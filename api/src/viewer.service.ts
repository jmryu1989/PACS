import { Injectable, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, viewerCommand, viewerFingerprint, viewerPage, viewerUid, viewerUuid, verifyViewerReference, VIEWER_LIMITS } from './viewer-input';

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
function result(head: any, revision?: any) {
  return { id: head.id, studyUid: head.studyUid, author: { sub: head.authorSub, actor: head.authorActor },
    revision: revision?.revision ?? head.revision, createdAt: head.createdAt,
    updatedAt: revision?.at ?? head.updatedAt, item: revision?.snapshot ?? head.snapshot };
}

@Injectable()
export class ViewerService {
  constructor(private prisma: PrismaService, private orthanc: OrthancService) {}

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
    // Both permission and content reads share one MVCC snapshot. A later tele/P
    // transition cannot make a second statement expose a different parent state.
    return this.bounded(async tx => {
      visible(await tx.studyState.findUnique({ where: { uid } }), c);
      if (id !== undefined) {
        const head = await tx.viewerItem.findFirst({ where: { id, studyUid: uid } });
        if (!head) throw new NotFoundException('표시 항목이 없습니다');
        const rows = await tx.viewerRevision.findMany({ where: { itemId: id,
          ...(page.cursor === null ? {} : { revision: { gt: page.cursor as number } }) },
          orderBy: { revision: 'asc' }, take: page.limit + 1 });
        const revisions = rows.slice(0, page.limit).map(row => ({ revision: row.revision, action: row.action,
          reason: row.reason, actor: row.actor, at: row.at, payloadBytes: row.payloadBytes, item: row.snapshot }));
        return { revisions, nextCursor: rows.length > page.limit ? revisions[revisions.length - 1].revision : null };
      }
      const rows = await tx.viewerItem.findMany({ where: { studyUid: uid,
        ...(page.includeHidden ? {} : { hidden: false }),
        ...(page.cursor === null ? {} : { id: { gt: page.cursor as string } }) },
        orderBy: { id: 'asc' }, take: page.limit + 1 });
      const items = rows.slice(0, page.limit).map(row => result(row));
      return { items, nextCursor: rows.length > page.limit ? items[items.length - 1].id : null };
    }, true);
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
    if (!known) verifyViewerReference(uid, command.item, await this.orthanc.viewerReference(command.item.sopUid));

    return this.bounded(async tx => {
      const studies = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      visible(studies[0], c);
      const replay = await tx.viewerRequest.findUnique({ where: { authorSub_requestId: requestKey }, include: { result: { include: { item: true } } } });
      if (replay) {
        if (replay.fingerprint !== fingerprint || replay.result.item.studyUid !== uid || replay.result.item.authorSub !== c.sub) conflict();
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
        for (const field of ['schemaVersion', 'kind', 'seriesUid', 'sopUid', 'frame', 'frameOfReferenceUid'])
          if (old[field] !== command.item[field]) conflict();
        if ((command.action === 'hide' && head.hidden) || (command.action === 'restore' && !head.hidden)) conflict();
      }
      const hidden = command.action === 'hide' || (command.action === 'edit' && head.hidden);
      const snapshot = { ...command.item, hidden }, serialized = canonical(snapshot);
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
      if (head) head = await tx.viewerItem.update({ where: { id }, data: { snapshot, hidden, revision, updatedAt: now } });
      else head = await tx.viewerItem.create({ data: { id: randomUUID(), studyUid: uid, authorSub: c.sub, authorActor: c.actor,
        snapshot, hidden, revision, createdAt: now, updatedAt: now } });
      await tx.viewerRevision.create({ data: { itemId: head.id, revision, snapshot, action: command.action,
        reason: command.reason, actor: c.actor, payloadBytes: bytes, at: now } });
      await tx.viewerStorageBudget.update({ where: { studyUid: uid }, data: {
        itemCount: { increment: added }, revisionCount: { increment: 1 }, payloadBytes: { increment: bytes } } });
      await tx.auditLog.create({ data: { actor: c.actor, action: 'viewer.' + command.action, target: uid,
        detail: JSON.stringify({ itemId: head.id, revision, authorSub: c.sub, payloadBytes: bytes }) } });
      await tx.viewerRequest.create({ data: { ...requestKey, fingerprint, itemId: head.id, revision } });
      return result(head);
    });
  }
}
