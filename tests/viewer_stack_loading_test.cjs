'use strict';
// Resize must preserve a reader's pending scroll. Execute the pinned native
// navigation/resize methods with a manually settled loader and timer queue;
// no GPU, network, sleep, source-string assertions or copied product adapter.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const native = require('./fixtures/viewer-stack-loading-source.cjs');

async function fixture(imageIds = ['frame:1', 'frame:2', 'frame:3', 'frame:4']) {
  const scheduled = new Map(), requests = [], pending = new Map(), cached = new Set([imageIds[0]]);
  let timer = 0, loading = false;
  const setTimeout = (run, delay) => { scheduled.set(++timer, { run, delay }); return timer; };
  const clearTimeout = id => scheduled.delete(id);
  const timers = delay => {
    for (const [id, task] of [...scheduled]) if (task.delay === delay) {
      scheduled.delete(id); task.run();
    }
  };
  const Events = { STACK_VIEWPORT_SCROLL: 'scroll', STACK_NEW_IMAGE: 'loaded', ELEMENT_ENABLED: 'enabled' };
  const element = new EventTarget();
  const methods = native({ window: { setTimeout }, setTimeout, clearTimeout,
    cache: { Ay: { isLoaded: id => cached.has(id) } }, enums: { Events, ViewportStatus: { PRE_RENDER: 'preRender' } },
    triggerEvent: { A(target, name, detail) { target.dispatchEvent(new CustomEvent(name, { detail })); } } });
  const indicator = methods.indicator(value => { loading = value; });
  element.addEventListener(Events.STACK_VIEWPORT_SCROLL, indicator.scroll);
  element.addEventListener(Events.STACK_NEW_IMAGE, indicator.loaded);
  const viewport = Object.assign({ id: 'left', type: 'stack', element,
    imageIds, currentImageIdIndex: 0, targetImageIdIndex: 0,
    perImageIdDefaultProperties: new Map(), shown: imageIds[0], camera: { zoom: 2 }, render() {},
    getImageIds() { return this.imageIds; },
    getCurrentImageId() { return this.imageIds[this.currentImageIdIndex]; },
    getCurrentImageIdIndex() { return this.currentImageIdIndex; },
    getTargetImageIdIndex() { return this.targetImageIdIndex; },
    _throwIfDestroyed() {},
    setViewPresentation(value) { this.camera = value; },
    _loadAndDisplayImage(imageId) {
      requests.push(imageId);
      return new Promise((resolve, reject) => pending.set(imageId, { resolve, reject })).then(() => {
        cached.add(imageId);
        if (this.getCurrentImageId() === imageId) {
          this.shown = imageId;
          element.dispatchEvent(new CustomEvent(Events.STACK_NEW_IMAGE, { detail: { imageId } }));
        }
        return imageId;
      });
    },
  }, methods.stack);
  const volume = { id: 'mpr', type: 'orthographic', camera: { zoom: 3 }, reference: { sliceIndex: 7 },
    setViewReference(value) { this.restoredReference = value; },
    setViewPresentation(value) { this.restoredCamera = value; } };
  const viewports = new Map([[viewport.id, viewport], [volume.id, volume]]);
  const service = Object.assign({ EVENTS: {}, beforeResizePositionPresentations: new Map(),
    getCornerstoneViewport: id => viewports.get(id),
    getRenderingEngine() { return this.renderingEngine; },
    renderingEngine: { getViewports: () => [...viewports.values()], resize() {}, render() {} },
    _getPositionPresentation(id) {
      const v = viewports.get(id);
      return { viewReference: v.reference || { sliceIndex: v.getCurrentImageIdIndex(), referencedImageId: v.getCurrentImageId() },
        viewPresentation: v.camera };
    },
    _setSegmentationPresentation() {}, _setLutPresentation() {},
  }, methods.service);
  const window = { top: {}, cornerstone: { Enums: { Events }, eventTarget: new EventTarget() },
    cornerstoneTools: { Enums: { MouseBindings: {} }, ToolGroupManager: { getToolGroupForViewport() {} } } };
  const context = { window, document: {}, console, setTimeout, clearTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  vm.runInNewContext(readFileSync('config/ohif.js', 'utf8'), context);
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-ux');
  await extension.preRegistration({ servicesManager: { services: { cornerstoneViewportService: service,
    viewportGridService: { EVENTS: {}, getState: () => ({ viewports }) }, toolbarService: {} } } });
  extension.onModeEnter();
  const settle = async (imageId, error) => {
    const entry = pending.get(imageId); assert.ok(entry, `requested ${imageId}`);
    pending.delete(imageId); error ? entry.reject(error) : entry.resolve();
    await new Promise(setImmediate);
  };
  let navigation = 0;
  const reference = context.kinViewerImageReference;
  const env = { services: { cornerstoneViewportService: service,
    viewportGridService: { getActiveViewportId: () => viewport.id },
    displaySetService: { getActiveDisplaySets: () => [{ StudyInstanceUID: '1.2', SeriesInstanceUID: '1.3', instances: [{ SOPInstanceUID: '1.4' }] }] } },
    ended: () => false, scope: () => '1.2', busy: () => false, generation: () => 1, valid: () => true,
    beginNavigation: () => ++navigation, navigation: () => navigation, viewport: () => viewport, reference,
    matches: (a, b) => a?.study === '1.2' && a.seriesUid === b.seriesUid && a.sopUid === b.sopUid && a.frame === b.frame,
    hydrate() {}, highlight: () => ({ highlighted: false, annotation: 'none' }) };
  return { viewport, volume, service, extension, requests, pending, cached, timers, settle, loading: () => loading,
    goTo: frame => context.kinViewerNavigateTo(env, { studyUid: '1.2', seriesUid: '1.3', sopUid: '1.4', frame }) };
}

const images = Array.from({ length: 5 }, (_, i) => `wadors:/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/${i + 1}`);
for (const resize of [false, true]) for (const delta of [-1, 1]) {
  test(`Go to Image then ${delta > 0 ? 'ArrowDown/wheel forward' : 'ArrowUp/wheel backward'} starts at the shown frame${resize ? ' after resize' : ''}`, async () => {
    const f = await fixture(images);
    try {
      const arrived = f.goTo(3);
      await f.settle(images[2]);
      assert.equal((await arrived).ok, true);
      assert.equal(f.viewport.shown, images[2]);
      if (resize) f.service.performResize();
      f.viewport.scroll(delta); f.timers(40);
      assert.equal(f.requests.at(-1), images[2 + delta], 'the next step requests the neighbour of the displayed frame');
      await f.settle(images[2 + delta]); f.timers(50);
      assert.equal(f.viewport.shown, images[2 + delta]);
      assert.equal(f.loading(), false);
    } finally { f.extension.onModeExit(); }
  });
}

test('Go to Image supersedes an older deferred scroll without a late rewind', async () => {
  const f = await fixture(images);
  try {
    f.viewport.scroll(1);
    const arrived = f.goTo(4);
    await f.settle(images[3]);
    assert.equal((await arrived).ok, true);
    f.timers(40); f.timers(50);
    assert.deepEqual(f.requests, [images[3]], 'the old deferred frame must not be requested after arrival');
    assert.equal(f.viewport.shown, images[3]);
    assert.equal(f.loading(), false);
    f.viewport.scroll(1); f.timers(40);
    await f.settle(images[4]);
    assert.equal(f.viewport.shown, images[4]);
  } finally { f.extension.onModeExit(); }
});

test('resize between ArrowDown and its deferred load preserves the next scroll and clears Loading', async () => {
  const f = await fixture();
  f.viewport.scroll(1); // The stock ArrowDown command calls this with native debounce.
  assert.deepEqual(f.requests, []);
  f.service.performResize(); // Restore the still-displayed frame 1 before frame 2 starts.
  f.timers(40);
  assert.deepEqual(f.requests, ['frame:2']);
  await f.settle('frame:2');
  assert.equal(f.viewport.shown, 'frame:2');
  f.viewport.scroll(1);
  f.timers(40);
  assert.deepEqual(f.requests, ['frame:2', 'frame:3'], 'the second ArrowDown must request frame 3');
  f.timers(50);
  assert.equal(f.loading(), true);
  await f.settle('frame:3');
  assert.equal(f.viewport.shown, 'frame:3');
  assert.equal(f.loading(), false);
  f.extension.onModeExit();
});

test('resize while frame 2 loads cannot cancel a queued frame 3; late frame 2 cannot replace it', async () => {
  const f = await fixture();
  f.viewport.scroll(1); f.timers(40);
  f.viewport.scroll(1); // Frame 2 remains in flight, frame 3 has only a debounce task.
  f.service.performResize();
  f.timers(40);
  assert.deepEqual(f.requests, ['frame:2', 'frame:3']);
  await f.settle('frame:3');
  await f.settle('frame:2');
  f.timers(50);
  assert.equal(f.viewport.shown, 'frame:3');
  assert.equal(f.loading(), false);
  f.extension.onModeExit();
});

test('resize retains stack camera and MPR reference; explicit stack navigation still applies', async () => {
  const f = await fixture();
  const camera = f.viewport.camera;
  f.viewport.scroll(1);
  f.service.performResize();
  assert.equal(f.viewport.camera, camera);
  assert.equal(f.volume.restoredReference, f.volume.reference);
  assert.equal(f.volume.restoredCamera, f.volume.camera);
  f.service.setPresentations('left', { positionPresentation: {
    viewReference: { sliceIndex: 3, referencedImageId: 'frame:4' }, viewPresentation: { zoom: 4 } } });
  f.timers(40);
  assert.deepEqual(f.requests, ['frame:4'], 'explicit navigation supersedes the pending scroll');
  await f.settle('frame:4');
  assert.equal(f.viewport.shown, 'frame:4');
  assert.equal(f.viewport.camera.zoom, 4);
  f.extension.onModeExit();
});

test('mode exit/reentry restores and reinstalls resize handling without stacking wrappers', async () => {
  const f = await fixture();
  f.extension.onModeExit();
  const original = f.service.performResize;
  f.extension.onModeEnter(); f.extension.onModeEnter();
  f.viewport.scroll(1); f.service.performResize(); f.timers(40);
  await f.settle('frame:2');
  f.viewport.scroll(1); f.timers(40);
  assert.deepEqual(f.requests, ['frame:2', 'frame:3']);
  await f.settle('frame:3');
  f.extension.onModeExit();
  assert.equal(f.service.performResize, original);
});

// The pinned RenderingEngine's resize assigns every canvas size (clearing it) and its render() only flags the
// viewports and requests one animation frame. A cell beside a dropped series must not stay cleared after the
// resize task while it still reports a rendered image.
function frameEngine(viewports, { failDraws = 0 } = {}) {
  const frames = [], needs = new Set();
  const engine = {
    canvases: new Map(viewports.map(v => [v.id, 'image'])),
    _animationFrameSet: false, _animationFrameHandle: null, hasBeenDestroyed: false,
    getViewports: () => viewports,
    resize() { for (const id of engine.canvases.keys()) engine.canvases.set(id, 'cleared'); },
    render() {
      viewports.forEach(v => needs.add(v.id));
      if (!engine._animationFrameSet) { frames.push(engine._renderFlaggedViewports); engine._animationFrameHandle = frames.length; engine._animationFrameSet = true; }
    },
    _renderFlaggedViewports() {
      if (failDraws > 0) { failDraws--; throw new Error('context lost'); }
      for (const id of needs) engine.canvases.set(id, 'image');
      needs.clear(); engine._animationFrameSet = false; engine._animationFrameHandle = null;
    },
    nextFrame() { frames.shift()?.(); },
    pendingFrames: () => frames.length,
  };
  return engine;
}

test('resize draws its queued frame before returning, so no rendered cell is left cleared', async () => {
  const f = await fixture();
  try {
    const engine = f.service.renderingEngine = frameEngine([...f.service.renderingEngine.getViewports()]);
    f.service.performResize();
    assert.deepEqual([...engine.canvases.values()], ['image', 'image']);
    assert.equal(engine._animationFrameSet, false);
    engine.nextFrame(); // The frame the engine requested still runs and finds nothing left to draw.
    assert.deepEqual([...engine.canvases.values()], ['image', 'image']);
  } finally { f.extension.onModeExit(); }
});

test('a resize redraw that fails is retried by the frame the engine already requested', async () => {
  const f = await fixture();
  try {
    const engine = f.service.renderingEngine = frameEngine([...f.service.renderingEngine.getViewports()], { failDraws: 1 });
    const warn = console.warn; console.warn = () => {};
    try { f.service.performResize(); } finally { console.warn = warn; }
    assert.deepEqual([...engine.canvases.values()], ['cleared', 'cleared']);
    assert.equal(engine.pendingFrames(), 1);
    engine.nextFrame();
    assert.deepEqual([...engine.canvases.values()], ['image', 'image']);
  } finally { f.extension.onModeExit(); }
});

test('a failed resize does not leave explicit stack navigation in resize mode', async () => {
  const f = await fixture();
  f.extension.onModeExit();
  f.service.performResize = () => { throw new Error('renderer removed'); };
  f.extension.onModeEnter();
  assert.throws(() => f.service.performResize(), /renderer removed/);
  f.service.setPresentations('left', { positionPresentation: {
    viewReference: { sliceIndex: 2, referencedImageId: 'frame:3' } } });
  f.timers(40);
  assert.deepEqual(f.requests, ['frame:3']);
  await f.settle('frame:3');
  assert.equal(f.viewport.shown, 'frame:3');
  f.extension.onModeExit();
});
