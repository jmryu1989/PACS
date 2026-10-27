// M02: original spacing -> saved geometry -> verified readback -> SR, with no HU inferred for non-CT images.
// REQ-MANUAL-SPACED-MODALITIES -> RISK-WRONG-SCALE-OR-UNITS -> TEST-PLANAR-MEASUREMENT.
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {viewerCommand,verifyViewerReference}=require('/app/dist/viewer-input.js');
const {srMeasurement,srDataset,srFile}=require('/app/dist/manual-sr-dicom.js');
const {planarGeometry}=require('/app/dist/planar-geometry.js');
const context=vm.createContext({});
for(const file of ['mg-length','planar-geometry'])vm.runInContext(fs.readFileSync('config/ohif/'+file+'.js','utf8'),context);
const base={StudyInstanceUID:'2.25.1',SeriesInstanceUID:'2.25.2',SOPInstanceUID:'2.25.3',SOPClassUID:'1.2.840.10008.5.1.4.1.1.4',Rows:128,Columns:128,PixelSpacing:[.5,.25],ImagePositionPatient:[0,0,0],ImageOrientationPatient:[1,0,0,0,1,0]};
for(const modality of ['MR','DX','US','XA','MG'])test(modality+' length, angle and area survive source verification and SR',()=>{
 const tags={...base,Modality:modality,...(modality==='MG'?{SOPClassUID:'1.2.840.10008.5.1.4.1.1.1.2'}:{})};
 const cases=[['length',[[0,0,0],[3,4,0]],5],['angle',[[0,1,0],[0,0,0],[1,0,0]],90],['angle',[[0,1,0],[0,0,0],[0,2,0]],0],['angle',[[0,1,0],[0,2,0],[0,3,0]],180],['ellipse',[[4,6,0],[4,2,0],[1,4,0],[7,4,0]],Math.PI*6]];
 for(const [kind,points,expected] of cases){
  const browser=context.kinPlanarGeometry(tags,1),server=planarGeometry(tags,1);
  for(const geometry of [browser,server])assert.ok(Math.abs(geometry.measure(kind,points)-expected)<1e-10);
  const item=viewerCommand(Buffer.from(JSON.stringify({requestId:'00000000-0000-4000-8000-000000000001',item:{schemaVersion:1,kind,seriesUid:tags.SeriesInstanceUID,sopUid:tags.SOPInstanceUID,frame:1,frameOfReferenceUid:null,label:'Manual',points,viewPlaneNormal:[0,0,1],viewUp:[0,1,0],baseline:{calculator:server.calculator,values:[expected]}}})),true).item;
  verifyViewerReference(tags.StudyInstanceUID,item,tags);
  const computed=srMeasurement(item,tags);assert.equal(computed.values.length,1);assert.ok(Math.abs(computed.values[0]-expected)<1e-10);
  const dataset=srDataset('sr-planar',tags.StudyInstanceUID,'Reader','reader',new Date('2026-10-26'),[{head:{id:'m-planar',revision:1,snapshot:item},tags,computed}],1);
  const procedure=dataset.ContentSequence.find(node=>node.ConceptNameCodeSequence.CodeValue==='121058').ConceptCodeSequence;
  assert.equal(procedure.CodeValue,modality);
  const group=dataset.ContentSequence.at(-1).ContentSequence[0].ContentSequence;
  const numeric=group.filter(node=>node.ValueType==='NUM');assert.equal(numeric.length,1);
  assert.equal(numeric[0].MeasuredValueSequence.MeasurementUnitsCodeSequence.CodeValue,{length:'mm',angle:'deg',ellipse:'mm2'}[kind]);
  assert.ok(Math.abs(Number(numeric[0].MeasuredValueSequence.NumericValue)-expected)<1e-10);
  assert.equal(numeric[0].ContentSequence.ContentSequence.ReferencedSOPSequence.ReferencedSOPInstanceUID,tags.SOPInstanceUID);
  const file=srFile(dataset);assert.equal(file.subarray(128,132).toString(),'DICM');
  assert.ok(file.includes(Buffer.from(computed.basis)));
  assert.throws(()=>verifyViewerReference(tags.StudyInstanceUID,{...item,baseline:{...item.baseline,values:[expected+1]}},tags));
 }
});
test('selected multiframe spacing and detector calibration remain explicit',()=>{
 const tags={...base,Modality:'XA',NumberOfFrames:2401,PerFrameFunctionalGroupsSequence:Array.from({length:2401},()=>({PixelMeasuresSequence:[{PixelSpacing:[1,2]}],PlanePositionSequence:[{ImagePositionPatient:[0,0,0]}],PlaneOrientationSequence:[{ImageOrientationPatient:[1,0,0,0,1,0]}]}))};
 tags.PerFrameFunctionalGroupsSequence[2400].PixelMeasuresSequence[0].PixelSpacing=[.5,.25];
 assert.deepEqual(planarGeometry(tags,2401).spacing,[.5,.25]);assert.throws(()=>planarGeometry(tags,2402));
 const detector={...base,Modality:'DX',PixelSpacing:undefined,ImagerPixelSpacing:[.2,.4]};
 assert.match(planarGeometry(detector,1).label,/검출기/);
 assert.throws(()=>planarGeometry({...detector,ImagerPixelSpacing:undefined},1));
});
