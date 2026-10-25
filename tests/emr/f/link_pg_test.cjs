/* REQ-EMR-07/15/19 -> RISK-F-01/02 -> TEST-F-LINK-AUDIT
 * REQ-EMR-16 -> RISK-F-03/04 -> TEST-F-LINK-COPY
 * REQ-EMR-17 -> RISK-F-06 -> TEST-F-LINK-HOLD
 * Real Nest HTTP, B1 PG transactions, D/C2 writes and E HTTP/copy facts.
 * Signed OIDC transport and D's not-yet-landed source adapters are synthetic.
 * The shipped AppModule, AuthGuard and current MemberRights admission run unchanged.
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { fork } = require('node:child_process');
const { mkdir } = require('node:fs/promises');
const fs = require('node:fs'), path = require('node:path');
const api = process.env.KIN_F_API || path.resolve(__dirname, '../../../api');
const load = name => require(path.join(api, 'dist', name));
const dependency = name => require(path.join(api, 'node_modules', name));
dependency('reflect-metadata');
const { PrismaClient } = dependency('@prisma/client');
const jose = dependency('jose');
const { NestFactory } = dependency('@nestjs/core');
const { EmrRuntime } = load('emr-runtime/application');
const { AppModule } = load('app.module');
const { ClinicalStore } = load('emr-clinical/store');
const { createOnlineClinicalServices } = load('emr-clinical/services');
const { OnlineSigningStore } = load('emr-report/online-store');
const crypto = load('emr-signature/server-crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const known = value => ({status:'known',value});
const time = delta => new Date(Date.now()+delta).toISOString();
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

if(process.argv.includes('--serve')){
  (async()=>{
    const runtime=new EmrRuntime(process.env.DATABASE_URL,process.env.KIN_F_SPOOL);
    await runtime.start();
    const app=await NestFactory.create(AppModule.withLedger(runtime,{proxyPeers:['127.0.0.1']}),{logger:['error'],abortOnError:false});
    app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');process.send({endpoint:await app.getUrl()});
    process.once('message',async()=>{try{await app.close();process.exit(0);}catch(error){console.error(error);process.exit(1);}});
  })().catch(error=>{console.error(error);process.exit(1);});
}else test('F_LINK real audit, immutable issuance, current designation and atomic extended hold', { timeout: 300000 }, async t => {
  process.env.KIN_EMR_ENVIRONMENT='synthetic-test';
  const db = new PrismaClient(), witness = new PrismaClient({datasources:{db:{url:process.env.KIN_F_WITNESS_URL}}});
  const issuer='https://synthetic.invalid/realms/f-link';
  const {privateKey,publicKey}=await jose.generateKeyPair('RS256');
  const jwk={...await jose.exportJWK(publicKey),kid:'f-link',alg:'RS256',use:'sig'};
  const provider=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/certs')return res.end(JSON.stringify({keys:[jwk]}));
    res.statusCode=404;res.end('{}');
  });
  const oidc=await listen(provider);
  Object.assign(process.env,{KC_ISSUER:issuer,KC_AUDIENCE:'kin-api',AUTH_REQUIRED:'true',
    KIN_COOKIE_SECRET:randomUUID(),KC_WEB_SECRET:randomUUID(),KC_CLIENT_SECRET:randomUUID(),
    PUBLIC_ORIGIN:'https://synthetic.invalid',KC_ADMIN_URL:oidc,KC_JWKS_URL:oidc+'/certs',
    ORTHANC_URL:oidc,ORTHANC_USER:'synthetic',ORTHANC_PASS:randomUUID()});
  const identities={},tokens={};
  let app,endpoint,runtime,port;
  const sourceServers=[];
  try{
  await witness.memberRightsImport.create({data:{id:'realm-v1'}});
  for(const subject of ['officer','auditor','doctor','admin','other']){
    const roles=[['admin','officer'].includes(subject)?'admin':subject==='doctor'?'radiologist':'clinician'];
    const institution=subject==='other'?'synthetic-other':'synthetic-hospital';
    await witness.memberRights.create({data:{sub:subject,username:subject,email:subject+'@example.test',name:'Synthetic '+subject,
      emailVerified:true,approved:true,suspended:false,institution,roles}});
    tokens[subject]=await new jose.SignJWT({email:subject+'@example.test',realm_access:{roles},groups:['/'+institution]})
      .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setSubject(subject).setAudience('kin-api')
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  }
  async function start(){
    if(!port){
      runtime=new EmrRuntime(process.env.DATABASE_URL,path.join(process.env.KIN_F_SPOOL,'producer'));
      await runtime.start();port=runtime.port;
      for(const subject of Object.keys(tokens)){
        const work=port.begin();
        try{identities[subject]={id:await work.resolveRequestIdentity(issuer,subject),issuer,subject};}
        finally{work.end();}
      }
    }
    const child=fork(__filename,['--serve'],{execArgv:[],stdio:['ignore','inherit','inherit','ipc']});
    let closed=false;
    const ended=new Promise(resolve=>child.once('exit',code=>{closed=true;resolve(code);}));
    app={close:async()=>{if(!closed)child.send('stop');assert.equal(await ended,0,'HTTP application shutdown');}};
    endpoint=await new Promise((resolve,reject)=>{
      child.once('message',message=>resolve(message.endpoint));
      child.once('exit',code=>reject(new Error('HTTP application exited '+code)));
    });
  }
  const call=async (actor,method,url,body)=>{
    const r=await fetch(endpoint+'/api/emr-audit/'+url,{method,headers:{'content-type':'application/json',authorization:'Bearer '+tokens[actor],'x-real-ip':'127.0.0.1'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const ok=async (...args)=>{const r=await call(...args);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const query={from:time(-86400000),to:time(86400000)};
    await start();
    const settings=await witness.$queryRaw`SELECT proname,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='emr_access' AND p.proname IN ('investigation_entries','holds_for','duty_requests')`;
    assert.equal(settings.length,3);assert.ok(settings.every(r=>r.proconfig.includes('jit=off')));
    // RED on base main is the real HTTP 404, before attempting F-only storage.
    assert.equal((await call('admin','POST','investigations',query)).status,403,'general admin needs a stored auditor designation');
    const grant={kind:'granted',subject:{issuer,subject:'auditor'},scopes:['investigate','export','disclosure'],validFrom:time(-1000),validUntil:null};
    assert.equal((await call('admin','POST','roster/auditor',grant)).status,403);
    await ok('officer','POST','roster/auditor',grant);
    await ok('officer','POST','roster/auditor',{kind:'changed',scopes:['investigate'],validUntil:null});
    assert.equal((await call('auditor','POST','exports',query)).status,403);
    await ok('officer','POST','roster/auditor',{kind:'changed',scopes:grant.scopes,validUntil:null});
    assert.equal((await call('other','POST','investigations',query)).status,403);
    assert.equal((await call('auditor','POST','investigations',{from:'bad',to:'bad'})).status,400);
    assert.equal((await call('auditor','POST','issuances',{})).status,400);
    assert.equal((await call('auditor','POST','issuances/missing/issue')).status,404);
    assert.equal((await call('auditor','GET','requests/missing')).status,404);
    // Holding a reader lock cannot exclude a second auditor read; a designation write still waits.
    let releaseReader, readyReader;
    const readerReady=new Promise(resolve=>readyReader=resolve), readerRelease=new Promise(resolve=>releaseReader=resolve);
    const rosterLock=JSON.stringify(['emr-f-roster','synthetic-hospital']);
    const holding=witness.$transaction(async tx=>{
      await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${rosterLock},0))::text`;
      readyReader();await readerRelease;
    },{timeout:15000});
    await readerReady;
    try {
      await ok('auditor','POST','investigations',query);
      const blocked=await call('officer','POST','roster/auditor',{kind:'changed',scopes:grant.scopes,validUntil:null});
      assert.equal(blocked.status,500,'designation write requires the exclusive roster lock');
    } finally {releaseReader();await holding;}


    const doctor={identity:identities.doctor,identityRegistrationId:'synthetic-doctor-registration',institutionId:'synthetic-hospital',canSign:true};
    const actor={identity:doctor.identity,kind:'member',roles:['radiologist'],institutionId:doctor.institutionId,signingRegistrationId:doctor.identityRegistrationId};
    const patient={linkId:'synthetic-f-link',patientId:'SYNTHETIC-F',assigningAuthority:'synthetic-hospital'};
    const study={studyId:'2.25.901',patient,managingInstitutionId:doctor.institutionId};
    const wrap=randomBytes(32),pair=crypto.generateServerKeyPair(),kid=randomUUID();
    await new OnlineSigningStore().insertKey(witness,{kid,publicKey:pair.publicKey,doctor,status:'active',registeredAt:time(-1000),endedAt:null},
      crypto.wrapServerPrivateKey(pair.privateKey,kid,'synthetic-wrap',wrap));
    const facts=()=>({actor,requestId:randomUUID(),ip:known({address:'127.0.0.1',source:'trusted-proxy'})});
    const clinical=createOnlineClinicalServices({records:port,store:new ClinicalStore(db),
      identity:{resolve:async()=>({online:true,capacity:'clinical',ingress:{requestId:randomUUID(),ip:facts().ip},actor:{identity:doctor.identity,kind:'member',
        roles:actor.roles,institutionId:doctor.institutionId,identityRegistrationId:doctor.identityRegistrationId,canSign:true,canCancel:true,rightsVersion:'fixture',sessionState:'active'}})},
      secrets:{currentId:'synthetic-wrap',read:async()=>Buffer.from(wrap)},context:{facts:async()=>facts(),study:async()=>study},project:async()=>{}}).runtime;
    const recordId=randomUUID(),empty={content:null,attachments:[],navigation:[],readerId:null,workContext:null,projection:null};
    const command={surface:'consultation.create',studyId:study.studyId,recordId,
      body:{requestId:randomUUID(),expectedOwner:[doctor.institutionId,doctor.identity.subject],recipientSub:'synthetic-recipient',reason:'Synthetic fixed original'},
      prepare:async()=>({...empty,recipientId:'synthetic-recipient'})};
    const first=await clinical.write({},command);assert.equal(first.status,'committed');
    const second=await clinical.write({},{...command,surface:'consultation.cancel',body:{requestId:randomUUID(),expectedOwner:command.body.expectedOwner,revision:1,action:'cancel',note:'Synthetic correction'},prepare:async()=>({...empty,recipientId:null})});
    assert.equal(second.status,'committed');

    const image=await imageDelivery(port,db,identities.doctor,study,sourceServers);
    const page=await ok('auditor','POST','investigations',{...query,patient:{patientId:patient.patientId,assigningAuthority:patient.assigningAuthority}});
    assert.ok(page.changes.rows.some(r=>r.action==='write'&&r.targets.some(t=>t.recordId.value===recordId)));
    assert.ok(page.changes.rows.some(r=>r.action==='cancel'&&r.targets.some(t=>t.versionId.value===second.receipt.versionId)));
    const imageFacts=page.images.find(i=>i.eventId===image.eventId);
    assert.equal(imageFacts.preparation.response_manifest.studyManifestSha256,image.sha256);
    assert.ok(imageFacts.observations.some(o=>o.kind==='transport'));
    assert.ok(imageFacts.observations.some(o=>o.kind==='copies'));
    assert.ok(!page.views.rows.some(r=>r.action==='client-shown'),'transport is not a display observation');
    const exported=await ok('auditor','POST','exports',{...query,recordId});assert.ok(exported.totalEntries>=2);
    const limited=await ok('auditor','POST','investigations',{...query,recordId,limit:1});
    assert.ok(limited.changes.nextCursor);assert.equal(limited.changes.rows.length,1);
    const continued=await ok('auditor','POST','investigations',{...query,recordId,limit:1,changesAfter:limited.changes.nextCursor});
    assert.equal(continued.changes.top,limited.changes.top);
    assert.notEqual(continued.changes.rows[0].eventId,limited.changes.rows[0].eventId);


    const copy=()=>({request:{requestId:randomUUID(),receivedAt:time(-1000),patient,
      basis:{clauseId:'medical:21.1',purpose:'own records'},requester:{kind:'patient',name:'Synthetic patient',organization:null},
      evidence:[{kind:'identity-check',documentId:'synthetic-identity-check',checkedBy:identities.auditor,checkedAt:time(-500)}],
      scope:[{recordId,versions:'all'}],delivery:{recipient:'Synthetic patient',method:'electronic',format:'signed-electronic'}},dueAt:time(86400000)});
    const c2=await reportProducer(port,witness,doctor,study,wrap);
    const signed=await c2.approve();
    const c2input=copy();c2input.request.scope=[{recordId:signed.recordId,versions:'all'}];
    const stale=await ok('auditor','POST','issuances',c2input);
    const added=await c2.approve('addendum',signed.versionId);
    assert.equal((await call('auditor','POST',`issuances/${encodeURIComponent(stale.issuanceId)}/issue`)).body.code,'RecordHeadChanged');
    const fresh=await ok('auditor','POST','issuances',c2input);
    assert.notEqual(fresh.issuanceId,stale.issuanceId);assert.equal(fresh.manifest.records[0].versions.length,2);
    assert.equal((await ok('auditor','POST','issuances',c2input)).issuanceId,fresh.issuanceId,'same request retry');
    const reportCopy=await ok('auditor','POST',`issuances/${encodeURIComponent(fresh.issuanceId)}/issue`);
    const reportOriginals=JSON.parse(Buffer.from(reportCopy.artifact,'base64')).originals;
    assert.deepEqual(JSON.parse(reportOriginals[1].original).envelope,added.envelope);
    const paper=copy();paper.request.scope=c2input.request.scope;paper.request.delivery={recipient:'Synthetic patient',method:'in-person',format:'paper-print'};
    const printPrepared=await ok('auditor','POST','issuances',paper);
    const printCopy=await ok('auditor','POST',`issuances/${encodeURIComponent(printPrepared.issuanceId)}/issue`);
    assert.equal(printCopy.contentType,'text/html; charset=utf-8');
    const html=Buffer.from(printCopy.artifact,'base64');assert.equal(hash(html),printCopy.sha256);
    assert.ok(html.toString().includes('Synthetic report &lt;follow-up&gt;'));
    assert.ok(html.toString().includes('synthetic-doctor-registration'));
    assert.ok(!html.toString().includes('<dt>Author</dt><dd>doctor</dd>'));
    fs.writeFileSync(path.join(process.env.KIN_F_SPOOL,'fixed-copy.html'),html);

    const input=copy(), prepared=await ok('auditor','POST','issuances',input);
    assert.equal(prepared.manifest.records[0].versions.length,2);
    const issued=await ok('auditor','POST',`issuances/${encodeURIComponent(prepared.issuanceId)}/issue`);
    const bytes=Buffer.from(issued.artifact,'base64');assert.equal(hash(bytes),issued.sha256);
    const pkg=JSON.parse(bytes);assert.equal(pkg.originals.length,2);
    assert.ok(JSON.parse(pkg.originals[0].original).plan.includes('Synthetic fixed original'));
    assert.ok(JSON.parse(pkg.originals[1].original).signature);
    assert.equal(load('emr-audit/contract').issuanceState(issued.issuance).state,'Issued');
    const requestId=input.request.requestId;
    assert.equal((await call('auditor','POST',`requests/${requestId}/resolve`,{outcome:'fulfilled',evidenceId:'not-yet-delivered'})).status,409);

    const ext={extensionId:randomUUID(),previousDueAt:input.dueAt,dueAt:time(172800000),basis:{clauseId:'privacy:35.3',version:'21445'},evidenceId:'synthetic-delay-notice'};
    const extended=await ok('auditor','POST',`requests/${requestId}/extend`,ext);
    assert.equal(extended.facts.extensions.length,1);
    const fhold=load('emr-audit/contract').requestHoldState(extended.facts,extended.holds[0],time(90000000));
    assert.equal(fhold.preserve,true);assert.equal(fhold.state,'pending');
    const due=await witness.$queryRaw`SELECT body FROM emr_access.duty_requests('access-request',${requestId})`;
    assert.equal(JSON.parse(due[0].body).responseDueAt,ext.dueAt);
    const held=await witness.$queryRaw`SELECT body FROM emr_access.holds_for(${recordId})`;
    assert.equal(JSON.parse(held[0].body).basis.validity.until,ext.dueAt);
    assert.equal((await ok('auditor','POST',`requests/${requestId}/extend`,ext)).facts.extensions.length,1);
    const replayAccess=await witness.$queryRaw`SELECT payload::jsonb AS event FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface'='POST emr-audit/requests/:id/extend' AND payload::jsonb->>'action'='provide-prepared'`;
    assert.equal(replayAccess.length,1,'an idempotent retry still records the returned patient/request facts');

    // Package failure must retain the separately committed request/hold intake.
    const rejected=copy();
    await witness.$executeRawUnsafe("CREATE FUNCTION emr_audit.fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic issuance failure'; END $$");
    await witness.$executeRawUnsafe('CREATE TRIGGER fixture_failure BEFORE INSERT ON emr_audit.issuance_event FOR EACH ROW EXECUTE FUNCTION emr_audit.fixture_fail()');
    assert.equal((await call('auditor','POST','issuances',rejected)).status,500);
    await witness.$executeRawUnsafe('DROP TRIGGER fixture_failure ON emr_audit.issuance_event');
    await witness.$executeRawUnsafe('DROP FUNCTION emr_audit.fixture_fail()');
    assert.equal((await witness.$queryRaw`SELECT body FROM emr_audit.request_event WHERE request_id=${rejected.request.requestId}`).length,1);
    assert.equal((await witness.$queryRaw`SELECT body FROM emr_access.duty_requests('access-request',${rejected.request.requestId})`).length,1);

    const unavailable=copy();unavailable.request.scope=[{recordId:'unpackaged-original',versions:'all'}];
    const intake=await ok('auditor','POST','requests',unavailable);
    assert.equal(intake.issuanceId,null);assert.equal(intake.holds.length,1);
    assert.equal((await call('auditor','POST','issuances',unavailable)).body.code,'VersionListingIncomplete');
    assert.equal((await ok('auditor','GET',`requests/${unavailable.request.requestId}`)).states[0].preserve,true);
    await ok('auditor','POST',`requests/${unavailable.request.requestId}/extend`,{...ext,extensionId:randomUUID(),previousDueAt:unavailable.dueAt});
    await ok('auditor','POST',`requests/${unavailable.request.requestId}/resolve`,{outcome:'withdrawn',evidenceId:'withdrawn-without-copy'});

    await futureHold(port,db,witness,identities.auditor,copy);
    await scaling(witness,ok,query,patient,identities.doctor);

    await app.close();await start();
    const reopened=await ok('auditor','POST',`issuances/${encodeURIComponent(prepared.issuanceId)}/issue`);
    assert.equal(reopened.artifact,issued.artifact,'restart reuses stored bytes and signatures');
    const damaged=Buffer.from('incomplete restore');
    await witness.$executeRaw`UPDATE emr_audit.fixed_copy SET body=${damaged} WHERE issuance_id=${prepared.issuanceId}`;
    assert.equal((await call('auditor','POST',`issuances/${prepared.issuanceId}/issue`)).body.code,'FixedCopyIntegrityMismatch');
    await witness.$executeRaw`UPDATE emr_audit.fixed_copy SET sha256=${hash(damaged)} WHERE issuance_id=${prepared.issuanceId}`;
    assert.equal((await call('auditor','POST',`issuances/${prepared.issuanceId}/issue`)).body.code,'FixedCopyIntegrityMismatch');
    await witness.$executeRaw`UPDATE emr_audit.fixed_copy SET body=${bytes},sha256=${issued.sha256} WHERE issuance_id=${prepared.issuanceId}`;

    await ok('auditor','POST',`issuances/${encodeURIComponent(prepared.issuanceId)}/delivery`,{outcome:'unknown',evidence:null,note:'Synthetic receipt pending'});
    await ok('auditor','POST',`issuances/${encodeURIComponent(prepared.issuanceId)}/delivery`,{outcome:'delivered',evidence:{kind:'electronic-receipt',evidenceId:'synthetic-recipient-receipt'},note:null});
    const raced=await Promise.all([
      call('auditor','POST',`requests/${requestId}/extend`,{...ext,extensionId:randomUUID(),previousDueAt:ext.dueAt,dueAt:time(259200000)}),
      call('auditor','POST',`requests/${requestId}/resolve`,{outcome:'fulfilled',evidenceId:'synthetic-recipient-receipt'})]);
    assert.equal(raced[1].status,200,JSON.stringify(raced[1].body));assert.ok([200,409].includes(raced[0].status));
    const resolved=await ok('auditor','GET',`requests/${requestId}`);
    await ok('auditor','POST',`requests/${requestId}/resolve`,{outcome:'fulfilled',evidenceId:'synthetic-recipient-receipt'});
    const resolvedReplay=await witness.$queryRaw`SELECT payload::jsonb AS event FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface'='POST emr-audit/requests/:id/resolve' AND payload::jsonb->>'action'='provide-prepared'`;
    assert.equal(resolvedReplay.length,1);
    const work=port.begin();
    try{
      const snapshot=await work.transactionWithRecords(tx=>work.snapshot(tx,{}, {recordIds:[recordId],accessRequestIds:[requestId]}));
      assert.equal(snapshot.accessRequests.get(requestId).resolution.outcome,'fulfilled');
      assert.equal(snapshot.holds.get(resolved.holds[0].holdId).release.evidenceId,'synthetic-recipient-receipt');
    }finally{work.end();}
    assert.equal(load('emr-audit/contract').requestHoldState(resolved.facts,resolved.holds[0],time(1000)).preserve,false);
    await ok('officer','POST','roster/auditor',{kind:'revoked',reason:'Synthetic designation ended'});
    assert.equal((await call('auditor','POST',`issuances/${encodeURIComponent(prepared.issuanceId)}/issue`)).status,403);
    assert.equal((await call('auditor','GET',`requests/${requestId}`)).status,403);
    console.log('F_LINK audit/copy/hold HTTP and PG assertions completed');
  }finally{
    for(const server of sourceServers)await close(server);
    await app?.close();if(runtime)await runtime.stop(Date.now()+15000);await close(provider);await db.$disconnect();await witness.$disconnect();
  }
});

async function imageDelivery(port,db,actor,study,servers){
  const {buildImageManifest}=load('emr-image/manifest'),E=load('emr-image/contract');
  const {sendOnlineImage}=load('emr-image/stream'),{PgImageEvidenceStore}=load('emr-image/store');
  const {OrthancService}=load('orthanc.service');
  const {parseAccessEvent}=load('emr-contract/access-event');
  const original=Buffer.alloc(4096,37),studyUid=study.studyId,seriesUid=studyUid+'.1',sop=seriesUid+'.1',ts='1.2.840.10008.1.2.1';
  original.write('DICM',128);
  const manifest=buildImageManifest({formatVersion:1,studyUid,managingInstitution:study.managingInstitutionId,patient:study.patient,builtAt:time(0),expected:{series:1,objects:1},
    pages:[{cursor:null,next:null,objects:[{studyUid,seriesUid,sopInstanceUid:sop,sopClassUid:'1.2.840.10008.5.1.4.1.1.7',transferSyntaxUid:ts,imageType:['ORIGINAL','PRIMARY'],
      bytes:original.length,sha256:hash(original),declaredFrameCount:1,frames:[{number:1,bytes:original.length,sha256:hash(original)}],
      provenance:{kind:'device',receiptEventId:null},derivation:{kind:'original'},mammography:null,timing:null}]}],referencedObjects:[],
    decoderCatalog:{native:{version:'synthetic',sha256:hash('decoder')}},viewer:{id:'synthetic',version:'fixture',sha256:hash('viewer')}});
  const source=createServer((req,res)=>{
    const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(req.url==='/tools/lookup')return json([{Type:'Instance',ID:'11111111-22222222-33333333-44444444-55555555'}]);
    if(req.url.endsWith('/simplified-tags'))return json({StudyInstanceUID:studyUid,SeriesInstanceUID:seriesUid,SOPInstanceUID:sop,SOPClassUID:manifest.objects[0].sopClassUid,NumberOfFrames:'1'});
    if(req.url.endsWith('/header'))return json({'0002,0010':{Value:ts}});
    if(req.url.endsWith('/file'))return res.end(original);
    res.writeHead(404);res.end();
  });servers.push(source);process.env.ORTHANC_URL=await listen(source);process.env.ORTHANC_USER='synthetic';process.env.ORTHANC_PASS=randomUUID();
  const at=time(0),eventId=randomUUID(),target=`/dicom-web/studies/${studyUid}/series/${seriesUid}/instances/${sop}`;
  const prepared=E.prepareDelivery(manifest,E.parseImageRequest('GET',target),{eventId,at,cause:'user-view',opening:null,
    authorization:{studyUid,institution:study.managingInstitutionId,accountGeneration:1},provision:E.checkProvisionBasis({relation:'same-institution',at,managingInstitution:study.managingInstitutionId,
      recipient:null,studyUid,purpose:null,basis:null,agreement:null,auditBefore:null})});
  const event=parseAccessEvent({formatVersion:1,surface:'dicom-web-study-series-instance-frame',eventId,userId:known(actor),rolesAtTime:known(['radiologist']),
    actingInstitution:known(study.managingInstitutionId),managingInstitution:known(study.managingInstitutionId),occurredAt:at,trustedProxyIp:known({address:'127.0.0.1',source:'trusted-proxy'}),
    cause:'user-view',context:{basis:'worklist',studyId:null,relatedStudyId:null,reason:null},executor:'member',targets:[{kind:'image',patientLinkSnapshot:known(study.patient),studyId:known(studyUid),recordId:known(sop),versionId:known(manifest.sha256)}],
    action:'provide-prepared',result:'prepared',requestId:randomUUID(),auditLinkId:'audit:'+randomUUID(),relatedEventId:null});
  const staging=path.join(process.env.KIN_F_SPOOL,'staging');await mkdir(staging,{recursive:true});
  let finish;const settled=new Promise((resolve,reject)=>finish={resolve,reject});
  const server=createServer(async(req,res)=>{
    try{await sendOnlineImage({records:port,evidence:new PgImageEvidenceStore(db),source:new OrthancService().imageSource(),stagingDirectory:staging,authorize:async()=>{}},
      {manifest,prepared,event,response:res,signal:new AbortController().signal});finish.resolve();}
    catch(error){res.statusCode=500;res.end();finish.reject(error);}
  });servers.push(server);
  const response=await fetch(await listen(server));assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/^multipart\/related/);
  const wire=Buffer.from(await response.arrayBuffer()), bodyStart=wire.indexOf('\r\n\r\n')+4;
  assert.ok(bodyStart>=4);assert.equal(hash(wire.subarray(bodyStart,bodyStart+original.length)),hash(original));await settled;
  return{eventId,sha256:manifest.sha256};
}

async function reportProducer(port,witness,doctor,study,wrap){
  const {createServerSigning}=load('emr-signature/server-signing.module');
  const {pgSigningLedger}=load('emr-signature/pg-ledger');
  const {transitionReport}=load('emr-contract/report-lifecycle');
  const recordId=randomUUID();
  const current={study:{...study,readingInstitutionIds:[doctor.institutionId],assignment:{readerId:doctor.identity.id,generation:1}},
    facts:{recordId,studyId:study.studyId,previousCancelledRecordId:null,contentHistory:[],state:'In Progress',firstApprovedAt:null,
      originalSignerId:null,amendUntil:null,publishedVersion:null,bodyVersion:null,addenda:[],claimantId:doctor.identity.id,
      claimGeneration:1,preliminary:null,cancellation:null,finalized:null,retentionOnlySince:null},author:doctor.identity,attachments:[]};
  await witness.$executeRawUnsafe('CREATE TABLE public.fixture_f_report(record_id text PRIMARY KEY,body jsonb NOT NULL)');
  await witness.$executeRawUnsafe('GRANT SELECT,UPDATE ON public.fixture_f_report TO kin_runtime');
  await witness.$executeRaw`INSERT INTO public.fixture_f_report VALUES(${recordId},${JSON.stringify(current)}::jsonb)`;
  const service=createServerSigning({ledger:pgSigningLedger(port),secrets:{currentId:'synthetic-wrap',read:async()=>Buffer.from(wrap)},
    identity:{resolve:async()=>({online:true,capacity:'clinical',ingress:{requestId:randomUUID(),ip:known({address:'127.0.0.1',source:'trusted-proxy'})},
      actor:{identity:doctor.identity,identityRegistrationId:doctor.identityRegistrationId,kind:'member',roles:['radiologist'],
        institutionId:doctor.institutionId,canSign:true,canCancel:true,rightsVersion:'fixture',sessionState:'active'}})},
    // This owned report fixture stands in for the source adapter pending #219.
    // Signing, immutable storage, lifecycle transitions and ledger are real.
    reports:{lock:async tx=>(await tx.$queryRaw`SELECT body FROM public.fixture_f_report WHERE record_id=${recordId} FOR UPDATE`)[0].body,
      validate:async()=>{},authorizeResult:async()=>{},publish:async(tx,current,command)=>{
        const next={...current,facts:transitionReport(current.facts,command).facts};
        await tx.$executeRaw`UPDATE public.fixture_f_report SET body=${JSON.stringify(next)}::jsonb WHERE record_id=${recordId}`;
      }}});
  return{approve:(action='approve',previous=null)=>service.approval.approve({}, {operationId:randomUUID(),action,recordId,studyId:study.studyId,patient:study.patient,
    expectedClaimGeneration:previous?2:1,expectedPublishedVersionId:previous,submittedDraftRevision:null,
    text:{findings:'Synthetic report <follow-up>',conclusion:'Synthetic conclusion',recommendation:''},reason:null})};
}


async function futureHold(port,db,witness,auditor,copy) {
  const {EmrAuditService}=load('emr-audit/service'), {withSnapshot}=load('emr-runtime/context');
  const {reloadLegalHolds}=load('emr-contract/lawful-defaults');
  const {AccessLedgerStore}=load('emr-runtime/store');
  const NativeDate=Date, at='2027-03-09T00:00:00.000Z';
  global.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[at]));}static now(){return NativeDate.parse(at);}};
  try {
    const source={withWork:async(_req,task)=>{
      const work=port.begin();
      try{return await task({work,facts:{actor:auditor,institution:'synthetic-hospital',roles:['clinician'],
        surface:'POST emr-audit/requests',requestId:randomUUID(),ingress:known({address:'127.0.0.1',source:'trusted-proxy'})},
        requireCurrent:async()=>{},assertActive:()=>{}});}finally{work.end();}
    }};
    const service=new EmrAuditService(db,source),input=copy();input.request.scope=[{recordId:'future-original',versions:'all'}];
    const state=await service.register({},input);
    assert.equal(state.holds[0].basis.clause.version,'21910');
    const read=async()=>{
      const work=port.begin(),scope={};
      try{return await work.transactionWithRecords(async tx=>{
        const snapshot=await work.snapshot(tx,scope,{recordIds:['future-original'],accessRequestIds:[state.facts.requestId]});
        return withSnapshot(scope,snapshot,()=>reloadLegalHolds('future-original'));
      });}finally{work.end();}
    };
    assert.equal((await read())[0].basis.clause.version,'21910','A reads the post-2027-03-09 placement');
    const extended=await service.extend({},state.facts.requestId,{extensionId:randomUUID(),previousDueAt:input.dueAt,
      dueAt:time(172800000),basis:{clauseId:'privacy:35.3',version:'21910'},evidenceId:'future-notice'});
    assert.equal((await read())[0].basis.validity.until,extended.facts.extensions[0].dueAt);
    const resolved=await service.resolve({},state.facts.requestId,{outcome:'withdrawn',evidenceId:'future-withdrawal'});
    // The B1 adapter must accept the placement's semantic facts despite JSONB key order,
    // including a release replay after F's request snapshot carries the release.
    await db.$transaction(tx=>new AccessLedgerStore(db,null).recordHoldRelease(tx,resolved.holds[0]));
    assert.equal((await read())[0].release.evidenceId,'future-withdrawal');
    const other=copy();other.request.scope=[{recordId:'b1-released-original',versions:'all'}];
    const b1=await service.register({},other),hold=b1.holds[0];
    const resolution={at,eventId:'b1-ending',outcome:'withdrawn'};
    const released={...hold,release:{holdId:hold.holdId,actorId:auditor.id,at,evidenceId:'b1-ending',authorityVerified:true,
      reason:'effect-ended',endingFact:{kind:'request-resolved',at,eventId:'b1-ending'}}};
    await db.$transaction(async tx=>{
      const store=new AccessLedgerStore(db,null);
      await store.recordDutyRequest(tx,'access-request',{requestId:b1.facts.requestId,recordIds:b1.facts.recordIds,
        receivedAt:b1.facts.receivedAt,responseDueAt:b1.facts.initialDueAt,resolution});
      await store.recordHoldRelease(tx,released);
    });
    const work=port.begin(),scope={};
    try { await work.transactionWithRecords(async tx=>{
      const snap=await work.snapshot(tx,scope,{recordIds:b1.facts.recordIds,accessRequestIds:[b1.facts.requestId]});
      const readBack=withSnapshot(scope,snap,()=>reloadLegalHolds('b1-released-original'));
      assert.equal(readBack[0].release.evidenceId,'b1-ending');
    }); } finally {work.end();}

  } finally {global.Date=NativeDate;}
}

async function scaling(witness,ok,query,patient,actor) {
  const measurements=[];
  const [template]=await witness.$queryRaw`SELECT payload FROM emr_access.access_entry WHERE stream='history' ORDER BY sequence LIMIT 1`;
  // Seed legal B1 rows through its actual admission/append functions; all data belongs to this disposable fixture.
  for (const count of [1000,1000,2000,4000,2000]) {
    const payload=template.payload.replaceAll("'","''");
    await witness.$executeRawUnsafe(`DO $seed$
      DECLARE i integer; op uuid; attempt uuid; event text;
      BEGIN FOR i IN 1..${count} LOOP
        op:=gen_random_uuid();attempt:=gen_random_uuid();
        event:=jsonb_set('${payload}'::jsonb,'{eventId}',to_jsonb(gen_random_uuid()::text))::text;
        PERFORM emr_access.admit_operation(op,attempt,event,'기재');
        PERFORM emr_access.append_operation(op,attempt,event,'기재',NULL,NULL,NULL);
      END LOOP; END $seed$`);
    await witness.$executeRawUnsafe('ANALYZE emr_access.access_entry');
    for(const stream of ['history','viewing']) {
      const [scope]=await witness.$queryRaw`SELECT count(*)::integer AS n,max(sequence)::text AS top FROM emr_access.access_entry
        WHERE stream=${stream} AND occurred_at>=${query.from}::timestamptz AND occurred_at<${query.to}::timestamptz`;
      for(const kind of ['top','rows']) {
        const top=kind==='top'?null:Number(scope.top),before=kind==='top'?null:Math.floor(top/2);
        const plan=await witness.$queryRaw`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM emr_access.investigation_entries(
          ${stream},'synthetic-hospital',${query.from}::timestamptz,${query.to}::timestamptz,${top}::bigint,${before}::bigint,${kind==='top'?1:500}::integer)`;
        const data=plan[0]['QUERY PLAN'][0];
        measurements.push({stream,scopedRows:scope.n,call:kind,ms:data['Execution Time'],tempReadBlocks:data.Plan['Temp Read Blocks']??0});
        fs.writeFileSync(path.join(process.env.KIN_F_SPOOL,'scaling.json'),JSON.stringify(measurements,null,2));
      }
    }
  }
  // Same E table scale as the review, with actual selected B1 UUIDs included in the 300k rows.
  await witness.$executeRawUnsafe(`INSERT INTO emr_image.preparation(event_id,study_uid,source_manifest,response_manifest,staging_copies)
    SELECT event_id::uuid,'2.25.901','{}','{}','[]' FROM emr_access.access_entry WHERE stream='history'
      AND event_id ~ '^[0-9a-f-]{36}$' ON CONFLICT DO NOTHING`);
  await witness.$executeRawUnsafe(`INSERT INTO emr_image.preparation(event_id,study_uid,source_manifest,response_manifest,staging_copies)
    SELECT gen_random_uuid(),'2.25.901','{}','{}','[]' FROM generate_series(1,300000-(SELECT count(*)::integer FROM emr_image.preparation))`);
  await witness.$executeRawUnsafe(`INSERT INTO emr_image.observation(event_id,kind,body)
    SELECT event_id,'transport','{}' FROM emr_image.preparation`);
  await witness.$executeRawUnsafe('ANALYZE emr_image.preparation');await witness.$executeRawUnsafe('ANALYZE emr_image.observation');
  const ids=(await witness.$queryRaw`SELECT event_id::text FROM emr_access.access_entry WHERE stream='history' ORDER BY sequence DESC LIMIT 200`).map(r=>r.event_id);
  for(const table of ['preparation','observation']) for(const form of ['text','uuid','batch']) {
    const where=form==='text'?`event_id::text='${ids[0]}'`:form==='uuid'?`event_id='${ids[0]}'::uuid`:
      `event_id=ANY(ARRAY[${ids.map(id=>`'${id}'`).join(',')}]::uuid[])`;
    const [plan]=await witness.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM emr_image.${table} WHERE ${where}`);
    const data=plan['QUERY PLAN'][0];measurements.push({table,rows:300000,form,ms:data['Execution Time'],plan:data.Plan});
  }
  fs.writeFileSync(path.join(process.env.KIN_F_SPOOL,'scaling.json'),JSON.stringify(measurements,null,2));
  const filter={...query,patient:{patientId:patient.patientId,assigningAuthority:patient.assigningAuthority}};
  for (const route of ['investigations','exports']) {
    const started=performance.now(),page=await ok('auditor','POST',route,{...filter,...(route==='investigations'?{limit:500}:{})});
    const ms=performance.now()-started;
    assert.ok(page.changes.total>=10000);assert.ok(page.views.total>=10000);
    if(route==='investigations')assert.equal(page.changes.rows.length,500);
    else assert.ok(page.changes.rows.length>=10000);
    assert.ok(ms<load('emr-runtime/limits').EMR_TX_TIMEOUT_MS,`${route} within the product transaction limit: ${ms}`);
    const events=await witness.$queryRaw`SELECT payload FROM emr_access.access_entry
      WHERE payload::jsonb->>'surface'=${'POST emr-audit/'+route} ORDER BY sequence DESC`;
    const requestId=JSON.parse(events[0].payload).requestId;
    const chunks=events.map(r=>({event:JSON.parse(r.payload),bytes:Buffer.byteLength(r.payload)})).filter(r=>r.event.requestId===requestId);
    const expected=new Set([...page.changes.rows,...page.views.rows].map(r=>r.eventId));
    const actual=new Set(chunks.flatMap(r=>r.event.targets.map(t=>t.recordId.value)));
    assert.equal(actual.size,expected.size,'every exported/shown event retained across bounded B1 events');
    for(const id of expected)assert.ok(actual.has(id),'shown event missing from B1: '+id);
    assert.ok(chunks.length>1);assert.ok(chunks.every(r=>r.bytes<=65536));
    measurements.push({route,ms,changes:page.changes.rows.length,views:page.views.rows.length,chunks:chunks.length,maxPayload:Math.max(...chunks.map(r=>r.bytes))});
  }
  fs.writeFileSync(path.join(process.env.KIN_F_SPOOL,'scaling.json'),JSON.stringify(measurements,null,2));
  console.log('F_LINK_SCALE',JSON.stringify(measurements.map(({plan,...r})=>r)));
}
