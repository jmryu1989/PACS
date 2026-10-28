'use strict';
// Each selected case names its boundary: compiled PG adapter, real Nest route,
// or AppModule scale/restart. A result covers only that selected case.
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
const { EMR_BACKGROUND_WORK } = require(path.join(build, 'emr-runtime/background-work.js'));
const { StudyTransferLocalService } = require(path.join(build, 'study-transfer-local.service.js'));
const { PresenceService } = require(path.join(build, 'presence.service.js'));
const { provideAfterReceipt } = require(path.join(build, 'emr-runtime/contract.js'));
const { createRequestContext, REQUEST_CONTEXT_CAPTURE, REQUEST_CONTEXT_SOURCE } = require(path.join(build, 'emr-runtime/request-context.js'));
const { createRequestIngress } = require(path.join(build, 'emr-runtime/request-ingress.js'));
function requestProviders(port) {
  const requests = createRequestContext(createRequestIngress({ proxyPeers: ['127.0.0.1'] }), port);
  return [{ provide: REQUEST_CONTEXT_CAPTURE, useValue: requests.capture },
    { provide: REQUEST_CONTEXT_SOURCE, useValue: requests.source }];
}
const known = value => ({ status: 'known', value });

async function requestWork() {
  const { createRecordPort } = require(path.join(build, 'emr-runtime/record-port.js'));
  const db = new EmrLedgerClient(process.env.DATABASE_URL);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const journal = new FailureJournal(db, new FailureSpool(process.env.KIN_B2R_SPOOL));
  const { port, control } = createRecordPort(new AccessLedgerStore(db, journal));
  const work = port.begin();
  let release, blocker;
  try {
    await db.$connect(); await witness.$connect();
    const ids = await Promise.all([work.resolveRequestIdentity('request-issuer', 'same-name'),
      work.resolveRequestIdentity('request-issuer', 'same-name')]);
    assert.equal(ids[0], ids[1]);
    assert.notEqual(await work.resolveRequestIdentity('another-issuer', 'same-name'), ids[0]);
    assert.notEqual(await work.resolveRequestIdentity('request-issuer', 'another-subject'), ids[0]);
    const [persisted] = await witness.$queryRaw`SELECT emr_access.resolve_member_identity('request-issuer','same-name')::text AS id`;
    assert.equal(persisted.id, ids[0]);

    // Hold a genuine identity insert open. Request end/port close must retain the
    // transaction's drain ownership until PG finishes; no fake transaction seam.
    let entered;
    const holding = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    blocker = witness.$transaction(async tx => {
      await tx.$queryRaw`SELECT emr_access.resolve_member_identity('request-issuer','held-subject')`;
      entered(); await gate;
    }, { timeout: 15000 });
    await holding;
    const pending = work.resolveRequestIdentity('request-issuer', 'held-subject');
    const outcome = pending.then(() => 'unexpected-success', error => error.message);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const [row] = await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename='kin_runtime' AND wait_event_type='Lock'`;
      if (row.n) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'Identity transaction must reach the actual PG wait');
    work.end(); control.close();
    assert.equal(control.live(), 1);
    let drained = false;
    const drain = control.drained().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.throws(() => port.begin(), /EmrRecordPortClosed/);
    release(); await blocker;
    assert.match(await outcome, /EmrRecordWorkEnded/);
    await drain;
    assert.equal(control.live(), 0);
    await assert.rejects(work.resolveRequestIdentity('request-issuer', 'after-end'), /EmrRecordWorkEnded/);
    const [absent] = await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.member_identity WHERE subject='after-end'`;
    assert.equal(absent.n, 0);
    console.log(JSON.stringify({ status: 'PASS', boundary: 'request-work + real PG identity/lock + independent witness',
      cases: ['same identity concurrent', 'issuer/subject separation', 'persisted identity', 'inflight drain', 'ended work refusal'] }));
  } finally {
    release?.(); if (blocker) await blocker;
    work.end(); control.close(); await control.drained();
    await journal.close(); await db.$disconnect(); await witness.$disconnect();
  }
}

async function main() {
  if (process.env.KIN_B2R_CASE === 'clinical-http') return clinicalHttp();
  if (process.env.KIN_B2R_CASE === 'scale-server') return scaleServer();
  if (process.env.KIN_B2R_CASE === 'failure-files') return failureFiles();
  if (process.env.KIN_B2R_CASE === 'concurrency') return concurrentReceipts();
  if (process.env.KIN_B2R_CASE === 'crash') return processCuts();
  if (process.env.KIN_B2R_CASE === 'crash-child') return crashChild();
  if (process.env.KIN_B2R_CASE === 'retention-adapter') return retentionAdapter();
  if (process.env.KIN_B2R_CASE === 'context') return contextBoundary();
  if (process.env.KIN_B2R_CASE === 'request-work') return requestWork();
  if (process.env.KIN_B2R_CASE === 'auth-failure') return authFailure();
  if (process.env.KIN_B2R_CASE === 'auth-success') return authSuccess();
  if (process.env.KIN_B2R_CASE === 'auth-end') return authSuccess(true);
  if (process.env.KIN_B2R_CASE === 'rights') return rightsProducer();
  if (process.env.KIN_B2R_CASE === 'rights-import') return rightsImport();
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

// D1806 item 8: the real AppModule and PG adapter share this API process.
// No fixture HTTP route is introduced. Admission/commit latency is the adapter
// boundary; the separate item-4 test covers the clinical HTTP boundary.
async function scaleServer() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(build, 'app.module.js'));
  const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
  const { profile } = require('/app/pg_ledger_profile.cjs');
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_B2R_SPOOL);
  await runtime.start();
  const app = await NestFactory.create(AppModule.withLedger(runtime), { logger: false });
  app.setGlobalPrefix('api'); app.enableShutdownHooks();
  await app.listen(3000, '0.0.0.0');
  const resultPath = '/tmp/b2r-scale-result.json';
  if (fs.existsSync(resultPath)) {
    const prior = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal((await runtime.ledger.lookup(prior.lastOperationId)).outcome, 'committed');
    console.log('B2R_SCALE_READY ' + JSON.stringify({ phase: 'restarted', lastOutcome: 'committed' }));
    return;
  }
  console.log('B2R_SCALE_READY ' + JSON.stringify({ phase: 'initial' }));
  const identity = await runtime.ledger.resolveRequestIdentity('synthetic-issuer', 'doctor');
  const admissions = [], receipts = [], errors = [];
  let peakApiRssBytes = process.memoryUsage().rss, lastOperationId;
  const sample = setInterval(() => { peakApiRssBytes = Math.max(peakApiRssBytes, process.memoryUsage().rss); }, 250);
  const workload = profile.workloads[0], count = workload.perSecond * workload.seconds;
  const start = performance.now(), active = [];
  for (let n = 0; n < count; n++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, start + n * 1000 / workload.perSecond - performance.now())));
    active.push((async () => {
      const began = performance.now();
      try {
        const operation = await runtime.ledger.admit(syntheticEvent(identity));
        admissions.push(performance.now() - began);
        const result = await runtime.ledger.transaction(operation, async () => null);
        runtime.ledger.receipt(result);
        receipts.push(performance.now() - began);
        lastOperationId = operation.operationId;
      } catch (error) { errors.push(error.name + ': ' + error.message); }
    })());
  }
  await Promise.all(active);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, start + workload.seconds * 1000 - performance.now())));
  clearInterval(sample);
  peakApiRssBytes = Math.max(peakApiRssBytes, process.memoryUsage().rss);
  const p95 = values => values.slice().sort((a,b) => a-b)[Math.ceil(values.length*.95)-1];
  const result = { boundary: 'actual AppModule process / compiled PG adapter', profile: profile.id,
    seconds: (performance.now()-start)/1000, attempted: count, completed: receipts.length,
    admissionP95Ms: p95(admissions), durableReceiptP95Ms: p95(receipts),
    peakApiRssBytes, errors, lastOperationId };
  fs.writeFileSync(resultPath, JSON.stringify(result));
  console.log('B2R_SCALE_RESULT ' + JSON.stringify(result));
}

async function clinicalHttp() {
  require('reflect-metadata');
  const http = require('node:http'), jose = require('jose');
  const { Module } = require('@nestjs/common');
  const { NestFactory, APP_GUARD } = require('@nestjs/core');
  const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
  const { EMR_RECORD_PORT } = require(path.join(build, 'emr-runtime/record-port.js'));
  const { PrismaService } = require(path.join(build, 'prisma.service.js'));
  const { AuthService } = require(path.join(build, 'auth.service.js'));
  const { AuthGuard } = require(path.join(build, 'auth.guard.js'));
  const { PacsController } = require(path.join(build, 'pacs.controller.js'));
  const { PacsService } = require(path.join(build, 'pacs.service.js'));
  const { AdminController } = require(path.join(build, 'admin.controller.js'));
  const { AdminService } = require(path.join(build, 'admin.service.js'));
  const { AdminAccessReview } = require(path.join(build, 'admin-access-review.js'));
  const { StudyAccessService } = require(path.join(build, 'study-access.service.js'));
  const { OrthancService } = require(path.join(build, 'orthanc.service.js'));
  const { KeycloakService } = require(path.join(build, 'keycloak.service.js'));
  const { FindingService } = require(path.join(build, 'finding.service.js'));
  const issuer='https://synthetic.invalid/realms/clinical', institution='synthetic-hospital';
  Object.assign(process.env,{KC_ISSUER:issuer,KC_AUDIENCE:'kin-api',AUTH_REQUIRED:'true',
    KIN_COOKIE_SECRET:randomUUID(),KC_WEB_SECRET:randomUUID(),PUBLIC_ORIGIN:'https://synthetic.invalid'});
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk={...await jose.exportJWK(publicKey),kid:'clinical-fixture',alg:'RS256',use:'sig'};
  const provider=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({keys:[jwk]}));});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  process.env.KC_JWKS_URL='http://127.0.0.1:'+provider.address().port+'/certs';
  const sub='synthetic-doctor', author='synthetic-doctor@example.test';
  const token=await new jose.SignJWT({email:author,realm_access:{roles:['radiologist']},groups:['/'+institution]})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setSubject(sub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const adminSub='synthetic-http-admin';
  const adminToken=await new jose.SignJWT({email:adminSub+'@example.test',realm_access:{roles:['admin']},groups:['/'+institution]})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setSubject(adminSub).setAudience('kin-api')
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const witness=new PrismaClient({datasources:{db:{url:process.env.KIN_B2R_WITNESS_URL}}});
  const runtime=new EmrRuntime(process.env.DATABASE_URL,process.env.KIN_B2R_SPOOL);
  let app, release, blocker, restored=true;
  const appendSignature='emr_access.append_operation(uuid,uuid,text,text,text,text,text)';
  try {
    await witness.$connect();
    await witness.memberRightsImport.create({data:{id:'realm-v1'}});
    await witness.memberRights.create({data:{sub,username:sub,email:author,name:'Synthetic',emailVerified:true,
      approved:true,suspended:false,institution,roles:['radiologist']}});
    await witness.memberRights.create({data:{sub:adminSub,username:adminSub,email:adminSub+'@example.test',name:'Synthetic',
      emailVerified:true,approved:true,suspended:false,institution,roles:['admin']}});
    await runtime.start();
    const orthanc={studyIdentityResources:async uid=>[{'0020000D':{Value:[uid]}}],studyIdentities:async()=>[]};
    class ClinicalFixture {}
    // Only external collaborators are synthetic. Both routes, the draft/CAS
    // implementation, auth/rights checks and PostgreSQL are the actual product.
    Module({controllers:[PacsController,AdminController],providers:[...requestProviders(runtime.port),PrismaService,PacsService,AuthService,PresenceService,AdminService,AdminAccessReview,
      {provide:OrthancService,useValue:orthanc},{provide:KeycloakService,useValue:{}},
      {provide:FindingService,useValue:{}},
      {provide:StudyAccessService,useFactory:db=>new StudyAccessService(db,orthanc,{}),inject:[PrismaService]},
      {provide:EMR_RECORD_PORT,useValue:runtime.port},
      {provide:EMR_BACKGROUND_WORK,useValue:runtime.background.work},{provide:APP_GUARD,useClass:AuthGuard},
      // S9-U4b (#181): AuthGuard also injects the archive-grant service; the draft routes never reach it.
      {provide:StudyTransferLocalService,useValue:{}}]})(ClinicalFixture);
    app=await NestFactory.create(ClinicalFixture,{logger:['error']});app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');
    const origin=await app.getUrl();
    const headers={authorization:'Bearer '+token,'content-type':'application/json','x-real-ip':'192.0.2.22'};
    const member='synthetic-http-member';
    await witness.memberRights.create({data:{sub:member,username:member,email:member+'@example.test',name:'Synthetic',
      emailVerified:true,approved:true,suspended:false,institution,roles:['radiologist']}});
    await witness.authSession.create({data:{sid:randomUUID(),sub:member,accessToken:'synthetic-unused',refreshToken:randomUUID(),
      atExpiresAt:new Date(Date.now()+600000),lastSeenAt:new Date(),rightsVersion:1,institution}});
    const changeRights=async(body,proxyObserved=true)=>{
      const requestHeaders={...headers,authorization:'Bearer '+adminToken};if(!proxyObserved)delete requestHeaders['x-real-ip'];
      const response=await fetch(origin+'/api/admin/users/'+member,
        {method:'PATCH',headers:requestHeaders,body:JSON.stringify(body)});
      const text=await response.text();return {status:response.status,text,body:JSON.parse(text)};
    };
    const rights=await changeRights({enabled:false},false);
    assert.equal(rights.status,200,rights.text);assert.equal(rights.body.version,2);
    const [rightRow]=await witness.$queryRaw`SELECT e.payload FROM emr_access.access_entry e
      JOIN emr_access.audit_projection p ON p.event_id=e.event_id JOIN public."AuditLog" a ON a.id=p.audit_log_id
      WHERE a.target=${member} AND a.action='admin.user.suspend'`;
    const rightEvent=JSON.parse(rightRow.payload);
    assert.equal(rightEvent.userId.value.subject,adminSub);
    assert.equal(rightEvent.surface,'PATCH admin/users/:id');
    assert.deepEqual(rightEvent.trustedProxyIp,{status:'unresolved',reason:'not-observed'});
    assert.deepEqual(rightEvent.rolesAtTime.value,['admin']);
    assert.equal(rightEvent.actingInstitution.value,institution);
    const [endedRow]=await witness.$queryRaw`SELECT payload FROM emr_access.access_entry
      WHERE payload::jsonb->'auth'->>'endCause'='isolation'`;
    assert.deepEqual(JSON.parse(endedRow.payload).trustedProxyIp,{status:'unresolved',reason:'not-observed'});
    assert.equal(await witness.authSession.count({where:{sub:member}}),0);
    assert.equal((await changeRights({enabled:true})).status,200);
    const [proxyRow]=await witness.$queryRaw`SELECT e.payload FROM emr_access.access_entry e
      JOIN emr_access.audit_projection p ON p.event_id=e.event_id JOIN public."AuditLog" a ON a.id=p.audit_log_id
      WHERE a.target=${member} AND a.action='admin.user.activate'`;
    assert.deepEqual(JSON.parse(proxyRow.payload).trustedProxyIp.value,{address:'192.0.2.22',source:'trusted-proxy'});
    const red=await witness.studyState.create({data:{uid:'SYNTHETIC-http-red',institutionId:institution,ss:'Verified'}});
    const green=await witness.studyState.create({data:{uid:'SYNTHETIC-http-green',institutionId:institution,ss:'Verified'}});
    const send=async(method,uid,body,proxyObserved=true,onBody,query='')=>{
      const requestHeaders={...headers};if(!proxyObserved)delete requestHeaders['x-real-ip'];
      const response=await fetch(origin+'/api/studies/'+uid+(method==='GET'?'/draft'+query:'/report'),
        {method,headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body)});
      let text;
      if(onBody){
        const reader=response.body.getReader(),decoder=new TextDecoder();text='';
        for(;;){const {done,value}=await reader.read();if(done)break;if(value.length)onBody();text+=decoder.decode(value,{stream:true});}
        text+=decoder.decode();
      }else text=await response.text();
      return {status:response.status,text,body:JSON.parse(text)};
    };
    const input=(revision,findings)=>({expectedOwner:{institution,sub,author},expectedRevision:revision,
      findings,conclusion:'',recommendation:'',baseVersion:0,citationIds:[],structureIds:[]});
    const entries=async(uid,action)=>witness.$queryRaw`SELECT payload FROM emr_access.access_entry
      WHERE payload::jsonb->'targets'->0->'studyId'->>'value'=${uid} AND payload::jsonb->>'action'=${action}`;
    const assertRecorded=async(uid)=>assert.equal((await entries(uid,'draft-save')).length,2,'clinical write requires its committed records');
    const original=runtime.ledger.appendInTransaction;
    runtime.ledger.appendInTransaction=async()=>({provisional:true});
    try {
      assert.equal((await send('PUT',red.uid,input(red.draftEpoch+':0','SYNTHETIC omitted'))).status,200);
      await assert.rejects(assertRecorded(red.uid),/clinical write requires its committed records/);
    } finally { runtime.ledger.appendInTransaction=original; }
    const content='SYNTHETIC protected draft';
    const saved=await send('PUT',green.uid,input(green.draftEpoch+':0',content));
    assert.equal(saved.status,200,saved.text);assert.equal(saved.body.snapshot.findings,content);
    await assertRecorded(green.uid);
    const stored=(await entries(green.uid,'draft-save')).map(row=>JSON.parse(row.payload));
    assert.equal(stored[0].userId.value.subject,sub);assert.equal(stored[0].trustedProxyIp.value.address,'192.0.2.22');
    assert.equal(stored[0].targets[0].versionId.value,saved.body.revision);
    let acquired;
    const locked=new Promise(resolve=>acquired=resolve), unlock=new Promise(resolve=>release=resolve);
    blocker=witness.$transaction(async tx=>{await tx.$executeRawUnsafe('LOCK TABLE emr_access.access_entry IN ACCESS EXCLUSIVE MODE');acquired();await unlock;},{timeout:15000});
    await locked;
    let published=false;
    const reading=send('GET',green.uid,undefined,false,()=>{published=true;});
    let waiting=false;
    for(let n=0;n<100;n++){
      const [row]=await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='kin_runtime' AND wait_event_type='Lock'`;
      if(row.n){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'view entry reaches actual PG lock');assert.equal(published,false,'no protected HTTP body before view record commit');
    release();await blocker;blocker=null;
    const read=await reading;assert.equal(read.status,200,read.text);assert.equal(read.body.snapshot.findings,content);
    const viewed=(await entries(green.uid,'provide-prepared')).map(row=>JSON.parse(row.payload));assert.equal(viewed.length,2);
    assert.deepEqual(viewed.find(event=>event.surface==='GET studies/:uid/draft').trustedProxyIp,{status:'unresolved',reason:'not-observed'});
    // D1813 -> missing clinical history / unrecorded disclosure -> real W5 HTTP
    // with separate PG observations. Each of the three required records has an omission control.
    let relatedSeq=0;
    const relatedFixture=async()=>{
      const uid='2.25.710'+(++relatedSeq), sourceUid='2.25.720'+relatedSeq;
      const state=await witness.studyState.create({data:{uid,institutionId:institution,ss:'Verified'}});
      await witness.studyState.create({data:{uid:sourceUid,institutionId:institution,ss:'Verified',rs:'A'}});
      const sourceText='SYNTHETIC source approved '+relatedSeq, seed='SYNTHETIC target '+relatedSeq;
      await witness.report.create({data:{uid:sourceUid,version:1,findings:sourceText,conclusion:'',recommendation:''}});
      await witness.reportVersion.create({data:{uid:sourceUid,version:1,action:'approve',author,
        findings:sourceText,conclusion:'',recommendation:''}});
      await witness.reportDraft.create({data:{uid,author,revision:1,present:true,findings:seed,conclusion:'',recommendation:'',baseVersion:0}});
      const text='\n'+sourceText;
      const body={...input(state.draftEpoch+':1',seed+text),relatedInsert:{intent:'apply',insertRequestId:randomUUID(),
        source:{uid:sourceUid,version:1,action:'approve',parts:[{field:'findings',start:0,end:sourceText.length}]},
        targetUid:uid,targetBaseVersion:0,section:'findings',position:'end',offset:seed.length,text,
        selectionSeq:1,contentRevision:1,sourceGeneration:1,seedKind:'private-draft'}};
      return {uid,sourceUid,body,seed};
    };
    const w5Events=async f=>(await witness.$queryRaw`SELECT payload FROM emr_access.access_entry
      WHERE payload::jsonb->'targets'->0->'studyId'->>'value' IN (${f.uid},${f.sourceUid})`).map(row=>JSON.parse(row.payload));
    const isRecord={save:e=>e.action==='draft-save',draftView:e=>e.action==='provide-prepared'&&e.targets[0].kind==='private-draft',
      sourceView:e=>e.action==='provide-prepared'&&e.targets[0].kind==='report-version'};
    const assertW5=async(f,kind)=>assert.ok((await w5Events(f)).some(isRecord[kind]),'D1813 requires '+kind);
    for(const kind of Object.keys(isRecord)){
      const f=await relatedFixture();
      runtime.ledger.appendInTransaction=async function(tx,operation,reference){
        if(isRecord[kind](operation.event))return {provisional:true};
        return original.call(this,tx,operation,reference);
      };
      try{
        const answer=await send('PUT',f.uid,f.body);assert.equal(answer.status,200,answer.text);
        await assert.rejects(assertW5(f,kind),new RegExp('D1813 requires '+kind));
      }finally{runtime.ledger.appendInTransaction=original;}
      // Fail the actual PG transaction at this record; neither draft nor receipt may commit.
      const denied=await relatedFixture();
      runtime.ledger.appendInTransaction=async function(tx,operation,reference){
        if(isRecord[kind](operation.event))await tx.$executeRawUnsafe('SELECT 1/0');
        return original.call(this,tx,operation,reference);
      };
      try{
        const answer=await send('PUT',denied.uid,denied.body);assert.ok(answer.status>=400,answer.text);
        assert.equal(answer.text.includes(denied.seed),false);
        assert.equal((await witness.reportDraft.findUnique({where:{uid_author:{uid:denied.uid,author}}})).findings,denied.seed);
        assert.equal(await witness.reportDraftInsertReceipt.count({where:{insertRequestId:denied.body.relatedInsert.insertRequestId}}),0);
        assert.equal((await w5Events(denied)).filter(e=>e.result==='prepared'||e.result==='succeeded').length,0);
      }finally{runtime.ledger.appendInTransaction=original;}
    }
    const related=await relatedFixture();
    const applied=await send('PUT',related.uid,related.body);assert.equal(applied.status,200,applied.text);
    for(const kind of Object.keys(isRecord))await assertW5(related,kind);
    const appliedEvents=await w5Events(related);
    assert.equal(appliedEvents.length,4,'save intent/result, draft view and Source view only');
    for(const event of appliedEvents){
      assert.equal(event.userId.value.subject,sub);assert.equal(event.userId.value.issuer,issuer);
      assert.deepEqual(event.rolesAtTime.value,['radiologist']);assert.equal(event.actingInstitution.value,institution);
      assert.deepEqual(event.trustedProxyIp.value,{address:'192.0.2.22',source:'trusted-proxy'});
    }
    const sourceEvent=appliedEvents.find(isRecord.sourceView);
    assert.equal(sourceEvent.targets[0].studyId.value,related.sourceUid);assert.equal(sourceEvent.targets[0].versionId.value,'1');
    const replay=await send('PUT',related.uid,related.body);assert.equal(replay.status,200,replay.text);
    const checked=await send('GET',related.uid,undefined,true,undefined,'?insertRequestId='+related.body.relatedInsert.insertRequestId);
    assert.equal(checked.body.relatedInsert.result,'applied');
    const cannotDiscard=await send('PUT',related.uid,{...related.body,relatedInsert:{...related.body.relatedInsert,intent:'discard',expectedReceiptRevision:1}});
    assert.equal(cannotDiscard.status,409);assert.equal(cannotDiscard.body.snapshot.findings,applied.body.snapshot.findings);
    assert.equal((await w5Events(related)).filter(isRecord.draftView).length,4);
    assert.equal((await w5Events(related)).filter(isRecord.sourceView).length,1,'replay/Check/refusal read no Source');
    const held=await relatedFixture();
    await witness.studyState.update({where:{uid:held.uid},data:{holder:'synthetic-other-doctor',heldAt:new Date()}});
    const heldAnswer=await send('PUT',held.uid,held.body);assert.equal(heldAnswer.status,409,heldAnswer.text);
    assert.equal(heldAnswer.body.snapshot.findings,held.seed);
    assert.equal((await w5Events(held)).length,1,'a pre-Source refusal records only its returned draft');
    // A ledger lock holds both replay and refusal HTTP bytes until their view commits.
    for(const f of [related,held]){
      let acquired;const locked=new Promise(resolve=>acquired=resolve),unlock=new Promise(resolve=>release=resolve);
      blocker=witness.$transaction(async tx=>{await tx.$executeRawUnsafe('LOCK TABLE emr_access.access_entry IN ACCESS EXCLUSIVE MODE');acquired();await unlock;},{timeout:15000});
      await locked;let published=false;
      const pending=send('PUT',f.uid,f.body,true,()=>{published=true;});
      let waiting=false;
      for(let n=0;n<100;n++){
        const [row]=await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='kin_runtime' AND wait_event_type='Lock'`;
        if(row.n){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true);assert.equal(published,false,'W5 draft bytes wait for the view commit');
      release();await blocker;blocker=null;await pending;
    }
    await witness.$executeRawUnsafe('REVOKE EXECUTE ON FUNCTION '+appendSignature+' FROM kin_runtime');restored=false;
    const deniedRights=await changeRights({enabled:false});
    assert.equal(deniedRights.status>=400,true,deniedRights.text);
    const unchanged=await witness.memberRights.findUnique({where:{sub:member}});
    assert.equal(unchanged.version,3);assert.equal(unchanged.suspended,false);
    const refused=await send('PUT',green.uid,input(saved.body.revision,'SYNTHETIC refused draft'));
    assert.equal(refused.status>=400,true);assert.equal(refused.text.includes('SYNTHETIC refused draft'),false);
    assert.equal((await witness.reportDraft.findUnique({where:{uid_author:{uid:green.uid,author}}})).findings,content);
    const noView=await send('GET',green.uid);assert.equal(noView.status>=400,true);assert.equal(noView.text.includes(content),false);
    for(const f of [related,held]){
      const denied=await send('PUT',f.uid,f.body);assert.ok(denied.status>=400);assert.equal(denied.text.includes(f.seed),false);
    }
    console.log(JSON.stringify({status:'PASS',boundary:'real Nest PacsController/AuthGuard + PG',
      cases:['omission mutant red','atomic draft write green','view body waits for PG commit','failed ledger rolls back save',
        'failed ledger refuses protected view','admin HTTP records observed request facts','failed ledger rolls back admin HTTP change',
        'D1813 save/draft-view/source-view omissions red; all green','D1813 each record failure rolls back draft and receipt',
        'W5 apply/replay/Check/refusal identity and exact records','W5 replay/refusal bytes wait for commit and fail closed']}));
  } finally {
    release?.();if(blocker)await blocker;
    if(!restored)await witness.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION '+appendSignature+' TO kin_runtime');
    if(app)await app.close();await runtime.stop(Date.now()+15000);await witness.$disconnect();
    await new Promise(resolve=>provider.close(resolve));
  }
}

async function authFailure() {
  require('reflect-metadata');
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const NodeModule = require('node:module');
  const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
  const { EMR_RECORD_PORT } = require(path.join(build, 'emr-runtime/record-port.js'));
  const { PrismaService } = require(path.join(build, 'prisma.service.js'));
  const { StudyAccessService } = require(path.join(build, 'study-access.service.js'));
  const { KeycloakService } = require(path.join(build, 'keycloak.service.js'));
  process.env.KC_ISSUER = 'https://synthetic.invalid/realms/b2r';
  process.env.KIN_COOKIE_SECRET = randomUUID();
  process.env.PUBLIC_ORIGIN = 'https://synthetic.invalid';
  // No token exchange is needed for the provider-declared refusal. The real
  // controller and service are mounted unchanged; no synthetic HTTP route.
  const authPath = path.join(build, 'auth.service.js');
  const { AuthService } = require(authPath);
  const { AuthController } = require(path.join(build, 'auth.controller.js'));
  const source = fs.readFileSync(authPath, 'utf8');
  const mutant = source.replace('auth_events_1.recordLoginFailure', 'async () => undefined');
  assert.notEqual(mutant, source, 'Failure-writer omission mutant must be applied');
  const modified = new NodeModule(authPath, module);
  modified.filename = authPath; modified.paths = NodeModule._nodeModulePaths(path.dirname(authPath));
  modified._compile(mutant, authPath);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_B2R_SPOOL);
  let app, faultInstalled = false;
  async function start(AuthType) {
    class AuthFixture {}
    Module({ controllers: [AuthController], providers: [PrismaService, KeycloakService, PresenceService,
      { provide: StudyAccessService, useFactory: prisma => new StudyAccessService(prisma, {}, {}), inject: [PrismaService] },
      { provide: AuthService, useClass: AuthType }, { provide: EMR_RECORD_PORT, useValue: runtime.port },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work }] })(AuthFixture);
    app = await NestFactory.create(AuthFixture, { logger: false });
    await app.listen(0, '127.0.0.1');
    return await app.getUrl();
  }
  async function counts() {
    const [row] = await witness.$queryRaw`SELECT
      (SELECT count(*)::int FROM emr_access.access_entry) AS ledger,
      (SELECT count(*)::int FROM public."AuditLog") AS projection,
      (SELECT count(*)::int FROM emr_access.audit_projection) AS links,
      (SELECT count(*)::int FROM public."AuthSession") AS sessions,
      (SELECT count(*)::int FROM emr_access.failure_entry) AS failures`;
    return row;
  }
  async function refusedCallback(origin, started = true) {
    let headers = {}, state = 'no-started-flow';
    if (started) {
      const login = await fetch(origin + '/auth/login', { redirect: 'manual' });
      assert.equal(login.status, 302);
      headers.cookie = login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
      state = new URL(login.headers.get('location')).searchParams.get('state');
    }
    const response = await fetch(origin + '/auth/callback?state=' + encodeURIComponent(state) + '&error=access_denied',
      { headers, redirect: 'manual' });
    await response.text();
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')).pathname, '/worklist/hpacs-lite/index.html');
    assert.equal(response.headers.getSetCookie().some(value => value.startsWith('kin_sid=')), false);
  }
  try {
    await witness.$connect();
    await witness.memberRightsImport.create({ data: { id: 'realm-v1', completedAt: new Date() } });
    await runtime.start();
    let origin = await start(modified.exports.AuthService);
    await refusedCallback(origin);
    const red = await counts();
    assert.throws(() => assert.equal(red.ledger, 1, 'Started login refusal must be recorded'),
      { code: 'ERR_ASSERTION' });
    assert.equal(red.ledger, 0);
    await app.close(); app = null;
    origin = await start(AuthService);
    await refusedCallback(origin);
    assert.deepEqual(await counts(), { ledger: 1, projection: 1, links: 1, sessions: 0, failures: 0 });
    const [fact] = await witness.$queryRaw`SELECT e.payload, e.retention_class, o.outcome
      FROM emr_access.access_entry e JOIN emr_access.attempt_outcome o USING(operation_id)`;
    const event = JSON.parse(fact.payload);
    assert.equal(event.action, 'auth.login'); assert.equal(event.result, 'refused');
    assert.equal(event.auth.failureCause, 'provider-error');
    assert.equal(event.userId.status, 'unresolved'); assert.equal(event.userId.reason, 'not-authenticated');
    assert.equal(event.session.status, 'unresolved'); assert.equal(event.trustedProxyIp.status, 'unresolved');
    assert.equal(fact.retention_class, 'viewing2y'); assert.equal(fact.outcome, 'committed');
    await refusedCallback(origin, false);
    assert.equal((await counts()).ledger, 1);

    // A real SQL append failure must roll back the AuditLog projection too.
    await witness.$executeRawUnsafe(`CREATE FUNCTION public.b2r_fail_auth_append() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'Synthetic append failure'; END $$`);
    await witness.$executeRawUnsafe(`CREATE TRIGGER b2r_fail_auth_append BEFORE INSERT ON emr_access.access_entry
      FOR EACH ROW EXECUTE FUNCTION public.b2r_fail_auth_append()`);
    faultInstalled = true;
    await refusedCallback(origin);
    assert.deepEqual(await counts(), { ledger: 1, projection: 1, links: 1, sessions: 0, failures: 1 });
    await witness.$executeRawUnsafe('DROP TRIGGER b2r_fail_auth_append ON emr_access.access_entry');
    faultInstalled = false;
    await refusedCallback(origin);
    assert.deepEqual(await counts(), { ledger: 2, projection: 2, links: 2, sessions: 0, failures: 1 });
    console.log(JSON.stringify({ status: 'PASS', boundary: 'real AuthController/AuthService HTTP + PG ledger/projection',
      red: 'omitted failure writer fails ledger assertion', green: 'refusal persists; SQL append failure rolls both rows back',
      notCovered: 'successful authentication, member rights, production AppModule/global Guard, protected response bytes' }));
  } finally {
    if (faultInstalled) await witness.$executeRawUnsafe('DROP TRIGGER b2r_fail_auth_append ON emr_access.access_entry');
    if (app) await app.close();
    await runtime.stop(Date.now() + 15000); await witness.$disconnect();
  }
}
async function authSuccess(endings = false) {
  require('reflect-metadata');
  const http = require('node:http');
  const jose = require('jose');
  const { Module } = require('@nestjs/common');
  const { NestFactory, APP_GUARD } = require('@nestjs/core');
  const NodeModule = require('node:module');
  const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
  const { EMR_RECORD_PORT } = require(path.join(build, 'emr-runtime/record-port.js'));
  const { PrismaService } = require(path.join(build, 'prisma.service.js'));
  const { StudyAccessService } = require(path.join(build, 'study-access.service.js'));
  const { KeycloakService } = require(path.join(build, 'keycloak.service.js'));
  const issuer = 'https://synthetic.invalid/realms/b2r';
  Object.assign(process.env, { KC_ISSUER: issuer, KC_AUDIENCE: 'kin-api', KIN_COOKIE_SECRET: randomUUID(),
    KC_WEB_SECRET: randomUUID(), PUBLIC_ORIGIN: 'https://synthetic.invalid' });
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const jwk = { ...await jose.exportJWK(publicKey), kid: 'b2r-fixture', alg: 'RS256', use: 'sig' };
  const exchanges = new Map();
  const provider = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/certs')) return res.end(JSON.stringify({ keys: [jwk] }));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const answer = exchanges.get(new URLSearchParams(body).get('code'));
      if (!answer) { res.statusCode = 400; return res.end('{}'); }
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.KC_JWKS_URL = 'http://127.0.0.1:' + provider.address().port + '/certs';
  const authPath = path.join(build, 'auth.service.js');
  const { AuthService } = require(authPath);
  const { AuthController } = require(path.join(build, 'auth.controller.js'));
  const { AuthGuard } = require(path.join(build, 'auth.guard.js'));
  const source = fs.readFileSync(authPath, 'utf8');
  const offset = endings ? source.indexOf('async endRow(') : source.indexOf('async finishCallback(');
  assert.equal(offset >= 0, true, 'Producer mutation location found');
  const mutant = source.slice(0, offset) + source.slice(offset).replace('await record(event, async () =>',
    'await (async (_event, effect) => effect())(event, async () =>');
  assert.notEqual(mutant, source, 'Producer ledger omission mutation applied');
  const modified = new NodeModule(authPath, module);
  modified.filename = authPath; modified.paths = NodeModule._nodeModulePaths(path.dirname(authPath));
  modified._compile(mutant, authPath);
  const witness = new PrismaClient({ datasources: { db: { url: process.env.KIN_B2R_WITNESS_URL } } });
  const runtime = new EmrRuntime(process.env.DATABASE_URL, process.env.KIN_B2R_SPOOL);
  let app, blocker, release, trigger = false;
  const sign = (sub, nonce, audience) => new jose.SignJWT({ sid: randomUUID(), nonce,
    email: 'same-display@synthetic.invalid', realm_access: { roles: ['radiologist'] }, groups: ['/synthetic-hospital'] })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setSubject(sub)
    .setAudience(audience).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const observedPort = { begin() {
    const work = runtime.port.begin();
    return { ...work, async transactionWithRecords(...args) {
      try { return await work.transactionWithRecords(...args); }
      catch (error) { console.error('Observed producer transaction failure:', error.stack); throw error; }
    } };
  } };
  let sweepCallback;
  async function start(AuthType) {
    class AuthFixture {}
    Module({ controllers: [AuthController], providers: [...requestProviders(observedPort), PrismaService, KeycloakService, PresenceService,
      { provide: StudyAccessService, useFactory: prisma => new StudyAccessService(prisma, {}, {}), inject: [PrismaService] },
      { provide: AuthService, useClass: AuthType }, { provide: EMR_RECORD_PORT, useValue: observedPort },
      { provide: EMR_BACKGROUND_WORK, useValue: runtime.background.work }, {provide: APP_GUARD, useClass: AuthGuard}] })(AuthFixture);
    app = await NestFactory.create(AuthFixture, { logger: false });
    app.setGlobalPrefix('api');
    const interval = global.setInterval;
    global.setInterval = (callback, delay, ...args) => {
      if (delay === 3600000) sweepCallback = callback;
      return interval(callback, delay, ...args);
    };
    try { await app.listen(0, '127.0.0.1'); }
    finally { global.setInterval = interval; }
    return (await app.getUrl()) + '/api';
  }
  async function begin(origin, sub, observed = true) {
    const response = await fetch(origin + '/auth/login', { redirect: 'manual' });
    assert.equal(response.status, 302);
    const query = new URL(response.headers.get('location')).searchParams;
    const state = query.get('state'), code = randomUUID();
    exchanges.set(code, { access_token: await sign(sub, state, 'kin-api'),
      id_token: await sign(sub, state, 'kin-bff'), refresh_token: randomUUID() });
    return () => fetch(origin + '/auth/callback?' + new URLSearchParams({ state, code }), { redirect: 'manual', headers: {
      cookie: response.headers.getSetCookie().map(row => row.split(';')[0]).join('; '),
      ...(observed ? { 'x-real-ip': '192.0.2.12' } : {}),
    } });
  }
  function entered(response) {
    assert.equal(response.status, 302);
    const cookie = response.headers.getSetCookie().find(row => row.startsWith('kin_sid='))?.split(';')[0];
    assert.equal(!!cookie, true, 'Login must publish its committed session');
    assert.equal(new URL(response.headers.get('location')).hash, '#kin-login');
    return { cookie };
  }
  async function events(sub, action) {
    const rows = await witness.$queryRaw`SELECT payload FROM emr_access.access_entry
      WHERE payload::jsonb->'userId'->'value'->>'subject'=${sub} AND payload::jsonb->>'action'=${action}`;
    return rows.map(row => JSON.parse(row.payload));
  }
  try {
    await witness.$connect();
    await witness.memberRightsImport.create({ data: { id: 'realm-v1' } });
    for (const sub of ['red', 'doctor-a', 'doctor-b', 'parallel-1', 'parallel-2', 'parallel-3', 'parallel-4'])
      await witness.memberRights.create({ data: { sub, username: sub, email: 'same-display@synthetic.invalid',
        name: 'Same display', emailVerified: true, approved: true, suspended: false, institution: 'synthetic-hospital', roles: ['radiologist'] } });
    await runtime.start();
    if (endings) {
      const logout = async (origin, login) => {
        if (!login.sessionId) {
          login.sessionId = app.get(AuthService).sessionRef(login.cookie.slice('kin_sid='.length));
        }
        return fetch(origin + '/auth/logout', {method:'POST',headers:{cookie:login.cookie,
          origin:process.env.PUBLIC_ORIGIN,'x-kin-csrf':'1','x-real-ip':'192.0.2.12','x-kin-session':login.sessionId}});
      };
      let origin = await start(modified.exports.AuthService);
      const redLogin = entered(await (await begin(origin, 'red'))());
      assert.equal((await logout(origin, redLogin)).status, 204);
      assert.equal(await witness.authSession.count({ where: { sub: 'red' } }), 0);
      const redEvents = await events('red', 'auth.logout');
      assert.throws(() => assert.equal(redEvents.length, 1, 'Ended session requires its durable event'));
      await app.close(); app = null;
      origin = await start(AuthService);
      const login = entered(await (await begin(origin, 'doctor-a'))());
      const session = await witness.authSession.findFirst({ where: { sub: 'doctor-a' } });
      await witness.$executeRawUnsafe(`CREATE FUNCTION public.b2r_fail_entry() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.payload::jsonb->>'action'='auth.logout' THEN RAISE EXCEPTION 'Synthetic logout failure'; END IF; RETURN NEW; END $$`);
      await witness.$executeRawUnsafe(`CREATE TRIGGER b2r_fail_entry BEFORE INSERT ON emr_access.access_entry
        FOR EACH ROW EXECUTE FUNCTION public.b2r_fail_entry()`);
      const failed = await logout(origin, login); assert.equal(failed.status, 500); await failed.text();
      assert.equal(await witness.authSession.count({ where: { sub: 'doctor-a' } }), 1);
      assert.equal(await witness.auditLog.count({ where: { target: 'doctor-a', action: 'auth.logout' } }), 0);
      assert.equal((await events('doctor-a', 'auth.logout')).length, 0);
      await witness.$executeRawUnsafe('DROP TRIGGER b2r_fail_entry ON emr_access.access_entry');
      assert.equal((await logout(origin, login)).status, 204);
      assert.equal((await logout(origin, login)).status, 204);
      const [ended] = await events('doctor-a', 'auth.logout');
      assert.equal((await events('doctor-a', 'auth.logout')).length, 1);
      assert.equal(ended.session.value, session.auditRef);
      assert.equal(ended.auth.endCause, 'logout');
      assert.equal(ended.surface, 'POST auth/logout');
      assert.equal(await witness.authSession.count({ where: { sub: 'doctor-a' } }), 0);
      entered(await (await begin(origin, 'doctor-b'))());
      await witness.authSession.updateMany({ where: { sub: 'doctor-b' }, data: { lastSeenAt: new Date(Date.now()-13*3600000) } });
      assert.equal(typeof sweepCallback, 'function'); sweepCallback();
      for (let i=0;i<200 && await witness.authSession.count({where:{sub:'doctor-b'}});i++)
        await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(await witness.authSession.count({where:{sub:'doctor-b'}}),0,'Lifecycle sweep must delete expired session with its legal event');
      const rows = await witness.$queryRaw`SELECT payload FROM emr_access.access_entry WHERE payload::jsonb->>'action'='auth.session.expired'`;
      assert.equal(rows.length,1);
      const swept=JSON.parse(rows[0].payload);
      assert.equal(swept.auth.endCause,'sweep'); assert.equal(swept.executor,'service');
      assert.equal(swept.affectedIdentity.value.subject,'doctor-b');
      assert.notEqual(swept.userId.value.id,swept.affectedIdentity.value.id);
      assert.equal(swept.trustedProxyIp.reason,'in-process-service');
      console.log(JSON.stringify({status:'PASS',boundary:'real HTTP logout and lifecycle sweep, independent SQL',
        red:'logout ledger omission ends session without legal entry',green:['append failure preserves session and projection','logout/retry records once','sweep service and affected member distinct']}));
      return;
    }
    let origin = await start(modified.exports.AuthService);
    entered(await (await begin(origin, 'red'))());
    const red = await events('red', 'auth.login');
    assert.throws(() => assert.equal(red.length, 1, 'Login requires a durable ledger event'));
    assert.equal(await witness.authSession.count({ where: { sub: 'red' } }), 1);
    await app.close(); app = null;
    origin = await start(AuthService);

    await witness.$executeRawUnsafe(`CREATE FUNCTION public.b2r_hold_login() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(1774,1792); RETURN NEW; END $$`);
    await witness.$executeRawUnsafe(`CREATE TRIGGER b2r_hold_login BEFORE INSERT ON emr_access.access_entry
      FOR EACH ROW EXECUTE FUNCTION public.b2r_hold_login()`);
    trigger = true;
    let locked, lockFailed;
    const lockedSignal = new Promise((resolve, reject) => { locked = resolve; lockFailed = reject; });
    const gate = new Promise(resolve => { release = resolve; });
    blocker = witness.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(1774,1792)`;
      locked(); await gate; }, { timeout: 15000 });
    blocker.catch(lockFailed);
    await lockedSignal;
    let replied = false;
    const callback = (await begin(origin, 'doctor-a'))().then(response => { replied = true; return response; });
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      const [row] = await witness.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE usename='kin_runtime' AND wait_event_type='Lock' AND query LIKE '%append_operation%'`;
      if (row.n) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'Real append reached the SQL lock');
    assert.equal(replied, false, 'No login cookie/header before ledger commit');
    assert.equal(await witness.authSession.count({ where: { sub: 'doctor-a' } }), 0);
    assert.equal((await events('doctor-a', 'auth.login')).length, 0);
    release(); await blocker; blocker = null;
    const first = entered(await callback);
    await witness.$executeRawUnsafe('DROP TRIGGER b2r_hold_login ON emr_access.access_entry'); trigger = false;
    const [loginEvent] = await events('doctor-a', 'auth.login');
    const session = await witness.authSession.findFirst({ where: { sub: 'doctor-a' } });
    assert.equal(loginEvent.session.value, session.auditRef);
    assert.equal(loginEvent.userId.value.issuer, issuer);
    assert.equal(loginEvent.rightsVersion.value, session.rightsVersion);
    assert.equal([session.sid, session.accessToken, session.refreshToken].some(secret => JSON.stringify(loginEvent).includes(secret)), false);

    entered(await (await begin(origin, 'doctor-b'))());
    const [other] = await events('doctor-b', 'auth.login');
    assert.notEqual(other.userId.value.id, loginEvent.userId.value.id);
    const pending = entered(await (await begin(origin, 'pending-member', false))());
    const [pendingEvent] = await events('pending-member', 'auth.login');
    assert.equal(pendingEvent.actingInstitution.reason, 'not-approved');
    assert.equal(pendingEvent.trustedProxyIp.reason, 'not-observed');
    const starts = await Promise.all(['parallel-1', 'parallel-2', 'parallel-3', 'parallel-4'].map(sub => begin(origin, sub)));
    for (const result of await Promise.all(starts.map(run => run()))) entered(result);
    const [projection] = await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.access_entry e
      LEFT JOIN emr_access.audit_projection p ON p.event_id=e.event_id WHERE p.event_id IS NULL`;
    assert.equal(projection.n, 0);
    console.log(JSON.stringify({ status: 'PASS', boundary: 'real AuthController/AuthService + JWKS/token transport + PG',
      red: 'login omission returns session without legal event; behavioral assertion fails',
      green: ['cookie after independently witnessed append commit', 'login non-credential session reference', 'same display distinct subjects',
        'waiting member and unknown observation preserved', 'four concurrent transactions drain'],
      notCovered: 'logout/expiry/sweep, rights producers, full AppModule/Guard, clinical first-byte boundary' }));
  } finally {
    release?.(); if (blocker) await blocker;
    if (trigger) await witness.$executeRawUnsafe('DROP TRIGGER IF EXISTS b2r_hold_login ON emr_access.access_entry');
    await witness.$executeRawUnsafe('DROP TRIGGER IF EXISTS b2r_fail_entry ON emr_access.access_entry');
    if (app) await app.close();
    await runtime.stop(Date.now() + 15000); await witness.$disconnect();
    await new Promise(resolve => provider.close(resolve));
  }
}
async function rightsProducer() {
  require('reflect-metadata');
  const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
  const adminPath = path.join(build, 'admin.service.js');
  const { AdminService } = require(adminPath);
  const { PrismaService } = require(path.join(build, 'prisma.service.js'));
  const NodeModule = require('node:module');
  const source = fs.readFileSync(adminPath,'utf8');
  const mutant = source.replace('await record(event, async () =>','await (async (_event, effect) => effect())(event, async () =>');
  assert.notEqual(mutant,source);
  const modified = new NodeModule(adminPath,module); modified.filename=adminPath;
  modified.paths=NodeModule._nodeModulePaths(path.dirname(adminPath)); modified._compile(mutant,adminPath);
  const witness = new PrismaClient({datasources:{db:{url:process.env.KIN_B2R_WITNESS_URL}}});
  const db = new PrismaService();
  const runtime = new EmrRuntime(process.env.DATABASE_URL,process.env.KIN_B2R_SPOOL);
  process.env.KC_ISSUER='https://synthetic.invalid/realms/b2r';
  const caller={sub:'administrator',actor:'same-display',roles:['admin'],institution:'synthetic-hospital',kind:'member'};
  const projectionCount = sub => witness.auditLog.count({where:{target:sub,action:'admin.user.suspend'}});
  async function legal(sub) {
    return witness.$queryRaw`SELECT e.retention_class,e.payload FROM emr_access.access_entry e
      JOIN emr_access.audit_projection p ON p.event_id=e.event_id JOIN public."AuditLog" a ON a.id=p.audit_log_id
      WHERE a.target=${sub} AND a.action='admin.user.suspend'`;
  }
  try {
    await witness.$connect(); await db.$connect(); await runtime.start();
    for(const sub of ['administrator','red-rights','member']) await witness.memberRights.create({data:{sub,username:sub,email:'same-display',
      name:'Same',emailVerified:true,approved:true,suspended:false,institution:'synthetic-hospital',roles:sub==='administrator'?['admin']:['radiologist']}});
    for(let i=0;i<2;i++) await witness.authSession.create({data:{sid:randomUUID(),sub:'member',accessToken:'synthetic-unused',refreshToken:randomUUID(),
      atExpiresAt:new Date(Date.now()+600000),lastSeenAt:new Date(),rightsVersion:1,institution:'synthetic-hospital'}});
    // REQUEST_FACTS: each rights change runs inside the shared request context over this same record port,
    // as AdminController does; the actor and its work come from that context.
    const { createRequestContext } = require(path.join(build, 'emr-runtime/request-context.js'));
    const { createRequestIngress } = require(path.join(build, 'emr-runtime/request-ingress.js'));
    const { IncomingMessage, ServerResponse } = require('node:http'), { Socket } = require('node:net');
    const requests = createRequestContext(createRequestIngress({proxyPeers:[]}), runtime.port);
    const patch = async (service, sub, body) => {
      const req=new IncomingMessage(new Socket()), res=new ServerResponse(req);
      requests.capture.capture(req,res,{issuer:process.env.KC_ISSUER,subject:caller.sub,roles:caller.roles,
        rightsVersion:1,institution:caller.institution,binding:{method:'bearer',sessionRef:null}},
        {method:'PATCH',route:'admin/users/:id',purpose:'clinical'},async()=>{});
      try {
        return await requests.source.withWork(req,request=>service.patchUser(sub,body,caller,{surface:request.facts.surface,
          actor:request.facts.actor,roles:request.facts.roles,rightsVersion:request.facts.rightsVersion,
          institution:request.facts.institution,ip:null,ipSource:'trusted-proxy',sessionRef:null,requestId:request.facts.requestId,request}));
      } finally { res.emit('finish'); }
    };
    const make=Type=>new Type(db,{}, {}, {});
    await patch(make(modified.exports.AdminService),'red-rights',{enabled:false});
    assert.equal((await witness.memberRights.findUnique({where:{sub:'red-rights'}})).suspended,true);
    const missing=await legal('red-rights'); assert.throws(()=>assert.equal(missing.length,1,'Rights change requires its legal event'));
    const service=make(AdminService);
    await assert.rejects(service.patchUser('member',{enabled:false},caller), e=>e.getStatus()===503);
    await witness.$executeRawUnsafe(`CREATE FUNCTION public.b2r_fail_rights() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.retention_class='rights3y' THEN RAISE EXCEPTION 'Synthetic rights failure'; END IF; RETURN NEW; END $$`);
    await witness.$executeRawUnsafe(`CREATE TRIGGER b2r_fail_rights BEFORE INSERT ON emr_access.access_entry FOR EACH ROW EXECUTE FUNCTION public.b2r_fail_rights()`);
    await assert.rejects(patch(service,'member',{enabled:false}));
    assert.equal((await witness.memberRights.findUnique({where:{sub:'member'}})).version,1);
    assert.equal(await witness.authSession.count({where:{sub:'member'}}),2);
    assert.equal(await projectionCount('member'),0); assert.equal((await legal('member')).length,0);
    await witness.$executeRawUnsafe('DROP TRIGGER b2r_fail_rights ON emr_access.access_entry');
    const changed=await patch(service,'member',{enabled:false});
    assert.equal(changed.version,2); assert.equal(changed.enabled,false);
    assert.equal(await witness.authSession.count({where:{sub:'member'}}),0);
    const records=await legal('member');assert.equal(records.length,1);assert.equal(records[0].retention_class,'rights3y');
    const event=JSON.parse(records[0].payload);assert.equal(event.userId.value.subject,'administrator');assert.equal(event.trustedProxyIp.reason,'not-observed');
    const ended=await witness.$queryRaw`SELECT payload FROM emr_access.access_entry WHERE payload::jsonb->'auth'->>'endCause'='isolation'`;
    assert.equal(ended.length,2);
    for(const row of ended){const e=JSON.parse(row.payload);assert.equal(e.userId.value.subject,'administrator');assert.equal(e.affectedIdentity.value.subject,'member');}
    console.log(JSON.stringify({status:'PASS',boundary:'real AdminService rights transaction + independent PG',red:'omitted rights event commits change without ledger',
      green:['missing request facts refuses','failed append preserves rights and both sessions','rights3y + two isolation facts commit atomically'],http:'REQUEST_FACTS controller wiring pending'}));
  }finally{
    await witness.$executeRawUnsafe('DROP TRIGGER IF EXISTS b2r_fail_rights ON emr_access.access_entry');
    await runtime.stop(Date.now()+15000);await db.$disconnect();await witness.$disconnect();
  }
}
async function rightsImport() {
  require('reflect-metadata');
  const { EmrRuntime } = require(path.join(build, 'emr-runtime/application.js'));
  const { PrismaService } = require(path.join(build, 'prisma.service.js'));
  const importPath = path.join(build, 'member-rights-import.js');
  const { importMemberRights } = require(importPath);
  const NodeModule = require('node:module');
  const source = fs.readFileSync(importPath,'utf8');
  const mutant = source.replace('await record(event, async () =>','await (async (_event, effect) => effect())(event, async () =>');
  assert.notEqual(mutant,source);
  const modified = new NodeModule(importPath,module); modified.filename=importPath;
  modified.paths=NodeModule._nodeModulePaths(path.dirname(importPath)); modified._compile(mutant,importPath);
  const witness = new PrismaClient({datasources:{db:{url:process.env.KIN_B2R_WITNESS_URL}}});
  const db = new PrismaService(), runtime = new EmrRuntime(process.env.DATABASE_URL,process.env.KIN_B2R_SPOOL);
  process.env.KC_ISSUER='https://synthetic.invalid/realms/import';
  const users = ['first','second'].map(id=>({id,username:id,email:id+'@synthetic.invalid',emailVerified:true,
    firstName:'Same',lastName:'Display',enabled:true,groups:['synthetic-hospital'],roles:['radiologist']}));
  const provider = {listUsers:async()=>({total:users.length,users})};
  const entries = () => witness.$queryRaw`SELECT retention_class,payload FROM emr_access.access_entry
    WHERE payload::jsonb->>'surface'='service:member-rights-import'`;
  try {
    await witness.$connect();await db.$connect();await runtime.start();
    await modified.exports.importMemberRights(db,provider,runtime.port);
    assert.equal(await witness.memberRights.count(),2);
    const missing = await entries();
    assert.throws(()=>assert.equal(missing.length,1,'Initial import requires a rights event'));
    assert.equal(missing.length,0);
    // This fixture owns the entire disposable DB; remove only its two members and marker.
    await witness.$executeRawUnsafe('TRUNCATE "MemberRights", "MemberRightsImport"');
    await witness.$executeRawUnsafe(`CREATE FUNCTION public.b2r_fail_import() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.payload::jsonb->>'surface'='service:member-rights-import' THEN RAISE EXCEPTION 'Synthetic import failure'; END IF; RETURN NEW; END $$`);
    await witness.$executeRawUnsafe('CREATE TRIGGER b2r_fail_import BEFORE INSERT ON emr_access.access_entry FOR EACH ROW EXECUTE FUNCTION public.b2r_fail_import()');
    await assert.rejects(importMemberRights(db,provider,runtime.port));
    assert.equal(await witness.memberRights.count(),0);assert.equal(await witness.memberRightsImport.count(),0);
    await witness.$executeRawUnsafe('DROP TRIGGER b2r_fail_import ON emr_access.access_entry');
    await Promise.all([importMemberRights(db,provider,runtime.port),importMemberRights(db,provider,runtime.port)]);
    assert.equal(await witness.memberRights.count(),2);assert.equal(await witness.memberRightsImport.count(),1);
    const records=await entries();assert.equal(records.length,1);assert.equal(records[0].retention_class,'rights3y');
    const e=JSON.parse(records[0].payload);assert.equal(e.userId.value.subject,'member-rights-import');
    assert.equal(e.userId.value.issuer,'urn:kin:pacs:service');assert.equal(e.executor,'service');
    assert.equal(e.trustedProxyIp.reason,'in-process-service');assert.equal(e.targets.length,2);
    assert.equal(new Set(e.targets.map(t=>t.recordId.value)).size,2);
    await importMemberRights(db,{listUsers:()=>assert.fail('completed import must not reread provider')},runtime.port);
    assert.equal((await entries()).length,1);
    console.log(JSON.stringify({status:'PASS',boundary:'actual initial-import service + independent PG',
      red:'omitted event leaves committed rights without ledger',green:['rollback preserves absent marker and rights','concurrent once-only import','service identity and rights3y','restart skips completed import']}));
  } finally {
    await witness.$executeRawUnsafe('DROP TRIGGER IF EXISTS b2r_fail_import ON emr_access.access_entry');
    await runtime.stop(Date.now()+15000);await db.$disconnect();await witness.$disconnect();
  }
}
async function pgBoundary(body) {
  const db=new EmrLedgerClient(process.env.DATABASE_URL);
  const witness=new PrismaClient({datasources:{db:{url:process.env.KIN_B2R_WITNESS_URL}}});
  const journal=new FailureJournal(db,new FailureSpool(process.env.KIN_B2R_SPOOL));
  const store=new AccessLedgerStore(db,journal);
  try{await db.$connect();await witness.$connect();await verifyRuntimeConnection(db);return await body({db,witness,store});}
  finally{await journal.close();await db.$disconnect();await witness.$disconnect();}
}
function syntheticEvent(identity,dual=true) {
  return {formatVersion:1,surface:dual?'POST studies/:uid/report/commit':'GET studies/:uid/report/versions',eventId:randomUUID(),
    userId:known({id:identity,issuer:'synthetic-issuer',subject:'doctor'}),rolesAtTime:known(['radiologist']),
    actingInstitution:known('synthetic-hospital'),managingInstitution:known('synthetic-hospital'),occurredAt:new Date().toISOString(),
    trustedProxyIp:known({address:'192.0.2.1',source:'trusted-proxy'}),cause:'user-view',
    context:{basis:'out-of-context',studyId:null,relatedStudyId:null,reason:null},executor:'member',
    targets:[{kind:'report-version',patientLinkSnapshot:known({linkId:'synthetic-link',patientId:'synthetic-patient',assigningAuthority:'synthetic-hospital'}),
      studyId:known('synthetic-study'),recordId:known('synthetic-report'),versionId:known('v1')}],
    action:dual?'write':'provide-prepared',result:dual?'succeeded':'prepared',requestId:randomUUID(),auditLinkId:'audit:'+randomUUID(),relatedEventId:null};
}
async function concurrentReceipts() {
  return pgBoundary(async({db,witness,store})=>{
    const identity=await store.resolveIdentity(db,'synthetic-issuer','doctor');
    const events=Array.from({length:48},(_,i)=>syntheticEvent(identity,i%2===0)); // retained L03b selection
    const result=await Promise.all(events.map(e=>store.append(e)));
    assert.equal(result.length,48);
    for(let i=0;i<events.length;i++) {
      assert.equal(result[i].eventId,events[i].eventId);
      const [row]=await witness.$queryRaw`SELECT count(*)::int AS n FROM emr_access.access_entry WHERE event_id=${events[i].eventId}`;
      assert.equal(row.n,i%2===0?2:1,'Every delivered receipt already has every required stream');
      assert.deepEqual(await store.append(events[i]),result[i]);
    }
    const [row]=await witness.$queryRaw`SELECT (SELECT count(*)::int FROM emr_access.access_entry) entries,
      (SELECT count(*)::int FROM emr_access.attempt_outcome WHERE outcome='committed') committed`;
    assert.deepEqual(row,{entries:72,committed:48});
    console.log(JSON.stringify({status:'PASS',boundary:'48 concurrent production-store receipts + independent PG',...row}));
  });
}
async function crashChild() {
  const {event,keys,cut}=JSON.parse(process.env.KIN_B2R_CUT);
  const db=new EmrLedgerClient(process.env.DATABASE_URL),journal=new FailureJournal(db,new FailureSpool(process.env.KIN_B2R_SPOOL+'-'+process.pid));
  const store=new AccessLedgerStore(db,journal);await db.$connect();
  const pause=async()=>{process.send({phase:cut});await new Promise(()=>{});};
  const operation=await store.admit(event,undefined,keys);
  if(cut==='admitted')await pause();
  await store.transaction(operation,async tx=>{
    await tx.reportVersion.create({data:{uid:keys.operationId,version:1,action:'save',findings:'SYNTHETIC only',author:'synthetic-doctor'}});
    if(cut==='before-commit')await pause();
    return {kind:'ReportVersion',id:keys.operationId,version:'1'};
  });
  if(cut==='after-commit')await pause();
  throw Error('Crash cut not reached');
}
async function processCuts() {
  const {fork}=require('node:child_process');
  return pgBoundary(async({db,witness,store})=>{
    const identity=await store.resolveIdentity(db,'synthetic-issuer','doctor');
    for(const cut of ['admitted','before-commit','after-commit']){
      const event=syntheticEvent(identity),keys={operationId:randomUUID(),attemptId:randomUUID()};
      const child=fork(__filename,[],{env:{...process.env,KIN_B2R_CASE:'crash-child',KIN_B2R_CUT:JSON.stringify({event,keys,cut})},stdio:['ignore','pipe','pipe','ipc']});
      let stderr='';child.stderr.on('data',b=>stderr+=b);
      const stopped=new Promise((resolve,reject)=>child.once('exit',(code,signal)=>signal==='SIGKILL'?resolve():reject(Error('Child exited before cut: '+code+' '+stderr))));
      try{
        await Promise.race([new Promise(resolve=>child.once('message',value=>{assert.equal(value.phase,cut);resolve();})),stopped.then(()=>{throw Error('Child stopped before cut');})]);
        child.kill('SIGKILL');await stopped;
        const restarted=new AccessLedgerStore(db,store.journal);await restarted.recoverPending();
        const state=await restarted.lookup(keys.operationId),committed=cut==='after-commit';
        assert.equal(state.outcome,committed?'committed':'negative');assert.equal(state.entries.length,committed?2:0);
        assert.equal(await witness.reportVersion.count({where:{uid:keys.operationId}}),committed?1:0);
        const retry=await restarted.admit(event,undefined,keys);
        assert.deepEqual(await restarted.transaction(retry,async()=>assert.fail('Retry executed a settled mutation')),state);
      }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
    }
    console.log(JSON.stringify({status:'PASS',boundary:'actual SIGKILL before/inside/after business COMMIT; restart settles under PG lock; exact retry never repeats mutation'}));
  });
}
async function contextBoundary() {
  const CTX=require(path.join(build,'emr-runtime/context.js')),D=require(path.join(build,'emr-contract/lawful-defaults.js'));
  const M=require(path.join(build,'emr-contract/composition.js'));
  M.composeEmrAdapters(CTX.runtimeAdapters);
  return pgBoundary(async({db,witness,store})=>{
    const recordId='synthetic-held-record',at='2026-01-01T00:00:00.000Z';
    const hold={holdId:'synthetic-hold',recordId,actorId:'custodian',at,release:null,basis:{type:'court-order',
      clause:{law:'synthetic-law',article:'article-1',version:'2026-v1'},clauseId:'synthetic-law:article-1',authorityKind:'court',
      managingInstitutionId:'synthetic-hospital',requestId:'synthetic-request',authorityId:'synthetic-court',scope:[recordId],verified:true,
      validity:{from:at,until:null,condition:'order-in-force'}}};
    const released={...hold,release:{holdId:hold.holdId,actorId:'custodian',at:'2026-02-01T00:00:00.000Z',evidenceId:'synthetic-ending',authorityVerified:true,reason:'order-ended'}};
    await db.$transaction(tx=>store.recordHold(tx,hold));
    await assert.rejects(db.$transaction(tx=>store.recordHoldRelease(tx,{...released,basis:{...hold.basis,scope:['other']}})),/HoldReleaseBindingRefused/);
    await db.$transaction(tx=>store.recordHoldRelease(tx,released));
    const scope=CTX.transactionScope();
    const load=()=>db.$transaction(tx=>store.snapshot(tx,scope,{recordIds:[recordId],clauseIds:['synthetic-law:article-1']}));
    const missing=await load();assert.throws(()=>CTX.withSnapshot(scope,missing,()=>D.reloadLegalHolds(recordId)),/HoldClauseRequired/);
    await witness.$executeRaw`INSERT INTO emr_access.clause_version VALUES ('synthetic-law:article-1','2026-v1','synthetic-law','article-1','2026-01-01','2026-01-01',now())`;
    const present=await load();
    assert.deepEqual(CTX.withSnapshot(scope,present,()=>D.reloadLegalHolds(recordId)).map(h=>[h.holdId,h.release.reason]),[['synthetic-hold','order-ended']]);
    assert.throws(()=>CTX.withSnapshot(CTX.transactionScope(),present,()=>D.reloadLegalHolds(recordId)),/EmrContextTransactionMismatch/);
    assert.throws(()=>CTX.withSnapshot(scope,missing,()=>D.reloadLegalHolds(recordId)),/HoldClauseRequired/,'A retained snapshot cannot acquire facts from a later read');
    const orderId='synthetic-order',orderAt='2026-01-01T00:00:00.000Z';
    const fact={recordId:orderId,eventId:'synthetic-order-original',previousEventId:null,facts:{
      objectKind:'order-indication',origin:'product-authored',authorId:'physician',authorRole:'physician',requestingClinicianId:'physician',
      directionSourceRef:null,examCodes:['CT-CHEST'],source:null,feed:null,inherited:[],firstReceivedAt:null,firstReceiptEventId:null,
      duplicateOf:null,scheduledAt:null,scheduleChangeEvidenceId:null,status:'closed',
      statusEvent:{eventId:'synthetic-order-original',actorId:'physician',at:orderAt,reason:'synthetic'},
      fulfilment:null,chartIncorporation:null,procedure:null,synthetic:null},
      event:{eventId:'synthetic-order-original',recordId:orderId,versionId:'original',sha256:'ab'.repeat(32),contentSha256:'ab'.repeat(32),at:orderAt,act:'entry',
        signature:{versionId:'original',sha256:'ab'.repeat(32),signedAt:orderAt,verified:true},predecessor:null,components:[],processing:null}};
    await db.$transaction(tx=>store.recordOrderFact(tx,fact));
    assert.deepEqual(await db.$transaction(tx=>store.recordOrderFact(tx,structuredClone(fact))),fact);
    await assert.rejects(db.$transaction(tx=>store.recordOrderFact(tx,{...fact,facts:{...fact.facts,examCodes:['MR-BRAIN']}})));
    const order=await db.$transaction(tx=>store.snapshot(tx,scope,{recordIds:[orderId],orderRecordIds:[orderId]}));
    const Cl=require(path.join(build,'emr-contract/classification.js'));
    const resolved=CTX.withSnapshot(scope,order,()=>Cl.resolveStoredRecord(M.emrAdapters().stored,orderId,fact.eventId));
    assert.deepEqual(resolved.kinds,['order-indication']);
    assert.equal((await store.orderFacts(db,orderId)).length,1);
    console.log(JSON.stringify({status:'PASS',boundary:'actual PG hold/release/clause and original-order snapshot; unknown clause, wrong transaction and altered duplicate refused'}));
  });
}

async function retentionAdapter() {
  const CTX=require(path.join(build,'emr-runtime/context.js')),D=require(path.join(build,'emr-contract/lawful-defaults.js'));
  const M=require(path.join(build,'emr-contract/composition.js')),Cl=require(path.join(build,'emr-contract/classification.js'));
  const H=require(path.join(build,'emr-retention/inventory.js'));
  M.composeEmrAdapters(CTX.runtimeAdapters);
  return pgBoundary(async({db,witness,store})=>{
    const orderId='synthetic-expired-order',orderAt='2010-01-01T00:00:00.000Z';
    const fact={recordId:orderId,eventId:'synthetic-order-original',previousEventId:null,facts:{
      objectKind:'order-indication',origin:'product-authored',authorId:'physician',authorRole:'physician',requestingClinicianId:'physician',
      directionSourceRef:null,examCodes:['CT-CHEST'],source:null,feed:null,inherited:[],firstReceivedAt:null,firstReceiptEventId:null,
      duplicateOf:null,scheduledAt:null,scheduleChangeEvidenceId:null,status:'closed',
      statusEvent:{eventId:'synthetic-order-original',actorId:'physician',at:orderAt,reason:'synthetic'},
      fulfilment:null,chartIncorporation:null,procedure:null,synthetic:null},
      event:{eventId:'synthetic-order-original',recordId:orderId,versionId:'original',sha256:'ab'.repeat(32),contentSha256:'ab'.repeat(32),at:orderAt,act:'entry',
        signature:{versionId:'original',sha256:'ab'.repeat(32),signedAt:orderAt,verified:true},predecessor:null,components:[],processing:null}};

    await db.$transaction(tx=>store.recordOrderFact(tx,fact));
    const identity=await store.resolveIdentity(db,'synthetic-issuer','doctor'),event=syntheticEvent(identity);
    event.occurredAt=orderAt;
    event.targets[0]={...event.targets[0],kind:'order-indication',recordId:known(orderId),versionId:known('original')};
    // Exercise the H/PG boundary with an original fact; API route classification
    // is covered by the separate real producer cases.
    const operation=randomUUID(),attempt=randomUUID(),body=JSON.stringify(event);
    await db.$queryRaw`SELECT emr_access.admit_operation(${operation}::uuid,${attempt}::uuid,${body},'기재')`;
    await db.$queryRaw`SELECT emr_access.append_operation(${operation}::uuid,${attempt}::uuid,${body},'기재',NULL,NULL,NULL)`;
    const [entry]=await witness.$queryRaw`SELECT entry_id::text AS id FROM emr_access.access_entry WHERE event_id=${event.eventId} AND stream='history'`;
    const scope=CTX.transactionScope(),snapshot=await db.$transaction(tx=>store.snapshot(tx,scope,{recordIds:[orderId],orderRecordIds:[orderId]}));
    const at=new Date().toISOString(),targets=[{index:0,kind:'order-indication',recordId:orderId,versionId:'original'}];
    await CTX.withSnapshot(scope,snapshot,async()=>{
      const record=D.newRetentionRecord(Cl.resolveStoredRecord(M.emrAdapters().stored,orderId,fact.eventId));
      const graph={records:[record],references:[],complete:true,revision:'synthetic-complete-H-snapshot',checkedAt:at};
      const expire=(g=graph,t=targets)=>witness.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET LOCAL ROLE kin_emr_retention');
        return H.expireLedgerHistory(tx,entry.id,t,g,at);
      });
      await assert.rejects(expire({...graph,complete:false}),/ReferenceSnapshotIncomplete/);
      await assert.rejects(expire({...graph,checkedAt:orderAt}),/ReferenceSnapshotIncomplete/);
      await assert.rejects(expire({...graph,records:[]}),/RecordEventBindingRefused/);
      await assert.rejects(expire(graph,[{...targets[0],versionId:'unrecorded'}]),/RecordEventBindingRefused/);
      assert.equal(await expire(),true);
    });
    const [result]=await witness.$queryRaw`SELECT (SELECT count(*)::int FROM emr_access.access_entry WHERE entry_id=${entry.id}::uuid) payload,
      (SELECT count(*)::int FROM emr_access.disposal_fact WHERE entry_id=${entry.id}::uuid) disposal,
      (SELECT count(*)::int FROM emr_access.entry_receipt WHERE entry_id=${entry.id}::uuid) receipt`;
    assert.deepEqual(result,{payload:0,disposal:1,receipt:1});
    console.log(JSON.stringify({status:'PASS',boundary:'H actual stored original classification + complete graph + retention-role PG row DELETE',...result}));
  });
}

async function failureFiles() {
  const root=process.env.KIN_B2R_SPOOL,dir=path.join(root,'outage');
  const spool=new FailureSpool(dir),file=path.join(dir,'failure-spool.jsonl');
  const make=()=>({id:randomUUID(),operationId:null,eventId:'x',at:new Date().toISOString(),cause:'ledger-unreachable'});
  const block=Number(fs.statfsSync(root).bsize),base=Buffer.byteLength(JSON.stringify(make())+'\n');
  const count=Math.ceil(block/(base+199));let padding=block-count*base;
  for(let i=0;i<count;i++) {const r=make(),extra=Math.min(padding,199);r.eventId='x'.repeat(1+extra);padding-=extra;await spool.append(r);}
  assert.equal(padding,0);assert.equal(fs.statSync(file).size,block);
  const filler=path.join(root,'owned-filler'),fd=fs.openSync(filler,'w');
  try{while(true)fs.writeSync(fd,Buffer.alloc(block));}
  catch(error){assert.equal(error.code,'ENOSPC');}finally{fs.closeSync(fd);}
  let bytes=0;const event=syntheticEvent(randomUUID(),false);
  await assert.rejects(provideAfterReceipt({append:async()=>{await spool.append(make());throw Error('ENOSPC write unexpectedly succeeded');}},event,async()=>{bytes++;}),e=>e.code==='ENOSPC');
  assert.equal(bytes,0);fs.unlinkSync(filler);let imported=0;
  assert.equal(await spool.replay(async()=>{imported++;}),count);assert.equal(imported,count);await spool.close();
  // A device with no durability operation yields a real kernel fsync error.
  const noSync=path.join(root,'no-fsync');fs.mkdirSync(noSync);fs.symlinkSync('/dev/null',path.join(noSync,'failure-spool.jsonl'));
  assert.throws(()=>new FailureSpool(noSync),e=>e.code==='EINVAL');
  const failure=new FailureSpool(path.join(root,'write-then-sync-error')),original=fs.fsyncSync;
  try {
    fs.fsyncSync=()=>{const e=Error('synthetic storage fsync EIO');e.code='EIO';throw e;};
    await assert.rejects(failure.append(make()),e=>e.code==='EIO');assert.equal(bytes,0);
  } finally {fs.fsyncSync=original;await failure.close();}
  const reopened=new FailureSpool(path.join(root,'write-then-sync-error'));
  assert.equal(await reopened.replay(async()=>{}),1);await reopened.close();
  const torn=path.join(root,'torn');const first=new FailureSpool(torn);await first.append(make());await first.close();
  fs.appendFileSync(path.join(torn,'failure-spool.jsonl'),'{"id":');
  const restart=new FailureSpool(torn);assert.equal(await restart.replay(async()=>{}),1);await restart.close();
  assert.equal(fs.readFileSync(path.join(torn,'failure-spool.jsonl.partial'),'utf8'),'{"id":');
  const again=new FailureSpool(torn);assert.equal(await again.replay(async()=>{}),0);await again.close();
  console.log(JSON.stringify({status:'PASS',boundary:'actual tmpfs ENOSPC and kernel fsync EINVAL; injected post-write fsync EIO; partial bytes preserved across restart',protectedBytes:bytes}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
