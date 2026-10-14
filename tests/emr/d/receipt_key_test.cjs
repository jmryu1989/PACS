'use strict';
/* EMR-D round 5 part (c), I-RECEIPT-KEY (Astra A5R-05): an image request's receipt keeps one row per request ID while unit
 * D's register keeps one original per (record, actor, request). REQ-S5-U4p (image requests: idempotent request IDs),
 * REQ-EMR-01/07 -> RISK-D-04 (an original terminal rewritten; a "try again" answer that can never succeed) -> this file,
 * run by tests/emr/d/server_test.cjs.
 *
 * Real: ImageRequestService and its registered projection, unit D's runtime and store as composeClinicalRuntime makes them,
 * C's v2 verification of a test-only device, and the response boundary over the controller's Nest route metadata - all from
 * api/src through the TypeScript loader of tests/emr/d/response_test.cjs, so this runs wherever server_test.cjs runs.
 * Stand-ins: the emr_clinical schema functions and B1's ledger (tests/emr/d/service_fixture.cjs, rolled back with the
 * case's tables, savepoints included), study access (always allows: its rules are tests/study_access_service_test.cjs's)
 * and one in-memory image-request store whose keys refuse a second row with P2002, as PostgreSQL's unique keys do.
 * Asserted per case: what the client gets, what is sealed for each request, and what was written (rows, revisions,
 * receipts, audit rows, clinical versions). Synthetic data only.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const H = require('./response_test.cjs');
const root = process.env.KIN_EMR_D_ROOT || path.resolve(__dirname, '../../..');
const F = require('./service_fixture.cjs').compose(process.env.KIN_EMR_D_API_SRC || path.join(root, 'api', 'src'));
const { ImageRequestService } = H.load('image-request.service.ts');
const CONTROLLERS = ['image-request.controller'];

const uid = '2.25.5142', institution = 'synthetic';
const member = (name, roles) => ({ kind: 'member', institution, sub: 'synthetic-' + name + '-sub', actor: 'synthetic-' + name,
  roles, name: 'SYNTHETIC ' + name });
const clinician = member('clinician', ['clinician']), technician = member('tech', ['technician']), other = member('tech-2', ['technician']);
const owner = c => [c.institution, c.sub];
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const REUSED = e => typeof e?.getStatus === 'function' && e.getStatus() === 409 && e.getResponse()?.code === 'REQUEST_ID_REUSED';

/** The image-request tables of one case. `foreign`: receipts another transaction committed, which this case's rollbacks never undo. */
function world() {
  const store = { requests: new Map(), receipts: new Map(), audits: [] }, writes = { request: 0, update: 0, receipt: 0, audit: 0 };
  const w = { store, writes, foreign: new Map(), beforeReceipt: null };
  const taken = (key, target) => Object.assign(new Error('SYNTHETIC unique constraint ' + key), { code: 'P2002', meta: { target: [target] } });
  const query = async (strings, values) => {
    const text = strings.join('?');
    if (text.includes('"StudyState"')) return values[0] === uid ? [{ uid, institutionId: institution }] : [];
    if (text.includes('FROM "StudyImageRequest" WHERE "studyUid"')) return [...store.requests.values()].filter(r => r.studyUid === values[0]
      && r.kind === values[1] && r.requesterSub === values[2] && ['Requested', 'Accepted'].includes(r.state)).map(r => ({ id: r.id }));
    if (text.includes('FROM "StudyImageRequest" WHERE id')) { const row = store.requests.get(values[0]); return row ? [structuredClone(row)] : []; }
    throw new Error('unexpected SQL in the stub: ' + text);
  };
  const client = () => ({
    $executeRaw: async () => 0,
    $queryRaw: (strings, ...values) => query(strings, values),
    studyImageRequest: {
      create: async ({ data }) => { if (store.requests.has(data.id)) throw taken(data.id, 'id'); writes.request++; store.requests.set(data.id, structuredClone(data)); return data; },
      update: async ({ where, data }) => { writes.update++; const row = { ...store.requests.get(where.id), ...data }; store.requests.set(where.id, row); return row; },
    },
    studyImageRequestReceipt: {
      findUnique: async ({ where }) => { const row = store.receipts.get(where.requestId) ?? w.foreign.get(where.requestId); return row ? structuredClone(row) : null; },
      create: async ({ data }) => {
        await w.beforeReceipt?.(data);
        if (store.receipts.has(data.requestId) || w.foreign.has(data.requestId)) throw taken(data.requestId, 'requestId');
        writes.receipt++; store.receipts.set(data.requestId, structuredClone(data)); return data;
      },
    },
    auditLog: { create: async ({ data }) => { writes.audit++; store.audits.push(structuredClone(data)); return data; } },
  });
  w.clinical = F.attach({
    tables: {
      snapshot: () => structuredClone({ requests: [...store.requests], receipts: [...store.receipts], audits: store.audits, writes }),
      restore: s => {
        store.requests.clear(); for (const [k, v] of s.requests) store.requests.set(k, v);
        store.receipts.clear(); for (const [k, v] of s.receipts) store.receipts.set(k, v);
        store.audits.splice(0, store.audits.length, ...s.audits); Object.assign(writes, s.writes);
      },
    },
    transaction: () => client(),
    studyOf: u => (u === uid ? { institutionId: institution, teleInstitutionId: null } : null),
  });
  const base = { ...client(), $transaction: async (fn, options) =>
    fn(w.clinical.client(client(), options?.isolationLevel === 'RepeatableRead' ? w.clinical.frozen() : null)) };
  const access = { prepare: async () => {}, require: async () => {}, unchanged: async () => {}, allowed: async (_c, uids) => new Set(uids),
    snapshot: async () => ({ revision: 1, windowOpen: true, policy: { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } }) };
  w.svc = new ImageRequestService(w.clinical.client(base), access);
  /** Everything a request could have changed: rows, receipts, audit rows, clinical units and the register. */
  w.facts = () => structuredClone({ requests: [...store.requests], receipts: [...store.receipts].map(([k, r]) => [k, r.subjectSub, r.imageRequestId]),
    audits: store.audits.length, units: [...w.clinical.store.units].map(([k, u]) => [k, u.revision]),
    register: [...w.clinical.store.rows].map(([k, r]) => [k, r.state, r.terminal ? JSON.parse(r.terminal).proof.code ?? 'committed' : null]) });
  return w;
}

/** One call as a client makes it (B2's verified request; the clinician's device signs a clinical write) and its answer. */
const call = async (route, c, run, write) => {
  const req = await F.request(c, write);
  return F.answer(CONTROLLERS, route, await run(req), req);
};
// One active request per study, kind and requester (OQ-7 a): a case's second request of the clinician is of the other kind.
const create = (w, c, requestId, kind = 'image-transfer') => {
  const b = { requestId, expectedOwner: owner(c), kind, counterparty: 'SYNTHETIC receiving hospital',
    counterpartyInstitutionId: null, reason: 'SYNTHETIC reason' };
  return call('POST studies/:uid/image-requests', c, req => w.svc.create(uid, c, b, req),
    { surface: 'image-request.create', body: b, recordId: requestId, studyId: uid });
};
const change = (w, target, c, requestId, revision, action = 'accept', note = action === 'accept' ? '' : 'SYNTHETIC note') => {
  const b = { requestId, expectedOwner: owner(c), revision, action, note };
  return call('POST image-requests/:id', c, req => w.svc.change(target, c, b, req),
    { surface: 'image-request.' + action, body: b, recordId: target, studyId: uid });
};
/** The register key of one person's request (unit D's (record, actor, request)). */
const keyOf = (c, requestId) => JSON.stringify(['image-request', F.actorOf(c).identity.id, requestId]);
/** The register entry of one request: its state and sealed code (the terminal of that request). */
const sealed = (w, c, requestId) => {
  const row = w.clinical.store.rows.get(keyOf(c, requestId));
  return row ? [row.state, row.state === 'rejected' ? JSON.parse(row.terminal).proof.code : null] : null;
};
/** The facts without the register entry of one refused request (its own terminal, asserted separately). */
const without = (facts, c, requestId) => ({ ...facts, register: facts.register.filter(([k]) => k !== keyOf(c, requestId)) });

test('A5R-05 probe: another person\'s request ID on another image request is refused 409 REQUEST_ID_REUSED, sealed as such, nothing written; the original keeps its result', async () => {
  const w = world();
  await create(w, { ...clinician }, id(141));
  const first = await change(w, id(141), { ...technician }, id(142), 1);
  await create(w, { ...clinician }, id(143), 'external-image');
  const before = w.facts();
  for (const attempt of ['first send', 'resend']) {
    await assert.rejects(change(w, id(143), { ...other }, id(142), 1), REUSED, attempt + ': 409 REQUEST_ID_REUSED, never a retry-advice 503');
    assert.deepEqual(sealed(w, other, id(142)), ['rejected', 'REQUEST_ID_REUSED'], attempt + ': the request\'s own terminal is this refusal, not StorageFailed');
    assert.deepEqual(without(w.facts(), other, id(142)), before, attempt + ': no row, revision, receipt, audit row or clinical version');
  }
  assert.deepEqual([w.store.requests.get(id(143)).state, w.store.requests.get(id(143)).revision], ['Requested', 1]);
  // The original sent again answers what it committed, and moves nothing.
  const kept = w.facts();
  const again = await change(w, id(141), { ...technician }, id(142), 1);
  assert.deepEqual({ ...again, replayed: false }, first, 'the original answers its own committed result');
  assert.equal(again.replayed, true);
  assert.deepEqual(w.facts(), kept, 'the original\'s resend changes nothing');
  assert.deepEqual(sealed(w, technician, id(142)), ['committed', null]);
});

test('A5R-05 routes: a request ID a receipt of another route holds - an accept\'s ID for a create, a create\'s ID for an accept - is the same 409 with nothing written', async () => {
  const w = world();
  await create(w, { ...clinician }, id(150));
  await change(w, id(150), { ...technician }, id(151), 1);
  let before = w.facts();
  await assert.rejects(create(w, { ...clinician }, id(151), 'external-image'), REUSED, 'a create under an accept\'s request ID');
  assert.deepEqual(sealed(w, clinician, id(151)), ['rejected', 'REQUEST_ID_REUSED']);
  assert.equal(await F.runtime.unit(id(151)), null, 'no clinical unit was opened');
  assert.deepEqual(without(w.facts(), clinician, id(151)), before, 'nothing written');
  await create(w, { ...clinician }, id(152), 'external-image');
  before = w.facts();
  await assert.rejects(change(w, id(152), { ...other }, id(150), 1), REUSED, 'an accept under a create\'s request ID');
  assert.deepEqual(sealed(w, other, id(150)), ['rejected', 'REQUEST_ID_REUSED']);
  assert.deepEqual(without(w.facts(), other, id(150)), before, 'nothing written');
  // The same person's own request ID on another request was already refused by unit D (another meaning): the same answer.
  before = w.facts();
  await assert.rejects(change(w, id(152), { ...technician }, id(151), 1), REUSED, 'the same person\'s request ID on another request');
  assert.deepEqual(w.facts(), before);
});

test('A5R-05 race: a receipt another transaction commits under the same ID while this request commits is the same 409, sealed, its row update undone', async () => {
  const w = world();
  await create(w, { ...clinician }, id(160));
  const before = w.facts();
  // Another transaction commits a receipt under id(161) after this request's commit has begun and updated its row.
  w.beforeReceipt = async data => { if (data.requestId === id(161)) w.foreign.set(id(161), { requestId: id(161), subjectSub: 'synthetic-elsewhere', imageRequestId: id(999) }); };
  await assert.rejects(change(w, id(160), { ...technician }, id(161), 1), REUSED, 'the receipt key refuses it: 409, not 503');
  w.beforeReceipt = null;
  assert.deepEqual(sealed(w, technician, id(161)), ['rejected', 'REQUEST_ID_REUSED']);
  assert.deepEqual(without(w.facts(), technician, id(161)), before, 'the request row update and every other write of the refused request are undone');
  await assert.rejects(change(w, id(160), { ...technician }, id(161), 1), REUSED, 'its resend answers the same refusal');
  assert.deepEqual([w.store.requests.get(id(160)).state, w.store.requests.get(id(160)).revision], ['Requested', 1]);
  // A fresh request ID still accepts the request.
  const accepted = await change(w, id(160), { ...technician }, id(162), 1);
  assert.deepEqual([accepted.applied.action, accepted.applied.revision], ['accept', 2]);
});
