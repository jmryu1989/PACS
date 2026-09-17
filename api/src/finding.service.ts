import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, viewerUid, viewerUuid } from './viewer-input';
import { comparisonStudies, copySource, findingCommand, findingFingerprint, findingPage, FindingCommand, FindingSource, FINDING_LIMITS } from './finding-input';

const denied = () => { throw new ForbiddenException('소견에 접근할 수 없습니다'); };
const conflict = () => { throw new ConflictException('소견 또는 요청이 변경되었습니다'); };
const absent = () => { throw new NotFoundException('소견이 없습니다'); };
const storageLimit = () => { throw new ConflictException({ code: 'FINDING_STORAGE_LIMIT', message: '소견 저장 한도에 도달했습니다' }); };
const oneComparison = () => {
  throw new ConflictException({ code: 'FINDING_COMPARISON_STUDY', message: '소견에는 비교 검사를 하나만 연결할 수 있습니다. 다른 비교 검사는 새 소견으로 기록하세요' });
};
const staleSource = (itemId: string, head: any) => {
  throw new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 표식의 최신판을 확인하세요', itemId,
    headRevision: head ? head.revision : null, headHidden: head ? head.hidden : null });
};

// Every study that finding `f`'s head or any of its immutable revisions copied a source from.
// The lineage only grows, and only under the anchor study's row lock.
const LINEAGE = Prisma.sql`SELECT s.value->>'studyUid' AS uid FROM jsonb_array_elements(f.snapshot->'sources') s
  UNION ALL SELECT s.value->>'studyUid' FROM "FindingRevision" r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'sources') s
  WHERE r."findingId" = f.id`;
// Finding `f` is readable only when its whole lineage stays inside `studies` (the anchor plus the
// comparison studies this caller may read now). A missing study uid never matches. Applied before
// ORDER BY/LIMIT, so pages stay full and a cursor never names a finding the caller cannot read.
const readableLineage = (studies: string[]) => Prisma.sql`NOT EXISTS (SELECT 1 FROM (${LINEAGE}) l
  WHERE COALESCE(l.uid, '') NOT IN (${Prisma.join(studies)}))`;

// Identical boundary to viewer items: institution or tele institution, RS=P designated only,
// radiologist writes, author-only revisions, admin gets no extra path.
function member(c: Caller, write = false) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution || (write && !c.roles.includes('radiologist'))) denied();
}
function viewable(study: any, c: Caller) {
  return !!study && (study.institutionId === c.institution || study.teleInstitutionId === c.institution) &&
    (study.rs !== 'P' || study.preDoc === c.actor || study.preReviewer === c.actor);
}
function visible(study: any, c: Caller) {
  if (!viewable(study, c)) denied();
}
// A comparison study must be viewable like the anchor and allowed by the caller's study-access
// policy (`reachable`); a `readable` one also shares the anchor's non-null institution. Tele access
// grants viewing but never makes two institutions equal (ViewerJob sameInstitution).
function comparable(anchor: any, rows: any[], allowed: Set<string>, c: Caller) {
  const reachable = new Set<string>(), readable = new Set<string>();
  for (const row of rows) {
    if (row.uid === anchor?.uid || !allowed.has(row.uid) || !viewable(row, c)) continue;
    reachable.add(row.uid);
    if (anchor?.institutionId && row.institutionId === anchor.institutionId) readable.add(row.uid);
  }
  return { reachable, readable };
}
function timestamp(value: Date | string) {
  return typeof value === 'string' ? new Date(value + 'Z') : value;
}
function result(head: any, revision?: any) {
  return { id: head.id, studyUid: head.studyUid, authorSub: head.authorSub, authorActor: head.authorActor,
    revision: revision?.revision ?? head.revision, createdAt: timestamp(head.createdAt), hidden: (revision?.snapshot ?? head.snapshot).hidden,
    updatedAt: timestamp(revision?.at ?? head.updatedAt), item: revision?.snapshot ?? head.snapshot };
}
function replayMismatch(replay: any, fingerprint: string, uid: string, c: Caller, id?: string) {
  return replay.fingerprint !== fingerprint || replay.finding.studyUid !== uid || replay.finding.authorSub !== c.sub ||
    (id !== undefined && replay.findingId !== id);
}

// A finding is anchored on its own study X and may copy sources from at most one comparison study P
// over its whole lifetime: same non-empty Orthanc PatientID, same institution, and the caller may
// read both. A finding whose lineage names a study the caller cannot read is excluded from every
// list, history and replay, and refused for every edit, hide and restore, exactly like an absent one.
// Storage budgets stay on X and count every finding, readable or not.
@Injectable()
export class FindingService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService, private orthanc: OrthancService) {}

  private async bounded<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return work(tx);
      }, { isolationLevel: read ? Prisma.TransactionIsolationLevel.RepeatableRead : Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 4000, timeout: 8000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (['P2002', 'P2003', 'P2034'].includes(error.code)) conflict();
        if (error.code === 'P2028' || (error.code === 'P2010' && ['55P03', '57014', '40P01'].includes(String(error.meta?.code))))
          throw new ServiceUnavailableException('소견 저장이 지연되었습니다. 같은 요청 ID로 다시 시도하세요');
        // The service refuses every bound before insert; the database CHECK is a fail-closed backstop, not a 500.
        if (error.code === 'P2010' && String(error.meta?.code) === '23514') storageLimit();
      }
      throw error;
    }
  }

  // Comparison studies (anchor excluded) of one finding's lineage.
  private async lineage(db: any, uid: string, findingId: string): Promise<string[]> {
    const rows = await db.$queryRaw`SELECT DISTINCT l.uid FROM "Finding" f CROSS JOIN LATERAL (${LINEAGE}) l
      WHERE f.id = ${findingId}::uuid AND f."studyUid" = ${uid}`;
    return comparisonStudies(uid, rows.map((row: any) => row.uid));
  }

  // Unlocked form for planning: without a transaction the access service prepares any Orthanc
  // metadata its policy needs, so the locked re-check below never has to fetch it.
  private async comparisons(c: Caller, anchor: any, uids: string[]) {
    if (!uids.length) return comparable(anchor, [], new Set(), c);
    const allowed = await this.studyAccess.allowed(c, uids);
    return comparable(anchor, await this.prisma.studyState.findMany({ where: { uid: { in: uids } } }), allowed, c);
  }

  async list(uid: string, query: any, c: Caller, id?: string) {
    member(c); viewerUid(uid); visible(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    // Comparison studies are found only inside the read transaction, which cannot fetch access
    // metadata, so a metadata-rule policy is prepared for every study first (ViewerJob.list).
    await this.studyAccess.prepare(c);
    await this.studyAccess.require(c, [uid]);
    if (id !== undefined) viewerUuid(id);
    const page = findingPage(query, id !== undefined);
    // Permission predicate, page and per-source link state share one RepeatableRead statement:
    // a link state is never taken from a second, unlocked read of the item heads. The link state
    // is a database fact (head revision/hidden/presence) and is distinct from the viewer's
    // Orthanc-backed verified/unverified status, which stays on the viewer-items list.
    return this.bounded(async tx => {
      const parent = Prisma.sql`SELECT uid FROM "StudyState" WHERE uid = ${uid}
        AND ("institutionId" = ${c.institution} OR "teleInstitutionId" = ${c.institution})
        AND (rs <> 'P' OR "preDoc" = ${c.actor} OR "preReviewer" = ${c.actor})`;
      // The same snapshot names every comparison study in scope and decides which of them this
      // caller may read; the page statement then drops findings whose lineage leaves that set.
      const scope = id === undefined ? Prisma.empty : Prisma.sql`AND f.id = ${id}::uuid`;
      const foreign = comparisonStudies(uid, (await tx.$queryRaw<any[]>`SELECT DISTINCT l.uid
        FROM "Finding" f CROSS JOIN LATERAL (${LINEAGE}) l WHERE f."studyUid" = ${uid} ${scope}`).map(row => row.uid));
      const studies = [uid];
      if (foreign.length) {
        const allowed = await this.studyAccess.allowed(c, foreign, tx);
        const rows = await tx.studyState.findMany({ where: { uid: { in: [uid, ...foreign] } } });
        const { readable } = comparable(rows.find(row => row.uid === uid), rows, allowed, c);
        studies.push(...foreign.filter(study => readable.has(study)));
      }
      if (id !== undefined) {
        const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent}),
          head AS (SELECT f.id FROM "Finding" f JOIN parent p ON p.uid = f."studyUid" WHERE f.id = ${id}::uuid
            AND ${readableLineage(studies)})
          SELECT EXISTS(SELECT 1 FROM parent) AS allowed, EXISTS(SELECT 1 FROM head) AS present,
            COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.revision) FROM (
              SELECT r.revision, r.snapshot, r.action, r.reason, r.actor, r."payloadBytes", r.at
              FROM "FindingRevision" r JOIN head h ON h.id = r."findingId"
              WHERE (${page.cursor}::int IS NULL OR r.revision > ${page.cursor}::int)
              ORDER BY r.revision LIMIT ${page.limit + 1}) page), '[]'::jsonb) AS rows`;
        if (!pageRow.allowed) denied();
        // An unreadable finding answers exactly like an absent id.
        if (!pageRow.present) absent();
        const revisions = pageRow.rows.slice(0, page.limit).map(row => ({ revision: row.revision, action: row.action,
          reason: row.reason, actor: row.actor, at: timestamp(row.at), payloadBytes: row.payloadBytes, item: row.snapshot }));
        return { revisions, nextCursor: pageRow.rows.length > page.limit ? revisions[revisions.length - 1].revision : null };
      }
      const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent})
        SELECT EXISTS(SELECT 1 FROM parent) AS allowed,
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM (
            SELECT f.*, (SELECT COALESCE(jsonb_agg(jsonb_build_object('itemId', s.value->>'itemId',
                'linkState', CASE WHEN i.id IS NULL THEN 'missing' WHEN i.hidden THEN 'hidden'
                  WHEN i.revision <> (s.value->>'revision')::int THEN 'revised' ELSE 'current' END,
                'headRevision', i.revision, 'headHidden', i.hidden) ORDER BY s.ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(f.snapshot->'sources') WITH ORDINALITY s
              LEFT JOIN "ViewerItem" i ON i.id = (s.value->>'itemId')::uuid AND i."studyUid" = s.value->>'studyUid') AS links
            FROM "Finding" f JOIN parent p ON p.uid = f."studyUid"
            WHERE (${page.includeHidden} OR NOT f.hidden)
              AND (${page.cursor}::uuid IS NULL OR f.id > ${page.cursor}::uuid)
              AND ${readableLineage(studies)}
            ORDER BY f.id LIMIT ${page.limit + 1}) page), '[]'::jsonb) AS rows`;
      if (!pageRow.allowed) denied();
      const items = pageRow.rows.slice(0, page.limit).map(row => ({ ...result(row), links: row.links }));
      return { items, nextCursor: pageRow.rows.length > page.limit ? items[items.length - 1].id : null };
    }, true);
  }

  // Resolves, without any lock, every study this command can touch, so access metadata and the
  // Orthanc patient identity are fetched before a row is locked. The transaction repeats each check
  // on locked rows; a plan made stale by a concurrent change ends in 409, never in an unchecked read
  // or copy. Studies the caller cannot open are left out: their items then fail in the source loop at
  // the same position and with the same body as unknown ids, and never reach Orthanc.
  private async plan(uid: string, anchor: any, command: FindingCommand, fingerprint: string, c: Caller, id?: string) {
    const checked = new Set<string>();
    const readableFinding = async (findingId: string) => {
      const lineage = await this.lineage(this.prisma, uid, findingId);
      const { readable } = await this.comparisons(c, anchor, lineage);
      if (lineage.some(study => !readable.has(study))) absent();
      return lineage;
    };
    const replay = await this.prisma.findingRevision.findUnique({
      where: { authorSub_requestId: { authorSub: c.sub, requestId: command.requestId } }, include: { finding: true } });
    if (replay) {
      if (replayMismatch(replay, fingerprint, uid, c, id)) conflict();
      return { studies: [uid, ...await readableFinding(replay.findingId)].sort(), checked };
    }
    let lineage: string[] = [];
    const frozen = new Map<string, string>();
    if (id !== undefined) {
      const heads: any = await this.prisma.$queryRaw`SELECT "authorSub", snapshot FROM "Finding" WHERE id = ${id}::uuid AND "studyUid" = ${uid}`;
      if (!heads.length) return { studies: [uid], checked };
      lineage = await readableFinding(id);
      if (heads[0].authorSub !== c.sub) denied();
      // Hide and restore keep the head's exact pairs, so they copy nothing and never reach Orthanc.
      if (command.action !== 'edit') return { studies: [uid, ...lineage].sort(), checked };
      for (const source of heads[0].snapshot.sources) frozen.set(source.itemId + ':' + source.revision, source.studyUid);
    }
    const key = (ref: { itemId: string; revision: number }) => ref.itemId + ':' + ref.revision;
    const fresh = command.item.sources.filter(ref => !frozen.has(key(ref)));
    const items = fresh.length ? await this.prisma.viewerItem.findMany({ where: { id: { in: fresh.map(ref => ref.itemId) } }, select: { studyUid: true } }) : [];
    const candidates = comparisonStudies(uid, items.map(item => item.studyUid));
    const { reachable, readable } = await this.comparisons(c, anchor, candidates);
    const linked = candidates.filter(study => reachable.has(study));
    const kept = command.item.sources.filter(ref => frozen.has(key(ref))).map(ref => frozen.get(key(ref)));
    if (comparisonStudies(uid, [...kept, ...linked]).length > 1) throw new BadRequestException('소견에는 비교 검사 하나의 표식만 함께 연결할 수 있습니다');
    if (linked.some(study => !readable.has(study))) denied();
    if (comparisonStudies(uid, [...lineage, ...kept, ...linked]).length > 1) oneComparison();
    if (linked.length) {
      // Only a new copy from the comparison study proves the patient again; Orthanc 400/503 pass through.
      const own = await this.orthanc.connectStudyIdentity(uid), other = await this.orthanc.connectStudyIdentity(linked[0]);
      if (own.patientId !== other.patientId) throw new BadRequestException('같은 환자의 검사만 소견에 연결할 수 있습니다');
      checked.add(linked[0]);
    }
    return { studies: [...new Set([uid, ...lineage, ...linked])].sort(), checked };
  }

  async write(uid: string, raw: Buffer, c: Caller, id?: string) {
    member(c, true); viewerUid(uid); if (id !== undefined) viewerUuid(id);
    const command = findingCommand(raw, id === undefined), fingerprint = findingFingerprint(uid, id ?? null, command);
    const anchor = await this.prisma.studyState.findUnique({ where: { uid } });
    visible(anchor, c);
    await this.studyAccess.require(c, [uid]);
    const plan = await this.plan(uid, anchor, command, fingerprint, c, id);
    const requestKey = { authorSub: c.sub, requestId: command.requestId };
    return this.bounded(async tx => {
      // The shared policy lock is taken first, so a concurrent access change is wholly before or
      // wholly after this write.
      await this.studyAccess.require(c, [uid], tx);
      const allowed = plan.studies.length > 1 ? await this.studyAccess.allowed(c, plan.studies, tx) : new Set<string>();
      // The anchor and planned comparison study rows are locked by ONE statement in the database's
      // uid order, as ViewerJob, favorites and study tags lock theirs; a JS sort could disagree with
      // the collation and invert the order. The anchor lock is the serialization point shared with
      // viewer-item writes, and each item write locks its own study row, so every source head read
      // below happens after the writes that could move it: a cooperating item edit is either fully
      // before (its new revision is seen) or fully after (it finds the copied revision).
      const studies = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid IN (${Prisma.join(plan.studies)}) ORDER BY uid FOR UPDATE`;
      const locked = studies.find(row => row.uid === uid);
      visible(locked, c);
      const { reachable, readable } = comparable(locked, studies, allowed, c);
      // An unreadable lineage answers like an absent finding. A lineage study missing from the plan
      // is a concurrent change: nothing is written and the same request id can be retried.
      const readableFinding = async (findingId: string) => {
        const lineage = await this.lineage(tx, uid, findingId);
        if (lineage.some(study => plan.studies.includes(study) && !readable.has(study))) absent();
        if (lineage.some(study => !plan.studies.includes(study))) conflict();
        return lineage;
      };
      // Replay returns the recorded row after current authorization and before any source
      // revalidation. A different body under the same request id is a conflict.
      const replay = await tx.findingRevision.findUnique({ where: { authorSub_requestId: requestKey }, include: { finding: true } });
      if (replay) {
        if (replayMismatch(replay, fingerprint, uid, c, id)) conflict();
        await readableFinding(replay.findingId);
        return result(replay.finding, replay);
      }
      let head: any = null, lineage: string[] = [];
      if (id !== undefined) {
        const heads = await tx.$queryRaw<any[]>`SELECT * FROM "Finding" WHERE id = ${id}::uuid AND "studyUid" = ${uid} FOR UPDATE`;
        head = heads[0];
        if (!head) throw new NotFoundException('소견이 없습니다');
        // Edit, hide and restore alike: checked before the author and revision checks.
        lineage = await readableFinding(id);
        if (head.authorSub !== c.sub) denied();
        if (head.revision !== command.expectedRevision) conflict();
        if ((command.action === 'hide' && head.hidden) || (command.action === 'restore' && !head.hidden)) conflict();
        if (head.revision + 1 > FINDING_LIMITS.history) storageLimit();
      }
      // An unchanged {itemId, revision} pair keeps its frozen copy byte for byte, even when that
      // item was edited, hidden or lost since. Only a new pair or an explicitly refreshed one is
      // validated against the current head and copied again.
      const frozen = new Map<string, FindingSource>();
      for (const source of (head?.snapshot?.sources ?? []) as FindingSource[]) frozen.set(source.itemId + ':' + source.revision, source);
      // Hide/restore is not an edit: the pair sequence must be exactly the head's, so no refresh
      // or relink can ride along with a hide reason.
      if (head && command.action !== 'edit' && canonical(command.item.sources) !==
          canonical((head.snapshot.sources as FindingSource[]).map(s => ({ itemId: s.itemId, revision: s.revision })))) conflict();
      const sources: FindingSource[] = [];
      for (const ref of command.item.sources) {
        const kept = frozen.get(ref.itemId + ':' + ref.revision);
        if (kept) { sources.push(kept); continue; }
        const rows = await tx.$queryRaw<any[]>`SELECT * FROM "ViewerItem" WHERE id = ${ref.itemId}::uuid`;
        const item = rows[0];
        // An item of a study that is not locked and reachable here is indistinguishable from a missing one.
        if (!item || (item.studyUid !== uid && !reachable.has(item.studyUid))) throw new NotFoundException('연결할 표식이 이 검사에 없습니다');
        if (item.studyUid !== uid) {
          if (!readable.has(item.studyUid)) denied();
          if (!plan.checked.has(item.studyUid)) conflict();
        }
        if (item.hidden || item.revision !== ref.revision) staleSource(ref.itemId, item);
        sources.push(copySource(item));
      }
      if (comparisonStudies(uid, [...lineage, ...sources.map(source => source.studyUid)]).length > 1) oneComparison();
      const hidden = command.action === 'hide' || (command.action === 'edit' && head?.hidden === true);
      const snapshot = { schemaVersion: 1, title: command.item.title, text: command.item.text, hidden, primary: command.item.primary, sources };
      const serialized = canonical(snapshot);
      const sizes = await tx.$queryRaw<{ bytes: number }[]>`SELECT octet_length(convert_to(${serialized}::jsonb::text, 'UTF8')) AS bytes`;
      const bytes = sizes[0].bytes;
      if (bytes > FINDING_LIMITS.snapshot) storageLimit();
      // Lifetime counts under the parent lock; revisions are append-only so the aggregate is the
      // lifetime figure and hiding never recovers budget. They count every finding of this study,
      // including those this caller cannot read, and the refusal names no finding or count.
      const [usage] = await tx.$queryRaw<any[]>`SELECT
        (SELECT count(*)::int FROM "Finding" WHERE "studyUid" = ${uid}) AS findings,
        (SELECT count(*)::int FROM "FindingRevision" r JOIN "Finding" f ON f.id = r."findingId" WHERE f."studyUid" = ${uid}) AS revisions,
        (SELECT COALESCE(sum(r."payloadBytes"), 0)::bigint FROM "FindingRevision" r JOIN "Finding" f ON f.id = r."findingId" WHERE f."studyUid" = ${uid}) AS bytes`;
      const added = head ? 0 : 1;
      if (usage.findings + added > FINDING_LIMITS.findings || usage.revisions + 1 > FINDING_LIMITS.revisions ||
          Number(usage.bytes) + bytes > FINDING_LIMITS.bytes) storageLimit();
      const now = new Date(), revision = head ? head.revision + 1 : 1;
      // The exact JSON counted above is stored in both rows; the byte-equality CHECK is not weakened.
      if (head) [head] = await tx.$queryRaw<any[]>`UPDATE "Finding" SET snapshot = ${serialized}::jsonb,
        hidden = ${hidden}, revision = ${revision}, "updatedAt" = ${now} WHERE id = ${id}::uuid RETURNING *`;
      else [head] = await tx.$queryRaw<any[]>`INSERT INTO "Finding"
        (id, "studyUid", "authorSub", "authorActor", snapshot, hidden, revision, "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${uid}, ${c.sub}, ${c.actor}, ${serialized}::jsonb, ${hidden}, ${revision}, ${now}, ${now}) RETURNING *`;
      await tx.$executeRaw`INSERT INTO "FindingRevision"
        ("findingId", revision, snapshot, action, reason, actor, "authorSub", "requestId", fingerprint, "payloadBytes", at)
        VALUES (${head.id}::uuid, ${revision}, ${serialized}::jsonb, ${command.action}, ${command.reason}, ${c.actor}, ${c.sub},
          ${command.requestId}::uuid, ${fingerprint}, ${bytes}, ${now})`;
      await tx.auditLog.create({ data: { actor: c.actor, action: 'finding.' + command.action, target: uid,
        detail: JSON.stringify({ findingId: head.id, revision, authorSub: c.sub, payloadBytes: bytes, sources: sources.length }) } });
      return result(head);
    });
  }
}
