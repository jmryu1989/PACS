'use strict';
/* B2-COMMIT on PostgreSQL: AccessLedgerStore (the compiled image's /app/dist) answers from the commit log of its own
 * transaction. Plan section 5: K1-K10 and K13 at the store boundary (the PACS draft consumer's K2/K3/K11 are in
 * tests/report_draft_cas_service_test.cjs). Run by tests/emr/b/pg_ledger_restore_test.py PgLedgerCommitJudgementLive.
 *
 * Every case observes the branch it is about before it asserts an answer:
 *  (i)  a deferred constraint trigger records, on sequences its rollback does not undo, whether it fired at COMMIT and
 *       the full XID it fired in (and RAISE LOGs that XID for the server log the Python side keeps);
 *  (ii) a witness connection reads that XID's pg_xact_status and the rows by their business keys;
 *  (iii) the trigger is deferrable and initially deferred (catalog);
 *  (v)  a relay between the product's client and PostgreSQL, working on protocol messages, holds a COMMIT answer, cuts a
 *       client connection, or blocks every later message (new connections and the pool's open ones) while recording what
 *       it blocked. Transaction control is told by the protocol's BEGIN/COMMIT/ROLLBACK commands, never by product SQL.
 * Synthetic rows only; the fixture database is the Python fixture's own.
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const build = process.env.KIN_B2R_BUILD;
if (!build) throw new Error('Compiled candidate path required');
const { PrismaClient } = require('@prisma/client');
const { AccessLedgerStore } = require(path.join(build, 'emr-runtime/store.js'));
const { EmrLedgerClient } = require(path.join(build, 'emr-runtime/client.js'));
const { FailureJournal, FailureSpool } = require(path.join(build, 'emr-runtime/failure-journal.js'));

const log = (label, value) => console.log(JSON.stringify({ case: label, ...value }));
// A case that gave up on an answer (its bound passed) must not end the run when that answer arrives later.
process.on('unhandledRejection', error => console.error('LATE REJECTION', error?.code ?? String(error)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled(promise, ms) {
  const started = Date.now();
  let timer;
  const bound = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  const result = await Promise.race([promise.then(value => ({ value }), error => ({ error, code: error?.code ?? null })), bound]);
  clearTimeout(timer);
  return { ...result, elapsedMs: Date.now() - started };
}
async function until(condition, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await condition(); if (value) return value; await sleep(25); }
  throw new Error('not observed: ' + what);
}

// ── (v) the protocol relay ──
const SSL_REQUEST = 80877103, GSS_REQUEST = 80877104;
function commandWord(type, body) {
  let text = null;
  if (type === 'Q') text = body.toString('utf8', 0, body.length - 1);
  if (type === 'P') { const name = body.indexOf(0); text = body.toString('utf8', name + 1, body.indexOf(0, name + 1)); }
  return text === null ? null : (text.trim().split(/\s+/)[0] || '').replace(/;$/, '').toUpperCase();
}
class Relay {
  constructor(host, port) {
    Object.assign(this, { host, port, conns: [], events: [], blocked: [], blocking: false, arm: null, nextId: 0 });
    this.server = net.createServer(client => this.accept(client));
  }
  listen() { return new Promise(resolve => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port))); }
  close() { for (const c of this.conns) { c.client.destroy(); c.upstream?.destroy(); } return new Promise(r => this.server.close(r)); }
  note(conn, what, extra = {}) { this.events.push({ at: Date.now(), conn: conn.id, what, ...extra }); }
  accept(client) {
    const conn = { id: ++this.nextId, client, upstream: null, started: false, cin: Buffer.alloc(0), sin: Buffer.alloc(0),
      pendingCommit: false, holding: null, cut: false, rollbackPass: false, early: [] };
    this.conns.push(conn);
    client.on('error', () => {});
    client.on('close', () => { if (!conn.cut) conn.upstream?.end(); });
    client.on('data', data => this.fromClient(conn, data));
    if (this.blocking) { this.blocked.push({ at: Date.now(), conn: conn.id, message: 'connect' }); this.note(conn, 'blocked-connect'); }
    else this.connect(conn);
  }
  connect(conn) {
    conn.upstream = net.connect(this.port, this.host);
    conn.upstream.on('error', () => conn.client.destroy());
    conn.upstream.on('close', () => { if (!conn.cut) conn.client.destroy(); });
    conn.upstream.on('data', data => this.fromServer(conn, data));
    for (const chunk of conn.early.splice(0)) conn.upstream.write(chunk);
  }
  send(conn, bytes) { if (conn.upstream) conn.upstream.write(bytes); else conn.early.push(bytes); }
  fromClient(conn, data) {
    conn.cin = Buffer.concat([conn.cin, data]);
    for (;;) {
      if (!conn.started) {
        if (conn.cin.length < 8) return;
        const length = conn.cin.readInt32BE(0);
        if (conn.cin.length < length) return;
        const code = conn.cin.readInt32BE(4), bytes = conn.cin.subarray(0, length);
        conn.cin = conn.cin.subarray(length);
        if (code === SSL_REQUEST || code === GSS_REQUEST) { conn.client.write('N'); continue; }
        conn.started = true; this.send(conn, bytes); continue;
      }
      if (conn.cin.length < 5) return;
      const total = 1 + conn.cin.readInt32BE(1);
      if (conn.cin.length < total) return;
      const bytes = conn.cin.subarray(0, total), type = String.fromCharCode(bytes[0]);
      conn.cin = conn.cin.subarray(total);
      const word = commandWord(type, bytes.subarray(5));
      // The ROLLBACK an engine sends after a failed COMMIT, on that same connection: its messages up to Sync pass.
      if (word === 'ROLLBACK' && conn.allowRollback) conn.rollbackPass = true;
      const passes = conn.rollbackPass;
      if (passes && (type === 'S' || type === 'Q')) conn.rollbackPass = false;
      if (this.blocking && !passes) {
        conn.blockedOut = conn.blockedOut || [];
        conn.blockedOut.push(bytes);
        this.blocked.push({ at: Date.now(), conn: conn.id, message: type, word });
        this.note(conn, 'blocked', { type, word });
        continue;
      }
      if (word === 'COMMIT') { conn.pendingCommit = true; this.note(conn, 'commit-sent'); }
      if (word) this.note(conn, 'command', { word });
      this.send(conn, bytes);
    }
  }
  fromServer(conn, data) {
    if (conn.cut) return;                                  // the client side is gone; the backend goes on
    if (conn.holding) { conn.holding.bytes.push(data); return; }
    conn.sin = Buffer.concat([conn.sin, data]);
    let offset = 0;
    while (conn.sin.length - offset >= 5) {
      const total = 1 + conn.sin.readInt32BE(offset + 1);
      if (conn.sin.length - offset < total) break;
      const type = String.fromCharCode(conn.sin[offset]);
      if (conn.pendingCommit && (type === 'C' || type === 'E')) {
        conn.pendingCommit = false;
        this.note(conn, 'commit-answer', { type });
        if (this.arm) {
          conn.client.write(conn.sin.subarray(0, offset));
          conn.holding = { type, bytes: [conn.sin.subarray(offset)] };
          conn.sin = Buffer.alloc(0);
          const arm = this.arm; this.arm = null;
          arm({ conn, type });
          return;
        }
      }
      offset += total;
    }
    conn.client.write(conn.sin.subarray(0, offset));
    conn.sin = conn.sin.subarray(offset);
  }
  /** Resolves when the next COMMIT answer arrives; that answer and everything after it on its connection is held. */
  holdNextCommit() { return new Promise(resolve => { this.arm = resolve; }); }
  release(conn) {
    const held = conn.holding; conn.holding = null;
    this.note(conn, 'released', { type: held.type });
    if (!conn.cut) for (const bytes of held.bytes) this.fromServer(conn, bytes);
  }
  /** Close the product's side only; the backend keeps its transaction (and its COMMIT) going. */
  cut(conn) { conn.cut = true; conn.holding = null; this.note(conn, 'cut'); conn.client.destroy(); }
  /** From now on hold every message - new connections and open ones - except that `allowRollbackOn` may still roll back. */
  block(allowRollbackOn) {
    this.blocking = true;
    for (const c of this.conns) c.allowRollback = c === allowRollbackOn;
    this.note({ id: 0 }, 'block-armed');
  }
  /** End the partition as a network does: what it held was lost, so each connection that had a message (or its
   * connection attempt) held is reset; nothing held reaches PostgreSQL late. */
  unblock() {
    this.blocking = false;
    this.note({ id: 0 }, 'unblocked');
    for (const c of this.conns) {
      if (!c.upstream || (c.blockedOut || []).length) { c.blockedOut = []; c.client.destroy(); c.upstream?.destroy(); }
    }
  }
}

// ── fixture ──
const known = value => ({ status: 'known', value });
function event(surface = 'POST studies/:uid/report/commit') {
  return { formatVersion: 1, surface, eventId: randomUUID(),
    userId: known({ id: randomUUID(), issuer: 'synthetic-issuer', subject: 'doctor-b2c' }), rolesAtTime: known(['radiologist']),
    actingInstitution: known('synthetic-hospital'), managingInstitution: known('synthetic-hospital'),
    occurredAt: new Date().toISOString(), trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }),
    cause: 'user-view', context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
    executor: 'member', targets: [{ kind: 'report-version',
      patientLinkSnapshot: known({ linkId: 'synthetic-link', patientId: 'synthetic-patient', assigningAuthority: 'synthetic-hospital' }),
      studyId: known('synthetic-study'), recordId: known('synthetic-report'), versionId: known('v1') }],
    action: 'write', result: 'succeeded', requestId: randomUUID(), auditLinkId: 'audit:' + randomUUID(), relatedEventId: null };
}
const reference = id => ({ kind: 'synthetic-fixture', id, version: 'v1' });

async function prepare(witness) {
  const run = sql => witness.$executeRawUnsafe(sql);
  await run('CREATE TABLE public.b2c_effect(id text PRIMARY KEY)');
  await run('GRANT SELECT, INSERT ON public.b2c_effect TO kin_runtime');
  await run('CREATE SEQUENCE public.b2c_stage');
  await run('CREATE SEQUENCE public.b2c_xid');
  // K10's settlement trigger keeps its own pair, so the business and the settlement XIDs are both kept to compare.
  await run('CREATE SEQUENCE public.b2c_settle_stage');
  await run('CREATE SEQUENCE public.b2c_settle_xid');
  // The triggers keep an XID in a bigint sequence, exact below 2^63; the server log prints the same xid8 as text.
  const [now] = await witness.$queryRawUnsafe('SELECT pg_current_xact_id()::text AS xid');
  assert.ok(BigInt(now.xid) < 2n ** 62n, 'the synthetic database\'s XIDs fit the sequences the triggers write');
  // fail:<SQLSTATE>:<key> raises at COMMIT; probe:<key> only records; hold[:<SQLSTATE>]:<key> first waits for the
  // witness's advisory lock 4242 (with no lock wait bound of its own), then raises if given a SQLSTATE.
  await run(`CREATE FUNCTION public.b2c_at_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE kind text := split_part(NEW.id, ':', 1); code text := split_part(NEW.id, ':', 2);
    BEGIN
      PERFORM setval('public.b2c_stage', CASE WHEN upper(btrim(current_query(), E' \\n;')) = 'COMMIT' THEN 2 ELSE 3 END);
      PERFORM setval('public.b2c_xid', pg_current_xact_id()::text::bigint);
      RAISE LOG 'syn-commit xid8=% kind=%', pg_current_xact_id(), kind;
      IF kind = 'hold' THEN
        PERFORM set_config('lock_timeout', '0', true);
        PERFORM pg_advisory_xact_lock(4242);
      END IF;
      IF kind IN ('fail', 'hold') AND code ~ '^[0-9A-Z]{5}$' THEN
        IF code = 'P0001' THEN RAISE EXCEPTION 'SYN deferred refusal'; END IF;
        RAISE EXCEPTION USING ERRCODE = code, MESSAGE = 'SYN deferred ' || code;
      END IF;
      RETURN NULL;
    END $$`);
  await run(`CREATE CONSTRAINT TRIGGER b2c_at_commit AFTER INSERT ON public.b2c_effect
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.b2c_at_commit()`);
  const [trigger] = await witness.$queryRawUnsafe(`SELECT tgdeferrable AS deferrable, tginitdeferred AS "initiallyDeferred"
    FROM pg_trigger WHERE tgname = 'b2c_at_commit'`);
  assert.deepEqual(trigger, { deferrable: true, initiallyDeferred: true }, '(iii) the trigger is deferred');
}
async function resetStage(witness) {
  await witness.$queryRawUnsafe(`SELECT setval('public.b2c_stage', 1)::text AS s, setval('public.b2c_xid', 1)::text AS x,
    setval('public.b2c_settle_stage', 1)::text AS ss, setval('public.b2c_settle_xid', 1)::text AS sx`);
}
/** (i)+(ii): where a trigger fired, the XID it fired in and PostgreSQL's status of that XID now. Each observation is
 * printed, so the Python side binds every XID seen at COMMIT to the server log's own line for that XID (iv). */
async function observed(witness, which = 'business') {
  const prefix = which === 'settlement' ? 'b2c_settle' : 'b2c';
  const [row] = await witness.$queryRawUnsafe(`SELECT (SELECT last_value FROM public.${prefix}_stage)::int AS stage,
    (SELECT last_value FROM public.${prefix}_xid)::text AS xid`);
  const [status] = await witness.$queryRawUnsafe('SELECT pg_xact_status($1::xid8)::text AS status', row.xid);
  const seen = { stage: { 1: 'not fired', 2: 'COMMIT', 3: 'statement' }[row.stage], xid: row.xid, status: status.status };
  console.log(JSON.stringify({ observed: which, ...seen }));
  return seen;
}
const effects = async (witness, id) => (await witness.$queryRawUnsafe('SELECT count(*)::int AS n FROM public.b2c_effect WHERE id = $1', id))[0].n;
const operation = async (witness, id) =>
  (await witness.$queryRawUnsafe('SELECT emr_access.operation_result($1::uuid) AS value', id))[0].value;
const failures = async (witness, eventId) => (await witness.$queryRawUnsafe(
  'SELECT cause FROM emr_access.failure_entry WHERE event_id = $1 ORDER BY recorded_at', eventId)).map(r => r.cause);
const insert = (tx, id) => tx.$executeRaw`INSERT INTO public.b2c_effect VALUES (${id})`;
const LEDGER = ['AppendNotCommitted', 'CommitUnknown'];

async function main() {
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const target = new URL(process.env.DATABASE_URL);
  const relay = new Relay(target.hostname, Number(target.port || 5432));
  const relayed = new URL(target); relayed.hostname = '127.0.0.1'; relayed.port = String(await relay.listen());
  const db = new EmrLedgerClient(relayed.toString());
  // The product's composition (application.ts): the failure journal on the ledger's own client, so K6's partition stops
  // the journal's database writes as it stops the judgement read; what the journal kept is then read from its spool.
  const spool = path.join(process.env.KIN_B2R_SPOOL, 'product');
  const store = new AccessLedgerStore(db, new FailureJournal(db, new FailureSpool(spool)));
  const spooled = () => { try { return fs.readFileSync(path.join(spool, 'failure-spool.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const results = {}, problems = [];
  // Each case runs on its own: a failure is recorded with its stack and the next case still runs.
  const check = async (name, work) => {
    try { await work(); results[name] = 'PASS'; }
    catch (error) { results[name] = 'FAIL'; problems.push(name); console.error('CASE FAILED', name, error); }
  };
  try {
    await witness.$connect(); await db.$connect();
    await prepare(witness);

    // K13 the runtime role may read its own XID and the commit log; nothing was granted for it.
    await check('K13-privilege', async () => {
      const [privilege] = await witness.$queryRawUnsafe(`SELECT
        has_function_privilege('kin_runtime', 'pg_current_xact_id()', 'EXECUTE') AS token,
        has_function_privilege('kin_runtime', 'pg_xact_status(xid8)', 'EXECUTE') AS status`);
      log('K13-privilege', privilege);
      assert.deepEqual(privilege, { token: true, status: true });
    });

    // K1 normal: a write and its record commit and answer; a read-only transaction answers once judged too.
    await check('K1', async () => {
      await resetStage(witness);
      const k1 = event();
      const value = await store.transactionWithRecords(async (tx, record) => record(k1, async () => { await insert(tx, 'probe:k1'); return reference('k1'); }));
      const k1seen = await observed(witness);
      log('K1', { seen: k1seen, value });
      assert.deepEqual([k1seen.stage, k1seen.status], ['COMMIT', 'committed']);
      assert.deepEqual(value, reference('k1'));
      assert.equal(await effects(witness, 'probe:k1'), 1);
      const [{ n: k1entries }] = await witness.$queryRawUnsafe('SELECT count(*)::int AS n FROM emr_access.access_entry WHERE event_id = $1', k1.eventId);
      assert.equal(k1entries, 2);
      const readOnly = await store.transactionWithRecords(async tx => (await tx.$queryRaw`SELECT 1::int AS one`)[0].one);
      assert.equal(readOnly, 1);
    });

    // K2/K3 a deferred 23514 or P0001 fails the COMMIT: AppendNotCommitted, no row, no entry, the operation negative.
    await check('K2/K3', async () => {
      for (const code of ['23514', 'P0001']) {
        await resetStage(witness);
        const ev = event(), key = `fail:${code}:k2`;
        const out = await settled(store.transactionWithRecords(async (tx, record) => record(ev, async () => { await insert(tx, key); return reference(key); })), 60000);
        const seen = await observed(witness);
        const [op] = await witness.$queryRawUnsafe('SELECT operation_id::text AS id FROM emr_access.operation WHERE event_id = $1', ev.eventId);
        log('K2/K3', { code, seen, answer: out.code ?? 'value', elapsedMs: out.elapsedMs });
        assert.deepEqual([seen.stage, seen.status], ['COMMIT', 'aborted'], code);
        assert.equal(out.code, 'AppendNotCommitted', code);
        assert.equal(await effects(witness, key), 0);
        const [{ n }] = await witness.$queryRawUnsafe('SELECT count(*)::int AS n FROM emr_access.access_entry WHERE event_id = $1', ev.eventId);
        assert.equal(n, 0, 'no access entry');
        assert.equal((await operation(witness, op.id)).outcome, 'negative');
        assert.deepEqual(await failures(witness, ev.eventId), ['business-rollback']);
      }
    });

    // K4a a refusal inside the callback keeps its meaning; the trigger never fired at COMMIT.
    await check('K4a/K4b', async () => {
      await insert(db, 'probe:k4a');
      await resetStage(witness);
      const k4a = await settled(store.transactionWithRecords(async tx => { await insert(tx, 'probe:k4a'); return 'never'; }), 30000);
      const k4aSeen = await observed(witness);
      log('K4a', { seen: k4aSeen, code: k4a.code, meta: k4a.error?.meta ?? null });
      assert.equal(k4aSeen.stage, 'not fired');
      assert.ok(k4a.error && !LEDGER.includes(k4a.code), 'the callback\'s own unique violation, not a commit judgement');
      // K4b a deferred 23503 at COMMIT carries a known code: still judged, not taken for the callback's error.
      await resetStage(witness);
      const k4b = await settled(store.transactionWithRecords(async tx => { await insert(tx, 'fail:23503:k4b'); return 'never'; }), 30000);
      const k4bSeen = await observed(witness);
      log('K4b', { seen: k4bSeen, code: k4b.code });
      assert.deepEqual([k4bSeen.stage, k4bSeen.status], ['COMMIT', 'aborted']);
      assert.equal(k4b.code, 'AppendNotCommitted');
    });

    // K8 (a) facts with no operation, journaled against their event; (b) effect-null only; (c) mixed operations.
    await check('K8', async () => {
      // Each input's own COMMIT is seen failing (its XID aborted, the trigger fired at COMMIT) before its answer counts.
      const owed = randomUUID();
      await resetStage(witness);
      const k8a = await settled(store.transactionWithRecords(async tx => { await insert(tx, 'fail:23514:k8a'); return 'fact'; }, undefined, owed), 30000);
      const k8aSeen = await observed(witness);
      log('K8a', { seen: k8aSeen, code: k8a.code, journal: await failures(witness, owed) });
      assert.deepEqual([k8aSeen.stage, k8aSeen.status], ['COMMIT', 'aborted'], 'K8a');
      assert.equal(k8a.code, 'AppendNotCommitted');
      assert.equal(await effects(witness, 'fail:23514:k8a'), 0);
      assert.deepEqual(await failures(witness, owed), ['business-rollback']);
      await resetStage(witness);
      const noop = event();
      const k8b = await settled(store.transactionWithRecords(async (tx, record) => { await record(noop, async () => null);
        await insert(tx, 'fail:23514:k8b'); return 'noop'; }), 30000);
      const k8bSeen = await observed(witness);
      const [k8bOp] = await witness.$queryRawUnsafe('SELECT operation_id::text AS id FROM emr_access.operation WHERE event_id = $1', noop.eventId);
      log('K8b', { seen: k8bSeen, code: k8b.code });
      assert.deepEqual([k8bSeen.stage, k8bSeen.status], ['COMMIT', 'aborted'], 'K8b');
      assert.equal(k8b.code, 'AppendNotCommitted');
      assert.notEqual((await operation(witness, k8bOp.id)).outcome, 'committed', 'the silent no-op is not a success');
      await resetStage(witness);
      const mixed = [event(), event()];
      const k8c = await settled(store.transactionWithRecords(async (tx, record) => { await record(mixed[0], async () => null);
        await record(mixed[1], async () => { await insert(tx, 'fail:23514:k8c'); return reference('k8c'); }); return 'mixed'; }), 30000);
      const k8cSeen = await observed(witness);
      log('K8c', { seen: k8cSeen, code: k8c.code });
      assert.deepEqual([k8cSeen.stage, k8cSeen.status], ['COMMIT', 'aborted'], 'K8c');
      assert.equal(k8c.code, 'AppendNotCommitted');
      assert.equal(await effects(witness, 'fail:23514:k8c'), 0);
      for (const ev of mixed) {
        const [op] = await witness.$queryRawUnsafe('SELECT operation_id::text AS id FROM emr_access.operation WHERE event_id = $1', ev.eventId);
        assert.notEqual((await operation(witness, op.id)).outcome, 'committed', 'no operation of the mixed transaction committed');
      }
    });

    // K9 a committed operation replayed inside a transaction whose own change fails at COMMIT.
    await check('K9', async () => {
      const k9event = event();
      const k9op = await store.admit(k9event, undefined, { operationId: randomUUID(), attemptId: randomUUID() });
      const original = await store.transaction(k9op, async tx => { await insert(tx, 'probe:k9'); return reference('k9'); });
      await resetStage(witness);
      const k9 = await settled(store.transactionWithRecords(async (tx, record) => {
        const previous = await record(k9event, async () => { throw new Error('a committed operation reran its effect'); });
        await insert(tx, 'fail:23514:k9'); return previous; }), 30000);
      const k9seen = await observed(witness);
      log('K9', { seen: k9seen, code: k9.code });
      assert.deepEqual([k9seen.stage, k9seen.status], ['COMMIT', 'aborted']);
      assert.equal(k9.code, 'AppendNotCommitted');
      assert.deepEqual((await operation(witness, k9op.operationId)).result, original.result, 'the original result stays');
    });

    // K10 the settlement's own COMMIT fails: no negative is announced, the operation stays pending until recovery.
    await check('K10', async () => {
      await witness.$executeRawUnsafe(`CREATE FUNCTION public.b2c_fail_negative() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN
          PERFORM setval('public.b2c_settle_stage', CASE WHEN upper(btrim(current_query(), E' \\n;')) = 'COMMIT' THEN 2 ELSE 3 END);
          PERFORM setval('public.b2c_settle_xid', pg_current_xact_id()::text::bigint);
          RAISE LOG 'syn-settle xid8=%', pg_current_xact_id();
          RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SYN deferred settlement refusal';
        END $$`);
      await witness.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER b2c_fail_negative AFTER INSERT ON emr_access.attempt_outcome
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.outcome = 'negative') EXECUTE FUNCTION public.b2c_fail_negative()`);
      const k10event = event();
      let k10;
      try {
        await resetStage(witness);
        k10 = await settled(store.transactionWithRecords(async (tx, record) => record(k10event, async () => {
          await insert(tx, 'fail:23514:k10'); return reference('k10'); })), 60000);
        const business = await observed(witness), settlement = await observed(witness, 'settlement');
        const [op] = await witness.$queryRawUnsafe('SELECT operation_id::text AS id, pending FROM emr_access.operation WHERE event_id = $1', k10event.eventId);
        log('K10', { business, settlement, code: k10.code, pending: op.pending });
        assert.deepEqual([business.stage, business.status], ['COMMIT', 'aborted'], 'the business transaction failed at its COMMIT');
        assert.deepEqual([settlement.stage, settlement.status], ['COMMIT', 'aborted'], 'the settlement failed at its own COMMIT');
        assert.notEqual(business.xid, settlement.xid, 'two transactions, two XIDs');
        assert.equal(k10.code, 'AppendNotCommitted', 'the business transaction aborted');
        assert.equal((await operation(witness, op.id)).outcome, 'pending', 'no unconfirmed negative is the result');
        await assert.rejects(store.recoverPending(), error => error.code === 'CommitUnknown');
        await witness.$executeRawUnsafe('DROP TRIGGER b2c_fail_negative ON emr_access.attempt_outcome');
        await store.recoverPending();
        assert.equal((await operation(witness, op.id)).outcome, 'negative', 'recovery settles it once');
      } finally { await witness.$executeRawUnsafe('DROP TRIGGER IF EXISTS b2c_fail_negative ON emr_access.attempt_outcome'); }
    });

    // K5 the COMMIT answer is lost after PostgreSQL committed: observed committed while the answer is held, then cut.
    await check('K5', async () => {
      {
        await resetStage(witness);
        const op = await store.admit(event(), undefined, { operationId: randomUUID(), attemptId: randomUUID() });
        let callbacks = 0;
        const held = relay.holdNextCommit();
        const answer = store.transaction(op, async tx => { callbacks++; await insert(tx, 'probe:k5'); return reference('k5'); });
        const hold = await held;
        const seen = await observed(witness);
        log('K5-held', { seen, answerType: hold.type });
        assert.deepEqual([hold.type, seen.stage, seen.status], ['C', 'COMMIT', 'committed'], 'committed before the answer was lost');
        relay.cut(hold.conn);
        const out = await settled(answer, 60000);
        log('K5', { answer: out.value?.outcome ?? out.code, elapsedMs: out.elapsedMs, callbacks });
        assert.equal(out.value?.outcome, 'committed', 'the committed result is answered');
        const again = await store.transaction(op, async () => { throw new Error('replay executed the callback'); });
        assert.deepEqual(again.result, out.value.result);
        assert.equal(callbacks, 1);
      }
    });

    // K6 the judgement cannot be read: the transaction really committed, or really aborted.
    await check('K6', async () => {
      for (const [label, key, actual] of [['committed', 'probe:k6c', 'committed'], ['aborted', 'fail:23514:k6a', 'aborted']]) {
        await resetStage(witness);
        const op = await store.admit(event(), undefined, { operationId: randomUUID(), attemptId: randomUUID() });
        let callbacks = 0, next = key;
        const effect = async tx => { callbacks++; await insert(tx, next); return reference(next); };
        const held = relay.holdNextCommit();                         // (1) hold the COMMIT answer
        const answer = store.transaction(op, effect);
        const hold = await held;
        const seen = await observed(witness);                         // (2) the real outcome, while the answer is held
        log('K6-held', { label, seen, answerType: hold.type });
        assert.deepEqual([seen.stage, seen.status], ['COMMIT', actual], label);
        const before = relay.blocked.length;
        relay.block(hold.conn);                                       // (3) block every later message but its ROLLBACK
        relay.release(hold.conn);                                     // (4) deliver the held answer
        let out;
        try {
          await until(() => relay.blocked.length > before, 'the product\'s next transaction message blocked');  // (5)
          out = await settled(answer, 120000);
        } finally { relay.unblock(); }
        const blocked = relay.blocked.slice(before, before + 6);
        log('K6', { label, blocked, answer: out.timedOut ? 'TIMED OUT' : out.value?.outcome ?? out.code, elapsedMs: out.elapsedMs });
        assert.ok(blocked.length > 0, 'the judgement read was actually blocked');
        assert.equal(out.timedOut, undefined, 'the answer came within its bound');
        assert.equal(out.code, 'CommitUnknown', label + ': neither a success nor a failure it could not see');
        // The journal's database write was cut off with the rest; the failure is kept in the spool, not dropped.
        const kept = spooled().filter(r => r.operationId === op.operationId);
        log('K6-journal', { label, kept: kept.map(r => r.cause) });
        assert.deepEqual(kept.map(r => r.cause), ['commit-unknown'], label + ': the failure record was kept');
        next = 'probe:k6-retry-' + label;
        const again = await settled(store.transaction(op, effect), 60000);
        log('K6-converged', { label, outcome: again.value?.outcome ?? again.code, callbacks });
        assert.equal(again.value?.outcome, 'committed', label);
        assert.equal(callbacks, actual === 'committed' ? 1 : 2, label + ': replayed once, or applied once');
        assert.equal(await effects(witness, 'probe:k6-retry-committed'), 0);
      }
    });

    // K7 the COMMIT is still in progress when the client side is cut: unknown; each way it then ends, it converges.
    await check('K7', async () => {
      for (const [label, key, final] of [['commits', 'hold:k7c', 'committed'], ['raises', 'hold:23514:k7r', 'aborted']]) {
        await resetStage(witness);
        let release;
        const released = new Promise(resolve => { release = resolve; });
        let locked;
        const lockedNow = new Promise(resolve => { locked = resolve; });
        const holder = witness.$transaction(async tx => {
          await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(4242)'); locked(); await released;
        }, { timeout: 60000, maxWait: 10000 });
        await lockedNow;
        const ev = event();
        const answer = settled(store.transactionWithRecords(async (tx, record) => record(ev, async () => {
          await insert(tx, key); return reference(key); })), 60000);
        const waiting = await until(async () => (await witness.$queryRawUnsafe(`SELECT pid, pg_blocking_pids(pid) AS blockers
          FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`))[0], 'COMMIT waiting in its trigger');
        const seen = await observed(witness);
        log('K7-waiting', { label, seen, waiting: { blockers: waiting.blockers.length } });
        assert.deepEqual([seen.stage, seen.status], ['COMMIT', 'in progress'], label);
        const committing = relay.conns.find(c => c.pendingCommit && !c.cut);
        assert.ok(committing, 'the relay holds the connection whose COMMIT is pending');
        relay.cut(committing);
        // The judgement reads the status first; its settlement then waits for the committing transaction's operation lock.
        await until(async () => (await witness.$queryRawUnsafe(`SELECT 1 FROM pg_stat_activity
          WHERE $1::int = ANY(pg_blocking_pids(pid))`, waiting.pid)).length, 'the settlement waiting behind the COMMIT', 20000)
          .catch(() => null);
        release(); await holder;
        const out = await answer;
        const after = await observed(witness);
        log('K7', { label, answer: out.value ?? out.code, elapsedMs: out.elapsedMs, finalStatus: after.status });
        assert.equal(out.code, 'CommitUnknown', label + ': a COMMIT in progress is unknown');
        assert.equal(after.status, final, label);
        await store.recoverPending();
        const [op] = await witness.$queryRawUnsafe('SELECT operation_id::text AS id FROM emr_access.operation WHERE event_id = $1', ev.eventId);
        assert.equal((await operation(witness, op.id)).outcome, final === 'committed' ? 'committed' : 'negative', label + ' converged');
      }
    });

    // K13 a saturated pool: twice its size of judged transactions at once all answer; the judgement takes no lane.
    await check('K13-pool', async () => {
      const many = Array.from({ length: 2 * db.emrAppendPoolSize }, (_, i) =>
        store.transactionWithRecords(async (tx, record) => record(event(), async () => { await insert(tx, 'probe:pool-' + i); return reference('pool-' + i); })));
      const pool = await settled(Promise.all(many), 120000);
      log('K13-pool', { size: many.length, elapsedMs: pool.elapsedMs, ok: !!pool.value });
      assert.ok(pool.value, 'no pool exhaustion');
    });

    log('relay-events', { events: relay.events.length, blocked: relay.blocked.length });
    console.log(JSON.stringify({ status: problems.length ? 'FAIL' : 'PASS', boundary: 'B2 commit judgement on PostgreSQL', results }));
    if (problems.length) process.exitCode = 1;
  } finally {
    await db.$disconnect().catch(() => {});
    await witness.$disconnect().catch(() => {});
    await relay.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
