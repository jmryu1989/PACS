# coding: utf-8
"""FC-040 -> RISK-HELD-FOREVER (a reader who left the page holds the study; any reader cannot take an in-progress
reading back to Unread) -> the delivered split page.

The delivered page (main.html, its bundle and every shipped asset) against the synthetic origin of report_flow_dom_test;
no stack, no product file is modified. ResetSite adds what the server answers on this boundary: another reader's live
hold and saved text in the study state (`holder`, `savedBy`), the `released` facts of an in-progress reset, and the
hold heartbeat's `{ renew: true }` answer (`lost`).

Button descriptions are not pinned here; the cases assert the behaviour (enabled, sent without the reason dialog, the
four released notices told apart, the heartbeat stopped, a late answer ignored).
"""
import re
import sys
import time
import unittest

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect, sync_playwright

OTHER = "syn-rad2@synthetic.test"
THIRD = "syn-rad3@synthetic.test"
LOST = {"holder": None, "mine": False, "conflict": False, "lost": True}


class ResetSite(rf.FlowSite):
    """FlowSite plus another reader's hold and saved text, the reset's `released` answer and the renew heartbeat."""

    def __init__(self, count=3):
        super().__init__(count)
        self.holder = {}            # uid -> another reader's live hold, as the state carries it
        self.saved_by = {}          # uid -> who saved the head text, as the state carries it
        self.released = {}          # uid -> the `released` facts an in-progress reset of that study answers
        self.hold_bodies = []       # (uid, body) of every POST hold
        self.renew_answers = []     # queued answers to renew heartbeats ("hold" parks the request)
        self.held_renews = []       # parked renew routes

    def state_of(self, uid, account):
        return {**super().state_of(uid, account), "holder": self.holder.get(uid), "savedBy": self.saved_by.get(uid)}

    def commit_of(self, uid, body, account):
        status, answer = super().commit_of(uid, body, account)
        if status == 200 and body.get("action") == "reset" and uid in self.released:
            self.holder.pop(uid, None)
            self.saved_by.pop(uid, None)
            answer = {**answer, "state": self.state_of(uid, account), "released": self.released[uid]}
        return status, answer

    def api(self, route, request, method, path, query):
        found = re.fullmatch(r"/api/studies/([^/]+)/hold", path)
        if method == "POST" and found and found.group(1) in self.store:
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            body = request.post_data_json if request.post_data else None
            self.hold_bodies.append((found.group(1), body))
            self.holds.append(path)
            if isinstance(body, dict) and body.get("renew") and self.renew_answers:
                reply = self.renew_answers.pop(0)
                if reply == "hold":
                    return self.held_renews.append(route)
                return route.fulfill(json=reply)
            return route.fulfill(json={"holder": account["user"], "mine": True, "conflict": False})
        return super().api(route, request, method, path, query)

    def renews(self):
        return [body for _, body in self.hold_bodies if isinstance(body, dict) and body.get("renew")]


class ResetInProgressPage(unittest.TestCase):
    count = 4

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.site = ResetSite(self.count)
        self.context = self.browser.new_context(viewport={"width": 1400, "height": 900}, locale="ko-KR",
                                                timezone_id="Asia/Seoul")
        self.context.route("**/*", lambda route, request: self.site.handle(route, request))
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.set_default_navigation_timeout(30000)
        self.errors, self.dialogs = [], []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("dialog", lambda dialog: (self.dialogs.append(dialog.message), dialog.accept()))
        self.page.clock.install()

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.site.violations, "requests the synthetic origin does not answer")

    # ── driving the page ──
    def open(self):
        self.page.goto(h.MAIN_URL)
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)

    def select(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()
        self.wait(lambda: self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.name ?? null") == patient,
                  "the study opens")

    def wait(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}: not observed; last requests {self.site.calls[-8:]}")
            self.page.wait_for_timeout(20)

    def press_unread(self):
        """Opens the More group holding Reset to Unread as a reader does, then presses it."""
        button = self.page.locator("#b-unread")
        button.evaluate("e => { for (let d = e.closest('details'); d; d = d.parentElement.closest('details')) d.open = true; }")
        button.click()

    def resets(self):
        return [body for uid, body in self.site.flow_commits if body.get("action") == "reset"]

    def toast(self):
        return self.page.locator("#toast")

    # ── #b-unread opens for an in-progress reading of another reader ──
    def test_another_readers_live_hold_opens_reset_and_sends_it_without_the_reason_dialog(self):
        self.site.store[h.UID]["report"]["rs"] = "T"
        self.site.holder[h.UID] = OTHER
        self.site.released[h.UID] = {"holder": OTHER, "holderDraft": True, "savedBy": None, "savedKept": False}
        self.open()
        self.select(h.PATIENT)
        expect(self.page.locator("#holdbar")).to_be_visible()
        expect(self.page.locator("#b-unread")).to_be_enabled()
        # the other write controls stay locked by the hold, as before
        expect(self.page.locator("#b-approve")).to_be_disabled()
        expect(self.page.locator("#b-save")).to_be_disabled()
        self.press_unread()
        self.wait(lambda: self.resets(), "the reset is sent")
        expect(self.page.locator("#reasonmodal")).to_be_hidden()
        self.assertNotIn("reason", self.resets()[0], "the reason is the server's, not the page's")
        expect(self.toast()).to_contain_text("개인 임시글로 남아 있습니다")
        expect(self.toast()).to_contain_text("Unread로 되돌렸습니다")
        self.wait(lambda: self.page.evaluate("() => studies.find(s => s.uid === selectedUid)?.rs") == "W", "Unread")

    def test_another_readers_saved_text_with_no_hold_opens_reset_without_the_reason_dialog(self):
        self.site.store[h.UID]["report"].update({"rs": "T", "version": 1, "findings": "SYN saved by another"})
        self.site.saved_by[h.UID] = OTHER
        self.site.released[h.UID] = {"holder": None, "holderDraft": False, "savedBy": OTHER, "savedKept": True}
        self.open()
        self.select(h.PATIENT)
        expect(self.page.locator("#holdbar")).to_be_hidden()
        expect(self.page.locator("#b-unread")).to_be_enabled()
        self.press_unread()
        self.wait(lambda: self.resets(), "the reset is sent")
        expect(self.page.locator("#reasonmodal")).to_be_hidden()
        expect(self.toast()).to_contain_text("개인 임시글로 옮겼습니다")

    def test_my_own_saved_text_still_asks_for_the_reason(self):
        self.site.store[h.UID]["report"].update({"rs": "T", "version": 1, "findings": "SYN saved by me"})
        self.site.saved_by[h.UID] = h.RAD["actor"]
        self.open()
        self.select(h.PATIENT)
        self.press_unread()
        expect(self.page.locator("#reasonmodal")).to_be_visible()
        self.assertEqual([], self.resets(), "nothing is sent before a reason")

    def test_an_approved_report_held_by_another_reader_keeps_reset_disabled(self):
        self.site.store[h.UID]["report"].update({"rs": "A", "version": 1, "findings": "SYN approved"})
        self.site.holder[h.UID] = OTHER
        self.site.saved_by[h.UID] = OTHER
        self.open()
        self.select(h.PATIENT)
        expect(self.page.locator("#b-unread")).to_be_disabled()

    def test_the_four_released_notices_are_told_apart(self):
        """Each answer the server can give is pressed for on its own study through Reset to Unread; the shown notice is read."""
        cases = (  # (study, its state, the released answer, what the notice must say)
            (h.UID, h.PATIENT, {"holder": OTHER}, {"holder": OTHER, "holderDraft": True, "savedBy": None, "savedKept": False},
             "쓰던 글이 있습니다"),
            (h.UID_B, h.PATIENT_B, {"saved_by": OTHER}, {"holder": None, "holderDraft": False, "savedBy": OTHER, "savedKept": True},
             "옮겼습니다"),
            (rf.UID_C, rf.PATIENT_C, {"saved_by": OTHER},
             {"holder": None, "holderDraft": False, "savedBy": OTHER, "savedKept": False}, "그대로 두었고"),
            (rf.UID_D, rf.PATIENT_D, {"holder": OTHER, "saved_by": THIRD},
             {"holder": OTHER, "holderDraft": False, "savedBy": THIRD, "savedKept": True}, "옮겼습니다"),
        )
        for uid, _, state, released, _ in cases:
            self.site.store[uid]["report"].update({"rs": "T", "version": 1, "findings": "SYN saved"})
            if "holder" in state:
                self.site.holder[uid] = state["holder"]
            if "saved_by" in state:
                self.site.saved_by[uid] = state["saved_by"]
            self.site.released[uid] = released
        self.open()
        shown = []
        for uid, patient, _, _, says in cases:
            self.select(patient)
            sent = len(self.resets())
            self.press_unread()
            self.wait(lambda: len(self.resets()) == sent + 1, "the reset is sent")
            expect(self.page.locator("#reasonmodal")).to_be_hidden()
            expect(self.toast()).to_contain_text(says)
            expect(self.toast()).to_contain_text("Unread로 되돌렸습니다")
            shown.append(self.toast().inner_text())
        self.assertEqual(4, len(set(shown)), "each answer is told in its own words")
        self.assertIn("이력(History)", shown[2])
        # the holder and the saver are different readers: the saved text is the saver's, never put on the holder
        self.assertIn(THIRD.split("@")[0], shown[3])
        self.assertNotIn(OTHER.split("@")[0], shown[3], "the holder had no draft; the saved text is not theirs")

    def test_releasing_a_hold_with_no_text_says_only_that_the_hold_was_released(self):
        self.site.holder[h.UID] = OTHER
        self.site.released[h.UID] = {"holder": OTHER, "holderDraft": False, "savedBy": None, "savedKept": False}
        self.open()
        self.select(h.PATIENT)
        self.press_unread()
        self.wait(lambda: self.resets(), "the reset is sent")
        expect(self.toast()).to_contain_text("점유를 풀고 Unread로 되돌렸습니다")
        self.assertNotIn("임시글", self.toast().inner_text())

    # ── the heartbeat renews only its own hold ──
    def claim(self):
        self.open()
        self.select(h.PATIENT)
        self.page.locator("#findings").fill("SYN typing")
        self.wait(lambda: self.site.hold_bodies, "the hold is claimed")
        self.assertFalse(isinstance(self.site.hold_bodies[0][1], dict) and self.site.hold_bodies[0][1].get("renew"),
                         "starting to write claims; it does not renew")

    def test_heartbeat_sends_renew_and_stops_with_the_notice_when_the_hold_was_lost(self):
        self.claim()
        self.site.renew_answers = [LOST]
        self.page.clock.run_for(60001)
        self.wait(lambda: self.site.renews(), "the heartbeat renews")
        expect(self.toast()).to_contain_text("판독 점유가 풀렸습니다")
        sent = len(self.site.renews())
        self.page.clock.run_for(180001)
        self.page.wait_for_timeout(200)
        self.assertEqual(sent, len(self.site.renews()), "the heartbeat stopped")
        self.assertIsNone(self.page.evaluate("() => heldUid"))

    def test_heartbeat_keeps_renewing_while_the_hold_is_mine(self):
        self.claim()
        self.page.clock.run_for(60001)
        self.wait(lambda: len(self.site.renews()) == 1, "one renew")
        self.page.clock.run_for(60001)
        self.wait(lambda: len(self.site.renews()) == 2, "the next renew")
        self.assertNotIn("판독 점유가 풀렸습니다", self.toast().inner_text())

    def test_a_late_lost_answer_after_moving_to_another_study_is_ignored(self):
        self.claim()
        self.site.renew_answers = ["hold"]
        self.page.clock.run_for(60001)
        self.wait(lambda: self.site.held_renews, "the renew is out")
        self.select(h.PATIENT_B)
        self.site.held_renews.pop(0).fulfill(json=LOST)
        self.page.wait_for_timeout(300)
        self.assertNotIn("판독 점유가 풀렸습니다", self.toast().inner_text())


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
