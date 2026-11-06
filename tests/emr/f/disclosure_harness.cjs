/* Synthetic storage ports, real F controller/service/contract and signed-original reader.
 * Shares real route metadata and parseAccessEvent admission with the inspection fixture; no database or network.
 */
'use strict';
const { fixture: inspectionFixture, actor, F, EmrAuditController } = require('./inspection_harness.cjs');
const { generateServerKeyPair, signServerPayload } = require('../../../api/src/emr-signature/server-crypto.ts');
const patient = { linkId: 'SYN-LINK', patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-SITE' };
function fixture(scopes = ['disclosure'], institution = 'SYN-SITE') {
  const f = inspectionFixture(scopes, institution), baseQuery = f.tx.$queryRaw;
  const requests = [], issuances = [], duties = [], copies = new Map();
  // CD-09-D: the studies whose report the retention unit destroyed (rs D), by record ID.
  const destroyed = new Set();
  const key = generateServerKeyPair(), kid = 'SYN-KEY';
  const doctor = { identity: actor, identityRegistrationId: 'SYN-DOCTOR', institutionId: 'SYN-SITE', canSign: true };
  const registration = { kid, publicKey: key.publicKey, doctor, registeredAt: '2026-01-01T00:00:00.000Z', status: 'active', endedAt: null };
  const originals = [];
  for (let index = 1; index <= 2; index++) {
    const previous = originals.at(-1);
    const content = { formatVersion: 'emr-signature/1', text: { kind: 'report', findings: `합성 원문 ${index} <script>unsafe</script>`, conclusion: '정상', recommendation: '' },
      patient, studyId: 'SYN-STUDY', managingInstitutionId: 'SYN-SITE', actingInstitutionId: 'SYN-SITE', recordKind: 'report-version',
      recordId: 'SYN-RECORD', versionId: `SYN-V${index}`, author: actor, signer: actor, identityRegistrationId: 'SYN-DOCTOR',
      action: index === 1 ? 'approve-sign' : 'addendum', previousVersion: previous ? { recordId: 'SYN-RECORD', versionId: previous.versionId, sha256: previous.versionSha256 } : null,
      attachments: [], reason: null };
    originals.push({ ...signServerPayload(content, kid, key.privateKey), versionId: content.versionId, kid, keyAtSigning: registration });
  }
  // Advisory keys in acquisition order (shared roster reads included): the order is F's lock contract.
  const locks = [];
  // No native report in this fixture; native_harness.cjs stores ReportVersion rows for its cases.
  f.tx.reportVersion = { findMany: async () => [] };
  f.tx.report = { findUnique: async () => null };
  f.tx.$queryRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('pg_advisory')) { locks.push(values[0]); return []; }
    if (sql.includes('FROM emr_audit.request_event')) return requests.filter(r => r.body.facts.requestId === values[0]).slice(-1);
    if (sql.includes('FROM emr_audit.issuance_event')) return issuances.filter(r => r.body.issuanceId === values[0] && r.body.manifest.institutionId === values[1]).slice(-1);
    if (sql.includes('FROM emr_audit.fixed_copy')) return copies.has(values[0]) ? [copies.get(values[0])] : [];
    if (sql.includes('FROM "StudyState"')) return values[0].filter(id => destroyed.has(id)).map(() => ({ found: 1 }));
    if (sql.includes('FROM emr_clinical.online_version')) return [];
    if (sql.includes('FROM emr_signing.signed_version')) return values[0] === 'SYN-RECORD' ? originals.map(outcome => ({ outcome })) : [];
    if (sql.includes('record_duty_request')) { duties.push({ sql, values: structuredClone(values) }); return []; }
    if (['place_hold', 'release_hold'].some(name => sql.includes(name))) return [];
    return baseQuery(parts, ...values);
  };
  f.tx.$executeRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('INSERT INTO emr_audit.request_event')) requests.push({ institution_id: values[1], body: JSON.parse(values[2]) });
    else if (sql.includes('INSERT INTO emr_audit.issuance_event')) issuances.push({ body: JSON.parse(values[2]) });
    else if (sql.includes('INSERT INTO emr_audit.fixed_copy')) copies.set(values[0], { body: values[1], sha256: values[2] });
    else throw Error('Unexpected synthetic write: ' + sql);
    return 1;
  };
  return { ...f, requests, issuances, copies, originals, duties, locks, destroyed };
}
function intake(id = 'SYN-REQUEST', method = 'electronic', versions = 'all', recordId = 'SYN-RECORD') {
  const at = new Date(Date.now() - 1000).toISOString();
  return { request: { requestId: id, receivedAt: at, patient, basis: { clauseId: 'medical:21.1', purpose: 'patient-copy' },
    requester: { kind: 'patient', name: '합성 요청자', organization: null },
    evidence: [{ kind: 'identity-check', documentId: 'SYN-EVIDENCE', checkedBy: actor, checkedAt: at }], scope: [{ recordId, versions }],
    delivery: { recipient: '합성 수령자', method, format: method === 'electronic' ? 'signed-electronic' : 'paper-print' } },
    dueAt: new Date(Date.now() + 86400000).toISOString() };
}
module.exports = { fixture, intake, patient, actor, F };
if (require.main === module) {
  let f = fixture();
  const filterType = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    try {
      const q = JSON.parse(line);
      if (q.reset) { f = fixture(q.scopes, q.institution); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      if (q.inspect) { process.stdout.write(JSON.stringify({ status: 200, body: { records: f.records, requests: f.requests, originals: f.originals } }) + '\n'); return; }
      const body = await f.controller[q.method]({}, ...(q.id ? [q.id] : []), ...(q.body ? [q.body] : []));
      process.stdout.write(JSON.stringify({ status: 200, body }) + '\n');
    } catch (error) {
      let status = 500, body = { code: error.code || error.message };
      new filterType().catch(error, { switchToHttp: () => ({ getResponse: () => ({ status: s => { status = s; return { json: b => { body = b; } }; } }) }) });
      process.stdout.write(JSON.stringify({ status, body }) + '\n');
    }
  });
}
