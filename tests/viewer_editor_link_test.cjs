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
