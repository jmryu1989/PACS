'use strict';
/* TEST-D09-EDITOR-COMPARE-OUTPUT: pure checks for the viewer's editor link.
 * The browser factory needs a real window, a real foreign WindowProxy source and
 * a real origin check, so it is exercised in the Playwright page test instead. */
const assert = require('node:assert/strict');
const { test } = require('node:test');

const link = require('../worklist-v0/hpacs-lite/viewer-editor-link.js');

const OWNER = JSON.stringify(['INST-1', 'subject-1']);
const CURRENT = 'uid-current', COMPARE = 'uid-compare';
const REQUEST = '11111111-2222-3333-4444-555555555555';

const expected = (extra) => Object.assign({ request: REQUEST, owner: OWNER,
  studies: [CURRENT, COMPARE], activeUid: CURRENT }, extra);
const body = (extra) => Object.assign({ findings: 'F', conclusion: 'C', recommendation: 'R' }, extra);
const reply = (extra) => Object.assign({ type: 'kin-editor-reply', request: REQUEST, result: 'ok',
  owner: OWNER, studies: [CURRENT, COMPARE], activeUid: CURRENT, session: 'sess-1', editor: body() }, extra);

test('module loads under require and still defines the browser factory', () => {
  assert.equal(typeof globalThis.kinViewerEditorLink, 'function');
  for (const name of ['validReply', 'sameEditor', 'reasonText'])
    assert.equal(typeof link[name], 'function', name);
});

test('validReply accepts only the exact answer to this request', () => {
  const ok = link.validReply(reply(), expected());
  assert.deepEqual(ok, { ok: true, editor: { findings: 'F', conclusion: 'C', recommendation: 'R' }, session: 'sess-1' });
  // The returned body is a fresh object holding only the three fields.
  assert.deepEqual(Object.keys(ok.editor), ['findings', 'conclusion', 'recommendation']);
  const extra = link.validReply(reply({ editor: body({ secret: 'x' }) }), expected());
  assert.equal(extra.ok, true);
  assert.equal(extra.editor.secret, undefined);
  // A single-study viewer is answered the same way.
  assert.equal(link.validReply(reply({ studies: [CURRENT] }), expected({ studies: [CURRENT] })).ok, true);
  assert.equal(link.validReply(reply({ editor: body({ findings: '' }) }), expected()).editor.findings, '');
});

test('validReply reports the reading window refusal it was given', () => {
  for (const reason of ['session', 'context', 'modal', 'unavailable', 'denied'])
    assert.deepEqual(link.validReply(reply({ result: reason, session: undefined, editor: undefined }), expected()),
      { ok: false, reason });
  // A refusal that still matches the request is never mistaken for a body.
  assert.deepEqual(link.validReply(reply({ result: 'denied' }), expected()), { ok: false, reason: 'denied' });
});

test('validReply refuses malformed shapes without throwing', () => {
  for (const bad of [undefined, null, '', 0, false, [], 'kin-editor-reply', { }, { type: 'kin-editor-request' },
    { type: 'kin-editor-reply' }, new Date()])
    assert.deepEqual(link.validReply(bad, expected()), { ok: false, reason: 'invalid' }, JSON.stringify(bad) || String(bad));
  for (const bad of [undefined, null, 'x', 0, []])
    assert.deepEqual(link.validReply(reply(), bad), { ok: false, reason: 'invalid' }, String(bad));
  const cases = {
    'unknown result': { result: 'maybe' },
    'missing result': { result: undefined },
    'ok result object': { result: { } },
    'no session': { session: undefined },
    'empty session': { session: '' },
    'numeric session': { session: 7 },
    'no editor': { editor: undefined },
    'array editor': { editor: [] },
    // An array survives structuredClone with its own properties, so an
    // array-shaped body carrying the three fields must still be refused.
    'array editor carrying fields': { editor: Object.assign([], body({ findings: 'LEAK' })) },
    'array editor with indexed fields': { editor: Object.assign(['x'], body()) },
    'string editor': { editor: 'F' },
    'numeric findings': { editor: body({ findings: 1 }) },
    'null conclusion': { editor: body({ conclusion: null }) },
    'missing recommendation': { editor: { findings: 'F', conclusion: 'C' } },
    'wrong type': { type: 'kin-editor-request' },
  };
  for (const [name, patch] of Object.entries(cases))
    assert.deepEqual(link.validReply(reply(patch), expected()), { ok: false, reason: 'invalid' }, name);
});

test('validReply refuses a reply for another request, owner, scope or study', () => {
  const mismatches = {
    'other request': { request: '99999999-2222-3333-4444-555555555555' },
    'numeric request': { request: 7 },
    'missing request': { request: undefined },
    'other owner': { owner: JSON.stringify(['INST-2', 'subject-1']) },
    'other subject': { owner: JSON.stringify(['INST-1', 'subject-2']) },
    'unstringified owner': { owner: ['INST-1', 'subject-1'] },
    'missing owner': { owner: undefined },
    'reordered studies': { studies: [COMPARE, CURRENT] },
    'shorter studies': { studies: [CURRENT] },
    'longer studies': { studies: [CURRENT, COMPARE, 'uid-extra'] },
    'string studies': { studies: CURRENT },
    'missing studies': { studies: undefined },
    'other active study': { activeUid: COMPARE },
    'missing active study': { activeUid: undefined },
  };
  for (const [name, patch] of Object.entries(mismatches))
    assert.deepEqual(link.validReply(reply(patch), expected()), { ok: false, reason: 'invalid' }, name);
  // A refusal reason cannot smuggle a mismatched scope past the check either.
  assert.deepEqual(link.validReply(reply({ result: 'context', activeUid: COMPARE }), expected()),
    { ok: false, reason: 'invalid' });
  assert.deepEqual(link.validReply(reply(), expected({ studies: [CURRENT] })), { ok: false, reason: 'invalid' });
});

test('validReply refuses a body longer than the field limit', () => {
  const limit = 200000;
  for (const key of ['findings', 'conclusion', 'recommendation']) {
    assert.equal(link.validReply(reply({ editor: body({ [key]: 'x'.repeat(limit) }) }), expected()).ok, true, key);
    assert.deepEqual(link.validReply(reply({ editor: body({ [key]: 'x'.repeat(limit + 1) }) }), expected()),
      { ok: false, reason: 'invalid' }, key);
  }
  assert.deepEqual(link.validReply(reply({ session: 'x'.repeat(limit + 1) }), expected()), { ok: false, reason: 'invalid' });
});

test('sameEditor compares owner, study, session and the exact body', () => {
  const base = { owner: OWNER, uid: CURRENT, session: 'sess-1', editor: body() };
  const copy = () => JSON.parse(JSON.stringify(base));
  assert.equal(link.sameEditor(base, copy()), true);
  // Key order of the body must not decide the answer.
  assert.equal(link.sameEditor(base, { session: 'sess-1', uid: CURRENT, owner: OWNER,
    editor: { recommendation: 'R', conclusion: 'C', findings: 'F' } }), true);
  const changed = [
    { owner: JSON.stringify(['INST-2', 'subject-1']) },
    { uid: COMPARE },
    { session: 'sess-2' },
    { editor: body({ findings: 'F2' }) },
    { editor: body({ conclusion: '' }) },
    { editor: body({ recommendation: 'R ' }) },
    { editor: { findings: 'F', conclusion: 'C' } },
  ];
  for (const patch of changed)
    assert.equal(link.sameEditor(base, Object.assign(copy(), patch)), false, JSON.stringify(patch));
  for (const bad of [undefined, null, '', 0, [], 'x'])
    assert.equal(link.sameEditor(base, bad), false, String(bad));
  assert.equal(link.sameEditor(null, null), false);
});

test('reasonText names every refusal the dialog can show', () => {
  assert.equal(link.reasonText('session'), '판독 화면의 세션이 바뀌었습니다. 다시 연결하세요.');
  assert.equal(link.reasonText('context'), '판독 화면의 편집 대상이 이 검사가 아닙니다.');
  assert.equal(link.reasonText('modal'), '판독 화면의 대화상자를 닫은 뒤 다시 확인하세요.');
  assert.equal(link.reasonText('unavailable'), '판독문 입력란을 확인할 수 없습니다.');
  assert.equal(link.reasonText('denied'), '편집문 출력 권한이 없습니다.');
  assert.equal(link.reasonText('invalid'), '편집문 응답을 확인할 수 없습니다.');
  assert.equal(link.reasonText('timeout'), '판독 화면의 응답이 없습니다. 목록 창에서 영상 창을 다시 연결하세요.');
  assert.equal(link.reasonText('missing'), '연결된 판독 화면이 없습니다. 판독 화면에서 연 영상 창에서만 편집문을 출력할 수 있습니다.');
  for (const bad of ['nonsense', '', undefined, null, 0, {}])
    assert.equal(link.reasonText(bad), '편집문 응답을 확인할 수 없습니다.', String(bad));
  for (const reason of ['session', 'context', 'modal', 'unavailable', 'denied', 'invalid', 'timeout', 'missing'])
    assert.ok(!link.reasonText(reason).includes('과거'), reason);
});

/* The cross-window boundary of the adapter (`event.origin` and `event.source`)
 * is the only thing standing between a foreign frame and the unsaved report
 * body, so it is pinned here with an injected window instead of a real one:
 * a page test cannot make a wrong-origin reply arrive from the bound window. */
const ORIGIN = 'https://localhost:9443';
// In the browser the pure half publishes itself on the global; under require the
// CommonJS branch wins, so the factory's lookup is restored for these cases.
globalThis.kinViewerEditorLinkApi = globalThis.kinViewerEditorLinkApi || link;

function harness(extra) {
  const listeners = new Set();
  const target = { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }); } };
  const view = {
    crypto: { randomUUID: () => REQUEST },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
  };
  const adapter = globalThis.kinViewerEditorLink(Object.assign({
    window: view, target, origin: ORIGIN, studies: [CURRENT, COMPARE],
    owner: () => ['INST-1', 'subject-1'], live: () => true, timeoutMs: 30,
  }, extra));
  return { adapter, view, target, listeners,
    deliver: event => { for (const fn of [...listeners]) fn(event); } };
}

test('the adapter asks the bound window with the request it will accept', async () => {
  const kit = harness();
  assert.equal(kit.adapter.available(), true);
  const answer = kit.adapter.read();
  assert.equal(kit.target.sent.length, 1);
  assert.equal(kit.target.sent[0].origin, ORIGIN);
  assert.deepEqual(kit.target.sent[0].data, { type: 'kin-editor-request', request: REQUEST,
    owner: OWNER, studies: [CURRENT, COMPARE], activeUid: CURRENT });
  kit.deliver({ origin: ORIGIN, source: kit.target, data: reply() });
  assert.deepEqual(await answer, { owner: OWNER, uid: CURRENT, session: 'sess-1',
    editor: { findings: 'F', conclusion: 'C', recommendation: 'R' } });
  assert.equal(kit.listeners.size, 0);
});

test('a reply from another origin is ignored, not answered', async () => {
  // The prefix-sharing entries pin an exact-match check: a startsWith test would
  // let every one of them through while the wholly foreign ones still fail.
  for (const origin of ['https://evil.example', 'http://localhost:9443', 'https://localhost:9444',
    'https://localhost:9443.evil.example', 'https://localhost:94430', 'https://localhost:9443@evil.example',
    '', null, undefined]) {
    const kit = harness();
    const answer = kit.adapter.read();
    kit.deliver({ origin, source: kit.target, data: reply() });
    assert.deepEqual(await answer, { ok: false, reason: 'timeout' }, String(origin));
    assert.equal(kit.listeners.size, 0, String(origin));
  }
});

test('a reply from a window other than the bound one is ignored, not answered', async () => {
  const others = () => [{ postMessage() {} }, { }, null, undefined, globalThis];
  for (const source of others()) {
    const kit = harness();
    const answer = kit.adapter.read();
    kit.deliver({ origin: ORIGIN, source, data: reply() });
    assert.deepEqual(await answer, { ok: false, reason: 'timeout' }, String(source));
    assert.equal(kit.listeners.size, 0, String(source));
  }
  // A foreign window cannot get in by sending a refusal either.
  const kit = harness();
  const answer = kit.adapter.read();
  kit.deliver({ origin: ORIGIN, source: { postMessage() {} }, data: reply({ result: 'denied' }) });
  assert.deepEqual(await answer, { ok: false, reason: 'timeout' });
});

test('a foreign reply does not consume the answer the bound window still sends', async () => {
  const kit = harness();
  const answer = kit.adapter.read();
  kit.deliver({ origin: 'https://evil.example', source: kit.target, data: reply({ editor: body({ findings: 'LEAK' }) }) });
  kit.deliver({ origin: ORIGIN, source: { postMessage() {} }, data: reply({ editor: body({ findings: 'LEAK' }) }) });
  kit.deliver({ origin: ORIGIN, source: kit.target, data: reply() });
  const value = await answer;
  assert.equal(value.editor.findings, 'F');
  assert.deepEqual(value, { owner: OWNER, uid: CURRENT, session: 'sess-1',
    editor: { findings: 'F', conclusion: 'C', recommendation: 'R' } });
});

test('an array-shaped body from the bound window is refused, not read as fields', async () => {
  const kit = harness();
  const answer = kit.adapter.read();
  kit.deliver({ origin: ORIGIN, source: kit.target,
    data: reply({ editor: Object.assign([], body({ findings: 'LEAK' })) }) });
  assert.deepEqual(await answer, { ok: false, reason: 'invalid' });
});

test('a delayed editor answer cannot outlive the window or its current owner', async () => {
  for (const change of ['close', 'inactive', 'owner']) {
    let live = true, owner = ['INST-1', 'subject-1'];
    const kit = harness({ live: () => live, owner: () => owner });
    const answer = kit.adapter.read();
    if (change === 'close') kit.target.closed = true;
    if (change === 'inactive') live = false;
    if (change === 'owner') owner = ['INST-1', 'subject-2'];
    kit.deliver({ origin: ORIGIN, source: kit.target, data: reply() });
    assert.deepEqual(await answer, { ok: false, reason: change === 'owner' ? 'session' : 'missing' });
    assert.equal(kit.listeners.size, 0);
    if (change === 'close') assert.equal(kit.adapter.available(), false);
  }
});

test('cancelling document preparation does not revive its older editor request', async () => {
  const work = require('../worklist-v0/hpacs-lite/work-context.js').create();
  work.follow({ onLifecycle(listener) { listener({ state: 'active', session: 'sess-1' }); } });
  const kit = harness();
  kit.view.KinWorkContext = work;
  const answer = kit.adapter.read();
  const preparing = work.prepare();
  assert.equal(work.cancelPreparation(preparing), true);
  kit.deliver({ origin: ORIGIN, source: kit.target, data: reply() });
  assert.deepEqual(await answer, { ok: false, reason: 'missing' });
  assert.equal(kit.listeners.size, 0);
});

/* C-R01-012#29: a viewer window the list opened has no opener (viewer-launch.js detaches it), so the adapter asks that list over
 * the list's own window-group channel, naming the list document that linked this window (both in its address, viewer-windows.js
 * linked()). Only an answer naming this request on that channel is read, under the same link, and the channel is closed with it. */
const GROUP = '0f0e0d0c-0b0a-4900-8800-070605040302', LIST = '0a0b0c0d-0e0f-4a00-9b00-010203040506';
const linkHash = (group = GROUP, list = LIST) => '#kin-window-group=' + group + '&kin-window-slot=0&kin-window-list=' + list;
function channelHarness(extra, hash = linkHash()) {
  const channels = [], listeners = new Map();
  class Channel {
    constructor(name) { this.name = name; this.sent = []; this.closed = false; channels.push(this); }
    postMessage(data) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  const view = { crypto: { randomUUID: () => REQUEST }, location: { origin: ORIGIN, hash }, opener: null,
    addEventListener(type, fn) { if (type === 'message') throw new Error('the window is not listened to on the channel path');
      if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  view.parent = view;
  const adapter = globalThis.kinViewerEditorLink(Object.assign({ window: view, Channel, studies: [CURRENT, COMPARE],
    owner: () => ['INST-1', 'subject-1'], live: () => true, timeoutMs: 30 }, extra));
  return { adapter, channels, view, listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    emit: type => { for (const fn of [...(listeners.get(type) || [])]) fn({ type }); },
    deliver: data => channels.at(-1).onmessage({ data }) };
}

test('without an opener the adapter asks the list document that linked it, on its window-group channel', async () => {
  const kit = channelHarness();
  assert.equal(kit.adapter.available(), true);
  const answer = kit.adapter.read();
  assert.equal(kit.channels.length, 1);
  assert.equal(kit.channels[0].name, 'kin-viewer-windows:' + GROUP);
  assert.deepEqual(kit.channels[0].sent, [{ type: 'kin-editor-request', request: REQUEST, owner: OWNER,
    studies: [CURRENT, COMPARE], activeUid: CURRENT, list: LIST }]);
  // Other traffic on the group channel: another viewer's request, a window announcement, an answer to another request.
  kit.deliver({ type: 'kin-editor-request', request: REQUEST, owner: OWNER, studies: [CURRENT], activeUid: CURRENT, list: LIST });
  kit.deliver({ type: 'present', owner: OWNER, index: 0 });
  kit.deliver(reply({ request: '99999999-2222-3333-4444-555555555555', editor: body({ findings: 'OTHER' }) }));
  kit.deliver(reply());
  assert.deepEqual(await answer, { owner: OWNER, uid: CURRENT, session: 'sess-1',
    editor: { findings: 'F', conclusion: 'C', recommendation: 'R' } });
  assert.equal(kit.channels[0].closed, true);
  assert.equal(kit.listening(), 0);
  // A refusal on the channel is the list's answer, an answer about another study is refused, and silence is a timeout.
  for (const [data, value] of [[reply({ result: 'context' }), { ok: false, reason: 'context' }],
    [reply({ activeUid: COMPARE }), { ok: false, reason: 'invalid' }], [null, { ok: false, reason: 'timeout' }]]) {
    const next = channelHarness(), pending = next.adapter.read();
    if (data) next.deliver(data);
    assert.deepEqual(await pending, value, JSON.stringify(data));
    assert.equal(next.channels[0].closed, true);
  }
});

test('a request is bound to the link it was sent on: a relink cancels it and a late answer under another link is refused', async () => {
  for (const type of ['kin-window-link-changed', 'hashchange']) {
    const kit = channelHarness(), pending = kit.adapter.read();
    kit.emit(type);
    assert.deepEqual(await pending, { ok: false, reason: 'missing' }, type);
    assert.equal(kit.channels[0].closed, true, type); assert.equal(kit.listening(), 0, type);
  }
  // The address changed without an event reaching this request (another group or another list document): the answer from the
  // old link is not read.
  for (const hash of [linkHash('0f0e0d0c-0b0a-4900-8800-0706050403ff'), linkHash(GROUP, '0a0b0c0d-0e0f-4a00-9b00-0102030405ff')]) {
    const kit = channelHarness(), pending = kit.adapter.read();
    kit.view.location.hash = hash;
    kit.deliver(reply());
    assert.deepEqual(await pending, { ok: false, reason: 'missing' }, hash);
  }
});

test('without an opener and without exactly one valid window group and list there is no link', async () => {
  for (const hash of ['', '#kin-window-slot=0', '#kin-window-group=' + GROUP + '&kin-window-slot=0',
    '#kin-window-group=not-a-uuid&kin-window-list=' + LIST, '#kin-window-group=' + GROUP + '&kin-window-list=not-a-uuid',
    linkHash() + '&kin-window-group=' + GROUP, linkHash() + '&kin-window-list=' + LIST]) {
    const kit = channelHarness({}, hash);
    assert.equal(kit.adapter.available(), false, hash);
    assert.deepEqual(await kit.adapter.read(), { ok: false, reason: 'missing' }, hash);
    assert.equal(kit.channels.length, 0, hash);
  }
  // An explicit target, even none, keeps the bound-window rule; the account and the document still gate the channel.
  assert.equal(channelHarness({ target: null }).adapter.available(), false);
  assert.equal(channelHarness({ live: () => false }).adapter.available(), false);
  assert.equal(channelHarness({ owner: () => null }).adapter.available(), false);
  assert.equal(channelHarness({ Channel: null }).adapter.available(), false, 'a browser without BroadcastChannel');
  // A disposed adapter cancels the request it still waits for and closes the channel.
  const kit = channelHarness(), pending = kit.adapter.read();
  kit.adapter.dispose();
  assert.deepEqual(await pending, { ok: false, reason: 'missing' });
  assert.equal(kit.channels[0].closed, true);
});

/* Open in Reading Screen (and the Mammo Keypad's move of the report target): a request this window stops waiting for — no
 * answer in time, a relink, an answer that arrives under another link, or the adapter disposed — is withdrawn on the channel it
 * was sent on (kin-editor-open-cancel, naming the request), before the channel closes, so the reading screen can drop a move
 * still waiting for its save gate. */
test('an opening without an answer in time is withdrawn on its channel before it ends as a timeout', async () => {
  const kit = channelHarness({ openTimeoutMs: 20 });
  const result = await kit.adapter.open(CURRENT);
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.deepEqual(kit.channels[0].sent.map(m => m.type), ['kin-editor-open', 'kin-editor-open-cancel']);
  assert.deepEqual(kit.channels[0].sent[1], { type: 'kin-editor-open-cancel', request: REQUEST, owner: OWNER, uid: CURRENT, list: LIST });
  assert.equal(kit.channels[0].closed, true);
});

test('an opening ended by a relink, or answered under another link, is withdrawn on the link it was sent on', async () => {
  const kit = channelHarness({ openTimeoutMs: 5000 });
  const pending = kit.adapter.open(CURRENT);
  kit.emit('kin-window-link-changed');
  assert.deepEqual(await pending, { ok: false, reason: 'missing' });
  assert.deepEqual(kit.channels[0].sent.map(m => m.type), ['kin-editor-open', 'kin-editor-open-cancel']);
  assert.equal(kit.channels[0].sent[1].request, REQUEST);
  const other = channelHarness({ openTimeoutMs: 5000 });
  const second = other.adapter.open(CURRENT);
  other.view.location.hash = linkHash(GROUP, '0a0b0c0d-0e0f-4a00-9b00-0102030405ff');
  other.deliver({ type: 'kin-editor-opened', request: REQUEST, owner: OWNER, uid: CURRENT, result: 'ok', reason: null });
  assert.deepEqual(await second, { ok: false, reason: 'missing' });
  assert.deepEqual(other.channels[0].sent.map(m => m.type), ['kin-editor-open', 'kin-editor-open-cancel']);
  // A disposed adapter withdraws what it still waits for.
  const third = channelHarness({ openTimeoutMs: 5000 });
  const waiting = third.adapter.open(CURRENT);
  third.adapter.dispose();
  assert.deepEqual(await waiting, { ok: false, reason: 'missing' });
  assert.deepEqual(third.channels[0].sent.map(m => m.type), ['kin-editor-open', 'kin-editor-open-cancel']);
});