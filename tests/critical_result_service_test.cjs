'use strict';
/* TEST-S7-U1a-SERVICE / TEST-S7-U1a-MATRIX (pure half): the compiled critical result policy, and the compiled service
 * over a real disposable PostgreSQL, a recording Keycloak and a recording Orthanc (contract S7-U1p section 2.3
 * SV01-SV14, and the lock-failure row: 503 CRITICAL_RESULT_BUSY). SV11's source check is tests/critical_result_source_test.py.
 *
 * REQ-S7-U1a-RECORD / REQ-S7-U1a-SOURCE-PIN / REQ-S7-U1a-AUTHZ / REQ-S7-U1a-IDEMPOTENCY / REQ-S7-U1a-RECIPIENT-MATRIX /
 * REQ-S7-U1a-AUDIT-ATTRIBUTION / REQ-S7-U1p-RECIPIENT-CLASS / REQ-S7-U1p-IDENTITY / REQ-S7-U1p-DEDUP /
 * REQ-S7-U1p-WRITE-OUTCOME
 *   -> RISK-S7-U1p-DRAFT-OR-LATEST / RISK-S7-U1p-FALSE-ACK / RISK-S7-U1p-WIDENING / RISK-S7-CVR-WRONG-RECIPIENT /
 *      RISK-S7-CVR-STALE-SOURCE / RISK-S7-CVR-PROXY-ACK / RISK-S7-CVR-ACK-CANCEL-RACE / RISK-S7-CVR-REVOKED-ACK /
 *      RISK-S7-CVR-PHI-IN-AUDIT / RISK-S7-CVR-SOURCE-BYPASS / RISK-S7-U1p-CLASS-WIDENING / RISK-S7-U1p-STALE-IDENTITY /
 *      RISK-S7-U1p-DUPLICATE-PENDING / RISK-S7-U1p-FALSE-UNDELIVERED / RISK-S7-CVR-COUNT-LEAK
 *   -> TEST-S7-U1a-SERVICE (this file).
 *
 * The expected values below are the contract's tables (M-S7-CVR and the R rows of section 4.2, state-machine.json
 * transitions and refusals, the section 3.3/3.4/11 key sets, section 6.2 lists and counts, section 7.1 replay sequences),
 * written out here as literals; none of them is read back from the implementation.
 *
 * The service cases run the compiled service's own SQL against PostgreSQL (S7-U1a-R-001-F03: a stub that sorted the
 * service's statements by their text broke on an equivalent alias or spacing and could not see what a statement read).
 * KIN_CRITICAL_RESULT_DATABASE_URL names a disposable server's database kin_critical_result_test, which must hold no
 * table when this file starts: the file applies the image's migrations with `prisma migrate deploy` (as the production
 * start does), checks that every migration directory applied, and truncates the rows it writes between cases. It never
 * opens another database. PostgreSQL itself provides the RepeatableRead snapshots, the FOR UPDATE waits, the partial
 * unique index and the jsonb receipts the contract relies on. The real StudyAccessService decides access over the same
 * database; Keycloak and Orthanc are recording stubs, and every Keycloak call, Orthanc call and transaction boundary is
 * logged in one ordered list. Container only (kin-api image: /app/dist, /app/prisma and the Prisma CLI).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
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

const MESSAGE = 'SYNTHETIC-MESSAGE-TEXT critical finding';
const REASON = 'SYNTHETIC-CANCEL-REASON wrong recipient';
const HEAD_BODY = 'SYNTHETIC-CURRENT-REPORT-BODY';   // Report row (current body): never a source
const DRAFT_BODY = 'SYNTHETIC-PRIVATE-DRAFT';         // ReportDraft: never a source
const pinnedText = v => 'SYNTHETIC-PINNED-V' + v;

// ── the disposable database ──

const DATABASE = 'kin_critical_result_test';
// Every table a case writes, directly or through the service; CASCADE empties whatever else references them.
const OWNED_TABLES = ['CriticalResultEvent', 'CriticalResultReceipt', 'CriticalResult', 'AuditLog', 'ReportDraft', 'ReportVersion',
  'Report', 'StudyAccessRevision', 'StudyAccessPolicy', 'StudyState', 'Institution'];
let prepared = null;

/** The one PrismaService of this file, on a database this file migrated itself from empty. */
function database() {
  prepared ??= (async () => {
    const url = process.env.KIN_CRITICAL_RESULT_DATABASE_URL;
    assert.ok(url, 'the service cases need a disposable PostgreSQL: set KIN_CRITICAL_RESULT_DATABASE_URL to its ' + DATABASE + ' database');
    assert.equal(new URL(url).pathname, '/' + DATABASE, 'refusing any database but the disposable ' + DATABASE);
    process.env.DATABASE_URL = url;
    const { PrismaService } = require('/app/dist/prisma.service');
    const base = new PrismaService();
    await base.$connect();
    const [{ tables }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(tables, 0, 'refusing a database that already holds tables: this file empties the tables it writes');
    execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'],
      { cwd: '/app', env: { ...process.env, DATABASE_URL: url, HOME: os.tmpdir(), CHECKPOINT_DISABLE: '1' }, stdio: 'pipe' });
    const applied = await base.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const folders = fs.readdirSync('/app/prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.deepEqual(applied.map(row => row.migration_name).sort(), folders, 'every migration of the image applied');
    return base;
  })();
  return prepared;
}
test.after(async () => { if (prepared) await (await prepared).$disconnect(); });

/**
 * One synthetic world on the database: the owned tables emptied, three studies, two institutions, the policies given,
 * and the service wired to a recording view of the real client. `log` holds, in order: tx:start / tx:end / tx:rollback,
 * kc:<method> and orthanc:<method>; `touched` the client members the services reached (root.* outside a transaction,
 * tx.* inside one). The harness itself reads and writes through `base`, which is not recorded.
 */
async function world({ policies = {} } = {}) {
  const base = await database();
  await base.$executeRawUnsafe(`TRUNCATE ${OWNED_TABLES.map(t => '"' + t + '"').join(', ')} RESTART IDENTITY CASCADE`);
  const log = [], touched = new Set(), transactions = [];
  const w = { log, touched, transactions, base, onRecordCreate: null };
  await base.$executeRaw`INSERT INTO "Institution" (id, name) VALUES (${INST}, 'SYNTHETIC A'), (${OTHER}, 'SYNTHETIC B')`;
  for (const [name, policy] of Object.entries(policies))
    await base.$executeRaw`INSERT INTO "StudyAccessPolicy" (institution, subject, revision, policy, reason, "updatedBy", "updatedAt")
      VALUES (${INST}, ${SUBS[name]}, 1, ${JSON.stringify(policy)}::jsonb, 'SYNTHETIC policy', 'SYNTHETIC-admin', now())`;
  w.study = async (uid, institutionId = INST, tele = null) =>
    base.$executeRaw`INSERT INTO "StudyState" (uid, "institutionId", "teleInstitutionId", "updatedAt") VALUES (${uid}, ${institutionId}, ${tele}, now())`;
  await w.study(UID); await w.study(UID2); await w.study(TELE_UID, OTHER, INST);

  /** commitReport's effect on the rows this service reads: the next version row, the Report head, RS, the P pair, a draft. */
  w.commit = async (uid, action, { author = actorOf('S'), reviewer = null, discard = false } = {}) => {
    const [{ top }] = await base.$queryRaw`SELECT COALESCE(max(version), 0)::int AS top FROM "ReportVersion" WHERE uid = ${uid}`;
    let version = top + 1;
    const at = new Date(Date.UTC(2026, 8, 28, 0, 0, version));
    const row = async (n, act, findings, conclusion) => base.$executeRaw`INSERT INTO "ReportVersion"
      (uid, version, action, findings, conclusion, recommendation, author, at) VALUES (${uid}, ${n}, ${act}, ${findings}, ${conclusion}, '', ${author}, ${at})`;
    if (action === 'reset' && discard) { await row(version, 'discarded', pinnedText(version), ''); version += 1; }
    const empty = action === 'reset';
    await row(version, action, empty ? '' : pinnedText(version), empty ? '' : 'SYNTHETIC conclusion v' + version);
    await base.$executeRaw`INSERT INTO "Report" (uid, findings, conclusion, recommendation, version, "updatedAt")
      VALUES (${uid}, ${HEAD_BODY}, ${HEAD_BODY}, ${HEAD_BODY}, ${version}, now())
      ON CONFLICT (uid) DO UPDATE SET version = EXCLUDED.version, "updatedAt" = now()`;
    const [s] = await base.$queryRaw`SELECT rs, "preDoc", "preReviewer" FROM "StudyState" WHERE uid = ${uid}`;
    let rs = { save: 'T', approve: 'A', addendum: 'A', reset: 'W', preliminary: 'P', defer: 'H' }[action];
    let preDoc = s.preDoc, preReviewer = s.preReviewer;
    if (action === 'save' && preDoc) rs = 'P';
    if (action === 'preliminary') { preDoc = author; preReviewer = reviewer; }
    if (action === 'reset' || action === 'approve') { preDoc = null; preReviewer = null; }
    await base.$executeRaw`UPDATE "StudyState" SET rs = ${rs}, "preDoc" = ${preDoc}, "preReviewer" = ${preReviewer}, "updatedAt" = now() WHERE uid = ${uid}`;
    await base.$executeRaw`INSERT INTO "ReportDraft" (uid, author, findings, conclusion, recommendation, "updatedAt")
      VALUES (${uid}, 'syn-draft-author@synthetic.test', ${DRAFT_BODY}, ${DRAFT_BODY}, ${DRAFT_BODY}, now())
      ON CONFLICT (uid, author) DO UPDATE SET findings = EXCLUDED.findings, "updatedAt" = now()`;
    return version;
  };
  w.head = async uid => (await base.$queryRaw`SELECT version FROM "Report" WHERE uid = ${uid}`)[0]?.version ?? 0;
  w.record = async recordId => (await base.$queryRaw`SELECT * FROM "CriticalResult" WHERE id = ${recordId}::uuid`)[0] ?? null;
  w.receipt = async requestId => (await base.$queryRaw`SELECT * FROM "CriticalResultReceipt" WHERE "requestId" = ${requestId}::uuid`)[0] ?? null;
  w.move = async (uid, institution) => base.$executeRaw`UPDATE "StudyState" SET "institutionId" = ${institution} WHERE uid = ${uid}`;
  w.audits = async () => base.$queryRaw`SELECT actor, action, target, detail FROM "AuditLog" WHERE action = ${CRITICAL_RESULT_AUDIT_ACTION} ORDER BY id`;
  w.events = async recordId => base.$queryRaw`SELECT seq, event, revision FROM "CriticalResultEvent" WHERE "recordId" = ${recordId}::uuid ORDER BY seq`;
  w.receipts = async () => base.$queryRaw`SELECT * FROM "CriticalResultReceipt" ORDER BY "requestId"`;
  /** `updates` = records a terminal event moved to revision 2 (a record is written once and updated at most once). */
  w.count = async () => (await base.$queryRaw`SELECT (SELECT count(*)::int FROM "CriticalResult") AS records,
    (SELECT count(*)::int FROM "CriticalResultEvent") AS events, (SELECT count(*)::int FROM "CriticalResultReceipt") AS receipts,
    (SELECT count(*)::int FROM "AuditLog" WHERE action = ${CRITICAL_RESULT_AUDIT_ACTION}) AS audits,
    (SELECT count(*)::int FROM "CriticalResult" WHERE revision = 2) AS updates`)[0];

  const view = (label, client, overrides = {}) => new Proxy({}, { get(_target, name) {
    if (typeof name !== 'string') return undefined;
    touched.add(label + '.' + name);
    if (name in overrides) return overrides[name];
    const value = client[name];
    return typeof value === 'function' ? value.bind(client) : value;
  } });
  // onRecordCreate lets a case put a row in the same transaction just before the service inserts a record, to meet the
  // real unique indexes; the service reaches only create and update of this delegate inside a transaction.
  const txView = tx => view('tx', tx, w.onRecordCreate ? { criticalResult: {
    create: async args => { await w.onRecordCreate(tx, args); return tx.criticalResult.create(args); },
    update: args => tx.criticalResult.update(args) } } : {});
  const prisma = view('root', base, { $transaction: async (fn, options) => {
    transactions.push(options);
    return base.$transaction(async tx => {
      log.push('tx:start');
      try {
        const out = await fn(txView(tx));
        log.push('tx:end');
        return out;
      } catch (e) {
        log.push('tx:rollback');
        throw e;
      }
    }, options);
  } });
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
    if (name === 'studyIdentities') return (await base.$queryRaw`SELECT uid FROM "StudyState" ORDER BY uid`).map(row => source(row.uid));
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

// ── the compiled service over the real database ──

async function approved(w, uid = UID) { await w.commit(uid, 'approve'); return w.head(uid); }

test('C2: create, read (the pinned body), explicit ACK; reads never acknowledge (CR03, CR20)', async () => {
  const w = await world();
  const v1 = await approved(w);
  const created = await w.svc.create(UID, S(), createBody(S(), id(11), 'P', v1));
  assert.deepEqual(Object.keys(created).sort(), ['applied', 'owner', 'replayed']);
  assert.deepEqual(created.applied, { id: id(11), studyUid: UID, requestId: id(11), action: 'create', from: null, to: 'created', revision: 1,
    replacement: null, at: created.applied.at });
  const row = await w.record(id(11));
  assert.deepEqual([row.senderSub, row.senderActor, row.senderName, row.recipientSub, row.recipientActor, row.recipientName, row.recipientRole],
    [SUBS.S, actorOf('S'), 'SYNTHETIC S', SUBS.P, actorOf('P'), 'P SYNTHETIC', 'clinician'], 'attribution from the token and Keycloak');
  assert.deepEqual([row.institutionId, row.senderInstitutionId, row.sourceVersion, row.sourceAction], [INST, INST, v1, 'approve']);
  assert.deepEqual([row.origName, row.origPatientId, row.origBirth, row.origStudyDate], ['SYNTHETIC ORIGINAL', 'SYN-PID-1', '19700101', '20260928']);
  const before = await w.count();
  for (let n = 0; n < 3; n++) {
    const { item } = await w.svc.read(id(11), person('P'));
    assert.equal(item.view, 'full');
    assert.equal(item.state, 'created');
    assert.deepEqual(item.body, { findings: pinnedText(v1), conclusion: 'SYNTHETIC conclusion v' + v1, recommendation: '' });
    assert.equal(item.message, MESSAGE);
  }
  assert.deepEqual(await w.count(), before, 'reads write nothing and never acknowledge');
  const acked = await w.svc.ack(id(11), person('P'), ackBody(person('P'), id(12)));
  assert.deepEqual([acked.replayed, acked.applied.action, acked.applied.from, acked.applied.to, acked.applied.revision],
    [false, 'ack', 'created', 'acknowledged', 2]);
  assert.equal((await w.record(id(11))).state, 'acknowledged');
  const text = JSON.stringify([created, acked, (await w.svc.read(id(11), S())).item]);
  assert.equal(text.includes(HEAD_BODY), false);
  assert.equal(text.includes(DRAFT_BODY), false);
});

test('SV04 / S-CR: every applied requestId replays its stored result before any state check; reuse is 409', async () => {
  const w = await world();
  const v1 = await approved(w);
  const r0 = await w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1));
  const a1 = await w.svc.ack(id(21), person('P'), ackBody(person('P'), id(22)));
  const settled = await w.count();
  assert.deepEqual(settled, { records: 1, events: 2, receipts: 2, audits: 2, updates: 1 });
  // the stored jsonb receipt is the applied result the first answer carried
  assert.deepEqual([(await w.receipt(id(21))).result, (await w.receipt(id(22))).result], [r0.applied, a1.applied]);
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
  assert.deepEqual(await w.count(), settled);
  // S-CR9: P loses clinician (new token); the replay is 403 at the route role
  await assert.rejects(w.svc.ack(id(21), { ...person('P'), roles: [] }, ackBody(person('P'), id(22))), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
  // S-CR11: after S-CR9 the sender's replay still answers the stored result (no recipient content in it)
  w.users.get(SUBS.P).roles = [];
  const late = await w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1));
  assert.deepEqual([late.replayed, late.applied], [true, r0.applied]);
  // S-CR10: the study's owner moves; the replay is hidden like any read
  await w.move(UID, OTHER);
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(21), 'P', v1)), code(404, 'STUDY_NOT_FOUND'));
  assert.deepEqual(await w.count(), settled);
});

test('SV06 Keycloak, Orthanc and source-tag reads end before the transaction; a failed read is 503 with no write', async () => {
  const metadata = { version: 1, restricted: true, startsAt: null, endsAt: null,
    rules: [{ patientId: 'SYN-PID-1', modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] };
  const w = await world({ policies: { S: metadata } });
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
    const f = await world();
    const v = await approved(f);
    f[fail] = true;
    await assert.rejects(f.svc.create(UID, S(), createBody(S(), id(36), 'P', v)), code(503, label === 'Keycloak' ? 'CRITICAL_RESULT_UNAVAILABLE' : undefined), label);
    assert.equal(f.log.includes('tx:start'), false, label);
    assert.deepEqual(await f.count(), { records: 0, events: 0, receipts: 0, audits: 0, updates: 0 }, label);
  }
  const f = await world();
  const v = await approved(f);
  f.orthancFail = true;
  await assert.rejects(f.svc.create(UID, S(), createBody(S(), id(37), 'P', v)), code(503, 'CRITICAL_RESULT_UNAVAILABLE'),
    'no metadata rule: the original identity read is the only Orthanc call and its failure is UNAVAILABLE');
});

test('SV09 the write-time Keycloak re-check: token AND Keycloak roles; replays found before the transaction skip it', async () => {
  const w = await world();
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
  assert.deepEqual((await w.count()).records, 0);
  // the ack of a clinician whose Keycloak roles lost clinician while the token keeps it
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
    const w = await world();
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
    assert.deepEqual(await w.count(), { records: 1, events: 2, receipts: 2, audits: 2, updates: 1 });
    assert.equal((await w.record(id(51))).state, winner);
  }
});

test('S-DUP concurrent creates for one study, sender and recipient: the study row lock admits one; the other names it', async () => {
  const w = await world();
  const v1 = await approved(w);
  const results = await Promise.allSettled([w.svc.create(UID, S(), createBody(S(), id(56), 'P', v1)),
    w.svc.create(UID, S(), createBody(S(), id(57), 'P', v1))]);
  const won = results.filter(r => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  const winner = won[0].value.applied.id;
  assert.ok([id(56), id(57)].includes(winner));
  const [lost] = results.filter(r => r.status === 'rejected').map(r => r.reason);
  assert.ok(code(409, 'CRITICAL_RESULT_PENDING_EXISTS')(lost) && lost.getResponse().id === winner, String(lost));
  assert.deepEqual(await w.count(), { records: 1, events: 1, receipts: 1, audits: 1, updates: 0 });
});

test('the real unique indexes are the last guard: a pending row met by the partial index is PENDING_EXISTS, a reused id REUSED', async () => {
  const w = await world();
  const v1 = await approved(w);
  await approved(w, UID2);
  // Another pending (study, sender, recipient) row appears in the same transaction just before the service inserts:
  // PostgreSQL's CriticalResult_pending_key refuses the insert and the whole transaction rolls back.
  const other = async (tx, args, rowId, studyUid) => tx.$executeRaw`INSERT INTO "CriticalResult" (id, "studyUid", "institutionId",
    "senderInstitutionId", "senderSub", "senderActor", "senderName", "recipientSub", "recipientActor", "recipientName", "recipientRole",
    "sourceVersion", "sourceAction", "sourceAuthor", "sourceAt", "origName", "origPatientId", "origBirth", "origStudyDate", message,
    state, revision, "changedBy", "createdAt", "updatedAt")
    SELECT ${rowId}::uuid, ${studyUid}, ${args.data.institutionId}, ${args.data.senderInstitutionId}, ${args.data.senderSub},
      ${args.data.senderActor}, ${args.data.senderName}, ${args.data.recipientSub}, ${args.data.recipientActor}, ${args.data.recipientName},
      ${args.data.recipientRole}, version, action, author, at, 'SYNTHETIC', 'SYNTHETIC', '', '', 'SYNTHETIC injected', 'created', 1,
      ${args.data.changedBy}, now(), now() FROM "ReportVersion" WHERE uid = ${studyUid} AND version = 1`;
  w.onRecordCreate = (tx, args) => other(tx, args, id(58), UID);
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(59), 'P', v1)),
    e => code(409, 'CRITICAL_RESULT_PENDING_EXISTS')(e) && e.getResponse().id === undefined, 'the index, not the pre-check, refused');
  assert.ok(w.log.includes('tx:rollback'));
  assert.deepEqual(await w.count(), { records: 0, events: 0, receipts: 0, audits: 0, updates: 0 }, 'nothing persists');
  // the same requestId written for another study in the same transaction: the primary key refuses, REQUEST_ID_REUSED
  w.onRecordCreate = (tx, args) => other(tx, args, args.data.id, UID2);
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(60), 'P', v1)), code(409, 'REQUEST_ID_REUSED'));
  assert.deepEqual(await w.count(), { records: 0, events: 0, receipts: 0, audits: 0, updates: 0 });
  // control: without the injected row the same request applies
  w.onRecordCreate = null;
  assert.equal((await w.svc.create(UID, S(), createBody(S(), id(60), 'P', v1))).replayed, false);
});

test('SV07 audit rows: one per event (supersede two), exactly the section 11 keys, no message, reason or patient text', async () => {
  const w = await world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(61), 'P', v1));
  await w.svc.supersede(id(61), S(), supersedeBody(S(), id(62), 1, v1));
  await w.svc.ack(id(62), person('P'), ackBody(person('P'), id(63)));
  await w.svc.create(UID, S(), createBody(S(), id(64), 'X', v1));
  await w.svc.cancel(id(64), S(), cancelBody(S(), id(65)));
  const audits = await w.audits();
  assert.equal(audits.length, 6, 'create 1 + supersede 2 + ack 1 + create 1 + cancel 1');
  const KEYS = ['event', 'from', 'id', 'institution', 'recipient', 'replacedBy', 'requestId', 'revision', 'role', 'senderInstitution', 'source',
    'supersedes', 'to'];
  const details = audits.map(row => {
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
  // append-only: each record has seq 1 created and at most one seq 2
  for (const recordId of [id(61), id(62), id(64)]) {
    const seqs = (await w.events(recordId)).map(e => [e.seq, e.event, e.revision]);
    assert.deepEqual(seqs[0], [1, 'created', 1]);
    assert.ok(seqs.length <= 2);
  }
  const receipts = await w.receipts();
  assert.deepEqual(receipts.map(r => [r.requestId, r.recordId, r.action, r.appliedRevision]), [
    [id(61), id(61), 'create', 1], [id(62), id(61), 'supersede', 2], [id(63), id(62), 'ack', 2], [id(64), id(64), 'create', 1],
    [id(65), id(64), 'cancel', 2]]);
  for (const receipt of receipts) {
    assert.match(receipt.fingerprint, /^[0-9a-f]{64}$/);
    for (const text of [MESSAGE, REASON, 'SYNTHETIC ORIGINAL']) assert.equal(JSON.stringify(receipt.result).includes(text), false);
  }
});

test('SV11 answers carry the pinned rows only; the service reaches no draft, report or other delegate', async () => {
  const w = await world();
  const v1 = await approved(w);
  const responses = [];
  responses.push(await w.svc.recipients(UID, S()));
  responses.push(await w.svc.create(UID, S(), createBody(S(), id(71), 'P', v1)));
  responses.push(await w.svc.read(id(71), person('P')));
  responses.push(await w.svc.read(id(71), S()));
  await w.commit(UID, 'addendum');
  responses.push(await w.svc.read(id(71), person('P')));
  responses.push(await w.svc.supersede(id(71), S(), supersedeBody(S(), id(72), 1, v1 + 1)));
  responses.push(await w.svc.read(id(72), person('P')));
  responses.push(await w.svc.ack(id(72), person('P'), ackBody(person('P'), id(73))));
  responses.push(await w.svc.list(person('P'), { view: 'received' }));
  responses.push(await w.svc.list(S(), { view: 'sent' }));
  responses.push(await w.svc.forStudy(UID, person('P')));
  const text = JSON.stringify(responses);
  for (const marker of [HEAD_BODY, DRAFT_BODY]) assert.equal(text.includes(marker), false, marker);
  assert.equal(responses[2].item.body.findings, pinnedText(v1));
  assert.equal(responses[6].item.body.findings, pinnedText(v1 + 1), 'the replacement shows its own pinned row');
  const allowed = ['root.$transaction', 'root.$queryRaw', 'root.criticalResultReceipt', 'root.criticalResult', 'root.studyState',
    'tx.$executeRaw', 'tx.$queryRaw', 'tx.criticalResult', 'tx.criticalResultEvent', 'tx.criticalResultReceipt', 'tx.auditLog'];
  assert.deepEqual([...w.touched].filter(name => !allowed.includes(name)), [], 'no reportDraft, report or other delegate');
  const types = Reflect.getMetadata('design:paramtypes', CriticalResultService).map(type => type.name);
  assert.deepEqual(types, ['PrismaService', 'StudyAccessService', 'KeycloakService', 'OrthancService']);
});

test('SV11 in SQL: after the head moves, read, the received list and the study list return each record\'s own pinned row', async () => {
  const w = await world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(161), 'P', v1));   // C2, then C3 when the head moves
  await w.svc.create(UID, S(), createBody(S(), id(162), 'X', v1));   // R2, then R3 (full: the pinned row, not the head)
  const v2 = await w.commit(UID, 'addendum');
  // X's pinned v1 row, never the v2 head row, the Report body or the draft; P's record is a stub without a body
  const readX = (await w.svc.read(id(162), person('X'))).item;
  const listX = (await w.svc.list(person('X'), { view: 'received' })).items;
  const studyX = (await w.svc.forStudy(UID, person('X'))).items;
  for (const [label, item] of [['read', readX], ['list', listX[0]], ['study list', studyX[0]]]) {
    assert.deepEqual([item.id, item.view, item.source.current, item.source.reason, item.body.findings],
      [id(162), 'full', false, 'head_moved', pinnedText(v1)], label);
    assert.equal(JSON.stringify(item).includes(pinnedText(v2)), false, label);
  }
  const listP = await w.svc.list(person('P'), { view: 'received' });
  const studyP = (await w.svc.forStudy(UID, person('P'))).items;
  for (const item of [listP.items[0], studyP[0]]) assert.deepEqual([item.id, item.view, 'body' in item, 'message' in item], [id(161), 'stub', false, false]);
  // the replacement pins v2; each record keeps its own row in the same list, and pending counts created records only
  await w.svc.supersede(id(162), S(), supersedeBody(S(), id(163), 1, v2));
  const both = await w.svc.list(person('X'), { view: 'received' });
  assert.deepEqual(both.items.map(item => [item.id, item.state, item.body.findings]).sort(),
    [[id(162), 'superseded', pinnedText(v1)], [id(163), 'created', pinnedText(v2)]]);
  assert.deepEqual([both.pending, listP.pending, (await w.svc.list(S(), { view: 'sent' })).pending], [1, 1, 2],
    'X: its replacement; P: the C3 stub is still pending; S: both of its pending records');
  assert.deepEqual((await w.svc.list(person('X'), { view: 'received', state: 'pending' })).items.map(item => item.id), [id(163)]);
  const text = JSON.stringify([readX, listX, studyX, listP, studyP, both]);
  for (const marker of [HEAD_BODY, DRAFT_BODY]) assert.equal(text.includes(marker), false, marker);
});

test('the received list and pending leave out C5 and R5 rows in the same SQL, before the page', async () => {
  const w = await world();
  const s1 = await w.commit(UID, 'save');
  await w.svc.create(UID, S(), createBody(S(), id(171), 'M', s1));   // R2 for the mixed member M
  const p1 = await w.commit(UID2, 'preliminary', { author: actorOf('S'), reviewer: actorOf('Y') });
  await w.svc.create(UID2, S(), createBody(S(), id(172), 'Y', p1));   // R2 for the named reviewer Y
  const asClinician = { ...person('M'), roles: ['clinician'] };      // M's new token: class C, the unsigned pin is C5
  for (const [who, recordId] of [[asClinician, id(171)], [person('Y'), id(172)]]) {
    const before = await w.svc.list(who, { view: 'received' });
    assert.equal(before.pending, who === asClinician ? 0 : 1);
    assert.deepEqual(before.items.map(item => item.id), who === asClinician ? [] : [recordId]);
  }
  // the P pair moves away from Y at the same head: R5, absent from the list, the count and the one-record read
  await w.base.$executeRaw`UPDATE "StudyState" SET "preReviewer" = ${actorOf('Z')} WHERE uid = ${UID2}`;
  const after = await w.svc.list(person('Y'), { view: 'received' });
  assert.deepEqual([after.items, after.pending], [[], 0]);
  await assert.rejects(w.svc.read(id(172), person('Y')), code(404, 'CRITICAL_RESULT_NOT_FOUND'));
  await assert.rejects(w.svc.read(id(171), asClinician), code(404, 'CRITICAL_RESULT_NOT_FOUND'));
  assert.equal((await w.svc.list(person('M'), { view: 'received' })).items.length, 1, 'M with radiologist still reads its R2 row');
});

test('the received list pages by (createdAt, id) under a cursor bound to the StudyAccess revision', async () => {
  const w = await world();
  const uids = Array.from({ length: 52 }, (_, n) => '2.25.8' + String(n).padStart(3, '0'));
  const made = [];
  for (const [n, uid] of uids.entries()) {
    await w.study(uid);
    const v = await approved(w, uid);
    made.push((await w.svc.create(uid, S(), createBody(S(), id(200 + n), 'P', v))).applied.id);
  }
  const first = await w.svc.list(person('P'), { view: 'received' });
  assert.equal(first.items.length, 50);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.pending, 52, 'pending is the server count, not the page length');
  const second = await w.svc.list(person('P'), { view: 'received', cursor: first.nextCursor });
  assert.deepEqual([second.items.length, second.nextCursor], [2, null]);
  const order = [...first.items, ...second.items].map(item => [item.createdAt, item.id]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] === b[0] ? (a[1] < b[1] ? 1 : -1) : (a[0] < b[0] ? 1 : -1)), 'createdAt DESC, id DESC');
  assert.deepEqual(order.map(([, recordId]) => recordId).sort(), [...made].sort(), 'every record once');
  // P's StudyAccess policy gets a revision: the earlier cursor is refused, not read on the new scope
  await w.base.$executeRaw`INSERT INTO "StudyAccessPolicy" (institution, subject, revision, policy, reason, "updatedBy", "updatedAt")
    VALUES (${INST}, ${SUBS.P}, 1, ${JSON.stringify({ version: 1, restricted: false, startsAt: null, endsAt: null, rules: [] })}::jsonb,
      'SYNTHETIC policy', 'SYNTHETIC-admin', now())`;
  await assert.rejects(w.svc.list(person('P'), { view: 'received', cursor: first.nextCursor }), code(400, 'CRITICAL_RESULT_INPUT_INVALID'));
  assert.equal((await w.svc.list(person('P'), { view: 'received' })).items.length, 50);
});

test('SV13 a StudyAccess refusal after the commit leaves the applied write; the same requestId replays it', async () => {
  for (const failure of ['409', '503']) {
    const w = await world();
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
      const { updates, ...counts } = await w.count();
      assert.deepEqual(counts, after, handler + ': the write committed before the refusal');
      mode = 'pass';
      const replay = await call(handler, c, ...args);
      assert.equal(replay.replayed, true, handler);
      assert.equal(replay.applied.requestId, args[2].requestId);
      const { updates: _u, ...same } = await w.count();
      assert.deepEqual(same, after, handler + ': the replay writes nothing');
    }
  }
});

test('SV14 a delayed original create applies after its replay was refused; a delayed id-route write cannot outlive a terminal state', async () => {
  const w = await world();
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
  assert.equal(await w.receipt(id(91)), null, 'the refused replay is not evidence that R0 never applies');
  await w.svc.ack(id(92), person('P'), ackBody(person('P'), id(93)));
  const settled = await w.count();
  r0Hold.release();
  const applied = await r0;
  assert.equal(applied.replayed, false);
  assert.deepEqual(await w.count(), { ...settled, records: settled.records + 1, events: settled.events + 1, receipts: settled.receipts + 1,
    audits: settled.audits + 1 });
  const replay = await w.svc.create(UID, S(), createBody(S(), id(91), 'P', v1));
  assert.deepEqual([replay.replayed, replay.applied], [true, applied.applied]);
  // the id route: an ack held before its transaction, the sender cancels, the ack's replay and the ack itself are 409
  const a0Caller = person('P');
  const a0Hold = holdFor(a0Caller);
  const a0 = w.svc.ack(id(91), a0Caller, ackBody(person('P'), id(94)));
  await a0Hold.entered;
  await w.svc.cancel(id(91), S(), cancelBody(S(), id(95)));
  const terminal = await w.count();
  await assert.rejects(w.svc.ack(id(91), person('P'), ackBody(person('P'), id(94))), code(409, 'CRITICAL_RESULT_CANCELLED'));
  a0Hold.release();
  await assert.rejects(a0, code(409, 'CRITICAL_RESULT_CANCELLED'));
  assert.deepEqual(await w.count(), terminal);
});

// ── lock failure (contract lock table: P2024/P2028/P2034, 55P03/57014/40P01 -> 503 CRITICAL_RESULT_BUSY) ──

/**
 * The advisory lock the real StudyAccessService takes for `caller` in a transaction, read back from PostgreSQL's pg_locks
 * (so the key is not rebuilt here). A policy write takes the same subject's lock exclusively (contract section 4).
 */
async function policyLock(w, caller) {
  return w.base.$transaction(async tx => {
    await w.access.snapshot(caller, tx);
    const rows = await tx.$queryRaw`SELECT ((classid::bigint << 32) | objid::bigint)::text AS key FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND mode = 'ShareLock' AND granted`;
    assert.equal(rows.length, 1, 'one shared advisory lock per policy snapshot');
    return rows[0].key;
  });
}

/** Another connection holds `key` exclusively, as a policy write in progress does, until the returned release runs. */
async function holdLock(w, key) {
  let locked, open;
  const held = new Promise(r => { locked = r; }), gate = new Promise(r => { open = r; });
  const done = w.base.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${key}::bigint)`;
    locked();
    await gate;
  }, { maxWait: 4000, timeout: 60000 });
  await Promise.race([held, done.then(() => { throw new Error('the hold ended before it took the lock'); })]);
  return async () => { open(); await done; };
}

const DB_TEXT = /55P03|57014|40P01|P20\d\d|lock timeout|advisory|pg_|SELECT|StudyAccessPolicy|Raw query/i;

test('lock failure: a policy lock held by another connection times out the caller or recipient StudyAccess lock -> 503 CRITICAL_RESULT_BUSY, nothing written; the same requestId applies later', async () => {
  // Astra S7-U1a-D-R-001-F01: StudyAccess passes the lock timeout on only as the cause of its own 503.
  const w = await world();
  const v1 = await approved(w);
  const v2 = await approved(w, UID2);
  const locks = { caller: await policyLock(w, S()), recipient: await policyLock(w, person('P')) };
  assert.notEqual(locks.caller, locks.recipient, 'the sender and the recipient subject have their own policy locks');
  const busyUnder = async (label, key, call, requestId) => {
    const before = await w.count();
    const release = await holdLock(w, key);
    try {
      await assert.rejects(call(), e => {
        const body = e.getResponse();
        assert.deepEqual([e.getStatus(), body.code, Object.keys(body).sort()], [503, 'CRITICAL_RESULT_BUSY', ['code', 'message']], label);
        assert.ok(!DB_TEXT.test(JSON.stringify(body)), label + ': no DB text in the answer');
        return true;
      }, label);
    } finally { await release(); }
    assert.deepEqual(await w.count(), before, label + ': no record, event, receipt or audit row');
    assert.equal(await w.receipt(requestId), null, label + ': the requestId is not spent');
  };
  // (a) create: the sender's lock, then the recipient subject's lock; the same request applies once both are free
  const create = () => w.svc.create(UID, S(), createBody(S(), id(301), 'P', v1));
  await busyUnder('create, sender lock', locks.caller, create, id(301));
  await busyUnder('create, recipient lock', locks.recipient, create, id(301));
  const created = await create();
  assert.deepEqual([created.replayed, created.applied.to, (await w.record(id(301))).state], [false, 'created', 'created']);
  // (b) ack: the recipient is the caller
  const ack = () => w.svc.ack(id(301), person('P'), ackBody(person('P'), id(302)));
  await busyUnder('ack, caller lock', locks.recipient, ack, id(302));
  assert.deepEqual([(await w.record(id(301))).state, (await w.record(id(301))).revision], ['created', 1]);
  assert.deepEqual([(await ack()).replayed, (await w.record(id(301))).state], [false, 'acknowledged']);
  // (c) supersede: the sender's lock, then the recipient subject's lock
  await w.svc.create(UID2, S(), createBody(S(), id(303), 'P', v2));
  const supersede = () => w.svc.supersede(id(303), S(), supersedeBody(S(), id(304), 1, v2));
  await busyUnder('supersede, sender lock', locks.caller, supersede, id(304));
  await busyUnder('supersede, recipient lock', locks.recipient, supersede, id(304));
  assert.deepEqual([(await w.record(id(303))).state, await w.record(id(304))], ['created', null]);
  const superseded = await supersede();
  assert.deepEqual([superseded.replayed, superseded.applied.replacement.id, (await w.record(id(303))).state], [false, id(304), 'superseded']);
  assert.deepEqual([(await supersede()).replayed, (await create()).replayed], [true, true], 'applied requests replay as before');
});

test('lock failure only: a malformed policy read in the transaction and the post-commit interceptor 503 keep the code-less StudyAccess answer', async () => {
  const w = await world();
  const v1 = await approved(w);
  // The table's CHECK admits it (an object, version 1, a boolean and an array); StudyAccess's own policy check does not.
  const malformed = { version: 1, restricted: true, startsAt: null, endsAt: null, rules: ['SYN-MALFORMED'] };
  // The policy row turns malformed after the sender's preparation, so the transaction's own StudyAccess read meets it.
  const original = w.access.prepare.bind(w.access);
  let armed = true;
  w.access.prepare = async (c, uids, policy) => {
    const out = await original(c, uids, policy);
    if (armed && c.sub === SUBS.S) {
      armed = false;
      await w.base.$executeRaw`INSERT INTO "StudyAccessPolicy" (institution, subject, revision, policy, reason, "updatedBy", "updatedAt")
        VALUES (${INST}, ${SUBS.S}, 1, ${JSON.stringify(malformed)}::jsonb, 'SYNTHETIC policy', 'SYNTHETIC-admin', now())`;
    }
    return out;
  };
  let refused, studyAccessAnswer;
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(311), 'P', v1)), e => { refused = e; return true; });
  assert.equal(armed, false, 'the row turned malformed between the preparation and the transaction');
  assert.ok(w.log.includes('tx:rollback'), 'the transaction met the malformed row: ' + String(refused));
  await assert.rejects(w.access.snapshot(S()), e => { studyAccessAnswer = [e.getStatus(), e.getResponse()]; return true; });
  assert.deepEqual([refused.getStatus(), refused.getResponse()], studyAccessAnswer, 'StudyAccess\'s own answer for this row, unchanged');
  assert.equal(refused.getResponse().code, undefined);
  assert.deepEqual(await w.count(), { records: 0, events: 0, receipts: 0, audits: 0, updates: 0 });
  // After the commit the interceptor's 503 stays code-less even when StudyAccess's cause is a DB timeout (SV13, section 8.1).
  await w.base.$executeRaw`DELETE FROM "StudyAccessPolicy" WHERE subject = ${SUBS.S}`;
  const controller = new CriticalResultController(w.svc);
  let fail = true;
  const timeout = Object.assign(new Error('SYN-DB-DETAIL canceling statement due to statement timeout'), { code: 'P2010', meta: { code: '57014' } });
  const interceptor = new StudyAccessInterceptor({ snapshot: async () => ({ revision: 0 }), unchanged: async () => {
    if (fail) throw new ServiceUnavailableException('SYNTHETIC policy read failed', { cause: timeout });
  } });
  const c = S(), req = { kind: 'member', institution: c.institution, sub: c.sub, actor: c.actor, roles: c.roles, displayName: c.name };
  const context = { switchToHttp: () => ({ getRequest: () => req }), getClass: () => CriticalResultController,
    getHandler: () => CriticalResultController.prototype.create };
  const post = async () => lastValueFrom(await interceptor.intercept(context, { handle: () => from(controller.create(UID, req, createBody(c, id(311), 'P', v1))) }));
  await assert.rejects(post(), e => {
    assert.deepEqual([e.getStatus(), e.getResponse().code], [503, undefined]);
    assert.ok(!DB_TEXT.test(JSON.stringify(e.getResponse())));
    return true;
  });
  const { updates, ...committed } = await w.count();
  assert.deepEqual(committed, { records: 1, events: 1, receipts: 1, audits: 1 }, 'the write committed before the refusal');
  fail = false;
  assert.equal((await post()).replayed, true);
  const { updates: _u, ...same } = await w.count();
  assert.deepEqual(same, committed, 'the replay writes nothing');
});

test('S-SU / C3: head moved after create is a stub with no message or body, ACK refused, supersede onto the new head', async () => {
  const w = await world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(101), 'P', v1));
  const v2 = await w.commit(UID, 'addendum');
  const stub = (await w.svc.read(id(101), person('P'))).item;
  assert.deepEqual([stub.view, stub.source.current, stub.source.reason, stub.state], ['stub', false, 'head_moved', 'created']);
  for (const text of [MESSAGE, pinnedText(v1), pinnedText(v2), HEAD_BODY]) assert.equal(JSON.stringify(stub).includes(text), false, text);
  await assert.rejects(w.svc.ack(id(101), person('P'), ackBody(person('P'), id(102))), code(409, 'CRITICAL_RESULT_SOURCE_CHANGED'));
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(103), 'P', v2)),
    e => code(409, 'CRITICAL_RESULT_PENDING_EXISTS')(e) && e.getResponse().id === id(101));
  await assert.rejects(w.svc.supersede(id(101), S(), supersedeBody(S(), id(104), 1, v1)), code(409, 'CRITICAL_RESULT_SOURCE_MOVED'));
  const before = await w.count();
  const sup = await w.svc.supersede(id(101), S(), supersedeBody(S(), id(104), 1, v2));
  assert.deepEqual(sup.applied.replacement, { id: id(104), revision: 1, sourceVersion: v2 });
  assert.deepEqual([sup.applied.id, sup.applied.from, sup.applied.to, sup.applied.revision], [id(101), 'created', 'superseded', 2]);
  assert.deepEqual(await w.count(), { ...before, records: before.records + 1, events: before.events + 2, receipts: before.receipts + 1,
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
  const w = await world();
  const v1 = await approved(w);
  await w.svc.create(UID, S(), createBody(S(), id(111), 'P', v1));
  await w.commit(UID, 'reset', { discard: true });
  const head = await w.head(UID);
  assert.equal(head, v1 + 2, 'discarded v2 then reset v3');
  const stub = (await w.svc.read(id(111), person('P'))).item;
  assert.deepEqual([stub.view, stub.source.reason], ['stub', 'reset']);
  await assert.rejects(w.svc.ack(id(111), person('P'), ackBody(person('P'), id(112))), code(409, 'CRITICAL_RESULT_SOURCE_CHANGED'));
  await assert.rejects(w.svc.supersede(id(111), S(), supersedeBody(S(), id(113), 1, head)), code(409, 'CRITICAL_RESULT_SOURCE_INVALID'));
  await assert.rejects(w.svc.supersede(id(111), S(), supersedeBody(S(), id(113), 1, v1 + 1)), code(409, 'CRITICAL_RESULT_SOURCE_MOVED'),
    'the discarded number is never the head');
  const cancelled = await w.svc.cancel(id(111), S(), cancelBody(S(), id(114)));
  assert.deepEqual([cancelled.applied.to, cancelled.applied.revision], ['cancelled', 2]);
  assert.equal((await w.record(id(111))).cancelReason, REASON);
  await assert.rejects(w.svc.ack(id(111), person('P'), ackBody(person('P'), id(115), 2)), code(409, 'CRITICAL_RESULT_CANCELLED'));
});

test('S-RR: unsigned sources reach radiologists only; after the head moves the reader sees the pinned row, not the head', async () => {
  const w = await world();
  const v1 = await w.commit(UID, 'save');
  await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(121), 'P', v1)), code(409, 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ'), 'S-RR1 (C1)');
  for (const who of ['CT', 'CA']) await assert.rejects(w.svc.create(UID, S(), createBody(S(), id(121), who, v1)),
    code(409, 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ'), who + ': a mixed non-reader is class C');
  assert.equal((await w.count()).records, 0);
  await w.svc.create(UID, S(), createBody(S(), id(122), 'X', v1));
  const r2 = (await w.svc.read(id(122), person('X'))).item;
  assert.deepEqual([r2.view, r2.source.current, r2.body.findings], ['full', true, pinnedText(v1)], 'S-RR2');
  const v2 = await w.commit(UID, 'approve', { author: actorOf('S') });
  const r3 = (await w.svc.read(id(122), person('X'))).item;
  assert.deepEqual([r3.view, r3.source.current, r3.source.reason, r3.body.findings], ['full', false, 'head_moved', pinnedText(v1)], 'S-RR3');
  await assert.rejects(w.svc.ack(id(122), person('X'), ackBody(person('X'), id(123))), code(409, 'CRITICAL_RESULT_SOURCE_CHANGED'), 'S-RR4');
  await w.svc.supersede(id(122), S(), supersedeBody(S(), id(124), 1, v2));
  await w.svc.ack(id(124), person('X'), ackBody(person('X'), id(125)));
  // S-RR6/7: a preliminary with reviewer Y on another study
  const p1 = await w.commit(UID2, 'preliminary', { author: actorOf('S'), reviewer: actorOf('Y') });
  await assert.rejects(w.svc.create(UID2, S(), createBody(S(), id(126), 'X', p1)), code(409, 'CRITICAL_RESULT_RECIPIENT_CANNOT_READ'), 'S-RR6 (R1)');
  await w.svc.create(UID2, S(), createBody(S(), id(127), 'Y', p1));
  await assert.rejects(w.svc.create(UID2, person('Z'), createBody(person('Z'), id(128), 'Y', p1)), code(403, 'CRITICAL_RESULT_SOURCE_FORBIDDEN'), 'S-RR7');
  // S-RR8: a mixed member M loses radiologist (new token): the unsigned pin is C5, absent
  const w2 = await world();
  const s1 = await w2.commit(UID, 'save');
  await w2.svc.create(UID, S(), createBody(S(), id(129), 'M', s1));
  await assert.rejects(w2.svc.read(id(129), { ...person('M'), roles: ['clinician'] }), code(404, 'CRITICAL_RESULT_NOT_FOUND'), 'S-RR8');
});

test('ordering, duplicates and boundaries: body before owner, role before body, 404 before the 409s, pending per sender', async () => {
  const w = await world();
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
  const w = await world();
  const s1 = await w.commit(UID, 'save');
  let out = await w.svc.recipients(UID, S());
  assert.deepEqual(Object.keys(out).sort(), ['owner', 'reason', 'recipients', 'sendable', 'source', 'uid']);
  assert.deepEqual([out.sendable, out.reason, out.source.version, out.source.action, out.source.final], [true, null, s1, 'save', false]);
  const subs = out.recipients.map(r => r.sub).sort();
  assert.deepEqual(subs, [SUBS.AR, SUBS.M, SUBS.X, SUBS.Y, SUBS.Z].sort(), 'radiologists (and mixed) only for an unsigned head');
  for (const r of out.recipients) assert.deepEqual(Object.keys(r).sort(), ['actor', 'name', 'role', 'sub']);
  await w.commit(UID, 'approve');
  out = await w.svc.recipients(UID, S());
  assert.deepEqual(out.recipients.map(r => r.sub).sort(), [SUBS.AR, SUBS.CA, SUBS.CT, SUBS.M, SUBS.P, SUBS.P2, SUBS.X, SUBS.Y, SUBS.Z].sort());
  for (const r of out.recipients) assert.equal(r.role, P.recipientClass(PEOPLE[Object.keys(SUBS).find(k => SUBS[k] === r.sub)].roles));
  // every listed candidate is accepted by create; the unlisted ones are refused
  const head = await w.head(UID);
  let n = 140;
  for (const r of out.recipients) assert.equal((await w.svc.create(UID, S(), { ...createBody(S(), id(n++), 'P', head), recipientSub: r.sub })).replayed, false);
  const p1 = await w.commit(UID2, 'preliminary', { author: actorOf('S'), reviewer: actorOf('Y') });
  out = await w.svc.recipients(UID2, S());
  assert.deepEqual(out.recipients.map(r => r.sub), [SUBS.Y], 'only the preliminary pair reads an RS P head');
  out = await w.svc.recipients(UID2, person('Z'));
  assert.deepEqual([out.sendable, out.reason, out.source, out.recipients], [false, 'SOURCE_FORBIDDEN', null, []]);
  await w.commit(UID2, 'reset');
  out = await w.svc.recipients(UID2, S());
  assert.deepEqual([out.sendable, out.reason, out.source], [false, 'NO_PINNABLE_SOURCE', null]);
  assert.equal(p1 > 0, true);
  await assert.rejects(w.svc.recipients(UID, person('P')), code(403, 'CRITICAL_RESULT_ROLE_REQUIRED'));
});
