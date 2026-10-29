/* REQ-B2R-02 -> pool starvation -> TX-01/02; a failure no admitted operation accounts for -> TX-03.
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
function boundary(){
  const calls=[];
  const db={$transaction:async(body,options)=>{calls.push(options);return body({$executeRaw:async()=>0,$queryRaw:async()=>[{id:'11111111-1111-4111-8111-111111111111'}]});}};
  const store=new AccessLedgerStore(db,{record:async()=>assert.fail('No failed business operation')});
  return {calls,...createRecordPort(store)};
}
test('TX-01 identity resolution and default producer transactions retain both configured limits',async()=>{
  const b=boundary(),w=b.port.begin();
  try{
    assert.equal(await w.resolveRequestIdentity('synthetic-issuer','subject'),'11111111-1111-4111-8111-111111111111');
    assert.equal(await w.transactionWithRecords(async()=>17),17);
    assert.deepEqual(b.calls,[0,1].map(()=>({maxWait:limits.EMR_TX_MAX_WAIT_MS,timeout:limits.EMR_TX_TIMEOUT_MS})));
  }finally{w.end();b.control.close();await b.control.drained();}
});
test('TX-02 a producer preserves its existing explicit business transaction limits',async()=>{
  const b=boundary(),w=b.port.begin(),options={maxWait:4000,timeout:120000}; // initial-import producer's existing limits
  try{await w.transactionWithRecords(async()=>null,options);assert.deepEqual(b.calls,[options]);}
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
