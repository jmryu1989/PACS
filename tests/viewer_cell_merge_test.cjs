'use strict';
/* Pure model and controller coverage for session-only cell merge: exact layoutOptions,
   slot assignment, refusal boundaries, verified restore and unverifiable quarantine. */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = path.join(__dirname, '../worklist-v0/hpacs-lite/viewer-cell-merge.js');
let source = fs.readFileSync(sourcePath, 'utf8');
// Isolated copies of the module with one guard removed, used to prove the guard is the
// thing that keeps a boundary. The shipped file is never modified.
const mutation = process.env.KIN_CELL_MERGE_MUTATION;
if (mutation === 'skip-kind-guard') source = source.replace("if (!['stack', 'empty'].includes(cell.kind))", 'if (false)');
if (mutation === 'skip-uniform-guard') source = source.replace('!near(cell.width, 1 / cols) || !near(cell.height, 1 / rows))', 'false)');
if (mutation === 'trust-dispatch') source = source.replace('const achieved = await settle(() => geometryIs(expected), deadline);', 'const achieved = true;');
if (mutation === 'claim-restore') source = source.replace('return restored(target);\n    }', 'return true;\n    }');
const moduleBox = { exports: {} };
new Function('module', 'exports', source)(moduleBox, moduleBox.exports);
const CellMerge = moduleBox.exports;

const CAMERA = { focalPoint: [0, 0, 0], position: [0, 0, 10], viewUp: [0, 1, 0], viewPlaneNormal: [0, 0, 1], parallelScale: 10, flipHorizontal: false, flipVertical: false };
const clone = value => JSON.parse(JSON.stringify(value));

function makeViewport(id, imageId, seed) {
  return {
    id, type: 'stack', current: imageId, index: 0, renders: 0,
    camera: { ...clone(CAMERA), parallelScale: seed },
    properties: { invert: false, voiRange: { lower: 0, upper: 100 } },
    getCurrentImageId() { return this.current; },
    getCurrentImageIdIndex() { return this.index; },
    getCamera() { return clone(this.camera); },
    setCamera(value) { Object.assign(this.camera, clone(value)); },
    getProperties() { return clone(this.properties); },
    setProperties(value) { Object.assign(this.properties, clone(value)); },
    setVOI(value) { this.properties.voiRange = clone(value); },
    setImageIdIndex(value) { this.index = value; this.current = 'wadors:' + id + ':' + value; return Promise.resolve(); },
    render() { this.renders++; },
  };
}

// A grid whose setLayout follows the pinned SET_LAYOUT reducer: per-position rectangles
// override the uniform default and positions beyond layoutOptions.length are skipped.
function fixture({ rows = 2, cols = 2, restoresPresentation = false, breakLayout = false, empty = [] } = {}) {
  const names = ['A', 'B', 'C', 'D'].slice(0, rows * cols);
  const viewports = new Map(), sets = new Map(), cells = new Map();
  names.forEach((name, index) => {
    const setId = 'ds-' + name, blank = empty.includes(name);
    sets.set(setId, { displaySetInstanceUID: setId, Modality: 'CT' });
    viewports.set(name, makeViewport(name, blank ? null : 'wadors:' + name + ':0', 10 + index));
    cells.set(name, { viewportId: name, x: (index % cols) / cols, y: Math.floor(index / cols) / rows, width: 1 / cols, height: 1 / rows,
      displaySetInstanceUIDs: blank ? [] : [setId], viewportOptions: { viewportId: name, id: 'slot-' + name, toolGroupId: 'default' } });
  });
  const state = { layout: { layoutType: 'grid', numRows: rows, numCols: cols }, activeViewportId: 'A', viewports: cells };
  const calls = [];
  const grid = {
    EVENTS: { GRID: 'grid' }, getState: () => state, subscribe: () => ({ unsubscribe() { } }),
    setLayout(payload) {
      calls.push(clone({ numRows: payload.numRows, numCols: payload.numCols, layoutOptions: payload.layoutOptions || null, activeViewportId: payload.activeViewportId }));
      if (breakLayout) return Promise.resolve();
      const next = new Map(), options = payload.layoutOptions;
      for (let row = 0; row < payload.numRows; row++) for (let col = 0; col < payload.numCols; col++) {
        const position = col + row * payload.numCols;
        if (options?.length && position >= options.length) continue;
        const option = options?.[position];
        const width = option ? option.width : 1 / payload.numCols, height = option ? option.height : 1 / payload.numRows;
        const x = option ? option.x : col / payload.numCols, y = option ? option.y : row / payload.numRows;
        const request = payload.findOrCreateViewport(position);
        if (!request) continue;
        const id = request.viewportOptions.viewportId;
        next.set(id, { viewportId: id, x, y, width, height, displaySetInstanceUIDs: [...request.displaySetInstanceUIDs], viewportOptions: request.viewportOptions });
      }
      for (const id of [...viewports.keys()]) if (!next.has(id)) viewports.delete(id);
      for (const [id, cell] of next) if (!viewports.has(id)) {
        // A rebuilt cell starts cold unless the native presentation cache returned it.
        const viewport = makeViewport(id, cell.displaySetInstanceUIDs.length ? 'wadors:' + id + ':0' : null, 1);
        if (restoresPresentation) { const saved = state.saved?.get(id); if (saved) { viewport.camera = clone(saved.camera); viewport.properties = clone(saved.properties); viewport.current = saved.current; viewport.index = saved.index; } }
        viewports.set(id, viewport);
        void cell;
      }
      state.viewports = next; state.layout = { layoutType: 'grid', numRows: payload.numRows, numCols: payload.numCols };
      state.activeViewportId = payload.activeViewportId;
      return Promise.resolve();
    },
  };
  state.saved = new Map([...viewports].map(([id, viewport]) => [id, { camera: clone(viewport.camera), properties: clone(viewport.properties), current: viewport.current, index: viewport.index }]));
  const services = { viewportGridService: grid, cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) || null },
    displaySetService: { getDisplaySetByUID: id => sets.get(id) }, cineService: { getState: () => ({ cines: {} }) } };
  const doc = { fullscreenElement: null, querySelector: () => null, addEventListener() { }, removeEventListener() { } };
  const win = { setTimeout, clearTimeout, addEventListener() { }, removeEventListener() { } };
  const controller = CellMerge.create(services, { doc, root: win });
  return { controller, state, cells, viewports, calls, services, win, doc };
}

const layoutOf = state => [...state.viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x)
  .map(view => [view.viewportId, view.x, view.y, view.width, view.height]);

const planCells = (rows, cols, kinds) => kinds.map((kind, index) => ({ viewportId: String.fromCharCode(65 + index), kind,
  x: (index % cols) / cols, y: Math.floor(index / cols) / rows, width: 1 / cols, height: 1 / rows, sets: ['ds-' + index] }));

test('each supported operation asks for exactly one documented rectangle set', () => {
  const cells = planCells(2, 2, ['stack', 'stack', 'stack', 'stack']);
  const maximize = CellMerge.plan({ rows: 2, cols: 2, cells, anchorId: 'D', op: 'maximize' });
  assert.deepEqual(maximize.layoutOptions, [{ x: 0, y: 0, width: 1, height: 1 }]);
  assert.deepEqual(maximize.slots.map(cell => cell.viewportId), ['D']);
  assert.deepEqual(maximize.displaced, ['A', 'B', 'C']);

  const left = CellMerge.plan({ rows: 2, cols: 2, cells, anchorId: 'C', op: 'merge-column' });
  assert.deepEqual(left.layoutOptions, [{ x: 0, y: 0, width: .5, height: 1 }, { x: .5, y: 0, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 }]);
  assert.deepEqual(left.slots.map(cell => cell.viewportId), ['C', 'B', 'D']);
  assert.deepEqual(left.displaced, ['A']);

  const right = CellMerge.plan({ rows: 2, cols: 2, cells, anchorId: 'B', op: 'merge-column' });
  assert.deepEqual(right.layoutOptions, [{ x: 0, y: 0, width: .5, height: .5 }, { x: .5, y: 0, width: .5, height: 1 }, { x: 0, y: .5, width: .5, height: .5 }]);
  assert.deepEqual(right.slots.map(cell => cell.viewportId), ['A', 'B', 'C']);

  const top = CellMerge.plan({ rows: 2, cols: 2, cells, anchorId: 'A', op: 'merge-row' });
  assert.deepEqual(top.layoutOptions, [{ x: 0, y: 0, width: 1, height: .5 }, { x: 0, y: .5, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 }]);
  assert.deepEqual(top.slots.map(cell => cell.viewportId), ['A', 'C', 'D']);

  const bottom = CellMerge.plan({ rows: 2, cols: 2, cells, anchorId: 'D', op: 'merge-row' });
  assert.deepEqual(bottom.layoutOptions, [{ x: 0, y: 0, width: .5, height: .5 }, { x: .5, y: 0, width: .5, height: .5 }, { x: 0, y: .5, width: 1, height: .5 }]);
  assert.deepEqual(bottom.slots.map(cell => cell.viewportId), ['A', 'B', 'D']);
  // Every plan covers the whole area exactly once, so no cell is hidden behind another.
  for (const result of [maximize, left, right, top, bottom])
    assert.equal(result.layoutOptions.reduce((sum, box) => sum + box.width * box.height, 0), 1);
});

test('unsupported bases, merged screens, wrong sources and unknown cells refuse whole', () => {
  const four = planCells(2, 2, ['stack', 'stack', 'stack', 'stack']);
  assert.match(CellMerge.plan({ rows: 3, cols: 3, cells: planCells(3, 3, Array(9).fill('stack')), anchorId: 'A', op: 'maximize' }).reason, /1·2·4화면/);
  assert.match(CellMerge.plan({ rows: 2, cols: 2, cells: four, anchorId: 'Z', op: 'maximize' }).reason, /선택/);
  assert.match(CellMerge.plan({ rows: 2, cols: 2, cells: four, anchorId: 'A', op: 'merge-block' }).reason, /지원하지 않는/);
  assert.match(CellMerge.plan({ rows: 1, cols: 2, cells: planCells(1, 2, ['stack', 'stack']), anchorId: 'A', op: 'merge-column' }).reason, /2×2/);
  const mpr = planCells(2, 2, ['stack', 'unreadable', 'stack', 'stack']);
  assert.match(CellMerge.plan({ rows: 2, cols: 2, cells: mpr, anchorId: 'A', op: 'maximize' }).reason, /MPR·3D·SR·PDF/);
  const empty = planCells(2, 2, ['stack', 'empty', 'stack', 'stack']);
  // An empty cell inside the block is recorded and rebuilt empty; only the surviving
  // anchor must carry an image.
  assert.equal(CellMerge.plan({ rows: 2, cols: 2, cells: empty, anchorId: 'A', op: 'maximize' }).ok, true);
  assert.match(CellMerge.plan({ rows: 2, cols: 2, cells: empty, anchorId: 'B', op: 'maximize' }).reason, /영상이 표시된/);
  const merged = planCells(2, 2, ['stack', 'stack', 'stack', 'stack']);
  merged[0] = { ...merged[0], width: 1, height: .5 };
  assert.match(CellMerge.plan({ rows: 2, cols: 2, cells: merged, anchorId: 'A', op: 'maximize' }).reason, /이미 병합/);
});

test('maximize keeps the anchor source and restores every displaced cell exactly', async () => {
  const x = fixture();
  const before = layoutOf(x.state), camera = clone(x.viewports.get('B').camera), voi = clone(x.viewports.get('B').properties.voiRange);
  x.viewports.get('D').index = 2; x.viewports.get('D').current = 'wadors:D:2';
  const merged = await x.controller.merge('maximize', 'D');
  assert.equal(merged.ok, true);
  assert.deepEqual(x.calls[0].layoutOptions, [{ x: 0, y: 0, width: 1, height: 1 }]);
  assert.deepEqual(layoutOf(x.state), [['D', 0, 0, 1, 1]]);
  assert.equal(x.state.activeViewportId, 'D');
  assert.equal(x.controller.state().merged, true);
  const back = await x.controller.unmerge();
  assert.equal(back.ok, true);
  assert.deepEqual(layoutOf(x.state), before);
  assert.deepEqual(x.viewports.get('B').camera, camera);
  assert.deepEqual(x.viewports.get('B').properties.voiRange, voi);
  assert.equal(x.viewports.get('D').current, 'wadors:D:2');
  assert.equal(x.controller.state().merged, false);
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[1].layoutOptions, null);
});

test('column merge keeps surviving cells in their own quadrant and restores their newest work', async () => {
  const x = fixture();
  const merged = await x.controller.merge('merge-column', 'A');
  assert.equal(merged.ok, true);
  assert.deepEqual(layoutOf(x.state), [['A', 0, 0, .5, 1], ['B', .5, 0, .5, .5], ['D', .5, .5, .5, .5]]);
  // The user scrolls a surviving cell while merged: unmerge owes them that newer state.
  x.viewports.get('B').index = 3; x.viewports.get('B').current = 'wadors:B:3';
  const back = await x.controller.unmerge();
  assert.equal(back.ok, true);
  assert.deepEqual(layoutOf(x.state).map(row => row[0]), ['A', 'B', 'C', 'D']);
  assert.equal(x.viewports.get('B').current, 'wadors:B:3');
  assert.equal(x.viewports.get('C').current, 'wadors:C:0');
});

test('an empty cell is recorded and comes back empty, and never becomes the anchor', async () => {
  const x = fixture({ empty: ['B', 'D'] });
  const before = layoutOf(x.state);
  const refused = await x.controller.merge('maximize', 'B');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /영상이 표시된/);
  assert.equal(x.calls.length, 0);
  assert.equal((await x.controller.merge('maximize', 'A')).ok, true);
  assert.deepEqual(layoutOf(x.state), [['A', 0, 0, 1, 1]]);
  assert.equal((await x.controller.unmerge()).ok, true);
  assert.deepEqual(layoutOf(x.state), before);
  assert.deepEqual(x.state.viewports.get('B').displaySetInstanceUIDs, []);
  assert.equal(x.viewports.get('B').getCurrentImageId(), null);
});

test('a native cache that returns the presentation needs no explicit re-apply', async () => {
  const x = fixture({ restoresPresentation: true });
  const before = clone(x.viewports.get('C').camera);
  assert.equal((await x.controller.merge('maximize', 'A')).ok, true);
  assert.equal((await x.controller.unmerge()).ok, true);
  assert.deepEqual(x.viewports.get('C').camera, before);
});

test('a layout request that never arrives is rolled back and verified, never claimed', async () => {
  const x = fixture({ breakLayout: true });
  const before = layoutOf(x.state);
  const result = await x.controller.merge('maximize', 'A');
  assert.equal(result.ok, false);
  assert.match(result.message, /이전 배치로 복구했습니다/);
  assert.deepEqual(layoutOf(x.state), before);
  assert.equal(x.controller.state().merged, false);
  assert.equal(x.controller.state().quarantined, false);
});

test('an unverifiable restore disables the controls instead of claiming a restore', async () => {
  const x = fixture();
  assert.equal((await x.controller.merge('maximize', 'A')).ok, true);
  // The rebuilt cells cannot take their recorded camera back.
  const original = x.services.viewportGridService.setLayout;
  x.services.viewportGridService.setLayout = function (payload) {
    return original.call(this, payload).then(() => {
      for (const view of x.state.viewports.values()) {
        const viewport = x.viewports.get(view.viewportId);
        if (viewport) { viewport.setCamera = () => { }; viewport.setVOI = () => { }; viewport.camera.parallelScale = 99; }
      }
    });
  };
  const back = await x.controller.unmerge();
  assert.equal(back.ok, false);
  assert.match(back.message, /확인하지 못했습니다/);
  const state = x.controller.state();
  assert.equal(state.quarantined, true);
  assert.equal(state.merged, false);
  // Quarantined means no further dispatch at all.
  const calls = x.calls.length;
  assert.equal((await x.controller.merge('maximize', 'A')).ok, false);
  assert.equal(x.calls.length, calls);
});

test('busy image work, cine playback and a foreign layout change refuse before dispatch', async () => {
  const x = fixture();
  x.services.cineService.getState = () => ({ cines: { A: { isPlaying: true } } });
  let result = await x.controller.merge('maximize', 'A');
  assert.equal(result.ok, false); assert.match(result.message, /Cine/);
  assert.equal(x.calls.length, 0);
  x.services.cineService.getState = () => ({ cines: {} });
  x.win.kinViewerJobWorkspaceState = () => ({ busy: true });
  result = await x.controller.merge('maximize', 'A');
  assert.equal(result.ok, false); assert.match(result.message, /끝난 뒤/);
  assert.equal(x.calls.length, 0);
  // An unsaved measurement is not in-flight work: merge never removes an annotation,
  // so it must stay available while the user is measuring.
  x.win.kinViewerJobWorkspaceState = () => ({ dirty: true, busy: false });
  x.win.kinViewerHistoryHasUnsaved = () => true;
  result = await x.controller.merge('maximize', 'A');
  assert.equal(result.ok, true);
  assert.equal((await x.controller.unmerge()).ok, true);
  delete x.win.kinViewerJobWorkspaceState; delete x.win.kinViewerHistoryHasUnsaved;
  const dispatched = x.calls.length;
  x.doc.fullscreenElement = {};
  result = await x.controller.merge('maximize', 'A');
  assert.equal(result.ok, false); assert.match(result.message, /전체 화면/);
  assert.equal(x.calls.length, dispatched);
  x.doc.fullscreenElement = null;
  assert.equal((await x.controller.merge('maximize', 'A')).ok, true);
  // A layout change this module did not make drops the record instead of rebuilding.
  x.state.viewports.get('A').displaySetInstanceUIDs = ['ds-other'];
  const rejected = await x.controller.unmerge();
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /병합 기록을 지웠습니다/);
  assert.equal(x.controller.state().merged, false);
  assert.equal(x.calls.length, dispatched + 1);
});

test('merging refuses while already merged and unmerge refuses without a record', async () => {
  const x = fixture();
  assert.match((await x.controller.unmerge()).message, /되돌릴 병합 기록이 없습니다/);
  assert.equal((await x.controller.merge('merge-row', 'A')).ok, true);
  const again = await x.controller.merge('maximize', 'A');
  assert.equal(again.ok, false);
  assert.match(again.message, /이미 병합/);
  assert.equal(x.calls.length, 1);
});

test('a stopped session refuses every operation', async () => {
  const x = fixture();
  x.controller.stop();
  const result = await x.controller.merge('maximize', 'A');
  assert.equal(result.ok, false);
  assert.match(result.message, /세션이 변경되었습니다/);
  assert.equal(x.calls.length, 0);
});
