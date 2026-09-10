"""D02-ROAM real BFF accounts and independent browser workspace restoration."""
import json,unittest,hashlib
from pathlib import Path
from playwright.sync_api import expect
from test_workspace_persistence import WorkspacePersistenceE2E
from workspace_roaming_support import cleanup_workspace

class WorkspaceRoamingE2E(WorkspacePersistenceE2E):
    def hashes(self):
        result={}
        for uid in self.stack.active:
            rows=self.stack._orthanc_request('POST','/tools/lookup',uid.encode()).body
            study=next(r['ID'] for r in rows if r['Type']=='Study')
            for r in self.stack._orthanc_request('GET','/studies/'+study+'/instances').body:
                result[r['ID']]=hashlib.sha256(self.stack.orthanc_bytes('/instances/'+r['ID']+'/file')).hexdigest()
        return result
    @classmethod
    def setUpClass(cls):
        super().setUpClass();cls.addClassCleanup(cleanup_workspace,cls.stack)
    def tearDown(self):
        super().tearDown();cleanup_workspace(self.stack)
    def remote(self,page):
        r=page.request.get(self.stack.proxy+'/api/workspace-layout');self.assertEqual(r.status,200);return r.json()
    def open_menu(self,page):
        menu=page.locator('#workspace-server-menu')
        if menu.get_attribute('open') is None:menu.locator('summary').click()
        expect(page.get_by_role('button',name='Load from Account',exact=True)).to_be_enabled()
    def action(self,page,name,message):
        self.open_menu(page);button=page.get_by_role('button',name=name,exact=True)
        expect(button).to_be_enabled();button.click();expect(button).to_be_enabled()
        expect(page.locator('#workspace-server-status')).to_contain_text(message)
    def shot(self,page,name):
        page.wait_for_function("() => {const p=document.querySelector('#workspace-server-panel').getBoundingClientRect();return p.left>=0 && p.right<=innerWidth && p.top>=0 && p.bottom<=innerHeight;}")
        page.screenshot(path=str(Path(__file__).parent/'artifacts'/('ROAM-'+name+'.png')))
    def same_sizes(self,page,layout):
        for axis,viewport in [('landscape',dict(width=1600,height=1000)),('portrait',dict(width=900,height=1400))]:
            page.set_viewport_size(viewport)
            for key,selector in [('main','.left'),('top','.rw'),('related','.related-p'),('prior','.related-list-pane')]:
                dim='width' if axis=='landscape' and key in ('main','related') else 'height'
                self.size_is(page,selector,dim,layout[axis][key])
        print('ROAM actual sizes '+json.dumps(page.evaluate("() => Object.fromEntries(['.left','.rw','.related-p','.related-list-pane'].map(k=>{const r=document.querySelector(k).getBoundingClientRect();return [k,{width:r.width,height:r.height}]}))")),flush=True)

    def test_roam_01_two_browsers_all_panels_and_report(self):
        f=self.fixture();self.seed_report(f);original=self.hashes();page=self.sign_in(self.device());self.select(page,f);self.wait_thumbnail(page)
        for key,value in [('findings','Roam findings'),('conclusion','Roam conclusion'),('recommendation','Roam recommendation')]:page.locator('#'+key).fill(value)
        page.locator('#quick').click();self.wait_state(page,f,lambda s:(s.get('draft') or {}).get('recommendation')=='Roam recommendation',timeout=30000)
        self.assertEqual(self.stack.request('POST',f'/studies/{f.uid}/hold','doctor').status,201)
        saved_state=self.state(f);history=self.versions(f)
        for selector,delta in [('#resize-main',dict(dx=70)),('#resize-top',dict(dy=25)),('#resize-related',dict(dx=-25)),('#resize-prior',dict(dy=15))]:self.drag_by(page,selector,**delta)
        page.set_viewport_size(dict(width=900,height=1400))
        for selector,delta in [('#resize-main',20),('#resize-top',20),('#resize-related',10),('#resize-prior',10)]:self.drag_by(page,selector,dy=delta)
        layout=self.stored(page);self.assertEqual(layout['mode'],'auto');self.assertEqual(set(layout['portrait']),{'main','top','related','prior'})
        self.action(page,'Save to Account','계정에 저장했습니다');self.assertEqual(self.remote(page)['layout'],layout)
        y=self.sign_in(self.device());self.select(y,f);self.wait_thumbnail(y)
        self.assertIsNone(self.stored(y));self.mode_is(y,'auto')
        writes=[];y.on('request',lambda r:writes.append(r.url.split('?')[0]) if r.method not in ('GET','HEAD','OPTIONS') and '/api/' in r.url else None)
        self.action(y,'Load from Account','불러왔습니다');self.assertEqual(self.stored(y),layout);self.same_sizes(y,layout);self.shot(y,'portrait-restored')
        y.set_viewport_size(dict(width=768,height=1024))
        for selector in ['#thumbwrap img','#clinical','#t-mod','#b-history','#layout-reset','#workspace-server-menu summary']:self.reachable(y,selector)
        self.assertEqual(self.stored(y),layout);self.shot(y,'small-clamped')
        for key,value in [('findings','Roam findings'),('conclusion','Roam conclusion'),('recommendation','Roam recommendation')]:expect(y.locator('#'+key)).to_have_value(value)
        self.action(y,'Reset Account Layout','현재 창의 배치는 유지');self.assertIsNone(self.remote(y)['layout']);self.assertEqual(self.stored(y),layout)
        self.assertEqual(self.stored(page),layout);self.assertEqual(self.state(f),saved_state);self.assertEqual(self.versions(f),history);self.assertEqual(self.hashes(),original)
        self.assertTrue(all(url.endswith('/workspace-layout') for url in writes),writes)

    def test_roam_02_owner_switch_new_login_and_conflict(self):
        x=self.device();a=self.sign_in(x);self.action(a,'Save to Account','저장했습니다');saved_a=self.remote(a)
        b=self.sign_in(x,'doctor2');self.assertIsNone(self.remote(b)['layout']);self.mode_is(b,'auto')
        self.open_menu(a);a.get_by_role('button',name='Save to Account',exact=True).click()
        expect(a.locator('#workspace-server-status')).to_contain_text('세션이 변경');expect(a.get_by_role('button',name='Save to Account',exact=True)).to_be_disabled()
        b.locator('#layout-toggle').click();self.action(b,'Save to Account','저장했습니다');saved_b=self.remote(b)
        by=self.sign_in(self.device(),'doctor2');self.mode_is(by,'auto');self.action(by,'Load from Account','불러왔습니다');self.mode_is(by,'portrait')
        ay=self.sign_in(self.device());self.assertEqual(self.remote(ay),saved_a);self.action(ay,'Load from Account','불러왔습니다')
        by.locator('#layout-toggle').click();self.action(by,'Save to Account','저장했습니다')
        before=self.stored(b);self.action(b,'Save to Account','다른 창에서');self.assertEqual(self.stored(b),before)
        self.action(b,'Reset Account Layout','다른 창에서');self.assertIsNotNone(self.remote(b)['layout'])
        self.action(b,'Load from Account','불러왔습니다');self.mode_is(b,'landscape')
        self.action(b,'Reset Account Layout','초기화했습니다');self.assertIsNone(self.remote(b)['layout']);self.assertEqual(self.remote(ay),saved_a)
        y_context=ay.context;self.sign_out(ay);ay=self.sign_in(y_context);self.assertEqual(self.remote(ay),saved_a)
        print('ROAM A/B X/Y saved revisions '+json.dumps([saved_a['revision'],saved_b['revision']]),flush=True)

    def test_roam_03_delayed_load_and_session_end(self):
        page=self.sign_in(self.device());page.locator('#layout-toggle').click();self.action(page,'Save to Account','저장했습니다')
        page.locator('#layout-reset').click();pending=[];pattern='**/api/workspace-layout'
        page.route(pattern,lambda r:pending.append(r));self.open_menu(page)
        page.get_by_role('button',name='Load from Account',exact=True).click();expect(page.get_by_role('button',name='Load from Account',exact=True)).to_be_disabled()
        page.locator('#layout-toggle').click();page.locator('#layout-toggle').click();before=self.stored(page)
        self.assertEqual(len(pending),1);pending[0].fulfill(response=pending[0].fetch())
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치가 변경');self.assertEqual(self.stored(page),before);self.mode_is(page,'landscape');page.unroute(pattern)
        # Another actual session's logout message ends a pending load in the old window.
        pending=[];page.route(pattern,lambda r:pending.append(r));self.open_menu(page)
        page.get_by_role('button',name='Load from Account',exact=True).click();page.wait_for_timeout(100);self.assertEqual(len(pending),1)
        response=pending[0].fetch();other=page.context.new_page();other.goto(self.stack.proxy+'/worklist/hpacs-lite/main.html')
        expect(other.locator('#dbstat')).to_contain_text('DB Connected');self.sign_out(other)
        expect(page.locator('#workspace-server-status')).to_contain_text('세션이 변경');pending[0].fulfill(response=response)
        self.assertEqual(self.stored(page),before);expect(page.get_by_role('button',name='Load from Account',exact=True)).to_be_disabled()

    def test_roam_04_failure_storage_denial_and_csrf(self):
        page=self.sign_in(self.device());page.locator('#layout-toggle').click();self.action(page,'Save to Account','저장했습니다');remote=self.remote(page)
        denied=page.request.put(self.stack.proxy+'/api/workspace-layout',data=dict(expectedOwner=remote['owner'],revision=remote['revision'],layout=remote['layout']))
        self.assertEqual(denied.status,403);self.assertEqual(self.remote(page),remote)
        page.locator('#layout-reset').click();before=self.stored(page);pattern='**/api/workspace-layout'
        bad=dict(remote,layout=dict(remote['layout'],mode='wrong'))
        page.route(pattern,lambda r:r.fulfill(status=200,json=bad));self.action(page,'Load from Account','형식을 확인할 수 없습니다');self.assertEqual(self.stored(page),before);page.unroute(pattern)
        page.route(pattern,lambda r:r.fulfill(status=500,json=dict(message='Synthetic failure')));self.action(page,'Save to Account','완료됐을 수 있으니');self.assertEqual(self.stored(page),before);page.unroute(pattern)
        page.context.add_init_script("""(() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,...rest){if(String(key).startsWith('kin-workspace:'))throw new DOMException('Synthetic denied','QuotaExceededError');return original.call(this,key,...rest);};})();""")
        page.reload();expect(page.locator('#dbstat')).to_contain_text('DB Connected');self.action(page,'Load from Account','이 창에만 적용됨');self.mode_is(page,'portrait');self.assertIsNone(self.stored(page))
        self.assertEqual(self.remote(page),remote)
        page.route(pattern,lambda r:r.fulfill(status=403,json=dict(message='Synthetic denied')));self.open_menu(page);page.get_by_role('button',name='Load from Account',exact=True).click()
        expect(page.locator('#workspace-server-status')).to_contain_text('접근 권한이 없습니다');expect(page.get_by_role('button',name='Save to Account',exact=True)).to_be_disabled();self.mode_is(page,'portrait')

    def test_roam_05_account_changes_while_old_read_is_pending(self):
        context=self.device();page=self.sign_in(context);page.locator('#layout-toggle').click()
        self.action(page,'Save to Account','저장했습니다');page.locator('#layout-reset').click();before=self.stored(page)
        pending=[];page.route('**/api/workspace-layout',lambda r:pending.append(r));self.open_menu(page)
        page.get_by_role('button',name='Load from Account',exact=True).click();page.wait_for_timeout(100);self.assertEqual(len(pending),1)
        response=pending[0].fetch()
        # A session can be replaced in another tab without this old document receiving logout.
        other=self.sign_in(context,'doctor2');self.assertIsNone(self.remote(other)['layout'])
        pending[0].fulfill(response=response)
        expect(page.locator('#workspace-server-status')).to_contain_text('세션이 변경')
        expect(page.get_by_role('button',name='Load from Account',exact=True)).to_be_disabled()
        self.assertEqual(self.stored(page),before);self.mode_is(page,'auto');self.assertIsNone(self.remote(other)['layout'])

def load_tests(loader,tests,pattern):return unittest.TestSuite(WorkspaceRoamingE2E(n) for n in loader.getTestCaseNames(WorkspaceRoamingE2E) if n.startswith('test_roam_'))
if __name__=='__main__':unittest.main(verbosity=2)
