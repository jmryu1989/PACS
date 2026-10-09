'use strict';
// S9-U0a-PRE C: tests/main_move_spec.json regenerated from the P main.html AST - the same 45 files in order and
// parts [18, 30, 45]; every statement key is the move contract's own name in the new AST (no hand edits); a statement
// PRE moved belongs to the run it now sits in (main_split_harness.cjs deriveSpec, against the f1d5406 spec).
//   node regenerate_spec.cjs <P sha> <out.json>
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../../..');
const { deriveSpec } = require(path.join(ROOT, 'tests/main_split_harness.cjs'));
const { chunks, statements } = require(path.join(ROOT, 'tests/main_move_contract.cjs'));
const { scripts } = require(path.join(ROOT, 'tests/page_source.cjs'));
const old = require(path.join(ROOT, 'tests/main_move_spec.json'));
const [P, out] = process.argv.slice(2);
assert.match(P, /^[0-9a-f]{40}$/);
const html = execFileSync('git', ['cat-file', '--filters', `${P}:${old.page}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8e6 });
const scratch = path.join(require('node:os').tmpdir(), 'kin-pre-P-main.html');
fs.writeFileSync(scratch, html);
const derived = deriveSpec(scratch);
const spec = { schema: old.schema, base: P, page: old.page, parts: old.parts,
  note: 'S9-U0a-PRE P의 AST에서 재생성한 순서 보존 run. PRE가 앞당긴 35개 선언은 지금 놓인 run에 속한다. 제품 미이동. 첫 실제 이동은 승인된 PRE 최종 C로 base를 다시 고정한다.',
  modules: derived.modules.map(m => ({ file: m.file, job: m.job, statements: m.statements })) };
const body = scripts(html).filter(t => !t.src)[0].body;
assert.deepEqual(spec.modules.flatMap(m => m.statements), statements(body).map(s => s.name), 'every statement once, in order');
assert.deepEqual(spec.modules.map(m => m.file), old.modules.map(m => m.file), 'the same 45 files in order');
assert.ok(spec.modules.every(m => m.statements.length > 0), 'no empty run');
assert.equal(chunks(html, spec).length, 45);
fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
process.stdout.write(JSON.stringify({ base: P, statements: spec.modules.reduce((n, m) => n + m.statements.length, 0),
  moved: derived.moved, runs: spec.modules.map(m => m.statements.length) }) + '\n');
