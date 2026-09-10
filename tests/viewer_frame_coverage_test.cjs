const test=require('node:test'),assert=require('node:assert/strict');
const {catalog,tracker,reference}=require('../worklist-v0/hpacs-lite/viewer-frame-coverage.js');
const row=(sop,frames=1)=>Object.fromEntries(Object.entries({'0020000D':'1.2','0020000E':'1.3','00080018':sop,'00080016':'1.2.840.10008.5.1.4.1.1.2','00280010':256,'00280011':256,'00280008':frames}).map(([k,v])=>[k,{Value:[v]}]));
test('count unique actual frames and reject foreign/out-of-range references',()=>{
 const t=tracker(catalog(['1.2'],[[row('1.4',3),row('1.5')]]));
 const r={study:'1.2',series:'1.3',sop:'1.4',frame:2};
 assert.equal(t.mark(r),true);assert.equal(t.mark(r),false);
 for(const bad of [{...r,study:'1.9'},{...r,series:'1.9'},{...r,sop:'1.9'},{...r,frame:0},{...r,frame:4},{...r,frame:1.5}])assert.equal(t.mark(bad),false);
 assert.deepEqual(t.snapshot(),{total:4,shown:1,remaining:3,documents:0});
 for(const frame of [1,3])t.mark({...r,frame});t.mark({...r,sop:'1.5',frame:1});assert.equal(t.snapshot().remaining,0);
});
test('empty, duplicate, mismatched, malformed and excessive catalogs fail closed',()=>{
 for(const list of [[],[row('1.4'),row('1.4')],[row('1.4',0)],[row('1.4',100001)],[{...row('1.4'),'0020000D':{Value:['1.8']}}],[{...row('1.4'),'00280010':undefined}]])assert.throws(()=>catalog(['1.2'],[list]));
 assert.throws(()=>catalog(['1.2','1.2'],[[row('1.4')],[row('1.4')]]));
});
test('non-image documents are separately counted and never accepted as frames',()=>{
 const doc=row('1.9');doc['00080016']={Value:['1.2.840.10008.5.1.4.1.1.104.1']};delete doc['00280010'];delete doc['00280011'];
 const t=tracker(catalog(['1.2'],[[row('1.4'),doc]]));assert.equal(t.snapshot().documents,1);assert.equal(t.snapshot().total,1);assert.equal(t.mark({study:'1.2',series:'1.3',sop:'1.9',frame:1}),false);
});
test('renderer references require complete metadata and 1-based WADO frame identity',()=>{
 const m={StudyInstanceUID:'1.2',SeriesInstanceUID:'1.3',SOPInstanceUID:'1.4'};
 const id='wadors:https://localhost/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/2';
 assert.deepEqual(reference(id,m),{study:'1.2',series:'1.3',sop:'1.4',frame:2});
 assert.equal(reference(id,{...m,SOPInstanceUID:'1.9'}),null);assert.equal(reference('volumeId:1.2',m),null);assert.equal(reference(id.replace('/2','/0'),m),null);
});
