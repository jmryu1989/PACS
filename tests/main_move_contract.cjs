'use strict';
// Byte equality is the requirement for this behaviour-preserving move (AGENTS §1-B.14).
// No feature implementation strings are pinned: compare a page with its own pre-move source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../api')] }));
const { scripts, readPage } = require('./page_source.cjs');
const spec = require('./main_move_spec.json');

function statements(body) {
  const source = ts.createSourceFile('inline.js', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0, 'Inline script must parse');
  let previous = 'START';
  const counts = new Map();
  return source.statements.map(node => {
    let names = [];
    if (ts.isVariableStatement(node)) names = node.declarationList.declarations.map(d => d.name.getText(source));
    else if (node.name) names = [node.name.getText(source)];
    let name;
    if (names.length) { name = names.join(', '); previous = name; }
    else {
      const key = `${ts.SyntaxKind[node.kind]} after ${previous}`;
      const n = (counts.get(key) || 0) + 1; counts.set(key, n); name = `${key} #${n}`;
    }
    return { name, start: node.getFullStart(), end: node.end };
  });
}

function chunks(before, contract = spec) {
  const inline = scripts(before).filter(t => !t.src);
  assert.equal(inline.length, 1, 'Pre-move page must have one inline block');
  const body = inline[0].body;
  const nodes = statements(body);
  assert.deepEqual(contract.modules.flatMap(m => m.statements), nodes.map(n => n.name),
    'Each named statement must be accounted for exactly once, in its original order');
  let index = 0;
  return contract.modules.map(m => {
    const start = nodes[index].start;
    index += m.statements.length;
    const end = index < nodes.length ? nodes[index].start : body.length;
    return { file: m.file, job: m.job, body: body.slice(start, end), statements: m.statements.length };
  });
}

function verify(before, page, contract = spec) {
  const parts = chunks(before, contract);
  const actual = readPage(page);
  if (actual.bundle) {
    for (const part of parts)
      assert.equal(fs.readFileSync(path.join(path.dirname(page), part.file), 'utf8'), part.body, `Moved bytes: ${part.file}`);
    assert.equal(actual.script, scripts(before).find(t => !t.src).body, 'Bundle artifact equals original body');
    assert.equal(actual.script, parts.map(p => p.body).join(''), 'Bundle artifact equals ordered sources (binary-proven empty boundaries)');
    assert.equal(actual.source, before, 'Markup outside the original script element must be identical');
    return { modules: parts.length, statements: parts.reduce((n, m) => n + m.statements, 0), bytes: Buffer.byteLength(actual.script) };
  }
  const moved = actual.region.filter(t => t.src);
  assert.deepEqual(moved.map(t => t.src), parts.slice(0, moved.length).map(m => m.file), 'Load order = spec order');
  for (let i = 0; i < moved.length; i++)
    assert.equal(fs.readFileSync(path.join(path.dirname(page), moved[i].src), 'utf8'), parts[i].body, `Moved bytes: ${moved[i].src}`);
  assert.equal(actual.script, scripts(before).find(t => !t.src).body, 'No dropped, duplicated, reordered or changed statement/trivia');
  assert.equal(actual.source, before, 'Markup outside the original script element must be identical');
  return { modules: moved.length, statements: parts.reduce((n, m) => n + m.statements, 0), bytes: Buffer.byteLength(actual.script) };
}

function baseline() {
  // Git applies only the checkout's existing EOL filter; actual page/chunk comparisons above are byte-exact UTF-8.
  return execFileSync('git', ['cat-file', '--filters', `${spec.base}:${spec.page}`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 4e6 });
}
module.exports = { statements, chunks, verify, baseline };
