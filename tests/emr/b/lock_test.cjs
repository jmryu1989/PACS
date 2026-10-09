/* REQ-D878 persistent kernel ownership -> RISK-EMR-STALE-WRITER -> LOCK-01.
 * Runs in the disposable Linux image; real flock, independent processes, no DB. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const binding=require('/app/native/flock.node');
if(process.argv[2]==='child'){
  const fd=fs.openSync(process.argv[3],'a+',0o600);
  binding.flock(fd,true);process.stdout.write('locked\n');
  setInterval(()=>{},1000);
}else{
  (async()=>{
    assert.deepEqual(Object.keys(binding),['flock']);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'emr-lock-')),file=path.join(dir,'lock');
    const fd=fs.openSync(file,'a+',0o600);
    let child;
    try{
      child=spawn(process.execPath,[__filename,'child',file],{stdio:['ignore','pipe','inherit']});
      await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
      assert.equal(binding.flock(fd,true,true),false,'another live process owns the inode');
      const dead=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await dead;
      assert.equal(binding.flock(fd,true,true),true,'OS death releases ownership without a lease');
      binding.flock(fd,false);
      const samples=[];
      for(let i=0;i<1000;i++){const start=performance.now();assert.equal(binding.flock(fd,true),true);binding.flock(fd,false);samples.push((performance.now()-start)*1000);}
      samples.sort((a,b)=>a-b);
      assert.throws(()=>binding.flock(-1,true),{code:'SealUnavailable'});
      console.log(JSON.stringify({case:'LOCK-01',cycles:1000,processDeathReleased:true,flock_pair_us:{p50:samples[499],p95:samples[949],p99:samples[989]}}));
    }finally{if(child?.exitCode===null)child.kill('SIGKILL');fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true});}
  })().catch(e=>{console.error(e);process.exitCode=1;});
}
