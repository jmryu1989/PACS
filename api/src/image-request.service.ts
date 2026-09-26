import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { CLINICIAN_ROLE } from './clinician-policy';
import type { Caller } from './pacs.service';

/**
 * S5-U4c 외부영상(ARCH-143)·영상전송(ARCH-144) 요청의 등록과 처리 상태(계약 S5-U4p §3-§13, 지휘자 결정 D33).
 *
 * 요청은 기록일 뿐 전송이 아니다. 이 서비스는 Connect의 전송·동의 근거·처리 합의 표를 읽거나 쓰지 않고, 영상을
 * 보내거나 받거나 저장하는 원본 서버 호출도 하지 않으며, 원본 서버·Connect 서비스를 주입받지 않는다. 원본 태그
 * 읽기는 StudyAccessService.prepare()가 권한 판정을 위해 트랜잭션·잠금 전에 할 뿐이다(§4.1). Closed는 요청 처리를
 * 마쳤다는 기록이고 영상이 실제로 오갔다는 주장이 아니다. 실제 전송은 직원이 기존 Connect 경로를 따로 쓴다(§10.2).
 * 역할은 동작마다 명시한 집합으로 판정하고 pacs.service의 need 판정(admin 예외)을 쓰지 않는다: 처리(accept·close·decline)는 technician·admin,
 * 판독의는 읽기만, 취소는 요청한 임상의 또는 admin이다(OQ-5 a). 소유 기관만 참여하고 원격판독 기관과 상대 기관은
 * 어떤 역할로도 읽지 못한다(OQ-1 a, T-5).
 */
export const IMAGE_REQUEST_AUDIT_ACTION = 'study.image-request';
export const IMAGE_REQUEST_KINDS: readonly string[] = Object.freeze(['external-image', 'image-transfer']);
export const IMAGE_REQUEST_ACTIONS: readonly string[] = Object.freeze(['accept', 'close', 'decline', 'cancel']);
export const IMAGE_REQUEST_TEXT_MAX = 2000;
export const IMAGE_REQUEST_COUNTERPARTY_MAX = 256;
export const IMAGE_REQUEST_PAGE = 50;
const RADIOLOGIST = 'radiologist';
const TECHNICIAN = 'technician';
const ADMIN = 'admin';
const ACTIVE: readonly string[] = Object.freeze(['Requested', 'Accepted']);
const STATES: readonly string[] = Object.freeze(['Requested', 'Accepted', 'Closed', 'Declined', 'Cancelled']);
const STATE_FILTERS: readonly string[] = Object.freeze(['active', 'closed', 'declined', 'cancelled', 'all']);
// 전이표(state-machine.json image_request R-T2..R-T5). 종결 상태에서 나가는 전이는 없다.
const TRANSITIONS: Readonly<Record<string, { from: readonly string[]; to: string }>> = Object.freeze({
  accept: { from: ['Requested'], to: 'Accepted' },
  close: { from: ['Requested', 'Accepted'], to: 'Closed' },
  decline: { from: ['Requested', 'Accepted'], to: 'Declined' },
  cancel: { from: ['Requested', 'Accepted'], to: 'Cancelled' },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STUDY_UID = /^\d+(?:\.\d+)+$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
// 줄바꿈과 탭만 받는다. 그 밖의 C0·C1 제어문자는 화면·로그에서 보이지 않는 글자가 된다.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

export type RequestCaller = Caller & { name?: string };
type Scope = 'all' | 'own';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: any, keys: string[]) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value: any, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);
// 기관 id는 형식만 여기서 본다. 있는 기관인지는 트랜잭션 안에서 Institution 행으로 확인한다.
const institutionId = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !CONTROL.test(value);
const uuid = (value: any) => typeof value === 'string' && UUID.test(value);
const studyUid = (value: any) => typeof value === 'string' && value.length <= 64 && STUDY_UID.test(value);
const revision = (value: any) => Number.isInteger(value) && value >= 1 && value < 2147483647;
// 역할은 부여 쪽으로만 읽는다: 혼합 역할 사용자는 가진 역할마다 그 동작을 받고 어느 역할로도 좁혀지지 않는다.
const holds = (c: Caller, role: string) => Array.isArray(c.roles) && c.roles.includes(role);
const staff = (c: Caller) => holds(c, TECHNICIAN) || holds(c, ADMIN);
const iso = (value: any) => value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const error = (code: string, message: string) => ({ code, message });
const invalid = (message = '영상 요청의 형식을 확인하세요') => new BadRequestException(error('IMAGE_REQUEST_INPUT_INVALID', message));
const counterpartyInvalid = () => new BadRequestException(error('IMAGE_REQUEST_COUNTERPARTY_INVALID', '상대 기관은 이 기관이 아닌 등록된 기관이어야 합니다'));
const roleRequired = () => new ForbiddenException(error('IMAGE_REQUEST_ROLE_REQUIRED', '이 영상 요청 동작에 필요한 역할이 없습니다'));
const actionForbidden = () => new ForbiddenException(error('IMAGE_REQUEST_ACTION_FORBIDDEN', '이 영상 요청에 이 동작을 할 수 없습니다'));
const studyMissing = () => new NotFoundException(error('STUDY_NOT_FOUND', '검사를 찾을 수 없습니다'));
const requestMissing = () => new NotFoundException(error('IMAGE_REQUEST_NOT_FOUND', '영상 요청을 찾을 수 없습니다'));
const ownerChanged = () => new ConflictException(error('OWNER_CHANGED', '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요'));
const reused = () => new ConflictException(error('REQUEST_ID_REUSED', '다른 내용에 이미 쓰인 요청 ID입니다. 영상 요청을 다시 불러오세요'));
const changed = () => new ConflictException(error('IMAGE_REQUEST_CHANGED', '영상 요청이 변경되었습니다. 다시 불러온 뒤 확인하세요'));
const stateError = () => new ConflictException(error('IMAGE_REQUEST_STATE', '지금 상태에서 할 수 없는 영상 요청 동작입니다'));
const activeExists = () => new ConflictException(error('IMAGE_REQUEST_ACTIVE_EXISTS', '같은 검사·종류로 처리 중인 요청이 이미 있습니다'));
const busy = () => new ServiceUnavailableException(error('IMAGE_REQUEST_BUSY', '영상 요청 처리 중입니다. 같은 요청으로 다시 시도하세요'));

@Injectable()
export class ImageRequestService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService) {}

  private member(c: RequestCaller) {
    if (c.kind !== 'member' || ![c.institution, c.sub, c.actor].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256))
      throw roleRequired();
  }

  /** 표시 이름은 토큰에서만 온다. 256자는 코드 포인트로 자른다 — UTF-16 단위로 자르면 짝 없는 대리 문자가 남는다. */
  private name(c: RequestCaller) {
    const raw = typeof c.name === 'string' && c.name.trim() ? c.name : c.actor;
    return Array.from(raw).slice(0, 256).join('');
  }

  private owner(c: Caller) { return [c.institution, c.sub]; }

  private expectOwner(c: Caller, b: any) {
    if (JSON.stringify(b.expectedOwner) !== JSON.stringify(this.owner(c))) throw ownerChanged();
  }

  /** 요청을 읽는 범위: 판독의·방사선사·관리자는 기관 대기열 전체, 임상의는 자기 요청만(OQ-2), 그 밖은 403. */
  private scope(c: Caller): Scope {
    if (holds(c, RADIOLOGIST) || staff(c)) return 'all';
    if (holds(c, CLINICIAN_ROLE)) return 'own';
    throw roleRequired();
  }

  /**
   * 쓰기는 기본 격리(ReadCommitted)에서 검사·요청 행을 잠근 뒤 커밋된 최신 행을 본다. 읽기(#8·#9)는 RepeatableRead 한
   * 스냅샷에서 요청 행과 검사 소유 기관을 함께 읽는다 — 문장마다 새 스냅샷이면 그 사이에 커밋된 전이·소유 기관 변경이
   * 섞인 조합을 돌려줄 수 있다(S5-U4a-F01과 같은 방식). 읽기는 행 잠금을 잡지 않는다. 스냅샷은 접근 정책 공유 잠금을
   * 기다리기 전에 정해지므로 그 사이의 정책 변경은 StudyAccessInterceptor가 응답 전에 거절한다.
   */
  private async run<T>(c: Caller, fn: (tx: any) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.studyAccess.snapshot(c, tx);
        return fn(tx);
      }, read ? { isolationLevel: 'RepeatableRead', maxWait: 4000, timeout: 8000 } : { maxWait: 4000, timeout: 8000 });
    } catch (e: any) {
      // 활성 요청 확인은 검사 행 잠금 뒤라 부분 unique가 부딪히는 일은 없어야 한다. 부딪히면 같은 뜻의 409로 답한다.
      // 그 밖의 unique 충돌은 같은 requestId가 다른 부모에서 동시에 쓰인 때뿐이다(같은 부모는 행 잠금이 줄 세운다).
      if (e?.code === 'P2002') {
        const target = JSON.stringify(e?.meta?.target ?? '');
        throw target.includes('active') || target.includes('requesterSub') ? activeExists() : reused();
      }
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
      ? await tx.$queryRaw`SELECT uid,"institutionId" FROM "StudyState" WHERE uid=${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT uid,"institutionId" FROM "StudyState" WHERE uid=${uid}`;
    if (!rows[0] || rows[0].institutionId !== c.institution) throw missing();
    try { await this.studyAccess.require(c, [uid], tx); }
    catch (e) { if (e instanceof NotFoundException) throw missing(); throw e; }
    return rows[0];
  }

  /**
   * id로 들어오는 경로의 가시성. 행 기관 = caller 기관 = 그 검사의 현재 소유 기관이고 StudyAccess가 허용할 때만,
   * 임상의 범위면 자기 요청일 때만 보인다. 검사가 옮겨 가거나 접근을 잃으면 행은 그대로 두고 404로 숨긴다.
   * 상대 기관(counterpartyInstitutionId)은 여기에 들어오지 않는다: 그 기관 회원은 행 기관이 달라 404다.
   */
  private async request(tx: any, id: string, c: Caller, scope: Scope, lock: boolean) {
    const found: any[] = await tx.$queryRaw`SELECT * FROM "StudyImageRequest" WHERE id=${id}::uuid`;
    const first = found[0];
    if (!first || first.institutionId !== c.institution) throw requestMissing();
    // 검사 행 잠금이 요청 행 잠금보다 먼저다 — 요청 생성·검사 삭제가 같은 순서로 잡는다.
    await this.study(tx, first.studyUid, c, lock, requestMissing);
    const rows: any[] = lock ? await tx.$queryRaw`SELECT * FROM "StudyImageRequest" WHERE id=${id}::uuid FOR UPDATE` : found;
    const row = rows[0];
    if (!row || row.institutionId !== c.institution || row.studyUid !== first.studyUid || scope === 'own' && row.requesterSub !== c.sub)
      throw requestMissing();
    return row;
  }

  /**
   * 적용된 requestId의 재전송은 그 영수증에 저장한 결과를 그대로 돌려준다. 가시성 판정 뒤, revision·상태·활성 중복 판정
   * 앞이라 접근을 잃으면 재전송도 거절되고, 뒤이은 전이·종결·새 활성 요청 뒤에도 같은 답이다. 내용·경로·부모·사용자가
   * 다르면 409.
   */
  private replay(receipt: any, mark: string, imageRequestId: string, c: Caller) {
    if (receipt.fingerprint !== mark || receipt.imageRequestId !== imageRequestId || receipt.subjectSub !== c.sub || !object(receipt.result))
      throw reused();
    return { owner: this.owner(c), applied: receipt.result, replayed: true };
  }

  /** 영수증 한 행과 감사 한 행을 같은 트랜잭션에 쓴다. 감사에는 사유·note·상대 기관 문장·환자 식별자가 없다(§11). */
  private async receipt(tx: any, c: Caller, applied: any, mark: string, counterpartyInstitutionId: string | null, role: string, at: Date) {
    await tx.studyImageRequestReceipt.create({ data: { requestId: applied.requestId, imageRequestId: applied.id, subjectSub: c.sub,
      action: applied.action, fingerprint: mark, appliedRevision: applied.revision, result: applied as any, at } });
    await tx.auditLog.create({ data: { actor: c.actor, action: IMAGE_REQUEST_AUDIT_ACTION, target: applied.studyUid,
      detail: JSON.stringify({ id: applied.id, institution: c.institution, kind: applied.kind, action: applied.action,
        from: applied.from, to: applied.to, revision: applied.revision, requestId: applied.requestId,
        counterpartyInstitutionId, role }) } });
  }

  private async apply(tx: any, c: RequestCaller, row: any, requestId: string, mark: string, action: string, to: string, role: string, note: string) {
    const at = new Date(), next = row.revision + 1;
    const applied = { id: row.id, studyUid: row.studyUid, requestId, kind: row.kind, action, from: row.state, to, revision: next,
      at: at.toISOString() };
    // 처리자는 처리 상태를 바꾼 직원(technician·admin)이다. 요청한 임상의 자신의 취소는 처리자를 바꾸지 않는다.
    const handler = role === CLINICIAN_ROLE ? {} : { handlerActor: c.actor, handlerName: this.name(c) };
    await tx.studyImageRequest.update({ where: { id: row.id },
      data: { state: to, revision: next, note: action === 'accept' ? null : note, changedBy: c.actor, updatedAt: at, ...handler } });
    await this.receipt(tx, c, applied, mark, row.counterpartyInstitutionId ?? null, role, at);
    return { owner: this.owner(c), applied, replayed: false };
  }

  /** 응답 DTO(§3.3). *Sub·기관 id·영수증 열은 싣지 않고, 키 이름에 전송·수신을 뜻하는 말을 쓰지 않는다. */
  private dto(row: any) {
    return { id: row.id, studyUid: row.studyUid, kind: row.kind, state: row.state, revision: row.revision,
      requester: { actor: row.requesterActor, name: row.requesterName },
      counterparty: { text: row.counterpartyText, institutionId: row.counterpartyInstitutionId ?? null },
      reason: row.reason,
      handler: row.handlerActor == null ? null : { actor: row.handlerActor, name: row.handlerName },
      note: row.note ?? null,
      createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  }

  /** #7 목록. view=mine은 clinician 역할의 자기 요청, view=queue는 판독의·방사선사·관리자의 기관 대기열. 총개수는 싣지 않는다. */
  async list(c: RequestCaller, q: any) {
    this.member(c);
    const query = object(q) ? q : {};
    if (Object.keys(query).some(k => !['view', 'state', 'kind', 'cursor'].includes(k)) || Object.values(query).some(v => typeof v !== 'string')
      || !['mine', 'queue'].includes(query.view)) throw invalid('요청 목록 구분(view)을 확인하세요');
    const mine = query.view === 'mine';
    if (mine ? !holds(c, CLINICIAN_ROLE) : !holds(c, RADIOLOGIST) && !staff(c)) throw roleRequired();
    const state = query.state ?? 'active';
    if (!STATE_FILTERS.includes(state)) throw invalid('요청 상태 필터를 확인하세요');
    if (query.kind !== undefined && !IMAGE_REQUEST_KINDS.includes(query.kind)) throw invalid('요청 종류를 확인하세요');
    const states = state === 'active' ? [...ACTIVE] : state === 'all' ? [...STATES] : [state[0].toUpperCase() + state.slice(1)];
    const kind = query.kind ?? 'all';
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
      } catch (_) { throw invalid('요청 목록 페이지를 확인하세요'); }
    }
    // 불변인 생성 기관과 **현재** 소유 기관을 함께 JOIN한다 — 옮겨 간 검사의 요청은 어느 쪽 목록에도 나오지 않는다.
    // 한 문장이라 한 스냅샷이다. 여러 문장을 조합하는 #8·#9만 읽기 트랜잭션을 쓴다.
    const before = cursor?.at ?? '9999-12-31T00:00:00.000Z', beforeId = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const rows: any[] = await this.prisma.$queryRaw`SELECT r.*
      FROM "StudyImageRequest" r JOIN "StudyState" s ON s.uid=r."studyUid" AND s."institutionId"=r."institutionId"
      WHERE r."institutionId"=${c.institution} AND (NOT ${restricted} OR r."studyUid"=ANY(${scope}::text[]))
        AND (NOT ${mine} OR r."requesterSub"=${c.sub}) AND r.state::text=ANY(${states}::text[])
        AND (${kind}::text='all' OR r.kind::text=${kind}::text)
        AND (r."createdAt",r.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
      ORDER BY r."createdAt" DESC,r.id DESC LIMIT 51`;
    const items = rows.slice(0, IMAGE_REQUEST_PAGE), last = items[items.length - 1];
    return { owner: this.owner(c), items: items.map(row => this.dto(row)),
      nextCursor: rows.length > IMAGE_REQUEST_PAGE
        ? Buffer.from(JSON.stringify({ at: iso(last.createdAt), id: last.id, r: accessPolicy.revision })).toString('base64url') : null };
  }

  /** #8 요청 한 건. */
  async read(id: string, c: RequestCaller) {
    this.member(c);
    const scope = this.scope(c);
    if (!uuid(id)) throw requestMissing();
    await this.studyAccess.prepare(c);
    return this.run(c, async tx => {
      const row = await this.request(tx, id.toLowerCase(), c, scope, false);
      return { owner: this.owner(c), item: this.dto(row) };
    }, true);
  }

  /** #9 한 검사의 요청(최신 50개). 임상의는 자기 요청만. */
  async forStudy(uid: string, c: RequestCaller) {
    this.member(c);
    const scope = this.scope(c);
    if (!studyUid(uid)) throw invalid('검사 UID를 확인하세요');
    await this.studyAccess.prepare(c, [uid]);
    return this.run(c, async tx => {
      await this.study(tx, uid, c, false, studyMissing);
      const own = scope === 'own';
      const rows: any[] = await tx.$queryRaw`SELECT r.* FROM "StudyImageRequest" r
        WHERE r."studyUid"=${uid} AND r."institutionId"=${c.institution} AND (NOT ${own} OR r."requesterSub"=${c.sub})
        ORDER BY r."createdAt" DESC,r.id DESC LIMIT 50`;
      return { owner: this.owner(c), items: rows.map(row => this.dto(row)) };
    }, true);
  }

  /**
   * #10 요청 등록. 요청자·기관·역할 표지는 토큰에서만 오고 body에는 정확히 여섯 키만 받는다. 상대 기관 id는 키가
   * 반드시 있고 값은 null 또는 등록된 다른 기관이다. 같은 검사·종류·요청자의 활성 요청은 하나다(OQ-7 a).
   */
  async create(uid: string, c: RequestCaller, b: any) {
    this.member(c);
    if (!holds(c, CLINICIAN_ROLE)) throw roleRequired();
    if (!studyUid(uid)) throw invalid('검사 UID를 확인하세요');
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'kind', 'counterparty', 'counterpartyInstitutionId', 'reason']) || !uuid(b.requestId)
      || !IMAGE_REQUEST_KINDS.includes(b.kind) || !text(b.counterparty, IMAGE_REQUEST_COUNTERPARTY_MAX)
      || !text(b.reason, IMAGE_REQUEST_TEXT_MAX) || b.counterpartyInstitutionId !== null && !institutionId(b.counterpartyInstitutionId))
      throw invalid('요청 ID·종류, 1~256자의 상대 기관과 1~2,000자의 사유를 입력하세요');
    if (b.counterpartyInstitutionId === c.institution) throw counterpartyInvalid();
    this.expectOwner(c, b);
    const requestId = b.requestId.toLowerCase();
    const mark = fingerprint({ uid, institution: c.institution, subject: c.sub, kind: b.kind, counterparty: b.counterparty,
      counterpartyInstitutionId: b.counterpartyInstitutionId, reason: b.reason });
    await this.studyAccess.prepare(c, [uid]);
    return this.run(c, async tx => {
      await this.study(tx, uid, c, true, studyMissing);
      const receipt = await tx.studyImageRequestReceipt.findUnique({ where: { requestId } });
      if (receipt) return this.replay(receipt, mark, requestId, c);
      if (b.counterpartyInstitutionId !== null) {
        // 잠금은 그 기관 행이 커밋 전에 지워지거나 id가 바뀌지 않게 할 뿐이다. 상대 기관에 어떤 열람도 생기지 않는다.
        const known: any[] = await tx.$queryRaw`SELECT id FROM "Institution" WHERE id=${b.counterpartyInstitutionId} FOR KEY SHARE`;
        if (!known.length) throw counterpartyInvalid();
      }
      // 검사 행을 잠근 뒤라 같은 검사의 생성·변경은 여기서 줄을 선다. 부분 unique는 같은 규칙의 마지막 방어선이다.
      const active: any[] = await tx.$queryRaw`SELECT id FROM "StudyImageRequest" WHERE "studyUid"=${uid} AND kind=${b.kind}
        AND "requesterSub"=${c.sub} AND state::text=ANY(${[...ACTIVE]}::text[])`;
      if (active.length) throw activeExists();
      const at = new Date(), name = this.name(c);
      const applied = { id: requestId, studyUid: uid, requestId, kind: b.kind, action: 'create', from: null, to: 'Requested', revision: 1,
        at: at.toISOString() };
      await tx.studyImageRequest.create({ data: { id: requestId, studyUid: uid, institutionId: c.institution, kind: b.kind,
        requesterSub: c.sub, requesterActor: c.actor, requesterName: name, counterpartyText: b.counterparty,
        counterpartyInstitutionId: b.counterpartyInstitutionId, reason: b.reason, state: 'Requested', revision: 1,
        changedBy: c.actor, createdAt: at, updatedAt: at } });
      await this.receipt(tx, c, applied, mark, b.counterpartyInstitutionId, CLINICIAN_ROLE, at);
      return { owner: this.owner(c), applied, replayed: false };
    });
  }

  /**
   * #11 상태 변경. accept는 빈 note, close·decline·cancel은 1~2,000자 note. 처리 동작은 technician·admin, 취소는
   * 요청한 임상의 또는 admin이다. 동작별 역할은 body의 action을 읽은 뒤 트랜잭션 전에 판정한다.
   */
  async change(id: string, c: RequestCaller, b: any) {
    this.member(c);
    if (!holds(c, CLINICIAN_ROLE) && !staff(c)) throw roleRequired();
    if (!exactKeys(b, ['requestId', 'expectedOwner', 'revision', 'action', 'note']) || !uuid(b.requestId) || !revision(b.revision)
      || !IMAGE_REQUEST_ACTIONS.includes(b.action) || (b.action === 'accept' ? b.note !== '' : !text(b.note, IMAGE_REQUEST_TEXT_MAX)))
      throw invalid('요청 ID·기준 revision·동작과 note를 확인하세요(accept는 빈 note, 그 밖은 1~2,000자)');
    if (b.action === 'cancel' ? !holds(c, CLINICIAN_ROLE) && !holds(c, ADMIN) : !staff(c)) throw roleRequired();
    this.expectOwner(c, b);
    if (!uuid(id)) throw requestMissing();
    const imageRequestId = id.toLowerCase(), requestId = b.requestId.toLowerCase(), scope = this.scope(c);
    const mark = fingerprint({ id: imageRequestId, institution: c.institution, subject: c.sub, revision: b.revision, action: b.action, note: b.note });
    const step = TRANSITIONS[b.action];
    await this.studyAccess.prepare(c);
    return this.run(c, async tx => {
      const row = await this.request(tx, imageRequestId, c, scope, true);
      const receipt = await tx.studyImageRequestReceipt.findUnique({ where: { requestId } });
      if (receipt) return this.replay(receipt, mark, imageRequestId, c);
      if (row.revision !== b.revision) throw changed();
      if (!step.from.includes(row.state)) throw stateError();
      let role: string;
      if (b.action !== 'cancel') role = holds(c, TECHNICIAN) ? TECHNICIAN : ADMIN;
      else if (row.requesterSub === c.sub && holds(c, CLINICIAN_ROLE)) role = CLINICIAN_ROLE;
      else if (holds(c, ADMIN)) role = ADMIN;
      else throw actionForbidden();
      return this.apply(tx, c, row, requestId, mark, b.action, step.to, role, b.note);
    });
  }
}
