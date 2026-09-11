# coding: utf-8
"""REQ-D02-IDENTITY-FIELDS isolated DOM coverage for viewer v3 and appearance v9."""
from pathlib import Path
import unittest

from playwright.sync_api import sync_playwright
from viewer_identity_position_dom_test import HARNESS, v1_viewer


ROOT = Path(__file__).resolve().parents[1]
IDENTITY = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-identity.js"
APPEARANCE = ROOT / "worklist-v0" / "hpacs-lite" / "reading-appearance.js"
VOLUME = ROOT / "worklist-v0" / "hpacs-lite" / "volume-preferences.js"


class ViewerIdentityFieldsDOMTest(unittest.TestCase):
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
        self.page.route("https://identity-fields.test/", lambda route: route.fulfill(body=HARNESS, content_type="text/html"))
        self.page.goto("https://identity-fields.test/")
        self.page.add_script_tag(path=str(IDENTITY))

    def tearDown(self):
        self.page.close()

    def test_schema_migration_strictness_and_cross_realm_value(self):
        result = self.page.evaluate("""legacy => {
          const v1=KinViewerIdentity.normalize(legacy),v2=structuredClone(legacy);v2.version=2;
          for(const role of ['current','prior'])v2[role].position=role==='current'?'bottom-left':'top-left';
          const migrated2=KinViewerIdentity.normalize(v2),badModality=structuredClone(migrated2),partial=structuredClone(migrated2);
          badModality.current.overrides.CT={...badModality.current};delete badModality.current.overrides.CT.overrides;
          badModality.current.overrides.ct=badModality.current.overrides.CT;delete badModality.current.overrides.CT;
          partial.current.overrides.CT={...partial.current};delete partial.current.overrides.CT.overrides;delete partial.current.overrides.CT.fieldPositions.date;
          const full=KinViewerIdentity.defaults();for(const role of ['current','prior'])for(const modality of KinViewerIdentity.modalities){const item=structuredClone(full[role]);delete item.overrides;full[role].overrides[modality]=item;}
          const maxLength=JSON.stringify(full).length,large=structuredClone(full);large.current.size=20;localStorage.setItem('kin-viewer-identity:v1:too-large',JSON.stringify(large).padEnd(32769,' '));
          const iframe=document.createElement('iframe');document.body.append(iframe);
          const foreign=iframe.contentWindow.JSON.parse(JSON.stringify(migrated2));
          return {v1,migrated2,bad:KinViewerIdentity.normalize(badModality),partial:KinViewerIdentity.normalize(partial),foreign:KinViewerIdentity.normalize(foreign),maxLength,tooLarge:KinViewerIdentity.read('too-large')};
        }""", v1_viewer())
        self.assertEqual(3, result["v1"]["version"])
        self.assertEqual("top-right", result["v1"]["current"]["fieldPositions"]["name"])
        self.assertEqual("bottom-left", result["migrated2"]["current"]["fieldPositions"]["description"])
        self.assertIsNone(result["bad"])
        self.assertIsNone(result["partial"])
        self.assertEqual(result["migrated2"], result["foreign"], "a plain preference from a parent/child realm remains valid")
        self.assertLess(result["maxLength"], 32768, "the full two-role, eleven-modality schema fits the documented local bound")
        self.assertEqual(12, result["tooLarge"]["current"]["size"], "oversized local values fail closed to defaults")

    def test_parent_realm_preference_event_updates_embedded_viewer(self):
        self.page.set_content('<iframe id="viewer"></iframe>')
        self.page.locator('#viewer').evaluate("(frame,html)=>frame.srcdoc=html", HARNESS)
        frame = self.page.locator('#viewer').element_handle().content_frame()
        frame.wait_for_load_state()
        frame.add_script_tag(path=str(IDENTITY))
        frame.evaluate("window.identityMount=__mount()")
        self.page.evaluate("""() => {
          const value={version:3,current:{size:20,font:'mono',color:'warm',name:true,date:true,description:false,position:'top-right',fieldPositions:{name:'top-left',date:'bottom-left',description:'bottom-right'},overrides:{}},prior:{size:12,font:'default',color:'warm',name:true,date:true,description:false,position:'top-right',fieldPositions:{name:'top-right',date:'top-right',description:'top-right'},overrides:{}}};
          dispatchEvent(new CustomEvent('kin-viewer-identity-change',{detail:{owner:JSON.stringify(['hospital','reader']),value}}));
        }""")
        self.assertEqual("20px", frame.locator("#vp1>.kin-viewer-identity").evaluate("e=>getComputedStyle(e).fontSize"))
        self.assertIn("CURRENT^PATIENT", frame.locator("#vp1>.kin-viewer-identity .kin-viewer-identity-group[data-position='top-left']").text_content())

    def test_fields_group_by_corner_and_modality_falls_back_to_general(self):
        result = self.page.evaluate("""() => {
          window.identityMount=__mount();const value=KinViewerIdentity.defaults(),general=value.current;
          general.description=true;general.position='bottom-right';general.fieldPositions={name:'bottom-left',date:'bottom-left',description:'top-left'};
          const ct=structuredClone(general);delete ct.overrides;ct.position='top-right';ct.fieldPositions={name:'top-left',date:'top-left',description:'bottom-right'};general.overrides.CT=ct;
          KinViewerIdentity.publish(JSON.stringify(ownerValue),value);
          const root=document.querySelector('#vp1>.kin-viewer-identity'),viewport=document.querySelector('#vp1').getBoundingClientRect();
          const snapshot=()=>[...root.querySelectorAll('.kin-viewer-identity-group')].map(e=>({position:e.dataset.position,text:e.textContent,box:(()=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}})()}));
          const ctResult={profile:root.dataset.profile,modality:root.dataset.modality,root:root.querySelector('.kin-viewer-identity-content').textContent,groups:snapshot(),viewport:{left:viewport.left,right:viewport.right,top:viewport.top,bottom:viewport.bottom}};
          const pane=document.querySelector('#vp1').parentElement,native=pane.querySelector('[data-cy="viewport-overlay-top-left"]');pane.style.width='200px';pane.style.height='120px';document.querySelector('#vp1').style.width='200px';document.querySelector('#vp1').style.height='120px';native.style.display='block';native.style.height='70px';KinViewerIdentity.publish(JSON.stringify(ownerValue),value);
          const smallRoot=document.querySelector('#vp1>.kin-viewer-identity'),smallViewport=document.querySelector('#vp1').getBoundingClientRect(),small=[smallRoot.querySelector('.kin-viewer-identity-content'),...smallRoot.querySelectorAll('.kin-viewer-identity-group')].map(node=>{const b=node.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}});
          metadata['image-current'].Modality='MR';__grid();
          return new Promise(resolve=>queueMicrotask(()=>{const next=document.querySelector('#vp1>.kin-viewer-identity');resolve({ct:ctResult,small,smallViewport:{left:smallViewport.left,right:smallViewport.right,top:smallViewport.top,bottom:smallViewport.bottom},mr:{profile:next.dataset.profile,modality:next.dataset.modality,root:next.querySelector('.kin-viewer-identity-content').textContent,groups:[...next.querySelectorAll('.kin-viewer-identity-group')].map(e=>({position:e.dataset.position,text:e.textContent}))}})}));
        }""")
        self.assertEqual(("override", "CT"), (result["ct"]["profile"], result["ct"]["modality"]))
        top_left = next(g for g in result["ct"]["groups"] if g["position"] == "top-left")
        self.assertLess(top_left["text"].index("CURRENT^PATIENT"), top_left["text"].index("20260911"))
        viewport = result["ct"]["viewport"]
        for group in result["ct"]["groups"]:
            self.assertGreater(group["box"]["width"], 0)
            self.assertGreater(group["box"]["height"], 0)
            self.assertGreaterEqual(group["box"]["left"], viewport["left"])
            self.assertLessEqual(group["box"]["right"], viewport["right"])
            self.assertGreaterEqual(group["box"]["top"], viewport["top"])
            self.assertLessEqual(group["box"]["bottom"], viewport["bottom"])
        for box in result["small"]:
            self.assertGreater(box["width"], 0)
            self.assertGreater(box["height"], 0)
            self.assertGreaterEqual(box["left"], result["smallViewport"]["left"])
            self.assertLessEqual(box["right"], result["smallViewport"]["right"])
            self.assertGreaterEqual(box["top"], result["smallViewport"]["top"])
            self.assertLessEqual(box["bottom"], result["smallViewport"]["bottom"])
        self.assertEqual(("general", "MR"), (result["mr"]["profile"], result["mr"]["modality"]))
        self.assertIn("PID-1", result["mr"]["root"])
        self.assertTrue(any(g["position"] == "bottom-left" and "CURRENT^PATIENT" in g["text"] for g in result["mr"]["groups"]))

    def test_editor_copy_reset_and_appearance_v9_legacy_v8(self):
        self.page.add_script_tag(path=str(VOLUME))
        self.page.add_script_tag(path=str(APPEARANCE))
        self.page.evaluate("window.appearance=KinReadingAppearance({owner:()=>JSON.stringify(ownerValue)})")
        self.page.click("#reading-appearance-open")
        self.page.select_option("#viewer-identity-current-profile", "CT")
        self.page.select_option("#viewer-identity-current-name-position", "top-left")
        self.page.select_option("#viewer-identity-current-size", "18")
        self.page.click("#viewer-identity-copy-current")
        self.page.select_option("#viewer-identity-current-name-position", "bottom-right")
        self.page.select_option("#viewer-identity-copy-modality-role", "prior")
        self.page.select_option("#viewer-identity-copy-modality-source", "CT")
        self.page.select_option("#viewer-identity-copy-modality-target", "MR")
        self.page.click("#viewer-identity-copy-modality")
        result = self.page.evaluate("""() => {
          const saved=appearance.read(),priorCt=saved.viewer.prior.overrides.CT,priorMr=saved.viewer.prior.overrides.MR;
          const legacy=structuredClone(saved);legacy.version=8;legacy.viewer={version:2,...Object.fromEntries(['current','prior'].map(role=>{const p=saved.viewer[role];return [role,{size:p.size,font:p.font,color:p.color,name:p.name,date:p.date,description:p.description,position:p.position}]}))};
          return {saved,priorCt,priorMr,legacy:appearance.normalize(legacy)};
        }""")
        self.assertEqual((9, 3), (result["saved"]["version"], result["saved"]["viewer"]["version"]))
        self.assertEqual("top-left", result["priorCt"]["fieldPositions"]["name"], "whole-role copy is a deep snapshot")
        self.assertEqual(result["priorCt"], result["priorMr"], "modality copy clones the selected explicit profile")
        self.assertEqual((8, 2), (result["legacy"]["version"], result["legacy"]["viewer"]["version"]))
        self.page.select_option("#viewer-identity-prior-profile", "MR")
        self.page.click("#viewer-identity-prior-reset-profile")
        reset = self.page.evaluate("appearance.read().viewer.prior")
        self.assertNotIn("MR", reset["overrides"])
        self.assertIn("CT", reset["overrides"])


if __name__ == "__main__":
    unittest.main()
