'use strict';
/*
 * TEST-S7-U5-ROAM: the shipped Account Layout module (worklist-v0/hpacs-lite/workspace-roaming.js) over the shipped
 * work-context gate and session transport (tests/module_session_harness.cjs), with the server answered here. The rule
 * under test is Astra's decided one for a refused read of the account copy (roaming-403 consult, 2026-10-05):
 *   - a read that fails never says anything about a write, keeps the local layout, and takes the right to write away
 *     (Save / Reset send nothing) until a later read confirms the account copy;
 *   - the Load button becomes Retry, a read that does not change the screen; a confirmed copy that differs from the
 *     current layout is said so and the reader chooses with the existing buttons;
 *   - a refused Save is the refusal of that save; only a Save whose answer is lost or not known says so;
 *   - with nothing failing there is no warning and no extra click.
 * The sentences are the decided ones (they are the product's statement of what happened, AGENTS §4 문구), so the
 * cases compare them exactly where the decision gave them. The DOM is a minimal stand-in of the panel's four controls.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const harness = require('./module_session_harness.cjs');

const SOURCE = fs.readFileSync(path.join(__dirname, '../worklist-v0/hpacs-lite/workspace-roaming.js'), 'utf8');
const OWNER = ['SYN-INSTITUTION', 'syn-sub-roam'];
const LOCAL = { mode: 'landscape', panels: { list: 300 } };
const OTHER = { mode: 'portrait', panels: { list: 420 } };
const S = {
  deniedKept: '계정 배치 접근이 거절되어 현재 배치를 이 브라우저에서 계속 사용합니다. 계정 배치 접근을 다시 확인하기 전에는 저장 요청을 보내지 않습니다.',
  temporaryKept: '계정 배치를 지금 확인하지 못해 현재 배치를 이 브라우저에서 계속 사용합니다. Retry로 계정 배치를 다시 확인한 뒤 저장할 수 있습니다.',
  unknownKept: '계정 배치를 확인하지 못해 현재 배치를 이 브라우저에서 계속 사용합니다. 덮어쓸 계정 배치를 확인하기 전에는 저장 요청을 보내지 않습니다.',
  deniedLost: '계정 배치 접근이 거절되어 현재 변경은 이 창에만 남으며 새로고침하면 사라집니다. 계정 배치 접근을 다시 확인하기 전에는 저장 요청을 보내지 않습니다.',
  recheckDenied: '이 브라우저의 배치를 유지하며 계정 배치 접근을 다시 확인합니다.',
  different: '계정 배치와 현재 배치가 다르며, Save to Account는 계정본을 교체하고 Load from Account는 현재 배치를 교체합니다.',
  writeUnknown: '계정 저장 결과를 확인하지 못했으며 현재 배치는 유지합니다.',
};

function element(extra = {}) {
  const listeners = {};
  return Object.assign({ style: {}, title: '', textContent: '', listeners, offsetWidth: 300, offsetHeight: 200,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
    // A disabled button takes no click, as in a browser.
    click() { if (!this.disabled) for (const fn of listeners.click || []) fn(); } }, extra);
}

function memoryStorage(map = new Map()) {
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

/** One page: the panel, the server's answers (a queue; each a function of the request), and what was sent. */
function page({ answers = [], local = LOCAL, kept = true, storage = memoryStorage() } = {}) {
  const sent = [], applied = [];
  const respond = async (url, init) => {
    const request = { url: String(url), method: (init?.method || 'GET').toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers || {}).entries()), body: init?.body ? JSON.parse(init.body) : null };
    sent.push(request);
    const next = answers.shift();
    if (!next) throw new Error('harness: no answer queued for ' + request.method);
    const out = await next(request);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(out.code ? { 'X-KIN-Auth-Code': out.code } : {}) } });
  };
  const buttons = ['save', 'load', 'clear'].map(action => element({ dataset: { action }, disabled: true,
    textContent: { save: 'Save to Account', load: 'Load from Account', clear: 'Reset Account Layout' }[action] }));
  const status = element(), panel = element(), summary = element();
  const menu = element({ open: false, querySelectorAll: () => buttons, querySelector: () => summary });
  const nodes = { '#workspace-server-menu': menu, '#workspace-server-status': status, '#workspace-server-panel': panel };
  const sandbox = { document: { querySelector: s => nodes[s] }, innerWidth: 1280, innerHeight: 800, sessionStorage: storage,
    setTimeout, clearTimeout, AbortController, JSON, Promise, Error, TypeError, Object, Array, Number, String };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
  harness.install(respond, sandbox);
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  let generation = 0;
  const model = { normalize: v => (v && typeof v === 'object' && !Array.isArray(v) && v.mode !== 'wrong' ? JSON.parse(JSON.stringify(v)) : null) };
  sandbox.KinWorkspaceRoaming.mount({ owner: OWNER, read: () => local, generation: () => generation, model,
    endpoint: '/api/workspace-layout', sessionEndpoint: '/api/me', localKept: () => kept,
    apply: state => { applied.push(state); generation++; return true; } });
  const [save, load, clear] = buttons;
  return { sent, applied, save, load, clear, status, storage, writes: () => sent.filter(r => r.method !== 'GET') };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const ok = (layout = LOCAL, revision = 3) => () => ({ status: 200, body: { owner: OWNER, revision, layout } });

const FAILED_READS = [
  ['denied (a refusal of this account)', () => ({ status: 403, body: { message: 'SYN denied' } }), S.deniedKept],
  ['temporary (an authentication request not accepted)', () => ({ status: 401, code: 'AUTH_TOKEN_INVALID', body: { code: 'AUTH_TOKEN_INVALID' } }), S.temporaryKept],
  ['unknown (a server failure)', () => ({ status: 500, body: { message: 'SYN failure' } }), S.unknownKept],
  ['unknown (no answer)', () => new TypeError('SYN network'), S.unknownKept],
  ['unknown (an answer that is not an account copy)', () => ({ status: 200, body: { owner: OWNER, revision: 4, layout: { mode: 'wrong' } } }), S.unknownKept],
];

test('a failed read keeps the local layout, says what it is without a word about writes, and sends no write until re-read', async () => {
  for (const [label, failure, sentence] of FAILED_READS) {
    const p = page({ answers: [ok(), failure] });
    await settle();
    assert.equal(p.save.disabled, false, label + ': the start confirmed the account copy');
    p.load.click();
    await settle();
    assert.equal(p.status.textContent, sentence, label);
    assert.ok(!p.status.textContent.includes('쓰기는'), label + ': a read says nothing about a write');
    assert.deepEqual([p.save.disabled, p.clear.disabled, p.load.disabled, p.load.textContent], [true, true, false, 'Retry'], label);
    assert.deepEqual(p.applied, [], label + ': the local layout stays');
    // Save and Reset take no click; even a forced run sends nothing (the revision they would replace is unknown).
    p.save.click(); p.clear.click();
    for (const button of [p.save, p.clear]) for (const fn of button.listeners.click) fn();
    await settle();
    assert.deepEqual(p.writes(), [], label + ': no PUT or DELETE while the account copy is not known');
    // The sentence is said once and stays: a later edit does not repeat it or change it.
    assert.equal(p.status.textContent, sentence, label);
  }
  // A local layout this browser could not keep is not promised to stay.
  const p = page({ answers: [ok(), FAILED_READS[0][1]], kept: false });
  await settle();
  p.load.click();
  await settle();
  assert.equal(p.status.textContent, S.deniedLost);
});

test('Retry reads without changing the screen; a confirmed copy gives Save back and says when it differs', async () => {
  const p = page({ answers: [ok(), FAILED_READS[0][1], ok(OTHER, 7), ok(LOCAL, 9)] });
  await settle();
  p.load.click();
  await settle();
  assert.equal(p.load.textContent, 'Retry');
  p.load.click();
  await settle();
  assert.deepEqual([p.applied, p.status.textContent], [[], S.different], 'Retry never applies: it says the two differ');
  assert.deepEqual([p.save.disabled, p.clear.disabled, p.load.textContent], [false, false, 'Load from Account']);
  assert.deepEqual(p.sent.map(r => r.method), ['GET', 'GET', 'GET'], 'Retry is a read');
  // The chosen Load replaces the current layout with the account copy, as before.
  p.load.click();
  await settle();
  assert.deepEqual(p.applied, [LOCAL]);
});

test('a reload after a failure re-checks with the decided sentence and a confirmed copy forgets the failure', async () => {
  const storage = memoryStorage();
  const first = page({ answers: [ok(), FAILED_READS[0][1]], storage });
  await settle();
  first.load.click();
  await settle();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const second = page({ answers: [() => held], storage });
  await settle();
  assert.deepEqual([second.status.textContent, second.load.textContent, second.save.disabled], [S.recheckDenied, 'Retry', true]);
  release({ status: 200, body: { owner: OWNER, revision: 5, layout: LOCAL } });
  await settle();
  assert.deepEqual([second.status.textContent, second.load.textContent, second.save.disabled, second.applied],
    ['계정 배치를 다시 확인했습니다. 현재 배치와 같습니다.', 'Load from Account', false, []]);
  assert.equal([...storage.map.keys()].length, 0, 'the failure is forgotten once the copy is confirmed');
});

// (The session transport puts X-KIN-CSRF on every request it sends; the server checks it on writes only - the e2e
// roam_04 sets a write without it against the real guard. Here: a read is a GET without a body.)
test('the ordinary path asks nothing extra: a read is a plain GET, a save carries the CSRF header and its revision', async () => {
  const p = page({ answers: [ok(null, 2), () => ({ status: 200, body: { owner: OWNER, revision: 3, layout: LOCAL } }), ok(OTHER, 3)] });
  await settle();
  assert.equal(p.status.textContent, '계정에 저장한 배치가 없습니다. 현재 창의 배치를 유지합니다.');
  p.save.click();
  await settle();
  assert.equal(p.status.textContent, '현재 배치를 계정에 저장했습니다.');
  p.load.click();
  await settle();
  const [read, write] = p.sent;
  assert.deepEqual([read.method, read.headers['content-type'], read.body], ['GET', undefined, null]);
  assert.deepEqual([write.method, write.headers['x-kin-csrf'], write.body.revision, write.body.layout], ['PUT', '1', 2, LOCAL]);
  assert.deepEqual([p.applied, p.load.textContent], [[OTHER], 'Load from Account']);
});

test('a refused save is that save\'s refusal; only a save whose answer is lost or not known says its result is not known', async () => {
  for (const [label, answer, sentence] of [
    ['denied', () => ({ status: 403, body: { message: 'SYN denied' } }), '계정 배치 저장이 거절되었습니다. 현재 배치는 유지합니다.'],
    ['csrf refused', () => ({ status: 403, code: 'AUTH_CSRF_REQUIRED', body: { code: 'AUTH_CSRF_REQUIRED' } }),
      '저장 요청이 받아들여지지 않았습니다. 현재 배치는 유지합니다. 다시 저장하세요.'],
    ['conflict', () => ({ status: 409, body: { message: 'SYN conflict' } }), '다른 창에서 서버 배치가 변경되었습니다. 불러온 뒤 다시 시도하세요.'],
    ['server failure', () => ({ status: 502, body: { message: 'SYN gateway' } }), S.writeUnknown],
    ['answer lost', () => new TypeError('SYN network'), S.writeUnknown],
  ]) {
    const p = page({ answers: [ok(), answer] });
    await settle();
    p.save.click();
    await settle();
    assert.equal(p.status.textContent, sentence, label);
    assert.ok(!p.status.textContent.includes('불러와 확인'), label);
    assert.deepEqual([p.applied, p.load.textContent], [[], 'Load from Account'], label + ': a write failure is not a failed read');
  }
});
