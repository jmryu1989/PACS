const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../worklist-v0/hpacs-lite/viewer-windows.js');
const registries = [];
const create = options => { const registry = model.create(options); registries.push(registry); return registry; };
after(() => registries.forEach(registry => registry.end()));
const id = '00000000-0000-4000-8000-000000000001';
const origin = 'https://localhost:9443';
const url = n => origin + '/ohif/viewer?StudyInstanceUIDs=1.2.' + n;
function setup(seed) {
  const values = new Map(seed || []), storage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) };
  let owner = '["i","a"]';
  const options = { storage, owner: () => owner, newId: () => id, origin,
    describe: popup => ({ kind: 'viewer', href: popup.href, ready: true, busy: !!popup.busy, dirty: !!popup.dirty }) };
  return { values, storage, options, registry: create(options), changeOwner: v => { owner = v; } };
}
test('window records contain only bounded identifiers and occupancy', () => {
  const good = { version: 1, id, slots: [true,false,false,true] };
  assert.deepEqual(model.normalize(good), good);
  for (const patch of [{ version: 2 }, { id: 'wrong' }, { slots: [true] }, { slots: [1,false,false,false] }, { uid: '1.2' }])
    assert.equal(model.normalize({ ...good, ...patch }), null);
});
test('scope refuses other origins, duplicate queries, malformed and excessive study scope', () => {
  assert.deepEqual(model.scope(url(1), origin), { studies: ['1.2.1'], series: null });
  for (const href of ['https://other.test/ohif/viewer?StudyInstanceUIDs=1.2', '/other?StudyInstanceUIDs=1.2',
    '/ohif/viewer?StudyInstanceUIDs=1.2&StudyInstanceUIDs=1.3', '/ohif/viewer?StudyInstanceUIDs=1.2,1.2',
    '/ohif/viewer?StudyInstanceUIDs=1.2,1.3,1.4', '/ohif/viewer?StudyInstanceUIDs=1..2',
    '/ohif/viewer?StudyInstanceUIDs=1.2&initialSeriesInstanceUID=bad']) assert.equal(model.scope(href, origin), null);
});
test('one window reuses slot zero; several windows retain distinct scopes until explicitly closed', () => {
  const { registry:r, values } = setup();
  const a = r.choose(url(1), 2), pa = { href: url(1), closed: false, dirty: true }; r.attach(a, pa);
  const b = r.choose(url(2), 2), pb = { href: url(2), closed: false }; r.attach(b, pb);
  assert.equal(r.choose(url(1), 2).index, a.index);
  assert.equal(r.choose(url(3), 2).full, true);
  assert.equal(r.choose(url(3), 1).full, true);
  pb.closed = true;
  const c = r.choose(url(3), 2); assert.equal(c.index, b.index);
  r.blocked(c); assert.equal(r.rows().length, 1);
  assert.equal(r.choose(url(4), 1).index, a.index);
  const record = [...values.values()][0]; assert.ok(!record.includes('StudyInstanceUIDs')); assert.ok(!record.includes('1.2.1'));
});
test('reload retains unverified occupied slots; silence cannot free capacity', () => {
  const { registry:r, options } = setup(); r.attach(r.choose(url(1), 2), { href: url(1), closed: false });
  r.attach(r.choose(url(2), 2), { href: url(2), closed: false });
  const resumed = create(options);
  assert.equal(resumed.rows().length, 2); assert.equal(resumed.choose(url(3), 2).full, true);
  assert.equal(resumed.rows()[0].scope, null);
});
test('blocked popup reservation, owner changes and denied/corrupt storage cannot bypass the cap', () => {
  const s = setup(), a = s.registry.choose(url(1), 2); s.registry.blocked(a);
  assert.equal(s.registry.rows().length, 0);
  s.changeOwner('["i","b"]'); assert.ok(s.registry.choose(url(1), 2).error);
  for (const storage of [{ getItem() { throw Error('denied'); } }, { getItem: () => '{', setItem() {} },
    { getItem: () => null, setItem() { throw Error('quota'); } }]) {
    const r = create({ ...s.options, storage }); assert.equal(r.available(), false); assert.ok(r.choose(url(1), 2).error);
  }
});
test('window hash preserves the reading return token and carries no new clinical fields', () => {
  const { registry:r } = setup(); const a=r.choose(url(1), 2);
  const linked = new URL(r.linked(url(1) + '#kin-reading-return=' + id, a.index), origin);
  const hash = new URLSearchParams(linked.hash.slice(1));
  assert.equal(hash.get('kin-reading-return'), id); assert.equal(hash.get('kin-window-group'), id);
  assert.equal(hash.get('kin-window-slot'), '0'); assert.equal(hash.size, 3);
});
