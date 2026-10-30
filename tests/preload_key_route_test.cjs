// REQ-MG-PRELOAD-CACHE -> RISK-PRELOAD-CROSS-USER / KEY-OUTLIVES-DATA -> R2/R3/R6/R17.
// Real controller and guard; the DB double checks service lifecycle, not SQL concurrency (served/PG run required).
const test = require('node:test'), assert = require('node:assert/strict');
require('./service_test_loader.cjs');
require('../api/node_modules/reflect-metadata');
const { PreloadKeyService } = require('../api/src/preload-key.service.ts');
const { PreloadKeyController } = require('../api/src/preload-key.controller.ts');
const { AuthGuard } = require('../api/src/auth.guard.ts');
const { Reflector } = require('../api/node_modules/@nestjs/core');
const { ExecutionContextHost } = require('../api/node_modules/@nestjs/core/helpers/execution-context-host');
const { HttpException } = require('../api/node_modules/@nestjs/common');
const { HEADERS_METADATA } = require('../api/node_modules/@nestjs/common/constants');
const caller = (sub='A',institution='hospital') => ({sub,institution,actor:sub,kind:'member',roles:['radiologist']});
function world() {
  const rows=[],timers=[];
  const db={preloadCacheKey:{async updateMany({where,data}) {
    let count=0;
    for(const row of rows) if(row.retiredAt===where.retiredAt && row.lastIssuedAt<=where.lastIssuedAt.lte
      && (!where.institution||row.institution===where.institution) && (!where.sub||row.sub===where.sub)) {Object.assign(row,data);count++;}
    return {count};
  }},async $transaction(fn){return fn(db);},async $queryRaw(_sql,id,institution,sub,key,createdAt,lastIssuedAt) {
    let row=rows.find(r=>r.institution===institution&&r.sub===sub&&r.retiredAt===null);
    if(!row){row={id,institution,sub,key,createdAt,lastIssuedAt,retiredAt:null};rows.push(row);}
    else row.lastIssuedAt=new Date(Math.max(row.lastIssuedAt,lastIssuedAt));
    return [{id:row.id,key:row.key}];
  }};
  const service=new PreloadKeyService(db,{every:(name,ms,fn)=>{timers.push({name,ms,fn});return ()=>timers.pop();}});
  return {service,controller:new PreloadKeyController(service),rows,timers};
}
test('R2 R3 R6 bound member issue is no-store, same owner stable, different user/institution separate, clinician denied',async()=>{
  const w=world(),a=await w.service.issue(caller());
  assert.equal(Buffer.from(a.key,'base64').length,32);
  assert.deepEqual(Object.keys(a).sort(),['key','keyId','serverTime']);
  assert.equal((await w.service.issue(caller())).keyId,a.keyId);
  assert.notEqual((await w.service.issue(caller('B'))).keyId,a.keyId);
  assert.notEqual((await w.service.issue(caller('A','other'))).keyId,a.keyId);
  for(const c of [{...caller(),roles:['clinician']},{...caller(),institution:null},{...caller(),kind:'gateway'}])
    await assert.rejects(w.service.issue(c),e=>e.getStatus()===403);
  assert.throws(()=>w.controller.read({...caller(),authMethod:'bearer'}),e=>e.getStatus()===403);
  assert.deepEqual(Reflect.getMetadata(HEADERS_METADATA,PreloadKeyController.prototype.read),[{name:'Cache-Control',value:'no-store'}]);
});
test('R17 hourly retirement deletes bytes and retains identity/time; fresh key next issue, lastIssuedAt advances',async()=>{
  const w=world();w.service.onModuleInit();assert.equal(w.timers[0].ms,3600000);
  const a=await w.service.issue(caller()),b=await w.service.issue(caller('B'));
  const now=new Date();w.rows[0].lastIssuedAt=new Date(+now-72*3600000-60000);w.rows[1].lastIssuedAt=new Date(+now-71*3600000);
  await w.service.retire(now);
  assert.equal(w.rows[0].key,null);assert.equal(+w.rows[0].retiredAt,+now);assert.equal(w.rows[0].id,a.keyId);
  assert.equal(w.rows[1].retiredAt,null);
  const issued=await w.service.issue(caller());assert.notEqual(issued.keyId,a.keyId);
  const before=+w.rows[1].lastIssuedAt;assert.equal((await w.service.issue(caller('B'))).keyId,b.keyId);assert.ok(+w.rows[1].lastIssuedAt>before);
  w.service.onModuleDestroy();assert.equal(w.timers.length,0);
});
test('R17 issuance itself retires overdue keys even before the hourly job runs',async()=>{
  const w=world(),a=await w.service.issue(caller());w.rows[0].lastIssuedAt=new Date(Date.now()-73*3600000);
  assert.notEqual((await w.service.issue(caller())).keyId,a.keyId);assert.equal(w.rows[0].key,null);
});
test('R6 real session guard refuses missing/mismatched/ended binding and clinician before issue, with auth codes',async()=>{
  const w=world();let ended=false,roles=['radiologist'],institution='hospital';
  const auth={ sessionId:()=> 'cookie',sessionRef:()=> 'bound',binding:req=>req.headers['x-kin-session']?'present':'missing',
    requireBinding(req){ if(req.headers['x-kin-session']!=='bound')throw new HttpException({code:req.headers['x-kin-session']?'AUTH_SESSION_MISMATCH':'AUTH_SESSION_REQUIRED'},req.headers['x-kin-session']?409:428); },
    authenticateSession:async()=>{if(ended)throw new HttpException({code:'AUTH_SESSION_ENDED'},401);return {sid:'cookie',accessToken:'token'};},
    verifyAccessToken:async()=>({sub:'A',iss:'synthetic',groups:['hospital'],realm_access:{roles}}),
    sessionRights:async()=>({approved:true,suspended:false,institution,roles,version:1}),bindCurrentAuthorization:()=>({}),
  };
  const guard=new AuthGuard(new Reflector(),auth,{capture(){}});
  async function call(binding) {
    const req={method:'GET',originalUrl:'/api/preload/cache-key',headers:{'x-kin-session':binding}},headers={};
    const res={setHeader:(name,value)=>headers[name]=value};
    try { await guard.canActivate(new ExecutionContextHost([req,res],PreloadKeyController,PreloadKeyController.prototype.read));return {body:await w.controller.read(req),headers}; }
    catch(error){return {status:error.getStatus(),headers};}
  }
  assert.equal((await call()).status,428);
  assert.equal((await call('wrong')).headers['X-KIN-Auth-Code'],'AUTH_SESSION_MISMATCH');
  ended=true;assert.equal((await call('bound')).headers['X-KIN-Auth-Code'],'AUTH_SESSION_ENDED');ended=false;
  roles=['clinician'];assert.equal((await call('bound')).status,403);
  roles=['radiologist'];institution=null;assert.equal((await call('bound')).status,403);
  assert.equal(w.rows.length,0);
  institution='hospital';assert.ok((await call('bound')).body.keyId);
});
