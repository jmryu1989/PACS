# coding: utf-8
"""Native IF-V11 Images Only fullscreen boundaries on owned synthetic CT."""
from pathlib import Path
import time
import unittest

from playwright.sync_api import expect

from test_display_controls import DisplayControlsE2E
from test_prior_selection import canvas_ready


class ViewerImagesOnlyE2E(DisplayControlsE2E):
    def shot(self, page, name):
        folder = Path(__file__).parent / "artifacts"
        folder.mkdir(exist_ok=True)
        page.screenshot(path=str(folder / f"IMAGES-ONLY-{name}.png"), full_page=True)

    def panel(self, page):
        self.open_layout_tools(page)
        panel = page.locator("#kin-images-only")
        expect(panel).to_be_visible(timeout=30000)
        expect(panel.locator("#kin-images-only-enter")).to_be_enabled()
        return panel

    def native_state(self, page):
        return page.evaluate("""() => {
          window.__imagesOnlyElements ||= new WeakMap();
          window.__imagesOnlyElementSequence ||= 0;
          const token=element=>{if(!__imagesOnlyElements.has(element))
            __imagesOnlyElements.set(element,++__imagesOnlyElementSequence);return __imagesOnlyElements.get(element)};
          const state=services.viewportGridService.getState();
          const rows=[...state.viewports.values()].sort((a,b)=>a.y-b.y||a.x-b.x).map(cell=>{
            const viewport=services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
            const imageIds=viewport.getImageIds(),current=viewport.getCurrentImageId();
            const metadata=cornerstone.metaData.get('instance',current)||{};
            const canvas=viewport.element.querySelector('canvas'),ctx=canvas.getContext('2d');
            const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
            let digest=2166136261;for(let n=0;n<pixels.length;n+=4)digest=Math.imul(digest^pixels[n],16777619)>>>0;
            return {id:cell.viewportId,element:token(viewport.element),displaySets:[...(cell.displaySetInstanceUIDs||[])],
              type:viewport.type,imageIds,current,index:viewport.getCurrentImageIdIndex(),camera:viewport.getCamera(),
              properties:viewport.getProperties(),study:metadata.StudyInstanceUID,series:metadata.SeriesInstanceUID,
              sop:metadata.SOPInstanceUID,canvas:{width:canvas.width,height:canvas.height,digest}};
          });
          return {active:state.activeViewportId,layout:{rows:state.layout.numRows,cols:state.layout.numCols},rows,
            fullscreen:document.fullscreenElement?token(document.fullscreenElement):null};
        }""")

    def stable_state(self, page, timeout=15000):
        deadline = time.monotonic() + timeout / 1000
        previous, identical = None, 0
        while time.monotonic() < deadline:
            current = self.native_state(page)
            identical = identical + 1 if current == previous else 1
            if identical >= 4:
                return current
            previous = current
            page.wait_for_timeout(250)
        self.fail("Native viewport state did not produce four identical 250 ms samples")

    def enter(self, page):
        panel = self.panel(page)
        panel.locator("#kin-images-only-enter").click()
        page.wait_for_function("""()=>{
          const state=services.viewportGridService.getState(),id=state.activeViewportId;
          const viewport=services.cornerstoneViewportService.getCornerstoneViewport(id),element=viewport?.element;
          if(!element||document.fullscreenElement!==element)return false;
          const cell=state.viewports.get(id),displaySet=services.displaySetService.getDisplaySetByUID(cell?.displaySetInstanceUIDs?.[0]);
          const rect=element.getBoundingClientRect(),canvas=element.querySelector('canvas'),box=canvas?.getBoundingClientRect();
          const identities=[...element.querySelectorAll('.kin-viewer-identity,.kin-viewer-identity-content,.kin-viewer-identity-group')].filter(value=>value.isConnected&&
            getComputedStyle(value).visibility!=='hidden'&&getComputedStyle(value).display!=='none'&&value.getClientRects().length);
          const sourceIdentity=identities.find(value=>value.classList.contains('kin-viewer-identity')&&value.dataset.study===displaySet?.StudyInstanceUID);
          const exit=element.querySelector('#kin-images-only-exit'),exitBox=exit?.getBoundingClientRect();
          const overlap=exitBox&&identities.some(identity=>{const identityBox=identity.getBoundingClientRect();return exitBox.left<identityBox.right&&
            exitBox.right>identityBox.left&&exitBox.top<identityBox.bottom&&exitBox.bottom>identityBox.top});
          const identityBox=identities[0]?.getBoundingClientRect(),dock=document.querySelector('#kin-workspace-dock'),nativeTool=document.querySelector('[data-cy="Zoom"]');
          const dpr=devicePixelRatio||1,backing=box&&Math.abs(canvas.width-box.width*dpr)<=2&&Math.abs(canvas.height-box.height*dpr)<=2;
          return Math.abs(rect.left)<=2&&Math.abs(rect.top)<=2&&Math.abs(rect.right-innerWidth)<=2&&Math.abs(rect.bottom-innerHeight)<=2&&
            box&&Math.abs(box.left-rect.left)<=2&&Math.abs(box.top-rect.top)<=2&&Math.abs(box.right-rect.right)<=2&&Math.abs(box.bottom-rect.bottom)<=2&&
            backing&&sourceIdentity&&identityBox.width>0&&identityBox.height>0&&exitBox.width>0&&exitBox.height>0&&!overlap&&dock&&nativeTool&&
            !element.contains(dock)&&!element.contains(nativeTool);
        }""", timeout=15000)
        expect(page.locator("#kin-images-only-status")).to_have_text(
            "Images Only · Esc 또는 Exit Images Only로 돌아갑니다.")

    def annotate(self, page):
        page.locator('[data-cy="MeasurementTools-split-button-secondary"]').click()
        page.get_by_text("Annotation", exact=True).click()
        box = page.locator('[data-cy=viewport-grid] > div').first.locator("canvas").bounding_box()
        x, y = box["x"] + box["width"] * .5, box["y"] + box["height"] * .5
        page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 35, y + 22, steps=8); page.mouse.up()
        entry = page.get_by_placeholder("Enter label")
        expect(entry).to_be_visible(); entry.fill("IMAGES ONLY KEEP")
        page.get_by_role("button", name="Save", exact=True).click()
        return page.evaluate("""()=>cornerstoneTools.annotation.state.getAllAnnotations()
          .filter(a=>a.metadata.toolName==='ArrowAnnotate').map(a=>({uid:a.annotationUID,text:a.data.text,
            frame:a.metadata.FrameOfReferenceUID,viewport:a.metadata.viewportId||null,
            points:a.data.handles.points}))""")

    def test_images_only_01_fullscreen_selected_element_and_explicit_exit_preserve_work(self):
        fixture, page = self.open_pair(); originals = self.originals()
        self.seed_report(fixture)
        values = {"findings": "Images Only saved draft", "conclusion": "", "recommendation": ""}
        self.assertEqual(200, self.stack.request("PUT", f"/studies/{fixture.uid}/report", "doctor",
                                                 dict(values, baseVersion=1)).status)
        self.assertEqual(201, self.stack.request("POST", f"/studies/{fixture.uid}/hold", "doctor").status)
        reports, holder = self.report_rows(fixture), self.state(fixture)["holder"]
        annotations = self.annotate(page)
        page.get_by_role("button", name="Comparison", exact=True).click()
        page.get_by_label("Job Title", exact=True).fill("IMAGES ONLY UNSAVED JOB")
        self.panel(page); before = self.stable_state(page); self.enter(page); during = self.native_state(page)
        selected = next(row for row in before["rows"] if row["id"] == before["active"])
        self.assertEqual(during["fullscreen"], selected["element"])
        self.assertEqual(during["layout"], before["layout"])
        self.assertEqual([(r["id"], r["element"], r["study"], r["series"], r["sop"], r["imageIds"])
                          for r in during["rows"]],
                         [(r["id"], r["element"], r["study"], r["series"], r["sop"], r["imageIds"])
                          for r in before["rows"]])
        for old, current in zip(before["rows"], during["rows"]):
            for field in ("camera", "properties", "current", "index"):
                self.assertEqual(current[field], old[field])
        page.locator("#kin-images-only-exit").click()
        page.wait_for_function("document.fullscreenElement === null")
        expect(page.locator("#kin-images-only-status")).to_have_text("Images Only를 종료했습니다.")
        self.assertEqual(self.stable_state(page), before)
        self.assertEqual(page.evaluate("""()=>cornerstoneTools.annotation.state.getAllAnnotations()
          .filter(a=>a.metadata.toolName==='ArrowAnnotate').map(a=>({uid:a.annotationUID,text:a.data.text,
            frame:a.metadata.FrameOfReferenceUID,viewport:a.metadata.viewportId||null,
            points:a.data.handles.points}))"""), annotations)
        expect(page.get_by_label("Job Title", exact=True)).to_have_value("IMAGES ONLY UNSAVED JOB")
        self.assertTrue(page.evaluate("()=>kinViewerJobWorkspaceState().dirty"))
        self.assertEqual(self.report_rows(fixture), reports); self.assertEqual(self.state(fixture)["holder"], holder)
        self.assertEqual(self.originals(), originals); self.shot(page, "explicit-exit")

    def test_images_only_02_native_display_changes_survive_escape_and_other_cell_is_unchanged(self):
        _, page = self.open_pair()
        page.get_by_role("button", name="Comparison", exact=True).click()
        page.get_by_label("Job Title", exact=True).fill("KEEP FILLED INPUT")
        self.choose(page, 0)
        page.keyboard.press("ArrowDown")
        page.wait_for_function("""()=>{const id=services.viewportGridService.getState().activeViewportId;
          return services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageIdIndex?.()===1}""")
        self.panel(page); before = self.stable_state(page); self.enter(page)
        page.keyboard.press("2"); page.wait_for_timeout(150)
        page.keyboard.press("h"); page.wait_for_timeout(150)
        active = next(i for i, row in enumerate(before["rows"]) if row["id"] == before["active"])
        other = 1 - active
        canvas = page.locator('[data-viewport-uid="' + before["active"] + '"] canvas')
        box = canvas.bounding_box(); page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.wheel(0, 600)
        page.wait_for_function("""value=>services.cornerstoneViewportService.getCornerstoneViewport(value.id)
          ?.getCurrentImageId?.()!==value.image""", arg={"id": before["active"], "image": before["rows"][active]["current"]})
        changed = self.native_state(page)
        self.assertIsNotNone(changed["fullscreen"])
        self.assertNotEqual(changed["rows"][active]["current"], before["rows"][active]["current"])
        self.assertNotEqual(changed["rows"][active]["properties"]["voiRange"],
                            before["rows"][active]["properties"]["voiRange"])
        self.assertNotEqual(changed["rows"][active]["camera"]["flipHorizontal"],
                            before["rows"][active]["camera"]["flipHorizontal"])
        self.assertEqual(changed["rows"][other], before["rows"][other])
        page.keyboard.press("Escape"); page.wait_for_function("document.fullscreenElement === null")
        after = self.stable_state(page)
        self.assertEqual(after["rows"][active]["properties"], changed["rows"][active]["properties"])
        self.assertEqual(after["rows"][active]["camera"], changed["rows"][active]["camera"])
        self.assertEqual(after["rows"][active]["current"], changed["rows"][active]["current"])
        self.assertEqual(after["rows"][active]["imageIds"], before["rows"][active]["imageIds"])
        self.assertEqual(after["rows"][other], before["rows"][other])
        expect(page.get_by_label("Job Title", exact=True)).to_have_value("KEEP FILLED INPUT")
        self.shot(page, "escape-retains-display")

    def test_images_only_03_rejected_request_retries_and_session_end_exits_owned_fullscreen(self):
        _, page = self.open_pair(); panel = self.panel(page)
        page.evaluate("""()=>{const id=services.viewportGridService.getState().activeViewportId;
          const element=services.cornerstoneViewportService.getCornerstoneViewport(id).element;
          window.__imagesOnlyRequestFullscreen=element.requestFullscreen;
          element.requestFullscreen=()=>Promise.reject(new DOMException('Synthetic denial','NotAllowedError'));}""")
        panel.locator("#kin-images-only-enter").click()
        expect(page.locator("#kin-images-only-status")).to_have_text(
            "브라우저가 Images Only 요청을 허용하지 않았습니다.")
        self.assertIsNone(page.evaluate("document.fullscreenElement"))
        page.evaluate("""()=>{const id=services.viewportGridService.getState().activeViewportId;
          services.cornerstoneViewportService.getCornerstoneViewport(id).element.requestFullscreen=__imagesOnlyRequestFullscreen;}""")
        page.locator("#kin-images-only-enter").click(); page.wait_for_function("document.fullscreenElement !== null")
        page.evaluate("window.dispatchEvent(new StorageEvent('storage',{key:'kin-session-ended',newValue:String(Date.now())}))")
        page.wait_for_function("document.fullscreenElement === null")
        expect(page.locator("#kin-images-only")).to_have_count(0)

    def test_images_only_04_native_double_click_one_up_restores_grid_without_fullscreen(self):
        _, page = self.open_pair(); self.panel(page); before = self.stable_state(page)
        page.evaluate("""()=>{window.__imagesOnlyFullscreenCalls=0;
          window.__imagesOnlyNativeRequest=Element.prototype.requestFullscreen;
          Element.prototype.requestFullscreen=function(...args){__imagesOnlyFullscreenCalls++;return __imagesOnlyNativeRequest.apply(this,args)};}""")
        canvas = page.locator('[data-cy=viewport-grid] > div').first.locator("canvas")
        canvas.dblclick()
        page.wait_for_function("""()=>{const s=services.viewportGridService.getState();
          return s.viewports.size===1&&s.layout.numRows===1&&s.layout.numCols===1}""")
        canvas_ready(page, 1); one = self.native_state(page)
        selected = next(row for row in before["rows"] if row["id"] == before["active"])
        self.assertEqual((one["rows"][0]["study"], one["rows"][0]["series"], one["rows"][0]["sop"],
                          one["rows"][0]["imageIds"]),
                         (selected["study"], selected["series"], selected["sop"], selected["imageIds"]))
        self.assertIsNone(one["fullscreen"]); self.assertEqual(page.evaluate("__imagesOnlyFullscreenCalls"), 0)
        page.locator('[data-cy=viewport-grid] > div').first.locator("canvas").dblclick()
        page.wait_for_function("services.viewportGridService.getState().viewports.size===2")
        canvas_ready(page, 2); restored = self.stable_state(page)
        self.assertEqual([(r["id"], r["study"], r["series"], r["sop"], r["imageIds"])
                          for r in restored["rows"]],
                         [(r["id"], r["study"], r["series"], r["sop"], r["imageIds"])
                          for r in before["rows"]])
        self.assertEqual(restored["layout"], before["layout"])
        self.assertIsNone(restored["fullscreen"]); self.assertEqual(page.evaluate("__imagesOnlyFullscreenCalls"), 0)
        self.shot(page, "one-up-restored")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ViewerImagesOnlyE2E(name) for name in ViewerImagesOnlyE2E.__dict__
                              if name.startswith("test_images_only_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
