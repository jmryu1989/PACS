// Image Report: the drawing list of my report draft in the draft command path (worklist-v0/hpacs-lite/report-draft-client.js).
// A draft carries its drawing list in one of three states: no list (the draft leaves the report's drawings as they are),
// an empty list (it removes them) and a list of ids. After a conflict or a lost answer the client reads the server's
// draft and continues by itself only on a draft this document saw. These cases hold that "saw" includes the drawing
// list: the same text with another list (a removal that is gone, a drawing attached elsewhere) is a conflict, and
// nothing is sent on top of it.
// Every request names the list (null, [] or ids) and a commit also the list the page shows as the version's; the
// server compares both (409 REPORT_DRAWINGS_CONFLICT). The lists are fixed for a command and its retry, a list this
// line has not confirmed never passes, and a lost answer is taken only as the exact result of a remove.
// Run with: node --test tests/image_report_draft_client_test.cjs
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create, sameSnapshot, holdsDraft, FIELDS } = require('../worklist-v0/hpacs-lite/report-draft-client.js');

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

test('autosave: a text draft without any drawing list names "no list" (null, never an empty list) and continues as before', async () => {
  const { client, calls, methods } = site([envelope(PLAIN, 3), CONFLICT, envelope(PLAIN, 4), stored(5)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'PUT']);
  assert.equal(calls[1].json.drawingIds, null);
  assert.equal(calls[3].json.drawingIds, null);
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

// A lost answer of an attach has no exception: the new drawing's id is the server's, so a draft with one more drawing
// cannot be told from another tab's attach. The reader chooses; the operation is never sent a second time.
test('attach: a lost answer is not taken by its shape - a draft with one more drawing at the next revision is a conflict', async () => {
  const { client, calls, methods } = site([envelope(PLAIN, 3), LOST, envelope(whole(TEXT, ['SYN-new']), 4), stored(5)]);
  await opened(client, SHOWN, 3);
  client.shown(UID, { revision: 'e1:3', effective: [], head: [] });
  const result = await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH });
  assert.equal(result.outcome, 'conflict');
  assert.equal(client.revision(UID), 'e1:3', 'the baseline did not move to a draft with a drawing this line cannot prove');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET'], 'the attach is not sent again');
  // The reader chooses (Keep This Text: this text on the server's draft and its drawings); then the line stands there.
  assert.equal(client.resolve(UID), true);
  assert.deepEqual(client.lists(UID).drawings, ['SYN-new']);
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(calls[3].json.drawingIds, ['SYN-new']);
  assert.equal(calls[3].json.expectedRevision, 'e1:4');
});

test('attach: a lost answer that landed late is a conflict for the next command, which sends nothing', async () => {
  const { client, methods } = site([envelope(whole(TEXT, ['SYN-a']), 3), LOST, envelope(whole(TEXT, ['SYN-a']), 3),
    envelope(whole(TEXT, ['SYN-a', 'SYN-new']), 4)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH })).outcome, 'unknown');
  assert.equal(client.revision(UID), 'e1:3');
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'conflict');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'GET']);
});

test('attach: a lost answer does not make a draft that lost a drawing mine', async () => {
  // Attach was sent on [SYN-a]; what the server holds later is the same text with no list at all: not what an attach leaves.
  const { client, methods } = site([envelope(whole(TEXT, ['SYN-a']), 3), LOST, envelope(PLAIN, 5)]);
  await opened(client, SHOWN, 3);
  const result = await client.write(UID, TEXT, { owner: OWNER, operation: ATTACH });
  assert.equal(result.outcome, 'conflict');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET']);
});

// A lost answer of a remove is taken only as its exact result: what the page showed when Remove was pressed (the list
// a version would hold and the head version's own) says what the draft holds afterwards - a list, no list, or no draft.
const EMPTY = { findings: '', conclusion: '', recommendation: '', baseVersion: 1 };
const REMOVE_A = { removeDrawing: 'SYN-a' };
/** One remove of SYN-a whose answer is lost, then the read `after`; returns the write's result and the site. */
async function lostRemove({ texts = TEXT, held, shown, after }) {
  const made = site([envelope(held === undefined ? null : whole(texts, held), 3), LOST, after]);
  await opened(made.client, held === undefined ? null : { ...texts, at: SHOWN.at }, 3);
  if (shown) made.client.shown(UID, { revision: 'e1:3', ...shown });
  return { ...made, result: await made.client.write(UID, texts, { owner: OWNER, operation: REMOVE_A }) };
}

test('remove: a lost answer is found by its exact result - the list without that drawing', async () => {
  // Both drawings are the draft's own (the head holds none): the draft keeps a list, exactly [SYN-b].
  const shown = { effective: ['SYN-a', 'SYN-b'], head: [] };
  const found = await lostRemove({ held: ['SYN-a', 'SYN-b'], shown, after: envelope(whole(TEXT, ['SYN-b']), 4) });
  assert.equal(found.result.outcome, 'saved');
  assert.equal(found.result.confirmedByRead, true);
  assert.equal(found.client.revision(UID), 'e1:4');
  assert.deepEqual(found.client.lists(UID).drawings, ['SYN-b']);
  assert.deepEqual(found.methods(), ['GET', 'PUT', 'GET'], 'the remove is not sent again');
  // The same draft without any list is not what this remove leaves: not taken.
  const other = await lostRemove({ held: ['SYN-a', 'SYN-b'], shown, after: envelope(PLAIN, 4) });
  assert.equal(other.result.outcome, 'conflict');
  assert.equal(other.client.revision(UID), 'e1:3');
});

test('remove: a lost answer is found by its exact result - no list, when the drawings are the head\'s again', async () => {
  // SYN-b came from the head, SYN-a was attached in the draft: without SYN-a the draft changes nothing and holds no list.
  const shown = { effective: ['SYN-a', 'SYN-b'], head: ['SYN-b'] };
  const found = await lostRemove({ held: ['SYN-a', 'SYN-b'], shown, after: envelope(PLAIN, 4) });
  assert.equal(found.result.outcome, 'saved');
  assert.equal(Object.hasOwn(found.client.lists(UID), 'drawings'), false);
  // A list [SYN-b] is another draft (the server would hold none): not taken.
  assert.equal((await lostRemove({ held: ['SYN-a', 'SYN-b'], shown, after: envelope(whole(TEXT, ['SYN-b']), 4) })).result.outcome, 'conflict');
});

test('remove: a lost answer that ended a draft without text is that remove - no conflict is left', async () => {
  const found = await lostRemove({ texts: EMPTY, held: ['SYN-a'], shown: { effective: ['SYN-a'], head: [] }, after: envelope(null, 4) });
  assert.equal(found.result.outcome, 'saved');
  assert.equal(found.result.envelope.present, false);
  assert.equal(found.client.conflict(UID), null);
  assert.equal(found.client.revision(UID), 'e1:4');
  assert.equal(found.client.uncertain(UID), false);
});

test('remove: removing the head\'s last drawing leaves an empty list - "no draft" is not that result', async () => {
  // No draft; the head holds SYN-a. The remove makes a draft that holds the removal (an empty list), text or not.
  const shown = { effective: ['SYN-a'], head: ['SYN-a'] };
  const kept = await lostRemove({ texts: EMPTY, shown, after: envelope(whole(EMPTY, []), 4) });
  assert.equal(kept.result.outcome, 'saved');
  assert.deepEqual(kept.client.lists(UID).drawings, []);
  const gone = await lostRemove({ texts: EMPTY, shown, after: envelope(null, 4) });
  assert.equal(gone.result.outcome, 'conflict', 'a draft that is not there is not the removal draft');
  // And the other way: a draft the remove would end is not "an empty list".
  const ended = await lostRemove({ texts: EMPTY, held: ['SYN-a'], shown: { effective: ['SYN-a'], head: [] }, after: envelope(whole(EMPTY, []), 4) });
  assert.equal(ended.result.outcome, 'conflict');
});

test('remove: a lost answer is not taken on another tab\'s attach, two revisions on, in another epoch, or without a shown list', async () => {
  const shown = { effective: ['SYN-a', 'SYN-b'], head: [] }, held = ['SYN-a', 'SYN-b'];
  // Another tab attached at the very next revision: the list is not what the remove leaves.
  assert.equal((await lostRemove({ held, shown, after: envelope(whole(TEXT, ['SYN-a', 'SYN-b', 'SYN-z']), 4) })).result.outcome, 'conflict');
  assert.equal((await lostRemove({ held, shown, after: envelope(whole(TEXT, ['SYN-b', 'SYN-z']), 4) })).result.outcome, 'conflict');
  // The exact list, but two revisions on: other changes came between.
  const far = await lostRemove({ held, shown, after: envelope(whole(TEXT, ['SYN-b']), 5) });
  assert.equal(far.result.outcome, 'conflict');
  assert.deepEqual(far.methods(), ['GET', 'PUT', 'GET']);
  // The exact list in another epoch (the drafts were released in between).
  const epoch = envelope(whole(TEXT, ['SYN-b']), 4);
  epoch.body.revision = 'e2:1';
  assert.equal((await lostRemove({ held, shown, after: epoch })).result.outcome, 'conflict');
  // The page showed no list (its read failed): nothing can be proved by a result.
  assert.equal((await lostRemove({ held, after: envelope(whole(TEXT, ['SYN-b']), 4) })).result.outcome, 'conflict');
});

test('remove: a lost answer found later by the next command is taken by the same exact result', async () => {
  const { client, calls, methods } = site([envelope(whole(TEXT, ['SYN-a', 'SYN-b']), 3), LOST, envelope(whole(TEXT, ['SYN-a', 'SYN-b']), 3),
    envelope(whole(TEXT, ['SYN-b']), 4), stored(5)]);
  await opened(client, SHOWN, 3);
  client.shown(UID, { revision: 'e1:3', effective: ['SYN-a', 'SYN-b'], head: [] });
  assert.equal((await client.write(UID, TEXT, { owner: OWNER, operation: REMOVE_A })).outcome, 'unknown');
  assert.equal((await client.write(UID, EDIT, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'PUT', 'GET', 'GET', 'PUT']);
  assert.deepEqual(calls[4].json.drawingIds, ['SYN-b']);
  assert.equal(calls[4].json.removeDrawing, undefined, 'the remove is not sent again');
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

// ── the lists a request names: confirmed, fixed for the command, and never taken from a later revision ──
const DRAWINGS = { ok: false, status: 409, code: 'REPORT_DRAWINGS_CONFLICT', body: { code: 'REPORT_DRAWINGS_CONFLICT' } };
const DONE = n => ({ ok: true, status: 200, body: { uid: UID, owner: OWNER, revision: 'e1:' + n, present: false, snapshot: null, state: { rs: 'T', version: 2 } } });
const SAVE = { action: 'save', baseVersion: 1, ...TEXT };

test('first read: a draft at the revision the page drew is the baseline; one that has moved on is not taken', async () => {
  // The page drew the draft of revision 3; the first whole read already finds revision 4 (another tab attached a drawing).
  for (const later of [whole(TEXT, ['SYN-other']), PLAIN]) {
    const { client, methods } = site([envelope(later, 4), envelope(later, 4)]);
    await opened(client, SHOWN, 3);
    assert.equal(client.lists(UID), null, 'the later draft\'s lists are not this line\'s');
    assert.equal(client.revision(UID), 'e1:3');
    // A command reads again and finds a draft it cannot place: a conflict, and nothing is sent.
    const result = await client.commit(UID, SAVE, { owner: OWNER });
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(methods(), ['GET', 'GET']);
    assert.equal(client.revision(UID), 'e1:3');
  }
});

test('commit: names my draft\'s list and the list the page shows, and a retry after a 409 carries the same lists', async () => {
  const moved = call => { client.shown(UID, { revision: 'e1:4', effective: ['SYN-late'], head: [] }); return envelope(REMOVED, 4); };
  const { client, calls, methods } = site([envelope(REMOVED, 3), CONFLICT, moved, DONE(5)]);
  await opened(client, SHOWN, 3);
  client.shown(UID, { revision: 'e1:3', effective: [], head: ['SYN-head'] });
  const result = await client.commit(UID, SAVE, { owner: OWNER });
  assert.equal(result.outcome, 'saved');
  assert.deepEqual(methods(), ['GET', 'POST', 'GET', 'POST']);
  for (const at of [1, 3]) {
    assert.deepEqual(calls[at].json.drawingIds, []);
    assert.deepEqual(calls[at].json.expectedEffectiveDrawingIds, [], 'the list shown when the command started, not one shown since');
  }
  assert.deepEqual(result.named, { drawingIds: [], expectedEffectiveDrawingIds: [] });
});

test('commit: a page that has shown no list names none - not an empty one - and "not shown" replaces an earlier list', async () => {
  const { client, calls } = site([envelope(PLAIN, 3), DONE(4)]);
  await opened(client, SHOWN, 3);
  client.shown(UID, { revision: 'e1:3', effective: ['SYN-a'], head: ['SYN-a'] });
  client.shown(UID, null);   // the list read failed afterwards
  assert.equal((await client.commit(UID, SAVE, { owner: OWNER })).outcome, 'saved');
  assert.equal(calls[1].json.drawingIds, null);
  assert.equal(Object.hasOwn(calls[1].json, 'expectedEffectiveDrawingIds'), false);
});

test('shown: a list read older than this line\'s revision is a late answer and is not taken', async () => {
  const { client, calls } = site([envelope(PLAIN, 3), DONE(4)]);
  await opened(client, SHOWN, 3);
  assert.equal(client.shown(UID, { revision: 'e1:3', effective: ['SYN-a'], head: ['SYN-a'] }), true);
  assert.equal(client.shown(UID, { revision: 'e1:2', effective: [], head: [] }), false);
  await client.commit(UID, SAVE, { owner: OWNER });
  assert.deepEqual(calls[1].json.expectedEffectiveDrawingIds, ['SYN-a']);
});

for (const [name, method, send] of [
  ['commit', 'POST', client => client.commit(UID, SAVE, { owner: OWNER })],
  ['discard', 'DELETE', client => client.discard(UID, { owner: OWNER })],
  ['write', 'PUT', client => client.write(UID, EDIT, { owner: OWNER })]])
  test(`${name}: the server's refusal of the named drawings is a conflict for the reader - not re-based, not sent again`, async () => {
    const { client, calls, methods } = site([envelope(REMOVED, 3), DRAWINGS, envelope(REMOVED, 3), envelope(REMOVED, 3), stored(4)]);
    await opened(client, SHOWN, 3);
    const result = await send(client);
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.drawings, true);
    assert.deepEqual(methods(), ['GET', method, 'GET'], 'one ' + name + ', one read of the latest draft, nothing sent again');
    assert.deepEqual(calls[1].json.drawingIds, [], 'the request named the list of the draft it stands on');
    assert.equal(client.conflict(UID).drawings, true);
    // A later read that follows this line does not end it: the lists still differ, the reader chooses.
    const again = await client.latest(UID, { owner: OWNER });
    assert.notEqual(again.resolved, true);
    assert.ok(client.conflict(UID));
    // The choice makes the latest draft the baseline; the next write names that draft's list.
    assert.equal(client.resolve(UID), true);
    assert.equal((await client.write(UID, { ...EDIT, findings: 'SYN text, after the choice' }, { owner: OWNER })).outcome, 'saved');
    assert.deepEqual(calls[4].json.drawingIds, []);
  });

test('the refusal of the named drawings whose read failed keeps the conflict until the reader can choose', async () => {
  const down = { ok: false, status: 502, body: {} };
  const { client, methods } = site([envelope(PLAIN, 3), DRAWINGS, down, envelope(PLAIN, 3)]);
  await opened(client, SHOWN, 3);
  const result = await client.commit(UID, SAVE, { owner: OWNER });
  assert.equal(result.outcome, 'conflict');
  assert.equal(client.conflict(UID).latest, null);
  // The same notice reads again: the latest draft is there to choose from, and the conflict is still the reader's.
  const got = await client.latest(UID, { owner: OWNER });
  assert.equal(got.outcome, 'read');
  assert.notEqual(got.resolved, true);
  assert.ok(client.conflict(UID).latest);
  assert.deepEqual(methods(), ['GET', 'POST', 'GET', 'GET']);
});

test('batch commit (pinned): names "no list" and no list of the version; the refusal is told as drawings', async () => {
  const { client, calls } = site([DRAWINGS]);
  assert.equal(client.observe(UID, 'e1:3', null), true);
  const result = await client.commit(UID, SAVE, { owner: OWNER, pinned: { revision: 'e1:3' } });
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.drawings, true);
  assert.equal(calls[0].json.drawingIds, null);
  assert.equal(Object.hasOwn(calls[0].json, 'expectedEffectiveDrawingIds'), false);
  assert.equal(calls.length, 1);
});

test('discard: names the list of the draft it ends', async () => {
  const { client, calls } = site([envelope(whole(TEXT, ['SYN-a']), 3), DONE(4)]);
  await opened(client, SHOWN, 3);
  assert.equal((await client.discard(UID, { owner: OWNER })).outcome, 'saved');
  assert.deepEqual(calls[1].json.drawingIds, ['SYN-a']);
});

test('"is there a draft" is one judgement: text, or a drawing list - an empty one too', () => {
  assert.equal(holdsDraft({ ...EMPTY }), false);
  assert.equal(holdsDraft({ ...EMPTY, drawings: [] }), true);
  assert.equal(holdsDraft({ ...EMPTY, drawings: ['SYN-a'] }), true);
  assert.equal(holdsDraft({ ...TEXT }), true);
  assert.equal(holdsDraft({ ...EMPTY, drawings: null }), false);
});