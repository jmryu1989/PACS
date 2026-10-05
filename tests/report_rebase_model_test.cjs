// TEST-S3-U3-CLIENT-MODEL: base-version origin, commit failure routing and the
// refused-head payload, taken from the real main.html source (no copy, no DOM).
// Run with: node --test tests/report_rebase_model_test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(process.env.KIN_REBASE_MAIN || join(__dirname, '../worklist-v0/hpacs-lite/main.html'), 'utf8');

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

const blockStart = html.indexOf('    let selectionSeq = 0;');
const blockEnd = html.indexOf('    function reportSource()', blockStart);
assert.ok(blockStart >= 0 && blockEnd > blockStart, 'The base-version block moved; re-pin the test');
// The selection sequence is counted by the page's work-context gate (S7-U5): the block runs against the shipped module.
const sandbox = vm.createContext({ work: require(join(__dirname, '../worklist-v0/hpacs-lite/work-context.js')).create() });
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

test('TEST-S3-U3-SELECTION: every selection change is countable, so A→B→A is not the same selection', () => {
  const start = call('selectionSeq');
  call('markSelectionChanged("1.2.3")');
  assert.equal(call('selectedUid'), '1.2.3');
  assert.equal(call('selectionSeq'), start + 1);
  call('markSelectionChanged("1.2.4")');
  call('markSelectionChanged("1.2.3")');
  assert.equal(call('selectedUid'), '1.2.3', 'the study is the same one again');
  assert.equal(call('selectionSeq'), start + 3, 'but the screen was redrawn twice, so the sequence must differ');
  // A deleted study clears the selection and that is a selection change too.
  call('markSelectionChanged(null)');
  assert.equal(call('selectedUid'), null);
  assert.equal(call('selectionSeq'), start + 4);
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

/**
 * A context whose globals are `stand` and, for any other name the running code reaches, main.html's own page-level
 * function of that name (or a fresh `new Map()` / `new Set()` when the page declares the name as one), taken from the
 * page when it is first reached. The test names only what it runs and what it stands in for; a page helper on the way
 * that is renamed, split or inlined changes nothing here (AGENTS 1-B). `reached` lists what was taken.
 */
function pageScope(stand) {
  const target = { ...stand }, reached = [];
  let context = null;
  const take = name => {
    const fn = new RegExp(`^    (async )?function ${name}\\(`, 'm').exec(html);
    if (fn && html.indexOf(`function ${name}(`) === fn.index + 4 + (fn[1] ? 6 : 0))
      return vm.runInContext(`(${fn[1] || ''}${extractFunction(html, name)})`, context);
    const store = new RegExp(`^    (?:const|let) ${name} = new (Map|Set)\\(\\);$`, 'm').exec(html);
    return store ? new (store[1] === 'Map' ? Map : Set)() : undefined;
  };
  const scope = new Proxy(target, {
    has: (t, name) => name in t || typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name)
      && new RegExp(`^    (?:(?:async )?function ${name}\\(|(?:const|let) ${name} = new (?:Map|Set)\\(\\);$)`, 'm').test(html),
    get: (t, name) => {
      if (name in t || typeof name !== 'string') return t[name];
      const value = take(name);
      if (value !== undefined) { t[name] = value; reached.push(name); return value; }
      // The language's own globals (Set, Promise, JSON, ...): a scope object that is a proxy is asked for those too.
      return globalThis[name];
    },
  });
  context = vm.createContext(scope);
  return { context, reached };
}

/**
 * The shipped stashReport() over the shipped base-version block, executed (AGENTS 1-B, D73: the assertion below looks at
 * the base version the save carries and keeps, not at how the function reads it). The study was rendered at one version
 * (the block records it) and `state` is what the page holds for it afterwards (a poll may have moved its version). What
 * the function reads around itself are stand-ins; `sent` is the body of every draft write it sends.
 */
async function stashAfterRender({ rendered, state }) {
  const UID = '1.2.3', OWNER = { institution: 'SYN-INST', sub: 'syn-sub', author: 'syn-reader' }, sent = [];
  // The page's own modules, as shipped (S7-U5): the gate at work for one session, the transport over a server that
  // answers as the wire contract says (a full read of the draft, then the envelope of the write), the draft command path.
  const lite = join(__dirname, '../worklist-v0/hpacs-lite');
  const work = require(join(lite, 'work-context.js')).create();
  work.follow({ onLifecycle(listener) { listener({ state: 'active', session: 'SYN-SESSION' }); } });
  let revision = 0, stored = null;
  const envelope = () => ({ uid: UID, owner: OWNER, revision: `SYNEPOCH:${revision}`, present: !!stored, snapshot: stored,
    updatedAt: stored ? '2026-10-04T00:00:00.000Z' : null });
  const transport = require(join(lite, 'session-transport.js')).create({ gate: work, fetch: async (url, init) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      sent.push(body);
      revision += 1;
      stored = { findings: body.findings, conclusion: body.conclusion, recommendation: body.recommendation,
        baseVersion: body.baseVersion, citations: body.citationIds, structured: body.structureIds };
    }
    return new Response(JSON.stringify(envelope()), { status: 200 });
  } });
  const draftClient = require(join(lite, 'report-draft-client.js')).create({ transport, base: '/api' });
  draftClient.observe(UID, 'SYNEPOCH:0', state.draft ?? null);
  const { context } = pageScope({
    work, draftClient, reportConverge: new Set(),
    citations: { emptied() {} }, structureState: { emptied() {} },
    $: selector => ({ value: selector === '#findings' ? 'SYN typed findings' : '' }),
  });
  vm.runInContext(html.slice(blockStart, blockEnd), context, { filename: 'base-version-block.js' });
  vm.runInContext([
    `markSelectionChanged(${JSON.stringify(UID)});`,
    rendered === undefined ? '' : `recordReportOrigin(${JSON.stringify(UID)}, ${JSON.stringify(rendered)});`,
    `var appState = {}; appState[selectedUid] = ${JSON.stringify(state)};`,
    'var insertInFlight = false, serverMode = true, offline = false, demoMode = false, API = "/api";',
    'var reportSaveFailures = new Map();',
    `var RFIELDS = ["findings", "conclusion", "recommendation"], draftOwner = ${JSON.stringify(OWNER)};`,
    'var KinAuth = { has: role => role === "radiologist" };',
    'function heldByOther() { return false; } function cur() { return null; } function reportNeedsWrite() { return true; }',
    'function renderDraftBar() {} function saveApp() {} function draftNotSaved() {}',
    // The scanner above returns the function without its `async` keyword. stashReport keeps the text and hands the
    // write to the page's draft write (the same one the autosave of every retained study uses); what that reaches on
    // the page is taken from the page as it is reached (pageScope).
    'async ' + extractFunction(html, 'stashReport'),
    'var outcome = stashReport();',
  ].join('\n'), context, { filename: 'stashReport.js' });
  const outcome = await context.outcome;
  const draft = JSON.parse(vm.runInContext('JSON.stringify(appState[selectedUid].draft ?? null)', context));
  return { sent, outcome, draft };
}

test('TEST-S3-U3-WIRING: the shipped callers use the rendered base and the preserved error body', async () => {

  // Executed: the screen rendered v2; a poll has since put v5 into the page's state. The first stash carries the base the
  // text was written on (2) and keeps it in the local draft - not the version nobody has seen on this screen.
  const first = await stashAfterRender({ rendered: 2, state: { version: 5 } });
  assert.deepEqual([first.sent.length, first.sent[0]?.baseVersion, first.draft?.baseVersion, first.outcome], [1, 2, 2, 'saved'],
    'the first stash must carry the rendered base');
  // A later stash of the same screen still stands on the rendered version, whatever the stored draft and the poll say.
  const again = await stashAfterRender({ rendered: 2, state: { version: 5, draft: { findings: 'SYN earlier', baseVersion: 4 } } });
  assert.equal(again.sent[0].baseVersion, 2);
  // Without a recorded render the base falls back to what the page holds: the draft's base first, else the version.
  assert.equal((await stashAfterRender({ state: { version: 5, draft: { findings: 'SYN earlier', baseVersion: 3 } } })).sent[0].baseVersion, 3);
  assert.equal((await stashAfterRender({ state: { version: 5 } })).sent[0].baseVersion, 5);
  // Every draft write carries the whole snapshot and the revision it stands on (S7-U5): the base version is part of it.
  assert.deepEqual([first.sent[0].expectedRevision, first.sent[0].findings, first.sent[0].citationIds, first.sent[0].structureIds],
    ['SYNEPOCH:0', 'SYN typed findings', [], []]);
  // Log out's preparation freezes the text and the base it took when it began; tests/auth_logout_dom_test.py (S01) holds
  // that capture against the real page, so it is not repeated on a stand-in here.

  // The rebase DOM suite checks refusal bodies, selection races, the visible base and unchanged text.
});
