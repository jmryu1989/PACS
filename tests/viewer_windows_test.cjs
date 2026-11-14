const { test, after } = require('node:test');
const assert = require('node:assert/strict');
// The registry follows its document's gate (S7-U5): the shipped gate with a live synthetic session.
require('./module_session_harness.cjs').install();
const model = require('../worklist-v0/hpacs-lite/viewer-windows.js');
const registries = [];
const create = options => { const registry = model.create(options); registries.push(registry); return registry; };
after(() => registries.forEach(registry => registry.end()));
const id = '00000000-0000-4000-8000-000000000001';
const origin = 'https://localhost:9443';
const url = n => origin + '/ohif/viewer?StudyInstanceUIDs=1.2.' + n;
function setup(seed) {
  const values = new Map(seed || []), storage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) };
  let owner = '["i","a"]';
  const options = { storage, owner: () => owner, newId: () => id, origin,
    describe: popup => ({ kind: 'viewer', href: popup.href, ready: true, busy: !!popup.busy, dirty: !!popup.dirty }) };
  return { values, storage, options, registry: create(options), changeOwner: v => { owner = v; } };
}
test('window records contain only bounded identifiers and occupancy', () => {
  const good = { version: 1, id, slots: [true,false,false,true] };
  assert.deepEqual(model.normalize(good), good);
  for (const patch of [{ version: 2 }, { id: 'wrong' }, { slots: [true] }, { slots: [1,false,false,false] }, { uid: '1.2' }])
    assert.equal(model.normalize({ ...good, ...patch }), null);
});
test('scope refuses other origins, duplicate queries, malformed and excessive study scope', () => {
  assert.deepEqual(model.scope(url(1), origin), { studies: ['1.2.1'], series: null });
  for (const href of ['https://other.test/ohif/viewer?StudyInstanceUIDs=1.2', '/other?StudyInstanceUIDs=1.2',
    '/ohif/viewer?StudyInstanceUIDs=1.2&StudyInstanceUIDs=1.3', '/ohif/viewer?StudyInstanceUIDs=1.2,1.2',
    '/ohif/viewer?StudyInstanceUIDs=' + Array.from({ length: 11 }, (_, i) => '1.' + (i + 2)).join(','),
    '/ohif/viewer?StudyInstanceUIDs=1..2',
    '/ohif/viewer?StudyInstanceUIDs=1.2&initialSeriesInstanceUID=bad']) assert.equal(model.scope(href, origin), null);
  // Merge Exam: a merged exam opens its studies (at most 10, the base first) as one scope.
  assert.deepEqual(model.scope('/ohif/viewer?StudyInstanceUIDs=1.2,1.3,1.4', origin), { studies: ['1.2', '1.3', '1.4'], series: null });
});
test('one window reuses slot zero; several windows retain distinct scopes until explicitly closed', () => {
  const { registry:r, values } = setup();
  const a = r.choose(url(1), 2), pa = { href: url(1), closed: false, dirty: true }; r.attach(a, pa);
  const b = r.choose(url(2), 2), pb = { href: url(2), closed: false }; r.attach(b, pb);
  assert.equal(r.choose(url(1), 2).index, a.index);
  assert.equal(r.choose(url(3), 2).full, true);
  assert.equal(r.choose(url(3), 1).full, true);
  pb.closed = true;
  const c = r.choose(url(3), 2); assert.equal(c.index, b.index);
  r.blocked(c); assert.equal(r.rows().length, 1);
  assert.equal(r.choose(url(4), 1).index, a.index);
  const record = [...values.values()][0]; assert.ok(!record.includes('StudyInstanceUIDs')); assert.ok(!record.includes('1.2.1'));
});
test('fresh document allocates another same-scope slot and retains a dirty busy viewer', () => {
  const { registry:r } = setup();
  const old = r.choose(url(1), 2), popup = { href:url(1), closed:false, dirty:true, busy:true }; r.attach(old, popup);
  const fresh = r.choose(url(1), 2, { freshDocument:true });
  assert.equal(fresh.fresh, true); assert.notEqual(fresh.index, old.index); assert.equal(r.rows()[0].popup, popup);
  assert.deepEqual(r.rows()[0].status, { kind:'viewer', href:url(1), ready:true, busy:true, dirty:true });
});
test('fresh document refuses a full limit even when an existing scope looks reusable', () => {
  const { registry:r } = setup(); const old=r.choose(url(1), 1); r.attach(old, { href:url(1), closed:false });
  const result=r.choose(url(1), 1, { freshDocument:true });
  assert.equal(result.full, true); assert.match(result.error, /Image Opening.*Viewer Windows/); assert.match(result.error, /저장하고 닫으세요/);
  assert.equal(r.rows().length, 1); assert.equal(r.rows()[0].index, old.index);
});
test('blocked fresh reservations are reclaimed and ended owners cannot allocate', () => {
  const { registry:r } = setup(); const old=r.choose(url(1), 2); r.attach(old, { href:url(1), closed:false });
  const blocked=r.choose(url(1), 2, { freshDocument:true }); r.blocked(blocked);
  const retry=r.choose(url(1), 2, { freshDocument:true }); assert.equal(retry.index, blocked.index); r.blocked(retry);
  assert.equal(r.rows().length, 1); r.end(); assert.ok(r.choose(url(1), 2, { freshDocument:true }).error);
});
test('reload retains unverified occupied slots; silence cannot free capacity', () => {
  const { registry:r, options } = setup(); r.attach(r.choose(url(1), 2), { href: url(1), closed: false });
  r.attach(r.choose(url(2), 2), { href: url(2), closed: false });
  const resumed = create(options);
  assert.equal(resumed.rows().length, 2); assert.equal(resumed.choose(url(3), 2).full, true);
  assert.equal(resumed.rows()[0].scope, null);
});
test('blocked popup reservation, owner changes and denied/corrupt storage cannot bypass the cap', () => {
  const s = setup(), a = s.registry.choose(url(1), 2); s.registry.blocked(a);
  assert.equal(s.registry.rows().length, 0);
  s.changeOwner('["i","b"]'); assert.ok(s.registry.choose(url(1), 2).error);
  for (const storage of [{ getItem() { throw Error('denied'); } }, { getItem: () => '{', setItem() {} },
    { getItem: () => null, setItem() { throw Error('quota'); } }]) {
    const r = create({ ...s.options, storage }); assert.equal(r.available(), false); assert.ok(r.choose(url(1), 2).error);
  }
});
test('window hash preserves the reading return token and carries no new clinical fields', () => {
  const { registry:r } = setup(); const a=r.choose(url(1), 2);
  const linked = new URL(r.linked(url(1) + '#kin-reading-return=' + id, a.index), origin);
  const hash = new URLSearchParams(linked.hash.slice(1));
  assert.equal(hash.get('kin-reading-return'), id); assert.equal(hash.get('kin-window-group'), id);
  assert.equal(hash.get('kin-window-slot'), '0');
  // C-R01-012#29: the list document's own link id (never stored) names who answers this window's editor request.
  assert.match(hash.get('kin-window-list'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(hash.get('kin-window-list'), id); assert.equal(hash.size, 4);
});

test('a failed closed-slot write cannot continue an open request and can recover on refresh', () => {
  const { registry:r, storage } = setup();
  const popup = { href: url(1), closed: false }; r.attach(r.choose(url(1), 1), popup);
  const set = storage.setItem; storage.setItem = () => { throw Error('quota'); }; popup.closed = true;
  assert.ok(r.choose(url(2), 1).error);
  assert.equal(r.available(), false);
  storage.setItem = set; r.refresh();
  assert.equal(r.rows().length, 0); assert.equal(r.available(), true);
  assert.equal(r.choose(url(2), 1).fresh, true);
});

test('pending navigation deduplicates a blank document and cannot appear ready from its old scope', () => {
  const { registry:r, values } = setup();
  const a = r.choose(url(1), 2), popup = { href: 'about:blank', closed: false };
  r.attach(a, popup); r.navigating(a, url(1));
  const duplicate = r.choose(url(1), 2);
  assert.equal(duplicate.index, a.index); assert.equal(duplicate.fresh, false); assert.equal(duplicate.pending, true);
  assert.equal(r.choose(url(2), 1).pending, true);
  popup.href = url(2); assert.equal(r.rows()[0].status.ready, false);
  assert.deepEqual(r.rows()[0].scope.studies, ['1.2.1']);
  popup.href = url(1); assert.equal(r.rows()[0].pending, false); assert.equal(r.rows()[0].status.ready, true);
  assert.ok(![...values.values()][0].includes('1.2.1'));
});

test('an authenticated replacement document can announce its restored Job scope', () => {
  const { registry:r } = setup(), a = r.choose(url(1), 2);
  const popup = { href: url(3), closed: false, document: {}, performance: { timeOrigin: 100 } };
  r.attach(a, popup); r.navigating(a, url(1));
  assert.equal(r.rows()[0].pending, true);
  popup.document = {};
  assert.equal(r.rows()[0].pending, false);
  assert.deepEqual(r.rows()[0].scope.studies, ['1.2.3']);
});

test('a changed but unverified document is no longer pending and end drops document references', () => {
  const { options } = setup();
  const r = create({ ...options, describe: p => ({ kind: 'viewer', href: p.href, ready: false, busy: true }) });
  const a = r.choose(url(1), 1), popup = { href: url(1), closed: false, document: {} };
  r.attach(a, popup); r.navigating(a, url(1), popup.document);
  assert.equal(r.rows()[0].pending, true);
  popup.document = {};
  assert.equal(r.rows()[0].pending, false); assert.equal(r.rows()[0].status.ready, false);
  r.end(); assert.equal(r.rows()[0].popup, null); assert.equal(r.rows()[0].scope, null);
});

test('a target URL with the old ready document cannot finish navigation', () => {
  const { registry:r } = setup(), a = r.choose(url(1), 1);
  const popup = { href: url(1), closed: false, document: {} };
  r.attach(a, popup); r.navigating(a, url(1), popup.document);
  assert.equal(r.rows()[0].pending, true); assert.equal(r.rows()[0].status.ready, false);
  popup.document = {};
  assert.equal(r.rows()[0].pending, false); assert.equal(r.rows()[0].status.ready, true);
});

test('an inaccessible replacement followed by another verified scope releases pending', () => {
  const { options } = setup(); let inaccessible = false, document = {};
  const r = create({ ...options, describe: p => inaccessible ? { kind: 'unknown', ready: false } : { kind: 'viewer', href: p.href, ready: true } });
  const a = r.choose(url(1), 1), popup = { href: url(2), closed: false };
  Object.defineProperty(popup, 'document', { get() { if (inaccessible) throw Error('cross-origin'); return document; } });
  r.attach(a, popup); r.navigating(a, url(1), document);
  inaccessible = true; assert.equal(r.rows()[0].pending, true);
  inaccessible = false; document = {}; popup.href = url(3);
  assert.equal(r.rows()[0].pending, false); assert.deepEqual(r.rows()[0].scope.studies, ['1.2.3']);
});

// V-SPACE (Minhoon 2026-10-27 item 5): a reloaded list keeps the viewer's place.
const flush = () => new Promise(resolve => setTimeout(resolve, 30));
test('a list that no longer holds the viewer saves its reported move; a held window is measured by its list', async () => {
  const { options } = setup(), saved = [];
  const r = create({ ...options, placed: (slot, rect) => saved.push([slot, rect]) });
  const slot = r.choose(url(1), 1), viewer = new BroadcastChannel('kin-viewer-windows:' + id);
  try {
    const rect = { left: 1920, top: 0, width: 1600, height: 1000 };
    const present = extra => viewer.postMessage({ type: 'present', owner: '["i","a"]', index: slot.index, href: url(1), ...extra });
    present({}); await flush();
    assert.deepEqual(saved, [], 'an announcement without a move keeps the saved place');
    present({ rect }); await flush();
    assert.deepEqual(saved, [[slot.index, rect]]);
    for (const extra of [{ rect: { ...rect, width: 100 } }, { rect: { ...rect, left: -32000 } }, { rect: { ...rect, top: 'x' } },
      { rect, owner: '["i","b"]' }, { rect, index: 2 }]) { present(extra); await flush(); }
    assert.equal(saved.length, 1, 'small, minimized, malformed, other-account and unoccupied reports are ignored');
    r.attach(slot, { href: url(1), closed: false });
    present({ rect: { ...rect, left: 0 } }); await flush();
    assert.equal(saved.length, 1, 'the list holding the window keeps its own measurement and pending placement');
  } finally { viewer.close(); }
});
test('a viewer reports its geometry only after it moves, and not while minimized', async t => {
  const names = ['location', 'document', 'screenX', 'screenY', 'outerWidth', 'outerHeight', 'addEventListener', 'removeEventListener'];
  const saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const name of names) { if (saved[name]) Object.defineProperty(globalThis, name, saved[name]); else delete globalThis[name]; } });
  const stub = { location: new URL(url(1) + '#kin-window-group=' + id + '&kin-window-slot=0'), document: { visibilityState: 'visible' },
    screenX: 40, screenY: 40, outerWidth: 1600, outerHeight: 1000, addEventListener() {}, removeEventListener() {} };
  for (const [name, value] of Object.entries(stub)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const list = new BroadcastChannel('kin-viewer-windows:' + id), heard = [];
  list.onmessage = event => heard.push(event.data);
  const viewer = model.connect({ owner: () => ['i', 'a'], live: () => true });
  try {
    await flush();
    assert.equal(heard.length, 1); assert.equal(heard[0].type, 'present'); assert.equal('rect' in heard[0], false);
    t.mock.timers.tick(2000); await flush();
    assert.equal(heard.length, 1, 'an unmoved window says nothing more');
    globalThis.screenX = 1960; t.mock.timers.tick(2000); await flush();
    assert.deepEqual(heard.at(-1).rect, { left: 1960, top: 40, width: 1600, height: 1000 });
    t.mock.timers.tick(2000); await flush();
    assert.equal(heard.length, 2, 'the same place is reported once');
    globalThis.document.visibilityState = 'hidden'; globalThis.screenX = -32000; t.mock.timers.tick(2000); await flush();
    assert.equal(heard.length, 2, 'a minimized window never reports its off-screen coordinates');
  } finally { viewer.dispose(); list.close(); }
});

/* C-R01-012#29: the reading screen's answer to a viewer's kin-editor-request. It is read only: the exact typed text, and only for
 * this login, this report target, no open dialog and a usable findings field. A malformed request gets no answer at all. */
const REQ = '11111111-2222-4333-8444-555555555555';
test('editorReply answers this login and report target only, with the exact text, and refuses by name otherwise', () => {
  const fields = { findings: { value: 'F line\n' }, conclusion: { value: 'C' }, recommendation: { value: '' } };
  const base = { owner: '["i","a"]', target: '1.2.1', modal: false, usable: true };
  let state = base;
  const reader = { owner: () => state.owner, target: () => state.target, modal: () => state.modal, field: id => fields[id],
    usable: field => field === fields.findings && state.usable, session: (owner, uid) => 'S|' + owner + '|' + uid };
  const m = { type: 'kin-editor-request', request: REQ, owner: '["i","a"]', studies: ['1.2.1', '1.2.0'], activeUid: '1.2.1' };
  const echo = { type: 'kin-editor-reply', request: REQ, owner: '["i","a"]', studies: ['1.2.1', '1.2.0'], activeUid: '1.2.1' };
  assert.deepEqual(model.editorReply(m, reader), { ...echo, result: 'ok', session: 'S|["i","a"]|1.2.1',
    editor: { findings: 'F line\n', conclusion: 'C', recommendation: '' } });
  for (const [change, result] of [[{ owner: '["i","b"]' }, 'session'], [{ owner: null }, 'session'], [{ target: '1.2.0' }, 'context'],
    [{ target: null }, 'context'], [{ modal: true }, 'modal'], [{ usable: false }, 'unavailable']]) {
    state = { ...base, ...change };
    assert.deepEqual(model.editorReply(m, reader), { ...echo, result }, JSON.stringify(change));
  }
  state = base;
  // A missing field, a field without text and a reader that throws are unavailable, never a partial body.
  for (const broken of [{ field: id => id === 'recommendation' ? null : fields[id] }, { field: id => id === 'conclusion' ? { value: 3 } : fields[id] },
    { session: () => '' }, { modal: () => { throw new Error('reader broke'); } }])
    assert.deepEqual(model.editorReply(m, { ...reader, ...broken }), { ...echo, result: 'unavailable' });
  for (const bad of [null, 'x', [], { ...m, type: 'request' }, { ...m, request: 'not-a-uuid' }, { ...m, owner: ['i', 'a'] }, { ...m, studies: [] },
    { ...m, studies: ['1', '2', '3'] }, { ...m, studies: '1.2.1' }, { ...m, activeUid: '1.2.0' }])
    assert.equal(model.editorReply(bad, reader), null, JSON.stringify(bad));
  // The answer's scope is a copy of the request's.
  const answer = model.editorReply(m, reader); answer.studies.push('changed'); assert.deepEqual(m.studies, ['1.2.1', '1.2.0']);
});
test('only the list document that linked the viewer relays its kin-editor-request; a duplicated tab of the same group stays silent', async t => {
  for (const registry of registries) registry.end();
  t.after(() => { delete globalThis.kinReadingEditorReply; });
  const first = setup(), slot = first.registry.choose(url(1), 1);
  const list = new URLSearchParams(new URL(first.registry.linked(url(1), slot.index), origin).hash.slice(1)).get('kin-window-list');
  // A duplicated tab copies sessionStorage, so it shares the group id; its own document link differs.
  const duplicate = create({ ...first.options, storage: { getItem: k => first.values.get(k) ?? null, setItem() {} } });
  const other = new URLSearchParams(new URL(duplicate.linked(url(1), 0), origin).hash.slice(1));
  assert.equal(other.get('kin-window-group'), id); assert.notEqual(other.get('kin-window-list'), list);
  const viewer = new BroadcastChannel('kin-viewer-windows:' + id), heard = [], asked = [];
  viewer.onmessage = event => heard.push(event.data);
  const request = { type: 'kin-editor-request', request: REQ, owner: '["i","a"]', studies: ['1.2.1'], activeUid: '1.2.1', list };
  try {
    viewer.postMessage(request); await flush();
    assert.deepEqual(heard, [], 'nothing answers while the reading screen is absent');
    globalThis.kinReadingEditorReply = message => { asked.push(message); return { type: 'kin-editor-reply', request: message.request, result: 'context' }; };
    viewer.postMessage(request); await flush();
    assert.deepEqual(asked, [request], 'only the linking document is asked'); assert.deepEqual(heard, [{ type: 'kin-editor-reply', request: REQ, result: 'context' }]);
    const { list: _, ...unnamed } = request;
    viewer.postMessage(unnamed); await flush();
    assert.equal(asked.length, 1, 'a request naming no list document is not answered'); assert.equal(heard.length, 1);
    // A request naming the duplicate's own link is that document's: it answers it once (this test shares one reader global).
    viewer.postMessage({ ...request, list: other.get('kin-window-list') }); await flush();
    assert.equal(asked.length, 2); assert.equal(asked[1].list, other.get('kin-window-list')); assert.equal(heard.length, 2);
    globalThis.kinReadingEditorReply = () => { throw new Error('reader broke'); };
    viewer.postMessage(request); await flush();
    assert.equal(heard.length, 2, 'a reader that throws answers nothing');
    globalThis.kinReadingEditorReply = message => ({ type: 'kin-editor-reply', request: message.request, result: 'ok' });
    for (const registry of registries) registry.end();
    viewer.postMessage(request); await flush();
    assert.equal(heard.length, 2, 'an ended list answers nothing');
  } finally { viewer.close(); }
});