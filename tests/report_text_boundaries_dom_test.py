# coding: utf-8
"""U5S-REQ-04/13/17/22/23 -> U5S-RISK-DRAFT/APPLY/SUCCESS -> U5CLI-F01/F02/F05/F06/F07/F08/F09/F10/F11, U5VW-F03/F07/F11 (main's half).

Real pages and public controls, using the existing DOM harness read-only. The fixture adds
independent stored drafts for study B; no product function is replaced or inspected.

Round 4 (U5CLI-F09/F10): text that this document's own controls put into the report editor (Paste, Clear, a template,
its shortcut, a dictation, a structured line, a quoted finding) is kept and saved - or asked about - like typed text;
a command that changes no text of this document (a refused or unconfirmed Approve, Save or Discard Draft, a refused
insertion) writes nothing and asks nothing; text typed while a save is out is not confirmed by that save; a study the
server no longer accepts is announced once and its text kept.
Round 5 (U5VW-F07/F11, main's half): the logout preparation's contract with viewer documents is two Web Locks, not a
timer - `kin-preparation:<id>` held from before the pause notice until Back to Editing (or the document's unload), and
`kin-session-ended:<session>` asked for before every end notice. The cases read the browser's own lock manager from
another document (`navigator.locks.query()`), and the order of lock requests, grants and notices inside the document.
Text typed while a Save or Approve is out stays when the server accepts that command.
Round 6 (U5CLI-F11): that kept text is not part of the approved report, and the screen says so - in the notice of the
approval (naming the study when the reader has left it), and in a state of the draft bar of its own that is derived
from recorded facts (an approved report, my draft, different text) and therefore shows again after a study change, in
a new document and on a later day. The bar names only confirming controls that can be pressed; View Approved Report
shows the approved text as the server has it; the text goes into the report only by the reader's own Addendum, or
away by Discard Draft. The ordinary path (nothing typed after the press) keeps its one notice and no bar. A lock
request that throws or is rejected leaves Log out pressable; a busy session store (409) does not stop the autosave.
The wording asserted is the part the unit's instruction fixed (the approved report "does not contain" the text; the
English control names of AGENTS section 4), not whole sentences.
Round 7 (closure audit 2026-10-05; draft claims 1-3, A020, A021): a draft write that waited behind a Save, an Approve
or a Discard Draft is decided when its turn comes - the text just committed or discarded is not stored again as a
draft (answer received or lost), and text typed after the press is; the answer of Discard Draft does not wipe text
typed after the press; a Save whose answer was lost is looked up on the server before anything is written (autosave,
leaving, Log out, pressing Save again, Recover Draft) and a Save that never arrived keeps its text; Recover Draft goes
on past a study the server refuses. Each case reads the stub server's stored draft row at the end and what the reader
sees on coming back (same document, after a list read, a new document).
Round 8 (A006, A015): Log out asks about unsaved work outside the report draft (a viewer's marks, finding text, Job
edits, its Tech Note - review DR-F01; a dictation in review) in the same panel, only when a document of the session declares some - nothing is asked,
posted or waited for otherwise, a closed window and another session's document count for nothing, and Back to Editing
discards nothing; the viewer window the list opens is handed the list's session by its window name, and a viewer that
stopped at its entry is read again when opened from the list.
Stand-ins added for rounds 7-8, named: a held or lost Discard Draft, a Save / Approve the server commits without the
answer arriving, a failing read of the study states, the viewer document the list opens (/ohif/viewer; its first
script takes the hand-over as config/ohif.js does), and a viewer document's side of the unsaved-work contract (the
`kin-unsaved:` lock and the answer to `session-work-query`, as viewer-session.js does; the real one is exercised in
tests/viewer_session_dom_test.py).
Stand-ins added here, named: the clipboard (the harness's), the media devices of a dictation (an audio context, a
worklet node and a microphone stream - nothing else of the browser), the server's answers for a dictation, a
findings list, an insertion and a discard, a blank same-origin document standing in for a viewer, a recorder of
the calls a document makes to the lock manager and the session channel, the server's version history (its head
version) and its acceptance of an Addendum, and a lock manager that is missing, throws or rejects.
"""
import contextlib
import re
import unittest

import auth_logout_dom_test as h
from playwright.sync_api import expect

# The media devices a dictation records from. The capture ends with a short silent PCM buffer when Stop is pressed.
MEDIA = """(() => {
  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    async resume() {}
    async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class FakeWorkletNode {
    constructor() {
      const node = this;
      this.port = { onmessage: null, close() {}, postMessage(message) {
        if (message && message.type === 'stop') Promise.resolve().then(() => node.port.onmessage &&
          node.port.onmessage({ data: { type: 'pcm', buffer: new Uint8Array(3200).buffer } }));
      } };
    }
    connect() {}
    disconnect() {}
  }
  const stream = () => {
    const track = { readyState: 'live', addEventListener() {}, removeEventListener() {}, stop() { this.readyState = 'ended'; } };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  Object.defineProperty(window, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, writable: true, value: FakeWorkletNode });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream() } });
})();"""
DICTATION = {"available": True, "maxBytes": 1048576, "timeoutMs": 30000, "languagePin": "ko", "enginePin": "SYN-ENGINE",
             "modelPin": "SYN-MODEL"}
DICTATED = "SYN dictated sentence."
TEMPLATE = {"title": "SYN TEMPLATE", "shortcut": "synsc", "modality": "", "bodypart": "",
            "findings": "SYN template findings", "conclusion": "SYN template conclusion", "recommendation": ""}
FINDING = {"id": "11111111-1111-4111-8111-111111111111", "studyUid": h.UID, "revision": 1, "hidden": False,
           "authorActor": h.RAD["actor"], "updatedAt": "2026-10-03T00:00:00.000Z",
           "item": {"title": "SYN finding title", "text": "SYN finding text", "primary": 0, "sources": [
               {"itemId": "22222222-2222-4222-8222-222222222222", "revision": 1, "studyUid": h.UID, "seriesUid": "1.2.826.1",
                "sopUid": "1.2.826.1.1", "frame": 1, "kind": "arrow", "label": "SYN mark"}]},
           "links": [{"itemId": "22222222-2222-4222-8222-222222222222", "linkState": "current", "headRevision": 1}]}
SAVED_REPORT = {"version": 1, "rs": "T", "findings": "SYN-SAVED-V1 report", "conclusion": "", "recommendation": ""}
EMPTY = dict.fromkeys(h.FIELDS, "")
# A same-origin document that is not one of the product's pages (the viewer stand-in of the lock cases).
VIEWER_URL = h.ORIGIN + "/syn-viewer.html"
# The viewer document the list opens (/ohif/viewer), standing in for OHIF. Its first script does what config/ohif.js
# does first with a hand-over from the list: reads it from the window name and gives the window its name back.
VIEWER_STAND_IN = """<!doctype html><title>SYN viewer stand-in</title><script>
  window.__synEntry = null; window.__synNameAtLoad = window.name;
  if (window.name.startsWith('kin-viewer-entry:')) {
    try { window.__synEntry = JSON.parse(window.name.slice('kin-viewer-entry:'.length)); window.name = window.__synEntry.name; }
    catch (_) {}
  }
</script>"""
# A viewer document's side of the unsaved-work contract (viewer-session.js), for the stand-in: while it holds unsaved
# work it holds the lock `kin-unsaved:<session>:<document>:<kinds>`, and it answers `session-work-query` of its
# session with `session-work` (when `answers`).
WORK_STAND_IN = """([session, kinds, answers]) => new Promise(held => {
  const id = crypto.randomUUID(), channel = new BroadcastChannel('kin-session');
  window.__synWork = { id, queries: [], release: null };
  channel.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== 'session-work-query' || data.session !== session) return;
    window.__synWork.queries.push(data.query);
    if (answers) channel.postMessage({ type: 'session-work', session, document: id, query: data.query, unsaved: kinds });
  });
  if (!kinds.length) return held(id);
  navigator.locks.request('kin-unsaved:' + session + ':' + id + ':' + kinds.join(','),
    () => new Promise(release => { window.__synWork.release = release; held(id); }));
})"""
# What a document asks of the browser's lock manager and posts on the session channel, in the order it happened, each
# with the state of the document's work gate at that moment. The lock manager and the channel stay the browser's own.
ORDER_RECORDER = """(() => {
  if (window.__synOrder) return;
  const order = [];
  Object.defineProperty(window, '__synOrder', { value: order });
  const gate = () => typeof KinWorkContext === 'undefined' ? null : KinWorkContext.state();
  if (navigator.locks) {
    const request = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, ...rest) => {
      const callback = rest.pop();
      order.push({ event: 'request', name, gate: gate() });
      return request(name, ...rest, lock => { order.push({ event: 'granted', name, gate: gate() }); return callback(lock); });
    };
  }
  if (typeof BroadcastChannel === 'function') {
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message) {
      if (this.name === 'kin-session') order.push({ event: 'post', type: message && message.type, gate: gate() });
      return post.call(this, message);
    };
  }
})();"""


class Amended:
    """A route whose JSON answer the fixture amends before it is sent; the harness's handler still decides the answer."""

    def __init__(self, route, amend):
        self._route, self._amend = route, amend

    def __getattr__(self, name):
        return getattr(self._route, name)

    def fulfill(self, **kwargs):
        if isinstance(kwargs.get("json"), dict):
            kwargs["json"] = self._amend(dict(kwargs["json"]))
        return self._route.fulfill(**kwargs)


class MultiStudySite(h.Site):
    def __init__(self):
        super().__init__()
        self.second_study = True
        self.current_uid = h.UID
        self.other_state = ({}, {}, {"version": 0, "rs": "W"})
        self.bootstrap_states = None
        self.hidden = set()             # studies the list no longer shows (access removed, another institution)
        self.discard_answers = []       # DELETE draft of UID: (status, body) | "abort" | "lost" (done, answer lost) | "hold"
        self.held_discards = []         # held Discard Drafts: (route, body)
        self.bootstrap_answers = []     # the read of every study's state: "abort" | (status, body); none queued: the states
        self.viewer_opens = []          # the query strings of the viewer documents the list asked for
        self.held_viewers = None        # a list: the viewer document's answer is held (the window is still loading)
        self.templates, self.dictation, self.findings = [], None, None
        self.dictations, self.sids = [], 0
        # Study B's own GET draft answers. B's requests run through study A's handler (api below), so without its own
        # queue a read of study B would take the answer a test queued for study A's read.
        self.draft_read_answers_b = []

    def handle(self, route, request):
        url = h.urlparse(request.url)
        if request.method == "GET" and url.path == "/ohif/viewer" and f"{url.scheme}://{url.netloc}" == h.ORIGIN:
            self.viewer_opens.append(url.query)
            if self.held_viewers is not None:
                return self.held_viewers.append(route)
            return route.fulfill(content_type="text/html; charset=utf-8", body=VIEWER_STAND_IN)
        return super().handle(route, request)

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        body["studies"] = [row for row in body["studies"] if row["uid"] not in self.hidden]
        body["pagination"]["total"] = len(body["studies"])
        return body

    def write(self, body, account):
        """An insertion or a structured line is recorded with the same write: the server names the new id."""
        status, answer = super().write(body, account)
        row = self.rows.get(account["actor"])
        if status != 200 or row is None:
            return status, answer
        if "insert" in body:
            self.cids += 1
            row["citations"].append(f"SYN-CID-{self.cids}")
            return 200, {**self.envelope(account), "inserted": {"cid": row["citations"][-1],
                                                                 "insertedAt": "2026-10-03T00:00:00.000Z"}}
        if "structure" in body:
            self.sids += 1
            replaced = body["structure"].get("replacesSid")
            row["structured"] = [sid for sid in row["structured"] if sid != replaced] + [f"SYN-SID-{self.sids}"]
            return 200, {**self.envelope(account), "applied": {"sid": row["structured"][-1]}}
        return status, answer

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

    def accept(self, route, body, rs):
        """The server accepts a held Approve, Save or Addendum as it was sent: the report becomes that text with a new
        version and that state, and the author's draft row is gone."""
        self.revs[h.RAD["actor"]] = self.revs.get(h.RAD["actor"], 0) + 1
        self.rows.pop(h.RAD["actor"], None)
        self.report = {"version": self.report["version"] + 1, "rs": rs, "action": body.get("action"),
                       **{k: body.get(k, "") for k in h.FIELDS}}
        route.fulfill(json={**self.envelope(h.RAD), "state": self.state(h.RAD)})

    def versions(self):
        """The version history of study A, newest first: the fixture keeps the head version only."""
        head = self.report
        return [] if not head["version"] else [{
            "id": head["version"], "uid": h.UID, "version": head["version"], "reason": None,
            "action": head.get("action") or ("approve" if head["rs"] == "A" else "save"),
            "author": h.RAD["actor"], "at": "2026-10-03T00:00:00.000Z", **{k: head.get(k, "") for k in h.FIELDS}}]

    def api(self, route, request, method, path, query):
        if method == "GET" and path == f"/api/studies/{h.UID}/report/versions":
            if path in self.held_gets:
                return self.held_gets[path].append(route)
            return route.fulfill(json=self.versions())
        if (method == "POST" and path == f"/api/studies/{h.UID}/report/commit" and not self.commit_answers
                and (request.post_data_json or {}).get("action") == "addendum"):
            # An Addendum leaves the report approved (the harness answers every other command than Approve with T).
            body = request.post_data_json
            self.commits.append(body)
            refused = self.preconditions(body, self.sessions[self.cookie])
            return self.answer(route, *refused) if refused else self.accept(route, body, "A")
        if method == "GET" and path == "/api/bootstrap" and (self.templates or self.dictation):
            route = Amended(route, lambda body: {**body, "templates": self.templates, "dictation": self.dictation})
        if method == "POST" and path == f"/api/studies/{h.UID}/dictation":
            self.dictations.append(request.headers.get("x-kin-session"))
            return route.fulfill(json={"text": DICTATED, "seconds": 0.1, "languagePin": DICTATION["languagePin"],
                                       "enginePin": DICTATION["enginePin"], "modelPin": DICTATION["modelPin"]})
        if method == "GET" and path == f"/api/studies/{h.UID}/findings" and self.findings is not None:
            return route.fulfill(json={"items": self.findings, "nextCursor": None}, headers={"X-KIN-Finding-Schema": "2"})
        if method == "DELETE" and path == f"/api/studies/{h.UID}/draft" and self.discard_answers:
            reply = self.discard_answers.pop(0)
            self.discards.append(request.post_data_json)
            if reply == "hold":
                return self.held_discards.append((route, request.post_data_json))
            if reply == "lost":             # the server discards the draft; its answer reaches nobody
                account = self.sessions[self.cookie]
                self.revs[account["actor"]] = self.revs.get(account["actor"], 0) + 1
                self.rows.pop(account["actor"], None)
            return route.abort("connectionreset") if reply in ("abort", "lost") else self.answer(route, *reply)
        if method == "GET" and path == "/api/bootstrap" and "states=omit" not in query and self.bootstrap_answers:
            reply = self.bootstrap_answers.pop(0)
            return route.abort("connectionreset") if reply == "abort" else self.answer(route, *reply)
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
            a_reads, self.draft_read_answers = self.draft_read_answers, self.draft_read_answers_b
            try:
                with self.study(uid):
                    result = super().api(answer, request, method, path.replace(h.UID_B, h.UID), query)
            finally:
                self.draft_read_answers_b, self.draft_read_answers = self.draft_read_answers, a_reads
            answer.deferred = False
            for action, kwargs in actions:
                getattr(route, action)(**kwargs)
            return result
        return super().api(route, request, method, path, query)

    def stored_for(self, uid):
        with self.study(uid):
            return self.stored()

    def finish_discard(self, lost=False):
        """The server reaches a held Discard Draft of study A now: the author's row goes when its revision is the
        expected one (`lost`: and the answer reaches nobody). Returns the status the server answered."""
        route, body = self.held_discards.pop(0)
        refused = self.preconditions(body, h.RAD)
        if refused:
            self.answer(route, *refused)
            return refused[0]
        self.revs[h.RAD["actor"]] = self.revs.get(h.RAD["actor"], 0) + 1
        self.rows.pop(h.RAD["actor"], None)
        if lost:
            route.abort("connectionreset")
        else:
            route.fulfill(json={**self.envelope(h.RAD), "state": self.state(h.RAD)})
        return 200

    def drop_discard(self):
        """A held Discard Draft of study A never reaches the server: the connection breaks, the row stays."""
        route, _ = self.held_discards.pop(0)
        route.abort("connectionreset")

    def lose(self, route, body, rs):
        """The server accepts a held Approve or Save as it was sent (as `accept` does); its answer reaches nobody."""
        self.revs[h.RAD["actor"]] = self.revs.get(h.RAD["actor"], 0) + 1
        self.rows.pop(h.RAD["actor"], None)
        self.report = {"version": self.report["version"] + 1, "rs": rs, "action": body.get("action"),
                       **{k: body.get(k, "") for k in h.FIELDS}}
        route.abort("connectionreset")

    def draft_row(self, uid=h.UID):
        """The author's whole stored draft row of a study (texts, base version, lists), or None."""
        with self.study(uid):
            row = self.rows.get(h.RAD["actor"])
            return dict(row) if row else None


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

    # ── round 4: U5CLI-F09 / F10, the reviewer's unverified paths ──
    def collect_notices(self, page=None):
        """Every notice the page shows from now on, as (text, shown as an error)."""
        page = page or self.page
        notices = []
        page.expose_function("syn_notice", lambda text, error: notices.append((text, error)))
        page.evaluate("""() => new MutationObserver(() => {
            const node = document.querySelector('#toast');
            if (node.textContent.trim() && node.classList.contains('show'))
              window.syn_notice(node.textContent, node.classList.contains('err'));
        }).observe(document.querySelector('#toast'), {childList: true, subtree: true, characterData: true, attributes: true})""")
        return notices

    def leaving_asks(self, page=None):
        """Whether the page would ask before the browser leaves it (the beforeunload contract)."""
        return (page or self.page).evaluate("""() => {
            const event = new Event('beforeunload', {cancelable: true});
            window.dispatchEvent(event); return event.defaultPrevented;
        }""")

    def report_menu(self, control):
        """A control of the report toolbar; some sit in the More menu."""
        if not self.page.locator(control).is_visible():
            self.page.locator("#report-more > summary").click()
        return self.page.locator(control)

    def paste(self, text):
        reads = self.page.evaluate("() => window.__synClipboard.reads.length")
        self.report_menu("#b-paste").click()
        self.wait_until(lambda: self.page.evaluate("() => window.__synClipboard.reads.length") == reads + 1, "the clipboard read")
        self.page.evaluate("([index, text]) => window.__synClipboard.reads[index].resolve(text)", [reads, text])

    def open_untouched(self, report=None, draft=None):
        """A new document on study A with nothing typed. `draft` is a draft the reader stored earlier."""
        self.fresh_context()
        self.site = MultiStudySite()
        if report:
            self.site.report = dict(report)
        if draft:
            self.site.write({**draft, "baseVersion": self.site.report["version"], "citationIds": [], "structureIds": [],
                             "expectedOwner": h.owner_of(h.RAD), "expectedRevision": "SYNEPOCH1:0"}, h.RAD)
        for part in ("citations", "structure"):
            self.site.gets[f"/api/studies/{h.UID}/report/{part}"] = (200, {
                "version": self.site.report["version"], "draftRevision": self.site.revision(h.RAD["actor"]),
                "head": [], "draft": []})
        self.context.add_init_script(h.CLIPBOARD)
        self.context.add_init_script(MEDIA)
        self.page.clock.install()

    def select_untouched(self):
        self.open_main()
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_be_editable()

    def cross(self, boundary, saved):
        """Take the page across one boundary at which unsaved editor text was lost; `saved` is what the server must
        hold afterwards (study A's stored draft)."""
        if boundary == "poll":
            self.page.clock.run_for(31000)      # the autosave (20 s), then the list poll (30 s)
            self.wait_until(lambda: self.site.stored_for(h.UID) == saved, "the autosave")
            self.page.wait_for_timeout(300)
        elif boundary == "study switch":
            self.switch(h.PATIENT_B)
            self.wait_until(lambda: self.site.stored_for(h.UID) == saved, "the save on leaving the study")
            self.switch(h.PATIENT)
        elif boundary == "refresh":
            self.refresh()
            self.page.wait_for_timeout(400)

    BOUNDARIES = ("poll", "study switch", "refresh", "log out", "log out, save refused")

    def end_at(self, boundary, saved, kept):
        """Log out after the boundary: the text is stored, or - when the server refuses it - the person is asked."""
        if boundary == "log out, save refused":
            self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN refused"})] * 2
            self.log_out_main()
            expect(self.panel_title()).to_have_text("Draft Not Saved")
            expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.PATIENT)
            self.assertEqual(([], kept), (self.site.logouts, self.editor()), "refused: nothing ends, the text stays")
            return
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((saved, 1), (self.site.stored_for(h.UID), len(self.site.logouts)))

    def test_pasted_text_in_an_untouched_study_is_saved_or_asked_at_every_boundary(self):
        pasted = {**EMPTY, "findings": "SYN-PASTED report text"}
        for boundary in self.BOUNDARIES:
            with self.subTest(boundary=boundary):
                self.open_untouched()
                self.select_untouched()
                self.paste(pasted["findings"])
                expect(self.page.locator("#findings")).to_have_value(pasted["findings"])
                self.cross(boundary, pasted)
                self.assertEqual(pasted, self.editor(), "the pasted text is no longer in the editor")
                self.end_at(boundary, pasted, pasted)
                self.assertEqual([], self.dialogs, "nothing is asked on the way")

    def test_a_cleared_draft_in_an_untouched_study_is_saved_or_asked_at_every_boundary(self):
        for boundary in self.BOUNDARIES:
            with self.subTest(boundary=boundary):
                self.open_untouched(draft=h.FIELDS)
                self.select_untouched()
                expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
                asked = len(self.dialogs)
                self.dialog_answers = [True]
                self.report_menu("#b-clear").click()
                self.assertEqual(EMPTY, self.editor())
                # The cleared draft is the reader's edit: the server's draft row goes, and the old text does not come back.
                self.cross(boundary, None)
                self.assertEqual(EMPTY, self.editor(), "the cleared text came back")
                self.end_at(boundary, None, EMPTY)
                self.assertEqual(asked + 1, len(self.dialogs), "only Clear's own confirmation was asked")
                if boundary == "log out, save refused":
                    self.assertEqual(h.FIELDS, self.site.stored_for(h.UID), "the refused clear changed nothing on the server")

    def insert_template(self):
        self.page.locator("#tplrows tr", has_text=TEMPLATE["title"]).first.dblclick()
        return TEMPLATE["findings"]

    def insert_shortcut(self):
        # The typed shortcut is saved first, so what follows is the expansion alone.
        typed = {**EMPTY, "findings": TEMPLATE["shortcut"]}
        self.page.fill("#findings", typed["findings"])
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == typed, "the typed shortcut autosaved")
        self.page.wait_for_timeout(300)
        self.page.locator("#findings").evaluate("el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }")
        self.page.keyboard.press("Tab")
        return TEMPLATE["findings"]

    def insert_dictation(self):
        self.page.locator("#b-dictate").click()
        self.page.locator("#dictation-stop").click()
        self.page.locator("#dictation-insert").click()
        self.assertEqual([self.site.cookie], self.site.dictations, "one recognition request, bound to the session")
        return DICTATED

    def insert_structured(self):
        self.report_menu("#b-structured").click()
        self.page.locator("#struct-value-text").fill("SYN technique")
        self.page.locator("#struct-apply").click()
        return "SYN technique"

    def insert_citation(self):
        self.page.locator("#reading-findings-open").click()
        self.page.locator("#reading-findings-list").get_by_role("button", name="Insert into Report").first.click()
        self.page.locator("#cite-preview-insert").click()
        return FINDING["item"]["text"]

    def test_each_insertion_by_a_control_is_recorded_like_typed_text(self):
        for kind in ("template", "shortcut", "dictation", "structured", "citation"):
            with self.subTest(insertion=kind):
                self.open_untouched()
                self.site.templates, self.site.dictation, self.site.findings = [TEMPLATE], DICTATION, [FINDING]
                self.select_untouched()
                inserted = getattr(self, "insert_" + kind)()
                expect(self.page.locator("#findings")).to_have_value(re.compile(re.escape(inserted)))
                shown = self.editor()
                # Nothing is typed after the insertion. The autosave stores exactly what the control put there and the
                # list poll does not replace it.
                self.page.clock.run_for(31000)
                self.wait_until(lambda: self.site.stored_for(h.UID) == shown, "the inserted text stored")
                self.page.wait_for_timeout(300)
                self.assertEqual(shown, self.editor(), "the poll replaced the inserted text")
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual((shown, []), (self.site.stored_for(h.UID), self.dialogs))

    def test_text_typed_while_a_save_is_out_is_not_confirmed_by_that_save(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.put_answers = ["hold"]
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.held_puts, "the autosave is out")
        later = {**h.FIELDS, "findings": h.FIELDS["findings"] + " SYN typed while the save was out"}
        self.page.fill("#findings", later["findings"])
        self.assertEqual(200, self.site.finish_put())
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "the earlier text stored")
        self.page.wait_for_timeout(300)
        # The server now holds the earlier text. A list read brings it; the later text is still this document's.
        self.refresh()
        self.page.wait_for_timeout(400)
        self.assertEqual(later, self.editor(), "the list read replaced text typed while the save was out")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the later text stored by the next autosave")
        # Saved text is said to be saved, with the time it was.
        expect(self.page.locator("#draftmsg")).to_contain_text(re.compile(r"\d{2}:\d{2}"))
        self.assertFalse(self.leaving_asks(), "everything is stored: leaving asks nothing")
        self.assertEqual([], self.dialogs)

    def test_a_refused_or_unconfirmed_approve_or_save_of_an_unedited_study_writes_and_asks_nothing(self):
        cases = (("Approve refused for a newer version", "#b-approve", (409, {"message": "그 사이 다른 사용자가 저장했습니다 (v2)"}), [False]),
                 ("Save refused", "#b-save", (500, {"message": "SYN commit refused"}), []),
                 ("Save of unknown outcome", "#b-save", (502, {"message": "SYN gateway"}), []))
        for label, control, answer, answers in cases:
            with self.subTest(command=label):
                self.open_untouched(report=SAVED_REPORT)
                self.select_untouched()
                expect(self.page.locator("#findings")).to_have_value(SAVED_REPORT["findings"])
                self.site.commit_answers = [answer]
                self.dialog_answers = list(answers)
                self.page.locator(control).click()
                self.wait_until(lambda: len(self.site.commits) == 1, "the command reached the server")
                self.page.wait_for_timeout(400)
                for _ in range(2):
                    self.page.clock.run_for(21000)
                    self.page.wait_for_timeout(200)
                self.assertEqual(([], None), (self.site.puts, self.site.stored_for(h.UID)),
                                 "nobody typed: the saved report was written as a draft")
                self.assertFalse(self.leaving_asks(), "nobody typed: leaving asks nothing")
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual(([], 1), (self.site.puts, len(self.site.logouts)), "Log out is one press, nothing to save")

    def test_a_failed_discard_of_an_unedited_draft_is_not_sent_again(self):
        cases = (("refused", (403, {"statusCode": 403, "message": "SYN discard refused"}), h.FIELDS),
                 ("unknown outcome, not done", "abort", h.FIELDS),
                 ("unknown outcome, done on the server", "lost", None))
        for label, reply, stored in cases:
            with self.subTest(discard=label):
                self.open_untouched(draft=h.FIELDS)
                self.select_untouched()
                expect(self.page.locator("#b-draft-discard")).to_be_visible()
                self.site.discard_answers = [reply]
                self.dialog_answers = [True]
                self.page.locator("#b-draft-discard").click()
                self.wait_until(lambda: len(self.site.discards) == 1, "the discard reached the server")
                self.page.wait_for_timeout(500)
                for _ in range(2):
                    self.page.clock.run_for(21000)
                    self.page.wait_for_timeout(250)
                self.assertEqual(([], stored), (self.site.puts, self.site.stored_for(h.UID)),
                                 "the draft the reader was discarding was written again")
                # The screen follows the server: the draft is still shown while it exists, and gone once it is gone.
                self.assertEqual(stored or EMPTY, self.editor())
                self.assertFalse(self.leaving_asks(), "nothing typed: leaving asks nothing")
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual(([], 1), (self.site.puts, len(self.site.logouts)))

    def test_a_refused_insertion_into_an_unedited_study_leaves_no_draft(self):
        self.open_untouched(report=SAVED_REPORT)
        self.select_untouched()
        expect(self.page.locator("#findings")).to_have_value(SAVED_REPORT["findings"])
        self.report_menu("#b-structured").click()
        self.page.locator("#struct-value-text").fill("SYN technique")
        self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN structure refused"})]
        self.page.locator("#struct-apply").click()
        self.wait_until(lambda: len(self.site.puts) == 1, "the refused insertion")
        self.page.wait_for_timeout(300)
        saved = {k: SAVED_REPORT[k] for k in h.FIELDS}
        self.assertEqual(saved, self.editor(), "a refused insertion changes no text")
        for _ in range(2):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(200)
        self.assertEqual((1, None), (len(self.site.puts), self.site.stored_for(h.UID)),
                         "the saved report was written as a draft after a refused insertion")
        self.assertFalse(self.leaving_asks())
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((1, 1), (len(self.site.puts), len(self.site.logouts)))

    def test_a_study_the_server_no_longer_accepts_is_announced_once_and_its_text_kept(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN no access to this study"})] * 10
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "A refused on leaving it")
        self.site.hidden = {h.UID}          # the study left this reader's list (access removed, another institution)
        for _ in range(4):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(200)
        expect(self.page.locator("#rows")).not_to_contain_text(h.PATIENT)
        self.assertEqual(1, len(self.site.puts), "the refused text was sent again by itself")
        self.assertEqual(1, len([text for text, error in notices if error]), notices)
        # The text is kept: Log out asks, naming the study by the only name it still has.
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        expect(self.page.locator("dialog.kin-logout")).to_contain_text(h.UID)
        self.assertEqual([], self.site.logouts)
        self.site.put_answers = []
        self.panel_button("Retry").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(h.FIELDS, self.site.stored_for(h.UID))

    def test_a_passing_save_failure_is_retried_without_repeating_the_notice(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN passing failure"})] * 3
        for _ in range(3):
            self.page.clock.run_for(20500)
            self.page.wait_for_timeout(200)
        self.assertEqual(3, len(self.site.puts), "a failure that may pass is tried again")
        self.assertEqual(1, len([text for text, error in notices if error]), notices)
        self.page.clock.run_for(20500)
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "stored once the server accepts")
        self.assertEqual(h.FIELDS, self.editor())

    def test_load_latest_without_that_study_in_the_answer_keeps_the_text_and_says_so(self):
        self.context.add_init_script(h.CLIPBOARD)
        self.site.bootstrap_states = {}     # the study is no longer among this reader's states
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        refusal = "그 사이 다른 사용자가 저장했습니다 (v1)"
        self.site.report = {"version": 1, "rs": "T", "findings": "SYN server report v1", "conclusion": "", "recommendation": ""}
        self.site.commit_answers = [(409, {"message": refusal})]
        self.dialog_answers = [True]
        reads = self.site.count("GET", "/api/bootstrap")
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.count("GET", "/api/bootstrap") > reads, "the read of the latest report")
        self.wait_until(lambda: any(error and text != refusal for text, error in notices), "the failed load is said")
        self.assertEqual(h.FIELDS, self.editor(), "the text the reader was writing stays")
        expect(self.page.locator("#b-save")).to_be_enabled()
        self.assertTrue(self.leaving_asks(), "the unsaved text is still this document's")
        # (tearDown: no page error - the failure is handled, not thrown)

    def save_and_leave_before_the_answer(self):
        """Save of study A is out; the reader moves to study B; then the server accepts the Save (what the harness
        answers for an unheld commit). The write of leaving A stood behind the Save."""
        self.site.commit_answers = ["hold"]
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.held_commits, "Save is out")
        self.switch(h.PATIENT_B)
        self.page.wait_for_timeout(200)
        route, body = self.site.held_commits.pop(), self.site.commits[-1]
        self.site.revs[h.RAD["actor"]] = self.site.revs.get(h.RAD["actor"], 0) + 1
        self.site.rows.pop(h.RAD["actor"], None)
        self.site.report = {"version": 1, "rs": "T", **{k: body.get(k, "") for k in h.FIELDS}}
        route.fulfill(json={**self.site.envelope(h.RAD), "state": self.site.state(h.RAD)})
        row = self.page.locator("#rows tr", has_text=h.PATIENT).first
        expect(row.get_by_role("cell", name="T", exact=True)).to_be_visible()

    def test_a_save_accepted_after_the_study_was_left_is_not_reported_as_failed(self):
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.save_and_leave_before_the_answer()
        self.page.wait_for_timeout(600)
        self.assertEqual([], [text for text, error in notices if error], "an accepted Save was shown as a failure")
        # The page stands on the saved version: the next Save names it.
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(h.FIELDS["findings"])
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 2, "the next Save")
        self.assertEqual(1, self.site.commits[-1]["baseVersion"])

    def test_a_refused_write_left_behind_an_accepted_save_is_not_a_failure_and_not_sent_again(self):
        """The write of leaving the study stood behind the Save. The Save stored that text as the report, so when the
        write's turn comes it has nothing to send - a write the server would refuse (403) is not a failure of anything.
        (Until the closure audit of 2026-10-05 the write was still sent with the text captured on leaving; this case
        waited for it. Sent and accepted, it put the saved text back as a draft - the cases of round 7 below.)"""
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.site.put_answers = [(403, {"statusCode": 403, "message": "SYN refused"})]
        self.save_and_leave_before_the_answer()
        self.page.wait_for_timeout(600)
        for _ in range(2):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(200)
        # The Save stored that text as the report: nothing of this document is unconfirmed, and nothing was sent as a draft.
        self.assertEqual((0, None), (len(self.site.puts), self.site.stored_for(h.UID)), "the saved report was sent as a draft")
        self.assertEqual([], [text for text, error in notices if error], "the reader was told of a failure that lost nothing")
        self.assertFalse(self.leaving_asks())
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((0, 1), (len(self.site.puts), len(self.site.logouts)))

    def test_text_typed_while_a_save_or_approve_is_out_is_kept_when_the_server_accepts_it(self):
        for control, rs in (("#b-save", "T"), ("#b-approve", "A")):
            with self.subTest(command=control):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.select_and_type()
                self.site.commit_answers = ["hold"]
                self.page.locator(control).click()
                self.wait_until(lambda: self.site.held_commits, "the command is out")
                later = {**h.FIELDS, "findings": h.FIELDS["findings"] + " SYN typed while the command was out"}
                self.page.locator("#findings").press_sequentially(" SYN typed while the command was out")
                # The server accepts the command as it was sent (what the harness answers for an unheld commit).
                route, body = self.site.held_commits.pop(), self.site.commits[-1]
                self.site.revs[h.RAD["actor"]] = self.site.revs.get(h.RAD["actor"], 0) + 1
                self.site.rows.pop(h.RAD["actor"], None)
                self.site.report = {"version": 1, "rs": rs, **{k: body.get(k, "") for k in h.FIELDS}}
                route.fulfill(json={**self.site.envelope(h.RAD), "state": self.site.state(h.RAD)})
                row = self.page.locator("#rows tr", has_text=h.PATIENT).first
                expect(row.get_by_role("cell", name=rs, exact=True)).to_be_visible()
                # The command carried the earlier text and that is what was saved; the later text is still on screen.
                self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS})
                self.assertEqual(later, self.editor(), "the accepted command redrew the editor over text typed meanwhile")
                self.assertTrue(self.leaving_asks(), "the later text is not stored anywhere yet: leaving asks")
                self.refresh()
                self.page.wait_for_timeout(400)
                self.assertEqual(later, self.editor(), "the list read replaced the later text")
                # It is this document's unconfirmed text on the accepted version: the next autosave stores it as a draft.
                self.page.clock.run_for(21000)
                self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the later text stored as a draft")
                self.assertEqual(1, self.site.puts[-1]["baseVersion"], "the draft stands on the version just accepted")
                self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS}, "the saved report is untouched")
                self.assertEqual([], self.dialogs)

    # ── round 5: the preparation's contract with viewer documents is two Web Locks, not a timer (U5VW-F07, U5VW-F11) ──
    def preparing(self, page=None):
        return [post for post in self.posts(page) if post["type"] == "session-preparing"]

    def order(self, page=None):
        """What the document asked of the lock manager and posted on the session channel, in order, as (event, what)."""
        return (page or self.page).evaluate(
            "() => window.__synOrder.map(e => [e.event, e.name || e.type, e.gate])")

    def viewer(self):
        """A document of the same origin that is no auth.js page, as a viewer document is: it hears the session channel
        and reads the browser's locks. With each notice it keeps the locks it could read at that moment."""
        page = self.watch(self.context.new_page())
        page.route(VIEWER_URL, lambda route: route.fulfill(content_type="text/html",
                                                           body="<!doctype html><title>SYN viewer stand-in</title>"))
        page.goto(VIEWER_URL)
        page.evaluate("""() => { window.__synHeard = []; window.__synChannel = new BroadcastChannel('kin-session');
            window.__synChannel.onmessage = async event => {
              const entry = { ...event.data, locks: null };
              window.__synHeard.push(entry);
              const now = await navigator.locks.query();
              entry.locks = [...now.held, ...now.pending].map(lock => lock.name);
            }; }""")
        return page

    def heard(self, viewer, kind):
        return viewer.evaluate("kind => window.__synHeard.filter(notice => notice.type === kind && notice.locks)", kind)

    def locks(self, viewer):
        return viewer.evaluate("""async () => { const now = await navigator.locks.query();
            return { held: now.held.map(lock => lock.name).sort(), pending: now.pending.map(lock => lock.name).sort() }; }""")

    def begin_preparation(self, answers):
        """A reader with typed text presses Log out; the preparation's save gets `answers`. Returns the viewer stand-in,
        the session and the preparation id of the one notice."""
        self.context.add_init_script(ORDER_RECORDER)
        self.open_main()
        session = self.site.cookie
        self.select_and_type()
        viewer = self.viewer()
        self.site.put_answers = list(answers)
        self.log_out_main()
        self.wait_until(lambda: self.heard(viewer, "session-preparing"), "the pause notice", page=viewer)
        notices = self.preparing()
        self.assertEqual([session], [notice["session"] for notice in notices], "one notice for one preparation")
        return viewer, session, notices[0]["preparation"]

    def test_a_preparation_holds_its_lock_from_before_its_notice_until_back_to_editing_releases_it(self):
        self.page.clock.install()
        viewer, session, first = self.begin_preparation([(403, {"statusCode": 403, "message": "SYN refused"})])
        name, leaving = "kin-preparation:" + first, "kin-leaving:" + first
        expect(self.panel_title()).to_have_text("Draft Not Saved")
        # (0) The press of Log out first asks for its leaving marker's lock (A017: the window that is leaving is alive) -
        # before any wait, so before the preparation's own lock.
        self.assertEqual(["request", leaving, "active"], self.order()[0], "the leaving marker is the press's first step")
        # (1) The preparation's lock is granted first; only then the document prepares and posts its notice.
        self.assertEqual([["request", name, "active"], ["granted", name, "active"], ["post", "session-preparing", "preparing"]],
                         [step for step in self.order() if step[1] != leaving])
        # What a viewer can read when the notice reaches it: the lock is already held.
        paused = self.heard(viewer, "session-preparing")
        self.assertEqual([("session-preparing", session, first)], [(n["type"], n["session"], n["preparation"]) for n in paused])
        self.assertIn(name, paused[0]["locks"], "the notice arrived before the lock it stands on")
        held = {"held": sorted([leaving, name]), "pending": []}
        self.assertEqual(held, self.locks(viewer))
        # Nothing of this depends on a timer of the preparing document: ten minutes pass, nothing is posted, it is held.
        self.page.clock.run_for(600000)
        self.assertEqual((1, "preparing"), (len(self.posts()), self.screen()["state"]))
        self.assertEqual(held, self.locks(viewer))
        # (2) Retry is the same preparation: the same locks, no second notice.
        self.site.put_answers = ["hold"]
        self.panel_button("Retry").click()
        self.wait_until(lambda: self.site.held_puts, "the retried save")
        self.assertEqual((1, 5), (len(self.posts()), len(self.order())), "a retry asked for another lock or posted again")
        self.assertEqual(held, self.locks(viewer))
        # (3) Back to Editing: the resume notice, then the release.
        self.panel_button("Back to Editing").click()
        self.wait_until(lambda: self.locks(viewer) == {"held": [], "pending": []}, "the lock released", page=viewer)
        resumed = self.heard(viewer, "session-resumed")
        self.assertEqual([("session-resumed", session, first)], [(n["type"], n["session"], n["preparation"]) for n in resumed])
        self.assertEqual(("active", []), (self.screen()["state"], self.heard(viewer, "session-ended")))
        # (6) A new Log out is a new preparation: a new id, a new lock.
        self.log_out_main()
        self.wait_until(lambda: len(self.preparing()) == 2, "the second preparation")
        second = self.preparing()[1]["preparation"]
        self.assertNotEqual(first, second)
        self.wait_until(lambda: self.locks(viewer) == {"held": ["kin-leaving:" + second, "kin-preparation:" + second],
                                                       "pending": []},
                        "the second preparation's locks", page=viewer)

    def test_a_real_end_asks_for_the_end_lock_before_its_notice_and_never_releases_the_preparation(self):
        for ending in ("Log out completes", "the server ended the session", "the session became another login's",
                       "another document ended the session"):
            with self.subTest(ending=ending):
                self.fresh_context()
                self.site = MultiStudySite()
                self.context.add_init_script(ORDER_RECORDER)
                other = self.open_main(self.watch(self.context.new_page())) if ending.startswith("another") else None
                self.site.logout_answers = ["hold"]
                viewer, session, first = self.begin_preparation(["hold"])
                self.wait_until(lambda: self.site.held_puts, "the preparation's save")
                name, end = "kin-preparation:" + first, "kin-session-ended:" + session
                if ending == "Log out completes":
                    self.assertEqual(200, self.site.finish_put())
                    self.wait_until(lambda: len(self.site.held_logouts) == 1, "the real end")
                elif ending == "the server ended the session":
                    self.site.ended.add(session)
                    self.site.refuse(self.site.held_puts.pop()[0], 401, "AUTH_SESSION_ENDED")
                elif ending == "the session became another login's":
                    self.site.account = h.RAD_OTHER
                    self.site.refuse(self.site.held_puts.pop()[0], 409, "AUTH_SESSION_MISMATCH")
                else:
                    self.log_out_main(other)
                    self.wait_until(lambda: len(self.site.held_logouts) == 1, "the other document's end", page=other)
                if ending != "Log out completes":
                    expect(self.panel_title()).to_have_text("Session Ended")
                self.wait_until(lambda: self.heard(viewer, "session-ended"), "the end notice", page=viewer)
                # (4) The end lock is asked for before the end is posted; whoever hears the end can already read it.
                order = [step[:2] for step in self.order(other)]
                self.assertLess(order.index(["request", end]), order.index(["post", "session-ended"]),
                                "the end was posted before its lock was asked for")
                self.assertEqual([], [n for n in self.heard(viewer, "session-ended") if end not in n["locks"]],
                                 "a viewer heard the end and could not read its lock")
                if other:
                    # A document that learns of the end asks for the lock too, and announces no end of its own.
                    mine = [step[:2] for step in self.order()]
                    self.assertIn(["request", end], mine)
                    self.assertNotIn(["post", "session-ended"], mine)
                # The preparation's lock is not released and no resume is posted: an end is never read as a cancel.
                self.page.wait_for_timeout(300)
                now = self.locks(viewer)
                self.assertIn(name, now["held"], "the preparation's lock was released at the end")
                self.assertIn(end, now["held"] + now["pending"])
                self.assertEqual([], viewer.evaluate("() => window.__synHeard.filter(n => n.type === 'session-resumed')"))
                # Both go with the documents that hold them.
                while self.site.held_logouts:
                    self.release_logout()
                if ending == "Log out completes":
                    self.page.wait_for_url(h.INDEX_URL)
                else:
                    if other:
                        other.wait_for_url(h.INDEX_URL)
                    self.wait_until(lambda: end in self.locks(viewer)["held"], "the document that stays keeps the end readable",
                                    page=viewer)
                    self.page.close()
                    self.page = viewer
                self.wait_until(lambda: self.locks(viewer) == {"held": [], "pending": []}, "the locks released with the document",
                                page=viewer)
                self.assertEqual([], viewer.evaluate("() => window.__synHeard.filter(n => n.type === 'session-resumed')"))

    def test_closing_the_preparing_tab_releases_its_lock_and_posts_nothing(self):
        viewer, session, first = self.begin_preparation(["hold"])
        self.wait_until(lambda: self.site.held_puts, "the preparation's save")
        self.assertEqual({"held": ["kin-leaving:" + first, "kin-preparation:" + first], "pending": []}, self.locks(viewer))
        self.page.close()                   # the tab is closed in the middle of its preparation
        self.page = viewer
        # The browser releases what the document held; nobody posts anything, and nothing says the session ended.
        self.wait_until(lambda: self.locks(viewer) == {"held": [], "pending": []}, "the lock released by the browser", page=viewer)
        viewer.wait_for_timeout(300)
        self.assertEqual(["session-preparing"], viewer.evaluate("() => window.__synHeard.map(notice => notice.type)"))

    def test_log_out_with_nothing_to_save_is_one_press_and_the_same_order(self):
        self.context.add_init_script(ORDER_RECORDER)
        self.open_main()
        session = self.site.cookie
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_be_editable()
        self.site.logout_answers = ["hold"]
        self.log_out_main()
        self.wait_until(lambda: self.site.held_logouts, "the real end")
        preparation = self.preparing()[0]["preparation"]
        name, end, leaving = "kin-preparation:" + preparation, "kin-session-ended:" + session, "kin-leaving:" + preparation
        # The same contract as with text to save, in one press: the leaving marker first (A017), then nothing waits for
        # the end lock's grant.
        self.assertEqual(["request", leaving], self.order()[0][:2])
        self.assertEqual([["request", name], ["granted", name], ["post", "session-preparing"], ["request", end],
                          ["post", "session-ended"]],
                         [step[:2] for step in self.order() if step[:2] != ["granted", end] and step[1] != leaving])
        self.assertEqual(([], []), (self.site.puts, self.dialogs))
        self.release_logout()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(1, len(self.site.logouts))

    # A document whose lock manager is missing, throws when it is read, throws from request(), or rejects the request.
    NO_LOCKS = {
        "no lock manager": "get() { return undefined; }",
        "reading the lock manager throws": "get() { throw new DOMException('SYN no locks here', 'SecurityError'); }",
        "the request throws": "get() { return { request() { throw new DOMException('SYN no locks here', 'SecurityError'); } }; }",
        "the request is rejected": "get() { return { request() { return Promise.reject(new DOMException('SYN', 'AbortError')); } }; }",
    }

    def test_without_the_lock_manager_the_notices_still_go_and_log_out_completes(self):
        for label, getter in self.NO_LOCKS.items():
            with self.subTest(locks=label):
                self.fresh_context()
                self.site = MultiStudySite()
                seen = len(self.errors)
                self.context.add_init_script(
                    "Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, %s });" % getter)
                self.open_main()
                session = self.site.cookie
                self.select_and_type()
                self.site.put_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_puts, "the preparation's save")
                self.panel_button("Back to Editing").click()
                first = self.preparing()[0]["preparation"]
                self.assertEqual([{"type": "session-preparing", "session": session, "preparation": first},
                                  {"type": "session-resumed", "session": session, "preparation": first}], self.posts())
                self.assertEqual(200, self.site.finish_put())
                # Log out can be pressed again, and that press ends the session.
                self.log_out_main()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual((h.FIELDS, 1), (self.site.stored_for(h.UID), len(self.site.logouts)))
                self.assertEqual([], self.errors[seen:], "the failed lock request escaped as a page error")

    # ── round 6: text typed after the press is not in the approved report, and the screen says so (U5CLI-F11) ──
    LATE = " SYN-LATE sentence typed after the press"
    LATER = {**h.FIELDS, "findings": h.FIELDS["findings"] + LATE}
    CONFIRMING = {"Save": "#b-save", "Approve": "#b-approve", "Addendum": "#b-addendum"}

    def press_then_type(self, control="#b-approve", rs="A", leave=False, field="findings"):
        """The reader presses a confirming control and, while the server still has it, types one more sentence into
        one field (and may move on to study B); then the server accepts the command as it was sent."""
        self.site.commit_answers = ["hold"]
        self.page.locator(control).click()
        self.wait_until(lambda: self.site.held_commits, "the command is out")
        self.page.locator("#" + field).press_sequentially(self.LATE)
        if leave:
            self.switch(h.PATIENT_B)
            self.page.wait_for_timeout(200)
        self.site.accept(self.site.held_commits.pop(), self.site.commits[-1], rs)
        row = self.page.locator("#rows tr", has_text=h.PATIENT).first
        expect(row.get_by_role("cell", name=rs, exact=True)).to_be_visible()
        self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS}, "the accepted report is the text sent")

    def late_notice(self, notices):
        """The notice that says some text is not part of what was just confirmed."""
        self.wait_until(lambda: any("포함되지 않았습니다" in text for text, error in notices), "the notice of the text left out")
        text, error = next(notice for notice in notices if "포함되지 않았습니다" in notice[0])
        self.assertFalse(error, "an accepted command was shown as a failure")
        return text

    def bar_guides(self):
        """The confirming controls the draft bar names. A control it names can be pressed."""
        text = self.page.locator("#draftbar").inner_text()
        named = [name for name in self.CONFIRMING if re.search(rf"(?<![A-Za-z]){name}(?![A-Za-z])", text)]
        for name in named:
            self.assertTrue(self.page.locator(self.CONFIRMING[name]).is_enabled(), f"the draft bar points at {name}, which is disabled: {text}")
        return named

    def assert_apart(self, what):
        """The draft bar's state of its own: text on screen that the approved report does not contain."""
        bar = self.page.locator("#draftbar")
        expect(bar).to_be_visible()
        expect(bar).to_contain_text("승인된 판독문에 포함되지 않은 글", timeout=3000)
        expect(bar.get_by_role("button", name="View Approved Report")).to_be_visible()
        expect(bar.get_by_role("button", name="Discard Draft")).to_be_visible()
        self.assertEqual(["Addendum"], self.bar_guides(), what)

    def approved_view(self):
        """View Approved Report: the approved text as the server has it, next to the text on screen."""
        self.page.locator("#draftbar").get_by_role("button", name="View Approved Report").click()
        dialog = self.page.get_by_role("dialog", name="Approved Report", exact=True)
        expect(dialog).to_be_visible()
        column = lambda title: dialog.locator("section").filter(has=self.page.get_by_role("heading", name=re.compile(title)))
        return dialog, column("^승인본"), column("이 화면의 글")

    def test_text_typed_after_approve_is_said_to_be_outside_the_approved_report_then_and_on_every_return(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.press_then_type()
        # Then: the notice of the approval says it, naming the control that was pressed.
        said = self.late_notice(notices)
        self.assertRegex(said, "승인")
        self.assertIn("Approve", said)
        # The text is kept and nothing is locked; the bar is the state of its own and points at what can be pressed.
        self.assertEqual(self.LATER, self.editor())
        expect(self.page.locator("#findings")).to_be_editable()
        self.assert_apart("right after the approval")
        self.assertEqual(["Approve", "Save"], sorted(name for name, control in self.CONFIRMING.items()
                                                      if self.page.locator(control).is_disabled()))
        # The approved report as the server has it does not contain the sentence; the screen's text does.
        dialog, approved, mine = self.approved_view()
        expect(approved).to_contain_text(h.FIELDS["findings"])
        expect(approved).not_to_contain_text(self.LATE.strip())
        expect(mine).to_contain_text(self.LATE.strip())
        dialog.get_by_role("button", name="Close").click()
        expect(dialog).not_to_be_visible()
        self.assertEqual(self.LATER, self.editor(), "looking at the approved report changed the editor")
        # Stored as a draft on the approved version: still not in the approved report, and the bar still says so.
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == self.LATER, "the later text stored as a draft")
        self.assertEqual((1, h.FIELDS), (self.site.puts[-1]["baseVersion"], {k: self.site.report[k] for k in h.FIELDS}))
        self.assert_apart("after the autosave")
        # Another study and back.
        self.switch(h.PATIENT_B)
        expect(self.page.locator("#draftbar")).not_to_be_visible()
        self.switch(h.PATIENT)
        self.assertEqual(self.LATER, self.editor())
        self.assert_apart("after another study")
        # A new document (the next day): the same bar from the recorded facts alone, and nothing is written or asked.
        puts = len(self.site.puts)
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(self.LATER["findings"])
        self.assert_apart("in a new document")
        _, approved, mine = self.approved_view()
        expect(approved).not_to_contain_text(self.LATE.strip())
        expect(mine).to_contain_text(self.LATE.strip())
        self.page.clock.run_for(21000)
        self.page.wait_for_timeout(200)
        self.assertEqual((puts, False, []), (len(self.site.puts), self.leaving_asks(), self.dialogs),
                         "a stored draft that only differs from the approved report is not an unconfirmed edit")

    def test_text_outside_the_approved_report_goes_in_by_addendum_or_goes_away_by_discard(self):
        for way in ("Addendum", "Discard Draft"):
            with self.subTest(way=way):
                self.fresh_context()
                self.site = MultiStudySite()
                self.open_main()
                notices = self.collect_notices()
                self.select_and_type()
                self.press_then_type()
                self.late_notice(notices)
                self.assert_apart("before " + way)
                if way == "Addendum":
                    # The existing flow, by the reader's own press: the sentence is in what is sent, on the approved version.
                    self.report_menu("#b-addendum").click()
                    self.wait_until(lambda: len(self.site.commits) == 2, "the Addendum")
                    sent = self.site.commits[-1]
                    self.assertEqual(("addendum", 1, self.LATER), (sent["action"], sent["baseVersion"], {k: sent[k] for k in h.FIELDS}))
                    self.wait_until(lambda: self.site.report["version"] == 2, "the Addendum accepted")
                    expect(self.page.locator("#draftbar")).not_to_be_visible()
                    self.assertEqual((self.LATER, self.LATER), (self.editor(), {k: self.site.report[k] for k in h.FIELDS}))
                else:
                    self.dialog_answers = [True]
                    self.page.locator("#draftbar").get_by_role("button", name="Discard Draft").click()
                    expect(self.page.locator("#draftbar")).not_to_be_visible()
                    # Only the approved report is left, on screen and on the server.
                    self.assertEqual((h.FIELDS, None, h.FIELDS),
                                     (self.editor(), self.site.stored_for(h.UID), {k: self.site.report[k] for k in h.FIELDS}))
                self.assertFalse(self.leaving_asks(), "nothing of this document is left unconfirmed")

    def test_text_typed_after_approve_in_a_study_that_was_then_left_is_named_and_shown_on_return(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.press_then_type(leave=True)
        # The reader is on study B: the notice says which study it speaks of, the way the logout panel names a study.
        # It is the only place that says so until that study is opened, so it is not a notice that goes away by itself.
        left = self.page.locator("#leftnotes")
        expect(left).to_contain_text("포함되지 않았습니다")
        said = left.inner_text()
        study = self.site.study_row(h.RAD)
        for part in (h.PATIENT, study["acc"], "Approve"):
            self.assertIn(part, said)
        self.assertEqual([], [text for text, error in notices if error], "an accepted command was shown as a failure")
        self.assertEqual(EMPTY, self.editor(), "study B's editor was written by study A's answer")
        expect(self.page.locator("#draftbar")).not_to_be_visible()
        self.page.clock.run_for(60000)
        expect(left).to_contain_text(h.PATIENT)
        # Opening that study from the notice: the sentence is there, the same bar says it is not in the approved report,
        # and the notice has handed over to the bar.
        left.get_by_role("button", name="Open Study").click()
        expect(self.page.locator("#findings")).to_have_value(self.LATER["findings"])
        expect(left).to_be_empty()
        self.assertEqual(self.LATER, self.editor())
        self.assert_apart("back on the study that was left")
        dialog, approved, mine = self.approved_view()
        expect(approved).not_to_contain_text(self.LATE.strip())
        expect(mine).to_contain_text(self.LATE.strip())
        dialog.get_by_role("button", name="Close").click()
        # The write of leaving the study was made before the approval; the draft ends up standing on the approved version.
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == self.LATER
                        and self.site.rows[h.RAD["actor"]]["baseVersion"] == 1, "the later text stored on the approved version")
        self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS}, "the approved report is untouched")
        self.wait_until(lambda: not self.leaving_asks(), "the stored draft confirmed to this document")
        # A new document: the same bar for that study.
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(self.LATER["findings"])
        self.assert_apart("in a new document")
        self.assertEqual([], self.dialogs)

    def test_the_notice_about_a_study_that_was_left_stays_until_it_is_dismissed_and_asks_nothing_at_log_out(self):
        """U5CLI-F13. The notice about a study that is not on screen stays until a person closes it; closing it changes
        nothing else - the text is still that study's draft - and Log out is still one press."""
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.press_then_type(leave=True)
        left = self.page.locator("#leftnotes")
        expect(left).to_contain_text("포함되지 않았습니다")
        # Other work on study B (typing, its own autosave notices) does not take the notice away.
        self.page.locator("#findings").press_sequentially("SYN-B typed while the notice is up")
        self.page.clock.run_for(60000)
        expect(left).to_contain_text(h.PATIENT)
        self.assertEqual(1, left.get_by_role("button", name="Dismiss").count())
        left.get_by_role("button", name="Dismiss").click()
        expect(left).to_be_empty()
        self.wait_until(lambda: self.site.stored_for(h.UID) == self.LATER, "the later text is stored as study A's draft")
        self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS}, "the approved report is untouched")
        self.wait_until(lambda: not self.leaving_asks(), "every draft confirmed to this document")
        # Log out: one press, no question about the approved study.
        self.page.locator("#logout").click()
        self.wait_until(lambda: self.site.logouts, "the logout")
        self.assertEqual([], self.dialogs)

    def test_text_typed_after_approve_into_conclusion_or_recommendation_only_is_said_the_same_way(self):
        """U5CLI-F14. The text the approval did not carry may sit in any of the three fields."""
        for field in ("conclusion", "recommendation"):
            with self.subTest(field=field):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                notices = self.collect_notices()
                self.select_and_type()
                self.press_then_type(field=field)
                later = {**h.FIELDS, field: h.FIELDS[field] + self.LATE}
                self.assertIn("Approve", self.late_notice(notices))
                self.assertEqual(later, self.editor())
                self.assert_apart(f"right after the approval, the later text in {field} only")
                dialog, approved, mine = self.approved_view()
                expect(approved).not_to_contain_text(self.LATE.strip())
                expect(mine).to_contain_text(self.LATE.strip())
                dialog.get_by_role("button", name="Close").click()
                # Stored as a draft on the approved version; a new document says the same from the server's state alone.
                self.page.clock.run_for(21000)
                self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the later text stored as a draft")
                self.wait_until(lambda: not self.leaving_asks(), "the stored draft confirmed to this document")
                self.page.reload()
                expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
                self.switch(h.PATIENT)
                expect(self.page.locator("#" + field)).to_have_value(later[field])
                self.assert_apart(f"in a new document, the draft differing in {field} only")
                self.assertEqual([], self.dialogs)

    def test_an_approved_report_with_crlf_line_ends_is_not_said_to_differ_when_text_is_typed_and_taken_back(self):
        """U5CLI-F12. The editor shows CR LF as LF and that is what an autosave stores: a draft that differs from the
        approved report in its line ends only is not text outside the approved report."""
        self.open_untouched(report={"version": 1, "rs": "A", **h.FIELDS, "findings": "SYN line one\r\nSYN line two"})
        self.select_untouched()
        findings = self.page.locator("#findings")
        expect(findings).to_have_value("SYN line one\nSYN line two")
        findings.press("Control+End")
        findings.press_sequentially("x")
        findings.press("Backspace")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID), "the autosave of the text as the editor shows it")
        self.assertEqual("SYN line one\nSYN line two", self.site.stored_for(h.UID)["findings"])
        bar = self.page.locator("#draftbar")
        expect(bar).to_be_visible()
        expect(bar).not_to_contain_text("승인된 판독문에 포함되지 않은 글")
        expect(bar.get_by_role("button", name="View Approved Report")).not_to_be_visible()
        # A real difference is still said (the bar is drawn again when the changed text has been saved).
        findings.press_sequentially(" SYN-MORE")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID)["findings"].endswith("SYN-MORE"), "the autosave of the changed text")
        self.assert_apart("after a real change to the CR LF report")

    def test_text_typed_after_save_is_said_and_the_next_save_takes_it(self):
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        self.press_then_type("#b-save", "T")
        self.late_notice(notices)
        # Not an approved report: the ordinary draft bar, and what it points at can be pressed.
        bar = self.page.locator("#draftbar")
        expect(bar).to_be_visible()
        expect(bar.get_by_role("button", name="View Approved Report")).not_to_be_visible()
        self.assertIn("Save", self.bar_guides())
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 2, "the next Save")
        sent = self.site.commits[-1]
        self.assertEqual((1, self.LATER), (sent["baseVersion"], {k: sent[k] for k in h.FIELDS}))

    def test_approve_or_save_with_nothing_typed_afterwards_is_one_press_one_notice_and_no_bar(self):
        for control, rs in (("#b-approve", "A"), ("#b-save", "T")):
            with self.subTest(command=control):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                notices = self.collect_notices()
                self.select_and_type()
                self.page.locator(control).click()
                row = self.page.locator("#rows tr", has_text=h.PATIENT).first
                expect(row.get_by_role("cell", name=rs, exact=True)).to_be_visible()
                self.wait_until(lambda: notices, "the notice of the command")
                self.page.wait_for_timeout(300)
                # One notice, of success, that speaks of nothing left out; no bar, no question, no draft afterwards.
                self.assertEqual(1, len(set(notices)), notices)
                self.assertEqual([], [text for text, error in notices if error or "포함되지" in text], notices)
                expect(self.page.locator("#draftbar")).not_to_be_visible()
                expect(self.page.locator("#leftnotes")).to_be_empty()
                self.page.clock.run_for(21000)
                self.page.wait_for_timeout(200)
                self.assertEqual((1, [], [], h.FIELDS, False),
                                 (len(self.site.commits), self.site.puts, self.dialogs, self.editor(), self.leaving_asks()))

    def test_the_draft_bar_points_only_at_controls_that_can_be_pressed(self):
        approved = {"version": 1, "rs": "A", **h.FIELDS}
        cases = (("a draft of a report that is not approved", None, None, ["Approve", "Save"], False),
                 ("an addendum being written on an approved report", approved, None, ["Addendum"], True),
                 ("a stored draft that differs from the approved report, opened later", approved, self.LATER, ["Addendum"], True),
                 ("a stored draft that says what the approved report says", approved, h.FIELDS, ["Addendum"], False))
        for label, report, draft, guides, apart in cases:
            with self.subTest(state=label):
                self.open_untouched(report=report, draft=draft)
                self.select_untouched()
                if draft is None:
                    self.page.locator("#findings").press_sequentially(" SYN typed now")
                    self.page.clock.run_for(21000)
                    self.wait_until(lambda: self.site.stored_for(h.UID), "the autosave")
                expect(self.page.locator("#draftbar")).to_be_visible()
                self.assertEqual(guides, sorted(self.bar_guides()))
                view = self.page.locator("#draftbar").get_by_role("button", name="View Approved Report")
                self.assertEqual(apart, view.is_visible(), "the bar of an approved report that the screen's text differs from")
                if draft is not None:
                    # Opening a study says what is there; it marks nothing as this document's unconfirmed edit.
                    self.page.clock.run_for(21000)
                    self.page.wait_for_timeout(200)
                    self.assertEqual(([], False), (self.site.puts, self.leaving_asks()))

    def test_a_late_answer_of_view_approved_report_is_not_drawn_beside_another_selection(self):
        self.open_untouched(report={"version": 1, "rs": "A", **h.FIELDS}, draft=self.LATER)
        self.select_untouched()
        path = f"/api/studies/{h.UID}/report/versions"
        self.site.held_gets[path] = []
        self.page.locator("#draftbar").get_by_role("button", name="View Approved Report").click()
        self.wait_until(lambda: self.site.held_gets[path], "the read of the approved report")
        # A -> B -> A is not the selection the reader asked from: the answer draws nothing.
        self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        self.site.held_gets.pop(path).pop().fulfill(json=self.site.versions())
        self.page.wait_for_timeout(400)
        expect(self.page.get_by_role("dialog", name="Approved Report", exact=True)).not_to_be_visible()
        self.assertEqual(self.LATER, self.editor())
        # Asked again on this selection, it shows.
        dialog, approved, _ = self.approved_view()
        expect(approved).not_to_contain_text(self.LATE.strip())

    def test_a_busy_session_store_does_not_stop_the_autosave(self):
        self.page.clock.install()
        self.open_main()
        notices = self.collect_notices()
        self.select_and_type()
        # The server could not take the write because the login session's record was busy (409): it says to try again.
        self.site.put_answers = [(409, {"code": "AUTH_SESSION_BUSY", "message": "SYN-SERVER-WORDING busy"})]
        self.page.clock.run_for(20500)
        self.wait_until(lambda: len(self.site.puts) == 1, "the refused autosave")
        self.page.wait_for_timeout(200)
        self.page.clock.run_for(20500)
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "the next autosave stores the text")
        self.assertEqual((2, h.FIELDS), (len(self.site.puts), self.editor()))
        self.assertLessEqual(len([text for text, error in notices if error]), 1, notices)

    # ── round 7 (closure audit 2026-10-05): a draft write that waited is decided at its turn; an answer never wipes
    #    text typed after its request; an unknown outcome is not "not done"; one refused study does not block the rest ──
    DISCARDED = " SYN typed, then thrown away"

    def shown(self, page=None):
        """What the reader sees of the selected study's report: the three fields, whether the draft bar is up and
        whether it offers Discard Draft."""
        page = page or self.page
        return {"editor": self.editor(page), "bar": page.locator("#draftbar").is_visible(),
                "discard": page.locator("#b-draft-discard").is_visible()}

    def assert_reopened(self, editor, draft, what):
        """Study A as the reader finds it again - in this document, after a list read, and in a new document. `draft`:
        whether the screen says the text is a draft (the bar with Discard Draft)."""
        expected = {"editor": editor, "bar": draft, "discard": draft}
        if self.page.locator("#rows tr.sel", has_text=h.PATIENT).count():
            self.switch(h.PATIENT_B)
        self.switch(h.PATIENT)
        self.page.wait_for_timeout(500)
        self.assertEqual(expected, self.shown(), f"{what}: on coming back to the study in the same document")
        self.refresh()
        self.page.wait_for_timeout(600)
        self.assertEqual(expected, self.shown(), f"{what}: after a list read")
        other = self.watch(self.context.new_page())
        self.open_main(page=other)
        other.locator("#rows tr", has_text=h.PATIENT).first.click()
        other.wait_for_timeout(700)
        seen = self.shown(other)
        other.close()
        self.assertEqual(expected, seen, f"{what}: in a new document")

    def a_writes(self):
        """The draft writes that carried study A's typed text (the list of writes is shared with study B)."""
        return [put for put in self.site.puts if put["findings"].startswith(h.FIELDS["findings"])]

    def let_everything_go(self):
        """Two autosave periods and a list poll."""
        for _ in range(2):
            self.page.clock.run_for(21000)
            self.page.wait_for_timeout(300)

    def press_and_leave(self, control):
        """Press a confirming control of study A and move to study B before the answer; work goes on in study B."""
        self.site.commit_answers = ["hold"]
        self.page.locator(control).click()
        self.wait_until(lambda: self.site.held_commits, "the command is out")
        self.switch(h.PATIENT_B)
        self.page.locator("#findings").press_sequentially("SYN-B typed meanwhile")
        self.page.wait_for_timeout(300)
        return self.site.held_commits.pop(), self.site.commits[-1]

    def test_a_save_or_approve_accepted_after_the_study_was_left_puts_no_draft_back(self):
        """Closure audit claim 1. The write of leaving study A waits behind the Save / Approve. When its turn comes the
        text is the report: nothing is written, with the answer received or lost."""
        for control, rs in (("#b-save", "T"), ("#b-approve", "A")):
            for answer in ("received", "lost"):
                with self.subTest(command=control, answer=answer):
                    self.fresh_context()
                    self.site = MultiStudySite()
                    self.page.clock.install()
                    self.open_main()
                    notices = self.collect_notices()
                    self.select_and_type()
                    route, body = self.press_and_leave(control)
                    self.assertEqual([], self.a_writes(), "a write of study A left while its command was out")
                    getattr(self.site, "accept" if answer == "received" else "lose")(route, body, rs)
                    self.page.wait_for_timeout(800)
                    self.let_everything_go()
                    self.assertIsNone(self.site.draft_row(), "claim 1: the text just committed was stored again as a draft")
                    self.assertEqual([], self.a_writes(), "claim 1: the committed text was sent as a draft")
                    self.assertEqual((1, rs, h.FIELDS), (self.site.report["version"], self.site.report["rs"],
                                                        {k: self.site.report[k] for k in h.FIELDS}))
                    # Nothing of study A was applied to study B: its own text is on screen and stored as its own draft.
                    self.assertEqual("SYN-B typed meanwhile", self.editor()["findings"])
                    self.assertEqual("SYN-B typed meanwhile", self.site.stored_for(h.UID_B)["findings"])
                    self.assertFalse(self.leaving_asks(), "everything is stored: leaving asks nothing")
                    errors = [text for text, error in notices if error]
                    self.assertLessEqual(len(errors), 0 if answer == "received" else 1, errors)
                    self.assert_reopened(h.FIELDS, False, "claim 1")
                    self.assertEqual(1, len(self.site.commits), "the command was sent once")
                    if rs == "T":
                        # The reader's next ordinary Save stands on the version just saved; nothing is asked.
                        self.page.locator("#b-save").click()
                        self.wait_until(lambda: len(self.site.commits) == 2, "the next Save")
                        self.assertEqual(1, self.site.commits[-1]["baseVersion"])
                    self.assertEqual([], self.dialogs)

    def test_text_typed_after_the_press_and_left_is_stored_once_on_the_accepted_version(self):
        """The opposite of claim 1: text typed after pressing Save / Approve and before leaving is not what was
        committed. It is stored as a draft - by one write, standing on the version the command made."""
        for control, rs in (("#b-save", "T"), ("#b-approve", "A")):
            with self.subTest(command=control):
                self.fresh_context()
                self.site = MultiStudySite()
                self.page.clock.install()
                self.open_main()
                self.select_and_type()
                self.press_then_type(control, rs, leave=True)
                self.wait_until(lambda: self.site.stored_for(h.UID) == self.LATER, "the later text stored as a draft")
                self.let_everything_go()
                self.assertEqual([1], [put["baseVersion"] for put in self.a_writes()],
                                 "the later text is written once, on the accepted version")
                self.assertEqual({**self.LATER, "baseVersion": 1}, {k: self.site.draft_row()[k] for k in (*h.FIELDS, "baseVersion")})
                self.assertEqual(h.FIELDS, {k: self.site.report[k] for k in h.FIELDS}, "the committed report is untouched")
                self.assert_reopened(self.LATER, True, "text typed after the press")
                self.assertEqual([], self.dialogs)

    def lose_a_save(self, typed_after=False, stored=True):
        """Save of study A; the answer never arrives. `stored`: the server committed it (else the request never reached
        the server). `typed_after`: one more sentence is typed while the Save is out."""
        self.site.commit_answers = ["hold"]
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.held_commits, "Save is out")
        if typed_after:
            self.page.locator("#findings").press_sequentially(self.LATE)
        route, body = self.site.held_commits.pop(), self.site.commits[-1]
        if stored:
            self.site.lose(route, body, "T")
        else:
            route.abort("connectionreset")
        self.page.wait_for_timeout(600)

    def begin_lost_save(self):
        self.fresh_context()
        self.site = MultiStudySite()
        self.page.clock.install()
        self.open_main()
        self.select_and_type()

    def test_a_save_whose_answer_was_lost_is_not_written_again_as_a_draft(self):
        """A021. The server committed the Save; the answer was lost. The reader stays on the study: the page reads
        what the server holds before any write, so the saved text is not stored again as a draft and nothing is asked."""
        for first_read in ("answered", "failed"):
            with self.subTest(the_read_after_the_lost_answer=first_read):
                self.begin_lost_save()
                if first_read == "failed":
                    # The read right after the lost answer fails too: the autosave is what reads before it writes.
                    self.site.bootstrap_answers = ["abort"]
                self.lose_a_save()
                self.let_everything_go()
                self.assertEqual(([], None), (self.site.puts, self.site.draft_row()), "A021: the committed text was written as a draft")
                self.assertEqual({"editor": h.FIELDS, "bar": False, "discard": False}, self.shown())
                self.assertFalse(self.leaving_asks(), "the text is the saved report: leaving asks nothing")
                self.assert_reopened(h.FIELDS, False, "A021")
                self.page.locator("#b-save").click()
                self.wait_until(lambda: len(self.site.commits) == 2, "the next Save")
                self.assertEqual((1, []), (self.site.commits[-1]["baseVersion"], self.dialogs), "the next Save stands on the saved version")

    def test_log_out_after_a_save_whose_answer_was_lost_writes_no_draft_and_asks_nothing(self):
        """A021 at Log out. The read right after the lost answer fails too, so the preparation is what learns that the
        text is already the report: nothing to preserve, one press."""
        self.begin_lost_save()
        self.site.bootstrap_answers = ["abort"]
        self.lose_a_save()
        self.assertTrue(self.leaving_asks(), "the outcome is unknown: the text is still held as unconfirmed")
        self.log_out_main()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(([], None, 1, []), (self.site.puts, self.site.draft_row(), len(self.site.logouts), self.dialogs),
                         "A021: Log out wrote the committed text as a draft, or asked")

    def test_pressing_save_again_after_a_lost_answer_does_not_commit_twice_or_ask(self):
        """A021. After "the outcome could not be confirmed" the reader presses Save again. The page first reads what
        the server holds: the Save is there, so the press ends there - no second version, no dialog naming himself."""
        self.begin_lost_save()
        self.site.bootstrap_answers = ["abort"]
        self.lose_a_save()
        self.page.locator("#b-save").click()
        row = self.page.locator("#rows tr", has_text=h.PATIENT).first
        expect(row.get_by_role("cell", name="T", exact=True)).to_be_visible()
        self.page.wait_for_timeout(400)
        self.assertEqual((1, 1, []), (len(self.site.commits), self.site.report["version"], self.dialogs))
        self.assertEqual({"editor": h.FIELDS, "bar": False, "discard": False}, self.shown())
        self.let_everything_go()
        self.assertEqual(([], None), (self.site.puts, self.site.draft_row()))

    def test_a_save_that_never_reached_the_server_keeps_the_text_and_stores_it_as_a_draft(self):
        """The opposite of A021: an unknown outcome is not "done" either. The Save never reached the server, so the
        text is still this document's - it is asked about on leaving and stored by the next autosave."""
        self.begin_lost_save()
        self.lose_a_save(stored=False)
        self.assertEqual(h.FIELDS, self.editor())
        self.assertTrue(self.leaving_asks(), "the text is stored nowhere yet: leaving asks")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == h.FIELDS, "the text stored as a draft by the autosave")
        self.assertEqual((0, 0), (self.site.report["version"], self.site.draft_row()["baseVersion"]))
        self.page.locator("#b-save").click()
        self.wait_until(lambda: self.site.report["version"] == 1, "the next Save is accepted")
        self.assertEqual((0, None, []), (self.site.commits[-1]["baseVersion"], self.site.draft_row(), self.dialogs))

    def test_text_typed_after_a_save_whose_answer_was_lost_is_kept_on_the_saved_version(self):
        """A021 with later text: the server committed what was sent; the sentence typed afterwards stays on screen and
        is stored as a draft standing on the saved version."""
        self.begin_lost_save()
        self.lose_a_save(typed_after=True)
        self.assertEqual(self.LATER, self.editor(), "the text typed after the press was replaced")
        self.page.clock.run_for(21000)
        self.wait_until(lambda: self.site.stored_for(h.UID) == self.LATER, "the later text stored as a draft")
        self.assertEqual(([1], 1, h.FIELDS), ([put["baseVersion"] for put in self.site.puts], self.site.report["version"],
                                             {k: self.site.report[k] for k in h.FIELDS}))
        self.assertEqual([], self.dialogs)

    def test_recover_draft_after_a_save_whose_answer_was_lost_stores_no_draft(self):
        """A021 after the session ended: the capture of a study whose Save the server had committed is not written
        as a draft by Recover Draft - the page reads the report state under the new login first."""
        self.begin_lost_save()
        self.site.bootstrap_answers = ["abort"]
        self.lose_a_save()
        self.site.ended.add(self.site.cookie)
        self.page.evaluate("""session => {
          const channel = new BroadcastChannel('kin-session');
          channel.postMessage({type:'session-ended',session,operation:1,status:'ending'}); channel.close();
        }""", self.site.cookie)
        expect(self.panel_title()).to_have_text("Session Ended")
        self.site.account = h.RAD
        self.panel_button("Recover Draft").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(([], None, 1), (self.site.puts, self.site.draft_row(), self.site.report["version"]))

    def discard_out(self, typed_before=False):
        """Study A with a stored draft on a saved report; the reader presses Discard Draft and the server holds it."""
        self.open_untouched(report=SAVED_REPORT, draft=h.FIELDS)
        self.select_untouched()
        expect(self.page.locator("#b-draft-discard")).to_be_visible()
        if typed_before:
            self.page.locator("#findings").press("Control+End")
            self.page.locator("#findings").press_sequentially(self.DISCARDED)
        self.site.discard_answers = ["hold"]
        self.dialogs.clear()
        self.dialog_answers = [True]
        self.page.locator("#b-draft-discard").click()
        self.wait_until(lambda: self.site.held_discards, "the discard is out")

    SAVED = {k: SAVED_REPORT[k] for k in h.FIELDS}

    def test_text_typed_while_a_discard_is_out_stays_when_the_server_accepts_the_discard(self):
        """Closure audit claim 2. The answer of Discard Draft does not wipe a sentence typed after the press: it stays
        on screen as unsaved text, leaving asks, and the next autosave stores it. With nothing typed after the press
        the discard is exact."""
        for typed in (True, False):
            for answer in ("received", "lost"):
                with self.subTest(typed_after_the_press=typed, answer=answer):
                    self.discard_out()
                    if typed:
                        self.page.locator("#findings").press("Control+End")
                        self.page.locator("#findings").press_sequentially(self.LATE)
                    self.assertEqual(200, self.site.finish_discard(lost=answer == "lost"))
                    self.page.wait_for_timeout(700)
                    if not typed:
                        self.assertEqual({"editor": self.SAVED, "bar": False, "discard": False}, self.shown())
                        self.assertFalse(self.leaving_asks())
                        self.let_everything_go()
                        self.assertEqual(([], None), (self.site.puts, self.site.draft_row()), "the discarded draft was written again")
                        self.assert_reopened(self.SAVED, False, "an exact discard")
                        continue
                    self.assertEqual(self.LATER, self.editor(), "claim 2: the text typed after the press was wiped")
                    self.assertTrue(self.leaving_asks(), "claim 2: the later text is stored nowhere yet - leaving asks")
                    expect(self.page.locator("#draftbar")).to_be_visible()
                    self.page.clock.run_for(21000)
                    self.wait_until(lambda: self.site.stored_for(h.UID) == self.LATER, "the later text stored by the autosave")
                    self.assertEqual(SAVED_REPORT["version"], self.site.draft_row()["baseVersion"])
                    self.wait_until(lambda: not self.leaving_asks(), "the stored draft confirmed to this document")
                    self.assert_reopened(self.LATER, True, "claim 2")
                    self.assertEqual(1, len(self.dialogs), "only Discard Draft's own confirmation was asked")

    def test_a_discard_accepted_after_the_study_was_left_does_not_store_the_discarded_text(self):
        """Closure audit claim 3. The reader types, presses Discard Draft and moves to study B before the answer; the
        write of leaving waits behind the discard. The discarded text is not stored again - with the answer received or
        lost, and also when the first read that would confirm a lost answer fails too (the discard's outcome is then
        unknown; a later successful read tells it). A sentence typed AFTER the press is new text and is stored."""
        for typed_after in (False, True):
            for answer in ("received", "lost", "lost, first read lost too"):
                with self.subTest(typed_after_the_press=typed_after, answer=answer):
                    self.discard_out(typed_before=True)
                    if typed_after:
                        self.page.locator("#findings").press_sequentially(self.LATE)
                    self.switch(h.PATIENT_B)
                    self.page.wait_for_timeout(300)
                    self.assertEqual([], self.site.puts, "a write of study A left while its discard was out")
                    if answer == "lost, first read lost too":
                        self.site.draft_read_answers = ["abort"]       # study A's next GET draft: the confirming read
                    self.assertEqual(200, self.site.finish_discard(lost=answer != "received"))
                    self.page.wait_for_timeout(800)
                    self.let_everything_go()
                    self.assertEqual([], self.site.draft_read_answers, "the confirming read of study A was the one that failed")
                    self.assertEqual(EMPTY, self.editor(), "study B's editor was written by study A's answer")
                    if not typed_after:
                        self.assertEqual(([], None), (self.site.puts, self.site.draft_row()),
                                         "claim 3: the text the reader discarded was stored again as a draft")
                        self.assertFalse(self.leaving_asks())
                        self.assert_reopened(self.SAVED, False, "claim 3")
                        self.log_out_main()
                        self.page.wait_for_url(h.INDEX_URL)
                        self.assertEqual(([], None, 1), (self.site.puts, self.site.draft_row(), len(self.site.logouts)),
                                         "claim 3: Log out preserved the discarded text")
                        continue
                    later = {**h.FIELDS, "findings": h.FIELDS["findings"] + self.DISCARDED + self.LATE}
                    self.assertEqual((later, SAVED_REPORT["version"]), (self.site.stored_for(h.UID), self.site.draft_row()["baseVersion"]),
                                     "text typed after the press is new text and is stored")
                    self.assert_reopened(later, True, "text typed after pressing Discard Draft, then leaving")

    def test_a_discard_of_unknown_outcome_brings_back_nothing_discarded_and_keeps_what_was_typed_after(self):
        """Draft resurrection (Astra 2026-10-06): the reader types, presses Discard Draft and stays on study A; the
        server's answer is lost AND the read that would confirm it fails too - the outcome is unknown. The text up to
        the press is what the reader threw away: the 20 s autosave and Log out do not store it, and the next successful
        read shows the server's state (a new document too). A DELETE that never reached the server is not taken as
        done: the stored draft is shown again with Discard Draft. Text typed after the press is new text and is stored -
        also when it is typed after the answer, and the next successful read comes before it is stored."""
        for then in ("autosave and the next read", "Log out before any read"):
            with self.subTest(server="discarded", then=then):
                self.discard_out(typed_before=True)
                self.site.draft_read_answers = ["abort"]
                self.assertEqual(200, self.site.finish_discard(lost=True))
                self.page.wait_for_timeout(800)
                self.assertEqual([], self.site.draft_read_answers, "the confirming read was the one that failed")
                self.assertFalse(self.leaving_asks(), "the discarded text is not unsaved work")
                if then == "Log out before any read":
                    self.log_out_main()
                    self.page.wait_for_url(h.INDEX_URL)
                    self.assertEqual(([], None, 1), (self.a_writes(), self.site.draft_row(), len(self.site.logouts)),
                                     "Log out preserved the discarded text as a draft")
                    continue
                self.let_everything_go()
                self.assertEqual(([], None), (self.a_writes(), self.site.draft_row()),
                                 "the autosave stored the discarded text again as a draft")
                self.assertEqual({"editor": self.SAVED, "bar": False, "discard": False}, self.shown(),
                                 "the next read shows the discard on the screen")
                self.assert_reopened(self.SAVED, False, "a discard learnt by a later read")
        with self.subTest(server="never reached"):
            self.discard_out(typed_before=True)
            self.site.draft_read_answers = ["abort"]
            # No list read answers from here on: what the screen shows is what the discard's own outcome read learnt,
            # not a later list poll repainting the server's draft over it.
            self.site.held_lists = []
            self.site.drop_discard()
            self.page.wait_for_timeout(800)
            self.let_everything_go()
            self.assertEqual(([], h.FIELDS), (self.a_writes(), self.site.stored_for(h.UID)),
                             "nothing is written and the stored draft stays")
            self.assertEqual({"editor": h.FIELDS, "bar": True, "discard": True}, self.shown(),
                             "a lost DELETE is not taken as done: the stored draft is shown again with Discard Draft")
        with self.subTest(server="discarded", typed_after_the_press=True):
            self.discard_out(typed_before=True)
            self.page.locator("#findings").press_sequentially(self.LATE)
            self.site.draft_read_answers = ["abort"]
            self.assertEqual(200, self.site.finish_discard(lost=True))
            self.page.wait_for_timeout(800)
            self.assertTrue(self.leaving_asks(), "the text typed after the press is unsaved work")
            self.let_everything_go()
            later = {**h.FIELDS, "findings": h.FIELDS["findings"] + self.DISCARDED + self.LATE}
            self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the text typed after the press is stored")
            self.assert_reopened(later, True, "text typed after a discard of unknown outcome")
        # The same, typed only once the outcome is known to be unknown (review of 8c2cf37, F-01): the next successful
        # read tells the discard's outcome, and the sentence typed after the answer is the reader's - kept and stored.
        # The autosave write is held so that read is answered while the sentence is stored nowhere yet.
        for then in ("a redraw of the study", "the autosave period"):
            with self.subTest(server="discarded", typed_after_the_answer=True, then=then):
                self.discard_out(typed_before=True)
                self.site.draft_read_answers = ["abort"]
                self.assertEqual(200, self.site.finish_discard(lost=True))
                self.page.wait_for_timeout(800)
                self.assertEqual([], self.site.draft_read_answers, "the confirming read was the one that failed")
                self.assertFalse(self.leaving_asks(), "the discarded text is not unsaved work")
                self.page.locator("#findings").press("Control+End")
                self.page.locator("#findings").press_sequentially(self.LATE)
                self.assertTrue(self.leaving_asks(), "the text typed after the answer is unsaved work")
                later = {**h.FIELDS, "findings": h.FIELDS["findings"] + self.DISCARDED + self.LATE}
                reads = len(self.site.draft_reads)
                self.site.put_answers = ["hold"]
                if then == "a redraw of the study":
                    self.refresh()
                else:
                    self.page.clock.run_for(21000)
                self.wait_until(lambda: len(self.site.draft_reads) > reads, "the next read of study A's draft")
                self.page.wait_for_timeout(600)
                self.assertEqual(later, self.editor(), "the read of the discard's outcome took the text typed after the answer away")
                self.assertTrue(self.leaving_asks(), "the text typed after the answer is still unsaved work")
                if then == "a redraw of the study":
                    self.page.clock.run_for(21000)
                self.wait_until(lambda: self.site.held_puts, "the autosave write of the text typed after the answer")
                self.site.finish_put()
                self.wait_until(lambda: self.site.stored_for(h.UID) == later, "the text typed after the answer is stored")
                self.assert_reopened(later, True, "text typed after the answer of a discard of unknown outcome")

    def test_log_out_pressed_while_a_discard_is_out_waits_for_it_and_preserves_nothing_discarded(self):
        """Claim 3 at Log out: the preparation captures the text only after the discard's answer, so the text the
        reader threw away is not preserved as a draft. One press, nothing asked."""
        self.discard_out(typed_before=True)
        self.log_out_main()
        expect(self.panel_title()).to_have_text("Logging Out")
        self.page.wait_for_timeout(300)
        self.assertEqual([], self.site.logouts, "the logout went on before the discard was answered")
        self.assertEqual(200, self.site.finish_discard())
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual(([], None, 1, 1), (self.site.puts, self.site.draft_row(), len(self.site.logouts), len(self.dialogs)))

    def test_a_draft_edited_back_to_the_saved_text_is_stored_as_the_reader_left_it(self):
        """What is unconfirmed is decided by what this document did, not by comparing texts: a stored draft that the
        reader edits back to exactly the saved report's text is an edit, and it is stored (or the old draft returns)."""
        self.open_untouched(report=SAVED_REPORT, draft={**self.SAVED, "findings": SAVED_REPORT["findings"] + " SYN more"})
        self.select_untouched()
        expect(self.page.locator("#findings")).to_have_value(SAVED_REPORT["findings"] + " SYN more")
        self.page.locator("#findings").press("Control+End")
        for _ in " SYN more":
            self.page.locator("#findings").press("Backspace")
        self.assertEqual(self.SAVED, self.editor())
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: self.site.stored_for(h.UID) == self.SAVED, "the edit stored on leaving the study")
        self.let_everything_go()
        self.switch(h.PATIENT)
        expect(self.page.locator("#findings")).to_have_value(SAVED_REPORT["findings"])
        self.assertEqual(self.SAVED, self.site.stored_for(h.UID), "the reader's edit was not stored: the older draft is still there")

    def test_recover_draft_goes_on_past_a_study_the_server_refuses(self):
        """A020. Unconfirmed text in studies A and B when the session ends; the server refuses A's write (a standing
        refusal). Recover Draft stores B, keeps A listed with its reason and unsaved, and Discard Draft names A only."""
        refusal = (403, {"statusCode": 403, "message": "SYN no access to this study"})
        self.open_main()
        self.select_and_type()
        self.site.put_answers = [refusal]
        self.switch(h.PATIENT_B)
        self.wait_until(lambda: len(self.site.puts) == 1, "A refused on leaving it")
        self.page.fill("#findings", "SYN B recovery")
        self.site.ended.add(self.site.cookie)
        self.page.evaluate("""session => {
          const channel = new BroadcastChannel('kin-session');
          channel.postMessage({type:'session-ended',session,operation:1,status:'ending'}); channel.close();
        }""", self.site.cookie)
        expect(self.panel_title()).to_have_text("Session Ended")
        panel = self.page.locator("dialog.kin-logout")
        expect(panel).to_contain_text(h.UID)
        expect(panel).to_contain_text(h.UID_B)
        self.site.account = h.RAD
        self.site.put_answers = [refusal]
        self.panel_button("Recover Draft").click()
        self.wait_until(lambda: (self.site.stored_for(h.UID_B) or {}).get("findings") == "SYN B recovery",
                        "A020: study B is stored although study A before it was refused")
        expect(self.panel_status()).to_contain_text("그대로 있습니다")
        expect(self.panel_title()).to_have_text("Session Ended")
        # What is left is A alone, with why; B is no longer among the studies that need preserving.
        listed = panel.locator("p", has_text="보존이 필요한 검사")
        expect(listed).to_contain_text(h.UID)
        expect(listed).to_contain_text("받아들이지 않았습니다")
        self.assertNotIn(h.UID_B, listed.inner_text())
        self.assertEqual((None, []), (self.site.stored_for(h.UID), self.docs(name="index.html")), "the refused study was not declared saved")
        # Another press tries A again and does not write B a second time.
        b_writes = lambda: len([put for put in self.site.puts if put["findings"] == "SYN B recovery"])
        puts, written = len(self.site.puts), b_writes()
        self.site.put_answers = [refusal]
        self.panel_button("Recover Draft").click()
        self.wait_until(lambda: len(self.site.puts) == puts + 1, "A tried again")
        self.page.wait_for_timeout(300)
        self.assertEqual((written, None), (b_writes(), self.site.stored_for(h.UID)))
        # Discard Draft says what it discards: A only.
        self.dialog_answers = [True]
        self.panel_button("Discard Draft").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertIn(h.UID, self.dialogs[-1])
        self.assertNotIn(h.UID_B, self.dialogs[-1])
        self.assertEqual("SYN B recovery", self.site.stored_for(h.UID_B)["findings"])

    # ── round 8 (closure audit A006): Log out asks about unsaved work outside the report draft - only when there is
    #    some, in the same panel; (A015) every viewer the list opens is handed the list's session ──
    def work_viewer(self, kinds, answers=True, session=None):
        """A viewer document of the session (stand-in) that holds `kinds` of unsaved work the way viewer-session.js
        declares it. It also hears the session's notices (self.heard)."""
        page = self.viewer()
        page.evaluate(WORK_STAND_IN, [session or self.site.cookie, list(kinds), answers])
        return page

    def work_panel(self):
        panel = self.page.locator("dialog.kin-logout")
        expect(self.panel_title()).to_have_text("Unsaved Work")
        return panel

    def test_log_out_with_unsaved_viewer_work_asks_in_the_same_panel_and_names_it(self):
        """A006. The report is saved; a viewer window of the session holds an unsaved measurement and finding text.
        One press on Log out ends nothing: the panel says what would be lost. Discard and Log Out then ends."""
        self.open_main()
        viewer = self.work_viewer(["findings", "marks"])
        self.log_out_main()
        panel = self.work_panel()
        expect(panel).to_contain_text("측정")
        expect(panel).to_contain_text("소견")
        self.page.wait_for_timeout(300)
        self.assertEqual(([], []), (self.site.logouts, self.dialogs), "A006: the session ended over unsaved viewer work")
        self.assertEqual([], self.heard(viewer, "session-ended"), "the viewer was told to end")
        self.assertEqual(1, len(self.heard(viewer, "session-preparing")), "the viewer is paused while the reader is asked")
        self.assertEqual(["Back to Editing", "Discard and Log Out"], panel.get_by_role("button").all_inner_texts())
        self.panel_button("Discard and Log Out").click()
        self.page.wait_for_url(h.INDEX_URL)
        self.assertEqual((1, []), (len(self.site.logouts), self.dialogs), "the choice in the panel is the confirmation")
        self.wait_until(lambda: self.heard(viewer, "session-ended"), "the end reaches the viewer after the choice", page=viewer)

    def test_back_to_editing_from_the_unsaved_work_question_discards_nothing(self):
        """A006, the opposite mistake: Back to Editing ends nothing - the viewer resumes with its work, the session
        stays, and the page works again."""
        self.open_main()
        viewer = self.work_viewer(["jobs"])
        self.log_out_main()
        expect(self.work_panel()).to_contain_text("Job")
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.wait_until(lambda: self.heard(viewer, "session-resumed"), "the viewer is told to go on", page=viewer)
        self.assertEqual(([], []), (self.heard(viewer, "session-ended"), self.site.logouts))
        held = self.locks(viewer)["held"]
        self.assertTrue(any(name.startswith("kin-unsaved:" + self.site.cookie) for name in held), "the viewer's work is still there")
        self.assertEqual("active", self.screen()["state"])
        self.select_and_type()
        self.assertEqual(h.FIELDS, self.editor())
        self.assertEqual([], self.dialogs)

    def test_log_out_with_nothing_unsaved_asks_nothing_and_waits_for_nothing(self):
        """A006, the opposite mistakes: with nothing unsaved Log out is one press without a prompt or a question to
        other documents (the only thing it would wait for is the answer to that question) - also with a clean viewer
        open, with a viewer of another session that holds unsaved work, and after a window that held unsaved work was
        closed."""
        for case in ("a clean viewer", "another session's unsaved work", "a closed window that held unsaved work"):
            with self.subTest(case=case):
                self.fresh_context()
                self.site = MultiStudySite()
                self.open_main()
                listener = self.viewer()
                if case == "a clean viewer":
                    self.work_viewer([])
                elif case == "another session's unsaved work":
                    self.work_viewer(["marks"], session="SYN-ANOTHER-SESSION")
                else:
                    self.work_viewer(["marks"], answers=False).close()
                    # Closing a page returns before the browser has dropped that document's locks; a person cannot
                    # close a window and press Log out inside that gap. Press when the browser no longer holds the
                    # closed window's declaration (main still counts any declaration it sees - the rule is unchanged).
                    self.wait_until(lambda: not [name for name in self.locks(self.page)["held"]
                                                 if name.startswith("kin-unsaved:")],
                                    "the closed window's declaration is released by the browser")
                # Keep the sending document alive until its outgoing channel traffic has been checked.
                # The end notice can arrive on a different channel before an earlier question is delivered.
                self.site.logout_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_logouts, "the logout request without another reader action")
                self.assertEqual([], [notice for notice in self.posts() if notice.get("type") == "session-work-query"],
                                 "A006: other documents were asked (and waited for) although none declared unsaved work")
                self.release_logout()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual((1, []), (len(self.site.logouts), self.dialogs))
                self.wait_until(lambda: self.heard(listener, "session-ended"), "the end reaches the other documents", page=listener)
                self.assertEqual([], self.heard(listener, "session-work-query"),
                                 "A006: other documents were asked (and waited for) although none declared unsaved work")

    def test_no_question_goes_to_other_documents_when_nothing_was_declared(self):
        """The ordinary Log out posts nothing new on the session channel: only a declared holder is asked."""
        self.open_main()
        viewer = self.work_viewer([])
        self.log_out_main()
        self.wait_until(lambda: self.site.logouts, "the logout")
        self.assertEqual([], viewer.evaluate("() => window.__synWork.queries"))

    def test_a_document_that_declared_unsaved_work_and_does_not_answer_is_reported_as_unconfirmed(self):
        """A006: a live document that declared unsaved work but does not answer within the bound is not taken for
        clean - the panel says its state could not be confirmed, and nothing ends."""
        self.page.clock.install()
        self.open_main()
        viewer = self.work_viewer(["marks"], answers=False)
        self.log_out_main()
        self.wait_until(lambda: viewer.evaluate("() => window.__synWork.queries.length") == 1, "the question", page=viewer)
        self.assertEqual([], self.site.logouts)
        self.page.clock.run_for(2000)
        panel = self.work_panel()
        expect(panel).to_contain_text("확인하지 못했습니다")
        expect(panel).to_contain_text("측정")
        self.assertEqual([], self.site.logouts)

    def test_unsaved_report_text_is_stored_before_the_question_about_viewer_work(self):
        """A006 with typed report text: the draft is stored first (as before), then the reader is asked about the
        viewer's work; Back to Editing keeps both."""
        self.open_main()
        self.select_and_type()
        viewer = self.work_viewer(["marks"])
        self.log_out_main()
        self.work_panel()
        self.assertEqual((h.FIELDS, []), (self.site.stored_for(h.UID), self.site.logouts))
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.assertEqual((h.FIELDS, []), (self.editor(), self.dialogs))
        self.wait_until(lambda: self.heard(viewer, "session-resumed"), "the viewer goes on", page=viewer)

    def test_an_unsaved_tech_note_in_a_viewer_is_named_in_the_unsaved_work_panel(self):
        """Review DR-F01 (main's half; the viewer's side is tests/viewer_session_dom_test.py): a viewer window of the
        session declares an unsaved Tech Note. Log out asks in the same panel and names it; Back to Editing ends nothing
        and the viewer still holds its note."""
        self.open_main()
        viewer = self.work_viewer(["note"])
        self.log_out_main()
        expect(self.work_panel()).to_contain_text("Tech Note")
        self.page.wait_for_timeout(300)
        self.assertEqual(([], []), (self.site.logouts, self.dialogs), "DR-F01: the session ended over an unsaved Tech Note")
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
        self.wait_until(lambda: self.heard(viewer, "session-resumed"), "the viewer is told to go on", page=viewer)
        self.assertEqual(([], []), (self.heard(viewer, "session-ended"), self.site.logouts))
        self.assertTrue(any(name.startswith("kin-unsaved:" + self.site.cookie) and name.endswith(":note")
                            for name in self.locks(viewer)["held"]), "the viewer's note is still there")
        self.assertEqual([], self.dialogs)

    def test_a_viewer_that_declared_an_unsaved_tech_note_and_does_not_answer_is_named_as_unconfirmed(self):
        """Review DR-F01, as for the other kinds: a document that declared an unsaved Tech Note and does not answer
        within the bound is not taken for clean - the panel names the note as not confirmed, and nothing ends."""
        self.page.clock.install()
        self.open_main()
        viewer = self.work_viewer(["note"], answers=False)
        self.log_out_main()
        self.wait_until(lambda: viewer.evaluate("() => window.__synWork.queries.length") == 1, "the question", page=viewer)
        self.assertEqual([], self.site.logouts)
        self.page.clock.run_for(2000)
        panel = self.work_panel()
        expect(panel).to_contain_text("확인하지 못했습니다")
        expect(panel).to_contain_text("Tech Note")
        self.assertEqual([], self.site.logouts)

    # ── S7-U5 fix-up E (review note of the draft branch; input loss): a Tech Note typed in ANOTHER Worklist tab of the
    #    same session is asked about at Log out like a viewer's, through the same lock and answer (the real main.html
    #    on both sides) ──
    def note_tab(self, saves=None):
        """A second Worklist tab of the session with its Tech Note dialog open on the patient's study (saved note v1).
        `saves` answers the note's Save requests in order: 'hold' keeps one unanswered, 'ok' stores it."""
        tab = self.open_main(self.watch(self.context.new_page()))
        note = {"studyUid": h.UID, "version": 1, "text": "SYN saved note", "reason": "", "author": h.RAD["actor"],
                "createdAt": "2026-10-05T00:00:00Z"}
        answers, held = list(saves or []), []

        def answer(route):
            if route.request.method == "GET":
                return route.fulfill(json={"uid": h.UID, "writable": True, "note": dict(note)})
            body = route.request.post_data_json
            if (answers.pop(0) if answers else "ok") == "hold":
                return held.append(route)
            note.update(version=note["version"] + 1, text=body["text"], reason=body["reason"].strip())
            route.fulfill(json={"uid": h.UID, "writable": True, "note": dict(note)})
        tab.route("**/api/studies/*/tech-note", answer)
        tab.locator("#rows tr", has_text=h.PATIENT).first.click()
        tab.locator("#tech-note-open").click()
        expect(tab.locator("#tech-note-text")).to_have_value("SYN saved note")
        tab.held_note_saves = held
        return tab

    def declared_by(self, page, kind):
        return [name for name in self.locks(page)["held"] if name.startswith("kin-unsaved:" + self.site.cookie) and name.endswith(":" + kind)]

    def test_a_tech_note_typed_in_another_worklist_tab_is_asked_about_at_log_out(self):
        for case in ("typed, not saved", "saving, no answer yet"):
            with self.subTest(case=case):
                self.fresh_context()
                self.site = MultiStudySite()
                self.open_main()
                tab = self.note_tab(saves=["hold"] if case.startswith("saving") else [])
                tab.fill("#tech-note-text", "SYN worklist note typed in the other tab")
                if case.startswith("saving"):
                    tab.fill("#tech-note-reason", "SYN reason")
                    tab.locator("#tech-note-save").click()
                    self.wait_until(lambda: tab.held_note_saves, "the note's save is out", page=tab)
                self.wait_until(lambda: self.declared_by(self.page, "worklist-note"), "the other tab declares its note")
                self.log_out_main()
                panel = self.work_panel()
                expect(panel).to_contain_text("Worklist 탭의 Tech Note")
                self.page.wait_for_timeout(300)
                self.assertEqual(([], []), (self.site.logouts, self.dialogs), "the session ended over the other tab's note")
                # Back to Editing ends nothing; the other tab keeps its text and its declaration.
                self.panel_button("Back to Editing").click()
                expect(self.page.locator("dialog.kin-logout")).to_have_count(0)
                expect(tab.locator("#tech-note-text")).to_have_value("SYN worklist note typed in the other tab")
                self.assertTrue(self.declared_by(self.page, "worklist-note"), "the other tab still declares its note")
                self.assertEqual([], self.site.logouts)

    def test_an_opened_or_saved_tech_note_in_another_worklist_tab_asks_nothing(self):
        """The opposite side: a note opened and read but not edited, or edited and then saved (answer received), is no
        unsaved work - Log out is one press with no question and nothing waited for."""
        for case in ("opened, nothing typed", "typed and saved"):
            with self.subTest(case=case):
                self.fresh_context()
                self.site = MultiStudySite()
                self.open_main()
                tab = self.note_tab()
                if case == "typed and saved":
                    tab.fill("#tech-note-text", "SYN worklist note saved")
                    tab.fill("#tech-note-reason", "SYN reason")
                    tab.locator("#tech-note-save").click()
                    expect(tab.locator("#tech-note-status")).to_contain_text("저장되었습니다")
                tab.wait_for_timeout(700)   # past one declaration cycle (500 ms): nothing is declared
                self.assertEqual([], self.declared_by(self.page, "worklist-note"))
                self.site.logout_answers = ["hold"]
                self.log_out_main()
                self.wait_until(lambda: self.site.held_logouts, "the logout without a question")
                self.assertEqual([], [notice for notice in self.posts() if notice.get("type") == "session-work-query"],
                                 "a clean note made Log out ask (and wait for) the other tab")
                self.release_logout()
                self.page.wait_for_url(h.INDEX_URL)
                self.assertEqual((1, []), (len(self.site.logouts), self.dialogs))

    def test_a_dictated_text_in_review_is_asked_about_at_log_out(self):
        """A006: a transcript the reader has not inserted yet is unsaved work of this page."""
        self.open_untouched()
        self.site.dictation = DICTATION
        self.select_untouched()
        self.page.locator("#b-dictate").click()
        self.page.locator("#dictation-stop").click()
        expect(self.page.locator("#dictation-text")).to_have_text(DICTATED)
        self.log_out_main()
        expect(self.work_panel()).to_contain_text("받아쓰기")
        self.assertEqual([], self.site.logouts)
        self.panel_button("Back to Editing").click()
        expect(self.page.locator("#dictation-text")).to_have_text(DICTATED)
        self.assertEqual([], self.dialogs)

    def open_images(self, known):
        """Film Box for the selected study; returns the viewer window (a new one, or the one already open)."""
        if known is None:
            with self.context.expect_page() as opened:
                self.page.locator("#m-filmbox").click()
            viewer = self.watch(opened.value)
            # The page event comes with the window's first document (the blank one window.open makes); the list then
            # navigates it to the viewer. Wait for the viewer document itself to have loaded, not for that blank one.
            viewer.wait_for_url("**/ohif/viewer?**", wait_until="load")
            return viewer
        self.page.locator("#m-filmbox").click()
        return known

    def test_the_viewer_the_list_opens_is_handed_the_lists_session(self):
        """A015. The viewer window is opener-less; the list hands its session over by the window name before the
        navigation, as the clinician page does. One press, nothing in the address, the window keeps its slot name."""
        self.open_main()
        self.switch(h.PATIENT)
        viewer = self.open_images(None)
        entry = viewer.evaluate("() => window.__synEntry")
        self.assertEqual(self.site.cookie, (entry or {}).get("session"), "A015: the viewer was not told which session opened it")
        self.assertEqual([entry["name"], True], viewer.evaluate("() => [window.name, window.opener === null]"))
        self.assertNotIn(self.site.cookie, viewer.url)
        self.assertEqual(1, len(self.site.viewer_opens), "one press opened one viewer document")
        self.assertEqual([], self.dialogs)

    def test_a_second_press_while_the_viewer_is_loading_opens_no_second_window(self):
        """A015, the opposite mistake: the hand-over rides on the window's name until the viewer's first script takes it.
        A second press on the same study while that window is still loading must find the same window - not open
        another one under the slot's name."""
        self.open_main()
        self.switch(h.PATIENT)
        self.site.held_viewers = []
        with self.context.expect_page() as opened:
            self.page.locator("#m-filmbox").click()
        viewer = self.watch(opened.value)
        self.wait_until(lambda: self.site.held_viewers, "the viewer document is being loaded")
        self.page.locator("#m-filmbox").click()
        self.page.wait_for_timeout(500)
        self.assertEqual(2, len(self.context.pages), "A015: a second window was opened while the first was loading")
        self.site.held_viewers.pop().fulfill(content_type="text/html; charset=utf-8", body=VIEWER_STAND_IN)
        viewer.wait_for_function("() => window.__synEntry !== undefined && window.__synEntry !== null")
        self.assertEqual(self.site.cookie, viewer.evaluate("() => window.__synEntry.session"))
        self.assertEqual((1, []), (len(self.site.viewer_opens), self.dialogs))

    def test_reopening_from_the_list_rechecks_a_viewer_that_stopped_at_its_entry(self):
        """A015. A viewer that stopped at its entry tells the reader to open it again from the list. Doing so now
        reloads that window with a fresh hand-over (same study or another); a viewer that did not stop is only focused."""
        self.open_main()
        self.switch(h.PATIENT)
        viewer = self.open_images(None)
        # Not stopped: opening the same study again does not reload the window.
        self.open_images(viewer)
        self.page.wait_for_timeout(400)
        self.assertEqual(1, len(self.site.viewer_opens), "an ordinary reopen of the same study reloaded the viewer")
        # The viewer records that its entry stopped (what viewer-session.js keeps in its history entry).
        viewer.evaluate("""() => { window.__synEntry = 'old document';
            history.replaceState({ ...history.state, kinViewerSession: { session: null, ended: false, unresolved: true,
                                   expected: 'SYN-GONE', entryStopped: true } }, ''); }""")
        self.open_images(viewer)
        self.wait_until(lambda: len(self.site.viewer_opens) == 2, "A015: the stopped viewer is read again", page=viewer)
        viewer.wait_for_function("() => window.__synEntry && window.__synEntry !== 'old document'")
        self.assertEqual(self.site.cookie, viewer.evaluate("() => window.__synEntry.session"))
        self.assertEqual(1, len([page for page in self.context.pages if "/ohif/viewer" in page.url]), "no second window")
        self.assertEqual([], self.dialogs)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ReportTextBoundaries(name) for name in ReportTextBoundaries.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
