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
