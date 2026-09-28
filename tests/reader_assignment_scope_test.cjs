'use strict';
/* TEST-S7-U3a-SCOPE-PURE (D-S7-09 a): the compiled reader assignment service and the compiled PacsService tele paths over
 * one recording in-memory store.
 *
 * REQ-S7-U3a-TELE-ASSIGN / REQ-S7-U3a-CLOSE / REQ-S7-U3a-ROWS
 *   -> RISK-S7-U3a-CROSS-TENANT-ASSIGN / RISK-S7-U3a-ORPHAN-AFTER-CLOSE / RISK-S7-U3a-CANDIDATE-LEAK
 *   -> TEST-S7-U3a-SCOPE-PURE (this file). TEST-S7-U3a-LIVE is tests/e2e/test_reader_assignment.py; TEST-S7-U3a-RESTORE
 *   is the restore fixture and the migration pins (tests/ops_product_transfer_test.py and the four source tests).
 *
 * The expected values are the card's rules written out here as literals (owner A, tele receiver B, third institution Z;
 * a manager is admin or technician, a radiologist assigns only itself; W/H and the 5-minute hold as before), never read
 * back from the implementation.
 *
 * The store answers Prisma delegate calls by what their arguments mean (model, operation, where fields), not by SQL
 * text. The service's two raw reads are told apart by what they are given: one study UID (the StudyState row), or the
 * assignment audit action with an institution and a revision floor (the history). Every call is logged with the client
 * that made it (root or tx#n), and a transaction's writes are undone when its callback throws, so "same transaction"
 * and "atomic with the channel change" are read from the log and the store. The store also refuses what
 * 20260928130000_reader_assignment_scope's CHECK refuses. Study access is a recording stand-in that always allows;
 * its own rules are tests/study_access_service_test.cjs's. Container only (kin-api image: /app/dist).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ReaderAssignmentService } = require('/app/dist/reader-assignment.service');
const { PacsService } = require('/app/dist/pacs.service');

const A = 'synthetic-a', B = 'synthetic-b', Z = 'synthetic-z';
const INSTITUTIONS = [A, B, Z];
const UID = '2.25.73001', OTHER_UID = '2.25.73002', Z_UID = '2.25.73003', UNKNOWN_UID = '2.25.73999';
const ACTION = 'reader.assignment';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

// name -> [Keycloak groups, realm roles]. abDoc sits in two groups: never a candidate or an assignee anywhere.
const PEOPLE = {
  aAdmin: [[A], ['admin']], aTech: [[A], ['technician']], aDoc: [[A], ['radiologist']], aDoc2: [[A], ['radiologist']],
  bAdmin: [[B], ['admin']], bTech: [[B], ['technician']], bDoc: [[B], ['radiologist']], bDoc2: [[B], ['radiologist']],
  zTech: [[Z], ['technician']], zDoc: [[Z], ['radiologist']],
  abDoc: [[A, B], ['radiologist']],
};
const SUB = Object.fromEntries(Object.keys(PEOPLE).map((name, n) => [name, id(7300 + n)]));
const actorOf = name => 'syn-' + name.toLowerCase() + '@synthetic.test';
const caller = name => ({ kind: 'member', institution: PEOPLE[name][0][0], sub: SUB[name], actor: actorOf(name), roles: [...PEOPLE[name][1]] });
const kcUser = name => ({ id: SUB[name], username: 'syn-' + name.toLowerCase(), email: actorOf(name), emailVerified: true,
  firstName: 'SYNTHETIC', lastName: name, enabled: true, serviceAccountClientId: null, groups: [...PEOPLE[name][0]], roles: [...PEOPLE[name][1]] });
const reader = name => ({ sub: SUB[name], actor: actorOf(name), name: name + ' SYNTHETIC' });
const status = n => e => typeof e?.getStatus === 'function' && e.getStatus() === n;
const response = async promise => { try { await promise; } catch (e) { return JSON.stringify(e.getResponse()); } assert.fail('expected a refusal'); };

/** One store, one recording client per transaction, the real services over it. */
function world() {
  const t = { StudyState: new Map(), ReaderAssignment: new Map(), AuditLog: [] };
  const log = [];
  let auditSeq = 0, txSeq = 0, clock = Date.parse('2026-09-28T00:00:00.000Z');
  const now = () => new Date(clock += 1000);
  const clone = value => structuredClone(value);
  const pick = (row, select) => select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row;
  const pair = (studyUid, institutionId) => studyUid + '|' + institutionId;
  const matches = (row, where) => Object.entries(where ?? {}).every(([k, v]) => {
    if (k === 'OR') return v.some(w => matches(row, w));
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('notIn' in v) return !v.notIn.includes(row[k]);
      throw new Error('unexpected filter ' + k + ' ' + JSON.stringify(v));
    }
    return (row[k] ?? null) === v;
  });
  const uniquePair = where => {
    const key = where?.studyUid_institutionId;
    if (!key || Object.keys(where).length !== 1) throw new Error('a ReaderAssignment row is found by its (studyUid, institutionId) key');
    return pair(key.studyUid, key.institutionId);
  };
  // 20260928130000_reader_assignment_scope's CHECK, as PostgreSQL would refuse the write.
  const check = row => {
    const revisionOk = row.closedRevision == null || (row.closedRevision > 0 && row.closedRevision <= row.revision);
    const closedOk = row.closedAt == null || (row.closedRevision === row.revision && row.readerSub == null && row.readerActor == null && row.readerName == null);
    if (!revisionOk || !closedOk) throw Object.assign(new Error('ReaderAssignment_closed_check'), { code: 'P2004' });
  };
  function client(name) {
    const record = (model, op, args) => log.push({ client: name, model, op, args: clone(args ?? null) });
    const none = model => ({ findFirst: async a => { record(model, 'findFirst', a); return null; } });
    const c = {
      __name: name,
      $executeRaw: async () => { record('$', 'executeRaw'); return 0; },
      $queryRaw: async (strings, ...values) => {
        const uids = values.filter(v => typeof v === 'string' && /^\d+(?:\.\d+)+$/.test(v));
        if (values.includes(ACTION)) {
          // The assignment history: one study, one institution, entries above a revision floor, newest first, 20.
          const institution = values.find(v => INSTITUTIONS.includes(v)), floor = values.find(v => typeof v === 'number');
          record('AuditLog', 'history', { uid: uids[0], institution, floor });
          return t.AuditLog.filter(a => a.target === uids[0] && a.action === ACTION)
            .filter(a => { const d = JSON.parse(a.detail); return d.institution === institution && d.revision > floor; })
            .sort((x, y) => y.at - x.at || y.id - x.id).slice(0, 20).map(a => clone({ at: a.at, actor: a.actor, detail: a.detail }));
        }
        if (values.length === 1 && uids.length === 1) {
          record('StudyState', 'raw', { uid: uids[0] });
          const row = t.StudyState.get(uids[0]);
          return row ? [clone(row)] : [];
        }
        record('$', 'queryRaw', { values: values.length });
        return [];
      },
      studyState: {
        findUnique: async a => { record('StudyState', 'findUnique', a); const row = t.StudyState.get(a.where.uid); return row ? pick(clone(row), a.select) : null; },
        findMany: async a => { record('StudyState', 'findMany', a); return [...t.StudyState.values()].filter(r => matches(r, a?.where)).map(r => pick(clone(r), a?.select)); },
        update: async a => { record('StudyState', 'update', a); const row = t.StudyState.get(a.where.uid); if (!row) throw new Error('no study');
          Object.assign(row, a.data, { updatedAt: now() }); return clone(row); },
        delete: async a => { record('StudyState', 'delete', a); const row = t.StudyState.get(a.where.uid); t.StudyState.delete(a.where.uid); return clone(row); },
        create: async () => { throw new Error('no study is created here'); },
      },
      readerAssignment: {
        findUnique: async a => { record('ReaderAssignment', 'findUnique', a); const row = t.ReaderAssignment.get(uniquePair(a.where)); return row ? clone(row) : null; },
        findMany: async a => { record('ReaderAssignment', 'findMany', a); return [...t.ReaderAssignment.values()].filter(r => matches(r, a.where)).map(clone); },
        upsert: async a => {
          record('ReaderAssignment', 'upsert', a);
          const key = uniquePair(a.where), current = t.ReaderAssignment.get(key);
          const next = current ? { ...current, ...a.update, updatedAt: now() } : { closedRevision: null, closedAt: null, ...a.create, updatedAt: now() };
          if (pair(next.studyUid, next.institutionId) !== key) throw new Error('the row left its key');
          check(next); t.ReaderAssignment.set(key, next); return clone(next);
        },
        update: async a => {
          record('ReaderAssignment', 'update', a);
          const key = uniquePair(a.where), current = t.ReaderAssignment.get(key);
          if (!current) throw Object.assign(new Error('no row'), { code: 'P2025' });
          const next = { ...current, ...a.data, updatedAt: now() }; check(next); t.ReaderAssignment.set(key, next); return clone(next);
        },
      },
      auditLog: { create: async a => { record('AuditLog', 'create', a);
        if (w.failAudit?.(a.data)) throw new Error('SYNTHETIC audit failure');
        const row = { id: ++auditSeq, at: now(), ...a.data }; t.AuditLog.push(row); return clone(row); } },
      report: { findUnique: async () => null, findMany: async () => [] },
      reportDraft: { findUnique: async () => null, findMany: async () => [], findFirst: async () => null },
      reportVersion: none('ReportVersion'), viewerItem: none('ViewerItem'), techNoteRevision: none('TechNoteRevision'),
      viewerJob: none('ViewerJob'), studyQuestion: none('StudyQuestion'), studyImageRequest: none('StudyImageRequest'),
      criticalResult: none('CriticalResult'),
      gatewayReceipt: { findMany: async () => [] },
      order: { findMany: async () => [], update: async () => { throw new Error('no order is linked here'); } },
    };
    if (name === 'root') c.$transaction = async (fn) => {
      const n = ++txSeq, tx = 'tx#' + n;
      const saved = clone({ s: [...t.StudyState], r: [...t.ReaderAssignment], a: t.AuditLog, auditSeq });
      log.push({ client: tx, model: '$', op: 'begin' });
      try {
        const result = await fn(client(tx));
        log.push({ client: tx, model: '$', op: 'commit' });
        return result;
      } catch (error) {
        t.StudyState = new Map(saved.s); t.ReaderAssignment = new Map(saved.r); t.AuditLog = saved.a; auditSeq = saved.auditSeq;
        log.push({ client: tx, model: '$', op: 'rollback' });
        throw error;
      }
    };
    return c;
  }
  const root = client('root');
  const access = {
    calls: [],
    prepare: async (c, uids) => { access.calls.push(['prepare', c.institution, uids]); },
    snapshot: async (c, db) => { access.calls.push(['snapshot', c.institution, db?.__name ?? 'root']); return { revision: 1, windowOpen: true, policy: { version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] } }; },
    require: async (c, uids, db) => { access.calls.push(['require', c.institution, uids, db?.__name ?? 'root']); },
    allowed: async (c, uids) => new Set(uids), matches: () => true, needsMetadata: () => false, unchanged: async () => {},
  };
  const keycloak = {
    calls: [],
    assignmentReaders: async institution => { keycloak.calls.push(['assignmentReaders', institution]);
      return Object.keys(PEOPLE).filter(name => PEOPLE[name][0].includes(institution)).map(kcUser); },
    getUser: async sub => { keycloak.calls.push(['getUser', sub]); const name = Object.keys(SUB).find(k => SUB[k] === sub); return name ? kcUser(name) : null; },
  };
  const orthanc = {
    studies: async () => [...t.StudyState.values()].map(s => ({ '0020000D': { Value: [s.uid] }, '00080080': { Value: [s.institutionId] },
      '00100020': { Value: ['SYN-' + s.uid] }, '00100010': { Value: ['SYNTHETIC^PATIENT'] } })),
  };
  const w = {
    t, log, access, keycloak,
    ra: new ReaderAssignmentService(root, keycloak, access),
    pacs: new PacsService(root, orthanc, keycloak, access, {}),
    study(uid, { owner = A, tele = null, ts = tele ? 'wait' : 'none', rs = 'W', holder = null, heldAt = null } = {}) {
      t.StudyState.set(uid, { uid, institutionId: owner, teleInstitutionId: tele, origin: 'dicom', rs, holdReason: null, ss: 'Verified', em: 'N', ts,
        matched: 'U', ward: '', reqHosp: owner, repDoc: null, confirm: null, preDoc: null, preReviewer: null, ov: null, orig: null,
        orderOid: null, holder, heldAt, updatedAt: new Date(clock), createdAt: new Date(clock) });
    },
    row: (uid, institution) => { const row = t.ReaderAssignment.get(pair(uid, institution)); return row ? clone(row) : null; },
    read: (name, uid = UID) => w.ra.read(uid, caller(name)),
    body: (name, state, readerName, requestId = randomUUID()) => ({ expectedOwner: [caller(name).institution, SUB[name]], revision: state.revision,
      readerSub: readerName ? SUB[readerName] : null, requestId }),
    write: (name, body, uid = UID) => w.ra.write(uid, caller(name), body),
    async assign(name, readerName, uid = UID) { return w.write(name, w.body(name, await w.read(name, uid), readerName), uid); },
    tele: (body, uid = UID, name = 'aDoc') => w.pacs.patchState(uid, body, caller(name)),
    mark: () => log.length,
    since: at => log.slice(at),
    audits: () => clone(t.AuditLog).map(a => ({ ...a, detail: JSON.parse(a.detail) })),
  };
  w.pacs.institutions = INSTITUTIONS.map(i => ({ id: i, name: i }));
  return w;
}

// Channel histories of one study owned by A: never opened, open to B, cancelled, and opened to B again.
async function channel(w, state) {
  w.study(UID);
  if (state === 'never') return;
  await w.tele({ ts: 'wait', teleTo: B });
  if (state === 'open') return;
  await w.tele({ ts: 'cancelled' });
  if (state === 'closed') return;
  await w.tele({ ts: 'wait', teleTo: B });
}

test('the boundary matrix: owner A always, receiver B only while its channel is open, third institution Z never', async () => {
  // institution -> may it read and write the study's assignment, per channel state (REQ-S7-U3a-TELE-ASSIGN).
  const EXPECTED = {
    never: { A: true, B: false, Z: false }, open: { A: true, B: true, Z: false },
    closed: { A: true, B: false, Z: false }, reopened: { A: true, B: true, Z: false },
  };
  const ROLES = { A: ['aTech', 'aDoc'], B: ['bTech', 'bDoc'], Z: ['zTech', 'zDoc'] };
  const SECOND = { aTech: 'aDoc2', bTech: 'bDoc2', zTech: 'zDoc' };
  const observed = {};
  for (const state of Object.keys(EXPECTED)) {
    observed[state] = {};
    for (const [label, [manager, radiologist]] of Object.entries(ROLES)) {
      const w = world();
      await channel(w, state);
      const unknown = await response(w.read(manager, UNKNOWN_UID));
      const outcome = [];
      for (const [name, act] of [[radiologist, () => w.assign(radiologist, radiologist)], [manager, () => w.assign(manager, SECOND[manager])],
                                 [manager, () => w.read(manager)], [radiologist, () => w.read(radiologist)]]) {
        try { await act(); outcome.push(true); }
        catch (e) {
          assert.ok(status(404)(e), state + ' ' + name + ': ' + e.message);
          // No existence oracle: the refusal is the one an unknown UID gets, and the one gate() gives (GET audit).
          assert.equal(JSON.stringify(e.getResponse()), unknown, state + ' ' + name);
          assert.equal(await response(w.pacs.audits(UID, 10, caller(name))), unknown, state + ' ' + name + ' gate()');
          outcome.push(false);
        }
      }
      assert.ok(outcome.every(x => x === outcome[0]), state + ' ' + label + ' ' + JSON.stringify(outcome));
      observed[state][label] = outcome[0];
      // The caller institution's own row moved twice, or a refused institution wrote nothing; no other row appeared.
      const own = w.row(UID, PEOPLE[manager][0][0]);
      if (outcome[0]) assert.deepEqual([own.revision, own.readerSub, own.closedAt], [2, SUB[SECOND[manager]], null], state + ' ' + label);
      else assert.equal(own, null, state + ' ' + label + ' refused but wrote');
      for (const other of INSTITUTIONS.filter(i => i !== PEOPLE[manager][0][0])) assert.equal(w.row(UID, other), null, state + ' ' + label + ' ' + other);
    }
  }
  assert.deepEqual(observed, EXPECTED);
});

test('owner and receiver keep their own rows: reads, writes, history and candidates never cross', async () => {
  const w = world();
  await channel(w, 'open');
  await w.assign('aTech', 'aDoc');
  await w.assign('bTech', 'bDoc');
  await w.assign('bDoc', null);   // the receiver's radiologist clears its own assignment...
  await w.assign('bDoc', 'bDoc');  // ...and takes it back: two rules of the existing model, at B
  const a = await w.read('aTech'), b = await w.read('bTech');
  assert.deepEqual([a.owner, a.revision, a.reader, a.canManage], [[A, SUB.aTech], 1, reader('aDoc'), true]);
  assert.deepEqual([b.owner, b.revision, b.reader, b.canManage], [[B, SUB.bTech], 3, reader('bDoc'), true]);
  assert.deepEqual(a.history.map(h => [h.actor, h.detail]), [[actorOf('aTech'), { institution: A, revision: 1, from: null, to: actorOf('aDoc') }]]);
  assert.deepEqual(b.history.map(h => [h.actor, h.detail]), [
    [actorOf('bDoc'), { institution: B, revision: 3, from: null, to: actorOf('bDoc') }],
    [actorOf('bDoc'), { institution: B, revision: 2, from: actorOf('bDoc'), to: null }],
    [actorOf('bTech'), { institution: B, revision: 1, from: null, to: actorOf('bDoc') }]]);
  for (const [answer, foreign] of [[a, ['bTech', 'bDoc']], [b, ['aTech', 'aDoc']]])
    for (const name of foreign) {
      assert.equal(JSON.stringify(answer).includes(actorOf(name)), false, name);
      assert.equal(JSON.stringify(answer).includes(SUB[name]), false, name);
    }
  assert.deepEqual([...w.t.ReaderAssignment.keys()].sort(), [UID + '|' + A, UID + '|' + B]);
  // Assigning across the boundary: the other institution's reader, a two-group reader, or another institution's owner.
  for (const [name, target] of [['bTech', 'aDoc'], ['aTech', 'bDoc'], ['bTech', 'abDoc'], ['aTech', 'abDoc'], ['bAdmin', 'zDoc'], ['bDoc', 'aDoc']])
    await assert.rejects(w.write(name, w.body(name, await w.read(name), target)), status(400), name + ' -> ' + target);
  const stale = w.body('bTech', await w.read('bTech'), 'bDoc2');
  await assert.rejects(w.write('bTech', { ...stale, expectedOwner: [A, SUB.bTech] }), status(409));
  assert.deepEqual([w.row(UID, A).revision, w.row(UID, B).revision], [1, 3], 'no refused call moved a row');
  // Candidates: the caller institution's single-group radiologists, asked of Keycloak for that institution only.
  w.keycloak.calls.length = 0;
  const subs = async name => (await w.ra.candidates(caller(name))).readers.map(r => r.sub).sort();
  assert.deepEqual(await subs('aTech'), [SUB.aDoc, SUB.aDoc2].sort());
  assert.deepEqual(await subs('bTech'), [SUB.bDoc, SUB.bDoc2].sort());
  assert.deepEqual(await subs('bAdmin'), [SUB.bDoc, SUB.bDoc2].sort());
  assert.deepEqual(await subs('zTech'), [SUB.zDoc]);
  assert.deepEqual(await subs('bDoc'), [SUB.bDoc]);
  assert.deepEqual(w.keycloak.calls.filter(c => c[0] === 'assignmentReaders').map(c => c[1]), [A, B, B, Z, B]);
});

test('closing the channel closes the receiver row in the same transaction, with one audit entry; the owner row stays', async () => {
  const w = world();
  await channel(w, 'open');
  await w.assign('aTech', 'aDoc');
  await w.assign('bTech', 'bDoc');
  const last = w.body('bTech', await w.read('bTech'), 'bDoc2');
  await w.write('bTech', last);
  const ownerBefore = w.row(UID, A), auditsBefore = w.audits().length, at = w.mark();
  const answer = await w.tele({ ts: 'cancelled' });
  assert.equal(answer.teleInstitutionId, null);
  const calls = w.since(at);
  const [change] = calls.filter(c => c.model === 'StudyState' && c.op === 'update');
  const tx = change.client;
  assert.match(tx, /^tx#\d+$/);
  const writes = calls.filter(c => (c.model === 'ReaderAssignment' && c.op !== 'findUnique' && c.op !== 'findMany') || (c.model === 'AuditLog' && c.op === 'create'));
  assert.deepEqual(writes.map(c => [c.client, c.model, c.op, c.args?.data?.action ?? '']).sort(),
    [[tx, 'AuditLog', 'create', ACTION], [tx, 'AuditLog', 'create', 'state.patch'], [tx, 'ReaderAssignment', 'update', '']]);
  assert.deepEqual(calls.filter(c => c.client === tx && ['begin', 'commit', 'rollback'].includes(c.op)).map(c => c.op), ['begin', 'commit']);
  // The close is decided after the channel change, under the lock that change holds.
  const order = key => calls.findIndex(c => c.client === tx && key(c));
  assert.ok(order(c => c.model === 'StudyState' && c.op === 'update') < order(c => c.model === 'ReaderAssignment' && c.op === 'findMany'));
  const closed = w.row(UID, B);
  assert.deepEqual({ ...closed, closedAt: closed.closedAt instanceof Date, updatedAt: undefined, lastRequest: closed.lastRequest === last.requestId,
    lastFingerprint: /^[0-9a-f]{64}$/.test(closed.lastFingerprint) }, {
    studyUid: UID, institutionId: B, revision: 3, readerSub: null, readerActor: null, readerName: null, changedBy: actorOf('aDoc'),
    lastRequest: false, lastFingerprint: true, updatedAt: undefined, closedRevision: 3, closedAt: true });
  assert.deepEqual(w.row(UID, A), ownerBefore);
  const added = w.audits().slice(auditsBefore);
  assert.deepEqual(added.filter(a => a.action === ACTION).map(a => [a.actor, a.target, a.detail]),
    [[actorOf('aDoc'), UID, { institution: B, revision: 3, from: actorOf('bDoc2'), to: null, closed: 'tele-closed' }]]);
  // Nothing of B's assignment reaches B afterwards; A's reads are what they were.
  for (const name of ['bTech', 'bDoc', 'bAdmin']) await assert.rejects(w.read(name), status(404), name);
  await assert.rejects(w.write('bTech', w.body('bTech', { revision: 3 }, 'bDoc')), status(404));
  assert.equal((await w.pacs.listStudies(caller('bTech'))).studies.some(s => s.uid === UID), false);
  const a = await w.read('aTech');
  assert.deepEqual([a.revision, a.reader, a.history.map(h => h.detail.institution)], [1, reader('aDoc'), [A]]);
  // A cancel with no receiver row writes no assignment row and no assignment audit.
  const v = world();
  await channel(v, 'open');
  const mark = v.mark();
  await v.tele({ ts: 'cancelled' });
  assert.deepEqual(v.since(mark).filter(c => c.model === 'ReaderAssignment' && !['findMany', 'findUnique'].includes(c.op)), []);
  assert.deepEqual(v.audits().filter(a => a.action === ACTION), []);
});

test('the close is atomic with the channel change: a failure after it leaves the channel and the row as they were', async () => {
  const w = world();
  await channel(w, 'open');
  await w.assign('bTech', 'bDoc');
  const before = { study: structuredClone(w.t.StudyState.get(UID)), row: w.row(UID, B), audits: w.audits().length };
  w.failAudit = data => data.action === 'state.patch';
  const at = w.mark();
  await assert.rejects(w.tele({ ts: 'cancelled' }), /SYNTHETIC audit failure/);
  w.failAudit = null;
  const calls = w.since(at);
  const tx = calls.find(c => c.model === 'StudyState' && c.op === 'update').client;
  assert.ok(calls.some(c => c.client === tx && c.model === 'ReaderAssignment' && c.op === 'update'), 'the close ran in that transaction');
  assert.deepEqual(calls.filter(c => c.client === tx && ['begin', 'commit', 'rollback'].includes(c.op)).map(c => c.op), ['begin', 'rollback']);
  assert.deepEqual(structuredClone(w.t.StudyState.get(UID)), before.study);
  assert.deepEqual(w.row(UID, B), before.row);
  assert.equal(w.audits().length, before.audits);
  assert.deepEqual((await w.read('bDoc')).reader, reader('bDoc'));
});

test('a reopened channel starts at a new revision: no reader, no history and no request of the closed channel carries over', async () => {
  const w = world();
  await channel(w, 'open');
  await w.assign('aTech', 'aDoc');
  const first = w.body('bTech', await w.read('bTech'), 'bDoc');
  await w.write('bTech', first);
  const ownerBefore = w.row(UID, A);
  await w.tele({ ts: 'cancelled' });
  const at = w.mark();
  await w.tele({ ts: 'wait', teleTo: B });
  // Reopening is the owner's act: it writes no assignment row; B's row stays closed until B writes.
  assert.deepEqual(w.since(at).filter(c => c.model === 'ReaderAssignment' && !['findMany', 'findUnique'].includes(c.op)), []);
  assert.ok(w.row(UID, B).closedAt instanceof Date);
  const reopened = await w.read('bTech');
  assert.deepEqual([reopened.revision, reopened.reader, reopened.history], [2, null, []]);
  // The closed channel's last request is not a replay any more, and its revision is stale.
  await assert.rejects(w.write('bTech', first), status(409));
  await assert.rejects(w.write('bTech', w.body('bTech', { revision: 1 }, 'bDoc2')), status(409));
  const written = await w.write('bTech', w.body('bTech', reopened, 'bDoc2'));
  assert.deepEqual([written.revision, written.reader, written.history.map(h => h.detail)],
    [3, reader('bDoc2'), [{ institution: B, revision: 3, from: null, to: actorOf('bDoc2') }]]);
  const row = w.row(UID, B);
  assert.deepEqual([row.revision, row.closedRevision, row.closedAt, row.readerSub], [3, 2, null, SUB.bDoc2]);
  assert.deepEqual(w.row(UID, A), ownerBefore);
  // Closed and reopened once more: the floor moves to the new close, and the second channel's entry is gone too.
  await w.tele({ ts: 'cancelled' });
  await w.tele({ ts: 'wait', teleTo: B });
  assert.deepEqual(await w.read('bTech').then(s => [s.revision, s.reader, s.history]), [4, null, []]);
  assert.deepEqual(w.audits().filter(a => a.action === ACTION && a.detail.institution === B).map(a => [a.detail.revision, a.detail.closed ?? null]),
    [[1, null], [2, 'tele-closed'], [3, null], [4, 'tele-closed']]);
});

test('every path that takes the channel away closes the row: a new teleTo and a study delete; a delete without one changes nothing', async () => {
  // Redirect: the owner sends the waiting study to Z instead of B.
  const w = world();
  await channel(w, 'open');
  await w.assign('bTech', 'bDoc');
  await w.tele({ ts: 'sending', teleTo: Z });
  assert.deepEqual([w.row(UID, B).closedRevision, w.row(UID, B).readerSub], [2, null]);
  await assert.rejects(w.read('bTech'), status(404));
  assert.deepEqual(await w.read('zTech').then(s => [s.revision, s.reader, s.history]), [0, null, []]);
  // Delete while the channel is open: the receiver row closes in the delete's transaction; the owner row is left as before.
  const d = world();
  await channel(d, 'open');
  await d.assign('aTech', 'aDoc');
  await d.assign('bTech', 'bDoc');
  const ownerBefore = d.row(UID, A), at = d.mark();
  assert.deepEqual(await d.pacs.removeState(UID, caller('aTech')), { ok: true });
  const calls = d.since(at), tx = calls.find(c => c.model === 'StudyState' && c.op === 'delete').client;
  assert.deepEqual(calls.filter(c => c.model === 'ReaderAssignment' && c.op === 'update').map(c => c.client), [tx]);
  assert.deepEqual(d.audits().filter(a => a.action === ACTION && a.detail.closed).map(a => [a.actor, a.detail]),
    [[actorOf('aTech'), { institution: B, revision: 2, from: actorOf('bDoc'), to: null, closed: 'study-deleted' }]]);
  assert.deepEqual(d.row(UID, A), ownerBefore);
  // Delete with no channel open: no assignment call at all.
  const n = world();
  n.study(OTHER_UID);
  const mark = n.mark();
  await n.pacs.removeState(OTHER_UID, caller('aTech'));
  assert.deepEqual(n.since(mark).filter(c => c.model === 'ReaderAssignment'), []);
});

test('a write whose check passed before the close cannot land after it', async () => {
  const w = world();
  await channel(w, 'open');
  const getUser = w.keycloak.getUser;
  let cancelled = false;
  // The receiver's request passes its first study check; Keycloak's eligibility answer comes back only after the
  // owner has cancelled the channel.
  w.keycloak.getUser = async sub => { if (!cancelled) { cancelled = true; await w.tele({ ts: 'cancelled' }); } return getUser(sub); };
  await assert.rejects(w.assign('bTech', 'bDoc'), status(404));
  assert.equal(cancelled, true);
  assert.equal(w.row(UID, B), null);
  assert.deepEqual(w.audits().filter(a => a.action === ACTION), []);
});

test('the existing rules hold unchanged at the receiver: replay, CAS, radiologist self only, W/H and the hold', async () => {
  const w = world();
  await channel(w, 'open');
  const body = w.body('bTech', await w.read('bTech'), 'bDoc');
  const first = await w.write('bTech', body);
  const entries = w.audits().length;
  assert.deepEqual(await w.write('bTech', body), first, 'a replay answers the same state');
  assert.equal(w.audits().length, entries, 'and writes nothing');
  await assert.rejects(w.write('bTech', { ...body, readerSub: SUB.bDoc2 }), status(409));
  await assert.rejects(w.write('bTech', w.body('bTech', { revision: 0 }, 'bDoc2')), status(409));
  await assert.rejects(w.assign('bDoc2', 'bDoc2'), status(403));
  await assert.rejects(w.assign('bDoc2', null), status(403));
  assert.equal((await w.assign('bDoc', null)).reader, null);
  for (const [rs, allowed] of [['T', false], ['P', false], ['A', false], ['H', true], ['W', true]]) {
    w.t.StudyState.get(UID).rs = rs;
    if (allowed) assert.ok(await w.assign('bTech', 'bDoc2'), rs);
    else await assert.rejects(w.assign('bTech', 'bDoc2'), status(409), rs);
  }
  Object.assign(w.t.StudyState.get(UID), { holder: actorOf('bDoc'), heldAt: new Date() });
  await assert.rejects(w.assign('bTech', null), status(409));
  w.t.StudyState.get(UID).heldAt = new Date(Date.now() - 301000);
  assert.equal((await w.assign('bTech', null)).reader, null);
  // Every read and write asked study access with the transaction it ran in.
  assert.ok(w.access.calls.filter(c => c[0] === 'require' && c[1] === B).every(c => c[3] === 'root' || /^tx#\d+$/.test(c[3])));
  assert.ok(w.access.calls.some(c => c[0] === 'require' && c[1] === B && /^tx#\d+$/.test(c[3])));
});

test('worklist rows carry the caller institution\'s own assignment on owned and tele-received rows', async () => {
  const w = world();
  w.study(UID, { owner: A, tele: B });
  w.study(OTHER_UID, { owner: B });
  w.study(Z_UID, { owner: Z });
  await w.assign('aTech', 'aDoc');
  await w.assign('bTech', 'bDoc');
  await w.assign('bTech', 'bDoc2', OTHER_UID);
  const list = async name => {
    const at = w.mark();
    const r = await w.pacs.listStudies(caller(name));
    const reads = w.since(at).filter(c => c.model === 'ReaderAssignment');
    assert.deepEqual(reads.map(c => [c.op, c.args.where.institutionId]), [['findMany', caller(name).institution]], name);
    return { rows: Object.fromEntries(r.studies.map(s => [s.uid, [s.tele, s.readerAssignment]])), text: JSON.stringify(r) };
  };
  const a = await list('aTech'), b = await list('bDoc'), z = await list('zTech');
  assert.deepEqual(a.rows, { [UID]: [false, { revision: 1, reader: reader('aDoc') }] });
  assert.deepEqual(b.rows, { [UID]: [true, { revision: 1, reader: reader('bDoc') }], [OTHER_UID]: [false, { revision: 1, reader: reader('bDoc2') }] });
  assert.deepEqual(z.rows, { [Z_UID]: [false, { revision: 0, reader: null }] });
  for (const name of ['bTech', 'bDoc', 'bDoc2']) assert.equal(a.text.includes(actorOf(name)) || a.text.includes(SUB[name]), false, name);
  for (const name of ['aTech', 'aDoc']) assert.equal(b.text.includes(actorOf(name)) || b.text.includes(SUB[name]), false, name);
  // Closed, the tele row leaves B's list; reopened, it comes back with the new revision and no reader.
  await w.tele({ ts: 'cancelled' });
  assert.deepEqual(Object.keys((await list('bDoc')).rows), [OTHER_UID]);
  await w.tele({ ts: 'wait', teleTo: B });
  assert.deepEqual((await list('bDoc')).rows[UID], [true, { revision: 2, reader: null }]);
  assert.deepEqual((await list('aTech')).rows[UID], [false, { revision: 1, reader: reader('aDoc') }]);
});
