// Exercise the shipped tabs and strip together at the DOM/native-service ports.
// Pixel rendering and native loader event delivery remain served viewer-tools coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

class Element extends EventTarget {
  constructor(tag = 'div') { super(); this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.textContent = ''; }
  get classList() { return { contains: c => (this.className || '').split(' ').includes(c),
    add: c => { this.className = (this.className || '') + ' ' + c; },
    remove: c => { this.className = (this.className || '').split(' ').filter(x => x !== c).join(' '); },
    toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); } }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  append(...nodes) { for (const n of nodes) { n.remove(); n.parentElement = this; this.children.push(n); } }
  prepend(...nodes) { this.append(...nodes); this.children = [...nodes, ...this.children.filter(n => !nodes.includes(n))]; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.append(...nodes); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector === '[data-kin-ux-owned]') return Object.hasOwn(this.dataset, 'kinUxOwned');
    const attr = selector.match(/^\[([^=]+)=["']?([^"'\]]+)["']?\]$/);
    return attr ? this.attrs[attr[1]] === attr[2] : this.tag === selector;
  }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture() {
  const body = new Element('body'), column = new Element(), a = new Element(), b = new Element(), gridNode = new Element();
  body.append(column); column.append(a); a.append(b); b.append(gridNode);
  gridNode.setAttribute('data-cy', 'viewport-grid');
  const pane = new Element(); pane.setAttribute('data-cy', 'viewport-pane'); gridNode.append(pane);
  const document = new EventTarget();
  Object.assign(document, { body, createElement: tag => new Element(tag), getElementById: () => null,
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) });
  const set = { displaySetInstanceUID: 'ds-a', StudyInstanceUID: '1.2', SeriesInstanceUID: '1.2.1' };
  const state = { activeViewportId: 'cell', viewports: new Map([['cell', { displaySetInstanceUIDs: ['ds-a'] }]]), layout: {} };
  let currentImage, fault, refuseOpening = false, coverage = true, onAssign, rendered = null;
  const assigned = [], messages = [], cached = new Set(), native = new EventTarget();
  const viewport = { element: pane, type: 'stack', getCurrentImageId: () => currentImage,
    getImageIds: () => [currentImage], getCurrentImageIdIndex: () => 0, render() {},
    async setStack() { rendered = { StudyInstanceUID: '1.2', SeriesInstanceUID: '1.2.1' }; cached.add(currentImage); } };
  const services = { viewportGridService: { getState: () => state, getActiveViewportId: () => 'cell',
    setDisplaySetsForViewport(value) { assigned.push(value); state.viewports.set('cell', value); onAssign?.(); } },
    displaySetService: { getActiveDisplaySets: () => [set], getDisplaySetByUID: () => set },
    cornerstoneViewportService: { EVENTS: {}, subscribe: () => ({ unsubscribe() {} }), getCornerstoneViewport: () => viewport },
    uiNotificationService: { show: value => messages.push(value) } };
  const window = { KinViewerInfoBar: { identity: () => ({ viewport, instance: rendered,
    set: state.viewports.get('cell').displaySetInstanceUIDs.length ? set : null }) },
    KinViewerFrameCoverageConfirm: () => coverage, KinViewerSessionBoundary: { reenter: async () => refuseOpening ? null : { commit() {} } },
    cornerstone: { eventTarget: native, Enums: { Events: { IMAGE_LOAD_FAILED: 'failed', IMAGE_LOADED: 'loaded' } },
      cache: { getImage: id => cached.has(id), getImageLoadObject: () => undefined },
      metaData: { get: (_, id) => id === 'frame-a' ? { StudyInstanceUID: '1.2', SeriesInstanceUID: '1.2.1' } : undefined } } };
  const fetch = async path => {
    if (path.startsWith('/api/studies')) {
      if (fault) return { ok: false, status: 503 };
      const uid = new URL(path, 'https://viewer.test').searchParams.get('uids');
      return { ok: true, json: async () => ({ studies: [{ uid, sourcePatientKey: uid, id: uid, name: 'Synthetic' }] }) };
    }
    if (path.endsWith('/metadata')) return { ok: true, json: async () => [{
      '0020000D': { Value: ['1.2'] }, '0020000E': { Value: ['1.2.1'] }, '0008103E': { Value: ['Synthetic Series'] },
      '00280010': { Value: [32] }, '00280011': { Value: [32] }, '00280008': { Value: [1] },
    }] };
    return { ok: false, status: 503 }; // Preview failure must not prevent assignment.
  };
  const context = vm.createContext({ window, document, fetch, URL, URLSearchParams, AbortController,
    location: { origin: 'https://viewer.test', href: 'https://viewer.test/ohif/viewer?StudyInstanceUIDs=1.2' },
    queueMicrotask, console });
  for (const file of ['viewer-patient-tabs.js', 'viewer-series-strip.js'])
    vm.runInContext(fs.readFileSync('worklist-v0/hpacs-lite/' + file, 'utf8'), context, { filename: file });
  await window.KinViewerPatientTabs.mount({ services, session: { state: () => 'active', readOnly: () => false }, refreshChrome() {} });
  const strip = window.KinViewerSeriesStrip.mount({ services }); strip.refresh(); await settle();
  const card = () => body.querySelectorAll('button').find(n => n.querySelector('.kin-series-title'));
  const fail = id => native.dispatchEvent(new CustomEvent('failed', { detail: { imageId: id, error: new Error('503') } }));
  return { body, pane, strip, state, assigned, messages, window, card, fail, cached,
    setFault(value) { fault = value; }, setCoverage(value) { coverage = value; }, setRefusal(value) { refuseOpening = value; },
    setAssignment(fn) { onAssign = fn; }, setImage(id) { currentImage = id; },
    close() { strip.dispose(); window.KinViewerPatientTabs.end(); } };
}

test('returning to a patient tab restores the scroll origin together with the saved frame', async () => {
  const listeners = new Set(), views = new Map(), body = new Element('body');
  const location = { origin: 'https://viewer.test', href: 'https://viewer.test/ohif/viewer?StudyInstanceUIDs=1.2' };
  const study = () => new URL(location.href).searchParams.get('StudyInstanceUIDs');
  const sets = ['1.2', '2.3'].map(uid => ({ displaySetInstanceUID: 'ds-' + uid, StudyInstanceUID: uid, SeriesInstanceUID: uid + '.1' }));
  const state = { activeViewportId: 'cell', layout: { layoutType: 'grid', numRows: 1, numCols: 1 }, viewports: new Map() };
  const changed = viewportId => { for (const listener of [...listeners]) listener({ viewportId }); };
  function create(id, uid, index) {
    const ids = Array.from({ length: 6 }, (_, n) => uid + '/frame/' + n);
    const view = { type: 'stack', current: index, targetImageIdIndex: index,
      getImageIds: () => ids, getCurrentImageId() { return ids[this.current]; }, getCurrentImageIdIndex() { return this.current; },
      setImageIdIndex(value) { this.current = value; return Promise.resolve(ids[value]); }, render() {},
      scroll(delta) { this.targetImageIdIndex = Math.max(0, Math.min(ids.length - 1, this.targetImageIdIndex + delta)); return this.setImageIdIndex(this.targetImageIdIndex); } };
    views.clear(); views.set(id, view);
    state.activeViewportId = id;
    state.viewports = new Map([[id, { viewportId: id, displaySetInstanceUIDs: ['ds-' + uid] }]]);
    return view;
  }
  create('cell', '1.2', 3);
  const services = { displaySetService: { getActiveDisplaySets: () => sets, getDisplaySetByUID: id => sets.find(set => set.displaySetInstanceUID === id) },
    viewportGridService: { getState: () => state, setLayout(options) {
      const cell = options.findOrCreateViewport(0), id = cell.viewportOptions.viewportId;
      create(id, study(), 0); // The recreated renderer still needs the saved frame applied.
      queueMicrotask(() => changed(id));
    } },
    cornerstoneViewportService: { EVENTS: { VIEWPORT_DATA_CHANGED: 'data' }, getCornerstoneViewport: id => views.get(id),
      subscribe(_event, listener) { listeners.add(listener); return { unsubscribe: () => listeners.delete(listener) }; } } };
  const window = { KinViewerInfoBar: { identity: () => ({ instance: { StudyInstanceUID: study() } }) },
    kinViewerFrameCoverageConfirm: () => true,
    dispatchEvent() { create('cell', study(), 0); queueMicrotask(() => changed('cell')); } };
  const context = vm.createContext({ window, location, URL, URLSearchParams, AbortController, structuredClone, queueMicrotask, clearTimeout,
    requestAnimationFrame: fn => queueMicrotask(fn), crypto: require('node:crypto').webcrypto, PopStateEvent: Event,
    document: { body, createElement: tag => new Element(tag), getElementById: () => null, querySelector: () => null },
    history: { state: {}, replaceState(_state, _title, href) { location.href = href; } },
    fetch: async path => { const uid = new URL(path, location.origin).searchParams.get('uids');
      return { ok: true, json: async () => ({ studies: [{ uid, sourcePatientKey: uid, id: uid, name: 'Synthetic' }] }) }; } });
  vm.runInContext(fs.readFileSync('worklist-v0/hpacs-lite/viewer-patient-tabs.js', 'utf8'), context);
  const tabs = window.KinViewerPatientTabs;
  try {
    await tabs.mount({ services, session: { state: () => 'active', readOnly: () => false }, refreshChrome() {} });
    assert.equal(await tabs.open('/ohif/viewer?StudyInstanceUIDs=2.3'), true); await settle();
    assert.equal(await tabs.open('/ohif/viewer?StudyInstanceUIDs=1.2'), true); await settle();
    const restored = views.get(state.activeViewportId);
    assert.equal(restored.getCurrentImageId(), '1.2/frame/3');
    await restored.scroll(1);
    assert.equal(restored.getCurrentImageId(), '1.2/frame/4');
  } finally { tabs.end(); }
});

for (const refusal of ['lookup 503', 'declined coverage', 'refused opening']) test(refusal + ' retains strip selection in a vacant cell', async () => {
  const f = await fixture();
  f.state.viewports.get('cell').displaySetInstanceUIDs = [];
  if (refusal === 'lookup 503') f.setFault(true);
  if (refusal === 'declined coverage') f.setCoverage(false);
  if (refusal === 'refused opening') f.setRefusal(true);
  assert.equal(await f.window.KinViewerPatientTabs.open('/ohif/viewer?StudyInstanceUIDs=2.3'), false);
  assert.ok(f.card(), 'the visible source series is retained');
  f.card().onclick();
  assert.equal(f.assigned.length, 1, 'the retained series can be selected immediately');
  assert.equal(f.messages.length, 0);
  f.close();
});

test('a failure evicted before the first refresh offers Retry and clears on successful retry', async () => {
  const f = await fixture();
  f.setAssignment(() => { f.setImage('frame-a'); f.fail('frame-a'); });
  f.card().onclick(); f.strip.refresh();
  const retry = f.pane.querySelectorAll('button').find(n => n.textContent === 'Retry');
  assert.ok(retry, 'fast native failure has a retry action without a cache promise');
  f.strip.refresh(); await settle(); f.strip.refresh();
  assert.ok(f.pane.querySelectorAll('button').includes(retry), 'Retry remains attached across refreshes before the click');
  await retry.onclick(); f.strip.refresh();
  assert.equal(f.pane.querySelectorAll('section').length, 0, 'successful image removes the loading/error notice');
  f.close();
});

test('late failures for a removed assignment and events after disposal do not show a retry', async () => {
  const f = await fixture(); f.setImage('frame-a'); f.card().onclick();
  f.state.viewports.get('cell').displaySetInstanceUIDs = ['different-series'];
  f.fail('frame-a');
  assert.equal(f.pane.querySelectorAll('section').length, 0);
  f.close(); f.fail('frame-a');
  assert.equal(f.pane.querySelectorAll('section').length, 0);
});

test('shell ignores its chrome writes but refreshes for stock viewport changes in the same batch', () => {
  const body = new Element('body'), root = new Element(), pane = new Element(), notice = new Element('section');
  body.append(root); root.append(pane); notice.dataset.kinUxOwned = ''; pane.append(notice);
  const document = new EventTarget();
  Object.assign(document, { body, createElement: tag => new Element(tag), getElementById: () => root });
  const frames = new Map(); let nextFrame = 0, observer, refreshes = 0, placements = 0;
  const chrome = () => ({ refresh() { refreshes++; }, place() { placements++; }, adopt() {}, dispose() {} });
  const window = {
    KinViewerPatientTabs: { snapshot() {}, subscribe: () => () => {}, mount() {}, refresh() {}, dispose() {} },
    KinViewerInfoBar: { mount: chrome }, KinViewerSeriesStrip: { mount: chrome },
    cornerstone: { Enums: { Events: {} } },
  };
  const context = vm.createContext({ window, document,
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} disconnect() {} },
  });
  vm.runInContext(fs.readFileSync('worklist-v0/hpacs-lite/viewer-ux-shell.js', 'utf8'), context);
  const shell = window.KinViewerUXShell.mount({ services: {
    viewportGridService: {}, displaySetService: {}, cornerstoneViewportService: {},
  }, session: {} });
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  flush(); const initial = refreshes;
  const mutation = (target, addedNodes = [], removedNodes = []) => ({ target, addedNodes, removedNodes });
  const ownWrites = [mutation(pane, [notice]), mutation(pane, [], [notice]), mutation(notice, [new Element('button')])];
  observer(ownWrites); flush();
  assert.equal(refreshes, initial, 'adding, removing and updating shell chrome does not schedule another refresh');
  assert.equal(placements, 0, 'shell writes do not trigger chrome placement either');
  const viewport = new Element('canvas');
  observer([...ownWrites, mutation(pane, [viewport])]); flush();
  assert.ok(refreshes > initial, 'stock viewport insertion still refreshes alongside shell mutations');
  const afterInsert = refreshes;
  observer([mutation(pane, [], [viewport])]); flush();
  assert.ok(refreshes > afterInsert, 'stock viewport removal still refreshes');
  shell.dispose();
});
