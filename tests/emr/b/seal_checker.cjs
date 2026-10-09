/* D860, pure bounded scheduler. Product TS is compiled without edits, DB transactions and
 * filesystem syscalls are adapters. No PostgreSQL, network, host fixture, product writes.
 * A/B each have start(intent), outcome(COMMIT), deliver(confirm/settle) cuts; E has
 * start(prepare/proof), outcome(delete+checkpoint transaction), deliver(job completion).
 * A crash/restart probe is made at EVERY reachable cut, including all three actors open.
 * Requirement assertions are about stored facts, receipts, progress, external seal only.
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cp = require('node:child_process'), assert = require('node:assert/strict');
const [inputRoot = path.resolve(__dirname, '../../..'), tsRoot = path.join(inputRoot, 'api/node_modules/typescript'), output, limitText] = process.argv.slice(2);
const revision = 'working-tree';
const root=path.resolve(inputRoot);
const ts = require(path.resolve(tsRoot)), clock = '2026-10-10T00:00:00.000Z', zero = '0'.repeat(64);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const source = new Map(), compiled = new Map(), sharedModules = new Map();
let genesisSealText;
const FixedDate = class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return Date.parse(clock); } };
function readSource(rel) {
  if (!source.has(rel)) source.set(rel, fs.readFileSync(path.join(root,rel),'utf8'));
  return source.get(rel);
}
function errno(code) { return Object.assign(new Error(code), {code}); }
// fsync is an atomic durable cut in this scheduler. Torn-write cases remain in the
// separately executed Opus J1-J5 corpus; this adapter does not claim POSIX durability.
class MemFS {
  constructor(snapshot) { this.serial=100; this.nodes = new Map(snapshot || []); this.fds = new Map(); this.fd=3; }
  key(p) { return path.resolve(p).toLowerCase(); }
  lstatSync(p, opt) { const n=this.nodes.get(this.key(p)); if(!n) { if(opt?.throwIfNoEntry===false)return; throw errno('ENOENT'); }
    return {isDirectory:()=>n.dir,isFile:()=>!n.dir,isSymbolicLink:()=>false,mode:n.dir?0o700:0o600,size:n.dir?0:Buffer.byteLength(n.data)}; }
  mkdirSync(p) { p=this.key(p); if(this.nodes.has(p))throw errno('EEXIST'); this.nodes.set(p,{dir:true}); }
  existsSync(p) { return this.nodes.has(this.key(p)); }
  realpathSync = Object.assign(p=>path.resolve(p), {native:p=>path.resolve(p)});
  openSync(p,flags) { p=this.key(p); if(flags.includes('x')&&this.nodes.has(p))throw errno('EEXIST');
    if(!this.nodes.has(p)&&!/[aw]/.test(flags))throw errno('ENOENT');
    if(!this.nodes.has(p)||flags.includes('w'))this.nodes.set(p,{dir:false,data:''});
    const id=this.fd++; this.fds.set(id,{p,flags}); return id; }
  writeSync(fd,data) { const h=this.fds.get(fd), s=Buffer.isBuffer(data)?data.toString('utf8'):String(data);
    const old=this.nodes.get(h.p); this.nodes.set(h.p,{dir:false,data:old.data+s}); return Buffer.byteLength(s); }
  writeFileSync(p,data) { if(typeof p==='number')return this.writeSync(p,data); this.nodes.set(this.key(p),{dir:false,data:Buffer.isBuffer(data)?data.toString('utf8'):String(data)}); }
  appendFileSync(p,data) { const fd=this.openSync(p,'a'); this.writeSync(fd,data); this.closeSync(fd); }
  fsyncSync() {} closeSync(fd) { this.fds.delete(fd); }
  readFileSync(p,enc) { const n=this.nodes.get(this.key(p)); if(!n||n.dir)throw errno('ENOENT'); return enc?n.data:Buffer.from(n.data); }
  renameSync(a,b) { a=this.key(a); b=this.key(b); const n=this.nodes.get(a); if(!n)throw errno('ENOENT');this.nodes.set(b,n);this.nodes.delete(a); }
  linkSync(a,b) { a=this.key(a);b=this.key(b);if(this.nodes.has(b))throw errno('EEXIST');this.nodes.set(b,this.nodes.get(a)); }
  rmSync(p,opt={}) { p=this.key(p);if(!this.nodes.has(p)&&!opt.force)throw errno('ENOENT');this.nodes.delete(p);if(opt.recursive)for(const k of this.nodes.keys())if(k.startsWith(p+path.sep))this.nodes.delete(k); }
  unlinkSync(p) { this.rmSync(p); }
  readdirSync(p) { p=this.key(p); return [...this.nodes.keys()].filter(k=>path.dirname(k)===p).map(k=>path.basename(k)).sort(); }
  ftruncateSync(fd,n) { const p=this.fds.get(fd).p;this.nodes.set(p,{dir:false,data:this.nodes.get(p).data.slice(0,n)}); }
  snapshot() { return [...this.nodes.entries()].sort(([a],[b])=>a.localeCompare(b)); }
}
// One compiled product module graph; AsyncLocalStorage gives each modeled process its own FS.
// This changes only the syscall adapter, preserves product objects/bytes, and avoids recompiling
// immutable class definitions at every crash cut. Actors in a world still share the same filesystem.
const fsScope=new (require('node:async_hooks').AsyncLocalStorage)();
let runtimeModules;
function modules(mem) {
  if(runtimeModules)return runtimeModules;
  const cache=new Map(),writes=new Set(['mkdirSync','openSync','writeSync','writeFileSync','appendFileSync','fsyncSync','renameSync','linkSync','rmSync','unlinkSync','ftruncateSync']);
  const fsapi={};
  for(const name of Object.getOwnPropertyNames(MemFS.prototype))if(name!=='constructor'&&typeof MemFS.prototype[name]==='function')fsapi[name]=(...args)=>{
    const mem=fsScope.getStore();assert(mem,'filesystem syscall outside a modeled process');const v=mem[name](...args);
    if(writes.has(name)&&mem.onMutation)mem.onMutation(name);return v;
  };
  fsapi.realpathSync=Object.assign(p=>path.resolve(p),{native:p=>path.resolve(p)});
  function load(rel){
    rel=path.posix.normalize(rel);if(!rel.endsWith('.ts'))rel+='.ts';if(cache.has(rel))return cache.get(rel).exports;
    if(!compiled.has(rel))compiled.set(rel,new Function('exports','require','module','__filename','__dirname','Date','process',
      ts.transpileModule(readSource(rel),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,esModuleInterop:true}}).outputText));
    const m={exports:{}};cache.set(rel,m);
    const req=id=>id==='node:fs'?fsapi:id==='node:crypto'?{...crypto,randomUUID:()=>('00000000-0000-4000-8000-'+String(++fsScope.getStore().serial).padStart(12,'0'))}:id.startsWith('.')?load(path.posix.join(path.posix.dirname(rel),id)):require(id);
    compiled.get(rel)(m.exports,req,m,path.join(root,rel),path.join(root,path.posix.dirname(rel)),FixedDate,process);return m.exports;
  }
  runtimeModules={C:load('api/src/emr-runtime/contract'),J:load('api/src/emr-runtime/failure-journal'),S:load('api/src/emr-runtime/seal'),
    CO:load('api/src/emr-runtime/coordinator'),EW:load('api/src/emr-runtime/external-writer'),RT:load('api/src/emr-runtime/store')};
  return runtimeModules;
}
const eventId=n=>'00000000-0000-4000-8000-'+({seed:10,A:11,B:12,P:13}[n]).toString().padStart(12,'0');
function event(id, at='2020-01-02T00:00:00.000Z') {
  const known=value=>({status:'known',value}), who={id:'00000000-0000-4000-8000-000000000001',issuer:'https://identity.example.test',subject:'synthetic'};
  return {formatVersion:2,branch:'online-auth',surface:'GET auth/callback',eventId:eventId(id),userId:known(who),rolesAtTime:known(['radiologist']),rightsVersion:known(1),
    actingInstitution:known('synthetic'),managingInstitution:known('synthetic'),occurredAt:at,trustedProxyIp:known({address:'192.0.2.1',source:'trusted-proxy'}),cause:'user-view',
    context:{basis:'authentication',studyId:null,relatedStudyId:null,reason:null},executor:'member',affectedIdentity:known(who),session:known('authref:00000000-0000-4000-8000-000000000002'),
    targets:[],action:'auth.login',result:'succeeded',auth:{endCause:null,failureCause:null,trigger:null},requestId:'synthetic-request',auditLinkId:'audit:00000000-0000-4000-8000-000000000003',relatedEventId:null};
}
const drain=async()=>{for(let i=0;i<90;i++)await Promise.resolve();};
const clone=v=>JSON.parse(JSON.stringify(v));
function create(snapshot, eligible=true, recoveryProcess=false) {
  const w={epoch:recoveryProcess?1:0,dir:path.join(root,'VIRTUAL_ONLY'),mem:new MemFS(snapshot?.files),rows:clone(snapshot?.rows||[]),truth:clone(snapshot?.truth||[]),
    markers:clone(snapshot?.markers||[]), head:clone(snapshot?.head||{chainId:'view-chain',sequence:0,hash:zero}), actors:{}, eligible,unreadable:false};
  if(!snapshot)w.mem.mkdirSync(w.dir);
  Object.assign(w,modules(w.mem));
  const rawMarker=m=>m&&({stream:m.stream,chain_id:m.chainId,attempt_id:m.attemptId,bundle_id:m.bundleId,kind:m.kind,event_id:m.eventId,
    sequence:m.sequence,previous_hash:m.previousHash,hash:m.hash,content_sha256:m.contentSha256,generation:m.generation,proof_digest:m.proofDigest});
  const rawEntry=e=>({...e,previous_hash:e.previousHash,content_sha256:e.contentSha256,event_id:e.eventId,stored_at:e.storedAt,statutory_act:e.statutoryAct});
  w.readSql=async(strings,...v)=>{
    if(w.unreadable)throw errno('P1001');
    const text=strings.join('?');
    if(/enter_writer|fence_writers|lock_chain/.test(text))return [];
    if(text.includes('chain_tail'))return [{chain_id:v[0]==='viewing'?w.head.chainId:'history-chain',sequence:v[0]==='viewing'?w.head.sequence:0,hash:v[0]==='viewing'?w.head.hash:zero}];
    if(text.includes('entries_after'))return v[0]==='viewing'?w.rows.filter(e=>e.sequence>v[1]).slice(0,v[2]).map(rawEntry):[];
    if(text.includes('entry_for_event'))return w.rows.filter(e=>e.eventId===v[1]).map(rawEntry);
    if(text.includes('commit_marker_for_slot'))return w.markers.filter(m=>m.stream===v[0]&&m.sequence===v[1]).map(rawMarker);
    if(text.includes('commit_marker_for_attempt'))return w.markers.filter(m=>m.stream===v[0]&&m.attemptId===v[1]).map(rawMarker);
    if(text.includes('retention_view'))return w.retentionRows().filter(e=>e.sequence>v[0]);
    throw new Error('Unknown read SQL '+text);
  };
  w.sql=new w.RT.PrismaLedgerSql({$queryRaw:w.readSql},true);
  w.sql.withWriterFence=async work=>work(w.sql); // crash discards every open tx before this call
  w.coordinator=fsScope.run(w.mem,()=>new w.CO.StateCoordinator(w.dir,request=>fsScope.run(w.mem,()=>w.EW.executeExternal(request))));
  w.journal=new w.J.FailureJournal(w.dir,w.coordinator);w.seal=new w.S.AccessSeal(w.dir,w.sql,w.journal);w.store=new w.RT.AccessLedgerStore(null,w.sql,w.seal,w.journal);
  w.snapshot=()=>({files:w.mem.snapshot(),rows:w.rows,markers:w.markers,head:w.head,truth:w.truth});
  w.cutSnapshots=[];w.captureCuts=false;const localCuts=new Set();
  w.mem.onMutation=operation=>{if(w.captureCuts){
    counts.filesystem_cuts_observed++;
    const state=w.snapshot();state.files=state.files.filter(([p])=>!path.basename(p).startsWith('.tmp-'));
    const k=sha(JSON.stringify(state));
    if(!cutSeen.has(k)&&!localCuts.has(k)){localCuts.add(k);w.cutSnapshots.push({operation,state:clone(state),key:k});}
  }};
  w.newRow=(id,text,kind='access')=>({sequence:w.head.sequence+1,previousHash:w.head.hash,hash:w.C.entryHash(w.head.sequence+1,w.head.hash,text),kind,
    statutoryAct:kind==='expiry'?null:'none',eventId:id,payload:text,contentSha256:sha(text),storedAt:clock});
  w.install=(rows,row,marker)=>{w.rows=rows;w.head={...w.head,sequence:row.sequence,hash:row.hash};w.truth.push(clone(row));
    w.markers=w.markers.filter(m=>rows.some(e=>e.sequence===m.sequence));w.markers.push(clone(marker));};
  w.seed=async()=>{
    await w.seal.recoverAtStart();genesisSealText=w.mem.readFileSync(path.join(w.dir,'seal','tail.json'),'utf8');
    await w.start('seed');await w.commit('seed','ok');await w.deliver('seed');assert(!w.actors.seed.error);delete w.actors.seed;
  };
  w.retentionRows=()=>w.rows.map(e=>({sequence:e.sequence,hash:e.hash,kind:e.kind,occurred_at:e.kind==='expiry'?JSON.parse(e.payload).at:JSON.parse(e.payload).event.occurredAt,held:false}));
  w.start=async name=>{
    // A fresh process never reuses a crashed actor's random attempt UUID. Keep IDs deterministic
    // within one epoch so equivalent schedules still converge to the same durable state.
    w.mem.serial=w.epoch*100000+{seed:100,A:200,B:300,E:400,P:500}[name];
    const a=w.actors[name]={phase:'starting',name};
    const tx={$queryRaw:async(strings,...values)=>{
      const text=strings.join('?');
      if(text.includes('append_reserved')||text.includes('lock_chain'))return new Promise((resolve,reject)=>{a.query={text,values,resolve,reject};a.phase='prepared';});
      if(text.includes('expire_reserved')) {
        const through=Number(values[0]),deleted=w.rows.filter(e=>e.sequence<=through),last=deleted.at(-1);
        if(!last)throw errno('EB006');
        const p=w.C.checkpointPayload(clock,through,deleted.length,last.hash),r=w.newRow(null,p,'expiry');
        a.staged={rows:[...w.rows.filter(e=>e.sequence>through),r],row:r};a.ids={attemptId:values[1],bundleId:values[2]};
        return [{deleted_count:deleted.length,checkpoint_sequence:r.sequence,checkpoint_hash:r.hash,chain_id:w.head.chainId,previous_hash:r.previousHash,content_sha256:r.contentSha256}];
      }
      if(text.includes('bind_commit')) {
        if(w.failBinding)throw errno('EB005');
        const m=a.staged.row, stream=name==='E'?'viewing':values[0], offset=name==='E'?0:1;
        a.marker={stream,chainId:w.head.chainId,attemptId:values[offset],bundleId:a.ids.bundleId,kind:m.kind,eventId:m.eventId,
          sequence:m.sequence,previousHash:m.previousHash,hash:m.hash,contentSha256:m.contentSha256,generation:Number(values[offset+1]),proofDigest:values[offset+2]};
        return [];
      }
      return w.readSql(strings,...values);
    }};
    const db={$queryRaw:w.readSql,$transaction:fn=>new Promise((resolve,reject)=>{
      a.delivery={resolve,reject};Promise.resolve().then(()=>fn(tx)).then(v=>{a.callback={value:v};},e=>{a.callback={error:e};});})};
    const operation=fsScope.run(w.mem,()=>name==='E'?w.RT.expireAccessPrefix(db,w.seal,eligible?'2035-01-01T00:00:00.000Z':clock):new w.RT.AccessLedgerStore(db,w.sql,w.seal,w.journal).append(event(name,name==='seed'&&!eligible?clock:undefined)));
    operation.then(v=>{a.phase='done';a.value=v;},e=>{a.phase='done';a.error={code:e.code||e.name,detail:e.detail||e.message};});await drain();
  };
  w.commit=async(name,outcome)=>{
    const a=w.actors[name];assert.equal(a.phase,'prepared');a.outcome=outcome;
    if(outcome==='failed')a.query.reject(errno('EB006'));
    else if(name==='E')a.query.resolve([]);
    else {
      const p=w.C.canonicalPayload(event(name,name==='seed'&&!eligible?clock:undefined)),r=w.newRow(eventId(name),p.text);a.staged={rows:[...w.rows,r],row:r};
      a.ids={attemptId:a.query.values[4],bundleId:a.query.values[5]};
      a.query.resolve([{chain_id:w.head.chainId,sequence:r.sequence,previous_hash:r.previousHash,hash:r.hash,stored_at:clock,replay:false}]);
    }
    await drain();assert(a.callback,'transaction callback must finish');
    if(!a.callback.error&&['ok','unknown1'].includes(outcome)){w.install(a.staged.rows,a.staged.row,a.marker);a.committed=true;}
    a.phase='committed';
  };
  w.deliver=async name=>{const a=w.actors[name];assert.equal(a.phase,'committed');
    w.unreadable=a.outcome.startsWith('unknown');
    if(a.callback.error)a.delivery.reject(a.callback.error);else if(a.outcome==='ok')a.delivery.resolve(a.callback.value);else a.delivery.reject(errno('P1017'));
    await drain();w.unreadable=false;assert.equal(a.phase,'done');};
  return w;
}
const violations={}, witnesses={}, counts={states:0,edges:0,terminal_states:0,restart_probes:0,invariant_checks:0,completed_outcomes:{},duplicate_states:0,attack_checks:0,attack_base_blocked:0,filesystem_cuts_observed:0,filesystem_crash_states:0};
const attacked=new Set(),cutSeen=new Set(),restarted=new Set(),attackCounts={};
function finding(id,trace,detail){violations[id]=(violations[id]||0)+1;if(!witnesses[id])witnesses[id]={trace,detail};}
function classify(w,trace) {
  const seal=w.seal.read().streams.viewing, expected=seal.sequence?w.truth.find(e=>e.sequence===seal.sequence):{hash:zero};
  counts.invariant_checks++;
  if(!expected||expected.hash!==seal.hash)finding('I1',trace,{seal,expected});
  for(const [name,a] of Object.entries(w.actors)){
    if(a.phase==='done'&&a.value&&name!=='E'&&!a.committed)finding('I1-receipt',trace,a);
    if(a.phase==='done'&&a.committed&&a.outcome==='ok'&&a.error&&name!=='E')finding('I3',trace,{actor:name,error:a.error});
    if(a.phase==='done'&&name==='E'&&a.value&&seal.sequence<a.value.checkpointSequence)finding('I4',trace,{seal,result:a.value});
  }
  const falseNotFound=w.journal.all().find(r=>r.kind==='commit-not-found'&&Object.entries(w.actors).some(([n,a])=>n!=='E'&&eventId(n)===r.body.eventId&&a.phase!=='done'));
  if(falseNotFound)finding('X-RACE',trace,falseNotFound);
}
async function restartProbe(w,trace){
  const snap=w.snapshot(), k=sha(JSON.stringify(snap));if(restarted.has(k))return;restarted.add(k);
  counts.restart_probes++;const r=create(snap,w.eligible,true);
  try {await r.seal.recoverAtStart();}
  catch(e){finding('I2-restart',trace,{code:e.code,detail:e.detail});return;}
  const pending=Object.keys(r.coordinator.call('read').intents);
  if(pending.length)finding('I2-intents',trace,pending);
  // The suffix tests a product append and a later product expiry after recovery.
  await r.start('P');await r.commit('P','ok');await r.deliver('P');
  if(r.actors.P.error){finding('I2-next-append',trace,r.actors.P.error);return;}
  await r.start('E');if(r.actors.E.phase==='prepared'){await r.commit('E','ok');await r.deliver('E');}
  if(r.actors.E.error)finding('I2-next-expiry',trace,r.actors.E.error);
}
async function attackProbe(w,trace){
  const key=sha(JSON.stringify(w.snapshot()));if(attacked.has(key))return;attacked.add(key);
  const base=create(w.snapshot(),w.eligible);try{await base.seal.recoverAtStart();}catch{counts.attack_base_blocked++;return;}
  // Use a baseline which actually starts: an unrelated liveness refusal must not kill a tamper mutant.
  const snap=clone(base.snapshot());
  const attacks={
    'delete-sealed-tail':r=>{const last=r.rows.pop();r.head={...r.head,sequence:last.sequence-1,hash:last.previousHash};},
    'rewrite-sealed-row':r=>{const row=r.rows.at(-1);row.payload=row.payload.replace(/202[016]/,'2019');row.contentSha256=sha(row.payload);row.hash=r.C.entryHash(row.sequence,row.previousHash,row.payload);r.head.hash=row.hash;},
    'replayed-genesis-seal':r=>r.mem.writeFileSync(path.join(r.dir,'seal','tail.json'),genesisSealText),
    'prefix-without-proof':r=>{const anchor=r.rows[0],payload=r.C.checkpointPayload(clock,anchor.sequence,1,anchor.hash),row=r.newRow(null,payload,'expiry');r.rows=[...r.rows.slice(1),row];r.head={...r.head,sequence:row.sequence,hash:row.hash};},
    'forged-anchor-checkpoint':r=>{const a=r.head.sequence+1,h='b'.repeat(64),payload=r.C.checkpointPayload(clock,a,a,h),row={sequence:a+1,previousHash:h,hash:r.C.entryHash(a+1,h,payload),kind:'expiry',statutoryAct:null,eventId:null,payload,contentSha256:sha(payload),storedAt:clock};r.rows=[row];r.head={...r.head,sequence:row.sequence,hash:row.hash};},
  };
  if(snap.rows.length>=2)attacks['reorder-rows']=r=>{[r.rows[0],r.rows[1]]=[r.rows[1],r.rows[0]];};
  for(const [name,mutate]of Object.entries(attacks)){const r=create(snap,w.eligible);mutate(r);counts.attack_checks++;attackCounts[name]=(attackCounts[name]||0)+1;
    try{await r.seal.recoverAtStart();finding('I1-'+name,trace,{accepted:true});}catch(e){if(!['SealMissing','SealCorrupt','SealChainMismatch','LedgerBehindSeal','SealTailMismatch','LedgerChainBroken','UnsealedEntryUnexplained'].includes(e.code))throw e;}}
}
async function filesystemCuts(w,trace){
  for(const [index,cut]of w.cutSnapshots.entries()){
    // Product recovery deliberately ignores .tmp-* files. Quotient only that
    // unobservable namespace; retain published proof/intent/journal/seal bytes.
    const normalized={...cut.state,files:cut.state.files.filter(([p])=>!path.basename(p).startsWith('.tmp-'))};
    const key=cut.key||sha(JSON.stringify(normalized));if(cutSeen.has(key))continue;cutSeen.add(key);counts.filesystem_crash_states++;
    const r=create(cut.state,w.eligible),where=[...trace,`crash-after-${cut.operation}-${index}`];
    await restartProbe(r,where);await attackProbe(r,where);
  }
}
const outcomes=['ok','failed','unknown0','unknown1'];
function options(w){const result=[];for(const name of ['A','B','E']){const a=w.actors[name];if(!a)result.push(`${name}:start`);
  else if(a.phase==='prepared')for(const o of outcomes)result.push(`${name}:commit:${o}`);else if(a.phase==='committed')result.push(`${name}:deliver`);}return result;}
async function act(w,s){const [n,a,o]=s.split(':');if(a==='start')await w.start(n);else if(a==='commit')await w.commit(n,o);else await w.deliver(n);}
function stateKey(w){return sha(JSON.stringify({snapshot:w.snapshot(),actors:Object.fromEntries(Object.entries(w.actors).sort().map(([n,a])=>[n,{phase:a.phase,outcome:a.outcome,committed:a.committed,
  staged:a.staged,callback:a.callback&&{value:a.callback.value,error:a.callback.error?.code},value:a.value,error:a.error}]))}));}
async function enumerate(eligible){
  const initial=create(undefined,eligible);await initial.seed();const seed=clone(initial.snapshot());const seen=new Map();let stopped=false;
  async function visit(trace){const w=create(seed,eligible);for(let i=0;i<trace.length;i++){w.captureCuts=i===trace.length-1;await act(w,trace[i]);}await filesystemCuts(w,trace);const k=stateKey(w);
    if(seen.has(k)){counts.duplicate_states++;return seen.get(k);}seen.set(k,null);counts.states++;classify(w,trace);await restartProbe(w,trace);await attackProbe(w,trace);
    if(counts.states%1000===0)console.log(JSON.stringify({progress:{states:counts.states,edges:counts.edges,attack_checks:counts.attack_checks}}));
    const next=options(w);if(!next.length){counts.terminal_states++;for(const [n,a]of Object.entries(w.actors)){const k=n+':'+a.outcome;counts.completed_outcomes[k]=(counts.completed_outcomes[k]||0)+1;}}
    const paths={terminal:next.length?0:1,restart:1};
    if(limitText&&counts.states>=Number(limitText)){stopped=true;return paths;}
    for(const s of next){counts.edges++;const child=await visit([...trace,s]);paths.terminal+=child.terminal;paths.restart+=child.restart;if(stopped)return paths;}
    seen.set(k,paths);return paths;
  }
  const paths=await visit([]);return {eligible,unique_states:seen.size,complete:!stopped,terminal_interleavings:paths.terminal,crash_restart_interleavings:paths.restart};
}
async function named(){
  async function run(id,steps,probe){const w=create();await w.seed();for(const s of steps)await act(w,s);const d=await probe(w);console.log(JSON.stringify({case:id,...d}));return d;}
  const result={};
  await run('I4-own-checkpoint',['E:start','E:commit:ok','E:deliver'],async w=>{classify(w,['E:COMMIT','E:success']);return {sealed:w.seal.read().streams.viewing.sequence};});
  await run('delayed-receipt-across-other-start',['A:start','A:commit:ok','E:start','E:commit:ok','E:deliver'],async w=>{
    await w.seal.recoverAtStart();await w.deliver('A');
    if(w.actors.A.error)finding('I3',['A:COMMIT','E:expiry','other-process:start','A:response'],w.actors.A.error);
    return {receipt:!w.actors.A.error};
  });
  result['RACE-1']=await run('RACE-1',['E:start','E:commit:ok','E:deliver','A:start','B:start','A:commit:ok','A:deliver'],async w=>({found:!!w.actors.A.error,error:w.actors.A.error||null}));
  result['RACE-2']=await run('RACE-2',['A:start','A:commit:unknown0','A:deliver','E:start','E:commit:ok','E:deliver','B:start','B:commit:ok','B:deliver'],async w=>{
    let restart;try{await create(w.snapshot()).seal.recoverAtStart();restart='ok';}catch(e){restart=e.code+':'+e.detail;}
    const retry=create(w.snapshot(),true,true);await retry.start('E');return{found:!!w.actors.B.error&&restart!=='ok',append:w.actors.B.error,restart,nextExpiry:retry.actors.E.error||null};});
  result['RACE-3']=await run('RACE-3',['E:start','E:commit:ok','E:deliver','A:start','B:start'],async w=>{try{await create(w.snapshot()).seal.recoverAtStart();return{found:false};}catch(e){return{found:true,error:e.code+':'+e.detail};}});
  const w=create(undefined,false);await w.seed();await w.start('A');await w.start('B');await w.start('E');await w.commit('A','ok');await w.deliver('A');
  result['X-RACE']={found:!!w.actors.A.error&&w.journal.all().some(r=>r.kind==='commit-not-found'),error:w.actors.A.error||null};console.log(JSON.stringify({case:'X-RACE',...result['X-RACE']}));
  // X-STALE: the aborted E proof is replayed after A has reserved and committed the SAME slot.
  // The healthy sibling must recover first; an unrelated startup refusal is never a tamper kill.
  {
    const w=create();await w.seed();await w.start('E');await w.commit('E','unknown0');await w.deliver('E');
    const prior=clone(w.coordinator.call('read').proofs), staged=clone(w.actors.E.staged), marker=clone(w.actors.E.marker);
    await w.start('A');await w.commit('A','ok');
    let healthy=true;try{await create(w.snapshot()).seal.recoverAtStart();}catch(e){if(e.code!=='UnsealedEntryUnexplained')throw e;healthy=false;finding('I2',['X-STALE-healthy-sibling'],{code:e.code});}
    if(healthy){
    w.rows=staged.rows;w.head={...w.head,sequence:staged.row.sequence,hash:staged.row.hash};
    w.markers=w.markers.filter(m=>m.sequence<marker.sequence).concat(marker);
    const state=w.coordinator.call('read'),before=state.revision++;Object.assign(state.proofs,prior);w.coordinator.call('compare-and-set',{before,state});
    try{await w.seal.recoverAtStart();finding('I1-stale-proof',['E:unknown0','A:COMMIT','replay:E-checkpoint-and-proof'],{accepted:true});}
    catch(e){if(!['UnsealedEntryUnexplained','SealTailMismatch'].includes(e.code))throw e;}
    }
  }
  {
    const w=create();await w.seed();w.failBinding=true;
    await w.start('E');await w.commit('E','ok');await w.deliver('E');
    assert(w.actors.E.error,'binding failure must roll back deletion');
    const external=w.coordinator.call('read');
    if(Object.keys(external.proofs).length||!Object.values(external.terminal).some(t=>t.phase==='aborted'))
      finding('rollback-terminal',['E:prepared-proof','binding-failure','rollback'],{proofs:Object.keys(external.proofs),terminal:external.terminal});
    assert.equal(w.rows.length,1);assert.equal(w.rows[0].kind,'access');
  }
  for(const attack of ['marker-delete','marker-forge','marker-generation','chain-id','row-order','same-slot-content']){
    const w=create();await w.seed();await w.start('A');await w.commit('A','ok');
    try{await create(w.snapshot()).seal.recoverAtStart();}catch(e){if(e.code!=='UnsealedEntryUnexplained')throw e;finding('I2',[attack+'-healthy-sibling'],{code:e.code});continue;}
    if(attack==='marker-delete')w.markers.pop();
    if(attack==='marker-forge')w.markers.at(-1).attemptId='forged-attempt';
    if(attack==='marker-generation')w.markers.at(-1).generation--;
    if(attack==='chain-id')w.head.chainId='replaced-chain';
    if(attack==='row-order')w.rows.reverse();
    if(attack==='same-slot-content'){const r=w.rows.at(-1);r.payload=r.payload.replace('2020','2021');r.contentSha256=sha(r.payload);r.hash=w.C.entryHash(r.sequence,r.previousHash,r.payload);w.head.hash=r.hash;}
    const before=JSON.stringify({rows:w.rows,markers:w.markers});
    try{await w.seal.recoverAtStart();finding('I1-'+attack,['A:COMMIT',attack],{accepted:true});}
    catch(e){if(!['UnsealedEntryUnexplained','LedgerChainBroken','SealChainMismatch','SealTailMismatch'].includes(e.code))throw e;}
    assert.equal(JSON.stringify({rows:w.rows,markers:w.markers}),before,'attack refusal preserves raw DB facts');
  }
  if(result['RACE-1'].found)finding('I3',['E:COMMIT','A:COMMIT','B:open'],result['RACE-1']);
  if(result['RACE-2'].restart!=='ok'||result['RACE-3'].found)finding('I2',['unknown0/E/open/start'],result);
  if(result['X-RACE'].found)finding('X-RACE',['unexpired-E/open-A'],result['X-RACE']);
  return result;
}
(async()=>{const begin=performance.now();const namedResults=await named();const spaces=[];
  if(limitText!=='named'){spaces.push(await enumerate(true));if(!limitText||counts.states<Number(limitText))spaces.push(await enumerate(false));}
  const summary={revision,source:Object.fromEntries([...source].map(([p,s])=>[p,sha(s)])),...counts,spaces,attackCounts,violations,witnesses,named:namedResults,
    runtime_s:Number(((performance.now()-begin)/1000).toFixed(3)),bounded_exhaustive:spaces.length===2&&spaces.every(s=>s.complete)};
  if(output)fs.writeFileSync(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify({summary:{...counts,spaces,violations,runtime_s:summary.runtime_s,bounded_exhaustive:summary.bounded_exhaustive}}));
  process.exitCode=Object.keys(violations).length?1:summary.bounded_exhaustive||limitText==='named'?0:3;
})().catch(e=>{console.error(e.stack);process.exitCode=2;});
