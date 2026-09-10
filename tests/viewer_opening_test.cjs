const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../worklist-v0/hpacs-lite/viewer-opening.js');
test('opening choices contain no study or report data and are strictly normalized', () => {
  const chosen = { version: 1, listTarget: 'workspace', includePrior: false };
  assert.deepEqual(model.normalize(chosen), chosen);
  assert.notEqual(model.normalize(chosen), chosen);
  for (const patch of [{ version: 2 }, { listTarget: 'tab' }, { includePrior: 1 }, { uid: '1.2.3' }])
    assert.equal(model.normalize({ ...chosen, ...patch }), null);
  for (const value of [null, [], {}, { version: 1, listTarget: 'window' }]) assert.equal(model.normalize(value), null);
});
test('owner uses institution and immutable subject, refuses anonymous and demo', () => {
  const a = { state: 'approved', institution: 'i', sub: 'a', name: 'same' };
  assert.equal(model.key(a), model.key({ ...a, name: 'new' }));
  assert.notEqual(model.key(a), model.key({ ...a, sub: 'b' }));
  assert.notEqual(model.key(a), model.key({ ...a, institution: 'j' }));
  for (const patch of [{ state: 'pending' }, { demo: true }, { sub: '' }, { institution: null }]) assert.equal(model.key({ ...a, ...patch }), null);
});
test('missing, corrupt and denied storage use safe defaults with distinct feedback', () => {
  assert.equal(model.read({ getItem: () => null }, 'a').status, 'empty');
  for (const raw of ['{', '{}', 'null', ' '.repeat(513), JSON.stringify({ ...model.defaults(), patient: 'unknown' })]) {
    const r = model.read({ getItem: () => raw }, 'a');
    assert.equal(r.status, 'invalid'); assert.deepEqual(r.value, model.defaults());
  }
  assert.equal(model.read({ getItem() { throw Error('denied'); } }, 'a').status, 'unavailable');
  assert.equal(model.read(null, null).status, 'disabled');
});
test('writes affect only one owner and retain explicit failures', () => {
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  model.write(storage, 'a', { version: 1, listTarget: 'workspace', includePrior: false });
  model.write(storage, 'b', model.defaults());
  assert.equal(model.read(storage, 'a').value.listTarget, 'workspace');
  assert.deepEqual(model.read(storage, 'b').value, model.defaults());
  assert.equal(model.write(storage, 'a', { ...model.defaults(), uid: '1' }), false);
  assert.equal(model.write(storage, null, model.defaults()), false);
  assert.equal(model.write({ setItem() { throw Error('quota'); } }, 'a', model.defaults()), false);
  assert.equal(values.size, 2);
});
