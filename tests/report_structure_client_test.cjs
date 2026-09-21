// TEST-S3-STRUCT-CLIENT: the browser-side structured-entry rules and their wiring coordinates.
//
//   node --test tests/report_structure_client_test.cjs
//
// Pure: no DOM, no network, no container. The module is required in plain Node, which is only
// possible because it takes the citation library as an argument instead of reaching for a global
// (the lesson of U4 pin C4 - `window.KinReportCitation` is not `globalThis.KinReportCitation`).
//
// What this file does NOT prove: that the page runs this code. The string assertions at the end are
// coordinates, not behaviour; D1-D15 in the hosted DOM test are what execute it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LITE = path.join(ROOT, 'worklist-v0', 'hpacs-lite');
globalThis.window = globalThis.window || {};
require(path.join(LITE, 'report-citation.js'));
const C = globalThis.window.KinReportCitation;
const S = require(path.join(LITE, 'report-structure.js'));
const VECTORS = require('./report_structure_vectors.json');
const MAIN = fs.readFileSync(path.join(LITE, 'main.html'), 'utf8');

const CATALOG = VECTORS.catalog;
const form = S.create(C, CATALOG);
const item = code => CATALOG[0].items.find(i => i.code === code);
const entry = (over = {}) => ({ v: 1, sid: 's-1', field: 'findings', templateId: 'SYN-T1', templateRevision: 2,
  itemCode: 'SYN-CHOICE', valueType: 'choice', value: 'c1', unit: null,
  renderedText: 'SYNTHETIC-ITEM choice = alpha', enteredAt: '2026-09-21T00:00:00.000Z',
  enteredBy: 'doctor@synthetic', ...over });

test('the module loads in plain Node and publishes the same object on window', () => {
  assert.equal(globalThis.window.KinReportStructure, S);
  assert.throws(() => S.create(null, CATALOG), /citation library/);
});

test('the PRODUCT catalog is empty, so the form reports itself empty', () => {
  // P6: with an empty catalog main.html never creates the Structured button, and this is the
  // property it asks for. The day D2 is answered this test keeps passing with a real catalog only
  // because it asks the product constant directly.
  assert.deepEqual(S.PRODUCT_CATALOG, []);
  assert.equal(S.create(C, S.PRODUCT_CATALOG).empty, true);
  assert.equal(form.empty, false);
});

test('renderItem reproduces every shared vector byte for byte', () => {
  for (const vector of VECTORS.render)
    assert.equal(form.renderItem(item(vector.itemCode), vector.value), vector.rendered,
      `${vector.itemCode} / ${JSON.stringify(vector.value)}`);
});

test('validateValue refuses every shared invalid vector and accepts every valid one', () => {
  for (const vector of VECTORS.invalid)
    assert.notEqual(form.validateValue(item(vector.itemCode), vector.value), null, vector.why);
  for (const vector of VECTORS.render)
    assert.equal(form.validateValue(item(vector.itemCode), vector.value), null);
});

/* ── P12: the same catalog rules, on this side ───────────────────────────────────────────── */

const catalogRule = catalog => {
  try { S.validateCatalog(C, catalog); return 'ACCEPT'; }
  catch (e) {
    assert.ok(e instanceof S.CatalogError, `not a catalog error: ${e && e.message}`);
    assert.ok(e.message.startsWith(e.rule + ': '), 'the message must name its own rule');
    return e.rule;
  }
};

test('every shared catalog vector gets exactly the rule it names, on this side too', () => {
  // B6. The server test asserts the same table against the compiled module; the vectors are what
  // bind the two implementations, so a rule that drifted on one side fails on that side alone.
  assert.ok(VECTORS.catalogVectors.length >= 30, 'the shared catalog vectors are missing');
  for (const vector of VECTORS.catalogVectors)
    assert.equal(catalogRule(vector.catalog), vector.rule, `${vector.name} - ${vector.why}`);
  assert.equal(catalogRule(CATALOG), 'ACCEPT');
  assert.equal(catalogRule(S.PRODUCT_CATALOG), 'ACCEPT');
});

test('every shared entry vector is decided by validateValue, before anything is sent', () => {
  // The screen has to refuse a value that composes across the sentence boundary, and has to say so
  // in words - the server would refuse it anyway, but only after the reader pressed Apply.
  assert.ok(VECTORS.entryVectors.length >= 10, 'the shared entry vectors are missing');
  for (const vector of VECTORS.entryVectors) {
    const entryForm = S.create(C, vector.catalog);
    assert.equal(entryForm.invalid, undefined, `${vector.name}: the case catalog itself must be legal`);
    const entryItem = entryForm.findItem(vector.templateId, vector.itemCode);
    const message = entryForm.validateValue(entryItem, vector.value);
    if (vector.expect === 'ACCEPT')
      assert.equal(message, null, `${vector.name} - ${vector.why}`);
    else
      assert.equal(message, S.MESSAGES.boundary, `${vector.name} - ${vector.why}`);
  }
});

test('an illegal catalog closes the form instead of throwing, and says which rule', () => {
  /**
   * B3/F4. `main.html` loads this module in one `<script>` with the rest of the worklist. An
   * exception here would take the whole page down - no list, no report, no autosave - because one
   * template was wrong. So `create()` returns the SAME inert object an empty catalog gives, plus a
   * diagnostic. The loud failure is the server refusing to boot, where it costs nothing.
   */
  const seen = [];
  const real = console.error;
  console.error = (...args) => seen.push(args.join(' '));
  let closed;
  try { closed = S.create(C, VECTORS.catalogVectors.find(v => v.rule === 'R-B').catalog); }
  finally { console.error = real; }
  assert.equal(closed.empty, true);
  assert.deepEqual(closed.catalog, []);
  assert.equal(typeof closed.invalid, 'string');
  assert.ok(closed.invalid.startsWith('R-B: '), closed.invalid);
  assert.equal(seen.length, 1, 'said once, not once per item');
  assert.match(seen[0], /report-structure/);
  // The inert form still answers every question main.html asks of it, so nothing downstream throws.
  assert.deepEqual(closed.templates(), []);
  assert.equal(closed.findTemplate('SYN-T1'), null);
  assert.equal(closed.unknownRevision(entry()), true);
});

test('a valid EMPTY catalog is silent, and is not the same thing as a refused one', () => {
  // The distinction matters: empty is the shipped, normal, deliberate state (P6). If both looked
  // alike, a broken catalog would ship as "no structured entry yet" and nobody would hear it.
  const seen = [];
  const real = console.error;
  console.error = (...args) => seen.push(args.join(' '));
  let empty;
  try { empty = S.create(C, S.PRODUCT_CATALOG); }
  finally { console.error = real; }
  assert.equal(empty.empty, true);
  assert.equal(empty.invalid, undefined, 'nothing was refused');
  assert.deepEqual(seen, [], 'and nothing was reported');
  assert.equal(form.invalid, undefined, 'a legal non-empty catalog is silent too');
});

test('programming errors are not swallowed by the fail-closed path', () => {
  // The catch is typed on purpose. A missing citation library is a wiring mistake, not a catalog
  // that broke a rule, and hiding it would leave a page that silently does nothing.
  assert.throws(() => S.create(null, CATALOG), /citation library/);
  assert.throws(() => S.validateCatalog(null, CATALOG), e => !(e instanceof S.CatalogError));
});

test('the PRODUCT catalog is byte-for-byte the pinned canonical JSON', () => {
  // B8, the other half. The compiled server test pins the same string for STRUCTURE_CATALOG, and
  // the two constants are compared as VALUES - neither test reads the other's file.
  const canonical = value => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
      return '{' + Object.keys(value).sort()
        .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  };
  const sha = crypto.createHash('sha256').update(canonical([...S.PRODUCT_CATALOG]), 'utf8').digest('hex');
  assert.equal(sha, VECTORS.productCatalogSha256, 'PRODUCT_CATALOG is not the pinned catalog');
});

test('a value that is too long or not one line is refused before anything is sent', () => {
  assert.equal(form.validateValue(item('SYN-TEXT'), 'x'.repeat(512)), null);
  assert.equal(form.validateValue(item('SYN-TEXT'), 'x'.repeat(513)), S.MESSAGES.tooLong);
  // Built from the code point on purpose: U+2028 is invisible in a source file, and a reviewer has
  // to be able to see which character this case is about.
  assert.equal(form.validateValue(item('SYN-TEXT'), 'a' + String.fromCharCode(0x2028) + 'b'),
    S.MESSAGES.oneLine);
  assert.equal(S.isSingleLine('plain'), true);
  assert.equal(S.isSingleLine('a\tb'), false);
});

test('placePlan is the U6 primitive itself, not a second implementation', () => {
  // P10: the structure path reuses citationGuards unchanged. If this ever stopped delegating, the
  // caret rules and the guard back-off would have to be re-proved here.
  const body = 'first\nsecond', block = 'SYNTHETIC-ITEM boolean = yes';
  const at = { start: 5, end: 5 };
  const mine = form.placePlan(body, block, at, []);
  const theirs = C.placeBlock(body, block, at, []);
  assert.equal(mine.text, theirs.text);
  assert.equal(mine.start, theirs.start);
  assert.equal(mine.end, theirs.end);
  assert.equal(mine.line, theirs.line);
  assert.equal(mine.mode2, 'place');
  assert.equal(mine.removedLine, null);
});

test('replacePlan swaps exactly one occurrence in place and deletes nothing else', () => {
  const old = 'SYNTHETIC-ITEM number = 12.0 unit-x';
  const next = 'SYNTHETIC-ITEM number = 15.0 unit-x';
  const body = 'above\n' + old + '\nbelow';
  const plan = form.replacePlan(body, old, next, { start: 0, end: 0 }, []);
  assert.equal(plan.mode2, 'replace');
  assert.equal(plan.text, 'above\n' + next + '\nbelow');
  assert.equal(plan.removedLine, 2);
  assert.equal(plan.line, 2);
  assert.equal(plan.text.slice(plan.start, plan.end), next);
  // the line count is unchanged and every other line survives byte for byte
  assert.deepEqual(plan.text.split('\n').filter((_, i) => i !== 1), ['above', 'below']);
  assert.equal(C.lineBlockOccurrences(plan.text, next), 1);
  assert.equal(C.lineBlockOccurrences(plan.text, old), 0);
});

test('replacePlan places instead when the old line is already gone, and refuses when it is doubled', () => {
  const old = 'SYNTHETIC-ITEM number = 12.0 unit-x';
  const next = 'SYNTHETIC-ITEM number = 15.0 unit-x';
  const placed = form.replacePlan('typed only', old, next, { start: 10, end: 10 }, []);
  assert.equal(placed.mode2, 'place');
  assert.equal(placed.text, 'typed only\n' + next);
  const doubled = form.replacePlan(old + '\n' + old, old, next, { start: 0, end: 0 }, []);
  assert.equal(doubled.mode2, 'refuse');
  assert.equal(doubled.message, S.MESSAGES.ambiguous);
  assert.equal(doubled.text, undefined, 'a refusal carries no text to write');
});

test('replacePlan refuses inside a cited block rather than cutting it', () => {
  const old = 'SYNTHETIC-ITEM choice = alpha';
  const cited = 'cited head\n' + old + '\ncited tail';
  const plan = form.replacePlan('before\n' + cited, old, 'SYNTHETIC-ITEM choice = beta',
    { start: 0, end: 0 }, [cited]);
  assert.equal(plan.mode2, 'refuse');
  assert.equal(plan.message, S.MESSAGES.guarded);
});

test('samePlan is what makes a stale confirmation impossible', () => {
  // P8/D15: the plan shown when the form opened must still be the plan at Apply, or nothing is sent.
  const block = 'SYNTHETIC-ITEM boolean = yes';
  const shown = form.placePlan('one\ntwo', block, { start: 3, end: 3 }, []);
  assert.equal(form.samePlan(shown, form.placePlan('one\ntwo', block, { start: 3, end: 3 }, [])), true);
  assert.equal(form.samePlan(shown, form.placePlan('one\ntwo\nthree', block, { start: 3, end: 3 }, [])), false);
  assert.equal(form.samePlan(shown, form.placePlan('one\ntwo', block, { start: 7, end: 7 }, [])), false);
  assert.equal(form.samePlan(shown, null), false);
});

test('an entry written under another catalog revision is read-only, never re-rendered', () => {
  assert.equal(form.unknownRevision(entry()), false);
  assert.equal(form.unknownRevision(entry({ templateRevision: 1 })), true);
  assert.equal(form.unknownRevision(entry({ templateId: 'SYN-GONE' })), true);
  assert.equal(form.unknownRevision(entry({ itemCode: 'SYN-GONE' })), true);
});

test('the keep list is absent until the dedicated read confirmed it', () => {
  // The whole point: `undefined` omits the key (server changes nothing), `[]` means "clear mine".
  // Inventing `[]` before the read would delete attestations the screen has never seen.
  const state = S.createState();
  assert.equal(state.keepIds('u1'), undefined);
  assert.equal(state.known('u1'), false);
  state.confirm('u1', { version: 3, head: [entry({ sid: 'h-1' })], draft: [entry({ sid: 'd-1' })] });
  assert.equal(state.known('u1'), true);
  assert.deepEqual(state.keepIds('u1'), ['d-1']);
  state.unconfirm('u1');
  assert.equal(state.keepIds('u1'), undefined, 'an invalidated row must not carry a keep list');
  state.confirm('u1', { version: 3, head: [], draft: [] });
  assert.deepEqual(state.keepIds('u1'), [], 'an explicit empty list is a real answer');
});

test('an unknown answer is stored as unknown, not as none', () => {
  const state = S.createState();
  state.confirm('u1', { version: 2, unknown: true, head: null, draft: null });
  assert.equal(state.known('u1'), false);
  assert.equal(state.keepIds('u1'), undefined);
  assert.equal(state.get('u1').unknown, true);
});

test('emptied drops only my draft entries, forget drops the row', () => {
  const state = S.createState();
  state.confirm('u1', { version: 3, head: [entry({ sid: 'h-1' })], draft: [entry({ sid: 'd-1' })] });
  state.emptied('u1');
  assert.deepEqual(state.keepIds('u1'), []);
  assert.equal(state.get('u1').head.length, 1, 'the head row was not emptied');
  state.forget('u1');
  assert.equal(state.get('u1'), null);
  assert.equal(state.keepIds('u1'), undefined);
});

test('liveEntries is head union my draft, and the immutable head wins on a sid collision', () => {
  const head = [entry({ sid: 'x', value: 'c1' })];
  const draft = [entry({ sid: 'x', value: 'c2' }), entry({ sid: 'y' })];
  const live = S.liveEntries(head, draft);
  assert.deepEqual(live.map(e => e.sid), ['x', 'y']);
  assert.equal(live[0].value, 'c1');
  assert.equal(S.itemKey(entry()), 'SYN-T1\u0000SYN-CHOICE');
});

test('main.html clears the structure state everywhere it clears the citation state', () => {
  // P14. These are coordinates: they say the two states are cleared together, which is the property
  // that keeps a keep-list from deleting an attestation the screen never saw.
  const count = needle => MAIN.split(needle).length - 1;
  assert.equal(count('citations.forget(uid);'), 2);
  assert.equal(count('structureState.forget(uid);'), 2);
  assert.equal(count('citations.emptied(uid)'), 1);
  assert.equal(count('structureState.emptied(uid)'), 1);
  assert.match(MAIN, /if \(empty\) \{ citations\.emptied\(uid\); structureState\.emptied\(uid\); \}/);
  const lines = MAIN.split('\n');
  const citationCalls = lines
    .map((line, i) => ({ line, i }))
    .filter(row => /invalidateCitations\((epoch|pane)\.uid\)/.test(row.line));
  assert.equal(citationCalls.length, 3);
  for (const row of citationCalls)
    assert.ok(lines.slice(row.i, row.i + 9).some(l => l.includes('invalidateStructure(')),
      `no invalidateStructure near line ${row.i + 1}`);
});

test('main.html carries the keep list on both writes and asks for the dedicated read', () => {
  assert.match(MAIN, /const structureIds = structureState\.keepIds\(uid\);/);
  // Three writes carry it: the 20s autosave, the commit, and the structure apply itself - and each
  // only when the dedicated read confirmed the row. Any fourth write that forgets it would be a
  // write whose keep list says nothing, which is the safe direction but worth noticing.
  assert.equal(MAIN.split('...(structureIds ? { structureIds } : {})').length - 1, 3,
    'autosave, commit and apply carry it, and only when it is known');
  assert.match(MAIN, /ensureStructure\(selectedUid\);/);
  assert.match(MAIN, /report\/structure`\)/);
  // The button exists only when a catalog does. A disabled button would promise what nothing can do.
  assert.match(MAIN, /if \(!structureForm\.empty\) \{/);
  assert.equal(MAIN.includes('<button disabled>Structured'), false);
  assert.equal(MAIN.includes('id="b-structured"'), false, 'the button is created in script, not markup');
});

test('paper and history never fetch the structure route and never label anything structured', () => {
  // P15/D6-honesty. The sentences print because they are body text; no output path reads or names
  // the typed values, so nothing on paper can claim a structure it did not verify. This is asserted
  // statically because the printing paths are owned by the accepted U4/U5/U5b contracts and this
  // unit must be able to say it did not touch them.
  for (const name of ['report-preview.js', 'viewer-job-print.js', 'reading-findings.js']) {
    const text = fs.readFileSync(path.join(LITE, name), 'utf8');
    assert.equal(text.includes('report/structure'), false, `${name} must not read the structure route`);
    assert.equal(text.includes('KinReportStructure'), false, `${name} must not know the structure module`);
    // `structuredClone` is the platform's own name and says nothing about this unit.
    assert.equal(text.replace(/structuredClone/g, '').includes('structured'), false,
      `${name} must not label anything structured`);
  }
  // The history modal lives in main.html; it must not have grown a structure read either.
  const history = MAIN.slice(MAIN.indexOf('// ── 판독문 이력 ──'));
  assert.equal(history.includes('report/structure'), false);
});

test('the form is bound to the study it opened on, and the binding is checked first', () => {
  // B4. The order is the whole point: if the study check ran AFTER the plan refresh, the first
  // press would only re-plan on the other patient's textarea and the second press would find that
  // plan consistent and write patient A's entry into patient B's report.
  const apply = MAIN.slice(MAIN.indexOf('async function applyStructure()'));
  const body = apply.slice(0, apply.indexOf('\n    }\n'));
  assert.match(body, /pane\.uid !== selectedUid \|\| pane\.selSeq !== selectionSeq/);
  assert.ok(body.indexOf('pane.uid !== selectedUid') < body.indexOf('structurePlan(pane)'),
    'the study check must come before the plan is recomputed');
  assert.ok(body.indexOf('pane.uid !== selectedUid') < body.indexOf('api("PUT"'),
    'and before anything is sent');
  assert.match(body, /const uid = pane\.uid;/, 'the request uses the pinned study, not the selection');
  // opened-on binding and the sibling-modal close, the same coordinate the cite preview has
  assert.match(MAIN, /structPane = \{ uid: selectedUid, selSeq: selectionSeq \};/);
  assert.match(MAIN, /if \(!structPane\?\.busy\) closeStructure\(\);/);
  assert.ok(MAIN.indexOf('if (!citeBusy) closeCitePreview(false);')
    < MAIN.indexOf('if (!structPane?.busy) closeStructure();'),
    'both live in select(), next to each other');
});

test('the value shown for an item is my draft entry, not a superseded head entry', () => {
  // B3: after one Save the first value is a head entry; once it is replaced its sentence has left
  // the body, and offering it again would show the old value and plan to delete a line that is no
  // longer there.
  const fn = MAIN.slice(MAIN.indexOf('function structurePrevious('));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  assert.ok(body.indexOf('row.draft.find(same)') < body.indexOf('row.head.find(same)'),
    'my draft entry is consulted first');
  assert.match(body, /structureState\.known\(uid\)/, 'an unconfirmed row has no draft answer to give');
  assert.match(MAIN, /const previous = structurePrevious\(/);
});

test('replace mode previews the sentence that will be removed as well as the new one', () => {
  // B7/P3: this modal covers the report column, and replace is the only path here that deletes
  // body text. A line number alone cannot be checked by the person pressing the button.
  assert.match(MAIN, /\$\("#struct-removed"\)\.textContent = removing;/);
  assert.match(MAIN, /pane\.previous\.renderedText/);
  assert.match(MAIN, /id="struct-removed"/);
  // textContent only - the removed sentence carries a user-typed value just like the new one
  assert.equal(MAIN.includes('#struct-removed").innerHTML'), false);
});

test('every element the structure block reaches for exists in the markup', () => {
  // U3's lesson: a top-level `$("#id")` for an element that is not there throws while the page
  // loads, and then every DOM case dies before its assertion.
  const ids = new Set([...MAIN.matchAll(/\$\("#(struct[a-z-]*)"\)/g)].map(m => m[1]));
  assert.ok(ids.size >= 8, `expected the structure block to reach for its controls, saw ${ids.size}`);
  for (const id of ids)
    assert.ok(MAIN.includes(`id="${id}"`), `#${id} is referenced but not in the markup`);
});
