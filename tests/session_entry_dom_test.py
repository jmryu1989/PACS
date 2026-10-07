# coding: utf-8
"""U5S-REQ-06/09/22 amendments 1,4,5 -> U5S-RISK-SESSION/WAIT -> U5CLI-F03.

Entry failures are request failures. Real pages use bounded confirmation retries and
must never replace another working document's live session just to enter.
"""
import json
import unittest

import auth_logout_dom_test as h
from playwright.sync_api import expect


class SessionEntry(h.LogoutDOMTest):
    def test_one_503_enters_automatically_and_keeps_the_other_tab_working(self):
        first = self.open_main()
        self.select_and_type(first)
        live = self.site.cookie
        second = self.watch(self.context.new_page())
        self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})]
        second.goto(h.INDEX_URL)
        expect(second.locator('#msg')).to_contain_text('다시 확인')
        second.wait_for_url(h.MAIN_URL)
        expect(second.locator('#rows')).to_contain_text(h.PATIENT)
        self.refresh(first)
        self.assertEqual(([], 0, live, h.FIELDS), (self.site.login_posts, self.site.logins, self.site.cookie, self.editor(first)))
        self.assertEqual('active', self.screen(first)['state'])
        self.assertNotIn(live, self.site.ended)

    def test_main_entry_retries_in_place_without_landing_or_login(self):
        self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})]
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator('#err')).to_contain_text('다시 확인')
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.assertEqual(([], [], 0), (self.docs(name='index.html'), self.site.login_posts, self.site.logins))

    def test_login_during_failed_confirmation_reuses_the_live_session(self):
        self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})]
        live = self.site.cookie
        self.page.goto(h.INDEX_URL)
        self.page.get_by_role('button', name=h.SIGN_IN).click()
        self.page.wait_for_url(h.MAIN_URL)
        self.assertEqual(([], 0, live), (self.site.login_posts, self.site.logins, self.site.cookie))
        self.assertNotIn(live, self.site.ended)

    def test_confirmation_retries_are_bounded_and_do_not_start_login(self):
        for url in (h.INDEX_URL, h.MAIN_URL):
            with self.subTest(url=url):
                self.fresh_context()
                self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})] * 20
                self.page.goto(url)
                status = self.page.locator('#msg' if url == h.INDEX_URL else '#err')
                expect(status).to_contain_text('세션을 확인하지 못했습니다', timeout=20000)
                self.assertEqual(4, self.site.count('GET', '/api/me'))
                self.page.clock.install()
                self.page.clock.run_for(70000)
                self.assertEqual(4, self.site.count('GET', '/api/me'))
                self.assertEqual(([], 0, [], None), (self.site.login_posts, self.site.logins, list(self.site.ended), self.screen()['end']))
                self.assertEqual('unknown', self.screen()['state'])
                self.assertEqual(url, self.page.url)

    def test_a_dropped_confirmation_recovers_without_login(self):
        remaining = [True]
        def drop_once(route, request):
            if remaining:
                remaining.pop()
                route.abort('connectionreset')
            else:
                route.fallback()
        self.context.route('**/api/me', drop_once)
        self.page.goto(h.INDEX_URL)
        self.page.wait_for_url(h.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.assertEqual(([], 0), (self.site.login_posts, self.site.logins))

    def test_a_timed_out_confirmation_recovers_without_login(self):
        self.page.clock.install()
        self.site.held_me = []
        self.page.goto(h.INDEX_URL)
        self.wait_until(lambda: self.site.held_me, 'held confirmation')
        self.page.clock.run_for(10001)
        expect(self.page.locator('#msg')).to_contain_text('다시 확인')
        self.site.held_me = None
        self.page.clock.run_for(1001)
        self.page.wait_for_url(h.MAIN_URL)
        self.assertEqual(([], 0), (self.site.login_posts, self.site.logins))

    def test_end_notice_during_retry_does_not_adopt_the_late_session(self):
        self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})]
        self.page.clock.install()
        self.page.goto(h.INDEX_URL)
        expect(self.page.locator('#msg')).to_contain_text('다시 확인')
        record = {'session': self.site.cookie, 'operation': 9999999999999, 'status': 'confirmed', 'origin': 'logout'}
        self.page.evaluate('(record) => {localStorage.setItem("kin-session-end:" + record.session, JSON.stringify(record)); window.dispatchEvent(new Event("focus"));}', record)
        self.page.clock.run_for(10000)
        self.assertEqual(h.INDEX_URL, self.page.url)
        self.assertEqual((0, [], 'confirmed'), (self.site.logins, self.site.login_posts, self.screen()['state']))
        self.assertEqual(1, self.site.count('GET', '/api/me'))

    def test_real_absence_still_logs_in_automatically(self):
        self.site.account = None
        self.page.goto(h.INDEX_URL)
        self.page.wait_for_url(h.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.assertEqual((1, [], ['SYN-PROOF-1']), (self.site.logins, self.site.login_posts, self.site.entries))

    def seed(self, record):
        """An end record as auth.js keeps it (its session's own key), put once per tab before any page script."""
        self.context.add_init_script('if (!sessionStorage.getItem("syn-seeded")) { sessionStorage.setItem("syn-seeded", "1"); '
                                     'localStorage.setItem(' + json.dumps('kin-session-end:' + record['session']) + ', '
                                     + json.dumps(json.dumps(record)) + '); }')

    def test_end_record_still_needs_explicit_login(self):
        # The person's own Log out of this (still live) session is recorded: no entry by itself; Login is the
        # re-authentication of the unfinished Log out, bound to that session - never a silent re-entry.
        live = self.site.cookie
        self.seed({'session': live, 'operation': 1, 'status': 'confirmed', 'origin': 'logout'})
        self.page.goto(h.INDEX_URL)
        expect(self.page.locator('#signin')).to_be_enabled()
        self.page.wait_for_timeout(1200)
        self.assertEqual((0, 0), (self.site.logins, self.site.count('GET', '/api/me')))
        self.page.get_by_role('button', name=h.SIGN_IN).click()
        self.page.wait_for_url(h.MAIN_URL)
        self.assertEqual(([live], [{'intent': 'reauthenticate', 'reason': 'logout_unfinished'}]),
                         (self.site.login_posts, self.site.login_bodies))
        self.assertIn(live, self.site.ended)

    def test_yesterdays_logout_costs_one_login_press_and_ends_nothing(self):
        # Design section 5 case 9 (the opposite side): yesterday's explicit Log out of ANOTHER session is on record and
        # today's session is alive. As before: the landing waits for one Login press, which enters the live session - no
        # login start, nothing ended, the old record taken over.
        live = self.site.cookie
        self.seed({'session': 'SYN-SESSION-YESTERDAY', 'operation': 1, 'status': 'confirmed', 'origin': 'logout'})
        self.page.goto(h.INDEX_URL)
        expect(self.page.locator('#msg')).to_have_text(h.CONFIRMED)
        self.page.wait_for_timeout(700)
        self.assertEqual((0, 0, h.INDEX_URL), (self.site.logins, self.site.count('GET', '/api/me'), self.page.url))
        self.page.get_by_role('button', name=h.SIGN_IN).click()
        self.page.wait_for_url(h.MAIN_URL)
        expect(self.page.locator('#rows')).to_contain_text(h.PATIENT)
        self.assertEqual(([], 0, live, None), (self.site.login_posts, self.site.logins, self.site.cookie, self.screen()['end']))
        self.assertNotIn(live, self.site.ended)

    def test_no_record_or_a_server_ended_sessions_record_enters_with_no_click(self):
        # Design section 5 case 9: with no record, or with only the record of a session the SERVER ended or another
        # login replaced, a new document (the landing, the work page, a second tab) enters the live session by itself.
        for origin in (None, 'server_end', 'replaced'):
            with self.subTest(origin=origin):
                self.fresh_context()
                live = self.site.cookie
                if origin:
                    self.seed({'session': 'SYN-SESSION-OLD', 'operation': 9999999999999,
                               'status': 'confirmed' if origin == 'server_end' else 'unconfirmed', 'origin': origin})
                for url in (h.INDEX_URL, h.MAIN_URL):
                    page = self.watch(self.context.new_page())
                    page.goto(url)
                    page.wait_for_url(h.MAIN_URL)
                    expect(page.locator('#rows')).to_contain_text(h.PATIENT)
                self.assertEqual(([], 0, live), (self.site.login_posts, self.site.logins, self.site.cookie))
                self.assertNotIn(live, self.site.ended)

    def test_explicit_account_switch_still_replaces_the_live_session(self):
        self.site.me_answers = [(503, {"code": "AUTH_IDP_UNAVAILABLE"})]
        live = self.site.cookie
        self.page.goto(h.INDEX_URL)
        expect(self.page.locator('#switch')).to_be_visible()
        self.page.locator('#switch').click()
        self.page.wait_for_url(h.MAIN_URL)
        self.assertEqual(([live], [{'intent': 'reauthenticate', 'reason': 'switch_account'}]),
                         (self.site.login_posts, self.site.login_bodies))
        self.assertIn(live, self.site.ended)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(SessionEntry(name) for name in SessionEntry.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
