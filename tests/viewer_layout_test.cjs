const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({ window: {}, document: {}, URLSearchParams });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../config/ohif.js'), 'utf8') + '\nglobalThis.model = kinViewerLayoutModel;', context);
const model = context.model;
const good = () => ({ version: 1, studies: ['1.2.3'], rows: 2, cols: 2, active: 3,
  cells: [{ study: '1.2.3', series: '1.2.4' }, null, { study: '1.2.3', series: '1.2.5' }, { study: '1.2.3', series: '1.2.4' }] });
const plain = v => JSON.parse(JSON.stringify(v));

test('recent grid round-trips references, empty and duplicate cells without transient IDs', () => {
  const data = good(), clean = model.normalize(data);
  assert.deepEqual(plain(clean), data);
  clean.cells[0].series = '1.2.99'; assert.equal(data.cells[0].series, '1.2.4');
  for (const [rows, cols] of [[1, 1], [1, 2], [2, 1], [2, 2]]) {
    const value = good(); Object.assign(value, { rows, cols, active: 0, cells: Array(rows * cols).fill(data.cells[0]) });
    assert.ok(model.normalize(value));
  }
});
test('strict schema refuses unsupported layout, scope, reference and active selection', () => {
  for (const patch of [{ version: 2 }, { rows: 3 }, { rows: '2' }, { cols: 0 }, { active: 4 }, { active: 0.5 },
    { active: -1 }, { studies: [] }, { studies: ['1.2.3', '1.2.3'] }, { studies: ['1.2.3', '1.4', '1.5'] },
    { patientName: 'must not persist' }, { cells: [null, null, null, null] }, { cells: [] },
    { cells: [{ study: '9.9', series: '1.2.4' }, null, null, null] },
    { cells: [{ study: '1.2.3', series: '1..2' }, null, null, null] },
    { cells: [{ study: '1.2.3', series: '1.2.4', displaySetInstanceUID: 'transient' }, null, null, null] }]) {
    assert.equal(model.normalize({ ...good(), ...patch }), null, JSON.stringify(patch));
  }
  for (const value of [null, [], 1, 'value']) assert.equal(model.normalize(value), null);
});
test('URL study scope is bounded, canonical and refuses ambiguous repeated parameters', () => {
  assert.deepEqual(plain(model.scope('?StudyInstanceUIDs=1.3,1.2')), ['1.2', '1.3']);
  for (const query of ['', '?StudyInstanceUIDs=', '?StudyInstanceUIDs=1.2,1.2', '?StudyInstanceUIDs=1,2,3',
    '?StudyInstanceUIDs=1..2', '?StudyInstanceUIDs=1&StudyInstanceUIDs=2', '?StudyInstanceUIDs=' + '1'.repeat(65)]) assert.equal(model.scope(query), null);
});
test('owner keys use immutable subject and institution and never display name', () => {
  const a = { kind: 'member', sub: 'a', institution: 'i', displayName: 'same' };
  assert.equal(model.owner(a), model.owner({ ...a, displayName: 'renamed' }));
  assert.notEqual(model.owner(a), model.owner({ ...a, sub: 'b' }));
  assert.notEqual(model.owner(a), model.owner({ ...a, institution: 'j' }));
  for (const patch of [{ kind: 'anonymous' }, { sub: '' }, { institution: '' }, { sub: null }, { sub: 'x'.repeat(257) }]) assert.equal(model.owner({ ...a, ...patch }), null);
});
test('storage corrupt/oversized data is refused, missing data is distinct', () => {
  assert.equal(model.read({ getItem: () => null }, 'owner'), null);
  for (const raw of ['{', '{}', 'null', JSON.stringify({ ...good(), extra: 1 }), ' '.repeat(8193)]) assert.throws(() => model.read({ getItem: () => raw }, 'owner'));
  assert.throws(() => model.read({ getItem: () => JSON.stringify(good()) }, null));
});
test('write replaces a single account record and preserves failures for the UI', () => {
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  model.write(storage, 'a', good()); model.write(storage, 'b', good());
  const next = good(); next.active = 0; model.write(storage, 'a', next);
  assert.equal(values.size, 2); assert.equal(model.read(storage, 'a').active, 0); assert.equal(model.read(storage, 'b').active, 3);
  assert.throws(() => model.write(storage, 'a', { ...good(), rows: 9 }));
  assert.throws(() => model.write({ setItem() { throw new Error('quota'); } }, 'a', good()), /quota/);
  assert.throws(() => model.read({ getItem() { throw new Error('blocked'); } }, 'a'), /blocked/);
});
