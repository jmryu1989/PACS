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
test('POOL-03 saturated appends retain two existing settlement connections and drain FIFO', async () => {
  const { admitAppend } = require(path.join(root,'api/src/emr-runtime/admission.ts'));
  const client={},entered=[],release=[];
  const jobs=[0,1,2].map(i=>admitAppend(client,3,async()=>{
    entered.push(i);await new Promise(resolve=>release[i]=resolve);return i;
  }));
  const observe=()=>new Promise(resolve=>setImmediate(resolve));
  try {
    await observe();assert.deepEqual(entered,[0],'the three-connection pool retains its two settlement connections');
    release[0]();await observe();assert.deepEqual(entered,[0,1]);
    release[1]();await observe();assert.deepEqual(entered,[0,1,2]);
  } finally { for(let i=0;i<3;i++){release[i]?.();await observe();} }
  assert.deepEqual(await Promise.all(jobs),[0,1,2]);
});
