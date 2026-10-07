// TEST-S3-U6-CURSOR-PLACEMENT: the shipped placement rule and the screen wiring that uses it.
//
// REQ-S3-U6-CURSOR-INSERTION (IF-A29 "cursor 위치 삽입")
//   -> RISK-S3-U6-SPLIT-LINE/BROKEN-GUARD/LOST-TEXT/DIVERGENT-BODY/UNREAD-POSITION
//   -> TEST-S3-U6-CURSOR-PLACEMENT.
//
// `worklist-v0/hpacs-lite/report-citation.js` is loaded and executed here, not copied, and the
// shared vector file is the same oracle the compiled server validator answers to: a placement that
// the two halves disagree about is exactly the "the sentence you inserted is already gone" bug.
//
// The expected strings below are written by hand, not produced by the function under test.
//
// Pure: no DOM, no browser, no stack, no network. Run with:
//   node --test tests/report_cursor_insert_test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const MODULE_PATH = process.env.KIN_CURSOR_CITATION_JS || join(ROOT, 'worklist-v0/hpacs-lite/report-citation.js');
const vectors = JSON.parse(readFileSync(join(__dirname, 'report_citation_vectors.json'), 'utf8'));

/** The shipped module, executed in this realm (same reason as report_citation_client_test.cjs). */
function loadModule() {
  globalThis.window = globalThis.window || {};
  vm.runInThisContext(readFileSync(MODULE_PATH, 'utf8'), { filename: 'report-citation.js' });
  assert.ok(globalThis.window.KinReportCitation, 'the module must publish window.KinReportCitation');
  return globalThis.window.KinReportCitation;
}
const C = loadModule();

const at = (start, end = start) => ({ start, end });
const lines = text => text.split('\n').length;

// ── P1 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-PLACE: every boundary lands the block on whole lines, byte for byte', () => {
  // value, caret, expected text, expected 1-based LF line, expected snap
  const cases = [
    ['', 0, 'X', 1, null, 'an empty field takes the block alone'],
    ['abc', 0, 'X\nabc', 1, null, 'the very start pushes the existing line down'],
    ['abc', 3, 'abc\nX', 2, null, 'the end of a field without a final newline is the legacy answer'],
    ['abc\n', 4, 'abc\nX\n', 2, null, 'a field that already ends in a newline gets NO blank line'],
    ['abc\ndef', 3, 'abc\nX\ndef', 2, null, 'the end of the first line'],
    ['abc\ndef', 4, 'abc\nX\ndef', 2, null, 'the head of the second line is the same boundary'],
    ['abc\ndef', 5, 'abc\ndef\nX', 3, 'line-end', 'a caret inside the last line snaps to that line end'],
    ['abcdef', 3, 'abcdef\nX', 2, 'line-end', 'a caret inside the only line never splits it'],
    ['a\n\nb', 2, 'a\nX\n\nb', 2, null, 'a blank line the person left stays a blank line'],
    ['\nabc', 0, 'X\n\nabc', 1, null, 'a leading blank line survives too'],
    ['abc', 99, 'abc\nX', 2, null, 'an out-of-range integer clamps to the end'],
    ['abc', -5, 'X\nabc', 1, null, 'and a negative one clamps to the start'],
  ];
  for (const [value, caret, expected, line, snapped, why] of cases) {
    const plan = C.placeBlock(value, 'X', at(caret));
    assert.equal(plan.text, expected, why);
    assert.equal(plan.line, line, `${why}: line number`);
    assert.equal(plan.snapped, snapped, `${why}: snap`);
    assert.equal(plan.text.slice(plan.start, plan.end), 'X', `${why}: the returned span is the block`);
    // The one structural promise: every existing line survives and the block adds its own.
    assert.equal(lines(plan.text), lines(value) + (value === '' ? 0 : 1), `${why}: line count`);
  }
  // A multi-line block keeps its own shape and its span.
  const multi = C.placeBlock('머리\n꼬리', '첫 줄\n둘째 줄', at(3));
  assert.equal(multi.text, '머리\n첫 줄\n둘째 줄\n꼬리');
  assert.equal(multi.text.slice(multi.start, multi.end), '첫 줄\n둘째 줄');
  assert.equal(multi.line, 2);
});

// ── P2 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-LEGACY: with no confirmed caret the bytes are exactly today’s append', () => {
  for (const vector of vectors.assembly) {
    if (!vector.block) continue;
    for (const value of ['', 'X', 'X\n', '여러\n줄', '끝\n']) {
      for (const anchor of [null, undefined, {}, { start: 1 }, { start: 1.5, end: 1.5 }, { start: NaN, end: NaN }]) {
        const plan = C.placeBlock(value, vector.block, anchor);
        assert.equal(plan.text, C.appendBlock(value, vector.block),
          `${vector.name}: a position nobody expressed must not change the answer`);
        assert.equal(plan.mode, 'end');
        assert.equal(plan.text.slice(plan.start, plan.end), vector.block, 'the caret target is still the block');
      }
    }
  }
  // The single disclosed difference of D-3: a field that ends in a newline.
  assert.equal(C.appendBlock('abc\n', 'X'), 'abc\n\nX', 'the position-free append keeps its blank line');
  assert.equal(C.placeBlock('abc\n', 'X', at(4)).text, 'abc\nX\n', 'an expressed caret at the end does not');
});

// ── P3 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-PRESENCE: whatever the caret says, the block is there as a whole-line block', () => {
  const bodies = ['', 'abc', 'abc\n', 'a\n\nb', '머리\n꼬리\n', 'x\ny\nz'];
  const blocks = ['X', '첫 줄\n둘째 줄', '제목\n본문\n특성: 값'];
  for (const value of bodies) {
    for (const block of blocks) {
      for (let q = 0; q <= value.length; q++) {
        const plan = C.placeBlock(value, block, at(q));
        assert.ok(C.lineBlockOccurrences(plan.text, block) >= 1,
          `${JSON.stringify(value)}@${q}: the sentence must be findable by the server rule`);
        assert.equal(plan.text.slice(plan.start, plan.end), block);
      }
      const end = C.placeBlock(value, block, null);
      assert.ok(C.lineBlockOccurrences(end.text, block) >= 1, 'and so must the legacy answer');
    }
  }
});

// ── P4 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-LOSSLESS: nothing of the existing text is deleted, moved or rewritten', () => {
  const values = ['', 'abc', 'abc\n', 'a\n\nb', '탭\t끝  \n둘째', '기존 판독문\n둘째 줄\n'];
  for (const value of values) {
    for (let q = 0; q <= value.length; q++) {
      for (const block of ['X', 'A\nB']) {
        const plan = C.placeBlock(value, block, at(q));
        const inserted = plan.text.length - value.length;
        // The inserted run starts at most one separator before the block.
        const from = plan.text.slice(0, plan.start).endsWith('\n') && plan.start > 0
          ? plan.start - (plan.text.slice(0, plan.start) === value.slice(0, plan.start) ? 0 : 1)
          : plan.start;
        assert.ok(inserted >= block.length && inserted <= block.length + 2, 'only separators may be added');
        // Removing exactly the inserted run gives the original back.
        const rebuilt = plan.text.slice(0, from) + plan.text.slice(from + inserted);
        assert.equal(rebuilt, value, `${JSON.stringify(value)}@${q}: the original text must survive`);
      }
    }
  }
});

// ── P5 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-GUARD: an insertion never splits a citation that is already in the field', () => {
  // The span finder and the occurrence counter are one rule: a disagreement is the whole defect.
  for (const vector of vectors.occurrence) {
    assert.equal(C.blockSpans(vector.body, vector.block).length, C.lineBlockOccurrences(vector.body, vector.block),
      `${vector.name}: spans and occurrences must be the same answer`);
    for (const [from, to] of C.blockSpans(vector.body, vector.block))
      assert.ok(to > from && to <= C.normalizeForCompare(vector.body).split('\n').length, `${vector.name}: span bounds`);
  }
  const body = '머리 인용\n두 줄\n\n사람이 쓴 글\n초안 인용';
  const guards = ['머리 인용\n두 줄', '초안 인용'];
  // The line the pane names must be the line the block is actually on: that sentence is the only
  // disclosure the person gets (the findings drawer covers the field), so it is asserted on every
  // case, not described.
  const namedLine = plan => plan.text.slice(0, plan.start).split('\n').length;
  for (let q = 0; q <= body.length; q++) {
    const plan = C.placeBlock(body, '새 문장', at(q), guards);
    for (const guard of guards)
      assert.ok(C.lineBlockOccurrences(plan.text, guard) >= C.lineBlockOccurrences(body, guard),
        `@${q}: ${guard.split('\n')[0]} must not lose an occurrence`);
    assert.ok(C.lineBlockOccurrences(plan.text, '새 문장') >= 1, `@${q}: and the new sentence must be there`);
    assert.equal(plan.line, namedLine(plan), `@${q}: the line the pane names is the line the block is on`);
  }
  /**
   * The class that a whole-file sweep found and the cases above did not: a field ENDING IN LF whose
   * guard block ends with a BLANK LINE. Stepping past that guard lands past the field's final empty
   * line, and there the character before the anchor ('\n') cannot tell "before the last line" from
   * "after it" - only the line number can. Getting it wrong split the very citation being protected
   * (occurrences 1 -> 0, nothing deleted) and named a line one too high.
   */
  for (const [value, guard] of [['abc\n', 'abc\n\n'], ['prev\nabc\n', 'abc\n\n'], ['a\n', 'a\n\n'],
                                ['x\na\n\n', 'a\n\n'], ['머리\n인용\n', '인용\n\n']]) {
    for (let q = 0; q <= value.length; q++) {
      const plan = C.placeBlock(value, 'X', at(q), [guard]);
      assert.ok(C.lineBlockOccurrences(plan.text, guard) >= C.lineBlockOccurrences(value, guard),
        `${JSON.stringify(value)}@${q}: a guard ending in a blank line must not be split`);
      assert.equal(plan.line, namedLine(plan),
        `${JSON.stringify(value)}@${q}: and the line it reports must be where the block really is`);
      assert.ok(C.lineBlockOccurrences(plan.text, 'X') >= 1, 'the new block is still whole-line');
    }
  }
  // The exact vector the sweep reported: past the final empty line, with a separator of its own.
  const past = C.placeBlock('abc\n', 'X', at(4), ['abc\n\n']);
  assert.equal(past.text, 'abc\n\nX');
  assert.equal(past.line, 3);
  assert.equal(past.snapped, 'past-citation');
  // Without that guard the same caret keeps the D-3 answer: no blank line, trailing newline kept.
  assert.equal(C.placeBlock('abc\n', 'X', at(4)).text, 'abc\nX\n');
  // Inside the first guard the anchor moves past it and says so; outside it does not move.
  const inside = C.placeBlock(body, '새 문장', at(body.indexOf('두 줄')), guards);
  assert.equal(inside.snapped, 'past-citation');
  assert.equal(inside.text, '머리 인용\n두 줄\n새 문장\n\n사람이 쓴 글\n초안 인용');
  const outside = C.placeBlock(body, '새 문장', at(body.indexOf('사람이 쓴 글')), guards);
  assert.equal(outside.snapped, null);
  assert.equal(outside.text, '머리 인용\n두 줄\n\n새 문장\n사람이 쓴 글\n초안 인용');
  // A guard the field no longer contains protects nothing, and an empty guard list is not an error.
  const gone = C.placeBlock(body, '새 문장', at(body.indexOf('두 줄')), ['지워진 인용']);
  assert.equal(gone.snapped, null, 'a citation whose text is no longer here cannot move an anchor');
  assert.equal(gone.text, '머리 인용\n새 문장\n두 줄\n\n사람이 쓴 글\n초안 인용');
  assert.equal(C.placeBlock(body, '새 문장', at(0), []).text, '새 문장\n' + body);
  // Repeated identical citations: every occurrence is protected, not only the first.
  const twice = '같은 글\n둘째 줄\n사이\n같은 글\n둘째 줄';
  for (const q of [twice.indexOf('둘째 줄'), twice.lastIndexOf('둘째 줄')]) {
    const plan = C.placeBlock(twice, 'N', at(q), ['같은 글\n둘째 줄']);
    assert.equal(C.lineBlockOccurrences(plan.text, '같은 글\n둘째 줄'), 2, 'both occurrences survive');
  }
});

// ── P6 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-SELECTION: a selection is never replaced, and the block follows it', () => {
  const value = '첫 줄\n둘째 줄\n셋째 줄';
  const from = value.indexOf('둘째'), to = from + 2;
  for (const [s, e] of [[from, to], [to, from]]) {
    const plan = C.placeBlock(value, 'X', { start: s, end: e });
    assert.equal(plan.mode, 'selection');
    assert.equal(plan.text, '첫 줄\n둘째 줄\nX\n셋째 줄', 'the selected characters are all still there');
    assert.ok(plan.text.includes('둘째 줄'), 'nothing of the selection was consumed');
  }
  const all = C.placeBlock(value, 'X', { start: 0, end: value.length });
  assert.equal(all.text, value + '\nX', 'selecting everything inserts after everything');
  const collapsed = C.placeBlock(value, 'X', at(from));
  assert.equal(collapsed.mode, 'caret', 'an empty selection is a caret, not a selection');
});

// ── P7 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-BYTES: no normalisation, no trimming, and a CR-bearing value still loses nothing', () => {
  const odd = '탭\t끝  \n가 조합\n이모지 🧪';
  const block = '제목  \n본문\t끝';
  const plan = C.placeBlock(odd, block, at(odd.indexOf('\n') + 1));
  assert.equal(plan.text, '탭\t끝  \n' + block + '\n가 조합\n이모지 🧪');
  assert.equal(plan.text.slice(plan.start, plan.end), block, 'the block keeps its own bytes');
  assert.ok(plan.text.includes('가'), 'a decomposed sequence is not composed on the way in');
  // Precondition is an LF-only value (a textarea API value always is). A CR-bearing one must not
  // throw and must not lose a character; guards are simply not applied to it.
  const crlf = 'A line\r\nsecond';
  const safe = C.placeBlock(crlf, 'X', at(0), ['A line']);
  assert.equal(safe.text, 'X\n' + crlf);
  const loneCr = C.placeBlock('A line\rsecond', 'X', at(3), ['A line']);
  assert.ok(loneCr.text.includes('A line\rsecond'), 'every original character is still there');
  assert.equal(loneCr.snapped, 'line-end', 'a value we cannot number by line is not "protected"');
});

// ── P8 ────────────────────────────────────────────────────────────────────────────────────────
test('TEST-S3-U6-COUNTS: where a sentence goes never changes what the counts mean', () => {
  const block = '같은 문장';
  const first = C.placeBlock('머리\n꼬리', block, at(0)).text;
  const second = C.placeBlock(first, block, at(first.length)).text;
  assert.equal(C.lineBlockOccurrences(second, block), 2, 'two insertions are two occurrences wherever they sit');
  assert.equal(C.presenceState(2, 2), 'present');
  assert.equal(C.presenceState(1, 2), 'ambiguous');
  // The same two sentences inserted in the other order answer the same way.
  const other = C.placeBlock(C.placeBlock('머리\n꼬리', block, at(6)).text, block, at(0)).text;
  assert.equal(C.lineBlockOccurrences(other, block), C.lineBlockOccurrences(second, block));
  const entry = { field: 'findings', insertedText: block, sameTextCount: 2 };
  assert.equal(C.presenceOf(entry, second), 'present');
  assert.equal(C.presenceOf(entry, first), 'ambiguous', 'one of two identical citations is still ambiguous');
});

// ── P9 ────────────────────────────────────────────────────────────────────────────────────────
// The cursor DOM suite checks displayed placement, request text, unchanged selection and caret.
// No source-shape or sliced-harness markup assertions belong in this model suite.
