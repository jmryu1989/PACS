# coding: utf-8
"""Native manual Image Text visibility boundaries on owned synthetic CT."""
from pathlib import Path
import time
import unittest

from playwright.sync_api import expect

from test_display_controls import DisplayControlsE2E


class ViewerImageTextE2E(DisplayControlsE2E):
    def tearDown(self):
        result = self._outcome.result
        failures = result.failures + result.errors + [
            (test, error) for test, error in getattr(self._outcome, "errors", []) if error
        ]
        if any(test is self for test, _ in failures):
            folder = Path(__file__).parent / "artifacts"
            folder.mkdir(exist_ok=True)
            for i, context in enumerate(self.contexts):
                for j, page in enumerate(context.pages):
                    if "/ohif/viewer" in page.url:
                        try:
                            page.screenshot(path=str(folder /
                                f"IMAGE-TEXT-failure-{self._testMethodName}-{i}-{j}.png"), full_page=True)
                        except Exception:
                            pass
        super().tearDown()

    def shot(self, page, name):
        folder = Path(__file__).parent / "artifacts"
        folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / f"IMAGE-TEXT-{name}.png"), full_page=True)

    def panel(self, page):
        self.open_layout_tools(page)
        panel = page.locator("#kin-image-text")
        expect(panel).to_be_visible(timeout=30000)
        expect(panel.locator("#kin-image-text-toggle")).to_be_enabled()
        return panel

    def text_state(self, page):
        return page.evaluate("""()=>{
          window.__imageTextNodes ||= new WeakMap();window.__imageTextNodeSequence ||= 0;
          const token=node=>{if(!__imageTextNodes.has(node))__imageTextNodes.set(node,++__imageTextNodeSequence);return __imageTextNodes.get(node)};
          const state=services.viewportGridService.getState();return [...state.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(cell=>{
            const viewport=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId),found=[];
            const pane=viewport.element.closest('[data-cy="viewport-pane"]')||viewport.element.parentElement;
            for(const node of pane.querySelectorAll('.viewport-overlay,[data-cy^="viewport-overlay-"],.kin-viewer-identity'))if(!found.includes(node))found.push(node);
            return {id:cell.viewportId,wrapperOwned:pane.getAttribute('data-kin-image-text-hidden'),
              native:found.some(node=>node.matches('.viewport-overlay,[data-cy^="viewport-overlay-"]')),
              identity:found.some(node=>node.matches('.kin-viewer-identity')),targets:found.map(node=>({token:token(node),
                text:node.textContent,owned:node.getAttribute('data-kin-image-text-hidden'),inline:node.style.getPropertyValue('visibility'),
                priority:node.style.getPropertyPriority('visibility'),computed:getComputedStyle(node).visibility,
                rect:node.getBoundingClientRect().toJSON()}))};
          });
        }""")

    def annotations(self, page):
        return page.evaluate("""()=>cornerstoneTools.annotation.state.getAllAnnotations()
          .map(value=>({uid:value.annotationUID,tool:value.metadata.toolName,frame:value.metadata.FrameOfReferenceUID,
            viewport:value.metadata.viewportId||null,points:value.data?.handles?.points||null,text:value.data?.text||null}))""")

    def stable_state(self, page, timeout=15000):
        deadline = time.monotonic() + timeout / 1000
        previous, identical = None, 0
        while time.monotonic() < deadline:
            current = {"display": self.display(page), "text": self.text_state(page),
                       "annotations": self.annotations(page), "title": page.title()}
            identical = identical + 1 if current == previous else 1
            if identical >= 4:
                return current
            previous = current
            page.wait_for_timeout(250)
        self.fail("Image Text native state did not produce four identical 250 ms samples")

    def hide(self, page):
        panel = self.panel(page)
        panel.locator("#kin-image-text-toggle").click()
        expect(panel.locator("#kin-image-text-toggle")).to_have_text("Show Image Text")
        expect(panel.locator("#kin-image-text-status")).to_have_text("Image Text를 숨겼습니다.")
        self.assertTrue(page.evaluate("()=>kinViewerImageTextHidden()"))
        state = self.text_state(page)
        for row in state:
            self.assertTrue(row["native"]); self.assertTrue(row["identity"]); self.assertTrue(row["targets"])
            self.assertTrue(row["wrapperOwned"])
            self.assertTrue(all(target["owned"] is None and target["computed"] == "hidden" for target in row["targets"]))
        return panel

    def show(self, page):
        panel = page.locator("#kin-image-text")
        panel.locator("#kin-image-text-toggle").click()
        expect(panel.locator("#kin-image-text-toggle")).to_have_text("Hide Image Text")
        expect(panel.locator("#kin-image-text-status")).to_have_text("Image Text를 표시했습니다.")
        self.assertFalse(page.evaluate("()=>kinViewerImageTextHidden()"))
        expect(page.locator("[data-kin-image-text-hidden]")).to_have_count(0)

    def assert_automatic_show(self, page):
        self.assertFalse(page.evaluate("()=>kinViewerImageTextHidden()"))
        expect(page.locator("[data-kin-image-text-hidden]")).to_have_count(0)
        page.wait_for_function("""()=>{const node=document.querySelector('#kin-image-text-status');
          return !!node&&/(Image Text|영상|표시)/.test(node.textContent||'');}""")

    def remember_text_styles(self, page):
        page.evaluate("""()=>{window.imageTextOldPanes=[...services.viewportGridService.getState().viewports.values()].map(cell=>{
          const viewport=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId),
            wrapper=viewport.element.closest('[data-cy="viewport-pane"]')||viewport.element.parentElement,targets=[];
          for(const node of wrapper.querySelectorAll('.viewport-overlay,[data-cy^="viewport-overlay-"],.kin-viewer-identity'))
            if(!targets.some(item=>item.node===node))targets.push({node,value:node.style.getPropertyValue('visibility'),
              priority:node.style.getPropertyPriority('visibility')});
          return {wrapper,attribute:wrapper.getAttribute('data-kin-image-text-hidden'),targets};})}""")

    def assert_remembered_text_restored(self, page):
        self.assertTrue(page.evaluate("""()=>imageTextOldPanes.every(item=>
          item.wrapper.getAttribute('data-kin-image-text-hidden')===item.attribute&&item.targets.every(target=>
            target.node.style.getPropertyValue('visibility')===target.value&&
            target.node.style.getPropertyPriority('visibility')===target.priority))"""))

    def annotate(self, page):
        page.locator('[data-cy="MeasurementTools-split-button-secondary"]').click()
        page.get_by_text("Annotation", exact=True).click()
        box = page.locator('[data-cy="viewport-grid"] > div').first.locator("canvas").bounding_box()
        x, y = box["x"] + box["width"] * .5, box["y"] + box["height"] * .5
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 38, y + 24, steps=8); page.mouse.up()
        entry = page.get_by_placeholder("Enter label")
        expect(entry).to_be_visible(); entry.fill("IMAGE TEXT KEEP")
        page.get_by_role("button", name="Save", exact=True).click()

    def test_image_text_01_two_ct_hide_show_preserves_display_and_work(self):
        fixture, page = self.open_pair(); originals = self.originals(); self.seed_report(fixture)
        report = {"findings": "Image Text private draft", "conclusion": "", "recommendation": ""}
        self.assertEqual(200, self.stack.request("PUT", f"/studies/{fixture.uid}/report", "doctor",
                                                dict(report, baseVersion=1)).status)
        self.assertEqual(201, self.stack.request("POST", f"/studies/{fixture.uid}/hold", "doctor").status)
        rows, holder = self.report_rows(fixture), self.state(fixture)["holder"]
        page.get_by_role("button", name="Comparison", exact=True).click()
        page.get_by_label("Job Title", exact=True).fill("IMAGE TEXT UNSAVED JOB")
        self.panel(page); before = self.stable_state(page)
        initial = self.text_state(page)
        self.assertTrue(all(row["native"] and row["identity"] and
                            any(target["computed"] == "visible" for target in row["targets"]) and
                            row["wrapperOwned"] is None and all(target["owned"] is None for target in row["targets"]) for row in initial))
        self.hide(page)
        for old, current in zip(initial, self.text_state(page)):
            self.assertEqual([(item["token"], item["inline"], item["priority"]) for item in current["targets"]],
                             [(item["token"], item["inline"], item["priority"]) for item in old["targets"]])
        self.assertEqual(self.display(page), before["display"])
        self.show(page)
        self.assertEqual(self.stable_state(page), before)
        expect(page.get_by_label("Job Title", exact=True)).to_have_value("IMAGE TEXT UNSAVED JOB")
        self.assertTrue(page.evaluate("()=>kinViewerJobWorkspaceState().dirty"))
        self.assertEqual(rows, self.report_rows(fixture)); self.assertEqual(holder, self.state(fixture)["holder"])
        self.assertEqual(originals, self.originals()); self.shot(page, "hide-show")

    def test_image_text_02_same_stack_frame_stays_hidden_then_grid_and_source_reveal(self):
        _, page = self.open_pair(); self.panel(page); self.remember_text_styles(page)
        self.hide(page)
        before = self.display(page); active = next(i for i, row in enumerate(before)
                                                  if row["id"] == page.evaluate("()=>services.viewportGridService.getState().activeViewportId"))
        canvas = page.locator('[data-viewport-uid="' + before[active]["id"] + '"] canvas')
        box = canvas.bounding_box(); page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.wheel(0, 600)
        page.wait_for_function("""value=>services.cornerstoneViewportService.getCornerstoneViewport(value.id)
          ?.getCurrentImageId?.()!==value.image""", arg={"id": before[active]["id"], "image": before[active]["image"]})
        page.wait_for_function("""()=>kinViewerImageTextHidden()&&[...services.viewportGridService.getState().viewports.values()].every(cell=>{
          const viewport=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId),
            wrapper=viewport.element.closest('[data-cy="viewport-pane"]')||viewport.element.parentElement,
            targets=[...wrapper.querySelectorAll('.viewport-overlay,[data-cy^="viewport-overlay-"],.kin-viewer-identity')];
          return wrapper.hasAttribute('data-kin-image-text-hidden')&&targets.length&&targets.every(node=>getComputedStyle(node).visibility==='hidden');})""")
        self.grid(page, 1)
        self.assert_automatic_show(page)
        self.assert_remembered_text_restored(page)
        self.remember_text_styles(page)
        self.hide(page)
        self.drag(page, "D02E second series", 0)
        self.assert_automatic_show(page)
        self.assert_remembered_text_restored(page)

    def test_image_text_03_source_owner_and_session_guards_restore_text(self):
        _, page = self.open_pair(); self.hide(page)
        page.evaluate("""()=>{const state=services.viewportGridService.getState(),cell=state.viewports.get(state.activeViewportId);
          window.imageTextDs=services.displaySetService.getDisplaySetByUID(cell.displaySetInstanceUIDs[0]);
          window.imageTextSeries=imageTextDs.SeriesInstanceUID;imageTextDs.SeriesInstanceUID='9.9.9'}""")
        self.assert_automatic_show(page)
        page.evaluate("()=>imageTextDs.SeriesInstanceUID=imageTextSeries")
        expect(page.locator("#kin-image-text-toggle")).to_be_enabled()
        self.hide(page)
        page.evaluate("""()=>{window.imageTextOwner=kinViewerWindowOwner;window.kinViewerWindowOwner=()=> 'different-owner'}""")
        self.assert_automatic_show(page)
        page.evaluate("()=>{window.kinViewerWindowOwner=imageTextOwner;}")
        self.hide(page)
        page.evaluate("()=>dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended'}))")
        expect(page.locator("#kin-image-text")).to_have_count(0)
        expect(page.locator("[data-kin-image-text-hidden]")).to_have_count(0)
        self.assertFalse(page.evaluate("()=>kinViewerImageTextHidden()"))

    def test_image_text_04_pre_hidden_native_overlay_annotation_and_reentry_are_preserved(self):
        _, page = self.open_pair(); self.annotate(page)
        page.get_by_role("button", name="Comparison", exact=True).click()
        page.get_by_label("Job Title", exact=True).fill("IMAGE TEXT REENTRY INPUT")
        self.panel(page)
        page.evaluate("""()=>{window.imageTextPreHidden=document.querySelector('[data-cy="viewport-overlay-top-right"]');
          if(!imageTextPreHidden)throw Error('Native overlay missing');imageTextPreHidden.style.setProperty('visibility','hidden','important')}""")
        before = self.stable_state(page); annotations = self.annotations(page)
        self.hide(page); self.show(page)
        self.assertEqual(page.evaluate("""()=>({value:imageTextPreHidden.style.getPropertyValue('visibility'),
          priority:imageTextPreHidden.style.getPropertyPriority('visibility'),computed:getComputedStyle(imageTextPreHidden).visibility})"""),
                         {"value": "hidden", "priority": "important", "computed": "hidden"})
        self.assertEqual(self.stable_state(page), before); self.assertEqual(self.annotations(page), annotations)
        self.hide(page)
        page.evaluate("""()=>window.config.extensions.find(value=>value.id==='kin.image-text').onModeExit()""")
        expect(page.locator("#kin-image-text")).to_have_count(0); expect(page.locator("[data-kin-image-text-hidden]")).to_have_count(0)
        self.assertEqual(page.evaluate("()=>imageTextPreHidden.style.getPropertyPriority('visibility')"), "important")
        page.evaluate("""()=>window.config.extensions.find(value=>value.id==='kin.image-text')
          .onModeEnter({servicesManager:{services}})""")
        expect(page.locator("#kin-image-text")).to_be_visible(timeout=30000)
        self.assertEqual(self.stable_state(page), before); self.assertEqual(self.annotations(page), annotations)
        expect(page.get_by_label("Job Title", exact=True)).to_have_value("IMAGE TEXT REENTRY INPUT")
        self.shot(page, "prehidden-reentry")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerImageTextE2E(name) for name in ViewerImageTextE2E.__dict__
                              if name.startswith("test_image_text_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
