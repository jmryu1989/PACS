# coding: utf-8
"""TEST-D-WORKSPACE-WINDOW: actual extended displays; no screen/window mocks."""
import os,sys,json,unittest,uuid
from pathlib import Path
from playwright.sync_api import expect
from test_thumbnail_series import ThumbnailSeriesE2E
from test_prior_selection import canvas_ready

class PhysicalMonitorsE2E(ThumbnailSeriesE2E):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('KIN_E2E_HEADED')!='1':
            raise RuntimeError('This test requires KIN_E2E_HEADED=1 and two actual extended displays.')
        super().setUpClass()

    def login(self,actor='doctor'):
        context=self.browser.new_context(ignore_https_errors=True,no_viewport=True)
        self.contexts.append(context);p=context.new_page();p.set_default_timeout(20000)
        p.goto(self.stack.proxy+'/')
        try:
            p.locator('#username').fill(self.stack.username(actor));p.locator('#password').fill(self.stack.passwords[actor]);p.locator('#kc-login').click()
        except Exception:
            raise RuntimeError('Real BFF login form could not be submitted') from None
        p.wait_for_url('**/worklist/hpacs-lite/main.html',timeout=30000)
        expect(p.locator('#dbstat')).to_contain_text('DB Connected');return p

    def test_physical_01_other_display_and_saved_window_restore(self):
        f=self.ct('SYNTHETIC-MONITOR-'+uuid.uuid4().hex[:12],'current','20260801');self.seed_report(f)
        p=self.login();self.select(p,f);self.thumbs(p,1)
        cdp=p.context.new_cdp_session(p)
        context_id=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
        cdp.send('Browser.setPermission',{'permission':{'name':'window-management'},'setting':'granted','origin':self.stack.proxy,'browserContextId':context_id})
        p.evaluate('initMonitorPermission()')
        screens=p.evaluate('async()=>{const d=await getScreenDetails();return {current:d.currentScreen.left,screens:d.screens.map(s=>({left:s.availLeft,top:s.availTop,width:s.availWidth,height:s.availHeight}))};}')
        self.assertGreaterEqual(len(screens['screens']),2,'Actual extended display inventory required')
        target=next(s for s in screens['screens'] if s['left']!=screens['current'])
        p.locator('#findings').fill('SYNTHETIC PHYSICAL WINDOW UNSAVED')
        with p.context.expect_page() as opened:p.locator('#thumbwrap img').first.dblclick()
        popup=opened.value;popup.wait_for_url('**/ohif/viewer?**');canvas_ready(popup,1)
        print(json.dumps({'screens':screens,'target':target,'opener':p.evaluate('({left:screenX,top:screenY,extended:screen.isExtended,permission:monitorPermission?.state,cache:screensCache})'),'popup':popup.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'),'nativeWindow':p.context.new_cdp_session(popup).send('Browser.getWindowForTarget')},ensure_ascii=False),flush=True)
        position=popup.evaluate('screenX')
        if not target['left']-10<=position<target['left']+target['width']:
            permission=popup.evaluate("async()=>(await navigator.permissions.query({name:'window-management'})).state")
            popup.evaluate('t=>moveTo(t.left+80,t.top+60)',target);popup.wait_for_timeout(500)
            print(json.dumps({'lateMoveProbe':popup.evaluate('({left:screenX,top:screenY})'),'popupPermission':permission}),flush=True)
            self.fail('Automatic other-display placement failed before diagnostic late move')
        first=popup.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
        self.assertIn(f.uid,popup.url)
        popup.evaluate('()=>{resizeTo(1000,800);moveTo(screen.availLeft+80,screen.availTop+60);}')
        popup.wait_for_function('Math.abs(outerWidth-1000)<=16&&Math.abs(outerHeight-800)<=16')
        expected=popup.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
        p.wait_for_function('expected=>{const r=JSON.parse(localStorage.getItem(OHIF_RECT_KEY)||"null");return r&&Math.abs(r.width-expected.width)<16&&Math.abs(r.left-expected.left)<16;}',arg=expected)
        folder=Path('../tmp/physical-monitors/screens');folder.mkdir(parents=True,exist_ok=True);popup.screenshot(path=str(folder/'viewer.png'))
        popup.close()
        with p.context.expect_page() as reopened:p.locator('#thumbwrap img').first.dblclick()
        restored=reopened.value;restored.wait_for_url('**/ohif/viewer?**');canvas_ready(restored,1)
        actual=restored.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})')
        for key in expected:self.assertLessEqual(abs(actual[key]-expected[key]),16,(key,expected,actual))
        expect(p.locator('#findings')).to_have_value('SYNTHETIC PHYSICAL WINDOW UNSAVED')
        print(json.dumps({'actualScreens':screens,'initial':first,'saved':expected,'restored':actual,'scope':'Actual headed Chromium on two OS displays; no disconnect/reconnect or three-display validation'},ensure_ascii=False),flush=True)
        restored.close()

    def test_physical_02_permission_denied_keeps_viewer_usable(self):
        f=self.ct('SYNTHETIC-MONITOR-'+uuid.uuid4().hex[:12],'current','20260801')
        p=self.login();self.select(p,f);self.thumbs(p,1)
        cdp=p.context.new_cdp_session(p);context_id=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
        cdp.send('Browser.setPermission',{'permission':{'name':'window-management'},'setting':'denied','origin':self.stack.proxy,'browserContextId':context_id})
        p.evaluate('initMonitorPermission()')
        self.assertFalse(p.evaluate('monitorPermissionGranted()'))
        with p.context.expect_page() as opened:p.locator('#thumbwrap img').first.dblclick()
        popup=opened.value;popup.wait_for_url('**/ohif/viewer?**');canvas_ready(popup,1)
        self.assertIn(f.uid,popup.url)
        self.assertFalse(p.evaluate('monitorPermissionGranted()'));self.assertEqual(p.evaluate('screensCache'),[])
        print(json.dumps({'permission':'denied','viewer':popup.evaluate('({left:screenX,top:screenY,width:outerWidth,height:outerHeight})'),'scope':'Real browser permission denial; viewer remains usable'}),flush=True)
        popup.close()

def load_tests(loader,tests,pattern):
    return unittest.TestSuite(PhysicalMonitorsE2E(name) for name in PhysicalMonitorsE2E.__dict__ if name.startswith('test_physical_'))

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8',errors='replace');unittest.main(verbosity=2)
