const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const budget=vm.runInNewContext(source.slice(source.indexOf('function kinCineWithinBudget'),source.indexOf('function kinCreateCine'))+';kinCineWithinBudget');
const frames=n=>Array.from({length:n},(_,i)=>`frame/${i+1}`);
const pixels=(n,rows=256,columns=256)=>Array.from({length:n},()=>({rows,columns}));
test('only bounded multi-image stacks prepare',()=>{
 for(const n of [0,1,501])assert.equal(budget(frames(n),pixels(n)),false);
 for(const n of [2,12,500])assert.equal(budget(frames(n),pixels(n)),true);
});
test('estimated RGBA pixel budget accepts its boundary and rejects larger frames',()=>{
 assert.equal(budget(frames(128),pixels(128,512,512)),true);
 assert.equal(budget(frames(129),pixels(129,512,512)),false);
 assert.equal(budget(frames(2),pixels(2,65536,65536)),false);
});
test('missing malformed and non-finite dimensions fail closed',()=>{
 for(const bad of [null,{}, {rows:NaN,columns:256},{rows:Infinity,columns:256},{rows:0,columns:256},{rows:-1,columns:256},{rows:1.5,columns:256},{rows:'256',columns:256}])assert.equal(budget(frames(2),[{rows:256,columns:256},bad]),false);
 assert.equal(budget(frames(2),pixels(1)),false);
});
test('source references and metadata remain unchanged',()=>{
 const ids=frames(12),p=pixels(12),before=JSON.stringify([ids,p]);assert.equal(budget(ids,p),true);assert.equal(JSON.stringify([ids,p]),before);
});
