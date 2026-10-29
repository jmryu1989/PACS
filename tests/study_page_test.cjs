const {test}=require('node:test');
const assert=require('node:assert/strict');
const {studyPageQuery:query,studyPageSlice:slice}=require('/app/dist/study-page');
const owner=['hallym','subject','reader'];
const uid=x=>x.uid;
const changed=e=>e.getStatus()===409&&e.getResponse().code==='STUDY_LIST_CHANGED';
test('pages cover sorted unique snapshot, bind owner/size and membership, continue after elapsed time',()=>{
 const rows=[{uid:'3'},{uid:'1'},{uid:'2'}];
 const first=slice(rows,uid,query({limit:'1'},owner),owner);
 assert.deepEqual(first.rows,[{uid:'1'}]);assert.equal(first.pagination.total,3);
 const cursor=first.pagination.next;
 const second=slice(rows,uid,query({limit:'1',after:cursor},owner),owner);assert.deepEqual(second.rows,[{uid:'2'}]);
 const last=slice(rows,uid,query({limit:'1',after:second.pagination.next},owner),owner);assert.deepEqual(last.rows,[{uid:'3'}]);assert.equal(last.pagination.next,null);
 assert.throws(()=>query({limit:'2',after:cursor},owner));
 for(const other of [['other','subject','reader'],['hallym','other','reader'],['hallym','subject','other']])assert.throws(()=>query({limit:'1',after:cursor},other));
 for(const token of [cursor+'!','bad','',Buffer.from('null').toString('base64url')])assert.throws(()=>query({limit:'1',after:token},owner));
 // M11-a: an arrival before or after the cursor, a removed cursor row, and a same-size different set all refuse the
 // continuation; continuing would hand back a list missing the arrival with a total the client cannot tell from complete.
 for(const other of [[{uid:'0'},...rows],[...rows,{uid:'4'}],rows.filter(r=>r.uid!=='1'),[{uid:'0'},{uid:'1'},{uid:'3'}]])
  assert.throws(()=>slice(other,uid,query({limit:'1',after:cursor},owner),owner),changed);
 // Duplicate source rows and order do not change the set.
 assert.deepEqual(slice([...rows,{uid:'2'}].reverse(),uid,query({limit:'1',after:cursor},owner),owner).rows,[{uid:'2'}]);
 // Cursors without the stamp (v2) restart from the first page.
 const legacy=Buffer.from(JSON.stringify({v:2,owner,size:1,after:'1'})).toString('base64url');
 assert.throws(()=>query({limit:'1',after:legacy},owner),changed);
 // No expiry: elapsed time alone continues the same list.
 const now=Date.now;try{Date.now=()=>now()+86400000;assert.deepEqual(slice(rows,uid,query({limit:'1',after:cursor},owner),owner).rows,[{uid:'2'}]);}finally{Date.now=now;}
});
test('legacy unchanged and strict bounded page query',()=>{
 const rows=[{uid:'2'},{uid:'1'}];assert.deepEqual(slice(rows,uid,query({},owner),owner).rows,rows);
 for(const q of [{limit:'0'},{limit:'101'},{limit:['1']},{limit:1},{limit:'01'},{after:'x'},{limit:'1',extra:'x'}])assert.throws(()=>query(q,owner));
 assert.equal(slice([],uid,query({limit:'100'},owner),owner).pagination.total,0);
});
