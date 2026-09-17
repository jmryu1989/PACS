'use strict';
/* TEST-S2-PURE-NAV / TEST-S2-PURE-STORE (REQ-S2-NAVIGATE, REQ-S2-FRESHNESS, REQ-S2-IDEMPOTENT).
 * Two production sources run here, never a copy: the shipped finding-link-model.js (link state,
 * refusal texts, reply shape and the async store) and the exact-frame navigation function sliced
 * out of the committed config/ohif.js (tests/three_d_cursor_wiring_test.cjs convention). The
 * synthetic parts are the transports: a fake fetch, fake viewports and a fake history closure. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const model = require('../worklist-v0/hpacs-lite/finding-link-model.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'config', 'ohif.js'), 'utf8');
const A = '1.2.3', B = '4.5.6', SERIES = '1.2.3.4', SOP = '1.2.3.4.5', ITEM = '00000000-0000-4000-8000-000000000001';
const REQUEST = '11111111-2222-3333-4444-555555555555';

/* ---------- navigation sliced from config/ohif.js ---------- */
function slice() {
  const start = source.indexOf('function kinViewerImageReference'), end = source.indexOf('function kinCreateViewerHistory()');
  assert.ok(start > 0 && end > start, 'navigation anchors present once');
  const text = source.slice(start, end);
  assert.ok(text.includes('async function kinViewerNavigateTo'), 'the shipped navigation function is in the slice');
  assert.ok(text.includes('function kinViewerActivateStudy'), 'the shipped activation function is in the slice');
  const sandbox = { Number, Array, Object, Promise, JSON, RegExp, Error, console };
  vm.createContext(sandbox);
  vm.runInContext(text + ';this.reference = kinViewerImageReference; this.navigateTo = kinViewerNavigateTo; this.REASONS = KIN_NAVIGATION_REASONS;' +
    'this.activate = kinViewerActivateStudy; this.ACTIVATION_REASONS = KIN_ACTIVATION_REASONS;', sandbox);
  return sandbox;
}
const shipped = slice();
// vm results come from another realm; compare structure after a JSON round trip.
const plain = value => JSON.parse(JSON.stringify(value === undefined ? null : value));

test('navigation anchors appear exactly once and the production closure wires the shipped function', () => {
  for (const anchor of ['function kinViewerImageReference', 'async function kinViewerNavigateTo', 'function kinCreateViewerHistory()'])
    assert.equal(source.split(anchor).length - 1, 1, anchor);
  // The closure calls the shared function (no second navigation implementation) and exports it.
  assert.ok(source.includes('const navigateTo = target => kinViewerNavigateTo(navigationEnv, target);'));
  assert.ok(source.includes('window.kinViewerHistoryNavigate = navigateTo;'));
  assert.ok(source.includes('if (window.kinViewerHistoryNavigate === navigateTo) delete window.kinViewerHistoryNavigate;'));
  assert.ok(source.includes('const reference = kinViewerImageReference;'));
  assert.ok(source.includes("kinCreateViewerHistory(), kinCreateViewerFindings(), kinCreateViewerLayout()"), 'findings loader registered after the history panel');
  assert.deepEqual([...shipped.REASONS], model.NAVIGATION_REASONS);
  assert.equal(source.split('kinThreeDCursor: { enabled: false }').length - 1, 1, '3D cursor stays off');
});

test('image reference parses study/series/sop/1-based frame only from a stack image id', () => {
  assert.deepEqual(plain(shipped.reference('wadors:https://x/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/7')), { study: '1.2', seriesUid: '1.3', sopUid: '1.4', frame: 7 });
  for (const bad of [undefined, null, 7, 'studies/1.2/series/1.3/instances/1.4/frames/0', '/studies/1.2/series/1.3/instances/1.4', '/studies/a/series/1.3/instances/1.4/frames/1'])
    assert.equal(shipped.reference(bad), null, String(bad));
});

const imageId = (study, seriesUid, sopUid, frame) => 'wadors:/dicom-web/studies/' + study + '/series/' + seriesUid + '/instances/' + sopUid + '/frames/' + frame;
function harness(options) {
  const o = options || {};
  const calls = [];
  const state = { ended: false, scope: A, generation: 1, navigation: 0, busy: false, hydrated: 0, highlight: [] };
  const ids = o.ids || [imageId(A, SERIES, SOP + '.1', 1), imageId(A, SERIES, SOP, 1), imageId(A, SERIES, SOP + '.2', 1)];
  const viewport = o.viewport || { type: 'stack', index: 0, getImageIds: () => ids, getCurrentImageId() { return ids[this.index]; },
    async setImageIdIndex(index) { calls.push(['setImageIdIndex', index]); if (o.during) await o.during(state, this); if (o.reject) throw new Error('load failed'); this.index = o.landOn ?? index; },
    render() { calls.push(['render']); } };
  const sets = o.sets || [{ displaySetInstanceUID: 'ds-1', StudyInstanceUID: A, SeriesInstanceUID: SERIES, instances: [{ SOPInstanceUID: SOP }, { SOPInstanceUID: SOP + '.1' }, { SOPInstanceUID: SOP + '.2' }] }];
  const services = { displaySetService: { getActiveDisplaySets: () => { if (o.throwSets) throw new Error('no service'); return sets; } },
    viewportGridService: { getActiveViewportId: () => 'vp-1', setDisplaySetsForViewport: args => calls.push(['setDisplaySets', plain(args)]) },
    cornerstoneViewportService: { getCornerstoneViewport: () => o.laterViewport ? o.laterViewport(state) : viewport } };
  const matches = (r, item) => r?.study === state.scope && r.seriesUid === item.seriesUid && r.sopUid === item.sopUid && r.frame === item.frame;
  const env = { services, viewport: () => o.noViewport ? undefined : viewport, reference: shipped.reference, matches,
    hydrate: () => { state.hydrated++; }, highlight: itemId => { state.highlight.push(itemId); return { highlighted: !!itemId, annotation: itemId ? 'shown' : 'none' }; },
    ended: () => state.ended, scope: () => state.scope, busy: () => state.busy, generation: () => state.generation,
    valid: ticket => !state.ended && ticket === state.generation, navigation: () => state.navigation, beginNavigation: () => ++state.navigation,
    delay: () => new Promise(resolve => setTimeout(resolve, 0)) };
  return { env, state, calls, viewport, navigate: async target => plain(await shipped.navigateTo(env, target)) };
}
const target = extra => Object.assign({ studyUid: A, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: ITEM }, extra);

test('navigation arrives at the exact frame, hydrates, highlights the source and reports arrival', async () => {
  const kit = harness();
  const result = await kit.navigate(target());
  assert.deepEqual(result, { ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(kit.calls, [['setImageIdIndex', 1], ['render']]);
  assert.equal(kit.state.hydrated, 1);
  assert.deepEqual(kit.state.highlight, [ITEM]);
  assert.equal(kit.state.navigation, 1);
  // The Saved Items caller passes no itemId and gets no highlight.
  const plain = await kit.navigate(target({ itemId: undefined }));
  assert.deepEqual(plain, { ok: true, highlighted: false, annotation: 'none' });
});

test('refusals before any side effect: invalid target, ended session, other study, busy panel', async () => {
  for (const [bad, reason] of [[null, 'invalid'], [target({ frame: 0 }), 'invalid'], [target({ sopUid: 'x' }), 'invalid'], [target({ studyUid: undefined }), 'invalid'], [target({ studyUid: B }), 'scope']]) {
    const kit = harness();
    assert.deepEqual(await kit.navigate(bad), { ok: false, reason }, reason);
    assert.deepEqual(kit.calls, [], reason + ' has no side effect');
    assert.equal(kit.state.navigation, 0, reason + ' does not consume a navigation ticket');
  }
  const ended = harness(); ended.state.ended = true;
  assert.deepEqual(await ended.navigate(target()), { ok: false, reason: 'ended' }); assert.deepEqual(ended.calls, []);
  const busy = harness(); busy.state.busy = true;
  assert.deepEqual(await busy.navigate(target()), { ok: false, reason: 'busy' }); assert.deepEqual(busy.calls, []);
  const noScope = harness(); noScope.state.scope = '';
  assert.deepEqual(await noScope.navigate(target()), { ok: false, reason: 'scope' });
});

test('series missing, missing tool service and a volume viewport are refused without reslicing', async () => {
  const missing = harness({ sets: [] });
  assert.deepEqual(await missing.navigate(target()), { ok: false, reason: 'series-missing' }); assert.deepEqual(missing.calls, []);
  const twice = harness({ sets: [{ displaySetInstanceUID: 'a', StudyInstanceUID: A, SeriesInstanceUID: SERIES, instances: [{ SOPInstanceUID: SOP }] }, { displaySetInstanceUID: 'b', StudyInstanceUID: A, SeriesInstanceUID: SERIES, images: [{ SOPInstanceUID: SOP }] }] });
  assert.deepEqual(await twice.navigate(target()), { ok: false, reason: 'series-missing' });
  const other = harness({ sets: [{ displaySetInstanceUID: 'a', StudyInstanceUID: B, SeriesInstanceUID: SERIES, instances: [{ SOPInstanceUID: SOP }] }] });
  assert.deepEqual(await other.navigate(target()), { ok: false, reason: 'series-missing' });
  const broken = harness({ throwSets: true });
  assert.deepEqual(await broken.navigate(target()), { ok: false, reason: 'tool-missing' });
  const volume = harness({ viewport: { type: 'orthographic', getImageIds: () => [], render() {} } });
  assert.deepEqual(await volume.navigate(target()), { ok: false, reason: 'viewport-unsupported' });
  assert.deepEqual(volume.calls, []);
  const laterVolume = harness({ noViewport: true, laterViewport: () => ({ type: 'volume', getImageIds: () => [] }) });
  assert.deepEqual(await laterVolume.navigate(target()), { ok: false, reason: 'viewport-unsupported' });
  assert.deepEqual(laterVolume.calls, [['setDisplaySets', { viewportId: 'vp-1', displaySetInstanceUIDs: ['ds-1'] }]], 'the display set switch happened before the viewport type was known');
});

test('a series not shown is loaded into the active viewport and then indexed', async () => {
  const before = [imageId(A, '9.9', '9.9.1', 1)];
  let swapped = false;
  const kit = harness({ ids: before });
  const after = [imageId(A, SERIES, SOP, 1)];
  kit.viewport.getImageIds = () => swapped ? after : before;
  kit.viewport.getCurrentImageId = function () { return (swapped ? after : before)[this.index]; };
  kit.env.services.viewportGridService.setDisplaySetsForViewport = args => { kit.calls.push(['setDisplaySets', plain(args)]); setTimeout(() => { swapped = true; }, 1); };
  const result = await kit.navigate(target());
  assert.equal(result.ok, true);
  assert.deepEqual(kit.calls[0], ['setDisplaySets', { viewportId: 'vp-1', displaySetInstanceUIDs: ['ds-1'] }]);
  assert.deepEqual(kit.calls.slice(1), [['setImageIdIndex', 0], ['render']]);
});

test('frame never appearing is refused after the bounded wait without a render', async () => {
  const kit = harness({ ids: [imageId(A, SERIES, '7.7.7', 1)] });
  assert.deepEqual(await kit.navigate(target()), { ok: false, reason: 'frame-missing' });
  assert.deepEqual(kit.calls, [['setDisplaySets', { viewportId: 'vp-1', displaySetInstanceUIDs: ['ds-1'] }]]);
  assert.equal(kit.state.hydrated, 0);
});

test('a scope change or session end during the image load is superseded, not reported as arrival (A-B-A)', async () => {
  const aba = harness({ during: state => { state.scope = B; state.generation++; state.scope = A; state.generation++; } });
  assert.deepEqual(await aba.navigate(target()), { ok: false, reason: 'superseded' });
  assert.deepEqual(aba.calls, [['setImageIdIndex', 1]], 'no render after a superseded load');
  assert.equal(aba.state.hydrated, 0); assert.deepEqual(aba.state.highlight, []);
  const ended = harness({ during: state => { state.ended = true; } });
  assert.deepEqual(await ended.navigate(target()), { ok: false, reason: 'superseded' });
  assert.equal(ended.state.hydrated, 0);
  const newer = harness({ during: state => { state.navigation++; } });
  assert.deepEqual(await newer.navigate(target()), { ok: false, reason: 'superseded' });
  // Two navigations in flight: only the latest may report arrival.
  const race = harness({ during: () => new Promise(resolve => setTimeout(resolve, 5)) });
  const [first, second] = await Promise.all([race.navigate(target()), race.navigate(target({ sopUid: SOP + '.2' }))]);
  assert.deepEqual(first, { ok: false, reason: 'superseded' });
  assert.equal(second.ok, true);
  assert.equal(race.state.hydrated, 1);
});

test('the frame shown after the await is the proof of arrival; a load error, wrong landing or other active viewport is refused', async () => {
  const landed = harness({ landOn: 2 });
  assert.deepEqual(await landed.navigate(target()), { ok: false, reason: 'frame-missing' });
  assert.deepEqual(landed.calls, [['setImageIdIndex', 1]]); assert.equal(landed.state.hydrated, 0);
  const rejected = harness({ reject: true });
  assert.deepEqual(await rejected.navigate(target()), { ok: false, reason: 'frame-missing' });
  const rejectedLate = harness({ reject: true, during: state => { state.generation++; } });
  assert.deepEqual(await rejectedLate.navigate(target()), { ok: false, reason: 'superseded' });
  // A relayout that changes the active viewport while the image loads is not an arrival either.
  const moved = harness({ during: state => { state.activeViewport = 'vp-2'; } });
  moved.env.services.viewportGridService.getActiveViewportId = () => moved.state.activeViewport || 'vp-1';
  assert.deepEqual(await moved.navigate(target()), { ok: false, reason: 'superseded' });
  assert.equal(moved.state.hydrated, 0); assert.deepEqual(moved.state.highlight, []);
});

/* ---------- the whole history extension mounted in vm (tests/viewer_recovery_test.cjs harness) ----------
 * Here the generation, navigation counter and scope are the production closure's own: a study switch
 * goes through the real scan()/reset() path while a navigation is awaiting the image load. */
const { webcrypto } = require('node:crypto');
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; }
  append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
  replaceChildren(...children) { for (const c of this.children) c.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attributes[k] = v; }
  get isConnected() { return this.tagName === 'body' || !!this.parent?.isConnected; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  querySelectorAll(selector) { return this.all().filter(e => selector === '[data-kin-sr]' && e.dataset.kinSr); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
async function mounted(options) {
  const o = options || {};
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.querySelector = selector => document.body.all().find(e => selector === '#' + e.id) || null;
  document.createTextNode = value => { const node = new Element('#text'); node.textContent = value; return node; };
  const window = new EventTarget(), annotations = new Map();
  let study = '1.1'; const ticks = []; const tick = () => { for (const fn of [...ticks]) fn(); };
  const me = { sub: 'doctor', kind: 'member', roles: ['radiologist'] };
  const keyHead = { id: 'a0000000-0000-4000-8000-000000000001', revision: 1, hidden: false, authorSub: 'doctor', authorActor: 'Doctor', referenceStatus: 'verified',
    item: { schemaVersion: 1, kind: 'key', seriesUid: '1.2', sopUid: '1.3', frame: 1, title: 'saved key', description: '', hidden: false } };
  const ids = ['/studies/1.1/series/1.2/instances/1.3/frames/1', '/studies/1.1/series/1.2/instances/1.5/frames/1'];
  const viewport = { type: 'stack', index: 0, pending: [], renders: 0, active: 'viewport',
    getImageIds: () => study === '1.1' ? ids : ['/studies/2.2/series/9.9/instances/9.9/frames/1'],
    getCurrentImageId() { return study === '1.1' ? ids[this.index] : '/studies/2.2/series/9.9/instances/9.9/frames/1'; },
    setImageIdIndex(index) { return new Promise(resolve => this.pending.push(() => { this.index = index; resolve(); })); },
    render() { this.renders++; } };
  const services = {
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
    viewportGridService: { getActiveViewportId: () => viewport.active, EVENTS: {}, setDisplaySetsForViewport() { viewport.switched = true; } },
    displaySetService: { getActiveDisplaySets: () => o.noSeries ? [] : [{ displaySetInstanceUID: 'ds', StudyInstanceUID: '1.1', SeriesInstanceUID: '1.2', instances: [{ SOPInstanceUID: '1.3' }, { SOPInstanceUID: '1.5' }] }] },
    measurementService: { getMeasurements: () => [], getMeasurement: () => undefined, remove() {}, update() {} },
    uiNotificationService: { show() {} },
  };
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'image' } }, metaData: { get() {} } };
  window.cornerstoneTools = { annotation: { locking: { setAnnotationLocked() {}, isAnnotationLocked: () => true }, selection: { setAnnotationSelected() {} },
    state: { getAnnotation: uid => annotations.get(uid), getAllAnnotations: () => [...annotations.values()], removeAnnotation: uid => annotations.delete(uid) } },
    ToolGroupManager: { getToolGroupForViewport() {} } };
  window.prompt = () => 'reason'; window.confirm = () => true;
  const fetch = async path => ({ status: 200, ok: true, json: async () => path === '/api/me' ? me
    : path.includes('/findings') ? { items: [], nextCursor: null } : { items: study === '1.1' ? [JSON.parse(JSON.stringify(keyHead))] : [], nextCursor: null } });
  window.fetch = fetch;
  const sandbox = { window, document, crypto: webcrypto, TextEncoder, console, Event, AbortController,
    setInterval: fn => { ticks.push(fn); return ticks.length; }, clearInterval() {}, setTimeout, clearTimeout, fetch };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-history');
  extension.preRegistration({ servicesManager: { services }, commandsManager: { getCommand: () => undefined, registerCommand() {} } });
  extension.onModeEnter(); await flush();
  const all = () => document.body.all();
  // Optionally mount the shipped Findings section itself inside the history panel.
  let findings = null;
  if (o.findings) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'finding-link-model.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'viewer-findings.js'), 'utf8'), sandbox);
    // In the browser globalThis is window; in this vm context the UMD root is the sandbox itself.
    findings = window.kinViewerFindings(services, window.kinFindingLinkModel || sandbox.kinFindingLinkModel);
    assert.equal(findings.mount(), true, 'the Findings section mounts inside #kin-viewer-history');
    tick(); await flush();
  }
  return { window, viewport, extension, all, findings, text: () => all().map(e => e.textContent).join('\n'),
    button: name => { const found = all().filter(e => e.tagName === 'button' && e.textContent === name); assert.equal(found.length, 1, name); return found[0]; },
    switch: async uid => { study = uid; tick(); await flush(); },
    release: async () => { const next = viewport.pending.shift(); assert.ok(next, 'no pending image load'); next(); await flush(); } };
}
const findingTarget = extra => Object.assign({ studyUid: '1.1', seriesUid: '1.2', sopUid: '1.5', frame: 1 }, extra);

test('mounted history: the exported navigation reaches the frame and the closure counters own the outcome', async () => {
  const h = await mounted();
  assert.equal(typeof h.window.kinViewerHistoryNavigate, 'function');
  assert.equal(typeof h.window.kinViewerHistoryState, 'function');
  assert.equal(h.window.kinViewerHistoryState().scope, '1.1');
  assert.equal(h.window.kinViewerHistoryState().heads.length, 1);
  const pending = h.window.kinViewerHistoryNavigate(findingTarget());
  await flush(); assert.equal(h.viewport.pending.length, 1, 'the image load was requested');
  await h.release();
  assert.deepEqual(plain(await pending), { ok: true, highlighted: false, annotation: 'none' });
  assert.equal(h.viewport.index, 1); assert.equal(h.viewport.renders >= 1, true);
  h.extension.onModeExit();
  assert.equal(h.window.kinViewerHistoryNavigate, undefined, 'the export is removed with the panel');
  assert.equal(h.window.kinViewerHistoryState, undefined);
});

test('mounted history: a study switch during the image load supersedes the navigation through the real scan()', async () => {
  const h = await mounted();
  const pending = h.window.kinViewerHistoryNavigate(findingTarget());
  await flush(); assert.equal(h.viewport.pending.length, 1);
  await h.switch('2.2');
  assert.equal(h.window.kinViewerHistoryState().scope, '2.2');
  // reset() itself renders once on the study change; nothing may render for the stale arrival after it.
  const rendersBefore = h.viewport.renders;
  await h.release();
  assert.deepEqual(plain(await pending), { ok: false, reason: 'superseded' });
  assert.equal(h.viewport.renders, rendersBefore, 'no render after a superseded load');
  // Back on study 1.1 the same target is reachable again through a fresh navigation.
  await h.switch('1.1');
  const again = h.window.kinViewerHistoryNavigate(findingTarget()); await flush(); await h.release();
  assert.equal(plain(await again).ok, true);
});

test('mounted history: of two navigations in flight only the latest may report arrival', async () => {
  const h = await mounted();
  const first = h.window.kinViewerHistoryNavigate(findingTarget()); await flush();
  const second = h.window.kinViewerHistoryNavigate(findingTarget({ sopUid: '1.3' })); await flush();
  assert.equal(h.viewport.pending.length, 2);
  await h.release(); await h.release();
  assert.deepEqual(plain(await first), { ok: false, reason: 'superseded' });
  assert.equal(plain(await second).ok, true);
  assert.equal(h.viewport.index, 0);
});

test('mounted findings section: reload action name is unique and no findings control reuses a page-level Measurements name', async () => {
  const h = await mounted({ findings: true });
  const panel = h.all().find(e => e.id === 'kin-viewer-findings');
  assert.ok(panel, 'findings section present'); assert.equal(panel.parent?.id, 'kin-viewer-history', 'nested inside the Measurements panel');
  const buttons = h.all().filter(e => e.tagName === 'button');
  const named = name => buttons.filter(b => b.textContent === name);
  // The hosted suites address these Measurements actions at page level with exact names.
  for (const name of ['Refresh', 'Add Key Image', 'Download SR', 'Store SR', 'Length', 'Angle', 'Ellipse ROI']) {
    assert.equal(named(name).length, 1, name + ' must resolve to exactly one button');
    assert.equal(panel.contains ? panel.contains(named(name)[0]) : panel.all().includes(named(name)[0]), false, name + ' belongs to the Measurements panel');
  }
  const reload = named('Reload Findings');
  assert.equal(reload.length, 1); assert.ok(panel.all().includes(reload[0]), 'Reload Findings belongs to the Findings section');
  const inside = new Set(panel.all().filter(e => e.tagName === 'button').map(b => b.textContent));
  assert.deepEqual([...inside].sort(), ['New Finding', 'Reload Findings']);
  assert.equal(h.all().filter(e => e.tagName === 'section' && panel.all().includes(e)).length, 0, 'findings rows never use <section>');
  assert.equal(panel.all().some(e => e.attributes.role === 'status'), false, 'no role=status inside the findings section');
  assert.equal(typeof h.window.kinViewerFindingsState, 'function');
  h.findings.stop();
  assert.equal(h.all().some(e => e.id === 'kin-viewer-findings'), false, 'stop() removes the section');
  assert.equal(h.window.kinViewerFindingsState, undefined);
});

test('mounted history: session end and other-study targets are refused; the Saved Items button keeps its messages', async () => {
  const h = await mounted({ noSeries: true });
  assert.deepEqual(plain(await h.window.kinViewerHistoryNavigate(findingTarget({ studyUid: '2.2' }))), { ok: false, reason: 'scope' });
  assert.deepEqual(plain(await h.window.kinViewerHistoryNavigate(findingTarget())), { ok: false, reason: 'series-missing' });
  h.button('Go to Image').click(); await flush();
  assert.match(h.text(), /현재 검사에서 원본 시리즈를 찾을 수 없습니다\./);
  const e = new Event('storage'); e.key = 'kin-session-ended'; h.window.dispatchEvent(e);
  assert.deepEqual(plain(await h.window.kinViewerHistoryNavigate(findingTarget())), { ok: false, reason: 'ended' });
});

/* ---------- link state, refusal texts, command and reply shapes ---------- */
const src = extra => Object.assign({ itemId: ITEM, revision: 2, studyUid: A }, extra);
test('linkState follows the server rule: missing, hidden, revised, current', () => {
  assert.equal(model.linkState(src(), null), 'missing');
  assert.equal(model.linkState(src(), { id: 'other', revision: 2, hidden: false, studyUid: A }), 'missing');
  assert.equal(model.linkState(src(), { id: ITEM, revision: 2, hidden: false, studyUid: B }), 'missing');
  assert.equal(model.linkState(src(), { id: ITEM, revision: 3, hidden: true, studyUid: A }), 'hidden');
  assert.equal(model.linkState(src(), { id: ITEM, revision: 3, hidden: false, studyUid: A }), 'revised');
  assert.equal(model.linkState(src(), { id: ITEM, revision: 1, hidden: false, studyUid: A }), 'revised');
  assert.equal(model.linkState(src(), { id: ITEM, revision: 2, hidden: false, studyUid: A }), 'current');
  assert.equal(model.linkState(src(), { id: ITEM, revision: 2, hidden: false }), 'current');
  assert.deepEqual(model.LINK_STATES, ['current', 'revised', 'hidden', 'missing']);
});

test('sourceStatus keeps the database link state and the reference verdict separate', () => {
  const head = { id: ITEM, revision: 3, hidden: false, referenceStatus: 'unverified' };
  const status = model.sourceStatus(src(), { itemId: ITEM, linkState: 'current', headRevision: 2, headHidden: false }, head);
  assert.equal(status.linkState, 'current', 'the server link wins over the client head');
  assert.equal(status.referenceStatus, 'unverified'); assert.equal(status.referenceLabel, 'Unverified'); assert.equal(status.label, 'Current');
  const local = model.sourceStatus(src(), null, head);
  assert.equal(local.linkState, 'revised'); assert.equal(local.headRevision, 3);
  assert.equal(model.sourceStatus(src(), null, { id: ITEM, revision: 2, hidden: false, referenceStatus: null }).referenceStatus, null);
  assert.equal(model.sourceStatus(src(), { itemId: ITEM, linkState: 'bogus' }, null).linkState, 'missing');
  assert.equal(model.sourceStatus(src(), null, null).text, '표식을 이 검사에서 찾을 수 없습니다. 소견의 사본은 유지됩니다.');
});

test('reasonText and annotationText name every refusal and every silent arrival', () => {
  for (const reason of model.NAVIGATION_REASONS) assert.ok(model.reasonText(reason).length > 5, reason);
  assert.equal(model.reasonText('scope'), '이 소견의 검사가 현재 화면의 검사가 아닙니다. 해당 검사를 연 창에서 이동하세요.');
  assert.equal(model.reasonText('viewport-unsupported'), '현재 화면은 원본 프레임 목록이 없는 MPR/볼륨 화면입니다. 일반 프레임 화면을 선택한 뒤 이동하세요.');
  for (const bad of ['nonsense', '', undefined, null, 0]) assert.equal(model.reasonText(bad), model.reasonText('invalid'), String(bad));
  assert.equal(model.annotationText('shown'), ''); assert.equal(model.annotationText('none'), '');
  assert.ok(model.annotationText('hidden').includes('숨겨져')); assert.ok(model.annotationText('unverified').includes('재확인'));
  assert.equal(model.annotationText('bogus'), model.annotationText('missing'));
});

test('commandBody sends only {itemId, revision} pairs plus title/text/primary', () => {
  const draft = { title: 'T', text: 'X', primary: 1, sources: [{ itemId: ITEM, revision: 2, values: [1], kind: 'length' }, { itemId: ITEM.replace('1', '2'), revision: 1 }] };
  const create = model.commandBody(draft, null, 'create', '', REQUEST);
  assert.deepEqual(create, { requestId: REQUEST, item: { schemaVersion: 1, title: 'T', text: 'X', primary: 1, sources: [{ itemId: ITEM, revision: 2 }, { itemId: ITEM.replace('1', '2'), revision: 1 }] } });
  const edit = model.commandBody(draft, { revision: 4 }, 'hide', '사유', REQUEST);
  assert.equal(edit.expectedRevision, 4); assert.equal(edit.action, 'hide'); assert.equal(edit.reason, '사유');
  assert.equal(model.commandBody({ ...draft, primary: 9 }, null, 'create', '', REQUEST).item.primary, 0);
  assert.equal(model.commandBody(draft, { revision: 1 }, undefined, undefined, REQUEST).action, 'edit');
});

test('draftProblem refuses empty, duplicate, overlong and unlinked drafts', () => {
  const ok = { title: 'T', text: '', sources: [{ itemId: ITEM, revision: 1 }], primary: 0 };
  assert.equal(model.draftProblem(ok), null);
  assert.equal(model.draftProblem({ ...ok, title: '', text: ' ' }), '제목 또는 본문을 입력하세요.');
  assert.equal(model.draftProblem({ ...ok, sources: [] }), '저장한 표식을 하나 이상 연결하세요.');
  assert.equal(model.draftProblem({ ...ok, sources: [ok.sources[0], ok.sources[0]] }), '같은 표식을 두 번 연결할 수 없습니다.');
  assert.equal(model.draftProblem({ ...ok, sources: Array.from({ length: 9 }, (_, i) => ({ itemId: ITEM.slice(0, -1) + i, revision: 1 })) }), '표식은 최대 8개까지 연결할 수 있습니다.');
  assert.equal(model.draftProblem({ ...ok, sources: [{ itemId: 'x', revision: 1 }] }), '연결한 표식의 저장 정보를 확인하세요.');
  assert.equal(model.draftProblem({ ...ok, title: '😀'.repeat(201) }), '제목은 200자 이하여야 합니다.');
  assert.equal(model.draftProblem({ ...ok, title: '😀'.repeat(200) }), null);
  assert.equal(model.draftProblem({ ...ok, text: 'x'.repeat(4001) }), '본문은 4000자 이하여야 합니다.');
});

test('validReply accepts only the exact navigation answer to this request (S2-B shape)', () => {
  const expected = { request: REQUEST, owner: 'o', studies: [A, B], activeUid: A };
  const reply = extra => Object.assign({ type: 'kin-finding-nav-reply', request: REQUEST, owner: 'o', studies: [A, B], activeUid: A, result: 'ok', highlighted: true, annotation: 'shown' }, extra);
  assert.deepEqual(model.validReply(reply(), expected), { ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(model.validReply(reply({ annotation: 7 }), expected), { ok: true, highlighted: true, annotation: 'none' });
  for (const reason of model.NAVIGATION_REASONS) assert.deepEqual(model.validReply(reply({ result: reason }), expected), { ok: false, reason });
  const bad = { 'other request': { request: 'x' }, 'other owner': { owner: 'p' }, 'other study set': { studies: [B, A] }, 'shorter': { studies: [A] },
    'other active': { activeUid: B }, 'wrong type': { type: 'kin-editor-reply' }, 'unknown result': { result: 'maybe' }, 'ok without highlight': { highlighted: 'yes' } };
  for (const [name, patch] of Object.entries(bad)) assert.deepEqual(model.validReply(reply(patch), expected), { ok: false, reason: 'invalid' }, name);
  for (const junk of [undefined, null, '', 0, [], {}, new Date()]) assert.deepEqual(model.validReply(junk, expected), { ok: false, reason: 'invalid' });
  assert.deepEqual(model.validReply(reply(), null), { ok: false, reason: 'invalid' });
  assert.equal(model.validTarget({ studyUid: A, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: ITEM }), true);
  assert.equal(model.validTarget({ studyUid: A, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: 'x' }), false);
  assert.equal(model.validTarget({ studyUid: A, seriesUid: SERIES, sopUid: SOP, frame: 0 }), false);
});

/* ---------- the async store: tickets, sequences, replay, conflicts ---------- */
function transport() {
  const log = [], gates = [];
  const me = { sub: 'reader-1', kind: 'member', roles: ['radiologist'] };
  const head = (id, revision, extra) => Object.assign({ id, studyUid: A, authorSub: 'reader-1', authorActor: 'Reader', revision, hidden: false, createdAt: 't', updatedAt: 't',
    item: { schemaVersion: 1, title: 'T', text: 'X', hidden: false, primary: 0, sources: [{ itemId: ITEM, revision: 2, studyUid: A, kind: 'length', seriesUid: SERIES, sopUid: SOP, frame: 1, frameOfReferenceUid: '1.9', label: 'L', values: [20], calculator: 'kin-native-manual-v1', sourceDigest: 'd', authorActor: 'Reader' }] },
    links: [{ itemId: ITEM, linkState: 'current', headRevision: 2, headHidden: false }] }, extra);
  const state = { items: [], responses: [], hold: false };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fetch = async (url, options) => {
    const entry = { url, options, body: options.body ? JSON.parse(options.body) : null };
    log.push(entry);
    if (state.hold) await new Promise(resolve => gates.push(resolve));
    if (url === '/api/me') return json(state.meStatus || 200, state.me === undefined ? me : state.me);
    if (state.responses.length) { const next = state.responses.shift(); return typeof next === 'function' ? next(entry) : json(next.status, next.body); }
    if (options.method === 'POST') return json(200, head('f0000000-0000-4000-8000-000000000001', 1));
    return json(200, { items: state.items, nextCursor: null });
  };
  return { fetch, log, gates, state, head, release: () => { state.hold = false; for (const g of gates.splice(0)) g(); } };
}
const tick = async n => { for (let i = 0; i < (n || 20); i++) await new Promise(r => setImmediate(r)); };
function makeStore(t, extra) {
  const navigations = [];
  const store = model.createStore(Object.assign({ fetch: t.fetch, uuid: () => REQUEST, navigate: async target => { navigations.push(target); return { ok: true, highlighted: true, annotation: 'shown' }; } }, extra));
  return { store, navigations };
}
const history = (scope, heads, extra) => Object.assign({ scope, subject: 'reader-1', ended: false, suspended: false, writable: true, heads: heads || [] }, extra);

test('store loads findings for the history scope and drops a late list after A-B-A', async () => {
  const t = transport(); const { store } = makeStore(t);
  t.state.items = [t.head('f0000000-0000-4000-8000-000000000001', 1)];
  store.syncHistory(history(A, [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false }]));
  await tick();
  assert.equal(store.state().scope, A); assert.equal(store.state().entries.size, 1);
  assert.equal(store.state().status, '1개 소견 · 소견 저장은 판독 확정과 별개입니다.');
  assert.deepEqual(t.log.map(x => x.url), ['/api/me', '/api/studies/' + A + '/findings?includeHidden=true&limit=100']);
  // Hold the next list for A, switch to B and back to A: the held reply belongs to an older generation.
  t.state.hold = true;
  store.load(); await tick();
  const generationA = store.state().generation;
  store.syncHistory(history(B, [])); await tick();
  assert.equal(store.state().entries.size, 0, 'B shows no findings of A');
  store.syncHistory(history(A, [])); await tick();
  assert.notEqual(store.state().generation, generationA);
  t.state.items = [t.head('f0000000-0000-4000-8000-000000000009', 1, { item: { schemaVersion: 1, title: 'NEW', text: '', hidden: false, primary: 0, sources: [{ itemId: ITEM, revision: 2, studyUid: A, kind: 'key', seriesUid: SERIES, sopUid: SOP, frame: 1, frameOfReferenceUid: null, label: 'K', values: null, calculator: null, sourceDigest: null, authorActor: 'Reader' }] } })];
  t.release(); await tick(60);
  const titles = [...store.state().entries.values()].map(e => e.head.item.title);
  assert.deepEqual(titles, ['NEW'], 'only the fresh load for A is applied');
});

test('store save sends the exact pairs once, replays the same body on retry and refreshes links', async () => {
  const t = transport(); const { store } = makeStore(t);
  store.syncHistory(history(A, [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false }])); await tick();
  const e = store.newDraft(); assert.ok(e);
  store.updateDraft(e, { title: '소견', text: '본문' });
  assert.equal(store.toggleSource(e, ITEM), true);
  assert.deepEqual(e.draft.sources, [{ itemId: ITEM, revision: 2 }]);
  assert.equal(store.toggleSource(e, 'ffffffff-0000-4000-8000-000000000000'), false, 'unknown head is not selectable');
  // Lost receipt: the server answered but the transport failed. The retry must resend the same body.
  t.state.responses.push(() => { throw new TypeError('network'); });
  assert.equal(await store.save(e, 'create'), false);
  assert.ok(e.pending); assert.equal(e.message, '저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.');
  const firstBody = t.log.filter(x => x.options.method === 'POST')[0].body;
  assert.deepEqual(firstBody, { requestId: REQUEST, item: { schemaVersion: 1, title: '소견', text: '본문', primary: 0, sources: [{ itemId: ITEM, revision: 2 }] } });
  t.state.items = [t.head('f0000000-0000-4000-8000-000000000001', 1)];
  assert.equal(await store.save(e), true);
  const posts = t.log.filter(x => x.options.method === 'POST');
  assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, firstBody);
  assert.equal(e.head.revision, 1); assert.equal(e.pending, null); assert.equal(e.message, '저장 완료');
  assert.equal(store.state().entries.get('f0000000-0000-4000-8000-000000000001'), e);
  assert.equal(e.links[0].linkState, 'current', 'links refreshed from the list after the write');
});

test('store keeps the draft on 409/503, records a stale source and lets Refresh Link re-pair it', async () => {
  const t = transport(); const { store } = makeStore(t);
  const saved = t.head('f0000000-0000-4000-8000-000000000001', 1, { links: [{ itemId: ITEM, linkState: 'revised', headRevision: 3, headHidden: false }] });
  t.state.items = [saved];
  store.syncHistory(history(A, [{ id: ITEM, revision: 3, hidden: false, referenceStatus: 'verified', working: false }])); await tick();
  const e = store.state().entries.get(saved.id);
  assert.equal(model.sourceStatus(e.head.item.sources[0], e.links[0], store.state().heads.get(ITEM)).linkState, 'revised');
  // Ordinary text edit keeps the old pair {ITEM, 2}: the server preserves the frozen copy.
  store.edit(e); store.updateDraft(e, { text: '수정' });
  t.state.responses.push({ status: 503, body: { message: 'delayed' } });
  assert.equal(await store.save(e, 'edit'), false);
  assert.ok(e.pending, '503 keeps the pending body for a same-request retry'); assert.equal(e.editing, true);
  assert.deepEqual(JSON.parse(e.pending.body).item.sources, [{ itemId: ITEM, revision: 2 }]);
  t.state.responses.push({ status: 409, body: { code: 'FINDING_SOURCE_STALE', itemId: ITEM, headRevision: 3, headHidden: false } });
  assert.equal(await store.save(e), false);
  assert.equal(e.pending, null); assert.deepEqual(e.staleSource, { itemId: ITEM, headRevision: 3, headHidden: false });
  assert.ok(e.message.includes('r3'));
  // Explicit refresh replaces exactly that pair with the current head pair.
  assert.equal(store.refreshSource(e, ITEM), true);
  assert.deepEqual(e.draft.sources, [{ itemId: ITEM, revision: 3 }]); assert.equal(e.staleSource, null);
  assert.equal(store.refreshSource(e, ITEM), false, 'already current');
  t.state.responses.push({ status: 200, body: t.head(saved.id, 2) });
  t.state.items = [t.head(saved.id, 2)];
  assert.equal(await store.save(e, 'edit'), true);
  const last = t.log.filter(x => x.options.method === 'POST').pop().body;
  assert.equal(last.expectedRevision, 1); assert.deepEqual(last.item.sources, [{ itemId: ITEM, revision: 3 }]);
  // A generic 409 reloads and keeps the local edit as "latest available".
  store.edit(e); store.updateDraft(e, { title: '내 수정' });
  t.state.responses.push({ status: 409, body: { message: 'conflict' } });
  t.state.items = [t.head(saved.id, 3)];
  assert.equal(await store.save(e, 'edit'), false);
  assert.equal(e.latest.revision, 3); assert.equal(e.draft.title, '내 수정'); assert.equal(e.editing, true);
  store.useLatest(e); assert.equal(e.head.revision, 3); assert.equal(e.latest, null); assert.equal(e.draft.title, '내 수정');
});

test('store refuses writes for read-only, suspended or ended sessions and ends on 401', async () => {
  const t = transport(); const { store } = makeStore(t);
  t.state.me = { sub: 'reader-1', kind: 'member', roles: ['technician'] };
  t.state.items = [t.head('f0000000-0000-4000-8000-000000000001', 1)];
  store.syncHistory(history(A, [])); await tick();
  assert.equal(store.writable(), false); assert.equal(store.newDraft(), null);
  const e = store.state().entries.get('f0000000-0000-4000-8000-000000000001');
  store.edit(e); assert.equal(e.editing, false);
  assert.equal(await store.save(e, 'hide', '사유'), false);
  assert.equal(t.log.filter(x => x.options.method === 'POST').length, 0);
  t.state.meStatus = 401; store.load(); await tick();
  assert.equal(store.state().ended, true); assert.equal(store.state().entries.size, 0);
  assert.equal(store.newDraft(), null);
  store.syncHistory(history(A, [])); await tick();
  assert.equal(store.state().ended, true, 'a later history sync does not revive an ended session');
  const denied = transport(); const kit = makeStore(denied);
  denied.state.responses.push({ status: 403, body: { message: 'no' } });
  kit.store.syncHistory(history(A, [])); await tick();
  assert.equal(kit.store.state().suspended, true); assert.equal(kit.store.state().ended, false);
  assert.equal(kit.store.state().status, '이 검사에 접근할 수 없습니다. 접근 확인 후 Refresh로 다시 불러오세요.');
});

test('store navigation uses the primary or chosen source, ignores a stale result and records refusals', async () => {
  const t = transport(); const kit = makeStore(t); const store = kit.store;
  const saved = t.head('f0000000-0000-4000-8000-000000000001', 1);
  saved.item.sources.push({ ...saved.item.sources[0], itemId: ITEM.replace('1', '2'), sopUid: SOP + '.2', kind: 'key', values: null });
  saved.item.primary = 1; t.state.items = [saved];
  store.syncHistory(history(A, [])); await tick();
  const e = store.state().entries.get(saved.id);
  assert.deepEqual(await store.navigate(e), { ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(kit.navigations[0], { studyUid: A, seriesUid: SERIES, sopUid: SOP + '.2', frame: 1, itemId: ITEM.replace('1', '2') });
  assert.equal(e.message, '');
  assert.equal((await store.navigate(e, 0)).ok, true); assert.equal(kit.navigations[1].sopUid, SOP);
  assert.deepEqual(await store.navigate(e, 5), { ok: false, reason: 'invalid' });
  const refusing = makeStore(t, { navigate: async () => ({ ok: false, reason: 'viewport-unsupported' }) });
  refusing.store.syncHistory(history(A, [])); await tick();
  const f = refusing.store.state().entries.get(saved.id);
  assert.deepEqual(await refusing.store.navigate(f), { ok: false, reason: 'viewport-unsupported' });
  assert.equal(f.message, model.reasonText('viewport-unsupported'));
  const missingTool = makeStore(t, { navigate: undefined });
  missingTool.store.syncHistory(history(A, [])); await tick();
  assert.deepEqual(await missingTool.store.navigate(missingTool.store.state().entries.get(saved.id)), { ok: false, reason: 'tool-missing' });
  // A navigation whose scope changed while the viewer was moving is dropped, message untouched.
  let release; const slow = makeStore(t, { navigate: () => new Promise(resolve => { release = resolve; }) });
  slow.store.syncHistory(history(A, [])); await tick();
  const g = slow.store.state().entries.get(saved.id); g.message = 'before';
  const pending = slow.store.navigate(g);
  slow.store.syncHistory(history(B, [])); await tick();
  release({ ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(await pending, { ok: false, reason: 'superseded' });
  assert.equal(g.message, 'before');
});

/* ---------- held finding drafts (TEST-S2B-PURE-PARK, REQ-S2B-GUARD, RISK-S2B-WORK-LOSS) ----------
 * The shipped store: a study switch, a 403 and a mode exit hold every entry with work as a copy bound
 * to {subject, study}; only the authenticated list of that study restores it; logout destroys it. */
const ITEM2 = '00000000-0000-4000-8000-000000000002', F1 = 'f0000000-0000-4000-8000-000000000001';
const heads2 = () => [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false },
  { id: ITEM2, revision: 1, hidden: false, referenceStatus: null, working: false }];
const counter = () => { let n = 0; return () => 'd0000000-0000-4000-8000-' + String(++n).padStart(12, '0'); };
const posts = t => t.log.filter(x => x.options.method === 'POST');
async function drafting(t, extra) {
  const kit = makeStore(t, Object.assign({ uuid: counter() }, extra));
  kit.store.syncHistory(history(A, heads2())); await tick();
  const e = kit.store.newDraft(); assert.ok(e, 'a writable store creates a draft');
  kit.store.updateDraft(e, { title: '우상엽 결절', text: '6 mm' });
  assert.equal(kit.store.toggleSource(e, ITEM), true); assert.equal(kit.store.toggleSource(e, ITEM2), true); kit.store.setPrimary(e, 1);
  return Object.assign(kit, { e });
}

test('held drafts: an editing draft survives A-B-A as a copy, keeps the viewer dirty while away and returns only with A\'s list', async () => {
  const t = transport(); const { store, e } = await drafting(t);
  const snapshot = plain(e.draft);
  t.state.hold = true;
  store.syncHistory(history(B, [])); await tick();
  assert.equal(store.state().entries.size, 0, 'B never shows the draft of A');
  assert.deepEqual(store.workState(), { dirty: true, busy: false, held: 1 });
  t.release(); await tick();
  assert.equal(store.state().entries.size, 0);
  assert.deepEqual(plain(store.held()), { count: 1, studies: [{ scope: A, count: 1, current: false }] });
  assert.equal(JSON.stringify(store.held()).includes('결절'), false, 'held content is never exposed by the summary');
  // The original object is detached: nothing done to it can come back.
  store.updateDraft(e, { title: 'stale' }); e.draft.text = 'mutated original';
  t.state.hold = true;
  store.syncHistory(history(A, heads2())); await tick();
  assert.equal(store.state().entries.size, 0, 'nothing is restored before the authenticated list of A');
  assert.equal(store.workState().dirty, true);
  t.release(); await tick();
  const back = store.state().entries.get(e.id);
  assert.ok(back && back !== e, 'a copy, never the original object');
  assert.deepEqual(plain(back.draft), snapshot);
  assert.equal(back.draft.primary, 1); assert.equal(back.editing, true); assert.equal(back.pending, null); assert.equal(back.busy, false);
  assert.equal(back.message, '보관했던 작성 내용을 복원했습니다. 저장 전 내용을 확인하세요.');
  assert.deepEqual(plain(store.held()), { count: 0, studies: [] });
  assert.deepEqual(store.workState(), { dirty: true, busy: false, held: 0 });
  store.updateDraft(e, { title: 'late original' }); assert.equal(back.draft.title, '우상엽 결절');
  store.discard(back);
  assert.deepEqual(store.workState(), { dirty: false, busy: false, held: 0 });
});

test('held drafts: a pending 503 create keeps its exact URL and body across A-B-A and Retry reconciles to one finding', async () => {
  const t = transport(); const { store, e } = await drafting(t);
  t.state.responses.push({ status: 503, body: { message: 'delayed' } });
  assert.equal(await store.save(e, 'create'), false);
  assert.ok(e.pending); assert.equal(posts(t)[0].url, '/api/studies/' + A + '/findings');
  store.syncHistory(history(B, [])); await tick();
  assert.deepEqual(store.workState(), { dirty: true, busy: false, held: 1 });
  store.syncHistory(history(A, heads2())); await tick();
  const back = store.state().entries.get(e.id);
  assert.ok(back && back !== e);
  assert.deepEqual(back.pending, { url: e.pending.url, body: e.pending.body });
  assert.equal(back.message, '보관했던 저장 요청을 복원했습니다. Retry Request로 저장 결과를 확인하세요.');
  assert.deepEqual(store.workState(), { dirty: true, busy: true, held: 0 }, 'an unconfirmed request is busy like a pending mark');
  t.state.items = [t.head(F1, 1)];
  assert.equal(await store.save(back), true);
  const [first, retry] = posts(t);
  assert.equal(posts(t).length, 2); assert.equal(retry.url, first.url);
  assert.equal(retry.options.body, first.options.body, 'byte-identical body with the same requestId');
  assert.deepEqual([...store.state().entries.keys()], [F1]); assert.equal(store.state().entries.get(F1), back);
  assert.deepEqual(store.workState(), { dirty: false, busy: false, held: 0 });
});

test('held drafts: a save in flight at the switch cannot touch the held copy; the committed head and Retry leave one finding', async () => {
  const t = transport(); const { store, e } = await drafting(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.state.responses.push(async () => { await gate; return { status: 200, ok: true, json: async () => t.head(F1, 1) }; });
  const saving = store.save(e, 'create'); await tick();
  assert.equal(posts(t).length, 1); assert.equal(e.busy, true);
  assert.deepEqual(store.workState(), { dirty: true, busy: true, held: 0 });
  store.syncHistory(history(B, [])); await tick();
  assert.deepEqual(store.workState(), { dirty: true, busy: false, held: 1 }, 'the held copy is not in flight');
  const copy = () => [...store.state().parked.values()][0].entries[0];
  const heldBody = copy().pending.body;
  assert.equal(heldBody, e.pending.body);
  release(); assert.equal(await saving, false); await tick();
  assert.equal(store.state().entries.size, 0, 'the late answer is not applied in B');
  assert.equal(copy().busy, false); assert.equal(copy().message, ''); assert.equal(copy().pending.body, heldBody); assert.equal(copy().head, null);
  t.state.items = [t.head(F1, 1)];
  store.syncHistory(history(A, heads2())); await tick();
  assert.equal(store.state().entries.size, 2, 'the committed head and the held request both show until Retry');
  assert.equal([...store.state().entries.values()].includes(e), false, 'the original entry is never re-inserted');
  const back = store.state().entries.get(e.id);
  assert.equal(await store.save(back), true);
  assert.deepEqual([...store.state().entries.keys()], [F1]);
  assert.equal(posts(t)[1].options.body, posts(t)[0].options.body);
  assert.equal(store.state().entries.get(F1).head.revision, 1);
});

test('held drafts: a 403 holds every draft of the study without showing it and restores both after an authorized list', async () => {
  const t = transport(); const { store, e } = await drafting(t);
  const other = store.newDraft(); store.updateDraft(other, { title: '두 번째 초안' });
  assert.notEqual(other.id, e.id);
  t.state.responses.push({ status: 403, body: { message: 'no' } });
  assert.equal(await store.save(e, 'create'), false);
  assert.equal(store.state().entries.size, 0);
  assert.equal(store.state().suspended, true); assert.equal(store.state().ended, false);
  assert.equal(store.state().status, '이 검사에 접근할 수 없습니다. 접근 확인 후 Refresh로 다시 불러오세요.');
  assert.deepEqual(plain(store.held()), { count: 2, studies: [{ scope: A, count: 2, current: true }] });
  assert.deepEqual(store.workState(), { dirty: true, busy: false, held: 2 });
  assert.equal(JSON.stringify(store.held()).includes('초안'), false);
  t.state.responses.push({ status: 403, body: { message: 'still no' } });
  await store.load(); await tick();
  assert.equal(store.state().entries.size, 0, 'a refused list restores nothing'); assert.equal(store.held().count, 2);
  await store.load(); await tick();
  const back = store.state().entries.get(e.id), second = store.state().entries.get(other.id);
  assert.ok(back && second && back !== e && second !== other);
  assert.equal(second.draft.title, '두 번째 초안'); assert.equal(second.pending, null); assert.equal(second.editing, true);
  assert.deepEqual(back.pending, { url: e.pending.url, body: e.pending.body }, 'the refused request stays retryable as sent');
  assert.equal(store.held().count, 0);
});

test('held drafts: logout, 401 and another login destroy live and held drafts; nothing crosses to another subject', async () => {
  {
    const t = transport(); const { store } = await drafting(t);
    store.syncHistory(history(B, [])); await tick(); assert.equal(store.held().count, 1);
    store.end();
    assert.equal(store.state().ended, true); assert.equal(store.state().parked.size, 0);
    assert.deepEqual(store.workState(), { dirty: false, busy: false, held: 0 });
    assert.equal(store.newDraft(), null); assert.deepEqual(store.detach(), []); assert.equal(store.discardHeld(), 0);
    store.syncHistory(history(A, heads2())); await tick(); assert.equal(store.state().entries.size, 0);
  }
  {
    const t = transport(); const { store } = await drafting(t);
    store.syncHistory(history(B, [])); await tick();
    t.state.meStatus = 401; store.syncHistory(history(A, heads2())); await tick();
    assert.equal(store.state().ended, true); assert.equal(store.state().parked.size, 0); assert.equal(store.workState().dirty, false);
  }
  {
    const t = transport(); const { store } = await drafting(t);
    store.syncHistory(history(B, [])); await tick();
    t.state.me = { sub: 'reader-2', kind: 'member', roles: ['radiologist'] };
    store.syncHistory(history(A, heads2())); await tick();
    assert.equal(store.state().ended, true); assert.equal(store.state().parked.size, 0); assert.equal(store.workState().dirty, false);
  }
  {
    const t = transport(); const { store } = await drafting(t);
    const records = store.detach(); assert.equal(records.length, 1);
    const next = transport(); next.state.me = { sub: 'reader-2', kind: 'member', roles: ['radiologist'] };
    const kit = makeStore(next, { recovered: records, uuid: counter() });
    assert.equal(kit.store.workState().dirty, true, 'held until the login is known');
    assert.deepEqual(plain(kit.store.held()), { count: 0, studies: [] }, 'no summary before the login is known');
    kit.store.syncHistory(history(A, heads2())); await tick();
    assert.equal(kit.store.state().ended, false); assert.equal(kit.store.state().entries.size, 0);
    assert.deepEqual(kit.store.workState(), { dirty: false, busy: false, held: 0 });
  }
});

test('held drafts: detach hands live and held drafts to the next store as copies; restore waits for its authenticated list', async () => {
  const t = transport(); const { store, e } = await drafting(t);
  t.state.responses.push({ status: 503, body: { message: 'delayed' } });
  assert.equal(await store.save(e, 'create'), false);
  store.syncHistory(history(B, [])); await tick();
  const inB = store.newDraft(); store.updateDraft(inB, { title: 'B 초안' });
  const records = store.detach();
  assert.equal(store.state().ended, true); assert.deepEqual(store.detach(), [], 'a detached store hands over once');
  assert.deepEqual(records.map(r => [r.subject, r.scope, r.entries.length]), [['reader-1', A, 1], ['reader-1', B, 1]]);
  const next = transport(); const kit = makeStore(next, { recovered: records, uuid: counter() });
  records[0].entries[0].draft.title = 'mutated after handover';
  assert.deepEqual(kit.store.workState(), { dirty: true, busy: false, held: 2 });
  next.state.hold = true;
  kit.store.syncHistory(history(A, heads2())); await tick();
  assert.equal(kit.store.state().entries.size, 0, 'no restore while the login and list are unanswered');
  next.release(); await tick();
  const back = kit.store.state().entries.get(e.id);
  assert.equal(back.draft.title, '우상엽 결절'); assert.deepEqual(back.pending, { url: e.pending.url, body: e.pending.body });
  assert.deepEqual(plain(kit.store.held()), { count: 1, studies: [{ scope: B, count: 1, current: false }] });
  assert.equal(kit.store.discardHeld(), 1);
  assert.deepEqual(kit.store.workState(), { dirty: true, busy: true, held: 0 });
  // A read-only login keeps the copies held instead of showing drafts it cannot save.
  const readOnly = transport(); readOnly.state.me = { sub: 'reader-1', kind: 'member', roles: ['technician'] };
  const viewer = makeStore(readOnly, { recovered: records, uuid: counter() });
  viewer.store.syncHistory(history(A, heads2())); await tick();
  assert.equal(viewer.store.state().entries.size, 0); assert.equal(viewer.store.held().count, 2);
});

/* ---------- whole-viewer guards over the shipped panel and consumers (TEST-S2B-PURE-GUARD) ---------- */
const labelled = (h, label) => h.all().filter(e => e.attributes['aria-label'] === label);
const findingsPanel = h => h.all().find(e => e.id === 'kin-viewer-findings');
function findingButton(h, name) {
  const found = findingsPanel(h).all().filter(e => e.tagName === 'button' && e.textContent === name);
  assert.equal(found.length, 1, name); return found[0];
}
const unload = w => { const event = new Event('beforeunload', { cancelable: true }); w.dispatchEvent(event); return event.defaultPrevented; };
async function composeMounted(h, title) {
  findingButton(h, 'New Finding').click(); await flush();
  const [input] = labelled(h, 'Finding Title'); assert.ok(input, 'draft title field');
  input.value = title; input.dispatchEvent(new Event('input'));
  const link = h.all().find(e => String(e.attributes['aria-label'] || '').startsWith('Link Key Image'));
  assert.ok(link, 'the saved key image is linkable'); link.checked = true; link.dispatchEvent(new Event('change')); await flush();
  assert.equal(labelled(h, 'Finding Title')[0].value, title);
}
const shippedFile = name => fs.readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', name), 'utf8');
// Each consumer decision runs from its shipped text: Next Study/retarget, window reuse/close,
// Hanging Protocol Apply, cell merge, and the mark-only Job guard.
function consumers(win) {
  const rw = shippedFile('reading-workspace.js'), html = shippedFile('main.html'), hp = shippedFile('viewer-hanging-protocol.js'), merge = shippedFile('viewer-cell-merge.js');
  const anchor = "for (const name of ['kinViewerJobWorkspaceState', 'kinViewerHistoryWorkspaceState']) {";
  const cuts = [[rw, rw.indexOf('  function viewerState() {'), rw.indexOf('  function request(uid, prior = null, series = null) {')],
    [html, html.indexOf('    function ohifPopupState(popup) {'), html.indexOf('    function openOhifWindow(')],
    [hp, hp.indexOf('function workspaceSafe(){'), hp.indexOf('function urlStudies(){')],
    [merge, merge.indexOf(anchor), merge.indexOf('return null;', merge.indexOf(anchor)) + 'return null;'.length]];
  for (const [, start, end] of cuts) assert.ok(start > 0 && end > start, 'consumer anchor present');
  const text = cuts.map(([file, start, end]) => file.slice(start, end));
  win.location = { href: 'https://pacs.test/ohif/viewer?StudyInstanceUIDs=1.1' };
  win.kinViewerWindowOwner = () => '["hospital","doctor"]';
  win.kinViewerJobWorkspaceState = () => ({ busy: false, dirty: false });
  win.document = { querySelector: () => null };
  const box = { frame: { contentWindow: win, inert: false }, loaded: true, win, root: win,
    KinViewerOpening: { PREFIX: 'p:', key: () => 'p:["hospital","doctor"]' }, KinAuth: { session: () => ({}) },
    ohifScope: href => /^https:\/\/pacs\.test\/ohif\/viewer\?/.test(href) ? { studies: ['1.1'], series: null } : null };
  vm.createContext(box);
  vm.runInContext(text[0] + '\n' + text[1] + '\n' + text[2] + '\nthis.mergeRefusal = function () {' + text[3] + '};', box);
  return () => {
    const popup = plain(box.ohifPopupState(win));
    return { nextStudy: plain(box.viewerState()), windowReuse: { ready: popup.ready, busy: popup.busy, dirty: popup.dirty },
      hangingProtocolApply: box.workspaceSafe(), cellMerge: box.mergeRefusal(), marksOnly: win.kinViewerHistoryHasUnsaved(), unload: unload(win) };
  };
}

test('mounted guard: a finding draft blocks Next Study, window reuse/close, Hanging Protocol and unload, not cell merge or the mark-only Job guard', async () => {
  const h = await mounted({ findings: true }), w = h.window, decide = consumers(w);
  const clean = { nextStudy: { busy: false, dirty: false }, windowReuse: { ready: true, busy: false, dirty: false }, hangingProtocolApply: true, cellMerge: null, marksOnly: false, unload: false };
  assert.deepEqual(decide(), clean, 'a clean viewer keeps every control usable');
  assert.deepEqual(plain(w.kinViewerFindingsState()), { scope: '1.1', dirty: false, busy: false, held: 0 });
  await composeMounted(h, 'discarded draft');
  const dirty = { nextStudy: { busy: false, dirty: true }, windowReuse: { ready: true, busy: false, dirty: true },
    hangingProtocolApply: false, cellMerge: null, marksOnly: false, unload: true };
  assert.deepEqual(decide(), dirty);
  findingButton(h, 'Discard Draft').click(); await flush();
  assert.deepEqual(decide(), clean, 'an explicitly discarded draft releases every control');
  await composeMounted(h, 'guarded draft');
  assert.deepEqual(decide(), dirty);
  // In flight and then unconfirmed (503): busy for the whole-viewer guards, like a pending mark.
  let release; const gate = new Promise(resolve => { release = resolve; }); const original = w.fetch;
  w.fetch = async (url, options) => {
    if (options && options.method === 'POST') { await gate; return { status: 503, ok: false, json: async () => ({ message: 'delayed' }) }; }
    return original(url, options);
  };
  findingButton(h, 'Save').click(); await flush();
  const busy = { nextStudy: { busy: true, dirty: true }, windowReuse: { ready: true, busy: true, dirty: true },
    hangingProtocolApply: false, cellMerge: '저장 또는 영상 작업이 끝난 뒤 다시 시도하세요.', marksOnly: false, unload: true };
  assert.deepEqual(decide(), busy);
  release(); await flush();
  assert.ok(h.text().includes('저장 결과를 확인하지 못했습니다'));
  assert.deepEqual(decide(), busy);
  // An unreadable findings state is uncertainty, not permission.
  const state = w.kinViewerFindingsState; w.kinViewerFindingsState = () => { throw new Error('gone'); };
  assert.deepEqual(plain(w.kinViewerHistoryWorkspaceState()), { dirty: true, busy: true }); assert.equal(unload(w), true);
  w.kinViewerFindingsState = state;
  assert.equal(findingButton(h, 'Retry Request').disabled, false, 'the unconfirmed request stays retryable');
  assert.deepEqual(plain(w.kinViewerFindingsState()), { scope: '1.1', dirty: true, busy: true, held: 0 });
});

test('mounted guard: the Job panel keeps its mark-only guard; only a document-replacing comparison restore refuses unsaved findings', () => {
  const jobs = shippedFile('viewer-jobs.js');
  assert.equal(jobs.split('window.kinViewerHistoryHasUnsaved?.()').length - 1, 3, 'Job save and restore keep the mark-only guard');
  const branch = jobs.indexOf('if (JSON.stringify(job.snapshot.studies) !== JSON.stringify(studies)) {');
  const guard = jobs.indexOf("throw new Error('저장하지 않은 소견 작성 내용이 있어 비교 검사를 열지 않았습니다.");
  const assign = jobs.indexOf('location.assign(next.href)');
  assert.ok(branch > 0 && branch < guard && guard < assign, 'the findings refusal sits in the cross-study branch before navigation');
  assert.equal(jobs.split('kinViewerFindingsState').length - 1, 2, 'no other Job path reads findings');
  const marks = source.slice(source.indexOf('const jobGuard = () =>'), source.indexOf('const findingsWork = () =>'));
  assert.ok(marks.length > 0 && !marks.includes('kinViewerFindingsState'), 'kinViewerHistoryHasUnsaved stays mark-only');
  assert.ok(source.includes('window.kinViewerHistoryHasUnsaved = jobGuard;'));
  assert.equal(source.split('end(true)').length - 1, 1, 'only the history panel mode exit announces kinModeExit');
});

test('mounted mode exit: drafts are held by this document in either exit order, restored after the next authenticated list and dropped by logout', async () => {
  const logout = w => { const ended = new Event('storage'); ended.key = 'kin-session-ended'; w.dispatchEvent(ended); };
  for (const historyFirst of [true, false]) {
    const h = await mounted({ findings: true }), w = h.window, title = 'held across mode exit ' + historyFirst;
    await composeMounted(h, title);
    if (historyFirst) { h.extension.onModeExit(); h.findings.stop(); } else { h.findings.stop(); h.extension.onModeExit(); }
    assert.equal(w.kinViewerFindingsState, undefined); assert.equal(w.kinViewerHistoryWorkspaceState, undefined);
    assert.equal(h.all().some(e => e.id === 'kin-viewer-findings'), false);
    assert.equal(unload(w), true, 'held drafts keep guarding the page between modes');
    h.extension.onModeEnter(); await flush();
    assert.equal(h.findings.mount(), true);
    assert.deepEqual(plain(w.kinViewerFindingsState()), { scope: '', dirty: true, busy: false, held: 1 });
    assert.equal(labelled(h, 'Finding Title').length, 0, 'nothing is shown before the authenticated list');
    await h.switch('1.1');
    const restored = labelled(h, 'Finding Title');
    assert.equal(restored.length, 1); assert.equal(restored[0].value, title);
    assert.ok(h.text().includes('보관했던 작성 내용을 복원했습니다'));
    assert.deepEqual(plain(w.kinViewerHistoryWorkspaceState()), { dirty: true, busy: false });
    logout(w); await flush();
    assert.equal(labelled(h, 'Finding Title').length, 0);
    assert.equal(w.kinViewerFindingsState().dirty, false); assert.equal(unload(w), false);
  }
  // A logout while no section is mounted drops the held drafts as well.
  const h = await mounted({ findings: true }), w = h.window;
  await composeMounted(h, 'dropped by logout');
  h.extension.onModeExit(); h.findings.stop();
  assert.equal(unload(w), true);
  logout(w);
  assert.equal(unload(w), false);
  h.extension.onModeEnter(); await flush();
  assert.equal(h.findings.mount(), true); await h.switch('1.1');
  assert.equal(labelled(h, 'Finding Title').length, 0);
  assert.deepEqual(plain(w.kinViewerFindingsState()), { scope: '1.1', dirty: false, busy: false, held: 0 });
});

test('mounted recovery line: held drafts are named by count and study only and can be discarded explicitly', async () => {
  const h = await mounted({ findings: true }), w = h.window;
  await composeMounted(h, 'secret draft title');
  await h.switch('2.2');
  const line = h.all().find(e => e.id === 'kin-viewer-findings-held');
  assert.equal(line.hidden, false); assert.equal(line.dataset.count, '1');
  assert.ok(line.textContent.includes('1건') && line.textContent.includes('다른 검사 1.1'));
  assert.equal(h.text().includes('secret draft title'), false); assert.equal(labelled(h, 'Finding Title').length, 0);
  assert.equal(w.kinViewerHistoryWorkspaceState().dirty, true);
  let asked = ''; w.confirm = message => { asked = message; return false; };
  findingButton(h, 'Discard Held Drafts').click(); await flush();
  assert.ok(asked.includes('1건')); assert.equal(w.kinViewerHistoryWorkspaceState().dirty, true, 'declined: nothing discarded');
  w.confirm = () => true;
  findingButton(h, 'Discard Held Drafts').click(); await flush();
  assert.equal(w.kinViewerHistoryWorkspaceState().dirty, false); assert.equal(line.hidden, true);
  await h.switch('1.1');
  assert.equal(labelled(h, 'Finding Title').length, 0, 'a discarded draft never returns');
});

/* ---------- S2-B1: the worklist command (finding-command.js) against this mounted production viewer ---------- */
const findingCommand = require('../worklist-v0/hpacs-lite/finding-command.js');
async function worklistCommand(h, source, during) {
  const owner = '["hospital","doctor"]', announced = [];
  const probe = () => {
    const s = typeof h.window.kinViewerHistoryState === 'function' ? h.window.kinViewerHistoryState() : null;
    return { error: false, live: true, owner, sub: 'doctor', uid: '1.1', selection: '1.1', generation: 1, kind: 'window', ref: h.window, window: h.window,
      document: 'viewer-document', scope: '1.1', attached: true, closed: false, visible: true, historyPresent: !!s, ended: s?.ended === true,
      suspended: s?.suspended === true, subject: s?.subject ?? null, windowOwner: owner, modal: false, navigate: typeof h.window.kinViewerHistoryNavigate === 'function' };
  };
  const running = findingCommand.createNavigator({ timeoutMs: 60000 }).run({
    expected: { owner, sub: 'doctor', uid: '1.1', generation: 1 }, source,
    // The exported function is read from the viewer window when the command is sent.
    choose: () => ({ kind: 'window', label: 'window', probe, invoke: target => { const go = h.window.kinViewerHistoryNavigate; return go(target); } }),
    announce: result => announced.push(plain(result)),
  });
  await flush();
  if (during) await during();
  const loads = h.viewport.pending.length;
  if (loads) await h.release();
  return { result: plain(await running), announced, loads };
}
test('mounted viewer: the worklist command reaches the real exported navigation; a switched, ended or foreign target is never arrival', async () => {
  const key = 'a0000000-0000-4000-8000-000000000001';
  const arrived = await mounted();
  assert.deepEqual(await worklistCommand(arrived, findingTarget({ itemId: key })),
    { result: { ok: true, highlighted: false, annotation: 'key', latest: true }, announced: [{ ok: true, highlighted: false, annotation: 'key' }], loads: 1 });
  assert.equal(arrived.viewport.index, 1, 'the saved SOP/frame is shown');
  const switched = await mounted();
  const moved = await worklistCommand(switched, findingTarget({ itemId: key }), () => switched.switch('2.2'));
  assert.deepEqual([moved.result, moved.announced, moved.loads], [{ ok: false, reason: 'superseded', latest: true }, [{ ok: false, reason: 'superseded' }], 1]);
  const ended = await mounted();
  const logout = await worklistCommand(ended, findingTarget(), () => { const e = new Event('storage'); e.key = 'kin-session-ended'; ended.window.dispatchEvent(e); });
  assert.deepEqual([logout.result, logout.loads], [{ ok: false, reason: 'superseded', latest: true }, 1]);
  // A source of another study is refused by the worklist before the viewer is asked at all.
  const foreign = await mounted();
  const refused = await worklistCommand(foreign, findingTarget({ studyUid: '2.2' }));
  assert.deepEqual([refused.result, refused.loads, foreign.viewport.switched], [{ ok: false, reason: 'foreign', latest: true }, 0, undefined]);
  // The viewer stays the scope authority: its own refusal is passed through unchanged.
  const other = await mounted();
  await other.switch('2.2');
  const scope = await worklistCommand(other, findingTarget());
  assert.deepEqual([scope.result, scope.loads, other.viewport.switched], [{ ok: false, reason: 'scope', latest: true }, 0, undefined]);
});

/* ---------- S2-B2 comparison sources (TEST-S2B2-PURE-*: REQ-S2B2-ANCHOR/PICK/NAVIGATE/RETRY/REVOKE) ----------
 * The shipped activation function sliced from config/ohif.js, crossNavigate and the anchored store of
 * finding-link-model.js, then the whole history extension with the Findings section in a two-viewport vm
 * viewer. Grid, viewports and transports are synthetic. */
const XS = '1.1', PS = '2.2';
const textOf = el => el.all().map(e => e.textContent).join('\n');
const waitFor = async (predicate, label, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) { await flush(); if (predicate()) return; assert.ok(Date.now() < end, 'timed out waiting for ' + label); await new Promise(r => setTimeout(r, 10)); }
};

test('activation: exactly one stack viewport showing the study becomes active; none, several, other kinds and errors change nothing', () => {
  assert.equal(source.split('function kinViewerActivateStudy(').length - 1, 1);
  assert.ok(source.includes('const activateStudy = study => kinViewerActivateStudy(navigationEnv, study);'));
  assert.ok(source.includes('window.kinViewerHistoryActivate = activateStudy;'));
  assert.ok(source.includes('if (window.kinViewerHistoryActivate === activateStudy) delete window.kinViewerHistoryActivate;'));
  assert.deepEqual([...shipped.ACTIVATION_REASONS], model.ACTIVATION_REASONS);
  function grid(o) {
    const calls = [], state = { active: 'vp-1', ended: false };
    const sets = { 'ds-x': { StudyInstanceUID: XS }, 'ds-p': { StudyInstanceUID: PS }, 'ds-p2': { StudyInstanceUID: PS } }, views = o.views || {};
    const env = { ended: () => state.ended, services: {
      viewportGridService: {
        getState: () => { if (o.throwGrid) throw new Error('grid'); return { viewports: new Map(Object.entries(o.shows).map(([id, ids]) => [id, { viewportId: id, displaySetInstanceUIDs: ids }])) }; },
        getActiveViewportId: () => state.active, setActiveViewportId: id => { calls.push(id); if (o.throwSet) throw new Error('set'); state.active = id; } },
      displaySetService: { getDisplaySetByUID: id => sets[id] },
      cornerstoneViewportService: { getCornerstoneViewport: id => id in views ? views[id] : { type: 'stack', getImageIds: () => [] } } } };
    return { calls, state, run: study => plain(shipped.activate(env, study)) };
  }
  const two = grid({ shows: { 'vp-1': ['ds-x'], 'vp-2': ['ds-p'] } });
  assert.deepEqual(two.run(PS), { ok: true, viewportId: 'vp-2', changed: true }); assert.deepEqual(two.calls, ['vp-2']);
  assert.deepEqual(two.run(PS), { ok: true, viewportId: 'vp-2', changed: false }); assert.deepEqual(two.calls, ['vp-2'], 'an active viewport is not activated again');
  assert.deepEqual(two.run(XS), { ok: true, viewportId: 'vp-1', changed: true }); assert.deepEqual(two.calls, ['vp-2', 'vp-1']);
  const pair = { 'vp-1': ['ds-x'], 'vp-2': ['ds-p'] };
  const cases = [
    [{ shows: { 'vp-1': ['ds-x'] } }, PS, 'viewport-missing'],
    [{ shows: { 'vp-1': ['ds-x'], 'vp-2': [] } }, PS, 'viewport-missing'],
    [{ shows: { 'vp-1': ['ds-x'], 'vp-2': ['ds-unknown'] } }, PS, 'viewport-missing'],
    [{ shows: pair, views: { 'vp-2': undefined } }, PS, 'viewport-missing'],
    [{ shows: { 'vp-1': ['ds-x'], 'vp-2': ['ds-p'], 'vp-3': ['ds-p2'] } }, PS, 'viewport-ambiguous'],
    [{ shows: { 'vp-1': ['ds-p'], 'vp-2': ['ds-p'] } }, PS, 'viewport-ambiguous'],
    [{ shows: { 'vp-1': ['ds-x', 'ds-p'], 'vp-2': ['ds-p'] } }, PS, 'viewport-ambiguous'],
    [{ shows: pair, views: { 'vp-2': { type: 'orthographic', getImageIds: () => [] } } }, PS, 'viewport-unsupported'],
    [{ shows: pair, views: { 'vp-2': { type: 'stack' } } }, PS, 'viewport-unsupported'],
    [{ shows: pair, throwGrid: true }, PS, 'tool-missing'],
    [{ shows: pair }, 'x', 'invalid'], [{ shows: pair }, undefined, 'invalid'], [{ shows: pair }, '1.' + '2'.repeat(70), 'invalid'],
  ];
  for (const [o, study, reason] of cases) {
    const g = grid(o);
    assert.deepEqual(g.run(study), { ok: false, reason }, reason + ' ' + JSON.stringify(o.shows));
    assert.deepEqual(g.calls, [], reason + ': nothing was activated');
  }
  const ended = grid({ shows: pair }); ended.state.ended = true;
  assert.deepEqual(ended.run(PS), { ok: false, reason: 'ended' }); assert.deepEqual(ended.calls, []);
  const thrown = grid({ shows: pair, throwSet: true });
  assert.deepEqual(thrown.run(PS), { ok: false, reason: 'tool-missing', changed: true }, 'a throwing grid may already have moved');
});

function crossKit(o) {
  const opts = o || {};
  const log = [], phases = [];
  const view = { scope: XS, subject: 'reader-1', ended: false, suspended: false, loading: false, generation: 4, viewportId: 'vp-x',
    image: { study: XS, seriesUid: '1.2', sopUid: '1.3', frame: 1 }, heads: [] };
  Object.assign(view, opts.view);
  const target = { studyUid: PS, seriesUid: '2.3', sopUid: '2.6', frame: 1, itemId: ITEM };
  // Applied after each wait: the grid moves, the history resets and loads the comparison study.
  const script = opts.script || [
    s => Object.assign(s, { viewportId: 'vp-p' }),
    s => Object.assign(s, { scope: PS, suspended: true, loading: true, generation: 5, image: { study: PS, seriesUid: '2.3', sopUid: '2.4', frame: 1 } }),
    s => Object.assign(s, { suspended: false, loading: false }),
  ];
  let polls = 0, stop = null;
  const env = {
    state: () => { log.push('state'); if (opts.state) return opts.state(view); return { ...view, image: view.image && { ...view.image } }; },
    activate: study => { log.push(['activate', study]); if (opts.activateThrows) throw new Error('gone'); return 'activation' in opts ? opts.activation : { ok: true, viewportId: 'vp-p', changed: true }; },
    navigate: async t => {
      log.push(['navigate', plain(t)]);
      if (opts.navigateThrows) throw new Error('gone');
      const answer = 'answer' in opts ? opts.answer : { ok: true, highlighted: false, annotation: 'key' };
      if (answer && answer.ok && !opts.noMove) view.image = { study: t.studyUid, seriesUid: t.seriesUid, sopUid: t.sopUid, frame: t.frame };
      if (opts.during) opts.during(view, value => { stop = value; });
      return answer;
    },
  };
  const control = { stopped: () => stop, phase: name => phases.push(name),
    wait: async ms => { assert.equal(ms, 100); polls++; log.push('wait'); const step = script[polls - 1]; if (step) step(view); if (opts.onWait) opts.onWait(polls, view, value => { stop = value; }); } };
  return { env, control, view, target, log, phases, polls: () => polls, setStop: value => { stop = value; },
    run: async t => plain(await model.crossNavigate(env, t === undefined ? target : t, control)) };
}
const navigated = log => log.filter(x => Array.isArray(x) && x[0] === 'navigate').map(x => x[1]);
const activated = log => log.filter(x => Array.isArray(x) && x[0] === 'activate').map(x => x[1]);

test('cross navigation: activation, a delayed history reload of that viewport, one navigation call and the exact frame read back', async () => {
  const kit = crossKit();
  assert.deepEqual(await kit.run(), { ok: true, highlighted: false, annotation: 'key' });
  assert.deepEqual(activated(kit.log), [PS]);
  assert.deepEqual(navigated(kit.log), [kit.target], 'the frozen target, never another study or frame');
  assert.equal(kit.polls(), 3); assert.deepEqual(kit.phases, ['activated', 'navigating']);
  // The comparison viewport is already active and loaded: no wait, and the display was not moved by activation.
  const ready = crossKit({ view: { scope: PS, viewportId: 'vp-p', generation: 9, image: { study: PS, seriesUid: '2.3', sopUid: '2.4', frame: 1 } },
    activation: { ok: true, viewportId: 'vp-p', changed: false } });
  assert.equal((await ready.run()).ok, true);
  assert.deepEqual([ready.polls(), ready.phases], [0, ['navigating']]);
  // The target viewport is already active but the history has not scanned it yet: waited for, not refused.
  const lagging = crossKit({ view: { viewportId: 'vp-p' }, activation: { ok: true, viewportId: 'vp-p', changed: false },
    script: [s => Object.assign(s, { scope: PS, generation: 6 })] });
  assert.equal((await lagging.run()).ok, true); assert.deepEqual([lagging.polls(), lagging.phases], [1, ['navigating']]);
  // A history that is still loading when the command starts is busy before anything is asked (B1 pre-call rule).
  const loading = crossKit({ view: { scope: PS, viewportId: 'vp-p', suspended: true, loading: true } });
  assert.deepEqual(await loading.run(), { ok: false, reason: 'busy' }); assert.deepEqual(activated(loading.log), []);
});

test('cross navigation: refusals before or at activation call nothing further and claim no display change', async () => {
  const cases = [
    [{}, null, 'invalid', 0], [{}, { ...crossKit().target, frame: 0 }, 'invalid', 0], [{}, { ...crossKit().target, studyUid: 'x' }, 'invalid', 0],
    [{ state: () => null }, undefined, 'tool-missing', 0], [{ state: () => ({ scope: XS }) }, undefined, 'tool-missing', 0],
    [{ state: () => { throw new Error('gone'); } }, undefined, 'tool-missing', 0],
    [{ view: { ended: true } }, undefined, 'ended', 0], [{ view: { suspended: true } }, undefined, 'busy', 0],
  ];
  for (const [o, t, reason, calls] of cases) {
    const kit = crossKit(o);
    assert.deepEqual(await kit.run(t), { ok: false, reason }, reason);
    assert.equal(activated(kit.log).length, calls, reason); assert.deepEqual(navigated(kit.log), []); assert.deepEqual(kit.phases, []);
  }
  const stopped = crossKit(); stopped.setStop('superseded');
  assert.deepEqual(await stopped.run(), { ok: false, reason: 'superseded' }); assert.deepEqual(activated(stopped.log), []);
  for (const [activation, reason, phases] of [
    [{ ok: false, reason: 'viewport-missing' }, 'viewport-missing', []], [{ ok: false, reason: 'viewport-ambiguous' }, 'viewport-ambiguous', []],
    [{ ok: false, reason: 'viewport-unsupported' }, 'viewport-unsupported', []], [{ ok: false, reason: 'ended' }, 'ended', []],
    [{ ok: false, reason: 'scope' }, 'tool-missing', []], [{ ok: true }, 'tool-missing', []], [null, 'tool-missing', []],
    [{ ok: false, reason: 'tool-missing', changed: true }, 'tool-missing', ['activated']],
  ]) {
    const kit = crossKit({ activation });
    assert.deepEqual(await kit.run(), { ok: false, reason }, JSON.stringify(activation));
    assert.deepEqual(navigated(kit.log), []); assert.deepEqual(kit.phases, phases); assert.equal(kit.polls(), 0);
  }
  const thrown = crossKit({ activateThrows: true });
  assert.deepEqual(await thrown.run(), { ok: false, reason: 'tool-missing' }); assert.deepEqual(thrown.phases, []);
});

test('cross navigation: another active viewport, A-B-A, login change, refusal, timeout or supersession while waiting never navigates', async () => {
  const cases = [
    ['user picks another viewport after activation', [s => Object.assign(s, { viewportId: 'vp-p' }), s => Object.assign(s, { viewportId: 'vp-3' })], 'superseded'],
    ['layout moves to a third viewport first', [s => Object.assign(s, { viewportId: 'vp-3' })], 'superseded'],
    ['A-B-A of the active viewport', [s => Object.assign(s, { viewportId: 'vp-p' }), s => Object.assign(s, { viewportId: 'vp-x' }), s => Object.assign(s, { viewportId: 'vp-p', scope: PS, generation: 7 })], 'superseded'],
    ['another login', [s => Object.assign(s, { viewportId: 'vp-p', subject: 'reader-2' })], 'superseded'],
    ['session ended', [s => Object.assign(s, { viewportId: 'vp-p', ended: true, subject: '' })], 'ended'],
    ['unreadable history', [s => Object.assign(s, { viewportId: 'vp-p', generation: 'x' })], 'tool-missing'],
    ['comparison history refused or holding parked marks', [s => Object.assign(s, { viewportId: 'vp-p' }), s => Object.assign(s, { scope: PS, suspended: true, loading: false, generation: 5 })], 'busy'],
  ];
  for (const [label, script, reason] of cases) {
    const kit = crossKit({ script });
    assert.deepEqual(await kit.run(), { ok: false, reason }, label);
    assert.deepEqual(navigated(kit.log), [], label); assert.deepEqual(kit.phases, ['activated'], label);
  }
  // The caller's 15 s bound or a newer command stops the wait; a history that becomes ready later is not used.
  for (const value of ['timeout', 'superseded']) {
    const kit = crossKit({ onWait: (n, view, stop) => { if (n === 2) stop(value); } });
    assert.deepEqual(await kit.run(), { ok: false, reason: value });
    Object.assign(kit.view, { scope: PS, suspended: false, loading: false, generation: 8 });
    await flush();
    assert.deepEqual(navigated(kit.log), [], value); assert.deepEqual(kit.phases, ['activated'], value);
  }
});

test('cross navigation: after the call only the viewer ok plus the same generation, viewport and exact image is success', async () => {
  const passes = await crossKit({ answer: { ok: false, reason: 'series-missing' } }).run();
  assert.deepEqual(passes, { ok: false, reason: 'series-missing' });
  const cases = [
    [{ answer: { ok: true } }, 'invalid'], [{ answer: { ok: false, reason: 'viewport-missing' } }, 'invalid'], [{ answer: null }, 'invalid'],
    [{ navigateThrows: true }, 'tool-missing'],
    [{ noMove: true }, 'frame-missing'],
    [{ during: view => { view.generation++; } }, 'superseded'],
    [{ during: view => { view.viewportId = 'vp-x'; } }, 'superseded'],
    [{ during: view => { view.suspended = true; } }, 'superseded'],
    [{ during: view => { view.scope = XS; } }, 'superseded'],
    [{ during: view => { view.subject = 'reader-2'; } }, 'superseded'],
    [{ during: view => { view.ended = true; } }, 'superseded'],
    [{ during: view => { view.image = { ...view.image, frame: 2 }; } }, 'frame-missing'],
    [{ during: view => { view.image = { ...view.image, sopUid: '2.4' }; } }, 'frame-missing'],
    [{ during: view => { view.image = null; } }, 'frame-missing'],
    [{ during: (view, stop) => stop('superseded') }, 'superseded'],
    [{ during: (view, stop) => stop('timeout') }, 'timeout'],
  ];
  for (const [o, reason] of cases) {
    const kit = crossKit(o);
    assert.deepEqual(await kit.run(), { ok: false, reason }, JSON.stringify(o) + ' ' + String(o.during));
    assert.equal(navigated(kit.log).length, 1); assert.deepEqual(kit.phases, ['activated', 'navigating']);
  }
  assert.deepEqual(model.CROSS_REASONS.filter(r => !model.reasonText(r) || model.reasonText(r) === model.reasonText('nope')), ['invalid']);
  assert.equal(model.phaseText('before'), ''); assert.ok(model.phaseText('activated').includes('자동으로 되돌리지 않습니다'));
  assert.ok(model.phaseText('navigating').includes('이미 이동했을 수 있으니'));
});

/* The anchored store: studies [A, B] as in the URL of a comparison viewer. */
const P1 = '00000000-0000-4000-8000-00000000b001', P2 = '00000000-0000-4000-8000-00000000b002', F2 = 'f0000000-0000-4000-8000-000000000002';
const pItem = (id, revision, extra) => Object.assign({ id, studyUid: B, authorSub: 'reader-1', authorActor: 'Reader', revision, hidden: false, createdAt: 't', updatedAt: 't',
  item: { schemaVersion: 1, kind: 'key', seriesUid: '4.5.6.1', sopUid: '4.5.6.1.2', frame: 1, title: 'P비교키', description: '', hidden: false } }, extra);
const pCopy = (id, revision) => ({ itemId: id, revision, studyUid: B, kind: 'key', seriesUid: '4.5.6.1', sopUid: '4.5.6.1.2', frame: 1, frameOfReferenceUid: null,
  label: 'P비교키', values: null, calculator: null, sourceDigest: null, authorActor: 'Reader' });
function pairTransport() {
  const t = transport(), base = t.fetch;
  const pair = { items: [pItem(P1, 1), pItem(P2, 3)], status: 200, manual: false, calls: [] };
  const answer = (status, items) => ({ status, ok: status === 200, json: async () => status === 200 ? { items, nextCursor: null } : { message: 'refused' } });
  t.fetch = async (url, options) => {
    if (!url.startsWith('/api/studies/' + B + '/viewer-items')) return base(url, options);
    t.log.push({ url, options, body: null });
    if (pair.manual) return new Promise(resolve => pair.calls.push((status, items) => resolve(answer(status, items))));
    return answer(typeof pair.status === 'function' ? pair.status() : pair.status, pair.items);
  };
  t.pair = pair;
  t.cross = (id, revision, extra) => t.head(id, revision, Object.assign({ item: { schemaVersion: 1, title: 'T', text: 'X', hidden: false, primary: 0,
    sources: [t.head(id, 1).item.sources[0], pCopy(P1, 1)] }, links: [{ itemId: ITEM, linkState: 'current', headRevision: 2, headHidden: false },
    { itemId: P1, linkState: 'current', headRevision: 1, headHidden: false }] }, extra));
  return t;
}
const reads = (t, study, kind) => t.log.filter(x => (x.options?.method || 'GET') === 'GET' && x.url.startsWith('/api/studies/' + study + '/' + kind)).length;
async function anchored(t, extra) {
  const kit = makeStore(t, Object.assign({ uuid: counter(), studies: [A, B] }, extra));
  kit.store.syncHistory(history(A, heads2())); await tick(40);
  return kit;
}

test('anchored store: the comparison viewport keeps entries, drafts, pending bodies and generation; only a study outside the pair re-anchors', async () => {
  const t = pairTransport(); t.state.items = [t.head(F1, 1)];
  const { store } = await anchored(t);
  assert.deepEqual([store.state().scope, store.pairOf(), store.anchorLive()], [A, B, true]);
  assert.deepEqual(t.log.map(x => x.url), ['/api/me', '/api/studies/' + A + '/findings?includeHidden=true&limit=100', '/api/studies/' + B + '/viewer-items?limit=100']);
  assert.equal(store.state().pair.status, 'ready'); assert.deepEqual([...store.state().pair.heads.keys()], [P1, P2]);
  assert.deepEqual(plain(store.state().pair.heads.get(P1)), { id: P1, studyUid: B, revision: 1, hidden: false, kind: 'key', label: 'P비교키', seriesUid: '4.5.6.1',
    sopUid: '4.5.6.1.2', frame: 1, authorSub: 'reader-1', referenceStatus: null, values: null, working: false });
  const saved = store.state().entries.get(F1);
  const e = store.newDraft(); store.updateDraft(e, { title: '비교 소견', text: '본문' });
  assert.equal(store.toggleSource(e, ITEM), true);
  assert.equal(store.toggleSource(e, P1, 'other-study'), false, 'only the pair study');
  assert.equal(store.toggleSource(e, P1, B), true);
  assert.deepEqual(e.draft.sources, [{ itemId: ITEM, revision: 2 }, { itemId: P1, revision: 1, studyUid: B }]);
  assert.equal(store.studyOf(e, e.draft.sources[1]), B); assert.equal(store.comparisonOf(e), B);
  t.state.responses.push({ status: 503, body: { message: 'delayed' } });
  assert.equal(await store.save(e, 'create'), false);
  const pendingBody = e.pending.body, generation = store.state().generation;
  assert.deepEqual(JSON.parse(pendingBody), { requestId: 'd0000000-0000-4000-8000-000000000002', item: { schemaVersion: 1, title: '비교 소견', text: '본문', primary: 0,
    sources: [{ itemId: ITEM, revision: 2 }, { itemId: P1, revision: 1 }] } }, 'only {itemId, revision} pairs are sent');
  // The comparison viewport becomes active: nothing is parked, reset or re-keyed; its saved list is read again.
  store.syncHistory(history(B, [{ id: P1, revision: 1, hidden: false, referenceStatus: null, working: true }, { id: P2, revision: 3, hidden: false, referenceStatus: null, working: false }]));
  await tick(40);
  assert.deepEqual([store.state().scope, store.state().generation, store.anchorLive()], [A, generation, false]);
  assert.equal(store.state().entries.get(e.id), e); assert.equal(store.state().entries.get(F1), saved);
  assert.equal(e.pending.body, pendingBody); assert.equal(e.draft.title, '비교 소견');
  assert.deepEqual(plain(store.held()), { count: 0, studies: [] }); assert.deepEqual(store.workState(), { dirty: true, busy: true, held: 0 });
  assert.equal(reads(t, B, 'viewer-items'), 2); assert.equal(reads(t, A, 'findings'), 1, 'no anchor reload on activation');
  const d = store.newDraft();
  assert.equal(store.toggleSource(d, ITEM2), false, 'anchor heads need the anchor viewport');
  assert.equal(store.toggleSource(d, P1, B), false, 'an item being edited in the comparison viewport');
  assert.equal(store.toggleSource(d, P2, B), true); assert.deepEqual(d.draft.sources, [{ itemId: P2, revision: 3, studyUid: B }]);
  // Retry while the comparison is active replays the byte-identical body.
  t.state.responses.push({ status: 200, body: t.cross(F2, 1) }); t.state.items = [t.head(F1, 1), t.cross(F2, 1)];
  assert.equal(await store.save(e), true);
  assert.equal(posts(t).length, 2); assert.equal(posts(t)[1].options.body, pendingBody);
  assert.equal(store.state().entries.get(F2), e); assert.deepEqual(e.draft.sources, [{ itemId: ITEM, revision: 2 }, { itemId: P1, revision: 1, studyUid: B }]);
  // Back on the anchor viewport nothing moves either.
  store.syncHistory(history(A, heads2())); await tick(40);
  assert.deepEqual([store.state().generation, store.anchorLive(), store.state().entries.get(d.id) === d], [generation, true, true]);
  // A study outside the pair is a real anchor change: the B1 parking and isolation apply.
  t.state.items = [];
  store.syncHistory(history('7.7.7', [])); await tick(40);
  assert.deepEqual([store.state().scope, store.pairOf(), store.state().entries.size], ['7.7.7', '', 0]);
  assert.deepEqual(plain(store.held()), { count: 1, studies: [{ scope: A, count: 1, current: false }] });
  const cleared = store.state().pair;
  assert.deepEqual([cleared.status, cleared.heads.size, cleared.working.size, cleared.key, cleared.refused], ['none', 0, 0, '', false]);
});

test('comparison list: late, superseded, other-login and other-anchor answers are dropped; 403/404 clears it, re-reads the anchor once and blocks new commands', async () => {
  {
    const t = pairTransport(); t.state.items = [t.head(F1, 1)];
    const { store } = await anchored(t);
    t.pair.manual = true;
    store.loadPair(); await tick();
    store.syncHistory(history(B, [{ id: P2, revision: 4, hidden: false, referenceStatus: null, working: false }])); await tick();
    assert.equal(t.pair.calls.length, 2); assert.equal(store.state().pair.status, 'loading');
    t.pair.calls[1](200, [pItem(P2, 4)]); await tick();
    t.pair.calls[0](200, [pItem(P1, 1), pItem(P2, 3)]); await tick();
    assert.deepEqual([...store.state().pair.heads.values()].map(h => [h.id, h.revision]), [[P2, 4]], 'only the newest answer');
    // A pending read, then a real anchor change: the late heads never appear under the new anchor.
    store.loadPair(); await tick();
    store.syncHistory(history('7.7.7', [])); await tick();
    t.pair.calls[2](200, [pItem(P1, 9)]); await tick();
    assert.equal(store.state().pair.heads.size, 0); assert.equal(store.state().pair.status, 'none');
  }
  {
    const t = pairTransport(); t.state.items = [t.head(F1, 1)];
    const { store } = await anchored(t);
    t.pair.manual = true; store.loadPair(); await tick();
    t.state.me = { sub: 'reader-2', kind: 'member', roles: ['radiologist'] }; await store.load(); await tick();
    assert.equal(store.state().ended, true);
    t.pair.calls[0](200, [pItem(P1, 9)]); await tick();
    assert.equal(store.state().pair.heads.size, 0, 'another login ends the store and drops the late list');
  }
  {
    const t = pairTransport(); t.state.items = [t.head(F1, 1)];
    const { store } = await anchored(t);
    for (const [status, items, expected] of [[503, [], 'failed'], [200, [pItem(P1, 1, { studyUid: A })], 'failed'], [200, [pItem('bad', 1)], 'failed']]) {
      t.pair.status = status; t.pair.items = items;
      const before = reads(t, A, 'findings');
      await store.loadPair(); await tick();
      assert.deepEqual([store.state().pair.status, store.state().pair.heads.size, reads(t, A, 'findings')], [expected, 0, before], JSON.stringify(items));
    }
  }
  for (const status of [403, 404]) {
    const t = pairTransport(); t.state.items = [t.head(F1, 1), t.cross(F2, 1)];
    const { store } = await anchored(t);
    const lost = store.state().entries.get(F2);
    store.edit(lost); store.updateDraft(lost, { text: '내 수정' }); store.toggleSource(lost, P1, B); store.toggleSource(lost, P2, B);
    assert.deepEqual(lost.draft.sources, [{ itemId: ITEM, revision: 2 }, { itemId: P2, revision: 3, studyUid: B }]);
    const fresh = store.newDraft(); store.updateDraft(fresh, { title: '새 초안' }); store.toggleSource(fresh, P2, B);
    // The comparison study is withdrawn: its list is refused and the server no longer lists F2.
    t.pair.status = status; t.state.items = [t.head(F1, 1)];
    const before = reads(t, A, 'findings');
    await store.loadPair(); await tick(60);
    assert.deepEqual([store.state().pair.status, store.state().pair.heads.size], ['denied', 0]);
    assert.equal(reads(t, A, 'findings'), before + 1, 'exactly one anchor re-read, no loop');
    assert.equal(store.state().entries.has(F2), false);
    assert.equal(store.state().entries.get(lost.id), lost); assert.notEqual(lost.id, F2);
    assert.deepEqual(plain(lost.draft), { title: 'T', text: '내 수정', sources: [{ itemId: ITEM, revision: 2 }], primary: 0 });
    assert.deepEqual([lost.head, lost.links, lost.latest, lost.pending, lost.editing], [null, [], null, null, true]);
    assert.ok(lost.message.startsWith('이 소견을 더 이상 볼 수 없어'));
    const shown = JSON.stringify(plain([...store.state().entries.values()].map(x => ({ head: x.head, draft: x.draft, links: x.links, message: x.message }))));
    for (const secret of ['P비교키', '4.5.6.1.2', P1, F2]) assert.equal(shown.includes(secret), false, secret);
    assert.equal(shown.includes(P2), true, 'the unsaved pair of the fresh draft stays until the user unlinks it');
    // New comparison picks and saves that still name the withdrawn study are refused without a request.
    const other = store.newDraft(); store.updateDraft(other, { title: 'x' });
    assert.equal(store.toggleSource(other, P1, B), false);
    const postsBefore = posts(t).length;
    assert.equal(await store.save(fresh, 'create'), false);
    assert.equal(fresh.message, '비교 검사에 접근할 수 없어 이 소견을 저장·수정하지 않았습니다. 비교 검사 표식 연결을 해제하거나 접근을 확인한 뒤 다시 시도하세요.');
    assert.equal(posts(t).length, postsBefore);
    assert.equal(store.toggleSource(fresh, P2), true, 'Unlink still works'); store.toggleSource(fresh, ITEM);
    t.state.responses.push({ status: 200, body: t.head(F1, 1) });
    assert.equal(await store.save(fresh, 'create'), true, 'an anchor-only draft saves');
    // Another denial in a row reads the anchor list no more.
    const again = reads(t, A, 'findings');
    await store.loadPair(); await tick(40);
    assert.equal(reads(t, A, 'findings'), again);
  }
});

test('comparison saves: 400/403/404/409 and quota texts keep the draft; a comparison 403 re-checks the anchor instead of holding drafts', async () => {
  const t = pairTransport(); t.state.items = [t.head(F1, 1)];
  const { store } = await anchored(t);
  const e = store.newDraft(); store.updateDraft(e, { title: '비교' }); store.toggleSource(e, ITEM); store.toggleSource(e, P1, B);
  const cases = [
    [{ status: 400, body: { message: '같은 환자의 검사만 소견에 연결할 수 있습니다' } }, '같은 환자의 비교 검사 하나만 연결할 수 있습니다', 0, 0],
    [{ status: 409, body: { code: 'FINDING_COMPARISON_STUDY' } }, '이미 다른 비교 검사가 연결된 적이 있어', 0, 0],
    // Every anchor list read also refreshes the comparison list.
    [{ status: 409, body: { code: 'FINDING_STORAGE_LIMIT' } }, '한도에는 이 화면에 표시되지 않는 소견도 포함됩니다', 1, 1],
    [{ status: 404, body: { message: '연결할 표식이 이 검사에 없습니다' } }, '그 검사에 더 이상 접근할 수 없습니다', 0, 1],
    [{ status: 403, body: { message: '소견에 접근할 수 없습니다' } }, '다른 기관 소속이거나 접근할 수 없어', 1, 1],
  ];
  for (const [answer, text, anchorReads, pairReads] of cases) {
    const a = reads(t, A, 'findings'), p = reads(t, B, 'viewer-items');
    t.state.responses.push(answer);
    assert.equal(await store.save(e, 'create'), false); await tick(40);
    assert.ok(e.message.includes(text), text + ' / ' + e.message);
    assert.deepEqual([e.pending, e.editing, store.state().entries.get(e.id) === e, store.state().suspended, store.held().count], [null, true, true, false, 0], text);
    assert.deepEqual([reads(t, A, 'findings') - a, reads(t, B, 'viewer-items') - p], [anchorReads, pairReads], text);
  }
  assert.equal(model.errorMessage({ status: 404 }), '연결한 표식이 이 검사에 없습니다. 작성 내용은 저장되지 않았습니다.', 'same-study text unchanged');
  assert.equal(model.errorMessage({ status: 400 }), '입력 길이와 연결 표식을 확인하세요. 작성 내용은 저장되지 않았습니다.');
  assert.equal(model.errorMessage({ status: 403 }), '저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.');
  // The comparison 403 was really the anchor: the re-read denies and holds the draft as in B1.
  t.state.responses.push({ status: 403, body: {} }, { status: 403, body: {} });
  assert.equal(await store.save(e, 'create'), false); await tick(40);
  assert.deepEqual([store.state().suspended, store.state().entries.size, store.held().count], [true, 0, 1]);
  assert.equal(store.state().status, '이 검사에 접근할 수 없습니다. 접근 확인 후 Refresh로 다시 불러오세요.');
  // A same-study 403 still holds at once (B1), without an extra list read.
  const u = pairTransport(); u.state.items = [];
  const same = await anchored(u);
  const x = same.store.newDraft(); same.store.updateDraft(x, { title: 'x' }); same.store.toggleSource(x, ITEM);
  const before = reads(u, A, 'findings');
  u.state.responses.push({ status: 403, body: {} });
  assert.equal(await same.store.save(x, 'create'), false); await tick(40);
  assert.deepEqual([same.store.state().suspended, same.store.held().count, reads(u, A, 'findings')], [true, 1, before]);
  // An entry that already names another comparison study cannot pick from this one.
  const w = pairTransport(), other = w.head(F1, 1); other.item.sources = [{ ...pCopy(P1, 1), studyUid: '9.9.9' }];
  w.state.items = [other];
  const blocked = await anchored(w);
  const f = blocked.store.state().entries.get(F1);
  blocked.store.edit(f);
  assert.equal(blocked.store.comparisonOf(f), '9.9.9');
  assert.equal(blocked.store.toggleSource(f, P2, B), false);
  assert.deepEqual(f.draft.sources, [{ itemId: P1, revision: 1, studyUid: '9.9.9' }]);
});

test('lost findings: 404 on an edit, a pending hide and a restored held copy of a withdrawn finding leave no copied content', async () => {
  const t = pairTransport(); t.state.items = [t.head(F1, 1), t.cross(F2, 1)];
  const { store } = await anchored(t);
  const e = store.state().entries.get(F2);
  store.edit(e); store.updateDraft(e, { title: '내 제목' });
  t.state.responses.push({ status: 404, body: { message: '소견이 없습니다' } }); t.state.items = [t.head(F1, 1)];
  assert.equal(await store.save(e, 'edit'), false); await tick(40);
  assert.deepEqual([e.head, e.pending, e.editing, store.state().entries.has(F2)], [null, null, true, false]);
  assert.deepEqual(e.draft.sources, [{ itemId: ITEM, revision: 2 }]); assert.equal(e.draft.title, '내 제목');
  assert.ok(e.message.startsWith('이 소견을 더 이상 볼 수 없어'));
  // A 404 on an edit of a finding that is still listed is only an item refusal.
  t.state.items = [t.head(F1, 1), t.cross(F2, 1)]; await store.load(); await tick(40);
  const again = store.state().entries.get(F2);
  store.edit(again);
  t.state.responses.push({ status: 404, body: {} });
  assert.equal(await store.save(again, 'edit'), false); await tick(40);
  assert.equal(store.state().entries.get(F2), again); assert.ok(again.head);
  assert.ok(again.message.includes('그 검사에 더 이상 접근할 수 없습니다'));
  store.discard(again);
  // A hide whose answer was lost, then the finding is withdrawn: dropped with a note, no draft invented.
  t.state.responses.push({ status: 503, body: {} });
  assert.equal(await store.save(again, 'hide', '숨김'), false); assert.ok(again.pending);
  t.state.items = [t.head(F1, 1)]; await store.load(); await tick(40);
  assert.equal(store.state().entries.has(F2), false);
  assert.equal([...store.state().entries.values()].filter(x => !x.head).length, 1, 'only the earlier converted draft');
  assert.ok(store.state().status.includes('더 이상 볼 수 없어 목록에서 뺐습니다'));
  // A held copy of that finding (parked by a real anchor change) is converted the same way after its list.
  const u = pairTransport(); u.state.items = [u.head(F1, 1), u.cross(F2, 1)];
  const kit = await anchored(u);
  const h = kit.store.state().entries.get(F2); kit.store.edit(h); kit.store.updateDraft(h, { text: '보관 수정' });
  kit.store.syncHistory(history('7.7.7', [])); await tick(40);
  u.state.items = [u.head(F1, 1)];
  kit.store.syncHistory(history(A, heads2())); await tick(60);
  const back = [...kit.store.state().entries.values()].find(x => !x.head);
  assert.ok(back); assert.deepEqual(plain(back.draft), { title: 'T', text: '보관 수정', sources: [{ itemId: ITEM, revision: 2 }], primary: 0 });
  assert.equal(kit.store.state().entries.has(F2), false);
});

function fakeClock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimeout: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: key => { timers.delete(key); },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await tick(4);
      }
      now = end; await tick(4);
    },
  };
}
function viewerDouble() {
  const v = { view: { scope: A, subject: 'reader-1', ended: false, suspended: false, loading: false, generation: 1, viewportId: 'vp-a', image: null, heads: [] },
    activations: [], calls: [], ready: true, answer: { ok: true, highlighted: false, annotation: 'key' } };
  v.history = () => ({ ...v.view });
  v.activate = study => {
    v.activations.push(study);
    if (study !== B) return { ok: false, reason: 'viewport-missing' };
    v.view.viewportId = 'vp-b';
    if (v.ready) Object.assign(v.view, { scope: B, generation: v.view.generation + 1 });
    return { ok: true, viewportId: 'vp-b', changed: true };
  };
  v.navigate = async target => {
    v.calls.push(plain(target));
    if (v.gate) await v.gate;
    if (target.studyUid !== v.view.scope) return { ok: false, reason: 'scope' };
    v.view.image = { study: target.studyUid, seriesUid: target.seriesUid, sopUid: target.sopUid, frame: target.frame };
    return v.answer;
  };
  return v;
}

test('store comparison Go to Image: arrival text, 15 s bound, newest wins, the anchor source while the comparison is active, and nothing outside the pair', async () => {
  const t = pairTransport(); t.state.items = [t.head(F1, 1), t.cross(F2, 1)];
  const c = fakeClock(), v = viewerDouble();
  const { store } = await anchored(t, { setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, history: v.history, activate: v.activate, navigate: v.navigate });
  const e = store.state().entries.get(F2);
  const target = { studyUid: B, seriesUid: '4.5.6.1', sopUid: '4.5.6.1.2', frame: 1, itemId: P1 };
  assert.deepEqual(await store.navigate(e, 1), { ok: true, highlighted: false, annotation: 'key', phase: 'navigating' });
  assert.deepEqual([v.activations, v.calls], [[B], [target]]);
  assert.equal(e.message, '비교 검사 영상 칸에서 원본 프레임으로 이동했습니다. 키 이미지 프레임으로 이동했습니다.');
  assert.equal(c.pending(), 0, 'no timer survives');
  // The history never loads the study: the bound answers timeout and nothing navigates later.
  Object.assign(v.view, { scope: A, viewportId: 'vp-a' }); v.ready = false;
  const waiting = store.navigate(e, 1); await tick();
  await c.advance(14999); assert.equal(v.calls.length, 1);
  await c.advance(1);
  const pending = Symbol('pending');
  assert.deepEqual(await Promise.race([waiting, tick(10).then(() => pending)]), { ok: false, reason: 'timeout', phase: 'activated' }, 'settled at the 15 s bound');
  assert.equal(e.message, model.reasonText('timeout') + model.phaseText('activated'));
  Object.assign(v.view, { scope: B, generation: 9 }); await c.advance(1000);
  assert.equal(v.calls.length, 1, 'no navigation after the bound');
  assert.equal(v.view.viewportId, 'vp-b', 'the activated viewport is not restored');
  // Two presses: only the newest may navigate and write.
  Object.assign(v.view, { scope: A, viewportId: 'vp-a' });
  const older = store.navigate(e, 1); await tick();
  v.ready = true; Object.assign(v.view, { scope: A, viewportId: 'vp-a' });
  const newer = store.navigate(e, 1);
  assert.deepEqual((await newer).ok, true);
  await c.advance(200);
  assert.deepEqual(await older, { ok: false, reason: 'superseded', phase: 'activated' });
  assert.equal(v.calls.length, 2);
  // A slow viewer answer past the bound: timeout, the display may already have moved.
  Object.assign(v.view, { scope: A, viewportId: 'vp-a' });
  let open; v.gate = new Promise(resolve => { open = resolve; });
  const slow = store.navigate(e, 1); await tick();
  await c.advance(15000);
  assert.deepEqual(await Promise.race([slow, tick(10).then(() => pending)]), { ok: false, reason: 'timeout', phase: 'navigating' });
  assert.ok(e.message.endsWith(model.phaseText('navigating')));
  open(); v.gate = null; await tick();
  // The anchor's own source while the comparison viewport is active goes to the B1 path and names the viewport to select.
  Object.assign(v.view, { scope: B, viewportId: 'vp-b' });
  store.syncHistory(history(B, [])); await tick(40);
  const anchorResult = await store.navigate(e, 0);
  assert.deepEqual(anchorResult, { ok: false, reason: 'scope' });
  assert.equal(e.message, '현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다. 현재 검사의 영상 칸을 선택한 뒤 다시 누르세요.');
  assert.equal(v.activations.length, 5, 'the anchor source never activates anything');
  // A study outside the pair, a refused comparison list and missing viewer tools never reach the viewer.
  const outside = t.cross(F2, 1); outside.item.sources[1] = { ...pCopy(P1, 1), studyUid: '9.9.9' };
  e.head = outside;
  assert.deepEqual(await store.navigate(e, 1), { ok: false, reason: 'scope', phase: 'before' });
  e.head = t.cross(F2, 1);
  store.state().pair.status = 'denied';
  assert.deepEqual(await store.navigate(e, 1), { ok: false, reason: 'busy', phase: 'before' });
  store.state().pair.status = 'ready';
  assert.deepEqual([v.activations.length, v.calls.length], [5, 4]);
  const noTools = makeStore(t, { studies: [A, B], uuid: counter() });
  noTools.store.syncHistory(history(A, heads2())); await tick(40);
  assert.deepEqual(await noTools.store.navigate(noTools.store.state().entries.get(F2), 1), { ok: false, reason: 'tool-missing', phase: 'before' });
});

const ANCHOR_REFUSAL = '현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다. 현재 검사의 영상 칸을 선택한 뒤 다시 누르세요.';
test('store anchor refusal: its text follows the viewer history at the answer, not the 250 ms snapshot; other logins, ended, outside the pair or unreadable stay generic', async () => {
  const t = pairTransport(); t.state.items = [t.head(F1, 1), t.cross(F2, 1)];
  let live = { scope: A, subject: 'reader-1', ended: false, suspended: false, heads: [] }, gate = null;
  const calls = [], activations = [];
  const { store } = await anchored(t, {
    history: () => { if (live instanceof Error) throw live; return live; },
    activate: study => { activations.push(study); return { ok: false, reason: 'viewport-missing' }; },
    navigate: async target => {
      calls.push(plain(target)); if (gate) await gate;
      return !(live instanceof Error) && !live.refuse && live.scope === target.studyUid ? { ok: true, highlighted: false, annotation: 'none' } : { ok: false, reason: 'scope' };
    } });
  const e = store.state().entries.get(F2);
  const anchorTarget = { studyUid: A, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: ITEM };
  // The viewer already shows the comparison study (still loading); the store's snapshot has not synced it yet.
  live = { ...live, scope: B, suspended: true, loading: true };
  assert.equal(store.state().history.scope, A);
  assert.deepEqual(await store.navigate(e, 0), { ok: false, reason: 'scope' });
  assert.equal(e.message, ANCHOR_REFUSAL);
  assert.deepEqual([calls, activations], [[anchorTarget], []], 'one viewer call for the anchor source, no activation');
  for (const [label, value] of [
    ['another login', { scope: B, subject: 'reader-2', ended: false }],
    ['ended session', { scope: B, subject: 'reader-1', ended: true }],
    ['a study outside the pair', { scope: '7.7.7', subject: 'reader-1', ended: false }],
    ['the anchor itself refusing', { scope: A, subject: 'reader-1', ended: false, refuse: true }],
    ['unreadable history', new Error('gone')],
    ['no scope', { subject: 'reader-1', ended: false }],
  ]) {
    live = value; e.message = 'before';
    assert.deepEqual(await store.navigate(e, 0), { ok: false, reason: 'scope' }, label);
    assert.equal(e.message, model.reasonText('scope'), label);
  }
  assert.deepEqual([calls.length, activations], [7, []]);
  // A snapshot still on the comparison study while the viewer is back on the anchor: the viewer's real answer counts.
  store.syncHistory(history(B, [])); await tick(40);
  live = { scope: A, subject: 'reader-1', ended: false };
  assert.equal(store.state().history.scope, B);
  assert.deepEqual(await store.navigate(e, 0), { ok: true, highlighted: false, annotation: 'none' });
  assert.equal(e.message, '');
  // An anchor change during the viewer call: superseded, nothing written, even though the viewer is on B.
  live = { scope: B, subject: 'reader-1', ended: false };
  e.message = 'marker';
  let open; gate = new Promise(resolve => { open = resolve; });
  const pending = store.navigate(e, 0); await tick();
  t.state.items = [];
  store.syncHistory(history('7.7.7', [])); await tick(40);
  open(); gate = null;
  assert.deepEqual(await pending, { ok: false, reason: 'superseded' });
  assert.deepEqual([e.message, store.state().entries.has(F2), activations], ['marker', false, []]);
});

/* The whole history extension and the Findings section in a two-viewport comparison viewer. */
async function paired() {
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.querySelector = selector => document.body.all().find(e => selector === '#' + e.id) || null;
  document.createTextNode = value => { const node = new Element('#text'); node.textContent = value; return node; };
  const window = new EventTarget(), annotations = new Map();
  const ticks = []; let ticked = 0; const tickAll = () => { ticked++; for (const fn of [...ticks]) fn(); };
  const me = { sub: 'doctor', kind: 'member', roles: ['radiologist'] };
  const XK = 'a0000000-0000-4000-8000-000000000011', PK = 'a0000000-0000-4000-8000-000000000022';
  const keyOf = (id, study, series, sop, title) => ({ id, studyUid: study, revision: 1, hidden: false, authorSub: 'doctor', authorActor: 'Doctor', createdAt: 't', updatedAt: 't',
    item: { schemaVersion: 1, kind: 'key', seriesUid: series, sopUid: sop, frame: 1, title, description: '', hidden: false } });
  const server = { items: { [XS]: [keyOf(XK, XS, '1.2', '1.3', 'X 키')], [PS]: [keyOf(PK, PS, '2.3', '2.6', 'P 비교 키')] },
    findings: [], posts: [], gets: [], denied: new Set(), requests: new Map(), next: 0, holdFindings: false, held: [] };
  const copy = ref => {
    for (const [study, list] of Object.entries(server.items)) {
      const item = list.find(i => i.id === ref.itemId && i.revision === ref.revision);
      if (item) return { itemId: item.id, revision: item.revision, studyUid: study, kind: 'key', seriesUid: item.item.seriesUid, sopUid: item.item.sopUid, frame: 1,
        frameOfReferenceUid: null, label: item.item.title, values: null, calculator: null, sourceDigest: null, authorActor: 'Doctor' };
    }
    return null;
  };
  const readable = f => f.lineage.every(study => !server.denied.has(study));
  const shown = f => ({ ...JSON.parse(JSON.stringify(f.head)), links: f.head.item.sources.map(s => ({ itemId: s.itemId, linkState: 'current', headRevision: s.revision, headHidden: false })) });
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)) });
  const fetch = async (path, options) => {
    const method = (options && options.method) || 'GET';
    if (path === '/api/me') return json(200, me);
    server.gets.push(method + ' ' + path);
    const m = path.match(/^\/api\/studies\/([0-9.]+)\/(viewer-items|findings)(?:\/([0-9a-f-]+)\/revisions)?/);
    if (!m) return json(404, {});
    if (server.denied.has(m[1])) return json(403, { message: 'refused' });
    if (m[2] === 'viewer-items') return json(200, { items: (server.items[m[1]] || []).filter(i => path.includes('includeHidden=true') || !i.hidden), nextCursor: null });
    if (method !== 'POST') {
      // Answered with the rows of the moment it was asked, now or when a held read is released.
      const answer = json(200, { items: server.findings.filter(readable).map(shown), nextCursor: null });
      return server.holdFindings ? new Promise(resolve => server.held.push(() => resolve(answer))) : answer;
    }
    const body = JSON.parse(options.body); server.posts.push({ path, body, raw: options.body });
    if (server.fail) { const status = server.fail; server.fail = null; return json(status, { message: 'synthetic' }); }
    if (server.requests.has(body.requestId)) return json(200, shown(server.requests.get(body.requestId)));
    const sources = body.item.sources.map(copy);
    if (sources.some(s => !s || server.denied.has(s.studyUid))) return json(404, { message: '연결할 표식이 이 검사에 없습니다' });
    let f = m[3] ? server.findings.find(x => x.head.id === m[3]) : null;
    if (m[3] && (!f || !readable(f))) return json(404, { message: '소견이 없습니다' });
    if (!f) { f = { head: { id: 'f0000000-0000-4000-8000-' + String(++server.next).padStart(12, '0'), studyUid: XS, authorSub: 'doctor', authorActor: 'Doctor', revision: 0, hidden: false, createdAt: 't', updatedAt: 't' }, lineage: [] }; server.findings.push(f); }
    f.head.revision++; f.head.item = { schemaVersion: 1, title: body.item.title, text: body.item.text, hidden: false, primary: body.item.primary, sources };
    f.lineage = [...new Set([...f.lineage, ...sources.map(s => s.studyUid)])];
    server.requests.set(body.requestId, f);
    return json(200, shown(f));
  };
  const images = { [XS]: ['/studies/1.1/series/1.2/instances/1.3/frames/1', '/studies/1.1/series/1.2/instances/1.5/frames/1'],
    [PS]: ['/studies/2.2/series/2.3/instances/2.4/frames/1', '/studies/2.2/series/2.3/instances/2.6/frames/1'] };
  const shows = new Map([['vp-x', XS], ['vp-p', PS]]);
  const views = new Map([...shows.keys()].map(id => [id, { id, type: 'stack', index: 0, pending: [], renders: 0,
    getImageIds() { return images[shows.get(id)]; }, getCurrentImageId() { return images[shows.get(id)][this.index]; },
    setImageIdIndex(index) { return new Promise(resolve => this.pending.push(() => { this.index = index; resolve(); })); }, render() { this.renders++; } }]));
  const grid = { active: 'vp-x', activations: [], handlers: [] };
  const services = {
    cornerstoneViewportService: { getCornerstoneViewport: id => views.get(id) },
    viewportGridService: { EVENTS: { ACTIVE: 'active' }, getActiveViewportId: () => grid.active,
      subscribe: (event, fn) => { grid.handlers.push(fn); return { unsubscribe: () => { grid.handlers = grid.handlers.filter(h => h !== fn); } }; },
      getState: () => ({ activeViewportId: grid.active, viewports: new Map([...shows].map(([id, study]) => [id, { viewportId: id, displaySetInstanceUIDs: ['ds-' + study] }])) }),
      setActiveViewportId(id) { grid.activations.push(id); grid.active = id; for (const fn of [...grid.handlers]) fn(); },
      setDisplaySetsForViewport() { throw new Error('no display set change expected'); } },
    displaySetService: { getDisplaySetByUID: id => ({ ['ds-' + XS]: { StudyInstanceUID: XS }, ['ds-' + PS]: { StudyInstanceUID: PS } })[id],
      getActiveDisplaySets: () => [
        { displaySetInstanceUID: 'ds-' + XS, StudyInstanceUID: XS, SeriesInstanceUID: '1.2', instances: [{ SOPInstanceUID: '1.3' }, { SOPInstanceUID: '1.5' }] },
        { displaySetInstanceUID: 'ds-' + PS, StudyInstanceUID: PS, SeriesInstanceUID: '2.3', instances: [{ SOPInstanceUID: '2.4' }, { SOPInstanceUID: '2.6' }] }] },
    measurementService: { getMeasurements: () => [], getMeasurement: () => undefined, remove() {}, update() {} },
    uiNotificationService: { show() {} },
  };
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'image' } }, metaData: { get() {} } };
  window.cornerstoneTools = { annotation: { locking: { setAnnotationLocked() {}, isAnnotationLocked: () => true }, selection: { setAnnotationSelected() {} },
    state: { getAnnotation: uid => annotations.get(uid), getAllAnnotations: () => [...annotations.values()], removeAnnotation: uid => annotations.delete(uid) } },
    ToolGroupManager: { getToolGroupForViewport() {} } };
  window.prompt = () => '사유'; window.confirm = () => true; window.fetch = fetch;
  const sandbox = { window, document, crypto: webcrypto, TextEncoder, console, Event, AbortController, URLSearchParams, fetch,
    location: { search: '?StudyInstanceUIDs=' + XS + ',' + PS + '&hangingProtocolId=@ohif/hpCompare' },
    setInterval: fn => { ticks.push(fn); return ticks.length; }, clearInterval() {}, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-history');
  extension.preRegistration({ servicesManager: { services }, commandsManager: { getCommand: () => undefined, registerCommand() {} } });
  extension.onModeEnter(); await flush();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'finding-link-model.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'viewer-findings.js'), 'utf8'), sandbox);
  const findings = window.kinViewerFindings(services, sandbox.kinFindingLinkModel);
  assert.equal(findings.mount(), true);
  tickAll(); await flush(); tickAll(); await flush();
  const h = { window, server, views, shows, grid, findings, XK, PK, all: () => document.body.all(), text: () => document.body.all().map(e => e.textContent).join('\n'),
    sync: async () => { tickAll(); await flush(); tickAll(); await flush(); },
    ticked: () => ticked,
    async activate(id) { services.viewportGridService.setActiveViewportId(id); await h.sync(); },
    // The grid event alone: the history scans at once, the Findings section has not polled it yet.
    async select(id) { services.viewportGridService.setActiveViewportId(id); await flush(); },
    async release(id) { const next = views.get(id).pending.shift(); assert.ok(next, 'no pending image load in ' + id); next(); await flush(); await h.sync(); } };
  return h;
}
const panelOf = h => h.all().find(e => e.id === 'kin-viewer-findings');
const rowsOf = h => panelOf(h).all().filter(e => e.tagName === 'article');
const buttonIn = (el, name) => { const found = el.all().filter(e => e.tagName === 'button' && e.textContent === name); assert.equal(found.length, 1, name); return found[0]; };
const lineOf = (row, study) => row.all().find(e => e.dataset.sourceStudy === study);
async function check(h, label) {
  const [box] = labelled(h, label); assert.ok(box, label); assert.equal(box.disabled, false, label);
  box.checked = true; box.dispatchEvent(new Event('change')); await flush();
}

test('mounted comparison viewer: the section stays on the first study, links a comparison item from its own list, and Go to Image activates exactly that viewport and proves the frame', async () => {
  const h = await paired(), panel = panelOf(h);
  assert.deepEqual([panel.dataset.studyUid, panel.dataset.comparisonUid, panel.dataset.comparisonState], [XS, PS, 'ready']);
  assert.ok(h.server.gets.includes('GET /api/studies/' + PS + '/viewer-items?limit=100'), 'the comparison list is its own viewer-items read');
  assert.equal(h.all().find(e => e.id === 'kin-viewer-findings-pair-note').hidden, false);
  assert.equal(typeof h.window.kinViewerHistoryActivate, 'function');
  buttonIn(panel, 'New Finding').click(); await flush();
  const [title] = labelled(h, 'Finding Title'); title.value = 'PAIRED DRAFT'; title.dispatchEvent(new Event('input'));
  await check(h, 'Link Key Image · X 키 · 프레임 1 · r1');
  await check(h, 'Link Comparison Key Image · P 비교 키 · 프레임 1 · r1');
  // The comparison viewport becomes active: the draft stays live on the first study, nothing is held.
  await h.activate('vp-p');
  assert.equal(h.window.kinViewerHistoryState().scope, PS);
  assert.equal(panel.dataset.studyUid, XS);
  assert.equal(labelled(h, 'Finding Title')[0].value, 'PAIRED DRAFT');
  assert.deepEqual(plain(h.window.kinViewerFindingsState()), { scope: XS, dirty: true, busy: false, held: 0 });
  assert.equal(h.all().find(e => e.id === 'kin-viewer-findings-held').hidden, true);
  const draft = rowsOf(h)[0];
  assert.deepEqual(draft.all().filter(e => e.dataset.sourceStudy).map(e => e.dataset.sourceStudy), ['current', 'comparison']);
  assert.ok(textOf(draft).includes('[비교 검사] Key Image · P 비교 키'));
  assert.ok(textOf(draft).includes('현재 검사의 표식은 현재 검사의 영상 칸을 선택하면 연결할 수 있습니다.'));
  // Saved while the comparison viewport is active: exactly the two pairs.
  buttonIn(draft, 'Save').click(); await flush(); await h.sync();
  assert.deepEqual(h.server.posts.map(p => p.body.item.sources), [[{ itemId: h.XK, revision: 1 }, { itemId: h.PK, revision: 1 }]]);
  const saved = rowsOf(h).find(e => e.dataset.saved === 'true');
  assert.ok(saved && textOf(saved).includes('Saved r1'));
  // Back on the first study, Go to Image of the comparison source.
  await h.activate('vp-x');
  const activationsBefore = h.grid.activations.length;
  buttonIn(lineOf(saved, 'comparison'), 'Go to Image').click();
  await waitFor(() => h.views.get('vp-p').pending.length === 1, 'the comparison image load');
  assert.deepEqual(h.grid.activations.slice(activationsBefore), ['vp-p'], 'exactly the comparison viewport');
  assert.equal(h.window.kinViewerHistoryState().scope, PS);
  assert.deepEqual([h.views.get('vp-x').pending.length, h.views.get('vp-x').index], [0, 0], 'the first study viewport is untouched');
  await h.release('vp-p');
  await waitFor(() => textOf(saved).includes('비교 검사 영상 칸에서 원본 프레임으로 이동했습니다.'), 'the arrival text');
  assert.equal(h.views.get('vp-p').index, 1);
  assert.deepEqual(plain(h.window.kinViewerHistoryState().image), { study: PS, seriesUid: '2.3', sopUid: '2.6', frame: 1 });
  assert.equal(h.grid.active, 'vp-p');
  // The first study's source while the comparison viewport is active: no activation, no image load.
  buttonIn(lineOf(saved, 'current'), 'Go to Image').click(); await flush(); await h.sync();
  assert.ok(textOf(saved).includes('현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다.'));
  assert.deepEqual([h.grid.activations.length, h.views.get('vp-x').pending.length, h.views.get('vp-p').pending.length], [activationsBefore + 1, 0, 0]);
  // With the first study active, its source navigates as in B1.
  await h.activate('vp-x');
  buttonIn(lineOf(saved, 'current'), 'Go to Image').click();
  await waitFor(() => h.views.get('vp-x').pending.length === 1, 'the first study image load');
  await h.release('vp-x');
  await waitFor(() => textOf(saved).includes('키 이미지 프레임으로 이동했습니다.') && !textOf(saved).includes('비교 검사 영상 칸에서'), 'the B1 arrival');
  assert.equal(h.grid.active, 'vp-x');
  h.findings.stop();
});

test('mounted comparison viewer: missing or duplicated comparison viewports refuse before activation; withdrawal leaves no comparison row or text', async () => {
  const h = await paired(), panel = panelOf(h);
  buttonIn(panel, 'New Finding').click(); await flush();
  const [title] = labelled(h, 'Finding Title'); title.value = 'CROSS'; title.dispatchEvent(new Event('input'));
  await check(h, 'Link Key Image · X 키 · 프레임 1 · r1');
  await check(h, 'Link Comparison Key Image · P 비교 키 · 프레임 1 · r1');
  buttonIn(rowsOf(h)[0], 'Save').click(); await flush(); await h.sync();
  const saved = () => rowsOf(h).find(e => e.dataset.saved === 'true');
  const press = async () => { buttonIn(lineOf(saved(), 'comparison'), 'Go to Image').click(); await new Promise(r => setTimeout(r, 30)); await h.sync(); };
  h.shows.set('vp-p', XS);
  await press();
  assert.ok(textOf(saved()).includes('이 원본의 검사를 표시하는 영상 칸이 이 화면에 없습니다.'));
  h.shows.set('vp-p', PS); h.shows.set('vp-x', PS);
  await press();
  assert.ok(textOf(saved()).includes('영상 칸이 여러 개라 이동할 칸을 정하지 않았습니다.'));
  assert.deepEqual([h.grid.activations, h.views.get('vp-p').pending.length], [[], 0], 'nothing was activated or loaded');
  h.shows.set('vp-x', XS);
  // The author edits the finding, then the comparison study is withdrawn from this login.
  buttonIn(saved(), 'Edit').click(); await flush();
  const [edit] = labelled(h, 'Finding Text'); edit.value = '작성자 수정'; edit.dispatchEvent(new Event('input'));
  h.server.denied.add(PS);
  buttonIn(panel, 'Reload Findings').click();
  await waitFor(() => panel.dataset.comparisonState === 'denied' && !rowsOf(h).some(e => e.dataset.saved === 'true'), 'the withdrawal');
  await h.sync();
  const text = textOf(panel);
  for (const secret of ['P 비교 키', '2.6', h.PK, '[비교 검사]']) assert.equal(text.includes(secret), false, secret);
  const kept = rowsOf(h);
  assert.equal(kept.length, 1); assert.equal(kept[0].dataset.saved, 'false');
  assert.equal(labelled(h, 'Finding Text')[0].value, '작성자 수정');
  assert.deepEqual(kept[0].all().filter(e => e.dataset.sourceStudy).map(e => e.dataset.sourceStudy), ['current']);
  assert.ok(text.includes('이 소견을 더 이상 볼 수 없어 저장하지 않았습니다.'));
  assert.ok(text.includes('비교 검사에 접근할 수 없어 표식을 연결할 수 없습니다.'));
  assert.equal(labelled(h, 'Link Comparison Key Image · P 비교 키 · 프레임 1 · r1').length, 0);
  assert.equal(h.server.gets.filter(g => g.startsWith('GET /api/studies/' + XS + '/findings')).length >= 3, true);
});

// Hosted navigation test 04 presses the first study's source right after activating the comparison viewport.
test('mounted comparison viewer: before any Findings sync after a viewport change, the first study source refuses with the right viewport text and loads nothing; back on it, it arrives', async () => {
  const h = await paired();
  buttonIn(panelOf(h), 'New Finding').click(); await flush();
  const [title] = labelled(h, 'Finding Title'); title.value = 'IMMEDIATE'; title.dispatchEvent(new Event('input'));
  await check(h, 'Link Key Image · X 키 · 프레임 1 · r1');
  await check(h, 'Link Comparison Key Image · P 비교 키 · 프레임 1 · r1');
  buttonIn(rowsOf(h)[0], 'Save').click(); await flush(); await h.sync();
  const saved = () => rowsOf(h).find(e => e.dataset.saved === 'true');
  assert.ok(saved());
  const ticked = h.ticked(), activations = h.grid.activations.length;
  await h.select('vp-p');
  assert.deepEqual([h.window.kinViewerHistoryState().scope, h.window.kinViewerHistoryState().suspended], [PS, false]);
  buttonIn(lineOf(saved(), 'current'), 'Go to Image').click(); await flush();
  assert.equal(h.ticked(), ticked, 'no Findings sync ran between the viewport change and the press');
  assert.ok(textOf(saved()).includes(ANCHOR_REFUSAL), textOf(saved()));
  assert.ok(!textOf(saved()).includes(model.reasonText('scope')));
  assert.deepEqual([h.grid.activations.length, h.grid.active, h.views.get('vp-x').pending.length, h.views.get('vp-p').pending.length],
    [activations + 1, 'vp-p', 0, 0], 'only the user selection; no activation or image load by the press');
  // Back on the first study, again before any sync: its source goes to the viewer and the frame is proven.
  await h.select('vp-x');
  buttonIn(lineOf(saved(), 'current'), 'Go to Image').click();
  await waitFor(() => h.views.get('vp-x').pending.length === 1, 'the first study image load');
  assert.equal(h.ticked(), ticked);
  await h.release('vp-x');
  await waitFor(() => textOf(saved()).includes('키 이미지 프레임으로 이동했습니다.'), 'the first study arrival');
  assert.ok(!textOf(saved()).includes(ANCHOR_REFUSAL));
  assert.deepEqual([h.grid.activations.length, h.grid.active, h.views.get('vp-p').pending.length], [activations + 2, 'vp-x', 0]);
  h.findings.stop();
});

// Hosted navigation test 04 holds the first study's list read and then activates the comparison viewport.
test('mounted comparison viewer: a held anchor list read survives comparison activation with its rows and reading status; only a mode exit drops its late answer', async () => {
  const h = await paired();
  const statusText = () => h.all().find(e => e.id === 'kin-viewer-findings-status').textContent;
  const saved = () => rowsOf(h).find(e => e.dataset.saved === 'true');
  buttonIn(panelOf(h), 'New Finding').click(); await flush();
  const [title] = labelled(h, 'Finding Title'); title.value = 'old A'; title.dispatchEvent(new Event('input'));
  await check(h, 'Link Key Image · X 키 · 프레임 1 · r1');
  buttonIn(rowsOf(h)[0], 'Save').click(); await flush(); await h.sync();
  assert.ok(textOf(saved()).includes('old A')); assert.match(statusText(), /^1개 소견/);
  // The next read is held with the rows of that moment; then the server changes the finding.
  const first = panelOf(h);
  h.server.holdFindings = true;
  buttonIn(first, 'Reload Findings').click(); await h.sync();
  assert.deepEqual([h.server.held.length, statusText()], [1, '소견 확인 중…']);
  h.server.findings[0].head.item.title = 'new A'; h.server.findings[0].head.revision++;
  await h.activate('vp-p');
  assert.equal(h.window.kinViewerHistoryState().scope, PS);
  assert.deepEqual([first.dataset.studyUid, statusText(), h.server.held.length], [XS, '소견 확인 중…', 1], 'still reading: neither answered, cancelled nor repeated');
  assert.ok(saved() && textOf(saved()).includes('old A'), 'the rows the read will replace stay shown');
  assert.equal(h.all().find(e => e.id === 'kin-viewer-findings-held').hidden, true);
  // The first study's source refuses with the anchor viewport text; nothing is activated or loaded.
  const activations = h.grid.activations.length;
  buttonIn(lineOf(saved(), 'current'), 'Go to Image').click(); await flush(); await h.sync();
  assert.ok(textOf(saved()).includes('현재 검사의 영상 칸이 선택되어 있지 않아 이동하지 않았습니다.'));
  assert.deepEqual([h.grid.activations.length, h.views.get('vp-x').pending.length, h.views.get('vp-p').pending.length, statusText()],
    [activations, 0, 0, '소견 확인 중…']);
  // Mode exit and entry: the next section reads the new row; the old read's late answer changes nothing.
  h.findings.stop(); h.server.holdFindings = false;
  assert.equal(h.findings.mount(), true); await h.sync();
  const next = panelOf(h);
  assert.notEqual(next, first); assert.equal(first.isConnected, false);
  assert.ok(textOf(next).includes('new A'));
  for (const release of h.server.held.splice(0)) release();
  await h.sync();
  assert.match(statusText(), /^1개 소견/);
  assert.deepEqual([textOf(next).includes('new A'), textOf(next).includes('old A'), next.dataset.studyUid], [true, false, XS]);
  assert.equal(h.all().filter(e => e.id === 'kin-viewer-findings').length, 1);
  h.findings.stop();
});

// The S2-B1 list/command suite runs in this same process as well, so the existing hosted Validate step
// for this file also executes it; `node --test tests/finding_command_test.cjs` runs it alone.
require('./finding_command_test.cjs');
