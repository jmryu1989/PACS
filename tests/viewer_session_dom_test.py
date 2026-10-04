# coding: utf-8
"""U5S-REQ-04/08/12 + amendments 2/3 -> U5S-RISK-SESSION/APPLY -> VIEWER-SESSION.

Real page gate, transport, viewer authority and complete OHIF config in Chromium.
The server is synthetic. This does not run the pinned OHIF bundle or a GPU renderer.
Mutants can replace one served product file through KIN_VIEWER_SESSION_SOURCE.
"""
import json
import os
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://viewer-session.test"
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SOURCE = Path(os.environ.get("KIN_VIEWER_SESSION_SOURCE", HPACS / "viewer-session.js"))


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
                          body=json.dumps({"code": self.code, "value": "incoming"}), content_type="application/json")
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

    def test_direct_entry_without_a_binding_opens_no_protected_work(self):
        page = self.context.new_page()
        page.goto(BASE + "/ohif/viewer")
        page.wait_for_url(BASE + "/worklist/hpacs-lite/index.html")
        self.assertEqual(self.requests, [])

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
