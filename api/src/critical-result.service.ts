import { rightsUser, lockMemberRights } from './member-rights';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { StudyAccessService } from './study-access.service';
import { KeycloakService, KeycloakUser } from './keycloak.service';
import { OrthancService } from './orthanc.service';
import { clinicianFinal } from './clinician-policy';
import type { Caller } from './pacs.service';
import {
  CRITICAL_RESULT_CODES as CODE, CRITICAL_RESULT_PAGE, CRITICAL_RESULT_PINNABLE_ACTIONS, CRITICAL_RESULT_STATE_FILTERS, Head,
  RADIOLOGIST, RecipientClass, Refusal, ackFingerprint, ackRefusal, appliedResult, auditDetail, cancelFingerprint, clip,
  createCase, createFingerprint, decodeCursor, deliveryOf, eligibleRecipient, effectiveRoles, encodeCursor, exactKeys, holds,
  isObject, legacyReadable, originalIdentity, positiveValue, recipientCase, recipientClass, recipientSees, recipientView, recordRefusal,
  senderScope, senderSees, senderView, sourceRefusal, studyIdentity, studyUidValue, supersedeFingerprint, textValue, userActor, userName,
  uuidValue,
} from './critical-result-policy';

/**
 * S7-U1a 중요 결과 전달·명시적 수신 확인(계약 S7-U1p §3~§11, 진입 결정 D49).
 *
 * consultation·임상의 질문·영상 요청을 넓히지 않고 따로 둔다(§10.1) — 판독의가 지정한 한 사람에게 **정확한 한 판**을
 * 보내고 그 사람만 명시적으로 확인한다. 원천은 ReportVersion 한 행뿐이다: 생성 순간의 머리 판을 (studyUid,
 * sourceVersion) 외래 키로 고정하고 본문은 읽을 때 그 행에서 읽는다. 개인 초안·현재 Report 본문·미리보기 응답은 어떤
 * 목적으로도 읽지 않는다(머리 판 번호를 알려고 Report.version만 읽는다).
 * 역할은 동작마다 명시하고 need()를 쓰지 않는다 — need()의 admin 예외가 있으면 관리자가 발신·대리 ACK를 하게 된다
 * (D-S7-02 a). 기관(S7-U1c, D-S7-05 a): 기록은 늘 검사 소유 기관(A)의 것이다. 원격판독 통로가 지금 열린 기관(B)의
 * 판독의는 A의 회원에게만 보낼 수 있고 두 기관 칸(institutionId = A, senderInstitutionId = B)이 기록에 남는다. B의 읽기·
 * 취소·대체는 통로가 열린 동안만이다(통로는 쓰기에서 검사 행을 잠근 뒤, 읽기에서 같은 스냅샷에서 본다). 수신자 쪽은
 * 통로와 무관하며 수신자 자격·StudyAccess 주체의 기관은 기록 기관이다. 질문·영상 요청·consultation은 넓히지 않는다.
 * Keycloak·Orthanc 읽기와 StudyAccess 원본 태그 준비는 모두 트랜잭션·잠금 전에 끝나고 트랜잭션 안에서는 네트워크를
 * 쓰지 않는다(§4.1). 쓰기의 새 요청은 caller의 Keycloak 현재 상태를 다시 확인하고, 읽기는 토큰만 쓴다(I-10, §17 L-10).
 */
export const CRITICAL_RESULT_AUDIT_ACTION = 'study.critical-result';
const CREATE_KEYS = ['requestId', 'expectedOwner', 'recipientSub', 'sourceVersion', 'message'];
const ACK_KEYS = ['requestId', 'expectedOwner', 'revision'];
const CANCEL_KEYS = ['requestId', 'expectedOwner', 'revision', 'reason'];
const SUPERSEDE_KEYS = ['requestId', 'expectedOwner', 'revision', 'sourceVersion', 'message'];
const READ = { isolationLevel: 'RepeatableRead' as const, maxWait: 4000, timeout: 8000 };
const WRITE = { maxWait: 4000, timeout: 8000 };

export type CriticalCaller = Caller & { name?: string };

const MESSAGES: Record<string, string> = {
  [CODE.INPUT_INVALID]: '중요 결과 요청의 형식을 확인하세요',
  [CODE.RECIPIENT_INVALID]: '받는 사람은 본인이 아닌, 검사 소유 기관의 활성 임상의 또는 판독의여야 합니다',
  [CODE.ROLE_REQUIRED]: '이 중요 결과 동작에 필요한 역할이 없습니다',
  [CODE.SOURCE_FORBIDDEN]: '예비 판독 중이라 지정된 판독의만 이 판독 판을 보낼 수 있습니다',
  [CODE.STUDY_NOT_FOUND]: '검사를 찾을 수 없습니다',
  [CODE.NOT_FOUND]: '중요 결과 전달 기록을 찾을 수 없습니다',
  [CODE.OWNER_CHANGED]: '로그인한 계정이 바뀌었습니다. 화면을 다시 불러오세요',
  [CODE.REUSED]: '다른 내용에 이미 쓰인 요청 ID입니다. 전달 기록을 다시 불러오세요',
  [CODE.CHANGED]: '전달 기록이 변경되었습니다. 다시 불러온 뒤 확인하세요',
  [CODE.ACKNOWLEDGED]: '이미 수신 확인된 전달입니다',
  [CODE.CANCELLED]: '취소된 전달입니다',
  [CODE.SUPERSEDED]: '새 판으로 대체된 전달입니다',
  [CODE.SOURCE_MOVED]: '그 사이 판독 판이 바뀌었습니다. 다시 불러온 뒤 보낼 판을 확인하세요',
  [CODE.SOURCE_INVALID]: '보낼 수 있는 판독 판이 없습니다(판독 전이거나 판독 취소됨)',
  [CODE.SOURCE_CHANGED]: '판독이 바뀌어 이 전달은 확인할 수 없습니다. 발신자의 대체 또는 취소를 기다리세요',
  [CODE.RECIPIENT_CANNOT_READ]: '받는 사람이 이 판독 판을 지금 읽을 수 없습니다(임상의는 승인·추가기재된 판독만 받을 수 있습니다)',
  [CODE.PENDING_EXISTS]: '같은 검사·받는 사람에게 확인 대기 중인 전달이 있습니다. 대체하거나 취소하세요',
  [CODE.BUSY]: '중요 결과 처리 중입니다. 같은 요청으로 다시 시도하세요',
  [CODE.UNAVAILABLE]: '계정 또는 원본 정보를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요',
};

/** 거절 하나를 Nest 예외로. body는 {code, message}이고 PENDING_EXISTS는 id, SUPERSEDED는 replacedBy를 함께 싣는다(§13). */
function refuse(r: Refusal, message?: string): HttpException {
  const body: Record<string, unknown> = { code: r.code, message: message ?? MESSAGES[r.code] ?? '중요 결과 요청을 처리할 수 없습니다' };
  if (r.id) body.id = r.id;
  if (r.replacedBy) body.replacedBy = r.replacedBy;
  if (r.status === 400) return new BadRequestException(body);
  if (r.status === 403) return new ForbiddenException(body);
  if (r.status === 404) return new NotFoundException(body);
  if (r.status === 409) return new ConflictException(body);
  return new ServiceUnavailableException(body);
}
const invalid = (message?: string) => refuse({ status: 400, code: CODE.INPUT_INVALID }, message);
const recipientInvalid = () => refuse({ status: 400, code: CODE.RECIPIENT_INVALID });
const roleRequired = () => refuse({ status: 403, code: CODE.ROLE_REQUIRED });
const studyMissing = () => refuse({ status: 404, code: CODE.STUDY_NOT_FOUND });
const recordMissing = () => refuse({ status: 404, code: CODE.NOT_FOUND });
const ownerChanged = () => refuse({ status: 409, code: CODE.OWNER_CHANGED });
const reused = () => refuse({ status: 409, code: CODE.REUSED });
const cannotRead = () => refuse({ status: 409, code: CODE.RECIPIENT_CANNOT_READ });
const busy = () => refuse({ status: 503, code: CODE.BUSY });
const unavailable = () => refuse({ status: 503, code: CODE.UNAVAILABLE });

@Injectable()
export class CriticalResultService {
  constructor(private prisma: PrismaService, private studyAccess: StudyAccessService, private keycloak: KeycloakService,
    private orthanc: OrthancService) {}

  private member(c: CriticalCaller) {
    if (c.kind !== 'member' || ![c.institution, c.sub, c.actor].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256))
      throw roleRequired();
  }

  /** 표시 이름은 토큰에서만 온다(§3.1). */
  private name(c: CriticalCaller) { return clip(typeof c.name === 'string' && c.name.trim() ? c.name : c.actor); }

  private owner(c: Caller) { return [c.institution, c.sub]; }

  private expectOwner(c: Caller, b: any) {
    if (JSON.stringify(b.expectedOwner) !== JSON.stringify(this.owner(c))) throw ownerChanged();
  }

  /**
   * 쓰기 전 DB 권한 재확인(D623). 요청과 현재 DB 역할에 route 권한이 있어야 하며 철회되었으면 403, DB를 읽지
   * 못하면 503이다. 토큰이 남아 있어도 철회된 사람의 새 쓰기는 여기서 멈춘다(CR18).
   */
  private async recheck(c: CriticalCaller, allowed: (roles: string[]) => boolean): Promise<string[]> {
    let user: KeycloakUser | null;
    try { user = rightsUser(await this.prisma.memberRights.findUnique({ where: { sub: c.sub } })); } catch { throw unavailable(); }
    const roles = effectiveRoles(user, c);
    if (!roles || !allowed(roles)) throw roleRequired();
    return roles;
  }

  private async user(sub: string): Promise<KeycloakUser | null> {
    try { return rightsUser(await this.prisma.memberRights.findUnique({ where: { sub } })); } catch { throw unavailable(); }
  }

  private async preliminaryRoster(uid: string, institution: string) {
    const state = await this.prisma.studyState.findUnique({ where: { uid }, select: { rs: true } });
    if (state?.rs !== 'P') return [];
    try { return await this.keycloak.usersInGroupWithRole(institution, RADIOLOGIST, true); } catch { throw unavailable(); }
  }

  /** The report picker stores roster ids; only an unambiguous binding to a subject identifies its readers. */
  private recipientReadState(state: any, roster: { id: string; sub: string }[]) {
    const subject = (actor: string) => {
      const matches = roster.filter(user => user.id === actor);
      return matches.length === 1 ? matches[0].sub : null;
    };
    return { ...state, preDoc: subject(state?.preDoc), preReviewer: subject(state?.preReviewer) };
  }

  /** 원본 신원 한 건(§3.2). 트랜잭션 밖에서만 부른다. 영상 저장·전송·변경 호출은 없다. */
  private async identity(uid: string) {
    try {
      const row = await this.orthanc.reportPreviewStudy(uid);
      return originalIdentity(key => OrthancService.tag(row, key));
    } catch { throw unavailable(); }
  }

  /**
   * 잠금 없는 사전 읽기: 이 검사의 지금 발신 범위(기록 기관 — 소유 기관이면 caller 기관, 원격판독 통로면 소유 기관).
   * 없으면 Keycloak·Orthanc를 읽지 않고 트랜잭션 안의 가시성 판정(순서 9)이 404로 답한다 — 원본에 없는 UID(Orthanc 실패
   * 503)와 범위 밖 검사(404)가 다른 답이 되어 범위 밖 검사의 존재가 드러나지 않게 한다. 판정 자체는 트랜잭션 안에서
   * 다시 하고, 그 사이 범위가 바뀌었으면 이 읽기로 준비한 수신자·원본을 쓰지 않는다.
   */
  private async scope(uid: string, c: Caller) {
    const row = await this.prisma.studyState.findUnique({ where: { uid }, select: { institutionId: true, teleInstitutionId: true } });
    return senderScope(row, c.institution);
  }

  /**
   * 수신자 주체의 StudyAccess(§4.1): 기록 기관(A)의 그 사람. StudyAccess는 (기관, 주체)로 정책과 잠금을 찾고 기관이 다른
   * 정책 행은 모두 거절하므로, tele 발신자의 기관(B)을 그대로 쓰면 A의 수신자를 B 기관 사람으로 판정한다(F-04). 준비와
   * 판정이 같은 객체를 써야 한다.
   */
  private subject(c: Caller, institution: string, sub: string): Caller { return { ...c, institution, sub }; }

  private async readableBy(subject: Caller, uid: string, tx?: any) {
    return (await this.studyAccess.allowed(subject, [uid], tx)).has(uid);
  }

  /**
   * 트랜잭션 하나. 쓰기는 기본 격리(ReadCommitted)에서 검사·기록 행을 잠근 뒤 커밋된 최신 행을 보고, 읽기는 RepeatableRead
   * 한 스냅샷에서 행 잠금 없이 읽는다(목록 한 쪽과 pending 수도 같은 스냅샷). 정책 공유 잠금은 caller와(생성·대체면)
   * 수신자 주체다. 두 공유 잠금은 서로 막지 않고 정책 쓰기는 주체 하나의 배타 잠금만 잡는다.
   */
  private async run<T>(c: Caller, subjects: Caller[], fn: (tx: any) => Promise<T>, read = false): Promise<T> {
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await this.studyAccess.snapshot(c, tx);
        for (const subject of subjects) await this.studyAccess.snapshot(subject, tx);
        return fn(tx);
      }, read ? READ : WRITE);
    } catch (e: any) {
      // 확인 대기 중복은 검사 행 잠금 아래에서 먼저 찾는다. 부분 unique가 걸리면 같은 뜻의 409이고, 그 밖의 unique 충돌은
      // 같은 requestId가 다른 기록·route에서 동시에 쓰인 때뿐이다.
      if (e?.code === 'P2002') {
        const target = JSON.stringify(e?.meta?.target ?? '');
        throw target.includes('pending') || target.includes('recipientSub') ? refuse({ status: 409, code: CODE.PENDING_EXISTS }) : reused();
      }
      // 잠금·트랜잭션 시간 초과(계약 잠금 실패)는 직접 올 수도, 정책 공유 잠금·조회(StudyAccess snapshot)가 자기 503의
      // cause로만 넘길 수도 있다. 둘 다 BUSY다. 형식이 틀린 정책 같은 다른 StudyAccess 503은 그대로 나가고, cause는 답에 싣지 않는다.
      const dbBusy = (x: any) => ['P2024', 'P2028', 'P2034'].includes(x?.code)
        || x?.code === 'P2010' && ['55P03', '57014', '40P01'].includes(x?.meta?.code);
      if (dbBusy(e) || e instanceof ServiceUnavailableException && dbBusy(e.cause)) throw busy();
      throw e;
    }
  }

  private async studyRow(tx: any, uid: string, lock: boolean) {
    const rows: any[] = lock
      ? await tx.$queryRaw`SELECT uid,"institutionId","teleInstitutionId",rs,"preDoc","preReviewer",ov FROM "StudyState" WHERE uid=${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT uid,"institutionId","teleInstitutionId",rs,"preDoc","preReviewer",ov FROM "StudyState" WHERE uid=${uid}`;
    return rows[0] ?? null;
  }

  /** 머리 판 = ReportVersion(uid, Report.version) 한 행의 번호·action·작성자·시각. Report의 본문 칸은 읽지 않는다. */
  private async head(tx: any, uid: string): Promise<Head> {
    const rows: any[] = await tx.$queryRaw`SELECT r.version AS "headVersion",v.action AS "headAction",v.author AS "headAuthor",v.at AS "headAt"
      FROM "Report" r LEFT JOIN "ReportVersion" v ON v.uid=r.uid AND v.version=r.version WHERE r.uid=${uid}`;
    const row = rows[0];
    if (!row || !Number.isSafeInteger(row.headVersion) || row.headVersion < 1) return null;
    return { version: row.headVersion, action: row.headAction ?? null, author: row.headAuthor ?? null, at: row.headAt ?? null };
  }

  /** 고정 판 행 자신의 본문. 판독 초안·현재 Report가 아니다. */
  private async pinnedBody(tx: any, uid: string, version: number) {
    const rows: any[] = await tx.$queryRaw`SELECT findings,conclusion,recommendation FROM "ReportVersion" WHERE uid=${uid} AND version=${version}`;
    return rows[0] ?? null;
  }

  private async recordRow(tx: any, id: string, lock: boolean) {
    const rows: any[] = lock
      ? await tx.$queryRaw`SELECT * FROM "CriticalResult" WHERE id=${id}::uuid FOR UPDATE`
      : await tx.$queryRaw`SELECT * FROM "CriticalResult" WHERE id=${id}::uuid`;
    return rows[0] ?? null;
  }

  /**
   * 대체 기록(이 기록을 supersedes로 가리키는 기록)의 id. 발신자에게는 늘, 수신자에게는 그 기록을 지금 읽을 수 있을 때만
   * 준다(§13 "호출자가 읽을 수 있는 기록일 때만").
   */
  private async replacement(tx: any, row: any, reader: null | { cls: RecipientClass; state: any; head: Head; actor: string }) {
    const rows: any[] = await tx.$queryRaw`SELECT id,"sourceVersion" FROM "CriticalResult" WHERE "supersedesId"=${row.id}::uuid`;
    return this.replacementOf(rows[0] ? { id: rows[0].id, sourceVersion: rows[0].sourceVersion } : null, reader);
  }

  private replacementOf(next: { id: string; sourceVersion: number } | null, reader: null | { cls: RecipientClass; state: any; head: Head; actor: string }) {
    if (!next?.id) return null;
    if (!reader) return next.id;
    const kase = recipientCase({ cls: reader.cls, visible: true, pin: next.sourceVersion, head: reader.head, state: reader.state, actor: reader.actor });
    return kase.view === null ? null : next.id;
  }

  /**
   * UID route의 검사 가시성(T-1/T-3 a~c, S7-U1c): 지금 발신 범위(소유 기관 또는 지금 열린 원격판독 통로) + StudyAccess.
   * 없음·범위 밖·접근 거절은 같은 404다. 범위의 기관(기록 기관)을 돌려준다.
   */
  private async visibleStudy(tx: any, uid: string, c: Caller, state: any, missing: () => HttpException): Promise<string> {
    const institution = senderScope(state, c.institution);
    if (!institution) throw missing();
    try { await this.studyAccess.require(c, [uid], tx); }
    catch (e) { if (e instanceof NotFoundException) throw missing(); throw e; }
    return institution;
  }

  /**
   * id route 쓰기의 대상(§4 순서 8~9): caller가 그 기록의 발신자(기록 시점 발신 기관 포함) 또는 수신자(기록 기관 =
   * caller 기관)인지 먼저 본다 — 두 칸 모두 바뀌지 않는 값이다. 그다음 검사 행 FOR UPDATE, 지금 소유 기관 = 기록 기관과
   * 발신자면 지금의 발신 범위(tele 통로), StudyAccess, 그다음 기록 행 FOR UPDATE. 통로는 검사 행을 잠근 뒤에 본다 — 잠금
   * 전에 보면 통로 닫힘과 엇갈린 취소·대체가 닫힌 뒤에 적용된다(TC-05). 잠금 순서는 StudyState → CriticalResult이고
   * commitReport·removeState·통로를 닫는 patchState도 StudyState를 먼저 잡으므로 머리 판 판정·통로와 쓰기가 엇갈리지 않는다.
   */
  private async writeTarget(tx: any, id: string, c: Caller, as: 'sender' | 'recipient') {
    const party = (row: any) => as === 'sender' ? row.senderSub === c.sub && row.senderInstitutionId === c.institution
      : row.recipientSub === c.sub && row.institutionId === c.institution;
    const sees = (row: any, state: any) => as === 'sender' ? senderSees(row, state, c) : recipientSees(row, state, c);
    const first = await this.recordRow(tx, id, false);
    if (!first || !party(first)) throw recordMissing();
    const state = await this.studyRow(tx, first.studyUid, true);
    if (!sees(first, state)) throw recordMissing();
    try { await this.studyAccess.require(c, [first.studyUid], tx); }
    catch (e) { if (e instanceof NotFoundException) throw recordMissing(); throw e; }
    const head = await this.head(tx, first.studyUid);
    const row = await this.recordRow(tx, id, true);
    if (!row || row.studyUid !== first.studyUid || !party(row) || !sees(row, state)) throw recordMissing();
    return { row, state, head };
  }

  /**
   * 적용된 requestId의 재전송(§4 순서 11): 가시성 판정 뒤, 상태·revision·원천·수신자 판정 앞이라 접근을 잃으면 재전송도
   * 거절되고, 뒤이은 머리 이동·종결 뒤에도 같은 저장 결과다. 내용·route·기록·사용자가 다르면 409.
   */
  private replay(receipt: any, mark: string, recordId: string, action: string, c: Caller) {
    if (receipt.fingerprint !== mark || receipt.recordId !== recordId || receipt.subjectSub !== c.sub || receipt.action !== action
      || !isObject(receipt.result)) throw reused();
    return { owner: this.owner(c), applied: receipt.result, replayed: true };
  }

  private async event(tx: any, recordId: string, seq: number, event: string, c: CriticalCaller, name: string, role: string,
    requestId: string, at: Date) {
    await tx.criticalResultEvent.create({ data: { id: randomUUID(), recordId, seq, event, revision: seq, actorSub: c.sub,
      actorActor: c.actor, actorName: name, actorRole: role, requestId, at } });
  }

  /** 상태 변경마다 같은 트랜잭션에 감사 한 행(§11). detail에는 메시지·사유·본문·환자 식별자·수신자 sub가 없다. */
  private async writeAudit(tx: any, c: Caller, record: any, e: { event: string; from: string | null; to: string; revision: number;
    requestId: string; role: string; supersedes: string | null; replacedBy: string | null }) {
    await tx.auditLog.create({ data: { actor: c.actor, action: CRITICAL_RESULT_AUDIT_ACTION, target: record.studyUid,
      detail: JSON.stringify(auditDetail({ id: record.id, institution: record.institutionId, senderInstitution: record.senderInstitutionId,
        event: e.event, from: e.from, to: e.to, revision: e.revision, requestId: e.requestId, role: e.role, source: record.sourceVersion,
        recipient: record.recipientActor, supersedes: e.supersedes, replacedBy: e.replacedBy })) } });
  }

  private async receipt(tx: any, c: Caller, recordId: string, action: string, mark: string, applied: any, at: Date) {
    await tx.criticalResultReceipt.create({ data: { requestId: applied.requestId, recordId, subjectSub: c.sub, action, fingerprint: mark,
      appliedRevision: applied.revision, result: applied as any, at } });
  }

  /** 새 기록 한 행(생성·대체). 고정 행의 action·작성자·시각은 같은 트랜잭션에서 읽은 머리 판의 사본이다(불변 행). */
  private newRecord(v: { id: string; uid: string; institution: string; senderInstitution: string; c: CriticalCaller; name: string;
    recipient: KeycloakUser; cls: RecipientClass; head: Head; identity: any; message: string; supersedesId: string | null; at: Date }) {
    return { id: v.id, studyUid: v.uid, institutionId: v.institution, senderInstitutionId: v.senderInstitution, senderSub: v.c.sub,
      senderActor: v.c.actor, senderName: v.name, recipientSub: v.recipient.id, recipientActor: userActor(v.recipient),
      recipientName: userName(v.recipient), recipientRole: v.cls, sourceVersion: v.head.version, sourceAction: v.head.action,
      sourceAuthor: String(v.head.author ?? ''), sourceAt: v.head.at, ...v.identity, message: v.message, state: 'created', revision: 1,
      supersedesId: v.supersedesId, changedBy: v.c.actor, createdAt: v.at, updatedAt: v.at };
  }

  /**
   * 생성·대체의 수신자 판정(§4 순서 15): Keycloak 현재 상태의 자격(T-8, 기록 기관의 회원) → 400, 부류별로 지금 고정 원문을
   * 읽는가(C2/R2) → 409. 수신자 주체(기록 기관)의 StudyAccess는 트랜잭션 전에 준비한 태그로 같은 트랜잭션에서 판정한다.
   */
  private async judgeRecipient(tx: any, uid: string, institution: string, c: Caller, sub: string, recipient: KeycloakUser | null,
    subject: Caller | null, head: Head, state: any, roster: { id: string; sub: string }[]): Promise<RecipientClass> {
    await lockMemberRights(tx, sub);
    recipient = rightsUser(await tx.memberRights.findUnique({ where: { sub } }));
    const cls = eligibleRecipient(recipient, { sub, institution, sender: c.sub });
    // Keep the prepared subject object: StudyAccess binds source metadata to its identity.
    if (subject && recipient) { subject.roles = recipient.roles; subject.institution = recipient.groups[0]; }
    if (!cls || !subject) throw recipientInvalid();
    const visible = await this.readableBy(subject, uid, tx);
    const kase = createCase({ cls, visible, head, state: this.recipientReadState(state, roster), actor: sub });
    if (kase !== 'C2' && kase !== 'R2') throw cannotRead();
    return cls;
  }

  // ── #1 후보 ──

  /**
   * GET studies/:uid/critical-result-recipients. Mark CVR 활성 판단·고정할 원천·수신자 후보(§3.3 Candidates). 후보는 생성
   * 판정(T-8 자격 + C2/R2)을 지금 통과하는 사람만이다. 후보 목록은 권한이 아니다 — 생성이 같은 판정을 다시 한다.
   */
  async recipients(uid: string, c: CriticalCaller) {
    this.member(c);
    if (!holds(c.roles, RADIOLOGIST)) throw roleRequired();
    if (!studyUidValue(uid)) throw invalid('검사 UID를 확인하세요');
    const institution = await this.scope(uid, c);
    if (!institution) throw studyMissing();
    await this.studyAccess.prepare(c, [uid]);
    // 후보는 기록 기관(검사 소유 기관)의 회원이다. tele 발신자 기관(B)의 회원은 수신자가 아니다(TR-02).
    let members: KeycloakUser[];
    try { members = await this.keycloak.institutionMembers(institution); } catch { throw unavailable(); }
    const candidates: { user: KeycloakUser; cls: RecipientClass; subject: Caller }[] = [];
    for (const user of members) {
      const cls = eligibleRecipient(user, { sub: user.id, institution, sender: c.sub });
      if (!cls) continue;
      const subject = this.subject(c, institution, user.id);
      await this.studyAccess.prepare(subject, [uid]);
      candidates.push({ user, cls, subject });
    }
    const out = await this.run(c, [], async tx => {
      const state = await this.studyRow(tx, uid, false);
      // 사전 읽기 뒤 소유 기관이 바뀌어 범위가 다른 기관이 되었으면 준비한 후보는 그 기관의 것이 아니다.
      if (await this.visibleStudy(tx, uid, c, state, studyMissing) !== institution) throw unavailable();
      const head = await this.head(tx, uid);
      const pinnable = !!head && CRITICAL_RESULT_PINNABLE_ACTIONS.includes(head.action as string);
      const readable = legacyReadable(state, c.actor);
      const recipients: any[] = [];
      if (pinnable && readable) for (const x of candidates) {
        const roster = members.map(user => ({ id: userActor(user), sub: user.id }));
        const kase = createCase({ cls: x.cls, visible: await this.readableBy(x.subject, uid, tx), head,
          state: this.recipientReadState(state, roster), actor: x.user.id });
        if (kase === 'C2' || kase === 'R2') recipients.push({ sub: x.user.id, actor: userActor(x.user), name: userName(x.user), role: x.cls });
      }
      return { state, head, pinnable, readable, recipients };
    }, true);
    const reason = !out.pinnable ? 'NO_PINNABLE_SOURCE' : !out.readable ? 'SOURCE_FORBIDDEN' : !out.recipients.length ? 'NO_ELIGIBLE_RECIPIENT' : null;
    out.recipients.sort((a, b) => a.name.localeCompare(b.name) || a.sub.localeCompare(b.sub));
    return { owner: this.owner(c), uid, sendable: reason === null, reason,
      // 발신자가 읽을 수 없는 머리(P 짝 밖)는 판 메타데이터도 싣지 않는다.
      source: out.pinnable && out.readable ? { version: out.head.version, action: out.head.action, author: out.head.author,
        at: out.head.at == null ? null : new Date(out.head.at).toISOString(), final: clinicianFinal(out.state.rs, out.head) } : null,
      recipients: out.recipients };
  }

  // ── #2 생성 ──

  /** POST studies/:uid/critical-results. 발신자는 인증된 요청, 수신자 자격·귀속은 DB 회원에서 온다. */
  async create(uid: string, c: CriticalCaller, b: any) {
    this.member(c);
    if (!holds(c.roles, RADIOLOGIST)) throw roleRequired();
    if (!studyUidValue(uid)) throw invalid('검사 UID를 확인하세요');
    if (!exactKeys(b, CREATE_KEYS) || !uuidValue(b.requestId) || !uuidValue(b.recipientSub) || !positiveValue(b.sourceVersion)
      || !textValue(b.message)) throw invalid('요청 ID·받는 사람·보낼 판 번호와 1~2,000자의 메시지를 입력하세요');
    const recipientSub = b.recipientSub.toLowerCase();
    if (recipientSub === c.sub) throw recipientInvalid();
    this.expectOwner(c, b);
    const requestId = b.requestId.toLowerCase();
    const mark = createFingerprint({ uid, institution: c.institution, subject: c.sub, recipientSub, sourceVersion: b.sourceVersion, message: b.message });
    // 순서 4: 적용된 요청의 재전송이면 Keycloak·Orthanc를 읽지 않는다(Keycloak이 멈춰도 재전송은 답한다).
    const known = await this.prisma.criticalResultReceipt.findUnique({ where: { requestId } });
    let recipient: KeycloakUser | null | undefined, identity: any = null, prepared: string | null = null;
    let roster: Awaited<ReturnType<KeycloakService['usersInGroupWithRole']>> = [];
    if (!known) {
      await this.recheck(c, roles => holds(roles, RADIOLOGIST));
      prepared = await this.scope(uid, c);
      if (prepared) {
        recipient = await this.user(recipientSub); identity = await this.identity(uid);
        if (recipient?.roles.includes(RADIOLOGIST)) {
          roster = await this.preliminaryRoster(uid, prepared);
          const current = roster.find(user => user.sub === recipientSub);
          if (current) recipient = { ...recipient, email: current.id, username: current.username, firstName: current.name, lastName: '' };
        }
      }
    }
    const subject = recipient && prepared ? this.subject(c, prepared, recipientSub) : null;
    await this.studyAccess.prepare(c, [uid]);
    if (subject) await this.studyAccess.prepare(subject, [uid]);
    return this.run(c, subject ? [subject] : [], async tx => {
      const state = await this.studyRow(tx, uid, true);
      // 발신 범위(tele 통로 포함)는 잠근 검사 행에서 다시 본다 — 사전 읽기 뒤 통로가 닫혔으면 여기서 404다(TC-04).
      const institution = await this.visibleStudy(tx, uid, c, state, studyMissing);
      const receipt = await tx.criticalResultReceipt.findUnique({ where: { requestId } });
      if (receipt) {
        const replayed = this.replay(receipt, mark, requestId, 'create', c);
        // 재전송은 그 기록을 지금 보는 발신자에게만 저장 결과로 답한다. 검사가 보여도(통로는 그대로인데 소유 기관이
        // 바뀜) 기록 기관이 지금의 발신 범위가 아니면 404다(TC-08) — 같은 기관 경로에서는 늘 같다.
        const record = await tx.criticalResult.findUnique({ where: { id: requestId },
          select: { institutionId: true, senderInstitutionId: true, senderSub: true, recipientSub: true } });
        if (!record || !senderSees(record, state, c)) throw studyMissing();
        return replayed;
      }
      const pending: any[] = await tx.$queryRaw`SELECT id FROM "CriticalResult" WHERE "studyUid"=${uid} AND "senderSub"=${c.sub}
        AND "recipientSub"=${recipientSub} AND state='created'`;
      if (pending.length) throw refuse({ status: 409, code: CODE.PENDING_EXISTS, id: pending[0].id });
      const head = await this.head(tx, uid);
      const source = sourceRefusal({ sourceVersion: b.sourceVersion, head, senderReadable: legacyReadable(state, c.actor) });
      if (source) throw refuse(source);
      // 잠금 없는 사전 읽기가 이 검사를 발신 범위로 보지 못해 수신자·원본을 읽지 않았는데 지금은 보이거나(그 사이 기관
      // 배정·통로 열림), 범위의 기관이 달라졌다(그 사이 소유 기관 변경). 준비한 수신자 판정을 다른 기관에 쓰지 않는다.
      if (recipient === undefined || !identity || prepared !== institution) throw unavailable();
      const cls = await this.judgeRecipient(tx, uid, institution, c, recipientSub, recipient, subject, head, state, roster);
      const at = new Date(), name = this.name(c);
      // 기록 기관 = 검사 소유 기관, 발신 기관 = caller 기관(tele면 둘이 다르다). 둘 다 기록 시점 값으로 남는다.
      const record = this.newRecord({ id: requestId, uid, institution, senderInstitution: c.institution, c, name,
        recipient, cls, head, identity, message: b.message, supersedesId: null, at });
      await tx.criticalResult.create({ data: record });
      await this.event(tx, requestId, 1, 'created', c, name, RADIOLOGIST, requestId, at);
      const applied = appliedResult({ id: requestId, studyUid: uid, requestId, action: 'create', from: null, to: 'created', revision: 1, at });
      await this.receipt(tx, c, requestId, 'create', mark, applied, at);
      await this.writeAudit(tx, c, record, { event: 'created', from: null, to: 'created', revision: 1, requestId, role: RADIOLOGIST,
        supersedes: null, replacedBy: null });
      return { owner: this.owner(c), applied, replayed: false };
    });
  }

  // ── #6 ACK ──

  /**
   * POST critical-results/:id/ack. 지정된 수신자 본인이 지금 읽을 수 있는 고정 판(C2/R2)에 대해 명시적으로 보낸 것만 ACK다.
   * 목록·한 건·검사별 GET, 시간 경과, 발신자·관리자의 행위는 ACK가 아니다(§5.3). ACK에는 자유 문장이 없다.
   */
  async ack(id: string, c: CriticalCaller, b: any) {
    this.member(c);
    if (!recipientClass(c.roles)) throw roleRequired();
    if (!exactKeys(b, ACK_KEYS) || !uuidValue(b.requestId) || !positiveValue(b.revision)) throw invalid('요청 ID와 기준 revision을 확인하세요');
    this.expectOwner(c, b);
    if (!uuidValue(id)) throw recordMissing();
    const recordId = id.toLowerCase(), requestId = b.requestId.toLowerCase();
    const mark = ackFingerprint({ id: recordId, institution: c.institution, subject: c.sub, revision: b.revision });
    const known = await this.prisma.criticalResultReceipt.findUnique({ where: { requestId } });
    // 부류는 지금의 역할로 판정한다: 새 요청은 토큰 ∩ Keycloak, 재전송은 토큰(§4.2).
    const roles = known ? c.roles : await this.recheck(c, r => !!recipientClass(r));
    await this.studyAccess.prepare(c);
    return this.run(c, [], async tx => {
      const { row, state, head } = await this.writeTarget(tx, recordId, c, 'recipient');
      const cls = recipientClass(roles);
      const kase = recipientCase({ cls, visible: true, pin: row.sourceVersion, head, state, actor: c.actor });
      if (kase.view === null) throw recordMissing();
      const receipt = await tx.criticalResultReceipt.findUnique({ where: { requestId } });
      if (receipt) return this.replay(receipt, mark, recordId, 'ack', c);
      const replacedBy = row.state === 'superseded' ? await this.replacement(tx, row, { cls, state, head, actor: c.actor }) : null;
      const refusal = ackRefusal(row, b.revision, kase, replacedBy);
      if (refusal) throw refuse(refusal);
      const at = new Date();
      await tx.criticalResult.update({ where: { id: row.id }, data: { state: 'acknowledged', revision: 2, acknowledgedAt: at,
        changedBy: c.actor, updatedAt: at } });
      await this.event(tx, row.id, 2, 'acknowledged', c, this.name(c), cls, requestId, at);
      const applied = appliedResult({ id: row.id, studyUid: row.studyUid, requestId, action: 'ack', from: 'created', to: 'acknowledged', revision: 2, at });
      await this.receipt(tx, c, row.id, 'ack', mark, applied, at);
      await this.writeAudit(tx, c, row, { event: 'acknowledged', from: 'created', to: 'acknowledged', revision: 2, requestId, role: cls,
        supersedes: null, replacedBy: null });
      return { owner: this.owner(c), applied, replayed: false };
    });
  }

  // ── #7 취소 ──

  /** POST critical-results/:id/cancel. 발신자 본인, 사유 필수. 원천·수신자 사례와 무관하다(C2~C5 어느 때나). */
  async cancel(id: string, c: CriticalCaller, b: any) {
    this.member(c);
    if (!holds(c.roles, RADIOLOGIST)) throw roleRequired();
    if (!exactKeys(b, CANCEL_KEYS) || !uuidValue(b.requestId) || !positiveValue(b.revision) || !textValue(b.reason))
      throw invalid('요청 ID·기준 revision과 1~2,000자의 취소 사유를 입력하세요');
    this.expectOwner(c, b);
    if (!uuidValue(id)) throw recordMissing();
    const recordId = id.toLowerCase(), requestId = b.requestId.toLowerCase();
    const mark = cancelFingerprint({ id: recordId, institution: c.institution, subject: c.sub, revision: b.revision, reason: b.reason });
    const known = await this.prisma.criticalResultReceipt.findUnique({ where: { requestId } });
    if (!known) await this.recheck(c, roles => holds(roles, RADIOLOGIST));
    await this.studyAccess.prepare(c);
    return this.run(c, [], async tx => {
      const { row } = await this.writeTarget(tx, recordId, c, 'sender');
      const receipt = await tx.criticalResultReceipt.findUnique({ where: { requestId } });
      if (receipt) return this.replay(receipt, mark, recordId, 'cancel', c);
      const replacedBy = row.state === 'superseded' ? await this.replacement(tx, row, null) : null;
      const refusal = recordRefusal(row, b.revision, replacedBy);
      if (refusal) throw refuse(refusal);
      const at = new Date();
      await tx.criticalResult.update({ where: { id: row.id }, data: { state: 'cancelled', revision: 2, cancelledAt: at,
        cancelReason: b.reason, changedBy: c.actor, updatedAt: at } });
      await this.event(tx, row.id, 2, 'cancelled', c, this.name(c), RADIOLOGIST, requestId, at);
      const applied = appliedResult({ id: row.id, studyUid: row.studyUid, requestId, action: 'cancel', from: 'created', to: 'cancelled', revision: 2, at });
      await this.receipt(tx, c, row.id, 'cancel', mark, applied, at);
      await this.writeAudit(tx, c, row, { event: 'cancelled', from: 'created', to: 'cancelled', revision: 2, requestId, role: RADIOLOGIST,
        supersedes: null, replacedBy: null });
      return { owner: this.owner(c), applied, replayed: false };
    });
  }

  // ── #8 대체 ──

  /**
   * POST critical-results/:id/supersede. 지금 머리 판으로 같은 수신자에게 새 기록(id = requestId)을 만들고 옛 기록을
   * superseded로 닫는다. 옛 기록을 먼저 바꾼 뒤 새 기록을 넣는다 — 확인 대기 부분 unique는 문장마다 검사된다.
   */
  async supersede(id: string, c: CriticalCaller, b: any) {
    this.member(c);
    if (!holds(c.roles, RADIOLOGIST)) throw roleRequired();
    if (!exactKeys(b, SUPERSEDE_KEYS) || !uuidValue(b.requestId) || !positiveValue(b.revision) || !positiveValue(b.sourceVersion)
      || !textValue(b.message)) throw invalid('요청 ID·기준 revision·보낼 판 번호와 1~2,000자의 메시지를 입력하세요');
    this.expectOwner(c, b);
    if (!uuidValue(id)) throw recordMissing();
    const recordId = id.toLowerCase(), requestId = b.requestId.toLowerCase();
    const mark = supersedeFingerprint({ id: recordId, institution: c.institution, subject: c.sub, revision: b.revision,
      sourceVersion: b.sourceVersion, message: b.message });
    const known = await this.prisma.criticalResultReceipt.findUnique({ where: { requestId } });
    let recipient: KeycloakUser | null | undefined, identity: any = null, subject: Caller | null = null;
    let roster: Awaited<ReturnType<KeycloakService['usersInGroupWithRole']>> = [];
    if (!known) {
      await this.recheck(c, roles => holds(roles, RADIOLOGIST));
      // 수신자·검사·기록 기관은 옛 기록의 것이다. 남의 기록이거나 기록 기관이 지금 발신 범위가 아니면(tele 통로 닫힘
      // 포함) 아무것도 읽지 않고 트랜잭션이 404로 답한다.
      const prior = await this.prisma.criticalResult.findUnique({ where: { id: recordId },
        select: { institutionId: true, senderInstitutionId: true, senderSub: true, recipientSub: true, studyUid: true } });
      if (prior && prior.senderInstitutionId === c.institution && prior.senderSub === c.sub
        && await this.scope(prior.studyUid, c) === prior.institutionId) {
        recipient = await this.user(prior.recipientSub);
        identity = await this.identity(prior.studyUid);
        if (recipient?.roles.includes(RADIOLOGIST)) {
          roster = await this.preliminaryRoster(prior.studyUid, prior.institutionId);
          const current = roster.find(user => user.sub === prior.recipientSub);
          if (current) recipient = { ...recipient, email: current.id, username: current.username, firstName: current.name, lastName: '' };
        }
        if (recipient) {
          subject = this.subject(c, prior.institutionId, prior.recipientSub);
          await this.studyAccess.prepare(subject, [prior.studyUid]);
        }
      }
    }
    await this.studyAccess.prepare(c);
    return this.run(c, subject ? [subject] : [], async tx => {
      const { row, state, head } = await this.writeTarget(tx, recordId, c, 'sender');
      const receipt = await tx.criticalResultReceipt.findUnique({ where: { requestId } });
      if (receipt) return this.replay(receipt, mark, recordId, 'supersede', c);
      const replacedBy = row.state === 'superseded' ? await this.replacement(tx, row, null) : null;
      const refusal = recordRefusal(row, b.revision, replacedBy);
      if (refusal) throw refuse(refusal);
      const source = sourceRefusal({ sourceVersion: b.sourceVersion, head, senderReadable: legacyReadable(state, c.actor) });
      if (source) throw refuse(source);
      if (recipient === undefined || !identity || (recipient && recipient.id !== row.recipientSub)) throw unavailable();
      const cls = await this.judgeRecipient(tx, row.studyUid, row.institutionId, c, row.recipientSub, recipient, subject, head, state, roster);
      const at = new Date(), name = this.name(c);
      await tx.criticalResult.update({ where: { id: row.id }, data: { state: 'superseded', revision: 2, supersededAt: at,
        changedBy: c.actor, updatedAt: at } });
      await this.event(tx, row.id, 2, 'superseded', c, name, RADIOLOGIST, requestId, at);
      await this.writeAudit(tx, c, row, { event: 'superseded', from: 'created', to: 'superseded', revision: 2, requestId, role: RADIOLOGIST,
        supersedes: null, replacedBy: requestId });
      const record = this.newRecord({ id: requestId, uid: row.studyUid, institution: row.institutionId, senderInstitution: row.senderInstitutionId,
        c, name, recipient, cls, head, identity, message: b.message, supersedesId: row.id, at });
      await tx.criticalResult.create({ data: record });
      await this.event(tx, requestId, 1, 'created', c, name, RADIOLOGIST, requestId, at);
      await this.writeAudit(tx, c, record, { event: 'created', from: null, to: 'created', revision: 1, requestId, role: RADIOLOGIST,
        supersedes: row.id, replacedBy: null });
      const applied = appliedResult({ id: row.id, studyUid: row.studyUid, requestId, action: 'supersede', from: 'created', to: 'superseded',
        revision: 2, replacement: { id: requestId, revision: 1, sourceVersion: head.version }, at });
      await this.receipt(tx, c, row.id, 'supersede', mark, applied, at);
      return { owner: this.owner(c), applied, replayed: false };
    });
  }

  // ── 읽기 ──

  /**
   * 보낸 기록의 delivery(§3.3): 확인 대기 기록마다 지금 수신자가 받으면 무엇을 보는가. 수신자 Keycloak 사용자(같은 수신자는
   * 한 번)와 수신자 주체의 StudyAccess를 스냅샷 뒤에 읽는다. 자격과 주체의 기관은 기록 기관이다(tele 기록이면 A — 발신
   * 기관 B로 보면 A 수신자가 늘 not_eligible이 된다). 읽지 못하면 그 기록은 'unknown'이고 목록은 실패하지 않는다.
   */
  private async deliveries(c: Caller, rows: { row: any; head: Head; state: any }[]) {
    const out = new Map<string, string>();
    const byRecipient = new Map<string, { row: any; head: Head; state: any }[]>();
    for (const item of rows) if (item.row.state === 'created') {
      const list = byRecipient.get(item.row.recipientSub) ?? [];
      list.push(item);
      byRecipient.set(item.row.recipientSub, list);
    }
    for (const [sub, all] of byRecipient) {
      let user: KeycloakUser | null;
      try { user = await this.keycloak.getUser(sub); } catch { for (const x of all) out.set(x.row.id, 'unknown'); continue; }
      for (const institution of new Set<string>(all.map(x => x.row.institutionId))) {
        const items = all.filter(x => x.row.institutionId === institution);
        const cls = eligibleRecipient(user, { sub, institution, sender: c.sub });
        if (!cls) { for (const x of items) out.set(x.row.id, 'not_eligible'); continue; }
        let allowed: Set<string>;
        try { allowed = await this.studyAccess.allowed(this.subject(c, institution, sub), [...new Set(items.map(x => x.row.studyUid))]); }
        catch { for (const x of items) out.set(x.row.id, 'unknown'); continue; }
        for (const x of items) out.set(x.row.id, deliveryOf(recipientCase({ cls, visible: allowed.has(x.row.studyUid), pin: x.row.sourceVersion,
          head: x.head, state: x.state, actor: userActor(user) })));
      }
    }
    return out;
  }

  private static headOf(row: any): Head {
    return Number.isSafeInteger(row?.headVersion) && row.headVersion > 0 ? { version: row.headVersion, action: row.headAction ?? null } : null;
  }

  private static stateOf(row: any) { return { rs: row.rs, preDoc: row.preDoc ?? null, preReviewer: row.preReviewer ?? null }; }

  /**
   * GET critical-results. view=sent는 radiologist의 보낸 기록, view=received는 clinician·radiologist의 받은 기록이다. 목록은
   * 기록 기관과 **현재** 소유 기관을 JOIN하고, 제한 정책이면 허용 UID로 거르고, 받은 목록은 부류별 C5/R5를 같은 WHERE에서
   * LIMIT 전에 뺀다. 보낸 목록은 발신자 가시성(senderSees)과 같은 조건이다: 기록 시점 발신 기관 = caller 기관이고 기록
   * 기관이 caller 기관이거나 지금 통로가 caller 기관인 검사 — 통로가 닫히면 다음 읽기부터 목록과 pending에서 함께 빠진다.
   * 총계는 없고 pending(확인 대기 수)만 한 쪽과 같은 스냅샷에서 센다(RISK-S7-CVR-COUNT-LEAK).
   */
  async list(c: CriticalCaller, q: any) {
    this.member(c);
    const cls = recipientClass(c.roles);
    if (!cls) throw roleRequired();
    const query = isObject(q) ? q : {};
    if (Object.keys(query).some(k => !['view', 'state', 'cursor'].includes(k)) || Object.values(query).some(v => typeof v !== 'string')
      || !['sent', 'received'].includes(query.view)) throw invalid('목록 구분(view)을 확인하세요');
    const sent = query.view === 'sent';
    if (sent && !holds(c.roles, RADIOLOGIST)) throw roleRequired();
    const filter = query.state ?? 'all';
    if (!CRITICAL_RESULT_STATE_FILTERS.includes(filter)) throw invalid('상태 필터를 확인하세요');
    const stateValue = filter === 'pending' ? 'created' : filter;
    const access = await this.studyAccess.snapshot(c);
    const restricted = access.policy.restricted;
    // 제한 정책의 허용 UID는 caller 기관이 지금 볼 수 있는 검사(소유 또는 원격판독 통로) 가운데서 뽑는다 — 소유 검사만
    // 뽑으면 허용된 tele 검사의 보낸 기록이 빠진다. 받은 목록은 SQL이 기록 기관 = caller 기관으로 따로 거른다.
    const scope = restricted ? [...await this.studyAccess.allowed(c, (await this.prisma.studyState.findMany({
      where: { OR: [{ institutionId: c.institution }, { teleInstitutionId: c.institution }] }, select: { uid: true } })).map(s => s.uid))] : [];
    let cursor: { at: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      cursor = decodeCursor(query.cursor, access.revision);
      if (!cursor) throw invalid('목록 페이지를 확인하세요');
    }
    const before = cursor?.at ?? '9999-12-31T00:00:00.000Z', beforeId = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const clinician = cls === 'clinician';
    const { rows, pending } = await this.run(c, [], async tx => {
      if (sent) {
        const rows: any[] = await tx.$queryRaw`SELECT cr.*,rb.id AS "replacedById",s.ov,s.rs,s."preDoc",s."preReviewer",
            r.version AS "headVersion",hv.action AS "headAction"
          FROM "CriticalResult" cr JOIN "StudyState" s ON s.uid=cr."studyUid" AND s."institutionId"=cr."institutionId"
          LEFT JOIN "Report" r ON r.uid=cr."studyUid" LEFT JOIN "ReportVersion" hv ON hv.uid=r.uid AND hv.version=r.version
          LEFT JOIN "CriticalResult" rb ON rb."supersedesId"=cr.id
          WHERE cr."senderSub"=${c.sub} AND cr."senderInstitutionId"=${c.institution}
            AND (cr."institutionId"=${c.institution} OR s."teleInstitutionId"=${c.institution})
            AND (NOT ${restricted} OR cr."studyUid"=ANY(${scope}::text[]))
            AND (${stateValue}::text='all' OR cr.state::text=${stateValue}::text)
            AND (cr."createdAt",cr.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
          ORDER BY cr."createdAt" DESC,cr.id DESC LIMIT 51`;
        const counted: any[] = await tx.$queryRaw`SELECT count(*)::int AS pending
          FROM "CriticalResult" cr JOIN "StudyState" s ON s.uid=cr."studyUid" AND s."institutionId"=cr."institutionId"
          WHERE cr."senderSub"=${c.sub} AND cr."senderInstitutionId"=${c.institution}
            AND (cr."institutionId"=${c.institution} OR s."teleInstitutionId"=${c.institution})
            AND (NOT ${restricted} OR cr."studyUid"=ANY(${scope}::text[])) AND cr.state::text='created'`;
        return { rows, pending: counted[0]?.pending ?? 0 };
      }
      // 부류별 C5/R5: 고정 = 머리인데 C는 확정 원천이 아님, R은 P 짝 밖(§6.2). NULL이 행을 떨어뜨리지 않게 모든 항을 참/거짓으로 만든다.
      const rows: any[] = await tx.$queryRaw`SELECT cr.*,rb.id AS "replacedById",rb."sourceVersion" AS "replacedByVersion",s.ov,s.rs,
          s."preDoc",s."preReviewer",r.version AS "headVersion",hv.action AS "headAction",
          pv.findings AS "pinFindings",pv.conclusion AS "pinConclusion",pv.recommendation AS "pinRecommendation"
        FROM "CriticalResult" cr JOIN "StudyState" s ON s.uid=cr."studyUid" AND s."institutionId"=cr."institutionId"
        JOIN "ReportVersion" pv ON pv.uid=cr."studyUid" AND pv.version=cr."sourceVersion"
        LEFT JOIN "Report" r ON r.uid=cr."studyUid" LEFT JOIN "ReportVersion" hv ON hv.uid=r.uid AND hv.version=r.version
        LEFT JOIN "CriticalResult" rb ON rb."supersedesId"=cr.id
        WHERE cr."institutionId"=${c.institution} AND cr."recipientSub"=${c.sub}
          AND (NOT ${restricted} OR cr."studyUid"=ANY(${scope}::text[]))
          AND NOT (cr."sourceVersion"=COALESCE(r.version,0) AND CASE WHEN ${clinician}
            THEN NOT (s.rs='A' AND COALESCE(hv.action=ANY(ARRAY['approve','addendum']::text[]),false) AND COALESCE(r.version,0)>0)
            ELSE (s.rs='P' AND NOT (COALESCE(s."preDoc"=${c.actor},false) OR COALESCE(s."preReviewer"=${c.actor},false))) END)
          AND (${stateValue}::text='all' OR cr.state::text=${stateValue}::text)
          AND (cr."createdAt",cr.id)<((${before}::timestamptz AT TIME ZONE 'UTC'),${beforeId}::uuid)
        ORDER BY cr."createdAt" DESC,cr.id DESC LIMIT 51`;
      const counted: any[] = await tx.$queryRaw`SELECT count(*)::int AS pending
        FROM "CriticalResult" cr JOIN "StudyState" s ON s.uid=cr."studyUid" AND s."institutionId"=cr."institutionId"
        LEFT JOIN "Report" r ON r.uid=cr."studyUid" LEFT JOIN "ReportVersion" hv ON hv.uid=r.uid AND hv.version=r.version
        WHERE cr."institutionId"=${c.institution} AND cr."recipientSub"=${c.sub}
          AND (NOT ${restricted} OR cr."studyUid"=ANY(${scope}::text[]))
          AND NOT (cr."sourceVersion"=COALESCE(r.version,0) AND CASE WHEN ${clinician}
            THEN NOT (s.rs='A' AND COALESCE(hv.action=ANY(ARRAY['approve','addendum']::text[]),false) AND COALESCE(r.version,0)>0)
            ELSE (s.rs='P' AND NOT (COALESCE(s."preDoc"=${c.actor},false) OR COALESCE(s."preReviewer"=${c.actor},false))) END)
          AND cr.state::text='created'`;
      return { rows, pending: counted[0]?.pending ?? 0 };
    }, true);
    const page = rows.slice(0, CRITICAL_RESULT_PAGE), last = page[page.length - 1];
    const nextCursor = rows.length > CRITICAL_RESULT_PAGE ? encodeCursor(last.createdAt, last.id, access.revision) : null;
    if (sent) {
      const delivery = await this.deliveries(c, page.map(row => ({ row, head: CriticalResultService.headOf(row), state: CriticalResultService.stateOf(row) })));
      return { owner: this.owner(c), view: 'sent', items: page.map(row => senderView(row, CriticalResultService.headOf(row),
        studyIdentity(row, row.ov), delivery.get(row.id) ?? null, row.replacedById ?? null)), nextCursor, pending };
    }
    const items = page.map(row => {
      const head = CriticalResultService.headOf(row), state = CriticalResultService.stateOf(row);
      const kase = recipientCase({ cls, visible: true, pin: row.sourceVersion, head, state, actor: c.actor });
      const next = row.replacedById ? { id: row.replacedById, sourceVersion: row.replacedByVersion } : null;
      return recipientView(row, kase, studyIdentity(row, row.ov),
        { findings: row.pinFindings, conclusion: row.pinConclusion, recommendation: row.pinRecommendation },
        this.replacementOf(next, { cls, state, head, actor: c.actor }));
    });
    return { owner: this.owner(c), view: 'received', items, nextCursor, pending };
  }

  /**
   * GET critical-results/:id. 발신자면 발신자 투영(radiologist, 발신자 가시성 — tele 기록은 통로가 열린 동안만), 수신자면
   * 부류별 투영, 그 밖(같은 기관의 다른 회원, 통로 기관의 다른 회원 포함)은 404.
   */
  async read(id: string, c: CriticalCaller) {
    this.member(c);
    const cls = recipientClass(c.roles);
    if (!cls) throw roleRequired();
    if (!uuidValue(id)) throw recordMissing();
    await this.studyAccess.prepare(c);
    const out = await this.run(c, [], async tx => {
      const row = await this.recordRow(tx, id.toLowerCase(), false);
      if (!row) throw recordMissing();
      const state = await this.studyRow(tx, row.studyUid, false);
      const sender = holds(c.roles, RADIOLOGIST) && senderSees(row, state, c);
      if (!sender && !recipientSees(row, state, c)) throw recordMissing();
      try { await this.studyAccess.require(c, [row.studyUid], tx); }
      catch (e) { if (e instanceof NotFoundException) throw recordMissing(); throw e; }
      const head = await this.head(tx, row.studyUid);
      if (sender) return { sender: true as const, row, state, head, replacedBy: await this.replacement(tx, row, null) };
      const kase = recipientCase({ cls, visible: true, pin: row.sourceVersion, head, state, actor: c.actor });
      if (kase.view === null) throw recordMissing();
      const pinned = kase.view === 'full' ? await this.pinnedBody(tx, row.studyUid, row.sourceVersion) : null;
      const replacedBy = await this.replacement(tx, row, { cls, state, head, actor: c.actor });
      return { sender: false as const, item: recipientView(row, kase, studyIdentity(row, state.ov), pinned, replacedBy) };
    }, true);
    if (!out.sender) return { owner: this.owner(c), item: out.item };
    const delivery = await this.deliveries(c, [{ row: out.row, head: out.head, state: out.state }]);
    return { owner: this.owner(c), item: senderView(out.row, out.head, studyIdentity(out.row, out.state.ov), delivery.get(out.row.id) ?? null, out.replacedBy) };
  }

  /**
   * GET studies/:uid/critical-results. 한 검사에서 내가 보냈거나(radiologist) 받은 기록, 최신 50개(cursor 없음). 검사는
   * 지금 발신 범위(소유 또는 원격판독 통로)여야 하고 기록 기관은 그 범위의 기관이다. 보낸 기록은 기록 시점 발신 기관도
   * caller 기관이어야 하고, 받은 기록은 기록 기관 = caller 기관(소유 검사)뿐이다.
   */
  async forStudy(uid: string, c: CriticalCaller) {
    this.member(c);
    const cls = recipientClass(c.roles);
    if (!cls) throw roleRequired();
    if (!studyUidValue(uid)) throw invalid('검사 UID를 확인하세요');
    await this.studyAccess.prepare(c, [uid]);
    const radiologist = holds(c.roles, RADIOLOGIST);
    const out = await this.run(c, [], async tx => {
      const state = await this.studyRow(tx, uid, false);
      const institution = await this.visibleStudy(tx, uid, c, state, studyMissing);
      const head = await this.head(tx, uid);
      // 받은 기록의 C5/R5는 검사 하나라 머리 판·부류가 행마다 같다: 고정 = 머리인 행을 이 조건이면 뺀다.
      const hide = cls === 'clinician' ? !clinicianFinal(state.rs, head) : !legacyReadable(state, c.actor);
      const rows: any[] = await tx.$queryRaw`SELECT cr.*,rb.id AS "replacedById",rb."sourceVersion" AS "replacedByVersion",
          pv.findings AS "pinFindings",pv.conclusion AS "pinConclusion",pv.recommendation AS "pinRecommendation"
        FROM "CriticalResult" cr JOIN "ReportVersion" pv ON pv.uid=cr."studyUid" AND pv.version=cr."sourceVersion"
        LEFT JOIN "CriticalResult" rb ON rb."supersedesId"=cr.id
        WHERE cr."studyUid"=${uid} AND cr."institutionId"=${institution}
          AND ((${radiologist} AND cr."senderSub"=${c.sub} AND cr."senderInstitutionId"=${c.institution})
            OR (cr."recipientSub"=${c.sub} AND cr."institutionId"=${c.institution}
              AND NOT (cr."sourceVersion"=${head?.version ?? 0} AND ${hide})))
        ORDER BY cr."createdAt" DESC,cr.id DESC LIMIT 50`;
      return { state, head, rows };
    }, true);
    const mine = (row: any) => radiologist && row.senderSub === c.sub && row.senderInstitutionId === c.institution;
    const sentRows = out.rows.filter(mine);
    const delivery = await this.deliveries(c, sentRows.map(row => ({ row, head: out.head, state: out.state })));
    const study = (row: any) => studyIdentity(row, out.state.ov);
    const items = out.rows.map(row => {
      if (mine(row)) return senderView(row, out.head, study(row), delivery.get(row.id) ?? null, row.replacedById ?? null);
      const kase = recipientCase({ cls, visible: true, pin: row.sourceVersion, head: out.head, state: out.state, actor: c.actor });
      const next = row.replacedById ? { id: row.replacedById, sourceVersion: row.replacedByVersion } : null;
      return recipientView(row, kase, study(row), { findings: row.pinFindings, conclusion: row.pinConclusion, recommendation: row.pinRecommendation },
        this.replacementOf(next, { cls, state: out.state, head: out.head, actor: c.actor }));
    });
    return { owner: this.owner(c), uid, items };
  }
}
