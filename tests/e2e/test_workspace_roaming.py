"""D02-ROAM real BFF accounts and independent browser workspace restoration."""
import json,unittest,hashlib,time
from pathlib import Path
from playwright.sync_api import expect
from test_workspace_persistence import WorkspacePersistenceE2E
from workspace_roaming_support import cleanup_workspace
from document_session import document_request
from viewer_session import hold_landing, release_after_end

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
        r=document_request(page, "GET", self.stack.proxy+'/api/workspace-layout');self.assertEqual(r.status,200);return r.json()
    def open_menu(self,page):
        self.open_toolbar_group(page,'#workspace-server-menu')
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
        self.open_toolbar_group(y,'#layout-reset')
        self.open_toolbar_group(y,'#b-history')
        for selector in ['#thumbwrap img','#clinical','#t-mod','#b-history','#layout-reset','#workspace-server-menu summary']:self.reachable(y,selector)
        self.assertEqual(self.stored(y),layout);self.shot(y,'small-clamped')
        for key,value in [('findings','Roam findings'),('conclusion','Roam conclusion'),('recommendation','Roam recommendation')]:expect(y.locator('#'+key)).to_have_value(value)
        self.action(y,'Reset Account Layout','현재 창의 배치는 유지');self.assertIsNone(self.remote(y)['layout']);self.assertEqual(self.stored(y),layout)
        self.assertEqual(self.stored(page),layout);self.assertEqual(self.state(f),saved_state);self.assertEqual(self.versions(f),history);self.assertEqual(self.hashes(),original)
        self.assertTrue(all(url.endswith('/workspace-layout') for url in writes),writes)

    def test_roam_02_owner_switch_new_login_and_conflict(self):
        x=self.device();a=self.sign_in(x);self.action(a,'Save to Account','저장했습니다');saved_a=self.remote(a)
        landing=hold_landing(a)
        b=self.sign_in(x,'doctor2');self.assertIsNone(self.remote(b)['layout']);self.mode_is(b,'auto')
        self.open_menu(a)
        with a.expect_response(lambda r:r.url.endswith('/worklist/hpacs-lite/index.html') and r.status==204):
            a.get_by_role('button',name='Save to Account',exact=True).click()
        a.wait_for_function("KinWorkContext.state() !== 'active'");self.assertTrue(landing)
        expect(a.get_by_role('button',name='Save to Account',exact=True,include_hidden=True)).to_be_disabled()
        self.open_toolbar_group(b,'#layout-toggle')
        b.locator('#layout-toggle').click();self.action(b,'Save to Account','저장했습니다');saved_b=self.remote(b)
        by=self.sign_in(self.device(),'doctor2');self.mode_is(by,'auto');self.action(by,'Load from Account','불러왔습니다');self.mode_is(by,'portrait')
        ay=self.sign_in(self.device());self.assertEqual(self.remote(ay),saved_a);self.action(ay,'Load from Account','불러왔습니다')
        self.open_toolbar_group(by,'#layout-toggle')
        by.locator('#layout-toggle').click();self.action(by,'Save to Account','저장했습니다')
        before=self.stored(b);self.action(b,'Save to Account','다른 창에서');self.assertEqual(self.stored(b),before)
        self.action(b,'Reset Account Layout','다른 창에서');self.assertIsNotNone(self.remote(b)['layout'])
        self.action(b,'Load from Account','불러왔습니다');self.mode_is(b,'landscape')
        self.action(b,'Reset Account Layout','초기화했습니다');self.assertIsNone(self.remote(b)['layout']);self.assertEqual(self.remote(ay),saved_a)
        y_context=ay.context;self.sign_out(ay);ay=self.sign_in(y_context);self.assertEqual(self.remote(ay),saved_a)
        print('ROAM A/B X/Y saved revisions '+json.dumps([saved_a['revision'],saved_b['revision']]),flush=True)

    def test_roam_03_delayed_load_and_session_end(self):
        page=self.sign_in(self.device());self.open_toolbar_group(page,'#layout-toggle');page.locator('#layout-toggle').click();self.action(page,'Save to Account','저장했습니다')
        self.open_toolbar_group(page,'#layout-reset')
        page.locator('#layout-reset').click();pending=[];pattern='**/api/workspace-layout'
        page.route(pattern,lambda r:pending.append(r));self.open_menu(page)
        page.get_by_role('button',name='Load from Account',exact=True).click();expect(page.get_by_role('button',name='Load from Account',exact=True)).to_be_disabled()
        self.open_toolbar_group(page,'#layout-toggle')
        page.locator('#layout-toggle').click();page.locator('#layout-toggle').click();before=self.stored(page)
        self.assertEqual(len(pending),1);pending[0].fulfill(response=pending[0].fetch())
        expect(page.locator('#workspace-server-status')).to_contain_text('현재 배치가 변경');self.assertEqual(self.stored(page),before);self.mode_is(page,'landscape');page.unroute(pattern)
        # Another tab's real logout ends a pending load in the old window. S7-U5: the end is announced before the logout
        # POST, so while that POST is held the old window is already closed and gone to the landing; the late layout answer
        # then changes nothing. The old owner's storage key is read before the end - afterwards no identity is given.
        key=self.owner(page)
        pending=[];page.route(pattern,lambda r:pending.append(r));self.open_menu(page)
        page.get_by_role('button',name='Load from Account',exact=True).click();page.wait_for_timeout(100);self.assertEqual(len(pending),1)
        response=pending[0].fetch();other=page.context.new_page();other.goto(self.stack.proxy+'/worklist/hpacs-lite/main.html')
        expect(other.locator('#dbstat')).to_contain_text('DB Connected')
        held=[];other.route('**/api/auth/logout',lambda r:held.append(r))
        other.once('dialog',lambda d:d.accept());other.locator('#logout').click();self.until_held(other,held)
        page.wait_for_url('**/worklist/hpacs-lite/index.html',timeout=30000)
        expect(page.locator('#workspace-server-menu')).to_have_count(0)
        self.assertIsNone(page.evaluate('KinAuth.session()'))
        pending[0].fulfill(response=response)
        page.wait_for_timeout(300)
        self.assertEqual(page.evaluate('k=>JSON.parse(localStorage.getItem(k))',key),before)
        held[0].continue_();other.wait_for_url('**/worklist/hpacs-lite/index.html',timeout=30000)
        self.ended_contexts().add(page.context)
        self.assertEqual(page.evaluate('k=>JSON.parse(localStorage.getItem(k))',key),before)

    def until_held(self,page,held,timeout=20.0):
        """Wait for the held logout POST, which only this tab's own Log out sends."""
        deadline=time.monotonic()+timeout
        while not held:
            if time.monotonic()>deadline:raise AssertionError('the logout POST was not sent')
            page.wait_for_timeout(50)

    def menu(self,page):
        """The Account Layout panel open, whatever its Load button is called (Retry after a failed read)."""
        self.open_toolbar_group(page,'#workspace-server-menu')
        menu=page.locator('#workspace-server-menu')
        if menu.get_attribute('open') is None:menu.locator('summary').click()

    def blocked(self,page,writes):
        """After a failed read of the account copy: Save and Reset are off, Load is Retry, and no write left (decision:
        roaming-403 consult 2026-10-05 - the revision a write would replace is not known)."""
        self.menu(page)
        expect(page.get_by_role('button',name='Save to Account',exact=True)).to_be_disabled()
        expect(page.get_by_role('button',name='Reset Account Layout',exact=True)).to_be_disabled()
        expect(page.get_by_role('button',name='Retry',exact=True)).to_be_enabled()
        self.assertEqual(writes,[],'no PUT or DELETE while the account copy is not known')

    def test_roam_04_failure_storage_denial_and_csrf(self):
        page=self.sign_in(self.device());self.open_toolbar_group(page,'#layout-toggle');page.locator('#layout-toggle').click();self.action(page,'Save to Account','저장했습니다');remote=self.remote(page)
        # The server's CSRF rule: a write without the header is refused (and says so in its code); a read is not checked.
        denied=document_request(page, "PUT", self.stack.proxy+'/api/workspace-layout',data=dict(expectedOwner=remote['owner'],revision=remote['revision'],layout=remote['layout']))
        self.assertEqual(denied.status,403);self.assertEqual(denied.json()['code'],'AUTH_CSRF_REQUIRED');self.assertEqual(denied.headers.get('x-kin-auth-code'),'AUTH_CSRF_REQUIRED');self.assertEqual(self.remote(page),remote)
        # Local storage refused: a Load applies to this window only and says so.
        page.context.add_init_script("""(() => {const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,...rest){if(String(key).startsWith('kin-workspace:'))throw new DOMException('Synthetic denied','QuotaExceededError');return original.call(this,key,...rest);};})();""")
        self.open_toolbar_group(page,'#layout-reset');page.locator('#layout-reset').click()
        page.reload();expect(page.locator('#dbstat')).to_contain_text('DB Connected');self.action(page,'Load from Account','이 창에만 적용됨');self.mode_is(page,'portrait');self.assertIsNone(self.stored(page))
        self.assertEqual(self.remote(page),remote)
        # A refused read of the account copy: the window keeps its layout, writes nothing, says nothing about a write.
        pattern='**/api/workspace-layout';writes=[]
        def refused(route):
            if route.request.method!='GET':writes.append(route.request.method);return route.continue_()
            route.fulfill(status=403,json=dict(message='Synthetic denied'))
        page.route(pattern,refused);self.open_menu(page);page.get_by_role('button',name='Load from Account',exact=True).click()
        expect(page.locator('#workspace-server-status')).to_contain_text('접근이 거절되어');expect(page.locator('#workspace-server-status')).not_to_contain_text('쓰기')
        self.blocked(page,writes);self.mode_is(page,'portrait')
        # Retry reads again without changing the screen; a confirmed copy gives the writes back.
        page.unroute(pattern);page.get_by_role('button',name='Retry',exact=True).click()
        expect(page.get_by_role('button',name='Save to Account',exact=True)).to_be_enabled();self.mode_is(page,'portrait')
        self.assertEqual(self.remote(page),remote)

    def test_roam_04b_write_failure_starts_from_a_normal_read(self):
        page=self.sign_in(self.device());self.open_toolbar_group(page,'#layout-toggle');page.locator('#layout-toggle').click();self.action(page,'Save to Account','저장했습니다');remote=self.remote(page)
        self.open_toolbar_group(page,'#layout-reset');page.locator('#layout-reset').click();before=self.stored(page);pattern='**/api/workspace-layout'
        # A normal read first: the account copy is known, so Save may replace it. The server then fails that Save with a
        # 5xx: whether the write happened is not known - said so; the local layout and the account copy are unchanged.
        self.action(page,'Load from Account','불러왔습니다');self.open_toolbar_group(page,'#layout-reset');page.locator('#layout-reset').click();before=self.stored(page)
        page.route(pattern,lambda r:r.fulfill(status=500,json=dict(message='Synthetic failure')) if r.request.method=='PUT' else r.continue_())
        self.action(page,'Save to Account','결과를 확인하지 못했으며');self.assertEqual(self.stored(page),before);page.unroute(pattern)
        self.assertEqual(self.remote(page),remote)
        # An answer that is not an account copy is a failed read: the writes go off until a later read confirms the copy.
        bad=dict(remote,layout=dict(remote['layout'],mode='wrong'));writes=[]
        def malformed(route):
            if route.request.method!='GET':writes.append(route.request.method);return route.continue_()
            route.fulfill(status=200,json=bad)
        page.route(pattern,malformed);self.open_menu(page);page.get_by_role('button',name='Load from Account',exact=True).click()
        expect(page.locator('#workspace-server-status')).to_contain_text('확인하지 못해');self.assertEqual(self.stored(page),before)
        self.blocked(page,writes);page.unroute(pattern)
        page.get_by_role('button',name='Retry',exact=True).click()
        expect(page.get_by_role('button',name='Save to Account',exact=True)).to_be_enabled();self.assertEqual(self.stored(page),before)

    def test_roam_05_account_changes_while_old_read_is_pending(self):
        context=self.device();page=self.sign_in(context);self.open_toolbar_group(page,'#layout-toggle');page.locator('#layout-toggle').click()
        self.action(page,'Save to Account','저장했습니다');self.open_toolbar_group(page,'#layout-reset');page.locator('#layout-reset').click();before=self.stored(page)
        pending=[];page.route('**/api/workspace-layout',lambda r:pending.append(r));self.open_menu(page)
        page.get_by_role('button',name='Load from Account',exact=True).click();page.wait_for_timeout(100);self.assertEqual(len(pending),1)
        response=pending[0].fetch()
        # A session can be replaced in another tab without this old document receiving logout.
        owner_key=self.owner(page);landing=hold_landing(page)
        other=self.sign_in(context,'doctor2');self.assertIsNone(self.remote(other)['layout'])
        with page.expect_response(lambda r:r.url.endswith('/worklist/hpacs-lite/index.html') and r.status==204):
            page.evaluate("() => { void KinSessionTransport.page().request('/api/me').catch(()=>null); }")
        page.wait_for_function("KinWorkContext.state() !== 'active'");self.assertTrue(landing)
        release_after_end(pending[0],response=response)
        expect(page.get_by_role('button',name='Load from Account',exact=True,include_hidden=True)).to_be_disabled()
        self.assertEqual(page.evaluate('key=>JSON.parse(localStorage.getItem(key))',owner_key),before);self.mode_is(page,'auto');self.assertIsNone(self.remote(other)['layout'])

def load_tests(loader,tests,pattern):return unittest.TestSuite(WorkspaceRoamingE2E(n) for n in loader.getTestCaseNames(WorkspaceRoamingE2E) if n.startswith('test_roam_'))
if __name__=='__main__':unittest.main(verbosity=2)
