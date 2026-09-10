import { StudyAccessService } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { Caller } from './pacs.service';
import { canonical, viewerUid, viewerUuid, verifyViewerReference, isManualMeasurement } from './viewer-input';
import { jobCommand, jobFingerprint, verifyJobCell, previewCommand } from './viewer-job-input';
import { verifyVolumeReference, compactVolumeTags } from './viewer-volume-reference';
const deny = (): never => { throw new ForbiddenException('비교 작업에 접근할 수 없습니다'); };
const conflict = (): never => { throw new ConflictException('비교 작업이 변경되었습니다. 목록을 새로 확인하세요'); };
const annotationKinds = ['arrow', 'length', 'angle', 'ellipse'];
const allowed = (s: any, c: Caller) => !!s && !!c.institution && typeof s.rs === 'string' && (s.institutionId === c.institution || s.teleInstitutionId === c.institution) && (s.rs !== 'P' || s.preDoc === c.actor || s.preReviewer === c.actor);
const summary = (j: any) => ({ id: j.id, studyUid: j.studyUid, authorSub: j.authorSub, authorActor: j.authorActor, title: j.title,
  description: j.description, hidden: j.hidden, revision: j.revision, createdAt: j.createdAt, updatedAt: j.updatedAt,
  snapshotVersion: j.snapshot?.version });

@Injectable()
export class ViewerJobService {
  constructor(private prisma: PrismaService, private orthanc: OrthancService, private studyAccess:StudyAccessService) {}
  private member(c: Caller, write = false) {
    if (c.kind !== 'member' || !c.sub || !c.actor || !c.institution || write && !c.roles.includes('radiologist')) deny();
  }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`; await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return work(tx);
      }, { isolationLevel: read ? 'RepeatableRead' : 'ReadCommitted', maxWait: 4000, timeout: 8000 });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (['P2002', 'P2003', 'P2034'].includes(e.code)) conflict();
        if (e.code === 'P2028' || e.code === 'P2010' && ['55P03', '57014'].includes(String(e.meta?.code))) throw new ServiceUnavailableException('저장 지연입니다. 같은 작업으로 다시 시도하세요');
      }
      throw e;
    }
  }
  private async parents(tx: any, studies: string[], c: Caller, lock = false) {
    await this.studyAccess.snapshot(c,tx);
    const rows = lock ? await tx.$queryRaw`SELECT uid, "institutionId", "teleInstitutionId", rs, "preDoc", "preReviewer" FROM "StudyState" WHERE uid IN (${Prisma.join([...studies].sort())}) ORDER BY uid FOR UPDATE`
      : await tx.studyState.findMany({ where: { uid: { in: studies } } });
    if (rows.length !== studies.length || rows.some(s => !allowed(s, c))) deny();
    await this.studyAccess.require(c,studies,tx);
    return rows;
  }
  private async sources(snapshot: any, old = false, sources = new Map<string, any>()) {
    const identity = new Map<string, string>();
    for (const uid of snapshot.studies) identity.set(uid, (await this.orthanc.connectStudyIdentity(uid)).patientId);
    if (new Set(identity.values()).size !== 1) throw new BadRequestException('같은 환자의 검사만 비교 작업으로 저장할 수 있습니다');
    if ([4,5].includes(snapshot.version)) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
      try {
        const before = await this.orthanc.viewerSeriesManifest(snapshot.volume.series, controller.signal);
        if (before.length !== snapshot.volume.sops.length) throw new BadRequestException('원본 시리즈의 모든 프레임을 포함해야 합니다');
        const tags: any[] = new Array(before.length); let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, before.length) }, async () => {
          while (index < before.length) { const i = index++; tags[i] = compactVolumeTags(await this.orthanc.viewerReference(snapshot.volume.sops[i], true, controller.signal)); }
        }));
        const digest = verifyVolumeReference(snapshot, tags, identity.get(snapshot.volume.study));
        const after = await this.orthanc.viewerSeriesManifest(snapshot.volume.series, controller.signal);
        if (canonical(before) !== canonical(after)) throw new ConflictException('원본 시리즈가 변경되어 저장 또는 복원을 중단했습니다');
        if (old && snapshot.volume.sourceDigest !== digest) throw new ConflictException('저장 당시 볼륨 원본과 달라 복원하지 않았습니다');
        return { ...snapshot, volume: { ...snapshot.volume, sourceDigest: digest } };
      } catch(error) {
        if(old && error instanceof BadRequestException)throw new ConflictException('저장 당시 볼륨 원본과 달라 복원하지 않았습니다');
        throw error;
      } finally { clearTimeout(timer); controller.abort(); }
    }
    const cells = [];
    for (const cell of snapshot.cells) {
      if (!cell) { cells.push(null); continue; }
      if (!sources.has(cell.sop)) sources.set(cell.sop, await this.orthanc.viewerReference(cell.sop, true));
      const tags = sources.get(cell.sop); verifyJobCell(cell, tags);
      if (tags.PatientID !== identity.get(cell.study)) throw new BadRequestException('원본 환자 참조가 일치하지 않습니다');
      if (old && cell.sourceDigest !== tags._kinSourceDigest) throw new ConflictException('저장 당시 원본과 달라 복원하지 않았습니다');
      cells.push({ ...cell, sourceDigest: tags._kinSourceDigest });
    }
    return { ...snapshot, cells };
  }
  private async annotations(tx: any, snapshot: any, sources: Map<string, any>) {
    const refs = snapshot.annotations;
    if (!Array.isArray(refs) || refs.length > 64 || new Set(refs.map(r => r.id)).size !== refs.length)
      throw new ConflictException('저장 주석 이력을 확인할 수 없습니다');
    if (!refs.length) return [];
    const revisions = await tx.viewerRevision.findMany({
      where: { OR: refs.map(r => ({ itemId: r.id, revision: r.revision, item: { studyUid: r.study } })) },
      include: { item: { select: { studyUid: true, authorActor: true } } },
    });
    const byRef = new Map(revisions.map(r => [r.itemId + '/' + r.revision, r]));
    let size = 2;
    const result = refs.map(ref => {
      const revision: any = byRef.get(ref.id + '/' + ref.revision), item = revision?.snapshot;
      const cell = snapshot.cells.find(c => c && c.study === ref.study && c.sop === item?.sopUid && c.series === item?.seriesUid && c.frame === item?.frame);
      if (!revision || !cell || revision.item.studyUid !== ref.study || item.hidden || !annotationKinds.includes(item.kind))
        throw new ConflictException('저장 주석의 원본 참조가 일치하지 않습니다');
      const tags = sources.get(cell.sop); verifyViewerReference(ref.study, item, tags);
      if (isManualMeasurement(item.kind) && item.sourceDigest !== cell.sourceDigest)
        throw new ConflictException(`주석 ${ref.id} (r${ref.revision})의 측정 원본이 달라졌습니다. 해당 영상을 비교에서 제외하거나 영상만 저장하세요. 주석을 포함하려면 저장 당시 원본이 복구되어야 합니다`);
      const expanded = { ...ref, authorActor: revision.item.authorActor, at: revision.at.toISOString(), item };
      size += Buffer.byteLength(canonical(expanded)) + (size === 2 ? 0 : 1);
      if (size > 262144) throw new ConflictException('비교 작업 주석 용량 한도를 초과했습니다. 주석이 더 적은 영상으로 구성하거나 영상만 저장하세요');
      return expanded;
    });
    return result;
  }
  private async freezeAnnotations(tx: any, snapshot: any, sources: Map<string, any>) {
    // Viewer writes hold these same study locks. The selected heads and the Job
    // therefore commit as one moment, without modifying any annotation revision.
    const heads = await tx.viewerItem.findMany({ where: { hidden: false,
      AND: [{ OR: snapshot.cells.filter(Boolean).map(c => ({ studyUid: c.study, AND: [
        { snapshot: { path: ['sopUid'], equals: c.sop } }, { snapshot: { path: ['seriesUid'], equals: c.series } },
        { snapshot: { path: ['frame'], equals: c.frame } }] })) },
        { OR: annotationKinds.map(kind => ({ snapshot: { path: ['kind'], equals: kind } })) }] }, orderBy: { id: 'asc' }, take: 65,
      select: { id: true, studyUid: true, revision: true } });
    if (heads.length > 64) throw new ConflictException('비교 작업에는 주석64개까지 함께 저장할 수 있습니다');
    const frozen = { ...snapshot, annotations: heads.map(h => ({ id: h.id, study: h.studyUid, revision: h.revision })) };
    await this.annotations(tx, frozen, sources);
    return frozen;
  }
  private sameInstitution(rows: any[]) {
    if (!rows[0]?.institutionId || rows.some(s => s.institutionId !== rows[0].institutionId)) deny();
  }
  async list(uid: string, q: any, c: Caller) { await this.studyAccess.prepare(c);
    this.member(c); viewerUid(uid);
    if (Object.keys(q).some(k => !['mine', 'includeHidden'].includes(k)) || Object.values(q).some(v => !['true', 'false'].includes(v as string))) throw new BadRequestException('목록 조건이 올바르지 않습니다');
    return this.transaction(async tx => {
      await this.parents(tx, [uid], c);
      const jobs = await tx.viewerJob.findMany({ where: { studyUid: uid, ...(q.mine === 'true' ? { authorSub: c.sub } : {}), ...(q.includeHidden === 'true' ? {} : { hidden: false }) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
      const refs = [...new Set(jobs.flatMap(j => j.studies))];
      const parents = await tx.studyState.findMany({ where: { uid: { in: refs } } });
      const byUid = new Map(parents.map(s => [s.uid, s]));
      const permitted=await this.studyAccess.allowed(c,refs,tx);
      // Even titles and descriptions may refer to a prior whose permission was revoked.
      return { jobs: jobs.filter(j => j.studies.every(s => permitted.has(s)&&allowed(byUid.get(s), c))).map(summary) };
    }, true);
  }
  private async head(uid: string, id: string, c: Caller) {
    return this.transaction(async tx => {
      await this.parents(tx, [uid], c);
      const j = await tx.viewerJob.findUnique({ where: { id } });
      if (!j || j.studyUid !== uid) throw new NotFoundException('저장한 비교 작업이 없습니다');
      this.sameInstitution(await this.parents(tx, j.studies, c));
      return j;
    }, true);
  }
  async get(uid: string, id: string, c: Caller) { await this.studyAccess.prepare(c);
    this.member(c); viewerUid(uid); viewerUuid(id);
    const j = await this.head(uid, id, c);
    if (j.hidden) conflict();
    const sources = new Map<string, any>();
    await this.sources(j.snapshot, true, sources);
    const annotations = j.snapshot['version'] === 3 ? await this.annotations(this.prisma, j.snapshot, sources) : null;
    // Orthanc calls happen outside locks; permission and metadata revision must
    // still be current after those calls before returning a restorable snapshot.
    const latest = await this.head(uid, id, c); if (latest.hidden || latest.revision !== j.revision) conflict();
    return { ...summary(latest), snapshot: latest.snapshot, ...(annotations ? { annotations } : {}) };
  }
  async preview(uid: string, raw: Buffer, c: Caller) {
    this.member(c); viewerUid(uid);
    const input = previewCommand(raw);
    if (input.studies[0] !== uid) throw new BadRequestException('판독 대상 검사가 일치하지 않습니다');
    this.sameInstitution(await this.parents(this.prisma, input.studies, c));
    const snapshot = await this.sources(input);
    // Recheck access after remote reads; no Job, annotation or audit write.
    this.sameInstitution(await this.parents(this.prisma, input.studies, c));
    return { snapshot };
  }
  async create(uid: string, raw: Buffer, c: Caller) {
    this.member(c, true); viewerUid(uid);
    const b = jobCommand(raw, true), fingerprint = jobFingerprint({ uid, ...b });
    if (b.snapshot.studies[0] !== uid) throw new BadRequestException('판독 대상 검사가 일치하지 않습니다');
    this.sameInstitution(await this.parents(this.prisma, b.snapshot.studies, c));
    const known = await this.prisma.viewerJob.findUnique({ where: { id: b.id } });
    const sources = new Map<string, any>();
    const snapshot = known ? null : await this.sources(b.snapshot, false, sources);
    return this.transaction(async tx => {
      this.sameInstitution(await this.parents(tx, b.snapshot.studies, c, true));
      const replay = await tx.viewerJob.findUnique({ where: { id: b.id } });
      if (replay) {
        if (replay.studyUid !== uid || replay.authorSub !== c.sub || replay.fingerprint !== fingerprint) conflict();
        return summary(replay);
      }
      if (known) conflict();
      if (await tx.viewerJob.count({ where: { studyUid: uid } }) >= 200) throw new ConflictException('검사별 비교 작업 저장 한도에 도달했습니다');
      const frozen = snapshot.version === 3 ? await this.freezeAnnotations(tx, snapshot, sources) : snapshot;
      const now = new Date();
      const j = await tx.viewerJob.create({ data: { id: b.id, studyUid: uid, authorSub: c.sub, authorActor: c.actor, studies: b.snapshot.studies,
        fingerprint, snapshot: frozen, title: b.title, description: b.description, revision: 1, updatedAt: now } });
      await this.history(tx, j, '', c); return summary(j);
    });
  }
  private async history(tx: Prisma.TransactionClient, j: any, reason: string, c: Caller) {
    await tx.viewerJobRevision.create({ data: { jobId: j.id, revision: j.revision, title: j.title, description: j.description, hidden: j.hidden, reason, actor: c.actor } });
    await tx.auditLog.create({ data: { actor: c.actor, target: j.studyUid, action: 'viewer.job', detail: canonical({ jobId: j.id, revision: j.revision, hidden: j.hidden }) } });
  }
  async revise(uid: string, id: string, raw: Buffer, c: Caller) { await this.studyAccess.prepare(c);
    this.member(c, true); viewerUid(uid); viewerUuid(id); const b = jobCommand(raw, false);
    const head = await this.head(uid, id, c);
    return this.transaction(async tx => {
      this.sameInstitution(await this.parents(tx, head.studies, c, true));
      const j = await tx.viewerJob.findUnique({ where: { id } });
      if (!j || j.studyUid !== uid || j.authorSub !== c.sub) deny();
      if (j.revision !== b.expectedRevision || j.revision >= 1000) conflict();
      if (j.hidden !== b.hidden ? !b.reason.trim() : b.reason !== '') throw new BadRequestException('숨김/복원에는 사유가 필요합니다');
      const next = await tx.viewerJob.update({ where: { id }, data: { title: b.title, description: b.description, hidden: b.hidden, revision: { increment: 1 }, updatedAt: new Date() } });
      await this.history(tx, next, b.reason, c); return summary(next);
    });
  }
}
