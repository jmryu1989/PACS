"""U5S-REQ-08/13/15/17 -> RISK-LOST-TEXT/STALE-DRAFT -> real report page.

No source slicing: serve main.html and every shipped asset. Reuse the wire server
from the already migrated logout suite; all routes are intercepted, with no live stack.
These cases complement the detailed citation/cursor/structure component scenarios.
"""
import os
import time
import unittest
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
import auth_logout_dom_test as auth


class ReportSite(auth.Site):
    def __init__(self):
        super().__init__()
        self.arrival = False
        self.held_patches = []

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        if self.arrival:
            body['studies'].append(self.study_row(account, auth.UID_B.rsplit('.', 1)[0] + '.3',
                                                 'SYN PATIENT CHARLIE', 'SYN-P-003'))
            body['pagination']['total'] += 1
        return body

    def api(self, route, request, method, path, query):
        if method == 'GET' and path == '/api/studies' and not query:
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return route.fulfill(json=self.list_body(account))
        if method == 'PATCH' and path == '/api/studies/' + auth.UID:
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            self.held_patches.append((route, request.post_data_json, account))
            return
        return super().api(route, request, method, path, query)

    def finish_patch(self, status=200):
        route, patch, account = self.held_patches.pop(0)
        self.answer(route, status, {**self.state(account), **patch} if status == 200
                    else {'message': 'SYN refused metadata change'})

    def write(self, body, account):
        status, answer = super().write(body, account)
        if status == 200 and body.get("insert"):
            inserted = {**body["insert"], "cid": "SYN-CITATION-1", "insertedBy": account["actor"],
                        "insertedAt": "2026-10-04T00:00:00.000Z"}
            self.rows[account["actor"]]["citations"].append(inserted["cid"])
            answer = {**self.envelope(account), "inserted": inserted}
        if status == 200 and body.get('structure'):
            self.rows[account['actor']]['structured'].append('SYN-STRUCTURE-1')
            answer = {**self.envelope(account), 'applied': {
                'sid': 'SYN-STRUCTURE-1', 'field': body['structure']['field'],
                'enteredAt': '2026-10-04T00:00:00.000Z'}}
        return status, answer


class ReportSessionPageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ReportSite()
        self.site.second_study = True
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900})
        self.errors, self.dialogs = [], []
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("dialog", lambda d: (self.dialogs.append(d.message), d.dismiss()))
        self.page.clock.install()
        self.page.goto(auth.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(auth.PATIENT)

    def route(self, route, request):
        # Mutants are copies outside the product tree, served only for this test.
        override = os.environ.get("KIN_REPORT_PAGE_MAIN")
        if override and request.url == auth.MAIN_URL:
            return route.fulfill(body=Path(override).read_bytes(), content_type="text/html")
        return self.site.handle(route, request)

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors)
        self.assertEqual([], self.site.violations)

    def wait(self, predicate):
        until = time.monotonic() + 5
        while not predicate():
            if time.monotonic() > until:
                self.fail("server outcome not observed: " + repr(self.site.calls[-8:]))
            self.page.wait_for_timeout(20)

    def type_report(self, fields=auth.FIELDS):
        self.page.locator("#rows tr", has_text=auth.PATIENT).first.click()
        for key, value in fields.items():
            self.page.locator("#" + key).fill(value)

    def assert_text(self, fields=auth.FIELDS):
        for key, value in fields.items():
            expect(self.page.locator("#" + key)).to_have_value(value)

    def test_normal_autosave_is_bound_and_saves_every_field_without_a_dialog(self):
        self.type_report()
        self.page.clock.run_for(20001)
        self.wait(lambda: self.site.stored() == auth.FIELDS)
        self.assert_text()
        self.assertEqual([self.site.cookie], self.site.put_sessions)
        self.assertEqual("SYNEPOCH1:0", self.site.puts[0]["expectedRevision"])
        self.assertEqual([], self.dialogs)

    def test_a_held_save_and_later_typing_are_serial_and_keep_the_newer_text(self):
        self.type_report()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(20001)
        self.wait(lambda: len(self.site.held_puts) == 1)
        for key, value in auth.MORE.items():
            self.page.locator("#" + key).fill(value)
        self.page.clock.run_for(1000)
        self.assertEqual(1, len(self.site.puts))
        self.site.finish_put()
        self.wait(lambda: self.site.stored() == auth.FIELDS)
        self.assert_text(auth.MORE)
        self.page.clock.run_for(20001)
        self.wait(lambda: self.site.stored() == auth.MORE)
        self.assert_text(auth.MORE)
        self.assertEqual(["SYNEPOCH1:0", "SYNEPOCH1:1"], [p["expectedRevision"] for p in self.site.puts])
        self.assertEqual([], self.dialogs)

    def test_one_logout_click_waits_for_the_save_and_ends_automatically(self):
        self.type_report()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(20001)
        self.wait(lambda: len(self.site.held_puts) == 1)
        self.page.locator("#logout").click()
        self.assertEqual([], self.site.logouts)
        self.assertEqual([], self.dialogs)
        self.site.finish_put()
        self.wait(lambda: len(self.site.logouts) == 1)
        expect(self.page).to_have_url(auth.INDEX_URL)
        self.assertEqual(auth.FIELDS, self.site.stored())

    def test_another_documents_newer_draft_is_not_overwritten_and_local_text_stays(self):
        self.type_report()
        self.site.revs[auth.RAD["actor"]] = 1
        self.site.rows[auth.RAD["actor"]] = {**auth.MORE, "baseVersion": 0, "citations": [], "structured": []}
        self.page.clock.run_for(20001)
        self.wait(lambda: bool(self.site.draft_reads) and bool(self.site.puts))
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        self.assert_text()
        self.assertEqual(auth.MORE, self.site.stored())
        self.assertEqual(1, len(self.site.puts))

    def test_one_logout_event_waits_for_the_citation_and_preserves_it_exactly_once(self):
        self.type_report()
        block = "SYN cited finding"
        # Exercise the module's page callback; the detailed finding-picker UI has its own suite.
        self.assertTrue(self.page.evaluate("request => openCitePreview(request)", {
            "uid": auth.UID, "findingId": "SYN-FINDING", "findingRevision": 1, "sourceIndex": 0,
            "sourceLabel": "SYN source", "linkState": "current", "headRevision": None, "block": block}))
        self.site.put_answers = ["hold"]
        self.page.locator("#cite-preview-insert").click()
        self.wait(lambda: len(self.site.held_puts) == 1)
        # The busy modal covers the pointer target; dispatch the same single logout activation.
        self.page.locator("#logout").dispatch_event("click")
        self.assertEqual([], self.site.logouts)
        self.assertEqual([], self.dialogs)
        self.site.finish_put()
        self.wait(lambda: len(self.site.logouts) == 1)
        expect(self.page).to_have_url(auth.INDEX_URL)
        self.assertEqual({**auth.FIELDS, "findings": auth.FIELDS["findings"] + "\n" + block}, self.site.stored())
        self.assertEqual(["SYN-CITATION-1"], self.site.rows[auth.RAD["actor"]]["citations"])
        self.assertEqual(1, sum(bool(p.get("insert")) for p in self.site.puts))

    def test_a_plain_401_is_a_failed_request_and_keeps_the_document_and_text(self):
        self.type_report()
        self.site.put_answers = [(401, {"message": "synthetic request refusal"})]
        self.page.clock.run_for(20001)
        self.wait(lambda: bool(self.site.puts))
        expect(self.page.locator("#toast")).to_contain_text("서버 저장 실패")
        self.assert_text()
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"))
        self.assertEqual([], self.site.logouts)
        self.assertEqual([], self.dialogs)

    def prepare_two_studies(self):
        expect(self.page.locator('#rows')).to_contain_text(auth.PATIENT_B)
        self.type_report()

    def begin_metadata_change(self, kind):
        # Invoke the real menu actions; delay their wire answer until the doctor is in B.
        # No editor/appState/model replacement: the entire shipped page performs the merge.
        if kind == 'tele':
            self.page.evaluate('uid => { void setTs(uid, "cancelled"); }', auth.UID)
        else:
            self.page.evaluate('uid => setSs(uid, "Unverified")', auth.UID)
        self.wait(lambda: len(self.site.held_patches) == 1)

    def unconfirmed_study_survives(self, update):
        self.prepare_two_studies()
        if update in ('patch', 'refused-patch', 'tele'):
            self.begin_metadata_change(update)
        self.site.put_answers = [(503, {'code': 'REPORT_DRAFT_UNAVAILABLE', 'message': 'SYN'})]
        self.page.locator('#rows tr', has_text=auth.PATIENT_B).first.click()
        expect(self.page.locator('#clinical')).to_contain_text(auth.PATIENT_B)
        self.wait(lambda: len(self.site.puts) == 1)
        expect(self.page.locator('#toast')).to_contain_text('서버 저장 실패')
        self.assertIsNone(self.site.stored())
        lists = self.site.count('GET', '/api/studies')
        if update == 'refresh':
            self.page.locator('#refresh').click()
        elif update == 'arrival':
            self.site.arrival = True
            self.page.clock.run_for(30001)
            expect(self.page.locator('#rows')).to_contain_text('SYN PATIENT CHARLIE')
        else:
            self.site.finish_patch(403 if update == 'refused-patch' else 200)
        if update in ('refresh', 'arrival', 'refused-patch'):
            self.wait(lambda: self.site.count('GET', '/api/studies') > lists)
        # Waiting for the accepted/refused action to repaint prevents a late answer after selection.
        if update in ('patch', 'tele'):
            expect(self.page.locator('#rows tr', has_text=auth.PATIENT).first).to_contain_text(
                'Unverified' if update == 'patch' else 'cancelled', ignore_case=True)
        self.page.locator('#rows tr', has_text=auth.PATIENT).first.click()
        expect(self.page.locator('#clinical')).to_contain_text(auth.PATIENT)
        self.assert_text()
        self.page.clock.run_for(20001)
        self.wait(lambda: self.site.stored() == auth.FIELDS)
        self.assertEqual(auth.FIELDS, {k: self.site.puts[-1][k] for k in auth.FIELDS})
        self.assertEqual(0, self.site.puts[-1]['baseVersion'])
        self.assertEqual('SYNEPOCH1:0', self.site.puts[-1]['expectedRevision'])

    def test_refresh_in_b_preserves_unconfirmed_a_and_its_next_save(self):
        self.unconfirmed_study_survives('refresh')

    def test_arrival_poll_in_b_preserves_unconfirmed_a_and_its_next_save(self):
        self.unconfirmed_study_survives('arrival')

    def test_metadata_answer_in_b_preserves_unconfirmed_a_and_its_next_save(self):
        self.unconfirmed_study_survives('patch')

    def test_refused_metadata_reload_in_b_preserves_unconfirmed_a_and_its_next_save(self):
        self.unconfirmed_study_survives('refused-patch')

    def test_tele_answer_in_b_preserves_unconfirmed_a_and_its_next_save(self):
        self.unconfirmed_study_survives('tele')

    def selected_versions_survive(self, update):
        if update == 'arrival':
            # Type after the first empty autosave tick, so the poll precedes the next save.
            self.page.clock.run_for(20001)
        self.type_report()
        # Another document advances the server after this screen has shown version/revision 0.
        self.site.report.update(version=7, rs='T')
        self.site.revs[auth.RAD['actor']] = 3
        self.site.rows[auth.RAD['actor']] = {**auth.MORE, 'baseVersion': 7, 'citations': [], 'structured': []}
        lists = self.site.count('GET', '/api/studies')
        if update == 'refresh':
            self.page.locator('#refresh').click()
            self.wait(lambda: self.site.count('GET', '/api/studies') > lists)
        elif update == 'arrival':
            self.site.arrival = True
            self.page.clock.run_for(10001)
            expect(self.page.locator('#rows')).to_contain_text('SYN PATIENT CHARLIE')
        else:
            self.begin_metadata_change(update)
            self.site.finish_patch(403 if update == 'refused-patch' else 200)
            if update == 'refused-patch':
                self.wait(lambda: self.site.count('GET', '/api/studies') > lists)
        self.assert_text()
        sent = len(self.site.puts)
        self.page.clock.run_for(20001)
        self.wait(lambda: len(self.site.puts) > sent)
        body = self.site.puts[-1]
        self.assertEqual((0, 'SYNEPOCH1:0'), (body['baseVersion'], body['expectedRevision']))
        self.assertEqual(auth.FIELDS, {k: body[k] for k in auth.FIELDS})
        self.assertEqual(auth.MORE, self.site.stored(), 'the stale write must not overwrite the other document')

    def test_refresh_preserves_the_selected_screens_version_and_revision(self):
        self.selected_versions_survive('refresh')

    def test_arrival_preserves_the_selected_screens_version_and_revision(self):
        self.selected_versions_survive('arrival')

    def test_metadata_answer_preserves_the_selected_screens_version_and_revision(self):
        self.selected_versions_survive('patch')

    def test_refused_metadata_reload_preserves_the_selected_screens_version_and_revision(self):
        self.selected_versions_survive('refused-patch')

    def test_tele_answer_preserves_the_selected_screens_version_and_revision(self):
        self.selected_versions_survive('tele')


if __name__ == "__main__":
    unittest.main(verbosity=2)
