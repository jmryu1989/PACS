'use strict';
// S9-U0a-PRE: the 35 declaration moves of Astra's pre-review design (design.md, "최종 이동 35단위"), applied to the
// f1d5406 main.html (= 2fc7358) at TypeScript AST positions. A statement moves verbatim with the comment block that
// documents it; the three multi-declarator units take one declarator out (the others keep their initializers and
// order). No registration, call site or function body changes. Each destination gets one reason comment.
//   node apply_moves.cjs <out.html> [--except M07,M25] [--m36] [--m37]
// --except leaves those units at their original late position (the M01..M35 mutants); --m36 / --m37 add the two
// extra mutants of the design on top. Prints a JSON report (located lines per unit) on stdout.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const { scripts } = require(path.join(ROOT, 'tests/page_source.cjs'));
const { statements } = require(path.join(ROOT, 'tests/main_move_contract.cjs'));
const ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'api')] }));
const ORIGINAL = 'f1d540626aac03f46de23a9620d69f4c9da66037';

// [id, statement (move-contract naming), design line, destination statement, first line of its own comment, declarator]
const MOVES = [
  ['M01', 'selectionSeq', 5514, 'ExpressionStatement after work #1', 5505],
  ['M02', 'studies', 2734, 'templates'],
  ['M03', 'quickDays, sortKey, sortDir, selectedUid, selectedOid', 2747, 'templates', null, 'selectedUid'],
  ['M04', 'cur', 3461, 'templates'],
  ['M05', 'RFIELDS', 5405, 'templates'],
  ['M06', 'reportWriteBlock', 9050, 'templates', 9042],
  ['M07', 'editReport', 7406, 'ExpressionStatement after expandShortcut #1', 7390],
  ['M08', 'relatedModalities', 3814, 'relatedParts'],
  ['M09', 'relatedPage, relatedPageQuery', 3817, 'relatedParts'],
  ['M10', 'renderRelated', 3821, 'relatedParts'],
  ['M11', 'savedFilterDays', 3146, 'ExpressionStatement after listLoadSequence #1'],
  ['M12', 'filteredFor', 3154, 'ExpressionStatement after listLoadSequence #1', 3152],
  ['M13', 'consultationFilter, consultationFilterSequence', 3171, 'ExpressionStatement after listLoadSequence #1', null, 'consultationFilter'],
  ['M14', 'searchCriteria', 3172, 'ExpressionStatement after listLoadSequence #1'],
  ['M15', 'filtered', 3173, 'ExpressionStatement after listLoadSequence #1'],
  ['M16', 'orderedStudies', 3182, 'ExpressionStatement after listLoadSequence #1', 3181],
  ['M17', 'resultPage, resultQuery, resultPageSize', 3189, 'ExpressionStatement after listLoadSequence #1'],
  ['M18', 'render', 3190, 'ExpressionStatement after listLoadSequence #1'],
  ['M19', 'relatedStudy', 3462, 'ExpressionStatement after listLoadSequence #1'],
  ['M20', 'viewed', 3463, 'ExpressionStatement after listLoadSequence #1'],
  ['M21', 'renderStudyIdentity', 3772, 'ExpressionStatement after listLoadSequence #1'],
  ['M22', 'renderDraftHint', 5781, 'ExpressionStatement after listLoadSequence #1', 5775],
  ['M23', 'heldByOther', 7812, 'ExpressionStatement after listLoadSequence #1'],
  ['M24', 'updateReportButtons', 7814, 'ExpressionStatement after listLoadSequence #1'],
  ['M25', 'validUserFilters', 11376, 'ExpressionStatement after listLoadSequence #1'],
  ['M26', 'userFilters', 11378, 'ExpressionStatement after listLoadSequence #1'],
  ['M27', 'TryStatement after userFilters #1', 11379, 'ExpressionStatement after listLoadSequence #1'],
  ['M28', 'activeFilterName', 11386, 'ExpressionStatement after listLoadSequence #1'],
  ['M29', 'renderActiveFilter', 11395, 'ExpressionStatement after listLoadSequence #1'],
  ['M30', 'renderChips', 11548, 'ExpressionStatement after listLoadSequence #1'],
  ['M31', 'layoutMode', 11211, 'readingWorkspace'],
  ['M32', 'workspaceState, workspaceOwner, workspaceStorage, workspaceGeneration', 11212, 'readingWorkspace', null, 'workspaceState'],
  ['M33', 'portraitLayout', 11216, 'readingWorkspace'],
  ['M34', 'workspaceAxis', 11217, 'readingWorkspace'],
  ['M35', 'applyLayout', 11246, 'readingWorkspace'],
];
const REASONS = {
  'ExpressionStatement after work #1':
    '// 아래 받아쓰기 칸 focus 등록이 읽는 선택 순번이다. 분할된 script 사이에 온 초기 focus도 읽을 수 있게 그 등록보다 먼저 선언한다(S9-U0a-PRE).',
  templates:
    '// 상용구 검색·View·삽입 관문과 그 등록(아래)이 부르는 선언이다. script를 나눠 실어도 틈의 초기 입력이 미정의를 만나지 않게 등록보다 앞에 둔다(S9-U0a-PRE).',
  'ExpressionStatement after expandShortcut #1':
    '// 단축어 Tab(아래 등록)이 부르는 편집기의 한 자리다. 분할된 script 사이의 Tab이 미정의를 만나지 않게 등록보다 앞에 둔다(S9-U0a-PRE).',
  relatedParts:
    '// relatedParts의 종료(pagehide)가 부르는 Related 목록 그리기다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).',
  'ExpressionStatement after listLoadSequence #1':
    '// studyPriority·Quick Match·검색·기능 패널의 종료가 부르는 목록·칩·판독 단추 그리기 묶음이다. 분할된 script 사이의 입력·종료가 미정의를 만나지 않게 이 생성보다 앞에 둔다(S9-U0a-PRE).',
  readingWorkspace:
    '// 읽기 작업공간의 종료(pagehide)가 부르는 배치 적용이다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).',
};

const args = process.argv.slice(2);
const out = args[0];
const at = args.indexOf('--except');
const except = new Set(at >= 0 ? args[at + 1].split(',').filter(Boolean) : []);
const m36 = args.includes('--m36'), m37 = args.includes('--m37');
for (const id of except) if (!MOVES.some(m => m[0] === id)) throw new Error('unknown unit ' + id);

const html = execFileSync('git', ['cat-file', '--filters', `${ORIGINAL}:worklist-v0/hpacs-lite/main.html`],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const EOL = html.includes('\r\n') ? '\r\n' : '\n';
const lines = html.split(EOL);                       // 1-based line n = lines[n - 1]
const inline = scripts(html).filter(t => !t.src);
if (inline.length !== 1) throw new Error('one inline script expected');
const tag = inline[0], bodyAt = tag.start + tag.tag.indexOf('>') + 1, body = tag.body;
const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = statements(body).map(s => s.name);
if (names.length !== source.statements.length || names.length !== 658) throw new Error('unexpected original statement list');
const lineOf = offset => html.slice(0, offset).split('\n').length;
const node = name => { const i = names.indexOf(name); if (i < 0) throw new Error('no statement ' + name); return source.statements[i]; };
const startLine = n => lineOf(bodyAt + n.getStart(source)), endLine = n => lineOf(bodyAt + n.end - 1);
const isComment = t => /^\s*(\/\/|\/\*|\*)/.test(t);

const removed = new Set();
const replaced = new Map();                           // line -> new text
const before = new Map();                             // line -> lines inserted before it
const after = new Map();                              // line -> lines inserted after it
const groups = new Map();
const report = [];
for (const [id, name, line, dest, comment, declarator] of MOVES) {
  const n = node(name), first = startLine(n), last = endLine(n);
  if (first !== line) throw new Error(`${id}: ${name} starts at ${first}, the design says ${line}`);
  if (except.has(id)) { report.push({ id, name, line, restored: true }); continue; }
  let text;
  if (declarator) {
    if (first !== last) throw new Error(`${id}: a one-line declaration expected`);
    const list = n.declarationList, decls = list.declarations;
    const k = decls.findIndex(d => d.name.getText(source) === declarator);
    if (k < 0 || decls.length < 2) throw new Error(`${id}: declarator ${declarator}`);
    const kw = (list.flags & ts.NodeFlags.Const) ? 'const' : (list.flags & ts.NodeFlags.Let) ? 'let' : 'var';
    text = [`    ${kw} ${decls[k].getText(source)};`];
    const from = bodyAt + (k === 0 ? decls[0].getStart(source) : decls[k - 1].end);
    const to = bodyAt + (k === 0 ? decls[1].getStart(source) : decls[k].end);
    const lineAt = html.lastIndexOf('\n', from) + 1;
    const current = replaced.get(first) ?? lines[first - 1];
    replaced.set(first, current.slice(0, from - lineAt) + current.slice(to - lineAt));
  } else {
    const top = comment ?? first;
    for (let l = top; l < first; l++) if (!isComment(lines[l - 1])) throw new Error(`${id}: line ${l} is not its comment`);
    text = lines.slice(top - 1, last);
    for (let l = top; l <= last; l++) removed.add(l);
  }
  if (!groups.has(dest)) groups.set(dest, []);
  groups.get(dest).push(...text);
  report.push({ id, name, line, to: dest });
}
for (const [dest, texts] of groups) {
  let line = startLine(node(dest));
  while (isComment(lines[line - 2])) line--;          // above the destination's own comment block
  const block = ['    ' + REASONS[dest], ...texts];
  if (lines[line - 2].trim() === '') block.push('');
  before.set(line, block);
}
if (m36) { // Retry registers one more Quick Match closure, the same behaviour as the original one, then boots
  const handler = node('ExpressionStatement after splitFrame, splitSize #8').getText(source);
  const retry = 'retry.addEventListener("click", () => { retry.disabled = true; boot(); });';
  const l = lines.findIndex(t => t.includes(retry)) + 1;
  if (!l || lines.filter(t => t.includes(retry)).length !== 1) throw new Error('M36 anchor');
  replaced.set(l, lines[l - 1].replace(retry, `retry.addEventListener("click", () => { retry.disabled = true; ${handler.replace(/\r?\n\s*/g, ' ')} boot(); });`));
}
if (m37) { // the dictation edit notice moves after the citation input listener of the same textareas
  const notice = 'el.addEventListener("input", () => { work.edited(); dictation.redraw(); });';
  const l = lines.findIndex(t => t.trim() === notice) + 1;
  if (!l || !isComment(lines[l - 2])) throw new Error('M37 anchor');
  removed.add(l - 1); removed.add(l);
  after.set(endLine(node('ForOfStatement after scheduleCitationRefresh #1')),
    ['    for (const k of RFIELDS) $("#" + k).addEventListener("input", () => { work.edited(); dictation.redraw(); });']);
}
const result = [];
let dropped = false;                                  // a removed line since the last kept one
for (let l = 1; l <= lines.length; l++) {
  if (before.has(l)) { result.push(...before.get(l)); dropped = false; }
  if (removed.has(l)) { dropped = true; continue; }
  const text = replaced.get(l) ?? lines[l - 1];
  // A removal leaves no second blank line behind (only next to a removed unit; other blank runs stay).
  if (dropped && text.trim() === '' && result.length && result[result.length - 1].trim() === '') continue;
  result.push(text);
  dropped = false;
  if (after.has(l)) result.push(...after.get(l));
}
const page = result.join(EOL);
const bodyAfter = scripts(page).filter(t => !t.src)[0].body;
const parsed = ts.createSourceFile('inline.js', bodyAfter, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
if (parsed.parseDiagnostics.length) throw new Error('result does not parse');
fs.writeFileSync(out, page);
process.stdout.write(JSON.stringify({ out, statements: parsed.statements.length, except: [...except], m36, m37, units: report }) + '\n');
