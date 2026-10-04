# coding: utf-8
"""U5S-REQ-04/08/12 + amendments 2/3 -> U5S-RISK-SESSION/APPLY -> VIEWER-SESSION.

Real page gate, transport, viewer authority and complete OHIF config in Chromium.
The server is synthetic. This does not run the pinned OHIF bundle or a GPU renderer.
Mutants can replace served product files through KIN_VIEWER_*_SOURCE.
"""
import json
import base64
import os
from pathlib import Path
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://viewer-session.test"
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SOURCE = Path(os.environ.get("KIN_VIEWER_SESSION_SOURCE", HPACS / "viewer-session.js"))
MIP_SOURCE = Path(os.environ.get("KIN_VIEWER_MIP_SOURCE", HPACS / "viewer-volume-mip.js"))


class ViewerSessionDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.requests = []
        self.status, self.code = 200, None
        self.server_session = "S1"
        self.dialogs = []
        self.context.on('page', lambda page: page.on('dialog', lambda dialog: (self.dialogs.append(dialog.message), dialog.dismiss())))
        self.extra_html = ""
        self.context.route(BASE + "/**", self.route)
        self.opener = self.context.new_page()
        self.opener.goto(BASE + "/worklist")
        self.opener.evaluate("""() => {
          KinWorkContext.follow({onLifecycle(fn){window.source=fn;fn({state:'active',session:'S1'})}});
          window.channel=new BroadcastChannel('kin-session');
        }""")
        self.view = None

    def tearDown(self):
        self.context.close()

    def route(self, route):
        path = route.request.url[len(BASE):].split("?")[0]
        if path.startswith("/worklist/hpacs-lite/") and path.endswith(".js"):
            name = path.rsplit("/", 1)[-1]
            source = SOURCE if name == "viewer-session.js" else HPACS / name
            route.fulfill(body=source.read_text(encoding="utf-8"), content_type="application/javascript")
        elif path == "/config.js":
            route.fulfill(body=(ROOT / "config" / "ohif.js").read_text(encoding="utf-8"), content_type="application/javascript")
        elif path == "/worklist":
            route.fulfill(body='<script src="/worklist/hpacs-lite/work-context.js"></script>', content_type="text/html")
        elif path == "/ohif/viewer":
            route.fulfill(body=self.extra_html + '''<div id="root"><input id="draft" value="held draft"></div>
              <script src="/config.js"></script><script>
              window.close=()=>{window.closeAttempted=true};
              config.extensions.find(extension=>extension.id==='kin.session-boundary').preRegistration().then(()=>window.started=true);
              </script>''', content_type="text/html")
        elif path.startswith(("/api/", "/dicom-web/", "/instances/")):
            self.requests.append((path, route.request.headers.get("x-kin-session")))
            headers = {"X-KIN-Auth-Code": self.code} if self.code else {}
            route.fulfill(status=self.status, headers=headers,
                          body=json.dumps({"code": self.code, "value": "incoming", "sessionId": self.server_session}), content_type="application/json")
        else:
            route.fulfill(body="<p>Landing</p>", content_type="text/html")

    def open_viewer(self):
        with self.context.expect_page() as created:
            self.opener.evaluate("window.viewerRef=window.open('/ohif/viewer?StudyInstanceUIDs=1.2.3')")
        self.view = created.value
        for _ in range(200):
            if self.view.evaluate("!!window.KinViewerSessionBoundary"):
                break
            self.view.wait_for_timeout(10)
        self.assertTrue(self.view.evaluate("!!window.KinViewerSessionBoundary"))
        return self.view

    def notice(self, kind, session="S1", preparation="document-X:preparation"):
        self.opener.evaluate("value=>channel.postMessage(value)",
                             {"type": kind, "session": session, "preparation": preparation})

    def test_open_and_reload_keep_binding_without_a_new_visible_step(self):
        view = self.open_viewer()
        self.assertTrue(view.evaluate("KinSessionTransport.page()===KinViewerSessionBoundary.transport"))
        for _ in range(2):
            self.assertEqual(view.locator("#draft").input_value(), "held draft")
            self.assertEqual(view.evaluate("KinWorkContext.state()"), "active")
            self.assertEqual(view.evaluate("fetch('/api/me').then(r=>r.json()).then(v=>v.value)"), "incoming")
            view.reload()
            view.wait_for_function("window.started===true")
        self.assertEqual(self.requests, [("/api/me", "S1"), ("/api/me", "S1")])

    def test_reload_after_opener_closed_retains_its_original_binding(self):
        view = self.open_viewer()
        view.evaluate("history.pushState({key:'router-entry'},'',location.href)")
        self.opener.close()
        view.reload()
        view.wait_for_function("window.started===true")
        view.evaluate("fetch('/api/me').then(r=>r.json())")
        self.assertEqual(self.requests[-1], ("/api/me", "S1"))

    def test_plain_failures_never_close_or_erase_input(self):
        view = self.open_viewer()
        for status, code in [(401, None), (401, "AUTH_CREDENTIALS_MISSING"), (403, None),
                             (403, "AUTH_SESSION_REQUIRED"), (409, "REPORT_HELD"),
                             (409, "AUTH_SESSION_BUSY"), (428, "AUTH_SESSION_REQUIRED"),
                             (500, None), (503, "AUTH_IDP_UNAVAILABLE")]:
            with self.subTest(status=status, code=code):
                self.status, self.code = status, code
                self.assertEqual(view.evaluate("fetch('/api/studies').then(r=>r.status)"), status)
                self.assertEqual(view.locator("#draft").input_value(), "held draft")
                self.assertEqual(view.evaluate("KinWorkContext.state()"), "active")

    def test_other_session_and_missing_session_notices_do_nothing(self):
        view = self.open_viewer()
        for session in ["S0", "S2", None]:
            for kind in ["session-ended", "session-preparing", "session-resumed"]:
                self.notice(kind, session)
        view.wait_for_timeout(100)
        self.assertEqual(view.evaluate("KinWorkContext.state()"), "active")
        self.assertEqual(view.locator("#draft").input_value(), "held draft")

    def test_pause_keeps_input_and_blocks_requests_then_matching_resume_continues(self):
        view = self.open_viewer()
        self.notice("session-preparing")
        view.wait_for_function("KinWorkContext.state()==='preparing'")
        self.assertEqual(view.evaluate("fetch('/api/write',{method:'POST'}).catch(e=>e.transport)"), "not-admitted")
        self.assertEqual(self.requests, [])
        view.evaluate("window.tick=0;setTimeout(()=>tick++,0)")
        view.wait_for_timeout(50)
        self.assertEqual(view.evaluate("tick"), 0)
        self.notice("session-preparing", preparation="document-Y:preparation")
        self.notice("session-resumed", preparation="document-Y:preparation")
        view.wait_for_timeout(50)
        self.assertEqual(view.evaluate("KinWorkContext.state()"), "preparing")
        self.notice("session-resumed")
        view.wait_for_function("KinWorkContext.state()==='active' && tick===1")
        self.assertEqual(view.locator("#draft").input_value(), "held draft")

    def test_opened_during_preparation_starts_paused(self):
        self.opener.evaluate("window.preparation=KinWorkContext.prepare({})")
        view = self.open_viewer()
        self.assertEqual(view.evaluate("KinWorkContext.state()"), "preparing")
        self.assertEqual(view.locator("#draft").input_value(), "held draft")
        self.opener.evaluate("KinWorkContext.cancelPreparation(preparation)")
        view.wait_for_function("KinWorkContext.state()==='active'")

    def test_xhr_api_dicom_and_instance_requests_use_same_transport(self):
        view = self.open_viewer()
        for path in ["/api/me", "/dicom-web/studies", "/instances/abc/file"]:
            reply = view.evaluate("""path => new Promise((resolve,reject)=>{
              const xhr=new XMLHttpRequest();xhr.open('GET',path);xhr.responseType='arraybuffer';
              xhr.onload=()=>resolve({status:xhr.status,value:new TextDecoder().decode(xhr.response)});
              xhr.onerror=reject;xhr.send();
            })""", path)
            self.assertEqual(reply["status"], 200)
            self.assertEqual(json.loads(reply["value"])["value"], "incoming")
        self.assertEqual(self.requests, [(path, "S1") for path in ["/api/me", "/dicom-web/studies", "/instances/abc/file"]])

    def test_missed_notice_first_request_mismatch_closes_with_navigation_held(self):
        view = self.open_viewer()
        held = []
        view.route(BASE + "/worklist/hpacs-lite/index.html", lambda route: held.append(route))
        self.status, self.code = 403, "AUTH_SESSION_MISMATCH"
        view.evaluate("() => {window.applied=0;fetch('/dicom-web/studies').then(()=>applied++).catch(()=>applied++).finally(()=>applied++);}")
        for _ in range(100):
            if held:
                break
            view.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        self.assertTrue(self.opener.evaluate("viewerRef.closeAttempted===true"))
        self.assertEqual(self.opener.evaluate("viewerRef.KinWorkContext.state()"), "ending")
        self.assertEqual(self.opener.evaluate("viewerRef.applied"), 0)
        self.assertFalse(self.opener.evaluate("!!viewerRef.document.querySelector('#root')"))
        self.assertEqual(self.opener.evaluate("KinWorkContext.state()"), "active")
        for route in held:
            route.abort()

    def test_clinician_noopener_bootstraps_once_then_reload_and_second_viewer_are_bound(self):
        with self.context.expect_page() as created:
            self.opener.evaluate("() => {const popup=window.open('/ohif/viewer?StudyInstanceUIDs=1.2.3','clinician-viewer');popup.opener=null;}")
        page = created.value
        page.wait_for_function("window.started===true")
        self.assertTrue(page.evaluate("opener===null"))
        self.assertEqual(self.requests, [("/api/me", None)])
        for _ in range(2):
            page.evaluate("fetch('/api/studies').then(r=>r.json())")
            page.reload()
            page.wait_for_function("window.started===true")
        self.assertEqual(self.requests.count(("/api/me", None)), 1)
        self.assertEqual(self.requests[-1], ("/api/studies", "S1"))
        self.assertEqual(page.locator('#draft').input_value(), 'held draft')
        with self.context.expect_page() as created:
            self.opener.evaluate("() => {const popup=window.open('/ohif/viewer?StudyInstanceUIDs=4.5.6','clinician-viewer-two');popup.opener=null;}")
        second = created.value
        second.wait_for_function('window.started===true')
        second.evaluate("fetch('/api/studies').then(r=>r.json())")
        self.assertEqual(self.requests.count(('/api/me', None)), 2)
        self.assertEqual(self.requests[-1], ('/api/studies', 'S1'))
        self.assertFalse(page.is_closed())
        self.assertFalse(second.is_closed())
        self.assertEqual(self.dialogs, [])

    def test_direct_entry_end_record_sends_nothing(self):
        self.opener.evaluate("localStorage.setItem('kin-session-end',JSON.stringify({session:'S1',operation:1,status:'confirmed'}))")
        page = self.context.new_page()
        page.goto(BASE + "/ohif/viewer")
        page.wait_for_url(BASE + "/worklist/hpacs-lite/index.html")
        self.assertEqual(self.requests, [])

    def test_direct_entry_unreliable_storage_or_history_sends_nothing(self):
        for unavailable in ["Object.defineProperty(window,'localStorage',{get(){throw new DOMException('denied')}})",
                            "Object.defineProperty(history,'state',{get(){throw new DOMException('denied')}})",
                            "history.replaceState=()=>{throw new DOMException('denied')}"]:
            with self.subTest(unavailable=unavailable):
                page = self.context.new_page()
                page.add_init_script(unavailable)
                page.goto(BASE + '/ohif/viewer')
                page.wait_for_url(BASE + '/worklist/hpacs-lite/index.html')
                self.assertEqual(self.requests, [])
                page.close()

    def test_noopener_bound_document_never_bootstraps_the_replacement_login(self):
        page=self.context.new_page()
        page.goto(BASE+'/ohif/viewer')
        page.wait_for_function('window.started===true')
        self.server_session='S2'
        page.reload()
        page.wait_for_function('window.started===true')
        self.assertEqual(page.evaluate('KinWorkContext.session()'),'S1')
        self.status,self.code=409,'AUTH_SESSION_MISMATCH'
        page.evaluate("() => {fetch('/api/studies');}")
        page.wait_for_url(BASE+'/worklist/hpacs-lite/index.html')
        self.assertEqual(self.requests, [('/api/me',None),('/api/studies','S1')])

    def test_end_notice_while_bootstrap_body_waits_cannot_open_work(self):
        held=[]
        self.context.route(BASE+'/api/me',lambda route: held.append(route))
        page=self.context.new_page();page.goto(BASE+'/ohif/viewer')
        for _ in range(100):
            if held:break
            page.wait_for_timeout(10)
        self.assertEqual(len(held),1)
        self.notice('session-ended')
        self.notice('session-resumed')
        self.notice('session-preparing')
        self.notice('session-resumed')
        page.wait_for_timeout(50)
        held.pop().fulfill(json={'sessionId':'S1'})
        page.wait_for_url(BASE+'/worklist/hpacs-lite/index.html')
        self.assertEqual(self.requests,[])

    def test_ordinary_two_windows_reload_and_study_navigation_need_no_extra_interaction(self):
        first=self.open_viewer()
        first.reload();first.wait_for_function('window.started===true')
        second=self.open_viewer()
        for page in [first,second]:
            page.locator('#draft').fill('working input')
            page.evaluate("history.pushState({layout:'retained'},'', '/ohif/viewer?StudyInstanceUIDs=4.5.6')")
            page.evaluate("fetch('/dicom-web/studies').then(r=>r.json())")
            self.assertEqual(page.locator('#draft').input_value(),'working input')
            self.assertEqual(page.evaluate('KinWorkContext.state()'),'active')
            self.assertFalse(page.is_closed())
        self.assertEqual(self.dialogs,[])
        self.assertEqual(self.requests,[('/dicom-web/studies','S1')]*2)

    def test_native_image_decode_finishing_during_pause_is_delivered_only_after_resume(self):
        held=[]
        view=self.open_viewer()
        view.route(BASE+'/pixels.png',lambda route: held.append(route))
        view.evaluate("""() => {
          window.effects=[];window.img=new Image();img.src='/pixels.png';
          img.decode().then(()=>{effects.push('decode');document.querySelector('#draft').value='decoded'});
        }""")
        for _ in range(100):
            if held:break
            view.wait_for_timeout(10)
        self.notice('session-preparing');view.wait_for_function("KinWorkContext.state()==='preparing'")
        held.pop().fulfill(body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='),content_type='image/png')
        view.wait_for_timeout(100)
        self.assertEqual(view.evaluate('effects'),[])
        self.assertEqual(view.locator('#draft').input_value(),'held draft')
        self.notice('session-resumed');view.wait_for_function("effects.length===1")
        self.assertEqual(view.locator('#draft').input_value(),'decoded')

    def test_native_bitmap_and_worker_completion_cannot_write_while_paused(self):
        view=self.open_viewer()
        view.evaluate("""() => {
          window.effects=[];
          const url=URL.createObjectURL(new Blob([`onmessage=()=>setTimeout(()=>postMessage('decoded'),100)`],{type:'text/javascript'}));
          window.worker=new Worker(url);URL.revokeObjectURL(url);
          worker.onmessage=()=>{effects.push('worker');document.querySelector('#draft').value='worker'};
          worker.postMessage('go');
        }""")
        self.notice('session-preparing');view.wait_for_function("KinWorkContext.state()==='preparing'")
        view.evaluate("""() => {createImageBitmap(new ImageData(2,2)).then(bitmap=>{
          effects.push('bitmap');document.querySelector('#draft').value='bitmap';bitmap.close();
        });}""")
        view.wait_for_timeout(200)
        self.assertEqual(view.evaluate('effects'),[])
        self.assertEqual(view.locator('#draft').input_value(),'held draft')
        self.notice('session-resumed');view.wait_for_function('effects.length===2')
        self.assertEqual(sorted(view.evaluate('effects')),['bitmap','worker'])

    def test_native_decode_after_end_never_paints_writes_or_touches_parent_with_navigation_held(self):
        held=[];view=self.open_viewer()
        view.route(BASE+'/worklist/hpacs-lite/index.html',lambda route:held.append(route))
        view.evaluate("""() => {
          window.effects=[];const write=()=>{effects.push('late');opener.contaminated=true;document.body.append('late')};
          createImageBitmap(new ImageData(64,64)).then(write).catch(write).finally(write);
          const image=new Image();image.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
          image.decode().then(write).catch(write).finally(write);
          const url=URL.createObjectURL(new Blob([`onmessage=()=>setTimeout(()=>postMessage('done'),100)`],{type:'text/javascript'}));
          const worker=new Worker(url);worker.onmessage=write;worker.postMessage('decode');
          KinViewerSessionBoundary.authFailure({session:'S1',status:401,code:'AUTH_SESSION_ENDED'});
        }""")
        for _ in range(100):
            if held:break
            view.wait_for_timeout(10)
        self.assertEqual(len(held),1)
        self.opener.wait_for_timeout(200)
        self.assertEqual(self.opener.evaluate('viewerRef.effects'),[])
        self.assertFalse(self.opener.evaluate('!!window.contaminated'))
        self.assertEqual(self.opener.evaluate('viewerRef.document.body.textContent'),'')
        held.pop().abort()

    def test_held_finding_real_store_entry_points_refuse_during_pause_and_restore_exact_text(self):
        view=self.open_viewer()
        view.route(BASE+'/api/me',lambda route:route.fulfill(json={'kind':'member','institution':'I1','sub':'u1','roles':['radiologist'],'sessionId':'S1'}))
        view.route(BASE+'/api/studies/**/findings?*',lambda route:route.fulfill(json={'items':[],'nextCursor':None},headers={'X-KIN-Finding-Schema':'2'}))
        for name in ['finding-link-model.js','viewer-findings.js']:
            view.add_script_tag(path=str(HPACS/name))
        view.evaluate("""() => {
          const host=document.createElement('details');host.open=true;host.id='kin-viewer-history';document.body.append(host);
          // Observe the exact store the real panel creates; no methods or results are replaced.
          const create=kinFindingLinkModel.createStore;kinFindingLinkModel.createStore=(...args)=>window.findingStore=create(...args);
          window.findings=kinViewerFindings({},kinFindingLinkModel);findings.mount();findingStore.setScope('1.2.3');
        }""")
        view.get_by_role('button',name='New Finding',exact=True).click()
        view.get_by_label('Finding Title',exact=True).fill('held title')
        view.get_by_label('Finding Text',exact=True).fill('held original body')
        view.evaluate("findingStore.setScope('4.5.6')")
        view.wait_for_function('findingStore.held().count===1 && !findingStore.state().loading')
        held=view.evaluate('JSON.stringify([...findingStore.state().parked])')
        self.notice('session-preparing');view.wait_for_function("KinWorkContext.state()==='preparing'")
        for command in ["findingStore.discardHeld()","findingStore.setScope('1.2.3')","findingStore.newDraft()","findingStore.load()"]:
            self.assertEqual(view.evaluate("() => {try {"+command+";return 'changed'}catch(e){return e.name}}"),'AbortError')
        self.assertEqual(view.evaluate('JSON.stringify([...findingStore.state().parked])'),held)
        self.notice('session-resumed');view.wait_for_function("KinWorkContext.state()==='active'")
        view.evaluate("findingStore.setScope('1.2.3')")
        self.assertEqual(view.get_by_label('Finding Title',exact=True).input_value(),'held title')
        self.assertEqual(view.get_by_label('Finding Text',exact=True).input_value(),'held original body')

    def test_mip_job_controls_and_capability_refuse_during_pause_preserving_the_open_job(self):
        from tests.viewer_session_fixture import MIP_RENDERER
        view=self.open_viewer()
        view.route(BASE+'/api/me',lambda route:route.fulfill(json={'kind':'member','institution':'I1','sub':'u1','roles':['radiologist'],'sessionId':'S1'}))
        view.route(BASE+'/api/studies',lambda route:route.fulfill(json={'studies':[{'uid':'1.2.3'}]}))
        for name in ['volume-mip.js','volume-voi.js','volume-mip-job.js','viewer-volume-mip.js']:
            view.add_script_tag(path=str(MIP_SOURCE if name == 'viewer-volume-mip.js' else HPACS/name))
        view.evaluate(MIP_RENDERER)
        before=view.evaluate('mip.job.capture()')
        self.assertIsNotNone(before, view.evaluate('mipNotices'))
        view.get_by_label('MIP Job Title',exact=True).fill('retained MIP job')
        writes=view.evaluate('mipNativeWrites')
        self.notice('session-preparing');view.wait_for_function("KinWorkContext.state()==='preparing'")
        # Invoke the real controls directly: this bypasses both the overlay and capture input blocker.
        for command in ["document.querySelector('[aria-label=\"MIP Projection\"]').onchange()",
                        "[...document.querySelectorAll('#kin-volume-mip button')].find(b=>b.textContent==='Reset VOI').onclick()",
                        'mip.job.clearForJob()', 'mip.job.restore(mip.job.capture())']:
            self.assertEqual(view.evaluate("() => {try {"+command+";return 'changed'}catch(e){return e.name}}"),'AbortError')
        self.assertEqual(view.evaluate('mip.job.capture()'),before)
        self.assertEqual(view.evaluate('mipNativeWrites'),writes)
        self.assertTrue(view.locator('#kin-volume-mip').evaluate('(element)=>element.open'))
        self.notice('session-resumed');view.wait_for_function("KinWorkContext.state()==='active'")
        self.assertEqual(view.get_by_label('MIP Job Title',exact=True).input_value(),'retained MIP job')
        self.assertEqual(view.evaluate('mip.job.capture()'),before)

    def test_real_back_forward_records_bfcache_or_the_exact_chromium_reason(self):
        requests=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                path=self.path.split('?')[0]
                kind='text/html'
                if path=='/config.js':body=(ROOT/'config/ohif.js').read_bytes();kind='application/javascript'
                elif path.startswith('/worklist/hpacs-lite/') and path.endswith('.js'):
                    name=path.rsplit('/',1)[-1];body=(SOURCE if name=='viewer-session.js' else HPACS/name).read_bytes();kind='application/javascript'
                elif path=='/api/me':
                    requests.append(self.headers.get('X-KIN-Session'));body=b'{"sessionId":"S1"}';kind='application/json'
                elif path=='/ohif/viewer':body=b'''<input id="draft" value="original"><script>
                  window.restored=false;addEventListener('pageshow',event=>window.restored=event.persisted);
                  </script><script src="/config.js"></script><script>
                  config.extensions.find(e=>e.id==='kin.session-boundary').preRegistration().then(()=>window.started=true);
                  </script>'''
                else:body=b'<a href="/ohif/viewer">Back</a>'
                self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        browser=self.pw.chromium.launch(ignore_default_args=['--disable-back-forward-cache'])
        try:
            page=browser.new_page();client=page.context.new_cdp_session(page);client.send('Page.enable');reasons=[]
            client.on('Page.backForwardCacheNotUsed',lambda event:reasons.append(event))
            origin='http://127.0.0.1:'+str(server.server_port)
            page.goto(origin+'/ohif/viewer');page.wait_for_function('window.started===true')
            page.locator('#draft').fill('preserved through history')
            page.goto(origin+'/away');page.go_back();page.wait_for_function('window.started===true')
            persisted=page.evaluate('restored')
            if persisted:self.assertEqual(page.locator('#draft').input_value(),'preserved through history')
            else:
                self.assertTrue(reasons,'Chromium must explain why this real back traversal did not use BFCache')
                page.locator('#draft').fill('direct persisted path')
                page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
                self.assertEqual(page.locator('#draft').input_value(),'direct persisted path')
            page.go_forward();self.assertTrue(page.url.endswith('/away'))
            print('BFCACHE '+json.dumps({'persisted':persisted,'reasons':reasons,'bindings':requests}))
            self.assertEqual(requests.count(None),1)
        finally:
            browser.close();server.shutdown();server.server_close();thread.join()

    def test_marks_and_unfinished_label_survive_pause_and_mutation_capabilities_refuse(self):
        from tests.viewer_volume_marks_progressive_dom_test import HARNESS
        self.extra_html = HARNESS
        view = self.open_viewer()
        for name in ["volume-marks.js", "viewer-volume-progressive.js", "viewer-volume-marks.js", "viewer-volume-orientation.js"]:
            view.add_script_tag(path=str(HPACS / name))
        view.evaluate("window.mounted=mountOrientation();tick(250);tick(500)")
        panel = view.locator("#kin-mpr-marks")
        panel.get_by_label("MPR annotation label", exact=True).fill("retained point")
        panel.get_by_role("button", name="Pick Point", exact=True).click()
        view.mouse.click(130, 60)
        before = view.evaluate("kinMprMarks.capture(true)")
        self.assertEqual(len(before["marks"]), 1)
        panel.get_by_label("MPR annotation label", exact=True).fill("unfinished label")
        self.notice("session-preparing")
        view.wait_for_timeout(50)
        for command in ["kinMprMarks.clearForJob()", "kinMprMarks.saved(null,[])", "kinMprMarks.restore(null)"]:
            self.assertEqual(view.evaluate("() => {try {" + command + ";return 'changed'}catch(e){return e.name}}"), "AbortError")
        self.assertEqual(panel.get_by_label("MPR annotation label", exact=True).input_value(), "unfinished label")
        self.notice("session-resumed")
        view.wait_for_timeout(50)
        panel.get_by_label("MPR annotation label", exact=True).fill("")
        self.assertEqual(view.evaluate("kinMprMarks.capture(true)"), before)

    def test_tech_note_input_and_inflight_save_survive_preparation(self):
        view = self.open_viewer()
        held = []
        note_url = BASE + "/api/studies/1.2.3/tech-note"
        def note(route):
            if route.request.method == "POST":
                held.append(route)
            else:
                route.fulfill(json={"uid": "1.2.3", "writable": True, "note": None})
        view.route(note_url, note)
        view.add_script_tag(path=str(HPACS / "tech-note.js"))
        view.evaluate("""() => {
          window.note=KinTechNote({allowed:()=>KinViewerSessionBoundary.active(),
            api:(method,path,body)=>fetch('/api'+path,{method,body:body===undefined?undefined:JSON.stringify(body),
              headers:{'Content-Type':'application/json'}}).then(r=>r.json())});
          note.open({uid:'1.2.3'});
        }""")
        view.locator("#tech-note-text").fill("unsaved original")
        view.locator("#tech-note-save").click()
        for _ in range(100):
            if held:
                break
            view.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        self.notice("session-preparing")
        view.wait_for_timeout(50)
        held.pop().fulfill(json={"uid": "1.2.3", "writable": True,
                                "note": {"studyUid": "1.2.3", "text": "unsaved original", "version": 1,
                                         "author": "synthetic", "createdAt": "2026-10-04T00:00:00Z"}})
        view.wait_for_timeout(100)
        self.assertEqual(view.locator("#tech-note-text").input_value(), "unsaved original")
        self.assertNotIn("저장되었습니다", view.locator("#tech-note-status").inner_text())
        self.notice("session-resumed")
        view.wait_for_timeout(100)
        self.assertEqual(view.locator("#tech-note-text").input_value(), "unsaved original")
        self.assertIn("저장되었습니다", view.locator("#tech-note-status").inner_text())

    def test_pause_retires_cancelled_timers_and_defers_an_xhr_completion(self):
        view = self.open_viewer()
        held = []
        view.route(BASE + "/instances/held/file", lambda route: held.append(route))
        view.evaluate("""() => {
          window.received=0;window.tick=0;
          const xhr=new XMLHttpRequest();xhr.open('GET','/instances/held/file');
          xhr.onload=()=>received++;xhr.send();
        }""")
        for _ in range(100):
            if held:
                break
            view.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        self.notice("session-preparing")
        view.wait_for_timeout(50)
        view.evaluate("window.timer=setTimeout(()=>tick++,0)")
        view.wait_for_timeout(50)
        view.evaluate("clearTimeout(timer)")
        held.pop().fulfill(body="image bytes")
        view.wait_for_timeout(50)
        self.assertEqual(view.evaluate("received"), 0)
        self.notice("session-resumed")
        view.wait_for_timeout(100)
        self.assertEqual(view.evaluate("received"), 1)
        self.assertEqual(view.evaluate("tick"), 0)

    def test_end_cuts_headers_body_stream_and_error_finally_with_navigation_held(self):
        self.extra_html = '''<script>
          const nativeFetch=window.fetch.bind(window);
          window.fetch=(url,init)=>{
            if(url==='/api/before')return new Promise(resolve=>window.finishHeaders=()=>resolve(new Response('late')));
            if(url==='/api/failure')return new Promise((_,reject)=>window.finishError=()=>reject(new TypeError('offline')));
            if(url==='/api/body'||url==='/api/stream')return Promise.resolve(new Response(new ReadableStream({
              start(controller){window[url==='/api/body'?'bodySource':'streamSource']=controller;
                controller.enqueue(new TextEncoder().encode('first'));}
            })));
            return nativeFetch(url,init);
          };
        </script>'''
        view = self.open_viewer()
        held = []
        view.route(BASE + "/worklist/hpacs-lite/index.html", lambda route: held.append(route))
        view.evaluate("""() => {
          window.effects=[];
          const write=()=>{effects.push('late');opener.contaminated=true;document.body.append(document.createElement('aside'))};
          fetch('/api/before').then(r=>r.text()).then(write).catch(write).finally(write);
          fetch('/api/failure').then(write).catch(write).finally(write);
          fetch('/api/body').then(r=>r.text()).then(write).catch(write).finally(write);
          fetch('/api/stream').then(async r=>{const reader=r.body.getReader();await reader.read();window.firstRead=true;
            await reader.read();write();}).catch(write).finally(write);
        }""")
        view.wait_for_function("window.firstRead===true")
        self.notice("session-ended")
        for _ in range(100):
            if held:
                break
            view.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        self.opener.evaluate("""() => {
          const view=viewerRef;view.finishHeaders();view.finishError();
          for(const controller of [view.bodySource,view.streamSource]){
            controller.enqueue(new TextEncoder().encode('late'));controller.close();
          }
        }""")
        self.opener.wait_for_timeout(100)
        self.assertEqual(self.opener.evaluate("viewerRef.effects"), [])
        self.assertFalse(self.opener.evaluate("!!window.contaminated"))
        self.assertFalse(self.opener.evaluate("!!viewerRef.document.querySelector('aside')"))
        held.pop().abort()

    def test_session_end_during_preparation_removes_the_viewer_iframe(self):
        self.opener.evaluate("""() => {
          const iframe=document.createElement('iframe');iframe.id='viewer';
          iframe.src='/ohif/viewer?StudyInstanceUIDs=1.2.3';document.body.append(iframe);
        }""")
        self.opener.wait_for_function("!!document.querySelector('#viewer')?.contentWindow.KinViewerSessionBoundary")
        self.notice("session-preparing")
        self.opener.wait_for_function("document.querySelector('#viewer').contentWindow.KinWorkContext.state()==='preparing'")
        self.notice("session-ended")
        self.opener.wait_for_function("!document.querySelector('#viewer')")
        self.assertEqual(self.opener.evaluate("KinWorkContext.state()"), "active")

    def test_an_s2_viewer_ignores_old_s1_signals_and_binds_new_requests_to_s2(self):
        self.opener.reload()
        self.opener.evaluate("""() => {
          KinWorkContext.follow({onLifecycle(fn){fn({state:'active',session:'S2'})}});
          window.channel=new BroadcastChannel('kin-session');
        }""")
        view = self.open_viewer()
        self.notice("session-ended", "S1")
        view.evaluate("KinViewerSessionBoundary.authFailure({session:'S1',status:409,code:'AUTH_SESSION_MISMATCH'})")
        view.wait_for_timeout(50)
        self.assertEqual(view.locator("#draft").input_value(), "held draft")
        view.evaluate("fetch('/api/me').then(r=>r.json())")
        self.assertEqual(self.requests[-1], ("/api/me", "S2"))

    def test_reload_does_not_adopt_the_openers_replacement_session(self):
        view = self.open_viewer()
        self.opener.reload()
        self.opener.evaluate("KinWorkContext.follow({onLifecycle(fn){fn({state:'active',session:'S2'})}})")
        view.reload()
        view.wait_for_function("window.started===true")
        view.evaluate("fetch('/api/me').then(r=>r.json())")
        self.assertEqual(self.requests[-1], ("/api/me", "S1"))
        self.assertEqual(view.evaluate("KinWorkContext.session()"), "S1")

    def test_xhr_abort_before_headers_finishes_once_and_stays_in_the_session(self):
        held = []
        self.context.route(BASE + "/api/held-abort", lambda route: held.append(route))
        view = self.open_viewer()
        view.evaluate("""() => {
          window.events=[];window.xhr=new XMLHttpRequest();xhr.open('GET','/api/held-abort');
          for(const name of ['abort','load','error','loadend'])xhr.addEventListener(name,()=>events.push(name));
          xhr.send();
        }""")
        for _ in range(100):
            if held:
                break
            view.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        view.evaluate("xhr.abort()")
        held.pop().abort()
        view.wait_for_timeout(50)
        self.assertEqual(view.evaluate("events"), ["abort", "loadend"])
        self.assertEqual(view.evaluate("KinWorkContext.state()"), "active")

    def test_restoration_event_keeps_layout_and_checks_the_same_session(self):
        view = self.open_viewer()
        view.locator("#draft").fill("preserved layout and input")
        view.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        for _ in range(100):
            if self.requests:
                break
            view.wait_for_timeout(10)
        self.assertEqual(self.requests, [("/api/me", "S1")])
        self.assertEqual(view.locator("#draft").input_value(), "preserved layout and input")

    def test_preparation_pauses_xhr_delivery_but_not_its_network_deadline(self):
        self.extra_html = """<script>
          window.fetch=(_url,init)=>new Promise((_resolve,reject)=>{
            init.signal.addEventListener('abort',()=>{
              window.networkAborted=true;reject(new DOMException('aborted','AbortError'));
            });
          });
        </script>"""
        view = self.open_viewer()
        view.evaluate("""() => {
          window.events=[];const xhr=new XMLHttpRequest();xhr.open('GET','/api/held');xhr.timeout=200;
          xhr.ontimeout=()=>events.push('timeout');xhr.onloadend=()=>events.push('loadend');xhr.send();
        }""")
        self.notice("session-preparing")
        view.wait_for_function("KinWorkContext.state()==='preparing'")
        # The page's animation scheduler is intentionally paused; observe from the browser driver.
        for _ in range(100):
            if view.evaluate("window.networkAborted===true"):
                break
            view.wait_for_timeout(10)
        self.assertTrue(view.evaluate("window.networkAborted===true"))
        self.assertEqual(view.evaluate("events"), [])
        self.notice("session-resumed")
        view.wait_for_function("events.length===2")
        self.assertEqual(view.evaluate("events"), ["timeout", "loadend"])


if __name__ == "__main__":
    unittest.main()
