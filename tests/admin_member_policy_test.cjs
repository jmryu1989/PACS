'use strict';
// D73: REQ-S5-ROLE-COMPOSITION -> RISK-UNAUTHORISED-MEMBER-CHANGE -> public admin/KC contracts.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '..'), ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { AdminService } = require('../api/src/admin.service.ts');
const { KeycloakService } = require('../api/src/keycloak.service.ts');
(async () => {
  const member = { sub: 'synthetic-member', username: 'synthetic', email: 'synthetic@example.test', name: 'Synthetic',
    emailVerified: true, approved: true, suspended: false, institution: 'synthetic-hospital', roles: ['admin'], version: 1 };
  const caller = { sub: 'synthetic-admin', actor: 'synthetic-admin', roles: ['admin'] };
  let writes = 0, changed;
  const db = { memberRights: { findUnique: async () => member, updateMany: async ({data}) => { writes++; changed = data; return {count:1}; } },
    authSession: { findMany: async () => [], deleteMany: async () => ({count:0}) },
    auditLog: { create: async () => ({}), findFirst: async () => null }, providerChange: { create: async () => ({id:1}), findFirst: async () => null }, $executeRaw: async () => 0 };
  db.$transaction = async work => work(db);
  const kc = { institutions: async () => ['synthetic-hospital'], getUser: async () => ({id:member.sub,emailVerified:true}) };
  const service = new AdminService(db,kc,null,{publishCredentials() {}});
  const roles = ['radiologist','technician','admin','clinician'];
  for (const role of roles) {
    await service.patchUser(member.sub,{roles:[role]},caller);
    assert.deepEqual(changed.roles,[role]);
  }
  await service.patchUser(member.sub,{roles:['clinician','radiologist']},caller);
  assert.deepEqual(changed.roles,['clinician','radiologist']);
  for (const invalid of [[],['gateway'],['invented'],['clinician','invented']]) {
    const before=writes;
    await assert.rejects(service.patchUser(member.sub,{roles:invalid},caller),e=>e.getStatus()===400);
    assert.equal(writes,before,'invalid role never reaches a write');
  }
  await assert.rejects(service.patchUser(member.sub,{roles:['clinician']},{...caller,sub:member.sub}),e=>e.getStatus()===400);
  await assert.rejects(service.patchUser(member.sub,{enabled:false},{...caller,roles:['clinician']}),e=>e.getStatus()===403);
  for (const role of roles) {
    const provider = new KeycloakService(), sent=[];
    provider.adm=async (route,verb,data)=> {if(verb)sent.push({verb,data});return route.startsWith('/roles/')?{name:role}:[];};
    await provider.setRoles(member.sub,[role]);assert.deepEqual(sent,[{verb:'POST',data:[{name:role}]}]);
    await assert.rejects(provider.setRoles(member.sub,['gateway']),e=>e.getStatus()===503);
  }
  const provider=new KeycloakService(),sent=[];
  provider.adm=async(route,verb,data)=>{
    if(verb)sent.push({verb,data});
    if(route==='/roles/clinician')return {name:'clinician'};
    return [{name:'radiologist'},{name:'unmanaged-realm-role'}];
  };
  await provider.setRoles(member.sub,['clinician']);
  assert.deepEqual(sent,[{verb:'DELETE',data:[{name:'radiologist'}]},{verb:'POST',data:[{name:'clinician'}]}],
    'rights replacement preserves unrelated realm roles');
  const roster=new KeycloakService();
  roster.adm=async route=>route.startsWith('/groups?')?[{id:'group',name:'synthetic-hospital'}]:[{id:'reader'},{id:'clinician'}];
  roster.getUser=async id=>({id,enabled:true,groups:['synthetic-hospital'],roles:[id==='reader'?'radiologist':'clinician']});
  assert.deepEqual((await roster.assignmentReaders('synthetic-hospital')).map(u=>u.id),['reader'],
    'the unchanged roster still excludes a clinician-only reviewer');
  process.stdout.write('Member role contracts passed\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
