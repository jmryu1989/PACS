import { STATUTORY_MINIMUM as FLOOR, StatutoryMinimum } from './legal-basis';
import { freeze } from './validation';

export type PurposeEnd = 'report-approved' | 'report-finalized' | 'explicit-discard' | 'owner-deleted' | 'assignment-ended' | 'setting-replaced' | 'session-ended' | 'institution-closed' | 'transfer-obligations-ended' | 'operation-completed';
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
  'report-head': record('Report.updatedBy; immutable ReportVersion projection', clinical, [...images, FLOOR.chart]),
  'report-version': record('ReportVersion.author; immutable author/signer identity', clinical, [...images, FLOOR.chart]),
  'private-draft': record('ReportDraft.author; private to (uid, author)', conditional('개인 작업 초안 자체의 별도 서명 의무는 명시되지 않음; 진료기록으로 기재/사용할 때 서명, 적용 보유기간 중 모든 저장판 보존'), [], 'emr-candidate', 'purpose', ['report-approved', 'report-finalized', 'explicit-discard']),
  'report-evidence': record('Pinned ReportVersion/ReportDraft provenance', source('첨부·인용 해시 보존; 임상 기재를 담은 문서는 해당 작성자의 서명 보존'), [], 'emr-candidate', 'source-record'),
  'tech-note': record('TechNoteRevision.authorSub/author', conditional('촬영기사의 업무 메모 자체의 전자서명 의무는 명시되지 않음; 의료인의 진료 기재이면 제22조①·제23조① 적용'), [FLOOR.examination]),
  'clinical-question': record('StudyQuestion/StudyQuestionEntry.authorSub', clinical, chart),
  'clinical-answer': record('StudyQuestionEntry answer author', clinical, chart),
  consultation: record('StudyConsultation requester/recipient/changedBy', clinical, chart),
  'critical-result': record('CriticalResult.senderSub; pinned report version', clinical, chart),
  'critical-result-ack': record('CriticalResultEvent.actorSub; pinned acknowledgment', conditional('단순 수신 확인에 별도 서명 의무는 명시되지 않음; 임상 판단/조치 기재가 더해지면 서명'), [FLOOR.access]),
  'image-request': record('StudyImageRequest requester/handler/changedBy', conditional('영상 전달 요청 자체에 별도 서명 의무는 명시되지 않음; 진료 지시/의견 기재이면 서명'), [FLOOR.patientRegister]),
  finding: record('Finding/FindingRevision author/actor', clinical, chart),
  measurement: record('ViewerItem/ViewerRevision author/actor', source('수동 점·ROI·수치 자체의 개별 서명 의무는 명시되지 않음; 이를 진료 소견으로 기록한 문서에는 서명'), images),
  'key-image': record('ViewerItem author; SOP/frame reference', source('원영상/선택 이력 보존; 별도 영상 선택 서명 의무는 명시되지 않음'), images),
  'manual-sr': record('ManualSr.authorSub; immutable DICOM bytes', clinical, images),
  'external-sr-seg': record('External DICOM producer; unchanged bytes', source('원작성자·원서명 증거를 보존하고 재서명/재해석하지 않음; 원자료를 새 진료기록으로 기재할 때 별도 서명'), images),
  'comparison-layout': record('ViewerJob.authorSub; image placement only', unsigned('배치만 있는 운영 기록; 임상 문구는 comparison-description으로 함께 분류'), [], 'operational-record', 'purpose', ['owner-deleted']),
  'comparison-description': record('ViewerJob/ViewerJobRevision clinical title/description/actor', clinical, chart),
  'study-correction': record('StudyState.ov/orig; immutable modifying actor', conditional('정정 이력 자체의 별도 서명 의무는 명시되지 않음; 서명된 진료 기재를 정정하면 새 서명판 필요'), [], 'emr-candidate', 'source-record'),
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
  order: record('RIS origin/requesting clinician', clinical, chart),
  dictation: record('Radiologist; preserved voice/transcript versions', conditional('개인 음성 초안 자체의 별도 서명 의무는 명시되지 않음; 진료기록으로 기재할 때 서명'), [], 'emr-candidate', 'purpose', ['report-approved', 'report-finalized', 'explicit-discard']),
  assignment: record('ReaderAssignment.changedBy; allocation only', unsigned('업무 배정'), [], 'operational-record', 'purpose', ['assignment-ended']),
  preferences: record('Account/site setting author', unsigned('필터·배치 설정만; 환자 임상 문구가 있으면 임상 종류로 추가 분류'), [], 'operational-record', 'purpose', ['setting-replaced', 'owner-deleted']),
  'reading-template': record('ReadingTemplate.owner', unsigned('환자 없는 문구 양식; 환자별 채택 내용은 서명된 임상 기재'), [], 'operational-record', 'purpose', ['owner-deleted']),
  'study-organization': record('StudyTagCatalog.ownerSub; FavoriteWorkspace.subject', conditional('분류표/즐겨찾기 동작 자체는 서명 의무 없음; 임상 기재로 채택하면 해당 종류로 분류'), [], 'emr-candidate', 'purpose', ['owner-deleted']),
  'identity-access': record('Keycloak/member/StudyAccessRevision author', unsigned('권한 부여 증거; 진료기록 서명과 구분'), [], 'operational-record', 'purpose', ['assignment-ended']),
  'authentication-session': record('Authentication service; no credential copying', unsigned('인증 상태; 종료한 비밀은 의무기록 보존 대상에서 제외'), [], 'operational-record', 'purpose', ['session-ended']),
  institution: record('Institution administrator', unsigned('기관 설정'), [], 'operational-record', 'purpose', ['institution-closed']),
  'transfer-governance': record('TransferBasis/ProcessingAgreement/Transfer author', unsigned('법 제23조①의 진료기록 서명과 별개; 전송 근거·동의 계약은 유지'), [], 'evidence-record', 'purpose', ['transfer-obligations-ended']),
  'delivery-receipt': record('Gateway/service/request actor; fixed source reference', unsigned('전달 결과 증거; 원기록 서명 보존'), [FLOOR.access], 'evidence-record'),
  'system-operation': record('System process; health/statistics/accounting', unsigned('운영 상태'), [], 'operational-record', 'purpose', ['operation-completed']),
});
export type RecordKind = keyof typeof RECORD_CLASSIFICATION;

/** Multi-kind rows deliberately retain mixed clinical/operational content. */
export const MODEL_CLASSIFICATION: Readonly<Record<string, readonly RecordKind[]>> = freeze({
  AuthSession: ['authentication-session'], Institution: ['institution'],
  StudyState: ['study-metadata', 'study-correction', 'patient-match', 'assignment'],
  GatewayReceipt: ['delivery-receipt'], GatewayRetryRequest: ['delivery-receipt'],
  TechNoteRevision: ['tech-note'], TransferBasis: ['transfer-governance'], ProcessingAgreement: ['transfer-governance'], Transfer: ['transfer-governance', 'patient-match'],
  Report: ['report-head'], ReportDraft: ['private-draft', 'report-evidence'], ReportVersion: ['report-version', 'report-evidence'], Order: ['order', 'patient-match'],
  UserFilterCollection: ['preferences'], SharedFilterLibrary: ['preferences'], UserFilter: ['preferences'], ReadingTemplate: ['reading-template'],
  AuditLog: ['access-audit'], ViewerItem: ['measurement', 'key-image'], ViewerRevision: ['measurement', 'key-image'], ManualSr: ['manual-sr'],
  ViewerStorageBudget: ['system-operation'], ViewerRequest: ['delivery-receipt'], Finding: ['finding'], FindingRevision: ['finding'],
  WorklistColumns: ['preferences'], ReadingPreferences: ['preferences'], ReadingAppearance: ['preferences'], WorkspaceLayout: ['preferences'],
  StudyTagCatalog: ['study-organization'], FavoriteWorkspace: ['study-organization'],
  ViewerJob: ['comparison-layout', 'comparison-description'], ViewerJobRevision: ['comparison-description'], ReaderAssignment: ['assignment'],
  WorkspaceShortcuts: ['preferences'], StudyConsultation: ['consultation'], StudyQuestion: ['clinical-question'], StudyQuestionEntry: ['clinical-question', 'clinical-answer'],
  StudyImageRequest: ['image-request'], StudyImageRequestReceipt: ['delivery-receipt', 'image-request'],
  CriticalResult: ['critical-result', 'report-version'], CriticalResultEvent: ['critical-result', 'critical-result-ack'], CriticalResultReceipt: ['delivery-receipt', 'critical-result-ack'],
  HangingProtocolPreference: ['preferences'], StudyAccessPolicy: ['identity-access'], StudyAccessRevision: ['identity-access'],
});

export function classifyModel(name: string): readonly RecordKind[] {
  if (!Object.prototype.hasOwnProperty.call(MODEL_CLASSIFICATION, name)) throw new Error(`Unclassified model: ${name}`);
  return MODEL_CLASSIFICATION[name];
}
