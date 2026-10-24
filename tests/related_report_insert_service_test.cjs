'use strict';
/* TEST-W5-API (REQ-WS4/REQ-WS5 -> RISK-WS4-INSERT-TWICE / RISK-WS4-SOURCE-AS-PROOF / RISK-WS5-RECEIPT-AS-SAVED ->
 * TEST-WS4-INSERT-IDEMPOTENCY / TEST-WS4-SOURCE-PERMISSIONS / TEST-WS5-INSERT-CHECK): the W5 Related Report insertion of the O4
 * design (R1, D1423) through the real PacsController handlers and PacsService facade - `relatedInsert` on PUT
 * /api/studies/:uid/report and the receipt-bearing Check on GET /api/studies/:uid/draft?insertRequestId=.
 *
 * What is bound: behaviour and permission contracts only (AGENTS §1, §1-B / D73) - statuses, codes, the wire shape of
 * `relatedInsert`, what is stored (draft revision, receipt state/revision, audit actions) and what is never touched. The
 * request digest is checked against the R1 hash_contract tuple written out here from the design, not from the product.
 * Expected values are the contract's literals; nothing reads product source text.
 *
 * How a case reaches the product: where the router does - the handler Nest's route metadata maps `method path` to on
 * PacsController, its arguments placed as its parameter decorators ask (PARAM uid, BODY, REQUEST, QUERY insertRequestId),
 * over the real facade and concerns compiled from api/src by tests/service_test_loader.cjs (or /app/dist in the image).
 *
 * The store is an in-memory double that models what this code relies on (D1444: a double without the store's fidelity hid
 * two product defects): the receipt primary key across transactions, the migration's two CHECKs transcribed clause by clause
 * with SQL NULL closed, its terminal guard (UPDATE only of a refused row with receiptRevision + 1 and the binding unchanged;
 * DELETE refused), ReportDraft's tombstone CHECK with SQL NULL apart from JSON null, jsonb's key re-ordering on read, and a
 * snapshot per transaction (RepeatableRead reads; a commit replaces the tables, a throw rolls back). Transactions run one at a
 * time: row locks, lock waits, deadlocks, READ COMMITTED re-reads after a wait and the real migration DDL are NOT modelled -
 * those are the PostgreSQL cases in tests/report_draft_cas_service_test.cjs (hosted runtime job). Synthetic data only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
if (!fs.existsSync('/app/dist/pacs')) require('./service_test_loader.cjs');

const { ConflictException, HttpException, NotFoundException, RequestMethod, ServiceUnavailableException } = require('/app/node_modules/@nestjs/common');
const { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } = require('/app/node_modules/@nestjs/common/constants');
const { RouteParamtypes } = require('/app/node_modules/@nestjs/common/enums/route-paramtypes.enum');
const { Prisma } = require('/app/node_modules/@prisma/client');
const { PacsService } = require('/app/dist/pacs.service');
const { PacsController } = require('/app/dist/pacs.controller');

// ── the store double ──

const copy = value => structuredClone(value);
const JSON_NULL = Object.freeze({ jsonNull: true });          // a stored JSON null, apart from SQL NULL (null)
const JSON_COLUMNS = { reportDraft: ['citations', 'structured'], reportVersion: ['citations', 'structured'] };
const UPDATED_AT = new Set(['reportDraft', 'reportDraftInsertReceipt', 'report']);
const AUTO_ID = new Set(['auditLog', 'reportVersion']);
const KEYS = { studyState: [['uid']], report: [['uid']], reportDraft: [['uid', 'author']], reportVersion: [['uid', 'version']],
  reportDraftInsertReceipt: [['insertRequestId']], authSession: [['sid']] };
const MODEL = name => name[0].toUpperCase() + name.slice(1);
const RECEIPT_REQUIRED = ['insertRequestId', 'targetUid', 'ownerInstitution', 'ownerSub', 'ownerAuthor', 'requestHash', 'proposalHash',
  'expectedEpoch', 'expectedRevision', 'sourceUid', 'sourceVersion', 'targetBaseVersion', 'section', 'state', 'receiptRevision',
  'createdAt', 'updatedAt'];
const RECEIPT_IMMUTABLE = ['insertRequestId', 'targetUid', 'ownerInstitution', 'ownerSub', 'ownerAuthor', 'requestHash', 'proposalHash',
  'expectedEpoch', 'expectedRevision', 'sourceUid', 'sourceVersion', 'targetBaseVersion', 'section', 'createdAt'];
const REFUSAL_CODES = ['DRAFT_CONFLICT', 'TARGET_UNVERIFIED', 'TARGET_HELD', 'SOURCE_UNAVAILABLE', 'SOURCE_CHANGED', 'SEED_CHANGED'];
const sqlError = (code, what) => Object.assign(new Error('double: ' + what), { code: 'P2010', meta: { code, message: what } });

/** PostgreSQL jsonb keeps object keys ordered by length, then bytewise - not as written. */
function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const keys = Object.keys(value).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(keys.map(key => [key, jsonbOrder(value[key])]));
}
/** The migration's two CHECKs, clause by clause; a SQL NULL never passes a clause (they are COALESCEd to false). */
function receiptChecks(row) {
  const nn = value => value !== null && value !== undefined;
  for (const field of RECEIPT_REQUIRED) if (!nn(row[field])) throw sqlError('23502', `null value in column "${field}"`);
  const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const values = ['targetUid', 'sourceUid', 'ownerInstitution', 'ownerSub', 'ownerAuthor'].every(f => row[f].length > 0)
    && hex(row.requestHash) && hex(row.proposalHash) && row.expectedRevision >= 0 && row.expectedRevision <= 2147483646
    && row.sourceVersion >= 1 && row.targetBaseVersion >= 0 && row.receiptRevision >= 1 && ['findings', 'conclusion'].includes(row.section);
  if (!values) throw sqlError('23514', 'ReportDraftInsertReceipt_values_check');
  const state = (row.state === 'applied' && nn(row.appliedRevision) && row.appliedRevision === row.expectedRevision + 1 && !nn(row.reason))
    || (row.state === 'refused' && !nn(row.appliedRevision) && nn(row.reason) && REFUSAL_CODES.includes(row.reason))
    || (row.state === 'discarded' && !nn(row.appliedRevision) && nn(row.reason) && row.reason === 'INSERT_DISCARDED');
  if (!state) throw sqlError('23514', 'ReportDraftInsertReceipt_state_check');
}
/** The terminal guard: SQLSTATE 42501 for every role. */
function receiptGuard(before, after) {
  if (before.state !== 'refused') throw sqlError('42501', `ReportDraftInsertReceipt is terminal once ${before.state}`);
  if (after.receiptRevision !== before.receiptRevision + 1 || RECEIPT_IMMUTABLE.some(f => +after[f] !== +before[f] && after[f] !== before[f]))
    throw sqlError('42501', 'ReportDraftInsertReceipt keeps its binding and moves one receipt revision at a time');
}
function draftChecks(row) {
  if (!(row.revision >= 1)) throw sqlError('23514', 'ReportDraft_revision_check');
  if (!row.present && !(row.findings === '' && row.conclusion === '' && row.recommendation === '' && row.baseVersion === 0
      && row.citations === null && row.structured === null)) throw sqlError('23514', 'ReportDraft_absent_check');
}

function storeDouble() {
  // lockedRows: StudyState rows another transaction holds; taking them fails as a lock wait past lock_timeout (55P03)
  const store = { tables: {}, events: [], ops: [], faults: [], hooks: {}, lockedRows: new Set(), queue: Promise.resolve(), seq: 0 };
  const event = (label, what) => store.events.push(label + ' ' + what);
  // a fault may name the row it hits (where.uid), so that it lands on the Source read and not on the Target's
  const fault = (model, op, where) => {
    const at = store.faults.findIndex(f => f.model === model && f.op === op && (f.uid === undefined || f.uid === where?.uid));
    if (at >= 0) throw store.faults.splice(at, 1)[0].error;
  };
  const same = (a, b) => (a instanceof Date || b instanceof Date ? +a === +b : (a ?? null) === (b ?? null));
  const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
  const matches = (row, where) => Object.entries(where ?? {}).every(([key, value]) =>
    key.includes('_') && plain(value) ? matches(row, value) : same(row[key], value));
  const read = (name, row, select) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (select && !select[key]) continue;
      out[key] = value === JSON_NULL ? null : (JSON_COLUMNS[name] ?? []).includes(key) ? jsonbOrder(copy(value)) : copy(value);
    }
    return out;
  };
  const write = (name, row, data) => {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value === undefined) continue;
      if (value === Prisma.DbNull) row[key] = null;
      else if (value === Prisma.JsonNull) row[key] = JSON_NULL;
      else if (value === null && (JSON_COLUMNS[name] ?? []).includes(key)) throw new Error('double: Prisma refuses a bare null for a Json column');
      else row[key] = copy(value);
    }
    if (UPDATED_AT.has(name)) row.updatedAt = new Date();
  };
  const delegate = (ctx, name, label) => {
    // reads never create a table; a write does
    const rows = () => ctx.tables[name] ?? [];
    const writable = () => (ctx.tables[name] ??= []);
    const unique = (row, others) => {
      for (const keys of KEYS[name] ?? [])
        if (others.some(other => other !== row && keys.every(k => same(other[k], row[k]))))
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { modelName: MODEL(name), target: keys } });
    };
    const check = row => { if (name === 'reportDraftInsertReceipt') receiptChecks(row); if (name === 'reportDraft') draftChecks(row); };
    return {
      async findUnique({ where, select } = {}) {
        fault(name, 'findUnique', where); event(label, `read ${name} ${JSON.stringify(where)}`);
        const row = rows().find(r => matches(r, where)), out = row ? read(name, row, select) : null;
        if (store.hooks.afterRead?.model === name) { const { fn } = store.hooks.afterRead; store.hooks.afterRead = null; await fn(); }
        return out;
      },
      async findFirst({ where, orderBy, select } = {}) {
        event(label, `read ${name}`);
        const [[key, dir] = []] = Object.entries(orderBy ?? {});
        const found = rows().filter(r => matches(r, where)).sort((a, b) => (key ? (a[key] < b[key] ? -1 : 1) * (dir === 'desc' ? -1 : 1) : 0));
        return found[0] ? read(name, found[0], select) : null;
      },
      async findMany({ where, select } = {}) { event(label, `read ${name}`); return rows().filter(r => matches(r, where)).map(r => read(name, r, select)); },
      async create({ data, select }) {
        fault(name, 'create'); store.ops.push(`${label} create ${name}`);
        const row = { ...(AUTO_ID.has(name) ? { id: ++store.seq } : {}),
          ...(name === 'reportDraftInsertReceipt' ? { receiptRevision: 1, appliedRevision: null, reason: null, createdAt: new Date() } : {}),
          ...(name === 'reportDraft' ? { citations: null, structured: null, revision: 1, present: true } : {}),
          ...(name === 'auditLog' ? { at: new Date(), detail: null } : {}) };
        write(name, row, data);
        check(row);
        // A primary key is one index for every transaction: a row another transaction committed meanwhile is a duplicate too.
        unique(row, [...rows(), ...(ctx === store.root ? [] : (store.tables[name] ?? []))]);
        writable().push(row);
        return read(name, row, select);
      },
      async update({ where, data, select }) {
        store.ops.push(`${label} update ${name}`);
        const row = rows().find(r => matches(r, where));
        if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
        const next = { ...row }; write(name, next, data); check(next); Object.assign(row, next);
        return read(name, row, select);
      },
      async updateMany({ where, data }) {
        fault(name, 'updateMany'); store.ops.push(`${label} updateMany ${name}`);
        const hit = rows().filter(r => matches(r, where));
        for (const row of hit) {
          const next = { ...row }; write(name, next, data);
          if (name === 'reportDraftInsertReceipt') receiptGuard(row, next);
          check(next); Object.assign(row, next);
        }
        return { count: hit.length };
      },
      async delete() { if (name === 'reportDraftInsertReceipt') throw sqlError('42501', 'ReportDraftInsertReceipt is never removed'); throw new Error('double: not used'); },
      async deleteMany() { if (name === 'reportDraftInsertReceipt') throw sqlError('42501', 'ReportDraftInsertReceipt is never removed'); throw new Error('double: not used'); },
    };
  };
  const raw = (ctx, label) => async (strings, ...values) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    const t = ctx.tables;
    if (/^SET LOCAL lock_timeout/.test(sql)) return 0;
    if (/FROM "AuthSession" WHERE sid = \? FOR KEY SHARE$/.test(sql)) {
      event(label, 'lock session'); return (t.authSession ?? []).filter(r => r.sid === values[0]).map(() => ({ held: 1 }));
    }
    let m;
    if ((m = /^SELECT (\*|uid) FROM "StudyState" WHERE uid = \? FOR (UPDATE|SHARE)$/.exec(sql))) {
      event(label, `lock StudyState ${values[0]} ${m[2]}`);
      if (store.lockedRows.has(values[0])) throw sqlError('55P03', `canceling statement due to lock timeout (${values[0]})`);
      return (t.studyState ?? []).filter(r => r.uid === values[0]).map(r => (m[1] === '*' ? copy(r) : { uid: r.uid }));
    }
    if (/FROM "ReportDraft" WHERE uid = \? AND author = \? FOR UPDATE$/.test(sql)) {
      event(label, 'lock ReportDraft');
      return (t.reportDraft ?? []).filter(r => r.uid === values[0] && r.author === values[1]).map(r => read('reportDraft', r));
    }
    if (/^SELECT \* FROM "ReportDraftInsertReceipt" WHERE "insertRequestId" = \?::uuid FOR UPDATE$/.test(sql)) {
      event(label, 'lock ReportDraftInsertReceipt');
      const found = (t.reportDraftInsertReceipt ?? []).filter(r => r.insertRequestId === values[0]).map(r => read('reportDraftInsertReceipt', r));
      if (store.hooks.afterReceiptLock) { const hook = store.hooks.afterReceiptLock; store.hooks.afterReceiptLock = null; await hook(); }
      return found;
    }
    throw new Error('double: unhandled SQL ' + sql);
  };
  const client = (ctx, label) => {
    const delegates = new Map();
    const target = { $executeRaw: raw(ctx, label), $queryRaw: raw(ctx, label),
      ...(label === 'root' ? { $transaction: (work, options) => {
        // one transaction at a time, on its own snapshot: a commit replaces the tables, a throw leaves them as they were
        const run = store.queue.then(async () => {
          event('tx', 'begin ' + (options?.isolationLevel ?? 'ReadCommitted'));
          const scratch = { tables: copy(store.tables) }, writes = store.ops.length;
          const out = await work(client(scratch, 'tx'));
          // a transaction that wrote replaces the tables; a read-only one leaves whatever was committed meanwhile
          if (store.ops.length !== writes) store.tables = scratch.tables;
          event('tx', 'commit');
          return out;
        });
        store.queue = run.catch(() => { event('tx', 'rollback'); });
        return run;
      } } : {}) };
    return new Proxy(target, { get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== 'string' || key === 'then' || key.startsWith('$')) return undefined;
      if (!delegates.has(key)) delegates.set(key, delegate(ctx, key, label));
      return delegates.get(key);
    } });
  };
  store.root = { get tables() { return store.tables; }, set tables(v) { store.tables = v; } };
  store.client = client(store.root, 'root');
  store.rows = name => (store.tables[name] ??= []);
  store.seed = (name, row) => { const full = { ...(AUTO_ID.has(name) ? { id: ++store.seq } : {}), ...row }; store.rows(name).push(full); return full; };
  return store;
}

// ── the world: principals, studies, the facade and the controller ──

const INST = 'syn-inst-a', OTHER = 'syn-inst-b';
const member = (name, institution, roles) => ({ kind: 'member', institution, sub: 'syn-sub-' + name, actor: `syn-${name}@synthetic.test`, roles });
const A = member('a', INST, ['radiologist']), B = member('b', INST, ['radiologist']), C = member('c', OTHER, ['radiologist']);
const TECH = member('tech', INST, ['technician']);
const ownerOf = p => ({ institution: p.institution, sub: p.sub, author: p.actor });
const TARGET = '2.25.5101', SOURCE_LOW = '2.25.5050', SOURCE_HIGH = '2.25.5202', SECOND_TARGET = '2.25.5102';
const CID = '0c0c0c0c-0000-4000-8000-0000000000c1';
const PRIOR = { findings: 'SYN prior findings line 1\nSYN prior findings line 2\n', conclusion: 'SYN prior conclusion',
  recommendation: 'SYN prior recommendation' };

function route(method, path) {
  const found = [];
  for (const key of Object.getOwnPropertyNames(PacsController.prototype)) {
    const handler = PacsController.prototype[key];
    if (key === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(METHOD_METADATA, handler) !== method) continue;
    if ([].concat(Reflect.getMetadata(PATH_METADATA, handler)).includes(path)) found.push(key);
  }
  assert.equal(found.length, 1, `${path} must reach one handler`);
  return found[0];
}
const ROUTES = { put: route(RequestMethod.PUT, 'studies/:uid/report'), read: route(RequestMethod.GET, 'studies/:uid/draft') };

function world({ source = SOURCE_LOW } = {}) {
  const store = storeDouble();
  const sa = { denied: new Set(),
    // prepareFails: studies whose access metadata cannot be read now (the real prepare answers 503 before any lock)
    prepareFails: new Set(),
    async prepare(c, uids) { store.events.push('root prepare ' + JSON.stringify(uids ?? null));
      if ((uids ?? []).some(uid => sa.prepareFails.has(uid))) throw new ServiceUnavailableException('검사 원본의 접근 조건을 확인하지 못했습니다'); },
    async require(c, uids, tx) { store.events.push(`${tx ? 'tx' : 'root'} require ${JSON.stringify(uids)}`);
      if (uids.some(uid => sa.denied.has(uid))) throw new NotFoundException('검사를 찾을 수 없습니다'); },
    async allowed(c, uids) { return new Set(uids.filter(uid => !sa.denied.has(uid))); },
    // WORKLIST-SPLIT-UID, as StudyAccessService: split = UIDs two original resources answer now; unobservable = UIDs whose
    // resources cannot be read now. The observation is per request (per Caller), outside the transaction; the assertion
    // refuses a split (409) or a UID this request did not observe (503).
    split: new Set(), unobservable: new Set(), observed: new WeakMap(),
    async prepareSourceIdentity(c, uids) { store.events.push('root identity ' + JSON.stringify(uids));
      const seen = sa.observed.get(c) ?? new Map(); sa.observed.set(c, seen);
      for (const uid of uids) if (!seen.has(uid)) seen.set(uid, sa.unobservable.has(uid) ? null : sa.split.has(uid) ? 2 : 1); },
    assertUnsplitSource(c, uid) { store.events.push('assert unsplit ' + uid);
      const count = sa.observed.get(c)?.get(uid);
      if (typeof count !== 'number') throw new ServiceUnavailableException({ code: 'STUDY_SOURCE_UNAVAILABLE', message: 'SYN source unobserved' });
      if (count > 1) throw new ConflictException({ code: 'STUDY_IDENTITY_UNRESOLVED', message: 'SYN split' }); },
  };
  const trap = name => new Proxy({}, { get(_t, key) { return () => { throw new Error(`harness: ${name}.${String(key)} must not be reached`); }; } });
  const w = { store, sa, source, epoch: randomUUID() };
  const ledger = { begin: () => ({ end() {}, resolveRequestIdentity: async () => 'synthetic-member-id',
    transactionWithRecords: (work, options) => store.client.$transaction(tx => work(tx, async (_event, effect) => effect()), options) }) };
  w.build = () => { w.svc = new PacsService(store.client, trap('orthanc'), trap('keycloak'), sa, trap('findings'), ledger);
    w.controller = new PacsController(w.svc, trap('auth')); };
  w.build();
  const now = new Date('2026-10-17T00:00:00.000Z');
  store.seed('studyState', { uid: TARGET, institutionId: INST, teleInstitutionId: null, rs: 'A', ss: 'Verified', em: 'N', holder: null,
    heldAt: null, preDoc: null, preDocSub: null, preReviewer: null, preReviewerSub: null, draftEpoch: w.epoch });
  store.seed('report', { uid: TARGET, version: 1, findings: 'SYN target head findings', conclusion: 'SYN target head conclusion',
    recommendation: '', updatedBy: B.actor, updatedAt: now });
  store.seed('reportVersion', { uid: TARGET, version: 1, action: 'approve', findings: 'SYN target head findings',
    conclusion: 'SYN target head conclusion', recommendation: '', author: B.actor, citations: null, structured: null, at: now });
  store.seed('reportDraft', { uid: TARGET, author: A.actor, findings: 'SYN draft findings', conclusion: 'SYN draft conclusion\n',
    recommendation: 'SYN draft recommendation', baseVersion: 1, revision: 1, present: true, structured: null, updatedAt: now,
    citations: [{ v: 2, cid: CID, field: 'findings', findingId: '0f0f0f0f-0000-4000-8000-00000000000a', findingRevision: 1,
      sourceIndex: 0, insertedText: 'SYN draft findings', insertedAt: now.toISOString(), insertedBy: A.actor }] });
  store.seed('studyState', { uid: source, institutionId: INST, teleInstitutionId: null, rs: 'A', ss: 'Verified', em: 'N', holder: null,
    heldAt: null, preDoc: null, preDocSub: null, preReviewer: null, preReviewerSub: null, draftEpoch: randomUUID() });
  store.seed('report', { uid: source, version: 2, ...PRIOR, updatedBy: B.actor, updatedAt: now });
  store.seed('reportVersion', { uid: source, version: 1, action: 'approve', findings: 'SYN prior v1', conclusion: '', recommendation: '',
    author: B.actor, citations: null, structured: null, at: now });
  store.seed('reportVersion', { uid: source, version: 2, action: 'addendum', ...PRIOR, author: B.actor, citations: null, structured: null, at: now });
  /** One request as the router hands it over; the answer is what the HTTP layer would send. */
  w.send = async (name, { as = A, uid = TARGET, body, query = {} }) => {
    const key = ROUTES[name], req = { sub: as.sub, actor: as.actor, roles: as.roles, institution: as.institution, kind: as.kind,
      headers: {}, authMethod: 'bearer' };
    const args = [];
    for (const [slot, { index, data }] of Object.entries(Reflect.getMetadata(ROUTE_ARGS_METADATA, PacsController, key) ?? {})) {
      const type = Number(slot.split(':')[0]);
      if (type === RouteParamtypes.PARAM && data === 'uid') args[index] = uid;
      else if (type === RouteParamtypes.BODY && data === undefined) args[index] = body;
      else if (type === RouteParamtypes.REQUEST) args[index] = req;
      else if (type === RouteParamtypes.QUERY && data === 'insertRequestId') args[index] = query.insertRequestId;
      else assert.fail(`the handler asks for argument ${slot} ${JSON.stringify(data)}, which these cases do not provide`);
    }
    try { return { status: 200, code: null, body: await w.controller[key](...args) }; }
    catch (error) {
      if (!(error instanceof HttpException)) return { status: 0, code: 'NOT_HTTP', body: null, error };
      const answer = error.getResponse();
      return { status: error.getStatus(), code: typeof answer === 'object' ? answer.code ?? null : null, body: answer };
    }
  };
  w.draft = (who = A) => store.rows('reportDraft').find(r => r.uid === TARGET && r.author === who.actor) ?? null;
  w.receipt = id => store.rows('reportDraftInsertReceipt').find(r => r.insertRequestId === id) ?? null;
  w.audits = () => store.rows('auditLog').map(r => `${r.actor} ${r.action} ${r.target}`);
  /** Everything a request could change, in committed form. */
  w.snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(store.tables).filter(([, rows]) => rows.length)));
  return w;
}

/** The R1 line rule, written from the design: '' after an empty or LF-ending seed, else one LF; parts joined by a blank line. */
function insertionText(seed, parts, versionTexts = PRIOR) {
  return (seed === '' || seed.endsWith('\n') ? '' : '\n') + parts.map(p => versionTexts[p.field].slice(p.start, p.end)).join('\n\n');
}
const WHOLE = [{ field: 'findings', start: 0, end: PRIOR.findings.length }, { field: 'conclusion', start: 0, end: PRIOR.conclusion.length }];

/** A fixed relatedInsert PUT as the W5 page freezes it: the full proposal plus the operation. */
function insertBody(w, { who = A, id = randomUUID(), revision = 1, epoch = w.epoch, section = 'findings', parts = WHOLE,
    version = 2, action = 'addendum', seedKind = 'private-draft', seed, ids = [CID], intent = 'apply', receiptRevision, edit = {},
    operation = {}, source = w.source } = {}) {
  seed ??= { findings: 'SYN draft findings', conclusion: 'SYN draft conclusion\n', recommendation: 'SYN draft recommendation', baseVersion: 1 };
  const text = insertionText(seed[section], parts);
  const proposal = { ...seed, [section]: seed[section] + text };
  return { expectedOwner: ownerOf(who), expectedRevision: `${epoch}:${revision}`, ...proposal, citationIds: ids, structureIds: [], ...edit,
    relatedInsert: { intent, insertRequestId: id, source: { uid: source, version, action, parts }, targetUid: TARGET,
      targetBaseVersion: seed.baseVersion, section, position: 'end', offset: seed[section].length, text, selectionSeq: 7,
      contentRevision: 3, sourceGeneration: 2, seedKind, ...(intent === 'discard' ? { expectedReceiptRevision: receiptRevision } : {}),
      ...operation } };
}
const discardOf = (body, receiptRevision) => ({ ...body, relatedInsert: { ...body.relatedInsert, intent: 'discard', expectedReceiptRevision: receiptRevision } });

/** The R1 hash_contract tuple, independently of the product: marker, ID, owner, route Target, CAS, Source, Target, text, generations, proposal. */
function contractHash(body, uid = TARGET) {
  const r = body.relatedInsert, [epoch, revision] = body.expectedRevision.split(':');
  const proposal = ['related-insert-proposal-v1', body.findings, body.conclusion, body.recommendation, body.baseVersion,
    [...body.citationIds].sort(), [...body.structureIds].sort()];
  const sha = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  return { request: sha(['related-insert-v1', r.insertRequestId, body.expectedOwner.institution, body.expectedOwner.sub,
    body.expectedOwner.author, uid, epoch, Number(revision), r.source.uid, r.source.version, r.source.action,
    r.source.parts.map(p => [p.field, p.start, p.end]), r.targetBaseVersion, r.seedKind, r.section, r.position, r.offset, r.text,
    r.selectionSeq, r.contentRevision, r.sourceGeneration, proposal]), proposal: sha(proposal) };
}

const ANSWER_KEYS = ['appliedRevision', 'currentMatches', 'discardable', 'expectedRevision', 'insertRequestId', 'proposalHash',
  'reason', 'receiptRevision', 'requestHash', 'result', 'state'];
function assertAnswer(answer, expected, label) {
  assert.deepEqual(Object.keys(answer).sort(), ANSWER_KEYS, label + ': the relatedInsert keys');
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(answer[key], value, `${label}: relatedInsert.${key}`);
}

// ── A-02 / A-08 / A-09: first apply, exact replay, the receipt and the result shape ──

test('W5API-01 first apply: draft +1 with the fixed proposal, one report.draft audit, an applied receipt in the same commit', async () => {
  const w = world();
  const body = insertBody(w);
  const answer = await w.send('put', { body });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const hash = contractHash(body);
  assertAnswer(answer.body.relatedInsert, { insertRequestId: body.relatedInsert.insertRequestId, result: 'applied', state: 'applied',
    requestHash: hash.request, proposalHash: hash.proposal, expectedRevision: `${w.epoch}:1`, appliedRevision: `${w.epoch}:2`,
    receiptRevision: 1, currentMatches: true, discardable: false, reason: null }, 'first apply');
  assert.equal(answer.body.revision, `${w.epoch}:2`);
  assert.deepEqual(answer.body.owner, ownerOf(A));
  assert.deepEqual(answer.body.snapshot, { findings: body.findings, conclusion: body.conclusion, recommendation: body.recommendation,
    baseVersion: 1, citations: [CID], structured: [] });
  assert.equal(w.draft().findings, 'SYN draft findings\n' + PRIOR.findings + '\n\n' + PRIOR.conclusion);
  assert.equal(w.draft().revision, 2);
  assert.deepEqual(w.audits(), [`${A.actor} report.draft ${TARGET}`]);
  const audit = JSON.parse(w.store.rows('auditLog')[0].detail);
  assert.deepEqual(Object.keys(audit).sort(), ['cits', 'len'], 'the existing minimal audit: lengths and citation ids only');
  const receipt = w.receipt(body.relatedInsert.insertRequestId);
  assert.deepEqual({ state: receipt.state, appliedRevision: receipt.appliedRevision, reason: receipt.reason, receiptRevision: receipt.receiptRevision,
    expectedEpoch: receipt.expectedEpoch, expectedRevision: receipt.expectedRevision, targetUid: receipt.targetUid, sourceUid: receipt.sourceUid,
    sourceVersion: receipt.sourceVersion, targetBaseVersion: receipt.targetBaseVersion, section: receipt.section, requestHash: receipt.requestHash },
    { state: 'applied', appliedRevision: 2, reason: null, receiptRevision: 1, expectedEpoch: w.epoch, expectedRevision: 1, targetUid: TARGET,
      sourceUid: w.source, sourceVersion: 2, targetBaseVersion: 1, section: 'findings', requestHash: hash.request });
  // W5API-24: no report text, inserted text or patient value in the receipt or the audit row
  const stored = JSON.stringify(receipt) + w.store.rows('auditLog')[0].detail;
  for (const text of [PRIOR.findings.trim(), PRIOR.conclusion, 'SYN draft findings', 'SYN prior']) assert.equal(stored.includes(text), false, text);
});

test('W5API-02 exact replay: the current envelope and the receipt, zero writes, zero audit, no revision bump', async () => {
  const w = world();
  const body = insertBody(w);
  assert.equal((await w.send('put', { body })).status, 200);
  const before = w.snapshot(), ops = w.store.ops.length;
  for (const attempt of [1, 2]) {
    const again = await w.send('put', { body });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assertAnswer(again.body.relatedInsert, { result: 'applied', state: 'applied', appliedRevision: `${w.epoch}:2`, currentMatches: true }, 'replay ' + attempt);
    assert.equal(again.body.revision, `${w.epoch}:2`);
  }
  assert.equal(w.snapshot(), before, 'nothing committed by the replays');
  assert.deepEqual(w.store.ops.slice(ops), [], 'no write was even attempted');
  assert.deepEqual(w.audits(), [`${A.actor} report.draft ${TARGET}`]);
});

test('W5API-03 replay after clear, own discard, commit and a force-discard epoch: SUPERSEDED, never re-inserted', async () => {
  for (const after of ['clear', 'discard', 'commit', 'epoch']) {
    const w = world();
    const body = insertBody(w);
    assert.equal((await w.send('put', { body })).status, 200);
    const row = w.store.rows('reportDraft').find(r => r.author === A.actor);
    if (after === 'clear' || after === 'discard' || after === 'commit')
      Object.assign(row, { present: false, findings: '', conclusion: '', recommendation: '', baseVersion: 0, citations: null, revision: 3 });
    if (after === 'epoch') w.store.rows('studyState').find(r => r.uid === TARGET).draftEpoch = randomUUID();
    const before = w.snapshot(), audits = w.audits();
    const replay = await w.send('put', { body });
    assert.deepEqual([replay.status, replay.code], [409, 'RELATED_INSERT_SUPERSEDED'], after);
    assertAnswer(replay.body.relatedInsert, { result: 'unknown', state: 'applied', reason: 'SUPERSEDED', currentMatches: false,
      appliedRevision: `${w.epoch}:2`, discardable: false }, after);
    assert.equal(w.snapshot(), before, after + ': nothing written');
    assert.deepEqual(w.audits(), audits, after + ': no audit');
  }
});

test('W5API-04 the same ID with another binding is ID_REUSED: other text, other owner, other Target, other CAS - no row disclosed, nothing changed', async () => {
  const w = world();
  w.store.seed('studyState', { uid: SECOND_TARGET, institutionId: INST, teleInstitutionId: null, rs: 'W', ss: 'Verified', em: 'N',
    holder: null, heldAt: null, preDoc: null, preReviewer: null, draftEpoch: w.epoch });
  const body = insertBody(w);
  assert.equal((await w.send('put', { body })).status, 200);
  const id = body.relatedInsert.insertRequestId, before = w.snapshot();
  const parts = [{ field: 'conclusion', start: 0, end: PRIOR.conclusion.length }];
  const cases = [
    ['other text', insertBody(w, { id, parts, revision: 2,
      seed: { findings: w.draft().findings, conclusion: 'SYN draft conclusion\n', recommendation: 'SYN draft recommendation', baseVersion: 1 } }), A, TARGET],
    ['other CAS (a retry rebased on the new revision)', { ...body, expectedRevision: `${w.epoch}:2` }, A, TARGET],
    ['other owner', { ...insertBody(w, { id, who: B, revision: 0, ids: [] }) }, B, TARGET],
    ['other Target', { ...body, relatedInsert: { ...body.relatedInsert, targetUid: SECOND_TARGET } }, A, SECOND_TARGET],
  ];
  for (const [label, request, as, uid] of cases) {
    const answer = await w.send('put', { as, uid, body: request });
    assert.deepEqual([answer.status, answer.code], [409, 'ID_REUSED'], label + ' ' + JSON.stringify(answer.body));
    assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'message'], label + ': nothing of the existing row');
    assert.equal(w.snapshot(), before, label + ': nothing changed');
  }
});

// ── A-07 / A-02: refusal, same-ID retry, discard tombstone ──

const hold = (w, holder = B.actor) => Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { holder, heldAt: new Date() });
const release = w => Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { holder: null, heldAt: null });

test('W5API-05 a business refusal is a durable refused receipt (409, discardable), the draft untouched; the same ID retried at the original CAS applies once', async () => {
  const w = world();
  const body = insertBody(w);
  hold(w);
  const refused = await w.send('put', { body });
  assert.deepEqual([refused.status, refused.code], [409, 'RELATED_INSERT_REFUSED'], JSON.stringify(refused.body));
  assertAnswer(refused.body.relatedInsert, { result: 'refused', state: 'refused', reason: 'TARGET_HELD', receiptRevision: 1,
    discardable: true, currentMatches: false, appliedRevision: null }, 'held');
  assert.equal(refused.body.revision, `${w.epoch}:1`, 'the refusal carries the current envelope');
  assert.equal(w.draft().revision, 1); assert.deepEqual(w.audits(), []);
  assert.equal(w.receipt(body.relatedInsert.insertRequestId).state, 'refused');
  // the same refusal again writes nothing new (same reason)
  const before = w.snapshot();
  assert.equal((await w.send('put', { body })).code, 'RELATED_INSERT_REFUSED');
  assert.equal(w.snapshot(), before);
  release(w);
  const retried = await w.send('put', { body });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assertAnswer(retried.body.relatedInsert, { result: 'applied', state: 'applied', receiptRevision: 2, appliedRevision: `${w.epoch}:2` }, 'retry');
  assert.equal(w.draft().revision, 2);
  assert.deepEqual(w.audits(), [`${A.actor} report.draft ${TARGET}`]);
});

test('W5API-06 a refused retry stays at its original CAS: a moved draft refuses it again (DRAFT_CONFLICT, receipt revision +1), never a silent rebase', async () => {
  const w = world();
  const body = insertBody(w);
  hold(w);
  assert.equal((await w.send('put', { body })).code, 'RELATED_INSERT_REFUSED');
  release(w);
  Object.assign(w.draft(), { findings: 'SYN typed later', revision: 2 });
  const again = await w.send('put', { body });
  assert.deepEqual([again.status, again.code], [409, 'RELATED_INSERT_REFUSED']);
  assertAnswer(again.body.relatedInsert, { state: 'refused', reason: 'DRAFT_CONFLICT', receiptRevision: 2, discardable: true }, 'moved');
  assert.equal(w.draft().findings, 'SYN typed later', 'the later text is not rewritten');
  assert.deepEqual(w.audits(), []);
});

test('W5API-07 Discard Insert: refused -> discarded tombstone only (no draft write, no Source read); a late retry inserts nothing; a lost reply resent is the same answer', async () => {
  const w = world();
  const body = insertBody(w);
  hold(w);
  const refused = await w.send('put', { body });
  release(w);
  const draft = JSON.stringify(w.draft()), events = w.store.events.length;
  w.sa.denied.add(w.source);   // a Source the caller can no longer read does not matter to a discard
  const discard = discardOf(body, refused.body.relatedInsert.receiptRevision);
  const done = await w.send('put', { body: discard });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assertAnswer(done.body.relatedInsert, { result: 'refused', state: 'discarded', reason: 'INSERT_DISCARDED', receiptRevision: 2,
    discardable: false }, 'discarded');
  assert.equal(JSON.stringify(w.draft()), draft, 'the draft is not written');
  const touched = w.store.events.slice(events).join('\n');
  assert.equal(touched.includes(w.source), false, 'no Source row is locked or read: ' + touched);
  assert.equal(touched.includes('read reportVersion'), false);
  const before = w.snapshot();
  w.sa.denied.delete(w.source);
  const late = await w.send('put', { body });
  assert.deepEqual([late.status, late.code], [409, 'RELATED_INSERT_DISCARDED']);
  assertAnswer(late.body.relatedInsert, { state: 'discarded', reason: 'INSERT_DISCARDED' }, 'late retry');
  const resent = await w.send('put', { body: discard });
  assert.equal(resent.status, 200);
  assertAnswer(resent.body.relatedInsert, { state: 'discarded' }, 'resent discard');
  assert.equal(w.snapshot(), before, 'neither the late retry nor the resent discard wrote');
  assert.deepEqual(w.audits(), []);
});

test('W5API-08 nothing but a confirmed refused receipt at its receipt revision is discardable: unknown, applied, a changed revision, another binding', async () => {
  const w = world();
  const unknown = insertBody(w);
  const absent = await w.send('put', { body: discardOf(unknown, 1) });
  assert.deepEqual([absent.status, absent.code], [409, 'RELATED_INSERT_NOT_DISCARDABLE']);
  assertAnswer(absent.body.relatedInsert, { result: 'unknown', state: null, reason: 'RECEIPT_ABSENT', discardable: false }, 'unknown');
  assert.equal(w.receipt(unknown.relatedInsert.insertRequestId), null, 'no tombstone is created for an unknown insertion');
  const applied = insertBody(w);
  assert.equal((await w.send('put', { body: applied })).status, 200);
  const late = await w.send('put', { body: discardOf(applied, 1) });
  assert.deepEqual([late.status, late.code], [409, 'RELATED_INSERT_NOT_DISCARDABLE']);
  assertAnswer(late.body.relatedInsert, { state: 'applied', result: 'applied' }, 'applied');
  const w2 = world(), held = insertBody(w2);
  hold(w2);
  assert.equal((await w2.send('put', { body: held })).code, 'RELATED_INSERT_REFUSED');
  const stale = await w2.send('put', { body: discardOf(held, 2) });
  assert.deepEqual([stale.status, stale.code], [409, 'RELATED_INSERT_RECEIPT_CHANGED']);
  assert.equal(w2.receipt(held.relatedInsert.insertRequestId).state, 'refused');
  const other = discardOf({ ...held, relatedInsert: { ...held.relatedInsert, text: held.relatedInsert.text + ' x' } }, 1);
  assert.equal((await w2.send('put', { body: other })).code, 'ID_REUSED');
  assert.equal(w2.receipt(held.relatedInsert.insertRequestId).state, 'refused');
});

test('W5API-09 Retry against Discard in both orders (serial in this store; the PostgreSQL interleavings are the hosted cases)', async () => {
  for (const first of ['retry', 'discard']) {
    const w = world(), body = insertBody(w);
    hold(w);
    const refused = await w.send('put', { body });
    release(w);
    const discard = discardOf(body, refused.body.relatedInsert.receiptRevision);
    const one = await w.send('put', { body: first === 'retry' ? body : discard });
    const two = await w.send('put', { body: first === 'retry' ? discard : body });
    if (first === 'retry') {
      assert.equal(one.status, 200); assert.equal(two.code, 'RELATED_INSERT_NOT_DISCARDABLE');
      assert.equal(w.receipt(body.relatedInsert.insertRequestId).state, 'applied');
      assert.equal(w.draft().revision, 2);
    } else {
      assert.equal(one.status, 200); assert.equal(two.code, 'RELATED_INSERT_DISCARDED');
      assert.equal(w.receipt(body.relatedInsert.insertRequestId).state, 'discarded');
      assert.equal(w.draft().revision, 1, 'the discard that won leaves the retry nothing to insert');
    }
  }
});

// ── A-03: the Check ──

test('W5API-10 Check reads the envelope and the receipt in one snapshot and writes nothing: absent, applied, superseded, refused, discarded, foreign', async () => {
  const w = world();
  const check = async (id, as = A) => w.send('read', { as, query: { insertRequestId: id } });
  const before = w.snapshot();
  const absent = await check(randomUUID());
  assert.equal(absent.status, 200);
  assertAnswer(absent.body.relatedInsert, { result: 'unknown', state: null, reason: 'RECEIPT_ABSENT', requestHash: null, currentMatches: false }, 'absent');
  assert.equal(absent.body.revision, `${w.epoch}:1`);
  assert.equal(w.snapshot(), before, 'a Check of an unknown ID creates no row');
  const body = insertBody(w);
  await w.send('put', { body });
  const id = body.relatedInsert.insertRequestId, written = w.snapshot();
  const applied = await check(id);
  assertAnswer(applied.body.relatedInsert, { result: 'applied', state: 'applied', currentMatches: true, requestHash: contractHash(body).request }, 'applied');
  assert.equal(applied.body.snapshot.findings, body.findings);
  const foreign = await check(id, B);
  assertAnswer(foreign.body.relatedInsert, { result: 'refused', state: null, reason: 'ID_REUSED', requestHash: null, proposalHash: null,
    expectedRevision: null, receiptRevision: null }, 'another owner');
  w.sa.denied.add(w.source);
  assertAnswer((await check(id)).body.relatedInsert, { result: 'applied' }, 'a Source the caller lost does not change the Target receipt');
  assert.equal(w.snapshot(), written, 'the Checks wrote nothing');
  Object.assign(w.draft(), { findings: 'SYN typed after the insert', revision: 3 });
  assertAnswer((await check(id)).body.relatedInsert, { result: 'unknown', state: 'applied', reason: 'SUPERSEDED', currentMatches: false }, 'superseded');
  assert.equal(w.draft().findings, 'SYN typed after the insert', 'the Check never restores the old proposal');
  const w2 = world(), held = insertBody(w2);
  hold(w2);
  await w2.send('put', { body: held });
  assertAnswer((await w2.send('read', { query: { insertRequestId: held.relatedInsert.insertRequestId } })).body.relatedInsert,
    { result: 'refused', state: 'refused', reason: 'TARGET_HELD', discardable: true }, 'refused');
  await w2.send('put', { body: discardOf(held, 1) });
  assertAnswer((await w2.send('read', { query: { insertRequestId: held.relatedInsert.insertRequestId } })).body.relatedInsert,
    { result: 'refused', state: 'discarded', reason: 'INSERT_DISCARDED', discardable: false }, 'discarded');
});

test('W5API-11 Check snapshot: the envelope and the receipt come from one snapshot even when another commit lands between the two reads', async () => {
  const w = world(), body = insertBody(w);
  hold(w);
  await w.send('put', { body });
  const id = body.relatedInsert.insertRequestId;
  // a discard commits after the Check read the draft and before it reads the receipt: the Check answers its own snapshot
  w.store.hooks.afterRead = { model: 'reportDraft', fn: () => {
    Object.assign(w.store.rows('reportDraftInsertReceipt').find(r => r.insertRequestId === id),
      { state: 'discarded', reason: 'INSERT_DISCARDED', receiptRevision: 2 });
  } };
  const seen = await w.send('read', { query: { insertRequestId: id } });
  assert.equal(w.store.hooks.afterRead, null, 'the concurrent commit landed between the reads');
  assertAnswer(seen.body.relatedInsert, { result: 'refused', state: 'refused', receiptRevision: 1, discardable: true },
    'the receipt as of the snapshot the draft was read in');
  assert.equal(w.receipt(id).state, 'discarded', 'the committed state moved on');
});

test('W5API-12 Check refuses a malformed insertRequestId before any read: uppercase, repeated, empty, not a UUID', async () => {
  const w = world();
  for (const value of [randomUUID().toUpperCase(), [randomUUID(), randomUUID()], '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    const events = w.store.events.length;
    const answer = await w.send('read', { query: { insertRequestId: value } });
    assert.deepEqual([answer.status, answer.code, answer.body.field], [400, 'RELATED_INSERT_INVALID', 'insertRequestId'], JSON.stringify(value));
    assert.deepEqual(w.store.events.slice(events), [], 'nothing read: ' + JSON.stringify(value));
  }
  const plainRead = await w.send('read', {});
  assert.equal(plainRead.status, 200);
  assert.equal('relatedInsert' in plainRead.body, false, 'the ordinary read keeps its envelope');
});

// ── A-01: Source and Target re-validation ──

test('W5API-13 the Source is re-validated on the server: unreadable, hidden preliminary, not a final version, a newer head - refused and never rebased', async () => {
  const cases = [
    ['StudyAccess denied', w => w.sa.denied.add(w.source), 'SOURCE_UNAVAILABLE'],
    ['another institution', w => { w.store.rows('studyState').find(r => r.uid === w.source).institutionId = OTHER; }, 'SOURCE_UNAVAILABLE'],
    ['deleted study', w => { w.store.tables.studyState = w.store.rows('studyState').filter(r => r.uid !== w.source); }, 'SOURCE_UNAVAILABLE'],
    ['hidden preliminary', w => Object.assign(w.store.rows('studyState').find(r => r.uid === w.source), { rs: 'P', preDoc: B.actor, preReviewer: 'syn-x' }), 'SOURCE_UNAVAILABLE'],
    ['newer head', w => { w.store.rows('report').find(r => r.uid === w.source).version = 3;
      w.store.seed('reportVersion', { uid: w.source, version: 3, action: 'reset', findings: '', conclusion: '', recommendation: '', author: B.actor, reason: 'SYN', at: new Date() }); }, 'SOURCE_CHANGED'],
  ];
  for (const [label, change, reason] of cases) {
    const w = world(), body = insertBody(w);
    change(w);
    const answer = await w.send('put', { body });
    assert.deepEqual([answer.status, answer.code], [409, 'RELATED_INSERT_REFUSED'], label + ' ' + JSON.stringify(answer.body));
    assert.equal(answer.body.relatedInsert.reason, reason, label);
    assert.equal(w.draft().revision, 1, label); assert.deepEqual(w.audits(), [], label);
  }
  const w = world();
  const save = insertBody(w, { version: 1, action: 'approve', parts: [{ field: 'findings', start: 0, end: 4 }] });
  w.store.rows('reportVersion').find(r => r.uid === w.source && r.version === 1).action = 'save';
  assert.equal((await w.send('put', { body: save })).body.relatedInsert.reason, 'SOURCE_UNAVAILABLE', 'a save version is not a Source');
});

test('W5API-14 the inserted text is rebuilt on the server from that version: other text, ranges outside or splitting a character are refused before any write', async () => {
  const w = world();
  const tamper = insertBody(w);
  tamper.relatedInsert.text = tamper.relatedInsert.text.replace('line 2', 'line 3');
  tamper.findings = 'SYN draft findings' + tamper.relatedInsert.text;
  const before = w.snapshot();
  const answer = await w.send('put', { body: tamper });
  assert.deepEqual([answer.status, answer.code, answer.body.field], [400, 'RELATED_INSERT_INVALID', 'text']);
  assert.equal(w.snapshot(), before, 'no receipt for an input error');
  const outside = insertBody(w, { parts: [{ field: 'findings', start: 0, end: 4 }] });
  outside.relatedInsert.source.parts = [{ field: 'findings', start: 0, end: PRIOR.findings.length + 1 }];
  assert.equal((await w.send('put', { body: outside })).body.field, 'text');
  const emoji = world();
  emoji.store.rows('reportVersion').find(r => r.uid === emoji.source && r.version === 2).findings = 'SYN 😀 face';
  emoji.store.rows('reportVersion').find(r => r.uid === emoji.source && r.version === 2).conclusion = '';
  const split = insertBody(emoji, { parts: [{ field: 'findings', start: 0, end: 5 }] });
  split.relatedInsert.text = '\nSYN \ud83d'; split.findings = 'SYN draft findings\nSYN \ud83d';
  assert.equal((await emoji.send('put', { body: split })).body.field, 'text');
});

test('W5API-15 the Target rules: Unverified and held are durable refusals; another institution, a hidden preliminary and a technician are refused without a receipt', async () => {
  const unverified = world(), body = insertBody(unverified);
  unverified.store.rows('studyState').find(r => r.uid === TARGET).ss = 'Unverified';
  assert.equal((await unverified.send('put', { body })).body.relatedInsert.reason, 'TARGET_UNVERIFIED');
  for (const [label, change, as, status] of [
    ['another institution', () => {}, C, 404],
    ['hidden preliminary', w => Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { rs: 'P', preDoc: B.actor, preReviewer: 'syn-x' }), A, 403],
    ['technician', () => {}, TECH, 403],
    ['StudyAccess denied', w => w.sa.denied.add(TARGET), A, 404],
  ]) {
    const w = world(), request = insertBody(w, { who: as, ids: as === A ? [CID] : [] });
    change(w);
    const answer = await w.send('put', { as, body: request });
    assert.equal(answer.status, status, label + ' ' + JSON.stringify(answer.body));
    assert.equal(w.receipt(request.relatedInsert.insertRequestId), null, label + ': no receipt');
  }
});

test('W5API-16 replay answers only under the current Target read gate: an applied receipt is not disclosed to a caller the Target now hides', async () => {
  const w = world(), body = insertBody(w);
  assert.equal((await w.send('put', { body })).status, 200);
  Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { rs: 'P', preDoc: B.actor, preReviewer: 'syn-x' });
  const replay = await w.send('put', { body });
  assert.equal(replay.status, 403, JSON.stringify(replay.body));
  assert.equal('relatedInsert' in replay.body, false);
  w.sa.denied.add(TARGET);
  Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { rs: 'A', preDoc: null, preReviewer: null });
  assert.equal((await w.send('put', { body })).status, 404, 'the StudyAccess boundary comes before the receipt');
  assert.equal((await w.send('read', { query: { insertRequestId: body.relatedInsert.insertRequestId } })).status, 404);
});

test('W5API-17 the Target seed: a report-head seed is that head (a moved head is SEED_CHANGED, never rebased); an empty seed; an inconsistent seed kind is refused', async () => {
  const head = { findings: 'SYN target head findings', conclusion: 'SYN target head conclusion', recommendation: '', baseVersion: 1 };
  const w = world();
  w.store.tables.reportDraft = [];
  const body = insertBody(w, { revision: 0, seedKind: 'report-head', seed: head, ids: [] });
  const answer = await w.send('put', { body });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(w.draft().findings, 'SYN target head findings\n' + PRIOR.findings + '\n\n' + PRIOR.conclusion);
  const moved = world();
  moved.store.tables.reportDraft = [];
  moved.store.rows('report').find(r => r.uid === TARGET).version = 2;
  const stale = insertBody(moved, { revision: 0, seedKind: 'report-head', seed: head, ids: [] });
  assert.equal((await moved.send('put', { body: stale })).body.relatedInsert.reason, 'SEED_CHANGED');
  const empty = world();
  empty.store.tables.reportDraft = [];
  empty.store.tables.report = empty.store.rows('report').filter(r => r.uid !== TARGET);
  const seed = { findings: '', conclusion: '', recommendation: '', baseVersion: 0 };
  const fresh = await empty.send('put', { body: insertBody(empty, { revision: 0, seedKind: 'empty', seed, ids: [] }) });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(empty.draft().findings, PRIOR.findings + '\n\n' + PRIOR.conclusion, 'an empty seed takes no leading LF');
  const wrong = world();
  assert.equal((await wrong.send('put', { body: insertBody(wrong, { seedKind: 'report-head' }) })).body.field, 'seedKind');
});

test('W5API-18 the proposal is exactly seed + text at the end of the one section: another field, the Recommendation, the evidence lists or the offset changed are refused', async () => {
  const edits = [
    ['recommendation', { recommendation: 'SYN changed recommendation' }, 'recommendation'],
    ['other section', { conclusion: 'SYN draft conclusion\nmore' }, 'conclusion'],
    ['evidence dropped', { citationIds: [] }, 'citationIds'],
    ['evidence duplicated', { citationIds: [CID, CID] }, 'citationIds'],
  ];
  for (const [label, edit, field] of edits) {
    const w = world(), before = w.snapshot();
    const answer = await w.send('put', { body: insertBody(w, { edit }) });
    assert.deepEqual([answer.status, answer.body.field], [400, field], label + ' ' + JSON.stringify(answer.body));
    assert.equal(w.snapshot(), before, label);
  }
  const w = world();
  const offset = insertBody(w, { operation: { offset: 3 } });
  assert.equal((await w.send('put', { body: offset })).body.field, 'offset');
  // the conclusion seed ends with LF: no leading LF is added there
  const conclusion = insertBody(w, { section: 'conclusion', parts: [{ field: 'recommendation', start: 0, end: PRIOR.recommendation.length }] });
  assert.equal(conclusion.relatedInsert.text, PRIOR.recommendation);
  assert.equal((await w.send('put', { body: conclusion })).status, 200);
  assert.equal(w.draft().conclusion, 'SYN draft conclusion\n' + PRIOR.recommendation);
  assert.equal(w.draft().recommendation, 'SYN draft recommendation', 'the Target Recommendation is never written');
});

test('W5API-19 shape refusals before any read: legacy insert/structure beside it, unknown or missing keys, discard fields on an apply, Target mismatch, blank text, overflow', async () => {
  const w = world();
  const base = insertBody(w);
  const variants = [
    ['legacy citation insert', { ...base, insert: { field: 'findings' } }, 'relatedInsert'],
    ['structure', { ...base, structure: { op: 'apply' } }, 'relatedInsert'],
    ['unknown key', { ...base, relatedInsert: { ...base.relatedInsert, extra: 1 } }, 'relatedInsert'],
    ['missing key', { ...base, relatedInsert: Object.fromEntries(Object.entries(base.relatedInsert).filter(([k]) => k !== 'sourceGeneration')) }, 'relatedInsert'],
    ['expectedReceiptRevision on apply', { ...base, relatedInsert: { ...base.relatedInsert, expectedReceiptRevision: 1 } }, 'relatedInsert'],
    ['discard without its revision', { ...base, relatedInsert: { ...base.relatedInsert, intent: 'discard' } }, 'relatedInsert'],
    ['uppercase ID', { ...base, relatedInsert: { ...base.relatedInsert, insertRequestId: base.relatedInsert.insertRequestId.toUpperCase() } }, 'insertRequestId'],
    ['Target mismatch', { ...base, relatedInsert: { ...base.relatedInsert, targetUid: SECOND_TARGET } }, 'targetUid'],
    ['blank text', { ...base, relatedInsert: { ...base.relatedInsert, text: '\n  ' } }, 'text'],
    ['CR in text', { ...base, relatedInsert: { ...base.relatedInsert, text: base.relatedInsert.text.replace('\n', '\r\n') } }, 'text'],
    ['parts out of order', { ...base, relatedInsert: { ...base.relatedInsert, source: { ...base.relatedInsert.source, parts: [...WHOLE].reverse() } } }, 'source.parts'],
    ['empty range', { ...base, relatedInsert: { ...base.relatedInsert, source: { ...base.relatedInsert.source, parts: [{ field: 'findings', start: 2, end: 2 }] } } }, 'source.parts'],
    ['Target Recommendation section', { ...base, relatedInsert: { ...base.relatedInsert, section: 'recommendation' } }, 'section'],
    ['revision overflow', { ...base, expectedRevision: `${w.epoch}:2147483647` }, 'expectedRevision'],
    ['base version disagrees', { ...base, relatedInsert: { ...base.relatedInsert, targetBaseVersion: 0 } }, 'targetBaseVersion'],
  ];
  for (const [label, body, field] of variants) {
    const events = w.store.events.length;
    const answer = await w.send('put', { body });
    assert.deepEqual([answer.status, answer.code, answer.body.field], [400, 'RELATED_INSERT_INVALID', field], label + ' ' + JSON.stringify(answer.body));
    assert.deepEqual(w.store.events.slice(events), [], label + ': nothing read');
  }
});

// ── A-08: atomicity, DB errors, restart, PK race, lock order ──

test('W5API-20 an audit or receipt write that fails rolls back the draft, the audit and the receipt together; the same ID then applies once', async () => {
  for (const [model, op] of [['auditLog', 'create'], ['reportDraftInsertReceipt', 'create']]) {
    const w = world(), body = insertBody(w), before = w.snapshot();
    w.store.faults.push({ model, op, error: new Error('SYN write failed') });
    const failed = await w.send('put', { body });
    assert.equal(failed.code, 'NOT_HTTP', model + ': an unknown outcome, never a refusal');
    assert.equal(w.snapshot(), before, model + ': nothing of the draft, audit or receipt is left');
    const check = await w.send('read', { query: { insertRequestId: body.relatedInsert.insertRequestId } });
    assertAnswer(check.body.relatedInsert, { result: 'unknown', reason: 'RECEIPT_ABSENT' }, model + ': the Check says unknown');
    assert.equal((await w.send('put', { body })).status, 200, model + ': the same ID retried');
    assert.equal(w.draft().revision, 2);
    assert.equal(w.audits().length, 1);
  }
});

test('W5API-21 a database error while judging the Source never becomes a refused receipt', async () => {
  const w = world(), body = insertBody(w), before = w.snapshot();
  w.store.faults.push({ model: 'studyState', op: 'findUnique', uid: w.source, error: Object.assign(new Error('SYN connection lost'), { code: 'P1017' }) });
  const failed = await w.send('put', { body });
  assert.notEqual(failed.code, 'RELATED_INSERT_REFUSED', JSON.stringify(failed.body));
  assert.equal(w.receipt(body.relatedInsert.insertRequestId), null);
  assert.equal(w.snapshot(), before);
});

test('W5API-22 a new process over the same store answers the same ID from the durable receipt', async () => {
  const w = world(), body = insertBody(w);
  assert.equal((await w.send('put', { body })).status, 200);
  const before = w.snapshot();
  w.build();   // nothing of the old process's memory
  const replay = await w.send('put', { body });
  assert.equal(replay.status, 200);
  assertAnswer(replay.body.relatedInsert, { result: 'applied', appliedRevision: `${w.epoch}:2` }, 'after restart');
  assert.equal(w.snapshot(), before);
});

test('W5API-23 a primary key race with another Target is ID_REUSED and rolls this insertion back; the other row is not disclosed', async () => {
  const w = world(), body = insertBody(w), before = w.snapshot();
  const id = body.relatedInsert.insertRequestId;
  // another Target's transaction commits the same ID after this one found no receipt under its lock
  w.store.hooks.afterReceiptLock = async () => { w.store.rows('reportDraftInsertReceipt').push({ insertRequestId: id, targetUid: SECOND_TARGET,
    ownerInstitution: INST, ownerSub: B.sub, ownerAuthor: B.actor, requestHash: 'e'.repeat(64), proposalHash: 'f'.repeat(64),
    expectedEpoch: w.epoch, expectedRevision: 0, sourceUid: w.source, sourceVersion: 2, targetBaseVersion: 0, section: 'findings',
    state: 'applied', appliedRevision: 1, reason: null, receiptRevision: 1, createdAt: new Date(), updatedAt: new Date() }); };
  const raced = await w.send('put', { body });
  assert.deepEqual([raced.status, raced.code], [409, 'ID_REUSED']);
  assert.deepEqual(Object.keys(raced.body).sort(), ['code', 'message']);
  const after = JSON.parse(w.snapshot());
  assert.deepEqual(after.reportDraft, JSON.parse(before).reportDraft, 'the draft write rolled back');
  assert.deepEqual(after.auditLog ?? [], []);
});

test('W5API-25 lock order: session -> policy -> Source/Target rows in one UID order -> own draft -> receipt, for A<-B and B<-A; a discard locks no Source', async () => {
  for (const source of [SOURCE_LOW, SOURCE_HIGH]) {
    const w = world({ source });
    w.store.seed('authSession', { sid: 'syn-sid' });
    const body = insertBody(w);
    const events = w.store.events.length;
    const key = ROUTES.put, args = [];
    for (const [slot, { index, data }] of Object.entries(Reflect.getMetadata(ROUTE_ARGS_METADATA, PacsController, key))) {
      const type = Number(slot.split(':')[0]);
      args[index] = type === RouteParamtypes.PARAM ? TARGET : type === RouteParamtypes.BODY ? body
        : { sub: A.sub, actor: A.actor, roles: A.roles, institution: A.institution, kind: 'member', headers: {}, authMethod: 'session', sid: 'syn-sid' };
      void data;
    }
    await w.controller[key](...args);
    // the write transaction (the read-only replay check before it locks nothing and is W5API-28's)
    const seen = w.store.events.slice(events), from = seen.indexOf('tx lock session'), check = seen.indexOf('tx commit');
    assert.ok(check > 0 && check < from, 'a read-only replay check commits before the write transaction takes the session lock');
    assert.equal(seen.slice(0, check).some(e => /^tx lock/.test(e) || e.includes(source)), false, 'the replay check locks nothing and reads no Source');
    const locks = seen.slice(from).filter(e => /^tx (lock|require)/.test(e));
    const rows = [TARGET, source].sort().map(uid => `tx lock StudyState ${uid} ${uid === TARGET ? 'UPDATE' : 'SHARE'}`);
    assert.deepEqual(locks.slice(0, 2 + rows.length + 2), ['tx lock session', `tx require ${JSON.stringify([TARGET])}`, ...rows,
      'tx lock ReportDraft', 'tx lock ReportDraftInsertReceipt'], source);
    const w2 = world({ source }), held = insertBody(w2);
    hold(w2);
    await w2.send('put', { body: held });
    const start = w2.store.events.length;
    await w2.send('put', { body: discardOf(held, 1) });
    assert.equal(w2.store.events.slice(start).some(e => e.includes(source)), false, 'a discard locks and reads no Source');
  }
});

test('W5API-26 ordinary callers keep the epoch refusal and their own statements: no Source lock, no receipt read', async () => {
  const w = world();
  const ordinary = { expectedOwner: ownerOf(A), expectedRevision: `${randomUUID()}:1`, findings: 'SYN ordinary', conclusion: '',
    recommendation: '', baseVersion: 1, citationIds: [CID], structureIds: [] };
  const stale = await w.send('put', { body: ordinary });
  assert.deepEqual([stale.status, stale.code], [409, 'REPORT_DRAFT_CONFLICT']);
  const events = w.store.events.length;
  const saved = await w.send('put', { body: { ...ordinary, expectedRevision: `${w.epoch}:1` } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal('relatedInsert' in saved.body, false);
  const seen = w.store.events.slice(events).join('\n');
  assert.equal(seen.includes('ReportDraftInsertReceipt'), false);
  assert.equal(seen.includes(w.source), false);
  assert.deepEqual(w.store.rows('reportDraftInsertReceipt'), []);
});

// ── A-05: the double's transcription of the migration (the real DDL is proved by the hosted PostgreSQL cases) ──

test('W5API-27 store double fidelity: each receipt CHECK clause and guard branch refuses, SQL NULL included; JSON null is not SQL NULL', async () => {
  const w = world(), body = insertBody(w);
  await w.send('put', { body });
  const receipt = w.receipt(body.relatedInsert.insertRequestId);
  const db = w.store.client.reportDraftInsertReceipt;
  const fresh = extra => ({ ...receipt, insertRequestId: randomUUID(), ...extra });
  for (const [label, extra, sqlstate] of [
    ['section', { section: 'recommendation' }, '23514'], ['uppercase hash', { requestHash: 'A'.repeat(64) }, '23514'],
    ['applied without its revision', { appliedRevision: null }, '23514'], ['applied revision not +1', { appliedRevision: 5 }, '23514'],
    ['refused without a reason', { state: 'refused', appliedRevision: null, reason: null }, '23514'],
    ['refused with an open reason', { state: 'refused', appliedRevision: null, reason: 'ANYTHING' }, '23514'],
    ['discarded with another reason', { state: 'discarded', appliedRevision: null, reason: 'TARGET_HELD' }, '23514'],
    ['expected revision at the Int maximum', { expectedRevision: 2147483647, appliedRevision: null, state: 'refused', reason: 'TARGET_HELD' }, '23514'],
    ['SQL NULL owner', { ownerSub: null }, '23502'],
  ]) await assert.rejects(db.create({ data: fresh(extra) }), e => e.meta?.code === sqlstate, label);
  await assert.rejects(db.create({ data: { ...receipt } }), e => e.code === 'P2002', 'primary key');
  await assert.rejects(db.updateMany({ where: { insertRequestId: receipt.insertRequestId }, data: { receiptRevision: 2 } }), e => e.meta?.code === '42501', 'terminal');
  const refused = fresh({ state: 'refused', appliedRevision: null, reason: 'TARGET_HELD' });
  await db.create({ data: refused });
  await assert.rejects(db.updateMany({ where: { insertRequestId: refused.insertRequestId }, data: { reason: 'SOURCE_CHANGED' } }), e => e.meta?.code === '42501', 'revision');
  await assert.rejects(db.updateMany({ where: { insertRequestId: refused.insertRequestId }, data: { requestHash: 'c'.repeat(64), receiptRevision: 2 } }), e => e.meta?.code === '42501', 'binding');
  await assert.rejects(db.deleteMany({ where: { insertRequestId: refused.insertRequestId } }), e => e.meta?.code === '42501', 'delete');
  assert.equal((await db.updateMany({ where: { insertRequestId: refused.insertRequestId }, data: { state: 'discarded', reason: 'INSERT_DISCARDED', receiptRevision: 2 } })).count, 1);
  // ReportDraft: an emptied row holding a JSON null where SQL NULL is required is refused; jsonb hands keys back in its own order
  await assert.rejects(w.store.client.reportDraft.updateMany({ where: { uid: TARGET, author: A.actor },
    data: { present: false, findings: '', conclusion: '', recommendation: '', baseVersion: 0, citations: Prisma.JsonNull, structured: Prisma.DbNull, revision: 9 } }),
  e => e.meta?.code === '23514');
  const [entry] = (await w.store.client.reportDraft.findUnique({ where: { uid_author: { uid: TARGET, author: A.actor } } })).citations;
  assert.deepEqual(Object.keys(entry).slice(0, 3), ['v', 'cid', 'field'], 'shorter keys first');
});

// ── A-02 / A-03 (Astra W5A-01): a finished receipt is answered under the current Target gate alone ──

test('W5API-28 applied and discarded replays, ID_REUSED and SUPERSEDED need no Source: failing Source preparation, lost Source access, a locked Source row', async () => {
  for (const blocker of ['prepare', 'access', 'lock']) {
    const w = world();
    const applied = insertBody(w);
    assert.equal((await w.send('put', { body: applied })).status, 200, blocker);
    // an insertion frozen on the old revision: refused (DRAFT_CONFLICT), then discarded
    const stale = insertBody(w);
    assert.equal((await w.send('put', { body: stale })).body.relatedInsert.reason, 'DRAFT_CONFLICT', blocker);
    assert.equal((await w.send('put', { body: discardOf(stale, 1) })).status, 200, blocker);
    if (blocker === 'prepare') w.sa.prepareFails.add(w.source);
    if (blocker === 'access') w.sa.denied.add(w.source);
    if (blocker === 'lock') w.store.lockedRows.add(w.source);
    const before = w.snapshot(), events = w.store.events.length;
    const replay = await w.send('put', { body: applied });
    assert.equal(replay.status, 200, `${blocker}: the applied replay ${JSON.stringify(replay.body)}`);
    assertAnswer(replay.body.relatedInsert, { result: 'applied', state: 'applied', currentMatches: true }, blocker + ' applied replay');
    const discarded = await w.send('put', { body: stale });
    assert.deepEqual([discarded.status, discarded.code], [409, 'RELATED_INSERT_DISCARDED'], blocker);
    assert.equal((await w.send('put', { body: discardOf(stale, 1) })).status, 200, blocker + ': a resent discard');
    const other = { ...applied, relatedInsert: { ...applied.relatedInsert, selectionSeq: 99 } };
    assert.deepEqual([(await w.send('put', { body: other })).code], ['ID_REUSED'], blocker);
    assert.equal(w.store.events.slice(events).some(e => e.includes(w.source)), false, `${blocker}: no Source preparation, lock or read`);
    assert.equal(w.snapshot(), before, blocker + ': nothing written');
    // a genuinely new insertion does need the Source: it meets the blocker and leaves no row on a non-refusal
    const fresh = insertBody(w, { revision: 2, seed: { findings: w.draft().findings, conclusion: 'SYN draft conclusion\n',
      recommendation: 'SYN draft recommendation', baseVersion: 1 } });
    const blocked = await w.send('put', { body: fresh });
    if (blocker === 'access') assert.equal(blocked.body.relatedInsert.reason, 'SOURCE_UNAVAILABLE', blocker);
    else {
      assert.equal(blocked.status, 503, `${blocker}: ${JSON.stringify(blocked.body)}`);
      assert.equal(w.receipt(fresh.relatedInsert.insertRequestId), null, blocker + ': no refused row for an unknown outcome');
    }
    // the Target gate still decides first, and a moved draft is still SUPERSEDED
    Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { rs: 'P', preDoc: B.actor, preReviewer: 'syn-x' });
    assert.equal((await w.send('put', { body: applied })).status, 403, blocker);
    Object.assign(w.store.rows('studyState').find(r => r.uid === TARGET), { rs: 'A', preDoc: null, preReviewer: null });
    w.sa.denied.add(TARGET);
    assert.equal((await w.send('put', { body: applied })).status, 404, blocker);
    w.sa.denied.delete(TARGET);
    Object.assign(w.draft(), { findings: 'SYN typed after the insert', revision: 3 });
    assert.equal((await w.send('put', { body: applied })).code, 'RELATED_INSERT_SUPERSEDED', blocker);
  }
});

test('W5API-29 after a new draft epoch a refused receipt is judged before the epoch: its retry is a durable DRAFT_CONFLICT and it can still be discarded', async () => {
  const w = world(), body = insertBody(w);
  hold(w);
  assert.equal((await w.send('put', { body })).body.relatedInsert.reason, 'TARGET_HELD');
  release(w);
  w.store.rows('studyState').find(r => r.uid === TARGET).draftEpoch = randomUUID();   // a force-discard rotated the epoch
  const retry = await w.send('put', { body });
  assert.deepEqual([retry.status, retry.code], [409, 'RELATED_INSERT_REFUSED'], JSON.stringify(retry.body));
  assertAnswer(retry.body.relatedInsert, { state: 'refused', reason: 'DRAFT_CONFLICT', receiptRevision: 2, discardable: true }, 'old epoch');
  const discard = await w.send('put', { body: discardOf(body, 2) });
  assert.equal(discard.status, 200, JSON.stringify(discard.body));
  assertAnswer(discard.body.relatedInsert, { state: 'discarded', receiptRevision: 3 }, 'discard after the epoch');
});

test('W5API-30 a receipt finished between the replay check and the lock is judged again under the lock: a late discard meets the applied retry', async () => {
  const w = world(), body = insertBody(w);
  hold(w);
  await w.send('put', { body });
  release(w);
  const id = body.relatedInsert.insertRequestId;
  // the discard's replay check reads the refused receipt; a retry then commits applied before the discard takes the Target lock
  w.store.hooks.afterRead = { model: 'reportDraftInsertReceipt', fn: () => {
    Object.assign(w.store.rows('reportDraftInsertReceipt').find(r => r.insertRequestId === id),
      { state: 'applied', appliedRevision: 2, reason: null, receiptRevision: 2 });
    Object.assign(w.draft(), { findings: body.findings, revision: 2 });
  } };
  const late = await w.send('put', { body: discardOf(body, 1) });
  assert.equal(w.store.hooks.afterRead, null, 'the concurrent apply landed between the check and the lock');
  assert.deepEqual([late.status, late.code], [409, 'RELATED_INSERT_NOT_DISCARDABLE'], JSON.stringify(late.body));
  assertAnswer(late.body.relatedInsert, { state: 'applied', result: 'applied' }, 'judged under the lock');
  assert.equal(w.receipt(id).state, 'applied');
});

/** An applied, a discarded and a refused insertion on the Target, each through the product (the W5API-28 fixture plus a hold). */
async function finishedInsertions(w) {
  const applied = insertBody(w);
  assert.equal((await w.send('put', { body: applied })).status, 200);
  const discarded = insertBody(w);            // frozen on the old revision: refused (DRAFT_CONFLICT), then discarded
  assert.equal((await w.send('put', { body: discarded })).body.relatedInsert.reason, 'DRAFT_CONFLICT');
  assert.equal((await w.send('put', { body: discardOf(discarded, 1) })).status, 200);
  const seed = { findings: w.draft().findings, conclusion: 'SYN draft conclusion\n', recommendation: 'SYN draft recommendation', baseVersion: 1 };
  const refused = insertBody(w, { revision: 2, seed });
  hold(w);
  assert.equal((await w.send('put', { body: refused })).body.relatedInsert.reason, 'TARGET_HELD');
  release(w);
  return { applied, discarded, refused, fresh: () => insertBody(w, { revision: 2, seed }) };
}

test('W5API-31 WORKLIST-SPLIT-UID: a Target two patient resources answer is 409 STUDY_IDENTITY_UNRESOLVED to every insertion PUT and Check - applied, discarded or refused receipt, or a new ID - before any receipt is read, with no receipt or envelope in the answer and nothing written', async () => {
  const w = world(), { applied, discarded, refused, fresh } = await finishedInsertions(w);
  w.sa.split.add(TARGET);
  const before = w.snapshot(), events = w.store.events.length;
  for (const [label, body] of [['applied replay', applied], ['discarded apply', discarded], ['resent discard', discardOf(discarded, 1)],
      ['refused retry', refused], ['refused discard', discardOf(refused, 1)], ['applied discard', discardOf(applied, 1)], ['new ID', fresh()]]) {
    const answer = await w.send('put', { body });
    assert.deepEqual([answer.status, answer.code], [409, 'STUDY_IDENTITY_UNRESOLVED'], `${label}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'message'], label + ': no receipt, revision or envelope');
  }
  for (const body of [applied, discarded, refused, fresh()]) {
    const check = await w.send('read', { query: { insertRequestId: body.relatedInsert.insertRequestId } });
    assert.deepEqual([check.status, check.code, Object.keys(check.body).sort()], [409, 'STUDY_IDENTITY_UNRESOLVED', ['code', 'message']]);
  }
  assert.equal(w.snapshot(), before, 'nothing written');
  const seen = w.store.events.slice(events);
  assert.equal(seen.some(e => /reportDraftInsertReceipt|ReportDraftInsertReceipt|ReportDraft\b|reportDraft /.test(e)), false,
    'neither a receipt nor a draft is read or locked: ' + seen.join(' | '));
  assert.equal(seen.some(e => e.includes(w.source)), false, 'no Source preparation, observation or read');
  // scope still decides first: an out-of-scope split Target is 404, never the split answer
  w.sa.denied.add(TARGET);
  assert.equal((await w.send('put', { body: applied })).status, 404);
  assert.equal((await w.send('read', { query: { insertRequestId: applied.relatedInsert.insertRequestId } })).status, 404);
  w.sa.denied.delete(TARGET);
  // a Target whose resources cannot be observed now is 503 STUDY_SOURCE_UNAVAILABLE, equally before the receipt
  w.sa.split.delete(TARGET); w.sa.unobservable.add(TARGET);
  const unobserved = await w.send('put', { body: applied });
  assert.deepEqual([unobserved.status, unobserved.code], [503, 'STUDY_SOURCE_UNAVAILABLE']);
  w.sa.unobservable.delete(TARGET);
  assert.equal((await w.send('put', { body: applied })).status, 200, 'resolved: the replay answers again');
  assert.equal(w.snapshot(), before, 'still nothing written');
});

test('W5API-32 WORKLIST-SPLIT-UID: a split Source refuses a new apply and a refused retry (409, no receipt row or change, nothing written) after the Source scope gate; replay, Check and discard need no Source observation and still answer under the Target', async () => {
  for (const blocker of ['split', 'unobservable']) {
    const w = world(), { applied, discarded, refused, fresh } = await finishedInsertions(w);
    w.sa[blocker].add(w.source);
    const before = w.snapshot(), events = w.store.events.length;
    const want = blocker === 'split' ? [409, 'STUDY_IDENTITY_UNRESOLVED'] : [503, 'STUDY_SOURCE_UNAVAILABLE'];
    const newApply = fresh();
    const blocked = await w.send('put', { body: newApply });
    assert.deepEqual([blocked.status, blocked.code], want, `${blocker} new apply: ${JSON.stringify(blocked.body)}`);
    assert.equal(w.receipt(newApply.relatedInsert.insertRequestId), null, blocker + ': no refused row for an identity refusal');
    const retry = await w.send('put', { body: refused });
    assert.deepEqual([retry.status, retry.code], want, blocker + ' refused retry');
    assert.equal(w.snapshot(), before, blocker + ': nothing written, the refused receipt unchanged');
    const observed = w.store.events.slice(events);
    assert.ok(observed.includes('root identity ' + JSON.stringify([w.source])), blocker + ': a new apply observes its Source outside the transaction');
    const unsplitAt = observed.indexOf('assert unsplit ' + w.source);
    const sourceGate = observed.findIndex(e => e === `tx require ${JSON.stringify([w.source])}`);
    assert.ok(sourceGate >= 0 && unsplitAt > sourceGate, blocker + ': the Source scope gate decides before the identity refusal');
    assert.equal(observed.slice(unsplitAt).some(e => /read (reportVersion|report) .*/.test(e) && e.includes(w.source)), false,
      blocker + ': no Source version or head is read');
    // the finished answers are unchanged and never touch the Source
    const quiet = w.store.events.length;
    const replay = await w.send('put', { body: applied });
    assert.equal(replay.status, 200, blocker);
    assertAnswer(replay.body.relatedInsert, { result: 'applied', state: 'applied', currentMatches: true }, blocker + ' replay');
    assert.deepEqual([(await w.send('put', { body: discarded })).code], ['RELATED_INSERT_DISCARDED'], blocker);
    assert.equal((await w.send('put', { body: discardOf(discarded, 1) })).status, 200, blocker + ': resent discard');
    const check = await w.send('read', { query: { insertRequestId: applied.relatedInsert.insertRequestId } });
    assert.deepEqual([check.status, check.body.relatedInsert.result], [200, 'applied'], blocker + ': Check');
    const discard = await w.send('put', { body: discardOf(refused, 1) });
    assert.equal(discard.status, 200, `${blocker}: the refused insertion is still discardable ${JSON.stringify(discard.body)}`);
    assertAnswer(discard.body.relatedInsert, { state: 'discarded', receiptRevision: 2 }, blocker + ' discard');
    assert.equal(w.store.events.slice(quiet).some(e => e.includes(w.source)), false, blocker + ': no Source observation, gate or read');
  }
});
