# coding: utf-8
"""Pure DOM coverage for the per-series image thumbnail browser."""
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
PREVIEW = (ROOT / "worklist-v0" / "hpacs-lite" / "worklist-image-preview.js").read_text(encoding="utf-8")
THUMBNAILS = (ROOT / "worklist-v0" / "hpacs-lite" / "worklist-image-thumbnails.js").read_text(encoding="utf-8")
MAIN = (ROOT / "worklist-v0" / "hpacs-lite" / "main.html").read_text(encoding="utf-8")
STUDY, SERIES, SOP1, SOP2 = "2.25.10", "2.25.20", "2.25.31", "2.25.32"

HARNESS = r"""
<main id="host"></main>
<script>
window.BroadcastChannel=undefined;
window.ownerValue='hospital|reader';window.currentValue='2.25.10';
window.apiCalls=[];window.fetchCalls=[];window.previewCalls=[];window.backCalls=0;
window.lookupMode='ok';window.renderMode='ok';window.metadataMode='ok';window.delayMs=20;window.inventoryCancelled=0;
window.activeLoads=0;window.peakLoads=0;window.created=[];window.revoked=[];
const nativeCreate=URL.createObjectURL.bind(URL),nativeRevoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=b=>{const u=nativeCreate(b);created.push(u);return u};
URL.revokeObjectURL=u=>{revoked.push(u);nativeRevoke(u)};
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
const row=(sop,frames,number,series='2.25.20')=>Object.fromEntries(Object.entries({'0020000D':'2.25.10','0020000E':series,'00080018':sop,'0008103E':'Literal <img onerror=bad> & Series','00200013':number,'00280008':frames,'00280010':8,'00280011':8,'00280004':'MONOCHROME2'}).map(([k,v])=>[k,{Value:[v]}]));
window.rows=[row('2.25.31',8,20),row('2.25.32',6,3),row('2.25.33',1,1,'2.25.21')];
window.api=async(method,path,body,signal)=>{apiCalls.push({method,path,body,aborted:signal.aborted});
 if(lookupMode==='network')throw new TypeError('synthetic network');if(lookupMode==='bad')return {id:'not-an-id'};
 if(lookupMode==='401'||lookupMode==='403')throw Object.assign(Error('HTTP '+lookupMode),{status:Number(lookupMode)});
 return {id:body.sopUid==='2.25.31'?'11111111-11111111-11111111-11111111-11111111':'22222222-22222222-22222222-22222222-22222222'};};
window.fetch=async(url,init={})=>{url=String(url);fetchCalls.push(url);
 if(url.includes('/dicom-web/')){
   if(metadataMode==='held')return new Promise(resolve=>window.heldInventoryResolve=()=>resolve(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(rows)))},cancel(){inventoryCancelled++}}),{headers:{'content-type':'application/json'}})));
   if(metadataMode==='http')return new Response('no',{status:503});
   if(metadataMode==='bad')return new Response(JSON.stringify([{bad:true}]),{headers:{'content-type':'application/json'}});
   if(metadataMode==='large')return new Response('[]',{headers:{'content-type':'application/json','content-length':'16777217'}});
   return new Response(JSON.stringify(rows),{headers:{'content-type':'application/json'}});
 }
 activeLoads++;peakLoads=Math.max(peakLoads,activeLoads);
 if(renderMode==='network'){activeLoads--;throw new TypeError('synthetic render network')}
 if(renderMode==='403'){activeLoads--;return new Response('denied',{status:403})}
 if(renderMode==='mime'){activeLoads--;return new Response('not png',{headers:{'content-type':'text/plain'}})}
 if(renderMode==='large'){activeLoads--;return new Response(png,{headers:{'content-type':'image/png','content-length':'4194305'}})}
 const signal=init.signal;return new Response(new ReadableStream({start(controller){
   const finish=()=>{activeLoads--;if(signal?.aborted){try{controller.error(new DOMException('Aborted','AbortError'))}catch(_){}}else{controller.enqueue(png);controller.close();}};
   if(renderMode==='held'||(renderMode==='partial'&&!/\/frames\/(0|1)\//.test(url)))window.heldBodies=(window.heldBodies||[]).concat(finish);else setTimeout(finish,delayMs);
 }}),{headers:{'content-type':'image/png'}});
};
window.sourceValue=series=>({uid:'2.25.10',series:series||'2.25.20',name:'Literal <patient>',id:'P&1'});
window.start=()=>{window.browser=KinWorklistImageThumbnails.mount({host:document.querySelector('#host'),owner:()=>ownerValue,currentUid:()=>currentValue,api,
 onPreview:value=>previewCalls.push(value),onBack:()=>backCalls++});return browser.open(sourceValue());};
</script>
"""


class WorklistImageThumbnailsDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start(); cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_content(HARNESS)
        self.page.add_script_tag(content=PREVIEW)
        self.page.add_script_tag(content=THUMBNAILS)

    def tearDown(self):
        self.page.close()

    def open(self):
        self.assertTrue(self.page.evaluate("start()"))
        expect(self.page.locator("#thumb-images-status")).to_have_text("12 / 12 images ready")

    def test_main_mount_is_optional_and_enables_images_only_after_existing_preview_succeeds(self):
        self.assertLess(MAIN.index('<script src="worklist-image-preview.js"></script>'), MAIN.index('<script src="worklist-image-thumbnails.js"></script>'))
        self.assertIn("imageThumbnails = window.KinWorklistImageThumbnails?.mount?.(", MAIN)
        self.assertIn("}) || null;", MAIN)
        self.assertIn("if(!imageThumbnails)images.title='Images 모듈을 불러오지 못했습니다. 페이지를 다시 열어 주세요.';", MAIN)
        self.assertIn("cells[index].open.disabled = false;", MAIN)
        self.assertIn("cells[index].inspect.disabled = false;", MAIN)
        self.assertIn("cells[index].images.disabled = !imageThumbnails;", MAIN)

    def test_pagination_order_worker_budget_urls_and_exact_preview_frame(self):
        self.open()
        cards = self.page.locator(".thumb-image-card")
        self.assertEqual(12, cards.count())
        self.assertEqual([SOP2] * 6 + [SOP1] * 6, cards.evaluate_all("xs=>xs.map(x=>x.dataset.sop)"))
        self.assertEqual([str(x) for x in list(range(6)) + list(range(6))], cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))
        expect(cards.first.locator(".thumb-number")).to_have_text("Image 1 · Instance 3")
        expect(cards.first.locator(".thumb-description")).to_have_text(f"SOP {SOP2} · Frame 1 / 6")
        self.assertLessEqual(self.page.evaluate("peakLoads"), 4)
        rendered = self.page.evaluate("fetchCalls.filter(x=>x.includes('/frames/'))")
        self.assertEqual(12, len(rendered)); self.assertTrue(all("?width=256&height=256" in x for x in rendered))
        cards.nth(7).get_by_role("button", name="Preview Image", exact=False).click()
        self.assertEqual({"uid": STUDY, "series": SERIES, "name": "Literal <patient>", "id": "P&1", "sop": SOP1, "frame": 1}, self.page.evaluate("previewCalls[0]"))
        detached = cards.first.locator(".thumb-image-open").element_handle()
        self.page.get_by_role("button", name="Next Page", exact=True).click()
        expect(self.page.locator("#thumb-images-status")).to_have_text("2 / 2 images ready")
        detached.evaluate("e=>e.onclick()") ; self.assertEqual(1, self.page.evaluate("previewCalls.length"))
        expect(self.page.locator("#thumb-images-page")).to_have_text("Page 2 / 2 · 14 images")
        self.assertEqual(["6", "7"], cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))
        self.page.get_by_label("Image Order").select_option("descending")
        expect(self.page.locator("#thumb-images-status")).to_have_text("12 / 12 images ready")
        self.assertEqual(([SOP1] * 8 + [SOP2] * 4), cards.evaluate_all("xs=>xs.map(x=>x.dataset.sop)"))
        self.assertEqual(["7", "6", "5", "4", "3", "2", "1", "0", "5", "4", "3", "2"], cards.evaluate_all("xs=>xs.map(x=>x.dataset.frame)"))
        self.page.get_by_role("button", name="Back to Series", exact=True).click()
        self.assertEqual(1, self.page.evaluate("backCalls")); self.assertEqual(0, self.page.locator("#thumb-images-view").count())

    def test_late_stream_source_and_owner_changes_revoke_without_a_to_b_to_a_resurrection(self):
        self.page.evaluate("renderMode='held';start()")
        self.page.wait_for_function("()=>heldBodies?.length===4")
        self.page.evaluate("currentValue='2.25.11';browser.sync();currentValue='2.25.10'")
        self.assertEqual(0, self.page.locator("#thumb-images-view").count())
        self.page.evaluate("heldBodies.splice(0).forEach(f=>f())")
        self.page.wait_for_timeout(50)
        self.assertEqual(0, self.page.locator("#thumb-images-view img").count())
        self.assertEqual(self.page.evaluate("created.length"), self.page.evaluate("revoked.length"))

        self.page.evaluate("renderMode='ok';start()")
        expect(self.page.locator("#thumb-images-status")).to_have_text("12 / 12 images ready")
        made = self.page.evaluate("created.length")
        self.page.evaluate("ownerValue='hospital|other';browser.sync();ownerValue='hospital|reader'")
        self.assertEqual(0, self.page.locator("#thumb-images-view").count())
        self.assertEqual(made, self.page.evaluate("revoked.length"))
        self.assertFalse(self.page.evaluate("browser.open({uid:'2.25.10',series:'2.25.20'})"))

    def test_detached_toolbar_controls_cannot_close_reorder_or_retry_a_new_same_study_source(self):
        self.open()
        old_back = self.page.locator("#thumb-images-back").element_handle()
        old_order = self.page.locator("#thumb-images-order").element_handle()
        old_retry = self.page.locator("#thumb-images-retry").element_handle()
        self.assertTrue(self.page.evaluate("browser.open(sourceValue('2.25.21'))"))
        expect(self.page.locator("#thumb-images-status")).to_have_text("1 / 1 images ready")
        baseline = self.page.evaluate("({fetches:fetchCalls.length,apis:apiCalls.length})")
        old_order.evaluate("e=>{e.value='descending';e.onchange({target:e})}")
        old_retry.evaluate("e=>e.onclick()")
        old_back.evaluate("e=>e.onclick()")
        self.page.wait_for_timeout(60)
        expect(self.page.locator("#thumb-images-view")).to_be_visible()
        expect(self.page.locator("#thumb-images-order")).to_have_value("ascending")
        self.assertEqual("2.25.33", self.page.locator(".thumb-image-card").get_attribute("data-sop"))
        self.assertEqual(0, self.page.evaluate("backCalls"))
        self.assertEqual(baseline, self.page.evaluate("({fetches:fetchCalls.length,apis:apiCalls.length})"))

    def test_late_decode_from_old_order_cannot_enable_stale_cards_or_preview(self):
        self.page.evaluate("""()=>{window.holdDecode=true;window.decodeResolves=[];Image.prototype.decode=function(){
          if(!holdDecode)return Promise.resolve();return new Promise(resolve=>decodeResolves.push(resolve));};start()}""")
        self.page.wait_for_function("()=>decodeResolves.length===4")
        old_button = self.page.locator(".thumb-image-open").first.element_handle()
        self.page.locator("#thumb-images-order").select_option("descending")
        self.page.evaluate("()=>{holdDecode=false;decodeResolves.splice(0).forEach(resolve=>resolve())}")
        expect(self.page.locator("#thumb-images-status")).to_have_text("12 / 12 images ready")
        self.assertTrue(old_button.evaluate("e=>e.disabled"))
        old_button.evaluate("e=>e.onclick()")
        self.assertEqual([], self.page.evaluate("previewCalls"))
        self.assertEqual(SOP1, self.page.locator(".thumb-image-card").first.get_attribute("data-sop"))
        self.assertEqual("7", self.page.locator(".thumb-image-card").first.get_attribute("data-frame"))
        self.assertGreaterEqual(self.page.evaluate("revoked.length"), 4)

    def test_page_timeout_marks_disabled_cards_and_late_stream_cannot_overwrite_status(self):
        self.open()
        self.page.evaluate("""()=>{const real=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>real(fn,ms===15000?100:ms,...args);
          renderMode='partial';document.querySelector('#thumb-images-retry').click()}""")
        self.page.wait_for_function("()=>document.querySelectorAll('#thumb-images-grid img').length===2")
        ready_button = self.page.locator(".thumb-image-open:enabled").first.element_handle()
        expect(self.page.locator("#thumb-images-status")).to_contain_text("응답 시간이 초과됐습니다.")
        self.assertTrue(ready_button.evaluate("e=>e.disabled"))
        self.assertEqual(12, self.page.locator(".thumb-image-open:disabled").count())
        expect(self.page.locator(".thumb-image-preview").nth(2)).to_have_text("Not loaded · Retry Images")
        self.assertEqual(4, self.page.evaluate("heldBodies.length")); self.assertLessEqual(self.page.evaluate("peakLoads"), 4)
        self.page.evaluate("heldBodies.splice(0).forEach(f=>f())")
        self.page.wait_for_timeout(60)
        expect(self.page.locator("#thumb-images-status")).to_contain_text("응답 시간이 초과됐습니다.")
        self.assertEqual(2, self.page.locator("#thumb-images-view img").count())

    def test_inventory_timeout_exposes_retry_before_held_provider_resolves_and_cancels_late_body(self):
        self.page.evaluate("""()=>{window.realTimeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms===15000?30:ms,...args);
          metadataMode='held';start()}""")
        self.page.wait_for_function("()=>typeof heldInventoryResolve==='function'")
        expect(self.page.locator("#thumb-images-status")).to_contain_text("응답 시간이 초과됐습니다.")
        expect(self.page.locator("#thumb-images-retry")).to_be_enabled()
        self.assertEqual(0, self.page.locator(".thumb-image-card").count())
        self.page.evaluate("heldInventoryResolve()")
        self.page.wait_for_function("()=>inventoryCancelled===1")
        self.page.evaluate("metadataMode='ok';window.setTimeout=realTimeout;document.querySelector('#thumb-images-retry').click()")
        expect(self.page.locator("#thumb-images-status")).to_have_text("12 / 12 images ready")

    def test_strict_inventory_lookup_mime_size_and_decode_failures_are_retryable(self):
        for mode, text in [("bad", "원본 영상 참조가 일치하지 않습니다."), ("http", "영상 목록 HTTP 503"), ("large", "영상 목록 크기 한도를 넘었습니다.")]:
            self.page.evaluate("m=>{metadataMode=m;start()}", mode)
            expect(self.page.locator("#thumb-images-status")).to_contain_text(text)
            expect(self.page.locator("#thumb-images-retry")).to_be_enabled()

        self.page.evaluate("metadataMode='ok';lookupMode='bad';start()")
        expect(self.page.locator("#thumb-images-status")).to_have_text("0 / 12 images ready")
        expect(self.page.locator(".thumb-image-preview").first).to_contain_text("원본 식별자를 확인할 수 없습니다.")
        expect(self.page.locator(".thumb-image-open").first).to_be_disabled()
        for mode, text in [("mime", "PNG 응답 형식이 아닙니다."), ("large", "영상 크기 한도를 넘었습니다.")]:
            self.page.evaluate("([m])=>{lookupMode='ok';renderMode=m;document.querySelector('#thumb-images-retry').click()}", [mode])
            expect(self.page.locator("#thumb-images-status")).to_have_text("0 / 12 images ready")
            expect(self.page.locator(".thumb-image-preview").first).to_contain_text(text)

        self.page.evaluate("""()=>{renderMode='ok';Image.prototype.decode=()=>Promise.reject(Error('bad image'));document.querySelector('#thumb-images-retry').click()}""")
        expect(self.page.locator("#thumb-images-status")).to_have_text("0 / 12 images ready")
        expect(self.page.locator(".thumb-image-preview").first).to_contain_text("원본 영상을 표시하지 못했습니다.")

    def test_authorization_or_network_failure_stops_new_workers_and_retry_recovers(self):
        self.page.evaluate("lookupMode='403';start()")
        expect(self.page.locator("#thumb-images-status")).to_contain_text("일부 요청이 중단됐습니다.")
        self.assertEqual(4, self.page.evaluate("apiCalls.length"))
        expect(self.page.locator(".thumb-image-preview").nth(4)).to_have_text("Not loaded · Retry Images")
        self.page.evaluate("lookupMode='ok';document.querySelector('#thumb-images-retry').click()")
        expect(self.page.locator("#thumb-images-status")).to_have_text("12 / 12 images ready")
        self.assertEqual(16, self.page.evaluate("apiCalls.length"))
        self.assertEqual(12, self.page.locator(".thumb-image-open:enabled").count())
        for mode, expected_calls in (("401", 20), ("network", 24)):
            self.page.evaluate("m=>{lookupMode=m;document.querySelector('#thumb-images-retry').click()}", mode)
            expect(self.page.locator("#thumb-images-status")).to_contain_text("일부 요청이 중단됐습니다.")
            self.assertEqual(expected_calls, self.page.evaluate("apiCalls.length"))
            expect(self.page.locator(".thumb-image-preview").nth(4)).to_have_text("Not loaded · Retry Images")


if __name__ == "__main__":
    unittest.main(verbosity=2)
