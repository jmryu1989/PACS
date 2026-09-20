'use strict';
/* TEST-S3-U5-JOB-PRINT-CITATION: the pure decisions behind the job print page's citation evidence.
 *
 * REQ-S3-U5-JOB-PRINT-CITATION -> RISK-S3-U5-EVIDENCE-LESS-PAGE / CROSS-STUDY-EVIDENCE /
 * FALSE-EMPTY / SURFACE-DIVERGENCE -> TEST-S3-U5-JOB-PRINT-CITATION.
 *
 * Four failures this file exists to catch, none of which needs a browser:
 *   1. A printed report page is planned without its evidence, or an unsaved draft is
 *      planned WITH evidence it cannot have.
 *   2. A refusal or a failure is read as 'this report cites nothing'.
 *   3. The re-typed api() stub used by the browser test outlives the product rule it
 *      imitates, so the 403 case silently stops testing anything.
 *   4. The two output surfaces drift apart and one signed report is described in two
 *      different ways.
 *
 * Pure: reads the shipped modules only. No stack, no container, no browser, no
 * network, no database.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const identity = require('../worklist-v0/hpacs-lite/viewer-job-print.js');
const paper = require('../worklist-v0/hpacs-lite/report-preview.js');

/* report-citation.js publishes window.KinReportCitation, which is not globalThis
 * under node --test; report_preview_citation_test.cjs loads it exactly this way. */
function loadCitation() {
  globalThis.window = globalThis.window || {};
  vm.runInThisContext(readFileSync(path.join(ROOT, 'worklist-v0', 'hpacs-lite', 'report-citation.js'), 'utf8'),
    { filename: 'report-citation.js' });
  assert.ok(globalThis.window.KinReportCitation, 'the module must publish window.KinReportCitation');
  return globalThis.window.KinReportCitation;
}
const C = loadCitation();

const saved = (uid, version) => ({ uid, report: { version, rs: 'A', findings: 'F', conclusion: 'C', recommendation: 'R' } });
const draftEntry = uid => ({ uid, draft: true, report: { version: null, rs: null, unsaved: true } });

test('P1: the printed entries decide which pages need a read, and an unsaved body never does', () => {
  // The report choice is deliberately not an input here. state() has already
  // resolved it into this list; the choice-to-uid mapping it used is checked by
  // the DOM cases, not by this function.
  assert.deepEqual(identity.citationTargets([saved('a', 1), saved('b', 4)]),
    [{ uid: 'a', mode: 'read' }, { uid: 'b', mode: 'read' }]);
  assert.deepEqual(identity.citationTargets([draftEntry('a'), saved('b', 2)]),
    [{ uid: 'a', mode: 'editor' }, { uid: 'b', mode: 'read' }]);
  // A study with no saved report draws no section, so it asks nothing.
  assert.deepEqual(identity.citationTargets([saved('a', 0)]), [{ uid: 'a', mode: 'none' }]);
  for (const version of [null, undefined, '1', 1.5, -1, NaN])
    assert.deepEqual(identity.citationTargets([saved('a', version)]), [{ uid: 'a', mode: 'none' }],
      'version ' + String(version));
  // Images only: no report entries at all.
  assert.deepEqual(identity.citationTargets([]), []);
  assert.deepEqual(identity.citationTargets(undefined), []);
  // A draft entry is an editor page whatever its report field says.
  assert.deepEqual(identity.citationTargets([{ uid: 'a', draft: true, report: { version: 3 } }]),
    [{ uid: 'a', mode: 'editor' }]);
});

test('P2: every api() failure maps to one named outcome, and the product rule the stub imitates still reads that way', () => {
  const cases = [
    [{ aborted: true }, 'rethrow'],
    [{ aborted: true, status: 403 }, 'rethrow'],
    [{ live: false }, 'rethrow'],
    [{ live: false, status: 404 }, 'rethrow'],
    [{ aborted: false, live: true, status: 403 }, 'refused'],
    [{ aborted: false, live: true, status: 404 }, 'unknown'],
    [{ aborted: false, live: true, status: 500 }, 'unknown'],
    [{ aborted: false, live: true, status: 409 }, 'unknown'],
    [{ aborted: false, live: true, name: 'TypeError' }, 'unknown'],
    // api() runs its own timer per call, so an AbortError is only this unit's
    // event when the caller's signal says so.
    [{ aborted: false, live: true, name: 'AbortError' }, 'unknown'],
    [{ aborted: false, live: true }, 'unknown'],
    [{}, 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [input, expected] of cases)
    assert.equal(identity.citationTerminal(input), expected, JSON.stringify(input));
  // The browser case for 'refused' runs against a re-typed copy of this line,
  // so if the product stops attaching .status to a foreign 403 the stub would
  // keep passing on its own. Pin the shipped text instead.
  const jobs = readFileSync(path.join(ROOT, 'worklist-v0', 'hpacs-lite', 'viewer-jobs.js'), 'utf8');
  assert.ok(jobs.includes("r.status === 401 || r.status === 403 && !foreign"),
    'viewer-jobs.js no longer ends the panel on 401 / non-foreign 403 in the form the stub imitates');
  assert.ok(jobs.includes("const { idempotent = false, foreign = false, ...request } = options;"),
    'viewer-jobs.js no longer accepts the foreign option');
});

test('P3: the pure record the viewer reads is the same object the node tests receive', () => {
  // The job print dialog lives in the viewer document, which never loads the
  // preview factory; a second copy of this wording is how two papers start
  // disagreeing about one citation.
  assert.ok(globalThis.KinReportPaper, 'report-preview.js must publish globalThis.KinReportPaper');
  for (const name of ['savedLabel', 'citationSection', 'citationAnswerOk']) {
    assert.equal(typeof paper[name], 'function', name);
    assert.equal(globalThis.KinReportPaper[name], paper[name], name + ' must be the same function');
  }
  assert.deepEqual(Object.keys(globalThis.KinReportPaper).sort(),
    ['citationAnswerOk', 'citationSection', 'savedLabel']);
});

test('P4: the identity helper keeps every name it published and adds the two new pure decisions', () => {
  assert.equal(typeof globalThis.kinViewerJobPrint, 'function');
  for (const name of ['normalizeStudyDate', 'dateText', 'dateRelation', 'relationText', 'reportTitle',
    'reportLabel', 'optionLabel', 'reportEntry', 'studyLine', 'dateLine', 'summaryText', 'pageIdentity',
    'pageName', 'cssContent', 'pageRules', 'sourceBytes', 'citationTargets', 'citationTerminal'])
    assert.equal(typeof identity[name], 'function', name);
  assert.equal(Object.keys(identity).length, 18);
});

test('P5: both output surfaces print the same line, and the person column is the only difference', () => {
  // The viewer holds no name map and this page names people by their raw actor
  // everywhere else, so the two surfaces may differ HERE and nowhere else.
  // Sentinel names make that boundary a value, not a column position.
  const READER = 'actor-reader', INSERTER = 'actor-inserter';
  const DISPLAY = { [READER]: 'READERSHOWN', [INSERTER]: 'INSERTERSHOWN' };
  const previewName = value => DISPLAY[String(value ?? '')] ?? String(value ?? '');
  const rawName = value => (value === null || value === undefined ? '' : String(value));
  const entries = [
    { field: 'findings', findingRevision: 11, sourceIndex: 0, linkStateAtInsert: 'current',
      insertedBy: INSERTER, insertedAt: '2026-09-01T03:04:05Z', insertedText: 'BODY LINE', sameTextCount: 1 },
    { field: 'conclusion', findingRevision: 22, sourceIndex: 6, linkStateAtInsert: 'revised',
      insertedBy: INSERTER, insertedAt: '2026-09-02T06:07:08Z', insertedText: 'GONE', sameTextCount: 1 },
    // A source this reader cannot see: the line keeps its count and claims nothing.
    { field: 'recommendation', state: 'source-unavailable', insertedBy: INSERTER,
      insertedAt: '2026-09-03T09:10:11Z' },
  ];
  const texts = { findings: 'BODY LINE\n', conclusion: 'OTHER', recommendation: '' };
  const call = actorName => paper.citationSection({ state: 'ok', entries, texts, actorName, actor: READER, citation: C });
  const shown = call(previewName), raw = call(rawName);
  assert.equal(shown.heading, raw.heading);
  assert.equal(shown.lines.length, raw.lines.length);
  assert.ok(shown.lines.length >= 5, shown.lines);
  const folded = shown.lines.map(line =>
    line.split(DISPLAY[READER]).join(READER).split(DISPLAY[INSERTER]).join(INSERTER));
  assert.deepEqual(folded, raw.lines);
  // The difference is real, not vacuous: the two renderings are not identical.
  assert.notDeepEqual(shown.lines, raw.lines);
  // And the raw rendering is what the viewer page actually prints.
  assert.ok(raw.lines[0].includes('인용 증적 확인: ' + READER + '의 열람 권한 기준'), raw.lines[0]);
  assert.ok(raw.lines.some(line => line.includes(' · ' + INSERTER + ' · ')), raw.lines);
  // An empty actor still falls back rather than printing 'null'.
  const anonymous = paper.citationSection({ state: 'unknown', entries: [], texts, actorName: rawName,
    actor: null, citation: C });
  assert.deepEqual(anonymous.lines, ['인용 증적 확인: 확인자 미확인의 열람 권한 기준',
    '인용 증적을 확인하지 못했습니다']);
});
