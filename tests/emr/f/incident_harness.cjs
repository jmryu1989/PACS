/* Actual F controller, contract and surface parser; only storage is synthetic. */
'use strict';
const { fixture: base, actor, EmrAuditController } = require('./inspection_harness.cjs');
const { randomUUID } = require('node:crypto');
const known = value => ({ status: 'known', value });
function fixture(scopes = ['investigate', 'export'], institution = 'SYN-SITE', requestActor = actor) {
  const f = base(scopes, institution, [], requestActor), requests = [], query = f.tx.$queryRaw;
  f.events.splice(0, f.events.length, { formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: 'SYN-READ',
    userId: known(actor), rolesAtTime: known(['radiologist']), actingInstitution: known('SYN-SITE'), managingInstitution: known('SYN-SITE'),
    occurredAt: '2026-10-02T00:00:00.000Z', trustedProxyIp: known({ address: '127.0.0.1', source: 'trusted-proxy' }),
    cause: 'user-view', executor: 'member', context: { basis: 'worklist', studyId: null, relatedStudyId: null, reason: null },
    targets: [{ kind: 'report-version', patientLinkSnapshot: known({ patientId: 'SYN-PATIENT', assigningAuthority: 'SYN-SITE', linkId: 'SYN-LINK' }),
      studyId: known('SYN-STUDY'), recordId: known('SYN-RECORD'), versionId: known('SYN-VERSION') }],
    action: 'provide-prepared', result: 'prepared', requestId: 'SYN-READ-REQUEST', auditLinkId: `audit:${randomUUID()}`, relatedEventId: null });
  f.tx.$queryRaw = async (parts, ...values) => {
    const sql = parts.join('?');
    if (sql.includes('FROM emr_audit.grantor')) return f.grantor ? [structuredClone(f.grantor)] : [];
    if (sql.includes('FROM emr_audit.roster_event') && values[0] === actor.id && requestActor.id !== actor.id) {
      const rows = await query(parts, ...values);
      return rows.map(r => ({ body: { ...r.body, grantId: 'SYN-ORIGINAL-GRANT', subject: actor } }));
    }
    if (sql.includes('FROM emr_audit.request_event')) {
      if (sql.includes('DISTINCT ON')) return structuredClone([...new Map(requests.filter(r => r.institution_id === values[0] && r.body.kind === 'incident').map(r => [r.body.incidentId, r])).values()]);
      return structuredClone(requests.filter(r => r.body.incidentId === values[0]).slice(-1));
    }
    return query(parts, ...values);
  };
  f.tx.$executeRaw = async (parts, ...values) => {
    if (!parts.join('?').includes('INSERT INTO emr_audit.request_event')) throw Error('Unexpected write');
    requests.push({ institution_id: values[1], body: JSON.parse(values[2]) }); return 1;
  };
  f.grantor = { capacity: 'privacy-officer', basis_document_id: 'SYN-DESIGNATION' };
  return Object.assign(f, { requests });
}
function intake(id = 'SYN-INCIDENT', status = 'possible') {
  return { incidentId: id, incidentType: 'cvr-misdelivery', query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' },
    determinations: [{ kind: 'access-outside-ledger', note: '합성 CVR 오발송: 원장 밖 수신자 확인 중 <img>' }],
    facts: { incidentId: id, awarenessAt: '2026-11-01T00:00:00.000Z', determinationAt: '2026-11-01T00:00:00.000Z', status,
      possibleGround: status === 'possible' ? 'illegal-access-unidentifiable' : null,
      evidenceId: 'SYN-FINDING-1', detailsComplete: true, newlyConfirmedAt: null, reportTriggers: [], medicalIncident: null } };
}
function notice(obligation, id = 'SYN-NOTICE') {
  return { operationId: id, notice: { kind: obligation.kind, triggeredAt: obligation.triggeredAt, noticeId: id,
    sentAt: '2026-11-01T02:00:00.000Z', triggerEventId: obligation.triggerEventId, recipientScopeRef: obligation.recipientScopeRef,
    coversAll: true, evidenceId: id + '-EVIDENCE', coveredFields: obligation.requiredFields,
    channel: obligation.recipient === 'PIPC-or-KISA' ? 'PIPC' : obligation.recipient === 'MOHW' ? 'MOHW-official' : obligation.recipient === 'MSIT-or-KISA' ? 'KISA' : 'affected-users' } };
}
function decider(at = '2026-11-01T00:00:00.000Z') {
  return { verifiedAt: at, designation: { categoryBasis: 'privacy-decree:32.2.1', categoryEvidenceId: 'SYN-CATEGORY',
    qualificationRequired: false, qualificationAssessmentEvidenceId: 'SYN-QUALIFICATION' } };
}
function exemption(obligation, id = 'SYN-EXEMPT') {
  return { operationId: id, decision: { decisionId: id, obligationKey: obligation.obligationKey,
    at: '2026-11-01T01:00:00.000Z', authorityEvidenceId: 'SYN-DESIGNATION', evidenceId: id + '-EVIDENCE',
    reason: '합성 면제 결정 근거', basis: 'privacy-decree:40.1:last-sentence', effect: 'report-exemption', stillOwed: false,
    category: 'risk-substantially-reduced', decider: decider() } };
}
function delay(obligation, id = 'SYN-DELAY') {
  return { operationId: id, delay: { delayId: id, obligationKey: obligation.obligationKey,
    clause: { possibility: 'privacy-decree:39-3.1', confirmed: 'privacy-decree:39.1', report: 'privacy-decree:40.1' }[obligation.family],
    version: '2026-09-11', reason: '합성 불가항력 지연', evidenceId: id + '-EVIDENCE',
    startedAt: '2026-11-01T00:30:00.000Z', clearedAt: null, accepted: true, decisionId: id + '-DECISION', supersedes: null,
    category: 'force-majeure', decider: decider(), causalReview: { evidenceId: 'SYN-CAUSE',
      reviewedAt: '2026-11-01T01:00:00.000Z', relatesToTime: '2026-11-01T00:30:00.000Z',
      createdAt: '2026-11-01T00:30:00.000Z', receivedAt: '2026-11-01T00:45:00.000Z', reason: '합성 인과 검토' } } };
}
module.exports = { fixture, intake, notice, exemption, delay, decider };
if (require.main === module) {
  let f = fixture();
  const Filter = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    try {
      const q = JSON.parse(line);
      if (q.reset) { f = fixture(q.scopes, q.institution); process.stdout.write(JSON.stringify({ status: 200, body: {} }) + '\n'); return; }
      if (q.inspect) { process.stdout.write(JSON.stringify({ status: 200, body: { records: f.records, requests: f.requests } }) + '\n'); return; }
      const body = await f.controller[q.method]({}, ...(q.id ? [q.id] : []), ...(q.form ? [q.form] : []), ...(q.body ? [q.body] : []));
      process.stdout.write(JSON.stringify({ status: 200, body }) + '\n');
    } catch (error) {
      let status = 500, body = { code: error.code || error.message };
      new Filter().catch(error, { switchToHttp: () => ({ getResponse: () => ({ status: s => { status = s; return { json: b => { body = b; } }; } }) }) });
      process.stdout.write(JSON.stringify({ status, body }) + '\n');
    }
  });
}
