// REQ-MG-VENDOR-HANG/VOI -> RISK-MG-OMITTED-SLICES/WRONG-VOI -> TEST-MG-VENDOR-HANG.
// Runs the shipped extension against its OHIF service/viewport interfaces. GPU/HTTP remain served checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../worklist-v0/hpacs-lite/mammography-model.js');
const cases = require('./fixtures/mg_vendor_cases.json').cases;
const fixture = id => structuredClone(cases.find(c => c.id === id).dicom);
const plain = x => JSON.parse(JSON.stringify(x));

async function mount(items, modality = 'MG') {
  class Element {
    constructor() { this.style = {}; this.children = []; }
    append(...children) { this.children.push(...children); for (const c of children) c.onload?.(); }
    setAttribute() {} addEventListener() {} remove() {}
    querySelectorAll() { return []; }
  }
  const listeners = new Map(), panel = new Element();
  const document = { head: new Element(), body: new Element(), createElement: () => new Element(),
    querySelector: s => s === '#kin-viewer-layout' ? panel : null, querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  let state, protocol, current = 0, renderCount = 0;
  const points = [], properties = [], ranges = [];
  const transfer = { removeAllPoints() { points.length = 0; }, addRGBPoint(...point) { points.push(point); } };
  const viewport = { type: 'stack', getCurrentImageId: () => 'frame-' + current, getCurrentImageIdIndex: () => current,
    getCamera: () => ({}), setCamera() {}, getDefaultActor: () => ({ actor: { getProperty: () => ({ getRGBTransferFunction: () => transfer }) } }),
    setProperties: p => properties.push(plain(p)), setVOI: (r, options) => { ranges.push(plain(r)); if (options.forceRecreateLUTFunction) points.length = 0; },
    render: () => renderCount++ };
  const hp = { getState: () => state, addProtocol: (_, p) => { protocol = p; },
    run: (_, id, options) => { state = { protocolId: id, stageIndex: options?.stageIndex }; } };
  const services = { hangingProtocolService: hp, viewportGridService: { EVENTS: { GRID_STATE_CHANGED: 'grid' },
    getState: () => ({ viewports: new Map() }), subscribe: () => ({ unsubscribe() {} }) },
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport } };
  const source = { retrieve: { series: { metadata: async () => [{ metadata: { Modality: modality }, start: async () => items }] } } };
  const study = items[0]['0020000D'].Value[0];
  const context = vm.createContext({ document, URLSearchParams, location: { search: '?StudyInstanceUIDs=' + study },
    MutationObserver: class { observe() {} disconnect() {} }, kinViewerSession: { sameAccount: () => true },
    fetch: async () => ({ ok: true, json: async () => ({ institution: 'SYNTHETIC' }) }),
    window: { KinMammographyModel: model, cornerstone: { Enums: { Events: { STACK_NEW_IMAGE: 'image', VIEWPORT_NEW_IMAGE_SET: 'stack' } },
      metaData: { get: () => ({ SOPInstanceUID: items[current]['00080018'].Value[0], SeriesInstanceUID: items[current]['0020000E'].Value[0] }) } } } });
  vm.runInContext(fs.readFileSync('config/ohif/mammography-hanging.js', 'utf8'), context);
  const extension = vm.runInContext('kinCreateMammographyHanging()', context);
  await extension.preRegistration({ servicesManager: { services }, extensionManager: { getActiveDataSource: () => [source] } });
  extension.onModeEnter(); await source.retrieve.series.metadata();
  return { hp, study, items, extension, points, properties, ranges,
    protocol: () => protocol, state: () => state, renderCount: () => renderCount,
    show(index, type = 'image') { current = index; listeners.get(type)({ type, detail: { viewportId: 'test' } }); } };
}

test('CT-only metadata loads and all of its actual slices select one native DBT stack', async () => {
  const items = [0, 1, 2].map(i => {
    const d = fixture('siemens-ct-tomo12'); d['00080018'].Value[0] += '.' + i;
    d['00080060'].Value[0] = 'CT'; d['00200032'].Value[2] = i; return d;
  });
  const h = await mount(items, 'CT');
  const images = items.map(d => ({ SOPInstanceUID: d['00080018'].Value[0] }));
  const set = { Modality: 'CT', StudyInstanceUID: h.study, displaySetInstanceUID: 'native-stack', images };
  h.hp.run({ displaySets: [set] }, 'default', {});
  assert.match(h.state().protocolId, /^kin.mammography/);
  const selector = h.protocol().displaySetSelectors['current|R|CC|dbt'];
  assert.equal(selector.seriesMatchingRules[0].constraint.equals.value, 'native-stack');
  h.show(0);
  assert.deepEqual(h.ranges.at(-1), { lower: 83, upper: 1382 }); // DICOM LINEAR, WC=733/WW=1300
  assert.ok(h.renderCount() > 0);
  // No partial display set can satisfy the full stack, even if its first SOP matches.
  h.hp.run({ displaySets: [{ ...set, images: images.slice(0, 1) }] }, 'default', {});
  assert.equal(h.protocol().displaySetSelectors['current|R|CC|dbt'].seriesMatchingRules[0].constraint.equals.value, '');
  h.extension.onModeExit();
});

test('stored VOI table reaches the actor and switching to a windowed image replaces it', async () => {
  const a = fixture('siemens-lut-12-1'), b = fixture('siemens-2d-12-2');
  b['0020000D'] = structuredClone(a['0020000D']);
  const h = await mount([a, b]);
  const sets = [a, b].map((d, i) => ({ Modality: 'MG', StudyInstanceUID: h.study, displaySetInstanceUID: 'image-' + i,
    images: [{ SOPInstanceUID: d['00080018'].Value[0] }] }));
  h.hp.run({ displaySets: sets }, 'default', {});
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

test('ordinary CT keeps the requested native hanging protocol', async () => {
  const d = fixture('siemens-ct-tomo12'); d['00080008'].Value = ['ORIGINAL', 'PRIMARY', 'AXIAL']; d['00080060'].Value[0] = 'CT';
  const h = await mount([d], 'CT');
  h.hp.run({ displaySets: [{ Modality: 'CT', StudyInstanceUID: h.study, images: [{ SOPInstanceUID: d['00080018'].Value[0] }] }] }, 'default', {});
  assert.equal(h.state().protocolId, 'default');
  assert.equal(h.protocol(), undefined);
  h.extension.onModeExit();
});
