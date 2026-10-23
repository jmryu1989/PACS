'use strict';
// PG-02/03/04 adapter stage: real public adapter + independent SQL connection.
// This is not the required Nest/HTTP API-01 evidence or a production-image run.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const build = process.env.KIN_B2R_BUILD;
if (!build) throw new Error('Compiled candidate path required');
const { PrismaClient } = require('@prisma/client');
const { AccessLedgerStore } = require(path.join(build, 'emr-runtime/store.js'));
const { EmrLedgerClient } = require(path.join(build, 'emr-runtime/client.js'));
const { FailureJournal, FailureSpool } = require(path.join(build, 'emr-runtime/failure-journal.js'));
const { verifyRuntimeConnection } = require(path.join(build, 'emr-runtime/manifest.js'));
const { provideAfterReceipt } = require(path.join(build, 'emr-runtime/contract.js'));
const known = value => ({ status: 'known', value });

async function main() {
  const db = new EmrLedgerClient(process.env.DATABASE_URL);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL));
  const store = new AccessLedgerStore(db, journal);
  try {
    await db.$connect(); await witness.$connect();
    await verifyRuntimeConnection(db);
    const id = await store.resolveIdentity(db, 'synthetic-issuer', 'doctor-a');
    assert.equal(await store.resolveIdentity(db, 'synthetic-issuer', 'doctor-a'), id);
    assert.notEqual(await store.resolveIdentity(db, 'another-issuer', 'doctor-a'), id);
    const event = {
      formatVersion: 1, surface: 'POST studies/:uid/report/commit', eventId: randomUUID(),
      userId: known({ id, issuer: 'synthetic-issuer', subject: 'doctor-a' }), rolesAtTime: known(['radiologist']),
      actingInstitution: known('synthetic-hospital'), managingInstitution: known('synthetic-hospital'),
      occurredAt: new Date().toISOString(), trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }),
      cause: 'user-view', context: { basis: 'out-of-context', studyId: null, relatedStudyId: null, reason: null },
      executor: 'member', targets: [{ kind: 'report-version',
        patientLinkSnapshot: known({ linkId: 'synthetic-link', patientId: 'synthetic-patient', assigningAuthority: 'synthetic-hospital' }),
        studyId: known('synthetic-study'), recordId: known('synthetic-report'), versionId: known('v1') }],
      action: 'write', result: 'succeeded', requestId: randomUUID(), auditLinkId: 'audit:' + randomUUID(), relatedEventId: null,
    };
    await witness.$executeRawUnsafe('CREATE TABLE public.b2r_effect(id text PRIMARY KEY, n integer NOT NULL)');
    await witness.$executeRawUnsafe('GRANT SELECT,INSERT,UPDATE ON public.b2r_effect TO kin_runtime');
    const keys = { operationId: randomUUID(), attemptId: randomUUID() };
    const operation = await store.admit(event, undefined, keys);
    let callbacks = 0;
    const effect = async tx => {
      callbacks++;
      await tx.$executeRaw`INSERT INTO public.b2r_effect VALUES ('effect',1)`;
      return { kind: 'synthetic-fixture', id: 'effect', version: 'v1' };
    };
    const results = await Promise.all([store.transaction(operation,effect),store.transaction(operation,effect)]);
    assert.equal(callbacks,1);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].entries.length,2);
    const [counts] = await witness.$queryRaw`SELECT (SELECT count(*)::int FROM public.b2r_effect) AS effects,
      (SELECT count(*)::int FROM emr_access.access_entry WHERE event_id=${event.eventId}) AS entries`;
    assert.equal(counts.effects,1); assert.equal(counts.entries,2);
    const retry = await store.admit(event,undefined,{operationId:randomUUID(),attemptId:randomUUID()});
    const repeated = await store.transaction(retry,async()=>{ throw new Error('Replay executed business callback'); });
    assert.deepEqual(repeated,results[0]);
    await assert.rejects(store.admit({...event, occurredAt:'2020-01-01T00:00:00.000Z'},undefined,keys));

    const failed = await store.admit({...event,eventId:randomUUID(),requestId:randomUUID()});
    await assert.rejects(store.transaction(failed,async tx=>{
      await tx.$executeRaw`INSERT INTO public.b2r_effect VALUES ('rolled-back',1)`;
      throw new Error('Observed business refusal');
    }),/Observed business refusal/);
    const [rollback] = await witness.$queryRaw`SELECT
      (SELECT count(*)::int FROM public.b2r_effect WHERE id='rolled-back') AS effects,
      (SELECT count(*)::int FROM emr_access.access_entry WHERE operation_id=${failed.operationId}::uuid) AS entries,
      (SELECT count(*)::int FROM emr_access.failure_entry WHERE operation_id=${failed.operationId}::uuid) AS failures`;
    assert.equal(rollback.effects,0); assert.equal(rollback.entries,0); assert.equal(rollback.failures,1);
    assert.equal((await store.lookup(failed.operationId)).outcome,'negative');

    const pending = await store.admit({...event,eventId:randomUUID(),requestId:randomUUID()});
    let unlock, locked;
    const release = new Promise(resolve=>unlock=resolve), acquired = new Promise(resolve=>locked=resolve);
    const held = witness.$transaction(async tx=>{
      await tx.$queryRaw`SELECT emr_access.lock_operation(${pending.operationId}::uuid)`;
      locked(); await release;
    },{timeout:15000});
    await acquired;
    let resolved = false;
    const settling = store.settle(pending.operationId).then(r=>{resolved=true;return r;});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(resolved,false);
    const [before] = await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.attempt_outcome WHERE operation_id=${pending.operationId}::uuid`;
    assert.equal(before.n,0);
    unlock(); await held;
    assert.equal((await settling).outcome,'negative');

    const view = {...event,eventId:randomUUID(),requestId:randomUUID(),surface:'GET studies/:uid/report/versions',action:'provide-prepared',result:'prepared'};
    let bodies = 0;
    await provideAfterReceipt(store,view,async receipt=>{
      const [recorded] = await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.access_entry WHERE event_id=${receipt.eventId}`;
      assert.equal(recorded.n,1); bodies++;
    });
    assert.equal(bodies,1);
    console.log(JSON.stringify({status:'PASS',boundary:'real PostgreSQL public adapter',cases:['identity','duplicate callback suppression','atomic dual','independent failure','locked settlement','receipt before callback'],api_http:'NOT_RUN'}));
  } finally {
    const results = await Promise.allSettled([journal.close(),db.$disconnect(),witness.$disconnect()]);
    if (results.some(r=>r.status==='rejected')) throw new Error('Fixture cleanup failed');
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
