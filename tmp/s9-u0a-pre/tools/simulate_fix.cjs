'use strict';
// Probe only (scratch copies, never the product): the minimal changes early-input.md proposes, applied to a copy of
// main.html so the phase-1 tests can be checked for satisfiability and for catching the known wrong designs.
//   node simulate_fix.cjs <variant> <out.html>
// variants (comma-joined): hoist | init-templates | init-templates-keep-window | init-quick-match | init-worklist-controls
//   | init-report-hold (its non-window registrations)
//   | noguard (the boot init runs on every boot: the Retry re-registration mutant)
//   | late-init (the init runs after the session answer: the auth-dependent registration mutant)
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../..');
const { scripts } = require(path.join(ROOT, 'tests/page_source.cjs'));
const spec = require(path.join(ROOT, 'tests/main_move_spec.json'));
const ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'api')] }));

const [variants, out] = [process.argv[2].split(','), process.argv[3]];
const html = fs.readFileSync(path.join(ROOT, 'worklist-v0/hpacs-lite/main.html'), 'utf8');
const tag = scripts(html).find(t => !t.src);
const body = tag.body;
const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const nodes = source.statements;
const moduleOf = spec.modules.flatMap((m, i) => m.statements.map(() => m.file));
const names = spec.modules.flatMap(m => m.statements);
const index = name => { const i = names.indexOf(name); if (i < 0) throw new Error('no statement ' + name); return i; };
const text = i => nodes[i].getText(source);
const registers = i => /\.addEventListener\(/.test(text(i)) && (ts.isExpressionStatement(nodes[i]) || ts.isForOfStatement(nodes[i]));
const onWindow = i => /^\s*window\.addEventListener\(/.test(text(i));

const edits = []; // [start, end, replacement]
const wrapped = [];
function wrap(i) { wrapped.push(i); edits.push([nodes[i].getStart(source), nodes[i].end, `__preInit.push(() => { ${text(i)} });`]); }

if (variants.includes('hoist')) {
  const seq = index('selectionSeq'), work = index('work');
  edits.push([nodes[seq].getStart(source), nodes[seq].end, '']);
  edits.push([nodes[work].end, nodes[work].end, '\n    ' + text(seq)]);
}
const pick = (files, keepWindow, filter = () => true) => names.forEach((_, i) => {
  if (files.includes(moduleOf[i]) && registers(i) && !(keepWindow && onWindow(i)) && filter(i)) wrap(i);
});
if (variants.includes('init-templates')) pick(['report-templates.js', 'report-templates-ui.js'], false);
if (variants.includes('init-templates-keep-window')) pick(['report-templates.js', 'report-templates-ui.js'], true);
if (variants.includes('init-quick-match')) pick(['worklist-controls.js'], false, i => /#quick-match/.test(text(i)));
if (variants.includes('init-worklist-controls')) pick(['worklist-controls.js'], false);
if (variants.includes('init-report-hold')) pick(['report-hold.js'], true);
if (wrapped.length) {
  const work = index('work'), boot = index('boot');
  const guard = variants.includes('noguard') ? '' : 'if (__preInitDone) return; __preInitDone = true; ';
  edits.push([nodes[work].end, nodes[work].end,
    `\n    const __preInit = []; let __preInitDone = false;\n    function __preInitRun() { ${guard}for (const f of __preInit) f(); }`]);
  // late-init: the mutant that registers only after the session answer (the first await of boot).
  const at = variants.includes('late-init') ? text(boot).indexOf('sess = KinAuth.session();') : text(boot).indexOf('{') + 1;
  if (at <= 0) throw new Error('boot has changed');
  const open = at + nodes[boot].getStart(source);
  edits.push([open, open, '\n      __preInitRun();']);
}
edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
let next = body;
for (const [start, end, replacement] of edits) next = next.slice(0, start) + replacement + next.slice(end);
const page = html.slice(0, tag.start) + '<script>' + next + '</script>' + html.slice(tag.end);
fs.writeFileSync(out, page);
process.stdout.write(JSON.stringify({ variants, wrapped: wrapped.map(i => `${moduleOf[i]} :: ${names[i]}`) }, null, 1) + '\n');
