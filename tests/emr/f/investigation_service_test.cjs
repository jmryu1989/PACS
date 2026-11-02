/* REQ-EMR-15 -> RISK-F-02 -> TEST-F-CONTINUATION.
 * Real service, controller and contract; synthetic transaction/roster/ledger ports.
 * Observe reads and recorded targets, without a database or compiled deployment.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
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
const { routeController, routeSurface } = require('./inspection_harness.cjs');
const { parseAccessEvent } = require(path.join(API, 'src/emr-contract/access-event.ts'));
const known = value => ({ status: 'known', value });
const actor = { id: 'synthetic-auditor', issuer: 'synthetic', subject: 'auditor' };
const institution = 'synthetic-site', at = '2026-10-15T00:00:00.000Z';
const query = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', limit: 1 };
function fixture(scopes = ['investigate', 'export']) {
  const reads = [], records = [];
  const event = (name, action) => ({ formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: name,
    userId: known(actor), rolesAtTime: known(['radiologist']), actingInstitution: known(institution), managingInstitution: known(institution),
    occurredAt: at, trustedProxyIp: known({ address: '127.0.0.1', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member',
    context: { basis: 'worklist', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'report-version', patientLinkSnapshot: known({ patientId: 'SYN-P', assigningAuthority: 'SYN-A', linkId: 'SYN-L' }),
      studyId: known('SYN-S'), recordId: known('SYN-R'), versionId: known('SYN-V') }], action, result: action === 'provide-prepared' ? 'prepared' : 'succeeded',
    requestId: 'synthetic-request', auditLinkId: `audit:${randomUUID()}`, relatedEventId: null });
  const rows = { history: [event('change-1', 'write')], viewing: [event('view-2', 'provide-prepared'), event('view-1', 'provide-prepared')] };
  const tx = { $queryRaw: async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('pg_advisory')) return [];
    if (sql.includes('roster_event')) return scopes.length ? [{ body: { grantId: 'synthetic-grant', subject: actor, institutionId: institution,
      events: [{ kind: 'granted', eventId: 'synthetic-grant-event', at: query.from, by: actor,
        capacity: 'privacy-officer', basisDocumentId: 'synthetic-appointment', scopes, validFrom: query.from, validUntil: null }] } }] : [];
    if (sql.includes('investigation_')) {
      const [stream] = values; reads.push(stream);
      if (sql.includes('investigation_count')) return [{ total: BigInt(rows[stream].length) }];
      const below = values[5], take = values[6];
      return rows[stream].map((event, index) => ({ sequence: BigInt(rows[stream].length - index), payload: JSON.stringify(event),
        recorded_at: new Date(at), snapshot_top: BigInt(rows[stream].length) }))
        .filter(row => below === null || row.sequence < below).slice(0, take);
    }
    throw new Error('Unexpected synthetic SQL: ' + sql);
  } };
  const ctx = { facts: { actor, institution, roles: ['radiologist'], ingress: known({ address: '127.0.0.1', source: 'trusted-proxy' }),
    requestId: 'synthetic-request' },
    requireCurrent: async () => {}, assertActive: () => {}, work: {
      transactionWithRecords: async fn => fn(tx, async (event, effect) => { records.push(parseAccessEvent(event)); return effect(); }),
    } };
  const service = new EmrAuditService({}, { withWork: async (request, fn) => fn({ ...ctx, facts: { ...ctx.facts, surface: request[routeSurface] } }) });
  return { controller: routeController(new EmrAuditController(service)), reads, records };
}
test('exhausted history is not read or recorded again while viewing continues', async () => {
  const f = fixture();
  const first = await f.controller.investigate({}, query);
  assert.equal(first.changes.nextCursor, null);
  assert.ok(first.views.nextCursor);
  f.reads.length = 0; f.records.length = 0;
  const more = await f.controller.investigate({}, { ...query, changesDone: true, viewsAfter: first.views.nextCursor });
  assert.equal(more.changes, null, 'omitted stream is explicit, not a fresh empty result');
  assert.deepEqual(more.views.rows.map(row => row.eventId), ['view-1']);
  assert.ok(f.reads.length > 0);
  assert.ok(f.reads.every(stream => stream === 'viewing'));
  assert.deepEqual(f.records.flatMap(event => event.targets.map(target => target.recordId.value)), ['view-1']);
});
test('exhausted viewing is omitted symmetrically', async () => {
  const f = fixture();
  const page = await f.controller.investigate({}, { ...query, viewsDone: true });
  assert.equal(page.views, null);
  assert.deepEqual(page.changes.rows.map(row => row.eventId), ['change-1']);
  assert.ok(f.reads.every(stream => stream === 'history'));
  assert.deepEqual(f.records.flatMap(event => event.targets.map(target => target.recordId.value)), ['change-1']);
});
test('done markers cannot omit export data or bypass authority and malformed requests make no reads', async () => {
  for (const body of [{ changesDone: true, viewsDone: true }, { changesDone: 'true' }, { changesDone: true, changesAfter: 'stale' }]) {
    const f = fixture();
    await assert.rejects(f.controller.investigate({}, { ...query, ...body }), { code: 'InvestigationQueryRefused' });
    assert.deepEqual(f.reads, []); assert.deepEqual(f.records, []);
  }
  const f = fixture();
  await assert.rejects(f.controller.export({}, { ...query, changesDone: true }), { code: 'InvestigationQueryRefused' });
  assert.deepEqual(f.reads, []); assert.deepEqual(f.records, []);
  for (const [scopes, code] of [[[], 'AuditorNotDesignated'], [['inspection'], 'AuditScopeNotGranted']]) {
    const denied = fixture(scopes);
    await assert.rejects(denied.controller.investigate({}, { ...query, changesDone: true }), { code });
    assert.deepEqual(denied.reads, []); assert.deepEqual(denied.records, []);
  }
});
