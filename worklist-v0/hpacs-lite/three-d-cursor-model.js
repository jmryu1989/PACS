/* REQ-D-3D-CURSOR geometry. Pure: no DOM, no renderer, no storage.
   Every rejection returns a reason code; nothing here guesses a coordinate. */
(function(root){
  'use strict';
  // Scanners store IOP to ~6 decimals, so a tight axis tolerance still accepts real data
  // while rejecting the reformatted/derived planes this feature must not transport points to.
  const AXIS_TOL=1e-3,TIE_MM=1e-6,DUP_MM=1e-4,COVER_MM=1e-6;
  /* Provisional default for |n·(p−o)|, the distance from the picked point to the plane of the
     slice that is shown for it. 3.0 mm passes the worst case of a 5 mm slice (2.5 mm) and
     refuses a 10 mm interval stack, where the shown slice can be 5 mm away from the point.
     The mount injects its own value; this constant is the fallback, not a call-site literal. */
  const SLICE_DISTANCE_LIMIT_MM=3;
  const uid=v=>typeof v==='string'&&v.length<=64&&/^[0-9]+(?:\.[0-9]+)*$/.test(v);
  const num=v=>typeof v==='number'&&Number.isFinite(v);
  const key=v=>typeof v==='string'&&v.length>0&&v.length<=256?v:null;
  const triple=v=>Array.isArray(v)&&v.length===3&&v.every(num)?v.map(Number):null;
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>Math.sqrt(dot(a,a));
  const fail=reason=>({ok:false,reason});
  const extent=v=>Number.isSafeInteger(v)&&v>=1&&v<=1e5;

  function identity(meta){
    if(!meta||typeof meta!=='object')return null;
    const value={study:meta.StudyInstanceUID,series:meta.SeriesInstanceUID,sop:meta.SOPInstanceUID,frame:meta.FrameOfReferenceUID};
    if(!Object.values(value).every(uid))return null;
    const patient=key(meta.sourcePatientKey),modality=typeof meta.Modality==='string'?meta.Modality.trim().toUpperCase():null;
    if(!patient||!['CT','MR'].includes(modality))return null;
    return {...value,patient,modality};
  }

  /* One image plane frame. x is the column axis (IOP rows cosines, PixelSpacing[1]),
     y is the row axis (IOP column cosines, PixelSpacing[0]); pixel coordinates are
     {x: column index, y: row index} in the source image grid. */
  function plane(meta){
    const id=identity(meta);
    if(!id)return fail('identity-missing');
    const orientation=meta.ImageOrientationPatient,position=triple(meta.ImagePositionPatient),spacing=meta.PixelSpacing;
    if(!Array.isArray(orientation)||orientation.length!==6||!orientation.every(num)||!position)return fail('geometry-missing');
    if(!Array.isArray(spacing)||spacing.length!==2||!spacing.every(num))return fail('geometry-missing');
    const x=orientation.slice(0,3).map(Number),y=orientation.slice(3,6).map(Number);
    if(Math.abs(norm(x)-1)>AXIS_TOL||Math.abs(norm(y)-1)>AXIS_TOL||Math.abs(dot(x,y))>AXIS_TOL)return fail('geometry-axes');
    const stepX=Number(spacing[1]),stepY=Number(spacing[0]);
    if(!(stepX>0)||!(stepY>0))return fail('geometry-spacing');
    if(!extent(meta.Rows)||!extent(meta.Columns))return fail('geometry-extent');
    const normal=cross(x,y);
    if(Math.abs(norm(normal)-1)>AXIS_TOL)return fail('geometry-axes');
    return {ok:true,plane:{id,imageId:typeof meta.imageId==='string'?meta.imageId:null,x,y,normal,position,stepX,stepY,rows:meta.Rows,columns:meta.Columns,
      projection:dot(position,normal)}};
  }

  const toWorld=(p,pixel)=>[0,1,2].map(i=>p.position[i]+pixel.x*p.stepX*p.x[i]+pixel.y*p.stepY*p.y[i]);
  function toPixel(p,world){
    const d=sub(world,p.position);
    return {x:dot(d,p.x)/p.stepX,y:dot(d,p.y)/p.stepY,distance:dot(d,p.normal)};
  }
  const inImage=(p,pixel)=>pixel.x>=-0.5&&pixel.x<=p.columns-0.5&&pixel.y>=-0.5&&pixel.y<=p.rows-0.5;

  /* A pane's whole stack. The incoming order is never trusted: slices keep their original
     index for navigation and are sorted here only to verify one uniform slice interval. */
  function stack(metas){
    if(!Array.isArray(metas)||metas.length<2)return fail('stack-too-short');
    if(metas.length>5000)return fail('stack-too-long');
    const slices=[],sops=new Set();let base=null;
    for(let index=0;index<metas.length;index++){
      const built=plane(metas[index]);
      if(!built.ok)return built;
      const p=built.plane;
      if(!base)base=p;
      else{
        const b=base.id,i=p.id;
        if(i.study!==b.study||i.series!==b.series||i.frame!==b.frame||i.patient!==b.patient||i.modality!==b.modality)return fail('stack-identity-mixed');
        if(dot(p.x,base.x)<1-AXIS_TOL||dot(p.y,base.y)<1-AXIS_TOL)return fail('stack-orientation-mixed');
        if(p.stepX!==base.stepX||p.stepY!==base.stepY)return fail('stack-spacing-mixed');
        if(p.rows!==base.rows||p.columns!==base.columns)return fail('stack-extent-mixed');
      }
      if(sops.has(p.id.sop))return fail('stack-duplicate-sop');
      sops.add(p.id.sop);
      slices.push({index,imageId:p.imageId,plane:p,projection:p.projection});
    }
    const sorted=slices.slice().sort((a,b)=>a.projection-b.projection),gaps=[];
    for(let i=1;i<sorted.length;i++){
      const gap=sorted[i].projection-sorted[i-1].projection;
      if(gap<=DUP_MM)return fail('stack-duplicate-position');
      gaps.push(gap);
    }
    const gap=gaps.reduce((a,b)=>a+b,0)/gaps.length,tolerance=Math.max(1e-3,gap*0.01);
    if(gaps.some(value=>Math.abs(value-gap)>tolerance))return fail('stack-spacing-nonuniform');
    return {ok:true,stack:{id:base.id,normal:base.normal,gap,rows:base.rows,columns:base.columns,slices,
      first:sorted[0].projection,last:sorted[sorted.length-1].projection}};
  }

  const comparable=(a,b)=>!a||!b?'identity-missing':a.study!==b.study?'identity-study':a.patient!==b.patient?'identity-patient':a.frame!==b.frame?'identity-frame':null;

  /* Exhaustive nearest-plane choice. A tie means two candidate slices are equally
     plausible, so no point is placed rather than one of them being guessed.
     Four refusals are kept apart because they mean different things to a reader:
     out-of-coverage (outside what was scanned), slice-distance-exceeded (scanned, but no slice
     is close enough for the point to be shown as if it were on one), ambiguous-slice (two
     slices equally close) and out-of-image (inside the slice plane, outside its pixel grid).
     The distance limit is read before the tie: when no slice is close enough there is nothing
     to choose between, so the distance is the honest reason rather than the tie. */
  function locate(target,world,limit){
    const point=triple(world);
    if(!point)return fail('point-nonfinite');
    const cap=num(limit)&&limit>=0?limit:SLICE_DISTANCE_LIMIT_MM;
    const t=dot(point,target.normal),half=target.gap/2;
    if(t<target.first-half-COVER_MM||t>target.last+half+COVER_MM)return fail('out-of-coverage');
    let best=null,tie=false;
    for(const slice of target.slices){
      const distance=Math.abs(t-slice.projection);
      if(!best||distance<best.distance-TIE_MM){best={slice,distance};tie=false;}
      else if(distance<=best.distance+TIE_MM)tie=true;
    }
    if(!best)return fail('stack-too-short');
    if(best.distance>cap)return {ok:false,reason:'slice-distance-exceeded',distance:best.distance,limit:cap};
    if(tie)return fail('ambiguous-slice');
    const pixel=toPixel(best.slice.plane,point);
    if(!inImage(best.slice.plane,pixel))return fail('out-of-image');
    return {ok:true,index:best.slice.index,imageId:best.slice.imageId,sop:best.slice.plane.id.sop,
      pixel:{x:pixel.x,y:pixel.y},distance:best.distance,distanceLimit:cap,offPlane:pixel.distance};
  }

  /* The picked canvas point comes from the renderer and carries float residue off the
     source plane. Snapping to the plane makes the transported point exactly reproducible. */
  function pick(source,index,world,tolerance){
    const slice=source.slices.find(item=>item.index===index);
    if(!slice)return fail('pick-slice-unknown');
    const point=triple(world);
    if(!point)return fail('point-nonfinite');
    const pixel=toPixel(slice.plane,point),limit=num(tolerance)&&tolerance>=0?tolerance:0.5;
    if(Math.abs(pixel.distance)>limit)return fail('pick-off-plane');
    if(!inImage(slice.plane,pixel))return fail('out-of-image');
    const snapped={x:pixel.x,y:pixel.y};
    return {ok:true,pixel:snapped,world:toWorld(slice.plane,snapped),sop:slice.plane.id.sop,imageId:slice.imageId};
  }

  const api={AXIS_TOL,SLICE_DISTANCE_LIMIT_MM,identity,plane,stack,locate,pick,comparable,toWorld,toPixel,inImage};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KinThreeDCursorModel=api;
})(typeof globalThis==='object'?globalThis:this);
