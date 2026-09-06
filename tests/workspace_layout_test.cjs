const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../worklist-v0/hpacs-lite/workspace-layout.js');
const session = { state: 'approved', sub: 'account-a', institution: 'hospital-a', user: 'old-name' };
const record = () => ({ version: 1, mode: 'portrait', portrait: { main: 350, top: 200 }, landscape: { main: 700 } });
function store() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k), data };
}

test('OWNER: immutable subject and institution isolate accounts; names do not identify storage', () => {
  const owner = layout.key(session);
  assert.equal(layout.key({ ...session, user: 'new-name' }), owner);
  assert.notEqual(layout.key({ ...session, sub: 'account-b' }), owner);
  assert.notEqual(layout.key({ ...session, institution: 'hospital-b' }), owner);
  for (const invalid of [null, {}, { ...session, sub: null }, { ...session, institution: '' },
    { ...session, state: 'pending' }, { ...session, demo: true }, { ...session, sub: 'x'.repeat(257) }]) {
    assert.equal(layout.key(invalid), null);
  }
  assert.notEqual(layout.key({ ...session, institution: 'a,b', sub: 'c' }), layout.key({ ...session, institution: 'a', sub: 'b,c' }));
});

test('OWNER/RESTORE: A/B by X/Y storage and owner-only reset', () => {
  const x = store(), y = store(), a = layout.key(session), b = layout.key({ ...session, sub: 'b' });
  assert.equal(layout.write(x, a, record()), true);
  assert.deepEqual(layout.read(x, a).state, record());
  for (const [device, owner] of [[x,b], [y,a], [y,b]]) assert.equal(layout.read(device, owner).status, 'empty');
  const other = { ...record(), mode: 'landscape' };
  layout.write(x, b, other);
  assert.equal(layout.remove(x,a), true);
  assert.equal(layout.read(x,a).status, 'empty');
  assert.deepEqual(layout.read(x,b).state, other);
});

test('INPUT: malformed schemas, fields and numeric boundaries fail closed', () => {
  const invalid = [null, [], 'text', {}, { ...record(), version: 2 }, { ...record(), mode: 'auto\n' },
    { ...record(), findings: 'must not persist' }, { ...record(), portrait: [] },
    { ...record(), landscape: { uid: 'patient' } }];
  for (const size of ['200', 0, -1, 16385, NaN, Infinity, null, true, {}, []]) invalid.push({ ...record(), portrait: { top: size } });
  for (const value of invalid) assert.equal(layout.normalize(value), null);
  const clean = layout.normalize({ ...record(), portrait: { main: 1, top: 16384, related: 245.6 } });
  assert.deepEqual(clean.portrait, { main: 1, top: 16384, related: 246 });
});

test('INPUT: corrupted or oversized stored JSON falls back without interpreting it', () => {
  const s = store(), k = layout.key(session);
  for (const raw of ['{', 'null', '[]', 'x'.repeat(2049), JSON.stringify({ ...record(), mode: '<script>' }),
    '{"version":1,"mode":"auto","portrait":{"__proto__":{}},"landscape":{}}']) {
    s.setItem(k,raw);
    const result = layout.read(s,k);
    assert.deepEqual(result.state,layout.defaults());
    assert.ok(['invalid','unavailable'].includes(result.status));
  }
});

test('INPUT: storage denial cannot break the workspace or report workflow', () => {
  const denied = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); }, removeItem() { throw new Error('SecurityError'); } };
  const k = layout.key(session);
  assert.equal(layout.read(denied,k).status, 'unavailable');
  assert.equal(layout.write(denied,k,record()), false);
  assert.equal(layout.remove(denied,k), false);
  assert.equal(layout.read(denied,null).status, 'disabled');
  assert.equal(layout.write(denied,null,record()), false);
  assert.equal(layout.remove(denied,null), false);
});

test('DATA: serialization is a detached whitelist, never the caller state', () => {
  const s = store(), k = layout.key(session), source = record();
  assert.equal(layout.write(s,k,source), true);
  source.portrait.main = 999;
  assert.equal(layout.read(s,k).state.portrait.main,350);
  const before = s.getItem(k);
  assert.equal(layout.write(s,k,{ ...source, report: 'private' }), false);
  assert.equal(s.getItem(k),before);
  assert.deepEqual(Object.keys(JSON.parse(before)).sort(),['landscape','mode','portrait','version']);
});
