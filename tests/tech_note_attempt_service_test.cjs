'use strict';
/* REQ-S8-CTX-NOTE -> RISK-CTX-NOTE-OUTCOME / RISK-CTX-NOTE-AUDIT -> TEST-S8-NOTE-SVR-01..14: the Tech Note save attempt
 * contract on the server (Astra S8-CTX contract 2026-10-05 section 2). The compiled PacsController handlers and
 * PacsService of the kin-api image; StudyAccessService is the image's own. Every outcome is read back from storage.
 *
 *   - a revision keeps the screen's attempt id; reads (latest and history) answer `attemptId` and the server-computed
 *     `isOwnAttempt` and never the author's subject;
 *   - the same attempt sent again (same study, author, institution, base, text, normalised reason) answers the revision
 *     it wrote - `note` = that receipt, `latestNote` = the current latest - and adds neither a revision nor an audit row;
 *   - the id used for any other request is 400 without the earlier receipt; a malformed id is 400; no id = old rule;
 *   - the id lookup comes after the permission, institution and study-lock checks (a revoked writer gets no receipt) and
 *     before the version check; revision and audit row commit or roll back together;
 *   - two transactions with one id: the same study is serialised by the study row (one revision, both answers the same
 *     receipt), two studies meet at the unique index (one revision, the other 400 - never 500);
 *   - the not-saved proof: `history?before=b+2` shows the exact revision b+1 and its id.
 *
 * Storage. With KIN_TECH_NOTE_DATABASE_URL (a disposable, empty database kin_tech_note_test) the real PrismaService over
 * PostgreSQL: the image's migrations are applied with `prisma migrate deploy` (container only: /app/dist, /app/prisma,
 * /app/node_modules) and transactions, row locks, the unique index and rollback are PostgreSQL's. Without it, an
 * in-file storage stand-in (STAND_IN below) that keeps committed rows apart from a transaction's own, serialises
 * `FOR UPDATE` per study and re-checks unique keys at commit. The stand-in checks the service's logic only; it proves
 * nothing about SQL, isolation, locks or atomicity - those cases count only from the PostgreSQL run (CI runtime job).
 * KIN_TECH_NOTE_API_DIST names a compiled api/src (default /app/dist). Synthetic identities and texts only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

const DIST = process.env.KIN_TECH_NOTE_API_DIST || '/app/dist';
const URL_ENV = process.env.KIN_TECH_NOTE_DATABASE_URL || '';
const DATABASE = 'kin_tech_note_test';
// The container run is the PostgreSQL run: refuse to fall back to the stand-in there.
if (DIST === '/app/dist') assert.ok(URL_ENV, 'set KIN_TECH_NOTE_DATABASE_URL to the disposable ' + DATABASE + ' database');
const PG = !!URL_ENV;

const { PacsController } = require(path.join(DIST, 'pacs.controller'));
const { PacsService } = require(path.join(DIST, 'pacs.service'));
const { StudyAccessService } = require(path.join(DIST, 'study-access.service'));
const nest = createRequire(path.join(DIST, 'pacs.controller.js'));
const { PATH_METADATA, METHOD_METADATA } = nest('@nestjs/common/constants');
const { RequestMethod, HttpException } = nest('@nestjs/common');

const INST = 'syn-inst-a', OTHER = 'syn-inst-b';
const caller = (sub, actor, roles, institution = INST) => ({ sub, actor, roles, institution, kind: 'member' });
const TECH = caller('11111111-1111-4111-8111-111111111111', 'SYN tech A', ['technician']);
const TECH2 = caller('22222222-2222-4222-8222-222222222222', 'SYN tech B', ['technician']);
const RAD = caller('33333333-3333-4333-8333-333333333333', 'SYN radiologist', ['radiologist']);
const FOREIGN = caller('44444444-4444-4444-8444-444444444444', 'SYN tech other', ['technician'], OTHER);
let studySeq = 0;
const studyUid = () => '1.2.826.0.1.3680043.10.99.' + process.pid + '.' + (++studySeq);

// ── the routes: the handler Nest's metadata maps a request to, on the controller the image registers ──
function routed(method, route) {
  const found = [];
  for (const key of Object.getOwnPropertyNames(PacsController.prototype)) {
    const handler = PacsController.prototype[key];
    if (key === 'constructor' || typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
    if (Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod[method]) continue;
    if ([].concat(Reflect.getMetadata(PATH_METADATA, handler)).includes(route)) found.push(handler);
  }
  assert.equal(found.length, 1, `${method} ${route} reaches one handler`);
  return found[0];
}
const SAVE = routed('POST', 'studies/:uid/tech-note');
const LATEST = routed('GET', 'studies/:uid/tech-note');
const HISTORY = routed('GET', 'studies/:uid/tech-note/history');

/** An answer as the client sees it: {status, body}. */
async function answer(run) {
  try { return { status: 200, body: JSON.parse(JSON.stringify(await run())) }; }
  catch (error) {
    if (!(error instanceof HttpException)) return { status: 500, body: { message: String(error?.message ?? error) }, error };
    return { status: error.getStatus(), body: error.getResponse() };
  }
}

// ── storage: PostgreSQL or the stand-in, behind one small surface ──
function standIn() {
  const committed = { studies: new Map(), notes: [], audit: [] };
  const queues = new Map();
  const hooks = { failAudit: null, beforeCommit: null, beforeTransaction: null };
  const pendingIds = new Map(); // attempt id -> the open transaction that inserted it
  let waiting = 0;
  const P2002 = target => Object.assign(new Error('Unique constraint failed on the fields: (' + target + ')'), { code: 'P2002', meta: { target } });
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k] ?? null])) : { ...row });
  async function lock(tx, uid) {
    const previous = queues.get(uid) || Promise.resolve();
    let release; const mine = new Promise(resolve => { release = resolve; });
    queues.set(uid, previous.then(() => mine));
    waiting++; try { await previous; } finally { waiting--; }
    tx.held.push(release);
  }
  async function query(tx, strings, values) {
    const sql = strings.join('?');
    if (sql.includes('pg_advisory_xact_lock')) return [{ locked: 1 }];
    if (sql.includes('"StudyAccessPolicy"')) return [];
    if (sql.includes('FROM "StudyState"')) {
      if (tx && sql.includes('FOR UPDATE')) await lock(tx, values[0]);
      const row = committed.studies.get(values[0]);
      return row ? [{ ...row }] : [];
    }
    throw new Error('stand-in: unexpected query ' + sql);
  }
  function view(tx) {
    const rows = () => [...committed.notes, ...tx.notes];
    return {
      $executeRaw: async () => 0,
      $queryRaw: (strings, ...values) => query(tx, strings, values),
      techNoteRevision: {
        findUnique: async ({ where, select }) => { const row = rows().find(n => n.attemptId === where.attemptId); return row ? pick(row, select) : null; },
        findFirst: async ({ where, select }) => {
          const row = rows().filter(n => n.studyUid === where.studyUid).sort((a, b) => b.version - a.version)[0];
          return row ? pick(row, select) : null;
        },
        findMany: async ({ where, take, select }) => rows().filter(n => n.studyUid === where.studyUid && n.version < where.version.lt)
          .sort((a, b) => b.version - a.version).slice(0, take).map(row => pick(row, select)),
        create: async ({ data, select }) => {
          const row = { createdAt: new Date(), attemptId: null, ...data };
          // Like a unique index: an id another open transaction inserted is waited for, then checked again.
          const owner = row.attemptId && pendingIds.get(row.attemptId);
          if (owner && owner !== tx) { waiting++; try { await owner.done; } finally { waiting--; } }
          if (row.attemptId && rows().some(n => n.attemptId === row.attemptId)) throw P2002(['attemptId']);
          if (rows().some(n => n.studyUid === row.studyUid && n.version === row.version)) throw P2002(['studyUid', 'version']);
          tx.notes.push(row);
          if (row.attemptId) pendingIds.set(row.attemptId, tx);
          return pick(row, select);
        },
      },
      auditLog: { create: async ({ data }) => { if (hooks.failAudit?.(data)) throw new Error('SYN audit write failed'); tx.audit.push({ ...data }); return data; } },
    };
  }
  const prisma = {
    $queryRaw: (strings, ...values) => query(null, strings, values),
    async $transaction(fn) {
      if (hooks.beforeTransaction) await hooks.beforeTransaction();
      let finish; const tx = { notes: [], audit: [], held: [], done: new Promise(resolve => { finish = resolve; }) };
      try {
        const result = await fn(view(tx));
        if (hooks.beforeCommit) await hooks.beforeCommit();
        // A second insert of a committed key waits for the first transaction and then violates the index.
        for (const row of tx.notes) {
          if (row.attemptId && committed.notes.some(n => n.attemptId === row.attemptId)) throw P2002(['attemptId']);
          if (committed.notes.some(n => n.studyUid === row.studyUid && n.version === row.version)) throw P2002(['studyUid', 'version']);
        }
        committed.notes.push(...tx.notes); committed.audit.push(...tx.audit);
        return result;
      } finally {
        for (const row of tx.notes) if (pendingIds.get(row.attemptId) === tx) pendingIds.delete(row.attemptId);
        for (const release of tx.held) release();
        finish();
      }
    },
  };
  return {
    prisma, hooks, name: 'stand-in',
    waiting: async () => waiting,
    async study(uid, institutionId = INST) { committed.studies.set(uid, { uid, institutionId, teleInstitutionId: null }); },
    async rows(uid) { return committed.notes.filter(n => n.studyUid === uid).sort((a, b) => a.version - b.version).map(n => ({ ...n })); },
    async audits(uid) { return committed.audit.filter(a => a.target === uid && a.action === 'tech-note.revise').map(a => ({ ...a })); },
    async seed(uid, rows) { for (const row of rows) committed.notes.push({ createdAt: new Date(), attemptId: null, institutionId: INST, ...row, studyUid: uid }); },
  };
}

let pg = null;
function postgres() {
  pg ??= (async () => {
    assert.equal(new URL(URL_ENV).pathname, '/' + DATABASE, 'refusing any database but the disposable ' + DATABASE);
    process.env.DATABASE_URL = URL_ENV;
    const { PrismaService } = require(path.join(DIST, 'prisma.service'));
    const base = new PrismaService();
    await base.$connect();
    const [{ tables }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(tables, 0, 'refusing a database that already holds tables: this file writes the tables it reads');
    execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'],
      { cwd: '/app', env: { ...process.env, DATABASE_URL: URL_ENV, HOME: os.tmpdir(), CHECKPOINT_DISABLE: '1' }, stdio: 'pipe' });
    const applied = await base.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const folders = fs.readdirSync('/app/prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.deepEqual(applied.map(row => row.migration_name).sort(), folders, 'every migration of the image applied');
    for (const id of [INST, OTHER]) await base.institution.create({ data: { id, name: id } });
    const hooks = { failAudit: null, beforeCommit: null, beforeTransaction: null };
    // A recording view of the real client: the service's own transactions, with an audit write that can be made to fail
    // and a pause after the work, before the commit. Nothing else is replaced.
    const wrap = tx => new Proxy(tx, { get(target, key) {
      if (key === 'auditLog') return { create: async args => { if (hooks.failAudit?.(args.data)) throw new Error('SYN audit write failed'); return target.auditLog.create(args); } };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const prisma = new Proxy(base, { get(target, key) {
      if (key === '$transaction') return async (fn, options) => { if (hooks.beforeTransaction) await hooks.beforeTransaction(); return target.$transaction(async tx => {
        const result = await fn(wrap(tx));
        if (hooks.beforeCommit) await hooks.beforeCommit();
        return result;
      }, options); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return {
      prisma, hooks, name: 'postgresql', base,
      async waiting() {
        const [{ n }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        return n;
      },
      async study(uid, institutionId = INST) { await base.studyState.create({ data: { uid, institutionId } }); },
      async rows(uid) { return base.techNoteRevision.findMany({ where: { studyUid: uid }, orderBy: { version: 'asc' } }); },
      async audits(uid) { return base.auditLog.findMany({ where: { target: uid, action: 'tech-note.revise' }, orderBy: { id: 'asc' } }); },
      async seed(uid, rows) { for (const row of rows) await base.techNoteRevision.create({ data: { institutionId: INST, authorSub: 'syn-seed', author: 'SYN seed', ...row, studyUid: uid } }); },
    };
  })();
  return pg;
}
test.after(async () => { if (pg) await (await pg).base.$disconnect(); });

let shared = null;
async function world() {
  const store = PG ? await postgres() : (shared ??= standIn());
  store.hooks.failAudit = null; store.hooks.beforeCommit = null; store.hooks.beforeTransaction = null;
  const access = new StudyAccessService(store.prisma, {}, {});
  const svc = new PacsService(store.prisma, {}, {}, access, {});
  const controller = new PacsController(svc);
  const req = who => ({ ...who, headers: {} });
  return {
    store,
    save: (uid, body, who = TECH) => answer(() => SAVE.call(controller, uid, body, req(who))),
    latest: (uid, who = TECH) => answer(() => LATEST.call(controller, uid, req(who))),
    history: (uid, before, who = TECH) => answer(() => HISTORY.call(controller, uid, before, req(who))),
    async study(institutionId = INST) { const uid = studyUid(); await store.study(uid, institutionId); return uid; },
  };
}
const body = (baseVersion, text, reason = '', attemptId = randomUUID()) => ({ baseVersion, text, reason, attemptId });
const receiptOf = row => ({ version: row.version, text: row.text, attemptId: row.attemptId });
/** The detail of a tech-note audit row, parsed. */
const detail = row => JSON.parse(row.detail);

/** Pause the next transaction after its work, before its commit. */
function holdNextCommit(store) {
  let reached, release;
  const at = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  store.hooks.beforeCommit = async () => { store.hooks.beforeCommit = null; reached(); await gate; };
  return { at, release };
}
async function untilWaiting(store, n) {
  for (let i = 0; i < 400; i++) { if (await store.waiting() >= n) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('no transaction waited for the held one');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test('TEST-S8-NOTE-SVR-01 a new save keeps its attempt id; receipt, latestNote and audit row carry it', async () => {
  const w = await world(), uid = await w.study(), first = body(0, 'SYN first note');
  const a = await w.save(uid, first);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual({ uid: a.body.uid, writable: a.body.writable }, { uid, writable: true });
  assert.deepEqual([a.body.note.version, a.body.note.attemptId, a.body.note.isOwnAttempt], [1, first.attemptId, true]);
  assert.deepEqual(a.body.latestNote, a.body.note, 'a new save is also the latest');
  assert.equal('authorSub' in a.body.note, false, 'the author subject stays on the server');
  assert.deepEqual((await w.store.rows(uid)).map(receiptOf), [{ version: 1, text: 'SYN first note', attemptId: first.attemptId }]);
  const audits = await w.store.audits(uid);
  assert.equal(audits.length, 1);
  assert.deepEqual(detail(audits[0]), { version: 1, institutionId: INST, attemptId: first.attemptId });
  const second = body(1, 'SYN second note', '  SYN dose corrected  ');
  const b = await w.save(uid, second);
  assert.equal(b.status, 200);
  assert.deepEqual([b.body.note.version, b.body.note.reason, b.body.note.attemptId], [2, 'SYN dose corrected', second.attemptId]);
});

test('TEST-S8-NOTE-SVR-02 the same attempt sent again answers its revision and writes no revision or audit row', async () => {
  const w = await world(), uid = await w.study(), sent = body(0, 'SYN note');
  const first = await w.save(uid, sent);
  const again = await w.save(uid, { ...sent });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.note, first.body.note, 'the resend answers the first receipt');
  assert.deepEqual(again.body.latestNote, first.body.note);
  assert.equal((await w.store.rows(uid)).length, 1);
  assert.equal((await w.store.audits(uid)).length, 1, 'an idempotent resend adds no audit row');
  // The normalised reason is the request: surrounding blanks of the reason do not make another request.
  const edit = body(1, 'SYN note v2', 'SYN reason');
  assert.equal((await w.save(uid, edit)).status, 200);
  const padded = await w.save(uid, { ...edit, reason: '  SYN reason  ' });
  assert.equal(padded.status, 200);
  assert.equal(padded.body.note.version, 2);
  assert.equal((await w.store.rows(uid)).length, 2);
});

test('TEST-S8-NOTE-SVR-03 a resend after a later revision answers its own v2 as note and the later v3 as latestNote', async () => {
  const w = await world(), uid = await w.study();
  assert.equal((await w.save(uid, body(0, 'SYN v1'))).status, 200);
  const mine = body(1, 'SYN v2 mine', 'SYN reason');
  assert.equal((await w.save(uid, mine)).status, 200);
  const theirs = await w.save(uid, body(2, 'SYN v3 theirs', 'SYN their reason'), TECH2);
  assert.equal(theirs.status, 200);
  const again = await w.save(uid, mine);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.note.version, again.body.note.attemptId, again.body.note.isOwnAttempt], [2, mine.attemptId, true]);
  assert.deepEqual([again.body.latestNote.version, again.body.latestNote.isOwnAttempt], [3, false]);
  assert.equal((await w.store.rows(uid)).length, 3);
  assert.equal((await w.store.audits(uid)).length, 3);
});

test('TEST-S8-NOTE-SVR-04 an id reused for another request is 400 without the earlier receipt and changes nothing', async () => {
  const w = await world(), uid = await w.study(), other = await w.study(), sent = body(0, 'SYN original');
  assert.equal((await w.save(uid, sent)).status, 200);
  const before = await w.store.rows(uid);
  const variants = [
    ['another text', uid, { ...sent, text: 'SYN changed text' }, TECH],
    ['another reason', uid, { ...sent, reason: 'SYN other reason' }, TECH],
    ['another base', uid, { ...sent, baseVersion: 1, text: 'SYN original v2', reason: 'R' }, TECH],
    ['another author', uid, { ...sent }, TECH2],
    ['another study', other, { ...sent }, TECH],
  ];
  for (const [name, target, request, who] of variants) {
    const reply = await w.save(target, request, who);
    assert.equal(reply.status, 400, name + ': ' + JSON.stringify(reply.body));
    assert.equal(JSON.stringify(reply.body).includes('SYN original'), false, name + ': no earlier receipt in the refusal');
    assert.equal(reply.body.note, undefined, name);
  }
  assert.deepEqual(await w.store.rows(uid), before);
  assert.deepEqual(await w.store.rows(other), []);
  assert.equal((await w.store.audits(uid)).length, 1);
  assert.equal((await w.store.audits(other)).length, 0);
});

test('TEST-S8-NOTE-SVR-05 a malformed attempt id is 400 before any write; no id keeps the older behaviour', async () => {
  const w = await world(), uid = await w.study();
  for (const bad of ['not-a-uuid', '', null, 7, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '6f1c4c4e-0b8a-11ee-be56-0242ac120002',
    '00000000-0000-0000-0000-000000000000', randomUUID() + ' ']) {
    const reply = await w.save(uid, { baseVersion: 0, text: 'SYN note', reason: '', attemptId: bad });
    assert.equal(reply.status, 400, JSON.stringify(bad) + ': ' + JSON.stringify(reply.body));
  }
  assert.deepEqual(await w.store.rows(uid), []);
  assert.equal((await w.store.audits(uid)).length, 0);
  const old = await w.save(uid, { baseVersion: 0, text: 'SYN older screen', reason: '' });
  assert.equal(old.status, 200);
  assert.deepEqual([old.body.note.attemptId, old.body.note.isOwnAttempt], [null, false]);
  const [row] = await w.store.rows(uid);
  assert.equal(row.attemptId, null);
  assert.deepEqual(detail((await w.store.audits(uid))[0]), { version: 1, institutionId: INST, attemptId: null });
  // The old rules still hold without an id: a stale base is 409, an unchanged text 400.
  assert.equal((await w.save(uid, { baseVersion: 0, text: 'SYN late', reason: '' })).status, 409);
  assert.equal((await w.save(uid, { baseVersion: 1, text: 'SYN older screen', reason: 'R' })).status, 400);
});

test('TEST-S8-NOTE-SVR-06 reads answer attemptId and isOwnAttempt per caller, never the author subject; NULL ids are nobody\'s', async () => {
  const w = await world(), uid = await w.study();
  await w.store.seed(uid, [{ version: 1, text: 'SYN before ids', reason: '', author: TECH.actor, authorSub: TECH.sub }]);
  const mine = body(1, 'SYN mine', 'R1');
  assert.equal((await w.save(uid, mine)).status, 200);
  const theirs = body(2, 'SYN theirs', 'R2');
  assert.equal((await w.save(uid, theirs, TECH2)).status, 200);
  const latestForMe = await w.latest(uid), latestForThem = await w.latest(uid, TECH2), latestForRad = await w.latest(uid, RAD);
  assert.deepEqual([latestForMe.body.note.attemptId, latestForMe.body.note.isOwnAttempt], [theirs.attemptId, false]);
  assert.deepEqual([latestForThem.body.note.attemptId, latestForThem.body.note.isOwnAttempt], [theirs.attemptId, true]);
  assert.deepEqual([latestForRad.body.note.isOwnAttempt, latestForRad.body.writable], [false, false]);
  const history = await w.history(uid, '4');
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.items.map(i => [i.version, i.attemptId, i.isOwnAttempt]),
    [[3, theirs.attemptId, false], [2, mine.attemptId, true], [1, null, false]], 'a NULL-id revision of the same author is not this attempt');
  for (const item of [...history.body.items, latestForMe.body.note]) assert.equal('authorSub' in item, false);
  // The not-saved proof: before=b+2 shows the exact revision b+1 with another id.
  const proof = await w.history(uid, String(1 + 2));
  assert.deepEqual(proof.body.items.map(i => [i.version, i.attemptId]), [[2, mine.attemptId], [1, null]]);
  const lostBid = body(1, 'SYN lost bid', 'R');
  assert.equal(proof.body.items.find(i => i.version === lostBid.baseVersion + 1).attemptId === lostBid.attemptId, false);
});

test('TEST-S8-NOTE-SVR-07 permission, institution and role are checked before any id lookup: no receipt for a revoked writer', async () => {
  const w = await world(), uid = await w.study(), sent = body(0, 'SYN note');
  assert.equal((await w.save(uid, sent)).status, 200);
  const revoked = { ...TECH, roles: ['radiologist'] };
  for (const [name, who, expected] of [['role revoked', revoked, 403], ['no role', { ...TECH, roles: [] }, 403],
    ['other institution', { ...TECH, institution: OTHER }, 404], ['not a member', { ...TECH, kind: 'gateway' }, 403]]) {
    const reply = await w.save(uid, { ...sent }, who);
    assert.equal(reply.status, expected, name + ': ' + JSON.stringify(reply.body));
    assert.equal(reply.body.note, undefined, name + ': no receipt');
  }
  const foreignStudy = await w.study(OTHER);
  assert.equal((await w.save(foreignStudy, body(0, 'SYN x'), TECH)).status, 404);
  assert.equal((await w.save(uid, body(1, 'SYN x', 'R'), FOREIGN)).status, 404);
  assert.equal((await w.store.rows(uid)).length, 1);
  assert.equal((await w.store.audits(uid)).length, 1);
});

test('TEST-S8-NOTE-SVR-08 a failed audit write rolls the revision back; the same id then saves once', async () => {
  const w = await world(), uid = await w.study(), sent = body(0, 'SYN note');
  w.store.hooks.failAudit = () => true;
  const failed = await w.save(uid, sent);
  assert.ok(failed.status >= 500, 'a failed audit write is a server fault: ' + failed.status);
  w.store.hooks.failAudit = null;
  assert.deepEqual(await w.store.rows(uid), [], 'the revision rolled back with its audit row');
  assert.equal((await w.store.audits(uid)).length, 0);
  const again = await w.save(uid, sent);
  assert.equal(again.status, 200);
  assert.equal(again.body.note.attemptId, sent.attemptId);
  assert.equal((await w.store.rows(uid)).length, 1);
  assert.equal((await w.store.audits(uid)).length, 1);
});

test('TEST-S8-NOTE-SVR-09 an answer lost after the commit: the resend of the same id finds the revision, never a second', async () => {
  const w = await world(), uid = await w.study();
  assert.equal((await w.save(uid, body(0, 'SYN v1'))).status, 200);
  const sent = body(1, 'SYN v2', 'R');
  const hold = holdNextCommit(w.store);
  const lost = w.save(uid, sent); // its answer is dropped below
  await hold.at; hold.release(); await lost;
  const resend = await w.save(uid, sent);
  assert.equal(resend.status, 200);
  assert.deepEqual([resend.body.note.version, resend.body.note.attemptId], [2, sent.attemptId]);
  assert.equal((await w.store.rows(uid)).length, 2);
  assert.equal((await w.store.audits(uid)).length, 2);
});

/** Pause the next transaction before it opens (the request arrived, it is not at the database yet). */
function holdNextStart(store) {
  let reached, release;
  const at = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  store.hooks.beforeTransaction = async () => { store.hooks.beforeTransaction = null; reached(); await gate; };
  return { at, release };
}

for (const order of ['the resend waits for the first commit', 'the resend commits before the first reaches the database']) {
  test(`TEST-S8-NOTE-SVR-10 one id sent twice at once on one study (${order}): one revision, one audit row, the same receipt twice`, async () => {
    const w = await world(), uid = await w.study(), sent = body(0, 'SYN same attempt');
    let x, y;
    if (order.startsWith('the resend waits')) {
      const hold = holdNextCommit(w.store);
      x = w.save(uid, sent);
      await hold.at;
      y = w.save(uid, { ...sent });
      await untilWaiting(w.store, 1); // the resend waits for the study row the first holds
      hold.release();
    } else {
      const hold = holdNextStart(w.store);
      x = w.save(uid, sent);
      await hold.at;
      y = w.save(uid, { ...sent });
      await y; // the resend commits first
      hold.release();
    }
    const [a, b] = await Promise.all([x, y]);
    assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
    assert.deepEqual(b.body.note, a.body.note);
    assert.equal((await w.store.rows(uid)).length, 1);
    assert.equal((await w.store.audits(uid)).length, 1);
  });
}

for (const first of ['A', 'B']) {
  test(`TEST-S8-NOTE-SVR-11 two ids on one base at once (${first} commits first): one wins, the other is 409, ids decide which`, async () => {
    const w = await world(), uid = await w.study(), A = body(0, 'SYN A'), B = body(0, 'SYN B');
    const [early, late] = first === 'A' ? [A, B] : [B, A];
    const hold = holdNextCommit(w.store);
    const x = w.save(uid, early);
    await hold.at;
    const y = w.save(uid, late);
    await untilWaiting(w.store, 1);
    hold.release();
    const [a, b] = await Promise.all([x, y]);
    assert.deepEqual([a.status, b.status], [200, 409]);
    const rows = await w.store.rows(uid);
    assert.deepEqual(rows.map(receiptOf), [{ version: 1, text: early.text, attemptId: early.attemptId }]);
    // The loser's id is not in the exact next revision: the not-saved proof.
    const proof = await w.history(uid, '2');
    assert.notEqual(proof.body.items.find(i => i.version === 1).attemptId, late.attemptId);
  });
}

test('TEST-S8-NOTE-SVR-12 one id on two studies at once meets the unique index: one revision, the other 400 (never 500)', async () => {
  const w = await world(), one = await w.study(), two = await w.study(), id = randomUUID();
  const hold = holdNextCommit(w.store);
  const x = w.save(one, body(0, 'SYN one', '', id));
  await hold.at;
  const y = w.save(two, body(0, 'SYN two', '', id));
  await untilWaiting(w.store, 1); // the second insert waits for the first's index entry
  hold.release();
  const [a, b] = await Promise.all([x, y]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 400, JSON.stringify(b.body));
  assert.equal((await w.store.rows(one)).length, 1);
  assert.equal((await w.store.rows(two)).length, 0);
  assert.equal((await w.store.audits(two)).length, 0);
});

test('TEST-S8-NOTE-SVR-13 the first note must not be blank: the server refuses whitespace directly', async () => {
  const w = await world(), uid = await w.study();
  for (const text of ['', '   ', '\n\t ']) {
    const reply = await w.save(uid, body(0, text));
    assert.equal(reply.status, 400, JSON.stringify(text));
  }
  assert.deepEqual(await w.store.rows(uid), []);
  assert.equal((await w.store.audits(uid)).length, 0);
});

test('TEST-S8-NOTE-SVR-14 an edit with an id still needs a reason and a changed text; a refusal writes nothing', async () => {
  const w = await world(), uid = await w.study();
  assert.equal((await w.save(uid, body(0, 'SYN v1'))).status, 200);
  assert.equal((await w.save(uid, body(1, 'SYN v2', '   '))).status, 400);
  assert.equal((await w.save(uid, body(1, 'SYN v1', 'R'))).status, 400);
  assert.equal((await w.save(uid, body(0, 'SYN stale', 'R'))).status, 409);
  assert.equal((await w.store.rows(uid)).length, 1);
  assert.equal((await w.store.audits(uid)).length, 1);
});

test('storage of this run', () => { process.stderr.write('S8-NOTE-SVR storage: ' + (PG ? 'postgresql' : 'stand-in (logic only)') + '\n'); });
