import { businessResponse, writeAcknowledgement } from './emr-clinical/response';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { CLINICIAN_ROLE } from './clinician-policy';
import type { Caller } from './pacs.service';
import type { ClinicalBody, ClinicalWritePlan } from './emr-clinical/records';
import { ClinicalWriteResult, clinicalHttpError, clinicalRefusal, clinicalText, outcomeCode, projectedCaller, readClinicalRows, registerClinicalProjection,
  requireClinicalRuntime } from './emr-clinical/services';

/**
 * S5-U4a 임상의 질문 스레드(계약 S5-U4p §3-§13, 지휘자 결정 D33).
 *
 * consultation(판독의→판독의 1:1 의뢰)을 넓히지 않고 따로 둔다 — member()를 임상의로 넓히면 판독의 전용
 * 의뢰 경로 전체가 임상의에게 열린다. 수신자는 소유 기관 영상의학과 풀이고 원격판독 기관은 참여하지 않는다(OQ-1).
 * 역할은 동작마다 명시한 집합으로 판정하고 need()를 쓰지 않는다: need()의 admin 예외가 있으면 판독의가 아닌
 * 관리자가 임상 답변을 쓰게 된다(OQ-3). 이 서비스는 Orthanc·Connect를 주입받지 않는다. 원본 태그 읽기는
 * StudyAccessService.prepare()가 권한 판정을 위해 트랜잭션·잠금 전에 할 뿐이다(§4.1).
 *
 * EMR-D 2라운드: 질문·추가 질문·답변·닫기는 각각 emr_clinical의 추가 전용 판 하나다(api/src/emr-clinical). 임상
 * 기재(작성자 본인의 질문·답변)는 작성자 단말의 서명이 C 검증을 통과해야만 판·원장 사건·기존 행이 한 트랜잭션으로
 * 커밋된다. 서명·원장·저장이 실패하면 성공 응답도 행 변경도 없고 같은 요청 ID는 그 결과만 다시 받는다. 기존 행
 * (StudyQuestion·StudyQuestionEntry·AuditLog)은 판의 투영이며 커밋 트랜잭션 안의 project()만 바꾼다. 본문을 싣는
 * 스레드 읽기(#2)는 그 판들에 대한 열람 사건이 원장에 내구 기록된 뒤에만 응답한다. 목록·요약에는 본문이 없다.
 */
export const QUESTION_AUDIT_ACTION = 'study.question';
export const QUESTION_BODY_MAX = 2000;
export const QUESTION_ENTRY_LIMIT = 100;
export const QUESTION_PAGE = 50;
const RADIOLOGIST = 'radiologist';
const ADMIN = 'admin';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STUDY_UID = /^\d+(?:\.\d+)+$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
// 줄바꿈과 탭만 받는다. 그 밖의 C0·C1 제어문자는 화면·로그에서 보이지 않는 글자가 된다.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

export type QuestionCaller = Caller & { name?: string };
type Scope = 'all' | 'own';
type Step = { action: string; kind: string; to: string; role: string; body: string };
/** What the commit transaction needs besides the plan; kept with the original for recovery (no secret, no token). */
type QuestionProjection = { caller: QuestionCaller; mark: string };

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: any, keys: string[]) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value: any) => typeof value === 'string' && value.trim().length > 0 && value.length <= QUESTION_BODY_MAX && !CONTROL.test(value);
const uuid = (value: any) => typeof value === 'string' && UUID.test(value);
const studyUid = (value: any) => typeof value === 'string' && value.length <= 64 && STUDY_UID.test(value);
const revision = (value: any) => Number.isInteger(value) && value >= 1 && value < 2147483647;
// 역할은 부여 쪽으로만 읽는다: 혼합 역할 사용자는 가진 역할마다 그 동작을 받고 어느 역할로도 좁혀지지 않는다.
const holds = (c: Caller, role: string) => Array.isArray(c.roles) && c.roles.includes(role);
const iso = (value: any) => value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** A legacy thread entry against the signed version it projects: position, kind, author, time and text (DR2-02). */
function sameEntry(e: any, b: ClinicalBody): boolean {
  const kind = b.sequence === 1 ? 'question' : b.state.to === 'Closed' ? 'close' : b.kind === 'clinical-answer' ? 'answer' : 'followup';
  return e.seq === b.sequence && e.kind === kind && e.authorSub === b.author.subject && iso(e.at) === b.at && e.body === (b.text ?? '');
}

const error = (code: string, message: string) => ({ code, message });
const invalid = (message = '질문 요청의 형식을 확인하세요') => new BadRequestException(error('QUESTION_INPUT_INVALID', message));
const roleRequired = () => new ForbiddenException(error('QUESTION_ROLE_REQUIRED', '이 질문 동작에 필요한 역할이 없습니다'));
const actionForbidden = () => new ForbiddenException(error('QUESTION_ACTION_FORBIDDEN', '이 질문에 이 동작을 할 수 없습니다'));
const studyMissing = () => new NotFoundException(error('STUDY_NOT_FOUND', '검사를 찾을 수 없습니다'));
const questionMissing = () => new NotFoundException(error('QUESTION_NOT_FOUND', '질문을 찾을 수 없습니다'));
const ownerChanged = () => new ConflictException(error('OWNER_CHANGED', '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요'));
const reused = () => new ConflictException(error('REQUEST_ID_REUSED', '다른 내용에 이미 쓰인 요청 ID입니다. 질문을 다시 불러오세요'));
const changed = () => new ConflictException(error('QUESTION_CHANGED', '질문이 변경되었습니다. 다시 불러온 뒤 확인하세요'));
const closedError = () => new ConflictException(error('QUESTION_CLOSED', '닫힌 질문에는 더 쓸 수 없습니다'));
const stateError = () => new ConflictException(error('QUESTION_STATE', '지금 상태에서 할 수 없는 질문 동작입니다'));
const entryLimit = () => new ConflictException(error('QUESTION_ENTRY_LIMIT', '질문 스레드의 항목 수 상한에 도달했습니다'));
const busy = () => new ServiceUnavailableException(error('QUESTION_BUSY', '질문 처리 중입니다. 같은 요청으로 다시 시도하세요'));
const closeReason = () => invalid('작성자가 아닌 사람이 질문을 닫을 때는 사유를 입력하세요');

/** The service's own wording for each refusal of the clinical commit (D codes and its own projection codes). */
const OWN: Readonly<Record<string, () => HttpException>> = Object.freeze({
  StaleRevision: changed, QUESTION_CHANGED: changed, ProjectionConflict: changed, QUESTION_ENTRY_LIMIT: entryLimit, QUESTION_CLOSED: closedError,
  QUESTION_STATE: stateError, STUDY_NOT_FOUND: studyMissing, QUESTION_NOT_FOUND: questionMissing, ProjectionNotFound: questionMissing,
  NotFound: questionMissing, ActorPathRefused: actionForbidden, QUESTION_ACTION_FORBIDDEN: actionForbidden, OwnerChanged: ownerChanged,
  RequestIdReused: reused, QUESTION_INPUT_INVALID: () => invalid(), QUESTION_BUSY: busy, ProjectionMismatch: changed,
});

@Injectable()
export class ClinicianQuestionService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService) {
    registerClinicalProjection('question', (tx, plan, projection, caller) => this.project(tx, plan, projection as QuestionProjection, caller), { db: prisma, access: studyAccess });
  }

  private member(c: QuestionCaller) {
    if (c.kind !== 'member' || ![c.institution, c.sub, c.actor].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256))
      throw roleRequired();
  }

  /** 표시 이름은 토큰에서만 온다. 256자는 코드 포인트로 자른다 — UTF-16 단위로 자르면 짝 없는 대리 문자가 남는다. */
  private name(c: QuestionCaller) {
    const raw = typeof c.name === 'string' && c.name.trim() ? c.name : c.actor;
    return Array.from(raw).slice(0, 256).join('');
  }

  private owner(c: Caller) { return [c.institution, c.sub]; }

  private expectOwner(c: Caller, b: any) {
    if (JSON.stringify(b.expectedOwner) !== JSON.stringify(this.owner(c))) throw ownerChanged();
  }

  /** 스레드를 읽는 범위: 판독의·관리자는 기관 풀 전체, 임상의는 자기 질문만(OQ-2), 그 밖(방사선사 등)은 403(OQ-4). */
  private scope(c: Caller): Scope {
    if (holds(c, RADIOLOGIST) || holds(c, ADMIN)) return 'all';
    if (holds(c, CLINICIAN_ROLE)) return 'own';
    throw roleRequired();
  }

  /**
   * 쓰기는 기본 격리(ReadCommitted)에서 검사·질문 행을 잠근 뒤 커밋된 최신 행을 본다. 읽기(#2·#3)는 RepeatableRead 한
   * 스냅샷에서 질문 행·검사 상태·항목·현재 판 번호를 모두 읽는다 — 문장마다 새 스냅샷이면 그 사이에 커밋된 답변·닫기·판독
   * 취소가 섞여 revision·항목·closed·current가 실제로 없었던 조합이 된다(S5-U4a-F01). 읽기는 행 잠금을 잡지 않는다.
   * 스냅샷은 접근 정책 공유 잠금을 기다리기 전에 정해지므로 그 사이의 정책 변경은 StudyAccessInterceptor가 응답 전에 거절한다.
   */
  private async run<T>(c: Caller, fn: (tx: any) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.studyAccess.snapshot(c, tx);
        return fn(tx);
      }, read ? { isolationLevel: 'RepeatableRead', maxWait: 4000, timeout: 8000 } : { maxWait: 4000, timeout: 8000 });
    } catch (e: any) {
      // 영수증 PK가 부딪히는 경우는 같은 requestId가 다른 부모에서 동시에 쓰인 때뿐이다(같은 부모는 행 잠금이 줄 세운다).
      if (e?.code === 'P2002') throw reused();
      if (['P2024', 'P2028', 'P2034'].includes(e?.code) || e?.code === 'P2010' && ['55P03', '57014', '40P01'].includes(e?.meta?.code))
        throw busy();
      throw clinicalRefusal(e, OWN);
    }
  }

  /**
   * T-1/T-3: 검사는 **지금** caller 기관 소유여야 한다(원격판독 수신 기관은 아니다, OQ-1). StudyAccess는 트랜잭션 전에
   * 준비한 원본 태그만으로 판정한다. 없음·기관 불일치·접근 거절을 구별하지 않고 같은 404를 준다.
   */
  private async study(tx: any, uid: string, c: Caller, lock: boolean, missing: () => NotFoundException) {
    const rows: any[] = lock
      ? await tx.$queryRaw`SELECT uid,"institutionId",rs FROM "StudyState" WHERE uid=${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT uid,"institutionId",rs FROM "StudyState" WHERE uid=${uid}`;
    if (!rows[0] || rows[0].institutionId !== c.institution) throw missing();
    try { await this.studyAccess.require(c, [uid], tx); }
    catch (e) { if (e instanceof NotFoundException) throw missing(); throw e; }
    return rows[0];
  }

  /**
   * id로 들어오는 경로의 가시성. 행 기관 = caller 기관 = 그 검사의 현재 소유 기관이고 StudyAccess가 허용할 때만,
   * 임상의 범위면 자기 질문일 때만 보인다. 검사가 옮겨 가거나 접근을 잃으면 행은 그대로 두고 404로 숨긴다.
   */
  private async question(tx: any, id: string, c: Caller, scope: Scope, lock: boolean) {
    const found: any[] = await tx.$queryRaw`SELECT * FROM "StudyQuestion" WHERE id=${id}::uuid`;
    const first = found[0];
    if (!first || first.institutionId !== c.institution) throw questionMissing();
    // 검사 행 잠금이 질문 행 잠금보다 먼저다 — 질문 생성·검사 삭제가 같은 순서로 잡는다.
    const state = await this.study(tx, first.studyUid, c, lock, questionMissing);
    const rows: any[] = lock ? await tx.$queryRaw`SELECT * FROM "StudyQuestion" WHERE id=${id}::uuid FOR UPDATE` : found;
    const row = rows[0];
    if (!row || row.institutionId !== c.institution || row.studyUid !== first.studyUid || scope === 'own' && row.authorSub !== c.sub)
      throw questionMissing();
    return { row, rs: state.rs };
  }

  /** 판독 상태 표지: StudyState.rs와 마지막 비폐기 ReportVersion 판 번호. 판독문 본문은 싣지 않는다(§3.2). */
  private async anchor(tx: any, uid: string, rs: any) {
    const rows: any[] = await tx.$queryRaw`SELECT max(version) AS version FROM "ReportVersion" WHERE uid=${uid} AND action <> 'discarded'`;
    const version = rows[0]?.version;
    return { rs: typeof rs === 'string' ? rs : 'W', version: Number.isSafeInteger(version) && version > 0 ? version : null };
  }

  /** 영수증 한 행과 감사 한 행을 같은 트랜잭션에 쓴다. 감사에는 본문·사유·환자 식별자가 없다(§11). */
  private async receipt(tx: any, c: Caller, applied: any, mark: string, body: string, role: string, anchor: any, at: Date, name: string) {
    await tx.studyQuestionEntry.create({ data: { id: applied.requestId, questionId: applied.id, seq: applied.entry.seq,
      kind: applied.entry.kind, body, authorSub: c.sub, authorActor: c.actor, authorName: name, authorRole: role,
      reportRs: anchor.rs, reportVersion: anchor.version, fingerprint: mark, appliedRevision: applied.revision,
      result: applied as any, at } });
    await tx.auditLog.create({ data: { actor: c.actor, action: QUESTION_AUDIT_ACTION, target: applied.studyUid,
      detail: JSON.stringify({ id: applied.id, institution: c.institution, entry: applied.requestId, kind: applied.entry.kind,
        from: applied.from, to: applied.to, revision: applied.revision, requestId: applied.requestId, role }) } });
  }

  private async apply(tx: any, c: QuestionCaller, row: any, rs: any, requestId: string, mark: string, step: Step, at: Date) {
    const seq = row.entryCount + 1, next = row.revision + 1, name = this.name(c);
    const anchor = await this.anchor(tx, row.studyUid, rs);
    const applied = { id: row.id, studyUid: row.studyUid, requestId, action: step.action,
      entry: { id: requestId, seq, kind: step.kind }, from: row.state, to: step.to, revision: next, at: at.toISOString() };
    const closing = step.to === 'Closed' ? { closedAt: at, closedByActor: c.actor, closedByName: name, closedByRole: step.role } : {};
    await tx.studyQuestion.update({ where: { id: row.id },
      data: { state: step.to, revision: next, entryCount: seq, changedBy: c.actor, updatedAt: at, ...closing } });
    await this.receipt(tx, c, applied, mark, step.body, step.role, anchor, at, name);
  }

  /**
   * The legacy rows of one committed question version, inside the clinical commit transaction (registered projector).
   * Visibility, the row's revision and state and the entry bounds are checked again under the row locks; the legacy row
   * must be exactly the fold before this version, otherwise the whole commit rolls back.
   */
  private async project(tx: any, plan: Readonly<ClinicalWritePlan>, p: QuestionProjection, trusted?: Caller) {
    const c: QuestionCaller = projectedCaller(p.caller, trusted), v = plan.version, at = new Date(v.at), body = v.text ?? '';
    const studyId = clinicalText(v.studyId), recordId = clinicalText(v.recordId), requestId = clinicalText(plan.requestId), mark = clinicalText(p.mark);
    await this.studyAccess.snapshot(c, tx);
    if (plan.surface === 'question.create') {
      const state = await this.study(tx, studyId, c, true, studyMissing);
      const name = this.name(c), anchor = await this.anchor(tx, studyId, state.rs);
      const applied = { id: recordId, studyUid: studyId, requestId, action: 'create',
        entry: { id: requestId, seq: 1, kind: 'question' }, from: null, to: 'Open', revision: 1, at: v.at };
      await tx.studyQuestion.create({ data: { id: recordId, studyUid: studyId, institutionId: c.institution, authorSub: c.sub,
        authorActor: c.actor, authorName: name, state: 'Open', revision: 1, entryCount: 1, changedBy: c.actor, createdAt: at, updatedAt: at } });
      await this.receipt(tx, c, applied, mark, body, 'clinician', anchor, at, name);
      return;
    }
    const { row, rs } = await this.question(tx, recordId, c, this.scope(c), true);
    if (row.revision !== v.sequence - 1 || row.state !== v.state.from) throw changed();
    if (plan.surface === 'question.reply') {
      // 마지막 한 칸은 닫기 몫이다. 답변·추가 질문이 100칸을 모두 채우면 그 스레드는 닫을 수 없게 된다.
      if (row.entryCount >= QUESTION_ENTRY_LIMIT - 1) throw entryLimit();
      const answer = v.kind === 'clinical-answer';
      return this.apply(tx, c, row, rs, requestId, mark, answer
        ? { action: 'answer', kind: 'answer', to: 'Answered', role: RADIOLOGIST, body }
        : { action: 'followup', kind: 'followup', to: 'Open', role: 'clinician', body }, at);
    }
    if (row.entryCount >= QUESTION_ENTRY_LIMIT) throw entryLimit();
    const role = v.capacity === 'operational-staff' ? ADMIN : v.kind === 'clinical-answer' ? RADIOLOGIST : 'clinician';
    return this.apply(tx, c, row, rs, requestId, mark, { action: 'close', kind: 'close', to: 'Closed', role, body }, at);
  }

  /** The stored receipt of a committed or replayed write; a failure carries this service's wording and no text. */
  private async answer(result: ClinicalWriteResult, requestId: string, c: Caller, request: unknown, route: any) {
    const o = result.outcome, code = outcomeCode(o);
    if (code !== null) {
      if (code === 'StateTransitionRefused') throw result.unit?.state === 'Closed' ? closedError() : stateError();
      if (code === 'TextRequired') throw closeReason();
      throw clinicalHttpError(code, OWN);
    }
    const entry = await this.prisma.studyQuestionEntry.findUnique({ where: { id: requestId } });
    if (!entry || !object(entry.result)) throw busy();
    return writeAcknowledgement(request, c, route, (o as any).receipt, result.unit, o.status === 'replayed', entry.result);
  }

  private async write(request: unknown, c: QuestionCaller, surface: 'question.create' | 'question.reply' | 'question.close',
    studyId: string, recordId: string, b: any, mark: string) {
    const runtime = requireClinicalRuntime();
    let result: ClinicalWriteResult;
    try {
      result = await runtime.write(request, { surface, studyId, recordId, body: b, caller: { subject: c.sub, institutionId: c.institution },
        projection: { caller: { kind: c.kind, institution: c.institution, sub: c.sub, actor: c.actor, roles: [...c.roles], name: c.name }, mark } });
    } catch (e) { throw clinicalRefusal(e, OWN); }
    return this.answer(result, b.requestId.toLowerCase(), c, request, surface === 'question.create' ? 'POST studies/:uid/questions' : surface === 'question.reply' ? 'POST questions/:id/entries' : 'POST questions/:id/close');
  }

  private summary(row: any, lastEntryAt: any) {
    return { id: row.id, studyUid: row.studyUid, state: row.state, revision: row.revision,
      author: { actor: row.authorActor, name: row.authorName }, entryCount: row.entryCount,
      lastEntryAt: iso(lastEntryAt ?? row.updatedAt), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  }

  private thread(row: any, entries: any[], current: any) {
    return { ...this.summary(row, entries.length ? entries[entries.length - 1].at : null),
      closed: row.state === 'Closed'
        ? { at: iso(row.closedAt), by: { actor: row.closedByActor, name: row.closedByName, role: row.closedByRole } } : null,
      entries: entries.map(e => ({ id: e.id, seq: e.seq, kind: e.kind, body: e.body,
        author: { actor: e.authorActor, name: e.authorName, role: e.authorRole }, at: iso(e.at),
        reportAnchor: { rs: e.reportRs, version: e.reportVersion ?? null } })),
      current };
  }

  /** #1 목록. view=mine은 clinician 역할의 자기 질문, view=inbox는 판독의·관리자의 기관 풀. 총개수는 싣지 않는다. */
  async list(c: QuestionCaller, q: any, request?: unknown) {
    this.member(c);
    const query = object(q) ? q : {};
    if (Object.keys(query).some(k => !['view', 'state', 'cursor'].includes(k)) || Object.values(query).some(v => typeof v !== 'string')
      || !['mine', 'inbox'].includes(query.view)) throw invalid('질문 목록 구분(view)을 확인하세요');
    const mine = query.view === 'mine';
    if (mine ? !holds(c, CLINICIAN_ROLE) : !holds(c, RADIOLOGIST) && !holds(c, ADMIN)) throw roleRequired();
    const state = query.state ?? 'all';
    if (!['open', 'answered', 'closed', 'all'].includes(state)) throw invalid('질문 상태 필터를 확인하세요');
    const stateValue = state === 'all' ? 'all' : state[0].toUpperCase() + state.slice(1);
    const accessPolicy = await this.studyAccess.snapshot(c);
    const restricted = accessPolicy.policy.restricted;
    const scope = restricted ? [...await this.studyAccess.allowed(c, (await this.prisma.studyState.findMany({
      where: { institutionId: c.institution }, select: { uid: true } })).map(s => s.uid))] : [];
    let cursor: any = null;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 256 || !CURSOR.test(query.cursor)) throw Error();
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (!object(cursor) || Object.keys(cursor).sort().join() !== 'at,id,r' || cursor.r !== accessPolicy.revision || !uuid(cursor.id)
          || typeof cursor.at !== 'string' || new Date(cursor.at).toISOString() !== cursor.at) throw Error();
      } catch (_) { throw invalid('질문 목록 페이지를 확인하세요'); }
    }
    // 불변인 생성 기관과 **현재** 소유 기관을 함께 JOIN한다 — 옮겨 간 검사의 질문은 어느 쪽 목록에도 나오지 않는다.
    // 항목 요약·lastEntryAt·소유 기관이 한 문장이라 한 스냅샷이다. 여러 문장을 조합하는 #2·#3만 읽기 트랜잭션을 쓴다.
    const before = cursor?.at ?? '9999-12-31T00:00:00.000Z', beforeId = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rows: any[] = await this.prisma.$queryRaw`SELECT q.*,
        (SELECT max(e.at) FROM "StudyQuestionEntry" e WHERE e."questionId"=q.id) AS "lastEntryAt"
      FROM "StudyQuestion" q JOIN "StudyState" s ON s.uid=q."studyUid" AND s."institutionId"=q."institutionId"
      WHERE q."institutionId"=${c.institution} AND (NOT ${restricted} OR q."studyUid"=ANY(${scope}::text[]))
        AND (NOT ${mine} OR q."authorSub"=${c.sub}) AND (${stateValue}::text='all' OR q.state::text=${stateValue}::text)
        AND (q."createdAt",q.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
      ORDER BY q."createdAt" DESC,q.id DESC LIMIT 51`;
    const items = rows.slice(0, QUESTION_PAGE), last = items[items.length - 1];
    return businessResponse(request, 'GET questions', { type: 'questions', owner: this.owner(c), items: items.map(row => this.summary(row, row.lastEntryAt)),
      nextCursor: rows.length > QUESTION_PAGE
        ? Buffer.from(JSON.stringify({ at: iso(last.createdAt), id: last.id, r: accessPolicy.revision })).toString('base64url') : null });
  }

  /**
   * #2 스레드 전체. 본문은 이 판들(질문의 전체 이력)에 대한 열람 사건이 원장에 내구 기록된 뒤에만 나가고, 나가는 본문은
   * 서명된 판의 글이다. 판과 기존 행은 같은 RepeatableRead 스냅샷에서 읽고, 기존 행의 의미(항목 수·순서·종류·작성자·시각·
   * 본문·상태·판 번호, 질문 작성자)가 판과 하나라도 다르면 본문 없이 409다 — 기존 행만 바뀐 손상이나 다른 경로의 쓰기를
   * 서명된 기록처럼 내보내지 않는다(DR2-02).
   */
  async read(id: string, c: QuestionCaller, request?: unknown) {
    this.member(c);
    const runtime = requireClinicalRuntime();
    const scope = this.scope(c);
    if (!uuid(id)) throw questionMissing();
    await this.studyAccess.prepare(c);
    return this.run(c, async tx => {
      const { row, rs } = await this.question(tx, id.toLowerCase(), c, scope, false);
      const entries: any[] = await tx.studyQuestionEntry.findMany({ where: { questionId: row.id }, orderBy: { seq: 'asc' } });
      const anchor = await this.anchor(tx, row.studyUid, rs);
      return runtime.respond(request, { view: 'question', route: 'GET questions/:id', id: row.id, current: anchor },
        { db: this.prisma, tx, caller: c, access: this.studyAccess });
    }, true);
  }

  /** #3 한 검사의 스레드 요약(최신 50개). 임상의는 자기 질문만. */
  async forStudy(uid: string, c: QuestionCaller, request?: unknown) {
    this.member(c);
    const scope = this.scope(c);
    if (!studyUid(uid)) throw invalid('검사 UID를 확인하세요');
    await this.studyAccess.prepare(c, [uid]);
    return this.run(c, async tx => {
      await this.study(tx, uid, c, false, studyMissing);
      const own = scope === 'own';
      const rows: any[] = await tx.$queryRaw`SELECT q.*,
          (SELECT max(e.at) FROM "StudyQuestionEntry" e WHERE e."questionId"=q.id) AS "lastEntryAt"
        FROM "StudyQuestion" q WHERE q."studyUid"=${uid} AND q."institutionId"=${c.institution}
          AND (NOT ${own} OR q."authorSub"=${c.sub})
        ORDER BY q."createdAt" DESC,q.id DESC LIMIT 50`;
      return businessResponse(request, 'GET studies/:uid/questions', { type: 'questions', owner: this.owner(c), items: rows.map(row => this.summary(row, row.lastEntryAt)) });
    }, true);
  }

  /** #4 질문 등록. 작성자·기관·역할 표지는 토큰에서만 오고 body에는 정확히 세 키만 받는다. */
  async create(uid: string, c: QuestionCaller, b: any, request?: unknown) {
    this.member(c);
    requireClinicalRuntime();
    if (!holds(c, CLINICIAN_ROLE)) throw roleRequired();
    if (!studyUid(uid)) throw invalid('검사 UID를 확인하세요');
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'body']) || !uuid(b.requestId) || !text(b.body))
      throw invalid('요청 ID와 1~2,000자의 질문을 입력하세요');
    this.expectOwner(c, b);
    const requestId = b.requestId.toLowerCase();
    const mark = fingerprint({ uid, institution: c.institution, subject: c.sub, body: b.body });
    await this.studyAccess.prepare(c, [uid]);
    // Visibility first, without a lock: an absent, foreign or refused study registers nothing.
    await this.run(c, tx => this.study(tx, uid, c, false, studyMissing), true);
    return this.write(request, c, 'question.create', uid, requestId, b, mark);
  }

  /** #5 답변 또는 추가 질문. 종류는 서버가 정한다: 작성자면 followup(clinician), 아니면 answer(radiologist). */
  async reply(id: string, c: QuestionCaller, b: any, request?: unknown) {
    this.member(c);
    requireClinicalRuntime();
    if (!holds(c, CLINICIAN_ROLE) && !holds(c, RADIOLOGIST)) throw roleRequired();
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'revision', 'body']) || !uuid(b.requestId) || !revision(b.revision) || !text(b.body))
      throw invalid('요청 ID·기준 revision과 1~2,000자의 내용을 입력하세요');
    this.expectOwner(c, b);
    if (!uuid(id)) throw questionMissing();
    const questionId = id.toLowerCase(), scope = this.scope(c);
    const mark = fingerprint({ id: questionId, institution: c.institution, subject: c.sub, revision: b.revision, action: 'reply', body: b.body });
    await this.studyAccess.prepare(c);
    const { row } = await this.run(c, tx => this.question(tx, questionId, c, scope, false), true);
    return this.write(request, c, 'question.reply', row.studyUid, questionId, b, mark);
  }

  /** #6 닫기. 작성자(clinician)는 사유를 비울 수 있고, 판독의·관리자가 남의 질문을 닫을 때는 사유가 필요하다. */
  async close(id: string, c: QuestionCaller, b: any, request?: unknown) {
    this.member(c);
    requireClinicalRuntime();
    if (!holds(c, CLINICIAN_ROLE) && !holds(c, RADIOLOGIST) && !holds(c, ADMIN)) throw roleRequired();
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'revision', 'note']) || !uuid(b.requestId) || !revision(b.revision)
      || b.note !== '' && !text(b.note)) throw invalid('요청 ID·기준 revision과 2,000자 이하의 사유를 확인하세요');
    this.expectOwner(c, b);
    if (!uuid(id)) throw questionMissing();
    const questionId = id.toLowerCase(), scope = this.scope(c);
    const mark = fingerprint({ id: questionId, institution: c.institution, subject: c.sub, revision: b.revision, action: 'close', note: b.note });
    await this.studyAccess.prepare(c);
    const { row } = await this.run(c, tx => this.question(tx, questionId, c, scope, false), true);
    return this.write(request, c, 'question.close', row.studyUid, questionId, b, mark);
  }
}
