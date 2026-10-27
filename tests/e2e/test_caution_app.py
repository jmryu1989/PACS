"""C37/M05: real proxy and Keycloak self-service, synthetic accounts only.

The access-record identity (email = API actor, first/last name = displayName) is admin-edited only. Self-registration
still collects it once, before the member exists in any access record."""
import base64
import hashlib
import re
import secrets
import unittest
import uuid
from pathlib import Path
from urllib.parse import quote, urlencode
from test_worklist import WorklistE2E, expect

IDENTITY = ('email', 'firstName', 'lastName')


class CautionAppE2E(WorklistE2E):
    def kc_user(self, actor):
        return self.stack.kc_admin('GET', f'/users/{quote(self.stack.user_ids[actor])}').body

    def password_credential(self, actor):
        rows = self.stack.kc_admin('GET', f'/users/{quote(self.stack.user_ids[actor])}/credentials').body
        return [(row['id'], row.get('createdDate')) for row in rows if row.get('type') == 'password']

    def open_password_action(self, page, actor):
        with page.expect_popup() as popup:
            page.get_by_role('link', name='Change Password').click()
        account = popup.value
        account.wait_for_load_state('domcontentloaded')
        expect(account.locator('#password-new, #password').first).to_be_visible()
        # Keycloak asks for the current password again when the sign-in is older than its re-authentication window.
        if account.locator('#username').is_visible():
            account.locator('#username').fill(self.stack.username(actor))
        if account.locator('#password').is_visible():
            account.locator('#password').fill(self.stack.passwords[actor])
            account.locator('#kc-login').click()
        expect(account.locator('#password-new')).to_be_visible()
        return account

    def failure_shot(self, account, name):
        folder = Path(__file__).parent / 'artifacts' / 'caution-app'
        folder.mkdir(parents=True, exist_ok=True)
        account.screenshot(path=str(folder / name))

    def test_account_password_change(self):
        page = self.login('doctor')
        before = self.stack.request('GET', '/me', 'doctor').body
        session = next(c['value'] for c in page.context.cookies() if c['name'] == 'kin_sid')
        password = 'SYN-' + secrets.token_hex(16) + 'aA1!'
        try:
            account = self.open_password_action(page, 'doctor')
            account.locator('#password-new').fill(password)
            account.locator('#password-confirm').fill(password)
            account.get_by_role('button', name=re.compile(r'^(Submit|제출|확인)$')).click()
            # The tab reports Keycloak's outcome instead of opening a second worklist document.
            expect(account.locator('body')).to_contain_text('비밀번호를 변경했습니다')
        except Exception as error:
            self.failure_shot(page.context.pages[-1], 'password-form-failed.png')
            raise RuntimeError('Synthetic password form: ' + type(error).__name__ + '; '
                               + page.context.pages[-1].locator('body').inner_text()[:500]) from None
        self.assertIn('/api/auth/callback', account.url)
        self.assertEqual(next(c['value'] for c in page.context.cookies() if c['name'] == 'kin_sid'), session)
        expect(page.locator('#dbstat')).to_contain_text('DB Connected')
        for path in ('/auth/realms/kin/account', '/auth/realms/kin/account/personal-info'):
            self.assertEqual(account.request.get(self.stack.proxy + path).status, 404)
        self.stack.passwords['doctor'] = password
        # A fresh browser must authenticate with the changed password.
        renewed = self.login('doctor')
        expect(renewed.locator('#dbstat')).to_contain_text('DB Connected')
        self.stack.tokens.pop('doctor', None)
        after = self.stack.request('GET', '/me', 'doctor').body
        for field in ('sub', 'actor', 'displayName'):
            self.assertTrue(before[field], field)
            self.assertEqual(after[field], before[field], field)
        self.failure_shot(account, 'password-changed.png')

    def test_password_change_cancel_keeps_password(self):
        page = self.login('doctor')
        session = next(c['value'] for c in page.context.cookies() if c['name'] == 'kin_sid')
        credential = self.password_credential('doctor')
        account = self.open_password_action(page, 'doctor')
        account.locator('[name="cancel-aia"]').click()
        expect(account.locator('body')).to_contain_text('비밀번호 변경을 취소했습니다')
        self.assertEqual(self.password_credential('doctor'), credential)
        self.assertEqual(next(c['value'] for c in page.context.cookies() if c['name'] == 'kin_sid'), session)
        expect(page.locator('#dbstat')).to_contain_text('DB Connected')

    def test_signed_in_user_cannot_edit_access_identity(self):
        """의료법 23조④ 접속기록: a typed Keycloak action URL must not change the identity the API records as actor."""
        page = self.login('doctor')
        before = self.kc_user('doctor')
        me = self.stack.request('GET', '/me', 'doctor').body
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        changed = 'kin-test-' + uuid.uuid4().hex[:12] + '-changed@local.test'
        for action in ('UPDATE_PROFILE', 'VERIFY_PROFILE'):
            query = urlencode({'client_id': 'kin-bff', 'redirect_uri': self.stack.proxy + '/api/auth/callback',
                               'response_type': 'code', 'scope': 'openid', 'state': secrets.token_urlsafe(16),
                               'code_challenge': challenge, 'code_challenge_method': 'S256', 'kc_action': action})
            attempt = page.context.new_page()
            attempt.goto(self.stack.proxy + '/auth/realms/kin/protocol/openid-connect/auth?' + query)
            attempt.wait_for_load_state('domcontentloaded')
            form = attempt.locator('form')
            if '/login-actions/' in attempt.url and form.count():
                # Whatever the form renders, post changed identity fields as a crafted submission would.
                attempt.evaluate("""([email]) => { const form = document.querySelector('form');
                    for (const [k, v] of [['email', email], ['firstName', 'Changed'], ['lastName', 'Identity']]) {
                        let input = form.querySelector('[name="' + k + '"]');
                        if (!input) { input = document.createElement('input'); input.type = 'hidden'; input.name = k; form.appendChild(input); }
                        input.removeAttribute('readonly'); input.removeAttribute('disabled'); input.value = v; } }""", [changed])
                submit = attempt.locator('input[type=submit], button[type=submit]:not([name="cancel-aia"])')
                if submit.count():
                    submit.first.click()
                    attempt.wait_for_load_state('domcontentloaded')
            after = self.kc_user('doctor')
            self.assertEqual({k: after.get(k) for k in IDENTITY}, {k: before.get(k) for k in IDENTITY}, action)
            attempt.close()
        self.stack.tokens.pop('doctor', None)
        again = self.stack.request('GET', '/me', 'doctor').body
        self.assertEqual((again['actor'], again['displayName']), (me['actor'], me['displayName']))

    def test_self_registration_collects_identity(self):
        context = self.browser.new_context(ignore_https_errors=True, viewport={'width': 1600, 'height': 1050})
        self.contexts.append(context)
        page = context.new_page()
        page.set_default_timeout(20000)
        username = 'kin-test-' + uuid.uuid4().hex[:12] + '-signup'
        email = username + '@local.test'
        password = 'SYN-' + secrets.token_hex(12) + 'aA1!'
        page.goto(self.stack.proxy + '/api/auth/register')
        try:
            for field, value in (('username', username), ('email', email), ('firstName', 'Signup'), ('lastName', 'Synthetic'),
                                 ('password', password), ('password-confirm', password)):
                page.locator('#' + field).fill(value)
            page.locator('input[type=submit], button[type=submit]').first.click()
            page.wait_for_load_state('domcontentloaded')
        except Exception:
            raise RuntimeError('Synthetic registration form could not be submitted') from None
        found = [u for u in self.stack.kc_admin('GET', '/users?exact=true&username=' + quote(username)).body or []
                 if u.get('username') == username]
        if found:
            # The owned identity joins the stack's cleanup (Keycloak user, sessions, audit rows of this actor).
            self.stack.user_ids['signup'] = found[0]['id']
            self.stack.usernames['signup'] = username
            self.stack.template_owners.add(email)
        self.assertEqual(len(found), 1, page.locator('body').inner_text()[:300])
        self.assertEqual({k: found[0].get(k) for k in IDENTITY}, {'email': email, 'firstName': 'Signup', 'lastName': 'Synthetic'})

    def test_shared_ip_requests(self):
        page = self.login('doctor')
        # Twelve immediate requests exceed the removed token bucket burst (10).
        # Missing grant fields never attempt a login or affect the retained account lockout.
        statuses = [page.request.post(self.stack.proxy + '/auth/realms/kin/protocol/openid-connect/token',
                                     form={'client_id': 'kin-web'}).status for _ in range(12)]
        self.assertEqual(statuses, [400] * 12)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([CautionAppE2E(name) for name in [
        'test_account_password_change', 'test_password_change_cancel_keeps_password',
        'test_signed_in_user_cannot_edit_access_identity', 'test_self_registration_collects_identity',
        'test_shared_ip_requests']])


if __name__ == '__main__':
    unittest.main(verbosity=2)
