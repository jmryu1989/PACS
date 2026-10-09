'use strict';
// Probe: the committed mutant generator (main_split_harness.cjs preMutant, working on the page under test) and the
// apply_moves.cjs mutants (from the f1d5406 blob, used for the full local run) give the same statements in the same
// order for every M01..M37 - comments may sit elsewhere, code may not.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const { preMutant, PRE_UNITS } = require(path.join(ROOT, 'tests/main_split_harness.cjs'));
const { scripts } = require(path.join(ROOT, 'tests/page_source.cjs'));
const ts = require(require.resolve('typescript', { paths: [path.join(ROOT, 'api')] }));
const page = path.join(ROOT, 'worklist-v0/hpacs-lite/main.html');
const stmts = html => { const body = scripts(html).filter(t => !t.src)[0].body;
  const sf = ts.createSourceFile('x.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return sf.statements.map(n => n.getText(sf).replace(/\r\n?/g, '\n')); };
const ids = [...PRE_UNITS.map(u => u[0]), 'M36', 'M37'];
const out = {};
for (const id of ids) {
  const scratch = path.join(os.tmpdir(), `kin-pre-equiv-${id}.html`);
  const flags = id === 'M36' ? ['--m36'] : id === 'M37' ? ['--m37'] : ['--except', id];
  execFileSync(process.execPath, [path.join(__dirname, 'apply_moves.cjs'), scratch, ...flags], { cwd: ROOT });
  const a = stmts(fs.readFileSync(scratch, 'utf8')), b = stmts(preMutant(page, id));
  out[id] = JSON.stringify(a) === JSON.stringify(b) ? 'same' : `differs (${a.length} vs ${b.length})`;
}
console.log(JSON.stringify(out));
console.log('all same:', Object.values(out).every(v => v === 'same'));
