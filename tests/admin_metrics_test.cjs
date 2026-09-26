'use strict';
/* TEST-S5-U6b-PURE: the admin Operations metric model.
 * REQ-S5-U6b-OPS-METRICS -> RISK-S5-U6b-UNKNOWN-AS-ZERO / INVENTED-THRESHOLD / TENANT-AGGREGATE.
 *
 * Two halves over one answer fixture (ANSWER below):
 *  - page: the <script id="admin-metrics-model"> block of worklist-v0/hpacs-lite/admin.html, run as shipped in a vm
 *    context (no copy, no DOM). Every read, failure, missing-source and zero-denominator vector; wording; no threshold.
 *  - server: the compiled api/src/pacs.service.ts (adminMetricRows, orthancDiskBytes, PacsService.adminMetrics) over a
 *    fake store. It runs only when KIN_ADMIN_METRICS_SERVER names the compiled module (kin-api:ci: /app/dist/pacs.service);
 *    when the variable is set a missing module fails the run. Without it these cases are reported as skipped, never passed.
 * The server half proves the fixture is what the compiled rows produce, so the page half reads the real shape.
 * Synthetic data only; no network, database, credentials or clinical data.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'admin.html'), 'utf8');
const OPEN = '<script id="admin-metrics-model">';

function modelSource() {
  const start = HTML.indexOf(OPEN);
  assert.ok(start >= 0, 'the model block is gone from admin.html');
  assert.equal(HTML.indexOf(OPEN, start + 1), -1, 'exactly one model block');
  return HTML.slice(start + OPEN.length, HTML.indexOf('</script>', start));
}
const context = vm.createContext({});
vm.runInContext(modelSource(), context, { filename: 'admin.html#admin-metrics-model' });
const M = context.KinAdminMetrics;
// Objects made in the vm realm carry its prototypes; compare them as JSON values.
const json = value => JSON.parse(JSON.stringify(value));
const F = iso => `<${iso}>`;

const SERVER = process.env.KIN_ADMIN_METRICS_SERVER || '';
const S = SERVER ? require(SERVER) : null;
const { StudyAccessService } = SERVER ? require(path.join(path.dirname(SERVER), 'study-access.service')) : {};
const hosted = S ? false : 'KIN_ADMIN_METRICS_SERVER is not set: the compiled PacsService runs in kin-api:ci only (/app/dist)';

const KEYS = ['storage.server', 'storage.institution', 'studies.own', 'studies.tele', 'studies.flag_unreadable',
  'studies.registered_24h', 'studies.registered_7d', 'tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal'];
const NOW = '2026-09-26T00:00:00.000Z';
const DAY_FROM = '2026-09-25T00:00:00.000Z';
const WEEK_FROM = '2026-09-19T00:00:00.000Z';
const DISK_AT = '2026-09-25T23:59:59.500Z';
const GENERATED = '2026-09-26T00:00:01.000Z';
const BYTES = 13421772800;   // 12.5 GiB
const SRC = {
  disk: 'Orthanc GET /statistics TotalDiskSize', studies: 'KIN DB StudyState', registered: 'KIN DB StudyState.createdAt',
  tat: 'KIN DB StudyState.createdAt, ReportVersion(action=approve).at, StudyState.em',
  waiting: 'KIN DB StudyState.createdAt, StudyState.rs, StudyState.em',
};
const base = { reason: null, max: null, denominator: null, excluded: null, window: null };
const ROWS = [
  { ...base, key: 'storage.server', state: 'observed', scope: 'server', source: SRC.disk, observedAt: DISK_AT, unit: 'byte',
    value: BYTES, denominator: { unit: 'byte', value: null } },
  { ...base, key: 'storage.institution', state: 'unobservable', reason: 'no_source', scope: 'institution', source: null,
    observedAt: null, unit: 'byte', value: null, denominator: { unit: 'byte', value: null } },
  { ...base, key: 'studies.own', state: 'observed', scope: 'institution', source: SRC.studies, observedAt: NOW, unit: 'study', value: 10 },
  { ...base, key: 'studies.tele', state: 'observed', scope: 'institution', source: SRC.studies, observedAt: NOW, unit: 'study', value: 1 },
  { ...base, key: 'studies.flag_unreadable', state: 'observed', scope: 'institution', source: SRC.studies, observedAt: NOW,
    unit: 'study', value: 1 },
  { ...base, key: 'studies.registered_24h', state: 'observed', scope: 'institution', source: SRC.registered, observedAt: NOW,
    unit: 'study', value: 7, excluded: 0, window: { from: DAY_FROM, to: NOW } },
  { ...base, key: 'studies.registered_7d', state: 'observed', scope: 'institution', source: SRC.registered, observedAt: NOW,
    unit: 'study', value: 9, excluded: 0, window: { from: WEEK_FROM, to: NOW } },
  { ...base, key: 'tat.emergency', state: 'observed', scope: 'institution', source: SRC.tat, observedAt: NOW, unit: 'second',
    value: 14400, max: 86400, denominator: { unit: 'study', value: 3 }, excluded: 0, window: { from: WEEK_FROM, to: NOW } },
  { ...base, key: 'tat.normal', state: 'observed', scope: 'institution', source: SRC.tat, observedAt: NOW, unit: 'second',
    value: 86400, max: 86400, denominator: { unit: 'study', value: 1 }, excluded: 1, window: { from: WEEK_FROM, to: NOW } },
  { ...base, key: 'waiting.emergency', state: 'observed', scope: 'institution', source: SRC.waiting, observedAt: NOW,
    unit: 'second', value: 3600, max: 3600, denominator: { unit: 'study', value: 1 }, excluded: 0 },
  { ...base, key: 'waiting.normal', state: 'observed', scope: 'institution', source: SRC.waiting, observedAt: NOW,
    unit: 'second', value: 12600, max: 18000, denominator: { unit: 'study', value: 2 }, excluded: 1 },
];
const ANSWER = { institutionId: 'hallym', generatedAt: GENERATED, metrics: ROWS };
const clone = value => JSON.parse(JSON.stringify(value));
const withRow = (key, change) => {
  const answer = clone(ANSWER);
  answer.metrics = answer.metrics.map(row => row.key === key ? (typeof change === 'function' ? change(row) : { ...row, ...change }) : row);
  return answer;
};
const read = answer => json(M.readAnswer(answer));
const rowOf = (answer, key) => read(answer).rows.find(row => row.key === key);

// ── page model ──

test('the page table is the fixed eleven rows in the server order, frozen', () => {
  assert.deepEqual(json(M.METRICS.map(item => item.key)), KEYS);
  assert.ok(Object.isFrozen(M.METRICS) && M.METRICS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(M.ROW_STATES) && Object.values(M.ROW_STATES).every(Object.isFrozen));
  assert.ok(Object.isFrozen(M.REASONS) && Object.isFrozen(M.UNITS));
  assert.deepEqual(json(Object.keys(M.REASONS)).sort(), ['invalid_answer', 'no_source', 'source_failed', 'timeout']);
});

test('a server answer is read row by row and every row keeps its source, time, unit, denominator and scope', () => {
  const result = read(ANSWER);
  assert.equal(result.institutionId, 'hallym');
  assert.equal(result.generatedAt, GENERATED);
  assert.deepEqual(result.rows.map(row => [row.key, row.state, row.value, row.max, row.denominator, row.excluded]), [
    ['storage.server', 'observed', BYTES, null, null, null],
    ['storage.institution', 'unobservable', null, null, null, null],
    ['studies.own', 'observed', 10, null, null, null],
    ['studies.tele', 'observed', 1, null, null, null],
    ['studies.flag_unreadable', 'observed', 1, null, null, null],
    ['studies.registered_24h', 'observed', 7, null, null, 0],
    ['studies.registered_7d', 'observed', 9, null, null, 0],
    ['tat.emergency', 'observed', 14400, 86400, 3, 0],
    ['tat.normal', 'observed', 86400, 86400, 1, 1],
    ['waiting.emergency', 'observed', 3600, 3600, 1, 0],
    ['waiting.normal', 'observed', 12600, 18000, 2, 1],
  ]);
  const shown = result.rows.map(row => json(M.display(row, result.institutionId, F)));
  assert.deepEqual(shown.map(s => [s.label, s.stateText, s.value, s.unit, s.denominator, s.scope, s.source, s.observed]), [
    ['Storage Used (Server-wide)', 'Observed', '12.50 GiB', 'Bytes (1 GiB = 1024³ B)', 'Capacity Unobservable', 'Server-wide', SRC.disk, `<${DISK_AT}>`],
    ['Storage Used (This Institution)', 'Unobservable', 'Unobservable', 'Bytes (1 GiB = 1024³ B)', 'Capacity Unobservable', 'Institution hallym', 'No Source', 'Not Observed'],
    ['Studies Owned', 'Observed', '10', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.studies, `<${NOW}>`],
    ['Studies Received for Tele-reading', 'Observed', '1', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.studies, `<${NOW}>`],
    ['Emergency Flag Unreadable', 'Observed', '1', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.studies, `<${NOW}>`],
    ['Registered in KIN (Last 24 h)', 'Observed', '7', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.registered, `<${NOW}>`],
    ['Registered in KIN (Last 7 d)', 'Observed', '9', 'Studies', 'Not a Ratio', 'Institution hallym', SRC.registered, `<${NOW}>`],
    ['Report TAT (Emergency)', 'Observed', 'Median 4 h 00 min · Max 24 h 00 min', 'Elapsed Time (Median · Max)', '3 Studies', 'Institution hallym', SRC.tat, `<${NOW}>`],
    ['Report TAT (Normal)', 'Observed', 'Median 24 h 00 min · Max 24 h 00 min', 'Elapsed Time (Median · Max)', '1 Study · 1 Excluded', 'Institution hallym', SRC.tat, `<${NOW}>`],
    ['Waiting (Emergency)', 'Observed', 'Median 1 h 00 min · Max 1 h 00 min', 'Elapsed Time (Median · Max)', '1 Study', 'Institution hallym', SRC.waiting, `<${NOW}>`],
    ['Waiting (Normal)', 'Observed', 'Median 3 h 30 min · Max 5 h 00 min', 'Elapsed Time (Median · Max)', '2 Studies · 1 Excluded', 'Institution hallym', SRC.waiting, `<${NOW}>`],
  ]);
  assert.equal(shown[0].valueTitle, `원천 값 ${BYTES}바이트`);
  assert.equal(shown[7].valueTitle, '중앙값 14400초 · 최댓값 86400초');
  assert.ok(shown[5].labelTitle.endsWith(` 기간: <${DAY_FROM}> ~ <${NOW}>.`), shown[5].labelTitle);
  assert.ok(shown[7].observedTitle.includes(`기간: <${WEEK_FROM}> ~ <${NOW}>.`), shown[7].observedTitle);
  assert.equal(shown[1].stateTitle, '값을 관측하지 못했습니다. 0으로 두지 않습니다. 제품에 이 값을 잴 원천이 없습니다.');
});

// Unknown is never a number: every cell of an unobservable row is a word, and only a known zero denominator says 0.
const DIGIT = /\d/;
function assertUnknownCells(shown) {
  for (const field of ['value', 'observed']) assert.doesNotMatch(shown[field], DIGIT, `${shown.key} ${field}: ${shown[field]}`);
  assert.doesNotMatch(shown.denominator, DIGIT, `${shown.key} denominator: ${shown.denominator}`);
  assert.equal(shown.value, 'Unobservable');
  assert.equal(shown.stateText, 'Unobservable');
}

test('every source failure reads Unobservable with its reason, never 0, on every row', () => {
  for (const reason of ['source_failed', 'invalid_answer', 'timeout', 'no_source']) {
    for (const key of KEYS) {
      const answer = withRow(key, row => ({ ...row, state: 'unobservable', reason, value: null, max: null, observedAt: null,
        excluded: null, window: null, denominator: row.unit === 'second' ? { unit: 'study', value: null } : row.denominator }));
      const row = rowOf(answer, key);
      assert.deepEqual([row.state, row.reason, row.value, row.observedAt], ['unobservable', reason, null, null], `${key} ${reason}`);
      const shown = json(M.display(row, 'hallym', F));
      assertUnknownCells(shown);
      assert.ok(shown.stateTitle.endsWith(M.REASONS[reason]), shown.stateTitle);
    }
  }
});

test('a zero denominator reads No Studies with a known 0 count, never 0 min', () => {
  for (const key of ['tat.emergency', 'tat.normal', 'waiting.emergency', 'waiting.normal']) {
    const answer = withRow(key, { state: 'empty', value: null, max: null, denominator: { unit: 'study', value: 0 }, excluded: 2 });
    const row = rowOf(answer, key);
    assert.deepEqual([row.state, row.value, row.max, row.denominator, row.excluded], ['empty', null, null, 0, 2], key);
    const shown = json(M.display(row, 'hallym', F));
    assert.deepEqual([shown.stateText, shown.value, shown.denominator], ['No Studies', 'No Studies', '0 Studies · 2 Excluded'], key);
    assert.doesNotMatch(shown.value, DIGIT);
    assert.match(shown.stateTitle, /0분이 아닙니다/);
  }
});

test('rows that do not prove their value read Unobservable (invalid_answer), including every disguised zero', () => {
  const cases = [
    ['studies.own', { value: null }, 'observed without a value'],
    ['studies.own', { value: '0' }, 'a string zero'],
    ['studies.own', { value: -1 }, 'a negative count'],
    ['studies.own', { value: 1.5 }, 'a fraction'],
    ['studies.own', { value: 2 ** 53 }, 'beyond safe integers'],
    ['studies.own', { observedAt: null }, 'no observation time'],
    ['studies.own', { observedAt: '2026-09-26 00:00:00' }, 'not an ISO UTC time'],
    ['studies.own', { source: '' }, 'no source'],
    ['studies.own', { source: null }, 'null source'],
    ['studies.own', { unit: 'second' }, 'another unit'],
    ['studies.own', { scope: 'server' }, 'another scope'],
    ['studies.own', { reason: 'source_failed' }, 'a reason on an observed row'],
    ['studies.own', { denominator: { unit: 'study', value: 10 } }, 'a denominator on a count'],
    ['studies.own', { state: 'empty' }, 'empty on a count'],
    ['studies.own', { state: 'fine' }, 'an unknown state'],
    ['studies.registered_24h', { window: null }, 'a windowed count without its window'],
    ['studies.registered_24h', { window: { from: WEEK_FROM, to: NOW } }, 'the wrong window length'],
    ['studies.registered_7d', { excluded: -1 }, 'a negative excluded count'],
    ['storage.server', { denominator: { unit: 'byte', value: 2 ** 40 } }, 'an invented capacity'],
    ['storage.server', { denominator: null }, 'storage without the capacity slot'],
    ['storage.server', { value: 0.5 }, 'fractional bytes'],
    ['tat.emergency', { denominator: { unit: 'study', value: 0 } }, 'observed with a zero denominator'],
    ['tat.emergency', { max: 100 }, 'a max below the median'],
    ['tat.emergency', { max: null }, 'no max'],
    ['tat.emergency', { excluded: null }, 'no excluded count'],
    ['tat.emergency', { window: null }, 'TAT without its window'],
    ['tat.emergency', { state: 'empty', value: 0, max: 0, denominator: { unit: 'study', value: 0 } }, 'empty carrying 0 min'],
    ['tat.emergency', { state: 'empty', value: null, max: null, denominator: { unit: 'study', value: 1 } }, 'empty with studies'],
    ['waiting.normal', { denominator: { unit: 'byte', value: 2 } }, 'a denominator in another unit'],
    ['waiting.normal', { state: 'unobservable', reason: 'source_failed', value: 0 }, 'unobservable carrying 0'],
    ['waiting.normal', { state: 'unobservable', reason: 'SYN', value: null, max: null }, 'an unknown reason'],
  ];
  for (const [key, change, what] of cases) {
    const row = rowOf(withRow(key, change), key);
    assert.deepEqual([row.state, row.reason, row.value, row.max, row.observedAt], ['unobservable', 'invalid_answer', null, null, null],
      `${key}: ${what}`);
    const shown = json(M.display(row, 'hallym', F));
    assertUnknownCells(shown);
    assert.equal(shown.source, 'Unknown', what);
  }
  // A row the answer leaves out is unknown too, and the other rows still read.
  const missing = clone(ANSWER);
  missing.metrics = missing.metrics.filter(row => row.key !== 'tat.normal');
  const rows = read(missing).rows;
  assert.deepEqual([rows[8].key, rows[8].state, rows[8].reason], ['tat.normal', 'unobservable', 'invalid_answer']);
  assert.equal(rows.filter(row => row.state === 'observed').length, 9);
  // An extra, unknown row is not shown.
  const extra = clone(ANSWER);
  extra.metrics.push({ ...ROWS[2], key: 'studies.unknown', value: 5 });
  assert.deepEqual(read(extra).rows.map(row => row.key), KEYS);
});

test('an answer that cannot be read at all is null (the page keeps its last reading)', () => {
  const bad = [null, undefined, 'SYN', 7, [], {}, { ...ANSWER, institutionId: '' }, { ...ANSWER, institutionId: 3 },
    { ...ANSWER, generatedAt: 'soon' }, { ...ANSWER, generatedAt: null }, { ...ANSWER, metrics: 'SYN' },
    { ...ANSWER, metrics: undefined }, { ...ANSWER, metrics: [...ROWS, ROWS[2]] }, { ...ANSWER, metrics: [...ROWS, { value: 1 }] },
    { ...ANSWER, metrics: [...ROWS, null] }];
  bad.forEach((answer, index) => assert.equal(M.readAnswer(answer), null, `case ${index}`));
  assert.equal(read({ ...ANSWER, metrics: [] }).rows.every(row => row.state === 'unobservable'), true, 'no rows: all unknown');
});

test('units are stated and formatted without rounding a nonzero value to 0', () => {
  assert.deepEqual([0, 1023, 1024, 1536, 2 ** 20, BYTES, 2 ** 40 * 3].map(M.formatBytes),
    ['0 B', '1023 B', '1.00 KiB', '1.50 KiB', '1.00 MiB', '12.50 GiB', '3.00 TiB']);
  assert.deepEqual([0, 1, 59, 60, 119, 3599, 3600, 3660, 12600, 100 * 3600 + 7 * 60].map(M.formatDuration),
    ['0 s', '1 s', '59 s', '1 min', '1 min', '59 min', '1 h 00 min', '1 h 01 min', '3 h 30 min', '100 h 07 min']);
  assert.deepEqual(json(Object.fromEntries(Object.entries(M.UNITS).map(([key, [text]]) => [key, text]))),
    { byte: 'Bytes (1 GiB = 1024³ B)', study: 'Studies', second: 'Elapsed Time (Median · Max)' });
});

test('no threshold: a long wait and a short one differ only in their numbers', () => {
  const short = json(M.display(rowOf(withRow('waiting.normal', { value: 60, max: 120 }), 'waiting.normal'), 'hallym', F));
  const long = json(M.display(rowOf(withRow('waiting.normal', { value: 900000, max: 3600000 }), 'waiting.normal'), 'hallym', F));
  const differ = Object.keys(short).filter(key => short[key] !== long[key]);
  assert.deepEqual(differ, ['value', 'valueTitle']);
  assert.deepEqual(Object.keys(short), ['key', 'state', 'label', 'labelTitle', 'stateText', 'stateTitle', 'value', 'valueTitle',
    'unit', 'unitTitle', 'denominator', 'denominatorTitle', 'scope', 'scopeTitle', 'source', 'sourceTitle', 'observed', 'observedTitle'],
  'no level, colour, severity or limit field exists');
  // The mockup limits (30 and 240 minutes) are absent from the model code, as is any level or severity word.
  const code = modelSource().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // 30/240 min as minutes, seconds or milliseconds (2 ** 30 in the byte units is not a limit).
  assert.doesNotMatch(code, /\b(240|1800|14400|1800000|14400000)\b|\b30\s*\*|threshold|severity|warning|danger|alert/i);
});

test('the panel line: Not Loaded, Observed, and Query Failed with and without a last reading', () => {
  assert.deepEqual(json([M.summary(null, F), M.summary({ observedAt: null, failed: false }, F),
    M.summary({ observedAt: GENERATED, failed: false }, F), M.summary({ observedAt: GENERATED, failed: true }, F),
    M.summary({ observedAt: null, failed: true }, F)].map(s => [s.key, s.text])), [
    ['not_loaded', 'Not Loaded'], ['not_loaded', 'Not Loaded'], ['observed', `Observed <${GENERATED}>`],
    ['query_failed', `Query Failed · 마지막 관측 기준 <${GENERATED}>`], ['query_failed', 'Query Failed · 아직 성공한 조회가 없습니다']]);
});

const HANGUL = /[가-힣]/;
// UXR-SP-34 / UXR-G-18, the same pattern as tests/admin_member_roles_dom_test.py.
const AVOIDED = /진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b/i;
test('wording: English labels, states and units; Korean explanations; no avoided word', () => {
  const english = [...M.METRICS.map(item => item.label), ...Object.values(M.ROW_STATES).map(state => state.text),
    ...Object.values(M.UNITS).map(([text]) => text)];
  assert.deepEqual(english.filter(text => HANGUL.test(text)), []);
  const korean = [...M.METRICS.map(item => item.title), ...Object.values(M.ROW_STATES).map(state => state.title),
    ...Object.values(M.REASONS), ...Object.values(M.UNITS).map(([, title]) => title)];
  assert.deepEqual(korean.filter(text => !HANGUL.test(text)), []);
  const every = [...english, ...korean];
  for (const row of read(ANSWER).rows) every.push(...Object.values(json(M.display(row, 'hallym', F))).filter(v => typeof v === 'string'));
  assert.deepEqual(every.filter(text => AVOIDED.test(text)), []);
});

// ── compiled server ──

const H = 3600 * 1000, now = Date.parse(NOW);
const ago = ms => new Date(now - ms);
const state = (uid, institutionId, em, rs, createdAgo, tele = null) =>
  ({ uid, institutionId, teleInstitutionId: tele, em, rs, createdAt: ago(createdAgo) });
// The ANSWER fixture, as study rows: see the comment on each line for where it lands.
const STATES = [
  state('1.2.1', 'hallym', 'E', 'A', 10 * H),          // TAT E 2 h
  state('1.2.2', 'hallym', 'E', 'A', 30 * H),          // TAT E 4 h (registered 7 d, not 24 h)
  state('1.2.3', 'hallym', 'N', 'A', 72 * H),          // TAT N 24 h
  state('1.2.4', 'hallym', 'N', 'W', 5 * H),           // waiting N 5 h
  state('1.2.5', 'kin-center', 'N', 'T', 2 * H, 'hallym'),   // tele-received: waiting N 2 h
  state('1.2.6', 'hallym', 'E', 'P', 1 * H),           // waiting E 1 h
  state('1.2.7', 'hallym', 'N', 'A', 20 * 24 * H),     // first approval 10 d ago: outside the TAT window
  state('1.2.8', 'hallym', 'X', 'W', 1 * H),           // flag unreadable: in no TAT/waiting row
  state('1.2.9', 'kin-center', 'E', 'W', 1 * H),       // another institution: counted nowhere
  state('1.2.10', 'hallym', 'N', 'A', 1 * H),          // approved before registered: TAT N excluded
  state('1.2.11', 'hallym', 'N', 'Z', 3 * H),          // unknown RS: waiting N excluded
  state('1.2.12', 'hallym', 'E', 'A', 8 * 24 * H),     // first approval exactly 7 d ago: in the window, TAT E 24 h
];
const APPROVED = [['1.2.1', 8 * H], ['1.2.2', 26 * H], ['1.2.3', 48 * H], ['1.2.7', 10 * 24 * H], ['1.2.9', 0.5 * H],
  ['1.2.10', 2 * H], ['1.2.12', 7 * 24 * H], ['9.9.9', 1 * H]];
const STATISTICS = { TotalDiskSize: String(BYTES), TotalDiskSizeMB: 12800, CountStudies: 987654, CountInstances: 876543,
  CountPatients: 765432, CountSeries: 654321, TotalUncompressedSize: '999999999999' };

const ADMIN = { institution: 'hallym', sub: 'SYN-ADMIN-SUB', actor: 'syn-admin', roles: ['admin'], kind: 'member' };
const POLICY = restricted => ({ institution: 'hallym', revision: 1, reason: 'SYN', updatedBy: 'syn-admin', updatedAt: new Date(now),
  policy: { version: 1, restricted, startsAt: null, endsAt: null, rules: restricted ? [{ all: true }] : [] } });

function store({ policies = [[], []], statistics = STATISTICS, orthanc = null, dbFail = null, approvalsFail = null } = {}) {
  const calls = [];
  let policyReads = 0;
  const prisma = {
    studyState: { findMany: async arg => { calls.push(['states', arg]); if (dbFail) throw dbFail; return structuredClone(STATES); } },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('"StudyAccessPolicy"')) { calls.push(['policy']); return structuredClone(policies[Math.min(policyReads++, policies.length - 1)]); }
      calls.push(['approvals', sql, values]);
      if (approvalsFail) throw approvalsFail;
      return APPROVED.map(([uid, at]) => ({ uid, firstApprovedAt: ago(at) }));
    },
  };
  const source = { get: orthanc ?? (async path => { calls.push(['orthanc', path]); return structuredClone(statistics); }) };
  const service = new S.PacsService(prisma, source, {}, new StudyAccessService(prisma, {}, {}), {});
  // The instance clock is the fixture's NOW, so windows and durations are the fixture's to the second.
  service.metricsClock = () => now;
  return { service, calls };
}
// The fixture as the service stamps it: its one clock also stamps the Orthanc observation.
const AT_CLOCK = () => clone(ROWS).map(row => row.key === 'storage.server' ? { ...row, observedAt: NOW } : row);

test('server: the compiled rows are exactly the page fixture (tenant filter, windows, median, exclusions)', { skip: hosted }, () => {
  assert.deepEqual([...S.ADMIN_METRIC_KEYS], KEYS);
  const approvals = new Map(APPROVED.map(([uid, at]) => [uid, ago(at)]));
  const rows = S.adminMetricRows('hallym', { bytes: BYTES, observedAt: DISK_AT }, { observedAt: NOW, states: STATES, firstApproved: approvals });
  assert.deepEqual(clone(rows), ROWS);
  // Rows of another institution never count, whoever passes them in.
  const foreign = STATES.map(s => ({ ...s, institutionId: 'kin-center', teleInstitutionId: null }));
  const none = clone(S.adminMetricRows('hallym', { bytes: 0, observedAt: DISK_AT }, { observedAt: NOW, states: foreign, firstApproved: approvals }));
  assert.deepEqual(none.slice(2).map(row => [row.key, row.state, row.value]), [
    ['studies.own', 'observed', 0], ['studies.tele', 'observed', 0], ['studies.flag_unreadable', 'observed', 0],
    ['studies.registered_24h', 'observed', 0], ['studies.registered_7d', 'observed', 0],
    ['tat.emergency', 'empty', null], ['tat.normal', 'empty', null], ['waiting.emergency', 'empty', null], ['waiting.normal', 'empty', null]]);
  assert.deepEqual([none[0].state, none[0].value], ['observed', 0], 'a disk the source reports as 0 bytes is a known 0');
  // DB facts missing: every DB row is unknown, and storage still reads.
  const failed = clone(S.adminMetricRows('hallym', { bytes: BYTES, observedAt: DISK_AT }, null));
  assert.deepEqual(failed.map(row => [row.key, row.state, row.reason, row.value, row.observedAt]), [
    ['storage.server', 'observed', null, BYTES, DISK_AT], ['storage.institution', 'unobservable', 'no_source', null, null],
    ...KEYS.slice(2).map(key => [key, 'unobservable', 'source_failed', null, null])]);
  assert.deepEqual(failed.slice(7).map(row => row.denominator), Array(4).fill({ unit: 'study', value: null }));
  assert.deepEqual(failed.slice(2, 7).map(row => row.denominator), Array(5).fill(null));
  for (const failure of ['source_failed', 'invalid_answer', 'timeout']) {
    const disk = clone(S.adminMetricRows('hallym', { failure }, null))[0];
    assert.deepEqual([disk.state, disk.reason, disk.value, disk.observedAt], ['unobservable', failure, null, null]);
  }
  assert.deepEqual(read({ ...ANSWER, metrics: failed }).rows.map(row => row.reason === 'invalid_answer'), Array(11).fill(false),
    'the page reads every compiled failure row as its own reason');
});

test('server: TotalDiskSize is the only value read from /statistics; anything else is unknown', { skip: hosted }, () => {
  const cases = [[{ TotalDiskSize: '0' }, 0], [{ TotalDiskSize: ' 42 ' }, 42], [{ TotalDiskSize: 42 }, 42],
    [{ TotalDiskSize: '-1' }, null], [{ TotalDiskSize: '1e3' }, null], [{ TotalDiskSize: '1.5' }, null],
    [{ TotalDiskSize: '12.0' }, null], [{ TotalDiskSize: '1.' }, null], [{ TotalDiskSize: '0x10' }, null],
    [{ TotalDiskSize: '99999999999999999999' }, null], [{ TotalDiskSizeMB: 12 }, null], [{}, null], [[], null],
    ['12', null], [null, null], [{ TotalDiskSize: null }, null], [{ TotalDiskSize: NaN }, null]];
  for (const [answer, bytes] of cases) assert.equal(S.orthancDiskBytes(answer), bytes, JSON.stringify(answer));
});

test('server: an admin reads the own-institution aggregate; filters sit in both queries; no study or server count leaves', { skip: hosted }, async () => {
  const { service, calls } = store();
  const answer = await service.adminMetrics(ADMIN);
  assert.deepEqual(Object.keys(answer), ['institutionId', 'generatedAt', 'metrics']);
  assert.deepEqual([answer.institutionId, answer.generatedAt], ['hallym', NOW]);
  assert.deepEqual(clone(answer.metrics), AT_CLOCK());
  const states = calls.find(call => call[0] === 'states')[1];
  assert.deepEqual(states.where, { OR: [{ institutionId: 'hallym' }, { teleInstitutionId: 'hallym' }] });
  assert.deepEqual(Object.keys(states.select).sort(), ['createdAt', 'em', 'institutionId', 'rs', 'teleInstitutionId', 'uid']);
  const [, sql, values] = calls.find(call => call[0] === 'approvals');
  assert.match(sql, /v\.action = 'approve'/);
  assert.match(sql, /JOIN "StudyState" s ON s\.uid = v\.uid/);
  assert.match(sql, /\(s\."institutionId" = \? OR s\."teleInstitutionId" = \?\)/);
  assert.deepEqual(values, ['hallym', 'hallym']);
  assert.deepEqual(calls.filter(call => call[0] === 'orthanc'), [['orthanc', '/statistics']]);
  assert.equal(calls.filter(call => call[0] === 'policy').length, 2, 'the access check runs before and after the reads');
  const text = JSON.stringify(answer);
  for (const leak of ['987654', '876543', '765432', '654321', '999999999999', 'Count', '1.2.', '9.9.9', 'kin-center', 'SYN-ADMIN'])
    assert.ok(!text.includes(leak), `the answer carries ${leak}`);
  const page = M.readAnswer(JSON.parse(text));
  assert.equal(page.rows.filter(row => row.reason === 'invalid_answer').length, 0, 'the page reads every compiled row');
});

test('server: only admin, only with an institution, never for a restricted study scope; nothing is read first', { skip: hosted }, async () => {
  for (const [who, caller] of [['radiologist', { ...ADMIN, roles: ['radiologist'] }], ['technician', { ...ADMIN, roles: ['technician'] }],
    ['clinician-only', { ...ADMIN, roles: ['clinician'] }], ['no roles', { ...ADMIN, roles: [] }],
    ['gateway', { ...ADMIN, kind: 'gateway', roles: ['gateway'] }], ['no institution', { ...ADMIN, institution: null }]]) {
    const { service, calls } = store();
    await assert.rejects(service.adminMetrics(caller), e => e.getStatus() === 403, who);
    assert.deepEqual(calls, [], `${who}: no read before the refusal`);
  }
  const { service, calls } = store({ policies: [[POLICY(true)]] });
  await assert.rejects(service.adminMetrics(ADMIN),
    e => e.getStatus() === 403 && e.getResponse().code === 'ADMIN_METRICS_RESTRICTED');
  assert.deepEqual(calls.map(call => call[0]), ['policy'], 'restricted: no study, approval or Orthanc read');
  // A mixed admin+clinician account is an admin (the clinician-only gate never applies to it).
  const mixed = store();
  assert.equal((await mixed.service.adminMetrics({ ...ADMIN, roles: ['clinician', 'admin'] })).institutionId, 'hallym');
});

test('server: a change of the study access policy during the read refuses the aggregate (409)', { skip: hosted }, async () => {
  const { service } = store({ policies: [[], [POLICY(false)]] });
  await assert.rejects(service.adminMetrics(ADMIN), e => e.getStatus() === 409 && e.getResponse().code === 'STUDY_ACCESS_CHANGED');
});

test('server: Orthanc down, malformed or late is Unobservable storage; the DB rows still read', { skip: hosted }, async () => {
  const outcomes = [
    ['source_failed', async () => { throw Object.assign(new Error('SYN-ORTHANC-URL http://orthanc:8042 refused'), { status: 503 }); }],
    ['invalid_answer', async () => ({ TotalDiskSizeMB: 12800, CountStudies: 987654 })],
    ['invalid_answer', async () => ['SYN']],
    ['timeout', () => new Promise(() => {})],
  ];
  for (const [reason, get] of outcomes) {
    const { service } = store({ orthanc: get });
    service.metricsTimeoutMs = 20;
    const answer = clone(await service.adminMetrics(ADMIN));
    assert.deepEqual([answer.metrics[0].state, answer.metrics[0].reason, answer.metrics[0].value, answer.metrics[0].observedAt],
      ['unobservable', reason, null, null], reason);
    assert.deepEqual(answer.metrics.slice(2).map(row => row.state), [...Array(5).fill('observed'), ...Array(4).fill('observed')]);
    assert.ok(!JSON.stringify(answer).includes('SYN-ORTHANC') && !JSON.stringify(answer).includes('987654'), 'no source wording or count');
  }
});

test('server: a failed DB read is Unobservable on every DB row, never 0, and logs only a code', { skip: hosted }, async () => {
  const warn = console.warn, warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    for (const option of ['dbFail', 'approvalsFail']) {
      const { service } = store({ [option]: Object.assign(new Error('SYN-SECRET-DATABASE-URL'), { code: 'P1001' }) });
      const answer = clone(await service.adminMetrics(ADMIN));
      assert.deepEqual([answer.metrics[0].state, answer.metrics[0].value], ['observed', BYTES], option);
      assert.deepEqual(answer.metrics.slice(2).map(row => [row.state, row.reason, row.value]),
        Array(9).fill(['unobservable', 'source_failed', null]), option);
    }
  } finally { console.warn = warn; }
  assert.equal(warned.length, 2);
  assert.ok(warned.every(line => line.includes('P1001') && !line.includes('SYN-SECRET')), warned.join('\n'));
});
