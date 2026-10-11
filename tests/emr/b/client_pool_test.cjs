/* REQ-D941 -> RISK-EMR-POOL-STARVATION/API-SCOPE -> dedicated-client boundary.
 * Observe Prisma constructor options with an inert client; no database access.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path'), fs = require('node:fs'), Module = require('node:module');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'api/node_modules/typescript'));
const original = Module._load;
const options = [];
class Client { constructor(value) { options.push(value); } }
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true }, fileName: filename }).outputText, filename);
Module._load = function (name, ...args) {
  if (name === '@prisma/client') return { PrismaClient: Client };
  return original.call(this, name, ...args);
};
const { EmrLedgerClient } = require(path.join(root, 'api/src/emr-runtime/client.ts'));
const { PrismaService } = require(path.join(root, 'api/src/prisma.service.ts'));
const limits = require(path.join(root, 'api/src/emr-runtime/limits.ts'));
Module._load = original;

test('POOL-01 EMR capacity derives from four append lanes plus reserved verification connections', () => {
  const client = new EmrLedgerClient('postgresql://synthetic.invalid/db');
  const size = limits.EMR_APPEND_LANES + limits.EMR_VERIFY_RESERVE;
  assert.equal(client.emrAppendPoolSize, size);
  assert.equal(new URL(options.at(-1).datasources.db.url).searchParams.get('connection_limit'), String(size));
  assert.equal(new EmrLedgerClient('postgresql://synthetic.invalid/db?connection_limit=4').emrAppendPoolSize, 4);
});
test('POOL-02 ordinary API Prisma constructor keeps its native pool and accepts small configured pools', () => {
  const before = process.env.DATABASE_URL;
  try {
    for (const url of ['postgresql://synthetic.invalid/db', 'postgresql://synthetic.invalid/db?connection_limit=2']) {
      process.env.DATABASE_URL = url;
      new PrismaService();
      assert.equal(options.at(-1), undefined, 'no API-wide datasource override');
    }
    assert.throws(() => new EmrLedgerClient('postgresql://synthetic.invalid/db?connection_limit=2'), /EmrAppendPoolTooSmall/);
  } finally { if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before; }
});
test('PLAN-01 the guard rejects either JIT or excess cost independently', () => {
  const { planVerdict, VERIFICATION_PLAN_COST_LIMIT } = require('./verification_plan.cjs');
  assert.equal(planVerdict([{ Plan: { 'Total Cost': 35 } }]).jit, false);
  assert.throws(() => planVerdict([{ Plan: { 'Total Cost': 35 }, JIT: { Functions: 17 } }]), /JIT/);
  assert.throws(() => planVerdict([{ Plan: { 'Total Cost': VERIFICATION_PLAN_COST_LIMIT + 1 } }]), /cost/);
});
test('PLAN-02 every catalog read needs local jit=off, including an added read', () => {
  const { assertFunctionSettings } = require('./verification_plan.cjs');
  assertFunctionSettings([{ signature: 'emr_access.read(text)', proconfig: ['search_path=pg_catalog', 'jit=off'] }]);
  for (const proconfig of [null, ['jit=on'], ['search_path=pg_catalog']]) {
    assert.throws(() => assertFunctionSettings([{ signature: 'emr_access.new_read()', proconfig }]), /nested JIT/);
  }
  assert.throws(() => assertFunctionSettings([]), /must exist/);
});
test('PLAN-03 prototype coverage fails closed when a read is added', () => {
  const { assertPrototypeCoverage } = require('./verification_plan.cjs');
  class Reads { first() {} second() {} }
  assert.throws(() => assertPrototypeCoverage(Reads, new Set(['first']), { constructor: 'construction' }), /uncovered SQL method/);
  assertPrototypeCoverage(Reads, new Set(['first', 'second']), { constructor: 'construction' });
});
test('TIMING-01 repeated warm blocks add exactly one head probe per request', async () => {
  const { instrument } = require('./throughput.cjs');
  let probes = 0, appends = 0;
  const tx = { $queryRaw: async () => { probes++; return [{ wait_ms: 0 }]; } };
  const prisma = { $transaction: async work => work(tx) };
  const store = {
    appendRow: async () => { appends++; return { durable: true }; },
    appendInTransaction: async function (t) { return this.appendRow(t, 'viewing'); },
    withAppendTransaction: work => prisma.$transaction(work),
    append: function () { return this.withAppendTransaction(t => this.appendInTransaction(t)); },
  };
  for (let block = 0; block < 3; block++) {
    const probe = instrument(prisma, store, {}, { headProbe: true });
    try { assert((await probe.run({ eventId: 'synthetic-' + block })).receipt); }
    finally { probe.restore(); }
  }
  assert.equal(appends, 3, 'instrumentation preserves the number of product appends');
  assert.equal(probes, 3, 'old wrappers cannot accumulate extra SQL in later blocks');
});
