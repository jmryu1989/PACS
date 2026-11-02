/* CD-09a synthetic native-report signatures: the committed StoredApproval rows native-signing.ts writes, signed at a
 * chosen past instant with a fixture-only P-256 key, so a unit can be due today. Used by the pure worker test (TS
 * source) and, mounted read-only into the API image, by tests/e2e/test_cd09_retention_worker.py (compiled dist).
 * Synthetic only: no real patient, doctor or key.
 */
const crypto = require('node:crypto');

function signedReports(load, spec) {
  const { canonicalPayload } = load('emr-contract/signature');
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const doctor = { identity: { id: spec.doctorId, issuer: 'https://identity.example.test', subject: spec.doctorId },
    identityRegistrationId: 'registration-' + spec.doctorId, institutionId: spec.institutionId, canSign: true };
  const registration = { kid: spec.kid, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, doctor,
    status: 'active', registeredAt: spec.registeredAt, endedAt: null };
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: spec.kid, typ: 'emr-signature+jws' }), 'utf8').toString('base64url');
  const approvals = [];
  for (const report of spec.reports) {
    let previous = null;
    for (const v of report.versions) {
      const versionId = String(v.version);
      const content = { formatVersion: 'emr-signature/1', text: { kind: 'clinical-entry', body: JSON.stringify({ uid: report.uid, version: v.version, action: v.action }) },
        patient: { linkId: 'link-' + report.uid, patientId: 'SYNTHETIC-patient', assigningAuthority: 'SYNTHETIC' },
        studyId: report.uid, managingInstitutionId: spec.institutionId, actingInstitutionId: spec.institutionId,
        recordKind: 'report-version', recordId: report.uid, versionId, author: doctor.identity, signer: doctor.identity,
        identityRegistrationId: doctor.identityRegistrationId,
        action: v.action === 'approve' ? 'approve-sign' : v.action === 'reset' ? 'cancel' : 'addendum',
        serverTime: v.signedAt, previousVersion: previous, attachments: [], reason: v.reason ?? null };
      const bytes = canonicalPayload(content), payload = bytes.toString('base64url');
      const signature = crypto.sign('sha256', Buffer.from(header + '.' + payload, 'ascii'), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const versionSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const outcome = { envelope: { protected: header, payload, signature }, versionSha256, signedAt: v.signedAt,
        operationId: crypto.randomUUID(), recordId: report.uid, versionId, kid: spec.kid, doctorId: spec.doctorId,
        institutionId: spec.institutionId, keyAtSigning: registration };
      approvals.push({ recordId: report.uid, versionId, kid: spec.kid, outcome });
      previous = { recordId: report.uid, versionId, sha256: versionSha256 };
    }
  }
  return { registration, approvals };
}
module.exports = { signedReports };

if (require.main === module) {
  // Inside the API image: compiled modules under /app/dist; the spec is the only argument.
  const result = signedReports(name => require('/app/dist/' + name), JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify(result));
}
