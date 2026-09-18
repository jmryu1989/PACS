# coding: utf-8
"""TEST-MIP-OUTPUT-DOM (A11-OUTPUT-1): Print Saved Images for a saved version 12 MIP Viewer Job and every frame of a version 13 MIP
Batch Job, rebuilt from freshly read, digest-verified CT pixels under analytic cameras in a private print engine, all or nothing."""
import copy,io,json,math,os,time,unittest,uuid
from pathlib import Path
from urllib.parse import urlsplit
import numpy as np
from pypdf import PdfReader
from playwright.sync_api import expect
import test_prior_selection as ct
from test_volume_mip import VOI_STUDIES,VOI_CASES,VOI_DELTA,VOI_DISCRIMINATION,SOURCE_PLANES,BLENDS,SPACING,COUNTS,mm_text,rodrigues,voi_plan,voi_planes,voi_record
from test_volume_mip_job import CAPTURE,LAYOUT,SESSION_END
from test_volume_mip_batch import BATCH_HELPERS,SIZE,VolumeMipBatchE2E,any_case_probes,canvas_point,ray_orientation,recipe_of
from test_volume_path import field_differences

# scripts/run-tests.py accepts only cases whose class is declared in the selected module; load_tests selects exactly these, so the
# inherited MIP Viewer, VOI Slab, MIP Job, MIP Batch, projection and orientation cases stay out of this bounded profile.
MIP_OUTPUT_CASES=('test_mip_output_01_v12_v13_fresh_pixel_frames_pdf_identity',
                  'test_mip_output_02_readiness_delay_failure_missing_tool_cancel_no_partial_page',
                  'test_mip_output_03_source_access_order_session')
# C4: the pinned MPR_CAMERA_VALUES as literals. Every expected camera below is computed from these and the synthetic geometry only;
# one assertion proves the page holds exactly these values. Axial and sagittal are the values the hosted runtime matched (ci-01). The
# coronal [0,1,0] of the orientation DOM stub (tests/viewer_volume_orientation_dom_test.py) only names a plane axis and is not the pinned
# value. The coronal literal follows from the axial one, not from the page: with screen right = viewUp x viewPlaneNormal (canvas_point),
# axial [0,-1,0] x [0,0,-1] = [1,0,0] shows patient left on screen right with anterior up. A coronal view in that same convention
# (superior up, patient left on screen right) needs [0,0,1] x n = [1,0,0], so n = [0,-1,0]: the camera stands anterior to the patient,
# as the product's own VR Anterior view does (volume-rendering.js: [0,-1,0],[0,0,1]). [0,1,0] would show patient left on screen left.
AXIAL,SAGITTAL,CORONAL=([0,0,-1],[0,-1,0]),([1,0,0],[0,0,1]),([0,-1,0],[0,0,1])
LITERALS={'Axial':AXIAL,'Sagittal':SAGITTAL,'Coronal':CORONAL}
# The known-voxel phantom (test_volume_mip.mip_phantom): world = (column x 0.5, row x 0.5, slice x 2.5) mm, identity index axes.
CORNERS=[(i*SPACING[0],j*SPACING[1],k*SPACING[2]) for i in (0,COUNTS[0]-1) for j in (0,COUNTS[1]-1) for k in (0,COUNTS[2]-1)]
FOCAL=[sum(corner[k] for corner in CORNERS)/8 for k in range(3)]
DISTANCE=min(1000,math.hypot(*[(n-1)*s for n,s in zip(COUNTS,SPACING)]))
MESSAGES={'load':'출력 화면을 불러오지 못했습니다. 다시 누르세요.','pre':'MIP 출력 준비 렌더를 확인하지 못했습니다.','frame':'MIP 출력 프레임의 최종 렌더를 확인하지 못했습니다.',
 'outer':'MIP 출력 준비 시간이 지났습니다. 다시 확인하세요.','clip':'MIP 출력 투영 깊이 범위를 확인하지 못했습니다.','display':'MIP 출력 표시 속성을 확인하지 못했습니다.',
 'gpu':'MIP 출력 셰이더를 GPU에서 확인하지 못했습니다.','average_shader':'MIP 출력 Raysum 평균 셰이더를 확인하지 못했습니다.','plane':'MIP 출력의 VOI Slab 평면을 적용하지 못했습니다.',
 'image':'MIP 출력 영상을 만들지 못했습니다.','memory':'MIP 출력 영상 용량 한도(32 MiB)를 초과했습니다.','context':'MIP 출력 GPU 문맥이 사라져 출력하지 않았습니다.',
 'size':'MIP 출력 영상 크기를 확인하지 못했습니다.','capability':'고정 뷰어에서 MIP 출력 기능을 확인하지 못했습니다.','average':'Raysum 평균 계산 모듈을 확인할 수 없어 출력하지 않았습니다.',
 'capacity':'출력 CT 원본은 최대 256장까지 지원합니다.','mid_read':'출력 준비 중 원본이 변경되었습니다.','digest':'저장 당시 전체 원본과 달라 출력하지 않았습니다.',
 'frame_of_reference':'저장한 MIP 작업의 좌표계(Frame of Reference)가 출력 원본과 달라 출력하지 않았습니다.','outside':'저장한 VOI Slab이 출력 CT 볼륨과 겹치지 않아 출력하지 않았습니다.',
 'reproduce':'MIP 작업의 계산 방식을 이 뷰어가 재현할 수 없어 출력하지 않았습니다.','shape':'저장한 MIP 작업의 형식을 확인할 수 없어 출력하지 않았습니다.',
 'ready':'미리보기 내용을 확인','source_read':'출력 원본을 읽지 못했습니다. 다시 확인하세요.'}
NOTE='저장한 조건과 전체 CT 원본으로 다시 계산한 출력입니다 · 화면 미리보기가 아닙니다 · 실제 크기 아님 · 조작성 평가 가능·진단 품질 미검증'
MODELS='()=>[typeof window.KinVolumeMip,typeof window.KinVolumeMipJob,typeof window.KinVolumeMipBatch,typeof window.KinVolumeMipOutput,typeof window.kinRenderVolumeMipPrint,typeof window.kinCreateVolumeMip]'
PRESET_VALUES="()=>Object.fromEntries(['axial','sagittal','coronal'].map(k=>[k,[Array.from(cornerstone.CONSTANTS.MPR_CAMERA_VALUES[k].viewPlaneNormal),Array.from(cornerstone.CONSTANTS.MPR_CAMERA_VALUES[k].viewUp)]]))"
WAIT_STATUS="()=>{const t=document.querySelector('#kin-job-print [role=status]')?.textContent;return !!t&&t!=='저장한 영상 상태를 확인하는 중…'}"
NO_LEAKS="()=>{const l=printLeaks();return !l.elements&&!l.volumes&&!l.images&&!l.engines}"
TAKE='()=>({frames:printFrames.splice(0),events:printEvents.splice(0),volumeInfo:printVolumeInfo.splice(0),faults:printFault.splice(0)})'
# The browser's own messages for a request rejected in transport (fetch) or a body cut in transport (body read).
TRANSPORT_TEXTS=('Failed to fetch','network error')
TRACE_COUNTS='()=>window.printReady?{enables:printEnables,faults:printFault.length,held:printHeld}:null'
# Installed once per page, before or after the MIP models load (a fresh page loads them inside the print). It only records, except
# where a test arms one of its hooks:
# - KinVolumeMip.verifyState is traced only from the print frame stack, with the private viewport's camera, pinned clipping range,
#   display properties and canvas read in that same rendered event (H-C1, H-C3);
# - the print viewport's blend writes, its rendered events and the average patch are recorded in one ordered list (B2, H-B2);
# - printHoldAt holds that print rendered event (1 = the first after enableElement) and every later one;
# - printViewFault(viewport, engine) runs once on each new print viewport, printAfterVerify(count, viewport) after each traced frame;
# - the kin-batch-print-* images and volumes put into the cache are listed so printLeaks() can prove they were removed.
PRINT_TRACE="""()=>{if(window.printReady)return true;window.printReady=true;
 window.printTrace=()=>{const limit=Error.stackTraceLimit;Error.stackTraceLimit=40;const stack=new Error().stack;Error.stackTraceLimit=limit;return stack};
 window.printFrames=[];window.printEvents=[];window.printVolumeInfo=[];window.printFault=[];window.printHoldAt=null;window.printHeld=0;window.printRenders=0;window.printEnables=0;window.printTracing=false;
 window.printViewFault=null;window.printAfterVerify=null;window.printImages=[];window.printVolumes=[];
 window.printView=()=>{for(const engine of cornerstone.getRenderingEngines?.()||[])for(const vp of engine.getViewports())if(vp.id.startsWith('kin-batch-print-'))return vp;return null};
 window.printLeaks=()=>({elements:document.querySelectorAll('[data-kin-batch-print-render]').length,volumes:printVolumes.filter(id=>cornerstone.cache.getVolume(id)).length,
  images:printImages.filter(id=>cornerstone.cache.getImageLoadObject(id)).length,engines:(cornerstone.getRenderingEngines?.()||[]).filter(e=>String(e.id).startsWith('kin-batch-print-')).length});
 const copy=v=>Array.from(v||[]);
 for(const [method,list] of [['putImageSync',printImages],['putVolumeSync',printVolumes]]){const fn=cornerstone.cache[method];cornerstone.cache[method]=function(id,...args){if(String(id).startsWith('kin-batch-print-'))list.push(id);return fn.call(this,id,...args)}}
 const wrap=model=>{if(!model||model.__kinPrintTrace)return;const real=model.verifyState;model.__kinPrintTrace=real;
  model.verifyState=function(state,expected){const problem=real.call(this,state,expected);
   if(printTrace().includes('verifyPrintFrame')){printTracing=true;
    try{const vp=printView(),cam=vp?.getCamera(),canvas=vp?.getCanvas(),p=vp?.getProperties?.()||{};let range=null;try{range=copy(vp.getVtkActiveCamera().getClippingRange())}catch(_){range=null}
     printFrames.push({problem,id:vp?.id||'',canvas:canvas?[canvas.width,canvas.height]:null,range,cameraRange:cam?.clippingRange?copy(cam.clippingRange):null,
      display:{VOILUTFunction:p.VOILUTFunction??null,invert:p.invert??null,colormap:p.colormap?.name??null,voiRange:p.voiRange?{lower:p.voiRange.lower,upper:p.voiRange.upper}:null},
      state:{actors:state.actors,volumeId:state.volumeId,blend:state.blend,viewPlaneNormal:copy(state.viewPlaneNormal),viewUp:copy(state.viewUp),planes:(state.planes||[]).map(q=>[copy(q.origin),copy(q.normal)]),sampleDistance:state.sampleDistance,interpolationType:state.interpolationType,voiRange:{lower:state.voiRange?.lower,upper:state.voiRange?.upper}},
      expected:{volumeId:expected.volumeId,blend:expected.blend,viewPlaneNormal:copy(expected.viewPlaneNormal),viewUp:copy(expected.viewUp),thickness:expected.thickness,sampleDistance:expected.sampleDistance,voiSlab:!!expected.voiSlab},
      camera:cam&&{focalPoint:copy(cam.focalPoint),position:copy(cam.position),viewPlaneNormal:copy(cam.viewPlaneNormal),viewUp:copy(cam.viewUp),parallelScale:cam.parallelScale}});
     printEvents.push('verify');if(typeof printAfterVerify==='function')printAfterVerify(printFrames.length,vp)}
    finally{printTracing=false}}
   return problem}};
 if(window.KinVolumeMip)wrap(window.KinVolumeMip);
 else{let held;Object.defineProperty(window,'KinVolumeMip',{configurable:true,enumerable:true,get:()=>held,set:value=>{wrap(value);held=value}})}
 const average=window.kinPrepareVolumeAverage;
 if(typeof average==='function')window.kinPrepareVolumeAverage=function(...args){if(printTrace().includes('kinRenderVolumeMipPrint'))printEvents.push('average');return average.apply(this,args)};
 document.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED,e=>{if(!e.target?.dataset?.kinBatchPrintRender)return;printRenders++;
  if(printHoldAt!==null&&printRenders>=printHoldAt){e.stopImmediatePropagation();printHeld++;printEvents.push('held');return}
  printEvents.push('rendered')},true);
 const enable=cornerstone.RenderingEngine.prototype.enableElement;
 cornerstone.RenderingEngine.prototype.enableElement=function(input,...rest){const result=enable.call(this,input,...rest);
  if(input?.element?.dataset?.kinBatchPrintRender){printRenders=0;printEnables++;const vp=this.getViewport(input.viewportId),blend=vp.setBlendMode;
   vp.setBlendMode=function(mode,...more){if(mode===0){let info=null;try{const i=vp.getActors()[0]?.actor?.getMapper?.()?.getScalarTexture?.()?.getVolumeInfo?.();info=i?{scale:i.scale?copy(i.scale):null,offset:i.offset?copy(i.offset):null}:null}catch(error){info={error:String(error)}}printVolumeInfo.push(info)}
    printEvents.push('blend:'+mode);return blend.call(this,mode,...more)};
   if(typeof printViewFault==='function')printViewFault(vp,this)}
  return result};
 return true}"""
# The page as printed: every image decoded and read whole (FNV-1a over RGBA, the MIP Batch helper), and RGB read at this test's probes.
PAGE_FRAMES="""async(images,probes)=>Promise.all(images.map(async(img,i)=>{await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
 const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(const b of data)hash=Math.imul(hash^b,16777619);
 return {width:c.width,height:c.height,hash:hash>>>0,pixels:(probes[i]||[]).map(([x,y])=>{const o=(y*c.width+x)*4;return [data[o],data[o+1],data[o+2]]})}}))"""
# Frame-read holds in the print loader: every frame body read waits while fetchHold is on, and records its own abort signal.
FETCH_HOLD="""()=>{if(window.printFetch)return true;window.printFetch=window.fetch;window.fetchHold=false;window.fetchHeld=[];
 window.fetch=async(...args)=>{const response=await printFetch(...args);if(fetchHold&&String(args[0]).includes('/frames/0/image-'))await new Promise(resolve=>fetchHeld.push({resolve,signal:args[1]?.signal}));return response};return true}"""
RELEASE='()=>{fetchHold=false;for(const held of fetchHeld.splice(0))held.resolve()}'
# Readback faults, each on its own named print step only, so the traced state beside it stays the real one.
RANGE_FAULT="""value=>{window.printViewFault=vp=>{const real=vp.getVtkActiveCamera;vp.getVtkActiveCamera=function(...args){const camera=real.apply(this,args);if(!printTrace().includes('printDepthRange'))return camera;
 printFault.push('range');return {getClippingRange:()=>value==null?undefined:value.map(n=>n==='NaN'?NaN:n)}}};return true}"""
DISPLAY_FAULT="""change=>{window.printViewFault=vp=>{const real=vp.getProperties;vp.getProperties=function(...args){const value=real.apply(this,args);if(!printTrace().includes('printDisplay'))return value;
 printFault.push('display');const next={...value,...change};for(const key of Object.keys(change))if(change[key]==='__missing__')delete next[key];return next}};return true}"""
SHADER_FAULT="""kind=>{window.printViewFault=(vp,engine)=>{const key='offscreenMultiRenderWindow',own=Object.getOwnPropertyDescriptor(engine,key);let real=engine[key];if(!real)return;
 const restore=()=>{if(!own)delete engine[key];else Object.defineProperty(engine,key,'value' in own?{...own,value:real}:own)};
 const program=node=>{const p=node.get('tris').tris.getProgram();return {getCompiled:()=>p.getCompiled(),getLinked:()=>kind==='unlinked'?false:p.getLinked(),
  getFragmentShader:()=>kind==='average'?{getSource:()=>p.getFragmentShader().getSource().split('kinAverageSamples += 1.0;').join('')}:p.getFragmentShader()}};
 const wrapped={getOpenGLRenderWindow:(...a)=>{const gl=real.getOpenGLRenderWindow(...a);return {getContext:(...b)=>gl.getContext(...b),getViewNodeFor:(...b)=>{const node=gl.getViewNodeFor(...b);return {get:()=>({tris:{getProgram:()=>program(node)}})}}}}};
 Object.defineProperty(engine,key,{configurable:true,enumerable:own?own.enumerable:false,get(){if(!printTrace().includes('printShaderProblem'))return real;restore();printFault.push('shader:'+kind);return wrapped},set(value){real=value}})};return true}"""
# vtk's addClippingPlane answers false for an object that is not a vtkPlane; the plane factory hands exactly one such object to the print.
PLANE_FAULT="""()=>{"use strict";const model=window.KinVolumeMip,real=model.voiPlane;
 model.voiPlane=function(definition){if(!printTrace().includes('writePrintFrame'))return real.call(this,definition);model.voiPlane=real;printFault.push('plane');return Object.freeze({...real.call(this,definition),isA:()=>false})};return model.voiPlane!==real}"""
BLOB_FAULT="""kind=>{const real=HTMLCanvasElement.prototype.toBlob;
 HTMLCanvasElement.prototype.toBlob=function(callback,...rest){if(!this.closest?.('[data-kin-batch-print-render]'))return real.call(this,callback,...rest);HTMLCanvasElement.prototype.toBlob=real;printFault.push('blob:'+kind);
  if(kind==='null')callback(null);else callback(new Blob([new Uint8Array(33*1024*1024)],{type:'image/png'}))};return true}"""
# Emulates a device pixel ratio change on frame 2 through the canvas the print reads back; a real ratio change without a resize keeps 512.
CANVAS_FAULT="""()=>{window.printViewFault=vp=>{const real=vp.getCanvas;let reads=0;vp.getCanvas=function(...args){const canvas=real.apply(this,args);
 if(printTracing||!printTrace().includes('verifyPrintFrame')||++reads<2)return canvas;printFault.push('canvas');return {width:Math.round(canvas.width*1.5),height:Math.round(canvas.height*1.5)}}};return true}"""
CONTEXT_FAULT="""()=>{window.printAfterVerify=(count,vp)=>{if(count!==1)return;window.printAfterVerify=null;const gl=vp.getRenderingEngine().offscreenMultiRenderWindow.getOpenGLRenderWindow().getContext();
 printFault.push('context');gl.getExtension('WEBGL_lose_context').loseContext()};return true}"""
RANGE_API_FAULT="""()=>{window.printViewFault=vp=>{const real=vp.getVtkActiveCamera;vp.getVtkActiveCamera=function(...args){const camera=real.apply(this,args);if(!printTrace().includes('printCapabilities'))return camera;printFault.push('range-api');return {}}};return true}"""
MAPPER_API_FAULT="""()=>{window.printViewFault=vp=>{const real=vp.getActors;vp.getActors=function(...args){const actors=real.apply(this,args);if(!printTrace().includes('printCapabilities'))return actors;printFault.push('mapper-api');
 const mapper=actors[0].actor.getMapper(),partial=Object.fromEntries(['getBlendMode','getClippingPlanes','addClippingPlane','removeClippingPlane','getSampleDistance'].map(k=>[k,(...a)=>mapper[k](...a)]));
 return [{...actors[0],actor:{getMapper:()=>partial}}]}};return true}"""
CLICK_PRINT="i=>{[...document.querySelectorAll('#kin-viewer-jobs button')].filter(b=>b.textContent==='Print Saved Images')[i].onclick()}"
PRINT_POPUP="""()=>{window.heldOpen=window.heldOpen||window.open;window.open=(...args)=>{const w=heldOpen(...args);if(w)w.print=()=>{w.__printCalled=true};return w};return true}"""

def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def print_cameras(orientation,recipe=None):
 # D2 and C5, computed here from the literals: focal point the voxel-centre box centre, D = t = min(1000, diagonal), parallel scale
 # D/2; version 13 turns frame i by sign x i x interval about viewUp (Horizontal) or the screen right viewUp x normal (Vertical).
 n0,u0=LITERALS[orientation]
 def camera(angle,n,u):return {'angle':angle,'focalPoint':list(FOCAL),'position':[f+x*DISTANCE for f,x in zip(FOCAL,n)],'viewPlaneNormal':list(n),'viewUp':list(u),'parallelScale':DISTANCE/2}
 if recipe is None:return [camera(0,n0,u0)]
 right=cross(u0,n0);length=math.hypot(*right);right=[x/length for x in right];axis=u0 if recipe['axis']=='Horizontal' else right;sign=-1 if recipe['reverse'] else 1;cameras=[]
 for i in range(recipe['count']):
  angle=sign*i*recipe['interval'];radians=math.radians(angle)
  cameras.append(camera(angle,rodrigues(n0,axis,radians) if i else list(n0),rodrigues(u0,axis,radians) if i and recipe['axis']=='Vertical' else list(u0)))
 return cameras
def depth_margin(camera):
 # D3: h0 is the largest voxel-centre corner depth from the focal plane, e the projected half voxel on the identity index axes.
 n=camera['viewPlaneNormal'];h0=max(abs(sum((f-c)*k for f,c,k in zip(FOCAL,corner,n))) for corner in CORNERS)
 return min(h0+.5*sum(s*abs(k) for s,k in zip(SPACING,n))+1e-6,DISTANCE/2)
def scripts_of(requests):return [url.split('?')[0].rsplit('/',1)[1] for method,url in requests if '/worklist/hpacs-lite/' in url and url.split('?')[0].endswith('.js')]
# The print loader's source reads (viewer-volume-job-print.js), one predicate each. The page's request log and the browser's own
# failure log are filtered with exactly the same test on both sides, so a rejection is never counted against a differently selected
# set of requests.
def is_frame_read(method,url):return '/frames/0/image-' in url
def is_lookup_read(method,url):return method=='POST' and url.split('?')[0].endswith('/api/dicom/lookup')
def is_tags_read(method,url):return method=='GET' and url.split('?')[0].endswith('/simplified-tags')
SOURCE_READS=(('frame',is_frame_read),('lookup',is_lookup_read),('tags',is_tags_read))
INJECTED_READ={'/api/dicom/lookup':'lookup','/simplified-tags':'tags'}
# The guarded path's rule, reused: more than three transport rejections in one case is not an isolated transport event.
TRANSPORT_CEILING=3
def transport_accounting(requests,failures,sent,fragment,times,count):
 # One ready sub-case of the injected-rejection loop, accounted against the browser's own requestfailed records instead of assuming
 # the browser rejected nothing of its own. The loader reads each of the count instances once; the only requests beyond that are one
 # resend of each read this page reported as failed, injected (times, on fragment's category) or natural. ERR_ABORTED is a print's
 # own cancel and is never subtracted, so an aborted and reissued read stays red; a missing failure record drives that category's
 # natural count below zero, so a dead or late listener is red too, never green. Pure: no page, no clock, no I/O.
 reads={name:[url for method,url in requests if match(method,url)] for name,match in SOURCE_READS}
 failed={name:[e for e in failures if e['error'] and 'ERR_ABORTED' not in e['error'] and match(e['method'],e['url'])] for name,match in SOURCE_READS}
 injected=INJECTED_READ[fragment];natural={name:len(rejects)-(times if name==injected else 0) for name,rejects in failed.items()}
 total=sum(natural.values());problems=[]
 for name,value in sorted(natural.items()):
  if value<0:problems.append(f'{name}: {len(failed[name])} failure records for {times if name==injected else 0} injected rejections')
 if total>TRANSPORT_CEILING:problems.append(f'{total} natural transport rejections in one sub-case is not an isolated transport event')
 frames,rejected=reads['frame'],[e['url'] for e in failed['frame']]
 if len(set(frames))!=count:problems.append(f'frame: {len(set(frames))} distinct reads, not {count}')
 if len(frames)!=count+natural['frame']:problems.append(f'frame: {len(frames)} requests for {count} instances and {natural["frame"]} rejections')
 for url in sorted(set(frames)|set(rejected)):
  if rejected.count(url)>1 or frames.count(url)!=(2 if url in rejected else 1):problems.append(f'frame: {url} rejected {rejected.count(url)}x, requested {frames.count(url)}x')
 if len(reads['lookup'])!=count+(times if injected=='lookup' else 0)+natural['lookup']:
  problems.append(f'lookup: {len(reads["lookup"])} requests for {count} instances, {times if injected=="lookup" else 0} injected and {natural["lookup"]} natural rejections')
 sends=count+times+natural['lookup'] if injected=='lookup' else times+1
 if not sent:problems.append('the injected rejection never fired')
 elif sent.count(sent[0])!=sends:problems.append(f'{sent.count(sent[0])} sends of the injected read, not {sends}')
 # Reported whenever the browser rejected anything beyond the injected rejections, or anything did not add up: method, url and the
 # browser's own error text of every failure in the window that was not a print's own cancel, so the next incident stays
 # attributable. The reads this accounting does not total (the two attachments/dicom/info reads per instance) are in it too.
 reported=[{'method':e['method'],'url':e['url'],'error':e['error']} for e in failures if e['error'] and 'ERR_ABORTED' not in e['error']]
 report={'fragment':fragment,'times':times,'natural':natural,'reads':{name:len(urls) for name,urls in reads.items()},'sends':len(sent),
  'problems':problems,'failed':reported,'aborted':sum(1 for e in failures if e['error'] and 'ERR_ABORTED' in e['error'])} if total or problems or len(reported)>times else None
 return problems,report

class VolumeMipOutputE2E(VolumeMipBatchE2E):
 def print_index(self,a,title):return next(i for i,row in enumerate(self.jobs(a)) if row['title']==title)
 def close_output(self,page):
  if page.locator('#kin-job-print[open]').count():page.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();expect(page.locator('#kin-job-print')).not_to_be_visible()
 def print_titled(self,page,a,title):
  self.close_output(page);page.evaluate("()=>{const s=document.querySelector('#kin-job-print [role=status]');if(s)s.textContent=''}")
  page.locator('#kin-viewer-jobs').get_by_role('button',name='Print Saved Images',exact=True).nth(self.print_index(a,title)).click()
 def watch_transport(self,page):
  # Request failures as the browser reports them. ERR_ABORTED entries are a print's own cancels (bounded() aborts every read still in
  # flight once a print ends), so they never count as transport evidence.
  logs=self.__dict__.setdefault('transport_logs',{})
  if page not in logs:
   log=logs[page]=[]
   page.on('requestfailed',lambda r:log.append({'method':r.method,'url':r.url,'error':r.failure}))
  return logs[page]
 def attempt_output(self,page,start,expected,timeout,rearm):
  status,log,origin=page.locator('#kin-job-print [role=status]'),self.watch_transport(page),urlsplit(page.url).netloc
  for attempt in (1,2):
   mark,before=len(log),page.evaluate(TRACE_COUNTS)
   start();page.wait_for_function(WAIT_STATUS,timeout=timeout)
   text=(status.text_content() or '').strip()
   if text not in TRANSPORT_TEXTS:break
   page.wait_for_timeout(300);after=page.evaluate(TRACE_COUNTS)
   failed=[e for e in log[mark:] if e['error'] and 'ERR_ABORTED' not in e['error'] and urlsplit(e['url']).netloc==origin and urlsplit(e['url']).path.startswith(('/api/','/instances/'))]
   print('MIP_OUTPUT_TRANSPORT_FAILURE',json.dumps({'attempt':attempt,'status':text,'failed':failed,'trace_before':before,'trace_after':after}),flush=True)
   # ci-01 NO2: a same-origin source read was rejected in transport (the proxy never logged it) while the shared loader ran, before any
   # private print viewport existed. Only such a rejection, with the browser's own failure record, no print viewport created, no
   # injected fault fired and no render held, is attempted once more. The failed attempt must itself have left no page and no leak,
   # and the next attempt must give the row's own exact outcome; any other status, or a second rejection, fails the row as it is.
   if attempt==2 or not failed or before is None or after is None or after!=before:break
   self.refused(page,text);self.transport_reattempts=getattr(self,'transport_reattempts',0)+1
   self.assertLessEqual(self.transport_reattempts,TRANSPORT_CEILING,'more than three transport rejections in one case is not an isolated transport event')
   if rearm:rearm()
  if expected:expect(status).to_contain_text(expected,timeout=1000)
  return page.frame_locator('#kin-job-print iframe')
 def open_output(self,page,a,title,expected=MESSAGES['ready'],timeout=300000,rearm=None):
  return self.attempt_output(page,lambda:self.print_titled(page,a,title),expected,timeout,rearm)
 def refresh_output(self,page,expected=MESSAGES['ready'],timeout=300000,rearm=None):
  return self.attempt_output(page,lambda:page.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click(),expected,timeout,rearm)
 def refused(self,page,message):
  # D12/O5: a refusal leaves no printable page, Print disabled, and no private print element, image, volume or engine.
  dialog=page.locator('#kin-job-print');expect(dialog.locator('[role=status]')).to_contain_text(message,timeout=1000);self.assertNotIn(MESSAGES['ready'],dialog.locator('[role=status]').text_content())
  expect(dialog.get_by_role('button',name='인쇄 / PDF',exact=True)).to_be_disabled();self.assertEqual(page.evaluate("()=>document.querySelector('#kin-job-print iframe').srcdoc"),'')
  page.wait_for_function(NO_LEAKS,timeout=10000)
 def page_shots(self,paper,points):return paper.locator('.cell img').evaluate_all(PAGE_FRAMES,points)
 def assert_fresh_reads(self,requests,count):
  # O1/MO1: the page was computed from fresh reads, one lookup and one frame body per saved original instance.
  lookups=[url for method,url in requests if is_lookup_read(method,url)];frames=[url for method,url in requests if is_frame_read(method,url)]
  self.assertEqual([len(lookups),len(frames)],[count,count],(lookups[:2],frames[:2]));requests.clear()
 def print_native(self,frames,cameras,record,voi,mode,label):
  self.assertEqual(len(frames),len(cameras),(label,[frame['problem'] for frame in frames]))
  for i,(frame,want) in enumerate(zip(frames,cameras)):
   tag=f'{label} frame {i}';camera,state=frame['camera'],frame['state']
   self.assertEqual(frame['problem'],'',tag);self.assertTrue(frame['id'].startswith('kin-batch-print-'),tag);self.assertEqual(frame['canvas'],[SIZE,SIZE],tag)
   self.assertEqual([state['actors'],state['volumeId'],frame['expected']['volumeId']],[1,frame['id'],frame['id']],tag)
   # O2/MO3/MO4/MO7: the read-back camera against the literal-derived one, every component within 1e-6.
   for key in ('focalPoint','position','viewPlaneNormal','viewUp'):np.testing.assert_allclose(camera[key],want[key],atol=1e-6,rtol=0,err_msg=tag+' '+key)
   self.assertAlmostEqual(camera['parallelScale'],want['parallelScale'],delta=1e-6,msg=tag)
   np.testing.assert_allclose(state['viewPlaneNormal'],want['viewPlaneNormal'],atol=1e-6,rtol=0,err_msg=tag);np.testing.assert_allclose(state['viewUp'],want['viewUp'],atol=1e-6,rtol=0,err_msg=tag)
   np.testing.assert_allclose(frame['expected']['viewPlaneNormal'],want['viewPlaneNormal'],atol=1e-6,rtol=0,err_msg=tag+' expected')
   self.assertAlmostEqual(frame['expected']['thickness'],DISTANCE,delta=1e-6,msg=tag);self.assertEqual(frame['expected']['voiSlab'],bool(record),tag)
   # O3/MO2/MO6: blend, sampling, interpolation and the saved range, the whole-volume slab facing this frame, the VOI Slab planes in LPS.
   self.assertEqual(state['blend'],BLENDS[mode],tag);self.assertAlmostEqual(state['sampleDistance'],sum(SPACING)/6,delta=1e-9,msg=tag);self.assertEqual(state['interpolationType'],0,tag)
   self.assertAlmostEqual(state['voiRange']['lower'],voi[0],delta=1e-6,msg=tag);self.assertAlmostEqual(state['voiRange']['upper'],voi[1],delta=1e-6,msg=tag)
   planes=state['planes'];self.assertEqual(len(planes),4 if record else 2,tag)
   for _,normal in planes[:2]:self.assertAlmostEqual(abs(float(np.dot(normal,want['viewPlaneNormal']))),1,delta=1e-6,msg=tag)
   self.assertAlmostEqual(math.dist(planes[0][0],planes[1][0]),DISTANCE,delta=1e-6,msg=tag)
   middle=[(p+q)/2 for p,q in zip(planes[0][0],planes[1][0])];self.assertAlmostEqual(float(np.dot(np.subtract(middle,FOCAL),want['viewPlaneNormal'])),0,delta=1e-6,msg=tag)
   for (origin,normal),(want_origin,want_normal) in zip(planes[2:],voi_planes(record) if record else []):
    np.testing.assert_allclose(origin,want_origin,atol=1e-6,rtol=0,err_msg=tag);np.testing.assert_allclose(normal,want_normal,atol=1e-6,rtol=0,err_msg=tag)
   # H-C3/MO6b: the explicit display reads back on the private orthographic viewport.
   display=frame['display'];self.assertEqual([display['VOILUTFunction'],display['invert'],display['colormap']],['LINEAR',False,'Grayscale'],tag)
   self.assertAlmostEqual(display['voiRange']['lower'],voi[0],delta=1e-6,msg=tag);self.assertAlmostEqual(display['voiRange']['upper'],voi[1],delta=1e-6,msg=tag)
   # H-C1: the pinned vtk camera clipping range against the D3 bound computed here.
   self.assertIsNotNone(frame['range'],tag);self.assertEqual(len(frame['range']),2,tag);near,far=frame['range'];margin=depth_margin(want)
   self.assertTrue(math.isfinite(near) and math.isfinite(far) and near<far,(tag,frame['range']))
   self.assertLessEqual(near,DISTANCE-margin,(tag,frame['range'],margin));self.assertGreaterEqual(far,DISTANCE+margin,(tag,frame['range'],margin))
 def assert_order(self,events,blend,count):
  # B2/O11/MO10: Raysum renders once at blend 0, patches the average and switches to blend 3 before its first frame, which is not that render.
  self.assertEqual(events.count('verify'),count,events);self.assertNotIn('held',events)
  if blend==3:
   first=events.index('blend:0');rendered=events.index('rendered',first);average=events.index('average');switched=events.index('blend:3')
   self.assertTrue(first<rendered<average<switched<events.index('verify'),events);self.assertEqual(events.count('average'),1,events)
   self.assertEqual(events[first:average].count('rendered'),1,events);self.assertNotIn('verify',events[:switched],events)
  else:
   self.assertNotIn('blend:0',events);self.assertNotIn('average',events);self.assertLess(events.index('blend:'+str(blend)),events.index('verify'),events)
 def print_pixels(self,shots,probe_sets,label,expected='expected'):
  for i,(shot,probes) in enumerate(zip(shots,probe_sets)):
   self.assertEqual([shot['width'],shot['height']],[SIZE,SIZE],(label,i))
   if probes is None:continue
   self.assertTrue(probes,(label,i,'the known-voxel oracle has no probe on this ray'));self.assertEqual(len(shot['pixels']),len(probes),(label,i))
   for probe,rgb in zip(probes,shot['pixels']):
    self.assertEqual([rgb[0],rgb[0]],[rgb[1],rgb[2]],(label,i,'grayscale',rgb));self.assertGreaterEqual(probe['separation'],VOI_DISCRIMINATION,probe)
    wanted=[probe['expected']] if expected=='expected' else probe['unclipped']
    self.assertLessEqual(min(abs(rgb[0]-w) for w in wanted),VOI_DELTA,(label,i,expected,probe,rgb))
 def fresh_page(self,a,rows):
  page=self.login();self.launch(page,[a]);self.ready(page)
  expect(page.locator('#kin-viewer-jobs').get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(rows,timeout=60000);return page

 def test_mip_output_01_v12_v13_fresh_pixel_frames_pdf_identity(self):
  study,intercept,voi=VOI_STUDIES[0];plan=voi_plan();_,_,oblique=VOI_CASES;record=voi_record(oblique)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();p.locator('#findings').fill('KEEP MIP OUTPUT REPORT');v.evaluate(BATCH_HELPERS)
  dialog=self.open_voi(v);thickness=mm_text(record['thickness']);label='VOI Slab · On · '+thickness+' mm · ';summary=dialog.locator('.kin-mip-voi-state')
  V13,V12,OFF='MIP output v13 Raysum','MIP output v12 Raysum','MIP output v13 MinIP off'
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,oblique)),'MIP','Axial',record,voi)
  mark=self.mark(v);self.choose_mip(dialog,'Raysum','Coronal');self.job_final(v,mark,'Raysum','Coronal')
  raysum=recipe_of('Horizontal',90,4);self.batch_inputs(dialog,'Horizontal',90,4);self.make(v,dialog,4);self.save_titled(dialog,V13,label+'Saved')
  # The same confirmed block without its preview saves as version 12 (the MIP Batch Clear rule).
  self.batch_button(dialog,'Clear MIP Batch').click();expect(summary).to_have_text(label+'Not Saved');self.save_titled(dialog,V12,label+'Saved')
  mark=self.mark(v);self.voi_button(dialog,'Reset VOI').click();self.settled(v,mark);mark=self.mark(v);self.choose_mip(dialog,'MinIP','Sagittal');self.job_final(v,mark,'MinIP','Sagittal')
  minip=recipe_of('Vertical',45,3,True);self.batch_inputs(dialog,'Vertical',45,3,True);self.make(v,dialog,3);self.save_titled(dialog,OFF,'VOI Slab · Off · Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  titles=(V13,V12,OFF);saved={title:self.mip_job(a,title) for title in titles}
  self.assertEqual([saved[title][0]['snapshotVersion'] for title in titles],[13,12,13])
  self.assertEqual(field_differences(saved[V13][1]['snapshot']['mip'],saved[V12][1]['snapshot']['mip']),[],'one confirmed block, saved with and without its recipe')
  self.assertEqual([saved[V13][1]['snapshot']['mipBatch'],saved[OFF][1]['snapshot']['mipBatch']],[raysum,minip])
  jobs_panel=v.locator('#kin-viewer-jobs');expect(jobs_panel).to_contain_text('MIP Batch · 회전 투영 재구성 출력 · 표시 조건 작업');expect(jobs_panel).to_contain_text('MIP Viewer · 저장 조건 재구성 출력 · 표시 전용 투영 작업')
  expect(jobs_panel.get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(3)
  # B1/MO11: a fresh browser that never opened the MIP Viewer holds no MIP model before its print loads them.
  fresh=self.fresh_page(a,3);self.assertEqual(fresh.evaluate(MODELS),['undefined']*6)
  # C4/H-C4: the runtime presets are exactly the literals every expected camera is computed from.
  self.assertEqual(fresh.evaluate(PRESET_VALUES),{'axial':[AXIAL[0],AXIAL[1]],'sagittal':[SAGITTAL[0],SAGITTAL[1]],'coronal':[CORONAL[0],CORONAL[1]]})
  self.assertEqual(FOCAL,[15.75,15.75,40.0]);fresh.evaluate(PRINT_TRACE);requests=[];fresh.on('request',lambda r:requests.append((r.method,r.url)))
  # A print attempted again after a transport rejection keeps the page's script loads but not the rejected attempt's partial reads.
  def keep_scripts():requests[:]=[entry for entry in requests if '/worklist/hpacs-lite/' in entry[1]]
  layout,planes=fresh.evaluate(LAYOUT),fresh.evaluate(SOURCE_PLANES);timings={};status=fresh.locator('#kin-job-print [role=status]');heading=fresh.locator('#kin-job-print h2')
  # (1) Version 13 VOI on, Raysum x Coronal, Horizontal 90 x 4: four frames, the B2 order traced, known voxels on every frame.
  started=time.monotonic();paper=self.open_output(fresh,a,V13,rearm=keep_scripts);timings['v13_raysum_4_frames_s']=round(time.monotonic()-started,3)
  self.assertLess(timings['v13_raysum_4_frames_s'],120+4*15,'D8 bound of a four-frame version 13 print')
  self.assertTrue({'viewer-job-print.js','viewer-volume-job-print.js','volume-mip.js','volume-mip-job.js','volume-mip-batch.js','volume-mip-output.js','viewer-volume-mip-print.js'}<=set(scripts_of(requests)),scripts_of(requests))
  self.assertNotIn('viewer-volume-mip.js',scripts_of(requests),'the MIP Viewer dialog is never loaded to print')
  expect(heading).to_have_text('Saved MIP Batch Output');expect(paper.locator('[data-mip-frame]')).to_have_count(4)
  trace=fresh.evaluate(TAKE);cameras=print_cameras('Coronal',raysum)
  self.print_native(trace['frames'],cameras,record,voi,'Raysum','v13 Raysum');self.assert_order(trace['events'],3,4)
  rays=[ray_orientation(camera['viewPlaneNormal']) for camera in cameras];self.assertEqual(rays,['Coronal','Sagittal','Coronal','Sagittal'])
  probe_sets=[plan[(study,'oblique',ray,'Raysum')] for ray in rays];points=[[canvas_point(probe['world'],camera) for probe in probes] for probes,camera in zip(probe_sets,cameras)]
  shots=self.page_shots(paper,points);self.print_pixels(shots,probe_sets,'v13 Raysum');hashes=[shot['hash'] for shot in shots];self.assertNotEqual(hashes[0],hashes[1],'a quarter turn is another image')
  expect(paper.locator('.mip-caption')).to_have_text([f'Frame {i+1} / 4 · Raysum · Coronal · Horizontal {angle} · VOI Slab {thickness} mm · 512 × 512' for i,angle in enumerate(('0°','+90°','+180°','+270°'))])
  expect(paper.locator('.mip-display')).to_have_text([f'VOI {voi[0]} ~ {voi[1]} (LINEAR) · Normal grayscale']*4)
  text=paper.locator('main').inner_text();self.assertNotIn('W/L',text)
  for part in (NOTE,saved[V13][0]['id'],'33 original CT instances','Reconstructed display · no original SOP for this image','Horizontal · Interval 90° · Forward'):self.assertIn(part,text)
  self.assert_fresh_reads(requests,33)
  hosted={'v13_raysum':{'volume_info_at_pre_render':trace['volumeInfo'],'ranges':[frame['range'] for frame in trace['frames']],'camera_ranges':[frame['cameraRange'] for frame in trace['frames']],'display':trace['frames'][0]['display']}}
  # (4) The same fresh browser recomputes the same pixels: the pinned jitter and the private volume make the page reproducible.
  started=time.monotonic();paper=self.refresh_output(fresh,rearm=keep_scripts);timings['v13_raysum_refresh_s']=round(time.monotonic()-started,3)
  self.assertEqual([shot['hash'] for shot in self.page_shots(paper,points)],hashes);fresh.evaluate(TAKE);self.assert_fresh_reads(requests,33)
  # (3) Version 12 of the same block: its one camera is the version 13 frame 0 readback and its pixels are frame 0's (O4/MO12).
  started=time.monotonic();paper=self.open_output(fresh,a,V12,rearm=keep_scripts);timings['v12_raysum_1_frame_s']=round(time.monotonic()-started,3);self.assertLess(timings['v12_raysum_1_frame_s'],120)
  expect(heading).to_have_text('Saved MIP Viewer Output');expect(paper.locator('[data-mip-frame]')).to_have_count(1)
  single=fresh.evaluate(TAKE);self.print_native(single['frames'],print_cameras('Coronal'),record,voi,'Raysum','v12 Raysum');self.assert_order(single['events'],3,1)
  self.assertEqual(single['frames'][0]['camera'],trace['frames'][0]['camera'],'the version 12 camera is version 13 frame 0 on every component')
  shot=self.page_shots(paper,[points[0]]);self.print_pixels(shot,[probe_sets[0]],'v12 Raysum');self.assertEqual(shot[0]['hash'],hashes[0],'version 12 pixels are version 13 frame 0')
  expect(paper.locator('.mip-caption')).to_have_text(f'MIP Viewer · Raysum · Coronal · VOI Slab {thickness} mm · 512 × 512');self.assertIn(f'Job {saved[V12][0]["id"]} · MIP Viewer · 1 frame',paper.locator('main').inner_text())
  self.assert_fresh_reads(requests,33)
  # (2) Version 13 VOI off, MinIP x Sagittal, Vertical Reverse 45 x 3: the axis-aligned frames keep the unclipped known voxels.
  started=time.monotonic();paper=self.open_output(fresh,a,OFF,rearm=keep_scripts);timings['v13_minip_3_frames_s']=round(time.monotonic()-started,3);self.assertLess(timings['v13_minip_3_frames_s'],120+3*15)
  off=fresh.evaluate(TAKE);off_cameras=print_cameras('Sagittal',minip);self.print_native(off['frames'],off_cameras,None,voi,'MinIP','v13 MinIP');self.assert_order(off['events'],2,3)
  off_rays=[ray_orientation(camera['viewPlaneNormal']) for camera in off_cameras];self.assertEqual(off_rays,['Sagittal',None,'Axial'])
  off_sets=[any_case_probes(plan,study,ray,'MinIP') if ray else None for ray in off_rays]
  off_points=[[canvas_point(probe['world'],camera) for probe in probes] if probes else [] for probes,camera in zip(off_sets,off_cameras)]
  self.print_pixels(self.page_shots(paper,off_points),off_sets,'v13 MinIP','unclipped')
  expect(paper.locator('.mip-caption')).to_have_text([f'Frame {i+1} / 3 · MinIP · Sagittal · Vertical {angle} · VOI Slab Off · 512 × 512' for i,angle in enumerate(('0°','-45°','-90°'))])
  self.assert_fresh_reads(requests,33);hosted['v13_minip']={'ranges':[frame['range'] for frame in off['frames']],'display':off['frames'][0]['display']}
  # The multipage PDF carries each page's identity footer; the unsaved report draft never reaches it.
  fresh.get_by_label('함께 출력할 판독문',exact=True).select_option('saved');fresh.wait_for_function(WAIT_STATUS,timeout=300000);expect(status).to_contain_text(MESSAGES['ready'],timeout=1000)
  fresh.evaluate(TAKE);requests.clear();fresh.evaluate(PRINT_POPUP)
  with fresh.expect_popup() as opened:fresh.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True).click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true',timeout=60000)
  folder=Path(os.environ.get('KIN_EVIDENCE_DIR','../tmp/mip-output'));folder.mkdir(parents=True,exist_ok=True);path=folder/'mip-output.pdf';printed.pdf(path=str(path),prefer_css_page_size=True)
  pdf=PdfReader(path);self.assertGreaterEqual(len(pdf.pages),2);text='\n'.join(page.extract_text() for page in pdf.pages)
  for page in pdf.pages:self.assertIn(a.patient_id,page.extract_text())
  for i in (1,2,3):self.assertEqual(text.count(f'Frame {i} / 3'),1)
  self.assertIn(saved[OFF][0]['id'],text);self.assertNotIn('KEEP MIP OUTPUT REPORT',text);self.assertNotIn('W/L',text);printed.close()
  # O6: nothing was saved or changed: Jobs, report, original DICOM, the fresh viewer's layout and MPR planes.
  self.close_output(fresh);self.assertEqual(fresh.evaluate(LAYOUT),layout);self.assertEqual(fresh.evaluate(SOURCE_PLANES),planes);fresh.wait_for_function(NO_LEAKS,timeout=10000)
  self.assertEqual({title:self.mip_job(a,title) for title in titles},saved);self.assertEqual(len(self.jobs(a)),3)
  expect(p.locator('#findings')).to_have_value('KEEP MIP OUTPUT REPORT');self.assertEqual(len(self.versions(a)),1);self.assertEqual(self.originals(),original)
  print('MIP_OUTPUT_01',json.dumps({'timings':timings,'hosted':hosted,'hashes':hashes,'pdf_pages':len(pdf.pages)}),flush=True)

 def test_mip_output_02_readiness_delay_failure_missing_tool_cancel_no_partial_page(self):
  study,intercept,voi=VOI_STUDIES[1];_,perpendicular,_=VOI_CASES;record=voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();v.evaluate(BATCH_HELPERS)
  dialog=self.open_voi(v);label='VOI Slab · On · '+mm_text(record['thickness'])+' mm · ';summary=dialog.locator('.kin-mip-voi-state')
  HELD,PLAIN='MIP output held v13 Raysum','MIP output plain v12 MIP'
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,perpendicular)),'MIP','Axial',record,voi)
  mark=self.mark(v);self.choose_mip(dialog,'Raysum');self.job_final(v,mark,'Raysum','Axial')
  self.batch_inputs(dialog,'Horizontal',90,3);self.make(v,dialog,3);self.save_titled(dialog,HELD,label+'Saved')
  self.batch_button(dialog,'Clear MIP Batch').click();expect(summary).to_have_text(label+'Not Saved')
  mark=self.mark(v);self.choose_mip(dialog,'MIP');self.job_final(v,mark,'MIP','Axial');self.save_titled(dialog,PLAIN,label+'Saved')
  self.assertEqual({row['title']:row['snapshotVersion'] for row in self.jobs(a)},{HELD:13,PLAIN:12})
  # (5) The MIP Viewer was opened first: its present models are neither requested nor replaced by the print (B1/O10).
  self.assertEqual(v.evaluate('()=>{window.heldMipModels=[window.KinVolumeMip,window.KinVolumeMipJob,window.KinVolumeMipBatch];return heldMipModels.map(m=>typeof m)}'),['object']*3)
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  v.evaluate(PRINT_TRACE);v.evaluate(FETCH_HOLD);requests=[];v.on('request',lambda r:requests.append((r.method,r.url)))
  status=v.locator('#kin-job-print [role=status]');timings={}
  started=time.monotonic();paper=self.open_output(v,a,HELD);timings['v13_raysum_3_frames_s']=round(time.monotonic()-started,3);self.assertLess(timings['v13_raysum_3_frames_s'],120+3*15)
  loaded=scripts_of(requests);self.assertFalse({'volume-mip.js','volume-mip-job.js','volume-mip-batch.js','viewer-volume-mip.js'}&set(loaded),loaded)
  self.assertTrue({'viewer-volume-job-print.js','volume-mip-output.js','viewer-volume-mip-print.js'}<=set(loaded),loaded)
  self.assertTrue(v.evaluate('()=>window.KinVolumeMip===heldMipModels[0]&&window.KinVolumeMipJob===heldMipModels[1]&&window.KinVolumeMipBatch===heldMipModels[2]'),'the models are the same objects')
  expect(paper.locator('[data-mip-frame]')).to_have_count(3);opened=v.evaluate(TAKE);self.assertEqual([frame['problem'] for frame in opened['frames']],['']*3);self.assert_order(opened['events'],3,3)
  held_hashes=[shot['hash'] for shot in self.page_shots(paper,[])];requests.clear()
  # (4) and missing tool: in a fresh browser a loaded module whose global lacks a member keeps print-only failure; the retry
  # requests only that file and prints the pixels of the browser that opened the MIP Viewer.
  f1=self.fresh_page(a,2);f1.evaluate(PRINT_TRACE);f1_requests=[];f1.on('request',lambda r:f1_requests.append((r.method,r.url)));jobs1=f1.locator('#kin-viewer-jobs-status')
  def incomplete(route):route.fulfill(status=200,content_type='application/javascript',body='window.KinVolumeMipOutput=Object.freeze({plan(){},verifyClip(){},verifyDisplay(){},caption(){},supports(){}});')
  f1.route('**/volume-mip-output.js',incomplete);self.print_titled(f1,a,HELD)
  expect(jobs1).to_have_text(MESSAGES['load'],timeout=60000);expect(f1.locator('#kin-job-print[open]')).to_have_count(0)
  expect(f1.locator('#kin-viewer-jobs').get_by_role('button',name='Restore Job',exact=True).first).to_be_enabled();expect(f1.get_by_role('button',name='Save New Job',exact=True)).to_be_enabled()
  f1.unroute('**/volume-mip-output.js',incomplete);f1.wait_for_timeout(500);f1_requests.clear();paper=self.open_output(f1,a,HELD)
  self.assertEqual(scripts_of(f1_requests),['volume-mip-output.js'],'the retry requests only the module whose predicate failed')
  self.assertEqual([shot['hash'] for shot in self.page_shots(paper,[])],held_hashes,'a fresh browser prints the same pixels')
  # Aborted loads of the renderer and of the MIP Batch model: version 13 is refused, the retry requests only what is not ready, and
  # version 12 prints without the MIP Batch model.
  f2=self.fresh_page(a,2);f2.evaluate(PRINT_TRACE);f2_requests=[];f2.on('request',lambda r:f2_requests.append((r.method,r.url)));jobs2=f2.locator('#kin-viewer-jobs-status');abort=lambda route:route.abort()
  f2.route('**/viewer-volume-mip-print.js',abort);f2.route('**/volume-mip-batch.js',abort)
  self.print_titled(f2,a,HELD);expect(jobs2).to_have_text(MESSAGES['load'],timeout=60000);expect(f2.locator('#kin-viewer-jobs').get_by_role('button',name='Restore Job',exact=True).first).to_be_enabled()
  f2.unroute('**/viewer-volume-mip-print.js',abort);f2.wait_for_timeout(500);f2.evaluate("()=>{document.querySelector('#kin-viewer-jobs-status').textContent=''}");f2_requests.clear()
  self.print_titled(f2,a,HELD);expect(jobs2).to_have_text(MESSAGES['load'],timeout=60000);f2.wait_for_timeout(500)
  self.assertEqual(sorted(scripts_of(f2_requests)),['viewer-volume-mip-print.js','volume-mip-batch.js']);f2_requests.clear()
  paper=self.open_output(f2,a,PLAIN);self.assertEqual(scripts_of(f2_requests),[],'version 12 needs no MIP Batch model');expect(f2.locator('#kin-job-print h2')).to_have_text('Saved MIP Viewer Output')
  self.assertEqual(f2.evaluate('()=>typeof window.KinVolumeMipBatch'),'undefined')
  f2.unroute('**/volume-mip-batch.js',abort);f2_requests.clear();paper=self.open_output(f2,a,HELD)
  self.assertEqual(scripts_of(f2_requests),['volume-mip-batch.js']);expect(paper.locator('[data-mip-frame]')).to_have_count(3)
  # Delayed: a held source read, then Close, aborts every held read and leaves no page and no private volume.
  v.evaluate('()=>{fetchHold=true}');self.print_titled(v,a,HELD);v.wait_for_function('()=>fetchHeld.length>0',timeout=60000)
  v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();expect(v.locator('#kin-job-print')).not_to_be_visible()
  self.assertTrue(v.evaluate('()=>fetchHeld.every(held=>held.signal?.aborted)'));v.evaluate(RELEASE);v.wait_for_function(NO_LEAKS,timeout=10000);v.wait_for_timeout(300)
  self.assertEqual(v.evaluate("()=>document.querySelector('#kin-job-print iframe').srcdoc"),'');self.assertEqual(v.evaluate(TAKE)['frames'],[])
  # Delayed: the withheld Raysum pre-render refuses after 5 s; no average patch and no frame follow it.
  v.evaluate('()=>{printHoldAt=1;printHeld=0}');started=time.monotonic();self.open_output(v,a,HELD,MESSAGES['pre']);timings['pre_render_refusal_s']=round(time.monotonic()-started,3)
  self.refused(v,MESSAGES['pre']);events=v.evaluate(TAKE)['events'];self.assertEqual(events.count('blend:0'),1,events);self.assertIn('held',events);self.assertNotIn('average',events);self.assertNotIn('verify',events)
  v.evaluate('()=>{printHoldAt=null}');self.refresh_output(v);v.evaluate(TAKE)
  # Delayed: frame 2's rendered event held refuses on the 15 s frame bound after frame 1 alone was accepted.
  v.evaluate('()=>{printHoldAt=3;printHeld=0}');started=time.monotonic();self.refresh_output(v,MESSAGES['frame']);timings['frame_refusal_s']=round(time.monotonic()-started,3)
  self.assertGreaterEqual(timings['frame_refusal_s'],15);self.refused(v,MESSAGES['frame']);events=v.evaluate(TAKE)['events'];self.assertEqual(events.count('verify'),1,events);self.assertIn('held',events)
  v.evaluate('()=>{printHoldAt=null}');self.refresh_output(v);v.evaluate(TAKE)
  # Delayed: the version 13 outer bound (made short here) expires with its own message before the frame bound.
  v.evaluate('()=>{window.realMipOutput=window.KinVolumeMipOutput;window.KinVolumeMipOutput=Object.freeze({...realMipOutput,timer:()=>6000});printHoldAt=3;printHeld=0}')
  started=time.monotonic();self.refresh_output(v,MESSAGES['outer']);timings['outer_refusal_s']=round(time.monotonic()-started,3);self.assertLess(timings['outer_refusal_s'],15)
  self.refused(v,MESSAGES['outer']);v.evaluate('()=>{window.KinVolumeMipOutput=realMipOutput;printHoldAt=null}');self.refresh_output(v);v.evaluate(TAKE)
  # Failures on the print stack only: each refuses with no page and no leak, having fired exactly once.
  faults=((SHADER_FAULT,'unlinked',PLAIN,'gpu','shader:unlinked'),(SHADER_FAULT,'average',HELD,'average_shader','shader:average'),(PLANE_FAULT,None,PLAIN,'plane','plane'),
          (RANGE_FAULT,None,PLAIN,'clip','range'),(RANGE_FAULT,['NaN',1e5],PLAIN,'clip','range'),(RANGE_FAULT,[50,50],PLAIN,'clip','range'),(RANGE_FAULT,[DISTANCE-40+1,1e5],PLAIN,'clip','range'),
          (DISPLAY_FAULT,{'VOILUTFunction':'SIGMOID'},PLAIN,'display','display'),(DISPLAY_FAULT,{'invert':True},PLAIN,'display','display'),
          (DISPLAY_FAULT,{'colormap':'__missing__'},PLAIN,'display','display'),(DISPLAY_FAULT,{'colormap':{'name':'hsv'}},PLAIN,'display','display'),
          (BLOB_FAULT,'null',PLAIN,'image','blob:null'),(BLOB_FAULT,'large',PLAIN,'memory','blob:large'),(CANVAS_FAULT,None,HELD,'size','canvas'),
          (RANGE_API_FAULT,None,PLAIN,'capability','range-api'),(MAPPER_API_FAULT,None,PLAIN,'capability','mapper-api'))
  for script,arg,title,message,fault in faults:
   self.assertTrue(v.evaluate(script,arg),fault);self.open_output(v,a,title,MESSAGES[message]);self.refused(v,MESSAGES[message])
   self.assertEqual(v.evaluate(TAKE)['faults'],[fault],(fault,arg));v.evaluate('()=>{printViewFault=null;printAfterVerify=null}')
  self.refresh_output(v);v.evaluate(TAKE)
  # WebGL context loss after frame 1: no page. Whether the pinned viewer still sends a rendered event is recorded, not assumed.
  self.assertTrue(v.evaluate(CONTEXT_FAULT));self.open_output(v,a,HELD,None);context_status=status.text_content()
  self.assertIn(context_status,(MESSAGES['context'],MESSAGES['frame'],MESSAGES['gpu']));self.refused(v,context_status)
  self.assertEqual(v.evaluate(TAKE)['faults'],['context']);v.evaluate('()=>{printAfterVerify=null}');self.refresh_output(v);v.evaluate(TAKE)
  # More than 256 slices: the capacity message comes before any source lookup or pixel read.
  row=next(r for r in self.jobs(a) if r['title']==PLAIN);pattern=f"**/api/studies/{a.uid}/viewer-jobs/{row['id']}"
  def many(route):
   response=route.fetch();value=response.json();sops=value['snapshot']['volume']['sops'];value['snapshot']['volume']['sops']=sops+[sops[-1]]*(257-len(sops));route.fulfill(response=response,json=value)
  v.route(pattern,many);requests.clear();self.open_output(v,a,PLAIN,MESSAGES['capacity']);self.refused(v,MESSAGES['capacity'])
  self.assertEqual([url for method,url in requests if '/api/dicom/lookup' in url or '/frames/0/image-' in url],[]);v.unroute(pattern,many)
  # Missing tool: without kinPrepareVolumeAverage Raysum is refused while MIP still prints.
  v.evaluate('()=>{window.heldAverage=window.kinPrepareVolumeAverage;window.kinPrepareVolumeAverage=undefined}')
  self.open_output(v,a,HELD,MESSAGES['average']);self.refused(v,MESSAGES['average']);self.open_output(v,a,PLAIN)
  v.evaluate('()=>{window.kinPrepareVolumeAverage=heldAverage}');v.evaluate(TAKE)
  # User cancel: Close during the pre-render or during frame 2 leaves no page and no private volume; a later release announces nothing.
  for hold in (1,3):
   v.evaluate('h=>{printHoldAt=h;printHeld=0}',hold);self.print_titled(v,a,HELD);v.wait_for_function('()=>printHeld>0',timeout=120000)
   v.locator('#kin-job-print').get_by_role('button',name='닫기',exact=True).click();expect(v.locator('#kin-job-print')).not_to_be_visible();v.wait_for_function(NO_LEAKS,timeout=10000)
   v.evaluate('()=>{printHoldAt=null}');v.wait_for_timeout(500);self.assertEqual(v.evaluate("()=>document.querySelector('#kin-job-print iframe').srcdoc"),'')
   self.assertNotIn(MESSAGES['ready'],status.text_content());v.evaluate(TAKE)
  # A blocked popup shows the existing message; a cancelled OS print dialog changes no state.
  self.open_output(v,a,PLAIN);print_button=v.locator('#kin-job-print').get_by_role('button',name='인쇄 / PDF',exact=True)
  v.evaluate('()=>{window.heldOpen=window.heldOpen||window.open;window.open=()=>null}');print_button.click()
  expect(status).to_have_text('팝업 허용 여부를 확인한 뒤 다시 인쇄하세요.');expect(print_button).to_be_enabled()
  before={title:self.mip_job(a,title) for title in (HELD,PLAIN)};layout=v.evaluate(LAYOUT);v.evaluate(PRINT_POPUP)
  with v.expect_popup() as opened:print_button.click()
  printed=opened.value;printed.wait_for_function('()=>window.__printCalled===true',timeout=60000);printed.close()
  expect(print_button).to_be_enabled(timeout=10000);self.assertEqual({title:self.mip_job(a,title) for title in (HELD,PLAIN)},before);self.assertEqual(v.evaluate(LAYOUT),layout)
  v.evaluate('()=>{window.open=heldOpen}');self.close_output(v);v.wait_for_function(NO_LEAKS,timeout=10000)
  self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1);self.assertEqual(len(self.jobs(a)),2)
  print('MIP_OUTPUT_02',json.dumps({'timings':timings,'context_loss_status':context_status}),flush=True)

 def test_mip_output_03_source_access_order_session(self):
  study,intercept,voi=VOI_STUDIES[0];_,perpendicular,_=VOI_CASES;record=voi_record(perpendicular)
  a,p,v=self.opened_voi_study(intercept,voi);original=self.originals();v.evaluate(BATCH_HELPERS)
  dialog=self.open_voi(v);label='VOI Slab · On · '+mm_text(record['thickness'])+' mm · ';summary=dialog.locator('.kin-mip-voi-state')
  V13,V12='MIP output source v13','MIP output source v12'
  self.voi_native(self.settled(v,self.apply_voi_case(v,dialog,perpendicular)),'MIP','Axial',record,voi)
  self.batch_inputs(dialog,'Horizontal',90,2);self.make(v,dialog,2);self.save_titled(dialog,V13,label+'Saved')
  self.batch_button(dialog,'Clear MIP Batch').click();expect(summary).to_have_text(label+'Not Saved');self.save_titled(dialog,V12,label+'Saved')
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  rows={row['title']:row for row in self.jobs(a)};self.assertEqual([rows[V13]['snapshotVersion'],rows[V12]['snapshotVersion']],[13,12])
  v.evaluate(PRINT_TRACE);v.evaluate(FETCH_HOLD);requests=[];v.on('request',lambda r:requests.append((r.method,r.url)))
  status,heading,jobs_status=v.locator('#kin-job-print [role=status]'),v.locator('#kin-job-print h2'),v.locator('#kin-viewer-jobs-status')
  self.open_output(v,a,V12);v.evaluate(TAKE)
  # A source MD5 that changes between the reads before and after one frame body refuses in the loader.
  seen=[]
  def mid_read(route):
   response=route.fetch();value=response.json();url=route.request.url;seen.append(url)
   if url==seen[0] and seen.count(url)==2:value['UncompressedMD5']='0'*32
   route.fulfill(response=response,json=value)
  v.route('**/attachments/dicom/info',mid_read);self.open_output(v,a,V12,MESSAGES['mid_read'],rearm=seen.clear);self.refused(v,MESSAGES['mid_read']);v.unroute('**/attachments/dicom/info',mid_read)
  # MO9: a whole source whose instances all read consistently but differ from the saved sourceDigest is refused for version 13 too.
  def changed(route):
   response=route.fetch();value=response.json();value['UncompressedMD5']='0'*32;route.fulfill(response=response,json=value)
  v.route('**/attachments/dicom/info',changed);self.open_output(v,a,V13,MESSAGES['digest']);self.refused(v,MESSAGES['digest']);v.unroute('**/attachments/dicom/info',changed)
  self.refresh_output(v);v.evaluate(TAKE)
  # Transport fix (hosted diagnostic run 35022850312): Chromium failed one source read with net::ERR_FAILED, before any response and
  # without resending it, when its HTTP/2 connection received nginx's GOAWAY. That page-visible rejection is injected on a direct
  # print, outside the guarded open_output: a source read or a lookup rejected once is sent once more and the page is ready with every
  # fresh read; the same read rejected on both sends refuses with the source-read message after exactly two sends and leaves nothing.
  # Validate 35357376546 lost this row on the exact totals alone: a 34th frame request against 33 frame reads at the proxy, all 200,
  # with the page ready. The browser can reject a read of its own inside this window too, so the totals are accounted against the
  # browser's own failure records (transport_accounting) rather than assuming it rejected nothing: only a read this page reported as
  # failed, and did not abort itself, may be requested twice, at most TRANSPORT_CEILING of them in one sub-case, each rejected once
  # and sent exactly twice, and every such window is reported. The cause of that rejection is not established by that run and is not
  # asserted here.
  def rejecting(fragment,times):
   sent=[]
   def reject(route,request):
    if fragment in request.url and (not sent or request.url==sent[0]):
     sent.append(request.url)
     if len(sent)<=times:route.abort('failed');return
    route.continue_()
   return reject,sent
  for pattern,fragment,times,message in (('**/simplified-tags','/simplified-tags',1,'ready'),('**/api/dicom/lookup','/api/dicom/lookup',1,'ready'),
                                         ('**/simplified-tags','/simplified-tags',2,'source_read')):
   reject,sent=rejecting(fragment,times);v.route(pattern,reject);requests.clear();log=self.watch_transport(v);mark=len(log)
   self.print_titled(v,a,V12);v.wait_for_function(WAIT_STATUS,timeout=300000);v.unroute(pattern,reject)
   if message=='ready':
    expect(status).to_contain_text(MESSAGES['ready'],timeout=1000);v.wait_for_timeout(300)
    problems,report=transport_accounting(requests,log[mark:],sent,fragment,times,33)
    if report:print('MIP_OUTPUT_03_TRANSPORT',json.dumps(report),flush=True)
    self.assertEqual(problems,[],(fragment,report))
   else:
    self.refused(v,MESSAGES['source_read']);self.assertNotIn('Failed to fetch',status.text_content());self.assertEqual(sent,[sent[0]]*2,'exactly two sends of the rejected read')
   v.evaluate(TAKE)
  # Intercepted GET: a Frame of Reference or VOI Slab that does not fit the fresh volume refuses after the read; an algorithm this
  # viewer cannot reproduce refuses before any source read.
  for title,change,message,reads in ((V12,lambda s:s['mip'].__setitem__('frameOfReference','2.25.1234'),'frame_of_reference',True),
                                     (V12,lambda s:s['mip']['voiSlab'].update(center=[-500.0,-500.0,-500.0],pivot=[-500.0,-500.0,-500.0]),'outside',True),
                                     # A11-ORIENT-1 named replacement: kin-mip-2 is a known algorithm now (versions 14/15), so inside a
                                     # version 12 body it is a malformed version/algorithm pair ('shape'); kin-mip-3 is the algorithm
                                     # this viewer cannot reproduce. Both refuse before any source read, as before.
                                     (V12,lambda s:s['mip'].__setitem__('algorithm','kin-mip-3'),'reproduce',False),
                                     (V12,lambda s:s['mip'].__setitem__('algorithm','kin-mip-2'),'shape',False),
                                     (V13,lambda s:s['mipBatch'].__setitem__('algorithm','kin-mip-batch-2'),'reproduce',False)):
   pattern=f"**/api/studies/{a.uid}/viewer-jobs/{rows[title]['id']}"
   # Playwright passes (route, request) to a handler with two positional parameters, so the bound change comes after both
   # (ci-01: a handler of (route, change=change) received the Request as change; test_sr_reader.py binds its values the same way).
   def forged(route,request,change=change):
    response=route.fetch();value=response.json();change(value['snapshot']);route.fulfill(response=response,json=value)
   v.route(pattern,forged);requests.clear();self.open_output(v,a,title,MESSAGES[message],rearm=requests.clear);self.refused(v,MESSAGES[message])
   self.assertEqual(len([url for method,url in requests if '/frames/0/image-' in url]),33 if reads else 0,message);v.unroute(pattern,forged)
  # Hide Job during prepare: the re-read before the page is kept refuses it.
  def revise(title,revision,hidden):
   r=self.stack.request('POST',f"/studies/{a.uid}/viewer-jobs/{rows[title]['id']}/revisions",'doctor',dict(expectedRevision=revision,title=title,description=rows[title]['description'],hidden=hidden,reason='Synthetic output revision'))
   self.assertEqual(r.status,200,r.text)
  v.evaluate('()=>{fetchHold=true}');self.print_titled(v,a,V12);v.wait_for_function('()=>fetchHeld.length>0',timeout=60000)
  revise(V12,rows[V12]['revision'],True);v.evaluate(RELEASE);v.wait_for_function(WAIT_STATUS,timeout=300000);hidden_status=status.text_content();self.refused(v,'')
  revise(V12,rows[V12]['revision']+1,False);self.refresh_output(v);v.evaluate(TAKE)
  # Input order: row A (version 13) is opened, then row B (version 12) before A finishes; only B's page is shown. The Jobs panel is inert
  # behind the open print dialog, so B's button action is invoked directly.
  self.close_output(v);v.evaluate('()=>{fetchHold=true}');self.print_titled(v,a,V13);v.wait_for_function('()=>fetchHeld.length>0',timeout=60000)
  v.evaluate('()=>{fetchHold=false}');v.evaluate(CLICK_PRINT,self.print_index(a,V12));v.evaluate(RELEASE)
  v.wait_for_function(WAIT_STATUS,timeout=300000);expect(status).to_contain_text(MESSAGES['ready'],timeout=1000);expect(heading).to_have_text('Saved MIP Viewer Output')
  expect(v.frame_locator('#kin-job-print iframe').locator('[data-mip-frame]')).to_have_count(1);v.wait_for_timeout(1000)
  expect(heading).to_have_text('Saved MIP Viewer Output');expect(status).to_contain_text(MESSAGES['ready']);v.wait_for_function(NO_LEAKS,timeout=10000)
  self.assertEqual(len(v.evaluate(TAKE)['frames']),1,'only row B rendered frames')
  # Re-check during prepare aborts and cleans the previous loader before the new one keeps its page.
  self.close_output(v);v.evaluate('()=>{fetchHold=true}');self.print_titled(v,a,V12);v.wait_for_function('()=>fetchHeld.length>0',timeout=60000)
  v.evaluate('()=>{fetchHold=false}');v.locator('#kin-job-print').get_by_role('button',name='다시 확인',exact=True).click()
  self.assertTrue(v.evaluate('()=>fetchHeld.every(held=>held.signal?.aborted)'),'the previous loader is aborted');v.evaluate(RELEASE)
  v.wait_for_function(WAIT_STATUS,timeout=300000);expect(status).to_contain_text(MESSAGES['ready'],timeout=1000);v.wait_for_function(NO_LEAKS,timeout=10000)
  self.assertEqual(len(v.evaluate(TAKE)['frames']),1)
  # Restoring the same version 13 row into the viewer and then printing it leaves the restored viewer as it was.
  self.close_output(v);self.restore_titled(v,a,V13);expect(jobs_status).to_contain_text('MIP Batch 작업을 복원했습니다',timeout=150000)
  self.voi_button(dialog,'Close MIP Viewer').click();expect(dialog).not_to_be_visible()
  before,planes=v.evaluate(CAPTURE),v.evaluate(SOURCE_PLANES);paper=self.open_output(v,a,V13);expect(paper.locator('[data-mip-frame]')).to_have_count(2)
  self.close_output(v);after=v.evaluate(CAPTURE);self.assertEqual(after['version'],before['version']);self.assert_cells(after['cells'],before['cells']);self.assertEqual(v.evaluate(SOURCE_PLANES),planes)
  v.evaluate(TAKE)
  # Session end during prepare closes the print dialog through the Jobs panel; the held loader is aborted and cleaned.
  v.evaluate('()=>{fetchHold=true}');self.print_titled(v,a,V12);v.wait_for_function('()=>fetchHeld.length>0',timeout=60000);v.evaluate(SESSION_END)
  expect(v.locator('#kin-job-print[open]')).to_have_count(0,timeout=10000);expect(jobs_status).to_contain_text('세션이 변경되었습니다')
  self.assertTrue(v.evaluate('()=>fetchHeld.every(held=>held.signal?.aborted)'));v.evaluate(RELEASE);v.wait_for_function(NO_LEAKS,timeout=10000)
  self.assertEqual(v.evaluate("()=>document.querySelector('#kin-job-print iframe')?.srcdoc??''"),'')
  self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(a)),1)
  # Access: an account without study access gets 403; a technologist prints a readable row but cannot save a MIP Job.
  self.assertEqual(self.stack.request('GET',f"/studies/{a.uid}/viewer-jobs/{rows[V12]['id']}",'kdoctor').status,403)
  tech=self.login('tech');self.launch(tech,[a]);self.ready(tech);tech.get_by_label('Job Author',exact=True).select_option('false')
  expect(tech.locator('#kin-viewer-jobs').get_by_role('button',name='Print Saved Images',exact=True)).to_have_count(2,timeout=60000)
  expect(tech.get_by_role('button',name='Save New Job',exact=True)).to_be_disabled();tech.evaluate(PRINT_TRACE)
  paper=self.open_output(tech,a,V12);expect(paper.locator('[data-mip-frame]')).to_have_count(1);tech.evaluate(TAKE)
  body=copy.deepcopy(self.mip_job(a,V12)[1]['snapshot']);del body['volume']['sourceDigest']
  self.assertEqual(self.stack.request('POST',f'/studies/{a.uid}/viewer-jobs','tech',{'id':str(uuid.uuid4()),'title':'Tech MIP output','description':'','snapshot':body}).status,403)
  self.assertEqual(len(self.jobs(a)),2)
  # A series changed after the save is refused by the server (409) and leaves no page.
  from pydicom import dcmread
  d=dcmread(io.BytesIO(self.stack.orthanc_bytes('/instances/'+self.stack.first_instance_id(a.uid)+'/file')));self.assertEqual(str(d.StudyInstanceUID),a.uid)
  d.SOPInstanceUID=d.file_meta.MediaStorageSOPInstanceUID=ct.generate_uid();d.InstanceNumber=34;d.ImagePositionPatient=[0,0,33*2.5];d.SliceLocation=33*2.5
  ae=ct.AE(ae_title='HALLYM_CT');ae.add_requested_context(ct.CTImageStorage,ct.ExplicitVRLittleEndian);assoc=ae.associate('127.0.0.1',4242,ae_title='KINLAB')
  try:self.assertTrue(assoc.is_established);self.assertEqual(assoc.send_c_store(d).Status,0)
  finally:assoc.release()
  self.assertEqual(self.stack.request('GET',f"/studies/{a.uid}/viewer-jobs/{rows[V12]['id']}",'doctor').status,409)
  self.open_output(tech,a,V12,'저장 당시 볼륨 원본과 달라');self.refused(tech,'저장 당시 볼륨 원본과 달라')
  # A 403 on the Job read ends the session in that viewer and closes the print dialog before any page.
  pattern=f"**/api/studies/{a.uid}/viewer-jobs/{rows[V13]['id']}"
  tech.route(pattern,lambda route:route.fulfill(status=403,content_type='application/json',body=json.dumps({'message':'INJECTED MIP OUTPUT 403'})))
  self.print_titled(tech,a,V13);expect(tech.locator('#kin-job-print[open]')).to_have_count(0,timeout=30000);expect(tech.locator('#kin-viewer-jobs-status')).to_contain_text('세션이 변경되었습니다',timeout=30000)
  tech.wait_for_function(NO_LEAKS,timeout=10000);self.assertEqual(tech.evaluate("()=>document.querySelector('#kin-job-print iframe')?.srcdoc??''"),'')
  self.assertEqual(len(self.versions(a)),1)
  print('MIP_OUTPUT_03',json.dumps({'hidden_status':hidden_status}),flush=True)

def load_tests(loader,tests,pattern):return unittest.TestSuite(VolumeMipOutputE2E(n) for n in MIP_OUTPUT_CASES)
if __name__=='__main__':unittest.main(verbosity=2)
