/** W9 same-patient metadata admission (D1500).
 * Order: role -> institution -> input -> StudyState/visible -> local scope ->
 * StudyAccess -> sources -> split UID -> PatientID -> patient key -> A1 receipts -> body.
 * This read writes no clinical row or lazy StudyState. Use the existing public
 * access/identity contracts so their decisions cannot drift between consumers.
 * A denied member's serving source is never read. Keep the initial access decision;
 * D1764 removes the duplicate state/policy/source-tag rechecks, not that decision
 * or the returned UID and mixed-patient protections. PC3 also retires the outer
 * policy-revision interceptor; subsequent requests apply the current policy.
 * A1 records the selected metadata under the request work and withholds it until
 * every receipt is durable.
 */
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { ViewingSetAccess } from './emr-viewing/viewing-set-access';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { StudyAccessService } from './study-access.service';
import { PacsAccess, need, inst } from './pacs/access';
import type { Caller } from './pacs/access';
import type { WorkContext } from './emr-contract/access-event';
import { viewerJson, viewerUid } from './viewer-input';
import { STUDY_IDENTITY_UNRESOLVED, unresolvedSource } from './study-source-groups';

export const W9_SELECTION_INVALID = 'W9_SELECTION_INVALID';
export const W9_VIEW_FORBIDDEN = 'W9_VIEW_FORBIDDEN';
export const W9_PATIENT_MISMATCH = 'W9_PATIENT_MISMATCH';
export const W9_MEMBER_UNAVAILABLE = 'W9_MEMBER_UNAVAILABLE';
export const W9_SCOPE_EXCLUDED = 'W9_SCOPE_EXCLUDED';
export const W9_IDENTITY_UNAVAILABLE = 'W9_IDENTITY_UNAVAILABLE';
export const W9_LOAD_FAILED = 'W9_LOAD_FAILED';

/** The route this service answers, as the EMR route classification and an access event's surface name it. */
export const VIEWING_SET_SURFACE = 'POST studies/viewing-set/resolve';
// deadlineMs: the one resolve deadline (spec §3). servedReadCutMs: the served reads stop there, keeping a fixed
// 1000 ms reserve of the same 10 s for the durable receipt (9000/1000 split, D1558).
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
   * A1 selects the metadata body only after every target receipt is durable.
   * The transport signal cancels source reads and the same preparation deadline.
   */
  async resolve(raw: unknown, c: Caller, transport: AbortSignal) {
    // A-01: nothing about identity, institution or rights comes from the body; all of it is decided before any read.
    if (c?.kind !== 'member') throw viewForbidden();
    try { need(c.roles, 'radiologist', '여러 검사 열기'); } catch { throw viewForbidden(); }
    const me = inst(c);
    const input = selection(raw);

    // A-03: one deadline per resolve, and its one signal, from here to the answer. Every wait is raced against it - the
    // policy and member reads, the StudyAccess decision (whose own source read takes the signal and is cancelled with its
    // body), the served reads (same, and cut earlier at servedReadCutMs), the durable receipt. The
    // deadline answers at once wherever it lands: a member without its own cause is W9_LOAD_FAILED and nothing is
    // provided (in the receipt wait: 503, and a late receipt is finished as aborted).
    const deadline = new AbortController();
    const signal = deadline.signal;
    const timer = setTimeout(() => deadline.abort(), VIEWING_SET_LIMITS.deadlineMs);
    const end = () => { clearTimeout(timer); deadline.abort(); transport.removeEventListener('abort', end); };
    transport.addEventListener('abort', end, { once: true });
    if (transport.aborted) end();
    let selected = false;
    // D1558: the served reads run under a child of the one deadline that is cut at servedReadCutMs (9000 of 10000 ms).
    // The fixed 1000 ms reserve is for the durable receipt of the members read in time.
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
      try {
        // A-02: one read of the members' rows (no transaction, no lazy registration), then each member on its own.
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
      // receipt; a read still pending at the sub-cut is W9_LOAD_FAILED and its fetch and body are cancelled.
      await this.readSources(admitted, servedCut.signal);
      for (const m of admitted) {
        if (!Array.isArray(m.rows)) m.code = W9_LOAD_FAILED;
        else if (!m.rows.length) m.code = W9_MEMBER_UNAVAILABLE;
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

      // Nothing is provided when no member is ready: the answer carries the selected UIDs and their codes only.
      if (!ready.length) return answer(null);

      // A-06: every provided member's receipt before the body; any failure answers 503 with no member body.
      const anchor = members[0];
      const context = (m: Member): WorkContext => anchor.code
        ? { basis: 'worklist', studyId: m.uid, relatedStudyId: null, reason: null }
        : m === anchor ? { basis: 'worklist', studyId: anchor.uid, relatedStudyId: null, reason: null }
          : { basis: 'same-patient-comparison', studyId: anchor.uid, relatedStudyId: m.uid, reason: null };
      const targets = ready.map(m => ({ uid: m.uid, ordinal: m.ordinal,
        managingInstitutionId: m.state!.institutionId!, patientId: m.patientId!,
        metadata: m.metadata!, context: context(m) }));
      const response = this.access.select(targets, answer, signal);
      selected = true;
      return response;
    } finally {
      // A1 still needs the same deadline while awaiting durable receipts and
      // selecting this response. The controller ends it on finish/close; late
      // receipts drain in A1's original request work.
      if (!selected) end();
      servedCut.abort();
      signal.removeEventListener('abort', relay);
      clearTimeout(cutTimer);
    }
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
