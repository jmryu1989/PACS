/**
 * 시드 데이터.
 *
 * 기관은 4~5단계에서 관리 화면으로 등록하게 되지만, 지금은 두 개를 코드로 박는다.
 * dicomNames는 DICOM InstitutionName(0008,0080)에 실제로 찍혀 오는 문자열들이다 —
 * 장비마다 표기가 달라서 별칭이 여러 개 붙는다.
 */
export const SEED_INSTITUTIONS = [
  {
    id: 'hallym',
    name: '한림병원',
    type: 'hospital',
    dicomNames: '한림병원,HALLYM,Hallym Hospital,KIN',
  },
  {
    id: 'kin-center',
    name: 'KIN 판독센터',
    type: 'reading-center',
    dicomNames: 'KIN 판독센터,KIN Reading Center,KINLAB',
  },
];

/**
 * 새 계정이 처음 로그인했을 때 넣어주는 판독 상용구.
 *
 * 빈 목록으로 시작하면 "이게 뭐 하는 칸이지"가 되고, 그러면 아무도 안 쓴다.
 * HPACS도 "신규계정인 경우 Reading Template 생성이 되지 않았던 오류"를 고친 적이 있다
 * (릴리즈노트) — 빈 상태로 두면 버그 취급을 받는다는 뜻이다.
 *
 * 여기 있는 건 출발점일 뿐이고, 판독의는 곧 자기 문장으로 갈아치운다. 그게 정상이다.
 */
export const SEED_TEMPLATES = [
  {
    title: 'Normal Brain CT', shortcut: 'nbct', modality: 'CT', bodypart: 'Head', ord: 1,
    findings: 'No evidence of acute intracranial hemorrhage.\nNo mass effect or midline shift.\nVentricles and sulci are within normal limits.',
    conclusion: 'No acute intracranial abnormality.', recommendation: '',
  },
  {
    title: 'Brain CT f/u nodule', shortcut: 'fu', modality: 'CT', bodypart: 'Head', ord: 2,
    findings: 'Known hyperdense nodule in right frontal region.\nNo interval change in size.\nNo new lesion.',
    conclusion: 'Stable known nodule. No interval change.', recommendation: '',
  },
  {
    title: 'Screening', shortcut: 'scr', modality: '', bodypart: '', ord: 3,
    findings: 'Screening examination.\n', conclusion: '', recommendation: '',
  },
];

/**
 * RIS(HRIS) 오더 시드. 4~5단계에서 HL7 v2 ORM 메시지 수신으로 교체된다.
 * 날짜는 서버가 처음 뜬 날로 잡는다 — 데모에서 "오늘 오더"로 보이게 하려고.
 *
 * 오더는 기관을 넘지 않는다. 각 병원의 RIS가 따로 돌기 때문 —
 * 한림병원 기사에게 판독센터 오더가 보이면 그건 데이터가 새는 것이다.
 * (HPACS 2021.11: "SCP 기관 사용자에게 Order List가 안 보이던 오류" — 반대 방향의 같은 문제)
 */
const d = new Date().toISOString().slice(0, 10);

export const SEED_ORDERS = [
  { oid: 'O-9001', institutionId: 'hallym',     patientId: 'P-1001', name: 'KIM CHULSOO',  sex: 'M', birth: '1962-03-04', sched: `${d} 09:10`, modality: 'CT', descr: 'Brain CT without contrast', ward: 'NR',  reqDoc: 'PARK MD' },
  { oid: 'O-9002', institutionId: 'hallym',     patientId: 'P-1002', name: 'LEE YOUNGHEE', sex: 'F', birth: '1975-11-22', sched: `${d} 09:40`, modality: 'CT', descr: 'Brain CT with contrast',    ward: 'ER',  reqDoc: 'KIM MD' },
  { oid: 'O-9003', institutionId: 'hallym',     patientId: 'P-2001', name: 'HAN JIWOO',    sex: 'F', birth: '1990-07-14', sched: `${d} 10:05`, modality: 'CT', descr: 'Brain CT screening',       ward: 'OPD', reqDoc: 'CHOI MD' },
  { oid: 'O-9004', institutionId: 'hallym',     patientId: 'P-2002', name: 'OH SEUNGMIN',  sex: 'M', birth: '1984-01-30', sched: `${d} 10:30`, modality: 'CR', descr: 'Chest PA',                 ward: 'OPD', reqDoc: 'KIM MD' },
  { oid: 'O-9005', institutionId: 'kin-center', patientId: 'P-2003', name: 'SEO YUNA',     sex: 'F', birth: '2001-09-02', sched: `${d} 11:00`, modality: 'CT', descr: 'Brain CT f/u',             ward: 'NR',  reqDoc: 'PARK MD' },
  { oid: 'O-9006', institutionId: 'kin-center', patientId: 'P-2004', name: 'BAEK DOYUN',   sex: 'M', birth: '1958-12-19', sched: `${d} 11:25`, modality: 'US', descr: 'Abdominal US',             ward: 'GI',  reqDoc: 'LEE MD' },
];
