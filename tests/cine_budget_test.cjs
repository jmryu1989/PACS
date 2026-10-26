const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('config/ohif.js','utf8');
const budget=vm.runInNewContext(source.slice(source.indexOf('function kinCineWithinBudget'),source.indexOf('function kinCreateCine'))+';kinCineWithinBudget');
const frames=n=>Array.from({length:n},(_,i)=>`frame/${i+1}`);
const pixels=(n,rows=256,columns=256)=>Array.from({length:n},()=>({rows,columns}));
test('frame count does not limit a stack with sufficient measured memory',()=>{
 for(const n of [0,1])assert.equal(budget(frames(n),pixels(n),1024*1024*1024),false);
 for(const n of [2,12,500,501,2001])assert.equal(budget(frames(n),pixels(n),1024*1024*1024),true);
});
test('estimated RGBA pixel budget accepts its boundary and rejects larger frames',()=>{
 assert.equal(budget(frames(128),pixels(128,512,512),128*1024*1024),true);
 assert.equal(budget(frames(129),pixels(129,512,512),128*1024*1024),false);
 assert.equal(budget(frames(2),pixels(2,65536,65536),128*1024*1024),false);
});
test('missing malformed and non-finite dimensions fail closed',()=>{
 for(const bad of [null,{}, {rows:NaN,columns:256},{rows:Infinity,columns:256},{rows:0,columns:256},{rows:-1,columns:256},{rows:1.5,columns:256},{rows:'256',columns:256}])assert.equal(budget(frames(2),[{rows:256,columns:256},bad],1024*1024*1024),false);
 assert.equal(budget(frames(2),pixels(1),1024*1024*1024),false);
});
test('source references and metadata remain unchanged',()=>{
 const ids=frames(12),p=pixels(12),before=JSON.stringify([ids,p]);assert.equal(budget(ids,p,128*1024*1024),true);assert.equal(JSON.stringify([ids,p]),before);
});

test('cached frames need no second allocation and color samples count',()=>{
 assert.equal(budget(frames(2),pixels(2),0,[{},{}]),true);
 assert.equal(budget(frames(2),pixels(2).map(p=>({...p,samplesPerPixel:3})),2*256*256*4),false);
});
