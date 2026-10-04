"""Shared page defaults for isolated viewer panels (no auth/server or OHIF bundle).

The shipped authority, gate and transport run in Chromium. Panels use the public
onEnd port; full config registration/navigation is covered by viewer_session_dom_test.
"""
from pathlib import Path
from urllib.parse import urlparse

HPACS = Path(__file__).resolve().parents[1] / 'worklist-v0' / 'hpacs-lite'

def unbound_protected_request(request):
    path = urlparse(request.url).path
    protected = any(path == prefix or path.startswith(prefix + '/') for prefix in
                    ['/api', '/dicom-web', '/instances', '/statistics', '/system'])
    bootstrap = path == '/api/me' and request.method == 'GET' and request.resource_type in ('fetch', 'xhr')
    return protected and not request.headers.get('x-kin-session') and not bootstrap


def reject_unbound(route, failures):
    request = route.request
    if unbound_protected_request(request):
        path = urlparse(request.url).path
        failures.append((path, request.resource_type))
        route.fulfill(status=403, headers={'X-KIN-Auth-Code': 'AUTH_SESSION_REQUIRED'}, body='{}')
        return True
    return False


def install_viewer_session(page):
    failures = []
    page.route('**/*', lambda route: None if reject_unbound(route, failures) else route.fallback())
    for name in ['work-context.js', 'session-transport.js', 'viewer-resources.js', 'viewer-session.js']:
        page.add_script_tag(path=str(HPACS / name))
    page.evaluate("""() => {
      history.replaceState({...history.state,kinViewerSession:{session:'S1',ended:false}},'');
      const boundary=KinViewerSession.connect(window);
      window.kinViewerOnEnd=run=>({close:boundary.onEnd(run)});
      return boundary.ready;
    }""")
    return failures


# Only Cornerstone's rendering service is synthetic. Controls, events, job model,
# MIP sequence and all session modules are the shipped code on a real document.
MIP_RENDERER = r"""() => {
  const presets={axial:{viewPlaneNormal:[0,0,-1],viewUp:[0,-1,0]},sagittal:{viewPlaneNormal:[1,0,0],viewUp:[0,0,1]},coronal:{viewPlaneNormal:[0,-1,0],viewUp:[0,0,1]}};
  const volume={volumeId:'volume-1',dimensions:[64,64,33],spacing:[.5,.5,2.5],imageIds:['image:1'],
    imageData:{getSpatialExtent:()=>[0,63,0,63,0,32],indexToWorld:i=>[i[0]*.5,i[1]*.5,i[2]*2.5]}};
  const views=new Map();window.mipNativeWrites=0;
  const engine={resize(){},enableElement({viewportId,element}){
    let camera=null,blend=0,half=0,properties={};const extra=[],centre=[15.75,15.75,40];
    const slab=sign=>({getOrigin:()=>centre.map((x,i)=>x-sign*camera.viewPlaneNormal[i]*half),getNormal:()=>camera.viewPlaneNormal.map(n=>sign*n)});
    const mapper={getBlendMode:()=>blend,getSampleDistance:()=>(.5+.5+2.5)/6,getClippingPlanes:()=>[...(camera?[slab(1),slab(-1)]:[]),...extra],
      addClippingPlane:p=>{extra.push(p);return true},removeClippingPlane:p=>{const i=extra.indexOf(p);if(i<0)return false;extra.splice(i,1);return true}};
    const actor={getMapper:()=>mapper,getProperty:()=>({getInterpolationType:()=>properties.interpolationType})};
    views.set(viewportId,{mapper,getVolumeId:()=>volume.volumeId,setVolumes:async()=>{},getActors:()=>[{actor}],
      setOrientation:key=>{mipNativeWrites++;const axes=presets[key];camera={...structuredClone(axes),focalPoint:[...centre],position:centre.map((x,i)=>x+axes.viewPlaneNormal[i]*120),parallelScale:60}},
      setCamera:value=>{mipNativeWrites++;camera={...camera,...structuredClone(value)}},getCamera:()=>structuredClone(camera),
      setBlendMode:v=>{mipNativeWrites++;blend=v},setSlabThickness:v=>{mipNativeWrites++;half=v},
      setProperties:v=>{mipNativeWrites++;properties={...properties,...v}},getProperties:()=>properties,
      render:()=>setTimeout(()=>element.dispatchEvent(new Event('IMAGE_RENDERED')),0)});
  },getViewport:id=>views.get(id),disableElement:id=>views.delete(id)};
  engine.offscreenMultiRenderWindow={getOpenGLRenderWindow:()=>({getViewNodeFor:mapper=>({get:()=>({tris:{getProgram:()=>({getCompiled:()=>true,getLinked:()=>true,
    getFragmentShader:()=>({getSource:()=>`for(int i = 0; i < ${mapper.getClippingPlanes().length}; i++) {\n  float rayDirRatio = dot(rayDir, vClipPlaneNormals[i]);\n if (rayDirRatio < 0.0) dists.y = min(dists.y, result);\n else dists.x = max(dists.x, result);\n}`})})}})})})};
  const source={id:'vp-0',getVolumeId:()=>volume.volumeId,getRenderingEngine:()=>engine,getActors:()=>[{actor:{getMapper:()=>({})}}],getProperties:()=>({voiRange:{lower:-1100,upper:1100},interpolationType:0})};
  const target={group:'group-1',selection:'selection-1',views:[source,{id:'vp-1'},{id:'vp-2'}],source:{viewportId:'vp-0',uid:'1.2.3',series:'1.2.4',study:{id:'SYNTHETIC'}}};
  window.cornerstone={cache:{getVolume:()=>volume},metaData:{get:()=>({FrameOfReferenceUID:'2.25.6'})},Enums:{Events:{IMAGE_RENDERED:'IMAGE_RENDERED'},ViewportType:{ORTHOGRAPHIC:'orthographic'}},CONSTANTS:{MPR_CAMERA_VALUES:presets}};
  window.mipNotices=[];
  window.mip=kinCreateVolumeMip({target:()=>target,permitted:()=>true,alive:()=>true,owner:()=>['I1','u1'],notice:value=>mipNotices.push(value)});
  return mip.open();
}"""
