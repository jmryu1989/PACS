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
const MODULE_PATH = join(ROOT, 'worklist-v0/hpacs-lite/report-citation.js');
const html = readFileSync(join(ROOT, 'worklist-v0/hpacs-lite/main.html'), 'utf8');
const vectors = JSON.parse(readFileSync(join(__dirname, 'report_citation_vectors.json'), 'utf8'));

/** The shipped module, executed in this realm (same reason as report_citation_client_test.cjs). */
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
test('TEST-S3-U6-WIRING: the screen asks the rule once, shows that answer, and sends that answer', () => {
  // P-1: the base block is executed in an EMPTY vm by tests/report_rebase_model_test.cjs, so nothing
  // in it may touch $, document, RFIELDS or the citation module at evaluation time.
  const from = html.indexOf('    let selectionSeq = 0;');
  const to = html.indexOf('    function reportSource()', from);
  assert.ok(from >= 0 && to > from, 'the base block markers moved; re-pin this test');
  const sandbox = vm.createContext({});
  vm.runInContext(html.slice(from, to), sandbox);
  vm.runInContext('markSelectionChanged("1.2.3"); noteCaret("findings"); forgetCaret("findings");', sandbox);
  assert.equal(vm.runInContext('caretFields.size', sandbox), 0, 'the caret set is real, empty and inert');
  assert.equal(vm.runInContext('caretAt("findings")', sandbox), null, 'an unmarked field has no position');

  // The caret memory is a marker only: the position itself is read from the field at use time.
  const caret = extractFunction(html, 'caretAt');
  assert.match(caret, /caretFields\.has\(field\)/);
  assert.match(caret, /el\.selectionStart/);
  assert.match(caret, /el\.selectionEnd/);
  assert.match(extractFunction(html, 'markSelectionChanged'), /caretFields\.clear\(\);/,
    'a study move drops every remembered field');
  assert.ok(html.indexOf('$("#" + k).addEventListener("focus", () => noteCaret(k));') >= 0,
    'the fields mark themselves when the person puts the caret in them');

  // P-2: the pinned assignment stays byte-intact and the anchor is forgotten by API value.
  const load = extractFunction(html, 'loadReport');
  const assign = load.indexOf('el.value = locked ? "" : (src[sel.slice(1)] ?? "")');
  const forget = load.indexOf('if (el.value !== was) forgetCaret(sel.slice(1));');
  assert.ok(assign >= 0 && forget >= 0 && forget > assign, 'forgetting follows the write it is about');
  assert.ok(load.indexOf('const was = el.value;') >= 0 && load.indexOf('const was = el.value;') < assign);
  assert.ok(load.indexOf('recordReportOrigin') >= 0 && load.indexOf('recordReportOrigin') < assign);

  // P-3: exactly three places decide the plan - open, destination change (both on the live pane)
  // and the refusal (on the pane the press captured). A fourth would absorb what it should refuse.
  assert.equal(html.split('citePane.plan = ').length - 1, 2, 'open and destination change, and no more');
  /**
   * S3-structured-report put a second form in this file, and its pane is also called `pane`, so a
   * whole-file count of `pane.plan = ` now mixes two units' sites together. Renaming the product
   * variable would move the M2/M3c mutant anchors and invalidate every recomputed mutant hash, so
   * the two regions are counted separately instead. Neither number is relaxed: the citation side
   * keeps its "one refusal site and no fourth", and the structure side gets its own exact two.
   *
   * The delimiters are asserted unique AND the slice asserted substantial, so a marker that moved
   * (leaving an empty or collapsed region) fails here instead of quietly passing both counts.
   */
  const STRUCT_FROM = '    /* ── 구조화 판독 본문 (S3-structured-report)';
  const STRUCT_TO = '    function citationBody(scope, field) {';
  assert.equal(html.split(STRUCT_FROM).length - 1, 1, 'the structure block opening marker is unique');
  assert.equal(html.split(STRUCT_TO).length - 1, 1, 'the structure block closing marker is unique');
  const structFrom = html.indexOf(STRUCT_FROM), structTo = html.indexOf(STRUCT_TO, structFrom);
  assert.ok(structFrom >= 0 && structTo > structFrom, 'the structure block is where its markers say');
  const structBlock = html.slice(structFrom, structTo);
  assert.ok(structBlock.length > 5000, 'an empty or collapsed slice must not be able to satisfy either count');
  assert.equal((html.slice(0, structFrom) + html.slice(structTo)).split('pane.plan = ').length - 1, 1,
    'plus the refusal, and no fourth site');
  assert.equal(structBlock.split('pane.plan = ').length - 1, 2,
    'the structured-entry form decides its plan in exactly two places: the render and the stale refusal');
  assert.ok(extractFunction(html, 'insertCitation').indexOf('pane.plan = plan2;') >= 0,
    'the refusal is the only place the press itself may move the plan');
  const render = extractFunction(html, 'renderCitePreview');
  assert.ok(render.indexOf('placementLine($("#cite-preview-field").value, citePane.plan)') >= 0,
    'the preview displays the plan it was given');
  assert.equal(render.indexOf('citationPlan('), -1, 'and never recomputes it: the press itself calls this function');
  const open = extractFunction(html, 'openCitePreview');
  assert.ok(open.indexOf('citePane.plan = citationPlan("findings", citePane.block);') >= 0,
    'the destination default is explicit and the plan is taken for it');

  // The guard list is the accepted one: head whenever the row exists, draft only while confirmed.
  const guards = extractFunction(html, 'citationGuards');
  assert.match(guards, /citations\.known\(uid\) \? \[\.\.\.row\.head, \.\.\.row\.draft\] : \[\.\.\.row\.head\]/);
  assert.match(guards, /!KinReportCitation\.isReduced\(e\)/, 'a reduced entry carries no text to protect');
  assert.match(extractFunction(html, 'citationPlan'), /KinReportCitation\.placeBlock\(\$\("#" \+ field\)\.value/);

  // The template path uses the same rule, on LF-normalised template text (P-7).
  const template = extractFunction(html, 'insertTemplate');
  const place = template.indexOf('KinReportCitation.placeBlock(el.value, KinReportCitation.toLf(t[k]),');
  const write = template.indexOf('el.value = plan.text;');
  const select = template.indexOf('el.setSelectionRange(plan.end, plan.end);');
  assert.ok(place >= 0 && write > place && select > write, 'place, then write, then the caret');
  assert.ok(template.indexOf('caretAt(k)') >= 0 && template.indexOf('citationGuards(k)') >= 0,
    'each field uses its own caret and its own guards');
  assert.doesNotMatch(template, /el\.value \+=/, 'the position-free append is gone from this path too');
  assert.match(template, /if \(!t\[k\]\) continue;/, 'a field the template does not fill is still untouched');

  // The person is told where it goes, in lines of text, and the no-caret case does not pretend.
  const line = extractFunction(html, 'placementLine');
  assert.match(line, /번째 줄\(줄바꿈 기준\)부터/);
  assert.match(line, /이 칸에서 확인된 커서 자리가 없어 끝에 붙입니다/);
  assert.match(line, /커서가 줄 중간이라 그 줄 다음으로 맞췄습니다/);
  assert.match(line, /이미 인용된 문장을 쪼개지 않도록 그 뒤로 옮겼습니다/);
  assert.match(line, /선택한 글은 지우지 않고 그 뒤에 넣습니다/);
  const insert = extractFunction(html, 'insertCitation');
  assert.match(insert, /판독문이나 삽입 위치가 그 사이 바뀌었습니다 — 위의 삽입 위치를 다시 확인하고 한 번 더 누르세요\./);

  // The browser harness slices this file rather than retyping it. If those slices do not compile,
  // every hosted case dies before its first assertion - which is exactly what happened in U3 - and
  // the browser is the one place we cannot try it here. So compile them on the host instead.
  const domTest = readFileSync(join(ROOT, 'tests/report_cursor_insert_dom_test.py'), 'utf8');
  let harness = '';
  for (const [name, from, to] of [['BASE_BLOCK', '    let selectionSeq = 0;', '    function reportSource()'],
                                  ['REPORT_BLOCK', '    function reportSource() {', '    function heldByOther(s)']]) {
    assert.ok(domTest.includes(`${name} = slice_between(MAIN, ${JSON.stringify(from)}, ${JSON.stringify(to)})`),
      `${name} must be sliced from the product with these markers`);
    const a = html.indexOf(from), b = html.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${name} markers are gone from main.html`);
    harness += html.slice(a, b) + '\n';
  }
  for (const name of ['api', 'reportWriteBlock', 'reportEditorBlock', 'templateInsertionBlock', 'insertTemplate']) {
    assert.ok(domTest.includes(`extract_function(MAIN, "${name}")`), `${name} must be taken from the product`);
    harness += extractFunction(html, name) + '\n';
  }
  assert.doesNotThrow(() => new vm.Script(harness, { filename: 'cursor-dom-harness.js' }),
    'the sliced browser harness must compile');

  /**
   * Compiling is not running. The sliced region also EXECUTES top-level statements, and every one
   * of them that reaches for an element by id needs that element to exist or the whole script dies
   * on a TypeError - after which nothing later is defined and every case fails for a reason that has
   * nothing to do with the product. So the markup the harness puts on the page must cover every id
   * the region names. The modal markup is sliced from main.html, so it counts as coverage.
   */
  let markup = domTest;
  // S3-structured-report added a third modal inside the same sliced region, and the U6 harness
  // slices it for the same reason it slices the other two: the region registers listeners on it at
  // the top level, so without the markup the page dies while loading. Counting it here is what this
  // pin already says - markup sliced from main.html counts as coverage - not a relaxation of it.
  for (const [name, from, to] of [['CITE_HTML', '<div class="modal" id="cite-preview"', '\n  </div>'],
                                  ['PANE_HTML', '<div class="modal" id="stalemodal"', '\n  </div>'],
                                  ['STRUCT_HTML', '<div class="modal" id="structmodal"', '\n  </div>']]) {
    assert.ok(domTest.includes(`${name} = slice_between(MAIN, '${from}', "${to.replace('\n', '\\n')}")`),
      `${name} must be sliced from the product`);
    const a = html.indexOf(from), b = html.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${name} markers are gone from main.html`);
    markup += html.slice(a, b);
  }
  const wanted = new Set();
  for (const [, from, to] of [[0, '    let selectionSeq = 0;', '    function reportSource()'],
                              [0, '    function reportSource() {', '    function heldByOther(s)']])
    for (const line of html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from))).split('\n'))
      for (const hit of line.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) wanted.add(hit[1]);
  assert.ok(wanted.size >= 20, 'the id scan found suspiciously little; re-pin it');
  /**
   * One id in the region is reached only from inside `if (!structureForm.empty) { ... }`: the
   * structured-entry button is CREATED there and inserted before `#b-print`. The product catalog
   * ships empty, so that branch never runs and no page can die on it - but the scan above is
   * textual and cannot see a guard, so the exemption is written out and tied to the two facts that
   * make it true. Fill the catalog and this fails, which is exactly right: the U6 harness would
   * then need that button on its page.
   */
  const guardAt = structBlock.indexOf('if (!structureForm.empty) {');
  assert.ok(guardAt >= 0, 'the structured button is created behind the empty-catalog guard');
  assert.ok(structBlock.slice(guardAt).includes('$("#b-print").before(button);'),
    '#b-print is reached only from inside that guard');
  assert.match(readFileSync(join(ROOT, 'worklist-v0/hpacs-lite/report-structure.js'), 'utf8'),
    /PRODUCT_CATALOG = Object\.freeze\(\[\]\)/, 'the shipped catalog is empty, so that branch is dead');
  const deadBranchOnly = new Set(['b-print']);
  const missing = [...wanted].filter(id => !markup.includes(`id="${id}"`) && !deadBranchOnly.has(id));
  assert.deepEqual(missing, [], 'every element the sliced product region asks for must be on the page');
});
