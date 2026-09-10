# coding: utf-8
"""REQ-D-WINDOW-DISPLAY: explicit movement of the live viewer on two real displays."""
import json,sys,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_physical_monitors import PhysicalMonitorsE2E
from test_prior_selection import canvas_ready

class ViewerDisplayLayoutE2E(PhysicalMonitorsE2E):
    def jobs(self,fixture):
        result=self.stack.request('GET',f'/studies/{fixture.uid}/viewer-jobs','doctor')
        self.assertEqual(result.status,200);return result.body['jobs']

    def setup_viewer(self,permission='granted'):
        fixture=self.ct('DISPLAY-'+uuid.uuid4().hex[:12],'display','20260801');self.seed_report(fixture)
        p=self.login();self.select(p,fixture);self.thumbs(p,1)
        cdp=p.context.new_cdp_session(p);context_id=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
        cdp.send('Browser.setPermission',{'permission':{'name':'window-management'},'setting':permission,'origin':self.stack.proxy,'browserContextId':context_id})
        p.evaluate('initMonitorPermission()');p.locator('#findings').fill('DISPLAY MOVE UNSAVED REPORT')
        with p.context.expect_page() as opened:p.locator('#thumbwrap img').first.dblclick()
        v=opened.value;v.wait_for_url('**/ohif/viewer?**');canvas_ready(v,1)
        v.wait_for_function('typeof kinViewerJobWorkspaceState==="function"')
        marker=v.evaluate('window.__displayDocument=crypto.randomUUID()')
        p.locator('#viewer-windows-open').click()
        return p,v,fixture,marker

    def test_display_01_move_live_unsaved_window_and_restore_saved_screen(self):
        p,v,fixture,marker=self.setup_viewer();original=self.originals()
        v.get_by_role('button',name='Comparison',exact=True).click()
        v.get_by_label('Job Title',exact=True).fill('DISPLAY MOVE UNSAVED JOB')
        p.locator('#viewer-windows-displays').click()
        expect(p.locator('[data-window-action="display-1"]')).to_be_visible()
        screens=p.evaluate('async()=>KinViewerDisplayLayout.screens(await getScreenDetails())')
        self.assertEqual(len(screens),2,'This evidence is for the user current actual two-display configuration')
        observed=[]
        for index in [1,0]:
            control=p.locator(f'[data-window-index="0"][data-window-action="display-{index}"]')
            expect(control).to_be_enabled();control.click()
            expect(p.locator('#viewer-windows-status')).to_have_text('지정 화면으로 이동하고 창 위치를 저장했습니다.')
            actual=v.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
            screen=screens[index]
            self.assertGreaterEqual(actual['left'],screen['left']-16)
            self.assertLessEqual(actual['left']+actual['width'],screen['left']+screen['width']+16)
            self.assertEqual(v.evaluate('window.__displayDocument'),marker)
            expect(v.get_by_label('Job Title',exact=True)).to_have_value('DISPLAY MOVE UNSAVED JOB')
            expect(p.locator('#findings')).to_have_value('DISPLAY MOVE UNSAVED REPORT')
            self.assertEqual(p.evaluate('JSON.parse(localStorage.getItem(OHIF_RECT_KEY))'),actual)
            observed.append(actual)
        folder=Path('../tmp/viewer-display-layout/screens');folder.mkdir(parents=True,exist_ok=True)
        p.screenshot(path=str(folder/'display-selection.png'))
        v.get_by_label('Job Title',exact=True).fill('');v.close();p.locator('#viewer-windows-done').click()
        with p.context.expect_page() as reopened:p.locator('#thumbwrap img').first.dblclick()
        restored=reopened.value;restored.wait_for_url('**/ohif/viewer?**');canvas_ready(restored,1)
        rect=restored.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
        for key in rect:self.assertLessEqual(abs(rect[key]-observed[-1][key]),16)
        self.assertEqual(self.originals(),original);self.assertEqual(len(self.versions(fixture)),1);self.assertEqual(self.jobs(fixture),[])
        print(json.dumps({'actualScreens':screens,'moved':observed,'reopened':rect,'scope':'Two real Windows displays; same viewer document and unsaved Job/report retained; no physical disconnect/three-screen claim'}),flush=True)
        restored.close()

    def test_display_02_permission_denied_preserves_live_viewer(self):
        p,v,fixture,marker=self.setup_viewer('denied')
        before=v.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
        p.locator('#viewer-windows-displays').click()
        expect(p.locator('#viewer-windows-status')).to_contain_text('화면 권한을 허용한 뒤')
        expect(p.locator('[data-window-action^="display-"]')).to_have_count(0)
        self.assertEqual(v.evaluate('window.__displayDocument'),marker);canvas_ready(v,1)
        self.assertEqual(v.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'),before)
        expect(p.locator('#findings')).to_have_value('DISPLAY MOVE UNSAVED REPORT')
        v.close()

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ViewerDisplayLayoutE2E(name) for name in ViewerDisplayLayoutE2E.__dict__ if name.startswith('test_display_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
