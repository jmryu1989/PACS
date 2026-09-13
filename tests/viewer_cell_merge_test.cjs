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
// A mutation that silently fails to apply would report a guard as proven for nothing - and
// an anchor that quietly stops matching the shipped module reports it for nothing while
// still exiting non-zero, which is worse, because the run that dies at load looks exactly
// like the run whose assertion caught the defect. So every anchor, selected or not, is
// declared with the number of sites it must match, and the first test in this file audits
// the whole declaration against the file on disk: drift fails by name in a plain run,
// before anyone cites a mutation as evidence.
const declared = [];
const occurrences = (text, from) => typeof from === 'string' ? text.split(from).length - 1 : (text.match(from) || []).length;
function mutate(name, from, to, expected = 1) {
  declared.push({ name, from, expected });
  if (mutation !== name) return;
  const found = occurrences(source, from);
  if (found !== expected) throw new Error('mutation anchor does not match the module: ' + name + ' expected ' + expected + ' found ' + found);
  const next = source.replace(from, to);
  if (next === source || occurrences(next, from) !== 0) throw new Error('mutation did not apply: ' + name);
  source = next;
}
mutate('skip-kind-guard', "if (!['stack', 'empty'].includes(cell.kind))", 'if (false)');
mutate('skip-uniform-guard', '!near(cell.width, 1 / cols) || !near(cell.height, 1 / rows))', 'false)');
mutate('trust-dispatch', 'const achieved = await settle(() => geometryIs(expected), deadline);', 'const achieved = true;');
mutate('claim-restore', 'if (restored(target)) { if (++confirmed >= 2) return true; }', 'if (true) { return true; }');
// The three defects this module was rejected for, each reintroduced by one edit: a
// rollback that reads the screen it just disturbed, a record taken without re-confirming
// the geometry it describes, and a camera handed back whole with an unrelated field.
// Both halves of the rollback defect, because the fix closed it in two places: the failed
// path read the screen back, and that reading had no settled baseline to be judged against.
mutate('rollback-adopts-screen', 'return await rebuild(base, owned)', 'return await rebuild(unmergeTarget(base), owned)');
mutate('rollback-adopts-screen', "if (!merged || merged.kind !== 'stack' || cell.kind !== 'stack') return cell;",
  "if (!merged || merged.kind !== 'stack' || cell.kind !== 'stack') return { ...cell, camera: current.camera, voiRange: current.voiRange, invert: current.invert, imageId: current.imageId, imageIndex: current.imageIndex };");
mutate('record-without-recheck', 'if (geometryIs(expected)) {', 'if (true) {');
// Ownership, in both directions: rebuilding over a screen this module cannot account for,
// and folding the user's own input into the baseline the restore is judged against.
mutate('trust-foreign-screen', 'if (!ours(base)) return { ok: false, message: quarantine(FOREIGN) };', ';');
mutate('adopt-input-baseline', 'if (steady === false) { if (held) ambiguous = true; return actual; }', ';');
// The input that arrives before the refit lands: keeping the newer value is right, calling
// it a restored image state is not. This drops the honesty and keeps the value.
mutate('claim-refit-as-user', '{ if (held) ambiguous = true; return actual; }', '{ return actual; }');
// The camera judged as one decision again, which is what let a slice change carry the
// merge's refit zoom back with it.
mutate('adopt-merged-camera', 'const owed = decide(sameCameraKeys(current.camera, merged.camera, keys),',
  'const owed = decide(sameCamera(current.camera, merged.camera),');
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
    // Scrolling a real stack moves the camera along the view normal with the slice, so the
    // camera cannot be read as one decision: a pure scroll must not look like a zoom.
    setImageIdIndex(value) {
      const shift = value - this.index;
      this.index = value; this.current = 'wadors:' + id + ':' + value;
      this.camera.focalPoint = [this.camera.focalPoint[0], this.camera.focalPoint[1], this.camera.focalPoint[2] + shift * 2];
      this.camera.position = [this.camera.position[0], this.camera.position[1], this.camera.position[2] + shift * 2];
      return Promise.resolve();
    },
    render() { this.renders++; },
  };
}

// A grid whose setLayout follows the pinned SET_LAYOUT reducer: per-position rectangles
// override the uniform default and positions beyond layoutOptions.length are skipped.
function fixture({ rows = 2, cols = 2, restoresPresentation = false, breakLayout = false, empty = [], refitOnResize = false, deviate = null, slow = 0 } = {}) {
  let deviated = false;
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
      // A native layout that lands a valid rectangle set other than the one asked for.
      // The panes really do change shape, so the refit happens exactly as it would on a
      // successful merge, but the achieved geometry is not the requested one.
      if (deviate && !deviated && payload.layoutOptions?.length === deviate.length) {
        deviated = true; payload = { ...payload, layoutOptions: clone(deviate) };
      }
      // A native layout whose promise resolves before the grid has actually been rebuilt,
      // which is the reason the achieved geometry and not the promise decides success.
      if (slow) { setTimeout(() => apply(payload), slow); return Promise.resolve(); }
      apply(payload);
      return Promise.resolve();
    },
  };
  function apply(payload) {
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
      // The native viewport refits its camera when a pane changes shape, and resizing
      // back does not undo that refit; this models the ratio drift seen on real panes.
      if (refitOnResize) for (const [id, cell] of next) {
        const previous = state.viewports.get(id), viewport = viewports.get(id);
        if (previous && viewport && Math.abs(previous.width / previous.height - cell.width / cell.height) > 1e-6)
          viewport.camera.parallelScale = Number((viewport.camera.parallelScale * 0.883).toFixed(6));
      }
      state.viewports = next; state.layout = { layoutType: 'grid', numRows: payload.numRows, numCols: payload.numCols };
      state.activeViewportId = payload.activeViewportId;
  }
  state.saved = new Map([...viewports].map(([id, viewport]) => [id, { camera: clone(viewport.camera), properties: clone(viewport.properties), current: viewport.current, index: viewport.index }]));
  const services = { viewportGridService: grid, cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) || null },
    displaySetService: { getDisplaySetByUID: id => sets.get(id) }, cineService: { getState: () => ({ cines: {} }) } };
  // Real listener bookkeeping, so a test can model the user input that accompanies a
  // foreign panel's layout change and check that ownership is given up because of it.
  const listeners = new Map();
  const doc = { fullscreenElement: null, querySelector: () => null,
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    fire(type) { for (const handler of [...(listeners.get(type) || [])]) handler({ type }); } };
  const win = { setTimeout, clearTimeout, addEventListener() { }, removeEventListener() { } };
  const controller = CellMerge.create(services, { doc, root: win });
  return { controller, state, cells, viewports, calls, services, win, doc };
}

const layoutOf = state => [...state.viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x)
  .map(view => [view.viewportId, view.x, view.y, view.width, view.height]);

const planCells = (rows, cols, kinds) => kinds.map((kind, index) => ({ viewportId: String.fromCharCode(65 + index), kind,
  x: (index % cols) / cols, y: Math.floor(index / cols) / rows, width: 1 / cols, height: 1 / rows, sets: ['ds-' + index] }));

// A guard is only proven by a mutation that really reintroduces the defect. An anchor that
// no longer matches the shipped module produces a run that still exits non-zero, which a
// checker reading exit codes would count as a proof, so the whole declaration is audited
// here by name against the file on disk - in every plain run, before any mutation is used.
test('every declared mutation anchor still matches the shipped module exactly once', () => {
  const shipped = fs.readFileSync(sourcePath, 'utf8');
  // Eleven anchors for ten mutations: the rollback defect takes two edits to reintroduce.
  assert.equal(declared.length, 11);
  for (const item of declared)
    assert.equal(occurrences(shipped, item.from), item.expected, 'anchor drifted: ' + item.name + ' ' + item.from);
  assert.deepEqual([...new Set(declared.map(item => item.name))].sort(),
    ['adopt-input-baseline', 'adopt-merged-camera', 'claim-refit-as-user', 'claim-restore', 'record-without-recheck',
      'rollback-adopts-screen', 'skip-kind-guard', 'skip-uniform-guard', 'trust-dispatch', 'trust-foreign-screen']);
});

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

test('a pane refit during the merge is undone on restore, but real user work is not', async () => {
  const x = fixture({ refitOnResize: true });
  const zoom = x.viewports.get('A').camera.parallelScale;
  assert.equal((await x.controller.merge('merge-column', 'A')).ok, true);
  // The merged pane changed shape, so the native refit moved the zoom.
  assert.notEqual(x.viewports.get('A').camera.parallelScale, zoom);
  assert.equal((await x.controller.unmerge()).ok, true);
  assert.equal(x.viewports.get('A').camera.parallelScale, zoom);

  const y = fixture({ refitOnResize: true });
  assert.equal((await y.controller.merge('merge-column', 'A')).ok, true);
  y.viewports.get('A').camera.parallelScale = 3.5;
  assert.equal((await y.controller.unmerge()).ok, true);
  assert.equal(y.viewports.get('A').camera.parallelScale, 3.5);
});

// Each field the merge record carries is decided on its own. Scrolling or windowing the
// merged cell is the user's work and is kept; the zoom nobody touched is still owed the
// pre-merge value even though the merge's own refit is sitting in it.
test('work the user did in a reshaped merged cell is kept without surrendering the zoom they never touched', async () => {
  const x = fixture({ refitOnResize: true });
  const zoom = x.viewports.get('A').camera.parallelScale, voi = clone(x.viewports.get('A').properties.voiRange);
  assert.equal((await x.controller.merge('merge-column', 'A')).ok, true);
  const refit = x.viewports.get('A').camera.parallelScale;
  assert.notEqual(refit, zoom);
  // The user scrolls the merged cell. Only the slice is theirs; the refit above is not.
  // Scrolling drags focalPoint and position with it, which must not read as a zoom.
  await x.viewports.get('A').setImageIdIndex(3);
  assert.equal((await x.controller.unmerge()).ok, true);
  assert.equal(x.viewports.get('A').current, 'wadors:A:3');
  assert.equal(x.viewports.get('A').camera.parallelScale, zoom);
  // Where the camera sits follows the slice the user chose, not the slice it was recorded on.
  assert.deepEqual(x.viewports.get('A').camera.focalPoint, [0, 0, 6]);
  assert.deepEqual(x.viewports.get('A').camera.position, [0, 0, 16]);
  assert.deepEqual(x.viewports.get('A').properties.voiRange, voi);

  // The same holds for window/level and invert: they come back, the untouched zoom does not
  // follow them, and the slice nobody scrolled stays where the record put it.
  const y = fixture({ refitOnResize: true });
  const yzoom = y.viewports.get('A').camera.parallelScale;
  assert.equal((await y.controller.merge('merge-column', 'A')).ok, true);
  y.viewports.get('A').properties.voiRange = { lower: 5, upper: 55 };
  y.viewports.get('A').properties.invert = true;
  assert.equal((await y.controller.unmerge()).ok, true);
  assert.deepEqual(y.viewports.get('A').properties.voiRange, { lower: 5, upper: 55 });
  assert.equal(y.viewports.get('A').properties.invert, true);
  assert.equal(y.viewports.get('A').camera.parallelScale, yzoom);
  assert.equal(y.viewports.get('A').current, 'wadors:A:0');
});

test('a native layout that lands after its own promise resolved is waited for, not rolled back', async () => {
  const x = fixture({ slow: 300 });
  const result = await x.controller.merge('merge-column', 'A');
  assert.equal(result.ok, true);
  assert.deepEqual(layoutOf(x.state), [['A', 0, 0, .5, 1], ['B', .5, 0, .5, .5], ['D', .5, .5, .5, .5]]);
  assert.equal(x.controller.state().merged, true);
  assert.equal((await x.controller.unmerge()).ok, true);
  assert.deepEqual(layoutOf(x.state).map(row => row[0]), ['A', 'B', 'C', 'D']);
});

test('a native layout that lands a different shape rolls back the pre-merge state, not the refit it caused', async () => {
  // Three rectangles, so the merge dispatch is the one that deviates, but a row merge
  // where a column merge was asked for: the panes resize and refit, the geometry is wrong.
  const x = fixture({ refitOnResize: true, deviate: [{ x: 0, y: 0, width: 1, height: .5 }, { x: 0, y: .5, width: .5, height: .5 }, { x: .5, y: .5, width: .5, height: .5 }] });
  const before = layoutOf(x.state), zoom = x.viewports.get('A').camera.parallelScale, voi = clone(x.viewports.get('A').properties.voiRange);
  const result = await x.controller.merge('merge-column', 'A');
  assert.equal(result.ok, false);
  assert.match(result.message, /이전 배치로 복구했습니다/);
  assert.deepEqual(layoutOf(x.state), before);
  // Nothing on that screen was the user's: this path runs only while no interaction has
  // happened, so the refit the failed merge caused must not be handed back as their state.
  assert.equal(x.viewports.get('A').camera.parallelScale, zoom);
  assert.deepEqual(x.viewports.get('A').properties.voiRange, voi);
  assert.equal(x.controller.state().merged, false);
  assert.equal(x.controller.state().quarantined, false);
  // Ownership is proven here - every viewport and every source on screen is one this
  // module recorded - so the rollback really is dispatched, unlike the foreign case below.
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[1].layoutOptions, null);
});

test('a foreign layout landing while the merge settles is never recorded as this merge', async () => {
  // Another panel - an async Hanging Protocol Apply or Load Job whose own click predates
  // this merge, so no input of its own lands inside the interaction window - replaces a
  // source inside the settling wait. The merge failed, but the newest thing on screen is
  // that panel's work, not this module's, and rebuilding the pre-merge grid over it would
  // be a clobber dressed up as a recovery. Nothing is dispatched: no second setLayout call.
  const x = fixture();
  const interfere = grid => {
    const original = grid.setLayout;
    grid.setLayout = function (payload) {
      return original.call(this, payload).then(value => {
        if (payload.layoutOptions) setTimeout(() => { x.state.viewports.get('B').displaySetInstanceUIDs = ['ds-other']; }, 30);
        return value;
      });
    };
  };
  interfere(x.services.viewportGridService);
  const result = await x.controller.merge('merge-column', 'A');
  assert.equal(result.ok, false);
  assert.match(result.message, /다른 기능이 화면을 바꾸어/);
  assert.equal(x.controller.state().merged, false);
  assert.equal(x.controller.state().quarantined, true);
  assert.deepEqual(x.state.viewports.get('B').displaySetInstanceUIDs, ['ds-other']);
  assert.equal(x.calls.length, 1);
  assert.equal((await x.controller.unmerge()).ok, false);

  // The same holds when the foreign work is a whole new grid rather than one source: the
  // viewports on screen are not the ones this module recorded, so it cannot account for
  // them and does not rebuild over them.
  const z = fixture();
  const originalZ = z.services.viewportGridService.setLayout;
  z.services.viewportGridService.setLayout = function (payload) {
    return originalZ.call(this, payload).then(value => {
      if (payload.layoutOptions) setTimeout(() => {
        z.state.viewports = new Map([['HP1', { viewportId: 'HP1', x: 0, y: 0, width: 1, height: .5, displaySetInstanceUIDs: ['ds-hp1'] }],
          ['HP2', { viewportId: 'HP2', x: 0, y: .5, width: 1, height: .5, displaySetInstanceUIDs: ['ds-hp2'] }]]);
      }, 30);
      return value;
    });
  };
  const landed = await z.controller.merge('merge-column', 'A');
  assert.equal(landed.ok, false);
  assert.match(landed.message, /다른 기능이 화면을 바꾸어/);
  assert.deepEqual([...z.state.viewports.keys()], ['HP1', 'HP2']);
  assert.equal(z.calls.length, 1);

  // The same change driven by the user's own click on that other panel: ownership is gone,
  // so the screen is left alone and the panel says so instead of recording a merge.
  const y = fixture();
  const original = y.services.viewportGridService.setLayout;
  y.services.viewportGridService.setLayout = function (payload) {
    return original.call(this, payload).then(value => {
      if (payload.layoutOptions) setTimeout(() => {
        y.doc.fire('pointerdown');
        y.state.viewports.get('B').displaySetInstanceUIDs = ['ds-other'];
      }, 30);
      return value;
    });
  };
  const taken = await y.controller.merge('merge-column', 'A');
  assert.equal(taken.ok, false);
  assert.match(taken.message, /확인하지 못했습니다/);
  assert.equal(y.controller.state().merged, false);
  assert.equal(y.controller.state().quarantined, true);
  // A record that survived here would rebuild the pre-merge grid over the other panel's work.
  assert.equal((await y.controller.unmerge()).ok, false);
});

// The reading the restore is judged against is taken once the merge has settled, and the
// user can work inside that wait. Their edit must not be folded into that baseline and
// handed back as the merge's own doing - and a bare click, which changes nothing, must not
// cost them the refit undo either. What the screen held at the instant their input arrived
// separates the two.
test('a user edit made while the merge settles is kept, and a bare click costs nothing', async () => {
  const x = fixture({ refitOnResize: true });
  const zoom = x.viewports.get('A').camera.parallelScale;
  const duringSettle = (env, act) => {
    const original = env.services.viewportGridService.setLayout;
    env.services.viewportGridService.setLayout = function (payload) {
      return original.call(this, payload).then(value => {
        if (payload.layoutOptions) setTimeout(act, 30);
        return value;
      });
    };
  };
  duringSettle(x, () => {
    x.doc.fire('pointerdown');
    x.viewports.get('A').properties.voiRange = { lower: 12, upper: 90 };
    x.viewports.get('A').setImageIdIndex(2);
  });
  assert.equal((await x.controller.merge('merge-column', 'A')).ok, true);
  assert.notEqual(x.viewports.get('A').camera.parallelScale, zoom);
  const back = await x.controller.unmerge();
  assert.equal(back.ok, true);
  // Their window and their slice survive the restore, and are not reported as restored work.
  assert.deepEqual(x.viewports.get('A').properties.voiRange, { lower: 12, upper: 90 });
  assert.equal(x.viewports.get('A').current, 'wadors:A:2');
  // The zoom nobody touched still gives the refit back: the input is placed, not assumed.
  assert.equal(x.viewports.get('A').camera.parallelScale, zoom);
  assert.match(back.message, /이전 칸 배치와 영상 상태로 되돌렸습니다/);

  const y = fixture({ refitOnResize: true });
  const yzoom = y.viewports.get('A').camera.parallelScale, yvoi = clone(y.viewports.get('A').properties.voiRange);
  duringSettle(y, () => { y.doc.fire('pointerdown'); });
  assert.equal((await y.controller.merge('merge-column', 'A')).ok, true);
  const restored = await y.controller.unmerge();
  assert.equal(restored.ok, true);
  assert.equal(y.viewports.get('A').camera.parallelScale, yzoom);
  assert.deepEqual(y.viewports.get('A').properties.voiRange, yvoi);
  assert.match(restored.message, /이전 칸 배치와 영상 상태로 되돌렸습니다/);
});

// The same input, on either side of the native refit. What the screen held at the instant
// the input arrived tells the two orderings apart: after the refit, a value that moved since
// is the user's; before it, the same evidence fits their gesture and this merge's own refit
// equally well. Their work is kept either way - it is the claim about it that has to differ.
test('an input that lands before the native refit keeps the user work without claiming the image state came back', async () => {
  const atSettle = (env, delay, act) => {
    const original = env.services.viewportGridService.setLayout;
    env.services.viewportGridService.setLayout = function (payload) {
      return original.call(this, payload).then(value => {
        if (payload.layoutOptions) setTimeout(act, delay);
        return value;
      });
    };
  };
  // The merged layout lands at 60ms, so an input at 10ms reaches a screen that still holds
  // the pre-merge zoom: the refit is still to come.
  const x = fixture({ refitOnResize: true, slow: 60 });
  const zoom = x.viewports.get('A').camera.parallelScale, bcamera = clone(x.viewports.get('B').camera);
  atSettle(x, 10, () => { x.doc.fire('wheel'); x.viewports.get('A').setImageIdIndex(2); });
  assert.equal((await x.controller.merge('merge-column', 'A')).ok, true);
  const refit = x.viewports.get('A').camera.parallelScale;
  assert.notEqual(refit, zoom);
  const back = await x.controller.unmerge();
  assert.equal(back.ok, true);
  assert.deepEqual(layoutOf(x.state).map(row => row[0]), ['A', 'B', 'C', 'D']);
  // The slice they scrolled to is theirs and is kept. The zoom moved between their input
  // and the settled reading, which their wheel and the refit explain equally well, so the
  // newer value stays too - and the panel does not report the image state as restored.
  assert.equal(x.viewports.get('A').current, 'wadors:A:2');
  assert.equal(x.viewports.get('A').camera.parallelScale, refit);
  assert.match(back.message, /되돌리지 않고 그대로 두었습니다/);
  assert.doesNotMatch(back.message, /영상 상태로 되돌렸습니다/);
  // A surviving cell kept its shape, so no refit could have reached it: it is owed its
  // recorded state whole, and the ambiguity above is confined to the cell that was reshaped.
  assert.deepEqual(x.viewports.get('B').camera, bcamera);
  assert.equal(x.viewports.get('B').current, 'wadors:B:0');

  // The control: the same user work, the same fixture, the input placed after the refit has
  // landed. Now the zoom at the input instant is the refit's own, so the value the settled
  // reading holds is attributable and the untouched zoom really is restored.
  const y = fixture({ refitOnResize: true, slow: 60 });
  const yzoom = y.viewports.get('A').camera.parallelScale;
  atSettle(y, 100, () => { y.doc.fire('wheel'); y.viewports.get('A').setImageIdIndex(2); });
  assert.equal((await y.controller.merge('merge-column', 'A')).ok, true);
  assert.notEqual(y.viewports.get('A').camera.parallelScale, yzoom);
  const restored = await y.controller.unmerge();
  assert.equal(restored.ok, true);
  assert.equal(y.viewports.get('A').current, 'wadors:A:2');
  assert.equal(y.viewports.get('A').camera.parallelScale, yzoom);
  assert.match(restored.message, /이전 칸 배치와 영상 상태로 되돌렸습니다/);
});

test('an input this module could not place on the screen is never silently reverted', async () => {
  const x = fixture({ refitOnResize: true });
  const zoom = x.viewports.get('A').camera.parallelScale;
  const original = x.services.viewportGridService.setLayout;
  x.services.viewportGridService.setLayout = function (payload) {
    return original.call(this, payload).then(value => {
      if (payload.layoutOptions) setTimeout(() => {
        // The input arrives while that cell cannot be read, so nothing about the state
        // that follows can be attributed either to the user or to the merge.
        const viewport = x.viewports.get('A'); x.viewports.delete('A');
        x.doc.fire('pointerdown');
        x.viewports.set('A', viewport);
        viewport.properties.voiRange = { lower: 7, upper: 77 };
      }, 30);
      return value;
    });
  };
  assert.equal((await x.controller.merge('merge-column', 'A')).ok, true);
  const refit = x.viewports.get('A').camera.parallelScale;
  assert.notEqual(refit, zoom);
  const back = await x.controller.unmerge();
  assert.equal(back.ok, true);
  assert.deepEqual(layoutOf(x.state).map(row => row[0]), ['A', 'B', 'C', 'D']);
  // Nothing is reverted on a guess, and the restore says exactly that instead of claiming
  // the image state came back.
  assert.deepEqual(x.viewports.get('A').properties.voiRange, { lower: 7, upper: 77 });
  assert.equal(x.viewports.get('A').camera.parallelScale, refit);
  assert.match(back.message, /되돌리지 않고 그대로 두었습니다/);
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
