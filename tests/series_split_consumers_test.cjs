// REQ-FB-052 (one MR series holding several sequences/time points opens as one virtual series per group)
// -> RISK-SPLIT-TAB-LOST/PRIOR-WRONG-PART/PRIOR-LATE -> TEST-SERIES-SPLIT-CONSUMERS.
// The viewer places that make one series' display sets their own: the patient tab restore (viewer-patient-tabs.js),
// the prior image choice and its request validity (the shipped viewer-prior extension in config/ohif.js with the shipped
// prior controller, the shell seam viewer-ux-shell.js and the ranking in viewer-hanging-settings.js) and the personal MR
// layout. The split display sets are made by the shipped split model over the pinned stack handler double.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createStackHandler, mixedSeries } = require('./fixtures/ohif_stack_4d.cjs');

const shipped = fs.readFileSync('config/ohif.js', 'utf8');
const slice = (from, to) => shipped.slice(shipped.indexOf(from), shipped.indexOf(to));
const splitModel = vm.runInNewContext(slice('function kinSeriesSplitModel(', 'function kinCreateSeriesSplit(') + ';kinSeriesSplitModel');
const priorSource = slice('function kinCreateViewerPrior(', 'function kinCreateMultiStudyStrip(');
const read = name => fs.readFileSync('worklist-v0/hpacs-lite/' + name, 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element extends EventTarget {
  constructor(tag = 'div') { super(); this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.style = {}; this.textContent = ''; }
  get classList() { return { contains: c => (this.className || '').split(' ').includes(c),
    add: c => { this.className = (this.className || '') + ' ' + c; },
    remove: c => { this.className = (this.className || '').split(' ').filter(x => x !== c).join(' '); },
    toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); } }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) { n.remove?.(); n.parentElement = this; this.children.push(n); } }
  prepend(...nodes) { this.append(...nodes); }
  before() {}
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.append(...nodes); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attr = selector.match(/^\[([^=]+)=["']?([^"'\]]+)["']?\]$/);
    return attr ? this.attrs[attr[1]] === attr[2] : this.tag === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
}

// The current examination: one MR series holding b0 and b1000 at 12 positions, split by the shipped model into
// `AX DWI · 1/2 b0` and `AX DWI · 2/2 b1000`, with the same series number and UID.
function splitSeries() {
  const handler = createStackHandler();
  const sets = splitModel(handler.getDisplaySetsFromSeries(mixedSeries()), list => handler.getDisplaySetsFromSeries(list));
  assert.deepEqual(Array.from(sets, set => set.SeriesDescription), ['AX DWI · 1/2 b0', 'AX DWI · 2/2 b1000']);
  return Array.from(sets);
}
// A prior examination whose b0 and b1000 arrived as two series.
function priorSeries(study = '2.25.8000') {
  const handler = createStackHandler();
  return [['AX DWI b0', '2.25.8001', 5, 0], ['AX DWI b1000', '2.25.8002', 6, 1000]].map(([description, series, number, value]) =>
    handler.getDisplaySetsFromSeries(mixedSeries({ values: [value], description, series,
      patch(instance) { instance.StudyInstanceUID = study; instance.SeriesNumber = number; } }))[0]);
}
function singleSeries(description, series, number, study = '2.25.7000') {
  return createStackHandler().getDisplaySetsFromSeries(mixedSeries({ values: [0], description, series,
    patch(instance) { instance.StudyInstanceUID = study; instance.SeriesNumber = number; } }))[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Patient tabs: leave a 1×2 of the two parts for another patient and come back.
function tabsWorld(firstSets) {
  const listeners = new Set(), views = new Map(), body = new Element('body'), layouts = [];
  const location = { origin: 'https://viewer.test', href: 'https://viewer.test/ohif/viewer?StudyInstanceUIDs=2.25.7000' };
  const study = () => new URL(location.href).searchParams.get('StudyInstanceUIDs');
  const other = singleSeries('AX T2', '2.25.9001', 1, '2.25.9000');
  let sets = [...firstSets, other];
  const byId = id => sets.find(set => set.displaySetInstanceUID === id);
  const state = { activeViewportId: null, layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, viewports: new Map() };
  const changed = viewportId => { for (const listener of [...listeners]) listener({ viewportId }); };
  function view(set, index) {
    const ids = set ? set.images.map(image => image.imageId) : [];
    return { type: 'stack', current: index, targetImageIdIndex: index, properties: {}, camera: { parallelScale: 100 },
      canvas: { width: 400, height: 400 },
      getImageIds: () => ids, getCurrentImageId() { return ids[this.current]; }, getCurrentImageIdIndex() { return this.current; },
      setImageIdIndex(value) { this.current = value; return Promise.resolve(ids[value]); }, render() {},
      getProperties() { return { ...this.properties }; }, setProperties(value) { this.properties = { ...this.properties, ...value }; },
      getCamera() { return { ...this.camera }; }, setCamera(value) { this.camera = { ...this.camera, ...value }; },
      getViewPresentation() { return { zoom: 1, pan: [0, 0] }; }, setViewPresentation() {} };
  }
  function grid(rows, cols, cells) {
    views.clear(); state.viewports = new Map();
    state.layout = { layoutType: 'grid', numRows: rows, numCols: cols };
    cells.forEach(([id, set, index]) => {
      views.set(id, view(set, index));
      state.viewports.set(id, { viewportId: id, displaySetInstanceUIDs: set ? [set.displaySetInstanceUID] : [] });
    });
    state.activeViewportId = cells[0][0];
  }
  const services = {
    displaySetService: { getActiveDisplaySets: () => sets, getDisplaySetByUID: byId },
    viewportGridService: { getState: () => state, setLayout(options) {
      layouts.push(options);
      const cells = Array.from({ length: options.numRows * options.numCols }, (_, i) => options.findOrCreateViewport(i));
      grid(options.numRows, options.numCols, cells.map(cell => [cell.viewportOptions.viewportId,
        byId(cell.displaySetInstanceUIDs[0]), cell.viewportOptions.initialImageOptions?.index ?? 0]));
      queueMicrotask(() => cells.forEach(cell => changed(cell.viewportOptions.viewportId)));
    } },
    cornerstoneViewportService: { EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => views.get(id),
      subscribe(_event, listener) { listeners.add(listener); return { unsubscribe: () => listeners.delete(listener) }; } } };
  // The stock route reopens a study as one cell with its first display set.
  const reopen = () => {
    const first = sets.find(set => set.StudyInstanceUID === study());
    grid(1, 1, [['cell-' + study(), first, 0]]);
    queueMicrotask(() => changed('cell-' + study()));
  };
  const window = { KinViewerInfoBar: { identity: () => ({ instance: { StudyInstanceUID: study() } }) },
    kinViewerFrameCoverageConfirm: () => true, dispatchEvent: reopen };
  const context = vm.createContext({ window, location, URL, URLSearchParams, AbortController, structuredClone, queueMicrotask,
    clearTimeout, setTimeout, requestAnimationFrame: fn => queueMicrotask(fn), crypto: require('node:crypto').webcrypto, PopStateEvent: Event,
    document: { body, createElement: tag => new Element(tag), getElementById: () => null, querySelector: () => null },
    history: { state: {}, replaceState(_state, _title, href) { location.href = href; } },
    fetch: async path => { const uid = new URL(path, location.origin).searchParams.get('uids');
      return { ok: true, json: async () => ({ studies: [{ uid, sourcePatientKey: uid, id: uid, name: 'Synthetic' }] }) }; } });
  vm.runInContext(read('viewer-patient-tabs.js'), context);
  return { tabs: window.KinViewerPatientTabs, services, state, views, layouts, grid,
    replaceSets(next) { sets = [...next, other]; } };
}

async function leaveAndReturn(world) {
  const { tabs, services } = world;
  await tabs.mount({ services, session: { state: () => 'active', readOnly: () => false }, refreshChrome() {} });
  assert.equal(await tabs.open('/ohif/viewer?StudyInstanceUIDs=2.25.9000'), true); await settle();
  return async () => { assert.equal(await tabs.open('/ohif/viewer?StudyInstanceUIDs=2.25.7000'), true); await settle(); };
}

test('a 1×2 of the two parts of a split series comes back part by part with its image and display', async () => {
  const [b0, b1000] = splitSeries(), world = tabsWorld([b0, b1000]);
  world.grid(1, 2, [['left', b0, 3], ['right', b1000, 7]]);
  world.views.get('right').properties = { voiRange: { lower: 10, upper: 400 }, invert: true };
  world.views.get('left').camera = { parallelScale: 42, flipHorizontal: true };
  const back = await leaveAndReturn(world);
  try {
    await back();
    const cells = [...world.state.viewports.values()];
    assert.equal(world.state.layout.numCols, 2, 'the 1×2 returns');
    assert.deepEqual(cells.map(cell => cell.displaySetInstanceUIDs), [[b0.displaySetInstanceUID], [b1000.displaySetInstanceUID]],
      'each cell holds the part it held');
    const [left, right] = cells.map(cell => world.views.get(cell.viewportId));
    assert.equal(left.getCurrentImageId(), b0.images[3].imageId);
    assert.equal(right.getCurrentImageId(), b1000.images[7].imageId);
    assert.deepEqual(right.properties, { voiRange: { lower: 10, upper: 400 }, invert: true }, 'the display conditions return');
    assert.equal(left.camera.parallelScale, 42); assert.equal(left.camera.flipHorizontal, true);
  } finally { world.tabs.end(); }
});

test('a split series is not restored when the image a cell showed is in none of its parts', async () => {
  const [b0, b1000] = splitSeries(), world = tabsWorld([b0, b1000]);
  world.grid(1, 2, [['left', b0, 3], ['right', b1000, 7]]);
  const back = await leaveAndReturn(world);
  try {
    // The same series comes back split differently: neither part holds the image the left cell showed.
    const [again0, again1000] = splitSeries();
    const kept = again0.images.filter(image => image.imageId !== b0.images[3].imageId);
    world.replaceSets([Object.assign(Object.create(Object.getPrototypeOf(again0)), again0, { displaySetInstanceUID: 'ds-moved' }), again1000]);
    Object.defineProperty(world.services.displaySetService.getActiveDisplaySets()[0], 'images', { value: kept });
    const before = world.layouts.length;
    await back();
    assert.equal(world.layouts.length, before, 'no layout is restored');
    assert.equal(world.state.viewports.size, 1, 'the stock opening stays');
  } finally { world.tabs.end(); }
});

test('a series that is one display set still restores as before', async () => {
  const t2 = singleSeries('AX T2', '2.25.7101', 1), flair = singleSeries('AX FLAIR', '2.25.7102', 2);
  const world = tabsWorld([t2, flair]);
  world.grid(1, 2, [['left', t2, 2], ['right', flair, 9]]);
  const back = await leaveAndReturn(world);
  try {
    await back();
    const cells = [...world.state.viewports.values()];
    assert.deepEqual(cells.map(cell => cell.displaySetInstanceUIDs), [[t2.displaySetInstanceUID], [flair.displaySetInstanceUID]]);
    assert.deepEqual(cells.map(cell => world.views.get(cell.viewportId).getCurrentImageId()), [t2.images[2].imageId, flair.images[9].imageId]);
  } finally { world.tabs.end(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Prior images: the shipped viewer-prior extension over the shipped shell seam and prior controller.
async function priorWorld(currentSets) {
  const priors = priorSeries(), sets = [...currentSets, ...priors], subscribers = new Set();
  const byId = id => sets.find(set => set.displaySetInstanceUID === id);
  const state = { activeViewportId: 'v1', layout: { layoutType: 'grid', numRows: 1, numCols: 2 }, viewports: new Map([
    ['v1', { viewportId: 'v1', displaySetInstanceUIDs: [currentSets[0].displaySetInstanceUID], x: 0, y: 0, width: 0.5, height: 1 }],
    ['v2', { viewportId: 'v2', displaySetInstanceUIDs: [], x: 0.5, y: 0, width: 0.5, height: 1 }]]) };
  const grid = { EVENTS: { GRID_STATE_CHANGED: 'grid' }, getState: () => state, layouts: [],
    subscribe(_event, listener) { subscribers.add(listener); return { unsubscribe: () => subscribers.delete(listener) }; },
    setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs }) {
      state.viewports.set(viewportId, { ...state.viewports.get(viewportId), displaySetInstanceUIDs });
      for (const listener of [...subscribers]) listener();
    },
    setLayout(options) { grid.layouts.push(options); } };
  let metadata = () => Promise.resolve();
  const source = { retrieve: { series: { metadata: () => metadata() } }, deleteStudyMetadataPromise() {} };
  const services = { viewportGridService: grid,
    displaySetService: { EVENTS: {}, subscribe: () => ({ unsubscribe() {} }), getActiveDisplaySets: () => sets, getDisplaySetByUID: byId },
    cornerstoneViewportService: { EVENTS: {}, subscribe: () => ({ unsubscribe() {} }), getCornerstoneViewport: () => ({ type: 'stack' }) } };
  const frames = new Map(); let nextFrame = 0, studyActions, lists = [];
  const chrome = () => ({ refresh() {}, place() {}, adopt() {}, invalidate() {}, dispose() {} });
  const document = new EventTarget(), head = new Element('head');
  const sandbox = { document, console, URL, URLSearchParams, AbortController, Promise, structuredClone, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { observe() {} disconnect() {} },
    kinViewerOnEnd: () => null, kinViewerSession: { ended: () => false, readOnly: () => false },
    fetch: async path => {
      assert.equal(path, '/api/studies');
      return { ok: true, status: 200, json: async () => ({ studies: [
        { uid: '2.25.7000', sourcePatientKey: 'P', date: '20261110', modality: 'MR' },
        { uid: '2.25.8000', sourcePatientKey: 'P', date: '20250110', modality: 'MR' }] }) };
    } };
  sandbox.window = sandbox; sandbox.top = sandbox;
  Object.assign(document, { body: new Element('body'), head, createElement: tag => new Element(tag),
    getElementById: () => new Element(), querySelector: () => null, querySelectorAll: () => [] });
  // The extension loads its controller and panel as page scripts; the controller is the shipped file, the panel a recorder.
  head.append = function (...nodes) {
    Element.prototype.append.apply(this, nodes);
    for (const node of nodes) if (node.tag === 'script') queueMicrotask(() => {
      const name = node.src.split('/').pop();
      if (name === 'viewer-prior-controller.js') vm.runInContext(read(name), context);
      else sandbox.KinViewerPriorPanel = { list(_host, value, handlers) { lists.push({ value, handlers }); }, report() {} };
      node.onload();
    });
  };
  Object.assign(sandbox, {
    KinSessionTransport: { refusal: () => false, responseError: () => new Error('ended') },
    KinViewerPatientTabs: { snapshot: () => ({ key: 'P', sequence: 1, studyUIDs: ['2.25.7000'], patient: {} }),
      subscribe: () => () => {}, mount() {}, refresh() {}, dispose() {}, guard: () => true },
    // The info bar's identity: a cell names a clinical image only when it holds exactly one display set.
    KinViewerInfoBar: { mount(value) { studyActions = value.studyActions; return chrome(); },
      identity(_services, viewportId) {
        const cell = state.viewports.get(viewportId), ids = cell?.displaySetInstanceUIDs || [];
        const set = ids.length === 1 && byId(ids[0]);
        return { viewportId, cell, set, viewport: { type: 'stack' },
          instance: set ? { StudyInstanceUID: set.StudyInstanceUID, SeriesInstanceUID: set.SeriesInstanceUID } : null };
      } },
    KinViewerSeriesStrip: { mount: chrome }, cornerstone: { Enums: { Events: {} } },
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(read('viewer-hanging-settings.js'), context);
  vm.runInContext(read('viewer-ux-shell.js'), context);
  const shell = sandbox.KinViewerUXShell.mount({ services, session: { owner: () => null, readOnly: () => false } });
  const extension = vm.runInContext(priorSource + ';kinCreateViewerPrior()', context);
  extension.preRegistration({ servicesManager: { services }, extensionManager: { getActiveDataSource: () => [source] } });
  extension.onModeEnter();
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(sandbox.KinViewerUX && sandbox.KinViewerPriorController, 'the extension mounted on the shell seam');
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  const pane = new Element(); pane.setAttribute('data-cy', 'viewport-pane');
  const bar = new Element(); bar.className = 'kin-viewer-info-bar'; bar.offsetHeight = 20; pane.append(bar);
  const anchor = new Element('button'); bar.append(anchor);
  return { state, grid, priors, flush,
    holdMetadata() { let release; metadata = () => new Promise(resolve => { release = resolve; }); return () => release(); },
    put(viewportId, set) { grid.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [set.displaySetInstanceUID] }); flush(); },
    async listPriors() { studyActions.open('v1', anchor); await settle(); await settle(); return lists.at(-1); },
    placed: () => Array.from(state.viewports.get('v2').displaySetInstanceUIDs),
    end() { extension.onModeExit(); shell.dispose(); } };
}

test('the prior image is chosen for the part in the cell that opened the comparison', async () => {
  const [b0, b1000] = splitSeries();
  for (const [part, expected] of [[b0, 'AX DWI b0'], [b1000, 'AX DWI b1000']]) {
    const world = await priorWorld([b0, b1000]);
    try {
      world.put('v1', part);
      const list = await world.listPriors();
      assert.equal(list.value.state, 'ready');
      await list.handlers.openImages('2.25.8000'); await settle();
      const placed = world.placed().map(id => world.priors.find(set => set.displaySetInstanceUID === id)?.SeriesDescription);
      assert.deepEqual(placed, [expected], part.SeriesDescription + ' opens the prior ' + expected);
    } finally { world.end(); }
  }
});

test('a late prior answer is dropped after the cell moved to the other part and back (A→B→A)', async () => {
  const [b0, b1000] = splitSeries(), world = await priorWorld([b0, b1000]);
  try {
    const list = await world.listPriors(), release = world.holdMetadata();
    const opening = list.handlers.openImages('2.25.8000'); await settle();
    world.put('v1', b1000);
    world.put('v1', b0);
    release(); await opening; await settle();
    assert.deepEqual(world.placed(), [], 'the answer for the request started on the first visit is placed nowhere');
    assert.equal(world.grid.layouts.length, 0, 'no comparison layout is made');
  } finally { world.end(); }
});

test('a series that is one display set opens the same prior as before', async () => {
  const dwi = singleSeries('AX DWI b1000', '2.25.7201', 5), world = await priorWorld([dwi]);
  try {
    const list = await world.listPriors();
    await list.handlers.openImages('2.25.8000'); await settle();
    assert.deepEqual(world.placed(), [world.priors[1].displaySetInstanceUID]);
  } finally { world.end(); }
});

test('prior ranking: the part decides between the prior b0 and b1000 series', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('viewer-hanging-settings.js'), context);
  const { rank } = context.window.KinViewerHangingSettings, [b0, b1000] = splitSeries(), priors = priorSeries();
  assert.equal(rank(priors, b0)[0].SeriesDescription, 'AX DWI b0');
  assert.equal(rank(priors, b1000)[0].SeriesDescription, 'AX DWI b1000');
});

// ---------------------------------------------------------------------------------------------------------------
// The personal MR layout places the parts in order (viewer-hanging-settings.js, unchanged).
function personalLayout(displaySets, opened, priorPosition) {
  const protocols = [], hp = { run(_data, id) { return id; }, addProtocol(id, protocol) { protocols.push(protocol); } };
  const context = vm.createContext({ window: {}, location: { search: '?StudyInstanceUIDs=' + opened.join(',') }, URLSearchParams });
  vm.runInContext(read('viewer-hanging-settings.js'), context);
  const settings = { hanging: { MR: { layout: '1x2', priorPosition, seriesMatch: 'similar' } } };
  context.window.KinViewerHangingSettings.mount({ hangingProtocolService: hp }, () => settings);
  hp.run({ displaySets }, 'default', {});
  const selectors = protocols.at(-1).displaySetSelectors;
  return Object.keys(selectors).map(key => selectors[key].seriesMatchingRules[0].constraint.equals.value);
}

test('personal MR 1×2: the two parts of the first series fill the cells in order', () => {
  const [b0, b1000] = splitSeries(), later = singleSeries('AX T2', '2.25.7301', 8);
  assert.deepEqual(personalLayout([later, b0, b1000], ['2.25.7000'], 'right'), [b0.displaySetInstanceUID, b1000.displaySetInstanceUID]);
});

test('personal MR 1×2 with a prior: the first part and its prior follow the prior position', () => {
  const [b0, b1000] = splitSeries(), priors = priorSeries();
  assert.deepEqual(personalLayout([b0, b1000, ...priors], ['2.25.7000', '2.25.8000'], 'right'), [b0.displaySetInstanceUID, priors[0].displaySetInstanceUID]);
  assert.deepEqual(personalLayout([b0, b1000, ...priors], ['2.25.7000', '2.25.8000'], 'left'), [priors[0].displaySetInstanceUID, b0.displaySetInstanceUID]);
});
