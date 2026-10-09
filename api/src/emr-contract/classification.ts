import { isEmrReader } from './composition';
import { STATUTORY_MINIMUM as FLOOR, StatutoryMinimum } from './legal-basis';
import { choice, freeze, object, refuse, string, utc, sha256, integer } from './validation';

export type PurposeEnd = 'result-version-signed' | 'intent-superseded' | 'explicit-discard' | 'owner-deleted' | 'assignment-ended' | 'setting-replaced' | 'session-ended' | 'institution-closed' | 'transfer-obligations-ended' | 'operation-completed' | 'original-received' | 'order-purpose-ended' | 'lawful-return' | 'unnecessary-operations';
export type SignatureRule = 'required' | 'clinical-entry-only' | 'source-evidence' | 'not-required';
export interface RecordClassification {
  author: { observedSource: string; responsibility: 'immutable-actual-author-or-source' };
  clinicalAdoption: 'emr-candidate' | 'operational-record' | 'evidence-record';
  legalOriginalLocation: 'product-version-store-and-protected-object-store';
  managingInstitution: 'persisted-record-managing-institution';
  retention: { years: number; statutoryMinimum: readonly StatutoryMinimum[]; basis: string;
    mode: 'statutory' | 'source-record' | 'purpose'; purposeEnds: readonly PurposeEnd[] };
  signature: { rule: SignatureRule; basis: string; explanation: string };
  provenance: readonly ['author', 'server-time', 'sha256'];
  preserveEarlierVersions: true;
  accessLogged: true;
  accessBasis: string;
  automaticDestruction: true;
}

const signed = (explanation: string): RecordClassification['signature'] => ({ rule: 'required',
  basis: '의료법 제22조①·제23조①', explanation });
const conditional = (explanation: string): RecordClassification['signature'] => ({ rule: 'clinical-entry-only',
  basis: '의료법 제22조①·제23조①', explanation });
const source = (explanation: string): RecordClassification['signature'] => ({ rule: 'source-evidence',
  basis: '의료법 제22조①·제23조①: 임상 기재의 서명과 원자료 자체를 구별', explanation });
const unsigned = (explanation: string): RecordClassification['signature'] => ({ rule: 'not-required',
  basis: '확인한 의료법 제22조①·제23조①에는 이 운영/증거 행위 자체의 별도 서명 의무 없음', explanation });

function record(author: string, signature: RecordClassification['signature'],
  minima: readonly StatutoryMinimum[], clinicalAdoption: RecordClassification['clinicalAdoption'] = 'emr-candidate',
  mode: RecordClassification['retention']['mode'] = minima.length ? 'statutory' : 'purpose',
  purposeEnds: readonly PurposeEnd[] = []): RecordClassification {
  return {
    author: { observedSource: author, responsibility: 'immutable-actual-author-or-source' }, clinicalAdoption,
    legalOriginalLocation: 'product-version-store-and-protected-object-store',
    managingInstitution: 'persisted-record-managing-institution',
    retention: { years: Math.max(0, ...minima.map(m => m.years)), statutoryMinimum: minima, mode, purposeEnds,
      basis: minima.length ? '이 기록 자체의 법정 종류별 기간; 계속 진료 1회 연장 외 기간 설정 금지; 만료 파기' :
        mode === 'source-record' ? '독립 기간 없음; 고정 원기록의 종류·기산·연장·만료를 그대로 따름; 연결만으로 기간 전파 금지' :
        '독립 법정 연수 없음; 명시적 목적 종료 시 파기; 실제 진료 기재로 채택한 내용은 해당 법정 종류로 분류' },
    signature, provenance: ['author', 'server-time', 'sha256'], preserveEarlierVersions: true, accessLogged: true,
    accessBasis: '의료법 제23조④: 기재·추가기재·수정·열람 모두 제품 기본 기록; 개정 시행 전에도 적용',
    automaticDestruction: true,
  };
}
const chart = [FLOOR.chart];
const images = [FLOOR.imageReport, FLOOR.examination];
const clinical = signed('의료인이 진료에 관한 사항·의견을 작성하는 전자의무기록; 각 기재·수정·추가기재판에 서명');

/** Classify actual content, not every referenced record. Source evidence has no independent retention clock. */
export const RECORD_CLASSIFICATION = freeze({
  // D-19 (legal register §5-02): a reading report and the clinical records attached to it are the image's 소견서 or\r
  // 검사소견 (시행규칙 제15조①6·5, 5 years); 진료기록부 (10 years) applies only through a recorded chart incorporation.
  'report-head': record('Report.updatedBy; immutable ReportVersion projection', clinical, images),
  'report-version': record('ReportVersion.author; immutable author/signer identity', clinical, images),
  'private-draft': record('ReportDraft.author; private to (uid, author)', conditional('개인 작업 초안 자체의 별도 서명 의무는 명시되지 않음; 진료기록으로 기재/사용할 때 서명, 적용 보유기간 중 모든 저장판 보존'), [], 'emr-candidate', 'purpose', ['result-version-signed', 'intent-superseded', 'explicit-discard']),
  'report-evidence': record('Pinned ReportVersion/ReportDraft provenance', source('첨부·인용 해시 보존; 임상 기재를 담은 문서는 해당 작성자의 서명 보존'), [], 'emr-candidate', 'source-record'),
  // D-3 (delta map MAP-D03): a radiographer's own Tech Note is a signed entry of its author - every version signed with the
  // author's own key, never standing in for a physician's record duty; an administrator's note on the same surface is
  // unsigned operational text (operational-note), never presented as a signed clinical entry. C wires the signature.
  'tech-note': record('TechNoteRevision.authorSub/author (radiographer)', signed('방사선사 본인의 촬영 기록 메모; 각 작성·수정판에 작성자 본인 키로 서명; 의료인의 진료기록 의무를 대체하지 않음'), [FLOOR.examination]),
  'operational-note': record('TechNoteRevision.authorSub (administrator)', unsigned('관리자의 운영 메모; 의료인의 서명 기재로 표시하지 않음; 환자 임상 문구는 해당 임상 종류로 분류'), [], 'operational-record', 'purpose', ['owner-deleted']),
  'clinical-question': record('StudyQuestion/StudyQuestionEntry.authorSub', clinical, images),
  'clinical-answer': record('StudyQuestionEntry answer author', clinical, images),
  consultation: record('StudyConsultation requester/recipient/changedBy', clinical, images),
  'critical-result': record('CriticalResult.senderSub; pinned report version', clinical, images),
  'critical-result-ack': record('CriticalResultEvent.actorSub; pinned acknowledgment', conditional('임상 인계 완료는 CVR의 일부; 별도 접속/전송 영수증과 구별; 임상 판단/조치 기재가 더해지면 서명'), images),
  'image-request': record('StudyImageRequest requester/handler/changedBy', conditional('영상 전달 요청 자체에 별도 서명 의무는 명시되지 않음; 진료 지시/의견 기재이면 서명'), [FLOOR.patientRegister]),
  finding: record('Finding/FindingRevision author/actor', clinical, images),
  measurement: record('ViewerItem/ViewerRevision author/actor', source('수동 점·ROI·수치 자체의 개별 서명 의무는 명시되지 않음; 이를 진료 소견으로 기록한 문서에는 서명'), images),
  'key-image': record('ViewerItem author; SOP/frame reference', source('원영상/선택 이력 보존; 별도 영상 선택 서명 의무는 명시되지 않음'), images),
  'manual-sr': record('ManualSr.authorSub; immutable DICOM bytes', clinical, images),
  'external-sr-seg': record('External DICOM producer; unchanged bytes', source('원작성자·원서명 증거를 보존하고 재서명/재해석하지 않음; 원자료를 새 진료기록으로 기재할 때 별도 서명'), images),
  'comparison-layout': record('ViewerJob.authorSub; image placement only', unsigned('배치만 있는 운영 기록; 임상 문구는 comparison-description으로 함께 분류'), [], 'operational-record', 'purpose', ['owner-deleted']),
  'comparison-description': record('ViewerJob/ViewerJobRevision clinical title/description/actor', clinical, images),
  'study-correction': record('StudyState.ov/orig; immutable modifying actor', conditional('원 StudyState 단위의 정정판; 원본 보존, 임상 기재 정정 시 새 서명판 필요'), images),
  'patient-match': record('StudyState/Order; immutable matching actor', conditional('환자 명부 연결 정보; 진료기록 인적사항을 정정하면 해당 원기록 분류와 새 서명판 필요'), [FLOOR.patientRegister]),
  'study-metadata': record('DICOM producer; StudyState provenance', source('취득 메타데이터에 별도 서명 의무는 명시되지 않음; 임상 기재 문서의 원서명 보존'), images),
  'clinical-context': record('Pinned per-source author/record/version', source('파생 조회는 원기록 서명 보존; 새 임상 판단을 추가하면 별도 진료 기재 서명'), [], 'emr-candidate', 'source-record'),
  image: record('Acquisition institution/modality/import source', source('영상 자체의 개별 서명 의무는 명시되지 않음; 소견서는 서명'), images),
  thumbnail: record('Pinned original image/frame renderer', source('원영상 증거 보존; 파생 썸네일에 새 서명 의무는 명시되지 않음'), [], 'emr-candidate', 'source-record'),
  download: record('Exporter; fixed source manifest', source('원기록 서명 유지; 다운로드 동작에 새 서명 의무는 명시되지 않음'), [], 'emr-candidate', 'source-record'),
  print: record('Requester; pinned source versions', source('원기록 서명 유지; 출력 동작에 새 서명 의무는 명시되지 않음'), [], 'emr-candidate', 'source-record'),
  pdf: record('Requester or external PDF producer', source('원기록 서명 유지; 형식 변환에 새 서명 의무는 명시되지 않음'), [], 'emr-candidate', 'source-record'),
  copy: record('Copying actor; fixed selection', source('원기록 서명 유지; 복사 동작에 새 서명 의무는 명시되지 않음'), [], 'emr-candidate', 'source-record'),
  disclosure: record('Providing actor; basis/recipient/fixed scope', source('원기록 서명 유지; 제공 동작에 새 서명 의무는 명시되지 않음'), [], 'emr-candidate', 'source-record'),
  'access-audit': record('System recorder; immutable acting identity', unsigned('접속사건은 작성자·시각·해시 및 내구성으로 증명'), [FLOOR.access], 'evidence-record'),
  'signature-evidence': record('Registered signer/key registrar; exact signed bytes', unsigned('기존 서명 검증 증거에 재귀적 서명 의무는 명시되지 않음'), [], 'evidence-record', 'source-record'),
  order: record('Registration actor; pinned original clinical direction', unsigned('이미 존재하는 원 지시를 접수·예약·대사하는 등록 표현; 원 지시 참조 필수'), [], 'operational-record', 'purpose', ['order-purpose-ended', 'lawful-return', 'unnecessary-operations']),
  'order-indication': record('Treating physician; original decision, including a code-only direction', clinical, chart),
  'exam-clinical-info': record('Exam clinical information author; own signed entry', signed('검사내용으로 처음 작성한 임상정보; 작성자 본인 서명'), [FLOOR.examination]),
  'order-exam-component': record('Verified fulfilment event; pinned adopted part', source('이행 확인으로 검사에 채택한 부분; 원기재 단위·원서명은 별도로 존속'), [FLOOR.examination]),
  'received-order': record('Verified feed and per-record obligations; unchanged original evidence', source('원판·원서명·출처·원 기산 증거는 승계 의무를 따르며 단순 수신 영수증과 분리'), [], 'evidence-record', 'purpose', ['order-purpose-ended', 'lawful-return', 'unnecessary-operations']),
  dictation: record('Radiologist; preserved voice/transcript versions', conditional('개인 음성 초안 자체의 별도 서명 의무는 명시되지 않음; 진료기록으로 기재할 때 서명'), [], 'emr-candidate', 'purpose', ['result-version-signed', 'intent-superseded', 'explicit-discard']),
  assignment: record('ReaderAssignment.changedBy; allocation only', unsigned('업무 배정'), [], 'operational-record', 'purpose', ['assignment-ended']),
  preferences: record('Account/site setting author', unsigned('필터·배치 설정만; 환자 임상 문구가 있으면 임상 종류로 추가 분류'), [], 'operational-record', 'purpose', ['setting-replaced', 'owner-deleted']),
  'reading-template': record('ReadingTemplate.owner', unsigned('환자 없는 문구 양식; 환자별 채택 내용은 서명된 임상 기재'), [], 'operational-record', 'purpose', ['owner-deleted']),
  'study-organization': record('StudyTagCatalog.ownerSub; FavoriteWorkspace.subject', conditional('분류표/즐겨찾기 동작 자체는 서명 의무 없음; 임상 기재로 채택하면 해당 종류로 분류'), [], 'emr-candidate', 'purpose', ['owner-deleted']),
  'identity-access': record('Keycloak/member/StudyAccessRevision author', unsigned('권한 부여 증거; 진료기록 서명과 구분'), [], 'operational-record', 'purpose', ['assignment-ended']),
  'authentication-session': record('Authentication service; no credential copying', unsigned('인증 상태; 종료한 비밀은 의무기록 보존 대상에서 제외'), [], 'operational-record', 'purpose', ['session-ended']),
  institution: record('Institution administrator', unsigned('기관 설정'), [], 'operational-record', 'purpose', ['institution-closed']),
  'transfer-governance': record('TransferBasis/ProcessingAgreement/Transfer author', unsigned('법 제23조①의 진료기록 서명과 별개; 전송 근거·동의 계약은 유지'), [], 'evidence-record', 'purpose', ['transfer-obligations-ended']),
  // Two years is a product policy for the receipt only, not a statutory floor for its original payload.
  'delivery-receipt': { ...record('Gateway/service/request actor; fixed source reference', unsigned('단순 전달 영수증의 제품 정책 2년; 원판·원서명은 별도 의무'), [FLOOR.access], 'evidence-record'),
    retention: { years: 2, statutoryMinimum: [], basis: '제품 정책: 전달 결과 확인; 내부 관리계획에 목적·필요성·조기 종료 명시', mode: 'statutory' as const, purposeEnds: [] } },
  'system-operation': record('System process; health/statistics/accounting', unsigned('운영 상태'), [], 'operational-record', 'purpose', ['operation-completed']),
  // EMR-B1 (D596): an approval actually signed on a registered device while disconnected is the signed record itself, kept
  // from its actual signedAt; its recovery/review working copy is a separate purpose record that cannot outlive its purpose.
  'offline-signed-original': record('Device signer; registered device key and its own kid; exact signed bytes at the actual signedAt', signed('단말에서 실제 서명한 임상 기재 원본; 수신·재인증 시각으로 다시 서명하거나 기산하지 않음'), images),
  'recovery-working-copy': record('Owner; its original event or conflict record; purpose ID', conditional('복구·재검토 작업본 자체의 별도 서명 의무는 명시되지 않음; 진료기록으로 기재·채택할 때 새 서명판'), [], 'emr-candidate', 'purpose', ['original-received', 'explicit-discard']),
  // D-19 (legal register §5-02): the 10-year 진료기록부 class applies only through this recorded fact - a hospital EMR
  // incorporation event or the treating physician's chart entry that incorporates the pinned versions (its component
  // manifest; relation 'incorporation'). A comparison or navigation link never counts. Its period counts from the
  // incorporation, and the incorporated versions are kept while it is (retainingUnits).
  'chart-incorporation': record('Hospital EMR incorporation event or treating physician chart entry; pinned incorporated versions', source('편입 사건 자체에 새 서명 의무는 명시되지 않음; 편입된 판의 원서명·바이트 보존'), chart),
  // EMR-B1 storage of legal duties and the reviewed clause history: evidence attached to the records they concern.
  'legal-duty': record('Verified legal duty adapter; order/request, authority, scope, validity and release', unsigned('법적 보존 의무·요청 증빙; 진료기록 서명과 구분'), [], 'evidence-record', 'source-record'),
  'legal-reference': record('Reviewed statute clause history (unit I); publication and effective dates', unsigned('검토된 조문 판본 이력; 환자·개인 자료 없음'), [], 'evidence-record', 'source-record'),
});
export type RecordKind = keyof typeof RECORD_CLASSIFICATION;

/** SQL-only storage of EMR-B (schema emr_access, its own tablespace), classified apart from Prisma models: none of these is
 * a Prisma model and the Prisma inventory never lists them. The live catalog is compared with this table both ways. */
export const SQL_STORAGE_CLASSIFICATION: Readonly<Record<string, readonly RecordKind[]>> = freeze({
  'emr_access.access_entry': ['access-audit'], 'emr_access.access_target': ['access-audit'], 'emr_access.chain_head': ['access-audit'],
  'emr_access.audit_projection': ['access-audit'],
  'emr_access.commit_marker': ['access-audit'],
  'emr_access.member_identity': ['identity-access'],
  'emr_access.legal_hold_event': ['legal-duty'], 'emr_access.duty_request_event': ['legal-duty'],
  'emr_access.clause_version': ['legal-reference'],
  'emr_access.order_fact': ['order', 'order-indication', 'exam-clinical-info', 'received-order', 'order-exam-component'],
});
/** D596 storage boundary: offline originals and their working copies live in C's clinical terminal queue, not in B. */
export const TERMINAL_RECORD_BOUNDARY = freeze({
  storage: 'clinical-terminal-queue',
  models: { TerminalSignedOriginal: ['offline-signed-original'], TerminalRecoveryCopy: ['recovery-working-copy'] } as Record<string, readonly RecordKind[]>,
  states: ['pending-transmission', 'received-unverified', 'verified', 'verification-refused'],
  original: 'owned by its immutable signer; retention from the actual signedAt; never ended by a private-draft purpose end; reception and re-authentication are separate events',
  recovery: 'owned by the same member; references its original event; a purpose ID; ends at verified reception of the original or the owner discard',
});
/** D-19 storage boundary: chart incorporation facts come from the hospital EMR or the treating physician's chart (C/H). */
export const CHART_INCORPORATION_BOUNDARY = freeze({
  storage: 'chart-incorporation-facts',
  models: { ChartIncorporation: ['chart-incorporation'] } as Record<string, readonly RecordKind[]>,
  sources: ['hospital-emr-incorporation', 'treating-physician-chart-entry'],
});
export type TerminalState = 'pending-transmission' | 'received-unverified' | 'verified' | 'verification-refused';
export interface TerminalRecordFacts {
  ownerId: string; originalEventId: string; state: TerminalState;
  signedAt: string | null; purposeId: string | null;
}
function terminalFacts(kind: RecordKind, row: Record<string, any>, event: RecordEvent): void {
  string(row.ownerId); string(row.originalEventId); choice(row.state, TERMINAL_RECORD_BOUNDARY.states);
  if (kind === 'offline-signed-original') {
    // The stored event time is the device's actual signing time; a reception or re-authentication time is refused.
    if (row.purposeId !== null || utc(row.signedAt) !== event.at || !event.signature) refuse('TerminalOriginalTimeRefused');
  } else if (row.signedAt !== null || typeof row.purposeId !== 'string' || !row.purposeId.trim() || event.act !== 'creation') {
    refuse('TerminalPurposeRequired');
  }
}

/** D-24: facts supplied by the bound storage adapter, never classification flags accepted from an HTTP body. */
export const ORDER_OBJECTS = freeze(['registration', 'order-indication', 'exam-clinical-info', 'received-order', 'exam-component'] as const);
export const ORDER_REVIEW_STATES = freeze(['classification-unconfirmed', 'entrusted-evidence-unconfirmed', 'linked-fulfilment-unconfirmed',
  'open-order', 'unlinked-exam', 'copy-window-review', 'interface-outage', 'claim-duty-end-unconfirmed'] as const);
export interface OrderProcedure {
  state: typeof ORDER_REVIEW_STATES[number]; responsibleRole: 'privacy-officer' | 'delegated-officer'; assigneeId: string;
  enteredAt: string; evidenceDueAt: string; escalationDecisionDueAt: string; finalDecisionDueAt: string;
  superiorRole: 'institution-head' | 'trustee-representative'; superiorId: string; escalatedAt: string | null;
  extensions: number; extensionLimit: number; extensionEvidenceId: string | null;
  decision: null | { route: 'classification-confirmed' | 'duty-continues' | 'lawful-return' | 'unnecessary-operations';
    actorId: string; at: string; evidenceId: string; basisId: string | null; scope: readonly string[];
    reviewAt: string | null; originalPreservedEvidenceId: string | null };
}
export interface DirectionSourceRef { kind: 'received-order' | 'native-chart' | 'order-indication'; systemId: string; recordId: string; versionId: string }
export interface OrderFacts {
  objectKind: typeof ORDER_OBJECTS[number]; origin: 'product-authored' | 'received-ris' | 'migrated';
  authorId: string; authorRole: 'physician' | 'radiographer' | 'registrar' | 'interface'; requestingClinicianId: string;
  directionSourceRef: DirectionSourceRef | null; examCodes: readonly string[];
  source: null | { systemId: string; recordId: string; versionId: string; at: string; signatureEvidenceId: string };
  feed: null | { feedId: string; installationEvidenceId: string; roles: readonly ('worklist-copy' | 'exam-component' | 'entrusted-original')[] };
  inherited: readonly { kind: RecordKind; recordId: string; versionId: string; startedAt: string; evidenceId: string }[];
  firstReceivedAt: string | null; firstReceiptEventId: string | null; duplicateOf: string | null;
  scheduledAt: string | null; scheduleChangeEvidenceId: string | null;
  status: 'open' | 'linked' | 'fulfilment-confirmed' | 'closed' | 'cancelled' | 'superseded';
  statusEvent: { eventId: string; actorId: string; at: string; reason: string };
  fulfilment: null | { eventId: string; actorId: string; at: string; studyId: string; partial: boolean; reason: string };
  chartIncorporation: null | { eventId: string; at: string; recordId: string; versionId: string };
  procedure: OrderProcedure | null;
  synthetic: null | { runId: string; seedId: string; originalSha256: string; observedSha256: string; checkedAt: string;
    verificationRunId: string; linkedStudyIds: readonly string[] };
}
export function parseOrderProcedure(input: unknown): Readonly<OrderProcedure> {
  const p = object(input, ['state', 'responsibleRole', 'assigneeId', 'enteredAt', 'evidenceDueAt', 'escalationDecisionDueAt',
    'finalDecisionDueAt', 'superiorRole', 'superiorId', 'escalatedAt', 'extensions', 'extensionLimit', 'extensionEvidenceId', 'decision']);
  choice(p.state, ORDER_REVIEW_STATES); choice(p.responsibleRole, ['privacy-officer', 'delegated-officer']); string(p.assigneeId);
  choice(p.superiorRole, ['institution-head', 'trustee-representative']); string(p.superiorId);
  const dates = ['enteredAt', 'evidenceDueAt', 'escalationDecisionDueAt', 'finalDecisionDueAt'].map(k => utc(p[k]));
  if (dates.some((d, i) => i > 0 && d <= dates[i - 1])) refuse('OrderProcedureDeadlineRequired');
  if (p.escalatedAt !== null && utc(p.escalatedAt) < p.enteredAt) refuse('OrderProcedureDeadlineRequired');
  if (integer(p.extensions) > integer(p.extensionLimit)) refuse('OrderReconciliationLimit');
  if (p.extensions > 0) string(p.extensionEvidenceId); else if (p.extensionEvidenceId !== null) refuse('OrderExtensionEvidenceRequired');
  if (p.decision !== null) {
    const d = object(p.decision, ['route', 'actorId', 'at', 'evidenceId', 'basisId', 'scope', 'reviewAt', 'originalPreservedEvidenceId']);
    choice(d.route, ['classification-confirmed', 'duty-continues', 'lawful-return', 'unnecessary-operations']);
    string(d.actorId); string(d.evidenceId);
    if (utc(d.at) < p.enteredAt || ![p.assigneeId, p.superiorId].includes(d.actorId) ||
        (d.at >= p.escalationDecisionDueAt && d.actorId !== p.superiorId)) refuse('OrderDecisionAuthorityRequired');
    if (!Array.isArray(d.scope) || !d.scope.length) refuse('OrderDecisionScopeRequired');
    d.scope.forEach(x => string(x));
    if (d.route === 'duty-continues') {
      string(d.basisId);
      if (utc(d.reviewAt) <= d.at) refuse('OrderProcedureDeadlineRequired');
    } else if (d.basisId !== null || d.reviewAt !== null) refuse('OrderDecisionBindingRefused');
    if (d.route === 'lawful-return') string(d.originalPreservedEvidenceId);
    else if (d.originalPreservedEvidenceId !== null) refuse('OrderDecisionBindingRefused');
  }
  return freeze(structuredClone(p)) as Readonly<OrderProcedure>;
}
export function parseOrderFacts(input: unknown): Readonly<OrderFacts> {
  const r = object(input, ['objectKind', 'origin', 'authorId', 'authorRole', 'requestingClinicianId', 'directionSourceRef', 'examCodes',
    'source', 'feed', 'inherited', 'firstReceivedAt', 'firstReceiptEventId', 'duplicateOf', 'scheduledAt', 'scheduleChangeEvidenceId',
    'status', 'statusEvent', 'fulfilment', 'chartIncorporation', 'procedure', 'synthetic']);
  choice(r.objectKind, ORDER_OBJECTS); choice(r.origin, ['product-authored', 'received-ris', 'migrated']);
  string(r.authorId); choice(r.authorRole, ['physician', 'radiographer', 'registrar', 'interface']); string(r.requestingClinicianId);
  if (!Array.isArray(r.examCodes) || !r.examCodes.length || new Set(r.examCodes).size !== r.examCodes.length) refuse('OrderExamCodesRequired');
  r.examCodes.forEach(x => string(x));
  if (r.objectKind === 'registration' && r.directionSourceRef === null && r.origin !== 'migrated') refuse('DirectionSourceRequired');
  if (r.directionSourceRef !== null) {
    const d = object(r.directionSourceRef, ['kind', 'systemId', 'recordId', 'versionId']);
    choice(d.kind, ['received-order', 'native-chart', 'order-indication']); ['systemId', 'recordId', 'versionId'].forEach(k => string(d[k]));
  }
  if (r.objectKind === 'order-indication' && r.authorRole !== 'physician') refuse('OrderClinicalAuthorRequired');
  if (r.source !== null) {
    const s = object(r.source, ['systemId', 'recordId', 'versionId', 'at', 'signatureEvidenceId']);
    ['systemId', 'recordId', 'versionId', 'signatureEvidenceId'].forEach(k => string(s[k])); utc(s.at);
  }
  if (r.feed !== null) {
    const f = object(r.feed, ['feedId', 'installationEvidenceId', 'roles']); string(f.feedId); string(f.installationEvidenceId);
    if (!Array.isArray(f.roles) || !f.roles.length || new Set(f.roles).size !== f.roles.length) refuse('OrderFeedEvidenceRequired');
    f.roles.forEach(x => choice(x, ['worklist-copy', 'exam-component', 'entrusted-original']));
  }
  if (!Array.isArray(r.inherited)) refuse('OrderInheritedEvidenceRequired');
  for (const d of r.inherited) {
    object(d, ['kind', 'recordId', 'versionId', 'startedAt', 'evidenceId']);
    const kind = choice(d.kind, Object.keys(RECORD_CLASSIFICATION) as RecordKind[]);
    if (!RECORD_CLASSIFICATION[kind].retention.statutoryMinimum.length || ['access-audit', 'patient-match'].includes(kind)) refuse('OrderInheritedEvidenceRequired');
    string(d.recordId); string(d.versionId); utc(d.startedAt); string(d.evidenceId);
  }
  if (r.objectKind === 'received-order') {
    utc(r.firstReceivedAt); string(r.firstReceiptEventId);
    if (r.source && r.source.at > r.firstReceivedAt) refuse('OrderReceiptRequired');
    if (r.feed && r.feed.roles.includes('entrusted-original') !== (r.inherited.length > 0) &&
        r.procedure?.state !== 'entrusted-evidence-unconfirmed') refuse('OrderInheritedEvidenceRequired');
  } else if (r.feed !== null || r.inherited.length || r.firstReceivedAt !== null || r.firstReceiptEventId !== null || r.duplicateOf !== null) refuse('OrderReceiptRequired');
  if (r.duplicateOf !== null && string(r.duplicateOf) !== r.firstReceiptEventId) refuse('OrderReceiptRequired');
  if (r.scheduledAt !== null) utc(r.scheduledAt);
  if (r.scheduleChangeEvidenceId !== null) string(r.scheduleChangeEvidenceId);
  choice(r.status, ['open', 'linked', 'fulfilment-confirmed', 'closed', 'cancelled', 'superseded']);
  const e = object(r.statusEvent, ['eventId', 'actorId', 'at', 'reason']); string(e.eventId); string(e.actorId); utc(e.at); string(e.reason, true);
  if (r.fulfilment !== null) {
    const f = object(r.fulfilment, ['eventId', 'actorId', 'at', 'studyId', 'partial', 'reason']);
    ['eventId', 'actorId', 'studyId'].forEach(k => string(f[k])); utc(f.at); string(f.reason);
    if (typeof f.partial !== 'boolean') refuse('OrderFulfilmentRequired');
  }
  if ((r.status === 'fulfilment-confirmed' || r.objectKind === 'exam-component' || r.feed?.roles.includes('exam-component')) && !r.fulfilment)
    refuse('OrderFulfilmentRequired');
  if (r.chartIncorporation !== null) {
    const c = object(r.chartIncorporation, ['eventId', 'at', 'recordId', 'versionId']);
    ['eventId', 'recordId', 'versionId'].forEach(k => string(c[k])); utc(c.at);
  }
  if (r.procedure !== null) parseOrderProcedure(r.procedure);
  const unresolved = r.origin === 'migrated' || r.status === 'linked' ||
    (r.objectKind === 'registration' && r.status === 'open') || (r.objectKind === 'received-order' && !r.scheduledAt && r.status === 'open');
  if (unresolved && !r.procedure) refuse('OrderProcedureRequired');
  if ((r.objectKind === 'registration' && !r.directionSourceRef || r.objectKind === 'received-order' && (!r.source || !r.feed)) &&
      (!r.procedure || !['classification-unconfirmed', 'entrusted-evidence-unconfirmed'].includes(r.procedure.state) ||
       r.procedure.decision?.route === 'classification-confirmed')) refuse('OrderClassificationUnconfirmed');
  if (r.synthetic !== null) {
    const s = object(r.synthetic, ['runId', 'seedId', 'originalSha256', 'observedSha256', 'checkedAt', 'verificationRunId', 'linkedStudyIds']);
    string(s.runId); string(s.seedId); string(s.verificationRunId); sha256(s.originalSha256); sha256(s.observedSha256); utc(s.checkedAt);
    if (!Array.isArray(s.linkedStudyIds)) refuse('SyntheticVerificationRequired');
    s.linkedStudyIds.forEach(x => string(x));
    if (s.originalSha256 !== s.observedSha256 || s.linkedStudyIds.length || r.fulfilment !== null) refuse('SyntheticVerificationRequired');
  }
  return freeze(structuredClone(r)) as Readonly<OrderFacts>;
}
/** A code-only direction is still native-chart; adoption creates another record and never reclassifies the original. */
function orderKinds(row: Record<string, any>, event: RecordEvent): readonly RecordKind[] {
  const r = parseOrderFacts(row);
  if (r.procedure && r.procedure.decision?.route !== 'classification-confirmed' && ['classification-unconfirmed', 'entrusted-evidence-unconfirmed'].includes(r.procedure.state))
    refuse('OrderClassificationUnconfirmed');
  if (r.objectKind === 'order-indication') return ['order-indication'];
  if (r.objectKind === 'exam-clinical-info') return ['exam-clinical-info'];
  if (r.objectKind === 'exam-component') {
    if (!event.components.length) refuse('OrderOriginalComponentRequired');
    return ['order-exam-component', 'patient-match'];
  }
  if (r.objectKind === 'received-order' && (event.act !== 'receipt' || r.firstReceiptEventId !== event.eventId || r.firstReceivedAt !== event.at))
    refuse('OrderReceiptRequired');
  const kinds: RecordKind[] = [r.objectKind === 'registration' ? 'order' : 'received-order'];
  if (r.fulfilment) kinds.push('order-exam-component', 'patient-match');
  if (r.chartIncorporation) {
    if (!event.components.length) refuse('ChartIncorporationRequired');
    kinds.push('chart-incorporation');
  }
  for (const duty of r.inherited) if (!kinds.includes(duty.kind)) kinds.push(duty.kind);
  return kinds;
}

/** Multi-kind rows deliberately retain mixed clinical/operational content. */
export const MODEL_CLASSIFICATION: Readonly<Record<string, readonly RecordKind[]>> = freeze({
  AuthSession: ['authentication-session'], Institution: ['institution'],
  IdpSessionEnd: ['authentication-session'], MemberIsolation: ['identity-access'],
  // Provider calls record their own completion; they are neither the rights row nor the session they affect.
  ProviderChange: ['system-operation'], MemberRights: ['identity-access'], MemberRightsImport: ['system-operation'],
  StudyState: ['study-metadata', 'study-correction', 'patient-match', 'assignment'],
  GatewayReceipt: ['delivery-receipt'], GatewayRetryRequest: ['delivery-receipt'],
  TechNoteRevision: ['tech-note', 'operational-note'], TransferBasis: ['transfer-governance'], ProcessingAgreement: ['transfer-governance'], Transfer: ['transfer-governance', 'patient-match'],
  Report: ['report-head'], ReportDraft: ['private-draft', 'report-evidence'], ReportVersion: ['report-version', 'report-evidence'], Order: ['order', 'received-order', 'order-indication', 'exam-clinical-info', 'order-exam-component', 'patient-match', 'chart-incorporation'],
  UserFilterCollection: ['preferences'], SharedFilterLibrary: ['preferences'], UserFilter: ['preferences'], ReadingTemplate: ['reading-template'],
  AuditLog: ['access-audit'], ViewerItem: ['measurement', 'key-image'], ViewerRevision: ['measurement', 'key-image'], ManualSr: ['manual-sr'],
  ViewerStorageBudget: ['system-operation'], ViewerRequest: ['delivery-receipt'], Finding: ['finding'], FindingRevision: ['finding'],
  WorklistColumns: ['preferences'], ReadingPreferences: ['preferences'], ReadingAppearance: ['preferences'], WorkspaceLayout: ['preferences'],
  StudyTagCatalog: ['study-organization'], FavoriteWorkspace: ['study-organization'],
  ViewerJob: ['comparison-layout', 'comparison-description'], ViewerJobRevision: ['comparison-layout', 'comparison-description'], ReaderAssignment: ['assignment'],
  WorkspaceShortcuts: ['preferences'], StudyConsultation: ['consultation'], StudyQuestion: ['clinical-question'], StudyQuestionEntry: ['clinical-question', 'clinical-answer'],
  StudyImageRequest: ['image-request'], StudyImageRequestReceipt: ['delivery-receipt', 'image-request'],
  CriticalResult: ['critical-result', 'report-version'], CriticalResultEvent: ['critical-result', 'critical-result-ack'], CriticalResultReceipt: ['delivery-receipt', 'critical-result-ack'],
  HangingProtocolPreference: ['preferences'], StudyAccessPolicy: ['identity-access'], StudyAccessRevision: ['identity-access'],
});

export function classifyModel(name: string): readonly RecordKind[] {
  if (!Object.prototype.hasOwnProperty.call(MODEL_CLASSIFICATION, name)) throw new Error(`Unclassified model: ${name}`);
  return MODEL_CLASSIFICATION[name];
}

/** These adapters are bound by the server composition root to server storage at composition time, never deserialized from a request.
 * The caller supplies an opaque row/event ID, not the model, kind, signature verdict or row discriminator.
 */
export interface StoredRecordReader { load(recordId: string, eventId: string): unknown }
export interface Component { recordId: string; partId: string; sha256: string }
export interface RecordEvent {
  eventId: string; recordId: string; versionId: string; sha256: string; contentSha256: string; at: string;
  act: 'entry' | 'additional-entry' | 'correction' | 'acquisition' | 'receipt' | 'creation' | 'handoff-ack' | 'access' | 'delivery' | 'read' | 'resign' | 'migration' | 'bookkeeping';
  signature: { versionId: string; sha256: string; signedAt: string; verified: boolean } | null;
  predecessor: Component | null;
  components: readonly Component[];
  processing: { basisId: string; authorized: boolean; preservesOriginals: boolean; separateManagement: boolean; permittedHoldIds: readonly string[]; componentRecordIds?: readonly string[] } | null;
}
export interface ResolvedRecord {
  recordId: string; model: string; kinds: readonly RecordKind[]; row: Readonly<Record<string, any>>; event: Readonly<RecordEvent>;
}
const resolvedRecords = new WeakSet<object>();
export function verifiedRecord(input: ResolvedRecord): ResolvedRecord {
  if (!resolvedRecords.has(input)) refuse('StoredRecordRequired');
  return input;
}
function rowKinds(model: string, row: Record<string, any>, event: RecordEvent): readonly RecordKind[] {
  if (model === 'emr_access.order_fact') return orderKinds(row, event);
  if (model === 'DicomInstance') return [row.sopClass === 'image' ? 'image' : choice(row.sopClass, ['external-sr-seg', 'pdf'])];
  if (model === 'Dictation') return ['dictation'];
  if (Object.prototype.hasOwnProperty.call(TERMINAL_RECORD_BOUNDARY.models, model)) {
    const [kind] = TERMINAL_RECORD_BOUNDARY.models[model];
    terminalFacts(kind, row, event); return [kind];
  }
  if (Object.prototype.hasOwnProperty.call(CHART_INCORPORATION_BOUNDARY.models, model)) {
    // An incorporation names its source and incorporates at least one pinned version; a link without content is not one.
    choice(row.source, CHART_INCORPORATION_BOUNDARY.sources);
    if (!event.components.length) refuse('ChartIncorporationRequired');
    return CHART_INCORPORATION_BOUNDARY.models[model];
  }
  if (Object.prototype.hasOwnProperty.call(SQL_STORAGE_CLASSIFICATION, model))
    return SQL_STORAGE_CLASSIFICATION[model].filter(k => RECORD_CLASSIFICATION[k].retention.mode !== 'source-record');
  const possible = classifyModel(model);
  switch (model) {
    case 'StudyState':
      switch (choice(row.change, ['acquisition', 'correction', 'patient-match', 'assignment'])) {
        case 'acquisition': return ['study-metadata'];
        case 'correction':
          if (row.sourceRecordId !== event.recordId || event.act !== 'correction' || !event.predecessor) refuse('CorrectionSourceRequired');
          return ['study-metadata', 'study-correction'];
        case 'patient-match': string(row.orderOid); return ['patient-match'];
        case 'assignment': return ['assignment'];
      }
      break;
    case 'Order':
      return orderKinds(row, event);
    case 'Transfer': return row.localPatientId === null ? ['transfer-governance'] : (string(row.localPatientId), ['patient-match']);
    case 'ViewerItem': case 'ViewerRevision': return [choice(row.snapshot?.type, ['measurement', 'key-image'])];
    case 'ViewerJob': case 'ViewerJobRevision':
      // B resolves clinical adoption against the stored text and signed event, not an HTTP flag.
      if (typeof row.clinicalEntry !== 'boolean') refuse('RowFactsRequired');
      string(row.title, true); string(row.description, true);
      if (row.clinicalEntry && !(row.title.trim() || row.description.trim())) refuse('RowFactsRequired');
      return row.clinicalEntry ? ['comparison-description'] : ['comparison-layout'];
    case 'StudyQuestionEntry': return [choice(row.kind, ['question', 'answer']) === 'answer' ? 'clinical-answer' : 'clinical-question'];
    // D-3: who wrote the note decides what it is, read from the stored author role, never from a request flag.
    case 'TechNoteRevision': return [choice(row.authorRole, ['radiographer', 'administrator']) === 'administrator' ? 'operational-note' : 'tech-note'];
    case 'CriticalResult': return ['critical-result'];
    case 'CriticalResultEvent':
      string(row.recordId);
      if (row.recordId !== event.recordId) refuse('RecordEventBindingRefused');
      if (row.event === 'ack') {
        const pin = object(row.acknowledgedVersion, ['recordId', 'partId', 'sha256']);
        string(row.recipientId);
        if (row.actorId !== row.recipientId || !event.components.some(c => c.recordId === pin.recordId && c.partId === pin.partId && c.sha256 === pin.sha256)) refuse('CvrAckBindingRefused');
      }
      return [choice(row.event, ['created', 'replaced', 'ack']) === 'ack' ? 'critical-result-ack' : 'critical-result'];
    case 'StudyImageRequestReceipt': case 'CriticalResultReceipt': return ['delivery-receipt'];
    default: return possible.filter(k => RECORD_CLASSIFICATION[k].retention.mode !== 'source-record');
  }
  return refuse('RowFactsRequired');
}
export function parseRecordEvent(input: unknown): Readonly<RecordEvent> {
  const e = object(input, ['eventId', 'recordId', 'versionId', 'sha256', 'contentSha256', 'at', 'act', 'signature', 'predecessor', 'components', 'processing']);
  string(e.versionId); sha256(e.sha256); sha256(e.contentSha256); utc(e.at);
  choice(e.act, ['entry', 'additional-entry', 'correction', 'acquisition', 'receipt', 'creation', 'handoff-ack', 'access', 'delivery', 'read', 'resign', 'migration', 'bookkeeping']);
  if (e.signature !== null) {
    const s = object(e.signature, ['versionId', 'sha256', 'signedAt', 'verified']);
    if (s.verified !== true || s.versionId !== e.versionId || s.sha256 !== e.sha256 || utc(s.signedAt) !== e.at) refuse('SignatureBindingRefused');
  }
  if (e.predecessor !== null) {
    const p = object(e.predecessor, ['recordId', 'partId', 'sha256']); string(p.recordId); string(p.partId); sha256(p.sha256);
  }
  if (!Array.isArray(e.components)) refuse('ComponentManifestRequired');
  for (const c of e.components) { object(c, ['recordId', 'partId', 'sha256']); string(c.recordId); string(c.partId); sha256(c.sha256); }
  if (new Set(e.components.map(c => `${c.recordId}\0${c.partId}`)).size !== e.components.length) refuse('ComponentManifestRequired');
  if (e.processing !== null) {
    const p = object(e.processing, ['basisId', 'authorized', 'preservesOriginals', 'separateManagement', 'permittedHoldIds', ...(Object.prototype.hasOwnProperty.call(e.processing, 'componentRecordIds') ? ['componentRecordIds'] : [])]);
    string(p.basisId);
    if (![p.authorized, p.preservesOriginals, p.separateManagement].every(x => typeof x === 'boolean') || !Array.isArray(p.permittedHoldIds)) refuse('ProcessingBasisRequired');
    p.permittedHoldIds.forEach(x => string(x));
    if (p.componentRecordIds !== undefined) {
      if (!Array.isArray(p.componentRecordIds) || new Set(p.componentRecordIds).size !== p.componentRecordIds.length) refuse('ProcessingBasisRequired');
      p.componentRecordIds.forEach(x => string(x));
    }
  }
  string(e.recordId); string(e.eventId);
  return freeze(structuredClone(e)) as Readonly<RecordEvent>;
}
export function resolveStoredRecord(reader: StoredRecordReader, recordId: string, eventId: string): Readonly<ResolvedRecord> {
  string(recordId); string(eventId);
  if (!isEmrReader('stored', reader)) refuse('StoredReaderRequired');
  const v = object(reader.load(recordId, eventId), ['recordId', 'model', 'row', 'event']);
  const e = parseRecordEvent(v.event);
  if (v.recordId !== recordId || e.recordId !== recordId || e.eventId !== eventId) refuse('RecordEventBindingRefused');
  const model = string(v.model), row = object(v.row, Object.keys(v.row ?? {}));
  const result = freeze({ recordId, model, row: structuredClone(row), event: structuredClone(e) as RecordEvent, kinds: rowKinds(model, row, e as RecordEvent) });
  if (!result.kinds.length) refuse('RowFactsRequired');
  resolvedRecords.add(result);
  return result;
}
/** A consumer selects the handling path from resolved facts, never chooses kinds from the model inventory. */
export function retentionDisposition(source: ResolvedRecord): 'statutory' | 'purpose' | 'source-record' | 'access-event' {
  const s = verifiedRecord(source);
  if (s.kinds.some(k => ['access-audit', 'delivery-receipt'].includes(k))) return 'access-event';
  if (s.kinds.some(k => RECORD_CLASSIFICATION[k].retention.mode === 'statutory')) return 'statutory';
  return RECORD_CLASSIFICATION[s.kinds[0]].retention.mode;
}
