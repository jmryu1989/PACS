/*
 * 검사 상태를 화면 모양으로 바꾸는 toClient, 판독문 초안 경계(작성자·세대·revision)의 요청 해석과 답 봉투, QIDO 개수,
 * hold 유효시간, 트랜잭션 오류 변환. 상태·IO가 없는 함수만 둔다 — 여러 concern이 같은 규칙을 한 곳에서 쓴다.
 */
import { canReadPreliminary } from '../preliminary-reader';
import { BadRequestException, ConflictException, GoneException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { citationArray } from '../report-citation';
import { structureArray } from '../report-structure';
import { draftDrawings } from '../image-report';
import { relatedInsertIdReused } from '../report-related-insert';
import type { Caller } from './access';

/**
 * QIDO 개수 태그(00201208 영상 수·00201206 시리즈 수)의 목록 값. 태그가 없거나
 * 정수가 아니면 `null`(unknown)이다. 예전 `+tag || 0`은 부재를 0으로 만들어 '영상 없음'과
 * '모름'을 섞었고, 그 뒤 실제 값이 오면 클라이언트가 0→n을 새 영상 도착으로 통지했다.
 * DICOM IS 형식(선택적 부호·앞뒤 공백)만 받고 음수·소수·지수·비유한값은 unknown이다.
 */
export function qidoCount(st: any, key: string): number | null {
  const raw = st?.[key]?.Value?.[0];
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\+?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
/**
 * CD-09-D: a study whose report was destroyed at the end of its retention (rs D) keeps its row - so a later reception
 * cannot bring it back as a new unread study and no version number starts again - and every report write, report read,
 * hold and deletion of it is refused here, after the caller's existing visibility check (it stays the 404/403 it was).
 */
export function refuseDestroyed(state: { rs?: string } | null | undefined): void {
  if (state?.rs === 'D') throw new GoneException({ code: 'REPORT_DESTROYED', message: '보존 기간이 끝나 판독문을 파기한 검사입니다' });
}
export function noteTransactionError(error: any): never {
  if (error?.code === 'P2028' || error?.code === 'P2010' && ['55P03', '57014'].includes(error?.meta?.code))
    throw new ServiceUnavailableException('검사 처리 중입니다. 잠시 후 최신 메모를 확인하고 다시 시도하세요');
  throw error;
}

/** JSON 문자열 컬럼 ↔ 객체 변환. 서버가 깨진 값을 받아도 죽지 않게 감싼다. */
export const parse = (s?: string) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
export const dump = (o: any) => (o == null ? null : JSON.stringify(o));

/**
 * 점유 유효시간. 브라우저가 죽거나 탭이 닫히면 해제 요청이 오지 않는다.
 * "닫았을 때 해제"만 믿으면 검사가 영원히 잠긴다 — 그래서 시간으로도 푼다.
 * 프론트는 이보다 짧은 주기로 하트비트를 보내 점유를 갱신한다.
 */
const HOLD_TTL_MS = 5 * 60 * 1000;
export const holdAlive = (s: any) => s?.holder && s.heldAt && Date.now() - new Date(s.heldAt).getTime() < HOLD_TTL_MS;

/** FC-034 승인 뒤 수정 창의 끝 = 첫 승인 시각 + 24시간(고쳐도 다시 시작하지 않는다). 승인 시각을 모르면 null — 창이 없다. */
export const AMEND_WINDOW_MS = 24 * 3600 * 1000;
export function amendUntil(approvedAt: unknown): Date | null {
  if (!approvedAt) return null;
  const t = new Date(approvedAt as any).getTime();
  return Number.isFinite(t) ? new Date(t + AMEND_WINDOW_MS) : null;
}
const isoOrNull = (value: unknown) => {
  if (!value) return null;
  const t = new Date(value as any).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * The order fields the worklist's request columns read (ReqDate, ReqDept, ReqDoc, Pt Class), and nothing else of the order.
 */
export const ORDER_REQUEST_SELECT = { oid: true, reqAt: true, reqDept: true, reqDoc: true, ptClass: true } as const;
/** Patient class codes an order carries, shown as words. A code outside these is shown as it was stored. */
export const PATIENT_CLASS: Record<string, string> = { O: 'Outpatient', I: 'Inpatient', E: 'ER', ICU: 'ICU' };
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
/**
 * The worklist row's request columns. The matched order decides each value; without one (or for a study received for
 * tele-reading, whose order belongs to the owner) ReqDoc alone falls back to the study's own indexed DICOM tags,
 * Requesting Physician (0032,1032) and then Referring Physician (0008,0090). ReqDate, ReqDept and Pt Class come only from
 * the order: the list cannot read non-indexed request tags cheaply. A missing value is null, never a guess.
 */
export function requestColumns(order: { reqAt?: unknown; reqDept?: unknown; reqDoc?: unknown; ptClass?: unknown } | null | undefined,
  dicom: { requestingPhysician?: string | null; referringPhysician?: string | null } = {}) {
  const ptClass = text(order?.ptClass);
  // A DICOM person name separates its components with '^'; the list shows them with spaces, as it does the patient name.
  const person = (value: unknown) => text(typeof value === 'string' ? value.replace(/\^+/g, ' ') : null);
  return {
    reqDate: isoOrNull(order?.reqAt),
    reqDept: text(order?.reqDept),
    reqDoc: text(order?.reqDoc) ?? person(dicom.requestingPhysician) ?? person(dicom.referringPhysician),
    ptClass: ptClass === null ? null : PATIENT_CLASS[ptClass.toUpperCase()] ?? ptClass,
  };
}

/**
 * A shared study grants access to the report, not the other institution's writer identity.
 * Keep the existing nonempty holder contract so clients still block conflicting writes.
 * Unknown legacy affiliations fail closed; only an authenticated hold heartbeat can fill them.
 */
export function visibleHolder(s: any, caller: Caller): string | null {
  if (!s?.holder) return null;
  return s.holder === caller.actor || (caller.institution && s.holderInstitutionId === caller.institution)
    ? s.holder : s.holderInstitutionId ? '다른 기관' : '작성자 비공개';
}

// ReportDraft and its discarded safety copies have no recorded affiliation.
// Neither the study owner nor a current holder proves who wrote those drafts.
export const visibleDraftAuthor = (author: string, caller: Caller): string => author === caller.actor ? author : '작성자 비공개';
export const visibleDraftSummary = (drafts: any[], caller: Caller) =>
  drafts.map(draft => ({ ...draft, author: visibleDraftAuthor(draft.author, caller) }));

export function reportHeld(s: any, caller: Caller): ConflictException {
  const holder = visibleHolder(s, caller);
  const writer = holder === '다른 기관' ? '다른 기관 판독의가'
    : holder === '작성자 비공개' ? '비공개 작성자가' : `${holder} 님이`;
  return new ConflictException({ code: 'REPORT_HELD', holder, message: `${writer} 판독 중입니다` });
}

/**
 * Preliminary(RS=P) 판독문을 이 사람이 볼 수 있는가.
 *
 * 예비 판독은 **아직 확정되지 않은 소견**이다. 상급 판독의가 뒤집을 수 있는 내용이
 * 기관 전체에 퍼지면, 나중에 정정해도 이미 읽은 사람의 머릿속까지 정정되지는 않는다.
 * 그래서 작성자와 지정된 상급자만 본다. (HPACS 매뉴얼 7.4.1.3-4.1)
 *
 * 검사 자체는 워크리스트에 그대로 보인다 — 가리는 건 판독문 내용뿐이다.
 * 검사를 통째로 숨기면 "그 검사 어디 갔냐"가 되고, 그건 다른 종류의 사고다.
 */


/**
 * 프론트가 그대로 쓸 수 있는 모양으로 되돌린다 (main.html의 appState 한 칸과 같은 구조)
 *
 * `d`는 **이 호출자 본인의 초안**이다. 남의 초안은 절대 실어 보내지 않는다 —
 * 초안은 아직 진술이 아니고, 확정되지 않은 소견이 퍼지면 나중에 뒤집어도
 * 이미 읽은 사람의 머릿속은 안 뒤집힌다 (RS=P를 가리는 것과 같은 이유).
 * 남이 쓰고 있다는 사실은 점유 표시(holder)가 이미 말해준다.
 */
export function toClient(s: any, r: any, caller: Caller, d: any = null) {
  const actor = caller.actor;
  const hidden = !canReadPreliminary(s, caller);
  return {
    rs: s.rs, ss: s.ss, em: s.em, ts: s.ts,
    matched: s.matched, ward: s.ward, reqHosp: s.reqHosp,
    institutionId: s.institutionId ?? null,
    teleInstitutionId: s.teleInstitutionId ?? null,
    /**
     * ── 아래 필드는 전부 `undefined`가 아니라 `null`이다 ──
     *
     * 클라이언트는 `{...기존, ...응답}`으로 상태를 병합한다. 그런데 `JSON.stringify`는
     * undefined 키를 **통째로 지운다.** 키가 없으면 스프레드가 이전 값을 못 덮으므로
     * "이 값은 비워졌다"는 사실이 영영 전달되지 않는다.
     *
     * 실제로 이 실수를 두 번 했다. 처음엔 `holder`에서(인계문서 §8), 이번엔 나머지
     * 전부에서. 결과는 **매칭을 해제했는데 화면엔 남의 환자 이름이 그대로 남고**,
     * **승인이 끝났는데 판독문이 계속 잠긴 것처럼 보이는 것**이었다.
     *
     * 비움도 값이다. 값이 사라졌다는 것도 전송해야 한다.
     */
    preDoc: s.preDoc ?? null, preReviewer: s.preReviewer ?? null,
    // 화면이 "왜 비어 있는지" 말할 수 있어야 한다. 빈 판독문과 가려진 판독문은 다르다.
    prelimHidden: hidden,
    repDoc: s.repDoc ?? null, confirm: s.confirm ?? null,
    /**
     * FC-034 지금 승인 회차: 승인 시각, 수정 창의 끝(승인 + 24시간), 마지막 수정·Addendum 시각, 그리고 창 안 수정이
     * 내 것인지(`amendMine`). 승인자의 sub 자체는 내보내지 않는다. 승인 시각을 모르는 옛 승인본은 모두 null/false다 —
     * 화면은 그것을 "24시간 지남"으로 말하지 않는다. 최종 판정은 언제나 서버의 commitReport다.
     */
    approvedAt: s.rs === 'A' ? isoOrNull(s.approvedAt) : null,
    amendUntil: s.rs === 'A' ? isoOrNull(amendUntil(s.approvedAt)) : null,
    amendedAt: s.rs === 'A' ? isoOrNull(s.amendedAt) : null,
    addendumAt: s.rs === 'A' ? isoOrNull(s.addendumAt) : null,
    amendMine: s.rs === 'A' && !!s.approvedBySub && s.approvedBySub === caller.sub,
    ov: parse(s.ov) ?? null, orig: parse(s.orig) ?? null,
    oid: s.orderOid ?? null,
    // 만료된 점유는 없는 것으로 내보낸다. 화면이 유령 자물쇠를 그리지 않게.
    // undefined가 아니라 null인 이유: JSON.stringify는 undefined 키를 통째로 지운다.
    // 키가 사라지면 클라이언트의 `{...기존, ...응답}` 이 이전 점유자를 그대로 남긴다.
    // "값을 비웠다"는 사실도 전송되어야 한다.
    holder: holdAlive(s) ? visibleHolder(s, caller) : null,
    holdReason: s.holdReason ?? null,
    version: r?.version ?? 0,
    // 머리 판의 글을 확정한 사람(본문이 있을 때만). 그 판의 작성자로 이력에 이미 보이는 사실이다 — 화면이 "남이 Save해 둔
    // 진행 중 판독"을 알아 되돌리기(FC-040)를 연다.
    savedBy: !hidden && r && (r.findings || r.conclusion || r.recommendation) ? r.updatedBy ?? null : null,
    findings: hidden ? '' : (r?.findings ?? ''),
    conclusion: hidden ? '' : (r?.conclusion ?? ''),
    recommendation: hidden ? '' : (r?.recommendation ?? ''),
    /**
     * 내가 쓰다 만 초안. 없으면 `undefined`가 아니라 `null`이다 —
     * 클라이언트가 `{...기존, ...응답}`으로 병합하므로, 키가 없으면 "초안이 사라졌다"가
     * 전달되지 않아 확정한 뒤에도 옛 초안이 화면에 계속 남는다. (§14 — 비움도 값이다)
     * 비운 초안의 행(present=false)은 초안이 아니다 — 경계(revision)만 남긴 자리다.
     */
    draft: (hidden || !d || !d.present) ? null : {
      findings: d.findings, conclusion: d.conclusion, recommendation: d.recommendation,
      baseVersion: d.baseVersion, at: d.updatedAt,
    },
    // 초안이 없어도 내 경계는 나간다(S7-U5): 다음 쓰기가 무엇을 보고 쓰는지 말할 수 있어야 한다.
    draftRevision: draftToken(s.draftEpoch, d?.revision ?? 0),
    draftEpoch: s.draftEpoch,
  };
}

/**
 * ── S7-U5 초안 경계 (U5S-REQ-14..17) ──
 *
 * 작성자별 행이라 남과는 부딪히지 않지만 **자기 자신과는 부딪힌다**: 연결이 끊겨 답을 못 받은 앞선 쓰기, 다른 탭,
 * 다시 로그인한 같은 계정. 그래서 모든 초안 변경은 자기가 본 경계(검사의 세대 + 내 revision)를 함께 보내고, 저장된
 * 경계와 같을 때만 적용된다. 경계는 불투명한 문자열 하나(`세대:revision`)로 나간다 — `Report.version`과 무관하다.
 * 작성자(`expectedOwner`)는 대조에만 쓴다. 권한과 작성자는 언제나 인증된 호출자에서 정한다.
 */
const DRAFT_EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DRAFT_TOKEN = /^([0-9a-f-]{36}):(0|[1-9][0-9]{0,9})$/;
const DRAFT_PREPARE_MS = 5000;
export const draftToken = (epoch: string, revision: number) => `${epoch}:${revision}`;

const draftRequired = (field: string) => new BadRequestException({ code: 'REPORT_DRAFT_PRECONDITION_REQUIRED', field,
  message: `판독문 초안 요청에 ${field} 값이 없습니다. 화면을 새로 고친 뒤 다시 시도하세요.` });
const draftInvalid = (field: string) => new BadRequestException({ code: 'REPORT_DRAFT_PRECONDITION_INVALID', field,
  message: `판독문 초안 요청의 ${field} 값이 잘못되었습니다. 화면을 새로 고친 뒤 다시 시도하세요.` });
export const draftConflict = () => new ConflictException({ code: 'REPORT_DRAFT_CONFLICT',
  message: '판독문 초안이 그 사이 다른 저장·비우기·확정으로 바뀌었습니다. 이 글은 저장하지 않았습니다 — 최신 상태를 확인한 뒤 다시 저장하세요.' });
const draftUnavailable = () => new ServiceUnavailableException({ code: 'REPORT_DRAFT_UNAVAILABLE',
  message: '판독문 초안을 제때 처리하지 못했습니다. 저장되지 않았습니다 — 최신 상태를 확인한 뒤 다시 시도하세요.' });

export interface DraftOwner { institution: string; sub: string; author: string }

/** `expectedOwner`의 모양과 인증된 호출자와의 일치. 어떤 읽기보다 먼저 본다 — 거절은 아무것도 읽거나 쓰지 않는다. */
export function draftOwner(body: any, c: Caller): DraftOwner {
  const owner = body?.expectedOwner;
  if (owner === undefined || owner === null) throw draftRequired('expectedOwner');
  if (typeof owner !== 'object' || Array.isArray(owner) || Object.keys(owner).length !== 3
      || typeof owner.institution !== 'string' || typeof owner.sub !== 'string' || typeof owner.author !== 'string')
    throw draftInvalid('expectedOwner');
  if (owner.institution !== c.institution || owner.sub !== c.sub || owner.author !== c.actor)
    throw new ConflictException({ code: 'REPORT_DRAFT_OWNER_CHANGED',
      message: '판독문 초안을 쓰던 계정이 아닙니다. 그 계정으로 다시 로그인한 뒤 저장하세요.' });
  return { institution: owner.institution, sub: owner.sub, author: owner.author };
}

export function draftEpochOf(value: unknown, field: string): string {
  if (value === undefined || value === null) throw draftRequired(field);
  if (typeof value !== 'string' || !DRAFT_EPOCH.test(value)) throw draftInvalid(field);
  return value;
}

export function draftExpected(body: any): { epoch: string; revision: number } {
  const token = body?.expectedRevision;
  if (token === undefined || token === null) throw draftRequired('expectedRevision');
  const parts = typeof token === 'string' ? DRAFT_TOKEN.exec(token) : null;
  if (!parts || !DRAFT_EPOCH.test(parts[1]) || Number(parts[2]) > 2147483647) throw draftInvalid('expectedRevision');
  return { epoch: parts[1], revision: Number(parts[2]) };
}

/** PUT이 싣는 전체 스냅숏의 모양. 칸이 빠진 요청은 "그대로 두라"가 아니라 거절이다 — 모르는 것을 지우거나 남기지 않는다. */
export function draftSnapshotInput(body: any) {
  for (const field of ['findings', 'conclusion', 'recommendation']) {
    if (body?.[field] === undefined || body[field] === null) throw draftRequired(field);
    if (typeof body[field] !== 'string') throw draftInvalid(field);
  }
  if (body.baseVersion === undefined || body.baseVersion === null) throw draftRequired('baseVersion');
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0 || body.baseVersion > 2147483647)
    throw draftInvalid('baseVersion');
  for (const field of ['citationIds', 'structureIds']) {
    if (body[field] === undefined || body[field] === null) throw draftRequired(field);
    if (!Array.isArray(body[field]) || !body[field].every((id: unknown) => typeof id === 'string')) throw draftInvalid(field);
  }
  // Image Report: the drawing ids the screen knows this draft holds. Optional - absent means "not compared"; a write never
  // changes the drawings without its own attach / remove operation.
  if (body.drawingIds !== undefined && (!Array.isArray(body.drawingIds) || !body.drawingIds.every((id: unknown) => typeof id === 'string')))
    throw draftInvalid('drawingIds');
  return { findings: body.findings as string, conclusion: body.conclusion as string,
    recommendation: body.recommendation as string, baseVersion: body.baseVersion as number };
}

/** 저장된 행의 표준 스냅숏. 인용·구조화는 식별자만 — 전문은 소견 가독을 다시 거는 전용 읽기로만 나간다. */
function draftSnapshot(row: any) {
  if (!row?.present) return null;
  return { findings: row.findings, conclusion: row.conclusion, recommendation: row.recommendation,
    baseVersion: row.baseVersion,
    citations: citationArray(row.citations).map(entry => String(entry?.cid ?? '')),
    structured: structureArray(row.structured).map(entry => String(entry?.sid ?? '')),
    // Image Report: only a draft that attached or removed a drawing names its drawing ids (the rest read as before).
    ...(draftDrawings(row.drawings) ? { drawings: draftDrawings(row.drawings)!.ids } : {}) };
}

/** 초안 변경·권위 있는 읽기의 답 봉투. `saved`는 이 봉투 전체가 보낸 것과 같을 때만이다. */
export function draftEnvelope(uid: string, owner: DraftOwner, epoch: string, row: any) {
  return { uid, owner, revision: draftToken(epoch, row?.revision ?? 0), present: !!row?.present,
    snapshot: draftSnapshot(row), updatedAt: row?.present ? row.updatedAt : null };
}

/**
 * B2가 판정한 이 트랜잭션의 COMMIT(emr-runtime/store.ts LedgerFailure). change는 초안 변경과 그 기록이 한 트랜잭션인 경우로,
 * 커밋되지 않음은 저장되지 않음이다. 확인하지 못함(CommitUnknown)은 저장되지 않았다고 하지 않는다.
 * 입력과 고정 요청 ID·revision은 화면에 남고, 다시 읽기(Check)가 서버 상태를 정한다.
 */
const DRAFT_LEDGER = {
  change: {
    AppendNotCommitted: { code: 'REPORT_DRAFT_NOT_COMMITTED',
      message: '판독문 변경이 서버에 저장되지 않았습니다. 입력한 내용은 이 화면에 남아 있습니다 — 다시 시도하세요.' },
    CommitUnknown: { code: 'REPORT_DRAFT_COMMIT_UNKNOWN',
      message: '판독문 변경이 서버에 저장됐는지 아직 확인하지 못했습니다. 입력한 내용은 이 화면에 남아 있고, 저장된 상태를 다시 불러와 확인합니다.' },
  },
} as const;
const DRAFT_COMMIT_CODES: readonly unknown[] = [DRAFT_LEDGER.change.AppendNotCommitted.code, DRAFT_LEDGER.change.CommitUnknown.code];

/** B2의 COMMIT 판정이면 초안 변경의 503을 던진다. 그 밖의 오류는 그대로 둔다(호출한 쪽이 이어서 다룬다). */
export function draftLedgerError(error: any): void {
  if (error?.code === 'AppendNotCommitted' || error?.code === 'CommitUnknown')
    throw new ServiceUnavailableException(DRAFT_LEDGER.change[error.code as 'AppendNotCommitted' | 'CommitUnknown']);
}

/**
 * 이미 읽은 초안 상태(GET draft·Check·Related 영수증 답·거절에 실린 상태)를 보내기 전의 열람 기록이 커밋되지 않았거나 확인되지
 * 않았을 때(B6, 2026-11-05 축소): 그 상태는 그대로 보내고 기록 실패만 `accessRecord`로 알린다. 의료법 제23조④는 열람 기록의
 * 보관을 요구할 뿐 기록하지 못한 열람을 막으라고 하지 않는다. 실패한 기록의 사실(누가·무엇·언제)과 원인은 B2가 그 열람 사건에
 * 실패 journal로 이미 남겼다. B2의 COMMIT 판정이 아니면 null — 그 오류는 원래대로 던진다.
 */
export function draftAccessRecord(error: any): 'not-recorded' | 'unknown' | null {
  return error?.code === 'AppendNotCommitted' ? 'not-recorded' : error?.code === 'CommitUnknown' ? 'unknown' : null;
}

/** 열람 기록에 실패한 거절: 같은 상태 번호와 본문에 `accessRecord`만 더한다. 본문이 객체가 아닌 거절은 그대로 둔다. */
export function withAccessRecord(error: any, accessRecord: 'not-recorded' | 'unknown'): any {
  const body = error instanceof HttpException ? error.getResponse() : null;
  return body && typeof body === 'object' ? new HttpException({ ...body, accessRecord }, error.getStatus()) : error;
}

/** 초안 변경 트랜잭션의 COMMIT이 커밋되지 않았거나 확인되지 않은 답(변환 전후 모두). 종료 판정(settleEnding)이 일반 거절과 가른다. */
export function draftCommitFailure(error: any): boolean {
  if (error?.code === 'AppendNotCommitted' || error?.code === 'CommitUnknown') return true;
  return DRAFT_COMMIT_CODES.includes(error?.getResponse?.()?.code);
}

/** 트랜잭션 획득·잠금·제한 시간 초과. 한도를 넘긴 요청은 끝없이 기다리지 않고 저장되지 않은 채 503으로 끝난다. */
export function draftTransactionError(error: any): never {
  draftLedgerError(error);
  if (error?.code === 'P2028' || error?.code === 'P2034'
      || error?.code === 'P2010' && ['55P03', '57014', '40P01'].includes(error?.meta?.code))
    throw draftUnavailable();
  // 초안 행의 PK 충돌은 같은 경계에서 두 쓰기가 첫 행을 만들려 한 것이다 — 진 쪽은 충돌이다.
  if (error?.code === 'P2002' && error?.meta?.modelName === 'ReportDraft') throw draftConflict();
  // W5 삽입 영수증의 PK 충돌: 같은 Target의 같은 ID는 검사 행 잠금에서 줄을 서므로, 이 경합은 다른 Target(또는 owner)이 같은
  // ID를 먼저 쓴 것이다. 그 행의 내용도, 이 요청이 적용되지 않았다는 단정도 답하지 않는다 — 진 쪽은 아무것도 남기지 않았다.
  if (error?.code === 'P2002' && error?.meta?.modelName === 'ReportDraftInsertReceipt') throw relatedInsertIdReused();
  throw error;
}

/** 외부 준비(원본 조회·계정 조회)는 트랜잭션 밖에서, 유한하게. 넘기면 저장하지 않고 끝낸다. */
export async function draftBounded<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(draftUnavailable()), DRAFT_PREPARE_MS);
  });
  // 한도 뒤에 늦게 실패한 준비는 이미 답한 요청의 것이다 — 처리되지 않은 거절로 남기지 않는다.
  work.catch(() => undefined);
  try { return await Promise.race([work, limit]); }
  finally { clearTimeout(timer); }
}
