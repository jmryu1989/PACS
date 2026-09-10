# coding: utf-8
"""REQ-D-WORKSPACE-FRAME-COVERAGE / RISK-FALSE-COVERAGE/LOSS / TEST-FRAME-COVERAGE."""
import sys
import unittest
from playwright.sync_api import expect
from test_viewer_windows import ViewerWindowsE2E


class FrameCoverageE2E(ViewerWindowsE2E):
    def enable(self, viewer):
        try:
            viewer.wait_for_function("() => typeof kinViewerFrameCoverageState==='function' && document.querySelector('#kin-frame-warning') && !document.querySelector('#kin-frame-warning').disabled")
        except Exception:
            print('COVERAGE CONNECTION',viewer.evaluate("""() => ({extensions:config.extensions.map(e=>e.id),core:!!window.cornerstone,module:!!window.KinFrameCoverage,state:window.kinViewerFrameCoverageState?.(),panel:document.querySelector('#kin-frame-coverage')?.textContent,scripts:[...document.scripts].map(s=>s.src).filter(s=>/coverage|config/.test(s))})"""),flush=True)
            raise
        viewer.get_by_role('button', name='Comparison', exact=True).click()
        viewer.locator('#kin-frame-warning').check()
        viewer.wait_for_function("() => kinViewerFrameCoverageState().phase==='ready'", timeout=30000)
        try:
            viewer.wait_for_function('() => kinViewerFrameCoverageState().shown>0')
        except Exception:
            print('COVERAGE VISIBILITY',viewer.evaluate("""() => {
                const v=cornerstone.getEnabledElements()[0].viewport,levels=[];let w=window,e=v.element;
                while(e){const r=e.getBoundingClientRect(),hit=w.document.elementFromPoint(Math.max(0,r.left)+Math.min(r.width,w.innerWidth)/2,Math.max(0,r.top)+Math.min(r.height,w.innerHeight)/2);levels.push({element:e.tagName,id:e.id,rect:r.toJSON(),hit:hit?.outerHTML.slice(0,600),modal:!!w.document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show'),inert:!!e.closest('[inert]')});if(w===w.top)break;e=w.frameElement;w=w.parent;}
                return {levels,state:kinViewerFrameCoverageState(),bound:v.csImage?.imageId,current:v.getCurrentImageId(),invalid:v.stackInvalidated,status:v.viewportStatus};
            }"""),flush=True)
            page=viewer.page if hasattr(viewer,'page') else viewer
            page.screenshot(path='../tmp/frame-coverage/visibility-diagnostic.png')
            raise

    def render_index(self, viewer, index):
        viewer.evaluate("""async index => {
            const v=cornerstone.getEnabledElements().map(e=>e.viewport).find(v=>v.type==='stack');
            await v.setImageIdIndex(index);v.render();
            await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
        }""", index)

    def test_coverage_01_real_frames_cancel_close_then_all_shown(self):
        a,b=self.pair();original=self.originals()
        p=self.sign_in(self.device());self.limit(p,2);v=self.separate(p,a)
        self.enable(v)
        state=v.evaluate('kinViewerFrameCoverageState()')
        self.assertEqual(state['total'],4);self.assertGreater(state['remaining'],0)
        v.evaluate("window.__coverageKeep='kept'")
        self.manager(p)
        prompts=[]
        p.once('dialog',lambda d:(prompts.append(d.message),d.dismiss()))
        self.control(p,0,'close').click()
        self.assertEqual(len(prompts),1);self.assertIn('원본 프레임',prompts[0])
        expect(p.locator('#viewer-windows-status')).to_contain_text('닫지 않았습니다')
        self.assertEqual(v.evaluate('window.__coverageKeep'),'kept')
        native=[]
        v.once('dialog',lambda d:(native.append(d.type),d.dismiss()))
        with v.expect_event('dialog'):
            v.close(run_before_unload=True)
        self.assertEqual(native,['beforeunload']);self.assertFalse(v.is_closed())
        for index in range(4):
            self.render_index(v,index)
            v.wait_for_function('n => kinViewerFrameCoverageState().shown>=n',arg=index+1)
        self.assertEqual(v.evaluate('kinViewerFrameCoverageState().remaining'),0)
        self.control(p,0,'close').click();self.assertTrue(v.is_closed())
        self.assertEqual(self.originals(),original)

    def test_coverage_02_metadata_failure_retry_and_reuse_cancel(self):
        a,b=self.pair();p=self.sign_in(self.device());self.limit(p,1);v=self.separate(p,a)
        v.route('**/dicom-web/studies/*/metadata',lambda route:route.fulfill(status=503,body='unavailable'))
        v.wait_for_function("() => document.querySelector('#kin-frame-warning') && !document.querySelector('#kin-frame-warning').disabled")
        v.get_by_role('button',name='Comparison',exact=True).click();v.locator('#kin-frame-warning').check()
        v.wait_for_function("() => kinViewerFrameCoverageState().phase==='unverified'")
        self.assertTrue(v.evaluate('kinViewerFrameCoverageState().warn'))
        v.unroute('**/dicom-web/studies/*/metadata')
        v.locator('#kin-frame-reload').click();v.wait_for_function("() => kinViewerFrameCoverageState().phase==='ready'")
        v.evaluate("window.__coverageKeep='retry-kept'");self.choose(p,b)
        p.once('dialog',lambda d:d.dismiss());p.locator('#m-filmbox').click()
        self.assertEqual(self.ids(v),[a.uid]);self.assertEqual(v.evaluate('window.__coverageKeep'),'retry-kept')
        p.once('dialog',lambda d:d.accept());p.locator('#m-filmbox').click()
        v.wait_for_url('**StudyInstanceUIDs='+b.uid+'**');self.assertEqual(self.ids(v),[b.uid])

    def test_coverage_03_embedded_cancel_preserves_document_and_report(self):
        a,b=self.pair();p=self.sign_in(self.device());self.settings(p,'workspace',False);self.close_settings(p)
        self.choose(p,a);p.locator('#m-filmbox').click();v=self.ready(p,1);self.enable(v)
        v.evaluate("window.__coverageKeep='embedded'");p.locator('#findings').fill('FRAME COVERAGE PRIVATE DRAFT')
        p.once('dialog',lambda d:d.dismiss());self.choose(p,b)
        expect(p.locator('#reading-status')).to_contain_text('이전 영상을 유지했습니다')
        self.assertEqual(v.evaluate('window.__coverageKeep'),'embedded');self.assertEqual(self.ids(v),[a.uid])
        hidden_before=v.evaluate('kinViewerFrameCoverageState().shown')
        for index in range(4):self.render_index(v,index)
        self.assertEqual(v.evaluate('kinViewerFrameCoverageState().shown'),hidden_before)
        p.get_by_role('button',name='Return to Previous Viewer',exact=True).click()
        expect(p.locator('#findings')).to_have_value('FRAME COVERAGE PRIVATE DRAFT')
        self.assertGreater(v.evaluate('kinViewerFrameCoverageState().remaining'),0)
        p.screenshot(path='../tmp/frame-coverage/embedded-final.png')

    def test_coverage_04_browser_preference_and_session_end(self):
        a,b=self.pair();context=self.device();p=self.sign_in(context);self.limit(p,2);v=self.separate(p,a);self.enable(v)
        persisted=v.evaluate("Object.entries(localStorage).filter(([k])=>k.startsWith('kin-frame-warning:'))")
        self.assertEqual(len(persisted),1);self.assertEqual(persisted[0][1],'true');self.assertNotIn(a.uid,str(persisted))
        second=self.separate(p,b)
        second.wait_for_function("() => window.kinViewerFrameCoverageState?.().phase==='ready'")
        self.assertTrue(second.evaluate('kinViewerFrameCoverageState().enabled'))
        self.assertGreater(second.evaluate('kinViewerFrameCoverageState().remaining'),0)
        v.close();second.close();self.sign_out(p)
        other=self.sign_in(context,'doctor2');self.limit(other,2);third=self.separate(other,a)
        third.wait_for_function("() => document.querySelector('#kin-frame-warning') && !document.querySelector('#kin-frame-warning').disabled")
        self.assertFalse(third.evaluate('kinViewerFrameCoverageState().enabled'))
        self.sign_out(other)
        third.wait_for_function("() => kinViewerFrameCoverageState().phase==='ended'")
        self.assertFalse(third.evaluate('kinViewerFrameCoverageState().warn'))

    def test_coverage_05_identity_retry_and_forbidden_metadata_keep_warning(self):
        a,b=self.pair();context=self.device();p=self.sign_in(context);self.limit(p,2)
        def fail_coverage_identity(route):
            if 'application/dicom+json' in route.request.headers.get('accept',''):
                route.fulfill(status=503,body='unavailable')
            else:route.continue_()
        context.route('**/api/me',fail_coverage_identity)
        v=self.separate(p,a)
        v.wait_for_function("() => window.kinViewerFrameCoverageState?.().phase==='unverified'")
        self.assertTrue(v.evaluate('kinViewerFrameCoverageState().warn'))
        v.get_by_role('button',name='Comparison',exact=True).click()
        expect(v.locator('#kin-frame-reload')).to_be_enabled()
        context.unroute('**/api/me',fail_coverage_identity)
        v.locator('#kin-frame-reload').click()
        v.wait_for_function("() => kinViewerFrameCoverageState().phase==='disabled'")
        v.route('**/dicom-web/studies/*/metadata',lambda route:route.fulfill(status=403,body='forbidden'))
        v.locator('#kin-frame-warning').check()
        v.wait_for_function("() => kinViewerFrameCoverageState().phase==='unverified'")
        self.assertTrue(v.evaluate('kinViewerFrameCoverageState().warn'))
        expect(v.locator('#kin-frame-status')).to_contain_text('권한')
        expect(v.locator('#kin-frame-reload')).to_be_enabled()
        v.unroute('**/dicom-web/studies/*/metadata');v.locator('#kin-frame-reload').click()
        v.wait_for_function("() => kinViewerFrameCoverageState().phase==='ready'")

    def test_coverage_06_pending_pixels_are_not_counted(self):
        a,b=self.pair();p=self.sign_in(self.device());self.limit(p,2);v=self.separate(p,a);self.enable(v)
        held=[];v.route('**/dicom-web/**/frames/*',lambda route:held.append(route))
        before=v.evaluate('kinViewerFrameCoverageState().shown')
        try:
            race=v.evaluate("""async () => {
                const v=cornerstone.getEnabledElements().map(e=>e.viewport).find(v=>v.type==='stack');
                const index=v.getCurrentImageIdIndex()===0?1:0,target=v.getImageIds()[index];
                if(cornerstone.cache.getImageLoadObject(target))cornerstone.cache.removeImageLoadObject(target);
                window.__coveragePending=v.setImageIdIndex(index);v.render();
                await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
                return {target,current:v.getCurrentImageId(),bound:v.csImage?.imageId};
            }""")
            self.assertEqual(race['target'],race['current']);self.assertNotEqual(race['target'],race['bound'])
            self.assertEqual(v.evaluate('kinViewerFrameCoverageState().shown'),before)
            self.assertGreaterEqual(len(held),1)
        finally:
            for route in held:route.continue_()
            v.unroute('**/dicom-web/**/frames/*')
        v.evaluate('window.__coveragePending')
        v.wait_for_function('n => kinViewerFrameCoverageState().shown===n',arg=before+1)

    def test_coverage_07_modal_and_offscreen_render_are_not_counted(self):
        a,b=self.pair();p=self.sign_in(self.device());self.limit(p,2);v=self.separate(p,a);self.enable(v)
        before=v.evaluate('kinViewerFrameCoverageState().shown')
        v.evaluate("() => {const d=document.createElement('dialog');d.id='coverage-test-dialog';d.textContent='Synthetic modal';document.body.append(d);d.showModal();}")
        for index in range(4):self.render_index(v,index)
        self.assertEqual(v.evaluate('kinViewerFrameCoverageState().shown'),before)
        v.evaluate("() => document.querySelector('#coverage-test-dialog').remove()")
        v.evaluate("() => {const v=cornerstone.getEnabledElements()[0].viewport;v.element.style.transform='translateY(4000px)';}")
        for index in range(4):self.render_index(v,index)
        self.assertEqual(v.evaluate('kinViewerFrameCoverageState().shown'),before)
        v.evaluate("() => {const v=cornerstone.getEnabledElements()[0].viewport;v.element.style.transform='';v.render();}")
        for index in range(4):self.render_index(v,index)
        self.assertEqual(v.evaluate('kinViewerFrameCoverageState().remaining'),0)


def load_tests(loader,tests,pattern):
    return unittest.TestSuite(FrameCoverageE2E(name) for name in FrameCoverageE2E.__dict__ if name.startswith('test_coverage_'))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
