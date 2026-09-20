'use strict';
/* TEST-S3-U4-PREVIEW-CITATION: the printed citation section's pure record wording.
 *
 * REQ-S3-U4-CITATION-OUTPUT -> RISK-S3-U4-PAPER-IDENTIFIER-LEAK / FALSE-EMPTY /
 * UNMAPPABLE-CLAIM -> TEST-S3-U4-PREVIEW-CITATION.
 *
 * Four failures this file exists to catch, none of which needs a browser:
 *   1. An identifier reaches the paper. The section is metadata-only by decision
 *      (D5): the sentence is already in the body above, and reprinting it for an
 *      'absent' entry would resurrect text removed from a signed record.
 *   2. A failed or refused read prints as '인용된 소견 없음' - a false negative on
 *      a medical record, which is the one defect the first review caught.
 *   3. The paper and the editing drawer disagree about one entry, because the
 *      paper counted presence its own way instead of through the shipped rule.
 *   4. A malformed answer is half-believed: an entry with an unknown field would
 *      silently vanish when the lines are grouped, so the printed count would no
 *      longer be the row's count.
 *
 * Pure: reads the two shipped modules and the shared vector oracle. No stack, no
 * container, no browser, no network, no database.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const preview = require('../worklist-v0/hpacs-lite/report-preview.js');
const VECTORS = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'report_citation_vectors.json'), 'utf8'));

/* report-citation.js publishes window.KinReportCitation, which is not globalThis
 * under node --test; the client test loads it exactly this way. The section
 * takes the library as an argument, so the product file never depends on this. */
function loadCitation() {
  globalThis.window = globalThis.window || {};
  vm.runInThisContext(readFileSync(path.join(ROOT, 'worklist-v0', 'hpacs-lite', 'report-citation.js'), 'utf8'),
    { filename: 'report-citation.js' });
  assert.ok(globalThis.window.KinReportCitation, 'the module must publish window.KinReportCitation');
  return globalThis.window.KinReportCitation;
}
const C = loadCitation();

const ACTOR = 'doctor@kin';
const actorName = value => String(value ?? '').split('@')[0];
const EMPTY = { findings: '', conclusion: '', recommendation: '' };
const ATTRIBUTION = '인용 증적 확인: doctor의 열람 권한 기준';
const LIMITATION = '이 목록은 판독문 문장과 1:1로 대응하지 않습니다.';
const UNKNOWN = '인용 증적을 확인하지 못했습니다';
const REFUSED = '인용 증적을 확인하지 못했습니다 — 접근 권한 밖';
const NONE = '인용된 소견 없음';
const EDITOR = '현재 편집문 · 미확정 — 인용 증적은 이 출력에 싣지 않습니다. 서버 저장본 출력에서 확인하세요.';

/* The server's real projection for a readable entry: pacs.service.ts writes
 * exactly these keys (verifiedInsertion) and projectCitation adds sameTextCount.
 * Every value that must never reach paper is a distinctive sentinel; the two
 * integers are far from any revision, ordinal or timestamp digit group. */
const CID = 'SENTINELCIDAAAA', FINDING = 'SENTINELFINDINGBBBB';
const JOB = 'SENTINELJOBCCCC', MARK = 'SENTINELMARKDDDD', ITEM = 'SENTINELITEMEEEE';
const HEAD_REVISION = 918273, SOURCE_REVISION = 827364;
const SENTINELS = [CID, FINDING, JOB, MARK, ITEM, String(HEAD_REVISION), String(SOURCE_REVISION)];

function readable(over = {}) {
  return {
    v: 2, cid: CID, field: 'findings', findingId: FINDING, findingRevision: 2, sourceIndex: 0,
    sourceRef: { kind: 'job', jobId: JOB, markId: MARK, sourceRevision: SOURCE_REVISION },
    linkStateAtInsert: 'current', headRevisionAtInsert: HEAD_REVISION,
    insertedText: 'A line', insertedAt: '2026-09-19T05:00:00.000Z', insertedBy: 'doctor2@kin',
    sameTextCount: 1, ...over,
  };
}
function item(over = {}) {
  return readable({ cid: CID + '2', sourceRef: { kind: 'item', itemId: ITEM, sourceRevision: SOURCE_REVISION },
    headRevisionAtInsert: HEAD_REVISION, ...over });
}
/* What the server sends when this reader may not read the source finding. */
function reduced(over = {}) {
  return { cid: CID + '3', field: 'conclusion', insertedAt: '2026-09-19T06:30:00.000Z',
    insertedBy: 'doctor3@kin', state: 'source-unavailable', ...over };
}
const section = (state, entries, texts = EMPTY) =>
  preview.citationSection({ state, entries, texts, actorName, actor: ACTOR, citation: C });
const answer = (over = {}) => ({ version: 3, head: [], draft: [], ...over });

// ── P1 · one deterministic order: fields in printing order, stored order inside ──

test('the section is deterministic and groups entries by printed field order', () => {
  const entries = [readable({ field: 'recommendation', cid: 'r1' }), readable({ field: 'findings', cid: 'f1' }),
    readable({ field: 'conclusion', cid: 'c1' }), readable({ field: 'findings', cid: 'f2', findingRevision: 5 })];
  const first = section('ok', entries), second = section('ok', entries);
  assert.deepEqual(first, second, 'the same input must produce the same record');
  assert.equal(first.heading, '인용된 소견');
  const bodies = first.lines.slice(2);
  assert.deepEqual(bodies.map(line => line.split(' · ')[0]),
    ['Findings', 'Findings', 'Conclusion', 'Recommendation'], 'fields print in Findings→Conclusion→Recommendation order');
  // Stored order inside one field: f1 (r2) before f2 (r5).
  assert.ok(bodies[0].includes('소견 r2') && bodies[1].includes('소견 r5'), bodies.join('\n'));
});

// ── P2 · nothing that identifies a finding, a source or the inserted text ──

test('no identifier and no inserted text can reach the paper', () => {
  const entries = [readable(), item({ field: 'conclusion' }), reduced({ field: 'recommendation' })];
  const texts = { findings: 'A line', conclusion: 'A line', recommendation: '' };
  const printed = [section('ok', entries, texts), section('unknown', []), section('refused', []),
    section('ok', []), section('editor', [])]
    .map(part => [part.heading, ...part.lines].join('\n')).join('\n');
  for (const sentinel of SENTINELS)
    assert.ok(!printed.includes(sentinel), `the paper must not carry ${sentinel}:\n${printed}`);
  // insertedText is legitimate in the report body above, never in this section.
  assert.ok(!printed.includes('A line'), printed);
  // The metadata that IS allowed must still be there, or the assertion above
  // would pass on an empty section.
  assert.ok(printed.includes('소견 r2') && printed.includes('출처 1번'), printed);
});

// ── P3 · presence is the shipped rule, counted on the printed text ──

test('presence matches the shared oracle and an absent entry is never dropped', () => {
  for (const vector of VECTORS.occurrence) {
    const entry = readable({ insertedText: vector.block, sameTextCount: 1 });
    const texts = { ...EMPTY, findings: vector.body };
    const line = section('ok', [entry], texts).lines[2];
    const expected = C.STATE_TEXT[C.presenceOf(entry, vector.body)];
    assert.ok(line.endsWith(expected), `${vector.name}: ${line}`);
  }
  // An entry whose text the radiologist removed stays on the record and says so.
  const gone = section('ok', [readable({ insertedText: 'A line' })], EMPTY);
  assert.equal(gone.lines.length, 3, 'attribution + limitation + the entry');
  assert.ok(gone.lines[2].endsWith(C.STATE_TEXT.absent), gone.lines[2]);
  // A reduced entry keeps its place and claims nothing about the body.
  const hidden = section('ok', [reduced()], EMPTY);
  assert.ok(hidden.lines[2].endsWith(C.UNAVAILABLE_TEXT), hidden.lines[2]);
  for (const text of Object.values(C.STATE_TEXT)) assert.ok(!hidden.lines[2].includes(text), hidden.lines[2]);
  // Two entries for the same sentence are ambiguous, not both present.
  const twice = [readable({ cid: 'a', sameTextCount: 2 }), readable({ cid: 'b', sameTextCount: 2 })];
  for (const line of section('ok', twice, { ...EMPTY, findings: 'A line' }).lines.slice(2))
    assert.ok(line.endsWith(C.STATE_TEXT.ambiguous), line);
});

// ── P4 · terminal state → exact wording, and what a valid answer is ──

test('each terminal state maps to its own wording and only ok-0 may say 없음', () => {
  assert.deepEqual(section('ok', []).lines, [ATTRIBUTION, NONE]);
  assert.deepEqual(section('unknown', []).lines, [ATTRIBUTION, UNKNOWN]);
  assert.deepEqual(section('refused', []).lines, [ATTRIBUTION, REFUSED]);
  assert.deepEqual(section('editor', []).lines, [EDITOR]);
  for (const state of ['unknown', 'refused', 'editor'])
    assert.ok(!section(state, []).lines.join('\n').includes(NONE), state);
  // A state this file does not know is not an empty list either.
  assert.deepEqual(section('pending', []).lines, [ATTRIBUTION, UNKNOWN]);

  assert.equal(preview.citationAnswerOk(answer(), 3), true);
  assert.equal(preview.citationAnswerOk(answer({ head: [readable()], draft: [item()] }), 3), true);
  assert.equal(preview.citationAnswerOk(answer(), 4), false, 'a different head version is not this paper');
  assert.equal(preview.citationAnswerOk(answer({ version: '3' }), 3), false);
  assert.equal(preview.citationAnswerOk(answer({ head: null }), 3), false);
  assert.equal(preview.citationAnswerOk(answer({ draft: 'none' }), 3), false);
  assert.equal(preview.citationAnswerOk(null, 3), false);
  for (const bad of [null, 'entry', 7, { ...readable(), field: 'impression' }, { ...readable(), field: undefined }]) {
    assert.equal(preview.citationAnswerOk(answer({ head: [bad] }), 3), false, JSON.stringify(bad));
    assert.equal(preview.citationAnswerOk(answer({ draft: [bad] }), 3), false, JSON.stringify(bad));
  }
});

// ── P5 · the record wording itself ──

test('the record names the reader, the link state, UTC and its own limitation', () => {
  const states = { current: '현재 판과 일치', revised: '이후 개정됨', 'metadata-changed': '메타데이터 변경됨',
    hidden: '숨김 처리됨', missing: '찾을 수 없음' };
  for (const [value, korean] of Object.entries(states)) {
    const line = section('ok', [readable({ linkStateAtInsert: value })]).lines[2];
    assert.ok(line.includes(`인용 당시 연결 ${korean}`), line);
  }
  // An unrecognised value is neutral and is never echoed onto the record.
  const odd = section('ok', [readable({ linkStateAtInsert: 'SENTINELSTATE' })]).lines[2];
  assert.ok(odd.includes('인용 당시 연결 연결 상태 미확인'), odd);
  assert.ok(!odd.includes('SENTINELSTATE'), odd);

  const line = section('ok', [readable()]).lines[2];
  assert.ok(line.includes('2026-09-19 05:00(UTC)'), line);
  assert.ok(line.includes('doctor2'), line);
  assert.ok(!line.includes('doctor2@kin'), 'the paper shows the display name the screen shows');
  assert.ok(section('ok', [readable({ insertedAt: null })]).lines[2].includes('시각 미확인'));
  assert.ok(section('ok', [readable({ insertedBy: null })]).lines[2].includes('작성자 미확인'));
  assert.equal(section('ok', [readable({ field: 'conclusion' })]).lines[2].split(' · ')[0], 'Conclusion');

  // The limitation line exists exactly where a list is printed.
  assert.ok(section('ok', [readable()]).lines[1] === LIMITATION);
  for (const state of ['ok', 'unknown', 'refused'])
    assert.ok(!section(state, []).lines.includes(LIMITATION), state);
  assert.ok(!section('editor', []).lines.includes(LIMITATION));
  // The editor notice stands alone: no read was made under anyone's permissions.
  assert.ok(!section('editor', []).lines.includes(ATTRIBUTION));

  // The caveat qualifies '그대로 있습니다'; without such a line it qualifies nothing.
  const present = section('ok', [readable()], { ...EMPTY, findings: 'A line' });
  assert.equal(present.lines[present.lines.length - 1], C.PRESENT_CAVEAT);
  for (const part of [section('ok', [readable()], EMPTY), section('ok', [reduced()], EMPTY), section('ok', [])])
    assert.ok(!part.lines.includes(C.PRESENT_CAVEAT), part.lines.join('\n'));
});

// ── P6 · the node surface of the shipped module ──

test('the module still exports the saved label beside the citation wording', () => {
  assert.deepEqual(Object.keys(preview), ['savedLabel', 'citationSection', 'citationAnswerOk']);
  for (const name of Object.keys(preview)) assert.equal(typeof preview[name], 'function', name);
  assert.equal(typeof globalThis.KinReportPreview, 'function', 'the browser factory still reaches the page');
  // Loading the module must not need a DOM: the job-print identity test and the
  // label test both require it in plain node.
  assert.equal(typeof globalThis.document, 'undefined');
});
