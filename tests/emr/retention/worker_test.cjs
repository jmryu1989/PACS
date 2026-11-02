/* CD-09 / REQ-EMR-17 -> RISK-H-06 -> TEST-CD09-LEDGER.
 * The query boundary is exercised without a DB. Actual SQL expiry/hold behavior
 * is in test_cd09_retention_worker.py; this does not prove clinical erasure.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { sweepLedgerExpiry, runRetentionWorker } = require(path.join(root, 'api/src/emr-retention/worker.ts'));
const receipt = () => ({ ran: true, checkedAt: '2026-11-02T00:00:00.000Z', deletedEntries: 2,
  deletedFailures: 1, retainedByDutyOrHold: 3, historyRetainedUnknownLifetime: 4, complete: true });
function database(result, role = 'kin_emr_retention') {
  const calls = [];
  return { calls, async $queryRaw(query, ...values) {
    calls.push({ query: query.join('?'), values });
    return calls.length === 1 ? [{ role }] : result;
  } };
}
test('ledger receipt preserves held and unknown-history counts; full worker remains incomplete', async () => {
  const db = database([{ result: receipt() }]);
  const result = await runRetentionWorker(db);
  assert.deepEqual(result.ledger, receipt());
  assert.equal(result.status, 'incomplete');
  assert.ok(result.open.includes('statutory-destruction'));
  assert.equal(db.calls.length, 2);
});
test('runtime and installer credentials never reach an expiry call', async () => {
  for (const role of ['kin_runtime', 'kin', 'kin_emr_reader']) {
    const db = database([{ result: receipt() }], role);
    await assert.rejects(sweepLedgerExpiry(db), /RetentionCredentialRequired/);
    assert.equal(db.calls.length, 1);
  }
});
test('query failure remains a failure rather than an empty sweep', async () => {
  const failure = new Error('synthetic DB unavailable');
  let reads = 0;
  await assert.rejects(runRetentionWorker({ async $queryRaw() {
    if (++reads === 1) return [{ role: 'kin_emr_retention' }];
    throw failure;
  } }), error => error === failure);
});
test('absent, partial and invalid receipts never become success', async () => {
  for (const rows of [[], [{ result: null }], [{ result: { ...receipt(), complete: false } }],
    [{ result: { ...receipt(), checkedAt: 'invalid' } }],
    [{ result: { ...receipt(), deletedEntries: -1 } }],
    [{ result: { ...receipt(), historyRetainedUnknownLifetime: null } }]]) {
    await assert.rejects(sweepLedgerExpiry(database(rows)), /RetentionSweepReceiptInvalid/);
  }
});
test('retry makes a fresh SQL call and retains the new counters', async () => {
  const first = database([{ result: receipt() }]);
  await sweepLedgerExpiry(first);
  const next = { ...receipt(), deletedEntries: 0, deletedFailures: 0 };
  assert.deepEqual(await sweepLedgerExpiry(database([{ result: next }])), next);
});
