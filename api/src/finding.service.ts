import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, viewerUid, viewerUuid } from './viewer-input';
import { comparisonStudies, copyJob, copySource, findingCommand, findingFingerprint, findingPage, FindingCommand, FindingJobSource, FindingSource,
  FindingSourceRef, FINDING_LIMITS, isJobRef, jobAbsent, jobFrame, jobLocation, jobMark, jobStudies, refKey, sourceRef, sourceStudies } from './finding-input';

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
const staleJob = (ref: { jobId: string; markId?: string }, head: any) => {
  throw new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 저장 작업의 최신판을 확인하세요', jobId: ref.jobId,
    ...(ref.markId === undefined ? {} : { markId: ref.markId }), headRevision: head.revision, headHidden: head.hidden });
};
const schemaVersion = () => {
  throw new ConflictException({ code: 'FINDING_SCHEMA_VERSION', message: '이 소견은 새 판 형식입니다. 화면을 새로고침한 뒤 다시 시도하세요' });
};
const clientOutdated = () => {
  throw new ConflictException({ code: 'FINDING_CLIENT_OUTDATED', message: '이 화면 판은 새 소견 형식을 표시하지 못합니다. 새로고침하세요' });
};
const parsed = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : null;

// R6: the shape a stored job copy must have to name its studies (finding-input.ts jobShape). Every WHEN is
// evaluated in order, so no array function sees a non-array.
const JOB_SHAPE = Prisma.sql`(CASE WHEN jsonb_typeof(s.value->'studies') IS DISTINCT FROM 'array' THEN false
  WHEN jsonb_array_length(s.value->'studies') NOT BETWEEN 1 AND 2 THEN false
  WHEN jsonb_typeof(s.value->'studies'->0) IS DISTINCT FROM 'string' THEN false
  WHEN jsonb_array_length(s.value->'studies') = 2 AND jsonb_typeof(s.value->'studies'->1) IS DISTINCT FROM 'string' THEN false
  WHEN (s.value->'studies'->>1) IS NOT DISTINCT FROM (s.value->'studies'->>0) THEN false
  WHEN (s.value->'studies'->>0) IS DISTINCT FROM (s.value->>'jobStudyUid') THEN false
  WHEN (s.value->>'studyUid') IS DISTINCT FROM COALESCE(s.value->'studies'->>1, s.value->'studies'->>0) THEN false
  ELSE true END)`;
// The studies one copied source `s` names: an item names its own study; a job names its projection, every
// study of its ordered set and its anchor, or the unreadable '' when its shape is not exactly that.
const SOURCE_STUDIES = Prisma.sql`CROSS JOIN LATERAL (SELECT s.value->>'studyUid' AS uid
  UNION ALL SELECT CASE WHEN ${JOB_SHAPE} THEN e.value ELSE '' END
    FROM jsonb_array_elements_text(CASE WHEN ${JOB_SHAPE} THEN s.value->'studies' ELSE '[""]'::jsonb END) e WHERE s.value->>'kind' = 'job'
  UNION ALL SELECT s.value->>'jobStudyUid' WHERE s.value->>'kind' = 'job') c`;
// Every study that finding `f`'s head or any of its immutable revisions copied a source from.
// The lineage only grows, and only under the anchor study's row lock.
const LINEAGE = Prisma.sql`SELECT c.uid AS uid FROM jsonb_array_elements(f.snapshot->'sources') s ${SOURCE_STUDIES}
  UNION ALL SELECT c.uid FROM "FindingRevision" r CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'sources') s ${SOURCE_STUDIES}
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
// A shipped (version 1) client reads only version 1 rows; anything else would be dropped by it silently.
const legacyOnly = (items: any[]) => items.every(item => item?.schemaVersion === 1);
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

  // The replay receipt with both snapshots read as JSON text (the query engine's Json conversion can move a
  // 17-digit double by one ULP; viewer-job-snapshot.ts).
  private async replayRow(db: any, sub: string, requestId: string) {
    const [row] = await db.$queryRaw`SELECT r."findingId", r.revision, r.fingerprint, r.at, r.snapshot::text AS snapshot,
        f.id, f."studyUid", f."authorSub", f."authorActor", f."createdAt"
      FROM "FindingRevision" r JOIN "Finding" f ON f.id = r."findingId" WHERE r."authorSub" = ${sub} AND r."requestId" = ${requestId}::uuid`;
    if (!row) return null;
    return { findingId: row.findingId, revision: row.revision, fingerprint: row.fingerprint, at: row.at, snapshot: parsed(row.snapshot),
      finding: { id: row.id, studyUid: row.studyUid, authorSub: row.authorSub, authorActor: row.authorActor, createdAt: row.createdAt } };
  }

  // `schema` is the X-KIN-Finding-Schema request header: without '2' a page holding any other version is refused whole.
  async list(uid: string, query: any, c: Caller, id?: string, schema?: string) {
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
              ORDER BY r.revision LIMIT ${page.limit + 1}) page), '[]'::jsonb)::text AS rows`;
        if (!pageRow.allowed) denied();
        // An unreadable finding answers exactly like an absent id.
        if (!pageRow.present) absent();
        const rows: any[] = parsed(pageRow.rows);
        const revisions = rows.slice(0, page.limit).map(row => ({ revision: row.revision, action: row.action,
          reason: row.reason, actor: row.actor, at: timestamp(row.at), payloadBytes: row.payloadBytes, item: row.snapshot }));
        if (schema !== '2' && !legacyOnly(revisions.map(r => r.item))) clientOutdated();
        return { revisions, nextCursor: rows.length > page.limit ? revisions[revisions.length - 1].revision : null };
      }
      // Item links are the shipped entries byte for byte; a job entry reports the job head of this anchor.
      const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent})
        SELECT EXISTS(SELECT 1 FROM parent) AS allowed,
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM (
            SELECT f.*, (SELECT COALESCE(jsonb_agg(CASE WHEN s.value->>'kind' = 'job' THEN jsonb_build_object('jobId', s.value->>'jobId',
                'markId', s.value->'mark'->>'id',
                'linkState', CASE WHEN j.id IS NULL THEN 'missing' WHEN j.hidden THEN 'hidden'
                  WHEN j.revision <> (s.value->>'revision')::int THEN 'metadata-changed' ELSE 'current' END,
                'headRevision', j.revision, 'headHidden', j.hidden)
              ELSE jsonb_build_object('itemId', s.value->>'itemId',
                'linkState', CASE WHEN i.id IS NULL THEN 'missing' WHEN i.hidden THEN 'hidden'
                  WHEN i.revision <> (s.value->>'revision')::int THEN 'revised' ELSE 'current' END,
                'headRevision', i.revision, 'headHidden', i.hidden) END ORDER BY s.ordinality), '[]'::jsonb)
              FROM jsonb_array_elements(f.snapshot->'sources') WITH ORDINALITY s
              LEFT JOIN "ViewerItem" i ON s.value->>'kind' IS DISTINCT FROM 'job' AND i.id = (s.value->>'itemId')::uuid AND i."studyUid" = s.value->>'studyUid'
              LEFT JOIN "ViewerJob" j ON s.value->>'kind' = 'job' AND j."studyUid" = f."studyUid" AND j.id = (CASE
                WHEN s.value->>'jobId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (s.value->>'jobId')::uuid END)) AS links
            FROM "Finding" f JOIN parent p ON p.uid = f."studyUid"
            WHERE (${page.includeHidden} OR NOT f.hidden)
              AND (${page.cursor}::uuid IS NULL OR f.id > ${page.cursor}::uuid)
              AND ${readableLineage(studies)}
            ORDER BY f.id LIMIT ${page.limit + 1}) page), '[]'::jsonb)::text AS rows`;
      if (!pageRow.allowed) denied();
      const rows: any[] = parsed(pageRow.rows);
      const items = rows.slice(0, page.limit).map(row => ({ ...result(row), links: row.links }));
      if (schema !== '2' && !legacyOnly(items.map(i => i.item))) clientOutdated();
      return { items, nextCursor: rows.length > page.limit ? items[items.length - 1].id : null };
    }, true);
  }

  // Resolves, without any lock, every study this command can touch, so access metadata and the
  // Orthanc patient identity are fetched before a row is locked. The transaction repeats each check
  // on locked rows; a plan made stale by a concurrent change ends in 409, never in an unchecked read
  // or copy. Studies the caller cannot open are left out: their items then fail in the source loop at
  // the same position and with the same body as unknown ids, and never reach Orthanc.
  // S2-L1 (B1): a job reference is first read raw, a job anchored elsewhere contributes nothing and later fails
  // as an unknown id, and an anchored job's whole study set joins the item studies in the unchanged
  // reachable/readable/N2/patient checks. Only then, and only for a point on a job every study of which
  // passed, is the Frame of Reference of its first original read: once per job, all within 20 s.
  private async plan(uid: string, anchor: any, command: FindingCommand, fingerprint: string, c: Caller, id?: string) {
    const checked = new Set<string>(), frames = new Map<string, string>();
    const readableFinding = async (findingId: string) => {
      const lineage = await this.lineage(this.prisma, uid, findingId);
      const { readable } = await this.comparisons(c, anchor, lineage);
      if (lineage.some(study => !readable.has(study))) absent();
      return lineage;
    };
    const replay = await this.replayRow(this.prisma, c.sub, command.requestId);
    if (replay) {
      if (replayMismatch(replay, fingerprint, uid, c, id)) conflict();
      return { studies: [uid, ...await readableFinding(replay.findingId)].sort(), checked, frames };
    }
    let lineage: string[] = [];
    const frozen = new Map<string, unknown[]>();
    if (id !== undefined) {
      const heads: any = await this.prisma.$queryRaw`SELECT "authorSub", snapshot::text AS snapshot FROM "Finding" WHERE id = ${id}::uuid AND "studyUid" = ${uid}`;
      if (!heads.length) return { studies: [uid], checked, frames };
      lineage = await readableFinding(id);
      if (heads[0].authorSub !== c.sub) denied();
      // Hide and restore keep the head's exact pairs, so they copy nothing and never reach Orthanc.
      if (command.action !== 'edit') return { studies: [uid, ...lineage].sort(), checked, frames };
      for (const source of parsed(heads[0].snapshot).sources) frozen.set(refKey(sourceRef(source)), sourceStudies(source));
    }
    const fresh = command.item.sources.filter(ref => !frozen.has(refKey(ref)));
    const itemRefs = fresh.filter((ref): ref is FindingSourceRef => !isJobRef(ref)), jobRefs = fresh.filter(isJobRef);
    const items = itemRefs.length ? await this.prisma.viewerItem.findMany({ where: { id: { in: itemRefs.map(ref => ref.itemId) } }, select: { studyUid: true } }) : [];
    const jobs = jobRefs.length ? await this.prisma.$queryRaw<any[]>`SELECT id::text AS id, "studyUid", studies,
        (snapshot->'version')::text AS version, (snapshot->'volume')::text AS volume, (snapshot->'marks')::text AS marks
      FROM "ViewerJob" WHERE id IN (${Prisma.join(jobRefs.map(ref => Prisma.sql`${ref.jobId}::uuid`))})` : [];
    const anchored = new Map<string, { studies: string[]; snapshot: any }>();
    for (const job of jobs) {
      let studies: string[];
      try { studies = jobStudies(uid, job); } catch { continue; }
      anchored.set(job.id, { studies, snapshot: { version: parsed(job.version), volume: parsed(job.volume), marks: parsed(job.marks) } });
    }
    const candidates = comparisonStudies(uid, [...items.map(item => item.studyUid), ...[...anchored.values()].flatMap(job => job.studies)]);
    const { reachable, readable } = await this.comparisons(c, anchor, candidates);
    const linked = candidates.filter(study => reachable.has(study));
    const kept = command.item.sources.filter(ref => frozen.has(refKey(ref))).flatMap(ref => frozen.get(refKey(ref)));
    if (comparisonStudies(uid, [...kept, ...linked]).length > 1) throw new BadRequestException('소견에는 비교 검사 하나의 표식만 함께 연결할 수 있습니다');
    if (linked.some(study => !readable.has(study))) denied();
    if (comparisonStudies(uid, [...lineage, ...kept, ...linked]).length > 1) oneComparison();
    if (linked.length) {
      // Only a new copy from the comparison study proves the patient again; Orthanc 400/503 pass through.
      const own = await this.orthanc.connectStudyIdentity(uid), other = await this.orthanc.connectStudyIdentity(linked[0]);
      if (own.patientId !== other.patientId) throw new BadRequestException('같은 환자의 검사만 소견에 연결할 수 있습니다');
      checked.add(linked[0]);
    }
    const permitted = new Set([uid, ...linked]), points = new Map<string, { study: string; series: string; sop: string }>();
    for (const ref of jobRefs) {
      const job = anchored.get(ref.jobId);
      if (ref.markId === undefined || !job || points.has(ref.jobId) || !job.studies.every(study => permitted.has(study))) continue;
      // A point the write will refuse (W4) is never looked up; the refusal keeps its position there.
      const mark = (() => { try { return jobMark(job.snapshot, job.studies, ref.markId); } catch { return null; } })();
      if (mark) points.set(ref.jobId, mark.volume);
    }
    if (points.size) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        for (const [jobId, volume] of points) frames.set(jobId, jobFrame(await this.orthanc.viewerReference(volume.sop, false, controller.signal), volume));
      } finally { clearTimeout(timer); controller.abort(); }
    }
    return { studies: [...new Set([uid, ...lineage, ...linked])].sort(), checked, frames };
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
      // revalidation or version rule. A different body under the same request id is a conflict.
      const replay = await this.replayRow(tx, c.sub, command.requestId);
      if (replay) {
        if (replayMismatch(replay, fingerprint, uid, c, id)) conflict();
        await readableFinding(replay.findingId);
        return result(replay.finding, replay);
      }
      let head: any = null, lineage: string[] = [];
      if (id !== undefined) {
        const heads = await tx.$queryRaw<any[]>`SELECT id, "studyUid", "authorSub", "authorActor", revision, hidden, "createdAt", "updatedAt",
          snapshot::text AS snapshot FROM "Finding" WHERE id = ${id}::uuid AND "studyUid" = ${uid} FOR UPDATE`;
        head = heads[0] ? { ...heads[0], snapshot: parsed(heads[0].snapshot) } : null;
        if (!head) throw new NotFoundException('소견이 없습니다');
        // Edit, hide and restore alike: checked before the author and revision checks.
        lineage = await readableFinding(id);
        if (head.authorSub !== c.sub) denied();
        if (head.revision !== command.expectedRevision) conflict();
        if ((command.action === 'hide' && head.hidden) || (command.action === 'restore' && !head.hidden)) conflict();
        if (head.revision + 1 > FINDING_LIMITS.history) storageLimit();
        // Version rule: an edit may promote version 1 to 2 but never write version 1 over version 2, whose
        // characteristics and job copies a shipped client cannot carry. Hide and restore keep the head's
        // version; on version 2 they also keep its content exactly.
        const from = head.snapshot?.schemaVersion, to = command.item.schemaVersion, item = command.item;
        if (![1, 2].includes(from) || (command.action === 'edit' ? from === 2 && to !== 2 : to !== from)) schemaVersion();
        if (command.action !== 'edit' && from === 2 && (item.title !== head.snapshot.title || item.text !== head.snapshot.text ||
            item.characteristics !== head.snapshot.characteristics || item.primary !== head.snapshot.primary)) schemaVersion();
      }
      // An unchanged {itemId, revision} pair (or job key) keeps its frozen copy byte for byte, even when that
      // item or job was edited, hidden or lost since. Only a new pair or an explicitly refreshed one is
      // validated against the current head and copied again.
      const frozen = new Map<string, any>(), identities = new Map<string, any>();
      for (const source of (head?.snapshot?.sources ?? []) as any[]) {
        frozen.set(refKey(sourceRef(source)), source);
        if (source?.kind === 'job') identities.set(source.jobId + ':' + (source.mark?.id ?? ''), source);
      }
      // Hide/restore is not an edit: the pair sequence must be exactly the head's, so no refresh
      // or relink can ride along with a hide reason.
      if (head && command.action !== 'edit' && canonical(command.item.sources) !==
          canonical((head.snapshot.sources as any[]).map(sourceRef))) conflict();
      const sources: (FindingSource | FindingJobSource)[] = [];
      for (const ref of command.item.sources) {
        const kept = frozen.get(refKey(ref));
        if (kept) { sources.push(kept); continue; }
        if (isJobRef(ref)) {
          // S2-L1: the job head of this anchor, its immutable snapshot as text, W1-W4, then staleness.
          const [job] = await tx.$queryRaw<any[]>`SELECT id::text AS id, "studyUid", studies, hidden, revision, title, "authorActor",
            snapshot::text AS snapshot FROM "ViewerJob" WHERE id = ${ref.jobId}::uuid`;
          const studies = jobStudies(uid, job);
          // A comparison study that is not locked and reachable here is indistinguishable from an unknown job.
          if (studies.length > 1) {
            if (!reachable.has(studies[1])) jobAbsent();
            if (!readable.has(studies[1])) denied();
            if (!plan.checked.has(studies[1])) conflict();
          }
          const snapshot = parsed(job.snapshot), mark = jobMark(snapshot, studies, ref.markId);
          if (job.hidden || job.revision !== ref.revision) staleJob(ref, job);
          // The Frame of Reference was read for this job before the locks; a reference outside that plan is a
          // concurrent change and the same request id can be retried.
          if (mark && !plan.frames.has(ref.jobId)) conflict();
          const copy = copyJob(job, studies, snapshot, mark, mark ? plan.frames.get(ref.jobId) : null);
          // A refresh re-copies the title and author only; the location it names must be the frozen one.
          const previous = identities.get(ref.jobId + ':' + (ref.markId ?? ''));
          if (previous && jobLocation(previous) !== jobLocation(copy)) conflict();
          sources.push(copy);
          continue;
        }
        const rows = await tx.$queryRaw<any[]>`SELECT id, "studyUid", revision, hidden, "authorActor", snapshot::text AS snapshot
          FROM "ViewerItem" WHERE id = ${ref.itemId}::uuid`;
        const item = rows[0] ? { ...rows[0], snapshot: parsed(rows[0].snapshot) } : null;
        // An item of a study that is not locked and reachable here is indistinguishable from a missing one.
        if (!item || (item.studyUid !== uid && !reachable.has(item.studyUid))) throw new NotFoundException('연결할 표식이 이 검사에 없습니다');
        if (item.studyUid !== uid) {
          if (!readable.has(item.studyUid)) denied();
          if (!plan.checked.has(item.studyUid)) conflict();
        }
        if (item.hidden || item.revision !== ref.revision) staleSource(ref.itemId, item);
        sources.push(copySource(item));
      }
      if (comparisonStudies(uid, [...lineage, ...sources.flatMap(sourceStudies)]).length > 1) oneComparison();
      const hidden = command.action === 'hide' || (command.action === 'edit' && head?.hidden === true);
      const snapshot = command.item.schemaVersion === 2
        ? { schemaVersion: 2, title: command.item.title, text: command.item.text, characteristics: command.item.characteristics, hidden, primary: command.item.primary, sources }
        : { schemaVersion: 1, title: command.item.title, text: command.item.text, hidden, primary: command.item.primary, sources };
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
      // The answer carries the stored snapshot read back as text.
      if (head) [head] = await tx.$queryRaw<any[]>`UPDATE "Finding" SET snapshot = ${serialized}::jsonb,
        hidden = ${hidden}, revision = ${revision}, "updatedAt" = ${now} WHERE id = ${id}::uuid
        RETURNING id, "studyUid", "authorSub", "authorActor", revision, hidden, "createdAt", "updatedAt", snapshot::text AS snapshot`;
      else [head] = await tx.$queryRaw<any[]>`INSERT INTO "Finding"
        (id, "studyUid", "authorSub", "authorActor", snapshot, hidden, revision, "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${uid}, ${c.sub}, ${c.actor}, ${serialized}::jsonb, ${hidden}, ${revision}, ${now}, ${now})
        RETURNING id, "studyUid", "authorSub", "authorActor", revision, hidden, "createdAt", "updatedAt", snapshot::text AS snapshot`;
      head = { ...head, snapshot: parsed(head.snapshot) };
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
