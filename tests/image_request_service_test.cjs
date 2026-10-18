'use strict';
/* TEST-S5-U4c-ACCESS: the compiled image request service over a stub store and a recording Orthanc.
 * REQ-S5-U4p-STUDY-ACCESS-READ / REQ-S5-U4p-IDEMPOTENCY / REQ-S5-U4p-CONNECT-SEPARATE -> RISK-S5-U4p-ACCESS-READ-CONFLATION /
 * REPLAY-HISTORY / REQUEST-AS-TRANSFER (contract S5-U4p section 4.1, 7.1, 10.2, 11).
 *
 * The real StudyAccessService (compiled, /app/dist) decides access; only Prisma and Orthanc are stubs, as in
 * study_access_service_test.cjs and clinician_question_service_test.cjs. Every stub call is logged in order, so "the
 * source read ends before the transaction starts" and "no Orthanc call inside the transaction callback" are read from one
 * event list.
 *   (1) a metadata rule: the source tags are read before $transaction and the callback makes no Orthanc call (create:
 *       studyIdentityResources, every resource of its one study (WORKLIST-SPLIT-UID); a change and its replay: studyIdentities(true));
 *   (2) the policy revision moves during the source read: 409 STUDY_ACCESS_CHANGED, no transaction, no request, receipt
 *       or audit write (create, change, replay);
 *   (3) the source read fails: 503, no transaction, no write (create, change, replay);
 *   (4) the constructor takes PrismaService and StudyAccessService only (no OrthancService, no ConnectService), and two
 *       kinds of evidence, both from service_boundary_observation.cjs (W4X-03 r3, Astra consult R3-2..R3-8):
 *       - a STATIC check of the ordinary direct imports: every literal require(...) call in the compiled module's
 *         TypeScript AST, resolved by Node from that file, names neither service's module, wherever the call sits (a
 *         real require at load, in view=mine, in a cursor page or kind filter of list, in create's error path, a TS
 *         import() compiled to CommonJS, a .js specifier is refused; a JS comment or an unused string passes); the
 *         recording require still sees an executed load or alias;
 *       - an OBSERVATION over the executed contract matrix (every route and both list views): a recording Connect store
 *         sees no call on the transfer, transferBasis or processingAgreement delegate of the root or transaction client,
 *         and no raw statement of either client ($queryRaw, $executeRaw, $queryRawUnsafe, $executeRawUnsafe), assembled by
 *         the product's Prisma and parsed by PostgreSQL's parser, reads or writes the "Transfer", "TransferBasis" or
 *         "ProcessingAgreement" table. A statement the parser refuses is recorded too, never taken as no access. SQL
 *         comments (line, block, nested), string literals and bound values naming those tables behave the same and pass;
 *         a delegate call, a raw read or write (also after a '--' literal, behind `-- /*`, through Prisma.raw or a nested
 *         Prisma.Sql, by an *Unsafe method) is refused; the service's own SET LOCAL site sending a CTE with a '--'
 *         literal before a DELETE of "Transfer" is refused and sending `SET LOCAL application_name = '"Transfer"'` passes
 *         (D1550). Not claimed: raw statements on paths these flows do not run, SQL built by helpers elsewhere, views or
 *         server functions, createRequire or other loaders; these are limits of the check, not all of them adversarial;
 *   (5) a recording Orthanc sees only studyIdentityResources and studyIdentities(true) across create, accept, replay, read,
 *       forStudy, list and close, and nothing at all when the policy has no metadata rule.
 * Also pinned over the same stubs: every applied requestId replays its stored receipt without a write, after Closed and
 * after a new active request; reuse is 409 REQUEST_ID_REUSED; the active-request rule, the counterparty check, the
 * transition table, the action roles and the audit detail keys without text; the lock order (StudyState before the
 * request row and the counterparty Institution, the receipt lookup after them); and #8/#9 in one RepeatableRead snapshot.
 * Hosted only (kin-api:ci): no /app/dist exists on a development host.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { basename, dirname } = require('node:path');
const vm = require('node:vm');
const { ImageRequestService, IMAGE_REQUEST_AUDIT_ACTION } = require('/app/dist/image-request.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { OWNER_ONLY_AUDIT_ACTIONS } = require('/app/dist/pacs.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { ConnectService } = require('/app/dist/connect.service');
const { Prisma, staticRequires, latentRequires, withRawExecuteText, rawStatement, sqlRelations } = require('./service_boundary_observation.cjs');

const uid = '2.25.4343';
const institution = 'synthetic';
const counterparty = 'synthetic-other';
const member = (name, roles) => ({ kind: 'member', institution, sub: 'synthetic-' + name + '-sub', actor: 'synthetic-' + name,
  roles, name: 'SYNTHETIC ' + name });
const clinician = member('clinician', ['clinician']);
const technician = member('tech', ['technician']);
const radiologist = member('reader', ['radiologist']);
const admin = member('admin', ['admin']);
const owner = c => [c.institution, c.sub];
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const metadataPolicy = () => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: 'SYNTHETIC-PATIENT', modalities: [], dateFrom: null, dateTo: null, studyUids: [] }] });
const uidPolicy = () => ({ version: 1, restricted: true, startsAt: null, endsAt: null,
  rules: [{ patientId: null, modalities: [], dateFrom: null, dateTo: null, studyUids: [uid] }] });
const source = u => ({ '0020000D': { Value: [u] }, '00100020': { Value: ['SYNTHETIC-PATIENT'] } });
const code = (status, value) => e => typeof e?.getStatus === 'function' && e.getStatus() === status
  && (value === undefined || e.getResponse()?.code === value);
const seeded = (n, state, revision) => ({ id: id(n), studyUid: uid, institutionId: institution, kind: 'image-transfer',
  requesterSub: clinician.sub, requesterActor: clinician.actor, requesterName: clinician.name,
  counterpartyText: 'SYNTHETIC hospital', counterpartyInstitutionId: null, reason: 'SYNTHETIC reason', state, revision,
  handlerActor: null, handlerName: null, note: null, changedBy: clinician.actor, createdAt: new Date(0), updatedAt: new Date(0) });
// The Connect family of api/prisma/schema.prisma (contract S5-U4p section 10.2: a request is never a transfer).
const CONNECT_DELEGATES = ['transfer', 'transferBasis', 'processingAgreement'];
const CONNECT_TABLES = ['Transfer', 'TransferBasis', 'ProcessingAgreement'];
// The row lock of a statement, from the parser's locking clauses (a comment saying FOR UPDATE takes no lock).
const LOCK = { LCS_FORUPDATE: ' FOR UPDATE', LCS_FORNOKEYUPDATE: ' FOR NO KEY UPDATE', LCS_FORSHARE: ' FOR SHARE',
  LCS_FORKEYSHARE: ' FOR KEY SHARE' };

/**
 * One synthetic store: the study's owner, StudyAccessPolicy, requests, receipts and audit rows, with an ordered event log.
 * `statements` repeats `events` with the row lock of each SQL statement; `transactions` keeps the options of every
 * $transaction. A RepeatableRead transaction reads a copy of the store taken when it starts (PostgreSQL fixes the snapshot
 * at its first statement; nothing commits in between here); any other transaction and the root client read the live
 * store per statement, as ReadCommitted does. Writes always go to the live store. `between({event: step})` runs each
 * step once, right after that statement of the NEXT transaction to start, as a commit landing between two statements.
 */
function world(policy, { requests = [], receipts = [], Service = ImageRequestService } = {}) {
  const events = [], statements = [], transactions = [], calls = [], audits = [], connect = [];
  const writes = { request: 0, update: 0, receipt: 0, audit: 0 };
  const store = { requests: new Map(requests.map(r => [r.id, { ...r }])), receipts: new Map(receipts.map(r => [r.requestId, { ...r }])),
    study: { institutionId: institution } };
  const institutions = new Set([institution, counterparty]);
  const w = { events, statements, transactions, calls, audits, writes, store, connect,
    policyRow: policy ? { institution, revision: 1, policy, reason: '', updatedBy: null, updatedAt: null } : null };
  // The Connect store records every call instead of failing it, so only the observation refuses a transfer call.
  const connectDelegate = (where, name) => new Proxy({}, { get: (_target, method) => async () => {
    connect.push(where + ':' + name + '.' + String(method)); return method === 'findMany' ? [] : null;
  } });
  const connectDelegates = where => Object.fromEntries(CONNECT_DELEGATES.map(name => [name, connectDelegate(where, name)]));
  let target = null, steps = new Map();
  w.between = next => { steps = new Map(Object.entries(next)); target = 'next'; };
  w.pending = () => [...steps.keys()];
  const log = (event, lock = '') => { events.push(event); statements.push(event + lock); };
  const after = async (index, event) => {
    if (index === null || index !== target || !steps.has(event)) return;
    const step = steps.get(event);
    steps.delete(event);
    await step();
  };
  const kind = sql => sql.includes('pg_advisory') ? 'advisory' : sql.includes('"StudyAccessPolicy"') ? 'policy'
    : sql.includes('FROM "StudyImageRequest" r') ? 'list' : sql.includes('FROM "StudyImageRequest" WHERE "studyUid"') ? 'active'
      : sql.includes('FROM "StudyImageRequest" WHERE id') ? 'request' : sql.includes('"Institution"') ? 'institution'
        : sql.includes('"StudyState"') ? 'study' : 'unknown';
  // Every raw call of either client, read or write, tagged or *Unsafe, passes one observation: the statement as the
  // product's Prisma assembles it, parsed by PostgreSQL's parser. One that reads or writes a Connect table, or that the
  // parser refuses, is recorded, not run; the others run on the stub (kind() routes the product's own statements).
  const raw = async (where, method, view, index, args) => {
    const { text, values } = rawStatement(method, args);
    const write = method.startsWith('$execute');
    let parsed;
    try { parsed = await sqlRelations(text); } catch (_) { connect.push(where + ':sql unparsed'); return write ? 0 : []; }
    const named = [...new Set(parsed.relations.filter(name => CONNECT_TABLES.includes(name)))];
    if (named.length) {
      for (const name of named) connect.push(where + ':sql "' + name + '"');
      return write ? 0 : [];
    }
    if (write) { log(where + ':execute'); return 0; }
    return query(where, view, index, text, values, parsed.locks);
  };
  const rawMethods = (where, view, index) => Object.fromEntries(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe']
    .map(method => [method, (...args) => raw(where, method, view, index, args)]));
  const query = async (where, view, index, sql, values, locks) => {
    const k = kind(sql);
    log(where + ':' + k, locks.map(lock => LOCK[lock]).join(''));
    let rows;
    if (k === 'advisory') rows = [{ locked: 1 }];
    else if (k === 'policy') rows = w.policyRow ? [w.policyRow] : [];
    else if (k === 'list') rows = [];
    else if (k === 'request') { const row = view.requests.get(values[0]); rows = row ? [{ ...row }] : []; }
    else if (k === 'active') rows = [...view.requests.values()].filter(r => r.studyUid === values[0] && r.kind === values[1]
      && r.requesterSub === values[2] && ['Requested', 'Accepted'].includes(r.state)).map(r => ({ id: r.id }));
    else if (k === 'institution') rows = institutions.has(values[0]) ? [{ id: values[0] }] : [];
    else if (k === 'study') rows = values[0] === uid ? [{ uid, institutionId: view.study.institutionId }] : [];
    else throw new Error('unexpected SQL in the stub: ' + sql);
    await after(index, where + ':' + k);
    return rows;
  };
  const client = (view, index) => ({
    ...connectDelegates('tx'),
    ...rawMethods('tx', view, index),
    studyImageRequest: {
      create: async ({ data }) => { log('tx:write'); writes.request++; store.requests.set(data.id, { ...data }); return data; },
      update: async ({ where, data }) => {
        log('tx:write'); writes.update++;
        const row = { ...store.requests.get(where.id), ...data }; store.requests.set(where.id, row); return row;
      },
    },
    studyImageRequestReceipt: {
      findUnique: async ({ where }) => { log('tx:receipt'); const row = view.receipts.get(where.requestId); return row ? { ...row } : null; },
      create: async ({ data }) => { log('tx:write'); writes.receipt++; store.receipts.set(data.requestId, { ...data }); return data; },
    },
    auditLog: { create: async ({ data }) => { log('tx:write'); writes.audit++; audits.push(data); return data; } },
  });
  const prisma = {
    ...connectDelegates('root'),
    ...rawMethods('root', store, null),
    $transaction: async (fn, options) => {
      const index = transactions.push(options) - 1;
      if (target === 'next') target = index;
      const view = options?.isolationLevel === 'RepeatableRead' ? structuredClone(store) : store;
      log('tx:start');
      const result = await fn(client(view, index));
      log('tx:end');
      return result;
    },
    studyState: { findMany: async () => { log('root:studies'); return [{ uid }]; } },
  };
  w.handlers = { studyIdentityResources: async u => [source(u)], studyIdentities: async () => [source(uid)] };
  // Records every member the service stack touches, not only the two it is allowed to use.
  const orthanc = new Proxy({}, { get: (_target, name) => async (...args) => {
    calls.push({ name: String(name), args }); events.push('orthanc:' + String(name));
    const handler = w.handlers[name];
    return handler ? handler(...args) : null;
  } });
  w.access = new StudyAccessService(prisma, orthanc, {});
  w.svc = new Service(prisma, w.access);
  w.bumpPolicy = () => { w.policyRow = { ...w.policyRow, revision: w.policyRow.revision + 1 }; };
  return w;
}

const create = (w, c, requestId, extra = {}) => w.svc.create(uid, c, { requestId, expectedOwner: owner(c), kind: 'image-transfer',
  counterparty: 'SYNTHETIC receiving hospital', counterpartyInstitutionId: null, reason: 'SYNTHETIC reason', ...extra });
const change = (w, target, c, requestId, revision, action, note = action === 'accept' ? '' : 'SYNTHETIC note') =>
  w.svc.change(target, c, { requestId, expectedOwner: owner(c), revision, action, note });
const orthancAfterStart = w => w.events.slice(w.events.indexOf('tx:start')).filter(e => e.startsWith('orthanc:'));
const noWrites = { request: 0, update: 0, receipt: 0, audit: 0 };
// an Accepted request of the clinician with the technician's applied accept id(11), for the replay route of (2) and (3)
const acceptedWorld = policy => world(policy, { requests: [seeded(10, 'Accepted', 2)], receipts: [{ requestId: id(11),
  imageRequestId: id(10), subjectSub: technician.sub, action: 'accept', fingerprint: '0'.repeat(64), appliedRevision: 2,
  result: { id: id(10), studyUid: uid, requestId: id(11), kind: 'image-transfer', action: 'accept', from: 'Requested', to: 'Accepted',
    revision: 2, at: new Date(0).toISOString() }, at: new Date(0) }] });
const routes = w => ({
  create: () => create(w, { ...clinician }, id(12), { kind: 'external-image' }),
  change: () => change(w, id(10), { ...technician }, id(13), 2, 'close', 'SYNTHETIC record'),
  replay: () => change(w, id(10), { ...technician }, id(11), 1, 'accept'),
});

test('(1) a metadata rule reads source tags before $transaction and never inside the callback', async () => {
  const w = world(metadataPolicy());
  const created = await create(w, { ...clinician }, id(1));
  assert.equal(created.replayed, false);
  const start = w.events.indexOf('tx:start');
  assert.ok(start > 0);
  const reads = w.events.map((event, index) => [event, index]).filter(([event]) => event.startsWith('orthanc:'));
  assert.deepEqual(reads.map(([event]) => event), ['orthanc:studyIdentityResources'], 'the UID route prepares one study');
  assert.ok(reads.every(([, index]) => index < start), 'the source read ends before the transaction');
  assert.deepEqual(orthancAfterStart(w), []);
  assert.ok(w.events.indexOf('tx:study') > start && w.events.indexOf('tx:receipt') > w.events.indexOf('tx:study'),
    'StudyState is locked before the receipt lookup');
  // an id route prepares every study (prepare(c)) before its transaction too, for a change and for its replay
  for (const label of ['change', 'replay']) {
    const before = w.events.length;
    const result = await change(w, id(1), { ...technician }, id(2), 1, 'accept');
    assert.equal(result.replayed, label === 'replay', label);
    const later = w.events.slice(before), second = later.indexOf('tx:start');
    assert.deepEqual(later.filter(e => e.startsWith('orthanc:')), ['orthanc:studyIdentities'], label);
    assert.ok(later.indexOf('orthanc:studyIdentities') < second, label);
    assert.deepEqual(later.slice(second).filter(e => e.startsWith('orthanc:')), [], label);
  }
  assert.deepEqual(w.calls.filter(call => call.name === 'studyIdentities').map(call => call.args), [[true], [true]]);
  assert.deepEqual(w.writes, { request: 1, update: 1, receipt: 2, audit: 2 });
});

test('(2) a policy change during the source read is 409 STUDY_ACCESS_CHANGED with no transaction and no write', async () => {
  for (const route of ['create', 'change', 'replay']) {
    const w = acceptedWorld(metadataPolicy());
    w.handlers.studyIdentityResources = async u => { w.bumpPolicy(); return [source(u)]; };
    w.handlers.studyIdentities = async () => { w.bumpPolicy(); return [source(uid)]; };
    await assert.rejects(routes(w)[route](), code(409, 'STUDY_ACCESS_CHANGED'), route);
    assert.equal(w.events.includes('tx:start'), false, route);
    assert.deepEqual(w.writes, noWrites, route);
  }
});

test('(3) a failed source read is 503 with no transaction and no write', async () => {
  for (const route of ['create', 'change', 'replay']) {
    const w = acceptedWorld(metadataPolicy());
    w.handlers.studyIdentityResources = async () => { throw new Error('SYNTHETIC transport failure'); };
    w.handlers.studyIdentities = async () => { throw new Error('SYNTHETIC transport failure'); };
    await assert.rejects(routes(w)[route](), code(503), route);
    assert.equal(w.events.includes('tx:start'), false, route);
    assert.deepEqual(w.writes, noWrites, route);
  }
});

/** Create, accept, its replay, read, forStudy, the queue and close. */
const flows = async w => {
  await create(w, { ...clinician }, id(31));
  await change(w, id(31), { ...technician }, id(32), 1, 'accept');
  await change(w, id(31), { ...technician }, id(32), 1, 'accept');
  await w.svc.read(id(31), { ...clinician });
  await w.svc.forStudy(uid, { ...radiologist });
  await w.svc.list({ ...technician }, { view: 'queue' });
  await change(w, id(31), { ...admin }, id(33), 2, 'close', 'SYNTHETIC record');
};
/** Every route and action: the flows, then an external-image request with a counterparty declined, a cancel and mine. */
const everyRoute = async w => {
  await flows(w);
  await create(w, { ...clinician }, id(34), { kind: 'external-image', counterpartyInstitutionId: counterparty });
  await change(w, id(34), { ...admin }, id(35), 1, 'decline', 'SYNTHETIC note');
  await create(w, { ...clinician }, id(36));
  await change(w, id(36), { ...clinician }, id(37), 1, 'cancel', 'SYNTHETIC reason');
  await w.svc.list({ ...clinician }, { view: 'mine' });
};

/**
 * The resolved-import contract (D73 section 15: Node's own module resolution, no match on source text), two ways.
 * `staticForbidden(source)` is the static check: the resolved OrthancService and ConnectService modules among the literal
 * require calls of the module's TypeScript AST (an unresolvable specifier is listed too). `loadCompiled(source)` runs the
 * module once more under a require that records the file each specifier resolves to, at load and while its class serves
 * the routes, so an executed lazy require or alias is seen too; `forbidden()` lists the same two modules among them.
 */
const compiledFile = require.resolve('/app/dist/image-request.service');
const forbiddenFiles = ['/app/dist/orthanc.service', '/app/dist/connect.service'].map(name => require.resolve(name));
const staticForbidden = source => staticRequires(source, compiledFile)
  .filter(file => forbiddenFiles.includes(file) || file.startsWith('unresolved:'))
  .map(file => file.startsWith('unresolved:') ? file : basename(file));
function loadCompiled(source) {
  const resolved = [];
  const real = createRequire(compiledFile);
  const recording = Object.assign(name => { resolved.push(real.resolve(name)); return real(name); },
    { resolve: real.resolve, cache: real.cache });
  const module = { exports: {} };
  vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: compiledFile })
    .call(module.exports, module.exports, recording, module, compiledFile, dirname(compiledFile));
  return { exports: module.exports, forbidden: () => resolved.filter(file => forbiddenFiles.includes(file)).map(file => basename(file)) };
}
/**
 * Module code that, once the exported class exists, makes its list() require `file` only for view=mine: a dependency
 * reached in one contractual branch, which only a check covering that branch can see.
 */
const requiredInMine = (name, file) => `\n{ const list = exports.${name}.prototype.list;\n`
  + `  exports.${name}.prototype.list = function (c, q) { if (q && q.view === 'mine') require(${JSON.stringify(file)}); return list.call(this, c, q); }; }\n`;
/** What a class does over every route, timestamps aside, and what the recording Connect store saw. */
const observe = async Service => {
  const w = world(metadataPolicy(), { Service });
  await everyRoute(w);
  return { behaviour: JSON.stringify([w.statements, w.calls, w.writes]), connect: w.connect };
};

test('(4) the service is constructed from PrismaService and StudyAccessService only and depends on no Orthanc or Connect service and no Connect store', async () => {
  const types = Reflect.getMetadata('design:paramtypes', ImageRequestService);
  assert.deepEqual(types.map(type => type.name), ['PrismaService', 'StudyAccessService']);
  assert.equal(types.includes(OrthancService), false);
  assert.equal(types.includes(ConnectService), false);
  const compiled = readFileSync(compiledFile, 'utf8');
  // The static check reads the module's own imports: the two injected services' modules are among them.
  const imports = staticRequires(compiled, compiledFile);
  assert.deepEqual(['/app/dist/prisma.service', '/app/dist/study-access.service'].map(name => imports.includes(require.resolve(name))),
    [true, true]);
  const names = 'OrthancService ConnectService ./orthanc.service ./connect.service "Transfer" "TransferBasis" "ProcessingAgreement"'
    + ' prisma.transfer prisma.transferBasis prisma.processingAgreement';
  // The contrast both ways: a comment and an unused string naming every forbidden service, delegate and table is the same
  // module and passes; a real require of either service module, at load, only in the clinician's own list (view=mine) or
  // in a branch these flows never run (static check only), or a real Connect call, is refused.
  const latent = latentRequires('ImageRequestService', 'kind');
  const variants = {
    compiled,
    named: `/* ${names} */\n${compiled}\nvoid ${JSON.stringify(names)}; // ${names}\n`,
    orthanc: `${compiled}\nrequire("./orthanc.service");\n`,
    connect: `${compiled}\nrequire("./connect.service");\n`,
    mineOrthanc: compiled + requiredInMine('ImageRequestService', './orthanc.service'),
    mineConnect: compiled + requiredInMine('ImageRequestService', './connect.service'),
    ...Object.fromEntries(Object.entries(latent).map(([name, code]) => [name, compiled + code])),
    // D1550 (Codex audit 2026-10-18) on the service's own SET LOCAL site: a '--' inside a literal of a CTE before a real
    // DELETE of a Connect table, the DELETE alone, and a SET whose only mention of the table is a string literal.
    siteLiteralThenDelete: withRawExecuteText(compiled, compiledFile,
      `WITH marker AS (SELECT '--' AS note) DELETE FROM "Transfer" WHERE false`),
    siteDelete: withRawExecuteText(compiled, compiledFile, 'DELETE FROM "Transfer" WHERE false'),
    siteNameLiteral: withRawExecuteText(compiled, compiledFile, `SET LOCAL application_name = '"Transfer"'`),
  };
  const expected = await observe(ImageRequestService);
  assert.deepEqual(expected.connect, [], 'every route of the compiled service');
  const seen = {};
  for (const [name, source] of Object.entries(variants)) {
    const loaded = loadCompiled(source);
    const { behaviour, connect } = await observe(loaded.exports.ImageRequestService);
    seen[name] = { static: staticForbidden(source), forbidden: loaded.forbidden(), connect: [...new Set(connect)],
      same: behaviour === expected.behaviour };
  }
  // A real Connect call from a service that otherwise behaves the same: through the injected PrismaService, a delegate
  // inside the write transaction, a raw write of a Connect table in a transaction and a raw read of one.
  class Transferring extends ImageRequestService {
    constructor(prisma, access) { super(prisma, access); this.connectStore = prisma; }
    async create(...args) {
      const result = await super.create(...args);
      await this.connectStore.$transaction(tx => tx.transfer.create({ data: {} }));
      await this.connectStore.$transaction(tx => tx.$executeRaw`INSERT INTO "Transfer" (id) VALUES (${'SYNTHETIC'})`);
      await this.connectStore.$queryRaw`SELECT id FROM "ProcessingAgreement"`;
      return result;
    }
  }
  const transferring = await observe(Transferring);
  seen.transferring = { connect: [...new Set(transferring.connect)] };
  // A SQL comment naming the Connect tables is not a reference: the same extra statements with and without such comments
  // (a block comment in a write, a line comment in a read) behave identically and reach no Connect table.
  const lockTimeout = withComments => class extends ImageRequestService {
    constructor(prisma, access) { super(prisma, access); this.store = prisma; }
    async create(...args) {
      const result = await super.create(...args);
      await this.store.$transaction(tx => withComments
        ? tx.$executeRaw`SET LOCAL lock_timeout = '3s' /* not "Transfer", "TransferBasis" or "ProcessingAgreement" */`
        : tx.$executeRaw`SET LOCAL lock_timeout = '3s'`);
      await (withComments
        ? this.store.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1}) -- never "ProcessingAgreement"
          `
        : this.store.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1})`);
      return result;
    }
  };
  const [plain, commented] = [await observe(lockTimeout(false)), await observe(lockTimeout(true))];
  seen.sqlComments = { connect: commented.connect, same: commented.behaviour === plain.behaviour };
  // The same two extra statements (a write in a transaction, an advisory read on the root client) sent other ways that
  // reach no Connect table: nested comments, string literals, bound values, a Prisma.raw comment, the *Unsafe methods.
  const extra = (execute, read) => class extends ImageRequestService {
    constructor(prisma, access) { super(prisma, access); this.store = prisma; }
    async create(...args) {
      const result = await super.create(...args);
      await this.store.$transaction(execute);
      await read(this.store);
      return result;
    }
  };
  const lockWrite = tx => tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
  const harmless = {
    nestedComments: extra(tx => tx.$executeRaw`SET LOCAL lock_timeout = '3s' /* a /* b */ "Transfer" */`,
      root => root.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1}) -- /* "TransferBasis"
        `),
    literals: extra(tx => tx.$executeRaw`SET LOCAL application_name = '"Transfer"'`,
      root => root.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1}) WHERE 'see "ProcessingAgreement" -- /*' IS NOT NULL`),
    boundValues: extra(lockWrite,
      root => root.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1}) WHERE ${'"Transfer" -- /*'}::text IS NOT NULL`),
    sqlFragment: extra(tx => tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s' -- "TransferBasis"`),
      root => root.$queryRaw(Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(${1}) ${Prisma.raw('/* "Transfer" */')}`)),
    unsafeRead: extra(lockWrite,
      root => root.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock($1) /* "ProcessingAgreement" */', 1)),
  };
  seen.harmlessSql = {};
  for (const [name, Service] of Object.entries(harmless)) {
    const { behaviour, connect } = await observe(Service);
    seen.harmlessSql[name] = { connect, same: behaviour === plain.behaviour };
  }
  // Real reads and writes of a Connect table through every raw method of both clients, and SQL the parser refuses.
  const once = run => class extends ImageRequestService {
    constructor(prisma, access) { super(prisma, access); this.store = prisma; }
    async create(...args) { const result = await super.create(...args); await run(this.store); return result; }
  };
  const inTx = run => store => store.$transaction(run);
  const real = {
    literalThenRead: once(root => root.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1})
      WHERE '--' <> (SELECT count(*) FROM "Transfer")::text`),
    lineThenBlock: once(root => root.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1}) WHERE true -- /*
      AND NOT EXISTS (SELECT 1 FROM "TransferBasis") -- */`),
    prismaRaw: once(root => root.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${1})
      WHERE NOT EXISTS (SELECT 1 FROM ${Prisma.raw('"ProcessingAgreement"')})`),
    nestedSql: once(inTx(tx => tx.$queryRaw(Prisma.sql`SELECT 1 WHERE EXISTS
      ${Prisma.sql`(SELECT 1 FROM public."Transfer" WHERE id = ${'SYNTHETIC'})`}`))),
    txQueryUnsafe: once(inTx(tx => tx.$queryRawUnsafe('SELECT id FROM "TransferBasis" WHERE id = $1', 'SYNTHETIC'))),
    txExecuteUnsafe: once(inTx(tx => tx.$executeRawUnsafe('UPDATE "ProcessingAgreement" SET id = $1 WHERE false', 'SYNTHETIC'))),
    rootExecute: once(root => root.$executeRaw`DELETE FROM "Transfer" WHERE id = ${'SYNTHETIC'}`),
    rootExecuteUnsafe: once(root => root.$executeRawUnsafe('INSERT INTO "TransferBasis" (id) VALUES ($1)', 'SYNTHETIC')),
    rootQueryUnsafe: once(root => root.$queryRawUnsafe('SELECT id FROM "ProcessingAgreement"')),
    unparsed: once(inTx(tx => tx.$executeRaw`SET LOCAL lock_timeout = '3s' /* "Transfer"`)),
  };
  seen.connectSql = {};
  for (const [name, Service] of Object.entries(real)) seen.connectSql[name] = [...new Set((await observe(Service)).connect)];
  const none = { static: [], forbidden: [], connect: [], same: true };
  const statically = file => ({ ...none, static: [file] });
  const loadedToo = file => ({ ...none, static: [file], forbidden: [file] });
  assert.deepEqual(seen, {
    compiled: none,
    named: none,
    orthanc: loadedToo('orthanc.service.js'),
    connect: loadedToo('connect.service.js'),
    mineOrthanc: loadedToo('orthanc.service.js'),
    mineConnect: loadedToo('connect.service.js'),
    cursorConnect: statically('connect.service.js'),
    filterOrthanc: statically('orthanc.service.js'),
    catchConnect: statically('connect.service.js'),
    importConnect: statically('connect.service.js'),
    extensionOrthanc: statically('orthanc.service.js'),
    siteLiteralThenDelete: { ...none, connect: ['tx:sql "Transfer"'], same: false },
    siteDelete: { ...none, connect: ['tx:sql "Transfer"'], same: false },
    siteNameLiteral: none,
    transferring: { connect: ['tx:transfer.create', 'tx:sql "Transfer"', 'root:sql "ProcessingAgreement"'] },
    sqlComments: { connect: [], same: true },
    harmlessSql: Object.fromEntries(Object.keys(harmless).map(name => [name, { connect: [], same: true }])),
    connectSql: {
      literalThenRead: ['root:sql "Transfer"'],
      lineThenBlock: ['root:sql "TransferBasis"'],
      prismaRaw: ['root:sql "ProcessingAgreement"'],
      nestedSql: ['tx:sql "Transfer"'],
      txQueryUnsafe: ['tx:sql "TransferBasis"'],
      txExecuteUnsafe: ['tx:sql "ProcessingAgreement"'],
      rootExecute: ['root:sql "Transfer"'],
      rootExecuteUnsafe: ['root:sql "TransferBasis"'],
      rootQueryUnsafe: ['root:sql "ProcessingAgreement"'],
      unparsed: ['tx:sql unparsed'],
    },
  });
  assert.deepEqual(plain.connect, []);
});

test('(5) only studyIdentityResources and studyIdentities(true) reach Orthanc, and nothing without a metadata rule', async () => {
  const metadata = world(metadataPolicy());
  await flows(metadata);
  assert.ok(metadata.calls.length > 0);
  for (const call of metadata.calls) {
    assert.ok(['studyIdentityResources', 'studyIdentities'].includes(call.name), call.name);
    if (call.name === 'studyIdentities') assert.deepEqual(call.args, [true]);
  }
  for (const policy of [null, uidPolicy()]) {
    const w = world(policy);
    await flows(w);
    assert.deepEqual(w.calls, [], JSON.stringify(policy));
    assert.deepEqual(w.writes, { request: 1, update: 2, receipt: 3, audit: 3 });
  }
});

test('every applied requestId replays its stored receipt without a write, after Closed and after a new active request', async () => {
  const w = world(null);
  const created = await create(w, { ...clinician }, id(41));
  const accepted = await change(w, id(41), { ...technician }, id(42), 1, 'accept');
  const closed = await change(w, id(41), { ...technician }, id(43), 2, 'close', 'SYNTHETIC record');
  assert.deepEqual([created, accepted, closed].map(r => [r.applied.action, r.applied.from, r.applied.to, r.applied.revision]),
    [['create', null, 'Requested', 1], ['accept', 'Requested', 'Accepted', 2], ['close', 'Accepted', 'Closed', 3]]);
  const fresh = await create(w, { ...clinician }, id(44));
  assert.deepEqual([fresh.replayed, fresh.applied.id, fresh.applied.revision], [false, id(44), 1]);
  const settled = { ...w.writes };
  for (const [again, first] of [[await create(w, { ...clinician }, id(41)), created],
    [await change(w, id(41), { ...technician }, id(42), 1, 'accept'), accepted],
    [await change(w, id(41), { ...technician }, id(43), 2, 'close', 'SYNTHETIC record'), closed]]) {
    assert.equal(again.replayed, true);
    assert.deepEqual(again.applied, first.applied);
  }
  assert.deepEqual(w.writes, settled);
  const other = { ...clinician, sub: 'synthetic-other-clinician-sub', actor: 'synthetic-other-clinician' };
  // Thunks: each call starts only when its rejection handler is attached.
  const refusals = [
    [() => create(w, { ...clinician }, id(41), { reason: 'SYNTHETIC other reason' }), 409, 'REQUEST_ID_REUSED'],
    [() => change(w, id(41), { ...technician }, id(42), 1, 'decline', 'SYNTHETIC decline'), 409, 'REQUEST_ID_REUSED'],
    [() => change(w, id(41), { ...technician }, id(43), 2, 'close', 'SYNTHETIC other record'), 409, 'REQUEST_ID_REUSED'],
    [() => change(w, id(44), { ...technician }, id(42), 1, 'accept'), 409, 'REQUEST_ID_REUSED'],
    [() => create(w, { ...other }, id(41)), 409, 'REQUEST_ID_REUSED'],
    [() => create(w, { ...clinician }, id(45)), 409, 'IMAGE_REQUEST_ACTIVE_EXISTS'],
    [() => change(w, id(41), { ...technician }, id(46), 3, 'decline', 'SYNTHETIC late'), 409, 'IMAGE_REQUEST_STATE'],
    [() => change(w, id(41), { ...technician }, id(47), 2, 'decline', 'SYNTHETIC late'), 409, 'IMAGE_REQUEST_CHANGED'],
    [() => change(w, id(44), { ...technician }, id(48), 1, 'accept', 'SYNTHETIC not empty'), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
    [() => change(w, id(44), { ...technician }, id(49), 1, 'close', ''), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
    [() => change(w, id(44), { ...clinician }, id(50), 1, 'accept'), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => change(w, id(44), { ...radiologist }, id(51), 1, 'close', 'SYNTHETIC'), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => change(w, id(44), { ...technician }, id(52), 1, 'cancel', 'SYNTHETIC'), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => change(w, id(44), { ...other }, id(53), 1, 'cancel', 'SYNTHETIC'), 404, 'IMAGE_REQUEST_NOT_FOUND'],
    [() => change(w, id(44), { ...technician, roles: ['technician', 'clinician'] }, id(54), 1, 'cancel', 'SYNTHETIC'), 403,
      'IMAGE_REQUEST_ACTION_FORBIDDEN'],
    [() => create(w, { ...technician }, id(55)), 403, 'IMAGE_REQUEST_ROLE_REQUIRED'],
    [() => create(w, { ...clinician }, id(56), { kind: 'external-image', counterpartyInstitutionId: institution }), 400,
      'IMAGE_REQUEST_COUNTERPARTY_INVALID'],
    [() => create(w, { ...clinician }, id(57), { kind: 'external-image', counterpartyInstitutionId: 'synthetic-unknown' }), 400,
      'IMAGE_REQUEST_COUNTERPARTY_INVALID'],
    [() => create(w, { ...clinician }, id(58), { kind: 'external-image', institution: counterparty }), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
    [() => create(w, { ...clinician }, id(59), { kind: 'transfer' }), 400, 'IMAGE_REQUEST_INPUT_INVALID'],
  ];
  for (const [call, status, value] of refusals) await assert.rejects(call, code(status, value), value);
  assert.deepEqual(w.writes, settled);
});

test('receipts and audit rows carry the fixed keys and no text; the action is owner-only in GET audit', async () => {
  assert.equal(IMAGE_REQUEST_AUDIT_ACTION, 'study.image-request');
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes(IMAGE_REQUEST_AUDIT_ACTION));
  assert.ok(OWNER_ONLY_AUDIT_ACTIONS.includes('study.question'), 'S5-U4a keeps its action');
  const w = world(null);
  const created = await create(w, { ...clinician }, id(61), { counterparty: 'SYNTHETIC counterparty text',
    counterpartyInstitutionId: counterparty, reason: 'SYNTHETIC reason text that must stay out of audit' });
  await change(w, id(61), { ...admin }, id(62), 1, 'decline', 'SYNTHETIC note text that must stay out of audit');
  assert.deepEqual(Object.keys(created.applied).sort(), ['action', 'at', 'from', 'id', 'kind', 'requestId', 'revision', 'studyUid', 'to']);
  assert.deepEqual(Object.keys(created).sort(), ['applied', 'owner', 'replayed']);
  assert.equal(w.audits.length, 2);
  for (const row of w.audits) {
    assert.equal(row.action, IMAGE_REQUEST_AUDIT_ACTION);
    assert.equal(row.target, uid);
    const detail = JSON.parse(row.detail);
    assert.deepEqual(Object.keys(detail).sort(),
      ['action', 'counterpartyInstitutionId', 'from', 'id', 'institution', 'kind', 'requestId', 'revision', 'role', 'to']);
    assert.deepEqual([detail.institution, detail.counterpartyInstitutionId], [institution, counterparty]);
    assert.equal(row.detail.includes('SYNTHETIC'), false);
  }
  assert.deepEqual(w.audits.map(row => JSON.parse(row.detail).role), ['clinician', 'admin']);
  const receipt = w.store.receipts.get(id(61));
  assert.deepEqual([receipt.result, receipt.subjectSub, receipt.imageRequestId, receipt.appliedRevision], [created.applied, clinician.sub, id(61), 1]);
  assert.equal(JSON.stringify(receipt.result).includes('SYNTHETIC'), false);
  const row = w.store.requests.get(id(61));
  assert.deepEqual([row.state, row.handlerActor, row.note], ['Declined', admin.actor, 'SYNTHETIC note text that must stay out of audit']);
});

test('a state outside the machine is 409 IMAGE_REQUEST_STATE, never a transition', async () => {
  const w = world(null, { requests: [seeded(70, 'Bogus', 1)] });
  for (const [c, action, note] of [[technician, 'accept', ''], [technician, 'close', 'SYNTHETIC'], [admin, 'decline', 'SYNTHETIC'],
    [clinician, 'cancel', 'SYNTHETIC']])
    await assert.rejects(change(w, id(70), { ...c }, id(71), 1, action, note), code(409, 'IMAGE_REQUEST_STATE'), action);
  assert.deepEqual(w.writes, noWrites);
});

const READ = { isolationLevel: 'RepeatableRead', maxWait: 4000, timeout: 8000 };
const WRITE = { maxWait: 4000, timeout: 8000 };

test('#8 and #9 read in one RepeatableRead transaction, with no row lock and no read outside it', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(81));
  // The only read before the transaction is the policy snapshot of prepare(); nothing follows tx:end.
  for (const [route, call, inside] of [
    ['read', () => w.svc.read(id(81), { ...clinician }), ['tx:request', 'tx:study', 'tx:advisory', 'tx:policy']],
    ['forStudy', () => w.svc.forStudy(uid, { ...clinician }), ['tx:study', 'tx:advisory', 'tx:policy', 'tx:list']],
  ]) {
    const from = w.statements.length, at = w.transactions.length;
    await call();
    assert.deepEqual(w.transactions.slice(at), [READ], route);
    assert.deepEqual(w.statements.slice(from), ['root:policy', 'tx:start', 'tx:execute', 'tx:advisory', 'tx:policy', ...inside, 'tx:end'], route);
  }
  assert.deepEqual(w.writes, { request: 1, update: 0, receipt: 1, audit: 1 });
});

test('an owner change committed between the statements of a request read never reaches its answer', async () => {
  const w = world(null);
  await create(w, { ...clinician }, id(91));
  const reader = w.transactions.length;
  // Read per statement, the row said this institution and the study said another: a 404 for a row that was visible.
  w.between({ 'tx:request': async () => { w.store.study.institutionId = 'synthetic-elsewhere'; } });
  const { item } = await w.svc.read(id(91), { ...technician });
  assert.deepEqual(w.pending(), [], 'the move landed inside the read');
  assert.deepEqual(w.transactions[reader], READ);
  assert.deepEqual([item.id, item.state, item.revision], [id(91), 'Requested', 1]);
  // the next read and a write start after the move and see it whole: hidden, never moved
  await assert.rejects(w.svc.read(id(91), { ...technician }), code(404, 'IMAGE_REQUEST_NOT_FOUND'));
  await assert.rejects(change(w, id(91), { ...technician }, id(92), 1, 'accept'), code(404, 'IMAGE_REQUEST_NOT_FOUND'));
  assert.deepEqual(w.writes, { request: 1, update: 0, receipt: 1, audit: 1 });
});

test('the write paths keep the default isolation and lock StudyState before the request row and the counterparty', async () => {
  const w = world(null);
  const locks = rows => rows.filter(s => ['tx:execute', 'tx:advisory', 'tx:write'].includes(s) || / FOR (UPDATE|KEY SHARE|SHARE)$/.test(s));
  const runs = [];
  for (const [route, call] of [
    ['create', () => create(w, { ...clinician }, id(101), { counterpartyInstitutionId: counterparty })],
    ['accept', () => change(w, id(101), { ...technician }, id(102), 1, 'accept')],
    ['close', () => change(w, id(101), { ...technician }, id(103), 2, 'close', 'SYNTHETIC record')],
  ]) {
    const from = w.statements.length, at = w.transactions.length;
    await call();
    runs.push([route, w.transactions.slice(at), locks(w.statements.slice(from))]);
  }
  const parent = ['tx:execute', 'tx:advisory', 'tx:study FOR UPDATE', 'tx:advisory'];
  const written = ['tx:write', 'tx:write', 'tx:write'];
  assert.deepEqual(runs, [
    ['create', [WRITE], [...parent, 'tx:institution FOR KEY SHARE', ...written]],
    ['accept', [WRITE], [...parent, 'tx:request FOR UPDATE', ...written]],
    ['close', [WRITE], [...parent, 'tx:request FOR UPDATE', ...written]],
  ]);
  // the receipt lookup follows the parent and row locks, so one requestId applies once
  const last = w.statements.slice(w.statements.lastIndexOf('tx:start'));
  assert.ok(last.indexOf('tx:receipt') > last.indexOf('tx:request FOR UPDATE'));
});
