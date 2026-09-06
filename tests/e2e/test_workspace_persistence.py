"""D02B real account/browser workspace persistence; separate from B2/D02A/D03A.

python tests/e2e/test_workspace_persistence.py
"""
from __future__ import annotations

import json
import unittest
from playwright.sync_api import expect
from test_portrait_workspace import PortraitWorkspaceE2E
import test_worklist as base


class WorkspacePersistenceE2E(PortraitWorkspaceE2E):
    def snapshot(self, page, name):
        page.screenshot(path=str(base.Path(__file__).parent / 'artifacts' / ('D02B-' + name + '.png')))

    def device(self):
        context = self.browser.new_context(ignore_https_errors=True, viewport={'width': 1600, 'height': 1000})
        self.contexts.append(context)
        return context

    def sign_in(self, context, actor='doctor'):
        # An empty cookie jar forces a fresh real BFF/Keycloak login, while the
        # same browser profile's localStorage stays intact for account switching.
        context.clear_cookies()
        page = context.new_page()
        page.goto(self.stack.proxy + '/')
        try:
            page.locator('#username').fill(self.stack.username(actor))
            page.locator('#password').fill(self.stack.passwords[actor])
            page.locator('#kc-login').click()
        except Exception:
            raise RuntimeError('D02B real login failed') from None
        page.wait_for_url('**/worklist/hpacs-lite/main.html', timeout=30000)
        expect(page.locator('#dbstat')).to_contain_text('DB 연결됨')
        me = page.context.request.get(self.stack.api + '/me').json()
        self.assertEqual(page.evaluate('KinAuth.session().sub'), me['sub'])
        self.assertTrue(me['sub'])
        return page

    def sign_out(self, page):
        page.once('dialog', lambda d: d.accept())
        page.locator('#logout').click()
        page.wait_for_url('**/index.html', timeout=30000)
        page.close()

    def owner(self, page):
        return page.evaluate('KinWorkspaceLayout.key(KinAuth.session())')

    def stored(self, page):
        return page.evaluate('JSON.parse(localStorage.getItem(KinWorkspaceLayout.key(KinAuth.session())))')

    def mode_is(self, page, mode):
        expect(page.locator('#layout-toggle')).to_have_attribute('aria-label', '화면 배치 ' + mode)

    def size_is(self, page, selector, dimension, expected):
        # set_viewport_size returns before the browser dispatches resize. Wait
        # for the real rendered size, not an arbitrary delay or a CSS assignment.
        page.wait_for_function("""([selector,dimension,expected]) =>
          Math.abs(document.querySelector(selector).getBoundingClientRect()[dimension]-expected)<=2""",
          arg=[selector,dimension,expected],timeout=5000)

    def drag_by(self, page, selector, dx=0, dy=0, cancel=False):
        handle = page.locator(selector)
        handle.scroll_into_view_if_needed()
        rect = handle.bounding_box()
        x, y = rect['x'] + rect['width']/2, rect['y'] + rect['height']/2
        page.mouse.move(x,y)
        page.mouse.down()
        page.mouse.move(x+dx,y+dy,steps=8)
        if cancel:
            # A browser pointercancel restores the last committed preference.
            handle.dispatch_event('pointercancel', {'pointerId': 1})
        page.mouse.up()

    def test_d02b_accounts_and_devices(self):
        """OWNER: A/B x two browser profiles, real logout/login, owner-only reset."""
        x, y = self.device(), self.device()
        ax = self.sign_in(x)
        ax.set_viewport_size({'width':900,'height':1400})
        ax.locator('#layout-toggle').click()  # A-X portrait
        self.drag_by(ax,'#resize-top',dy=30)
        a_key, a_state = self.owner(ax), self.stored(ax)
        self.assertEqual(a_state['mode'],'portrait')
        self.assertGreater(a_state['portrait']['top'],230)
        self.sign_out(ax)
        bx = self.sign_in(x,'doctor2')
        self.mode_is(bx,'auto')
        self.assertIsNone(self.stored(bx))
        bx.locator('#layout-toggle').click()
        bx.locator('#layout-toggle').click()  # B-X landscape
        b_key, b_state = self.owner(bx), self.stored(bx)
        self.assertNotEqual(a_key,b_key)
        self.sign_out(bx)
        ax = self.sign_in(x)
        self.mode_is(ax,'portrait')
        self.assertEqual(self.stored(ax),a_state)
        ax.locator('#quick').fill('D02B-NO-STUDY-ACCOUNT-CHECK')
        self.snapshot(ax,'account-a-restored')
        ay = self.sign_in(y)
        self.mode_is(ay,'auto')
        self.assertIsNone(self.stored(ay))
        ay.locator('#layout-toggle').click()
        ay.locator('#layout-toggle').click()
        self.mode_is(ay,'landscape')
        self.sign_out(ay)
        by = self.sign_in(y,'doctor2')
        self.mode_is(by,'auto')
        self.assertIsNone(self.stored(by))
        self.sign_out(by)
        ay = self.sign_in(y)
        self.mode_is(ay,'landscape')
        self.assertEqual(self.stored(ax),a_state)
        ax.locator('#layout-reset').click()
        self.assertIsNone(self.stored(ax))
        self.mode_is(ax,'auto')
        self.assertEqual(ax.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',b_key),b_state)
        self.assertEqual(self.stored(ay)['mode'],'landscape')
        self.sign_out(ax)
        bx = self.sign_in(x,'doctor2')
        self.mode_is(bx,'landscape')
        self.assertEqual(self.stored(bx),b_state)

    def test_d02b_sizes_and_report_preservation(self):
        """RESTORE/DATA: all separators, orientation, clamp and reset retain report data."""
        fixture=self.fixture()
        self.seed_report(fixture)
        page=self.sign_in(self.device())
        self.select(page,fixture)
        self.wait_thumbnail(page)
        # Establish an actual private draft before layout-only observation.
        edited=fixture.secret+' private draft'
        page.locator('#findings').fill(edited)
        page.locator('#quick').click()
        self.wait_state(page,fixture,lambda s:(s.get('draft') or {}).get('findings')==edited,timeout=30000)
        history=self.versions(fixture)
        self.drag_by(page,'#resize-main',dx=85)
        self.drag_by(page,'#resize-top',dy=35)
        self.drag_by(page,'#resize-related',dx=-30)
        self.drag_by(page,'#resize-prior',dy=45)
        landscape=self.stored(page)['landscape']
        self.assertEqual(set(landscape),{'main','top','related','prior'})
        before=self.stored(page)
        self.drag_by(page,'#resize-top',dy=20,cancel=True)
        self.assertEqual(self.stored(page),before)
        self.size_is(page,'.rw','height',landscape['top'])
        requests=[]
        listener=lambda r:requests.append((r.method,r.url)) if '/dicom-web/' in r.url or '/preview' in r.url or (r.method!='GET' and '/api/' in r.url) else None
        page.on('request',listener)
        try:
            page.set_viewport_size({'width':900,'height':1400})
            self.drag_by(page,'#resize-main',dy=30)
            self.drag_by(page,'#resize-top',dy=25)
            self.drag_by(page,'#resize-related',dy=15)
            self.drag_by(page,'#resize-prior',dy=20)
            portrait=self.stored(page)['portrait']
            self.assertEqual(set(portrait),{'main','top','related','prior'})
            page.set_viewport_size({'width':768,'height':1024})
            for selector in ['#thumbwrap img','#clinical','#t-mod','#b-history','#layout-reset']:
                self.reachable(page,selector)
            self.assertEqual(self.stored(page)['portrait'],portrait)
            page.set_viewport_size({'width':900,'height':1400})
            self.size_is(page,'.rw','height',portrait['top'])
            page.set_viewport_size({'width':1600,'height':1000})
            self.size_is(page,'.left','width',landscape['main'])
            self.size_is(page,'.rw','height',landscape['top'])
        finally:
            page.remove_listener('request',listener)
        self.assertEqual(requests,[])
        saved=self.stored(page)
        page.reload()
        self.select(page,fixture)
        expect(page.locator('#findings')).to_have_value(edited)
        self.assertEqual(self.stored(page),saved)
        self.size_is(page,'.left','width',landscape['main'])
        self.snapshot(page,'landscape-restored-draft')
        page.locator('#layout-reset').click()
        self.assertIsNone(self.stored(page))
        expect(page.locator('#findings')).to_have_value(edited)
        self.assertEqual(self.versions(fixture),history)
        self.assertEqual(self.state(fixture)['findings'],fixture.secret)
        self.assertIsNone(self.state(fixture,'doctor2').get('draft'))
        self.assertNotIn(fixture.uid,json.dumps(saved))
        self.assertNotIn(edited,json.dumps(saved))

    def test_d02b_corruption_and_storage_denial(self):
        """INPUT: corrupt records and blocked storage fall back without losing app access."""
        page=self.sign_in(self.device())
        owner=self.owner(page)
        page.evaluate('(key)=>localStorage.setItem(key,JSON.stringify({version:1,mode:"portrait",portrait:{main:-999},landscape:{}}))',owner)
        page.reload()
        expect(page.locator('#dbstat')).to_contain_text('DB 연결됨')
        self.mode_is(page,'auto')
        expect(page.locator('#layout-status')).to_contain_text('기본 배치')
        page.context.add_init_script("""(() => {
          for (const [name,error] of [['getItem','SecurityError'],['setItem','QuotaExceededError'],['removeItem','SecurityError']]) {
            const original=Storage.prototype[name];
            Storage.prototype[name]=function(key,...args) {
              if (String(key).startsWith('kin-workspace:')) throw new DOMException('blocked for D02B',error);
              return original.call(this,key,...args);
            };
          }
        })();""")
        page.reload()
        expect(page.locator('#dbstat')).to_contain_text('DB 연결됨')
        expect(page.locator('#layout-status')).to_contain_text('저장소 사용 불가')
        page.locator('#layout-toggle').click()
        self.mode_is(page,'portrait')
        expect(page.locator('#layout-status')).to_contain_text('저장 안 됨')
        page.set_viewport_size({'width':768,'height':1024})
        self.reachable(page,'#layout-reset')
        page.locator('#layout-reset').click()
        self.mode_is(page,'auto')
        expect(page.locator('#layout-status')).to_contain_text('초기화 저장 안 됨')
        self.reachable(page,'#logout')
        page.locator('#quick').fill('D02B-NO-STUDY-STORAGE-CHECK')
        self.snapshot(page,'storage-denied')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(WorkspacePersistenceE2E(name) for name in loader.getTestCaseNames(WorkspacePersistenceE2E)
                              if name.startswith('test_d02b_'))


if __name__=='__main__':
    unittest.main(verbosity=2)
