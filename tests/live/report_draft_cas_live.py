"""U5S-REQ-05/08/14..18 -> U5S-RISK-SESSION/DRAFT/AUDIT/WAIT -> D01/D03/D04/D05/S05.

Real BFF HTTP and PostgreSQL observations. No automatic precondition injection.
Conflict state is read from GET draft, as specified by the wire contract.
Keycloak pause is bounded and always undone; only the selected Compose service is touched.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_support import Session, setup_stack, draft_body, cleanup_sessions
from invariants_live import ROOT, psql


@contextmanager
def slow_keycloak():
    subprocess.run(["docker", "compose", "pause", "keycloak"], cwd=ROOT, check=True,
                   capture_output=True, timeout=20)
    try:
        yield
    finally:
        subprocess.run(["docker", "compose", "unpause", "keycloak"], cwd=ROOT, check=True,
                       capture_output=True, timeout=20)


class ReportDraftCasLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        setup_stack(cls)

    def tearDown(self):
        cleanup_sessions(self.stack)
        self.stack.cleanup_all()

    def start(self):
        fixture = self.stack.create_fixture()
        session = Session(self.stack).login(self)
        path = f"/api/studies/{fixture.uid}"
        status, _, initial = session.json("GET", path + "/draft")
        self.assertEqual(status, 200)
        self.assertFalse(initial["present"])
        self.assertIsNone(initial["snapshot"])
        return fixture, session, path, initial

    def read(self, session, path):
        status, _, body = session.json("GET", path + "/draft")
        self.assertEqual(status, 200)
        return body

    def stored(self, fixture):
        return psql(f'SELECT to_jsonb(d)::text FROM "ReportDraft" d WHERE uid=\'{fixture.uid}\' ORDER BY author;')

    def audits(self, session, action):
        return int(psql(f'SELECT count(*) FROM "AuditLog" WHERE target=\'{session.me["sub"]}\' '
                        f'AND action=\'{action}\';')[0])

    def expire(self, session):
        psql(f'UPDATE "AuthSession" SET "atExpiresAt"=now()-interval \'1 minute\' '
             f'WHERE sub=\'{session.me["sub"]}\';')

    def test_d01_concurrent_first_create_has_one_winner_and_authoritative_conflict_read(self):
        fixture, first, path, initial = self.start()
        second = Session(self.stack).login(self)
        barrier = threading.Barrier(2)
        def send(session, text):
            barrier.wait(timeout=10)
            return session.json("PUT", path + "/report", draft_body(session, initial["revision"], text))
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(send, first, "First snapshot"), pool.submit(send, second, "Second snapshot")]
            results = [future.result(timeout=30) for future in futures]
        self.assertEqual(sorted(r[0] for r in results), [200, 409])
        winner = next(r[2] for r in results if r[0] == 200)
        loser = next(r[2] for r in results if r[0] == 409)
        self.assertEqual(loser["code"], "REPORT_DRAFT_CONFLICT")
        self.assertNotIn("revision", loser, "Conflict never grants a blind retry token")
        self.assertEqual(self.read(first, path), winner)
        self.assertEqual(self.read(second, path), winner)
        rows = [json.loads(row) for row in self.stored(fixture)]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["revision"], 1)
        self.assertEqual(rows[0]["findings"], winner["snapshot"]["findings"])

    def test_d07_same_content_conflict_converges_by_full_read_without_second_write(self):
        fixture, session, path, initial = self.start()
        body = draft_body(session, initial["revision"], "Same complete snapshot")
        status, _, saved = session.json("PUT", path + "/report", body)
        self.assertEqual(status, 200)
        before = self.stored(fixture)
        status, _, refused = session.json("PUT", path + "/report", body)
        self.assertEqual((status, refused["code"]), (409, "REPORT_DRAFT_CONFLICT"))
        latest = self.read(session, path)
        self.assertEqual(latest, saved)
        self.assertEqual(latest["owner"], session.owner)
        self.assertEqual(latest["snapshot"], {"findings": body["findings"], "conclusion": body["conclusion"],
                         "recommendation": "", "baseVersion": 0, "citations": [], "structured": []})
        self.assertEqual(self.stored(fixture), before)

    def test_d03_delete_and_approval_advance_boundary_and_reject_late_write(self):
        for operation in ("delete", "approve"):
            with self.subTest(operation=operation):
                fixture, session, path, initial = self.start()
                body = draft_body(session, initial["revision"], "Retain history")
                status, _, saved = session.json("PUT", path + "/report", body)
                self.assertEqual(status, 200)
                precondition = {"expectedOwner": session.owner, "expectedRevision": saved["revision"]}
                if operation == "delete":
                    status, _, ended = session.json("DELETE", path + "/draft", precondition)
                    self.assertEqual(status, 200)
                else:
                    status, _, ended = session.json("POST", path + "/report/commit",
                        {**body, **precondition, "action": "approve"})
                    self.assertEqual(status, 201)
                    self.assertEqual(ended["state"]["rs"], "A")
                    self.assertEqual(psql(f'SELECT count(*) FROM "ReportVersion" WHERE uid=\'{fixture.uid}\';'), ["1"])
                self.assertFalse(ended["present"])
                self.assertIsNone(ended["snapshot"])
                self.assertNotEqual(ended["revision"], saved["revision"])
                before = self.stored(fixture)
                status, _, refused = session.json("PUT", path + "/report", {**body, **precondition})
                self.assertEqual((status, refused["code"]), (409, "REPORT_DRAFT_CONFLICT"))
                self.assertEqual(self.stored(fixture), before)

    def test_d04_force_discard_rotates_epoch_even_without_a_draft(self):
        fixture, session, path, initial = self.start()
        admin = Session(self.stack).login(self, "jmryu")
        epoch = initial["revision"].split(":")[0]
        status, _, cleared = admin.json("DELETE", path + "/draft/force",
            {"expectedOwner": admin.owner, "expectedEpoch": epoch})
        self.assertEqual(status, 200)
        self.assertNotEqual(cleared["epoch"], epoch)
        status, _, refused = session.json("PUT", path + "/report", draft_body(session, initial["revision"], "Too late"))
        self.assertEqual((status, refused["code"]), (409, "REPORT_DRAFT_CONFLICT"))
        self.assertFalse(self.read(session, path)["present"])

    def test_d05_ended_session_write_refused_preserves_draft_and_one_termination_audit(self):
        fixture, session, path, initial = self.start()
        body = draft_body(session, initial["revision"], "Owned before logout")
        status, _, saved = session.json("PUT", path + "/report", body)
        self.assertEqual(status, 200)
        before = self.stored(fixture)
        count = self.audits(session, "auth.logout")
        status, headers, _ = session.json("POST", "/api/auth/logout")
        self.assertEqual(status, 204)
        self.assertFalse(any(k.lower() == "set-cookie" for k in headers))
        status, _, refused = session.json("PUT", path + "/report", {**body, "expectedRevision": saved["revision"]})
        self.assertEqual((status, refused["code"]), (401, "AUTH_SESSION_ENDED"))
        self.assertEqual(self.stored(fixture), before)
        self.assertEqual(self.audits(session, "auth.logout"), count + 1)
        self.assertEqual(session.json("POST", "/api/auth/logout")[0], 204)
        self.assertEqual(self.audits(session, "auth.logout"), count + 1)

    def test_s05_logout_committed_and_204_while_keycloak_is_paused(self):
        session = Session(self.stack).login(self)
        before = self.audits(session, "auth.logout")
        self.expire(session)
        with slow_keycloak():
            started = time.monotonic()
            status, _, _ = session.json("POST", "/api/auth/logout")
            elapsed = time.monotonic() - started
            self.assertEqual(status, 204)
            self.assertLess(elapsed, 1.8, "204 must not await the 2 s IdP timeout")
            self.assertEqual(psql(f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{session.me["sub"]}\';'), ["0"])
            self.assertEqual(self.audits(session, "auth.logout"), before + 1)
            self.assertEqual(session.json("GET", "/api/me")[2]["code"], "AUTH_SESSION_ENDED")

    def test_refresh_timeout_preserves_session_then_real_invalid_grant_ends_it(self):
        session = Session(self.stack).login(self)
        before = self.audits(session, "auth.session.expired")
        self.expire(session)
        with slow_keycloak():
            started = time.monotonic()
            status, _, refused = session.json("GET", "/api/me")
            self.assertEqual((status, refused["code"]), (503, "AUTH_IDP_UNAVAILABLE"))
            self.assertLess(time.monotonic() - started, 10)
            self.assertEqual(psql(f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{session.me["sub"]}\';'), ["1"])
            self.assertEqual(self.audits(session, "auth.session.expired"), before)
        self.assertEqual(session.json("GET", "/api/me")[0], 200)
        self.assertEqual(self.stack.kc_admin("POST", f'/users/{session.me["sub"]}/logout').status, 204)
        self.expire(session)
        status, _, refused = session.json("GET", "/api/me")
        self.assertEqual((status, refused["code"]), (401, "AUTH_SESSION_ENDED"))
        self.assertEqual(self.audits(session, "auth.session.expired"), before + 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
