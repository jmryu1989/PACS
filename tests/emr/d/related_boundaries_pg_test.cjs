'use strict';
// CD-09 W-R WR1-4: synthetic signed reports -> observed PG boundary -> HTTP result.
// Real AuthGuard, signer, fixed locks, row probes, receipt and B2 transaction.
const assert = require('node:assert/strict');
const { test } = require('node:test');
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

test('CD-09 W-R real PG boundaries, native signing and Tech Note lock order', async t => {
  const { EmrRuntime } = product('emr-runtime/application');
  const { EMR_RECORD_PORT } = product('emr-runtime/record-port');
  const { EMR_BACKGROUND_WORK } = product('emr-runtime/background-work');
  const { PrismaService } = product('prisma.service');
  const { AuthService } = product('auth.service');
  const { PresenceService } = product('presence.service');
  const { AuthGuard } = product('auth.guard');
  const { PacsController } = product('pacs.controller');
  const { PacsService } = product('pacs.service');
  const { StudyAccessService } = product('study-access.service');
  const { OrthancService } = product('orthanc.service');
  const { KeycloakService } = product('keycloak.service');
  const { FindingService } = product('finding.service');
  const { StudyTransferLocalService } = product('study-transfer-local.service');
  const issuer = 'https://synthetic.example.test/realms/report', institution = 'report-fixture';
  const sub = 'synthetic-report-doctor', author = 'doctor@example.test';
  const otherSub = 'synthetic-other-doctor', otherAuthor = 'other@example.test';
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', AUTH_REQUIRED: 'true',
    KIN_COOKIE_SECRET: randomUUID(), KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.example.test' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'report-fixture', alg: 'RS256', use: 'sig' };
  const provider = require('node:http').createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const token = await new jose.SignJWT({ email: author, realm_access: { roles: ['radiologist', 'technician'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(sub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const otherToken = await new jose.SignJWT({ email: otherAuthor, realm_access: { roles: ['radiologist'] }, groups: ['/' + institution] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(otherSub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_D_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_D_SPOOL);
  let app, ready = false;
  try {
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    await witness.memberRights.create({ data: { sub, username: sub, email: author, name: 'Synthetic',
      emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist', 'technician'] } });
    await witness.memberRights.create({ data: { sub: otherSub, username: otherSub, email: otherAuthor, name: 'Synthetic Other',
      emailVerified: true, approved: true, suspended: false, institution, roles: ['radiologist'] } });
    await runtime.start(); ready = true;
    const clinical = await require('./clinical_fixture.cjs').clinicalFixture(witness, runtime.port, issuer,
      [{ sub, institution, roles: ['radiologist', 'technician'] }, { sub: otherSub, institution, roles: ['radiologist'] }]);
    const orthanc = { studyIdentityResources: async uid => [{ '0020000D': { Value: [uid] }, '00100020': { Value: ['SYN-PATIENT-' + uid] } }], studyIdentities: async () => [] };
    class HttpFixture {}
    // REQUEST_FACTS: the Guard captures into, and the report routes read, the shared request context;
    // this direct fixture's loopback peer stands in for the deployment proxy.
    const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = product('emr-runtime/request-context');
    const { createRequestIngress } = product('emr-runtime/request-ingress');
    const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), runtime.port);
    Module({ controllers: [PacsController], providers: [PrismaService, PacsService, AuthService, PresenceService, ...clinical.providers,
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
    const send = async (uid, endpoint, body, bearer = token) => {
      const response = await fetch(origin + '/api/studies/' + uid + endpoint, {
        method: body === undefined ? 'GET' : endpoint === '/report' ? 'PUT' : 'POST',
        headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', 'x-real-ip': '192.0.2.23' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const log = (label, value) => console.log('WR-WITNESS ' + JSON.stringify({ label, ...value }));
    const owner = { institution, sub, author };
    let serial = 0;
    const fresh = async () => {
      const state = await witness.studyState.create({ data: { uid: '2.25.9404.' + ++serial,
        institutionId: institution, ss: 'Verified' } });
      return state.uid;
    };
    const draft = async (uid, bearer = token) => {
      const out = await send(uid, '/draft', undefined, bearer);
      assert.equal(out.status, 200, JSON.stringify(out)); return out.body;
    };
    const commit = async (uid, action = 'approve', other = false) => {
      const bearer = other ? otherToken : token, principal = other ? { institution, sub: otherSub, author: otherAuthor } : owner;
      const d = await draft(uid, bearer), head = await witness.report.findUnique({ where: { uid } });
      const body = { expectedOwner: principal, expectedRevision: d.revision, baseVersion: head?.version ?? 0,
        findings: 'SYN signed ' + uid, conclusion: '', recommendation: '', citationIds: [], structureIds: [],
        action, ...(action === 'reset' ? { reason: 'SYN reset' } : {}) };
      return () => send(uid, '/report/commit', body, bearer);
    };
    const signed = async () => {
      const uid = await fresh(), out = await (await commit(uid))();
      assert.equal(out.status, 201, JSON.stringify(out));
      assert.ok(out.body.signature, 'normal control uses the real signer');
      assert.equal((await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_signing.signed_version
        WHERE record_id=${uid}`)[0].n, 1);
      const atomic = await witness.$queryRaw`SELECT 'state' AS part, xmin::text AS xid FROM "StudyState" WHERE uid=${uid}
        UNION ALL SELECT 'head', xmin::text FROM "Report" WHERE uid=${uid}
        UNION ALL SELECT 'draft', xmin::text FROM "ReportDraft" WHERE uid=${uid}
        UNION ALL SELECT 'version', xmin::text FROM "ReportVersion" WHERE uid=${uid}
        UNION ALL SELECT 'signature', xmin::text FROM emr_signing.signed_version WHERE record_id=${uid}
        UNION ALL SELECT 'operation', xmin::text FROM emr_signing.operation WHERE outcome->>'recordId'=${uid}
        UNION ALL SELECT 'audit', xmin::text FROM "AuditLog" WHERE target=${uid} AND action='report.approve'
        UNION ALL SELECT 'B', xmin::text FROM emr_access.access_entry
          WHERE payload::jsonb->>'surface'='POST studies/:uid/report/commit'
            AND payload::jsonb->>'action'='approve-sign' AND payload::jsonb->'context'->>'studyId'=${uid}`;
      log('signed-atomic', { uid, atomic });
      assert.deepEqual([...new Set(atomic.map(row => row.part))].sort(), ['B', 'audit', 'draft', 'head', 'operation', 'signature', 'state', 'version']);
      assert.equal(new Set(atomic.map(row => row.xid)).size, 1);
      return uid;
    };
    const insertion = async (target, source) => {
      const d = await draft(target), head = await witness.report.findUnique({ where: { uid: target } });
      const src = await witness.report.findUnique({ where: { uid: source } });
      const version = await witness.reportVersion.findUnique({ where: { uid_version: { uid: source, version: src.version } } });
      const seed = d.snapshot ?? { findings: head?.findings ?? '', conclusion: head?.conclusion ?? '',
        recommendation: head?.recommendation ?? '', baseVersion: head?.version ?? 0 };
      const text = (seed.findings && !seed.findings.endsWith('\n') ? '\n' : '') + version.findings;
      const body = { expectedOwner: owner, expectedRevision: d.revision, ...seed,
        findings: seed.findings + text, citationIds: [], structureIds: [], relatedInsert: {
          intent: 'apply', insertRequestId: randomUUID(), targetUid: target, targetBaseVersion: seed.baseVersion,
          source: { uid: source, version: src.version, action: version.action,
            parts: [{ field: 'findings', start: 0, end: version.findings.length }] },
          seedKind: d.present ? 'private-draft' : head ? 'report-head' : 'empty', section: 'findings',
          position: 'end', offset: seed.findings.length, text, selectionSeq: 1, contentRevision: 1, sourceGeneration: 1 } };
      log('input', { target, source, id: body.relatedInsert.insertRequestId, seedKind: body.relatedInsert.seedKind,
        base: seed.baseVersion, sourceVersion: src.version, revision: d.revision });
      return body;
    };
    const note = uid => () => send(uid, '/tech-note', { baseVersion: 0, text: 'SYN note', reason: '', attemptId: randomUUID() });
    const fixed = uid => JSON.stringify(['emr-fixed-record', uid]);
    // Each holder is a separate real connection. No product pause or mocked lock.
    const hold = async acquire => {
      let ready, release;
      const entered = new Promise(resolve => { ready = resolve; });
      const stop = new Promise(resolve => { release = resolve; });
      const pending = witness.$transaction(async tx => {
        await acquire(tx);
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        ready(pid); await stop;
      }, { timeout: 15000 });
      pending.catch(() => {});
      const pid = await Promise.race([entered, pending.then(() => { throw new Error('holder ended before ready'); })]);
      return { pid, async end() { release(); await pending; } };
    };
    const waits = async blocker => witness.$queryRaw`SELECT pid, backend_xid::text AS xid, wait_event, query,
      pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))`;
    const waitFor = async (blocker, label) => {
      for (let i = 0; i < 100; i++) {
        const rows = await waits(blocker);
        if (rows.length) { log(label, { blocker, rows }); return rows; }
        await sleep(10);
      }
      log(label + '-missing', { blocker, rows: await waits(blocker) });
      throw new Error(label + ': waiter was not observed');
    };
    const keys = async (pid, uids) => {
      const out = [];
      for (const uid of uids) {
        const rows = await witness.$queryRaw`SELECT l.granted, l.classid::text, l.objid::text,
          hashtextextended(${fixed(uid)},0)::text AS hash
          FROM pg_locks l WHERE l.pid=${pid} AND l.locktype='advisory' AND l.objsubid=1
          AND l.classid::bigint=((hashtextextended(${fixed(uid)},0) >> 32) & 4294967295)
          AND l.objid::bigint=(hashtextextended(${fixed(uid)},0) & 4294967295)`;
        out.push({ uid, rows });
      }
      log('advisory-map', { pid, keys: out }); return out;
    };
    const rowProbe = async (uid, mode = 'UPDATE') => {
      let code = 'acquired';
      const rollback = new Error('row probe completed; release by rollback');
      try { await witness.$transaction(async tx => {
        await tx.$queryRawUnsafe(`SELECT uid FROM "StudyState" WHERE uid=$1 FOR ${mode} NOWAIT`, uid);
        throw rollback;
      }); } catch (error) { if (error !== rollback) code = error.meta?.code ?? error.code; }
      log('row-probe', { uid, mode, code }); return code;
    };

    await t.test('T1/T3 signed controls, exact positive base, old private base and base0', async () => {
      for (const missing of [false, true]) {
        const source = await signed(), target = await signed(), body = await insertion(target, source);
        if (missing) await witness.reportVersion.deleteMany({ where: { uid: target, version: 1 } });
        const count = await witness.reportVersion.count({ where: { uid: target, version: 1 } });
        log('target-base-before-apply', { missing, count }); assert.equal(count, missing ? 0 : 1);
        const out = await send(target, '/report', body);
        assert.equal(out.status, missing ? 409 : 200, JSON.stringify(out));
        if (missing) {
          assert.equal(out.body.relatedInsert.reason, 'SEED_CHANGED'); assert.equal((await draft(target)).present, false);
        }
      }
      const source = await signed(), target = await signed();
      const d = await draft(target);
      assert.equal((await send(target, '/report', { expectedOwner: owner, expectedRevision: d.revision, baseVersion: 1,
        findings: 'SYN old base', conclusion: '', recommendation: '', citationIds: [], structureIds: [] })).status, 200);
      const advanced = await (await commit(target, 'addendum', true))();
      assert.equal(advanced.status, 201, JSON.stringify(advanced));
      assert.equal(advanced.body.state.version, 2);
      assert.equal((await draft(target)).snapshot.baseVersion, 1);
      const body = await insertion(target, source), out = await send(target, '/report', body);
      assert.equal(out.status, 200, JSON.stringify(out)); assert.equal(out.body.snapshot.baseVersion, 1);
      const empty = await fresh(), zero = await insertion(empty, source);
      assert.equal((await send(empty, '/report', zero)).status, 200);
      const privateZero = await fresh(), initial = await draft(privateZero);
      assert.equal((await send(privateZero, '/report', { expectedOwner: owner, expectedRevision: initial.revision,
        baseVersion: 0, findings: 'SYN private zero', conclusion: '', recommendation: '', citationIds: [], structureIds: [] })).status, 200);
      const zeroBody = await insertion(privateZero, source);
      assert.equal(zeroBody.relatedInsert.seedKind, 'private-draft'); assert.equal(zeroBody.baseVersion, 0);
      const zeroResult = await send(privateZero, '/report', zeroBody);
      assert.equal(zeroResult.status, 200, JSON.stringify(zeroResult)); assert.equal(zeroResult.body.snapshot.baseVersion, 0);
      const same = await signed(), sameBody = await insertion(same, same);
      const sameResult = await send(same, '/report', sameBody);
      assert.equal(sameResult.status, 200, JSON.stringify(sameResult));
      assert.equal((await witness.report.findUnique({ where: { uid: same } })).version, 1);
    });

    await t.test('T2 exact source loss, kind and native head changes precede refusal', async () => {
      for (const change of ['missing', 'wrong-kind', 'addendum', 'reset']) {
        const source = await signed(), target = await fresh(), body = await insertion(target, source);
        if (change === 'missing') await witness.reportVersion.deleteMany({ where: { uid: source, version: 1 } });
        else if (change === 'wrong-kind') await witness.reportVersion.update({ where: { uid_version: { uid: source, version: 1 } }, data: { action: 'save' } });
        else {
          const advanced = await (await commit(source, change))();
          assert.equal(advanced.status, 201, JSON.stringify(advanced));
        }
        const version = await witness.reportVersion.findUnique({ where: { uid_version: { uid: source, version: 1 } } });
        const head = await witness.report.findUnique({ where: { uid: source } });
        log('source-before-refusal', { change, source, exactAction: version?.action ?? null, head: head.version });
        if (change === 'missing') assert.equal(version, null);
        else if (change === 'wrong-kind') assert.equal(version.action, 'save');
        // Reset preserves the cancelled head as a discarded version before the
        // new reset version, so this existing contract advances by two.
        else assert.equal(head.version, change === 'reset' ? 3 : 2);
        const out = await send(target, '/report', body);
        assert.equal(out.status, 409, JSON.stringify(out));
        assert.equal(out.body.relatedInsert.reason, ['missing', 'wrong-kind'].includes(change) ? 'SOURCE_UNAVAILABLE' : 'SOURCE_CHANGED');
        assert.equal((await draft(target)).present, false);
      }
    });

    await t.test('T6 real hold refuses then same ID applies or is discarded exactly once', async () => {
      for (const discard of [false, true]) {
        const source = await signed(), target = await fresh(), body = await insertion(target, source);
        const before = await draft(target);
        assert.equal((await send(target, '/hold', {}, otherToken)).status, 201);
        const held = await witness.studyState.findUnique({ where: { uid: target } });
        log('hold-before-refusal', { holder: held.holder, target }); assert.equal(held.holder, otherAuthor);
        const refused = await send(target, '/report', body);
        assert.equal(refused.status, 409, JSON.stringify(refused)); assert.equal(refused.body.relatedInsert.reason, 'TARGET_HELD');
        const id = body.relatedInsert.insertRequestId;
        const receipt = await witness.reportDraftInsertReceipt.findUnique({ where: { insertRequestId: id } });
        assert.equal(receipt.state, 'refused'); assert.equal((await draft(target)).revision, before.revision);
        assert.equal((await send(target, '/release', {}, otherToken)).status, 201);
        const command = discard ? { ...body, relatedInsert: { ...body.relatedInsert, intent: 'discard',
          expectedReceiptRevision: receipt.receiptRevision } } : body;
        const result = await send(target, '/report', command);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.body.relatedInsert.state, discard ? 'discarded' : 'applied');
        assert.equal(result.body.relatedInsert.receiptRevision, receipt.receiptRevision + 1);
        const settled = await draft(target), replay = await send(target, '/report', body);
        assert.equal(replay.status, discard ? 409 : 200);
        assert.equal((await draft(target)).revision, settled.revision);
      }
    });

    await t.test('T4/T5 fixed waits precede StudyState for Related, native signer and Tech Note', async t => {
      for (const kind of ['related-low', 'related-high', 'approve', 'addendum', 'reset', 'tech']) await t.test(kind, async () => {
        const source = await signed(), target = kind === 'approve' ? await fresh() : await signed();
        const locked = kind === 'related-low' ? [source, target].sort()[0] : kind === 'related-high' ? [source, target].sort()[1] : target;
        const invoke = kind.startsWith('related') ? (() => insertion(target, source).then(body => send(target, '/report', body)))
          : kind === 'tech' ? note(target) : await commit(target, kind);
        const holder = await hold(tx => tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${fixed(locked)},0))::text`);
        let pending, outcome;
        try {
          pending = invoke();
          const rows = await waitFor(holder.pid, kind + '-fixed-wait');
          const observed = await keys(rows[0].pid, [locked]);
          const probe = await rowProbe(target);
          assert.equal(observed[0].rows[0]?.granted, false);
          assert.equal(probe, 'acquired', 'writer must wait for fixed without owning StudyState');
        } finally { await holder.end(); if (pending) { outcome = await pending; log(kind + '-outcome', outcome); } }
        assert.ok([200, 201].includes(outcome.status), JSON.stringify(outcome));
      });
    });

    await t.test('T5 both directions: Tech Note and native writer versus Related, target and source', async t => {
      for (const other of ['tech', 'addendum']) for (const side of ['target', 'source']) for (const first of ['related', 'other']) {
        await t.test([other, side, first].join('-'), async () => {
          const source = await signed(), target = await signed(), body = await insertion(target, source);
          const uid = side === 'target' ? target : source;
          const actions = { related: () => send(target, '/report', body), other: other === 'tech' ? note(uid) : await commit(uid, 'addendum') };
          // Blocks the first writer after its StudyState/fixed locks, at its actual
          // projection insert/update. Admission reads are compatible with SHARE.
          const holder = await hold(tx => tx.$executeRawUnsafe('LOCK TABLE "ReportDraft", "ReportVersion", "TechNoteRevision" IN SHARE MODE'));
          let one, two, oneOut, twoOut;
          try {
            one = actions[first]();
            const [writer] = await waitFor(holder.pid, 'first-at-projection');
            const held = await keys(writer.pid, first === 'related' ? [source, target].sort() : [uid]);
            const probe = await rowProbe(uid);
            assert.ok(held.every(k => k.rows.some(r => r.granted)), 'the first writer owns all fixed keys');
            assert.equal(probe, '55P03', 'a real conflicting row probe witnesses StudyState ownership');
            two = actions[first === 'related' ? 'other' : 'related']();
            const [waiter] = await waitFor(writer.pid, 'second-at-fixed');
            const waitingKeys = await keys(waiter.pid, [source, target]);
            if (first === 'related' && other === 'tech') {
              // Tech Note's read-only admission can wait for StudyState before
              // opening its writer transaction; it owns no fixed key here.
              assert.ok(waitingKeys.some(k => k.rows.some(r => !r.granted))
                || waiter.query.includes('StudyState'), 'observe fixed wait or separate admission row wait');
            } else assert.ok(waitingKeys.some(k => k.rows.some(r => !r.granted)), 'second writer waits on the same fixed boundary');
          } finally {
            await holder.end();
            [oneOut, twoOut] = await Promise.all([one, two]);
            log('pair-outcomes', { other, side, first, oneOut, twoOut });
          }
          assert.ok([200, 201].includes(oneOut.status), JSON.stringify(oneOut));
          if (other === 'tech') assert.ok([200, 201].includes(twoOut.status), JSON.stringify(twoOut));
          else if (first === 'related' && side === 'target') {
            assert.equal(twoOut.status, 409, JSON.stringify(twoOut)); assert.equal(twoOut.body.code, 'REPORT_DRAFT_CONFLICT');
          } else if (first === 'other') {
            assert.equal(twoOut.status, 409, JSON.stringify(twoOut));
            assert.equal(twoOut.body.relatedInsert.reason, side === 'source' ? 'SOURCE_CHANGED' : 'DRAFT_CONFLICT');
          } else assert.equal(twoOut.status, 201, JSON.stringify(twoOut));
        });
      }
    });

    await t.test('T5 Tech Note and native signer finish in both acquisition orders', async t => {
      for (const first of ['tech', 'native']) await t.test(first, async () => {
        const uid = await signed(), actions = { tech: note(uid), native: await commit(uid, 'addendum') };
        const holder = await hold(tx => tx.$executeRawUnsafe('LOCK TABLE "ReportVersion", "TechNoteRevision" IN SHARE MODE'));
        let one, two, answers;
        try {
          one = actions[first]();
          const [writer] = await waitFor(holder.pid, 'tech-native-first');
          const held = await keys(writer.pid, [uid]);
          assert.ok(held[0].rows.some(row => row.granted));
          assert.equal(await rowProbe(uid), '55P03');
          two = actions[first === 'tech' ? 'native' : 'tech']();
          const [waiter] = await waitFor(writer.pid, 'tech-native-second');
          const waiting = await keys(waiter.pid, [uid]);
          assert.ok(waiting[0].rows.some(row => !row.granted) || first === 'native' && waiter.query.includes('StudyState'));
        } finally { await holder.end(); answers = await Promise.all([one, two]); log('tech-native-results', { first, answers }); }
        assert.ok(answers.every(out => out.status === 201), JSON.stringify(answers));
        assert.equal((await witness.report.findUnique({ where: { uid } })).version, 2);
        assert.equal(await witness.techNoteRevision.count({ where: { studyUid: uid } }), 1);
      });
    });

    await t.test('T4 reciprocal Related writes serialize on the complete sorted set', async () => {
      const a = await signed(), b = await signed();
      const ab = await insertion(a, b), ba = await insertion(b, a);
      const holder = await hold(tx => tx.$executeRawUnsafe('LOCK TABLE "ReportDraft" IN SHARE MODE'));
      let first, second, answers;
      try {
        first = send(a, '/report', ab);
        const [writer] = await waitFor(holder.pid, 'reciprocal-first');
        const held = await keys(writer.pid, [a, b].sort());
        assert.ok(held.every(k => k.rows.some(r => r.granted)));
        second = send(b, '/report', ba);
        const [waiter] = await waitFor(writer.pid, 'reciprocal-second');
        const waiting = await keys(waiter.pid, [a, b].sort());
        assert.equal(waiting[0].rows[0].granted, false);
        assert.equal(waiting[1].rows.length, 0, 'cannot take the second key before the first');
      } finally { await holder.end(); answers = await Promise.all([first, second]); }
      assert.deepEqual(answers.map(out => out.status), [200, 200], JSON.stringify(answers));
      assert.equal((await draft(a)).snapshot.findings, ab.findings);
      assert.equal((await draft(b)).snapshot.findings, ba.findings);
    });

    let rolledBackAttempt;
    await t.test('T8 deferred COMMIT rollback must never answer applied', async () => {
      const source = await signed(), target = await fresh(), body = await insertion(target, source);
      rolledBackAttempt = { target, body };
      // A deferred constraint reaches COMMIT, after the real draft/receipt/B work.
      await witness.$executeRawUnsafe(`CREATE FUNCTION public.wr_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'SYN WR deferred rollback' USING ERRCODE='23514'; END $$`);
      await witness.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER wr_fail_commit AFTER INSERT ON "ReportDraftInsertReceipt"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.wr_fail_commit()`);
      let failed;
      try { failed = await send(target, '/report', body); }
      finally {
        await witness.$executeRawUnsafe('DROP TRIGGER wr_fail_commit ON "ReportDraftInsertReceipt"');
        await witness.$executeRawUnsafe('DROP FUNCTION public.wr_fail_commit()');
      }
      const id = body.relatedInsert.insertRequestId;
      const receipts = await witness.reportDraftInsertReceipt.count({ where: { insertRequestId: id } });
      const drafts = await witness.reportDraft.count({ where: { uid: target } });
      log('deferred-rollback', { failed, receipts, drafts });
      assert.equal(receipts, 0); assert.equal(drafts, 0);
      assert.notEqual(failed.status, 200, 'E3: false applied is a finding, never hidden by a new judgement layer');
    });

    await t.test('T8/T10 the same ID recovers after rollback; committed answer loss and atomic writes', async () => {
      // Keep this control executable even when the separate E3 assertion fails.
      assert.ok(rolledBackAttempt, 'the prior rollback control reached its real input');
      const { target, body } = rolledBackAttempt, id = body.relatedInsert.insertRequestId;
      const applied = await send(target, '/report', body);
      // A separate witness sees the durable result BEFORE the client loses it.
      const [atomic] = await witness.$queryRaw`SELECT d.xmin::text AS draft_tx, r.xmin::text AS receipt_tx,
        a.xmin::text AS audit_tx FROM "ReportDraft" d, "ReportDraftInsertReceipt" r, "AuditLog" a
        WHERE d.uid=${target} AND r."insertRequestId"=${id}::uuid AND a.target=${target} AND a.action='report.draft'`;
      const ledger = await witness.$queryRaw`SELECT DISTINCT xmin::text AS xid FROM emr_access.access_entry
        WHERE payload::jsonb->>'surface'='PUT studies/:uid/report' AND payload::jsonb->'context'->>'studyId'=${target}
        AND payload::jsonb->>'action'='draft-save'`;
      log('committed-body-held', { applied, atomic, ledger });
      assert.equal(applied.status, 200); assert.ok(atomic);
      assert.equal(atomic.draft_tx, atomic.receipt_tx); assert.equal(atomic.draft_tx, atomic.audit_tx);
      assert.ok(ledger.length); assert.ok(ledger.every(r => r.xid === atomic.draft_tx));
      const check = await send(target, '/draft?insertRequestId=' + id), replay = await send(target, '/report', body);
      assert.equal(check.body.relatedInsert.state, 'applied'); assert.equal(replay.status, 200);
      assert.equal(replay.body.revision, applied.body.revision); assert.equal((await draft(target)).snapshot.findings, body.findings);
    });
  } finally {
    if (app) await app.close();
    if (ready) await runtime.stop(Date.now() + 10000);
    await witness.$disconnect(); await new Promise(resolve => provider.close(resolve));
  }
});
