'use strict';
/* TEST-S7-U1a-SERVICE / TEST-S7-U1a-MATRIX (pure half): the compiled critical result policy and service over a stub
 * store, a recording Keycloak and a recording Orthanc (contract S7-U1p section 2.3 SV01-SV14).
 *
 * REQ-S7-U1a-RECORD / REQ-S7-U1a-SOURCE-PIN / REQ-S7-U1a-AUTHZ / REQ-S7-U1a-IDEMPOTENCY / REQ-S7-U1a-RECIPIENT-MATRIX /
 * REQ-S7-U1a-AUDIT-ATTRIBUTION / REQ-S7-U1p-RECIPIENT-CLASS / REQ-S7-U1p-IDENTITY / REQ-S7-U1p-DEDUP /
 * REQ-S7-U1p-WRITE-OUTCOME
 *   -> RISK-S7-U1p-DRAFT-OR-LATEST / RISK-S7-U1p-FALSE-ACK / RISK-S7-U1p-WIDENING / RISK-S7-CVR-WRONG-RECIPIENT /
 *      RISK-S7-CVR-STALE-SOURCE / RISK-S7-CVR-PROXY-ACK / RISK-S7-CVR-ACK-CANCEL-RACE / RISK-S7-CVR-REVOKED-ACK /
 *      RISK-S7-CVR-PHI-IN-AUDIT / RISK-S7-CVR-SOURCE-BYPASS / RISK-S7-U1p-CLASS-WIDENING / RISK-S7-U1p-STALE-IDENTITY /
 *      RISK-S7-U1p-DUPLICATE-PENDING / RISK-S7-U1p-FALSE-UNDELIVERED
 *   -> TEST-S7-U1a-SERVICE (this file).
 *
 * The expected values below are the contract's tables (M-S7-CVR and the R rows of section 4.2, state-machine.json
 * transitions and refusals, the section 3.3/3.4/11 key sets, section 7.1 replay sequences), written out here as literals;
 * none of them is read back from the implementation. The real StudyAccessService (compiled) decides access; Prisma,
 * Keycloak and Orthanc are stubs. The stub answers the statements the service sends by the table they name and keeps
 * PostgreSQL's two behaviours the contract relies on: a RepeatableRead transaction reads the store as it was when it
 * started, and FOR UPDATE on StudyState/CriticalResult waits for the holder's transaction to end (ReadCommitted re-reads).
 * Every Keycloak, Orthanc and transaction boundary is logged in one ordered list.
 * Container only (kin-api image, /app/dist), as the other compiled service tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { from, lastValueFrom } = require('/app/node_modules/rxjs');
const { ConflictException, ServiceUnavailableException } = require('/app/node_modules/@nestjs/common');
const P = require('/app/dist/critical-result-policy');
const { CriticalResultService, CRITICAL_RESULT_AUDIT_ACTION } = require('/app/dist/critical-result.service');
const { CriticalResultController } = require('/app/dist/critical-result.controller');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { StudyAccessInterceptor } = require('/app/dist/study-access.interceptor');
const { OWNER_ONLY_AUDIT_ACTIONS } = require('/app/dist/pacs.service');
const { AUDIT_HIDDEN_STUDY_SCOPED, auditRule } = require('/app/dist/admin-audit');
const { CLINICIAN_BUSINESS_ROUTES } = require('/app/dist/clinician-policy');

const INST = 'synthetic-a';
const OTHER = 'synthetic-b';
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const UID = '2.25.7001', UID2 = '2.25.7002', TELE_UID = '2.25.7003';

// Members: sub, token roles, Keycloak groups. Names are synthetic.
const PEOPLE = {
  S: { roles: ['radiologist'] }, X: { roles: ['radiologist'] }, Y: { roles: ['radiologist'] }, Z: { roles: ['radiologist'] },
  P: { roles: ['clinician'] }, P2: { roles: ['clinician'] }, M: { roles: ['clinician', 'radiologist'] },
  CT: { roles: ['clinician', 'technician'] }, CA: { roles: ['clinician', 'admin'] }, AD: { roles: ['admin'] }, T: { roles: ['technician'] },
  AR: { roles: ['admin', 'radiologist'] }, K: { roles: ['radiologist'], group: OTHER }, KC: { roles: ['clinician'], group: OTHER },
};
const SUBS = Object.fromEntries(Object.keys(PEOPLE).map((name, n) => [name, id(9000 + n)]));
const actorOf = name => 'syn-' + name.toLowerCase() + '@synthetic.test';
const person = name => ({ kind: 'member', institution: PEOPLE[name].group ?? INST, sub: SUBS[name], actor: actorOf(name),
  roles: [...PEOPLE[name].roles], name: 'SYNTHETIC ' + name });
const owner = c => [c.institution, c.sub];
const code = (status, value) => e => typeof e?.getStatus === 'function' && e.getStatus() === status
  && (value === undefined || e.getResponse()?.code === value);
const json = value => JSON.parse(JSON.stringify(value));
const unique = (name, target) => Object.assign(new Error('SYNTHETIC unique violation ' + name), { code: 'P2002', meta: { target } });

const MESSAGE = 'SYNTHETIC-MESSAGE-TEXT critical finding';
const REASON = 'SYNTHETIC-CANCEL-REASON wrong recipient';
const HEAD_BODY = 'SYNTHETIC-CURRENT-REPORT-BODY';   // Report row (current body): never a source
const DRAFT_BODY = 'SYNTHETIC-PRIVATE-DRAFT';         // ReportDraft: never a source
const pinnedText = v => 'SYNTHETIC-PINNED-V' + v;

/**
 * One synthetic store and its stubs. `log` holds, in order: tx:start / tx:end / tx:rollback, kc:<method> and
 * orthanc:<method>. Writes inside a transaction keep an undo entry so a refused transaction leaves nothing behind.
 */
function world({ policies = {} } = {}) {
  const log = [], sqls = [], touched = new Set(), transactions = [];
  const store = { studies: new Map(), reports: new Map(), versions: new Map(), drafts: new Map(), records: new Map(), events: [],
    receipts: new Map(), audits: [], policies: new Map(), updates: 0 };
  for (const [name, policy] of Object.entries(policies))
    store.policies.set(SUBS[name], { institution: INST, revision: 1, policy, reason: '', updatedBy: null, updatedAt: null });
  const locks = new Map();
  const w = { log, sqls, touched, transactions, store };

  const study = (uid, institutionId = INST, extra = {}) => store.studies.set(uid, { uid, institutionId, teleInstitutionId: null, rs: 'W',
    preDoc: null, preReviewer: null, ov: null, ...extra });
  w.study = study;
  /** commitReport's effect on the rows this service reads: a larger version, the head, RS and the P pair. */
  w.commit = (uid, action, { author = actorOf('S'), reviewer = null, discard = false } = {}) => {
    const versions = [...store.versions.values()].filter(v => v.uid === uid).map(v => v.version);
    let version = (versions.length ? Math.max(...versions) : 0) + 1;
    const at = new Date(Date.UTC(2026, 8, 28, 0, 0, version));
    if (action === 'reset' && discard) {
      store.versions.set(uid + ':' + version, { uid, version, action: 'discarded', author, at, findings: pinnedText(version), conclusion: '', recommendation: '' });
      version += 1;
    }
    const empty = action === 'reset';
    store.versions.set(uid + ':' + version, { uid, version, action, author, at, findings: empty ? '' : pinnedText(version),
      conclusion: empty ? '' : 'SYNTHETIC conclusion v' + version, recommendation: '' });
    store.reports.set(uid, { uid, version, findings: HEAD_BODY, conclusion: HEAD_BODY, recommendation: HEAD_BODY });
    const s = store.studies.get(uid);
    s.rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W', preliminary: s.rs === 'P' ? 'P' : 'P', defer: 'H' }[action];
    if (action === 'save' && s.preDoc) s.rs = 'P';
    if (action === 'preliminary') { s.preDoc = author; s.preReviewer = reviewer; }
    if (action === 'reset' || action === 'approve') { s.preDoc = null; s.preReviewer = null; }
    store.drafts.set(uid, { uid, findings: DRAFT_BODY });
    return version;
  };
  study(UID); study(UID2); study(TELE_UID, OTHER, { teleInstitutionId: INST });

  const count = () => ({ records: store.records.size, events: store.events.length, receipts: store.receipts.size, audits: store.audits.length,
    updates: store.updates });
  w.count = count;

  const acquire = async (key, tx) => {
    for (;;) {
      const held = locks.get(key);
      if (!held) break;
      if (held.tx === tx) return;
      await held.released;
    }
    let release;
    const released = new Promise(resolve => { release = resolve; });
    locks.set(key, { tx, released, release });
    tx.held.push(key);
  };
  const releaseAll = tx => { for (const key of tx.held) { const held = locks.get(key); locks.delete(key); held.release(); } tx.held = []; };

  const kind = sql => sql.includes('pg_advisory') ? 'advisory'
    : sql.includes('"StudyAccessPolicy"') ? 'policy'
      : sql.includes('FROM "StudyState"') ? 'study'
        : sql.includes('FROM "Report" r') ? 'head'
          : sql.includes('FROM "ReportVersion" WHERE') ? 'pinned'
            : sql.includes('"supersedesId"=') && !sql.includes('JOIN') ? 'replacement'
              : sql.includes("state='created'") && sql.includes('"senderSub"=') && !sql.includes('JOIN') ? 'pending'
                : sql.includes('FROM "CriticalResult" WHERE id=') ? 'record' : 'unknown';
  const query = async (view, tx, strings, values) => {
    const sql = strings.join('?'), k = kind(sql);
    sqls.push(k);
    if (sql.includes('FOR UPDATE')) await acquire(k + ':' + values[0], tx);
    if (k === 'advisory') return [{ locked: 1 }];
    if (k === 'policy') { const row = view.policies.get(values[0]); return row ? [structuredClone(row)] : []; }
    if (k === 'study') { const row = view.studies.get(values[0]); return row ? [structuredClone(row)] : []; }
    if (k === 'head') {
      const report = view.reports.get(values[0]);
      if (!report) return [];
      const v = view.versions.get(values[0] + ':' + report.version);
      return [{ headVersion: report.version, headAction: v?.action ?? null, headAuthor: v?.author ?? null, headAt: v?.at ?? null }];
    }
    if (k === 'pinned') {
      const v = view.versions.get(values[0] + ':' + values[1]);
      return v ? [{ findings: v.findings, conclusion: v.conclusion, recommendation: v.recommendation }] : [];
    }
    if (k === 'record') { const row = view.records.get(values[0]); return row ? [structuredClone(row)] : []; }
    if (k === 'replacement') {
      const row = [...view.records.values()].find(r => r.supersedesId === values[0]);
      return row ? [{ id: row.id, sourceVersion: row.sourceVersion }] : [];
    }
    if (k === 'pending') return [...view.records.values()].filter(r => r.studyUid === values[0] && r.senderSub === values[1]
      && r.recipientSub === values[2] && r.state === 'created').map(r => ({ id: r.id }));
    throw new Error('unexpected SQL in the stub: ' + sql);
  };
  const mutate = (tx, apply) => { const undo = apply(); if (tx) tx.undo.push(undo); };
  const writers = tx => ({
    criticalResult: {
      create: async ({ data }) => mutate(tx, () => {
        if (store.records.has(data.id)) throw unique('record', ['id']);
        if (data.state === 'created' && [...store.records.values()].some(r => r.state === 'created' && r.studyUid === data.studyUid
          && r.senderSub === data.senderSub && r.recipientSub === data.recipientSub)) throw unique('pending', 'CriticalResult_pending_key');
        store.records.set(data.id, structuredClone(data));
        return () => store.records.delete(data.id);
      }),
      update: async ({ where, data }) => mutate(tx, () => {
        const before = store.records.get(where.id);
        store.records.set(where.id, { ...before, ...structuredClone(data) });
        store.updates++;
        return () => { store.records.set(where.id, before); store.updates--; };
      }),
    },
    criticalResultEvent: { create: async ({ data }) => mutate(tx, () => {
      if (store.events.some(e => e.recordId === data.recordId && (e.seq === data.seq || e.event === data.event))) throw unique('event', ['recordId', 'seq']);
      store.events.push(structuredClone(data));
      return () => store.events.splice(store.events.findIndex(e => e.id === data.id), 1);
    }) },
    criticalResultReceipt: { create: async ({ data }) => mutate(tx, () => {
      if (store.receipts.has(data.requestId)) throw unique('receipt', ['requestId']);
      store.receipts.set(data.requestId, structuredClone(data));
      return () => store.receipts.delete(data.requestId);
    }) },
    auditLog: { create: async ({ data }) => mutate(tx, () => { store.audits.push(structuredClone(data)); return () => store.audits.pop(); }) },
  });
  const watched = (label, target) => new Proxy(target, { get(object, name) {
    if (typeof name === 'string') touched.add(label + '.' + name);
    return object[name];
  } });
  const client = (view, tx) => {
    const write = writers(tx);
    return watched('tx', {
      $executeRaw: async () => 0,
      $queryRaw: (strings, ...values) => query(view, tx, strings, values),
      criticalResult: write.criticalResult,
      criticalResultEvent: write.criticalResultEvent,
      criticalResultReceipt: { ...write.criticalResultReceipt, findUnique: async ({ where }) => {
        const row = view.receipts.get(where.requestId); return row ? structuredClone(row) : null; } },
      auditLog: write.auditLog,
    });
  };
  const prisma = watched('root', {
    $queryRaw: (strings, ...values) => query(store, null, strings, values),
    $transaction: async (fn, options) => {
      transactions.push(options);
      const tx = { held: [], undo: [] };
      const view = options?.isolationLevel === 'RepeatableRead'
        ? structuredClone({ studies: store.studies, reports: store.reports, versions: store.versions, records: store.records,
          receipts: store.receipts, policies: store.policies })
        : store;
      log.push('tx:start');
      try {
        const result = await fn(client(view, tx));
        log.push('tx:end');
        return result;
      } catch (e) {
        for (const undo of tx.undo.reverse()) undo();
        log.push('tx:rollback');
        throw e;
      } finally { releaseAll(tx); }
    },
    criticalResultReceipt: { findUnique: async ({ where }) => { const row = store.receipts.get(where.requestId); return row ? structuredClone(row) : null; } },
    criticalResult: { findUnique: async ({ where }) => { const row = store.records.get(where.id); return row ? structuredClone(row) : null; } },
    studyState: {
      findUnique: async ({ where }) => { const row = store.studies.get(where.uid); return row ? { institutionId: row.institutionId } : null; },
      findMany: async () => [...store.studies.values()].map(s => ({ uid: s.uid })),
    },
  });
  w.users = new Map(Object.keys(PEOPLE).map(name => [SUBS[name], { id: SUBS[name], username: 'syn-' + name.toLowerCase(),
    email: actorOf(name), emailVerified: true, firstName: 'SYNTHETIC', lastName: name, enabled: true, serviceAccountClientId: null,
    groups: [PEOPLE[name].group ?? INST], roles: [...PEOPLE[name].roles] }]));
  w.kcFail = false;
  const keycloak = {
    getUser: async sub => { log.push('kc:getUser'); if (w.kcFail) throw new Error('SYNTHETIC Keycloak down'); const u = w.users.get(sub); return u ? structuredClone(u) : null; },
    institutionMembers: async institution => { log.push('kc:institutionMembers'); if (w.kcFail) throw new Error('SYNTHETIC Keycloak down');
      return [...w.users.values()].filter(u => u.enabled && u.groups.length === 1 && u.groups[0] === institution).map(u => structuredClone(u)); },
  };
  w.orthancFail = false;
  const source = uid => ({ '0020000D': { Value: [uid] }, '00100010': { Value: [{ Alphabetic: 'SYNTHETIC^ORIGINAL' }] },
    '00100020': { Value: ['SYN-PID-1'] }, '00100030': { Value: ['19700101'] }, '00080020': { Value: ['20260928'] },
    '00080061': { Value: ['CT'] } });
  const orthanc = new Proxy({}, { get: (_t, name) => async (...args) => {
    log.push('orthanc:' + String(name));
    if (w.orthancFail) throw new Error('SYNTHETIC Orthanc down');
    if (name === 'reportPreviewStudy' || name === 'studyAccessMetadata') return source(args[0]);
    if (name === 'studyIdentities') return [...store.studies.keys()].map(source);
    return null;
  } });
  w.access = new StudyAccessService(prisma, orthanc, {});
  w.svc = new CriticalResultService(prisma, w.access, keycloak, orthanc);
  return w;
}

const createBody = (c, requestId, recipient, sourceVersion, message = MESSAGE) =>
  ({ requestId, expectedOwner: owner(c), recipientSub: SUBS[recipient], sourceVersion, message });
const ackBody = (c, requestId, revision = 1) => ({ requestId, expectedOwner: owner(c), revision });
const cancelBody = (c, requestId, revision = 1, reason = REASON) => ({ requestId, expectedOwner: owner(c), revision, reason });
const supersedeBody = (c, requestId, revision, sourceVersion, message = MESSAGE + ' corrected') =>
  ({ requestId, expectedOwner: owner(c), revision, sourceVersion, message });
const S = () => person('S');
const between = (log, from, to) => log.slice(from, to);
const networkInside = log => { let inside = false, hits = []; for (const e of log) {
  if (e === 'tx:start') inside = true; else if (e === 'tx:end' || e === 'tx:rollback') inside = false;
  else if (inside && (e.startsWith('kc:') || e.startsWith('orthanc:'))) hits.push(e);
} return hits; };

// ── pure: the contract's tables ──

test('SV01 recipient class: radiologist makes R, otherwise clinician makes C (mixed non-readers included), else none', () => {
  const vectors = [[['radiologist'], 'radiologist'], [['clinician', 'radiologist'], 'radiologist'], [['admin', 'radiologist'], 'radiologist'],
    [['clinician'], 'clinician'], [['clinician', 'technician'], 'clinician'], [['clinician', 'admin'], 'clinician'],
    [['clinician', 'default-roles-kin', 'offline_access'], 'clinician'], [['technician'], null], [['admin'], null], [[], null], [undefined, null]];
  for (const [roles, expected] of vectors) assert.equal(P.recipientClass(roles), expected, JSON.stringify(roles));
});

test('SV01 M-S7-CVR C1..C5 and the R rows R1..R5 as the contract states them (create and record cases)', () => {
  const h = (version, action) => ({ version, action });
  const st = (rs, preDoc = null, preReviewer = null) => ({ rs, preDoc, preReviewer });
  // create: the pin is the head by construction (the source check came first)
  const creates = [
    ['C approve A', 'clinician', true, h(1, 'approve'), st('A'), 'C2'], ['C addendum A', 'clinician', true, h(2, 'addendum'), st('A'), 'C2'],
    ['C save T', 'clinician', true, h(1, 'save'), st('T'), 'C1'], ['C preliminary P', 'clinician', true, h(1, 'preliminary'), st('P', 'a', 'b'), 'C1'],
    ['C defer H', 'clinician', true, h(1, 'defer'), st('H'), 'C1'], ['C reset W', 'clinician', true, h(2, 'reset'), st('W'), 'C1'],
    ['C approve but RS not A', 'clinician', true, h(1, 'approve'), st('T'), 'C1'], ['C approve, not visible', 'clinician', false, h(1, 'approve'), st('A'), 'C1'],
    ['R save T', 'radiologist', true, h(1, 'save'), st('T'), 'R2'], ['R defer H', 'radiologist', true, h(1, 'defer'), st('H'), 'R2'],
    ['R preliminary, reviewer', 'radiologist', true, h(1, 'preliminary'), st('P', 'a', 'me'), 'R2'],
    ['R preliminary, author', 'radiologist', true, h(1, 'preliminary'), st('P', 'me', 'b'), 'R2'],
    ['R preliminary, outside the pair', 'radiologist', true, h(1, 'preliminary'), st('P', 'a', 'b'), 'R1'],
    ['R approve, not visible (StudyAccess)', 'radiologist', false, h(1, 'approve'), st('A'), 'R1'],
  ];
  for (const [label, cls, visible, head, state, expected] of creates)
    assert.equal(P.createCase({ cls, visible, head, state, actor: 'me' }), expected, label);
  // records: [label, class, visible, pin, head, state, case, view, ack, reason]
  const records = [
    ['C2 approve', 'clinician', true, 1, h(1, 'approve'), st('A'), 'C2', 'full', true, null],
    ['C2 addendum', 'clinician', true, 2, h(2, 'addendum'), st('A'), 'C2', 'full', true, null],
    ['C3 addendum moved the head', 'clinician', true, 1, h(2, 'addendum'), st('A'), 'C3', 'stub', false, 'head_moved'],
    ['C3 reopened and saved', 'clinician', true, 1, h(3, 'save'), st('T'), 'C3', 'stub', false, 'head_moved'],
    ['C4 reset', 'clinician', true, 1, h(3, 'reset'), st('W'), 'C4', 'stub', false, 'reset'],
    ['C5 not visible', 'clinician', false, 1, h(1, 'approve'), st('A'), 'C5', null, false, null],
    ['C5 unsigned pin after an R->C class change', 'clinician', true, 1, h(1, 'save'), st('T'), 'C5', null, false, null],
    ['C5 preliminary pin after an R->C class change', 'clinician', true, 1, h(1, 'preliminary'), st('P', 'a', 'me'), 'C5', null, false, null],
    ['R2 save', 'radiologist', true, 1, h(1, 'save'), st('T'), 'R2', 'full', true, null],
    ['R2 preliminary reviewer', 'radiologist', true, 1, h(1, 'preliminary'), st('P', 'a', 'me'), 'R2', 'full', true, null],
    ['R5 preliminary outside the pair', 'radiologist', true, 1, h(1, 'preliminary'), st('P', 'a', 'b'), 'R5', null, false, null],
    ['R3 full', 'radiologist', true, 1, h(2, 'approve'), st('A'), 'R3', 'full', false, 'head_moved'],
    ['R3 stub (new head is a preliminary outside the pair)', 'radiologist', true, 1, h(2, 'preliminary'), st('P', 'a', 'b'), 'R3', 'stub', false, 'head_moved'],
    ['R4 full', 'radiologist', true, 1, h(3, 'reset'), st('W'), 'R4', 'full', false, 'reset'],
    ['R5 not visible', 'radiologist', false, 1, h(1, 'save'), st('T'), 'R5', null, false, null],
  ];
  for (const [label, cls, visible, pin, head, state, kase, view, ack, reason] of records) {
    const out = P.recipientCase({ cls, visible, pin, head, state, actor: 'me' });
    assert.deepEqual([out.case, out.view, out.ack, out.reason], [kase, view, ack, reason], label);
  }
  // ACK is allowed in C2 and R2 only; delivery follows the view.
  assert.deepEqual([P.deliveryOf({ view: 'full' }), P.deliveryOf({ view: 'stub' }), P.deliveryOf({ view: null }), P.deliveryOf(null)],
    ['readable', 'stub', 'not_eligible', 'not_eligible']);
});

test('SV02 the transition table and the absorbing terminal states', () => {
  assert.deepEqual(json(P.CRITICAL_RESULT_TRANSITIONS), {
    ack: { from: 'created', to: 'acknowledged', event: 'acknowledged' },
    cancel: { from: 'created', to: 'cancelled', event: 'cancelled' },
    supersede: { from: 'created', to: 'superseded', event: 'superseded' } });
  assert.deepEqual([...P.CRITICAL_RESULT_STATES], ['created', 'acknowledged', 'cancelled', 'superseded']);
  assert.equal(P.terminalRefusal('created'), null);
  assert.deepEqual(P.terminalRefusal('acknowledged'), { status: 409, code: 'CRITICAL_RESULT_ACKNOWLEDGED' });
  assert.deepEqual(P.terminalRefusal('cancelled'), { status: 409, code: 'CRITICAL_RESULT_CANCELLED' });
  assert.deepEqual(P.terminalRefusal('superseded', id(5)), { status: 409, code: 'CRITICAL_RESULT_SUPERSEDED', replacedBy: id(5) });
  assert.deepEqual(P.terminalRefusal('superseded', null), { status: 409, code: 'CRITICAL_RESULT_SUPERSEDED' });
});

test('SV03 the source pin: no head, a moved head, a reset head, an unreadable head and the number bounds', () => {
  const r = (sourceVersion, head, senderReadable = true) => P.sourceRefusal({ sourceVersion, head, senderReadable });
  assert.deepEqual(r(1, null), { status: 409, code: 'CRITICAL_RESULT_SOURCE_INVALID' });
  assert.deepEqual(r(1, { version: 0, action: null }), { status: 409, code: 'CRITICAL_RESULT_SOURCE_INVALID' });
  assert.deepEqual(r(1, { version: 2, action: 'approve' }), { status: 409, code: 'CRITICAL_RESULT_SOURCE_MOVED' });
  assert.deepEqual(r(2, { version: 3, action: 'reset' }), { status: 409, code: 'CRITICAL_RESULT_SOURCE_MOVED' }, 'a discarded number is never the head');
  assert.deepEqual(r(3, { version: 3, action: 'reset' }), { status: 409, code: 'CRITICAL_RESULT_SOURCE_INVALID' });
  assert.deepEqual(r(1, { version: 1, action: 'preliminary' }, false), { status: 403, code: 'CRITICAL_RESULT_SOURCE_FORBIDDEN' });
  for (const action of ['save', 'approve', 'addendum', 'preliminary', 'defer']) assert.equal(r(1, { version: 1, action }), null, action);
  for (const bad of [0, -1, 1.5, '1', null, 2147483647, Number.NaN]) assert.equal(P.positiveValue(bad), false, String(bad));
  for (const good of [1, 2147483646]) assert.equal(P.positiveValue(good), true);
});

test('SV05 the id-route refusals answer terminal state, then revision, then the source (section 4 steps 12-14)', () => {
  const current = { ack: true }, moved = { ack: false };
  assert.equal(P.ackRefusal({ state: 'cancelled', revision: 2 }, 1, moved).code, 'CRITICAL_RESULT_CANCELLED');
  assert.equal(P.ackRefusal({ state: 'acknowledged', revision: 2 }, 2, current).code, 'CRITICAL_RESULT_ACKNOWLEDGED');
  assert.equal(P.ackRefusal({ state: 'created', revision: 1 }, 2, moved).code, 'CRITICAL_RESULT_CHANGED');
  assert.equal(P.ackRefusal({ state: 'created', revision: 1 }, 1, moved).code, 'CRITICAL_RESULT_SOURCE_CHANGED');
  assert.equal(P.ackRefusal({ state: 'created', revision: 1 }, 1, current), null);
  assert.equal(P.recordRefusal({ state: 'superseded', revision: 2 }, 1, id(3)).replacedBy, id(3));
  assert.equal(P.recordRefusal({ state: 'created', revision: 1 }, 1), null);
});

test('SV08 and SV12 projections carry exactly the section 3.3 keys; the identity is the original copy overlaid by ov', () => {
  const record = { id: id(1), studyUid: UID, state: 'created', revision: 1, createdAt: new Date(0), supersedesId: null,
    senderName: 'SYNTHETIC S', recipientActor: 'r@x', recipientName: 'SYNTHETIC P', recipientRole: 'clinician', message: MESSAGE,
    sourceVersion: 1, sourceAction: 'approve', sourceAuthor: 'a', sourceAt: new Date(0), origName: 'ORIG NAME', origPatientId: 'ORIG-ID',
    origBirth: '19700101', origStudyDate: '20260928', acknowledgedAt: null, cancelledAt: null, cancelReason: null, supersededAt: null };
  const study = P.studyIdentity(record, JSON.stringify({ name: 'OV NAME', id: 'OV-ID', sex: 'X', acc: 'ACC', birth: 7 }));
  assert.deepEqual(study, { uid: UID, name: 'OV NAME', id: 'OV-ID', birth: '19700101', date: '20260928' }, 'only string name/id/birth/date overlay');
  assert.deepEqual(P.studyIdentity(record, '{broken'), { uid: UID, name: 'ORIG NAME', id: 'ORIG-ID', birth: '19700101', date: '20260928' });
  const full = P.recipientView(record, { view: 'full', current: true, reason: null }, study, { findings: 'F', conclusion: 'C', recommendation: 'R' }, null);
  assert.deepEqual(Object.keys(full).sort(), ['acknowledgedAt', 'body', 'cancelReason', 'cancelledAt', 'createdAt', 'id', 'message', 'replacedBy',
    'revision', 'sender', 'source', 'state', 'study', 'studyUid', 'supersededAt', 'view']);
  assert.deepEqual(Object.keys(full.source).sort(), ['action', 'at', 'author', 'current', 'reason', 'version']);
  assert.deepEqual(Object.keys(full.body).sort(), ['conclusion', 'findings', 'recommendation']);
  assert.deepEqual(Object.keys(full.sender), ['name']);
  const stub = P.recipientView({ ...record, state: 'superseded' }, { view: 'stub', current: false, reason: 'head_moved' }, study, null, id(2));
  assert.deepEqual(Object.keys(stub).sort(), ['acknowledgedAt', 'cancelledAt', 'createdAt', 'id', 'replacedBy', 'revision', 'sender', 'source',
    'state', 'study', 'studyUid', 'supersededAt', 'view']);
  assert.deepEqual(stub.source, { current: false, reason: 'head_moved' });
  assert.equal(JSON.stringify(stub).includes(MESSAGE), false);
  const sender = P.senderView(record, { version: 2, action: 'reset' }, study, 'stub', null);
  assert.deepEqual(Object.keys(sender).sort(), ['acknowledgedAt', 'cancelReason', 'cancelledAt', 'createdAt', 'delivery', 'id', 'message',
    'recipient', 'replacedBy', 'revision', 'source', 'state', 'study', 'studyUid', 'supersededAt', 'supersedes', 'view']);
  assert.deepEqual(Object.keys(sender.recipient).sort(), ['actor', 'name', 'role']);
  assert.deepEqual([sender.source.current, sender.source.reason, sender.delivery], [false, 'reset', 'stub']);
  assert.equal(P.senderView({ ...record, state: 'acknowledged' }, { version: 1, action: 'approve' }, study, 'readable', null).delivery, null,
    'delivery is only for a pending record');
});

test('audit and allowlist wiring: owner-only GET audit, hidden from the Members console, three clinician rows', () => {
  assert.equal(CRITICAL_RESULT_AUDIT_ACTION, 'study.critical-result');
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes('study.critical-result'));
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes('study.question') && OWNER_ONLY_AUDIT_ACTIONS.includes('study.image-request'));
  assert.ok(AUDIT_HIDDEN_STUDY_SCOPED.includes('study.critical-result'));
  assert.equal(auditRule('study.critical-result'), 'hidden:study_scoped_owner_only');
  const mine = CLINICIAN_BUSINESS_ROUTES.filter(route => route.includes('critical-result'));
  assert.deepEqual(mine, ['GET critical-results', 'GET critical-results/:id', 'POST critical-results/:id/ack']);
});

// ── the compiled service over the stub store ──

async function approved(w, uid = UID) { w.commit(uid, 'approve'); return w.store.reports.get(uid).version; }

test('C2: create, read (the pinned body), explicit ACK; reads never acknowledge (CR03, CR20 in the stub)', async () => {
  const w = world();
  const v1 = await approved(w);
  const created = await w.svc.create(UID, S(), createBody(S(), id(11), 'P', v1));
  assert.deepEqual(Object.keys(created).sort(), ['applied', 'owner', 'replayed']);
  assert.deepEqual(created.applied, { id: id(11), studyUid: UID, requestId: id(11), action: 'create', from: null, to: 'created', revision: 1,
    replacement: null, at: created.applied.at });
  const row = w.store.records.get(id(11));
  assert.deepEqual([row.senderSub, row.senderActor, row.senderName, row.recipientSub, row.recipientActor, row.recipientName, row.recipientRole],
    [SUBS.S, actorOf('S'), 'SYNTHETIC S', SUBS.P, actorOf('P'), 'P SYNTHETIC', 'clinician'], 'attribution from the token and Keycloak');
  assert.deepEqual([row.institutionId, row.senderInstitutionId, row.sourceVersion, row.sourceAction], [INST, INST, v1, 'approve']);
  assert.deepEqual([row.origName, row.origPatientId, row.origBirth, row.origStudyDate], ['SYNTHETIC ORIGINAL', 'SYN-PID-1', '19700101', '20260928']);
  const before = w.count();
  for (let n = 0; n < 3; n++) {
    const { item } = await w.svc.read(id(11), person('P'));
    assert.equal(item.view, 'full');
    assert.equal(item.state, 'created');
    assert.deepEqual(item.body, { findings: pinnedText(v1), conclusion: 'SYNTHETIC conclusion v' + v1, recommendation: '' });
    assert.equal(item.message, MESSAGE);
  }
  assert.deepEqual(w.count(), before, 'reads write nothing and never acknowledge');
  const acked = await w.svc.ack(id(11), person('P'), ackBody(person('P'), id(12)));
  assert.deepEqual([acked.replayed, acked.applied.action, acked.applied.from, acked.applied.to, acked.applied.revision],
    [false, 'ack', 'created', 'acknowledged', 2]);
  assert.equal(w.store.records.get(id(11)).state, 'acknowledged');
  const text = JSON.stringify([created, acked, (await w.svc.read(id(11), S())).item]);
  assert.equal(text.includes(HEAD_BODY), false);
  assert.equal(text.includes(DRAFT_BODY), false);
});

test('SV04 / S-CR: every applied requestId replays its stored result before any state check; reuse is 409', async () => {
  const w = world();
  const v1 = await approved(w);
  const r0 = await w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1));
  const a1 = await w.svc.ack(id(21), person('P'), ackBody(person('P'), id(22)));
  const settled = w.count();
  assert.deepEqual(settled, { records: 1, events: 2, receipts: 2, audits: 2, updates: 1 });
  // S-CR1, S-CR2
  const again = await w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1));
  assert.deepEqual([again.replayed, again.applied], [true, r0.applied]);
  const ackAgain = await w.svc.ack(id(21), person('P'), ackBody(person('P'), id(22)));
  assert.deepEqual([ackAgain.replayed, ackAgain.applied], [true, a1.applied]);
  const refusals = [
    ['S-CR3', () => w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1, MESSAGE + ' other')), 409, 'REQUEST_ID_REUSED'],
    ['S-CR4', () => w.svc.cancel(id(21), S(), cancelBody(S(), id(21), 1)), 409, 'REQUEST_ID_REUSED'],
    ['S-CR5', () => w.svc.cancel(id(21), S(), cancelBody(S(), id(23), 2)), 409, 'CRITICAL_RESULT_ACKNOWLEDGED'],
    ['S-CR6', () => w.svc.ack(id(21), person('P'), ackBody(person('P'), id(24), 2)), 409, 'CRITICAL_RESULT_ACKNOWLEDGED'],
    ['S-CR7', () => w.svc.ack(id(21), person('P2'), ackBody(person('P2'), id(22))), 404, 'CRITICAL_RESULT_NOT_FOUND'],
    ['S-CR8', () => w.svc.ack(id(21), person('AD'), ackBody(person('AD'), id(25))), 403, 'CRITICAL_RESULT_ROLE_REQUIRED'],
    ['another user replays the id', () => w.svc.create(UID, person('X'), createBody(person('X'), id(21), 'P', v1)), 409, 'REQUEST_ID_REUSED'],
    ['the ack id on another record', () => w.svc.ack(id(26), person('P'), ackBody(person('P'), id(22))), 404, 'CRITICAL_RESULT_NOT_FOUND'],
  ];
  for (const [label, call, status, value] of refusals) await assert.rejects(call, code(status, value), label);
  assert.deepEqual(w.count(), settled);
  // S-CR9: P loses clinician (new token); the replay is 403 at the route role
  await assert.rejects(w.svc.ack(id(21), { ...person('P'), roles: [] }, ackBody(person('P'), id(22))), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
  // S-CR11: after S-CR9 the sender's replay still answers the stored result (no recipient content in it)
  w.users.get(SUBS.P).roles = [];
  const late = await w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1));
  assert.deepEqual([late.replayed, late.applied], [true, r0.applied]);
  // S-CR10: the study's owner moves; the replay is hidden like any read
  w.store.studies.get(UID).institutionId = OTHER;
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1)), code(404, 'STUDY_NOT_FOUND'));
  assert.deepEqual(w.count(), settled);
});

test('SV06 Keycloak, Orthanc and source-tag reads end before the transaction; a failed read is 503 with no write', async () => {
  const metadata = { version: 1, restricted: true, startsAt: null, endsAt: null,
    rules: [{ patientId: 'SYN-PID-1', modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] };
  const w = world({ policies: { S: metadata } });
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(31), 'P', v1));
  await w.svc.supersede(id(31), S(), supersedeBody(S(), id(32), 1, v1));
  await w.svc.ack(id(32), person('P'), ackBody(person('P'), id(33)));
  await w.svc.create(UID, S(), createBody(S(), id(34), 'X', v1));
  await w.svc.cancel(id(34), S(), cancelBody(S(), id(35)));
  await w.svc.read(id(34), S());
  await w.svc.recipients(UID, S());
  assert.deepEqual(networkInside(w.log), [], 'no Keycloak or Orthanc call inside any transaction callback');
  assert.ok(w.log.includes('orthanc:studyAccessMetadata') && w.log.includes('orthanc:studyIdentities') && w.log.includes('orthanc:reportPreviewStudy'));
  // failures before the transaction: 503 UNAVAILABLE, no transaction, no write
  for (const [label, fail] of [['Keycloak', 'kcFail'], ['Orthanc', 'orthancFail']]) {
    const f = world();
    const v = await approved(f);
    f[fail] = true;
    await assert.rejects(f.svc.create(UID, S(), createBody(S(), id(36), 'P', v)), code(503, label === 'Keycloak' ? 'CRITICAL_RESULT_UNAVAILABLE' : undefined), label);
    assert.equal(f.log.includes('tx:start'), false, label);
    assert.deepEqual(f.count(), { records: 0, events: 0, receipts: 0, audits: 0, updates: 0 }, label);
  }
  const f = world();
  const v = await approved(f);
  f.orthancFail = true;
  await assert.rejects(f.svc.create(UID, S(), createBody(S(), id(37), 'P', v)), code(503, 'CRITICAL_RESULT_UNAVAILABLE'),
    'no metadata rule: the original identity read is the only Orthanc call and its failure is UNAVAILABLE');
});

test('SV09 the write-time Keycloak re-check: token AND Keycloak roles; replays found before the transaction skip it', async () => {
  const w = world();
  const v1 = await approved(w);
  const cases = [
    ['radiologist removed in Keycloak', u => { u.roles = ['technician']; }],
    ['disabled', u => { u.enabled = false; }],
    ['moved to another institution', u => { u.groups = [OTHER]; }],
    ['two groups', u => { u.groups = [INST, OTHER]; }],
    ['deleted', null],
  ];
  for (const [label, change] of cases) {
    const saved = structuredClone(w.users.get(SUBS.S));
    if (change) change(w.users.get(SUBS.S)); else w.users.delete(SUBS.S);
    await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(41), 'P', v1)), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'), label);
    w.users.set(SUBS.S, saved);
  }
  assert.deepEqual(w.count().records, 0);
  // the token keeps radiologist but only admin remains in Keycloak: the ack of a clinician whose Keycloak roles lost clinician
  const created = await w.svc.create(UID, S(), createBody(S(), id(42), 'P', v1));
  w.users.get(SUBS.P).roles = ['technician'];
  await assert.rejects(w.svc.ack(id(42), person('P'), ackBody(person('P'), id(43))), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
  // reads use the token only (I-10): the stale token still reads while Keycloak says otherwise
  assert.equal((await w.svc.read(id(42), person('P'))).item.view, 'full');
  w.users.get(SUBS.P).roles = ['clinician'];
  // a replay found by the unlocked receipt lookup reads no Keycloak, even when Keycloak is down
  w.kcFail = true;
  const mark = w.log.length;
  const replay = await w.svc.create(UID, S(), createBody(S(), id(42), 'P', v1));
  assert.deepEqual([replay.replayed, replay.applied], [true, created.applied]);
  assert.deepEqual(w.log.slice(mark).filter(e => e.startsWith('kc:') || e.startsWith('orthanc:')), []);
  await assert.rejects(w.svc.ack(id(42), person('P'), ackBody(person('P'), id(44))), code(503, 'CRITICAL_RESULT_UNAVAILABLE'));
});

test('SV10 / S-RACE a concurrent ACK and cancel of one record: one applies, the other gets the winner terminal code', async () => {
  for (let round = 0; round < 10; round++) {
    const w = world();
    const v1 = await approved(w);
    await w.svc.create(UID, S(), createBody(S(), id(51), 'P', v1));
    const calls = [w.svc.ack(id(51), person('P'), ackBody(person('P'), id(52))), w.svc.cancel(id(51), S(), cancelBody(S(), id(53)))];
    if (round % 2) calls.reverse();
    const results = await Promise.allSettled(calls);
    const won = results.filter(r => r.status === 'fulfilled');
    const lost = results.filter(r => r.status === 'rejected');
    assert.equal(won.length, 1, 'round ' + round);
    const winner = won[0].value.applied.to;
    assert.ok(code(409, winner === 'acknowledged' ? 'CRITICAL_RESULT_ACKNOWLEDGED' : 'CRITICAL_RESULT_CANCELLED')(lost[0].reason), 'round ' + round);
    assert.deepEqual(w.count(), { records: 1, events: 2, receipts: 2, audits: 2, updates: 1 });
    assert.equal(w.store.records.get(id(51)).state, winner);
  }
});

test('SV07 audit rows: one per event (supersede two), exactly the section 11 keys, no message, reason or patient text', async () => {
  const w = world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(61), 'P', v1));
  await w.svc.supersede(id(61), S(), supersedeBody(S(), id(62), 1, v1));
  await w.svc.ack(id(62), person('P'), ackBody(person('P'), id(63)));
  await w.svc.create(UID, S(), createBody(S(), id(64), 'X', v1));
  await w.svc.cancel(id(64), S(), cancelBody(S(), id(65)));
  assert.equal(w.store.audits.length, 6, 'create 1 + supersede 2 + ack 1 + create 1 + cancel 1');
  const KEYS = ['event', 'from', 'id', 'institution', 'recipient', 'replacedBy', 'requestId', 'revision', 'role', 'senderInstitution', 'source',
    'supersedes', 'to'];
  const details = w.store.audits.map(row => {
    assert.deepEqual([row.action, row.target], [CRITICAL_RESULT_AUDIT_ACTION, UID]);
    for (const text of [MESSAGE, REASON, 'SYNTHETIC ORIGINAL', 'SYN-PID-1', '19700101', SUBS.P, SUBS.X]) assert.equal(row.detail.includes(text), false, text);
    const detail = JSON.parse(row.detail);
    assert.deepEqual(Object.keys(detail).sort(), KEYS);
    return [row.actor, detail.id, detail.event, detail.from, detail.to, detail.revision, detail.requestId, detail.role, detail.supersedes,
      detail.replacedBy, detail.institution, detail.senderInstitution];
  });
  assert.deepEqual(details, [
    [actorOf('S'), id(61), 'created', null, 'created', 1, id(61), 'radiologist', null, null, INST, INST],
    [actorOf('S'), id(61), 'superseded', 'created', 'superseded', 2, id(62), 'radiologist', null, id(62), INST, INST],
    [actorOf('S'), id(62), 'created', null, 'created', 1, id(62), 'radiologist', id(61), null, INST, INST],
    [actorOf('P'), id(62), 'acknowledged', 'created', 'acknowledged', 2, id(63), 'clinician', null, null, INST, INST],
    [actorOf('S'), id(64), 'created', null, 'created', 1, id(64), 'radiologist', null, null, INST, INST],
    [actorOf('S'), id(64), 'cancelled', 'created', 'cancelled', 2, id(65), 'radiologist', null, null, INST, INST],
  ]);
  // append-only: the events and receipts were only ever created, and each record has seq 1 created + at most one seq 2
  for (const recordId of [id(61), id(62), id(64)]) {
    const seqs = w.store.events.filter(e => e.recordId === recordId).map(e => [e.seq, e.event, e.revision]);
    assert.equal(seqs[0][0], 1); assert.equal(seqs[0][1], 'created'); assert.ok(seqs.length <= 2);
  }
  assert.deepEqual([...w.store.receipts.values()].map(r => [r.requestId, r.recordId, r.action, r.appliedRevision]), [
    [id(61), id(61), 'create', 1], [id(62), id(61), 'supersede', 2], [id(63), id(62), 'ack', 2], [id(64), id(64), 'create', 1],
    [id(65), id(64), 'cancel', 2]]);
  for (const receipt of w.store.receipts.values()) {
    assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
    for (const text of [MESSAGE, REASON, 'SYNTHETIC ORIGINAL']) assert.equal(JSON.stringify(receipt.result).includes(text), false);
  }
});

test('SV11 no draft, current report body or preview read; other clinical-message services are not dependencies', async () => {
  const w = world();
  const v1 = await approved(w);
  const responses = [];
  responses.push(await w.svc.recipients(UID, S()));
  responses.push(await w.svc.create(UID, S(), createBody(S(), id(71), 'P', v1)));
  responses.push(await w.svc.read(id(71), person('P')));
  responses.push(await w.svc.read(id(71), S()));
  w.commit(UID, 'addendum');
  responses.push(await w.svc.read(id(71), person('P')));
  responses.push(await w.svc.supersede(id(71), S(), supersedeBody(S(), id(72), 1, v1 + 1)));
  responses.push(await w.svc.read(id(72), person('P')));
  responses.push(await w.svc.ack(id(72), person('P'), ackBody(person('P'), id(73))));
  const text = JSON.stringify(responses);
  for (const marker of [HEAD_BODY, DRAFT_BODY]) assert.equal(text.includes(marker), false, marker);
  assert.equal(responses[2].item.body.findings, pinnedText(v1));
  assert.equal(responses[6].item.body.findings, pinnedText(v1 + 1), 'the replacement shows its own pinned row');
  assert.deepEqual(w.sqls.filter(k => k === 'unknown'), []);
  const allowed = ['root.$transaction', 'root.$queryRaw', 'root.criticalResultReceipt', 'root.criticalResult', 'root.studyState',
    'tx.$executeRaw', 'tx.$queryRaw', 'tx.criticalResult', 'tx.criticalResultEvent', 'tx.criticalResultReceipt', 'tx.auditLog'];
  assert.deepEqual([...w.touched].filter(name => !allowed.includes(name)), [], 'no reportDraft, report or other delegate');
  const types = Reflect.getMetadata('design:paramtypes', CriticalResultService).map(type => type.name);
  assert.deepEqual(types, ['PrismaService', 'StudyAccessService', 'KeycloakService', 'OrthancService']);
});

test('SV13 a StudyAccess refusal after the commit leaves the applied write; the same requestId replays it', async () => {
  for (const failure of ['409', '503']) {
    const w = world();
    const v1 = await approved(w);
    const controller = new CriticalResultController(w.svc);
    let mode = failure;
    const access = { snapshot: async () => ({ revision: 1 }), unchanged: async () => {
      if (mode === '409') throw new ConflictException({ code: 'STUDY_ACCESS_CHANGED', message: 'SYNTHETIC policy changed' });
      if (mode === '503') throw new ServiceUnavailableException('SYNTHETIC policy read failed');
    } };
    const interceptor = new StudyAccessInterceptor(access);
    const request = c => ({ kind: 'member', institution: c.institution, sub: c.sub, actor: c.actor, roles: c.roles, displayName: c.name });
    const call = async (handler, c, ...args) => {
      const req = request(c);
      const context = { switchToHttp: () => ({ getRequest: () => req }), getClass: () => CriticalResultController,
        getHandler: () => CriticalResultController.prototype[handler] };
      const next = { handle: () => from(controller[handler](...args.map(a => a === '$req' ? req : a))) };
      return lastValueFrom(await interceptor.intercept(context, next));
    };
    const expected = failure === '409' ? code(409, 'STUDY_ACCESS_CHANGED') : code(503);
    const writes = [
      ['create', S(), [UID, '$req', createBody(S(), id(81), 'P', v1)], { records: 1, events: 1, receipts: 1, audits: 1 }],
      ['ack', person('P'), [id(81), '$req', ackBody(person('P'), id(82))], { records: 1, events: 2, receipts: 2, audits: 2 }],
      ['create', S(), [UID, '$req', createBody(S(), id(83), 'X', v1)], { records: 2, events: 3, receipts: 3, audits: 3 }],
      ['supersede', S(), [id(83), '$req', supersedeBody(S(), id(84), 1, v1)], { records: 3, events: 5, receipts: 4, audits: 5 }],
      ['cancel', S(), [id(84), '$req', cancelBody(S(), id(85))], { records: 3, events: 6, receipts: 5, audits: 6 }],
    ];
    for (const [handler, c, args, after] of writes) {
      mode = failure;
      await assert.rejects(call(handler, c, ...args), expected, handler + ' ' + failure);
      const { updates, ...counts } = w.count();
      assert.deepEqual(counts, after, handler + ': the write committed before the refusal');
      mode = 'pass';
      const replay = await call(handler, c, ...args);
      assert.equal(replay.replayed, true, handler);
      assert.equal(replay.applied.requestId, args[2].requestId);
      const { updates: _u, ...same } = w.count();
      assert.deepEqual(same, after, handler + ': the replay writes nothing');
    }
  }
});

test('SV14 a delayed original create applies after its replay was refused; a delayed id-route write cannot outlive a terminal state', async () => {
  const w = world();
  const v1 = await approved(w);
  const original = w.access.prepare.bind(w.access);
  const held = new Map();
  w.access.prepare = async (c, uids, policy) => {
    const hold = held.get(c);
    if (hold) { hold.entered(); await hold.gate; }
    return original(c, uids, policy);
  };
  const holdFor = c => { let entered, release; const e = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
    held.set(c, { entered, gate }); return { entered: e, release }; };
  const r0Caller = S();
  const r0Hold = holdFor(r0Caller);
  const r0 = w.svc.create(UID, r0Caller, createBody(S(), id(91), 'P', v1));
  await r0Hold.entered;
  const q = await w.svc.create(UID, S(), createBody(S(), id(92), 'P', v1));
  assert.equal(q.replayed, false);
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(91), 'P', v1)),
    e => code(409, 'CRITICAL_RESULT_PENDING_EXISTS')(e) && e.getResponse().id === id(92));
  assert.equal(w.store.receipts.has(id(91)), false, 'the refused replay is not evidence that R0 never applies');
  await w.svc.ack(id(92), person('P'), ackBody(person('P'), id(93)));
  const settled = w.count();
  r0Hold.release();
  const applied = await r0;
  assert.equal(applied.replayed, false);
  assert.deepEqual(w.count(), { ...settled, records: settled.records + 1, events: settled.events + 1, receipts: settled.receipts + 1,
    audits: settled.audits + 1 });
  const replay = await w.svc.create(UID, S(), createBody(S(), id(91), 'P', v1));
  assert.deepEqual([replay.replayed, replay.applied], [true, applied.applied]);
  // the id route: an ack held before its transaction, the sender cancels, the ack's replay and the ack itself are 409
  const a0Caller = person('P');
  const a0Hold = holdFor(a0Caller);
  const a0 = w.svc.ack(id(91), a0Caller, ackBody(person('P'), id(94)));
  await a0Hold.entered;
  await w.svc.cancel(id(91), S(), cancelBody(S(), id(95)));
  const terminal = w.count();
  await assert.rejects(w.svc.ack(id(91), person('P'), ackBody(person('P'), id(94))), code(409, 'CRITICAL_RESULT_CANCELLED'));
  a0Hold.release();
  await assert.rejects(a0, code(409, 'CRITICAL_RESULT_CANCELLED'));
  assert.deepEqual(w.count(), terminal);
});

test('S-SU / C3: head moved after create is a stub with no message or body, ACK refused, supersede onto the new head', async () => {
  const w = world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(101), 'P', v1));
  const v2 = w.commit(UID, 'addendum');
  const stub = (await w.svc.read(id(101), person('P'))).item;
  assert.deepEqual([stub.view, stub.source.current, stub.source.reason, stub.state], ['stub', false, 'head_moved', 'created']);
  for (const text of [MESSAGE, pinnedText(v1), pinnedText(v2), HEAD_BODY]) assert.equal(JSON.stringify(stub).includes(text), false, text);
  await assert.rejects(w.svc.ack(id(101), person('P'), ackBody(person('P'), id(102))), code(409, 'CRITICAL_RESULT_SOURCE_CHANGED'));
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(103), 'P', v2)),
    e => code(409, 'CRITICAL_RESULT_PENDING_EXISTS')(e) && e.getResponse().id === id(101));
  await assert.rejects(w.svc.supersede(id(101), S(), supersedeBody(S(), id(104), 1, v1)), code(409, 'CRITICAL_RESULT_SOURCE_MOVED'));
  const before = w.count();
  const sup = await w.svc.supersede(id(101), S(), supersedeBody(S(), id(104), 1, v2));
  assert.deepEqual(sup.applied.replacement, { id: id(104), revision: 1, sourceVersion: v2 });
  assert.deepEqual([sup.applied.id, sup.applied.from, sup.applied.to, sup.applied.revision], [id(101), 'created', 'superseded', 2]);
  assert.deepEqual(w.count(), { ...before, records: before.records + 1, events: before.events + 2, receipts: before.receipts + 1,
    audits: before.audits + 2, updates: before.updates + 1 });
  const old = (await w.svc.read(id(101), person('P'))).item;
  assert.deepEqual([old.view, old.state, old.replacedBy], ['stub', 'superseded', id(104)]);
  const fresh = (await w.svc.read(id(104), person('P'))).item;
  assert.deepEqual([fresh.view, fresh.source.version, fresh.body.findings], ['full', v2, pinnedText(v2)]);
  await w.svc.ack(id(104), person('P'), ackBody(person('P'), id(105)));
  const replay = await w.svc.supersede(id(101), S(), supersedeBody(S(), id(104), 1, v2));
  assert.deepEqual([replay.replayed, replay.applied], [true, sup.applied]);
  await assert.rejects(w.svc.supersede(id(101), S(), supersedeBody(S(), id(106), 2, v2)),
    e => code(409, 'CRITICAL_RESULT_SUPERSEDED')(e) && e.getResponse().replacedBy === id(104));
  await assert.rejects(w.svc.ack(id(101), person('P'), ackBody(person('P'), id(107))), code(409, 'CRITICAL_RESULT_SUPERSEDED'));
});

test('S-RS / C4: reset after create is a stub with reason reset; supersede onto the reset head refused; cancel', async () => {
  const w = world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(111), 'P', v1));
  w.commit(UID, 'reset', { discard: true });
  const head = w.store.reports.get(UID).version;
  assert.equal(head, v1 + 2, 'discarded v2 then reset v3');
  const stub = (await w.svc.read(id(111), person('P'))).item;
  assert.deepEqual([stub.view, stub.source.reason], ['stub', 'reset']);
  await assert.rejects(w.svc.ack(id(111), person('P'), ackBody(person('P'), id(112))), code(409, 'CRITICAL_RESULT_SOURCE_CHANGED'));
  await assert.rejects(w.svc.supersede(id(111), S(), supersedeBody(S(), id(113), 1, head)), code(409, 'CRITICAL_RESULT_SOURCE_INVALID'));
  await assert.rejects(w.svc.supersede(id(111), S(), supersedeBody(S(), id(113), 1, v1 + 1)), code(409, 'CRITICAL_RESULT_SOURCE_MOVED'),
    'the discarded number is never the head');
  const cancelled = await w.svc.cancel(id(111), S(), cancelBody(S(), id(114)));
  assert.deepEqual([cancelled.applied.to, cancelled.applied.revision], ['cancelled', 2]);
  assert.equal(w.store.records.get(id(111)).cancelReason, REASON);
  await assert.rejects(w.svc.ack(id(111), person('P'), ackBody(person('P'), id(115), 2)), code(409, 'CRITICAL_RESULT_CANCELLED'));
});

test('S-RR: unsigned sources reach radiologists only; after the head moves the reader sees the pinned row, not the head', async () => {
  const w = world();
  const v1 = w.commit(UID, 'save');
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(121), 'P', v1)), code(409, 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ'), 'S-RR1 (C1)');
  for (const who of ['CT', 'CA']) await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(121), who, v1)),
    code(409, 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ'), who + ': a mixed non-reader is class C');
  assert.equal(w.count().records, 0);
  await w.svc.create(UID, S(), createBody(S(), id(122), 'X', v1));
  const r2 = (await w.svc.read(id(122), person('X'))).item;
  assert.deepEqual([r2.view, r2.source.current, r2.body.findings], ['full', true, pinnedText(v1)], 'S-RR2');
  const v2 = w.commit(UID, 'approve', { author: actorOf('S') });
  const r3 = (await w.svc.read(id(122), person('X'))).item;
  assert.deepEqual([r3.view, r3.source.current, r3.source.reason, r3.body.findings], ['full', false, 'head_moved', pinnedText(v1)], 'S-RR3');
  await assert.rejects(w.svc.ack(id(122), person('X'), ackBody(person('X'), id(123))), code(409, 'CRITICAL_RESULT_SOURCE_CHANGED'), 'S-RR4');
  await w.svc.supersede(id(122), S(), supersedeBody(S(), id(124), 1, v2));
  await w.svc.ack(id(124), person('X'), ackBody(person('X'), id(125)));
  // S-RR6/7: a preliminary with reviewer Y on another study
  const p1 = w.commit(UID2, 'preliminary', { author: actorOf('S'), reviewer: actorOf('Y') });
  await assert.rejects(w.svc.create(UID2, S(), createBody(S(), id(126), 'X', p1)), code(409, 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ'), 'S-RR6 (R1)');
  await w.svc.create(UID2, S(), createBody(S(), id(127), 'Y', p1));
  await assert.rejects(w.svc.create(UID2, person('Z'), createBody(person('Z'), id(128), 'Y', p1)), code(403, 'CRITICAL_RESULT_SOURCE_FORBIDDEN'), 'S-RR7');
  // S-RR8: a mixed member M loses radiologist (new token): the unsigned pin is C5, absent
  const w2 = world();
  const s1 = w2.commit(UID, 'save');
  await w2.svc.create(UID, S(), createBody(S(), id(129), 'M', s1));
  await assert.rejects(w2.svc.read(id(129), { ...person('M'), roles: ['clinician'] }), code(404, 'CRITICAL_RESULT_NOT_FOUND'), 'S-RR8');
});

test('ordering, duplicates and boundaries: body before owner, role before body, 404 before the 409s, pending per sender', async () => {
  const w = world();
  const v1 = await approved(w);
  const bad = { ...createBody(S(), id(131), 'P', v1), institution: INST };
  await assert.rejects(w.svc.create(UID, { ...S(), roles: ['technician'] }, bad), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
  await assert.rejects(w.svc.create(UID, person('AD'), createBody(person('AD'), id(131), 'P', v1)), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'),
    'admin alone is not a sender');
  for (const key of ['institution', 'senderSub', 'role', 'recipientName', 'body', 'sourceAction'])
    await assert.rejects(w.svc.create(UID, S(), { ...createBody(S(), id(131), 'P', v1), [key]: 'x' }), code(400, 'CRITICAL_RESULT_INPUT_INVALID'), key);
  await assert.rejects(w.svc.create(UID, S(), { ...bad, expectedOwner: ['x', 'y'] }), code(400, 'CRITICAL_RESULT_INPUT_INVALID'));
  await assert.rejects(w.svc.create(UID, S(), { ...createBody(S(), id(131), 'P', v1), expectedOwner: ['x', 'y'] }), code(409, 'OWNER_CHANGED'));
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(131), 'S', v1)), code(400, 'CRITICAL_RESULT_RECIPIENT_INVALID'), 'self');
  for (const text of ['', '   ', 'x'.repeat(2001), 'bell\u0007', 'nul\u0000'])
    await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(131), 'P', v1, text)), code(400, 'CRITICAL_RESULT_INPUT_INVALID'));
  assert.equal((await w.svc.create(UID, S(), createBody(S(), id(132), 'P', v1, 'line one\n\tline two'))).replayed, false);
  // the same (study, sender, recipient) has one pending record; another sender is independent
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(133), 'P', v1)),
    e => code(409, 'CRITICAL_RESULT_PENDING_EXISTS')(e) && e.getResponse().id === id(132));
  assert.equal((await w.svc.create(UID, person('X'), createBody(person('X'), id(134), 'P', v1))).replayed, false);
  // recipient validation: another institution, a technician, an admin, disabled, service account, unknown -> 400
  w.users.get(SUBS.Y).enabled = false;
  w.users.get(SUBS.Z).serviceAccountClientId = 'svc';
  for (const who of ['K', 'KC', 'T', 'AD', 'Y', 'Z'])
    await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(135), who, v1)), code(400, 'CRITICAL_RESULT_RECIPIENT_INVALID'), who);
  await assert.rejects(w.svc.create(UID, S(), { ...createBody(S(), id(135), 'P', v1), recipientSub: id(8999) }), code(400, 'CRITICAL_RESULT_RECIPIENT_INVALID'));
  // overlapping failures: a moved source beats an invalid recipient; the pending record beats the moved source
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(136), 'T', v1 + 5)), code(409, 'CRITICAL_RESULT_SOURCE_MOVED'));
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(136), 'P', v1 + 5)), code(409, 'CRITICAL_RESULT_PENDING_EXISTS'));
  // tele-only and other-institution studies: 404 before any Keycloak or Orthanc read of the recipient or the source
  const mark = w.log.length;
  await assert.rejects(w.svc.create(TELE_UID, S(), createBody(S(), id(137), 'X', 1)), code(404, 'STUDY_NOT_FOUND'));
  await assert.rejects(w.svc.create('2.25.999999', S(), createBody(S(), id(137), 'X', 1)), code(404, 'STUDY_NOT_FOUND'), 'no such study');
  assert.deepEqual(w.log.slice(mark).filter(e => e.startsWith('orthanc:')), [], 'no original identity read for a study that is not ours');
  await assert.rejects(w.svc.recipients(TELE_UID, S()), code(404, 'STUDY_NOT_FOUND'));
  await assert.rejects(w.svc.forStudy(TELE_UID, S()), code(404, 'STUDY_NOT_FOUND'));
  // id routes: malformed ids are 404, not 400
  await assert.rejects(w.svc.read('not-a-uuid', S()), code(404, 'CRITICAL_RESULT_NOT_FOUND'));
  await assert.rejects(w.svc.ack('not-a-uuid', person('P'), ackBody(person('P'), id(138))), code(404, 'CRITICAL_RESULT_NOT_FOUND'));
  // a non-participant of the same institution never sees the record
  for (const who of ['P2', 'Y', 'M']) await assert.rejects(w.svc.read(id(132), person(who)), code(404, 'CRITICAL_RESULT_NOT_FOUND'), who);
  await assert.rejects(w.svc.read(id(132), person('T')), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
});

test('candidates follow the create rules: C1 clinicians, readers outside the P pair, the sender and other institutions are absent', async () => {
  const w = world();
  const s1 = w.commit(UID, 'save');
  let out = await w.svc.recipients(UID, S());
  assert.deepEqual(Object.keys(out).sort(), ['owner', 'reason', 'recipients', 'sendable', 'source', 'uid']);
  assert.deepEqual([out.sendable, out.reason, out.source.version, out.source.action, out.source.final], [true, null, s1, 'save', false]);
  const subs = out.recipients.map(r => r.sub).sort();
  assert.deepEqual(subs, [SUBS.AR, SUBS.M, SUBS.X, SUBS.Y, SUBS.Z].sort(), 'radiologists (and mixed) only for an unsigned head');
  for (const r of out.recipients) assert.deepEqual(Object.keys(r).sort(), ['actor', 'name', 'role', 'sub']);
  w.commit(UID, 'approve');
  out = await w.svc.recipients(UID, S());
  assert.deepEqual(out.recipients.map(r => r.sub).sort(), [SUBS.AR, SUBS.CA, SUBS.CT, SUBS.M, SUBS.P, SUBS.P2, SUBS.X, SUBS.Y, SUBS.Z].sort());
  for (const r of out.recipients) assert.equal(r.role, P.recipientClass(PEOPLE[Object.keys(SUBS).find(k => SUBS[k] === r.sub)].roles));
  // every listed candidate is accepted by create; the unlisted ones are refused
  let n = 140;
  for (const r of out.recipients) assert.equal((await w.svc.create(UID, S(), { ...createBody(S(), id(n++), 'P', w.store.reports.get(UID).version), recipientSub: r.sub })).replayed, false);
  const p1 = w.commit(UID2, 'preliminary', { author: actorOf('S'), reviewer: actorOf('Y') });
  out = await w.svc.recipients(UID2, S());
  assert.deepEqual(out.recipients.map(r => r.sub), [SUBS.Y], 'only the preliminary pair reads an RS P head');
  out = await w.svc.recipients(UID2, person('Z'));
  assert.deepEqual([out.sendable, out.reason, out.source, out.recipients], [false, 'SOURCE_FORBIDDEN', null, []]);
  w.commit(UID2, 'reset');
  out = await w.svc.recipients(UID2, S());
  assert.deepEqual([out.sendable, out.reason, out.source], [false, 'NO_PINNABLE_SOURCE', null]);
  assert.equal(p1 > 0, true);
  await assert.rejects(w.svc.recipients(UID, person('P')), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
});
