/* REQ-EMR-15/19 -> RISK-F-05 -> TEST-F-INSPECTION-WIRING.
 * Real controller/service/contract with synthetic storage and request context.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, actor, F, EmrAuditController } = require('./inspection_harness.cjs');
const { createHash } = require('node:crypto');

test('preview, start and reopen record each shown event and patient, including local observations', async () => {
  const f = fixture(), known = value => ({ status: 'known', value });
  const none = { status: 'not-applicable', reason: 'non-record-target' };
  const patient = id => ({ kind: 'report-head', patientLinkSnapshot: known({ linkId: `LINK-${id}`, patientId: id, assigningAuthority: 'SYN-SITE' }),
    studyId: known('SYN-STUDY'), recordId: known('SYN-REPORT'), versionId: none });
  const local = { kind: 'access-audit', sourcePatientId: { status: 'unresolved', reason: 'not-observed' },
    sourceInstitution: known('SYN-SITE'), studyId: known('LOCAL-STUDY'), recordId: known('LOCAL-RECORD'), versionId: none };
  f.events[0].targets = [patient('P1'), patient('P2'), patient('P1'), local];
  f.events[0].targets[2].patientLinkSnapshot.value.linkId = 'ANOTHER-LINK-P1';
  const expected = [
    { kind: 'access-audit', patientLinkSnapshot: none, studyId: none, recordId: known('inspection:2026-10'), versionId: none },
    ...[patient('P1'), patient('P2'), local].map(t => ({ ...t, kind: 'access-audit', recordId: known('SYN-0'), versionId: known('SYN-0') })),
    { kind: 'access-audit', patientLinkSnapshot: none, studyId: none, recordId: known('SYN-1'), versionId: known('SYN-1') },
  ];
  for (const method of ['inspection', 'inspectionReport', 'inspection']) {
    const before = f.records.length;
    await f.controller[method]({}, '2026-10');
    const accesses = f.records.slice(before).filter(e => e.action === 'provide-prepared');
    assert.deepEqual(accesses.flatMap(e => e.targets), expected);
  }
});

test('inspection operations translate transaction and statement timeouts to HTTP 503 without hiding other failures', async () => {
  const filterType = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  for (const method of ['inspectionMonths', 'inspection', 'inspectionReport', 'inspectionStep']) {
    for (const error of [{ code: 'P2028' }, { meta: { code: '57014' } }, { code: '57014' }]) {
      const f = fixture();
      f.tx.$queryRaw = async () => { throw error; };
      await assert.rejects(f.controller[method]({}, '2026-10', {}), failure => {
        assert.equal(failure.code, 'InvestigationTimedOut');
        let status, body;
        new filterType().catch(failure, { switchToHttp: () => ({ getResponse: () => ({
          status: s => { status = s; return { json: b => { body = b; } }; },
        }) }) });
        assert.equal(status, 503); assert.equal(body.code, 'InvestigationTimedOut');
        return true;
      });
      assert.equal(f.storage.length, 0);
    }
    const f = fixture(), failure = new Error('storage unavailable');
    f.tx.$queryRaw = async () => { throw failure; };
    await assert.rejects(f.controller[method]({}, '2026-10', {}), error => error === failure);
  }
});
test('ended Seoul months, report at start, immutable snapshot on reopen and append-only steps', async () => {
  const f = fixture();
  const list = await f.controller.inspectionMonths({});
  assert.deepEqual(list.period, F.INSPECTION_PERIOD);
  assert.ok(list.months.some(m => m.month === '2026-09'));
  assert.ok(list.months.every(m => m.month < F.inspectionMonth(new Date().toISOString())));
  const preview = await f.controller.inspection({}, '2026-10');
  assert.equal(preview.cycle, null);
  assert.equal(f.storage.length, 0);
  const started = await f.controller.inspectionReport({}, '2026-10');
  assert.equal(started.summary.eventCount, 3);
  assert.deepEqual(started.downloads.map(e => e.eventId), ['SYN-0', 'SYN-1']);
  const report = started.cycle.events[0];
  assert.equal(report.reportSha256, createHash('sha256').update(JSON.stringify(started.summary)).digest('hex'));
  assert.equal(report.eventCount, 3);
  assert.equal(started.summary.from, '2026-09-30T15:00:00.000Z');
  assert.equal(started.summary.to, '2026-10-31T15:00:00.000Z');
  const original = f.storage[0].detail;
  f.events.push({ ...f.events[0], eventId: 'LATE' });
  assert.deepEqual(await f.controller.inspectionReport({}, '2026-10'), started, 'retry must recover the original report');
  assert.deepEqual(await f.controller.inspection({}, '2026-10'), started);
  const step = await f.controller.inspectionStep({}, '2026-10', { kind: 'download-check', eventId: 'SYN-0',
    reason: '진료 사본 요청 확인', outcome: 'legitimate', followUp: '추가 조치 없음' });
  assert.deepEqual(Object.keys(step).sort(), ['cycle', 'status']);
  assert.equal(step.cycle.events.at(-1).kind, 'download-reason');
  assert.match(step.cycle.events.at(-1).reason, /추가 조치 없음/);
  assert.deepEqual(step.cycle.events.at(-1).by, actor);
  assert.equal(f.storage[0].detail, original);
  assert.equal(f.storage.length, 2);
  assert.deepEqual(JSON.parse(f.storage[1].detail), { cycle: step.cycle }, 'steps retain only the evolving cycle, not another copy of patient downloads');
  assert.equal(step.cycle.events[0].reportSha256, report.reportSha256);
  const reopened = fixture(['inspection'], 'SYN-SITE', f.storage);
  assert.deepEqual(await reopened.controller.inspection({}, '2026-10'), { ...started, ...step });
});
test('API-only designated auditor receives no patient downloads when recording a step without opening the month', async () => {
  const starter = fixture(), known = value => ({ status: 'known', value });
  starter.events[0].targets = [{ kind: 'report-head',
    patientLinkSnapshot: known({ linkId: 'PRIVATE-LINK', patientId: 'PRIVATE-PATIENT', assigningAuthority: 'PRIVATE-AUTHORITY' }),
    studyId: known('PRIVATE-STUDY'), recordId: known('PRIVATE-REPORT'), versionId: known('PRIVATE-VERSION') }];
  await starter.controller.inspectionReport({}, '2026-10');
  const otherActor = { id: 'second-auditor', issuer: 'synthetic', subject: 'second-auditor' };
  const auditor = fixture(['inspection'], 'SYN-SITE', starter.storage, otherActor);
  const answer = await auditor.controller.inspectionStep({}, '2026-10', {
    kind: 'download-check', eventId: 'SYN-0', reason: '사유 확인', outcome: 'legitimate', followUp: '없음' });
  assert.deepEqual(Object.keys(answer).sort(), ['cycle', 'status']);
  assert.equal(answer.cycle.events.at(-1).kind, 'download-reason');
  assert.deepEqual(answer.cycle.events.at(-1).by, otherActor);
  assert.equal(answer.status.state, 'report-only');
  assert.doesNotMatch(JSON.stringify(answer), /PRIVATE-/);
  assert.equal(auditor.reads.length, 0);
  assert.deepEqual(auditor.records.map(e => e.action), ['write']);
});

test('follow-up uses contract investigations/actions and human review; Finish needs no write endpoint', async () => {
  const f = fixture();
  await assert.rejects(f.controller.inspectionStep({}, '2026-10', { kind: 'reviewed', conclusion: 'no-anomaly', note: '확인' }), { code: 'InspectionReportRequired' });
  await f.controller.inspectionReport({}, '2026-10');
  let state = await f.controller.inspectionStep({}, '2026-10', { kind: 'download-check', eventId: 'SYN-0', reason: '확인 필요', outcome: 'investigate', followUp: '담당자 확인 요청' });
  assert.deepEqual(state.cycle.events.slice(1).map(e => e.kind), ['investigation-opened', 'download-reason', 'action-recorded']);
  const investigationId = state.status.openInvestigations[0];
  state = await f.controller.inspectionStep({}, '2026-10', { kind: 'rechecked', investigationId, result: 'resolved', note: '확인 완료' });
  assert.deepEqual(state.status.openInvestigations, []);
  await f.controller.inspectionStep({}, '2026-10', { kind: 'download-check', eventId: 'SYN-1', reason: '확인', outcome: 'legitimate', followUp: '없음' });
  state = await f.controller.inspectionStep({}, '2026-10', { kind: 'reviewed', conclusion: 'no-anomaly', note: '월간 기록 확인 완료' });
  assert.equal(state.status.state, 'ready-to-close');
  assert.ok(!(await f.controller.inspectionMonths({})).months.some(m => m.month === '2026-10'));
});
test('all routes enforce designation and separate inspection scope; HTTP filter returns 403', async () => {
  const filterType = Reflect.getMetadata('__exceptionFilters__', EmrAuditController)[0];
  for (const [scopes, code] of [[[], 'AuditorNotDesignated'], [['investigate'], 'AuditScopeNotGranted']]) {
    const f = fixture(scopes);
    for (const call of [() => f.controller.inspectionMonths({}), () => f.controller.inspection({}, '2026-10'),
      () => f.controller.inspectionReport({}, '2026-10'), () => f.controller.inspectionStep({}, '2026-10', {})]) {
      await assert.rejects(call(), { code });
    }
    assert.equal(f.reads.length, 0); assert.equal(f.storage.length, 0);
    let status, body;
    new filterType().catch({ code }, { switchToHttp: () => ({ getResponse: () => ({
      status: s => { status = s; return { json: b => { body = b; } }; },
    }) }) });
    assert.equal(status, 403); assert.equal(body.code, code);
  }
});
test('tenant isolation, invalid month and forged actor/time are refused without new rows', async () => {
  const f = fixture();
  await f.controller.inspectionReport({}, '2026-10');
  const other = fixture(['inspection'], 'OTHER-SITE', f.storage);
  assert.equal((await other.controller.inspection({}, '2026-10')).cycle, null);
  for (const month of ['2026-13', '2026-1', '9999-12']) await assert.rejects(f.controller.inspectionReport({}, month));
  for (const extra of [{ by: actor }, { at: '2026-01-01T00:00:00.000Z' }, { kind: 'closed' }]) {
    await assert.rejects(f.controller.inspectionStep({}, '2026-10', { kind: 'reviewed', conclusion: 'no-anomaly', note: '확인', ...extra }));
  }
  assert.equal(f.storage.length, 1);
});
test('clinician-only designated auditors reach the same inspection authority gate', () => {
  const { clinicianRouteAllowed } = require('../../../api/src/clinician-policy.ts');
  for (const route of ['GET emr-audit/inspections', 'GET emr-audit/inspections/:month',
    'POST emr-audit/inspections/:month/report', 'POST emr-audit/inspections/:month/steps']) {
    assert.equal(clinicianRouteAllowed(route), true, route);
  }
  assert.equal(clinicianRouteAllowed('DELETE emr-audit/inspections/:month'), false);
});
