'use strict';
/* REQ-S8-CTX-AUDIT -> RISK-CTX-TENANT/TEXT -> CTX-SERVER.
 * Compiled controller, service, Pacs image admission and StudyAccess; only storage is synthetic.
 */
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const dist=process.env.KIN_CTX_API_DIST||'/app/dist';
const {ViewerContextEventService}=require(path.join(dist,'viewer-context-event.service'));
const {ViewerController}=require(path.join(dist,'viewer.controller'));
const {PacsService}=require(path.join(dist,'pacs.service'));
const {StudyAccessService}=require(path.join(dist,'study-access.service'));
const policy=require(path.join(dist,'clinician-policy'));
const audit=require(path.join(dist,'admin-audit'));
const uuid='01234567-1234-1234-1234-012345678901';
const input=()=>({eventId:uuid,faultId:uuid,stage:'loss',occurredAt:'2026-10-05T01:00:00.000Z',engine:'webgl',viewport:'stack',cause:'context-lost',repeatCount:1,attempt:0,reason:'none',result:'unknown'});
function fixture(){
 const f={rows:[],study:{uid:'1.2.3',institutionId:'hospital',teleInstitutionId:null},restriction:null};
 const db={studyState:{findUnique:async()=>f.study},$queryRaw:async()=>f.restriction?[f.restriction]:[],
  auditLog:{create:async({data})=>{f.rows.push(data);return data}}};
 const access=new StudyAccessService(db,{},{}),pacs=new PacsService(db,{}, {},access,{});
 const service=new ViewerContextEventService(db,pacs);f.controller=new ViewerController({},pacs,service);f.db=db;
 f.caller={kind:'member',sub:uuid,actor:'reader',institution:'hospital',roles:['radiologist']};
 f.send=(body=input(),c=f.caller)=>f.controller.contextEvent('1.2.3',{...c,rawBody:Buffer.from(JSON.stringify(body))});
 return f;
}
for(const role of ['radiologist','technician','admin','clinician'])test('CTX-SERVER accepts visible '+role+' and server attributes row',async()=>{
 const f=fixture();f.caller.roles=[role];const result=await f.send();assert.equal(result.recorded,true);assert.equal(f.rows.length,1);
 const row=f.rows[0],detail=JSON.parse(row.detail);assert.equal(row.actor,'reader');assert.equal(row.target,'1.2.3');assert.equal(row.action,'viewer-context.event');
 assert.equal(detail.institution,'hospital');assert.equal(detail.subject,uuid);assert.equal(detail.eventId,uuid);
 assert.ok(Number.isFinite(Date.parse(detail.receivedAt)));assert.equal(audit.projectAuditRow({...row,at:detail.receivedAt},'other'),null);
 assert.equal(audit.projectAuditRow({...row,at:detail.receivedAt},'hospital').detail.faultId,uuid);
});
test('CTX-SERVER rejects gateway, unapproved and absent role before a row',async()=>{
 for(const c of [{kind:'gateway',roles:['gateway']},{roles:[]},{roles:['guest']},{institution:null}]){
  const f=fixture();await assert.rejects(f.send(input(),{...f.caller,...c}),e=>e.getStatus()===403);assert.equal(f.rows.length,0);
 }
});
test('CTX-SERVER owner, tele receiver and admin all follow the image institution boundary',async()=>{
 for(const role of ['radiologist','technician','admin','clinician']){
  const f=fixture();f.caller.roles=[role];f.study.institutionId='other';await assert.rejects(f.send(),e=>e.getStatus()===403);assert.equal(f.rows.length,0);
  f.study.teleInstitutionId='hospital';await f.send();assert.equal(f.rows.length,1);
 }
});
test('CTX-SERVER StudyAccess refusal and missing study leave no audit row',async()=>{
 const f=fixture();f.restriction={institution:'hospital',revision:1,policy:{version:1,restricted:true,startsAt:null,endsAt:null,rules:[]}};
 await assert.rejects(f.send());assert.equal(f.rows.length,0);
 f.restriction=null;f.study=null;await assert.rejects(f.send(),e=>e.getStatus()===403);assert.equal(f.rows.length,0);
});
test('CTX-SERVER refuses free text, identity, pixels and malformed finite vocabulary',async()=>{
 for(const field of ['report','note','description','image','error','actor','subject','institution','seriesUid']){
  const f=fixture();await assert.rejects(f.send({...input(),[field]:'private free text'}),e=>e.getStatus()===400);assert.equal(f.rows.length,0);
 }
 for(const [field,value] of [['stage','a report'],['cause','GPU error text'],['reason','notes'],['engine','runtime-id'],['viewport','custom'],['result','probably'],['occurredAt','yesterday'],['eventId','free-text'],['faultId',''],['repeatCount',0],['repeatCount',1.2],['attempt',-1]]){
  const f=fixture();await assert.rejects(f.send({...input(),[field]:value}),e=>e.getStatus()===400);assert.equal(f.rows.length,0);
 }
});
test('CTX-SERVER clinician route is the narrow diagnostic POST only',()=>{
 const key=policy.routeKey(Reflect.getMetadata('method',ViewerController.prototype.contextEvent),Reflect.getMetadata('path',ViewerController),Reflect.getMetadata('path',ViewerController.prototype.contextEvent));
 assert.equal(key,'POST studies/:uid/viewer-context-events');assert.equal(policy.clinicianRouteAllowed(key),true);
 assert.equal(policy.clinicianRouteAllowed('POST studies/:uid/viewer-items'),false);
});
test('CTX-SERVER database failure is not a recorded receipt',async()=>{
 const f=fixture();f.db.auditLog.create=async()=>{throw Error('unavailable')};await assert.rejects(f.send(),/unavailable/);
});
