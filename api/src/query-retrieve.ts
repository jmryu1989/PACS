/*
 * FC-070 Query/Retrieve: the pure rules of searching another PACS and pulling a study from it. No I/O here; the
 * service (query-retrieve.service.ts) calls Orthanc and the database. Each rule is the screen's wording where the screen
 * shows it, so a refusal reads the same in the panel, the admin page and the tests.
 */
import { BadRequestException } from '@nestjs/common';

export const QR_MESSAGES = Object.freeze({
  noPeer: '등록된 상대 PACS가 없습니다 — 관리자가 Members ▸ DICOM Peers에서 등록합니다',
  criteria: '환자번호·이름·접수번호·검사일 중 하나는 넣어야 합니다',
  truncated: '200건까지만 보입니다 — 조건을 좁히세요',
  peerNotFound: '상대 PACS를 찾을 수 없습니다',
  studyNotFound: '이 상대 PACS의 검색 결과에 없는 검사입니다 — 다시 검색하세요',
  jobNotFound: '가져오기 작업을 찾을 수 없습니다',
  connect: (name: string) => `상대 PACS(${name})에 연결하지 못했습니다`,
  refused: (status: string) => `상대 PACS가 요청을 거절했습니다 (${status})`,
  moveFailed: (aet: string) => `가져오지 못했습니다 — 상대 PACS에 HALO PACS(AE ${aet})가 목적지로 등록돼 있는지 확인하세요`,
  partial: '일부만 받았습니다',
  held: '보낸 장비가 등록되지 않아 보류됐습니다. 관리자가 Held Studies에서 등록합니다',
  notOpenable: '도착했지만 이 계정의 목록에서 열 수 없는 검사입니다',
});

/** The display and response cap of one search (not a limit put on the peer's own search). */
export const QR_ROW_CAP = 200;

const STUDY_UID = /^[0-9]+(?:\.[0-9]+)*$/;
export function isStudyUid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && STUDY_UID.test(value);
}

/** Orthanc's modality key of one peer: `kin-<institution>-<peer id>`, unique per institution and peer. */
export function peerKey(institutionId: string, peerId: string) {
  return `kin-${institutionId}-${peerId}`;
}

/**
 * What Orthanc is told about a peer, every time it is used. Every Allow* is written out: a registered modality's
 * defaults let it query and pull from this archive, which several institutions share - the peer only sends to us
 * (C-STORE, the C-MOVE answer) and may answer an echo.
 */
export function modalityBody(peer: { aet: string; host: string; port: number }) {
  return { AET: peer.aet, Host: peer.host, Port: peer.port,
    AllowEcho: true, AllowStore: true, AllowFind: false, AllowFindWorklist: false, AllowGet: false, AllowMove: false };
}

// ── peer registration (admin) ──
const AET = /^[\x21-\x5b\x5d-\x7e](?:[\x20-\x5b\x5d-\x7e]{0,14}[\x21-\x5b\x5d-\x7e])?$/;   // DICOM AE: 16 chars, no backslash or control
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

const PEER_FILM_SIZES = ['8INX10IN', '10INX12IN', '11INX14IN', '14INX17IN'];

/**
 * `{ name, aet, host, port, kind?, filmSizes? }` from the admin form → the row's values. Throws 400 with the admin page's
 * wording. `kind` is `store` (another PACS or modality; the default) or `printer` (a DICOM film printer, with the film
 * sizes it takes - none chosen = every size).
 */
export function normalizePeer(body: any): { name: string; aet: string; host: string; port: number; kind: string; filmSizes: string } {
  if (!body || typeof body !== 'object') throw new BadRequestException('상대 PACS 요청 형식이 잘못되었습니다');
  const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  const name = text(body.name), aet = text(body.aet), host = text(body.host);
  const port = typeof body.port === 'string' && /^\d+$/.test(body.port.trim()) ? Number(body.port.trim()) : body.port;
  if (!name || name.length > 64) throw new BadRequestException('이름은 1~64자로 넣어야 합니다');
  if (!AET.test(aet)) throw new BadRequestException('AE Title은 1~16자(역슬래시·제어 문자 없이)로 넣어야 합니다');
  if (host.length > 253 || !HOST.test(host)) throw new BadRequestException('Host는 호스트 이름이나 IPv4 주소로 넣어야 합니다');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequestException('Port는 1~65535의 정수여야 합니다');
  const kind = body.kind == null || body.kind === '' ? 'store' : body.kind;
  if (kind !== 'store' && kind !== 'printer') throw new BadRequestException('종류는 PACS·장비(store) 또는 필름 프린터(printer)여야 합니다');
  const sizes = body.filmSizes == null ? [] : body.filmSizes;
  if (!Array.isArray(sizes) || sizes.some((s: unknown) => !PEER_FILM_SIZES.includes(s as string)) || (kind === 'store' && sizes.length))
    throw new BadRequestException('필름 크기는 필름 프린터에만 8INX10IN·10INX12IN·11INX14IN·14INX17IN 중에서 고릅니다');
  return { name, aet, host, port, kind, filmSizes: PEER_FILM_SIZES.filter(s => sizes.includes(s)).join(',') };
}

// ── search criteria ──
export type SearchCriteria = {
  peerId: string;
  /** The C-FIND identifier sent to the peer (empty values ask the peer to return that attribute). */
  query: Record<string, string>;
  /** The names of the criteria the caller filled in (the audit keeps these, never their values). */
  fields: string[];
};

const meaningful = (value: string) => value.replace(/[*?]/g, '').trim();

function dicomDate(value: unknown, label: string): string {
  if (value == null || value === '') return '';
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  if (!match || !date || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3])
    throw new BadRequestException(`${label}는 YYYY-MM-DD 날짜여야 합니다`);
  return match[1] + match[2] + match[3];
}

function bounded(value: unknown, max: number, label: string): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new BadRequestException(`${label} 형식이 잘못되었습니다`);
  const trimmed = value.trim();
  if (trimmed.length > max || /[\\\x00-\x1f]/.test(trimmed)) throw new BadRequestException(`${label}는 ${max}자 이내여야 합니다`);
  return trimmed;
}

/**
 * The search form → the peer's C-FIND identifier (Study level). One of patient ID, patient name (two characters or
 * more), accession number or study date must carry a value that is not only blanks and wildcards (`*`, `?`); the
 * modality alone narrows nothing enough. Wildcards are passed as typed (DICOM matching).
 */
export function searchCriteria(body: any): SearchCriteria {
  if (!body || typeof body !== 'object' || typeof body.peerId !== 'string' || !body.peerId)
    throw new BadRequestException('검색 요청 형식이 잘못되었습니다');
  const patientId = bounded(body.patientId, 64, '환자번호');
  const patientName = bounded(body.patientName, 64, '이름');
  const accession = bounded(body.accession, 16, '접수번호');
  const modality = bounded(body.modality, 16, 'Modality').toUpperCase();
  if (modality && !/^[A-Z0-9_ ]+$/.test(modality)) throw new BadRequestException('Modality는 영문 대문자·숫자여야 합니다');
  const from = dicomDate(body.studyDateFrom, '검사일(시작)'), to = dicomDate(body.studyDateTo, '검사일(끝)');
  if (from && to && from > to) throw new BadRequestException('검사일의 시작이 끝보다 늦습니다');
  const fields: string[] = [];
  if (meaningful(patientId)) fields.push('patientId');
  if (meaningful(patientName).length >= 2) fields.push('patientName');
  if (meaningful(accession)) fields.push('accession');
  if (from || to) fields.push('studyDate');
  if (!fields.length) throw new BadRequestException(QR_MESSAGES.criteria);
  if (modality) fields.push('modality');
  const studyDate = from || to ? `${from}-${to}` : '';
  return { peerId: body.peerId, fields, query: {
    PatientID: patientId, PatientName: patientName, AccessionNumber: accession, StudyDate: studyDate,
    ModalitiesInStudy: modality, StudyInstanceUID: '', StudyDescription: '', NumberOfStudyRelatedInstances: '',
  } };
}

export type SearchRow = {
  studyUid: string; patientId: string; patientName: string; studyDate: string; modality: string;
  description: string; accession: string; instances: number | null;
};

/**
 * Orthanc's expanded, simplified answers (`GET /queries/{id}/answers?expand&simplify`: one object per answer keyed by
 * tag name) → the rows, one per Study Instance UID in the peer's order. An answer without a usable UID cannot be
 * retrieved and is left out.
 */
export function answerRows(answers: unknown): SearchRow[] {
  if (!Array.isArray(answers)) throw new Error('answers');
  const text = (v: unknown) => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(x => typeof x === 'string').join('\\') : '';
  const rows: SearchRow[] = [], seen = new Set<string>();
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') continue;
    const a = answer as Record<string, unknown>, studyUid = text(a.StudyInstanceUID).trim();
    if (!isStudyUid(studyUid) || seen.has(studyUid)) continue;
    seen.add(studyUid);
    const count = text(a.NumberOfStudyRelatedInstances).trim();
    rows.push({ studyUid, patientId: text(a.PatientID), patientName: text(a.PatientName).replace(/\^/g, ' ').trim(),
      studyDate: text(a.StudyDate), modality: text(a.ModalitiesInStudy).split('\\').map(m => m.trim()).filter(Boolean).join(','),
      description: text(a.StudyDescription), accession: text(a.AccessionNumber),
      instances: /^\d+$/.test(count) ? Number(count) : null });
  }
  return rows;
}

/**
 * A failed Orthanc call towards the peer, read from Orthanc's error answer: a DIMSE status in its text is the peer's
 * refusal (`0xA700`), anything else is a failure to reach the peer. Orthanc 1.12.5 words a refusal
 * `C-FIND SCU to AET "…" has failed with DIMSE status 0x…`.
 */
export function peerFailure(body: unknown): { kind: 'refused'; status: string } | { kind: 'connect' } {
  const parts = body && typeof body === 'object'
    ? ['Details', 'Message', 'OrthancError'].map(key => (body as any)[key]).filter(v => typeof v === 'string') : typeof body === 'string' ? [body] : [];
  const status = /DIMSE status (0x[0-9A-F]{4})/i.exec(parts.join(' '));
  return status ? { kind: 'refused', status: '0x' + status[1].slice(2).toUpperCase() } : { kind: 'connect' };
}

export type JobState = 'pending' | 'running' | 'arrived' | 'held' | 'failed';
export type JobAnswer = { state: JobState; progress: number; reason: string | null };

/**
 * One retrieve's answer from Orthanc's job and what arrived. `arrival` is read only once the job has ended:
 * `count` instances of the study are in this archive now (before the retrieve: `before`), `expected` is what the peer's
 * answer said the study holds (null = it did not say), `openable` = the caller's list can open it, `held` = no hospital
 * is decided for it (D1882). Arrived is never the job's success alone.
 */
export function jobAnswer(job: any, arrival: { count: number; before: number; expected: number | null; openable: boolean; held: boolean } | null,
  ourAet: string): JobAnswer {
  const progress = Number.isFinite(job?.Progress) ? Math.max(0, Math.min(100, Math.round(job.Progress))) : 0;
  const state = job?.State;
  if (state === 'Pending' || state === 'Paused' || state === 'Retry') return { state: 'pending', progress, reason: null };
  if (state === 'Running') return { state: 'running', progress, reason: null };
  if (state !== 'Success' && state !== 'Failure') throw new Error('job state');
  if (!arrival) throw new Error('arrival');
  const received = arrival.count > arrival.before;
  // Orthanc 1.12.5 fails a C-MOVE whose final status is a warning (some sub-operations failed): what came is partial.
  if (state === 'Failure') return received ? { state: 'failed', progress: 100, reason: QR_MESSAGES.partial }
    : { state: 'failed', progress: 100, reason: QR_MESSAGES.moveFailed(ourAet) };
  if (arrival.count === 0) return { state: 'failed', progress: 100, reason: QR_MESSAGES.moveFailed(ourAet) };
  if (arrival.expected !== null && arrival.count < arrival.expected) return { state: 'failed', progress: 100, reason: QR_MESSAGES.partial };
  if (arrival.held) return { state: 'held', progress: 100, reason: QR_MESSAGES.held };
  if (!arrival.openable) return { state: 'failed', progress: 100, reason: QR_MESSAGES.notOpenable };
  return { state: 'arrived', progress: 100, reason: null };
}
