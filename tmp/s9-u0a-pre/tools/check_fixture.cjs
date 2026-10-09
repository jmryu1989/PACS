'use strict';
// Probe: the fixture projection of BASE_BLOCK / REPORT_BLOCK on the f1d5406 page and on the page under test, compared
// statement by statement with the f1d5406 marker cuts the legacy tests used.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const { fixtureBlocks, FIXTURE_BASE } = require(path.join(ROOT, 'tests/main_split_harness.cjs'));
const { readPageSource } = require(path.join(ROOT, 'tests/page_source.cjs'));
const ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'api')] }));
const ranges = { BASE_BLOCK: ['selectionSeq', 'reportSource'], REPORT_BLOCK: ['reportSource', 'heldByOther'] };
const original = execFileSync('git', ['cat-file', '--filters', `${FIXTURE_BASE}:worklist-v0/hpacs-lite/main.html`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const scratch = path.join(require('node:os').tmpdir(), 'kin-pre-fixture-original.html');
fs.writeFileSync(scratch, original);
const cut = (s, a, b) => { const i = s.indexOf(a); return s.slice(i, s.indexOf(b, i + a.length)); };
const marker = { BASE_BLOCK: cut(original, '    let selectionSeq = 0;', '    function reportSource()'),
  REPORT_BLOCK: cut(original, '    function reportSource() {', '    function heldByOther(s)') };
const stmts = text => { const sf = ts.createSourceFile('x.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return sf.statements.map(n => n.getText(sf).replace(/\r\n?/g, '\n')); };
const out = {};
for (const [label, page] of [['f1d5406', scratch], ['page under test', process.argv[2] || path.join(ROOT, 'worklist-v0/hpacs-lite/main.html')]]) {
  const blocks = fixtureBlocks(page, ranges);
  for (const key of Object.keys(ranges)) {
    const a = stmts(marker[key]), b = stmts(blocks[key]);
    out[`${label} ${key}`] = { marker_statements: a.length, fixture_statements: b.length,
      same_statements_in_order: JSON.stringify(a) === JSON.stringify(b) };
  }
}
console.log(JSON.stringify(out, null, 1));
