"""REQ-A-METADATA / A-HTTP-METADATA, A-PG-COMMIT, A-HTTP-OUTCOME.

The real AppModule, Guard, W9 route, Orthanc HTTP client and A1/B2 PG port run
against owned synthetic PG/JWKS/QIDO fixtures. No replacement route or receipt.
The embedded Node driver keeps the single A3 test entry point self-contained.
"""
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/emr/b'))
from pg_ledger_restore_test import PgLedgerFixture


DRIVER = r"""
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const build = process.env.KIN_B2R_BUILD;
const api = createRequire(path.join(build, '../package.json'));
api('reflect-metadata');
const { NestFactory } = api('@nestjs/core');
const { PrismaClient } = api('@prisma/client');
const jose = api('jose');
const load = name => require(path.join(build, name + '.js'));
const { AppModule } = load('app.module');
const { EmrRuntime } = load('emr-runtime/application');
const { VIEWING_SET_LIMITS } = load('multi-study-view.service');
const { EMR_TX_TIMEOUT_MS } = load('emr-runtime/limits');
const { parseAccessEvent } = load('emr-contract/access-event');
const site = 'SYN-A3-site', subject = 'SYN-A3-doctor', patient = 'SYN-A3-patient';
const issuer = 'https://synthetic.invalid/realms/a3';
const known = value => ({ status: 'known', value });
const rows = new Map(), reads = [], sourceWaits = new Map(), sourceDelays = new Map();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function row(uid, pid = patient) {
  return { '0020000D': { vr: 'UI', Value: [uid] }, '00100020': { vr: 'LO', Value: [pid] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'SYN^Patient' }] },
    '00080080': { vr: 'LO', Value: ['SYN Source Hospital'] }, '00080020': { vr: 'DA', Value: ['20261025'] },
    '00080061': { vr: 'CS', Value: ['CT', 'SR'] }, '00081030': { vr: 'LO', Value: ['SYN metadata ' + uid] },
    '00080050': { vr: 'SH', Value: ['SYN accession'] } };
}
const selection = uids => ({ compositionId: randomUUID(), generation: 1, requestId: randomUUID(),
  expectedSourcePatientKey: null, studyUids: uids });

async function main() {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'a3-fixture', alg: 'RS256', use: 'sig' };
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url, 'http://synthetic.invalid');
    if (url.pathname === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname !== '/dicom-web/studies') { res.statusCode = 404; return res.end('{}'); }
    const uid = url.searchParams.get('StudyInstanceUID'); reads.push(uid);
    if (sourceDelays.has(uid)) await pause(sourceDelays.get(uid));
    if (sourceWaits.has(uid)) await sourceWaits.get(uid);
    if (!res.destroyed) res.end(JSON.stringify(rows.get(uid) || []));
  });
  await listen(upstream);
  const external = 'http://127.0.0.1:' + upstream.address().port;
  Object.assign(process.env, { KC_ISSUER: issuer, KC_JWKS_URL: external + '/certs', KC_AUDIENCE: 'kin-api',
    AUTH_REQUIRED: 'true', KC_WEB_SECRET: randomUUID(), KIN_COOKIE_SECRET: randomUUID(),
    PUBLIC_ORIGIN: 'https://synthetic.invalid', ORTHANC_URL: external, ORTHANC_USER: 'synthetic', ORTHANC_PASS: randomUUID() });
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_B2R_SPOOL);
  let app, releaseLock, holding, releaseSource;
  try {
    await witness.$connect();
    await witness.institution.create({ data: { id: site, name: 'SYN A3 Hospital' } });
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    await witness.memberRights.create({ data: { sub: subject, username: subject, email: subject + '@example.test',
      name: 'Synthetic doctor', emailVerified: true, approved: true, suspended: false, institution: site,
      roles: ['radiologist'] } });
    const token = await new jose.SignJWT({ email: subject + '@example.test', groups: ['/' + site],
      realm_access: { roles: ['radiologist'] } }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(issuer).setSubject(subject).setAudience('kin-api').setIssuedAt().setExpirationTime('10m').sign(privateKey);
    await runtime.start();
    app = await NestFactory.create(AppModule.withLedger(runtime), { rawBody: true, logger: ['error'], abortOnError: false });
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl(), headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
    const events = async () => (await witness.$queryRaw`SELECT payload FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface'='POST studies/viewing-set/resolve' ORDER BY sequence`).map(r => JSON.parse(r.payload));
    const forUid = async uid => (await events()).filter(e => e.targets[0].studyId.value === uid);
    const until = async probe => {
      const end = performance.now() + EMR_TX_TIMEOUT_MS;
      for (;;) {
        const result = await probe(); if (result) return result;
        assert.ok(performance.now() < end, 'PG observation exceeded the existing B2 transaction deadline');
        await pause(10);
      }
    };
    let serial = 0;
    const study = async (opts = {}) => {
      const uid = '2.25.730' + (++serial);
      if (!opts.missing) await witness.studyState.create({ data: { uid, institutionId: opts.site || site,
        ss: 'Verified', ts: 'none' } });
      rows.set(uid, opts.split ? [row(uid), row(uid, 'SYN-other-patient')] : [row(opts.wrongUid || uid, opts.patient || patient)]);
      return uid;
    };
    const send = async (input, { signal, onFirstByte } = {}) => {
      const response = await fetch(origin + '/api/studies/viewing-set/resolve', {
        method: 'POST', headers, body: JSON.stringify(input), signal });
      const chunks = []; let first = true;
      for await (const chunk of response.body) {
        if (first) { first = false; if (response.status === 200 && onFirstByte) await onFirstByte(); }
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString();
      return { status: response.status, text, body: JSON.parse(text) };
    };
    const verify = async (input, response, readyUids) => {
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.compositionId, input.compositionId);
      assert.equal(response.body.requestId, input.requestId);
      assert.equal(response.body.generation, input.generation);
      const ready = response.body.members.filter(m => m.status === 'ready');
      assert.deepEqual(ready.map(m => m.uid), readyUids);
      for (const member of ready) {
        const recorded = await until(async () => {
          const found = (await forUid(member.uid)).filter(e => e.eventId === member.accessRef || e.relatedEventId === member.accessRef);
          return found.length === 2 ? found : null;
        });
        const event = recorded.find(e => e.action === 'provide-prepared');
        assert.ok(event, 'actual durable receipt refers to prepared metadata');
        parseAccessEvent(event);
        assert.equal(recorded.find(e => e.relatedEventId === event.eventId).action, 'transfer-ended');
        assert.equal(event.userId.value.issuer, issuer); assert.equal(event.userId.value.subject, subject);
        assert.deepEqual(event.rolesAtTime.value, ['radiologist']);
        assert.deepEqual(event.session, { method: 'bearer', sessionRef: null });
        assert.equal(event.actingInstitution.value, site); assert.equal(event.managingInstitution.value, site);
        assert.notEqual(event.requestId, input.requestId);
        assert.equal(event.context.studyId, readyUids.includes(input.studyUids[0]) ? input.studyUids[0] : member.uid);
        assert.equal(event.context.basis, readyUids.includes(input.studyUids[0]) && member.ordinal !== 0
          ? 'same-patient-comparison' : 'worklist');
        assert.deepEqual(event.targets[0].studyId, known(member.uid));
        assert.deepEqual(event.targets[0].recordId, known(member.uid));
        assert.deepEqual(event.targets[0].versionId, { status: 'unresolved', reason: 'not-observed' });
        assert.deepEqual(event.targets[0].sourcePatientId, known(member.metadata.patientId));
        assert.deepEqual(event.targets[0].sourceInstitution, known(member.metadata.institutionName));
        assert.equal(event.targets[0].projectionSha256, createHash('sha256').update(JSON.stringify(member.metadata)).digest('hex'));
        assert.deepEqual(member.metadata, { patientId: patient, patientName: 'SYN Patient', institutionName: 'SYN Source Hospital',
          studyDate: '20261025', modalities: ['CT', 'SR'], description: 'SYN metadata ' + member.uid, accession: 'SYN accession' });
      }
      for (const member of response.body.members.filter(m => m.status === 'error')) {
        assert.equal('metadata' in member, false); assert.equal('accessRef' in member, false);
        assert.equal((await forUid(member.uid)).length, 0);
      }
    };

    const a = await study(), b = await study(), readyInput = selection([a, b]);
    const ready = await send(readyInput, { onFirstByte: async () => {
      for (const uid of [a, b]) assert.equal((await forUid(uid)).filter(e => e.action === 'provide-prepared').length, 1,
        'all target commits precede the first clinical HTTP byte');
    } });
    await verify(readyInput, ready, [a, b]); assert.equal(ready.body.scopeStatus, 'ready');
    console.log('PASS ready / actual AppModule binding / PG before first byte / exact target / request attribution / selected response end');

    const missing = await study({ missing: true }), partialUid = await study(), partialInput = selection([missing, partialUid]);
    const partial = await send(partialInput); await verify(partialInput, partial, [partialUid]);
    assert.equal(partial.body.scopeStatus, 'partial'); assert.equal(partial.body.members[1].ordinal, 1);
    assert.equal(reads.includes(missing), false);
    const split = await study({ split: true }), otherSite = await study({ site: 'SYN-other-site' });
    const errorInput = selection([split, otherSite]), errorOnly = await send(errorInput);
    await verify(errorInput, errorOnly, []); assert.equal(errorOnly.body.scopeStatus, 'rejected');
    assert.equal(errorOnly.body.members[0].code, 'STUDY_IDENTITY_UNRESOLVED');
    assert.equal(reads.includes(otherSite), false);
    const mismatch = await study({ patient: 'SYN-other-patient' }), mismatchPartner = await study();
    const rejected = await send(selection([mismatch, mismatchPartner])); assert.equal(rejected.status, 409);
    assert.equal((await forUid(mismatch)).length + (await forUid(mismatchPartner)).length, 0);
    const wrong = await study({ wrongUid: '2.25.999' }), absent = await study({ missing: true });
    const wrongReply = await send(selection([wrong, absent])); assert.equal(wrongReply.body.members[0].code, 'W9_LOAD_FAILED');
    assert.equal((await forUid(wrong)).length, 0);
    assert.equal((await send({ ...selection([a, b]), studyUids: [a, a] })).status, 400);
    console.log('PASS partial ordinal and anchor / error-only / denied source unread / split patient source / mismatched patient and source UID / invalid input');

    // Lose delivery of one actual committed receipt at the public work port.
    // The underlying append, lookup and confirm still use the real PG adapter;
    // no fabricated receipt or product fault switch participates.
    const lost = await study(), lostPartner = await study(), lostInput = selection([lost, lostPartner]);
    const begin = runtime.port.begin, appendKeys = [], lookedUp = [];
    runtime.port.begin = () => {
      const work = begin(), append = work.append, lookup = work.lookup;
      work.append = async (event, served, keys) => {
        const receipt = await append(event, served, keys);
        if (event.action === 'provide-prepared' && event.targets[0].studyId.value === lost) {
          appendKeys.push(keys); throw new Error('Synthetic receipt delivery lost after COMMIT');
        }
        return receipt;
      };
      work.lookup = async id => { lookedUp.push(id); return lookup(id); };
      return work;
    };
    try {
      await verify(lostInput, await send(lostInput), [lost, lostPartner]);
      assert.equal(appendKeys.length, 1); assert.deepEqual(lookedUp, [appendKeys[0].operationId]);
    } finally { runtime.port.begin = begin; }
    console.log('PASS lost committed receipt delivery / same operation PG lookup and confirm / no replacement append');

    const unknownUid = await study(), unknownPartner = await study(), unknownKeys = [], unknownLookups = [];
    runtime.port.begin = () => {
      const work = begin(), append = work.append, lookup = work.lookup;
      work.append = async (event, served, keys) => {
        if (event.action === 'provide-prepared' && event.targets[0].studyId.value === unknownUid) {
          await work.admit(event, served, keys); unknownKeys.push(keys);
          throw new Error('Synthetic interruption after actual admission; COMMIT unobserved');
        }
        return append(event, served, keys);
      };
      work.lookup = async id => { const result = await lookup(id); unknownLookups.push({ id, outcome: result?.outcome }); return result; };
      return work;
    };
    try {
      const unknown = await send(selection([unknownUid, unknownPartner]));
      assert.equal(unknown.status, 503); assert.equal(unknown.body.members, undefined);
      assert.equal(unknownKeys.length, 1);
      assert.deepEqual(unknownLookups, [{ id: unknownKeys[0].operationId, outcome: 'pending' }]);
      assert.equal((await forUid(unknownUid)).length + (await forUid(unknownPartner)).length, 0);
    } finally { runtime.port.begin = begin; }
    console.log('PASS actual pending PG operation remains unknown / no clinical body or replacement append');

    const first = await study(), last = await study();
    await witness.$executeRawUnsafe(`ALTER TABLE emr_access.access_entry ADD CONSTRAINT a3_fixture_refusal
      CHECK (payload::jsonb->'targets'->0->'recordId'->>'value' <> '${last}')`);
    try {
      const failed = await send(selection([first, last])); assert.equal(failed.status, 503);
      assert.equal(failed.text.includes('SYN metadata'), false); assert.equal(failed.body.members, undefined);
      const prior = await until(async () => { const e = await forUid(first); return e.length === 2 && e; });
      assert.deepEqual(prior.map(e => e.action).sort(), ['provide-prepared', 'transfer-aborted']);
      assert.equal((await forUid(last)).length, 0);
    } finally { await witness.$executeRawUnsafe('ALTER TABLE emr_access.access_entry DROP CONSTRAINT a3_fixture_refusal'); }
    console.log('PASS last target SQL failure / prior commit retained / entire clinical body refused / aborted follow-up');

    const lock = async () => {
      let entered; const acquired = new Promise(resolve => { entered = resolve; });
      const release = new Promise(resolve => { releaseLock = resolve; });
      holding = witness.$transaction(async tx => {
        await tx.$executeRawUnsafe('LOCK TABLE emr_access.access_entry IN SHARE MODE'); entered(); await release;
      }, { timeout: 15000 }); // Existing B2 transaction/fixture hang timeout.
      await acquired;
    };
    const waitAppend = () => until(async () => {
      const [row] = await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename='kin_runtime' AND wait_event_type='Lock' AND query LIKE '%append_operation%'`;
      return row.n > 0;
    });
    const refusedUid = await study(), refusedPartner = await study();
    await lock();
    const refusedBody = send(selection([refusedUid, refusedPartner]));
    try {
      await waitAppend();
      await witness.studyAccessPolicy.create({ data: { institution: site, subject, revision: 1,
        reason: 'Synthetic ordinary policy edit', updatedBy: subject,
        policy: { version: 1, restricted: true, startsAt: null, endsAt: null, rules: [] } } });
      releaseLock(); await holding; holding = null;
      const refused = await refusedBody;
      assert.equal(refused.status, 409); assert.equal(refused.body.members, undefined);
      for (const uid of [refusedUid, refusedPartner]) {
        const recorded = await until(async () => { const e = await forUid(uid); return e.length === 2 && e; });
        assert.deepEqual(recorded.map(e => e.action).sort(), ['provide-prepared', 'transfer-aborted']);
      }
    } finally {
      releaseLock(); if (holding) await holding; holding = null;
      await witness.studyAccessPolicy.delete({ where: { institution_subject: { institution: site, subject } } });
    }
    console.log('PASS existing outer policy interceptor refusal / selected metadata never consumed / aborted outcomes only');

    for (const cause of ['close', 'deadline']) {
      console.log('BEGIN cancellation observation ' + cause);
      const late = await study(), second = await study(), controller = new AbortController();
      const cancellationUids = [late, second];
      if (cause === 'deadline') {
        while (cancellationUids.length <= VIEWING_SET_LIMITS.concurrentReads) cancellationUids.push(await study());
        // Two source waves consume the existing 8 s allowance without hitting
        // Orthanc's existing 5 s per-fetch limit; the ledger wait is then <3 s.
        const waves = Math.ceil(cancellationUids.length / VIEWING_SET_LIMITS.concurrentReads);
        const delay = (VIEWING_SET_LIMITS.servedReadCutMs
          - (VIEWING_SET_LIMITS.deadlineMs - VIEWING_SET_LIMITS.servedReadCutMs)) / waves;
        for (const uid of cancellationUids) sourceDelays.set(uid, delay);
      }
      await lock(); let bytes = false;
      const started = performance.now();
      const pending = send(selection(cancellationUids), { signal: controller.signal, onFirstByte: () => { bytes = true; } })
        .then(value => ({ value }), error => ({ error }));
      try {
        await waitAppend(); assert.equal(bytes, false);
        if (cause === 'close') { controller.abort(); await pending; }
        else await pause(Math.max(0, VIEWING_SET_LIMITS.deadlineMs - (performance.now() - started)) + 100);
        assert.equal(bytes, false, 'no clinical body while receipt is pending');
        releaseLock(); await holding; holding = null;
        const answer = await pending;
        console.log(JSON.stringify({ cancellation: cause, status: answer.value?.status,
          error: answer.error?.name, eventsAfterRelease: (await forUid(late)).map(e => e.action) }));
        if (cause === 'deadline') { assert.equal(answer.value.status, 503); assert.equal(answer.value.body.members, undefined); }
        const recorded = await until(async () => { const e = await forUid(late); return e.length === 2 && e; });
        assert.deepEqual(recorded.map(e => e.action).sort(), ['provide-prepared', 'transfer-aborted']);
        for (const uid of cancellationUids.slice(1)) assert.equal((await forUid(uid)).length, 0);
      } finally {
        for (const uid of cancellationUids) sourceDelays.delete(uid);
        releaseLock(); if (holding) await holding; holding = null;
      }
    }
    console.log('PASS close and existing deadline / late actual PG receipt / original work drains / no second target');

    const slow = await study(), fast = [];
    for (let i = 0; i < VIEWING_SET_LIMITS.concurrentReads; i++) {
      const uid = await study(); fast.push(uid); sourceDelays.set(uid, VIEWING_SET_LIMITS.servedReadCutMs / 2);
    }
    sourceWaits.set(slow, new Promise(resolve => { releaseSource = resolve; }));
    const cutInput = selection([...fast, slow]);
    const cutReply = await send(cutInput);
    await verify(cutInput, cutReply, fast); assert.equal(cutReply.body.members[fast.length].code, 'W9_LOAD_FAILED');
    for (const uid of fast) sourceDelays.delete(uid);
    releaseSource(); sourceWaits.delete(slow);
    console.log('PASS existing source read cutoff / partial target receipt');

    const stoppingUid = await study(), stoppingPartner = await study(), stoppingInput = selection([stoppingUid, stoppingPartner]);
    await lock();
    const duringStop = send(stoppingInput);
    await waitAppend();
    const stopped = runtime.stop(Date.now() + 15000); // Existing B2 fixture transaction hang timeout.
    releaseLock(); await holding; holding = null;
    await verify(stoppingInput, await duringStop, [stoppingUid, stoppingPartner]);
    await stopped; assert.equal(runtime.control.live(), 0);
    console.log('PASS runtime stop drains existing request work and its observed follow-ups');
  } finally {
    releaseSource?.(); releaseLock?.(); if (holding) await holding;
    if (app) await app.close(); else await runtime.stop(Date.now() + 5000);
    await witness.$disconnect();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
"""


class ViewingSetHttpBoundary(PgLedgerFixture):
    def test_metadata_receipts_and_response_outcomes(self):
        evidence = ROOT / 'tmp/module-a-03' / self.token
        evidence.mkdir(parents=True, exist_ok=True)
        driver = evidence / 'viewing-set.cjs'
        driver.write_text(DRIVER, encoding='utf-8')
        env = {**os.environ, 'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
               'KIN_B2R_SPOOL': str(evidence / 'spool')}
        if self.image:
            command = ['docker', 'run', '--rm', '--name', self.container + '-node', '--label', 'kin.b2r=' + self.token,
                       '--network', self.network, '--mount', 'type=bind,source=' + str(driver) + ',target=/app/viewing-set.cjs,readonly']
            for key, value in {'DATABASE_URL': self.runtime_url, 'KIN_B2R_WITNESS_URL': self.witness_url,
                               'KIN_B2R_BUILD': '/app/dist', 'KIN_B2R_SPOOL': '/tmp/a3-spool'}.items():
                command += ['-e', key + '=' + value]
            command += [self.image, 'node', '/app/viewing-set.cjs']
        else:
            command = [os.environ['KIN_B2R_NODE'], str(driver)]
        try:
            result = self.command(command, env=env, check=False, timeout=120)  # Existing A1 PG driver hang timeout.
        except subprocess.TimeoutExpired as error:
            # Keep partial raw output and omit ephemeral fixture credentials
            # from unittest's command-line traceback.
            for name, value in [('stdout', error.stdout), ('stderr', error.stderr)]:
                raw = value if isinstance(value, bytes) else (value or '').encode('utf-8')
                (evidence / ('node.' + name + '.log')).write_bytes(raw)
            raise RuntimeError('Node fixture timed out; partial logs: ' + str(evidence)) from None
        (evidence / 'node.stdout.log').write_text(result.stdout, encoding='utf-8')
        (evidence / 'node.stderr.log').write_text(result.stderr, encoding='utf-8')
        print(result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:] or result.stdout[-3000:])


if __name__ == '__main__':
    unittest.main(verbosity=2)
