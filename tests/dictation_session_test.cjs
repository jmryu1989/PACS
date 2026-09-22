// REQ-S3-R14 dictation review -> RISK stale/wrong-patient/changed-body insertion.
// Pure session protocol only: no microphone, engine, browser, HTTP or persistence proof.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { create, hashText } = require('../worklist-v0/hpacs-lite/dictation-session.js');
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const f = { value: { uid: 'study-A', selectionSeq: 7, baseVersion: 2, field: 'findings',
    value: '기존 본문\n', caret: { start: 0, end: 0 }, blocked: false }, writes: [], cleanup: [] };
  f.model = create({ readContext: () => f.value, hashText: async v => sha(v),
    // This is a test-only caller policy, NOT the eventual product transcript cap.
    validateTranscript: v => Buffer.byteLength(v, 'utf8') <= 64,
    insert: p => { f.writes.push(p); f.value.value += p.text; return true; },
    cleanup: reason => f.cleanup.push(reason), ...overrides });
  return f;
}
async function uploading(f) {
  f.model.setAvailable(true);
  const r = await f.model.begin(); assert.equal(r.ok, true);
  assert.equal(f.model.recording(r.token).ok, true);
  assert.equal(f.model.uploading(r.token).ok, true);
  return r.token;
}
async function review(f, text = '검토할 문장') {
  const token = await uploading(f);
  assert.equal(f.model.receive(token, text).ok, true);
  return token;
}

test('unavailable is the default and all three host safety contracts are required', async () => {
  const f = fixture();
  assert.equal((await f.model.begin()).reason, 'unavailable');
  assert.equal(f.model.snapshot().state, 'unavailable');
  assert.equal(f.writes.length, 0);
  assert.throws(() => create({ readContext() {} }), TypeError);
});

test('an answer is review text only; Insert preserves the original field/caret pin', async () => {
  const f = fixture(), before = f.value.value;
  const token = await review(f);
  f.value.caret = { start: before.length, end: before.length };
  assert.equal(f.value.value, before);
  assert.equal(f.writes.length, 0);
  const result = await f.model.insert(token);
  assert.equal(result.ok, true);
  assert.deepEqual(f.writes[0].caret, { start: 0, end: 0 });
  assert.equal(f.writes[0].expectedValue, before);
  assert.equal(f.writes[0].fieldValueHash, sha(before));
  assert.equal(f.model.snapshot().state, 'inserted');
  assert.equal(f.model.snapshot().text, '');
  assert.equal(f.cleanup.length, 1);
});

test('double Insert while hashing and a replay after completion write once', async () => {
  let hold = null;
  const f = fixture({ hashText: v => hold ? hold.promise : Promise.resolve(sha(v)) });
  const token = await review(f); hold = deferred();
  const first = f.model.insert(token);
  assert.equal((await f.model.insert(token)).reason, 'busy');
  hold.resolve(sha(f.value.value));
  assert.equal((await first).ok, true);
  assert.equal((await f.model.insert(token)).reason, 'stale');
  assert.equal(f.writes.length, 1);
  assert.equal(f.cleanup.length, 1);
});

test('a changed field retains review and requires explicit re-pin plus a new Insert', async () => {
  const f = fixture(), token = await review(f), original = f.value.value;
  f.value.value += '추가 타이핑';
  assert.equal((await f.model.insert(token)).reason, 'field-changed');
  assert.equal(f.model.snapshot().text, '검토할 문장');
  assert.equal(f.model.snapshot().state, 'review');
  f.value.value = original; // Even reverting does not silently clear the re-pin requirement.
  assert.equal((await f.model.insert(token)).reason, 'field-changed');
  f.value.field = 'conclusion'; f.value.value = '결론\n'; f.value.caret = { start: 3, end: 3 };
  assert.equal((await f.model.repin(token)).ok, true);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.model.insert(token)).ok, true);
  assert.equal(f.writes[0].field, 'conclusion');
  assert.equal(f.writes[0].expectedValue, '결론\n');
  assert.deepEqual(f.writes[0].caret, { start: 3, end: 3 });
});

for (const [name, change] of [
  ['different study', f => { f.value.uid = 'study-B'; }],
  ['A to B to A selection', f => { f.value.selectionSeq += 2; }],
  ['new report version', f => { f.value.baseVersion += 1; }],
  ['editor becomes read-only', f => { f.value.blocked = true; }],
]) {
  test(`${name} during asynchronous Insert hashing cannot write`, async () => {
    let hold = null;
    const f = fixture({ hashText: v => hold ? hold.promise : Promise.resolve(sha(v)) });
    const token = await review(f), before = f.value.value;
    hold = deferred(); const insertion = f.model.insert(token);
    change(f); hold.resolve(sha(before));
    assert.equal((await insertion).ok, false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.value.value, before);
    assert.equal(f.model.snapshot().state, 'failed');
    assert.ok(f.model.snapshot().asrSeq > token);
    assert.equal(f.cleanup.length, 1);
  });
}

for (const method of ['cancel', 'studyChanged', 'loggedOut']) {
  test(`${method} drops a pending hash and a late answer without changing the body`, async () => {
    let hold = null;
    const f = fixture({ hashText: v => hold ? hold.promise : Promise.resolve(sha(v)) });
    const token = await review(f), before = f.value.value;
    hold = deferred(); const insertion = f.model.insert(token);
    f.model[method](); f.model[method]();
    hold.resolve(sha(before));
    assert.equal((await insertion).ok, false);
    assert.equal(f.model.receive(token, '늦은 응답').ok, false);
    assert.equal(f.value.value, before);
    assert.equal(f.writes.length, 0);
    assert.equal(f.cleanup.length, 1);
  });
}

test('begin cannot supersede an active session or reuse a late response after manual retry', async () => {
  const f = fixture(), first = await uploading(f);
  assert.equal((await f.model.begin()).reason, 'busy');
  f.model.fail(first, 'timeout');
  const second = await uploading(f);
  assert.ok(second > first);
  assert.equal(f.model.receive(first, '오래된 응답').reason, 'stale');
  assert.equal(f.model.receive(second, '새 응답').ok, true);
  assert.equal(f.model.snapshot().text, '새 응답');
  f.model.cancel(); assert.equal(f.cleanup.length, 2);
});

test('invalid response or failed host policy fails closed, with no automatic retry', async () => {
  for (const transcript of ['', '  \n', null, '가'.repeat(40)]) {
    const f = fixture(), token = await uploading(f), before = f.value.value;
    assert.equal(f.model.receive(token, transcript).reason, 'invalid-transcript');
    assert.equal(f.model.snapshot().state, 'failed');
    assert.equal(f.model.snapshot().text, '');
    assert.equal(f.value.value, before);
    assert.equal(f.cleanup.length, 1);
  }
  const f = fixture({ validateTranscript() { throw Error('policy unavailable'); } });
  assert.equal(f.model.receive(await uploading(f), '문장').ok, false);
});

test('the response itself checks editor scope before exposing review text', async () => {
  const f = fixture(), token = await uploading(f);
  f.value.selectionSeq += 1;
  assert.equal(f.model.receive(token, '다른 검사 응답').ok, false);
  assert.equal(f.model.snapshot().text, '');
  assert.equal(f.writes.length, 0);
});

test('a late transport failure cannot erase an already accepted review', async () => {
  const f = fixture(), token = await review(f);
  assert.equal(f.model.fail(token, 'late-timeout').ok, false);
  assert.equal(f.model.snapshot().state, 'review');
  assert.equal(f.model.snapshot().text, '검토할 문장');
  assert.equal(f.writes.length, 0);
});

test('normalization differences invalidate the exact field pin', async () => {
  const f = fixture(); f.value.value = 'é\r\n';
  const token = await review(f);
  f.value.value = 'e\u0301\n';
  assert.equal((await f.model.insert(token)).reason, 'field-changed');
  assert.equal(f.writes.length, 0);
});

test('default SHA-256 hashes exact UTF-8 without normalization', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    for (const value of ['é\r\n', 'e\u0301\n', '판독 😀', '']) assert.equal(await hashText(value), sha(value));
    assert.notEqual(await hashText('é'), await hashText('e\u0301'));
  } finally {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto;
  }
});

test('begin and re-pin reject body changes while hashing rather than capturing a different body', async () => {
  let hold = deferred();
  const f = fixture({ hashText: v => hold ? hold.promise : Promise.resolve(sha(v)) });
  f.model.setAvailable(true);
  const begin = f.model.begin(), initial = f.value.value;
  f.value.value += '새 글'; hold.resolve(sha(initial));
  assert.equal((await begin).reason, 'editor-changed');
  hold = null; const token = await review(f);
  f.value.value += '수정'; await f.model.insert(token);
  hold = deferred(); const before = f.value.value, repin = f.model.repin(token);
  assert.equal((await f.model.insert(token)).reason, 'busy');
  f.value.value += '다시 수정'; hold.resolve(sha(before));
  assert.equal((await repin).reason, 'field-changed');
  assert.equal(f.model.snapshot().needsRepin, true);
  assert.equal(f.writes.length, 0);
});

test('cancel during initial hash cannot revive the old pin in a replacement session', async () => {
  const hold = deferred(); let first = true;
  const f = fixture({ hashText: v => { if (first) { first = false; return hold.promise; } return Promise.resolve(sha(v)); } });
  f.model.setAvailable(true); const initial = f.model.begin(); f.model.cancel();
  const replacement = await review(f, '현재 응답');
  hold.resolve(sha('기존 본문\n'));
  assert.equal((await initial).reason, 'stale');
  assert.equal(f.model.snapshot().asrSeq, replacement);
  assert.equal(f.model.snapshot().text, '현재 응답');
  assert.equal(f.cleanup.length, 1);
});

test('host insert refusal or exception consumes the old session without duplicate writes', async () => {
  for (const insert of [() => false, () => { throw Error('not writable'); }]) {
    const f = fixture({ insert }), token = await review(f), before = f.value.value;
    assert.equal((await f.model.insert(token)).ok, false);
    assert.equal((await f.model.insert(token)).reason, 'stale');
    assert.equal(f.model.snapshot().state, 'failed');
    assert.equal(f.value.value, before);
    assert.equal(f.cleanup.length, 1);
  }
});

test('failed hash and invalid hash output invalidate the session', async () => {
  for (const hashText of [async () => { throw Error('digest'); }, async () => 'not-sha256']) {
    const f = fixture({ hashText }); f.model.setAvailable(true);
    assert.equal((await f.model.begin()).reason, 'hash-failed');
    assert.equal(f.model.snapshot().state, 'failed');
    assert.equal(f.cleanup.length, 1);
  }
});

test('capability loss cleans up once; malformed editor context never starts recording', async () => {
  const f = fixture(), token = await uploading(f);
  f.model.setAvailable(false); f.model.setAvailable(false);
  assert.equal(f.model.receive(token, '문장').ok, false);
  assert.equal(f.cleanup.length, 1);
  f.value.caret = { start: -1, end: 1 }; f.model.setAvailable(true);
  assert.equal((await f.model.begin()).reason, 'editor-blocked');
});

test('snapshots and insert payload cannot mutate the private pin', async () => {
  const f = fixture(), token = await review(f), snapshot = f.model.snapshot();
  assert.ok(Object.isFrozen(snapshot.pin)); assert.ok(Object.isFrozen(snapshot.pin.caret));
  assert.equal(Reflect.set(snapshot.pin.caret, 'start', 100), false);
  await f.model.insert(token);
  assert.equal(f.writes[0].caret.start, 0);
  assert.ok(Object.isFrozen(f.writes[0]));
});

test('insert and cleanup callbacks cannot start another session inside terminal cleanup', async () => {
  let f; const begins = [], cleanups = [];
  f = fixture({ insert() { begins.push(f.model.begin()); return true; },
    cleanup(reason) { cleanups.push(reason); begins.push(f.model.begin()); } });
  const token = await review(f);
  assert.equal((await f.model.insert(token)).inserted, true);
  assert.deepEqual((await Promise.all(begins)).map(r => r.reason), ['busy', 'busy']);
  assert.deepEqual(cleanups, ['inserted']);
  f.model.cancel(); assert.equal(cleanups.length, 1);
  // A later, deliberate user action can begin and owns its own cleanup.
  const next = await uploading(f); assert.ok(next > token);
  f.model.cancel(); assert.equal(cleanups.length, 2);
});

test('cleanup failure after a write reports inserted=true and cannot invite duplicate insertion', async () => {
  const f = fixture({ cleanup() { throw Error('track cleanup failed'); } });
  const token = await review(f), result = await f.model.insert(token);
  assert.equal(result.ok, true);
  assert.equal(result.inserted, true);
  assert.equal(result.reason, 'cleanup-failed');
  assert.equal(result.snapshot.state, 'inserted');
  assert.equal(result.snapshot.cleanupFailed, true);
  assert.equal((await f.model.insert(token)).ok, false);
  assert.equal(f.writes.length, 1);
});

test('capability changes inside cleanup affect the next begin without erasing a completed insert', async () => {
  let f; f = fixture({ cleanup() { f.model.setAvailable(false); } });
  const token = await review(f), result = await f.model.insert(token);
  assert.equal(result.inserted, true);
  assert.equal(result.snapshot.state, 'inserted');
  assert.equal((await f.model.begin()).reason, 'unavailable');
});

test('distinct lone surrogates cannot pass field identity just because their UTF-8 hashes agree', async () => {
  const f = fixture(); f.value.value = '\ud800';
  const token = await review(f); f.value.value = '\ud801';
  assert.equal(sha('\ud800'), sha('\ud801')); // Independent UTF-8 encoding fact.
  assert.equal((await f.model.insert(token)).reason, 'field-changed');
  assert.equal(f.writes.length, 0);
});

test('create uses its default WebCrypto path when hashText is not supplied', async () => {
  const f = fixture({ hashText: undefined }), token = await review(f);
  assert.equal(f.model.snapshot().pin.fieldValueHash, sha(f.value.value));
  assert.equal((await f.model.insert(token)).ok, true);
});

test('cleanup failure preserves the primary failure and exposes separate cleanup status', async () => {
  const f = fixture({ cleanup() { throw Error('cleanup'); } }), token = await uploading(f);
  f.model.fail(token, 'timeout');
  assert.equal(f.model.snapshot().error, 'timeout');
  assert.equal(f.model.snapshot().cleanupFailed, true);
  assert.equal(f.model.snapshot().state, 'failed');
});
