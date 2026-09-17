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
// S2-L R5: every synthetic API answer below models the current API, which names its record format in this response header;
// the old-API cases build answers without it on purpose.
const API_HEADERS = Object.freeze({ get: name => String(name).toLowerCase() === 'x-kin-finding-schema' ? '2' : null });

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
  const fetch = async path => ({ status: 200, ok: true, headers: API_HEADERS, json: async () => path === '/api/me' ? me
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
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: API_HEADERS, json: async () => body });
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
  // S2-L DN7: a new client creates and edits version 2 records (the one expected-value change of this assertion).
  assert.deepEqual(firstBody, { requestId: REQUEST, item: { schemaVersion: 2, title: '소견', text: '본문', characteristics: '', primary: 0, sources: [{ itemId: ITEM, revision: 2 }] } });
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
  t.state.responses.push(async () => { await gate; return { status: 200, ok: true, headers: API_HEADERS, json: async () => t.head(F1, 1) }; });
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
  // S2-C: the answer also carries the viewer's live entry of the item (the one expected addition to this assertion).
  const live = { present: true, revision: 1, hidden: false, working: false };
  assert.deepEqual(await worklistCommand(arrived, findingTarget({ itemId: key })),
    { result: { ok: true, highlighted: false, annotation: 'key', live, latest: true }, announced: [{ ok: true, highlighted: false, annotation: 'key', live }], loads: 1 });
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
    sopUid: '4.5.6.1.2', frame: 1, authorSub: 'reader-1', referenceStatus: null, values: null, calculator: null, working: false });
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
  assert.deepEqual(JSON.parse(pendingBody), { requestId: 'd0000000-0000-4000-8000-000000000002', item: { schemaVersion: 2, title: '비교 소견', text: '본문', characteristics: '', primary: 0,
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
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: API_HEADERS, json: async () => JSON.parse(JSON.stringify(body)) });
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

/* ---------- copied measurement values (S2-V R8 with design corrections C1-C8) ---------- */
const CALC = 'kin-native-manual-v1', UNV = '수치(단위 미확인): ';
const E5 = [400.26, 45, -20, 80, 1234];
const E5_TEXT = '면적 400.3 mm² · 평균 45.0 HU · 최소 -20.0 HU · 최대 80.0 HU · 화소 수 1234';

test('valueText: names and units only for a known provenance with the exact calculator, count and number shape', () => {
  const V = model.valueText;
  assert.equal(V('length', CALC, [12.34], 'server-copy'), '12.3 mm');
  assert.equal(V('angle', CALC, [12.34], 'server-copy'), '12.3°');
  assert.equal(V('ellipse', CALC, E5, 'server-copy'), E5_TEXT);
  // The calculator's order [area, mean, min, max, count]: distinct values pin every name.
  assert.equal(V('ellipse', CALC, [1, 2, 3, 4, 5], 'server-copy'), '면적 1.0 mm² · 평균 2.0 HU · 최소 3.0 HU · 최대 4.0 HU · 화소 수 5');
  // C1: a server copy needs exactly the pinned calculator.
  for (const calculator of [undefined, null, '', 'other-v9', 'kin-native-manual-v2', 'KIN-NATIVE-MANUAL-V1', ' kin-native-manual-v1', 0, {}, [CALC]])
    assert.equal(V('length', calculator, [12.34], 'server-copy'), UNV + '12.3', 'server-copy ' + String(calculator));
  // Only a live Measurements head may omit it; null or another value is still unverified.
  assert.equal(V('length', undefined, [12.34], 'live-head'), '12.3 mm');
  assert.equal(V('angle', undefined, [12.34], 'live-head'), '12.3°');
  assert.equal(V('ellipse', undefined, E5, 'live-head'), E5_TEXT);
  assert.equal(V('length', CALC, [12.34], 'live-head'), '12.3 mm');
  for (const calculator of [null, '', 'other-v9', 0, false])
    assert.equal(V('length', calculator, [12.34], 'live-head'), UNV + '12.3', 'live-head ' + String(calculator));
  // A missing or unknown provenance never names a unit, whatever the calculator.
  for (const provenance of [undefined, null, '', 'server', 'live', 'Server-Copy', 'LIVE-HEAD', 'saved', 'comparison', 'server-copy ', {}, 1])
    for (const calculator of [CALC, undefined])
      assert.equal(V('length', calculator, [12.34], provenance), UNV + '12.3', String(provenance) + ' ' + String(calculator));
  assert.equal(V('ellipse', CALC, E5), UNV + '400.3 / 45.0 / -20.0 / 80.0 / 1234.0', 'provenance omitted');
  // Exactly 1/1/5 values; an empty list of a measurement kind is unverified, not silent.
  for (const [kind, values, shown] of [['length', [20, 3.14159], '20.0 / 3.1'], ['length', [], ''], ['angle', [], ''], ['angle', [1, 2], '1.0 / 2.0'],
    ['ellipse', E5.slice(0, 4), '400.3 / 45.0 / -20.0 / 80.0'], ['ellipse', [...E5, 9], '400.3 / 45.0 / -20.0 / 80.0 / 1234.0 / 9.0'], ['ellipse', [7], '7.0']])
    for (const provenance of ['server-copy', 'live-head']) assert.equal(V(kind, CALC, values, provenance), UNV + shown, kind + ' ' + values.length + ' ' + provenance);
  // C3: finite number primitives in fixed notation only; otherwise the whole source is unverified.
  for (const [value, shown] of [[NaN, '?'], [Infinity, '?'], [-Infinity, '?'], ['12.3', '?'], [null, '?'], [undefined, '?'], [12n, '?'], [new Number(12), '?'],
    [1e21, '1e+21'], [-1e21, '-1e+21'], [Number.MAX_VALUE, '1.7976931348623157e+308']])
    assert.equal(V('length', CALC, [value], 'server-copy'), UNV + shown, String(value));
  assert.equal(V('length', CALC, [999999999999999e5], 'server-copy'), '99999999999999901696.0 mm', 'below 1e21 stays in fixed notation');
  assert.equal(V('ellipse', CALC, [400.26, NaN, -20, Infinity, 1234], 'server-copy'), UNV + '400.3 / ? / -20.0 / ? / 1234.0');
  assert.equal(V('ellipse', CALC, [400.26, 45, -20, 80, '1234'], 'live-head'), UNV + '400.3 / 45.0 / -20.0 / 80.0 / ?');
  // The pixel count: a non-negative safe integer shown as is, never rounded into one.
  for (const [count, shown] of [[1234.5, '1234.5'], [1234.04, '1234.0'], [-1, '-1.0'], [-0.5, '-0.5'], [-0.04, '0.0'], [2 ** 53, '9007199254740992.0'], [NaN, '?']])
    assert.equal(V('ellipse', CALC, [400.26, 45, -20, 80, count], 'server-copy'), UNV + '400.3 / 45.0 / -20.0 / 80.0 / ' + shown, String(count));
  for (const [count, shown] of [[-0, '0'], [0, '0'], [7, '7'], [Number.MAX_SAFE_INTEGER, '9007199254740991']])
    assert.equal(V('ellipse', CALC, [400.26, 45, -20, 80, count], 'server-copy'), E5_TEXT.replace('화소 수 1234', '화소 수 ' + shown), String(count));
  // One decimal after Math.round(n * 10) / 10; negative zero never shows as '-0.0'.
  for (const [n, shown] of [[-0, '0.0'], [0, '0.0'], [-0.04, '0.0'], [-0.05, '0.0'], [0.04, '0.0'], [0.05, '0.1'], [-0.06, '-0.1'], [12.25, '12.3'],
    [12.35, '12.4'], [-12.35, '-12.3'], [1.005, '1.0'], [-20, '-20.0'], [99.95, '100.0'], [5e-324, '0.0']]) {
    assert.equal(V('length', CALC, [n], 'server-copy'), shown + ' mm', String(n));
    assert.equal(V('angle', undefined, [n], 'live-head'), shown + '°', String(n));
    assert.equal(V('length', 'other', [n], 'server-copy'), UNV + shown, String(n));
  }
  assert.equal(V('ellipse', CALC, [-0, -0.04, -0.05, -0, -0], 'server-copy'), '면적 0.0 mm² · 평균 0.0 HU · 최소 0.0 HU · 최대 0.0 HU · 화소 수 0');
  // C4: other kinds show nothing without values and unverified numbers with them.
  for (const kind of ['volume3d', 'Length', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '', null, undefined, 7]) {
    assert.equal(V(kind, CALC, [7], 'server-copy'), UNV + '7.0', String(kind));
    assert.equal(V(kind, undefined, [7], 'live-head'), UNV + '7.0', String(kind));
  }
  for (const kind of ['arrow', 'key', 'volume3d', 'constructor'])
    for (const values of [null, undefined, []]) for (const provenance of ['server-copy', 'live-head']) assert.equal(V(kind, null, values, provenance), '', kind);
  assert.equal(V('arrow', CALC, [7], 'server-copy'), UNV + '7.0');
  assert.equal(V('key', null, [1, 2], 'server-copy'), UNV + '1.0 / 2.0');
  // Values that are not an array show nothing; a hostile list never throws and never names a unit.
  for (const values of ['12.3', 12.3, { length: 1, 0: 12.3 }, new Float64Array([12.3]), new Set([12.3]), null, undefined])
    assert.equal(V('length', CALC, values, 'server-copy'), '', Object.prototype.toString.call(values));
  const throwing = [1]; Object.defineProperty(throwing, 0, { get() { throw new Error('getter'); } });
  assert.equal(V('length', CALC, throwing, 'server-copy'), UNV + '?');
  const proxy = new Proxy([1], { get(target, key) { if (key === 'length') throw new Error('length'); return target[key]; } });
  assert.equal(V('length', CALC, proxy, 'server-copy'), UNV + '?');
  let reads = 0; const once = [5]; Object.defineProperty(once, 0, { get() { reads++; return reads === 1 ? 5 : NaN; } });
  assert.equal(V('length', CALC, once, 'server-copy'), '5.0 mm'); assert.equal(reads, 1, 'each value is read once');
  assert.equal(V('ellipse', CALC, vm.runInNewContext('[400.26, 45, -20, 80, 1234]'), 'server-copy'), E5_TEXT, 'another realm');
  const frozen = Object.freeze([...E5]); assert.equal(V('ellipse', CALC, frozen, 'server-copy'), E5_TEXT); assert.deepEqual(frozen, E5);
});

test('comparisonHead keeps a string calculator for display and nulls anything else, as it does for values (S2-V C2)', () => {
  const head = baseline => model.comparisonHead({ id: P1, studyUid: B, revision: 1, hidden: false, authorSub: 'reader-1', referenceStatus: 'verified',
    item: { schemaVersion: 1, kind: 'length', seriesUid: '4.5.6.1', sopUid: '4.5.6.1.2', frame: 1, label: 'P 길이', baseline } }, B);
  assert.deepEqual([head({ calculator: CALC, values: [12.34] }).calculator, head({ calculator: CALC, values: [12.34] }).values], [CALC, [12.34]]);
  for (const [baseline, calculator] of [[{ calculator: 'other-v9', values: [1] }, 'other-v9'], [{ calculator: '', values: [1] }, ''], [{ values: [1] }, null],
    [{ calculator: null, values: [1] }, null], [{ calculator: 7, values: [1] }, null], [{ calculator: {}, values: [1] }, null], [undefined, null], ['x', null], [null, null]])
    assert.equal(head(baseline).calculator, calculator, JSON.stringify(baseline));
  const text = baseline => { const h = head(baseline); return model.valueText(h.kind, h.calculator, h.values, 'server-copy'); };
  assert.equal(text({ calculator: CALC, values: [12.34] }), '12.3 mm');
  assert.equal(text({ values: [12.34] }), UNV + '12.3');
  assert.equal(text({ calculator: 7, values: [12.34] }), UNV + '12.3');
  assert.equal(text({ calculator: CALC, values: [12.34, '1'] }), '', 'a list with a non-number is dropped by comparisonHead as before');
});

test('calculators and copied values never reach a request, draft, pending or held body, a navigation target or the history key (S2-V I1)', async () => {
  const t = pairTransport();
  t.pair.items = [pItem(P1, 1, { item: { schemaVersion: 1, kind: 'length', seriesUid: '4.5.6.1', sopUid: '4.5.6.1.2', frame: 1, label: 'P길이', baseline: { calculator: CALC, values: [7.5] } } })];
  t.state.items = [t.head(F1, 1)];
  const liveHeads = [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false, kind: 'length', label: 'L', values: [20], calculator: CALC }];
  const { store, navigations } = makeStore(t, { uuid: counter(), studies: [A, B] });
  store.syncHistory(history(A, liveHeads)); await tick(40);
  assert.equal(store.state().heads.get(ITEM), liveHeads[0], 'live heads are kept as given');
  assert.equal(store.state().pair.heads.get(P1).calculator, CALC);
  const e = store.state().entries.get(F1);
  assert.equal(e.head.item.sources[0].calculator, CALC);
  assert.deepEqual(e.draft, { title: 'T', text: 'X', primary: 0, sources: [{ itemId: ITEM, revision: 2 }] });
  const key = store.state().historyKey;
  store.syncHistory(history(A, liveHeads.map(h => ({ ...h, calculator: 'other-v9', values: [99] }))));
  assert.equal(store.state().historyKey, key, 'the history key ignores calculator and values');
  const d = store.newDraft(); store.updateDraft(d, { title: '새 소견' });
  assert.equal(store.toggleSource(d, ITEM), true); assert.equal(store.toggleSource(d, P1, B), true);
  assert.deepEqual(d.draft.sources, [{ itemId: ITEM, revision: 2 }, { itemId: P1, revision: 1, studyUid: B }]);
  t.state.responses.push({ status: 503, body: { message: 'delayed' } });
  assert.equal(await store.save(d, 'create'), false);
  const requestId = JSON.parse(d.pending.body).requestId;
  assert.deepEqual(d.pending, { url: '/studies/' + A + '/findings', body: '{"requestId":"' + requestId + '","item":{"schemaVersion":2,"title":"새 소견","text":"","characteristics":"",' +
    '"sources":[{"itemId":"' + ITEM + '","revision":2},{"itemId":"' + P1 + '","revision":1}],"primary":0}}' });
  store.edit(e); store.updateDraft(e, { text: '수정' });
  t.state.responses.push({ status: 503, body: { message: 'delayed' } });
  assert.equal(await store.save(e, 'edit'), false);
  const editId = JSON.parse(e.pending.body).requestId;
  assert.equal(e.pending.body, '{"requestId":"' + editId + '","item":{"schemaVersion":2,"title":"T","text":"수정","characteristics":"","sources":[{"itemId":"' + ITEM + '","revision":2}],"primary":0},' +
    '"expectedRevision":1,"action":"edit"}');
  for (const post of posts(t)) assert.equal(/calculator|values|kind|label|mm|HU/.test(post.options.body), false, post.options.body);
  assert.deepEqual(plain(await store.navigate(e, 0)), { ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(navigations, [{ studyUid: A, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: ITEM }]);
  const pending = [d, e].map(x => ({ id: x.id, pending: { ...x.pending } }));
  const [record] = store.detach();
  assert.deepEqual(record.entries.map(x => ({ id: x.id, pending: x.pending })).sort((a, b) => a.id.localeCompare(b.id)), pending.sort((a, b) => a.id.localeCompare(b.id)));
});

/* The shipped Findings section over a synthetic Measurements history: live heads in the shape of
 * config/ohif.js historyState() (values of the saved head, no calculator), a two-study URL, one saved
 * finding and the comparison study's own viewer-items list. */
const VX = '1.1', VP = '2.2', VF = 'f0000000-0000-4000-8000-00000000c001';
const VL = 'e0000000-0000-4000-8000-000000000001', VE = 'e0000000-0000-4000-8000-000000000002', VM = 'e0000000-0000-4000-8000-000000000003';
const VA = 'e0000000-0000-4000-8000-000000000004', VN = 'e0000000-0000-4000-8000-000000000005', VW = 'e0000000-0000-4000-8000-000000000006';
const VK = 'e0000000-0000-4000-8000-000000000007', VQ = 'e0000000-0000-4000-8000-000000000008';
const VO = 'e0000000-0000-4000-8000-000000000009';
const PL = 'e0000000-0000-4000-8000-00000000b001', PN = 'e0000000-0000-4000-8000-00000000b002', PC = 'e0000000-0000-4000-8000-00000000b003';
const PD = 'e0000000-0000-4000-8000-00000000b004';
async function valueViewer() {
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.querySelector = selector => document.body.all().find(e => selector === '#' + e.id) || null;
  document.createTextNode = value => { const node = new Element('#text'); node.textContent = value; return node; };
  const host = new Element('div'); host.id = 'kin-viewer-history'; document.body.append(host);
  const live = (id, revision, kind, label, values, extra) => Object.assign({ id, revision, hidden: false, kind, label, seriesUid: '1.2', sopUid: '1.3', frame: 1,
    authorSub: 'doctor', referenceStatus: ['length', 'angle', 'ellipse'].includes(kind) ? 'verified' : null, values, working: false }, extra);
  const heads = [live(VL, 2, 'length', '길이', [25]), live(VE, 1, 'ellipse', '관심', [...E5]), live(VM, 1, 'length', '새 길이', [20]),
    live(VA, 1, 'angle', '각도', [12.34]), live(VN, 1, 'length', '계산 없음', [30], { calculator: null }), live(VW, 1, 'ellipse', '넷', E5.slice(0, 4)),
    live(VK, 1, 'key', '키', null), live(VQ, 1, 'arrow', '화살표', [7])];
  const copy = (itemId, study, kind, label, values) => ({ itemId, revision: 1, studyUid: study, kind, seriesUid: study === VX ? '1.2' : '2.3', sopUid: study === VX ? '1.3' : '2.4',
    frame: 1, frameOfReferenceUid: null, label, values, calculator: CALC, sourceDigest: null, authorActor: 'Doctor' });
  // VO is a copy without the calculator key: a server copy of unknown identity.
  const { calculator: _omitted, ...old } = copy(VO, VX, 'length', '옛 길이', [9.99]);
  const item = { schemaVersion: 1, title: '값 소견', text: '본문', hidden: false, primary: 0,
    sources: [copy(VL, VX, 'length', '길이', [12.34]), copy(VE, VX, 'ellipse', '관심', E5), copy(PL, VP, 'length', 'P 길이', [77.77]), old] };
  const finding = { id: VF, studyUid: VX, authorSub: 'doctor', authorActor: 'Doctor', revision: 1, hidden: false, createdAt: 't', updatedAt: 't', item,
    links: [{ itemId: VL, linkState: 'revised', headRevision: 2, headHidden: false }, { itemId: VE, linkState: 'current', headRevision: 1, headHidden: false },
      { itemId: PL, linkState: 'current', headRevision: 1, headHidden: false }, { itemId: VO, linkState: 'current', headRevision: 1, headHidden: false }] };
  const pairItem = (id, label, baseline) => ({ id, studyUid: VP, revision: 1, hidden: false, authorSub: 'doctor', referenceStatus: 'verified',
    item: { schemaVersion: 1, kind: 'length', seriesUid: '2.3', sopUid: '2.4', frame: 1, label, baseline } });
  const server = { denied: false, log: [], pair: [pairItem(PL, 'P 길이', { calculator: CALC, values: [77.77] }), pairItem(PN, 'P 무계산', { values: [66.6] }),
    pairItem(PC, 'P 계산', { calculator: CALC, values: [55.55] }), pairItem(PD, 'P 지운 계산', { calculator: CALC, values: [44.44] })] };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: API_HEADERS, json: async () => JSON.parse(JSON.stringify(body)) });
  const window = new EventTarget(), ticks = [];
  window.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    server.log.push({ method, url, body: options && options.body });
    if (url === '/api/me') return json(200, { sub: 'doctor', kind: 'member', roles: ['radiologist'] });
    if (url.startsWith('/api/studies/' + VP + '/viewer-items?')) return server.denied ? json(403, { message: 'refused' }) : json(200, { items: server.pair, nextCursor: null });
    if (method === 'POST') return json(503, { message: 'synthetic' });
    if (url.startsWith('/api/studies/' + VX + '/findings/' + VF + '/revisions?'))
      return json(200, { revisions: [{ revision: 1, action: 'create', actor: 'Doctor', at: 't1', reason: '', item }], nextCursor: null });
    if (url.startsWith('/api/studies/' + VX + '/findings?')) return json(200, { items: [finding], nextCursor: null });
    return json(404, {});
  };
  window.kinViewerHistoryState = () => ({ scope: VX, subject: 'doctor', ended: false, suspended: false, writable: true, heads });
  window.prompt = () => '사유'; window.confirm = () => true;
  const sandbox = { window, document, crypto: webcrypto, console, Event, AbortController, URLSearchParams, setTimeout, clearTimeout,
    location: { search: '?StudyInstanceUIDs=' + VX + ',' + VP }, setInterval: fn => { ticks.push(fn); return ticks.length; }, clearInterval() {} };
  vm.createContext(sandbox);
  vm.runInContext(shippedFile('finding-link-model.js'), sandbox);
  vm.runInContext(shippedFile('viewer-findings.js'), sandbox);
  // The shipped model, with its store kept for the tests that reshape a comparison head.
  const linkModel = sandbox.kinFindingLinkModel;
  let store = null;
  const findings = window.kinViewerFindings({}, Object.assign({}, linkModel, { createStore: deps => (store = linkModel.createStore(deps)) }));
  assert.equal(findings.mount(), true);
  const sync = async () => { for (let i = 0; i < 3; i++) { for (const fn of [...ticks]) fn(); await flush(); } };
  await sync();
  const panel = () => document.body.all().find(e => e.id === 'kin-viewer-findings');
  const row = () => panel().all().find(e => e.tagName === 'article' && e.dataset.findingId === VF);
  return { server, heads, findings, sync, panel, row, store: () => store,
    line: id => row().all().find(e => e.dataset.itemId === id),
    choices: summary => panel().all().find(e => e.tagName === 'details' && e.children[0]?.textContent === summary).children.filter(e => e.tagName === 'label')
      .map(l => [l.children[0].attributes['aria-label'], l.children[1].textContent]),
    press: async (scope, name) => { const [b] = scope.all().filter(e => e.tagName === 'button' && e.textContent === name); assert.ok(b, name); b.click(); await flush(); await sync(); } };
}

test('mounted values: a saved finding shows its frozen server copies with units, the revised one included, and history lines stay count-only (S2-V C1, C5a/b)', async () => {
  const h = await valueViewer();
  assert.equal(h.panel().dataset.comparisonState, 'ready');
  const first = line => line.children[0].textContent;
  assert.equal(first(h.line(VL)), '[현재 검사] ★ Length · 길이 · 프레임 1 · r1 · 12.3 mm · ');
  assert.equal(h.line(VL).dataset.linkState, 'revised');
  assert.ok(textOf(h.line(VL)).includes(' (현재 r2)'));
  assert.equal(textOf(h.row()).includes('25.0'), false, 'the current head value of a revised link is not shown');
  assert.equal(first(h.line(VE)), '[현재 검사] Ellipse ROI · 관심 · 프레임 1 · r1 · ' + E5_TEXT + ' · ');
  assert.equal(first(h.line(PL)), '[비교 검사] Length · P 길이 · 프레임 1 · r1 · 77.8 mm · ');
  // A saved copy without a calculator is a server copy of unknown identity, never a live head.
  assert.equal(first(h.line(VO)), '[현재 검사] Length · 옛 길이 · 프레임 1 · r1 · 수치(단위 미확인): 10.0 · ');
  assert.ok(h.heads.every(x => !Object.prototype.hasOwnProperty.call(x, 'calculator') || x.id === VN), 'no calculator is stamped on live heads');
  await h.press(h.row(), 'History');
  const lines = h.row().all().filter(e => e.tagName === 'p' && /^r1 · /.test(e.textContent)).map(e => e.textContent);
  assert.deepEqual(lines, ['r1 · 생성 · Doctor · t1 ·  · 값 소견 · 표식 4개']);
  h.findings.stop();
});

test('mounted values: live heads show units without a calculator, comparison heads only with it; checkbox names and new pairs carry no values (S2-V C1, C5d)', async () => {
  const h = await valueViewer();
  // A comparison head that lost its calculator key is still a server copy: no unit.
  delete h.store().state().pair.heads.get(PD).calculator;
  await h.press(h.row(), 'Edit');
  assert.equal(h.line(VO).children[0].textContent, '[현재 검사] Length · 옛 길이 · 프레임 1 · r1 · 수치(단위 미확인): 10.0 · ');
  assert.deepEqual(h.choices('Link Saved Items'), [
    ['Link Length · 새 길이 · 프레임 1 · r1', ' Length · 새 길이 · 프레임 1 · r1 · 20.0 mm · Verified'],
    ['Link Angle · 각도 · 프레임 1 · r1', ' Angle · 각도 · 프레임 1 · r1 · 12.3° · Verified'],
    ['Link Length · 계산 없음 · 프레임 1 · r1', ' Length · 계산 없음 · 프레임 1 · r1 · 수치(단위 미확인): 30.0 · Verified'],
    ['Link Ellipse ROI · 넷 · 프레임 1 · r1', ' Ellipse ROI · 넷 · 프레임 1 · r1 · 수치(단위 미확인): 400.3 / 45.0 / -20.0 / 80.0 · Verified'],
    ['Link Key Image · 키 · 프레임 1 · r1', ' Key Image · 키 · 프레임 1 · r1'],
    ['Link Arrow · 화살표 · 프레임 1 · r1', ' Arrow · 화살표 · 프레임 1 · r1 · 수치(단위 미확인): 7.0']]);
  assert.deepEqual(h.choices('Link Comparison Items'), [
    ['Link Comparison Length · P 무계산 · 프레임 1 · r1', ' Length · P 무계산 · 프레임 1 · r1 · 수치(단위 미확인): 66.6 · Verified'],
    ['Link Comparison Length · P 계산 · 프레임 1 · r1', ' Length · P 계산 · 프레임 1 · r1 · 55.6 mm · Verified'],
    ['Link Comparison Length · P 지운 계산 · 프레임 1 · r1', ' Length · P 지운 계산 · 프레임 1 · r1 · 수치(단위 미확인): 44.4 · Verified']]);
  // A newly linked pair has no server copy yet: it is named from the head, without numbers.
  const box = h.panel().all().find(e => e.attributes['aria-label'] === 'Link Length · 새 길이 · 프레임 1 · r1');
  box.checked = true; box.dispatchEvent(new Event('change')); await h.sync();
  assert.equal(h.line(VM).children[0].textContent, '[현재 검사] Length · 새 길이 · 프레임 1 · r1 · ');
  await h.press(h.row(), 'Save');
  const post = h.server.log.filter(x => x.method === 'POST');
  assert.equal(post.length, 1);
  const body = JSON.parse(post[0].body);
  assert.equal(post[0].body, JSON.stringify({ requestId: body.requestId, item: { schemaVersion: 2, title: '값 소견', text: '본문', characteristics: '',
    sources: [{ itemId: VL, revision: 1 }, { itemId: VE, revision: 1 }, { itemId: PL, revision: 1 }, { itemId: VO, revision: 1 }, { itemId: VM, revision: 1 }], primary: 0 },
    expectedRevision: 1, action: 'edit' }));
  h.findings.stop();
});

test('mounted values: a refused comparison study leaves no copied or listed number of it on screen (S2-V C5c, I5)', async () => {
  const h = await valueViewer();
  await h.press(h.row(), 'Edit');
  assert.ok(textOf(h.panel()).includes('77.8 mm') && textOf(h.panel()).includes('66.6'));
  h.server.denied = true;
  await h.press(h.panel(), 'Reload Comparison Items');
  assert.equal(h.panel().dataset.comparisonState, 'denied');
  assert.ok(h.row(), 'the finding being edited stays');
  assert.equal(h.line(PL).children[0].textContent, '[비교 검사] 접근할 수 없는 비교 검사의 표식 · ');
  assert.deepEqual(h.choices('Link Comparison Items'), []);
  const shown = textOf(h.panel());
  for (const secret of ['77.8', '66.6', '55.6', '44.4', 'P 길이', 'P 무계산', 'P 계산', 'P 지운 계산']) assert.equal(shown.includes(secret), false, secret);
  assert.ok(shown.includes('12.3 mm') && shown.includes(E5_TEXT), 'the first study copies stay');
  h.findings.stop();
});

test('the live head premise: config/ohif.js historyState() copies the values of the saved server head', () => {
  const start = source.indexOf('const historyState = () => ({'), end = source.indexOf('function hydrate()', start);
  assert.ok(start > 0 && end > start);
  const text = source.slice(start, end);
  assert.ok(text.includes('values: Array.isArray(e.head.item.baseline?.values) ? [...e.head.item.baseline.values] : null'));
  assert.ok(text.includes('heads: [...entries.values()].filter(e => e.head)'), 'only saved heads');
});

/* ---------- S2-C live disclosure and S2-L2b saved locations (TEST-S2C-LIVE, TEST-S2L-STORE, TEST-S2L-MOUNTED) ----------
 * The shipped model and Findings section; the viewer location API, the transports and the clock are synthetic. */
const LJ = 'c0000000-0000-4000-8000-00000000000a', LM = 'c0000000-0000-4000-8000-00000000000b', LM2 = 'c0000000-0000-4000-8000-00000000000c';
const LF = 'f0000000-0000-4000-8000-00000000d001', LHEX = 'e'.repeat(64), LV = 'c0000000-0000-4000-8000-00000000000d';
const liveEntry = extra => Object.assign({ present: true, revision: 2, hidden: false, working: false }, extra);
const jobCopy = extra => Object.assign({ kind: 'job', jobId: LJ, revision: 1, jobStudyUid: A, studyUid: A, studies: [A], snapshotVersion: 6, title: '저장 위치',
  authorActor: 'Reader', mark: { id: LM, label: '결절', point: [-0.33113281957650276, 2, 3], volume: { study: A, series: SERIES, frameOfReferenceUid: '1.2.9', sourceDigest: LHEX, sopCount: 33 } } }, extra);
const viewCopy = extra => jobCopy(Object.assign({ mark: null, snapshotVersion: 4, jobId: LV }, extra));

test('S2-C: live entry facts are copied as primitives from another realm and the notes come from them only', () => {
  const other = vm.runInNewContext('({ ok: true, highlighted: true, annotation: "shown", present: true, revision: 3, hidden: false, working: true, extra: 1 })');
  assert.deepEqual(plain(model.viewerResult(other)), { ok: true, highlighted: true, annotation: 'shown', live: { present: true, revision: 3, hidden: false, working: true } });
  assert.deepEqual(model.viewerResult({ ok: true, highlighted: false, annotation: 'missing', present: false }), { ok: true, highlighted: false, annotation: 'missing', live: { present: false, revision: null, hidden: false, working: false } });
  assert.deepEqual(model.viewerResult({ ok: true, highlighted: true, annotation: 'shown', present: 'yes', revision: 3 }), { ok: true, highlighted: true, annotation: 'shown' }, 'no live facts without a boolean present');
  assert.equal(model.viewerResult({ ok: true, highlighted: true, annotation: 'shown', present: true, revision: 0 }).live.revision, null);
  const reply = model.validReply({ type: 'kin-finding-nav-reply', request: REQUEST, owner: 'o', studies: [A], activeUid: A, result: 'ok', highlighted: true, annotation: 'shown', present: true, revision: 2, hidden: false, working: false },
    { request: REQUEST, owner: 'o', studies: [A], activeUid: A });
  assert.deepEqual(reply.live, liveEntry());
  const note = (live, frozen) => model.liveText({ ok: true, live }, frozen);
  assert.equal(note(liveEntry(), 2), '');
  assert.equal(note(liveEntry({ revision: 3 }), 2), '표시한 표식은 현재판 r3이며 소견의 수치는 연결 당시 r2의 사본입니다(위치·수치가 다를 수 있음).');
  assert.equal(note(liveEntry({ working: true }), 2), '편집 중인 미저장 위치일 수 있습니다.');
  assert.equal(note(liveEntry({ revision: null }), 2), '연결 당시 판인지 확인하지 못했습니다.');
  assert.equal(note(liveEntry({ revision: 4, working: true }), 2), model.LIVE_TEXT.revised(4, 2) + ' ' + model.LIVE_TEXT.working);
  assert.equal(note(liveEntry({ hidden: true, revision: 9 }), 2), '', 'a hidden entry keeps the "not drawn" arrival text');
  assert.equal(note({ present: false, revision: null, hidden: false, working: false }, 2), '');
  assert.equal(model.liveText({ ok: true }, 2), '', 'a viewer without live facts adds nothing');
});

test('S2-C: the store shows the live note of the arrival, never the list state', async () => {
  const t = transport();
  const saved = t.head('f0000000-0000-4000-8000-000000000001', 1, { links: [{ itemId: ITEM, linkState: 'current', headRevision: 2, headHidden: false }] });
  t.state.items = [saved];
  let live = liveEntry({ revision: 3 });
  const { store } = makeStore(t, { navigate: async () => ({ ok: true, highlighted: true, annotation: 'shown', ...live }) });
  store.syncHistory(history(A, [])); await tick();
  const e = store.state().entries.get(saved.id);
  assert.equal((await store.navigate(e)).ok, true);
  assert.equal(e.message, model.LIVE_TEXT.revised(3, 2), 'the list said current; the viewer shows r3');
  saved.links = [{ itemId: ITEM, linkState: 'revised', headRevision: 5, headHidden: false }]; t.state.items = [saved];
  await store.load(); live = liveEntry({ revision: 2 });
  const same = store.state().entries.get(saved.id);
  await store.navigate(same);
  assert.equal(same.message, '', 'the list said revised; the viewer shows the linked revision');
  live = liveEntry({ working: true }); await store.navigate(same);
  assert.equal(same.message, model.LIVE_TEXT.working);
  // The shipped history closure reports its entry at arrival, and an unknown item as absent.
  const h = await mounted();
  const arrived = h.window.kinViewerHistoryNavigate(findingTarget({ sopUid: '1.3', itemId: 'a0000000-0000-4000-8000-000000000001' }));
  await flush(); await h.release();
  assert.deepEqual(plain(await arrived), { ok: true, highlighted: false, annotation: 'key', present: true, revision: 1, hidden: false, working: false });
  const unknown = h.window.kinViewerHistoryNavigate(findingTarget({ itemId: 'a0000000-0000-4000-8000-00000000ffff' }));
  await flush(); await h.release();
  assert.deepEqual(plain(await unknown), { ok: true, highlighted: false, annotation: 'missing', present: false });
});

test('S2-L R5: only a successful findings answer without the schema header makes the store read-only; errors never do; every request names it', async () => {
  const t = transport(); t.state.items = [t.head('f0000000-0000-4000-8000-000000000001', 1)];
  let header = null;
  const base = t.fetch;
  t.fetch = async (url, options) => { const res = await base(url, options); return url.includes('/findings') ? { ...res, headers: { get: name => name === 'X-KIN-Finding-Schema' ? header : null } } : res; };
  const { store } = makeStore(t);
  store.syncHistory(history(A, [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false }])); await tick();
  assert.equal(store.state().compat, 'old-api');
  assert.equal(store.state().entries.size, 1, 'saved findings stay visible');
  assert.ok(store.state().status.endsWith(model.OLD_API_TEXT), store.state().status);
  assert.deepEqual([store.writable(), store.newDraft()], [false, null]);
  const e = store.state().entries.get('f0000000-0000-4000-8000-000000000001');
  store.edit(e); assert.equal(e.editing, false);
  assert.equal(await store.save(e, 'hide', '사유'), false);
  assert.equal(t.log.filter(x => x.options.method === 'POST').length, 0, 'never a version 1 fallback write');
  // The current API names itself: writable again. A refused or failed answer without the header changes nothing.
  header = '2'; await store.load();
  assert.deepEqual([store.state().compat, store.writable()], ['v2', true]);
  const d = store.newDraft(); store.updateDraft(d, { title: '새 소견', characteristics: '경계 불명확' });
  assert.equal(store.toggleSource(d, ITEM), true);
  header = null;
  t.state.responses.push({ status: 503, body: { message: 'proxy' } });
  assert.equal(await store.save(d, 'create'), false);
  assert.equal(store.state().compat, 'v2', 'a 503 without the header is not an old API');
  t.state.responses.push({ status: 409, body: { code: 'FINDING_SOURCE_STALE', itemId: ITEM, headRevision: 3, headHidden: false } });
  assert.equal(await store.save(d), false);
  assert.equal(store.state().compat, 'v2');
  assert.ok(t.log.every(x => x.options.headers['X-KIN-Finding-Schema'] === '2'), 'every request names the record format');
  // A pending body kept across an older API answer is not sent while that API answers.
  const p = store.newDraft(); store.updateDraft(p, { title: '보류' }); store.toggleSource(p, ITEM);
  t.state.responses.push({ status: 503, body: { message: 'later' } });
  assert.equal(await store.save(p, 'create'), false); assert.ok(p.pending);
  await store.load(); assert.equal(store.state().compat, 'old-api');
  const posts = t.log.filter(x => x.options.method === 'POST').length;
  assert.equal(await store.save(p), false);
  assert.equal(t.log.filter(x => x.options.method === 'POST').length, posts);
  assert.ok(p.pending, 'the pending request is kept for the current API');
  assert.ok(p.message.startsWith(model.OLD_API_TEXT));
});

test('S2-L DN7: version 2 bodies, drafts and code-point limits; version 1 heads keep their shape and their hide', async () => {
  const draft = { title: '', text: '', characteristics: '가', primary: 5, sources: [{ itemId: ITEM, revision: 2, studyUid: B }, { jobId: LJ, revision: 3, markId: LM, studyUid: B }, { jobId: LJ, revision: 3 }] };
  assert.equal(JSON.stringify(model.commandBody(draft, null, 'create', '', REQUEST, 2)), JSON.stringify({ requestId: REQUEST, item: { schemaVersion: 2, title: '', text: '', characteristics: '가',
    sources: [{ itemId: ITEM, revision: 2 }, { jobId: LJ, revision: 3, markId: LM }, { jobId: LJ, revision: 3 }], primary: 0 } }));
  assert.equal(model.draftProblem(draft), null, 'characteristics alone are enough');
  const astral = '\u{1F600}'.repeat(1000);
  assert.equal(model.draftProblem({ ...draft, characteristics: astral }), null);
  assert.equal(model.draftProblem({ ...draft, characteristics: astral + '\u{1F600}' }), '병변 특성은 1000자 이하여야 합니다.');
  assert.equal(model.draftProblem({ ...draft, characteristics: ' ' }), '제목, 본문 또는 병변 특성을 입력하세요.');
  assert.equal(model.draftProblem({ ...draft, sources: [{ jobId: 'x', revision: 1 }] }), '연결한 표식의 저장 정보를 확인하세요.');
  assert.equal(model.draftProblem({ ...draft, sources: [{ jobId: LJ, revision: 1, markId: 'x' }] }), '연결한 표식의 저장 정보를 확인하세요.');
  assert.equal(model.draftProblem({ ...draft, sources: [{ jobId: LJ, revision: 1 }, { jobId: LJ, revision: 2 }] }), '같은 표식을 두 번 연결할 수 없습니다.');
  assert.equal(model.CHARACTERISTICS, 1000); assert.equal(model.SCHEMA, 2);
  // Draft copies: a version 2 head names its characteristics and job pairs; a version 1 head keeps the shipped draft shape.
  const v2 = { id: LF, studyUid: A, revision: 3, item: { schemaVersion: 2, title: 'T', text: '', characteristics: astral, primary: 1,
    sources: [jobCopy({ studyUid: B, studies: [A, B], mark: { ...jobCopy().mark, volume: { ...jobCopy().mark.volume, study: B } } }), viewCopy()] } };
  assert.deepEqual(model.itemOnly(v2), { title: 'T', text: '', characteristics: astral, primary: 1,
    sources: [{ jobId: LJ, revision: 1, markId: LM, studyUid: B }, { jobId: viewCopy().jobId, revision: 1 }] });
  const edit = JSON.parse(JSON.stringify(model.commandBody(model.itemOnly(v2), v2, 'edit', '', REQUEST, 2)));
  assert.equal(Buffer.compare(Buffer.from(edit.item.characteristics), Buffer.from(astral)), 0, 'a 1000-astral value round-trips byte for byte');
  assert.deepEqual(Object.keys(model.itemOnly({ studyUid: A, item: { schemaVersion: 1, title: 'T', text: 'X', primary: 0, sources: [{ itemId: ITEM, revision: 2, studyUid: A }] } })), ['title', 'text', 'primary', 'sources']);
  // The store: create and edit are version 2 (a version 1 head is promoted); hide keeps the head's version and content.
  const t = transport();
  const v1head = t.head('f0000000-0000-4000-8000-000000000001', 1);
  const v2head = t.head('f0000000-0000-4000-8000-000000000002', 2, { item: { schemaVersion: 2, title: 'V2', text: '본문', characteristics: astral, hidden: false, primary: 0, sources: [v1head.item.sources[0]] } });
  t.state.items = [v1head, v2head];
  const { store } = makeStore(t);
  store.syncHistory(history(A, [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false }])); await tick();
  const posts = () => t.log.filter(x => x.options.method === 'POST').map(x => x.options.body);
  t.state.responses.push({ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} });
  const one = store.state().entries.get(v1head.id), two = store.state().entries.get(v2head.id);
  await store.save(one, 'hide', '사유');
  assert.equal(posts()[0], JSON.stringify({ requestId: REQUEST, item: { schemaVersion: 1, title: 'T', text: 'X', sources: [{ itemId: ITEM, revision: 2 }], primary: 0 }, expectedRevision: 1, action: 'hide', reason: '사유' }));
  await store.save(two, 'hide', '사유');
  assert.equal(posts()[1], JSON.stringify({ requestId: REQUEST, item: { schemaVersion: 2, title: 'V2', text: '본문', characteristics: astral, sources: [{ itemId: ITEM, revision: 2 }], primary: 0 }, expectedRevision: 2, action: 'hide', reason: '사유' }));
  one.pending = null; store.edit(one); store.updateDraft(one, { characteristics: '승격' });
  await store.save(one, 'edit');
  assert.equal(JSON.parse(posts()[2]).item.schemaVersion, 2); assert.equal(JSON.parse(posts()[2]).item.characteristics, '승격');
  // New error codes keep the draft with their own texts.
  assert.ok(model.errorMessage({ status: 409, code: 'FINDING_SCHEMA_VERSION' }).includes('새로고침'));
  assert.ok(model.errorMessage({ status: 400, code: 'FINDING_JOB_MARK' }).includes('3D 표식'));
  assert.ok(model.errorMessage({ status: 409, code: 'FINDING_SOURCE_STALE', jobId: LJ, headRevision: 4, headHidden: false }).includes('r4'));
  assert.ok(model.errorMessage({ status: 404 }, { job: true }).includes('현재 검사를 판독 대상으로 연 화면'));
});

// A location API double in the shape of viewer-jobs.js kinViewerJobLocation; restore() answers from a queue or holds.
function locationDouble() {
  const d = { requests: [], answers: [], held: [], shownValue: null };
  d.api = { version: 1, shown: () => d.shownValue, owns: () => false,
    restore: request => { d.requests.push(JSON.parse(JSON.stringify(request))); const next = d.answers.shift();
      if (next === 'hold') return new Promise(resolve => d.held.push(resolve)); return Promise.resolve(next); } };
  return d;
}
async function locatedStore(items, extra) {
  const t = transport(); t.state.items = items;
  const loc = locationDouble(), clock = fakeClock();
  const kit = makeStore(t, Object.assign({ location: () => loc.api, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, studies: [A] }, extra));
  kit.store.syncHistory(history(A, [{ id: ITEM, revision: 2, hidden: false, referenceStatus: 'verified', working: false }])); await tick();
  return { t, loc, clock, ...kit };
}
const located = (id, sources, extra) => ({ id, studyUid: A, authorSub: 'reader-1', authorActor: 'Reader', revision: 2, hidden: false, createdAt: 't', updatedAt: 't',
  item: { schemaVersion: 2, title: 'L', text: '', characteristics: '', hidden: false, primary: 0, sources }, links: [], ...extra });

test('S2-L2b saved locations: the saved view list, marks only from the Job shown now, and the one-comparison rule', async () => {
  const k = await locatedStore([]);
  const views = { jobs: [{ id: LJ, studyUid: A, revision: 2, hidden: false, snapshotVersion: 6, title: 'MPR', authorActor: 'R' },
    { id: LM, studyUid: B, revision: 1, hidden: false, snapshotVersion: 4, title: 'other anchor' }, { id: LM2, studyUid: A, revision: 1, hidden: false, snapshotVersion: 16, title: 'future' },
    { id: LF, studyUid: A, revision: 1, hidden: true, snapshotVersion: 2, title: 'hidden' }] };
  k.t.state.responses.push({ status: 200, body: views });
  await k.store.loadJobs();
  assert.equal(k.t.log.at(-1).url, '/api/studies/' + A + '/viewer-jobs?mine=false&includeHidden=false');
  assert.deepEqual([...k.store.state().jobs.list.keys()], [LJ], 'this anchor, visible, linkable versions only');
  const d = k.store.newDraft();
  assert.equal(k.store.toggleJob(d, LJ), true);
  assert.deepEqual(d.draft.sources, [{ jobId: LJ, revision: 2 }]);
  assert.equal(k.store.toggleJob(d, LJ, LM), false, 'no 3D point unless its Job is shown');
  k.loc.shownValue = { jobId: LJ, revision: 2, snapshotVersion: 6, studies: [A, B], marks: [{ id: LM, label: '결절' }] };
  assert.equal(k.store.toggleJob(d, LJ, LM2), false, 'a mark that is not shown');
  assert.equal(k.store.toggleJob(d, LJ, LM), true);
  assert.deepEqual(d.draft.sources[1], { jobId: LJ, revision: 2, markId: LM, studyUid: B });
  assert.equal(k.store.comparisonOf(d), B);
  k.loc.shownValue = { jobId: LM2, revision: 1, snapshotVersion: 6, studies: [A, '9.9.9'], marks: [{ id: LM2, label: 'x' }] };
  assert.equal(k.store.toggleJob(d, LM2, LM2), false, 'another comparison study than the draft names');
  k.loc.shownValue = { jobId: LM2, revision: 1, snapshotVersion: 6, studies: ['9.9.9'], marks: [{ id: LM2, label: 'x' }] };
  assert.equal(k.store.shownJob(), null, 'a Job of another anchor is never shown for linking');
  assert.equal(k.store.toggleJob(d, LJ), true, 'toggling again unlinks'); assert.equal(d.draft.sources.length, 1);
  const body = JSON.parse(JSON.stringify(model.commandBody(d.draft, null, 'create', '', REQUEST, 2)));
  assert.deepEqual(body.item.sources, [{ jobId: LJ, revision: 2, markId: LM }]);
});

test('S2-L2b navigation: the exact request, outcomes copied field by field, and every text', async () => {
  const point = jobCopy(), view = viewCopy(), pair = jobCopy({ jobId: LM2, studyUid: B, studies: [A, B], mark: null, snapshotVersion: 2 });
  const k = await locatedStore([located(LF, [point, view, pair])]);
  const e = k.store.state().entries.get(LF);
  const cases = [
    [0, { state: 'restored', message: 'MPR 작업을 복원했습니다. 재구성 표시이며 원본 프레임 표식과 별개입니다.', point: 'all-planes' }, '3D 표식 위치로 이동했습니다. MPR 작업을 복원했습니다. 재구성 표시이며 원본 프레임 표식과 별개입니다.'],
    [0, { state: 'restored', message: '', point: 'source-plane', metadataRevision: 4 }, '3D 표식 위치로 이동했습니다. 기준 평면만 이동했습니다. ' + model.LOCATION_TEXT.metadata(4)],
    [0, { state: 'restored', message: '', point: 'failed', pointMessage: '저장 화면은 복원했지만 3D 표식 위치로는 이동하지 않았습니다. 연결 당시의 표식·볼륨과 다릅니다.', reason: 'point-mismatch' },
      '저장 화면은 복원했지만 3D 표식 위치로는 이동하지 않았습니다. 연결 당시의 표식·볼륨과 다릅니다.'],
    [0, { state: 'restored', message: '', point: 'none' }, model.LOCATION_TEXT.pointFailed],
    [1, { state: 'restored', message: 'MPR 작업을 복원했습니다.', point: 'none' }, '저장 화면을 복원했습니다(병변 위치 표식 없음). MPR 작업을 복원했습니다.'],
    [1, { state: 'refused', reason: 'job-hidden', message: '연결한 저장 작업이 숨겨져 있어 복원하지 않았습니다. 영상은 바꾸지 않았습니다.' }, '연결한 저장 작업이 숨겨져 있어 복원하지 않았습니다. 영상은 바꾸지 않았습니다.'],
    [1, { state: 'refused', reason: 'job-conflict', message: '' }, '저장 위치를 열지 않았습니다. 영상은 바꾸지 않았습니다.'],
    [1, { state: 'rolled-back', reason: 'apply-failed', message: '영상 상태를 적용하지 못했습니다.' }, '저장 화면을 적용하지 못해 이전 화면으로 되돌렸습니다. 영상 상태를 적용하지 못했습니다.'],
    [1, { state: 'screen-unknown', reason: 'apply-failed', message: '복원과 이전 화면 복구에 실패했습니다.' }, '복원 결과를 확인하지 못했습니다. 현재 영상을 확인하세요. 복원과 이전 화면 복구에 실패했습니다.'],
    [2, { state: 'continuing' }, model.LOCATION_TEXT.continuing],
    [1, { state: 'maybe' }, model.LOCATION_TEXT.unknown],
    [1, null, model.LOCATION_TEXT.unknown],
    [1, vm.runInNewContext('({ state: "restored", message: "다른 창", point: "none", reason: 7 })'), '저장 화면을 복원했습니다(병변 위치 표식 없음). 다른 창'],
  ];
  // N1: the machine-readable result per case; a restored view whose 3D point was not reached is never ok.
  const results = ['ok', 'ok', 'point-failed', 'point-failed', 'ok', 'job-hidden', 'job-conflict', 'rolled-back', 'apply-failed', 'continuing',
    'screen-unknown', 'screen-unknown', 'ok'];
  assert.equal(results.length, cases.length);
  for (const [at, [index, answer, text]] of cases.entries()) {
    k.loc.answers.push(answer);
    const result = await k.store.navigate(e, index);
    assert.equal(e.message, text, JSON.stringify(answer));
    assert.deepEqual([result.ok, result.result], [results[at] === 'ok', results[at]], JSON.stringify(answer));
    assert.deepEqual(JSON.parse(JSON.stringify(e.location)), { result: results[at], message: text });
  }
  // The failed point keeps the composite outcome: the view restored, the point failed, the viewer's own reason.
  k.loc.answers.push(cases[2][1]);
  assert.deepEqual(await k.store.navigate(e, 0), { ok: false, result: 'point-failed', reason: 'point-mismatch', state: 'restored', point: 'failed' });
  // Each request names exactly the frozen copy; another study set continues with the finding named, a same one does not.
  const [first, , , , second] = k.loc.requests;
  assert.deepEqual(first, { subject: 'reader-1', jobId: LJ, revision: 1, snapshotVersion: 6, studies: [A], mode: 'same-document', waitReady: false,
    mark: { id: LM, label: '결절', point: [-0.33113281957650276, 2, 3], volume: { study: A, series: SERIES, frameOfReferenceUid: '1.2.9', sourceDigest: LHEX, sopCount: 33 } } });
  assert.deepEqual([second.jobId, second.mark, second.mode], [view.jobId, null, 'same-document']);
  const continuing = k.loc.requests[9];
  assert.deepEqual([continuing.mode, continuing.studies, continuing.finding], ['continue', [A, B], { id: LF, revision: 2, source: 2 }]);
  // A malformed copy, a denied comparison, a missing or other-version API: refused before any request.
  const before = k.loc.requests.length;
  const broken = located('f0000000-0000-4000-8000-00000000d002', [jobCopy({ studies: [B, A] })]);
  k.t.state.items = [located(LF, [point, view, pair]), broken]; await k.store.load();
  const bad = k.store.state().entries.get(broken.id);
  assert.equal((await k.store.navigate(bad)).reason, 'invalid'); assert.equal(bad.message, model.LOCATION_TEXT.invalid);
  const noApi = await locatedStore([located(LF, [point])], { location: () => ({ version: 2, restore: () => assert.fail('another version') }) });
  const n = noApi.store.state().entries.get(LF);
  assert.equal((await noApi.store.navigate(n)).reason, 'tool-missing'); assert.equal(n.message, model.LOCATION_TEXT['tool-missing']);
  assert.equal(k.loc.requests.length, before);
});

test('S2-L2b B4: the backstop only changes the text; nothing else navigates until the restore settles; a late answer needs the same entry', async () => {
  const k = await locatedStore([located(LF, [jobCopy(), viewCopy()]), { ...located('f0000000-0000-4000-8000-00000000d003', []), item: { schemaVersion: 1, title: 'item', text: '', hidden: false, primary: 0,
    sources: [transport().head('x', 1).item.sources[0]] } }]);
  const e = k.store.state().entries.get(LF);
  k.loc.answers.push('hold');
  const pending = k.store.navigate(e, 0); await tick();
  assert.equal(e.message, model.LOCATION_TEXT.pending);
  assert.ok(k.store.state().jobNavigation);
  await k.clock.advance(269999); assert.equal(e.message, model.LOCATION_TEXT.pending);
  await k.clock.advance(1); assert.equal(e.message, model.LOCATION_TEXT.backstop, 'at 270 s the result is unknown, never success or unchanged');
  assert.ok(k.store.state().jobNavigation, 'still suspended after the backstop');
  // No second navigation of any kind while the first may still change the screen.
  assert.deepEqual(await k.store.navigate(e, 1), { ok: false, reason: 'busy' });
  const item = k.store.state().entries.get('f0000000-0000-4000-8000-00000000d003');
  assert.deepEqual(await k.store.navigate(item), { ok: false, reason: 'busy' });
  assert.equal(item.message, model.LOCATION_TEXT.waiting);
  assert.equal(k.loc.requests.length, 1); assert.equal(k.navigations.length, 0);
  // Drafts are untouched by the wait.
  const d = k.store.newDraft(); k.store.updateDraft(d, { title: '대기 중 초안' }); assert.equal(d.draft.title, '대기 중 초안');
  k.loc.held.shift()({ state: 'restored', message: '', point: 'all-planes' }); await pending;
  assert.equal(e.message, model.LOCATION_TEXT.point, 'the late verified answer of the same entry is shown');
  assert.equal(k.store.state().jobNavigation, null);
  assert.equal(k.clock.pending(), 0, 'no timer survives');
  k.loc.answers.push({ state: 'refused', reason: 'busy', message: 'x' });
  assert.equal((await k.store.navigate(e, 1)).state, 'refused', 'the next navigation runs');
  // An anchor change during the wait: superseded, nothing written; the late answer releases the suspension only.
  k.loc.answers.push('hold');
  e.message = 'marker';
  const moved = k.store.navigate(e, 0); await tick();
  k.store.syncHistory(history(B, [])); await tick();
  k.loc.held.shift()({ state: 'restored', message: '', point: 'all-planes' });
  assert.deepEqual(await moved, { ok: false, reason: 'superseded', state: 'restored' });
  assert.equal(e.message, model.LOCATION_TEXT.pending, 'the detached entry was not updated after the anchor changed');
  assert.equal(k.store.state().jobNavigation, null);
  // A session end during the wait: the late answer changes nothing.
  const s = await locatedStore([located(LF, [jobCopy()])]);
  const f = s.store.state().entries.get(LF);
  s.loc.answers.push('hold');
  const ended = s.store.navigate(f, 0); await tick();
  s.store.end();
  s.loc.held.shift()({ state: 'restored', point: 'all-planes' });
  assert.equal((await ended).reason, 'superseded');
});

test('S2-L2b continuation: once, after the first authorized list, only for the exact finding, revision and source', async () => {
  const items = [located(LF, [jobCopy(), jobCopy({ jobId: LM2, mark: null, snapshotVersion: 2 })])];
  const run = async continuation => { const k = await locatedStore(items, { continuation }); await tick(); return k; };
  let k = await run({ finding: LF, revision: 2, source: 0, jobId: LJ, refused: false });
  assert.equal(k.loc.requests.length, 1);
  assert.deepEqual([k.loc.requests[0].mode, k.loc.requests[0].waitReady, k.loc.requests[0].jobId], ['same-document', true, LJ]);
  await k.store.load(); await tick();
  assert.equal(k.loc.requests.length, 1, 'a later list never runs it again');
  for (const [name, c] of [['refused marker', { finding: LF, revision: 2, source: 0, jobId: null, refused: true }],
    ['other revision', { finding: LF, revision: 1, source: 0, jobId: LJ, refused: false }], ['other source', { finding: LF, revision: 2, source: 1, jobId: LJ, refused: false }],
    ['item source', { finding: LF, revision: 2, source: 5, jobId: LJ, refused: false }]]) {
    k = await run(c);
    assert.equal(k.loc.requests.length, 0, name);
    assert.equal(k.store.state().entries.get(LF).message, model.CONTINUE_REFUSED_TEXT, name);
  }
  k = await run({ finding: 'f0000000-0000-4000-8000-00000000dfff', revision: 2, source: 0, jobId: LJ, refused: false });
  assert.ok(k.store.state().status.endsWith(model.CONTINUE_REFUSED_TEXT)); assert.equal(k.loc.requests.length, 0);
  // Without session storage the URL alone names it, still once.
  k = await run({ finding: LF, revision: 2, source: 1, jobId: null, refused: false });
  assert.deepEqual(k.loc.requests.map(r => r.jobId), [LM2]);
});

/* The shipped Findings section with a version 2 finding holding a characteristics line, a 3D point and a saved view. */
async function locationViewer({ schemaHeader = '2', modelOverride } = {}) {
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  document.querySelector = selector => document.body.all().find(e => selector === '#' + e.id) || null;
  document.createTextNode = value => { const node = new Element('#text'); node.textContent = value; return node; };
  const host = new Element('div'); host.id = 'kin-viewer-history'; document.body.append(host);
  const loc = locationDouble();
  const item = { schemaVersion: 2, title: '위치 소견', text: '본문', characteristics: '경계 불명확한 간유리 결절', hidden: false, primary: 0, sources: [jobCopy({ studies: [VX], jobStudyUid: VX, studyUid: VX,
    mark: { ...jobCopy().mark, volume: { ...jobCopy().mark.volume, study: VX } } }), viewCopy({ studies: [VX], jobStudyUid: VX, studyUid: VX })] };
  const finding = { id: LF, studyUid: VX, authorSub: 'doctor', authorActor: 'Doctor', revision: 2, hidden: false, createdAt: 't', updatedAt: 't', item,
    links: [{ jobId: LJ, markId: LM, linkState: 'current', headRevision: 1, headHidden: false }, { jobId: viewCopy().jobId, markId: null, linkState: 'metadata-changed', headRevision: 3, headHidden: false }] };
  const server = { log: [] };
  const headers = { get: name => name === 'X-KIN-Finding-Schema' ? schemaHeader : null };
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, headers, json: async () => JSON.parse(JSON.stringify(body)) });
  const window = new EventTarget(), ticks = [];
  window.fetch = async (url, options) => {
    const method = (options && options.method) || 'GET';
    server.log.push({ method, url, body: options && options.body, headers: options && options.headers });
    if (url === '/api/me') return json(200, { sub: 'doctor', kind: 'member', roles: ['radiologist'] });
    if (method === 'POST') return json(503, { message: 'synthetic' });
    if (url.startsWith('/api/studies/' + VX + '/viewer-jobs?')) return json(200, { jobs: [{ id: LM2, studyUid: VX, revision: 1, hidden: false, snapshotVersion: 7, title: '평면 배치', authorActor: 'D' }] });
    if (url.startsWith('/api/studies/' + VX + '/findings/' + LF + '/revisions?'))
      return json(200, { revisions: [{ revision: 1, action: 'create', actor: 'Doctor', at: 't1', reason: '', item: { schemaVersion: 1, title: '처음', text: '', hidden: false, primary: 0, sources: [] } },
        { revision: 2, action: 'edit', actor: 'Doctor', at: 't2', reason: '', item }], nextCursor: null });
    if (url.startsWith('/api/studies/' + VX + '/findings?')) return json(200, { items: [finding], nextCursor: null });
    return json(404, {});
  };
  window.kinViewerHistoryState = () => ({ scope: VX, subject: 'doctor', ended: false, suspended: false, writable: true, heads: [] });
  window.kinViewerJobLocation = loc.api;
  window.prompt = () => '사유'; window.confirm = () => true;
  const sandbox = { window, document, crypto: webcrypto, console, Event, AbortController, URLSearchParams, setTimeout, clearTimeout,
    location: { search: '?StudyInstanceUIDs=' + VX }, setInterval: fn => { ticks.push(fn); return ticks.length; }, clearInterval() {} };
  vm.createContext(sandbox);
  vm.runInContext(shippedFile('finding-link-model.js'), sandbox);
  vm.runInContext(shippedFile('viewer-findings.js'), sandbox);
  const findings = window.kinViewerFindings({}, modelOverride ? modelOverride(sandbox.kinFindingLinkModel) : sandbox.kinFindingLinkModel);
  const mountedOk = findings.mount();
  const sync = async () => { for (let i = 0; i < 3; i++) { for (const fn of [...ticks]) fn(); await flush(); } };
  await sync();
  const panel = () => document.body.all().find(e => e.id === 'kin-viewer-findings');
  const row = () => panel().all().find(e => e.tagName === 'article' && e.dataset.findingId === LF);
  return { server, loc, findings, mountedOk, sync, panel, row, host,
    press: async (scope, name) => { const [b] = scope.all().filter(e => e.tagName === 'button' && e.textContent === name); assert.ok(b, name); b.click(); await flush(); await sync(); } };
}

test('mounted locations: characteristics line, point and view lines with their own buttons, and the restore request', async () => {
  const h = await locationViewer();
  const lines = h.row().all().filter(e => e.dataset.jobId);
  assert.deepEqual(lines.map(e => [e.dataset.sourceKind, e.dataset.linkState, e.children[0].textContent]), [
    ['point', 'current', '★ 3D Point · 결절 · 저장 위치 · v6 · r1 · '], ['view', 'metadata-changed', 'Saved View · 저장 위치 · v4 · r1 · ']]);
  assert.ok(textOf(lines[1]).includes(' (현재 r3)') && textOf(lines[1]).includes('제목·설명만'));
  assert.ok(h.row().all().some(e => e.dataset.kinCharacteristics === '' && e.textContent === 'Characteristics (병변 특성): 경계 불명확한 간유리 결절'));
  h.loc.answers.push({ state: 'restored', message: '', point: 'all-planes' });
  await h.press(lines[0], 'Go to 3D Point');
  assert.equal(h.loc.requests.length, 1);
  assert.deepEqual([h.loc.requests[0].jobId, h.loc.requests[0].mark.id, h.loc.requests[0].mode], [LJ, LM, 'same-document']);
  assert.ok(textOf(h.row()).includes('3D 표식 위치로 이동했습니다.'));
  const note = () => h.row().all().find(e => e.tagName === 'p' && e.dataset.kinMessage === '');
  assert.equal(note().dataset.kinLocationResult, 'ok');
  // N1: the view restored but the point was not reached: the text says so and the panel's result is point-failed, never ok.
  h.loc.answers.push({ state: 'restored', message: '', point: 'failed', reason: 'point-failed', pointMessage: '저장 화면은 복원했지만 3D 표식 위치로는 이동하지 않았습니다.' });
  await h.press(h.row().all().filter(e => e.dataset.jobId)[0], 'Go to 3D Point');
  assert.deepEqual([note().textContent, note().dataset.kinLocationResult], ['저장 화면은 복원했지만 3D 표식 위치로는 이동하지 않았습니다.', 'point-failed']);
  h.loc.answers.push({ state: 'refused', reason: 'job-hidden', message: '숨김' });
  await h.press(h.row().all().filter(e => e.dataset.jobId)[1], 'Open Saved View');
  assert.equal(h.loc.requests.length, 3);
  assert.equal(h.loc.requests[2].mark, null);
  assert.deepEqual([note().textContent, note().dataset.kinLocationResult], ['숨김', 'job-hidden']);
  // History: every revision's characteristics and linked kinds, counted; the main line keeps the shipped shape.
  await h.press(h.row(), 'History');
  const shown = h.row().all().filter(e => e.tagName === 'p').map(e => e.textContent);
  assert.ok(shown.includes('r2 · 수정 · Doctor · t2 ·  · 위치 소견 · 표식 2개'));
  assert.ok(shown.includes('Characteristics (병변 특성): 경계 불명확한 간유리 결절'));
  assert.ok(shown.includes('연결: 2D 표식 0개 · Saved View 1개 · 3D Point 1개 · v2'));
  assert.ok(shown.includes('연결: 2D 표식 0개 · Saved View 0개 · 3D Point 0개 · v1'));
  assert.equal(shown.filter(e => e.startsWith('Characteristics')).length, 2, 'the version 1 revision has no characteristics line');
  // Another text replacing the location text carries no location result.
  await h.press(h.row(), 'Edit'); await h.press(h.row(), 'Save');
  assert.ok(note().textContent && note().textContent !== '숨김', note().textContent);
  assert.equal(note().dataset.kinLocationResult, undefined);
  h.findings.stop();
});

test('mounted locations: the editor names its characteristics field and helper, lists saved views and shown points, and saves version 2', async () => {
  const h = await locationViewer();
  h.loc.shownValue = { jobId: LJ, revision: 1, snapshotVersion: 6, studies: [VX], marks: [{ id: LM, label: '결절' }, { id: LM2, label: '두번째' }] };
  await h.press(h.row(), 'Edit');
  const field = h.row().all().find(e => e.attributes['aria-label'] === 'Finding Characteristics');
  assert.ok(field, 'the labelled characteristics field');
  assert.equal(field.maxLength, 1000); assert.equal(field.value, '경계 불명확한 간유리 결절');
  const help = h.row().all().find(e => e.id === field.attributes['aria-describedby']);
  assert.equal(help.textContent, '사용자가 직접 입력하는 병변 특성입니다. 정해진 용어나 항목은 없으며 판독문에 자동 반영하지 않습니다.');
  const labels = h.row().all().filter(e => e.tagName === 'label');
  assert.ok(labels.some(l => l.children[0] === field || l.textContent === 'Characteristics (병변 특성)'));
  const box = h.row().all().find(e => e.tagName === 'details' && e.dataset.kinLocations === '');
  const choices = box.all().filter(e => e.tagName === 'input').map(e => e.attributes['aria-label']);
  assert.deepEqual(choices, ['Link 3D Point 두번째 · 저장 작업 r1', 'Link Saved View 평면 배치 · v7 · r1'], 'linked pairs are not offered again');
  const pick = label => { const input = box.all().find(e => e.attributes['aria-label'] === label); input.checked = true; input.dispatchEvent(new Event('change')); return input; };
  const clicked = pick('Link 3D Point 두번째 · 저장 작업 r1'); pick('Link Saved View 평면 배치 · v7 · r1'); await h.sync();
  // Each choice is offered once: the linked pair leaves the list, so the clicked checkbox is removed from the panel rather than
  // left checked in it, and the linked source line appears instead. A hosted click must assert that state, never the checkbox.
  const listed = h.row().all().find(e => e.tagName === 'details' && e.dataset.kinLocations === '');
  assert.deepEqual(listed.all().filter(e => e.tagName === 'input').map(e => e.attributes['aria-label']), [], 'every offered pair is linked');
  assert.equal(h.panel().all().includes(clicked), false, 'the clicked checkbox is gone from the panel');
  assert.deepEqual(h.row().all().filter(e => e.dataset.jobId).map(e => e.dataset.jobId).sort(),
    [LJ, LJ, LM2, viewCopy().jobId].sort(), 'the two new pairs are shown as source lines');
  field.value = '분엽상 경계'; field.dispatchEvent(new Event('input'));
  const edited = h.row().all().find(e => e.attributes['aria-label'] === 'Finding Characteristics');
  edited.value = '분엽상 경계'; edited.dispatchEvent(new Event('input'));
  await h.press(h.row(), 'Save');
  const post = h.server.log.filter(x => x.method === 'POST');
  assert.equal(post.length, 1);
  const body = JSON.parse(post[0].body);
  assert.equal(post[0].body, JSON.stringify({ requestId: body.requestId, item: { schemaVersion: 2, title: '위치 소견', text: '본문', characteristics: '분엽상 경계',
    sources: [{ jobId: LJ, revision: 1, markId: LM }, { jobId: viewCopy().jobId, revision: 1 }, { jobId: LJ, revision: 1, markId: LM2 }, { jobId: LM2, revision: 1 }], primary: 0 },
    expectedRevision: 2, action: 'edit' }));
  assert.equal(post[0].headers['X-KIN-Finding-Schema'], '2');
  assert.ok(h.server.log.some(x => x.url === '/api/studies/' + VX + '/viewer-jobs?mine=false&includeHidden=false'));
  h.findings.stop();
});

test('mounted locations: an older API makes the section read-only; another model version is never mounted', async () => {
  const h = await locationViewer({ schemaHeader: null });
  const buttons = h.panel().all().filter(e => e.tagName === 'button');
  assert.equal(buttons.find(b => b.textContent === 'New Finding').disabled, true);
  assert.equal(buttons.some(b => b.textContent === 'Edit' || b.textContent === 'Hide'), false);
  assert.ok(h.panel().all().find(e => e.id === 'kin-viewer-findings-status').textContent.endsWith(OLD_TEXT()));
  assert.ok(h.row(), 'the saved finding is still shown');
  h.findings.stop();
  const other = await locationViewer({ modelOverride: m => Object.assign({}, m, { SCHEMA: 1 }) });
  assert.equal(other.mountedOk, false);
  assert.equal(other.host.all().find(e => e.id === 'kin-viewer-findings').textContent, '화면 구성 요소 판이 다릅니다. 새로고침하세요.');
  assert.equal(other.host.all().some(e => e.tagName === 'button'), false);
  other.findings.stop();
  assert.equal(other.host.all().some(e => e.id === 'kin-viewer-findings'), false);
});
const OLD_TEXT = () => model.OLD_API_TEXT;

test('mounted continuation: the one-use nonce is consumed once; a missing record refuses the automatic restore', async () => {
  const load = async (search, stored, storage = true) => {
    const store = new Map(stored ? [[stored[0], stored[1]]] : []);
    const saved = globalThis.__kinStorage;
    const viewer = await (async () => {
      const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
      document.querySelector = selector => document.body.all().find(e => selector === '#' + e.id) || null;
      document.createTextNode = value => { const node = new Element('#text'); node.textContent = value; return node; };
      const host = new Element('div'); host.id = 'kin-viewer-history'; document.body.append(host);
      const loc = locationDouble(); loc.answers.push({ state: 'restored', message: '', point: 'all-planes' }, { state: 'restored', message: '', point: 'all-planes' });
      const item = { schemaVersion: 2, title: 'C', text: '', characteristics: '', hidden: false, primary: 0, sources: [jobCopy({ jobStudyUid: VX, studyUid: VX, studies: [VX],
        mark: { ...jobCopy().mark, volume: { ...jobCopy().mark.volume, study: VX } } })] };
      const window = new EventTarget(), ticks = [];
      const json = body => ({ status: 200, ok: true, headers: { get: () => '2' }, json: async () => JSON.parse(JSON.stringify(body)) });
      window.fetch = async url => url === '/api/me' ? json({ sub: 'doctor', kind: 'member', roles: ['radiologist'] })
        : json({ items: [{ id: LF, studyUid: VX, authorSub: 'doctor', authorActor: 'D', revision: 4, hidden: false, createdAt: 't', updatedAt: 't', item, links: [] }], nextCursor: null });
      window.kinViewerHistoryState = () => ({ scope: VX, subject: 'doctor', ended: false, suspended: false, writable: true, heads: [] });
      window.kinViewerJobLocation = loc.api;
      window.sessionStorage = storage ? { getItem: k => store.get(k) ?? null, removeItem: k => store.delete(k), setItem: (k, v) => store.set(k, v) }
        : { getItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
      const sandbox = { window, document, crypto: webcrypto, console, Event, AbortController, URLSearchParams, setTimeout, clearTimeout,
        location: { search }, setInterval: fn => { ticks.push(fn); return ticks.length; }, clearInterval() {} };
      vm.createContext(sandbox);
      vm.runInContext(shippedFile('finding-link-model.js'), sandbox);
      vm.runInContext(shippedFile('viewer-findings.js'), sandbox);
      const findings = window.kinViewerFindings({}, sandbox.kinFindingLinkModel);
      const sync = async () => { for (let i = 0; i < 3; i++) { for (const fn of [...ticks]) fn(); await flush(); } };
      findings.mount(); await sync();
      return { loc, findings, sync, store, text: () => textOf(document.body) };
    })();
    globalThis.__kinStorage = saved;
    return viewer;
  };
  const nonce = '11111111-2222-4333-8444-555555555555';
  const search = '?StudyInstanceUIDs=' + VX + '&kinFinding=' + LF + '&kinFindingRevision=4&kinFindingSource=0&kinFindingNonce=' + nonce;
  const record = JSON.stringify({ finding: LF, revision: 4, source: 0, jobId: LJ });
  const good = await load(search, ['kin-finding-continue:' + nonce, record]);
  assert.equal(good.loc.requests.length, 1); assert.equal(good.loc.requests[0].waitReady, true);
  assert.equal(good.store.size, 0, 'the nonce is consumed');
  // A second mount in the same document (mode re-entry) never runs it again.
  good.findings.stop(); good.findings.mount(); await good.sync();
  assert.equal(good.loc.requests.length, 1);
  const missing = await load(search, null);
  assert.equal(missing.loc.requests.length, 0); assert.ok(missing.text().includes(model.CONTINUE_REFUSED_TEXT));
  const mismatched = await load(search, ['kin-finding-continue:' + nonce, JSON.stringify({ finding: LF, revision: 3, source: 0, jobId: LJ })]);
  assert.equal(mismatched.loc.requests.length, 0);
  const blocked = await load(search, null, false);
  assert.equal(blocked.loc.requests.length, 1, 'without session storage the request runs once in this document');
  const plainPage = await load('?StudyInstanceUIDs=' + VX, null);
  assert.equal(plainPage.loc.requests.length, 0); assert.equal(plainPage.text().includes(model.CONTINUE_REFUSED_TEXT), false);
  for (const v of [good, missing, mismatched, blocked, plainPage]) v.findings.stop();
});

// The S2-B1 list/command suite runs in this same process as well, so the existing hosted Validate step
// for this file also executes it; `node --test tests/finding_command_test.cjs` runs it alone.
require('./finding_command_test.cjs');
