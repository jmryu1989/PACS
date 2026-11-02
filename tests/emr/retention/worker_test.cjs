/* CD-09a / REQ-EMR-17, REQ-EMR-19 -> RISK-H-06 -> TEST-CD09-P01..P06, P09 (pure; no database).
 * The worker's order and refusals over A's real destruction contract with in-memory ports, the native-report source
 * adapter over synthetic signed rows, and the ledger sweep's receipt checks. The PostgreSQL adapter, its deletion
 * function and the fence triggers are exercised against a real database in tests/e2e/test_cd09_retention_worker.py.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const src = name => require(path.join(root, 'api/src', name + '.ts'));
const { composeEmrAdapters } = src('emr-contract/composition');
const { runtimeAdapters } = src('emr-runtime/context');
const D = src('emr-contract/lawful-defaults');
const { reportRetentionRecord, withStoredHolds } = src('emr-retention/report-source');
const { runRetentionWorker, sweepLedgerExpiry } = src('emr-retention/worker');
const { signedReports } = require('./signed_report.cjs');
composeEmrAdapters(runtimeAdapters);

const NOW = '2026-11-03T03:00:00.000Z';
const unitId = () => 'disposal:' + crypto.randomUUID();
function report(uid, versions, signedAt = '2015-03-02T01:00:00.000Z') {
  const spec = { kid: 'kid-' + uid, doctorId: 'doctor-1', institutionId: 'hospital-a', registeredAt: '2014-01-01T00:00:00.000Z',
    reports: [{ uid, versions: versions.map((action, i) => ({ version: i + 1, action, reason: action === 'reset' ? 'synthetic reason' : null,
      signedAt: new Date(Date.parse(signedAt) + i * 3_600_000).toISOString() })) }] };
  const { approvals } = signedReports(name => src(name), spec);
  const rows = versions.map((action, i) => ({ id: i + 1, uid, version: i + 1, action, findings: 'F' + i, conclusion: 'C' + i,
    recommendation: '', reason: action === 'reset' ? 'synthetic reason' : null, citations: null, structured: null }));
  return { uid, rows, signed: approvals.map(a => ({ recordId: a.recordId, versionId: a.versionId, outcome: a.outcome })) };
}
function built(uid, versions, signedAt) {
  const r = report(uid, versions, signedAt), result = reportRetentionRecord(uid, r.rows, r.signed, unitId());
  assert.equal(result.status, 'built', result.reason);
  return result.record;
}
const ledgerReceipt = () => ({ ran: true, checkedAt: NOW, deletedEntries: 0, deletedFailures: 0, retainedByDutyOrHold: 0,
  historyRetainedUnknownLifetime: 0, complete: true });

/** In-memory H ports over A's real batch contract. `fail` names a recordId whose set the storage refuses. */
function world({ units = [], uncovered = [], drafts = { live: 0, cleared: 0, inconsistent: 0 }, openPhases = [], fail = null,
  receipt = null, completedFails = false, reconcile = { resumed: 0, abandoned: 0, unfinished: 0, failures: [] }, graphChange = null } = {}) {
  const log = [], journal = []; let execution = null, clock = NOW;
  const graphFor = async (ids, at) => ({ records: units.filter(u => ids.includes(u.recordId)).map(u => u.record), references: [],
    complete: true, revision: 'r1', checkedAt: at });
  const ports = {
    sweepLedger: async () => { log.push('ledger'); return ledgerReceipt(); },
    clock: async () => { log.push('clock'); return NOW; },
    reconcile: async () => { log.push('reconcile'); return reconcile; },
    inventory: async at => { log.push('inventory'); return { units, uncovered, drafts }; },
    graphFor,
    store: {
      withRetentionBatchLock: async (ids, at, work) => { log.push('lock:' + ids.join(',')); const g = await graphFor(ids, at); return withStoredHolds(new Map(ids.map(id => [id, []])), () => work(graphChange ? graphChange(g) : g)); },
      now: () => { clock = new Date(Date.parse(clock) + 1000).toISOString(); return clock; },
      beginSet: async ids => { execution = { operationId: crypto.randomUUID(), ids: [...ids] }; log.push('begin:' + ids.length); return { operationId: execution.operationId }; },
      append: async e => { journal.push(e); return { durableAt: e.occurredAt }; },
      appendCompletedSet: async events => { if (completedFails) throw new Error('journal down'); journal.push(...events); return { durableAt: events[0].occurredAt }; },
    },
    destroySet: async requests => {
      const ids = requests.map(r => r.record.recordId); log.push('destroy:' + ids.join(','));
      if (ids.includes(fail)) throw new Error('storage refused');
      return receipt ? receipt(execution) : { formatVersion: 2, kind: 'operational-deletion', method: 'operational-store-deletion',
        operationId: execution.operationId, disposalUnitIds: execution.ids, completedAt: requests[0].requestedAt };
    },
    openPhases,
  };
  return { ports, log, journal };
}
const due = record => ({ recordId: record.recordId, disposalUnitId: record.disposalUnitId, status: 'due', reason: null, record });

test('CD09-P06 report source: every signed version is a part from its own signature; anything else is unsupported, never shortened', () => {
  const r = report('1.2.3.1', ['approve', 'addendum', 'reset', 'approve']);
  const ok = reportRetentionRecord(r.uid, r.rows, r.signed, unitId());
  assert.equal(ok.status, 'built');
  assert.deepEqual(ok.record.parts.map(p => p.partId), ['1', '2', '3', '4']);
  assert.deepEqual(ok.record.parts.map(p => p.startedAt), r.signed.map(s => s.outcome.signedAt));
  // 5 years from the latest signed part (D-19), counted by A, not by H.
  assert.equal(D.retentionDeadline(ok.record), D.civilPeriodEnd(r.signed[3].outcome.signedAt, 5));
  const cases = {
    'report-version-unsigned': [r.rows, r.signed.slice(0, 3)],
    'signature-without-version': [r.rows.slice(0, 3), r.signed],
    'report-signature-unverifiable': [r.rows, r.signed.map((s, i) => i !== 1 ? s : { ...s, outcome: { ...s.outcome,
      envelope: { ...s.outcome.envelope, signature: Buffer.alloc(64).toString('base64url') } } })],
    'report-signature-binding': [r.rows, r.signed.map((s, i) => i !== 2 ? s : { ...s, outcome: { ...s.outcome, versionSha256: 'a'.repeat(64) } })],
    'report-without-version': [[], []],
  };
  for (const [reason, [rows, signed]] of Object.entries(cases))
    assert.deepEqual(reportRetentionRecord(r.uid, rows, signed, unitId()), { status: 'unsupported', reason }, reason);
  // Another study's signature never completes this one's history.
  const other = report('1.2.3.2', ['approve']);
  assert.equal(reportRetentionRecord(r.uid, r.rows.slice(0, 1), other.signed, unitId()).status, 'unsupported');
});

test('CD09-P01 every due unit is its own set in A order; each set is started durably before its one deletion call', async () => {
  const a = built('1.2.9.1', ['approve']), b = built('1.2.9.2', ['approve', 'addendum']);
  const { ports, log, journal } = world({ units: [due(b), due(a)] });
  const run = await runRetentionWorker(ports);
  assert.equal(run.status, 'complete');
  assert.equal(run.statutory.destroyed, 2);
  assert.deepEqual(log.filter(x => !x.startsWith('lock')), ['ledger', 'reconcile', 'clock', 'inventory', 'begin:1', 'destroy:1.2.9.1', 'begin:1', 'destroy:1.2.9.2']);
  assert.deepEqual(journal.map(e => [e.disposalUnitId, e.phase]), [[a.disposalUnitId, 'started'], [a.disposalUnitId, 'completed'],
    [b.disposalUnitId, 'started'], [b.disposalUnitId, 'completed']]);
  assert.equal(journal.find(e => e.disposalUnitId === b.disposalUnitId).partCount, 2);
  assert.notEqual(journal[0].operationId, journal[2].operationId);
  assert(!JSON.stringify(run).includes('1.2.9.'), 'the run result names no study or record');
});

test('CD09-P01 a snapshot that changed under the lock starts nothing and is a failed run', async () => {
  const a = built('1.2.8.1', ['approve']);
  const { ports, log, journal } = world({ units: [due(a)], graphChange: g => ({ ...g, revision: 'concurrent' }) });
  const run = await runRetentionWorker(ports);
  assert.equal(run.status, 'failed'); assert.equal(run.failure, 'ReferenceSnapshotStale');
  assert.equal(journal.length, 0); assert(!log.some(x => x.startsWith('begin') || x.startsWith('destroy')));
});

test('CD09-P02 a failed set records failed at its actual time and the next set is never begun', async () => {
  const a = built('1.2.7.1', ['approve']), b = built('1.2.7.2', ['approve']);
  const { ports, log, journal } = world({ units: [due(a), due(b)], fail: '1.2.7.1' });
  const run = await runRetentionWorker(ports);
  assert.equal(run.status, 'failed'); assert.equal(run.statutory.destroyed, 0);
  assert.deepEqual(journal.map(e => e.phase), ['started', 'failed']);
  assert(journal[1].occurredAt > journal[0].occurredAt, 'failure time is the store clock, not the request time');
  assert.equal(log.filter(x => x.startsWith('begin')).length, 1);
  // A lost completion write also stops the batch; the deleted set is reconciled by the next run, not re-deleted.
  const second = world({ units: [due(built('1.2.7.3', ['approve'])), due(built('1.2.7.4', ['approve']))], completedFails: true });
  const again = await runRetentionWorker(second.ports);
  assert.equal(again.status, 'failed'); assert.equal(again.failure, 'DestructionJournalUnavailable');
  assert.equal(second.log.filter(x => x.startsWith('destroy')).length, 1);
});

test('CD09-P03 only a format-2 operational receipt of exactly this execution completes a set', async () => {
  for (const receipt of [() => ({ completedAt: NOW, method: 'irreversible-permanent-deletion' }),
    e => ({ formatVersion: 2, kind: 'operational-deletion', method: 'operational-store-deletion', operationId: crypto.randomUUID(), disposalUnitIds: e.ids, completedAt: NOW }),
    e => ({ formatVersion: 2, kind: 'operational-deletion', method: 'operational-store-deletion', operationId: e.operationId, disposalUnitIds: [unitId()], completedAt: NOW }),
    e => ({ formatVersion: 2, kind: 'backup-generation-expired', method: 'operational-store-deletion', operationId: e.operationId, disposalUnitIds: e.ids, completedAt: NOW })]) {
    const { ports, journal } = world({ units: [due(built('1.2.6.' + crypto.randomInt(1e6), ['approve']))], receipt });
    const run = await runRetentionWorker(ports);
    assert.equal(run.failure, 'DestructionReceiptInvalid');
    assert.deepEqual(journal.map(e => e.phase), ['started', 'failed']);
  }
});

test('CD09-P04 the five-day boundary is counted from the eligible instant in Seoul days; a missing reason is recorded, never a stop', async () => {
  const record = built('1.2.5.1', ['approve'], '2015-03-02T01:00:00.000Z');
  const eligible = D.retentionDeadline(record); // 00:00 KST after the last day
  assert.equal(eligible, '2020-03-01T15:00:00.000Z');
  const dueBoundary = '2020-03-06T15:00:00.000Z'; // five civil days counting the first
  const store = (clock) => ({ withRetentionLock: async (id, at, work) => withStoredHolds(new Map([[id, []]]), () => work({ records: [record], references: [], complete: true, revision: 'r', checkedAt: at })),
    now: () => clock, beginSet: async ids => { store.op = { operationId: crypto.randomUUID(), ids }; return { operationId: store.op.operationId }; },
    append: async e => ({ durableAt: e.occurredAt }), appendCompletedSet: async events => ({ durableAt: events[0].occurredAt }) });
  const destroyAt = (requestedAt, completedAt, justifiedDelay = null) => D.destroyAtExpiry(store(completedAt), { record, versionIds: ['1'], requestedAt,
    justifiedDelay, graph: { records: [record], references: [], complete: true, revision: 'r', checkedAt: requestedAt } },
    async () => ({ formatVersion: 2, kind: 'operational-deletion', method: 'operational-store-deletion', operationId: store.op.operationId, disposalUnitIds: store.op.ids, completedAt }));
  const inTime = await destroyAt(eligible, '2020-03-06T14:59:59.999Z');
  assert.equal(inTime.timeliness, 'within-five-days'); assert.equal(inTime.delayReasonStatus, 'not-required'); assert.equal(inTime.dueDay, '2020-03-06');
  // Requested in time, completed at the boundary: the completion is late.
  const late = await destroyAt('2020-03-06T14:00:00.000Z', dueBoundary);
  assert.equal(late.timeliness, 'overdue'); assert.equal(late.delayReasonStatus, 'missing'); assert.equal(late.justifiedDelay, null);
  const reason = { reason: 'storage maintenance window', recordedAt: '2020-03-06T00:00:00.000Z' };
  const explained = await destroyAt(dueBoundary, dueBoundary, reason);
  assert.equal(explained.timeliness, 'overdue', 'a recorded reason never turns overdue into timely');
  assert.equal(explained.delayReasonStatus, 'recorded'); assert.deepEqual(explained.justifiedDelay, reason);
  await assert.rejects(destroyAt('2020-03-01T14:59:59.999Z', eligible), { code: 'RetentionNotElapsed' });
});

test('CD09-P05 retained, held and unsupported units are never handed to a destruction call', async () => {
  const kept = built('1.2.4.1', ['approve'], '2025-01-01T00:00:00.000Z');
  const units = [
    { recordId: '1.2.4.1', disposalUnitId: kept.disposalUnitId, status: 'retained', reason: null, record: null },
    { recordId: '1.2.4.2', disposalUnitId: unitId(), status: 'held', reason: 'legal-hold', record: null },
    { recordId: '1.2.4.3', disposalUnitId: unitId(), status: 'held', reason: 'open-duty-request', record: null },
    { recordId: '1.2.4.4', disposalUnitId: unitId(), status: 'unsupported', reason: 'report-version-unsigned', record: null },
    { recordId: '1.2.4.5', disposalUnitId: unitId(), status: 'unsupported', reason: 'report-version-unsigned', record: null },
  ];
  const { ports, log, journal } = world({ units });
  const run = await runRetentionWorker(ports);
  assert.equal(run.status, 'incomplete');
  assert.deepEqual(run.statutory, { due: 0, destroyed: 0, retained: 1, held: 2, unsupported: { 'report-version-unsigned': 2 }, overdue: 0, delayReasonMissing: 0 });
  assert.equal(journal.length, 0); assert(!log.some(x => x.startsWith('lock') || x.startsWith('destroy')));
  const onlyKept = world({ units: units.slice(0, 3) });
  assert.equal((await runRetentionWorker(onlyKept.ports)).status, 'complete', 'retained and held are lawful outcomes, not gaps');
});

test('CD09-P06 an unreadable store fails the run; unread tables, inconsistent drafts and open phases keep it incomplete', async () => {
  const broken = world();
  broken.ports.inventory = async () => { throw new Error('report rows unreadable'); };
  await assert.rejects(runRetentionWorker(broken.ports), /report rows unreadable/);
  for (const [options, expected] of [[{ uncovered: ['public."Finding"'] }, 'uncovered'], [{ drafts: { live: 1, cleared: 0, inconsistent: 1 } }, 'purpose'],
    [{ openPhases: ['image-destruction'] }, 'open']]) {
    const { ports } = world(options);
    const run = await runRetentionWorker(ports);
    assert.equal(run.status, 'incomplete', expected);
  }
  const clean = world({ drafts: { live: 3, cleared: 2, inconsistent: 0 } });
  const run = await runRetentionWorker(clean.ports);
  assert.equal(run.status, 'complete'); assert.deepEqual(run.purpose, { live: 3, cleared: 2, inconsistent: 0 });
});

test('CD09-P02 an unfinished interrupted set stops the run before any new judgement', async () => {
  const { ports, log } = world({ units: [due(built('1.2.3.9', ['approve']))],
    reconcile: { resumed: 0, abandoned: 0, unfinished: 1, failures: ['OperationalRowRemains'] } });
  const run = await runRetentionWorker(ports);
  assert.equal(run.status, 'failed'); assert.equal(run.failure, 'OperationalRowRemains');
  assert.deepEqual(log, ['ledger', 'reconcile']);
});

test('CD09-P09 reconciliation rebuilds completion or failure from the started record without changing the fact', () => {
  const started = { formatVersion: 2, kind: 'operational-deletion', revision: 1, operationId: crypto.randomUUID(), phase: 'started',
    occurredAt: '2020-03-02T00:00:00.000Z', day: '2020-03-02', disposalUnitId: unitId(), classes: ['imageReport'],
    clauseIds: ['medical-rules:15.1.6'], partCount: 2, expiryDay: '2020-03-01', extensionUsed: false, dueDay: '2020-03-06',
    timeliness: 'within-five-days', method: 'operational-store-deletion', justifiedDelay: null, delayReasonStatus: 'not-required',
    basis: 'privacy-act-21-and-decree-16-1-1' };
  const done = D.completedFromStarted(started, '2020-03-06T14:59:59.999Z');
  assert.deepEqual({ ...done, phase: 'started', occurredAt: started.occurredAt, day: started.day }, started);
  assert.equal(done.phase, 'completed'); assert.equal(done.timeliness, 'within-five-days');
  // A confirmation found only after the boundary stays late; nothing back-dates the deletion.
  const lateDone = D.completedFromStarted(started, '2020-03-06T15:00:00.000Z');
  assert.equal(lateDone.timeliness, 'overdue'); assert.equal(lateDone.delayReasonStatus, 'missing'); assert.equal(lateDone.day, '2020-03-07');
  assert.equal(D.failedFromStarted(started, '2020-03-03T00:00:00.000Z').phase, 'failed');
  for (const bad of [{ ...started, phase: 'completed' }, { ...started, formatVersion: 1 }, { ...started, method: 'irreversible-permanent-deletion' },
    { ...started, extra: 1 }])
    assert.throws(() => D.completedFromStarted(bad, '2020-03-04T00:00:00.000Z'), { code: 'StartedDestructionRequired' });
  assert.throws(() => D.completedFromStarted(started, '2020-03-01T00:00:00.000Z'), { code: 'StartedDestructionRequired' });
  // The privacy officer confirms operational completions only.
  assert.throws(() => D.confirmDestruction('batch-1', [{ ...done, kind: 'backup-generation-expired' }], 'officer', '2020-03-07T00:00:00.000Z'));
  assert.equal(D.confirmDestruction('batch-1', [done], 'officer', '2020-03-07T00:00:00.000Z').disposalUnitIds[0], started.disposalUnitId);
});

function database(result, role = 'kin_emr_retention') {
  const calls = [];
  return { calls, async $queryRaw(query, ...values) { calls.push({ query: query.join('?'), values }); return calls.length === 1 ? [{ role }] : result; } };
}
test('ledger sweep: runtime and installer credentials never reach an expiry call', async () => {
  for (const role of ['kin_runtime', 'kin', 'kin_emr_reader']) {
    const db = database([{ result: ledgerReceipt() }], role);
    await assert.rejects(sweepLedgerExpiry(db), /RetentionCredentialRequired/);
    assert.equal(db.calls.length, 1);
  }
  assert.deepEqual(await sweepLedgerExpiry(database([{ result: ledgerReceipt() }])), ledgerReceipt());
});
test('ledger sweep: a failed query is a failure and absent, partial or invalid receipts never become success', async () => {
  const failure = new Error('synthetic DB unavailable'); let reads = 0;
  await assert.rejects(sweepLedgerExpiry({ async $queryRaw() { if (++reads === 1) return [{ role: 'kin_emr_retention' }]; throw failure; } }), e => e === failure);
  for (const rows of [[], [{ result: null }], [{ result: { ...ledgerReceipt(), complete: false } }], [{ result: { ...ledgerReceipt(), checkedAt: 'invalid' } }],
    [{ result: { ...ledgerReceipt(), deletedEntries: -1 } }], [{ result: { ...ledgerReceipt(), historyRetainedUnknownLifetime: null } }]])
    await assert.rejects(sweepLedgerExpiry(database(rows)), /RetentionSweepReceiptInvalid/);
});
