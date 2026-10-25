'use strict';
// REQ-A-TARGET / REQ-A-OUTCOME: selected projection, local attribution and
// response observations. The PG mode exercises B2's real accepted role/port;
// neither mode claims A2/A3 route or renderer acceptance.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');
const root = path.resolve(__dirname, '../../..');
const build = process.env.KIN_B2R_BUILD;
const apiRequire = createRequire(build ? path.join(build, '../package.json') : path.join(root, 'api/package.json'));
if (!build) {
  const ts = apiRequire('typescript');
  const config = ts.readConfigFile(path.join(root, 'api/tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, 'api')).options;
  require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'),
    { compilerOptions: options, fileName: file }).outputText, file);
}
const load = file => require(path.join(build || path.join(root, 'api/src'), file + (build ? '.js' : '.ts')));
const { LocalReadResponse, localReadEvents, localReadFollowup } = load('emr-viewing/local-read');
const { observeLocalReadResponse } = load('emr-viewing/response-lifecycle');
const { parseAccessEvent, accessStreams } = load('emr-contract/access-event');
const { recordTargets } = load('emr-runtime/contract');
const audit = load('emr-audit/contract');
// Paces the PG polling loops below; the run's hang timeout is their only bound.
const pause = () => require('node:timers/promises').setTimeout(20);
const known = value => ({ status: 'known', value });
const unknown = { status: 'unresolved', reason: 'not-observed' };
const actor = { id: randomUUID(), issuer: 'https://synthetic.invalid', subject: 'doctor-a' };
const facts = {
  issuer: actor.issuer, subject: actor.subject, actor, roles: ['radiologist'], rightsVersion: 3,
  institution: 'synthetic-site', binding: { method: 'session', sessionRef: 'authref:' + randomUUID() },
  requestId: randomUUID(), ingress: known({ address: '192.0.2.12', source: 'trusted-proxy' }),
  surface: 'GET studies/:uid/report/versions',
};
const source = (overrides = {}) => ({
  eventId: randomUUID(), managingInstitution: 'synthetic-site', cause: 'user-view', path: [0],
  target: { kind: 'report-version', studyId: known('study-a'), recordId: known('stored-row-a'),
    versionId: known('version-2'), sourcePatientId: known('synthetic-patient-a'), sourceInstitution: unknown },
  ...overrides,
});
const body = () => [{ id: 'stored-row-a', version: 2, findings: 'synthetic report' }];
const prepared = () => localReadEvents(facts, new LocalReadResponse(body(), [source()]))[0];

function authority(scopes = ['investigate'], institutionId = facts.institution) {
  const at = new Date().toISOString();
  return audit.resolveAuditAuthority({ listGrants: subject => ({ subject, complete: true, grants: [{
    grantId: 'synthetic-grant', subject, institutionId, events: [{
      kind: 'granted', eventId: 'synthetic-grant-event', at, by: actor, capacity: 'privacy-officer',
      basisDocumentId: 'synthetic-designation', scopes, validFrom: at, validUntil: null,
    }],
  }] }) }, { identity: actor, institutionId, roles: ['radiologist'] }, at);
}
const period = { from: '2020-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };
const ledgerOf = rows => ({
  top: async () => rows.length ? Math.max(...rows.map(r => r.entry.sequence)) : 0,
  rows: async (top, below, take) => rows.filter(r => r.entry.sequence <= top && (below === null || r.entry.sequence < below))
    .sort((a, b) => b.entry.sequence - a.entry.sequence).slice(0, take),
});
async function replay(rows, filter) {
  return audit.readInvestigationPage(audit.planInvestigation(authority(), { ...period, ...filter }), ledgerOf(rows));
}
// Three local reads in one institution: patient a in two studies, and a study whose PatientID was not observed.
function localSubjects(institution) {
  const read = (sourcePatientId, studyId) => localReadEvents({ ...facts, institution }, new LocalReadResponse(body(), [source({
    managingInstitution: institution, target: { ...source().target, studyId: known(studyId), sourcePatientId } })]))[0];
  return [read(known('synthetic-patient-a'), 'study-a'), read(known('synthetic-patient-a'), 'study-c'), read(unknown, 'study-b')];
}
// A-AUDIT-LOCAL: the incident scope and the auditor's own access event of locally identified subjects.
async function checkLocalIncident(ledger, events, institution) {
  const auditor = authority(['investigate', 'export'], institution);
  const scope = await audit.incidentScope(auditor, audit.planInvestigation(auditor, period, 'export'), ledger);
  assert.equal(scope.subjectsIdentifiable, false, 'local-only subjects are not formally identified');
  assert.deepEqual(scope.reasons, [{ kind: 'identified-locally', subjects: 2 }]);
  assert.deepEqual(scope.identified, []);
  const [a1, a2, b] = events;
  assert.deepEqual(scope.identifiedLocally.map(g => [g.source.sourcePatientId, [...g.studyIds].sort(), [...g.eventIds].sort()]), [
    [known('synthetic-patient-a'), ['study-a', 'study-c'], [a1.eventId, a2.eventId].sort()],
    [unknown, ['study-b'], [b.eventId]],
  ]);
  assert.deepEqual(scope.identifiedLocally[0].source.sourceInstitution, unknown);
  assert.equal(scope.auditEvent.action, 'download');
  assert.deepEqual(scope.auditEvent.targets.map(t => [t.kind, t.recordId.value, t.studyId.value, t.sourcePatientId]).sort(),
    [['access-audit', a1.eventId, 'study-a', known('synthetic-patient-a')], ['access-audit', a2.eventId, 'study-c', known('synthetic-patient-a')],
      ['access-audit', b.eventId, 'study-b', unknown]].sort());
  assert.ok(scope.auditEvent.targets.every(t => !('patientLinkSnapshot' in t)), 'no formal PatientLink placeholder');
  // The export read the scope is built on shows the same observed identifiers.
  const exported = await audit.readInvestigationPage(audit.planInvestigation(auditor, period, 'export'), ledger);
  assert.deepEqual(exported.rows.map(r => r.targets[0].localSource.sourcePatientId).filter(f => f.status === 'known').map(f => f.value),
    ['synthetic-patient-a', 'synthetic-patient-a']);
  assert.ok(exported.rows.every(r => r.targets[0].patient === null));
}

if (!build) {
  test('selection records the serialized projection and freezes attribution without formal placeholders', () => {
    let calls = 0;
    const value = { toJSON() { calls++; return body(); } }, input = source();
    const selected = new LocalReadResponse(value, [input]);
    input.target.recordId.value = 'later-row';
    const event = localReadEvents(facts, selected)[0];
    assert.equal(calls, 1);
    assert.equal(event.targets[0].recordId.value, 'stored-row-a');
    assert.equal(event.targets[0].projectionSha256, createHash('sha256').update(JSON.stringify(body()[0])).digest('hex'));
    assert.equal(event.session.sessionRef, facts.binding.sessionRef);
    assert.deepEqual(event.userId.value, actor);
    assert.equal('patientLinkSnapshot' in event.targets[0], false);
    assert.deepEqual(accessStreams(event), ['viewing']);
    assert.deepEqual(recordTargets(event), [{ index: 0, kind: 'report-version', recordId: 'stored-row-a', versionId: 'version-2' }]);
    assert.equal(Object.isFrozen(event.targets[0]), true);
  });
  test('failed serialization and missing projection cannot become a prepared read', () => {
    const circular = {}; circular.self = circular;
    assert.throws(() => new LocalReadResponse(circular, [source()]));
    assert.throws(() => new LocalReadResponse(body(), [source({ path: [1] })]));
    const event = structuredClone(prepared()); event.targets[0].versionId = unknown;
    assert.throws(() => parseAccessEvent(event));
    assert.deepEqual(localReadEvents(facts, new LocalReadResponse([], [])), []);
  });
  test('metadata keeps unobserved facts; follow-ups preserve the exact target and event reference', () => {
    const input = source(); input.path = []; input.target.kind = 'study-metadata'; input.target.versionId = unknown;
    input.context = { basis: 'same-patient-comparison', studyId: 'anchor-study', relatedStudyId: 'study-a', reason: null };
    const event = localReadEvents({ ...facts, surface: 'POST studies/viewing-set/resolve', ingress: unknown },
      new LocalReadResponse({ patientId: 'synthetic-patient-a' }, [input]))[0];
    assert.deepEqual(event.trustedProxyIp, unknown);
    assert.deepEqual(event.context, input.context);
    const followup = localReadFollowup(event, 'aborted');
    assert.equal(followup.relatedEventId, event.eventId);
    assert.deepEqual(followup.targets, event.targets);
    assert.equal(followup.result, 'aborted');
    assert.throws(() => parseAccessEvent({ ...followup, action: 'transfer-ended' }));
    assert.throws(() => parseAccessEvent({ ...followup, action: 'client-shown', result: 'reported' }));
  });
  test('response observation requires consumption of this stream, not merely status 200', async () => {
    for (const scenario of ['selected', 'other-200', 'close', 'error', '204', 'deadline']) {
      const request = new IncomingMessage(new Socket()), response = new ServerResponse(request);
      const controller = new AbortController();
      const lifecycle = observeLocalReadResponse(request, response, controller.signal);
      if (scenario !== 'other-200') {
        const file = lifecycle.select('[1]');
        for await (const chunk of file.getStream()) assert.equal(chunk.toString(), '[1]');
      }
      if (scenario === '204') response.statusCode = 204;
      if (scenario === 'deadline') controller.abort();
      response.emit(scenario === 'close' ? 'close' : scenario === 'error' ? 'error' : 'finish', new Error('synthetic'));
      assert.equal(await lifecycle.outcome, scenario === 'selected' ? 'ended' : 'aborted');
      assert.equal(response.listenerCount('finish'), 0);
      assert.equal(request.listenerCount('aborted'), 0);
    }
  });
  test('audit replay filters local identities without inventing a formal patient link', async () => {
    const event = prepared();
    const rows = [{ entry: { sequence: 1, payload: { kind: 'access', event } }, durableAt: event.occurredAt, served: null }];
    const page = await replay(rows, { sourcePatientId: 'synthetic-patient-a', recordId: 'stored-row-a' });
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].targets[0].patient, null);
    assert.equal(page.rows[0].targets[0].localSource.projectionSha256, event.targets[0].projectionSha256);
    assert.equal((await replay(rows, { sourcePatientId: 'other' })).rows.length, 0);
    assert.equal((await replay(rows, { patient: { patientId: 'synthetic-patient-a', assigningAuthority: 'invented' } })).rows.length, 0);
  });
  test('incident scope and the auditor event keep locally identified subjects without counting them as identified', async () => {
    const events = localSubjects(facts.institution);
    const rows = events.map((event, i) => ({ entry: { sequence: i + 1, payload: { kind: 'access', event } }, durableAt: event.occurredAt, served: null }));
    await checkLocalIncident(ledgerOf(rows), events, facts.institution);
  });
  test('a deadline after selection but before adapter consumption cannot publish the selected bytes', async () => {
    const request = new IncomingMessage(new Socket()), response = new ServerResponse(request), deadline = new AbortController();
    const lifecycle = observeLocalReadResponse(request, response, deadline.signal);
    const file = lifecycle.select('["synthetic clinical body"]');
    deadline.abort();
    const chunks = [];
    await assert.rejects(async () => { for await (const chunk of file.getStream()) chunks.push(chunk); });
    assert.equal(chunks.length, 0);
    assert.equal(await lifecycle.outcome, 'aborted');
  });
  test('unknown append consults the same operation and never fabricates a receipt or retries', async () => {
    const { ViewingRecordService } = load('emr-viewing/viewing-record.service');
    let attempts = 0, keys, lookedUp;
    const request = new IncomingMessage(new Socket()), response = new ServerResponse(request);
    const service = new ViewingRecordService({ withWork: async (_request, task) => task({ facts,
      assertActive() {}, work: {
        async append(_event, _served, input) { attempts++; keys = input; throw new Error('CommitUnknown'); },
        async lookup(id) { lookedUp = id; return { outcome: 'pending' }; },
        async confirm() { assert.fail('An unknown operation has no receipt'); },
      },
    }) });
    await assert.rejects(service.prepare(request, response, new LocalReadResponse(body(), [source()])),
      error => error.getStatus() === 503);
    assert.equal(attempts, 1);
    assert.equal(lookedUp, keys.operationId);
    assert.equal(response.headersSent, false);
  });
} else {
  test('A-PG-COMMIT: accepted runtime role append, independent readback, target projection and audit filter', async () => {
    const { PrismaClient } = apiRequire('@prisma/client');
    const { EmrLedgerClient } = load('emr-runtime/client');
    const { AccessLedgerStore } = load('emr-runtime/store');
    const { FailureJournal, FailureSpool } = load('emr-runtime/failure-journal');
    const { createRecordPort } = load('emr-runtime/record-port');
    const db = new EmrLedgerClient(process.env.DATABASE_URL);
    const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
    const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL));
    const { port, control } = createRecordPort(new AccessLedgerStore(db, journal));
    const work = port.begin();
    let moduleContext;
    try {
      const event = prepared();
      const receipt = await work.append(event);
      assert.equal(receipt.eventId, event.eventId);
      const entries = await witness.$queryRaw`SELECT sequence, payload FROM emr_access.access_entry WHERE event_id=${event.eventId}`;
      assert.equal(entries.length, 1);
      const stored = JSON.parse(entries[0].payload);
      assert.deepEqual(parseAccessEvent(stored), event);
      const targets = await witness.$queryRaw`SELECT target_kind, record_id, version_id FROM emr_access.access_target t
        JOIN emr_access.access_entry e USING(entry_id) WHERE e.event_id=${event.eventId}`;
      assert.deepEqual(targets, [{ target_kind: 'report-version', record_id: 'stored-row-a', version_id: 'version-2' }]);
      const page = await replay([{ entry: { sequence: Number(entries[0].sequence), payload: { kind: 'access', event: stored } },
        durableAt: receipt.durableAt, served: null }], { sourcePatientId: 'synthetic-patient-a' });
      assert.equal(page.rows.length, 1);
      assert.equal(page.rows[0].targets[0].localSource.projectionSha256, event.targets[0].projectionSha256);
      const followup = localReadFollowup(event, 'ended');
      await work.append(followup);
      const [recorded] = await witness.$queryRaw`SELECT payload FROM emr_access.access_entry WHERE event_id=${followup.eventId}`;
      assert.equal(JSON.parse(recorded.payload).relatedEventId, event.eventId);

      // Exercise the actual A1 service and RF work with PG, without inventing a
      // route. These Node transport objects are component observations only.
      const { createRequestContext } = load('emr-runtime/request-context');
      const { createRequestIngress } = load('emr-runtime/request-ingress');
      const { ViewingRecordService } = load('emr-viewing/viewing-record.service');
      const { EmrViewingModule } = load('emr-viewing/emr-viewing.module');
      const contexts = createRequestContext(createRequestIngress({ proxyPeers: [] }), port);
      moduleContext = await apiRequire('@nestjs/core').NestFactory.createApplicationContext(
        EmrViewingModule.withRequests(contexts.source), { logger: false });
      const service = moduleContext.get(ViewingRecordService);
      function admission() {
        const request = new IncomingMessage(new Socket()), response = new ServerResponse(request);
        contexts.capture.capture(request, response, { issuer: facts.issuer, subject: facts.subject, roles: facts.roles,
          institution: facts.institution, rightsVersion: facts.rightsVersion, binding: facts.binding },
        { method: 'GET', route: 'studies/:uid/report/versions', purpose: 'clinical' },
        async () => assert.fail('A1 must not revive W9API-20'));
        return { request, response };
      }
      const readEvents = async id => (await witness.$queryRaw`SELECT payload FROM emr_access.access_entry
        WHERE event_id=${id} OR payload::jsonb->>'relatedEventId'=${id}`).map(r => JSON.parse(r.payload));
      for (const consumed of [true, false]) {
        const { request, response } = admission(), target = source();
        const delivery = await service.prepare(request, response, new LocalReadResponse(body(), [target]));
        const before = await readEvents(target.eventId);
        assert.deepEqual(before.map(e => e.action), ['provide-prepared']);
        assert.equal(before[0].userId.value.issuer, facts.issuer);
        assert.equal(before[0].session.sessionRef, facts.binding.sessionRef);
        if (consumed) {
          const chunks = [];
          for await (const chunk of delivery.body.getStream()) chunks.push(chunk);
          assert.deepEqual(JSON.parse(Buffer.concat(chunks)), body());
        }
        response.emit('finish');
        await delivery.settled;
        const events = await readEvents(target.eventId);
        assert.equal(events.find(e => e.relatedEventId === target.eventId).action,
          consumed ? 'transfer-ended' : 'transfer-aborted');
      }

      // An ordinary fixture-only SQL failure on the last target: prior COMMIT
      // remains, the complete clinical body is refused, and its end is aborted.
      const first = source(), last = source({ path: [1] });
      last.target.recordId = known('synthetic-refused-row');
      await witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT a1_fixture_refusal
        CHECK (payload::jsonb->'targets'->0->'recordId'->>'value' <> 'synthetic-refused-row')`);
      try {
        const { request, response } = admission();
        await assert.rejects(service.prepare(request, response, new LocalReadResponse([...body(), ...body()], [first, last])),
          error => error.getStatus() === 503);
        response.emit('finish');
        // RF owns the follow-up until it settles; the unrelated direct work
        // above is kept open, so inspect this event instead of a global drain.
        let events;
        while ((events = await readEvents(first.eventId)).length < 2) await pause();
        assert.deepEqual(events.map(e => e.action).sort(), ['provide-prepared', 'transfer-aborted']);
        assert.equal((await readEvents(last.eventId)).length, 0);
        assert.equal(response.headersSent, false);
      } finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT a1_fixture_refusal'); }

      // Hold the actual INSERT until the response closes; the late COMMIT is
      // preserved and settled under the original request work, never published.
      for (const cancellation of ['close', 'deadline']) {
        const late = source(), transport = admission(), deadline = new AbortController();
        let releaseLock, entered;
        const locked = new Promise(resolve => { entered = resolve; });
        const release = new Promise(resolve => { releaseLock = resolve; });
        const holding = witness.$transaction(async tx => {
          await tx.$executeRawUnsafe('LOCK TABLE emr_access.access_entry IN SHARE MODE');
          entered(); await release;
        }, { timeout: 15000 }); // B2's existing transaction deadline.
        try {
          await locked;
          const pending = service.prepare(transport.request, transport.response, new LocalReadResponse(body(), [late], deadline.signal));
          const refused = assert.rejects(pending, error => error.getStatus() === 503);
          for (;;) {
            const [row] = await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE usename='kin_runtime' AND wait_event_type='Lock' AND query LIKE '%append_operation%'`;
            if (row.n) break;
            await pause();
          }
          if (cancellation === 'deadline') deadline.abort();
          else transport.response.emit('close');
          releaseLock(); await holding; await refused;
          transport.response.emit('finish');
          let events;
          while ((events = await readEvents(late.eventId)).length < 2) await pause();
          assert.deepEqual(events.map(e => e.action).sort(), ['provide-prepared', 'transfer-aborted']);
          assert.equal(transport.response.headersSent, false);
        } finally { releaseLock(); await holding; }
      }
    } finally {
      await moduleContext?.close();
      work.end(); control.close(); await control.drained();
      await journal.close(); await db.$disconnect(); await witness.$disconnect();
    }
  });
  test('A-PG-AUDIT-LOCAL: incident scope over local reads appended and read back from PG names them as identified locally', async () => {
    const { PrismaClient } = apiRequire('@prisma/client');
    const { EmrLedgerClient } = load('emr-runtime/client');
    const { AccessLedgerStore } = load('emr-runtime/store');
    const { FailureJournal, FailureSpool } = load('emr-runtime/failure-journal');
    const { createRecordPort } = load('emr-runtime/record-port');
    const db = new EmrLedgerClient(process.env.DATABASE_URL);
    const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
    const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL));
    const { port, control } = createRecordPort(new AccessLedgerStore(db, journal));
    const work = port.begin();
    try {
      // Its own institution keeps the earlier case's rows outside this plan; every stored row is still parsed.
      const institution = 'synthetic-incident-site', events = localSubjects(institution);
      for (const event of events) await work.append(event);
      const ledger = {
        top: async () => (await witness.$queryRaw`SELECT coalesce(max(sequence), 0)::int AS top
          FROM emr_access.access_entry WHERE stream = 'viewing'`)[0].top,
        rows: async (top, below, take) => (await witness.$queryRawUnsafe(`SELECT sequence::int AS sequence, payload, recorded_at
          FROM emr_access.access_entry WHERE stream = 'viewing' AND sequence <= $1::bigint AND ($2::bigint IS NULL OR sequence < $2::bigint)
          ORDER BY sequence DESC LIMIT $3::int`, top, below, take)).map(r => ({
          entry: { sequence: r.sequence, payload: { kind: 'access', event: JSON.parse(r.payload) } },
          durableAt: r.recorded_at.toISOString(), served: null })),
      };
      await checkLocalIncident(ledger, events, institution);
    } finally {
      work.end(); control.close(); await control.drained();
      await journal.close(); await db.$disconnect(); await witness.$disconnect();
    }
  });
}
