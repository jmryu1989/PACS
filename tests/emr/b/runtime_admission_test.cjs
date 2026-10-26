const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { verifyRuntimeConnection, EMR_STORAGE } = require(path.resolve(process.env.KIN_API_DIST || '/app/dist', 'emr-runtime/manifest'));
function database(change = {}) {
  const observations = [
    { name: 'site_application', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
      rolbypassrls: false, memberships: 2, owned: 4, owned_schemas: 1 },
    { present: true },
    { direct_write: false, append: true, expire: false, clauses: false, create_ledger: false,
      create_public: false, audit_insert: true, audit_rewrite: false, ...change.privileges },
    { fsync: 'on', full_page_writes: 'on', synchronous_commit: 'on', ...change.durability },
    EMR_STORAGE.tables.map(relation => ({ relation, relkind: 'r', tablespace: 'site_storage' })),
  ];
  return { async $queryRaw() { const value = observations.shift(); return Array.isArray(value) ? value : [value]; } };
}
test('site role name, unrelated ownership, memberships and storage names do not reject an append-only connection', async () => {
  const result = await verifyRuntimeConnection(database());
  assert.equal(result.role, 'site_application');
  assert.equal(result.relations, EMR_STORAGE.tables.length);
});
test('access-record rewrite permission and non-durable commits still refuse production admission', async () => {
  for (const change of [{ privileges: { audit_rewrite: true } }, { privileges: { audit_insert: false } },
    { privileges: { direct_write: true } }, { privileges: { append: false } },
    { durability: { fsync: 'off' } }, { durability: { synchronous_commit: 'off' } }])
    await assert.rejects(verifyRuntimeConnection(database(change)), /EmrRuntimeRefused/);
});
