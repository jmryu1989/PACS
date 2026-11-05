/* REQ-B2R-02 -> pool starvation -> TX-01/02; a failure no admitted operation accounts for -> TX-03.
 * B2-COMMIT: every B2 transaction is followed by a bounded commit judgement (tests/emr/b/commit_judgement_test.cjs).
 * Observe transaction options at the Prisma boundary; source shape and the
 * location of an options literal do not determine the product contract. */
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'../../..'),ts=require(path.join(root,'api/node_modules/typescript'));
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:f}).outputText,f);
const {AccessLedgerStore}=require(path.join(root,'api/src/emr-runtime/store.ts'));
const {createRecordPort}=require(path.join(root,'api/src/emr-runtime/record-port.ts'));
const limits=require(path.join(root,'api/src/emr-runtime/limits.ts'));
const {PgTxDouble}=require('./pg_tx_double.cjs');
function boundary(){
  const db=new PgTxDouble();
  const store=new AccessLedgerStore(db,{record:async()=>assert.fail('No failed business operation')});
  // A transaction that took its own XID is a business transaction; one that read a status is B2's commit judgement.
  const begun=held=>db.log.filter(e=>e.kind==='begin'&&db.log.some(s=>s.tx===e.tx&&held(s))).map(e=>e.options);
  return {db,business:()=>begun(s=>s.kind==='commit'&&s.xid!==null),judged:()=>begun(s=>s.kind==='status'),...createRecordPort(store)};
}
const bounded=options=>Number.isFinite(options?.maxWait)&&Number.isFinite(options?.timeout);
test('TX-01 identity resolution and default producer transactions retain both configured limits; each judgement is bounded',async()=>{
  const b=boundary(),w=b.port.begin();
  try{
    assert.equal(typeof await w.resolveRequestIdentity('synthetic-issuer','subject'),'string');
    assert.equal(await w.transactionWithRecords(async()=>17),17);
    assert.deepEqual(b.business(),[0,1].map(()=>({maxWait:limits.EMR_TX_MAX_WAIT_MS,timeout:limits.EMR_TX_TIMEOUT_MS})));
    assert.equal(b.judged().length,2,'each of the two commits was judged');
    assert.ok(b.judged().every(bounded),'a judgement read never waits without a bound');
  }finally{w.end();b.control.close();await b.control.drained();}
});
test('TX-02 a producer preserves its existing explicit business transaction limits',async()=>{
  const b=boundary(),w=b.port.begin(),options={maxWait:4000,timeout:120000}; // initial-import producer's existing limits
  try{await w.transactionWithRecords(async()=>null,options);assert.deepEqual(b.business(),[options]);assert.ok(b.judged().every(bounded));}
  finally{w.end();b.control.close();await b.control.drained();}
});
test('TX-03 a failure no admitted operation accounts for is journaled against the event the transaction writes for',async()=>{
  const event='22222222-2222-4222-8222-222222222222';
  const tx={$executeRaw:async()=>0,$queryRaw:async()=>[]};
  for(const [name,$transaction,work,cause] of [
    ['no connection',async()=>{throw Object.assign(new Error('Timed out fetching a new connection'),{code:'P2024'});},async()=>0,'ledger-unreachable'],
    ['the callback\'s own SQL',async body=>body(tx),async()=>{throw new Error('SyntheticInsertRefused');},'business-rollback'],
    ['a lost COMMIT',async body=>{await body(tx);throw new Error('SyntheticCommitLost');},async()=>0,'commit-unknown'],
  ]){
    for(const failureEvent of [event,undefined]){
      const journal=[],store=new AccessLedgerStore({$transaction},{record:async(...entry)=>{journal.push(entry);return 'database';}});
      const {port,control}=createRecordPort(store),w=port.begin();
      try{await assert.rejects(w.transactionWithRecords(work,undefined,failureEvent));}
      finally{w.end();control.close();await control.drained();}
      assert.deepEqual(journal,failureEvent?[[cause,event,null]]:[],name);
    }
  }
});
