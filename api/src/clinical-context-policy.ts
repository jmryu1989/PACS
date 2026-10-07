/**
 * S7-U4a — Clinical Context(판독의 패널)의 순수 규칙. 계약 S7-U4p(Astra S7-U4p-D-R-001 ACCEPT), 결정 D-S7-11 (b).
 * REQ-S7-U4p-SOURCES/ORDER-EXCLUDED/PATIENT-KEY/PROVENANCE/ACCESS-BASIS/STATES/ROUTE
 *   -> RISK-S7-U4a-TENANT/CROSS-PATIENT/NONFINAL, RISK-S7-U4p-UNSOURCED/KEY-WIDENING/ABSENT-OVERCLAIM/MEMBER-CHANGE
 *   -> TEST-S7-U4a-SERVICE/LIVE/POLICY.
 *
 * 이 파일은 순수 함수만 둔다(DB·Orthanc·Nest 예외 없음). 읽는 순서·트랜잭션·재검증은 clinical-context.service.ts가 정한다.
 * 오더 값은 어디에도 없다: 입력에 Order 행도, Match가 StudyState에 복사한 칸(ov·orig·ward·orderOid·matched)도 없고,
 * 응답 모양은 닫혀 있어(§9.1) 그런 칸이 끼면 그 구역이 source_invalid가 된다. 시드 오더가 권위 있는 오더로 보이는 길
 * (RISK-S7-U4p-SEED-AS-AUTHORITY / ORDER-VIA-OVERLAY)을 입력과 출력 양쪽에서 막는 이유다.
 */
import { clinicianFinal, clinicianIdentityRelation, clinicianTimelineMembers } from './clinician-policy';
import type { ClinicianIdentityKeys, ClinicianIdentityRelation } from './clinician-policy';
import { birthKey, sexKey } from './study-identity';

export const CLINICAL_CONTEXT_SCHEMA = 'kin.clinical-context/1';

/** 판독 화면 패널이다(CS-03). 명시 집합이고 need()가 아니다 — need()는 admin을 역할마다 통과시키는 다른 규칙이다(D33 OQ-3). */
export const CLINICAL_CONTEXT_ROLES: readonly string[] = Object.freeze(['radiologist', 'admin']);

export const CLINICAL_CONTEXT_INPUT_INVALID = 'CLINICAL_CONTEXT_INPUT_INVALID';
export const CLINICAL_CONTEXT_ROLE = 'CLINICAL_CONTEXT_ROLE';
export const CLINICAL_CONTEXT_CHANGED = 'CLINICAL_CONTEXT_CHANGED';
export const CLINICAL_CONTEXT_BUSY = 'CLINICAL_CONTEXT_BUSY';

/** 응답 크기 상한일 뿐 임상 기준이 아니다(CS-07). 넘치면 잘리고 `truncated`가 그렇다고 말한다. */
export const CONTEXT_PRIOR_LIMIT = 10;
export const CONTEXT_HISTORY_LIMIT = 200;

/** 파생 객체의 헤더를 읽고 요청 태그가 "없다"고 말하지 않기 위해 원본 영상 시리즈만 고른다(CS-06). */
export const CONTEXT_DERIVED_MODALITIES: readonly string[] = Object.freeze(['SR', 'KO', 'PR', 'SEG']);

/** 확인하는 요청 태그(CS-05). 헤더 최상위 요소만 읽고, 이 순서가 `checked`의 순서다. */
export const CONTEXT_REQUEST_TAGS: readonly { tag: string; keyword: string; vr: 'LO' | 'LT' }[] = Object.freeze([
  { tag: '00321030', keyword: 'ReasonForStudy', vr: 'LO' },
  { tag: '00401002', keyword: 'ReasonForTheRequestedProcedure', vr: 'LO' },
  { tag: '001021B0', keyword: 'AdditionalPatientHistory', vr: 'LT' },
  { tag: '00081080', keyword: 'AdmittingDiagnosesDescription', vr: 'LO' },
  { tag: '00324000', keyword: 'StudyComments', vr: 'LT' },
]);
export const CONTEXT_REQUEST_TAG_CODES: readonly string[] = Object.freeze(CONTEXT_REQUEST_TAGS.map(t => t.tag));
/** LT의 최대 길이. 넘는 값은 자르지 않고 `too_long`으로만 알린다 — 잘린 값이 원문처럼 보이지 않게. */
export const CONTEXT_REQUEST_TAG_MAX_CHARS = 10240;

export type ContextSectionName = 'priorReports' | 'history' | 'requestTags' | 'techNote';
export type ContextSectionState = 'present' | 'absent' | 'not_configured' | 'failed';
export type ContextAccess = 'owner' | 'tele';

export const CONTEXT_SECTION_NAMES: readonly ContextSectionName[] = Object.freeze(['priorReports', 'history', 'requestTags', 'techNote']);

/** 구역마다 고정 영어 출처 이름(§5.1). */
export const CONTEXT_SOURCE_LABELS: Readonly<Record<ContextSectionName, string>> = Object.freeze({
  priorReports: 'KIN signed report (head version)',
  history: 'DICOM study + KIN study state',
  requestTags: 'DICOM header (one original instance)',
  techNote: 'KIN Tech Note',
});

/** 구역마다 provenance kind(§5.1). */
export const CONTEXT_PROVENANCE_KINDS: Readonly<Record<ContextSectionName, string>> = Object.freeze({
  priorReports: 'kin.report-version',
  history: 'dicom.study+kin.study-state',
  requestTags: 'dicom.instance-header',
  techNote: 'kin.tech-note',
});

/**
 * 사유 코드 닫힌 목록(§7.1). present·absent의 사유는 null 하나다. techNote는 R6(DB)에서만 읽으므로 조회하지 않는 경우가 없고,
 * DB가 답하지 못하면 답 전체가 503이라 구역 실패는 모양 위반(source_invalid)뿐이다.
 */
const SOURCE_FAILURES = ['source_unavailable', 'source_invalid', 'source_row_missing'];
export const CONTEXT_REASONS: Readonly<Record<ContextSectionName, { not_configured: readonly string[]; failed: readonly string[] }>> = Object.freeze({
  priorReports: { not_configured: ['no_patient_key'], failed: SOURCE_FAILURES },
  history: { not_configured: ['no_patient_key'], failed: SOURCE_FAILURES },
  requestTags: { not_configured: ['no_original_instance'], failed: SOURCE_FAILURES },
  techNote: { not_configured: [], failed: ['source_invalid'] },
});

/**
 * 응답의 닫힌 키(§9.1). 모양 확인은 객체마다 이 목록과 **정확히** 같은 키를 요구한다. 전체 합집합이 계약
 * uxr-trace.json response_keys와 같은지는 TEST-S7-U4a-SERVICE CC-S13이 대조한다.
 */
const SECTION_KEYS = ['state', 'reason', 'sourceLabel', 'observedAt', 'truncated', 'items'];
export const CLINICAL_CONTEXT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  answer: ['schema', 'uid', 'observedAt', 'patientKey', 'anchor', 'identity', 'sections'],
  anchor: ['access', 'institutionName', 'techNoteVersion'],
  identity: ['conflict', 'birth', 'sex'],
  sections: [...CONTEXT_SECTION_NAMES],
  section: SECTION_KEYS,
  requestTagsSection: [...SECTION_KEYS, 'checked'],
  provenance: ['kind', 'recordId', 'version', 'author', 'recordedAt', 'observedAt'],
  priorItem: ['studyUid', 'access', 'study', 'identity', 'report', 'provenance'],
  priorStudy: ['date', 'modalities', 'description'],
  report: ['version', 'action', 'findings', 'conclusion', 'recommendation'],
  historyItem: ['studyUid', 'access', 'institutionName', 'study', 'reading', 'identity', 'provenance'],
  historyStudy: ['date', 'modalities', 'description', 'accession'],
  reading: ['rs', 'signed', 'reportVersion'],
  rowIdentity: ['birth', 'sex'],
  requestTagItem: ['tag', 'keyword', 'vr', 'value', 'note', 'provenance'],
  techNoteItem: ['version', 'hasText', 'provenance'],
});

const RELATIONS = ['match', 'mismatch', 'not_comparable'];
const ORTHANC_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DICOM_UID = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/;

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, any>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** KIN 서버 시각(ISO 8601 UTC). 읽을 수 없는 값은 null이고, null이 허용되지 않는 칸이면 그 항목이 모양 확인에서 걸린다. */
export function contextInstant(value: unknown): string | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// ── R2 호출자 ──

/**
 * R-CTX-ANCHOR (1)(2)(4). null이면 통과. clinician-only는 guard와 controller 두 번째 줄이 CLINICIAN_ROUTE_DENIED로 먼저
 * 거절한다(§9.2). 여기까지 왔다면 radiologist·admin이 없어 'role'이 된다 — 역할 없는 호출이 어느 쪽으로도 통과하지 않는다.
 * 혼합 역할(clinician + radiologist)은 radiologist가 있으므로 통과한다(F-20).
 */
export function clinicalContextCallerRefusal(c: any): 'member' | 'institution' | 'role' | null {
  if (!record(c) || c.kind !== 'member' || !text(c.sub) || !text(c.actor)) return 'member';
  if (!text(c.institution)) return 'institution';
  const roles = Array.isArray(c.roles) ? c.roles : [];
  return CLINICAL_CONTEXT_ROLES.some(role => roles.includes(role)) ? null : 'role';
}

// ── 권한 근거와 환자 키 ──

/**
 * §5.6 권한 근거. 'owner'는 StudyState.institutionId가 호출자 기관일 때, 'tele'는 teleInstitutionId가 호출자 기관일 때다.
 * 둘은 PacsService.visible()의 두 가지이고(기관 경계를 넘는 유일한 통로가 tele다), 둘 다 아니면 null = 보이지 않음이다.
 * admin도 예외가 없다(AGENTS 1 · 4).
 */
export function contextAccess(state: any, institution: string): ContextAccess | null {
  if (!record(state) || !text(institution)) return null;
  if (state.institutionId === institution) return 'owner';
  return state.teleInstitutionId === institution ? 'tele' : null;
}

/**
 * K-1 서버 환자 키 = 소유 기관 | 원본 DICOM PatientID. 워크리스트 행의 sourcePatientKey와 같은 식이다(pacs.service.ts listStudies).
 * trim·대소문자·IssuerOfPatientID 결합을 하지 않는다(CS-02) — 다른 사람이 합쳐지는 쪽이 갈라지는 쪽보다 위험하다.
 */
export function contextPatientKey(institutionId: unknown, patientId: unknown): string | null {
  return institutionId == null || typeof patientId !== 'string' || !patientId ? null : `${institutionId}|${patientId}`;
}

/** R5에서 읽은 원본 DICOM 검사 한 행(QIDO). `row`는 StudyAccess 원본 태그 규칙 판정에만 쓰고 응답에 싣지 않는다. */
export interface ContextSourceStudy {
  uid: string; patientId: string; birth: string; sex: string;
  date: string; modalities: string; description: string; accession: string; row?: any;
}

export type ContextStudySources =
  | { kind: 'read'; anchor: ContextSourceStudy; candidates: ContextSourceStudy[] }
  | { kind: 'missing' } | { kind: 'invalid' };

/**
 * R5 (a)(b): 원본 열거에서 기준 행과, 원본 PatientID가 기준과 **정확히 같은** 다른 행(후보)을 가른다. PatientID로 거르는
 * 질의는 쓰지 않으므로(K-3) `*`·`?`·`\`·`,`가 든 값도 거르기 키가 되지 않는다. UID가 없는 행은 워크리스트처럼 건너뛰고,
 * 같은 UID가 두 번 나오면 열거를 믿을 수 없어 invalid다. PatientID가 비면 후보는 없다(K-5, 호출측이 not_configured로 둔다).
 */
export function contextStudySources(studies: ContextSourceStudy[], uid: string): ContextStudySources {
  if (!Array.isArray(studies)) return { kind: 'invalid' };
  const seen = new Set<string>();
  let anchor: ContextSourceStudy | null = null;
  for (const study of studies) {
    if (!record(study) || typeof study.uid !== 'string') return { kind: 'invalid' };
    if (!study.uid) continue;
    if (seen.has(study.uid)) return { kind: 'invalid' };
    seen.add(study.uid);
    if (study.uid === uid) anchor = study;
  }
  if (!anchor) return { kind: 'missing' };
  const candidates = anchor.patientId
    ? studies.filter(study => study.uid && study.uid !== uid && study.patientId === anchor.patientId) : [];
  return { kind: 'read', anchor, candidates };
}

/**
 * K-2: 기준과 서버 환자 키가 같은 후보(기준 제외). 키는 R6의 StudyState.institutionId와 R5의 원본 PatientID로 만들고,
 * 묶음은 S5-U3의 clinicianTimelineMembers가 정한다(CS-10 — 같은 판정을 두 곳에 두지 않는다). 이름·생년월일·덮어쓰기는
 * 입력이 아니다. 가시성·StudyAccess는 여기서 보지 않는다: 호출측이 R6에서 지금 거른다.
 */
export function contextSameKey<T extends { uid: string; sourcePatientKey: string | null }>(uid: string, patientKey: string | null, keyed: T[]): T[] {
  const anchor = { uid, sourcePatientKey: patientKey };
  return clinicianTimelineMembers(anchor, [anchor, ...(Array.isArray(keyed) ? keyed : [])])
    .filter((row: any) => row !== anchor && row.uid !== uid) as T[];
}

// ── D8 관계 ──

/** 원본 생년월일·성별을 S4-U5 비교 규칙(birthKey·sexKey)으로 바꾼 값. S5-U3 타임라인과 같은 입력이다. */
export function contextIdentityKeys(study: any): ClinicianIdentityKeys {
  return { birth: birthKey(study?.birth), sex: sexKey(study?.sex) };
}

/** K-6 전체 관계: 보이는 구성원 전체(기준 포함, 잘린 행 포함). 값은 싣지 않는다. */
export function contextIdentity(keys: ClinicianIdentityKeys[]): { conflict: boolean; birth: ClinicianIdentityRelation; sex: ClinicianIdentityRelation } {
  const list = Array.isArray(keys) ? keys : [];
  const birth = clinicianIdentityRelation(list.map(k => k.birth));
  const sex = clinicianIdentityRelation(list.map(k => k.sex));
  return { conflict: birth === 'mismatch' || sex === 'mismatch', birth, sex };
}

/** K-6 행 관계: 기준 검사와 그 행 둘의 관계. */
export function contextRowIdentity(anchor: ClinicianIdentityKeys, row: ClinicianIdentityKeys) {
  return { birth: clinicianIdentityRelation([anchor.birth, row.birth]), sex: clinicianIdentityRelation([anchor.sex, row.sex]) };
}

// ── 순서 ──

/**
 * §5.2·§5.3 순서: 원본 StudyDate 내림차순, 형식이 맞지 않는 날짜는 뒤, 같으면 UID 오름차순(문자열 순서).
 * 날짜의 형식 판정은 D8 비교와 같은 달력 규칙(study-identity.ts birthKey: 실제 그레고리력 YYYYMMDD)이다.
 */
export function contextOrder(a: { uid: string; date: string }, b: { uid: string; date: string }): number {
  const left = birthKey(a.date), right = birthKey(b.date);
  if (left && right && left !== right) return left < right ? 1 : -1;
  if (!left !== !right) return left ? -1 : 1;
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

// ── 항목 ──

/** R6에서 읽고 R7(a)가 확인한 한 구성원. `head`는 ReportVersion(uid, Report.version) 행의 메타(본문 없음) 또는 null이다. */
export interface ContextMember {
  source: ContextSourceStudy;
  state: { uid: string; institutionId: string | null; teleInstitutionId: string | null; rs: string;
    preDoc: string | null; preReviewer: string | null; preDocSub?: string | null; preReviewerSub?: string | null; createdAt: any };
  access: ContextAccess;
  reportVersion: number;
  head: { id: number; uid: string; version: number; action: string; author: string; at: any } | null;
}

/** §5.2: 서명 확정(clinicianFinal = RS A이고 머리 판 action이 approve/addendum)인 구성원만 과거 판독문 후보다. */
export function contextSigned(member: ContextMember): boolean {
  return clinicianFinal(member?.state?.rs, member?.head);
}

/** §5.3 이력 한 행. 덮어쓰기·오더 유래·작성자 쪽 칸은 입력에도 없다. */
export function contextHistoryItem(member: ContextMember, institutionName: string, anchorKeys: ClinicianIdentityKeys, observedAt: string) {
  const source = member.source;
  return {
    studyUid: source.uid, access: member.access, institutionName,
    study: { date: source.date, modalities: source.modalities, description: source.description, accession: source.accession },
    reading: { rs: member.state.rs, signed: contextSigned(member), reportVersion: member.reportVersion },
    identity: contextRowIdentity(anchorKeys, contextIdentityKeys(source)),
    provenance: { kind: CONTEXT_PROVENANCE_KINDS.history, recordId: source.uid, version: null, author: null,
      recordedAt: contextInstant(member.state.createdAt), observedAt },
  };
}

/**
 * §5.2 과거 판독문 한 건. 본문은 **머리 판 행 자신**의 세 칸이다(F-22) — `Report` 표의 본문이 아니다. action·작성자·시각·본문이
 * 한 불변 행에서 온다. 본문 행을 찾지 못하면 칸이 null이 되어 모양 확인이 이 구역을 source_invalid로 만든다.
 */
export function contextPriorItem(member: ContextMember, body: any, anchorKeys: ClinicianIdentityKeys, observedAt: string) {
  const source = member.source, head = member.head;
  const field = (key: string) => record(body) && typeof body[key] === 'string' ? body[key] as string : null;
  return {
    studyUid: source.uid, access: member.access,
    study: { date: source.date, modalities: source.modalities, description: source.description },
    identity: contextRowIdentity(anchorKeys, contextIdentityKeys(source)),
    report: { version: head?.version ?? null, action: head?.action ?? null,
      findings: field('findings'), conclusion: field('conclusion'), recommendation: field('recommendation') },
    provenance: { kind: CONTEXT_PROVENANCE_KINDS.priorReports,
      recordId: Number.isSafeInteger(head?.id) ? String(head.id) : null, version: head?.version ?? null,
      author: typeof head?.author === 'string' ? head.author : null, recordedAt: contextInstant(head?.at), observedAt },
  };
}

/** §5.5 Tech Note 메타. 본문·사유·authorSub·기관은 싣지 않는다. 내용을 비운 판도 기록된 사실이라 present다. */
export function contextTechNoteItem(uid: string, note: any, observedAt: string) {
  return {
    version: note?.version ?? null, hasText: typeof note?.text === 'string' ? note.text !== '' : null,
    provenance: { kind: CONTEXT_PROVENANCE_KINDS.techNote, recordId: `${uid}#${note?.version}`, version: note?.version ?? null,
      author: typeof note?.author === 'string' ? note.author : null, recordedAt: contextInstant(note?.createdAt), observedAt },
  };
}

// ── CTX-TAGS (§5.4) ──

/** Orthanc /tools/lookup 답에서 기준 검사의 Orthanc id. 없으면 missing(source_row_missing), 모양이 틀리면 invalid. */
export function contextOrthancStudy(found: unknown): { kind: 'found'; id: string } | { kind: 'missing' } | { kind: 'invalid' } {
  if (!Array.isArray(found)) return { kind: 'invalid' };
  const studies = found.filter(item => record(item) && item.Type === 'Study');
  if (!studies.length) return { kind: 'missing' };
  if (studies.length !== 1 || typeof studies[0].ID !== 'string' || !ORTHANC_ID.test(studies[0].ID)) return { kind: 'invalid' };
  return { kind: 'found', id: studies[0].ID };
}

/**
 * 원본 영상 시리즈 고르기: Modality가 SR·KO·PR·SEG가 아닌 시리즈 중 SeriesInstanceUID가 가장 작은 것(문자열 순서).
 * 후보가 없으면 none — 읽을 헤더가 없었다는 뜻이고 요청 태그가 없다는 뜻이 아니다(not_configured, RISK-S7-U4p-ABSENT-OVERCLAIM).
 */
export function contextOriginalSeries(series: unknown): { kind: 'series'; id: string; uid: string } | { kind: 'none' } | { kind: 'invalid' } {
  if (!Array.isArray(series)) return { kind: 'invalid' };
  const seen = new Set<string>();
  let chosen: { id: string; uid: string } | null = null;
  for (const item of series) {
    if (!record(item) || typeof item.ID !== 'string' || !ORTHANC_ID.test(item.ID) || !record(item.MainDicomTags)) return { kind: 'invalid' };
    const uid = item.MainDicomTags.SeriesInstanceUID, modality = item.MainDicomTags.Modality;
    if (!text(uid) || seen.has(uid) || (modality != null && typeof modality !== 'string')) return { kind: 'invalid' };
    seen.add(uid);
    if (CONTEXT_DERIVED_MODALITIES.includes(String(modality ?? '').trim().toUpperCase())) continue;
    if (!chosen || uid < chosen.uid) chosen = { id: item.ID, uid };
  }
  return chosen ? { kind: 'series', ...chosen } : { kind: 'none' };
}

/** 고른 시리즈 안에서 SOPInstanceUID가 가장 작은 인스턴스(문자열 순서). 모양이 틀리거나 비었으면 null(source_invalid). */
export function contextFirstInstance(instances: unknown): { id: string; sop: string } | null {
  if (!Array.isArray(instances) || !instances.length) return null;
  const seen = new Set<string>();
  let first: { id: string; sop: string } | null = null;
  for (const item of instances) {
    if (!record(item) || typeof item.ID !== 'string' || !ORTHANC_ID.test(item.ID) || !record(item.MainDicomTags)) return null;
    const sop = item.MainDicomTags.SOPInstanceUID;
    if (!text(sop) || seen.has(sop)) return null;
    seen.add(sop);
    if (!first || sop < first.sop) first = { id: item.ID, sop };
  }
  return first;
}

/** Orthanc /instances/{id}/tags의 키 형식("0010,21b0"). */
export function contextHeaderKey(tag: string): string {
  return (tag.slice(0, 4) + ',' + tag.slice(4)).toLowerCase();
}

/**
 * 헤더 한 개에서 다섯 태그를 원문 그대로 꺼낸다. Orthanc가 SpecificCharacterSet으로 풀어 준 문자열을 trim·대소문자·번역·
 * 파싱 없이 싣고 다중 값의 `\`도 그대로 둔다. 문자열이 아닌 값(시퀀스·null·바이너리)은 not_text, LT 최대를 넘으면 too_long이다.
 * 헤더가 고른 인스턴스의 것이 아니거나, Orthanc가 값을 TooLong으로 가렸거나(ignore-length가 적용되지 않음), 모르는 형식이면
 * 값을 확인하지 못한 것이므로 구역 전체를 source_invalid로 둔다 — 확인하지 못한 값을 "없음"이나 잘린 값으로 보이지 않는다.
 */
export function contextRequestTags(header: unknown, sop: string, observedAt: string):
  { state: 'present' | 'absent'; items: any[] } | { state: 'failed'; reason: 'source_invalid' } {
  const invalid = { state: 'failed' as const, reason: 'source_invalid' as const };
  if (!record(header)) return invalid;
  const identity = header[contextHeaderKey('00080018')];
  if (!record(identity) || identity.Type !== 'String' || identity.Value !== sop) return invalid;
  const items: any[] = [];
  for (const tag of CONTEXT_REQUEST_TAGS) {
    const key = contextHeaderKey(tag.tag);
    if (!own(header, key)) continue;
    const entry = header[key];
    if (!record(entry)) return invalid;
    let value: string | null = null, note: 'not_text' | 'too_long' | null = null;
    if (entry.Type === 'String' && typeof entry.Value === 'string') {
      if ([...entry.Value].length > CONTEXT_REQUEST_TAG_MAX_CHARS) note = 'too_long'; else value = entry.Value;
    } else if (entry.Type === 'Sequence' || entry.Type === 'Null' || entry.Type === 'Binary') note = 'not_text';
    else return invalid;
    items.push({ tag: tag.tag, keyword: tag.keyword, vr: tag.vr, value, note,
      provenance: { kind: CONTEXT_PROVENANCE_KINDS.requestTags, recordId: sop, version: null, author: null, recordedAt: null, observedAt } });
  }
  return { state: items.length ? 'present' : 'absent', items };
}

// ── 구역 ──

/**
 * 구역 하나. `checked`는 requestTags에만 있고 헤더를 실제로 읽었을 때(present·absent)만 다섯 태그다(§5.4).
 * `truncated`는 present일 때만 참일 수 있다. `observedAt`이 null인 경우는 no_patient_key 하나다(읽지 않았다).
 */
export function contextSection(name: ContextSectionName, state: ContextSectionState, reason: string | null,
  observedAt: string | null, items: any[] = [], truncated = false) {
  const section = { state, reason, sourceLabel: CONTEXT_SOURCE_LABELS[name], observedAt,
    truncated: state === 'present' && truncated, items: state === 'present' ? items : [] };
  return name === 'requestTags'
    ? { ...section, checked: state === 'present' || state === 'absent' ? [...CONTEXT_REQUEST_TAG_CODES] : [] } : section;
}

/** 출처를 읽은 구역: 항목이 있으면 present, 0개면 absent(읽고 없음). */
export function contextReadSection(name: ContextSectionName, items: any[], observedAt: string, truncated = false) {
  return contextSection(name, items.length ? 'present' : 'absent', null, observedAt, items, truncated);
}

// ── R7(a) 고정값 ──

/** §6.2 고정값. 기준은 기관·tele·Tech Note 판, 기여 구성원은 기관·tele·RS·P 짝·머리 판 번호다(행 수 = V-ROW). */
export interface ContextPins {
  anchor: { uid: string; institutionId: string | null; teleInstitutionId: string | null; techNoteVersion: number };
  members: { uid: string; institutionId: string | null; teleInstitutionId: string | null; rs: string;
    preDoc: string | null; preReviewer: string | null; preDocSub?: string | null; preReviewerSub?: string | null; reportVersion: number }[];
}

export function contextPins(anchor: any, techNoteVersion: number, members: ContextMember[]): ContextPins {
  return {
    anchor: { uid: anchor.uid, institutionId: anchor.institutionId ?? null, teleInstitutionId: anchor.teleInstitutionId ?? null, techNoteVersion },
    members: members.map(m => ({ uid: m.state.uid, institutionId: m.state.institutionId ?? null,
      teleInstitutionId: m.state.teleInstitutionId ?? null, rs: m.state.rs, preDoc: m.state.preDoc ?? null,
      preReviewer: m.state.preReviewer ?? null, preDocSub: m.state.preDocSub ?? null,
      preReviewerSub: m.state.preReviewerSub ?? null, reportVersion: m.reportVersion })),
  };
}

/** R7(a)이 다시 읽을 검사: 기준과 기여 구성원 전부. */
export function contextPinnedUids(pins: ContextPins): string[] {
  return [pins.anchor.uid, ...pins.members.map(m => m.uid)];
}

/**
 * R7(a) 비교. 한 SQL 문장(트랜잭션 밖)의 행과 R6 고정값이 하나라도 다르면 true(409 CLINICAL_CONTEXT_CHANGED).
 * 행이 빠지면(검사 삭제, V-ROW) 다르다. 기준의 rs·P 짝·머리 판은 비교하지 않는다 — 답의 어떤 칸도 그 값에서 오지 않고,
 * 판독 중인 기준 검사의 저장·확정이 Context 읽기를 막지 않게 하기 위해서다(§6.2).
 * StudyAccess revision은 검사별 변경으로 오르지 않으므로(F-54) 이 비교를 대신하지 못한다.
 */
export function contextPinsChanged(pins: ContextPins, rows: unknown): boolean {
  if (!Array.isArray(rows)) return true;
  const expected = contextPinnedUids(pins);
  const byUid = new Map<string, any>();
  for (const row of rows) {
    if (!record(row) || typeof row.uid !== 'string' || byUid.has(row.uid)) return true;
    byUid.set(row.uid, row);
  }
  if (byUid.size !== expected.length || expected.some(uid => !byUid.has(uid))) return true;
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const number = (value: unknown) => typeof value === 'bigint' ? Number(value) : value;
  const anchor = byUid.get(pins.anchor.uid);
  if (!same(anchor.institutionId, pins.anchor.institutionId) || !same(anchor.teleInstitutionId, pins.anchor.teleInstitutionId)
      || number(anchor.techNoteVersion) !== pins.anchor.techNoteVersion) return true;
  return pins.members.some(pin => {
    const row = byUid.get(pin.uid);
    return !same(row.institutionId, pin.institutionId) || !same(row.teleInstitutionId, pin.teleInstitutionId)
      || !same(row.rs, pin.rs) || !same(row.preDoc, pin.preDoc) || !same(row.preReviewer, pin.preReviewer)
      || !same(row.preDocSub, pin.preDocSub) || !same(row.preReviewerSub, pin.preReviewerSub)
      || number(row.reportVersion) !== pin.reportVersion;
  });
}

// ── 모양 확인 (§9.1, CC-S13) ──

class ShapeViolation extends Error {}
function check(condition: boolean, path: string, what: string): void {
  if (!condition) throw new ShapeViolation(path + ': ' + what);
}
function keysExactly(value: unknown, keys: readonly string[], path: string): Record<string, any> {
  check(record(value), path, 'not an object');
  const actual = Object.keys(value as object).sort(), expected = [...keys].sort();
  check(actual.length === expected.length && actual.every((key, i) => key === expected[i]), path, 'keys differ from the closed shape');
  return value as Record<string, any>;
}
const instant = (value: unknown) => typeof value === 'string' && ISO_INSTANT.test(value) && contextInstant(value) === value;
const count = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min;
const relation = (value: unknown) => typeof value === 'string' && RELATIONS.includes(value);
const studyUid = (value: unknown) => typeof value === 'string' && value.length <= 64 && DICOM_UID.test(value);

function provenance(value: unknown, path: string, kind: string) {
  const p = keysExactly(value, CLINICAL_CONTEXT_KEYS.provenance, path);
  check(p.kind === kind, path + '.kind', 'not the kind of this section');
  check(text(p.recordId), path + '.recordId', 'missing');
  check(instant(p.observedAt), path + '.observedAt', 'not an ISO instant');
  if (kind === CONTEXT_PROVENANCE_KINDS.priorReports || kind === CONTEXT_PROVENANCE_KINDS.techNote) {
    check(count(p.version, 1), path + '.version', 'missing');
    check(text(p.author), path + '.author', 'missing');
    check(instant(p.recordedAt), path + '.recordedAt', 'missing');
  } else if (kind === CONTEXT_PROVENANCE_KINDS.history) {
    check(p.version === null && p.author === null, path, 'a study row has no version or author');
    check(instant(p.recordedAt), path + '.recordedAt', 'missing');
  } else {
    // a DICOM header records no author and no time of recording; StudyDate is not a recording time (§5.1)
    check(p.version === null && p.author === null && p.recordedAt === null, path, 'a header has no version, author or recording time');
  }
  return p;
}

function rowIdentity(value: unknown, path: string) {
  const identity = keysExactly(value, CLINICAL_CONTEXT_KEYS.rowIdentity, path);
  check(relation(identity.birth) && relation(identity.sex), path, 'not a relation');
}

function studyLabel(value: unknown, path: string, keys: readonly string[]) {
  const study = keysExactly(value, keys, path);
  check(keys.every(key => typeof study[key] === 'string'), path, 'original DICOM values are strings');
}

function sectionItems(name: ContextSectionName, section: Record<string, any>, context: { uid: string; anchor: any }) {
  const path = 'sections.' + name;
  const kind = CONTEXT_PROVENANCE_KINDS[name];
  const uids = new Set<string>();
  section.items.forEach((value: unknown, i: number) => {
    const at = `${path}.items[${i}]`;
    if (name === 'priorReports') {
      const item = keysExactly(value, CLINICAL_CONTEXT_KEYS.priorItem, at);
      check(studyUid(item.studyUid) && item.studyUid !== context.uid && !uids.has(item.studyUid), at + '.studyUid', 'not a distinct other study');
      uids.add(item.studyUid);
      check(item.access === context.anchor.access, at + '.access', 'differs from anchor.access');
      studyLabel(item.study, at + '.study', CLINICAL_CONTEXT_KEYS.priorStudy);
      rowIdentity(item.identity, at + '.identity');
      const report = keysExactly(item.report, CLINICAL_CONTEXT_KEYS.report, at + '.report');
      check(count(report.version, 1) && ['approve', 'addendum'].includes(report.action), at + '.report', 'not a signed head');
      check(['findings', 'conclusion', 'recommendation'].every(key => typeof report[key] === 'string'), at + '.report', 'body is not text');
      const p = provenance(item.provenance, at + '.provenance', kind);
      check(/^\d+$/.test(p.recordId) && p.version === report.version, at + '.provenance', 'not the head row');
    } else if (name === 'history') {
      const item = keysExactly(value, CLINICAL_CONTEXT_KEYS.historyItem, at);
      check(studyUid(item.studyUid) && item.studyUid !== context.uid && !uids.has(item.studyUid), at + '.studyUid', 'not a distinct other study');
      uids.add(item.studyUid);
      check(item.access === context.anchor.access, at + '.access', 'differs from anchor.access');
      check(item.institutionName === context.anchor.institutionName, at + '.institutionName', 'differs from anchor.institutionName');
      studyLabel(item.study, at + '.study', CLINICAL_CONTEXT_KEYS.historyStudy);
      const reading = keysExactly(item.reading, CLINICAL_CONTEXT_KEYS.reading, at + '.reading');
      check(text(reading.rs) && typeof reading.signed === 'boolean' && count(reading.reportVersion, 0), at + '.reading', 'invalid');
      check(!reading.signed || reading.rs === 'A' && reading.reportVersion > 0, at + '.reading', 'signed needs RS A and a head');
      rowIdentity(item.identity, at + '.identity');
      const p = provenance(item.provenance, at + '.provenance', kind);
      check(p.recordId === item.studyUid, at + '.provenance.recordId', 'not the study');
    } else if (name === 'requestTags') {
      const item = keysExactly(value, CLINICAL_CONTEXT_KEYS.requestTagItem, at);
      const tag = CONTEXT_REQUEST_TAGS.find(t => t.tag === item.tag);
      check(!!tag && item.keyword === tag.keyword && item.vr === tag.vr && !uids.has(item.tag), at + '.tag', 'not one of the five tags');
      check(i === 0 || CONTEXT_REQUEST_TAG_CODES.indexOf(item.tag) > CONTEXT_REQUEST_TAG_CODES.indexOf(section.items[i - 1].tag), at + '.tag', 'out of the fixed order');
      uids.add(item.tag);
      check(typeof item.value === 'string' ? item.note === null && [...item.value].length <= CONTEXT_REQUEST_TAG_MAX_CHARS
        : item.value === null && (item.note === 'not_text' || item.note === 'too_long'), at + '.value', 'value and note disagree');
      const p = provenance(item.provenance, at + '.provenance', kind);
      check(p.recordId === section.items[0].provenance?.recordId && p.observedAt === section.observedAt, at + '.provenance', 'not the one header read');
    } else {
      const item = keysExactly(value, CLINICAL_CONTEXT_KEYS.techNoteItem, at);
      check(count(item.version, 1) && typeof item.hasText === 'boolean', at, 'invalid');
      const p = provenance(item.provenance, at + '.provenance', kind);
      check(p.recordId === `${context.uid}#${item.version}` && p.version === item.version, at + '.provenance', 'not this note version');
    }
  });
}

/** 구역 하나의 모양(§5.1·§5.4·§5.6·§7·§9.1). 위반이면 경로와 이유를 담은 문자열(값은 담지 않는다), 아니면 null. */
export function contextSectionShapeError(name: ContextSectionName, value: unknown, context: { uid: string; anchor: any; patientKey: string | null }): string | null {
  try {
    const path = 'sections.' + name;
    const section = keysExactly(value, name === 'requestTags' ? CLINICAL_CONTEXT_KEYS.requestTagsSection : CLINICAL_CONTEXT_KEYS.section, path);
    const state = section.state;
    check(['present', 'absent', 'not_configured', 'failed'].includes(state), path + '.state', 'not a section state');
    const reasons = state === 'not_configured' || state === 'failed' ? CONTEXT_REASONS[name][state] : [null];
    check(reasons.includes(section.reason), path + '.reason', 'not in the closed list');
    check(section.sourceLabel === CONTEXT_SOURCE_LABELS[name], path + '.sourceLabel', 'not the fixed label');
    check(state === 'not_configured' && section.reason === 'no_patient_key' ? section.observedAt === null : instant(section.observedAt),
      path + '.observedAt', 'null only when the source was not read for want of a patient key');
    check(Array.isArray(section.items) && typeof section.truncated === 'boolean', path, 'items or truncated');
    const limit = { priorReports: CONTEXT_PRIOR_LIMIT, history: CONTEXT_HISTORY_LIMIT, requestTags: CONTEXT_REQUEST_TAGS.length, techNote: 1 }[name];
    check(state === 'present' ? section.items.length >= 1 && section.items.length <= limit : section.items.length === 0, path + '.items', 'count does not fit the state');
    check(!section.truncated || state === 'present' && section.items.length === limit, path + '.truncated', 'only a full present section is cut');
    if (name === 'requestTags') {
      const read = state === 'present' || state === 'absent';
      check(Array.isArray(section.checked) && section.checked.length === (read ? CONTEXT_REQUEST_TAG_CODES.length : 0)
        && section.checked.every((tag: unknown, i: number) => tag === CONTEXT_REQUEST_TAG_CODES[i]), path + '.checked', 'the five tags only when a header was read');
    }
    if (name === 'priorReports' || name === 'history') {
      check(state === 'not_configured' ? context.patientKey === null : state === 'failed' || context.patientKey !== null, path, 'state and patientKey disagree');
    }
    if (name === 'techNote') {
      check(state !== 'present' || section.items[0]?.version === context.anchor?.techNoteVersion, path, 'differs from anchor.techNoteVersion');
      check(state !== 'absent' || context.anchor?.techNoteVersion === 0, path, 'absent needs anchor.techNoteVersion 0');
    }
    sectionItems(name, section, context);
    return null;
  } catch (error) {
    if (error instanceof ShapeViolation) return error.message;
    throw error;
  }
}

/** 답 전체의 모양(§9.1). 위반이면 경로와 이유, 아니면 null. 서버는 이 확인을 통과한 답만 보낸다. */
export function clinicalContextShapeError(value: unknown): string | null {
  try {
    const answer = keysExactly(value, CLINICAL_CONTEXT_KEYS.answer, 'answer');
    check(answer.schema === CLINICAL_CONTEXT_SCHEMA, 'schema', 'not this schema');
    check(studyUid(answer.uid), 'uid', 'not a study UID');
    check(instant(answer.observedAt), 'observedAt', 'not an ISO instant');
    check(answer.patientKey === null || text(answer.patientKey), 'patientKey', 'not a key');
    const anchor = keysExactly(answer.anchor, CLINICAL_CONTEXT_KEYS.anchor, 'anchor');
    check(anchor.access === 'owner' || anchor.access === 'tele', 'anchor.access', 'not a permission basis');
    check(typeof anchor.institutionName === 'string' && count(anchor.techNoteVersion, 0), 'anchor', 'invalid');
    const identity = keysExactly(answer.identity, CLINICAL_CONTEXT_KEYS.identity, 'identity');
    check(relation(identity.birth) && relation(identity.sex), 'identity', 'not a relation');
    check(identity.conflict === (identity.birth === 'mismatch' || identity.sex === 'mismatch'), 'identity.conflict', 'disagrees with the relations');
    const sections = keysExactly(answer.sections, CLINICAL_CONTEXT_KEYS.sections, 'sections');
    for (const name of CONTEXT_SECTION_NAMES) {
      const error = contextSectionShapeError(name, sections[name], { uid: answer.uid, anchor, patientKey: answer.patientKey });
      if (error) return error;
    }
    return null;
  } catch (error) {
    if (error instanceof ShapeViolation) return error.message;
    throw error;
  }
}

/**
 * R8 조립(R7이 통과한 뒤에만 부른다). 모양 확인에 걸린 구역은 항목 없이 failed/source_invalid로 바꾼다 — 한 구역 안에서 일부
 * 항목만 싣고 성공이라 하지 않는다(부분 성공은 구역 단위뿐). 그 뒤에도 답이 닫힌 모양이 아니면 보내지 않고 던진다.
 */
export function clinicalContextAnswer(parts: { uid: string; observedAt: string; patientKey: string | null;
  anchor: { access: ContextAccess; institutionName: string; techNoteVersion: number };
  identity: { conflict: boolean; birth: string; sex: string }; sections: Record<ContextSectionName, any> }) {
  const context = { uid: parts.uid, anchor: parts.anchor, patientKey: parts.patientKey };
  const sections = {} as Record<ContextSectionName, any>;
  for (const name of CONTEXT_SECTION_NAMES) {
    const section = parts.sections[name];
    sections[name] = contextSectionShapeError(name, section, context) === null ? section
      : contextSection(name, 'failed', 'source_invalid', parts.observedAt);
  }
  const answer = { schema: CLINICAL_CONTEXT_SCHEMA, uid: parts.uid, observedAt: parts.observedAt, patientKey: parts.patientKey,
    anchor: { ...parts.anchor }, identity: { ...parts.identity }, sections };
  const error = clinicalContextShapeError(answer);
  if (error) throw new Error('clinical context answer is not the closed shape: ' + error);
  return answer;
}
