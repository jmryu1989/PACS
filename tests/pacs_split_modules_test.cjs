'use strict';
/* TEST-S9-U0b-MODULES — the PACS concern modules of api/src/pacs/ run directly (S9-U0b round 1, order §6 step 2, §8).
 *
 * What is bound: behaviour and permission contracts (AGENTS §1, §1-B / D73) — who may read or write a study, what a refusal
 * answers (HTTP status, `code`), what is stored, which history rows are appended and which audit rows are written, and that
 * a write and its audit row commit or roll back together. Nothing here reads source text, file layout or private names.
 * No byte pins.
 *
 * How: each concern is a plain object (PacsService builds and owns them; they are not Nest providers). The cases build the
 * same graph the facade will build, over test-owned value providers: an in-memory Prisma double with transactional
 * rollback that records which client (root or transaction) every write used, StudyAccess / Orthanc / Keycloak / Findings
 * doubles. No Docker, no database, no stack. The compiled service suites over a real PostgreSQL remain the authority for
 * SQL and snapshot semantics; this file proves the moved behaviour of each concern on its own.
 *
 * REQ -> RISK -> TEST (order §8):
 *   REQ-U0B-ACCESS   -> RISK-TENANT-ROLE        -> SPLIT-03, SPLIT-04, SPLIT-05, SPLIT-06, SPLIT-20 (M01, M02, M03)
 *   REQ-U0B-REPORT   -> RISK-HISTORY-STATE      -> SPLIT-07, SPLIT-08 (M04, M05, M06, M07)
 *   REQ-U0B-DRAFT    -> RISK-TEXT-SESSION       -> SPLIT-09, SPLIT-10 (M08, M09, M10)
 *   REQ-U0B-HOLD     -> RISK-LOCK               -> SPLIT-02, SPLIT-11 (M11, M12)
 *   REQ-U0B-QUERY    -> RISK-IDENTITY-LEAK      -> SPLIT-02, SPLIT-12, SPLIT-13, SPLIT-16 (M13, M14)
 *   REQ-U0B-EVIDENCE -> RISK-HIDDEN-CITATION    -> SPLIT-14, SPLIT-15 (M16, M17, M18)
 *   REQ-U0B-NOTE-GW  -> RISK-DUPLICATE-AUDIT    -> SPLIT-17, SPLIT-18 (M19, M20)
 *   construction: SPLIT-01 (constructors store references only: no IO, no timers, no seeding).
 *
 * Runs as `node --test tests/pacs_split_modules_test.cjs` (the installed TypeScript compiles api/src through
 * tests/service_test_loader.cjs) and unchanged against a compiled /app/dist.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
if (!fs.existsSync('/app/dist/pacs')) require('./service_test_loader.cjs');

const { HttpException, NotFoundException } = require('/app/node_modules/@nestjs/common');
const { Prisma } = require('/app/node_modules/@prisma/client');
const values = require('/app/dist/pacs/values');
const accessModule = require('/app/dist/pacs/access');
const { PacsAccess, need, needExact, inst } = accessModule;
const { PacsInstitutions } = require('/app/dist/pacs/institutions');
const { PacsPreferences } = require('/app/dist/pacs/preferences');
const { PacsFilters } = require('/app/dist/pacs/filters');
const { PacsAudit } = require('/app/dist/pacs/audit');
const { PacsMetrics } = require('/app/dist/pacs/metrics');
const { PacsWorklist } = require('/app/dist/pacs/worklist');
const { PacsDicomGateway } = require('/app/dist/pacs/dicom-gateway');
const { PacsStudyState } = require('/app/dist/pacs/study-state');
const { PacsTechNote } = require('/app/dist/pacs/tech-note');
const { PacsHold } = require('/app/dist/pacs/hold');
const { PacsClinician } = require('/app/dist/pacs/clinician');
const { PacsReportEvidence } = require('/app/dist/pacs/report-evidence');
const { PacsReportDraft } = require('/app/dist/pacs/report-draft');
const { PacsReportCommit } = require('/app/dist/pacs/report-commit');
const { STRUCTURE_CATALOG } = require('/app/dist/report-structure');

// ── the Prisma double: tables in memory, transactions on a copy, every write recorded with its client ──

const MODEL = name => name[0].toUpperCase() + name.slice(1);
const UNIQUE = {
  studyState: [['uid']], report: [['uid']], reportDraft: [['uid', 'author']], reportVersion: [['uid', 'version']],
  techNoteRevision: [['studyUid', 'version'], ['attemptId']], gatewayRetryRequest: [['studyUid', 'epoch', 'seq']],
  gatewayReceipt: [['studyUid']], institution: [['id']], order: [['oid']], memberRights: [['sub']], authSession: [['sid']],
  readerAssignment: [['studyUid', 'institutionId']], readingPreferences: [['institution', 'subject']],
  userFilter: [['owner', 'name']], userFilterCollection: [['owner']], sharedFilterLibrary: [['institution']],
};
const AUTO_ID = new Set(['auditLog', 'reportVersion', 'readingTemplate', 'userFilter', 'viewerItem']);
const DEFAULTS = {
  studyState: () => ({ teleInstitutionId: null, rs: 'W', ss: 'Unverified', em: 'N', ts: 'none', matched: 'U', ward: null,
    reqHosp: null, holder: null, heldAt: null, holdReason: null, preDoc: null, preReviewer: null, preDocSub: null,
    preReviewerSub: null, repDoc: null, confirm: null, ov: null, orig: null, orderOid: null, origin: 'device',
    draftEpoch: randomUUID(), createdAt: new Date() }),
  auditLog: () => ({ detail: null, at: new Date() }),
  reportVersion: () => ({ citations: null, structured: null, reason: null, at: new Date() }),
  reportDraft: () => ({ citations: null, structured: null, updatedAt: new Date() }),
  techNoteRevision: () => ({ attemptId: null, createdAt: new Date() }),
  report: () => ({ updatedAt: new Date() }),
  readerAssignment: () => ({ closedAt: null, revision: 0 }),
};
const copy = value => structuredClone(value);
const same = (a, b) => ((a instanceof Date || b instanceof Date) ? +a === +b : (a ?? null) === (b ?? null));
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
function cond(value, filter) {
  if (filter === undefined) return true;
  if (!plain(filter)) return same(value, filter);
  if ('path' in filter) { let at = value; for (const key of filter.path) at = at?.[key]; return !('equals' in filter) || same(at, filter.equals); }
  for (const [op, arg] of Object.entries(filter)) {
    if (op === 'equals') { if (!same(value, arg)) return false; }
    else if (op === 'in') { if (!arg.some(a => same(value, a))) return false; }
    else if (op === 'notIn') { if (arg.some(a => same(value, a))) return false; }
    else if (op === 'not') { if (plain(arg) ? cond(value, arg) : same(value, arg)) return false; }
    else if (op === 'lt') { if (!(value < arg)) return false; }
    else if (op === 'lte') { if (!(value <= arg)) return false; }
    else if (op === 'gt') { if (!(value > arg)) return false; }
    else if (op === 'gte') { if (!(value >= arg)) return false; }
    else if (op === 'has') { if (!(Array.isArray(value) && value.includes(arg))) return false; }
    else throw new Error('double: unsupported filter ' + op);
  }
  return true;
}
function matches(row, where) {
  for (const [key, filter] of Object.entries(where ?? {})) {
    if (key === 'OR') { if (!filter.some(w => matches(row, w))) return false; }
    else if (key === 'AND') { if (![].concat(filter).every(w => matches(row, w))) return false; }
    else if (key.includes('_') && plain(filter)) { if (!matches(row, filter)) return false; }   // compound unique key
    else if (!cond(row[key], filter)) return false;
  }
  return true;
}
const pick = (row, select) => (!select ? copy(row) : Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, copy(row[k] ?? null)])));
function sorted(rows, orderBy) {
  const keys = [].concat(orderBy ?? []).flatMap(o => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? +a[k] : a[k], y = b[k] instanceof Date ? +b[k] : b[k];
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function applyData(row, data) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined) continue;
    if (v === Prisma.DbNull || v === Prisma.JsonNull) row[k] = null;
    else if (plain(v) && Object.keys(v).length === 1 && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else row[k] = copy(v);
  }
}

function prismaDouble() {
  const store = { tables: {}, writes: [], raw: [], transactions: 0, faults: [], seq: 0, handlers: [] };
  const fault = (model, op, label) => {
    const at = store.faults.findIndex(f => f.model === model && f.op === op && (!f.client || f.client === label));
    if (at >= 0) throw store.faults.splice(at, 1)[0].error;
  };
  const delegate = (ctx, name, label) => {
    const rows = () => (ctx.tables[name] ??= []);
    const wrote = op => store.writes.push({ client: label, model: name, op });
    const unique = row => {
      for (const keys of UNIQUE[name] ?? []) {
        if (keys.some(k => row[k] === null || row[k] === undefined)) continue;
        if (rows().some(other => keys.every(k => same(other[k], row[k]))))
          throw Object.assign(new Error(`Unique constraint failed on ${keys}`), { code: 'P2002', meta: { modelName: MODEL(name), target: keys } });
      }
    };
    const one = where => rows().find(row => matches(row, where));
    return {
      async findUnique({ where, select } = {}) { fault(name, 'findUnique', label); const row = one(where); return row ? pick(row, select) : null; },
      async findUniqueOrThrow(args) { const row = await this.findUnique(args); if (!row) throw Object.assign(new Error('missing'), { code: 'P2025' }); return row; },
      async findFirst({ where, orderBy, select } = {}) { const row = sorted(rows().filter(r => matches(r, where)), orderBy)[0]; return row ? pick(row, select) : null; },
      async findMany({ where, orderBy, select, take } = {}) {
        fault(name, 'findMany', label);
        const found = sorted(rows().filter(r => matches(r, where)), orderBy);
        return (take ? found.slice(0, take) : found).map(r => pick(r, select));
      },
      async count({ where } = {}) { return rows().filter(r => matches(r, where)).length; },
      async create({ data, select }) {
        fault(name, 'create', label);
        wrote('create');
        const row = { ...(AUTO_ID.has(name) ? { id: ++store.seq } : {}), ...(DEFAULTS[name]?.() ?? {}) };
        applyData(row, data);
        unique(row);
        rows().push(row);
        return pick(row, select);
      },
      async createMany({ data }) { for (const item of [].concat(data)) await this.create({ data: item }); return { count: [].concat(data).length }; },
      async update({ where, data, select }) {
        fault(name, 'update', label);
        wrote('update');
        const row = one(where);
        if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        applyData(row, data);
        return pick(row, select);
      },
      async updateMany({ where, data }) {
        fault(name, 'updateMany', label);
        wrote('updateMany');
        const hit = rows().filter(r => matches(r, where));
        hit.forEach(r => applyData(r, data));
        return { count: hit.length };
      },
      async upsert({ where, create, update, select }) {
        wrote('upsert');
        const row = one(where);
        if (row) { applyData(row, update); return pick(row, select); }
        return this.create({ data: create, select });
      },
      async delete({ where }) { wrote('delete'); const at = rows().findIndex(r => matches(r, where)); if (at < 0) throw Object.assign(new Error('missing'), { code: 'P2025' }); return rows().splice(at, 1)[0]; },
      async deleteMany({ where } = {}) { wrote('deleteMany'); const keep = rows().filter(r => !matches(r, where)), n = rows().length - keep.length; ctx.tables[name] = keep; return { count: n }; },
    };
  };
  const raw = (ctx, label) => async (strings, ...params) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    store.raw.push({ client: label, sql, params });
    fault('$raw', sql, label);
    for (const [pattern, answer] of [...store.handlers, ...BUILT_IN]) if (pattern.test(sql)) return answer(params, ctx.tables, label, store);
    throw new Error('double: unhandled SQL ' + sql);
  };
  const client = (ctx, label) => {
    const delegates = new Map();
    const target = {
      $executeRaw: raw(ctx, label), $queryRaw: raw(ctx, label),
      ...(label === 'root' ? { async $transaction(work, options) {
        if (typeof work !== 'function') throw new Error('double: batch transactions are not used by these concerns');
        store.transactions++;
        const scratch = { tables: copy(store.tables) };
        const out = await work(client(scratch, 'tx'), options);
        store.tables = scratch.tables;
        return out;
      } } : {}),
    };
    return new Proxy(target, { get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== 'string' || key === 'then' || key.startsWith('$')) return undefined;
      if (!delegates.has(key)) delegates.set(key, delegate(ctx, key, label));
      return delegates.get(key);
    } });
  };
  // the root client reads store.tables as it is now (a committed transaction replaces it)
  const rootCtx = { get tables() { return store.tables; }, set tables(v) { store.tables = v; } };
  const root = client(rootCtx, 'root');
  store.root = root;
  store.rows = name => (store.tables[name] ??= []);
  store.seed = (name, row) => { const full = { ...(AUTO_ID.has(name) ? { id: ++store.seq } : {}), ...(DEFAULTS[name]?.() ?? {}), ...row }; store.rows(name).push(full); return full; };
  store.writesBy = client => store.writes.filter(w => w.client === client);
  return store;
}
const BUILT_IN = [
  [/^SET LOCAL /, () => 0],
  [/pg_advisory_xact_lock/, () => [{ locked: 1 }]],
  [/^SELECT \* FROM "StudyState" WHERE uid ?= ?\? FOR (UPDATE|SHARE)$/, ([uid], t) => (t.studyState ?? []).filter(r => r.uid === uid).map(copy)],
  [/^SELECT "institutionId", "teleInstitutionId" FROM "StudyState" WHERE uid = \? FOR (SHARE|NO KEY UPDATE)$/,
    ([uid], t) => (t.studyState ?? []).filter(r => r.uid === uid).map(r => ({ institutionId: r.institutionId, teleInstitutionId: r.teleInstitutionId }))],
  [/FROM "AuthSession" WHERE sid = \? FOR KEY SHARE$/, ([sid], t) => (t.authSession ?? []).filter(r => r.sid === sid).map(() => ({ held: 1 }))],
  [/FROM "ReportDraft" WHERE uid = \? AND author = \? FOR UPDATE$/, ([uid, author], t) => (t.reportDraft ?? []).filter(r => r.uid === uid && r.author === author).map(copy)],
  [/FROM "ReportDraft" WHERE uid = \? AND present ORDER BY author FOR UPDATE$/,
    ([uid], t) => sorted((t.reportDraft ?? []).filter(r => r.uid === uid && r.present), { author: 'asc' }).map(copy)],
  [/FROM "Report" WHERE uid = \? FOR UPDATE$/, ([uid], t) => (t.report ?? []).filter(r => r.uid === uid)
    .map(r => ({ version: r.version, updatedBy: r.updatedBy ?? null, findings: r.findings, conclusion: r.conclusion, recommendation: r.recommendation }))],
  [/^SELECT octet_length\(convert_to\(\?::jsonb::text, 'UTF8'\)\) AS bytes$/, ([text]) => [{ bytes: Buffer.byteLength(String(text), 'utf8') }]],
  [/FROM "TechNoteRevision" n JOIN "StudyState" s/, () => []],
  [/FROM "ReportVersion" v JOIN "StudyState" s ON s.uid = v.uid WHERE v.action = 'approve'/, () => []],
  [/^SELECT a\.\* FROM "AuditLog" a LEFT JOIN "StudyState" s/, () => []],
  [/^SELECT s\.uid, s\."institutionId", s\."teleInstitutionId", s\.rs, s\."repDoc", s\.confirm, COALESCE\(r\.version, 0\) AS version, v\.action FROM "StudyState" s/,
    ([uids], t) => uids.values.map(uid => {
      const s = (t.studyState ?? []).find(r => r.uid === uid);
      if (!s) return null;
      const r = (t.report ?? []).find(x => x.uid === uid), v = r && (t.reportVersion ?? []).find(x => x.uid === uid && x.version === r.version);
      return { uid, institutionId: s.institutionId, teleInstitutionId: s.teleInstitutionId, rs: s.rs, repDoc: s.repDoc, confirm: s.confirm,
        version: r?.version ?? 0, action: v?.action ?? null };
    }).filter(Boolean)],
];

// ── the other value providers ──

function studyAccessDouble() {
  const sa = { denied: new Set(), restricted: false, calls: [], onPrepare: null,
    async snapshot(c, tx) { sa.calls.push(['snapshot', tx ? 'tx' : 'root']); return { revision: 1, windowOpen: true, policy: { restricted: sa.restricted, rules: [] } }; },
    async prepare(c, uids) { sa.calls.push(['prepare', uids ?? null]); if (sa.onPrepare) { const hook = sa.onPrepare; sa.onPrepare = null; await hook(); } },
    async require(c, uids, tx) { sa.calls.push(['require', uids, tx ? 'tx' : 'root']); if (uids.some(uid => sa.denied.has(uid))) throw new NotFoundException('검사를 찾을 수 없습니다'); },
    async allowed(c, uids) { return new Set(uids.filter(uid => !sa.denied.has(uid))); },
    matches(_snapshot, uid) { return !sa.denied.has(uid); },
    needsMetadata() { return false; },
    async unchanged(_c, previous) { return previous; },
  };
  return sa;
}
const qido = (uid, institutionName, extra = {}) => ({ '0020000D': { Value: [uid] }, '00080080': { Value: [institutionName] },
  '00100020': { Value: ['PID-' + uid.slice(-3)] }, '00100010': { Value: [{ Alphabetic: 'SYN^PATIENT' }] }, ...extra });
function orthancDouble() {
  const o = { rows: [], statistics: null,
    async studies() { return copy(o.rows); },
    async studyIdentities() { return copy(o.rows); },
    async studiesByUid(uids) { return copy(o.rows.filter(r => uids.includes(r['0020000D'].Value[0]))); },
    async get(path) { assert.equal(path, '/statistics'); if (o.statistics instanceof Error) throw o.statistics; return o.statistics; },
    async instanceStudyUid() { throw new Error('double: not used'); },
    async lookupInstance() { return []; },
  };
  return o;
}

const INST_A = 'syn-a', INST_B = 'syn-b';
const member = (name, institution, roles) => ({ kind: 'member', sub: 'syn-sub-' + name, actor: `syn-${name}@synthetic.test`, roles, institution });
const RAD_A = member('rad-a', INST_A, ['radiologist']), RAD_A2 = member('rad-a2', INST_A, ['radiologist']);
const TECH_A = member('tech-a', INST_A, ['technician']), ADMIN_A = member('admin-a', INST_A, ['admin']);
const RAD_B = member('rad-b', INST_B, ['radiologist']), TECH_B = member('tech-b', INST_B, ['technician']), ADMIN_B = member('admin-b', INST_B, ['admin']);
const CLIN_A = member('clin-a', INST_A, ['clinician']);
const GATEWAY_A = { kind: 'gateway', sub: 'syn-gw-a', actor: 'syn-gw-a', roles: ['gateway'], institution: INST_A };
const ownerOf = c => ({ institution: c.institution, sub: c.sub, author: c.actor });
let serial = 0;
const uidOf = () => `1.2.840.99999.${process.pid}.${++serial}`;

/** The concern graph as the facade composes it: every concern gets the one instance of each provider and of its suppliers. */
function world() {
  const db = prismaDouble(), sa = studyAccessDouble(), orthanc = orthancDouble();
  const keycloak = { roster: [], async usersInGroupWithRole() { return copy(keycloak.roster); } };
  const findings = { readable: new Set(), async readableFindings(_tx, _c, _uid, ids) { return ids.filter(id => findings.readable.has(id)).map(id => ({ id })); } };
  const prisma = db.root;
  const access = new PacsAccess(prisma, sa);
  const institutions = new PacsInstitutions(prisma, orthanc, keycloak, sa, access);
  const preferences = new PacsPreferences(prisma);
  const filters = new PacsFilters(prisma);
  const audit = new PacsAudit(prisma, sa, access);
  const metrics = new PacsMetrics(prisma, orthanc, sa, access);
  const worklist = new PacsWorklist(prisma, orthanc, sa, access, institutions, preferences, audit);
  const gateway = new PacsDicomGateway(prisma, orthanc, sa, access, institutions);
  const studyState = new PacsStudyState(prisma, sa, access, institutions, audit);
  const techNote = new PacsTechNote(prisma, sa, access);
  const hold = new PacsHold(prisma, sa, access);
  const clinician = new PacsClinician(prisma, sa, access, worklist);
  const evidence = new PacsReportEvidence(prisma, sa, findings, access);
  const draft = new PacsReportDraft(prisma, sa, access, audit, evidence);
  const commit = new PacsReportCommit(keycloak, sa, evidence, draft);
  const w = { db, sa, orthanc, keycloak, findings, access, institutions, preferences, filters, audit, metrics, worklist, gateway,
    studyState, techNote, hold, clinician, evidence, draft, commit };
  w.study = (fields = {}) => db.seed('studyState', { uid: uidOf(), institutionId: INST_A, ss: 'Verified', ...fields });
  w.audits = (action) => db.rows('auditLog').filter(row => !action || row.action === action);
  /** Starts the institutions concern as the facade's onModuleInit does: two synthetic institutions beside the seeds. */
  w.boot = async () => {
    db.seed('institution', { id: INST_A, name: 'SYN A', type: 'hospital', dicomNames: 'SYN A HOSPITAL' });
    db.seed('institution', { id: INST_B, name: 'SYN B', type: 'center', dicomNames: 'SYN B CENTER' });
    const log = console.log; console.log = () => {};
    try { await institutions.onModuleInit(); } finally { console.log = log; }
  };
  return w;
}

async function refused(work, status, code) {
  let error = null;
  try { await work(); } catch (e) { error = e; }
  assert.ok(error, `expected a ${status} refusal, the call succeeded`);
  assert.ok(error instanceof HttpException, `expected an HTTP refusal, got ${error?.stack ?? error}`);
  assert.equal(error.getStatus(), status, JSON.stringify(error.getResponse()));
  if (code !== undefined) assert.equal(error.getResponse()?.code, code, JSON.stringify(error.getResponse()));
  return error.getResponse();
}
const draftBody = (c, epoch, revision, text = {}) => ({ expectedOwner: ownerOf(c), expectedRevision: `${epoch}:${revision}`,
  findings: '', conclusion: '', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [], ...text });
const commitBody = (c, action, epoch, revision, baseVersion, text = {}) => ({ action, expectedOwner: ownerOf(c),
  expectedRevision: `${epoch}:${revision}`, baseVersion, citationIds: [], removeCitationIds: [], structureIds: [],
  findings: '', conclusion: '', recommendation: '', ...text });

// ── SPLIT-01 construction ──

test('SPLIT-01 every concern is built from references alone: constructing touches no provider, opens no timer and seeds nothing', () => {
  const touched = [];
  const trap = name => new Proxy({}, { get(_t, key) { touched.push(`${name}.${String(key)}`); throw new Error(`${name} touched while constructing`); } });
  const timers = process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length;
  const [prisma, orthanc, keycloak, sa, findings] = ['prisma', 'orthanc', 'keycloak', 'studyAccess', 'findings'].map(trap);
  const access = new PacsAccess(prisma, sa);
  const institutions = new PacsInstitutions(prisma, orthanc, keycloak, sa, access);
  const preferences = new PacsPreferences(prisma);
  const audit = new PacsAudit(prisma, sa, access);
  const worklist = new PacsWorklist(prisma, orthanc, sa, access, institutions, preferences, audit);
  const evidence = new PacsReportEvidence(prisma, sa, findings, access);
  const draft = new PacsReportDraft(prisma, sa, access, audit, evidence);
  new PacsFilters(prisma); new PacsMetrics(prisma, orthanc, sa, access); new PacsDicomGateway(prisma, orthanc, sa, access, institutions);
  new PacsStudyState(prisma, sa, access, institutions, audit); new PacsTechNote(prisma, sa, access); new PacsHold(prisma, sa, access);
  new PacsClinician(prisma, sa, access, worklist); new PacsReportCommit(keycloak, sa, evidence, draft);
  assert.deepEqual(touched, []);
  assert.equal(process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length, timers);
  // the institution cache is empty until the facade's onModuleInit starts it
  assert.equal(institutions.instName(INST_A), '(미배정)');
  assert.equal(institutions.resolveInstitution('SYN A HOSPITAL'), null);
});

// ── SPLIT-02 values ──

test('SPLIT-02 QIDO counts keep unknown apart from zero, and a hold lives five minutes', () => {
  const tag = value => ({ '00201208': { Value: [value] } });
  assert.equal(values.qidoCount({}, '00201208'), null);
  assert.equal(values.qidoCount(tag(''), '00201208'), null);
  for (const bad of ['-1', '1.5', '1e3', 'x', ' ', null]) assert.equal(values.qidoCount(tag(bad), '00201208'), null, String(bad));
  assert.equal(values.qidoCount(tag('0'), '00201208'), 0);
  assert.equal(values.qidoCount(tag(' 12 '), '00201208'), 12);
  assert.equal(values.qidoCount(tag('+3'), '00201208'), 3);
  assert.equal(values.qidoCount(tag(7), '00201208'), 7);
  const at = ms => ({ holder: 'x', heldAt: new Date(Date.now() - ms) });
  assert.ok(values.holdAlive(at(4 * 60_000 + 59_000)));
  assert.ok(!values.holdAlive(at(5 * 60_000 + 1_000)));
  assert.ok(!values.holdAlive({ holder: null, heldAt: new Date() }));
  // a cleared value is sent as null, never left out, and another reader's draft never rides along
  const state = values.toClient({ rs: 'W', draftEpoch: randomUUID(), holder: 'gone', heldAt: new Date(Date.now() - 6 * 60_000) }, null, RAD_A, null);
  for (const key of ['holder', 'preDoc', 'repDoc', 'confirm', 'ov', 'orig', 'oid', 'draft', 'institutionId']) assert.equal(state[key], null, key);
});

// ── SPLIT-03 roles, institution, gateway identity ──

test('SPLIT-03 roles and identity: need admits the role or admin, gateway routes admit only the gateway identity, an account needs an institution', async () => {
  assert.doesNotThrow(() => need(RAD_A.roles, 'radiologist', 'x'));
  assert.doesNotThrow(() => need(ADMIN_A.roles, 'radiologist', 'x'));
  await refused(() => need(TECH_A.roles, 'radiologist', '판독문 확정'), 403);
  assert.doesNotThrow(() => needExact(GATEWAY_A, 'gateway', 'x'));
  await refused(() => needExact({ ...ADMIN_A, roles: ['admin', 'gateway'] }, 'gateway', 'x'), 403);
  assert.equal(inst(RAD_A), INST_A);
  await refused(() => inst({ ...ADMIN_A, institution: null }), 403);
});

// ── SPLIT-04 tenant boundary (M01, M03b) ──

test('SPLIT-04 a study is reachable by its owner and its tele receiver only; admin of another institution gets the same 404 as a stranger', async () => {
  const w = world();
  const own = w.study(), tele = w.study({ teleInstitutionId: INST_B });
  assert.equal((await w.access.gate(own.uid, RAD_A)).uid, own.uid);
  assert.equal((await w.access.gate(tele.uid, RAD_B)).uid, tele.uid, 'the tele receiver reaches the study');
  for (const c of [RAD_B, ADMIN_B]) await refused(() => w.access.gate(own.uid, c), 404);
  assert.equal(await w.access.gate('1.2.3.404', RAD_A), null, 'an unknown study is answered as absent by gate');
  w.sa.denied.add(own.uid);
  await refused(() => w.access.gate(own.uid, RAD_A), 404);
  // the same boundary on reads built on it: history, audit trail, hold
  w.sa.denied.clear();
  await refused(() => w.evidence.versions(own.uid, ADMIN_B), 404);
  await refused(() => w.audit.audits(own.uid, 10, ADMIN_B), 404);
  await refused(() => w.hold.forceRelease(own.uid, ADMIN_B), 404);
  assert.deepEqual(await w.hold.hold(tele.uid, RAD_B), { holder: RAD_B.actor, mine: true, conflict: false });
});

// ── SPLIT-05 the write gate re-checks inside the transaction (M03) ──

test('SPLIT-05 access withdrawn between preparation and the transaction refuses the write; the write and its audit row roll back together', async () => {
  const w = world();
  const s = w.study();
  w.sa.onPrepare = async () => { w.sa.denied.add(s.uid); };
  await refused(() => w.hold.hold(s.uid, RAD_A), 404);
  assert.equal(w.db.rows('studyState')[0].holder, null);
  assert.equal(w.audits().length, 0);
  // scopeWrite: same refusal, then a failing audit row takes the state write back with it
  w.sa.denied.clear();
  w.sa.onPrepare = async () => { w.sa.denied.add(s.uid); };
  await refused(() => w.studyState.patchState(s.uid, { em: 'E' }, TECH_A), 404);
  w.sa.denied.clear();
  const boom = new Error('audit store down');
  w.db.faults.push({ model: 'auditLog', op: 'create', client: 'tx', error: boom });
  await assert.rejects(() => w.studyState.patchState(s.uid, { em: 'E' }, TECH_A), error => error === boom);
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).em, 'N');
  const saved = await w.studyState.patchState(s.uid, { em: 'E' }, TECH_A);
  assert.equal(saved.em, 'E');
  assert.deepEqual(w.audits().map(a => a.action), ['state.patch']);
  assert.deepEqual(w.db.writesBy('root'), [], 'every write went through the transaction');
});

// ── SPLIT-06 PATCH cannot touch the report lifecycle; tele transitions keep their owners (M07) ──

test('SPLIT-06 PATCH refuses report-owned fields without writing anything; technician fields need the technician role and the owning institution', async () => {
  const w = world();
  await w.boot();
  const s = w.study(), booted = w.db.writes.length;
  const since = () => w.db.writes.slice(booted);
  for (const field of ['rs', 'repDoc', 'confirm', 'matched', 'orig', 'holdReason']) {
    await refused(() => w.studyState.patchState(s.uid, { [field]: 'A', ss: 'Verified', em: 'E' }, TECH_A), 400);
  }
  assert.deepEqual(since(), []);
  assert.equal(w.db.rows('studyState').find(r => r.uid === s.uid).em, 'N');
  await refused(() => w.studyState.patchState(s.uid, { ss: 'Verified' }, RAD_A), 403);
  const tele = w.study({ teleInstitutionId: INST_B, ts: 'sent' });
  await refused(() => w.studyState.patchState(tele.uid, { em: 'E' }, TECH_B), 403);
  assert.deepEqual(since(), []);
  // the owner requests tele reading to B, then cancels it: the channel closes and B's reader assignment closes with it
  const out = await w.studyState.patchState(s.uid, { ts: 'wait', teleTo: INST_B }, RAD_A);
  assert.equal(out.teleInstitutionId, INST_B);
  w.db.seed('readerAssignment', { studyUid: s.uid, institutionId: INST_B, revision: 1, readerSub: RAD_B.sub, readerActor: RAD_B.actor, readerName: 'B' });
  await refused(() => w.studyState.patchState(s.uid, { ts: 'wait', teleTo: 'nowhere' }, RAD_A), 400);
  const cancelled = await w.studyState.patchState(s.uid, { ts: 'cancelled' }, RAD_A);
  assert.equal(cancelled.teleInstitutionId, null);
  const assignment = w.db.rows('readerAssignment')[0];
  assert.ok(assignment.closedAt instanceof Date);
  assert.equal(assignment.readerSub, null);
  assert.deepEqual(w.audits().map(a => a.action), ['state.patch', 'reader.assignment', 'state.patch']);
});

// ── SPLIT-07 commit: append-only history, the approved report's two exits, the role (M02, M04, M06) ──

test('SPLIT-07 commit appends one version per decision; an approved report leaves only by addendum or reset; a technician cannot commit', async () => {
  const w = world();
  const s = w.study();
  const epoch = s.draftEpoch;
  await refused(() => w.commit.commitReport(s.uid, commitBody(TECH_A, 'save', epoch, 0, 0, { findings: 't' }), TECH_A, null), 403);
  assert.deepEqual([w.db.transactions, w.db.writes.length], [0, 0], 'the refused caller opened no transaction and wrote nothing');

  const saved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', epoch, 0, 0, { findings: 'first text' }), RAD_A, null);
  assert.equal(saved.state.rs, 'T');
  const approved = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 1, 1, { findings: 'second text' }), RAD_A, null);
  assert.equal(approved.state.rs, 'A');
  assert.equal(approved.state.repDoc, RAD_A.actor.split('@')[0]);
  const history = () => w.db.rows('reportVersion').filter(v => v.uid === s.uid).map(v => [v.version, v.action, v.findings]);
  assert.deepEqual(history(), [[1, 'save', 'first text'], [2, 'approve', 'second text']]);

  for (const action of ['approve', 'save']) {
    await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, action, epoch, 0, 2, { findings: 'quiet change' }), RAD_A2, null), 400);
  }
  assert.deepEqual(history(), [[1, 'save', 'first text'], [2, 'approve', 'second text']]);
  assert.equal(w.db.rows('studyState')[0].rs, 'A');
  const addendum = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'addendum', epoch, 0, 2, { findings: 'second text + addendum' }), RAD_A2, null);
  assert.equal(addendum.state.rs, 'A');
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'reset', epoch, 2, 3), RAD_A, null), 400);
  const reset = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'reset', epoch, 2, 3, { reason: 'wrong patient' }), RAD_A, null);
  assert.equal(reset.state.rs, 'W');
  assert.deepEqual(history(), [[1, 'save', 'first text'], [2, 'approve', 'second text'], [3, 'addendum', 'second text + addendum'],
    [4, 'discarded', 'second text + addendum'], [5, 'reset', '']]);
  assert.deepEqual(w.audits().map(a => a.action), ['report.save', 'report.approve', 'report.addendum', 'report.reset']);
  assert.deepEqual(w.db.writesBy('root'), []);
});

// ── SPLIT-08 Preliminary: only the designated senior approves (M05) ──

test('SPLIT-08 a preliminary report is approved by its designated senior only; its author cannot approve it, and a save keeps it preliminary', async () => {
  const w = world();
  const s = w.study({ rs: 'P', preDoc: RAD_A.actor, preDocSub: RAD_A.sub, preReviewer: RAD_A2.actor, preReviewerSub: RAD_A2.sub });
  w.db.seed('report', { uid: s.uid, findings: 'prelim', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'preliminary', findings: 'prelim', conclusion: '', recommendation: '', author: RAD_A.actor });
  const epoch = s.draftEpoch;
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A, 'approve', epoch, 0, 1, { findings: 'self' }), RAD_A, null), 403);
  assert.equal(w.db.rows('reportVersion').length, 1);
  const kept = await w.commit.commitReport(s.uid, commitBody(RAD_A, 'save', epoch, 0, 1, { findings: 'prelim 2' }), RAD_A, null);
  assert.equal(kept.state.rs, 'P');
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_B, 'approve', epoch, 0, 2), RAD_B, null), 404);
  const done = await w.commit.commitReport(s.uid, commitBody(RAD_A2, 'approve', epoch, 0, 2, { findings: 'final' }), RAD_A2, null);
  assert.equal(done.state.rs, 'A');
  assert.deepEqual(w.db.rows('reportVersion').map(v => v.action), ['preliminary', 'save', 'approve']);
});

// ── SPLIT-09 the draft boundary: owner, epoch, revision, session, one transaction (M08, M09, M10) ──

test('SPLIT-09 a draft write is kept only on the boundary it saw, under a live session, inside one transaction with its audit row', async () => {
  const w = world();
  const s = w.study();
  w.db.seed('authSession', { sid: 'sid-a', sub: RAD_A.sub });
  const epoch = s.draftEpoch;
  const mine = () => w.db.rows('reportDraft').find(r => r.uid === s.uid && r.author === RAD_A.actor);
  const first = await w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 0, { findings: 'kept text' }), RAD_A, 'sid-a');
  assert.deepEqual([first.revision, first.present, first.snapshot.findings], [`${epoch}:1`, true, 'kept text']);
  assert.deepEqual(w.audits().map(a => a.action), ['report.draft']);
  assert.deepEqual(w.db.writesBy('root'), [], 'the draft and its audit row went through the transaction');

  // a late write that saw revision 0, a write on another epoch, a write for another owner: refused, nothing changes
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 0, { findings: 'late' }), RAD_A, 'sid-a'), 409, 'REPORT_DRAFT_CONFLICT');
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, randomUUID(), 1, { findings: 'old epoch' }), RAD_A, 'sid-a'), 409, 'REPORT_DRAFT_CONFLICT');
  await refused(() => w.draft.putReport(s.uid, { ...draftBody(RAD_A, epoch, 1, { findings: 'x' }), expectedOwner: ownerOf(RAD_A2) }, RAD_A, 'sid-a'), 409, 'REPORT_DRAFT_OWNER_CHANGED');
  // an ended session writes nothing
  await refused(() => w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 1, { findings: 'after logout' }), RAD_A, 'sid-ended'), 401, 'AUTH_SESSION_ENDED');
  // a failing audit row takes the draft write back with it
  const boom = new Error('audit store down');
  w.db.faults.push({ model: 'auditLog', op: 'create', client: 'tx', error: boom });
  await assert.rejects(() => w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 1, { findings: 'lost?' }), RAD_A, 'sid-a'), error => error === boom);
  assert.deepEqual([mine().revision, mine().findings, mine().present], [1, 'kept text', true]);
  assert.deepEqual(w.audits().map(a => a.action), ['report.draft']);
  assert.deepEqual(w.db.writesBy('root'), []);

  // another radiologist's draft is a row of its own; neither answer carries the other's text
  const other = await w.draft.putReport(s.uid, draftBody(RAD_A2, epoch, 0, { findings: 'other text' }), RAD_A2, null);
  assert.equal(other.snapshot.findings, 'other text');
  const read = await w.draft.readDraft(s.uid, RAD_A);
  assert.deepEqual([read.revision, read.snapshot.findings], [`${epoch}:1`, 'kept text']);
  // the boundary moves on: a write on revision 1 is kept and a discard clears the row but keeps its revision
  const second = await w.draft.putReport(s.uid, draftBody(RAD_A, epoch, 1, { findings: 'second' }), RAD_A, 'sid-a');
  assert.equal(second.revision, `${epoch}:2`);
  const discarded = await w.draft.discardDraft(s.uid, { expectedOwner: ownerOf(RAD_A), expectedRevision: `${epoch}:2` }, RAD_A, 'sid-a');
  assert.deepEqual([discarded.revision, discarded.present, discarded.state.draft], [`${epoch}:3`, false, null]);
  assert.equal(mine().revision, 3);
});

// ── SPLIT-10 the administrator's forced discard ──

test('SPLIT-10 a forced discard is administrator-only, keeps every present draft as a discarded version by its author and rotates the epoch', async () => {
  const w = world();
  const s = w.study();
  w.db.seed('reportDraft', { uid: s.uid, author: RAD_A.actor, findings: 'a text', conclusion: '', recommendation: '', baseVersion: 0, revision: 2, present: true });
  w.db.seed('reportDraft', { uid: s.uid, author: RAD_A2.actor, findings: 'b text', conclusion: '', recommendation: '', baseVersion: 0, revision: 1, present: true });
  await refused(() => w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(RAD_A), expectedEpoch: s.draftEpoch }, RAD_A, null), 403);
  const out = await w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null);
  assert.deepEqual([out.count, out.versions], [2, [1, 2]]);
  assert.notEqual(out.epoch, s.draftEpoch);
  const byAuthor = rows => rows.sort((x, y) => (x[1] < y[1] ? -1 : 1));
  assert.deepEqual(byAuthor(w.db.rows('reportVersion').map(v => [v.action, v.author, v.findings])),
    byAuthor([['discarded', RAD_A.actor, 'a text'], ['discarded', RAD_A2.actor, 'b text']]));
  assert.deepEqual(w.db.rows('reportDraft').map(d => [d.present, d.revision]), [[false, 3], [false, 2]]);
  assert.deepEqual(w.audits().map(a => a.action), ['report.draft.force-discard']);
  await refused(() => w.draft.forceDiscardDrafts(s.uid, { expectedOwner: ownerOf(ADMIN_A), expectedEpoch: s.draftEpoch }, ADMIN_A, null), 409, 'REPORT_DRAFT_CONFLICT');
});

// ── SPLIT-11 hold (M11, M12) ──

test('SPLIT-11 a live hold of another reader is reported, never overwritten; an expired one is taken over; forced release is audited', async () => {
  const w = world();
  const s = w.study();
  const row = () => w.db.rows('studyState').find(r => r.uid === s.uid);
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A), { holder: RAD_A.actor, mine: true, conflict: false });
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A), { holder: RAD_A.actor, mine: true, conflict: false }, 'heartbeat');
  assert.equal(w.audits('report.hold').length, 1, 'a heartbeat of a live hold is not a new hold');
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: RAD_A.actor, mine: false, conflict: true });
  assert.equal(row().holder, RAD_A.actor);
  // the commit of the other reader is refused while the hold lives
  await refused(() => w.commit.commitReport(s.uid, commitBody(RAD_A2, 'save', s.draftEpoch, 0, 0, { findings: 'x' }), RAD_A2, null), 409, 'REPORT_HELD');
  w.db.tables.studyState.find(r => r.uid === s.uid).heldAt = new Date(Date.now() - (4 * 60_000 + 50_000));
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: RAD_A.actor, mine: false, conflict: true }, 'still alive just under five minutes');
  w.db.tables.studyState.find(r => r.uid === s.uid).heldAt = new Date(Date.now() - (5 * 60_000 + 1_000));
  assert.deepEqual(await w.hold.hold(s.uid, RAD_A2), { holder: RAD_A2.actor, mine: true, conflict: false });
  assert.equal(w.audits('report.hold').length, 2);
  await refused(() => w.hold.hold(s.uid, TECH_A), 403);
  // release: only the holder's own hold is released
  assert.deepEqual(await w.hold.release(s.uid, RAD_A), { ok: true });
  assert.equal(row().holder, RAD_A2.actor);
  // forced release: administrator only, one audit row in the same transaction
  await refused(() => w.hold.forceRelease(s.uid, RAD_A), 403);
  assert.deepEqual(await w.hold.forceRelease(s.uid, ADMIN_A), { ok: true, released: RAD_A2.actor });
  assert.equal(row().holder, null);
  const [forced] = w.audits('hold.force-release');
  assert.deepEqual(JSON.parse(forced.detail).by, INST_A);
  assert.deepEqual([JSON.parse(forced.detail).holder, JSON.parse(forced.detail).alive], [RAD_A2.actor, true]);
  assert.deepEqual(w.db.writesBy('root'), []);
});

// ── SPLIT-12 worklist: the institution boundary of the list and the boot bundle (M13, M14) ──

test('SPLIT-12 the list and the boot bundle carry own and tele-received studies only; first sight registers a study; unknown counts stay unknown', async () => {
  const w = world();
  await w.boot();
  const own = w.study(), foreign = w.study({ institutionId: INST_B }), tele = w.study({ institutionId: INST_B, teleInstitutionId: INST_A });
  const fresh = uidOf(), unknown = uidOf();
  w.orthanc.rows = [qido(own.uid, 'SYN A HOSPITAL'), qido(foreign.uid, 'SYN B CENTER'), qido(tele.uid, 'SYN B CENTER'),
    qido(fresh, 'syn a hospital', { '00201208': { Value: ['4'] } }), qido(unknown, 'NOBODY')];
  const list = await w.worklist.listStudies(RAD_A);
  assert.deepEqual(list.studies.map(r => r.uid).sort(), [own.uid, tele.uid, fresh].sort());
  const byUid = Object.fromEntries(list.studies.map(r => [r.uid, r]));
  assert.deepEqual([byUid[own.uid].count, byUid[fresh].count], [null, 4]);
  assert.deepEqual([byUid[tele.uid].tele, byUid[own.uid].tele], [true, false]);
  assert.equal(byUid[own.uid].institutionName, 'SYN A');
  assert.deepEqual(w.db.rows('studyState').filter(r => [fresh, unknown].includes(r.uid)).map(r => [r.uid, r.institutionId, r.ss]),
    [[fresh, INST_A, 'Unverified'], [unknown, null, 'Unverified']]);
  assert.deepEqual(w.audits('study.arrived').map(a => a.target).sort(), [fresh, unknown].sort());
  const boot = await w.worklist.bootstrap(RAD_A);
  assert.deepEqual(Object.keys(boot.states).sort(), [own.uid, tele.uid, fresh].sort());
  assert.deepEqual([boot.me.institution, boot.me.institutionName], [INST_A, 'SYN A']);
  assert.ok(boot.institutions.some(i => i.id === INST_B), 'the boot bundle lists the cached institutions');
  const other = await w.worklist.bootstrap(RAD_B);
  assert.deepEqual(Object.keys(other.states).sort(), [foreign.uid, tele.uid].sort());
});

// ── SPLIT-13 institutions: one cache, the seed at start, the orphan path ──

test('SPLIT-13 one institution cache serves every concern; unknown DICOM names stay unassigned; an orphan is assigned once, by an administrator', async () => {
  const w = world();
  await w.boot();
  assert.equal(w.institutions.resolveInstitution(' syn b center '), INST_B);
  assert.equal(w.institutions.resolveInstitution('nobody'), null);
  assert.equal(w.institutions.institutionName(null), '(미배정)');
  assert.ok(w.db.rows('order').length > 0, 'the order seed ran at start');
  // a reload is seen by the other concerns reading the cache (tele target check of PATCH)
  w.db.seed('institution', { id: 'syn-c', name: 'SYN C', type: 'center', dicomNames: '' });
  const s = w.study();
  await refused(() => w.studyState.patchState(s.uid, { ts: 'wait', teleTo: 'syn-c' }, RAD_A), 400);
  const log = console.log; console.log = () => {};
  try { await w.institutions.onModuleInit(); } finally { console.log = log; }
  assert.equal((await w.studyState.patchState(s.uid, { ts: 'wait', teleTo: 'syn-c' }, RAD_A)).teleInstitutionId, 'syn-c');
  const orphan = w.study({ institutionId: null });
  await refused(() => w.institutions.assignInstitution(orphan.uid, INST_A, RAD_A), 403);
  const assigned = await w.institutions.assignInstitution(orphan.uid, INST_A, ADMIN_A);
  assert.deepEqual([assigned.institutionId, assigned.reqHosp], [INST_A, 'SYN A']);
  await refused(() => w.institutions.assignInstitution(orphan.uid, INST_B, ADMIN_A), 400);
  assert.deepEqual(w.audits('study.assign').map(a => a.target), [orphan.uid]);
});

// ── SPLIT-14 evidence: readability of citations and the CHECK backstop (M16, M17) ──

test('SPLIT-14 a citation is shown only while its finding is readable; a database CHECK on citations or structure becomes its named 409', async () => {
  const w = world();
  const s = w.study({ rs: 'A' });
  const entry = (cid, findingId, text) => ({ v: 1, cid, field: 'findings', findingId, findingRevision: 1, sourceIndex: 0,
    sourceRef: {}, linkStateAtInsert: 'current', headRevisionAtInsert: 1, insertedText: text, insertedAt: '2026-10-01T00:00:00.000Z', insertedBy: RAD_A.actor });
  w.db.seed('report', { uid: s.uid, findings: 'line one\nline two', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'approve', findings: 'line one\nline two', conclusion: '', recommendation: '',
    author: RAD_A.actor, citations: [entry('c-1', 'f-readable', 'line one'), entry('c-2', 'f-hidden', 'line two')] });
  w.findings.readable.add('f-readable');
  const read = await w.evidence.reportCitations(s.uid, RAD_A);
  assert.equal(read.head.length, 2);
  assert.equal(read.head[0].insertedText, 'line one');
  assert.deepEqual(read.head[1], { cid: 'c-2', field: 'findings', insertedAt: '2026-10-01T00:00:00.000Z', insertedBy: RAD_A.actor, state: 'source-unavailable' });
  w.findings.readable.clear();
  const past = await w.evidence.reportVersionCitations(s.uid, '1', RAD_A);
  assert.ok(past.entries.every(e => e.state === 'source-unavailable' && !('presence' in e)));

  const check = name => Object.assign(new Error('violates check constraint'), { code: 'P2010', meta: { constraint: name } });
  await refused(() => w.evidence.reportLimitChecked(async () => { throw check('ReportDraft_citations_check'); }), 409, 'REPORT_CITATION_LIMIT');
  await refused(() => w.evidence.reportLimitChecked(async () => { throw check('ReportVersion_structured_check'); }), 409, 'REPORT_STRUCTURE_LIMIT');
  const other = check('Some_other_check');
  await assert.rejects(() => w.evidence.reportLimitChecked(async () => { throw other; }), error => error === other);
  assert.equal(await w.evidence.reportLimitChecked(async () => 'ok'), 'ok');
});

// ── SPLIT-15 the structure catalog gate (M18) ──

test('SPLIT-15 the structure catalog is replaced only by a list that passes the gate; a refused list leaves the previous one standing', () => {
  const w = world();
  // The catalog's own replacement path (P7/P12) is the protected accessor; a subclass reaches it as the product's tests do.
  class Seam extends PacsReportEvidence { set(next) { this.structureCatalog = next; } get current() { return this.structureCatalog; } }
  const seam = new Seam(w.db.root, w.sa, w.findings, w.access);
  assert.equal(seam.current, STRUCTURE_CATALOG);
  const broken = [STRUCTURE_CATALOG[0], STRUCTURE_CATALOG[0]];   // the same templateId twice
  assert.throws(() => seam.set(broken));
  assert.equal(seam.current, STRUCTURE_CATALOG);
  seam.set([]);
  assert.deepEqual(seam.current, []);
  assert.throws(() => seam.set(broken));
  assert.deepEqual(seam.current, []);
});

// ── SPLIT-16 clinician reads ──

test('SPLIT-16 the clinician list is the worklist narrowed; a report state that moved after the list was read refuses the whole answer', async () => {
  const w = world();
  await w.boot();
  const s = w.study({ rs: 'A', repDoc: 'syn-rad-a', confirm: '2026-10-01' });
  w.db.seed('report', { uid: s.uid, findings: 'final', conclusion: '', recommendation: '', version: 1, updatedBy: RAD_A.actor });
  w.db.seed('reportVersion', { uid: s.uid, version: 1, action: 'approve', findings: 'final', conclusion: '', recommendation: '', author: RAD_A.actor });
  w.orthanc.rows = [qido(s.uid, 'SYN A HOSPITAL')];
  await refused(() => w.clinician.clinicianStudies(RAD_A), 403);
  const list = await w.clinician.clinicianStudies(CLIN_A);
  assert.deepEqual(list.studies.map(r => r.uid), [s.uid]);
  const read = await w.clinician.clinicianReportRead(s.uid, CLIN_A);
  assert.equal(read.report.final, true);
  assert.equal(await w.clinician.clinicianViewerHead(s.uid, CLIN_A), 1);
  // an addendum by another signer lands between the list and its snapshot statement
  w.db.handlers.push([/^SELECT s\.uid, s\."institutionId"/, (params, tables) => {
    w.db.handlers.pop();
    const state = tables.studyState.find(r => r.uid === s.uid), report = tables.report.find(r => r.uid === s.uid);
    state.repDoc = 'syn-rad-a2'; report.version = 2;
    tables.reportVersion.push({ uid: s.uid, version: 2, action: 'addendum' });
    return [{ uid: s.uid, institutionId: INST_A, teleInstitutionId: null, rs: 'A', repDoc: 'syn-rad-a2', confirm: '2026-10-01', version: 2, action: 'addendum' }];
  }]);
  await refused(() => w.clinician.clinicianStudies(CLIN_A), 409, 'STUDY_LIST_CHANGED');
  const foreign = w.study({ institutionId: INST_B, rs: 'A' });
  await refused(() => w.clinician.clinicianReportRead(foreign.uid, CLIN_A), 404);
});

// ── SPLIT-17 Tech Note attempts (M19, M20) ──

test('SPLIT-17 a Tech Note attempt sent again answers its revision without a second revision or audit row; permission is judged before the attempt id', async () => {
  const w = world();
  const s = w.study();
  const attemptId = randomUUID();
  const body = { baseVersion: 0, text: 'contrast given', reason: '', attemptId };
  const first = await w.techNote.saveTechNote(s.uid, body, TECH_A);
  assert.deepEqual([first.note.version, first.note.isOwnAttempt, first.writable], [1, true, true]);
  const again = await w.techNote.saveTechNote(s.uid, { ...body }, TECH_A);
  assert.deepEqual([again.note.version, again.note.text, again.latestNote.version], [1, 'contrast given', 1]);
  assert.equal(w.db.rows('techNoteRevision').length, 1);
  assert.equal(w.audits('tech-note.revise').length, 1);
  // the id of that attempt used for another request is refused without showing the earlier revision
  const reused = await refused(() => w.techNote.saveTechNote(s.uid, { ...body, text: 'different text' }, TECH_A), 400);
  assert.ok(!JSON.stringify(reused).includes('contrast given'));
  // callers without the write permission are refused for their permission, whatever the attempt id names
  await refused(() => w.techNote.saveTechNote(s.uid, { ...body }, RAD_A), 403);
  await refused(() => w.techNote.saveTechNote(s.uid, { ...body }, TECH_B), 404);
  const tele = w.study({ teleInstitutionId: INST_B });
  await refused(() => w.techNote.saveTechNote(tele.uid, { baseVersion: 0, text: 'x', reason: '', attemptId: randomUUID() }, TECH_B), 403);
  assert.equal(w.db.rows('techNoteRevision').length, 1);
  assert.equal(w.audits('tech-note.revise').length, 1);
  const history = await w.techNote.techNote(s.uid, RAD_A);
  assert.deepEqual([history.note.version, history.note.isOwnAttempt, history.writable], [1, false, false]);
});

// ── SPLIT-18 gateway: identity and idempotent requests ──

test('SPLIT-18 Gateway surfaces admit only the gateway identity; a repeated announce or retry request writes and audits once', async () => {
  const w = world();
  await w.boot();
  const uid = uidOf();
  await refused(() => w.gateway.announceStudy(uid, 'SYN A HOSPITAL', ADMIN_A), 403);
  const first = await w.gateway.announceStudy(uid, 'SYN A HOSPITAL', GATEWAY_A);
  const again = await w.gateway.announceStudy(uid, 'SYN A HOSPITAL', GATEWAY_A);
  assert.deepEqual([first, again].map(a => [a.institutionId, a.origin]), [[INST_A, 'gateway'], [INST_A, 'gateway']]);
  assert.equal(w.audits('study.announce').length, 1);
  await refused(() => w.gateway.announceStudy(uid, '', { ...GATEWAY_A, institution: INST_B }), 409, 'STUDY_OWNERSHIP_CONFLICT');
  const epoch = randomUUID();
  w.db.seed('gatewayReceipt', { studyUid: uid, institutionId: INST_A, epoch, seq: 5n, phase: 'retry' });
  await refused(() => w.gateway.requestGatewayRetry(uid, {}, RAD_A), 403);
  await refused(() => w.gateway.requestGatewayRetry(uid, {}, TECH_B), 404);
  const asked = await w.gateway.requestGatewayRetry(uid, {}, TECH_A);
  const repeated = await w.gateway.requestGatewayRetry(uid, {}, TECH_A);
  assert.deepEqual([asked.result, repeated.result, repeated.requestedAt], ['requested', 'already_requested', asked.requestedAt]);
  assert.equal(w.db.rows('gatewayRetryRequest').length, 1);
  assert.equal(w.audits('gateway.retry.request').length, 1);
});

// ── SPLIT-19 preferences and searches: the CAS writes ──

test('SPLIT-19 account settings and shared searches: a write on a stale revision is a conflict; publishing institution searches is administrator-only', async () => {
  const w = world();
  const owner = [INST_A, RAD_A.sub];
  const saved = await w.preferences.saveReadingPreferences({ autoNote: true, expectedOwner: owner, revision: 0 }, RAD_A);
  assert.deepEqual([saved.revision, saved.autoNote], [1, true]);
  await refused(() => w.preferences.saveReadingPreferences({ autoNote: false, expectedOwner: owner, revision: 0 }, RAD_A), 409);
  await refused(() => w.preferences.saveReadingPreferences({ autoNote: false, expectedOwner: [INST_B, RAD_A.sub], revision: 1 }, RAD_A), 409);
  assert.deepEqual(await w.preferences.readingPreferences(RAD_A), { owner, revision: 1, autoNote: true });
  await refused(() => w.preferences.readingPreferences(CLIN_A), 403);
  await refused(() => w.filters.writeSharedFilters({ command: { action: 'create-folder', path: 'x' }, expectedOwner: owner, revision: 0 }, RAD_A), 403);
  assert.equal(w.db.writes.filter(x => x.model === 'sharedFilterLibrary').length, 0);
});

// ── SPLIT-20 operations metrics and the audit trail ──

test('SPLIT-20 metrics are administrator-only and refused to a restricted account; an unobservable source is never a zero', async () => {
  const w = world();
  w.study();
  w.orthanc.statistics = { TotalDiskSize: '123456' };
  await refused(() => w.metrics.adminMetrics(RAD_A), 403);
  const shown = await w.metrics.adminMetrics(ADMIN_A);
  const row = key => shown.metrics.find(m => m.key === key);
  assert.deepEqual([row('storage.server').state, row('storage.server').value], ['observed', 123456]);
  assert.equal(row('studies.own').value, 1);
  w.orthanc.statistics = new Error('down');
  const failed = await w.metrics.adminMetrics(ADMIN_A);
  assert.deepEqual([failed.metrics[0].state, failed.metrics[0].reason, failed.metrics[0].value], ['unobservable', 'source_failed', null]);
  w.sa.restricted = true;
  await refused(() => w.metrics.adminMetrics(ADMIN_A), 403, 'ADMIN_METRICS_RESTRICTED');
  w.sa.restricted = false;
  const own = w.study();
  assert.deepEqual(await w.audit.audits(own.uid, 10, RAD_A), []);
  await refused(() => w.audit.audits(own.uid, 10, RAD_B), 404);
});
