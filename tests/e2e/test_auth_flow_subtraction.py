"""Product-cuts-3: served PKCE/session binding, native archive and admin consumers.

Synthetic LiveStack only, through scripts/run-tests.py. The archive is downloaded
by the browser without a query or custom headers and checked against its manifest.
"""
import os
import re
from pathlib import Path
import unittest
from datetime import datetime
import uuid

from playwright.sync_api import expect
from test_worklist import WorklistE2E
from document_session import document_request
from invariants_live import psql
from viewer_precision_fixture import synthetic_ct


class AuthFlowSubtractionE2E(WorklistE2E):
    def choose_account(self, page):
        page.wait_for_url('**/auth/**')
        page.wait_for_load_state('domcontentloaded')
        # Keycloak can offer the previous username first; its standard restart link opens account selection.
        if not page.locator('#username').count():
            page.get_by_role('link', name=re.compile('로그인 다시 시작|Restart login')).click()
        expect(page.locator('#username')).to_be_editable()

    def submit_login(self, page, actor):
        try:
            self.choose_account(page)
            page.locator('#username').fill(self.stack.username(actor))
            page.locator('#password').fill(self.stack.passwords[actor])
            page.locator('#kc-login').click()
        except Exception:
            raise RuntimeError('Synthetic login form could not be submitted') from None
        page.wait_for_url('**/worklist/hpacs-lite/main.html')
        page.wait_for_function('KinAuth.session() !== null')

    def test_served_login_switch_logout_archive_and_admin(self):
        fixture = synthetic_ct(self.stack, 'PC3-' + uuid.uuid4().hex, 'AUTH-FLOW',
                               datetime.now().strftime('%Y%m%d'), (0, 0, 0), (1, 0, 0, 0, 1, 0), (1, 1), slices=1)
        operations = []
        page = self.login('doctor')
        evidence = Path(os.environ.get('KIN_EVIDENCE_DIR', 'tmp/product-cuts-3-browser'))
        evidence.mkdir(parents=True, exist_ok=True)
        try:
            self.assertEqual(page.evaluate('location.hash'), '')
            old_binding = page.evaluate('KinAuth.sessionId()')
            # The same public command used by the landing page's Switch button.
            page.evaluate('void KinAuth.switchAccount()')
            self.choose_account(page)
            page.screenshot(path=str(evidence / 'switch-login.png'))
            self.submit_login(page, 'doctor2')
            current = document_request(page, 'GET', self.stack.api + '/me')
            self.assertEqual(current.json()['actor'], self.stack.actor('doctor2'))
            self.assertNotEqual(page.evaluate('KinAuth.sessionId()'), old_binding)
            stale = page.context.request.get(self.stack.api + '/studies', headers={'X-KIN-Session': old_binding})
            self.assertEqual(stale.status, 409)
            self.assertEqual(stale.json()['code'], 'AUTH_SESSION_MISMATCH')
            self.select(page, fixture)
            operation = self.download_operation(page, fixture, operations)
            archive = self.stack.api + f'/studies/{fixture.uid}/original-downloads/{operation}/archive'
            seen = []
            page.on('request', lambda request: seen.append(request) if request.url == archive else None)
            with page.expect_download() as waiting:
                page.evaluate('url => location.assign(url)', archive)
            download = waiting.value
            self.assertIsNone(download.failure())
            self.assertEqual(download.url, archive)
            self.assertTrue(seen)
            for request in seen:
                self.assertTrue('x-kin-session' not in request.all_headers(), 'native download carries no session header')
                self.assertTrue('x-kin-csrf' not in request.all_headers(), 'native download carries no CSRF header')
            self.archive_supplied(download.path(), operation, 1)
            page.screenshot(path=str(evidence / 'archive-worklist.png'))
            page.once('dialog', lambda dialog: dialog.accept())
            with page.expect_response(lambda r: r.url.endswith('/auth/logout')) as ended:
                page.locator('#logout').click()
            self.assertEqual(ended.value.status, 204)
            self.assertEqual(page.context.request.get(self.stack.api + '/me').status, 401)
            page.wait_for_url('**/worklist/hpacs-lite/index.html')
            page.locator('#signin').click()
            self.submit_login(page, 'jmryu')
            response = page.goto(self.stack.proxy + '/worklist/hpacs-lite/admin.html')
            self.assertEqual(response.status, 200)
            expect(page.locator('#users tr')).not_to_have_count(0)
            users = document_request(page, 'GET', self.stack.api + '/admin/users')
            self.assertEqual(users.status, 200)
            self.assertEqual(users.headers.get('cache-control'), 'no-store')
            page.screenshot(path=str(evidence / 'admin-users.png'))
        finally:
            try:
                page.screenshot(path=str(evidence / 'served-flow-final.png'))
            except Exception:
                pass
            if operations:
                self.assertTrue(all(re.fullmatch(r'[0-9a-f-]{36}', value) for value in operations))
                psql('DELETE FROM "ImportOperation" WHERE kind=\'download\' AND id IN (' + ','.join("'" + value + "'" for value in operations) + ');')


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromNames(['test_served_login_switch_logout_archive_and_admin'], AuthFlowSubtractionE2E)


if __name__ == '__main__':
    unittest.main(verbosity=2)
