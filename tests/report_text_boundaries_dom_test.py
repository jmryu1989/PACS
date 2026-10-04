# coding: utf-8
"""U5S-REQ-04/13/17/22/23 -> U5S-RISK-DRAFT/APPLY/SUCCESS -> U5CLI-F01/F02/F05/F06/F07/F08.

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
        self.bootstrap_states = None

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
        if method == "GET" and path == "/api/bootstrap" and (self.bootstrap_states is not None or "states=omit" not in query):
            states = self.bootstrap_states
            if states is None:
                states = {h.UID: self.state(h.RAD)}
                with self.study(h.UID_B):
                    states[h.UID_B] = self.state(h.RAD)
            return route.fulfill(json={"states": states, "orders": [], "filters": [], "templates": [],
                "me": {"institution": h.INSTITUTION, "institutionName": "SYN Hospital A"}, "institutions": []})
        match = re.match(r"/api/studies/([^/]+)/", path)
        uid = match.group(1) if match else h.UID
        if uid == h.UID_B:
            # Playwright may dispatch another request while fulfill yields. Restore the fixture's study before
            # yielding, so another request (or the test's next server write) cannot accidentally use B's storage.
            actions = []
            class Answer:
                deferred = True
                def __getattr__(self, name):
                    return getattr(route, name)
                def fulfill(self, **kwargs):
                    return actions.append(("fulfill", kwargs)) if self.deferred else route.fulfill(**kwargs)
                def abort(self, error_code="failed"):
                    return actions.append(("abort", {"error_code": error_code})) if self.deferred else route.abort(error_code)
            answer = Answer()
            with self.study(uid):
                result = super().api(answer, request, method, path.replace(h.UID_B, h.UID), query)
            answer.deferred = False
            for action, kwargs in actions:
                getattr(route, action)(**kwargs)
            return result
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

    def go_offline(self, elapsed=61000):
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.page.clock.run_for(elapsed)
        expect(self.page.locator("#dbstat")).to_contain_text("서버 연결 끊김")

    def test_reconnect_keeps_and_saves_unselected_offline_text(self):
        for bootstrap in ("omitted", "included"):
            with self.subTest(bootstrap=bootstrap):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.select_and_type()
                self.go_offline()
                latest = "SYN offline unselected text"
                self.page.fill("#findings", latest)
                self.switch(h.PATIENT_B)
                if bootstrap == "included":
                    self.site.bootstrap_states = {h.UID: self.site.state(h.RAD)}
                self.page.clock.run_for(16000)
                expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
                self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == latest, "A saved without reselecting")
                self.switch(h.PATIENT)
                self.assertEqual({**h.FIELDS, "findings": latest}, self.editor())
                self.assertEqual([], self.dialogs)

    def test_late_refresh_and_poll_merge_facts_without_losing_unconfirmed_text(self):
        for arrival in ("refresh", "poll", "poll with arrival"):
            with self.subTest(arrival=arrival):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.site.held_lists = []
                if arrival == "refresh":
                    self.refresh()
                else:
                    self.page.clock.run_for(31000)
                self.wait_until(lambda: self.site.held_lists, "list read held before editing")
                route, account = self.site.held_lists.pop()
                self.site.held_lists = None
                self.select_and_type()
                self.site.put_answers = ["hold"]
                self.switch(h.PATIENT_B)
                self.wait_until(lambda: self.site.held_puts, "unconfirmed A write")
                self.site.write({**h.MORE, "baseVersion": 0, "citationIds": [], "structureIds": [],
                    "expectedOwner": h.owner_of(h.RAD), "expectedRevision": "SYNEPOCH1:0"}, h.RAD)
                self.site.report.update(version=4, rs="T")
                body = self.site.list_body(account, rename="SYN PATIENT UPDATED")
                body["studies"][0]["count"] = 42
                if arrival == "poll with arrival":
                    body["studies"].append({**body["studies"][0], "uid": h.UID + ".3", "name": "SYN NEW ARRIVAL"})
                    body["studies"].sort(key=lambda row: row["uid"])
                    body["pagination"]["total"] += 1
                self.site.answer(route, 200, body)
                patient = h.PATIENT if arrival == "poll" else "SYN PATIENT UPDATED"
                row = self.page.locator("#rows tr", has_text=patient).first
                expect(row.get_by_role("cell", name="42", exact=True)).to_be_visible()
                expect(row.get_by_role("cell", name="T", exact=True)).to_be_visible()
                row.click()
                self.assertEqual(h.FIELDS, self.editor())
                self.assertEqual("SYNEPOCH1:0", self.site.puts[0]["expectedRevision"])
                self.site.finish_put()
                expect(self.page.locator("#b-draft-keep")).to_be_visible()
                self.assertEqual(h.FIELDS, self.editor())
                self.page.locator("#b-draft-keep").click()
                self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "explicitly kept A text")
                self.assertEqual((0, "SYNEPOCH1:1"),
                                 (self.site.puts[-1]["baseVersion"], self.site.puts[-1]["expectedRevision"]))

    def test_reconnect_preserves_open_conflict_and_latest_attempt(self):
        self.prepare_conflict()
        latest = "SYN conflict typed offline"
        self.go_offline(41000)
        self.page.fill("#findings", latest)
        self.switch(h.PATIENT_B)
        self.site.bootstrap_states = {h.UID: self.site.state(h.RAD)}
        puts = len(self.site.puts)
        self.page.clock.run_for(16000)
        expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
        self.assertEqual(puts, len(self.site.puts), "reconnect cannot resolve another document's conflict")
        self.assertEqual("SYN other document", self.site.stored_for(h.UID)["findings"])
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(latest)
        expect(self.page.locator("#b-draft-keep")).to_be_visible()
        self.page.locator("#b-draft-keep").click()
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == latest, "latest conflict attempt stored")

    def test_reconnect_keeps_unknown_outcome_until_authoritative_read(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["abort"]
        self.site.draft_read_answers = ["abort"] * 20
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.puts and len(self.site.draft_reads) >= 2, "A uncertain")
        self.go_offline()
        self.site.bootstrap_states = {h.UID: self.site.state(h.RAD)}
        puts = len(self.site.puts)
        self.page.clock.run_for(16000)
        expect(self.page.locator("#dbstat")).to_contain_text("DB Connected")
        self.assertEqual(puts, len(self.site.puts), "bootstrap is not an authoritative draft confirmation")
        self.switch(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())
        self.site.draft_read_answers = []
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_legacy_demo_text_never_becomes_an_authenticated_draft(self):
        self.context.add_init_script("""localStorage.setItem('kin-app', JSON.stringify({
            '""" + h.UID + """': {draft: {findings:'SYN DEMO PRIVATE', conclusion:'', recommendation:'', baseVersion:0}}
        }));""")
        self.open_main()
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value("")
        self.assertEqual([], self.site.puts)
        backups = self.page.evaluate("Object.keys(localStorage).filter(k => k.startsWith('kin-app-backup-')).map(k => localStorage[k])")
        self.assertTrue(any("SYN DEMO PRIVATE" in value for value in backups))

    def other_document_saves(self, page, text):
        page.locator("#rows tr", has_text=h.PATIENT).first.click()
        page.fill("#findings", text)
        page.locator("#rows tr", has_text=h.PATIENT_B).first.click()
        self.wait_until(lambda: self.site.stored_for(h.UID) and self.site.stored_for(h.UID)["findings"] == text,
                        "other document's draft stored", page=page)

    def test_idle_document_observes_other_drafts_without_writes_warnings_or_logout_questions(self):
        for selected in (False, True):
            with self.subTest(study_stays_selected=selected):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                a = self.open_main()
                self.switch(h.PATIENT)
                expect(a.locator("#findings")).to_be_editable()
                if not selected:
                    self.switch(h.PATIENT_B)
                b = self.watch(self.context.new_page())
                b.clock.install()
                self.open_main(b)
                sent, toasts = [], []
                a.on("request", lambda r: sent.append(r.post_data_json) if r.method == "PUT" else None)
                a.expose_function("observe_toast", lambda text: toasts.append(text))
                a.evaluate("""() => new MutationObserver(() => {
                    const node = document.querySelector('#toast');
                    if (node.textContent.trim()) window.observe_toast(node.textContent);
                }).observe(document.querySelector('#toast'), {childList:true, subtree:true, characterData:true})""")
                self.other_document_saves(b, "SYN other v1")
                self.refresh(a)
                a.wait_for_timeout(150)
                self.other_document_saves(b, "SYN other v2")
                for _ in range(4):
                    a.clock.run_for(21000)
                    a.wait_for_timeout(150)
                cancelled = a.evaluate("""() => {
                    const e = new Event('beforeunload', {cancelable:true});
                    window.dispatchEvent(e); return e.defaultPrevented;
                }""")
                self.assertFalse(cancelled, "server observations must not prompt on leaving")
                self.switch(h.PATIENT)
                expect(a.locator("#findings")).to_have_value("SYN other v2")
                self.assertEqual(([], []), (sent, toasts))
                self.log_out_main(a)
                a.wait_for_url(h.INDEX_URL)
                self.assertEqual(([], [], 1), (sent, self.dialogs, len(self.site.logouts)))

    def test_observed_draft_is_the_baseline_of_the_next_real_edit(self):
        self.page.clock.install()
        a = self.open_main()
        self.switch(h.PATIENT)
        self.switch(h.PATIENT_B)
        b = self.watch(self.context.new_page())
        b.clock.install()
        self.open_main(b)
        self.other_document_saves(b, "SYN server v1")
        self.refresh(a)
        self.other_document_saves(b, "SYN server v2")
        self.refresh(a)
        self.switch(h.PATIENT)
        expect(a.locator("#findings")).to_have_value("SYN server v2")
        a.fill("#findings", "SYN my first edit after observation")
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"] == "SYN my first edit after observation",
                        "new edit saved on observed revision")
        self.assertEqual("SYNEPOCH1:2", self.site.puts[-1]["expectedRevision"])
        self.assertEqual([], self.dialogs)

    def test_real_edit_in_otherwise_idle_document_keeps_its_conflict_and_text(self):
        self.page.clock.install()
        a = self.open_main()
        self.select_and_type()
        self.site.put_answers = [(500, {"message": "SYN refused"})]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "local switch write refused")
        b = self.watch(self.context.new_page())
        b.clock.install()
        self.open_main(b)
        self.other_document_saves(b, "SYN other v1")
        self.refresh(a)
        self.other_document_saves(b, "SYN other v2")
        for _ in range(3):
            a.clock.run_for(21000)
            a.wait_for_timeout(150)
        self.switch(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())
        expect(a.locator("#b-draft-keep")).to_be_visible()
        self.assertEqual("SYN other v2", self.site.stored_for(h.UID)["findings"])
        self.switch(h.PATIENT_B)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(a.locator("dialog.kin-logout")).to_contain_text(h.PATIENT)
        self.assertEqual([], self.site.logouts)
        self.panel_button("Overwrite Server Draft").click()
        a.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_version_conflict_load_latest_replaces_text_and_next_save_base(self):
        self.context.add_init_script(h.CLIPBOARD)
        self.open_main()
        self.select_and_type()
        self.site.report = {"version": 1, "rs": "T", "findings": "SYN server report v1",
                            "conclusion": "", "recommendation": ""}
        self.site.commit_answers = [(409, {"message": "그 사이 다른 사용자가 저장했습니다 (v1)"})]
        self.dialog_answers = [True]
        self.page.locator("#b-save").click()
        expect(self.page.locator("#findings")).to_have_value("SYN server report v1")
        self.assertEqual("\n\n".join(h.FIELDS.values()), self.page.evaluate("window.__synClipboard.written[0].text"))
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 2, "next Save")
        self.assertEqual((1, "SYN server report v1"),
                         (self.site.commits[-1]["baseVersion"], self.site.commits[-1]["findings"]))

    def test_load_server_draft_replaces_conflict_and_does_not_resend_discarded_text(self):
        self.prepare_conflict()
        self.site.report.update(version=2, rs="T", findings="SYN final v2")
        self.site.rows[h.RAD["actor"]]["baseVersion"] = 2
        self.page.locator("#b-draft-load").click()
        expect(self.page.locator("#findings")).to_have_value("SYN other document")
        expect(self.page.locator("#b-draft-keep")).not_to_be_visible()
        puts = len(self.site.puts)
        self.page.clock.run_for(21000)
        self.assertEqual(puts, len(self.site.puts))
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.commits, "Save after server replacement")
        self.assertEqual((2, "SYN other document"),
                         (self.site.commits[-1]["baseVersion"], self.site.commits[-1]["findings"]))

    def test_discard_draft_takes_server_report_version(self):
        self.open_main()
        self.select_and_type()
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "draft saved")
        self.switch(h.PATIENT)
        self.site.report.update(version=3, rs="T", findings="SYN final v3")
        self.dialog_answers = [True]
        self.page.locator("#b-draft-discard").click()
        expect(self.page.locator("#findings")).to_have_value("SYN final v3")
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.commits, "Save after discard")
        self.assertEqual(3, self.site.commits[-1]["baseVersion"])

    def test_logout_saves_second_study_and_only_offers_first_failure(self):
        for action in ("Retry", "Discard and Log Out"):
            with self.subTest(action=action):
                self.fresh_context()
                self.site = MultiStudySite()
                self.open_main()
                self.select_and_type()
                self.site.put_answers = [(500, {"message": "SYN refused"})] * 2
                self.switch(h.PATIENT_B)
                self.wait_until(lambda: len(self.site.puts) == 1, "A refused")
                self.page.fill("#findings", "SYN B safe")
                self.log_out_main()
                expect(self.panel_title()).to_have_text("Draft Not Saved")
                self.assertEqual({"findings": "SYN B safe", "conclusion": "", "recommendation": ""},
                                 self.site.stored_for(h.UID_B))
                panel = self.page.locator("dialog.kin-logout")
                expect(panel).to_contain_text(h.PATIENT)
                expect(panel).not_to_contain_text(h.PATIENT_B)
                expect(panel).to_contain_text("받아들이지 않았습니다")
                self.assertEqual(3, len(self.site.puts))
                if action == "Discard and Log Out":
                    self.dialog_answers = [True]
                self.panel_button(action).click()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual("SYN B safe", self.site.stored_for(h.UID_B)["findings"])
                self.assertEqual(1, sum(p["findings"] == "SYN B safe" for p in self.site.puts))
                if action == "Retry":
                    self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))
                else:
                    self.assertIsNone(self.site.stored_for(h.UID))
                    self.assertIn("1건", self.dialogs[-1])
                    self.assertIn(h.PATIENT, self.dialogs[-1])
                    self.assertNotIn(h.PATIENT_B, self.dialogs[-1])

    def test_logout_lists_each_remaining_study_with_its_own_reason(self):
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [(500, {"message": "SYN refused"})] * 2 + [
            (409, {"code": "REPORT_HELD", "message": "SYN held"})]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "A refused")
        self.page.fill("#findings", "SYN B held")
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        lines = self.page.locator("dialog.kin-logout").inner_text().splitlines()
        self.assertTrue(any(h.PATIENT in line and "받아들이지 않았습니다" in line for line in lines))
        self.assertTrue(any(h.PATIENT_B in line and "다른 판독의" in line for line in lines))
        self.assertEqual((3, []), (len(self.site.puts), self.site.logouts))

    def test_refused_command_without_typing_still_requires_confirmation_before_leaving(self):
        self.page.clock.install()
        self.site.report.update(findings="SYN report already on server")
        self.open_main()
        self.switch(h.PATIENT)
        self.site.commit_answers = [(500, {"message": "SYN commit refused"})]
        self.page.locator("#b-save").click()
        expect(self.page.locator("#toast")).to_contain_text("SYN commit refused")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID), "command's text confirmed")
        cancelled = self.page.evaluate("""() => {
            const e = new Event('beforeunload', {cancelable:true});
            window.dispatchEvent(e); return e.defaultPrevented;
        }""")
        self.assertFalse(cancelled, "exact confirmation clears the command mark")
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual({"findings": "SYN report already on server", "conclusion": "", "recommendation": ""},
                         self.site.stored_for(h.UID))


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReportTextBoundaries(name) for name in ReportTextBoundaries.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
