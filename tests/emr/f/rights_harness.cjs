/* Real F controller/service, original reader and per-route parseAccessEvent admission
 * inherited through disclosure/inspection fixtures; synthetic storage only, no network/DB. */
'use strict';
const { fixture: disclosureFixture, patient, actor, F } = require('./disclosure_harness.cjs');
const { EmrAuditController } = require('./inspection_harness.cjs');
const { composeEmrAdapters } = require('../../../api/src/emr-contract/composition.ts');
const { runtimeAdapters } = require('../../../api/src/emr-runtime/context.ts');
const { planClinicalWrite } = require('../../../api/src/emr-clinical/records.ts');
const { randomUUID } = require('node:crypto');
composeEmrAdapters(runtimeAdapters);
function fixture(scopes = ['disclosure'], institution = 'SYN-SITE') {
  const f = disclosureFixture(scopes, institution), baseQuery = f.tx.$queryRaw;
  const operational = planClinicalWrite({ surface: 'tech-note.write', actor: { identity: actor, kind: 'member', roles: ['admin'],
    institutionId: 'SYN-SITE', signingRegistrationId: null }, study: { studyId: 'SYN-STUDY', patient, managingInstitutionId: 'SYN-SITE' },
    unit: null, body: { baseVersion: 0, text: '합성 운영 메모', reason: '', attemptId: randomUUID() }, content: null,
    attachments: [], navigation: [], recipientId: null, readerId: null, workContext: null,
    ids: { recordId: 'SYN-NOTE', versionId: randomUUID() }, at: new Date().toISOString() });
  const clinicalRows = [{ body: JSON.stringify(operational), signature: null }];
  f.tx.$queryRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('FROM emr_clinical.online_version') && values[0] === 'SYN-NOTE')
      return clinicalRows;
    if (sql.includes('FROM emr_audit.request_event')) {
      if (sql.includes('DISTINCT ON')) {
        const latest = new Map(f.requests.filter(r => r.institution_id === values[0] && r.body.kind === 'rights-request')
          .map(r => [r.body.request.requestId, r]));
        return structuredClone([...latest.values()]);
      }
      return structuredClone(f.requests.filter(r => (r.body.request?.requestId || r.body.facts?.requestId) === values[0]).slice(-1));
    }
    return baseQuery(parts, ...values);
  };
  return { ...f, operational, clinicalRows };
}
function intake(requestId = 'SYN-RIGHTS', kind = 'correction') {
  return { requestId, kind, receivedAt: '2026-10-01T00:00:00.000Z', patient,
    recordIds: ['SYN-RECORD'], statement: '합성 정정 요구 <b>원문</b>' };
}
module.exports = { fixture, intake, patient, actor, F };
if (require.main === module) {
  let f = fixture();
  const Filter = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    try {
      const q = JSON.parse(line);
      if (q.reset) { f = fixture(q.scopes, q.institution); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      if (q.inspect) { process.stdout.write(JSON.stringify({ status: 200, body: { records: f.records, requests: f.requests, duties: f.duties } }) + '\n'); return; }
      if (q.unavailable_originals) { f.originals.length = 0; process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      const body = await f.controller[q.method]({}, ...(q.id ? [q.id] : []), ...(q.body ? [q.body] : []));
      process.stdout.write(JSON.stringify({ status: 200, body }) + '\n');
    } catch (error) {
      let status = 500, body = { code: error.code || error.message };
      new Filter().catch(error, { switchToHttp: () => ({ getResponse: () => ({ status: s => { status = s; return { json: b => { body = b; } }; } }) }) });
      process.stdout.write(JSON.stringify({ status, body }) + '\n');
    }
  });
}
