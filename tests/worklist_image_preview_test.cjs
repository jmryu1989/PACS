const test=require('node:test'),assert=require('node:assert/strict');
const {inventory,frameAt,windowing}=require('../worklist-v0/hpacs-lite/worklist-image-preview');
const row=(sop,series,frames=1,number=1)=>Object.fromEntries(Object.entries({'0020000D':'2.25.1','0020000E':series,'00080018':sop,'00280010':32,'00280011':32,'00280008':frames,'00200013':number,'00280004':'MONOCHROME2'}).map(([k,v])=>[k,{Value:[v]}]));
test('series frames map exact SOP and zero-based frame without flattening or guessing',()=>{
  const groups=inventory([row('2.25.3','2.25.2',3,2),row('2.25.4','2.25.2',2,1)],'2.25.1');
  assert.equal(groups[0].total,5);assert.deepEqual([frameAt(groups[0],1).sop,frameAt(groups[0],1).frame],['2.25.4',1]);
  assert.deepEqual([frameAt(groups[0],2).sop,frameAt(groups[0],2).frame],['2.25.3',0]);assert.equal(frameAt(groups[0],5),null);
});
test('wrong study, duplicate SOP, invalid frame count and inventory budget fail closed',()=>{
  for(const records of [[row('2.25.3','2.25.2'),row('2.25.3','2.25.2')],[row('2.25.3','2.25.2',0)],[row('2.25.3','2.25.2',100001)]])assert.throws(()=>inventory(records,'2.25.1'));
  assert.throws(()=>inventory([row('2.25.3','2.25.2')],'2.25.9'));
  assert.equal(windowing('',40),null);assert.equal(windowing(0,40),null);assert.equal(windowing(Infinity,40),null);assert.deepEqual(windowing('400','-50'),{width:400,center:-50});
});
