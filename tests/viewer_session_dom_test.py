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
try:
    from viewer_session_fixture import reject_unbound, unbound_protected_request
except ImportError:
    from tests.viewer_session_fixture import reject_unbound, unbound_protected_request

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://viewer-session.test"
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SOURCE = Path(os.environ.get("KIN_VIEWER_SESSION_SOURCE", HPACS / "viewer-session.js"))
RESOURCE_SOURCE = Path(os.environ.get("KIN_VIEWER_RESOURCE_SOURCE", HPACS / "viewer-resources.js"))
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
        self.unbound = []
        # Even a test-specific held/error route must satisfy the same boundary rule.
        self.context.on('request', lambda request: self.unbound.append((request.url, request.resource_type))
                        if request.url.startswith(BASE + '/') and unbound_protected_request(request) else None)
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
        self.assertEqual(self.unbound, [], 'protected browser loads must never be unbound')

    def route(self, route):
        if reject_unbound(route, self.unbound):
            return
        path = route.request.url[len(BASE):].split("?")[0]
        if path.startswith("/worklist/hpacs-lite/") and path.endswith(".js"):
            name = path.rsplit("/", 1)[-1]
            source = SOURCE if name == "viewer-session.js" else RESOURCE_SOURCE if name == "viewer-resources.js" else HPACS / name
            route.fulfill(body=source.read_text(encoding="utf-8"), content_type="application/javascript; charset=utf-8")
        elif path == "/config.js":
            route.fulfill(body=(ROOT / "config" / "ohif.js").read_text(encoding="utf-8"), content_type="application/javascript; charset=utf-8")
        elif path == "/worklist":
            route.fulfill(body='<script src="/worklist/hpacs-lite/work-context.js"></script>', content_type="text/html")
        elif path == "/ohif/viewer":
            route.fulfill(body=self.extra_html + '''<div id="root"><input id="draft" value="held draft"></div>
              <script src="/config.js"></script><script>
              window.close=()=>{window.closeAttempted=true};
              config.extensions.find(extension=>extension.id==='kin.session-boundary').preRegistration().then(()=>window.started=true);
              </script>''', content_type="text/html; charset=utf-8")
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
        # Main's contract: own the lock before the notice, release on cancellation/end.
        self.opener.evaluate("""async value=>{
          window.preparationLocks ||= new Map();const key=JSON.stringify([value.session,value.preparation]);
          if(value.type==='session-preparing'&&!preparationLocks.has(key))await new Promise(acquired=>{
            navigator.locks.request('kin-preparation:'+value.preparation,()=>new Promise(release=>{
              preparationLocks.set(key,{session:value.session,release});acquired();}));});
          channel.postMessage(value);
          if(value.type==='session-resumed'){preparationLocks.get(key)?.release();preparationLocks.delete(key);}
          if(value.type==='session-ended')for(const [key,item] of preparationLocks)if(item.session===value.session){item.release();preparationLocks.delete(key);}
        }""",
                             {"type": kind, "session": session, "preparation": preparation})

    def preparer(self):
        page = self.context.new_page()
        page.goto(BASE + '/worklist')
        page.evaluate("window.channel=new BroadcastChannel('kin-session')")
        return page

    def hold_lock(self, page, name, mode='exclusive'):
        page.evaluate("""({name,mode})=>new Promise(acquired=>{
          window.releases ||= new Map();
          navigator.locks.request(name,{mode},()=>new Promise(release=>{
            releases.set(name,release);acquired();}));
        })""", {'name': name, 'mode': mode})

    def observe_deferred_reads(self):
        self.context.add_init_script("""(() => {
          window.nativeSends=[];const nativeFetch=window.fetch.bind(window);
          window.fetch=(url,...args)=>{
            if(String(url).includes('/dicom-web/deferred'))nativeSends.push(KinWorkContext.state());
            return nativeFetch(url,...args);
          };
        })();""")

    def queue_image_and_work(self, view):
        view.evaluate("""()=>{
          window.states=[];window.delivered=0;window.events=[];
          KinWorkContext.onInvalidate(e=>states.push(e.state));
          setTimeout(()=>delivered++,0);
          const image=new Image();image.src='/dicom-web/deferred';
          image.onload=()=>events.push('load');image.onerror=()=>events.push('error');
          document.body.append(image);
        }""")

    def test_nonopener_end_then_release_never_resumes_or_sends_30_times(self):
        self.observe_deferred_reads()
        preparer = self.preparer()
        for trial in range(30):
            with self.subTest(trial=trial):
                view = self.open_viewer()
                pid = 'nonopener-' + str(trial)
                self.hold_lock(preparer, 'kin-preparation:' + pid)
                preparer.evaluate("id=>channel.postMessage({type:'session-preparing',session:'S1',preparation:id})", pid)
                view.wait_for_function("KinWorkContext.state()==='preparing'")
                self.queue_image_and_work(view)
                landing = []
                view.route(BASE + '/worklist/hpacs-lite/index.html', lambda route: landing.append(route))
                # The granted marker, end notice and early release share one main task.
                # Early release stresses the viewer even though main normally holds until unload.
                preparer.evaluate("""id=>new Promise(done=>navigator.locks.request('kin-session-ended:S1',()=>
                  new Promise(release=>{releases.set('kin-session-ended:S1',release);
                    channel.postMessage({type:'session-ended',session:'S1'});
                    releases.get('kin-preparation:'+id)();done();})))""", pid)
                for _ in range(100):
                    if landing: break
                    self.opener.wait_for_timeout(10)
                self.assertTrue(landing)
                result = self.opener.evaluate("({states:viewerRef.states,sends:viewerRef.nativeSends,work:viewerRef.delivered,events:viewerRef.events})")
                self.assertEqual(result, {'states':['ending'], 'sends':[], 'work':0, 'events':[]})
                for route in landing: route.abort()
                view.close()
                preparer.evaluate("releases.get('kin-session-ended:S1')()")

    def test_nonopener_cancel_and_close_release_resume_deferred_work(self):
        self.observe_deferred_reads()
        for action in ['cancel', 'close']:
            with self.subTest(action=action):
                preparer = self.preparer()
                view = self.open_viewer()
                self.hold_lock(preparer, 'kin-preparation:separate')
                preparer.evaluate("channel.postMessage({type:'session-preparing',session:'S1',preparation:'separate'})")
                view.wait_for_function("KinWorkContext.state()==='preparing'")
                self.queue_image_and_work(view)
                if action == 'cancel':
                    preparer.evaluate("channel.postMessage({type:'session-resumed',session:'S1',preparation:'separate'});releases.get('kin-preparation:separate')()")
                else:
                    preparer.close()
                view.wait_for_function("delivered===1 && nativeSends.length===1")
                self.assertEqual(view.evaluate('[states,nativeSends]'), [['active'],['active']])
                view.close()
                if not preparer.is_closed(): preparer.close()

    def test_end_marker_blocks_every_resume_path_even_without_end_notice(self):
        self.observe_deferred_reads()
        for path in ['release-held', 'release-pending', 'resumed', 'peer']:
            # Stop on the first assertion so a failed case cannot retain a lock into the next case.
            preparer = self.preparer()
            view = self.open_viewer()
            pid = 'marker-' + path
            if path == 'peer':
                self.opener.evaluate("id=>window.localPreparation=KinWorkContext.prepare({preparationId:id})", pid)
                view.evaluate("navigator.locks.request=()=>Promise.reject(new DOMException('unavailable','NotAllowedError'));void 0")
            self.notice('session-preparing', preparation=pid)
            view.wait_for_function("KinWorkContext.state()==='preparing'")
            self.queue_image_and_work(view)
            landing = []
            view.route(BASE + '/worklist/hpacs-lite/index.html', lambda route: landing.append(route))
            if path == 'release-pending':
                self.hold_lock(preparer, 'kin-session-ended:S1', 'shared')
                preparer.evaluate("navigator.locks.request('kin-session-ended:S1',()=>new Promise(()=>{}));void 0")
                self.assertIn('kin-session-ended:S1', preparer.evaluate('navigator.locks.query().then(q=>q.pending.map(l=>l.name))'))
                # Only the pending exclusive marker remains; hide the shared holder in
                # the snapshot so this independently exercises the pending decision.
                view.evaluate("const query=navigator.locks.query.bind(navigator.locks);navigator.locks.query=async()=>{const q=await query();return {...q,held:q.held.filter(l=>l.name!=='kin-session-ended:S1')}}")
            else:
                self.hold_lock(preparer, 'kin-session-ended:S1')
            if path == 'resumed':
                self.opener.evaluate("id=>channel.postMessage({type:'session-resumed',session:'S1',preparation:id})", pid)
            elif path == 'peer':
                # The readable-peer fallback also checks the marker before cancellation.
                self.opener.evaluate("KinWorkContext.cancelPreparation(localPreparation)")
            else:
                self.opener.evaluate("id=>preparationLocks.get(JSON.stringify(['S1',id])).release()", pid)
            for _ in range(100):
                if landing: break
                self.opener.wait_for_timeout(10)
            self.assertTrue(landing)
            self.assertEqual(self.opener.evaluate('[viewerRef.states,viewerRef.nativeSends,viewerRef.delivered]'), [['ending'],[],0])
            for route in landing: route.abort()
            self.opener.evaluate("id=>preparationLocks.get(JSON.stringify(['S1',id])).release()", pid)
            view.close(); preparer.close()
            self.opener.evaluate("source({state:'active',session:'S1'})")

    def test_startup_end_marker_blocks_opener_handoff_typed_reload_and_frame(self):
        self.context.add_init_script("""(() => {
          let gate;window.entryStates=[];
          Object.defineProperty(window,'KinWorkContext',{get:()=>gate,set:value=>{
            gate=value;gate.onInvalidate(e=>entryStates.push(e.state));
          }});
        })();""")
        for entry in ['opener', 'handoff', 'typed', 'reload', 'restore', 'frame']:
            # Stop on the first assertion so a failed case cannot retain a lock into the next case.
            preparer = self.preparer()
            view = self.open_viewer() if entry in ['reload', 'restore'] else None
            self.hold_lock(preparer, 'kin-session-ended:S1')
            self.requests.clear()
            landing = []
            self.context.route(BASE + '/worklist/hpacs-lite/index.html', lambda route: landing.append(route))
            if entry in ['opener', 'handoff', 'typed']:
                with self.context.expect_page() as created:
                    self.opener.evaluate("""entry=>{
                      const p=window.viewerRef=window.open('/ohif/viewer');
                      if(entry==='handoff')p.name='kin-viewer-entry:'+JSON.stringify({session:'S1',name:'viewer'});
                      if(entry!=='opener')p.opener=null;
                    }""", entry)
                view = created.value
            elif entry == 'reload': view.evaluate('location.reload()')
            elif entry == 'restore': view.evaluate("entryStates=[];dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
            else:
                self.opener.evaluate("const f=document.createElement('iframe');f.id='viewer';f.src='/ohif/viewer';document.body.append(f)")
            for _ in range(100):
                if (entry == 'frame' and self.opener.locator('#viewer').count() == 0) or landing: break
                self.opener.wait_for_timeout(10)
            if entry == 'frame': self.assertEqual(self.opener.locator('#viewer').count(), 0)
            else:
                self.assertTrue(landing)
                self.assertEqual(self.opener.evaluate('viewerRef.KinWorkContext.state()'), 'ending')
                self.assertNotIn('active', self.opener.evaluate('viewerRef.entryStates'))
                if entry != 'restore': self.assertFalse(self.opener.evaluate('!!viewerRef.started'))
                for route in landing: route.abort()
                view.close()
            self.assertEqual(self.requests, [('/api/me',None)] if entry == 'typed' else [])
            self.context.unroute(BASE + '/worklist/hpacs-lite/index.html')
            preparer.close()

    def test_other_sessions_end_during_handoff_does_not_stop_entry(self):
        held = []
        self.context.route(BASE + '/api/me', lambda route: held.append(route))
        view = self.open_noopener('S1')
        for _ in range(100):
            if held: break
            view.wait_for_timeout(10)
        self.assertEqual(len(held), 1)
        self.notice('session-ended', session='S2')
        view.wait_for_timeout(100)
        held[0].fulfill(json={'sessionId':'S1'})
        # Driver polling avoids a timeout-only mutant oracle on the suspended page clock.
        for _ in range(100):
            if view.evaluate("!!window.started || !!document.querySelector('[role=alert]')"): break
            view.wait_for_timeout(10)
        self.assertEqual(view.evaluate('[KinWorkContext.session(),KinWorkContext.state(),!!window.started]'), ['S1','active',True])
        view.evaluate("fetch('/api/studies').then(r=>r.json())")
        self.assertEqual(self.requests, [('/api/studies','S1')])

    def test_removed_elements_send_nothing_and_never_attached_errors_on_resume(self):
        self.observe_deferred_reads()
        view = self.open_viewer()
        self.notice('session-preparing')
        view.wait_for_function("KinWorkContext.state()==='preparing'")
        view.evaluate("""()=>{
          window.events=[];window.readAttempts=[];const fetch=window.fetch.bind(window);
          window.fetch=(url,...args)=>{readAttempts.push(String(url));return fetch(url,...args);};
          for(const kind of ['never','brief','removed','reattached']){
            const image=new Image();image.id=kind;
            image.onload=()=>events.push(kind+'-load');image.onerror=()=>events.push(kind+'-error');
            image.src='/dicom-web/deferred-'+kind;
            if(kind!=='never')document.body.append(image);
            if(kind==='brief')image.remove();
          }
        }""")
        # Let the observer see the two persistent elements, then retire their reads.
        view.wait_for_timeout(30)
        view.evaluate("window.retired=document.getElementById('reattached');retired.remove();document.getElementById('removed').remove()")
        view.wait_for_timeout(30)
        view.evaluate('document.body.append(retired)')
        self.notice('session-resumed')
        view.wait_for_function("KinWorkContext.state()==='active'")
        view.wait_for_timeout(150)
        # Check retirement at the browser fetch API as well as at native send. The page
        # transport's independent abort defence must not hide a restarted retired read.
        self.assertEqual(view.evaluate('readAttempts'), [])
        self.assertEqual(view.evaluate('nativeSends'), [])
        self.assertEqual(self.requests, [])
        self.assertEqual(view.evaluate('events'), ['never-error'])

    def test_never_attached_image_and_media_settle_with_error_while_active(self):
        view = self.open_viewer()
        view.evaluate("""()=>{
          window.events=[];
          for(const element of [new Image(),document.createElement('video'),document.createElement('audio')]){
            element.onload=()=>events.push(element.tagName+'-load');
            element.onerror=()=>events.push(element.tagName+'-error');
            element.src='/dicom-web/detached';
          }
        }""")
        for _ in range(200):
            if view.evaluate('events.length===3'): break
            view.wait_for_timeout(10)
        self.assertEqual(view.evaluate('events.sort()'), ['AUDIO-error','IMG-error','VIDEO-error'])
        self.assertEqual(self.requests, [])

    def test_both_locks_vanish_with_end_record_ends_without_notice(self):
        self.observe_deferred_reads()
        for storage in ['localStorage', 'cookie']:
            for trial in range(2):
                preparer = self.preparer()
                view = self.open_viewer()
                self.hold_lock(preparer, 'kin-preparation:vanishing')
                preparer.evaluate("channel.postMessage({type:'session-preparing',session:'S1',preparation:'vanishing'})")
                view.wait_for_function("KinWorkContext.state()==='preparing'")
                self.queue_image_and_work(view)
                self.hold_lock(preparer, 'kin-session-ended:S1')
                # Storage delivery can close the viewer before evaluate returns. Observe
                # navigation before either end signal, independent of browser queue order.
                landing = []
                view.route(BASE + '/worklist/hpacs-lite/index.html', lambda route: landing.append(route))
                preparer.evaluate("""storage=>{
                  const record=JSON.stringify({session:'S1',status:'ending'});
                  if(storage==='cookie')document.cookie='kin-session-end='+encodeURIComponent(record)+';path=/';
                  else localStorage.setItem('kin-session-end',record);
                }""", storage)
                preparer.close()
                for _ in range(200):
                    if landing: break
                    self.opener.wait_for_timeout(10)
                self.assertTrue(landing, (storage, trial))
                self.assertEqual(self.opener.evaluate('({states:viewerRef.states,sends:viewerRef.nativeSends,events:viewerRef.events,work:viewerRef.delivered,body:viewerRef.document.body.textContent})'),
                                 {'states':['ending'],'sends':[],'events':[],'work':0,'body':''})
                self.assertEqual(self.requests, [])
                for route in landing: route.abort()
                view.close()
                self.opener.evaluate("localStorage.removeItem('kin-session-end');document.cookie='kin-session-end=;max-age=0;path=/'")

    def test_both_locks_vanish_without_matching_end_record_resumes_and_loads(self):
        self.observe_deferred_reads()
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
        self.context.route(BASE + '/dicom-web/deferred', lambda route: (
            self.requests.append(('/dicom-web/deferred', route.request.headers.get('x-kin-session'))),
            route.fulfill(body=png, content_type='image/png')))
        for record in [None, 'invalid-json', '{"session":"S2"}']:
            preparer = self.preparer()
            view = self.open_viewer()
            self.hold_lock(preparer, 'kin-preparation:vanishing')
            preparer.evaluate("channel.postMessage({type:'session-preparing',session:'S1',preparation:'vanishing'})")
            view.wait_for_function("KinWorkContext.state()==='preparing'")
            self.queue_image_and_work(view)
            self.hold_lock(preparer, 'kin-session-ended:S1')
            if record is not None: preparer.evaluate("r=>localStorage.setItem('kin-session-end',r)", record)
            preparer.close()
            for _ in range(200):
                if view.evaluate("events.includes('load')"): break
                view.wait_for_timeout(10)
            self.assertEqual(view.evaluate('[states,nativeSends,events,delivered]'), [['active'],['active'],['load'],1], record)
            self.assertEqual(self.requests, [('/dicom-web/deferred','S1')])
            self.requests.clear()
            view.close()
            self.opener.evaluate("localStorage.removeItem('kin-session-end')")

    def test_end_record_blocks_bound_startup_without_web_locks(self):
        self.context.add_init_script("Object.defineProperty(navigator,'locks',{value:undefined})")
        for storage in ['localStorage', 'cookie']:
            self.opener.evaluate("""storage=>{
              const record=JSON.stringify({session:'S1',status:'ending'});
              if(storage==='cookie')document.cookie='kin-session-end='+encodeURIComponent(record)+';path=/';
              else localStorage.setItem('kin-session-end',record);
            }""", storage)
            landing = []
            self.context.route(BASE + '/worklist/hpacs-lite/index.html', lambda route: landing.append(route))
            with self.context.expect_page() as created:
                self.opener.evaluate("window.viewerRef=window.open('/ohif/viewer')")
            view = created.value
            for _ in range(200):
                if landing: break
                self.opener.wait_for_timeout(10)
            self.assertTrue(landing, storage)
            self.assertEqual(self.opener.evaluate('viewerRef.KinWorkContext.state()'), 'ending')
            self.assertFalse(self.opener.evaluate('!!viewerRef.started'))
            self.assertEqual(self.requests, [])
            for route in landing: route.abort()
            view.close()
            self.context.unroute(BASE + '/worklist/hpacs-lite/index.html')
            self.opener.evaluate("localStorage.removeItem('kin-session-end');document.cookie='kin-session-end=;max-age=0;path=/'")


    def test_router_reload_cannot_adopt_replacement_session(self):
        view = self.open_viewer()
        view.evaluate("history.pushState({router:'next'},'',location.href+'&layout=2')")
        self.server_session = 'S2'
        self.opener.evaluate("window.KinWorkContext={session:()=> 'S2',state:()=> 'active'}")
        view.reload()
        view.wait_for_function('window.started===true')
        view.evaluate("fetch('/api/studies').then(r=>r.json())")
        self.assertEqual(view.evaluate('KinWorkContext.session()'), 'S1')
        self.assertEqual(self.requests, [('/api/studies', 'S1')])

    def test_ended_history_reload_and_back_send_and_paint_nothing(self):
        self.context.add_init_script('window.restoreBrowserHistory=history.replaceState.bind(history)')
        view = self.open_viewer()
        # Keep the ended entry while exercising real reload/back. The page gate alone must
        # prevent work; no opener end or server rejection is available to rescue the mutant.
        view.evaluate("restoreBrowserHistory({...history.state,kinViewerSession:{session:'S1',ended:true}},'')")
        for back in [False, True]:
            if back:
                view.goto(BASE + '/elsewhere')
                view.go_back()
            else:
                view.reload()
            for _ in range(100):
                if view.url.endswith('/index.html'): break
                view.wait_for_timeout(10)
            self.assertEqual(view.url, BASE + '/worklist/hpacs-lite/index.html')
            self.assertEqual(view.locator('#root').count(), 0)
            self.assertEqual(self.requests, [])
            if not back:
                # The landing replaces an ended entry; reconstruct a restored browser entry.
                view.goto(BASE + '/ohif/viewer')
                view.wait_for_function('window.started===true')
                view.evaluate("restoreBrowserHistory({...history.state,kinViewerSession:{session:'S1',ended:true}},'')")

    def test_opener_ending_without_notice_ends_within_one_poll(self):
        view = self.open_viewer()
        self.opener.evaluate("source({state:'ending',session:'S1'})")
        view.wait_for_timeout(550)
        self.assertEqual(view.url, BASE + '/worklist/hpacs-lite/index.html')
        self.assertEqual(view.locator('#root').count(), 0)
        self.assertEqual(self.requests, [])

    def test_other_origin_fetch_and_xhr_never_carry_session_or_csrf(self):
        view = self.open_viewer()
        seen = []
        def outside(route):
            seen.append(route.request.headers)
            route.fulfill(body='{}', content_type='application/json', headers={'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS'})
        self.context.route('https://external.test/**', outside)
        for path in ['/api/me', '/dicom-web/studies']:
            url = 'https://external.test' + path
            view.evaluate('url=>fetch(url).then(r=>r.text())', url)
            view.evaluate("""url=>new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET',url);
              x.onload=()=>resolve(x.status);x.onerror=reject;x.send();})""", url)
        self.assertEqual(len(seen), 4)
        for headers in seen:
            self.assertNotIn('x-kin-session', headers)
            self.assertNotIn('x-kin-csrf', headers)

    def test_preparation_lock_releases_after_preparer_closes_or_navigates(self):
        for action in ['closed', 'navigate']:
            with self.subTest(action=action):
                if self.opener.is_closed() or self.opener.url != BASE + '/worklist':
                    self.opener = self.context.new_page()
                    self.opener.goto(BASE + '/worklist')
                    self.opener.evaluate("KinWorkContext.follow({onLifecycle(fn){window.source=fn;fn({state:'active',session:'S1'})}});window.channel=new BroadcastChannel('kin-session')")
                view = self.open_viewer()
                self.opener.evaluate("window.preparation=KinWorkContext.prepare({preparationId:'lock-X'})")
                self.notice('session-preparing', preparation='lock-X')
                view.wait_for_function("KinWorkContext.state()==='preparing'")
                view.evaluate("window.delivered=0;setTimeout(()=>delivered++,1)")
                if action == 'closed':
                    # A different main document can disappear without taking its viewers away.
                    self.opener.close()
                elif action == 'navigate':
                    self.opener.goto(BASE + '/elsewhere')
                view.wait_for_function("KinWorkContext.state()==='active'", timeout=2000)
                self.assertEqual(view.evaluate('[KinWorkContext.state(),delivered]'), ['active',1])
                view.locator('#draft').fill('continued draft')
                self.assertEqual(view.locator('#draft').input_value(), 'continued draft')
                view.close()
                self.opener = self.context.new_page()
                self.opener.goto(BASE + '/worklist')
                self.opener.evaluate("KinWorkContext.follow({onLifecycle(fn){window.source=fn;fn({state:'active',session:'S1'})}});window.channel=new BroadcastChannel('kin-session')")

    def test_held_lock_keeps_pause_without_renewals_and_another_lock_does_not_hold_it(self):
        view = self.open_viewer()
        self.notice('session-preparing', preparation='lock-X')
        view.wait_for_function("KinWorkContext.state()==='preparing'")
        view.evaluate("window.delivered=0;setTimeout(()=>delivered++,1)")
        view.wait_for_timeout(8500)
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'preparing')
        view.locator('#draft').press('End'); view.keyboard.type('forbidden')
        self.assertEqual(view.locator('#draft').input_value(), 'held draft')
        self.assertEqual(view.evaluate('delivered'), 0)
        self.notice('session-preparing', preparation='lock-Y')
        self.opener.evaluate("preparationLocks.get(JSON.stringify(['S1','lock-X'])).release()")
        view.wait_for_function("KinWorkContext.state()==='active'", timeout=2000)
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'active')
        self.assertEqual(view.evaluate('delivered'), 1)
        self.assertEqual(view.locator('#draft').input_value(), 'held draft')

    def test_readable_preparing_peer_keeps_pause_without_a_lock(self):
        self.opener.evaluate("window.preparation=KinWorkContext.prepare({preparationId:'readable-X'})")
        view = self.open_viewer()
        view.wait_for_timeout(7500)
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'preparing')
        self.opener.close()
        view.wait_for_function("KinWorkContext.state()==='active'", timeout=2000)

    def test_end_disposes_while_the_preparer_still_holds_its_lock(self):
        view=self.open_viewer(); self.notice('session-preparing',preparation='held-at-end')
        view.wait_for_function("KinWorkContext.state()==='preparing'")
        held=[]; view.route(BASE+'/worklist/hpacs-lite/index.html',lambda route:held.append(route))
        self.opener.evaluate("channel.postMessage({type:'session-ended',session:'S1'})")
        for _ in range(100):
            if held: break
            view.wait_for_timeout(10)
        self.assertTrue(held)
        self.assertEqual(self.opener.evaluate('viewerRef.KinWorkContext.state()'),'ending')
        self.assertEqual(self.opener.evaluate('viewerRef.document.body.textContent'),'')
        self.assertIn('kin-preparation:held-at-end',self.opener.evaluate('navigator.locks.query().then(q=>q.held.map(l=>l.name))'))
        self.assertEqual(self.opener.evaluate('navigator.locks.query().then(q=>q.pending.length)'),0)
        for route in held: route.abort()

    def test_lock_release_observes_opener_end_before_delivering_work_without_a_notice(self):
        with self.context.expect_page() as created:
            self.opener.evaluate("window.viewerRef=window.open('about:blank')")
        view=created.value
        view.clock.install(); view.clock.pause_at(view.evaluate('Date.now()'))
        view.goto(BASE+'/ohif/viewer?StudyInstanceUIDs=1.2.3')
        for _ in range(200):
            if view.evaluate('!!window.KinViewerSessionBoundary'): break
            view.wait_for_timeout(10)
        self.notice('session-preparing',preparation='ending-without-notice')
        for _ in range(100):
            if view.evaluate("KinWorkContext.state()==='preparing'"): break
            view.wait_for_timeout(10)
        self.assertEqual(view.evaluate('KinWorkContext.state()'),'preparing')
        view.evaluate("const i=new Image();i.src='/dicom-web/must-not-start';document.body.append(i)")
        held=[]; view.route(BASE+'/worklist/hpacs-lite/index.html',lambda route:held.append(route))
        self.opener.evaluate("""()=>{source({state:'ending',session:'S1'});
          preparationLocks.get(JSON.stringify(['S1','ending-without-notice'])).release();}""")
        for _ in range(100):
            if held: break
            view.wait_for_timeout(10)
        self.assertTrue(held,'the lock release observes the end even with the viewer polling clock stopped')
        self.assertEqual(self.requests,[],'no deferred resource starts between lock release and the end')
        self.assertEqual(self.opener.evaluate('viewerRef.document.body.textContent'),'')
        for route in held: route.abort()

    def test_no_locks_uses_readable_peer_and_notices_never_silence(self):
        self.context.add_init_script("Object.defineProperty(navigator,'locks',{value:undefined})")
        self.opener.evaluate("window.preparation=KinWorkContext.prepare({preparationId:'fallback-X'})")
        view = self.open_viewer()
        view.wait_for_timeout(7000)
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'preparing')
        self.opener.goto(BASE + '/elsewhere')
        view.wait_for_function("KinWorkContext.state()==='active'", timeout=2000)
        self.opener.evaluate("window.channel=new BroadcastChannel('kin-session')")
        self.opener.evaluate("channel.postMessage({type:'session-preparing',session:'S1',preparation:'unreadable'})")
        view.wait_for_function("KinWorkContext.state()==='preparing'")
        view.wait_for_timeout(7000)
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'preparing')
        self.opener.evaluate("channel.postMessage({type:'session-resumed',session:'S1',preparation:'unreadable'})")
        view.wait_for_function("KinWorkContext.state()==='active'")

    def test_opened_during_preparation_resumes_on_notice_after_main_reprepares(self):
        self.opener.evaluate("window.preparation=KinWorkContext.prepare({preparationId:'live-opaque-id'})")
        view = self.open_viewer()
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'preparing')
        self.opener.evaluate("KinWorkContext.cancelPreparation(preparation);window.preparation=KinWorkContext.prepare({preparationId:'live-opaque-id'})")
        self.notice('session-resumed', preparation='live-opaque-id')
        view.wait_for_timeout(100)
        self.assertEqual(view.evaluate('KinWorkContext.state()'), 'active', 'the matching notice resumes immediately')
        self.assertEqual(view.locator('#draft').input_value(), 'held draft')

    def test_noopener_transient_bootstrap_retries_without_closing(self):
        for status, code in [(503, 'AUTH_IDP_UNAVAILABLE'), (500, None), (401, None), (403, None)]:
            with self.subTest(status=status):
                self.status, self.code = status, code
                page = self.context.new_page()
                page.clock.install()
                page.goto(BASE + '/ohif/viewer')
                for _ in range(100):
                    if '/ohif/viewer' not in page.url or page.evaluate('!!window.KinViewerSessionBoundary'): break
                    page.wait_for_timeout(10)
                page.wait_for_timeout(50)
                self.assertIn('/ohif/viewer', page.url)
                self.assertEqual(page.evaluate('KinWorkContext.state()'), 'unknown')
                self.assertFalse(page.evaluate('!!window.closeAttempted'))
                self.assertEqual(page.evaluate("fetch('/api/studies').catch(e=>e.transport)"), 'not-admitted')
                self.status, self.code = 200, None
                page.clock.run_for(1100)
                page.wait_for_function('window.started===true')
                self.assertEqual(page.evaluate('KinWorkContext.session()'), 'S1')
                page.close()

    def test_noopener_offline_timeout_and_exhausted_budget_offer_in_document_retry(self):
        for failure in ['offline', 'timeout', 'http']:
            with self.subTest(failure=failure):
                page = self.context.new_page(); page.clock.install()
                held = []
                def fail(route):
                    if failure == 'offline': route.abort('internetdisconnected')
                    elif failure == 'timeout': held.append(route)
                    else: route.fulfill(status=503, body='{}', content_type='application/json')
                page.route(BASE + '/api/me', fail)
                page.goto(BASE + '/ohif/viewer')
                page.wait_for_function("window.KinViewerSessionBoundary && KinWorkContext.state()==='unknown'")
                for _ in range(6):
                    page.clock.run_for(11000); page.wait_for_timeout(30)
                self.assertEqual(page.get_by_role('button', name='Retry').count(), 1)
                self.assertFalse(page.evaluate('!!window.closeAttempted'))
                self.assertEqual(page.evaluate('KinWorkContext.state()'), 'unknown')
                page.unroute(BASE + '/api/me', fail)
                page.get_by_role('button', name='Retry').click()
                page.wait_for_function('window.started===true')
                self.assertEqual(page.evaluate('KinWorkContext.session()'), 'S1')
                for route in held:
                    try: route.abort()
                    except Exception: pass  # the native bootstrap deadline already aborted it
                page.close()

    def test_bootstrap_confirmed_absence_or_member_refusal_ends(self):
        for status, code in [(401, 'AUTH_CREDENTIALS_MISSING'), (401, 'AUTH_SESSION_ENDED'),
                             (403, 'INSTITUTION_PENDING'), (403, 'INSTITUTION_INVALID')]:
            self.status, self.code = status, code
            page = self.context.new_page(); page.goto(BASE + '/ohif/viewer')
            page.wait_for_url(BASE + '/worklist/hpacs-lite/index.html')
            self.assertEqual(page.locator('#root').count(), 0)
            page.close()

    def open_noopener(self, expected='S1'):
        with self.context.expect_page() as created:
            self.opener.evaluate("""expected=>{const p=window.open('/ohif/viewer?StudyInstanceUIDs=1.2.3','_blank');
              if(expected)p.name='kin-viewer-entry:'+JSON.stringify({session:expected,name:'clinician-viewer'});
              p.opener=null;}""", expected)
        return created.value

    def expect_reopen_notice(self, page):
        # An unresolved viewer deliberately suspends requestAnimationFrame. Observe its
        # visible notice from the driver instead of waiting in the blocked page scheduler.
        for _ in range(200):
            if page.get_by_role('alert').count() and '목록에서' in page.get_by_role('alert').inner_text(): break
            page.wait_for_timeout(10)
        self.assertIn('목록에서',page.get_by_role('alert').inner_text())

    def test_noopener_expected_session_is_consumed_without_click_or_address_leak(self):
        page = self.open_noopener()
        page.wait_for_function('window.started===true')
        self.assertEqual(page.evaluate('[KinWorkContext.session(),window.name,window.opener]'), ['S1','clinician-viewer',None])
        self.assertEqual(page.url, BASE+'/ohif/viewer?StudyInstanceUIDs=1.2.3')
        self.assertEqual(page.get_by_role('alert').count(), 0)
        self.assertEqual(self.requests, [('/api/me',None)])
        page.goto(BASE+'/elsewhere')
        self.assertEqual(page.evaluate('window.name'), 'clinician-viewer')
        self.assertIsNone(page.evaluate('history.state?.kinViewerSession'))

    def test_noopener_retry_never_adopts_a_replacement_with_or_without_end_notice(self):
        for expected, hear_end in [('S1',False),('S1',True),(None,True)]:
            with self.subTest(expected=expected, hear_end=hear_end):
                self.status, self.code, self.server_session = 503, 'AUTH_IDP_UNAVAILABLE', 'S1'
                page = self.open_noopener(expected)
                page.get_by_role('button',name='Retry').wait_for(timeout=8000)
                if hear_end: self.notice('session-ended'); page.wait_for_timeout(100)
                self.status, self.code, self.server_session = 200, None, 'S2'
                page.get_by_role('button',name='Retry').click()
                self.expect_reopen_notice(page)
                self.assertEqual(page.evaluate('[KinWorkContext.session(),KinWorkContext.state(),!!window.started]'), [None,'unknown',False])
                self.assertEqual(page.get_by_role('button',name='Retry').count(), 0)
                self.assertFalse(page.evaluate('!!window.closeAttempted'))
                page.reload()
                self.expect_reopen_notice(page)
                self.assertIsNone(page.evaluate('KinWorkContext.session()'))
                page.close()
        self.assertFalse(any(binding for _,binding in self.requests))

    def test_retry_notice_reload_repeats_original_expected_session_verification(self):
        for server_session in ['S1','S2']:
            with self.subTest(server=server_session):
                self.status, self.code, self.server_session = 503, 'AUTH_IDP_UNAVAILABLE', 'S1'
                page = self.open_noopener()
                page.get_by_role('button',name='Retry').wait_for(timeout=8000)
                self.status, self.code, self.server_session = 200, None, server_session
                page.reload()
                if server_session == 'S1':
                    page.wait_for_function('window.started===true')
                    self.assertEqual(page.evaluate('KinWorkContext.session()'), 'S1')
                else:
                    self.expect_reopen_notice(page)
                    self.assertIsNone(page.evaluate('KinWorkContext.session()'))
                self.assertFalse(page.evaluate('!!window.closeAttempted'))
                self.assertIn('/ohif/viewer',page.url)
                page.close()

    def test_handoff_survives_reload_when_boundary_script_loading_failed(self):
        self.context.route(BASE+'/worklist/hpacs-lite/viewer-session.js',lambda route:route.abort())
        page=self.open_noopener()
        page.wait_for_load_state('load')
        self.assertEqual(page.evaluate('window.name'),'clinician-viewer')
        self.context.unroute(BASE+'/worklist/hpacs-lite/viewer-session.js')
        self.server_session='S2'; page.reload()
        self.expect_reopen_notice(page)
        self.assertIsNone(page.evaluate('KinWorkContext.session()'))

    def test_reopen_from_list_verifies_a_new_handoff_in_the_same_named_window(self):
        self.server_session='S2';page=self.open_noopener('S1');self.expect_reopen_notice(page)
        with page.expect_navigation():
            self.opener.evaluate("""()=>{const p=window.open('/ohif/viewer?StudyInstanceUIDs=1.2.3','clinician-viewer');
              p.name='kin-viewer-entry:'+JSON.stringify({session:'S2',name:'clinician-viewer'});p.opener=null;}""")
        page.wait_for_function('window.started===true')
        self.assertEqual(len(self.context.pages),2)
        self.assertEqual(page.evaluate('KinWorkContext.session()'),'S2')
        self.assertEqual(page.get_by_role('alert').count(),0)
        page.evaluate("fetch('/api/studies').then(r=>r.json())")
        self.assertEqual(self.requests,[('/api/me',None),('/api/me',None),('/api/studies','S2')])

    def test_protected_element_load_waits_for_resume_or_entry_and_drops_at_end(self):
        # Observe the native send boundary too: a request aborted during teardown can
        # disappear before Playwright's route callback, but must still fail this test.
        self.context.add_init_script("""(() => {
          window.deferredSends=[];const nativeFetch=window.fetch.bind(window);
          window.fetch=(url,...args)=>{
            if(new URL(url,location.href).pathname==='/dicom-web/deferred')
              deferredSends.push(KinWorkContext.state());
            return nativeFetch(url,...args);
          };
        })();""")
        for phase in ['preparing','unknown','end']:
            with self.subTest(phase=phase):
                held=[]; sent=[]
                def image_response(route):
                    sent.append(route.request.headers.get('x-kin-session'))
                    route.fulfill(body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),content_type='image/png')
                self.context.route(BASE+'/dicom-web/deferred',image_response)
                if phase=='unknown':
                    self.context.route(BASE+'/api/me',lambda route:held.append(route))
                    view=self.open_noopener()
                    view.wait_for_function('!!window.KinViewerSessionBoundary')
                else:
                    view=self.open_viewer(); self.notice('session-preparing')
                    view.wait_for_function("KinWorkContext.state()==='preparing'")
                view.evaluate("""()=>{window.events=[];const i=document.createElement('img');i.id='deferred';
                  i.onload=()=>events.push('load:'+KinWorkContext.state());i.onerror=()=>events.push('error:'+KinWorkContext.state());
                  i.src='/dicom-web/deferred';document.body.append(i);}""")
                view.wait_for_timeout(100)
                self.assertEqual(sent,[]); self.assertEqual(view.evaluate('events'),[])
                self.assertEqual(view.evaluate('deferredSends'),[])
                if phase=='end':
                    landing=[];view.route(BASE+'/worklist/hpacs-lite/index.html',lambda route:landing.append(route))
                    # The sender closes its gate before broadcasting/releasing its lock
                    # (auth.js logout contract). Otherwise a lock-first callback sees an
                    # active opener and legitimately resumes before the end notice arrives.
                    self.opener.evaluate("source({state:'ending',session:'S1'})")
                    self.notice('session-ended')
                    for _ in range(100):
                        if landing: break
                        view.wait_for_timeout(10)
                    self.assertTrue(landing, 'the viewer must finish its end transition')
                    self.assertEqual(self.opener.evaluate('viewerRef.KinWorkContext.state()'),'ending')
                    self.assertEqual(self.opener.evaluate('viewerRef.deferredSends'),[])
                    self.assertEqual(sent,[])
                    self.assertEqual(self.opener.evaluate('viewerRef.events'),[])
                    for route in landing: route.abort()
                else:
                    if phase=='unknown':
                        held[0].fulfill(json={'sessionId':'S1'})
                        self.context.unroute(BASE+'/api/me')
                    else: self.notice('session-resumed')
                    view.wait_for_function("events.length===1")
                    self.assertEqual(view.evaluate('events'),['load:active'])
                    self.assertEqual(sent,['S1'])
                    self.assertEqual(view.evaluate('deferredSends'),['active'])
                view.close(); self.context.unroute(BASE+'/dicom-web/deferred',image_response)

    def hold_ended_viewer(self, view):
        held=[];view.route(BASE+'/worklist/hpacs-lite/index.html',lambda route:held.append(route))
        self.notice('session-ended')
        for _ in range(100):
            if held: break
            view.wait_for_timeout(10)
        self.assertTrue(held)
        return held

    def test_end_revokes_owned_blobs_that_were_never_attached(self):
        view=self.open_viewer()
        urls=view.evaluate("[URL.createObjectURL(new Blob(['decoder'])),URL.createObjectURL(new Blob(['print']))]")
        self.assertEqual(view.evaluate('urls=>Promise.all(urls.map(u=>fetch(u).then(r=>r.text())))',urls),['decoder','print'])
        held=self.hold_ended_viewer(view)
        self.assertEqual(self.opener.evaluate('urls=>Promise.all(urls.map(u=>viewerRef.fetch(u).then(()=>true,()=>false)))',urls),[False,False])
        for route in held: route.abort()

    def test_create_object_url_is_refused_after_session_end(self):
        view=self.open_viewer();held=self.hold_ended_viewer(view)
        self.assertEqual(self.opener.evaluate("()=>{try{viewerRef.URL.createObjectURL(new Blob(['late']));return 'created'}catch(e){return e.name}}"),'AbortError')
        for route in held: route.abort()

    def test_two_elements_share_resource_until_the_last_reference_is_removed(self):
        view=self.open_viewer()
        self.context.route(BASE+'/instances/shared/pdf',lambda route:route.fulfill(body=b'%PDF-shared',content_type='application/pdf'))
        url=view.evaluate("""async()=>{const url=await KinViewerResource.read('/instances/shared/pdf');window.shared=[];
          for(let n=0;n<2;n++){const e=document.createElement('object');document.body.append(e);e.data=url;shared.push(e);}return url;}""")
        view.evaluate('shared[0].remove()');view.wait_for_timeout(50)
        self.assertEqual(view.evaluate('u=>fetch(u).then(r=>r.text()).catch(()=>null)',url),'%PDF-shared')
        view.evaluate('shared[1].remove()');view.wait_for_timeout(50)
        self.assertFalse(view.evaluate('u=>fetch(u).then(()=>true,()=>false)',url))

    def test_protected_native_elements_use_owned_blobs_and_release_on_close_and_end(self):
        view = self.open_viewer()
        def media(route):
            if reject_unbound(route, self.unbound): return
            self.requests.append((route.request.url.split(BASE)[1], route.request.headers.get('x-kin-session')))
            route.fulfill(body=b'%PDF-1.4\n%%EOF', content_type='application/pdf')
        self.context.route(BASE + '/instances/**', media)
        urls = view.evaluate("""async()=>{
          window.resources=[];
          for(const [tag,attr] of [['object','data'],['iframe','src'],['embed','src'],['img','src'],['video','src'],['video','poster'],['audio','src'],['source','src']]){
            const element=document.createElement(tag);document.body.append(element);resources.push({element,attr});
            if(resources.length%2)element[attr]='/instances/'+resources.length+'/pdf';else element.setAttribute(attr,'/instances/'+resources.length+'/pdf');
          }
        }""")
        view.wait_for_function("resources.every(({element,attr})=>element.getAttribute(attr)?.startsWith('blob:'))")
        urls = view.evaluate("resources.map(({element,attr})=>element.getAttribute(attr))")
        self.assertEqual(len(self.requests), 8)
        self.assertTrue(all(session == 'S1' for _, session in self.requests))
        view.evaluate('resources[0].element.remove()')
        view.wait_for_function('url=>!KinViewerResource.has(url)', arg=urls[0])
        self.assertEqual(view.evaluate('url=>fetch(url).then(()=>true,()=>false)', urls[0]), False)
        view.evaluate('window.savedBlobUrls=resources.map(({element,attr})=>element.getAttribute(attr))')
        held = []
        view.route(BASE + '/worklist/hpacs-lite/index.html', lambda route: held.append(route))
        self.notice('session-ended')
        for _ in range(100):
            if held: break
            view.wait_for_timeout(10)
        self.assertTrue(self.opener.evaluate('viewerRef.savedBlobUrls.every(url=>!viewerRef.KinViewerResource.has(url))'))
        self.assertEqual(self.opener.evaluate('viewerRef.document.querySelectorAll("object,iframe,img,video,audio,embed").length'), 0)
        for route in held: route.abort()



    def test_derived_batch_frame_urls_survive_previous_next_until_owner_releases(self):
        view=self.open_viewer()
        result=view.evaluate("""async()=>{
          const a=URL.createObjectURL(new Blob(['frame-a'])),b=URL.createObjectURL(new Blob(['frame-b']));
          const img=document.createElement('img');document.body.append(img);
          img.src=a;img.src=b;img.src=a;img.remove();
          await Promise.resolve();
          const before=await Promise.all([a,b].map(url=>fetch(url).then(r=>r.text())));
          URL.revokeObjectURL(a);URL.revokeObjectURL(b);
          return {before,after:[a,b].map(url=>KinViewerResource.has(url))};
        }""")
        self.assertEqual(result,{'before':['frame-a','frame-b'],'after':[False,False]})

    def test_native_pdf_and_source_panel_use_bound_bytes_under_the_viewer_csp(self):
        policy = next(line.split('"')[1] for line in (ROOT/'proxy/nginx.conf.template').read_text(encoding='utf-8').splitlines()
                      if 'add_header Content-Security-Policy' in line)
        def document(route):
            route.fulfill(body=self.extra_html + '<div id="root"><div id="kin-viewer-layout"></div></div>'
                '<script src="/config.js"></script><script>window.close=()=>{};config.extensions[0].preRegistration().then(()=>window.started=true)</script>',
                content_type='text/html', headers={'Content-Security-Policy': policy})
        self.context.route(BASE+'/ohif/viewer?*', document)
        def answer(route):
            if reject_unbound(route, self.unbound): return
            path=route.request.url.split(BASE)[1]
            self.requests.append((path, route.request.headers.get('x-kin-session')))
            if path.startswith('/instances/'):
                route.fulfill(body=b'%PDF-1.4\n%%EOF', content_type='application/pdf'); return
            body={'kind':'member','institution':'I1','sub':'reader','sessionId':'S1'} if path=='/api/me' else (
                {'id':'aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee'} if path=='/api/dicom/lookup' else {'studies':[{'uid':'1.2.3','id':'SYNTHETIC'}]})
            route.fulfill(body=json.dumps(body), content_type='application/json')
        for path in ['/api/**','/instances/**']:
            self.context.route(BASE+path,answer)
        view=self.open_viewer()
        view.add_script_tag(url=BASE+'/worklist/hpacs-lite/viewer-dicom-pdf.js')
        view.evaluate("""async()=>{
          window.cspFailures=[];addEventListener('securitypolicyviolation',e=>cspFailures.push(e.effectiveDirective));
          const sop='1.2.840.10008.5.1.4.1.1.104.1';
          const ds={displaySetInstanceUID:'pdf1',SOPClassHandlerId:'@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf',
            SOPClassUID:sop,StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.4',SOPInstanceUID:'1.2.5',
            pdfUrl:Promise.resolve(location.origin+'/dicom-web/studies/1.2.3/series/1.2.4/instances/1.2.5/rendered'),
            instance:{SOPClassUID:sop,StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.4',SOPInstanceUID:'1.2.5',PatientID:'SYNTHETIC',MIMETypeOfEncapsulatedDocument:'application/pdf',EncapsulatedDocument:{}}};
          const entry={component:props=>({key:props.key,props})};
          window.pdfGuard=kinDicomPdfViewportGuard({getModuleEntry:()=>entry});pdfGuard.install();pdfGuard.activate();
          const result=entry.component({displaySets:[ds]});window.pdfBlob=await result.props.displaySets[0].pdfUrl;
          const object=document.createElement('object');object.type='application/pdf';object.data=pdfBlob;document.querySelector('#root').append(object);
          const state={activeViewportId:'vp1',viewports:new Map([['vp1',{viewportId:'vp1',displaySetInstanceUIDs:['pdf1']}]])};
          window.pdfPanel=KinDicomPdf.create({viewportGridService:{getState:()=>state},displaySetService:{getDisplaySetByUID:()=>ds}});pdfPanel.mount();
        }""")
        for _ in range(200):
            if view.evaluate("!document.querySelector('#kin-source-pdf-open').disabled"): break
            view.wait_for_timeout(10)
        view.locator('#kin-source-pdf-open').click()
        for _ in range(200):
            if view.evaluate("!!document.querySelector('dialog[open] iframe')"): break
            view.wait_for_timeout(10)
        urls=view.evaluate("[pdfBlob,document.querySelector('dialog iframe').src]")
        self.assertTrue(all(url.startswith('blob:') for url in urls))
        self.assertTrue(all(binding=='S1' for _,binding in self.requests))
        self.assertEqual(len(self.context.pages),2,'Source PDF stays in the viewer document')
        self.assertEqual(view.evaluate('cspFailures'),[])
        view.get_by_role('button',name='Close',exact=True).click()
        self.assertFalse(view.evaluate('url=>KinViewerResource.has(url)',urls[1]))
        view.evaluate('pdfGuard.deactivate()')
        self.assertFalse(view.evaluate('url=>KinViewerResource.has(url)',urls[0]))

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

    def test_xhr_repeated_values_of_one_header_all_reach_the_server(self):
        """The DICOMweb client names a request's own Accept, then the data source's default one. Orthanc answers
        series metadata only while the JSON type is still in the list, so both values must arrive, as XHR sends them."""
        view = self.open_viewer(); seen = []
        self.context.route(BASE + "/dicom-web/studies/1.2/series/1.3/metadata", lambda route: (
            seen.append(route.request.headers), route.fulfill(body="[]", content_type="application/dicom+json")))
        status = view.evaluate("""() => new Promise((resolve,reject)=>{
          const xhr=new XMLHttpRequest();xhr.open('GET','/dicom-web/studies/1.2/series/1.3/metadata');
          xhr.setRequestHeader('Accept','application/dicom+json');
          xhr.setRequestHeader('Accept','multipart/related; type=application/octet-stream; transfer-syntax=*');
          xhr.onload=()=>resolve(xhr.status);xhr.onerror=reject;xhr.send();})""")
        self.assertEqual(status, 200); self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].get("accept"),
                         "application/dicom+json, multipart/related; type=application/octet-stream; transfer-syntax=*")
        self.assertEqual(seen[0].get("x-kin-session"), "S1")

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
        self.expect_reopen_notice(page)
        self.assertEqual(page.evaluate('[KinWorkContext.session(),KinWorkContext.state(),!!window.started]'),[None,'unknown',False])
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
        try:
            from viewer_session_fixture import MIP_RENDERER
        except ImportError:
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
        try:
            from viewer_volume_marks_progressive_dom_test import HARNESS
        except ImportError:
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

    def test_tech_note_save_across_cancel_is_confirmed_by_read_without_a_repair_click(self):
        view = self.open_viewer()
        held = []
        stored = {"note": None}
        note_url = BASE + "/api/studies/1.2.3/tech-note"
        def note(route):
            if route.request.method == "POST":
                held.append(route)
            else:
                route.fulfill(json={"uid": "1.2.3", "writable": True, **stored})
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
        stored["note"]={"studyUid": "1.2.3", "text": "unsaved original", "version": 1,
                        "author": "synthetic", "createdAt": "2026-10-04T00:00:00Z"}
        held.pop().fulfill(json={"uid": "1.2.3", "writable": True, **stored})
        view.wait_for_timeout(100)
        self.assertEqual(view.locator("#tech-note-text").input_value(), "unsaved original")
        self.assertNotIn("저장되었습니다", view.locator("#tech-note-status").inner_text())
        self.notice("session-resumed")
        view.wait_for_timeout(100)
        self.assertEqual(view.locator("#tech-note-text").input_value(), "unsaved original")
        # The resumed document confirms the old write by reading it, without a repair prompt.
        status = view.locator("#tech-note-status").inner_text()
        self.assertNotIn("저장되었습니다", status)
        self.assertEqual("", status)
        self.assertTrue(view.get_by_role("button", name="Save Note", exact=True).is_enabled())

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
