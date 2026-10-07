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
  return { window, Viewport, StackViewport, VolumeViewport, warnings,
    extension: window.config.extensions.find(extension => extension.id === 'kin.stack-precision') };
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

// S7-U5 fix round H2: a flip (and the rotation with it) stays while the person scrolls the same stack; a new stack and a
// reset are left to the pinned viewer. The frame update is the pinned upstream text (fixtures/viewer-frame-source.cjs);
// its collaborators are a plain camera with the pinned viewer's GPU rotation (getRotationGPU / setRotationGPU without the
// pan bookkeeping; vtk's roll turns viewUp about the direction of projection) and a reset that clears both flips.
const frame = require('./fixtures/viewer-frame-source.cjs');
const vec = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  negate: a => [-a[0], -a[1], -a[2]],
  unit: a => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; },
};
function roll(camera, degrees) {
  const k = vec.unit([0, 1, 2].map(i => camera.focalPoint[i] - camera.position[i])), t = degrees * Math.PI / 180;
  const v = camera.viewUp, kv = vec.cross(k, v), d = vec.dot(k, v);
  return [0, 1, 2].map(i => v[i] * Math.cos(t) + kv[i] * Math.sin(t) + k[i] * d * (1 - Math.cos(t)));
}
async function frameWorld() {
  const c = context();
  Object.defineProperty(c.StackViewport.prototype, '_updateActorToDisplayImageId',
    { value: frame._updateActorToDisplayImageId, configurable: true, writable: true });
  assert.equal(await c.extension.preRegistration(), 'ready');
  const initial = { viewPlaneNormal: [0, 0, 1], viewUp: [0, -1, 0], focalPoint: [10000.5, -20000.25, 30000.75],
    position: [10000.5, -20000.25, 30100.75] };
  const viewport = () => {
    const v = new c.StackViewport();
    let camera = structuredClone(initial);
    Object.assign(v, {
      initialViewUp: initial.viewUp, stackInvalidated: false,
      getDefaultImageData: () => ({ getDimensions: () => [256, 256, 1],
        indexToWorld: (_idx, out) => { out.set(initial.focalPoint); return out; } }),
      getCamera: () => ({ ...camera, flipHorizontal: !!v.flipHorizontal, flipVertical: !!v.flipVertical }),
      setCamera: change => { camera = { ...camera, ...change }; },
      render() {},
      resetCameraNoEvent() { camera = structuredClone(initial); v.flipHorizontal = false; v.flipVertical = false; },
      getRotation() {
        const { viewUp, viewPlaneNormal, flipVertical } = v.getCamera();
        const start = flipVertical ? vec.negate(v.initialViewUp) : v.initialViewUp;
        const angle = Math.acos(Math.max(-1, Math.min(1, vec.dot(start, viewUp)))) * 180 / Math.PI;
        return vec.dot(vec.cross(start, viewUp), viewPlaneNormal) >= 0 ? angle : (360 - angle) % 360;
      },
      setRotation(rotation) {
        camera.viewUp = v.flipVertical ? vec.negate(v.initialViewUp) : v.initialViewUp;
        camera.viewUp = roll(camera, -rotation);
      },
      getViewPresentation: () => ({ rotation: v.getRotation() }),
      setViewPresentation: p => { if (p.rotation >= 0) v.setRotation(p.rotation); },
      _checkVTKImageDataMatchesCornerstoneImage: () => true,
      _updateVTKImageDataFromCornerstoneImage() {}, _setPropertiesFromCache() {},
      getImageDataMetadata: () => ({ origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], dimensions: [256, 256, 1],
        spacing: [1, 1, 1], numberOfComponents: 1, imagePixelModule: { photometricInterpretation: 'MONOCHROME2' } }),
      _createVTKImageData() {}, createActorMapper: () => ({}), getActors: () => [], setActors() {},
      _getCameraOrientation: () => ({ viewPlaneNormal: initial.viewPlaneNormal, viewUp: initial.viewUp }),
      setCameraNoEvent: change => { camera = { ...camera, ...change }; },
      triggerCameraEvent() {}, _getInitialVOIRange: () => ({ lower: 0, upper: 1 }), setVOI() {}, setInvertColor() {},
    });
    // What the person does: a 90 degree turn ('r'), then the flips; then the viewer shows frames.
    v.person = flips => { v.setRotation((v.getRotation() + 90) % 360); v.flip(flips); };
    v.state = () => ({ viewUp: Array.from(camera.viewUp, n => Math.round(n * 1e9) / 1e9 + 0),
      viewPlaneNormal: Array.from(camera.viewPlaneNormal, n => Math.round(n * 1e9) / 1e9 + 0),
      flipHorizontal: !!v.flipHorizontal, flipVertical: !!v.flipVertical, rotation: Math.round(v.getRotation() * 1e6) / 1e6 });
    v.frame = () => v._updateActorToDisplayImageId({ voxelManager: { getScalarData: () => new Float32Array(1) } });
    v.stockFrame = () => frame._updateActorToDisplayImageId.call(v, { voxelManager: { getScalarData: () => new Float32Array(1) } });
    return v;
  };
  return { c, viewport };
}

test('S7-U5 a flip and the turn with it stay while the same stack is scrolled', async () => {
  const world = await frameWorld();
  assert.equal(world.c.window.kinViewerFlipKeeper.state, 'ready');
  for (const flips of [{ flipHorizontal: true }, { flipVertical: true }, { flipHorizontal: true, flipVertical: true }]) {
    const v = world.viewport();
    v.person(flips);
    const shown = v.state();
    v.frame(); assert.deepEqual(v.state(), shown, 'next frame: ' + JSON.stringify(flips));
    v.frame(); assert.deepEqual(v.state(), shown, 'the frame after: ' + JSON.stringify(flips));
  }
});

test('S7-U5 the pinned frame update alone drops the flip and turns the image (what the keeper corrects)', async () => {
  const v = (await frameWorld()).viewport();
  v.person({ flipHorizontal: true });
  const shown = v.state();
  v.stockFrame();
  assert.equal(v.state().flipHorizontal, false);
  assert.notDeepEqual(v.state().viewUp, shown.viewUp, 'without the flip the 90 degree turn comes back as 270');
});

test('S7-U5 a new stack and a reset are left to the pinned viewer: nothing is given back', async () => {
  const world = await frameWorld();
  const pair = () => { const a = world.viewport(), b = world.viewport(); a.person({ flipHorizontal: true }); b.person({ flipHorizontal: true }); return [a, b]; };
  // setStack clears both flips and invalidates the stack before its first frame (camera vectors untouched).
  let [kept, stock] = pair();
  for (const v of [kept, stock]) Object.assign(v, { stackInvalidated: true, flipHorizontal: false, flipVertical: false });
  kept.frame(); stock.stockFrame();
  assert.deepEqual(kept.state(), stock.state());
  assert.equal(kept.state().flipHorizontal, false);
  // An explicit reset (Space/Reset, Reset Display) clears the flips outside the frame update; the next frame keeps that.
  [kept, stock] = pair();
  for (const v of [kept, stock]) v.resetCameraNoEvent();
  kept.frame(); stock.stockFrame();
  assert.deepEqual(kept.state(), stock.state());
  assert.equal(kept.state().flipHorizontal, false);
});
