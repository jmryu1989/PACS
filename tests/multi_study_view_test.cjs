/* W9 pure composition contract (V-RESOLVE/V-PAGES/V-LIFECYCLE).
 * These synthetic resolve bodies exercise the actual public model. They do not
 * prove served-page wiring, popup reservation, renderer display, or live access.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, orderedSelection, validateResponse, errorState } = require('../worklist-v0/hpacs-lite/multi-study-view.js');
const ids = ['1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5'];
function fixture(studyUids = ids) {
  let owner = { owner: 'document-a', session: 'session-a' };
  let selected = { ...owner, generation: 1, studyUids: [...studyUids] };
  const model = create({ context: () => owner, selection: () => selected });
  return { model, chosen: () => structuredClone(selected),
    select: (uids, generation = selected.generation + 1) => { selected = { ...owner, studyUids: [...uids], generation }; },
    owner: value => { owner = value; }, open: current => model.beginOpen(structuredClone(selected), current) };
}
function answer(intent, errors = {}) {
  const members = intent.body.studyUids.map((uid, ordinal) => errors[uid]
    ? { uid, ordinal, status: 'error', code: errors[uid] }
    : { uid, ordinal, status: 'ready', metadata: { patientId: 'synthetic-patient', patientName: 'Synthetic',
      institutionName: 'Synthetic site', studyDate: '20261024', modalities: ['CT'], description: '', accession: '' },
      accessRef: `synthetic-${intent.body.requestId}-${ordinal}` });
  const count = members.filter(member => member.status === 'ready').length;
  return { compositionId: intent.body.compositionId, generation: intent.body.generation, requestId: intent.body.requestId,
    sourcePatientKey: count ? 'synthetic-site|synthetic-patient' : null,
    scopeStatus: count === members.length ? 'ready' : count ? 'partial' : 'rejected', members };
}
function admit(f, current) {
  const intent = f.open(current);
  assert.equal(f.model.finish(intent, answer(intent)).status, 'resolved');
  return intent;
}

test('selection copies visible order, moves only included reading target, and never truncates wire limits', () => {
  const original = [...ids];
  assert.deepEqual(orderedSelection(original, ids[2]), [ids[2], ids[0], ids[1], ids[3], ids[4]]);
  const frozen = orderedSelection(original, '9.9'); original.reverse();
  assert.deepEqual(frozen, ids);
  const twenty = Array.from({ length: 20 }, (_, i) => `1.2.${i}`);
  assert.equal(orderedSelection(twenty).length, 20);
  for (const invalid of [[], ids.slice(0, 1), [...ids, ids[0]], [...twenty, '1.2.20'], ['1.2', '1.02'], ['1.2', 'bad']])
    assert.equal(orderedSelection(invalid), null);
});

test('a menu must still have the same owner, generation and ordered selection, including A→B→A', () => {
  const f = fixture(), menu = f.chosen();
  f.select(ids.slice(0, 2)); f.select(ids);
  assert.equal(f.model.beginOpen(menu, null), null);
  assert.equal(f.model.snapshot().pending, false);
  const now = f.chosen();
  assert.equal(f.model.beginOpen({ ...now, session: 'session-b' }, null), null);
  assert.equal(f.model.beginOpen({ ...now, studyUids: [...ids].reverse() }, null), null);
  assert.ok(f.open());
});

test('initial admission requires everyone ready; partial and zero-ready never supply a launch plan', () => {
  const f = fixture();
  for (const errors of [{ [ids[1]]: 'W9_LOAD_FAILED' }, Object.fromEntries(ids.map(uid => [uid, 'W9_MEMBER_UNAVAILABLE']))]) {
    const intent = f.open();
    assert.equal(f.model.finish(intent, answer(intent, errors)).status, 'not-admitted');
    assert.equal(f.model.snapshot().composition, null);
    assert.equal(f.model.snapshot().attempt.status, 'Not Opened');
  }
  admit(f, ids[3]);
  assert.deepEqual(f.model.snapshot().composition.studyUids, [ids[3], ids[0], ids[1], ids[2], ids[4]]);
  assert.equal(f.model.snapshot().attempt.status, 'Ready');
});

test('missing, contradictory and miscorrelated responses cannot authorize a launch', () => {
  const f = fixture(), intent = f.open();
  assert.ok(validateResponse(intent.body, answer(intent)));
  const changes = [
    r => { r.requestId = 'old'; }, r => { r.compositionId = 'old'; }, r => { r.generation++; },
    r => { r.members.pop(); }, r => { r.members.reverse(); }, r => { r.members[1].ordinal = 0; },
    r => { r.members[1].uid = ids[0]; }, r => { r.members[0].metadata = null; },
    r => { r.members[0].metadata.modalities = 'CT'; }, r => { r.members[0].accessRef = ''; },
    r => { r.members[1].accessRef = r.members[0].accessRef; }, r => { r.members[0].code = 'W9_LOAD_FAILED'; },
    r => { r.scopeStatus = 'partial'; }, r => { r.sourcePatientKey = null; },
    r => { r.sourcePatientKey = 'bad\nkey'; },
  ];
  for (const change of changes) { const r = answer(intent); change(r); assert.equal(validateResponse(intent.body, r), null); }
  assert.equal(validateResponse(intent.body, null), null);
  assert.equal(f.model.finish(intent, {}).status, 'failed');
  assert.equal(f.model.snapshot().composition, null);
});

test('wire error members preserve each code and contain no cached identity or access reference', () => {
  const f = fixture(), intent = f.open();
  const codes = ['W9_MEMBER_UNAVAILABLE', 'W9_SCOPE_EXCLUDED', 'W9_IDENTITY_UNAVAILABLE', 'STUDY_IDENTITY_UNRESOLVED', 'W9_LOAD_FAILED'];
  const reply = answer(intent, Object.fromEntries(ids.map((uid, i) => [uid, codes[i]])));
  assert.deepEqual(validateResponse(intent.body, reply).members.map(m => m.code), codes);
  reply.members[0].metadata = { patientId: 'stale' };
  assert.equal(validateResponse(intent.body, reply), null);
});

test('all fixed pages keep the odd member and re-resolve frozen N after filtering and clearing selection', () => {
  for (const count of [3, 5, 20]) {
    const all = Array.from({ length: count }, (_, i) => `1.2.${i}`), f = fixture(all), first = admit(f);
    f.select([]);
    for (let page = 0; page < Math.ceil(count / 2); page++) {
      const intent = f.model.beginPage(page);
      assert.deepEqual(intent.body.studyUids, all);
      assert.equal(intent.body.expectedSourcePatientKey, 'synthetic-site|synthetic-patient');
      assert.notEqual(intent.body.requestId, first.body.requestId);
      const plan = f.model.finish(intent, answer(intent));
      assert.deepEqual(plan.members.map(m => m.uid), all.slice(page * 2, page * 2 + 2));
      assert.equal(plan.priorUid, all[page * 2 + 1] ?? null);
    }
    assert.equal(f.model.beginPage(Math.ceil(count / 2)), null);
    assert.equal(f.model.beginPage(-1), null);
  }
});

test('reverse pair and singleton keep the last fixed page for Back to Pages', () => {
  const f = fixture(); admit(f);
  let intent = f.model.beginPage(1); f.model.finish(intent, answer(intent));
  intent = f.model.beginCompare([ids[4], ids[0]]);
  let plan = f.model.finish(intent, answer(intent));
  assert.deepEqual([plan.uid, plan.priorUid], [ids[4], ids[0]]);
  intent = f.model.beginSingle(ids[1]); plan = f.model.finish(intent, answer(intent));
  assert.deepEqual([plan.uid, plan.priorUid], [ids[1], null]);
  assert.deepEqual(f.model.backToPages().activeUids, ids.slice(2, 4));
  for (const pair of [[ids[0], ids[0]], [ids[0], '9.9'], [ids[0]], ids]) assert.equal(f.model.beginCompare(pair), null);
});

test('partial page keeps error slots; singleton retry uses whole N and explicitly preserves the partner', () => {
  const f = fixture(); admit(f);
  let intent = f.model.beginPage(1);
  let plan = f.model.finish(intent, answer(intent, { [ids[2]]: 'W9_LOAD_FAILED' }));
  assert.deepEqual(plan.activeUids, ids.slice(2, 4));
  assert.deepEqual([plan.uid, plan.priorUid], [ids[3], null]);
  assert.deepEqual(f.model.snapshot().composition.members[2], { uid: ids[2], ordinal: 2, status: 'error', code: 'W9_LOAD_FAILED' });
  intent = f.model.beginRetry(ids[2]);
  assert.deepEqual(intent.body.studyUids, ids);
  plan = f.model.finish(intent, answer(intent));
  assert.equal(plan.preservePartner, true);
  assert.deepEqual([plan.uid, plan.priorUid], [ids[2], null]);
  assert.equal(f.model.snapshot().composition.page, 1);
});

test('ready members outside the requested page do not open; rejected navigation supplies no viewer UID', () => {
  const f = fixture(); admit(f);
  let intent = f.model.beginPage(2);
  let plan = f.model.finish(intent, answer(intent, { [ids[4]]: 'W9_LOAD_FAILED' }));
  assert.equal(plan.status, 'not-opened'); assert.deepEqual(plan.members, []); assert.equal(plan.uid, null);
  intent = f.model.beginPage(0);
  plan = f.model.finish(intent, answer(intent, Object.fromEntries(ids.map(uid => [uid, 'W9_MEMBER_UNAVAILABLE']))));
  assert.equal(plan.status, 'not-opened'); assert.equal(plan.uid, null);
  assert.equal(f.model.snapshot().composition.sourcePatientKey, 'synthetic-site|synthetic-patient');
});

test('a failed new set preserves the admitted composition and retries its own frozen candidate', () => {
  const f = fixture(); admit(f);
  const prior = f.model.snapshot().composition;
  f.select(['2.1', '2.2', '2.3']);
  let intent = f.open();
  f.model.finish(intent, answer(intent, { '2.2': 'W9_LOAD_FAILED' }));
  assert.deepEqual(f.model.snapshot().composition, prior);
  f.select([]);
  const retried = f.model.beginRetry('2.2');
  assert.deepEqual(retried.body.studyUids, ['2.1', '2.2', '2.3']);
  assert.deepEqual(retried.activeUids, ['2.1', '2.2']);
  assert.equal(retried.body.expectedSourcePatientKey, null);
  assert.notEqual(retried.body.requestId, intent.body.requestId);
  f.model.fail(retried, { status: 503, code: 'W9_AUDIT_UNAVAILABLE' });
  assert.deepEqual(f.model.snapshot().composition, prior);
});

test('uncoded 503 stays a generic load failure; coded audit and context failures remain distinct', () => {
  assert.notEqual(errorState({ status: 503 }).message, errorState({ status: 503, code: 'W9_AUDIT_UNAVAILABLE' }).message);
  const f = fixture(); admit(f);
  const intent = f.model.beginPage(1);
  f.model.fail(intent, { status: 409, code: 'W9_PATIENT_MISMATCH' });
  assert.equal(f.model.snapshot().attempt.status, 'Context Changed');
  assert.equal(f.model.beginRetry(ids[0]), null);
  assert.equal(f.model.beginPage(0), null);
  assert.ok(f.open());
});

test('changed expected patient key cannot become fresh ready metadata', () => {
  const f = fixture(); admit(f);
  const intent = f.model.beginPage(1), reply = answer(intent);
  reply.sourcePatientKey = 'another-patient';
  assert.equal(f.model.finish(intent, reply).status, 'failed');
  assert.equal(f.model.snapshot().composition.sourcePatientKey, 'synthetic-site|synthetic-patient');
});

test('cancelled and superseded A→B→A replies cannot replace the latest request', () => {
  const f = fixture(), a1 = f.open();
  f.select(['2.1', '2.2']); const b = f.open();
  f.select(ids); const a2 = f.open();
  assert.equal(f.model.finish(a1, answer(a1)).status, 'ignored');
  assert.equal(f.model.finish(b, answer(b)).status, 'ignored');
  assert.equal(f.model.finish(a2, answer(a2)).status, 'resolved');
  const intent = f.model.beginPage(1); f.model.cancel();
  assert.equal(f.model.finish(intent, answer(intent)).status, 'ignored');
  assert.equal(f.model.snapshot().composition.page, 0);
});

test('owner/session loss ends in-memory composition and rejects late results and restored owner', () => {
  const f = fixture(); admit(f);
  const intent = f.model.beginPage(1);
  f.owner({ owner: 'document-a', session: 'session-b' });
  assert.equal(f.model.finish(intent, answer(intent)).status, 'ignored');
  assert.equal(f.model.snapshot().composition, null);
  f.owner({ owner: 'document-a', session: 'session-a' });
  assert.equal(f.open(), null);
});

test('returned snapshots and reply objects cannot mutate frozen membership or subsequent request metadata', () => {
  const f = fixture(), intent = f.open(), reply = answer(intent);
  assert.throws(() => intent.body.studyUids.push('9.9'), TypeError);
  f.model.finish(intent, reply);
  reply.members[0].metadata.patientName = 'changed';
  const state = f.model.snapshot(); state.composition.studyUids.reverse();
  assert.deepEqual(f.model.beginPage(1).body.studyUids, ids);
  assert.equal(f.model.snapshot().composition.members[0].metadata.patientName, 'Synthetic');
  f.model.end(); assert.equal(f.model.snapshot().composition, null);
});
