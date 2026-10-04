# coding: utf-8
"""U5S-REQ-04/13/17/22/23 -> U5S-RISK-DRAFT/APPLY/SUCCESS -> U5CLI-F01/F02/F05.

Real pages and public controls, using the existing DOM harness read-only. The fixture adds
independent stored drafts for study B; no product function is replaced or inspected.
"""
import contextlib
import re
import unittest

import auth_logout_dom_test as h
from playwright.sync_api import expect


class MultiStudySite(h.Site):
    def __init__(self):
        super().__init__()
        self.second_study = True
        self.current_uid = h.UID
        self.other_state = ({}, {}, {"version": 0, "rs": "W"})

    @contextlib.contextmanager
    def study(self, uid):
        previous = self.current_uid
        swap = uid != previous
        if swap:
            current = (self.revs, self.rows, self.report)
            self.revs, self.rows, self.report = self.other_state
            self.other_state = current
            self.current_uid = uid
        try:
            yield
        finally:
            if swap:
                current = (self.revs, self.rows, self.report)
                self.revs, self.rows, self.report = self.other_state
                self.other_state = current
                self.current_uid = previous

    def envelope(self, account):
        return {**super().envelope(account), "uid": self.current_uid}

    def study_row(self, account, uid=h.UID, name=h.PATIENT, patient="SYN-P-001"):
        with self.study(uid):
            row = super().study_row(account, uid, name, patient)
            row["state"] = self.state(account)
            return row

    def api(self, route, request, method, path, query):
        match = re.match(r"/api/studies/([^/]+)/", path)
        uid = match.group(1) if match else h.UID
        if uid == h.UID_B:
            with self.study(uid):
                return super().api(route, request, method, path.replace(h.UID_B, h.UID), query)
        return super().api(route, request, method, path, query)

    def stored_for(self, uid):
        with self.study(uid):
            return self.stored()


class ReportTextBoundaries(h.LogoutDOMTest):
    def setUp(self):
        super().setUp()
        self.site = MultiStudySite()

    def switch(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()

    def prepare_conflict(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.write({"findings": "SYN other document", "conclusion": "", "recommendation": "",
                         "baseVersion": 0, "citationIds": [], "structureIds": [],
                         "expectedOwner": h.owner_of(h.RAD), "expectedRevision": "SYNEPOCH1:0"}, h.RAD)
        self.page.clock.run_for(21000)
        expect(self.page.locator("#b-draft-keep")).to_be_visible()

    def test_held_write_of_a_and_unsent_b_finish_on_one_logout_click(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.held_puts, "A write")
        self.page.fill("#findings", "SYN B latest")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Saving Draft")
        self.page.wait_for_timeout(300)
        self.assertEqual([], self.site.logouts)
        self.site.finish_put()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))
        self.assertEqual("SYN B latest", self.site.stored_for(h.UID_B)["findings"])
        self.assertEqual((1, []), (len(self.site.logouts), self.dialogs))

    def test_unknown_previous_study_is_named_and_retained_until_retry(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["abort"]
        self.site.draft_read_answers = ["abort"] * 10
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.draft_reads) >= 2, "uncertain A read")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.PATIENT)
        self.assertEqual(([], None), (self.site.logouts, self.site.stored_for(h.UID)))
        self.site.draft_read_answers = []
        self.panel_button("Retry").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_refused_previous_study_survives_back_to_editing(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(403, {"code": "SYN_REFUSED"})] * 2
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "refused A write")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        self.assertEqual([], self.site.logouts)
        self.panel_button("Back to Editing").click()
        self.switch(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())

    def test_conflicted_previous_study_needs_explicit_choice(self):
        self.prepare_conflict()
        self.page.fill("#findings", "SYN latest after conflict")
        self.switch(h.PATIENT_B)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        self.assertEqual([], self.site.logouts)
        self.panel_button("Overwrite Server Draft").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual("SYN latest after conflict", self.site.stored_for(h.UID)["findings"])

    def test_session_end_recovers_all_studies_for_each_unconfirmed_outcome(self):
        for outcome in ("hold", "abort", "refused", "conflict"):
            with self.subTest(outcome=outcome):
                self.fresh_context()
                self.site = MultiStudySite()
                if outcome == "conflict":
                    self.prepare_conflict()
                else:
                    self.open_main()
                    self.select_and_type()
                    self.site.put_answers = [(403, {"code": "SYN_REFUSED"})] if outcome == "refused" else [outcome]
                    if outcome == "abort":
                        self.site.draft_read_answers = ["abort"]
                self.switch(h.PATIENT_B)
                self.wait_until(lambda: self.site.puts, "A write")
                self.page.fill("#findings", "SYN B recovery")
                self.site.ended.add(self.site.cookie)
                if outcome == "hold":
                    self.site.refuse(self.site.held_puts.pop()[0], 401, "AUTH_SESSION_ENDED")
                else:
                    self.page.evaluate("""session => {
                      const channel = new BroadcastChannel('kin-session');
                      channel.postMessage({type:'session-ended',session,operation:1,status:'ending'}); channel.close();
                    }""", self.site.cookie)
                expect(self.panel_title()).to_have_text("Session Ended")
                expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
                expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID_B)
                expect(self.page.locator("dialog.kin-logout")).not_to_contain_text(h.PATIENT)
                self.assertEqual([], self.site.logouts)
                self.site.account = h.RAD
                self.panel_button("Recover Draft").click()
                if outcome == "conflict":
                    self.panel_button("Overwrite Server Draft").click()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))
                self.assertEqual("SYN B recovery", self.site.stored_for(h.UID_B)["findings"])
                self.assertNotIn(self.site.cookie, self.site.ended)

    def test_conflict_then_typing_switch_and_keep_sends_latest_text(self):
        self.prepare_conflict()
        latest = "SYN latest typed after conflict"
        self.page.fill("#findings", latest)
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(latest)
        self.page.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == latest, "latest text stored")
        self.assertEqual(latest, self.site.puts[-1]["findings"])
        self.assertEqual([], self.dialogs)

    def test_offline_typing_survives_study_change_and_cannot_be_logged_out_as_saved(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.page.clock.run_for(61000)
        expect(self.page.locator("#dbstat")).to_contain_text("서버 연결 끊김")
        latest = "SYN typed offline"
        self.page.fill("#findings", latest)
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(latest)
        expect(self.page.locator("#draftmsg")).not_to_contain_text("자동 저장됨")
        self.switch(h.PATIENT_B)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        self.assertEqual([], self.site.logouts)
        self.assertNotEqual(latest, self.site.stored_for(h.UID)["findings"])

    def test_insertion_defers_sending_but_keeps_subsequent_typing(self):
        self.open_main()
        for part in ("citations", "structure"):
            self.site.gets[f"/api/studies/{h.UID}/report/{part}"] = (200, {
                "version": 0, "draftRevision": "SYNEPOCH1:0", "head": [], "draft": []})
        self.select_and_type()
        self.page.locator("#report-more > summary").click()
        self.page.locator("#b-structured").click()
        self.page.locator("#struct-value-text").fill("SYN technique")
        self.site.put_answers = ["hold"]
        self.page.locator("#struct-apply").click()
        self.wait_until(lambda: self.site.held_puts, "structured insertion")
        # The busy non-modal insertion panel may cover the fields; dispatch real input and row controls.
        latest = "SYN typed while insertion is out"
        self.page.locator("#findings").evaluate("(el, text) => { el.value=text; el.dispatchEvent(new Event('input',{bubbles:true})); }", latest)
        self.page.locator("#rows tr", has_text=h.PATIENT_B).first.evaluate("el => el.click()")
        self.page.locator("#rows tr", has_text=h.PATIENT).first.evaluate("el => el.click()")
        expect(self.page.locator("#findings")).to_have_value(latest)
        self.assertEqual(1, len(self.site.puts), "study switching must not send over the pending insertion")
        self.site.finish_put(status=503)
        self.page.wait_for_timeout(100)
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(latest, self.site.stored_for(h.UID)["findings"])

    def test_conflict_clear_keeps_the_empty_edit_on_study_change(self):
        self.prepare_conflict()
        for field in h.FIELDS:
            self.page.fill("#" + field, "")
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        self.assertEqual(dict.fromkeys(h.FIELDS, ""), self.editor())
        self.page.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored_for(h.UID) is None, "explicit empty draft")

    def test_unselected_text_warns_before_navigation_away(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(403, {"code": "SYN_REFUSED"})]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.puts, "A refused")
        # Observe the browser event contract without destroying the captured document.
        cancelled = self.page.evaluate("""() => {
          const event = new Event('beforeunload', {cancelable: true});
          window.dispatchEvent(event); return event.defaultPrevented;
        }""")
        self.assertTrue(cancelled)

    def test_demo_navigation_still_keeps_its_local_draft(self):
        self.context.add_init_script("sessionStorage.setItem('kin-demo','1')")
        self.page.goto(h.MAIN_URL)
        self.page.locator("#rows tr", has_text="KIM CHULSOO").first.click()
        self.page.fill("#findings", "SYN demo local draft")
        self.page.evaluate("window.dispatchEvent(new Event('beforeunload', {cancelable:true}))")
        drafts = self.page.evaluate("Object.values(JSON.parse(localStorage.getItem('kin-app'))).map(row => row.draft)")
        self.assertTrue(any(d and d.get('findings') == 'SYN demo local draft' for d in drafts))
        self.assertEqual([], self.site.puts)

    def test_two_documents_have_distinct_preparations_and_matching_resume(self):
        self.open_main()
        self.select_and_type()
        other = self.open_main(self.watch(self.context.new_page()))
        self.select_and_type(other, fields=h.MORE)
        self.site.put_answers = ["hold", "hold"]
        self.log_out_main()
        self.wait_until(lambda: len(self.site.held_puts) == 1, "first preparation")
        self.log_out_main(other)
        self.wait_until(lambda: len(self.site.held_puts) == 2, "second preparation")
        first = next(p for p in self.posts() if p["type"] == "session-preparing")
        second = next(p for p in self.posts(other) if p["type"] == "session-preparing")
        self.assertNotEqual(first["preparation"], second["preparation"])
        self.assertEqual(first["session"], second["session"])
        self.panel_button("Back to Editing").click()
        resumed = next(p for p in self.posts() if p["type"] == "session-resumed")
        self.assertEqual(first["preparation"], resumed["preparation"])
        self.assertNotEqual(second["preparation"], resumed["preparation"])
        self.assertEqual("preparing", self.screen(other)["state"])


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReportTextBoundaries(name) for name in ReportTextBoundaries.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
