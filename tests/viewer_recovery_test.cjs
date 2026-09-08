// D-MEASURE2 A1/A2/C1/C2/C5: mount the production extension with in-memory
// transport and DOM ports. No copied state machine, containers or browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = readFileSync(require.resolve('../config/ohif.js'), 'utf8');
class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.textContent = ''; }
  append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
  replaceChildren(...children) { for (const c of this.children) c.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attributes[k] = v; }
  get isConnected() { return this.tagName === 'body' || !!this.parent?.isConnected; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  querySelectorAll(selector) { assert.equal(selector, '[data-kin-sr]'); return this.all().filter(e => e.dataset.kinSr); }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const copy = x => JSON.parse(JSON.stringify(x));
const head = (id = 'a', revision = 1, title = 'server', hidden = false) => ({ id, revision, hidden,
  authorSub: 'doctor', authorActor: 'Doctor', referenceStatus: 'verified', item: {
    schemaVersion: 1, kind: 'key', seriesUid: '1.2', sopUid: '1.3', frame: 1, title, description: '', hidden, sourceDigest: 'digest',
  } });
async function harness() {
  const document = new EventTarget(); document.body = new Element('body'); document.createElement = tag => new Element(tag);
  const window = new EventTarget(), annotations = new Map(), commands = new Map();
  let study = '1', tick, me = { sub: 'doctor', kind: 'member', roles: ['radiologist'] };
  const calls = [], notices = [], dialogs = [], pages = new Map([['1', [head()]], ['2', [head('b')]]]);
  let reply = async (path, options) => {
    if (path === '/api/me') return { status: 200, data: me };
    const uid = path.match(/\/studies\/([^/]+)/)?.[1];
    if (options.method === 'POST') return { status: 409, data: {} };
    return { status: 200, data: { items: copy(pages.get(uid) || []), nextCursor: null } };
  };
  const viewport = { getCurrentImageId: () => `/studies/${study}/series/1.2/instances/1.3/frames/1`, render() {} };
  window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'image' } }, metaData: { get() {} } };
  window.cornerstoneTools = { annotation: { locking: { setAnnotationLocked() {}, isAnnotationLocked: () => true },
    state: { getAnnotation: uid => annotations.get(uid), getAllAnnotations: () => [...annotations.values()], removeAnnotation: uid => annotations.delete(uid) } },
    ToolGroupManager: { getToolGroupForViewport() {} } };
  window.confirm = message => { dialogs.push(message); return window.answer; };
  window.prompt = () => 'test reason';
  const measurements = new Map();
  const services = {
    cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
    viewportGridService: { getActiveViewportId: () => 'viewport', EVENTS: {} },
    measurementService: { getMeasurements: () => [...measurements.values()], getMeasurement: uid => measurements.get(uid), remove: uid => measurements.delete(uid), update() {} },
    uiNotificationService: { show: x => notices.push(x) },
  };
  for (const name of ['downloadReport', 'storeMeasurements']) commands.set(name, { commandFn: () => { throw new Error('native SR must not run'); } });
  vm.runInNewContext(source, { window, document, crypto: webcrypto, TextEncoder, console, Event, AbortController,
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    fetch: async (path, options) => { calls.push({ path, options }); const r = await reply(path, options); return { status: r.status, ok: r.status === 200, json: async () => copy(r.data) }; },
  });
  const extension = window.config.extensions.find(e => e.id === 'kin.viewer-history');
  extension.preRegistration({ servicesManager: { services }, commandsManager: {
    getCommand: name => commands.get(name), registerCommand: (_, name, command) => commands.set(name, command),
  } });
  extension.onModeEnter(); await flush();
  const all = () => document.body.all();
  const button = name => { const found = all().filter(e => e.tagName === 'button' && e.textContent === name); assert.equal(found.length, 1, `button ${name}: ${found.length}`); return found[0]; };
  return { window, document, pages, calls, commands, measurements, annotations, notices, dialogs, extension, services,
    setReply: f => { reply = f; }, defaultReply: reply, setMe: value => { me = value; },
    button, click: async name => { button(name).click(); await flush(); },
    input: (label, value) => { const e = all().find(e => e.attributes['aria-label'] === label && !e.disabled); assert.ok(e, label); e.value = value; e.dispatchEvent(new Event('input')); },
    values: () => all().filter(e => e.tagName === 'input').map(e => e.value),
    text: () => all().map(e => e.textContent).join('\n'),
    switch: async uid => { study = uid; tick(); await flush(); },
    tick: async () => { tick(); await flush(); },
    logout: () => { const e = new Event('storage'); e.key = 'kin-session-ended'; window.dispatchEvent(e); },
  };
}

test('A1 (5): A→B→A keeps edited and held work, explicit resume and cancel are inert', async () => {
  const h = await harness();
  await h.click('편집'); h.input('키 제목', 'my A');
  await h.switch('2'); assert.doesNotMatch(h.text(), /my A/);
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  assert.equal(h.window.dispatchEvent(new Event('beforeunload', { cancelable: true })), false);
  await h.click('편집'); h.input('키 제목', 'my B');
  await h.switch('1'); assert.doesNotMatch(h.text(), /my B/); assert.equal(h.values().length, 0);
  h.window.answer = false; await h.click('보관 작업 버리기');
  await h.click('보관 작업 재개'); assert.ok(h.values().includes('my A'));
  h.pages.set('1', [head('a', 2, 'hidden server', true)]);
  await h.click('저장'); await h.click('최신판 기준으로 내 수정 유지');
  assert.match(h.text(), /my A/);
  await h.switch('2'); await h.click('보관 작업 재개'); assert.ok(h.values().includes('my B'));
  await h.switch('1'); await h.click('보관 작업 재개'); assert.match(h.text(), /my A/);
  h.logout(); assert.equal(h.window.kinViewerHistoryHasUnsaved(), false); assert.doesNotMatch(h.text(), /my [AB]/);
});

test('A2 (6): busy-only hide conflict does not invent local edits or roll back latest content', async () => {
  const h = await harness(); h.pages.set('1', [head('a', 2, 'new hidden server', true)]);
  await h.click('숨김'); await h.click('최신판 기준으로 내 수정 유지');
  assert.doesNotMatch(h.text(), /보관 중인 수정 보기/); assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
  assert.match(h.text(), /new hidden server/);
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head('a', 3, 'new hidden server') } : h.defaultReply(path, options));
  await h.click('복원');
  const body = JSON.parse(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body);
  assert.equal(body.item.title, 'new hidden server'); assert.equal(h.values().length, 0);
});

test('C1 (7): discard states revision adoption, cancellation changes neither copy', async () => {
  const h = await harness(); await h.click('편집'); h.input('키 제목', 'local');
  h.pages.set('1', [head('a', 2, 'hidden', true)]); await h.click('저장'); await h.click('최신판 기준으로 내 수정 유지');
  h.window.answer = false; await h.click('보관 수정 버리기');
  assert.match(h.dialogs.at(-1), /서버판 r2.*채택/); assert.match(h.text(), /local/);
  const count = h.calls.filter(c => c.options.method === 'POST').length;
  h.window.answer = true; await h.click('보관 수정 버리기'); assert.doesNotMatch(h.text(), /local/);
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, count);
});

test('C5 (4): study 403 quarantines its pending bytes, preserves other drafts, reauthorizes before resume', async () => {
  const h = await harness(); await h.click('편집'); h.input('키 제목', 'private A'); await h.switch('2');
  await h.click('편집'); h.input('키 제목', 'private B');
  h.setReply(async (path, options) => path.includes('/studies/2/') ? { status: 403, data: {} } : h.defaultReply(path, options));
  await h.click('저장'); assert.doesNotMatch(h.text(), /private [AB]|server/);
  assert.match(h.text(), /접근할 수 없습니다/); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  await h.click('접근 다시 확인'); assert.doesNotMatch(h.text(), /private B/);
  await h.switch('1'); await h.click('보관 작업 재개'); assert.ok(h.values().includes('private A'));
  h.setReply(h.defaultReply); await h.switch('2'); assert.doesNotMatch(h.text(), /private B/);
  await h.click('보관 작업 재개'); assert.ok(h.values().includes('private B'));
  const pending = h.calls.find(c => c.options.method === 'POST').options.body;
  await h.click('같은 요청 재시도'); assert.equal(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body, pending);
});

test('A1/C5: late committed create cannot cross A→B→A; same UUID retry coalesces loaded server row', async () => {
  const h = await harness(); h.pages.set('1', []); await h.click('새로고침');
  await h.click('현재 프레임 키 저장'); h.input('키 제목', 'new A');
  let release; h.setReply(async (path, options) => options.method === 'POST' ? new Promise(resolve => { release = resolve; }) : h.defaultReply(path, options));
  const detached = h.button('저장'); detached.click(); await flush();
  const pending = h.calls.find(c => c.options.method === 'POST').options.body;
  await h.switch('2'); await h.switch('1');
  h.pages.set('1', [head('created', 1, 'new A')]); release({ status: 200, data: head('created', 1, 'new A') }); await flush();
  assert.equal(h.values().length, 0); detached.click(); await flush();
  assert.equal(h.calls.filter(c => c.options.method === 'POST').length, 1);
  await h.click('보관 작업 재개');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head('created', 1, 'new A') } : h.defaultReply(path, options));
  await h.click('같은 요청 재시도');
  assert.equal(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body, pending);
  assert.equal(h.document.body.all().filter(e => e.tagName === 'section').length, 1);
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
});

test('C2 (9): actual session end clears recovery and both captured SR commands explain re-entry', async () => {
  const h = await harness(); await h.click('편집'); h.input('키 제목', 'private'); await h.switch('2');
  const captured = [...h.commands.values()];
  h.setReply(async () => ({ status: 401, data: {} })); await h.click('새로고침');
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
  for (const command of captured) assert.throws(() => command.commandFn({ measurementData: [{ uid: 'x', toolName: 'Length' }] }), /다시 로그인한 뒤 뷰어/);
  assert.equal(h.notices.length, 2); assert.doesNotMatch(h.text(), /private/);
});

test('A1 delta: native deletion removes a headless draft; it does not resurrect or retain an exit guard', async () => {
  const h = await harness();
  h.annotations.set('new', { annotationUID: 'new', metadata: { toolName: 'ArrowAnnotate', FrameOfReferenceUID: '1.4',
    referencedImageId: '/studies/1/series/1.2/instances/1.3/frames/1' }, data: { text: 'delete me', handles: { points: [[0,0,0],[1,0,0]] } } });
  await h.tick(); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  h.annotations.delete('new'); await h.tick();
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), false); assert.doesNotMatch(h.text(), /delete me/);
  assert.equal(h.annotations.size, 0);
});

test('C5 delta: denied study loses incomplete annotations; other-study marks are not erased', async () => {
  const h = await harness();
  for (const uid of ['1', '2']) h.annotations.set(uid, { annotationUID: uid, metadata: { toolName: 'ArrowAnnotate',
    referencedImageId: `/studies/${uid}/series/1.2/instances/1.3/frames/1` }, data: { handles: { points: [[0,0,0]] } } });
  h.setReply(async (path, options) => path.includes('/studies/1/') ? { status: 403, data: {} } : h.defaultReply(path, options));
  await h.click('새로고침'); assert.equal(h.annotations.has('1'), false); assert.equal(h.annotations.has('2'), true);
});

test('A1/C5 delta: pending create does not block another edit or overwrite its changes when replay resolves', async () => {
  const h = await harness(); await h.click('현재 프레임 키 저장'); h.input('키 제목', 'created');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 503, data: {} } : h.defaultReply(path, options));
  await h.click('저장'); const body = h.calls.find(c => c.options.method === 'POST').options.body;
  h.pages.set('1', [head('created', 1, 'created')]); await h.switch('2'); await h.switch('1'); await h.click('보관 작업 재개');
  await h.click('편집'); h.input('키 제목', 'edit after commit');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 200, data: head('created', 1, 'created') } : h.defaultReply(path, options));
  await h.click('같은 요청 재시도'); assert.equal(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body, body);
  assert.ok(h.values().includes('edit after commit')); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  assert.equal(h.document.body.all().filter(e => e.tagName === 'section').length, 1);
});

test('A1 delta: a changed login subject purges parked work before any resume', async () => {
  const h = await harness(); await h.click('편집'); h.input('키 제목', 'private'); await h.switch('2');
  h.setMe({ sub: 'another', kind: 'member', roles: ['radiologist'] }); await h.switch('1');
  assert.match(h.text(), /로그인이 종료/); assert.equal(h.window.kinViewerHistoryHasUnsaved(), false);
});

async function measured() {
  const h = await harness(), id = '/studies/1/series/1.2/instances/1.3/frames/1';
  h.window.cornerstone.cache = { getImage: () => ({}) };
  h.window.cornerstone.metaData.get = kind => kind === 'instance' ? {
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', Modality: 'CT', PixelSpacing: [1,1],
    ImageOrientationPatient: [1,0,0,0,1,0], ImagePositionPatient: [0,0,0], FrameOfReferenceUID: '1.4', Columns: 256, Rows: 256,
  } : undefined;
  const a = { annotationUID: 'length', invalidated: false, metadata: { toolName: 'Length', FrameOfReferenceUID: '1.4',
    referencedImageId: id, viewPlaneNormal: [0,0,1], viewUp: [0,-1,0] },
    data: { label: '', handles: { points: [[0,0,0],[10,0,0]] }, cachedStats: {} } };
  h.annotations.set(a.annotationUID,a); h.measurements.set(a.annotationUID,{ uid: a.annotationUID, toolName: 'Length', source: {} });
  h.services.measurementService.getSourceMappings = () => [{ annotationType: 'Length', toMeasurementSchema: () => ({ displayText: { primary: ['10 mm'], secondary: [] }, points: a.data.handles.points }) }];
  await h.tick(); a.data.cachedStats['imageId:'+id] = { length: 10 }; a.invalidated = false; await h.tick();
  return { h, a };
}

test('B1: both production SR commands reject changed geometry before the next scan/native calculation', async () => {
  const { h, a } = await measured(); a.data.handles.points[1][0] = 20;
  const before = h.calls.length;
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({ measurementData: [...h.measurements.values()] }), /재확인 필요/);
  assert.equal(h.calls.length,before);
});

test('B1 panel regression: a public unverified read between ticks still emits the recovered view', async () => {
  const { h, a } = await measured(); let updates = 0; h.services.measurementService.update = () => updates++;
  a.data.kinUnverified = true;
  assert.match(h.services.measurementService.getMeasurements()[0].displayText.primary[0], /재확인 필요/);
  a.data.kinUnverified = false; await h.tick();
  assert.equal(updates,1); assert.equal(h.services.measurementService.getMeasurements()[0].displayText.primary[0], '10 mm');
});

async function savedMeasurement(mismatch = false) {
  const result = await measured(), { h } = result;
  const originalButton = h.button;
  h.button = name => h.document.body.all().find(e => e.tagName === 'section' && e.dataset.kind === 'length')
    ?.all().find(e => e.tagName === 'button' && e.textContent === name) || originalButton(name);
  h.click = async name => { h.button(name).click(); await flush(); };
  let saved;
  h.setReply(async (path, options) => {
    if (options.method !== 'POST') return h.defaultReply(path, options);
    saved = { ...head('saved'), item: JSON.parse(options.body).item };
    if (mismatch) saved.item.baseline.values[0] += 1;
    h.pages.set('1', [saved]); return { status: 200, data: saved };
  });
  await h.click('저장'); await h.tick(); return { ...result, saved };
}

test('A4 (12): editing alone keeps mismatch; only fresh remeasured geometry recovers', async () => {
  const { h, a } = await savedMeasurement(true);
  assert.equal(a.data.kinUnverified, true); await h.click('편집'); await h.tick();
  assert.equal(a.data.kinUnverified, true);
  a.data.handles.points[1][0] = 20; a.invalidated = false; await h.tick();
  assert.equal(a.data.kinUnverified, true);
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({ measurementData: [...h.measurements.values()] }), /재확인 필요/);
  a.data.cachedStats['imageId:' + a.metadata.referencedImageId] = { length: 20 };
  a.invalidated = false; await h.tick(); assert.equal(a.data.kinUnverified, false);
  assert.doesNotMatch(h.services.measurementService.getMeasurements()[0].displayText.primary[0], /재확인 필요/);
  await h.click('저장');
  const command = JSON.parse(h.calls.filter(c => c.options.method === 'POST').at(-1).options.body);
  assert.deepEqual(command.item.points, [[0,0,0],[20,0,0]]);
  assert.deepEqual(command.item.baseline.values, [20]);
});

test('A3 (11): same-revision unverified head keeps edits and blocks even a detached save handler', async () => {
  const { h, saved } = await savedMeasurement(); await h.click('편집'); h.input('주석 문구', 'retained edit');
  const staleSave = h.button('저장'); saved.referenceStatus = 'unverified';
  await h.click('새로고침'); assert.equal(h.button('저장').disabled, true);
  assert.deepEqual(h.values(), ['retained edit']); assert.equal(h.annotations.size, 0);
  const posts = h.calls.filter(c => c.options.method === 'POST').length;
  staleSave.click(); await flush(); assert.equal(h.calls.filter(c => c.options.method === 'POST').length, posts);
  await h.click('원본 다시 확인'); assert.deepEqual(h.values(), ['retained edit']);
  assert.ok(h.calls.some(c => c.path.includes('recheck=saved')), 'C4a uses an item-scoped read, not the same starving page');
  h.pages.set('1', []); await h.click('원본 다시 확인');
  assert.match(h.text(), /선택한 저장 항목을 찾지 못했습니다/); assert.deepEqual(h.values(), ['retained edit']);
  h.pages.set('1', [saved]);
  const link = h.document.body.all().find(e => e.tagName === 'a' && e.textContent === '새 뷰어에서 재측정');
  assert.equal(link.href, '/ohif/viewer?StudyInstanceUIDs=1'); assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
  saved.referenceStatus = 'verified'; await h.click('원본 다시 확인');
  assert.match(h.text(), /원본 확인 완료/);
  assert.equal(h.button('저장').disabled, false); assert.deepEqual(h.values(), ['retained edit']);
});

test('C3: both SR commands identify the blocked selected item without silently dropping it', async () => {
  const { h, a } = await measured();
  h.input('주석 문구', '<img src=x> blocked length');
  a.data.handles.points[1][0] = 20;
  const selection = [{ uid: 'foreign-key', toolName: 'KeyImage' }, ...h.measurements.values()];
  const before = h.calls.length;
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({measurementData: selection}),
    /<img src=x> blocked length.*\[length\].*계산이 완료되지/);
  assert.equal(h.calls.length, before);
  assert.equal(selection.length, 2);
  a.invalidated = true; a.data.handles = {};
  for (const command of h.commands.values()) assert.throws(() => command.commandFn({measurementData: selection}), /측정 위치가 완성되지/);
  assert.equal(h.calls.length, before);
});

test('A5: replaced cache is rewrapped; old values stay untrusted until a new native assignment', async () => {
  const { h, a } = await measured(), data = a.data, target = 'imageId:'+a.metadata.referencedImageId;
  a.data.cachedStats = { [target]: { length: 10 } }; a.invalidated = false;
  await h.tick();
  assert.equal(a.data, data);
  for (const command of h.commands.values()) assert.throws(()=>command.commandFn({measurementData:[...h.measurements.values()]}), /재확인 필요/);
  a.data.cachedStats[target] = { length: 10 }; a.invalidated = false; await h.tick();
  assert.equal(h.services.measurementService.getMeasurements()[0].displayText.primary[0], '10 mm');
});

test('A3 delta: verified read after storage-limit 409 retains the actionable failure', async () => {
  const { h } = await savedMeasurement(); await h.click('편집'); h.input('주석 문구', 'quota draft');
  h.setReply(async (path, options) => options.method === 'POST' ? { status: 409, data: { code: 'VIEWER_STORAGE_LIMIT' } } : h.defaultReply(path, options));
  await h.click('저장'); assert.match(h.text(), /저장 공간 한도/);
  await h.click('새로고침'); assert.match(h.text(), /저장 공간 한도/);
  assert.deepEqual(h.values(), ['quota draft']); assert.equal(h.window.kinViewerHistoryHasUnsaved(), true);
});

test('A4 delta: retained annotation with identical values reports failed source, not recalculation mismatch', async () => {
  const { h, a, saved } = await savedMeasurement(); await h.click('편집');
  h.pages.set('1', [{ ...saved, revision: 2, referenceStatus: 'unverified' }]);
  await h.click('새로고침'); await h.click('최신판 기준으로 내 수정 유지'); await h.tick();
  assert.equal(h.annotations.get(a.annotationUID), a); assert.equal(a.data.kinUnverified, true);
  assert.match(h.text(), /원본을 확인하지 못했습니다/); assert.doesNotMatch(h.text(), /재계산 값이 저장 당시와 다릅니다/);
  assert.equal(h.button('저장').disabled, true);
});
