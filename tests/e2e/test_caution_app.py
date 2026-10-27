"""C37/M05: real proxy and Keycloak self-service, synthetic accounts only."""
import re
import secrets
import unittest
from pathlib import Path
from test_worklist import WorklistE2E, expect


class CautionAppE2E(WorklistE2E):
    def test_account_password_change(self):
        page = self.login('doctor')
        with page.expect_popup() as popup:
            page.get_by_role('link', name='Change Password').click()
        account = popup.value
        account.wait_for_load_state('domcontentloaded')
        expect(account.locator('body')).not_to_contain_text('404 Not Found')
        update = account.get_by_role('button', name=re.compile(r'^(Update|업데이트|변경)$'))
        expect(update.first).to_be_visible(timeout=30000)
        update.first.click()
        password = 'SYN-' + secrets.token_hex(16) + 'aA1!'
        try:
            expect(account.locator('#password-new, #password').first).to_be_visible()
            if account.locator('#username').is_visible():
                account.locator('#username').fill(self.stack.username('doctor'))
            if account.locator('#password').is_visible():
                account.locator('#password').fill(self.stack.passwords['doctor'])
                account.locator('#kc-login').click()
            account.locator('#password-new').fill(password)
            account.locator('#password-confirm').fill(password)
            account.get_by_role('button', name=re.compile(r'^(Submit|제출|확인)$')).click()
        except Exception as error:
            folder = Path(__file__).parent / 'artifacts' / 'caution-app'
            folder.mkdir(parents=True, exist_ok=True)
            account.screenshot(path=str(folder / 'password-form-failed.png'))
            raise RuntimeError('Synthetic password form: ' + type(error).__name__ + '; ' + account.locator('body').inner_text()) from None
        account.wait_for_url('**/account/**', timeout=30000)
        self.stack.passwords['doctor'] = password
        # A fresh browser must authenticate with the changed password.
        renewed = self.login('doctor')
        expect(renewed.locator('#dbstat')).to_contain_text('DB Connected')
        folder = Path(__file__).parent / 'artifacts' / 'caution-app'
        folder.mkdir(parents=True, exist_ok=True)
        account.screenshot(path=str(folder / 'password-changed.png'))

    def test_shared_ip_requests(self):
        page = self.login('doctor')
        # Twelve immediate requests exceed the removed token bucket burst (10).
        # Missing grant fields never attempt a login or affect the retained account lockout.
        statuses = [page.request.post(self.stack.proxy + '/auth/realms/kin/protocol/openid-connect/token',
                                     form={'client_id': 'kin-web'}).status for _ in range(12)]
        self.assertEqual(statuses, [400] * 12)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([CautionAppE2E(name) for name in ['test_account_password_change', 'test_shared_ip_requests']])


if __name__ == '__main__':
    unittest.main(verbosity=2)
