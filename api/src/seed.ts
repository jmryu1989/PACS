/**
 * RIS(HRIS) 오더 시드. 4~5단계에서 HL7 v2 ORM 메시지 수신으로 교체된다.
 * 날짜는 서버가 처음 뜬 날로 잡는다 — 데모에서 "오늘 오더"로 보이게 하려고.
 */
const d = new Date().toISOString().slice(0, 10);

export const SEED_ORDERS = [
  { oid: 'O-9001', patientId: 'P-1001', name: 'KIM CHULSOO',  sex: 'M', birth: '1962-03-04', sched: `${d} 09:10`, modality: 'CT', descr: 'Brain CT without contrast', ward: 'NR',  reqDoc: 'PARK MD' },
  { oid: 'O-9002', patientId: 'P-1002', name: 'LEE YOUNGHEE', sex: 'F', birth: '1975-11-22', sched: `${d} 09:40`, modality: 'CT', descr: 'Brain CT with contrast',    ward: 'ER',  reqDoc: 'KIM MD' },
  { oid: 'O-9003', patientId: 'P-2001', name: 'HAN JIWOO',    sex: 'F', birth: '1990-07-14', sched: `${d} 10:05`, modality: 'CT', descr: 'Brain CT screening',       ward: 'OPD', reqDoc: 'CHOI MD' },
  { oid: 'O-9004', patientId: 'P-2002', name: 'OH SEUNGMIN',  sex: 'M', birth: '1984-01-30', sched: `${d} 10:30`, modality: 'CR', descr: 'Chest PA',                 ward: 'OPD', reqDoc: 'KIM MD' },
  { oid: 'O-9005', patientId: 'P-2003', name: 'SEO YUNA',     sex: 'F', birth: '2001-09-02', sched: `${d} 11:00`, modality: 'CT', descr: 'Brain CT f/u',             ward: 'NR',  reqDoc: 'PARK MD' },
  { oid: 'O-9006', patientId: 'P-2004', name: 'BAEK DOYUN',   sex: 'M', birth: '1958-12-19', sched: `${d} 11:25`, modality: 'US', descr: 'Abdominal US',             ward: 'GI',  reqDoc: 'LEE MD' },
];
