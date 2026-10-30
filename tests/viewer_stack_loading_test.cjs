'use strict';
// Resize must preserve a reader's pending scroll. Execute the pinned native
// navigation/resize methods with a manually settled loader and timer queue;
// no GPU, network, sleep, source-string assertions or copied product adapter.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const native = require('./fixtures/viewer-stack-loading-source.cjs');

async function fixture() {
  const scheduled = new Map(), requests = [], pending = new Map(), cached = new Set(['frame:1']);
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
    imageIds: ['frame:1', 'frame:2', 'frame:3', 'frame:4'], currentImageIdIndex: 0, targetImageIdIndex: 0,
    perImageIdDefaultProperties: new Map(), shown: 'frame:1', camera: { zoom: 2 },
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
  vm.runInNewContext(readFileSync('config/ohif.js', 'utf8'), { window, document: {}, console,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-ux');
  await extension.preRegistration({ servicesManager: { services: { cornerstoneViewportService: service,
    viewportGridService: { EVENTS: {}, getState: () => ({ viewports }) }, toolbarService: {} } } });
  extension.onModeEnter();
  const settle = async (imageId, error) => {
    const entry = pending.get(imageId); assert.ok(entry, `requested ${imageId}`);
    pending.delete(imageId); error ? entry.reject(error) : entry.resolve();
    await new Promise(setImmediate);
  };
  return { viewport, volume, service, extension, requests, pending, cached, timers, settle, loading: () => loading };
}

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
