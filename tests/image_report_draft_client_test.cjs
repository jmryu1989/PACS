// Image Report: the drawing list of my report draft in the draft command path (worklist-v0/hpacs-lite/report-draft-client.js).
// A draft carries its drawing list in one of three states: no list (the draft leaves the report's drawings as they are),
// an empty list (it removes them) and a list of ids. After a conflict or a lost answer the client reads the server's
// draft and continues by itself only on a draft this document saw. These cases hold that "saw" includes the drawing
// list: the same text with another list (a removal that is gone, a drawing attached elsewhere) is a conflict, and
// nothing is sent on top of it. Run with: node --test tests/image_report_draft_client_test.cjs
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create, sameSnapshot, FIELDS } = require('../worklist-v0/hpacs-lite/report-draft-client.js');

const OWNER = { institution: 'SYN-INST', sub: 'syn-sub', author: 'syn-reader@SYN' };
const UID = '1.2.826.0.1.3680043.10.7707.137';
const TEXT = { findings: 'SYN text', conclusion: '', recommendation: '', baseVersion: 1 };
const EDIT = { ...TEXT, findings: 'SYN text, edited' };
const whole = (texts, drawings) => ({ ...texts, citations: [], structured: [], ...(drawings ? { drawings } : {}) });
const REMOVED = whole(TEXT, []);          // my draft removes the report's drawings
const PLAIN = whole(TEXT);                // the same text, no drawing list
// What the page hands to observe(): the draft of the report state (three texts, base version, time) - no lists.
const SHOWN = { ...TEXT, at: '2026-11-14T00:00:00.000Z' };

function site(answers) {
  const calls = [];
  const transport = { request: async (url, opts) => {
    const call = { method: opts.method || 'GET', url, json: opts.json };
    calls.push(call);
    const next = answers.shift();
    assert.ok(next, 'unexpected request: ' + call.method + ' ' + url);
    return typeof next === 'function' ? next(call) : next;
  } };
  return { calls, client: create({ transport, base: '/api' }), methods: () => calls.map(c => c.method) };
}
const envelope = (snapshot, n, extra = {}) => ({ ok: true, status: 200,
  body: { uid: UID, owner: OWNER, revision: 'e1:' + n, present: snapshot !== null, snapshot, ...extra } });
const CONFLICT = { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT', body: { code: 'REPORT_DRAFT_CONFLICT' } };
const LOST = () => { throw Object.assign(new Error('SYN answer lost'), { sent: true }); };
/** The server stored exactly what this PUT carried, at revision n. */
const stored = n => call => envelope({ findings: call.json.findings, conclusion: call.json.conclusion,
  recommendation: call.json.recommendation, baseVersion: call.json.baseVersion, citations: call.json.citationIds,
  structured: call.json.structureIds, ...(call.json.drawingIds ? { drawings: call.json.drawingIds } : {}) }, n);

/** The preservation loop of the log out preparation and Recover Draft (work-exit.js): base, capture, preserve, once more after `rebased`. */
async function preserveAsLogout(client, texts) {
  for (let round = 0; ; round += 1) {
    const base = await client.base(UID, { owner: OWNER });
    if (base.outcome === 'conflict' && !base.latest) {
      const got = await client.latest(UID, { owner: OWNER });
      if (got.resolved && round === 0) continue;
    }
    if (base.outcome !== 'ready') return base.outcome;
    const snapshot = { ...texts, citations: base.lists.citations, structured: base.lists.structured,
      ...(base.lists.drawings ? { drawings: base.lists.drawings } : {}) };
    if (sameSnapshot(base.stored, FIELDS.every(k => !texts[k]) && !base.lists.drawings ? null : snapshot)) return 'saved';
    const result = await client.preserve({ uid: UID, owner: OWNER, expectedRevision: base.revision, snapshot });
    if (result.outcome === 'saved') return 'saved';
    if (result.outcome === 'rebased' && round === 0) continue;
    return result.outcome;
  }
}
/** The editor opened the study: the page observes the shown draft, then the line reads the whole draft once. */
async function opened(client, shown, n) {
  assert.equal(client.observe(UID, 'e1:' + n, shown), true);
  await client.prime(UID, { owner: OWNER });
}

for (const [name, shown] of [['the page shows the draft texts only', SHOWN], ['the observation names the removal', REMOVED]])
  test(`preservation: the removal draft is not re-based onto the same text without its list (${name})`, async () => {
    const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, envelope(PLAIN, 5)]);
    await opened(client, shown, 3);
    assert.deepEqual(client.lists(UID).drawings, []);
    const outcome = await preserveAsLogout(client, EDIT);
    assert.equal(outcome, 'conflict');
    // The line read the draft, sent the capture with its empty list, read again - and sent nothing on the draft it found.
    assert.deepEqual(methods(), ['GET', 'PUT', 'GET']);
    assert.deepEqual(calls[1].json.drawingIds, []);
    assert.equal(calls[1].json.expectedRevision, 'e1:3');
    assert.ok(client.conflict(UID), 'the conflict stays for the reader to decide');
    assert.equal(client.revision(UID), 'e1:3', 'the baseline did not move to the draft that lost the removal');
  });

test('preservation: the same text with the same removal list is mine - re-based, and the retry carries the list', async () => {
  const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, envelope(REMOVED, 5), stored(6)]);
  await opened(client, SHOWN, 3);
  assert.equal(await preserveAsLogout(client, EDIT), 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'PUT']);
  assert.equal(calls[3].json.expectedRevision, 'e1:5');
  assert.deepEqual(calls[3].json.drawingIds, [], 'the removal went with the retried capture');
  assert.deepEqual(client.lists(UID).drawings, []);
});

for (const [name, theirs] of [['a drawing attached elsewhere', ['SYN-drawing-9']], ['a removal made elsewhere', []]])
  test(`preservation: a draft without a list is not re-based onto the same text with ${name}`, async () => {
    const { client, methods } = site([envelope(PLAIN, 3), CONFLICT, envelope(whole(TEXT, theirs), 5)]);
    await opened(client, SHOWN, 3);
    assert.equal(Object.hasOwn(client.lists(UID), 'drawings'), false);
    assert.equal(await preserveAsLogout(client, EDIT), 'conflict');
    assert.deepEqual(methods(), ['GET', 'PUT', 'GET']);
  });

test('preservation: an observation that names the list is compared before the line has read the draft', async () => {
  // No whole read yet: what the screen showed is all this line knows, and it showed the removal.
  const { client, methods } = site([CONFLICT, envelope(PLAIN, 5)]);
  assert.equal(client.observe(UID, 'e1:3', REMOVED), true);
  const result = await client.preserve({ uid: UID, owner: OWNER, expectedRevision: 'e1:3', snapshot: whole(EDIT, []) });
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(methods(), ['PUT', 'GET']);
});

test('preservation: a capture that carries a list is not re-based onto a draft without it, whatever the screen showed', async () => {
  const { client, methods } = site([CONFLICT, envelope(PLAIN, 5)]);
  assert.equal(client.observe(UID, 'e1:3', SHOWN), true);
  const result = await client.preserve({ uid: UID, owner: OWNER, expectedRevision: 'e1:3', snapshot: whole(EDIT, []) });
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(methods(), ['PUT', 'GET']);
});

test('autosave: a conflicting write is not sent again on the same text without the removal list', async () => {
  const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, envelope(PLAIN, 5)]);
  await opened(client, SHOWN, 3);
  const result = await client.write(UID, EDIT, { owner: OWNER });
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET']);
  assert.deepEqual(calls[1].json.drawingIds, []);
  // The next autosave waits for the reader too.
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'conflict');
  assert.equal(calls.length, 3);
});

test('autosave: the same text with the same list is still continued without asking (a late save of mine)', async () => {
  const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, envelope(REMOVED, 4), stored(5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(calls[3].json.drawingIds, []);
});

test('autosave: text drafts without any drawing list continue as before', async () => {
  const { client, calls, methods } = site([envelope(PLAIN, 3), CONFLICT, envelope(PLAIN, 4), stored(5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'PUT']);
  assert.equal(Object.hasOwn(calls[3].json, 'drawingIds'), false);
});

for (const [name, method, rest, send] of [
  ['commit', 'POST', 'report/commit', client => client.commit(UID, { action: 'approve', baseVersion: 1, ...TEXT }, { owner: OWNER })],
  ['discard', 'DELETE', 'draft', client => client.discard(UID, { owner: OWNER })]])
  test(`${name}: not sent again on a draft whose drawing list this document did not see`, async () => {
    const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, envelope(PLAIN, 5)]);
    await opened(client, SHOWN, 3);
    const result = await send(client);
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(methods(), ['GET', method, 'GET'], 'one ' + name + ', one read, no second ' + name);
    assert.ok(calls[1].url.endsWith('/' + rest));
    assert.equal(calls[1].json.expectedRevision, 'e1:3');
  });

test('commit: the same text and the same list at a later revision is mine - sent once more there', async () => {
  const done = { ok: true, status: 200, body: { uid: UID, owner: OWNER, revision: 'e1:5', present: false, snapshot: null, state: { rs: 'A', version: 2 } } };
  const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, envelope(REMOVED, 4), done]);
  await opened(client, SHOWN, 3);
  const result = await client.commit(UID, { action: 'approve', baseVersion: 1, ...TEXT }, { owner: OWNER });
  assert.equal(result.outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'POST', 'GET', 'POST']);
  assert.equal(calls[3].json.expectedRevision, 'e1:4');
});

test('after a lost answer: the next command does not adopt the same text without the removal list', async () => {
  // The write's answer is lost and the read finds it not recorded yet; later the draft is the old text without the list.
  const { client, methods } = site([envelope(REMOVED, 3), LOST, envelope(REMOVED, 3), envelope(PLAIN, 5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'unknown');
  assert.equal(client.uncertain(UID), true);
  const base = await client.base(UID, { owner: OWNER });
  assert.equal(base.outcome, 'conflict');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'GET']);
});

test('a conflict whose read failed is not ended by a later read of a draft with another list', async () => {
  const down = { ok: false, status: 502, body: {} };
  const { client, methods } = site([envelope(REMOVED, 3), CONFLICT, down, envelope(PLAIN, 5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'conflict');
  const got = await client.latest(UID, { owner: OWNER });
  assert.equal(got.outcome, 'read');
  assert.notEqual(got.resolved, true);
  assert.ok(client.conflict(UID));
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'GET']);
});

// ── attach and remove: the server makes the list; a lost answer is found again, a confirmed one is no standing excuse ──
const ATTACH = { drawing: { background: 'breast', strokes: [{ tool: 'pen', color: '#e0242b', points: [[0.5, 0.5]] }], png: 'SYN' } };

test('attach: a lost answer is found by the next read (the list with the new drawing is mine)', async () => {
  const { client, calls, methods } = site([envelope(PLAIN, 3), LOST, envelope(whole(TEXT, ['SYN-new']), 4), stored(5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH })).outcome, 'unknown');
  assert.equal(client.revision(UID), 'e1:4', 'the baseline moved to the attached draft');
  assert.deepEqual(client.lists(UID).drawings, ['SYN-new']);
  assert.equal(client.conflict(UID), null);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(calls[3].json.drawingIds, ['SYN-new']);
});

test('attach: a lost answer that landed late is found by the next command (not yet recorded at the first read)', async () => {
  const { client, calls, methods } = site([envelope(whole(TEXT, ['SYN-a']), 3), LOST, envelope(whole(TEXT, ['SYN-a']), 3),
    envelope(whole(TEXT, ['SYN-a', 'SYN-new']), 4), stored(5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH })).outcome, 'unknown');
  assert.equal(client.revision(UID), 'e1:3');
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'GET', 'PUT']);
  assert.deepEqual(calls[4].json.drawingIds.sort(), ['SYN-a', 'SYN-new']);
});

test('attach: a lost answer does not make a draft that lost a drawing mine', async () => {
  // Attach was sent on [SYN-a]; what the server holds later is the same text with no list at all: not what an attach leaves.
  const { client, methods } = site([envelope(whole(TEXT, ['SYN-a']), 3), LOST, envelope(PLAIN, 5)]);
  await opened(client, SHOWN, 3);
  const result = await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH });
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET']);
});

test('remove: a lost answer is found by the next read (no list, or the list without that drawing)', async () => {
  for (const left of [PLAIN, whole(TEXT, ['SYN-b'])]) {
    const { client, methods } = site([envelope(whole(TEXT, ['SYN-a', 'SYN-b']), 3), LOST, envelope(left, 4)]);
    await opened(client, SHOWN, 3);
    assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: { removeDrawing: 'SYN-a' } })).outcome, 'unknown');
    assert.equal(client.revision(UID), 'e1:4');
    assert.equal(client.conflict(UID), null);
    assert.deepEqual(methods(), ['GET', 'PUT', 'GET']);
  }
});

test('remove: a lost answer does not make a draft that still holds that drawing with others mine', async () => {
  const { client } = site([envelope(whole(TEXT, ['SYN-a']), 3), LOST, envelope(whole(TEXT, ['SYN-a', 'SYN-z']), 5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: { removeDrawing: 'SYN-a' } })).outcome, 'conflict');
});

test('attach, then remove, both confirmed: a later conflict on the same text without the list is still a conflict', async () => {
  const attached = envelope(whole(TEXT, ['SYN-saved', 'SYN-new']), 4, { drawn: { added: 'SYN-new', ids: ['SYN-saved', 'SYN-new'] } });
  const removed = envelope(whole(TEXT, ['SYN-new']), 5, { drawn: { removed: 'SYN-saved', ids: ['SYN-new'] } });
  const { client, methods } = site([envelope(whole(TEXT, ['SYN-saved']), 3), attached, removed, CONFLICT, envelope(PLAIN, 7)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH })).outcome, 'saved');
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: { removeDrawing: 'SYN-saved' } })).outcome, 'saved');
  assert.deepEqual(client.lists(UID).drawings, ['SYN-new']);
  assert.equal(await preserveAsLogout(client, EDIT), 'conflict');
  assert.deepEqual(methods(), ['GET', 'PUT', 'PUT', 'PUT', 'GET']);
});

test('remove of the last saved drawing: the kept empty list rides every later write and the preservation', async () => {
  const gone = envelope(whole(TEXT, []), 4, { drawn: { removed: 'SYN-saved', ids: [] } });
  const { client, calls } = site([envelope(whole(TEXT, ['SYN-saved']), 3), gone, stored(5), stored(6)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: { removeDrawing: 'SYN-saved' } })).outcome, 'saved');
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(calls[2].json.drawingIds, []);
  assert.equal(await preserveAsLogout(client, { ...EDIT, conclusion: 'SYN conclusion' }), 'saved');
  assert.deepEqual(calls[3].json.drawingIds, []);
  assert.deepEqual(client.lists(UID).drawings, []);
});
