'use strict';
/* TEST-S2B-PURE-TARGET / -RESULT / -LIST / -ADAPTER (REQ-S2B-LIST, REQ-S2B-COMMAND, REQ-S2B-BOUNDARY).
 * Production code only: finding-command.js directly, and the shipped reading-findings.js together with
 * finding-link-model.js, viewer-windows.js and finding-command.js inside a vm "worklist" realm whose
 * viewer documents are separate vm realms (cross-realm results, functions and documents). Synthetic
 * parts: a small fake DOM, the list transport, timers and the viewer exports' behaviour. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const command = require('../worklist-v0/hpacs-lite/finding-command.js');
const links = require('../worklist-v0/hpacs-lite/finding-link-model.js');
const HP = path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite');
const shipped = name => fs.readFileSync(path.join(HP, name), 'utf8');

const ORIGIN = 'https://pacs.test';
const X = '1.2.840.10', B = '1.2.840.20', P = '1.2.840.30', SERIES = '1.2.840.10.1', SOP = '1.2.840.10.1.1', SOP2 = '1.2.840.10.1.2';
const OWNER = '["hallym","sub-a"]', SUB = 'sub-a';
const ID1 = 'aaaaaaaa-0000-4000-8000-000000000001', ID2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ITEM1 = 'bbbbbbbb-0000-4000-8000-000000000001', ITEM2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const CURSOR = 'cccccccc-0000-4000-8000-000000000001', CURSOR2 = 'cccccccc-0000-4000-8000-000000000002';
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
const plain = value => JSON.parse(JSON.stringify(value === undefined ? null : value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function source(extra) {
  return Object.assign({ itemId: ITEM1, revision: 1, studyUid: X, kind: 'length', seriesUid: SERIES, sopUid: SOP, frame: 1, frameOfReferenceUid: '1.2.3',
    label: '길이', values: [20], calculator: 'kin-native-manual-v1', sourceDigest: 'digest', authorActor: 'Doctor A' }, extra);
}
function finding(extra, sources) {
  const s = sources || [source(), source({ itemId: ITEM2, kind: 'key', sopUid: SOP2, label: '키 영상', values: null, revision: 2 })];
  return Object.assign({ id: ID1, studyUid: X, authorSub: SUB, authorActor: 'Doctor A', revision: 1, createdAt: '2026-09-17T01:02:03.000Z', hidden: false,
    updatedAt: '2026-09-17T01:02:03.000Z', item: { schemaVersion: 1, title: '결절 <img src=x onerror=alert(1)>', text: '본문\n둘째 줄', hidden: false, primary: 0, sources: s },
    links: s.map(x => ({ itemId: x.itemId, linkState: 'current', headRevision: x.revision, headHidden: false })) }, extra);
}
const page = (items, nextCursor = null) => ({ items, nextCursor });

/* ---------- texts ---------- */
test('every worklist and viewer reason has Korean text; superseded and timeout never promise an unchanged display', () => {
  for (const reason of [...command.LOCAL_REASONS, ...links.NAVIGATION_REASONS]) assert.ok(command.reasonText(reason).length > 10, reason);
  for (const reason of ['superseded', 'timeout']) {
    const text = command.reasonText(reason);
    assert.ok(text.includes('이미 이동했을 수 있으니'), reason);
    assert.ok(!/취소했|바뀌지 않|유지했/.test(text), reason);
  }
  assert.equal(command.reasonText('scope').includes('영상 칸을 선택'), true);
  assert.equal(command.reasonText('series-missing'), links.reasonText('series-missing'), 'viewer texts are reused');
  assert.deepEqual([...links.NAVIGATION_REASONS].filter(r => !command.retryable(r)), ['invalid']);
  assert.deepEqual(['foreign', 'list-changed'].map(command.retryable), [false, false]);
  assert.deepEqual(command.LOCAL_REASONS.filter(command.openable).sort(), ['no-viewer', 'unattached']);
  assert.equal(command.arrivalText({ ok: true, highlighted: true, annotation: 'shown' }, '영상 창 2'), '영상 이동 확인 · 영상 창 2');
  assert.equal(command.arrivalText({ ok: true, highlighted: false, annotation: 'hidden' }, '통합 작업공간'), '영상 이동 확인 · 통합 작업공간 · ' + links.annotationText('hidden'));
  for (const reason of ['loading', 'ambiguous', 'unattached', 'no-viewer', 'owner'])
    assert.ok(command.readinessText({ kind: 'refused', reason }).length > 5, reason);
  assert.equal(command.readinessText({ kind: 'window', index: 1 }), '이동 대상: 영상 창 2');
});

/* ---------- rows ---------- */
test('a server item becomes a plain read-only row with DB link states and frozen values, never a Verified label', () => {
  const states = ['current', 'revised', 'hidden', 'missing'];
  const sources = states.map((state, i) => source({ itemId: 'bbbbbbbb-0000-4000-8000-00000000000' + (i + 1), frame: i + 1, values: i ? null : [20, 3.14159] }));
  const item = finding({ links: sources.map((s, i) => ({ itemId: s.itemId, linkState: states[i], headRevision: i === 1 ? 4 : s.revision, headHidden: i === 2 })) }, sources);
  item.item.primary = 1;
  const row = command.rowOf(item, X);
  assert.deepEqual(row.sources.map(s => [s.linkState, s.linkLabel]), states.map(s => [s, links.LINK_LABELS[s]]));
  assert.ok(row.sources.every(s => s.linkText === links.sourceStatus(s, { linkState: s.linkState }, null).text));
  assert.equal(row.sources[1].headRevision, 4);
  assert.equal(row.sources[0].description, 'Length · 길이 · 프레임 1 · r1 · 20.0 / 3.1');
  assert.equal(row.primary, 1); assert.equal(row.title, item.item.title); assert.equal(row.author, 'Doctor A');
  assert.match(row.updated, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(command.timeText('not a date'), '시각 미확인'); assert.equal(command.timeText(null), '시각 미확인');
  assert.ok(!JSON.stringify(row).includes('Verified') && !JSON.stringify(row).includes('Unverified'));
  assert.ok(row.sources.every(s => s.foreign === false));
  // A link row that is absent reads Missing; a source of another study is flagged, not substituted.
  const orphan = command.rowOf(finding({ links: [] }, [source({ studyUid: B })]), X);
  assert.deepEqual([orphan.sources[0].linkState, orphan.sources[0].foreign, orphan.sources[0].studyUid], ['missing', true, B]);
  const key = command.rowOf(finding({}, [source({ kind: 'key', label: '키', values: null })]), X).sources[0];
  assert.equal(key.description, 'Key Image · 키 · 프레임 1 · r1');
  const broken = [
    finding({ studyUid: B }), finding({ id: 'nope' }), finding({ revision: 0 }), finding({ hidden: 'false' }),
    finding({}, []), finding({}, Array.from({ length: 9 }, (_, i) => source({ itemId: 'bbbbbbbb-0000-4000-8000-0000000001' + String(i).padStart(2, '0') }))),
    finding({}, [source({ frame: 0 })]), finding({}, [source({ sopUid: 'x' })]), finding({}, [source({ values: ['1'] })]), finding({}, [source({ label: 7 })]),
    Object.assign(finding(), { item: { title: 't', text: 't', primary: 3, sources: [source()] } }), null,
  ];
  for (const bad of broken) assert.throws(() => command.rowOf(bad, X), undefined, JSON.stringify(bad)?.slice(0, 80));
});

/* ---------- list store ---------- */
function lister() {
  const calls = [], queue = [];
  let changes = 0;
  const store = command.createListStore({ fetch: p => { const d = deferred(); calls.push(p); queue.push(d); return d.promise; }, changed: () => { changes++; } });
  return { store, calls, queue, changes: () => changes, s: () => store.state() };
}

test('list: one context, exact read path, paging, Show Hidden and a reload that keeps rows until its answer', async () => {
  const l = lister();
  assert.equal(await l.store.load(), false, 'no context, no request'); assert.equal(l.calls.length, 0);
  assert.equal(l.store.context(OWNER, X), true); assert.equal(l.store.context(OWNER, X), false);
  assert.deepEqual([l.s().status, l.s().rows], ['idle', []]);
  const loading = l.store.load();
  assert.equal(l.s().status, 'loading');
  assert.deepEqual(l.calls, ['/studies/1.2.840.10/findings?includeHidden=false&limit=100']);
  l.queue[0].resolve(page([finding()], CURSOR)); await flush();
  assert.equal(l.calls[1], '/studies/1.2.840.10/findings?includeHidden=false&limit=100&cursor=' + CURSOR);
  const hidden = finding({ id: ID2, hidden: true });
  l.queue[1].resolve(page([hidden])); assert.equal(await loading, true);
  assert.deepEqual(l.s().rows.map(r => r.id), [ID1], 'a hidden item is not shown without Show Hidden');
  assert.equal(l.s().status, 'ready'); assert.ok(l.s().message.startsWith('1개 소견'));
  const shown = l.s().rows;
  // Reload of the same context keeps the rows until its answer, then replaces them.
  const reload = l.store.load();
  assert.equal(l.s().status, 'reloading'); assert.equal(l.s().rows, shown);
  l.queue[2].resolve(page([])); assert.equal(await reload, true);
  assert.deepEqual([l.s().rows, l.s().message], [[], '이 검사에 표시할 소견이 없습니다.']);
  // Show Hidden starts a new read; an older in-flight read is dropped.
  const stale = l.store.load();
  const withHidden = l.store.includeHidden(true);
  assert.equal(l.calls[4], '/studies/1.2.840.10/findings?includeHidden=true&limit=100');
  l.queue[4].resolve(page([finding(), hidden])); assert.equal(await withHidden, true);
  l.queue[3].resolve(page([])); assert.equal(await stale, false);
  assert.deepEqual(l.s().rows.map(r => [r.id, r.hidden]), [[ID1, false], [ID2, true]]);
  assert.equal(l.store.includeHidden(true), false, 'unchanged toggle does not read');
  assert.equal(l.calls.length, 5);
});

test('list: A-B-A selection, owner change and session end drop late pages; rows never belong to another context', async () => {
  const l = lister();
  l.store.context(OWNER, X); const first = l.store.load();
  l.store.context(OWNER, B); assert.deepEqual(l.s().rows, []); const other = l.store.load();
  l.store.context(OWNER, X); const again = l.store.load();
  l.queue[2].resolve(page([finding({ id: ID2 })])); assert.equal(await again, true);
  const rows = l.s().rows;
  l.queue[0].resolve(page([finding()])); assert.equal(await first, false);
  l.queue[1].resolve(page([finding({ studyUid: B })])); assert.equal(await other, false);
  assert.equal(l.s().rows, rows); assert.deepEqual(rows.map(r => r.id), [ID2]);
  // Another account: rows go at once, the late page is dropped.
  const late = l.store.load();
  assert.equal(l.store.context('["hallym","sub-b"]', X), true); assert.deepEqual(l.s().rows, []);
  l.queue[3].resolve(page([finding()])); assert.equal(await late, false); assert.deepEqual(l.s().rows, []);
  // Session end: cleared, later reads refused without a request.
  const pending = l.store.load();
  l.store.end();
  assert.deepEqual([l.s().status, l.s().rows, l.s().uid, l.s().owner], ['ended', [], null, null]);
  l.queue[4].resolve(page([finding()])); assert.equal(await pending, false); assert.deepEqual(l.s().rows, []);
  assert.equal(l.store.context(OWNER, X), false); assert.equal(await l.store.load(), false); assert.equal(l.store.includeHidden(false), false);
  assert.equal(l.calls.length, 5);
  assert.equal(l.store.context(OWNER, 'not-a-uid'), false, 'ended store stays ended');
  const fresh = lister(); assert.equal(fresh.store.context(OWNER, 'not-a-uid'), false, 'an invalid selection is no context');
  assert.equal(fresh.store.context('', X), false);
});

test('list: 401 ends, 403/404 deny and 503/network/invalid pages fail; each clears previously shown rows and never shows a partial list', async () => {
  const outcomes = [
    [{ status: 403 }, 'denied'], [{ status: 404 }, 'denied'], [{ status: 503 }, 'failed'], [new TypeError('network'), 'failed'],
    [page([finding()], CURSOR), 'failed', page([finding({ id: ID2 })], CURSOR)], // repeated cursor
    [page([finding()], 'not-a-cursor'), 'failed'],
    [page([finding({ studyUid: B })]), 'failed'],
    [page([finding(), { id: ID2 }]), 'failed'],
    [{ items: 'x' }, 'failed'], [null, 'failed'],
    [page(Array.from({ length: 100 }, () => finding()), CURSOR), 'failed', page(Array.from({ length: 100 }, () => finding()), CURSOR2), page(Array.from({ length: 57 }, () => finding()))],
  ];
  for (const [answer, status, ...more] of outcomes) {
    const l = lister();
    l.store.context(OWNER, X); const ok = l.store.load(); l.queue[0].resolve(page([finding()])); await ok;
    assert.equal(l.s().rows.length, 1);
    const reading = l.store.load();
    const answers = [answer, ...more];
    for (let i = 0; i < answers.length; i++) {
      await flush();
      const d = l.queue[1 + i]; assert.ok(d, 'request ' + i + ' for ' + status);
      if (answers[i] instanceof Error || (answers[i] && answers[i].status)) d.reject(answers[i]); else d.resolve(answers[i]);
    }
    assert.equal(await reading, false);
    assert.deepEqual([l.s().status, l.s().rows, l.s().loading], [status, [], false], JSON.stringify(answer)?.slice(0, 60));
    assert.ok(l.s().message.includes('지웠습니다'));
  }
  const l = lister();
  l.store.context(OWNER, X); const unauthorized = l.store.load(); l.queue[0].reject({ status: 401 });
  assert.equal(await unauthorized, false);
  assert.deepEqual([l.s().status, l.s().ended, l.s().rows], ['ended', true, []]);
  // 256 findings over three pages is the bound, not an error.
  const bound = lister();
  bound.store.context(OWNER, X); const full = bound.store.load();
  const many = n => Array.from({ length: n }, (_, i) => finding({ id: 'aaaaaaaa-0000-4000-8000-' + String(i).padStart(12, '0') }));
  bound.queue[0].resolve(page(many(100), CURSOR)); await flush();
  bound.queue[1].resolve(page(many(100), CURSOR2)); await flush();
  bound.queue[2].resolve(page(many(56))); assert.equal(await full, true); assert.equal(bound.s().rows.length, 256);
});

/* ---------- target choice ---------- */
const ws = extra => Object.assign({ active: true, sameTarget: true, loaded: true, inert: false, hidden: false, studies: [X] }, extra);
const win = extra => Object.assign({ index: 0, attached: true, closed: false, pending: false, ready: true, owner: 'match', studies: [X] }, extra);
test('target: embedded first, exactly one attached ready owner-matched window, otherwise an explicit refusal without side effects', () => {
  const cases = [
    [{ workspace: ws(), windows: [win()] }, { kind: 'embedded' }],
    [{ workspace: ws({ loaded: false }), windows: [win()] }, { kind: 'refused', reason: 'loading' }],
    [{ workspace: ws({ inert: true }), windows: [win()] }, { kind: 'refused', reason: 'loading' }],
    [{ workspace: ws({ hidden: true }), windows: [] }, { kind: 'refused', reason: 'loading' }],
    [{ workspace: ws({ active: false }), windows: [win({ index: 2 })] }, { kind: 'window', index: 2 }],
    [{ workspace: ws({ sameTarget: false }), windows: [] }, { kind: 'refused', reason: 'no-viewer' }],
    [{ workspace: ws({ studies: [B] }), windows: [win({ studies: [P, X], index: 1 })] }, { kind: 'window', index: 1 }],
    [{ workspace: null, windows: [] }, { kind: 'refused', reason: 'no-viewer' }],
    [{ windows: [win(), win({ index: 1 })] }, { kind: 'refused', reason: 'ambiguous' }],
    [{ windows: [win(), win({ index: 1, pending: true })] }, { kind: 'refused', reason: 'ambiguous' }],
    [{ windows: [win(), win({ index: 1, attached: false })] }, { kind: 'refused', reason: 'ambiguous' }],
    [{ windows: [win({ attached: false }), win({ index: 1, attached: false })] }, { kind: 'refused', reason: 'ambiguous' }],
    [{ windows: [win({ pending: true })] }, { kind: 'refused', reason: 'loading' }],
    [{ windows: [win({ ready: false })] }, { kind: 'refused', reason: 'loading' }],
    [{ windows: [win({ owner: 'other' })] }, { kind: 'refused', reason: 'owner' }],
    [{ windows: [win({ owner: 'other', ready: false })] }, { kind: 'refused', reason: 'owner' }],
    [{ windows: [win({ owner: 'unknown' })] }, { kind: 'refused', reason: 'loading' }],
    [{ windows: [win({ owner: 'other', pending: true })] }, { kind: 'refused', reason: 'loading' }],
    [{ windows: [win({ closed: true })] }, { kind: 'refused', reason: 'no-viewer' }],
    [{ windows: [win({ closed: true }), win({ index: 3, attached: false })] }, { kind: 'refused', reason: 'unattached', index: 3 }],
    [{ windows: [win({ studies: [B] }), win({ index: 1, studies: [B, P] })] }, { kind: 'refused', reason: 'no-viewer' }],
    [{ windows: [win({ studies: [B] }), win({ index: 1 })] }, { kind: 'window', index: 1 }],
    [{ windows: 'nope' }, { kind: 'refused', reason: 'no-viewer' }],
  ];
  for (const [snapshot, expected] of cases) {
    const input = freeze(Object.assign({ uid: X }, snapshot));
    assert.deepEqual(command.chooseTarget(input), expected, JSON.stringify(snapshot));
  }
  assert.deepEqual(command.chooseTarget({ uid: 'x', windows: [win()] }), { kind: 'refused', reason: 'invalid' });
  assert.deepEqual(command.chooseTarget(null), { kind: 'refused', reason: 'invalid' });
});

/* ---------- pre-call and identity ---------- */
const REF = {}, WIN = {}, DOC = {};
const expected = Object.freeze({ owner: OWNER, sub: SUB, uid: X, generation: 3 });
const view = extra => Object.assign({ error: false, live: true, owner: OWNER, sub: SUB, uid: X, selection: X, generation: 3, kind: 'window', ref: REF, window: WIN,
  document: DOC, scope: X, attached: true, closed: false, visible: true, historyPresent: true, ended: false, suspended: false, subject: SUB,
  windowOwner: OWNER, modal: false, navigate: true }, extra);
test('pre-call refusal order: session, superseded, no-viewer, loading, tool, ended, owner, busy, modal', () => {
  const cases = [
    [view({ live: false }), 'session'], [null, 'session'],
    [view({ owner: '["x","y"]' }), 'superseded'], [view({ sub: 'b' }), 'superseded'], [view({ uid: B }), 'superseded'],
    [view({ selection: B }), 'superseded'], [view({ generation: 4 }), 'superseded'],
    [view({ error: true }), 'no-viewer'], [view({ closed: true }), 'no-viewer'], [view({ attached: false }), 'no-viewer'],
    [view({ scope: B }), 'no-viewer'], [view({ scope: null }), 'no-viewer'], [view({ scope: P + ',' + X }), null],
    [view({ visible: false }), 'loading'],
    [view({ historyPresent: false, ended: true }), 'tool-missing'],
    [view({ ended: true, subject: '' }), 'ended'],
    [view({ subject: 'sub-b' }), 'owner'], [view({ subject: null }), 'owner'],
    [view({ windowOwner: null }), 'owner'], [view({ windowOwner: '["hallym","sub-b"]' }), 'owner'],
    [view({ kind: 'embedded', windowOwner: null }), null],
    [view({ suspended: true }), 'busy'], [view({ modal: true }), 'modal'], [view({ navigate: false }), 'tool-missing'],
    [view(), null],
  ];
  for (const [value, reason] of cases) assert.equal(command.precheck(value, expected), reason, JSON.stringify(value));
  for (const bad of [null, { ...expected, owner: '' }, { ...expected, sub: null }, { ...expected, uid: 'x' }])
    assert.equal(command.precheck(view(), bad), 'session');
});

test('identity after the await: every session, target, document, scope and account fact must be unchanged', () => {
  assert.equal(command.sameIdentity(view(), view()), true);
  const changes = { kind: 'embedded', ref: {}, window: {}, document: {}, scope: X + ',' + P, owner: '["hallym","sub-b"]', sub: 'b', uid: B, selection: B,
    generation: 4, subject: 'other', windowOwner: null };
  for (const [key, value] of Object.entries(changes)) assert.equal(command.sameIdentity(view(), view({ [key]: value })), false, key);
  for (const flag of [{ live: false }, { closed: true }, { attached: false }, { visible: false }, { historyPresent: false }, { ended: true }, { suspended: true }, { error: true }])
    assert.equal(command.sameIdentity(view(), view(flag)), false, JSON.stringify(flag));
  assert.equal(command.sameIdentity(view({ error: true }), view()), false);
  assert.equal(command.sameIdentity(view(), null), false);
  // Modal/navigate availability after arrival is not an identity fact.
  assert.equal(command.sameIdentity(view(), view({ modal: true, navigate: false })), true);
});

test('result: only the exact viewer shape from any realm counts; everything else is invalid', () => {
  const other = code => vm.runInNewContext(code);
  assert.deepEqual(command.validResult(other('({ ok: true, highlighted: false, annotation: "hidden" })')), { ok: true, highlighted: false, annotation: 'hidden' });
  assert.deepEqual(command.validResult({ ok: true, highlighted: true, annotation: 'shown', extra: 1 }), { ok: true, highlighted: true, annotation: 'shown' });
  for (const reason of links.NAVIGATION_REASONS) assert.deepEqual(command.validResult(other(`({ ok: false, reason: ${JSON.stringify(reason)} })`)), { ok: false, reason });
  const invalid = [
    other('({ ok: true })'), other('({ ok: true, annotation: "shown" })'), { ok: true, highlighted: 'true', annotation: 'shown' },
    { ok: true, highlighted: true }, { ok: true, highlighted: true, annotation: 7 }, { ok: 'true', highlighted: true, annotation: 'shown' },
    { ok: 1, highlighted: true, annotation: 'shown' }, { ok: false }, { ok: false, reason: 'loading' }, { ok: false, reason: 'nope' },
    other('[]'), [], null, undefined, 7, 'ok', true,
    other('({ get ok() { throw new Error("gone"); } })'),
    new Proxy({}, { get() { throw new Error('revoked'); } }),
    { ok: true, get highlighted() { throw new Error('late'); }, annotation: 'shown' },
  ];
  invalid.forEach((value, index) => assert.deepEqual(command.validResult(value), { ok: false, reason: 'invalid' }, 'invalid case ' + index));
  const target = { studyUid: X, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: ITEM1 };
  assert.deepEqual(command.targetOf({ ...source(), extra: true }), target);
  for (const bad of [null, { ...source(), frame: 0 }, { ...source(), itemId: 'x' }, { ...source(), studyUid: '' }])
    assert.equal(command.targetOf(bad), null);
});

const ITEM3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const KEY_SOURCE = () => source({ itemId: ITEM2, kind: 'key', sopUid: SOP2, label: '키 영상', values: null, revision: 2 });
test('retry pin: list generation, finding id/revision/index and the source item and image identity; any difference is another source', () => {
  const row = command.rowOf(finding(), X), pin = command.pinSource(row, 0, 3);
  assert.deepEqual(plain(pin), { generation: 3, id: ID1, revision: 1, index: 0, itemId: ITEM1, sourceRevision: 1, studyUid: X, seriesUid: SERIES, sopUid: SOP, frame: 1 });
  assert.equal(Object.isFrozen(pin), true);
  const pinOf = (item, index = 0, generation = 3) => command.pinSource(command.rowOf(item, X), index, generation);
  assert.equal(command.samePin(pin, pinOf(finding())), true, 'an identical reloaded row keeps the pin');
  assert.equal(command.samePin(pin, pinOf(finding({ links: [{ itemId: ITEM1, linkState: 'revised', headRevision: 4, headHidden: false }] }))), true,
    'a DB link state is not image identity');
  const differ = other => Object.keys(pin).filter(key => pin[key] !== other[key]);
  const cases = [
    [command.pinSource(row, 0, 4), ['generation']],
    [command.pinSource(row, 1, 3), ['index', 'itemId', 'sourceRevision', 'sopUid']],
    [pinOf(finding({}, [source(), source()]), 1), ['index']],
    [pinOf(finding({ revision: 2 }, [KEY_SOURCE(), source()])), ['revision', 'itemId', 'sourceRevision', 'sopUid']],
    [pinOf(finding({}, [KEY_SOURCE(), source()])), ['itemId', 'sourceRevision', 'sopUid']],
    [pinOf(finding({ revision: 2 })), ['revision']],
    [pinOf(finding({ id: ID2 })), ['id']],
    [pinOf(finding({}, [source({ itemId: ITEM3 })])), ['itemId']],
    [pinOf(finding({}, [source({ revision: 2 })])), ['sourceRevision']],
    [pinOf(finding({}, [source({ studyUid: B })])), ['studyUid']],
    [pinOf(finding({}, [source({ seriesUid: '1.2.840.10.2' })])), ['seriesUid']],
    [pinOf(finding({}, [source({ sopUid: SOP2 })])), ['sopUid']],
    [pinOf(finding({}, [source({ frame: 2 })])), ['frame']],
  ];
  for (const [other, keys] of cases) {
    assert.deepEqual(differ(other), keys);
    assert.equal(command.samePin(pin, other), false, keys.join());
  }
  for (const [value, index] of [[null, 0], [row, 2], [row, -1], [row, '0'], [row, 0.5], [{ id: ID1, sources: 'x' }, 0], [{ id: ID1, sources: [null] }, 0]])
    assert.equal(command.pinSource(value, index, 3), null, JSON.stringify(index));
  assert.equal(command.samePin(null, pin), false); assert.equal(command.samePin(pin, undefined), false);
  assert.equal(command.samePin(pin, { ...pin }), true);
});

/* ---------- the command race ---------- */
function clock() {
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
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function job(o) {
  const log = [], announced = [];
  const state = { view: view(o && o.view), answer: o && 'answer' in o ? o.answer : Promise.resolve({ ok: true, highlighted: true, annotation: 'shown' }) };
  const choice = { kind: 'window', label: '영상 창 1',
    probe: () => { log.push('probe'); if (state.throwProbe) throw new Error('gone'); return { ...state.view }; },
    invoke: target => { log.push(['invoke', plain(target)]); if (state.throwInvoke) throw new Error('sync'); return state.answer; } };
  const value = {
    expected: o && o.expected || expected, source: o && 'source' in o ? o.source : source(),
    choose: () => { log.push('choose'); if (o && o.chooseThrows) throw new Error('boom'); return o && 'choice' in o ? o.choice : choice; },
    announce: (result, picked) => announced.push({ result: plain(result), label: picked ? picked.label : null }),
  };
  return { value, log, announced, state, choice };
}
const invoked = log => log.filter(x => Array.isArray(x) && x[0] === 'invoke').length;

test('command: every refusal is decided before the viewer is called; a foreign source is refused before choosing a target', async () => {
  const nav = command.createNavigator({ ...clock() });
  const cases = [
    [{ expected: { ...expected, owner: null } }, 'session', []],
    [{ source: null }, 'list-changed', []],
    [{ source: { ...source(), frame: 0 } }, 'invalid', []],
    [{ source: source({ studyUid: B }) }, 'foreign', []],
    [{ chooseThrows: true }, 'no-viewer', ['choose']],
    [{ choice: { kind: 'refused', reason: 'ambiguous' } }, 'ambiguous', ['choose']],
    [{ choice: { kind: 'refused', reason: 'unattached', index: 1 } }, 'unattached', ['choose']],
    [{ choice: null }, 'no-viewer', ['choose']],
    [{ view: { modal: true } }, 'modal', ['choose', 'probe']],
    [{ view: { subject: 'other' } }, 'owner', ['choose', 'probe']],
    [{ view: { navigate: false } }, 'tool-missing', ['choose', 'probe']],
    [{ view: { selection: B } }, 'superseded', ['choose', 'probe']],
  ];
  for (const [options, reason, log] of cases) {
    const j = job(options);
    const result = await nav.run(j.value);
    assert.deepEqual(result, { ok: false, reason, latest: true }, reason);
    assert.deepEqual(j.log, log, reason);
    assert.deepEqual(j.announced.map(a => a.result), [{ ok: false, reason }], reason);
  }
  const thrown = job(); thrown.state.throwProbe = true;
  assert.equal((await nav.run(thrown.value)).reason, 'session', 'an unreadable target is never called');
  assert.equal(invoked(thrown.log), 0);
});

test('command: the last probe and the call share one tick, the call carries the frozen source identity, and success is announced in the tick of the final check', async () => {
  const c = clock(), nav = command.createNavigator(c);
  const j = job();
  let tick = 0;
  const probe = j.choice.probe;
  j.choice.probe = () => { const v = probe(); if (j.log.filter(x => x === 'probe').length === 2) queueMicrotask(() => { tick++; }); return v; };
  j.value.announce = (result, picked) => { j.announced.push({ result: plain(result), label: picked.label, tick }); };
  const running = nav.run(j.value);
  assert.deepEqual(j.log, ['choose', 'probe', ['invoke', { studyUid: X, seriesUid: SERIES, sopUid: SOP, frame: 1, itemId: ITEM1 }]], 'checked and called synchronously');
  const result = await running;
  assert.deepEqual(result, { ok: true, highlighted: true, annotation: 'shown', latest: true });
  assert.deepEqual(j.announced, [{ result: { ok: true, highlighted: true, annotation: 'shown' }, label: '영상 창 1', tick: 0 }]);
  assert.equal(c.pending(), 0, 'no timer survives the command');
});

test('command: a change of target, document, scope, account or selection during the await is superseded even when the viewer answered ok', async () => {
  const changes = [{ document: {} }, { ref: {} }, { window: {} }, { scope: B }, { closed: true }, { attached: false }, { visible: false },
    { windowOwner: null }, { subject: 'other' }, { ended: true }, { suspended: true }, { historyPresent: false }, { live: false },
    { owner: '["hallym","sub-b"]' }, { selection: B }, { uid: B }, { generation: 9 }, { error: true }];
  for (const change of changes) {
    const c = clock(), nav = command.createNavigator(c), d = deferred(), j = job({ answer: d.promise });
    const running = nav.run(j.value);
    Object.assign(j.state.view, change);
    d.resolve({ ok: true, highlighted: true, annotation: 'shown' });
    assert.deepEqual(await running, { ok: false, reason: 'superseded', latest: true }, JSON.stringify(change));
    assert.deepEqual(j.announced.map(a => a.result.reason), ['superseded']);
    assert.equal(c.pending(), 0);
  }
  const c = clock(), nav = command.createNavigator(c), d = deferred(), j = job({ answer: d.promise });
  const running = nav.run(j.value); j.state.throwProbe = true; d.resolve({ ok: true, highlighted: true, annotation: 'shown' });
  assert.equal((await running).reason, 'superseded', 'an unreadable document after the await is not success');
});

test('command: a closed or replaced target settles early; no answer within 15 s is a timeout; late answers change nothing', async () => {
  {
    const c = clock(), nav = command.createNavigator(c), j = job({ answer: new Promise(() => {}) });
    const running = nav.run(j.value);
    await c.advance(250); assert.equal(j.announced.length, 0, 'unchanged target keeps waiting');
    j.state.view.closed = true;
    await c.advance(250);
    assert.deepEqual(await running, { ok: false, reason: 'superseded', latest: true });
    assert.equal(c.pending(), 0);
  }
  {
    const c = clock(), nav = command.createNavigator(c), d = deferred(), j = job({ answer: d.promise });
    const running = nav.run(j.value);
    await c.advance(14999); assert.equal(j.announced.length, 0);
    await c.advance(1);
    assert.deepEqual(await running, { ok: false, reason: 'timeout', latest: true });
    assert.equal(c.pending(), 0);
    d.resolve({ ok: true, highlighted: true, annotation: 'shown' }); await flush();
    assert.deepEqual(j.announced.map(a => a.result.reason), ['timeout']);
  }
  {
    const c = clock(), nav = command.createNavigator(c), d = deferred(), j = job({ answer: d.promise });
    const running = nav.run(j.value);
    await c.advance(14999); j.state.view.document = {}; await c.advance(1);
    assert.equal((await running).reason, 'superseded', 'a replaced document wins over the timeout text');
    d.resolve({ ok: true, highlighted: true, annotation: 'shown' });
  }
});

test('command: thrown, rejected and malformed answers are never success; only the latest command announces; cancel drops the rest', async () => {
  const c = clock(), nav = command.createNavigator(c);
  const thrown = job(); thrown.state.throwInvoke = true;
  assert.deepEqual(await nav.run(thrown.value), { ok: false, reason: 'tool-missing', latest: true });
  assert.deepEqual(await nav.run(job({ answer: Promise.reject(new Error('x')) }).value), { ok: false, reason: 'tool-missing', latest: true });
  assert.deepEqual(await nav.run(job({ answer: { ok: true, highlighted: 'yes', annotation: 'shown' } }).value), { ok: false, reason: 'invalid', latest: true });
  assert.deepEqual(await nav.run(job({ answer: { ok: false, reason: 'scope' } }).value), { ok: false, reason: 'scope', latest: true });
  assert.deepEqual(await nav.run(job({ answer: { then: resolve => resolve({ ok: false, reason: 'viewport-unsupported' }) } }).value), { ok: false, reason: 'viewport-unsupported', latest: true });
  // Two commands in flight: the older one never writes, even when it answers ok after the newer one.
  const d1 = deferred(), d2 = deferred(), first = job({ answer: d1.promise }), second = job({ answer: d2.promise });
  const a = nav.run(first.value), b = nav.run(second.value);
  d2.resolve({ ok: true, highlighted: false, annotation: 'key' });
  assert.deepEqual(await b, { ok: true, highlighted: false, annotation: 'key', latest: true });
  d1.resolve({ ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(await a, { ok: false, reason: 'superseded', latest: false });
  assert.equal(first.announced.length, 0); assert.equal(second.announced.length, 1);
  // A selection change or session end cancels the command in flight.
  const d3 = deferred(), third = job({ answer: d3.promise });
  const running = nav.run(third.value); nav.cancel();
  d3.resolve({ ok: true, highlighted: true, annotation: 'shown' });
  assert.deepEqual(await running, { ok: false, reason: 'superseded', latest: false });
  assert.equal(third.announced.length, 0);
  assert.equal(c.pending(), 0);
});

/* ---------- the shipped DOM adapter in a worklist realm ---------- */
class FakeElement extends EventTarget {
  constructor(tag, doc) {
    super(); this.tagName = tag; this.ownerDocument = doc; this.children = []; this.parent = null; this.dataset = {}; this.attributes = {};
    this.hidden = false; this.disabled = false; this.id = ''; this.className = ''; this.ownText = '';
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this.ownText; }
  set textContent(value) { for (const c of this.children) c.parent = null; this.children = []; this.ownText = String(value); }
  append(...nodes) { for (const n of nodes) { if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.ownText = ''; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  contains(node) { for (let x = node; x; x = x.parent) if (x === this) return true; return false; }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function makeDocument() {
  const doc = {};
  doc.body = new FakeElement('body', doc); doc.activeElement = doc.body;
  doc.createElement = tag => new FakeElement(tag, doc);
  doc.createTextNode = value => { const n = new FakeElement('#text', doc); n.textContent = value; return n; };
  doc.querySelector = selector => doc.body.all().find(e => selector.startsWith('#') ? e.id === selector.slice(1) : e.className.split(' ').includes(selector.slice(1))) || null;
  return doc;
}
// A viewer document of its own realm: exports, history state, owner and modal state as in config/ohif.js.
function viewer(o) {
  const options = o || {};
  const ctx = vm.createContext({});
  vm.runInContext(`
    this.calls = []; this.modal = false; this.focused = 0; this.closed = false; this.gates = [];
    this.history = { scope: ${JSON.stringify(X)}, subject: ${JSON.stringify(SUB)}, ended: false, suspended: false };
    this.document = { querySelectorAll: () => this.modal ? [{ getClientRects: () => [{}] }] : [] };
    this.location = { href: ${JSON.stringify(options.href || ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + X + '#kin-window-slot=0')} };
    this.focus = () => { this.focused++; };
    this.hold = () => { this.holding = true; };
    this.release = value => { const gate = this.gates.shift(); gate(value === undefined ? { ok: true, highlighted: true, annotation: 'shown' } : value); };
    this.kinViewerHistoryState = () => ({ scope: this.history.scope, subject: this.history.subject, ended: this.history.ended, suspended: this.history.suspended, heads: [] });
    this.kinViewerHistoryNavigate = target => {
      this.calls.push(JSON.stringify(target));
      if (this.holding) return new Promise(resolve => this.gates.push(resolve));
      return Promise.resolve({ ok: true, highlighted: true, annotation: 'shown' });
    };
    ${options.owner === null ? '' : 'this.kinViewerWindowOwner = () => ' + JSON.stringify(options.owner || OWNER) + ';'}
  `, ctx);
  return ctx;
}
function worklist() {
  const channels = [], intervals = [], events = new EventTarget();
  class FakeChannel { constructor(name) { this.name = name; this.onmessage = null; channels.push(this); } postMessage() {} close() { this.closed = true; } }
  const document = makeDocument();
  const sandbox = { console, Event, URL, URLSearchParams, document, location: { origin: ORIGIN }, BroadcastChannel: FakeChannel, setTimeout, clearTimeout,
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval: id => { intervals[id - 1] = null; },
    addEventListener: (...a) => events.addEventListener(...a), removeEventListener: (...a) => events.removeEventListener(...a), dispatchEvent: e => events.dispatchEvent(e) };
  const ctx = vm.createContext(sandbox);
  vm.runInContext('this.window = this;', ctx);
  const region = document.createElement('div'); region.className = 'panel related-p';
  const tabs = document.createElement('div'); tabs.id = 'reltabs'; region.append(tabs); document.body.append(region);
  for (const name of ['finding-link-model.js', 'viewer-windows.js', 'finding-command.js', 'reading-findings.js']) vm.runInContext(shipped(name), ctx, { filename: name });
  const s = { selected: X, allowed: true, owner: OWNER, sub: SUB, target: null, rows: () => [], api: [], popups: [], opened: [],
    respond: p => Promise.resolve(p.includes(encodeURIComponent(X)) ? page([finding()]) : page([])) };
  const app = {
    current: () => s.selected, allowed: () => s.allowed, owner: () => s.owner, sub: () => s.sub,
    api: (method, p) => { s.api.push([method, p]); return s.respond(p); },
    workspace: { viewerTarget: () => typeof s.target === 'function' ? s.target() : s.target },
    windows: () => s.rows(), popup: (...args) => { s.popups.push(args); }, open: uid => { s.opened.push(uid); },
  };
  const ui = sandbox.KinReadingFindings(app);
  const all = () => document.body.all();
  const byId = id => all().find(e => e.id === id);
  const named = (scope, name) => scope.all().filter(e => e.tagName === 'button' && e.textContent === name);
  const h = {
    s, ui, document, sandbox, channels, byId, named,
    panel: () => byId('reading-findings'),
    articles: () => byId('reading-findings-list').children,
    result: () => byId('reading-findings-nav'),
    source: (id, index) => { const a = h.articles().find(e => e.dataset.findingId === id); const b = named(a.children.find(e => e.tagName === 'ul').children[index], 'Go to Image'); assert.equal(b.length, 1); return b[0]; },
    primary: id => named(h.articles().find(e => e.dataset.findingId === id), 'Go to Primary Image')[0],
    async open() { byId('reading-findings-open').click(); await flush(); },
    async click(el) { el.click(); await flush(); },
    tickReadiness() { for (const fn of intervals) if (fn) fn(); },
    embed(v, extra) {
      const frame = { contentWindow: v, focused: 0, focus() { this.focused++; } };
      s.target = () => Object.assign({ frame, window: v, document: v.document, href: v.location.href, studies: [X], active: true, sameTarget: true,
        loaded: true, inert: false, hidden: false }, typeof extra === 'function' ? extra() : extra);
      return frame;
    },
    windows(list) {
      s.rows = () => list().map(({ index, popup, pending = false, ready = true, href }) => {
        const where = href || (popup ? popup.location.href : null);
        return { index, popup: popup || null, pending, status: popup ? { kind: 'viewer', ready, href: where } : null,
          scope: sandbox.KinViewerWindows.scope(where, ORIGIN) };
      });
    },
  };
  return h;
}
const target = (studyUid = X, sopUid = SOP, itemId = ITEM1) => ({ studyUid, seriesUid: SERIES, sopUid, frame: 1, itemId });

test('adapter: the panel lists the selected study read-only with textContent, link states and Show Hidden, and writes nothing', async () => {
  const h = worklist();
  const toggle = h.byId('reading-findings-open');
  assert.equal(toggle.textContent, 'Image Findings'); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.panel().hidden, true); assert.equal(h.s.api.length, 0, 'nothing is read while closed');
  h.s.respond = p => Promise.resolve(p.includes('includeHidden=true') ? page([finding(), finding({ id: ID2, hidden: true, item: { ...finding().item, title: '숨긴 소견' } })]) : page([finding()]));
  await h.open();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(h.panel().hidden, false);
  assert.deepEqual(h.s.api, [['GET', '/studies/' + X + '/findings?includeHidden=false&limit=100']]);
  assert.equal(h.panel().dataset.studyUid, X); assert.equal(h.panel().dataset.state, 'ready');
  assert.equal(h.articles().length, 1);
  const article = h.articles()[0];
  assert.ok(article.textContent.includes('결절 <img src=x onerror=alert(1)>'), 'external text stays text');
  assert.ok(article.textContent.includes('Length · 길이 · 프레임 1 · r1 · 20.0'));
  assert.deepEqual(article.all().filter(e => e.dataset.kinLinkState).map(e => e.textContent), ['Current', 'Current']);
  assert.ok(!h.panel().textContent.includes('Verified'));
  assert.ok(h.panel().textContent.includes('영상 원본 확인 결과가 아닙니다'));
  for (const name of ['Save', 'Edit', 'Hide', 'Restore', 'New Finding', 'Refresh Link']) assert.equal(h.named(h.panel(), name).length, 0, name);
  assert.equal(h.named(article, 'Go to Image').length, 2); assert.equal(h.named(article, 'Go to Primary Image').length, 1);
  assert.ok(h.source(ID1, 0).getAttribute('aria-describedby').split(' ').every(id => h.byId(id)));
  const hidden = h.byId('reading-findings-hidden');
  hidden.checked = true; hidden.dispatchEvent(new Event('change')); await flush();
  assert.equal(h.s.api[1][1], '/studies/' + X + '/findings?includeHidden=true&limit=100');
  assert.deepEqual(h.articles().map(e => [e.dataset.findingId, e.dataset.hidden]), [[ID1, 'false'], [ID2, 'true']]);
  await h.click(h.named(h.panel(), 'Reload Findings')[0]);
  assert.equal(h.s.api.length, 3);
  assert.ok(h.s.api.every(([method]) => method === 'GET'), 'the list only reads');
  assert.equal(h.byId('reading-findings-target').dataset.target, 'no-viewer');
  assert.equal(h.byId('reading-findings-recovery').hidden, false, 'Open Image is offered when no viewer shows the study');
  // An offline or expired worklist session clears the rows on the next tick of the open panel.
  h.s.allowed = false; h.tickReadiness();
  assert.deepEqual([h.articles().length, h.panel().dataset.studyUid, h.byId('reading-findings-recovery').hidden], [0, '', true]);
  h.s.allowed = true; h.ui.sync(); await flush();
  assert.deepEqual(h.articles().map(e => e.dataset.findingId), [ID1, ID2]);
  // Escape and Close return focus to the toggle.
  const escape = new Event('keydown', { cancelable: true }); escape.key = 'Escape'; h.panel().dispatchEvent(escape);
  assert.equal(h.panel().hidden, true); assert.equal(h.document.activeElement, toggle);
});

test('adapter: Go to Image calls the embedded viewer function read at call time with the frozen source, then announces and focuses', async () => {
  const h = worklist(), v = viewer(), frame = h.embed(v);
  await h.open();
  assert.equal(h.byId('reading-findings-target').textContent, '이동 대상: 통합 작업공간 영상');
  const original = v.kinViewerHistoryNavigate, replaced = [];
  v.kinViewerHistoryNavigate = function (t) { replaced.push({ self: this === v, target: plain(t) }); return original(t); };
  await h.click(h.source(ID1, 1));
  assert.deepEqual(replaced, [{ self: true, target: target(X, SOP2, ITEM2) }], 'the function present at the click is the one called');
  assert.equal(h.result().textContent, '영상 이동 확인 · 통합 작업공간'); assert.equal(h.result().dataset.result, 'ok');
  assert.deepEqual([frame.focused, v.focused], [1, 1]);
  await h.click(h.primary(ID1));
  assert.deepEqual(JSON.parse(v.calls.at(-1)), target());
  // A key/hidden annotation answer from the viewer realm is shown with the S2-A text.
  v.kinViewerHistoryNavigate = () => vm.runInContext('Promise.resolve({ ok: true, highlighted: false, annotation: "hidden" })', v);
  await h.click(h.primary(ID1));
  assert.equal(h.result().textContent, '영상 이동 확인 · 통합 작업공간 · ' + links.annotationText('hidden'));
  // Loading, then a retry once ready.
  v.kinViewerHistoryNavigate = original;
  let loaded = false; h.embed(v, () => ({ loaded }));
  await h.click(h.source(ID1, 0));
  assert.equal(h.result().dataset.result, 'loading'); assert.equal(v.calls.length, 2);
  const retry = h.named(h.panel(), 'Retry Go to Image')[0];
  assert.equal(retry.hidden, false);
  loaded = true; await h.click(retry);
  assert.equal(h.result().dataset.result, 'ok'); assert.equal(v.calls.length, 3); assert.equal(retry.hidden, true);
});

test('adapter: a replaced document, scope, account, frame or hidden workspace during the await is never success nor focus', async () => {
  const changes = [
    (v, h, state) => { state.document = { querySelectorAll: () => [] }; },
    (v, h, state) => { state.studies = [B]; },
    (v, h, state) => { state.frame = { contentWindow: v, focus() {} }; },
    (v, h, state) => { state.active = false; },
    (v) => { v.history.subject = 'sub-b'; },
    (v) => { v.history.suspended = true; },
    (v, h) => { h.s.owner = '["hallym","sub-b"]'; },
    (v, h) => { h.s.target = null; },
  ];
  for (const change of changes) {
    const h = worklist(), v = viewer(), state = {};
    const frame = h.embed(v, () => state);
    await h.open(); v.hold();
    await h.click(h.source(ID1, 0));
    assert.equal(h.result().dataset.result, 'pending');
    change(v, h, state); v.release(); await flush();
    assert.ok(!h.result().textContent.includes('영상 이동 확인'), String(change));
    assert.ok(['superseded', ''].includes(h.result().dataset.result), String(change) + ' ' + h.result().dataset.result);
    assert.deepEqual([frame.focused, v.focused], [0, 0]);
    assert.equal(v.calls.length, 1);
  }
});

test('adapter: separate windows — one owner-matched window only; ambiguity, owner, modal, session and tool states refuse before any call', async () => {
  const h = worklist(), one = viewer(), two = viewer({ href: ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + P + ',' + X });
  let open = [{ index: 0, popup: one }];
  h.windows(() => open);
  await h.open();
  assert.equal(h.byId('reading-findings-target').textContent, '이동 대상: 영상 창 1');
  await h.click(h.source(ID1, 0));
  assert.deepEqual([h.result().textContent, one.focused, one.calls.length], ['영상 이동 확인 · 영상 창 1', 1, 1]);
  const refusals = [
    ['ambiguous', () => { open = [{ index: 0, popup: one }, { index: 2, popup: two }]; }],
    ['ambiguous', () => { open = [{ index: 0, popup: one }, { index: 1, href: ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + X }]; }],
    ['owner', () => { open = [{ index: 0, popup: viewer({ owner: '["hallym","sub-b"]' }) }]; }],
    ['loading', () => { open = [{ index: 0, popup: viewer({ owner: null }) }]; }],
    ['loading', () => { open = [{ index: 0, popup: one, ready: false }]; }],
    ['loading', () => { open = [{ index: 0, popup: one, pending: true }]; }],
    ['no-viewer', () => { open = [{ index: 0, popup: viewer({ href: ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + B }) }]; }],
    ['owner', () => { open = [{ index: 0, popup: one }]; one.history.subject = 'sub-b'; }],
    ['ended', () => { one.history.subject = ''; one.history.ended = true; }],
    ['busy', () => { one.history.ended = false; one.history.subject = SUB; one.history.suspended = true; }],
    ['modal', () => { one.history.suspended = false; one.modal = true; }],
    ['tool-missing', () => { one.modal = false; one.saved = one.kinViewerHistoryNavigate; delete one.kinViewerHistoryNavigate; }],
    ['tool-missing', () => { one.kinViewerHistoryNavigate = one.saved; one.savedState = one.kinViewerHistoryState; delete one.kinViewerHistoryState; }],
    ['session', () => { one.kinViewerHistoryState = one.savedState; h.s.allowed = false; }],
  ];
  const before = () => [one, two].map(v => v.calls.length);
  for (const [reason, arrange] of refusals) {
    arrange();
    const counts = before();
    h.ui.sync(); await flush();
    if (reason === 'session') {
      assert.equal(h.articles().length, 0, 'rows are removed when the session is not usable');
      assert.equal(h.panel().dataset.studyUid, '');
      break;
    }
    await h.click(h.source(ID1, 0));
    assert.equal(h.result().dataset.result, reason, reason);
    assert.equal(h.result().textContent, command.reasonText(reason));
    assert.deepEqual(before(), counts, reason + ': no viewer was called');
    assert.equal(one.focused, 1);
  }
});

test('adapter: a window closed, re-navigated or detached during the await is superseded; the newest command alone reports', async () => {
  for (const change of [v => { v.closed = true; }, v => { v.location.href = ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + B; },
    (v, list) => { list.length = 0; }, (v, list) => { list[0] = { index: 0, popup: v, pending: true }; }, v => { v.kinViewerWindowOwner = () => '["x","y"]'; }]) {
    const h = worklist(), v = viewer(), list = [{ index: 0, popup: v }];
    h.windows(() => list);
    await h.open(); v.hold();
    await h.click(h.source(ID1, 0));
    change(v, list); v.release(); await flush();
    assert.equal(h.result().dataset.result, 'superseded', String(change));
    assert.equal(v.focused, 0);
  }
  // Newest wins: the older answer arrives last and writes nothing.
  const h = worklist(), v = viewer();
  h.windows(() => [{ index: 0, popup: v }]);
  await h.open(); v.hold();
  await h.click(h.source(ID1, 0)); await h.click(h.source(ID1, 1));
  assert.equal(v.calls.length, 2);
  const [older, newer] = v.gates.splice(0, 2);
  newer({ ok: true, highlighted: false, annotation: 'key' }); await flush();
  const text = h.result().textContent;
  assert.equal(text, '영상 이동 확인 · 영상 창 1 · ' + links.annotationText('key'));
  older({ ok: true, highlighted: true, annotation: 'shown' }); await flush();
  assert.equal(h.result().textContent, text); assert.equal(v.focused, 1);
  // A window that closes while the viewer never answers settles early as superseded.
  v.gates.length = 0; v.kinViewerHistoryNavigate = () => new Promise(() => {});
  await h.click(h.source(ID1, 0));
  v.closed = true;
  await new Promise(resolve => setTimeout(resolve, 600)); await flush();
  assert.equal(h.result().dataset.result, 'superseded');
});

test('adapter: a comparison source without a viewer of both studies, an unattached window and no viewer never navigate; Open Image uses only the existing open paths', async () => {
  const h = worklist(), v = viewer();
  h.s.respond = () => Promise.resolve(page([finding({}, [source(), source({ itemId: ITEM2, studyUid: B })])]));
  h.windows(() => [{ index: 0, popup: v }]);
  await h.open();
  // S2-B2: a source of the row's one comparison study is labelled as such and goes only to a viewer of both studies.
  assert.ok(h.articles()[0].textContent.includes('비교 검사 영상(선택한 검사와 이 비교 검사를 함께 표시하는 화면으로만 이동)'));
  assert.deepEqual(h.articles()[0].all().filter(e => e.dataset.sourceStudy).map(e => e.dataset.sourceStudy), ['current', 'comparison']);
  await h.click(h.source(ID1, 1));
  assert.deepEqual([h.result().dataset.result, h.result().textContent, v.calls.length], ['comparison-viewer', command.reasonText('comparison-viewer'), 0]);
  assert.equal(h.named(h.panel(), 'Retry Go to Image')[0].hidden, false, 'the user may open both studies and retry');
  assert.equal(h.named(h.panel(), 'Open Image')[0].hidden, true, 'no automatic open for the comparison');
  // A reloaded worklist knows the window only by its announced address.
  h.windows(() => [{ index: 1, href: ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + X + ',' + P + '&initialSeriesInstanceUID=' + SERIES }]);
  await h.click(h.source(ID1, 0));
  assert.equal(h.result().dataset.result, 'unattached');
  const openImage = h.named(h.panel(), 'Open Image')[0];
  assert.equal(openImage.hidden, false);
  await h.click(openImage);
  assert.deepEqual(plain(h.s.popups), [[X, P, SERIES]]); assert.deepEqual(h.s.opened, []);
  assert.equal(h.result().dataset.result, 'opening'); assert.equal(v.calls.length, 0, 'no queued navigation');
  h.windows(() => []); h.tickReadiness();
  assert.equal(h.byId('reading-findings-target').dataset.target, 'no-viewer');
  await h.click(h.source(ID1, 0));
  assert.equal(h.result().dataset.result, 'no-viewer');
  await h.click(openImage);
  assert.deepEqual(h.s.opened, [X]); assert.equal(h.s.popups.length, 1); assert.equal(v.calls.length, 0);
  // Open Image does nothing when a target already exists.
  h.windows(() => [{ index: 0, popup: v }]); h.tickReadiness();
  assert.equal(openImage.hidden, true);
  await h.click(openImage); assert.deepEqual([h.s.opened.length, h.s.popups.length], [1, 1]);
});

test('adapter: selection A-B-A, 403/404/503 and session end clear rows and drop late lists and commands', async () => {
  const h = worklist(), v = viewer();
  h.embed(v);
  const lists = [];
  h.s.respond = p => { const d = deferred(); lists.push({ p, d }); return d.promise; };
  await h.open();
  lists[0].d.resolve(page([finding()])); await flush();
  assert.equal(h.articles().length, 1);
  v.hold(); await h.click(h.source(ID1, 0));
  // Selection change during the command: rows and message go at once; the late answer writes nothing.
  h.s.selected = B; h.ui.sync(); await flush();
  assert.deepEqual([h.articles().length, h.result().textContent, h.panel().dataset.studyUid], [0, '', B]);
  h.s.selected = X; h.ui.sync(); await flush();
  assert.equal(lists.length, 3);
  lists[2].d.resolve(page([finding({ id: ID2 })])); await flush();
  lists[1].d.resolve(page([finding({ id: ID1, studyUid: B })])); await flush();
  v.release(); await flush();
  assert.deepEqual(h.articles().map(e => e.dataset.findingId), [ID2]);
  assert.equal(h.result().textContent, ''); assert.equal(v.focused, 0);
  // Denied, failed: rows cleared with the refusal text.
  for (const [status, state] of [[403, 'denied'], [404, 'denied'], [503, 'failed']]) {
    await h.click(h.named(h.panel(), 'Reload Findings')[0]);
    lists.at(-1).d.reject({ status }); await flush();
    assert.deepEqual([h.panel().dataset.state, h.articles().length], [state, 0], String(status));
    await h.click(h.named(h.panel(), 'Reload Findings')[0]);
    lists.at(-1).d.resolve(page([finding()])); await flush();
    assert.equal(h.articles().length, 1);
  }
  // Session end during a command and a list read: everything clears and nothing late is shown.
  await h.click(h.named(h.panel(), 'Reload Findings')[0]);
  await h.click(h.source(ID1, 0));
  const session = h.channels.find(c => c.name === 'kin-session');
  session.onmessage({ data: { type: 'session-ended' } }); await flush();
  assert.deepEqual([h.panel().dataset.state, h.articles().length, h.result().textContent], ['ended', 0, '']);
  assert.equal(h.byId('reading-findings-open').disabled, true);
  lists.at(-1).d.resolve(page([finding()])); v.release(); await flush();
  assert.deepEqual([h.articles().length, h.result().textContent, v.focused], [0, '', 0]);
  const calls = h.s.api.length;
  h.ui.sync(); await h.click(h.byId('reading-findings-open'));
  assert.equal(h.s.api.length, calls, 'an ended list never reads again');
  assert.equal(session.closed, true);
  // The storage signal of another tab ends it as well.
  const other = worklist(); await other.open();
  const ended = new Event('storage'); ended.key = 'kin-session-ended'; other.sandbox.dispatchEvent(ended);
  assert.deepEqual([other.panel().dataset.state, other.articles().length], ['ended', 0]);
});

/* Retry after a refused Go to Image: the user fixes the viewer, another authorized edit changes the
 * finding meanwhile and window focus reloads the list. Retry replays only the source first pressed. */
const sent = v => Array.from(v.calls, call => JSON.parse(call));
async function refusedRetry(press, first) {
  const h = worklist(), v = viewer(), frame = h.embed(v);
  if (first) h.s.respond = () => Promise.resolve(first);
  v.modal = true;
  await h.open();
  await h.click(press(h));
  assert.deepEqual([h.result().dataset.result, v.calls.length], ['modal', 0], 'the first command is refused before any call');
  const retry = h.named(h.panel(), 'Retry Go to Image')[0];
  assert.equal(retry.hidden, false);
  v.modal = false;
  return { h, v, frame, retry };
}
async function focusReload(h, answer) {
  const reads = h.s.api.length;
  h.s.respond = () => Promise.resolve(answer);
  h.sandbox.dispatchEvent(new Event('focus')); await flush();
  assert.equal(h.s.api.length, reads + 1, 'focus reloaded the list');
}
const listChanged = (h, v, frame, retry, label) => {
  assert.deepEqual(sent(v), [], label + ': Retry never calls the viewer with a changed or other source');
  assert.deepEqual([h.result().dataset.result, h.result().textContent], ['list-changed', command.reasonText('list-changed')], label);
  assert.deepEqual([frame.focused, v.focused, retry.hidden], [0, 0, true], label);
};

test('adapter: Retry Go to Image after a reload that reorders, replaces, revises or removes the pressed source refuses list-changed before any viewer call', async () => {
  const cases = [
    ['reversed order (new revision)', page([finding({ revision: 2 }, [KEY_SOURCE(), source()])])],
    ['reversed order (same revision)', page([finding({}, [KEY_SOURCE(), source()])])],
    ['replaced source item', page([finding({ revision: 2 }, [source({ itemId: ITEM3 }), KEY_SOURCE()])])],
    ['source revision', page([finding({ revision: 2 }, [source({ revision: 2 }), KEY_SOURCE()])])],
    ['finding revision only', page([finding({ revision: 2, item: { ...finding().item, title: '수정한 제목' } })])],
    ['other image, same revision', page([finding({}, [source({ sopUid: SOP2, frame: 2 }), KEY_SOURCE()])])],
    ['finding removed', page([])],
    ['finding hidden', page([finding({ revision: 2, hidden: true })])],
  ];
  for (const [label, answer] of cases) {
    const { h, v, frame, retry } = await refusedRetry(x => x.source(ID1, 0));
    await focusReload(h, answer);
    assert.equal(retry.hidden, false, label + ': the reload alone keeps the offer');
    await h.click(retry);
    listChanged(h, v, frame, retry, label);
    if (label === 'reversed order (new revision)') {
      // Only an explicit press on the reloaded row goes to the source now shown at that place.
      await h.click(h.source(ID1, 0));
      assert.deepEqual(sent(v), [target(X, SOP2, ITEM2)]);
      assert.equal(h.result().dataset.result, 'ok');
    }
  }
  // Go to Primary Image is pinned to the source that was primary: here it stays primary but moves to index 0.
  const primary = finding({}, [source(), KEY_SOURCE()]); primary.item.primary = 1;
  const { h, v, frame, retry } = await refusedRetry(x => x.primary(ID1), page([primary]));
  await focusReload(h, page([finding({ revision: 2 }, [KEY_SOURCE(), source()])]));
  await h.click(retry);
  listChanged(h, v, frame, retry, 'primary source moved to another index');
});

test('adapter: Retry Go to Image after an unchanged reload, during a pending reload and across owner or selection changes calls only the pinned source', async () => {
  // Unchanged rows (fresh copies) after the focus reload: exactly the source first pressed, then success.
  {
    const { h, v, frame, retry } = await refusedRetry(x => x.source(ID1, 1));
    await focusReload(h, page([finding()]));
    await h.click(retry);
    assert.deepEqual(sent(v), [target(X, SOP2, ITEM2)]);
    assert.deepEqual([h.result().dataset.result, h.result().textContent], ['ok', '영상 이동 확인 · 통합 작업공간']);
    assert.deepEqual([frame.focused, v.focused, retry.hidden], [1, 1, true]);
  }
  {
    const primary = finding({}, [source(), KEY_SOURCE()]); primary.item.primary = 1;
    const { h, v, retry } = await refusedRetry(x => x.primary(ID1), page([primary]));
    await focusReload(h, page([primary]));
    await h.click(retry);
    assert.deepEqual([sent(v), h.result().dataset.result], [[target(X, SOP2, ITEM2)], 'ok']);
  }
  // Retry while the reload is still pending uses the retained rows; the late reordered page neither
  // retargets nor repeats the command, and it does not re-offer Retry.
  {
    const { h, v, retry } = await refusedRetry(x => x.source(ID1, 0));
    const late = deferred();
    h.s.respond = () => late.promise;
    h.sandbox.dispatchEvent(new Event('focus')); await flush();
    assert.equal(h.panel().dataset.state, 'reloading');
    await h.click(retry);
    assert.deepEqual([sent(v), h.result().dataset.result], [[target()], 'ok']);
    late.resolve(page([finding({ revision: 2 }, [KEY_SOURCE(), source()])])); await flush();
    assert.equal(h.panel().dataset.state, 'ready');
    assert.equal(h.source(ID1, 0).parent.dataset.itemId, ITEM2, 'the reordered list is shown');
    assert.deepEqual([v.calls.length, h.result().dataset.result, retry.hidden], [1, 'ok', true]);
  }
  // A viewer answer that is still pending when a reordered reload lands reports the source actually sent.
  {
    const { h, v, retry } = await refusedRetry(x => x.source(ID1, 0));
    await focusReload(h, page([finding()]));
    v.hold();
    await h.click(retry);
    assert.deepEqual(sent(v), [target()]);
    h.s.respond = () => Promise.resolve(page([finding({ revision: 2 }, [KEY_SOURCE(), source()])]));
    await h.click(h.named(h.panel(), 'Reload Findings')[0]);
    assert.equal(h.source(ID1, 0).parent.dataset.itemId, ITEM2);
    v.release(); await flush();
    assert.deepEqual([v.calls.length, h.result().dataset.result, retry.hidden], [1, 'ok', true]);
  }
  // Owner B then A, or selection B then A, with the same rows: the refused command is gone, never replayed.
  for (const [label, away, back] of [
    ['owner A-B-A', h => { h.s.owner = '["hallym","sub-b"]'; }, h => { h.s.owner = OWNER; }],
    ['selection A-B-A', h => { h.s.selected = B; }, h => { h.s.selected = X; }],
  ]) {
    const { h, v, frame, retry } = await refusedRetry(x => x.source(ID1, 0));
    away(h); h.ui.sync(); await flush();
    back(h); h.ui.sync(); await flush();
    assert.equal(h.articles().length, 1, label + ': same rows again');
    assert.deepEqual([retry.hidden, h.result().dataset.result], [true, ''], label);
    await h.click(retry);
    assert.deepEqual([v.calls.length, h.result().dataset.result, frame.focused], [0, '', 0], label + ': a hidden Retry does nothing');
  }
  // An owner change seen first by the Retry click itself: the pin belongs to the old list, nothing is called.
  {
    const { h, v, frame, retry } = await refusedRetry(x => x.source(ID1, 0));
    h.s.owner = '["hallym","sub-b"]';
    await h.click(retry);
    assert.deepEqual([v.calls.length, h.result().dataset.result, frame.focused, retry.hidden], [0, 'list-changed', 0, true]);
    assert.equal(h.articles().length, 1, 'the list of the new owner is read again');
    await h.click(retry);
    assert.equal(v.calls.length, 0, 'the refused command of the old owner is never replayed on the new list');
  }
});

/* ---------- S2-B2 comparison sources (TEST-S2B2-PURE-WL: REQ-S2B2-NAVIGATE/RETRY/REVOKE) ----------
 * The worklist sends a source of the row's one comparison study only to a viewer that shows both studies,
 * through links.crossNavigate with that document's functions; the navigator keeps B1's identity watch. */
const P_SERIES = '1.2.840.30.1', P_SOP = '1.2.840.30.1.2';
const P_SOURCE = extra => source(Object.assign({ itemId: ITEM2, studyUid: P, seriesUid: P_SERIES, sopUid: P_SOP, kind: 'key', label: '비교 키', values: null, revision: 2 }, extra));
const crossFinding = extra => finding(extra, [source(), P_SOURCE()]);
const P_TARGET = { studyUid: P, seriesUid: P_SERIES, sopUid: P_SOP, frame: 1, itemId: ITEM2 };

test('comparison rows and targets: one comparison study per row; only a viewer of both studies is chosen, embedded first', () => {
  const row = command.rowOf(crossFinding(), X);
  assert.equal(row.comparison, P); assert.deepEqual(row.sources.map(s => s.foreign), [false, true]);
  assert.equal(command.rowOf(finding(), X).comparison, null);
  assert.throws(() => command.rowOf(finding({}, [source(), P_SOURCE(), source({ itemId: ITEM3, studyUid: B })]), X), undefined, 'two comparison studies');
  const cases = [
    [{ workspace: ws({ studies: [X, P] }), windows: [win({ studies: [X, P] })] }, { kind: 'embedded' }],
    [{ workspace: ws({ studies: [P, X], loaded: false }), windows: [] }, { kind: 'refused', reason: 'loading' }],
    [{ workspace: ws(), windows: [win({ studies: [X, P], index: 2 })] }, { kind: 'window', index: 2 }],
    [{ workspace: ws(), windows: [win()] }, { kind: 'refused', reason: 'comparison-viewer' }],
    [{ workspace: ws({ studies: [P] }), windows: [win({ studies: [P, B] })] }, { kind: 'refused', reason: 'comparison-viewer' }],
    [{ windows: [win({ studies: [X, P] }), win({ index: 1, studies: [P, X] })] }, { kind: 'refused', reason: 'ambiguous' }],
    [{ windows: [win({ studies: [X, P] }), win({ index: 1 })] }, { kind: 'window', index: 0 }],
    [{ windows: [win({ studies: [X, P], attached: false, index: 3 })] }, { kind: 'refused', reason: 'unattached', index: 3 }],
    [{ windows: [win({ studies: [X, P], owner: 'other' })] }, { kind: 'refused', reason: 'owner' }],
  ];
  for (const [snapshot, expected] of cases) assert.deepEqual(command.chooseTarget(freeze(Object.assign({ uid: X, comparison: P }, snapshot))), expected, JSON.stringify(snapshot));
  for (const bad of ['x', X]) assert.deepEqual(command.chooseTarget({ uid: X, comparison: bad, windows: [win({ studies: [X, P] })] }), { kind: 'refused', reason: 'invalid' });
  assert.deepEqual(command.chooseTarget({ uid: X, comparison: null, windows: [] }), { kind: 'refused', reason: 'no-viewer' }, 'no comparison keeps B1');
  assert.equal(command.retryable('comparison-viewer'), true); assert.equal(command.openable('comparison-viewer'), false);
  for (const reason of links.CROSS_REASONS) assert.ok(command.reasonText(reason).length > 10, reason);
  assert.equal(command.resultText({ reason: 'timeout', phase: 'activated' }), command.reasonText('timeout') + links.phaseText('activated'));
  assert.equal(command.resultText({ reason: 'modal' }), command.reasonText('modal'));
  assert.equal(command.arrivalText({ ok: true, annotation: 'key', phase: 'navigating' }, '영상 창 1'), '영상 이동 확인 · 영상 창 1 · 비교 검사 영상 칸 · ' + links.annotationText('key'));
});

test('comparison pre-call and identity: an activation tool is required; a loading history is tolerated only while the command waits', () => {
  assert.equal(command.precheck(view({ activate: false }), expected), null, 'B1 does not need it');
  assert.equal(command.precheck(view({ activate: false }), expected, true), 'tool-missing');
  assert.equal(command.precheck(view({ activate: true }), expected, true), null);
  assert.equal(command.precheck(view({ activate: true, suspended: true }), expected, true), 'busy', 'a loading history refuses before the call');
  assert.equal(command.sameIdentity(view(), view({ suspended: true }), true), true);
  assert.equal(command.sameIdentity(view(), view({ suspended: true })), false);
  for (const change of [{ document: {} }, { closed: true }, { ended: true }, { subject: 'other' }, { owner: '["x","y"]' }, { live: false }, { historyPresent: false }])
    assert.equal(command.sameIdentity(view(), view({ suspended: true, ...change }), true), false, JSON.stringify(change));
  const other = code => vm.runInNewContext(code);
  assert.deepEqual(command.crossResult(other('({ ok: false, reason: "viewport-ambiguous" })')), { ok: false, reason: 'viewport-ambiguous' });
  assert.deepEqual(command.crossResult({ ok: false, reason: 'timeout' }), { ok: false, reason: 'timeout' });
  assert.deepEqual(command.crossResult({ ok: true, highlighted: true, annotation: 'shown', phase: 'x' }), { ok: true, highlighted: true, annotation: 'shown' });
  for (const bad of [{ ok: false, reason: 'loading' }, { ok: false, reason: 'foreign' }, { ok: true }, null, { get ok() { throw new Error('x'); } }])
    assert.deepEqual(command.crossResult(bad), { ok: false, reason: 'invalid' });
});

// A command whose chosen document is driven by the fake clock: the history reloads the comparison study
// `readyAfter` ms after activation unless `never`; probe facts follow that history.
function crossJob(o) {
  const opts = o || {}, c = opts.clock, log = [], announced = [];
  const h = { scope: X, subject: SUB, ended: false, suspended: false, loading: false, generation: 3, viewportId: 'vp-x', image: null };
  const facts = view({ scope: X + ',' + P, activate: true });
  const env = {
    state: () => { log.push('state'); return { ...h, image: h.image && { ...h.image } }; },
    activate: study => {
      log.push(['activate', study]);
      if (opts.activation) return opts.activation;
      h.viewportId = 'vp-p'; Object.assign(h, { scope: study, suspended: true, loading: true, generation: h.generation + 1 });
      // Loaded (or refused, which leaves the history suspended) after `readyAfter` ms.
      if (!opts.never) c.setTimeout(() => { if (h.scope === study) Object.assign(h, { loading: false, suspended: !!opts.refused }); }, opts.readyAfter ?? 300);
      return { ok: true, viewportId: 'vp-p', changed: true };
    },
    navigate: target => {
      log.push(['navigate', plain(target)]);
      h.image = { study: target.studyUid, seriesUid: target.seriesUid, sopUid: target.sopUid, frame: target.frame };
      return opts.answer ? opts.answer() : Promise.resolve({ ok: true, highlighted: false, annotation: 'key' });
    },
  };
  const choice = { kind: 'window', label: '영상 창 1', env: () => env,
    probe: () => ({ ...facts, suspended: h.suspended, historyScope: h.scope, image: opts.probeImage ? opts.probeImage() : h.image && { ...h.image } }),
    invoke: () => { throw new Error('the B1 call is not used for a comparison source'); } };
  const job = { expected, source: P_SOURCE(), comparison: 'comparison' in opts ? opts.comparison : P,
    choose: () => { log.push('choose'); return choice; }, announce: result => announced.push(plain(result)) };
  return { job, log, announced, h, facts };
}
const calledWith = (log, name) => log.filter(x => Array.isArray(x) && x[0] === name).map(x => x[1]);

test('comparison command: activation, a reload wait that tolerates the loading history, one call, readback and one announcement', async () => {
  const c = clock(), nav = command.createNavigator(c), j = crossJob({ clock: c, readyAfter: 600 });
  const running = nav.run(j.job);
  await c.advance(1000);
  assert.deepEqual(await running, { ok: true, highlighted: false, annotation: 'key', phase: 'navigating', latest: true });
  assert.deepEqual(calledWith(j.log, 'activate'), [P]); assert.deepEqual(calledWith(j.log, 'navigate'), [P_TARGET]);
  assert.deepEqual(j.announced, [{ ok: true, highlighted: false, annotation: 'key', phase: 'navigating' }]);
  assert.equal(c.pending(), 0);
  // No declared comparison, or another one: refused before a target is chosen.
  for (const comparison of [undefined, null, B, 'x']) {
    const k = crossJob({ clock: c, comparison });
    assert.deepEqual(await nav.run(k.job), { ok: false, reason: 'foreign', latest: true }, String(comparison));
    assert.deepEqual(k.log, []);
  }
  // A viewer without the activation tool, or a refused activation: nothing further.
  const noTool = crossJob({ clock: c }); noTool.facts.activate = false;
  assert.deepEqual(await nav.run(noTool.job), { ok: false, reason: 'tool-missing', latest: true });
  assert.deepEqual(noTool.log, ['choose']);
  const refusedActivation = crossJob({ clock: c, activation: { ok: false, reason: 'viewport-ambiguous' } });
  assert.deepEqual(await nav.run(refusedActivation.job), { ok: false, reason: 'viewport-ambiguous', phase: 'before', latest: true });
  assert.deepEqual(calledWith(refusedActivation.log, 'navigate'), []);
});

test('comparison command: timeout, refusal, a replaced document or a newer command while waiting never calls the viewer, then or later', async () => {
  {
    const c = clock(), nav = command.createNavigator(c), j = crossJob({ clock: c, never: true });
    const running = nav.run(j.job);
    await c.advance(14999); assert.equal(j.announced.length, 0, 'a loading history does not settle the watch');
    await c.advance(1);
    assert.deepEqual(await running, { ok: false, reason: 'timeout', phase: 'activated', latest: true });
    Object.assign(j.h, { suspended: false, loading: false }); await c.advance(2000);
    assert.deepEqual(calledWith(j.log, 'navigate'), []); assert.equal(j.h.viewportId, 'vp-p', 'no automatic viewport restore');
    assert.equal(c.pending(), 0);
  }
  {
    const c = clock(), nav = command.createNavigator(c), j = crossJob({ clock: c, refused: true, readyAfter: 200 });
    const running = nav.run(j.job); await c.advance(1000);
    assert.deepEqual(await running, { ok: false, reason: 'busy', phase: 'activated', latest: true });
    assert.deepEqual(calledWith(j.log, 'navigate'), []);
  }
  for (const change of [f => { f.document = {}; }, f => { f.owner = '["hallym","sub-b"]'; }, f => { f.closed = true; }, f => { f.selection = B; }]) {
    const c = clock(), nav = command.createNavigator(c), j = crossJob({ clock: c, readyAfter: 800 });
    const running = nav.run(j.job);
    await c.advance(200); change(j.facts); await c.advance(2000);
    assert.deepEqual(await running, { ok: false, reason: 'superseded', phase: 'activated', latest: true }, String(change));
    assert.deepEqual(calledWith(j.log, 'navigate'), [], String(change));
    // Between two 250 ms watch ticks the reload poll itself re-checks the identity before calling.
    const d = clock(), later = command.createNavigator(d), k = crossJob({ clock: d, never: true });
    const pending = later.run(k.job);
    await d.advance(260); change(k.facts); Object.assign(k.h, { suspended: false, loading: false }); await d.advance(2000);
    assert.deepEqual(await pending, { ok: false, reason: 'superseded', phase: 'activated', latest: true }, 'between ticks ' + String(change));
    assert.deepEqual(calledWith(k.log, 'navigate'), [], 'between ticks ' + String(change));
  }
  {
    const c = clock(), nav = command.createNavigator(c), older = crossJob({ clock: c, never: true }), newer = crossJob({ clock: c, readyAfter: 100 });
    const a = nav.run(older.job); await c.advance(100);
    const b = nav.run(newer.job); await c.advance(1000);
    assert.equal((await b).ok, true);
    Object.assign(older.h, { suspended: false, loading: false }); await c.advance(500);
    assert.deepEqual(await a, { ok: false, reason: 'superseded', phase: 'activated', latest: false });
    assert.deepEqual([calledWith(older.log, 'navigate'), older.announced], [[], []]);
  }
});

test('comparison command: an ok answer is success only if the chosen document still reports that study and the exact image', async () => {
  const cases = [
    [{ probeImage: () => ({ study: P, seriesUid: P_SERIES, sopUid: SOP2, frame: 1 }) }, 'superseded'],
    [{ probeImage: () => null }, 'superseded'],
    [{ answer: () => Promise.resolve({ ok: false, reason: 'series-missing' }) }, 'series-missing'],
    [{ answer: () => Promise.resolve({ ok: true }) }, 'invalid'],
    [{ answer: () => Promise.reject(new Error('x')) }, 'tool-missing'],
  ];
  for (const [o, reason] of cases) {
    const c = clock(), nav = command.createNavigator(c), j = crossJob(Object.assign({ clock: c, readyAfter: 100 }, o));
    const running = nav.run(j.job); await c.advance(1000);
    assert.deepEqual(await running, { ok: false, reason, phase: 'navigating', latest: true }, reason);
    assert.equal(calledWith(j.log, 'navigate').length, 1);
  }
  // The history moving away from the study after the answer is caught by the viewer-side readback.
  const c = clock(), nav = command.createNavigator(c);
  let gate; const answer = new Promise(resolve => { gate = resolve; });
  const j = crossJob({ clock: c, readyAfter: 100, answer: () => answer });
  const running = nav.run(j.job); await c.advance(300);
  assert.equal(calledWith(j.log, 'navigate').length, 1);
  Object.assign(j.h, { scope: X, generation: 99 }); gate({ ok: true, highlighted: false, annotation: 'key' }); await c.advance(10);
  assert.deepEqual(await running, { ok: false, reason: 'superseded', phase: 'navigating', latest: true });
});

// A viewer document of its own realm with two viewports (URL X,P) and the S2-B2 exports.
function pairedViewer(o) {
  const options = o || {};
  const ctx = vm.createContext({ setTimeout });
  vm.runInContext(`
    this.calls = []; this.activations = []; this.modal = false; this.focused = 0; this.closed = false; this.gates = [];
    this.shows = { 'vp-x': ${JSON.stringify(X)}, 'vp-p': ${JSON.stringify(P)} };
    this.first = { ${JSON.stringify(X)}: { seriesUid: ${JSON.stringify(SERIES)}, sopUid: ${JSON.stringify(SOP)} }, ${JSON.stringify(P)}: { seriesUid: ${JSON.stringify(P_SERIES)}, sopUid: '1.2.840.30.1.1' } };
    this.history = { scope: ${JSON.stringify(X)}, subject: ${JSON.stringify(SUB)}, ended: false, suspended: false, loading: false, generation: 1, viewportId: 'vp-x',
      image: { study: ${JSON.stringify(X)}, seriesUid: ${JSON.stringify(SERIES)}, sopUid: ${JSON.stringify(SOP)}, frame: 1 } };
    this.loadMs = 30; this.refuse = false; this.never = false;
    this.document = { querySelectorAll: () => this.modal ? [{ getClientRects: () => [{}] }] : [] };
    this.location = { href: ${JSON.stringify(ORIGIN + '/ohif/viewer?StudyInstanceUIDs=' + X + ',' + P + '#kin-window-slot=0')} };
    this.focus = () => { this.focused++; };
    this.kinViewerWindowOwner = () => ${JSON.stringify(OWNER)};
    this.kinViewerHistoryState = () => ({ ...this.history, image: this.history.image && { ...this.history.image }, heads: [] });
    // The user (or the command) selects a viewport; the history resets and reloads that study later.
    this.select = id => {
      const study = this.shows[id];
      this.history.viewportId = id;
      if (study === this.history.scope) return;
      Object.assign(this.history, { scope: study, suspended: true, loading: true, generation: this.history.generation + 1, image: { study, ...this.first[study], frame: 1 } });
      const generation = this.history.generation;
      setTimeout(() => {
        if (this.history.generation !== generation || this.never) return;
        this.history.loading = false; if (!this.refuse) this.history.suspended = false;
      }, this.loadMs);
    };
    this.kinViewerHistoryActivate = study => {
      this.activations.push(study);
      const ids = Object.keys(this.shows).filter(id => this.shows[id] === study);
      if (ids.length === 0) return { ok: false, reason: 'viewport-missing' };
      if (ids.length > 1) return { ok: false, reason: 'viewport-ambiguous' };
      if (this.history.viewportId === ids[0]) return { ok: true, viewportId: ids[0], changed: false };
      this.select(ids[0]);
      return { ok: true, viewportId: ids[0], changed: true };
    };
    this.kinViewerHistoryNavigate = target => {
      this.calls.push(JSON.stringify(target));
      const land = () => {
        if (target.studyUid !== this.history.scope) return { ok: false, reason: 'scope' };
        this.history.image = { study: target.studyUid, seriesUid: target.seriesUid, sopUid: target.sopUid, frame: target.frame };
        return { ok: true, highlighted: false, annotation: 'key' };
      };
      if (this.holding) return new Promise(resolve => this.gates.push(() => resolve(land())));
      return Promise.resolve(land());
    };
  `, ctx);
  return ctx;
}
const settle = async (h, ms = 3000) => { const end = Date.now() + ms; while (h.result().dataset.result === 'pending' && Date.now() < end) { await new Promise(r => setTimeout(r, 10)); await flush(); } };

test('adapter comparison: a viewer of both studies activates the comparison viewport, waits for its reload, lands on the exact frame and says where', async () => {
  const h = worklist(), v = pairedViewer(), frame = h.embed(v, { studies: [X, P] });
  h.s.respond = () => Promise.resolve(page([crossFinding()]));
  await h.open();
  assert.equal(h.byId('reading-findings-target').dataset.target, 'embedded');
  await h.click(h.source(ID1, 1)); await settle(h);
  assert.deepEqual([h.result().dataset.result, h.result().textContent], ['ok', '영상 이동 확인 · 통합 작업공간 · 비교 검사 영상 칸 · ' + links.annotationText('key')]);
  assert.deepEqual([plain(v.activations), sent(v)], [[P], [P_TARGET]]);
  assert.deepEqual(plain(v.history.image), { study: P, seriesUid: P_SERIES, sopUid: P_SOP, frame: 1 });
  assert.deepEqual([frame.focused, v.focused, v.history.viewportId], [1, 1, 'vp-p']);
  // The selected study's own source while the comparison viewport is active: the B1 call, refused by the viewer.
  await h.click(h.source(ID1, 0)); await settle(h);
  assert.deepEqual([h.result().dataset.result, v.activations.length, v.calls.length], ['scope', 1, 2]);
  // Pressed again with the comparison already active and loaded: no activation change, one more call.
  await h.click(h.source(ID1, 1)); await settle(h);
  assert.deepEqual([h.result().dataset.result, plain(v.activations), v.history.viewportId, v.calls.length], ['ok', [P, P], 'vp-p', 3]);
});

test('adapter comparison: missing, duplicated or refused comparison viewports and Retry of the pinned comparison source', async () => {
  const h = worklist(), v = pairedViewer();
  let studies = [X];
  const frame = h.embed(v, () => ({ studies }));
  h.s.respond = () => Promise.resolve(page([crossFinding()]));
  await h.open();
  // The embedded viewer shows only the selected study: no call, Retry offered.
  await h.click(h.source(ID1, 1));
  assert.deepEqual([h.result().dataset.result, v.activations.length, v.calls.length], ['comparison-viewer', 0, 0]);
  const retry = h.named(h.panel(), 'Retry Go to Image')[0];
  assert.equal(retry.hidden, false);
  studies = [X, P];
  for (const [arrange, reason] of [[() => { v.shows['vp-p'] = X; }, 'viewport-missing'], [() => { v.shows['vp-x'] = P; v.shows['vp-p'] = P; }, 'viewport-ambiguous']]) {
    arrange();
    await h.click(retry); await settle(h);
    assert.deepEqual([h.result().dataset.result, h.result().textContent, v.calls.length], [reason, command.reasonText(reason), 0], reason);
    assert.equal(retry.hidden, false);
    Object.assign(v.shows, { 'vp-x': X, 'vp-p': P });
  }
  // The comparison history refuses after activation: busy, the display may have changed, the list is read again.
  v.refuse = true;
  const reads = h.s.api.length;
  await h.click(retry); await settle(h);
  assert.deepEqual([h.result().dataset.result, h.result().textContent], ['busy', command.reasonText('busy') + links.phaseText('activated')]);
  assert.deepEqual([v.calls.length, v.history.viewportId, h.s.api.length], [0, 'vp-p', reads + 1], 'no call, no restore, one list read');
  // The user returns to the selected study; Retry replays exactly the pinned comparison source.
  v.refuse = false; v.select('vp-x'); await new Promise(r => setTimeout(r, 60));
  await h.click(retry); await settle(h);
  assert.deepEqual([h.result().dataset.result, sent(v)], ['ok', [P_TARGET]]);
  assert.equal(frame.focused, 1);
  // A reload that replaces the comparison source: Retry refuses list-changed before any call.
  v.modal = true; v.select('vp-x'); await new Promise(r => setTimeout(r, 60));
  await h.click(h.source(ID1, 1));
  assert.equal(h.result().dataset.result, 'modal');
  await focusReload(h, page([finding({ revision: 2 }, [source(), P_SOURCE({ revision: 3 })])]));
  v.modal = false;
  await h.click(retry);
  assert.deepEqual([h.result().dataset.result, v.calls.length], ['list-changed', 1]);
});

test('adapter comparison: a document replaced, an account change or a withdrawn row during the wait is never success nor a later call', async () => {
  for (const change of [
    (v, h, state) => { state.document = { querySelectorAll: () => [] }; },
    (v, h) => { h.s.owner = '["hallym","sub-b"]'; },
    (v, h) => { h.s.selected = B; h.ui.sync(); },
    (v, h, state) => { state.studies = [X]; },
  ]) {
    const h = worklist(), v = pairedViewer(), state = { studies: [X, P] };
    h.embed(v, () => state);
    h.s.respond = () => Promise.resolve(page([crossFinding()]));
    await h.open();
    v.never = true;
    await h.click(h.source(ID1, 1));
    assert.equal(h.result().dataset.result, 'pending');
    change(v, h, state);
    await new Promise(r => setTimeout(r, 400)); await flush();
    Object.assign(v.history, { suspended: false, loading: false });
    await new Promise(r => setTimeout(r, 300)); await flush();
    assert.equal(v.calls.length, 0, String(change));
    assert.ok(['superseded', ''].includes(h.result().dataset.result), String(change) + ' ' + h.result().dataset.result);
    assert.ok(!h.result().textContent.includes('영상 이동 확인'));
  }
  // The comparison study is withdrawn: the reloaded list has no row, and nothing of it stays in the panel.
  const h = worklist(), v = pairedViewer();
  h.embed(v, { studies: [X, P] });
  h.s.respond = () => Promise.resolve(page([crossFinding()]));
  await h.open();
  assert.ok(h.panel().textContent.includes('비교 키'));
  h.s.respond = () => Promise.resolve(page([]));
  await h.click(h.named(h.panel(), 'Reload Findings')[0]);
  assert.equal(h.articles().length, 0);
  for (const secret of ['비교 키', P_SOP, P_SERIES, ITEM2]) assert.equal(h.panel().textContent.includes(secret), false, secret);
});

/* ---------- shipped wiring ---------- */
test('wiring: the worklist loads the modules in order, mounts once, follows selection and keeps the boundary', () => {
  const html = shipped('main.html'), rw = shipped('reading-workspace.js'), ui = shipped('reading-findings.js'), pure = shipped('finding-command.js');
  const order = ['reading-workspace.js', 'finding-link-model.js', 'finding-command.js', 'reading-findings.js'].map(name => html.indexOf('<script src="' + name + '"></script>'));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), 'script order');
  assert.equal(html.split('KinReadingFindings({').length - 1, 1);
  assert.equal(html.split('readingFindings?.sync();').length - 1, 1);
  assert.match(html, /readingWorkspace\.selectionChanged\(deferViewer\);\r?\n\s+readingFindings\?\.sync\(\);/, 'selection hook after the workspace');
  assert.ok(html.indexOf('let readingFindings = null;') > html.indexOf('const readingWorkspace = KinReadingWorkspace({'), 'mounted after the workspace it reads');
  assert.ok(rw.includes('snapshotPanels, applyPanels, viewerTarget,'));
  const accessor = rw.slice(rw.indexOf('  function viewerTarget() {'), rw.indexOf('  function noteTarget() {'));
  assert.ok(accessor.length > 0 && !/focus\(|layout\(|identify\(|attempt\(|\.src\s*=|location\.(href|assign|replace)\s*[=(]/.test(accessor), 'accessor is read-only');
  // No write, no report, no URL/scope change and no innerHTML in the list and command modules.
  for (const text of [ui, pure]) {
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(text));
    assert.ok(!/'(POST|PUT|PATCH|DELETE)'/.test(text));
    assert.ok(!/#findings|location\.(href|assign|replace)\s*[=(]|window\.open\(/.test(text));
  }
  assert.equal(ui.split("app.api('GET', path)").length - 1, 1, 'the only request is the list read');
  assert.ok(ui.includes('const navigate = w.kinViewerHistoryNavigate;'), 'navigate is read at call time');
  assert.equal(ui.split('kinViewerHistoryNavigate').length - 1, 2);
});
