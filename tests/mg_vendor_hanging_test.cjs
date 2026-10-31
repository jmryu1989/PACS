// REQ-MG-VENDOR-HANG/VOI -> RISK-MG-OMITTED-SLICES/WRONG-VOI -> TEST-MG-VENDOR-HANG.
// REQ-MG-04-REPEAT -> RISK-MG-REPEAT-HIDDEN -> TEST-MG-VENDOR-HANG (repeat exposure case).
// Runs the shipped extension against its OHIF service/viewport interfaces. GPU/HTTP remain served checks.
// The OHIF side below reproduces the pinned viewer's (orthancteam/orthanc:24.12.0 libOrthancOHIF.so) display-set
// path: DeferredPromise keeps the store callback registered before start() and runs it first; the store builds
// display sets at once through the stack SOP class handler, which gives each Modality MG/CR/DX instance its own
// ImageSet; ImageSet.images is a non-writable property holding the same array as `instances`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../worklist-v0/hpacs-lite/mammography-model.js');
const cases = require('./fixtures/mg_vendor_cases.json').cases;
const fixture = id => structuredClone(cases.find(c => c.id === id).dicom);
const plain = x => JSON.parse(JSON.stringify(x));
const STACK = '@ohif/extension-default.sopClassHandlerModule.stack';
const LUT = [0, 512, 4096, 16000, 32000, 50000, 62000, 65535];

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
class ImageSet {
  constructor(images) {
    Object.defineProperty(this, 'images', { enumerable: false, configurable: false, writable: false, value: images });
    this.instances = images; this.instance = images[0];
  }
  setAttributes(attributes) { Object.assign(this, attributes); }
}
let uid = 0;
const createStackHandler = () => ({
  sopClassUids: [],
  getDisplaySetsFromSeries(instances) {
    const sets = [], stackable = [];
    const make = list => { const set = new ImageSet(list); set.setAttributes({ displaySetInstanceUID: 'ds-' + ++uid,
      StudyInstanceUID: list[0].StudyInstanceUID, SeriesInstanceUID: list[0].SeriesInstanceUID, Modality: list[0].Modality, numImageFrames: list.length });
      set.images.sort((a, b) => (a.InstanceNumber || 0) - (b.InstanceNumber || 0)); return set; };
    for (const instance of instances) {
      if (instance.NumberOfFrames > 1 || ['CR', 'MG', 'DX'].includes(instance.Modality)) sets.push(make([instance]));
      else stackable.push(instance);
    }
    if (stackable.length) sets.push(make(stackable));
    return sets;
  },
});
const naturalize = d => ({ SOPInstanceUID: d['00080018'].Value[0], SeriesInstanceUID: d['0020000E'].Value[0],
  StudyInstanceUID: d['0020000D'].Value[0], Modality: d['00080060'].Value[0], SOPClassUID: d['00080016'].Value[0],
  InstanceNumber: d['00200013']?.Value?.[0], NumberOfFrames: d['00280008']?.Value?.[0] });

// The selector forms the viewer's DOM is queried with: tag, .class, [attr="value"] and [class~="token"].
// Setting textContent replaces the element's children, as in the DOM.
class Element {
  constructor(className = '', tagName = 'DIV') {
    this.className = className; this.tagName = tagName; this.style = {}; this.children = []; this.text = ''; this.attributes = {};
    this.dataset = {}; this.listeners = {};
  }
  get textContent() { return this.text; }
  set textContent(value) { this.children.forEach(c => { c.parent = null; }); this.children = []; this.text = value; }
  append(...children) { for (const c of children) { c.parent = this; this.children.push(c); c.onload?.(); } }
  setAttribute(k, v) { this.attributes[k] = v; } getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { const event = { stopPropagation() {} }; (this.listeners.click || []).forEach(fn => fn(event)); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  remove() { this.parent && (this.parent.children = this.parent.children.filter(c => c !== this)); this.parent = null; }
  getBoundingClientRect() { return this.rect || { top: 0, left: 0 }; }
  matches(selector) {
    const cls = /^\.(\S+)$/.exec(selector), attr = /^\[([\w-]+)(~?)="([^"]*)"\]$/.exec(selector);
    if (cls) return this.className.split(' ').includes(cls[1]);
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
    if (!attr) throw new Error('unsupported selector ' + selector);
    const value = attr[1] === 'class' ? this.className : this.getAttribute(attr[1]);
    return attr[2] ? (value || '').split(' ').includes(attr[3]) : value === attr[3];
  }
  querySelectorAll(selector) { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
// What a pane puts on screen: the text of everything inside it.
const paneText = el => [el.textContent, ...el.children.map(paneText)].filter(Boolean).join(' | ');

// The pinned Orthanc DICOMweb plugin (AcceptBulkData in WadoRs.cpp) serves bulk data only as multipart/related of
// application/octet-stream, and when no Accept is given; any other Accept, a bare application/octet-stream included,
// is answered 400 (measured on the served stack at 17b5428).
function orthancBulkAccept(accept) {
  if (accept === undefined) return true;
  const [media, ...params] = String(accept).split(';').map(s => s.trim());
  if (media.toLowerCase() !== 'multipart/related') return false;
  const type = params.map(p => p.split('=')).find(([k]) => k.trim().toLowerCase() === 'type')?.[1];
  return type === undefined || type.trim().replace(/^"|"$/g, '') === 'application/octet-stream';
}

async function mount(items, { routes = {}, opened = null } = {}) {
  const listeners = new Map(), panel = new Element(), requests = [];
  const body = new Element();
  const document = { head: new Element(), body, createElement: tag => new Element('', tag.toUpperCase()),
    querySelector: s => s === '#kin-viewer-layout' ? panel : body.querySelector(s), querySelectorAll: s => body.querySelectorAll(s),
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let grid = new Map(), active = null;
  const gridListeners = new Set(), gridChanged = () => gridListeners.forEach(fn => fn());
  let state, protocol, current = 0, renderCount = 0;
  const points = [], properties = [], ranges = [], element = new Element();
  const transfer = { removeAllPoints() { points.length = 0; }, addRGBPoint(...point) { points.push(point); } };
  const viewport = { type: 'stack', element, getCurrentImageId: () => 'frame-' + current, getCurrentImageIdIndex: () => current,
    getCamera: () => ({}), setCamera() {}, getDefaultActor: () => ({ actor: { getProperty: () => ({ getRGBTransferFunction: () => transfer }) } }),
    setProperties: p => properties.push(plain(p)), setVOI: (r, options) => { ranges.push(plain(r)); if (options.forceRecreateLUTFunction) points.length = 0; },
    render: () => renderCount++ };
  const hp = { getState: () => state, addProtocol: (_, p) => { protocol = p; },
    run: (_, id, options) => { state = { protocolId: id, stageIndex: options?.stageIndex }; } };
  const services = { hangingProtocolService: hp, viewportGridService: { EVENTS: { GRID_STATE_CHANGED: 'grid' },
    getState: () => ({ viewports: grid, activeViewportId: active }), setActiveViewportId: id => { active = id; },
    // SET_DISPLAYSETS_FOR_VIEWPORTS, then GRID_STATE_CHANGED; the reducer refuses a missing viewport id.
    setDisplaySetsForViewports: list => {
      grid = new Map(grid);
      for (const { viewportId, displaySetInstanceUIDs } of list) {
        if (!grid.has(viewportId)) throw new Error('ViewportId is required to set display sets for viewport');
        grid.set(viewportId, { ...grid.get(viewportId), displaySetInstanceUIDs });
      }
      gridChanged();
    },
    subscribe: (_, fn) => { gridListeners.add(fn); return { unsubscribe: () => gridListeners.delete(fn) }; } },
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport } };
  const modules = { [STACK]: createStackHandler() }, displaySets = [];
  const extensionManager = { getActiveDataSource: () => [source], getModuleEntry: id => modules[id] };
  // dicomweb retrieve.series.metadata({ returnPromises: true }): one deferred load per series, store callback first.
  const source = { retrieve: { series: { metadata: async () => {
    const bySeries = new Map();
    for (const d of items) bySeries.set(d['0020000E'].Value[0], [...(bySeries.get(d['0020000E'].Value[0]) || []), d]);
    return [...bySeries.values()].map(list => {
      const p = new DeferredPromise();
      p.metadata = { Modality: list[0]['00080060'].Value[0] };
      p.setProcessFunction(() => Promise.resolve(list));
      p.then(loaded => displaySets.push(...extensionManager.getModuleEntry(STACK).getDisplaySetsFromSeries(loaded.map(naturalize))));
      return p;
    });
  } } } };
  const study = items[0]['0020000D'].Value[0];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/me') return { ok: true, json: async () => ({ institution: 'SYNTHETIC' }) };
    const route = routes[url];
    if (route && !orthancBulkAccept(options?.headers?.Accept)) return { ok: false, status: 400, headers: { get: () => 'text/plain' } };
    return route ? { ok: true, headers: { get: () => route.type }, arrayBuffer: async () => route.body.buffer.slice(route.body.byteOffset, route.body.byteOffset + route.body.byteLength) }
      : { ok: false, headers: { get: () => '' } };
  };
  const uids = (opened || [study]).join(',');
  const window = { KinMammographyModel: model, cornerstone: { Enums: { Events: { STACK_NEW_IMAGE: 'image', VIEWPORT_NEW_IMAGE_SET: 'stack' } },
    metaData: { get: () => ({ SOPInstanceUID: shown()['00080018'].Value[0], SeriesInstanceUID: shown()['0020000E'].Value[0] }) } } };
  const context = vm.createContext({ document, URL, URLSearchParams, fetch,
    location: { search: '?StudyInstanceUIDs=' + uids, href: 'https://localhost:9443/ohif/viewer?StudyInstanceUIDs=' + uids },
    MutationObserver: class { observe() {} disconnect() {} }, kinViewerSession: { sameAccount: () => true }, window });
  let order = items;
  const shown = () => order[current];
  vm.runInContext(fs.readFileSync('config/ohif/mammography-hanging.js', 'utf8'), context);
  const extension = vm.runInContext('kinCreateMammographyHanging()', context);
  await extension.preRegistration({ servicesManager: { services }, extensionManager });
  extension.onModeEnter();
  const loads = await source.retrieve.series.metadata();
  await Promise.all(loads.map(p => p.start()));
  return { hp, study, items, extension, points, properties, ranges, element, displaySets, requests, body,
    protocol: () => protocol, state: () => state, renderCount: () => renderCount,
    // The layout and image type controls write through the preference interface the extension publishes.
    preferences: () => window.kinMammographyHanging,
    run() { hp.run({ displaySets }, 'default', {}); },
    // viewportGridService publishes GRID_STATE_CHANGED after every viewport assignment.
    setGrid(viewports) { grid = new Map(viewports.map(v => [v.viewportId, v])); gridChanged(); },
    grid: () => grid, activate(id) { active = id; },
    // The pinned viewer's SET_LAYOUT: a hanging protocol passes no active viewport, so determineActiveViewportId
    // takes the first new cell when none was active, otherwise the first new cell that shows an image, else null.
    layout(viewports) {
      const next = new Map(viewports.map(v => [v.viewportId, v]));
      active = !grid.has(active) ? viewports[0].viewportId : viewports.find(v => v.displaySetInstanceUIDs.length)?.viewportId ?? null;
      grid = next; gridChanged();
    },
    // The study browser's thumbnail double-click fills the active viewport. The MG stages allow unmatched views, so
    // getViewportsRequireUpdate returns its default, and the SET_DISPLAYSETS_FOR_VIEWPORTS reducer refuses a missing id.
    doubleClick(displaySetInstanceUID) {
      const viewportId = active;
      if (!viewportId) throw new Error('ViewportId is required to set display sets for viewport');
      grid = new Map(grid).set(viewportId, { ...grid.get(viewportId), displaySetInstanceUIDs: [displaySetInstanceUID] });
      gridChanged();
    },
    selected(key) { return protocol.displaySetSelectors[key].seriesMatchingRules[0].constraint.equals.value; },
    show(index, type = 'image', list = items) { order = list; current = index; listeners.get(type)({ type, detail: { viewportId: 'test' } }); } };
}

// Three CT-format slices of one series, stored and numbered out of position order.
function ctSlices(modality = 'MG') {
  return [2, 0, 1].map((position, i) => {
    const d = fixture('siemens-ct-tomo12');
    d['00080018'].Value[0] += '.' + (position + 1);
    d['00080060'].Value[0] = modality;
    d['00200032'].Value[2] = position;
    d['00200013'] = { vr: 'IS', Value: [i + 1] };
    return d;
  });
}

for (const modality of ['MG', 'CT']) test(`Siemens CT-format slices with Modality ${modality} become one OHIF display set in position order`, async () => {
  const items = ctSlices(modality);
  const h = await mount(items);
  assert.equal(h.displaySets.length, 1, 'one display set for the slice series');
  // Position order along the plane normal (row x column), the same walk as a multiframe DBT object.
  const [r, c] = [items[0]['00200037'].Value.slice(0, 3), items[0]['00200037'].Value.slice(3)];
  const normal = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
  const along = d => d['00200032'].Value.reduce((n, x, i) => n + x * normal[i], 0);
  const [set] = h.displaySets, byPosition = items.slice().sort((a, b) => along(a) - along(b));
  assert.deepEqual(set.images.map(i => i.SOPInstanceUID), byPosition.map(d => d['00080018'].Value[0]));
  assert.equal(set.instances, set.images, 'images and instances stay the same OHIF array');
  assert.equal(Object.getOwnPropertyDescriptor(set, 'images').writable, false);
  assert.equal(set.numImageFrames, 3);
  h.run();
  assert.match(h.state().protocolId, /^kin.mammography/);
  assert.equal(h.selected('current|R|CC|dbt'), set.displaySetInstanceUID);
  h.show(0, 'image', byPosition);
  assert.deepEqual(h.ranges.at(-1), { lower: 83, upper: 1382 }); // DICOM LINEAR, WC=733/WW=1300
  assert.ok(h.renderCount() > 0);
  h.extension.onModeExit();
});

test('a slice series that is not one verified stack keeps OHIF\'s own display sets and is not hung', async () => {
  for (const change of [
    items => { items[1]['00200052'].Value = ['2.25.999']; },
    items => { items[2]['00200032'].Value[2] = 0; },
    items => { items[0]['00080008'].Value[3] = 'LEFT'; },
  ]) {
    const items = ctSlices(); change(items);
    const h = await mount(items);
    assert.equal(h.displaySets.length, 3, 'Modality MG stays one display set per instance');
    h.run();
    assert.equal(h.selected('current|R|CC|dbt'), '');
    h.extension.onModeExit();
  }
});

test('a partial slice display set cannot satisfy the full stack', async () => {
  const h = await mount(ctSlices());
  const [set] = h.displaySets;
  h.hp.run({ displaySets: [{ ...set, images: set.images.slice(0, 1), displaySetInstanceUID: 'partial' }] }, 'default', {});
  assert.equal(h.selected('current|R|CC|dbt'), '');
  h.extension.onModeExit();
});

// OHIF renders a Cornerstone element ([data-viewport-uid]) only inside a pane that has an image; an empty
// pane is just its grid wrapper. Opening a series into an empty slot adds that element to the same wrapper.
test('a pane opened by the reader into an empty slot no longer shows that slot\'s Missing label', async () => {
  const h = await mount(ctSlices()); // R CC DBT only: the other three DBT views are missing
  h.run();
  const stage = h.protocol().stages[h.state().stageIndex], { columns } = stage.viewportStructure.properties;
  const keys = stage.viewports.map(v => v.displaySets[0].id);
  const panes = keys.map((_, i) => Object.assign(new Element('relative group/pane'), { rect: { top: Math.floor(i / columns), left: i % columns } }));
  h.body.append(...panes.slice().reverse()); // DOM order is not grid order
  const viewports = keys.map((key, i) => ({ viewportId: 'vp-' + i, x: i % columns, y: Math.floor(i / columns),
    displaySetInstanceUIDs: h.selected(key) ? [h.selected(key)] : [] }));
  const open = i => { const element = new Element(); element.setAttribute('data-viewport-uid', 'vp-' + i); panes[i].append(element); };
  viewports.forEach((v, i) => v.displaySetInstanceUIDs.length && open(i));
  h.setGrid(viewports);
  const hung = keys.findIndex(key => h.selected(key)), empty = keys.map((key, i) => i).filter(i => !h.selected(keys[i]));
  assert.equal(empty.length, 3);
  assert.match(paneText(panes[hung]), /^Current · R CC · [^|]*$/);
  for (const i of empty) assert.match(paneText(panes[i]), /^Current · [LR] (CC|MLO) · .* · Missing$/);

  const [target, ...rest] = empty, before = paneText(panes[rest[0]]);
  viewports[target] = { ...viewports[target], displaySetInstanceUIDs: [h.displaySets[0].displaySetInstanceUID] };
  open(target);
  h.setGrid(viewports);
  assert.equal(paneText(panes[target]), '', 'no slot label over an image that does not fill that slot');
  for (const i of rest) assert.match(paneText(panes[i]), /· Missing$/);
  assert.equal(paneText(panes[rest[0]]), before);
  assert.match(paneText(panes[hung]), /^Current · R CC · [^|]*$/);
  h.extension.onModeExit();
  assert.equal(panes.map(paneText).join(''), '', 'mode exit removes every slot label');
});

// Two R CC Conventional images of one study fill the same slot. They carry no exposure time and the same
// Instance Number, so neither is the latest and the hanging places no image anywhere.
test('a thumbnail double-click opens the series in a cell when the MG hanging places no image', async () => {
  const a = fixture('siemens-2d-12-1'), b = fixture('siemens-2d-12-2');
  b['0020000D'] = structuredClone(a['0020000D']);
  const h = await mount([a, b]);
  // OHIF's default protocol lays out its own grid before the MG protocol replaces it.
  h.layout([{ viewportId: 'default-0', x: 0, y: 0, displaySetInstanceUIDs: [h.displaySets[0].displaySetInstanceUID] }]);
  h.run();
  const stage = h.protocol().stages[h.state().stageIndex], { columns } = stage.viewportStructure.properties;
  const keys = stage.viewports.map(v => v.displaySets[0].id);
  assert.ok(keys.every(key => !h.selected(key)), 'no cell is hung');
  h.layout(keys.map((key, i) => ({ viewportId: 'vp-' + i, x: i % columns, y: Math.floor(i / columns), displaySetInstanceUIDs: [] })));
  const [first, second] = h.displaySets.map(d => d.displaySetInstanceUID);
  h.doubleClick(second);
  assert.deepEqual(h.grid().get('vp-0').displaySetInstanceUIDs, [second], 'the first cell shows the series');
  assert.equal([...h.grid().values()].filter(v => v.displaySetInstanceUIDs.length).length, 1);
  // A cell the reader made active keeps receiving the next double-click.
  h.activate('vp-2');
  h.doubleClick(first);
  assert.deepEqual(h.grid().get('vp-2').displaySetInstanceUIDs, [first]);
  assert.deepEqual(h.grid().get('vp-0').displaySetInstanceUIDs, [second]);
  h.extension.onModeExit();
});

// Acquisition DateTime per image, at the site's stated UTC offset.
function exposed(items, times) {
  times.forEach((t, i) => { items[i]['0008002A'] = { vr: 'DT', Value: [t] }; items[i]['00080201'] = { vr: 'SH', Value: ['+0900'] }; });
  return items;
}
// The active stage as the grid lays it out: one pane per cell, each with its viewport element, hung as the protocol says.
function layOut(h) {
  const stage = h.protocol().stages[h.state().stageIndex], { columns } = stage.viewportStructure.properties;
  const keys = stage.viewports.map(v => v.displaySets[0].id), id = i => stage.id + '-' + i;
  h.body.querySelectorAll('[class~="group/pane"]').forEach(p => p.remove());
  const panes = keys.map((_, i) => {
    const pane = Object.assign(new Element('relative group/pane'), { rect: { top: Math.floor(i / columns), left: i % columns } });
    const element = new Element(); element.setAttribute('data-viewport-uid', id(i)); pane.append(element);
    return pane;
  });
  h.body.append(...panes);
  h.layout(keys.map((k, i) => ({ viewportId: id(i), x: i % columns, y: Math.floor(i / columns), displaySetInstanceUIDs: h.selected(k) ? [h.selected(k)] : [] })));
  return { keys, panes, id };
}

// A retaken R CC: three R CC Conventional images of one study, stored out of exposure order. The latest
// exposure is hung and its cell says it is one of three, with a control that shows each image in turn.
test('a repeat exposure hangs the latest image, marked as one of several, and the cell switches to each other image', async () => {
  const items = ['siemens-2d-12-1', 'siemens-2d-12-2', 'siemens-2d-12-1'].map(fixture);
  items[2]['00080018'].Value[0] += '.3'; items[2]['0020000E'].Value[0] += '.3';
  for (const d of items.slice(1)) d['0020000D'] = structuredClone(items[0]['0020000D']);
  exposed(items, ['20261030101500', '20261030102000', '20261030101000']);
  const h = await mount(items);
  h.run();
  const set = d => h.displaySets.find(s => s.images[0].SOPInstanceUID === d['00080018'].Value[0]).displaySetInstanceUID;
  const key = 'current|R|CC|conventional';
  assert.equal(h.selected(key), set(items[1]), 'the latest exposure fills the slot');
  const stage = h.protocol().stages[h.state().stageIndex], { columns } = stage.viewportStructure.properties;
  const keys = stage.viewports.map(v => v.displaySets[0].id), cell = keys.indexOf(key);
  assert.deepEqual(plain(keys.filter(k => h.selected(k))), [key], 'no other slot takes one of the repeated images');
  const panes = keys.map((_, i) => Object.assign(new Element('relative group/pane'), { rect: { top: Math.floor(i / columns), left: i % columns } }));
  h.body.append(...panes);
  const open = i => { const element = new Element(); element.setAttribute('data-viewport-uid', 'vp-' + i); panes[i].append(element); };
  open(cell);
  h.layout(keys.map((k, i) => ({ viewportId: 'vp-' + i, x: i % columns, y: Math.floor(i / columns), displaySetInstanceUIDs: h.selected(k) ? [h.selected(k)] : [] })));
  const label = () => paneText(panes[cell]);
  const button = () => panes[cell].descendants().filter(e => e.tagName === 'BUTTON');
  assert.match(label(), /^Current · R CC · Conventional · 3장 중 1장 · 재촬영/);
  assert.equal(button().length, 1, 'one switch control in the repeat cell');
  assert.ok(panes.every((p, i) => i === cell || !p.descendants().some(e => e.tagName === 'BUTTON')), 'no control in a single-image or empty cell');
  // The reader opens an image in an empty cell; switching the repeat cell leaves that cell as it is.
  const other = keys.findIndex(k => !h.selected(k));
  h.activate('vp-' + other); open(other); h.doubleClick(set(items[2]));
  assert.match(paneText(panes[other]), /^Current · R CC · Conventional · 3장 중 3장 · 재촬영/, 'a repeat image is marked as its own slot wherever it is shown');
  for (const [shown, n] of [[items[0], 2], [items[2], 3], [items[1], 1]]) {
    button()[0].click();
    assert.deepEqual(plain(h.grid().get('vp-' + cell).displaySetInstanceUIDs), [set(shown)], 'image ' + n + ' of 3 in the same cell');
    assert.match(label(), new RegExp('^Current · R CC · Conventional · 3장 중 ' + n + '장 · 재촬영'));
    assert.equal(button().length, 1);
    assert.deepEqual(h.grid().get('vp-' + other).displaySetInstanceUIDs, [set(items[2])], 'the reader\'s own cell is unchanged');
  }
  // The reader's choice survives a new hanging run (a layout or image type change).
  button()[0].click();
  h.run();
  assert.equal(h.selected(key), set(items[0]));
  // The reader changes to a one-viewport layout, which keeps the image shown: its mark and Switch stay with it.
  const one = Object.assign(new Element('relative group/pane'), { rect: { top: 0, left: 0 } }), oneView = new Element();
  oneView.setAttribute('data-viewport-uid', 'one'); one.append(oneView);
  panes.forEach(p => p.remove()); h.body.append(one);
  h.layout([{ viewportId: 'one', x: 0, y: 0, displaySetInstanceUIDs: [set(items[0])] }]);
  assert.equal(paneText(one), 'Current · R CC · Conventional · 3장 중 2장 · 재촬영 | Switch');
  one.descendants().find(e => e.tagName === 'BUTTON').click();
  assert.deepEqual(plain(h.grid().get('one').displaySetInstanceUIDs), [set(items[2])], 'the one viewport shows the next image');
  assert.equal(paneText(one), 'Current · R CC · Conventional · 3장 중 3장 · 재촬영 | Switch');
  h.extension.onModeExit();
  assert.equal(paneText(h.body), '', 'mode exit removes the label and its control');
});

// The reader opens a repeat image where the active stage has no cell for its slot. Its mark and Switch come
// with it, and Switch changes only that cell.
async function openElsewhere(h, image, expected) {
  const { keys, panes, id } = layOut(h);
  const before = new Map([...h.grid()].map(([k, v]) => [k, v.displaySetInstanceUIDs]));
  const target = keys.findIndex(k => !h.selected(k));
  h.activate(id(target)); h.doubleClick(image);
  assert.equal(paneText(panes[target]), expected(1) + ' | Switch', 'the opened repeat image keeps its slot mark and Switch');
  panes[target].descendants().find(e => e.tagName === 'BUTTON').click();
  assert.equal(paneText(panes[target]), expected(2) + ' | Switch');
  assert.notDeepEqual(plain(h.grid().get(id(target)).displaySetInstanceUIDs), [image], 'Switch shows the other image in that cell');
  for (const [k, uids] of before) if (k !== id(target)) assert.deepEqual(h.grid().get(k).displaySetInstanceUIDs, uids, 'no other cell changes');
}

test('a marked Prior repeat opened in the Current layout keeps its mark and Switch', async () => {
  const current = fixture('siemens-2d-12-1'), prior = exposed(['siemens-2d-12-1', 'siemens-2d-12-2'].map(fixture), ['20241030101000', '20241030102000']);
  for (const d of prior) {
    d['0020000D'] = { ...d['0020000D'], Value: ['1.2.826.0.1.3680043.10.7.99'] };
    d['00080018'].Value[0] += '.9'; d['0020000E'].Value[0] += '.9';
  }
  const h = await mount([current, ...prior], { opened: [current['0020000D'].Value[0], '1.2.826.0.1.3680043.10.7.99'] });
  h.run();
  const set = d => h.displaySets.find(s => s.images[0].SOPInstanceUID === d['00080018'].Value[0]).displaySetInstanceUID;
  assert.equal(h.selected('prior|R|CC|conventional'), set(prior[1]), 'the Compare layout hangs the latest Prior exposure');
  assert.ok(h.preferences().set({ layout: 'current', kind: null }));
  assert.match(h.protocol().stages[h.state().stageIndex].id, /^current-/);
  await openElsewhere(h, set(prior[1]), k => 'Prior · R CC · Conventional · 2장 중 ' + k + '장 · 재촬영');
  h.extension.onModeExit();
});

test('a Conventional repeat opened in the DBT stage keeps its mark and Switch', async () => {
  const items = exposed(['siemens-2d-12-1', 'siemens-2d-12-2'].map(fixture), ['20261030102000', '20261030101000']);
  items[1]['0020000D'] = structuredClone(items[0]['0020000D']);
  const h = await mount(items);
  h.run();
  const set = d => h.displaySets.find(s => s.images[0].SOPInstanceUID === d['00080018'].Value[0]).displaySetInstanceUID;
  assert.ok(h.preferences().set({ layout: 'current', kind: 'dbt' }));
  assert.equal(h.protocol().stages[h.state().stageIndex].id, 'current-dbt');
  await openElsewhere(h, set(items[0]), k => 'Current · R CC · Conventional · 2장 중 ' + k + '장 · 재촬영');
  h.extension.onModeExit();
});

// A retake minutes later at a site that states no UTC offset, both images numbered alike: the study's images
// share one clock, so the later exposure is hung and marked, not left as "Select Image".
test('a repeat exposure without any UTC offset hangs the later image of one study', async () => {
  const items = ['siemens-2d-12-1', 'siemens-2d-12-2'].map(fixture);
  items[1]['0020000D'] = structuredClone(items[0]['0020000D']);
  ['20261030100000', '20261030103000'].forEach((t, i) => {
    items[i]['0008002A'] = { vr: 'DT', Value: [t] }; delete items[i]['00080201']; items[i]['00200013'] = { vr: 'IS', Value: [1] };
  });
  const h = await mount(items);
  h.run();
  const set = d => h.displaySets.find(s => s.images[0].SOPInstanceUID === d['00080018'].Value[0]).displaySetInstanceUID;
  const key = 'current|R|CC|conventional';
  assert.equal(h.selected(key), set(items[1]), 'the exposure 30 minutes later fills the slot');
  const { keys, panes } = layOut(h);
  assert.equal(paneText(panes[keys.indexOf(key)]), 'Current · R CC · Conventional · 2장 중 1장 · 재촬영 | Switch');
  h.extension.onModeExit();
});

test('stored VOI table reaches the actor and switching to a windowed image replaces it', async () => {
  const a = fixture('siemens-lut-12-1'), b = fixture('siemens-2d-12-2');
  b['0020000D'] = structuredClone(a['0020000D']);
  const h = await mount([a, b]);
  h.run();
  h.show(0);
  assert.equal(h.points.length, 8);
  assert.deepEqual(h.points[0].slice(0, 4), [100, 1, 1, 1]); // MONOCHROME1: minimum is white.
  assert.deepEqual(h.points.at(-1).slice(0, 4), [107, 0, 0, 0]);
  assert.equal(h.points[3][1], 1 - 16000 / 65535);
  h.show(1, 'stack');
  assert.equal(h.points.length, 0);
  assert.deepEqual(h.ranges.at(-1), { lower: 83, upper: 1382 });
  assert.equal(h.properties.at(-1).invert, false);
  h.extension.onModeExit();
});

// Implicit VR: LUT Data (US or OW) reaches DICOMweb JSON as binary, inline or as a bulk data URI.
const words = Buffer.from(new Uint16Array(LUT).buffer);
function implicitLut(form) {
  const d = fixture('siemens-lut-12-1'), table = d['00283010'].Value[0];
  const [study, series, sop] = ['0020000D', '0020000E', '00080018'].map(t => d[t].Value[0]);
  const uri = `http://orthanc:8042/dicom-web/studies/${study}/series/${series}/instances/${sop}/bulk/00283010/0/00283006`;
  table['00283006'] = form === 'inline' ? { vr: 'OW', InlineBinary: words.toString('base64') } : { vr: 'OW', BulkDataURI: uri };
  return { d, path: `/dicom-web/studies/${study}/series/${series}/instances/${sop}/bulk/00283010/0/00283006` };
}
for (const [form, body, type] of [
  ['inline'],
  ['bulk multipart', Buffer.concat([Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\n'), words, Buffer.from('\r\n--b1--\r\n')]),
    'multipart/related; type="application/octet-stream"; boundary=b1'],
  ['bulk multipart, quoted boundary and more part headers', Buffer.concat([Buffer.from('--ab-12\r\nContent-Type: application/octet-stream\r\n' +
    'MIME-Version: 1.0\r\nContent-Length: 16\r\n\r\n'), words, Buffer.from('\r\n--ab-12--')]),
    'multipart/related; type="application/octet-stream"; boundary="ab-12"'],
]) test('implicit-VR stored VOI LUT (' + form + ') is applied exactly', async () => {
  const { d, path } = implicitLut(form === 'inline' ? 'inline' : 'bulk');
  const h = await mount([d], { routes: body ? { [path]: { body: new Uint8Array(body), type } } : {} });
  if (body) assert.deepEqual(h.requests.filter(r => r.url !== '/api/me').map(r => r.url), [path], 'the bulk element is read on this origin');
  h.run();
  h.show(0);
  assert.equal(h.points.length, 8);
  assert.deepEqual(h.points.map(p => p[0]), [100, 101, 102, 103, 104, 105, 106, 107]);
  assert.deepEqual(h.points.map(p => p[1]), LUT.map(v => 1 - v / 65535));
  assert.equal(h.element.querySelector('.kin-mg-voi-notice'), null);
  h.extension.onModeExit();
});

test('an unreadable stored VOI LUT shows a notice instead of silently using another grayscale', async () => {
  const { d } = implicitLut('bulk');
  const h = await mount([d]); // the bulk request fails
  h.run();
  h.show(0);
  assert.equal(h.points.length, 0);
  const notice = h.element.querySelector('.kin-mg-voi-notice');
  assert.ok(notice, 'a visible notice');
  assert.equal(notice.attributes.role, 'status');
  assert.match(notice.textContent, /VOI LUT/);
  h.extension.onModeExit();
});

test('ordinary CT keeps the requested native hanging protocol', async () => {
  const d = fixture('siemens-ct-tomo12'); d['00080008'].Value = ['ORIGINAL', 'PRIMARY', 'AXIAL']; d['00080060'].Value[0] = 'CT';
  const h = await mount([d]);
  h.run();
  assert.equal(h.state().protocolId, 'default');
  assert.equal(h.protocol(), undefined);
  h.extension.onModeExit();
});
