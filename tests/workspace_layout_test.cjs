const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../worklist-v0/hpacs-lite/workspace-layout.js');
const reading = require('../worklist-v0/hpacs-lite/reading-panel-layout.js');
// REQ-WS1 -> RISK-WS1 -> TEST-WS1 (M-01..M-05): persisted display choices, never drawer visibility.
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

test('READING: v2 roundtrip isolates owners and loading legacy layouts preserves integrated choices', () => {
  const s = store(), k = layout.key(session), base = record();
  const panels = { ...reading.defaults(), reportWidth: 570, relatedHidden: true };
  const v2 = layout.withReading(base, panels);
  assert.equal(v2.version, 2);
  assert.equal(layout.write(s, k, v2), true);
  panels.reportWidth = 600;
  assert.equal(layout.read(s, k).state.reading.reportWidth, 570);
  assert.equal(layout.read(s, layout.key({ ...session, sub: 'b' })).status, 'empty');
  const legacy = { ...record(), mode: 'landscape' };
  const merged = layout.mergeLoaded(v2, legacy);
  assert.equal(merged.mode, 'landscape');
  assert.deepEqual(merged.reading, v2.reading);
  assert.deepEqual(layout.mergeLoaded(base, legacy), legacy);
  assert.deepEqual(layout.mergeLoaded(v2, layout.withReading(base, reading.defaults())).reading, reading.defaults());
  for (const invalid of [{ ...v2, reading: null }, { ...v2, reading: { ...v2.reading, patient: 'not-allowed' } },
    { ...v2, reading: { ...v2.reading, relatedHidden: 1 } }, { ...v2, version: 1 }]) {
    assert.equal(layout.normalize(invalid), null);
    assert.equal(layout.write(s, k, invalid), false);
    assert.deepEqual(layout.read(s, k).state, v2);
  }
});

test('M-01: v3 왕복·분리 복사·reading 갱신은 workspace와 계정 경계 보존', () => {
  const s = store(), k = layout.key(session), source = layout.toVersion3(record());
  source.workspace = { version: 1, rail: 232, worklist: 304, related: 184, prior: 200,
    railCollapsed: true, studyPanelTab: 'templates' };
  source.reading.reportWidth = 570;
  const expected = structuredClone(source);
  assert.equal(layout.write(s, k, source), true); source.workspace.rail = 100;
  assert.deepEqual(layout.read(s, k), { state: expected, status: 'restored' });
  assert.equal(layout.read(s, layout.key({ ...session, sub: 'other' })).status, 'empty');
  const changed = layout.withReading(expected, { ...reading.defaults(), relatedHidden: true });
  assert.equal(changed.version, 3); assert.deepEqual(changed.workspace, expected.workspace);
  assert.equal(changed.reading.relatedHidden, true);
  assert.equal(Object.hasOwn(changed.workspace, 'open'), false);
  assert.deepEqual(layout.toVersion3(changed), changed);
  for (const tab of ['images', 'info', 'templates']) {
    const value = { ...expected, workspace: { ...expected.workspace, studyPanelTab: tab } };
    assert.deepEqual(layout.normalize(value), value);
  }
});

test('M-02: 유효 v1/v2 생성 사례의 모든 기존 멤버 보존, geometry 추정 없음', () => {
  const names = ['main', 'top', 'related', 'prior'], sizes = [1, 1.4, 700.6, 16384];
  const current = layout.toVersion3(record()); current.reading.reportWidth = 987;
  current.reading.relatedHidden = true; current.workspace.studyPanelTab = 'info';
  let cases = 0;
  for (const version of [1, 2]) for (const mode of ['auto', 'portrait', 'landscape']) {
    for (let p = 0; p < 16; p++) for (let l = 0; l < 16; l++) {
      const axis = mask => Object.fromEntries(names.flatMap((name, i) => mask & (1 << i) ? [[name, sizes[(mask + i) % sizes.length]]] : []));
      const source = { version, mode, portrait: axis(p), landscape: axis(l) };
      if (version === 2) source.reading = { version: 1, reportWidth: p ? p * 900 : null,
        imageHeight: l ? l * 900 : null, relatedHeight: 16384, relatedListHeight: 1, relatedHidden: !!(p % 2) };
      const valid = layout.normalize(source), before = structuredClone(valid), result = layout.toVersion3(valid);
      assert.ok(valid); assert.equal(result.version, 3);
      for (const key of Object.keys(valid).filter(k => k !== 'version')) assert.deepEqual(result[key], valid[key]);
      assert.deepEqual(result.workspace, { version: 1, rail: null, worklist: null, related: null, prior: null,
        railCollapsed: false, studyPanelTab: 'images' });
      const loaded = layout.toVersion3(valid, current);
      assert.deepEqual(loaded.reading, version === 2 ? valid.reading : current.reading);
      assert.deepEqual(loaded.workspace, current.workspace); assert.deepEqual(valid, before);
      result.portrait.main = 444; result.reading.reportWidth = 222; loaded.workspace.studyPanelTab = 'templates';
      assert.deepEqual(valid, before); assert.equal(current.workspace.studyPanelTab, 'info'); cases++;
    }
  }
  assert.equal(cases, 1536);
});

test('M-02/04: v3 계정 Load와 구버전 덮어쓰기 뒤 변환 규칙', () => {
  const current = layout.toVersion3(record()); current.workspace.rail = 248;
  current.workspace.studyPanelTab = 'templates'; current.reading.reportWidth = 999;
  const legacy = record(), v2 = layout.withReading(legacy, reading.defaults());
  const loaded = layout.mergeLoaded(current, legacy);
  assert.equal(loaded.version, 3); assert.equal(loaded.mode, legacy.mode);
  assert.deepEqual(loaded.portrait, legacy.portrait); assert.deepEqual(loaded.landscape, legacy.landscape);
  assert.deepEqual(loaded.reading, current.reading); assert.deepEqual(loaded.workspace, current.workspace);
  assert.deepEqual(layout.mergeLoaded(current, v2).reading, v2.reading);
  const incoming = layout.toVersion3(v2); incoming.workspace.railCollapsed = true;
  assert.deepEqual(layout.mergeLoaded(current, incoming), incoming);
  assert.deepEqual(layout.mergeLoaded(legacy, incoming), incoming);
  const s = store(), k = layout.key(session); layout.write(s, k, current);
  // An old tab cannot decode v3; its next save can replace the local value with v2 defaults.
  s.setItem(k, JSON.stringify(v2));
  const converted = layout.toVersion3(layout.read(s, k).state);
  assert.deepEqual(converted.reading, reading.defaults());
  assert.deepEqual(converted.workspace, layout.workspaceDefaults());
});

test('M-03: v3 whitelist·필수 멤버·타입·수치·변환 오류는 저장 전에 거절', () => {
  const valid = layout.toVersion3(record()), s = store(), k = layout.key(session);
  layout.write(s, k, valid); const saved = s.getItem(k);
  const invalid = [null, [], {}, ...[0, 4, '3', true].map(version => ({ ...valid, version })),
    { ...valid, workspace: null }, { ...valid, workspace: [] }, { ...valid, reading: null },
    { ...valid, workspace: { ...valid.workspace, open: true } }, { ...valid, open: true },
    { ...valid, workspace: { ...valid.workspace, studyPanelTab: 'Info' } },
    { ...valid, workspace: { ...valid.workspace, railCollapsed: 1 } },
    { ...valid, workspace: { ...valid.workspace, version: 2 } },
    JSON.parse(JSON.stringify(valid).replace('"rail":null', '"__proto__":{},"rail":null'))];
  for (const key of Object.keys(valid)) { const v = structuredClone(valid); delete v[key]; invalid.push(v); }
  for (const key of Object.keys(valid.workspace)) { const v = structuredClone(valid); delete v.workspace[key]; invalid.push(v); }
  for (const key of ['rail', 'worklist', 'related', 'prior']) {
    for (const size of [0, -1, 16385, 1.1, NaN, Infinity, '100', true, undefined, {}, []]) {
      invalid.push({ ...valid, workspace: { ...valid.workspace, [key]: size } });
    }
    for (const size of [null, 1, 16384]) assert.equal(layout.normalize({ ...valid,
      workspace: { ...valid.workspace, [key]: size } }).workspace[key], size);
  }
  for (const value of invalid) {
    assert.equal(layout.normalize(value), null); assert.equal(layout.toVersion3(value), null);
    assert.equal(layout.mergeLoaded(valid, value), null); assert.equal(layout.write(s, k, value), false);
    assert.equal(s.getItem(k), saved);
  }
});

test('M-03/05: 2048자 cap 경계, 최대 v3 크기, 손상 기록 및 기존 owner key', () => {
  const axis = { main: 16384, top: 16384, related: 16384, prior: 16384 };
  const value = { version: 3, mode: 'landscape', portrait: axis, landscape: axis,
    reading: { version: 1, reportWidth: 16384, imageHeight: 16384, relatedHeight: 16384,
      relatedListHeight: 16384, relatedHidden: false }, workspace: { version: 1, rail: 16384,
      worklist: 16384, related: 16384, prior: 16384, railCollapsed: false, studyPanelTab: 'templates' } };
  const s = store(), k = layout.key(session), raw = JSON.stringify(value);
  assert.equal(layout.PREFIX, 'kin-workspace:v1:'); assert.equal(k, 'kin-workspace:v1:["hospital-a","account-a"]');
  assert.ok(raw.length <= 2048); assert.equal(layout.write(s, k, value), true);
  assert.deepEqual(layout.read(s, k).state, value);
  s.setItem(k, raw.padEnd(2048, ' ')); assert.equal(layout.read(s, k).status, 'restored');
  s.setItem(k, raw.padEnd(2049, ' ')); assert.equal(layout.read(s, k).status, 'invalid');
  assert.deepEqual(layout.read(s, k).state, layout.defaults());
  for (const bad of ['{', 'null', '[]', JSON.stringify({ ...value, version: 4 })]) {
    s.setItem(k, bad); const result = layout.read(s, k);
    assert.ok(['invalid', 'unavailable'].includes(result.status)); assert.deepEqual(result.state, layout.defaults());
  }
});
