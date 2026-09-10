# coding: utf-8
"""Selected classic CT display operations and the native preset keyboard contract."""
import io,json,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_viewer_layout import ViewerLayoutE2E
from test_prior_selection import synthetic_ct,canvas_ready

class DisplayControlsE2E(ViewerLayoutE2E):
 def ct(self,patient,label,date):return synthetic_ct(self.stack,patient,label,date,slices=4)

 def open_pair(self):
  f=self.multiple('DISPLAY-'+uuid.uuid4().hex[:12],'current','20260801')
  p=self.launch(self.login(),[f]);self.grid(p,2);self.drag(p,'D03A current',0);self.drag(p,'D02E second series',1)
  canvas_ready(p,2);self.choose(p,0);return f,p

 def choose(self,p,i):
  b=p.locator('[data-cy=viewport-grid] > div').nth(i).locator('canvas').bounding_box();p.mouse.click(b['x']+b['width']*.5,b['y']+b['height']*.3)

 def display(self,p):
  return p.evaluate('''()=>[...services.viewportGridService.getState().viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(g=>{
   const v=services.cornerstoneViewportService.getCornerstoneViewport(g.viewportId),c=v.element.querySelector('canvas'),ctx=c.getContext('2d');
   const plane=cornerstone.metaData.get('imagePlaneModule',v.getCurrentImageId()),z=plane.imagePositionPatient[2],point=v.worldToCanvas([65,65,z]);
   const rgba=ctx.getImageData(Math.round(point[0]),Math.round(point[1]),1,1).data;
   const pixels=ctx.getImageData(0,0,c.width,c.height).data;let digest=2166136261;for(let n=0;n<pixels.length;n+=4)digest=Math.imul(digest^pixels[n],16777619)>>>0;
   return {id:g.viewportId,camera:v.getCamera(),properties:v.getProperties(),image:v.getCurrentImageId(),index:v.getCurrentImageIdIndex(),point,rgba:Array.from(rgba),canvasHash:digest};
  })''')

 def gesture(self,p,tool,dx,dy):
  p.locator('[data-cy="'+tool+'"]').click();b=p.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box()
  x,y=b['x']+b['width']*.5,b['y']+b['height']*.5
  p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+dx,y+dy,steps=12);p.mouse.up();p.wait_for_timeout(150)

 def native_preset(self,p,label):
  b=p.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box()
  p.mouse.click(b['x']+b['width']-18,b['y']+20)
  p.get_by_text('Window Presets',exact=True).click();p.get_by_text(label,exact=True).click();p.wait_for_timeout(120)

 def test_display_01_preset_keys_apply_only_to_selected_ct(self):
  f,p=self.open_pair();original=self.originals();rows=self.report_rows(f);before=self.display(p)
  expected=[(400,40),(1500,-600),(150,90),(2500,480),(80,40)];labels=['Soft tissue','Lung','Liver','Bone','Brain']
  observations=[]
  for key,(width,level) in enumerate(expected,1):
   p.keyboard.press(str(key));p.wait_for_timeout(120);after=self.display(p)
   self.assertEqual(after[0]['properties']['voiRange'],dict(lower=level-width/2,upper=level+width/2-1))
   self.assertEqual(after[1],before[1]);self.assertEqual(after[0]['camera'],before[0]['camera']);self.assertEqual(after[0]['image'],before[0]['image'])
   observations.append(dict(key=key,display=after))
   p.keyboard.press(str(key%5+1));p.wait_for_timeout(120)
   self.assertNotEqual(self.display(p)[0]['properties']['voiRange'],after[0]['properties']['voiRange'])
   self.native_preset(p,labels[key-1]);self.assertEqual(self.display(p),after)
   self.choose(p,0)
  self.assertGreater(len({tuple(o['display'][0]['rgba']) for o in observations}),1)
  self.choose(p,1);left=self.display(p)[0];p.keyboard.press('2');p.wait_for_timeout(120);right=self.display(p)
  self.assertEqual(right[0],left);self.assertEqual(right[1]['properties']['voiRange'],dict(lower=-1350,upper=149))
  print('DISPLAY presets '+json.dumps(observations),flush=True)
  self.assertEqual(self.originals(),original);self.assertEqual(self.report_rows(f),rows)

 def test_display_02_non_ct_rejects_ct_preset(self):
  from test_cine import CineE2E
  f=self.ct('DISPLAY-US-'+uuid.uuid4().hex[:12],'current','20260801');us=CineE2E.series(self,f,12,'DISPLAY US')
  p=self.launch(self.login(),[f]);self.drag(p,'DISPLAY US',0);canvas_ready(p,1);self.choose(p,0)
  before=self.display(p);p.keyboard.press('1');p.wait_for_timeout(150);after=self.display(p)
  print('DISPLAY non-CT before-after '+json.dumps(dict(before=before,after=after)),flush=True);self.assertEqual(after,before)

 def test_display_03_transforms_pan_fit_and_selected_reset(self):
  f,p=self.open_pair();original=self.originals();rows=self.report_rows(f)
  p.keyboard.press('ArrowDown');p.wait_for_timeout(150);initial=self.display(p);self.assertEqual(initial[0]['index'],1)
  observations=[]
  self.gesture(p,'Zoom',0,50);zoom=self.display(p);self.assertNotEqual(zoom[0]['camera']['parallelScale'],initial[0]['camera']['parallelScale']);self.assertEqual(zoom[1],initial[1]);observations.append(dict(action='zoom',display=zoom))
  self.gesture(p,'Pan',40,25);pan=self.display(p)
  for axis,delta in enumerate([40,25]):self.assertAlmostEqual(pan[0]['point'][axis]-zoom[0]['point'][axis],delta,delta=1)
  self.assertEqual(pan[1],initial[1]);observations.append(dict(action='pan',display=pan))
  self.gesture(p,'WindowLevel',60,30);wl=self.display(p);self.assertNotEqual(wl[0]['properties']['voiRange'],pan[0]['properties']['voiRange']);self.assertEqual(wl[1],initial[1])
  for key,field in [('r','rotation'),('h','flipHorizontal'),('v','flipVertical')]:
   before=self.display(p);p.keyboard.press(key);p.wait_for_timeout(120);after=self.display(p);self.assertNotEqual(after[0]['camera'][field],before[0]['camera'][field]);self.assertEqual(after[1],initial[1]);observations.append(dict(action=key,display=after))
  before=self.display(p);p.keyboard.press('i');p.wait_for_timeout(120);inverted=self.display(p)
  self.assertNotEqual(inverted[0]['properties']['invert'],before[0]['properties']['invert']);self.assertAlmostEqual(inverted[0]['rgba'][0]+before[0]['rgba'][0],255,delta=2);self.assertEqual(inverted[1],initial[1])
  p.keyboard.press('=');p.wait_for_timeout(120);fit=self.display(p)
  self.assertEqual(fit[0]['properties']['voiRange'],inverted[0]['properties']['voiRange']);self.assertEqual(fit[0]['properties']['invert'],True);self.assertEqual(fit[1],initial[1]);self.assertEqual(fit[0]['image'],initial[0]['image'])
  p.keyboard.press('Space');p.wait_for_timeout(150);reset=self.display(p)
  self.assertEqual(reset[0]['camera'],initial[0]['camera'])
  self.assertEqual(reset[0]['properties']['colormap'],dict(name='Grayscale',opacity=[]))
  for name,value in initial[0]['properties'].items():
   if name!='colormap':self.assertEqual(reset[0]['properties'][name],value)
  self.assertEqual(reset[0]['canvasHash'],initial[0]['canvasHash']);self.assertEqual(reset[0]['rgba'],initial[0]['rgba']);self.assertEqual(reset[0]['image'],initial[0]['image']);self.assertEqual(reset[1],initial[1])
  print('DISPLAY transforms '+json.dumps(dict(initial=initial,operations=observations,inverted=inverted,fit=fit,reset=reset)),flush=True)
  p.screenshot(path=str(Path(__file__).parent/'artifacts/DISPLAY-reset.png'));self.assertEqual(self.originals(),original);self.assertEqual(self.report_rows(f),rows)

 def test_display_04_input_annotation_and_reporting_preservation(self):
  from test_viewer_history import ViewerHistoryE2E
  f,p=self.open_pair();self.seed_report(f)
  values=dict(findings='Display draft',conclusion='Display conclusion',recommendation='Display recommendation')
  self.assertEqual(self.stack.request('PUT','/studies/'+f.uid+'/report','doctor',dict(values,baseVersion=1)).status,200)
  self.assertEqual(self.stack.request('POST','/studies/'+f.uid+'/hold','doctor').status,201)
  original=self.originals();rows=self.report_rows(f);before=self.display(p)
  p.locator('[data-cy="MeasurementTools-split-button-secondary"]').click();p.get_by_text('Annotation',exact=True).click()
  b=p.locator('[data-cy=viewport-grid] > div').first.locator('canvas').bounding_box();x,y=b['x']+b['width']*.5,b['y']+b['height']*.5
  p.mouse.move(x,y);p.mouse.down();p.mouse.move(x+45,y+28,steps=8);p.mouse.up();entry=p.get_by_placeholder('Enter label');expect(entry).to_be_visible()
  before=self.display(p);entry.press_sequentially('12345');expect(entry).to_have_value('12345');self.assertEqual(self.display(p),before)
  p.get_by_role('button',name='Save',exact=True).click()
  arrows=p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').map(a=>({metadata:a.metadata,points:a.data.handles.points,text:a.data.text}))")
  self.choose(p,0);p.keyboard.press('2');p.keyboard.press('r');p.keyboard.press('h');p.keyboard.press('Space');p.wait_for_timeout(150)
  self.assertEqual(p.evaluate("()=>cornerstoneTools.annotation.state.getAllAnnotations().filter(a=>a.metadata.toolName==='ArrowAnnotate').map(a=>({metadata:a.metadata,points:a.data.handles.points,text:a.data.text}))"),arrows)
  p.get_by_role('button',name='Add Key Image',exact=True).click();title=p.locator('#kin-viewer-history section[data-kind=key]').last.get_by_label('키 제목');title.fill('')
  before=self.display(p);title.press_sequentially('12345');expect(title).to_have_value('12345');self.assertEqual(self.display(p),before)
  self.assertEqual(self.originals(),original);self.assertEqual(self.report_rows(f),rows)
  p.screenshot(path=str(Path(__file__).parent/'artifacts/DISPLAY-input.png'));p.close()
  p=self.launch(self.login(),[f]);canvas_ready(p,1);after=self.display(p)[0];self.assertEqual(after['index'],0);self.assertEqual(after['camera']['rotation'],0);self.assertFalse(after['camera']['flipHorizontal']);self.assertFalse(after['properties']['invert']);self.assertEqual(after['properties']['voiRange'],dict(lower=-1000,upper=-1))

def load_tests(loader,tests,pattern):return unittest.TestSuite(DisplayControlsE2E(n) for n in loader.getTestCaseNames(DisplayControlsE2E) if n.startswith('test_display_'))
if __name__=='__main__':unittest.main(verbosity=2)
