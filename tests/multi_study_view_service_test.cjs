'use strict';
/* W9-API (W9-LITE server half, D1500): the compiled viewing-set resolve - service, controller, Orthanc read and the real
 * StudyAccess service and interceptor - over a StudyState-only Prisma double, an Orthanc double with real AbortSignal
 * semantics and a recording access-record port.
 *
 * W9L-01 (server) -> W9L-R01 -> T02;  W9L-02 -> W9L-R02 -> T03, T04, T18;  W9L-06 (server) -> W9L-R06 -> T10, T18;
 * W9L-07 (server) -> W9L-R07 -> the no-write assertions of T10/T18;  W9L-08 (server) -> W9L-R08 -> T16 (route key,
 * EMR classification and clinician denial read from the real Nest metadata). Spec mutants M01 M04 M05 M06 M15 M17 and the
 * server extras are tests/multi_study_view_mutants.py; each names the case and the assertion message that must fail.
 *
 * What the doubles are (D1444/D1447 fidelity): Prisma answers studyState.findMany from a store by its where/select and the
 * StudyAccessPolicy row by the subject the real StudyAccessService asks for; every other model and every write is recorded
 * and refused (W9L-07). The Orthanc double answers viewingSetStudy per UID, counts concurrent reads, and a pending read
 * settles on the signal it was given (a late answer that ignores the signal models a source answering after the
 * deadline); studyIdentityResources/studyIdentities answer the real StudyAccessService's preparation. The port double
 * records the provision and answers receipts, an append failure or an incomplete receipt set; it builds no AccessEvent and
 * never stands for the ledger: this unit binds no ledger (D1500 D-2/D-6), the production binding is
 * ViewingSetAccessUnbound and W9API-13/16 run it. The Orthanc read itself runs against a local HTTP server (W9API-17), and
 * so does StudyAccess's own preparation read under the resolve deadline (W9API-21, W9A-01); W9API-22 holds each wait of
 * the resolve in turn (the doubles' `stalls`) to show every one of them ends at the deadline.
 * D73: assertions are on answers, HTTP statuses/codes, recorded calls and the real Nest metadata; none reads source text.
 * Synthetic SYN-* values only; no database, no Docker, no network beyond 127.0.0.1.
 */
require('./service_test_loader.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MultiStudyViewService, ViewingSetAccess, ViewingSetAccessUnbound, VIEWING_SET_SURFACE } = require('/app/dist/multi-study-view.service');
const { MultiStudyViewController } = require('/app/dist/multi-study-view.controller');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { StudyAccessInterceptor } = require('/app/dist/study-access.interceptor');
const { OrthancService } = require('/app/dist/orthanc.service');
const { PrismaService } = require('/app/dist/prisma.service');
const { STUDY_IDENTITY_UNRESOLVED } = require('/app/dist/study-source-groups');
const { routeContract } = require('/app/dist/emr-contract/routes');
const { WORK_CONTEXTS } = require('/app/dist/emr-contract/access-event');
const { routeKey, clinicianRouteAllowed } = require('/app/dist/clinician-policy');

const A = 'syn-a', B = 'syn-b';
const COMPOSITION = '7b0c1f3a-2d4e-4f60-8a1b-2c3d4e5f6a7b', REQUEST = '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516';
const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LF = 'W9_LOAD_FAILED', MU = 'W9_MEMBER_UNAVAILABLE', SX = 'W9_SCOPE_EXCLUDED', IU = 'W9_IDENTITY_UNAVAILABLE';
// Each request carries its own Caller object, as the guard builds one per request (StudyAccess keys request state by it).
const person = (name, roles, institution = A, kind = 'member') => () => ({ kind, institution, sub: 'syn-' + name + '-sub',
  actor: 'syn-' + name, roles: [...roles] });
const reader = person('reader', ['radiologist']), admin = person('admin', ['admin']), technician = person('tech', ['technician']);
const mixedReader = person('mixed', ['clinician', 'radiologist']), clinicianTech = person('ctech', ['clinician', 'technician']);
const noRole = person('none', []), gateway = person('gw', ['radiologist'], A, 'gateway');

let serial = 0;
const nextUid = () => '2.25.' + (800000 + ++serial);
/** One QIDO row of a source resource; `pid: undefined` leaves PatientID out. */
function sourceRow(uid, o = {}) {
  const row = { '0020000D': { vr: 'UI', Value: [uid] }, '00100010': { vr: 'PN', Value: [{ Alphabetic: o.name ?? 'SYN^PATIENT' }] },
    '00080080': { vr: 'LO', Value: [o.institutionName ?? 'SYN HOSPITAL A'] }, '00080020': { vr: 'DA', Value: [o.date ?? '20261001'] },
    '00080061': { vr: 'CS', Value: o.modalities ?? ['CT'] }, '00081030': { vr: 'LO', Value: [o.desc ?? 'SYN DESC ' + uid] },
    '00080050': { vr: 'SH', Value: [o.acc ?? 'SYN-ACC-' + uid.split('.').pop()] } };
  if (!('pid' in o) || o.pid !== undefined) row['00100020'] = { vr: 'LO', Value: [o.pid ?? 'SYN-PID-1'] };
  return row;
}
/** A study: its StudyState row (null = none) and what its source answers. read: answer | gate | hang | late | fail. */
function study(o = {}) {
  const uid = o.uid ?? nextUid();
  return { uid, read: o.read ?? 'answer', rows: o.rows ?? [sourceRow(uid, o)],
    state: o.state === null ? null : { uid, institutionId: A, teleInstitutionId: null, ts: 'none', rs: 'W', ss: 'Verified',
      holdReason: null, ov: null, ...(o.state ?? {}) } };
}
const unrestricted = () => ({ version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] });
const patientRule = (...pids) => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: pids.map(patientId => ({ patientId, modalities: [], dateFrom: null, dateTo: null, studyUids: [] })) });

class RecordingAccess extends ViewingSetAccess {
  constructor() { super(); this.prepared = []; this.finished = []; this.mode = 'ok'; this.during = null; this.events = 0; this.order = []; }
  async prepare(provision) {
    this.prepared.push(JSON.parse(JSON.stringify(provision)));
    this.order.push('prepare');
    // runs while the record is being made: after the resolve's own re-check, before the reply
    if (this.during) await this.during(provision);
    if (this.mode === 'fail') throw new Error('SYN append failed');
    const refs = new Map(provision.targets.map(target => [target.uid, 'syn-event-' + ++this.events]));
    if (this.mode === 'missing') refs.delete(provision.targets[0].uid);
    if (this.mode === 'duplicate') for (const key of refs.keys()) refs.set(key, 'syn-event-same');
    if (this.mode === 'empty') refs.set(provision.targets[0].uid, '');
    this.order.push('receipt');
    return { accessRefs: refs };
  }
  async finish(receipts, outcome) {
    this.finished.push({ refs: [...receipts.accessRefs.values()], outcome });
    if (this.finishMode === 'fail') throw new Error('SYN finish failed');
  }
}

function world(studies, { policy = null } = {}) {
  const w = { byUid: new Map(studies.map(s => [s.uid, structuredClone(s)])), policy, revision: 1, gates: new Map(), active: 0,
    maxActive: 0, calls: { states: [], reads: [], writes: [], foreign: [], identity: [], identitySignals: [] }, onRead: null,
    counts: {}, stalls: {}, held: null };
  // W9API-22: the n-th call of one wait (`w.stalls[name] = n`) does not answer until the test releases it. The held call
  // keeps the signal it was given, if any; a release answers what the call would have answered (a late answer).
  const stalled = (name, signal, answer) => {
    w.counts[name] = (w.counts[name] ?? 0) + 1;
    if (w.stalls[name] !== w.counts[name]) return null;
    return new Promise((resolve, reject) => { w.held = { name, signal, release: () => answer().then(resolve, reject) }; });
  };
  const project = (row, select) => Object.fromEntries(Object.keys(select).filter(k => select[k] === true).map(k => [k, row[k]]));
  const studyState = {
    async findMany(args) {
      w.calls.states.push(JSON.parse(JSON.stringify(args)));
      const wanted = args?.where?.uid?.in;
      assert.ok(Array.isArray(wanted) && args.select, 'the members are read by their UIDs with a select');
      const rows = async () => wanted.map(uid => w.byUid.get(uid)?.state).filter(Boolean).map(row => project(row, args.select));
      return stalled('states', undefined, rows) ?? rows();
    },
  };
  for (const method of WRITES) studyState[method] = async () => { w.calls.writes.push('studyState.' + method); throw new Error('SYN write refused'); };
  const root = {
    studyState,
    // The real StudyAccessService reads the caller's policy row by subject; a lock statement only inside a transaction.
    async $queryRaw(strings, ...values) {
      if (strings.join('?').includes('pg_advisory')) { w.calls.writes.push('advisory-lock'); return [{ locked: 1 }]; }
      const rows = async () => !w.policy ? []
        : [{ institution: values[1], revision: w.revision, policy: w.policy, reason: 'SYN policy', updatedBy: 'syn-admin', updatedAt: new Date(0) }];
      return stalled('policy', undefined, rows) ?? rows();
    },
  };
  for (const method of ['$executeRaw', '$transaction']) root[method] = async () => { w.calls.writes.push(method); throw new Error('SYN write refused'); };
  w.prisma = new Proxy(root, { get(target, key) {
    if (key in target || typeof key === 'symbol' || key === 'then') return target[key];
    w.calls.foreign.push(String(key));
    return new Proxy({}, { get: (_, method) => async () => { w.calls.writes.push(String(key) + '.' + String(method)); throw new Error('SYN model refused'); } });
  } });
  w.orthanc = {
    viewingSetStudy(uid, signal) {
      const s = w.byUid.get(uid), call = { uid, signal, sawAbort: false, settled: false };
      w.calls.reads.push(call);
      w.active++; w.maxActive = Math.max(w.maxActive, w.active);
      if (w.onRead) w.onRead(uid, call);
      return new Promise((resolve, reject) => {
        const settle = fn => { if (call.settled) return; call.settled = true; w.active--; fn(); };
        const answer = () => settle(() => s.read === 'fail' ? reject(new Error('SYN source failed')) : resolve(structuredClone(s.rows)));
        signal?.addEventListener('abort', () => {
          call.sawAbort = true;
          if (s.read !== 'late') settle(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }, { once: true });
        if (s.read === 'answer' || s.read === 'fail') queueMicrotask(answer);
        else if (s.read === 'gate' || s.read === 'late') w.gates.set(uid, answer);
      });
    },
    async studyIdentityResources(uid, signal) {
      w.calls.identity.push(uid); w.calls.identitySignals.push(signal);
      const rows = async () => structuredClone(w.byUid.get(uid)?.rows ?? []);
      return stalled('identity', signal, rows) ?? rows();
    },
    async studyIdentities(_metadata, _accession, signal) {
      w.calls.identity.push('*'); w.calls.identitySignals.push(signal);
      const rows = async () => [...w.byUid.values()].flatMap(s => structuredClone(s.rows));
      return stalled('identity', signal, rows) ?? rows();
    },
  };
  w.studyAccess = new StudyAccessService(w.prisma, w.orthanc, {});
  w.port = new RecordingAccess();
  w.svc = new MultiStudyViewService(w.prisma, w.orthanc, w.studyAccess, w.port);
  return w;
}
const body = (uids, over = {}) => Buffer.from(JSON.stringify({ compositionId: COMPOSITION, generation: 1, requestId: REQUEST,
  studyUids: uids, expectedSourcePatientKey: null, ...over }));
const never = () => new Promise(() => {});
const resolveFor = (w, caller, raw, transfer = never()) => w.svc.resolve(raw, caller, transfer);
const ids = list => list.map(s => s.uid);
const codes = answer => answer.members.map(m => m.status === 'ready' ? 'ready' : m.code);
const settle = () => new Promise(resolve => setImmediate(resolve));
/** A refusal with this status and code; anything else fails with the label. */
async function refusedWith(promise, status, wanted, label) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, label + ' (answered instead of refusing)');
  assert.deepEqual([error.getStatus?.() ?? String(error), error.getResponse?.().code], [status, wanted], label);
}
/** An answer; a refusal or a crash fails with the label. */
const opens = (promise, label) => promise.catch(error => assert.fail(`${label} (refused: ${error?.getResponse?.().code ?? error?.message})`));
// Polls on the event loop by wall time, so it also works while a test mocks setTimeout.
async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await settle()) if (check()) return;
  if (!check()) assert.fail('never reached: ' + label);
}
const noWrites = (w, label = 'a resolve writes nothing') => {
  assert.deepEqual(w.calls.writes, [], label);
  assert.deepEqual(w.calls.foreign, [], 'a resolve reads no other model');
};

test('W9API-01 T18 A-01: every malformed selection is the one 400 with no database, source or record call', async () => {
  const [s1, s2] = [study(), study()];
  const many = Array.from({ length: 21 }, (_, i) => '2.25.77' + i);
  const raws = {
    'extra key': body(ids([s1, s2]), { owner: 'syn' }),
    'missing key': Buffer.from(JSON.stringify({ compositionId: COMPOSITION, generation: 1, requestId: REQUEST, studyUids: ids([s1, s2]) })),
    'duplicate JSON key': Buffer.from(`{"compositionId":"${COMPOSITION}","compositionId":"${COMPOSITION}","generation":1,"requestId":"${REQUEST}","studyUids":["${s1.uid}","${s2.uid}"],"expectedSourcePatientKey":null}`),
    'one UID': body([s1.uid]), 'twenty-one UIDs': body(many), 'duplicate UID': body([s1.uid, s1.uid]),
    'UID with letters': body([s1.uid, '2.25.abc']), 'UID over 64': body([s1.uid, '2.25.' + '1'.repeat(64)]), 'UID not a string': body([s1.uid, 7]),
    'composition not v4': body(ids([s1, s2]), { compositionId: '7b0c1f3a-2d4e-1f60-8a1b-2c3d4e5f6a7b' }),
    'composition upper case': body(ids([s1, s2]), { compositionId: COMPOSITION.toUpperCase() }),
    'request ID format': body(ids([s1, s2]), { requestId: 'syn' }),
    'generation 0': body(ids([s1, s2]), { generation: 0 }), 'generation fraction': body(ids([s1, s2]), { generation: 1.5 }),
    'generation text': body(ids([s1, s2]), { generation: '1' }), 'generation too large': body(ids([s1, s2]), { generation: 2147483648 }),
    'empty expected key': body(ids([s1, s2]), { expectedSourcePatientKey: '' }), 'expected key a number': body(ids([s1, s2]), { expectedSourcePatientKey: 7 }),
    'expected key with a control': body(ids([s1, s2]), { expectedSourcePatientKey: A + '|SYN\n' }),
    'expected key too long': body(ids([s1, s2]), { expectedSourcePatientKey: 'x'.repeat(513) }),
    'array body': Buffer.from('[]'), 'null body': Buffer.from('null'), 'not JSON': Buffer.from('{'), 'no raw body': undefined,
  };
  for (const [label, raw] of Object.entries(raws)) {
    const w = world([s1, s2]);
    await refusedWith(resolveFor(w, reader(), raw), 400, 'W9_SELECTION_INVALID', label + ' must be refused as a selection');
    assert.deepEqual([w.calls.states.length, w.calls.reads.length, w.calls.identity.length, w.port.prepared.length], [0, 0, 0, 0],
      label + ': refused before any read');
  }
  // the bounds themselves are accepted: 2 and 20 members, generation 2^31-1, a bounded expected key
  const twenty = Array.from({ length: 20 }, () => study());
  const w = world(twenty);
  const answer = await opens(resolveFor(w, reader(), body(ids(twenty), { generation: 2147483647, expectedSourcePatientKey: A + '|SYN-PID-1' })),
    'twenty members are a valid selection');
  assert.deepEqual([answer.generation, answer.members.length, answer.scopeStatus], [2147483647, 20, 'ready']);
});

test('W9API-02 T03 A-01: only radiologist (admin passes) resolves; the role refusal comes before input and every read', async () => {
  const [s1, s2] = [study(), study()];
  for (const [label, caller] of [['technician', technician], ['no role', noRole], ['clinician and technician', clinicianTech], ['gateway', gateway]]) {
    const w = world([s1, s2]);
    await refusedWith(resolveFor(w, caller(), body(ids([s1, s2]))), 403, 'W9_VIEW_FORBIDDEN', label + ' must not resolve a viewing set');
    await refusedWith(resolveFor(w, caller(), body([s1.uid])), 403, 'W9_VIEW_FORBIDDEN', label + ': the role is decided before the input');
    assert.deepEqual([w.calls.states.length, w.calls.reads.length, w.port.prepared.length], [0, 0, 0], label + ': refused before any read');
  }
  for (const [label, caller] of [['radiologist', reader], ['admin', admin], ['clinician with radiologist', mixedReader]]) {
    const w = world([s1, s2]);
    assert.deepEqual(codes(await opens(resolveFor(w, caller(), body(ids([s1, s2]))), label + ' resolves a viewing set')), ['ready', 'ready'], label);
  }
});

test('W9API-03 T03 A-02: each member on its own - visibility, own institution, no tele, StudyAccess; the last one like the first', async () => {
  const ready = study();
  const cases = {
    'no StudyState row': [study({ state: null }), MU],
    'another institution': [study({ state: { institutionId: B } }), MU],
    'unassigned institution': [study({ state: { institutionId: null } }), MU],
    'received by tele': [study({ state: { institutionId: B, teleInstitutionId: A, ts: 'inReading' } }), SX],
    'sent by tele': [study({ state: { teleInstitutionId: B, ts: 'sent' } }), SX],
    'tele completed': [study({ state: { teleInstitutionId: B, ts: 'completed' } }), SX],
    'tele waiting without a channel row': [study({ state: { ts: 'wait' } }), SX],
    'tele cancelled': [study({ state: { ts: 'cancelled' } }), 'ready'],
    'tele failed and closed': [study({ state: { ts: 'fail' } }), 'ready'],
  };
  for (const [label, [member, expected]] of Object.entries(cases)) for (const order of ['last', 'first']) {
    const members = order === 'last' ? [ready, member] : [member, ready];
    const w = world(members);
    const what = `${label} (${order}) must be judged on its own`;
    const answer = await opens(resolveFor(w, reader(), body(ids(members))), what);
    assert.deepEqual(codes(answer), order === 'last' ? ['ready', expected] : [expected, 'ready'], what);
    const refused = answer.members.find(m => m.uid === member.uid);
    if (expected !== 'ready') {
      assert.deepEqual(Object.keys(refused).sort(), ['code', 'ordinal', 'status', 'uid'], label + ': an error member carries no name, institution or other UID');
      assert.ok(!w.calls.reads.some(r => r.uid === member.uid), label + ': a refused member\'s source is never read');
    }
    noWrites(w);
  }
  // admin: the role passes, the institution and tele boundaries do not
  const foreign = study({ state: { institutionId: B } }), received = study({ state: { institutionId: B, teleInstitutionId: A, ts: 'sent' } });
  const w = world([ready, foreign, received]);
  const adminAnswer = await opens(resolveFor(w, admin(), body(ids([ready, foreign, received]))), 'admin has no institution or tele exception');
  assert.deepEqual(codes(adminAnswer), ['ready', MU, SX], 'admin has no institution or tele exception');
  assert.deepEqual(w.calls.reads.map(r => r.uid), [ready.uid]);
  // a member of another institution is refused for that institution's own reader too, and readable there
  const wb = world([ready, foreign]);
  assert.deepEqual(codes(await opens(resolveFor(wb, person('b-reader', ['radiologist'], B)(), body(ids([ready, foreign]))), 'B reader')), [MU, 'ready']);
});

test('W9API-04 T03 A-02: a StudyAccess refusal is the same member error, for the last member too, and no refused source is read', async () => {
  const allowed1 = study({ pid: 'SYN-PID-1' }), allowed2 = study({ pid: 'SYN-PID-1' }), refusedLast = study({ pid: 'SYN-PID-2' });
  const w = world([allowed1, allowed2, refusedLast], { policy: patientRule('SYN-PID-1') });
  const what = 'the last member\'s StudyAccess refusal must be applied';
  const answer = await opens(resolveFor(w, reader(), body(ids([allowed1, allowed2, refusedLast]))), what);
  assert.deepEqual(codes(answer), ['ready', 'ready', MU], what);
  assert.deepEqual(w.calls.reads.map(r => r.uid), [allowed1.uid, allowed2.uid], 'only allowed members are read by the resolve');
  // a closed validity window refuses every member alike
  const closed = { ...patientRule('SYN-PID-1'), endsAt: '2020-01-01T00:00:00.000Z' };
  const wc = world([allowed1, allowed2], { policy: closed });
  const none = await opens(resolveFor(wc, reader(), body(ids([allowed1, allowed2]))), 'a closed window');
  assert.deepEqual([codes(none), none.scopeStatus, none.sourcePatientKey, wc.port.prepared.length], [[MU, MU], 'rejected', null, 0]);
});

test('W9API-05 T03: W/T/P/A/H and Unverified studies open by image-read rights; the answer carries no report or draft field', async () => {
  const members = [study({ state: { rs: 'W', ss: 'Unverified' } }), study({ state: { rs: 'T' } }), study({ state: { rs: 'P' } }),
    study({ state: { rs: 'A' } }), study({ state: { rs: 'W', holdReason: 'SYN hold' } })];
  const w = world(members);
  const answer = await opens(resolveFor(w, reader(), body(ids(members))), 'every reading status opens for viewing');
  assert.deepEqual(codes(answer), ['ready', 'ready', 'ready', 'ready', 'ready'], 'every reading status opens for viewing');
  for (const m of answer.members) {
    assert.deepEqual(Object.keys(m).sort(), ['accessRef', 'metadata', 'ordinal', 'status', 'uid']);
    assert.deepEqual(Object.keys(m.metadata).sort(), ['accession', 'description', 'institutionName', 'modalities', 'patientId', 'patientName', 'studyDate']);
  }
  assert.deepEqual(Object.keys(answer).sort(), ['compositionId', 'generation', 'members', 'requestId', 'scopeStatus', 'sourcePatientKey']);
  assert.deepEqual(w.calls.states.map(c => Object.keys(c.select).sort()),
    [['institutionId', 'teleInstitutionId', 'ts', 'uid'], ['institutionId', 'teleInstitutionId', 'ts', 'uid']]);
  noWrites(w);
});

test('W9API-06 T02 A-04: the same patient is the owner plus the raw source PatientID, nothing else', async () => {
  // positive control: two distinct normal UIDs, one non-empty PatientID, different names and overlays
  const p1 = study({ pid: 'SYN-PID-7', name: 'SYN^ONE', state: { ov: JSON.stringify({ id: 'OTHER' }) } }), p2 = study({ pid: 'SYN-PID-7', name: 'SYN^TWO' });
  const w = world([p1, p2]);
  const together = 'two normal studies with one PatientID must open as one set';
  const answer = await opens(resolveFor(w, reader(), body(ids([p1, p2]))), together);
  assert.deepEqual([codes(answer), answer.scopeStatus, answer.sourcePatientKey], [['ready', 'ready'], 'ready', A + '|SYN-PID-7'], together);
  assert.equal(answer.members[1].metadata.patientName, 'SYN TWO');
  const mismatches = {
    'another PatientID with the same name': [{ pid: 'SYN-PID-1', name: 'SYN^SAME' }, { pid: 'SYN-PID-2', name: 'SYN^SAME' }],
    'case': [{ pid: 'syn-pid-1' }, { pid: 'SYN-PID-1' }], 'leading zero': [{ pid: '0123' }, { pid: '123' }],
    'Unicode form': [{ pid: 'SYN-Å' }, { pid: 'SYN-Å' }], 'trailing space': [{ pid: 'SYN-PID-1 ' }, { pid: 'SYN-PID-1' }],
  };
  for (const [label, [o1, o2]] of Object.entries(mismatches)) {
    const pair = [study(o1), study(o2)], wm = world(pair);
    await refusedWith(resolveFor(wm, reader(), body(ids(pair))), 409, 'W9_PATIENT_MISMATCH', label + ' must not join two source patients');
    assert.equal(wm.port.prepared.length, 0, label + ': nothing is provided');
  }
  // the expected key of an admitted set is a stale check: equal opens, different refuses the whole set
  const we = world([p1, p2]);
  assert.equal((await opens(resolveFor(we, reader(), body(ids([p1, p2]), { expectedSourcePatientKey: A + '|SYN-PID-7' })), 'the same expected key')).scopeStatus, 'ready');
  await refusedWith(resolveFor(we, reader(), body(ids([p1, p2]), { expectedSourcePatientKey: A + '|SYN-PID-8' })), 409, 'W9_PATIENT_MISMATCH',
    'an admitted set whose source key changed must not reopen');
  await refusedWith(resolveFor(we, reader(), body(ids([p1, p2]), { expectedSourcePatientKey: B + '|SYN-PID-7' })), 409, 'W9_PATIENT_MISMATCH',
    'an expected key of another owner must not reopen');
  // a missing or whitespace-only PatientID is a member error, never a key
  const blank = study({ pid: '   ' }), missing = study({ pid: undefined });
  const wb = world([p1, blank, missing]), neverKey = 'a missing or whitespace-only PatientID is never a key';
  assert.deepEqual(codes(await opens(resolveFor(wb, reader(), body(ids([p1, blank, missing]))), neverKey)), ['ready', IU, IU], neverKey);
  assert.deepEqual(w.calls.reads.map(r => r.uid), ids([p1, p2]), 'one source read per member and no other source lookup');
  noWrites(w);
});

test('W9API-07 T18 A-04: first Open is ready only when all are; an admitted set keeps every ordinal and its errors', async () => {
  const s = [study(), study({ read: 'fail' }), study(), study()];
  const opened = await opens(resolveFor(world(s), reader(), body(ids(s))), 'a first Open with a failure');
  assert.deepEqual([opened.scopeStatus, codes(opened)], ['partial', ['ready', LF, 'ready', 'ready']], 'a first Open with a failure is never ready');
  const reopened = await opens(resolveFor(world(s), reader(), body(ids(s), { expectedSourcePatientKey: A + '|SYN-PID-1' })), 'an admitted set');
  assert.deepEqual(reopened.members.map(m => [m.ordinal, m.uid, m.status]),
    [[0, s[0].uid, 'ready'], [1, s[1].uid, 'error'], [2, s[2].uid, 'ready'], [3, s[3].uid, 'ready']], 'the failed member keeps its place');
  assert.equal(reopened.scopeStatus, 'partial');
  const allBad = [study({ read: 'fail' }), study({ state: null })], wb = world(allBad);
  const rejected = await opens(resolveFor(wb, reader(), body(ids(allBad))), 'nothing ready');
  assert.deepEqual([rejected.scopeStatus, rejected.sourcePatientKey, codes(rejected), wb.port.prepared.length],
    ['rejected', null, [LF, MU], 0], 'nothing ready: nothing provided');
  assert.deepEqual([rejected.compositionId, rejected.generation, rejected.requestId], [COMPOSITION, 1, REQUEST]);
});

test('W9API-08 A-03 split-UID: one original resource first, after the scope refusals, before any key', async () => {
  const normal = study({ pid: 'SYN-PID-1' });
  const splitUid = nextUid();
  const split = study({ uid: splitUid, rows: [sourceRow(splitUid, { pid: 'SYN-PID-1' }), sourceRow(splitUid, { pid: 'SYN-PID-9' })] });
  const notReady = 'a UID two patient resources answer must not be ready';
  const answer = await opens(resolveFor(world([normal, split]), reader(), body(ids([normal, split]))), notReady);
  assert.deepEqual(codes(answer), ['ready', STUDY_IDENTITY_UNRESOLVED], notReady);
  assert.equal(answer.sourcePatientKey, A + '|SYN-PID-1', 'the split member\'s rows never decide the key');
  // judged before the PatientID: a split whose second resource has no PatientID is still the split
  const halfUid = nextUid();
  const half = study({ uid: halfUid, rows: [sourceRow(halfUid, { pid: 'SYN-PID-1' }), sourceRow(halfUid, { pid: undefined })] });
  assert.deepEqual(codes(await opens(resolveFor(world([normal, half]), reader(), body(ids([normal, half]))), notReady)), ['ready', STUDY_IDENTITY_UNRESOLVED], notReady);
  // after the scope refusals: a refused split UID is never read and answers its scope refusal (no existence oracle)
  const hiddenUid = nextUid(), teleUid = nextUid();
  const hidden = study({ uid: hiddenUid, state: { institutionId: B }, rows: [sourceRow(hiddenUid), sourceRow(hiddenUid)] });
  const tele = study({ uid: teleUid, state: { institutionId: B, teleInstitutionId: A, ts: 'sent' }, rows: [sourceRow(teleUid), sourceRow(teleUid)] });
  const wh = world([normal, hidden, tele]);
  const oracle = 'a split the caller may not see must answer its scope refusal';
  assert.deepEqual(codes(await opens(resolveFor(wh, reader(), body(ids([normal, hidden, tele]))), oracle)), ['ready', MU, SX], oracle);
  assert.deepEqual(wh.calls.reads.map(r => r.uid), [normal.uid], 'the source of a refused member is never read');
  // no resource is not a split: the member is unavailable
  const gone = study({ rows: [] });
  assert.deepEqual(codes(await opens(resolveFor(world([normal, gone]), reader(), body(ids([normal, gone]))), 'no resource')), ['ready', MU]);
});

test('W9API-09 T04 A-03: at most four source reads at a time, each member\'s failure its own', async () => {
  const members = Array.from({ length: 7 }, () => study({ read: 'gate' }));
  const w = world(members);
  const pending = opens(resolveFor(w, reader(), body(ids(members))), 'gated reads');
  await until(() => w.calls.reads.length >= 4, 'four reads started');
  await settle(); await settle();
  assert.equal(w.calls.reads.length, 4, 'a fifth read must wait for a free slot');
  w.gates.get(members[0].uid)();
  await until(() => w.calls.reads.length === 5, 'the next read starts when one ends');
  for (const m of members.slice(1)) { await until(() => w.gates.has(m.uid), 'read ' + m.uid); w.gates.get(m.uid)(); }
  const answer = await pending;
  assert.equal(w.maxActive, 4, 'never more than four concurrent source reads');
  assert.deepEqual(w.calls.reads.map(r => r.uid), ids(members), 'reads start in member order');
  assert.equal(answer.scopeStatus, 'ready');
  assert.ok(w.calls.reads.every(r => r.signal === w.calls.reads[0].signal && r.signal instanceof AbortSignal), 'one resolve signal reaches every read');
});

test('W9API-10 T04 A-03: the 10 s resolve deadline cancels pending reads; no stale or late metadata is used', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const early = study({ read: 'gate' }), h1 = study({ read: 'hang' }), h2 = study({ read: 'hang' }), late = study({ read: 'late' });
  const q1 = study(), q2 = study({ read: 'hang' }), q3 = study();
  const members = [early, h1, h2, late, q1, q2, q3];
  const w = world(members);
  const pending = opens(resolveFor(w, reader(), body(ids(members), { expectedSourcePatientKey: A + '|SYN-PID-1' })), 'the deadline answer');
  await until(() => w.calls.reads.length === 4, 'the first four reads started');
  w.gates.get(early.uid)();   // answers before the deadline: kept
  await until(() => w.calls.reads.length === 6, 'the freed slot took the next members');
  await settle();
  assert.equal(w.calls.reads.length, 6, 'the seventh member waits for a slot');
  t.mock.timers.tick(9999);
  await settle();
  assert.ok(!w.calls.reads.some(r => r.sawAbort), 'nothing is cancelled before ten seconds');
  t.mock.timers.tick(1);
  await settle();
  const cut = w.calls.reads.filter(r => [h1, h2, late, q2].some(s => s.uid === r.uid));
  assert.ok(cut.length === 4 && cut.every(r => r.sawAbort && r.signal.aborted), 'every pending read must observe the deadline abort');
  const run = track(pending);
  await until(() => run.settled, 'the deadline answers without waiting for a late source');
  w.gates.get(late.uid)();   // the source answers after the deadline: it must not be used
  await settle();
  const answer = await pending;
  // D1550: the one deadline also bounds the re-check and the receipt, so a member read in time is not provided after it.
  assert.deepEqual([answer.scopeStatus, codes(answer)], ['rejected', [LF, LF, LF, LF, LF, LF, LF]],
    'a read answered after the deadline must not become metadata; nothing is provided after the deadline');
  assert.ok(!JSON.stringify(answer).includes('SYN-PID-1'), 'no member metadata after the deadline');
  assert.deepEqual([w.port.prepared.length, w.calls.states.length], [0, 1], 'no re-check and no receipt after the deadline');
  assert.deepEqual(w.calls.reads.map(r => r.uid), ids(members.slice(0, 6)), 'a member still queued at the deadline is never read');
});

test('W9API-11 T04 A-05: a change of a member row or of the policy during the source wait discards the whole result', async () => {
  const changes = {
    'tele opened': s => { s.state.teleInstitutionId = B; s.state.ts = 'wait'; },
    'owner changed': s => { s.state.institutionId = B; },
    'tele state moved': s => { s.state.ts = 'wait'; },
    'row removed': s => { s.state = null; },
    'policy changed': (s, w) => { w.revision = 2; },
  };
  for (const [label, change] of Object.entries(changes)) {
    const members = [study(), study()], w = world(members, { policy: label === 'policy changed' ? patientRule('SYN-PID-1') : null });
    w.onRead = uid => { if (uid === members[1].uid) change(w.byUid.get(uid), w); };
    await refusedWith(resolveFor(w, reader(), body(ids(members))), 409, 'W9_CONTEXT_CHANGED', label + ' must be re-checked after the source wait');
    assert.equal(w.port.prepared.length, 0, label + ': nothing is provided');
  }
  // an unchanged world answers, and the re-check reads the same members once more
  const members = [study(), study()], w = world(members);
  await opens(resolveFor(w, reader(), body(ids(members))), 'an unchanged world');
  assert.deepEqual(w.calls.states.map(c => c.where.uid.in), [ids(members), ids(members)]);
});

test('W9API-12 T10 A-06: one provision with one target per provided member, the D-5 anchor context, no composition row', async () => {
  const members = [study(), study({ read: 'fail' }), study(), study({ state: { institutionId: B } })];
  const w = world(members);
  const perMember = 'every provided member must have its own target, and only those';
  const answer = await opens(resolveFor(w, reader(), body(ids(members), { expectedSourcePatientKey: A + '|SYN-PID-1' })), perMember);
  assert.equal(w.port.prepared.length, 1, 'one provision per resolve');
  const provision = w.port.prepared[0];
  assert.deepEqual(Object.keys(provision).sort(), ['auditLinkId', 'caller', 'cause', 'kind', 'requestId', 'surface', 'targets'],
    'the provision carries no composition or generation field');
  assert.deepEqual([provision.kind, provision.cause, provision.surface, provision.requestId], ['study-metadata', 'user-view', VIEWING_SET_SURFACE, REQUEST]);
  assert.match(provision.auditLinkId, /^audit:/);
  assert.match(provision.auditLinkId.slice(6), UUID4);
  assert.deepEqual([provision.caller.sub, provision.caller.institution], ['syn-reader-sub', A]);
  assert.deepEqual(provision.targets.map(t => [t.uid, t.ordinal, t.managingInstitutionId, t.patientId]),
    [[members[0].uid, 0, A, 'SYN-PID-1'], [members[2].uid, 2, A, 'SYN-PID-1']], perMember);
  for (const target of provision.targets)
    assert.deepEqual(target.metadata, answer.members[target.ordinal].metadata, 'the recorded projection is exactly what the body carries');
  assert.deepEqual(provision.targets.map(t => t.context), [
    { basis: 'worklist', studyId: members[0].uid, relatedStudyId: null, reason: null },
    { basis: 'same-patient-comparison', studyId: members[0].uid, relatedStudyId: members[2].uid, reason: null }],
  'the ordered first UID anchors the comparison');
  for (const target of provision.targets) assert.ok(WORK_CONTEXTS.includes(target.context.basis));
  assert.deepEqual(answer.members.filter(m => m.status === 'ready').map(m => m.accessRef), ['syn-event-1', 'syn-event-2']);
  // the anchor failed after admission: no silent re-anchor, each provided member is its own worklist read
  const later = [study({ read: 'fail' }), study(), study()], wl = world(later);
  await opens(resolveFor(wl, reader(), body(ids(later), { expectedSourcePatientKey: A + '|SYN-PID-1' })), 'a failed anchor');
  assert.deepEqual(wl.port.prepared[0].targets.map(t => t.context), [
    { basis: 'worklist', studyId: later[1].uid, relatedStudyId: null, reason: null },
    { basis: 'worklist', studyId: later[2].uid, relatedStudyId: null, reason: null }], 'no silent re-anchor: each provided member is its own worklist read');
  // the surface is the real route's key and its classification is a study-metadata read
  const contract = routeContract(VIEWING_SET_SURFACE);
  assert.deepEqual([contract.kinds, contract.operation, contract.causes], [['study-metadata'], 'read', ['user-view']]);
  noWrites(w);
});

test('W9API-13 T18 A-06: no body before every receipt; a failed or incomplete record answers 503 with no member body', async () => {
  const members = [study(), study()];
  // the body waits for the receipt
  const w = world(members);
  let release; w.port.during = () => new Promise(resolve => { release = resolve; });
  let answered = false;
  const pending = opens(resolveFor(w, reader(), body(ids(members))), 'a recorded answer').then(answer => { answered = true; return answer; });
  await until(() => w.port.prepared.length === 1, 'the provision is asked');
  await settle(); await settle();
  assert.equal(answered, false, 'no body before the durable receipt');
  release();
  assert.equal((await pending).scopeStatus, 'ready');
  assert.deepEqual(w.port.order, ['prepare', 'receipt']);
  for (const mode of ['fail', 'missing', 'duplicate', 'empty']) {
    const wf = world(members); wf.port.mode = mode;
    await refusedWith(resolveFor(wf, reader(), body(ids(members))), 503, 'W9_AUDIT_UNAVAILABLE', mode + ': a provision without every receipt must not answer');
    await settle();
    if (mode !== 'fail') assert.deepEqual(wf.port.finished.map(f => f.outcome), ['aborted'], mode + ': the prepared records learn the body never went out');
  }
  // the production binding: AppModule binds the port to ViewingSetAccessUnbound
  const { AppModule } = require('/app/dist/app.module');
  const binding = Reflect.getMetadata('providers', AppModule).find(p => p && p.provide === ViewingSetAccess);
  assert.equal(binding?.useClass, ViewingSetAccessUnbound, 'this build binds the unbound port');
  const wu = world(members);
  const production = new MultiStudyViewService(wu.prisma, wu.orthanc, wu.studyAccess, new binding.useClass());
  await refusedWith(production.resolve(body(ids(members)), reader(), never()), 503, 'W9_AUDIT_UNAVAILABLE',
    'without a bound ledger no member metadata is provided');
  const bad = [study({ state: null }), study({ read: 'fail' })], wb = world(bad);
  const unbound = new MultiStudyViewService(wb.prisma, wb.orthanc, wb.studyAccess, new binding.useClass());
  assert.deepEqual(codes(await opens(unbound.resolve(body(ids(bad)), reader(), never()), 'an answer that provides nothing')), [MU, LF],
    'an answer that provides nothing needs no record');
});

test('W9API-14 T10 A-06: the observed transfer is recorded once, only after it is observed', async () => {
  const members = [study(), study()];
  for (const outcome of ['ended', 'aborted']) {
    const w = world(members);
    let observe; const transfer = new Promise(resolve => { observe = resolve; });
    await opens(resolveFor(w, reader(), body(ids(members)), transfer), 'a recorded answer');
    await settle(); await settle();
    assert.deepEqual(w.port.finished, [], 'no transfer outcome before the response observed one');
    observe(outcome);
    await until(() => w.port.finished.length === 1, 'the outcome is recorded');
    assert.deepEqual(w.port.finished, [{ refs: ['syn-event-1', 'syn-event-2'], outcome }], 'the observed outcome, once, for the provided records');
  }
  // a failing record of the outcome is the port's own journal: no unhandled rejection, no second call
  const w = world(members); w.port.finishMode = 'fail';
  await opens(resolveFor(w, reader(), body(ids(members)), Promise.resolve('ended')), 'a recorded answer');
  await until(() => w.port.finished.length === 1, 'the failing outcome record ran');
  await settle();
  assert.equal(w.port.finished.length, 1);
});

test('W9API-15 W9L-07: a resolve writes no clinical row and registers no StudyState, whatever it answers', async () => {
  const unregistered = study({ state: null });
  const members = [study(), unregistered, study({ state: { teleInstitutionId: B, ts: 'sent' } })];
  const w = world(members);
  const answer = await opens(resolveFor(w, reader(), body(ids(members))), 'a mixed answer');
  assert.deepEqual(codes(answer), ['ready', MU, SX]);
  noWrites(w, 'a resolve writes nothing and registers no StudyState');
  assert.equal(w.byUid.get(unregistered.uid).state, null, 'an unregistered study stays unregistered (no lazy row)');
  const mismatch = [study({ pid: 'SYN-1' }), study({ pid: 'SYN-2' })], wm = world(mismatch);
  await refusedWith(resolveFor(wm, reader(), body(ids(mismatch))), 409, 'W9_PATIENT_MISMATCH', 'a mismatch');
  noWrites(wm, 'a resolve writes nothing and registers no StudyState');
});

/** A real Nest HTTP application around the real controller, service and StudyAccess interceptor (guard: synthetic caller). */
async function serve(w, port) {
  const { NestFactory, APP_GUARD, APP_INTERCEPTOR } = require('/app/node_modules/@nestjs/core');
  const { Module } = require('/app/node_modules/@nestjs/common');
  class SyntheticGuard { canActivate(context) { const req = context.switchToHttp().getRequest(); Object.assign(req, JSON.parse(req.headers['x-syn-caller'])); return true; } }
  class HttpProbe {}
  Module({ controllers: [MultiStudyViewController], providers: [MultiStudyViewService,
    { provide: PrismaService, useValue: w.prisma }, { provide: OrthancService, useValue: w.orthanc },
    { provide: StudyAccessService, useValue: w.studyAccess }, { provide: ViewingSetAccess, useValue: port ?? w.port },
    { provide: APP_GUARD, useValue: new SyntheticGuard() }, { provide: APP_INTERCEPTOR, useClass: StudyAccessInterceptor }] })(HttpProbe);
  const app = await NestFactory.create(HttpProbe, { rawBody: true, logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  return { url: `http://127.0.0.1:${app.getHttpServer().address().port}/api/studies/viewing-set/resolve`, close: () => app.close() };
}
const post = (url, raw, caller, signal) => fetch(url, { method: 'POST', body: raw, signal,
  headers: { 'content-type': 'application/json', 'x-syn-caller': JSON.stringify(caller) } });

test('W9API-16 T10/T18 HTTP: 200 is the resolve body and ends the transfer; a post-handler refusal or a closed connection aborts it', async () => {
  const members = [study(), study()];
  // the real route: raw body, 200, and the finished body is the observed end
  const w = world(members), app = await serve(w);
  try {
    const ok = await post(app.url, body(ids(members)), reader());
    assert.equal(ok.status, 200, 'the resolve answers 200');
    const answer = await ok.json();
    assert.deepEqual(codes(answer), ['ready', 'ready']);
    await until(() => w.port.finished.length === 1, 'the transfer outcome');
    assert.equal(w.port.finished[0].outcome, 'ended', 'a finished 200 body is an ended transfer');
    const duplicate = await post(app.url, Buffer.from(body(ids(members)).toString().replace('{', '{"generation":2,')), reader());
    assert.deepEqual([duplicate.status, (await duplicate.json()).code], [400, 'W9_SELECTION_INVALID'], 'a duplicate JSON key is refused from the raw body');
    // the policy changes while the record is prepared: the interceptor refuses the reply, so the body never went out
    w.policy = unrestricted();
    w.port.during = async () => { w.revision = 7; };
    const refused = await post(app.url, body(ids(members)), reader());
    const refusal = await refused.json();
    assert.deepEqual([refused.status, refusal.code, 'members' in refusal], [409, 'STUDY_ACCESS_CHANGED', false]);
    await until(() => w.port.finished.length === 2, 'the refused transfer outcome');
    assert.equal(w.port.finished[1].outcome, 'aborted', 'a refused reply must never be recorded as a finished transfer');
    // the connection closes before the body: aborted
    w.policy = null; w.revision = 1;
    let release; w.port.during = () => new Promise(resolve => { release = resolve; });
    const client = new AbortController();
    const gone = post(app.url, body(ids(members)), reader(), client.signal).catch(error => error);
    await until(() => w.port.prepared.length === 3, 'the third provision is asked');
    client.abort();
    assert.equal((await gone).name, 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await until(() => w.port.finished.length === 3, 'the closed transfer outcome');
    assert.equal(w.port.finished[2].outcome, 'aborted', 'a connection closed before the body is an aborted transfer');
  } finally { await app.close(); }
  // the production binding over HTTP: 503 with no member metadata in the reply
  const wu = world(members), unbound = await serve(wu, new ViewingSetAccessUnbound());
  try {
    const answer = await post(unbound.url, body(ids(members)), reader());
    const text = await answer.text();
    assert.deepEqual([answer.status, JSON.parse(text).code], [503, 'W9_AUDIT_UNAVAILABLE'], 'the unbound build answers 503');
    assert.ok(!text.includes('SYN-PID') && !text.includes('SYN PATIENT') && !text.includes(members[0].uid), 'no member metadata in a refused reply');
  } finally { await unbound.close(); }
});

test('W9API-17 A-03 Orthanc read: the named display tags, every resource row, and the caller\'s abort cancels the body', async () => {
  let mode = 'one', stallClosed = false;
  const seen = [], uid = '2.25.4242', other = '2.25.4343';
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (mode === 'stall') {
      res.on('close', () => { stallClosed = true; });
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); return;
    }
    const rows = { one: [sourceRow(uid)], two: [sourceRow(uid), sourceRow(uid, { pid: 'SYN-PID-2' })], none: [],
      foreign: [sourceRow(uid), sourceRow(other)], malformed: { rows: [] } }[mode];
    res.end(JSON.stringify(rows));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ORTHANC_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  const orthanc = new OrthancService();
  try {
    const controller = new AbortController();
    assert.equal((await orthanc.viewingSetStudy(uid, controller.signal)).length, 1);
    const url = new URL(seen[0], 'http://x');
    assert.deepEqual([url.pathname, url.searchParams.get('StudyInstanceUID')], ['/dicom-web/studies', uid]);
    assert.deepEqual(url.searchParams.get('includefield').split(',').sort(),
      ['00080020', '00080050', '00080061', '00080080', '00081030', '00100010', '00100020'], 'the display tags are named; no issuer is read');
    mode = 'two'; assert.equal((await orthanc.viewingSetStudy(uid, controller.signal)).length, 2, 'every resource of a split UID is returned');
    mode = 'none'; assert.deepEqual(await orthanc.viewingSetStudy(uid, controller.signal), []);
    for (const bad of ['foreign', 'malformed']) {
      mode = bad;
      await refusedWith(orthanc.viewingSetStudy(uid, controller.signal), 503, undefined, bad + ' is a failed read, never fewer rows');
    }
    mode = 'stall'; const start = Date.now(), cancel = new AbortController();
    const reading = orthanc.viewingSetStudy(uid, cancel.signal);
    await until(() => seen.length === 6, 'the stalled read reached the source');
    setTimeout(() => cancel.abort(), 20);
    await refusedWith(reading, 503, undefined, 'the cancelled read fails');
    assert.ok(Date.now() - start < 3000, 'the abort ends the read long before the per-read limit');
    await until(() => stallClosed, 'the source connection is closed by the abort');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('W9API-18 T16 server part: the real route key, its EMR classification and the clinician gate agree', () => {
  require('/app/node_modules/reflect-metadata');
  const C = require('/app/node_modules/@nestjs/common/constants');
  const handler = MultiStudyViewController.prototype.resolve;
  const key = routeKey(Reflect.getMetadata(C.METHOD_METADATA, handler), Reflect.getMetadata(C.PATH_METADATA, MultiStudyViewController),
    Reflect.getMetadata(C.PATH_METADATA, handler));
  assert.equal(key, VIEWING_SET_SURFACE, 'the surface the provision names is the real route');
  assert.equal(Reflect.getMetadata(C.HTTP_CODE_METADATA, handler), 200);
  assert.equal(Reflect.getMetadata('public', handler) ?? Reflect.getMetadata('public', MultiStudyViewController), undefined, 'not public');
  assert.equal(clinicianRouteAllowed(key), false, 'a clinician-only member is refused by the guard before the service');
  assert.equal(routeContract(key).operation, 'read');
});

test('W9API-19 T03 A-02/A-03 (SRW9-1): a source-tag policy holds for every row the resolve serves, not only for the rows StudyAccess read', async () => {
  // StudyAccess prepares from its own source read; the resolve serves a later read. Between the two, the PatientID changes.
  const moved = (w, uids) => { w.onRead = uid => { if (uids.includes(uid)) w.byUid.get(uid).rows = [sourceRow(uid, { pid: 'SYN-PID-2' })]; }; };
  const both = [study({ pid: 'SYN-PID-1' }), study({ pid: 'SYN-PID-1' })];
  const w = world(both, { policy: patientRule('SYN-PID-1') });
  moved(w, ids(both));
  const served = 'a row the policy refuses must never be served';
  const answer = await opens(resolveFor(w, reader(), body(ids(both))), served);
  assert.deepEqual([codes(answer), answer.scopeStatus, answer.sourcePatientKey], [[MU, MU], 'rejected', null], served);
  assert.equal(w.port.prepared.length, 0, 'nothing refused is provided');
  assert.ok(!JSON.stringify(answer).includes('SYN-PID-2'), 'the refused PatientID is not in the answer');
  // one member moved: that member is unavailable at its place, the other stays ready (not a patient mismatch)
  const one = [study({ pid: 'SYN-PID-1' }), study({ pid: 'SYN-PID-1' })];
  const w1 = world(one, { policy: patientRule('SYN-PID-1') });
  moved(w1, [one[1].uid]);
  const partial = await opens(resolveFor(w1, reader(), body(ids(one))), served);
  assert.deepEqual(codes(partial), ['ready', MU], 'the moved member is unavailable at its place');
  assert.deepEqual(w1.port.prepared[0].targets.map(t => t.uid), [one[0].uid]);
  // every resource of a UID: one served resource outside the policy refuses the member before any split answer names it
  const splitUid = nextUid();
  const split = study({ uid: splitUid, rows: [sourceRow(splitUid, { pid: 'SYN-PID-1' }), sourceRow(splitUid, { pid: 'SYN-PID-1' })] });
  const ws = world([one[0], split], { policy: patientRule('SYN-PID-1') });
  ws.onRead = uid => { if (uid === splitUid) ws.byUid.get(uid).rows = [sourceRow(splitUid, { pid: 'SYN-PID-1' }), sourceRow(splitUid, { pid: 'SYN-PID-3' })]; };
  assert.deepEqual(codes(await opens(resolveFor(ws, reader(), body(ids([one[0], split]))), 'a split read')), ['ready', MU],
    'a served resource outside the policy refuses the member before the split answer');
  // control: unchanged rows under the same policy open, and an unrestricted caller is not held to source tags
  const wc = world(one, { policy: patientRule('SYN-PID-1') });
  assert.deepEqual(codes(await opens(resolveFor(wc, reader(), body(ids(one))), 'unchanged rows')), ['ready', 'ready']);
  const wu = world(both);
  moved(wu, ids(both));
  assert.deepEqual(codes(await opens(resolveFor(wu, reader(), body(ids(both))), 'an unrestricted caller')), ['ready', 'ready']);
});

/** Follows one resolve: whether it settled and with what, without awaiting it (the deadline cases tick mocked time). */
function track(promise) {
  const t = { settled: false, answer: null, error: null };
  t.done = promise.then(answer => { t.settled = true; t.answer = answer; }, error => { t.settled = true; t.error = error; });
  return t;
}
const outcome = t => t.error ? [t.error.getStatus?.() ?? String(t.error), t.error.getResponse?.().code ?? t.error.message]
  : [t.answer.scopeStatus, codes(t.answer)];

test('W9API-21 A-03 (W9A-01): the deadline bounds the StudyAccess preparation read and the served reads at a real source - stalled header or body', async t => {
  // The real StudyAccessService prepares a source-tag policy from the real OrthancService's /tools/find; the source here
  // never sends its header, or sends the header and stalls the body. Served reads are the double's (never reached).
  let mode = 'answer';
  const calls = [];
  const server = http.createServer((req, res) => {
    const call = { url: req.url, closed: false, closedAt: null };
    calls.push(call);
    res.on('close', () => { call.closed = true; call.closedAt = Date.now(); });
    req.resume();
    if (mode === 'header') return;
    // served-body: the policy read answers after 6 s, so the served reads (own 5 s limit) are still held at the deadline
    if (mode === 'served-body' && req.url === '/tools/find') { setTimeout(() => answerFind(res), 6000); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'body' || mode === 'served-body') { res.write('['); return; }
    answerFind(res);
  });
  const answerFind = res => {
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(found.map(s => ({ RequestedTags: { StudyInstanceUID: s.uid, InstitutionName: 'SYN HOSPITAL A',
      PatientID: 'SYN-PID-1', StudyDate: '20261001', ModalitiesInStudy: 'CT' } }))));
  };
  const found = [study(), study()];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ORTHANC_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.ORTHANC_USER = 'synthetic'; process.env.ORTHANC_PASS = 'synthetic';
  try {
    // control: an answering source decides as before, and the policy read is /tools/find
    const wc = world(found, { policy: patientRule('SYN-PID-1') });
    wc.studyAccess = new StudyAccessService(wc.prisma, new OrthancService(), {});
    wc.svc = new MultiStudyViewService(wc.prisma, wc.orthanc, wc.studyAccess, wc.port);
    assert.deepEqual(codes(await opens(resolveFor(wc, reader(), body(ids(found))), 'an answering source')), ['ready', 'ready'], 'an answering source');
    assert.deepEqual(calls.map(c => c.url), ['/tools/find'], 'the preparation reads the batch identity source');
    // real time, as the source and the deadline really meet (Astra AP08): about ten seconds per stall
    // D1550: the server-side socket of every held source request is closed shortly after the deadline, not only the answer.
    const timings = [];
    for (const stall of ['header', 'body', 'served-body']) {
      mode = stall; calls.length = 0;
      const served = stall === 'served-body';
      // served-body: the policy read answers at 6 s, then the resolve's own served reads (two members at once, real
      // OrthancService.viewingSetStudy) are held; their own 5 s limit has not run out when the 10 s deadline arrives
      const w = world(found, { policy: patientRule('SYN-PID-1') });
      const real = new OrthancService();
      w.studyAccess = new StudyAccessService(w.prisma, real, {});
      w.svc = new MultiStudyViewService(w.prisma, served ? real : w.orthanc, w.studyAccess, w.port);
      const heldCalls = () => served ? calls.filter(c => c.url.startsWith('/dicom-web/')) : calls;
      const start = Date.now(), run = track(resolveFor(w, reader(), body(ids(found))));
      run.done.then(() => { run.at = Date.now() - start; });
      await until(() => heldCalls().length === (served ? 2 : 1), stall + ': the held read reached the source', served ? 8000 : 5000);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 9700 - (Date.now() - start))));
      assert.equal(run.settled, false, stall + ': nothing is decided before ten seconds');
      assert.ok(heldCalls().every(c => !c.closed), stall + ': the source read is open before ten seconds');
      await until(() => run.settled, stall + ': the deadline answers the resolve', 2500);
      assert.ok(run.at >= 9900 && run.at < 11500, stall + ': the resolve answers at its ten-second deadline (' + run.at + ' ms)');
      assert.deepEqual(outcome(run), ['rejected', [LF, LF]], stall + ': the deadline answers with the typed timeout result');
      await until(() => heldCalls().every(c => c.closed), stall + ': the policy source read is cancelled by the deadline', 2000);
      const closedMs = heldCalls().map(c => c.closedAt - start);
      assert.ok(closedMs.every(ms => ms >= 9900 && ms < 11000), stall + ': each source socket closes within a second of the deadline (' + closedMs + ')');
      assert.deepEqual([w.port.prepared.length, w.port.finished.length], [0, 0], stall + ': nothing is provided or recorded after the deadline');
      assert.deepEqual(calls.map(c => new URL(c.url, 'http://x').pathname),
        served ? ['/tools/find', '/dicom-web/studies', '/dicom-web/studies'] : ['/tools/find'], stall + ': no other source read');
      if (!served) assert.equal(w.calls.reads.length, 0, stall + ': nothing is read for serving');
      timings.push({ stall, answered_ms: run.at, socket_closed_ms: closedMs });
    }
    t.diagnostic(JSON.stringify(timings));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('W9API-22 A-03 (W9A-01): every wait from resolve entry to the answer is under the one deadline (executed inventory)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const restricted = patientRule('SYN-PID-1');
  // Each point: the wait held at its n-th call, the policy that reaches it, and what the deadline must answer.
  const points = [
    { at: 'policy snapshot', stall: ['policy', 1], policy: null, expect: ['rejected', [LF, LF]] },
    { at: 'member rows', stall: ['states', 1], policy: null, expect: ['rejected', [LF, LF]] },
    { at: 'StudyAccess.allowed snapshot', stall: ['policy', 2], policy: restricted, expect: ['rejected', [LF, LF]] },
    { at: 'StudyAccess.prepare source read (batch)', stall: ['identity', 1], policy: restricted, expect: ['rejected', [LF, LF]], signal: true },
    { at: 'StudyAccess.prepare source read (one UID)', stall: ['identity', 1], policy: restricted, one: true, expect: ['rejected', [SX, LF]], signal: true },
    { at: 'StudyAccess.prepare re-check', stall: ['policy', 3], policy: restricted, expect: ['rejected', [LF, LF]] },
    { at: 'StudyAccess.allowed re-check', stall: ['policy', 4], policy: restricted, expect: ['rejected', [LF, LF]] },
    { at: 'served source reads', read: 'hang', policy: null, expect: ['rejected', [LF, LF]] },
    { at: 'member rows re-check', stall: ['states', 2], policy: null, expect: ['rejected', [LF, LF]] },
    { at: 'policy re-check', stall: ['policy', 5], policy: restricted, expect: ['rejected', [LF, LF]] },
    { at: 'access-record receipt', receipt: true, policy: null, expect: [503, 'W9_AUDIT_UNAVAILABLE'] },
  ];
  const inventory = [];
  for (const p of points) {
    const members = p.one ? [study({ state: { teleInstitutionId: B, ts: 'sent' } }), study()] : [study({ read: p.read }), study({ read: p.read })];
    const w = world(members, { policy: p.policy });
    if (p.stall) w.stalls[p.stall[0]] = p.stall[1];
    let release = null;
    if (p.receipt) w.port.during = () => new Promise(resolve => { release = resolve; });
    const run = track(resolveFor(w, reader(), body(ids(members))));
    await until(() => (p.receipt ? !!release : p.read ? w.calls.reads.length === 2 : !!w.held), p.at + ': the wait is reached');
    t.mock.timers.tick(9999);
    await settle(); await settle();
    assert.equal(run.settled, false, p.at + ': nothing is decided before ten seconds');
    t.mock.timers.tick(1);
    await until(() => run.settled, p.at + ': the deadline answers the resolve');
    assert.deepEqual(outcome(run), p.expect, p.at + ': the deadline answers with the typed timeout result');
    if (p.signal) assert.ok(w.held.signal instanceof AbortSignal && w.held.signal.aborted, p.at + ': the resolve signal reaches the read and aborts');
    // the held wait answers late: nothing changes, nothing is provided, and a late receipt learns its body never went out
    const before = JSON.stringify(outcome(run));
    if (w.held) w.held.release();
    if (release) release();
    await settle(); await settle(); await settle();
    assert.equal(JSON.stringify(outcome(run)), before, p.at + ': a late answer is discarded');
    if (p.receipt) {
      await until(() => w.port.finished.length === 1, p.at + ': the late receipt is finished');
      assert.deepEqual(w.port.finished.map(f => f.outcome), ['aborted'], p.at + ': a late receipt is recorded as an aborted transfer');
    } else assert.deepEqual([w.port.prepared.length, w.port.finished.length], [0, 0], p.at + ': nothing is provided after the deadline');
    noWrites(w);
    inventory.push({ at: p.at, outcome: outcome(run), signal_aborted: p.signal ? w.held.signal.aborted : undefined });
  }
  t.diagnostic(JSON.stringify(inventory));
});

test('W9API-23 A-02/A-03 (D1550): rights per resource AND, then the policy revision, then the source identity - in that order', async () => {
  // (1) the AND of rights per resource: one of a UID's two resources is outside the policy -> StudyAccess refuses the
  // member; it is never read for serving and never answered as a split.
  const normal = study({ pid: 'SYN-PID-1' }), splitUid = nextUid();
  const split = study({ uid: splitUid, rows: [sourceRow(splitUid, { pid: 'SYN-PID-1' }), sourceRow(splitUid, { pid: 'SYN-PID-2' })] });
  const wa = world([normal, split], { policy: patientRule('SYN-PID-1') });
  const anded = 'a UID with one resource outside the policy is refused by StudyAccess and never read';
  assert.deepEqual(codes(await opens(resolveFor(wa, reader(), body(ids([normal, split]))), anded)), ['ready', MU], anded);
  assert.deepEqual(wa.calls.reads.map(r => r.uid), [normal.uid], anded);
  // control: both resources inside the policy -> admitted, read, and only then answered as the split
  const both = study({ uid: nextUid(), rows: [] });
  both.rows = [sourceRow(both.uid, { pid: 'SYN-PID-1' }), sourceRow(both.uid, { pid: 'SYN-PID-1' })];
  const wc = world([normal, both], { policy: patientRule('SYN-PID-1') });
  assert.deepEqual(codes(await opens(resolveFor(wc, reader(), body(ids([normal, both]))), 'an admitted split')), ['ready', STUDY_IDENTITY_UNRESOLVED]);
  // (2) the policy revision is re-checked after the rights read: a revision during StudyAccess's own source read refuses
  // the whole resolve there, before any served read or source identity answer
  const pair = [study({ pid: 'SYN-PID-1' }), study({ pid: 'SYN-PID-1' })];
  const wr = world(pair, { policy: patientRule('SYN-PID-1') });
  const read = wr.orthanc.studyIdentities;
  wr.orthanc.studyIdentities = async (...args) => { const rows = await read(...args); wr.revision = 2; return rows; };
  await refusedWith(resolveFor(wr, reader(), body(ids(pair))), 409, 'STUDY_ACCESS_CHANGED',
    'a policy revision during the rights read refuses before any served read');
  assert.deepEqual([wr.calls.reads.length, wr.port.prepared.length], [0, 0], 'a policy revision during the rights read refuses before any served read');
});

// SRW9-2 binding precondition: Module A binds a real store only when this case runs - EMR-B2 verified request facts let the
// resolve re-check the caller's membership and session between the source wait and prepare() (A-05 remainder).
test.todo('W9API-20 a membership or session change during the source wait refuses the resolve before prepare (pending: EMR-B2 request facts)');
