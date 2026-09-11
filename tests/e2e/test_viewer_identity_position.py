# coding: utf-8
"""TEST-VIEWER-IDENTITY-POSITION: native corner placement and v8 roaming."""
import unittest
from pathlib import Path

from playwright.sync_api import expect
from test_viewer_identity import ViewerIdentityE2E
from test_viewer_tech_note import canvas_ready


class ViewerIdentityPositionE2E(ViewerIdentityE2E):
    def positioned(self, label, position):
        self.assertTrue(label.evaluate("""(element, position) => new Promise((resolve, reject) => {
          const deadline=performance.now()+10000;
          function check(){
            const label=element.getBoundingClientRect(), viewport=element.parentElement.getBoundingClientRect();
            const x=(label.left+label.right)/2, y=(label.top+label.bottom)/2;
            const horizontal=position.endsWith('left') ? x < (viewport.left+viewport.right)/2 : x > (viewport.left+viewport.right)/2;
            const vertical=position.startsWith('top') ? y < (viewport.top+viewport.bottom)/2 : y > (viewport.top+viewport.bottom)/2;
            if(label.width>0 && label.height>0 && viewport.width>0 && viewport.height>0 && horizontal && vertical &&
               label.left>=viewport.left && label.right<=viewport.right && label.top>=viewport.top && label.bottom<=viewport.bottom)
              return resolve(true);
            if(performance.now()>=deadline)return reject(Error('identity did not reach '+position));
            requestAnimationFrame(check);
          }
          check();
        })""", position))

    def test_identity_position_01_four_corners_copy_account_login_preserves_work(self):
        current, prior = self.pair()
        page, viewer = self.popup(current)
        page.locator('#findings').fill('KEEP POSITION REPORT')
        viewer.get_by_label('Job Title', exact=True).fill('KEEP POSITION JOB')
        before = self.snapshot(viewer)
        self.assertEqual(len(before), 2)
        self.settings(page)

        current_label = self.label(viewer, current.uid)
        prior_label = self.label(viewer, prior.uid)
        for position in ['top-left', 'top-right', 'bottom-right', 'bottom-left']:
            page.locator('#viewer-identity-current-position').select_option(position)
            expect(current_label).to_contain_text(current.patient_id)
            self.positioned(current_label, position)
            expect(viewer.locator('.kin-viewer-identity')).to_have_count(2)

        page.locator('#viewer-identity-prior-position').select_option('bottom-right')
        self.positioned(prior_label, 'bottom-right')
        page.locator('#viewer-identity-copy-current').click()
        expect(page.locator('#viewer-identity-prior-position')).to_have_value('bottom-left')
        self.positioned(current_label, 'bottom-left')
        self.positioned(prior_label, 'bottom-left')

        page.locator('#appearance-account-save').click()
        expect(page.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        page.locator('#reading-appearance-close').click()
        expect(page.locator('#findings')).to_have_value('KEEP POSITION REPORT')
        expect(viewer.get_by_label('Job Title', exact=True)).to_have_value('KEEP POSITION JOB')
        self.assertEqual(self.snapshot(viewer), before)
        self.assertEqual(self.jobs(current), [])
        self.assertEqual(len(self.versions(current)), 1)

        fresh = self.login()
        frame = self.workspace(fresh, current)
        self.settings(fresh)
        expect(fresh.locator('#viewer-identity-current-position')).to_have_value('top-right')
        fresh.locator('#appearance-account-load').click()
        expect(fresh.locator('#viewer-identity-current-position')).to_have_value('bottom-left')
        expect(fresh.locator('#viewer-identity-prior-position')).to_have_value('bottom-left')
        fresh.locator('#reading-appearance-close').click()
        self.positioned(self.label(frame, current.uid), 'bottom-left')
        self.positioned(self.label(frame, prior.uid), 'bottom-left')
        expect(self.label(frame, current.uid)).to_contain_text(current.patient_id)
        expect(self.label(frame, prior.uid)).to_contain_text(prior.patient_id)
        self.assertEqual(self.jobs(current), [])
        self.assertEqual(len(self.versions(current)), 1)
        evidence = Path(__file__).resolve().parents[2]/'tmp'/'workspace-ui-ci'/'identity-position-native'
        evidence.mkdir(parents=True, exist_ok=True)
        fresh.screenshot(path=str(evidence/'account-restored-bottom-left.png'))

    def test_identity_position_02_legacy_local_migration_and_late_account_load(self):
        current, prior = self.pair()
        page = self.login()
        page.evaluate("""() => {
          const owner=JSON.stringify([KinAuth.session().institution,KinAuth.session().sub]);
          localStorage.setItem('kin-viewer-identity:v1:'+owner,JSON.stringify({version:1,
            current:{size:18,font:'mono',color:'warm',name:true,date:true,description:false},
            prior:{size:14,font:'serif',color:'cool',name:false,date:true,description:true}}));
        }""")
        page.reload()
        self.workspace(page, current)
        with page.context.expect_page() as opened:
            page.get_by_role('button', name='Open Viewer Window', exact=True).click()
        viewer = opened.value
        canvas_ready(viewer, 2)
        self.ready(viewer)
        self.active(viewer, current.uid)
        self.tools(viewer)
        self.settings(page)
        expect(page.locator('#viewer-identity-current-position')).to_have_value('top-right')
        expect(page.locator('#viewer-identity-prior-position')).to_have_value('top-right')
        expect(page.locator('#viewer-identity-current-size')).to_have_value('18')
        self.positioned(self.label(viewer, current.uid), 'top-right')
        self.positioned(self.label(viewer, prior.uid), 'top-right')

        page.locator('#appearance-account-save').click()
        expect(page.locator('#appearance-account-status')).to_have_text('표시 설정을 계정에 저장했습니다.')
        pending = []
        page.route('**/api/reading-appearance', lambda route: pending.append(route))
        page.locator('#appearance-account-load').click()
        expect(page.locator('#appearance-account-status')).to_have_text('표시 설정 확인 중…')
        page.locator('#viewer-identity-current-position').select_option('bottom-right')
        self.assertEqual(len(pending), 1)
        pending.pop().fulfill(response=page.request.get(self.stack.api+'/reading-appearance'))
        expect(page.locator('#appearance-account-status')).to_contain_text('현재 설정이 바뀌어 적용하지 않았습니다')
        expect(page.locator('#viewer-identity-current-position')).to_have_value('bottom-right')
        self.positioned(self.label(viewer, current.uid), 'bottom-right')
        expect(self.label(viewer, current.uid)).to_contain_text(current.patient_id)
        expect(self.label(viewer, prior.uid)).to_contain_text(prior.patient_id)

        viewer.evaluate("""uid => {
          const grid=services.viewportGridService.getState();
          window.positionViewport=[...grid.viewports.keys()].map(id=>services.cornerstoneViewportService.getCornerstoneViewport(id))
            .find(viewport=>viewport?.getCurrentImageId?.().includes('/studies/'+uid+'/'));
        }""", current.uid)
        viewer.evaluate("""() => {
          window.positionMetadata=cornerstone.metaData.get('instance',positionViewport.getCurrentImageId());
          window.positionSop=positionMetadata.SOPInstanceUID;
          positionMetadata.SOPInstanceUID='1.2.3';
        }""")
        expect(self.label(viewer, current.uid)).to_have_count(0)
        expect(self.label(viewer, prior.uid)).to_contain_text(prior.patient_id)
        viewer.evaluate('()=>positionMetadata.SOPInstanceUID=positionSop')
        expect(self.label(viewer, current.uid)).to_contain_text(current.patient_id)
        viewer.evaluate("""() => {const channel=new BroadcastChannel('kin-session');channel.postMessage({type:'session-ended'});channel.close()}""")
        expect(viewer.locator('.kin-viewer-identity')).to_have_count(0)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(
        ViewerIdentityPositionE2E(name)
        for name in loader.getTestCaseNames(ViewerIdentityPositionE2E)
        if name.startswith('test_identity_position_') and name in ViewerIdentityPositionE2E.__dict__
    )


if __name__ == '__main__':
    names = [name for name in unittest.defaultTestLoader.getTestCaseNames(ViewerIdentityPositionE2E)
             if name.startswith('test_identity_position_') and name in ViewerIdentityPositionE2E.__dict__]
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.TestSuite(ViewerIdentityPositionE2E(name) for name in names))
    raise SystemExit(0 if result.wasSuccessful() else 1)
