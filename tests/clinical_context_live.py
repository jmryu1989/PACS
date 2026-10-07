# coding: utf-8
"""TEST-S7-U4a-LIVE: GET /api/studies/:uid/clinical-context on the real Nest guard and service, PostgreSQL, Keycloak,
Orthanc and nginx (contract S7-U4p section 11.2, cases CC-L01...CC-L11; decision D-S7-11 (b): no order values).

REQ-S7-U4p-SOURCES / ORDER-EXCLUDED / PATIENT-KEY / PROVENANCE / ACCESS-BASIS / READ-RULE / READ-ONLY / STATES / ROUTE
  -> RISK-S7-U4a-TENANT / CROSS-PATIENT / NONFINAL, RISK-S7-U4p-SEED-AS-AUTHORITY / ORDER-VIA-OVERLAY / KEY-WIDENING /
     ABSENT-OVERCLAIM / READ-WRITES / UNSOURCED
  -> TEST-S7-U4a-LIVE (this file).

Hosted synthetic stack only, through scripts/run-tests.py (never the original DB, DICOM or accounts; D-S7-12 (a): at most
three live runs of 900 s, no retry of the same SHA after an assertion failure):

    python scripts/run-tests.py --module tests/clinical_context_live.py --mode live --unit s7-u4a-clinical-context --timeout 900

  L01 roles: radiologist and admin 200 (no-store), technician-only 403 CLINICAL_CONTEXT_ROLE, clinician-only 403
      CLINICIAN_ROUTE_DENIED, clinician+radiologist 200, a member without an institution 403.
  L02 institution and tele: another institution's radiologist and admin get the bytes of an unknown UID's 404; after a
      referral the receiver reads the anchor as tele and sees only the sender's same-key studies referred to it (not its
      own same-PatientID study); a cancelled member leaves the answer and a cancelled anchor is 404.
  L03 StudyAccess: a UID rule and an original-tag rule each leave a prior out; a rule without the anchor is 404.
  L04 signed heads only: P (author, reviewer and a third reader) and T are history rows without a body; approve and
      addendum are prior reports with the head row's body; a reset leaves the prior reports.
  L05 same-key D8 conflict and the name trap; patientKey is the worklist row's sourcePatientKey.
  L06 no order value (Astra DEC-F01 negative test): sentinel Order rows matched to the anchor and to a prior, then the
      prior approved: no sentinel byte and no forbidden key; the prior's row carries its original DICOM description and
      accession; no history row is the anchor; every section is present.
  L07 request tags verbatim (Korean, leading spaces), absent with the five checked tags, one tag, an SR series added
      beside the image series, and a study with SR only (not_configured, no checked tags).
  L08 Tech Note metadata only: absent, v1 without its text or reason, an emptied revision hasText false.
  L09 read only: AuditLog and StudyState counts, ReportVersion and TechNoteRevision digests and Orthanc's last change are
      the same around the call, and an unregistered same-key Orthanc study is neither registered nor listed.
  L10 provenance and permission basis: the six fields of every item, observedAt inside the call, owner then tele.
  L11 no patient key: prior and history not_configured/no_patient_key; request tags and Tech Note unaffected.

Each case prints one `S7-U4a-CONTEXT {json}` marker line. Owned data only: run-created Keycloak users (kin-test-*), a
member without an institution created and deleted here, the realm role `clinician` only when this run had to create it,
synthetic studies uploaded to the synthetic Orthanc (SYN names, run-unique CCTX-* PatientIDs) and removed by the stack's
own cleanup, SYNTHETIC StudyAccess policies on this run's identities, and two SENTINEL Order rows removed by exact row.
Synthetic DICOM is made with pydicom, the same dependency scripts/send_cstore.py needs.
"""
from __future__ import annotations

import base64
import json
import re
import sys
import time
import unittest
import uuid
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from clinician_question_live import lit, member_owner, restricted, rule
from invariants_live import Fixture, LiveStack, past_audit_guard, psql

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))
DENIED = FIXTURES["denied_code"]
HALLYM, KIN = "한림병원", "KIN 판독센터"
# Contract S7-U4p uxr-trace.json (docs fc7680b): the closed response keys and the forbidden key names (sections 3.1, 9.1).
RESPONSE_KEYS = {"kind", "recordId", "version", "author", "recordedAt", "observedAt", "state", "reason", "sourceLabel",
                 "truncated", "items", "access", "institutionName", "techNoteVersion", "schema", "uid", "patientKey", "anchor",
                 "identity", "conflict", "birth", "sex", "sections", "priorReports", "history", "requestTags", "checked",
                 "techNote", "date", "modalities", "description", "studyUid", "study", "report", "action", "findings",
                 "conclusion", "recommendation", "provenance", "accession", "reading", "rs", "signed", "reportVersion", "tag",
                 "keyword", "vr", "value", "note", "hasText"}
FORBIDDEN_FRAGMENTS = ("order", "oid", "ward", "reqdoc", "reqhosp", "sched", "matched", "draft", "holder", "predoc",
                       "prereviewer", "holdreason")
FORBIDDEN_EXACT = ("ov", "orig")
FIVE = ["00321030", "00401002", "001021B0", "00081080", "00324000"]
KINDS = {"priorReports": "kin.report-version", "history": "dicom.study+kin.study-state",
         "requestTags": "dicom.instance-header", "techNote": "kin.tech-note"}
SECTIONS = ("priorReports", "history", "requestTags", "techNote")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SC_CLASS, SR_CLASS = "1.2.840.10008.5.1.4.1.1.7", "1.2.840.10008.5.1.4.1.1.88.11"
OWNED_USERNAME = r"^kin-test-[0-9a-f]{12}-[a-z0-9_-]+$"


def deep_keys(value, out=None) -> set[str]:
    out = set() if out is None else out
    if isinstance(value, list):
        for item in value:
            deep_keys(item, out)
    elif isinstance(value, dict):
        for key, item in value.items():
            out.add(key)
            deep_keys(item, out)
    return out


def marker(case: str, **seen) -> None:
    print("S7-U4a-CONTEXT " + json.dumps({"case": case, **seen}, ensure_ascii=True, sort_keys=True), flush=True)


def new_uid() -> str:
    return "2.25." + str(uuid.uuid4().int)


def instant(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


class ClinicalContextLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.created_role = False
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary S7-U4a clinician role"})
            if created.status != 201:
                raise RuntimeError(f"clinician role creation failed: {created.status} {created.text}")
            cls.created_role = True
        elif role.status != 200:
            raise RuntimeError(f"clinician role lookup failed: {role.status} {role.text}")
        cls.addClassCleanup(cls.delete_role_if_created)
        for logical, roles, group in (("ccadmin", ["admin"], "hallym"), ("kcadmin", ["admin"], "kin-center"),
                                      ("ccclinician", ["clinician"], "hallym"), ("ccmixed", ["clinician", "radiologist"], "hallym")):
            cls.stack.create_test_identity(logical, roles, group)
            cls.stack.token(logical)
        cls.owned_users: list[str] = []
        cls.addClassCleanup(cls.delete_owned_users)

    @classmethod
    def delete_role_if_created(cls) -> None:
        if not cls.created_role:
            return
        cls.stack._admin_login()
        deleted = cls.stack.kc_admin("DELETE", "/roles/clinician")
        if deleted.status not in (204, 404):
            raise RuntimeError(f"temporary clinician role cleanup failed: {deleted.status}")
        cls.created_role = False

    @classmethod
    def delete_owned_users(cls) -> None:
        if cls.owned_users:
            cls.stack._admin_login()
        for user_id in cls.owned_users:
            deleted = cls.stack.kc_admin("DELETE", f"/users/{quote(user_id)}")
            if deleted.status not in (204, 404):
                raise RuntimeError(f"owned member cleanup failed: {deleted.status}")
        cls.owned_users.clear()

    # ── synthetic studies ──

    def dicom(self, study_uid: str, series_uid: str, sop_uid: str, modality: str, patient: dict, tags: dict) -> bytes:
        from pydicom.dataset import Dataset, FileMetaDataset
        from pydicom.uid import ExplicitVRLittleEndian
        meta = FileMetaDataset()
        meta.MediaStorageSOPClassUID = SR_CLASS if modality == "SR" else SC_CLASS
        meta.MediaStorageSOPInstanceUID = sop_uid
        meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds = Dataset()
        ds.file_meta = meta
        ds.is_little_endian, ds.is_implicit_VR = True, False
        ds.SpecificCharacterSet = "ISO_IR 192"
        ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, sop_uid
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.Modality = study_uid, series_uid, modality
        ds.PatientID, ds.PatientName = patient["pid"], patient["name"]
        ds.PatientBirthDate, ds.PatientSex = patient["birth"], patient["sex"]
        ds.StudyDate, ds.StudyTime = patient["date"], "120000"
        ds.StudyDescription, ds.AccessionNumber = patient["desc"], patient["acc"]
        ds.InstitutionName = patient["institution"]
        ds.InstanceNumber = 1
        for keyword, value in tags.items():
            setattr(ds, keyword, value)
        buffer = BytesIO()
        ds.save_as(buffer, write_like_original=False)
        return buffer.getvalue()

    def store(self, content: bytes) -> None:
        auth = base64.b64encode(f"{self.stack.orthanc_user}:{self.stack.orthanc_password}".encode()).decode()
        request = Request(self.stack.orthanc + "/instances", data=content, method="POST",
                          headers={"Authorization": "Basic " + auth, "Content-Type": "application/dicom"})
        with urlopen(request, timeout=30) as response:
            answer = json.loads(response.read().decode("utf-8"))
        self.assertEqual(answer.get("Status"), "Success", answer)

    def upload(self, *, pid: str, institution: str = HALLYM, name: str = "SYN^CONTEXT", birth: str = "19800517",
               sex: str = "M", date: str = "20260101", desc: str | None = None, acc: str | None = None,
               series=(("CT", {}),), register: bool = True) -> Fixture:
        """One synthetic study: one instance per (modality, tags) series. Registered through the worklist like a C-STORE
        fixture (owner listing, then Verify), unless register=False (an Orthanc-only study)."""
        run = uuid.uuid4().hex[:10].upper()
        uid = new_uid()
        patient = {"pid": pid, "name": name, "birth": birth, "sex": sex, "date": date,
                   "desc": desc if desc is not None else "SYN CONTEXT " + run, "acc": acc if acc is not None else "SYNACC" + run,
                   "institution": institution}
        owner = "jmryu" if institution == HALLYM else "kdoctor"
        fixture = Fixture(uid, pid, institution, owner, "CCTX-SECRET-" + uuid.uuid4().hex)
        self.stack.active[uid] = fixture
        self.addCleanup(self.stack.cleanup_fixture, uid)
        for index, (modality, tags) in enumerate(series, start=1):
            series_uid = new_uid()
            self.store(self.dicom(uid, series_uid, new_uid(), modality, patient, tags))
        fixture.desc, fixture.acc = patient["desc"], patient["acc"]  # type: ignore[attr-defined]
        if register:
            for _ in range(80):
                listed = self.stack.request("GET", "/studies", owner)
                if listed.status == 200 and any(row.get("uid") == uid for row in listed.body.get("studies", [])):
                    break
                self.pause()
            else:
                self.fail(f"the synthetic study never reached the worklist: {uid}")
            verifier = "jmryu" if institution == HALLYM else "ktech"
            self.assertEqual(self.stack.request("PATCH", f"/studies/{quote(uid)}", verifier, {"ss": "Verified"}).status, 200)
        return fixture

    @staticmethod
    def pause() -> None:
        time.sleep(0.25)

    # ── calls ──

    def context(self, uid: str, user: str, status: int = 200):
        result = self.stack.request("GET", f"/studies/{quote(uid)}/clinical-context", user)
        self.assertEqual(result.status, status, f"{user}: {result.text[:500]}")
        if status == 200:
            self.assert_answer(result.body, uid)
        return result

    def assert_answer(self, body: dict, uid: str) -> None:
        self.assertEqual(sorted(body), sorted(["schema", "uid", "observedAt", "patientKey", "anchor", "identity", "sections"]))
        self.assertEqual((body["schema"], body["uid"]), ("kin.clinical-context/1", uid))
        self.assertLessEqual(deep_keys(body), RESPONSE_KEYS, "only the closed response keys")
        keys = [key.lower() for key in deep_keys(body)]
        self.assertEqual([key for key in keys if key in FORBIDDEN_EXACT or any(f in key for f in FORBIDDEN_FRAGMENTS)], [])
        self.assertEqual(sorted(body["anchor"]), ["access", "institutionName", "techNoteVersion"])
        self.assertIn(body["anchor"]["access"], ("owner", "tele"))
        self.assertEqual(body["identity"]["conflict"], "mismatch" in (body["identity"]["birth"], body["identity"]["sex"]))
        self.assertEqual(sorted(body["sections"]), sorted(SECTIONS))
        for name in SECTIONS:
            section = body["sections"][name]
            expected = ["state", "reason", "sourceLabel", "observedAt", "truncated", "items"] + (["checked"] if name == "requestTags" else [])
            self.assertEqual(sorted(section), sorted(expected), name)
            self.assertIn(section["state"], ("present", "absent", "not_configured", "failed"), name)
            self.assertEqual(section["items"] == [], section["state"] != "present", name)
            for item in section["items"]:
                self.assertEqual(item["provenance"]["kind"], KINDS[name])
                if name in ("priorReports", "history"):
                    self.assertEqual(item["access"], body["anchor"]["access"])
                    self.assertNotEqual(item["studyUid"], uid, "the anchor is never a prior or a history row")
        tags = body["sections"]["requestTags"]
        self.assertEqual(tags["checked"], FIVE if tags["state"] in ("present", "absent") else [])

    def pending_token(self) -> str:
        """A member without an institution group (radiologist role): the guard answers INSTITUTION_PENDING."""
        username = f"kin-test-{uuid.uuid4().hex[:12]}-ccpending"
        self.assertRegex(username, OWNED_USERNAME)
        password = uuid.uuid4().hex + "Aa1!"
        created = self.stack.kc_admin("POST", "/users", {"username": username, "enabled": True, "emailVerified": True,
                                                         "email": username + "@local.test", "firstName": "KIN", "lastName": "ccpending"})
        self.assertEqual(created.status, 201, created.text)
        user_id = str(created.body)
        self.owned_users.append(user_id)
        reset = self.stack.kc_admin("PUT", f"/users/{quote(user_id)}/reset-password",
                                    {"type": "password", "value": password, "temporary": False})
        self.assertEqual(reset.status, 204, reset.text)
        self.stack.set_member_rights(user_id, approvalState="PENDING")
        data = urlencode({"client_id": self.stack.test_client_id, "grant_type": "password", "username": username,
                          "password": password}).encode("ascii")
        request = Request(self.stack.keycloak, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        with self.stack._open(request) as response:
            return json.loads(response.read().decode("utf-8"))["access_token"]

    def restrict(self, logical: str, policy: dict) -> None:
        subject = self.stack.user_ids[logical]
        self.addCleanup(self.clear_access, subject)
        written = self.stack.request("POST", f"/admin/users/{quote(subject)}/study-access", "jmryu", {
            "expectedOwner": member_owner(self.stack, "jmryu"), "policy": policy, "revision": 0,
            "reason": "SYNTHETIC S7-U4a access condition", "requestId": str(uuid.uuid4())})
        self.assertEqual(written.status, 201, written.text)

    def clear_access(self, subject: str) -> None:
        self.assertIn(subject, self.stack.user_ids.values())
        for table in ("StudyAccessRevision", "StudyAccessPolicy"):
            for raw in psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE subject={lit(subject)}'):
                self.assertTrue(json.loads(raw)["reason"].startswith("SYNTHETIC"))
                self.assertEqual(psql(f'DELETE FROM "{table}" t WHERE to_jsonb(t)={lit(raw)}::jsonb RETURNING 1'), ["1"])
        for raw in psql(f"SELECT to_jsonb(t)::text FROM \"AuditLog\" t WHERE target={lit(subject)} AND action='study.access'"):
            self.assertTrue(json.loads(json.loads(raw)["detail"])["reason"].startswith("SYNTHETIC"))
            self.assertEqual(psql(past_audit_guard(f'DELETE FROM "AuditLog" t WHERE to_jsonb(t)={lit(raw)}::jsonb RETURNING 1')),
                             ["1"])

    def commit(self, fixture: Fixture, user: str, action: str, base: int, findings: str | None = None, **extra) -> int:
        body = {"action": action, "baseVersion": base, "findings": findings if findings is not None else fixture.secret,
                "conclusion": "SYN conclusion", "recommendation": "", **extra}
        result = self.stack.request("POST", f"/studies/{quote(fixture.uid)}/report/commit", user, body)
        self.assertEqual(result.status, 201, result.text[:400])
        return result.body["version"]

    def tele(self, uid: str, open_: bool = True) -> None:
        body = {"ts": "wait", "teleTo": "kin-center"} if open_ else {"ts": "cancelled"}
        self.assertEqual(self.stack.request("PATCH", f"/studies/{quote(uid)}", "doctor", body).status, 200)

    def section_uids(self, body: dict, name: str) -> list[str]:
        return [item["studyUid"] for item in body["sections"][name]["items"]]

    # ── cases ──

    def test_cc_l01_roles(self) -> None:
        pid = "CCTX-L01-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid)
        for user in ("doctor", "ccadmin", "ccmixed", "jmryu"):
            with self.subTest(allowed=user):
                self.context(anchor.uid, user)
        tech = self.context(anchor.uid, "tech", 403)
        self.assertEqual(tech.body.get("code"), "CLINICAL_CONTEXT_ROLE")
        clinician = self.context(anchor.uid, "ccclinician", 403)
        self.assertEqual(clinician.body.get("code"), DENIED)
        pending = self.stack.bearer_request("GET", f"/studies/{quote(anchor.uid)}/clinical-context", self.pending_token())
        self.assertEqual((pending.status, pending.body.get("code")), (401, "AUTH_SESSION_ENDED"))
        request = Request(self.stack.api + f"/studies/{quote(anchor.uid)}/clinical-context",
                          headers={"Accept": "application/json", "Authorization": "Bearer " + self.stack.token("doctor")})
        with self.stack._open(request) as response:
            cache = response.headers.get("Cache-Control")
        self.assertEqual(cache, "no-store")
        marker("L01-roles", technician=tech.status, clinician=clinician.status, pending=pending.status, cache_control=cache)

    def test_cc_l02_institution_and_tele(self) -> None:
        pid = "CCTX-L02-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid, date="20260105")
        referred = self.upload(pid=pid, date="20260104")
        kept = self.upload(pid=pid, date="20260103")
        own = self.upload(pid=pid, institution=KIN, date="20260102")
        unknown = self.stack.request("GET", f"/studies/{quote(new_uid())}/clinical-context", "kdoctor")
        self.assertEqual(unknown.status, 404)
        for user in ("kdoctor", "kcadmin"):
            with self.subTest(other_institution=user):
                self.assertEqual(self.context(anchor.uid, user, 404).text, unknown.text, "the same bytes as an unknown UID")
        self.tele(anchor.uid)
        self.tele(referred.uid)
        body = self.context(anchor.uid, "kdoctor").body
        self.assertEqual(body["anchor"]["access"], "tele")
        self.assertEqual(self.section_uids(body, "history"), [referred.uid], "only the sender's referred same-key study")
        self.assertNotIn(own.uid, json.dumps(body))
        self.assertNotIn(kept.uid, json.dumps(body))
        self.tele(referred.uid, open_=False)
        after = self.context(anchor.uid, "kdoctor").body
        self.assertEqual(after["sections"]["history"]["state"], "absent", "a cancelled referral leaves the answer")
        self.tele(anchor.uid, open_=False)
        self.assertEqual(self.context(anchor.uid, "kdoctor", 404).text, unknown.text)
        marker("L02-tenant", tele_history=len(body["sections"]["history"]["items"]), after_cancel=after["sections"]["history"]["state"])

    def test_cc_l03_study_access(self) -> None:
        pid = "CCTX-L03-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid, date="20260110")
        allowed = self.upload(pid=pid, date="20260109")
        by_uid = self.upload(pid=pid, date="20260108")
        by_tag = self.upload(pid=pid, date="20260107", series=(("MR", {}),))
        for fixture in (allowed, by_uid, by_tag):
            self.commit(fixture, "doctor", "approve", 0)
        everyone = self.context(anchor.uid, "doctor2").body
        self.assertEqual(sorted(self.section_uids(everyone, "priorReports")), sorted([allowed.uid, by_uid.uid, by_tag.uid]))
        self.restrict("doctor2", restricted(rule(studyUids=[anchor.uid, allowed.uid, by_tag.uid])))
        body = self.context(anchor.uid, "doctor2").body
        for name in ("priorReports", "history"):
            self.assertNotIn(by_uid.uid, self.section_uids(body, name), name)
            self.assertIn(allowed.uid, self.section_uids(body, name), name)
        self.clear_access(self.stack.user_ids["doctor2"])
        self.restrict("doctor2", restricted(rule(modalities=["CT"])))
        body = self.context(anchor.uid, "doctor2").body
        for name in ("priorReports", "history"):
            self.assertNotIn(by_tag.uid, self.section_uids(body, name), name)
            self.assertIn(by_uid.uid, self.section_uids(body, name), name)
        self.clear_access(self.stack.user_ids["doctor2"])
        self.restrict("doctor2", restricted(rule(studyUids=[allowed.uid])))
        self.context(anchor.uid, "doctor2", 404)
        marker("L03-study-access", uid_rule="excluded", tag_rule="excluded", anchor_excluded=404)

    def test_cc_l04_signed_heads_only(self) -> None:
        pid = "CCTX-L04-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid, date="20260120")
        prelim = self.upload(pid=pid, date="20260119")
        temporary = self.upload(pid=pid, date="20260118")
        signed = self.upload(pid=pid, date="20260117")
        self.commit(prelim, "doctor", "preliminary", 0, reviewer=self.stack.actor("jmryu"))
        self.commit(temporary, "doctor", "save", 0)
        for user in ("doctor", "jmryu", "doctor2"):
            with self.subTest(reader=user):
                body = self.context(anchor.uid, user).body
                text = json.dumps(body, ensure_ascii=False)
                self.assertNotIn(prelim.secret, text, "no P body, even for the P pair")
                self.assertNotIn(temporary.secret, text)
                self.assertEqual(body["sections"]["priorReports"]["state"], "absent")
                rows = {item["studyUid"]: item["reading"] for item in body["sections"]["history"]["items"]}
                self.assertEqual(rows[prelim.uid], {"rs": "P", "signed": False, "reportVersion": 1})
                self.assertEqual((rows[temporary.uid]["rs"], rows[temporary.uid]["signed"]), ("T", False))
        version = self.commit(signed, "doctor", "approve", 0, findings="CCTX-APPROVED-" + signed.secret)
        body = self.context(anchor.uid, "doctor2").body
        self.assertEqual(self.section_uids(body, "priorReports"), [signed.uid])
        self.assertEqual(body["sections"]["priorReports"]["items"][0]["report"]["findings"], "CCTX-APPROVED-" + signed.secret)
        version = self.commit(signed, "doctor2", "addendum", version, findings="CCTX-ADDENDUM-" + signed.secret)
        body = self.context(anchor.uid, "doctor2").body
        report = body["sections"]["priorReports"]["items"][0]["report"]
        self.assertEqual((report["version"], report["action"], report["findings"]), (version, "addendum", "CCTX-ADDENDUM-" + signed.secret))
        self.assertNotIn("CCTX-APPROVED-", json.dumps(body, ensure_ascii=False), "the earlier approve row is not the head")
        self.commit(signed, "doctor", "reset", version, reason="SYN reset")
        body = self.context(anchor.uid, "doctor2").body
        self.assertEqual(body["sections"]["priorReports"]["state"], "absent", "a reset head is not signed")
        self.assertNotIn("SYN reset", json.dumps(body, ensure_ascii=False))
        marker("L04-signed", prelim_rows="history only", addendum_version=version)

    def test_cc_l05_same_key_conflict_and_name_trap(self) -> None:
        pid = "CCTX-L05-" + uuid.uuid4().hex[:8].upper()
        name = "SYN^SAMENAME" + uuid.uuid4().hex[:6].upper()
        anchor = self.upload(pid=pid, name=name, birth="19800517", sex="M")
        other_birth = self.upload(pid=pid, name="SYN^OTHER", birth="19810203", sex="M")
        same_name = self.upload(pid=pid + "-X", name=name, birth="19800517", sex="M")
        body = self.context(anchor.uid, "doctor").body
        self.assertEqual(body["identity"], {"conflict": True, "birth": "mismatch", "sex": "match"})
        rows = {item["studyUid"]: item["identity"] for item in body["sections"]["history"]["items"]}
        self.assertEqual(rows, {other_birth.uid: {"birth": "mismatch", "sex": "match"}})
        self.assertNotIn(same_name.uid, json.dumps(body))
        for value in ("19800517", "19810203"):
            self.assertNotIn(value, json.dumps(body), "no birth date value is sent")
        listed = self.stack.request("GET", "/studies", "doctor")
        self.assertEqual(listed.status, 200)
        row = next(row for row in listed.body["studies"] if row["uid"] == anchor.uid)
        self.assertEqual(body["patientKey"], row["sourcePatientKey"])
        marker("L05-identity", conflict=True, patient_key_matches_worklist=True)

    def test_cc_l06_order_values_excluded(self) -> None:
        run = uuid.uuid4().hex[:10].upper()
        pid = "CCTX-L06-" + run
        sentinel = {key: f"SENTINEL-{key.upper()}-{run}" for key in ("oid", "pid", "name", "descr", "ward", "reqdoc", "sched")}
        anchor = self.upload(pid=pid, date="20260125", series=(("CT", {"ReasonForStudy": "SYN L06 reason"}),))
        prior = self.upload(pid=pid, date="20260124", desc="SYN L06 ORIGINAL DESC " + run, acc="SYNL06" + run[:8])
        created: list[str] = []

        def insert(oid: str) -> None:
            values = [oid, "hallym", sentinel["pid"], sentinel["name"], "O", "", sentinel["sched"], "CT", sentinel["descr"],
                      sentinel["ward"], sentinel["reqdoc"]]
            psql('INSERT INTO "Order" (oid,"institutionId","patientId",name,sex,birth,sched,modality,descr,ward,"reqDoc") VALUES ('
                 + ",".join(lit(v) for v in values) + ")")
            created.append(oid)

        def remove_orders() -> None:
            for oid in created:
                for raw in psql(f'SELECT to_jsonb(t)::text FROM "Order" t WHERE oid={lit(oid)}'):
                    self.assertTrue(json.loads(raw)["patientId"] == sentinel["pid"], raw)
                    self.assertEqual(psql(f'DELETE FROM "Order" t WHERE to_jsonb(t)={lit(raw)}::jsonb RETURNING oid'), [oid])
        self.addCleanup(remove_orders)
        for suffix, fixture in (("-C", anchor), ("-P", prior)):
            insert(sentinel["oid"] + suffix)
            matched = self.stack.request("POST", "/match", "tech", {"uid": fixture.uid, "oid": sentinel["oid"] + suffix, "patient": {}})
            self.assertEqual(matched.status, 201, matched.text[:300])
            self.assertEqual((matched.body["matched"], matched.body["ward"]), ("M", sentinel["ward"]), "the Match copies exist")
        note = self.stack.request("POST", f"/studies/{quote(anchor.uid)}/tech-note", "tech",
                                  {"baseVersion": 0, "text": "SYN L06 note", "reason": ""})
        self.assertIn(note.status, (200, 201), note.text[:300])
        self.commit(prior, "doctor", "approve", 0)
        for user in ("doctor", "ccadmin"):
            with self.subTest(reader=user):
                result = self.context(anchor.uid, user)
                self.assertNotIn("SENTINEL", result.text, "(1) no sentinel byte")
                body = result.body
                row = next(item for item in body["sections"]["history"]["items"] if item["studyUid"] == prior.uid)
                self.assertEqual((row["study"]["description"], row["study"]["accession"]), (prior.desc, prior.acc),  # type: ignore[attr-defined]
                                 "(2) the original DICOM values, not the overlay")
                self.assertNotIn(anchor.uid, self.section_uids(body, "history"), "(3) no history row is the anchor")
                self.assertEqual({name: body["sections"][name]["state"] for name in SECTIONS},
                                 {name: "present" for name in SECTIONS}, "(4) every section is present")
        marker("L06-order-excluded", sentinel_bytes=0, sections="present")

    def test_cc_l07_request_tags(self) -> None:
        pid = "CCTX-L07-" + uuid.uuid4().hex[:8].upper()
        values = {"ReasonForStudy": "  앞 공백 합성 사유", "ReasonForTheRequestedProcedure": "SYN 요청 사유",
                  "AdditionalPatientHistory": "SYN 병력 " + "가" * 300, "AdmittingDiagnosesDescription": "SYN 입원 진단",
                  "StudyComments": "SYN comment"}
        five = self.upload(pid=pid, series=(("CT", values), ("SR", {"ReasonForStudy": "SYN SR VALUE"})))
        tags = self.context(five.uid, "doctor").body["sections"]["requestTags"]
        self.assertEqual(tags["state"], "present")
        self.assertEqual([(item["keyword"], item["value"], item["note"]) for item in tags["items"]],
                         [(keyword, values[keyword], None) for keyword in values])
        instances = self.stack._orthanc_request("POST", "/tools/lookup", five.uid.encode("ascii"))
        study_id = next(item["ID"] for item in instances.body if item["Type"] == "Study")
        series = self.stack._orthanc_request("GET", f"/studies/{quote(study_id)}/series").body
        image = next(item for item in series if item["MainDicomTags"]["Modality"] == "CT")
        sop = self.stack._orthanc_request("GET", f"/series/{quote(image['ID'])}/instances").body[0]["MainDicomTags"]["SOPInstanceUID"]
        self.assertEqual({item["provenance"]["recordId"] for item in tags["items"]}, {sop}, "the image instance, not the SR")
        none = self.context(self.upload(pid=pid + "-N").uid, "doctor").body["sections"]["requestTags"]
        self.assertEqual((none["state"], none["reason"], none["checked"]), ("absent", None, FIVE))
        one = self.context(self.upload(pid=pid + "-1", series=(("CT", {"ReasonForStudy": "SYN only"}),)).uid, "doctor").body
        self.assertEqual([item["keyword"] for item in one["sections"]["requestTags"]["items"]], ["ReasonForStudy"])
        derived = self.upload(pid=pid + "-SR", series=(("SR", {"ReasonForStudy": "SYN SR ONLY"}),))
        sr = self.context(derived.uid, "doctor").body["sections"]["requestTags"]
        self.assertEqual((sr["state"], sr["reason"], sr["checked"], sr["items"]), ("not_configured", "no_original_instance", [], []))
        marker("L07-request-tags", present=len(tags["items"]), derived_only=sr["state"])

    def test_cc_l08_tech_note_metadata(self) -> None:
        pid = "CCTX-L08-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid)
        body = self.context(anchor.uid, "doctor").body
        self.assertEqual((body["sections"]["techNote"]["state"], body["anchor"]["techNoteVersion"]), ("absent", 0))
        text, reason = "CCTX-NOTE-TEXT-" + uuid.uuid4().hex, "CCTX-NOTE-REASON-" + uuid.uuid4().hex
        first = self.stack.request("POST", f"/studies/{quote(anchor.uid)}/tech-note", "tech", {"baseVersion": 0, "text": text, "reason": ""})
        self.assertIn(first.status, (200, 201), first.text[:300])
        result = self.context(anchor.uid, "doctor")
        note = result.body["sections"]["techNote"]
        self.assertEqual((note["state"], note["items"][0]["version"], note["items"][0]["hasText"]), ("present", 1, True))
        self.assertEqual(note["items"][0]["provenance"]["author"], self.stack.actor("tech"))
        self.assertRegex(note["items"][0]["provenance"]["recordedAt"], ISO)
        self.assertNotIn(text, result.text)
        emptied = self.stack.request("POST", f"/studies/{quote(anchor.uid)}/tech-note", "tech", {"baseVersion": 1, "text": "", "reason": reason})
        self.assertIn(emptied.status, (200, 201), emptied.text[:300])
        result = self.context(anchor.uid, "doctor")
        note = result.body["sections"]["techNote"]
        self.assertEqual((note["items"][0]["version"], note["items"][0]["hasText"], result.body["anchor"]["techNoteVersion"]), (2, False, 2))
        self.assertNotIn(reason, result.text)
        self.assertNotIn(text, result.text)
        marker("L08-tech-note", versions=[1, 2], has_text=[True, False])

    def test_cc_l09_read_only(self) -> None:
        pid = "CCTX-L09-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid)
        prior = self.upload(pid=pid)
        self.commit(prior, "doctor", "approve", 0)
        hidden = self.upload(pid=pid, register=False)
        self.stack.token("doctor")

        def marks() -> dict:
            return {
                "audit": psql('SELECT count(*) FROM "AuditLog"'),
                "states": psql('SELECT count(*) FROM "StudyState"'),
                "versions": psql("SELECT md5(coalesce(string_agg(to_jsonb(v)::text, ',' ORDER BY v.id), '')) FROM \"ReportVersion\" v"),
                "notes": psql("SELECT md5(coalesce(string_agg(to_jsonb(n)::text, ',' ORDER BY n.\"studyUid\", n.version), '')) FROM \"TechNoteRevision\" n"),
                "orthanc": self.stack._orthanc_request("GET", "/changes?last").body.get("Last"),
            }
        before = marks()
        body = self.context(anchor.uid, "doctor").body
        self.assertEqual(marks(), before, "the read wrote nothing")
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyState" WHERE uid={lit(hidden.uid)}'), ["0"], "no lazy registration")
        self.assertNotIn(hidden.uid, json.dumps(body))
        self.assertEqual(self.section_uids(body, "history"), [prior.uid])
        marker("L09-read-only", unchanged=sorted(before))

    def test_cc_l10_provenance_and_permission_basis(self) -> None:
        pid = "CCTX-L10-" + uuid.uuid4().hex[:8].upper()
        anchor = self.upload(pid=pid, date="20260130", series=(("CT", {"ReasonForStudy": "SYN L10"}),))
        prior = self.upload(pid=pid, date="20260129")
        self.commit(prior, "doctor", "approve", 0)
        note = self.stack.request("POST", f"/studies/{quote(anchor.uid)}/tech-note", "tech", {"baseVersion": 0, "text": "SYN", "reason": ""})
        self.assertIn(note.status, (200, 201), note.text[:300])
        start = datetime.now(timezone.utc)
        owner = self.context(anchor.uid, "doctor").body
        end = datetime.now(timezone.utc)
        for name in SECTIONS:
            self.assertEqual(owner["sections"][name]["state"], "present", name)
            for item in owner["sections"][name]["items"]:
                p = item["provenance"]
                self.assertEqual(sorted(p), ["author", "kind", "observedAt", "recordId", "recordedAt", "version"])
                self.assertTrue(start.replace(microsecond=0) <= instant(p["observedAt"]) <= end, name)
                if name in ("history", "requestTags"):
                    self.assertEqual((p["version"], p["author"]), (None, None), name)
                else:
                    self.assertIsInstance(p["version"], int)
                    self.assertTrue(p["author"])
                if name == "requestTags":
                    self.assertIsNone(p["recordedAt"])
                else:
                    self.assertRegex(p["recordedAt"], ISO)
        self.assertEqual(owner["anchor"]["access"], "owner")
        self.assertEqual({item["access"] for name in ("priorReports", "history") for item in owner["sections"][name]["items"]}, {"owner"})
        self.tele(anchor.uid)
        self.tele(prior.uid)
        tele = self.context(anchor.uid, "kdoctor").body
        self.assertEqual((tele["anchor"]["access"], tele["anchor"]["institutionName"]), ("tele", HALLYM))
        self.assertEqual({item["access"] for name in ("priorReports", "history") for item in tele["sections"][name]["items"]}, {"tele"})
        marker("L10-provenance", owner="owner", tele="tele")

    def test_cc_l11_no_patient_key(self) -> None:
        anchor = self.upload(pid="", series=(("CT", {"ReasonForStudy": "SYN L11"}),))
        body = self.context(anchor.uid, "doctor").body
        for name in ("priorReports", "history"):
            section = body["sections"][name]
            self.assertEqual((section["state"], section["reason"], section["observedAt"], section["items"]),
                             ("not_configured", "no_patient_key", None, []), name)
        self.assertIsNone(body["patientKey"])
        self.assertEqual(body["sections"]["requestTags"]["state"], "present")
        self.assertEqual(body["sections"]["techNote"]["state"], "absent")
        marker("L11-no-key", prior="not_configured", history="not_configured")


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
