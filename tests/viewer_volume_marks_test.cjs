// TEST-MPR-MARKS: server bounds use the full verified DICOM voxel basis.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateVolumeMarks,verifyVolumeMarkBounds}=require('/app/dist/viewer-volume-marks.js');
const mark={id:'00000000-0000-4000-8000-000000000001',label:'Manual point',point:[10,20,-5]},value={version:1,visible:true,sync:true,marks:[mark]};
const rejected=fn=>assert.throws(fn,e=>e.getStatus?.()===400);
test('reject malformed text, unknown fields and duplicate identity',()=>{
 validateVolumeMarks(value);
 for(const change of [v=>v.version=2,v=>v.marks.push({...mark}),v=>v.marks[0].label='\n',v=>v.marks[0].point=[1,2],v=>v.marks[0].point[0]=Infinity,v=>v.marks[0].sop='2.25.7']){const v=structuredClone(value);change(v);rejected(()=>validateVolumeMarks(v));}
});
test('rotated anisotropic descending slice bounds preserve patient coordinates',()=>{
 const check=p=>verifyVolumeMarkBounds({version:1,visible:true,sync:true,marks:[{...mark,point:p}]},[10,20,-5],[0,2,0],[-3,0,0],[0,0,-4],[5,8,10]);
 check([10,20,-5]);check([11.5,19,-3]);check([-12.5,29,-43]);
 rejected(()=>check([11.51,19,-3]));rejected(()=>check([-12.5,29,-43.01]));
});
test('near-orthogonal DICOM direction uses an inverse rather than dot approximation',()=>{
 const x=[2,0,0],y=[.00005,3,0],z=[0,0,4],origin=[100,200,300],dims=[256,256,33];
 const point=origin.map((n,i)=>n+x[i]*255.5+y[i]*255.5+z[i]*32.5);
 verifyVolumeMarkBounds({version:1,visible:true,sync:true,marks:[{...mark,point}]},origin,x,y,z,dims);
 point[0]+=.001;rejected(()=>verifyVolumeMarkBounds({version:1,visible:true,sync:true,marks:[{...mark,point}]},origin,x,y,z,dims));
});

test('v6 parser retains complete volume identity, marks and nullable batch only',()=>{
 const {jobCommand}=require('/app/dist/viewer-job-input.js');
 const v={study:'2.25.1',series:'2.25.2',sops:['2.25.3','2.25.4']};
 const c={study:v.study,series:v.series,viewport:{width:256,height:256},projection:{blend:0,thickness:.1},camera:{focalPoint:[10,20,-5],position:[10,20,95],viewUp:[0,1,0],viewPlaneNormal:[0,0,1],parallelScale:128,rotation:0,flipHorizontal:false,flipVertical:false},properties:{voiRange:{lower:0,upper:1000},VOILUTFunction:'LINEAR',invert:false,interpolationType:1}};
 const s={version:6,studies:[v.study],volume:v,rows:1,cols:3,active:0,cells:[c,c,c],marks:value,batch:null};
 const parse=snapshot=>jobCommand(Buffer.from(JSON.stringify({id:mark.id,title:'Manual MPR',description:'',snapshot})),true);
 assert.equal(Object.getPrototypeOf(parse(s).snapshot),null);assert.deepEqual(JSON.parse(JSON.stringify(parse(s).snapshot)),s);
 for(const change of [a=>a.volume.sourceDigest='forged',a=>a.marks.visible='true',a=>a.batch={},a=>a.cells[0].sop=v.sops[0]]){const a=structuredClone(s);change(a);rejected(()=>parse(a));}
});
