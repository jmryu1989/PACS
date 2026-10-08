/* Synthetic native adapter for consumer-boundary tests, not an OHIF pixel oracle. */
window.mountContextMip = () => {
  const engine=engines[0],volume={volumeId:'volume-1',dimensions:[64,64,33],spacing:[.5,.5,2.5],imageIds:['image:1'],
    imageData:{getSpatialExtent:()=>[0,63,0,63,0,32],indexToWorld:i=>[i[0]*.5,i[1]*.5,i[2]*2.5]}};
  const presets={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,-1,0],viewUp:[0,0,1]}};
  const privateViews=new Map();window.mipViews=privateViews;
  engine.enableElement=({viewportId,element})=>{
    let camera=null,blend=0,half=0,properties={};const extra=[],centre=[15.75,15.75,40],canvas=document.createElement('canvas');element.append(canvas);
    const slab=sign=>({getOrigin:()=>centre.map((x,i)=>x-sign*camera.viewPlaneNormal[i]*half),getNormal:()=>camera.viewPlaneNormal.map(n=>sign*n)});
    const mapper={getBlendMode:()=>blend,getSampleDistance:()=>3.5/6,getClippingPlanes:()=>[...(camera?[slab(1),slab(-1)]:[]),...extra],
      setViewSpecificProperties(){},addClippingPlane:p=>{extra.push(p);return true},removeClippingPlane:p=>{const i=extra.indexOf(p);if(i<0)return false;extra.splice(i,1);return true}};
    const actor={getMapper:()=>mapper,getProperty:()=>({getInterpolationType:()=>properties.interpolationType})};
    const blob=canvas.toBlob.bind(canvas);canvas.toBlob=(run,...args)=>window.holdBlob?window.finishBlob=()=>blob(run,...args):blob(run,...args);
    const view={id:viewportId,element,mapper,suppressEvents:true,getRenderingEngine:()=>engine,getVolumeId:()=>volume.volumeId,setVolumes:()=>window.holdVolumes?new Promise(r=>window.finishVolumes=r):Promise.resolve(),getActors:()=>[{actor}],
      setOrientation:key=>{const axes=presets[key];camera={...structuredClone(axes),focalPoint:[...centre],position:centre.map((x,i)=>x+axes.viewPlaneNormal[i]*120),parallelScale:60,parallelProjection:true};},
      setCamera:next=>{camera={...camera,...structuredClone(next)}},setBlendMode:v=>{blend=v},setSlabThickness:v=>{half=v},
      setProperties:v=>{properties={...properties,...v}},getProperties:()=>properties,getCamera:()=>structuredClone(camera),getCanvas:()=>canvas,
      render(){canvas.width=512;canvas.height=512;canvas.getContext('2d').fillRect(0,0,512,512);
        if(window.loseBeforeFrame)engine.gl.getExtension('WEBGL_lose_context').loseContext();
        element.dispatchEvent(new CustomEvent('IMAGE_RENDERED',{bubbles:true,detail:{element,viewportId}}));}};
    privateViews.set(viewportId,view);enabled.set(element,{viewport:view});
  };
  engine.getViewport=id=>privateViews.get(id);engine.disableElement=id=>privateViews.delete(id);
  engine.offscreenMultiRenderWindow.getOpenGLRenderWindow=()=>({getContext:()=>engine.gl,getViewNodeFor:mapper=>({get:()=>({tris:{getProgram:()=>({getCompiled:()=>true,getLinked:()=>true,
    getFragmentShader:()=>({getSource:()=>`for(int i = 0; i < ${mapper.getClippingPlanes().length}; i++) {\n  float rayDirRatio = dot(rayDir, vClipPlaneNormals[i]);\nif (rayDirRatio < 0.0) dists.y = min(dists.y, result);\nelse dists.x = max(dists.x, result);\n}`})})}})})});
  const source={id:'source',getVolumeId:()=>volume.volumeId,getRenderingEngine:()=>engine,getActors:()=>[{actor:{getMapper:()=>({})}}],getProperties:()=>({voiRange:{lower:-1100,upper:1100},interpolationType:0})};
  const target={group:'group',selection:'selection',views:[source,{id:'b'},{id:'c'}],source:{viewportId:'source',uid:'1.2.3',series:'1.2.5',study:{id:'SYNTHETIC'}}};
  Object.assign(cornerstone,{cache:{getVolume:()=>volume},metaData:{get:()=>({FrameOfReferenceUID:'2.25.6'})},CONSTANTS:{MPR_CAMERA_VALUES:presets}});
  cornerstone.Enums.ViewportType={ORTHOGRAPHIC:'orthographic'};
  window.kinViewerJobCommand={pending:()=>pending,owner:()=>JSON.stringify(['hospital','reader']),writable:()=>true,busy:()=>false,
    save:async()=>{pending={requestId:'retained'};return {state:'unconfirmed',sent:true}},retry:async()=>({state:'unconfirmed',sent:true})};
  window.mipNotices=[];
  window.mip=kinCreateVolumeMip({target:()=>target,permitted:()=>true,alive:()=>true,owner:()=>['hospital','reader'],notice:text=>mipNotices.push(text)});
  window.kinVolumeMipJob=mip.job;return mip.open();
};
