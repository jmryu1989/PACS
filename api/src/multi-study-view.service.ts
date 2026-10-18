/*
 * W9-LITE 서버 절반(W9-API): 같은 환자의 검사 2–20개를 한 번에 여는 열람 목록의 서버 판정 `POST studies/viewing-set/resolve`.
 *
 * 조회 전용이다. 임상 행·StudyState lazy 등록·schema 변경이 없고, 판정은 기존 공개 계약만 소비한다: 역할 need()·기관 inst()·
 * 기관 경계 PacsAccess.visible()·StudyAccess.allowed()/unchanged()·split 판정 unresolvedSource(). 판정을 여기 다시 만들면
 * 한쪽만 고쳐지는 날이 온다.
 *
 * 순서가 계약이다(spec §3): 역할 → 기관 → 입력 전체 → member마다 StudyState·visible → 자기 기관·tele 제외 → StudyAccess(그
 * 준비용 원본 읽기도 같은 resolve 신호로 취소) →
 * 허용된 member만 원본 읽기(동시 4, 전체 10초, fetch·본문 취소) → 원본 자원 수(split) → 원본 PatientID → 같은 환자 키 →
 * 기관·tele·정책 재확인 → 열람 기록의 영속 영수증 → 본문. 권한 없는 UID의 원본은 읽지 않고, 그 UID의 존재·기관·split 여부도
 * 답하지 않는다.
 *
 * 열람 기록(spec §5, D1500 D-6): 준비된 member의 metadata는 member마다의 영속 provide 영수증을 받은 뒤에만 나간다. 이 빌드에는
 * 원장 소유자가 없다(EMR-B2 base + 공용 Module A가 아직 없다) — AppModule은 ViewingSetAccess를 ViewingSetAccessUnbound에
 * 묶고, 그것은 어떤 제공도 503으로 거절한다. 기록 없는 본문도, 지어낸 사건도 없다.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { StudyAccessService } from './study-access.service';
import type { AccessSnapshot } from './study-access.service';
import { PacsAccess, need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import type { WorkContext } from './emr-contract/access-event';
import { viewerJson, viewerUid } from './viewer-input';
import { STUDY_IDENTITY_UNRESOLVED, unresolvedSource } from './study-source-groups';

export const W9_SELECTION_INVALID = 'W9_SELECTION_INVALID';
export const W9_VIEW_FORBIDDEN = 'W9_VIEW_FORBIDDEN';
export const W9_PATIENT_MISMATCH = 'W9_PATIENT_MISMATCH';
export const W9_CONTEXT_CHANGED = 'W9_CONTEXT_CHANGED';
export const W9_AUDIT_UNAVAILABLE = 'W9_AUDIT_UNAVAILABLE';
export const W9_MEMBER_UNAVAILABLE = 'W9_MEMBER_UNAVAILABLE';
export const W9_SCOPE_EXCLUDED = 'W9_SCOPE_EXCLUDED';
export const W9_IDENTITY_UNAVAILABLE = 'W9_IDENTITY_UNAVAILABLE';
export const W9_LOAD_FAILED = 'W9_LOAD_FAILED';

/** The route this service answers, as the EMR route classification and an access event's surface name it. */
export const VIEWING_SET_SURFACE = 'POST studies/viewing-set/resolve';
// deadlineMs: the one resolve deadline (spec §3). servedReadCutMs: the served reads stop there, keeping a fixed
// 1000 ms reserve of the same 10 s for the re-check and the durable receipt (9000/1000 split, D1558).
export const VIEWING_SET_LIMITS = Object.freeze({ minMembers: 2, maxMembers: 20, concurrentReads: 4, deadlineMs: 10000,
  servedReadCutMs: 9000 });
// A member opens with the owner's own images only: no tele channel in either direction, and a tele state that is closed.
const LOCAL_TELE_STATES = ['none', 'cancelled', 'fail'];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BODY_KEYS = 'compositionId,expectedSourcePatientKey,generation,requestId,studyUids';

const refusal = (Exception: new (body: object) => Error, code: string, message: string) => new Exception({ code, message });
const selectionInvalid = () => refusal(BadRequestException, W9_SELECTION_INVALID,
  '같은 환자의 검사를 2개에서 20개까지 선택하세요. 중복 검사는 포함할 수 없습니다.');
const viewForbidden = () => refusal(ForbiddenException, W9_VIEW_FORBIDDEN, '여러 검사 열기는 판독의 권한이 필요합니다.');
const patientMismatch = () => refusal(ConflictException, W9_PATIENT_MISMATCH,
  '원본 환자 ID가 다른 검사는 함께 열 수 없습니다. 선택 목록을 확인하세요.');
const contextChanged = () => refusal(ConflictException, W9_CONTEXT_CHANGED,
  '선택·환자 정보 또는 로그인 상태가 바뀌었습니다. 목록에서 다시 여세요.');
export const auditUnavailable = () => refusal(ServiceUnavailableException, W9_AUDIT_UNAVAILABLE,
  '열람 기록을 저장하지 못했습니다. 잠시 후 Retry로 다시 시도하세요.');

/** The minimal source display metadata of one member, exactly as the body carries it. No report, draft or version body. */
export interface ViewingSetMetadata {
  patientId: string; patientName: string; institutionName: string; studyDate: string; modalities: string[];
  description: string; accession: string;
}
/** One member whose metadata this response provides: what was actually read and what the body will carry for it. */
export interface ViewingSetTarget {
  uid: string; ordinal: number;
  /** StudyState.institutionId of the member (the caller's own institution; every member was held to it). */
  managingInstitutionId: string;
  /** The raw PatientID of the member's one original resource, as read. Never the issuer: no issuer is read. */
  patientId: string;
  metadata: ViewingSetMetadata;
  /** D1500 D-5: the ordered first UID is the request's comparison anchor; never a silently chosen other one. */
  context: WorkContext;
}
/** The provision a resolve asks to be recorded before its body: one target per member provided, never a composition row. */
export interface ViewingSetProvision {
  caller: Caller; requestId: string; auditLinkId: string; surface: string; kind: 'study-metadata'; cause: 'user-view';
  targets: ViewingSetTarget[];
}
/** Durable receipts, one per target: UID -> the provide-prepared event's ID (a correlation, never a permission). */
export interface ViewingSetReceipts { readonly accessRefs: ReadonlyMap<string, string> }
/** What happened to the one HTTP body that carried the prepared targets, as the response observed it. */
export type TransferOutcome = 'ended' | 'aborted';

/**
 * The access-record port of the resolve (spec §7 prepareMember/finishTransfer over the existing B1 store). prepare() resolves
 * only when every target's provide-prepared event is durable; finish() records the observed transfer of that body. The
 * owner and the event planner are the shared Module A on the EMR-B2 base (consult D1483, D1500 D-2); they bind here.
 *
 * Binding precondition: no real store is bound here before the resolve re-checks the caller's membership and session
 * (EMR-B2 verified request facts) between the source wait and prepare(); this build has no such seam (W9API-20, pending).
 * A prepare() that rejects owns what it already made durable: it records those events' end (aborted / storage-failed)
 * through its own journal before rejecting, because the resolve sends no body and calls no finish() after a rejection.
 */
export abstract class ViewingSetAccess {
  abstract prepare(provision: ViewingSetProvision): Promise<ViewingSetReceipts>;
  abstract finish(receipts: ViewingSetReceipts, outcome: TransferOutcome): Promise<void>;
}

/** This build's binding: no access-ledger owner is assembled, so no provision can be recorded and none is made. */
@Injectable()
export class ViewingSetAccessUnbound extends ViewingSetAccess {
  async prepare(): Promise<ViewingSetReceipts> { throw auditUnavailable(); }
  async finish(): Promise<void> { throw auditUnavailable(); }
}

interface Selection { compositionId: string; generation: number; requestId: string; studyUids: string[]; expected: string | null }
interface StateRow { uid: string; institutionId: string | null; teleInstitutionId: string | null; ts: string }
interface Member {
  uid: string; ordinal: number; state: StateRow | null; code: string | null;
  rows?: any[] | null; key?: string; patientId?: string; metadata?: ViewingSetMetadata;
}

/** Closed body; every refusal is the one 400, decided before any database or source read. */
function selection(raw: unknown): Selection {
  let body: any;
  try { body = viewerJson(raw as Buffer); } catch { throw selectionInvalid(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== BODY_KEYS) throw selectionInvalid();
  const { compositionId, generation, requestId, studyUids, expectedSourcePatientKey: expected } = body;
  if (typeof compositionId !== 'string' || !UUID4.test(compositionId) || typeof requestId !== 'string' || !UUID4.test(requestId)
      || !Number.isSafeInteger(generation) || generation < 1 || generation > 2147483647
      || !Array.isArray(studyUids) || studyUids.length < VIEWING_SET_LIMITS.minMembers || studyUids.length > VIEWING_SET_LIMITS.maxMembers
      || new Set(studyUids).size !== studyUids.length)
    throw selectionInvalid();
  try { studyUids.forEach(uid => viewerUid(uid)); } catch { throw selectionInvalid(); }
  // The expected key is compared, never trusted: it is only the stale check of an admitted set, so a bounded string suffices.
  if (expected !== null && (typeof expected !== 'string' || !expected.length || expected.length > 512 || /[\u0000-\u001f\u007f]/.test(expected)))
    throw selectionInvalid();
  return { compositionId, generation, requestId, studyUids: [...studyUids], expected };
}

const text = (row: any, tag: string) => { const value = row?.[tag]?.Value?.[0]; return typeof value === 'string' ? value : ''; };

/** The worklist's own display of the same tags (name carets as spaces), so the list and the viewing set read alike. */
function metadataOf(row: any): ViewingSetMetadata {
  const modalities = row?.['00080061']?.Value;
  return {
    patientId: text(row, '00100020'), patientName: OrthancService.tag(row, '00100010').replace(/\^/g, ' '),
    institutionName: text(row, '00080080'), studyDate: text(row, '00080020'),
    modalities: Array.isArray(modalities) ? modalities.filter((m: unknown): m is string => typeof m === 'string') : [],
    description: text(row, '00081030'), accession: text(row, '00080050'),
  };
}

const sameState = (a: StateRow | null, b: StateRow | null | undefined) => (a === null ? b == null : !!b
  && a.institutionId === b.institutionId && a.teleInstitutionId === b.teleInstitutionId && a.ts === b.ts);

/** The resolve deadline reached a wait: the typed timeout outcome, never a source or database answer. */
class ResolveDeadline extends Error {}
/**
 * One wait under the resolve deadline. The deadline settles it at once; what the wait answers afterwards is discarded,
 * and its late failure is consumed here (no unhandled rejection). A wait the deadline already passed is not started.
 * Cancelling the work itself is the signal's job where the work takes it (the source reads); a database query is left
 * to finish on its own and its answer is dropped.
 */
function within<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ResolveDeadline());
  return new Promise<T>((resolve, reject) => {
    const expire = () => reject(new ResolveDeadline());
    signal.addEventListener('abort', expire, { once: true });
    const done = () => signal.removeEventListener('abort', expire);
    Promise.resolve().then(work).then(
      value => { done(); if (signal.aborted) reject(new ResolveDeadline()); else resolve(value); },
      error => { done(); reject(signal.aborted ? new ResolveDeadline() : error); });
  });
}

@Injectable()
export class MultiStudyViewService {
  private readonly pacsAccess: PacsAccess;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orthanc: OrthancService,
    private readonly studyAccess: StudyAccessService,
    private readonly access: ViewingSetAccess) {
    this.pacsAccess = new PacsAccess(prisma, studyAccess);
  }

  /**
   * `transfer` is the observed end of this request's HTTP body; the controller starts observing before any provision.
   * The answer is the body. A provision that is not durable answers 503 before any member metadata exists in a reply.
   */
  async resolve(raw: unknown, c: Caller, transfer: Promise<TransferOutcome>) {
    // A-01: nothing about identity, institution or rights comes from the body; all of it is decided before any read.
    if (c?.kind !== 'member') throw viewForbidden();
    try { need(c.roles, 'radiologist', '여러 검사 열기'); } catch { throw viewForbidden(); }
    const me = inst(c);
    const input = selection(raw);

    // A-03: one deadline per resolve, and its one signal, from here to the answer. Every wait is raced against it - the
    // policy and member reads, the StudyAccess decision (whose own source read takes the signal and is cancelled with its
    // body), the served reads (same, and cut earlier at servedReadCutMs), the re-check and the durable receipt. The
    // deadline answers at once wherever it lands: a member without its own cause is W9_LOAD_FAILED and nothing is
    // provided (in the receipt wait: 503, and a late receipt is finished as aborted).
    const deadline = new AbortController();
    const signal = deadline.signal;
    const timer = setTimeout(() => deadline.abort(), VIEWING_SET_LIMITS.deadlineMs);
    // D1558: the served reads run under a child of the one deadline that is cut at servedReadCutMs (9000 of 10000 ms).
    // The fixed 1000 ms reserve is for the A-05 re-check and the durable receipt of the members read in time.
    const servedCut = new AbortController();
    const cutTimer = setTimeout(() => servedCut.abort(), VIEWING_SET_LIMITS.servedReadCutMs);
    const relay = () => servedCut.abort();
    signal.addEventListener('abort', relay, { once: true });
    const members: Member[] = input.studyUids.map((uid, ordinal) => ({ uid, ordinal, state: null, code: null }));
    const answer = (accessRefs: ReadonlyMap<string, string> | null) => {
      const ready = members.filter(m => !m.code);
      return {
        compositionId: input.compositionId, generation: input.generation, requestId: input.requestId,
        sourcePatientKey: ready.length ? ready[0].key! : null,
        scopeStatus: ready.length === members.length ? 'ready' : ready.length ? 'partial' : 'rejected',
        members: members.map(m => m.code ? { uid: m.uid, ordinal: m.ordinal, status: 'error', code: m.code }
          : { uid: m.uid, ordinal: m.ordinal, status: 'ready', metadata: m.metadata!, accessRef: accessRefs!.get(m.uid)! }),
      };
    };
    const timedOut = () => {
      for (const m of members) if (!m.code) m.code = W9_LOAD_FAILED;
      return answer(null);
    };
    try {
      let policy: AccessSnapshot;
      try {
        // A-02: one read of the members' rows (no transaction, no lazy registration), then each member on its own.
        policy = await within(() => this.studyAccess.snapshot(c), signal);
        const first = await within(() => this.states(input.studyUids), signal);
        for (const m of members) {
          m.state = first.get(m.uid) ?? null;
          if (!m.state || !this.pacsAccess.visible(m.state, me)) m.code = W9_MEMBER_UNAVAILABLE;
          else if (m.state.institutionId !== me || m.state.teleInstitutionId !== null || !LOCAL_TELE_STATES.includes(m.state.ts))
            m.code = W9_SCOPE_EXCLUDED;
        }
        const candidates = members.filter(m => !m.code);
        // The signal reaches StudyAccess's own source read (its preparation), so the deadline also cancels that read.
        const allowed = candidates.length
          ? await within(() => this.studyAccess.allowed(c, candidates.map(m => m.uid), undefined, signal), signal) : new Set<string>();
        for (const m of candidates) if (!allowed.has(m.uid)) m.code = W9_MEMBER_UNAVAILABLE;
      } catch (error) { if (error instanceof ResolveDeadline) return timedOut(); throw error; }

      // A-03: only the admitted members' sources, each failure its own; then the one-resource rule before any key.
      const admitted = members.filter(m => !m.code);
      // The served reads end at the sub-cut (9 s), so the members read in time keep 1 s of the same deadline for their
      // re-check and receipt; a read still pending at the sub-cut is W9_LOAD_FAILED and its fetch and body are cancelled.
      await this.readSources(admitted, servedCut.signal);
      // StudyAccess decided on the source rows its own preparation read. What is served is this later read, so a policy
      // that reads source tags must hold for every row served (the same per-resource AND); a tag that changed between the
      // two reads makes that member unavailable like any other refusal, before the split answer can name it.
      const sourcePolicy = this.studyAccess.needsMetadata(policy);
      for (const m of admitted) {
        if (!Array.isArray(m.rows)) m.code = W9_LOAD_FAILED;
        else if (!m.rows.length) m.code = W9_MEMBER_UNAVAILABLE;
        else if (sourcePolicy && !m.rows.every(row => this.studyAccess.matches(policy, m.uid, row))) m.code = W9_MEMBER_UNAVAILABLE;
        else if (unresolvedSource(m.rows)) m.code = STUDY_IDENTITY_UNRESOLVED;
        else {
          const patientId = m.rows[0]?.['00100020']?.Value?.[0];
          // Taken as read: no case, zero, Unicode or space normalisation, and no issuer read.
          if (typeof patientId !== 'string' || !patientId.trim()) m.code = W9_IDENTITY_UNAVAILABLE;
          else Object.assign(m, { patientId, key: `${m.state!.institutionId}|${patientId}`, metadata: metadataOf(m.rows[0]) });
        }
      }

      // SRW9R2-1: the rows are classified first, so a member with its own cause keeps it under a deadline (spec §3).
      if (signal.aborted) return timedOut();
      // A-04: one source patient key across every ready member, and the admitted set's own key when it has one.
      const ready = members.filter(m => !m.code);
      const keys = new Set(ready.map(m => m.key!));
      if (keys.size > 1 || (input.expected !== null && ready.length && !keys.has(input.expected))) throw patientMismatch();

      // A-05: the rows and the policy the decision used must still hold after the source wait.
      try {
        const second = await within(() => this.states(input.studyUids), signal);
        if (members.some(m => !sameState(m.state, second.get(m.uid)))) throw contextChanged();
        try { await within(() => this.studyAccess.unchanged(c, policy), signal); }
        catch (error) { if (error instanceof ConflictException) throw contextChanged(); throw error; }
      } catch (error) { if (error instanceof ResolveDeadline) return timedOut(); throw error; }

      // Nothing is provided when no member is ready: the answer carries the selected UIDs and their codes only.
      if (!ready.length) return answer(null);

      // A-06: every provided member's receipt before the body; any failure answers 503 with no member body.
      const anchor = members[0];
      const context = (m: Member): WorkContext => anchor.code
        ? { basis: 'worklist', studyId: m.uid, relatedStudyId: null, reason: null }
        : m === anchor ? { basis: 'worklist', studyId: anchor.uid, relatedStudyId: null, reason: null }
          : { basis: 'same-patient-comparison', studyId: anchor.uid, relatedStudyId: m.uid, reason: null };
      const provision: ViewingSetProvision = {
        caller: c, requestId: input.requestId, auditLinkId: 'audit:' + randomUUID(), surface: VIEWING_SET_SURFACE,
        kind: 'study-metadata', cause: 'user-view',
        targets: ready.map(m => ({ uid: m.uid, ordinal: m.ordinal, managingInstitutionId: m.state!.institutionId!,
          patientId: m.patientId!, metadata: m.metadata!, context: context(m) })),
      };
      let receipts: ViewingSetReceipts;
      const preparing = (async () => this.access.prepare(provision))();
      try { receipts = await within(() => preparing, signal); } catch (error) {
        // A receipt that arrives after the deadline answered 503 belongs to a body that never went out.
        if (error instanceof ResolveDeadline) void preparing.then(late => this.settle(late, Promise.resolve('aborted')), () => undefined);
        throw auditUnavailable();
      }
      const refs = receipts?.accessRefs;
      if (!(refs instanceof Map) || refs.size !== ready.length || new Set(refs.values()).size !== ready.length
          || ready.some(m => typeof refs.get(m.uid) !== 'string' || !refs.get(m.uid))) {
        this.settle(receipts, Promise.resolve('aborted'));
        throw auditUnavailable();
      }
      this.settle(receipts, transfer);
      return answer(refs);
    } finally {
      // The resolve is the owner of its source reads: whatever ends it (answer, refusal, throw, deadline), nothing it
      // started stays active. The transfer/receipt settlement is separate and is not cancelled here.
      deadline.abort(); servedCut.abort();
      signal.removeEventListener('abort', relay);
      clearTimeout(timer); clearTimeout(cutTimer);
    }
  }

  /**
   * The port records the observed end of the body after the reply. Its own failure journal owns a failed record: there is no
   * reply left to change, and an unhandled rejection would end the process.
   */
  private settle(receipts: ViewingSetReceipts, outcome: Promise<TransferOutcome>) {
    void outcome.then(result => this.access.finish(receipts, result)).catch(() => undefined);
  }

  private async states(uids: string[]): Promise<Map<string, StateRow>> {
    const rows = await this.prisma.studyState.findMany({ where: { uid: { in: uids } },
      select: { uid: true, institutionId: true, teleInstitutionId: true, ts: true } });
    return new Map(rows.map(row => [row.uid, row]));
  }

  /**
   * At most four reads at a time under the one resolve deadline. The signal reaches each fetch and its body; a read still
   * pending at the deadline, or answering after it, is a failed read (never stale metadata), and the queue stops; the
   * resolve then answers the deadline itself.
   */
  private async readSources(members: Member[], signal: AbortSignal) {
    const queue = [...members];
    const expired = new Promise<null>(settle => {
      if (signal.aborted) settle(null);
      else signal.addEventListener('abort', () => settle(null), { once: true });
    });
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        if (signal.aborted) { m.rows = null; continue; }
        const read = this.orthanc.viewingSetStudy(m.uid, signal).catch(() => null);
        const rows = await Promise.race([read, expired]);
        m.rows = signal.aborted ? null : rows;
      }
    };
    await Promise.all(Array.from({ length: Math.min(VIEWING_SET_LIMITS.concurrentReads, queue.length) }, worker));
  }
}
