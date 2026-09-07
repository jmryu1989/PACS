# coding: utf-8
from pathlib import Path
import sys,json,unittest,uuid,hashlib,io,math,re
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'tests/e2e'))
from test_thumbnail_requests import ThumbnailRequestsE2E
from test_prior_selection import canvas_ready
from playwright.sync_api import expect
from pydicom import dcmread
from viewer_precision_fixture import synthetic_ct
out=Path(__file__).parent
record={'codeSHA':'35c2c4a70c9879b7a64e5676e2cc1cc037a5a8c3','status':'STARTED','observations':[]}
def persist(): (out/'probe.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def dot(a,b):return sum(x*y for x,y in zip(a,b))
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def geometry(m,points):
    u,v=m['orientation'][:3],m['orientation'][3:];n=cross(u,v);n=[x/math.sqrt(dot(n,n)) for x in n]
    uu,vv,uv=dot(u,u),dot(v,v),dot(u,v);det=uu*vv-uv*uv
    result=[]
    for point in points:
        d=[x-y for x,y in zip(point,m['position'])];a,b=dot(d,u),dot(d,v)
        col=(a*vv-b*uv)/det/m['spacing'][1];row=(b*uu-a*uv)/det/m['spacing'][0]
        result.append({'planeErrorMM':abs(dot(d,n)),'column':col,'row':row,
          'candidateAccepted':abs(dot(d,n))<=.001 and -.501<=col<=m['columns']-.499 and -.501<=row<=m['rows']-.499 and max(abs(uu-1),abs(vv-1),abs(uv))<=1e-4})
    return result
hook='''
window.__d05c1={events:[]};
window.config.extensions.push({id:'kin.local-d05c1-observer',
 preRegistration({servicesManager}) {window.__d05c1.services=servicesManager.services;__d05c1.events.push('preRegistration');},
 onModeEnter(){__d05c1.events.push('onModeEnter');}
});
'''
def state(page):
    return page.evaluate('''() => {
      const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports())[0];
      return {camera:v.getCamera(),imageId:v.getCurrentImageId(),index:v.getCurrentImageIdIndex(),
       arrows:cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').map(a=>({
         uid:a.annotationUID,metadata:a.metadata,points:a.data.handles.points,text:a.data.text,
         projected:a.data.handles.points.map(p=>v.worldToCanvas(p))})),
       measurements:__d05c1.services.measurementService.getMeasurements().map(m=>({uid:m.uid,label:m.label,points:m.points,
         study:m.referenceStudyUID,series:m.referenceSeriesUID,sop:m.SOPInstanceUID,frame:m.frameNumber}))};
    }''')
