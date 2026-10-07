'use strict';
/* TEST-S7-U5 compiled draft boundary (U5S-TEST-D01..D11, Astra spec U5S-REQ-14..18, 23): the stored draft revision, its
 * tombstones, the study draft epoch, the one mutation path and its session fence - the compiled PacsController handlers
 * and PacsService of the kin-api image over a real disposable PostgreSQL. No mock of the draft store: every outcome is
 * read back from the database.
 *
 * U5S-REQ-14/15/16/17/18 -> U5S-RISK-DRAFT / -SUCCESS / -AUDIT / -WAIT / -SESSION -> U5S-TEST-D01..D11 (this file).
 * U5S-TEST-D12 (preparation/recovery against the other writers, client snapshots) is the client's and is not here.
 *
 * How a case reaches the product: where the router does. The handler is the one Nest's route metadata maps the request
 * to (looked up over the controllers AppModule registers, never by its name), its arguments placed as its parameter
 * decorators ask, the request carrying what the auth guard sets (sub, actor, roles, institution, kind, and for a cookie
 * session sid + authMethod). Expected values are the contract's literals (statuses, codes, revisions as counts of
 * successful mutations), never read back from the implementation.
 *
 * Interleavings (U5S-REQ-23, -24): two requests X and Y, the arrival order (which handler is entered first), the order
 * of their DB completion (which transaction commits first) and the order their answers are delivered. The matrix runs
 * the orderings that decide a row's outcome (both completion orders and one held answer) over one writer per server
 * path; the reduction and its reasons are at RELATIONS below. A request is held before its transaction opens (arrived, not yet at the database) or after its work, before
 * its commit (holding the study row), by a recording view of the real Prisma client and of the real StudyAccessService;
 * a request waiting for the study row is recognised in pg_stat_activity. Nothing in the product exists for this file.
 * The oracle of a schedule is (a) the literal CAS expectation - of two same-owner writes carrying the same boundary,
 * exactly the one that commits first takes effect and the other is refused without changing anything - and (b) the same
 * two requests run one after the other in commit order on a twin study: the persisted rows, history and audit actions
 * are equal. A refused request is recorded as refused; it is never counted as a second commit.
 *
 * Test doubles (collaborators outside the draft boundary): Keycloak's colleague list, the finding readability gate
 * (one synthetic readable finding, so that a citation insertion reaches the draft write) and an Orthanc that is never
 * called. StudyAccessService and AuthService are the image's own.
 *
 * KIN_REPORT_DRAFT_DATABASE_URL names a disposable server's database kin_report_draft_test, which must hold no table
 * when this file starts: the image's migrations are applied with `prisma migrate deploy`. Container only (kin-api image:
 * /app/dist, /app/prisma, /app/node_modules). Synthetic identities and texts only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

const DATABASE = 'kin_report_draft_test';
Object.assign(process.env, { KC_ISSUER: 'https://syn.test/auth/realms/kin', KC_AUDIENCE: 'kin-api', PUBLIC_ORIGIN: 'https://syn.test',
  KC_WEB_SECRET: 'syn-client-secret', KIN_COOKIE_SECRET: 'syn-cookie-secret',
  // a closed loopback port: the Keycloak logout after a revocation fails at once and changes nothing
  KC_JWKS_URL: 'http://127.0.0.1:9/realms/kin/protocol/openid-connect/certs' });

const { PacsService } = require('/app/dist/pacs.service');
const { AuthService } = require('/app/dist/auth.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { AppModule } = require('/app/dist/app.module');
const { STRUCTURE_CATALOG, renderItem } = require('/app/dist/report-structure');
const nest = createRequire('/app/dist/app.module.js');
const { PATH_METADATA, METHOD_METADATA, MODULE_METADATA, ROUTE_ARGS_METADATA } = nest('@nestjs/common/constants');
const { RequestMethod, HttpException } = nest('@nestjs/common');
const { RouteParamtypes } = nest('@nestjs/common/enums/route-paramtypes.enum');

const report = line => process.stderr.write('S7-U5-DRAFT-CAS ' + line + '\n');

// ── the disposable database ──

let prepared = null;
function database() {
  prepared ??= (async () => {
    const url = process.env.KIN_REPORT_DRAFT_DATABASE_URL;
    assert.ok(url, 'set KIN_REPORT_DRAFT_DATABASE_URL to the disposable ' + DATABASE + ' database');
    assert.equal(new URL(url).pathname, '/' + DATABASE, 'refusing any database but the disposable ' + DATABASE);
    process.env.DATABASE_URL = url;
    const { PrismaService } = require('/app/dist/prisma.service');
    const base = new PrismaService();
    await base.$connect();
    const [{ tables }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(tables, 0, 'refusing a database that already holds tables: this file writes the tables it reads');
    execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'],
      { cwd: '/app', env: { ...process.env, DATABASE_URL: url, HOME: os.tmpdir(), CHECKPOINT_DISABLE: '1' }, stdio: 'pipe' });
    const applied = await base.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const folders = fs.readdirSync('/app/prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.deepEqual(applied.map(row => row.migration_name).sort(), folders, 'every migration of the image applied');
    for (const id of [INST, OTHER]) await base.institution.create({ data: { id, name: id } });
    return base;
  })();
  return prepared;
}
test.after(async () => { if (prepared) await (await prepared).$disconnect(); });

// ── the routes ──

const pattern = (...parts) => parts.flatMap(part => String(part).split('/')).filter(Boolean)
  .map(segment => (segment.startsWith(':') ? ':' : segment)).join('/');
function controllersOf(module, seen = new Set()) {
  if (!module || seen.has(module)) return [];
  seen.add(module);
  const meta = key => (typeof module === 'function' ? Reflect.getMetadata(key, module) : module[key]) ?? [];
  return [...meta(MODULE_METADATA.CONTROLLERS),
    ...meta(MODULE_METADATA.IMPORTS).flatMap(imported => controllersOf(imported?.module ?? imported, seen)),
    ...(typeof module === 'function' ? [] : controllersOf(module.module, seen))];
}
/** The one handler a request `method path` reaches. */
function routed(method, path) {
  const found = [];
  for (const controller of new Set(controllersOf(AppModule))) {
    const prefixes = [].concat(Reflect.getMetadata(PATH_METADATA, controller) ?? '/');
    for (let proto = controller.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const handler = key === 'constructor' ? null : Object.getOwnPropertyDescriptor(proto, key).value;
        if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        if (![RequestMethod[method], RequestMethod.ALL].includes(Reflect.getMetadata(METHOD_METADATA, handler))) continue;
        const paths = [].concat(Reflect.getMetadata(PATH_METADATA, handler) ?? '/');
        if (prefixes.some(prefix => paths.some(at => pattern(prefix, at) === pattern(path)))) found.push({ controller, key });
      }
    }
  }
  assert.equal(found.length, 1, `${method} ${path} must reach one handler`);
  return found[0];
}
const ROUTE = {
  put: routed('PUT', 'studies/:uid/report'), read: routed('GET', 'studies/:uid/draft'),
  discard: routed('DELETE', 'studies/:uid/draft'), force: routed('DELETE', 'studies/:uid/draft/force'),
  commit: routed('POST', 'studies/:uid/report/commit'), remove: routed('DELETE', 'studies/:uid'),
  citations: routed('GET', 'studies/:uid/report/citations'), structure: routed('GET', 'studies/:uid/report/structure'),
};

// ── synthetic principals ──

const INST = 'syn-inst-a', OTHER = 'syn-inst-b';
const member = (name, institution, roles) => ({ kind: 'member', institution, sub: 'syn-sub-' + name, actor: `syn-${name}@synthetic.test`, roles });
const A = member('a', INST, ['radiologist']), B = member('b', INST, ['radiologist']), C = member('c', OTHER, ['radiologist']);
const REVIEWER = member('r', INST, ['radiologist']);
const ADMIN = member('admin', INST, ['admin']), OTHER_ADMIN = member('admin-c', OTHER, ['admin']);
const TECH = member('tech', INST, ['technician']);
const ownerOf = p => ({ institution: p.institution, sub: p.sub, author: p.actor });
const FINDING = '0f0f0f0f-0000-4000-8000-00000000000a';
const CITED = 'SYN cited line', STRUCT_ITEM = STRUCTURE_CATALOG[0].items.find(item => item.code === 'CONTRAST');
const STRUCT_LINE = renderItem(STRUCT_ITEM, true);

// ── a world: the recording views, the services, one controller (as the application has one) ──

const flow = new AsyncLocalStorage();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function within(promise, what, ms = 8000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('harness: ' + what + ' did not happen')), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

async function world() {
  const base = await database();
  const w = { base, gates: [], faults: [], points: [] };
  for(const p of [A,B,C,ADMIN,OTHER_ADMIN,REVIEWER]) await base.memberRights.upsert({where:{sub:p.sub},update:{},create:{
    sub:p.sub,username:p.actor,email:p.actor,name:p.actor,emailVerified:true,approved:true,suspended:false,institution:p.institution,roles:p.roles}});
  /** Holds the request `label` at `point` (prepare | commit) until released; `fault` makes its next audit write throw. */
  w.gate = (label, point) => {
    const gate = { label, point, arrived: deferred(), release: deferred(), used: false };
    w.gates.push(gate);
    return { arrived: () => within(gate.arrived.promise, `${label} reaching ${point}`), release: () => gate.release.resolve() };
  };
  w.fault = (label, point, error) => { w.faults.push({ label, point, error }); };
  async function hit(point, extra) {
    const label = flow.getStore()?.label;
    w.points.push(`${label}:${point}`);
    const gate = w.gates.find(g => g.label === label && g.point === point && !g.used);
    if (gate) { gate.used = true; if (extra) await extra(); gate.arrived.resolve(); await gate.release.promise; }
    const n = w.faults.findIndex(f => f.label === label && f.point === point);
    if (n >= 0) { const [fault] = w.faults.splice(n, 1); throw fault.error; }
  }
  const view = tx => new Proxy({}, { get(_t, key) {
    if (key === 'auditLog') return new Proxy({}, { get(_a, method) {
      const real = tx.auditLog[method];
      return method === 'create' ? async args => { await hit('audit'); return real.call(tx.auditLog, args); } : real.bind(tx.auditLog);
    } });
    const value = tx[key];
    return typeof value === 'function' ? value.bind(tx) : value;
  } });
  const recorder = new Proxy({}, { get(_t, key) {
    if (key === '$transaction') return (fn, options) => base.$transaction(async tx => {
      const out = await fn(view(tx));
      // the work is done and nothing is committed yet: the request holds the study row here
      await hit('commit', async () => { w.backend = (await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid; });
      return out;
    }, options);
    const value = base[key];
    return typeof value === 'function' ? value.bind(base) : value;
  } });
  const orthanc = new Proxy({}, { get(_t, key) { return () => { throw new Error('harness: Orthanc.' + String(key) + ' must not be reached'); }; } });
  const build = () => {
    const access = new StudyAccessService(recorder, orthanc, {});
    const realPrepare = access.prepare.bind(access);
    access.prepare = async (...args) => { await hit('prepare'); return realPrepare(...args); };
    const keycloak = { usersInGroupWithRole: async () => [{ id: REVIEWER.actor }, { id: A.actor }, { id: B.actor }] };
    const findings = { readableFindings: async (_tx, _c, _uid, ids) => ids.includes(FINDING) ? [{ id: FINDING, revision: 1, hidden: false,
      sources: [{ kind: 'item', itemId: '0f0f0f0f-0000-4000-8000-00000000000b', revision: 1 }],
      links: [{ linkState: 'current', headRevision: 1 }] }] : [] };
    const svc = new PacsService(recorder, orthanc, keycloak, access, findings);
    const controllers = new Map();
    return { svc, controller(cls) { if (!controllers.has(cls)) controllers.set(cls, new cls(svc)); return controllers.get(cls); } };
  };
  w.app = build();
  /** A new process: nothing of the old one's memory, the same database. */
  w.restart = () => { w.app = build(); };
  w.auth = new AuthService(recorder);

  /** One request through its routed handler. The answer is what the HTTP layer would send: status, code, body. */
  w.send = (label, route, { as, sid = null, uid, body }) => flow.run({ label }, async () => {
    const { controller, key } = ROUTE[route];
    const req = { sub: as.sub, actor: as.actor, roles: as.roles, institution: as.institution, kind: as.kind, headers: {},
      ...(sid ? { sid, authMethod: 'session' } : { authMethod: 'bearer' }) };
    const args = [];
    for (const [slot, { index, data }] of Object.entries(Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, key) ?? {})) {
      const type = Number(slot.split(':')[0]);
      if (type === RouteParamtypes.PARAM && data === 'uid') args[index] = uid;
      else if (type === RouteParamtypes.BODY && data === undefined) args[index] = body;
      else if (type === RouteParamtypes.REQUEST) args[index] = req;
      else assert.fail(`the handler asks for argument ${slot} ${JSON.stringify(data)}, which these cases do not provide`);
    }
    try {
      return { ok: true, status: 200, code: null, body: await w.app.controller(controller)[key](...args) };
    } catch (error) {
      if (!(error instanceof HttpException)) return { ok: false, status: 0, code: 'NOT_HTTP', body: null, error };
      const answer = error.getResponse();
      return { ok: false, status: error.getStatus(), code: typeof answer === 'object' ? answer.code ?? null : null, body: answer };
    }
  });

  // ── synthetic rows ──
  let serial = 0;
  w.uid = () => `2.25.${Date.now()}.${process.pid}.${++serial}`;
  /** A study of INST. `rs` W (open) or A (approved at v1); `draft` gives A a present draft at revision 1. */
  w.study = async ({ rs = 'W', draft = true, staleBase = false, uid = w.uid() } = {}) => {
    await base.studyState.create({ data: { uid, institutionId: INST, rs, ss: 'Verified',
      ...(rs === 'A' ? { repDoc: 'syn-prior', confirm: '2026-10-01' } : {}) } });
    if (rs === 'A') {
      await base.report.create({ data: { uid, findings: 'SYN approved head', conclusion: 'SYN head c', version: 1, updatedBy: REVIEWER.actor } });
      await base.reportVersion.create({ data: { uid, version: 1, action: 'approve', findings: 'SYN approved head', conclusion: 'SYN head c',
        author: REVIEWER.actor, citations: [] } });
    }
    if (draft) await base.reportDraft.create({ data: { uid, author: A.actor, findings: 'SYN first draft', conclusion: '',
      recommendation: '', baseVersion: rs === 'A' && !staleBase ? 1 : 0, revision: 1, present: true } });
    return uid;
  };
  w.session = async principal => {
    const sid = randomBytes(32).toString('base64url');
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${b64({ alg: 'none' })}.${b64({ sub: principal.sub, email: principal.actor, groups: [principal.institution] })}.syn`;
    await base.authSession.create({ data: { sid, sub: principal.sub, institution: principal.institution, rightsVersion: 1, accessToken: token, refreshToken: 'syn-rt-' + randomUUID(),
      atExpiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() } });
    return sid;
  };
  w.epoch = async uid => (await base.studyState.findUnique({ where: { uid }, select: { draftEpoch: true } }))?.draftEpoch ?? null;
  w.row = (uid, principal) => base.reportDraft.findUnique({ where: { uid_author: { uid, author: principal.actor } } });
  /** The boundary a document of `principal` read: the study epoch and its own revision. */
  w.token = async (uid, principal) => `${await w.epoch(uid)}:${(await w.row(uid, principal))?.revision ?? 0}`;
  w.audits = async uid => (await base.auditLog.findMany({ where: { target: uid }, orderBy: { id: 'asc' } })).map(r => `${r.actor} ${r.action}`);
  /** Everything a draft mutation can change, without the values that are random by design (ids, times, the epoch). */
  w.state = async uid => {
    const study = await base.studyState.findUnique({ where: { uid } });
    const drafts = await base.reportDraft.findMany({ where: { uid }, orderBy: { author: 'asc' } });
    const head = await base.report.findUnique({ where: { uid } });
    const versions = await base.reportVersion.findMany({ where: { uid }, orderBy: { version: 'asc' } });
    const count = value => (Array.isArray(value) ? value.length : value === null || value === undefined ? null : 'not-an-array');
    return {
      study: study ? { rs: study.rs, preDoc: study.preDoc, preReviewer: study.preReviewer, repDoc: study.repDoc, holdReason: study.holdReason } : null,
      drafts: drafts.map(d => ({ author: d.author, revision: d.revision, present: d.present, findings: d.findings,
        conclusion: d.conclusion, recommendation: d.recommendation, baseVersion: d.baseVersion,
        citations: count(d.citations), structured: count(d.structured) })),
      report: head ? { version: head.version, findings: head.findings, conclusion: head.conclusion, updatedBy: head.updatedBy } : null,
      versions: versions.map(v => ({ version: v.version, action: v.action, author: v.author, findings: v.findings,
        citations: count(v.citations), structured: count(v.structured) })),
      audits: await w.audits(uid),
    };
  };
  /** True once a backend waits for a row lock: the request behind the held one has reached the study row. */
  w.blocked = async () => {
    const [{ n }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    return n > 0;
  };
  return w;
}

// ── the writers (U5S-REQ-23): what each sends, as the document that read `token` would send it ──

const KINDS = ['put', 'rebase', 'insert', 'structure', 'clear', 'discard', 'save', 'approve', 'preliminary', 'defer', 'addendum', 'reset', 'force'];
const DRAFT_ONLY = new Set(['put', 'rebase', 'insert', 'structure', 'clear', 'discard']);
const COMMITS = new Set(['save', 'approve', 'preliminary', 'defer', 'addendum', 'reset']);
/** The client writers each server writer stands for (the matrix names the client's kinds; the server sees these). */
const CLIENT_WRITERS = {
  put: 'autosave, explicit draft save, study-switch/unload preservation, preparation save, Recover Draft',
  rebase: 'stale rebase', insert: 'citation insertion', structure: 'structure apply/replace', clear: 'empty PUT',
  discard: 'own discard', force: 'force-discard', save: 'commit save', approve: 'commit approve',
  preliminary: 'commit preliminary', defer: 'commit defer', addendum: 'commit addendum', reset: 'commit reset',
};
/**
 * Kinds admissible alone in a fixture. open = RS W, no confirmed version. approved = RS A at head v1, the draft (if any)
 * based on v1. stale = RS A at head v1, the draft based on v0 (the head moved while it was written): the only state a
 * rebase exists in, and one an addendum is refused in (REPORT_DRAFT_STALE) - so those two share no fixture.
 */
const ADMISSIBLE = {
  open: ['put', 'insert', 'structure', 'clear', 'discard', 'save', 'approve', 'preliminary', 'defer', 'reset', 'force'],
  approved: ['put', 'insert', 'structure', 'clear', 'discard', 'addendum', 'reset', 'force'],
  stale: ['put', 'rebase', 'insert', 'structure', 'clear', 'discard', 'reset', 'force'],
};
const HEAD = { open: 0, approved: 1, stale: 1 }, BASE = { open: 0, approved: 1, stale: 0 };

/**
 * [route, body] of writer `kind` by `principal`, marked `mark` so that the stored text says whose write it was.
 * `head` is the confirmed version the document saw, `base` the version its draft stands on (the head unless given).
 */
function request(kind, principal, { token, epoch, head, base = head, mark }) {
  const pre = { expectedOwner: ownerOf(principal), expectedRevision: token };
  const text = `SYN ${kind} by ${mark}`;
  const snapshot = (findings, baseVersion = base) => ({ ...pre, findings, conclusion: 'SYN conclusion ' + mark, recommendation: '',
    baseVersion, citationIds: [], structureIds: [] });
  if (kind === 'put') return ['put', snapshot(text)];
  if (kind === 'rebase') return ['put', snapshot(text, 1)];
  if (kind === 'insert') return ['put', { ...snapshot(text + '\n' + CITED), insert: { field: 'findings', findingId: FINDING,
    findingRevision: 1, sourceIndex: 0, insertedText: CITED, expectedLinkState: 'current', expectedHeadRevision: 1 } }];
  if (kind === 'structure') return ['put', { ...snapshot(text + '\n' + STRUCT_LINE), structure: { op: 'apply', field: 'findings',
    templateId: STRUCTURE_CATALOG[0].templateId, templateRevision: STRUCTURE_CATALOG[0].revision, itemCode: STRUCT_ITEM.code,
    valueType: STRUCT_ITEM.valueType, value: true, renderedText: STRUCT_LINE } }];
  if (kind === 'clear') return ['put', { ...pre, findings: '', conclusion: '', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [] }];
  if (kind === 'discard') return ['discard', pre];
  if (kind === 'force') return ['force', { expectedOwner: ownerOf(principal), expectedEpoch: epoch }];
  assert.ok(COMMITS.has(kind), 'unknown writer ' + kind);
  return ['commit', { ...pre, action: kind, findings: text, conclusion: 'SYN conclusion ' + mark, recommendation: '', baseVersion: head,
    ...(kind === 'reset' || kind === 'defer' ? { reason: 'SYN reason ' + mark } : {}),
    ...(kind === 'preliminary' ? { reviewer: REVIEWER.actor } : {}) }];
}

/** The fixture of a pair: one both writers are admissible in, alone. null = no such state exists. */
function fixtureFor(x, y) {
  for (const fixture of ['open', 'approved', 'stale'])
    if (ADMISSIBLE[fixture].includes(x) && ADMISSIBLE[fixture].includes(y)) return fixture;
  return null;
}
const studyOf = (w, fixture, draft) => w.study(fixture === 'open' ? { rs: 'W', draft } : { rs: 'A', draft, staleBase: fixture === 'stale' });

/**
 * The reduced matrix (U5S-REQ-23 as narrowed by the fix10s work order: representative cases, not the full product of
 * writer kinds x eight orderings x four principal relations).
 *
 * Writers: the thirteen kinds reach the draft boundary through five server paths, and a race is run once per pair of
 * paths, not once per pair of kinds -
 *   content  putReport with text: autosave, explicit save, preservation, preparation save, Recover Draft, stale rebase,
 *            citation insertion, structure apply (one conditional write of the caller's row)
 *   clear    putReport with three empty texts (the tombstone write of the same handler)
 *   discard  discardDraft
 *   commit   commitReport: save, approve, preliminary, defer, addendum, reset
 *   force    forceDiscardDrafts (the epoch)
 * What differs between the kinds of one path (the rebase audit row, citation and structure entries, each commit
 * action's report-state rule) does not decide a race at the boundary; it is asserted in D10, D09 and the report suites.
 * Orderings: what is stored is decided by which transaction commits first, so both completion orders run; the order in
 * which the two answers are handed over cannot change it and is varied once (the winner's answer held back).
 * Principals: one owner in one session. Another session of the same owner, another subject and another institution do
 * not change which row a write lands in or which boundary it carries: those are D05 and D09.
 */
const PATH_OF = { put: 'content', rebase: 'content', insert: 'content', structure: 'content', clear: 'clear', discard: 'discard',
  save: 'commit', approve: 'commit', preliminary: 'commit', defer: 'commit', addendum: 'commit', reset: 'commit', force: 'force' };
const REPRESENTATIVE = { content: 'put', clear: 'clear', discard: 'discard', commit: 'approve', force: 'force' };
const MATRIX = Object.values(REPRESENTATIVE);
const ORDERINGS = [['XY', 'XY', 'XY'], ['XY', 'YX', 'XY'], ['XY', 'XY', 'YX']];
const RELATIONS = { 'same owner, one session': { other: A, session: 'same' } };

/** The two requests of a schedule on study `uid`: X by A (or the admin for force), Y by the relation's principal. */
async function pairOn(w, uid, fixture, x, y, relation, sessions) {
  const head = HEAD[fixture], base = BASE[fixture], epoch = await w.epoch(uid);
  const who = (kind, principal) => kind === 'force' ? (principal.institution === INST ? ADMIN : OTHER_ADMIN) : principal;
  const px = who(x, A), py = who(y, RELATIONS[relation].other);
  const sidOf = (principal, slot) => sessions[`${principal.actor}:${slot}`];
  return {
    X: { kind: x, as: px, sid: sidOf(px, 'first'), req: request(x, px, { token: await w.token(uid, px), epoch, head, base, mark: 'X' }) },
    Y: { kind: y, as: py, sid: sidOf(py, RELATIONS[relation].session === 'second' ? 'second' : 'first'),
      req: request(y, py, { token: await w.token(uid, py), epoch, head, base, mark: 'Y' }) },
  };
}
const fire = (w, label, uid, op) => w.send(label, op.req[0], { as: op.as, sid: op.sid, uid, body: op.req[1] });
const brief = answer => ({ ok: answer.ok, status: answer.status, code: answer.code });

/**
 * One schedule. `arrival` and `completion` are 'XY' or 'YX'; `response` is the order the two answers are handed over.
 * Returns the answers in delivery order and by label.
 */
async function schedule(w, uid, pair, arrival, completion, response) {
  const first = arrival[0], second = arrival[1], winner = completion[0];
  let running;
  if (first === winner) {
    // the first to arrive is held with its work done and uncommitted; the other arrives and waits for the study row
    const held = w.gate(first, 'commit');
    const a = fire(w, first, uid, pair[first]);
    const state = await Promise.race([held.arrived().then(() => 'held'), a.then(() => 'answered')]);
    const b = fire(w, second, uid, pair[second]);
    if (state === 'held') {
      // released once the other is seen waiting on the lock, or has answered without needing it (a refusal before the row)
      let settled = false;
      b.then(() => { settled = true; });
      for (const until = performance.now() + 2500; !settled && !(await w.blocked()) && performance.now() < until;)
        await new Promise(resolve => setTimeout(resolve, 5));
      held.release();
    }
    running = { [first]: a, [second]: b };
  } else {
    // the first to arrive is held before its transaction; the other runs to its end; then the first goes on
    const held = w.gate(first, 'prepare');
    const a = fire(w, first, uid, pair[first]);
    const state = await Promise.race([held.arrived().then(() => 'held'), a.then(() => 'answered')]);
    const b = await fire(w, second, uid, pair[second]);
    if (state === 'held') held.release();
    running = { [first]: a, [second]: Promise.resolve(b) };
  }
  const delivered = [];
  for (const label of response) delivered.push([label, await within(running[label], 'the answer of ' + label)]);
  // a request refused before its hold point leaves its hold unused: it must not catch the next schedule's request
  w.gates.length = 0;
  return { delivered, X: await running.X, Y: await running.Y };
}

/** The same two requests one after the other in commit order on a twin study: the serial result of the schedule. */
async function serial(w, fixture, draft, x, y, relation, sessions, completion) {
  const uid = await studyOf(w, fixture, draft);
  const pair = await pairOn(w, uid, fixture, x, y, relation, sessions);
  const before = await w.state(uid);
  const one = await fire(w, completion[0], uid, pair[completion[0]]);
  const middle = await w.state(uid);
  const two = await fire(w, completion[1], uid, pair[completion[1]]);
  return { before, middle, after: await w.state(uid), answers: { [completion[0]]: one, [completion[1]]: two } };
}

// ── D01, D03, D04 over the reduced matrix: every pair of server writer paths, both completion orders, one held answer.
//    First creates (no draft row yet) are D01, D03 (initially absent draft) and D04 (zero present drafts) below. ──

for (const [relation, spec] of Object.entries(RELATIONS)) {
  for (const draft of [true]) {
    test(`D01/D03/D04 matrix: ${relation}, a present draft - every pair of server writer paths, both completion orders and a held answer`, async () => {
      const w = await world();
      const sessions = {};
      for (const principal of [A, B, C, ADMIN, OTHER_ADMIN]) for (const slot of ['first', 'second'])
        sessions[`${principal.actor}:${slot}`] = await w.session(principal);
      const table = [], inapplicable = [];
      const twins = new Map();
      for (let i = 0; i < MATRIX.length; i++) for (let j = 0; j < MATRIX.length; j++) {
        const x = MATRIX[i], y = MATRIX[j];
        // an unordered pair once where both sides are the same owner; ordered where Y is another principal
        if (spec.other === A && j < i) continue;
        if (spec.xKinds && !spec.xKinds.includes(x)) continue;
        // a rebase needs a draft based on an older version: without a draft row it is a first PUT (the `put` row)
        if (!draft && (x === 'rebase' || y === 'rebase')) { inapplicable.push([x, y, 'a rebase raises the base of an existing draft; with no draft row it is the put writer']); continue; }
        const fixture = fixtureFor(x, y);
        if (!fixture) { inapplicable.push([x, y, 'no study state admits both alone: one of them is refused by its report-state rule before the draft boundary (D09 covers that refusal)']); continue; }
        for (const [arrival, completion, response] of ORDERINGS) {
          const key = [fixture, x, y, completion].join('|');
          if (!twins.has(key)) twins.set(key, await serial(w, fixture, draft, x, y, relation, sessions, completion));
          const twin = twins.get(key);
          const uid = await studyOf(w, fixture, draft);
          const pair = await pairOn(w, uid, fixture, x, y, relation, sessions);
          const ran = await schedule(w, uid, pair, arrival, completion, response);
          const after = await w.state(uid);
          const label = `${x} x ${y} [${fixture}] arrival ${arrival} completion ${completion} response ${response}`;
          const winner = completion[0], loser = completion[1];
          assert.deepEqual(ran.delivered.map(([name]) => name).join(''), response, label + ': answers delivered in the asked order');
          assert.notEqual(ran.X.code, 'NOT_HTTP', label + ': X ended as an HTTP answer');
          assert.notEqual(ran.Y.code, 'NOT_HTTP', label + ': Y ended as an HTTP answer');
          // (b) the schedule equals its serial execution in commit order
          assert.deepEqual(after, twin.after, label + ': persisted rows, history and audit equal the serial run in commit order');
          assert.deepEqual([brief(ran[winner]), brief(ran[loser])], [brief(twin.answers[winner]), brief(twin.answers[loser])], label + ': the two answers');
          // (a) literal expectations
          const sameOwner = spec.other === A && x !== 'force' && y !== 'force';
          if (spec.other === C) {
            // another institution never reaches the study: refused as an unknown study, nothing of it stored, and X is
            // exactly what it is alone
            assert.deepEqual([ran.Y.ok, ran.Y.status], [false, 404], label + ': the other institution');
            assert.equal(ran.X.ok, true, label + ': X is admissible alone and takes effect');
            assert.equal(after.drafts.some(d => d.author === C.actor), false, label);
          } else {
            assert.equal(ran[winner].ok, true, label + ': the first to commit is admissible alone and takes effect');
          }
          if (sameOwner) {
            // one owner, one boundary, two writes: exactly one mutation
            assert.equal(ran[loser].ok, false, label + ': the write that commits second carries a boundary that is gone');
            assert.deepEqual(twin.after, twin.middle, label + ': the refused write changed nothing');
            if (DRAFT_ONLY.has(pair[loser].kind)) assert.deepEqual([ran[loser].status, ran[loser].code], [409, 'REPORT_DRAFT_CONFLICT'], label);
            else {
              // a commit that lost: its own report-state rule (400/403) answers first where the winner changed the
              // state it needs; otherwise the boundary refuses it
              assert.ok([400, 403, 409].includes(ran[loser].status), label + ': ' + JSON.stringify(brief(ran[loser])));
              if (ran[loser].status === 409) assert.equal(ran[loser].code, 'REPORT_DRAFT_CONFLICT', label);
            }
            const mine = after.drafts.find(d => d.author === A.actor);
            assert.equal(mine.revision, (draft ? 1 : 0) + 1, label + ': the owner revision advanced exactly once');
          }
          if (pair[winner].kind === 'force' && ran[winner].ok && pair[loser].as.institution === INST) {
            // a force-discard that commits first rotates the epoch: the other request's boundary is of the old epoch
            assert.deepEqual([ran[loser].status, ran[loser].code], [409, 'REPORT_DRAFT_CONFLICT'], label + ': a request of the epoch before the force-discard');
          }
          table.push([x, y, fixture, arrival, completion, response, brief(ran.X), brief(ran.Y)]);
        }
      }
      const refused = table.filter(row => !row[6].ok || !row[7].ok).length;
      report(JSON.stringify({ matrix: relation, draft: draft ? 'present' : 'absent', schedules: table.length, with_a_refused_write: refused,
        x_kinds: spec.xKinds ?? MATRIX, y_kinds: MATRIX, orderings: ORDERINGS, inapplicable: inapplicable.length, inapplicable_pairs: inapplicable }));
      for (const row of table) report('SCHEDULE ' + JSON.stringify({ relation, draft: draft ? 'present' : 'absent', x: row[0], y: row[1], fixture: row[2],
        arrival: row[3], completion: row[4], response: row[5], X: row[6], Y: row[7] }));
      assert.ok(table.length > 0);
    });
  }
}

test('every writer kind of U5S-REQ-23 is named, with what the server sees of it and the server path it takes', () => {
  assert.deepEqual(Object.keys(CLIENT_WRITERS).sort(), [...KINDS].sort());
  assert.deepEqual(Object.keys(PATH_OF).sort(), [...KINDS].sort(), 'no kind without a path');
  assert.deepEqual([...new Set(Object.values(PATH_OF))].sort(), Object.keys(REPRESENTATIVE).sort(), 'every path has its representative in the matrix');
  for (const [path, kind] of Object.entries(REPRESENTATIVE)) assert.equal(PATH_OF[kind], path);
  report('WRITERS ' + JSON.stringify(CLIENT_WRITERS));
  report('PATHS ' + JSON.stringify({ path_of: PATH_OF, representative: REPRESENTATIVE }));
});

// ── D01: first create ──

test('D01 two first creates at revision 0 held at the study row: one success, one REPORT_DRAFT_CONFLICT, one row', async () => {
  const w = await world();
  const uid = await w.study({ draft: false });
  const token = await w.token(uid, A);
  assert.match(token, /:0$/, 'a missing owner row reads as revision 0 in the current epoch');
  const pair = { X: { kind: 'put', as: A, sid: null, req: request('put', A, { token, head: 0, mark: 'X' }) },
    Y: { kind: 'put', as: A, sid: null, req: request('put', A, { token, head: 0, mark: 'Y' }) } };
  const ran = await schedule(w, uid, pair, 'XY', 'XY', 'YX');
  assert.deepEqual([brief(ran.X), brief(ran.Y)], [{ ok: true, status: 200, code: null }, { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' }]);
  const row = await w.row(uid, A);
  assert.deepEqual([row.revision, row.present, row.findings], [1, true, 'SYN put by X'], 'the loser snapshot is not stored');
  assert.equal(await w.base.reportDraft.count({ where: { uid } }), 1);
  assert.deepEqual(await w.audits(uid), [`${A.actor} report.draft`], 'one mutation, one audit row');
  // the answer of the winner is the complete envelope of what is stored
  assert.deepEqual(ran.X.body, { uid, owner: ownerOf(A), revision: `${await w.epoch(uid)}:1`, present: true,
    snapshot: { findings: 'SYN put by X', conclusion: 'SYN conclusion X', recommendation: '', baseVersion: 0, citations: [], structured: [] },
    updatedAt: row.updatedAt });
  assert.equal('revision' in ran.Y.body, false, 'a conflict does not hand out the current revision');
});

// ── D02: a causally newer write ──

test('D02 Y read the revision X committed while X\'s answer is still held: Y commits, the late X answer describes an older revision', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const heldAnswer = w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  const x = await heldAnswer;                       // committed; the harness keeps the answer from the "client" for now
  const seen = await w.send('R', 'read', { as: A, uid });
  assert.equal(seen.body.revision, `${epoch}:2`);
  const y = await w.send('Y', 'put', { as: A, uid, body: request('put', A, { token: seen.body.revision, head: 0, mark: 'Y' })[1] });
  assert.deepEqual([brief(y), y.body.revision], [{ ok: true, status: 200, code: null }, `${epoch}:3`]);
  // now the held X answer is delivered: it names revision 2, which is not the stored revision any more
  assert.equal(x.body.revision, `${epoch}:2`);
  const row = await w.row(uid, A);
  assert.deepEqual([row.revision, row.findings], [3, 'SYN put by Y'], 'the store holds Y');
  // and X's request, arriving again late (a retry of the same request), cannot replace Y
  const again = await w.send('X2', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  assert.deepEqual(brief(again), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' });
  assert.equal((await w.row(uid, A)).findings, 'SYN put by Y');
});

// ── D03: tombstones ──

// One ender per server path that ends a draft (clear, own discard, commit): the six commit actions are one path.
for (const ender of ['clear', 'discard', 'approve']) {
  for (const draft of [true, false]) {
    test(`D03 ${ender} then a late PUT of the boundary before it (${draft ? 'present draft' : 'initially absent draft'}): the tombstone refuses the resurrection`, async () => {
      const w = await world();
      const fixture = ender === 'addendum' ? 'approved' : 'open';
      const uid = fixture === 'open' ? await w.study({ draft }) : await w.study({ rs: 'A', draft });
      const head = fixture === 'approved' ? 1 : 0, epoch = await w.epoch(uid), before = await w.token(uid, A);
      const late = request('put', A, { token: before, head, mark: 'late' });
      const [route, body] = request(ender, A, { token: before, head, mark: 'end' });
      const ended = await w.send('E', route, { as: A, uid, body });
      assert.equal(ended.ok, true, JSON.stringify(ended.body));
      const revision = (draft ? 1 : 0) + 1;
      assert.deepEqual([ended.body.revision, ended.body.present, ended.body.snapshot], [`${epoch}:${revision}`, false, null],
        'the boundary advanced although the content is absent');
      const tomb = await w.row(uid, A);
      assert.deepEqual([tomb.revision, tomb.present, tomb.findings, tomb.conclusion, tomb.recommendation, tomb.baseVersion, tomb.citations, tomb.structured],
        [revision, false, '', '', '', 0, null, null], 'the row stays, emptied, with its revision');
      const answer = await w.send('L', late[0], { as: A, uid, body: late[1] });
      assert.deepEqual(brief(answer), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' });
      assert.deepEqual(await w.row(uid, A), tomb, 'no resurrection');
      // the tombstone is not a draft anywhere it is read
      const read = await w.send('R', 'read', { as: A, uid });
      assert.deepEqual([read.body.present, read.body.snapshot, read.body.revision], [false, null, `${epoch}:${revision}`]);
      if (COMMITS.has(ender) && ender !== 'preliminary') {
        const cites = await w.send('C', 'citations', { as: A, uid });
        assert.deepEqual([cites.body.draft, cites.body.draftRevision], [[], `${epoch}:${revision}`]);
        const structure = await w.send('S', 'structure', { as: A, uid });
        assert.deepEqual([structure.body.draft, structure.body.draftRevision], [[], `${epoch}:${revision}`]);
      }
      // a write from the tombstone's own revision is a normal first write again
      const next = await w.send('N', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:${revision}`,
        head: (await w.base.report.findUnique({ where: { uid } }))?.version ?? 0, mark: 'next' })[1] });
      assert.deepEqual([next.ok, next.body.revision, next.body.present], [true, `${epoch}:${revision + 1}`, true], JSON.stringify(next.body));
    });
  }
}

// ── D04: force-discard ──

test('D04 force-discard archives present drafts, advances their owners, rotates the epoch; every older boundary is refused', async () => {
  const w = await world();
  const uid = await w.study();
  await w.base.reportDraft.create({ data: { uid, author: B.actor, findings: 'SYN draft of b', revision: 4, present: true } });
  await w.base.reportDraft.create({ data: { uid, author: REVIEWER.actor, revision: 2, present: false } });
  const epoch = await w.epoch(uid);
  const stale = { a: `${epoch}:1`, b: `${epoch}:4`, unseen: `${epoch}:0` };
  const forced = await w.send('F', 'force', { as: ADMIN, uid, body: { expectedOwner: ownerOf(ADMIN), expectedEpoch: epoch } });
  assert.equal(forced.ok, true, JSON.stringify(forced.body));
  const next = await w.epoch(uid);
  assert.notEqual(next, epoch, 'the epoch rotated');
  assert.deepEqual([forced.body.count, forced.body.epoch, forced.body.drafts.map(d => d.author)], [2, next, [A.actor, B.actor]]);
  const versions = await w.base.reportVersion.findMany({ where: { uid }, orderBy: { version: 'asc' } });
  assert.deepEqual(versions.map(v => [v.version, v.action, v.author, v.findings]),
    [[1, 'discarded', A.actor, 'SYN first draft'], [2, 'discarded', B.actor, 'SYN draft of b']], 'the archived snapshots, by their authors');
  assert.deepEqual((await w.state(uid)).drafts.map(d => [d.author, d.revision, d.present, d.findings]),
    [[A.actor, 2, false, ''], [B.actor, 5, false, ''], [REVIEWER.actor, 2, false, '']], 'present drafts emptied and advanced; a tombstone untouched');
  assert.deepEqual((await w.audits(uid)).filter(a => a.endsWith('report.draft.force-discard')).length, 1);
  // old boundaries: an owner that had a draft, and one that had never written (first create with the old epoch)
  for (const [who, token] of [[A, stale.a], [B, stale.b], [REVIEWER, stale.unseen]]) {
    const answer = await w.send('old', 'put', { as: who, uid, body: request('put', who, { token, head: 0, mark: 'old' })[1] });
    assert.deepEqual(brief(answer), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' }, who.actor);
  }
  // an old force-discard request too
  const again = await w.send('F2', 'force', { as: ADMIN, uid, body: { expectedOwner: ownerOf(ADMIN), expectedEpoch: epoch } });
  assert.deepEqual(brief(again), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' });
  // a write that read the new epoch goes on from its owner revision
  const fresh = await w.send('new', 'put', { as: A, uid, body: request('put', A, { token: `${next}:2`, head: 0, mark: 'new' })[1] });
  assert.deepEqual([fresh.ok, fresh.body.revision], [true, `${next}:3`]);
});

test('D04 force-discard with zero present drafts still rotates the epoch and is audited; an unseen owner\'s first create of the old epoch is refused', async () => {
  const w = await world();
  const uid = await w.study({ draft: false });
  const epoch = await w.epoch(uid);
  const forced = await w.send('F', 'force', { as: ADMIN, uid, body: { expectedOwner: ownerOf(ADMIN), expectedEpoch: epoch } });
  assert.deepEqual([forced.ok, forced.body.count, forced.body.versions], [true, 0, []]);
  const next = await w.epoch(uid);
  assert.notEqual(next, epoch);
  assert.deepEqual(await w.audits(uid), [`${ADMIN.actor} report.draft.force-discard`]);
  assert.equal(await w.base.reportVersion.count({ where: { uid } }), 0, 'no discard history for a draft that was not there');
  const first = await w.send('old', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:0`, head: 0, mark: 'old' })[1] });
  assert.deepEqual(brief(first), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' });
  assert.equal(await w.row(uid, A), null);
});

// ── D05: the session fence ──

test('D05 a cookie-session draft write commits before the revocation of its session or fails after it', async () => {
  const w = await world();
  // (1) revoked before admission
  let uid = await w.study();
  let sid = await w.session(A);
  await w.auth.logout({ sid, headers: {} });
  assert.equal(await w.base.authSession.count({ where: { sid } }), 0);
  let token = await w.token(uid, A);
  let answer = await w.send('X', 'put', { as: A, sid, uid, body: request('put', A, { token, head: 0, mark: 'X' })[1] });
  assert.deepEqual(brief(answer), { ok: false, status: 401, code: 'AUTH_SESSION_ENDED' }, 'revoked before admission');
  assert.equal((await w.row(uid, A)).findings, 'SYN first draft');

  // (2) revoked during the external preparation (the request has arrived, its transaction has not opened)
  sid = await w.session(A);
  let held = w.gate('X', 'prepare');
  let pending = w.send('X', 'put', { as: A, sid, uid, body: request('put', A, { token, head: 0, mark: 'X' })[1] });
  await held.arrived();
  await w.auth.logout({ sid, headers: {} });
  held.release();
  assert.deepEqual(brief(await pending), { ok: false, status: 401, code: 'AUTH_SESSION_ENDED' }, 'revoked during lookup');
  assert.deepEqual([(await w.row(uid, A)).revision, (await w.row(uid, A)).findings], [1, 'SYN first draft']);

  // (3) the write holds its session row: the revocation waits, the write commits first
  sid = await w.session(A);
  held = w.gate('X', 'commit');
  pending = w.send('X', 'put', { as: A, sid, uid, body: request('put', A, { token, head: 0, mark: 'X' })[1] });
  await held.arrived();
  let revoked = false;
  const logout = w.auth.logout({ sid, headers: {} }).then(() => { revoked = true; });
  for (const until = performance.now() + 2500; !(await w.blocked()) && performance.now() < until;) await new Promise(r => setTimeout(r, 5));
  assert.equal(revoked, false, 'the revocation waits for the write that locked the session');
  assert.equal(await w.base.authSession.count({ where: { sid } }), 1);
  held.release();
  assert.deepEqual(brief(await pending), { ok: true, status: 200, code: null }, 'committed before the revocation');
  await logout;
  assert.equal(await w.base.authSession.count({ where: { sid } }), 0);
  assert.equal((await w.row(uid, A)).findings, 'SYN put by X');
  const order = (await w.base.auditLog.findMany({ where: { OR: [{ target: uid }, { target: A.sub }] }, orderBy: { id: 'asc' } })).map(r => r.action);
  assert.deepEqual(order.slice(-2), ['report.draft', 'auth.logout'], 'the write is recorded before the end of its session');

  // (4) the revocation holds the session row first: the write waits and then finds no session
  uid = await w.study();
  token = await w.token(uid, A);
  sid = await w.session(A);
  held = w.gate('OUT', 'commit');
  const ending = flow.run({ label: 'OUT' }, () => w.auth.logout({ sid, headers: {} }));
  await held.arrived();
  pending = w.send('X', 'put', { as: A, sid, uid, body: request('put', A, { token, head: 0, mark: 'X' })[1] });
  for (const until = performance.now() + 2500; !(await w.blocked()) && performance.now() < until;) await new Promise(r => setTimeout(r, 5));
  held.release();
  await ending;
  assert.deepEqual(brief(await pending), { ok: false, status: 401, code: 'AUTH_SESSION_ENDED' }, 'revoked before the DB lock');
  assert.deepEqual([(await w.row(uid, A)).revision, (await w.row(uid, A)).findings], [1, 'SYN first draft']);
  assert.deepEqual(await w.audits(uid), [], 'a write refused at the fence leaves no audit row');

  // (5) every kind of draft mutation stands behind the same fence
  sid = await w.session(A);
  const adminSid = await w.session(ADMIN);
  await w.auth.logout({ sid, headers: {} });
  await w.auth.logout({ sid: adminSid, headers: {} });
  const epoch = await w.epoch(uid);
  for (const kind of MATRIX) {
    const who = kind === 'force' ? ADMIN : A;
    const [route, body] = request(kind, who, { token, epoch, head: 0, mark: 'X' });
    assert.deepEqual(brief(await w.send('X', route, { as: who, sid: kind === 'force' ? adminSid : sid, uid, body })),
      { ok: false, status: 401, code: 'AUTH_SESSION_ENDED' }, kind);
  }
  assert.equal((await w.state(uid)).drafts[0].revision, 1);
  // a Bearer caller has no session to fence: the same request commits under its own principal
  answer = await w.send('BR', 'put', { as: A, uid, body: request('put', A, { token, head: 0, mark: 'bearer' })[1] });
  assert.equal(answer.ok, true);
});

test('D05 no reassignment: a write carrying one owner never lands in another account\'s row', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  // the old document's request (owner A, A's boundary) arrives under B's session after an account switch
  const sidB = await w.session(B);
  const before = await w.state(uid);
  for (const kind of ['put', 'clear', 'discard', 'approve']) {
    const [route, body] = request(kind, A, { token: `${epoch}:1`, head: 0, mark: 'old' });
    assert.deepEqual(brief(await w.send('X', route, { as: B, sid: sidB, uid, body })),
      { ok: false, status: 409, code: 'REPORT_DRAFT_OWNER_CHANGED' }, kind);
  }
  // each part of the owner is compared: the same subject in another institution, another subject with the same author
  for (const forged of [{ ...ownerOf(A), institution: OTHER }, { ...ownerOf(A), sub: B.sub }, { ...ownerOf(A), author: B.actor }]) {
    const body = { ...request('put', A, { token: `${epoch}:1`, head: 0, mark: 'old' })[1], expectedOwner: forged };
    assert.deepEqual(brief(await w.send('X', 'put', { as: A, uid, body })), { ok: false, status: 409, code: 'REPORT_DRAFT_OWNER_CHANGED' });
  }
  assert.deepEqual(await w.state(uid), before, 'nothing read into, written to or audited for either account');
  assert.equal(await w.row(uid, B), null);
});

// ── D06: crash and restart ──

test('D06 a transaction lost before its commit leaves nothing; a committed revision survives a new process; no ordering lives in memory', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const before = await w.state(uid);
  // before commit: the backend of the in-flight transaction is terminated (the process or the connection died)
  const held = w.gate('X', 'commit');
  const pending = w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  await held.arrived();
  const [{ done }] = await w.base.$queryRawUnsafe(`SELECT pg_terminate_backend(${Number(w.backend)}) AS done`);
  assert.equal(done, true, 'the backend of the held transaction was signalled');
  // the signal is asynchronous: the commit must not reach a backend that has not yet acted on it
  for (const until = performance.now() + 5000; ; ) {
    const [{ n }] = await w.base.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${Number(w.backend)}`);
    if (n === 0) break;
    assert.ok(performance.now() < until, 'the terminated backend is gone');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  held.release();
  const lost = await pending;
  assert.equal(lost.ok, false, 'the request did not answer a success');
  assert.deepEqual(await w.state(uid), before, 'rolled back: data, revision and audit unchanged');
  // the same request again (the same expected revision) after the loss: it was never applied, so it applies now
  w.restart();
  const retried = await w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  assert.deepEqual([retried.ok, retried.body?.revision], [true, `${epoch}:2`]);
  // after commit, before the answer: the answer is lost and the process restarts; the revision is durable
  const unanswered = await w.send('Y', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:2`, head: 0, mark: 'Y' })[1] });
  assert.equal(unanswered.ok, true);                   // (the harness discards this answer: the client never saw it)
  w.restart();
  const read = await w.send('R', 'read', { as: A, uid });
  assert.deepEqual([read.body.revision, read.body.snapshot.findings], [`${epoch}:3`, 'SYN put by Y'], 'durable across the restart');
  // an earlier write of the old process arriving at the new one: refused from the stored revision alone
  for (const stale of [`${epoch}:1`, `${epoch}:2`]) {
    const late = await w.send('late', 'put', { as: A, uid, body: request('put', A, { token: stale, head: 0, mark: 'late' })[1] });
    assert.deepEqual(brief(late), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' }, stale);
  }
  assert.equal((await w.row(uid, A)).findings, 'SYN put by Y');
});

// ── D07: a lost answer ──

test('D07 after an unknown outcome the authoritative read tells exactly what is stored; a blind retry is refused', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const sent = request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1];
  await w.send('X', 'put', { as: A, uid, body: sent });      // answer lost
  const read = await w.send('R', 'read', { as: A, uid });
  assert.deepEqual(read.body, { uid, owner: ownerOf(A), revision: `${epoch}:2`, present: true,
    snapshot: { findings: sent.findings, conclusion: sent.conclusion, recommendation: '', baseVersion: 0, citations: [], structured: [] },
    updatedAt: (await w.row(uid, A)).updatedAt }, 'owner, uid, revision and the entire snapshot');
  const retry = await w.send('X2', 'put', { as: A, uid, body: sent });
  assert.deepEqual(brief(retry), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' }, 'the same request again is not applied twice');
  assert.equal((await w.row(uid, A)).revision, 2);
  // the read is the caller's own: another account sees its own boundary and no content
  const other = await w.send('R', 'read', { as: B, uid });
  assert.deepEqual([other.body.owner, other.body.revision, other.body.present, other.body.snapshot], [ownerOf(B), `${epoch}:0`, false, null]);
  // and the list/bootstrap projection carries the boundary even without a draft
  const boot = await flow.run({ label: 'boot' }, () => w.app.svc.bootstrap(B));
  assert.deepEqual([boot.states[uid].draft, boot.states[uid].draftRevision, boot.states[uid].draftEpoch], [null, `${epoch}:0`, epoch]);
  const mine = await flow.run({ label: 'boot' }, () => w.app.svc.bootstrap(A));
  assert.deepEqual([mine.states[uid].draft.findings, mine.states[uid].draftRevision], [sent.findings, `${epoch}:2`]);
});

// ── D08: rollback and retry of the same revision ──

// One writer per server path: the audit row of each path is written in that path's transaction.
for (const kind of MATRIX) {
  test(`D08 ${kind}: an audit write that fails rolls the whole mutation back; a competitor goes on; the same revision retried succeeds`, async () => {
    const w = await world();
    const fixture = kind === 'addendum' ? 'approved' : 'open';
    const uid = fixture === 'open' ? await w.study() : await w.study({ rs: 'A' });
    const head = fixture === 'approved' ? 1 : 0, epoch = await w.epoch(uid);
    const who = kind === 'force' ? ADMIN : A;
    const [route, body] = request(kind, who, { token: `${epoch}:1`, epoch, head, mark: 'X' });
    const before = await w.state(uid);
    w.fault('X', 'audit', new Error('SYN audit write failed'));
    const failed = await w.send('X', route, { as: who, uid, body });
    assert.equal(failed.ok, false, 'no success without its audit row');
    assert.equal(failed.code, 'NOT_HTTP', 'the failure is not turned into a named success or conflict');
    assert.deepEqual(await w.state(uid), before, 'data, revision, epoch-bound rows, history and audit are unchanged');
    assert.equal(await w.epoch(uid), epoch, 'the epoch did not move');
    // the competitor progresses
    const rival = await w.send('B', 'put', { as: B, uid, body: request('put', B, { token: `${epoch}:0`, head, mark: 'B' })[1] });
    assert.equal(rival.ok, true, JSON.stringify(rival.body));
    // the same request, the same expected revision: nothing was reserved by the failed attempt
    const retried = await w.send('X', route, { as: who, uid, body });
    assert.equal(retried.ok, true, JSON.stringify(retried.body));
    if (kind !== 'force') assert.equal(retried.body.revision, `${epoch}:2`);
    const audits = await w.audits(uid);
    const action = kind === 'put' ? 'report.draft' : kind === 'clear' ? 'report.draft.clear' : kind === 'discard' ? 'report.draft.discard'
      : kind === 'force' ? 'report.draft.force-discard' : 'report.' + kind;
    assert.deepEqual(audits.filter(a => a === `${who.actor} ${action}`).length, 1, 'exactly one audit row of the mutation: ' + JSON.stringify(audits));
  });
}

// ── D09: refusals that change nothing ──

test('D09 missing or malformed preconditions, a fabricated owner, a foreign study, a forbidden role or state: a named refusal and zero mutation', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const good = request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1];
  const before = await w.state(uid);
  const without = (body, key) => { const next = { ...body }; delete next[key]; return next; };
  const cases = [
    // an old client: no preconditions at all
    ['put', A, { findings: 'SYN old client', conclusion: '', recommendation: '', baseVersion: 0 }, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['put', A, without(good, 'expectedOwner'), 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['put', A, without(good, 'expectedRevision'), 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ...['findings', 'conclusion', 'recommendation', 'baseVersion', 'citationIds', 'structureIds'].map(key =>
      ['put', A, without(good, key), 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED']),
    // the array owner and the page order of the removed protocol are not preconditions
    ['put', A, { ...good, expectedOwner: [INST, A.sub, A.actor] }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['put', A, { ...without(good, 'expectedRevision'), draftOrder: ['p', 1] }, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ...[`${epoch}`, `${epoch}:`, `${epoch}:-1`, `${epoch}:01`, `${epoch}:1.0`, `${epoch}:99999999999`, 'x:1', `:1`, 1, { epoch, revision: 1 },
      `${epoch.toUpperCase()}:1`].map(token => ['put', A, { ...good, expectedRevision: token }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID']),
    ['put', A, { ...good, expectedOwner: { ...ownerOf(A), extra: 1 } }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['put', A, { ...good, expectedOwner: { institution: INST, sub: A.sub } }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['put', A, { ...good, findings: 7 }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['put', A, { ...good, baseVersion: '0' }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['put', A, { ...good, citationIds: 'x' }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['put', A, { ...good, structureIds: [1] }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['discard', A, {}, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['discard', A, undefined, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['commit', A, { action: 'save', findings: 'SYN', baseVersion: 0 }, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['commit', A, { action: 'save', findings: 'SYN', baseVersion: 0, expectedOwner: ownerOf(A) }, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['force', ADMIN, { expectedOwner: ownerOf(ADMIN) }, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    ['force', ADMIN, { expectedOwner: ownerOf(ADMIN), expectedEpoch: `${epoch}:1` }, 400, 'REPORT_DRAFT_PRECONDITION_INVALID'],
    ['force', ADMIN, { expectedEpoch: epoch }, 400, 'REPORT_DRAFT_PRECONDITION_REQUIRED'],
    // a fabricated owner
    ['put', A, { ...good, expectedOwner: ownerOf(B) }, 409, 'REPORT_DRAFT_OWNER_CHANGED'],
    ['force', ADMIN, { expectedOwner: ownerOf(A), expectedEpoch: epoch }, 409, 'REPORT_DRAFT_OWNER_CHANGED'],
    // a study of another institution is an unknown study, for an administrator too
    ['put', C, request('put', C, { token: `${epoch}:0`, head: 0, mark: 'C' })[1], 404, null],
    ['discard', C, request('discard', C, { token: `${epoch}:0`, head: 0, mark: 'C' })[1], 404, null],
    ['commit', C, request('approve', C, { token: `${epoch}:0`, head: 0, mark: 'C' })[1], 404, null],
    ['force', OTHER_ADMIN, { expectedOwner: ownerOf(OTHER_ADMIN), expectedEpoch: epoch }, 404, null],
    ['read', C, undefined, 404, null],
    // roles
    ['put', TECH, request('put', TECH, { token: `${epoch}:0`, head: 0, mark: 'T' })[1], 403, null],
    ['discard', TECH, request('discard', TECH, { token: `${epoch}:0`, head: 0, mark: 'T' })[1], 403, null],
    ['commit', TECH, request('approve', TECH, { token: `${epoch}:0`, head: 0, mark: 'T' })[1], 403, null],
    ['force', A, { expectedOwner: ownerOf(A), expectedEpoch: epoch }, 403, null],
    ['read', TECH, undefined, 403, null],
    // report-state rules keep their own answers (the draft boundary does not replace them)
    ['commit', A, request('addendum', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1], 400, null],
    ['commit', A, { ...request('reset', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1], reason: ' ' }, 400, null],
    ['commit', A, { ...request('save', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1], baseVersion: 3 }, 409, null],
    ['put', A, { ...good, baseVersion: 2 }, 400, null],
  ];
  for (const [route, as, body, status, code] of cases) {
    const answer = await w.send('X', route, { as, uid, body });
    assert.deepEqual([answer.status, answer.code ?? null], [status, code], `${route} ${JSON.stringify(body)?.slice(0, 160)}`);
    assert.deepEqual(await w.state(uid), before, `${route}: zero mutation`);
    assert.equal(await w.epoch(uid), epoch);
  }
  // states that forbid the write: an unverified study, a study another reader holds, a preliminary read assigned to others
  for (const [data, status, code] of [[{ ss: 'Unverified' }, 409, null], [{ holder: B.actor, heldAt: new Date() }, 409, 'REPORT_HELD'],
    [{ rs: 'P', preDoc: B.actor, preReviewer: REVIEWER.actor }, 403, null]]) {
    const locked = await w.study();
    await w.base.studyState.update({ where: { uid: locked }, data });
    const at = await w.state(locked), token = await w.token(locked, A);
    for (const kind of ['put', 'approve']) {
      const [route, body] = request(kind, A, { token, head: 0, mark: 'X' });
      const answer = await w.send('X', route, { as: A, uid: locked, body });
      assert.deepEqual([answer.status, answer.code ?? null], [status, code], `${kind} on ${JSON.stringify(Object.keys(data))}`);
      assert.deepEqual(await w.state(locked), at);
    }
  }
  report(JSON.stringify({ d09: cases.length + 6 }));
});

// ── D10: snapshot semantics ──

test('D10 citation and structure entries are part of the snapshot: kept by their full id lists, dropped when a list omits them, gone with a clear', async () => {
  const w = await world();
  const uid = await w.study({ draft: false });
  const epoch = await w.epoch(uid);
  const cite = await w.send('X', 'put', { as: A, uid, body: request('insert', A, { token: `${epoch}:0`, head: 0, mark: 'X' })[1] });
  assert.equal(cite.ok, true, JSON.stringify(cite.body));
  const cid = cite.body.inserted.cid;
  assert.deepEqual([cite.body.revision, cite.body.snapshot.citations, cite.body.snapshot.structured], [`${epoch}:1`, [cid], []]);
  // structure applied on top, keeping the citation by its id
  const applyBody = { ...request('structure', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1], citationIds: [cid] };
  applyBody.findings += '\n' + CITED;
  const applied = await w.send('X', 'put', { as: A, uid, body: applyBody });
  assert.equal(applied.ok, true, JSON.stringify(applied.body));
  const sid = applied.body.applied.sid;
  assert.deepEqual([applied.body.snapshot.citations, applied.body.snapshot.structured, applied.body.revision], [[cid], [sid], `${epoch}:2`]);
  const stored = await w.row(uid, A);
  assert.deepEqual([stored.citations.length, stored.citations[0].insertedBy, stored.structured.length, stored.structured[0].enteredBy],
    [1, A.actor, 1, A.actor], 'the testimony is the server\'s');
  // the dedicated reads carry the boundary of the same snapshot
  const cites = await w.send('C', 'citations', { as: A, uid }), structure = await w.send('S', 'structure', { as: A, uid });
  assert.deepEqual([cites.body.draft.map(e => e.cid), cites.body.draftRevision], [[cid], `${epoch}:2`]);
  assert.deepEqual([structure.body.draft.map(e => e.sid), structure.body.draftRevision], [[sid], `${epoch}:2`]);
  // a citation-only change: the texts and the structure entry stay, the citation is dropped by omission from the full list
  const dropped = await w.send('X', 'put', { as: A, uid, body: { ...applyBody, expectedRevision: `${epoch}:2`, structure: undefined,
    citationIds: [], structureIds: [sid] } });
  assert.deepEqual([dropped.ok, dropped.body.snapshot.citations, dropped.body.snapshot.structured], [true, [], [sid]]);
  assert.deepEqual([(await w.row(uid, A)).citations, (await w.row(uid, A)).structured.length], [null, 1], 'an empty list is stored as absence');
  // a clear ends all of it and keeps the revision; the empty draft is "no draft" everywhere
  const cleared = await w.send('X', 'put', { as: A, uid, body: request('clear', A, { token: `${epoch}:3`, head: 0, mark: 'X' })[1] });
  assert.deepEqual([cleared.body.present, cleared.body.snapshot, cleared.body.revision, cleared.body.updatedAt], [false, null, `${epoch}:4`, null]);
  const after = await w.row(uid, A);
  assert.deepEqual([after.present, after.findings, after.citations, after.structured, after.revision], [false, '', null, null, 4]);
  // the database itself refuses a tombstone with content, whoever writes it
  await assert.rejects(w.base.$executeRawUnsafe(`UPDATE "ReportDraft" SET findings = 'SYN ghost' WHERE uid = '${uid}'`), /ReportDraft_absent_check/);
  await assert.rejects(w.base.$executeRawUnsafe(`UPDATE "ReportDraft" SET revision = 0 WHERE uid = '${uid}'`), /ReportDraft_revision_check/);
  // an empty clear with an operation is refused by the operation's own rule, and changes nothing
  for (const [op, code] of [['insert', 'REPORT_CITATION_TEXT'], ['structure', 'REPORT_STRUCTURE_TEXT']]) {
    const body = { ...request(op, A, { token: `${epoch}:4`, head: 0, mark: 'X' })[1], findings: '', conclusion: '', recommendation: '' };
    assert.deepEqual(brief(await w.send('X', 'put', { as: A, uid, body })), { ok: false, status: 409, code });
  }
  assert.equal((await w.row(uid, A)).revision, 4);
});

test('D10 commit and discard answer the envelope and the state; the commit audit is in the transaction of the commit', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const committed = await w.send('X', 'commit', { as: A, uid, body: request('approve', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  assert.equal(committed.ok, true, JSON.stringify(committed.body));
  assert.deepEqual([committed.body.uid, committed.body.owner, committed.body.revision, committed.body.present, committed.body.snapshot],
    [uid, ownerOf(A), `${epoch}:2`, false, null]);
  assert.deepEqual([committed.body.state.rs, committed.body.state.version, committed.body.state.draft, committed.body.state.draftRevision,
    committed.body.state.findings], ['A', 1, null, `${epoch}:2`, 'SYN approve by X']);
  assert.deepEqual(await w.audits(uid), [`${A.actor} report.approve`]);
  const points = w.points.filter(p => p.startsWith('X:'));
  assert.deepEqual(points.slice(-2), ['X:audit', 'X:commit'], 'the audit row is written before the commit of the same transaction');
  // own discard of an absent draft is a mutation of the boundary too
  const second = await w.study({ draft: false }), e2 = await w.epoch(second);
  const gone = await w.send('X', 'discard', { as: A, uid: second, body: request('discard', A, { token: `${e2}:0`, head: 0, mark: 'X' })[1] });
  assert.deepEqual([gone.ok, gone.body.revision, gone.body.present, gone.body.state.draft, gone.body.state.draftRevision], [true, `${e2}:1`, false, null, `${e2}:1`]);
});

// ── D11: study removal and recreation ──

test('D11 tombstones do not block the removal of a study; the same UID created again has a new epoch that refuses every old boundary', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  // a present draft blocks the removal (it is someone's text); its tombstone does not
  const blocked = await w.send('X', 'remove', { as: ADMIN, uid });
  assert.equal(blocked.status, 400);
  const gone = await w.send('X', 'discard', { as: A, uid, body: request('discard', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  assert.equal(gone.ok, true);
  assert.equal((await w.row(uid, A)).present, false);
  const removed = await w.send('X', 'remove', { as: ADMIN, uid });
  assert.equal(removed.ok, true, JSON.stringify(removed.body));
  assert.equal(await w.base.reportDraft.count({ where: { uid } }), 0, 'the tombstones went with the study');
  // a write of the removed study: unknown study
  assert.equal((await w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:2`, head: 0, mark: 'X' })[1] })).status, 404);
  // the study arrives again under the same UID
  await w.study({ uid, draft: false });
  const next = await w.epoch(uid);
  assert.notEqual(next, epoch, 'a new epoch at each creation');
  for (const token of [`${epoch}:0`, `${epoch}:1`, `${epoch}:2`]) {
    const late = await w.send('late', 'put', { as: A, uid, body: request('put', A, { token, head: 0, mark: 'late' })[1] });
    assert.deepEqual(brief(late), { ok: false, status: 409, code: 'REPORT_DRAFT_CONFLICT' }, token);
  }
  assert.equal(await w.row(uid, A), null);
  const fresh = await w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${next}:0`, head: 0, mark: 'X' })[1] });
  assert.deepEqual([fresh.ok, fresh.body.revision], [true, `${next}:1`]);
});

// ── REQ-18: bounds ──

test('REQ-18 an external preparation that does not answer ends as REPORT_DRAFT_UNAVAILABLE within its bound, with nothing written and no queue behind it', async t => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const before = await w.state(uid);
  const stuck = w.gate('X', 'prepare');                // the lookup never answers
  const started = performance.now();
  const pending = w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  await stuck.arrived();
  // a later write of the same row is not queued behind the stuck one
  const later = await w.send('Y', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'Y' })[1] });
  assert.equal(later.ok, true);
  const answer = await within(pending, 'the bounded answer', 7000);
  const took = performance.now() - started;
  assert.deepEqual(brief(answer), { ok: false, status: 503, code: 'REPORT_DRAFT_UNAVAILABLE' });
  assert.ok(took >= 4900 && took < 6500, `bounded to 5 s (took ${Math.round(took)} ms)`);
  stuck.release();                                      // the late lookup changes nothing
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual((await w.state(uid)).drafts, [{ ...before.drafts[0], revision: 2, findings: 'SYN put by Y', conclusion: 'SYN conclusion Y' }]);
  report(JSON.stringify({ req18_prepare_ms: Math.round(took) }));
});

test('REQ-18 a study row held past the lock wait ends as REPORT_DRAFT_UNAVAILABLE and writes nothing', async () => {
  const w = await world();
  const uid = await w.study();
  const epoch = await w.epoch(uid);
  const before = await w.state(uid);
  const held = w.gate('X', 'commit');
  const holder = w.send('X', 'put', { as: A, uid, body: request('put', A, { token: `${epoch}:1`, head: 0, mark: 'X' })[1] });
  await held.arrived();
  const started = performance.now();
  const waiting = await w.send('B', 'put', { as: B, uid, body: request('put', B, { token: `${epoch}:0`, head: 0, mark: 'B' })[1] });
  const took = performance.now() - started;
  assert.deepEqual(brief(waiting), { ok: false, status: 503, code: 'REPORT_DRAFT_UNAVAILABLE' });
  assert.ok(took >= 2900 && took < 4500, `lock wait bounded to 3 s (took ${Math.round(took)} ms)`);
  assert.equal(await w.row(uid, B), null);
  held.release();
  assert.equal((await holder).ok, true);
  assert.equal(before.drafts.length, 1);
  report(JSON.stringify({ req18_lock_ms: Math.round(took) }));
});

// ── REQ-14/18: the migration's backfill ──

test('REQ-18 migration: existing drafts become present at revision 1 with their content, existing states get distinct epochs', async () => {
  const w = await world();
  const sql = fs.readFileSync('/app/prisma/migrations/20261004120000_draft_revision_session_entry/migration.sql', 'utf8');
  const schema = 'kin_u5s_before';
  // the two tables as they were before this migration, in a scratch schema of the same disposable database
  const run = text => w.base.$executeRawUnsafe(text);
  await run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await run(`CREATE SCHEMA ${schema}`);
  for (const table of ['ReportDraft', 'StudyState', 'AuthSession'])
    await run(`CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
  await run(`ALTER TABLE ${schema}."ReportDraft" DROP CONSTRAINT "ReportDraft_revision_check", DROP CONSTRAINT "ReportDraft_absent_check", DROP COLUMN revision, DROP COLUMN present`);
  await run(`ALTER TABLE ${schema}."StudyState" DROP COLUMN "draftEpoch"`);
  await run(`ALTER TABLE ${schema}."AuthSession" DROP COLUMN "entryProofHash", DROP COLUMN "entryProofExpiresAt"`);
  for (let n = 1; n <= 5; n++) await run(`INSERT INTO ${schema}."StudyState" (uid, "institutionId", "updatedAt") VALUES ('2.25.900.${n}', '${INST}', now())`);
  await run(`INSERT INTO ${schema}."ReportDraft" (uid, author, findings, conclusion, recommendation, "baseVersion", citations, "updatedAt") VALUES
    ('2.25.900.1', 'syn-old@synthetic.test', 'SYN kept findings', 'SYN kept conclusion', 'SYN kept rec', 3, '[{"cid":"syn"}]'::jsonb, now()),
    ('2.25.900.2', 'syn-old@synthetic.test', '', '', 'SYN only rec', 0, NULL, now())`);
  await run(`INSERT INTO ${schema}."AuthSession" (sid, sub, "accessToken", "refreshToken", "atExpiresAt", "lastSeenAt") VALUES ('syn-sid', 'syn', 'a', 'r', now(), now())`);
  // the migration's own statements, against that schema
  const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').split(';').map(s => s.trim())
    .filter(s => s && s !== 'BEGIN' && s !== 'COMMIT');
  assert.ok(statements.length >= 7, 'the migration statements were read');
  await w.base.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path = ${schema}`);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
  });
  const drafts = await w.base.$queryRawUnsafe(`SELECT uid, findings, conclusion, recommendation, "baseVersion", citations, revision, present FROM ${schema}."ReportDraft" ORDER BY uid`);
  assert.deepEqual(drafts, [
    { uid: '2.25.900.1', findings: 'SYN kept findings', conclusion: 'SYN kept conclusion', recommendation: 'SYN kept rec', baseVersion: 3, citations: [{ cid: 'syn' }], revision: 1, present: true },
    { uid: '2.25.900.2', findings: '', conclusion: '', recommendation: 'SYN only rec', baseVersion: 0, citations: null, revision: 1, present: true },
  ], 'content preserved; present at the initial revision');
  const epochs = await w.base.$queryRawUnsafe(`SELECT "draftEpoch"::text AS epoch FROM ${schema}."StudyState"`);
  assert.equal(new Set(epochs.map(row => row.epoch)).size, 5, 'a distinct epoch for every existing state');
  const [session] = await w.base.$queryRawUnsafe(`SELECT "entryProofHash", "entryProofExpiresAt" FROM ${schema}."AuthSession"`);
  assert.deepEqual(session, { entryProofHash: null, entryProofExpiresAt: null });
  await run(`DROP SCHEMA ${schema} CASCADE`);
});

// REQ-S7-U5-DB-RIGHTS -> RISK-STALE-REVIEWER -> CORE-REVIEWER, D623.
test('CORE-REVIEWER preliminary assignment uses current DB eligibility while the provider list is stale',async()=>{
  const w=await world();
  for(const change of [{suspended:true},{institution:OTHER},{roles:['technician']},{approved:false,roles:[],institution:null}]){
    await w.base.memberRights.update({where:{sub:REVIEWER.sub},data:{...change,version:{increment:1}}});
    const uid=await w.study(),token=await w.token(uid,A);
    const [route,body]=request('preliminary',A,{token,head:0,mark:'rights-refusal'});
    assert.equal((await w.send('rights',route,{as:A,uid,body})).status,400);
    assert.equal((await w.state(uid)).study.rs,'W');
    await w.base.memberRights.update({where:{sub:REVIEWER.sub},data:{suspended:false,approved:true,institution:INST,roles:['radiologist'],version:{increment:1}}});
  }
  const uid=await w.study(),token=await w.token(uid,A);
  const [route,body]=request('preliminary',A,{token,head:0,mark:'rights-admitted'});
  assert.equal((await w.send('rights',route,{as:A,uid,body})).status,200);
  assert.equal((await w.state(uid)).study.preReviewer,REVIEWER.actor);
});
