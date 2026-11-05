/* Real F controller/service/contract over synthetic native report storage.
 * The stored rows and signatures follow report-commit.ts/native-signing.ts: every commit appends a ReportVersion,
 * approve/addendum and a reset of an existing report carry a C2 signature whose previous version is the Report head
 * row digest, and a content reset/force-discard appends a discarded row that never becomes the head. */
'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { fixture: rightsFixture, patient, actor, F } = require('./rights_harness.cjs');
const { generateServerKeyPair, signServerPayload } = require('../../../api/src/emr-signature/server-crypto.ts');
const { planClinicalWrite } = require('../../../api/src/emr-clinical/records.ts');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UID = '2.25.7001';
const ACTIONS = { approve: 'approve-sign', addendum: 'addendum', reset: 'cancel' };

function fixture(scopes = ['disclosure'], institution = 'SYN-SITE') {
  const f = rightsFixture(scopes, institution), baseQuery = f.tx.$queryRaw;
  const key = generateServerKeyPair(), kid = 'SYN-NATIVE-KEY';
  const doctor = { identity: actor, identityRegistrationId: 'SYN-DOCTOR', institutionId: 'SYN-SITE', canSign: true };
  const registration = { kid, publicKey: key.publicKey, doctor, registeredAt: '2026-01-01T00:00:00.000Z', status: 'active', endedAt: null };
  const rows = [], reports = new Map(), signed = new Map(), clinical = new Map();
  let id = 0, clock = Date.parse('2026-10-01T00:00:00.000Z');
  const row = (uid, version, action, text, reason = null) => ({ id: ++id, uid, version, action, findings: text, conclusion: text ? '합성 결론' : '',
    recommendation: '', reason, author: 'synthetic-doctor@example.test', citations: [], structured: null, at: new Date(clock += 1000) });
  const nextVersion = uid => Math.max(0, ...rows.filter(r => r.uid === uid).map(r => r.version)) + 1;
  function sign(saved, before, action = ACTIONS[saved.action]) {
    const content = { formatVersion: 'emr-signature/1', text: { kind: 'clinical-entry', body: JSON.stringify(saved) },
      patient, studyId: saved.uid, managingInstitutionId: 'SYN-SITE', actingInstitutionId: 'SYN-SITE', recordKind: 'report-version',
      recordId: saved.uid, versionId: String(saved.version), author: actor, signer: actor, identityRegistrationId: 'SYN-DOCTOR',
      action, previousVersion: before ? { recordId: before.uid, versionId: String(before.version), sha256: digest(before) } : null,
      attachments: [], reason: saved.reason };
    const outcome = { ...signServerPayload(content, kid, key.privateKey), operationId: randomUUID(), recordId: saved.uid,
      versionId: String(saved.version), kid, doctorId: actor.id, institutionId: 'SYN-SITE', keyAtSigning: registration };
    signed.set(saved.uid, [...(signed.get(saved.uid) ?? []), outcome]);
    return outcome;
  }
  /** report-commit.ts:311-358 for one committed action. */
  function commit(uid, action, text = `${action} 본문`, reason = null) {
    const cur = reports.get(uid) ?? null, head = cur && rows.find(r => r.uid === uid && r.version === cur.version);
    let version = nextVersion(uid);
    if (action === 'reset' && head && (head.findings || head.conclusion || head.recommendation)) {
      rows.push(row(uid, version, 'discarded', head.findings, '판독 취소로 폐기')); version += 1;
    }
    const saved = row(uid, version, action, action === 'reset' ? '' : text, reason);
    if (action === 'reset') saved.conclusion = '';
    rows.push(saved); reports.set(uid, { version });
    const signature = ['approve', 'addendum'].includes(action) || (action === 'reset' && cur) ? sign(saved, head) : null;
    return { row: saved, signature };
  }
  /** report-draft.ts force-discard: another author's draft becomes a discarded row; the Report head is unchanged. */
  function discard(uid, text = '다른 작성자의 개인 초안') {
    const saved = row(uid, nextVersion(uid), 'discarded', text, '강제 폐기');
    rows.push(saved); return saved;
  }
  /** A real D Tech Note plan stored under the Study UID, as pacs-routes.ts:51 writes it. */
  function techNote(uid, text = '합성 Tech Note', response) {
    const plan = planClinicalWrite({ surface: 'tech-note.write', actor: { identity: actor, kind: 'member', roles: ['admin'],
      institutionId: 'SYN-SITE', signingRegistrationId: null }, study: { studyId: uid, patient, managingInstitutionId: 'SYN-SITE' },
      unit: null, body: { baseVersion: 0, text, reason: '', attemptId: randomUUID() }, content: null,
      attachments: [], navigation: [], recipientId: null, readerId: null, workContext: null,
      ids: { recordId: uid, versionId: randomUUID() }, at: new Date(clock += 1000).toISOString() });
    // A route write whose projector answered is stored as {plan, response} (emr-clinical/store.ts append).
    clinical.set(uid, [...(clinical.get(uid) ?? []), { body: JSON.stringify(response === undefined ? plan : { plan, response }), signature: null }]);
    return plan;
  }
  /** Rewrite the stored issuances to the shape saved before recordKind was recorded; issue reads the stored manifest. */
  function legacyIssuances() {
    for (const r of f.issuances) if (r.body.manifest.records[0].recordKind) {
      const records = r.body.manifest.records.map(({ recordKind, ...rest }) => rest);
      r.body = { ...r.body, manifest: { ...r.body.manifest, records } };
      r.body.manifestSha256 = digest(r.body.manifest);
      r.body.events = r.body.events.map(e => ({ ...e, ...(e.manifestSha256 ? { manifestSha256: r.body.manifestSha256 } : {}),
        ...(e.artifact ? { artifact: { ...e.artifact, manifestSha256: r.body.manifestSha256 } } : {}) }));
    }
  }
  f.tx.reportVersion = { findMany: async ({ where, orderBy }) => {
    if (orderBy?.version !== 'asc') throw Error('Unexpected synthetic ReportVersion order');
    return rows.filter(r => r.uid === where.uid).sort((a, b) => a.version - b.version).map(r => ({ ...r, at: new Date(r.at) }));
  } };
  f.tx.report = { findUnique: async ({ where }) => reports.has(where.uid) ? { ...reports.get(where.uid) } : null };
  f.tx.$queryRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('FROM emr_signing.signed_version') && signed.has(values[0])) return signed.get(values[0]).map(outcome => ({ outcome }));
    if (sql.includes('FROM emr_clinical.online_version') && clinical.has(values[0])) return clinical.get(values[0]);
    return baseQuery(parts, ...values);
  };
  return { ...f, rows, reports, signed, clinical, commit, discard, techNote, legacyIssuances, sign, registration };
}
function copyIntake(id, scope, format = 'signed-electronic') {
  const at = new Date(Date.now() - 1000).toISOString();
  return { request: { requestId: id, receivedAt: at, patient, basis: { clauseId: 'medical:21.1', purpose: 'patient-copy' },
    requester: { kind: 'patient', name: '합성 요청자', organization: null },
    evidence: [{ kind: 'identity-check', documentId: 'SYN-EVIDENCE', checkedBy: actor, checkedAt: at }], scope,
    delivery: format === 'signed-electronic' ? { recipient: '합성 수령자', method: 'electronic', format }
      : { recipient: '합성 수령자', method: 'in-person', format } },
    dueAt: new Date(Date.now() + 86400000).toISOString() };
}
function rightsIntake(requestId, recordIds, kind = 'correction') {
  return { requestId, kind, receivedAt: '2026-10-01T00:00:00.000Z', patient, recordIds, statement: '합성 정정 요구' };
}
module.exports = { fixture, copyIntake, rightsIntake, UID, digest, patient, actor, F };
if (require.main === module) {
  // One Study UID holding a Tech Note and a saved-then-approved native report, for the browser tests. `reportOnly`
  // starts without the Tech Note, `saved` sets the saved version's findings; `techNote` adds it later and `legacy` gives the stored issuances their pre-recordKind
  // shape, so a request received unselected, or prepared before F, becomes ambiguous.
  const { EmrAuditController } = require('./inspection_harness.cjs');
  const seeded = (reportOnly = false, saved = '저장 소견') => { const f = fixture(); if (!reportOnly) f.techNote(UID); f.commit(UID, 'save', saved); f.commit(UID, 'approve', '확정 소견'); return f; };
  let f = seeded();
  const Filter = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    try {
      const q = JSON.parse(line);
      if (q.reset) { f = seeded(!!q.reportOnly, q.saved); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      if (q.techNote) { if (q.legacy) f.legacyIssuances(); f.techNote(UID); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      if (q.inspect) { process.stdout.write(JSON.stringify({ status: 200, body: { records: f.records, requests: f.requests, issuances: f.issuances } }) + '\n'); return; }
      const body = await f.controller[q.method]({}, ...(q.id ? [q.id] : []), ...(q.body ? [q.body] : []));
      process.stdout.write(JSON.stringify({ status: 200, body }) + '\n');
    } catch (error) {
      let status = 500, body = { code: error.code || error.message };
      new Filter().catch(error, { switchToHttp: () => ({ getResponse: () => ({ status: s => { status = s; return { json: b => { body = b; } }; } }) }) });
      process.stdout.write(JSON.stringify({ status, body }) + '\n');
    }
  });
}