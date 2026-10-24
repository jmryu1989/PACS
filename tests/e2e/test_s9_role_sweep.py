"""SCN-S9-SET-03 / SCN-S9-SWEEP-05 -> RISK-S5-U1c-MIXED-DOWNGRADE.

The missing integration is a real admin membership edit followed by the old
worklist's refusal and a fresh clinician login. Existing clinician_policy_live
cases cover the role/tenant API matrix; admin_member_roles_dom_test covers the
editor's unchanged/unknown-role behavior. Do not duplicate those matrices here.

Uses the shipped main/admin/clinician pages and real BFF/API replies. A request
is held at the network boundary so the old document can observe the membership
change deterministically. No script extraction, synthetic success, or product
test hook. Run only through scripts/run-tests.py on an isolated synthetic stack.
Viewport and login deadline are the existing WorklistE2E fixture's values, not
new site requirements. Candidate registration belongs to the shared CI owner.
"""
import unittest
import time
from urllib.parse import urlsplit

from playwright.sync_api import expect

from document_session import document_request, session_headers
from test_study_access import StudyAccessE2E, policy


class S9RoleSweepE2E(StudyAccessE2E):
    def member_row(self, page, actor):
        username = self.stack.username(actor)
        expect(page.locator('#search')).to_be_enabled()
        page.locator('#search').fill(username)
        row = page.locator('#users tr').filter(
            has=page.get_by_text(username, exact=True))
        # Search filters the current server page; walk the existing pagination
        # rather than assuming the run's member is among the first users.
        while not row.count():
            self.assertTrue(page.locator('#next').is_enabled(),
                            'Owned synthetic member missing from the member list')
            previous = page.locator('#page-label').inner_text()
            page.locator('#next').click()
            expect(page.locator('#page-label')).not_to_have_text(previous)
        expect(row).to_be_visible()
        return row

    def clinician_login(self, actor):
        context = self.browser.new_context(
            ignore_https_errors=True, viewport={'width': 1600, 'height': 1050})
        self.contexts.append(context)
        page = context.new_page()
        page.goto(self.stack.proxy + '/')
        try:
            page.locator('#username').fill(self.stack.username(actor))
            page.locator('#password').fill(self.stack.passwords[actor])
            page.locator('#kc-login').click()
        except Exception:
            # Playwright fill diagnostics can contain the temporary credential.
            raise RuntimeError('Real BFF clinician login could not be submitted') from None
        page.wait_for_url('**/worklist/hpacs-lite/clinician.html', timeout=30000)
        expect(page.get_by_role('heading', name='Clinician Home', exact=True)).to_be_visible()
        # The heading is static; the signed-in actor appears after this document
        # has established its session, as the worklist login waits for its role.
        expect(page.locator('#actor')).to_contain_text(actor)
        return page

    def test_sweep_05_admin_role_change_old_document_and_fresh_login(self):
        actor = 's9-set-mixed'
        subject = self.stack.create_test_identity(
            actor, ['clinician', 'radiologist'], 'hallym')
        member = self.login(actor)
        before = document_request(member, 'GET', self.stack.api + '/me')
        self.assertEqual(before.status, 200)
        self.assertEqual(set(before.json()['roles']), {'clinician', 'radiologist'})
        self.assertEqual(document_request(member, 'GET', self.stack.api + '/prefs').status, 200)
        # The worklist badge shows the active worklist role. Full mixed-role
        # membership is verified through /me and the administrator's editor.
        expect(member.locator('#roles')).to_contain_text('radiologist')

        admin = self.login('jmryu')
        admin.goto(self.stack.proxy + '/worklist/hpacs-lite/admin.html')
        self.member_row(admin, actor).get_by_role(
            'button', name='Change Membership', exact=True).click()
        dialog = admin.locator('#membership-dialog')
        expect(dialog).to_be_visible()
        expect(dialog.locator('[name=role][value=clinician]')).to_be_checked()
        expect(dialog.locator('[name=role][value=radiologist]')).to_be_checked()

        held = []
        changed_and_refused = False
        def defer_request(route):
            if urlsplit(route.request.url).path == '/api/studies':
                held.append(route)
            else:
                route.abort('failed')

        # Defer Refresh's study-list read and interrupt other background traffic while
        # the administrator edits. APIRequestContext bypasses page routing and
        # sees the real refusal. Releasing the study-list read then exercises the UI.
        member.route('**/api/**', defer_request)
        try:
            with member.expect_request(lambda request:
                    urlsplit(request.url).path == '/api/studies'):
                member.locator('#refresh').click()
            dialog.locator('[name=role][value=radiologist]').uncheck()
            path = '/api/admin/users/' + subject
            with admin.expect_response(lambda response:
                    urlsplit(response.url).path == path and response.request.method == 'PATCH') as changed:
                dialog.get_by_role('button', name='Save', exact=True).click()
            response = changed.value
            self.assertEqual(response.status, 200)
            self.assertEqual(response.request.post_data_json['roles'], ['clinician'])
            self.assertNotIn('institution', response.request.post_data_json)
            self.assertEqual(response.json()['roles'], ['clinician'])
            self.assertEqual(response.json()['institution'], before.json()['institution'])
            # Reuse the existing fixture allowance for Keycloak's whole-second
            # auth_time (LiveStack.set_member_rights), not a product delay rule.
            time.sleep(1.05)

            # Read the persisted membership again, not the dialog's optimistic
            # state. The same subject must retain clinician and lose radiologist.
            admin.reload()
            self.member_row(admin, actor).get_by_role(
                'button', name='Change Membership', exact=True).click()
            expect(dialog.locator('[name=role][value=clinician]')).to_be_checked()
            expect(dialog.locator('[name=role][value=radiologist]')).not_to_be_checked()
            stale = document_request(member, 'GET', self.stack.api + '/prefs')
            self.assertEqual(stale.status, 401)
            self.assertEqual(stale.json()['code'], 'AUTH_SESSION_ENDED')
            self.assertTrue(held, 'Refresh must have issued its study-list read')
            changed_and_refused = True
        finally:
            # Abort held requests on an assertion failure; continuing is reserved
            # for the successful edit/refusal sequence below.
            # Resolve intercepted requests while their handler is still installed;
            # removing interception first can release a route before continue_().
            try:
                for route in held[:-1] if changed_and_refused else held:
                    route.abort()
                if changed_and_refused:
                    held[-1].continue_()
            finally:
                member.unroute('**/api/**', defer_request)

        # The landing page automatically starts authentication when the ended
        # server session is absent. Verify its real destination, not a transient
        # Login button that disappears while the existing redirect completes.
        member.wait_for_url('**/auth/**', timeout=30000)
        expect(member.locator('#password')).to_be_visible()
        expect(member.locator('#kc-login')).to_be_enabled()
        expect(member.locator('#findings')).to_have_count(0)

        fresh = self.clinician_login(actor)
        me = document_request(fresh, 'GET', self.stack.api + '/me')
        self.assertEqual(me.status, 200)
        self.assertEqual(me.json()['sub'], subject)
        self.assertEqual(me.json()['roles'], ['clinician'])
        self.assertEqual(me.json()['institution'], before.json()['institution'])
        allowed = document_request(fresh, 'GET', self.stack.api + '/clinician/studies')
        self.assertEqual(allowed.status, 200)
        denied = document_request(fresh, 'GET', self.stack.api + '/prefs')
        self.assertEqual(denied.status, 403)
        self.assertEqual(denied.json()['code'], 'CLINICIAN_ROUTE_DENIED')
        expect(fresh.locator('#findings')).to_have_count(0)

    def test_sweep_05_institution_move_requires_new_scope_on_real_page(self):
        """The existing institution recovery API case, joined to the served UI.

        REQ-D01-STUDY-ACCESS -> access/owner/stale risks. An institution move
        preserves the old policy as history and requires explicit review in the
        new scope; it must not silently inherit the old unrestricted policy.
        """
        actor, receiver = 's9-set-move', 's9-set-receiver-admin'
        subject = self.stack.create_test_identity(
            actor, ['clinician', 'radiologist'], 'hallym')
        self.stack.create_test_identity(receiver, ['admin', 'radiologist'], 'kin-center')
        home = self.fixture()
        destination = self.fixture(institution='KIN 판독센터')
        self.write(policy(restricted=False), who=actor)
        member = self.login(actor)
        binding = member.evaluate('KinWorkContext.session()')
        listed = document_request(member, 'GET', self.stack.api + '/studies')
        self.assertEqual(listed.status, 200)
        self.assertIn(home.uid, [row['uid'] for row in listed.json()['studies']])
        self.assertNotIn(destination.uid, [row['uid'] for row in listed.json()['studies']])

        admin = self.login('jmryu')
        admin.goto(self.stack.proxy + '/worklist/hpacs-lite/admin.html')
        self.member_row(admin, actor).get_by_role(
            'button', name='Change Membership', exact=True).click()
        dialog = admin.locator('#membership-dialog')
        dialog.locator('[name=institution]').fill('kin-center')
        path = '/api/admin/users/' + subject
        with admin.expect_response(lambda response:
                urlsplit(response.url).path == path and response.request.method == 'PATCH') as changed:
            dialog.get_by_role('button', name='Save', exact=True).click()
        self.assertEqual(changed.value.status, 200)
        self.assertEqual(changed.value.json()['institution'], 'kin-center')
        self.assertEqual(set(changed.value.json()['roles']), {'clinician', 'radiologist'})
        self.assertNotIn('roles', changed.value.request.post_data_json)
        # Retain this document's original binding even if its background read
        # has already navigated it to the landing page after the change.
        stale = member.request.get(self.stack.api + '/studies',
                                   headers=session_headers(binding), max_redirects=0)
        self.assertEqual(stale.status, 401)
        self.assertEqual(stale.json()['code'], 'AUTH_SESSION_ENDED')
        # Same fixture allowance as set_member_rights: a fresh login must be in
        # a later auth_time second than the membership command.
        time.sleep(1.05)

        fresh = self.login(actor)
        me = document_request(fresh, 'GET', self.stack.api + '/me')
        self.assertEqual(me.status, 200)
        self.assertEqual((me.json()['sub'], me.json()['institution']), (subject, 'kin-center'))
        access = document_request(fresh, 'GET', self.stack.api + '/study-access')
        self.assertEqual(access.status, 200)
        self.assertTrue(access.json()['denied'])
        self.assertTrue(access.json()['needsInstitutionReview'])
        listed = document_request(fresh, 'GET', self.stack.api + '/studies')
        self.assertEqual(listed.status, 200)
        self.assertEqual(listed.json()['studies'], [])
        expect(fresh.locator('#rows tr[data-uid]')).to_have_count(0)

        # The receiving administrator explicitly reviews scope through the real
        # API, as in test_recovery_03. No member policy is seeded into the DB.
        # Use the known subject instead of a cached pre-change fixture token.
        reviewed = self.stack.request('POST', '/admin/users/' + subject + '/study-access',
                                     receiver, self.body(policy(restricted=False), actor=receiver))
        self.assertEqual(reviewed.status, 201)
        fresh.locator('#refresh').click()
        expect(fresh.locator('#rows tr[data-uid="' + destination.uid + '"]').first).to_be_visible()
        expect(fresh.locator('#rows tr[data-uid="' + home.uid + '"]')).to_have_count(0)
        listed = document_request(fresh, 'GET', self.stack.api + '/studies')
        self.assertEqual(listed.status, 200)
        self.assertIn(destination.uid, [row['uid'] for row in listed.json()['studies']])
        self.assertNotIn(home.uid, [row['uid'] for row in listed.json()['studies']])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([
        S9RoleSweepE2E('test_sweep_05_admin_role_change_old_document_and_fresh_login'),
        S9RoleSweepE2E('test_sweep_05_institution_move_requires_new_scope_on_real_page')])


if __name__ == '__main__':
    unittest.main(verbosity=2)
