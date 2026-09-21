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
const MODULE_PATH = join(ROOT, 'worklist-v0/hpacs-lite/report-citation.js');
const html = readFileSync(join(ROOT, 'worklist-v0/hpacs-lite/main.html'), 'utf8');
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

/** The shipped function body, brace matched, so a wiring assertion can never drift into a copy. */
function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} is gone from main.html`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
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

test('TEST-S3-U2b-WIRING: the shipped screen sends the server first and only a 200 moves the text', () => {
  const insert = extractFunction(html, 'insertCitation');
  // B1: the insertion waits for a non-keepalive stash already in flight for this study.
  const settle = insert.indexOf('await settleStash(pane.uid)'), put = insert.indexOf('await api("PUT"');
  assert.ok(settle >= 0 && put > settle, 'the insertion PUT must leave after the held stash settles');
  // The request body carries the sentence; the editor is still untouched at that point.
  // S3-U6: body and screen come from ONE plan, and that plan is re-derived after the held stash
  // settles - a position the person never read may not be sent. These are coordinates only; the
  // behaviour itself is proved by the DOM cases and their mutants (D11/M4, D7/M3, D1/M1+M6).
  const plan = insert.indexOf('const plan2 = citationPlan(field, pane.block);');
  const compare = insert.indexOf('plan2.text !== pane.plan.text');
  const carried = insert.indexOf('content[field] = plan2.text;');
  assert.ok(plan >= 0 && plan > settle && plan < put, 'the plan is derived after the settle and before the PUT');
  assert.ok(compare >= 0 && compare > plan && compare < put, 'what was shown is compared before anything is sent');
  assert.ok(carried >= 0 && carried < put, 'the request body carries exactly that plan');
  assert.doesNotMatch(insert, /el\.value \+=/, 'S3-U6: no second concatenation may reach the editor');
  assert.doesNotMatch(insert, /appendBlock\(/, 'the position-free append is not this path any more');
  const write = insert.indexOf('el.value = shown.text;');
  assert.ok(write >= 0 && write > put, 'the editor may only change after the answer');
  const caret = insert.indexOf('el.setSelectionRange(shown.end, shown.end);');
  assert.ok(caret >= 0 && caret > write, 'the caret lands on the inserted block once the text is in');
  const guard = insert.indexOf('epoch.uid !== selectedUid || epoch.selSeq !== selectionSeq || epoch.seq !== citeSeq');
  assert.ok(guard >= 0 && guard < write, 'a late answer must be checked against uid AND selection AND pane');
  assert.doesNotMatch(insert.slice(put, write), /\.value\s*=/, 'nothing may be written while the answer is being judged');
  // The request carries exactly the seven keys the server reads; the attestation values are the
  // server's to write, and a shape check could never tell a forged one from a real one.
  const from = insert.indexOf('insert: { field,');
  assert.ok(from > 0 && from < put + 500, 'the insertion payload must sit in the PUT that was just sent');
  const payload = insert.slice(from, insert.indexOf('},', from) + 2);
  for (const allowed of ['field', 'findingId', 'findingRevision', 'sourceIndex', 'insertedText',
                         'expectedLinkState', 'expectedHeadRevision'])
    assert.ok(payload.includes(allowed + ':') || payload.includes(allowed + ','), `${allowed} must be sent`);
  for (const forbidden of ['cid', 'insertedBy', 'insertedAt', 'sourceRef', 'linkStateAtInsert', 'headRevisionAtInsert'])
    assert.equal(new RegExp(`\\b${forbidden}\\b\\s*:`).test(payload), false, `${forbidden} is the server's to write`);
  // Every refusal path leaves the report alone, marks the study for convergence AND returns the
  // draft side to unknown: a keep list without the new cid would delete the attestation the server
  // may just have written, leaving the sentence in the report with nothing behind it.
  const failure = insert.slice(insert.indexOf('} catch (e) {'), insert.indexOf('} finally { insertInFlight'));
  assert.match(failure, /markConverge\(epoch\.uid\)/);
  assert.match(failure, /invalidateCitations\(epoch\.uid\)/);
  assert.doesNotMatch(failure, /\.value/, 'a refused insertion must not touch the editor');
  const discarded = insert.slice(guard, write);
  assert.match(discarded, /markConverge\(epoch\.uid\)/, 'a discarded answer must mark convergence too');
  assert.match(discarded, /invalidateCitations\(epoch\.uid\)/);
  // A 200 that could not extend an already-known row leaves the same unknown state behind.
  assert.match(insert, /const extended = !!answer\?\.inserted\?\.cid &&\s*\n\s*citations\.extend\(/);
  assert.match(insert, /if \(!extended\) invalidateCitations\(pane\.uid\);/);
  // The read that left before the PUT describes the row before the insertion; its ticket goes.
  const dropped = insert.indexOf('citationReads.delete(pane.uid);');
  assert.ok(dropped > 0 && dropped < put, 'the in-flight read ticket must be dropped before the PUT leaves');
  const invalidate = extractFunction(html, 'invalidateCitations');
  assert.match(invalidate, /citations\.unconfirm\(uid\)/);
  assert.doesNotMatch(invalidate, /forget\(/, 'forget() would erase an explicit head-removal choice');
  assert.match(invalidate, /citationReads\.delete\(uid\)/);
  assert.match(invalidate, /ensureCitations\(uid, \{ force: true \}\)/, 'one new read must be forced');
});

/**
 * The Image Findings panel is `position: fixed` over the report column (reading-workspace.css): it
 * never moves the report, it covers it - the citation bar an insertion fills, and that bar's own
 * buttons, are underneath it at every supported viewport. So the insertion that filled the bar is
 * what hands the screen back, and only when the server actually recorded it.
 */
test('TEST-S3-U2b-WIRING: only an accepted insertion stands the list that raised it down', () => {
  const insert = extractFunction(html, 'insertCitation');
  const put = insert.indexOf('await api("PUT"');
  const write = insert.indexOf('el.value = shown.text;');
  assert.ok(write >= 0, 'the editor write is the plan the server was told about');
  const stand = insert.indexOf('pane.inserted();');
  const close = insert.indexOf('closeCitePreview();');
  assert.ok(stand > write, 'the list may only stand down once the answer has moved the editor');
  assert.ok(close > stand, 'and it stands down before the preview closes, so focus lands on the field');
  assert.match(insert.slice(stand - 120, stand), /if \(typeof pane\.inserted === "function"\) \{/);
  assert.match(insert.slice(stand, close), /citeReturn = el;/,
    'focus follows the text into the field that received it, never onto a button being hidden');
  assert.equal(insert.split('pane.inserted').length - 1, 2, 'one guarded call, and nowhere else');
  // Every other exit leaves the list exactly where the person left it: the next press is made
  // from that same list, on the revision it is still showing.
  const failure = insert.slice(insert.indexOf('} catch (e) {'), insert.indexOf('} finally { insertInFlight'));
  assert.doesNotMatch(failure, /inserted\b/, 'a refusal must not stand the list down');
  const discarded = insert.slice(insert.indexOf('epoch.uid !== selectedUid'), write);
  assert.doesNotMatch(discarded, /inserted\(/, 'nor may an answer that came back to another selection');
  assert.ok(insert.indexOf('pane.warned = true;') < put && stand > put,
    'the warn-once duplicate sends nothing, so it has nothing to hand back');
  // The panel's half. Standing down goes through its own close path - that is what keeps the
  // toggle's aria-expanded true to what is on screen - and the callback is a function, so it can
  // never reach the request body (which the pin above holds to its seven keys).
  const findings = readFileSync(join(ROOT, 'worklist-v0/hpacs-lite/reading-findings.js'), 'utf8');
  const cite = extractFunction(findings, 'cite');
  assert.match(cite, /inserted: \(\) => \{ show\(false\); \}/, 'the request carries the stand-down callback');
  assert.match(extractFunction(findings, 'show'),
    /toggle\.setAttribute\('aria-expanded', String\(!!open\)\)/);
  assert.match(extractFunction(findings, 'show'), /panel\.hidden = !open;/);
});

test('TEST-S3-U2b-WIRING: the insertion waits for EVERY draft write of that study, not just the newest', () => {
  const settle = extractFunction(html, 'settleStash');
  assert.match(settle, /Promise\.allSettled\(\[\.\.\.pending\]\)/, 'all in-flight writes, not one');
  assert.match(settle, /if \(!pending \|\| !pending\.size\) return true;/);
  const stash = extractFunction(html, 'stashReport');
  assert.match(stash, /pending = new Set\(\)/, 'the map holds a set per study');
  assert.match(stash, /pending\.add\(settled\)/);
  assert.match(stash, /finally \{ pending\.delete\(settled\);/);
  // A settle that never drains refuses the insertion instead of racing it.
  const insert = extractFunction(html, 'insertCitation');
  assert.match(insert, /if \(!await settleStash\(pane\.uid\)\) \{/);
  assert.match(insert.slice(insert.indexOf('if (!await settleStash')), /잠시 뒤 다시 누르세요/);
  assert.ok(insert.indexOf('if (!await settleStash') < insert.indexOf('await api("PUT"'));
});

test('TEST-S3-U2b-WIRING: a draft behind the approved report refuses the insertion with the U3 exit named', () => {
  const behind = extractFunction(html, 'reportDraftBehind');
  assert.match(behind, /\(r\.version \?\? 0\) > \(d\.baseVersion \?\? 0\)/);
  assert.match(behind, /r\?\.prelimHidden \? null : r\?\.draft/);
  // One expression, used by the warning bar and by the refusal: two copies would drift apart.
  assert.equal(html.split('(r.version ?? 0) > (d.baseVersion ?? 0)').length - 1, 1);
  assert.match(extractFunction(html, 'renderDraftBar'), /const behind = reportDraftBehind\(r\);/);
  const gate = extractFunction(html, 'citationInsertBlock');
  assert.match(gate, /reportDraftBehind\(appState\[selectedUid\] \?\? \{\}\)/);
  assert.match(gate, /Addendum/, 'the refusal must name the non-destructive exit S3-U3 built');
});

test('TEST-S3-U2b-BYTES: neither the module nor this file carries a control byte', () => {
  // An invisible NUL in a record-bearing module makes every later diff and review unreliable, and
  // an HTML inline script turns it into U+FFFD, so the harness would not even run the same bytes.
  for (const file of [MODULE_PATH, __filename, join(ROOT, 'worklist-v0/hpacs-lite/main.html'),
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

test('TEST-S3-U2b-WIRING: every non-keepalive draft write stands aside while an insertion is out', () => {
  const stash = extractFunction(html, 'stashReport');
  // Pin B1 skips the WRITE. Skipping the local capture as well would lose unsaved typing the
  // moment a study move redraws the editor, so the capture happens first and the deferral is
  // recorded as the converge flag.
  const capture = stash.indexOf('appState[uid] = { ...a, draft };');
  const skip = stash.indexOf('if (deferWrite) return;');
  assert.ok(capture > 0 && skip > capture, 'the editor text must be captured before the write is skipped');
  assert.match(stash, /const deferWrite = insertInFlight && !keepalive;/);
  assert.match(stash, /if \(deferWrite\) reportConverge\.add\(uid\);/);
  assert.ok(stash.indexOf('const deferWrite') < capture, 'the decision is taken before the capture');
  assert.ok(skip < stash.indexOf('await api("PUT", path, body)'), 'nothing may leave while an insertion is out');
  assert.doesNotMatch(stash, /if \(insertInFlight && !keepalive\) return;/, 'the early return dropped the capture');
  // Not a timer-only guard: the product has exactly one non-keepalive writer and it is this one.
  const callers = [...html.matchAll(/stashReport\((\{[^}]*\})?\)/g)].map(m => m[0]);
  assert.ok(callers.length >= 4, 'the draft write is reached from several places');
  for (const call of callers)
    assert.ok(call === 'stashReport()' || call.includes('keepalive: true'),
      `unexpected stash call shape ${call}`);
  // B3: the dirty comparison is clean right after a stash, so the flag has to be separate.
  const needs = extractFunction(html, 'reportNeedsWrite');
  assert.match(needs, /reportDirty\(\) \|\| \(!!selectedUid && reportConverge\.has\(selectedUid\)\)/);
  assert.match(stash, /if \(!reportNeedsWrite\(\)\) return;/, 'the stash cleanliness check honours the flag');
  const timer = html.slice(html.indexOf('}, AUTOSAVE_MS);') - 700, html.indexOf('}, AUTOSAVE_MS);'));
  assert.match(timer, /commitInFlight \|\| insertInFlight/);
  assert.match(timer, /if \(!reportNeedsWrite\(\)\) return;/);
  const unload = html.slice(html.indexOf('window.addEventListener("beforeunload"'), html.indexOf('e.returnValue = ""'));
  assert.match(unload, /if \(!reportNeedsWrite\(\)\) return;/);
  assert.match(unload, /stashReport\(\{ keepalive: true \}\)/, 'the closing tab still sends what it has');
  // Only a completed write lowers the flag.
  assert.match(stash, /await api\("PUT", path, body\);\s*\n\s*\/\/[^\n]*\n\s*reportConverge\.delete\(uid\);/);
});

test('TEST-S3-U2b-WIRING: the keep list is carried only while the state is confirmed', () => {
  const stash = extractFunction(html, 'stashReport');
  assert.match(stash, /const keep = citations\.keepIds\(uid\);/);
  assert.match(stash, /\.\.\.\(keep \? \{ citationIds: keep \} : \{\}\)/, 'an unconfirmed study omits the key');
  assert.ok(stash.indexOf('const body = { ...next, baseVersion') < stash.indexOf('if (keepalive)'),
    'both the normal and the keepalive write use the one body');
  const commit = extractFunction(html, 'commitReport');
  assert.match(commit, /const keepIds = citations\.keepIds\(uid\), removeCitationIds = citations\.removeIds\(uid\);/);
  assert.match(commit, /\.\.\.\(keepIds \? \{ citationIds: keepIds \} : \{\}\)/);
  assert.match(commit, /\.\.\.\(removeCitationIds \? \{ removeCitationIds \} : \{\}\)/,
    'explicit head removal travels on its own key, separate from the draft keep list');
  assert.match(commit, /if \(commitInFlight \|\| insertInFlight\) return;/);
  assert.match(commit, /citations\.forget\(uid\);/, 'a commit moved both rows, so the screen no longer knows');
  const discard = extractFunction(html, 'discardDraft');
  assert.match(discard, /citations\.forget\(uid\);/);
});

test('TEST-S3-U2b-WIRING: every place a server projection replaces a study goes through the one merge', () => {
  // The capture from a deferred write lives in appState[uid].draft. Whoever replaces that object
  // has to honour the rule, and the rule must exist once: the poll was taught it first and the
  // Refresh button - which is the ONLY refresh when Auto Refresh is Manual - still bypassed it,
  // because the replacement is done by fromApi(), not by the poll.
  const keep = extractFunction(html, 'preservedLocal');
  assert.match(keep, /if \(uid === selectedUid\) local\.version = mine\?\.version \?\? 0;/);
  assert.match(keep, /if \(uid === selectedUid \|\| reportConverge\.has\(uid\)\) local\.draft = mine\?\.draft \?\? null;/);
  const merge = extractFunction(html, 'mergePolledState');
  assert.match(merge, /\{ \.\.\.mine, \.\.\.st, \.\.\.preservedLocal\(uid, mine\) \}/,
    'the server projection still merges; only the protected keys win');
  // fromApi is the one assignment behind the whole worklist: load() (Refresh) and the poll's
  // list rebuild both map through it, and applyState reads appState right after, so the row's
  // version comes out right without a second pass.
  const fromApi = extractFunction(html, 'fromApi');
  assert.match(fromApi, /appState\[s\.uid\] = mergePolledState\(s\.uid, s\.state\);/);
  assert.ok(fromApi.indexOf('mergePolledState') < fromApi.indexOf('return applyState('),
    'the merge must happen before the row is built from appState');
  // Every remaining assignment of a server projection over a study, in the whole page.
  const projections = [...html.matchAll(/appState\[[^\]]+\] = \{ \.\.\.appState\[[^\]]+\], \.\.\.(?:st|s\.state|fresh\.state)\b/g)]
    .map(m => m[0]);
  assert.equal(projections.length, 1, `only the commit answer may merge raw, found ${projections.length}`);
  const commit = extractFunction(html, 'commitReport');
  assert.ok(commit.includes(projections[0]),
    'the one raw merge is the commit answering the action this screen just took, not a projection of someone else');
  // The same family: a single-study answer that also carries that study's draft. saveApp() is the
  // PATCH path (success and its re-read recovery); setTs() is the tele-state one, whose timers come
  // back on whatever uid was requested - which need not be the selected study.
  assert.equal(extractFunction(html, 'saveApp').split('appState[uid] = mergePolledState(uid, ').length - 1, 2,
    'both the PATCH success and its recovery re-read');
  assert.match(extractFunction(html, 'setTs'), /appState\[uid\] = mergePolledState\(uid, st\);/);
  assert.equal(html.split('mergePolledState(').length - 1, 7,
    'definition + fromApi + two poll branches + patch success + patch recovery + setTs');
  // The rule exists once: the two blocks that used to restore one study after fromApi are gone.
  assert.doesNotMatch(html, /version:editing\.version \?\? 0, draft:editing\.draft \?\? null/);
  assert.doesNotMatch(html, /for \(const uid of \[selectedUid, \.\.\.reportConverge\]\)/);
  assert.equal(html.split('preservedLocal(').length - 1, 2, 'preservedLocal is called only by mergePolledState');
});

test('TEST-S3-U2b-HARNESS: a harness that slices the poll must supply what the poll now calls', () => {
  /**
   * Centralising the rule added a collaborator to startPolling, and tests/worklist_arrivals_dom_test.py
   * slices that function with its own stubs. The missing name threw inside the poll's own catch, so
   * the browser reported no page error - only a row that had not been redrawn. This check is
   * structural: whatever top-level product function the sliced body calls, the harness must supply.
   */
  const plain = html.replace(/\r\n/g, '\n');
  const topLevel = new Set([...plain.matchAll(/^ {4}(?:async )?function ([A-Za-z_$][\w$]*)\(/gm)].map(m => m[1]));
  assert.ok(topLevel.has('mergePolledState') && topLevel.has('startPolling'));
  const slicers = ['tests/worklist_arrivals_dom_test.py'].filter(file =>
    readFileSync(join(ROOT, file), 'utf8').includes('extract_function(MAIN, "startPolling")'));
  assert.deepEqual(slicers, ['tests/worklist_arrivals_dom_test.py'], 'the poll-slicing harness moved');
  const body = extractFunction(html, 'startPolling');
  assert.match(body, /mergePolledState\(uid, st\)/, 'the slice is the one that carries the rule');
  for (const file of slicers) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const missing = [...new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))]
      .filter(name => topLevel.has(name) && name !== 'startPolling' && !text.includes(name));
    assert.deepEqual(missing, [], `${file} does not supply ${missing.join(', ')}`);
    // And it supplies them by slicing the product, not by re-describing the rule.
    assert.match(text, /PRESERVE = extract_function\(MAIN, "preservedLocal"\)/);
    assert.match(text, /MERGE = extract_function\(MAIN, "mergePolledState"\)/);
  }
});

test('TEST-S3-U2b-WIRING: the shipped fromApi line really keeps a draft that is waiting to converge', () => {
  // Executed, not matched. The shipped assignment plus the shipped merge, against a study that is
  // NOT selected and has a deferred capture - the exact state a refused insertion leaves behind.
  const region = slice(html.replace(/\r\n/g, '\n'), '    function preservedLocal(uid, mine) {',
                       '    /** 삽입이 나가 있는 동안의');
  const line = extractFunction(html, 'fromApi').split('\n').find(text => text.includes('appState[s.uid] ='));
  assert.ok(line, 'fromApi no longer assigns appState');
  const run = assignment => {
    const context = vm.createContext({});
    vm.runInContext(`
      var selectedUid = "B";
      var reportConverge = new Set(["A"]);
      var appState = { A: { rs: "T", version: 1, draft: { findings: "T0 typed, never sent", baseVersion: 1 } },
                       B: { rs: "T", version: 4, draft: null } };
      var answers = [{ uid: "A", state: { rs: "H", version: 2, draft: { findings: "server: pre-T0", baseVersion: 1 } } },
                     { uid: "B", state: { rs: "T", version: 9, draft: { findings: "server B", baseVersion: 9 } } }];
      ${region}
      for (const s of answers) { ${assignment} }
    `, context, { filename: 'fromApi-line.js' });
    return JSON.parse(vm.runInContext('JSON.stringify(appState)', context));
  };
  const shipped = run(line.trim());
  assert.equal(shipped.A.draft.findings, 'T0 typed, never sent',
    'a study waiting to converge keeps the typing even though it is not selected');
  assert.equal(shipped.A.rs, 'H', 'every other field still comes from the server');
  assert.equal(shipped.A.version, 2, 'and so does the version of a study that is not selected');
  assert.equal(shipped.B.draft, null, 'the selected study keeps its own local draft');
  assert.equal(shipped.B.version, 4, 'and the version the screen actually drew');
  // Negative control: the line as it was before this correction.
  const raw = run('appState[s.uid] = { ...appState[s.uid], ...s.state };');
  assert.equal(raw.A.draft.findings, 'server: pre-T0', 'the old line loses the typing - this smoke can fail');
  assert.equal(raw.B.version, 9, 'and adopted a version the screen never drew');
});

test('TEST-S3-U2b-WIRING: logout stands aside for an insertion instead of tearing the session down', () => {
  // Its draft write is non-keepalive, so B1 defers it; KinAuth.logout() then destroys the session
  // before navigation, so the closing-tab keepalive would leave after the session is gone.
  const logout = html.slice(html.indexOf('$("#logout").addEventListener("click"'),
                            html.indexOf('// 다른 사람이 잡거나 놓은 걸'));
  const guard = logout.indexOf('if (insertInFlight) {');
  assert.ok(guard > 0, 'the logout must check for an insertion in flight');
  assert.ok(guard < logout.indexOf('confirm("로그아웃하시겠습니까?")'), 'before it asks anything');
  assert.ok(guard < logout.indexOf('loggingOut = true;'));
  assert.ok(guard < logout.indexOf('await stashReport();'));
  assert.ok(guard < logout.indexOf('await KinAuth.logout();'));
  assert.match(logout.slice(guard, logout.indexOf('if (!confirm')), /toast\(/, 'and it says why');
});

test('TEST-S3-U2b-WIRING: the citation path reuses the one editor gate, it does not grow a second', () => {
  const gate = extractFunction(html, 'reportEditorBlock');
  assert.match(gate, /reportWriteBlock\(\)/);
  assert.match(gate, /RFIELDS\.some\(k => \$\("#" \+ k\)\.readOnly\)/);
  const refusal = '현재 판독문은 편집할 수 없습니다';
  // Two places, and both are gates: reportEditorBlock (which both insertion paths call) and the
  // pre-existing Save-as-Template gate, whose own order puts a different check in between. That
  // one is not this unit's to reorder - but no insertion path may carry a third copy.
  assert.equal(html.split(refusal).length - 1, 2, 'a third copy of the refusal would drift');
  assert.match(extractFunction(html, 'reportTemplateAccessBlock'), new RegExp(refusal));
  for (const name of ['templateInsertionBlock', 'citationInsertBlock']) {
    assert.match(extractFunction(html, name), /const why = reportEditorBlock\(\);/, name);
    assert.doesNotMatch(extractFunction(html, name), new RegExp(refusal), `${name} must not hold its own copy`);
  }
  const cite = extractFunction(html, 'citationInsertBlock');
  // An insertion needs a server attestation to exist at all, so these three are citation-only.
  assert.match(cite, /!serverMode \|\| demoMode/);
  assert.match(cite, /if \(offline\)/);
  assert.match(cite, /if \(commitInFlight\)/);
  assert.doesNotMatch(cite, /readOnly/, 'the read-only rule belongs to the shared gate now');
});

test('TEST-S3-U2b-WIRING: the pane is modal while busy and the read is the only source of counts', () => {
  const busy = extractFunction(html, 'setCiteBusy');
  for (const control of ['insert', 'close', 'field'])
    assert.match(busy, new RegExp(`\\$\\("#cite-preview-${control}"\\)\\.disabled = busy;`), control);
  const backdrop = html.slice(html.indexOf('$("#cite-preview").addEventListener("click"'),
                              html.indexOf('$("#cite-preview").addEventListener("keydown"'));
  assert.match(backdrop, /e\.target\.id === "cite-preview" && !citeBusy/, 'B3: no backdrop close while busy');
  const keys = html.slice(html.indexOf('$("#cite-preview").addEventListener("keydown"'),
                          html.indexOf('window.addEventListener("pagehide", () => { if (!citeBusy)'));
  assert.match(keys, /if \(e\.key === "Escape"\)[\s\S]*if \(!citeBusy\) closeCitePreview\(\);/, 'B3: no Escape close while busy');
  const ensure = extractFunction(html, 'ensureCitations');
  assert.match(ensure, /\/report\/citations/, 'counts come from the dedicated read only');
  assert.match(ensure, /citations\.confirm\(uid, answer\);/);
  assert.match(ensure, /citationNotes\.set\(uid,/, 'a failed read says so instead of reading as zero');
  const load = extractFunction(html, 'loadReport');
  assert.match(load, /ensureCitations\(selectedUid\);/);
  const bar = extractFunction(html, 'renderCitationBar');
  assert.match(bar, /appState\[uid\]\?\.prelimHidden/, 'a hidden preliminary report shows no citation counts');
  assert.match(bar, /textContent/);
  assert.doesNotMatch(bar, /innerHTML/, 'server strings reach the screen through textContent only');
  // The head entry is compared against the approved body, the draft entry against the editor.
  const body = extractFunction(html, 'citationBody');
  assert.match(body, /scope === "head" \? String\(appState\[selectedUid\]\?\.\[field\] \?\? ""\) : \$\("#" \+ field\)\.value/);
  // Typing changes k, so the open list has to be recounted - but not once per keystroke.
  const refresh = extractFunction(html, 'scheduleCitationRefresh');
  assert.match(refresh, /if \(!citationListOpen\) return;/);
  assert.match(refresh, /setTimeout/);
  assert.match(html, /for \(const k of RFIELDS\) \$\("#" \+ k\)\.addEventListener\("input", scheduleCitationRefresh\);/);
  // The payload the polling list returns is untouched by this unit.
  assert.doesNotMatch(html, /citationCount/);
});

/**
 * The DOM harness assembles product text and helper text into one classic script. Parsing it
 * proves nothing about whether the helpers reach the product: a top-level `function select` is a
 * writable property of the global object, so `window.select = uid => select(uid)` replaced the very
 * binding its own body resolved and every study move threw RangeError before stashReport() ran.
 * These two tests execute the assembled pieces instead of reading them.
 */
const domTest = readFileSync(join(ROOT, 'tests/report_citation_dom_test.py'), 'utf8').replace(/\r\n/g, '\n');
const slice = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `the region ${from.trim()} moved; re-pin the harness`);
  return source.slice(start, end);
};
/** The markers come out of the harness itself, so the smoke can never slice a different region. */
const harnessMarkers = name => {
  const line = domTest.split('\n').find(text => text.startsWith(`${name} = slice_between(MAIN, `));
  assert.ok(line, `${name} is gone from the DOM harness`);
  const found = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`));
  assert.equal(found.length, 2, `${name} markers`);
  return found;
};
/** Only what select()/refreshRight() touch; the two that matter record that they ran. */
const SELECT_STUBS = `
  var window = this, trace = [];
  var selectedUid = "1.2.3", selectionSeq = 0, citeBusy = false, reasonResolve = null, heldUid = null, warnedFor = null;
  var relatedUid = null, relatedReportSeq = 0, relatedModality = "", relatedBodyPart = "", relatedIncludeCurrent = false;
  var mode = "Reading", templateEditor = null;
  var reportPreview = { close() {} }, relatedParts = { reset() {} };
  var readingWorkspace = { active: () => false, selectionChanged() {} }, readingFindings = { sync() {} };
  var imageOpening = { snapshot: () => ({ autoLoad: false }) };
  function closeTemplateEditor() {} function closeTemplatePreview() {} function closeCitePreview() {}
  function releaseHold() {} function clearRelatedReport() {} function loadRelatedReport() {}
  function renderClinical() {} function renderRelated() {} function renderThumbs() {} function renderTemplates() {}
  function renderOrders() {} function openFilmbox() {} function render() {} function updateReportButtons() {}
  function markSelectionChanged(uid) { selectedUid = uid; selectionSeq += 1; }
  function stashReport() { trace.push("stashReport:" + selectedUid); }
  function loadReport(o) { trace.push("loadReport:" + selectedUid + ":" + !!(o && o.force)); }
  /* S3-structured-report closes the structured-entry form on the way out, the same way this block
     already closes the cite preview. The stubs have to declare both names or the sliced product
     throws ReferenceError before a single line of the move runs. closeStructure deliberately does
     NOT push to trace: the two entries this smoke asserts are the draft write and the redraw, and
     adding a third here would silently rewrite what the smoke is about. structClosed records it
     instead, so the close can be observed without touching the trace.
     (No backticks in here - this whole block is itself a template literal.) */
  var structPane = null, structClosed = 0;
  function closeStructure() { structClosed += 1; }
`;
const runSelect = (extra, call) => {
  const [from, to] = harnessMarkers('SELECT_BLOCK');
  const context = vm.createContext({});
  vm.runInContext(SELECT_STUBS + '\n' + slice(html.replace(/\r\n/g, '\n'), from, to) + '\n' + extra,
    context, { filename: 'harness-inline.js' });
  let threw = null;
  try { vm.runInContext(call, context); } catch (e) { threw = e.constructor.name; }
  // Through JSON: an array built inside the vm realm carries that realm's Array.prototype and
  // would fail deepStrictEqual for a reason that has nothing to do with the harness.
  return { threw, selectedUid: vm.runInContext('selectedUid', context),
    selectionSeq: vm.runInContext('selectionSeq', context),
    structClosed: vm.runInContext('structClosed', context),
    trace: JSON.parse(vm.runInContext('JSON.stringify(trace)', context)) };
};

test('TEST-S3-U2b-HARNESS: the sliced study move really runs, and the wrapper that broke it cannot come back', () => {
  // Executed, not matched: the shipped select() writes the draft on the way out, counts the
  // selection change and redraws the arriving study with force.
  const ran = runSelect('', 'select("1.2.4")');
  assert.equal(ran.threw, null, 'the shipped study move must execute');
  assert.equal(ran.selectedUid, '1.2.4');
  assert.equal(ran.selectionSeq, 1);
  assert.deepEqual(ran.trace, ['stashReport:1.2.3', 'loadReport:1.2.4:true'],
    'the draft write happens before the move and the arrival redraws with force');
  // S3-structured-report: an idle structured-entry form is closed on the way out, exactly like the
  // cite preview - leaving it open would let the next press write the departed study's entry.
  assert.equal(ran.structClosed, 1, 'an idle structured-entry form is closed by the move');
  // ...and a form with a request in flight is left alone, for the same reason citeBusy leaves the
  // cite preview alone: its late answer still has to find the pane it belongs to.
  const busy = runSelect('structPane = { busy: true };', 'select("1.2.4")');
  assert.equal(busy.threw, null, 'the move still runs with a busy form');
  assert.equal(busy.structClosed, 0, 'a form waiting for its answer must not be closed underneath it');
  assert.deepEqual(busy.trace, ['stashReport:1.2.3', 'loadReport:1.2.4:true'],
    'and the rest of the move is unchanged');
  assert.equal(busy.selectedUid, '1.2.4');
  // Negative control: the exact line that was removed, so this smoke can be seen to fail.
  const broken = runSelect('window.select = uid => select(uid);', 'select("1.2.4")');
  assert.equal(broken.threw, 'RangeError', 'a same-named helper makes the move call itself');
  assert.deepEqual(broken.trace, [], 'and nothing of the product runs');
  assert.equal(broken.selectedUid, '1.2.3');
  // No helper in the harness may shadow a top-level function of any block it slices.
  const sliced = ['BASE_BLOCK', 'REPORT_BLOCK', 'SELECT_BLOCK', 'UNLOAD_BLOCK', 'LOGOUT_BLOCK']
    .map(name => { const [from, to] = harnessMarkers(name); return slice(html.replace(/\r\n/g, '\n'), from, to); })
    .join('\n');
  const helpers = [...domTest.matchAll(/^window\.([A-Za-z_$][\w$]*) = /gm)].map(m => m[1]);
  assert.ok(helpers.length > 15, 'the helper list was not found');
  const shadowing = helpers.filter(name =>
    new RegExp(`^ {4}(?:async )?function ${name.replace(/\$/g, '\\$')}\\(`, 'm').test(sliced));
  assert.deepEqual(shadowing, [], 'a window.X helper named after a sliced top-level function shadows it');
  // Each placeholder must occur exactly twice: the spot it fills and its own replace() call.
  // A third mention - even inside a comment - makes replace() inject product text into prose,
  // which is how one sentence about SELECTBLOCK stopped the whole harness from compiling.
  for (const token of ['MODALCSS', 'PANEHTML', 'CITEHTML', 'CITATIONJS', 'APIFN', 'WRITEBLOCKFN',
                       'EDITORBLOCKFN', 'BASEBLOCK', 'REPORTBLOCK', 'SELECTBLOCK', 'UNLOADBLOCK',
                       'LOGOUTBLOCK', 'INITIALSTATE'])
    assert.equal(domTest.split(token).length - 1, 2,
      `${token} must appear exactly twice: where it is substituted and in its replace() call`);
  // UIDVALUE/OTHERVALUE are value placeholders with several intended substitution sites, so they
  // are only required to stay out of prose that a block replacement could corrupt.
  for (const token of ['UIDVALUE', 'OTHERVALUE'])
    assert.ok(domTest.split(token).length - 1 >= 2, token);
  // Show Citations is a bare toggle and the product assigns citationListOpen nowhere else, so a
  // case that presses it twice CLOSES the list and then reads null. The late-200 case reads the
  // list at its end: it must press once and state the precondition instead of pressing again.
  assert.equal(html.split(/citationListOpen\s*=[^=]/).length - 1, 2,
    'citationListOpen is the declaration plus the toggle; a third assignment changes this rule');
  const late200 = slice(domTest, '    def test_a_late_200_leaves_the_keep_list_unknown_and_the_head_choice_intact(self):',
                        '    def test_the_insertion_waits_for_every_write');
  assert.equal(late200.split('self.page.click("#b-cite-list")').length - 1, 1,
    'one press per case on a bare toggle, or the list is shut when it is read');
  assert.match(late200, /aria-expanded/, 'and the open state is asserted, not assumed');
  assert.match(late200, /더는 없습니다/, 'the absent reading is still what it checks');
});

test('TEST-S3-U2b-HARNESS: the product region the DOM tests slice actually compiles', () => {
  // The U3 harness died before its first assertion because an extraction dropped `async`. Compile
  // the exact slices here, on the host, so that failure can never reach a browser job again.
  const between = (start, end) => {
    const from = html.indexOf(start);
    const to = html.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `the region ${start.trim()} moved; re-pin the harness`);
    return html.slice(from, to);
  };
  const region = between('    let selectionSeq = 0;', '    function reportSource()') +
                 between('    function reportSource() {', '    function heldByOther(s)');
  new vm.Script(region, { filename: 'main.html:report-region' });
  for (const name of ['insertCitation', 'ensureCitations', 'renderCitationBar', 'openCitePreview',
                      'closeCitePreview', 'citationInsertBlock', 'reportNeedsWrite', 'markConverge',
                      'settleStash', 'renderCitePreview', 'setCiteBusy', 'citationEntryText', 'citationBody',
                      'scheduleCitationRefresh'])
    assert.ok(region.includes(`function ${name}(`), `${name} must live inside the sliced region`);
  // The modal markup the DOM harness needs is one contiguous block, as the stale pane already is.
  const start = html.indexOf('<div class="modal" id="cite-preview"');
  assert.ok(start > 0);
  const end = html.indexOf('\n  </div>', start);
  const markup = html.slice(start, end);
  for (const id of ['cite-preview-title', 'cite-preview-target', 'cite-preview-source', 'cite-preview-field',
                    'cite-preview-block', 'cite-preview-status', 'cite-preview-close', 'cite-preview-insert'])
    assert.ok(markup.includes(`id="${id}"`), `${id} must be inside the pane markup`);
  assert.match(markup, /aria-modal="true"/);
  new vm.Script(readFileSync(MODULE_PATH, 'utf8'), { filename: 'report-citation.js' });
  assert.ok(html.includes('<script src="report-citation.js"></script>'), 'the module must ship with the page');
});
