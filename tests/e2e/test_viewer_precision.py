# coding: utf-8
from pathlib import Path
import json,sys,unittest,uuid,math,io,hashlib,re,subprocess,ssl,urllib.request
from datetime import datetime,timezone
import viewer_precision_support as previous
from viewer_precision_support import ThumbnailRequestsE2E,canvas_ready,expect,dcmread,synthetic_ct,geometry
root=Path(__file__).resolve().parents[2]
out=root.parent/'tmp/d05c5';out.mkdir(parents=True,exist_ok=True)
record={'productBaseSHA':'35c2c4a70c9879b7a64e5676e2cc1cc037a5a8c3','status':'STARTED','conditions':[]}
def persist(): (out/'probe.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def snapshot(page,m):
    result=previous.state(page)
    result['mapping']=page.evaluate('''() => {
      const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports())[0];
      const d=v.getDefaultImageData();
      const samples=[[v.element.clientWidth*.47,v.element.clientHeight*.47],[v.element.clientWidth*.53,v.element.clientHeight*.53]];
      return {samples:samples.map(canvas=>({canvas,world:v.canvasToWorld(canvas)})),
        imageData:{origin:Array.from(d.getOrigin()),spacing:Array.from(d.getSpacing()),direction:Array.from(d.getDirection()),dimensions:Array.from(d.getDimensions())},
        devicePixelRatio:window.devicePixelRatio};
    }''')
    result['sampleGeometry']=geometry(m,[x['world'] for x in result['mapping']['samples']])
    result['arrowGeometry']=geometry(m,result['arrows'][0]['points'])
    result['focalGeometry']=geometry(m,[result['camera']['focalPoint']]*2)[0]
    return result
class ViewerPrecisionE2E(ThumbnailRequestsE2E):
    def test_gpu_stack_precision(self):
        a=math.sqrt(.5);c=math.cos(math.radians(31));s=math.sin(math.radians(31));iop=[a,a,0,-c*a,c*a,s]
        fixtures=[(label,synthetic_ct(self.stack,'D05C5-'+uuid.uuid4().hex[:12],label,'20260907',pos,iop,[.7,1.3])) for label,pos in [('origin',[0,0,0]),('stress',[10000,-20000,30000])]]
        original=self.hashes();self.assertEqual(len(original),4);self.addCleanup(lambda:self.assertEqual(self.hashes(),original))
        metadata={}
        for path in original:
            ds=dcmread(io.BytesIO(self.stack.orthanc_bytes(path)))
            m={'study':str(ds.StudyInstanceUID),'series':str(ds.SeriesInstanceUID),'sop':str(ds.SOPInstanceUID),
              'frameOfReference':str(ds.FrameOfReferenceUID),'position':[float(x) for x in ds.ImagePositionPatient],
              'orientation':[float(x) for x in ds.ImageOrientationPatient],'spacing':[float(x) for x in ds.PixelSpacing],
              'rows':int(ds.Rows),'columns':int(ds.Columns),'sha256':original[path],'idealOrientation':iop}
            metadata[m['sop']]=m
        record['originals']=list(metadata.values());persist()
        for _,f in fixtures:self.seed_report(f)
        work=self.login()
        for _,f in fixtures:
            self.select(work,f);draft=f.secret+' private draft';work.locator('#findings').fill(draft)
            self.wait_state(work,f,lambda x:(x.get('draft') or {}).get('findings')==draft,timeout=30000)
        saved={f.uid:(self.state(f),self.versions(f)) for _,f in fixtures}
        writes=[];configs=[]
        for label,f in fixtures:
          for variant,keys in [(mode+'-'+setup,keys) for mode,keys in [('h',['h']),('rh',['r','h']),('v',['v'])] for setup in ['plain','panzoom']]:
            arm,setup=variant.split('-')
            page=work.context.new_page()
            def config(route):
                response=route.fetch();self.assertEqual(response.status,200);body=response.text()
                configs.append(hashlib.sha256(body.encode()).hexdigest());route.fulfill(response=response,body=body+'\n'+previous.hook)
            page.route(self.stack.proxy+'/ohif/app-config.js',config)
            page.on('request',lambda r:writes.append({'method':r.method,'url':r.url.split('?')[0]}) if r.method not in ['GET','HEAD','OPTIONS'] else None)
            page.goto(self.stack.proxy+'/ohif/viewer?StudyInstanceUIDs='+f.uid);canvas_ready(page,1)
            page.wait_for_function("()=>window.__d05c1?.events.includes('onModeEnter')")
            page.locator('[data-cy="MeasurementTools-split-button-secondary"]').click();page.get_by_text('Annotation',exact=True).click()
            box=page.locator('.cornerstone-canvas').bounding_box();x,y=box['x']+box['width']*.47,box['y']+box['height']*.47
            page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+55,y+30,steps=8);page.mouse.up()
            entry=page.get_by_placeholder('Enter label');expect(entry).to_be_visible();entry.fill('D05C5 '+label+' '+variant)
            page.get_by_role('button',name='Save',exact=True).click()
            page.wait_for_function("()=>__d05c1.services.measurementService.getMeasurements().length===1")
            initial=previous.state(page);self.assertEqual(len(initial['arrows']),1)
            sop=initial['measurements'][0]['sop'];m=metadata[sop]
            applied=page.evaluate('''() => ({status:window.kinViewerPrecision,
              stackOwn:['flip','_getFocalPointForResetCamera'].map(n=>Object.hasOwn(cornerstone.StackViewport.prototype,n)),
              baseOwn:['flip','_getFocalPointForResetCamera'].map(n=>Object.hasOwn(cornerstone.Viewport.prototype,n))})''')
            self.assertEqual(applied['status'],{'version':1,'state':'ready','scope':'gpu-stack-flip'})
            self.assertEqual(applied['stackOwn'],[True,True]);self.assertEqual(applied['baseOwn'],[True,True])
            case={'condition':label,'variant':variant,'arm':arm,'setup':setup,'installation':applied,'stages':[]};record['conditions'].append(case)
            def take(stage):
                view=snapshot(page,m);self.assertEqual(len(view['arrows']),1);arrow=view['arrows'][0];measurement=view['measurements'][0]
                self.assertEqual(arrow['uid'],measurement['uid']);self.assertEqual(arrow['points'],measurement['points'])
                match=re.search(r'/studies/([^/]+)/series/([^/]+)/instances/([^/]+)/frames/(\d+)',arrow['metadata']['referencedImageId'])
                self.assertIsNotNone(match);self.assertEqual(match.groups(),(f.uid,m['series'],sop,'1'))
                self.assertEqual((measurement['study'],measurement['series'],measurement['sop'],measurement['frame']),(f.uid,m['series'],sop,1))
                self.assertEqual(arrow['metadata']['FrameOfReferenceUID'],m['frameOfReference']);self.assertEqual(view['imageId'],arrow['metadata']['referencedImageId'])
                case['stages'].append({'stage':stage,'view':view});persist();return view
            baseline=take('created')
            if setup=='panzoom':
                for tool,dx,dy in [('Pan',20,12),('Zoom',0,35)]:
                    old=case['stages'][-1]['view']
                    page.locator('[data-cy="'+tool+'"]').click()
                    px,py=box['x']+box['width']*.80,box['y']+box['height']*.80
                    page.mouse.move(px,py);page.mouse.down();page.mouse.move(px+dx,py+dy,steps=10);page.mouse.up()
                    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                    moved=take('after-'+tool.lower())
                    if tool=='Pan':self.assertNotEqual(old['camera']['focalPoint'],moved['camera']['focalPoint'])
                    else:self.assertNotEqual(old['camera']['parallelScale'],moved['camera']['parallelScale'])
                    self.assertEqual(baseline['arrows'][0]['points'],moved['arrows'][0]['points'])
            page.locator('[data-cy="Pan"]').click();page.mouse.click(box['x']+box['width']*.85,box['y']+box['height']*.85)
            for key in keys:
                page.keyboard.press(key)
                page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                transformed=take('after-'+key)
                if key=='r':self.assertAlmostEqual(transformed['camera']['rotation'],90,delta=1e-8)
                if key=='h':self.assertTrue(transformed['camera']['flipHorizontal'])
                if key=='v':self.assertTrue(transformed['camera']['flipVertical'])
                self.assertEqual(transformed['arrows'][0]['points'],baseline['arrows'][0]['points'])
            before=case['stages'][-1]['view']
            self.assertLessEqual(max(g['planeErrorMM'] for g in before['sampleGeometry']),.001)
            target=before['arrows'][0]['projected'][0]
            page.evaluate('''() => {
              const v=cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports())[0];
              window.__d05c2input=[];
              v.element.addEventListener(cornerstoneTools.Enums.Events.MOUSE_DRAG,e=>{
                const p=e.detail.currentPoints;
                __d05c2input.push({canvas:[...p.canvas],world:[...p.world],mapped:[...v.canvasToWorld(p.canvas)]});
              },true);
            }''')
            page.locator('[data-cy="MeasurementTools-split-button-primary"]').click()
            page.mouse.move(box['x']+target[0],box['y']+target[1]);page.mouse.down()
            page.mouse.move(box['x']+target[0]+25,box['y']+target[1]-15,steps=10);page.mouse.up()
            page.wait_for_function("old=>JSON.stringify(cornerstoneTools.annotation.state.getAllAnnotations().find(a=>a.annotationUID===old.uid).data.handles.points)!==JSON.stringify(old.points)",arg=before['arrows'][0])
            page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');after=take('edited')
            self.assertLessEqual(after['arrowGeometry'][0]['planeErrorMM'],.001)
            events=page.evaluate('()=>__d05c2input');self.assertGreater(len(events),0)
            self.assertEqual(events[-1]['world'],after['arrows'][0]['points'][0]);self.assertEqual(events[-1]['world'],events[-1]['mapped'])
            self.assertEqual(before['camera'],after['camera']);self.assertEqual(before['arrows'][0]['metadata'],after['arrows'][0]['metadata'])
            self.assertEqual(before['arrows'][0]['points'][1],after['arrows'][0]['points'][1])
            error=max(abs(p-t) for p,t in zip(after['arrows'][0]['projected'][0],[target[0]+25,target[1]-15]));self.assertLessEqual(error,2)
            case['input']=events;case['dragMaxAxisErrorPixels']=error;persist()
            if label=='stress' and setup=='panzoom':page.screenshot(path=str(out/(arm+'-stress-panzoom.png')))
            page.locator('[data-cy="Pan"]').click();page.mouse.click(box['x']+box['width']*.85,box['y']+box['height']*.85)
            page.keyboard.press(keys[-1]);page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            unflipped=take('unflipped');rotated=next((x['view'] for x in case['stages'] if x['stage']=='after-r'),next(x['view'] for x in case['stages'] if x['stage']==('after-zoom' if setup=='panzoom' else 'created')))
            self.assertFalse(unflipped['camera']['flipHorizontal']);self.assertFalse(unflipped['camera']['flipVertical']);self.assertAlmostEqual(unflipped['camera']['rotation'],90 if arm=='rh' else 0,delta=1e-8)
            self.assertEqual(unflipped['arrows'][0]['points'],after['arrows'][0]['points'])
            self.assertEqual(unflipped['arrows'][0]['metadata'],after['arrows'][0]['metadata'])
            return_error=max(abs(a-b) for a,b in zip(unflipped['arrows'][0]['projected'][1],rotated['arrows'][0]['projected'][1]))
            self.assertLessEqual(return_error,2);case['unflipProjectionErrorPixels']=return_error
            page.keyboard.press('Space');page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            reset=take('reset');self.assertAlmostEqual(reset['camera']['rotation'],0,delta=1e-8);self.assertFalse(reset['camera']['flipHorizontal'])
            self.assertAlmostEqual(reset['camera']['parallelScale'],baseline['camera']['parallelScale'],delta=1e-8)
            self.assertEqual(reset['arrows'][0]['points'],after['arrows'][0]['points']);self.assertEqual(reset['arrows'][0]['metadata'],baseline['arrows'][0]['metadata'])
            reset_error=max(abs(a-b) for a,b in zip(reset['arrows'][0]['projected'][1],baseline['arrows'][0]['projected'][1]))
            self.assertLessEqual(reset_error,2);case['resetProjectionErrorPixels']=reset_error;persist()
            page.close();print(label+'/'+variant+' observed',flush=True)
        self.assertEqual(writes,[])
        for _,f in fixtures:self.assertEqual((self.state(f),self.versions(f)),saved[f.uid])
        self.assertEqual(self.hashes(),original)
        record['preservation']={'instances':4,'hashUnchanged':True,'reportDraftVersionsUnchanged':True,'viewerWrites':writes}
        record['configOriginalSHA256']=configs;record['status']='OBSERVATION_PASS';persist()
def load_tests(loader,tests,pattern):return unittest.TestSuite([ViewerPrecisionE2E('test_gpu_stack_precision')])
if __name__=='__main__':
    result=unittest.main(verbosity=2,exit=False).result
    health={'utc':datetime.now(timezone.utc).isoformat(),'unittestSuccessful':result.wasSuccessful(),'testsRun':result.testsRun}
    health['composePS']=subprocess.check_output(['docker','compose','ps','--format','json'],cwd=str(root),text=True,encoding='utf-8')
    with urllib.request.urlopen('https://localhost:9443/api/health',context=ssl._create_unverified_context(),timeout=15) as response:
        health['httpStatus']=response.status;health['health']=json.load(response)
    (out/'post-run-health.json').write_text(json.dumps(health,indent=2)+'\n',encoding='utf-8')
    sys.exit(0 if result.wasSuccessful() else 1)
