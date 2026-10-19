# coding: utf-8
"""S9-U4b part (c) C-01..C-08 -> REQ-S9-U4-09/10 (+ contract S9-U4p 4.4, 4.6, 4.8, 5.3, 6) -> the transfer panel.

The delivered split page (main.html, its bundle, study-transfer-local.js and every shipped asset) against the W4 flow
suite's synthetic origin (report_flow_dom_test.FlowSite, itself the logout suite's wire boundary): no stack, no product
file is modified. TransferSite adds the six S9-U4b routes with the answer shapes of the part (b) server (0d115a1:
study-transfer-local.service.ts / dicom-import-gate.service.ts publicFile, downloadView, recover): a file result carries
operationId, index, outcome, code, message, identity, writeDisposition and attempts; a request-level refusal is the
Nest error body {code?, message}. D1606 supersedes raw negative messages and result-derived retry. Negative results have neutral guidance;
only complete matching positive envelopes confirm storage or supply. The sentences pinned here are the contract's
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
from pathlib import Path
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


# Results the import gate answers before any attempt of the request (a held Study, an undetermined owner, the bytes'
# own refusals): no attempt, generation 0, no identity - as the real service answers them (S9U4-B86).
BEFORE_ATTEMPT = ("STUDY_WRITE_PENDING", "STUDY_OWNERSHIP_UNDETERMINED")
ENVELOPE = json.loads((Path(__file__).resolve().parent / "fixtures" / "s9u4-import-envelope.json").read_text(encoding="utf-8"))


def file_result(op, index, outcome="stored", code=None, message=None, identity="matched", disposition=None,
                rechecked=None, uid=UID_A, generation=1):
    before = code in BEFORE_ATTEMPT or (outcome == "rejected" and code and code.startswith(("DICOM_", "PATIENT_ID_", "MODALITY")))
    if before and identity == "matched":
        identity = None
    attempts = [] if before else [{
        "attemptId": "00000000-0000-4000-8000-%012d" % (index + 1000 * generation), "generation": generation, "phase": "finished", "outcome": outcome,
        "code": code, "transport": None, "startedAt": "2026-10-17T00:00:00.000Z", "finishedAt": "2026-10-17T00:01:00.000Z",
        "autoRecheckedAt": rechecked, "recovery": None}]
    return {"operationId": op, "index": index, "outcome": outcome, "code": code,
            "message": message or ("SYN-SERVER " + (code or outcome)), "identity": identity, "writeDisposition": disposition,
            "studyUid": uid, "seriesUid": uid + ".1", "sopUid": uid + ".1.%d" % index, "sha256": hashlib.sha256(dicom(index)).hexdigest(), "bytes": 64,
            "at": "2026-10-17T00:00:00.000Z", "generation": generation if attempts else 0, "attempts": attempts}


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
        "objectsComplete": complete, "bytesSupplied": size if state == "sent" else 0}]
    return {"operationId": op, "studyUid": uid, "state": state, "manifestSha256": "2" * 64,
            "preparedAt": "2026-10-17T00:00:00.000Z", "objects": objects, "bytes": size,
            "note": SENT if state == "sent" else None, "attempts": attempts, "archiveRequest": None}


D1606_SUPERSESSION = {'test_c02_a_retryable_file_goes_again_with_the_same_operation_index_and_bytes_and_a_final_one_never': 'R5-A01 '
                                                                                                       'mixed '
                                                                                                       'queue + '
                                                                                                       'A02 '
                                                                                                       'received '
                                                                                                       'negatives: '
                                                                                                       'same-operation '
                                                                                                       'dispatched '
                                                                                                       'retry '
                                                                                                       'superseded '
                                                                                                       'by D1606; '
                                                                                                       'original '
                                                                                                       'bytes/index/lane '
                                                                                                       'retained.',
 'test_c02_an_unconfirmed_file_is_never_sent_again_and_the_panel_reads_the_operation': 'R5-A03 ordered '
                                                                                       'missing/404/503/Stored '
                                                                                       'and A07 GET-only '
                                                                                       'reconciliation retain '
                                                                                       'no-unconfirmed-resend.',
 'test_c03_display_names_server_messages_unverified_and_may_have_written': 'R5-A02 neutral diagnostics/no raw '
                                                                           'negative messages replaces display of '
                                                                           'raw server refusals; A07 retains '
                                                                           'Already Present/Unverified.',
 'test_c03_request_level_refusals_are_shown_once_per_request_never_as_outcomes': 'R5-A02 typed/uncoded refusals: '
                                                                                 'superseded by D1606, every '
                                                                                 'dispatched nonpositive stays '
                                                                                 'unconfirmed; A01 pauses '
                                                                                 'untouched siblings.',
 'test_c04_still_unconfirmed_after_the_recheck_names_the_operation_and_copy_id_copies_it_whole': 'R5-A07-GET '
                                                                                                 'exact Copy ID '
                                                                                                 'and A03 '
                                                                                                 'read-only '
                                                                                                 'recovery retain '
                                                                                                 'identifiers; '
                                                                                                 'server recovery '
                                                                                                 'tests retained.',
 'test_c06_a_changed_manifest_offers_a_new_preparation_and_keeps_the_old_operation': 'R5-A11-valid '
                                                                                     'MANIFEST_CHANGED + A10 '
                                                                                     'distinct Prepare Again '
                                                                                     'UUID/history; old same-op '
                                                                                     'restart superseded by '
                                                                                     'D1606.',
 'test_c06_a_grant_answered_after_the_selection_moved_starts_no_download': 'R5-A12 A-B and A-B-A late-grant zero '
                                                                           'preserve selection guard '
                                                                           'independently.',
 'test_c06_a_late_or_refused_grant_starts_nothing_and_the_status_says_why': 'R5-A10 partial grant + A11 '
                                                                            'issued/expired/refused status + A12 '
                                                                            'session: neutral late/unknown '
                                                                            'handling; same-op restart superseded '
                                                                            'by D1606.',
 'test_c06_incomplete_and_unconfirmed_are_offered_again_for_the_same_operation': 'R5-A11 incomplete/unconfirmed '
                                                                                 'retention + A10 new '
                                                                                 'preparation; same-operation '
                                                                                 'redownload superseded by D1606.',
 'test_c07_a_file_restored_after_a_new_login_without_a_server_result_stays_undecided': 'R5-A03 reload after '
                                                                                       'missing/404/503 and A04 '
                                                                                       'legacy restore retain no '
                                                                                       'absence-derived '
                                                                                       'permission.',
 'test_c07_a_lost_answer_of_a_stored_file_and_a_scoped_404_is_never_not_sent': 'R5-A03 lost stored answer '
                                                                               'traverses scoped 404/503 then '
                                                                               'Stored, one POST and unchanged '
                                                                               'original.',
 'test_c07_a_network_error_keeps_the_session_and_reads_the_operation_back': 'R5-A03 network loss retains session '
                                                                            'and recovers Stored; A06 retains '
                                                                            'draft on context cancellation.',
 'test_c07_a_status_read_without_the_file_leaves_it_undecided': 'R5-A03 missing index is uncertainty, never new '
                                                                'send authority.',
 'test_c07_an_answer_from_before_a_cancelled_logout_preparation_is_not_shown_the_server_is_read_instead': 'R5-A06-context '
                                                                                                          'real '
                                                                                                          'logout '
                                                                                                          'preparation/cancel: '
                                                                                                          'late '
                                                                                                          'import '
                                                                                                          'not '
                                                                                                          'written, '
                                                                                                          'later '
                                                                                                          'GET '
                                                                                                          'only, '
                                                                                                          'draft '
                                                                                                          'preserved.',
 'test_c07_retry_only_for_a_file_never_sent_or_answered_retryable': 'R5-A01 true local sent=false and resident '
                                                                    'siblings remain continuable; server-answer '
                                                                    'retry superseded by D1606 A02.',
 'test_c07_the_same_person_resumes_after_a_new_login_another_person_never_sees_the_operation': 'R5-A06 same '
                                                                                               'issuer/sub '
                                                                                               'changed actor '
                                                                                               'reads; different '
                                                                                               'sub no '
                                                                                               'read/display/send. '
                                                                                               'Old reselection '
                                                                                               'superseded by '
                                                                                               'D1606 A04.',
 'test_r4_a01_an_answer_that_proves_nothing_never_says_not_sent_or_offers_retry': 'R5-A02 complete negative '
                                                                                  'matrix + A03 native fault '
                                                                                  'chain retain no false '
                                                                                  'non-write or automatic resend.',
 'test_r4_a02_a_malformed_or_contradicting_status_row_changes_nothing': 'R5-A07-GET each missing public field + '
                                                                        'A07 each POST field/final attempt; '
                                                                        'malformed row cannot confirm storage.',
 'test_r4_a02_missing_then_404_then_503_then_stored_by_the_status_read_only': 'R5-A03 exact ordered '
                                                                              'missing/404/503/Stored, including '
                                                                              'reload, one POST.',
 'test_r4_a03_a_lost_retry_of_a_pre_attempt_retryable_stays_undecided': 'R5-A02 generation-0 refusal never '
                                                                        'restores authority; A03 later positive '
                                                                        'GET resolves. Old second Retry action '
                                                                        'superseded by D1606.',
 'test_r4_a03_a_record_that_cannot_be_updated_stops_the_dispatch': 'R5-A05 independent get/remove/set faults + '
                                                                   'surviving legacy snapshot; '
                                                                   'storage-as-dispatch-authorization superseded '
                                                                   'by D1606.',
 'test_r4_a03_an_older_attempt_retryable_does_not_answer_a_newer_request': 'R5-A04 copied/in-flight and legacy '
                                                                           'retryable snapshots have no '
                                                                           'capability. Old browser request-2 '
                                                                           'overlap superseded by D1606; server '
                                                                           'concurrency cases retained.',
 'test_r4_a04_continuation_stays_possible_only_where_a_contract_allows_it': 'R5-A01 local first-send positive + '
                                                                            'A02 no dispatched retry + A04 no '
                                                                            'restored retry; superseded by D1606 '
                                                                            'for received/refused/reattached '
                                                                            'continuation.',
 'test_r4_a05_a_download_answer_that_proves_nothing_is_not_called_a_refusal': 'R5-A10 committed '
                                                                              'preparation/replaced answer + '
                                                                              'malformed grant; A11 poll/status '
                                                                              'uncertainty retains history; no '
                                                                              'refusal certificate.'}


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
                if reply == "abort":
                    return route.abort("connectionreset")
                if reply[0] == "raw":
                    return route.fulfill(status=reply[1], body=reply[2], content_type=reply[3])
                return self.answer(route, *reply)
            if op not in self.import_state:
                return self.answer(route, 404, {"statusCode": 404, "message": "SYN-SERVER import not found"})
            files = [{k: v for k, v in self.import_state[op][i].items() if k != "operationId"} for i in sorted(self.import_state[op])]
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
                reply = self.prepare_answers.pop(0)
                if reply[0] == "prepared-then":
                    # The server prepared the operation, then the answer was replaced on the way.
                    self.download_state[body["operationId"]] = download_view(body["operationId"], uid)
                    reply = reply[1]
                if reply[0] == "raw":
                    return route.fulfill(status=reply[1], body=reply[2], content_type=reply[3])
                return self.answer(route, *reply)
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
            view = json.loads(json.dumps(self.download_state[op]))
            # "LATEST": the server's archiveRequest is about the operation's latest grant, whichever the case pressed last.
            if isinstance(view.get("archiveRequest"), dict) and view["archiveRequest"].get("grantId") == "LATEST":
                issued = [g["grantId"] for g in self.grants if g.get("grantId")]
                view["archiveRequest"]["grantId"] = issued[-1] if issued else str(uuid.uuid4())
            return self.answer(route, 200, view)
        self.violations.append(f"undeclared transfer request: {method} {path}")
        return route.fulfill(status=405, json={"code": "SYN_NO_WRITE"})

    def answer_import(self, route, record, reply):
        if callable(reply):
            reply = reply(record)
        if isinstance(reply, tuple) and reply and reply[0] == "stored-then":
            op, index = record["operation"], int(record["index"])
            self.import_state.setdefault(op, {})[index] = file_result(op, index, "stored")
            reply = reply[1](record) if callable(reply[1]) else reply[1]
        if isinstance(reply, tuple) and reply and reply[0] == "raw":
            return route.fulfill(status=reply[1], body=reply[2], content_type=reply[3])
        if reply == "abort":
            return route.abort("connectionreset")
        if reply == "stored":
            reply = {**file_result(record["operation"], int(record["index"]), uid=record["expect"] or UID_A), "sha256": record["sha256"], "bytes": record["bytes"]}
        if isinstance(reply, dict):
            self.import_state.setdefault(reply["operationId"], {})[reply["index"]] = reply
            return self.answer(route, status_of(reply), reply)
        return self.answer(route, *reply)

    def answer_grant(self, route, record, reply=None):
        if reply == "abort":
            return route.abort("connectionreset")
        if reply is None:
            record["grant"], record["grantId"] = secrets.token_urlsafe(32), str(uuid.uuid4())
            reply = (200, {"operationId": record["operation"], "grantId": record["grantId"], "grant": record["grant"],
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


    # ── C-03 the result panel ──


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
        expect(form).to_contain_text("상태를 다시 확인")
        self.site.recovery_answers = [(409, {"code": "RECOVERY_NOT_APPLICABLE", "message": "SYN-SERVER not applicable"})]
        form.get_by_role("button", name="Resolve", exact=True).click()
        expect(form).to_contain_text("RECOVERY_NOT_APPLICABLE")
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
        self.assertNotEqual('Sent', box.locator('.study-transfer-state').inner_text(), 'C-06 native start is not Sent')
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


    # ── r4 (D1566): what an answer proves - the classifier's acceptance cases R4-A01..A05 ──
    WATCH = """() => { const seen = window.__synStates = window.__synStates || {};
      const note = () => { for (const li of document.querySelectorAll('#study-transfer li[data-index]')) {
        const op = li.closest('section')?.dataset.operation || '', key = op + ':' + li.dataset.index;
        const state = li.querySelector('.study-transfer-state')?.textContent || '';
        const retry = !!li.querySelector('button') && [...li.querySelectorAll('button')].some(b => b.textContent === 'Retry');
        (seen[key] = seen[key] || []).push(state + (retry ? '+Retry' : '')); } };
      if (!window.__synWatching) { window.__synWatching = true; new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true }); }
      note(); }"""

    def seen_states(self, op, index):
        return self.page.evaluate("k => (window.__synStates || {})[k] || []", f"{op}:{index}")

    def controls(self, op=0):
        box = self.operations().nth(op)
        return {name: box.get_by_role("button", name=name, exact=True).count() for name in ("Retry", "Retry All", "Choose Files Again", "Check Again")}

    # Each answer comes after the server stored the file (or with a body that cannot be read): none proves a non-write.
    A01_VARIANTS = [
        ("nginx-style 502 HTML", ("raw", 502, "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>", "text/html")),
        ("nginx-style 504 HTML", ("raw", 504, "<html><head><title>504 Gateway Time-out</title></head></html>", "text/html")),
        ("200 truncated JSON", ("raw", 200, '{"operationId":', "application/json")),
        ("200 empty body", ("raw", 200, "", "application/json")),
        ("200 empty object", (200, {})),
        ("503 body cut after its headers", ("raw", 503, '{"code":"IMPORT_NOT_READY","mess', "application/json")),
        ("malformed result (outcome only)", lambda r: (200, {"operationId": r["operation"], "index": int(r["index"]), "outcome": "stored"})),
        ("another operation's result", lambda r: (200, file_result(str(uuid.uuid4()), int(r["index"])))),
        ("another index's result", lambda r: (200, file_result(r["operation"], int(r["index"]) + 50))),
        ("retryable without a code", lambda r: (503, {**file_result(r["operation"], int(r["index"]), "retryable", "ORTHANC_UNAVAILABLE"), "code": None})),
        ("retryable without a disposition", lambda r: (503, {k: v for k, v in file_result(r["operation"], int(r["index"]), "retryable", "ORTHANC_UNAVAILABLE").items() if k != "writeDisposition"})),
        ("retryable + may-have-written", lambda r: (503, file_result(r["operation"], int(r["index"]), "retryable", "ORTHANC_UNAVAILABLE", disposition="may-have-written"))),
        ("an unknown outcome", lambda r: (200, {**file_result(r["operation"], int(r["index"])), "outcome": "mystery"})),
        ("an HTTP status the code does not have", lambda r: (200, file_result(r["operation"], int(r["index"]), "retryable", "ORTHANC_UNAVAILABLE"))),
        ("an uncoded 403", (403, {"statusCode": 403, "message": "Forbidden"})),
        ("an undeclared code", (418, {"code": "SYN_UNDECLARED", "message": "SYN-SERVER undeclared"})),
        ("a typed operation conflict (says nothing of the stored file)", (409, {"code": "OPERATION_CONFLICT", "message": "SYN-SERVER conflict"})),
    ]


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

    # D1606 supersedes the r4 response-derived Retry and same-operation archive restart controls.
    # Preconditions carry no assertion ID. Only direct behavior assertions below are mutant kill evidence.
    def observed(self, predicate, what="response received"):
        self.wait(predicate, what)
        self.settle(250)

    def assert_policy(self, op=0, index=0, row="R5-A02"):
        box = self.operations().nth(op)
        self.assertEqual(0, self.file_row(index, op).get_by_role("button", name="Retry", exact=True).count(), row + ": no spent retry")
        self.assertEqual(0, box.get_by_role("button", name="Choose Files Again", exact=True).count(), row + ": no reattachment")
        self.assertNotIn("저장되지 않았습니다", self.file_row(index, op).inner_text(), row + ": no non-write certificate")
        self.assertEqual("Not confirmed", self.state_of(index, op), row + ": unconfirmed state")
        self.assertEqual(1, box.get_by_role("button", name="Check Again", exact=True).count(), row + ": read available")

    def reload_transfers(self):
        self.page.reload()
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.page.clock.run_for(3000)
        self.page.locator("[data-tab=Technician]").click()
        self.settle(250)

    def prepare(self):
        before = len(self.site.prepares)
        self.row_menu(h.PATIENT)
        self.menu_item("Download Originals").click()
        self.observed(lambda: len(self.site.prepares) > before, "preparation received")
        return self.site.prepares[-1][1]["operationId"]

    def test_r5_a01_spent_file_pauses_two_unsent_siblings_and_atomic_retry_all(self):
        self.open_as(TECH, "Technician")
        self.site.import_answers = [(503, {"code": "IMPORT_NOT_READY", "message": "파일은 저장되지 않았습니다."})]
        self.choose(self.files(3))
        self.observed(lambda: self.site.imports)
        self.assertEqual(1, len(self.site.imports), "R5-A01: pause unsent siblings")
        self.assert_policy(row="R5-A01")
        self.assertEqual(["Not Sent", "Not Sent"], [self.state_of(i) for i in (1, 2)], "R5-A01: resident siblings remain unsent")
        self.site.import_answers = ["hold", "stored"]
        self.operations().first.get_by_role("button", name="Retry All", exact=True).evaluate("b => { b.click(); b.click(); }")
        self.observed(lambda: self.site.held_imports, "sibling received")
        self.assertEqual(["0", "1"], [r["index"] for r in self.site.imports], "R5-A01: atomic enqueue and one lane")
        self.site.release_import()
        self.observed(lambda: len(self.site.imports) == 3, "last sibling received")
        self.assertEqual(["Not confirmed", "Stored", "Stored"], [self.state_of(i) for i in range(3)], "R5-A01: eligible first sends succeed")
        self.assertEqual(1, len({r["operation"] for r in self.site.imports}), "R5-A01: sibling operation unchanged")

    def test_r5_a01_local_oversize_never_dispatches(self):
        self.open_as(TECH, "Technician")
        self.choose(self.files(1, 25165825))
        self.settle(300)
        self.assertEqual([], self.site.imports, "R5-A01: oversized selection zero POST")
        self.assertEqual("Not Sent", self.state_of(0), "R5-A01: local rejection")
        self.assertEqual(0, self.controls()["Retry"], "R5-A01: oversized no retry")

    def test_r5_a01_real_transport_sent_false_can_make_its_first_dispatch(self):
        # Public module host + real session transport. session:null fails before fetch; no rewritten product method.
        context=self.browser.new_context(); page=context.new_page()
        try:
            context.route('**/*',lambda r:r.fulfill(content_type='text/html',body='<button id="t-import">Import DICOM</button><div id="study-transfer"></div>'))
            page.goto('http://localhost/fixture')
            for name in ('work-context.js','session-transport.js','study-transfer-local.js'):
                source=(Path(__file__).resolve().parents[1]/'worklist-v0/hpacs-lite'/name).read_text(encoding='utf-8')
                if self.asset_source and self.asset_source[0]==name: source=self.asset_source[1]
                page.add_script_tag(content=source)
            page.evaluate('''result=>{
              const gate=KinWorkContext.create(); gate.follow({onLifecycle(fn){fn({state:'active',session:'SYN-SESSION'});}});
              window.KinWorkContext=gate; window.synBound=false; window.synRequests=[];
              const transport=KinSessionTransport.create({gate,authFailure:()=>{},fetch:async(url,init)=>{
                const headers=new Headers(init.headers); synRequests.push([headers.get('X-KIN-Operation-Id'),headers.get('X-KIN-File-Index')]);
                return new Response(JSON.stringify({...result,operationId:synRequests.at(-1)[0]}),{status:200,headers:{'Content-Type':'application/json'}});
              }});
              KinStudyTransferLocal({api:'/api',transport:{request:(url,init)=>transport.request(url,{...init,...(synBound?{}:{session:null})})},
                allowed:()=>true,identity:()=>['SYN-INST','SYN-SUB'],can:()=>true,demo:()=>false,study:()=>null});
            }''',file_result(str(uuid.uuid4()),0))
            with page.expect_file_chooser() as choice:page.locator('#t-import').click()
            choice.value.set_files(self.files(1)); page.wait_for_timeout(250)
            self.assertEqual([],page.evaluate('synRequests'),'R5-A01-local: true sent=false zero fetch')
            self.assertEqual(1,page.get_by_role('button',name='Retry',exact=True).count(),'R5-A01-local: local continuation available')
            page.evaluate('synBound=true')
            page.get_by_role('button',name='Retry',exact=True).evaluate('b=>{b.click();b.click();}')
            page.wait_for_timeout(300)
            self.assertEqual(1,len(page.evaluate('synRequests')),'R5-A01-local: exactly one first dispatch')
            self.assertEqual('Stored',page.locator('.study-transfer-state').inner_text(),'R5-A01-local: complete first-send positive')
        finally:context.close()

    def test_r5_a02_auth_lifecycle_ends_without_a_nonwrite_claim(self):
        self.open_as(TECH,'Technician'); self.page.evaluate(self.WATCH)
        self.site.import_answers=[(401,{'code':'AUTH_SESSION_ENDED','message':'SYN ended'})]
        self.choose(self.files(1)); self.observed(lambda:self.site.imports)
        self.assertEqual(0,self.operations().count(),'R5-A02-auth: session end clears private panel')
        self.assertFalse(any('Not Sent' in s or '+Retry' in s for s in self.seen_states(self.site.imports[0]['operation'],0)),
                         'R5-A02-auth: authentication answer never certifies nonwrite')

    def test_r5_a02_all_received_negatives_are_observation_only(self):
        self.open_as(TECH, "Technician")
        self.page.evaluate(self.WATCH)
        codes = ["ORTHANC_UNAVAILABLE", "IMPORT_PERMISSION_REVOKED", "IMPORT_ATTEMPT_EXPIRED", "STUDY_WRITE_PENDING",
                 "SOP_WRITE_PENDING", "STUDY_OWNERSHIP_UNDETERMINED", "RECOVERED_NO_OBJECT"]
        variants = list(self.A01_VARIANTS) + [(c, lambda r, c=c: file_result(r["operation"], 0, "retryable", c)) for c in codes]
        variants += [(c, (status, {"code": c, "message": "파일은 저장되지 않았습니다. 같은 요청으로 다시 보내세요."}))
                     for status,c in [(413,"DICOM_IMPORT_TOO_LARGE"),(400,"IMPORT_REQUEST_INVALID"),(415,"IMPORT_CONTENT_TYPE_UNSUPPORTED"),
                                      (503,"IMPORT_NOT_READY"),(503,"IMPORT_STORAGE_UNAVAILABLE"),(503,"IMPORT_ISSUER_UNCONFIGURED"),
                                      (403,"STUDY_ACCESS_RESTRICTED_IMPORT"),(403,"IMPORT_SUBJECT_MISSING")]]
        variants += [("rejected", lambda r: file_result(r["operation"],0,"rejected","SOP_CONTENT_CONFLICT",disposition="may-have-written")),
                     ("incomplete retryable", lambda r:(503,{"operationId":r["operation"],"index":0,"outcome":"retryable","code":"ORTHANC_UNAVAILABLE", "message":"x", "identity":None,"writeDisposition":None,"generation":1,"attempts":[]}))]
        for name, reply in variants:
            with self.subTest(variant=name):
                before=len(self.site.imports); reads=len(self.site.import_reads)
                self.site.import_answers=[reply]
                self.choose(self.files(1))
                self.observed(lambda:len(self.site.imports)>before)
                # Even a mutant which omits reconciliation reaches the received-answer milestone.
                self.assert_policy(row="R5-A02")
                op=self.site.imports[-1]["operation"]
                self.assertEqual(before+1,len(self.site.imports),"R5-A02: no extra old-key POST")
                self.assertGreater(len(self.site.import_reads),reads,"R5-A02: bound status read")
                self.assertFalse(any("Not Sent" in v or "Retry Needed" in v or "+Retry" in v for v in self.seen_states(op,0)),"R5-A02: no transient non-write or retry")

    def test_r5_a03_lost_answer_ordered_status_chain_then_exact_stored(self):
        self.open_as(TECH,"Technician")
        for name,reply in self.A01_VARIANTS[:6] + [("network loss","abort")]:
            with self.subTest(variant=name):
                self.site.import_answers=["hold"]; self.choose(self.files(1))
                self.observed(lambda:self.site.held_imports)
                route,record=self.site.held_imports.pop(0); op=record["operation"]
                original=record["sha256"]
                self.site.import_state[op]={0:file_result(op,0)}
                self.site.status_answers=[(200,{"operationId":op,"status":"open","files":[]})]
                before=len(self.site.imports); reads=len(self.site.import_reads)
                self.site.answer_import(route,record,("stored-then",reply))
                self.observed(lambda:len(self.site.import_reads)>reads)
                self.assert_policy(row="R5-A03")
                for status in (404,503):
                    self.site.status_answers=[(status,{"message":"synthetic unreadable"})]
                    reads=len(self.site.import_reads)
                    self.operations().first.get_by_role("button",name="Check Again",exact=True).click()
                    self.observed(lambda:len(self.site.import_reads)>reads)
                    self.assert_policy(row="R5-A03")
                self.reload_transfers()
                self.assertEqual("Stored",self.state_of(0),"R5-A03: later positive GET restores Stored")
                self.assertEqual(before,len(self.site.imports),"R5-A03: GET-only recovery")
                self.assertEqual(original,self.site.import_state[op][0]["sha256"],"R5-A03: original SHA retained")
                self.assertEqual(1,len(self.site.import_state[op]),"R5-A03: one original row")

    def test_r5_a04_real_copied_tabs_and_legacy_snapshots_are_read_only(self):
        self.open_as(TECH,"Technician")
        self.site.import_answers=["hold"]
        self.choose(self.files(2))
        self.observed(lambda:self.site.held_imports)
        op=self.site.imports[0]["operation"]
        # Ordinary window.open copies the unmodified sessionStorage before the queued sibling dispatches.
        with self.page.expect_popup() as opened:
            self.page.evaluate("url => window.open(url, '_blank')",h.MAIN_URL)
        other=opened.value
        try:
            expect(other.locator("#rows")).to_contain_text(h.PATIENT)
            other.locator("[data-tab=Technician]").click(); self.settle(300)
            box=other.locator('#study-transfer section[data-operation]').first
            self.assertEqual(0,box.get_by_role("button",name="Retry",exact=True).count(),"R5-A04: copied unsent descriptor has no capability")
            self.assertEqual(0,box.get_by_role("button",name="Choose Files Again",exact=True).count(),"R5-A04: copied operation cannot reattach")
            self.site.release_import(lambda r:file_result(op,0,"retryable","ORTHANC_UNAVAILABLE"))
            self.settle(300)
            self.assertEqual(1, len(self.site.imports), 'R5-A04: received negative pauses resident sibling')
            self.file_row(1).get_by_role("button",name="Retry",exact=True).click()
            self.observed(lambda:len(self.site.imports)==2)
            self.assertEqual(["0","1"],[r["index"] for r in self.site.imports],"R5-A04: original sibling sends once")
            with other.expect_file_chooser() as choice: other.locator('#t-import').click()
            choice.value.set_files(self.files(1)); self.observed(lambda:len(self.site.imports)>2)
            self.assertNotEqual(op,self.site.imports[-1]["operation"],"R5-A04: copied tab new selection has new UUID")
        finally: other.close()
        saved=self.page.evaluate("JSON.parse(sessionStorage.getItem('kin-study-transfer-local'))")
        for v in (1,2,3):
            saved['v']=v
            for f in saved['operations'][0]['files']: f.update(sent=False,canRetry=True,pending=None)
            self.page.evaluate("s=>sessionStorage.setItem('kin-study-transfer-local',JSON.stringify(s))",saved)
            before=len(self.site.imports); self.reload_transfers()
            self.assertEqual(0,self.controls()["Retry"],"R5-A04: legacy snapshot read-only")
            self.assertEqual(0,self.controls()["Choose Files Again"],"R5-A04: legacy no reattach")
            self.assertEqual(before,len(self.site.imports),"R5-A04: legacy zero dispatch")

    def test_r5_a05_storage_faults_cap_pressure_and_clear_preserve_uncertainty(self):
        self.open_as(TECH,"Technician")
        self.site.import_answers=["abort"]; self.choose(self.files(1))
        self.observed(lambda:self.site.import_reads)
        for methods in (["setItem"],["removeItem"],["getItem"],["setItem","removeItem","getItem"]):
            self.page.evaluate("""methods=>{ window.synStorage={}; for(const m of methods){
              const original=Storage.prototype[m]; window.synStorage[m]=original;
              Storage.prototype[m]=function(k,...rest){if(k==='kin-study-transfer-local')throw new Error('synthetic storage'); return original.call(this,k,...rest);};}}""",methods)
            before=len(self.site.imports); self.site.import_answers=["abort"]; self.choose(self.files(1))
            self.settle(250)
            self.assertEqual(before + 1, len(self.site.imports), 'R5-A05: storage never governs fresh dispatch authority')
            self.assert_policy(row="R5-A05")
            if "setItem" in methods: self.assertIn("보존하지 못했습니다",self.panel().inner_text(),"R5-A05: persistence failure disclosed")
            self.page.evaluate("() => {for(const [m,f] of Object.entries(window.synStorage)) Storage.prototype[m]=f;}")
            self.reload_transfers()
            self.assertEqual(0,self.controls()["Retry"],"R5-A05: old surviving snapshot read-only")
        for i in range(22):
            before=len(self.site.imports); self.site.import_answers=["abort"]; self.choose(self.files(1))
            self.observed(lambda:len(self.site.imports)>before)
        ids=self.operations().evaluate_all("nodes=>nodes.map(n=>n.dataset.operation)")
        self.assertGreater(len(ids),20,"R5-A05: more than 20 unconfirmed rows")
        stored=self.page.evaluate("JSON.parse(sessionStorage.getItem('kin-study-transfer-local')).operations.map(o=>o.id)")
        self.assertEqual(set(ids),set(stored),"R5-A05: pending descriptors never pruned")
        self.assertTrue(self.panel().get_by_role("button",name="Clear Finished",exact=True).is_disabled(),"R5-A05: uncertainty not clearable")
        self.reload_transfers()
        self.assertEqual(set(ids),set(self.operations().evaluate_all("nodes=>nodes.map(n=>n.dataset.operation)")),"R5-A05: pending history restores")

    def test_r5_a06_same_owner_changed_actor_reads_different_owner_never_queries(self):
        self.open_as(TECH,"Technician")
        self.site.import_answers=[lambda r:file_result(r['operation'],0,'retryable','STUDY_WRITE_PENDING')]
        self.choose(self.files(1)); self.observed(lambda:self.site.imports)
        op=self.site.imports[0]['operation']
        self.site.account={**TECH,'actor':'renamed@synthetic.test','displayName':'renamed'}
        self.reload_transfers(); self.assert_policy(row="R5-A06")
        self.site.import_state[op]={0:file_result(op,0)}
        reads=len(self.site.import_reads); self.operations().first.get_by_role('button',name='Check Again',exact=True).click()
        self.observed(lambda:len(self.site.import_reads)>reads)
        self.assertEqual('Stored',self.state_of(0),'R5-A06: same owner status-only recovery')
        self.site.account={**TECH_OTHER,'actor':TECH['actor']}; reads=len(self.site.import_reads)
        self.reload_transfers()
        self.assertEqual(reads,len(self.site.import_reads),'R5-A06: other owner no query')
        self.assertEqual(0,self.operations().count(),'R5-A06: other owner no display')
        self.assertEqual(1,len(self.site.imports),'R5-A06: no restored POST')

    def test_r5_a06_cancelled_logout_discards_late_import_and_preserves_draft(self):
        self.open_as(RAD_TECH); self.open_study(h.PATIENT)
        self.type('SYN unsaved findings remain')
        self.page.locator('[data-tab=Technician]').click()
        self.site.import_answers=['hold']; self.choose(self.files(1)); self.observed(lambda:self.site.held_imports)
        op=self.site.imports[-1]['operation']
        self.site.put_answers=[(500,{'message':'synthetic save failure'})]
        self.page.evaluate("() => document.querySelector('#logout').click()")
        expect(self.page.locator('dialog.kin-logout h2')).to_have_text('Draft Not Saved')
        self.site.import_state[op]={0:file_result(op,0,'retryable','IMPORT_ATTEMPT_EXPIRED')}
        route,record=self.site.held_imports.pop(0); self.site.answer(route,200,file_result(op,0)); self.settle(250)
        self.assertNotEqual('Stored',self.state_of(0),'R5-A06-context: no late import during logout preparation')
        self.page.locator('dialog.kin-logout').get_by_role('button',name='Back to Editing',exact=True).click()
        self.observed(lambda:self.site.import_reads)
        self.assert_policy(row='R5-A06-context')
        self.assertEqual('SYN unsaved findings remain',self.page.locator('#findings').input_value(),'R5-A06-context: draft preserved')
        self.assertEqual(1,len(self.site.imports),'R5-A06-context: no old-file resend')

    def test_r5_a07_status_positive_fields_and_preserved_final(self):
        self.open_as(TECH,'Technician'); self.site.import_answers=['stored','abort']; self.choose(self.files(2))
        self.observed(lambda:len(self.site.imports)==2)
        op=self.site.imports[-1]['operation']
        self.assertEqual('Stored',self.state_of(0),'R5-A07-GET: genuine prior positive')
        good=file_result(op,1); good.pop('operationId')
        for field in ENVELOPE['status_file']:
            bad={**good}; bad.pop(field)
            self.site.status_answers=[(200,{'operationId':op,'status':'open','files':[bad]})]
            self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(250)
            self.assertEqual('Stored',self.state_of(0),'R5-A07-GET: uncertainty never downgrades final')
            self.assert_policy(index=1,row='R5-A07-GET')
        self.file_row(1).get_by_role('button',name='Copy ID',exact=True).click(); self.settle(100)
        self.assertEqual(op+' 1',self.page.evaluate('window.__synClipboard[0]'),'R5-A07-GET: Copy ID keeps full operation/index')
        self.site.import_state[op][1]=file_result(op,1)
        self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(250)
        self.assertEqual('Stored',self.state_of(1),'R5-A07-GET: exact later positive accepted')

    def test_r5_a07_each_import_positive_field_and_final_attempt_are_required(self):
        self.open_as(TECH,'Technician')
        mutations=[('missing '+k,lambda r,k=k:r.pop(k)) for k in ENVELOPE['post_file']]
        mutations += [('wrong '+k,lambda r,k=k:r.__setitem__(k,False)) for k in ENVELOPE['post_file']]
        mutations += [('attempt missing '+k,lambda r,k=k:r['attempts'][-1].pop(k)) for k in ENVELOPE['attempt']]
        mutations += [('wrong SHA',lambda r:r.update(sha256='f'*64)),('wrong size',lambda r:r.update(bytes=65)),
                      ('contradiction',lambda r:r['attempts'][-1].update(outcome='retryable',code='ORTHANC_UNAVAILABLE'))]
        for label,mutate in mutations:
            with self.subTest(field=label):
                self.site.import_answers=['hold']; self.choose(self.files(1)); self.observed(lambda:self.site.held_imports)
                route,record=self.site.held_imports.pop(0); op=record['operation']; bad=file_result(op,0); mutate(bad)
                self.site.answer(route,200,bad)
                self.observed(lambda:self.state_of(0) not in ('Waiting','Sending'), 'import answer settled')
                # Assert this response before looking for controls that a false positive can remove.
                self.assertEqual('Not confirmed',self.state_of(0),'R5-A07: unconfirmed state')
                self.assert_policy(row='R5-A07')
                clear=self.panel().get_by_role('button',name='Clear Finished',exact=True)
                if clear.is_enabled(): clear.click()
                self.assertEqual(1,self.panel().locator(f'section[data-operation="{op}"]').count(),
                                 'R5-A07: malformed positive not clearable')

    def test_r5_a07_duplicate_positive_indexes_remain_unconfirmed(self):
        self.open_as(TECH,'Technician'); self.site.import_answers=['abort']; self.choose(self.files(1))
        self.observed(lambda:self.site.import_reads)
        op=self.site.imports[-1]['operation']; good=file_result(op,0); good.pop('operationId')
        for n in (2,3):
            self.site.status_answers=[(200,{'operationId':op,'status':'open','files':[good]*n})]
            reads=len(self.site.import_reads); self.operations().first.get_by_role('button',name='Check Again',exact=True).click()
            self.observed(lambda:len(self.site.import_reads)>reads); self.assert_policy(row='R5-A07')

    def test_r5_a07_complete_positive_and_dedup_are_accepted(self):
        self.open_as(TECH,'Technician'); self.site.import_answers=['abort']; self.choose(self.files(1))
        self.observed(lambda:self.site.import_reads)
        op=self.site.imports[-1]['operation']
        self.site.import_state[op]={0:file_result(op,0)}
        self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(250)
        self.assertEqual('Stored',self.state_of(0),'R5-A07: complete immutable positive accepted')
        self.site.import_answers=[lambda r:file_result(r['operation'],0,'already-present',identity='not_comparable')]
        self.choose(self.files(1)); self.settle(300)
        self.assertEqual('Already Present',self.state_of(0),'R5-A07: truthful dedup label')
        self.assertEqual('Unverified',self.file_row(0).locator('.study-transfer-mark').inner_text(),'R5-A07: identity label')

    def test_r5_a08_explicit_reimport_keeps_old_operation(self):
        self.open_as(TECH,'Technician'); self.site.import_answers=['abort']
        self.choose(self.files(1)); self.observed(lambda:self.site.import_reads)
        old=self.site.imports[0]['operation']
        self.assertEqual(1, self.operations().first.get_by_role('button', name='Import Again', exact=True).count(),
                         'R5-A08: explicit new selection action available')
        with self.page.expect_file_chooser() as choice: self.operations().first.get_by_role('button',name='Import Again',exact=True).click()
        choice.value.set_files(self.files(1)); self.observed(lambda:len(self.site.imports)==2)
        self.assertNotEqual(old,self.site.imports[1]['operation'],'R5-A08: new UUID')
        self.assertEqual(self.site.imports[0]['sha256'],self.site.imports[1]['sha256'],'R5-A08: unchanged bytes')
        self.assertEqual(old,self.operations().nth(1).get_attribute('data-operation'),'R5-A08: old operation retained')
        self.assert_policy(op=1,row='R5-A08')

    def test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears(self):
        self.open_as(RAD_ONLY)
        self.site.prepare_answers=[('prepared-then',(502,{'code':'SYN_PROXY_REPLACED','message':'not started'}))]
        op=self.prepare()
        self.assertFalse(self.panel().get_by_role('button', name='Clear Finished', exact=True).is_enabled(),
                         'R5-A10: uncertain preparation cannot be discarded')
        self.assertEqual('Ready',self.operations().first.locator('.study-transfer-state').inner_text(),'R5-A10: first preparation recovered by GET')
        self.site.grant_answers=[(200,{'operationId':op})]
        self.operations().first.get_by_role('button',name='Download',exact=True).click()
        self.observed(lambda:self.site.grants)
        self.assertEqual([],self.downloads,'R5-A10: invalid grant zero native click')
        self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A10: prepared GET cannot reset grant budget')
        for i in range(2):
            self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(200)
        self.assertEqual(1,len(self.site.grants),'R5-A10: Check Again is GET only')
        self.assertTrue(self.panel().get_by_role('button',name='Clear Finished',exact=True).is_disabled(),'R5-A10: uncertain operation retained')
        self.operations().first.get_by_role('button',name='Prepare Again',exact=True).click(); self.settle(250)
        self.assertEqual(2,len(self.site.prepares),'R5-A10: explicit new preparation works')
        self.assertNotEqual(op,self.site.prepares[1][1]['operationId'],'R5-A10: new preparation UUID')
        self.assertEqual(op,self.operations().nth(1).get_attribute('data-operation'),'R5-A10: old operation not replaced')
        with self.page.expect_download(): self.operations().first.get_by_role('button',name='Download',exact=True).click()
        self.assertEqual(1,len(self.downloads),'R5-A10: fresh operation downloads once')

    def test_r5_a10_every_partial_or_mismatched_grant_has_zero_native_click(self):
        self.open_as(RAD_ONLY)
        for field in ('operationId','grantId','grant','expiresAt'):
            for mode in ('missing','wrong-type'):
                op=self.prepare(); token=secrets.token_urlsafe(32)
                reply={'operationId':op,'grantId':str(uuid.uuid4()),'grant':token,'expiresAt':'2026-10-17T00:02:00.000Z'}
                if mode=='missing':reply.pop(field)
                else:reply[field]=17
                self.site.grant_answers=[(200,reply)]
                before=len(self.site.grants); self.operations().first.get_by_role('button',name='Download',exact=True).click()
                self.observed(lambda:len(self.site.grants)>before)
                self.assertEqual([],self.downloads,'R5-A10-grant: malformed grant zero native clicks')
                self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A10-grant: malformed grant cannot rearm')

    def test_r5_a12_read_sequence_and_pagehide_discard_valid_grant(self):
        self.open_as(RAD_ONLY); op=self.prepare()
        self.page.evaluate("window.synReadButton=[...document.querySelectorAll('#study-transfer button')].find(b=>b.textContent==='Check Again')")
        self.site.grant_answers=['hold']; self.operations().first.get_by_role('button',name='Download',exact=True).click()
        self.observed(lambda:self.site.held_grants)
        self.page.evaluate('synReadButton.click()'); self.observed(lambda:self.site.download_reads)
        route,record=self.site.held_grants.pop(0); self.site.answer_grant(route,record); self.settle(250)
        self.assertEqual([],self.downloads,'R5-A12-sequence: superseded read sequence zero native clicks')
        self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A12-sequence: stale grant remains spent')
        self.prepare(); self.site.grant_answers=['hold']; self.operations().first.get_by_role('button',name='Download',exact=True).click()
        self.observed(lambda:self.site.held_grants)
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))")
        route,record=self.site.held_grants.pop(0); self.site.answer_grant(route,record); self.settle(250)
        self.page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        self.assertEqual([],self.downloads,'R5-A12-document: suspended document zero native clicks')

    def test_r5_a11_archive_uncertainty_and_restored_ready_never_rearm(self):
        self.open_as(RAD_ONLY)
        for state in ('prepared','incomplete','unconfirmed'):
            op=self.prepare()
            with self.page.expect_download(): self.operations().first.get_by_role('button',name='Download',exact=True).click()
            view=download_view(op,UID_A,state)
            view['archiveRequest']={'grantId':self.site.grants[-1]['grantId'],'state':'refused','attemptId':str(uuid.uuid4()),
                                    'expiresAt':17,'code':'SYN_UNDECLARED','message':'not started'}
            self.site.download_state[op]=view
            for i in range(10): self.page.clock.run_for(3100); self.settle(50)
            self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A11: malformed status or poll deadline no rearm')
            self.assertNotIn('not started',self.operations().first.inner_text(),'R5-A11: no raw nonstart certificate')
            self.assertTrue(self.panel().get_by_role('button',name='Clear Finished',exact=True).is_disabled(),'R5-A11: unconfirmed history not clearable')

    def test_r5_a11_restored_ready_is_read_only(self):
        self.open_as(RAD_ONLY)
        op=self.prepare(); before=len(self.site.grants); self.reload_transfers()
        self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A11: restored Ready read-only')
        self.assertEqual(before,len(self.site.grants),'R5-A11: restore no grant')

    def test_r5_a12_complete_sent_required_and_late_A_B_A_grant_zero(self):
        self.open_as(RAD_ONLY)
        for moves in ((h.PATIENT_B,),(h.PATIENT_B,h.PATIENT)):
            op=self.prepare(); self.open_study(h.PATIENT); self.site.grant_answers=['hold']
            self.operations().first.get_by_role('button',name='Download',exact=True).click()
            self.observed(lambda:self.site.held_grants)
            for patient in moves:self.open_study(patient)
            route,record=self.site.held_grants.pop(0); self.site.answer_grant(route,record); self.settle(300)
            self.assertEqual([],self.downloads,'R5-A12: stale selection zero native clicks')
            self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A12: discarded budget stays spent')
        op=self.prepare()
        for field in ('archiveSha256','responseFinished','objectsComplete','bytesSupplied','attemptId','number','endedAt'):
            view=download_view(op,UID_A,'sent',complete=3); del view['attempts'][0][field]
            self.site.download_state[op]=view
            reads=len(self.site.download_reads); self.operations().first.get_by_role('button',name='Check Again',exact=True).click()
            self.observed(lambda:len(self.site.download_reads)>reads)
            self.assertNotEqual('Sent',self.operations().first.locator('.study-transfer-state').inner_text(),'R5-A12: incomplete supply summary not Sent')
            self.assertTrue(self.panel().get_by_role('button',name='Clear Finished',exact=True).is_disabled(),'R5-A12: false Sent not clearable')

    def test_r5_a12_close_during_grant_does_not_start_a_late_download(self):
        self.open_as(RAD_ONLY); self.prepare(); self.site.grant_answers=['hold']
        self.operations().first.get_by_role('button',name='Download',exact=True).click()
        self.observed(lambda:self.site.held_grants)
        self.panel().get_by_role('button',name='Close',exact=True).click()
        route,record=self.site.held_grants.pop(0); self.site.answer_grant(route,record); self.settle(250)
        self.assertEqual([],self.downloads,'R5-A12-close: closed panel cannot start a late native download')

    def test_r5_a12_panel_lifetime_ends_revoke_ready_and_pending_capabilities(self):
        self.open_as(RAD_ONLY)
        for action in ('Close', 'Hide', 'Clear Finished'):
            for phase in ('ready', 'grant-pending'):
                with self.subTest(action=action, phase=phase):
                    # Clear removes a confirmed sibling, while the pending operation must remain as history.
                    confirmed = self.prepare()
                    self.site.download_state[confirmed] = download_view(confirmed, UID_A, 'sent', complete=3)
                    with self.page.expect_download():
                        self.operations().first.get_by_role('button', name='Download', exact=True).click()
                    self.page.clock.run_for(3100)
                    self.observed(lambda: confirmed in self.site.download_reads)
                    op = self.prepare()
                    native_before = len(self.downloads)
                    if phase == 'grant-pending':
                        self.site.grant_answers = ['hold']
                        self.operations().first.get_by_role('button', name='Download', exact=True).click()
                        self.observed(lambda: self.site.held_grants)
                    grants = len(self.site.grants)
                    self.panel().get_by_role('button', name=action, exact=True).click()
                    if phase == 'grant-pending':
                        route, record = self.site.held_grants.pop(0)
                        self.site.answer_grant(route, record)
                        self.settle(250)
                    self.assertEqual(native_before, len(self.downloads), 'R5-A12-lifetime: ended operation zero native clicks')
                    # Reopen through the ordinary row command; a fresh operation is distinct from the old row.
                    self.prepare()
                    old = self.panel().locator(f'section[data-operation="{op}"]')
                    self.assertEqual(1, old.count(), 'R5-A12-lifetime: unconfirmed history retained')
                    self.assertEqual(0, old.get_by_role('button', name='Download', exact=True).count(),
                                     'R5-A12-lifetime: reopening cannot restore capability')
                    self.assertIn('시작 기회가 종료', old.inner_text(), 'R5-A12-lifetime: neutral ended notice')
                    self.assertEqual(0, old.get_by_role('button', name='Choose Files Again', exact=True).count(),
                                     'R5-A12-lifetime: no reselection')
                    self.assertEqual(grants, len(self.site.grants), 'R5-A12-lifetime: no extra grant')
                    if action == 'Clear Finished':
                        self.assertEqual(0, self.panel().locator(f'section[data-operation="{confirmed}"]').count(),
                                         'R5-A12-lifetime: confirmed sibling actually removed')

    def test_r5_a12_removed_operation_rejects_its_queued_download_action(self):
        self.open_as(RAD_ONLY)
        op = self.prepare()
        self.operations().first.get_by_role('button', name='Download', exact=True).evaluate('b => window.synRemovedDownload = b')
        self.site.download_state[op] = download_view(op, UID_A, 'sent', complete=3)
        with self.page.expect_download():
            self.operations().first.get_by_role('button', name='Download', exact=True).click()
        self.page.clock.run_for(3100)
        self.observed(lambda: self.site.download_reads)
        self.panel().get_by_role('button', name='Clear Finished', exact=True).click()
        self.assertEqual(0, self.operations().count(), 'R5-A12-removal: confirmed operation actually removed')
        self.page.evaluate('synRemovedDownload.click()')
        self.settle(250)
        self.assertEqual(1, len(self.site.grants), 'R5-A12-removal: removed operation zero extra grants')
        self.assertEqual(1, len(self.downloads), 'R5-A12-removal: removed operation zero extra native clicks')

    def test_r5_a12_close_in_native_link_insertion_is_checked_before_click(self):
        self.open_as(RAD_ONLY)
        self.prepare()
        # Synchronous DOM reentrancy at the native side effect boundary, without a product hook.
        self.page.evaluate('''() => { const append = Element.prototype.append;
          Element.prototype.append = function(...nodes) {
            const result = append.apply(this, nodes);
            if (nodes.some(n => n instanceof HTMLAnchorElement && n.hasAttribute('download')))
              [...document.querySelectorAll('#study-transfer button')].find(b => b.textContent === 'Close').click();
            return result;
          }; }''')
        self.operations().first.get_by_role('button', name='Download', exact=True).click()
        self.observed(lambda: self.site.grants)
        self.assertEqual([], self.downloads, 'R5-A12-immediate: lifetime checked immediately before native click')
        self.assertEqual(1, len(self.site.grants), 'R5-A12-immediate: one grant only')

    def test_r5_a12_logout_removes_operation_before_late_grant(self):
        self.open_as(RAD_ONLY)
        self.prepare()
        self.site.grant_answers = ['hold']
        self.operations().first.get_by_role('button', name='Download', exact=True).click()
        self.observed(lambda: self.site.held_grants)
        self.page.evaluate("document.querySelector('#logout').click()")
        self.observed(lambda: self.page.evaluate("KinWorkContext.state() !== 'active'"), 'logout lifecycle ended')
        route, record = self.site.held_grants.pop(0)
        self.site.answer_grant(route, record)
        self.settle(250)
        self.assertEqual([], self.downloads, 'R5-A12-logout: ended session zero native clicks')
        self.assertEqual(0, self.operations().count(), 'R5-A12-logout: private operations removed')

    def test_r5_a12_account_switch_and_document_unload_end_capability_in_same_turn(self):
        # Exercise public mount/lifecycle contracts with real work-context and session transport.
        # The host can switch identity synchronously; the full page instead closes through auth lifecycle.
        for boundary in ('account-switch', 'pagehide', 'beforeunload'):
            with self.subTest(boundary=boundary):
                context = self.browser.new_context()
                page = context.new_page()
                try:
                    context.route('**/*', lambda r: r.fulfill(content_type='text/html', body='<button id="t-import">Import DICOM</button><div id="study-transfer"></div>'))
                    page.goto('http://localhost/fixture')
                    for name in ('work-context.js', 'session-transport.js', 'study-transfer-local.js'):
                        source = (Path(__file__).resolve().parents[1]/'worklist-v0/hpacs-lite'/name).read_text(encoding='utf-8')
                        if self.asset_source and self.asset_source[0] == name: source = self.asset_source[1]
                        page.add_script_tag(content=source)
                    page.evaluate('''view => {
                      const gate = KinWorkContext.create(); gate.follow({onLifecycle(fn){fn({state:'active',session:'SYN-SESSION'});}});
                      window.KinWorkContext = gate; window.synOwner = ['SYN-INST','SYN-SUB']; window.synClicks = 0;
                      HTMLAnchorElement.prototype.click = function(){synClicks++;};
                      const transport = KinSessionTransport.create({gate, authFailure:()=>{}, fetch:async(url,init)=>{
                        if (url.endsWith('/grant')) return new Promise(resolve=>{window.synGrantRelease=()=>resolve(new Response(JSON.stringify({
                          operationId:window.synOperation,grantId:'00000000-0000-4000-8000-000000000001',grant:'x'.repeat(43),expiresAt:'2026-10-17T00:02:00.000Z'
                        }),{status:200,headers:{'Content-Type':'application/json'}}));});
                        window.synOperation=JSON.parse(init.body).operationId;
                        return new Response(JSON.stringify({...view,operationId:synOperation}),{status:200,headers:{'Content-Type':'application/json'}});
                      }});
                      window.synTransfer=KinStudyTransferLocal({api:'/api',transport,allowed:()=>true,identity:()=>synOwner,can:()=>true,demo:()=>false,study:()=>null});
                    }''', download_view(str(uuid.uuid4()), UID_A))
                    page.evaluate('uid=>synTransfer.download(uid)', UID_A)
                    page.get_by_role('button', name='Download', exact=True).click()
                    page.wait_for_function('!!window.synGrantRelease')
                    page.evaluate('''boundary=>{
                      if(boundary==='account-switch'){synOwner=['SYN-INST','SYN-OTHER'];synTransfer.sync();}
                      else window.dispatchEvent(new Event(boundary));
                      synGrantRelease();
                    }''', boundary)
                    page.wait_for_timeout(250)
                    self.assertEqual(0, page.evaluate('synClicks'), 'R5-A12-end: same-turn lifetime end zero native clicks')
                    self.assertEqual(0, page.get_by_role('button', name='Download', exact=True).count(),
                                     'R5-A12-end: ended capability never restored')
                finally:
                    context.close()

    def test_r5_a12_session_change_during_grant_keeps_budget_spent(self):
        self.open_as(RAD_TECH); self.open_study(h.PATIENT); self.type('SYN draft during grant')
        self.prepare(); self.site.grant_answers=['hold']
        self.operations().first.get_by_role('button',name='Download',exact=True).click()
        self.observed(lambda:self.site.held_grants)
        self.site.put_answers=[(500,{'message':'SYN save failure'})]
        self.page.evaluate("document.querySelector('#logout').click()")
        expect(self.page.locator('dialog.kin-logout h2')).to_have_text('Draft Not Saved')
        route,record=self.site.held_grants.pop(0); self.site.answer_grant(route,record); self.settle(250)
        self.assertEqual([],self.downloads,'R5-A12-session: invalidated grant zero native clicks')
        self.page.locator('dialog.kin-logout').get_by_role('button',name='Back to Editing',exact=True).click()
        self.observed(lambda:self.site.download_reads)
        self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A12-session: cancelled grant remains spent')
        self.assertEqual('SYN draft during grant',self.page.locator('#findings').input_value(),'R5-A12-session: draft retained')

    def test_r5_a13_actual_fixture_response_matches_public_file_contract(self):
        self.open_as(TECH,'Technician')
        received=[]
        self.page.on('response',lambda r:received.append((r.request.method,r.json())) if '/api/dicom-import' in r.url else None)
        self.choose(self.files(1)); self.observed(lambda:received)
        post=next(v for method,v in received if method=='POST'); op=post['operationId']
        self.assertEqual(ENVELOPE['post_file'],sorted(post),'R5-A13: actual POST keys')
        self.assertEqual(hashlib.sha256(dicom(0)).hexdigest(),post['sha256'],'R5-A13: original SHA value')
        self.reload_transfers()
        get=next(v for method,v in received if method=='GET')
        self.assertEqual(ENVELOPE['status_envelope'],sorted(get),'R5-A13: actual GET keys')
        row=get['files'][0]
        self.assertEqual(ENVELOPE['status_file'],sorted(row),'R5-A13: emitted GET row has no POST-only operationId')
        self.assertEqual(ENVELOPE['attempt'],sorted(row['attempts'][0]),'R5-A13: emitted attempt keys')
        self.assertEqual((op,64,1,'finished',None),(get['operationId'],row['bytes'],row['generation'],row['attempts'][0]['phase'],row['code']),'R5-A13: wire values and types')


    def test_r5_a04_copy_before_dispatch_and_after_each_result(self):
        self.open_as(TECH, 'Technician')
        # Hold the real browser request before network dispatch; both the base and current page use this boundary.
        self.page.evaluate("""() => { const send=window.fetch;
          window.fetch=function(url,init){
            if(String(url).endsWith('/dicom-import') && init?.method==='POST')
              return new Promise(resolve=>{window.synImportRelease=()=>resolve(send.call(this,url,init));});
            return send.apply(this,arguments);
          }; }""")
        self.site.import_answers=['hold']; self.choose(self.files(1))
        self.wait(lambda:self.page.evaluate('!!window.synImportRelease'),'browser request held before network dispatch')
        self.assertEqual([],self.site.imports,'R5-A04-copy: no dispatch before release')
        old=self.operations().first.get_attribute('data-operation')
        for phase in ('before-dispatch','retryable','positive'):
            with self.page.expect_popup() as opened:self.page.evaluate('u=>window.open(u,"_blank")',h.MAIN_URL)
            copied=opened.value
            try:
                expect(copied.locator('#rows')).to_contain_text(h.PATIENT)
                box=copied.locator('#study-transfer section[data-operation]').first
                expect(box).to_be_visible(); self.settle(250)
                self.assertEqual(old,box.get_attribute('data-operation'),'R5-A04-copy: same copied operation')
                self.assertEqual(0,box.get_by_role('button',name='Retry',exact=True).count(),'R5-A04-copy: copied old operation never sends')
                self.assertEqual(0,box.get_by_role('button',name='Choose Files Again',exact=True).count(),'R5-A04-copy: copied old operation never reattaches')
            finally:copied.close()
            if phase=='before-dispatch':
                self.page.evaluate('window.synImportRelease()'); self.observed(lambda:self.site.held_imports)
                self.site.release_import(lambda r:file_result(old,0,'retryable','ORTHANC_UNAVAILABLE')); self.settle(250)
            elif phase=='retryable':
                self.site.import_state[old]={0:file_result(old,0)}
                self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(250)
        self.assertEqual(1,len(self.site.imports),'R5-A04-copy: original old key dispatched once across all copies')

    def test_r5_a05_failed_read_then_storage_recovery_has_no_capability(self):
        self.open_as(TECH,'Technician'); self.site.import_answers=['abort']; self.choose(self.files(1))
        self.observed(lambda:self.site.import_reads)
        original=self.site.imports[0]['operation']
        self.page.evaluate("""() => { const s=JSON.parse(sessionStorage.getItem('kin-study-transfer-local'));
          s.v=2; s.operations[0].files[0].sent=false; s.operations[0].files[0].canRetry=true;
          s.operations[0].files[0].pending=null; sessionStorage.setItem('kin-study-transfer-local',JSON.stringify(s)); }""")
        self.context.add_init_script("""(() => { const raw=Storage.prototype.getItem;
          const mode=raw.call(localStorage,'syn-transfer-storage-fault'); window.synStorageFaultCalls=[];
          if(mode) for(const method of JSON.parse(mode)){const original=Storage.prototype[method];
            Storage.prototype[method]=function(key,...args){if(key==='kin-study-transfer-local'){
              window.synStorageFaultCalls.push(method);throw new Error('synthetic storage failure');}
              return original.call(this,key,...args);};}})();""")
        for methods in (['getItem'],['getItem','setItem','removeItem']):
            self.page.evaluate("m=>localStorage.setItem('syn-transfer-storage-fault',JSON.stringify(m))",methods)
            self.reload_transfers()
            self.assertIn('getItem',self.page.evaluate('window.synStorageFaultCalls'),'R5-A05-read: actual failed storage read observed')
            self.assertEqual(0,self.operations().count(),'R5-A05-read: unreadable history not fabricated')
            self.assertIn('보존하지 못했습니다',self.panel().inner_text(),'R5-A05-read: unavailable history disclosed')
            self.page.evaluate("localStorage.removeItem('syn-transfer-storage-fault')")
            self.reload_transfers()
            self.assertEqual(original,self.operations().first.get_attribute('data-operation'),'R5-A05-read: surviving snapshot recovered')
            self.assert_policy(row='R5-A05-read')
            self.assertEqual(1,len(self.site.imports),'R5-A05-read: recovered legacy descriptor never sends')

    def test_r5_a07_expected_study_and_legacy_positive_history(self):
        self.open_as(TECH,'Technician'); self.site.import_answers=['hold']
        self.choose(self.files(1),via=h.PATIENT); self.observed(lambda:self.site.held_imports)
        route,record=self.site.held_imports.pop(0); op=record['operation']
        self.site.answer(route,200,file_result(op,0,uid=UID_B)); self.settle(250)
        self.assert_policy(row='R5-A07-study')
        prior=file_result(op,0,'retryable','ORTHANC_UNAVAILABLE')['attempts'][0]
        positive=file_result(op,0,generation=2); positive['attempts'].insert(0,prior)
        self.site.import_state[op]={0:positive}
        self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(250)
        self.assertEqual('Stored',self.state_of(0),'R5-A07-study: genuine legacy positive accepted without new dispatch')
        self.reload_transfers()
        self.assertEqual('Stored',self.state_of(0),'R5-A07-study: immutable legacy positive accepted again')
        self.assertEqual(1,len(self.site.imports),'R5-A07-study: old positive history GET only')

    def storage_failure_then_new_operation(self, fault):
        self.open_as(TECH, 'Technician')
        self.site.import_answers = [('stored-then', 'abort')]
        self.site.status_answers = [(503, {'message': 'SYN status temporarily unavailable'})] * 30
        self.choose(self.files(1))
        self.observed(lambda: self.site.import_reads)
        original = self.site.imports[0]['operation']
        snapshot = self.page.evaluate("sessionStorage.getItem('kin-study-transfer-local')")
        self.context.add_init_script('''(() => {
          const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
          const mode = get.call(localStorage, 'syn-transfer-fault');
          window.synTransferFaultCalls = [];
          window.synSavedTransfer = () => get.call(sessionStorage, 'kin-study-transfer-local');
          window.synRecoverStorage = original => {
            Storage.prototype.getItem = get; Storage.prototype.setItem = set;
            if (mode === 'corrupt' || mode === 'unverified') set.call(sessionStorage, 'kin-study-transfer-local', original);
            localStorage.removeItem('syn-transfer-fault');
          };
          for (const method of ['getItem', 'setItem']) {
            const fn = Storage.prototype[method];
            Storage.prototype[method] = function(key, ...args) {
              if (key === 'kin-study-transfer-local' && (mode === method || mode === 'unavailable')) {
                synTransferFaultCalls.push(method); throw new Error('SYN storage unavailable');
              }
              return fn.call(this, key, ...args);
            };
          }
        })();''')
        self.page.evaluate("m => localStorage.setItem('syn-transfer-fault', m)", fault)
        if fault in ('corrupt', 'unverified'):
            # Simulate an unreadable persisted value, retaining its exact bytes until the fixture repairs it.
            damaged = snapshot + '!' if fault == 'corrupt' else json.dumps({**json.loads(snapshot), 'v': 999})
            self.page.evaluate("s => sessionStorage.setItem('kin-study-transfer-local', s)", damaged)
        self.reload_transfers()
        before_selection = self.page.evaluate('synSavedTransfer()')
        self.assertEqual(damaged if fault in ('corrupt', 'unverified') else snapshot, before_selection,
                         'R5-A05-new: failed restore leaves the exact unread history intact')
        self.site.import_answers = ['abort']
        self.choose(self.files(1))
        self.observed(lambda: len(self.site.imports) == 2)
        self.settle(250)
        fresh = self.site.imports[-1]['operation']
        self.assertNotEqual(original, fresh, 'R5-A05-new: explicit new operation is distinct')
        self.assertEqual(before_selection, self.page.evaluate('synSavedTransfer()'),
                         'R5-A05-new: failed or unverified read/write never replaces the surviving snapshot')
        if fault in ('getItem', 'setItem', 'unavailable'):
            self.assertIn('setItem' if fault == 'setItem' else 'getItem', self.page.evaluate('synTransferFaultCalls'),
                          'R5-A05-new: storage failure actually observed')
        self.assertIn('보존하지 못했습니다', self.panel().inner_text(), 'R5-A05-new: history persistence failure disclosed')
        box = self.operations().filter(has=self.page.locator(f'li[data-index="0"]')).first
        box.get_by_role('button', name='Copy ID', exact=True).click()
        self.assertIn(fresh, self.page.evaluate('window.__synClipboard').pop(), 'R5-A05-new: Copy ID remains usable')
        # Recovery while this page is alive must merge its memory-only operation with the previously unread history.
        self.page.evaluate('s => synRecoverStorage(s)', snapshot)
        box.get_by_role('button', name='Check Again', exact=True).click()
        self.settle(350)
        persisted = json.loads(self.page.evaluate('synSavedTransfer()'))
        self.assertEqual({original, fresh}, {op['id'] for op in persisted['operations']},
                         'R5-A05-new: verified recovery merges old and memory-only operations')
        self.reload_transfers()
        restored = self.operations().evaluate_all('nodes => nodes.map(n => n.dataset.operation)')
        print('R5-A05_NEW_HISTORY ' + json.dumps({'fault': fault, 'original': original, 'fresh': fresh,
              'restored': restored, 'received_posts': self.import_writes(),
              'server_original_sha256': self.site.import_state[original][0]['sha256']}, ensure_ascii=False), flush=True)
        self.assertEqual({original, fresh}, set(restored), 'R5-A05-new: all recoverable history survives reload')
        self.assertEqual(self.site.imports[0]['sha256'], self.site.import_state[original][0]['sha256'],
                         'R5-A05-new: original bytes remain on the synthetic server')
        for index in range(2):
            self.assert_policy(op=index, row='R5-A05-new')
        self.assertEqual(2, len(self.site.imports), 'R5-A05-new: recovery and restoration create no send capability')

    def test_r5_a05_failed_restore_read_then_new_operation_preserves_surviving_history(self):
        self.storage_failure_then_new_operation('getItem')

    def test_r5_a05_failed_write_then_new_operation_and_reload_preserve_history(self):
        self.storage_failure_then_new_operation('setItem')

    def test_r5_a05_corrupt_json_then_new_operation_and_reload_preserve_history(self):
        self.storage_failure_then_new_operation('corrupt')

    def test_r5_a05_unavailable_storage_recovers_merges_new_operation_before_reload(self):
        self.storage_failure_then_new_operation('unavailable')

    def test_r5_a05_unverified_snapshot_then_new_operation_and_reload_preserve_history(self):
        self.storage_failure_then_new_operation('unverified')

    def test_r5_a11_valid_archive_statuses_and_copied_download_are_read_only(self):
        self.open_as(RAD_ONLY)
        for state,code in (('issued',None),('expired','DOWNLOAD_GRANT_EXPIRED'),('refused','MANIFEST_CHANGED'),('refused','SYN_UNKNOWN')):
            op=self.prepare()
            with self.page.expect_download():self.operations().first.get_by_role('button',name='Download',exact=True).click()
            view=download_view(op,UID_A)
            view['archiveRequest']={'grantId':self.site.grants[-1]['grantId'],'state':state,'code':code,
                'expiresAt':'2026-10-17T00:02:00.000Z','attemptId':None,'message':None if code is None else 'not started'}
            self.site.download_state[op]=view
            for i in range(10):self.page.clock.run_for(3100); self.settle(50)
            self.assertEqual(0,self.operations().first.get_by_role('button',name='Download',exact=True).count(),'R5-A11-valid: no status restores grant')
            self.assertNotIn('not started',self.operations().first.inner_text(),'R5-A11-valid: no nonstart certificate')
            self.assertTrue(self.panel().get_by_role('button',name='Clear Finished',exact=True).is_disabled(),'R5-A11-valid: old history kept')
        ready=self.prepare(); before=len(self.site.grants)
        with self.page.expect_popup() as opened:self.page.evaluate('u=>window.open(u,"_blank")',h.MAIN_URL)
        copied=opened.value
        try:
            expect(copied.locator('#rows')).to_contain_text(h.PATIENT); self.settle(250)
            box=copied.locator('#study-transfer section[data-operation]').first
            self.assertEqual(ready,box.get_attribute('data-operation'),'R5-A11-copy: original Ready copied')
            self.assertEqual(0,box.get_by_role('button',name='Download',exact=True).count(),'R5-A11-copy: copied Ready read-only')
            self.assertEqual(before,len(self.site.grants),'R5-A11-copy: no copied grant')
        finally:copied.close()

    def test_r5_a12_each_download_view_field_and_attempt_binding_required(self):
        self.open_as(RAD_ONLY); op=str(uuid.uuid4())
        good=download_view(op,UID_A,'sent',complete=3)
        mutations=[('missing '+k,lambda v,k=k:v.pop(k)) for k in good]
        mutations += [('wrong '+k,lambda v,k=k:v.__setitem__(k,False)) for k in good]
        mutations += [('attempt missing '+k,lambda v,k=k:v['attempts'][0].pop(k)) for k in good['attempts'][0]]
        mutations += [('attempt wrong '+k,lambda v,k=k:v['attempts'][0].__setitem__(k,'wrong')) for k in good['attempts'][0]]
        mutations += [('wrong consumed binding',lambda v:v.update(archiveRequest={'grantId':str(uuid.uuid4()),'state':'consumed',
            'code':None,'message':None,'expiresAt':'2026-10-17T00:02:00.000Z','attemptId':str(uuid.uuid4())})),
            ('duplicate attempt',lambda v:v['attempts'].append(v['attempts'][0].copy()))]
        for label,mutate in mutations:
            with self.subTest(field=label):
                op=self.prepare()
                bad=json.loads(json.dumps(good)); bad['operationId']=op; mutate(bad); self.site.download_state[op]=bad
                reads=len(self.site.download_reads)
                with self.page.expect_download(): self.operations().first.get_by_role('button',name='Download',exact=True).click()
                self.page.clock.run_for(3100)
                self.observed(lambda:len(self.site.download_reads)>reads)
                self.assertNotEqual('Sent',self.operations().first.locator('.study-transfer-state').inner_text(),'R5-A12-view: malformed positive is not Sent')
                self.assertTrue(self.panel().get_by_role('button',name='Clear Finished',exact=True).is_disabled(),'R5-A12-view: malformed positive not clearable')
        good['operationId']=op; self.site.download_state[op]=good
        self.operations().first.get_by_role('button',name='Check Again',exact=True).click(); self.settle(250)
        self.assertEqual('Sent',self.operations().first.locator('.study-transfer-state').inner_text(),'R5-A12-view: complete matching supply accepted')


def own_cases():
    """This file's cases only: the W4 flow cases it inherits its harness from run in report_flow_dom_test.py."""
    return [name for name in unittest.defaultTestLoader.getTestCaseNames(TransferPanelPage) if name in TransferPanelPage.__dict__]


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite(TransferPanelPage(name) for name in own_cases())
    return suite


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    names = sys.argv[1:] or own_cases()
    suite = unittest.TestSuite(TransferPanelPage(n) for n in names)
    result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
    return 0 if result.wasSuccessful() and not result.skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
