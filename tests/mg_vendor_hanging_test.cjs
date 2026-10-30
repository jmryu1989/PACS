// REQ-MG-VENDOR-HANG/VOI -> RISK-MG-OMITTED-SLICES/WRONG-VOI -> TEST-MG-VENDOR-HANG.
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

class Element {
  constructor(className = '') { this.className = className; this.style = {}; this.children = []; this.textContent = ''; this.attributes = {}; }
  append(...children) { this.children.push(...children); for (const c of children) c.onload?.(); }
  setAttribute(k, v) { this.attributes[k] = v; } addEventListener() {}
  remove() { this.parent && (this.parent.children = this.parent.children.filter(c => c !== this)); }
  querySelector(selector) { const c = this.children.find(x => '.' + x.className === selector); if (c) c.parent = this; return c || null; }
  querySelectorAll() { return []; }
}

async function mount(items, { routes = {} } = {}) {
  const listeners = new Map(), panel = new Element(), requests = [];
  const document = { head: new Element(), body: new Element(), createElement: () => new Element(),
    querySelector: s => s === '#kin-viewer-layout' ? panel : null, querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
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
    getState: () => ({ viewports: new Map() }), subscribe: () => ({ unsubscribe() {} }) },
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
    return route ? { ok: true, headers: { get: () => route.type }, arrayBuffer: async () => route.body.buffer.slice(route.body.byteOffset, route.body.byteOffset + route.body.byteLength) }
      : { ok: false, headers: { get: () => '' } };
  };
  const context = vm.createContext({ document, URL, URLSearchParams, fetch,
    location: { search: '?StudyInstanceUIDs=' + study, href: 'https://localhost:9443/ohif/viewer?StudyInstanceUIDs=' + study },
    MutationObserver: class { observe() {} disconnect() {} }, kinViewerSession: { sameAccount: () => true },
    window: { KinMammographyModel: model, cornerstone: { Enums: { Events: { STACK_NEW_IMAGE: 'image', VIEWPORT_NEW_IMAGE_SET: 'stack' } },
      metaData: { get: () => ({ SOPInstanceUID: shown()['00080018'].Value[0], SeriesInstanceUID: shown()['0020000E'].Value[0] }) } } } });
  let order = items;
  const shown = () => order[current];
  vm.runInContext(fs.readFileSync('config/ohif/mammography-hanging.js', 'utf8'), context);
  const extension = vm.runInContext('kinCreateMammographyHanging()', context);
  await extension.preRegistration({ servicesManager: { services }, extensionManager });
  extension.onModeEnter();
  const loads = await source.retrieve.series.metadata();
  await Promise.all(loads.map(p => p.start()));
  return { hp, study, items, extension, points, properties, ranges, element, displaySets, requests,
    protocol: () => protocol, state: () => state, renderCount: () => renderCount,
    run() { hp.run({ displaySets }, 'default', {}); },
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
  ['bulk single part', words, 'application/octet-stream'],
  ['bulk multipart', Buffer.concat([Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\n'), words, Buffer.from('\r\n--b1--\r\n')]),
    'multipart/related; type="application/octet-stream"; boundary=b1'],
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
