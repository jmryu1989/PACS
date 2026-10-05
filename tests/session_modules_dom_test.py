# coding: utf-8
"""U5S-REQ-11/12/19/24/26 -> U5S-RISK-APPLY/SESSION/WAIT -> TEST-U5-MODULES.

Representative request, periodic subscription and image decoder consumers. Real
auth, gate and page transport; synthetic responses, delayed bodies/decodes only.
Assertions concern visible results, preserved controls and outgoing bindings.
"""
import json
import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright
from auth_logout_dom_test import Site, ORIGIN, BASE

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
FILES = ("auth.js", "work-context.js", "session-transport.js", "reading-preferences.js",
         "study-access-status.js", "worklist-image-preview.js", "tech-note.js")
HTML = '<!doctype html><meta charset="utf-8"><button id="access">Study Access</button><div id="prefs"></div>' + "".join(
    '<script src="' + name + '"></script>' for name in FILES)

BOOT = """async () => {
  const gate=KinWorkContext; gate.follow(KinAuth); await KinAuth.init(); gate.select('1.2.3');
  const nativeFetch=window.fetch.bind(window), nativeDecode=HTMLImageElement.prototype.decode;
  window.syn={calls:[],holds:[],decodes:[],hold:false,holdDecode:false,status:200,applied:[],value:false,revision:1};
  const syn=window.syn, me=KinAuth.session(), owner=[me.institution,me.sub];
  syn.note={studyUid:'1.2.3',version:1,text:'SYN saved',reason:'',author:'SYN author',createdAt:'2026-10-04T00:00:00Z'};
  syn.storeNote=true;
  const response=(path,status)=>{
    if(status!==200)return new Response(JSON.stringify({message:'SYN request failed'}),{status,headers:{'Content-Type':'application/json'}});
    if(path==='/api/preferences/reading')return new Response(JSON.stringify({owner,revision:syn.revision,autoNote:syn.value}));
    if(path.endsWith('/tech-note'))return new Response(JSON.stringify({uid:'1.2.3',writable:true,note:syn.note}));
    if(path==='/api/study-access')return new Response(JSON.stringify({owner,revision:syn.revision,restricted:false,windowOpen:true,denied:false}));
    if(path==='/api/dicom/lookup')return new Response(JSON.stringify({id:'12345678-12345678-12345678-12345678-12345678'}));
    if(path.startsWith('/dicom-web/'))return new Response(JSON.stringify([{
      '0020000D':{Value:['1.2.3']},'0020000E':{Value:['1.2.3.4']},'00080018':{Value:['1.2.3.5']},
      '00280010':{Value:[1]},'00280011':{Value:[1]},'00280004':{Value:['MONOCHROME2']},'0008103E':{Value:['SYN Series']}
    }]));
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
    return new Response(bytes,{headers:{'Content-Type':'image/png'}});
  };
  window.fetch=(input,init={})=>{
    const path=new URL(input,location.href).pathname;
    if(!['/api/preferences/reading','/api/study-access','/api/dicom/lookup'].includes(path)&&!path.startsWith('/dicom-web/')&&!path.startsWith('/instances/')&&!path.endsWith('/tech-note'))return nativeFetch(input,init);
    syn.calls.push({path,session:new Headers(init.headers).get('X-KIN-Session'),method:init.method||'GET'});
    if(path.endsWith('/tech-note')&&init.method==='POST'){
      const body=JSON.parse(init.body);
      if(body.baseVersion!==syn.note.version)return Promise.resolve(new Response('{}',{status:409}));
      if(syn.storeNote)syn.note={...syn.note,version:syn.note.version+1,text:body.text,reason:body.reason};
      const reply=response(path,syn.storeNote?200:503);
      if(syn.holdNoteWrite)return new Promise(resolve=>syn.holds.push(()=>resolve(reply)));
      return Promise.resolve(reply);
    }
    const reply=response(path,syn.status);
    if(syn.hold&&path===syn.hold)return new Promise(resolve=>syn.holds.push(()=>resolve(reply)));
    return Promise.resolve(reply);
  };
  HTMLImageElement.prototype.decode=function(){
    if(syn.holdDecode)return new Promise((resolve,reject)=>{const image=this;syn.decodes.push(()=>nativeDecode.call(image).then(resolve,reject));});
    return nativeDecode.call(this);
  };
  syn.api=async(method,path,body,signal,context)=>{
    const r=await KinSessionTransport.page().request('/api'+path,{method,json:body,signal,context});
    if(!r.ok)throw new Error('HTTP '+r.status);return r.body;
  };
  syn.mount=kind=>{
    if(kind==='request')KinReadingPreferences({owner,host:document.querySelector('#prefs'),read:()=>syn.value,
      apply:value=>{syn.applied.push(value);return true;},generation:()=>0,endpoint:'/api/preferences/reading'});
    if(kind==='timer')syn.module=KinStudyAccessStatus.mount({button:document.querySelector('#access'),session:()=>KinAuth.session(),refresh:()=>true});
    if(kind==='note')syn.module=KinTechNote({allowed:()=>true,api:syn.api});
    if(kind==='decoder')syn.module=KinWorklistImagePreview.mount({owner:()=>JSON.stringify(owner),currentUid:()=>'1.2.3',api:syn.api});
  };
  syn.open=()=>syn.module.open({uid:'1.2.3',series:'1.2.3.4',name:'SYN Patient'});
  syn.prepare=()=>{syn.preparation=gate.prepare({});};
  syn.cancel=()=>gate.cancelPreparation(syn.preparation);
  syn.notice=session=>{const channel=new BroadcastChannel('kin-session');channel.postMessage({type:'session-ended',session,operation:1,status:'ending'});channel.close();};
} """


class SessionModulesDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = Site()
        self.context = self.browser.new_context()
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(ORIGIN + BASE + "module.html")
        self.page.evaluate(BOOT)
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))

    def route(self, route):
        path = urlparse(route.request.url).path
        if path == BASE + "module.html":
            return route.fulfill(body=HTML, content_type="text/html; charset=utf-8")
        if path.startswith(BASE) and path[len(BASE):] in FILES:
            return route.fulfill(body=(HPACS / path[len(BASE):]).read_bytes(), content_type="application/javascript; charset=utf-8")
        self.site.handle(route, route.request)

    def tearDown(self):
        calls = self.page.evaluate("syn.calls")
        self.assertTrue(all(row["session"] == self.site.cookie for row in calls), calls)
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)
        self.context.close()

    def mount(self, kind):
        self.page.evaluate("kind=>syn.mount(kind)", kind)

    def settle(self):
        self.page.evaluate("async()=>{for(let i=0;i<12;i++)await Promise.resolve();}")
        self.page.wait_for_timeout(30)

    def end(self):
        self.page.evaluate("syn.notice(KinWorkContext.session())")
        self.page.wait_for_function("KinWorkContext.state()!=='active'")

    def foreign(self):
        self.page.evaluate("syn.notice('SYN-OLDER-SESSION')")
        self.settle()
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))

    def test_note_cancel_reads_its_stored_save_and_next_save_uses_the_confirmed_version(self):
        self.mount("note")
        self.page.evaluate("syn.open()")
        note = self.page.locator("#tech-note-text")
        reason = self.page.locator("#tech-note-reason")
        expect(note).to_have_value("SYN saved")
        note.fill("SYN edited")
        reason.fill("SYN reason")
        self.page.evaluate("syn.holdNoteWrite=true")
        self.page.get_by_role("button", name="Save Note", exact=True).click()
        self.page.wait_for_function("syn.holds.length===1")
        self.page.evaluate("syn.prepare();syn.cancel();syn.holds.shift()()")
        expect(self.page.locator("#tech-note-dialog")).to_be_visible()
        expect(note).to_have_value("SYN edited")
        expect(reason).to_have_value("")
        expect(self.page.get_by_role("button", name="Save Note", exact=True)).to_be_enabled()
        expect(self.page.locator("#tech-note-status")).to_have_text("저장되었습니다. v2")
        self.assertEqual(['GET','POST','GET'],self.page.evaluate("syn.calls.map(c=>c.method)"))
        self.page.evaluate("syn.holdNoteWrite=false")
        note.fill("SYN next edit"); reason.fill("SYN next reason")
        self.page.get_by_role("button", name="Save Note", exact=True).click()
        expect(self.page.locator("#tech-note-status")).to_have_text("저장되었습니다. v3")
        self.end()
        expect(self.page.locator("#tech-note-dialog")).not_to_be_visible()

    def test_note_cancel_keeps_an_unsaved_attempt_and_the_next_save_succeeds(self):
        self.mount("note"); self.page.evaluate("syn.open()")
        note=self.page.locator("#tech-note-text"); reason=self.page.locator("#tech-note-reason")
        expect(note).to_have_value("SYN saved")
        note.fill("SYN not stored"); reason.fill("SYN reason")
        self.page.evaluate("syn.holdNoteWrite=true;syn.storeNote=false")
        self.page.get_by_role("button",name="Save Note",exact=True).click()
        self.page.wait_for_function("syn.holds.length===1")
        self.page.evaluate("syn.prepare();syn.holds.shift()()")
        self.settle()
        self.page.evaluate("syn.cancel()")
        expect(self.page.get_by_role("button",name="Save Note",exact=True)).to_be_enabled()
        expect(note).to_have_value("SYN not stored"); expect(reason).to_have_value("SYN reason")
        expect(self.page.locator("#tech-note-status")).to_have_text("저장되지 않았습니다 · 입력은 유지했습니다. 다시 Save Note를 누르세요.")
        self.assertEqual(['GET','POST','GET'],self.page.evaluate("syn.calls.map(c=>c.method)"))
        self.page.evaluate("syn.holdNoteWrite=false;syn.storeNote=true")
        self.page.get_by_role("button",name="Save Note",exact=True).click()
        expect(self.page.locator("#tech-note-status")).to_have_text("저장되었습니다. v2")

    def test_request_prepare_cancel_drops_old_and_resumes(self):
        self.mount("request")
        expect(self.page.get_by_role("button", name="Load Note Preferences")).to_be_enabled()
        self.page.evaluate("syn.hold='/api/preferences/reading';syn.value=true")
        self.page.get_by_role("button", name="Load Note Preferences").click()
        self.page.wait_for_function("syn.holds.length===1")
        self.page.evaluate("syn.prepare();syn.value=false;syn.cancel()")
        self.page.wait_for_function("syn.holds.length===2")
        self.page.evaluate("syn.holds[0]()")
        self.settle()
        self.assertEqual([], self.page.evaluate("syn.applied"))
        self.page.evaluate("syn.holds[1]()")
        self.page.wait_for_function("syn.applied.length===1")
        self.assertEqual([False], self.page.evaluate("syn.applied"))

    def test_request_end_drops_late_result(self):
        self.mount("request")
        expect(self.page.get_by_role("button", name="Load Note Preferences")).to_be_enabled()
        self.page.evaluate("syn.hold='/api/preferences/reading';syn.value=true")
        self.page.get_by_role("button", name="Load Note Preferences").click()
        self.page.wait_for_function("syn.holds.length===1")
        self.end()
        before = self.page.locator("#prefs").inner_text()
        self.page.evaluate("syn.holds[0]()")
        self.settle()
        self.assertEqual(before, self.page.locator("#prefs").inner_text())
        self.assertEqual([], self.page.evaluate("syn.applied"))

    def test_request_foreign_notice_keeps_document_usable(self):
        self.mount("request")
        self.foreign()
        self.page.get_by_role("button", name="Load Note Preferences").click()
        self.page.wait_for_function("syn.applied.length===1")

    def test_request_plain_failures_close_nothing(self):
        self.mount("request")
        for status in (401, 500):
            self.page.evaluate("n=>syn.status=n", status)
            self.page.get_by_role("button", name="Load Note Preferences").click()
            expect(self.page.locator("#reading-prefs-status")).to_contain_text("확인하지 못했습니다")
            self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))
            expect(self.page.get_by_role("button", name="Load Note Preferences")).to_be_enabled()

    def test_timer_prepare_cancel_pauses_and_resumes(self):
        self.page.clock.install()
        self.mount("timer")
        expect(self.page.locator("#access")).to_have_text("Study Access")
        self.page.evaluate("syn.hold='/api/study-access'")
        self.page.clock.fast_forward(30000)
        self.page.wait_for_function("syn.holds.length===1")
        self.page.evaluate("syn.prepare()")
        count = self.page.evaluate("syn.calls.length")
        self.page.clock.fast_forward(60000)
        self.assertEqual(count, self.page.evaluate("syn.calls.length"))
        self.page.evaluate("syn.cancel();syn.holds[0]()")
        self.page.wait_for_function("syn.holds.length===2")
        self.assertEqual("Study Access", self.page.locator("#access").inner_text())
        self.page.evaluate("syn.hold=false;syn.holds[1]()")
        self.settle()
        self.page.clock.fast_forward(30000)
        self.assertGreater(self.page.evaluate("syn.calls.length"), count + 1)

    def test_timer_end_stops_requests_and_late_paint(self):
        self.page.clock.install()
        self.page.evaluate("syn.hold='/api/study-access'")
        self.mount("timer")
        self.page.wait_for_function("syn.holds.length===1")
        self.end()
        before = self.page.locator("#access").inner_text()
        self.page.evaluate("syn.holds[0]()")
        self.page.clock.fast_forward(60000)
        self.settle()
        self.assertEqual(before, self.page.locator("#access").inner_text())
        expect(self.page.locator("#access")).to_be_disabled()
        self.assertEqual(1, self.page.evaluate("syn.calls.length"))

    def test_timer_foreign_notice_keeps_subscription(self):
        self.page.clock.install()
        self.mount("timer")
        self.foreign()
        count = self.page.evaluate("syn.calls.length")
        self.page.clock.fast_forward(30000)
        self.assertGreater(self.page.evaluate("syn.calls.length"), count)

    def test_timer_plain_failures_leave_controls_open(self):
        self.mount("timer")
        for status in (401, 500):
            self.page.evaluate("n=>syn.status=n", status)
            self.page.evaluate("syn.module.check()")
            expect(self.page.locator("#access")).to_have_text("Study Access: Unverified")
            expect(self.page.locator("#access")).to_be_enabled()
            self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))

    def test_decoder_prepare_cancel_drops_old_and_resumes(self):
        self.mount("decoder")
        self.page.evaluate("syn.holdDecode=true;syn.open()")
        self.page.wait_for_function("syn.decodes.length===1")
        self.page.evaluate("syn.prepare();syn.cancel()")
        self.page.wait_for_function("syn.decodes.length===2")
        expect(self.page.get_by_role("dialog")).to_be_visible()
        self.page.evaluate("syn.decodes[0]()")
        self.settle()
        expect(self.page.locator("dialog img")).to_be_hidden()
        self.page.evaluate("syn.decodes[1]()")
        expect(self.page.locator("dialog img")).to_be_visible()

    def test_decoder_end_drops_late_image(self):
        self.mount("decoder")
        self.page.evaluate("syn.holdDecode=true;syn.open()")
        self.page.wait_for_function("syn.decodes.length===1")
        self.end()
        self.page.evaluate("syn.decodes[0]()")
        self.settle()
        expect(self.page.get_by_role("dialog")).to_have_count(0)
        expect(self.page.locator("img")).to_have_count(0)

    def test_decoder_foreign_notice_keeps_image(self):
        self.mount("decoder")
        self.page.evaluate("syn.open()")
        expect(self.page.locator("dialog img")).to_be_visible()
        self.foreign()
        expect(self.page.locator("dialog img")).to_be_visible()

    def test_decoder_plain_failures_close_nothing(self):
        self.mount("decoder")
        for status in (401, 500):
            self.page.evaluate("n=>{syn.status=n;syn.open();}", status)
            expect(self.page.get_by_role("dialog")).to_be_visible()
            expect(self.page.locator("[data-status]")).to_contain_text("HTTP " + str(status))
            self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))


class ModulesBootDOMTest(unittest.TestCase):
    def test_account_change_in_either_critical_area_locks_both_without_ending(self):
        # Exercise the shipped mounts and common host dispatcher, in both directions.
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for source, prefix in (("received", "cvr-inbox"), ("sent", "cvr-sent")):
                with self.subTest(source=source):
                    context = browser.new_context()
                    site, changed, seen, errors = Site(), [], [], []
                    def route_request(route):
                        url = urlparse(route.request.url)
                        if url.path == "/api/critical-results":
                            view = parse_qs(url.query)["view"][0]
                            seen.append(view)
                            owner = [site.account["institution"], site.account["sub"]]
                            if changed and view == source:
                                owner = [owner[0], "SYN-OTHER-OWNER"]
                            return route.fulfill(json={"owner": owner, "view": view, "items": [], "pending": 0, "nextCursor": None})
                        site.handle(route, route.request)
                    context.route("**/*", route_request)
                    page = context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(ORIGIN + BASE + "main.html")
                    page.wait_for_function("KinWorkContext.state()==='active'")
                    page.locator('#cvr-inbox-toggle').click()
                    page.locator('#cvr-sent-toggle').click()
                    for area in ("cvr-inbox", "cvr-sent"):
                        expect(page.locator('#'+area+'-refresh')).to_be_enabled()
                    changed.append(True)
                    page.locator('#'+prefix+'-refresh').click()
                    for area in ("cvr-inbox", "cvr-sent"):
                        expect(page.locator('#'+area+'-refresh')).to_be_disabled()
                    self.assertIn(source, seen)
                    self.assertEqual("active", page.evaluate("KinWorkContext.state()"))
                    self.assertEqual([], site.logouts)
                    self.assertEqual([], errors)
                    self.assertEqual([], site.violations)
                    context.close()
            browser.close()

    def test_shortcuts_mounted_before_boot_enable_and_load_the_accounts_map(self):
        # U5MOD-F03: exercise the actual page's order, holding bootstrap until after mount.
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            context = browser.new_context()
            site, held, errors = Site(), [], []
            context.route("**/*", lambda route: site.handle(route, route.request))
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/api/me", lambda route: held.append(route))
            page.goto(ORIGIN + BASE + "main.html")
            button = page.get_by_role("button", name="Edit Shortcuts", exact=True, include_hidden=True)
            expect(button).to_be_disabled()
            self.assertEqual("unknown", page.evaluate("KinWorkContext.state()"))
            self.assertEqual(1, len(held))
            page.evaluate("""owner => {
                const map={...KinWorkspaceShortcuts.defaults,report:'KeyR'};
                localStorage.setItem('kin-workspace-shortcuts:v1:'+JSON.stringify(owner),JSON.stringify(map));
            }""", [site.account['institution'], site.account['sub']])
            site.handle(held[0], held[0].request)
            page.unroute("**/api/me")
            expect(button).to_be_enabled()
            expect(page.get_by_role("button", name="Report Editor", exact=True, include_hidden=True)).to_have_attribute("aria-keyshortcuts", "Control+Alt+R")
            self.assertEqual("active", page.evaluate("KinWorkContext.state()"))
            self.assertEqual([], errors)
            self.assertEqual([], site.violations)
            context.close()
            browser.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
