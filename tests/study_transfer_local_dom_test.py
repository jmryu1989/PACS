# coding: utf-8
"""S9-U4b part (c) C-01..C-08 -> REQ-S9-U4-09/10 (+ contract S9-U4p 4.4, 4.6, 4.8, 5.3, 6) -> the transfer panel.

The delivered split page (main.html, its bundle, study-transfer-local.js and every shipped asset) against the W4 flow
suite's synthetic origin (report_flow_dom_test.FlowSite, itself the logout suite's wire boundary): no stack, no product
file is modified. TransferSite adds the six S9-U4b routes with the answer shapes of the part (b) server (0d115a1:
study-transfer-local.service.ts / dicom-import-gate.service.ts publicFile, downloadView, recover): a file result carries
operationId, index, outcome, code, message, identity, writeDisposition and attempts; a request-level refusal is the
Nest error body {code?, message}. The server's wording is synthetic (SYN-...) on purpose: the panel must show whatever
message the server sends, so no case pins a Korean sentence of the server. The sentences pinned here are the contract's
own (S9-U4p 4.6, 5.3, 6) that the page itself writes.

Cases drive the page through its controls (the toolbar button, the row menus, the file chooser, the panel's buttons, the
admin form, the test clock) and read what a person sees (the panel's text, focus, dialogs) and what reached the server.

Archive start (C-06, D1489 grant): one Download press is one bound POST .../archive/grant (X-KIN-Session, X-KIN-CSRF, body
{}) and then the browser's own download of .../archive?grant=<the answered value> (no fetch of the archive, no Blob).
Chromium's download manager takes an a[download] request itself, so it never reaches the context's routes: the cases
read the download's URL (the path, and a query that is exactly the grant the server answered), check that no script
read the archive, that the value is kept nowhere (storage, panel text), that the page stayed, and then drive the states
through the status GET. Whether the real guard admits that GET is the server suite's (S9U4-B77..B80, the product's own
AuthGuard) and the live WorklistE2E case's; nothing here claims it.

Mutants: tests/study_transfer_local_mutants.py serves one-off copies of the shipped files; nothing here edits a file.
"""
import hashlib
import json
import re
import secrets
import sys
import time
import unittest
import uuid
from urllib.parse import unquote, urlparse

import auth_logout_dom_test as h
import report_flow_dom_test as rf
from playwright.sync_api import expect

TECH = {**h.RAD, "sub": "SYN-TECH-SUB", "actor": "syn-tech@synthetic.test", "user": "syn-tech@synthetic.test",
        "displayName": "SYN Tech Choi", "roles": ["technician"]}
TECH_OTHER = {**TECH, "sub": "SYN-TECH2-SUB", "displayName": "SYN Tech Choi"}   # same display name, another person
RAD_ONLY = {**h.RAD, "roles": ["radiologist"]}
RAD_TECH = {**h.RAD, "roles": ["radiologist", "technician"]}
ADMIN = {**h.RAD, "sub": "SYN-ADMIN-SUB", "actor": "syn-admin@synthetic.test", "user": "syn-admin@synthetic.test",
         "displayName": "SYN Admin Park", "roles": ["admin"]}
UID_A, UID_B, UID_C = h.UID, h.UID_B, rf.UID_C
TELE_UID = UID_C
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HTTP_OF = {"stored": 200, "already-present": 200, "unconfirmed": 202}
SENT = "서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요."
MAY_HAVE_WRITTEN = "저장된 원본과 충돌하여 완료를 확인할 수 없습니다."
CLIPBOARD = """(() => { const written = [];
  Object.defineProperty(window, '__synClipboard', { value: written });
  Object.defineProperty(navigator, 'clipboard', { configurable: true,
    value: { writeText: text => { written.push(String(text)); return Promise.resolve(); } } }); })();"""
# Every network request the page starts (fetch and XHR), so a case can tell a browser download from a script read.
FETCHES = """(() => { const seen = [];
  Object.defineProperty(window, '__synFetches', { value: seen });
  const original = window.fetch;
  window.fetch = function (input, init) { seen.push(String(input && input.url || input)); return original.apply(this, arguments); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) { seen.push(String(url)); return open.apply(this, arguments); }; })();"""


def dicom(index, size=64):
    """Synthetic file bytes: the page never reads them as DICOM, the server would."""
    head = b"SYN-DICOM-%03d-" % index
    return (head + b"x" * size)[:max(size, len(head))]


def file_result(op, index, outcome="stored", code=None, message=None, identity="matched", disposition=None,
                rechecked=None, uid=UID_A):
    attempts = [] if outcome == "rejected" and code and code.startswith(("DICOM_", "PATIENT_ID_", "MODALITY")) else [{
        "attemptId": "00000000-0000-4000-8000-%012d" % index, "generation": 1, "phase": "finished", "outcome": outcome,
        "code": code, "transport": None, "startedAt": "2026-10-17T00:00:00.000Z", "finishedAt": None,
        "autoRecheckedAt": rechecked, "recovery": None}]
    return {"operationId": op, "index": index, "outcome": outcome, "code": code,
            "message": message or ("SYN-SERVER " + (code or outcome)), "identity": identity, "writeDisposition": disposition,
            "studyUid": uid, "seriesUid": uid + ".1", "sopUid": uid + ".1.%d" % index, "sha256": "0" * 64, "bytes": 64,
            "at": "2026-10-17T00:00:00.000Z", "generation": 1, "attempts": attempts}


def status_of(result):
    if result["outcome"] in HTTP_OF:
        return HTTP_OF[result["outcome"]]
    if result["outcome"] == "retryable":
        return 503 if result["code"] == "ORTHANC_UNAVAILABLE" else 409
    return 400 if (result["code"] or "").startswith(("DICOM_", "PATIENT_ID_", "MODALITY")) else 409


def download_view(op, uid, state="prepared", objects=3, size=3 * 1048576, complete=0):
    attempts = [] if state == "prepared" else [{"attemptId": "00000000-0000-4000-9000-000000000001", "number": 1,
        "state": state, "startedAt": "2026-10-17T00:00:00.000Z", "endedAt": None if state == "sending" else "2026-10-17T00:01:00.000Z",
        "archiveSha256": "1" * 64 if state == "sent" else None, "responseFinished": state == "sent",
        "objectsComplete": complete, "bytesSupplied": 0}]
    return {"operationId": op, "studyUid": uid, "state": state, "manifestSha256": "2" * 64,
            "preparedAt": "2026-10-17T00:00:00.000Z", "objects": objects, "bytes": size,
            "note": SENT if state == "sent" else None, "attempts": attempts}


class TransferSite(rf.FlowSite):
    """The W4 flow origin plus the six S9-U4b routes, answering as the part (b) server does."""

    def __init__(self, count=3):
        super().__init__(count)
        self.imports = []               # each POST /api/dicom-import as the server received it
        self.held_imports = []          # (route, record) answered by the case
        self.import_answers = []        # per POST: a result dict | (status, body) | "hold" | "abort"
        self.import_state = {}          # operationId -> {index: result} (what the status GET answers)
        self.import_reads = []          # operationId of every status GET
        self.status_answers = []        # per status GET: (status, body) | "abort"; none queued: the stored state
        self.prepares = []              # (uid, body) of every download preparation
        self.prepare_answers = []       # per preparation: (status, body)
        self.download_state = {}        # operationId -> view
        self.download_reads = []        # operationId of every download status GET
        self.download_answers = {}      # operationId -> list of views answered in turn by its status GETs
        self.recoveries = []            # (operationId, index, body)
        self.grants = []                # each archive grant POST (D1489): uid, operation, body, its binding and CSRF headers, grant
        self.grant_answers = []         # per grant POST: (status, body) | "hold" | "abort"; none queued: a fresh grant
        self.held_grants = []           # (route, record) answered by the case
        self.recovery_answers = []      # per recovery: (status, body)
        self.tele = {TELE_UID}

    def list_body(self, account, rename=None):
        body = super().list_body(account, rename)
        for row in body["studies"]:
            row["tele"] = row["uid"] in self.tele
        return body

    def api(self, route, request, method, path, query):
        if path == "/api/dicom-import" or path.startswith(("/api/dicom-import/", "/api/admin/dicom-import/")) \
                or re.fullmatch(r"/api/studies/[^/]+/original-downloads(/[^/]+(/archive(/grant)?)?)?", path):
            account, refused = self.authenticate(request)
            if refused:
                return self.refuse(route, *refused)
            return self.transfer(route, request, method, path, account)
        return super().api(route, request, method, path, query)

    def transfer(self, route, request, method, path, account):
        if method == "POST" and path == "/api/dicom-import":
            body = request.post_data_buffer or b""
            record = {"operation": request.headers.get("x-kin-operation-id"), "index": request.headers.get("x-kin-file-index"),
                      "expect": request.headers.get("x-kin-expect-study"), "type": request.headers.get("content-type"),
                      "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body), "head": body[:14],
                      "session": request.headers.get("x-kin-session"), "account": account["sub"]}
            self.imports.append(record)
            reply = self.import_answers.pop(0) if self.import_answers else "stored"
            if reply == "hold":
                return self.held_imports.append((route, record))
            return self.answer_import(route, record, reply)
        found = re.fullmatch(r"/api/dicom-import/([^/]+)", path)
        if method == "GET" and found:
            op = found.group(1)
            self.import_reads.append(op)
            if self.status_answers:
                reply = self.status_answers.pop(0)
                return route.abort("connectionreset") if reply == "abort" else self.answer(route, *reply)
            if op not in self.import_state:
                return self.answer(route, 404, {"statusCode": 404, "message": "SYN-SERVER import not found"})
            files = [self.import_state[op][i] for i in sorted(self.import_state[op])]
            return self.answer(route, 200, {"operationId": op, "status": "open", "files": files})
        found = re.fullmatch(r"/api/admin/dicom-import/([^/]+)/files/([^/]+)/recovery", path)
        if method == "POST" and found:
            self.recoveries.append((found.group(1), found.group(2), request.post_data_json))
            reply = self.recovery_answers.pop(0) if self.recovery_answers else (200, {
                "operationId": found.group(1), "index": int(found.group(2)), "outcome": "stored", "code": None,
                "writeDisposition": None, "message": "SYN-SERVER recovered stored"})
            return self.answer(route, *reply)
        found = re.fullmatch(r"/api/studies/([^/]+)/original-downloads", path)
        if method == "POST" and found:
            uid, body = unquote(found.group(1)), request.post_data_json
            self.prepares.append((uid, body))
            if self.prepare_answers:
                return self.answer(route, *self.prepare_answers.pop(0))
            view = download_view(body["operationId"], uid)
            self.download_state[body["operationId"]] = view
            return self.answer(route, 200, view)
        found = re.fullmatch(r"/api/studies/([^/]+)/original-downloads/([^/]+)/archive/grant", path)
        if method == "POST" and found:
            record = {"uid": unquote(found.group(1)), "operation": found.group(2), "body": request.post_data_json,
                      "session": request.headers.get("x-kin-session"), "csrf": request.headers.get("x-kin-csrf"), "grant": None}
            self.grants.append(record)
            reply = self.grant_answers.pop(0) if self.grant_answers else None
            if reply == "hold":
                return self.held_grants.append((route, record))
            return self.answer_grant(route, record, reply)
        found = re.fullmatch(r"/api/studies/([^/]+)/original-downloads/([^/]+)", path)
        if method == "GET" and found:
            op = found.group(2)
            self.download_reads.append(op)
            queued = self.download_answers.get(op)
            if queued:
                self.download_state[op] = queued.pop(0)
            if op not in self.download_state:
                return self.answer(route, 404, {"statusCode": 404, "message": "SYN-SERVER download not found"})
            return self.answer(route, 200, self.download_state[op])
        self.violations.append(f"undeclared transfer request: {method} {path}")
        return route.fulfill(status=405, json={"code": "SYN_NO_WRITE"})

    def answer_import(self, route, record, reply):
        if reply == "abort":
            return route.abort("connectionreset")
        if reply == "stored":
            reply = file_result(record["operation"], int(record["index"]))
        if isinstance(reply, dict):
            self.import_state.setdefault(reply["operationId"], {})[reply["index"]] = reply
            return self.answer(route, status_of(reply), reply)
        return self.answer(route, *reply)

    def answer_grant(self, route, record, reply=None):
        if reply == "abort":
            return route.abort("connectionreset")
        if reply is None:
            record["grant"] = secrets.token_urlsafe(32)
            reply = (200, {"operationId": record["operation"], "grantId": str(uuid.uuid4()), "grant": record["grant"],
                           "expiresAt": "2026-10-17T00:02:00.000Z"})
        return self.answer(route, *reply)

    def release_import(self, reply="stored", index=0):
        route, record = self.held_imports.pop(index)
        if callable(reply):
            reply = reply(record)
        self.answer_import(route, record, reply)
        return record


class TransferPanelPage(rf.ReportFlowPage):
    """C-01..C-08 on the delivered page; only HTTP is synthetic."""

    def setUp(self):
        super().setUp()
        self.site = TransferSite(self.count)
        self.context.add_init_script(CLIPBOARD)
        self.context.add_init_script(FETCHES)
        self.downloads = []             # the URL of every download the browser started
        self.page.on("download", lambda download: self.downloads.append(download.url))

    # ── driving the page ──
    def open_as(self, account, tab=None):
        self.site.account = account
        self.open()
        if tab:
            self.page.locator(f"[data-tab={tab}]").click()

    def panel(self):
        return self.page.locator("#study-transfer")

    def operations(self):
        return self.panel().locator("section.study-transfer-op")

    def file_row(self, index, op=0):
        return self.operations().nth(op).locator(f'li[data-index="{index}"]')

    def choose(self, files, via=None):
        """The toolbar's Import DICOM (via None) or the Technician row menu of `via`, then the file chooser."""
        with self.page.expect_file_chooser() as chooser:
            if via is None:
                self.page.locator("#t-import").click()
            else:
                self.row_menu(via)
                self.menu_item("Import DICOM").click()
        chooser.value.set_files(files)

    def row_menu(self, patient):
        self.open_study_row(patient)
        self.right_click(patient)
        self.wait(self.menu_shown, "the row menu of " + patient)

    def close_menu(self):
        """A click outside the menu closes it (the page's document click handler)."""
        self.page.evaluate("() => document.body.click()")
        self.wait(lambda: not self.menu_shown(), "the menu closes")

    def files(self, count, size=64):
        return [{"name": "IM%04d" % i, "mimeType": "application/octet-stream", "buffer": dicom(i, size)} for i in range(count)]

    def state_of(self, index, op=0):
        return self.file_row(index, op).locator(".study-transfer-state").inner_text()

    def reason_of(self, index, op=0):
        row = self.file_row(index, op).locator(".study-transfer-reason")
        return row.inner_text() if row.count() else ""

    def import_writes(self):
        return [(r["operation"], r["index"]) for r in self.site.imports]

    # ── C-01 entry by role ──
    def test_c01_import_entry_shows_only_for_technician_or_admin_and_the_row_item_names_its_study(self):
        for account, shown in ((RAD_ONLY, False), (TECH, True), (ADMIN, True)):
            with self.subTest(account=account["roles"]):
                if account is not RAD_ONLY:
                    self.tearDown()
                    self.setUp()
                self.open_as(account, "Technician")
                self.assertEqual(shown, self.page.locator("#t-import").is_visible(), "C-01 toolbar Import DICOM by role")
                self.row_menu(h.PATIENT)
                self.assertEqual(1 if shown else 0, self.menu_item("Import DICOM").count(), "C-01 row item by role")
                self.close_menu()
        # The row item sends its row's study; the toolbar sends none.
        self.choose(self.files(1), via=h.PATIENT_B)
        self.wait(lambda: len(self.site.imports) == 1, "the row import")
        self.choose(self.files(1))
        self.wait(lambda: len(self.site.imports) == 2, "the toolbar import")
        self.assertEqual([UID_B, None], [r["expect"] for r in self.site.imports], "C-01 X-KIN-Expect-Study from the row only")

    # ── C-02 the upload loop ──
    def test_c02_more_than_100_files_are_refused_before_any_request(self):
        self.open_as(TECH, "Technician")
        self.choose(self.files(101, 8))
        self.settle(300)
        self.assertEqual([], self.site.imports, "C-02 nothing of a 101-file selection is sent")
        expect(self.panel()).to_contain_text("100개 파일까지")

    def test_c02_one_request_in_flight_one_operation_its_indexes_and_the_bytes_as_chosen(self):
        self.open_as(TECH, "Technician")
        self.site.import_answers = ["hold", "hold", "hold"]
        chosen = self.files(3)
        self.choose(chosen)
        for sent in (1, 2, 3):
            # Wait for any upload to be held, then count: a page that sends several at once is caught by the C-02 assertion
            # whichever moment the poll first sees them, never only by a wait that times out.
            self.wait(lambda: len(self.site.held_imports) >= 1, "upload %d out" % sent)
            self.settle(300)
            self.assertEqual(1, len(self.site.held_imports), "C-02 exactly one upload in flight")
            self.assertEqual(sent, len(self.site.imports), "C-02 exactly one upload in flight")
            self.site.release_import()
        self.wait(lambda: self.state_of(2) == "Stored", "the third result")
        ops = {r["operation"] for r in self.site.imports}
        self.assertEqual(1, len(ops), "C-02 one operation id per selection")
        self.assertRegex(ops.pop(), UUID)
        self.assertEqual(["0", "1", "2"], [r["index"] for r in self.site.imports], "C-02 file index 0..n-1")
        self.assertEqual(["application/dicom"] * 3, [r["type"] for r in self.site.imports])
        self.assertEqual([hashlib.sha256(f["buffer"]).hexdigest() for f in chosen], [r["sha256"] for r in self.site.imports],
                         "C-02 the bytes go as chosen, never parsed or changed")
        self.assertTrue(all(r["session"] for r in self.site.imports), "every upload names its session")

    def test_c02_a_retryable_file_goes_again_with_the_same_operation_index_and_bytes_and_a_final_one_never(self):
        self.open_as(TECH, "Technician")
        retryable =lambda r: file_result(r["operation"], int(r["index"]), "retryable", "ORTHANC_UNAVAILABLE")
        self.site.import_answers = ["hold", "stored"]
        self.choose(self.files(2))
        self.wait(lambda: self.site.held_imports, "the first upload")
        self.site.release_import(retryable)
        self.wait(lambda: self.state_of(1) == "Stored", "both answers")
        self.assertEqual("Retry Needed", self.state_of(0))
        self.assertEqual(0, self.file_row(1).get_by_role("button", name="Retry").count(), "C-02 a final result offers no retry")
        first = dict(self.site.imports[0])
        self.file_row(0).get_by_role("button", name="Retry", exact=True).click()
        self.wait(lambda: len(self.site.imports) == 3, "the retry")
        again = self.site.imports[2]
        self.assertEqual((first["operation"], first["index"], first["sha256"]), (again["operation"], again["index"], again["sha256"]),
                         "C-02 the retry is the same operation id, index and bytes")
        self.wait(lambda: self.state_of(0) == "Stored", "the retry's result")
        self.settle(200)
        self.assertEqual(3, len(self.site.imports), "C-02 nothing else is sent")

    def test_c02_an_unconfirmed_file_is_never_sent_again_and_the_panel_reads_the_operation(self):
        self.open_as(TECH, "Technician")
        unconfirmed = lambda r: file_result(r["operation"], int(r["index"]), "unconfirmed", "IMPORT_UNCONFIRMED")
        self.site.import_answers = ["hold"]
        self.choose(self.files(1))
        self.wait(lambda: self.site.held_imports, "the upload")
        record = self.site.release_import(unconfirmed)
        self.settle(300)
        self.assertEqual(1, len(self.site.imports), "C-02 an Unconfirmed file is never POSTed again")
        self.wait(lambda: self.state_of(0) == "Unconfirmed", "the Unconfirmed answer")
        self.assertEqual(0, self.file_row(0).get_by_role("button", name="Retry").count(), "C-02 no retry for Unconfirmed")
        self.page.clock.run_for(36000)
        self.wait(lambda: record["operation"] in self.site.import_reads, "C-02 the status read after the lease")
        self.page.clock.run_for(120000)
        self.settle(300)
        self.assertEqual(1, len(self.site.imports), "C-02 an Unconfirmed file is never POSTed again")

    # ── C-03 the result panel ──
    def test_c03_display_names_server_messages_unverified_and_may_have_written(self):
        self.open_as(TECH, "Technician")
        made = [
            lambda r: file_result(r["operation"], 0, "stored"),
            lambda r: file_result(r["operation"], 1, "already-present"),
            lambda r: file_result(r["operation"], 2, "rejected", "PATIENT_ID_MISSING", disposition=None),
            lambda r: file_result(r["operation"], 3, "retryable", "STUDY_WRITE_PENDING"),
            lambda r: file_result(r["operation"], 4, "unconfirmed", "IMPORT_UNCONFIRMED"),
            lambda r: file_result(r["operation"], 5, "stored", identity="not_comparable"),
            # The server's message for this code says "not stored"; with may-have-written the panel must not say so.
            lambda r: file_result(r["operation"], 6, "rejected", "SOP_CONTENT_CONFLICT", disposition="may-have-written",
                                  message="SYN-SERVER 파일은 저장되지 않았습니다."),
        ]
        self.site.import_answers = ["hold"] * len(made)
        self.choose(self.files(len(made)))
        for make in made:
            self.wait(lambda: self.site.held_imports, "an upload")
            self.site.release_import(make)
        self.wait(lambda: self.state_of(6) == "Rejected", "every answer")
        names = [self.state_of(i) for i in range(7)]
        self.assertEqual(["Stored", "Already Present", "Rejected", "Retry Needed", "Unconfirmed", "Stored", "Rejected"], names,
                         "C-03 the display name of each API token")
        self.assertEqual("SYN-SERVER PATIENT_ID_MISSING", self.reason_of(2), "C-03 the server's message for a refusal")
        self.assertEqual("SYN-SERVER STUDY_WRITE_PENDING", self.reason_of(3))
        self.assertEqual(1, self.file_row(5).locator(".study-transfer-mark", has_text="Unverified").count(), "C-03 Unverified mark")
        self.assertEqual(0, self.file_row(0).locator(".study-transfer-mark").count())
        self.assertEqual(MAY_HAVE_WRITTEN, self.reason_of(6), "C-03 may-have-written text")
        self.assertNotIn("저장되지 않았습니다", self.file_row(6).inner_text(), "C-03 may-have-written never says not stored")
        self.assertEqual([], self.dialogs, "C-03 no dialog")

    def test_c03_request_level_refusals_are_shown_once_per_request_never_as_outcomes(self):
        self.open_as(TECH, "Technician")
        self.site.import_answers = [(413, {"code": "DICOM_IMPORT_TOO_LARGE", "message": "SYN-SERVER too large"}),
                                    (415, {"code": "IMPORT_CONTENT_TYPE_UNSUPPORTED", "message": "SYN-SERVER content type"}),
                                    (503, {"code": "IMPORT_NOT_READY", "message": "SYN-SERVER not ready"})]
        self.choose(self.files(4))
        self.wait(lambda: len(self.site.imports) == 3, "three uploads")
        expect(self.file_row(2)).to_contain_text("SYN-SERVER not ready")
        self.settle(300)
        self.assertEqual(3, len(self.site.imports), "C-03 a request-level 503 stops the loop: the rest would be refused alike")
        for index, message in ((0, "SYN-SERVER too large"), (1, "SYN-SERVER content type"), (2, "SYN-SERVER not ready")):
            self.assertEqual("Not Sent", self.state_of(index), "C-03 a request refusal is not a file outcome")
            self.assertEqual(1, self.file_row(index).inner_text().count(message), "C-03 shown once per request")
        self.assertEqual("Not Sent", self.state_of(3), "the remaining file waits for Retry")
        for name in ("Stored", "Already Present", "Rejected", "Retry Needed", "Unconfirmed"):
            self.assertEqual(0, self.panel().locator(".study-transfer-state", has_text=re.compile("^" + name + "$")).count())

    def test_c03_c08_the_panel_never_takes_focus_opens_a_dialog_or_loses_the_draft(self):
        self.open_as(RAD_TECH)
        self.open_study(h.PATIENT)
        self.type("SYN typed findings before a download")
        self.page.locator("#findings").focus()
        self.right_click(h.PATIENT)
        self.wait(self.menu_shown, "the Radiology row menu")
        self.menu_item("Download Originals").dispatch_event("click")
        self.wait(lambda: self.site.prepares, "the preparation")
        expect(self.operations().first).to_contain_text("Ready")
        self.assertEqual("findings", self.page.evaluate("document.activeElement?.id"), "C-03 focus stays in the report editor")
        self.assertEqual("SYN typed findings before a download", self.page.locator("#findings").input_value(), "C-08 draft kept")
        self.assertEqual(0, self.page.locator("dialog[open], .modal.show").count(), "C-03 no modal")
        self.assertEqual([], self.dialogs, "C-08 no confirmation dialog")
        self.assertTrue(self.panel().is_visible())

    # ── C-04 Unconfirmed after the re-check, Copy ID ──
    def test_c04_still_unconfirmed_after_the_recheck_names_the_operation_and_copy_id_copies_it_whole(self):
        self.open_as(TECH, "Technician")
        unconfirmed = lambda r: file_result(r["operation"], int(r["index"]), "unconfirmed", "IMPORT_UNCONFIRMED")
        self.site.import_answers = ["stored", "hold"]
        self.choose(self.files(2))
        self.wait(lambda: self.site.held_imports, "the second upload")
        record = self.site.release_import(unconfirmed)
        self.wait(lambda: self.state_of(1) == "Unconfirmed", "Unconfirmed")
        self.assertEqual(0, self.file_row(1).get_by_role("button", name="Copy ID").count(), "C-04 Copy ID only after the re-check")
        self.assertEqual("SYN-SERVER IMPORT_UNCONFIRMED", self.reason_of(1), "the server's message before the re-check")
        self.page.clock.run_for(36000)
        self.wait(lambda: record["operation"] in self.site.import_reads, "the re-check")
        op = record["operation"]
        wanted = f"저장 결과를 확인하지 못했습니다. 관리자에게 작업 번호 {op[:8]}·파일 번호 1의 확인을 요청하세요."
        self.wait(lambda: self.reason_of(1) == wanted, "C-04 the after-re-check sentence")
        self.file_row(1).get_by_role("button", name="Copy ID").click()
        self.wait(lambda: self.page.evaluate("window.__synClipboard.length") == 1, "the copy")
        copied = self.page.evaluate("window.__synClipboard[0]")
        self.assertIn(op, copied, "C-04 Copy ID copies the whole operation id")
        self.assertNotEqual(op[:8], copied.split()[0], "C-04 not only the 8-character prefix")
        self.assertTrue(copied.split()[-1] == "1", "C-04 and the file number")

    # ── C-05 Resolve Unconfirmed (admin only) ──
    def test_c05_resolve_unconfirmed_is_admin_only_sends_the_closed_body_and_shows_the_answer(self):
        self.open_as(TECH, "Technician")
        self.choose(self.files(1))
        self.wait(lambda: self.site.imports, "a technician's upload")
        self.assertEqual(0, self.panel().get_by_role("button", name="Resolve Unconfirmed").count(), "C-05 hidden from a non-admin")
        self.tearDown()
        self.setUp()
        self.open_as(ADMIN, "Technician")
        self.choose(self.files(1))
        self.wait(lambda: self.site.imports, "the admin's upload")
        resolve = self.panel().get_by_role("button", name="Resolve Unconfirmed")
        expect(resolve).to_be_visible()
        resolve.click()
        op = "11111111-2222-4333-8444-555555555555"
        form = self.panel().locator("form")
        form.locator("[name=operationId]").fill(op + " 7")   # a pasted Copy ID fills both fields
        self.assertEqual("7", form.locator("[name=index]").input_value())
        form.locator("[name=basis]").select_option("orthanc-log-checked")
        form.locator("[name=checkedAt]").fill("2026-10-17T09:30")
        form.get_by_role("button", name="Resolve", exact=True).click()
        self.wait(lambda: self.site.recoveries, "the recovery request")
        rop, index, body = self.site.recoveries[0]
        self.assertEqual((op, "7"), (rop, index))
        self.assertEqual(["basis", "checkedAt"], sorted(body), "C-05 exactly the closed keys")
        self.assertEqual("orthanc-log-checked", body["basis"])
        self.assertEqual("2026-10-17T00:30:00.000Z", body["checkedAt"], "C-05 the local time as its UTC instant")
        expect(form).to_contain_text("SYN-SERVER recovered stored")
        self.site.recovery_answers = [(409, {"code": "RECOVERY_NOT_APPLICABLE", "message": "SYN-SERVER not applicable"})]
        form.get_by_role("button", name="Resolve", exact=True).click()
        expect(form).to_contain_text("SYN-SERVER not applicable")
        self.assertEqual([], self.dialogs, "C-05 no confirmation dialog")

    # ── C-06 Download Originals ──
    def test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation(self):
        self.open_as(RAD_ONLY)
        self.right_click(rf.PATIENT_C)
        self.wait(self.menu_shown, "the menu of the tele row")
        item = self.menu_item("Download Originals")
        self.assertEqual("true", item.get_attribute("aria-disabled"), "C-06 disabled on a tele row")
        item.dispatch_event("click")
        self.settle(200)
        self.assertEqual([], self.site.prepares, "C-06 a disabled item sends nothing")
        self.close_menu()
        self.row_menu(h.PATIENT)
        self.menu_item("Download Originals").click()
        self.wait(lambda: self.site.prepares, "the preparation")
        uid, body = self.site.prepares[0]
        self.assertEqual(UID_A, uid)
        self.assertEqual(["operationId"], list(body), "C-06 the closed preparation body")
        op = body["operationId"]
        self.assertRegex(op, UUID)
        box = self.operations().first
        expect(box).to_contain_text("Ready")
        self.site.download_answers[op] = [download_view(op, UID_A, "sending", complete=1), download_view(op, UID_A, "sent", complete=3)]
        page_url, before = self.page.url, len(self.page.evaluate("window.__synFetches"))
        with self.page.expect_download() as started:
            box.get_by_role("button", name="Download", exact=True).click()
        # D1489: one press = one bound grant request, then the browser's own GET with that grant and nothing else.
        self.assertEqual(1, len(self.site.grants), "C-06 one grant request per press")
        grant = self.site.grants[0]
        self.assertEqual([UID_A, op, {}, "1"], [grant["uid"], grant["operation"], grant["body"], grant["csrf"]], "C-06 the closed grant request")
        self.assertTrue(grant["session"], "C-06 the grant request is session-bound")
        # The browser's download manager takes an a[download] request itself (it never reaches the context's routes), so
        # the case reads the URL it was given.
        url = urlparse(started.value.url)
        self.assertEqual(f"/api/studies/{UID_A}/original-downloads/{op}/archive", url.path, "C-06 nothing but the UID and the id")
        self.assertEqual("grant=" + grant["grant"], url.query, "C-06 the query is exactly the answered grant")
        self.assertNotIn(h.PATIENT.split()[-1], unquote(started.value.url), "C-06 no PHI in the URL")
        fetched = self.page.evaluate("window.__synFetches")[before:]
        self.assertFalse(any(urlparse(u).path.endswith("/archive") for u in fetched),
                         "C-06 the archive GET is a browser download, never read into the page")
        self.assertEqual([f"/api/studies/{UID_A}/original-downloads/{op}/archive/grant"],
                         [urlparse(u).path for u in fetched if "/archive" in u], "C-06 the page's only archive-related request is the grant")
        kept = self.page.evaluate("() => JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)])")
        self.assertNotIn(grant["grant"], kept, "C-06 the grant is never stored")
        self.assertNotIn(grant["grant"], self.panel().inner_text(), "C-06 nor shown")
        self.assertEqual(0, self.page.locator("#study-transfer a[href]").count(), "C-06 no link with the grant is left in the page")
        self.assertEqual(page_url, self.page.url, "the page stays")
        self.page.clock.run_for(3100)
        expect(box).to_contain_text("Downloading")
        self.page.clock.run_for(3100)
        expect(box.locator(".study-transfer-state")).to_have_text("Sent")
        self.assertEqual(SENT, box.locator(".study-transfer-reason").inner_text(), "C-06 the Sent sentence")
        self.assertEqual(0, box.get_by_role("button", name="Download", exact=True).count(), "C-06 Sent is not downloaded again")
        box.get_by_role("button", name="Prepare Again").click()
        self.wait(lambda: len(self.site.prepares) == 2, "the new preparation")
        self.assertNotEqual(op, self.site.prepares[1][1]["operationId"], "C-06 after Sent a new operation")
        self.assertEqual(1, len(self.downloads), "one archive download")

    def test_c06_incomplete_and_unconfirmed_are_offered_again_for_the_same_operation(self):
        for state in ("incomplete", "unconfirmed"):
            with self.subTest(state=state):
                if state == "unconfirmed":
                    self.tearDown()
                    self.setUp()
                self.open_as(TECH, "Technician")
                self.row_menu(h.PATIENT)
                self.menu_item("Download Originals").click()
                self.wait(lambda: self.site.prepares, "the preparation")
                op = self.site.prepares[0][1]["operationId"]
                box = self.operations().first
                expect(box).to_contain_text("Ready")
                self.site.download_answers[op] = [download_view(op, UID_A, state)]
                with self.page.expect_download():
                    box.get_by_role("button", name="Download", exact=True).click()
                self.page.clock.run_for(3100)
                expect(box.locator(".study-transfer-state")).to_have_text(state.capitalize())
                with self.page.expect_download():
                    box.get_by_role("button", name="Download", exact=True).click()
                self.wait(lambda: len(self.downloads) == 2, "the second archive download")
                self.assertEqual(urlparse(self.downloads[0]).path, urlparse(self.downloads[1]).path, "C-06 the same operation again")
                self.assertIn(op, self.downloads[1])
                self.assertEqual(["grant=" + g["grant"] for g in self.site.grants], [urlparse(d).query for d in self.downloads],
                                 "C-06 each press its own new grant")
                self.assertNotEqual(self.downloads[0], self.downloads[1])
                self.assertEqual(1, len(self.site.prepares), "C-06 no new preparation")

    def test_c06_a_late_or_refused_grant_starts_nothing_and_the_status_says_why(self):
        """DG-T06 (D1489): a grant answered after the context changed clicks no link; a refused grant is a notice and a
        status read, never a logout; an expired one is known from the status summary, as the browser's own GET answers
        the page nothing. No dialog, the draft kept."""
        self.open_as(RAD_TECH)
        self.open_study(h.PATIENT)
        self.type("SYN unsaved text keeps the logout in preparation")
        self.row_menu(h.PATIENT)
        self.menu_item("Download Originals").click()
        self.wait(lambda: self.site.prepares, "the preparation")
        op = self.site.prepares[0][1]["operationId"]
        box = self.operations().first
        expect(box).to_contain_text("Ready")
        self.site.grant_answers = ["hold"]
        box.get_by_role("button", name="Download", exact=True).click()
        self.wait(lambda: self.site.held_grants, "the grant request")
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})]
        self.page.evaluate("() => document.querySelector('#logout').click()")
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
        route, record = self.site.held_grants.pop(0)
        self.site.answer_grant(route, record)
        self.settle(400)
        self.assertEqual([], self.downloads, "C-07 a grant answered during the logout preparation clicks no link")
        self.page.locator("dialog.kin-logout").get_by_role("button", name="Back to Editing", exact=True).click()
        self.wait(lambda: op in self.site.download_reads, "C-07 the status read after Back to Editing")
        self.site.grant_answers = [(409, {"code": "DOWNLOAD_IN_PROGRESS", "message": "SYN-SERVER in progress"})]
        reads = len(self.site.download_reads)
        box.get_by_role("button", name="Download", exact=True).click()
        self.wait(lambda: len(self.site.download_reads) > reads, "C-06 the state read again after a refusal")
        self.settle(200)
        # The refusal is the answer to the press: the status read that follows (no archiveRequest of its own) keeps it.
        expect(box, "C-06 a refused grant stays a notice after its status read").to_contain_text("SYN-SERVER in progress")
        self.assertEqual([], self.downloads, "C-06 a refused grant downloads nothing")
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"), "C-07 a refusal never logs out")
        view = download_view(op, UID_A)
        view["archiveRequest"] = {"grantId": str(uuid.uuid4()), "state": "expired", "expiresAt": "2026-10-17T00:02:00.000Z",
                                  "attemptId": None, "code": "DOWNLOAD_GRANT_EXPIRED", "message": "SYN-SERVER grant expired"}
        self.site.download_answers[op] = [view]
        with self.page.expect_download():
            box.get_by_role("button", name="Download", exact=True).click()
        self.page.clock.run_for(3100)
        expect(box).to_contain_text("SYN-SERVER grant expired")
        expect(box.get_by_role("button", name="Download", exact=True)).to_be_visible()
        self.assertEqual([], self.dialogs, "C-08 no dialog")
        self.assertEqual("SYN unsaved text keeps the logout in preparation", self.page.locator("#findings").input_value(), "C-08 draft kept")

    def test_c06_the_download_item_acts_only_on_the_selection_its_menu_opened_on(self):
        self.open_as(RAD_ONLY)
        self.open_study(h.PATIENT)
        self.right_click(h.PATIENT_B)
        self.wait(self.menu_shown, "the menu of B")
        self.page.evaluate("() => select(studies.find(s => s.name === 'SYN PATIENT CHARLIE').uid)")
        self.menu_item("Download Originals").dispatch_event("click")
        self.settle(300)
        self.assertEqual([], self.site.prepares, "C-06 nothing for the old or the new selection")
        expect(self.page.locator("#toast")).to_contain_text(self.MENU_CANCELLED)

    # ── C-07 late answers and account boundaries ──
    def test_c07_an_answer_from_before_a_cancelled_logout_preparation_is_not_shown_the_server_is_read_instead(self):
        self.open_as(RAD_TECH)
        self.open_study(h.PATIENT)
        self.type("SYN unsaved text keeps the logout in preparation")
        self.page.locator("[data-tab=Technician]").click()
        self.site.import_answers = ["hold"]
        self.choose(self.files(1))
        self.wait(lambda: self.site.held_imports, "the upload")
        self.site.put_answers = [(500, {"statusCode": 500, "message": "SYN"})]
        self.page.evaluate("() => document.querySelector('#logout').click()")
        expect(self.page.locator("dialog.kin-logout h2")).to_have_text("Draft Not Saved")
        op = self.site.imports[0]["operation"]
        # The late answer says Stored; the server's record (what the status read answers) says Retry Needed.
        self.site.import_state[op] = {0: file_result(op, 0, "retryable", "IMPORT_ATTEMPT_EXPIRED")}
        route, record = self.site.held_imports.pop(0)
        self.site.answer(route, 200, file_result(op, 0, "stored"))
        self.settle(300)
        self.assertNotEqual("Stored", self.state_of(0), "C-07 nothing applies during the preparation")
        self.page.locator("dialog.kin-logout").get_by_role("button", name="Back to Editing", exact=True).click()
        self.wait(lambda: op in self.site.import_reads, "C-07 the status read after Back to Editing")
        self.wait(lambda: self.state_of(0) == "Retry Needed", "the server's state")
        self.assertEqual(1, len(self.site.imports), "C-07 nothing re-sent by itself")

    def test_c07_a_network_error_keeps_the_session_and_reads_the_operation_back(self):
        self.open_as(TECH, "Technician")
        self.site.import_answers = ["abort"]
        self.choose(self.files(1))
        self.wait(lambda: self.site.imports, "the upload")
        op = self.site.imports[0]["operation"]
        self.wait(lambda: op in self.site.import_reads, "C-07 the operation read back after a lost answer")
        self.wait(lambda: self.state_of(0) == "Not Sent", "the server has no result: not sent")
        self.assertEqual("active", self.page.evaluate("KinWorkContext.state()"), "C-07 a network error never logs out")
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.file_row(0).get_by_role("button", name="Retry", exact=True).click()
        self.wait(lambda: len(self.site.imports) == 2, "the retry")
        self.assertEqual((op, "0"), (self.site.imports[1]["operation"], self.site.imports[1]["index"]))

    def test_c07_the_same_person_resumes_after_a_new_login_another_person_never_sees_the_operation(self):
        self.open_as(TECH, "Technician")
        unconfirmed = lambda r: file_result(r["operation"], int(r["index"]), "unconfirmed", "IMPORT_UNCONFIRMED")
        self.site.import_answers = ["hold"]
        self.choose(self.files(1))
        self.wait(lambda: self.site.held_imports, "the upload")
        record = self.site.release_import(unconfirmed)
        op = record["operation"]
        self.wait(lambda: self.state_of(0) == "Unconfirmed", "Unconfirmed")
        # The same immutable sub signs in again (a new session; the display name changed meanwhile).
        self.site.account = {**TECH, "displayName": "SYN Tech Choi (renamed)"}
        reads = len(self.site.import_reads)
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.page.clock.run_for(3000)
        self.wait(lambda: len(self.site.import_reads) > reads, "C-07 the same person's operation read with the new session")
        self.assertEqual(op, self.site.import_reads[-1])
        self.page.locator("[data-tab=Technician]").click()
        self.wait(lambda: self.operations().count() == 1 and self.state_of(0) == "Unconfirmed", "the resumed operation")
        # Another sub with the same display name in the same tab: nothing is read, shown or resumed.
        self.site.account = TECH_OTHER
        reads = len(self.site.import_reads)
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.page.clock.run_for(5000)
        self.settle(300)
        self.assertEqual(reads, len(self.site.import_reads), "C-07 another person never queries the prior operation")
        self.page.locator("[data-tab=Technician]").click()
        self.assertEqual(0, self.operations().count(), "C-07 nor sees it")
        self.assertIsNone(self.page.evaluate("sessionStorage.getItem('kin-study-transfer-local')"), "its record is dropped")

    # ── C-08 normal reading ──
    def test_c08_normal_reading_sends_no_transfer_request_and_shows_no_panel(self):
        self.open_as(RAD_TECH)
        self.open_study(h.PATIENT)
        self.type("SYN reading as usual")
        self.open_study(h.PATIENT_B)
        self.page.clock.run_for(60000)
        self.settle(300)
        transfer = [c for c in self.site.calls if "dicom-import" in c[1] or "original-downloads" in c[1]]
        self.assertEqual([], transfer, "C-08 no transfer request in normal reading")
        self.assertFalse(self.panel().is_visible(), "C-08 no panel")
        self.assertEqual([], self.dialogs)


def own_cases():
    """This file's cases only: the W4 flow cases it inherits its harness from run in report_flow_dom_test.py."""
    return [name for name in unittest.defaultTestLoader.getTestCaseNames(TransferPanelPage) if name in TransferPanelPage.__dict__]


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(TransferPanelPage(name) for name in own_cases())


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    names = sys.argv[1:] or own_cases()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(TransferPanelPage(n) for n in names))
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
