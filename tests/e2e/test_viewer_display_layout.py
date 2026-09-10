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

    def setup_viewer(self,permission='granted',unsupported_query=False):
        fixture=self.ct('DISPLAY-'+uuid.uuid4().hex[:12],'display','20260801');self.seed_report(fixture)
        p=self.login()
        if unsupported_query:
            p.context.add_init_script('''const nativeQuery=navigator.permissions.query.bind(navigator.permissions);
              navigator.permissions.query=d=>d.name==='window-management'?Promise.reject(new TypeError('Synthetic unsupported query')):nativeQuery(d);''')
            p.reload();expect(p.locator('#dbstat')).to_contain_text('DB Connected')
        self.select(p,fixture);self.thumbs(p,1)
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

    def hold_screen_details(self,p):
        # Hold only completion of the real native call; do not mock screen data.
        p.evaluate('''()=>{const native=window.getScreenDetails.bind(window);window.getScreenDetails=async()=>{
          const details=await native();return new Promise(resolve=>window.__resumeMove=()=>resolve(details));};}''')

    def test_display_03_query_fallback_and_done_do_not_cancel_accepted_move(self):
        p,v,fixture,marker=self.setup_viewer(unsupported_query=True)
        self.assertTrue(p.evaluate('monitorQueryUnsupported'));self.assertFalse(p.evaluate('monitorPermissionGranted()'))
        p.locator('#viewer-windows-displays').click()
        control=p.locator('[data-window-action="display-1"]');expect(control).to_be_enabled()
        self.assertTrue(p.evaluate('monitorSessionGranted'))
        expected=p.evaluate('async()=>KinViewerDisplayLayout.fit(popupRect(ohifPopupHandle),KinViewerDisplayLayout.screens(await getScreenDetails())[1])')
        self.hold_screen_details(p);control.click();p.wait_for_function('typeof __resumeMove==="function"')
        expect(control).to_be_disabled();expect(p.locator('#viewer-windows-done')).to_be_focused();p.locator('#viewer-windows-done').click()
        p.evaluate('__resumeMove()')
        p.wait_for_function('expected=>{const r=JSON.parse(localStorage.getItem(OHIF_RECT_KEY));return r&&Object.keys(expected).every(k=>Math.abs(r[k]-expected[k])<=16)&&r.left===ohifPopupHandle.screenX;}',arg=expected)
        self.assertGreaterEqual(v.evaluate('screenX'),0);self.assertEqual(v.evaluate('__displayDocument'),marker)
        expect(p.locator('#findings')).to_have_value('DISPLAY MOVE UNSAVED REPORT')
        print(json.dumps({'scope':'Real two-display movement with synthetic permissions.query TypeError and delayed native result; Done closes controls without cancelling accepted movement'}),flush=True)
        v.close()

    def test_display_04_closed_window_finishes_delayed_request_with_status(self):
        p,v,fixture,marker=self.setup_viewer();p.locator('#viewer-windows-displays').click()
        control=p.locator('[data-window-action="display-1"]');expect(control).to_be_enabled()
        self.hold_screen_details(p);control.click();p.wait_for_function('typeof __resumeMove==="function"')
        v.close();p.evaluate('__resumeMove()')
        expect(p.locator('#viewer-windows-status')).to_contain_text('창 상태가 바뀌어 이동하지 않았습니다')
        expect(p.locator('#findings')).to_have_value('DISPLAY MOVE UNSAVED REPORT')

    def test_display_05_permission_revoked_before_delayed_result(self):
        p,v,fixture,marker=self.setup_viewer();p.locator('#viewer-windows-displays').click()
        control=p.locator('[data-window-action="display-1"]');expect(control).to_be_enabled()
        before=v.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
        self.hold_screen_details(p);control.click();p.wait_for_function('typeof __resumeMove==="function"')
        cdp=p.context.new_cdp_session(p);context_id=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
        cdp.send('Browser.setPermission',{'permission':{'name':'window-management'},'setting':'denied','origin':self.stack.proxy,'browserContextId':context_id})
        p.wait_for_function('!monitorPermissionGranted()');p.evaluate('__resumeMove()')
        expect(p.locator('#viewer-windows-status')).to_contain_text('화면 구성이나 권한이 바뀌었습니다')
        self.assertEqual(v.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'),before)
        self.assertEqual(v.evaluate('__displayDocument'),marker);v.close()

    def test_display_06_two_patients_move_independently_and_keep_report_target(self):
        p,first,a,first_marker=self.setup_viewer();p.locator('#viewer-windows-done').click()
        b=self.ct('DISPLAY-OTHER-'+uuid.uuid4().hex[:12],'other','20260802');self.seed_report(b,findings='DISPLAY SECOND BASE')
        original=self.originals();p.locator('#image-opening-open').click()
        p.locator('#image-opening-limit').select_option('2');p.locator('#image-opening-done').click()
        p.locator('#quick').fill('');p.evaluate('load()');self.select(p,b);self.thumbs(p,1)
        expect(p.locator('#findings')).to_have_value('DISPLAY SECOND BASE');p.locator('#findings').fill('SECOND PATIENT UNSAVED REPORT')
        with p.context.expect_page() as opened:p.locator('#thumbwrap img').first.dblclick()
        second=opened.value;second.wait_for_url('**/ohif/viewer?**');canvas_ready(second,1)
        second.wait_for_function('typeof kinViewerJobWorkspaceState==="function"')
        second_marker=second.evaluate('window.__displayDocument=crypto.randomUUID()')
        for viewer,title in [(first,'FIRST PATIENT UNSAVED JOB'),(second,'SECOND PATIENT UNSAVED JOB')]:
            viewer.get_by_role('button',name='Comparison',exact=True).click();viewer.get_by_label('Job Title',exact=True).fill(title)
        p.locator('#viewer-windows-open').click();p.locator('#viewer-windows-displays').click()
        expect(p.locator('[data-window-index="1"][data-window-action="display-1"]')).to_be_enabled()
        expected=p.evaluate('''async()=>{const screens=KinViewerDisplayLayout.screens(await getScreenDetails());
          return viewerWindows.rows().map(row=>KinViewerDisplayLayout.fit(popupRect(row.popup),screens[row.index]));}''')
        p.evaluate('''()=>{const native=window.getScreenDetails.bind(window);window.__heldMoves=[];
          window.getScreenDetails=async()=>{const details=await native();return new Promise(resolve=>__heldMoves.push(()=>resolve(details)));};}''')
        for i in [0,1]:p.locator(f'[data-window-index="{i}"][data-window-action="display-{i}"]').click()
        p.wait_for_function('__heldMoves.length===2');p.locator('#viewer-windows-done').click();p.evaluate('__heldMoves.forEach(release=>release())')
        p.wait_for_function('''expected=>expected.every((rect,i)=>{const saved=JSON.parse(localStorage.getItem(OHIF_RECT_KEY+(i?':'+i:'')));
          return saved&&Object.keys(rect).every(k=>Math.abs(rect[k]-saved[k])<=16);})''',arg=expected)
        for viewer,fixture,marker,title in [(first,a,first_marker,'FIRST PATIENT UNSAVED JOB'),(second,b,second_marker,'SECOND PATIENT UNSAVED JOB')]:
            self.assertEqual(viewer.evaluate('__displayDocument'),marker);expect(viewer.get_by_label('Job Title',exact=True)).to_have_value(title)
            image_id=viewer.evaluate("cornerstone.getRenderingEngines().filter(e=>e.id!=='_thumbnails').flatMap(e=>e.getViewports().map(v=>v.getCurrentImageId?.()))[0]")
            self.assertIn('/studies/'+fixture.uid+'/series/',image_id)
            self.assertEqual(self.jobs(fixture),[]);self.assertEqual(len(self.versions(fixture)),1)
        self.assertEqual(p.evaluate('selectedUid'),b.uid);expect(p.locator('#findings')).to_have_value('SECOND PATIENT UNSAVED REPORT')
        self.select(p,a);expect(p.locator('#findings')).to_have_value('DISPLAY MOVE UNSAVED REPORT')
        self.assertEqual(self.originals(),original)
        actual=[v.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})') for v in [first,second]]
        for index,rect in enumerate(actual):
            for key in rect:self.assertLessEqual(abs(rect[key]-expected[index][key]),16)
        print(json.dumps({'twoPatientWindows':actual,'scope':'Two different actual synthetic patients on two real displays; concurrent native results, independent slot persistence, image identity and draft/job preservation'}),flush=True)
        first.close();second.close()

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(ViewerDisplayLayoutE2E(name) for name in ViewerDisplayLayoutE2E.__dict__ if name.startswith('test_display_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
