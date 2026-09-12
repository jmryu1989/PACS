/* REQ-D-3D-CURSOR / RISK-D-3D-CURSOR-IDENTITY/GEOMETRY / TEST-3D-CURSOR-MODEL */
const test=require('node:test'),assert=require('node:assert/strict');
const {identity,plane,stack,locate,pick,comparable,toWorld,toPixel}=require('../worklist-v0/hpacs-lite/three-d-cursor-model.js');

const AXIAL=[1,0,0,0,1,0];
// PixelSpacing is [between rows, between columns]: a row/column swap changes these results.
const SPACING=[0.8,0.5],ROWS=256,COLUMNS=512;
const base=(over={})=>({StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.3.4',SOPInstanceUID:'1.2.3.4.1',
  FrameOfReferenceUID:'1.2.9',sourcePatientKey:'hospital|patient',Modality:'CT',
  ImageOrientationPatient:AXIAL,ImagePositionPatient:[-250,-250,0],PixelSpacing:SPACING,Rows:ROWS,Columns:COLUMNS,imageId:'image:0',...over});
const axial=(count=5,gap=5,over={})=>Array.from({length:count},(_,k)=>base({SOPInstanceUID:'1.2.3.4.'+(k+1),imageId:'image:'+k,
  ImagePositionPatient:[-250,-250,gap*k],...over}));
const ok=value=>{assert.equal(value.ok,true,value.reason);return value;};
const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance,a+' !~ '+b);

test('a known physical point maps to the slice that contains it and back to its pixel',()=>{
  const built=ok(stack(axial())).stack;
  near(built.gap,5);
  const found=ok(locate(built,[-200,-210,10]));
  assert.equal(found.index,2);assert.equal(found.sop,'1.2.3.4.3');
  near(found.pixel.x,100);near(found.pixel.y,50);near(found.distance,0);
  assert.deepEqual(toWorld(built.slices[2].plane,{x:100,y:50}),[-200,-210,10]);
  // Row and column spacing are not interchangeable.
  const swapped=ok(stack(axial(5,5,{PixelSpacing:[0.5,0.8]}))).stack;
  const other=ok(locate(swapped,[-200,-210,10]));
  near(other.pixel.x,62.5);near(other.pixel.y,80);
});

test('an oblique plane resolves a hand-computed point without assuming an axis',()=>{
  const u=[1,0,0],v=[0,0.8660254037844387,0.5],n=[0,-0.5,0.8660254037844387];
  const metas=Array.from({length:4},(_,k)=>base({SOPInstanceUID:'1.2.3.4.'+(k+1),imageId:'image:'+k,
    ImageOrientationPatient:[...u,...v],ImagePositionPatient:n.map(value=>value*3*k)}));
  const built=ok(stack(metas)).stack;
  near(built.gap,3,1e-12);
  const found=ok(locate(built,[5,12.356406460551018,10.598076211353316]));
  assert.equal(found.index,1);near(found.pixel.x,10,1e-9);near(found.pixel.y,20,1e-9);
  const round=toPixel(built.slices[1].plane,toWorld(built.slices[1].plane,{x:10,y:20}));
  near(round.x,10,1e-9);near(round.y,20,1e-9);near(round.distance,0,1e-9);
});

test('an unordered series resolves the same slice as the ordered one and keeps its own index',()=>{
  const ordered=axial(5),shuffled=[ordered[3],ordered[0],ordered[4],ordered[1],ordered[2]];
  const a=ok(locate(ok(stack(ordered)).stack,[-200,-210,15])),b=ok(locate(ok(stack(shuffled)).stack,[-200,-210,15]));
  assert.equal(a.index,3);assert.equal(b.index,0);
  assert.equal(a.sop,b.sop);assert.equal(a.imageId,b.imageId);
  assert.deepEqual(a.pixel,b.pixel);
});

test('nearest slice is chosen exhaustively and an exact tie is refused instead of guessed',()=>{
  const built=ok(stack(axial())).stack;
  assert.equal(ok(locate(built,[-200,-210,11])).index,2);
  assert.equal(ok(locate(built,[-200,-210,13.5])).index,3);
  assert.equal(locate(built,[-200,-210,12.5]).reason,'ambiguous-slice');
});

test('points outside the image or outside the stack coverage are rejected',()=>{
  const built=ok(stack(axial())).stack;
  assert.equal(ok(locate(built,[-250.25,-250.2,0])).index,0);
  assert.equal(locate(built,[6,-210,10]).reason,'out-of-image');
  assert.equal(locate(built,[-250.26,-210,10]).reason,'out-of-image');
  assert.equal(locate(built,[-200,-45.5,10]).reason,'out-of-image');
  assert.equal(ok(locate(built,[-200,-210,-2.4])).index,0);
  assert.equal(locate(built,[-200,-210,-2.6]).reason,'out-of-coverage');
  assert.equal(locate(built,[-200,-210,22.6]).reason,'out-of-coverage');
  assert.equal(locate(built,[-200,-210,Number.NaN]).reason,'point-nonfinite');
  assert.equal(locate(built,[-200,-210]).reason,'point-nonfinite');
});

test('incomplete or invalid plane geometry is rejected with its reason',()=>{
  const cases=[
    ['geometry-missing',{ImageOrientationPatient:[1,0,0,0,1]}],
    ['geometry-missing',{ImagePositionPatient:[-250,-250,'0']}],
    ['geometry-missing',{ImagePositionPatient:[-250,-250,Number.POSITIVE_INFINITY]}],
    ['geometry-missing',{PixelSpacing:[0.8]}],
    ['geometry-axes',{ImageOrientationPatient:[2,0,0,0,1,0]}],
    ['geometry-axes',{ImageOrientationPatient:[1,0,0,0.5,0.8660254037844386,0]}],
    ['geometry-axes',{ImageOrientationPatient:[1,0,0,1,0,0]}],
    ['geometry-spacing',{PixelSpacing:[0.8,0]}],
    ['geometry-spacing',{PixelSpacing:[-0.8,0.5]}],
    ['geometry-extent',{Rows:0}],['geometry-extent',{Columns:256.5}],
    ['identity-missing',{FrameOfReferenceUID:undefined}],
    ['identity-missing',{StudyInstanceUID:'not a uid'}],
    ['identity-missing',{sourcePatientKey:''}],
    ['identity-missing',{Modality:'US'}],
    ['identity-missing',{Modality:'SR'}]];
  for(const [reason,over] of cases){
    assert.equal(plane(base(over)).reason,reason,JSON.stringify(over));
    assert.equal(stack([base(),base({SOPInstanceUID:'1.2.3.4.2',ImagePositionPatient:[-250,-250,5],...over})]).reason,reason,JSON.stringify(over));
  }
  assert.equal(plane(null).reason,'identity-missing');
  assert.equal(identity(base({Modality:'ct'})).modality,'CT');
});

test('a stack with mixed identity, mixed geometry or an unusable slice interval is rejected',()=>{
  const pair=over=>[base(),base({SOPInstanceUID:'1.2.3.4.2',imageId:'image:1',ImagePositionPatient:[-250,-250,5],...over})];
  assert.equal(stack(pair({StudyInstanceUID:'1.2.4'})).reason,'stack-identity-mixed');
  assert.equal(stack(pair({SeriesInstanceUID:'1.2.3.5'})).reason,'stack-identity-mixed');
  assert.equal(stack(pair({FrameOfReferenceUID:'1.2.8'})).reason,'stack-identity-mixed');
  assert.equal(stack(pair({sourcePatientKey:'hospital|other'})).reason,'stack-identity-mixed');
  assert.equal(stack(pair({Modality:'MR'})).reason,'stack-identity-mixed');
  assert.equal(stack(pair({ImageOrientationPatient:[0,1,0,-1,0,0]})).reason,'stack-orientation-mixed');
  assert.equal(stack(pair({ImageOrientationPatient:[-1,0,0,0,-1,0]})).reason,'stack-orientation-mixed');
  assert.equal(stack(pair({PixelSpacing:[0.8,0.6]})).reason,'stack-spacing-mixed');
  assert.equal(stack(pair({Rows:512})).reason,'stack-extent-mixed');
  assert.equal(stack(pair({SOPInstanceUID:'1.2.3.4.1'})).reason,'stack-duplicate-sop');
  assert.equal(stack(pair({ImagePositionPatient:[-250,-250,0]})).reason,'stack-duplicate-position');
  assert.equal(stack([base()]).reason,'stack-too-short');
  assert.equal(stack([]).reason,'stack-too-short');
  const nonUniform=axial();nonUniform[3].ImagePositionPatient=[-250,-250,16];
  assert.equal(stack(nonUniform).reason,'stack-spacing-nonuniform');
  const tolerated=axial();tolerated[3].ImagePositionPatient=[-250,-250,15.02];
  assert.equal(stack(tolerated).ok,true);
  const flipped=axial();flipped[2].ImageOrientationPatient=[1,0,0,0,-1,0];
  assert.equal(stack(flipped).reason,'stack-orientation-mixed');
});

/* Independent review D-3DCURSOR-801AD73 §8-3. The unit/orthogonality check on the two image
   axes is the only defence against these two orientations: their cross product is exactly a
   unit vector, so the later normal-norm check accepts them. Without the axis check the same
   physical point is reported at twice the column index and half the row index. */
test('an orthogonal but non-unit orientation is refused although its normal is a unit vector',()=>{
  const pair=over=>[base(),base({SOPInstanceUID:'1.2.3.4.2',ImagePositionPatient:[-250,-250,5],...over})];
  // |x|=2, |y|=0.5, x.y=0 -> cross(x,y) === [0,0,1].
  const scaled={ImageOrientationPatient:[2,0,0,0,0.5,0]};
  assert.equal(plane(base(scaled)).reason,'geometry-axes');
  assert.equal(stack(pair(scaled)).reason,'geometry-axes');
  // Skewed as well as non-unit: x.y=0.5, and cross([1,0,0],[0.5,1,0]) === [0,0,1] all the same.
  const skewed={ImageOrientationPatient:[1,0,0,0.5,1,0]};
  assert.equal(plane(base(skewed)).reason,'geometry-axes');
  assert.equal(stack(pair(skewed)).reason,'geometry-axes');
  // What the refusal prevents: PixelSpacing is divided out of a projection onto a non-unit axis,
  // so one and the same world point would land on a silently rescaled pixel.
  const good=ok(plane(base())).plane;
  near(toPixel(good,[-200,-210,0]).x,100);near(toPixel(good,[-200,-210,0]).y,50);
  const rescaled=toPixel({...good,x:[2,0,0],y:[0,0.5,0]},[-200,-210,0]);
  near(rescaled.x,200);near(rescaled.y,25);
});

test('only same study, same patient and same frame of reference panes are comparable',()=>{
  const a=identity(base()),b=identity(base({SeriesInstanceUID:'1.2.3.5',SOPInstanceUID:'1.2.3.5.1',Modality:'MR'}));
  assert.equal(comparable(a,b),null);
  assert.equal(comparable(a,identity(base({StudyInstanceUID:'1.2.4'}))),'identity-study');
  assert.equal(comparable(a,identity(base({sourcePatientKey:'other|patient'}))),'identity-patient');
  assert.equal(comparable(a,identity(base({FrameOfReferenceUID:'1.2.8'}))),'identity-frame');
  assert.equal(comparable(a,null),'identity-missing');
});

test('a picked point is snapped to the displayed plane and refused when it is not on it',()=>{
  const built=ok(stack(axial())).stack;
  const picked=ok(pick(built,2,[-200.0000004,-210,10.0000004],0.5));
  near(picked.pixel.x,100,1e-6);near(picked.pixel.y,50,1e-6);
  assert.deepEqual(picked.world,toWorld(built.slices[2].plane,picked.pixel));
  near(picked.world[2],10,1e-12);
  assert.equal(picked.sop,'1.2.3.4.3');assert.equal(picked.imageId,'image:2');
  assert.equal(pick(built,2,[-200,-210,11],0.5).reason,'pick-off-plane');
  assert.equal(pick(built,2,[-200,-210,10.6],0.5).reason,'pick-off-plane');
  assert.equal(pick(built,2,[6,-210,10],0.5).reason,'out-of-image');
  assert.equal(pick(built,9,[-200,-210,10],0.5).reason,'pick-slice-unknown');
  assert.equal(pick(built,2,[-200,-210,Number.NaN],0.5).reason,'point-nonfinite');
});

test('a point picked on one series lands on the matching slice of a differently spaced series',()=>{
  const source=ok(stack(axial(5,5))).stack;
  const target=ok(stack(axial(9,2.5,{SeriesInstanceUID:'1.2.3.9',Modality:'MR',PixelSpacing:[1,1],Rows:128,Columns:128,
    ImagePositionPatient:[-64,-64,0]}).map((meta,k)=>({...meta,SOPInstanceUID:'1.2.3.9.'+(k+1),imageId:'mr:'+k,
      ImagePositionPatient:[-64,-64,2.5*k]})))).stack;
  assert.equal(comparable(source.id,target.id),null);
  const picked=ok(pick(source,2,[-20,-60,10],0.5));
  near(picked.pixel.x,460);near(picked.pixel.y,237.5);
  const found=ok(locate(target,picked.world));
  assert.equal(found.index,4);assert.equal(found.sop,'1.2.3.9.5');
  near(found.pixel.x,44);near(found.pixel.y,4);
  assert.equal(locate(target,toWorld(source.slices[2].plane,{x:0,y:0})).reason,'out-of-image');
});
