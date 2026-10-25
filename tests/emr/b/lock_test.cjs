/* REQ-B2R-07 -> shutdown loses provider work -> LIFE-01/02.
 * The separate state-owner lock was removed by D1770. Exercise the actual
 * in-process work registry now used by AuthService and EmrRuntime. */
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'../../..'),ts=require(path.join(root,'api/node_modules/typescript'));
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},fileName:f}).outputText,f);
const {createBackgroundWorkRegistry}=require(path.join(root,'api/src/emr-runtime/background-work.ts'));
test('LIFE-01 shutdown cancels owned I/O, refuses new tasks and drains the already started work',async()=>{
  const control=createBackgroundWorkRegistry();let release,started=false,done=false;
  const held=new Promise(resolve=>release=resolve);
  const task=control.work.run('synthetic provider',async signal=>{started=true;await held;assert.equal(signal.aborted,true);});
  await Promise.resolve();assert.equal(started,true);control.quiesce();
  control.drained().then(()=>done=true);await Promise.resolve();assert.equal(done,false);
  assert.equal(control.work.tryRun('late publication',()=>assert.fail('late task started')),null);
  release();await task.settled;await control.drained();assert.equal(control.live(),0);assert.equal(done,true);
});
test('LIFE-02 scheduled retries stop at quiesce and a failed task still settles',async()=>{
  const c=createBackgroundWorkRegistry();
  c.work.schedule('retry',0,()=>assert.fail('quiesced retry started'));
  const failed=c.work.run('failed provider',async()=>{throw Error('provider unavailable');});
  c.quiesce();await failed.settled;await c.drained();assert.equal(c.live(),0);
});
