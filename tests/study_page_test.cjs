const {test}=require('node:test');
const assert=require('node:assert/strict');
const {studyPageQuery:query,studyPageSlice:slice}=require('/app/dist/study-page');
const owner=['hallym','subject','reader'];
const uid=x=>x.uid;
test('signed pages cover sorted unique snapshot, bind owner/size, reject changes and expiry',()=>{
 const rows=[{uid:'3'},{uid:'1'},{uid:'2'}];
 const first=slice(rows,uid,query({limit:'1'},owner),owner);
 assert.deepEqual(first.rows,[{uid:'1'}]);assert.equal(first.pagination.total,3);
 const cursor=first.pagination.next;
 const second=slice(rows,uid,query({limit:'1',after:cursor},owner),owner);assert.deepEqual(second.rows,[{uid:'2'}]);
 const last=slice(rows,uid,query({limit:'1',after:second.pagination.next},owner),owner);assert.deepEqual(last.rows,[{uid:'3'}]);assert.equal(last.pagination.next,null);
 assert.throws(()=>query({limit:'2',after:cursor},owner));
 for(const other of [['other','subject','reader'],['hallym','other','reader'],['hallym','subject','other']])assert.throws(()=>query({limit:'1',after:cursor},other));
 for(const token of [cursor+'!',cursor.slice(0,-3)+'abc','bad'])assert.throws(()=>query({limit:'1',after:token},owner));
 assert.throws(()=>slice([...rows,{uid:'4'}],uid,query({limit:'1',after:cursor},owner),owner));
 assert.throws(()=>slice(rows.slice(1),uid,query({limit:'1',after:cursor},owner),owner));
 const now=Date.now;try{Date.now=()=>now()+300001;assert.throws(()=>query({limit:'1',after:cursor},owner));}finally{Date.now=now;}
});
test('legacy unchanged and strict bounded page query',()=>{
 const rows=[{uid:'2'},{uid:'1'}];assert.deepEqual(slice(rows,uid,query({},owner),owner).rows,rows);
 for(const q of [{limit:'0'},{limit:'101'},{limit:['1']},{limit:1},{limit:'01'},{after:'x'},{limit:'1',extra:'x'}])assert.throws(()=>query(q,owner));
 assert.equal(slice([],uid,query({limit:'100'},owner),owner).pagination.total,0);
});
