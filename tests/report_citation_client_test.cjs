const { movedFiles } = require('./page_source.cjs');
// TEST-S3-U2b-CITATION-CLIENT: the shipped client comparator, the R5 template and the per-study
// citation state, held against the same vector file the compiled server validator answers to.
//
// REQ-S3-U2b-CITATION-UI -> RISK-S3-FALSE-PRESENCE/SILENT-ATTESTATION-LOSS/INVENTED-KEEP-LIST
//   -> TEST-S3-U2b-CITATION-CLIENT.
//
// `worklist-v0/hpacs-lite/report-citation.js` is loaded and executed here, not copied: the state
// object this file drives is the very object `main.html` keeps per study. Contract 13 asks for one
// oracle behind two implementations, so every vector in tests/report_citation_vectors.json runs
// against this half; if the two halves ever disagree, the person is told a sentence is preserved on
// one surface and gone on the other.
//
// Pure: no DOM, no browser, no stack, no network. Run with:
//   node --test tests/report_citation_client_test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const MODULE_PATH = process.env.KIN_CITATION_JS || join(ROOT, 'worklist-v0/hpacs-lite/report-citation.js');
const vectors = JSON.parse(readFileSync(join(__dirname, 'report_citation_vectors.json'), 'utf8'));

/**
 * The shipped module, executed. A copy of its rules here would prove nothing about the product.
 * It runs in this realm on purpose: an array built inside a second vm context carries that
 * context's Array.prototype, and every deepStrictEqual below would then fail for a reason that
 * has nothing to do with citations.
 */
function loadModule() {
  globalThis.window = globalThis.window || {};
  vm.runInThisContext(readFileSync(MODULE_PATH, 'utf8'), { filename: 'report-citation.js' });
  assert.ok(globalThis.window.KinReportCitation, 'the module must publish window.KinReportCitation');
  return globalThis.window.KinReportCitation;
}
const C = loadModule();

const operands = vector => {
  const shift = value => value.normalize('NFD');
  return [vector.nfd === 'body' ? shift(vector.body) : vector.body,
          vector.nfd === 'block' ? shift(vector.block) : vector.block];
};
/**
 * n is a property of the citation set, and it must be keyed by the same equality k uses. The key
 * comes from the shipped entryKey(), so the vectors and the product cannot key apart; no control
 * byte is used as a separator, here or in the module.
 */
const sameTextCounts = entries => {
  const keys = entries.map(entry => C.entryKey(entry));
  return keys.map(key => keys.filter(other => other === key).length);
};

// Page wiring is exercised by report_citation_dom_test.py, report_cursor_insert_dom_test.py
// and auth_logout_dom_test.py (AM6: one click waits for the pending save).
test('TEST-S3-U2b-VECTORS: every occurrence vector answers the same as the server validator', () => {
  assert.equal(vectors.occurrence.length, 24, 'the occurrence section was thinned');
  for (const vector of vectors.occurrence) {
    const [body, block] = operands(vector);
    assert.equal(C.lineBlockOccurrences(body, block), vector.k, `${vector.name}: ${vector.why ?? ''}`);
  }
  // Without this the two NFC vectors could pass while comparing identical bytes.
  for (const vector of vectors.occurrence.filter(v => v.nfd)) {
    const [body, block] = operands(vector);
    const raw = vector.nfd === 'body' ? vector.body : vector.block;
    assert.notEqual(vector.nfd === 'body' ? body : block, raw, `${vector.name}: the operand was already decomposed`);
  }
});

test('TEST-S3-U2b-VECTORS: a blank block is refused and counts nothing', () => {
  assert.equal(vectors.blank.length, 8, 'the blank section was thinned');
  for (const vector of vectors.blank) {
    assert.equal(C.blockIsBlank(vector.block), vector.refused, vector.name);
    if (vector.refused) {
      assert.equal(C.lineBlockOccurrences('one\n\ntwo', vector.block), 0, `${vector.name}: a blank line must not satisfy a citation`);
      // The same block must also be refused before any report text is changed.
      assert.ok(C.refuseBlock(vector.block), `${vector.name}: the client must refuse it up front`);
    }
  }
});

test('TEST-S3-U2b-VECTORS: n and k are decided by one equality, so a shared occurrence reads ambiguous', () => {
  assert.equal(vectors.sameText.length, 7, 'the sameText section was thinned');
  for (const vector of vectors.sameText)
    assert.deepEqual(sameTextCounts(vector.entries), vector.counts, `${vector.name}: ${vector.why ?? ''}`);
  assert.equal(vectors.state.length, 7, 'the state section was thinned');
  for (const vector of vectors.state)
    assert.equal(C.presenceState(vector.k, vector.n), vector.state, vector.name);
  assert.equal(vectors.equivalence.length, 6, 'the equivalence section was thinned');
  for (const vector of vectors.equivalence) {
    const counts = sameTextCounts(vector.entries);
    assert.deepEqual(vector.entries.map(e => C.lineBlockOccurrences(vector.body, e.insertedText)), vector.k, vector.name);
    assert.deepEqual(counts, vector.counts, `${vector.name}: ${vector.why ?? ''}`);
    // presenceOf is the function the screen actually calls; drive it, not the rule behind it.
    const states = vector.entries.map((entry, i) =>
      C.presenceOf({ ...entry, sameTextCount: counts[i] }, vector.body));
    assert.deepEqual(states, vector.states, vector.name);
  }
});

test('TEST-S3-U2b-PRESENCE: a reduced entry claims nothing about the report text', () => {
  const body = 'A line\nsecond';
  const readable = { field: 'findings', insertedText: 'A line', sameTextCount: 1 };
  assert.equal(C.presenceOf(readable, body), 'present');
  assert.equal(C.presenceOf(readable, ''), 'absent');
  // The server sends four keys and one neutral state for a citation whose finding it may not show.
  const reduced = { cid: 'c1', field: 'findings', insertedAt: '2026-09-20T01:00:00Z', insertedBy: 'a@kin',
                    state: C.SOURCE_UNAVAILABLE };
  assert.ok(C.isReduced(reduced));
  assert.equal(C.presenceOf(reduced, body), null, 'a reduced entry has no text to compare');
  // A missing sameTextCount must not read as n=0: that would call every citation 'present'.
  assert.equal(C.presenceOf({ field: 'findings', insertedText: 'A line' }, body), 'present');
  for (const bad of [0, -1, 1.5, '2', null, undefined])
    assert.equal(C.presenceOf({ field: 'findings', insertedText: 'A line', sameTextCount: bad }, body), 'present');
  assert.equal(C.presenceOf({ field: 'findings', insertedText: 'A line', sameTextCount: 2 }, body), 'ambiguous');
  // An entry naming a field that is not a report field must not be compared against another one.
  assert.equal(C.FIELDS.includes('impression'), false);
});

test('TEST-S3-U2b-R5: one deterministic template, exact bytes, no invented sentence', () => {
  assert.equal(vectors.assembly.length, 8, 'the assembly section was thinned');
  for (const vector of vectors.assembly) {
    const built = C.assembleBlock({ title: vector.title, text: vector.text, characteristics: vector.characteristics });
    if (vector.refused) assert.equal(built, null, `${vector.name}: no fallback sentence may be invented`);
    else assert.equal(built, vector.block, vector.name);
  }
  // Absent characteristics (schemaVersion 1) and an empty one are the same zero-length field.
  assert.equal(C.assembleBlock({ title: 'T', text: 'X', characteristics: undefined }), 'T\nX');
  // Nothing is added: no ending punctuation, no author, no time, no finding id, no source label.
  const built = C.assembleBlock({ title: '결절', text: '우상엽 결절', characteristics: '경계 불명확' });
  assert.equal(built, '결절\n우상엽 결절\n특성: 경계 불명확');
  assert.equal(built.startsWith('결절'), true);
  assert.equal(/r\d|F-\d|\d{4}-\d{2}-\d{2}/.test(built), false, 'no identifier or timestamp may be added');
  // Line endings are the only thing normalized; NFC would rewrite the characters a person typed.
  const decomposed = '소견 가'.normalize('NFD');
  assert.equal(C.assembleBlock({ title: decomposed, text: 'X', characteristics: null }), decomposed + '\nX');
  assert.equal(C.assembleBlock({ title: 'A\r\nB', text: 'C\rD', characteristics: null }), 'A\nB\nC\nD');
  // Edge whitespace is part of the record.
  assert.equal(C.assembleBlock({ title: '  T  ', text: ' X ', characteristics: null }), '  T  \n X ');
});

test('TEST-S3-U2b-R5: preview = request = attested block, and the separator stays outside it', () => {
  for (const vector of vectors.assembly.filter(v => !v.refused)) {
    const block = C.assembleBlock({ title: vector.title, text: vector.text, characteristics: vector.characteristics });
    assert.equal(block, vector.block, vector.name);
    // The empty field takes the block alone; a non-empty one takes exactly one LF first.
    assert.equal(C.appendBlock('', block), block);
    assert.equal(C.appendBlock('기존 판독문', block), '기존 판독문\n' + block);
    assert.equal(C.appendBlock(null, block), block);
    // The attested bytes must then be findable as a whole-line block in that field.
    assert.equal(C.lineBlockOccurrences(C.appendBlock('기존 판독문', block), block), 1, vector.name);
    assert.equal(C.lineBlockOccurrences(C.appendBlock('', block), block), 1, vector.name);
    // And continued typing right underneath must not flip it to 'absent'.
    assert.equal(C.lineBlockOccurrences(C.appendBlock('기존 판독문', block) + '\n이어 친 글', block), 1, vector.name);
  }
  // A field ending in a newline keeps exactly one separator: the append rule never trims the record.
  assert.equal(C.appendBlock('기존 판독문\n', 'B'), '기존 판독문\n\nB');
});

test('TEST-S3-U2b-R5: an oversized or blank block is refused before any report text changes', () => {
  assert.equal(C.INSERTED_TEXT_BYTES, 4096);
  const korean = '가'.repeat(1365);                       // 3 bytes each = 4095
  assert.equal(C.utf8Bytes(korean), 4095);
  assert.equal(C.refuseBlock(korean), null, '4095 bytes still fits');
  assert.equal(C.utf8Bytes(korean + '가'), 4098);
  assert.match(C.refuseBlock(korean + '가'), /4096바이트를 넘습니다/);
  assert.match(C.refuseBlock(korean + '가'), /소견을 줄인/, 'the way out is to revise the finding, not to truncate');
  assert.equal(C.utf8Bytes('a'.repeat(4096)), 4096);
  assert.equal(C.refuseBlock('a'.repeat(4096)), null, 'the bound is inclusive, as the server measures it');
  assert.ok(C.refuseBlock('a'.repeat(4097)));
  for (const empty of [null, undefined, '', '   ', '\r\n', '\t', '　'])
    assert.ok(C.refuseBlock(empty), `blank ${JSON.stringify(empty)} must be refused`);
});

test('TEST-S3-U2b-STATE: an unconfirmed study has no key at all, not an empty list', () => {
  const state = C.createState();
  assert.equal(state.known('1.2.3'), false);
  assert.equal(state.keepIds('1.2.3'), undefined, 'an unknown study must omit the key, never send []');
  assert.equal(state.removeIds('1.2.3'), undefined);
  assert.equal(state.get('1.2.3'), null);
  // A 200 from an insertion cannot invent the state (pin B2): a one-entry list would make the next
  // autosave's keep list delete every citation this screen has never seen.
  assert.equal(state.extend('1.2.3', { cid: 'new', field: 'findings', insertedText: 'A' }), false);
  assert.equal(state.keepIds('1.2.3'), undefined, 'still omitted after an unconfirmed 200');
  assert.equal(state.known('1.2.3'), false);
  // Only the dedicated read confirms.
  assert.equal(state.confirm('1.2.3', { version: 2, head: [{ cid: 'h1' }], draft: [{ cid: 'd1' }] }), true);
  assert.deepEqual(state.keepIds('1.2.3'), ['d1']);
  assert.equal(state.extend('1.2.3', { cid: 'new', field: 'findings', insertedText: 'A' }), true);
  assert.deepEqual(state.keepIds('1.2.3'), ['d1', 'new'], 'the 200 extends the confirmed list');
  // A malformed answer confirms nothing.
  const other = C.createState();
  for (const bad of [null, undefined, 'ok', 7]) assert.equal(other.confirm('1.2.4', bad), false);
  assert.equal(other.known('1.2.4'), false);
  // A missing head/draft key reads as an empty row, not as "unknown".
  assert.equal(other.confirm('1.2.4', {}), true);
  assert.deepEqual(other.keepIds('1.2.4'), []);
  assert.equal(other.get('1.2.4').version, 0);
});

test('TEST-S3-U2b-STATE: the keep list never silently drops an ambiguous, absent or reduced entry', () => {
  const state = C.createState();
  state.confirm('1.2.3', { version: 3, head: [], draft: [
    { cid: 'present', field: 'findings', insertedText: 'A line', sameTextCount: 1 },
    { cid: 'absent', field: 'findings', insertedText: '지워진 문장', sameTextCount: 1 },
    { cid: 'ambiguous', field: 'findings', insertedText: 'A line', sameTextCount: 2 },
    { cid: 'reduced', field: 'findings', insertedAt: 'x', insertedBy: 'y', state: C.SOURCE_UNAVAILABLE },
  ] });
  assert.deepEqual(state.keepIds('1.2.3'), ['present', 'absent', 'ambiguous', 'reduced'],
    'presence is a display state; it must never remove an attestation');
  // The same 200 arriving twice must not double an entry.
  const entry = { cid: 'present', field: 'findings', insertedText: 'A line' };
  assert.equal(state.extend('1.2.3', entry), false);
  assert.equal(state.keepIds('1.2.3').length, 4);
  // An emptied draft row really has lost its citations; the head keeps its own.
  state.confirm('1.2.3', { version: 3, head: [{ cid: 'h1' }], draft: [{ cid: 'd1' }] });
  assert.equal(state.emptied('1.2.3'), true);
  assert.deepEqual(state.keepIds('1.2.3'), []);
  assert.equal(state.get('1.2.3').head.length, 1, 'the head is a different row and is untouched');
});

test('TEST-S3-U2b-STATE: the head only loses a citation through an explicit, still-present choice', () => {
  const state = C.createState();
  state.confirm('1.2.3', { version: 4, head: [{ cid: 'h1' }, { cid: 'h2' }], draft: [{ cid: 'd1' }] });
  assert.equal(state.removeIds('1.2.3'), undefined, 'nothing chosen means no key at all');
  assert.equal(state.mark('1.2.3', 'd1', true), false, 'a draft entry is not removed through the head list');
  assert.equal(state.mark('1.2.3', 'unknown', true), false);
  assert.equal(state.mark('1.2.3', 'h2', true), true);
  assert.deepEqual(state.removeIds('1.2.3'), ['h2']);
  assert.equal(state.marked('1.2.3', 'h2'), true);
  assert.equal(state.marked('1.2.3', 'h1'), false);
  // Re-reading keeps a choice the person made, but only while that citation is still in the head.
  state.confirm('1.2.3', { version: 4, head: [{ cid: 'h1' }, { cid: 'h2' }], draft: [] });
  assert.deepEqual(state.removeIds('1.2.3'), ['h2']);
  state.confirm('1.2.3', { version: 5, head: [{ cid: 'h1' }], draft: [] });
  assert.equal(state.removeIds('1.2.3'), undefined, 'a choice about a citation that is gone is no choice');
  assert.equal(state.mark('1.2.3', 'h1', true), true);
  assert.equal(state.mark('1.2.3', 'h1', false), true);
  assert.equal(state.removeIds('1.2.3'), undefined);
  // Forgetting returns to "unknown", which is what a commit or a discarded draft leaves behind.
  state.forget('1.2.3');
  assert.equal(state.keepIds('1.2.3'), undefined);
  assert.equal(state.removeIds('1.2.3'), undefined);
});

test('TEST-S3-U2b-STATE: n rises with a local insertion, so two copies read ambiguous at once', () => {
  const state = C.createState();
  state.confirm('1.2.3', { version: 1, head: [], draft: [
    { cid: 'a', field: 'findings', insertedText: 'A line', sameTextCount: 1 }] });
  state.extend('1.2.3', { cid: 'b', field: 'findings', insertedText: 'A line\n', sameTextCount: 1 });
  const draft = state.get('1.2.3').draft;
  assert.deepEqual(draft.map(e => e.sameTextCount), [2, 2],
    'the final-LF form competes for the same occurrence, so both entries must say so');
  assert.deepEqual(draft.map(e => C.presenceOf(e, 'A line\nsecond')), ['ambiguous', 'ambiguous']);
  assert.deepEqual(draft.map(e => C.presenceOf(e, 'A line\nA line')), ['present', 'present']);
  // A different field never shares n.
  state.extend('1.2.3', { cid: 'c', field: 'conclusion', insertedText: 'A line', sameTextCount: 1 });
  assert.equal(state.get('1.2.3').draft[2].sameTextCount, 1);
  // A reduced entry keeps its neutral shape: counting must not give it a text it does not have.
  const other = C.createState();
  other.confirm('1.2.4', { version: 1, head: [], draft: [{ cid: 'r', state: C.SOURCE_UNAVAILABLE }] });
  other.extend('1.2.4', { cid: 's', field: 'findings', insertedText: 'A line', sameTextCount: 1 });
  assert.equal(other.get('1.2.4').draft[0].insertedText, undefined);
  assert.equal(other.get('1.2.4').draft[0].sameTextCount, undefined);
  assert.equal(other.get('1.2.4').draft[1].sameTextCount, 1, 'a reduced entry contributes no count it never had');
});

test('TEST-S3-U2b-STATE: an insertion never LOWERS the server count, because a reduced twin is invisible here', () => {
  // The server counted the whole row: A's twin R carries the same text but came back reduced, so
  // the screen cannot see it. Re-tallying what arrived would say n=1 and call A 'present' where the
  // server said 'ambiguous' - the client counting the entries it received is exactly what §3/D9-a
  // forbids.
  const state = C.createState();
  const A = { cid: 'a', field: 'findings', insertedText: 'A line', sameTextCount: 2 };
  const R = { cid: 'r', field: 'findings', insertedAt: 'x', insertedBy: 'y', state: C.SOURCE_UNAVAILABLE };
  state.confirm('1.2.3', { version: 1, head: [], draft: [A, R] });
  // A different text must not touch A at all.
  assert.equal(state.extend('1.2.3', { cid: 'n1', field: 'findings', insertedText: 'B line', sameTextCount: 1 }), true);
  let draft = state.get('1.2.3').draft;
  assert.equal(draft[0].sameTextCount, 2, 'the server count for an unrelated entry must not move');
  assert.equal(draft[1].sameTextCount, undefined, 'a reduced entry is never given a count');
  assert.equal(draft[2].sameTextCount, 1);
  assert.equal(C.presenceOf(draft[0], 'A line\nB line'), 'ambiguous', 'still ambiguous, as the server said');
  // The same text raises every entry of that text to the server count + this one.
  assert.equal(state.extend('1.2.3', { cid: 'n2', field: 'findings', insertedText: 'A line', sameTextCount: 1 }), true);
  draft = state.get('1.2.3').draft;
  assert.deepEqual(draft.map(e => e.sameTextCount), [3, undefined, 1, 3]);
  assert.equal(C.presenceOf(draft[3], 'A line\nB line'), 'ambiguous');
  assert.equal(C.presenceOf(draft[3], 'A line\nA line\nA line\nB line'), 'present');
  // Another insertion of the same text raises it again; nothing ever comes back down.
  state.extend('1.2.3', { cid: 'n3', field: 'findings', insertedText: 'A line\r\n', sameTextCount: 1 });
  assert.deepEqual(state.get('1.2.3').draft.map(e => e.sameTextCount), [4, undefined, 1, 4, 4],
    'the CRLF form is the same block, so it shares n');
});

test('TEST-S3-U2b-STATE: after a discarded insertion the draft side is unknown again, and the head choice survives', () => {
  const state = C.createState();
  state.confirm('1.2.3', { version: 4, head: [{ cid: 'h1' }, { cid: 'h2' }], draft: [{ cid: 'd1' }] });
  assert.equal(state.mark('1.2.3', 'h2', true), true);
  assert.deepEqual(state.keepIds('1.2.3'), ['d1']);
  // The insertion was refused, or its 200 was discarded: the screen no longer knows what the draft
  // row holds, so it must not claim a keep list. A list without the new cid deletes the very
  // attestation the server may just have written, while the sentence stays in the report.
  assert.equal(state.unconfirm('1.2.3'), true);
  assert.equal(state.known('1.2.3'), false);
  assert.equal(state.keepIds('1.2.3'), undefined, 'unknown must omit the key, never send a stale list');
  assert.equal(state.extend('1.2.3', { cid: 'x', field: 'findings', insertedText: 'A' }), false,
    'an unconfirmed row cannot be extended either');
  assert.equal(state.duplicate('1.2.3', 'findings', { findingId: 'f', findingRevision: 1, sourceIndex: 0 }), false);
  assert.equal(state.emptied('1.2.3'), false, 'an unknown row is not emptied by a clearing write');
  // forget() is NOT the remedy: it would erase a removal the person explicitly chose.
  assert.deepEqual(state.removeIds('1.2.3'), ['h2'], 'the explicit head-removal choice survives');
  assert.equal(state.marked('1.2.3', 'h2'), true);
  assert.equal(state.get('1.2.3').head.length, 2, 'the head row was not touched by the insertion');
  assert.equal(state.unconfirm('1.2.3'), false, 'unconfirming twice changes nothing');
  assert.equal(state.unconfirm('1.2.9'), false);
  // One dedicated read puts it back, and the choice is still there.
  state.confirm('1.2.3', { version: 4, head: [{ cid: 'h1' }, { cid: 'h2' }], draft: [{ cid: 'd1' }, { cid: 'x' }] });
  assert.equal(state.known('1.2.3'), true);
  assert.deepEqual(state.keepIds('1.2.3'), ['d1', 'x']);
  assert.deepEqual(state.removeIds('1.2.3'), ['h2']);
});

test('TEST-S3-U2b-STATE: a repeated source in the same field warns once, another field does not', () => {
  const state = C.createState();
  const request = { findingId: 'f1', findingRevision: 2, sourceIndex: 0 };
  state.confirm('1.2.3', { version: 1, head: [], draft: [
    { cid: 'a', field: 'findings', findingId: 'f1', findingRevision: 2, sourceIndex: 0, insertedText: 'A' }] });
  assert.equal(state.duplicate('1.2.3', 'findings', request), true);
  assert.equal(state.duplicate('1.2.3', 'conclusion', request), false, 'another field is not a duplicate');
  assert.equal(state.duplicate('1.2.3', 'findings', { ...request, sourceIndex: 1 }), false);
  assert.equal(state.duplicate('1.2.3', 'findings', { ...request, findingRevision: 3 }), false);
  assert.equal(state.duplicate('1.2.4', 'findings', request), false, 'the state is per study');
});

test('TEST-S3-U2b-BYTES: neither the module nor this file carries a control byte', () => {
  // An invisible NUL in a record-bearing module makes every later diff and review unreliable, and
  // an HTML inline script turns it into U+FFFD, so the harness would not even run the same bytes.
  for (const file of [MODULE_PATH, __filename, join(ROOT, 'worklist-v0/hpacs-lite/main.html'),
                      ...movedFiles(join(ROOT, 'worklist-v0/hpacs-lite/main.html')),
                      join(ROOT, 'worklist-v0/hpacs-lite/reading-findings.js')]) {
    const bytes = readFileSync(file);
    assert.equal(bytes.indexOf(0), -1, `${file} contains a NUL byte`);
  }
  assert.equal(C.entryKey({ field: 'findings', insertedText: 'A' }), '["findings","A"]');
  assert.equal(C.entryKey({ field: 'findings', insertedText: 'A\n' }), C.entryKey({ field: 'findings', insertedText: 'A' }));
  assert.notEqual(C.entryKey({ field: 'conclusion', insertedText: 'A' }), C.entryKey({ field: 'findings', insertedText: 'A' }));
  // The separator cannot be forged from inside a field value: JSON escapes the quotes.
  assert.notEqual(C.entryKey({ field: 'findings', insertedText: '","conclusion' }),
                  C.entryKey({ field: 'findings", "', insertedText: 'conclusion' }));
  assert.equal(C.entryKey({ cid: 'r', state: C.SOURCE_UNAVAILABLE }), null, 'a reduced entry has no key');
});
