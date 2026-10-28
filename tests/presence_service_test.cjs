'use strict';
// Exercise the real service with synthetic persistence and the existing access boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../api/node_modules/typescript');
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true, emitDecoratorMetadata: true }, fileName: file,
}).outputText, file);
const { PresenceService, PRESENCE_EXPIRES_MS } = require('../api/src/presence.service.ts');
function fixture() {
  const rows = [{uid:'1.2',institutionId:'A',teleInstitutionId:'B'}, {uid:'1.3',institutionId:'A',teleInstitutionId:null},
    {uid:'2.1',institutionId:'B',teleInstitutionId:null}];
  const sessions = new Map([['session-a','doctor'],['session-b','reader'],['session-c','other']]);
  const db = {studyState: {findMany: async ({where}) => rows.filter(r => where.uid.in.includes(r.uid))},
    authSession: {findUnique: async ({where}) => sessions.has(where.sid) ? {sub:sessions.get(where.sid)} : null,
      findMany: async ({where}) => where.sid.in.filter(sid => sessions.has(sid)).map(sid => ({sid}))}};
  const access = {allowed: async (c,uids) => new Set(uids.filter(uid => uid !== c.denied))};
  const svc = new PresenceService(db,access);
  const caller = (sub='doctor',institution='A',denied=null) => ({sub,actor:sub,roles:['radiologist'],institution,kind:'member',denied});
  const update = (id,seq,uids,c=caller(),sid='session-a') => svc.update(c,sid,'ref-'+sid,c.sub,{viewerId:id,sequence:seq,uids});
  return {svc,sessions,caller,update,read:(c=caller())=>svc.read(c,['1.2','1.3','2.1'])};
}
test('two doctors, two windows, switch, close, and same-name users preserve distinct viewing', async () => {
  const f=fixture();
  await f.update('tab',1,['1.2','1.3']);
  await f.update('other-tab',1,['1.2']);
  await f.update('reader-tab',1,['1.2'],f.caller('reader'),'session-b');
  let result=await f.read();
  assert.deepEqual(result.studies['1.2'].map(v=>v.name),['doctor','reader']);
  assert.equal(result.studies['1.3'].length,1);assert.equal('2.1' in result.studies,false);
  const since=result.studies['1.3'][0].since;
  await f.update('tab',2,['1.3']);await f.update('other-tab',2,[]);
  assert.deepEqual((await f.read()).studies['1.2'].map(v=>v.name),['reader']);
  await f.update('tab',3,['1.3']);assert.equal((await f.read()).studies['1.3'][0].since,since);
  await f.update('reader-tab',2,[],f.caller('reader'),'session-b');
  // A delayed heartbeat must not undo the close.
  await f.update('reader-tab',1,['1.2'],f.caller('reader'),'session-b');
  assert.deepEqual((await f.read()).studies['1.2'],[]);
});
test('same institution plus visible study plus individual StudyAccess all apply', async () => {
  const f=fixture();await f.update('a',1,['1.2']);
  const other=await f.read(f.caller('other','B'));
  assert.deepEqual(other.studies,{'1.2':[],'2.1':[]});
  assert.equal('1.2' in (await f.read(f.caller('reader','A','1.2'))).studies,false);
  await assert.rejects(f.update('bad',1,['2.1']),e=>e.getStatus()===404);
});
test('lost heartbeat expires, reconnect starts again, and session end cannot be undone',async t=>{
  const f=fixture();let now=100000;t.mock.method(Date,'now',()=>now);
  await f.update('a',1,['1.2']);now+=PRESENCE_EXPIRES_MS-1;
  assert.equal((await f.read()).studies['1.2'].length,1);now++;
  assert.deepEqual((await f.read()).studies['1.2'],[]);
  await f.update('a',2,['1.2']);assert.equal((await f.read()).studies['1.2'][0].since,new Date(now).toISOString());
  f.svc.endUser('doctor');assert.deepEqual((await f.read()).studies['1.2'],[]);
  f.sessions.delete('session-a');await assert.rejects(f.update('a',3,['1.2']),e=>e.getStatus()===401);
});
test('committed logout while an admitted heartbeat awaits access leaves no entry',async()=>{
  const f=fixture();const pending=f.update('a',1,['1.2']);f.svc.endUser('doctor');
  await assert.rejects(pending,e=>e.getStatus()===401);
  assert.deepEqual((await f.read()).studies['1.2'],[]);
});
