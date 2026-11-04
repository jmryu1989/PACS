'use strict';
/* B2-COMMIT: AccessLedgerStore answers from the commit of the transaction it ran, never from the promise.
 * B2-COMMIT plan section 2-3 (one row per case below) and section 5 K4a/K4b, K8-K10, K13 in their pure form; the same
 * boundaries on PostgreSQL are the commit-judgement case of tests/emr/b/pg_ledger_api_test.cjs.
 *
 * Every case reads its outcome from the double's durable state, its journal and the answer: whether the callback's value
 * was returned, which LedgerFailure was thrown, what became durable, and what the judgement asked. No product SQL text is
 * an expectation (AGENTS 1-B 14); the double models the database (tests/emr/b/pg_tx_double.cjs).
 */
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../../..'), ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: f }).outputText, f);
const { AccessLedgerStore } = require(path.join(root, 'api/src/emr-runtime/store.ts'));
const { PgTxDouble } = require('./pg_tx_double.cjs');

const known = value => ({ status: 'known', value });
function event() {
  return { formatVersion: 1, surface: 'POST studies/:uid/report/commit', eventId: randomUUID(),
    userId: known({ id: randomUUID(), issuer: 'synthetic-issuer', subject: 'doctor-a' }), rolesAtTime: known(['radiologist']),
    actingInstitution: known('synthetic-hospital'), managingInstitution: known('synthetic-hospital'),
    occurredAt: new Date().toISOString(), trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }),
    cause: 'user-view', context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
    executor: 'member', targets: [{ kind: 'report-version',
      patientLinkSnapshot: known({ linkId: 'synthetic-link', patientId: 'synthetic-patient', assigningAuthority: 'synthetic-hospital' }),
      studyId: known('synthetic-study'), recordId: known('synthetic-report'), versionId: known('v1') }],
    action: 'write', result: 'succeeded', requestId: randomUUID(), auditLinkId: 'audit:' + randomUUID(), relatedEventId: null };
}
function world(poolSize) {
  const db = new PgTxDouble(), journal = [];
  const store = new AccessLedgerStore(db, { record: async (...entry) => { journal.push(entry); return 'database'; } }, poolSize);
  return { db, journal, store };
}
async function answer(promise) {
  try { return { value: await promise }; } catch (error) { return { error, code: error?.code ?? null }; }
}
const reference = { kind: 'synthetic-fixture', id: 'effect', version: 'v1' };
/** A producer write: one business row and its record, as an ordinary transactionWithRecords caller writes them. */
const write = (key = 'effect') => async (tx, record) => {
  const recorded = await record(event(), async () => {
    await tx.$executeRaw`INSERT INTO syn_effect VALUES (${key}, ${1})`;
    return reference;
  });
  return { recorded };
};

// ── 2-3 row 2: callback returned, token held, committed ──
test('J01 a committed transaction answers its callback value, after one status read of its own XID in a new transaction', async () => {
  const w = world();
  const out = await answer(w.store.transactionWithRecords(write()));
  assert.deepEqual(out.value, { recorded: reference });
  assert.equal(w.db.effects.get('effect'), 1);
  assert.equal(w.db.judged.length, 1, 'the commit was judged');
  const business = w.db.log.find(e => e.kind === 'commit' && e.xid !== null);
  assert.equal(w.db.judged[0].token, business.xid, 'the judgement asks about the business transaction itself');
  assert.notEqual(w.db.judged[0].tx, business.tx, 'from a transaction of its own');
  assert.ok(w.db.log.indexOf(business) < w.db.log.indexOf(w.db.judged[0]), 'after that transaction settled');
  assert.deepEqual(w.journal, []);
});

test('J02 a read-only or no-op callback is judged as well: a status that cannot be read is unknown, never its value', async () => {
  for (const work of [async () => 'read-only', async (_tx, record) => record(event(), async () => null)]) {
    const w = world();
    assert.equal((await answer(w.store.transactionWithRecords(work))).value === undefined, false);
    assert.equal(w.db.judged.length, 1, 'a transaction that wrote nothing still has its commit judged');
    const blind = world();
    blind.db.statusReads.push('throw');
    assert.equal((await answer(blind.store.transactionWithRecords(work))).code, 'CommitUnknown');
  }
});

// ── 2-3 row 3: not committed ──
test('J03 a COMMIT that failed but answered as success is AppendNotCommitted: nothing durable, its operation settled negative', async () => {
  const w = world();
  w.db.plan('silent-abort');
  const out = await answer(w.store.transactionWithRecords(write()));
  assert.equal(out.code, 'AppendNotCommitted');
  assert.equal(out.value, undefined, 'the callback value of a rolled back transaction is never answered');
  assert.equal(w.db.effects.size, 0);
  const [op] = w.db.ops.values();
  assert.equal(op.outcome, 'negative');
  assert.deepEqual(w.journal.map(([cause]) => cause), ['business-rollback']);
});

test('J04 K4b a COMMIT refused with a known Prisma code is judged, not taken for the callback\'s own error', async () => {
  const w = world();
  w.db.plan({ mode: 'abort', error: Object.assign(new Error('SYN deferred FK at COMMIT'), { code: 'P2003' }) });
  assert.equal((await answer(w.store.transactionWithRecords(write()))).code, 'AppendNotCommitted');
  assert.equal(w.db.effects.size, 0);
});

// ── 2-3 row 1: the callback threw, or no transaction was opened ──
test('J05 K4a the callback\'s own refusal keeps its meaning and is never judged', async () => {
  for (const refusal of [Object.assign(new Error('SYN unique'), { code: 'P2002' }), Object.assign(new Error('SYN forbidden'), { status: 403 })]) {
    const w = world();
    const out = await answer(w.store.transactionWithRecords(async (tx, record) => {
      await record(event(), async () => { await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'x'}, ${1})`; return reference; });
      throw refusal;
    }));
    assert.equal(out.error, refusal);
    const rolledBack = w.db.log.find(e => e.kind === 'rollback');
    assert.ok(w.db.judged.every(j => j.token !== rolledBack.xid), 'the refused transaction is not judged');
    assert.deepEqual(w.journal.map(([cause]) => cause), ['business-rollback']);
  }
  const event0 = randomUUID();
  for (const [name, $transaction, cause] of [
    ['no connection', async () => { throw Object.assign(new Error('Timed out fetching a new connection'), { code: 'P2024' }); }, 'ledger-unreachable'],
  ]) {
    const journal = [], store = new AccessLedgerStore({ $transaction }, { record: async (...e) => { journal.push(e); } });
    const out = await answer(store.transactionWithRecords(async () => 0, undefined, event0));
    assert.equal(out.code, 'P2024', name);
    assert.deepEqual(journal, [[cause, event0, null]], name);
  }
});

// ── 2-3 rows 2 and 4: an answer lost after COMMIT, and a COMMIT still in progress ──
test('J06 K5 an answer lost after a committed COMMIT returns the callback value once, with no journal', async () => {
  const w = world();
  let calls = 0;
  w.db.plan('lost');
  const out = await answer(w.store.transactionWithRecords(async tx => { calls++; await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'lost'}, ${1})`; return 'stored'; }));
  assert.equal(out.value, 'stored');
  assert.equal(calls, 1);
  assert.deepEqual(w.journal, []);
});

test('J07 K7 a COMMIT still in progress is unknown and is never settled into a negative; once settled it converges', async () => {
  const w = world();
  w.db.plan('in-progress');
  const out = await answer(w.store.transactionWithRecords(write()));
  assert.equal(out.code, 'CommitUnknown');
  assert.equal(w.db.judged.length, 1);
  const [op] = w.db.ops.values();
  assert.equal(op.outcome, 'pending', 'the operation is left to recovery, not answered negative');
  assert.deepEqual(w.journal.map(([cause]) => cause), ['commit-unknown']);
  w.db.pending.settle('committed');
  await w.store.recoverPending();
  assert.equal(w.db.operation(op.operationId).outcome, 'committed');
});

// ── 2-3 rows 4 and 5: unknown ──
test('J08 K13 a status that is NULL, unreadable or unanswerable, and a token that cannot be taken, are all unknown', async () => {
  for (const [name, arrange] of [['null', db => db.statusReads.push('null')], ['throw', db => db.statusReads.push('throw')],
    ['token', db => { db.tokenFails = 1; }]]) {
    const w = world();
    arrange(w.db);
    const out = await answer(w.store.transactionWithRecords(write()));
    assert.equal(out.code, 'CommitUnknown', name);
    assert.deepEqual(w.journal.map(([cause]) => cause), ['commit-unknown'], name);
  }
});

test('J09 K13 a full XID beyond 2^53 reaches the status read as the same decimal string', async () => {
  const w = world();
  w.db.nextXid = 18446744073709551615n;
  assert.deepEqual((await answer(w.store.transactionWithRecords(write()))).value, { recorded: reference });
  assert.equal(typeof w.db.judged[0].token, 'string');
  assert.equal(w.db.judged[0].token, '18446744073709551615');
});

test('J10 the token is taken after the callback, so a callback opening with its isolation level keeps that order', async () => {
  const w = world();
  const out = await answer(w.store.transactionWithRecords(async tx => {
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    return 'isolated';
  }));
  assert.equal(out.value, 'isolated');
  assert.equal(w.db.judged.length, 1);
});

test('J11 the judgement waits on no append lane: a lane freed by the business transaction admits the next one meanwhile', async () => {
  const w = world(3); // one append lane
  let entered, second;
  const admitted = new Promise(resolve => { entered = resolve; });
  w.db.statusReads.push(async () => {
    second = w.store.transactionWithRecords(async () => { entered(); return 'second'; });
    await Promise.race([admitted, new Promise((_, reject) => setTimeout(() => reject(new Error('the judgement held the lane')), 2000))]);
  });
  assert.equal((await answer(w.store.transactionWithRecords(async () => 'first'))).value, 'first');
  assert.equal(await second, 'second');
});

// ── record-count and replay boundaries (K8, K9) ──
test('J12 K8 a fact write with no operation, an effect-null transaction and mixed operations: silent rollback is never success', async () => {
  const failure = randomUUID();
  let w = world();
  w.db.plan('silent-abort');
  let out = await answer(w.store.transactionWithRecords(async tx => { await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'fact'}, ${1})`; return 'fact'; },
    undefined, failure));
  assert.equal(out.code, 'AppendNotCommitted');
  assert.deepEqual(w.journal, [['business-rollback', failure, null]], 'the owed facts are journaled against their event');

  w = world();
  w.db.plan('silent-abort');
  out = await answer(w.store.transactionWithRecords(async (_tx, record) => record(event(), async () => null)));
  assert.equal(out.code, 'AppendNotCommitted');

  w = world();
  w.db.plan('silent-abort');
  out = await answer(w.store.transactionWithRecords(async (tx, record) => {
    await record(event(), async () => null);
    await record(event(), async () => { await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'mixed'}, ${1})`; return reference; });
    return 'mixed';
  }));
  assert.equal(out.code, 'AppendNotCommitted');
  assert.equal(w.db.effects.size, 0);
  assert.ok([...w.db.ops.values()].every(op => op.outcome === 'negative'));
});

test('J13 K9 a transaction replaying a committed operation does not succeed with its own change when it did not commit', async () => {
  const w = world();
  const keys = { operationId: randomUUID(), attemptId: randomUUID() }, ev = event();
  const op = await w.store.admit(ev, undefined, keys);
  const first = await w.store.transaction(op, async tx => { await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'original'}, ${1})`; return reference; });
  assert.equal(first.outcome, 'committed');
  // The same event replayed inside a new transaction with a new change of its own.
  w.db.plan('silent-abort');
  const out = await answer(w.store.transactionWithRecords(async (tx, record) => {
    const previous = await record(ev, async () => { throw new Error('a committed operation never reruns its effect'); });
    await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'new'}, ${1})`;
    return previous;
  }));
  assert.equal(out.code, 'AppendNotCommitted');
  assert.equal(w.db.effects.has('new'), false);
  // A single-operation transaction whose own COMMIT failed recovers only the stored original result.
  w.db.plan('silent-abort');
  const replay = await w.store.transaction(op, async () => { throw new Error('replay executed business callback'); });
  assert.deepEqual(replay.result, first.result);
});

// ── transaction(), append(), settle(), identity ──
test('J14 transaction() and append(): a silent rollback answers AppendNotCommitted and no receipt is minted', async () => {
  let w = world();
  const op = await w.store.admit(event());
  w.db.plan('silent-abort');
  assert.equal((await answer(w.store.transaction(op, async tx => { await tx.$executeRaw`INSERT INTO syn_effect VALUES (${'t'}, ${1})`; return reference; }))).code,
    'AppendNotCommitted');
  assert.equal(w.db.operation(op.operationId).outcome, 'negative');
  w = world();
  w.db.plan('silent-abort');
  assert.equal((await answer(w.store.append(event()))).code, 'AppendNotCommitted');
  w = world();
  w.db.plan('in-progress');
  assert.equal((await answer(w.store.append(event()))).code, 'CommitUnknown');
  // A committed attempt whose status could not be read: the operation's stored result, which only that attempt can
  // have written, is recovered through a settlement judged committed - never assumed from the promise.
  w = world();
  w.db.statusReads.push('throw');
  const receipt = await w.store.append(event());
  assert.equal(typeof receipt.durableAt, 'string');
  assert.equal(w.db.judged.length, 2, 'the attempt and its settlement were both judged');
});

test('J15 K10 settle answers only what its own committed transaction wrote; an unconfirmed negative stays pending', async () => {
  const w = world();
  w.db.plan('silent-abort', 'silent-abort');
  const out = await answer(w.store.transactionWithRecords(write()));
  assert.equal(out.code, 'AppendNotCommitted', 'the business transaction aborted');
  const [op] = w.db.ops.values();
  assert.equal(op.outcome, 'pending', 'the negative of a settlement that did not commit is not the result');
  w.db.plan('silent-abort');
  assert.equal(await w.store.settle(op.operationId), null);
  w.db.plan('silent-abort');
  assert.equal((await answer(w.store.recoverPending())).code, 'CommitUnknown');
  assert.equal(w.db.operation(op.operationId).outcome, 'pending');
  await w.store.recoverPending();
  assert.equal(w.db.operation(op.operationId).outcome, 'negative', 'recovery settles it once its own commit is confirmed');
});

test('J16 an identity is cached only once its transaction committed', async () => {
  const w = world();
  w.db.plan('silent-abort');
  assert.equal((await answer(w.store.resolveRequestIdentity('synthetic-issuer', 'subject'))).code, 'AppendNotCommitted');
  assert.equal(w.db.identities.size, 0);
  const id = await w.store.resolveRequestIdentity('synthetic-issuer', 'subject');
  assert.equal(w.db.identities.get(JSON.stringify(['synthetic-issuer', 'subject'])), id);
  const judged = w.db.judged.length;
  assert.equal(await w.store.resolveRequestIdentity('synthetic-issuer', 'subject'), id);
  assert.equal(w.db.judged.length, judged, 'a cached identity takes no transaction');
});
