"""Synthetic BFF fixtures shared by the U5 HTTP and browser boundary tests."""
from __future__ import annotations

import html
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlencode, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import auth_audit_live as audit
from invariants_live import LiveStack, psql


class SessionStack(LiveStack):
    def fixture_command(self, institution, name, patient_id):
        command = super().fixture_command(institution, name, patient_id)
        source = os.environ.get("KIN_U5_DICOM_SOURCE")
        if source:
            path = Path(source).resolve(strict=True)
            if not path.is_dir():
                raise RuntimeError("KIN_U5_DICOM_SOURCE must name the public CT fixture directory")
            command += ["--source-dir", str(path)]
        return command


class Session(audit.Browser):
    def json(self, method, path, body=None, headers=None):
        status, response_headers, text = self.call(
            method, path, None if body is None else json.dumps(body).encode(),
            {"Content-Type": "application/json", "X-KIN-CSRF": "1", **(headers or {})})
        return status, response_headers, json.loads(text) if text else None

    def login(self, test, actor="doctor"):
        status, headers, _ = self.call("GET", "/api/auth/login")
        test.assertEqual(status, 302)
        status, _, form = self.call("GET", headers["Location"])
        test.assertEqual(status, 200)
        action = re.search(r'<form[^>]+action="([^"]+)"', form, re.I)
        test.assertIsNotNone(action, "Keycloak login form")
        data = urlencode({"username": self.stack.username(actor),
                          "password": self.stack.passwords[actor], "credentialId": ""}).encode()
        status, headers, _ = self.call("POST", html.unescape(action.group(1)), data,
                                      {"Content-Type": "application/x-www-form-urlencoded"})
        test.assertEqual(status, 302, "Keycloak authentication")
        status, headers, _ = self.call("GET", headers["Location"])
        test.assertEqual(status, 302, "BFF callback")
        target = urlparse(headers["Location"])
        test.assertEqual(target.path, "/worklist/hpacs-lite/main.html")
        self.proof = unquote(target.fragment.partition("kin-entry=")[2])
        test.assertTrue(self.proof, "One-use entry proof")
        status, _, self.me = self.json("GET", "/api/me")
        test.assertEqual(status, 200)
        self.session = self.me["sessionId"]
        self.owner = {"institution": self.me["institution"], "sub": self.me["sub"], "author": self.me["actor"]}
        return self


def setup_stack(case):
    case.stack = SessionStack()
    case.addClassCleanup(case.stack.cleanup_test_identities)
    case.addClassCleanup(cleanup_sessions, case.stack)
    case.addClassCleanup(case.stack.cleanup_all)
    case.stack.require_stack()


def cleanup_sessions(stack):
    # Only subjects allocated by this LiveStack are eligible for cleanup.
    import uuid
    for sub in stack.user_ids.values():
        if str(uuid.UUID(sub)) != sub:
            raise RuntimeError("Invalid owned subject")
        psql(f'DELETE FROM "AuthSession" WHERE sub=\'{sub}\';')
        if psql(f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{sub}\';') != ["0"]:
            raise RuntimeError("Owned session cleanup incomplete")


def snapshot(text):
    return {"findings": text, "conclusion": "Synthetic conclusion", "recommendation": "",
            "baseVersion": 0, "citationIds": [], "structureIds": []}


def draft_body(session, revision, text):
    return {**snapshot(text), "expectedOwner": session.owner, "expectedRevision": revision}
