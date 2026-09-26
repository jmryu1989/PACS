import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { CLINICIAN_ROLE } from './clinician-policy';
import type { Caller } from './pacs.service';

/**
 * S5-U4a 임상의 질문 스레드(계약 S5-U4p §3-§13, 지휘자 결정 D33).
 *
 * consultation(판독의→판독의 1:1 의뢰)을 넓히지 않고 따로 둔다 — member()를 임상의로 넓히면 판독의 전용
 * 의뢰 경로 전체가 임상의에게 열린다. 수신자는 소유 기관 영상의학과 풀이고 원격판독 기관은 참여하지 않는다(OQ-1).
 * 역할은 동작마다 명시한 집합으로 판정하고 need()를 쓰지 않는다: need()의 admin 예외가 있으면 판독의가 아닌
 * 관리자가 임상 답변을 쓰게 된다(OQ-3). 이 서비스는 Orthanc·Connect를 주입받지 않는다. 원본 태그 읽기는
 * StudyAccessService.prepare()가 권한 판정을 위해 트랜잭션·잠금 전에 할 뿐이다(§4.1).
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

@Injectable()
export class ClinicianQuestionService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService) {}

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

  private async run<T>(c: Caller, fn: (tx: any) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.studyAccess.snapshot(c, tx);
        return fn(tx);
      }, { maxWait: 4000, timeout: 8000 });
    } catch (e: any) {
      // 영수증 PK가 부딪히는 경우는 같은 requestId가 다른 부모에서 동시에 쓰인 때뿐이다(같은 부모는 행 잠금이 줄 세운다).
      if (e?.code === 'P2002') throw reused();
      if (['P2024', 'P2028', 'P2034'].includes(e?.code) || e?.code === 'P2010' && ['55P03', '57014', '40P01'].includes(e?.meta?.code))
        throw busy();
      throw e;
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

  /**
   * 적용된 requestId의 재전송은 그 영수증에 저장한 결과를 그대로 돌려준다. 가시성 판정 뒤, revision·상태 판정 앞이라
   * 접근을 잃으면 재전송도 거절되고, 뒤이은 전이·종결 뒤에도 같은 답이다. 내용·경로·부모·사용자가 다르면 409.
   */
  private replay(receipt: any, mark: string, questionId: string, c: Caller) {
    if (receipt.fingerprint !== mark || receipt.questionId !== questionId || !object(receipt.result)) throw reused();
    return { owner: this.owner(c), applied: receipt.result, replayed: true };
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

  private async apply(tx: any, c: QuestionCaller, row: any, rs: any, requestId: string, mark: string, step: Step) {
    const at = new Date(), seq = row.entryCount + 1, next = row.revision + 1, name = this.name(c);
    const anchor = await this.anchor(tx, row.studyUid, rs);
    const applied = { id: row.id, studyUid: row.studyUid, requestId, action: step.action,
      entry: { id: requestId, seq, kind: step.kind }, from: row.state, to: step.to, revision: next, at: at.toISOString() };
    const closing = step.to === 'Closed' ? { closedAt: at, closedByActor: c.actor, closedByName: name, closedByRole: step.role } : {};
    await tx.studyQuestion.update({ where: { id: row.id },
      data: { state: step.to, revision: next, entryCount: seq, changedBy: c.actor, updatedAt: at, ...closing } });
    await this.receipt(tx, c, applied, mark, step.body, step.role, anchor, at, name);
    return { owner: this.owner(c), applied, replayed: false };
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
  async list(c: QuestionCaller, q: any) {
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
    const before = cursor?.at ?? '9999-12-31T00:00:00.000Z', beforeId = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rows: any[] = await this.prisma.$queryRaw`SELECT q.*,
        (SELECT max(e.at) FROM "StudyQuestionEntry" e WHERE e."questionId"=q.id) AS "lastEntryAt"
      FROM "StudyQuestion" q JOIN "StudyState" s ON s.uid=q."studyUid" AND s."institutionId"=q."institutionId"
      WHERE q."institutionId"=${c.institution} AND (NOT ${restricted} OR q."studyUid"=ANY(${scope}::text[]))
        AND (NOT ${mine} OR q."authorSub"=${c.sub}) AND (${stateValue}::text='all' OR q.state::text=${stateValue}::text)
        AND (q."createdAt",q.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
      ORDER BY q."createdAt" DESC,q.id DESC LIMIT 51`;
    const items = rows.slice(0, QUESTION_PAGE), last = items[items.length - 1];
    return { owner: this.owner(c), items: items.map(row => this.summary(row, row.lastEntryAt)),
      nextCursor: rows.length > QUESTION_PAGE
        ? Buffer.from(JSON.stringify({ at: iso(last.createdAt), id: last.id, r: accessPolicy.revision })).toString('base64url') : null };
  }

  /** #2 스레드 전체. */
  async read(id: string, c: QuestionCaller) {
    this.member(c);
    const scope = this.scope(c);
    if (!uuid(id)) throw questionMissing();
    await this.studyAccess.prepare(c);
    return this.run(c, async tx => {
      const { row, rs } = await this.question(tx, id.toLowerCase(), c, scope, false);
      const entries: any[] = await tx.studyQuestionEntry.findMany({ where: { questionId: row.id }, orderBy: { seq: 'asc' } });
      return { owner: this.owner(c), item: this.thread(row, entries, await this.anchor(tx, row.studyUid, rs)) };
    });
  }

  /** #3 한 검사의 스레드 요약(최신 50개). 임상의는 자기 질문만. */
  async forStudy(uid: string, c: QuestionCaller) {
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
      return { owner: this.owner(c), items: rows.map(row => this.summary(row, row.lastEntryAt)) };
    });
  }

  /** #4 질문 등록. 작성자·기관·역할 표지는 토큰에서만 오고 body에는 정확히 세 키만 받는다. */
  async create(uid: string, c: QuestionCaller, b: any) {
    this.member(c);
    if (!holds(c, CLINICIAN_ROLE)) throw roleRequired();
    if (!studyUid(uid)) throw invalid('검사 UID를 확인하세요');
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'body']) || !uuid(b.requestId) || !text(b.body))
      throw invalid('요청 ID와 1~2,000자의 질문을 입력하세요');
    this.expectOwner(c, b);
    const requestId = b.requestId.toLowerCase();
    const mark = fingerprint({ uid, institution: c.institution, subject: c.sub, body: b.body });
    await this.studyAccess.prepare(c, [uid]);
    return this.run(c, async tx => {
      const state = await this.study(tx, uid, c, true, studyMissing);
      const receipt = await tx.studyQuestionEntry.findUnique({ where: { id: requestId } });
      if (receipt) return this.replay(receipt, mark, requestId, c);
      const at = new Date(), name = this.name(c), anchor = await this.anchor(tx, uid, state.rs);
      const applied = { id: requestId, studyUid: uid, requestId, action: 'create', entry: { id: requestId, seq: 1, kind: 'question' },
        from: null, to: 'Open', revision: 1, at: at.toISOString() };
      await tx.studyQuestion.create({ data: { id: requestId, studyUid: uid, institutionId: c.institution, authorSub: c.sub,
        authorActor: c.actor, authorName: name, state: 'Open', revision: 1, entryCount: 1, changedBy: c.actor,
        createdAt: at, updatedAt: at } });
      await this.receipt(tx, c, applied, mark, b.body, 'clinician', anchor, at, name);
      return { owner: this.owner(c), applied, replayed: false };
    });
  }

  /** #5 답변 또는 추가 질문. 종류는 서버가 정한다: 작성자면 followup(clinician), 아니면 answer(radiologist). */
  async reply(id: string, c: QuestionCaller, b: any) {
    this.member(c);
    if (!holds(c, CLINICIAN_ROLE) && !holds(c, RADIOLOGIST)) throw roleRequired();
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'revision', 'body']) || !uuid(b.requestId) || !revision(b.revision) || !text(b.body))
      throw invalid('요청 ID·기준 revision과 1~2,000자의 내용을 입력하세요');
    this.expectOwner(c, b);
    if (!uuid(id)) throw questionMissing();
    const questionId = id.toLowerCase(), requestId = b.requestId.toLowerCase(), scope = this.scope(c);
    const mark = fingerprint({ id: questionId, institution: c.institution, subject: c.sub, revision: b.revision, action: 'reply', body: b.body });
    await this.studyAccess.prepare(c);
    return this.run(c, async tx => {
      const { row, rs } = await this.question(tx, questionId, c, scope, true);
      const receipt = await tx.studyQuestionEntry.findUnique({ where: { id: requestId } });
      if (receipt) return this.replay(receipt, mark, questionId, c);
      if (row.revision !== b.revision) throw changed();
      if (row.state === 'Closed') throw closedError();
      if (!['Open', 'Answered'].includes(row.state)) throw stateError();
      const author = row.authorSub === c.sub;
      if (author ? !holds(c, CLINICIAN_ROLE) : !holds(c, RADIOLOGIST)) throw actionForbidden();
      // 마지막 한 칸은 닫기 몫이다. 답변·추가 질문이 100칸을 모두 채우면 그 스레드는 닫을 수 없게 된다.
      if (row.entryCount >= QUESTION_ENTRY_LIMIT - 1) throw entryLimit();
      return this.apply(tx, c, row, rs, requestId, mark, author
        ? { action: 'followup', kind: 'followup', to: 'Open', role: 'clinician', body: b.body }
        : { action: 'answer', kind: 'answer', to: 'Answered', role: RADIOLOGIST, body: b.body });
    });
  }

  /** #6 닫기. 작성자(clinician)는 사유를 비울 수 있고, 판독의·관리자가 남의 질문을 닫을 때는 사유가 필요하다. */
  async close(id: string, c: QuestionCaller, b: any) {
    this.member(c);
    if (!holds(c, CLINICIAN_ROLE) && !holds(c, RADIOLOGIST) && !holds(c, ADMIN)) throw roleRequired();
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'revision', 'note']) || !uuid(b.requestId) || !revision(b.revision)
      || b.note !== '' && !text(b.note)) throw invalid('요청 ID·기준 revision과 2,000자 이하의 사유를 확인하세요');
    this.expectOwner(c, b);
    if (!uuid(id)) throw questionMissing();
    const questionId = id.toLowerCase(), requestId = b.requestId.toLowerCase(), scope = this.scope(c);
    const mark = fingerprint({ id: questionId, institution: c.institution, subject: c.sub, revision: b.revision, action: 'close', note: b.note });
    await this.studyAccess.prepare(c);
    return this.run(c, async tx => {
      const { row, rs } = await this.question(tx, questionId, c, scope, true);
      const receipt = await tx.studyQuestionEntry.findUnique({ where: { id: requestId } });
      if (receipt) return this.replay(receipt, mark, questionId, c);
      if (row.revision !== b.revision) throw changed();
      if (row.state === 'Closed') throw closedError();
      if (!['Open', 'Answered'].includes(row.state)) throw stateError();
      const author = row.authorSub === c.sub;
      let role: string;
      if (author && holds(c, CLINICIAN_ROLE)) role = 'clinician';
      else if (!author && (holds(c, RADIOLOGIST) || holds(c, ADMIN))) {
        if (b.note === '') throw invalid('작성자가 아닌 사람이 질문을 닫을 때는 사유를 입력하세요');
        role = holds(c, RADIOLOGIST) ? RADIOLOGIST : ADMIN;
      } else throw actionForbidden();
      if (row.entryCount >= QUESTION_ENTRY_LIMIT) throw entryLimit();
      return this.apply(tx, c, row, rs, requestId, mark, { action: 'close', kind: 'close', to: 'Closed', role, body: b.note });
    });
  }
}
