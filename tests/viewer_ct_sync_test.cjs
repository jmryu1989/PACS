'use strict';
/* REQ-S5-U2c-CLINICIAN-CT-SYNC -> RISK-S5-U2c-FALSE-SESSION-END / RISK-S5-U2c-ALLOWLIST-WIDENING / RISK-S5-U2c-WRONG-PATIENT-SYNC
   / RISK-S5-U2c-SYNC-AFTER-DOCUMENT-END -> TEST-S5-U2c-PURE (Astra S5-VIEWER-UXR-R-001 F01, VUI-02; fix1: Astra S5-U2c-R-001 F01;
   fix2: Astra S5-U2c-B-R-001 F01 an end after a refusal is kept, F02 every producer names its reason, F03 a dropped event's late
   failure says nothing; U5 amendments: only the page authority ends a session. An ordinary HTTP refusal stays local,
   including when it answers after mode exit. An incoming account mismatch never changes the bound identity).

   config/ohif.js runs unchanged in a vm and kinCreateCTSync is mounted against in-test stand-ins for the pinned OHIF services
   (sync group, grid, display sets, cornerstone viewports, metadata and image loader) and for the API. The API stand-in answers
   GET me, GET studies and GET clinician/studies, and refuses a clinician-only caller every route outside the approved
   clinician_policy_fixtures.json allowlist. Compiled policy parity belongs to the API suite. Its native synchronizer is deliberately permissive:
   it moves every enabled target to the nearest position (or by index when there is no geometry), so a target that stays put was
   held by the viewer's own gate. Synthetic data only: no network, server, browser or credentials. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { sessionWorld, response: respond } = require('./viewer_session_fixture.cjs');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'config', 'ohif.js'), 'utf8');
const POLICY = require('./clinician_policy_fixtures.json');
const SESSION_ROUTES = POLICY.session_routes;
const BUSINESS_ROUTES = POLICY.business_routes;
const ALLOWED = new Set([...SESSION_ROUTES, ...BUSINESS_ROUTES]);
const CLINICIAN_ROLE = POLICY.clinician_role;
const APP_ROLES = new Set(POLICY.app_roles);
const clinicianOnly = roles => { const app = roles.filter(role => APP_ROLES.has(role)); return app.length > 0 && app.every(role => role === CLINICIAN_ROLE); };

// config/ohif.js kinCreateCTSync wording, verbatim.
const TEXT = {
  ended: '세션이 변경되었거나 종료되어 위치 동기를 중지했습니다. 다시 로그인한 뒤 뷰어를 여세요',
  checking: '검사 접근 정보를 확인하는 중입니다. 확인한 뒤 위치 동기를 적용합니다',
  confirmed: '검사 접근 정보를 확인했습니다. 위치 동기를 사용할 수 있습니다',
  failed: '검사 접근 정보를 확인하지 못해 위치 동기를 멈췄습니다. 연결 상태를 확인한 뒤 다시 확인하세요',
  denied: '이 계정으로 검사 접근 정보를 확인할 수 없어 위치 동기를 멈췄습니다. 권한을 확인한 뒤 다시 확인하세요',
  changed: '계정의 역할이 바뀌어 위치 동기를 멈췄습니다. 검사 접근 정보를 다시 확인하세요',
  synced: '같은 좌표계의 CT 위치 동기',
  applyFailed: '위치 동기를 적용하지 못했습니다. 영상과 연결 상태를 확인하세요',
  applyDenied: '위치 동기를 적용하지 못했습니다. 이 계정의 검사 접근 권한을 확인할 수 없습니다',
  off: '위치 동기 꺼짐',
};
const LIMIT = reason => '위치 동기 제한: ' + reason;
const AVOIDED = /진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b/i;

// ── synthetic accounts, studies and series ──
const INST = 'SYN-INST-A';
const member = (roles, sub) => ({ kind: 'member', sub, actor: sub.toLowerCase(), institution: INST, roles, user: sub.toLowerCase(),
  displayName: 'SYN ' + sub });
const CLINICIAN = member(['clinician', 'default-roles-kin', 'offline_access'], 'SYN-CLIN');
const OTHER_CLINICIAN = member(['clinician'], 'SYN-CLIN-2');
const CLINICIAN_NOW_MIXED = member(['clinician', 'radiologist'], 'SYN-CLIN');
const RADIOLOGIST = member(['radiologist', 'default-roles-kin'], 'SYN-RAD');
const TECHNICIAN = member(['technician'], 'SYN-TECH');
const ADMIN = member(['admin'], 'SYN-ADMIN');
const MIXED = member(['clinician', 'radiologist'], 'SYN-MIX');

const PREFIX = '1.2.826.0.1.3680043.10.5432';
const CUR = `${PREFIX}.2150`, PRI = `${PREFIX}.2180`, OTH = `${PREFIX}.2190`, NOK = `${PREFIX}.2195`, ABSENT = `${PREFIX}.3000`;
const KEY = `${INST}|SYN-P-100`, OTHER_KEY = `${INST}|SYN-P-200`;
const KEYS = { [CUR]: KEY, [PRI]: KEY, [OTH]: OTHER_KEY, [NOK]: null };
const row = uid => ({ uid, id: 'SYN-P', name: 'SYN NAME', birth: '19800517', sex: 'M', date: '20260320', acc: 'SYN-ACC', desc: 'SYN CT',
  modality: 'CT', count: 16, series: 2, sourcePatientKey: Object.hasOwn(KEYS, uid) ? KEYS[uid] : `${INST}|SYN-FILL-${uid.slice(-4)}`,
  institutionName: 'SYN Hospital A', tele: false, report: { final: false, rs: 'W' } });
const ROWS = [CUR, PRI, OTH, NOK].map(row);
// 250 visible studies; the opened pair sorts onto the second page of 100.
const MANY = Array.from({ length: 250 }, (_, i) => row(`${PREFIX}.${2000 + i}`));

const range = (from, to, step) => Array.from({ length: (to - from) / step + 1 }, (_, i) => from + i * step);
const SERIES = {
  S1: { study: CUR, series: `${CUR}.1`, zs: range(0, 30, 2), frame: 'SYN-FOR-1' },
  S2: { study: CUR, series: `${CUR}.2`, zs: range(0, 28, 4), frame: 'SYN-FOR-1' }, // a spaced series of the same study
  S3: { study: PRI, series: `${PRI}.1`, zs: range(0, 28, 4), frame: 'SYN-FOR-1' }, // the prior: same server patient key and frame
  S4: { study: PRI, series: `${PRI}.2`, zs: range(0, 28, 4), frame: 'SYN-FOR-2' }, // the prior in another frame of reference
  S5: { study: OTH, series: `${OTH}.1`, zs: range(0, 28, 4), frame: 'SYN-FOR-1' }, // another patient with the same frame UID
  S6: { study: CUR, series: `${CUR}.6`, zs: range(0, 28, 4), frame: 'SYN-FOR-1', geometry: false }, // no plane geometry
  S7: { study: NOK, series: `${NOK}.1`, zs: range(0, 28, 4), frame: 'SYN-FOR-1' }, // a study the server gives no patient key
  S8: { study: ABSENT, series: `${ABSENT}.1`, zs: range(0, 28, 4), frame: 'SYN-FOR-1' }, // opened but not in the list
};
const ORIGIN = 'https://viewer.test', ENGINE = 'syn-engine', CT = '1.2.840.10008.5.1.4.1.1.2';
const OPENED = `?StudyInstanceUIDs=${CUR},${PRI}&hangingProtocolId=@ohif/hpCompare`;

const plain = value => JSON.parse(JSON.stringify(value));
const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const NETWORK = Symbol('network failure');
// A DOM node with what kinCreateCTSync touches.
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.hidden = false; this.style = {};
    this.attributes = new Map(); this.listeners = new Map(); this.own = ''; }
  get textContent() { return this.own + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.own = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { const parent = this.parentNode; if (parent) { parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; } }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this }); }
}

function routeKey(method, pathname) {
  assert.ok(pathname.startsWith('/api/'), `an API path: ${pathname}`);
  return `${method} ${pathname.slice(5).split('/').map(decodeURIComponent).join('/')}`;
}

// The API as the viewer meets it: auth.guard.ts's clinician-only gate, then GET me / GET studies / GET clinician/studies.
function serve(w, entry) {
  const account = w.account;
  if (entry.key === 'GET me') return respond(200, account);
  if (clinicianOnly(account.roles || []) && !ALLOWED.has(entry.key)) return respond(403, { code: 'CLINICIAN_ROUTE_DENIED' });
  if (entry.key === 'GET studies') return respond(200, { studies: w.rows.map(r => ({ ...r, state: { rs: 'W', ov: null } })), observedAt: 'SYN' });
  if (entry.key !== 'GET clinician/studies') return respond(404, { message: 'SYN unknown route' });
  // clinicianCaller: need('clinician') (admin passes); the page query is study-page.ts's (limit, after only).
  if (!account.roles.includes('clinician') && !account.roles.includes('admin')) return respond(403, { message: '임상의 조회' });
  const query = new URLSearchParams(entry.query);
  if ([...query.keys()].some(k => k !== 'limit' && k !== 'after') || query.getAll('limit').length !== 1 || query.get('limit') !== '100') {
    w.badQueries.push(entry.url); return respond(400, { message: 'SYN page query' });
  }
  const rows = [...w.rows].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  let start = 0;
  if (query.has('after')) {
    if (!w.cursors.has(query.get('after'))) return respond(409, { code: 'STUDY_LIST_CHANGED' });
    start = w.cursors.get(query.get('after'));
  }
  const picked = rows.slice(start, start + 100);
  let next = null;
  if (start + picked.length < rows.length) {
    next = `eyJ2IjoxLCJwIjo${++w.cursorSeq}fQ.SYN_sig-${w.cursorSeq}`;
    w.cursors.set(next, start + picked.length);
  }
  return respond(200, { studies: picked, serverTime: '2026-09-27T00:00:00.000Z', pagination: { next, total: rows.length, offset: start, limit: 100 } });
}

function world(options = {}) {
  const w = { account: options.account || CLINICIAN, rows: options.rows || ROWS, log: [], held: [], holds: [], answer: null,
    cursors: new Map(), cursorSeq: 0, badQueries: [], moves: [], loads: [], registrations: [], holdLoads: false, heldLoads: [] };
  const body = new Node('body'), windowListeners = new Map(), channels = new Set(), timers = new Map();
  let timerSeq = 0;
  class Channel {
    constructor(name) { this.name = name; this.listeners = new Set(); this.onmessage = null; channels.add(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.add(fn); }
    removeEventListener(type, fn) { this.listeners.delete(fn); }
    postMessage() {}
    close() { channels.delete(this); }
  }
  const sandbox = {
    console, URL, URLSearchParams, AbortController, BroadcastChannel: Channel,
    location: { search: options.search || OPENED, origin: ORIGIN },
    document: { createElement: tag => new Node(tag), body },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    addEventListener: (type, fn) => { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn); },
    removeEventListener: (type, fn) => { windowListeners.get(type)?.delete(fn); },
    fetch: (url, init = {}) => new Promise((resolve, reject) => {
      const u = new URL(url, ORIGIN), method = String(init.method || 'GET').toUpperCase();
      const entry = { method, url: String(url), path: u.pathname, query: u.search, key: routeKey(method, u.pathname),
        binding: new Headers(init.headers).get('X-KIN-Session'), csrf: new Headers(init.headers).get('X-KIN-CSRF'), credentials: init.credentials ?? null, cache: init.cache ?? null,
        roles: [...(w.account.roles || [])], aborted: false };
      w.log.push(entry);
      const aborted = () => { entry.aborted = true; reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); };
      if (init.signal?.aborted) return aborted();
      const hold = w.holds.findIndex(h => h.match(entry));
      const answer = override => {
        const response = override === undefined ? (w.answer && w.answer(entry)) || serve(w, entry) : override;
        if (response === NETWORK) reject(new TypeError('Failed to fetch')); else resolve(response);
      };
      if (hold >= 0) {
        const [h] = w.holds.splice(hold, 1);
        // An uncancellable hold is an answer already on the wire: the abort of its mount no longer stops it.
        if (!h.uncancellable) init.signal?.addEventListener('abort', aborted, { once: true });
        entry.release = override => answer(override);
        w.held.push(entry);
        return;
      }
      init.signal?.addEventListener('abort', aborted, { once: true });
      answer();
    }),
  };
  sandbox.window = sandbox;
  w.page = sessionWorld(sandbox, sandbox.fetch, SOURCE + '\n;globalThis.__kin = { kinCreateCTSync, kinViewerSession, kinViewerClinicianOnly };');
  const kin = sandbox.__kin;

  // cornerstone viewports, display sets and the grid
  const planes = new Map(), viewports = new Map(), grid = new Map(), displaySets = new Map();
  let setSeq = 0;
  const zOf = id => planes.get(id)?.imagePositionPatient[2];
  w.show = (vp, name) => {
    const s = SERIES[name];
    const ids = s.zs.map((z, i) => `wadors:${ORIGIN}/dicom-web/studies/${s.study}/series/${s.series}/instances/${s.series}.${i}/frames/1`);
    if (s.geometry !== false) ids.forEach((id, i) => planes.set(id, { frameOfReferenceUID: s.frame, imagePositionPatient: [0, 0, s.zs[i]],
      rowCosines: [1, 0, 0], columnCosines: [0, 1, 0] }));
    const uid = `syn-ds-${++setSeq}`;
    displaySets.set(uid, { displaySetInstanceUID: uid, StudyInstanceUID: s.study, SeriesInstanceUID: s.series, Modality: 'CT', SOPClassUID: CT,
      images: ids.map(() => ({ SOPClassUID: CT })) });
    grid.set(vp, { viewportId: vp, displaySetInstanceUIDs: [uid] });
    viewports.set(vp, { id: vp, type: 'stack', index: 0, ids, getRenderingEngine: () => ({ id: ENGINE }), getImageIds() { return this.ids; },
      getCurrentImageIdIndex() { return this.index; }, getCurrentImageId() { return this.ids[this.index]; } });
  };
  w.at = vp => { const v = viewports.get(vp); return { index: v.index, z: zOf(v.getCurrentImageId()) ?? null }; };
  w.image = vp => viewports.get(vp).getCurrentImageId();
  class NativeSync {
    constructor(id) { this.id = id; this.targets = []; this.options = {}; this.enabled = true; this.destroyed = false; }
    add(info) { this.targets.push(info); }
    getTargetViewports() { return this.targets.map(t => ({ ...t })); }
    hasTargetViewport(engine, id) { return this.targets.some(t => t.renderingEngineId === engine && t.viewportId === id); }
    isDisabled() { return !this.enabled; }
    setEnabled(value) { this.enabled = value; }
    getOptions(id) { return this.options[id]; }
    setOptions(id, value) { this.options[id] = value; }
    destroy() { this.destroyed = true; this.targets = []; }
    async fireEvent(sourceInfo) {
      const source = viewports.get(sourceInfo.viewportId), sz = zOf(source.getCurrentImageId());
      for (const t of this.targets) {
        if (t.viewportId === sourceInfo.viewportId || this.options[t.viewportId]?.disabled) continue;
        const target = viewports.get(t.viewportId), zs = target.ids.map(zOf);
        let index = Math.min(source.index, target.ids.length - 1);
        if (sz !== undefined && zs.every(z => z !== undefined))
          index = zs.reduce((best, z, i) => Math.abs(z - sz) < Math.abs(zs[best] - sz) ? i : best, 0);
        w.moves.push([t.viewportId, index]);
        target.index = index;
      }
    }
  }
  const creators = new Map(['imageSlice', 'stackimage'].map(type => [type, id => new NativeSync(id)]));
  const services = {
    syncGroupService: { getSyncCreatorForType: type => creators.get(type), addSynchronizerType: (type, fn) => { creators.set(type, fn); } },
    cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
    viewportGridService: { getState: () => ({ viewports: grid }) },
    displaySetService: { getDisplaySetByUID: uid => displaySets.get(uid) },
  };
  sandbox.cornerstone = {
    // A held preload answers when the case calls it: with pixels, or failed (fail = true).
    imageLoader: { loadAndCacheImage: id => { w.loads.push(id); return w.holdLoads
      ? new Promise((resolve, reject) => w.heldLoads.push(fail => fail ? reject(new Error('SYN image load failed')) : resolve({}))) : Promise.resolve({}); } },
    metaData: { get: (type, id) => type === 'imagePlaneModule' ? planes.get(id) : undefined },
    utilities: { spatialRegistrationMetadataProvider: { add: (pair, matrix) => { w.registrations.push([...pair, [...matrix]]); } } },
  };
  w.sync = (type = 'imageSlice', vps = ['vp-a', 'vp-b']) => {
    const sync = creators.get(type)('IMAGE_SLICE_SYNC', {});
    for (const viewportId of vps) sync.add({ viewportId, renderingEngineId: ENGINE });
    return sync;
  };
  w.scroll = (sync, vp, index) => { viewports.get(vp).index = index; return sync.fireEvent({ viewportId: vp, renderingEngineId: ENGINE }, { type: 'syn-scroll' }); };
  w.hold = (match, uncancellable = false) => { w.holds.push({ match, uncancellable }); };
  w.expire = ms => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  w.storage = key => { for (const fn of [...(windowListeners.get('storage') || [])]) fn({ key }); };
  w.broadcast = data => { for (const c of [...channels]) { const e = { data }; c.onmessage?.(e); for (const fn of [...c.listeners]) fn(e); } };
  w.pagehide = () => { for (const fn of [...(windowListeners.get('pagehide') || [])]) fn({ type: 'pagehide', persisted: false }); };
  // The document's own /me read (kinViewerSession.decide(), the write modules' gate) answered with `status`; nothing else changes.
  w.decide = async status => {
    w.answer = e => e.key === 'GET me' ? respond(status, { statusCode: status }) : undefined;
    try { return await kin.kinViewerSession.decide(); } finally { w.answer = null; }
  };
  w.notices = () => body.children.filter(node => node.id === 'kin-ct-sync-status');
  w.screen = () => {
    const found = w.notices();
    assert.ok(found.length <= 1, 'at most one CT sync notice');
    if (!found.length) return { mounted: false, visible: false, text: '', recheck: false };
    const [message, button] = found[0].children;
    return { mounted: true, visible: !found[0].hidden, text: found[0].hidden ? '' : message.textContent, recheck: !found[0].hidden && !button.hidden };
  };
  w.recheck = async () => {
    const found = w.notices()[0];
    assert.ok(found && !found.hidden && !found.children[1].hidden, 'Recheck Access is offered');
    found.children[1].dispatch('click');
    await flush();
  };
  w.keys = () => w.log.map(e => e.key);
  w.kin = kin; w.sandbox = sandbox; w.services = services;
  w.enter = () => { w.ext.onModeEnter(); };
  w.exit = () => { w.ext.onModeExit(); };
  w.show('vp-a', options.a || 'S1');
  w.show('vp-b', options.b || 'S3');
  w.ext = kin.kinCreateCTSync();
  w.ext.preRegistration({ servicesManager: { services } });
  if (options.mount !== false) w.enter();
  return w;
}

// Every request of the viewer's CT sync, in every case: a GET the guard sees as a browser call (X-KIN-CSRF, same-origin, no-store)
// on /me, GET studies or GET clinician/studies — never a write, never a route outside the pinned allowlist for a clinician-only caller.
function finish(w) {
  for (const e of w.log) {
    assert.equal(e.binding, 'S1', e.url);
    assert.equal(e.method, 'GET', e.url);
    assert.deepEqual([e.csrf, e.credentials, e.cache], ['1', 'same-origin', 'no-store'], e.url);
    assert.ok(['GET me', 'GET studies', 'GET clinician/studies'].includes(e.key), e.url);
    if (clinicianOnly(e.roles)) { assert.ok(ALLOWED.has(e.key), `clinician-only request inside the allowlist: ${e.url}`); assert.notEqual(e.key, 'GET studies'); }
  }
  assert.deepEqual(w.badQueries, []);
}

test('the approved clinician-only route contract refuses GET studies and admits the narrow list; the viewer follows its role matrix', () => {
  assert.ok(SESSION_ROUTES.includes('GET me'));
  assert.ok(BUSINESS_ROUTES.includes('GET clinician/studies'));
  assert.equal(ALLOWED.has('GET studies'), false, 'GET studies stays refused to clinician-only');
  const w = world({ mount: false });
  for (const roles of [['clinician'], ['clinician', 'default-roles-kin', 'offline_access'], ['clinician', 'radiologist'], ['radiologist'],
    ['technician'], ['admin'], ['admin', 'clinician'], [], ['default-roles-kin'], ['CLINICIAN'], ['gateway'], ['clinician', 'gateway']])
    assert.equal(w.kin.kinViewerClinicianOnly({ kind: 'member', sub: 's', institution: INST, roles }), clinicianOnly(roles), JSON.stringify(roles));
  assert.equal(w.kin.kinViewerClinicianOnly({ kind: 'gateway', roles: ['clinician'] }), false);
  assert.ok(w.sandbox.config.extensions.some(e => e && e.id === 'kin.ct-sync'), 'the shipped viewer registers kin.ct-sync');
  assert.equal(w.log.length, 0);
});

test('clinician-only: the check reads GET clinician/studies, never GET studies, and a same-patient CT pair syncs by physical position', async () => {
  const w = world();
  await flush();
  assert.deepEqual(w.keys(), ['GET me', 'GET clinician/studies', 'GET me']);
  assert.equal(w.log[1].url, '/api/clinician/studies?limit=100');
  assert.deepEqual(w.screen(), { mounted: true, visible: false, text: '', recheck: false }, 'a normal login shows no notice');
  const sync = w.sync();
  await w.scroll(sync, 'vp-a', 4); // S1 z=8 -> the prior S3
  assert.deepEqual(w.at('vp-b'), { index: 2, z: 8 });
  assert.equal(w.loads.at(-1), w.image('vp-b'), 'the image the viewer preloaded is the one the target shows');
  assert.deepEqual(plain(w.registrations.at(-1)), ['vp-b', 'vp-a', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]]);
  assert.equal(w.screen().text, TEXT.synced);
  await w.scroll(sync, 'vp-b', 5); // S3 z=20 -> S1
  assert.deepEqual(w.at('vp-a'), { index: 10, z: 20 });
  assert.deepEqual(w.keys().slice(3), ['GET me', 'GET me'], 'each sync event asks /me again and nothing else');
  // Two series of the same study, as tests/e2e/test_ct_sync.py pairs them.
  w.show('vp-b', 'S2');
  await w.scroll(sync, 'vp-a', 6);
  assert.deepEqual(w.at('vp-b'), { index: 3, z: 12 });
  finish(w);
});

test('radiologist, technician, admin and mixed sessions keep GET studies and sync the same pair', async () => {
  for (const account of [RADIOLOGIST, TECHNICIAN, ADMIN, MIXED]) {
    const w = world({ account });
    await flush();
    assert.deepEqual(w.keys(), ['GET me', 'GET studies', 'GET me'], account.sub);
    const sync = w.sync();
    await w.scroll(sync, 'vp-a', 4);
    assert.deepEqual(w.at('vp-b'), { index: 2, z: 8 }, account.sub);
    assert.equal(w.screen().text, TEXT.synced);
    finish(w);
  }
});

test('the clinician list is read page by page with the signed cursor verbatim, only until every opened study is seen', async () => {
  const w = world({ rows: MANY });
  await flush();
  const lists = w.log.filter(e => e.key === 'GET clinician/studies');
  const issued = [...w.cursors.keys()];
  assert.equal(lists.length, 2, 'the opened pair is on page 2: page 3 is never asked');
  assert.equal(lists[0].url, '/api/clinician/studies?limit=100');
  assert.equal(lists[1].url, '/api/clinician/studies?limit=100&after=' + encodeURIComponent(issued[0]));
  assert.equal(new URLSearchParams(lists[1].query).get('after'), issued[0]);
  const sync = w.sync();
  await w.scroll(sync, 'vp-a', 4);
  assert.deepEqual(w.at('vp-b'), { index: 2, z: 8 });
  finish(w);
  // An opened study the list does not hold: every page is read, and that study never syncs (no key, never the DICOM PatientID).
  const gone = world({ rows: MANY, search: `?StudyInstanceUIDs=${CUR},${ABSENT}`, b: 'S8' });
  await flush();
  assert.equal(gone.log.filter(e => e.key === 'GET clinician/studies').length, 3);
  const s2 = gone.sync();
  await gone.scroll(s2, 'vp-a', 5);
  assert.deepEqual(gone.moves, []);
  assert.deepEqual(gone.at('vp-b'), { index: 0, z: 0 });
  assert.equal(gone.screen().text, LIMIT('같은 환자를 확인할 수 없습니다'));
  finish(gone);
});

test('a 409 between pages starts the read again, twice at most; a page of another shape refuses the whole read', async () => {
  const pattern = w => w.log.filter(e => e.key === 'GET clinician/studies').map(e => e.query.includes('after=') ? 'next' : 'first');
  let refusals = 1;
  const once = world({ rows: MANY });
  once.answer = e => e.key === 'GET clinician/studies' && e.query.includes('after=') && refusals-- > 0 ? respond(409, { code: 'STUDY_LIST_CHANGED' }) : undefined;
  await flush();
  assert.deepEqual(pattern(once), ['first', 'next', 'first', 'next']);
  const sync = once.sync();
  await once.scroll(sync, 'vp-a', 4);
  assert.deepEqual(once.at('vp-b'), { index: 2, z: 8 });
  finish(once);
  const always = world({ rows: MANY });
  always.answer = e => e.key === 'GET clinician/studies' && e.query.includes('after=') ? respond(409, { code: 'STUDY_LIST_CHANGED' }) : undefined;
  await flush();
  assert.deepEqual(pattern(always), ['first', 'next', 'first', 'next', 'first', 'next']);
  await always.scroll(always.sync(), 'vp-a', 4);
  assert.deepEqual(always.screen(), { mounted: true, visible: true, text: TEXT.failed, recheck: true });
  assert.deepEqual(always.moves, []);
  finish(always);
  const page = () => ({ studies: plain([...ROWS].sort((a, b) => a.uid < b.uid ? -1 : 1)), serverTime: 'SYN',
    pagination: { next: null, total: ROWS.length, offset: 0, limit: 100 } });
  const shapes = {
    'no pagination': p => { delete p.pagination; },
    'studies not a list': p => { p.studies = {}; },
    'another limit': p => { p.pagination.limit = 50; },
    'another offset': p => { p.pagination.offset = 1; },
    'a total unlike the rows': p => { p.pagination.total = 5; },
    'total not an integer': p => { p.pagination.total = '4'; },
    'a next cursor on a short page': p => { p.pagination.next = 'eyJ2IjoxfQ.SYN'; },
    'an empty next cursor': p => { p.pagination.next = ''; },
    'a row without a UID': p => { p.studies[0].uid = ''; },
    'more rows than the limit': p => { p.studies = Array.from({ length: 101 }, (_, i) => row(`${PREFIX}.${2000 + i}`)); p.pagination.total = 101; },
  };
  for (const [label, edit] of Object.entries(shapes)) {
    const w = world();
    w.answer = e => { if (e.key !== 'GET clinician/studies') return undefined; const p = page(); edit(p); return respond(200, p); };
    await flush();
    await w.scroll(w.sync(), 'vp-a', 4);
    assert.deepEqual(w.screen(), { mounted: true, visible: true, text: TEXT.failed, recheck: true }, label);
    assert.deepEqual(w.moves, [], label);
    assert.deepEqual(w.keys(), ['GET me', 'GET clinician/studies'], label);
    finish(w);
  }
});

test('message matrix of the access check: unconfirmed, 401, 403, unanswered and a real end each have their own words', async () => {
  // Unconfirmed: an event waits for the answer, moves nothing meanwhile, and applies once the check confirms the same source.
  const waiting = world({ mount: false });
  waiting.hold(e => e.key === 'GET me');
  waiting.enter();
  await flush();
  const sync = waiting.sync();
  const pending = waiting.scroll(sync, 'vp-a', 4);
  await flush();
  assert.deepEqual(waiting.screen(), { mounted: true, visible: true, text: TEXT.checking, recheck: false });
  assert.deepEqual([waiting.moves, waiting.loads, waiting.keys()], [[], [], ['GET me']]);
  waiting.held[0].release();
  await pending;
  assert.deepEqual(waiting.at('vp-b'), { index: 2, z: 8 });
  assert.equal(waiting.screen().text, TEXT.synced);
  assert.deepEqual(waiting.keys(), ['GET me', 'GET clinician/studies', 'GET me', 'GET me']);
  finish(waiting);

  const cases = [
    ['/me 401', e => e.key === 'GET me' ? respond(401, { statusCode: 401 }) : undefined, TEXT.failed, true, ['GET me']],
    ['/me 403', e => e.key === 'GET me' ? respond(403, { code: 'INSTITUTION_PENDING' }) : undefined, TEXT.denied, true, ['GET me']],
    ['list 403', e => e.key === 'GET clinician/studies' ? respond(403, { code: 'CLINICIAN_ROUTE_DENIED' }) : undefined, TEXT.denied, true, ['GET me', 'GET clinician/studies']],
    ['list 401', e => e.key === 'GET clinician/studies' ? respond(401, {}) : undefined, TEXT.failed, true, ['GET me', 'GET clinician/studies']],
    ['list 500', e => e.key === 'GET clinician/studies' ? respond(500, {}) : undefined, TEXT.failed, true, ['GET me', 'GET clinician/studies']],
    ['list 503', e => e.key === 'GET clinician/studies' ? respond(503, {}) : undefined, TEXT.failed, true, ['GET me', 'GET clinician/studies']],
    ['/me network', e => e.key === 'GET me' ? NETWORK : undefined, TEXT.failed, true, ['GET me']],
    ['list not JSON', e => e.key === 'GET clinician/studies' ? respond(200, null, true) : undefined, TEXT.failed, true, ['GET me', 'GET clinician/studies']],
    ['/me not JSON', e => e.key === 'GET me' ? respond(200, null, true) : undefined, TEXT.failed, true, ['GET me']],
    ['/me not a member', e => e.key === 'GET me' ? respond(200, { kind: 'anonymous', sub: 'SYN-CLIN', institution: INST }) : undefined, TEXT.denied, true, ['GET me']],
  ];
  for (const [label, answer, text, recheck, keys] of cases) {
    const w = world({ mount: false });
    w.answer = answer;
    w.enter();
    await flush();
    const ended = text === TEXT.ended;
    // A real end is said at once; a refusal or an unanswered check waits for the user to use sync (no notice on a viewer just opened).
    assert.deepEqual(w.screen(), ended ? { mounted: true, visible: true, text, recheck: false } : { mounted: true, visible: false, text: '', recheck: false }, label);
    const s = w.sync();
    await w.scroll(s, 'vp-a', 4);
    assert.deepEqual(w.screen(), { mounted: true, visible: true, text, recheck }, label);
    assert.deepEqual([w.moves, w.loads], [[], []], label);
    assert.deepEqual(w.keys(), keys, `${label}: nothing more is asked`);
    finish(w);
  }
  // A /me that never answers: the 10 s bound aborts it, which is unanswered, not a logout.
  const slow = world({ mount: false });
  slow.hold(e => e.key === 'GET me');
  slow.enter();
  await flush();
  slow.expire(10000);
  await flush();
  assert.equal(slow.held[0].aborted, true);
  await slow.scroll(slow.sync(), 'vp-a', 4);
  assert.deepEqual(slow.screen(), { mounted: true, visible: true, text: TEXT.failed, recheck: true });
  finish(slow);
  // A mismatched account refuses this access round locally; a role change needs a new access check.
  for (const [label, account, text, recheck] of [['another account', OTHER_CLINICIAN, TEXT.denied, true], ['another role', CLINICIAN_NOW_MIXED, TEXT.changed, true]]) {
    const w = world({ mount: false });
    w.hold(e => e.key === 'GET me' && w.log.filter(x => x.key === 'GET me').length === 2);
    w.enter();
    await flush();
    w.account = account;
    w.held[0].release();
    await flush();
    await w.scroll(w.sync(), 'vp-a', 4);
    assert.deepEqual(w.screen(), { mounted: true, visible: true, text, recheck }, label);
    assert.deepEqual(w.moves, [], label);
    finish(w);
  }
});

test('Recheck Access asks again from /me, says it is checking, and only a confirmed answer brings sync back', async () => {
  const w = world();
  let down = true;
  w.answer = e => down && e.key === 'GET clinician/studies' ? respond(503, {}) : undefined;
  await flush();
  const sync = w.sync();
  await w.scroll(sync, 'vp-a', 4);
  assert.deepEqual(w.screen(), { mounted: true, visible: true, text: TEXT.failed, recheck: true });
  down = false;
  w.hold(e => e.key === 'GET me');
  await w.recheck();
  assert.deepEqual(w.screen(), { mounted: true, visible: true, text: TEXT.checking, recheck: false });
  // Pressing again while it asks starts nothing (the button is gone and the check is in flight).
  w.notices()[0].children[1].dispatch('click');
  await flush();
  assert.equal(w.log.filter(e => e.key === 'GET me').length, 2);
  w.held[0].release();
  await flush();
  assert.deepEqual(w.screen(), { mounted: true, visible: true, text: TEXT.confirmed, recheck: false });
  assert.deepEqual(w.moves, []);
  await w.scroll(sync, 'vp-a', 4);
  assert.deepEqual(w.at('vp-b'), { index: 2, z: 8 });
  finish(w);
  // A mismatched account stays refused without ending the document; a corrected read can recover.
  const refused = world();
  refused.answer = e => e.key === 'GET clinician/studies' ? respond(403, { code: 'CLINICIAN_ROUTE_DENIED' }) : undefined;
  await flush();
  const s2 = refused.sync();
  await refused.scroll(s2, 'vp-a', 4);
  assert.equal(refused.screen().text, TEXT.denied);
  refused.answer = null;
  refused.account = OTHER_CLINICIAN;
  await refused.recheck();
  assert.deepEqual(refused.screen(), { mounted: true, visible: true, text: TEXT.denied, recheck: true });
  assert.equal(s2.isDisabled(), false);
  assert.equal(refused.page.gate.state(), 'active');
  await refused.scroll(s2, 'vp-a', 5);
  assert.deepEqual(refused.moves, []);
  refused.account = CLINICIAN;
  await refused.recheck();
  await refused.scroll(s2, 'vp-a', 4);
  assert.deepEqual(refused.at('vp-b'), { index: 2, z: 8 });
  finish(refused);
});

test('checks inside a sync event: authenticated end stops work, ordinary 403 only fails that event, another role stops until Recheck Access', async () => {
  const unauth = world();
  await flush();
  const s1 = unauth.sync();
  unauth.answer = e => e.key === 'GET me' ? respond(401, {code:'AUTH_SESSION_ENDED'}) : undefined;
  await unauth.scroll(s1, 'vp-a', 4);
  assert.deepEqual(unauth.screen(), { mounted: true, visible: true, text: TEXT.ended, recheck: false });
  assert.equal(s1.isDisabled(), true, 'the synchronizers created in this mount are disabled');
  const asked = unauth.log.length;
  await unauth.scroll(s1, 'vp-a', 6);
  assert.deepEqual([unauth.moves, unauth.log.length], [[], asked]);
  finish(unauth);

  const refused = world();
  await flush();
  const s2 = refused.sync();
  refused.answer = e => e.key === 'GET me' ? respond(403, { message: 'SYN refused' }) : undefined;
  await refused.scroll(s2, 'vp-a', 4);
  assert.deepEqual(refused.screen(), { mounted: true, visible: true, text: TEXT.applyDenied, recheck: false });
  assert.deepEqual(refused.moves, []);
  refused.answer = null;
  await refused.scroll(s2, 'vp-a', 4);
  assert.deepEqual(refused.at('vp-b'), { index: 2, z: 8 }, 'the next event asks again and applies');
  finish(refused);

  const other = world();
  await flush();
  const s3 = other.sync();
  other.account = OTHER_CLINICIAN;
  await other.scroll(s3, 'vp-a', 4);
  assert.deepEqual([other.screen().text, other.moves, s3.isDisabled()], [TEXT.applyDenied, [], false]);
  assert.equal(other.page.gate.state(), 'active');
  finish(other);

  const role = world();
  await flush();
  const s4 = role.sync();
  role.account = CLINICIAN_NOW_MIXED;
  await role.scroll(s4, 'vp-a', 4);
  assert.deepEqual(role.screen(), { mounted: true, visible: true, text: TEXT.changed, recheck: true });
  const before = role.log.length;
  await role.scroll(s4, 'vp-a', 5);
  assert.deepEqual([role.screen().text, role.log.length, role.moves], [TEXT.changed, before, []]);
  await role.recheck();
  assert.deepEqual(role.keys().slice(before), ['GET me', 'GET studies', 'GET me'], 'the recheck reads the list of the new role');
  assert.equal(role.screen().text, TEXT.confirmed);
  await role.scroll(s4, 'vp-a', 4);
  assert.deepEqual(role.at('vp-b'), { index: 2, z: 8 });
  finish(role);
});

test('geometry gates: another patient, no server key, another frame, no geometry and out of range never move the target', async () => {
  for (const [label, b, index, reason] of [
    ['another patient (same frame UID)', 'S5', 5, '같은 환자를 확인할 수 없습니다'],
    ['a study without a server patient key', 'S7', 5, '같은 환자를 확인할 수 없습니다'],
    ['another frame of reference', 'S4', 5, '좌표계가 다르거나 없습니다'],
    ['no plane geometry', 'S6', 5, '좌표계가 다르거나 없습니다'],
    ['outside the target range', 'S3', 15, '대상 영상의 위치 범위를 벗어났습니다'],
  ]) {
    const w = world({ b, search: `?StudyInstanceUIDs=${CUR},${SERIES[b].study}` });
    await flush();
    const sync = w.sync();
    const before = w.at('vp-b');
    await w.scroll(sync, 'vp-a', index);
    assert.deepEqual(w.moves, [], `${label}: the permissive native was never let at the target`);
    assert.deepEqual(w.at('vp-b'), before, label);
    assert.deepEqual(w.loads, [], label);
    assert.equal(w.screen().text, LIMIT(reason), label);
    assert.equal(sync.getOptions('vp-b').disabled, true, label);
    finish(w);
  }
});

test('late answers: Sync OFF, series replacement, account change, logout and A->B->A never move the target', async () => {
  const held = async (setup, act, expectText) => {
    const w = world();
    await flush();
    const sync = w.sync();
    if (setup) setup(w);
    w.hold(e => e.key === 'GET me');
    const pending = w.scroll(sync, 'vp-a', 4);
    await flush();
    assert.equal(w.held.length, 1, 'the event is waiting for its /me');
    const before = w.at('vp-b');
    await act(w, sync);
    await pending;
    await flush();
    assert.deepEqual(w.moves, []);
    assert.deepEqual(w.at('vp-b'), before);
    if (expectText !== undefined) assert.equal(w.screen().text, expectText);
    finish(w);
    return { w, sync };
  };
  await held(null, async (w, sync) => { sync.destroy(); w.held[0].release(); }, TEXT.off);
  await held(null, async (w, sync) => { sync.setEnabled(false); w.held[0].release(); });
  await held(null, async w => { w.show('vp-b', 'S2'); w.held[0].release(); });
  const other = await held(null, async w => { w.account = OTHER_CLINICIAN; w.held[0].release(); }, TEXT.applyDenied);
  assert.equal(other.w.page.gate.state(), 'active');
  await held(null, async w => { w.page.end(); w.held[0].release(); }, TEXT.ended);
  await held(null, async w => { w.page.end(); w.held[0].release(); }, TEXT.ended);
  // A->B->A inside the mount: an event while B is shown asks nothing; the stack reloaded under A again is not the one it saw
  // (the source is left where the held event saw it, so only the target's reload stops it).
  await held(null, async (w, sync) => {
    w.sandbox.location.search = `?StudyInstanceUIDs=${OTH}`;
    const asked = w.log.length;
    await w.scroll(sync, 'vp-a', 4);
    assert.equal(w.log.length, asked);
    w.show('vp-b', 'S3');
    w.sandbox.location.search = OPENED;
    w.held[0].release();
  });
  // A held image load, then Sync OFF: the late pixels choose nothing.
  const w = world();
  await flush();
  const sync = w.sync();
  w.holdLoads = true;
  const pending = w.scroll(sync, 'vp-a', 4);
  await flush();
  assert.equal(w.heldLoads.length, 1);
  sync.destroy();
  w.heldLoads[0]();
  await pending;
  assert.deepEqual(w.moves, []);
  finish(w);
});

test('A->B->A across mode exits: the first mount\'s late answers touch nothing of the next mounts', async () => {
  for (const uncancellable of [false, true]) {
    const w = world({ mount: false });
    w.hold(e => e.key === 'GET clinician/studies', uncancellable);
    w.enter();
    await flush();
    const first = w.held[0], oldSync = w.sync();
    w.sandbox.location.search = `?StudyInstanceUIDs=${OTH}`;
    w.exit();
    assert.equal(first.aborted, !uncancellable, 'mode exit aborts what it can');
    w.enter();
    await flush();
    w.sandbox.location.search = OPENED;
    w.exit();
    w.enter();
    await flush();
    const screen = w.screen(), asked = w.log.length;
    if (uncancellable) first.release();
    await flush();
    assert.equal(w.notices().length, 1, 'only the current mount has a notice');
    assert.deepEqual(w.screen(), screen, 'the late answer said nothing');
    assert.equal(w.log.length, asked, 'the late answer asked nothing more');
    await w.scroll(oldSync, 'vp-a', 4);
    assert.deepEqual([w.moves, w.log.length], [[], asked], 'a synchronizer of the first mount stays down');
    const sync = w.sync();
    await w.scroll(sync, 'vp-a', 4);
    assert.deepEqual(w.at('vp-b'), { index: 2, z: 8 }, 'the current mount works');
    finish(w);
  }
});

// Hold each asynchronous producer at the boundary where an end or a later mount can overtake it.
const STAGES = {
  'an event waiting for its image': async () => {
    const w = world();
    await flush();
    const sync = w.sync();
    w.holdLoads = true;
    const pending = w.scroll(sync, 'vp-a', 4);
    await flush();
    assert.equal(w.heldLoads.length, 1, 'the event waits for its preload');
    return { w, sync, pending, release: () => { w.holdLoads = false; w.heldLoads.splice(0).forEach(go => go()); } };
  },
  'an event waiting for its /me': async () => {
    const w = world();
    await flush();
    const sync = w.sync();
    w.hold(e => e.key === 'GET me', true);
    const pending = w.scroll(sync, 'vp-a', 4);
    await flush();
    assert.equal(w.held.length, 1, 'the event waits for its /me');
    return { w, sync, pending, release: () => { w.held.splice(0).forEach(e => e.release()); } };
  },
  'the check waiting for a list page': async () => {
    const w = world({ rows: MANY, mount: false });
    w.hold(e => e.key === 'GET clinician/studies' && e.query.includes('after='), true);
    w.enter();
    await flush();
    assert.equal(w.held.length, 1, 'the check waits for its second page');
    const sync = w.sync();
    const pending = w.scroll(sync, 'vp-a', 4);
    await flush();
    assert.equal(w.screen().text, TEXT.checking, 'the event waits for the check');
    return { w, sync, pending, release: () => { w.held.splice(0).forEach(e => e.release()); } };
  },
};

// U5S amendment ⑤: the page gate owns termination. These cases preserve every old
// end/refusal/race scenario using the shipped transport and authenticated server answers.
const authEnds = [
  [401, 'AUTH_SESSION_ENDED'], [403, 'AUTH_SESSION_MISMATCH'], [409, 'AUTH_SESSION_MISMATCH'],
];
const failCheck = async w => {
  w.answer = e => e.key === 'GET clinician/studies' ? respond(403, {}) : undefined;
  w.exit(); w.enter(); await flush();
  await w.scroll(w.sync(), 'vp-a', 4);
  assert.equal(w.screen().text, TEXT.denied); assert.equal(w.screen().recheck, true);
  w.answer = null;
};
const endByReply = async (w, status, code) => {
  w.answer = () => respond(status, { code });
  await w.page.transport.request('/api/me', {context:w.page.gate.capture('document'),credentials:'same-origin',cache:'no-store'});
  w.answer = null;
};

test('a document ended before mount asks nothing; a refused check recovers through Recheck Access', async () => {
  const w=world({mount:false});w.page.end();w.enter();await flush();
  await w.scroll(w.sync(),'vp-a',4);
  assert.equal(w.log.length,0);assert.equal(w.screen().text,TEXT.ended);assert.deepEqual(w.moves,[]);
  const x=world();await flush();await failCheck(x);await x.recheck();
  await x.scroll(x.sync(),'vp-a',4);assert.deepEqual(x.at('vp-b'),{index:2,z:8});finish(x);
});

test('the page end at each held image, event or list page prevents every later move and request', async () => {
  for(const open of Object.values(STAGES)) for(const signal of ['notice',...authEnds]) {
    const {w,sync,pending,release}=await open();
    if(signal==='notice')w.page.end();else await endByReply(w,...signal);
    const asked=w.log.length;release();await pending;await flush();
    assert.equal(w.screen().text,TEXT.ended);assert.equal(sync.isDisabled(),true);
    assert.deepEqual([w.moves,w.registrations,w.log.length],[[],[],asked]);finish(w);
  }
});

test('another request plain 401 or 403 does not drop a valid held sync event or its access check', async () => {
  for(const open of Object.values(STAGES)) for(const status of [401,403,409,428,503]) {
    const {w,pending,release}=await open();
    await endByReply(w,status,'ORDINARY_FAILURE');
    assert.equal(w.page.gate.state(),'active');release();await pending;await flush();
    assert.deepEqual(w.at('vp-b'),{index:2,z:8});finish(w);
  }
});

test('mode exit removes the old notice; an end during exit stays ended on re-entry', async () => {
  const w=world();await flush();w.exit();assert.deepEqual(w.notices(),[]);
  w.page.end();assert.deepEqual(w.notices(),[]);const asked=w.log.length;
  w.enter();await flush();await w.scroll(w.sync(),'vp-a',4);
  assert.equal(w.log.length,asked);assert.equal(w.screen().text,TEXT.ended);assert.deepEqual(w.moves,[]);finish(w);
});

test('an end after access refusal with no mount cannot be reversed by re-entry of either account', async () => {
  const w=world();await flush();await failCheck(w);w.exit();w.page.end();const asked=w.log.length;
  for(const account of [CLINICIAN,OTHER_CLINICIAN]){
    w.account=account;w.enter();await flush();await w.scroll(w.sync(),'vp-a',4);
    assert.equal(w.screen().text,TEXT.ended);assert.equal(w.log.length,asked);w.exit();
  }
  assert.deepEqual(w.moves,[]);finish(w);
});

test('Recheck Access cannot revive a document ended while its replacement check waits', async () => {
  for(const match of [e=>e.key==='GET me',e=>e.key==='GET clinician/studies']){
    const w=world();await flush();await failCheck(w);w.hold(match,true);await w.recheck();
    assert.equal(w.held.length,1);w.page.end();const asked=w.log.length;
    w.held[0].release();await flush();await w.scroll(w.sync(),'vp-a',4);
    assert.equal(w.log.length,asked);assert.equal(w.screen().text,TEXT.ended);assert.deepEqual(w.moves,[]);finish(w);
  }
});

test('each check compares the document first account after mode exit and never applies another account data', async () => {
  for(const number of [1,2]){
    const w=world();await flush();w.exit();const base=w.log.filter(e=>e.key==='GET me').length;
    w.hold(e=>e.key==='GET me'&&w.log.filter(e=>e.key==='GET me').length===base+number,true);
    w.enter();await flush();w.held[0].release(respond(200,OTHER_CLINICIAN));await flush();
    await w.scroll(w.sync(),'vp-a',4);assert.deepEqual(w.moves,[]);
    assert.equal(w.page.gate.state(),'active','invalid incoming account data does not rebind or terminate the session');
    assert.equal(w.kin.kinViewerSession.sameAccount(CLINICIAN),true);finish(w);
  }
});

test('a true end disposes write modules once and late role verdicts cannot reopen them', async () => {
  const w=world();await flush();const s=w.kin.kinViewerSession;let ends=0;s.writeModule.onEnd(()=>ends++);
  w.page.end();w.page.end();s.note(RADIOLOGIST);s.writeModule.answer(RADIOLOGIST);
  assert.equal(ends,1);assert.equal(s.writer(),false);const asked=w.log.length;
  await s.decide();assert.equal(w.log.length,asked);finish(w);
});

test('ordinary me refusals from other panels never close or erase this document', async () => {
  for(const status of [401,403,428]){
    const w=world();await flush();await w.decide(status);
    w.kin.kinViewerSession.refuse('forbidden');w.kin.kinViewerSession.writeModule.refuse('unauthorized');
    assert.equal(w.page.gate.state(),'active');assert.equal(w.kin.kinViewerSession.ended(),false);
    await w.scroll(w.sync(),'vp-a',4);assert.deepEqual(w.at('vp-b'),{index:2,z:8});finish(w);
  }
});

test('an old event late ordinary failure cannot replace the notice of a new mount', async () => {
  for(const status of [401,403,500]){
    const {w,pending}=await STAGES['an event waiting for its /me']();
    w.exit();w.enter();await flush();const before=w.screen();
    w.held[0].release(respond(status,{}));await pending;await flush();
    assert.deepEqual(w.screen(),before);assert.deepEqual(w.moves,[]);assert.equal(w.page.gate.state(),'active');finish(w);
  }
});

// Replaces the source-line promotion/comparison/event-check mutants. The assertions
// concern retained access, unchanged target and recoverability, not an internal verdict.
test('refusal recovery requires the same account and late errors leave Recheck Access usable', async () => {
  const w=world();await flush();await failCheck(w);w.account=OTHER_CLINICIAN;await w.recheck();
  await w.scroll(w.sync(),'vp-a',4);assert.deepEqual(w.moves,[]);
  const x=world();await flush();await failCheck(x);await x.recheck();
  await x.scroll(x.sync(),'vp-a',4);assert.deepEqual(x.at('vp-b'),{index:2,z:8});finish(w);finish(x);
  const {w:y,pending}=await STAGES['an event waiting for its /me']();
  await failCheck(y);const before=y.screen();y.held[0].release(respond(403,{}));await pending;await flush();
  assert.deepEqual(y.screen(),before);assert.equal(y.screen().recheck,true);assert.deepEqual(y.moves,[]);
  await y.recheck();await y.scroll(y.sync(),'vp-a',4);assert.deepEqual(y.at('vp-b'),{index:2,z:8});finish(y);
});

test('late authenticated end from every check request closes the current mount even after mode re-entry', async () => {
  for(const phase of ['first-me','list','second-me','later-page']) for(const [status,code] of authEnds){
    const w=world({mount:false,rows:phase==='later-page'?MANY:ROWS});
    w.hold(e=>phase==='first-me'?e.key==='GET me':phase==='second-me'?e.key==='GET me'&&w.log.filter(x=>x.key==='GET me').length===2:
      e.key==='GET clinician/studies'&&(phase!=='later-page'||e.query.includes('after=')),true);
    w.enter();await flush();assert.equal(w.held.length,1);w.exit();w.enter();await flush();
    w.held[0].release(respond(status,{code}));await flush();const asked=w.log.length;
    await w.scroll(w.sync(),'vp-a',6);assert.equal(w.screen().text,TEXT.ended);assert.equal(w.log.length,asked);
    assert.deepEqual(w.moves,[]);finish(w);
  }
});

test('event authenticated end across mode exit closes later mounts without touching the removed mount', async () => {
  for(const [status,code] of authEnds){
    const {w,pending}=await STAGES['an event waiting for its /me']();w.exit();
    w.held[0].release(respond(status,{code}));await pending;await flush();assert.deepEqual(w.notices(),[]);
    const asked=w.log.length;w.enter();await flush();await w.scroll(w.sync(),'vp-a',8);
    assert.deepEqual(w.moves,[]);assert.equal(w.log.length,asked);assert.equal(w.screen().text,TEXT.ended);finish(w);
  }
});

test('a late first account answer cannot make a later mount accept another account', async () => {
  const w=world({mount:false});w.hold(e=>e.key==='GET me',true);w.enter();await flush();w.exit();
  w.held[0].release();await flush();w.account=OTHER_CLINICIAN;w.enter();await flush();
  await w.scroll(w.sync(),'vp-a',4);assert.deepEqual(w.moves,[]);assert.equal(w.kin.kinViewerSession.sameAccount(CLINICIAN),true);finish(w);
});

// Replaces source-order pins: the actual transport must classify an answer even when
// the request's UI has left. Ordinary failures remain local at the same held boundary.
test('late ordinary 401 stays local while authenticated mismatch ends every later mount', async () => {
  for(const [status,code,ended] of [[401,null,false],[403,'AUTH_SESSION_MISMATCH',true]]){
    const {w,pending}=await STAGES['an event waiting for its /me']();w.exit();w.enter();await flush();
    w.held[0].release(respond(status,{code}));await pending;await flush();
    await w.scroll(w.sync(),'vp-a',4);assert.equal(w.moves.length,ended?0:1);
    assert.equal(w.page.gate.state(),ended?'ending':'active');finish(w);
  }
});

// Replaces subscription and reason-string pins with the held pixel-load behaviour.
test('end after a preload was issued prevents its native sync and every later request', async () => {
  const {w,sync,pending,release}=await STAGES['an event waiting for its image']();w.page.end();
  const asked=w.log.length;release();await pending;await w.scroll(sync,'vp-a',8);
  assert.deepEqual([w.moves,w.registrations,w.log.length],[[],[],asked]);finish(w);
});

test('a role change rechecks against the new role allowlist without ending the login', async () => {
  const w=world();await flush();w.account=CLINICIAN_NOW_MIXED;
  await w.scroll(w.sync(),'vp-a',4);assert.equal(w.screen().text,TEXT.changed);
  const before=w.log.length;await w.recheck();assert.deepEqual(w.keys().slice(before),['GET me','GET studies','GET me']);
  await w.scroll(w.sync(),'vp-a',4);assert.deepEqual(w.at('vp-b'),{index:2,z:8});assert.equal(w.page.gate.state(),'active');finish(w);
});

test('notice and Recheck Access expose a status and an English recovery control', async () => {
  const w=world();await flush();await failCheck(w);
  const notice=w.notices()[0],button=notice.children[1];
  assert.equal(notice.getAttribute('role'),'status');assert.equal(button.textContent,'Recheck Access');
  assert.match(button.getAttribute('title')||button.title,/[가-힣]/);await w.recheck();
  assert.equal(w.screen().text,TEXT.confirmed);w.exit();assert.deepEqual(w.notices(),[]);finish(w);
});
