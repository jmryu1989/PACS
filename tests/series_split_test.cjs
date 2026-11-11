// REQ-FB-052 (one MR series holding several sequences/time points opens as one virtual series per group)
// -> RISK-SPLIT-LOST/DUPLICATED/WRONG-LABEL/DOUBLE-SPLIT -> TEST-SERIES-SPLIT.
// The shipped series-split extension runs against the pinned viewer's stack handler and its own 4D detection
// (tests/fixtures/ohif_stack_4d.cjs), next to the shipped cine and mammography hooks on the same handler.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { STACK, createStackHandler, mixedSeries } = require('./fixtures/ohif_stack_4d.cjs');

const shipped = fs.readFileSync('config/ohif.js', 'utf8');
const source = fs.readFileSync('config/ohif/series-split.js', 'utf8');
const cineSource = shipped.slice(shipped.indexOf('function kinCineWithinBudget('), shipped.indexOf('function kinApplyCTPreset('));
const mgSource = fs.readFileSync('config/ohif/mammography-hanging.js', 'utf8');
const model = vm.runInNewContext(source + ';kinSeriesSplitModel');

// Arrays made inside the vm context have that context's prototypes; compare them as plain outer arrays.
const sops = set => Array.from(set.images, i => i.SOPInstanceUID);
const describe = sets => Array.from(sets, s => [s.SeriesDescription, s.images.length]);
const descriptions = sets => Array.from(sets, s => s.SeriesDescription);
// Every input image appears in exactly one output set.
function assertPartition(sets, instances) {
  const all = sets.flatMap(sops);
  assert.equal(new Set(all).size, all.length, 'no image in two sets');
  assert.deepEqual([...all].sort(), instances.map(i => i.SOPInstanceUID).sort(), 'no image missing');
}

test('the viewer configuration ships the extension once, in the stack handler extension list', () => {
  assert.ok(shipped.includes(source), 'config/ohif.js carries config/ohif/series-split.js');
  assert.equal(shipped.split('function kinCreateSeriesSplit(').length - 1, 1);
  assert.equal(shipped.split('kinCreateSeriesSplit(), ').length - 1, 1);
  assert.match(shipped, /kinCreateMammographyHanging\(\), kinCreateSeriesSplit\(\), kinCreateMGReferenceLines\(\)/);
});

test('b0 and b1000 mixed in one MR series become two sets, each one value at every position', () => {
  const handler = createStackHandler(), instances = mixedSeries();
  const sets = model(handler.getDisplaySetsFromSeries(instances), list => handler.getDisplaySetsFromSeries(list));
  assert.deepEqual(describe(sets), [['AX DWI · 1/2 b0', 12], ['AX DWI · 2/2 b1000', 12]]);
  assertPartition(sets, instances);
  for (const [k, value] of [[0, 0], [1, 1000]]) {
    assert.ok(sets[k].images.every(i => i.DiffusionBValue === value));
    assert.deepEqual(sets[k].images.map(i => i.ImagePositionPatient[2]), Array.from({ length: 12 }, (_, p) => p * 4));
    assert.equal(sets[k].isDynamicVolume, false, 'each set is an ordinary stack');
    assert.equal(sets[k].SeriesInstanceUID, '2.25.7001');
    assert.equal(sets[k].SeriesNumber, 5);
  }
  // The original images are the same objects, not copies, and keep their own description.
  assert.ok(sets[1].images.every(i => instances.includes(i) && i.SeriesDescription === 'AX DWI'));
});

test('three temporal positions keep the viewer\'s ascending order and equal counts', () => {
  const handler = createStackHandler();
  const instances = mixedSeries({ tag: 'TemporalPositionIdentifier', values: [3, 1, 2], positions: 10, description: 'DYN T1' });
  const sets = model(handler.getDisplaySetsFromSeries(instances), list => handler.getDisplaySetsFromSeries(list));
  assert.deepEqual(describe(sets), [['DYN T1 · 1/3 Phase 1', 10], ['DYN T1 · 2/3 Phase 2', 10], ['DYN T1 · 3/3 Phase 3', 10]]);
  assertPartition(sets, instances);
});

test('a series that is not a recognised MR time point mix keeps the result it was given', () => {
  const handler = createStackHandler(), rebuild = list => handler.getDisplaySetsFromSeries(list);
  const cases = {
    'not MR': () => handler.getDisplaySetsFromSeries(mixedSeries({ modality: 'CT' })),
    'not dynamic': () => handler.getDisplaySetsFromSeries(mixedSeries({ values: [1000] })),
    'groups are not the set\'s images one to one': () => {
      const sets = handler.getDisplaySetsFromSeries(mixedSeries()), groups = sets[0].dynamicVolumeInfo.timePoints;
      groups[1][0] = groups[0][0];
      return sets;
    },
    'a group names an image outside the set': () => {
      const sets = handler.getDisplaySetsFromSeries(mixedSeries());
      sets[0].dynamicVolumeInfo.timePoints[1][0] = 'wadors:/elsewhere';
      return sets;
    },
    'groups of different sizes': () => {
      const sets = handler.getDisplaySetsFromSeries(mixedSeries()), groups = sets[0].dynamicVolumeInfo.timePoints;
      groups[0].push(groups[1].pop());
      return sets;
    },
    'more than one display set': () => handler.getDisplaySetsFromSeries([...mixedSeries(),
      { ...mixedSeries()[0], SOPInstanceUID: 'mf', imageId: 'wadors:/mf', NumberOfFrames: 4 }]),
  };
  for (const [name, make] of Object.entries(cases)) {
    const given = make(), before = given.map(s => [s.SeriesDescription, sops(s)]);
    const result = model(given, rebuild);
    assert.equal(result, given, name);
    assert.deepEqual(result.map(s => [s.SeriesDescription, sops(s)]), before, name);
  }
});

test('if any group does not come back as one stack, the first result stands unchanged', () => {
  const handler = createStackHandler(), instances = mixedSeries();
  for (const broken of [
    list => [...handler.getDisplaySetsFromSeries(list.slice(0, 6)), ...handler.getDisplaySetsFromSeries(list.slice(6))],
    () => [],
    list => handler.getDisplaySetsFromSeries(list.slice(1)),
    () => { throw new Error('handler refused'); },
  ]) {
    let calls = 0;
    const given = handler.getDisplaySetsFromSeries(instances);
    const result = model(given, list => ++calls === 2 ? broken(list) : handler.getDisplaySetsFromSeries(list));
    assert.equal(result, given);
    assert.deepEqual(describe(result), [['AX DWI', 24]]);
  }
});

test('labels name the value the viewer split by, read from the first image of each set', () => {
  const handler = createStackHandler(), split = instances =>
    descriptions(model(handler.getDisplaySetsFromSeries(instances), list => handler.getDisplaySetsFromSeries(list)));
  assert.deepEqual(split(mixedSeries({ tag: 'DiffusionBValue', values: [0, 1000] })), ['AX DWI · 1/2 b0', 'AX DWI · 2/2 b1000']);
  assert.deepEqual(split(mixedSeries({ tag: 'TemporalPositionIdentifier', values: [1, 2] })), ['AX DWI · 1/2 Phase 1', 'AX DWI · 2/2 Phase 2']);
  assert.deepEqual(split(mixedSeries({ tag: 'TriggerTime', values: [150, 300.5] })), ['AX DWI · 1/2 TT 150', 'AX DWI · 2/2 TT 300.5']);
  assert.deepEqual(split(mixedSeries({ tag: 'EchoTime', values: [12, 90] })), ['AX DWI · 1/2 TE 12', 'AX DWI · 2/2 TE 90']);
  assert.deepEqual(split(mixedSeries({ tag: 'EchoNumber', values: [1, 2] })), ['AX DWI · 1/2 Echo 1', 'AX DWI · 2/2 Echo 2']);
  // Metadata that names the element by its keyword (Echo Numbers) also labels an echo split.
  const echoes = mixedSeries({ tag: 'EchoNumber', values: [1, 2], patch: (i, _, v) => { i.EchoNumbers = [v]; } });
  const echoSets = handler.getDisplaySetsFromSeries(echoes);
  echoes.forEach(i => delete i.EchoNumber);
  assert.deepEqual(descriptions(model(echoSets, list => handler.getDisplaySetsFromSeries(list))),
    ['AX DWI · 1/2 Echo 1', 'AX DWI · 2/2 Echo 2']);
  // b0 images that do not carry the element: the viewer still groups them as 0, the label has no value to show.
  assert.deepEqual(split(mixedSeries({ patch: (i, _, v) => { if (v === 0) delete i.DiffusionBValue; } })),
    ['AX DWI · 1/2', 'AX DWI · 2/2 b1000']);
  // A split tag the label does not read (a vendor private b value) shows only the position in the series.
  const sets = handler.getDisplaySetsFromSeries(mixedSeries());
  sets[0].dynamicVolumeInfo.splittingTag = 'PhilipsPrivateBValue';
  assert.deepEqual(descriptions(model(sets, list => handler.getDisplaySetsFromSeries(list))), ['AX DWI · 1/2', 'AX DWI · 2/2']);
  // No series description: the label stands alone.
  assert.deepEqual(split(mixedSeries({ description: '' })), ['1/2 b0', '2/2 b1000']);
});

// ---- The three hooks on one stack handler ----

class Element {
  constructor(tagName = 'DIV') {
    this.tagName = tagName; this.style = {}; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {};
    this.className = ''; this.text = ''; this.hidden = false; this.offsetHeight = 0;
  }
  get textContent() { return this.text; } set textContent(v) { this.children = []; this.text = v; }
  append(...items) { for (const c of items) { if (typeof c === 'object') { c.parent = this; this.children.push(c); c.onload?.(); } } }
  setAttribute(k, v) { this.attributes[k] = v; } getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  querySelector() { return null; } querySelectorAll() { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
}
class DeferredPromise {
  setProcessFunction(fn) { this.processFunction = fn; }
  start() {
    if (this.internalPromise) return this.internalPromise;
    this.internalPromise = this.processFunction();
    if (this.thenFunction) { this.then(this.thenFunction); this.thenFunction = undefined; }
    return this.internalPromise;
  }
  then(fn) { if (this.internalPromise) return this.internalPromise.then(fn); this.thenFunction = fn; }
}
const mgCases = require('./fixtures/mg_vendor_cases.json').cases;
// Three Siemens CT-format breast slices (Modality MG), stored out of position order.
function mgSlices() {
  return [2, 0, 1].map((position, i) => {
    const d = structuredClone(mgCases.find(c => c.id === 'siemens-ct-tomo12').dicom);
    d['00080018'].Value[0] += '.' + (position + 1);
    d['00200032'].Value[2] = position;
    d['00200013'] = { vr: 'IS', Value: [i + 1] };
    return d;
  });
}
// Position order along the plane normal (row x column), as the mammography hook orders a slice series.
function mgPositionOrder() {
  const items = mgSlices(), o = items[0]['00200037'].Value, r = o.slice(0, 3), c = o.slice(3);
  const normal = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
  const along = d => d['00200032'].Value.reduce((n, x, i) => n + x * normal[i], 0);
  return items.sort((a, b) => along(a) - along(b)).map(d => d['00080018'].Value[0]);
}
const naturalize = d => ({ SOPInstanceUID: d['00080018'].Value[0], SeriesInstanceUID: d['0020000E'].Value[0],
  StudyInstanceUID: d['0020000D'].Value[0], Modality: d['00080060'].Value[0], SOPClassUID: d['00080016'].Value[0],
  InstanceNumber: d['00200013']?.Value?.[0], NumberOfFrames: d['00280008']?.Value?.[0], imageId: 'wadors:/' + d['00080018'].Value[0] });

async function viewer() {
  const handler = createStackHandler(), native = handler.getDisplaySetsFromSeries, body = new Element('BODY');
  const document = { head: new Element('HEAD'), body, hidden: false, createElement: tag => new Element(tag.toUpperCase()),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} };
  const subscription = () => ({ unsubscribe() {} });
  const services = {
    displaySetService: { getActiveDisplaySets: () => [] },
    cineService: { EVENTS: { CINE_STATE_CHANGED: 'cine' }, getState: () => ({ isCineEnabled: false, cines: {} }),
      playClip() {}, stopClip() {}, setCine() {}, subscribe: subscription },
    viewportGridService: { EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'active', GRID_STATE_CHANGED: 'grid' },
      getActiveViewportId: () => null, getState: () => ({ viewports: new Map(), activeViewportId: null }),
      setActiveViewportId() {}, setDisplaySetsForViewports() {}, subscribe: subscription },
    cornerstoneViewportService: { getCornerstoneViewport: () => undefined },
    hangingProtocolService: { getState: () => null, addProtocol() {}, run() {} },
  };
  const items = mgSlices(), loaded = [];
  const dataSource = { retrieve: { series: { metadata: async () => {
    const p = new DeferredPromise();
    p.metadata = { Modality: 'MG' };
    p.setProcessFunction(() => Promise.resolve(items));
    p.then(list => loaded.push(...handler.getDisplaySetsFromSeries(list.map(naturalize))));
    return [p];
  } } } };
  const extensionManager = { getModuleEntry: id => id === STACK ? handler : undefined, getActiveDataSource: () => [dataSource] };
  const window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    KinMammographyModel: require('../worklist-v0/hpacs-lite/mammography-model.js'),
    cornerstone: { Enums: { Events: { STACK_NEW_IMAGE: 'image', VIEWPORT_NEW_IMAGE_SET: 'stack' } } } };
  const study = items[0]['0020000D'].Value[0];
  const context = vm.createContext({ window, document, URL, URLSearchParams, JSON, Math, Number, Error, performance: {},
    fetch: async () => ({ ok: true, json: async () => ({ institution: 'SYNTHETIC' }) }), AbortController,
    location: { search: '?StudyInstanceUIDs=' + study, href: 'https://localhost/ohif/viewer?StudyInstanceUIDs=' + study },
    MutationObserver: class { observe() {} disconnect() {} }, kinViewerSession: { sameAccount: () => true },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(cineSource + mgSource + source, context);
  const hooks = {
    cine: vm.runInContext('kinCreateCine()', context),
    mg: vm.runInContext('kinCreateMammographyHanging()', context),
    split: vm.runInContext('kinCreateSeriesSplit()', context),
  };
  for (const hook of Object.values(hooks)) await hook.preRegistration({ servicesManager: { services }, extensionManager });
  return {
    handler, native, hooks,
    enter: name => hooks[name].onModeEnter(), exit: name => hooks[name].onModeExit(),
    open: instances => handler.getDisplaySetsFromSeries(instances),
    // The data source path the mammography hook reads its headers from.
    async openMG() { loaded.length = 0; const loads = await dataSource.retrieve.series.metadata(); await Promise.all(loads.map(p => p.start())); return loaded.slice(); },
  };
}

const cineInstance = () => [{ imageId: 'wadors:/cine', SOPInstanceUID: 'cine.1', SeriesInstanceUID: '2.25.8', StudyInstanceUID: '2.25.7000',
  Modality: 'US', NumberOfFrames: 30, RecommendedDisplayFrameRate: 25, InstanceNumber: 1 }];

async function assertAllAlive(v, label) {
  const mr = mixedSeries();
  assert.deepEqual(describe(v.open(mr)), [['AX DWI · 1/2 b0', 12], ['AX DWI · 2/2 b1000', 12]], label + ': split');
  assert.equal(v.open(cineInstance())[0].FrameRate, 40, label + ': cine rate');
  const mg = await v.openMG();
  assert.equal(mg.length, 1, label + ': mammography slices become one stack');
  assert.deepEqual(Array.from(mg[0].images, i => i.SOPInstanceUID), mgPositionOrder(), label + ': position order');
}

for (const order of [['cine', 'mg', 'split'], ['cine', 'split', 'mg'], ['mg', 'cine', 'split'],
  ['mg', 'split', 'cine'], ['split', 'cine', 'mg'], ['split', 'mg', 'cine']]) {
  test(`mounted ${order.join(' > ')}, all three hooks work and exits in any order end the split`, async () => {
    const v = await viewer();
    order.forEach(v.enter);
    await assertAllAlive(v, order.join('>'));
    // Leave in mount order: the earlier hooks are not on top and stay in the chain.
    order.forEach(v.exit);
    assert.deepEqual(describe(v.open(mixedSeries())), [['AX DWI', 24]], 'an ended split hook passes the series on');
    const left = v.handler.getDisplaySetsFromSeries;
    // Coming back wraps on top of whatever is left; still one split per series.
    order.forEach(v.enter);
    await assertAllAlive(v, 're-entered ' + order.join('>'));
    [...order].reverse().forEach(v.exit);
    assert.equal(v.handler.getDisplaySetsFromSeries, left, 'leaving in reverse order unwinds exactly what this visit added');
    assert.deepEqual(describe(v.open(mixedSeries())), [['AX DWI', 24]]);
  });
}

test('entering and leaving repeatedly never splits a split set again', async () => {
  const v = await viewer(), instances = mixedSeries({ tag: 'TemporalPositionIdentifier', values: [1, 2, 3], positions: 10 });
  for (let round = 0; round < 4; round++) {
    v.enter('split');
    if (round % 2) v.enter('cine');
    const sets = v.open(instances);
    assert.deepEqual(describe(sets), [['AX DWI · 1/3 Phase 1', 10], ['AX DWI · 2/3 Phase 2', 10], ['AX DWI · 3/3 Phase 3', 10]], 'round ' + round);
    assertPartition(sets, instances);
    v.exit('split');
    if (round % 2) v.exit('cine');
  }
  // Mounting twice without leaving replaces the first wrapper instead of stacking two.
  v.enter('split'); v.enter('split');
  assert.deepEqual(describe(v.open(instances)).map(([, n]) => n), [10, 10, 10]);
  v.exit('split');
  assert.deepEqual(describe(v.open(instances)), [['AX DWI', 30]], 'after leaving, ended hooks left in the chain pass the series on');
});

test('a split hook left inside the chain after its mode ended does not split', async () => {
  const v = await viewer();
  v.enter('split'); v.enter('cine');
  v.exit('split');
  assert.notEqual(v.handler.getDisplaySetsFromSeries, v.native, 'cine still wraps the ended split hook');
  assert.deepEqual(describe(v.open(mixedSeries())), [['AX DWI', 24]]);
  assert.equal(v.open(cineInstance())[0].FrameRate, 40, 'cine still works');
  v.exit('cine');
});
