const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const next=vm.runInNewContext(source.slice(source.indexOf('function kinCineNext'),source.indexOf('function kinCreateCine'))+';kinCineNext');

function run(start,first,last,mode,loop,limit=20){
 const seen=[start];let index=start,direction=mode==='reverse'?-1:1,stopped=false;
 for(let i=0;i<limit;i++){
  const step=next(index,first,last,mode,direction,loop);direction=step.direction;
  if(step.stop){stopped=true;break;}index=step.next;seen.push(index);
 }
 return {seen,stopped};
}

test('bounded forward and reverse include the final endpoint before stopping',()=>{
 assert.deepEqual(run(2,2,5,'forward',false),{seen:[2,3,4,5],stopped:true});
 assert.deepEqual(run(5,2,5,'reverse',false),{seen:[5,4,3,2],stopped:true});
});

test('loop wraps inside the requested range',()=>{
 assert.deepEqual(run(2,2,5,'forward',true,5).seen,[2,3,4,5,2,3]);
 assert.deepEqual(run(5,2,5,'reverse',true,5).seen,[5,4,3,2,5,4]);
});

test('Yoyo visits each endpoint once per turn and non-loop stops after returning',()=>{
 assert.deepEqual(run(2,2,5,'yoyo',true,8).seen,[2,3,4,5,4,3,2,3,4]);
 assert.deepEqual(run(2,2,5,'yoyo',false),{seen:[2,3,4,5,4,3,2],stopped:true});
});

test('invalid internal range state fails closed',()=>{
 for(const args of [[0,0,0,'forward',true],[0,1,2,'forward',true],[0,0,2,'other',true],[0.5,0,2,'forward',true]])
  assert.throws(()=>next(...args),/invalid cine range state/);
});
