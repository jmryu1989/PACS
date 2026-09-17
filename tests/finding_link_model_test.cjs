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
  const sandbox = { Number, Array, Object, Promise, JSON, RegExp, Error, console };
  vm.createContext(sandbox);
  vm.runInContext(text + ';this.reference = kinViewerImageReference; this.navigateTo = kinViewerNavigateTo; this.REASONS = KIN_NAVIGATION_REASONS;', sandbox);
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

// The S2-B1 list/command suite runs in this same process as well, so the existing hosted Validate step
// for this file also executes it; `node --test tests/finding_command_test.cjs` runs it alone.
require('./finding_command_test.cjs');
