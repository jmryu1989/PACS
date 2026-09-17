import { StudyAccessService } from './study-access.service';
import { Injectable, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { Caller } from './pacs.service';
import { canonical, viewerUid, viewerUuid } from './viewer-input';
import { copySource, findingCommand, findingFingerprint, findingPage, FindingSource, FINDING_LIMITS } from './finding-input';

const denied = () => { throw new ForbiddenException('소견에 접근할 수 없습니다'); };
const conflict = () => { throw new ConflictException('소견 또는 요청이 변경되었습니다'); };
const storageLimit = () => { throw new ConflictException({ code: 'FINDING_STORAGE_LIMIT', message: '소견 저장 한도에 도달했습니다' }); };
const staleSource = (itemId: string, head: any) => {
  throw new ConflictException({ code: 'FINDING_SOURCE_STALE', message: '연결할 표식의 최신판을 확인하세요', itemId,
    headRevision: head ? head.revision : null, headHidden: head ? head.hidden : null });
};

// Identical boundary to viewer items: institution or tele institution, RS=P designated only,
// radiologist writes, author-only revisions, admin gets no extra path.
function member(c: Caller, write = false) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution || (write && !c.roles.includes('radiologist'))) denied();
}
function visible(study: any, c: Caller) {
  if (!study || (study.institutionId !== c.institution && study.teleInstitutionId !== c.institution) ||
      (study.rs === 'P' && study.preDoc !== c.actor && study.preReviewer !== c.actor)) denied();
}
function timestamp(value: Date | string) {
  return typeof value === 'string' ? new Date(value + 'Z') : value;
}
function result(head: any, revision?: any) {
  return { id: head.id, studyUid: head.studyUid, authorSub: head.authorSub, authorActor: head.authorActor,
    revision: revision?.revision ?? head.revision, createdAt: timestamp(head.createdAt), hidden: (revision?.snapshot ?? head.snapshot).hidden,
    updatedAt: timestamp(revision?.at ?? head.updatedAt), item: revision?.snapshot ?? head.snapshot };
}

@Injectable()
export class FindingService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService) {}

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

  async list(uid: string, query: any, c: Caller, id?: string) {
    member(c); viewerUid(uid); visible(await this.prisma.studyState.findUnique({ where: { uid } }), c); await this.studyAccess.require(c, [uid]);
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
      if (id !== undefined) {
        const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent}),
          head AS (SELECT f.id FROM "Finding" f JOIN parent p ON p.uid = f."studyUid" WHERE f.id = ${id}::uuid)
          SELECT EXISTS(SELECT 1 FROM parent) AS allowed, EXISTS(SELECT 1 FROM head) AS present,
            COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.revision) FROM (
              SELECT r.revision, r.snapshot, r.action, r.reason, r.actor, r."payloadBytes", r.at
              FROM "FindingRevision" r JOIN head h ON h.id = r."findingId"
              WHERE (${page.cursor}::int IS NULL OR r.revision > ${page.cursor}::int)
              ORDER BY r.revision LIMIT ${page.limit + 1}) page), '[]'::jsonb) AS rows`;
        if (!pageRow.allowed) denied();
        if (!pageRow.present) throw new NotFoundException('소견이 없습니다');
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
            ORDER BY f.id LIMIT ${page.limit + 1}) page), '[]'::jsonb) AS rows`;
      if (!pageRow.allowed) denied();
      const items = pageRow.rows.slice(0, page.limit).map(row => ({ ...result(row), links: row.links }));
      return { items, nextCursor: pageRow.rows.length > page.limit ? items[items.length - 1].id : null };
    }, true);
  }

  async write(uid: string, raw: Buffer, c: Caller, id?: string) {
    member(c, true); viewerUid(uid); if (id !== undefined) viewerUuid(id);
    const command = findingCommand(raw, id === undefined), fingerprint = findingFingerprint(uid, id ?? null, command);
    visible(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    await this.studyAccess.require(c, [uid]);
    const requestKey = { authorSub: c.sub, requestId: command.requestId };
    return this.bounded(async tx => {
      await this.studyAccess.require(c, [uid], tx);
      // The parent write lock is the serialization point shared with viewer-item writes: every
      // source head read below happens after this lock, so a cooperating item edit is either
      // fully before (its new revision is seen) or fully after (it finds the copied revision).
      const studies = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      visible(studies[0], c);
      // Replay returns the recorded row after current authorization and before any source
      // revalidation. A different body under the same request id is a conflict.
      const replay = await tx.findingRevision.findUnique({ where: { authorSub_requestId: requestKey }, include: { finding: true } });
      if (replay) {
        if (replay.fingerprint !== fingerprint || replay.finding.studyUid !== uid || replay.finding.authorSub !== c.sub ||
            (id !== undefined && replay.findingId !== id)) conflict();
        return result(replay.finding, replay);
      }
      let head: any = null;
      if (id !== undefined) {
        const heads = await tx.$queryRaw<any[]>`SELECT * FROM "Finding" WHERE id = ${id}::uuid AND "studyUid" = ${uid} FOR UPDATE`;
        head = heads[0];
        if (!head) throw new NotFoundException('소견이 없습니다');
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
        if (!item || item.studyUid !== uid) throw new NotFoundException('연결할 표식이 이 검사에 없습니다');
        if (item.hidden || item.revision !== ref.revision) staleSource(ref.itemId, item);
        sources.push(copySource(item));
      }
      const hidden = command.action === 'hide' || (command.action === 'edit' && head?.hidden === true);
      const snapshot = { schemaVersion: 1, title: command.item.title, text: command.item.text, hidden, primary: command.item.primary, sources };
      const serialized = canonical(snapshot);
      const sizes = await tx.$queryRaw<{ bytes: number }[]>`SELECT octet_length(convert_to(${serialized}::jsonb::text, 'UTF8')) AS bytes`;
      const bytes = sizes[0].bytes;
      if (bytes > FINDING_LIMITS.snapshot) storageLimit();
      // Lifetime counts under the parent lock; revisions are append-only so the aggregate is the
      // lifetime figure and hiding never recovers budget.
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
