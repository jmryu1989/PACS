/*
 * S7-U4b Clinical Context — the pure client model of the reading screen's panel (contract S7-U4p §7, §7.1, §8.1, §9.1, §10).
 * REQ-S7-U4b-PANEL → RISK-S7-U4b-STALE-PANEL / RISK-S7-U4b-FAIL-AS-EMPTY → TEST-S7-U4b-MODEL (tests/clinical_context_model_test.cjs)
 * and TEST-S7-U4b-DOM (tests/clinical_context_dom_test.py).
 *
 * No DOM, storage, network, timers or session here: main.html asks, keeps the request generation and paints what view()
 * returns with textContent only. The closed-shape check is the screen's own copy of the server's (§9.1 "the screen runs
 * the same check"); the model test holds both to one set of answer vectors, so a key added on one side fails there.
 * Nothing here decides anything clinical: the panel shows signed prior reports, exam history, DICOM request tags and the
 * Tech Note meta as the server read them, with where and when each value came from.
 */
(function (root) {
  'use strict';

  const SCHEMA = 'kin.clinical-context/1';
  const SECTIONS = Object.freeze(['priorReports', 'history', 'requestTags', 'techNote']);
  const SOURCE_LABELS = Object.freeze({
    priorReports: 'KIN signed report (head version)', history: 'DICOM study + KIN study state',
    requestTags: 'DICOM header (one original instance)', techNote: 'KIN Tech Note',
  });
  const KINDS = Object.freeze({
    priorReports: 'kin.report-version', history: 'dicom.study+kin.study-state',
    requestTags: 'dicom.instance-header', techNote: 'kin.tech-note',
  });
  // The five request tags in their fixed order (§5.4); `checked` lists their codes in this order.
  const TAGS = Object.freeze([
    Object.freeze({ tag: '00321030', keyword: 'ReasonForStudy', vr: 'LO' }),
    Object.freeze({ tag: '00401002', keyword: 'ReasonForTheRequestedProcedure', vr: 'LO' }),
    Object.freeze({ tag: '001021B0', keyword: 'AdditionalPatientHistory', vr: 'LT' }),
    Object.freeze({ tag: '00081080', keyword: 'AdmittingDiagnosesDescription', vr: 'LO' }),
    Object.freeze({ tag: '00324000', keyword: 'StudyComments', vr: 'LT' }),
  ]);
  const TAG_CODES = TAGS.map(item => item.tag);
  const TAG_MAX_CHARS = 10240;
  // Response size bounds (CS-07), not clinical thresholds: a full section says so with `truncated`.
  const LIMITS = Object.freeze({ priorReports: 10, history: 200, requestTags: TAGS.length, techNote: 1 });
  const SOURCE_FAILURES = ['source_unavailable', 'source_invalid', 'source_row_missing'];
  const REASONS = Object.freeze({
    priorReports: { not_configured: ['no_patient_key'], failed: SOURCE_FAILURES },
    history: { not_configured: ['no_patient_key'], failed: SOURCE_FAILURES },
    requestTags: { not_configured: ['no_original_instance'], failed: SOURCE_FAILURES },
    techNote: { not_configured: [], failed: ['source_invalid'] },
  });
  const SECTION_KEYS = ['state', 'reason', 'sourceLabel', 'observedAt', 'truncated', 'items'];
  const KEYS = Object.freeze({
    answer: ['schema', 'uid', 'observedAt', 'patientKey', 'anchor', 'identity', 'sections'],
    anchor: ['access', 'institutionName', 'techNoteVersion'],
    identity: ['conflict', 'birth', 'sex'],
    sections: SECTIONS,
    section: SECTION_KEYS,
    requestTagsSection: SECTION_KEYS.concat(['checked']),
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
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const DICOM_UID = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))+$/;

  // Contract wording (§5.1, §5.4, §7, §7.1, §10, K-8). Controls, states and headings are English; explanations Korean.
  // The panel title, Refresh and the fixed scope sentence (§3.1) are main.html markup.
  const TEXT = Object.freeze({
    retry: 'Retry', loading: 'Loading…',
    noInformation: 'No clinical information provided.',
    sectionTitles: Object.freeze({ priorReports: 'Prior Reports', history: 'Exam History', requestTags: 'DICOM Request Tags',
      techNote: 'Tech Note' }),
    stateLabels: Object.freeze({ absent: 'None', not_configured: 'Not Configured', failed: 'Failed', stale: 'Stale' }),
    present: 'KIN이 {observedAt}에 읽은 값입니다. 출처: {sourceLabel}',
    absent: '이 출처에 해당 항목이 없습니다(확인 {observedAt}).',
    notConfigured: Object.freeze({
      no_patient_key: '이 검사의 원본 DICOM 환자 ID가 없어 같은 환자의 다른 검사를 찾지 않았습니다.',
      no_original_instance: '원본 영상 시리즈가 없어(SR·KO·PR·SEG만 있음) 요청 태그를 읽지 않았습니다. 요청 태그가 없다는 뜻이 아닙니다.',
    }),
    failed: '출처를 읽지 못했습니다. 값이 없다는 뜻이 아닙니다. 다시 시도하세요.',
    stale: '마지막으로 읽은 값입니다({observedAt}). 그 뒤 {cause}.',
    staleCauses: Object.freeze({ refresh_failed: '다시 읽기에 실패했습니다', list_changed: '목록에서 변경이 관측되었습니다' }),
    // One distinct sentence per closed reason (§7.1); the HTTP status and the server code follow when there are any.
    reasons: Object.freeze({
      source_unavailable: '원본(Orthanc) 연결이나 응답에 실패했습니다.',
      source_invalid: '원본 답의 형식이 계약의 규칙과 맞지 않았습니다.',
      source_row_missing: '원본(Orthanc)에 이 검사가 없습니다.',
      not_visible: '이 검사를 더 읽을 수 없습니다. 기관 배정·원격판독·접근 설정이 바뀌었을 수 있습니다.',
      forbidden: '이 계정의 역할로는 이 패널을 읽을 수 없습니다.',
      changed: '읽는 사이 검사 상태나 접근 조건이 바뀌었습니다. 다시 시도하세요.',
      busy: '서버가 지금 이 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.',
      network: '서버와 연결하지 못했습니다.',
      malformed: '서버 답의 모양을 확인할 수 없어 표시하지 않았습니다.',
    }),
    refreshFailed: '다시 읽기에 실패했습니다.',
    observedAnswer: '읽은 시각 {observedAt}',
    access: Object.freeze({
      owner: Object.freeze({ label: 'Owner', title: '소유 기관 권한으로 읽은 값입니다 · {institutionName}' }),
      tele: Object.freeze({ label: 'Tele',
        title: '원격판독 수신 권한으로 읽은 값입니다 · 소유 기관 {institutionName}. 원격판독이 닫히면 더 읽을 수 없습니다.' }),
    }),
    conflictTitle: 'Identity Conflict',
    conflict: '같은 환자 키로 묶인 검사 사이에 원본 DICOM {fields}이 서로 다릅니다. 같은 사람의 검사인지 확인한 뒤 비교하세요.',
    conflictFields: Object.freeze({ birth: '생년월일', sex: '성별', both: '생년월일·성별' }),
    marks: Object.freeze({ birth: 'Birth Date Mismatch', sex: 'Sex Mismatch' }),
    recordedAtNone: 'DICOM 헤더에는 기록 시각이 없습니다',
    tagNotes: Object.freeze({ not_text: '문자열이 아닌 값이라 표시하지 않습니다',
      too_long: '10240자를 넘어 표시하지 않습니다 — 잘라 보이지 않습니다' }),
    noText: '내용 비움',
    checked: '확인한 태그: {checked}',
    recorded: '기록 {time}',
    observed: '읽은 시각 {time}',
    signed: 'Signed', unsigned: '—',
    actions: Object.freeze({ approve: 'Approve', addendum: 'Addendum' }),
    bodies: Object.freeze([['findings', 'Findings'], ['conclusion', 'Conclusion'], ['recommendation', 'Recommendation']]),
    reportText: 'Report Text',
  });

  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.length > 0;
  const instant = value => typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
  const count = (value, min) => Number.isSafeInteger(value) && value >= min;
  const relation = value => typeof value === 'string' && RELATIONS.includes(value);
  const studyUid = value => typeof value === 'string' && value.length <= 64 && DICOM_UID.test(value);
  const fill = (template, values) => template.replace(/\{(\w+)\}/g, (all, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : all);
  const pad = value => String(value).padStart(2, '0');
  function localTime(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
      + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ── closed shape (§9.1). A violation names the path and the rule, never a value. ──
  function Violation(message) { this.message = message; }
  function check(condition, path, what) { if (!condition) throw new Violation(path + ': ' + what); }
  function keysExactly(value, keys, path) {
    check(record(value), path, 'not an object');
    const actual = Object.keys(value).sort(), expected = keys.slice().sort();
    check(actual.length === expected.length && actual.every((key, i) => key === expected[i]), path, 'keys differ from the closed shape');
    return value;
  }
  function provenance(value, path, kind) {
    const p = keysExactly(value, KEYS.provenance, path);
    check(p.kind === kind, path + '.kind', 'not the kind of this section');
    check(text(p.recordId), path + '.recordId', 'missing');
    check(instant(p.observedAt), path + '.observedAt', 'not an ISO instant');
    if (kind === KINDS.priorReports || kind === KINDS.techNote) {
      check(count(p.version, 1), path + '.version', 'missing');
      check(text(p.author), path + '.author', 'missing');
      check(instant(p.recordedAt), path + '.recordedAt', 'missing');
    } else if (kind === KINDS.history) {
      check(p.version === null && p.author === null, path, 'a study row has no version or author');
      check(instant(p.recordedAt), path + '.recordedAt', 'missing');
    } else {
      check(p.version === null && p.author === null && p.recordedAt === null, path, 'a header has no version, author or recording time');
    }
    return p;
  }
  function rowIdentity(value, path) {
    const identity = keysExactly(value, KEYS.rowIdentity, path);
    check(relation(identity.birth) && relation(identity.sex), path, 'not a relation');
  }
  function studyLabel(value, path, keys) {
    const study = keysExactly(value, keys, path);
    check(keys.every(key => typeof study[key] === 'string'), path, 'original DICOM values are strings');
  }
  function items(name, section, answer) {
    const path = 'sections.' + name, kind = KINDS[name], seen = new Set();
    section.items.forEach((value, i) => {
      const at = path + '.items[' + i + ']';
      if (name === 'priorReports') {
        const item = keysExactly(value, KEYS.priorItem, at);
        check(studyUid(item.studyUid) && item.studyUid !== answer.uid && !seen.has(item.studyUid), at + '.studyUid', 'not a distinct other study');
        seen.add(item.studyUid);
        check(item.access === answer.anchor.access, at + '.access', 'differs from anchor.access');
        studyLabel(item.study, at + '.study', KEYS.priorStudy);
        rowIdentity(item.identity, at + '.identity');
        const report = keysExactly(item.report, KEYS.report, at + '.report');
        check(count(report.version, 1) && (report.action === 'approve' || report.action === 'addendum'), at + '.report', 'not a signed head');
        check(['findings', 'conclusion', 'recommendation'].every(key => typeof report[key] === 'string'), at + '.report', 'body is not text');
        const p = provenance(item.provenance, at + '.provenance', kind);
        check(/^\d+$/.test(p.recordId) && p.version === report.version, at + '.provenance', 'not the head row');
      } else if (name === 'history') {
        const item = keysExactly(value, KEYS.historyItem, at);
        check(studyUid(item.studyUid) && item.studyUid !== answer.uid && !seen.has(item.studyUid), at + '.studyUid', 'not a distinct other study');
        seen.add(item.studyUid);
        check(item.access === answer.anchor.access, at + '.access', 'differs from anchor.access');
        check(item.institutionName === answer.anchor.institutionName, at + '.institutionName', 'differs from anchor.institutionName');
        studyLabel(item.study, at + '.study', KEYS.historyStudy);
        const reading = keysExactly(item.reading, KEYS.reading, at + '.reading');
        check(text(reading.rs) && typeof reading.signed === 'boolean' && count(reading.reportVersion, 0), at + '.reading', 'invalid');
        check(!reading.signed || (reading.rs === 'A' && reading.reportVersion > 0), at + '.reading', 'signed needs RS A and a head');
        rowIdentity(item.identity, at + '.identity');
        const p = provenance(item.provenance, at + '.provenance', kind);
        check(p.recordId === item.studyUid, at + '.provenance.recordId', 'not the study');
      } else if (name === 'requestTags') {
        const item = keysExactly(value, KEYS.requestTagItem, at);
        const tag = TAGS.find(t => t.tag === item.tag);
        check(!!tag && item.keyword === tag.keyword && item.vr === tag.vr && !seen.has(item.tag), at + '.tag', 'not one of the five tags');
        check(i === 0 || TAG_CODES.indexOf(item.tag) > TAG_CODES.indexOf(section.items[i - 1].tag), at + '.tag', 'out of the fixed order');
        seen.add(item.tag);
        check(typeof item.value === 'string'
          ? item.note === null && Array.from(item.value).length <= TAG_MAX_CHARS
          : item.value === null && (item.note === 'not_text' || item.note === 'too_long'), at + '.value', 'value and note disagree');
        const p = provenance(item.provenance, at + '.provenance', kind);
        const first = section.items[0].provenance;
        check(record(first) && p.recordId === first.recordId && p.observedAt === section.observedAt, at + '.provenance', 'not the one header read');
      } else {
        const item = keysExactly(value, KEYS.techNoteItem, at);
        check(count(item.version, 1) && typeof item.hasText === 'boolean', at, 'invalid');
        const p = provenance(item.provenance, at + '.provenance', kind);
        check(p.recordId === answer.uid + '#' + item.version && p.version === item.version, at + '.provenance', 'not this note version');
      }
    });
  }
  function section(name, value, answer) {
    const path = 'sections.' + name;
    const s = keysExactly(value, name === 'requestTags' ? KEYS.requestTagsSection : KEYS.section, path);
    check(['present', 'absent', 'not_configured', 'failed'].includes(s.state), path + '.state', 'not a section state');
    const reasons = s.state === 'not_configured' || s.state === 'failed' ? REASONS[name][s.state] : [null];
    check(reasons.includes(s.reason), path + '.reason', 'not in the closed list');
    check(s.sourceLabel === SOURCE_LABELS[name], path + '.sourceLabel', 'not the fixed label');
    check(s.state === 'not_configured' && s.reason === 'no_patient_key' ? s.observedAt === null : instant(s.observedAt),
      path + '.observedAt', 'null only when the source was not read for want of a patient key');
    check(Array.isArray(s.items) && typeof s.truncated === 'boolean', path, 'items or truncated');
    check(s.state === 'present' ? s.items.length >= 1 && s.items.length <= LIMITS[name] : s.items.length === 0, path + '.items', 'count does not fit the state');
    check(!s.truncated || (s.state === 'present' && s.items.length === LIMITS[name]), path + '.truncated', 'only a full present section is cut');
    if (name === 'requestTags') {
      const read = s.state === 'present' || s.state === 'absent';
      check(Array.isArray(s.checked) && s.checked.length === (read ? TAG_CODES.length : 0)
        && s.checked.every((tag, i) => tag === TAG_CODES[i]), path + '.checked', 'the five tags only when a header was read');
    }
    if (name === 'priorReports' || name === 'history') {
      check(s.state === 'not_configured' ? answer.patientKey === null : s.state === 'failed' || answer.patientKey !== null,
        path, 'state and patientKey disagree');
    }
    // Items are shape-checked before any comparison reads them: a null item must be refused, not throw out of shapeError()
    // and leave the panel mid-read (Astra S7-U4b-R-001 F01).
    items(name, s, answer);
    if (name === 'techNote') {
      check(s.state !== 'present' || s.items[0].version === answer.anchor.techNoteVersion, path, 'differs from anchor.techNoteVersion');
      check(s.state !== 'absent' || answer.anchor.techNoteVersion === 0, path, 'absent needs anchor.techNoteVersion 0');
    }
  }
  /** null when the answer has exactly the closed shape of §9.1 and its value rules, otherwise the path and the rule broken. */
  function shapeError(value) {
    try {
      const answer = keysExactly(value, KEYS.answer, 'answer');
      check(answer.schema === SCHEMA, 'schema', 'not this schema');
      check(studyUid(answer.uid), 'uid', 'not a study UID');
      check(instant(answer.observedAt), 'observedAt', 'not an ISO instant');
      check(answer.patientKey === null || text(answer.patientKey), 'patientKey', 'not a key');
      const anchor = keysExactly(answer.anchor, KEYS.anchor, 'anchor');
      check(anchor.access === 'owner' || anchor.access === 'tele', 'anchor.access', 'not a permission basis');
      check(typeof anchor.institutionName === 'string' && count(anchor.techNoteVersion, 0), 'anchor', 'invalid');
      const identity = keysExactly(answer.identity, KEYS.identity, 'identity');
      check(relation(identity.birth) && relation(identity.sex), 'identity', 'not a relation');
      check(identity.conflict === (identity.birth === 'mismatch' || identity.sex === 'mismatch'), 'identity.conflict', 'disagrees with the relations');
      const sections = keysExactly(answer.sections, KEYS.sections, 'sections');
      for (const name of SECTIONS) section(name, sections[name], answer);
      return null;
    } catch (error) {
      if (error instanceof Violation) return error.message;
      throw error;
    }
  }

  // ── states (§7) ──
  const readable = state => state === 'present' || state === 'absent';
  /** Display state per section: the server's, except that a section read before (present, absent) shows Stale while marked. */
  function states(answer, stale) {
    const marks = stale || {}, out = {};
    for (const name of SECTIONS) {
      const state = answer.sections[name].state;
      out[name] = readable(state) && marks[name] ? 'stale' : state;
    }
    return out;
  }
  /** "No clinical information provided." only when all four sections were read and are empty, and none is stale. */
  function noInformation(answer, stale) {
    const shown = states(answer, stale);
    return SECTIONS.every(name => shown[name] === 'absent');
  }

  // ── whole-answer failures (§7.1; OP-1 decided by D172 for the statuses §7.1 does not name) ──
  function failure(error) {
    const status = Number.isSafeInteger(error && error.status) ? error.status : null;
    const code = error && typeof error.code === 'string' && error.code ? error.code : null;
    let reason;
    if (status === 404) reason = 'not_visible';
    else if (status === 403) reason = 'forbidden';
    else if (status === 409) reason = 'changed';
    else if (status === 503) reason = 'busy';
    else if (status !== null && status >= 500) reason = 'network';      // OP-1: 500, 502, 504 ... read like a lost connection
    else if (status !== null) reason = 'malformed';                     // OP-1: 400 and the other 4xx
    else if (error && error.name === 'SyntaxError') reason = 'malformed'; // a 200 whose body is not JSON
    else reason = 'network';                                            // the request never got an answer
    // ABA-7: only a transient failure keeps the last answer of the same study (as Stale); ABA-6 and a bad answer clear it.
    return { reason, status, code, keep: reason === 'busy' || reason === 'network' };
  }
  function reasonText(reason, status, code) {
    const tail = [status === null || status === undefined ? '' : 'HTTP ' + status, code || ''].filter(Boolean).join(' · ');
    return TEXT.reasons[reason] + (tail ? ' (' + tail + ')' : '');
  }

  // ── stale after a later list observation (§8.1 S1-S8). The baseline is the painted answer's own DTO paths. ──
  /**
   * `list` is a readable worklist answer ({studies, observation: {observedAt}}). Only an observation read after the answer
   * (list observedAt > answer observedAt) is compared; rows the list does not carry are not compared. A section that was not
   * read (failed, not_configured) has no baseline and is never marked. A mark stays until a new answer is painted.
   */
  function staleAfter(answer, list, stale) {
    const next = Object.assign({}, stale || {});
    const at = list && record(list.observation) ? list.observation.observedAt : null;
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || !(Date.parse(at) > Date.parse(answer.observedAt))) return next;
    const rows = new Map();
    for (const row of Array.isArray(list.studies) ? list.studies : []) if (record(row) && typeof row.uid === 'string') rows.set(row.uid, row);
    const sections = answer.sections;
    const mark = name => { if (readable(sections[name].state) && !next[name]) next[name] = 'list_changed'; };
    const rsOf = row => record(row.state) ? row.state.rs : undefined;
    const versionOf = row => record(row.state) ? row.state.version : undefined;
    for (const item of sections.history.items) {
      const row = rows.get(item.studyUid);
      if (!row) continue;
      if (rsOf(row) !== item.reading.rs || versionOf(row) !== item.reading.reportVersion) {     // S1, S2
        mark('history');
        if (item.reading.signed || rsOf(row) === 'A') mark('priorReports');                   // S8
      }
    }
    for (const item of sections.priorReports.items) {
      const row = rows.get(item.studyUid);
      if (row && (rsOf(row) !== 'A' || versionOf(row) !== item.report.version)) mark('priorReports');   // S3, S4
    }
    const anchor = rows.get(answer.uid);
    if (anchor) {
      const note = record(anchor.techNote) && Number.isSafeInteger(anchor.techNote.version) ? anchor.techNote.version : 0;
      if (note !== answer.anchor.techNoteVersion) mark('techNote');                             // S5
      if ((anchor.sourcePatientKey === undefined ? null : anchor.sourcePatientKey) !== answer.patientKey) {
        mark('priorReports'); mark('history');                                                // S7
      }
    }
    if (!sections.history.truncated && answer.patientKey !== null) {                            // S6
      const known = new Set(sections.history.items.map(item => item.studyUid));
      for (const row of rows.values()) {
        if (row.uid === answer.uid || known.has(row.uid) || row.sourcePatientKey !== answer.patientKey) continue;
        mark('history');
        if (rsOf(row) === 'A') mark('priorReports');
      }
    }
    return next;
  }
  /** ABA-7: a transient failure of a re-read keeps the last answer; every section that was read shows Stale. */
  function refreshFailed(answer, stale) {
    const next = Object.assign({}, stale || {});
    for (const name of SECTIONS) if (readable(answer.sections[name].state) && !next[name]) next[name] = 'refresh_failed';
    return next;
  }

  // ── what to paint (§10) ──
  function accessBadge(access, anchor) {
    const table = TEXT.access[access];
    return { text: table.label, title: fill(table.title, { institutionName: anchor.institutionName }), badge: true };
  }
  const joined = values => values.filter(value => typeof value === 'string' && value !== '').join(' ');
  function marks(identity) {
    const out = [];
    if (identity.birth === 'mismatch') out.push(TEXT.marks.birth);
    if (identity.sex === 'mismatch') out.push(TEXT.marks.sex);
    return out;
  }
  function view(answer, stale, options) {
    const format = options && typeof options.format === 'function' ? options.format : localTime;
    const actor = options && typeof options.actor === 'function' ? options.actor : value => value;
    const shown = states(answer, stale), marksBy = stale || {};
    const time = iso => ({ text: format(iso), title: iso });
    const recorded = iso => iso === null ? { text: fill(TEXT.recorded, { time: '-' }), title: TEXT.recordedAtNone }
      : { text: fill(TEXT.recorded, { time: format(iso) }), title: iso };
    const observed = iso => ({ text: fill(TEXT.observed, { time: format(iso) }), title: iso });
    const anchorBadge = accessBadge(answer.anchor.access, answer.anchor);
    const sections = SECTIONS.map(name => {
      const section = answer.sections[name], state = shown[name];
      let description;
      if (state === 'present') description = fill(TEXT.present, { observedAt: format(section.observedAt), sourceLabel: section.sourceLabel });
      else if (state === 'absent') description = fill(TEXT.absent, { observedAt: format(section.observedAt) });
      else if (state === 'not_configured') description = TEXT.notConfigured[section.reason];
      else if (state === 'failed') description = TEXT.failed + ' ' + reasonText(section.reason);
      else description = fill(TEXT.stale, { observedAt: format(section.observedAt), cause: TEXT.staleCauses[marksBy[name]] });
      const list = section.items.map(item => {
        if (name === 'priorReports') {
          return { key: item.studyUid, marks: marks(item.identity),
            line: [{ text: joined([item.study.date, item.study.modalities, item.study.description]) },
              { text: TEXT.actions[item.report.action] + ' v' + item.report.version }, { text: actor(item.provenance.author) },
              time(item.provenance.recordedAt), accessBadge(item.access, answer.anchor)],
            source: [{ text: section.sourceLabel }, observed(item.provenance.observedAt)],
            details: TEXT.bodies.map(([key, label]) => ({ label, text: item.report[key] })) };
        }
        if (name === 'history') {
          return { key: item.studyUid, marks: marks(item.identity),
            line: [{ text: joined([item.study.date, item.study.modalities, item.study.description, item.study.accession]) },
              { text: item.institutionName }, { text: 'RS ' + item.reading.rs },
              { text: item.reading.signed ? TEXT.signed : TEXT.unsigned }, accessBadge(item.access, answer.anchor)],
            source: [{ text: section.sourceLabel }, recorded(item.provenance.recordedAt), observed(item.provenance.observedAt)],
            details: null };
        }
        if (name === 'requestTags') {
          const code = '(' + item.tag.slice(0, 4) + ',' + item.tag.slice(4) + ')';
          return { key: item.tag, marks: [],
            line: [{ text: item.keyword + ' ' + code + ': ' + (item.value === null ? TEXT.tagNotes[item.note] : item.value) }],
            source: [{ text: 'DICOM header' }, { text: 'SOP ' + item.provenance.recordId }, recorded(item.provenance.recordedAt),
              observed(item.provenance.observedAt), anchorBadge],
            details: null };
        }
        return { key: 'v' + item.version, marks: [],
          line: [{ text: 'Tech Note v' + item.version }, { text: actor(item.provenance.author) }, time(item.provenance.recordedAt),
            anchorBadge].concat(item.hasText ? [] : [{ text: TEXT.noText }]),
          source: [{ text: section.sourceLabel }, observed(item.provenance.observedAt)],
          details: null };
      });
      const checked = name === 'requestTags' && section.checked.length
        ? fill(TEXT.checked, { checked: section.checked.map(code => {
          const tag = TAGS.find(t => t.tag === code);
          return (tag ? tag.keyword + ' ' : '') + '(' + code.slice(0, 4) + ',' + code.slice(4) + ')';
        }).join(', ') }) : null;
      return { name, title: TEXT.sectionTitles[name],
        count: section.items.length ? '(' + section.items.length + (section.truncated ? '+' : '') + ')' : '',
        state, label: state === 'present' ? '' : TEXT.stateLabels[state], description, retry: state === 'failed',
        checked, items: list };
    });
    const identity = answer.identity;
    const fields = identity.birth === 'mismatch' && identity.sex === 'mismatch' ? 'both' : identity.birth === 'mismatch' ? 'birth' : 'sex';
    return {
      conflict: identity.conflict ? { title: TEXT.conflictTitle, text: fill(TEXT.conflict, { fields: TEXT.conflictFields[fields] }) } : null,
      sections, noInformation: noInformation(answer, stale),
    };
  }
  /** The panel status line for a painted answer: the empty sentence, a kept answer after a failed re-read, or its read time. */
  function summary(answer, stale, kept, options) {
    const format = options && typeof options.format === 'function' ? options.format : localTime;
    if (kept) return { label: TEXT.stateLabels.stale, text: TEXT.refreshFailed + ' ' + reasonText(kept.reason, kept.status, kept.code), title: '' };
    if (noInformation(answer, stale)) return { label: '', text: TEXT.noInformation, title: '' };
    return { label: '', text: fill(TEXT.observedAnswer, { observedAt: format(answer.observedAt) }), title: answer.observedAt };
  }
  /** The panel status line when no answer is shown: Failed and the reason (§7 failed, screen-made). */
  function failedSummary(failed) {
    return { label: TEXT.stateLabels.failed, text: reasonText(failed.reason, failed.status, failed.code), title: '' };
  }

  const api = Object.freeze({ SCHEMA, SECTIONS, SOURCE_LABELS, TEXT, shapeError, states, noInformation, failure, staleAfter,
    refreshFailed, view, summary, failedSummary, localTime });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinClinicalContext = api;
})(globalThis);
