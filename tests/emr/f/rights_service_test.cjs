/* REQ-EMR-17 -> TEST-F-RIGHTS: request workflow, immutable originals and tenant/roster boundaries.
 * 위험 ID 미배정: 문서 트랙 대기. */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, intake } = require('./rights_harness.cjs');
const notice = () => ({ notifiedAt: new Date().toISOString(), recipient: '합성 수령자', method: 'electronic',
  evidenceId: 'SYN-NOTICE', content: '거절 근거 조문 및 실제 이의제기 방법 통지 원문' });
test('rights intake, contract decision and evidenced notice preserve originals and reopen', async () => {
  const f = fixture(), input = intake(), original = JSON.stringify(f.originals);
  let saved = await f.controller.receiveRights({}, input);
  assert.equal(saved.status, 'Received'); assert.equal(saved.decision, null);
  assert.equal(saved.dueBy, '2026-10-10T15:00:00.000Z'); assert.equal(saved.overdue, true);
  saved = await f.controller.decideRights({}, input.requestId);
  assert.equal(saved.status, 'Decided');
  assert.equal(saved.decision.records[0].outcome, 'correct-by-new-signed-version');
  saved = await f.controller.notifyRights({}, input.requestId, { notifiedAt: new Date().toISOString(),
    recipient: '합성 수령자', method: 'electronic', evidenceId: 'SYN-NOTICE', content: '실제 전달한 통지문' });
  assert.equal(saved.status, 'Notified'); assert.equal(saved.notification.evidenceId, 'SYN-NOTICE');
  assert.equal((await f.controller.readRights({}, input.requestId)).status, 'Notified');
  assert.equal((await f.controller.listRights({})).requests.length, 1);
  assert.equal(JSON.stringify(f.originals), original);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[0].body.decision, null);
  assert.equal(f.requests[1].body.notification, null);
});

for (const kind of ['correction', 'deletion', 'processing-suspension']) {
  for (const [period, decisionAt] of [['retention-running', '2026-11-03T01:00:00Z'], ['retention-ended', '2035-11-03T01:00:00Z']]) {
    test(`${kind} / ${period}: 출하 분류, Q1 미정; notice deadline and original preservation`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T01:00:00Z') });
      const f = fixture(), original = JSON.stringify(f.originals);
      t.mock.timers.setTime(Date.parse(decisionAt));
      const input = intake('SYN-' + kind, kind);
      await f.controller.receiveRights({}, input);
      const result = await f.controller.decideRights({}, input.requestId);
      const expected = { correction: 'correct-by-new-signed-version', deletion: 'refused-retained-by-law',
        'processing-suspension': 'refused-legal-duty' }[kind];
      assert.equal(result.decision.records[0].outcome, expected,
        'F does not take a retention-expiry input; even the 2035 decision uses the stored statutory classification');
      assert.equal(result.decision.notice.dueBy, '2026-10-10T15:00:00.000Z');
      assert.equal(result.overdue, true);
      if (kind !== 'correction') {
        assert.equal(result.decision.notice.content, 'refusal-with-reason-and-objection-method');
        assert.ok(result.decision.records[0].basis.includes(kind === 'deletion' ? 'privacy:36.1-proviso' : 'privacy:37.2.1'));
      }
      const sent = await f.controller.notifyRights({}, input.requestId, notice());
      assert.equal(sent.status, 'Notified'); assert.equal(sent.overdue, true);
      assert.equal(JSON.stringify(f.originals), original);
    });
  }
  test(`${kind}: purpose-only operational note uses A classification with no original mutation`, async () => {
    const f = fixture(), input = { ...intake('SYN-PURPOSE', kind), recordIds: ['SYN-NOTE'] };
    const original = JSON.stringify(f.operational);
    await f.controller.receiveRights({}, input);
    const state = await f.controller.decideRights({}, input.requestId);
    assert.equal(state.decision.records[0].outcome, { correction: 'correct', deletion: 'delete-irreversibly',
      'processing-suspension': 'suspend-processing' }[kind]);
    assert.equal(state.decision.notice.content, 'action-result-required');
    assert.equal(JSON.stringify(f.operational), original);
  });
}

test('every route enforces designation, disclosure scope and current request authority', async () => {
  for (const [scopes, code] of [[[], 'AuditorNotDesignated'], [['inspection'], 'AuditScopeNotGranted']]) {
    const f = fixture(scopes);
    for (const [method, args] of [['receiveRights', [intake()]], ['listRights', []], ['readRights', ['SYN-RIGHTS']],
      ['decideRights', ['SYN-RIGHTS']], ['notifyRights', ['SYN-RIGHTS', notice()]]])
      await assert.rejects(f.controller[method]({}, ...args), { code });
    assert.equal(f.records.length, 0); assert.equal(f.requests.length, 0);
  }
  const { clinicianRouteAllowed } = require('../../../api/src/clinician-policy.ts');
  const { routeContract } = require('../../../api/src/emr-contract/routes.ts');
  for (const route of ['POST emr-audit/rights-requests', 'GET emr-audit/rights-requests', 'GET emr-audit/rights-requests/:id',
    'POST emr-audit/rights-requests/:id/decide', 'POST emr-audit/rights-requests/:id/notify']) {
    assert.equal(clinicianRouteAllowed(route), true); assert.deepEqual(routeContract(route).kinds, ['disclosure']);
  }
});

test('foreign institution, mismatched subject, forged classification and unknown originals cannot be accepted', async () => {
  const f = fixture(), input = intake(); await f.controller.receiveRights({}, input);
  const foreign = fixture(['disclosure'], 'OTHER-SITE'); foreign.requests.push(...f.requests);
  assert.deepEqual((await foreign.controller.listRights({})).requests, []);
  for (const method of ['readRights', 'decideRights', 'notifyRights'])
    await assert.rejects(foreign.controller[method]({}, input.requestId, notice()), { code: 'RequestNotFound' });
  await assert.rejects(foreign.controller.receiveRights({}, { ...input, requestId: 'NEW' }), { code: 'DisclosureSubjectMismatch' });
  await assert.rejects(f.controller.receiveRights({}, { ...input, requestId: 'BAD-PATIENT', patient: { ...input.patient, patientId: 'OTHER' } }),
    { code: 'DisclosureSubjectMismatch' });
  await assert.rejects(f.controller.receiveRights({}, { ...input, requestId: 'BAD-FACT', retained: false }), { code: 'AuditRequestInvalid' });
  await assert.rejects(f.controller.receiveRights({}, { ...input, requestId: 'MISSING', recordIds: ['UNKNOWN'] }), { code: 'VersionListingIncomplete' });
  assert.equal(f.requests.length, 1);
});

test('append-only transitions, replay, intake collision and exact response audit targets', async () => {
  const f = fixture(), input = intake();
  await f.controller.receiveRights({}, input); await f.controller.receiveRights({}, input);
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.controller.notifyRights({}, input.requestId, notice()), { code: 'RightsDecisionRequired' });
  await assert.rejects(f.controller.receiveRights({}, { ...input, statement: 'different' }), { code: 'RightsRequestConflict' });
  await assert.rejects(f.controller.state({}, input.requestId), { code: 'DisclosureRequestConflict' });
  const copyInput = require('./disclosure_harness.cjs').intake('COPY-FIRST');
  await f.controller.register({}, copyInput);
  await assert.rejects(f.controller.receiveRights({}, intake('COPY-FIRST')), { code: 'RightsRequestConflict' });
  await f.controller.decideRights({}, input.requestId); await f.controller.decideRights({}, input.requestId);
  const sent = notice(); await f.controller.notifyRights({}, input.requestId, sent);
  await f.controller.notifyRights({}, input.requestId, sent);
  await assert.rejects(f.controller.notifyRights({}, input.requestId, { ...sent, content: 'replacement' }), { code: 'RightsRequestConflict' });
  assert.equal(f.requests.filter(r => r.body.kind === 'rights-request').length, 3);
  await f.controller.readRights({}, input.requestId);
  assert.deepEqual(f.records.at(-1).targets.map(t => [t.recordId.value, t.patientLinkSnapshot.value]), [['SYN-RECORD', input.patient]]);
  const list = await f.controller.listRights({});
  assert.equal(JSON.stringify(list).includes('SYN-PATIENT'), false);
  assert.deepEqual(f.records.at(-1).targets.map(t => t.recordId.value), [input.requestId]);
  const { parseAccessEvent } = require('../../../api/src/emr-contract/access-event.ts');
  const admitted = parseAccessEvent(f.records.at(-1));
  assert.deepEqual(admitted.targets.map(t => t.recordId.value), [input.requestId]);
  assert.equal(JSON.stringify(admitted.targets).includes(input.patient.patientId), false);
});

test('received duty remains open through decision and closes once on evidenced notification', async () => {
  const f = fixture(), input = intake();
  await f.controller.receiveRights({}, input); await f.controller.receiveRights({}, input);
  assert.equal(f.duties.length, 1);
  assert.match(f.duties[0].sql, /'correction-request'.*'received'/s);
  const received = JSON.parse(f.duties[0].values[1]);
  assert.deepEqual(received, { requestId: input.requestId, recordIds: input.recordIds, receivedAt: input.receivedAt,
    responseDueAt: '2026-10-10T15:00:00.000Z', resolution: null });
  await f.controller.decideRights({}, input.requestId); assert.equal(f.duties.length, 1);
  const sent = notice(); await f.controller.notifyRights({}, input.requestId, sent);
  await f.controller.notifyRights({}, input.requestId, sent); assert.equal(f.duties.length, 2);
  assert.match(f.duties[1].sql, /'correction-request'.*'resolved'/s);
  assert.deepEqual(JSON.parse(f.duties[1].values[1]).resolution, { at: sent.notifiedAt, eventId: sent.evidenceId, outcome: 'fulfilled' });
});

test('bad future intake maps to HTTP 400 and creates no receipt or duty', async () => {
  const f = fixture(), { EmrAuditController } = require('./inspection_harness.cjs');
  const Filter = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  await assert.rejects(f.controller.receiveRights({}, { ...intake(), receivedAt: '2099-01-01T00:00:00.000Z' }), error => {
    let status;
    new Filter().catch(error, { switchToHttp: () => ({ getResponse: () => ({ status: s => { status = s; return { json: () => {} }; } }) }) });
    assert.equal(status, 400); return true;
  });
  assert.equal(f.requests.length, 0); assert.equal(f.duties.length, 0);
});

for (const decided of [false, true]) test(`evidenced withdrawal from ${decided ? 'Decided' : 'Received'} closes once and refuses later decisions/notices`, async () => {
  const f = fixture(), input = intake(), withdrawal = { outcome: 'withdrawn', evidenceId: 'SYN-WITHDRAWAL' };
  await f.controller.receiveRights({}, input);
  if (decided) await f.controller.decideRights({}, input.requestId);
  const history = structuredClone(f.requests), duties = structuredClone(f.duties), original = JSON.stringify(f.originals);
  const state = await f.controller.notifyRights({}, input.requestId, withdrawal);
  assert.equal(state.status, 'Withdrawn'); assert.equal(state.notification, null);
  assert.equal(state.withdrawal.evidenceId, withdrawal.evidenceId);
  assert.equal(!!state.decision, decided);
  assert.deepEqual(f.requests.slice(0, history.length), history);
  assert.deepEqual(f.duties.slice(0, duties.length), duties);
  assert.deepEqual(JSON.parse(f.duties.at(-1).values[1]).resolution,
    { at: state.withdrawal.recordedAt, eventId: withdrawal.evidenceId, outcome: 'withdrawn' });
  for (const replay of [() => f.controller.notifyRights({}, input.requestId, withdrawal),
    () => f.controller.receiveRights({}, input), () => f.controller.readRights({}, input.requestId)]) {
    assert.deepEqual(await replay(), state);
    assert.equal(f.records.at(-1).action, 'provide-prepared');
  }
  assert.equal((await f.controller.listRights({})).requests[0].status, 'Withdrawn');
  await assert.rejects(f.controller.decideRights({}, input.requestId), { code: 'RightsRequestWithdrawn' });
  await assert.rejects(f.controller.notifyRights({}, input.requestId, notice()), { code: 'RightsRequestWithdrawn' });
  await assert.rejects(f.controller.notifyRights({}, input.requestId, { ...withdrawal, evidenceId: 'replacement' }), { code: 'RightsRequestConflict' });
  assert.equal(f.requests.length, history.length + 1); assert.equal(f.duties.length, 2);
  assert.equal(JSON.stringify(f.originals), original);
});

test('withdrawal requires evidence, preserves a notified outcome, and does not need readable originals', async () => {
  const f = fixture(), input = intake(); await f.controller.receiveRights({}, input);
  await assert.rejects(f.controller.notifyRights({}, input.requestId, { outcome: 'withdrawn', evidenceId: '' }), { code: 'AuditRequestInvalid' });
  const query = f.tx.$queryRaw;
  f.tx.$queryRaw = async (parts, ...values) => parts.join('?').includes('FROM emr_signing.signed_version') ? [] : query(parts, ...values);
  await assert.rejects(f.controller.decideRights({}, input.requestId), { code: 'VersionListingIncomplete' });
  assert.equal((await f.controller.readRights({}, input.requestId)).status, 'Received');
  assert.equal(f.duties.length, 1); assert.equal(f.requests.length, 1);
  assert.equal((await f.controller.notifyRights({}, input.requestId, { outcome: 'withdrawn', evidenceId: 'E' })).status, 'Withdrawn');
  const other = fixture(); await other.controller.receiveRights({}, input); await other.controller.decideRights({}, input.requestId);
  await other.controller.notifyRights({}, input.requestId, notice());
  await assert.rejects(other.controller.notifyRights({}, input.requestId, { outcome: 'withdrawn', evidenceId: 'E' }), { code: 'RightsRequestConflict' });
  assert.equal((await other.controller.readRights({}, input.requestId)).status, 'Notified');
  assert.equal(other.duties.length, 2);
});

test('list places the earliest notice deadline first regardless of request identifier', async () => {
  const f = fixture();
  await f.controller.receiveRights({}, { ...intake('A-LATER'), receivedAt: '2026-10-02T00:00:00.000Z' });
  await f.controller.receiveRights({}, intake('Z-EARLIER'));
  assert.deepEqual((await f.controller.listRights({})).requests.map(r => r.requestId), ['Z-EARLIER', 'A-LATER']);
});

test('notice cannot predate the decision or claim a future delivery', async () => {
  const f = fixture(), input = intake();
  await f.controller.receiveRights({}, input); await f.controller.decideRights({}, input.requestId);
  for (const notifiedAt of ['2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'])
    await assert.rejects(f.controller.notifyRights({}, input.requestId, { ...notice(), notifiedAt }), { code: 'RightsNoticeTimeInvalid' });
  assert.equal(f.requests.length, 2);
});

test('one mixed clinical/operational unit cannot be decided using only its latest classification', async () => {
  const { applyPlan, planClinicalWrite } = require('../../../api/src/emr-clinical/records.ts');
  const { clinicalSigningContent } = require('../../../api/src/emr-clinical/signing.ts');
  const { generateServerKeyPair, signServerPayload } = require('../../../api/src/emr-signature/server-crypto.ts');
  const { actor, patient } = require('./rights_harness.cjs');
  const { randomUUID } = require('node:crypto');
  const f = fixture(), keys = generateServerKeyPair();
  const input = { ...intake('SYN-BEFORE-MIX'), recordIds: ['SYN-NOTE'] };
  await f.controller.receiveRights({}, input);
  const plan = planClinicalWrite({ surface: 'tech-note.write', actor: { identity: actor, kind: 'member', roles: ['technician'],
    institutionId: 'SYN-SITE', signingRegistrationId: 'SYN-TECH' }, study: { studyId: 'SYN-STUDY', patient, managingInstitutionId: 'SYN-SITE' },
    unit: applyPlan(null, f.operational), body: { baseVersion: 1, text: '합성 촬영 기록', reason: '촬영 추가', attemptId: randomUUID() },
    content: null, attachments: [], navigation: [], recipientId: null, readerId: null, workContext: null,
    ids: { recordId: 'SYN-NOTE', versionId: randomUUID() }, at: new Date().toISOString() });
  const signed = signServerPayload(clinicalSigningContent(plan.signing), 'SYN-TECH-KEY', keys.privateKey);
  const signature = { ...signed, payloadSha256: signed.versionSha256, registration: { kid: 'SYN-TECH-KEY', publicKey: keys.publicKey,
    doctor: { identity: actor, identityRegistrationId: 'SYN-TECH', institutionId: 'SYN-SITE', canSign: true },
    registeredAt: '2026-01-01T00:00:00.000Z', status: 'active', endedAt: null } };
  f.clinicalRows.push({ body: JSON.stringify(plan), signature: JSON.stringify(signature) });
  await assert.rejects(f.controller.receiveRights({}, { ...intake(), recordIds: ['SYN-NOTE'] }), { code: 'RightsRecordAmbiguous' });
  await assert.rejects(f.controller.decideRights({}, input.requestId), { code: 'RightsRecordAmbiguous' });
  assert.equal((await f.controller.readRights({}, input.requestId)).status, 'Received');
  assert.equal(f.requests.length, 1); assert.equal(f.duties.length, 1);
  assert.equal((await f.controller.notifyRights({}, input.requestId, { outcome: 'withdrawn', evidenceId: 'SYN-MIX-WITHDRAWAL' })).status, 'Withdrawn');
  assert.equal(f.duties.length, 2);
});
