/* REQ-EMR-15/19 -> RISK-F-07 -> TEST-F-INCIDENT. Contract-owned response obligations and actual admission. */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, intake, notice, exemption, delay } = require('./incident_harness.cjs');
const forms = ['possibility', 'confirmed', 'not-a-leak', 'report', 'medical', 'network'];
test('a later auditor never becomes the author of the registration scope finding', async () => {
  const first = fixture(), input = intake();
  await first.controller.registerIncident({}, input);
  const reader = { id: 'second-auditor', issuer: 'synthetic', subject: 'second' };
  const second = fixture(undefined, undefined, reader); second.requests.push(...structuredClone(first.requests));
  const old = await second.controller.readIncident({}, input.incidentId);
  assert.equal(old.scope.reasons.find(r => r.kind === 'access-outside-ledger').by.id, 'synthetic-auditor');
  const result = await second.controller.incidentNotice({}, input.incidentId, notice(old.plan.obligations[0]));
  assert.equal(result.history.at(-1).by.id, 'second-auditor');
  assert.equal(result.scope.reasons.find(r => r.kind === 'access-outside-ledger').by.id, 'synthetic-auditor');
  assert.equal(result.plan.ledger.findings[0].by.id, 'synthetic-auditor');
});
test('register, full scope, six draft downloads, deadline, replay and exact disclosed targets', async () => {
  const f = fixture(), input = intake();
  let r = await f.controller.registerIncident({}, input);
  assert.equal(r.incidentType, 'cvr-misdelivery'); assert.equal(r.scope.subjectsIdentifiable, false);
  assert.equal(r.scope.identified[0].patient.patientId, 'SYN-PATIENT');
  assert.equal(r.plan.obligations[0].dueAt, '2026-11-04T00:00:00.000Z');
  const first = JSON.stringify(f.requests);
  await f.controller.registerIncident({}, input); assert.equal(JSON.stringify(f.requests), first);
  for (const form of forms) {
    const draft = await f.controller.incidentDraft({}, input.incidentId, form);
    assert.equal(draft.status, 'Draft'); assert.match(draft.wording, /P5/); assert.equal(draft.cloud, '조건부 (#69)');
    if (draft.obligations.length) assert.deepEqual(draft.basis, [...new Set(draft.obligations.flatMap(o => o.basis))]);
    else { assert.deepEqual(draft.basis, []); assert.equal(draft.applicabilityNote, '현재 계약 결과에 이 서식의 의무가 없습니다(조회 사실만 포함)'); }
    assert.equal(f.records.at(-1).action, 'download');
    assert.ok(f.records.at(-1).targets.some(t => t.patientLinkSnapshot?.value?.patientId === 'SYN-PATIENT'));
  }
  const list = await f.controller.listIncidents({}); assert.equal(list.incidents.length, 1);
  assert.ok(f.records.at(-1).targets.every(t => t.patientLinkSnapshot.status === 'not-applicable'));
  assert.equal((await f.controller.readIncident({}, input.incidentId)).scope.identified.length, 1);
});

test('report exemption is an evidenced human decision, survives reload and permits honest closure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T03:00:00Z') });
  const f = fixture(), input = intake('EXEMPT', 'confirmed'); input.facts.reportTriggers = ['sensitive-or-unique'];
  let r = await f.controller.registerIncident({}, input);
  const decision = exemption(r.plan.obligations.find(o => o.family === 'report'));
  decision.decision.by = { id: 'forged', issuer: 'forged', subject: 'forged' };
  decision.decision.decider = { ...decision.decision.decider, by: decision.decision.by, ownerId: 'FOREIGN', status: 'representative', evidenceId: 'FORGED' };
  for (const patch of [{ basis: 'invented' }, { category: 'invented' }, { stillOwed: true },
    { obligationKey: r.plan.obligations.find(o => o.family === 'confirmed').obligationKey }, { at: '2099-01-01T00:00:00.000Z' }]) {
    await assert.rejects(f.controller.incidentFinding({}, input.incidentId, { ...decision, decision: { ...decision.decision, ...patch } }), { code: 'IncidentResponseRefused' });
  }
  const prior = JSON.stringify(f.requests), grantor = f.grantor; f.grantor = null;
  await assert.rejects(f.controller.incidentFinding({}, input.incidentId, decision), { code: 'AuditorDesignationAuthorityRequired' });
  assert.equal(JSON.stringify(f.requests), prior); f.grantor = grantor;
  r = await f.controller.incidentFinding({}, input.incidentId, decision);
  const d = r.plan.ledger.decisions[0];
  assert.equal(d.by.id, 'synthetic-auditor'); assert.equal(d.decider.by.id, d.by.id);
  assert.equal(d.decider.ownerId, 'SYN-SITE'); assert.equal(d.decider.status, 'verified-privacy-officer');
  assert.equal(d.decider.evidenceId, 'SYN-DESIGNATION');
  assert.equal(r.plan.obligations.find(o => o.family === 'report').status, 'exempt');
  await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
  for (const o of r.plan.obligations.filter(o => o.stillOwed)) await f.controller.incidentNotice({}, input.incidentId, notice(o, o.kind));
  r = await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }); assert.equal(r.status, 'Closed');
  const saved = JSON.stringify(f.requests);
  await f.controller.incidentFinding({}, input.incidentId, decision); assert.equal(JSON.stringify(f.requests), saved);
  const reopened = await f.controller.readIncident({}, input.incidentId);
  assert.equal(reopened.plan.obligations.find(o => o.family === 'report').closureGround, 'report-exemption');
  assert.deepEqual(reopened.history[1].decisions, [d]);
});

test('accepted and pending delay preserve the original deadline and causal evidence across replay', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T03:00:00Z') });
  const f = fixture(); let r = await f.controller.registerIncident({}, intake());
  const o = r.plan.obligations[0], accepted = delay(o), pending = structuredClone(accepted);
  pending.operationId = pending.delay.delayId = 'PENDING'; pending.delay.accepted = false; pending.delay.decisionId = null;
  delete pending.delay.decider; delete pending.delay.causalReview;
  r = await f.controller.incidentFinding({}, r.incidentId, pending);
  assert.equal(r.plan.obligations[0].dueAt, o.dueAt); assert.equal(r.plan.obligations[0].status, 'overdue');
  for (const patch of [{ clause: 'wrong' }, { category: 'urgent-containment' }, { causalReview: undefined }])
    await assert.rejects(f.controller.incidentFinding({}, r.incidentId, { ...accepted, delay: { ...accepted.delay, ...patch } }), { code: 'IncidentResponseRefused' });
  r = await f.controller.incidentFinding({}, r.incidentId, accepted);
  assert.equal(r.plan.obligations[0].originalDueAt, o.originalDueAt);
  assert.equal(r.plan.obligations[0].timing, 'deferred-until-cause-cleared'); assert.equal(r.plan.obligations[0].dueAt, null);
  assert.equal(r.plan.ledger.delays.find(d => d.delayId === accepted.delay.delayId).by.id, 'synthetic-auditor');
  const saved = JSON.stringify(f.requests); await f.controller.incidentFinding({}, r.incidentId, accepted);
  assert.equal(JSON.stringify(f.requests), saved);
  assert.deepEqual((await f.controller.readIncident({}, r.incidentId)).plan.ledger.delays, r.plan.ledger.delays);
});

test('superseded closure keeps old verdict, scope and drafts; targets must be existing same-site open incidents', async () => {
  const f = fixture(), old = await f.controller.registerIncident({}, intake('OLD'));
  await f.controller.registerIncident({}, intake('NEW'));
  const foreign = fixture(undefined, 'FOREIGN'); await foreign.controller.registerIncident({}, intake('FOREIGN'));
  f.requests.push(...foreign.requests);
  await f.controller.registerIncident({}, intake('CLOSED', 'not-a-leak'));
  await f.controller.closeIncident({}, 'CLOSED', { evidenceId: 'closed' });
  for (const [target, code] of [['OLD', 'IncidentConflict'], ['MISSING', 'IncidentNotFound'], ['FOREIGN', 'IncidentNotFound'], ['CLOSED', 'IncidentClosed']]) {
    const saved = JSON.stringify(f.requests);
    await assert.rejects(f.controller.closeIncident({}, 'OLD', { evidenceId: 'mistake', supersededBy: target }), { code });
    assert.equal(JSON.stringify(f.requests), saved);
  }
  const closure = { evidenceId: 'mistake', supersededBy: 'NEW' };
  let r = await f.controller.closeIncident({}, 'OLD', closure);
  assert.equal(r.status, 'Closed'); assert.equal(r.closed.supersededBy, 'NEW'); assert.equal(r.plan.verdict, 'possible');
  assert.deepEqual(r.scope, old.scope); assert.equal(r.history.length, 1);
  await assert.rejects(f.controller.closeIncident({}, 'NEW', { evidenceId: 'cycle', supersededBy: 'OLD' }), { code: 'IncidentClosed' });
  for (const changed of [{ evidenceId: 'mistake' }, { ...closure, evidenceId: 'changed' }, { ...closure, supersededBy: 'MISSING' }])
    await assert.rejects(f.controller.closeIncident({}, 'OLD', changed), { code: 'IncidentConflict' });
  await f.controller.registerIncident({}, intake('NEXT'));
  await f.controller.closeIncident({}, 'NEW', { evidenceId: 'next', supersededBy: 'NEXT' });
  await assert.rejects(f.controller.closeIncident({}, 'NEXT', { evidenceId: 'long-cycle', supersededBy: 'OLD' }), { code: 'IncidentClosed' });
  const saved = JSON.stringify(f.requests); await f.controller.closeIncident({}, 'OLD', closure);
  assert.equal(JSON.stringify(f.requests), saved);
  assert.equal((await f.controller.listIncidents({})).incidents.find(i => i.incidentId === 'OLD').supersededBy, 'NEW');
  r = await f.controller.readIncident({}, 'OLD'); assert.deepEqual(r.scope, old.scope);
  for (const form of forms) { const d = await f.controller.incidentDraft({}, 'OLD', form); assert.deepEqual(d.scope, old.scope); assert.equal(d.verdict, 'possible'); }
});
test('possible notice then confirmed preserves actual evidence and closes only after every owed notice', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T01:00:00Z') });
  const f = fixture(), input = intake(); let r = await f.controller.registerIncident({}, input);
  t.mock.timers.setTime(Date.parse('2026-11-01T03:00:00Z'));
  const sent = notice(r.plan.obligations[0]); r = await f.controller.incidentNotice({}, input.incidentId, sent);
  assert.equal(r.plan.obligations[0].status, 'met');
  const finding = { operationId: 'confirm', facts: { ...input.facts, status: 'confirmed', possibleGround: null,
    determinationAt: '2026-11-01T02:00:00.000Z', evidenceId: 'SYN-CONFIRMED', verdictId: 'confirmed-1' } };
  r = await f.controller.incidentFinding({}, input.incidentId, finding);
  assert.equal(r.plan.verdict, 'confirmed'); assert.equal(r.history.length, 3);
  await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
  for (const o of r.plan.obligations.filter(o => o.stillOwed)) await f.controller.incidentNotice({}, input.incidentId, notice(o, o.kind));
  r = await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }); assert.equal(r.status, 'Closed');
  const stored = JSON.stringify(f.requests);
  await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' });
  await f.controller.incidentFinding({}, input.incidentId, finding);
  await f.controller.incidentNotice({}, input.incidentId, sent);
  assert.equal(JSON.stringify(f.requests), stored);
  await assert.rejects(f.controller.incidentFinding({}, input.incidentId, { ...finding, operationId: 'new' }), { code: 'IncidentClosed' });
  await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'other' }), { code: 'IncidentConflict' });
  assert.equal(f.requests[0].body.steps.length, 1);
});
test('no-leak closure retains prior notice and requires the contract no-leak followup', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T03:00:00Z') });
  for (const notified of [false, true]) {
    const f = fixture(), input = intake(); let r = await f.controller.registerIncident({}, input);
    if (notified) r = await f.controller.incidentNotice({}, input.incidentId, notice(r.plan.obligations[0]));
    r = await f.controller.incidentFinding({}, input.incidentId, { operationId: 'no-leak', facts: { ...input.facts,
      status: 'not-a-leak', possibleGround: null, determinationAt: '2026-11-01T02:30:00.000Z', evidenceId: 'SYN-NO-LEAK' } });
    if (notified) {
      await assert.rejects(f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }), { code: 'IncidentDutiesOpen' });
      const o = r.plan.obligations.find(o => o.kind === 'not-a-leak');
      const n = notice(o, 'no-leak-notice'); n.notice.sentAt = '2026-11-01T02:45:00.000Z';
      r = await f.controller.incidentNotice({}, input.incidentId, n);
      assert.equal(r.plan.ledger.notices.length, 2);
    }
    r = await f.controller.closeIncident({}, input.incidentId, { evidenceId: 'close' }); assert.equal(r.status, 'Closed');
    assert.equal(r.plan.verdict, 'not-a-leak');
  }
});
test('unreadable and locally identified sources stay explicitly unidentifiable, not zero affected', async () => {
  const broken = fixture(); broken.events[0].surface = 'invalid';
  const r = await broken.controller.registerIncident({}, intake());
  assert.equal(r.scope.subjectsIdentifiable, false); assert.ok(r.scope.reasons.some(r => r.kind === 'ledger-unreadable'));
  assert.equal((await broken.controller.readIncident({}, 'SYN-INCIDENT')).scope.subjectsIdentifiable, false);
  const local = fixture(), event = local.events[0], target = event.targets[0];
  event.surface = 'POST emr-audit/investigations';
  event.targets = [{ kind: 'access-audit', studyId: target.studyId, recordId: target.recordId, versionId: target.versionId,
    sourcePatientId: { status: 'known', value: 'LOCAL-PATIENT' }, sourceInstitution: { status: 'known', value: 'SYN-SITE' } }];
  const input = intake(); input.determinations = [];
  const result = await local.controller.registerIncident({}, input);
  assert.equal(result.scope.subjectsIdentifiable, false); assert.equal(result.scope.identifiedLocally.length, 1);
  assert.ok(local.records.at(-1).targets.some(t => t.sourcePatientId?.value === 'LOCAL-PATIENT'));
  for (const form of forms) await local.controller.incidentDraft({}, input.incidentId, form);
});
test('numeric overdue, immediate MOHW, ISP provisional and confirmed clocks come from F', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T00:00:00Z') });
  const f = fixture(), input = intake('CLOCKS', 'confirmed');
  input.facts.reportTriggers = ['sensitive-or-unique'];
  input.facts.medicalIncident = { occurredAt: '2026-10-31T00:00:00.000Z', discoveredAt: input.facts.awarenessAt, electronicIntrusion: true, type: 'theft-leak' };
  input.facts.ispIncident = { eventId: 'attack', attackCaused: true, status: 'unknown',
    occurrence: { occurredAt: '2026-10-31T00:00:00.000Z', endedAt: null, evidenceId: 'occurrence' } };
  let r = await f.controller.registerIncident({}, input);
  assert.equal(r.plan.obligations.find(o => o.kind === 'confirmed-leak').status, 'overdue');
  assert.equal(r.plan.obligations.find(o => o.kind === 'mohw-notice').dueAt, null);
  assert.equal(r.plan.ispAssessments[0].initialReport.provisionalResponseDueAt, '2026-11-02T00:00:00.000Z');
  const fact = { ...input.facts, evidenceId: 'verified', determinationAt: '2026-11-01T01:00:00.000Z',
    ispIncident: { ...input.facts.ispIncident, status: true, verification: { by: { id: 'spoof', issuer: 'spoof', subject: 'spoof' },
      at: '2026-11-01T01:00:00.000Z', evidenceId: 'types', types: { telecomBusiness: true, forProfitTelecomInformation: false } } } };
  r = await f.controller.incidentFinding({}, input.incidentId, { operationId: 'verify', facts: fact });
  assert.equal(r.history.at(-1).facts.ispIncident.verification.by.id, 'synthetic-auditor');
  assert.equal(r.plan.obligations.find(o => o.kind === 'isp-incident-report').dueAt, '2026-11-02T00:00:00.000Z');
  const o = r.plan.obligations.find(o => o.kind === 'confirmed-leak'), sent = notice(o);
  sent.notice.sentAt = '2026-11-09T00:00:00.000Z';
  r = await f.controller.incidentNotice({}, input.incidentId, sent);
  assert.equal(r.plan.obligations.find(o => o.kind === 'confirmed-leak').status, 'met');
  assert.ok(r.plan.obligations.find(o => o.kind === 'confirmed-leak').lateByMs > 0);
});
test('all routes require both scopes and tenant ownership; malformed, conflict and future inputs refuse', async () => {
  const methods = [['registerIncident',[intake()]], ['listIncidents',[]], ['readIncident',['x']], ['incidentFinding',['x',{}]],
    ['incidentNotice',['x',{}]], ['closeIncident',['x',{}]], ['incidentDraft',['x','possibility']]];
  for (const scopes of [[], ['investigate'], ['export'], ['inspection']]) {
    const f = fixture(scopes);
    for (const [method, args] of methods) await assert.rejects(f.controller[method]({}, ...args), { code: scopes.length ? 'AuditScopeNotGranted' : 'AuditorNotDesignated' });
    assert.equal(f.records.length, 0); assert.equal(f.requests.length, 0);
  }
  const f = fixture(); await f.controller.registerIncident({}, intake());
  const foreign = fixture(undefined, 'OTHER'); foreign.requests.push(...f.requests);
  assert.deepEqual((await foreign.controller.listIncidents({})).incidents, []);
  await assert.rejects(foreign.controller.readIncident({}, 'SYN-INCIDENT'), { code: 'IncidentNotFound' });
  await assert.rejects(f.controller.registerIncident({}, { ...intake(), incidentType: 'other' }), { code: 'IncidentConflict' });
  await assert.rejects(f.controller.incidentDraft({}, 'SYN-INCIDENT', 'invented'), { code: 'AuditRequestInvalid' });
  const future = intake('FUTURE'); future.facts.determinationAt = '2099-01-01T00:00:00.000Z';
  await assert.rejects(f.controller.registerIncident({}, future), { code: 'IncidentResponseRefused' });
});
test('incident parser exceptions do not waive clinical targets, unresolved patients or other surfaces', async () => {
  const { parseAccessEvent } = require('../../../api/src/emr-contract/access-event.ts');
  const f = fixture(); await f.controller.registerIncident({}, intake());
  const event = structuredClone(f.records[0]);
  assert.throws(() => parseAccessEvent({ ...event, surface: 'GET studies/:uid/report/versions' }));
  const noId = structuredClone(event); noId.targets[0].recordId = { status: 'unresolved', reason: 'not-resolved' };
  assert.throws(() => parseAccessEvent(noId));
  const noPatient = structuredClone(event); noPatient.targets[1].patientLinkSnapshot = { status: 'unresolved', reason: 'not-resolved' };
  assert.throws(() => parseAccessEvent(noPatient));
  const wrongKind = structuredClone(event); wrongKind.targets[0].kind = 'report-version';
  assert.throws(() => parseAccessEvent(wrongKind));
  const v2 = { ...event, formatVersion: 2, branch: 'local-read' };
  assert.throws(() => parseAccessEvent(v2));
});
