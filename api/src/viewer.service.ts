import { Injectable, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, isManualMeasurement, viewerCommand, viewerFingerprint, viewerPage, viewerUid, viewerUuid, verifyViewerReference, VIEWER_LIMITS } from './viewer-input';

const denied = () => { throw new ForbiddenException('표시 항목에 접근할 수 없습니다'); };
const conflict = () => { throw new ConflictException('표시 항목 또는 요청이 변경되었습니다'); };
const storageLimit = () => { throw new ConflictException({ code: 'VIEWER_STORAGE_LIMIT', message: '표시 이력 저장 한도에 도달했습니다' }); };

function member(c: Caller, write = false) {
  if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution || (write && !c.roles.includes('radiologist'))) denied();
}
function visible(study: any, c: Caller) {
  if (!study || (study.institutionId !== c.institution && study.teleInstitutionId !== c.institution) ||
      (study.rs === 'P' && study.preDoc !== c.actor && study.preReviewer !== c.actor)) denied();
}
function timestamp(value: Date | string) {
  // PostgreSQL timestamp(3) JSON omits a zone; Prisma writes these columns as UTC.
  return typeof value === 'string' ? new Date(value + 'Z') : value;
}
function result(head: any, revision?: any) {
  return { id: head.id, studyUid: head.studyUid, authorSub: head.authorSub, authorActor: head.authorActor,
    revision: revision?.revision ?? head.revision, createdAt: timestamp(head.createdAt), hidden: (revision?.snapshot ?? head.snapshot).hidden,
    updatedAt: timestamp(revision?.at ?? head.updatedAt), item: revision?.snapshot ?? head.snapshot };
}

@Injectable()
export class ViewerService {
  constructor(private prisma: PrismaService, private orthanc: OrthancService) {}

  private async verifyMeasurements(uid: string, heads: any[], c: Caller) {
    const groups = new Map<string, any[]>();
    for (const head of heads) {
      if (!isManualMeasurement(head.item.kind)) continue;
      head.referenceStatus = 'unverified';
      if (!groups.has(head.item.sopUid)) groups.set(head.item.sopUid, []);
      groups.get(head.item.sopUid).push(head);
    }
    if (!groups.size) return;
    // A slow source must not consume the browser's whole request timeout or
    // hide unrelated keys/arrows. The deadline cancels real fetch/body reads;
    // unstarted and failed measurements retain their explicit withheld status.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
    const queue = [...groups.entries()]; let next = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (!controller.signal.aborted && next < queue.length) {
          const [sop, entries] = queue[next++];
          try {
            const tags = await this.orthanc.viewerReference(sop, true, controller.signal);
            if (controller.signal.aborted) break;
            for (const head of entries) {
              try {
                verifyViewerReference(uid, head.item, tags);
                if (tags._kinSourceDigest === head.item.sourceDigest) head.referenceStatus = 'verified';
              } catch { /* One invalid reference must not poison another item on this SOP. */ }
            }
          } catch { /* Receipt/list survives; these measurements remain unverified. */ }
        }
      }));
    } finally { clearTimeout(timer); controller.abort(); }
    // Source checks run outside DB locks. Do not release a delayed response
    // after the study's institution or pending-reading access has changed.
    visible(await this.prisma.studyState.findUnique({ where: { uid } }), c);
  }

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
        if (error.code === 'P2028' || (error.code === 'P2010' && ['55P03', '57014'].includes(String(error.meta?.code))))
          throw new ServiceUnavailableException('표시 저장이 지연되었습니다. 같은 요청 ID로 다시 시도하세요');
      }
      throw error;
    }
  }

  async list(uid: string, query: any, c: Caller, id?: string) {
    member(c); viewerUid(uid); if (id !== undefined) viewerUuid(id);
    const page = viewerPage(query, id !== undefined);
    // The permission predicate and page share a single SQL statement, including
    // the distinction between a forbidden parent and an authorized empty page.
    const pageResult = await this.bounded(async tx => {
      const parent = Prisma.sql`SELECT uid FROM "StudyState" WHERE uid = ${uid}
        AND ("institutionId" = ${c.institution} OR "teleInstitutionId" = ${c.institution})
        AND (rs <> 'P' OR "preDoc" = ${c.actor} OR "preReviewer" = ${c.actor})`;
      if (id !== undefined) {
        const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent}),
          head AS (SELECT i.id FROM "ViewerItem" i JOIN parent p ON p.uid = i."studyUid" WHERE i.id = ${id}::uuid)
          SELECT EXISTS(SELECT 1 FROM parent) AS allowed, EXISTS(SELECT 1 FROM head) AS present,
            COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.revision) FROM (
              SELECT r.* FROM "ViewerRevision" r JOIN head h ON h.id = r."itemId"
              WHERE (${page.cursor}::int IS NULL OR r.revision > ${page.cursor}::int)
              ORDER BY r.revision LIMIT ${page.limit + 1}) page), '[]'::jsonb) AS rows`;
        if (!pageRow.allowed) denied();
        if (!pageRow.present) throw new NotFoundException('표시 항목이 없습니다');
        const revisions = pageRow.rows.slice(0, page.limit).map(row => ({ revision: row.revision, action: row.action,
          reason: row.reason, actor: row.actor, at: timestamp(row.at), payloadBytes: row.payloadBytes, item: row.snapshot }));
        return { revisions, nextCursor: pageRow.rows.length > page.limit ? revisions[revisions.length - 1].revision : null };
      }
      const [pageRow] = await tx.$queryRaw<any[]>`WITH parent AS (${parent})
        SELECT EXISTS(SELECT 1 FROM parent) AS allowed,
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.id) FROM (
            SELECT i.* FROM "ViewerItem" i JOIN parent p ON p.uid = i."studyUid"
            WHERE (${page.includeHidden} OR NOT i.hidden)
              AND (${page.cursor}::uuid IS NULL OR i.id > ${page.cursor}::uuid)
            ORDER BY i.id LIMIT ${page.limit + 1}) page), '[]'::jsonb) AS rows`;
      if (!pageRow.allowed) denied();
      const items = pageRow.rows.slice(0, page.limit).map(row => result(row));
      return { items, nextCursor: pageRow.rows.length > page.limit ? items[items.length - 1].id : null };
    }, true);
    if ('items' in pageResult) await this.verifyMeasurements(uid, pageResult.items, c);
    return pageResult;
  }

  async write(uid: string, raw: Buffer, c: Caller, id?: string) {
    member(c, true); viewerUid(uid); if (id !== undefined) viewerUuid(id);
    const command = viewerCommand(raw, id === undefined), fingerprint = viewerFingerprint(uid, id ?? null, command);
    visible(await this.prisma.studyState.findUnique({ where: { uid } }), c);
    const requestKey = { authorSub: c.sub, requestId: command.requestId };
    const known = await this.prisma.viewerRequest.findUnique({ where: { authorSub_requestId: requestKey } });
    // A prior success is immutable; it may be replayed during an Orthanc outage.
    // This lookup is only an optimization. Current permission and the fingerprint
    // are checked again under the parent lock before returning anything.
    const manual = isManualMeasurement(command.item.kind);
    let sourceDigest: string;
    if (!known) {
      const tags = await this.orthanc.viewerReference(command.item.sopUid, manual);
      verifyViewerReference(uid, command.item, tags);
      if (manual) sourceDigest = tags._kinSourceDigest;
    }

    let replayed = false;
    const output = await this.bounded(async tx => {
      const studies = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      visible(studies[0], c);
      const replay = await tx.viewerRequest.findUnique({ where: { authorSub_requestId: requestKey }, include: { result: { include: { item: true } } } });
      if (replay) {
        if (replay.fingerprint !== fingerprint || replay.result.item.studyUid !== uid || replay.result.item.authorSub !== c.sub) conflict();
        replayed = true;
        return result(replay.result.item, replay.result);
      }
      // The request row can only disappear through administrative corruption;
      // never turn the metadata-skip optimization into a new unverified write.
      if (known) conflict();
      let head: any = null;
      if (id !== undefined) {
        const heads = await tx.$queryRaw<any[]>`SELECT * FROM "ViewerItem" WHERE id = ${id}::uuid AND "studyUid" = ${uid} FOR UPDATE`;
        head = heads[0];
        if (!head) throw new NotFoundException('표시 항목이 없습니다');
        if (head.authorSub !== c.sub) denied();
      }
      if (head) {
        if (head.revision !== command.expectedRevision) conflict();
        const old = head.snapshot as any;
        if (manual && old.sourceDigest !== sourceDigest) conflict();
        for (const field of ['schemaVersion', 'kind', 'seriesUid', 'sopUid', 'frame', 'frameOfReferenceUid'])
          if (old[field] !== command.item[field]) conflict();
        if ((command.action === 'hide' && head.hidden) || (command.action === 'restore' && !head.hidden)) conflict();
      }
      const hidden = command.action === 'hide' || (command.action === 'edit' && head.hidden);
      const snapshot = { ...command.item, ...(manual ? { sourceDigest } : {}), hidden }, serialized = canonical(snapshot);
      const sizes = await tx.$queryRaw<{ bytes: number }[]>`SELECT octet_length(convert_to(${serialized}::jsonb::text, 'UTF8')) AS bytes`;
      const bytes = sizes[0].bytes;
      if (bytes > VIEWER_LIMITS.snapshot) storageLimit();
      // All creators lock the existing study before this upsert. There is no
      // orphan budget if any subsequent history/audit/request write fails.
      await tx.viewerStorageBudget.upsert({ where: { studyUid: uid }, update: {},
        create: { studyUid: uid, itemCount: 0, revisionCount: 0, payloadBytes: 0 } });
      const budgets = await tx.$queryRaw<any[]>`SELECT * FROM "ViewerStorageBudget" WHERE "studyUid" = ${uid} FOR UPDATE`;
      const budget = budgets[0], added = head ? 0 : 1;
      if (budget.itemCount + added > VIEWER_LIMITS.items || budget.revisionCount + 1 > VIEWER_LIMITS.revisions ||
          budget.payloadBytes + bytes > VIEWER_LIMITS.bytes) storageLimit();
      const now = new Date(), revision = head ? head.revision + 1 : 1;
      // Prisma's JSON number serialization can differ from JSON.stringify for
      // fractional world coordinates. Use the exact JSON counted above for both
      // copies: the database byte equality check must never be weakened to fit it.
      if (head) [head] = await tx.$queryRaw<any[]>`UPDATE "ViewerItem" SET snapshot = ${serialized}::jsonb,
        hidden = ${hidden}, revision = ${revision}, "updatedAt" = ${now} WHERE id = ${id}::uuid RETURNING *`;
      else [head] = await tx.$queryRaw<any[]>`INSERT INTO "ViewerItem"
        (id, "studyUid", "authorSub", "authorActor", snapshot, hidden, revision, "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${uid}, ${c.sub}, ${c.actor}, ${serialized}::jsonb, ${hidden}, ${revision}, ${now}, ${now}) RETURNING *`;
      await tx.$executeRaw`INSERT INTO "ViewerRevision"
        ("itemId", revision, snapshot, action, reason, actor, "payloadBytes", at)
        VALUES (${head.id}::uuid, ${revision}, ${serialized}::jsonb, ${command.action}, ${command.reason}, ${c.actor}, ${bytes}, ${now})`;
      await tx.viewerStorageBudget.update({ where: { studyUid: uid }, data: {
        itemCount: { increment: added }, revisionCount: { increment: 1 }, payloadBytes: { increment: bytes } } });
      await tx.auditLog.create({ data: { actor: c.actor, action: 'viewer.' + command.action, target: uid,
        detail: JSON.stringify({ itemId: head.id, revision, authorSub: c.sub, payloadBytes: bytes }) } });
      await tx.viewerRequest.create({ data: { ...requestKey, fingerprint, itemId: head.id, revision } });
      return { ...result(head), ...(manual ? { referenceStatus: 'verified' } : {}) };
    });
    // Persisted success and current source identity are separate facts. Never
    // invent a verified status for a replay just because its write succeeded.
    if (replayed && manual) await this.verifyMeasurements(uid, [output], c);
    return output;
  }
}
