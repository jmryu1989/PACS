// TEST-S3-U3-CLIENT-MODEL: base-version origin, commit failure routing and the
// refused-head payload, taken from the real main.html source (no copy, no DOM).
// Run with: node --test tests/report_rebase_model_test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '../worklist-v0/hpacs-lite/main.html'), 'utf8');

/** The shipped function body, brace matched, so a test can never drift into a copy. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} is gone from main.html`);
  // The body starts after the parameter list: a destructured parameter carries
  // braces of its own, and matching those would return half a signature.
  let depth = 0, quote = null, escaped = false, open = -1;
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) { open = source.indexOf('{', i); break; }
  }
  assert.ok(open > start, `unbalanced parameter list for ${name}`);
  depth = 0; quote = null; escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const blockStart = html.indexOf('    const reportOrigin = new Map();');
const blockEnd = html.indexOf('    function reportSource()', blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'The base-version block moved; re-pin the test');
const sandbox = vm.createContext({});
vm.runInContext(html.slice(blockStart, blockEnd), sandbox);
const call = (expression, value) => { sandbox.__input = value; return vm.runInContext(expression, sandbox); };

test('TEST-S3-U3-ORIGIN: only a recorded render decides the base, and the fallback is untouched until then', () => {
  assert.equal(call('reportBaseVersion("1.2.3", 9)'), 9, 'unknown study must fall back, not invent 0');
  call('recordReportOrigin("1.2.3", 2)');
  assert.equal(call('reportBaseVersion("1.2.3", 9)'), 2, 'a refreshed appState version must not win over the rendered one');
  assert.equal(call('reportBaseVersion("1.2.4", 7)'), 7, 'the record belongs to one study only');
  // A version that is not a real version number must not become a base that the
  // server would then accept as "the version this text stands on".
  for (const bad of ['3', 3.5, NaN, Infinity, -1, null, undefined, {}, []]) {
    call('recordReportOrigin("1.2.5", __input)', bad);
    assert.equal(call('reportBaseVersion("1.2.5", 9)'), 0, `rejected value ${String(bad)}`);
  }
  call('recordReportOrigin("", 5)');
  assert.equal(call('reportBaseVersion("", 4)'), 4, 'no selected study, nothing to record');
});

test('TEST-S3-U3-ORIGIN: the rendered origin is the version the visible text stands on', () => {
  assert.equal(call('renderedOrigin(__input)', { version: 3 }), 3);
  assert.equal(call('renderedOrigin(__input)', { version: 5, draft: { baseVersion: 2 } }), 2,
    'a drafted screen stands on the version the draft was written against');
  assert.equal(call('renderedOrigin(__input)', { version: 5, draft: {} }), 5, 'a local draft without a base falls back');
  assert.equal(call('renderedOrigin(__input)', { version: 5, draft: { baseVersion: 0 } }), 0);
  assert.equal(call('renderedOrigin(__input)', { version: 4, draft: { baseVersion: 1 }, prelimHidden: true }), 4,
    'a hidden preliminary draft is not on the screen');
  assert.equal(call('renderedOrigin(__input)', {}), 0);
  assert.equal(call('renderedOrigin(__input)', null), 0);
});

test('TEST-S3-U3-ROUTE: the error code is read before the message, so a stale refusal never reloads', () => {
  const route = value => call('commitFailureRoute(__input)', value);
  assert.equal(route({ code: 'REPORT_DRAFT_STALE', message: '초안이 낡았습니다' }), 'stale');
  // The destructive branch is selected by a substring. A refusal that happens to
  // contain it must still be routed by its code.
  assert.equal(route({ code: 'REPORT_DRAFT_STALE', message: '다른 사용자가 v3을 저장했습니다' }), 'stale');
  assert.equal(route({ code: 'REPORT_HELD', message: '저장했습니다' }), 'held');
  assert.equal(route({ message: '그 사이 doctor가 v3을 저장했습니다. 내용을 다시 불러온 뒤 작성해 주세요.' }), 'reload');
  assert.equal(route({ code: 'REPORT_CITATION_LIMIT', message: '인용이 너무 많습니다' }), 'toast');
  assert.equal(route({ message: 'HTTP 500' }), 'toast');
  assert.equal(route({}), 'toast');
  assert.equal(route(null), 'toast');
  assert.equal(route(undefined), 'toast');
  assert.equal(route({ code: 'report_draft_stale' }), 'toast', 'the code is compared exactly');
  assert.equal(route({ code: ['REPORT_DRAFT_STALE'] }), 'toast');
});

test('TEST-S3-U3-PAYLOAD: the approved report shown to the human comes from the refusal body, byte for byte', () => {
  const head = value => call('staleHeadOf(__input)', value);
  const body = {
    code: 'REPORT_DRAFT_STALE', draftBaseVersion: 2,
    head: {
      version: 4, updatedBy: 'doctor2@kin',
      findings: 'LINE ONE\r\n  trailing spaces   \nLINE TWO\n',
      conclusion: '', recommendation: '결론 없음',
    },
  };
  const got = head({ code: 'REPORT_DRAFT_STALE', body });
  assert.equal(got.version, 4);
  assert.equal(got.updatedBy, 'doctor2@kin');
  assert.equal(got.findings, body.head.findings, 'newlines and edge whitespace must survive the display path');
  assert.equal(got.conclusion, '');
  assert.equal(got.recommendation, '결론 없음');
  assert.equal(got.draftBaseVersion, 2);

  // Nothing may be presented as "the approved report" unless the server sent it
  // in that exact shape: an invented pane is worse than a plain failure toast.
  assert.equal(head({ code: 'REPORT_DRAFT_STALE' }), null, 'a dropped body must not become an empty approved report');
  assert.equal(head({ body: {} }), null);
  assert.equal(head({ body: { head: null } }), null);
  assert.equal(head({ body: { head: 'v4' } }), null);
  for (const version of [0, -1, 1.5, '4', null, undefined, NaN])
    assert.equal(head({ body: { head: { version, findings: 'x' } } }), null, `version ${String(version)}`);
  const coerced = head({ body: { head: { version: 1, updatedBy: 7, findings: { a: 1 }, conclusion: ['x'], recommendation: null } } });
  assert.deepEqual({ ...coerced }, { version: 1, updatedBy: '', findings: '', conclusion: '', recommendation: '', draftBaseVersion: null },
    'non-text must render as empty, never as [object Object]');
  assert.equal(head({ body: { draftBaseVersion: '2', head: { version: 1 } } }).draftBaseVersion, null);
});

test('TEST-S3-U3-WIRING: the shipped callers use the rendered base and the preserved error body', () => {
  const api = extractFunction(html, 'api');
  assert.match(api, /body: j \}\);/, 'api() must keep the error body for the approved-report pane');

  const stash = extractFunction(html, 'stashReport');
  assert.match(stash, /const baseVersion = reportBaseVersion\(uid,/, 'the first stash must carry the rendered base');

  const commit = extractFunction(html, 'commitReport');
  assert.match(commit, /reportBaseVersion\(uid, appState\[uid\]\?\.version \?\? 0\)/);
  assert.doesNotMatch(commit, /baseVersion: appState\[uid\]\?\.version \?\? 0/,
    'a commit that carries the polled version defeats the optimistic lock');
  const routed = commit.indexOf('commitFailureRoute(e)'), substring = commit.indexOf('저장했습니다');
  assert.ok(routed >= 0 && substring > routed, 'the code branch must be decided before the substring branch');
  const stale = commit.slice(commit.indexOf('route === "stale"'), commit.indexOf('route === "reload"'));
  assert.doesNotMatch(stale, /loadReport|\.value/, 'a stale refusal must not redraw or rewrite the editor');

  const load = extractFunction(html, 'loadReport');
  assert.match(load, /if \(!preserveValue\) recordReportOrigin\(selectedUid, renderedOrigin\(r\)\);/,
    'only a real render may move the base');
  assert.equal(load.indexOf('recordReportOrigin') < load.indexOf('el.value = locked'), true,
    'the recorded version belongs to the values this call is about to write');

  const rebase = extractFunction(html, 'rebaseDraft');
  assert.match(rebase, /baseVersion: pane\.head\.version/, 'the rebase must carry exactly the displayed version');
  assert.doesNotMatch(rebase, /appState\[pane\.uid\]\?\.version|loadReport/,
    'the rebase must not adopt an unseen version nor redraw the editor');
  assert.match(rebase, /pane\.uid !== selectedUid \|\| pane\.seq !== staleSeq/, 'the pane is bound to one study and one sequence');
});
