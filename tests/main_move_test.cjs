'use strict';
// REQ-S9-U0a-BYTES -> RISK-MOVE-LOSS/DUPLICATION/ORDER -> TEST-S9-U0a-A1.
// Byte identity itself is the move requirement (AGENTS §1-B.14); no feature strings are pinned.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scripts, readPage } = require('./page_source.cjs');
const { baseline, chunks, verify, historicalPage, currentHomes } = require('./main_move_contract.cjs');
const spec = require('./main_move_spec.json');
const before = baseline();
const page = path.resolve(__dirname, '..', spec.page);
function currentProjection() {
  // Projection byte equality is the contract: independently join the editable
  // sources and preserve every outer HTML byte. Do not use page_source as its own oracle.
  const order = require('../scripts/main-split-order.json'), html = fs.readFileSync(page, 'utf8');
  const tag = '<script src="main-split.bundle.js"></script>';
  assert.equal(html.split(tag).length, 2, 'one canonical bundle tag');
  const body = order.sources.map(source => fs.readFileSync(path.join(path.dirname(page), source.file), 'utf8')).join('');
  return html.replace(tag, () => '<script>' + body + '</script>');
}
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

test('A1: landed split preserves every historical statement, byte and outer markup', t => {
  const frozen = historicalPage(scratch(t, 'u0a-history-'));
  const result = verify(before, frozen), actual = readPage(frozen);
  assert.equal(result.statements, spec.modules.flatMap(m => m.statements).length);
  assert.ok([0, ...spec.parts].includes(result.modules), 'Only the specified cumulative parts are deliverable');
  const newline = before.includes('\r\n') ? '\r\n' : '\n';
  actual.region.forEach((tag, i) => {
    if (tag.src) assert.equal(tag.tag, `<script src="${tag.src}"></script>`, 'Exact classic tag spelling');
    if (i) assert.equal(actual.html.slice(actual.region[i - 1].end, tag.start), newline + '  ', 'Exact tag separator');
  });
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

test('C5: actual projection, Python bytes, fixture cuts and delivered asset inventory agree', t => {
  const { actual, fixtureBlocks, REPORT_FIXTURE } = require('./main_split_harness.cjs');
  const dir = scratch(t, 'u0a-projection-'), source = path.join(dir, 'main.html');
  fs.writeFileSync(source, before);
  const candidate = readPage(page), manifest = actual(page);
  currentHomes(page);
  assert.equal(candidate.source, currentProjection());
  fs.writeFileSync(source, currentProjection());
  assert.deepEqual(fixtureBlocks(page, REPORT_FIXTURE), fixtureBlocks(source, REPORT_FIXTURE));
  assert.deepEqual(manifest.parts, candidate.files.map(p => path.basename(p)));
  assert.deepEqual(manifest.scripts, scripts(candidate.html).filter(t => t.src).map(t => t.src));
  for (const file of [page, ...candidate.files]) {
    const body = fs.readFileSync(file), info = manifest.inputs[path.basename(file)];
    assert.equal(info.sha256, require('node:crypto').createHash('sha256').update(body).digest('hex'));
    assert.equal(info.bytes, body.length);
  }
  const python = process.env.KIN_SPLIT_PYTHON || 'python3';
  const fromPython = execFileSync(python, ['-B', '-c',
    'import sys; sys.path.insert(0, "tests"); from page_source import read_page_bytes; sys.stdout.buffer.write(read_page_bytes(sys.argv[1]))', page],
    { cwd: path.resolve(__dirname, '..'), maxBuffer: 8e6 });
  assert.deepEqual(fromPython, Buffer.from(candidate.source), 'Python adapter preserves current projection bytes');
});

test('S1 historical byte contract', t => {
  verify(before, process.env.KIN_SPLIT_BYTE_PAGE || historicalPage(scratch(t, 'u0a-history-')));
});

test('C1 bundle artifact: stdlib binary equality and HTMLParser tag proof', () => {
  if (!readPage(page).bundle) return; // Historical 0/18/30/45 scratch layouts retain their own C1 checks.
  execFileSync(process.env.KIN_SPLIT_PYTHON || 'python3', ['-B', 'scripts/build-main-split-bundle.py', '--check'],
    { cwd: path.resolve(__dirname, '..'), maxBuffer: 2e6 });
});

test('C5 complete source projection', () => {
  const helper = process.env.KIN_SPLIT_PROJECTION_HELPER || './page_source.cjs';
  const source = require(helper).readPageSource(process.env.KIN_SPLIT_BYTE_PAGE || page);
  assert.equal(source, currentProjection(), 'C5 all current statements and outer markup are reconstructed when no inline script remains');
  currentHomes(page);
});

for (const [id, reason] of [['S1-M01', /Moved bytes/], ['S1-M02', /ENOENT/], ['S1-M03', /No dropped/],
  ['S1-M04', /load order/], ['S1-M05', /ordinary blocking classic/],
  ['S2-M01', /Moved bytes/], ['S2-M02', /load order/], ['S2-M03', /Moved bytes/], ['S2-M04', /No dropped/],
  ['S3-M01', /Moved bytes/], ['S3-M02', /load order/], ['S3-M03', /No dropped/], ['S3-M04', /ordinary blocking classic/]]) {
  test(`C1 rejects ${id}`, t => {
    const dir = scratch(t, 'u0a-part1-mutant-');
    const source = path.join(dir, 'main.html'); fs.writeFileSync(source, before);
    const candidate = require('./main_split_harness.cjs').splitMutant(source, id, path.join(dir, id));
    assert.throws(() => verify(before, candidate.page), reason);
  });
}
