import { freeze } from './validation';

/** Publication identifiers survive upstream history rewrites. Dates are legal metadata, not delivery deadlines. */
export const LEGAL_SOURCES = freeze({
  medicalCurrent: { path: 'legalize-kr/kr/의료법/법률.md', mst: '285327', publication: '21524',
    publishedAt: '2026-04-07', effectiveAt: '2026-04-07', verification: '본문 확인' },
  medicalAmended: { path: 'legalize-kr/kr/의료법/법률.md', mst: '286719', publication: '21776',
    publishedAt: '2026-06-09', effectiveAt: '2026-12-10', verification: '본문·부칙 확인' },
  medicalRules: { path: 'legalize-kr/kr/의료법/시행규칙.md', mst: '286963', publication: '01177',
    publishedAt: '2026-06-12', effectiveAt: '2026-06-12', verification: '본문 확인' },
  privacy: { path: 'legalize-kr/kr/개인정보보호법/법률.md', mst: '283839', publication: '21445',
    publishedAt: '2026-03-10', effectiveAt: '2026-09-11', verification: '본문 확인' },
  privacyAmended: { path: 'legalize-kr/kr/개인정보보호법/법률.md', mst: '289415', publication: '21910',
    publishedAt: '2026-09-08', effectiveAt: '2027-03-09', verification: '최신 공포본 제3·15·21·58조 본문 확인; 시행 예정' },
  privacyDecree: { path: 'legalize-kr/kr/개인정보보호법/시행령.md', mst: '289537', publication: '36671',
    publishedAt: '2026-09-10', effectiveAt: '2026-09-11', verification: '제16조①1 본문 확인' },
  accessSafety: { path: 'admrule-kr/국무총리/개인정보보호위원회/고시/개인정보의 안전성 확보조치 기준/본문.md', mst: '2100000281400', publication: '2026-9',
    publishedAt: '2026-07-01', effectiveAt: '2026-07-01', verification: '제8조 본문·시행일자 확인; 부칙 원문 미확인' },
  emrEquipment: { path: 'admrule-kr/보건복지부/_본부/고시/전자의무기록의 관리·보존에 필요한 시설과 장비에 관한 기준/본문.md',
    mst: '2100000232676', publication: '2023-245', publishedAt: '2023-12-14', effectiveAt: '2023-12-14',
    verification: '제2조·제3조·제4조·제5조·제6조 본문 확인; 별표·부칙 원문 미확인' },
});

export interface StatutoryMinimum { years: number; basis: string; scope: string; verification: string }
export const STATUTORY_MINIMUM = freeze({
  chart: { years: 10, basis: '의료법 시행규칙 제15조①2', scope: '진료기록부', verification: '본문 확인' },
  prescription: { years: 2, basis: '의료법 시행규칙 제15조①3', scope: '처방전', verification: '본문 확인' },
  surgery: { years: 10, basis: '의료법 시행규칙 제15조①4', scope: '수술기록', verification: '본문 확인' },
  examination: { years: 5, basis: '의료법 시행규칙 제15조①5', scope: '검사내용 및 검사소견기록', verification: '본문 확인' },
  imageReport: { years: 5, basis: '의료법 시행규칙 제15조①6', scope: '방사선 사진(영상물 포함) 및 그 소견서', verification: '본문 확인' },
  patientRegister: { years: 5, basis: '의료법 시행규칙 제15조①1', scope: '환자 명부', verification: '본문 확인' },
  nursing: { years: 5, basis: '의료법 시행규칙 제15조①7', scope: '간호기록부', verification: '본문 확인' },
  midwifery: { years: 5, basis: '의료법 시행규칙 제15조①8', scope: '조산기록부', verification: '본문 확인' },
  certificateCopy: { years: 3, basis: '의료법 시행규칙 제15조①9', scope: '진단서 등의 부본', verification: '본문 확인' },
  access: { years: 2, basis: '개인정보의 안전성 확보조치 기준 제8조①2', scope: '민감정보 처리 시스템 접속기록',
    verification: '본문 확인' },
} satisfies Record<string, StatutoryMinimum>);
