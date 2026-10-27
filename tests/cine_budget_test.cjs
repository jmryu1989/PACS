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

test('native 8-bit XA and RGB US fit without Float32 inflation',()=>{
 const xa=pixels(2).map(p=>({...p,bitsAllocated:8,samplesPerPixel:1}));
 assert.equal(budget(frames(2),xa,2*256*256),true);
 const us=xa.map(p=>({...p,samplesPerPixel:3}));
 assert.equal(budget(frames(2),us,2*256*256*3),true);
 assert.equal(budget(frames(2),us,2*256*256*3-1),false);
});
test('cine may evict old frames but must fit the complete requested stack',()=>{
 const p=pixels(2).map(p=>({...p,bitsAllocated:8}));
 const full=2*256*256;
 assert.equal(budget(frames(2),p,full,[],bytes=>bytes<=full),true);
 assert.equal(budget(frames(2),p,full,[{sizeInBytes:256*256}],bytes=>bytes<full),false);
 assert.equal(budget(frames(2),p,0,[{sizeInBytes:256*256},{sizeInBytes:256*256}],bytes=>bytes<=full),true);
});

test('the displayed frame allocation accounts for decoder promotion',()=>{
 const p=pixels(2).map(p=>({...p,bitsAllocated:16,decodedBytesPerPixel:4}));
 assert.equal(budget(frames(2),p,2*256*256*2),false);
 assert.equal(budget(frames(2),p,2*256*256*4),true);
});
