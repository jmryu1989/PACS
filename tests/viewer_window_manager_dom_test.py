# coding: utf-8
"""REQ-D-WORKSPACE-WINDOWS / RISK-D-WORKSPACE-IDENTITY/UNSAVED/STALE / TEST-VIEWER-WINDOW-MANAGER-DOM."""
from pathlib import Path
import hashlib
import os
import sys
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "worklist-v0" / "hpacs-lite" / "main.html"
WINDOWS = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-windows.js"


def extract_function(source, name):
    start = source.index(f"    function {name}(")
    brace = source.index("{", start)
    depth = 0
    quote = None
    escaped = False
    line_comment = False
    block_comment = False
    for index in range(brace, len(source)):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char == "/" and following == "/":
            line_comment = True
            continue
        if char == "/" and following == "*":
            block_comment = True
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated function {name}")


HARNESS = r"""
<button id="viewer-windows-open" disabled></button>
<script>
const $ = value => document.querySelector(value);
let viewerWindows = null, viewerWindowCursor = null;
const studies = [
  {uid:'1.2.1',name:'Current',date:'2026-09-10',desc:'CT'},
  {uid:'1.2.2',name:'Compared',date:'2026-09-11',desc:'CT'}
];
const imageOpening = {snapshot:()=>({maxWindows:2})};
let openingPreference = {maxWindows:2,reuseClean:true};
imageOpening.snapshot=()=>({...openingPreference});
let sessionOwner = '["institution","doctor"]';
const KinViewerOpening = {PREFIX:'kin:',key:()=>sessionOwner ? 'kin:' + sessionOwner : null};
const KinAuth = {session:()=>({state:'approved'})};
const ohifPopupSlots = new WeakMap(), ohifPopupSequences = new WeakMap(), ohifPlacementWrites = new WeakMap();
const display={id:'display-1',left:0,top:0,width:1280,height:900,primary:true};
const KinViewerDisplayLayout = {screens:details=>details.screens||[],identity:screen=>screen.id,
  fit:()=>({left:10,top:10,width:800,height:600})};
const initMonitorPermission = async()=>{}, cacheMonitorScreens=()=>{}, popupRect=()=>null;
const monitorPermissionGranted = ()=>true, rememberOhifRect=()=>true, watchOhifRect=()=>{};
let monitorQueryUnsupported=false, monitorSessionGranted=false;
let demoMode=false,ohifOpenSeq=0,viewerOpenSeq=0,monitorHintShown=false;
let monitorPermission={state:'denied'};
const screen={isExtended:false};
const readStoredOhifRect=()=>null,ohifPlacement=()=>({left:10,top:10,width:800,height:600});
const toast=(message,kind,duration)=>__toasts.push({message,kind,duration});
window.__toasts=[];window.__opened=[];window.__openCalls=[];window.__blockNextOpen=false;window.__nextOpenPopup=null;
window.__blankPopup=()=>{
  const documentToken={querySelector:()=>null,visibilityState:'visible'};
  return {kind:'blank',location:{href:'about:blank'},document:documentToken,opener:{},closed:false,
    focusCalls:0,closeCalls:0,resizeCalls:0,moveCalls:0,focus(){this.focusCalls++},
    close(){this.closeCalls++;this.closed=true},resizeTo(){this.resizeCalls++},moveTo(){this.moveCalls++}};
};
window.open=(...args)=>{__openCalls.push(args);if(__blockNextOpen){__blockNextOpen=false;return null}
  const popup=__nextOpenPopup||__blankPopup();__nextOpenPopup=null;popup.openArgs=args;__opened.push(popup);return popup};
window.getScreenDetails = undefined;
window.BroadcastChannel = undefined;
window.__enableDisplay=async()=>{
  window.getScreenDetails=async()=>({screens:[display]});
  document.querySelector('#viewer-windows-displays').click();
  while(document.querySelector('#viewer-windows-displays').disabled)await new Promise(resolve=>setTimeout(resolve,0));
};
window.__holdDisplayMove=()=>{
  let resolve;window.getScreenDetails=()=>new Promise(done=>{resolve=done});
  window.__resolveDisplayMove=()=>resolve({screens:[display]});
};
function ohifPopupState(popup) {
  try {
    const href=popup.location.href;
    if (href === 'about:blank') return {kind:'blank',busy:false,dirty:false};
    if (popup.kind !== 'viewer') return {kind:popup.kind||'unknown',href,ready:false,busy:true,dirty:true};
    if (!sessionOwner || popup.owner !== sessionOwner) return {kind:'viewer',href,ready:false,busy:true,dirty:false};
    return {kind:'viewer',href,ready:popup.ready,busy:popup.busy,dirty:popup.dirty};
  } catch (_) { return {kind:'unknown',ready:false,busy:true,dirty:true}; }
}
window.__popups=[];
window.__makePopup = ({href='https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1', pending=null,
  kind='viewer',ready=true,busy=false,dirty=false,owner=sessionOwner,coverage=true,sequence=1}={}) => {
  const documentToken={querySelector:()=>null,visibilityState:'visible'};
  const popup={kind,location:{href},document:documentToken,ready,busy,dirty,owner,
    coverageCalls:0,focusCalls:0,closeCalls:0,closed:false,
    focus(){this.focusCalls++},close(){this.closeCalls++;this.closed=true},
    kinViewerFrameCoverageConfirm(callback){this.coverageCalls++;return typeof coverage==='function'?coverage(this,callback):coverage}
  };
  const target=pending||href,choice=viewerWindows.choose(target,2);
  viewerWindows.attach(choice,popup);ohifPopupSlots.set(popup,choice.index);
  if(sequence!==null)ohifPopupSequences.set(popup,sequence);
  if(pending)viewerWindows.navigating(choice,pending,documentToken);
  window.__popups.push(popup);return {popup,index:choice.index};
};
</script>
"""


class ViewerWindowManagerDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)
        main_fixture = os.environ.get("KIN_VIEWER_MAIN_FIXTURE")
        cls.main_path = Path(main_fixture).resolve() if main_fixture else MAIN.resolve()
        main_bytes = cls.main_path.read_bytes()
        main_lf = main_bytes.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        print(f"MAIN_SOURCE path={cls.main_path} raw_sha256={hashlib.sha256(main_bytes).hexdigest()} "
              f"lf_sha256={hashlib.sha256(main_lf).hexdigest()}")
        cls.main_source = main_bytes.decode("utf-8-sig")
        cls.manager_source = extract_function(cls.main_source, "mountViewerWindows")
        cls.open_source = "\n".join(extract_function(cls.main_source, name)
                                    for name in ("ohifScope", "sameOhifScope", "openOhifWindow"))
        cls.windows_source = WINDOWS.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.open_harness()

    def open_harness(self):
        self.page = self.browser.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=HARNESS)
                        if route.request.url == "https://example.test/harness" else route.abort())
        self.page.goto("https://example.test/harness")
        self.page.add_script_tag(content=self.windows_source)
        self.page.add_script_tag(content=self.open_source + "\n" + self.manager_source + "\nmountViewerWindows();")

    def reset_harness(self):
        self.assertEqual(self.page_errors, [])
        self.page.close()
        self.open_harness()

    def tearDown(self):
        self.assertEqual(self.page_errors, [])
        self.page.close()

    def close_button(self, index=0):
        return self.page.locator(f'[data-window-index="{index}"][data-window-action="close"]')

    def focus_button(self, index=0):
        return self.page.locator(f'[data-window-index="{index}"][data-window-action="focus"]')

    def enable_display(self):
        self.page.evaluate("__enableDisplay()")
        self.page.wait_for_function("document.querySelector('[data-window-action=\"display-0\"]') !== null")

    def test_pending_refuses_before_coverage_focuses_and_closes_after_replacement(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1',
            pending:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2'});
          document.querySelector('#viewer-windows-open').click();return made.index;
        }""")
        self.close_button(result).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 0)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
        self.assertIn("닫지 않았습니다", self.page.locator("#viewer-windows-status").inner_text())

        self.page.locator(f'[data-window-index="{result}"][data-window-action="focus"]').click()
        self.assertEqual(self.page.evaluate("__popups[0].focusCalls"), 2)
        self.assertFalse(self.page.locator("#viewer-windows-dialog").evaluate("dialog=>dialog.open"))
        self.page.evaluate("""() => {
          const popup=__popups[0];popup.document={querySelector:()=>null,visibilityState:'visible'};
          popup.location.href='https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2';viewerWindows.rows();
          document.querySelector('#viewer-windows-open').click();
        }""")
        self.close_button(result).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_authenticated_clean_document_closes(self):
        index = self.page.evaluate("() => {const made=__makePopup();document.querySelector('#viewer-windows-open').click();return made.index}")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_reconnected_clean_window_without_sequence_still_closes(self):
        index = self.page.evaluate("""() => {
          const made=__makePopup({sequence:null});
          viewerWindows.end();
          viewerWindows=KinViewerWindows.create({storage:sessionStorage,owner:()=>sessionOwner,
            newId:()=>crypto.randomUUID(),origin:location.origin,describe:ohifPopupState,changed:()=>{}});
          window.__reconnectCalls=[];
          window.open=(...args)=>{__reconnectCalls.push(args);return made.popup};
          document.querySelector('#viewer-windows-open').click();return made.index;
        }""")
        self.assertTrue(self.page.evaluate("viewerWindows.rows()[0].popup === null"))
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__reconnectCalls.length"), 1)
        self.assertEqual(self.page.evaluate("__reconnectCalls[0][1]"), "kin-ohif-current")
        self.assertTrue(self.page.evaluate("ohifPopupSequences.get(__popups[0]) === undefined"))
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_confirmation_navigation_owner_and_document_changes_refuse_close(self):
        mutations = {
            "coverage_cancel": "p=>false",
            "dirty_during_confirmation": "p=>{p.dirty=true;return true}",
            "busy_during_confirmation": "p=>{p.busy=true;return true}",
            "navigation": "p=>{ohifPopupSequences.set(p,2);viewerWindows.navigating(viewerWindows.rows()[0],p.location.href,p.document);return true}",
            "pending_without_sequence_change": "p=>{viewerWindows.navigating(viewerWindows.rows()[0],'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2',p.document);return true}",
            "placement_pending": "p=>{ohifPlacementWrites.set(p,{pending:true});return true}",
            "owner": "p=>{sessionOwner='[\\\"institution\\\",\\\"other\\\"]';return true}",
            "document": "p=>{p.document={querySelector:()=>null,visibilityState:'visible'};return true}",
            "document_aba": "p=>{const old=p.document;p.document={querySelector:()=>null};ohifPopupSequences.set(p,2);viewerWindows.navigating(viewerWindows.rows()[0],p.location.href,old);viewerWindows.rows();p.document=old;return true}",
            "registry_end": "p=>{viewerWindows.end();return true}",
            "session_end": "p=>{sessionOwner=null;return true}",
            "slot_popup_replacement": "p=>{__makePopup();return true}",
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name):
                self.reset_harness()
                index = self.page.evaluate(f"() => {{const made=__makePopup({{coverage:{mutation}}});document.querySelector('#viewer-windows-open').click();return made.index}}")
                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
                self.assertIn("닫지 않았습니다", self.page.locator("#viewer-windows-status").inner_text())

    def test_moving_and_pending_placement_refuse_before_coverage_then_focus_and_recover(self):
        for boundary in ("moving", "placement"):
            with self.subTest(boundary=boundary):
                self.reset_harness()
                index = self.page.evaluate("() => {const made=__makePopup();document.querySelector('#viewer-windows-open').click();return made.index}")
                if boundary == "moving":
                    self.enable_display()
                    self.page.evaluate("__holdDisplayMove()")
                    self.page.locator(f'[data-window-index="{index}"][data-window-action="display-0"]').click()
                    self.page.wait_for_function("document.querySelector('.viewer-window-row p').textContent.includes('Moving')")
                else:
                    self.page.evaluate("ohifPlacementWrites.set(__popups[0],{pending:true})")

                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 0)
                self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
                self.assertGreaterEqual(self.page.evaluate("__popups[0].focusCalls"), 1)
                self.assertIn("닫지 않았습니다", self.page.locator("#viewer-windows-status").inner_text())

                self.focus_button(index).click()
                self.assertFalse(self.page.locator("#viewer-windows-dialog").evaluate("dialog=>dialog.open"))
                if boundary == "moving":
                    self.page.evaluate("__resolveDisplayMove()")
                    self.page.wait_for_function("!document.querySelector('.viewer-window-row p').textContent.includes('Moving')")
                else:
                    self.page.evaluate("ohifPlacementWrites.delete(__popups[0])")
                self.page.locator("#viewer-windows-open").click()
                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
                self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_movement_started_during_confirmation_refuses_then_focuses_and_closes_cleanly(self):
        index = self.page.evaluate("""() => {const made=__makePopup({coverage:p=>{
          document.querySelector('[data-window-index="0"][data-window-action="display-0"]').click();return true}});
          document.querySelector('#viewer-windows-open').click();return made.index}""")
        self.enable_display()
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
        self.page.wait_for_function("!document.querySelector('.viewer-window-row p').textContent.includes('Moving')")
        self.focus_button(index).click()
        self.assertGreaterEqual(self.page.evaluate("__popups[0].focusCalls"), 1)
        self.page.locator("#viewer-windows-open").click()
        self.page.evaluate("__popups[0].kinViewerFrameCoverageConfirm=()=>true")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_registry_error_during_confirmation_fails_closed_and_actual_model_recovers(self):
        mutation = "p=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw Error('synthetic storage failure')};try{viewerWindows.choose('https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2',2)}finally{Storage.prototype.setItem=original}return true}"
        index = self.page.evaluate(f"() => {{const made=__makePopup({{coverage:{mutation}}});document.querySelector('#viewer-windows-open').click();return made.index}}")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
        self.assertFalse(self.page.evaluate("viewerWindows.available()"))
        self.page.evaluate("viewerWindows.blocked({fresh:true,index:1})")
        self.assertTrue(self.page.evaluate("viewerWindows.available()"))
        self.focus_button(index).click()
        self.assertGreaterEqual(self.page.evaluate("__popups[0].focusCalls"), 1)
        self.page.locator("#viewer-windows-open").click()
        self.page.evaluate("__popups[0].kinViewerFrameCoverageConfirm=()=>true")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_dirty_busy_unknown_are_protected_and_focus_remains_available(self):
        for state in ({"dirty": True}, {"busy": True}, {"kind": "unknown"}):
            with self.subTest(state=state):
                self.reset_harness()
                index = self.page.evaluate("state=>{const made=__makePopup(state);document.querySelector('#viewer-windows-open').click();return made.index}", state)
                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 0)
                self.page.locator(f'[data-window-index="{index}"][data-window-action="focus"]').click()
                self.assertEqual(self.page.evaluate("__popups[0].focusCalls"), 2)

    def test_second_study_is_neutral_comparison_with_date_and_uid(self):
        self.page.evaluate("""() => {__makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1,1.2.2'});
          document.querySelector('#viewer-windows-open').click()}""")
        text = self.page.locator(".viewer-window-row p").inner_text()
        self.assertIn("Comparison: 2026-09-11 · 1.2.2", text)
        self.assertNotIn("Prior:", text)

    def test_latest_images_opens_a_separate_blank_document_and_preserves_dirty_source(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup({dirty:true});
          const original={href:made.popup.location.href,document:made.popup.document,dirty:made.popup.dirty};
          document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
          return {original,index:made.index,rows:viewerWindows.rows().map(r=>({index:r.index,pending:r.pending})),
            old:{href:made.popup.location.href,sameDocument:made.popup.document===original.document,
              dirty:made.popup.dirty,closeCalls:made.popup.closeCalls},
            fresh:__opened.map(p=>({args:p.openArgs,href:p.location.href,opener:p.opener,focusCalls:p.focusCalls}))};
        }""")
        self.assertEqual(result["index"], 0)
        self.assertEqual(result["old"], {"href": result["original"]["href"], "sameDocument": True,
                                          "dirty": True, "closeCalls": 0})
        self.assertEqual(result["rows"], [{"index": 0, "pending": False}, {"index": 1, "pending": True}])
        self.assertEqual(len(result["fresh"]), 1)
        self.assertEqual(result["fresh"][0]["args"][0], "")
        self.assertNotEqual(result["fresh"][0]["args"][1], "kin-ohif-current")
        self.assertIn("StudyInstanceUIDs=1.2.1", result["fresh"][0]["href"])
        self.assertIsNone(result["fresh"][0]["opener"])

    def test_latest_images_full_limit_never_reuses_a_clean_document(self):
        result = self.page.evaluate("""() => {
          openingPreference={maxWindows:2,reuseClean:true};
          const dirty=__makePopup({dirty:true});
          const clean=__makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2'});
          const before=[dirty.popup.location.href,clean.popup.location.href];
          document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
          return {before,after:[dirty.popup.location.href,clean.popup.location.href],opened:__opened.length,
            closes:[dirty.popup.closeCalls,clean.popup.closeCalls],toasts:__toasts.map(x=>x.message),rows:viewerWindows.rows().length};
        }""")
        self.assertEqual(result["after"], result["before"])
        self.assertEqual(result["opened"], 0)
        self.assertEqual(result["closes"], [0, 0])
        self.assertEqual(result["rows"], 2)
        self.assertTrue(any("Viewer Windows 수" in message for message in result["toasts"]))

    def test_latest_images_popup_block_releases_slot_and_retry_uses_a_new_blank(self):
        first = self.page.evaluate("""() => {
          __makePopup();document.querySelector('#viewer-windows-open').click();__blockNextOpen=true;
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
          return {rows:viewerWindows.rows().length,opened:__opened.length,toasts:__toasts.map(x=>x.message)};
        }""")
        self.assertEqual(first["rows"], 1)
        self.assertEqual(first["opened"], 0)
        self.assertTrue(any("팝업이 차단" in message for message in first["toasts"]))
        retried = self.page.evaluate("""() => {
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
          return {rows:viewerWindows.rows().map(r=>({index:r.index,pending:r.pending})),opened:__opened.length,
            href:__opened[0]?.location.href,opener:__opened[0]?.opener};
        }""")
        self.assertEqual(retried["rows"], [{"index": 0, "pending": False}, {"index": 1, "pending": True}])
        self.assertEqual(retried["opened"], 1)
        self.assertIn("StudyInstanceUIDs=1.2.1", retried["href"])
        self.assertIsNone(retried["opener"])
        self.assertEqual("", self.page.locator("#viewer-windows-status").text_content())

    def test_latest_detached_button_revalidates_owner_pending_unknown_and_current_scope(self):
        for boundary in ("owner", "pending", "unknown"):
            with self.subTest(boundary=boundary):
                self.reset_harness()
                opened = self.page.evaluate("""boundary => {
                  const made=__makePopup();document.querySelector('#viewer-windows-open').click();
                  const old=document.querySelector('[data-window-index="0"][data-window-action="latest"]');
                  if(boundary==='owner')sessionOwner='["institution","other"]';
                  if(boundary==='pending')viewerWindows.navigating(viewerWindows.rows()[0],
                    'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2',made.popup.document);
                  if(boundary==='unknown')made.popup.kind='unknown';
                  old.onclick();return __opened.length;
                }""", boundary)
                self.assertEqual(opened, 0)

        self.reset_harness()
        current = self.page.evaluate("""() => {
          const made=__makePopup();document.querySelector('#viewer-windows-open').click();
          const old=document.querySelector('[data-window-index="0"][data-window-action="latest"]');
          made.popup.location.href='https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2';
          old.onclick();return {oldClose:made.popup.closeCalls,href:__opened[0]?.location.href};
        }""")
        self.assertEqual(current["oldClose"], 0)
        self.assertIn("StudyInstanceUIDs=1.2.2", current["href"])
        self.assertNotIn("StudyInstanceUIDs=1.2.1", current["href"])

    def test_latest_named_window_collision_preserves_original_and_releases_reservation(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup({dirty:true});
          const original={href:made.popup.location.href,document:made.popup.document};
          document.querySelector('#viewer-windows-open').click();
          __nextOpenPopup=made.popup;
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
          return {rows:viewerWindows.rows().map(r=>({index:r.index,pending:r.pending,popup:r.popup===made.popup})),
            href:made.popup.location.href,sameDocument:made.popup.document===original.document,
            dirty:made.popup.dirty,closeCalls:made.popup.closeCalls,openCalls:__openCalls.length,
            status:document.querySelector('#viewer-windows-status').textContent};
        }""")
        self.assertEqual(result["rows"], [{"index": 0, "pending": False, "popup": True}])
        self.assertEqual(result["href"], "https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1")
        self.assertTrue(result["sameDocument"])
        self.assertTrue(result["dirty"])
        self.assertEqual(result["closeCalls"], 0)
        self.assertEqual(result["openCalls"], 1)
        self.assertIn("새 창 이름", result["status"])

    def test_latest_collision_focus_failure_keeps_visible_notice_and_no_exception(self):
        self.page.evaluate("""()=>{const made=__makePopup({dirty:true});
          document.querySelector('#viewer-windows-open').click();
          made.popup.focus=()=>{throw Error('native focus failed')};__nextOpenPopup=made.popup;}""")
        self.page.locator('[data-window-index="0"][data-window-action="latest"]').click()
        self.assertIn('기존 화면', self.page.locator('#viewer-windows-status').text_content())
        self.assertEqual([], self.page_errors)
        self.assertEqual(1, self.page.evaluate('viewerWindows.rows().length'))

    def test_latest_preserves_comparison_series_and_reading_return_scope(self):
        reading_return = "12345678-1234-4123-8123-123456789abc"
        href = ("https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1,1.2.2"
                "&hangingProtocolId=@ohif/hpCompare&initialSeriesInstanceUID=1.2.3"
                f"#kin-reading-return={reading_return}")
        opened = self.page.evaluate("""href => {
          __makePopup({href});document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
          return __opened[0]?.location.href;
        }""", href)
        target = self.page.evaluate("href => {const u=new URL(href,location.origin);return {studies:u.searchParams.get('StudyInstanceUIDs'),"
                                    "hp:u.searchParams.get('hangingProtocolId'),series:u.searchParams.get('initialSeriesInstanceUID'),"
                                    "reading:new URLSearchParams(u.hash.slice(1)).get('kin-reading-return')}}", opened)
        self.assertEqual(target, {"studies": "1.2.1,1.2.2", "hp": "@ohif/hpCompare",
                                  "series": "1.2.3", "reading": reading_return})

    def test_latest_failures_are_announced_inside_the_open_dialog(self):
        scenarios = {
            "full": """openingPreference={maxWindows:1,reuseClean:true};__makePopup();""",
            "popup": """__makePopup();__blockNextOpen=true;""",
            "collision": """const made=__makePopup({dirty:true});__nextOpenPopup=made.popup;""",
        }
        for name, setup in scenarios.items():
            with self.subTest(name=name):
                self.reset_harness()
                result = self.page.evaluate(f"""() => {{
                  {setup}
                  document.querySelector('#viewer-windows-open').click();
                  document.querySelector('[data-window-index="0"][data-window-action="latest"]').click();
                  const dialog=document.querySelector('#viewer-windows-dialog');
                  return {{open:dialog.open,status:dialog.querySelector('#viewer-windows-status').textContent,
                    rows:viewerWindows.rows().length}};
                }}""")
                self.assertTrue(result["open"])
                self.assertTrue(result["status"].strip())
                if name == "full":
                    self.assertIn("Viewer Windows 수", result["status"])
                elif name == "popup":
                    self.assertIn("팝업이 차단", result["status"])
                else:
                    self.assertIn("새 창 이름", result["status"])
                self.assertEqual(result["rows"], 1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
