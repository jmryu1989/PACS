'use strict';
// CD-09 W-Q WQ1-WQ3: synthetic studies and question threads -> observed PostgreSQL lock, waiter and row facts
// -> HTTP result. Real AuthGuard, question and report controllers, C2 signer, fixed-record locks, B2 transactions.
// Each case states its input, observes the branch it needs on the database (holder connections, pg_locks,
// pg_blocking_pids, NOWAIT probes, xmin) before the product answers, then asserts the product result.
// Lock keys are computed here from their stored JSON form, not imported from the product.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const api = process.env.KIN_D_API || path.resolve(__dirname, '../../../api');
const dependency = name => require(path.join(api, 'node_modules', name));
const product = name => require(path.join(api, 'dist', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { Module } = dependency('@nestjs/common');
const { NestFactory, APP_GUARD } = dependency('@nestjs/core');

test('CD-09 W-Q question writes: report anchor, lock order against native, Tech Note and Related writers, B2 outcomes', async t => {
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { AuthService } = product('auth.service');
  const { PresenceService } = product('presence.service');
  const { AuthGuard } = product('auth.guard');
  const { PacsController } = product('pacs.controller');
  const { PacsService } = product('pacs.service');
  const { ClinicianQuestionController } = product('clinician-question.controller');
  const { ClinicianQuestionService } = product('clinician-question.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { StudyTransferLocalService } = product('study-transfer-local.service');
  const issuer = 'https://synthetic.example.test/realms/question', institution = 'question-fixture';
  // doctor signs native reports, answers and writes Tech Notes; other is a second signer; admin force-discards drafts.
  const members = Object.fromEntries(Object.entries({ doctor: ['radiologist', 'technician'], other: ['radiologist'],
    clinician: ['clinician'], admin: ['admin'] }).map(([name, roles]) => [name, { sub: 'synthetic-wq-' + name,
    email: name + '@example.test', roles }]));
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'question-fixture', alg: 'RS256', use: 'sig' };
  const provider = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const tokens = {};
  for (const [name, m] of Object.entries(members)) tokens[name] = await new jose.SignJWT({ email: m.email,
    realm_access: { roles: m.roles }, groups: ['/' + institution] }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer).setSubject(m.sub).setAudience('kin-api').setIssuedAt().setExpirationTime('30m').sign(privateKey);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  let app, relay, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const m of Object.values(members)) await witness.memberRights.create({ data: { sub: m.sub, username: m.sub,
      email: m.email, name: 'Synthetic ' + m.sub, emailVerified: true, approved: true, suspended: false, institution, roles: m.roles } });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      Object.values(members).map(m => ({ sub: m.sub, institution, roles: m.roles })));
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] } }], studyIdentities: async () => [] };
    class HttpFixture {}
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ controllers: [PacsController, ClinicianQuestionController], providers: [PrismaService, PacsService,
      ClinicianQuestionService, AuthService, PresenceService, ...clinical.providers,
      { provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture }, { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source },
      { provide: OrthancService, useValue: orthanc }, { provide: KeycloakService, useValue: {} },
      { provide: FindingService, useValue: {} },
      { provide: StudyAccessService, useFactory: db => new StudyAccessService(db, orthanc, {}), inject: [PrismaService] },
      { provide: EMR_RECORD_PORT, useValue: runtime.port },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work },
      { provide: APP_GUARD, useClass: AuthGuard }, { provide: StudyTransferLocalService, useValue: {} }] })(HttpFixture);
    app = await NestFactory.create(HttpFixture, { logger: ['error'] });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const headers = who => ({ authorization: 'Bearer ' + tokens[who], 'content-type': 'application/json', 'x-real-ip': '192.0.2.23' });
    const call = async (who, method, route, body) => {
      const response = await fetch(origin + '/api' + route, { method, headers: headers(who),
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let value; try { value = JSON.parse(text); } catch { value = text; }
      return { status: response.status, body: value };
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = (label, value) => console.log('WQ-WITNESS ' + JSON.stringify({ label, ...value }));
    const ok = (out, status, label) => assert.equal(out.status, status, label + ' ' + JSON.stringify(out));

    // --- inputs through the real routes
    let serial = 0;
    const fresh = async () => (await witness.studyState.create({ data: { uid: '2.25.9407.' + ++serial,
      institutionId: institution, ss: 'Verified' } })).uid;
    const draftOwner = who => ({ institution, sub: members[who].sub, author: members[who].email });
    const draft = async (uid, who = 'doctor') => { const out = await call(who, 'GET', `/studies/${uid}/draft`); ok(out, 200, 'draft'); return out.body; };
    const commit = async (uid, action, who = 'doctor') => {
      const d = await draft(uid, who), head = await witness.report.findUnique({ where: { uid } });
      const body = { expectedOwner: draftOwner(who), expectedRevision: d.revision, baseVersion: head?.version ?? 0,
        findings: 'SYN signed ' + uid + ' ' + action, conclusion: '', recommendation: '', citationIds: [], structureIds: [],
        action, ...(action === 'reset' ? { reason: 'SYN reset' } : {}) };
      return () => call(who, 'POST', `/studies/${uid}/report/commit`, body);
    };
    const signed = async () => {
      const uid = await fresh(); const out = await (await commit(uid, 'approve'))();
      ok(out, 201, 'approve'); assert.ok(out.body.signature, 'the normal control uses the real signer'); return uid;
    };
    const owner = who => [institution, members[who].sub];
    const ask = (uid, requestId = randomUUID(), text = 'SYN question') =>
      call('clinician', 'POST', `/studies/${uid}/questions`, { requestId, expectedOwner: owner('clinician'), body: text });
    const reply = (qid, who, revision, requestId = randomUUID(), text = 'SYN reply') =>
      call(who, 'POST', `/questions/${qid}/entries`, { requestId, expectedOwner: owner(who), revision, body: text });
    const closeQuestion = (qid, who, revision, note, requestId = randomUUID()) =>
      call(who, 'POST', `/questions/${qid}/close`, { requestId, expectedOwner: owner(who), revision, note });
    const note = uid => () => call('doctor', 'POST', `/studies/${uid}/tech-note`, { baseVersion: 0, text: 'SYN note', reason: '', attemptId: randomUUID() });
    const insertion = async (target, source) => {
      const d = await draft(target), head = await witness.report.findUnique({ where: { uid: target } });
      const src = await witness.report.findUnique({ where: { uid: source } });
      const version = await witness.reportVersion.findUnique({ where: { uid_version: { uid: source, version: src.version } } });
      const seed = d.snapshot ?? { findings: head?.findings ?? '', conclusion: head?.conclusion ?? '',
        recommendation: head?.recommendation ?? '', baseVersion: head?.version ?? 0 };
      const text = (seed.findings && !seed.findings.endsWith('\n') ? '\n' : '') + version.findings;
      return { expectedOwner: draftOwner('doctor'), expectedRevision: d.revision, ...seed,
        findings: seed.findings + text, citationIds: [], structureIds: [], relatedInsert: {
          intent: 'apply', insertRequestId: randomUUID(), targetUid: target, targetBaseVersion: seed.baseVersion,
          source: { uid: source, version: src.version, action: version.action,
            parts: [{ field: 'findings', start: 0, end: version.findings.length }] },
          seedKind: d.present ? 'private-draft' : head ? 'report-head' : 'empty', section: 'findings',
          position: 'end', offset: seed.findings.length, text, selectionSeq: 1, contentRevision: 1, sourceGeneration: 1 } };
    };

    // --- independent witnesses (not the product's queries)
    const head = async uid => (await witness.$queryRaw`SELECT r.version, v.action FROM "Report" r
      LEFT JOIN "ReportVersion" v ON v.uid=r.uid AND v.version=r.version WHERE r.uid=${uid}`)[0] ?? null;
    const versions = async uid => witness.$queryRaw`SELECT version, action FROM "ReportVersion" WHERE uid=${uid} ORDER BY version`;
    const rsOf = async uid => (await witness.studyState.findUnique({ where: { uid } })).rs;
    const anchorOf = async requestId => (await witness.$queryRaw`SELECT "reportRs" AS rs, "reportVersion" AS version
      FROM "StudyQuestionEntry" WHERE id=${requestId}::uuid`)[0] ?? null;
    const counts = async (qid, requestId) => (await witness.$queryRaw`SELECT
        (SELECT revision FROM "StudyQuestion" WHERE id=${qid}::uuid) AS revision,
        (SELECT "entryCount" FROM "StudyQuestion" WHERE id=${qid}::uuid) AS "entryCount",
        (SELECT count(*)::int FROM "StudyQuestionEntry" WHERE "questionId"=${qid}::uuid) AS entries,
        (SELECT count(*)::int FROM "StudyQuestionEntry" WHERE id=${requestId}::uuid) AS mine,
        (SELECT count(*)::int FROM "AuditLog" WHERE action='study.question' AND detail::jsonb->>'id'=${qid}) AS audits,
        (SELECT count(*)::int FROM "AuditLog" WHERE action='study.question' AND detail::jsonb->>'requestId'=${requestId}) AS "myAudits",
        (SELECT count(*)::int FROM emr_clinical.online_version WHERE record_type='question' AND record_id=${qid}) AS versions`)[0];
    // The B2 business operation of a question write: its command row names the operation; admission rows are not read.
    const outcome = async requestId => witness.$queryRaw`SELECT o.outcome, o.xmin::text AS xid
      FROM emr_clinical.online_command c JOIN emr_access.attempt_outcome o ON o.operation_id=c.operation_id
      WHERE c.record_type='question' AND c.request_id=${requestId}`;
    const observeWrite = async (qid, requestId) => witness.$queryRaw`
      SELECT 'question' AS part, xmin::text AS xid FROM "StudyQuestion" WHERE id=${qid}::uuid
      UNION ALL SELECT 'entry', xmin::text FROM "StudyQuestionEntry" WHERE id=${requestId}::uuid
      UNION ALL SELECT 'audit', xmin::text FROM "AuditLog" WHERE action='study.question' AND detail::jsonb->>'requestId'=${requestId}
      UNION ALL SELECT 'version', v.xmin::text FROM emr_clinical.online_version v JOIN emr_clinical.online_command c
        ON c.operation_id=v.operation_id WHERE c.record_type='question' AND c.request_id=${requestId}
      UNION ALL SELECT 'access', e.xmin::text FROM emr_access.access_entry e JOIN emr_clinical.online_command c
        ON c.operation_id=e.operation_id WHERE c.record_type='question' AND c.request_id=${requestId}
      UNION ALL SELECT 'receipt', r.xmin::text FROM emr_access.entry_receipt r JOIN emr_clinical.online_command c
        ON c.operation_id=r.operation_id WHERE c.record_type='question' AND c.request_id=${requestId}
      UNION ALL SELECT 'outcome', o.xmin::text FROM emr_access.attempt_outcome o JOIN emr_clinical.online_command c
        ON c.operation_id=o.operation_id WHERE c.record_type='question' AND c.request_id=${requestId} AND o.outcome='committed'`;
    const PARTS = ['access', 'audit', 'entry', 'outcome', 'question', 'receipt', 'version'];
    // One assertion for the normal path and for the split-transaction counterexamples alike.
    const oneTransaction = (label, rows) => {
      assert.deepEqual([...new Set(rows.map(r => r.part))].sort(), PARTS, label + ': every part of the write is present');
      assert.equal(new Set(rows.map(r => r.xid)).size, 1, label + ': one transaction wrote them ' + JSON.stringify(rows));
    };

    // --- lock observation
    const fixed = uid => JSON.stringify(['emr-fixed-record', uid]);
    const unitKey = qid => JSON.stringify(['emr-d-unit', 'question', qid]);
    const identityOf = who => clinical.keys.get(members[who].sub).doctor.identity.id;
    const c2 = who => JSON.stringify(['c2-key', institution, identityOf(who)]);
    // Each holder is a separate real connection. No product pause or mocked lock. A holder that does not end cleanly fails.
    const hold = async acquire => {
      let entered, release, ended;
      const ready = new Promise(resolve => { entered = resolve; });
      const stop = new Promise(resolve => { release = resolve; });
      const pending = witness.$transaction(async tx => {
        await acquire(tx);
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        entered(pid); await stop;
      }, { timeout: 20000, maxWait: 5000 });
      pending.catch(() => {});
      const pid = await Promise.race([ready, pending.then(() => { throw new Error('holder ended before ready'); })]);
      return { pid, end() { release(); return ended ??= pending.then(() => undefined); } };
    };
    // Every cleanup step runs. A failed step fails the case, and never replaces the case's own failure: both are kept.
    const ensure = async (body, ...cleanups) => {
      const failures = [];
      let value;
      try { value = await body(); } catch (error) { failures.push(error); }
      for (const cleanup of cleanups) {
        try { await cleanup(); } catch (error) { if (!failures.includes(error)) failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, failures.map(String).join(' | then | '));
      return value;
    };
    const advisoryHold = key => hold(tx => tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))::text`);
    const waits = async blocker => witness.$queryRaw`SELECT pid, backend_xid::text AS xid, wait_event_type, wait_event,
      left(query, 200) AS query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`;
    const waitFor = async (blocker, label) => {
      for (let i = 0; i < 300; i++) {
        const rows = await waits(blocker);
        if (rows.length) { log(label, { blocker, rows }); return rows; }
        await sleep(10);
      }
      log(label + '-missing', { blocker, rows: await waits(blocker) });
      throw new Error(label + ': waiter was not observed');
    };
    const keys = async (pid, named) => {
      const out = {};
      for (const [name, key] of Object.entries(named)) out[name] = await witness.$queryRaw`SELECT l.granted, l.classid::text, l.objid::text,
        hashtextextended(${key},0)::text AS hash FROM pg_locks l WHERE l.pid=${pid} AND l.locktype='advisory' AND l.objsubid=1
        AND l.classid::bigint=((hashtextextended(${key},0) >> 32) & 4294967295)
        AND l.objid::bigint=(hashtextextended(${key},0) & 4294967295)`;
      log('advisory-map', { pid, keys: named, rows: out }); return out;
    };
    const granted = rows => rows.some(r => r.granted), waiting = rows => rows.some(r => !r.granted);
    const lockState = async (pid, label) => log(label, { pid, locks: await witness.$queryRaw`SELECT locktype, relation::regclass::text AS relation,
      classid::text, objid::text, mode, granted FROM pg_locks WHERE pid=${pid} ORDER BY granted DESC, locktype` });
    const rowProbe = async uid => {
      let code = 'acquired';
      const rollback = new Error('probe completed; release by rollback');
      try { await witness.$transaction(async tx => {
        await tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${uid} FOR UPDATE NOWAIT`;
        throw rollback;
      }); } catch (error) { if (error !== rollback) code = error.meta?.code ?? error.code ?? String(error); }
      log('row-probe', { uid, code }); return code;
    };
    const keyProbe = async key => {
      let free = null;
      const rollback = new Error('probe completed; release by rollback');
      try { await witness.$transaction(async tx => {
        free = (await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS free`)[0].free;
        throw rollback;
      }); } catch (error) { if (error !== rollback) throw error; }
      log('key-probe', { key, free }); return free;
    };
    const deadlocks = async () => (await witness.$queryRaw`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()`)[0].n;
    const settledDeadlocks = async () => { await sleep(1200); return deadlocks(); };

    await t.test('T1/T10/T9 one thread records null, then each verified head; current follows the head; one transaction per write', async () => {
      const uid = await fresh(), q = randomUUID();
      assert.equal(await head(uid), null); assert.deepEqual(await versions(uid), []);
      ok(await ask(uid, q), 201, 'create');
      oneTransaction('create', await observeWrite(q, q));
      assert.deepEqual(await anchorOf(q), { rs: await rsOf(uid), version: null });
      const steps = [
        ['approve', id => reply(q, 'doctor', 1, id), 'answer'],
        ['addendum', id => reply(q, 'clinician', 2, id), 'followup'],
        ['reset', id => closeQuestion(q, 'doctor', 3, 'SYN close after reset', id), 'close'],
      ];
      const recorded = [null];
      for (const [action, write, label] of steps) {
        ok(await (await commit(uid, action))(), 201, action);
        const before = await head(uid), rs = await rsOf(uid);
        log('head-before-' + label, { uid, before, rs, versions: await versions(uid) });
        assert.notEqual(before, null); assert.notEqual(before.action, 'discarded');
        const id = randomUUID();
        ok(await write(id), 201, label);
        oneTransaction(label, await observeWrite(q, id));
        assert.deepEqual(await anchorOf(id), { rs, version: before.version }, label);
        recorded.push(before.version);
      }
      assert.deepEqual((await versions(uid)).map(v => v.action), ['approve', 'addendum', 'discarded', 'reset']);
      ok(await (await commit(uid, 'approve'))(), 201, 'approve after reset');
      const now = await head(uid), thread = await call('clinician', 'GET', `/questions/${q}`);
      ok(thread, 200, 'thread');
      assert.deepEqual(thread.body.item.entries.map(e => e.reportAnchor.version), recorded);
      assert.deepEqual(recorded, [null, 1, 2, 4]);
      assert.deepEqual(thread.body.item.current, { rs: await rsOf(uid), version: now.version });
      assert.equal(JSON.stringify(thread.body).includes('SYN signed'), false, 'no report text in the thread');
    });

    await t.test('T9 split-transaction counterexamples fail the same one-transaction assertion', async () => {
      const uid = await fresh(), q = randomUUID();
      ok(await ask(uid, q), 201, 'create');
      oneTransaction('control', await observeWrite(q, q));
      // An audit row for the request committed by another transaction.
      await witness.auditLog.create({ data: { actor: members.clinician.email, action: 'study.question', target: uid,
        detail: JSON.stringify({ id: q, requestId: q, counterexample: 'separate audit transaction' }) } });
      const auditApart = await observeWrite(q, q);
      log('counterexample-audit', { rows: auditApart });
      assert.throws(() => oneTransaction('audit apart', auditApart), assert.AssertionError);
      // The business entry rewritten by another transaction.
      const other = await fresh(), q2 = randomUUID();
      ok(await ask(other, q2), 201, 'create 2');
      await witness.$executeRaw`UPDATE "StudyQuestionEntry" SET body=body WHERE id=${q2}::uuid`;
      const businessApart = await observeWrite(q2, q2);
      log('counterexample-business', { rows: businessApart });
      assert.throws(() => oneTransaction('business apart', businessApart), assert.AssertionError);
    });

    await t.test('T1 a discarded-only history (force-discarded private draft) records null', async () => {
      const uid = await fresh(), d = await draft(uid);
      ok(await call('doctor', 'PUT', `/studies/${uid}/report`, { expectedOwner: draftOwner('doctor'), expectedRevision: d.revision,
        baseVersion: 0, findings: 'SYN private draft', conclusion: '', recommendation: '', citationIds: [], structureIds: [] }), 200, 'draft');
      const state = await witness.studyState.findUnique({ where: { uid } });
      ok(await call('admin', 'DELETE', `/studies/${uid}/draft/force`, { expectedOwner: draftOwner('admin'), expectedEpoch: state.draftEpoch }), 200, 'force');
      const history = await versions(uid);
      log('discarded-only', { uid, history, head: await head(uid) });
      assert.deepEqual(history.map(v => v.action), ['discarded']); assert.equal(await head(uid), null);
      const q = randomUUID();
      ok(await ask(uid, q), 201, 'create');
      assert.deepEqual(await anchorOf(q), { rs: await rsOf(uid), version: null });
    });

    await t.test('T2 a head that does not match its version rows refuses the write, writes nothing, keeps its B2 result', async t => {
      const corruptions = {
        'head-row-missing': { apply: uid => witness.$executeRaw`DELETE FROM "ReportVersion" WHERE uid=${uid} AND version=1`,
          seen: async uid => (await head(uid))?.action === null,
          restore: uid => witness.$executeRaw`INSERT INTO "ReportVersion"(uid, version, action, findings, author)
            VALUES (${uid}, 1, 'approve', 'SYN restored', 'synthetic-restore')` },
        'report-missing': { apply: uid => witness.$executeRaw`DELETE FROM "Report" WHERE uid=${uid}`,
          seen: async uid => await head(uid) === null && (await versions(uid)).length === 1,
          restore: uid => witness.$executeRaw`INSERT INTO "Report"(uid, findings, version, "updatedBy", "updatedAt")
            VALUES (${uid}, 'SYN restored', 1, 'synthetic-restore', now())` },
        'kept-above-head': { apply: uid => witness.$executeRaw`INSERT INTO "ReportVersion"(uid, version, action, findings, author)
            VALUES (${uid}, 2, 'approve', 'SYN above head', 'synthetic-corruption')`,
          seen: async uid => (await head(uid))?.version === 1 && (await versions(uid)).length === 2,
          restore: uid => witness.$executeRaw`DELETE FROM "ReportVersion" WHERE uid=${uid} AND version=2` },
      };
      for (const [name, corruption] of Object.entries(corruptions)) await t.test(name, async () => {
        const uid = await signed(), q = randomUUID();
        ok(await ask(uid, q), 201, 'create');
        await corruption.apply(uid);
        log('corruption', { name, uid, head: await head(uid), versions: await versions(uid) });
        assert.ok(await corruption.seen(uid), 'the corrupted state exists before the write');
        const id = randomUUID(), before = await counts(q, id);
        const refused = await reply(q, 'doctor', 1, id);
        log('refused', { name, refused, outcome: await outcome(id) });
        assert.equal(refused.status, 409, JSON.stringify(refused)); assert.equal(refused.body.code, 'QUESTION_REPORT_UNAVAILABLE');
        const created = randomUUID(), opened = await ask(uid, created);
        assert.equal(opened.status, 409, JSON.stringify(opened)); assert.equal(opened.body.code, 'QUESTION_REPORT_UNAVAILABLE');
        assert.deepEqual(await counts(q, id), before, 'no question, entry, audit or record version');
        assert.equal(await witness.studyQuestion.count({ where: { id: created } }), 0);
        await corruption.restore(uid);
        // The refused request ID settled negative in B2; repairing the data does not reapply it.
        const again = await reply(q, 'doctor', 1, id);
        log('same-id-after-repair', { name, again, outcome: await outcome(id) });
        assert.ok(again.status >= 400, JSON.stringify(again)); assert.equal((await counts(q, id)).mine, 0);
        const fresh2 = randomUUID();
        ok(await reply(q, 'doctor', 1, fresh2), 201, 'new id after repair');
        assert.deepEqual(await anchorOf(fresh2), { rs: await rsOf(uid), version: (await head(uid)).version });
        assert.equal((await counts(q, fresh2)).myAudits, 1);
      });
    });

    await t.test('T2 (E1) a question row that moved to another study under the unit lock is refused before that StudyState', async () => {
      const a = await fresh(), b = await fresh(), q = randomUUID();
      ok(await ask(a, q), 201, 'create');
      const id = randomUUID(), before = await counts(q, id);
      const unit = await advisoryHold(unitKey(q));
      let pending, other, waiters = [], out;
      await ensure(async () => {
        pending = reply(q, 'doctor', 1, id);
        await waitFor(unit.pid, 'reply-at-unit');
        await witness.$executeRaw`UPDATE "StudyQuestion" SET "studyUid"=${b} WHERE id=${q}::uuid`;
        other = await hold(tx => tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${b} FOR UPDATE`);
        await unit.end();
        let done = false;
        const watched = pending.finally(() => { done = true; });
        while (!done) { waiters.push(...await waits(other.pid)); await sleep(10); }
        out = await watched;
        log('moved-question', { out, waiters });
      }, () => unit.end(), () => other?.end(),
      () => witness.$executeRaw`UPDATE "StudyQuestion" SET "studyUid"=${a} WHERE id=${q}::uuid`);
      assert.equal(waiters.length, 0, 'the write never waited on the other study');
      assert.equal(out.status, 409, JSON.stringify(out)); assert.equal(out.body.code, 'QUESTION_CHANGED');
      assert.deepEqual(await counts(q, id), before);
    });

    await t.test('T3 an outside fixed(study) holder: create and answer wait at that key before the signer key and StudyState', async t => {
      const uid = await signed(), q = randomUUID();
      ok(await ask(uid, q), 201, 'create');
      let revision = 1;
      for (const [kind, signer] of [['create', 'clinician'], ['reply', 'doctor']]) await t.test(kind, async () => {
        const id = randomUUID(), holder = await advisoryHold(fixed(uid));
        let pending, out;
        await ensure(async () => {
          pending = kind === 'create' ? ask(uid, id) : reply(q, signer, revision, id);
          const [waiter] = await waitFor(holder.pid, kind + '-at-fixed');
          const held = await keys(waiter.pid, { study: fixed(uid), signer: c2(signer) });
          await lockState(waiter.pid, kind + '-locks');
          assert.ok(waiting(held.study), 'the write waits at the study key');
          assert.equal(granted(held.signer), false, 'the signer key is not held yet');
          assert.equal(await rowProbe(uid), 'acquired', 'StudyState is not held yet');
          assert.equal(await keyProbe(c2(signer)), true, 'the signer key is free');
        }, () => holder.end(), async () => { if (pending) out = await pending; });
        ok(out, 201, kind);
        assert.deepEqual(await anchorOf(id), { rs: await rsOf(uid), version: (await head(uid)).version });
        if (kind === 'reply') revision++;
      });
    });

    await t.test('T3 (E5) a fixed(study) wait past the lock bound answers QUESTION_BUSY and writes nothing', async () => {
      const uid = await signed(), q = randomUUID();
      ok(await ask(uid, q), 201, 'create');
      const id = randomUUID(), before = await counts(q, id), holder = await advisoryHold(fixed(uid));
      let out;
      await ensure(async () => {
        const pending = reply(q, 'doctor', 1, id);
        const [waiter] = await waitFor(holder.pid, 'reply-at-fixed');
        assert.ok(waiting((await keys(waiter.pid, { study: fixed(uid) })).study));
        out = await pending;
      }, () => holder.end());
      log('fixed-timeout', { out, outcome: await outcome(id) });
      assert.equal(out.status, 503, JSON.stringify(out)); assert.equal(out.body.code, 'QUESTION_BUSY');
      assert.deepEqual(await counts(q, id), before);
      const again = await reply(q, 'doctor', 1, id);
      log('fixed-timeout-same-id', { again, outcome: await outcome(id) });
      assert.ok(again.status >= 400, JSON.stringify(again)); assert.equal((await counts(q, id)).mine, 0);
      ok(await reply(q, 'doctor', 1), 201, 'new id');
    });

    await t.test('T4/T6 a native commit and an answer on one study, same and other signer, both orders, finish without deadlock', async t => {
      for (const signer of ['doctor', 'other']) for (const order of ['native-first', 'question-first']) await t.test(signer + '-' + order, async () => {
        const uid = await signed(), q = randomUUID();
        ok(await ask(uid, q), 201, 'create');
        const native = await commit(uid, 'addendum'), id = randomUUID();
        const before = { ...await counts(q, id), reportVersions: (await versions(uid)).length,
          addenda: await witness.auditLog.count({ where: { target: uid, action: 'report.addendum' } }) };
        const d0 = await deadlocks();
        let holder, nativeCall, answerCall, results;
        await ensure(async () => {
          if (order === 'native-first') {
            holder = await hold(tx => tx.$queryRaw`SELECT uid FROM "Report" WHERE uid=${uid} FOR UPDATE`);
            nativeCall = native();
            const [writer] = await waitFor(holder.pid, 'native-at-report');
            await keys(writer.pid, { study: fixed(uid) });
            assert.equal(await rowProbe(uid), '55P03', 'the native writer holds StudyState');
            answerCall = reply(q, signer, 1, id);
            const [waiter] = await waitFor(writer.pid, 'answer-behind-native');
            const held = await keys(waiter.pid, { study: fixed(uid), signer: c2(signer) });
            await lockState(waiter.pid, 'answer-locks');
            assert.ok(waiting(held.study), 'the answer waits at the study key the native writer holds');
            assert.equal(granted(held.signer), false, 'the answer does not hold the signer key while it waits');
          } else {
            holder = await advisoryHold(c2(signer));
            answerCall = reply(q, signer, 1, id);
            const [waiter] = await waitFor(holder.pid, 'answer-at-signer');
            const held = await keys(waiter.pid, { study: fixed(uid), signer: c2(signer) });
            assert.ok(granted(held.study), 'the answer holds the study key'); assert.ok(waiting(held.signer));
            assert.equal(await rowProbe(uid), 'acquired', 'the answer has not locked StudyState');
            nativeCall = native();
            const [writer] = await waitFor(waiter.pid, 'native-behind-answer');
            const nativeHeld = await keys(writer.pid, { study: fixed(uid) });
            await lockState(writer.pid, 'native-locks');
            assert.ok(waiting(nativeHeld.study), 'the native writer waits at the same study key');
          }
        }, () => holder?.end(), async () => {
          results = await Promise.all([nativeCall, answerCall]);
          log('native-answer-results', { signer, order, results, deadlocks: [d0, await settledDeadlocks()] });
        });
        const [nativeOut, answerOut] = results;
        ok(nativeOut, 201, 'native'); ok(answerOut, 201, 'answer');
        assert.equal(await deadlocks(), d0, 'no deadlock was detected');
        const now = await head(uid);
        assert.equal(now.version, 2);
        assert.deepEqual(await anchorOf(id), { rs: await rsOf(uid), version: order === 'native-first' ? 2 : 1 });
        const after = await counts(q, id);
        assert.deepEqual([after.revision, after.entryCount, after.entries, after.audits, after.mine, after.myAudits, after.versions],
          [before.revision + 1, before.entryCount + 1, before.entries + 1, before.audits + 1, 1, 1, before.versions + 1]);
        assert.equal((await versions(uid)).length, before.reportVersions + 1);
        assert.equal(await witness.auditLog.count({ where: { target: uid, action: 'report.addendum' } }), before.addenda + 1);
      });
    });

    await t.test('T5 Tech Note and Related cross an answer on the same study in both orders without deadlock', async t => {
      const cases = {
        tech: async () => { const uid = await signed(); return { uid, other: note(uid), otherStatus: 201, otherKeys: [uid] }; },
        'related-target': async () => { const uid = await signed(), source = await signed(), body = await insertion(uid, source);
          return { uid, other: () => call('doctor', 'PUT', `/studies/${uid}/report`, body), otherStatus: 200, otherKeys: [uid, source] }; },
        'related-source': async () => { const uid = await signed(), target = await signed(), body = await insertion(target, uid);
          return { uid, other: () => call('doctor', 'PUT', `/studies/${target}/report`, body), otherStatus: 200, otherKeys: [uid, target] }; },
      };
      for (const [name, setup] of Object.entries(cases)) for (const first of ['other', 'answer']) await t.test(name + '-' + first + '-first', async () => {
        const { uid, other, otherStatus, otherKeys } = await setup(), q = randomUUID();
        ok(await ask(uid, q), 201, 'create');
        const id = randomUUID(), d0 = await deadlocks();
        const actions = { other, answer: () => reply(q, 'doctor', 1, id) };
        const named = Object.fromEntries(otherKeys.map((key, i) => ['k' + i, fixed(key)]));
        // Stops the first writer at its own projection write, after its record and row locks.
        const holder = await hold(tx => tx.$executeRawUnsafe('LOCK TABLE "StudyQuestion", "TechNoteRevision", "ReportDraft" IN SHARE MODE'));
        let one, two, results, secondWait = 'fixed';
        await ensure(async () => {
          one = actions[first]();
          const [writer] = await waitFor(holder.pid, 'first-at-projection');
          const held = await keys(writer.pid, first === 'answer' ? { study: fixed(uid) } : named);
          assert.ok(Object.values(held).every(granted), 'the first writer holds its fixed keys');
          assert.equal(await rowProbe(uid), '55P03', 'the first writer holds StudyState');
          two = actions[first === 'answer' ? 'other' : 'answer']();
          const [waiter] = await waitFor(writer.pid, 'second-behind-first');
          const study = (await keys(waiter.pid, { study: fixed(uid) })).study;
          await lockState(waiter.pid, 'second-locks');
          if (!waiting(study) && first === 'answer' && name === 'tech' && waiter.query.includes('StudyState')) secondWait = 'admission-row';
          else assert.ok(waiting(study), 'the second writer waits at the study key');
        }, () => holder.end(), async () => {
          results = await Promise.all([one, two]);
          log('cross-results', { name, first, secondWait, results, deadlocks: [d0, await settledDeadlocks()] });
        });
        const byName = first === 'answer' ? { answer: results[0], other: results[1] } : { other: results[0], answer: results[1] };
        ok(byName.answer, 201, 'answer'); ok(byName.other, otherStatus, name);
        assert.equal(await deadlocks(), d0, 'no deadlock was detected');
        assert.deepEqual(await anchorOf(id), { rs: await rsOf(uid), version: (await head(uid)).version });
      });
    });

    await t.test('T7 (E4) a committed answer whose response the relay held and dropped replays by the same ID', async () => {
      const uid = await signed(), q = randomUUID();
      ok(await ask(uid, q), 201, 'create');
      let heldBody, drop;
      const captured = new Promise(resolve => { heldBody = resolve; });
      const dropped = new Promise(resolve => { drop = resolve; });
      relay = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const answer = await fetch(origin + req.url, { method: req.method, headers: { authorization: req.headers.authorization,
          'content-type': 'application/json', 'x-real-ip': '192.0.2.23' }, body });
        heldBody({ status: answer.status, body: JSON.parse(await answer.text()) });
        await dropped;
        req.socket.destroy();
      });
      await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
      const id = randomUUID(), payload = { requestId: id, expectedOwner: owner('doctor'), revision: 1, body: 'SYN answer held' };
      const client = fetch('http://127.0.0.1:' + relay.address().port + `/api/questions/${q}/entries`, { method: 'POST',
        headers: headers('doctor'), body: JSON.stringify(payload) })
        .then(response => ({ delivered: true, status: response.status }), error => ({ delivered: false, error: String(error.cause?.code ?? error.message) }));
      const held = await captured;
      const committed = { entry: await anchorOf(id), outcome: await outcome(id), counts: await counts(q, id) };
      log('committed-before-drop', { held, committed });
      ok(held, 201, 'the relay holds the real answer');
      assert.ok(committed.entry, 'the entry is committed'); assert.deepEqual(committed.outcome.map(o => o.outcome), ['committed']);
      assert.equal(committed.counts.versions, 2);
      drop();
      const lost = await client;
      log('client-lost', { lost });
      assert.equal(lost.delivered, false, 'the client never received the answer');
      const replay = await call('doctor', 'POST', `/questions/${q}/entries`, payload);
      ok(replay, 201, 'replay'); assert.equal(replay.body.replayed, true);
      assert.deepEqual(replay.body.applied, held.body.applied);
      const after = await counts(q, id);
      assert.deepEqual([after.mine, after.myAudits, after.versions], [1, 1, 2]);
      const reused = await call('doctor', 'POST', `/questions/${q}/entries`, { ...payload, body: 'SYN other text' });
      assert.equal(reused.status, 409, JSON.stringify(reused)); assert.equal(reused.body.code, 'REQUEST_ID_REUSED');
    });

    await t.test('T8 (E2/E5) uncommitted answers never answer success and their request IDs keep the B2 result', async t => {
      await t.test('StudyState held past the lock bound', async () => {
        const uid = await signed(), q = randomUUID();
        ok(await ask(uid, q), 201, 'create');
        const id = randomUUID(), before = await counts(q, id);
        const holder = await hold(tx => tx.$queryRaw`SELECT uid FROM "StudyState" WHERE uid=${uid} FOR UPDATE`);
        let out;
        await ensure(async () => {
          const pending = reply(q, 'doctor', 1, id);
          const [waiter] = await waitFor(holder.pid, 'answer-at-studystate');
          await keys(waiter.pid, { study: fixed(uid), signer: c2('doctor') });
          out = await pending;
        }, () => holder.end());
        log('studystate-timeout', { out, outcome: await outcome(id) });
        assert.equal(out.status, 503, JSON.stringify(out)); assert.equal(out.body.code, 'QUESTION_BUSY');
        assert.deepEqual(await counts(q, id), before);
        const again = await reply(q, 'doctor', 1, id);
        log('studystate-timeout-same-id', { again, outcome: await outcome(id) });
        assert.ok(again.status >= 400, JSON.stringify(again)); assert.equal((await counts(q, id)).mine, 0);
        ok(await reply(q, 'doctor', 1), 201, 'new id');
      });
      await t.test('COMMIT refused by a deferred constraint', async () => {
        const uid = await signed(), q = randomUUID();
        ok(await ask(uid, q), 201, 'create');
        const id = randomUUID(), before = await counts(q, id);
        await witness.$executeRawUnsafe(`CREATE FUNCTION public.wq_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'SYN WQ deferred rollback' USING ERRCODE='23514'; END $$`);
        await witness.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER wq_fail_commit AFTER INSERT ON "StudyQuestionEntry"
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wq_fail_commit()`);
        let out;
        try { out = await reply(q, 'doctor', 1, id); }
        finally {
          await witness.$executeRawUnsafe('DROP TRIGGER wq_fail_commit ON "StudyQuestionEntry"');
          await witness.$executeRawUnsafe('DROP FUNCTION public.wq_fail_commit()');
        }
        // E5: the HTTP status of a refused COMMIT is recorded as observed; it is not counted as a 503 pass.
        const first = await outcome(id);
        log('deferred-commit', { out, outcome: first, counts: await counts(q, id) });
        assert.ok(out.status >= 500, JSON.stringify(out));
        assert.deepEqual(await counts(q, id), before);
        // E2: only a negative B2 settlement fixes the request ID to its failure. An operation the failed COMMIT left
        // unsettled may be applied by its retry, once; it is never applied twice and never answered from nothing.
        const again = await reply(q, 'doctor', 1, id), after = await counts(q, id);
        log('deferred-commit-same-id', { again, outcome: await outcome(id), after, firstSettlement: first.map(o => o.outcome) });
        if (first.some(o => o.outcome === 'negative') || again.status >= 400) {
          assert.ok(again.status >= 400, JSON.stringify(again)); assert.equal(after.mine, 0);
        } else {
          ok(again, 201, 'retry of an unsettled operation');
          assert.deepEqual([after.mine, after.myAudits, after.versions, after.revision],
            [1, 1, before.versions + 1, before.revision + 1], 'applied once');
        }
        ok(await reply(q, 'doctor', after.revision), 201, 'new id');
      });
    });
  } finally {
    if (relay) await new Promise(resolve => relay.close(resolve));
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await witness.$disconnect(); await new Promise(resolve => provider.close(resolve));
  }
});
