const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const upstream = require('./fixtures/viewer-precision-source.cjs');
const source = readFileSync(require.resolve('../config/ohif.js'), 'utf8');

function context(crypto = webcrypto) {
  class Viewport {}
  Object.defineProperties(Viewport.prototype, Object.fromEntries(Object.entries(upstream).map(([name, value]) =>
    [name, { value, configurable: true, writable: true }])));
  class StackViewport extends Viewport {}
  class VolumeViewport extends Viewport {}
  const warnings = [];
  const window = { cornerstone: { Viewport, StackViewport, VolumeViewport } };
  vm.runInNewContext(source, { window, document: {}, crypto, TextEncoder,
    console: { warn: x => warnings.push(x) } });
  return { window, Viewport, StackViewport, VolumeViewport, warnings, extension: window.config.extensions[0] };
}
const plain = x => Array.from(x);
const names = ['flip', '_getFocalPointForResetCamera'];
function untouched(c) {
  for (const name of names) {
    assert.equal(Object.hasOwn(c.StackViewport.prototype, name), false);
    assert.equal(c.Viewport.prototype[name], upstream[name]);
  }
  assert.equal(c.window.kinViewerPrecision.state, 'unsupported');
}

test('PIN/SCOPE: pinned methods install once on stack, retaining base and volume', async () => {
  const c = context();
  const first = c.extension.preRegistration();
  assert.equal(first, c.extension.preRegistration());
  assert.equal(await first, 'ready');
  for (const name of names) {
    assert.equal(Object.hasOwn(c.StackViewport.prototype, name), true);
    assert.equal(c.Viewport.prototype[name], upstream[name]);
    assert.equal(c.VolumeViewport.prototype[name], upstream[name]);
  }
  const flip = c.StackViewport.prototype.flip;
  await c.extension.preRegistration();
  assert.equal(c.StackViewport.prototype.flip, flip);
  assert.equal(Object.isFrozen(c.window.kinViewerPrecision), true);
});

test('PIN: changed source, unsupported crypto and non-extensible target never partially install', async () => {
  const changed = context();
  changed.Viewport.prototype.flip = function flip() {};
  const original = changed.Viewport.prototype.flip;
  await changed.extension.preRegistration();
  assert.equal(changed.Viewport.prototype.flip, original);
  assert.equal(changed.window.kinViewerPrecision.state, 'unsupported');
  assert.ok(names.every(n => !Object.hasOwn(changed.StackViewport.prototype, n)));
  for (const c of [context({}), context()]) {
    if (c.window.cornerstone && c.extension) Object.preventExtensions(c.StackViewport.prototype);
    await c.extension.preRegistration();
    untouched(c);
  }
});

test('PIN: source/ownership changes during async hashing are retained, not overwritten', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const c = context({ subtle: { async digest(...args) { await gate; return webcrypto.subtle.digest(...args); } } });
  const pending = c.extension.preRegistration();
  const other = function anotherExtension() {};
  c.StackViewport.prototype.flip = other;
  release();
  await pending;
  assert.equal(c.window.kinViewerPrecision.state, 'unsupported');
  assert.equal(c.StackViewport.prototype.flip, other);
  assert.equal(Object.hasOwn(c.StackViewport.prototype, names[1]), false);
  assert.equal(c.Viewport.prototype.flip, upstream.flip);
});

test('SCOPE: all four reset flags and NaN fallback retain the original contract', async () => {
  const c = context(); await c.extension.preRegistration();
  const v = new c.StackViewport();
  const centered = [10001.125, -20001.25, 30002.5];
  const previous = { focalPoint: [10003.25, -20004.5, 30007.75], viewPlaneNormal: [0, 0, 1] };
  const fn = (...args) => v._getFocalPointForResetCamera(...args);
  assert.equal(fn(centered, previous, { resetPan: true, resetToCenter: true }), centered);
  assert.deepEqual(plain(fn(centered, previous, { resetPan: true, resetToCenter: false })), [10001.125, -20001.25, 30007.75]);
  for (const resetToCenter of [true, false]) {
    assert.equal(fn(centered, previous, { resetPan: false, resetToCenter }), previous.focalPoint);
    assert.equal(fn(centered, { ...previous, focalPoint: [NaN, 0, 0] }, { resetPan: false, resetToCenter }), centered);
  }
  v.useCPURendering = true;
  assert.equal(fn(centered, previous, { resetPan: true, resetToCenter: true }), centered);
  let calls = 0;
  v.getDefaultImageData = () => { calls++; return null; };
  v.flip({ flipHorizontal: true });
  assert.equal(calls, 1);
});

test('PRECISION: mirror twice returns a large-origin camera without changing source vectors', async () => {
  const c = context(); await c.extension.preRegistration();
  for (const direction of ['flipHorizontal', 'flipVertical']) {
    const v = new c.StackViewport();
    const initial = { viewPlaneNormal: [0, 0, 1], viewUp: [0, -1, 0],
      focalPoint: [10000.123456789, -20000.234567891, 30000.345678912],
      position: [10000.123456789, -20000.234567891, 30100.345678912] };
    const snapshot = JSON.stringify(initial);
    let camera = structuredClone(initial);
    v.getDefaultImageData = () => ({ getDimensions: () => [256, 256, 1],
      indexToWorld: (_idx, out) => { out.set([10000, -20000, 30000]); return out; } });
    v.getCamera = () => camera;
    v.setCamera = change => { camera = { ...camera, ...change }; };
    let renders = 0; v.render = () => renders++;
    v.flip({ [direction]: true });
    assert.equal(v[direction], true);
    assert.equal(camera.focalPoint[2], initial.focalPoint[2]);
    v.flip({ [direction]: true });
    assert.equal(v[direction], false);
    assert.equal(renders, 2);
    for (const key of ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal']) {
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(camera[key][i] - initial[key][i]) < 1e-10, key);
    }
    assert.equal(JSON.stringify(initial), snapshot);
  }
});
