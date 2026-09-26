import { StudyAccessService } from './study-access.service';
import type { AccessSnapshot } from './study-access.service';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { OrthancService } from './orthanc.service';
import { KeycloakService } from './keycloak.service';
import { FindingService } from './finding.service';
import { canonical, viewerUid } from './viewer-input';
import { CLINICIAN_ROLE, clinicianFinal, clinicianKeyImage, clinicianList, clinicianListChanged, clinicianOnly,
  clinicianReport } from './clinician-policy';
import { applyKeepList, blockIsBlank, citationArray, citationIdList, citationInsertInput, citationSourceRef,
  citationUnion, CitationInputError, lineBlockOccurrences, presenceState, projectCitation, sameTextCounts,
  REPORT_CITATION_FIELDS, REPORT_CITATION_LIMITS, REPORT_CITATION_SCHEMA, SOURCE_UNAVAILABLE } from './report-citation';
import { applyStructureKeepList, commitStructureSelection, isStructureEntry, projectStructure, structureApplyInput,
  structureArray, structureIdList, structureItemKey, structureSameTextCounts, structureUnion,
  StructureInputError, STRUCTURE_CATALOG, REPORT_STRUCTURE_LIMITS, REPORT_STRUCTURE_SCHEMA,
  validateCatalog } from './report-structure';
import type { StructureTemplate } from './report-structure';
import { SEED_INSTITUTIONS, SEED_ORDERS, SEED_TEMPLATES } from './seed';
import { normalizeWorklistColumns } from './worklist-columns';
import { studyPageQuery, studyPageSlice } from './study-page';
import { reconcileOrders } from './order-reconciliation';
import { ORDER_IDENTITY_SELECT, orderIdentity, overlayShape, OVERLAY_RULE_TEXT } from './study-identity';
import { decideGatewayReceipt, GATEWAY_EPOCH_INCIDENT_WINDOW_MS, GatewayReceiptInputError, parseGatewayReceipt,
  projectGatewayReceipt, storedGatewayReceipt } from './gateway-receipt';
import type { GatewayReceipt, GatewayReceiptDecision } from './gateway-receipt';
import { decideGatewayRetryRequest, GATEWAY_RETRY_BUSY, GATEWAY_RETRY_INVALID, GATEWAY_RETRY_NOT_RETRY,
  GATEWAY_RETRY_POLL_INVALID, GATEWAY_RETRY_UNSUPPORTED_F01, GatewayRetryInputError, parseGatewayRetryPoll,
  parseGatewayRetryRequestBody } from './gateway-retry';
import { folderAction, folderEntries, folderPath } from './filter-folders';
import { copySearchFolder, mergeCopiedFolders, sharedKeys, sharedLibrary, sharedSearch } from './shared-filters';
import { normalizeHangingProtocol } from './hanging-protocol';
import type { HangingProtocolLibrary } from './hanging-protocol';

/**
 * 호출자. 다섯 필드 모두 **서명된 토큰**과 가드 판정에서 나온다 — 클라이언트가 정할 수 없다.
 *  sub         KC 사용자 ID    (세션 일괄 폐기 키)
 *  actor       누구인가        (감사로그)
 *  roles       무엇을 할 수 있나 (판독의/기사)
 *  institution 어디 소속인가    (어떤 데이터를 볼 수 있나)  ← 이번 작업에서 추가
 *  kind        사람인가 gateway인가 (허용되는 API 면)
 */
// ASR capability is optional; no engine URL or credentials leave the server.
import { asrConfiguration } from './asr.service';

export interface Caller {
  sub: string;
  actor: string;
  roles: string[];
  institution: string | null;
  kind: 'member' | 'gateway';
}

/**
 * 역할 검사. HPACS의 Radiology / Technician 두 탭이 그냥 화면 분리가 아니라
 * 권한 분리라는 것이 핵심 — 방사선사는 검사를 확인(Verify)하고 오더를 매칭하지만
 * 판독문을 승인하지 않는다. 판독의는 그 반대다.
 * admin은 둘 다 할 수 있다(개발·운영 편의).
 */
function need(roles: string[], role: string, what: string) {
  if (!roles?.includes(role) && !roles?.includes('admin'))
    throw new ForbiddenException(`${what}은(는) ${role} 권한이 필요합니다`);
}

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

/** Gateway 라우트에는 admin 예외가 없다. 신원 종류와 전용 역할이 모두 맞아야 한다. */
function needExact(c: Caller, role: string, what: string) {
  if (c.kind !== 'gateway' || !c.roles?.includes(role))
    throw new ForbiddenException(`${what}은(는) ${role} 전용입니다`);
}

/**
 * 소속 기관 확인.
 *
 * **admin에게도 예외를 주지 않는다.** 역할(role)은 "무엇을 할 수 있는가"이고
 * 기관은 "무엇을 볼 수 있는가"다. 둘은 다른 축이라, admin이라고 남의 병원 환자를
 * 보게 하면 그건 편의가 아니라 구멍이다. 운영자용 전역 조회가 정말 필요해지면
 * 그때 별도 경로로 만들고 감사로그를 남긴다.
 *
 * 기관이 비어 있으면 조용히 빈 목록을 주지 않고 **소리 내어 막는다.**
 * 매퍼 설정이 틀렸을 때 "검사가 하나도 없네" 로 보이면 그게 최악이다.
 */
function inst(c: Caller): string {
  if (!c.institution)
    throw new ForbiddenException(
      '소속 기관이 없는 계정입니다. Keycloak에서 이 사용자를 기관 그룹에 넣어주세요.');
  return c.institution;
}

const TECHNICIAN_FIELDS = ['ss', 'ward', 'reqHosp', 'em', 'ov'];

/**
 * 소유 기관 전용 감사 action(S5-U4p §11.1). 이 행은 `GET audit`의 두 경로 모두에서 생성 기관(detail.institution)
 * = 대상 검사의 **현재** 소유 기관 = caller 기관일 때만 나간다. 기존 action은 원격판독 기관에도 보이지만 질문은
 * 소유 기관 안의 대화라서, 질문 API가 404여도 감사 통로로 존재·행위자·전이가 새지 않게 한다. 한 action을 처음
 * 쓰는 단위가 여기에 이름을 더한다(S5-U4a: study.question, S5-U4c: study.image-request).
 */
export const OWNER_ONLY_AUDIT_ACTIONS: readonly string[] = Object.freeze(['study.question']);

const NOTE_PUBLIC_FIELDS = { studyUid: true, version: true, text: true, reason: true, author: true, createdAt: true } as const;
function noteTransactionError(error: any): never {
  if (error?.code === 'P2028' || error?.code === 'P2010' && ['55P03', '57014'].includes(error?.meta?.code))
    throw new ServiceUnavailableException('검사 처리 중입니다. 잠시 후 최신 메모를 확인하고 다시 시도하세요');
  throw error;
}

/** JSON 문자열 컬럼 ↔ 객체 변환. 서버가 깨진 값을 받아도 죽지 않게 감싼다. */
const parse = (s?: string) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const dump = (o: any) => (o == null ? null : JSON.stringify(o));

/**
 * 점유 유효시간. 브라우저가 죽거나 탭이 닫히면 해제 요청이 오지 않는다.
 * "닫았을 때 해제"만 믿으면 검사가 영원히 잠긴다 — 그래서 시간으로도 푼다.
 * 프론트는 이보다 짧은 주기로 하트비트를 보내 점유를 갱신한다.
 */
const HOLD_TTL_MS = 5 * 60 * 1000;
const holdAlive = (s: any) => s?.holder && s.heldAt && Date.now() - new Date(s.heldAt).getTime() < HOLD_TTL_MS;

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
function canReadPrelim(s: any, actor: string) {
  if (s?.rs !== 'P') return true;
  return s.preDoc === actor || s.preReviewer === actor;
}

/**
 * 프론트가 그대로 쓸 수 있는 모양으로 되돌린다 (main.html의 appState 한 칸과 같은 구조)
 *
 * `d`는 **이 호출자 본인의 초안**이다. 남의 초안은 절대 실어 보내지 않는다 —
 * 초안은 아직 진술이 아니고, 확정되지 않은 소견이 퍼지면 나중에 뒤집어도
 * 이미 읽은 사람의 머릿속은 안 뒤집힌다 (RS=P를 가리는 것과 같은 이유).
 * 남이 쓰고 있다는 사실은 점유 표시(holder)가 이미 말해준다.
 */
function toClient(s: any, r: any, actor = '', d: any = null) {
  const hidden = !canReadPrelim(s, actor);
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
    ov: parse(s.ov) ?? null, orig: parse(s.orig) ?? null,
    oid: s.orderOid ?? null,
    // 만료된 점유는 없는 것으로 내보낸다. 화면이 유령 자물쇠를 그리지 않게.
    // undefined가 아니라 null인 이유: JSON.stringify는 undefined 키를 통째로 지운다.
    // 키가 사라지면 클라이언트의 `{...기존, ...응답}` 이 이전 점유자를 그대로 남긴다.
    // "값을 비웠다"는 사실도 전송되어야 한다.
    holder: holdAlive(s) ? s.holder : null,
    holdReason: s.holdReason ?? null,
    version: r?.version ?? 0,
    findings: hidden ? '' : (r?.findings ?? ''),
    conclusion: hidden ? '' : (r?.conclusion ?? ''),
    recommendation: hidden ? '' : (r?.recommendation ?? ''),
    /**
     * 내가 쓰다 만 초안. 없으면 `undefined`가 아니라 `null`이다 —
     * 클라이언트가 `{...기존, ...응답}`으로 병합하므로, 키가 없으면 "초안이 사라졌다"가
     * 전달되지 않아 확정한 뒤에도 옛 초안이 화면에 계속 남는다. (§14 — 비움도 값이다)
     */
    draft: (hidden || !d) ? null : {
      findings: d.findings, conclusion: d.conclusion, recommendation: d.recommendation,
      baseVersion: d.baseVersion, at: d.updatedAt,
    },
  };
}

/**
 * **서명 순간에 새로 생기는 유일한 거절이다.**
 *
 * 삽입 시점의 한도 검사는 머리 판을 잠그지 않고 읽으므로 예방적일 뿐이다 — 그 뒤 머리가
 * 움직였거나 옛 탭이 유지 목록을 보내지 않았으면 확정에서 합집합이 한도를 넘을 수 있다.
 * 그때 트랜잭션을 되돌린다: 초안과 인용은 그대로 남고, 출구는 **제거**다. 그래서 문구가
 * 그 출구를 분명히 말해야 한다.
 *
 * 문구에 `저장했습니다`를 넣지 않는다. 옛 탭은 그 부분 문자열로 분기해 서버 내용을
 * 편집기에 덮어쓰는 복구 경로로 들어간다 — 쓰던 글을 잃는다(R2와 같은 규칙).
 */
const citationLimit = () => {
  throw new ConflictException({ code: 'REPORT_CITATION_LIMIT',
    message: `인용이 한도(${REPORT_CITATION_LIMITS.entries}건 · ${REPORT_CITATION_LIMITS.bytes}바이트)를 넘습니다 — ` +
      '인용을 일부 제거한 뒤 다시 확정해 주세요' });
};

/** 마이그레이션이 두 칸에 건 이름. 이 이름이 보일 때만 우리 CHECK다. */
const CITATION_CHECKS = ['ReportDraft_citations_check', 'ReportVersion_citations_check'];

/**
 * 구조화 칸의 CHECK도 같은 백스톱이다. 이름을 따로 두는 이유는 **어느 한도를 넘었는지**
 * 사용자에게 말해야 하기 때문이다 — 구조화 항목을 지우라는 안내와 인용을 지우라는 안내는
 * 서로 할 수 있는 일이 다르다.
 */
const STRUCTURE_CHECKS = ['ReportDraft_structured_check', 'ReportVersion_structured_check'];

const structureLimit = () => {
  throw new ConflictException({ code: 'REPORT_STRUCTURE_LIMIT',
    message: `구조화 항목이 한도(${REPORT_STRUCTURE_LIMITS.entries}건 · ${REPORT_STRUCTURE_LIMITS.bytes}바이트)를 넘습니다 — ` +
      '항목을 일부 제거한 뒤 다시 시도해 주세요' });
};

function isStructureCheck(error: any): boolean {
  const meta: any = error?.meta ?? {};
  const text = [meta.constraint, meta.message, meta.detail, error?.message].filter(Boolean).join(' ');
  return STRUCTURE_CHECKS.some(name => text.includes(name));
}

/**
 * DB CHECK는 fail-closed 백스톱이지 서버 고장이 아니다. 500으로 내보내면 사용자는
 * "다시 해보세요" 말고 할 수 있는 게 없고, 실제로 필요한 행동(제거)을 못 듣는다.
 *
 * **좁게 본다.** 드라이버가 이 위반을 어떤 클래스로 올리는지는 실제 PostgreSQL에서만
 * 확인되므로(선례 `finding.service.ts:124`는 원시 질의의 `P2010`/`23514`를 보지만, 여기 세
 * 경로는 Prisma Client 호출이다) 코드 모양이 아니라 **우리가 지은 제약 이름**으로 가른다.
 * 이름이 없으면 우리 것이라고 단정하지 않고 그대로 올려보낸다 — 다른 DB 오류를 삼키면
 * 진짜 고장이 "인용을 제거하세요"로 위장된다.
 */
function isCitationCheck(error: any): boolean {
  const meta: any = error?.meta ?? {};
  const text = [meta.constraint, meta.message, meta.detail, error?.message].filter(Boolean).join(' ');
  return CITATION_CHECKS.some(name => text.includes(name));
}

/**
 * PATCH로 바꿀 수 있는 필드.
 *
 * **`rs`·`repDoc`·`confirm`이 여기 없는 것이 핵심이다.**
 * 예전엔 있었고, 그래서 `PATCH {rs:"T"}` 한 번으로 예비 판독(RS=P) 잠금이 풀렸다.
 * 판독문에 걸어둔 관문 네 개(저장·확정·점유·이력)를 전부 우회하는 창문이었다.
 *
 * RS는 단순한 컬럼이 아니라 **판독문의 생애주기**다. 상태가 바뀔 때마다 판(version)이
 * 쌓이고, 승인자가 기록되고, 취소에는 사유가 남아야 한다. 그건 `commitReport`가
 * 트랜잭션으로 하는 일이고, 여기서 필드 하나 바꾸듯 할 수 있는 일이 아니다.
 * `repDoc`·`confirm`도 승인의 결과이지 클라이언트가 정할 값이 아니다.
 */
const STATE_FIELDS = ['ss', 'em', 'ts', 'ward', 'reqHosp'];
/** 전용 경로가 소유한 필드들. PATCH로 오면 조용히 무시하지 않고 소리 내어 막는다.
 * matched·orig는 /match·/unmatch의 Order+Study 원자 트랜잭션만이 쓴다. */
const REPORT_OWNED_FIELDS = ['rs', 'repDoc', 'confirm', 'matched', 'orig', 'holdReason'];

/** 원격판독 상태머신. 어느 쪽 기관이 이 전이를 일으킬 수 있는가가 핵심이다. */
const TELE_BY_OWNER = ['none', 'wait', 'sending', 'sent', 'cancelled', 'fail'];  // 의뢰 기관이 미는 구간
const TELE_BY_RECEIVER = ['inReading', 'completed'];                             // 수신 기관이 미는 구간
/** 통로가 닫히는 상태 — 여기로 가면 수신 기관은 검사를 더 못 본다 */
const TELE_CLOSED = ['none', 'cancelled'];
/** 화면의 실제 버튼 흐름과 같은 전이만 허용한다. 역행·건너뛰기는 데이터 조작이다. */
const TELE_NEXT: Record<string, string[]> = {
  none: ['wait'], wait: ['sending', 'cancelled'], sending: ['sent', 'fail', 'cancelled'],
  sent: ['inReading', 'cancelled'], inReading: ['completed', 'cancelled'],
  completed: [], cancelled: ['wait'], fail: ['wait', 'cancelled'],
};

/**
 * ── S5-U6b 관리자 운영 지표 (REQ-S5-U6b-OPS-METRICS → RISK-S5-U6b-UNKNOWN-AS-ZERO/INVENTED-THRESHOLD/TENANT-AGGREGATE) ──
 *
 * 한 줄은 값과 함께 **출처·관측 시각·단위·분모·범위**를 싣는다. 값을 모르면 `value: null`이고 `state`가 이유를
 * 말한다 — 0은 원천이 실제로 0을 말했을 때만 나간다. 수집 실패가 0으로 보이면 관리자는 "비어 있다"와 "모른다"를
 * 가를 수 없다(main.html `#storage`의 기본값 '0.0GB / -'가 그 반례다).
 *  observed      원천이 답했고 값이 있다
 *  empty         원천은 답했지만 대상이 0건이라 중앙값·최댓값이 없다 — 0분이 아니다
 *  unobservable  원천이 실패했거나(source_failed·invalid_answer·timeout) 제품에 원천이 없다(no_source)
 * 임계값·정상/이상 판정은 싣지 않는다. 출처 있는 사이트 설정이 없다(C-7 — 목업의 30/240분은 원천이 아니다).
 * 대기·TAT의 입력은 사람이 입력한 Emergency 표시(em)와 서버 시각뿐이고, 영상·판독 본문·외부 결과는 읽지 않는다
 * (UXR-S5-17). 서버 전체 값은 Orthanc 저장량 하나뿐이고(D11), 기관별 저장량은 원천이 없어 늘 관측 불가다.
 */
export const ADMIN_METRIC_KEYS = Object.freeze([
  'storage.server', 'storage.institution', 'studies.own', 'studies.tele', 'studies.flag_unreadable',
  'studies.registered_24h', 'studies.registered_7d', 'tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal',
]);
export const ADMIN_METRIC_DAY_MS = 24 * 3600 * 1000;
export const ADMIN_METRIC_WEEK_MS = 7 * ADMIN_METRIC_DAY_MS;
/** 승인 전 상태. 그 밖의 값(A가 아닌 모르는 값)은 대기로 세지 않고 제외 건수에 넣는다. */
const ADMIN_METRIC_WAITING_RS = ['W', 'T', 'P', 'H'];

export type AdminMetricFailure = 'source_failed' | 'invalid_answer' | 'timeout';
export interface AdminMetricStorage { bytes?: number; observedAt?: string; failure?: AdminMetricFailure }
export interface AdminMetricStudies { observedAt: string; states: any[]; firstApproved: Map<string, unknown> }

/** Orthanc `/statistics`의 TotalDiskSize(바이트, 문자열). 음수·소수·지수·안전 정수 밖은 모름이다. */
export function orthancDiskBytes(answer: unknown): number | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const raw = (answer as any).TotalDiskSize;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

const metricTime = (value: unknown): number | null => {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** 중앙값(짝수 건이면 가운데 두 값의 평균을 내림)과 최댓값, 초 단위 정수. 0건이면 둘 다 없음이다. */
function metricDurations(seconds: number[]) {
  if (!seconds.length) return { value: null, max: null };
  const sorted = [...seconds].sort((a, b) => a - b), mid = sorted.length >> 1;
  const value = sorted.length % 2 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
  return { value, max: sorted[sorted.length - 1] };
}

/**
 * 입력 사실에서 지표 줄을 만든다(순수). `studies`가 null이면 DB 읽기가 실패한 것이고 DB 줄은 전부 관측 불가다.
 * 행 거르기는 `visible()`과 같은 경계다 — 소유 기관이거나 원격판독으로 받은 기관. 호출측이 이미 걸렀어도 여기서
 * 한 번 더 걸러, 다른 기관 행이 섞여 들어와도 어느 합계에도 들어가지 않게 한다.
 */
export function adminMetricRows(institution: string, storage: AdminMetricStorage, studies: AdminMetricStudies | null) {
  const row = (key: string, scope: 'server' | 'institution', unit: 'byte' | 'study' | 'second', rest: any) => ({
    key, state: 'observed', reason: null, scope, source: null, observedAt: null, unit, value: null, max: null,
    denominator: null, excluded: null, window: null, ...rest });
  const rows: any[] = [];
  const disk = storage.failure === undefined && Number.isSafeInteger(storage.bytes) && (storage.bytes as number) >= 0
    && metricTime(storage.observedAt) !== null;
  // 분모(전체 용량)는 제품 어디에도 원천이 없다. 그래서 사용률(%)도 만들지 않는다.
  rows.push(row('storage.server', 'server', 'byte', disk
    ? { source: 'Orthanc GET /statistics TotalDiskSize', observedAt: storage.observedAt, value: storage.bytes,
        denominator: { unit: 'byte', value: null } }
    : { state: 'unobservable', reason: storage.failure ?? 'invalid_answer', source: 'Orthanc GET /statistics TotalDiskSize',
        denominator: { unit: 'byte', value: null } }));
  rows.push(row('storage.institution', 'institution', 'byte',
    { state: 'unobservable', reason: 'no_source', denominator: { unit: 'byte', value: null } }));

  const now = studies ? metricTime(studies.observedAt) : null;
  const sources: Record<string, string> = {
    studies: 'KIN DB StudyState', registered: 'KIN DB StudyState.createdAt',
    tat: 'KIN DB StudyState.createdAt, ReportVersion(action=approve).at, StudyState.em',
    waiting: 'KIN DB StudyState.createdAt, StudyState.rs, StudyState.em',
  };
  const durationKeys = ['tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal'];
  if (!studies || now === null) {
    for (const key of ADMIN_METRIC_KEYS.slice(2)) {
      const family = key.startsWith('tat.') ? 'tat' : key.startsWith('waiting.') ? 'waiting'
        : key.startsWith('studies.registered') ? 'registered' : 'studies';
      rows.push(row(key, 'institution', durationKeys.includes(key) ? 'second' : 'study', {
        state: 'unobservable', reason: 'source_failed', source: sources[family],
        denominator: durationKeys.includes(key) ? { unit: 'study', value: null } : null }));
    }
    return rows;
  }

  const observedAt = new Date(now).toISOString();
  const windowOf = (span: number) => ({ from: new Date(now - span).toISOString(), to: observedAt });
  const scoped = (Array.isArray(studies.states) ? studies.states : [])
    .filter(s => s && (s.institutionId === institution || s.teleInstitutionId === institution));
  const own = scoped.filter(s => s.institutionId === institution).length;
  const flagged = (em: unknown) => em === 'E' ? 'emergency' : em === 'N' ? 'normal' : null;
  const counts = (span: number) => {
    let value = 0, excluded = 0;
    for (const s of scoped) {
      const at = metricTime(s.createdAt);
      if (at === null) excluded++;
      else if (at >= now - span && at <= now) value++;
    }
    return { value, excluded };
  };
  const day = counts(ADMIN_METRIC_DAY_MS), week = counts(ADMIN_METRIC_WEEK_MS);
  rows.push(row('studies.own', 'institution', 'study', { source: sources.studies, observedAt, value: own }));
  rows.push(row('studies.tele', 'institution', 'study', { source: sources.studies, observedAt, value: scoped.length - own }));
  rows.push(row('studies.flag_unreadable', 'institution', 'study',
    { source: sources.studies, observedAt, value: scoped.filter(s => flagged(s.em) === null).length }));
  rows.push(row('studies.registered_24h', 'institution', 'study',
    { source: sources.registered, observedAt, value: day.value, excluded: day.excluded, window: windowOf(ADMIN_METRIC_DAY_MS) }));
  rows.push(row('studies.registered_7d', 'institution', 'study',
    { source: sources.registered, observedAt, value: week.value, excluded: week.excluded, window: windowOf(ADMIN_METRIC_WEEK_MS) }));

  // TAT: 첫 승인 판(ReportVersion approve의 가장 이른 at)이 최근 7일 안인 검사, KIN 등록(createdAt)부터 그 시각까지.
  // 대기: 지금 승인 전(RS W·T·P·H)인 검사, KIN 등록부터 지금까지. 시각 순서가 맞지 않거나 읽을 수 없으면 제외로 센다.
  const from = now - ADMIN_METRIC_WEEK_MS;
  const groups: Record<string, { tat: number[]; tatExcluded: number; waiting: number[]; waitingExcluded: number }> = {
    emergency: { tat: [], tatExcluded: 0, waiting: [], waitingExcluded: 0 },
    normal: { tat: [], tatExcluded: 0, waiting: [], waitingExcluded: 0 },
  };
  for (const s of scoped) {
    const group = flagged(s.em);
    if (group === null) continue;
    const start = metricTime(s.createdAt), g = groups[group];
    const approved = studies.firstApproved instanceof Map ? metricTime(studies.firstApproved.get(s.uid)) : null;
    if (approved !== null && approved >= from && approved <= now) {
      if (start === null || approved < start) g.tatExcluded++;
      else g.tat.push(Math.floor((approved - start) / 1000));
    }
    if (s.rs === 'A') continue;
    if (!ADMIN_METRIC_WAITING_RS.includes(s.rs) || start === null || start > now) g.waitingExcluded++;
    else g.waiting.push(Math.floor((now - start) / 1000));
  }
  for (const family of ['tat', 'waiting'] as const) {
    for (const group of ['emergency', 'normal']) {
      const seconds = groups[group][family], stats = metricDurations(seconds);
      rows.push(row(`${family}.${group}`, 'institution', 'second', {
        state: seconds.length ? 'observed' : 'empty', source: sources[family], observedAt,
        value: stats.value, max: stats.max, denominator: { unit: 'study', value: seconds.length },
        excluded: groups[group][family === 'tat' ? 'tatExcluded' : 'waitingExcluded'],
        window: family === 'tat' ? windowOf(ADMIN_METRIC_WEEK_MS) : null }));
    }
  }
  return rows;
}

@Injectable()
export class PacsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private orthanc: OrthancService,
    private keycloak: KeycloakService, private studyAccess:StudyAccessService,
    // 인용이 가리키는 소견의 가독은 소견 쪽 관문이 판정한다. 판독문 관문(기관·예비판독)은
    // 그보다 넓어서, 그것만으로 통과시키면 읽을 수 없는 비교 검사가 인용을 통해 새어 나온다.
    private findings: FindingService) {}

  /** 기관 목록 캐시. 몇 개 안 되고 거의 안 바뀌므로 메모리에 둔다. */
  private institutions: any[] = [];

  /**
   * 구조화 서식 목록 (P7의 주입 이음매).
   *
   * 제품에서는 언제나 `STRUCTURE_CATALOG`이고 그것은 **비어 있다**(P6). 시험만이 자기
   * 인스턴스의 이 칸을 합성 목록으로 덮는다 — 환경변수도, 헤더도, 라우트도 아니다.
   * 제품 코드나 HTTP로 합성 항목에 닿을 방법이 없어야 지어낸 임상 내용이 새지 않는다.
   */
  private structureCatalogValue: readonly StructureTemplate[] = STRUCTURE_CATALOG;
  protected get structureCatalog(): readonly StructureTemplate[] { return this.structureCatalogValue; }
  /**
   * 목록을 갈아끼우는 **유일한 길**이고, 그 길에는 관문이 있다 (P12).
   *
   * 검사는 갈아끼우기 **전에** 한다. 규칙을 어긴 목록은 던지면서 지나가고, 그때 이미 서 있던
   * 유효한 목록은 그대로 남는다 — 잘못된 배정이 멀쩡한 목록을 치우고 그 자리를 비워두는 일은
   * 없다. 제품 인스턴스는 언제나 비어 있는 `STRUCTURE_CATALOG`으로 시작한다.
   */
  protected set structureCatalog(next: readonly StructureTemplate[]) {
    validateCatalog(next);
    this.structureCatalogValue = next;
  }

  async onModuleInit() {
    // 기관 시드 — upsert라 이미 있으면 이름·별칭만 갱신된다
    for (const i of SEED_INSTITUTIONS)
      await this.prisma.institution.upsert({ where: { id: i.id }, create: i, update: { name: i.name, type: i.type, dicomNames: i.dicomNames } });
    await this.reloadInstitutions();

    const n = await this.prisma.order.count();
    if (n === 0) {
      await this.prisma.order.createMany({ data: SEED_ORDERS });
      console.log(`[KIN API] 오더 시드 ${SEED_ORDERS.length}건 생성`);
    } else {
      // 기관 컬럼이 생기기 전에 만들어진 오더는 전부 스키마 기본값(hallym)을 달고 있다.
      // 시드 오더의 소속을 코드와 맞춰준다 — 안 하면 판독센터 오더가 한림에 보인다.
      for (const o of SEED_ORDERS)
        await this.prisma.order.updateMany({
          where: { oid: o.oid, institutionId: { not: o.institutionId } },
          data: { institutionId: o.institutionId },
        });
    }
    console.log(`[KIN API] 기관 ${this.institutions.length}개: ${this.institutions.map(i => `${i.id}(${i.name})`).join(', ')}`);
  }

  private async reloadInstitutions() {
    this.institutions = await this.prisma.institution.findMany();
  }

  /**
   * DICOM InstitutionName(0008,0080) → 우리 기관 id.
   *
   * 못 찾으면 **null을 준다.** 모르는 기관명을 기본 기관에 밀어넣지 않는다 —
   * 그렇게 하면 남의 병원 검사가 조용히 우리 목록에 섞이고, 조용히 섞인 것은
   * 아무도 발견하지 못한다. 미배정 검사는 화면에서 "(미배정)"으로 보이고
   * 어느 기관에도 잡히지 않는다.
   */
  private resolveInstitution(dicomName: string): string | null {
    const key = (dicomName ?? '').trim().toLowerCase();
    if (!key) return null;
    for (const i of this.institutions) {
      const names = String(i.dicomNames ?? '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
      if (names.includes(key) || i.id.toLowerCase() === key || i.name.toLowerCase() === key) return i.id;
    }
    return null;
  }

  private instName(id: string | null) {
    return this.institutions.find(i => i.id === id)?.name ?? '(미배정)';
  }

  private audit(actor: string, action: string, target: string, detail?: any) {
    return this.prisma.auditLog.create({
      data: { actor: actor || 'unknown', action, target, detail: dump(detail) },
    });
  }

  /**
   * 이 검사를 이 기관이 다룰 수 있는가.
   *  - 소유 기관이면 된다
   *  - 원격판독을 받은 기관이어도 된다  ← **기관 경계를 넘는 유일한 통로**
   */
  private visible(s: any, institution: string) {
    return s.institutionId === institution || s.teleInstitutionId === institution;
  }

  /**
   * ── 미배정 검사 (institutionId = null) ──
   *
   * DICOM `InstitutionName`을 못 알아본 검사는 어느 기관 것도 아니다. 그건 의도한
   * 설계다 — 모르는 기관명을 아무 데나 밀어넣으면 남의 병원 검사가 조용히 섞인다.
   *
   * 그런데 그 결과 **그 검사는 누구에게도 안 보인다.** 장비 태그 오타 하나로
   * 영상이 시스템에 들어와 있는데 아무도 모르는 상태가 되고, 아무도 모르므로
   * 아무도 고치지 않는다. 조용히 사라지는 검사는 조용히 섞이는 검사만큼 나쁘다.
   *
   * 그래서 **관리자용 통로 하나**를 낸다. 목록에 섞어 보여주지 않고, 별도 경로로만
   * 보이고, 배정은 감사로그에 남는다. (§9 — 편의로 기관 경계를 뚫지는 않는다)
   */
  async unassigned(c: Caller) {
    need(c.roles, 'admin', '미배정 검사 조회');
    inst(c);   // 소속이 없는 계정은 admin이어도 여기서 막힌다
    const orphans = await this.prisma.studyState.findMany({ where: { institutionId: null } });
    if (!orphans.length) return { studies: [], institutions: this.institutions.map(i => ({ id: i.id, name: i.name })) };
    const set = await this.studyAccess.allowed(c,orphans.map(o=>o.uid));
    const qido = await this.orthanc.studies();
    const studies = qido
      .filter(st => set.has(OrthancService.tag(st, '0020000D')))
      .map(st => ({
        uid: OrthancService.tag(st, '0020000D'),
        id: OrthancService.tag(st, '00100020'),
        name: OrthancService.tag(st, '00100010').replace(/\^/g, ' '),
        date: OrthancService.tag(st, '00080020'),
        desc: OrthancService.tag(st, '00081030'),
        // 왜 못 알아봤는지 사람이 보고 판단할 수 있어야 한다. 이 문자열이 단서다.
        dicomInstitution: OrthancService.tag(st, '00080080'),
      }));
    return { studies, institutions: this.institutions.map(i => ({ id: i.id, name: i.name })) };
  }

  /**
   * 미배정 검사를 기관에 배정한다.
   *
   * **이미 배정된 검사는 여기로 옮기지 못한다.** 판독문이 붙은 검사를 다른 기관으로
   * 옮기는 것은 전혀 다른 무게의 일이다 — 누가 읽었는지, 누가 볼 수 있는지가 함께
   * 바뀐다. 이 통로는 "고아를 집에 보내는" 것 하나만 한다.
   */
  async assignInstitution(uid: string, institutionId: string, c: Caller) {
    return this.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'admin', '검사 기관 배정');
    inst(c);
    await this.studyAccess.require(c,[uid],tx);
    if (!this.institutions.some(i => i.id === institutionId))
      throw new BadRequestException(`알 수 없는 기관입니다: ${institutionId}`);
    const s = await tx.studyState.findUnique({ where: { uid } });
    if (!s) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (s.institutionId)
      throw new BadRequestException(
        `이미 ${this.instName(s.institutionId)}에 배정된 검사입니다. 기관 이동은 이 통로로 하지 않습니다.`);
    const saved = await tx.studyState.update({
      where: { uid }, data: { institutionId, reqHosp: this.instName(institutionId) },
    });
    await audit(c.actor, 'study.assign', uid, { institutionId });
    return toClient(saved, await tx.report.findUnique({ where: { uid } }), c.actor, null);
    });
  }

  /** 운영 지표 원천 한 곳의 대기 상한. 느린 Orthanc가 DB 지표까지 붙잡지 않게 한다(시험은 인스턴스 값을 줄인다). */
  protected metricsTimeoutMs = 5000;
  /** 운영 지표의 관측 시각·기간 기준 시계. 제품은 서버 시계이고, 시험만 인스턴스 값을 고정해 기간 경계를 재현한다. */
  protected metricsClock = () => Date.now();

  /**
   * S5-U6b 관리자 운영 지표(`GET /api/admin/metrics`). 줄의 모양과 규칙은 `adminMetricRows`에 있다.
   *
   * 기관 범위는 서버가 정한다: DB 읽기(범위 재확인 포함)가 모두 `institutionId = me OR teleInstitutionId = me`로 걸리고
   * (워크리스트와 같은 visible 경계), 원천 행은 응답에 나가지 않고 합계만 나간다. Orthanc `/statistics`에서는
   * TotalDiskSize 하나만 읽는다 — 같은 답에 있는 서버 전체 검사·영상 수는 다른 기관 검사를 세는 값이라 싣지 않는다.
   */
  async adminMetrics(c: Caller) {
    need(c.roles, 'admin', '운영 지표 조회');
    const me = inst(c);
    const access = await this.studyAccess.snapshot(c);
    // 검사 접근이 제한된 계정에게 기관·서버 합계는 범위 밖 검사를 세어 주는 창이다(`/statistics`를 닫은 S5-U1b
    // COUNT-LEAK와 같은 이유). 제한 범위만 다시 센 값을 기관 지표라고 부를 수도 없으므로 주지 않는다.
    if (access.policy.restricted)
      throw new ForbiddenException({ code: 'ADMIN_METRICS_RESTRICTED',
        message: '검사 접근 범위가 제한된 계정은 기관 운영 지표를 볼 수 없습니다' });
    const [storage, read] = await Promise.all([this.metricsStorage(), this.metricsStudies(me)]);
    // 기관 범위 재확인은 모든 원천이 답한 뒤(Orthanc 대기 포함)에 한다. 범위가 바뀐 것은 원천 실패가 아니므로
    // metricsStudies의 catch 밖에서 409로 던진다 — 관측 불가 줄로 바꿔 내보내지 않는다.
    const studies = read && await this.metricsScopeHeld(me, read);
    const metrics = adminMetricRows(me, storage, studies);
    // AdminController는 정책 관리 통로를 지키려고 응답 뒤 재확인 interceptor를 건너뛴다. 그 확인을 여기서 한다 —
    // 읽는 동안 접근 조건이 바뀌었으면 그 전 조건으로 센 합계를 내보내지 않는다.
    await this.studyAccess.unchanged(c, access);
    return { institutionId: me, generatedAt: new Date(this.metricsClock()).toISOString(), metrics };
  }

  /**
   * Orthanc 서버 전체 저장량(D11). OrthancService의 인증된 `get`을 그대로 쓴다 — 자격증명 처리를 한 곳에 두려는
   * 것이고, 이 단위의 쓰기 범위에 orthanc.service.ts가 없어 공개 메서드를 새로 두지 못했다(후속에서 옮길 자리).
   * 실패 문구(원천 주소가 섞일 수 있다)는 응답에 싣지 않고 이유 코드만 남긴다.
   */
  private async metricsStorage(): Promise<AdminMetricStorage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.metricsTimeoutMs); });
    try {
      const answer = await Promise.race([this.orthanc['get']('/statistics'), late]);
      if (answer === 'timeout') return { failure: 'timeout' };
      const bytes = orthancDiskBytes(answer);
      return bytes === null ? { failure: 'invalid_answer' } : { bytes, observedAt: new Date(this.metricsClock()).toISOString() };
    } catch {
      return { failure: 'source_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 기관 범위 DB 사실. 실패는 null(관측 불가)이며 0건으로 바꾸지 않는다. */
  private async metricsStudies(me: string): Promise<AdminMetricStudies | null> {
    try {
      const states = await this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
        select: { uid: true, institutionId: true, teleInstitutionId: true, rs: true, em: true, createdAt: true },
      });
      // 첫 승인 시각은 전체 이력에서 고른다. 기간으로 먼저 거르면 오래전에 승인되고 최근 다시 승인된 검사가
      // 이번 주의 첫 승인처럼 보인다. IN 목록 대신 JOIN으로 기관을 걸어 매개변수 개수 한도에 닿지 않는다.
      const approvals = await this.prisma.$queryRaw<{ uid: string; firstApprovedAt: Date }[]>`
        SELECT v.uid, MIN(v.at) AS "firstApprovedAt"
        FROM "ReportVersion" v JOIN "StudyState" s ON s.uid = v.uid
        WHERE v.action = 'approve' AND (s."institutionId" = ${me} OR s."teleInstitutionId" = ${me})
        GROUP BY v.uid`;
      return { observedAt: new Date(this.metricsClock()).toISOString(), states: states.filter(s => this.visible(s, me)),
        firstApproved: new Map(approvals.map(a => [a.uid, a.firstApprovedAt])) };
    } catch (e: any) {
      console.warn(`[KIN API] 운영 지표 DB 읽기 실패: ${e?.code ?? e?.name ?? 'unknown'}`);
      return null;
    }
  }

  /**
   * 집계에 쓴 검사가 아직 같은 기관 범위에 있는가(S5-U6b-F01). `studyAccess.unchanged`는 계정의 접근 정책만 비교하므로,
   * 읽는 동안 원격판독 의뢰가 취소되어(teleInstitutionId → null) 통로가 닫힌 검사를 보지 못한다. 그래서 첫 읽기와 같은
   * 조건으로 한 번 더 읽어, 쓴 검사마다 institutionId·teleInstitutionId가 그대로인지 본다(워크리스트의 응답 전 재확인과
   * 같은 두 칸). IN 목록 대신 같은 기관 조건을 다시 걸어 매개변수 개수 한도에 닿지 않는다. 빠지거나 바뀐 검사가 하나라도
   * 있으면 합계 전체를 409로 거절한다. 읽는 동안 새로 범위에 들어온 검사는 거절 사유가 아니다 — 합계에 들어가지 않았으니
   * 범위 밖을 센 것이 없다. 재확인 읽기가 실패하면 범위를 확인하지 못한 것이므로 DB 줄 전부를 관측 불가(null)로 돌린다.
   */
  private async metricsScopeHeld(me: string, read: AdminMetricStudies): Promise<AdminMetricStudies | null> {
    let current: { uid: string; institutionId: string | null; teleInstitutionId: string | null }[];
    try {
      current = await this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
        select: { uid: true, institutionId: true, teleInstitutionId: true },
      });
    } catch (e: any) {
      console.warn(`[KIN API] 운영 지표 범위 재확인 실패: ${e?.code ?? e?.name ?? 'unknown'}`);
      return null;
    }
    const held = new Map(current.map(s => [s.uid, s]));
    if (read.states.some(s => {
      const now = held.get(s.uid);
      return !now || now.institutionId !== s.institutionId || now.teleInstitutionId !== s.teleInstitutionId;
    })) throw new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '집계하는 동안 검사의 기관 범위(원격판독 포함)가 바뀌었습니다. 다시 조회하세요.' });
    return read;
  }

  /**
   * DICOMweb 경로의 기관 관문. 워크리스트가 지키는 경계(visible)를 영상 경로에도 세운다.
   * auth_request 제약상 거부는 전부 403이다 — 404를 던지면 nginx가 500으로 바꾼다.
   */
  async authzDicom(originalUri: string, originalMethod: string, c: Caller) {
    const me = inst(c);
    const [path, query = ''] = originalUri.split('?');
    const method = originalMethod.toUpperCase();

    // Gateway가 여는 유일한 DICOMweb 면: announce로 소유권을 먼저 고정한 지정형 STOW.
    if (method === 'POST') {
      needExact(c, 'gateway', 'DICOM 수신');
      const m = /^\/dicom-web\/studies\/([0-9.]+)$/.exec(path);
      if (!m) throw new ForbiddenException('지정형 STOW만 허용됩니다');
      const s = await this.prisma.studyState.findUnique({ where: { uid: m[1] } });
      if (!s || s.institutionId !== me)
        throw new ForbiddenException('announce되지 않은 검사입니다');
      return;
    }
    if (!['GET', 'HEAD'].includes(method))
      throw new ForbiddenException('허용되지 않는 DICOMweb 메서드입니다');
    if (c.kind === 'gateway')
      throw new ForbiddenException('게이트웨이는 영상을 조회할 수 없습니다');

    // 서버 정보는 관리자만. 프론트 사용처 없음 — 버전 정보는 표면 축소가 이득이다.
    if (path === '/system') { need(c.roles, 'admin', '서버 정보 조회'); return; }
    // 로그인만으로 충분한 경로 — PHI 없음
    if (path === '/statistics') {
      // 서버 전체의 검사 수다. clinician-only에게는 자기 범위 밖 검사가 몇 건 있는지 세어 주는 창이라
      // 닫는다(S5-U1b COUNT-LEAK). 임상의 목록의 total은 볼 수 있는 검사만 센다.
      if (clinicianOnly(c.roles)) throw new ForbiddenException('전체 검사 통계를 열람할 수 없습니다');
      if((await this.studyAccess.snapshot(c)).policy.restricted)throw new ForbiddenException('전체 검사 통계를 열람할 수 없습니다');
      return;
    }

    // /dicom-web/studies/{uid}/... — 경로의 UID로 관문
    let m = /^\/dicom-web\/studies\/([0-9.]+)(?:\/|$)/.exec(path);
    let uid = m?.[1];

    // /dicom-web/studies?StudyInstanceUID=... — 쿼리의 UID로 관문 (OHIF 초기 조회)
    if (!uid && path === '/dicom-web/studies') {
      const q = new URLSearchParams(query);
      if(q.getAll('StudyInstanceUID').length+q.getAll('0020000D').length!==1)
        throw new ForbiddenException('검사 UID를 하나만 지정하세요');
      uid = q.get('StudyInstanceUID') ?? q.get('0020000D') ?? undefined;
      // UID 없는 전체 열거는 이 관문이 막으려는 바로 그것이다. 목록은 /api/studies가 기관을 걸러 준다.
      if (!uid) throw new ForbiddenException('전체 목록은 워크리스트 API를 사용하세요');
    }

    // /instances/{orthancId}/... — Orthanc에 물어 StudyInstanceUID로 환원
    if (!uid) {
      const im = /^\/instances\/([0-9a-f-]+)(?:\/|$)/.exec(path);
      if (im) {
        try { uid = await this.orthanc.instanceStudyUid(im[1]); }   // 불변이라 캐시됨
        catch {
          // 존재 여부도 정보다. Orthanc 장애도 403이 되지만, 503은 auth_request가 500으로 바꾸므로 수용한다.
          throw new ForbiddenException('열람 권한이 없습니다');
        }
      }
    }

    if (!uid) throw new ForbiddenException('허용되지 않는 경로입니다');
    const s = await this.prisma.studyState.findUnique({ where: { uid } });
    // 미등록(기관 미확정) 검사는 기본 거부 — 워크리스트를 한 번 열면 lazy 등록이 기관을 박는다.
    if (!s || !this.visible(s, me)) throw new ForbiddenException('열람 권한이 없습니다');
    try{await this.studyAccess.require(c,[uid]);}catch(e){throw new ForbiddenException('열람 권한이 없습니다');}
  }

  /**
   * Gateway 수신 예고. DICOM 태그는 참고 신호일 뿐이고 소유 기관은 서명된 자격증명으로 정한다.
   * 같은 기관의 재시도는 쓰기와 감사를 모두 생략한다.
   */
  async announceStudy(studyUid: string, institutionNameTag: unknown, c: Caller) {
    needExact(c, 'gateway', '검사 수신 예고');
    const me = inst(c);
    if (typeof studyUid !== 'string' || !/^[0-9.]+$/.test(studyUid))
      throw new BadRequestException('올바른 studyUid가 필요합니다');
    if (institutionNameTag != null && typeof institutionNameTag !== 'string')
      throw new BadRequestException('institutionNameTag는 문자열이어야 합니다');

    const existing = await this.prisma.studyState.findUnique({ where: { uid: studyUid } });
    if (existing) {
      if (existing.institutionId !== me)
        throw new ConflictException({ code: 'STUDY_OWNERSHIP_CONFLICT' });
      return { studyUid, institutionId: me, origin: existing.origin };
    }

    const resolvedTag = this.resolveInstitution(typeof institutionNameTag === 'string' ? institutionNameTag : '');
    const tagMismatch = resolvedTag != null && resolvedTag !== me;
    try {
      const saved = await this.prisma.$transaction(async tx => {
        const created = await tx.studyState.create({ data: {
          uid: studyUid,
          institutionId: me,
          reqHosp: this.instName(me),
          ss: 'Unverified',
          origin: 'gateway',
        } });
        await tx.auditLog.create({ data: {
          actor: c.actor || 'unknown',
          action: 'study.announce',
          target: studyUid,
          detail: dump({ institutionId: me, ...(tagMismatch ? { tagMismatch: true } : {}) }),
        } });
        return created;
      });
      return { studyUid, institutionId: me, origin: saved.origin };
    } catch (error: any) {
      // 동시 재시도는 unique 경쟁에서 진 쪽도 같은 기관이면 멱등 성공이다.
      if (error?.code !== 'P2002') throw error;
      const winner = await this.prisma.studyState.findUnique({ where: { uid: studyUid } });
      if (!winner || winner.institutionId !== me)
        throw new ConflictException({ code: 'STUDY_OWNERSHIP_CONFLICT' });
      return { studyUid, institutionId: me, origin: winner.origin };
    }
  }

  /**
   * S4-U3 Gateway 전송 영수증(`gateway-receipt.ts`).
   *
   * 자기 기관 StudyState가 없는 UID는 없든 남의 것이든 **같은 404 하나**다. 그 판정이 순서·epoch
   * 비교보다 먼저 온다 — 남의 검사에 409가 나가면 그 검사가 있다는 사실이 샌다. announce의 소유권 409는
   * 쓰지 않는다. 409는 순서·본문 충돌과 모르는 epoch에만 쓴다.
   *
   * 한 검사의 영수증 처리는 advisory lock으로 줄 세운다. 그래서 최초 저장과 epoch 사건 감사의 속도
   * 제한이 경쟁에서도 한 건이고, 속도 제한 때문에 저장된 영수증 행을 건드리지 않는다.
   */
  async gatewayReceipt(body: unknown, c: Caller) {
    needExact(c, 'gateway', '전송 영수증');
    const me = inst(c);
    let receipt: GatewayReceipt;
    try { receipt = parseGatewayReceipt(body); }
    catch (error) {
      if (error instanceof GatewayReceiptInputError)
        throw new BadRequestException({ code: 'GATEWAY_RECEIPT_INVALID', field: error.message });
      throw error;
    }
    const uid = receipt.studyUid;
    const outcome: GatewayReceiptDecision | { kind: 'absent' } = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'kin.gateway-receipt:' + uid}, 0))`;
      const study = await tx.studyState.findUnique({ where: { uid }, select: { institutionId: true } });
      if (!study || study.institutionId !== me) return { kind: 'absent' as const };
      const row = await tx.gatewayReceipt.findUnique({ where: { studyUid: uid } });
      // 다른 기관 자격증명이 남긴 행은 이 epoch의 것이 아니다. 덮어쓰지 않는다.
      const decision: GatewayReceiptDecision = row && row.institutionId !== me ? { kind: 'epoch' }
        : decideGatewayReceipt(row ? storedGatewayReceipt(row) : null, receipt);
      const fields = { epoch: receipt.epoch, seq: receipt.seq, phase: receipt.phase, attempt: receipt.attempt,
        successCount: receipt.successCount, localCount: receipt.localCount, errorCode: receipt.errorCode,
        receivedAt: new Date() };
      const audit = (action: string, detail: any) =>
        tx.auditLog.create({ data: { actor: c.actor || 'unknown', action, target: uid, detail: dump(detail) } });
      if (decision.kind === 'first') {
        await tx.gatewayReceipt.create({ data: { studyUid: uid, institutionId: me, ...fields } });
        await audit('gateway.receipt.first', { epoch: receipt.epoch, seq: receipt.seq, phase: receipt.phase });
      } else if (decision.kind === 'advance') {
        await tx.gatewayReceipt.update({ where: { studyUid: uid }, data: fields });
        if (decision.transition)
          await audit('gateway.receipt.transition', { epoch: receipt.epoch, seq: receipt.seq, from: row.phase, phase: receipt.phase });
      } else if (decision.kind === 'epoch') {
        const since = new Date(Date.now() - GATEWAY_EPOCH_INCIDENT_WINDOW_MS);
        const recent = await tx.auditLog.findFirst({
          where: { action: 'gateway.receipt.epoch_unrecognised', target: uid, at: { gte: since } }, select: { id: true } });
        if (!recent) await audit('gateway.receipt.epoch_unrecognised', { registeredEpoch: row.epoch, offeredEpoch: receipt.epoch });
      }
      return decision;
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch((error: any) => {
      if (error?.code === 'P2028' || error?.code === 'P2010' && ['55P03', '57014'].includes(error?.meta?.code))
        throw new ServiceUnavailableException({ code: 'GATEWAY_RECEIPT_BUSY' });
      throw error;
    });
    if (outcome.kind === 'absent') throw new NotFoundException({ code: 'GATEWAY_RECEIPT_STUDY_NOT_FOUND' });
    if (outcome.kind === 'conflict') throw new ConflictException({ code: 'GATEWAY_RECEIPT_CONFLICT' });
    if (outcome.kind === 'epoch') throw new ConflictException({ code: 'GATEWAY_EPOCH_UNRECOGNISED' });
    return { studyUid: uid, result: outcome.kind === 'first' || outcome.kind === 'advance' ? 'stored' : outcome.kind };
  }

  /**
   * S4-U4 Now Retry 요청(`gateway-retry.ts`). 사람은 요청을 남길 뿐이다 — 병원으로 밀지 않고, 재시도가
   * 돌았다고 말하지 않는다. 응답 `requested`는 "저장됨"이다.
   *
   * 없는·남의·원격판독으로 받은·접근 조건 밖 검사는 모두 `gate()`와 같은 404 한 가지다(존재 여부도 정보다).
   * 요청은 U3 영수증과 **같은 advisory lock** 안에서 지금 저장된 `retry` 영수증의 (epoch, seq)에 묶인다.
   * 같은 묶음의 두 번째 요청은 쓰기·감사 없이 처음 시각을 돌려준다. 영수증·StudyState·Orthanc는 쓰지 않는다.
   */
  async requestGatewayRetry(uid: string, body: unknown, c: Caller) {
    need(c.roles, 'technician', 'Gateway 재시도 요청');
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용입니다');
    const me = inst(c);
    try { parseGatewayRetryRequestBody(body); }
    catch (error) {
      if (error instanceof GatewayRetryInputError) throw new BadRequestException({ code: GATEWAY_RETRY_INVALID });
      throw error;
    }
    const s = await this.gate(uid, c);
    // gate()는 원격판독을 받은 기관에도 검사를 보여 준다. 요청은 소유(촬영) 기관만 하고, 받은 쪽에는 같은 404다.
    if (!s || s.institutionId !== me) throw new NotFoundException('검사를 찾을 수 없습니다');
    await this.studyAccess.prepare(c, [uid]);
    type Outcome = { kind: 'absent' | 'not_retry' | 'unsupported_f01' }
      | { kind: 'requested' | 'already_requested'; requestedAt: Date };
    const outcome: Outcome = await this.prisma.$transaction(async (tx): Promise<Outcome> => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      // U3 영수증과 같은 키: 한 검사의 요청과 영수증 갱신은 줄을 서므로, 묶은 (epoch, seq)는 커밋 순간의 저장값이다.
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'kin.gateway-receipt:' + uid}, 0))`;
      await this.studyAccess.require(c, [uid], tx);
      const study = await tx.studyState.findUnique({ where: { uid }, select: { institutionId: true } });
      if (!study || study.institutionId !== me) return { kind: 'absent' };
      const receipt = await tx.gatewayReceipt.findFirst({ where: { studyUid: uid, institutionId: me } });
      const decision = decideGatewayRetryRequest(receipt);
      if (decision !== 'eligible') return { kind: decision };
      const key = { studyUid: uid, epoch: receipt!.epoch, seq: receipt!.seq };
      const existing = await tx.gatewayRetryRequest.findUnique({ where: { studyUid_epoch_seq: key } });
      if (existing) return { kind: 'already_requested', requestedAt: existing.requestedAt };
      const requestedAt = new Date();
      await tx.gatewayRetryRequest.create({ data: { ...key, requestedAt } });
      await tx.auditLog.create({ data: { actor: c.actor || 'unknown', action: 'gateway.retry.request', target: uid,
        detail: dump({ epoch: key.epoch, seq: Number(key.seq) }) } });
      return { kind: 'requested', requestedAt };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch((error: any) => {
      if (error?.code === 'P2028' || error?.code === 'P2010' && ['55P03', '57014'].includes(error?.meta?.code))
        throw new ServiceUnavailableException({ code: GATEWAY_RETRY_BUSY });
      throw error;
    });
    if (outcome.kind === 'requested' || outcome.kind === 'already_requested')
      return { studyUid: uid, result: outcome.kind, requestedAt: outcome.requestedAt.toISOString() };
    if (outcome.kind === 'unsupported_f01') throw new ConflictException({ code: GATEWAY_RETRY_UNSUPPORTED_F01 });
    if (outcome.kind === 'not_retry') throw new ConflictException({ code: GATEWAY_RETRY_NOT_RETRY });
    throw new NotFoundException('검사를 찾을 수 없습니다');
  }

  /**
   * S4-U4 Gateway가 가져가는 Now Retry 목록. 읽기만 한다 — 쓰기·감사가 없다. 답은 이 자격증명 기관의
   * studyUid뿐이고 개수·시각·epoch·다른 기관의 것은 싣지 않는다. 대기 판정은 SQL 한 문장에서 LIMIT 전에
   * 끝난다: 요청의 (epoch, seq)가 지금 저장된 영수증과 같고, 그 영수증이 `retry`이며, 영수증과 StudyState가
   * 모두 이 기관 것이다. 다른 epoch의 조회는 오류 없이 빈 목록이다(H-1: 여기서는 epoch을 만들거나 바꾸지 않는다).
   */
  async gatewayRetryRequests(query: unknown, c: Caller) {
    needExact(c, 'gateway', 'Gateway 재시도 요청 조회');
    const me = inst(c);
    let epoch: string;
    try { epoch = parseGatewayRetryPoll(query); }
    catch (error) {
      if (error instanceof GatewayRetryInputError) throw new BadRequestException({ code: GATEWAY_RETRY_POLL_INVALID });
      throw error;
    }
    // LIMIT은 gateway-retry.ts GATEWAY_RETRY_POLL_LIMIT(100)이다. 검사당 대기 요청은 저장 영수증 하나에 묶여 최대 한 건이다.
    const rows: { studyUid: string }[] = await this.prisma.$queryRaw`SELECT q."studyUid" FROM "GatewayRetryRequest" q
      JOIN "GatewayReceipt" r ON r."studyUid" = q."studyUid" AND r.epoch = q.epoch AND r.seq = q.seq
      JOIN "StudyState" s ON s.uid = q."studyUid"
      WHERE q.epoch = ${epoch}::uuid AND r.phase = 'retry' AND r."institutionId" = ${me} AND s."institutionId" = ${me}
      ORDER BY q."requestedAt", q."studyUid" LIMIT 100`;
    return { studyUids: rows.map(row => row.studyUid) };
  }

  /** SOP lookup도 요청 Study의 기관 관문 안에서만 Orthanc ID를 내보낸다. */
  async dicomLookup(studyUid: string, sopUid: string, c: Caller) {
    const me = inst(c);
    if (!/^[0-9.]+$/.test(studyUid ?? '') || !/^[0-9.]+$/.test(sopUid ?? ''))
      throw new BadRequestException('studyUid와 sopUid가 필요합니다');

    const found = await this.orthanc.lookupInstance(sopUid);
    const instances = found.filter((item: any) => item?.Type === 'Instance' && /^[0-9a-f-]+$/.test(item?.ID ?? ''));
    if (instances.length !== 1) throw new ForbiddenException('열람 권한이 없습니다');

    let actualUid: string;
    try { actualUid = await this.orthanc.instanceStudyUid(instances[0].ID); }
    catch { throw new ForbiddenException('열람 권한이 없습니다'); }
    if (actualUid !== studyUid) throw new ForbiddenException('열람 권한이 없습니다');

    const study = await this.prisma.studyState.findUnique({ where: { uid: actualUid } });
    if (!study || !this.visible(study, me)) throw new ForbiddenException('열람 권한이 없습니다');
    await this.studyAccess.require(c,[actualUid]);
    return { id: instances[0].ID };
  }

  /** 쓰기 전 관문. 없는 검사와 남의 검사는 같은 메시지로 막는다(존재 여부도 정보다). */
  /**
   * 내 초안 한 건. **모든 `toClient` 호출이 이걸 실어야 한다.**
   *
   * 안 실으면 `draft: null`이 나가고, 클라이언트의 `{...기존, ...응답}`이
   * 방금 쓰고 있던 초안을 지운다 — 점유 하트비트나 Verify 한 번에 화면의 판독문이
   * 사라지는 것이다. §14("비움도 값이다")의 정확히 반대편 함정이고,
   * 같은 실수를 `holder`에서 한 번, `toClient`의 7개 필드에서 또 했다.
   */
  private myDraft(uid: string, actor: string, db:any=this.prisma) {
    return db.reportDraft.findUnique({ where: { uid_author: { uid, author: actor } } });
  }

  private async scopeWrite<T>(uid:string,c:Caller,work:(tx:Prisma.TransactionClient,audit:(actor:string,action:string,target:string,detail?:any)=>Promise<any>)=>Promise<T>):Promise<T> {
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c,[uid],tx);
      const audit=(actor:string,action:string,target:string,detail?:any)=>tx.auditLog.create({data:{actor:actor||'unknown',action,target,detail:dump(detail)}});
      return work(tx,audit);
    },{maxWait:4000,timeout:8000}).catch(noteTransactionError);
  }

  private async gate(uid: string, c: Caller, db:any=this.prisma) {
    const me = inst(c);
    const s = await db.studyState.findUnique({ where: { uid } });
    if (s && !this.visible(s, me))
      throw new NotFoundException('검사를 찾을 수 없습니다');
    if(s)await this.studyAccess.require(c,[uid],db===this.prisma?undefined:db);
    return s;
  }

  // ══════════════════ 조회 ══════════════════

  // REQ-D01-TECH-NOTE -> RISK-D01-NOTE-IDENTITY/HISTORY -> TEST-D01-TECH-NOTE.
  // The parent lock serializes note revisions with transfer cancellation/deletion.
  private async noteScope(tx: any, uid: string, c: Caller, writing: boolean) {
    if (typeof uid !== 'string' || uid.length > 64 || !/^\d+(?:\.\d+)+$/.test(uid))
      throw new BadRequestException('검사 UID를 확인하세요');
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용입니다');
    need(c.roles, writing ? 'technician' : c.roles.includes('technician') ? 'technician' : 'radiologist', 'Tech 메모');
    const me = inst(c);
    await this.studyAccess.snapshot(c,tx);
    const rows = writing
      ? await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`
      : await tx.$queryRaw`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR SHARE`;
    const study = rows[0];
    if (!study || !this.visible(study, me)) throw new NotFoundException('검사를 찾을 수 없습니다');
    await this.studyAccess.require(c,[uid],tx);
    if (writing && study.institutionId !== me) throw new ForbiddenException('촬영 기관에서만 Tech 메모를 작성할 수 있습니다');
    return study;
  }

  async techNote(uid: string, c: Caller, before?: string) {
    if (before !== undefined && (!/^[1-9]\d{0,9}$/.test(before) || Number(before) > 2147483647))
      throw new BadRequestException('이력 위치를 확인하세요');
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      const study = await this.noteScope(tx, uid, c, false);
      const writable = study.institutionId === c.institution && (c.roles.includes('technician') || c.roles.includes('admin'));
      if (before !== undefined) {
        const items = await tx.techNoteRevision.findMany({ where: { studyUid: uid, version: { lt: Number(before) } }, orderBy: { version: 'desc' }, take: 51, select: NOTE_PUBLIC_FIELDS });
        const more = items.length > 50; if (more) items.pop();
        return { uid, items, nextBefore: more ? items[items.length - 1].version : null };
      }
      const note = await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, orderBy: { version: 'desc' }, select: NOTE_PUBLIC_FIELDS });
      return { uid, note: note ?? null, writable };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch(noteTransactionError);
  }

  async saveTechNote(uid: string, body: any, c: Caller) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['baseVersion', 'text', 'reason'].includes(k)) ||
        !Number.isInteger(body.baseVersion) || body.baseVersion < 0 || body.baseVersion >= 2147483646 ||
        typeof body.text !== 'string' || body.text.length > 10000 || body.text.includes('\0') ||
        typeof body.reason !== 'string' || body.reason.length > 1000 || body.reason.includes('\0'))
      throw new BadRequestException('메모·수정 사유·기준 버전을 확인하세요');
    if (/[\uD800-\uDFFF]/u.test(body.text) || /[\uD800-\uDFFF]/u.test(body.reason))
      throw new BadRequestException('잘못된 문자 인코딩입니다');
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.noteScope(tx, uid, c, true);
      const prev = await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, orderBy: { version: 'desc' } });
      if ((prev?.version ?? 0) !== body.baseVersion) throw new ConflictException('메모가 변경되었습니다. 이력을 확인한 뒤 다시 작성하세요');
      if (prev && !body.reason.trim()) throw new BadRequestException('수정·비우기에는 사유가 필요합니다');
      if (!prev && !body.text.trim()) throw new BadRequestException('메모 내용을 입력하세요');
      if (prev?.text === body.text) throw new BadRequestException('변경된 내용이 없습니다');
      const note = await tx.techNoteRevision.create({ data: { studyUid: uid, version: body.baseVersion + 1,
        text: body.text, reason: body.reason.trim(), author: c.actor, authorSub: c.sub, institutionId: inst(c) }, select: NOTE_PUBLIC_FIELDS });
      await tx.auditLog.create({ data: { actor: c.actor, action: 'tech-note.revise', target: uid,
        detail: JSON.stringify({ version: note.version, institutionId: c.institution }) } });
      return { uid, note, writable: true };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 }).catch(noteTransactionError);
  }

  /**
   * 검사 목록. **예전엔 브라우저가 Orthanc를 직접 불렀다.**
   * 이제 서버가 QIDO-RS를 대신 부르고, 기관으로 거른 뒤, 상태를 얹어 내려준다.
   * 필터를 화면에 두면 주소창으로 우회할 수 있다 — 경계는 서버에만 있다.
   *
   * 처음 본 검사는 여기서 StudyState 행이 생기며 기관이 박힌다(lazy 등록).
   * 조회가 쓰기를 하는 게 이상해 보이지만, 대안은 모든 쓰기 경로가 매번
   * Orthanc에 기관을 물어보는 것이다. 기관은 영상에 찍혀 오는 사실이고
   * 한 번 판정하면 변하지 않으므로, 처음 보는 순간 DB에 확정한다.
   */
  async listStudies(c: Caller, query?: any) {
    const me = inst(c);
    const access=await this.studyAccess.snapshot(c);
    const owner = [me, c.sub, c.actor, String(access.revision), String(access.windowOpen)], page = studyPageQuery(query, owner);
    // S4-U2 asks the paged enumeration for the indexed AccessionNumber too; the full QIDO carries it already.
    const qido = page ? await this.orthanc.studyIdentities(this.studyAccess.needsMetadata(access), true) : await this.orthanc.studies();
    // S4-U1b: the server time at which this successful enumeration returned. A failed QIDO throws
    // before this line, so no response ever carries an observation time it did not make.
    const observedAt = new Date().toISOString();

    const states = page ? await this.prisma.studyState.findMany({
      select: { uid:true, institutionId:true, teleInstitutionId:true, origin:true, createdAt:true },
    }) : await this.prisma.studyState.findMany();
    const byUid = new Map(states.map(s => [s.uid, s as any]));

    // Both source paths carry indexed InstitutionName. Cold/unassigned rows
    // resolve from that original tag without fetching patient details for all.

    // 아직 등록 안 된 검사에 기관을 박는다 (한 번만 일어난다)
    const news: any[] = [];
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) continue;
      const cur = byUid.get(uid);
      const resolved = this.resolveInstitution(OrthancService.tag(st, '00080080'));
      if (!cur) news.push({ uid, institutionId: resolved, reqHosp: this.instName(resolved) });
      else if (cur.institutionId == null && resolved) news.push({ uid, institutionId: resolved, patch: true });
    }
    for (const n of news) {
      const row = n.patch
        ? await this.prisma.studyState.update({ where: { uid: n.uid }, data: { institutionId: n.institutionId } })
        : await this.prisma.studyState.create({
            data: {
              uid: n.uid, institutionId: n.institutionId, reqHosp: n.reqHosp,
              // 처음 보는 검사는 방금 장비에서 도착한 것이다 → **기사 확인 전(Unverified)**.
              // 도착 검사는 바로 보이되, 비응급 판독 쓰기는 Verify 뒤에만 허용한다.
              // 도착하자마자 판독을 허용하면 기사가 환자·검사정보를 고칠 틈이 없고,
              // 그 상태로 판독이 붙으면 더는 고칠 수 없다(RS≠W 규칙).
              ss: 'Unverified',
            },
          });
      if (!n.patch) await this.audit('system', 'study.arrived', n.uid, { institutionId: n.institutionId });
      byUid.set(n.uid, row as any);
    }

    const window = studyPageSlice(qido.filter(st => {
      const state = byUid.get(OrthancService.tag(st, '0020000D'));
      return state && this.visible(state, me) && this.studyAccess.matches(access,OrthancService.tag(st,'0020000D'),st);
    }), st => OrthancService.tag(st, '0020000D'), page, owner);
    const pageUids = window.rows.map(st => OrthancService.tag(st, '0020000D'));
    const changedAccess = (rows: any[]) => rows.length !== pageUids.length || rows.some(state => !this.visible(state, me)
      || state.institutionId !== byUid.get(state.uid)?.institutionId || state.teleInstitutionId !== byUid.get(state.uid)?.teleInstitutionId
      || (byUid.get(state.uid)?.rs !== undefined && (state.rs !== byUid.get(state.uid).rs
        || state.preDoc !== byUid.get(state.uid).preDoc || state.preReviewer !== byUid.get(state.uid).preReviewer)));
    const accessConflict = () => new ConflictException({ code:'STUDY_LIST_CHANGED', message:'검사 접근 범위가 바뀌었습니다. 새로고침하세요.' });
    if (page) {
      // Enumerate only identity/scope first; report state and overlays belong to the selected page.
      const details = await this.prisma.studyState.findMany({ where: { uid: { in: pageUids } } });
      if (changedAccess(details)) throw accessConflict();
      for (const state of details) byUid.set(state.uid, state);
    }
    const reports = await this.prisma.report.findMany({ where: { uid: { in: pageUids } } });
    const repByUid = new Map(reports.map(r => [r.uid, r]));
    // 목록에도 내 초안을 함께 싣는다. 30초 폴링 응답이 초안 없이 오면
    // 클라이언트 병합이 쓰고 있던 초안을 지운다.
    const drafts = await this.prisma.reportDraft.findMany({ where: { author: c.actor, uid: { in: pageUids } } });
    const draftByUid = new Map(drafts.map(d => [d.uid, d]));

    // Only presence/version leaves this query, never the note body or author.
    const noteRows = !pageUids.length ? [] : await this.prisma.$queryRaw<{ studyUid: string; version: number; present: boolean }[]>`
      SELECT DISTINCT ON (n."studyUid") n."studyUid", n.version, (n.text <> '') AS present
      FROM "TechNoteRevision" n JOIN "StudyState" s ON s.uid = n."studyUid"
      WHERE (s."institutionId" = ${me} OR s."teleInstitutionId" = ${me})
        AND n."studyUid" IN (${Prisma.join(pageUids)})
      ORDER BY n."studyUid", n.version DESC`;
    const noteByUid = new Map(noteRows.map(n => [n.studyUid, { version: n.version, present: n.present }]));

    const assignments = await this.prisma.readerAssignment.findMany({where:{studyUid:{in:pageUids},institutionId:me}});
    const assignmentByUid=new Map(assignments.map(a=>[a.studyUid,a]));
    // S4-U3 axis C: only receipts this institution's own Gateway credentials wrote, and below only on its own rows.
    const receipts = await this.prisma.gatewayReceipt.findMany({ where: { studyUid: { in: pageUids }, institutionId: me } });
    const receiptByUid = new Map(receipts.map(r => [r.studyUid, r]));
    // S4-U5: the orders this page's own linked rows point to, one read pinned to the caller's institution and
    // taken before the access re-check below. study-identity.ts judges each pair; no Order value is sent.
    const linked = [...new Set(pageUids.map(uid => byUid.get(uid))
      .filter(s => s?.institutionId === me && s.matched === 'M' && s.orderOid).map(s => s.orderOid))];
    const identityOrders = linked.length ? await this.prisma.order.findMany({
      where: { oid: { in: linked }, institutionId: me }, select: ORDER_IDENTITY_SELECT }) : [];
    const identityByOid = new Map(identityOrders.map(o => [o.oid, o]));
    const sourceRows = page ? await this.orthanc.studiesByUid(pageUids) : window.rows;
    const out: any[] = [];
    for (const st of sourceRows) {
      const uid = OrthancService.tag(st, '0020000D');
      const s = byUid.get(uid);
      if (!s || !this.visible(s, me)) continue;   // ← 기관 경계. 여기가 전부다.

      const birth = OrthancService.tag(st, '00100030');
      const date = OrthancService.tag(st, '00080020');
      const patientId = OrthancService.tag(st, '00100020');
      out.push({
        uid,
        techNote: noteByUid.get(uid) ?? { version: 0, present: false },
        readerAssignment: s.institutionId===me ? (()=>{const a=assignmentByUid.get(uid);return {revision:a?.revision??0,reader:a?.readerSub?{sub:a.readerSub,actor:a.readerActor,name:a.readerName}:null};})() : null,
        // null = no Gateway report: normal (device-direct, older agent, not installed), never failure or offline.
        // A tele receiver sees null too; the sender's transport is not its business.
        gatewayReceipt: s.institutionId === me ? projectGatewayReceipt(receiptByUid.get(uid)) : null,
        // S4-U5: judged on this row's server-read tags only, never on ov/orig. A tele receiver's row is null.
        orderIdentity: s.institutionId === me
          ? orderIdentity(me, s, identityByOid.get(s.orderOid), key => OrthancService.tag(st, key)) : null,
        // null은 unknown이다. 0은 QIDO가 실제로 0을 말했을 때만 나간다.
        count: qidoCount(st, '00201208'),
        series: qidoCount(st, '00201206'),
        acc: OrthancService.tag(st, '00080050'),
        id: patientId,
        // 화면 오버레이가 PatientID를 바꿔도 Related의 기관 경계는 원본 DICOM 값에 남는다.
        sourcePatientKey: s.institutionId == null || !patientId ? null : `${s.institutionId}|${patientId}`,
        name: OrthancService.tag(st, '00100010').replace(/\^/g, ' '),
        birth, date,
        sex: OrthancService.tag(st, '00100040'),
        modality: st['00080061']?.Value?.join(',') ?? '',
        desc: OrthancService.tag(st, '00081030'),
        institutionName: this.instName(s.institutionId),
        // 이 검사가 우리에게 원격판독으로 넘어온 것인가 (화면에서 구분해 보여준다)
        tele: s.teleInstitutionId === me && s.institutionId !== me,
        state: toClient(s, repByUid.get(uid), c.actor, draftByUid.get(uid)),
      });
    }
    // A concurrent Preliminary transition can change who may read the report too.
    const current = await this.prisma.studyState.findMany({ where: { uid: { in: pageUids } },
      select: { uid:true, institutionId:true, teleInstitutionId:true, rs:true, preDoc:true, preReviewer:true } });
    if (changedAccess(current)) throw accessConflict();
    // S4-U2: the order side is read with the page that completes the list and BEFORE the access
    // re-check below, so a policy change during this request refuses the whole answer.
    const orderRows = !page || window.pagination?.next === null ? await this.orderSide(me) : null;
    // Absence is judged against the whole enumeration, never against this page's window. It is sent
    // once, with the page that completes the list, so a client never merges two absence answers.
    const notObserved = !page || window.pagination?.next === null ? this.notObserved(qido, states, me, access, observedAt) : undefined;
    // S4-F01V: an own study with no observed image still has its last Gateway receipt. Only receipts this
    // institution's own credentials wrote are read, before the access re-check like every other tenant read here.
    const absentReceipts = notObserved?.length ? await this.prisma.gatewayReceipt.findMany({ where: { studyUid: { in: notObserved.map(row => row.uid) }, institutionId: me } }) : [];
    await this.studyAccess.unchanged(c,access);
    // The key is added only when such a receipt exists; without one the item keeps its three fields.
    const absentReceiptByUid = new Map(absentReceipts.map(r => [r.studyUid, r]));
    for (const row of notObserved ?? []) { const receipt = absentReceiptByUid.get(row.uid); if (receipt) Object.assign(row, { gatewayReceipt: projectGatewayReceipt(receipt) }); }
    const orderReconciliation = orderRows ? this.orderReconciliation(qido, orderRows, me, access) : undefined;
    return { studies: out, serverTime: new Date().toISOString(), observedAt,
      ...(notObserved === undefined ? {} : { notObserved }),
      ...(orderReconciliation === undefined ? {} : { orderReconciliation }), ...(page ? { pagination: window.pagination } : {}) };
  }

  /**
   * S4-U1b 관측되지 않은 자기 기관 검사. **성공한** QIDO 열거 전체에 행이 없는 StudyState만 낸다.
   * 필드는 uid·origin·createdAt뿐이다 — QIDO 행이 없으니 환자 필드는 존재하지 않고, 지어내지 않는다.
   * 열거의 어느 행이라도 UID를 확인할 수 없으면 부재를 판정할 수 없으므로 `null`(모름)이다.
   * 원격판독으로 받은 검사는 자기 기관 행이 아니다. 접근 조건은 UID만으로 판정한다 — 메타데이터
   * 조건이 걸린 계정에는 원본 태그가 없는 행이 맞을 수 없으므로 보이지 않는다(닫힌 쪽으로 실패).
   * 열거가 끝난 뒤 생긴 행은 이 열거로 판정할 수 없으므로 다음 관측으로 넘긴다.
   */
  private notObserved(qido: any, states: any[], me: string, access: AccessSnapshot, observedAt: string) {
    if (!Array.isArray(qido)) return null;
    const present = new Set<string>();
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) return null;
      present.add(uid);
    }
    const out: { uid: string; origin: string; createdAt: string }[] = [];
    for (const s of states) {
      if (s.institutionId !== me || present.has(s.uid) || !this.studyAccess.matches(access, s.uid)) continue;
      if (!(s.createdAt instanceof Date) || typeof s.origin !== 'string') return null;
      const createdAt = s.createdAt.toISOString();
      if (createdAt > observedAt) continue;
      out.push({ uid: s.uid, origin: s.origin, createdAt });
    }
    return out.sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  }

  /**
   * S4-U2 오더 측 대사의 입력. 기관 조건을 조회에 건다 — 남의 기관 오더와 StudyState는 읽지도 않는다.
   * 필요한 칸만 고른다. 환자 칸은 이 면으로 나가지 않는다.
   */
  private orderSide(me: string) {
    return Promise.all([
      this.prisma.order.findMany({ where: { institutionId: me },
        select: { oid: true, institutionId: true, accession: true, matched: true, studyUid: true } }),
      this.prisma.studyState.findMany({ where: { institutionId: me },
        select: { uid: true, institutionId: true, matched: true, orderOid: true } }),
    ]);
  }

  /**
   * S4-U2 오더 측 대사 — **엔지니어링 전용**(`order-reconciliation.ts`). notObserved와 같은 성공한 열거로
   * 판정한다. 열거의 어느 행이라도 UID를 확인할 수 없으면 관측 여부를 말할 수 없으므로 `null`(모름)이다.
   * 검사 쪽 accession은 서버가 읽은 원본 태그(00080050)뿐이다 — ov/orig는 입력이 아니다.
   */
  private orderReconciliation(qido: any, [orders, links]: [any[], any[]], me: string, access: AccessSnapshot) {
    if (!Array.isArray(qido)) return null;
    const observed = new Map<string, any>();
    for (const st of qido) {
      const uid = OrthancService.tag(st, '0020000D');
      if (!uid) return null;
      observed.set(uid, st);
    }
    return reconcileOrders({ me, restricted: access.policy.restricted, orders, links, observed,
      accessionOf: row => OrthancService.tag(row, '00080050'),
      permitted: (uid, row) => this.studyAccess.matches(access, uid, row) });
  }

  /** 프론트가 켜질 때 한 번에 받아가는 묶음 — 전부 내 기관 것만 */
  async bootstrap(c: Caller, query?: any) {
    const me = inst(c);
    const omitStates = query?.states === 'omit';
    if (query && (Object.keys(query).some(key => key !== 'states') || (Object.keys(query).length && !omitStates)))
      throw new BadRequestException('초기 목록 요청 형식이 잘못되었습니다');
    const access=await this.studyAccess.snapshot(c);
    const [stateRows, orderRows] = await Promise.all([
      omitStates ? Promise.resolve([]) : this.prisma.studyState.findMany({
        where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
      }),
      this.prisma.order.findMany({ where: { institutionId: me }, orderBy: { sched: 'asc' } }),
    ]);
    const permitted=await this.studyAccess.allowed(c,[...stateRows.map(s=>s.uid),...orderRows.flatMap(o=>o.studyUid?[o.studyUid]:[])]);
    const states=stateRows.filter(s=>permitted.has(s.uid));
    const orders=orderRows.filter(o=>o.studyUid?permitted.has(o.studyUid):!access.policy.restricted);
    const reports = omitStates ? [] : await this.prisma.report.findMany({
      where: { uid: { in: states.map(s => s.uid) } },
    });
    const byUid = Object.fromEntries(reports.map(r => [r.uid, r]));
    // 켤 때 내 초안도 함께 — "어제 쓰다 만 것"이 PC를 바꿔도 따라온다.
    // 필터·상용구를 계정에 붙인 것과 같은 이유다 (§6-A-4).
    const drafts = omitStates ? [] : await this.prisma.reportDraft.findMany({ where: { author: c.actor } });
    const draftByUid = Object.fromEntries(drafts.map(d => [d.uid, d]));
    await this.studyAccess.unchanged(c,access);
    const prefs = await this.prefs(c);   // 필터·상용구도 첫 요청에 함께 (왕복을 늘리지 않는다)
    return {
      ...(omitStates ? { statesOmitted:true } : {}),
      dictation: (() => { const { url, ...capability } = asrConfiguration(); return capability; })(),
      me: { actor: c.actor, roles: c.roles, institution: me, institutionName: this.instName(me) },
      filters: prefs.filters,
      templates: prefs.templates,
      institutions: this.institutions.map(i => ({ id: i.id, name: i.name, type: i.type })),
      states: Object.fromEntries(states.map(s => [s.uid, toClient(s, byUid[s.uid], c.actor, draftByUid[s.uid])])),
      orders: orders.map(o => ({
        oid: o.oid, id: o.patientId, name: o.name, sex: o.sex, birth: o.birth,
        sched: o.sched, modality: o.modality, desc: o.descr, ward: o.ward,
        reqDoc: o.reqDoc, matched: o.matched, studyUid: o.studyUid,
      })),
      serverTime: new Date().toISOString(),
    };
  }

  // ══════════════════ 쓰기 ══════════════════

  // ══════════════════ 개인 설정 (필터·상용구) ══════════════════
  //
  // 둘 다 **계정에 붙는다.** 브라우저가 아니라.
  // 판독의는 자기 필터를 하루 종일 쓴다. PC를 바꿨다고 초기화되면 깨지는 건
  // 작업이 아니라 신뢰다 (교훈 §6 — HPACS가 5년간 반복한 버그 카테고리).
  //
  // 반대로 **모니터 구성에 딸린 것(필름박스 레이아웃 등)은 계정에 두면 안 된다.**
  // HPACS도 Hanging Protocol만은 "계정 + 컴퓨터"별로 기억하도록 따로 만들었다 —
  // 집의 1대 모니터와 병원의 3대 모니터에 같은 레이아웃을 강요할 수 없기 때문.
  // 계정에 저장할 것과 기기에 남길 것을 나누는 기준이 여기 있다.

  /** 내 필터 + 내 상용구. 처음 보는 계정이면 기본 상용구를 넣어준다. */
  async prefs(c: Caller) {
    const owner = c.actor;
    /**
     * 새 계정에는 기본 상용구를 넣어준다 — 빈 목록은 버그로 보이기 때문.
     * (HPACS도 "신규계정인 경우 Reading Template 생성이 되지 않았던 오류"를 고친 적이 있다)
     *
     * **단, 판독의에게만.** 상용구는 판독문을 쓰는 도구다. 방사선사는 판독문을 안 쓰므로
     * 그 사람 계정에 판독 상용구가 세 개 생기면, 못 쓰는 기능이 목록에 놓여 있는 셈이다.
     * 화면에 있는데 아무것도 못 하는 것은 안내가 아니라 소음이다.
     */
    const canRead = c.roles?.includes('radiologist') || c.roles?.includes('admin');
    const n = await this.prisma.readingTemplate.count({ where: { owner } });
    if (n === 0 && canRead)
      await this.prisma.readingTemplate.createMany({
        data: SEED_TEMPLATES.map(t => ({ ...t, owner })),
      });

    const [filters, templates] = await Promise.all([
      this.prisma.userFilter.findMany({ where: { owner }, orderBy: { createdAt: 'asc' } }),
      this.prisma.readingTemplate.findMany({ where: { owner }, orderBy: [{ ord: 'asc' }, { id: 'asc' }] }),
    ]);
    return {
      filters: filters.map(f => ({ ...f, cols: parse(f.cols) ?? {} })),
      templates,
    };
  }

  private workspaceOwner(c: Caller) {
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용 배치입니다');
    need(c.roles, c.roles.includes('technician') ? 'technician' : 'radiologist', '작업공간 배치');
    const institution = inst(c);
    if (![institution, c.sub].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256))
      throw new ForbiddenException('계정 정보를 확인할 수 없습니다');
    return { institution, subject: c.sub };
  }

  private workspaceValue(value: any) {
    const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fields = value?.version === 2 ? 'landscape,mode,portrait,reading,version' : 'landscape,mode,portrait,version';
    if (!object(value) || Object.keys(value).sort().join(',') !== fields ||
        ![1, 2].includes(value.version) || !['auto', 'portrait', 'landscape'].includes(value.mode) || JSON.stringify(value).length > 2048)
      throw new BadRequestException('작업공간 배치 형식이 잘못되었습니다');
    const clean: any = { version: value.version, mode: value.mode, portrait: {}, landscape: {} };
    for (const axis of ['portrait', 'landscape']) {
      if (!object(value[axis]) || Object.keys(value[axis]).some(k => !['main', 'top', 'related', 'prior'].includes(k)))
        throw new BadRequestException('작업공간 패널 형식이 잘못되었습니다');
      for (const [key, size] of Object.entries(value[axis])) {
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 1 || size > 16384)
          throw new BadRequestException('작업공간 패널 크기가 잘못되었습니다');
        clean[axis][key] = Math.round(size);
      }
    }
    if (value.version === 2) {
      const reading = value.reading;
      if (!object(reading) || Object.keys(reading).sort().join(',') !==
          'imageHeight,relatedHeight,relatedHidden,relatedListHeight,reportWidth,version' ||
          reading.version !== 1 || typeof reading.relatedHidden !== 'boolean')
        throw new BadRequestException('판독 작업공간 배치 형식이 잘못되었습니다');
      clean.reading = { version: 1 };
      for (const key of ['reportWidth', 'imageHeight', 'relatedHeight', 'relatedListHeight']) {
        const size = reading[key];
        if (size !== null && (!Number.isInteger(size) || size < 1 || size > 16384))
          throw new BadRequestException('판독 작업공간 패널 크기가 잘못되었습니다');
        clean.reading[key] = size;
      }
      clean.reading.relatedHidden = reading.relatedHidden;
    }
    return clean;
  }

  private readingPreferencesResult(owner: { institution: string; subject: string }, row: any) {
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      autoNote: row?.autoNote ?? null };
  }

  async readingPreferences(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.readingPreferences.findUnique({ where: { institution_subject: owner } });
    return this.readingPreferencesResult(owner, row);
  }

  async saveReadingPreferences(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'autoNote,expectedOwner,revision' ||
        typeof body.autoNote !== 'boolean' || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('메모 자동 열기 설정 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const conflict = () => new ConflictException('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.readingPreferences.create({ data: { ...owner, revision: 1, autoNote: body.autoNote } });
        const changed = await tx.readingPreferences.updateMany({ where: { ...owner, revision: body.revision },
          data: { autoNote: body.autoNote, revision: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        return tx.readingPreferences.findUnique({ where: { institution_subject: owner } });
      });
      return this.readingPreferencesResult(owner, row);
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  /**
   * 기관 공용(SITE) 행의 주인. 개인 행과 같은 표를 쓰되 `subject=''` 센티널로 구분한다
   * (StudyTagCatalog의 `ownerSub=''`와 같은 방식). 개인 경로의 `workspaceOwner()`는
   * subject가 비어 있지 않음을 계속 요구하므로, 빈 subject는 오직 이 경로에서만 나온다.
   */
  private siteOwner(c: Caller) {
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용 배치입니다');
    need(c.roles, c.roles.includes('technician') ? 'technician' : 'radiologist', '기관 Hanging Protocol');
    const institution = inst(c);
    if (typeof institution !== 'string' || institution.length === 0 || institution.length > 256)
      throw new ForbiddenException('계정 정보를 확인할 수 없습니다');
    return { institution, subject: '' };
  }

  private hangingProtocolResult(owner: { institution: string; subject: string }, row: any) {
    if (!row) return { owner, revision: 0, value: null };
    const value = row.value === null ? null : normalizeHangingProtocol(row.value);
    if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2147483647 || value === undefined)
      throw new ServiceUnavailableException('저장된 Hanging Protocol 설정을 확인할 수 없습니다');
    return { owner, revision: row.revision, value };
  }

  async hangingProtocols(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.hangingProtocolPreference.findUnique({ where: { institution_subject: owner } });
    return this.hangingProtocolResult(owner, row);
  }

  /**
   * 저장 요청의 형식·소유자·값 검사. 개인과 기관(SITE)이 같은 표·같은 스키마·같은 CAS를
   * 쓰므로 검사도 하나만 둔다. 기관은 `expectedOwner.subject`가 빈 문자열이어야 하고,
   * 개인은 비어 있지 않아야 하므로 소유자 대조만으로 두 범위가 서로 섞이지 않는다.
   */
  private hangingProtocolRequest(body: any, owner: { institution: string; subject: string }) {
    const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
    if (!object(body) || Object.keys(body).sort().join(',') !== 'expectedOwner,revision,value' ||
        !object(body.expectedOwner) || Object.keys(body.expectedOwner).sort().join(',') !== 'institution,subject' ||
        typeof body.expectedOwner.institution !== 'string' || typeof body.expectedOwner.subject !== 'string' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('Hanging Protocol 저장 요청 형식이 잘못되었습니다');
    if (body.expectedOwner.institution !== owner.institution || body.expectedOwner.subject !== owner.subject)
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const value = body.value === null ? null : normalizeHangingProtocol(body.value);
    if (value === undefined) throw new BadRequestException('Hanging Protocol 설정 형식이 잘못되었습니다');
    return value;
  }

  private async writeHangingProtocol(owner: { institution: string; subject: string }, revision: number,
      value: HangingProtocolLibrary | null, audit: ((tx: Prisma.TransactionClient, saved: any) => Promise<unknown>) | null) {
    const conflict = () => new ConflictException('Hanging Protocol 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    const stored: any = value === null ? Prisma.DbNull : value;
    try {
      return await this.prisma.$transaction(async tx => {
        let row: any;
        if (revision === 0) row = await tx.hangingProtocolPreference.create({ data: { ...owner, revision: 1, value: stored } });
        else {
          const changed = await tx.hangingProtocolPreference.updateMany({ where: { ...owner, revision },
            data: { value: stored, revision: { increment: 1 } } });
          if (changed.count !== 1) throw conflict();
          row = await tx.hangingProtocolPreference.findUnique({ where: { institution_subject: owner } });
        }
        if (audit) await audit(tx, row);
        return row;
      });
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  async saveHangingProtocols(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    const value = this.hangingProtocolRequest(body, owner);
    return this.hangingProtocolResult(owner, await this.writeHangingProtocol(owner, body.revision, value, null));
  }

  private siteHangingProtocolResult(owner: { institution: string; subject: string }, row: any, c: Caller) {
    // 개인 응답은 한 글자도 바꾸지 않는다. 기관 전용 필드는 이 응답에만 붙인다.
    return { ...this.hangingProtocolResult(owner, row),
      canManageSite: c.roles.includes('admin'), updatedAt: row?.updatedAt ?? null };
  }

  async siteHangingProtocols(c: Caller) {
    const owner = this.siteOwner(c);
    const row = await this.prisma.hangingProtocolPreference.findUnique({ where: { institution_subject: owner } });
    return this.siteHangingProtocolResult(owner, row, c);
  }

  async saveSiteHangingProtocols(body: any, c: Caller) {
    const owner = this.siteOwner(c);
    // 형식보다 권한을 먼저 본다. 관리자가 아닌 호출자는 본문으로 저장 경로를 떠볼 수 없다.
    need(c.roles, 'admin', '기관 Hanging Protocol 배포');
    const value = this.hangingProtocolRequest(body, owner);
    const row = await this.writeHangingProtocol(owner, body.revision, value, (tx, saved) =>
      tx.auditLog.create({ data: { actor: c.actor, action: 'hanging-protocol.site.' + (value === null ? 'reset' : 'save'),
        target: owner.institution, detail: JSON.stringify({ revision: saved?.revision ?? null }) } }));
    return this.siteHangingProtocolResult(owner, row, c);
  }

  private validShortcutBindings(v: any) {
    const names = ['list','image','prior','report','context','note','tools','nativeTools','previous','next'];
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === names.slice().sort().join(',') && new Set(Object.values(v)).size === names.length && Object.values(v).every((key: any) => typeof key === 'string' && /^(Digit[1-9]|Key[A-Z]|ArrowLeft|ArrowRight)$/.test(key) && !['KeyC','Digit8'].includes(key));
  }

  private shortcutPreferencesResult(owner: { institution: string; subject: string }, row: any) {
    const invalid = !!row && !this.validShortcutBindings(row.bindings);
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      bindings: invalid ? null : row?.bindings ?? null, invalid };
  }

  async workspaceShortcuts(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.workspaceShortcuts.findUnique({ where: { institution_subject: owner } });
    return this.shortcutPreferencesResult(owner, row);
  }

  async saveWorkspaceShortcuts(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'bindings,expectedOwner,revision' ||
        !this.validShortcutBindings(body.bindings) || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('단축키 설정 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const conflict = () => new ConflictException('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.workspaceShortcuts.create({ data: { ...owner, revision: 1, bindings: body.bindings } });
        const changed = await tx.workspaceShortcuts.updateMany({ where: { ...owner, revision: body.revision },
          data: { bindings: body.bindings, revision: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        return tx.workspaceShortcuts.findUnique({ where: { institution_subject: owner } });
      });
      return this.shortcutPreferencesResult(owner, row);
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  private appearanceResult(owner: { institution: string; subject: string }, row: any) {
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0, sizes: row?.sizes ?? null };
  }

  async readingAppearance(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.readingAppearance.findUnique({ where: { institution_subject: owner } });
    return this.appearanceResult(owner, row);
  }

  async saveReadingAppearance(body: any, c: Caller) {
    const owner = this.workspaceOwner(c);
    const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
    const choices = (v: any, allowed: string[]) => object(v) && Object.keys(v).sort().join(',') === 'current,list,prior,version' &&
      v.version === 1 && ['list', 'current', 'prior'].every(k => typeof v[k] === 'string' && allowed.includes(v[k]));
    const validDock = (v: any, version: number) => object(v) && Object.keys(v).sort().join(',') === (version >= 5 ? 'autoHide,panel,placement,version' : 'panel,placement,version') &&
      v.version === (version >= 5 ? 2 : 1) && (version < 5 || typeof v.autoHide === 'boolean') && ['top', 'bottom'].includes(v.placement) && [-1, 0, 1].includes(v.panel);
    const toolbarIds = ['MeasurementTools','Zoom','Pan','TrackballRotate','WindowLevel','Capture','Layout','Crosshairs','MoreTools'];
    const validToolbar = (v: any) => object(v) && v.version === 1 && Object.keys(v).sort().join(',') === 'hidden,order,version' &&
      Array.isArray(v.order) && v.order.length === toolbarIds.length && new Set(v.order).size === toolbarIds.length && v.order.every((id: any) => toolbarIds.includes(id)) &&
      Array.isArray(v.hidden) && new Set(v.hidden).size === v.hidden.length && v.hidden.every((id: any) => toolbarIds.includes(id) && id !== 'Zoom');
    const positions = ['top-left','top-right','bottom-left','bottom-right'], modalities = ['CT','MR','CR','DX','US','MG','XA','RF','PT','NM','OT'];
    const validViewerProfile = (p: any, overrides: boolean) => object(p) && Object.keys(p).sort().join(',') === (overrides ? 'color,date,description,fieldPositions,font,name,overrides,position,size' : 'color,date,description,fieldPositions,font,name,position,size') &&
      [12,14,16,18,20].includes(p.size) && ['default','sans','serif','mono'].includes(p.font) && ['default','warm','cool','white'].includes(p.color) && positions.includes(p.position) &&
      ['name','date','description'].every(k => typeof p[k] === 'boolean') && object(p.fieldPositions) && Object.keys(p.fieldPositions).sort().join(',') === 'date,description,name' &&
      ['name','date','description'].every(k => positions.includes(p.fieldPositions[k])) && (!overrides || object(p.overrides) && Object.keys(p.overrides).every(k => modalities.includes(k) && validViewerProfile(p.overrides[k], false)));
    const validViewer = (v: any, appearanceVersion: number) => object(v) && v.version === (appearanceVersion === 9 ? 3 : appearanceVersion === 8 ? 2 : 1) && Object.keys(v).sort().join(',') === 'current,prior,version' &&
      ['current', 'prior'].every(role => { const p = v[role]; return v.version === 3 ? validViewerProfile(p, true) : object(p) && Object.keys(p).sort().join(',') === (v.version === 2 ? 'color,date,description,font,name,position,size' : 'color,date,description,font,name,size') &&
        [12,14,16,18,20].includes(p.size) && ['default','sans','serif','mono'].includes(p.font) && ['default','warm','cool','white'].includes(p.color) &&
        (v.version === 1 || positions.includes(p.position)) && ['name','date','description'].every(k => typeof p[k] === 'boolean'); });
    const validMpr = (v: any) => object(v) && v.version === 1 && Object.keys(v).sort().join(',') === 'display,mouse,progressive,sync,version' && typeof v.progressive === 'boolean' &&
      object(v.display) && Object.keys(v.display).sort().join(',') === 'autoHideCrosshair,cube,demographics,orientation,sample,scale,thickness,windowing,zoom' && Object.values(v.display).every(x => typeof x === 'boolean') &&
      object(v.mouse) && Object.keys(v.mouse).sort().join(',') === 'left,middle,right' && new Set(Object.values(v.mouse)).size === 3 && Object.values(v.mouse).every(x => ['WindowLevel','Pan','Zoom','StackScroll'].includes(x as string)) &&
      object(v.sync) && Object.keys(v.sync).sort().join(',') === 'windowing,zoom' && Object.values(v.sync).every(x => typeof x === 'boolean');
    const validAppearance = (v: any) => object(v) && ['list', 'current', 'prior'].every(k => [12, 14, 16, 18, 20].includes(v[k])) &&
      (v.version === 1 ? Object.keys(v).sort().join(',') === 'current,list,prior,version' :
        [2, 3, 4, 5, 6, 7, 8, 9].includes(v.version) && Object.keys(v).sort().join(',') === (v.version >= 7 ? 'colors,current,dock,fonts,list,mpr,prior,toolbar,version,viewer' : v.version === 6 ? 'colors,current,dock,fonts,list,prior,toolbar,version,viewer' : v.version >= 4 ? 'colors,current,dock,fonts,list,prior,version,viewer' : v.version === 3 ? 'colors,current,dock,fonts,list,prior,version' : 'colors,current,fonts,list,prior,version') &&
        (v.version < 3 || validDock(v.dock, v.version)) && (v.version < 4 || validViewer(v.viewer, v.version)) && (v.version < 6 || validToolbar(v.toolbar)) && (v.version < 7 || validMpr(v.mpr)) &&
        choices(v.fonts, ['default', 'sans', 'serif', 'mono']) && choices(v.colors, ['default', 'warm', 'cool', 'white']));
    if (!object(body) || Object.keys(body).sort().join(',') !== 'expectedOwner,revision,sizes' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647 ||
        !validAppearance(body.sizes))
      throw new BadRequestException('글자 설정 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    const select = (v: any) => ({ version: 1, list: v.list, current: v.current, prior: v.prior });
    const sizes = body.sizes.version === 1 ? select(body.sizes) :
      { ...select(body.sizes), version: body.sizes.version, fonts: select(body.sizes.fonts), colors: select(body.sizes.colors),
        ...(body.sizes.version >= 3 ? { dock: { version: body.sizes.dock.version, placement: body.sizes.dock.placement, panel: body.sizes.dock.panel, ...(body.sizes.version >= 5 ? { autoHide: body.sizes.dock.autoHide } : {}) } } : {}),
        ...(body.sizes.version >= 6 ? { toolbar: { version: 1, order: body.sizes.toolbar.order.slice(), hidden: body.sizes.toolbar.hidden.slice() } } : {}),
        ...(body.sizes.version >= 7 ? { mpr: { version: 1, progressive: body.sizes.mpr.progressive, display: { ...body.sizes.mpr.display }, mouse: { ...body.sizes.mpr.mouse }, sync: { ...body.sizes.mpr.sync } } } : {}),
        ...(body.sizes.version >= 4 ? { viewer: { version: body.sizes.viewer.version, ...Object.fromEntries(['current','prior'].map(role => { const p = body.sizes.viewer[role];
          const copyProfile = (value: any) => ({ size:value.size, font:value.font, color:value.color, name:value.name, date:value.date, description:value.description, position:value.position, fieldPositions:{ name:value.fieldPositions.name, date:value.fieldPositions.date, description:value.fieldPositions.description } });
          return [role, body.sizes.viewer.version === 3 ? { ...copyProfile(p), overrides:Object.fromEntries(Object.keys(p.overrides).map(modality => [modality, copyProfile(p.overrides[modality])])) } : { size:p.size, font:p.font, color:p.color, name:p.name, date:p.date, description:p.description, ...(body.sizes.viewer.version === 2 ? { position:p.position } : {}) }]; })) } } : {}) };
    const conflict = () => new ConflictException('계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요');
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.readingAppearance.create({ data: { ...owner, revision: 1, sizes } });
        // Check the stored format in the same update as CAS; old clients must not
        // erase fields introduced by a newer display-preference version.
        const changed = await tx.readingAppearance.updateMany({ where: { ...owner, revision: body.revision,
          OR: Array.from({ length: body.sizes.version }, (_, i) => ({ sizes: { path: ['version'], equals: i + 1 } })) },
          data: { sizes, revision: { increment: 1 } } });
        if (changed.count !== 1) throw conflict();
        return tx.readingAppearance.findUnique({ where: { institution_subject: owner } });
      });
      return this.appearanceResult(owner, row);
    } catch (e) {
      if ((e as any)?.code === 'P2002') throw conflict();
      throw e;
    }
  }

  private workspaceResult(owner: { institution: string; subject: string }, row: any) {
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      layout: row?.value == null ? null : this.workspaceValue(JSON.parse(row.value)), updatedAt: row?.updatedAt ?? null };
  }

  async workspaceLayout(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.workspaceLayout.findUnique({ where: { institution_subject: owner } });
    return this.workspaceResult(owner, row);
  }

  async writeWorkspaceLayout(body: any, c: Caller, clear: boolean) {
    const owner = this.workspaceOwner(c);
    const fields = clear ? 'expectedOwner,revision' : 'expectedOwner,layout,revision';
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== fields ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('배치 저장 요청 형식이 잘못되었습니다');
    // A stale tab must not write its old account's preferences under a newly logged-in session.
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException({ code: 'WORKSPACE_OWNER_CHANGED', message: '계정이 변경되었습니다. 다시 로그인한 뒤 여세요.' });
    const layout = clear ? null : this.workspaceValue(body.layout);
    const value = clear ? null : JSON.stringify(layout);
    const conflict = () => new ConflictException({ code: 'WORKSPACE_CONFLICT', message: '다른 창에서 서버 배치가 변경되었습니다. 서버 배치를 불러온 뒤 다시 시도하세요.' });
    try {
      const row = await this.prisma.$transaction(async tx => {
        const current = await tx.workspaceLayout.findUnique({ where: { institution_subject: owner } });
        if ((current?.revision ?? 0) !== body.revision) throw conflict();
        // A v1 client can know the latest revision but cannot retain v2 reading
        // settings. CAS ties this version check to the row being replaced.
        if (!clear && current?.value != null && this.workspaceValue(JSON.parse(current.value)).version > layout.version)
          throw conflict();
        if (!current) return tx.workspaceLayout.create({ data: { ...owner, revision: 1, value } });
        const updated = await tx.workspaceLayout.updateMany({ where: { ...owner, revision: body.revision },
          data: { value, revision: { increment: 1 } } });
        if (updated.count !== 1) throw conflict();
        return tx.workspaceLayout.findUnique({ where: { institution_subject: owner } });
      });
      return this.workspaceResult(owner, row);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw conflict();
      throw error;
    }
  }

  private columnsResult(owner: { institution: string; subject: string }, row: any) {
    const columns = row?.value == null ? null : normalizeWorklistColumns(JSON.parse(row.value));
    if (row?.value != null && !columns) throw new ServiceUnavailableException('저장된 열 설정 형식을 확인할 수 없습니다');
    return { owner: [owner.institution, owner.subject], revision: row?.revision ?? 0,
      columns, updatedAt: row?.updatedAt ?? null };
  }

  async worklistColumns(c: Caller) {
    const owner = this.workspaceOwner(c);
    const row = await this.prisma.worklistColumns.findUnique({ where: { institution_subject: owner } });
    return this.columnsResult(owner, row);
  }

  async writeWorklistColumns(body: any, c: Caller, clear: boolean) {
    const owner = this.workspaceOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join() !== (clear ? 'expectedOwner,revision' : 'columns,expectedOwner,revision') ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('열 설정 저장 요청 형식이 잘못되었습니다');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify([owner.institution, owner.subject]))
      throw new ConflictException({ code: 'COLUMNS_OWNER_CHANGED', message: '계정이 변경되었습니다. 다시 로그인하세요.' });
    const columns = clear ? null : normalizeWorklistColumns(body.columns);
    if (!clear && !columns) throw new BadRequestException('열 설정 형식이 잘못되었습니다');
    const value = clear ? null : JSON.stringify(columns);
    const conflict = () => new ConflictException({ code: 'COLUMNS_CONFLICT', message: '다른 창에서 열 설정이 변경되었습니다. 서버 설정을 다시 확인하세요.' });
    try {
      const row = await this.prisma.$transaction(async tx => {
        if (body.revision === 0) return tx.worklistColumns.create({ data: { ...owner, revision: 1, value } });
        const updated = await tx.worklistColumns.updateMany({ where: { ...owner, revision: body.revision }, data: { value, revision: { increment: 1 } } });
        if (updated.count !== 1) throw conflict();
        return tx.worklistColumns.findUnique({ where: { institution_subject: owner } });
      });
      return this.columnsResult(owner, row);
    } catch (error) {
      if ((error as any)?.code === 'P2002') throw conflict();
      throw error;
    }
  }

  /** 필터 저장 (같은 이름이면 덮어쓴다 — 이름이 곧 사용자에게는 그 필터다) */
  async saveFilter(body: any, c: Caller) {
    const owner = c.actor;
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('필터 이름이 필요합니다');

    // Old clients omit these fields; undefined must preserve existing metadata.
    let folder: string | undefined;
    if (body.folder !== undefined) folder = folderPath(body.folder, true);
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000))
      throw new BadRequestException('검색 설명은 1000자 이내로 입력하세요');
    if (body.ordinal !== undefined && (!Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal > 9999))
      throw new BadRequestException('표시 순서는 0~9999의 정수로 입력하세요');
    const data = {
      folder, description: body.description, ordinal: body.ordinal,
      mode: body.mode ?? 'Radiology',
      quick: String(body.quick ?? ''),
      days: Number.isFinite(+body.days) ? +body.days : -1,
      cols: dump(body.cols ?? {}) ?? '{}',
      sortKey: body.sortKey ?? null,
      sortDir: +body.sortDir || 0,
      isDefault: !!body.isDefault,
    };

    // Copies are create-only even when another tab just claimed the name.
    if (body.createOnly === true) {
      try {
        const saved = await this.prisma.$transaction(async tx => {
          await this.lockFilterCollection(tx, owner);
          const created = await tx.userFilter.create({ data: { owner, name, ...data } });
          if (data.isDefault) await tx.userFilter.updateMany({
            where: { owner, id: { not: created.id } }, data: { isDefault: false },
          });
          return created;
        });
        return { ...saved, cols: parse(saved.cols) ?? {} };
      } catch (error) {
        if ((error as any)?.code === 'P2002') throw new ConflictException('같은 이름의 검색이 있습니다. 다른 이름으로 저장하세요. 기존 검색은 변경하지 않았습니다.');
        throw error;
      }
    }

    // 기본 필터는 하나뿐이다. 새로 지정하면 이전 것이 풀린다 —
    // 두 개가 기본이면 로그인할 때마다 어느 쪽이 걸릴지 모른다.
    const saved = await this.prisma.$transaction(async tx => {
      await this.lockFilterCollection(tx, owner);
      if (data.isDefault) await tx.userFilter.updateMany({ where: { owner }, data: { isDefault: false } });
      return tx.userFilter.upsert({
        where: { owner_name: { owner, name } },
        create: { owner, name, ...data }, update: data,
      });
    });
    return { ...saved, cols: parse(saved.cols) ?? {} };
  }

  /** 기본 필터 지정/해제 */
  async setDefaultFilter(id: number, on: boolean, c: Caller) {
    const owner = c.actor;
    await this.prisma.$transaction(async tx => {
      await this.lockFilterCollection(tx, owner);
      const f = await tx.userFilter.findUnique({ where: { id } });
      if (!f || f.owner !== owner) throw new NotFoundException('필터를 찾을 수 없습니다');
      if (on) await tx.userFilter.updateMany({ where: { owner }, data: { isDefault: false } });
      await tx.userFilter.update({ where: { id }, data: { isDefault: on } });
    });
    return { ok: true };
  }

  async deleteFilter(id: number, c: Caller) {
    // 남의 것을 지우지 못하게 owner를 조건에 넣는다. 찾아서 검사하고 지우면
    // 그 사이가 벌어질 수 있으므로 조건을 삭제문 안에 둔다.
    await this.prisma.$transaction(async tx => {
      await this.lockFilterCollection(tx, c.actor);
      const r = await tx.userFilter.deleteMany({ where: { id, owner: c.actor } });
      if (!r.count) throw new NotFoundException('필터를 찾을 수 없습니다');
    });
    return { ok: true };
  }

  private lockFilterCollection(tx: Prisma.TransactionClient, owner: string, increment = 1) {
    // A single PostgreSQL upsert locks this owner's row until the transaction ends.
    return tx.userFilterCollection.upsert({
      where: { owner }, create: { owner, revision: increment, folders: [] },
      update: { revision: { increment } },
    });
  }

  private filterCollectionOwner(c: Caller) {
    if (c.kind !== 'member' || !c.sub || !c.actor) throw new ForbiddenException('개인 계정으로 로그인하세요');
    return [inst(c), c.sub];
  }

  private async filterCollectionSnapshot(tx: Prisma.TransactionClient, c: Caller) {
    const collection = await tx.userFilterCollection.findUnique({ where: { owner: c.actor } });
    const filters = await tx.userFilter.findMany({ where: { owner: c.actor }, orderBy: { id: 'asc' } });
    return { owner: this.filterCollectionOwner(c), revision: collection?.revision ?? 0,
      folders: folderEntries(collection?.folders ?? []),
      filters: filters.map(filter => ({ ...filter, cols: parse(filter.cols) ?? {} })) };
  }

  async readFilterFolders(c: Caller) {
    this.filterCollectionOwner(c);
    return this.prisma.$transaction(tx => this.filterCollectionSnapshot(tx, c),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async writeFilterFolders(body: any, c: Caller) {
    const owner = this.filterCollectionOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'command,expectedOwner,revision' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('검색 모음 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    return this.prisma.$transaction(async tx => {
      const collection = await this.lockFilterCollection(tx, c.actor);
      if (collection.revision !== body.revision + 1)
        throw new ConflictException('다른 화면에서 검색 모음이 변경되었습니다. 편집 내용을 확인한 뒤 다시 불러오세요');
      const searches = await tx.userFilter.findMany({ where: { owner: c.actor }, select: { id: true, folder: true } });
      const result = folderAction(collection.folders, searches, body.command);
      for (const move of result.moves) {
        const changed = await tx.userFilter.updateMany({ where: { id: move.id, owner: c.actor }, data: { folder: move.folder } });
        if (changed.count !== 1) throw new ConflictException('선택한 검색이 변경되었습니다');
      }
      if (result.deletes.length) {
        const changed = await tx.userFilter.deleteMany({ where: { owner: c.actor, id: { in: result.deletes } } });
        if (changed.count !== result.deletes.length) throw new ConflictException('선택한 검색이 변경되었습니다');
      }
      await tx.userFilterCollection.update({ where: { owner: c.actor }, data: { folders: result.folders } });
      return this.filterCollectionSnapshot(tx, c);
    });
  }

  private lockSharedFilters(tx: Prisma.TransactionClient, c: Caller, increment: number) {
    return tx.sharedFilterLibrary.upsert({
      where: { institution: inst(c) },
      create: { institution: inst(c), revision: increment, folders: [], filters: [], updatedBy: increment ? c.actor : '' },
      update: { revision: { increment }, ...(increment ? { updatedBy: c.actor, updatedAt: new Date() } : {}) },
    });
  }

  private sharedFilterSnapshot(row: any, c: Caller) {
    return { owner: this.filterCollectionOwner(c), revision: row?.revision ?? 0,
      canManage: c.roles.includes('admin'), updatedBy: row?.updatedBy || '', updatedAt: row?.updatedAt || null,
      ...sharedLibrary(row?.folders ?? [], row?.filters ?? []) };
  }

  async readSharedFilters(c: Caller) {
    this.filterCollectionOwner(c);
    return this.sharedFilterSnapshot(await this.prisma.sharedFilterLibrary.findUnique({ where: { institution: inst(c) } }), c);
  }

  private sharedFilterRequest(body: any, c: Caller, fields: string) {
    const owner = this.filterCollectionOwner(c);
    if (!sharedKeys(body, fields) || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('기관 검색 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner)) throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
  }

  async writeSharedFilters(body: any, c: Caller) {
    this.sharedFilterRequest(body, c, 'command,expectedOwner,revision');
    need(c.roles, 'admin', '기관 검색 배포');
    const publish = body.command?.action === 'publish-folder';
    if (publish && (!sharedKeys(body.command, 'action,from,namePrefix,replace,sourceRevision,to') ||
        !Number.isInteger(body.command.sourceRevision) || body.command.sourceRevision < 0 ||
        typeof body.command.replace !== 'boolean')) throw new BadRequestException('폴더 배포 요청 형식을 확인하세요');
    return this.prisma.$transaction(async tx => {
      // Every operation needing both locks uses personal -> institution order.
      const personal = publish ? await this.lockFilterCollection(tx, c.actor, 0) : null;
      if (publish && personal.revision !== body.command.sourceRevision)
        throw new ConflictException('개인 검색이 변경되었습니다. 개인 폴더를 다시 불러오세요');
      const row = await this.lockSharedFilters(tx, c, 1);
      if (row.revision !== body.revision + 1) throw new ConflictException('기관 검색이 변경되었습니다. 공유 목록을 다시 불러오세요');
      let library = sharedLibrary(row.folders, row.filters);
      if (publish) {
        const from = folderPath(body.command.from, true);
        const owned = await tx.userFilter.findMany({ where: { owner: c.actor } });
        const sources = owned.filter(filter => !from || filter.folder === from || filter.folder.startsWith(from + '/'))
          .map(filter => sharedSearch(filter, filter.id));
        const copied = copySearchFolder(folderEntries(personal.folders), sources, from, body.command.to, body.command.namePrefix);
        const folders = mergeCopiedFolders(library.folders, library.filters, copied.folders, body.command.replace);
        const filters = new Map(library.filters.map(filter => [filter.name, filter]));
        let nextId = row.revision * 201;
        for (const copy of copied.filters) {
          const existing = filters.get(copy.name);
          if (existing && !body.command.replace) throw new ConflictException('같은 이름의 기관 검색이 있습니다. 이름 접두사 또는 명시적 교체를 사용하세요');
          filters.set(copy.name, { ...copy, id: existing?.id ?? ++nextId });
        }
        library = sharedLibrary(folders, [...filters.values()]);
      } else {
        const changes = folderAction(library.folders, library.filters, body.command);
        const moves = new Map(changes.moves.map(move => [move.id, move.folder]));
        const deleted = new Set(changes.deletes);
        library = sharedLibrary(changes.folders, library.filters.filter(filter => !deleted.has(filter.id))
          .map(filter => moves.has(filter.id) ? { ...filter, folder: moves.get(filter.id) } : filter));
      }
      const saved = await tx.sharedFilterLibrary.update({ where: { institution: inst(c) }, data: library });
      return this.sharedFilterSnapshot(saved, c);
    });
  }

  async copySharedFilters(body: any, c: Caller) {
    this.sharedFilterRequest(body, c, 'expectedOwner,from,namePrefix,personalRevision,revision,to');
    if (!Number.isInteger(body.personalRevision) || body.personalRevision < 0 || body.personalRevision >= 2147483647)
      throw new BadRequestException('개인 검색 버전을 확인하세요');
    return this.prisma.$transaction(async tx => {
      const personal = await this.lockFilterCollection(tx, c.actor);
      if (personal.revision !== body.personalRevision + 1) throw new ConflictException('개인 검색이 변경되었습니다. 개인 폴더를 다시 불러오세요');
      const row = await this.lockSharedFilters(tx, c, 0);
      if (row.revision !== body.revision) throw new ConflictException('기관 검색이 변경되었습니다. 공유 목록을 다시 불러오세요');
      const library = sharedLibrary(row.folders, row.filters);
      if (row.revision === 0 && !library.folders.length && !library.filters.length)
        throw new NotFoundException('배포된 기관 검색이 없습니다');
      const copied = copySearchFolder(library.folders, library.filters, body.from, body.to, body.namePrefix);
      const owned = await tx.userFilter.findMany({ where: { owner: c.actor } });
      const folders = mergeCopiedFolders(folderEntries(personal.folders), owned, copied.folders, false);
      const names = new Set(owned.map(filter => filter.name));
      if (copied.filters.some(filter => names.has(filter.name))) throw new ConflictException('같은 이름의 개인 검색이 있습니다. 이름 접두사를 입력하세요');
      for (const filter of copied.filters) {
        const { id, cols, ...definition } = filter;
        await tx.userFilter.create({ data: { ...definition, owner: c.actor, cols: JSON.stringify(cols), isDefault: false } });
      }
      await tx.userFilterCollection.update({ where: { owner: c.actor }, data: { folders } });
      return this.filterCollectionSnapshot(tx, c);
    });
  }

  private async nextTemplateOrd(owner: string) {
    const last = await this.prisma.readingTemplate.findFirst({
      where: { owner }, orderBy: { ord: 'desc' }, select: { ord: true },
    });
    return (last?.ord ?? 0) + 1;
  }

  /** 상용구 저장 (id가 있으면 수정) */
  async saveTemplate(body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독 상용구 편집');
    const owner = c.actor;
    const title = String(body.title ?? '').trim();
    if (!title) throw new BadRequestException('제목이 필요합니다');
    const data = {
      title,
      shortcut: String(body.shortcut ?? '').trim(),
      modality: String(body.modality ?? '').trim(),
      bodypart: String(body.bodypart ?? '').trim(),
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
      // 새로 만든 건 목록 끝에 붙는다. 0으로 두면 맨 위로 올라가서, 방금 만든 하나가
      // 매일 쓰던 상용구들을 밀어낸다. 순서는 사용자가 정할 것이지 우연히 정해질 게 아니다.
      ord: +body.ord || (body.id ? 0 : await this.nextTemplateOrd(owner)),
    };
    if (body.id) {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0)
        throw new BadRequestException(`잘못된 상용구 id입니다: ${body.id}`);
      const r = await this.prisma.readingTemplate.updateMany({ where: { id, owner }, data });
      if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
      return this.prisma.readingTemplate.findUnique({ where: { id } });
    }
    return this.prisma.readingTemplate.create({ data: { owner, ...data } });
  }

  async deleteTemplate(id: number, c: Caller) {
    need(c.roles, 'radiologist', '판독 상용구 삭제');   // saveTemplate과 같은 역할 경계
    const r = await this.prisma.readingTemplate.deleteMany({ where: { id, owner: c.actor } });
    if (!r.count) throw new NotFoundException('상용구를 찾을 수 없습니다');
    return { ok: true };
  }

  /** 검사 상태 부분 수정 (RS 토글, Verify, Switch EM/ReqHosp, TS 전이 …) */
  async patchState(uid: string, body: any, c: Caller) {
    return this.scopeWrite(uid,c,async(tx,audit)=>{
    const me = inst(c);

    /**
     * 판독문의 생애주기에 속한 필드는 여기로 못 들어온다.
     * 조용히 무시하면 클라이언트는 "저장됐다"고 믿고 화면만 앞서 나간다 — 소리 내어 막는다.
     */
    const owned = REPORT_OWNED_FIELDS.filter(k => body[k] !== undefined);
    if (owned.length)
      throw new BadRequestException(
        `${owned.join(', ')} 은(는) 전용 경로(판독문 확정 /report/commit, 매칭 /match·/unmatch)로만 바꿀 수 있습니다`);

    // 무엇을 바꾸려 하는가에 따라 필요한 권한이 다르다
    if (TECHNICIAN_FIELDS.some(k => body[k] !== undefined)) need(c.roles, 'technician', '검사 정보 변경');

    const prev = await this.gate(uid,c,tx);
    // 쓰기 경로는 행을 만들지 않는다. 생성은 DICOM 기관명을 검증하는 listStudies 한 곳뿐이다.
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');

    /**
     * match·unmatch·삭제와 같은 규칙: 원격판독으로 받은 검사의 촬영 상태·환자 정보는 **보유 기관의 일**이다.
     * 세 형제 관문은 있었는데 patchState만 열려 있어서, 수신 기관 기사가 ss·em을 바꿔 소유 기관을 자기
     * 검사의 판독에서 잠그거나 ov로 환자 정보를 덮을 수 있었다(v0.6.3 회귀 확충에서 발견 —
     * "관문은 한 곳만 열려 있어도 관문이 아니다"). 수신 기관이 여는 건 TS의 자기 구간(아래)뿐이다.
     */
    if (prev.institutionId !== me && TECHNICIAN_FIELDS.some(k => body[k] !== undefined))
      throw new ForbiddenException('원격판독으로 받은 검사의 촬영·환자 정보는 보유 기관만 바꿀 수 있습니다');

    /**
     * **예비 판독 중인 검사는 여기서도 막는다.**
     *
     * 판독문 저장·확정·점유·이력 네 곳에 관문을 달면서 이 한 곳을 빼먹었고,
     * 그래서 `PATCH {rs:"T"}` 한 번으로 잠금이 통째로 풀렸다. 응답에 판독문 본문까지
     * 실려 나갔다. **관문은 한 곳만 열려 있어도 관문이 아니다.**
     */
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 다룰 수 있습니다.`);

    const data: any = {};
    for (const k of STATE_FIELDS) if (body[k] !== undefined) data[k] = body[k];
    if (body.ov !== undefined) data.ov = dump(body.ov);

    // ── 원격판독: 유일하게 기관을 넘는 동작 ──
    if (body.ts !== undefined) {
      // 기관 관문과 역할 관문은 다른 축이다. 원격판독 의뢰·수신은 판독의만 결정한다.
      need(c.roles, 'radiologist', '원격판독 상태 변경');
      const owner = prev?.institutionId ?? me;
      const ts = body.ts;
      const from = prev?.ts ?? 'none';
      if (!(TELE_NEXT[from] ?? []).includes(ts))
        throw new BadRequestException(`허용되지 않는 TS 전이입니다: ${from} → ${ts}`);
      if (TELE_BY_OWNER.includes(ts)) {
        if (owner !== me)
          throw new ForbiddenException('원격판독 의뢰는 검사를 보유한 기관만 할 수 있습니다');
        // 매뉴얼 6.3.4.4 — 원격판독은 RS가 W이고 TS가 none/cancelled일 때만 요청할 수 있다.
        // 이미 우리 쪽에서 판독이 시작된 검사를 밖으로 보내면 판독문이 둘로 갈라진다.
        if (!TELE_CLOSED.includes(ts) && (prev?.rs ?? 'W') !== 'W')
          throw new BadRequestException(
            `판독 전(RS: W)인 검사만 원격판독을 의뢰할 수 있습니다 (현재 RS: ${prev?.rs})`);
        if (TELE_CLOSED.includes(ts)) data.teleInstitutionId = null;   // 의뢰 취소 → 통로를 닫는다
        else if (body.teleTo !== undefined) {
          if (!this.institutions.some(i => i.id === body.teleTo))
            throw new BadRequestException(`알 수 없는 기관: ${body.teleTo}`);
          if (body.teleTo === owner)
            throw new BadRequestException('자기 기관으로는 원격판독을 의뢰할 수 없습니다');
          data.teleInstitutionId = body.teleTo;
        } else if (!prev?.teleInstitutionId) {
          throw new BadRequestException('원격판독을 받을 기관(teleTo)을 지정해야 합니다');
        }
      } else if (TELE_BY_RECEIVER.includes(ts)) {
        if (prev?.teleInstitutionId !== me)
          throw new ForbiddenException('원격판독을 받은 기관만 이 상태로 바꿀 수 있습니다');
      } else {
        throw new BadRequestException(`알 수 없는 TS: ${ts}`);
      }
    }

    if (!Object.keys(data).length) throw new BadRequestException('바꿀 필드가 없습니다');

    // 판독문은 "그때 그 영상, 그 환자"에 대한 진술이다. 판독이 끝난 뒤 환자·검사 정보를
    // 갈아치우면 그 진술의 근거가 사라진다. 그래서 RS가 W일 때만 덮어쓰기를 허용한다.
    // (HPACS 매뉴얼 8.1.2.1.5 — 승인된 검사를 수정하면 판독문을 버리고 새 검사를 만든다)
    // 화면에서도 막고 있지만, 화면의 검사는 검사가 아니다. 서버가 막아야 막힌 것이다.
    if (body.ov !== undefined) {
      const rs = prev?.rs ?? 'W';
      if (rs !== 'W')
        throw new BadRequestException(`판독 전(RS: W)인 검사만 환자·검사 정보를 수정할 수 있습니다 (현재 RS: ${rs})`);
      // S4-U5 (M-1): last, after every existing refusal, so each caller and RS keeps its status and message. The
      // overlay reaches every institution that sees the row, so only display fields with text values are stored.
      if (!overlayShape(body.ov))
        throw new BadRequestException(`환자·검사 정보(ov) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);
    }

    const saved = await tx.studyState.update({ where: { uid }, data });
    await audit(c.actor, 'state.patch', uid, { ...data, by: me });
    const r = await tx.report.findUnique({ where: { uid } });
    return toClient(saved, r, c.actor, await this.myDraft(uid,c.actor,tx));
    });
  }

  /**
   * 판독문 초안 저장. **`Report`가 아니라 내 `ReportDraft` 행에 쓴다.**
   *
   * 예전엔 초안도 `Report`에 썼고, 거기서 이 시스템의 판독문 손실이 거의 다 나왔다:
   * 초안이 남의 확정본을 덮고, 두 사람의 초안이 서로를 덮고, Clear 한 번에 승인본이
   * 화면에서 사라졌다. 확정 경로에만 낙관적 락이 있었기 때문이라고 생각해서
   * 이쪽에도 락을 달았더니, 이번엔 **20초 자동 저장이 409를 받는** 문제가 생겼다 —
   * 사용자가 안 보고 있을 때 "충돌했습니다"를 띄워봐야 할 수 있는 일이 없다.
   *
   * 진짜 원인은 락이 없어서가 아니라 **한 칸을 둘이 썼기 때문**이었다.
   * 초안을 쓴 사람에게 붙이면 충돌은 감지할 필요조차 없다. 같은 행을 안 쓰니까.
   *
   * 충돌은 확정할 때만 일어난다 — 사람이 화면 앞에 있고, 스스로 누른 순간이고,
   * 물어볼 수 있는 자리다. 낙관적 락은 `commitReport` 한 곳에만 있으면 된다.
   */
  // Shared with putReport: dictation cannot create a weaker copy of report refusal rules.
  private async reportDraftGate(uid: string, c: Caller, tx: any) {
    need(c.roles, 'radiologist', '판독문 저장');
    const prev = await this.gate(uid,c,tx);
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    if (heldByOther)
      throw new ConflictException({ code: 'REPORT_HELD', holder: heldByOther, message: `${heldByOther} 님이 판독 중입니다` });
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);
    return prev;
  }

  async dictationGate(uid: string, c: Caller) {
    return this.scopeWrite(uid, c, async tx => { await this.reportDraftGate(uid, c, tx); });
  }

  async dictationAudit(uid: string, c: Caller, detail: { bytes: number; seconds: number; ms: number; engine: string; outcome: string }) {
    await this.audit(c.actor, 'dictation.request', uid, detail);
  }

  async putReport(uid: string, body: any, c: Caller) {
    /**
     * 소견 계보의 접근 정책은 **트랜잭션 밖에서** 준비되어야 한다.
     *
     * `scopeWrite`가 미리 부르는 `prepare(c,[uid])`는 검사 하나만 요청하므로 전체 준비를
     * 켜지 않는다(`study-access.service.ts`). 그러면 트랜잭션 안에서 비교 검사를 묻는 순간
     * `allowed`는 준비를 못 하고 캐시가 없어 409를 던진다 — 비교 검사를 가진 소견의 인용이
     * 권한 문제도 아닌데 조용히 실패한다. 소견 목록이 같은 이유로 같은 형태를 쓴다.
     */
    if (body?.insert !== undefined) await this.studyAccess.prepare(c);
    return this.reportLimitChecked(() => this.scopeWrite(uid,c,async(tx,audit)=>{
    const prev = await this.reportDraftGate(uid, c, tx);

    const content = {
      findings: body.findings ?? '',
      conclusion: body.conclusion ?? '',
      recommendation: body.recommendation ?? '',
    };
    const empty = !(content.findings || content.conclusion || content.recommendation);

    /**
     * 빈 초안은 **행을 지운다.** 빈 초안을 남겨두면 그게 확정본을 가려서,
     * 승인된 판독문을 열었는데 빈 칸이 보이는 상태가 된다.
     * "초안이 없다"와 "초안이 비어 있다"는 화면에서 같은 뜻이어야 한다.
     */
    if (empty) {
      // 비우는 PUT에 삽입을 함께 보낼 수는 없다 — 넣었다고 말하는 문장이 본문에 없다.
      // 조용히 무시하면 화면은 200을 받고도 무엇이 기록되었는지 알 수 없다.
      if (body.insert !== undefined)
        throw new ConflictException({ code: 'REPORT_CITATION_TEXT',
          message: '삽입한 문구가 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
      // 같은 이유로 구조화 적용도 함께 올 수 없다 — 넣었다고 말하는 문장이 본문에 없다.
      if (body.structure !== undefined)
        throw new ConflictException({ code: 'REPORT_STRUCTURE_TEXT',
          message: '구조화 항목의 문장이 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
      await tx.reportDraft.deleteMany({ where: { uid, author: c.actor } });
      await audit(c.actor, 'report.draft.clear', uid, {});
      return { uid, author: c.actor, cleared: true };
    }

    /**
     * **기준 판은 화면이 실제로 본 판이어야 한다.**
     *
     * 판 번호는 커지기만 하므로(`:1821`·`:1834`) 정직한 화면은 아직 없는 판을 기준으로
     * 삼을 수 없다. 여기 걸린다면 `baseVersion`의 출처가 틀린 것이고, 그대로 저장하면
     * 확정 때 낙관적 락이 **아무도 본 적 없는 판**을 통과시킨다.
     * 비우는 PUT(위)은 판 번호를 저장하지 않으므로 이 검사 앞에서 끝난다 —
     * 자동 저장을 거절하지 않는다는 규칙은 그대로다.
     */
    const baseVersion = body.baseVersion ?? 0;
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0)
      throw new BadRequestException('baseVersion은 0 이상의 정수여야 합니다 (화면이 마지막으로 본 판 번호)');
    // 잠그지 않는다. 초안은 내 행에만 쓰므로 여기서 Report를 잠그면 20초 자동 저장이
    // 남의 확정과 겹쳐 서로를 기다린다 — 이 파일이 한 번 겪은 실패다(:1501-1515).
    const head = await tx.report.findUnique({ where: { uid }, select: { version: true } });
    if (baseVersion > (head?.version ?? 0))
      throw new BadRequestException(
        `아직 없는 판(v${baseVersion})을 기준으로 초안을 저장할 수 없습니다 (현재 v${head?.version ?? 0})`);

    // 기존 초안의 기준이 올라가는 PUT은 자동 저장이 아니라 **사람이 승인본을 확인하고
    // 다시 잡은 것**이다. 어느 판을 딛고 쓴 글인지는 나중에 되짚을 근거가 이것뿐이라
    // 자동 저장과 구분해 남긴다.
    const prior = await tx.reportDraft.findUnique({
      where: { uid_author: { uid, author: c.actor } }, select: { baseVersion: true },
    });
    // 인용 키가 하나도 없으면 `null`이고, 그러면 칸을 아예 쓰지 않는다 — 옛 탭의 자동 저장이
    // 자기가 모르는 증언을 지우는 일은 없어야 한다. 키 부재는 `[]`가 아니라 **변경 없음**이다.
    const cited = await this.draftCitations(tx, uid, body, content, c, head?.version ?? 0);
    const structure = await this.draftStructure(tx, uid, body, content, c, head?.version ?? 0);

    /**
     * ── 비어 있음을 쓰는 세 가지 (A1) ──
     *
     * 요청이 구조화를 **건드리지 않았으면** 칸을 아예 빼야 한다. UPDATE에서 키를 빼는 것은
     * "그대로 두라"는 뜻이고, 구조화를 모르는 옛 탭의 자동 저장이 남의 증언을 지우지 않는
     * 유일한 방법이다.
     *
     * 요청이 구조화를 **명시적으로 비웠으면**(`structureIds: []`) 칸을 빼서는 안 된다 —
     * 빼면 이전 배열이 그대로 남아 "지웠다"고 답해놓고 아무것도 지우지 않은 것이 된다.
     * 그 경우에만 `Prisma.DbNull`로 **SQL NULL**을 쓴다. `Prisma.JsonNull`은 JSON 값 `null`이라
     * 배열도 NULL도 아닌 세 번째 모양을 만들고, 읽는 쪽의 "배열이 아니면 없음"을 통과하면서
     * CHECK의 `IS NULL`은 통과하지 못한다.
     *
     * CREATE에는 지울 이전 값이 없으므로 빈 결과는 그냥 생략한다(P13 — `[]`는 저장하지 않는다).
     */
    const structuredCreate = structure && structure.entries.length ? { structured: structure.entries } : {};
    const structuredUpdate = !structure ? {}
      : structure.entries.length ? { structured: structure.entries } : { structured: Prisma.DbNull };

    const saved = await tx.reportDraft.upsert({
      where: { uid_author: { uid, author: c.actor } },
      create: { uid, author: c.actor, ...content, baseVersion,
        ...(cited ? { citations: cited.entries } : {}), ...structuredCreate },
      update: { ...content, baseVersion, ...(cited ? { citations: cited.entries } : {}), ...structuredUpdate },
    });
    // 판독문 전문을 감사로그에 통째로 넣지 않는다 — 길이와 개인정보 때문. 길이만 남긴다.
    await audit(c.actor, 'report.draft', uid, {
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
      // 인용 감사는 `cid`·칸·수만 남긴다. `findingId`·`sourceIndex`·삽입 문구를 남기면
      // 역할·예비 판독 관문이 없는 감사 통로(`audits()`)로 판독문↔소견 연결이 통째로 새어 나간다.
      ...(cited?.detail ? { cits: cited.detail } : {}),
      // 구조화 감사도 **건수와 `sid`만** 남긴다(P16). 고른 값·본문에 들어간 문장·항목 코드를
      // 남기면 역할 관문이 없는 감사 통로로 판독 내용이 새어 나간다.
      ...(structure?.detail ? { strs: structure.detail } : {}),
    });
    if (prior && baseVersion > prior.baseVersion)
      await audit(c.actor, 'report.draft.rebase', uid, { from: prior.baseVersion, to: baseVersion });
    /**
     * 원시 행을 돌려주지 않는다. 본문을 되돌려 보내면 늦은 응답이 사용자가 그 사이 친 글자를
     * 덮을 수 있고, 새로 생긴 인용 칸이 이 통로로 함께 나간다. 화면이 알아야 하는 것은
     * **무엇이 기록되었는가**뿐이다.
     */
    return { uid, author: c.actor, baseVersion: saved.baseVersion, updatedAt: saved.updatedAt,
      ...(cited?.inserted ? { inserted: cited.inserted } : {}),
      // 요청이 `structure`를 실어 보냈을 때만 이 칸이 있다(P9). 화면은 이 `sid` 하나로 유지
      // 목록을 넓힌다 — 없으면 지어내지 않고 모르는 상태로 남긴다. 이 응답은 appState에
      // 통째로 병합되지 않으므로 키가 없는 것이 옛 값을 남기지 않는다.
      ...(structure?.applied ? { structured: structure.applied } : {}) };
    }));
  }

  /**
   * PUT 한 번에 들어온 인용 변경을 본문과 **같은 쓰기**로 풀어낸다.
   * 인용 키가 하나도 없으면 `null` — 칸을 건드리지 않는다.
   */
  private async draftCitations(tx: any, uid: string, body: any, content: any, c: Caller, headVersion: number) {
    const keep = this.citationKeys(body.citationIds, 'citationIds');
    const wantsInsert = body.insert !== undefined;
    if (keep === undefined && !wantsInsert) return null;
    // 내 행을 먼저 잠근다. 두 탭의 PUT이 본문과 인용을 결정적으로 짝짓게 하는 유일한 방법이다.
    // 남과 경합하지 않는다 — 초안 행의 키는 (uid, author)다.
    const [locked] = await tx.$queryRaw`
      SELECT citations FROM "ReportDraft" WHERE uid = ${uid} AND author = ${c.actor} FOR UPDATE`;
    const { kept, ignored } = applyKeepList(citationArray(locked?.citations), keep);
    let inserted: { cid: string; field: string; insertedAt: string } | null = null;
    if (wantsInsert) {
      const entry = await this.verifiedInsertion(tx, uid, body.insert, content, c);
      kept.push(entry);
      inserted = { cid: entry.cid, field: entry.field, insertedAt: entry.insertedAt };
      /**
       * 예방적 검사다. 머리 판을 **잠그지 않고** 읽으므로 두 방향 모두 틀릴 수 있다 —
       * 넘치는데 통과하거나, 여유가 있는데 거절할 수 있다. 실제 상한은 확정 시의
       * `REPORT_CITATION_LIMIT`과 DB CHECK가 잡는다. 유지 목록만 온 PUT은 줄어들기만
       * 하므로 여기 오지 않는다 — 자동 저장을 한도로 거절하지 않는다.
       */
      await this.citationBudget(tx, [...await this.versionCitations(tx, uid, headVersion), ...kept]);
    }
    const detail = (kept.length || ignored) ? { n: kept.length,
      ...(inserted ? { add: [{ cid: inserted.cid, field: inserted.field }] } : {}),
      ...(ignored ? { ignored } : {}) } : null;
    return { entries: kept, inserted, detail };
  }

  /**
   * PUT 한 번에 들어온 구조화 변경을 본문과 **같은 쓰기**로 풀어낸다.
   * 구조화 키가 하나도 없으면 `null` — 칸을 건드리지 않는다(A1의 "변경 없음").
   *
   * `studyAccess.prepare(c)`를 부르지 않는다(P14). 구조화 항목은 소견 계보를 가리키지 않으므로
   * 비교 검사 정책을 준비할 이유가 없고, 준비하면 이 경로가 넓은 정책 읽기를 끌고 들어온다.
   */
  private async draftStructure(tx: any, uid: string, body: any, content: any, c: Caller, headVersion: number) {
    const keep = this.structureKeys(body.structureIds, 'structureIds');
    const wantsApply = body.structure !== undefined;
    if (keep === undefined && !wantsApply) return null;
    // 내 행을 먼저 잠근다. 인용과 같은 행·같은 방향이라 두 잠금은 순서대로 선다.
    const [locked] = await tx.$queryRaw`
      SELECT structured FROM "ReportDraft" WHERE uid = ${uid} AND author = ${c.actor} FOR UPDATE`;
    const { kept, ignored } = applyStructureKeepList(structureArray(locked?.structured), keep);
    let applied: { sid: string; field: string; enteredAt: string } | null = null;
    if (wantsApply) {
      const input = this.structureInput(body.structure);
      const head = await this.versionStructured(tx, uid, headVersion);
      /**
       * **살아 있음의 규칙은 확정의 규칙과 같다** (P1/B3).
       *
       * 머리 건은 그 문장이 **이 요청의 본문에 있을 때만** 살아 있다. 한 번 Save한 뒤 값을
       * 고치면 머리 건의 문장은 본문을 떠나지만 행 자체는 불변이라 그대로 남는데, 그것을
       * 살아 있다고 세면 같은 항목을 **두 번째로** 고치려는 사람에게 "이미 입력한 항목입니다"를
       * 돌려주게 된다 — 고치라고 안내해놓고 고치지 못하게 하는 답이다.
       *
       * 대상 찾기(`all`)는 좁히지 않는다. `replace`는 옛 문장이 본문에 **없을 것**을 요구하므로,
       * 바꿀 머리 건은 정의상 `live`에 없기 때문이다.
       */
      const all = structureUnion(head, kept);
      const headLive = head.filter(entry => lineBlockOccurrences(
        String(content[String(entry?.field ?? '')] ?? ''), String(entry?.renderedText ?? '')) >= 1);
      let live = structureUnion(headLive, kept);
      if (input.op === 'replace') {
        /**
         * 바꿀 건은 내 초안에도, **머리 판에도** 있을 수 있다 (P3/B3).
         * 확정은 매번 초안 행을 지우므로(`:2158`) 한 번 저장한 뒤의 모든 건은 머리 건이고,
         * 머리를 못 가리키면 값을 고치는 일이 첫 저장 이후로 영영 불가능해진다.
         * 머리 행은 불변이므로 여기서 **고치지 않는다** — 그 건은 문장이 본문을 떠난 사실로
         * 확정 때 P1이 떨어뜨린다.
         */
        const target = all.find(entry => String(entry?.sid ?? '') === input.replacesSid);
        if (!target)
          throw new ConflictException({ code: 'REPORT_STRUCTURE_REPLACE',
            message: '바꿀 항목을 찾을 수 없습니다 — 화면을 다시 불러오세요' });
        if (String(target.field) !== input.field || String(target.templateId) !== input.templateId
            || String(target.itemCode) !== input.itemCode)
          throw new ConflictException({ code: 'REPORT_STRUCTURE_REPLACE',
            message: '같은 서식의 같은 항목만 바꿀 수 있습니다' });
        // 옛 문장이 아직 본문에 있으면 두 값이 동시에 적힌 판독문이 된다.
        if (lineBlockOccurrences(content[String(target.field)], String(target.renderedText ?? '')))
          throw new ConflictException({ code: 'REPORT_STRUCTURE_REPLACE',
            message: '이전 값의 문장이 아직 본문에 남아 있습니다 — 화면을 다시 불러오세요' });
        const at = kept.findIndex(entry => String(entry?.sid ?? '') === input.replacesSid);
        if (at >= 0) kept.splice(at, 1);
        live = live.filter(entry => String(entry?.sid ?? '') !== input.replacesSid);
      }
      // 같은 항목은 한 번만 산다(P3). 되풀이되는 항목(결절 여러 개)은 v1의 범위 밖이다.
      const wanted = structureItemKey({ templateId: input.templateId, itemCode: input.itemCode });
      if (live.some(entry => structureItemKey(entry) === wanted))
        throw new ConflictException({ code: 'REPORT_STRUCTURE_EXISTS',
          message: '이미 입력한 항목입니다 — 값을 바꾸려면 수정을 사용하세요' });
      /**
       * 서버가 확인하는 것은 이 글이 **이 요청의 본문에 줄 블록으로 실재하는지**뿐이다.
       * 본문을 쓰는 것은 화면이고, 서버는 화면이 넣었다고 말한 것을 대조만 한다 —
       * 인용과 같은 구조적 방어다.
       */
      if (!lineBlockOccurrences(content[input.field], input.renderedText))
        throw new ConflictException({ code: 'REPORT_STRUCTURE_TEXT',
          message: '구조화 항목의 문장이 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
      const template = this.structureCatalog.find(t => t.templateId === input.templateId);
      const item = template?.items.find(i => i.code === input.itemCode);
      const entry = { v: REPORT_STRUCTURE_SCHEMA, sid: randomUUID(), field: input.field,
        templateId: input.templateId, templateRevision: input.templateRevision, itemCode: input.itemCode,
        valueType: input.valueType, value: input.value, unit: item?.unit ?? null,
        renderedText: input.renderedText, enteredAt: new Date().toISOString(), enteredBy: c.actor };
      kept.push(entry);
      applied = { sid: entry.sid, field: entry.field, enteredAt: entry.enteredAt };
      // 예방적 검사다. 머리 판을 잠그지 않고 읽으므로 양방향 모두 틀릴 수 있고, 실제 상한은
      // 확정 시의 검사와 DB CHECK가 잡는다. 유지 목록만 온 PUT은 줄어들기만 하므로 오지 않는다.
      await this.structureBudget(tx, [...head, ...kept]);
    }
    const detail = (kept.length || ignored) ? { n: kept.length,
      ...(applied ? { add: [applied.sid] } : {}),
      ...(ignored ? { ignored } : {}) } : null;
    return { entries: kept, applied, detail };
  }

  /** 머리 판의 구조화 증언. 인용과 같은 규칙 — 머리는 `ReportVersion(uid, Report.version)` 한 행이다. */
  private async versionStructured(tx: any, uid: string, version: number) {
    if (!version) return [] as any[];
    const row = await tx.reportVersion.findUnique({
      where: { uid_version: { uid, version } }, select: { structured: true } });
    return structureArray(row?.structured);
  }

  /** 한도는 데이터베이스가 센다. CHECK와 같은 자(canonical `jsonb::text`의 UTF-8 바이트)를 쓴다. */
  private async structureBudget(tx: any, entries: any[]) {
    if (entries.length > REPORT_STRUCTURE_LIMITS.entries) structureLimit();
    if (!entries.length) return;
    const [row] = await tx.$queryRaw`
      SELECT octet_length(convert_to(${canonical(entries)}::jsonb::text, 'UTF8')) AS bytes`;
    if (Number(row.bytes) > REPORT_STRUCTURE_LIMITS.bytes) structureLimit();
  }

  /** 모양이 틀린 입력만 400으로 옮긴다. 다른 실패는 그대로 올려보낸다. */
  private structureKeys(value: any, what: string) {
    try { return structureIdList(value, what); }
    catch (e: any) { if (e instanceof StructureInputError) throw new BadRequestException(e.message); throw e; }
  }
  private structureInput(value: any) {
    try { return structureApplyInput(value, this.structureCatalog); }
    catch (e: any) { if (e instanceof StructureInputError) throw new BadRequestException(e.message); throw e; }
  }

  /**
   * 검사 순서가 곧 계약이다: 모양 → 같은 검사 → 소견 가독 → 소견 판·숨김 →
   * 링크 상태 재계산 → 본문에 줄 블록으로 실재.
   *
   * 증언 값은 전부 **여기서 서버가** 쓴다 — `cid`(난수), 사람, 시각, 링크 상태, 머리 판.
   * 클라이언트가 보낸 같은 이름의 칸은 `citationInsertInput`이 읽지 않아 그대로 사라진다.
   */
  private async verifiedInsertion(tx: any, uid: string, raw: any, content: any, c: Caller) {
    const insert = this.citationInput(raw);
    // `Finding.studyUid === uid`는 이 메서드가 uid로 묻는 것 자체가 보장한다 —
    // 다른 검사의 소견은 애초에 답에 들어오지 않는다.
    const [row] = await this.findings.readableFindings(tx, c, uid, [insert.findingId]);
    // 읽을 수 없는 소견과 없는 소견은 **같은 답**이다. 어느 쪽인지 말하면 그 자체가 정보다.
    if (!row) throw new ConflictException({ code: 'REPORT_CITATION_SOURCE',
      message: '그 소견을 인용할 수 없습니다 — 소견 목록을 다시 불러오세요' });
    if (row.revision !== insert.findingRevision || row.hidden)
      throw new ConflictException({ code: 'REPORT_CITATION_STALE',
        message: '소견이 그 사이 바뀌었습니다 — 소견 패널을 다시 불러온 뒤 인용하세요' });
    const source = citationArray(row.sources)[insert.sourceIndex];
    const link = citationArray(row.links)[insert.sourceIndex];
    if (!source || !link) throw new ConflictException({ code: 'REPORT_CITATION_SOURCE',
      message: '그 출처를 찾을 수 없습니다 — 소견 목록을 다시 불러오세요' });
    // 판정은 핀이 아니라 **삽입 시점에 서버가 다시 계산한** 링크 상태로 한다.
    if (link.linkState === 'hidden' || link.linkState === 'missing')
      throw new ConflictException({ code: 'REPORT_CITATION_SOURCE',
        message: '숨겨졌거나 사라진 출처는 인용할 수 없습니다' });
    if (link.linkState !== insert.expectedLinkState || (link.headRevision ?? null) !== insert.expectedHeadRevision)
      throw new ConflictException({ code: 'REPORT_CITATION_STALE',
        message: '출처 상태가 그 사이 바뀌었습니다 — 확인한 뒤 다시 인용하세요' });
    /**
     * 서버가 확인하는 것은 이 글이 **이 요청의 본문에 줄 블록으로 실재하는지**뿐이다.
     * `insertedText`는 출처의 사본이 아니라 작성자가 자기 판독문에 넣은 글 그 자체이며,
     * 그것이 출처를 재현한다고는 어떤 표면도 말하지 않는다.
     */
    if (blockIsBlank(insert.insertedText) || !lineBlockOccurrences(content[insert.field], insert.insertedText))
      throw new ConflictException({ code: 'REPORT_CITATION_TEXT',
        message: '삽입한 문구가 그 칸의 본문에 줄 단위로 그대로 있지 않습니다' });
    return { v: REPORT_CITATION_SCHEMA, cid: randomUUID(), field: insert.field,
      findingId: insert.findingId, findingRevision: insert.findingRevision, sourceIndex: insert.sourceIndex,
      sourceRef: citationSourceRef(source), linkStateAtInsert: link.linkState,
      headRevisionAtInsert: link.headRevision ?? null, insertedText: insert.insertedText,
      insertedAt: new Date().toISOString(), insertedBy: c.actor };
  }

  /** 머리 판은 오직 `ReportVersion(uid, Report.version)` 한 행이다. 없으면 빈 배열이다. */
  private async versionCitations(tx: any, uid: string, version: number) {
    if (!version) return [] as any[];
    const row = await tx.reportVersion.findUnique({
      where: { uid_version: { uid, version } }, select: { citations: true } });
    return citationArray(row?.citations);
  }

  /**
   * 한도는 **데이터베이스가 센다.** canonical `jsonb::text`의 UTF-8 바이트가 CHECK와 같은
   * 자이며, JS의 더 짧은 직렬화로 재면 서버가 통과시킨 것을 CHECK가 거절해 500이 된다.
   * 선례는 소견 스냅샷의 같은 측정이다(`finding.service.ts`).
   */
  private async citationBudget(tx: any, entries: any[]) {
    if (entries.length > REPORT_CITATION_LIMITS.entries) citationLimit();
    if (!entries.length) return;
    const [row] = await tx.$queryRaw`
      SELECT octet_length(convert_to(${canonical(entries)}::jsonb::text, 'UTF8')) AS bytes`;
    if (Number(row.bytes) > REPORT_CITATION_LIMITS.bytes) citationLimit();
  }

  /** 모양이 틀린 입력만 400으로 옮긴다. 다른 실패는 그대로 올려보낸다. */
  private citationKeys(value: any, what: string) {
    try { return citationIdList(value, what); }
    catch (e: any) { if (e instanceof CitationInputError) throw new BadRequestException(e.message); throw e; }
  }
  private citationInput(value: any) {
    try { return citationInsertInput(value); }
    catch (e: any) { if (e instanceof CitationInputError) throw new BadRequestException(e.message); throw e; }
  }

  /**
   * DB CHECK를 **이름으로** 알아보고 같은 409로 옮긴다. 우리 제약이 아니면 손대지 않는다 —
   * 다른 데이터베이스 오류를 삼키면 진짜 고장이 "인용을 제거하세요"로 위장된다.
   */
  private async reportLimitChecked<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error: any) {
      if (isCitationCheck(error)) citationLimit();
      if (isStructureCheck(error)) structureLimit();
      throw error;
    }
  }

  /**
   * 초안 버리기. 확정본으로 돌아가고 싶을 때 — "쓰다 만 것"과 "저장된 것"이
   * 다를 때 사용자가 고를 수 있어야 한다.
   * 내 초안만 지운다. 남의 초안은 애초에 보이지도 않는다.
   */
  async discardDraft(uid: string, c: Caller) {
    return this.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'radiologist', '판독문 저장');
    await this.gate(uid,c,tx);
    const r = await tx.reportDraft.deleteMany({ where: { uid, author: c.actor } });
    if (r.count) await audit(c.actor, 'report.draft.discard', uid, {});
    const s = await tx.studyState.findUnique({ where: { uid } });
    const rep = await tx.report.findUnique({ where: { uid } });
    return toClient(s, rep, c.actor, null);
    });
  }

  /**
   * 관리자용 초안 강제 해제.
   *
   * 평소의 discardDraft는 **내 초안만** 지운다. 그 경계를 느슨하게 만들어 관리자가
   * 남의 초안을 일반 경로로 지우게 하면, 실수인지 강제 조치인지 이력에서 구분할 수 없다.
   * 그래서 별도 admin 경로에서만 모든 초안을 지우고, 지우기 직전 내용을 판으로 남긴다.
   *
   * 현재 UID의 초안 행만 FOR UPDATE로 고정한다. 조회한 초안과 실제로 지운 초안이
   * 달라지는 틈은 막되, 다른 검사의 자동 저장과 확정까지 멈추는 테이블 락은 잡지 않는다.
   * 그 사이 다른 판독 확정이 같은 판 번호를 먼저 쓰면 이 트랜잭션은 P2002로 롤백되며,
   * 최신 판 번호와 남은 초안을 다시 읽어 한 번 재시도한다.
   */
  async forceDiscardDrafts(uid: string, c: Caller) {
    need(c.roles, 'admin', '판독문 초안 강제 해제');
    const me = inst(c);
    await this.gate(uid, c);
    await this.studyAccess.prepare(c,[uid]);

    const run = () => this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
      await tx.$queryRaw`
        SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
      const drafts = await tx.$queryRaw<any[]>`
        SELECT uid, author, findings, conclusion, recommendation, "baseVersion", citations, structured, "updatedAt"
        FROM "ReportDraft"
        WHERE uid = ${uid}
        ORDER BY author
        FOR UPDATE
      `;
      if (!drafts.length) {
        // 강제 해제 호출 자체도 관리자 조치다. 지울 것이 없었어도 흔적은 남긴다.
        await tx.auditLog.create({
          data: {
            actor: c.actor, action: 'report.draft.force-discard', target: uid,
            detail: dump({ by: me, drafts: [], versions: [] }),
          },
        });
        return { ok: true, count: 0, drafts: [], versions: [] };
      }

      const last = await tx.reportVersion.findFirst({
        where: { uid }, orderBy: { version: 'desc' }, select: { version: true },
      });
      const firstVersion = (last?.version ?? 0) + 1;
      const versions = drafts.map((d, i) => firstVersion + i);
      const summary = drafts.map(d => ({
        author: d.author,
        len: [d.findings.length, d.conclusion.length, d.recommendation.length],
      }));

      await tx.reportVersion.createMany({
        data: drafts.map((d, i) => ({
          uid, version: versions[i], action: 'discarded',
          findings: d.findings, conclusion: d.conclusion, recommendation: d.recommendation,
          // 본문을 판으로 보존하면서 그 본문의 증언만 버리면, 남은 글이 어디서 왔는지 아무도
          // 되짚을 수 없다. 이 판에는 **그 작성자가 넣은 건만** 들어간다.
          // 되읽은 NULL을 그대로 쓰면 Prisma가 거절하므로 칸을 아예 생략한다 —
          // 그러지 않으면 인용이 없던 옛 초안의 강제 해제가 전부 실패한다.
          ...(d.citations === null || d.citations === undefined ? {} : { citations: d.citations }),
          // 구조화도 같은 규칙으로 함께 보존한다. 본문만 판으로 남기고 타입 있는 값을 버리면
          // 보존된 문장이 무엇을 뜻했는지 되짚을 자리가 없어진다 — 강제 해제는 사용자의
          // 실수가 아니라 관리자 조치이므로 더더욱 통째로 남아야 한다.
          ...(d.structured === null || d.structured === undefined ? {} : { structured: d.structured }),
          reason: `관리자 강제 초안 해제 (해제자: ${c.actor})`,
          author: d.author,   // 지운 관리자가 아니라 실제로 **쓴 사람**이 저자다
        })),
      });
      // 조회 뒤 새로 생긴 초안은 지우지 않는다. 판으로 보존한 바로 그 행들만 없앤다.
      await tx.reportDraft.deleteMany({
        where: { OR: drafts.map(d => ({ uid: d.uid, author: d.author })) },
      });
      // 판독문 전문은 감사로그에 넣지 않는다. 누구의 몇 글자를 지웠는지만 남긴다.
      await tx.auditLog.create({
        data: {
          actor: c.actor, action: 'report.draft.force-discard', target: uid,
          detail: dump({ by: me, drafts: summary, versions }),
        },
      });

      return { ok: true, count: drafts.length, drafts: summary, versions };
    });

    // 재시도 다리까지 **같은 매핑 안에 둔다.** 첫 시도만 감싸면 번호 충돌로 다시 돈 실행에서
    // 나온 CHECK 위반이 500으로 새어 나가고, 같은 요청이 두 가지 답을 갖게 된다.
    return this.reportLimitChecked(async () => {
      try {
        return await run();
      } catch (e: any) {
        // 다른 판독 확정이 같은 (uid, version)을 먼저 썼다면, 새 번호로 전체 작업을 한 번만 다시 한다.
        if (e?.code !== 'P2002') throw e;
        return run();
      }
    });
  }

  /**
   * 판독문 확정. 내용 저장 + 버전 적립 + RS 전이를 **한 번에, 트랜잭션으로** 한다.
   *
   * 왜 한 엔드포인트인가: 예전엔 프론트가 판독문 PUT과 상태 PATCH를 따로 쐈다.
   * 두 요청의 도착 순서가 뒤집히면 "승인됐는데 내용은 이전 것"인 상태가 남는다.
   * 판독문과 그 판독문의 상태는 같이 움직여야 하는 하나의 사실이다.
   */
  async commitReport(uid: string, body: any, c: Caller) {
    need(c.roles, 'radiologist', '판독문 확정');
    const me = inst(c);
    const action = body.action;
    if (!['save', 'approve', 'addendum', 'reset', 'preliminary', 'defer'].includes(action))
      throw new BadRequestException(`알 수 없는 action: ${action}`);
    /**
     * `citationIds`는 **내 초안 건에 대한 유지 목록**, `removeCitationIds`는 **머리 판 건에 대한
     * 명시적 제거 의사**다. 모양만 여기서 본다 — 모르는 값은 거절 사유가 아니라 무동작이다.
     * 그래서 낡은 화면은 제거에 실패할 수는 있어도 **보지 못한 건을 지울 수는 없다.**
     */
    const keepIds = this.citationKeys(body.citationIds, 'citationIds');
    const removeIds = this.citationKeys(body.removeCitationIds, 'removeCitationIds');
    // 구조화에는 `removeStructureIds`가 없다(P1). 머리 건이 빠지는 길은 **그 문장이 본문을
    // 떠나는 것** 하나뿐이고, 그래야 지운 적 없는 증언이 목록 하나로 사라지지 않는다.
    const structureKeepIds = this.structureKeys(body.structureIds, 'structureIds');

    const prev = await this.gate(uid, c);
    if (prev?.ss === 'Unverified' && prev.em !== 'E')
      throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
    const heldByOther = holdAlive(prev) && prev.holder !== c.actor ? prev.holder : null;
    if (heldByOther)
      throw new ConflictException({ code: 'REPORT_HELD', holder: heldByOther, message: `${heldByOther} 님이 판독 중입니다` });
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');

    // 예비 판독 중인 검사는 지정된 두 사람 말고는 쓰지도 못한다.
    // 읽기만 막고 쓰기를 열어두면, 내용을 못 본 채로 덮어쓸 수 있다 — 더 나쁘다.
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 이어서 판독할 수 있습니다.`);

    // Addendum은 승인된 판독에만 붙는다. 승인 전이라면 그냥 고쳐 쓰면 되기 때문.
    if (action === 'addendum' && prev?.rs !== 'A')
      throw new BadRequestException('Addendum은 승인(RS: A)된 판독문에만 붙일 수 있습니다');

    /**
     * 승인(A)에서 나가는 길도 둘뿐이다 — 이전 판을 남기는 Addendum, 사유가 남는 Reset.
     *
     * v0.6.3 회귀 확충에서 드러났다: `save`는 사유 없이 승인을 T로 떨어뜨리면서 repDoc·confirm을
     * 그대로 남겨 화면이 "읽었다"와 "아직 안 읽었다"를 동시에 말하게 했고, `approve`는 다른 판독의가
     * 본문과 승인자 이름을 조용히 갈아치우는 무표시 재승인이었다. 화면은 Save를 회색으로도 안 막았다.
     * P의 출구 규칙과 같은 모양으로 닫는다 — 하나만 닫으면 나머지 하나가 문이다.
     */
    if (prev?.rs === 'A' && (action === 'save' || action === 'approve'))
      throw new BadRequestException('승인된 판독문은 추가기재(Addendum) 또는 판독 취소(Reset)로만 바꿀 수 있습니다');

    // 판독을 되돌리는 것은 기록을 지우는 일이다. 사유 없이는 안 된다. (교훈 §1)
    if (action === 'reset' && !String(body.reason ?? '').trim())
      throw new BadRequestException('판독 취소에는 사유가 필요합니다');
    if (action === 'defer') {
      if (!String(body.reason ?? '').trim())
        throw new BadRequestException('보류에는 사유가 필요합니다');
      if (prev.rs === 'P')
        throw new BadRequestException('예비 판독(RS: P)은 보류할 수 없습니다 — 승인 또는 취소만 가능합니다');
      if (prev.rs === 'A')
        throw new BadRequestException('승인된 판독문은 보류할 수 없습니다. 먼저 판독 취소(Reset)를 하세요');
      if (!['W', 'T', 'H'].includes(prev.rs))
        throw new BadRequestException('대기·임시저장·보류 상태에서만 보류할 수 있습니다');
    }

    /**
     * ── Preliminary (RS=P) ──
     * "전문의가 상급 판독의를 지정하여 상급 판독의가 최종 판독하는 시스템"
     * (HPACS 매뉴얼 7.4.1.3-4). 별도의 전공의 롤이 있는 게 아니라, 누가 누구에게
     * 넘기느냐의 문제다. RS는 진행률이 아니라 **책임의 이전**을 표현한다 (교훈 §14).
     *
     * 지정 대상은 서버가 Keycloak에 물어 **실제로 존재하는 우리 기관 판독의**인지
     * 확인한다. 이 값이 판독문 접근을 좌우하므로, 클라이언트가 보낸 문자열을
     * 그대로 믿으면 오타 하나로 아무도 못 여는 판독문이 생긴다.
     */
    let reviewer: string | undefined;
    if (action === 'preliminary') {
      /**
       * 이미 승인된 판독문은 예비 판독으로 되돌릴 수 없다.
       *
       * 허용하면 확정된 의무기록이 지정된 두 사람만의 것이 되고, 본문이 body의
       * 빈 값으로 덮인다. 실제로 그렇게 됐다 — 승인자 본인조차 자기 판독문을 못 봤다.
       * 되돌리려면 사유가 남는 Reset을 거쳐야 한다.
       */
      if (prev?.rs === 'A')
        throw new BadRequestException(
          '승인된 판독문은 예비 판독으로 되돌릴 수 없습니다. 먼저 판독 취소(Reset)를 하세요');
      /**
       * 예비 판독(P) 중에는 다시 지정하지 못한다.
       *
       * 열어두면 사유 없이 preDoc이 호출자로 덮어써진다. 지정된 상급자가 작성자를 거꾸로
       * 지정하면 작성자가 preReviewer만 보는 아래 승인 관문을 지나 자기 예비 판독을 스스로
       * 승인하고, 제3자에게 넘기면 원래의 두 사람이 판독문에서 잠긴다. P에서 나가는 길은
       * 지정된 상급자의 승인과 사유가 남는 취소 둘뿐이다 — 지정을 바꾸려면 취소 뒤 다시 지정한다.
       * 화면도 P에서 Prelim을 막지만 화면 잠금이 서버 검사를 대신하지는 않는다.
       */
      if (prev?.rs === 'P')
        throw new BadRequestException(
          '예비 판독(RS: P) 중에는 지정을 바꿀 수 없습니다 — 사유를 남기는 판독 취소(Reset) 뒤 다시 지정하세요');
      reviewer = String(body.reviewer ?? '').trim();
      if (!reviewer) throw new BadRequestException('상급 판독의를 지정해야 합니다');
      if (reviewer === c.actor) throw new BadRequestException('자기 자신을 상급 판독의로 지정할 수 없습니다');
      const peers = await this.keycloak.usersInGroupWithRole(me, 'radiologist');
      if (!peers.some(u => u.id === reviewer))
        throw new BadRequestException(`${reviewer} 은(는) 이 기관의 판독의가 아닙니다`);
    }

    // 승인으로 P를 끝내는 것은 **지정된 상급 판독의**의 일이다.
    // 예비 판독을 쓴 사람이 스스로 승인하면 감독이라는 절차 자체가 없어진다.
    if (action === 'approve' && prev?.rs === 'P' && prev.preReviewer !== c.actor)
      throw new ForbiddenException(
        `예비 판독의 최종 승인은 지정된 상급 판독의(${prev.preReviewer})만 할 수 있습니다`);

    let rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W', preliminary: 'P', defer: 'H' }[action];

    /**
     * **예비 판독 중에는 임시 저장이 P를 풀지 못한다.**
     *
     * 이걸 빼먹어서 감독이 통째로 우회됐다: 작성자가 `save`로 RS를 T로 떨어뜨린 뒤
     * `approve`를 부르면, 위의 검사가 `prev.rs === 'P'`를 보므로 그냥 통과했다.
     * 정상 호출 두 번에 상급자 감독이 사라졌다.
     *
     * P에서 빠져나가는 길은 두 개뿐이다 — 지정된 상급자의 승인, 또는 사유가 남는 취소.
     * 그 사이의 저장은 여전히 예비 판독이다.
     */
    if (prev?.rs === 'P' && action === 'save') rs = 'P';
    const content = action === 'reset'
      ? { findings: '', conclusion: '', recommendation: '' }
      : {
          findings: body.findings ?? '',
          conclusion: body.conclusion ?? '',
          recommendation: body.recommendation ?? '',
        };

    const stateData: any = { rs, holder: null, heldAt: null };   // 확정하면 점유가 풀린다
    stateData.holdReason = action === 'defer' ? body.reason : null;
    if (action === 'preliminary') {
      stateData.preDoc = c.actor;
      stateData.preReviewer = reviewer;
    }
    // 판독이 되돌아가면 지정도 풀린다. RS는 W인데 "누구에게 맡겨져 있음"이 남아
    // 판독문이 계속 가려지는 상태가 제일 나쁘다.
    if (action === 'reset') {
      // 판독이 되돌아가면 그 판독에 딸린 이름도 함께 지운다. RS는 W인데 RepDoc에
      // 판독의 이름과 확정일이 남아 있으면, 화면은 "누가 읽었다"고 말하면서
      // 동시에 "아직 안 읽었다"고 말하는 셈이다.
      stateData.preDoc = null; stateData.preReviewer = null;
      stateData.repDoc = null; stateData.confirm = null;
    }
    if (action === 'approve' || action === 'addendum') {
      stateData.repDoc = c.actor.split('@')[0];
      stateData.confirm = new Date().toISOString().slice(0, 10);
      // 원격판독으로 받은 검사를 승인하면 의뢰 기관에 "끝났다"가 보여야 한다.
      // 상태가 상대편에 도달하지 않으면 워크플로가 아니라 파일 전송일 뿐이다 (교훈 §10).
      if (prev?.teleInstitutionId === me && prev?.institutionId !== me) stateData.ts = 'completed';
    }

    let results: [any, number];
    // 감사는 트랜잭션 밖에서 남는다. 되돌아간 확정에는 감사도 남지 않으므로 이 값은
    // 성공한 경로에서만 읽힌다.
    let citationAudit: any = null;
    let structureAudit: any = null;
    let structured: any[] = [];
    try {
      results = await this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
        // 첫 확정에는 아직 Report 행이 없어 FOR UPDATE만으로 잠글 수 없다. B 적용 후
        // 항상 존재하는 StudyState를 먼저 잠가 첫 판부터 같은 uid의 확정을 직렬화한다.
        await tx.$queryRaw`
          SELECT uid FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;

        // 안정된 부모 행을 잡은 뒤 현재 Report를 잠근 채 판 번호를 읽는다.
        const [cur] = await tx.$queryRaw<any[]>`
          SELECT version, "updatedBy", findings, conclusion, recommendation
          FROM "Report" WHERE uid = ${uid} FOR UPDATE`;

        if (body.baseVersion === undefined)
          throw new BadRequestException('baseVersion이 필요합니다 (화면이 마지막으로 본 판 번호)');

        /**
         * **낡은 초안은 승인본에 덧붙지 못한다.**
         *
         * 화면이 보내는 `baseVersion`은 본문을 다시 그리지 않고도 올라간다 —
         * PATCH 응답 한 번이면 `appState`의 판 번호가 최신이 된다(`main.html:1175`).
         * 그러면 아래 낙관적 락은 통과하고, 며칠 전 초안이 그 사이 승인된 판독문을
         * 통째로 대체한다(원장 IF-A24 「승인본 자동 덮어쓰기 금지」).
         * 그래서 화면이 말하는 판이 아니라 **초안 행에 적힌 판**을 본다.
         *
         * 아래 낙관적 락보다 **먼저** 본다. 락이 먼저 걸리면 사람은 "다시 불러오라"는
         * 옛 안내를 받고, 그 경로는 쓰던 글을 서버 내용으로 덮는다 — 정확히 이 단위가
         * 막으려는 손실이다. 거절 본문은 이미 잠가서 읽은 `cur` 행 그대로이므로
         * 추가 조회가 없고, 여기까지 온 호출자는 예비 판독·기관·역할 관문을 모두 지났다.
         *
         * 심층 방어다. 초안이 없는 확정은 구조적으로 이 관문을 지나가고,
         * `baseVersion`의 출처가 틀린 화면은 조용히 통과한다.
         */
        if (action === 'addendum') {
          const draft = await tx.reportDraft.findUnique({
            where: { uid_author: { uid, author: c.actor } }, select: { baseVersion: true },
          });
          if (draft && draft.baseVersion < (cur?.version ?? 0))
            throw new ConflictException({
              code: 'REPORT_DRAFT_STALE',
              message: `이 초안은 v${draft.baseVersion}을 기준으로 씁니다. 지금 승인본은 ` +
                `v${cur.version}입니다 — 승인본을 확인한 뒤 기준을 다시 잡아 주세요.`,
              head: {
                version: cur.version, updatedBy: cur.updatedBy ?? null,
                findings: cur.findings, conclusion: cur.conclusion, recommendation: cur.recommendation,
              },
              draftBaseVersion: draft.baseVersion,
            });
        }

        if ((cur?.version ?? 0) !== body.baseVersion)
          throw new ConflictException(
            `그 사이 ${cur?.updatedBy ?? '다른 사용자'}가 v${cur?.version}을 저장했습니다. ` +
            `내용을 다시 불러온 뒤 작성해 주세요.`);

        /**
         * **이월은 머리 판에서만 온다.**
         *
         * 바로 아래 `last`는 머리 판이 아니다 — reset과 관리자 강제 해제가 만든 `discarded`
         * 행이 더 큰 번호를 갖고도 `Report.version`을 움직이지 않기 때문이다. 그것을 머리로
         * 쓰면 **남의 확정되지 않은 초안 인용이 내 서명 판에 「이월됨」으로 들어간다.**
         * 머리 판은 오직 `ReportVersion(uid, Report.version)` 한 행이고, 그 행은 불변이다.
         *
         * 낙관적 락 **뒤**에 읽는다. 거절되는 확정은 아무것도 더 읽지 않아야 한다.
         */
        const headCitations = await this.versionCitations(tx, uid, cur?.version ?? 0);
        /**
         * 내 초안 행을 **잠그고** 읽는다.
         *
         * 잠그지 않으면 다른 탭의 삽입이 이 읽기와 아래의 초안 삭제 사이에 끼어들 수 있고,
         * 그러면 사용자가 미리보기에서 확인까지 마친 문장의 증언이 행과 함께 사라진다 —
         * 잃는 것이 남의 것이 아니라 **본인이 방금 한 일**이다. 삽입도 같은 행을 같은 방식으로
         * 잠그므로 둘은 순서대로 선다: 삽입이 먼저면 여기서 함께 읽히고, 확정이 먼저면 삽입은
         * 행이 사라진 뒤에 자기 행을 새로 만든다. 어느 쪽도 조용히 없어지지 않는다.
         *
         * 잠금 순서는 StudyState → Report → 내 초안이고, 강제 해제는 StudyState → 초안들,
         * 삽입은 내 초안 하나뿐이다. 모두 같은 방향이라 순환이 없다.
         */
        const headStructured = await this.versionStructured(tx, uid, cur?.version ?? 0);
        const [mine] = await tx.$queryRaw<any[]>`
          SELECT citations, structured FROM "ReportDraft" WHERE uid = ${uid} AND author = ${c.actor} FOR UPDATE`;
        const { kept, ignored } = applyKeepList(citationArray(mine?.citations), keepIds);
        const union = citationUnion(headCitations, removeIds, kept);
        const mineStructured = applyStructureKeepList(structureArray(mine?.structured), structureKeepIds);
        // 세 칸이 빈 확정과 reset은 본문이 없으니 증언할 것도 없다.
        const blank = !(content.findings || content.conclusion || content.recommendation);
        const citations = (action === 'reset' || blank) ? [] : union.entries;
        /**
         * 확정 시 **소견 검증은 하지 않는다.** 삽입 뒤 소견이 숨겨지거나 비교 검사 접근이
         * 회수되어도 서명은 막히지 않는다 — 기록을 남기지 못하게 하는 쪽이 더 나쁘다.
         * 한도 초과만이 새 거절이다.
         */
        await this.citationBudget(tx, citations);
        citationAudit = (citations.length || union.removed.length || ignored)
          ? { n: citations.length, ...(union.removed.length ? { dropped: union.removed } : {}),
              ...(ignored ? { ignored } : {}) } : null;

        /**
         * 구조화는 **한 가지 규칙**으로 고른다 (P1): 머리에서 왔든 초안에서 왔든, 그 문장이
         * 확정될 본문에 있을 때만 실린다. 인용과 달리 출처를 다시 묻지 않는다 — 구조화 건은
         * 자기 문장 말고 아무것도 가리키지 않기 때문이다.
         */
        const selection = commitStructureSelection(
          structureUnion(headStructured, mineStructured.kept), content, blank, action === 'reset');
        structured = selection.entries;
        await this.structureBudget(tx, structured);
        structureAudit = (structured.length || selection.dropped.length || mineStructured.ignored)
          ? { n: structured.length, ...(selection.dropped.length ? { dropped: selection.dropped } : {}),
              ...(mineStructured.ignored ? { ignored: mineStructured.ignored } : {}) } : null;

        const last = await tx.reportVersion.findFirst({
          where: { uid }, orderBy: { version: 'desc' }, select: { version: true },
        });
        let version = (last?.version ?? 0) + 1;

        // Reset은 현재 판독문을 비우기 직전에 이력으로 보존한다. 같은 트랜잭션이라
        // 실패하면 비움도 스냅샷도 함께 취소되어 판독문을 잃을 틈이 없다.
        if (action === 'reset' && cur &&
            (cur.findings || cur.conclusion || cur.recommendation)) {
          await tx.reportVersion.create({ data: {
            uid, version, action: 'discarded',
            findings: cur.findings, conclusion: cur.conclusion,
            recommendation: cur.recommendation,
            // 비우기 직전의 본문을 판으로 남기면서 그 증언만 버리면, 보존된 글이 어디서
            // 왔는지 되짚을 수 없다. 같은 머리 판 행에서 읽은 그대로 함께 보존한다.
            citations: headCitations,
            // 구조화도 같은 이유로 함께 보존한다. 다만 빈 배열은 저장하지 않는다(P13) —
            // "없음"의 모양은 NULL 하나여야 읽는 쪽이 두 가지를 구분할 일이 없다.
            ...(headStructured.length ? { structured: headStructured } : {}),
            reason: `판독 취소로 폐기 (취소자: ${c.actor})`,
            author: cur.updatedBy ?? c.actor,
          }});
          version += 1;
        }

        const state = await tx.studyState.update({ where: { uid }, data: stateData });
        await tx.report.upsert({ where: { uid },
          create: { uid, ...content, version, updatedBy: c.actor },
          update: { ...content, version, updatedBy: c.actor } });
        // 인용은 **`ReportVersion` 행에만** 쓴다. `Report`에는 칸이 없다 — 거울을 두면
        // 같은 사실이 두 곳에서 엇갈릴 수 있고, 그 순간 어느 쪽이 기록인지 말할 수 없다.
        await tx.reportVersion.create({ data: {
          uid, version, action, ...content, citations,
          ...(structured.length ? { structured } : {}),
          reason: body.reason ?? null, author: c.actor } });
        // 확정에 실패하면 초안도 남아야 하므로 같은 트랜잭션에서 지운다.
        await tx.reportDraft.deleteMany({ where: { uid, author: c.actor } });
        return [state, version] as [any, number];
      });
    } catch (e: any) {
      // CHECK 백스톱도 서버 고장이 아니라 명명된 409다. 우리 제약 이름일 때만 옮긴다.
      if (isCitationCheck(e)) citationLimit();
      if (isStructureCheck(e)) structureLimit();
      // @@unique(uid, version)은 최종 방어선이다. 불변조건이 깨져 충돌하더라도
      // 서버 고장으로 노출하지 않도록 C-1의 409 변환은 그대로 유지한다.
      if (e?.code === 'P2002')
        throw new ConflictException(
          '다른 사용자가 방금 이 판독문을 확정했습니다. 내용을 다시 불러온 뒤 확정해 주세요.');
      throw e;
    }
    const [state, version] = results;

    await this.audit(c.actor, `report.${action}`, uid, {
      version, by: me,
      len: [content.findings.length, content.conclusion.length, content.recommendation.length],
      reason: body.reason ?? undefined,
      reviewer,   // 누구에게 맡겼는가. 책임이 옮겨간 기록이므로 감사로그에 남아야 한다.
      // 몇 건이 남았고 무엇이 **지워졌는가**. 지워진 증언은 되짚을 자리가 여기뿐이라
      // `cid`는 남기지만, `findingId`·`sourceIndex`·문구는 남기지 않는다.
      ...(citationAudit ? { cits: citationAudit } : {}),
      // 구조화도 같은 규칙이다 — 건수와 `sid`만. 값·문장·항목 코드는 남기지 않는다(P16).
      ...(structureAudit ? { strs: structureAudit } : {}),
    });

    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor, await this.myDraft(uid, c.actor));
  }

  /**
   * 판독문 점유 선언 / 하트비트.
   *
   * 점유는 **열람이 아니라 쓰기**로 시작한다(프론트가 두 글자 이상 입력했을 때 부른다).
   * 검사를 열어보는 건 흔한 일이라 그걸 점유로 치면 경고가 남발되고, 남발된 경고는 무시된다.
   * (HPACS도 2021년에 이 기준으로 바꿨다 — 교훈 §2)
   *
   * 이미 다른 사람이 살아 있는 점유를 갖고 있으면 **막지 않고 알려준다.**
   * 응급 판독을 자물쇠로 막는 건 위험하다. 실제 충돌은 저장 시점의 버전 비교가 잡는다.
   *
   * 원격판독으로 넘어간 검사는 두 기관의 판독의가 동시에 열 수 있다 —
   * 점유가 기관을 넘어 보여야 하는 이유가 여기 있다.
   */
  async hold(uid: string, c: Caller) {
    need(c.roles, 'radiologist', '판독문 점유');
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await this.studyAccess.require(c,[uid],tx);
      const rows=await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid=${uid} FOR UPDATE`;
      const prev=rows[0];
      if(!prev||!this.visible(prev,inst(c)))throw new NotFoundException('검사를 찾을 수 없습니다');
      if(prev.ss==='Unverified'&&prev.em!=='E')throw new ConflictException('촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
      if(!canReadPrelim(prev,c.actor))throw new ForbiddenException('예비 판독(RS: P) 중인 검사입니다');
      const other=holdAlive(prev)&&prev.holder!==c.actor?prev.holder:null;
      if(!other){
        await tx.studyState.update({where:{uid},data:{holder:c.actor,heldAt:new Date()}});
        if(!holdAlive(prev))await tx.auditLog.create({data:{actor:c.actor,action:'report.hold',target:uid}});
      }
      return {holder:other??c.actor,mine:!other,conflict:!!other};
    },{maxWait:4000,timeout:8000}).catch(noteTransactionError);
  }

  /** 점유 해제 (검사를 옮기거나 판독을 확정할 때) */
  async release(uid: string, c: Caller) {
    return this.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'radiologist', '판독문 점유 해제');   // hold와 같은 역할 경계
    const prev = await this.gate(uid,c,tx);
    if (!prev || prev.holder !== c.actor) return { ok: true };   // 내 것이 아니면 건드리지 않는다
    await tx.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    return { ok: true };
    });
  }

  async forceRelease(uid: string, c: Caller) {
    return this.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'admin', '판독 점유 강제 해제');
    const prev = await this.gate(uid,c,tx);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    await tx.studyState.update({ where: { uid }, data: { holder: null, heldAt: null } });
    // 점유가 없었어도 관리자 조치의 호출 흔적은 남긴다.
    await audit(c.actor, 'hold.force-release', uid, {
      by: inst(c), holder: prev.holder ?? null, heldAt: prev.heldAt ?? null, alive: holdAlive(prev),
    });
    return { ok: true, released: prev.holder ?? null };
    });
  }

  /** 판독문 이력 (최신순) */
  async versions(uid: string, c: Caller) {
    const prev = await this.gate(uid, c);
    /**
     * 행이 없는 uid는 없는 검사다. gate()는 "안 보이는 검사"만 404로 바꾸고 "없는 검사"는 null로
     * 흘려보내는데, 그러면 삭제된 검사에 남은 discarded 이력이 **모든 기관**에 읽혔다(v0.6.3 회귀 확충에서
     * 발견). 이력의 조회 관문은 StudyState 행이다 — 행이 없으면 기관을 가를 수 없고, 가를 수 없으면 거절한다.
     */
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    // 본문을 가려놓고 이력에서 읽히면 가린 게 아니다. 같은 규칙을 여기에도 건다.
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    /**
     * 칸을 **명시해서** 고른다. 행 전체를 돌려주면 새로 생긴 인용 칸이 이력 응답으로
     * 그대로 나간다 — 관문을 하나도 새로 만들지 않았는데 노출면만 넓어지는 것이다.
     * 인용은 전용 읽기 하나에서만, 소견 가독을 다시 건 뒤에 나간다.
     */
    return this.prisma.reportVersion.findMany({ where: { uid }, orderBy: { version: 'desc' },
      select: { id: true, uid: true, version: true, action: true, findings: true, conclusion: true,
        recommendation: true, reason: true, author: true, at: true } });
  }

  /**
   * 인용 전용 읽기 — **소견 가독을 다시 거는 유일한 표면**이다.
   *
   * 판독문 관문(기관·예비 판독)은 소견 관문보다 넓다. 소견은 계보에 읽을 수 없는 검사가
   * 하나라도 있으면 목록·이력·재생에서 통째로 빠지는데, 인용을 판독문 관문만으로 내보내면
   * 그 좁은 관문이 이 통로로 우회된다. 그래서 여기서 한 번 더 건다.
   *
   * 한 `RepeatableRead` 트랜잭션 안에서 머리 판과 내 초안을 함께 읽는다 — 두 번 읽으면
   * 그 사이 확정이 끼어들어 "머리에는 없고 초안에는 있는" 없는 상태를 그릴 수 있다.
   */
  async reportCitations(uid: string, c: Caller) {
    const prev = await this.gate(uid, c);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    // 본문을 가려놓고 그 증언이 읽히면 가린 게 아니다. `versions()`와 같은 규칙을 건다.
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    // 소견 계보의 접근 정책은 트랜잭션 밖에서 준비한다(`putReport`와 같은 이유).
    await this.studyAccess.prepare(c);
    return this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
      const report = await tx.report.findUnique({ where: { uid }, select: { version: true } });
      const head = await this.versionCitations(tx, uid, report?.version ?? 0);
      const draft = await tx.reportDraft.findUnique({
        where: { uid_author: { uid, author: c.actor } }, select: { citations: true } });
      const mine = citationArray(draft?.citations);
      /**
       * **행마다 따로 묻는다.** 한 행은 CHECK가 64건으로 묶지만 머리 + 초안은 128건까지 갈 수
       * 있고, 바로 그 상태(머리 40 + 초안 30)가 확정이 `REPORT_CITATION_LIMIT`으로 거절하는
       * 경우다. 한 번에 물으면 그 질의가 64 한도에 먼저 걸려 409가 되고, **어떤 `cid`를 지워야
       * 하는지 알려주는 유일한 표면**이 닫힌다 — "제거하면 서명할 수 있다"고 말해놓고 제거할
       * 대상을 못 보여주는 셈이다.
       */
      const findingIds = (entries: any[]) =>
        [...new Set(entries.map(entry => String(entry?.findingId ?? '')).filter(Boolean))];
      const readable = new Set<string>();
      for (const ids of [findingIds(head), findingIds(mine)])
        for (const row of await this.findings.readableFindings(tx, c, uid, ids)) readable.add(String(row.id));
      /**
       * `sameTextCount`는 **그 행 전체**(축약된 건 포함)에서 센다. 화면이 자기가 받은
       * 건수로 세면 축약된 건이 빠져, `ambiguous`여야 할 것이 `present`로 보인다.
       * 머리 판과 초안은 서로 다른 본문을 가진 다른 행이므로 따로 센다.
       */
      const project = (entries: any[]) => {
        const counts = sameTextCounts(entries);
        return entries.map((entry, i) => projectCitation(entry, readable.has(String(entry?.findingId ?? '')), counts[i]));
      };
      return { version: report?.version ?? 0, head: project(head), draft: project(mine) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  /**
   * 구조화 전용 읽기 — 머리 판과 내 초안의 타입 있는 값.
   *
   * 관문은 `versions()`와 **같은 것**이다(기관 + 예비 판독). 인용 읽기가 소견 가독을 한 번 더
   * 거는 이유는 인용이 소견 계보를 가리키기 때문인데, 구조화 건은 자기 문장 말고 아무것도
   * 가리키지 않는다. 그래서 그 좁은 관문을 여기에 옮겨 붙이지 않고(가짜 안전), 인용 읽기의
   * 의미를 넓히지도 않는다. 나가는 내용은 이미 `versions()`가 내보내는 본문의 부분집합이다.
   *
   * 확정은 매번 초안 행을 지우므로(`:2353`) 한 번 저장한 뒤의 값은 전부 머리 판에 있다.
   * 그래서 이 읽기가 없으면 Save 한 번에 화면의 구조화 상태가 통째로 사라진다.
   *
   * 한 `RepeatableRead` 트랜잭션 안에서 머리와 초안을 함께 읽는다 — 두 번 읽으면 그 사이
   * 확정이 끼어들어 "머리에는 없고 초안에는 있는" 없는 상태를 그릴 수 있다.
   */
  async reportStructure(uid: string, c: Caller) {
    const prev = await this.gate(uid, c);
    if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
    if (!canReadPrelim(prev, c.actor))
      throw new ForbiddenException(
        `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
    return this.prisma.$transaction(async tx => {
      const report = await tx.report.findUnique({ where: { uid },
        select: { version: true, findings: true, conclusion: true, recommendation: true } });
      const head = await this.versionStructured(tx, uid, report?.version ?? 0);
      const draftRow = await tx.reportDraft.findUnique({
        where: { uid_author: { uid, author: c.actor } },
        select: { findings: true, conclusion: true, recommendation: true, structured: true } });
      const mine = structureArray(draftRow?.structured);
      /**
       * 한 건이라도 모양이 틀리면 **답 전체가 모른다**가 된다. 틀린 건만 빼고 나머지를
       * 정상처럼 돌려주면, 화면은 자기가 본 것이 전부라고 믿고 유지 목록을 만들어 보낸다 —
       * 그 순간 읽지 못한 건이 조용히 지워진다.
       */
      if (!head.every(isStructureEntry) || !mine.every(isStructureEntry))
        return { version: report?.version ?? 0, unknown: true, head: null, draft: null };
      const project = (entries: any[], body: any) => {
        const counts = structureSameTextCounts(entries);
        return entries.map((entry, i) =>
          projectStructure(entry, String(body?.[String(entry.field)] ?? ''), counts[i]));
      };
      return { version: report?.version ?? 0, unknown: false,
        head: project(head, report), draft: project(mine, draftRow) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  /**
   * 과거 판의 인용 — **보존된 한 행**의 증언.
   *
   * 머리 읽기(위)는 지금 열려 있는 판독문의 것이고, 이력에 쌓인 판의 증언은 `versions()`가
   * 칸을 명시해 빼고 있어 **어떤 표면도 읽지 않았다.** 그 행은 확정과 같은 트랜잭션에서 쓰이고
   * 다시 바뀌지 않으므로 본문과 증언이 어긋날 수 없다.
   *
   * 나가는 것은 **메타데이터뿐**이다. 머리 읽기가 `insertedText`·`cid`를 싣는 이유는 편집 화면이
   * 제거를 고르고 **살아 있는** 본문과 대조해야 하기 때문인데, 과거 판에는 지울 것도 바뀔 본문도
   * 없다. 그래서 존재 상태는 **여기서, 그 행 자신의 본문에 대해** 계산해 한 낱말로 보내고 문구와
   * 식별자는 서버를 떠나지 않는다. 화면이 본문을 갖지 않으므로 **틀린 본문으로 셀 방법이 없다.**
   */
  async reportVersionCitations(uid: string, version: string, c: Caller) {
    /**
     * 표준 십진 · `Int` 범위만 받는다. 어떤 DB 읽기보다 **먼저** 거절한다 — `prepare()`도
     * 정책 읽기다. 관용 변환(`Number()`)을 쓰면 `'1e2'`·`'0x10'`·`' 1'`·`'01'`·`'+1'`이 실제
     * 판의 별칭이 되고, 2^31 이상은 `Int` 컬럼에 닿아 400도 404도 아닌 실패가 된다.
     */
    if (!/^[1-9][0-9]{0,9}$/.test(version) || Number(version) > 2147483647)
      throw new BadRequestException('판 번호를 확인하세요');
    const want = Number(version);
    /**
     * uid 목록 **없이** 준비한다. 이 메서드에는 트랜잭션 밖 `gate()`가 없어 밖에서 도는
     * `require`도 없으므로, 아래 트랜잭션 안의 재검사는 이 호출이 채운 캐시에만 기댈 수 있다.
     */
    await this.studyAccess.prepare(c);
    return this.prisma.$transaction(async tx => {
      /**
       * 관문과 판 읽기가 **한 스냅샷** 안에 있다. 밖에서 읽으면 그 사이에 예비 판독이 끼어들어
       * RS=P가 된 판을 그 관문을 거치지 않은 채 답할 수 있다.
       */
      const prev = await this.gate(uid, c, tx);
      if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
      if (!canReadPrelim(prev, c.actor))
        throw new ForbiddenException(
          `예비 판독(RS: P) 중입니다. ${prev?.preReviewer ?? '지정된 판독의'}만 볼 수 있습니다.`);
      const row = await tx.reportVersion.findUnique({
        where: { uid_version: { uid, version: want } },
        // 네 칸뿐이다. `action`·`author`·`at`·`reason`은 이력 응답의 것이고, 여기서 다시 나가면
        // 관문을 하나도 새로 만들지 않은 채 노출면만 넓어진다.
        select: { citations: true, findings: true, conclusion: true, recommendation: true },
      });
      // 없는 판을 「인용 없음」으로 답하면 그 자체가 거짓말이다.
      if (!row) throw new NotFoundException('그 판을 찾을 수 없습니다');
      const entries = citationArray(row.citations);
      // `n`은 **행 전체**에서 센다. 축약된 건이 빠지면 `ambiguous`여야 할 것이 `present`가 된다.
      const counts = sameTextCounts(entries);
      const ids = [...new Set(entries.map(entry => String(entry?.findingId ?? '')).filter(Boolean))];
      const readable = new Set<string>();
      for (const found of await this.findings.readableFindings(tx, c, uid, ids)) readable.add(String(found.id));
      return { version: want, actor: c.actor, entries: entries.map((entry, index) => {
        if (!readable.has(String(entry?.findingId ?? '')))
          return { field: entry?.field ?? null, insertedAt: entry?.insertedAt ?? null,
            insertedBy: entry?.insertedBy ?? null, state: SOURCE_UNAVAILABLE };
        /**
         * 셀 수 없는 건은 **모른다고 말한다.** `lineBlockOccurrences`는 문자열이 아닌 값을
         * `''`로 바꾸므로 그대로 세면 0회 → `absent`가 되어, 확인하지 못한 것을 「더는
         * 없습니다」로 지어내게 된다. 화면은 이 `null`을 보고 그 판 전체를 미확인으로 만든다.
         */
        const countable = REPORT_CITATION_FIELDS.includes(entry?.field)
          && typeof entry?.insertedText === 'string';
        return { field: entry?.field ?? null, findingRevision: entry?.findingRevision ?? null,
          sourceIndex: entry?.sourceIndex ?? null, linkStateAtInsert: entry?.linkStateAtInsert ?? null,
          insertedAt: entry?.insertedAt ?? null, insertedBy: entry?.insertedBy ?? null,
          presence: countable
            ? presenceState(lineBlockOccurrences(String((row as any)[entry.field] ?? ''), entry.insertedText), counts[index])
            : null };
      }) };
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  // ══════════════════ S5-U1b 임상의 읽기 ══════════════════
  // REQ-S5-U1b-CLINICIAN-READ. 모양은 clinician-policy.ts의 순수 투영이 정하고, 여기서는 범위와 스냅샷만 정한다.

  /**
   * 임상의 목록. **워크리스트 목록(listStudies) 그 자체를 부르고** 행을 좁힌다 — 기관·원격판독·StudyAccess·
   * lazy 등록·페이지·접근 재검사를 따로 흉내 내면 둘 중 하나만 고쳐지는 날이 온다. 워크리스트 행의 초안·기사
   * 메모·판독의 배정·Gateway 영수증·오더 대사·관측 부재·observedAt은 clinicianList가 버리고 싣지 않는다.
   * total·이어받기는 워크리스트와 같다 — 볼 수 있는 검사만 센다.
   *
   * 판독 상태(rs·repDoc·confirm·판 번호·머리 판 action)는 워크리스트 행에서 가져오지 않는다. listStudies는 StudyState와
   * Report를 따로 읽으므로 그 사이 Addendum이 끼면 새 판 번호에 이전 서명자가 붙는다. 여기서 **한 SQL 문장**(한 스냅샷)으로
   * 기관 두 칸과 판독 상태를 함께 읽어 그 행에서만 상태를 만들고, 워크리스트 행과 그 칸들(CLINICIAN_LIST_PINS)이 하나라도
   * 다르면 워크리스트와 같은 409로 답 전체를 거절한다. 정책 변경은 StudyAccessInterceptor가 요청 전체에서 본다.
   */
  async clinicianStudies(c: Caller, query?: any) {
    this.clinicianCaller(c);
    const list = await this.listStudies(c, query);
    const uids: string[] = list.studies.map((row: any) => row.uid);
    const current = !uids.length ? [] : await this.prisma.$queryRaw<any[]>`
      SELECT s.uid, s."institutionId", s."teleInstitutionId", s.rs, s."repDoc", s.confirm,
        COALESCE(r.version, 0) AS version, v.action
      FROM "StudyState" s
      LEFT JOIN "Report" r ON r.uid = s.uid
      LEFT JOIN "ReportVersion" v ON v.uid = r.uid AND v.version = r.version
      WHERE s.uid IN (${Prisma.join(uids)})`;
    if (clinicianListChanged(list.studies, current))
      throw new ConflictException({ code: 'STUDY_LIST_CHANGED', message: '검사 목록 또는 판독 상태가 바뀌었습니다. 새로고침하세요.' });
    return clinicianList(list, current);
  }

  /**
   * 임상의 판독 읽기. 머리 판이 확정본(clinicianFinal)이면 **그 행의** 본문과 key image를, 아니면 상태만 준다
   * (S5-F5, D-S5-NONFINAL-VIEW 미결). 초안·이력·인용·구조화·작성자 칸은 없다. 예비 판독(P)도 상태만이라
   * 지정된 두 사람 규칙(canReadPrelim)을 넓히지 않는다. key image는 판독문 미리보기와 같은 조회다
   * (숨기지 않은 kind=key, 512건 한도).
   */
  async clinicianReportRead(uid: string, c: Caller) {
    return this.clinicianScope(uid, c, async (tx, state, head) => {
      const report = clinicianReport(state, head);
      if (!report.final) return { uid, report, keys: null };
      const rows = await tx.viewerItem.findMany({ where: { studyUid: uid, hidden: false,
        snapshot: { path: ['kind'], equals: 'key' } }, orderBy: { id: 'asc' }, take: 513,
        select: { id: true, revision: true, hidden: true, snapshot: true } });
      if (rows.length > 512) throw new ForbiddenException('키 이미지 목록 한도를 초과했습니다');
      return { uid, report, keys: rows.map(clinicianKeyImage).filter(Boolean) };
    });
  }

  /**
   * 표시 항목 관문(viewer.controller): 호출자·검사 범위(밖이면 404)를 판정하고, 지금 머리 판이 확정본이면 **그 판 번호**를,
   * 아니면 null을 답한다. true/false로 줄이지 않는 이유: 관문 두 번이 모두 "확정"이어도 그 사이 reset → 재승인이 끼었을
   * 수 있고, 그것은 판 번호로만 드러난다(clinicianViewerPinned).
   */
  async clinicianViewerHead(uid: string, c: Caller): Promise<number | null> {
    return this.clinicianScope(uid, c, async (_tx, state, head) => clinicianFinal(state.rs, head) ? head.version as number : null);
  }

  /**
   * 임상의 읽기의 호출자 관문. clinician 역할(need의 admin 예외 포함)과 회원 신원만 받는다 —
   * 판독의·기사는 자기 화면의 넓은 경로를 이미 갖고 있어 이 좁은 응답이 필요 없다. 기관은 inst()/gate()가 본다.
   */
  private clinicianCaller(c: Caller) {
    if (c.kind !== 'member') throw new ForbiddenException('회원 전용입니다');
    need(c.roles, CLINICIAN_ROLE, '임상의 조회');
  }

  /**
   * 임상의 판독 읽기와 표시 항목 관문이 함께 쓰는 **한 스냅샷**: 검사 범위(기관·원격판독·StudyAccess, 밖이거나
   * 행이 없으면 404 — 존재 여부도 정보다)와 머리 판. 머리 판은 `Report.version` 번 행 하나다 — reset이 남긴 더 큰
   * 번호의 discarded 행은 머리가 아니다. 범위 판정과 본문 읽기를 한 트랜잭션에 두어, 그 사이 reset·원격판독
   * 취소가 끼어들어 확정본이 아닌 판이나 범위 밖 검사가 답이 되지 않게 한다.
   */
  private async clinicianScope<T>(uid: string, c: Caller, work: (tx: any, state: any, head: any) => Promise<T>): Promise<T> {
    this.clinicianCaller(c);
    viewerUid(uid);
    // 원본 태그 조건이 있는 접근 정책은 트랜잭션 밖에서 준비한다(reportCitations와 같은 이유).
    await this.studyAccess.prepare(c, [uid]);
    return this.prisma.$transaction(async tx => {
      const state = await this.gate(uid, c, tx);
      if (!state) throw new NotFoundException('검사를 찾을 수 없습니다');
      const report = await tx.report.findUnique({ where: { uid }, select: { version: true } });
      const head = report?.version > 0 ? await tx.reportVersion.findUnique({
        where: { uid_version: { uid, version: report.version } },
        select: { version: true, action: true, findings: true, conclusion: true, recommendation: true } }) : null;
      return work(tx, state, head);
    }, { isolationLevel: 'RepeatableRead', maxWait: 2000, timeout: 5000 });
  }

  /**
   * 내 기관의 판독의 목록 — Preliminary에서 상급 판독의를 고를 때 쓴다.
   * 사용자 목록은 Keycloak에 있고, 우리 DB에 복사본을 만들면 두 곳이 어긋난다.
   */
  async colleagues(c: Caller) {
    need(c.roles, 'radiologist', '판독의 목록 조회');   // Preliminary 지정 화면 전용
    const me = inst(c);
    const users = await this.keycloak.usersInGroupWithRole(me, 'radiologist');
    return users.filter(u => u.id !== c.actor);   // 자기 자신은 지정 대상이 아니다
  }

  /**
   * Match (8.1.2.1.1): 오더 정보를 검사에 덮어쓴다.
   * 두 테이블을 같이 바꾸므로 트랜잭션. 하나만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
   */
  async match(uid: string, oid: string, patient: any, c: Caller) {
    need(c.roles, 'technician', '오더 매칭');
    const me = inst(c);
    const order = await this.prisma.order.findUnique({ where: { oid } });
    if (!order) throw new BadRequestException('오더를 찾을 수 없습니다');
    // 오더도 검사도 내 기관 것이어야 한다. 남의 병원 오더를 우리 검사에 붙이면
    // 환자 정보가 기관을 넘어 덮어써진다 — 조용히 섞이는 최악의 경로다.
    if (order.institutionId !== me) throw new BadRequestException('오더를 찾을 수 없습니다');

    const prev = await this.gate(uid, c);
    await this.studyAccess.prepare(c,[uid]);
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭할 수 없습니다 (보유 기관의 일입니다)');
    // Match도 환자 정보를 덮어쓰는 동작이므로 같은 규칙을 받는다
    if (prev && prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭할 수 있습니다 (현재 RS: ${prev.rs})`);
    // S4-U5 (N-1): the client-claimed original is stored and relayed like the overlay, so it gets the same shape
    // check, after every existing refusal above. Mismatch or identity never refuses a match.
    if (!overlayShape(patient?.orig ?? null))
      throw new BadRequestException(`원래 정보(orig) 형식이 잘못되었습니다 — ${OVERLAY_RULE_TEXT}`);

    // S4-NB1: age is the client's untrusted ageOf convenience value relayed to every viewer incl. tele: coerce to '', never refuse (PATCH ov keeps its M-1 refusal).
    const ov = {
      id: order.patientId, name: order.name, sex: order.sex, birth: order.birth,
      age: overlayShape({ age: patient?.age }) ? patient.age : '', desc: order.descr, ward: order.ward,
    };
    const orig = parse(prev?.orig) ?? patient?.orig ?? null;

    let state;
    try {
      state = await this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
        /**
         * 먼저 읽은 `matched` 값은 두 요청이 함께 U를 봐버릴 수 있다. 조건부 갱신은
         * "아직 U일 때만 내가 M으로 바꾼다"를 DB 한 문장으로 만들고, 행 잠금 뒤의
         * 실제 상태에서 한 요청만 count=1을 받게 한다.
         */
        const claimedOrder = await tx.order.updateMany({
          where: { oid, institutionId: me, matched: 'U' },
          data: { matched: 'M', studyUid: uid },
        });
        if (claimedOrder.count !== 1)
          throw new BadRequestException('이미 매칭된 오더입니다. 목록을 새로고침한 뒤 다시 선택하세요.');

        const data = { matched: 'M', orderOid: oid, ov: dump(ov), orig: dump(orig), ward: order.ward };
        if (!prev) {
          return tx.studyState.create({
            data: { uid, institutionId: me, reqHosp: this.instName(me), ...data },
          });
        }

        // 검사 쪽도 같은 상태였을 때만 선점한다. 실패하면 위 오더 갱신도 함께 롤백된다.
        const claimedStudy = await tx.studyState.updateMany({
          where: { uid, institutionId: me, matched: 'U' }, data,
        });
        if (claimedStudy.count !== 1)
          throw new BadRequestException('이미 매칭된 검사입니다. 목록을 새로고침한 뒤 다시 선택하세요.');
        return tx.studyState.findUniqueOrThrow({ where: { uid } });
      });
    } catch (e: any) {
      /**
       * 서로 다른 오더를 같은 검사에 거는 경쟁은 각 오더 행이 달라 updateMany만으로
       * 직렬화되지 않는다. 양쪽 nullable unique가 마지막 관문이고, 그 충돌은 사용자가
       * 조치할 수 있는 말로 바꾼다. PostgreSQL은 NULL 중복을 허용하므로 미매칭은 막지 않는다.
       */
      if (e?.code === 'P2002')
        throw new BadRequestException(
          '이미 다른 오더 또는 검사와 매칭되었습니다. 목록을 새로고침한 뒤 다시 선택하세요.');
      throw e;
    }
    await this.audit(c.actor, 'match', uid, { oid, ov, by: me });
    const r = await this.prisma.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor, await this.myDraft(uid, c.actor));
  }

  /** Unmatch (8.1.2.1.2): 검사·오더 양쪽을 동시에 해제 */
  async unmatch(uid: string, c: Caller) {
    return this.scopeWrite(uid,c,async(tx,audit)=>{
    need(c.roles, 'technician', '매칭 해제');
    const me = inst(c);
    const prev = await this.gate(uid,c,tx);
    if (!prev || prev.matched !== 'M') throw new BadRequestException('매칭된 검사가 아닙니다');
    // Match와 같은 규칙을 해제에도 건다. 승인 뒤 환자·오더 연결을 바꾸면 진술의 근거가 사라진다.
    if (prev.rs !== 'W')
      throw new BadRequestException(`판독 전(RS: W)인 검사만 매칭을 풀 수 있습니다 (현재 RS: ${prev.rs})`);
    if (prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 매칭을 풀 수 없습니다 (보유 기관의 일입니다)');

    const ops: any[] = [
      tx.studyState.update({
        where: { uid }, data: { matched: 'U', orderOid: null, ov: null },
      }),
    ];
    if (prev.orderOid)
      ops.push(tx.order.update({
        where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null },
      }));

    const [state] = await Promise.all(ops);
    await audit(c.actor, 'unmatch', uid, { oid: prev.orderOid, by: me });
    const r = await tx.report.findUnique({ where: { uid } });
    return toClient(state, r, c.actor, await this.myDraft(uid,c.actor,tx));
    });
  }

  /** 검사 상태 행 삭제 (장비 수신 시뮬로 만든 가짜 검사 정리용) */
  async removeState(uid: string, c: Caller) {
    need(c.roles, 'technician', '검사 삭제');
    const me = inst(c);
    await this.gate(uid, c);
    await this.studyAccess.prepare(c,[uid]);
    return this.prisma.$transaction(async tx => {
      await this.studyAccess.require(c,[uid],tx);
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    const parents = await tx.$queryRaw<any[]>`SELECT * FROM "StudyState" WHERE uid = ${uid} FOR UPDATE`;
    const prev = parents[0];
    if (!prev) throw new NotFoundException('검사가 없습니다');
    if (!this.visible(prev, me)) throw new ForbiddenException('검사에 접근할 수 없습니다');
    if (prev && prev.institutionId !== me)
      throw new ForbiddenException('원격판독으로 받은 검사는 삭제할 수 없습니다');

    // Creation takes this same parent lock. Hidden items still own immutable
    // history; deleting their parent would remove the authorization boundary.
    if (await tx.viewerItem.findFirst({ where: { studyUid: uid }, select: { id: true } }))
      throw new ConflictException('표시 이력이 있는 검사는 삭제할 수 없습니다');
    if (await tx.techNoteRevision.findFirst({ where: { studyUid: uid }, select: { version: true } }))
      throw new ConflictException('Tech 메모 이력이 있는 검사는 삭제할 수 없습니다');
    if (await tx.viewerJob.findFirst({ where: { studies: { has: uid } }, select: { id: true } }))
      throw new ConflictException('저장한 비교 작업에서 참조하는 검사는 삭제할 수 없습니다');
    // S5-U4a: 질문 스레드와 그 영수증은 검사에 묶인 기록이라 함께 지우지 않는다(FK Restrict). 처리되지 않은 FK 오류
    // 대신 명시 409로 거절한다. 질문 생성도 이 부모 잠금을 잡으므로 삭제와 생성이 엇갈리지 않는다.
    if (await tx.studyQuestion.findFirst({ where: { studyUid: uid }, select: { id: true } }))
      throw new ConflictException({ code: 'STUDY_HAS_QUESTIONS', message: '임상의 질문이 있는 검사는 삭제할 수 없습니다' });

    /**
     * 삭제 가능 여부는 지금의 RS가 아니라 **사람의 기록이 생긴 적이 있는가**로 정한다.
     * 승인 뒤 Reset하면 RS는 다시 W지만, ReportVersion은 있었던 결정을 보존한다.
     * 그 상태 행을 지우면 현재 판독문은 cascade로 사라지고 이력은 조회 관문을 잃는다.
     * 초안도 아직 진술은 아니지만 누군가 쓰는 중인 글이므로 삭제로 가로채지 않는다.
     */
    const [version, draft] = await Promise.all([
      /**
       * 강제 해제로 보존한 discarded 초안만 있는 검사는 이후 삭제할 수 있어야 한다.
       * 그것은 판독 결정이 아니라 삭제 직전의 안전 사본이다. save/approve/reset 같은
       * 실제 생애주기 이력이 하나라도 있으면 이전과 똑같이 삭제를 막는다.
       */
      tx.reportVersion.findFirst({
        where: { uid, action: { not: 'discarded' } }, select: { id: true },
      }),
      tx.reportDraft.findFirst({ where: { uid }, select: { author: true } }),
    ]);
    if (version)
      throw new BadRequestException(
        '판독 이력이 있는 검사는 삭제할 수 없습니다. 판독 취소(Reset)로 되돌리세요.');
    if (draft)
      throw new BadRequestException(
        `작성 중인 판독문 초안이 있는 검사는 삭제할 수 없습니다. ` +
        `작성자(${draft.author})에게 확정 또는 폐기를 요청하거나 관리자에게 강제 해제를 요청하세요.`);

    if (prev?.orderOid)
      await tx.order.update({ where: { oid: prev.orderOid }, data: { matched: 'U', studyUid: null } });
    await tx.studyState.delete({ where: { uid } });
    await tx.auditLog.create({ data: { actor: c.actor, action: 'state.delete', target: uid, detail: JSON.stringify({ by: me }) } });
    return { ok: true };
    }, { isolationLevel: 'ReadCommitted', maxWait: 4000, timeout: 8000 });
  }

  /**
   * 감사로그. 내 기관이 볼 수 있는 검사의 것만. OWNER_ONLY_AUDIT_ACTIONS 행은 생성 기관 = 현재 소유 기관 = 나일 때만.
   * 그 조건은 LIMIT이 있는 같은 SQL의 WHERE에 둔다 — 가져온 뒤 거르면 짧은 쪽이 숨긴 행의 수·시각을 드러내고
   * 보여야 할 오래된 행을 밀어낸다. CASE는 목록의 action에만 detail을 jsonb로 읽고, 검사 행이 없거나 기관이
   * null이면 NULL이 되어 행이 빠진다(닫힌 쪽). 같은 시각의 행은 id로 순서를 고정한다.
   */
  async audits(uid: string | undefined, take: number, c: Caller) {
    const me = inst(c);
    const limit = Math.min(take, 500);
    if (uid) {
      const prev = await this.gate(uid, c);
      // versions()와 같은 이유. 삭제된 검사의 감사(환자 정보가 든 ov 포함)와 회원 감사 행(target이
      // Keycloak 사용자 id)이 이 통로로 새어 나갔다. 회원 감사 조회가 필요해지면 admin 전용 경로로 만든다.
      if (!prev) throw new NotFoundException('검사를 찾을 수 없습니다');
      return this.prisma.$queryRaw`SELECT a.* FROM "AuditLog" a LEFT JOIN "StudyState" s ON s.uid = a.target
        WHERE a.target = ${uid}
          AND CASE WHEN a.action = ANY(${OWNER_ONLY_AUDIT_ACTIONS}::text[])
                   THEN s."institutionId" = ${me} AND (a.detail::jsonb ->> 'institution') = ${me}
                   ELSE TRUE END
        ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`;
    }
    const mine = await this.prisma.studyState.findMany({
      where: { OR: [{ institutionId: me }, { teleInstitutionId: me }] },
      select: { uid: true },
    });
    const allowed = [...await this.studyAccess.allowed(c,mine.map(s=>s.uid))];
    return this.prisma.$queryRaw`SELECT a.* FROM "AuditLog" a LEFT JOIN "StudyState" s ON s.uid = a.target
      WHERE a.target = ANY(${allowed}::text[])
        AND CASE WHEN a.action = ANY(${OWNER_ONLY_AUDIT_ACTIONS}::text[])
                 THEN s."institutionId" = ${me} AND (a.detail::jsonb ->> 'institution') = ${me}
                 ELSE TRUE END
      ORDER BY a.at DESC, a.id DESC LIMIT ${limit}`;
  }
}
