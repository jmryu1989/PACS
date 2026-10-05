# coding: utf-8
"""REQ-S8-CTX / D549 -> RISK-CTX-BLANK/WORK/SESSION -> CTX-DOM.

Real browser DOM, WebGL and Web Locks, shipped boundary/transport/recovery. Synthetic
grid adapters provide current ownership; they do not emulate the pinned OHIF renderer.
"""
import json
import os
import time
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HP = ROOT / 'worklist-v0/hpacs-lite'
BASE = 'https://context.test'
SCOPE = '/ohif/viewer?StudyInstanceUIDs=1.2.3,1.2.4&initialSeriesInstanceUID=1.2.5&hangingProtocolId=compare&kinJob=saved&kinFinding=once&kinFindingRevision=1&kinFindingSource=1.2.3&kinFindingNonce=nonce'
HARNESS = r'''
<style>.image{position:relative;width:480px;height:520px;display:inline-block;background:#444}</style>
<input aria-label="Report" value="retained report"><button id="save">Save Report</button>
<div class="image" id="image0"></div><div class="image" id="image1"></div>
<script src="/worklist/hpacs-lite/work-context.js"></script>
<script src="/worklist/hpacs-lite/session-transport.js"></script>
<script src="/worklist/hpacs-lite/viewer-resources.js"></script>
<script src="/worklist/hpacs-lite/viewer-session.js"></script>
<script src="/worklist/hpacs-lite/viewer-context-loss.js"></script>
<script>
window.boot = (async()=>{
 if(!history.state?.kinViewerSession)history.replaceState({kinViewerSession:{session:'S1',ended:false}},'');
 const boundary=KinViewerSession.connect(window); await boundary.ready;
 window.findingConsumed=new URL(location).searchParams.has('kinFinding');
 window.engines=[];window.views=new Map();window.enabled=new Map();window.grid=new Map();
 window.makeEngine=(id)=>{
   const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2');
   if(!gl||!gl.getExtension('WEBGL_lose_context'))throw Error('WebGL loss extension unavailable');
   const engine={id,gl,canvas,lossExtension:gl.getExtension('WEBGL_lose_context'),renders:0,offscreenMultiRenderWindow:{getOpenGLRenderWindow:()=>({getContext:()=>gl})},
    render(){this.renders++},renderViewport(){this.renders++},resize(){this.renders++}}; engines.push(engine);return engine;
 };
 window.putView=(id,engine,element=document.getElementById('image'+id))=>{
   const view={id,element,type:'stack',getRenderingEngine:()=>engine};views.set(id,view);grid.set(id,{});enabled.set(element,{viewport:view});return view;
 };
 for(let i=0;i<2;i++)putView(String(i),makeEngine(String(i)));
 window.cornerstone={getEnabledElement:e=>enabled.get(e),Enums:{Events:{IMAGE_RENDERED:'IMAGE_RENDERED'}}};
 window.services={viewportGridService:{getState:()=>({viewports:grid})},cornerstoneViewportService:{getCornerstoneViewport:id=>views.get(id)}};
 window.role='read-only';window.work={dirty:false,busy:false};window.pending=null;
 window.kinViewerHistoryWorkspaceState=()=>({...work});
 window.kinViewerJobWorkspaceState=()=>({...work});window.kinViewerTechNoteWorkspaceState=()=>({...work});
 window.kinViewerJobCommand={pending:()=>pending};
 window.coverageCalls=0;window.kinViewerFrameCoverageConfirm=()=>{coverageCalls++;return true};
 window.session={state:()=>role,writer:()=>role==='writer',sameAccount:me=>me?.sub==='reader'&&me?.institution==='hospital',ended:()=>boundary.ended()};
 window.releases=[];
 window.recovery=KinViewerContextLoss.create({services,session});window.kinViewerContextLoss=recovery;
 recovery.onContextLoss(info=>releases.push(info.engine.id));recovery.start();
 window.lose=i=>engines[i].gl.getExtension('WEBGL_lose_context').loseContext();
 return true;
})();
</script>'''


class ViewerContextLossDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, args=['--enable-unsafe-swiftshader'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 1200, 'height': 850})
        self.audit, self.requests = [], []
        self.me = {'kind': 'member', 'sub': 'reader', 'institution': 'hospital', 'sessionId': 'S1'}
        self.status, self.me_hook = 200, None
        self.context.route(BASE + '/**', self.route)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.accept_dialog = lambda d: d.accept()
        self.page.on('dialog', self.accept_dialog)
        self.page.goto(BASE + SCOPE)
        self.page.evaluate('boot')
        self.page.wait_for_timeout(80)

    def tearDown(self):
        self.context.close()

    def route(self, route):
        path = route.request.url[len(BASE):].split('?')[0]
        if path.startswith('/worklist/hpacs-lite/'):
            name = path.rsplit('/', 1)[-1]
            source = Path(os.environ.get('KIN_CTX_' + name.replace('-', '_').replace('.', '_').upper(), HP / name))
            route.fulfill(body=source.read_text(encoding='utf-8'), content_type='text/javascript; charset=utf-8')
        elif path.startswith('/api/'):
            self.requests.append((path, route.request.headers.get('x-kin-session')))
            if path.endswith('/viewer-context-events'):
                self.audit.append(route.request.post_data_json)
                route.fulfill(json={'recorded': True})
            else:
                if self.me_hook:
                    self.me_hook()
                route.fulfill(status=self.status, json=self.me)
        else:
            route.fulfill(body=HARNESS if path.startswith('/ohif/') else '<input id="parent-report" value="parent text"><textarea id="dictation">spoken</textarea>', content_type='text/html; charset=utf-8')

    def lose(self, index=0, page=None):
        page = page or self.page
        page.evaluate('(i)=>lose(i)', index)
        expect(page.get_by_role('heading', name='Viewer Recovery').first).to_be_visible()

    def click_reload(self, page=None):
        (page or self.page).get_by_role('button', name='Reload Viewer', exact=True).first.click()

    def test_normal_paths_and_healthy_synthetic_event(self):
        p = self.page
        p.get_by_label('Report').focus()
        p.evaluate('engines.forEach(e=>e.canvas.dispatchEvent(new Event("webglcontextlost")))')
        p.evaluate('grid.delete("1");engines[1].gl.getExtension("WEBGL_lose_context").loseContext()')
        p.evaluate('putView("0",makeEngine("replacement"));engines[0].gl.getExtension("WEBGL_lose_context").loseContext()')
        p.evaluate('makeEngine("print").gl.getExtension("WEBGL_lose_context").loseContext()')
        p.evaluate('recovery.stop();recovery.start();document.dispatchEvent(new Event("visibilitychange"))')
        p.wait_for_timeout(450)
        self.assertEqual(p.get_by_role('heading', name='Viewer Recovery').count(), 0)
        self.assertEqual(p.evaluate('document.activeElement.getAttribute("aria-label")'), 'Report')
        self.assertEqual(self.audit, [])

    def test_second_engine_real_loss_cover_scope_and_synchronous_release(self):
        p = self.page
        p.get_by_label('Report').focus()
        self.lose(1)
        self.assertEqual(p.locator('#image0 [aria-label="Viewer Recovery"]').count(), 0)
        self.assertEqual(p.locator('#image1').get_by_role('heading', name='Viewer Recovery').count(), 1)
        self.assertEqual(p.evaluate('releases'), ['1'])
        expect(p.get_by_label('Report')).to_have_value('retained report')
        p.locator('#save').click()
        p.evaluate('engines[1].render();engines[1].resize();engines[0].render()')
        self.assertEqual(p.evaluate('engines.map(e=>e.renders)'), [1, 0])
        self.assertEqual(p.evaluate('document.activeElement.id'), 'save')

    def test_loss_before_watch_duplicate_late_and_throwing_callbacks_restore(self):
        p = self.page
        p.evaluate('recovery.stop();lose(0)')
        p.wait_for_timeout(50)
        p.evaluate('recovery.onContextLoss(()=>{throw Error("borrower")});recovery.start()')
        expect(p.get_by_role('heading', name='Viewer Recovery')).to_be_visible()
        p.evaluate('window.late=0;recovery.onContextLoss(()=>late++);engines[0].canvas.dispatchEvent(new Event("webglcontextlost"))')
        self.assertEqual(p.evaluate('[late,releases.length]'), [1, 1])
        p.evaluate('engines[0].canvas.dispatchEvent(new Event("webglcontextrestored"))')
        expect(p.get_by_role('heading', name='Viewer Recovery')).to_be_visible()
        self.assertFalse(p.evaluate('recovery.usable(engines[0])'))
        # The extension may reject restore if the loss predates listener attachment;
        # use the currently watched second context for the real restoration transition.
        p.evaluate('lose(1)'); p.wait_for_timeout(100)
        p.evaluate('engines[1].lossExtension.restoreContext()')
        p.wait_for_function('!engines[1].gl.isContextLost()')
        expect(p.locator('#image1').get_by_role('heading', name='Viewer Recovery')).to_be_visible()
        self.assertFalse(p.evaluate('recovery.usable(engines[1])'))

    def test_fact_before_event_and_current_borrower_vr(self):
        p = self.page
        p.evaluate('''() => {
          const d=document.createElement('dialog'),el=document.createElement('div');el.dataset.kinVrRender='1';
          el.style.cssText='width:480px;height:500px';d.append(el);document.body.append(d);d.showModal();
          const engine=makeEngine('vr'),view={element:el,type:'volume3d',getRenderingEngine:()=>engine};
          enabled.set(el,{viewport:view});engine.gl.getExtension('WEBGL_lose_context').loseContext();
          window.allowed=recovery.usable(engine);
          window.releasedBeforeReturn=releases.includes('vr');
        }''')
        self.assertFalse(p.evaluate('allowed'))
        self.assertTrue(p.evaluate('releasedBeforeReturn'))
        expect(p.locator('dialog').get_by_role('heading', name='Viewer Recovery')).to_be_visible()

    def test_no_automatic_reload_and_read_only_guard_not_applicable(self):
        self.lose()
        self.page.evaluate('delete window.kinViewerJobWorkspaceState;delete window.kinViewerTechNoteWorkspaceState;delete window.kinViewerJobCommand')
        self.page.wait_for_timeout(300)
        self.assertIn('kinFinding=once', self.page.url)
        self.click_reload()
        self.page.wait_for_function('window.boot && !new URL(location).searchParams.has("kinFinding")')
        self.page.evaluate('boot')
        self.assertFalse(self.page.evaluate('findingConsumed'))
        self.assertEqual(self.page.evaluate('KinViewerSessionBoundary.session()'), 'S1')
        self.assertIn('kinJob=saved', self.page.url)
        self.assertIn('StudyInstanceUIDs=1.2.3', self.page.url)
        self.assertEqual(self.page.evaluate('sessionStorage.getItem("kin-viewer-recovery")'), None)
        self.assertTrue(all(session == 'S1' for _, session in self.requests))

    def test_writer_missing_guard_busy_unknown_and_dirty_kept(self):
        p = self.page
        self.lose()
        p.evaluate('role="writer";delete window.kinViewerTechNoteWorkspaceState')
        self.click_reload()
        expect(p.get_by_role('status')).to_contain_text('상태를 확인할 수 없습니다')
        p.evaluate('kinViewerTechNoteWorkspaceState=()=>({...work});work.busy=true;work.dirty=true')
        self.click_reload()
        expect(p.get_by_role('status')).to_contain_text('진행 중')
        expect(p.get_by_role('button', name='Discard Viewer Changes & Reload')).to_be_hidden()
        p.evaluate('work.busy=false;pending={requestId:"retained"}')
        self.click_reload()
        expect(p.get_by_role('status')).to_contain_text('저장 결과')
        p.evaluate('pending=null')
        self.click_reload()
        expect(p.get_by_role('status')).to_contain_text('미저장')
        expect(p.get_by_role('button', name='Discard Viewer Changes & Reload')).to_be_visible()
        self.assertTrue(p.evaluate('work.dirty'))
        expect(p.get_by_label('Report')).to_have_value('retained report')

    def test_admission_cookie_stale_storage_and_read_failure(self):
        p = self.page
        p.evaluate('localStorage.setItem("kin-session-end",JSON.stringify({session:"old"}));document.cookie="kin-session-end="+encodeURIComponent(JSON.stringify({session:"S1"}))+";path=/"')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()'), {'status': 'refused', 'reason': 'session-ended'})
        self.assertTrue(p.evaluate('KinViewerSessionBoundary.active()'))
        p.evaluate('document.cookie="kin-session-end=;Max-Age=0;path=/";localStorage.removeItem("kin-session-end");Object.defineProperty(window,"localStorage",{get(){throw Error("unreadable")}})')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()'), {'status': 'unknown'})
        self.assertTrue(p.evaluate('KinViewerSessionBoundary.active()'))

    def test_real_held_and_pending_ended_lock(self):
        p = self.page
        peer = self.context.new_page()
        peer.goto(BASE + '/peer')
        peer.evaluate('void navigator.locks.request("kin-session-ended:S1",{mode:"shared"},()=>new Promise(r=>window.release=r))')
        peer.wait_for_function('!!window.release')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()')['status'], 'refused')
        peer.evaluate('void navigator.locks.request("kin-session-ended:S1",()=>new Promise(()=>{}))')
        snapshot = p.evaluate('navigator.locks.query()')
        self.assertTrue(snapshot['pending'])
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()')['status'], 'refused')

    def test_preparation_other_document_wrong_resume_and_release(self):
        p = self.page
        peer = self.context.new_page(); peer.goto(BASE + '/peer')
        peer.evaluate('void navigator.locks.request("kin-preparation:P1",()=>new Promise(r=>window.release=r));window.channel=new BroadcastChannel("kin-session")')
        peer.wait_for_function('!!window.release')
        peer.evaluate('channel.postMessage({type:"session-preparing",session:"S1",preparation:"P1"})')
        p.wait_for_function('KinWorkContext.state()==="preparing"')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()'), {'status': 'refused', 'reason': 'preparing'})
        peer.evaluate('channel.postMessage({type:"session-resumed",session:"S1",preparation:"wrong"})')
        p.wait_for_timeout(50)
        self.assertEqual(p.evaluate('KinWorkContext.state()'), 'preparing')
        peer.close()
        p.wait_for_function('KinWorkContext.state()==="active"')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()')['status'], 'allowed')

    def test_lock_query_failure_does_not_end_and_same_button_retries(self):
        p = self.page; self.lose()
        p.evaluate('() => {window.query=navigator.locks.query.bind(navigator.locks);navigator.locks.query=async()=>{throw Error("failed")};}')
        self.click_reload()
        expect(p.get_by_role('status')).to_contain_text('복구 허가')
        self.assertTrue(p.evaluate('KinViewerSessionBoundary.active()'))
        p.evaluate('() => {navigator.locks.query=query}')
        self.click_reload()
        p.wait_for_function('!new URL(location).searchParams.has("kinFinding")')

    def test_account_same_user_new_session_and_http_refusals(self):
        p = self.page; self.lose()
        self.me['sessionId'] = 'S2'
        self.click_reload(); expect(p.get_by_role('status')).to_contain_text('로그인 세션')
        self.me['sessionId'] = 'S1'
        for status in (401, 403, 500):
            self.status = status; self.click_reload()
            expect(p.get_by_role('status')).to_contain_text('로그인 확인 요청')
            self.assertTrue(p.evaluate('KinViewerSessionBoundary.active()'))

    def test_g4_preparation_race_no_navigation(self):
        p = self.page; self.lose()
        self.me_hook = lambda: p.evaluate('KinWorkContext.prepare({preparationId:"during-me"})')
        self.click_reload()
        p.wait_for_timeout(100)
        self.assertIn('kinFinding=once', p.url)
        self.assertEqual(p.evaluate('KinWorkContext.state()'), 'preparing')

    def test_initial_identity_failure_can_retry_on_same_button(self):
        p = self.page; self.status = 500
        p.reload(); p.evaluate('boot'); p.wait_for_timeout(80); self.lose()
        self.click_reload(); expect(p.get_by_role('status')).to_contain_text('로그인 확인 요청')
        self.status = 200; self.click_reload()
        p.wait_for_function('!new URL(location).searchParams.has("kinFinding")'); p.evaluate('boot')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.session()'), 'S1')

    def test_repeat_across_reload_duplicate_once_and_expiry(self):
        p = self.page; self.lose()
        p.evaluate('engines[0].canvas.dispatchEvent(new Event("webglcontextlost"));lose(1)')
        self.assertEqual(p.get_by_text('영상 표시 장애가 반복되고 있습니다.', exact=False).count(), 0)
        self.click_reload(); p.wait_for_function('!new URL(location).searchParams.has("kinFinding")'); p.evaluate('boot')
        p.wait_for_timeout(80); self.lose()
        expect(p.get_by_text('영상 표시 장애가 반복되고 있습니다.', exact=False)).to_contain_text('3D 기능 사용을 중단하고 지원 담당자')
        losses = [a for a in self.audit if a['stage'] == 'loss']
        self.assertEqual([a['repeatCount'] for a in losses], [1, 2])
        p.evaluate('''() => { for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k.startsWith('kin-viewer-faults:')){const v=JSON.parse(sessionStorage.getItem(k));v.times=v.times.map(()=>Date.now()-300001);sessionStorage.setItem(k,JSON.stringify(v));}} }''')
        self.click_reload(); p.wait_for_load_state(); p.wait_for_timeout(150); p.evaluate('boot'); self.lose()
        self.assertEqual(p.get_by_text('영상 표시 장애가 반복되고 있습니다.', exact=False).count(), 0)

    def test_iframe_and_popup_reload_preserve_parent_and_binding(self):
        parent = self.context.new_page(); parent.goto(BASE + '/parent')
        parent.evaluate('(url)=>{const f=document.createElement("iframe");f.src=url;f.style="width:1100px;height:750px";document.body.append(f)}', BASE + SCOPE)
        parent.wait_for_timeout(250); frame = parent.frames[1]; frame.evaluate('boot'); frame.wait_for_timeout(80)
        self.lose(page=frame); self.click_reload(frame)
        frame.wait_for_function('!new URL(location).searchParams.has("kinFinding")'); frame.evaluate('boot')
        expect(parent.locator('#parent-report')).to_have_value('parent text'); expect(parent.locator('#dictation')).to_have_value('spoken')
        self.assertEqual(frame.evaluate('KinViewerSessionBoundary.session()'), 'S1')
        with parent.expect_popup() as popup:
            parent.evaluate('(url)=>window.open(url,"viewer")', BASE + SCOPE)
        separate = popup.value; separate.on('dialog', lambda d: d.accept()); separate.wait_for_load_state(); separate.evaluate('boot'); separate.wait_for_timeout(80)
        self.lose(page=separate); self.click_reload(separate)
        separate.wait_for_function('!new URL(location).searchParams.has("kinFinding")'); separate.evaluate('boot')
        self.assertEqual(separate.evaluate('KinViewerSessionBoundary.session()'), 'S1')
        expect(parent.locator('#parent-report')).to_have_value('parent text')

    def mount_mip(self, wait=True):
        for name in ('volume-mip.js', 'volume-voi.js', 'volume-mip-job.js', 'volume-mip-batch.js', 'viewer-volume-mip.js'):
            self.page.add_script_tag(url=BASE + '/worklist/hpacs-lite/' + name)
        self.page.add_script_tag(content=(ROOT / 'tests/viewer_context_loss_fixture.js').read_text(encoding='utf-8'))
        self.page.evaluate('mountContextMip()' if wait else 'void mountContextMip().catch(e=>window.mipOpenFailure=e.message)')

    def test_mip_loss_keeps_title_description_unknown_save_and_not_final(self):
        p = self.page; self.mount_mip()
        p.wait_for_function('document.querySelector("#kin-volume-mip").dataset.kinMipState==="final"')
        p.get_by_label('MIP Job Title', exact=True).fill('unsaved title')
        p.get_by_label('MIP Job Description', exact=True).fill('unsaved description')
        p.get_by_role('button', name='Save MIP Job', exact=True).click()
        p.wait_for_function('!!pending')
        self.lose()
        p.wait_for_timeout(300)
        expect(p.get_by_label('MIP Job Title', exact=True)).to_have_value('unsaved title')
        expect(p.get_by_label('MIP Job Description', exact=True)).to_have_value('unsaved description')
        self.assertEqual(p.locator('#kin-volume-mip').get_attribute('data-kin-mip-state'), 'stopped')
        self.assertTrue(p.evaluate('mip.job.recoveryState().unknown'))
        p.get_by_role('button', name='Close MIP Viewer').click()
        self.assertTrue(p.locator('#kin-volume-mip').evaluate('(d)=>d.open'))

    def test_mip_loss_before_render_event_cannot_be_final(self):
        self.page.evaluate('window.loseBeforeFrame=true')
        self.mount_mip()
        self.page.wait_for_timeout(80)
        self.assertNotEqual(self.page.locator('#kin-volume-mip').get_attribute('data-kin-mip-state'), 'final')
        self.assertTrue(self.page.locator('#kin-volume-mip').evaluate('(d)=>d.open'))

    def test_mip_batch_late_blob_does_not_commit(self):
        p = self.page; self.mount_mip()
        p.wait_for_function('document.querySelector("#kin-volume-mip").dataset.kinMipState==="final"')
        p.evaluate('window.holdBlob=true')
        p.get_by_label('MIP Batch Number', exact=True).fill('2')
        p.get_by_role('button', name='Make MIP Batch', exact=True).click()
        p.wait_for_function('!!window.finishBlob')
        self.lose(); p.evaluate('finishBlob()'); p.wait_for_timeout(80)
        expect(p.locator('.kin-mip-batch-result')).to_be_hidden()

    def test_mip_loss_during_volume_load_keeps_stopped_dialog(self):
        p = self.page; p.evaluate('window.holdVolumes=true'); self.mount_mip(wait=False)
        p.wait_for_function('!!window.finishVolumes'); self.lose()
        p.evaluate('finishVolumes()'); p.wait_for_function('!!window.mipOpenFailure')
        self.assertTrue(p.locator('#kin-volume-mip').evaluate('(d)=>d.open'))
        expect(p.locator('#kin-volume-mip')).to_have_attribute('data-kin-mip-state', 'stopped')

    def test_recovery_audit_waits_for_rendered_image_and_is_not_replayed(self):
        p = self.page; self.lose(); self.click_reload()
        p.wait_for_function('!new URL(location).searchParams.has("kinFinding")'); p.evaluate('boot'); p.wait_for_timeout(120)
        self.assertFalse(any(a['result'] == 'succeeded' for a in self.audit))
        p.evaluate('views.get("0").element.dispatchEvent(new Event("IMAGE_RENDERED"))'); p.wait_for_timeout(100)
        self.assertEqual(len([a for a in self.audit if a['result'] == 'succeeded']), 1)
        p.evaluate('views.get("0").element.dispatchEvent(new Event("IMAGE_RENDERED"))'); p.wait_for_timeout(80)
        self.assertEqual(len([a for a in self.audit if a['result'] == 'succeeded']), 1)
        self.assertTrue(all('text' not in a and 'actor' not in a for a in self.audit))

    def test_frame_coverage_does_not_credit_loss_before_delivery(self):
        p = self.page
        def metadata(route):
            study = route.request.url.split('/studies/')[1].split('/')[0]
            row = {'0020000D': {'Value': [study]}, '0020000E': {'Value': ['1.2.5']}, '00080018': {'Value': ['1.2.6']},
                   '00080016': {'Value': ['1.2.840.10008.5.1.4.1.1.2']}, '00280010': {'Value': [2]}, '00280011': {'Value': [2]}}
            route.fulfill(json=[row])
        self.context.route(BASE + '/dicom-web/**', metadata)
        p.add_script_tag(url=BASE + '/worklist/hpacs-lite/viewer-frame-coverage.js')
        p.evaluate('''() => {
          const host=document.createElement('div');host.id='kin-viewer-layout';document.body.append(host);
          localStorage.setItem('kin-frame-warning:v1:'+JSON.stringify(['hospital','reader']),'true');
          cornerstone.getEnabledElements=()=>[];cornerstone.metaData={get:()=>({StudyInstanceUID:'1.2.3',SeriesInstanceUID:'1.2.5',SOPInstanceUID:'1.2.6'})};
          const v=views.get('0'),image='/studies/1.2.3/series/1.2.5/instances/1.2.6/frames/1';
          Object.assign(v,{viewportStatus:'rendered',getCurrentImageId:()=>image,csImage:{imageId:image},stackInvalidated:false});
          window.coverage=KinFrameCoverage.mount(services);
        }''')
        p.wait_for_function('kinViewerFrameCoverageState().phase==="ready"')
        p.evaluate('''() => {lose(0);const element=views.get('0').element;element.dispatchEvent(new CustomEvent('IMAGE_RENDERED',{bubbles:true,detail:{element,viewportId:'0'}}));}''')
        self.assertEqual(p.evaluate('kinViewerFrameCoverageState().shown'), 0)

    def test_tech_note_real_input_busy_and_unknown_are_preserved(self):
        p = self.page
        p.add_script_tag(url=BASE + '/worklist/hpacs-lite/tech-note.js')
        p.evaluate('''() => {
          window.note=KinTechNote({allowed:()=>true,api:async(method)=>method==='GET'?{uid:'1.2.3',writable:true,note:null}:new Promise((r,j)=>window.failNote=()=>j(Error('unknown')))});
          note.open({uid:'1.2.3'});
        }''')
        p.get_by_label('Note', exact=True).fill('kept note')
        p.get_by_role('button', name='Save Note', exact=True).click()
        self.assertTrue(p.evaluate('note.workspaceState().busy'))
        p.evaluate('lose(0);failNote()'); p.wait_for_timeout(80)
        expect(p.get_by_label('Note', exact=True)).to_have_value('kept note')
        self.assertTrue(p.evaluate('note.workspaceState().unknown'))
        p.get_by_role('button', name='Close', exact=True).click()
        self.assertTrue(p.locator('#tech-note-dialog').evaluate('(d)=>d.open'))

    def test_foreign_and_old_entry_markers_are_consumed_as_ordinary_entry(self):
        p = self.page
        for changed in ('session', 'account', 'entry', 'href'):
            with self.subTest(changed=changed):
                p.evaluate('''changed => {
                  const own=history.state.kinViewerContext,marker={...own,href:location.href,faultId:crypto.randomUUID(),repeatCount:1,at:Date.now()};
                  marker[changed]='different';
                  sessionStorage.setItem('kin-viewer-recovery',JSON.stringify(marker));
                  history.replaceState({...history.state,kinViewerRecovery:marker},'');
                }''', changed)
                p.reload(); p.evaluate('boot'); p.wait_for_timeout(60)
                self.assertTrue(p.evaluate('findingConsumed'))
                self.assertIsNone(p.evaluate('KinViewerSessionBoundary.recovery'))
                self.assertIsNone(p.evaluate('sessionStorage.getItem("kin-viewer-recovery")'))
                self.assertTrue(p.evaluate('KinViewerSessionBoundary.active()'))

    def test_cancelled_unload_keeps_url_guards_and_inputs(self):
        p = self.page; self.lose()
        p.evaluate('window.addEventListener("beforeunload",e=>{e.preventDefault();e.returnValue=""})')
        p.remove_listener('dialog', self.accept_dialog); p.on('dialog', lambda d: d.dismiss())
        self.click_reload(); p.wait_for_timeout(100)
        self.assertIn('kinFinding=once', p.url)
        expect(p.get_by_label('Report')).to_have_value('retained report')
        expect(p.get_by_role('heading', name='Viewer Recovery')).to_be_visible()

    def test_cookie_only_lock_unsupported_and_failed_audit_not_success(self):
        p = self.page
        p.evaluate('document.cookie="kin-session-end="+encodeURIComponent(JSON.stringify({session:"S1"}))+";path=/"')
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()')['reason'], 'session-ended')
        p.evaluate('document.cookie="kin-session-end=;Max-Age=0;path=/"')
        self.context.route(BASE + '/api/studies/*/viewer-context-events', lambda r: r.fulfill(status=500, json={'error': 'unavailable'}))
        self.lose(); p.wait_for_timeout(60)
        self.assertEqual(p.evaluate('recovery.auditState()'), 'unknown')
        p.add_init_script('Object.defineProperty(navigator,"locks",{value:undefined})')
        p.reload(); p.evaluate('boot'); p.wait_for_timeout(60)
        self.assertEqual(p.evaluate('KinViewerSessionBoundary.recoveryAdmission()')['status'], 'allowed')

    def test_g3_runs_after_account_check_and_rechecks_session_before_navigation(self):
        p = self.page; self.lose()
        p.evaluate('window.kinViewerFrameCoverageConfirm=()=>{document.cookie="kin-session-end="+encodeURIComponent(JSON.stringify({session:"S1"}))+";path=/";return true}')
        self.click_reload(); p.wait_for_timeout(60)
        self.assertIn('kinFinding=once', p.url)
        expect(p.get_by_role('status')).to_contain_text('세션이 종료')

    def test_g4_body_deadline_late_body_cannot_navigate_or_issue_coverage_permit(self):
        p = self.page
        p.add_init_script('''(() => {
          const send=window.fetch.bind(window);
          window.fetch=async (url,init)=>{
            const response=await send(url,init);
            if(url!=='/api/me'||!window.holdMeBody)return response;
            const bytes=new TextEncoder().encode(await response.text());
            return new Response(new ReadableStream({start(controller){
              window.finishMe=()=>{try{controller.enqueue(bytes);controller.close()}catch(_){}};
              init.signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});
            }}),{status:200,headers:response.headers});
          };
        })()''')
        p.reload(); p.evaluate('boot'); p.wait_for_timeout(80); self.lose()
        p.evaluate('window.holdMeBody=true')
        start = time.monotonic(); self.click_reload()
        expect(p.get_by_role('status')).to_contain_text('로그인 확인 요청', timeout=15000)
        self.assertLess(time.monotonic() - start, 15)
        p.evaluate('finishMe()'); p.wait_for_timeout(80)
        self.assertEqual(p.evaluate('coverageCalls'), 0)
        self.assertIn('kinFinding=once', p.url)
        self.assertTrue(p.evaluate('KinViewerSessionBoundary.active()'))

    def test_tech_note_later_revision_resolves_uncertainty_without_discard(self):
        p = self.page; p.add_script_tag(url=BASE + '/worklist/hpacs-lite/tech-note.js')
        p.evaluate('''() => {
          window.noteRevision=0;
          window.note=KinTechNote({allowed:()=>true,api:async(method,path)=>{
            if(method==='POST'){noteRevision=2;throw Error('lost receipt')}
            if(path.includes('/history?before=2'))return {uid:'1.2.3',items:[{studyUid:'1.2.3',version:1,text:'my input',reason:''}],nextBefore:null};
            return {uid:'1.2.3',writable:true,note:noteRevision?{studyUid:'1.2.3',version:2,text:'later input',reason:'later',author:'reader',createdAt:'2026-10-05T00:00:00Z'}:null};
          }});note.open({uid:'1.2.3'});
        }''')
        p.get_by_label('Note', exact=True).fill('my input'); p.get_by_role('button', name='Save Note', exact=True).click()
        p.wait_for_function('note.workspaceState().unknown && !note.workspaceState().busy')
        p.get_by_role('button', name='Save Note', exact=True).click()
        p.wait_for_function('!note.workspaceState().unknown && !note.workspaceState().busy')
        expect(p.get_by_label('Note', exact=True)).to_have_value('my input')
        self.assertTrue(p.evaluate('note.workspaceState().dirty'))

    def test_tech_note_conflicting_revision_resolves_uncertainty_keeps_input(self):
        p = self.page; p.add_script_tag(url=BASE + '/worklist/hpacs-lite/tech-note.js')
        p.evaluate('''() => {
          window.noteRevision=0;
          window.note=KinTechNote({allowed:()=>true,api:async(method,path)=>{
            if(method==='POST'){noteRevision=1;throw Error('conflicting attempt')}
            return {uid:'1.2.3',writable:true,note:noteRevision?{studyUid:'1.2.3',version:1,text:'other input',reason:'',author:'other',createdAt:'2026-10-05T00:00:00Z'}:null};
          }});note.open({uid:'1.2.3'});
        }''')
        p.get_by_label('Note', exact=True).fill('my input'); p.get_by_role('button', name='Save Note', exact=True).click()
        p.wait_for_function('note.workspaceState().unknown && !note.workspaceState().busy')
        p.get_by_role('button', name='Save Note', exact=True).click()
        p.wait_for_function('!note.workspaceState().unknown && !note.workspaceState().busy')
        expect(p.get_by_label('Note', exact=True)).to_have_value('my input')
        self.assertTrue(p.evaluate('note.workspaceState().dirty'))


if __name__ == '__main__':
    unittest.main()
