# coding: utf-8
"""C09/M17: shipped extensions at their browser/service boundary on a synthetic HTTP origin."""
import functools
import http.server
import json
import os
import threading
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_): pass
class ViewerCautionDOM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=str(ROOT)))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def setUp(self):
        self.page = self.browser.new_page(); self.page.goto(f'http://127.0.0.1:{self.server.server_port}/?StudyInstanceUIDs=1.2')
        self.page.evaluate("document.body.replaceChildren(); document.body.innerHTML='<p id=kin-viewer-layout-status></p>'")
    def tearDown(self): self.page.close()
    def script(self, name): self.page.add_script_tag(url=f'/config/ohif/{name}.js')
    def test_pixel_failure_explanation_follows_the_displayed_image_and_mode(self):
        self.script('image-load-status')
        self.page.evaluate("""() => {
          const element = document.createElement('div'); document.body.append(element);
          window.currentImage = 'image-a';
          const events = {IMAGE_LOAD_FAILED:'failed', IMAGE_LOADED:'loaded', STACK_NEW_IMAGE:'stack', VIEWPORT_NEW_IMAGE_SET:'set'};
          window.loadedImages = new Set();
          window.cornerstone = {cache:{getImage:id => loadedImages.has(id) ? {imageId:id} : undefined},
            Enums:{Events:events}, eventTarget:new EventTarget(), getRenderingEngines:() => [{
            getViewports:() => [{element, getCurrentImageId:() => window.currentImage}]
          }]};
          window.extension = kinCreateImageLoadStatus();
          extension.preRegistration({servicesManager:{services:{viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},
            subscribe:(name, refresh) => {window.refreshGrid=refresh; return {unsubscribe(){}};}}}}});
          extension.onModeEnter();
          window.pixelEvent = (type, imageId, error) => cornerstone.eventTarget.dispatchEvent(new CustomEvent(type,{detail:{imageId,error}}));
        }""")
        self.page.evaluate("pixelEvent('failed','prefetched-image',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        # The served pinned loader reports the first-frame fetch failure as Error(message),
        # with no response/status fields. The served-page test proves the server-reason channel.
        self.page.evaluate("pixelEvent('failed','image-a',new Error(\"Couldn't retrieve image-a got status 404\"))")
        expect(self.page.get_by_role('alert')).to_contain_text('계속되면 관리자에게 문의하세요')
        self.page.evaluate("currentImage='image-b'; refreshGrid()")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("pixelEvent('failed','image-a',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("pixelEvent('failed','image-b',{status:503})")
        expect(self.page.get_by_role('alert')).to_contain_text('HTTP 503')
        self.page.evaluate("loadedImages.add('image-b'); pixelEvent('loaded','image-b'); pixelEvent('failed','image-b',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("currentImage='image-c'; pixelEvent('failed','image-c',{status:404})")
        expect(self.page.get_by_role('alert')).to_be_visible()
        self.page.evaluate("extension.onModeExit(); pixelEvent('failed','image-c',{status:404})")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("extension.onModeEnter(); refreshGrid()")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate('extension.onModeExit()')

    def test_failed_module_can_retry_without_reopening_study(self):
        self.script('tool-retry')
        for source, factory, asset, global_name, member in [
            ('context-loss','kinCreateContextLoss','viewer-context-loss','KinViewerContextLoss','create'),
            ('frame-coverage','kinCreateFrameCoverage','viewer-frame-coverage','KinFrameCoverage','mount'),
            ('images-only','kinCreateImagesOnly','viewer-images-only','KinViewerImagesOnly','create'),
            ('dicom-pdf','kinCreateDicomPdf','viewer-dicom-pdf','KinDicomPdf','create')]:
            self.page.evaluate("window.kinViewerSession={}; window.kinViewerOnEnd=()=>({close(){}}); window.connected=0")
            self.script(source)
            route = f'**/worklist/hpacs-lite/{asset}.js'
            self.page.route(route, lambda request: request.abort())
            self.page.evaluate("([factory])=>{window.ext=window[factory]();window.args={servicesManager:{services:{}}};ext.preRegistration?.(args);ext.onModeEnter(args)}",[factory])
            retry=self.page.get_by_role('button', name='Retry', exact=True); expect(retry).to_be_visible()
            self.page.unroute(route)
            module = f"window.{global_name}={{ {member}:()=>{{window.connected++;return {{start(){{}},mount(){{return true}},stop(){{}}}}}} }}"
            self.page.route(route, lambda request: request.fulfill(content_type='application/javascript',body=module))
            retry.click(); self.page.wait_for_function('window.connected === 1')
            expect(retry).to_have_count(0)
            self.page.evaluate('ext.onModeExit()'); self.page.unroute(route)

    def test_known_image_rejections_are_specific_and_do_not_reach_the_global_boundary(self):
        self.script('image-load-status')
        self.page.evaluate("""() => {
          window.currentImage='wadors:'+location.origin+'/dicom-web/studies/1/series/2/instances/3/frames/1';
          const element=document.createElement('div');document.body.append(element);
          window.cornerstone={cache:{getImage:()=>null},Enums:{Events:{IMAGE_LOAD_FAILED:'failed',IMAGE_LOAD_ERROR:'decode',IMAGE_LOADED:'loaded',STACK_NEW_IMAGE:'stack',VIEWPORT_NEW_IMAGE_SET:'set'}},
            eventTarget:new EventTarget(),getRenderingEngines:()=>[{getViewports:()=>[{element,getCurrentImageId:()=>currentImage}]}]};
          window.messages=[];window.boundaryErrors=[];window.sourceConfig={acceptHeader:['original']};
          window.config={acceptHeader:['multipart/related; type=image/jp2; transfer-syntax=*']};
          window.ext=kinCreateImageLoadStatus();
          ext.preRegistration({extensionManager:{getActiveDataSource:()=>[{getConfig:()=>sourceConfig}]},servicesManager:{services:{
            uiNotificationService:{show:message=>messages.push(message)},viewportGridService:{EVENTS:{GRID_STATE_CHANGED:'grid'},subscribe:()=>({unsubscribe(){}})}
          }}});
          // The pinned ui-next boundary subscribes in bubble phase. Known image rejections must be handled before it.
          window.addEventListener('unhandledrejection',e=>boundaryErrors.push(e.reason));
          window.addEventListener('error',e=>boundaryErrors.push(e.error));
          ext.onModeEnter();
          window.fail=(error,type='failed')=>cornerstone.eventTarget.dispatchEvent(new CustomEvent(type,{detail:{imageId:currentImage,error}}));
          window.reject=error=>window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection',{reason:error,promise:Promise.resolve(),cancelable:true}));
          window.renderError=error=>window.dispatchEvent(new ErrorEvent('error',{error,cancelable:true}));
        }""")
        self.assertEqual(self.page.evaluate('sourceConfig.acceptHeader'), ['multipart/related; type=image/jp2; transfer-syntax=*'])
        for error, expected in [('{status:401}', '로그인'), ('{status:403}', '접근 권한'), ('{status:404}', '프레임이 없습니다'),
                                ("{status:503,response:{code:'IMAGE_DELIVERY_RECORD_UNAVAILABLE',message:'영상 열람 기록을 저장하지 못해 영상을 보낼 수 없습니다.'}}", '열람 기록'),
                                ('{status:409}', '변경되었습니다'), ('{status:416}', '프레임 번호'), ('{status:503}', '영상 서버'),
                                ('{status:0}', '전송이 끊겼'), ("new Error('CACHE_SIZE_EXCEEDED')", '메모리'),
                                ("new Error('JPEG 2000 decoder failed')", '압축 영상'), ("'JPEG-LS decoder failed'", '압축 영상'),
                                ("new DOMException('cancelled','AbortError')", '요청이 취소'), ("new DOMException('timeout','TimeoutError')", '시간이 초과')]:
            self.page.evaluate(f"()=>{{window.latest={error};fail(latest);reject(latest);renderError(latest)}}")
            expect(self.page.get_by_role('alert')).to_contain_text(expected)
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 0)
        self.page.evaluate("reject(new Error('unrelated render failure'))")
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1, 'unknown errors retain upstream diagnostics')
        self.page.evaluate("cornerstone.eventTarget.dispatchEvent(new CustomEvent('loaded',{detail:{imageId:currentImage}}))")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.evaluate("reject(new Error('Couldn\\'t retrieve '+currentImage.slice(7)+' got status 504'))")
        expect(self.page.get_by_role('alert')).to_contain_text('HTTP 504')
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1)
        self.page.evaluate("""()=>{const error={status:503,request:{}};
          window.dispatchEvent(new CustomEvent('kin-series-metadata-failed',{detail:{error,message:'영상 정보를 한 번 다시 요청했지만 불러오지 못했습니다(HTTP 503).'}}));
          reject(error)}""")
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1, 'metadata recovery already supplied the terminal reason')
        # An empty successful response would spin forever in the pinned streaming loader; truncated multipart
        # must reject, and complete bytes must pass unchanged. This exercises the real browser ReadableStream.
        route = '**/dicom-web/studies/1/series/2/instances/3/frames/1'
        for payload, complete in [('', False), ('--fixture\r\nContent-Type: image/jp2\r\n\r\nbytes', False),
                                  ('--fixture\r\nContent-Type: image/jp2\r\n\r\nbytes\r\n--fixture--\r\n', True)]:
            self.page.route(route, lambda r: r.fulfill(status=200, content_type='multipart/related; boundary=fixture', body=payload))
            result = self.page.evaluate("""async()=>{try{return {body:await (await fetch(currentImage.slice(7))).text()}}
              catch(error){fail(error);reject(error);return {error:error.message}}}""")
            if complete:
                self.assertEqual(result, {'body': payload})
            else:
                self.assertIn('error', result, 'incomplete transport must reject before decode')
                expect(self.page.get_by_role('alert')).to_contain_text('프레임이 완전하지 않습니다')
            self.page.unroute(route)
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 1)
        if os.environ.get('KIN_MG_ERROR_SCREENSHOT'):
            self.page.screenshot(path=os.environ['KIN_MG_ERROR_SCREENSHOT'])
        self.page.evaluate("ext.onModeExit();reject(latest)")
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.assertEqual(self.page.evaluate('boundaryErrors.length'), 2)
        self.assertEqual(self.page.evaluate('sourceConfig.acceptHeader'), ['original'])
    def test_mixed_modality_merged_layout_round_trips_all_cells(self):
        self.page.evaluate('document.body.replaceChildren()')
        self.script('layout-model'); self.script('layout')
        self.page.evaluate("""() => {
          window.kinViewerSession={ended:()=>false,readOnly:()=>false,onReadOnly:()=>()=>{},onChange:()=>()=>{},sameAccount:()=>true,note(){}};
          window.kinViewerOnEnd=()=>({close(){}}); window.KinSessionTransport={refusal:()=>false};
          window.KinHangingProtocolModel={}; window.KinViewerHangingProtocol={mount:()=>({end(){}})};
          const sets=['MG','MR','DX'].map((Modality,i)=>({displaySetInstanceUID:'d'+i,Modality,StudyInstanceUID:'1.2',SeriesInstanceUID:'1.2.'+(i+1),SOPClassHandlerId:'stack',images:[{SOPInstanceUID:'1.3.'+(i+1)}]}));
          const rectangles=[[0,0,.5,1],[.5,0,.5,.5],[.5,.5,.5,.5]];
          window.state={layout:{numRows:2,numCols:2,layoutType:'grid'},activeViewportId:'v2',viewports:new Map(rectangles.map(([x,y,width,height],i)=>['v'+i,{viewportId:'v'+i,x,y,width,height,displaySetInstanceUIDs:['d'+i],viewportOptions:{viewportType:'stack',toolGroupId:'default'},displaySetOptions:[{}]}]))};
          const grid={getState:()=>state,setLayout:async spec=>{window.restored={rectangles:spec.layoutOptions,cells:spec.layoutOptions.map((_,i)=>spec.findOrCreateViewport(i)),active:spec.activeViewportId}}};
          window.fetch=async path=>({ok:true,json:async()=>path==='/api/me'?{kind:'member',sub:'doctor',institution:'site'}:{studies:[{uid:'1.2'}]}});
          const services={viewportGridService:grid,cornerstoneViewportService:{},displaySetService:{getActiveDisplaySets:()=>sets,getDisplaySetByUID:id=>sets.find(s=>s.displaySetInstanceUID===id)}};
          window.ext=kinCreateViewerLayout();ext.preRegistration({servicesManager:{services}});ext.onModeEnter();
        }""")
        save=self.page.get_by_role('button',name='Save Recent Layout',exact=True); expect(save).to_be_enabled(); save.click()
        expect(self.page.locator('#kin-viewer-layout-status')).to_contain_text('저장했습니다')
        self.page.get_by_role('button',name='Restore Recent Layout',exact=True).click()
        self.page.wait_for_function('!!window.restored')
        actual=self.page.evaluate('restored'); self.assertEqual(3,len(actual['cells']))
        self.assertEqual([['d0'],['d1'],['d2']],[c['displaySetInstanceUIDs'] for c in actual['cells']])
        self.assertEqual([{'x':0,'y':0,'width':.5,'height':1},{'x':.5,'y':0,'width':.5,'height':.5},{'x':.5,'y':.5,'width':.5,'height':.5}],actual['rectangles'])
        self.assertEqual(actual['active'],actual['cells'][2]['viewportOptions']['viewportId'])
        if os.environ.get('KIN_CAUTION_SCREENSHOT'): self.page.screenshot(path=os.environ['KIN_CAUTION_SCREENSHOT'])
        self.page.evaluate('ext.onModeExit()')
if __name__=='__main__': unittest.main()
