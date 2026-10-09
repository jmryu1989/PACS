'use strict';
// REQ-S9-U0a-BYTES -> RISK-MOVE-LOSS/DUPLICATION/ORDER -> TEST-S9-U0a-A1.
// Byte identity itself is the move requirement (AGENTS §1-B.14); no feature strings are pinned.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scripts, readPage } = require('./page_source.cjs');
const { baseline, chunks, verify } = require('./main_move_contract.cjs');
const spec = require('./main_move_spec.json');
const before = baseline();
const page = path.resolve(__dirname, '..', spec.page);
function scratch(t, prefix) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith(prefix));
    fs.rmSync(resolved, { recursive: true });
  });
  return dir;
}

test('A1: not-yet-moved page or moved page preserves every statement, byte and outer markup', () => {
  assert.equal(verify(before, page).statements, spec.modules.flatMap(m => m.statements).length);
});

for (const mutation of ['dropped', 'duplicated', 'swapped']) {
  test(`A1 rejects ${mutation} statements`, t => {
    const dir = scratch(t, 'u0a-a1-');
    const tag = scripts(before).find(t => !t.src);
    const { statements } = require('./main_move_contract.cjs');
    const nodes = statements(tag.body);
    const a = tag.body.slice(0, nodes[1].start), b = tag.body.slice(nodes[1].start, nodes[2].start);
    const tail = tag.body.slice(nodes[2].start);
    const body = mutation === 'dropped' ? b + tail : mutation === 'duplicated' ? a + a + b + tail : b + a + tail;
    const changed = before.slice(0, tag.start) + '<script>' + body + '</script>' + before.slice(tag.end);
    const target = path.join(dir, 'main.html'); fs.writeFileSync(target, changed);
    assert.throws(() => verify(before, target), /No dropped, duplicated, reordered or changed statement\/trivia/);
  });
}

test('A1/helper: all three split stages reconstruct the original text and enforce tags, files and markup', t => {
  const dir = scratch(t, 'u0a-split-');
  const tag = scripts(before).find(t => !t.src), parts = chunks(before);
  for (const count of spec.parts) {
    for (const p of parts.slice(0, count)) fs.writeFileSync(path.join(dir, p.file), p.body);
    const tags = parts.slice(0, count).map(p => `<script src="${p.file}"></script>`);
    if (count < parts.length) tags.push('<script>' + parts.slice(count).map(p => p.body).join('') + '</script>');
    const after = before.slice(0, tag.start) + tags.join('\n  ') + before.slice(tag.end);
    const target = path.join(dir, 'main.html'); fs.writeFileSync(target, after);
    assert.equal(verify(before, target).modules, count);
    assert.equal(readPage(target).source, before);
    for (const broken of [before.slice(0, tag.start) + [tags[1], tags[0], ...tags.slice(2)].join('\n  ') + before.slice(tag.end),
      after.replace('<script src=', '<script async src='), after.replace('</body>', '<!-- changed --></body>')]) {
      assert.notEqual(broken, after);
      fs.writeFileSync(target, broken); assert.throws(() => verify(before, target));
    }
    fs.writeFileSync(target, after);
    const firstFile = path.join(dir, parts[0].file);
    const { statements } = require('./main_move_contract.cjs');
    const nodes = statements(parts[0].body);
    const a = parts[0].body.slice(0, nodes[1].start), b = parts[0].body.slice(nodes[1].start, nodes[2].start);
    const tail = parts[0].body.slice(nodes[2].start);
    for (const changed of [b + tail, a + a + b + tail, b + a + tail]) {
      fs.writeFileSync(firstFile, changed);
      assert.throws(() => verify(before, target), /Moved bytes:/);
    }
    fs.writeFileSync(firstFile, parts[0].body);
    fs.unlinkSync(path.join(dir, parts[0].file));
    assert.throws(() => readPage(target), /ENOENT/);
  }
});
