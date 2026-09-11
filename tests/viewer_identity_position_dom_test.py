# coding: utf-8
"""REQ-D02-IDENTITY-POSITION / RISK-D02-WRONG-IDENTITY/OCCLUSION/PREFERENCE-LOSS/STALE / TEST-VIEWER-IDENTITY-POSITION."""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-identity.js"
APPEARANCE = ROOT / "worklist-v0" / "hpacs-lite" / "reading-appearance.js"
VOLUME = ROOT / "worklist-v0" / "hpacs-lite" / "volume-preferences.js"

HARNESS = r"""
<style>
  [data-cy="viewport-pane"] { position:relative;width:400px;height:300px }
  .viewport { position:relative;width:400px;height:300px;background:#111 }
  .native { display:none;position:absolute;z-index:1;width:120px;height:60px }
  [data-cy="viewport-overlay-top-left"] { left:0;top:0 }
  [data-cy="viewport-overlay-top-right"] { right:0;top:0 }
  [data-cy="viewport-overlay-bottom-left"] { left:0;bottom:0 }
  [data-cy="viewport-overlay-bottom-right"] { right:0;bottom:0 }
</style>
<button id="reading-appearance-open">Appearance</button>
<textarea id="report">unchanged report</textarea>
<div data-cy="viewport-pane"><div class="native" data-cy="viewport-overlay-top-left">native</div><div class="native" data-cy="viewport-overlay-top-right">native</div><div class="native" data-cy="viewport-overlay-bottom-left">native</div><div class="native" data-cy="viewport-overlay-bottom-right">native</div><div id="vp1" class="viewport"></div></div>
<div data-cy="viewport-pane"><div class="native" data-cy="viewport-overlay-top-left">native</div><div class="native" data-cy="viewport-overlay-top-right">native</div><div class="native" data-cy="viewport-overlay-bottom-left">native</div><div class="native" data-cy="viewport-overlay-bottom-right">native</div><div id="vp2" class="viewport"></div></div>
<script>
window.BroadcastChannel=undefined;
let ownerValue=['hospital','reader'], allowedValue=true;
const imageState={
  vp1:{uid:'study-current',series:'series-current',sop:'sop-current',image:'image-current',study:{id:'PID-1'}},
  vp2:{uid:'study-prior',series:'series-prior',sop:'sop-prior',image:'image-prior',study:{id:'PID-2'}}
};
const metadata={
  'image-current':{StudyInstanceUID:'study-current',SeriesInstanceUID:'series-current',SOPInstanceUID:'sop-current',PatientID:'PID-1',PatientName:'CURRENT^PATIENT',StudyDate:'20260911',StudyDescription:'Current CT',Modality:'CT'},
  'image-prior':{StudyInstanceUID:'study-prior',SeriesInstanceUID:'series-prior',SOPInstanceUID:'sop-prior',PatientID:'PID-2',PatientName:'PRIOR^PATIENT',StudyDate:'20250911',StudyDescription:'Prior CT',Modality:'CT'}
};
const eventNames={PRE_STACK_NEW_IMAGE:'pre-stack',STACK_NEW_IMAGE:'stack',VOLUME_VIEWPORT_NEW_VOLUME:'volume',IMAGE_RENDERED:'render'};
window.cornerstone={metaData:{get:(_,id)=>metadata[id]},Enums:{ViewportStatus:{RENDERED:'rendered'},Events:eventNames}};
const viewports=new Map([['vp1',{}],['vp2',{}]]), subscribers=[];
const viewportObjects={
  vp1:{element:document.querySelector('#vp1'),viewportStatus:'rendered',getCurrentImageId:()=>imageState.vp1.image},
  vp2:{element:document.querySelector('#vp2'),viewportStatus:'rendered',getCurrentImageId:()=>imageState.vp2.image}
};
const services={
  viewportGridService:{EVENTS:{LAYOUT_CHANGED:'layout'},getState:()=>({viewports,activeViewportId:'vp1'}),subscribe:(_,fn)=>{subscribers.push(fn);return {unsubscribe(){}}}},
  cornerstoneViewportService:{getCornerstoneViewport:id=>viewportObjects[id]}
};
const resolve=id=>imageState[id];
window.__mount=()=>window.KinViewerIdentity.mount({services,resolve,owner:()=>ownerValue,allowed:()=>allowedValue,studies:['study-current','study-prior']});
window.__grid=()=>subscribers.forEach(fn=>fn());
window.__image=(type,id='vp1',imageId=imageState[id]?.image)=>document.dispatchEvent(new CustomEvent(eventNames[type],{detail:{viewportId:id,imageId}}));
window.KinViewerWorkspaceDock={normalize:v=>v&&typeof v==='object'&&[1,2].includes(v.version)&&['top','bottom'].includes(v.placement)&&[-1,0,1].includes(v.panel)&&
  (v.version===1||typeof v.autoHide==='boolean')?{version:v.version,placement:v.placement,panel:v.panel,...(v.version===2?{autoHide:v.autoHide}:{})}:null};
</script>
"""


def v1_viewer():
    return {
        "version": 1,
        "current": {"size": 14, "font": "sans", "color": "cool", "name": True, "date": True, "description": False},
        "prior": {"size": 16, "font": "serif", "color": "warm", "name": False, "date": True, "description": True},
    }


class ViewerIdentityPositionDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1280, "height": 900})
        self.page.route("https://identity.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        self.page.goto("https://identity.test/")
        self.page.add_script_tag(path=str(IDENTITY))

    def tearDown(self):
        self.page.close()

    def test_v1_migrates_on_same_local_key_and_v2_schema_is_strict(self):
        legacy = v1_viewer()
        result = self.page.evaluate(
            """legacy => {
              localStorage.setItem('kin-viewer-identity:v1:owner-a',JSON.stringify(legacy));
              const read=KinViewerIdentity.read('owner-a');
              const extra=structuredClone(read);extra.current.extra=true;
              const invalid=structuredClone(read);invalid.prior.position='center';
              return {read,raw:JSON.parse(localStorage.getItem('kin-viewer-identity:v1:owner-a')),
                extra:KinViewerIdentity.normalize(extra),invalid:KinViewerIdentity.normalize(invalid),positions:KinViewerIdentity.positions};
            }""",
            legacy,
        )
        self.assertEqual(2, result["read"]["version"])
        self.assertEqual("top-right", result["read"]["current"]["position"])
        self.assertEqual(1, result["raw"]["version"], "migration keeps the established storage key/value until an explicit write")
        self.assertIsNone(result["extra"])
        self.assertIsNone(result["invalid"])
        self.assertEqual(["top-left", "top-right", "bottom-left", "bottom-right"], result["positions"])

    def test_whole_block_moves_to_four_corners_avoids_matching_overlay_and_clamps(self):
        self.page.evaluate("window.identityMount=__mount()")
        self.assertEqual(1, self.page.locator("#vp1 > .kin-viewer-identity").count())
        self.assertEqual(1, self.page.locator("#vp2 > .kin-viewer-identity").count())
        self.assertEqual("current", self.page.locator("#vp1 > .kin-viewer-identity").get_attribute("data-role"))
        self.assertEqual("prior", self.page.locator("#vp2 > .kin-viewer-identity").get_attribute("data-role"))
        for position, sides in {
            "top-left": ("28px", "auto", "38px", "auto"),
            "top-right": ("auto", "28px", "38px", "auto"),
            "bottom-left": ("28px", "auto", "auto", "38px"),
            "bottom-right": ("auto", "28px", "auto", "38px"),
        }.items():
            style = self.page.evaluate(
                """position=>{const v=KinViewerIdentity.defaults();v.current.position=position;KinViewerIdentity.publish(JSON.stringify(ownerValue),v);const s=document.querySelector('#vp1 .kin-viewer-identity').style;return [s.left,s.right,s.top,s.bottom]}""",
                position,
            )
            self.assertEqual(list(sides), style, position)

        collision = self.page.evaluate("""()=>{const native=document.querySelector('[data-cy="viewport-overlay-top-left"]');native.style.display='block';const v=KinViewerIdentity.defaults();v.current.position='top-left';KinViewerIdentity.publish(JSON.stringify(ownerValue),v);return document.querySelector('#vp1 .kin-viewer-identity').style.top}""")
        self.assertGreater(float(collision.removesuffix("px")), 38)
        contained = self.page.evaluate("""()=>{const p=document.querySelector('#vp1').parentElement,e=document.querySelector('#vp1'),native=p.querySelector('[data-cy="viewport-overlay-top-left"]');p.style.width=e.style.width='200px';p.style.height=e.style.height='120px';native.style.height='70px';const v=KinViewerIdentity.defaults();v.current.position='top-left';KinViewerIdentity.publish(JSON.stringify(ownerValue),v);const outer=e.getBoundingClientRect(),label=e.querySelector('.kin-viewer-identity').getBoundingClientRect(),n=native.getBoundingClientRect();return {inside:label.left>=outer.left&&label.right<=outer.right&&label.top>=outer.top&&label.bottom<=outer.bottom,separate:label.top>=n.bottom}}""")
        self.assertEqual({"inside": True, "separate": True}, contained)
        small = self.page.evaluate("""()=>{const p=document.querySelector('#vp1').parentElement,e=document.querySelector('#vp1');p.style.width=e.style.width='100px';p.style.height=e.style.height='80px';const v=KinViewerIdentity.defaults();v.current.position='bottom-right';KinViewerIdentity.publish(JSON.stringify(ownerValue),v);const s=document.querySelector('#vp1 .kin-viewer-identity').style;return [s.right,s.bottom,s.maxWidth,s.maxHeight]}""")
        self.assertEqual(["4px", "4px", "92px", "72px"], small)

    def test_metadata_owner_and_loading_gates_clear_then_recover(self):
        self.page.evaluate("window.identityMount=__mount()")
        self.assertEqual(2, self.page.locator(".kin-viewer-identity").count())
        self.page.evaluate("metadata['image-current'].SOPInstanceUID='wrong';__grid()")
        self.page.wait_for_timeout(0)
        self.assertEqual(0, self.page.locator("#vp1 .kin-viewer-identity").count())
        self.page.evaluate("metadata['image-current'].SOPInstanceUID='sop-current';__grid()")
        self.page.wait_for_timeout(0)
        self.assertEqual(1, self.page.locator("#vp1 .kin-viewer-identity").count())
        self.page.evaluate("__image('PRE_STACK_NEW_IMAGE','vp1','replacement')")
        self.assertEqual(0, self.page.locator("#vp1 .kin-viewer-identity").count())
        self.page.evaluate("__image('STACK_NEW_IMAGE','vp1','replacement');__image('IMAGE_RENDERED','vp1','replacement')")
        self.page.wait_for_timeout(0)
        self.assertEqual(0, self.page.locator("#vp1 .kin-viewer-identity").count(), "a rendered event cannot validate a mismatched loaded image")
        self.page.evaluate("__image('PRE_STACK_NEW_IMAGE','vp1','image-current');__image('STACK_NEW_IMAGE','vp1','image-current');__image('IMAGE_RENDERED','vp1','image-current')")
        self.page.wait_for_timeout(0)
        self.assertEqual(1, self.page.locator("#vp1 .kin-viewer-identity").count())
        self.page.evaluate("ownerValue=['hospital','other'];__grid()")
        self.page.wait_for_timeout(0)
        self.assertEqual(0, self.page.locator(".kin-viewer-identity").count())
        self.assertEqual("판독 뷰어 — KOREA IMAGING NETWORK", self.page.title())

    def test_settings_copy_exports_v8_and_strictly_loads_v7_viewer_v1(self):
        self.page.add_script_tag(path=str(VOLUME))
        self.page.add_script_tag(path=str(APPEARANCE))
        self.page.evaluate("""()=>{window.appearance=KinReadingAppearance({owner:()=>JSON.stringify(ownerValue)});document.querySelector('#reading-appearance-open').click()}""")
        self.assertEqual(["top-left", "top-right", "bottom-left", "bottom-right"], self.page.locator("#viewer-identity-current-position option").evaluate_all("o=>o.map(x=>x.value)"))
        self.page.select_option("#viewer-identity-current-position", "bottom-left")
        self.page.select_option("#viewer-identity-current-size", "18")
        before = self.page.evaluate("({report:document.querySelector('#report').value,images:structuredClone(imageState)})")
        self.page.click("#viewer-identity-copy-current")
        result = self.page.evaluate("""()=>({value:appearance.read(),priorPosition:document.querySelector('#viewer-identity-prior-position').value,
          priorSize:document.querySelector('#viewer-identity-prior-size').value,report:document.querySelector('#report').value,images:structuredClone(imageState)})""")
        self.assertEqual(8, result["value"]["version"])
        self.assertEqual(2, result["value"]["viewer"]["version"])
        self.assertEqual("bottom-left", result["priorPosition"])
        self.assertEqual("18", result["priorSize"])
        self.assertEqual(before, {"report": result["report"], "images": result["images"]})

        legacy = result["value"]
        legacy["version"] = 7
        legacy["viewer"] = v1_viewer()
        compatibility = self.page.evaluate("""legacy=>{const normalized=appearance.normalize(legacy);const applied=appearance.apply(normalized);return {normalized,applied,exported:appearance.read()}}""", legacy)
        self.assertEqual(7, compatibility["normalized"]["version"])
        self.assertEqual(1, compatibility["normalized"]["viewer"]["version"])
        self.assertTrue(compatibility["applied"])
        self.assertEqual(8, compatibility["exported"]["version"])
        self.assertEqual("top-right", compatibility["exported"]["viewer"]["prior"]["position"])
        invalid = self.page.evaluate("""v=>{const wrong=structuredClone(v);wrong.version=7;return appearance.normalize(wrong)}""", compatibility["exported"])
        self.assertIsNone(invalid, "v1-v7 envelopes must reject a v2 viewer payload")

    def test_missing_mpr_keeps_position_local_and_disables_account_transfer(self):
        self.page.add_script_tag(path=str(APPEARANCE))
        self.page.add_script_tag(path=str(APPEARANCE.with_name('reading-appearance-account.js')))
        result = self.page.evaluate("""()=>{const appearance=KinReadingAppearance({owner:()=>JSON.stringify(ownerValue)});
          KinReadingAppearanceAccount({owner:ownerValue,...appearance,endpoint:'/api/reading-appearance',sessionEndpoint:'/api/me'});
          const select=document.querySelector('#viewer-identity-current-position');select.value='bottom-left';select.dispatchEvent(new Event('change'));
          return {allowed:appearance.allowed(),local:KinViewerIdentity.read(JSON.stringify(ownerValue)),account:document.querySelector('#reading-appearance-local-only').textContent,
            loadDisabled:document.querySelector('#appearance-account-load').disabled,saveDisabled:document.querySelector('#appearance-account-save').disabled,aggregate:appearance.read()}}""")
        self.assertFalse(result["allowed"])
        self.assertTrue(result["loadDisabled"])
        self.assertTrue(result["saveDisabled"])
        self.assertEqual("bottom-left", result["local"]["current"]["position"])
        self.assertEqual(2, result["local"]["version"])
        self.assertIn("이 브라우저에만 적용", result["account"])
        self.assertEqual(6, result["aggregate"]["version"])
        self.assertEqual(1, result["aggregate"]["viewer"]["version"])


if __name__ == "__main__":
    unittest.main()
