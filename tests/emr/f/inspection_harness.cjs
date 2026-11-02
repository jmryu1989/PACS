/* Synthetic ports for the real F inspection service/controller, shared by node and browser tests. */
const fs = require('node:fs'), path = require('node:path');
const API = path.resolve(__dirname, '../../../api');
const ts = require(path.join(API, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(API, 'tsconfig.json'), ts.sys.readFile);
const compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, API).options;
require(path.join(API, 'node_modules/reflect-metadata'));
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions, fileName: filename }).outputText, filename);
const { EmrAuditService } = require(path.join(API, 'src/emr-audit/service.ts'));
const { EmrAuditController } = require(path.join(API, 'src/emr-audit/audit.controller.ts'));
const F = require(path.join(API, 'src/emr-audit/contract.ts'));
const known = value => ({ status: 'known', value });
const actor = { id: 'synthetic-auditor', issuer: 'synthetic', subject: 'auditor' };
function fixture(scopes = ['inspection'], institution = 'SYN-SITE', storage = [], requestActor = actor) {
  const records = [], reads = [];
  const events = ['download', 'copy', 'provide-prepared'].map((action, i) => ({ eventId: `SYN-${i}`, action,
    occurredAt: '2026-09-30T15:00:00.000Z', userId: known(requestActor), result: 'succeeded', targets: [] }));
  const tx = {
    institution: { findUnique: async () => ({ createdAt: new Date('2026-08-31T15:00:00Z') }) },
    auditLog: {
      findMany: async ({ where }) => storage.filter(r => r.target === where.target && r.action === where.action).map(r => ({ ...r })),
      findFirst: async ({ where, orderBy }) => {
        const rows = storage.filter(r => r.target === where.target && r.action === where.action);
        return (orderBy.id === 'asc' ? rows[0] : rows.at(-1)) || null;
      },
      create: async ({ data }) => { const row = { ...data, id: storage.length + 1 }; storage.push(row); return row; },
    },
    $queryRaw: async (parts, ...values) => {
      const sql = parts.join('?');
      if (sql.includes('pg_advisory')) return [];
      if (sql.includes('roster_event')) return scopes.length ? [{ body: { grantId: 'SYN-GRANT', subject: requestActor, institutionId: institution,
        events: [{ kind: 'granted', eventId: 'SYN-GRANT-EVENT', at: '2026-01-01T00:00:00.000Z', by: actor,
          capacity: 'privacy-officer', basisDocumentId: 'SYN-BASIS', scopes, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null }] } }] : [];
      if (sql.includes('investigation_entries')) {
        reads.push(values);
        const below = values[5], take = values[6];
        return events.map((e, i) => ({ sequence: BigInt(events.length - i), payload: JSON.stringify(e),
          recorded_at: new Date(e.occurredAt), snapshot_top: BigInt(events.length) }))
          .filter(r => below === null || r.sequence < below).slice(0, take);
      }
      throw Error('Unexpected synthetic SQL: ' + sql);
    },
  };
  const ctx = { facts: { actor: requestActor, institution, roles: ['radiologist'], ingress: known({ address: '127.0.0.1', source: 'trusted-proxy' }),
    requestId: 'SYN-REQUEST', surface: 'POST emr-audit/inspections/:month/report' }, requireCurrent: async () => {}, assertActive: () => {},
    work: { transactionWithRecords: async fn => fn(tx, async (event, effect) => { records.push(event); return effect(); }) } };
  return { controller: new EmrAuditController(new EmrAuditService({}, { withWork: async (_req, fn) => fn(ctx) })), storage, reads, records, events, tx };
}

module.exports = { fixture, actor, F, EmrAuditController };
if (require.main === module) {
  const readline = require('node:readline');
  let f = fixture();
  const filterType = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', async line => {
    try {
      const q = JSON.parse(line);
      if (q.reset) { f = fixture(q.scopes); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      const body = await f.controller[q.method]({}, ...(q.month ? [q.month] : []), ...(q.body ? [q.body] : []));
      process.stdout.write(JSON.stringify({ status: 200, body }) + '\n');
    } catch (error) {
      let status = 500, body = { code: error.code || error.message };
      filterType && new filterType().catch(error, { switchToHttp: () => ({ getResponse: () => ({
        status: s => { status = s; return { json: b => { body = b; } }; },
      }) }) });
      process.stdout.write(JSON.stringify({ status, body }) + '\n');
    }
  });
}
