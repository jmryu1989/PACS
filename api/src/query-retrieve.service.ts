/*
 * FC-070 Query/Retrieve: an institution's administrator registers another PACS (DicomPeer); its radiologists and
 * technicians search it (C-FIND) and pull a study into this archive (C-MOVE, the peer sends to our AE). A pulled study
 * arrives like every other DICOM arrival: the worklist's arrival rule decides its hospital (InstitutionName alias or a
 * registered sending device, D1882), so a study can be held, and "Arrived" is only what the caller's own list opens.
 *
 * A search, the studies it answered and a retrieve job belong to the institution and the member who made them: they
 * live in this process (a search's answers for an hour, a job for a day) and another member's or institution's is 404.
 */
import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { PacsService } from './pacs.service';
import { need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import { dump } from './pacs/values';
import { QR_MESSAGES, QR_ROW_CAP, answerRows, isStudyUid, jobAnswer, modalityBody, normalizePeer, peerFailure, peerKey, searchCriteria } from './query-retrieve';
import type { JobAnswer } from './query-retrieve';

const ANSWER_TTL_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ANSWERS = 20000;
const MAX_JOBS = 5000;

type Peer = { id: string; institutionId: string; name: string; aet: string; host: string; port: number };
type Job = { id: string; institution: string; sub: string; peerId: string; studyUid: string; orthancJob: string;
  ourAet: string; expected: number | null; before: number; at: number; final?: JobAnswer };

/** A member route: radiologist or technician (admin passes every role check, as everywhere). */
function member(c: Caller) {
  if (c.kind !== 'member' || !['radiologist', 'technician', 'admin'].some(role => c.roles?.includes(role)))
    throw new ForbiddenException('Query/Retrieve은(는) radiologist 또는 technician 권한이 필요합니다');
}

@Injectable()
export class QueryRetrieveService {
  private readonly answered = new Map<string, { expected: number | null; at: number }>();
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly prisma: PrismaService, private readonly orthanc: OrthancService, private readonly pacs: PacsService) {}

  // ── admin: the institution's peers ──

  async adminPeers(c: Caller) {
    need(c.roles, 'admin', '상대 PACS 조회');
    const me = inst(c);
    const peers = await this.prisma.dicomPeer.findMany({ where: { institutionId: me }, orderBy: [{ name: 'asc' }, { aet: 'asc' }] });
    return { peers: peers.map(p => ({ id: p.id, name: p.name, aet: p.aet, host: p.host, port: p.port, createdAt: p.createdAt })) };
  }

  /** Register a peer for the admin's own institution; the row and its audit commit together. */
  async registerPeer(body: any, c: Caller) {
    need(c.roles, 'admin', '상대 PACS 등록');
    const me = inst(c);
    const peer = normalizePeer(body);
    try {
      const created = await this.prisma.$transaction(async tx => {
        const row = await tx.dicomPeer.create({ data: { institutionId: me, ...peer, createdBy: c.actor || 'unknown' } });
        await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'institution.dicom-peer.register', target: row.id,
          detail: dump({ institution: me, name: row.name, aet: row.aet, host: row.host, port: row.port }) } });
        return row;
      }, { maxWait: 4000, timeout: 8000 });
      return { peer: { id: created.id, name: created.name, aet: created.aet, host: created.host, port: created.port, createdAt: created.createdAt } };
    } catch (error: any) {
      if (error?.code === 'P2002') throw new ConflictException('이 기관에 같은 AE Title의 상대 PACS가 이미 등록돼 있습니다');
      throw error;
    }
  }

  /** Remove a peer: Orthanc's modality first (a failure keeps the row, so nothing is left registered unseen), then the row. */
  async removePeer(id: string, c: Caller) {
    need(c.roles, 'admin', '상대 PACS 삭제');
    const me = inst(c);
    const peer = await this.peer(id, me);
    await this.orthanc.deleteModality(peerKey(me, peer.id));
    await this.prisma.$transaction(async tx => {
      await tx.dicomPeer.delete({ where: { id: peer.id } });
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'institution.dicom-peer.remove', target: peer.id,
        detail: dump({ institution: me, name: peer.name, aet: peer.aet, host: peer.host, port: peer.port }) } });
    }, { maxWait: 4000, timeout: 8000 });
    return { removed: peer.id };
  }

  // ── members: search, retrieve, follow ──

  async peers(c: Caller) {
    member(c);
    const me = inst(c);
    const peers = await this.prisma.dicomPeer.findMany({ where: { institutionId: me }, orderBy: [{ name: 'asc' }, { aet: 'asc' }],
      select: { id: true, name: true } });
    return { peers, ...(peers.length ? {} : { message: QR_MESSAGES.noPeer }) };
  }

  async search(body: any, c: Caller) {
    member(c);
    const me = inst(c);
    const criteria = searchCriteria(body);
    const peer = await this.peer(criteria.peerId, me);
    const key = peerKey(me, peer.id);
    await this.orthanc.putModality(key, modalityBody(peer));
    const found = await this.orthanc.queryModality(key, criteria.query);
    if (found.ok === false) throw this.peerError(peer, found.body);
    let all;
    try { all = answerRows(found.answers); } catch { throw new BadGatewayException(QR_MESSAGES.connect(peer.name)); }
    const truncated = all.length > QR_ROW_CAP, rows = all.slice(0, QR_ROW_CAP);
    const here = await this.openable(c, rows.map(row => row.studyUid));
    const now = Date.now();
    this.prune(now);
    for (const row of rows) {
      const remembered = this.answerKey(me, c.sub, peer.id, row.studyUid);
      this.answered.delete(remembered);
      this.answered.set(remembered, { expected: row.instances, at: now });
    }
    while (this.answered.size > MAX_ANSWERS) this.answered.delete(this.answered.keys().next().value!);
    // The audit names which criteria were used and how many answered - never a patient value.
    await this.prisma.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'query-retrieve.search', target: peer.id,
      detail: dump({ institution: me, peer: peer.id, fields: criteria.fields, count: all.length, truncated }) } });
    return { rows: rows.map(row => ({ ...row, here: here.has(row.studyUid) })), truncated,
      ...(truncated ? { message: QR_MESSAGES.truncated } : {}) };
  }

  async retrieve(body: any, c: Caller) {
    member(c);
    const me = inst(c);
    if (!body || typeof body !== 'object' || typeof body.peerId !== 'string' || !isStudyUid(body.studyUid))
      throw new BadRequestException('가져오기 요청 형식이 잘못되었습니다');
    const peer = await this.peer(body.peerId, me);
    const studyUid: string = body.studyUid;
    const now = Date.now();
    this.prune(now);
    const remembered = this.answered.get(this.answerKey(me, c.sub, peer.id, studyUid));
    if (!remembered) throw new NotFoundException(QR_MESSAGES.studyNotFound);
    const ourAet = await this.orthanc.ownAet();
    const before = (await this.orthanc.studyInstanceCounts([studyUid])).get(studyUid) ?? 0;
    const key = peerKey(me, peer.id);
    await this.orthanc.putModality(key, modalityBody(peer));
    const moved = await this.orthanc.moveStudy(key, studyUid, ourAet);
    if (moved.ok === false) throw this.peerError(peer, moved.body);
    const id = randomUUID();
    this.jobs.set(id, { id, institution: me, sub: c.sub, peerId: peer.id, studyUid, orthancJob: moved.job, ourAet,
      expected: remembered.expected, before, at: now });
    while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value!);
    await this.prisma.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'query-retrieve.retrieve', target: studyUid,
      detail: dump({ institution: me, peer: peer.id, job: id }) } });
    return { jobId: id };
  }

  /**
   * A retrieve's state. While Orthanc's job runs: pending or running with its progress. Once it ended: what arrived
   * decides - the caller's own list opens it (arrived), no hospital is decided for it (held), fewer instances than the
   * peer answered or a failed move (failed). An ended answer is kept and repeated.
   */
  async job(id: string, c: Caller): Promise<JobAnswer> {
    member(c);
    const me = inst(c);
    this.prune(Date.now());
    const job = typeof id === 'string' ? this.jobs.get(id) : undefined;
    if (!job || job.institution !== me || job.sub !== c.sub) throw new NotFoundException(QR_MESSAGES.jobNotFound);
    if (job.final) return job.final;
    const orthancJob = await this.orthanc.job(job.orthancJob);
    if (!orthancJob) return (job.final = { state: 'failed', progress: 100, reason: QR_MESSAGES.moveFailed(job.ourAet) });
    if (orthancJob.State !== 'Success' && orthancJob.State !== 'Failure') return jobAnswer(orthancJob, null, job.ourAet);
    const count = (await this.orthanc.studyInstanceCounts([job.studyUid])).get(job.studyUid) ?? 0;
    let openable = false, held = false;
    if (count > 0) {
      const read = await this.openable(c, [job.studyUid]);
      // The list could not be read just now: not an answer yet, asked again on the next poll.
      if (read.unconfirmed) return { state: 'running', progress: 100, reason: null };
      openable = read.has(job.studyUid);
      if (!openable) {
        const state = await this.prisma.studyState.findUnique({ where: { uid: job.studyUid }, select: { institutionId: true } });
        held = !!state && state.institutionId == null;
      }
    }
    const answer = jobAnswer(orthancJob, { count, before: job.before, expected: job.expected, openable, held }, job.ourAet);
    job.final = answer;
    return answer;
  }

  // ── shared ──

  private async peer(id: unknown, me: string): Promise<Peer> {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new NotFoundException(QR_MESSAGES.peerNotFound);
    const peer = await this.prisma.dicomPeer.findFirst({ where: { id, institutionId: me } });
    if (!peer) throw new NotFoundException(QR_MESSAGES.peerNotFound);
    return peer;
  }

  private peerError(peer: Peer, body: unknown) {
    const failure = peerFailure(body);
    return new BadGatewayException(failure.kind === 'refused' ? QR_MESSAGES.refused(failure.status) : QR_MESSAGES.connect(peer.name));
  }

  /**
   * The UIDs this archive holds that the caller's own worklist opens now: the worklist's own targeted read (its
   * institution boundary, StudyAccess and patient identity rules, and the arrival registration of a first-seen study).
   * A read that fails or changed under it leaves those UIDs closed - Here only shows what was confirmed.
   */
  private async openable(c: Caller, uids: string[]): Promise<Set<string> & { unconfirmed?: boolean }> {
    const out: Set<string> & { unconfirmed?: boolean } = new Set<string>();
    if (!uids.length) return out;
    const held = [...(await this.orthanc.studyInstanceCounts(uids)).keys()];
    for (let i = 0; i < held.length; i += 100) {
      try {
        const body: any = await this.pacs.listStudies(c, { uids: held.slice(i, i + 100).join(',') });
        for (const row of body?.studies ?? []) if (typeof row?.uid === 'string') out.add(row.uid);
      } catch { out.unconfirmed = true; }
    }
    return out;
  }

  private answerKey(institution: string, sub: string, peer: string, uid: string) {
    return JSON.stringify([institution, sub, peer, uid]);
  }

  private prune(now: number) {
    for (const [key, value] of this.answered) { if (now - value.at <= ANSWER_TTL_MS) break; this.answered.delete(key); }
    for (const [key, value] of this.jobs) { if (now - value.at <= JOB_TTL_MS) break; this.jobs.delete(key); }
  }
}
