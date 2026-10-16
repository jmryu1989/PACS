"""EMR-D round 2 live cases (REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01..04, the server halves; the G3
flow EmrDLive.test_d_flow_write_amend_reopen; the live mutants M-D-01..05 of emr/units/d.json).

Runs only through scripts/run-tests.py in live mode. The database is a PostgreSQL 16 container this class creates itself
(no network, tmpfs data and tablespace, generated credentials, this run's label kin.emrd.live); the product is the
production API image of this checkout (KIN_TEST_API_IMAGE, else built here and removed at the end). The image's own
`migrate` mode applies every migration with the installer credential after the EMR-B provisioning; the compiled six owning
services, the D runtime/store/signature port, B1's ledger and C's verifier then run as the runtime role through
tests/emr/d/live_driver.cjs, which stands in only for what unlanded units supply at server start (B2's verified context,
C's study reader and key/anchor readers with an explicit test key policy) and for Keycloak/Orthanc. Every stored fact is
read back here directly from the catalog and the tables as the installer. No port is published, no compose stack or
foreign container is touched; everything created carries this run's label and is removed by class cleanup.
Assertions are stored facts, SQLSTATEs and closed error codes. Synthetic data only.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
import live_test_gate as gate  # noqa: E402

_spec = importlib.util.spec_from_file_location("emr_compose", ROOT / "scripts" / "emr-compose.py")
emr_compose = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(emr_compose)

POSTGRES = "postgres:16-alpine"
DRIVER_DIR = ROOT / "tests" / "emr" / "d"
STATE = "/var/lib/kin-emr"
TABLESPACE = "/var/lib/postgresql/emr-access/ts"
DECLARATION = json.loads((ROOT / "emr" / "units" / "d.json").read_text(encoding="utf-8"))
REFUSED = "42501"
PEOPLE = {"c1": "c1000000-0000-4000-8000-000000000001", "c2": "c2000000-0000-4000-8000-000000000002",
          "r1": "a1000000-0000-4000-8000-000000000001", "r2": "a2000000-0000-4000-8000-000000000002",
          "t1": "b1000000-0000-4000-8000-000000000001", "ad": "d1000000-0000-4000-8000-000000000001",
          "rb": "e1000000-0000-4000-8000-000000000001"}
TEXT = {"question": "SYN 흉통 지속\n이전 CT와 비교 바랍니다 é ", "answer": "SYN 이전 CT 대비 변화 없음.", "request": "SYN 외부 병원 영상 요청 사유",
        "close": "SYN 외부 영상 수신 처리 완료 기록", "consult": "SYN 자문 의뢰: 결절 성상", "reply": "SYN 자문 답변: 양성 소견"}
# The live mutants (emr/units/d.json): one change of the compiled /app/dist each, applied in a copy by the driver.
MUTANTS = {
    "M-D-01": {"file": "emr-clinical/contract.js", "old": "return path.capacity === C ? 'clinical-entry' : 'operational-note';",
               "new": "return path.capacity === C ? 'assignment' : 'operational-note';"},
    "M-D-02": {"file": "emr-clinical/store.js", "old": "${JSON.stringify(v)}::text", "new": "${JSON.stringify({ ...v, text: null })}::text"},
    "M-D-03": {"file": "emr-clinical/signing.js", "old": "if (checks.some(ok => !ok))", "new": "if (false && checks.some(ok => !ok))"},
    "M-D-04": {"file": "emr-clinical/records.js",
               "old": "row.storedAt !== null || row.adoptedVersion !== null ? 'adopted' :\n            row.attemptedAt !== null ? 'store-attempted' :\n            ",
               "new": ""},
    "M-D-05": {"file": "emr-clinical/records.js", "old": "return institutionId === managing;", "new": "return true;"},
}
_studies = iter(range(600, 10000))


def run(args, *, env=None, input=None, timeout=300, check=True):
    result = subprocess.run(args, input=input, capture_output=True, timeout=timeout, env=env)
    if check and result.returncode:
        raise RuntimeError("%s %s failed (exit %d): %s" % (args[0], args[1], result.returncode,
                                                          result.stderr.decode("utf-8", "replace")[-1500:]))
    return result


def err(answer) -> dict:
    """The error of a driver answer, or an empty one: a missing refusal fails as an assertion, never as a KeyError."""
    return answer.get("error") or {}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def verified_image(image, identity_file, target_sha):
    """Pin the inspected tag to the identity accepted by CI before any DB work."""
    words = Path(identity_file).read_text(encoding="utf-8").split()
    if len(words) != 2 or not re.fullmatch(r"sha256:[0-9a-f]{64}", words[0]) or words[1] != target_sha:
        raise RuntimeError("EMR-D image identity does not name TARGET_SHA")
    inspected = json.loads(run(["docker", "image", "inspect", image]).stdout)[0]
    revision = (inspected.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision")
    if inspected.get("Id") != words[0] or revision != target_sha:
        raise RuntimeError("EMR-D selected image ID/revision differs from verified identity")
    print("EMR_D_USED_IMAGE " + json.dumps({"id": inspected["Id"], "revision": revision}), flush=True)
    return inspected["Id"]


class EmrDLive(unittest.TestCase):
    label_namespace = "kin.emrd.live"

    @classmethod
    def setUpClass(cls):
        gate.require_live_run()
        cls.token = uuid.uuid4().hex[:12]
        cls.label = cls.label_namespace + "=" + cls.token
        cls.created = {"container": [], "volume": [], "image": []}
        cls.addClassCleanup(cls.cleanup_resources)
        cls.secrets = {name: secrets.token_hex(24) for name in
                       ("POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD", "KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD")}
        cls.env = {**os.environ, **cls.secrets}
        image = os.environ.get("KIN_TEST_API_IMAGE")
        if image:
            cls.image = verified_image(image, os.environ.get("KIN_EMR_D_IMAGE_IDENTITY", str(ROOT / "tmp/emr-d-ci/image-identity.txt")),
                                       os.environ.get("TARGET_SHA", ""))
        else:
            tag = "kin-emrd-live:" + cls.token
            run(["docker", "build", "--target", "production", "--label", cls.label, "--build-arg", "VCS_REF=emr-d-live",
                 "-t", tag, str(ROOT / "api")], timeout=2400)
            cls.created["image"].append(tag)
            cls.image = json.loads(run(["docker", "image", "inspect", tag]).stdout)[0]["Id"]
        cls.work = tempfile.mkdtemp(prefix="kin-emrd-")
        os.chmod(cls.work, 0o777)
        cls.addClassCleanup(shutil.rmtree, cls.work, True)
        cls.db = cls.start_db()
        cls.provision()
        cls.migrate()
        # The real request context authorizes against MemberRights; Keycloak-only stand-ins no longer model admission.
        roles = {"c1": "clinician", "c2": "clinician", "r1": "radiologist", "r2": "radiologist", "rb": "radiologist", "t1": "technician", "ad": "admin"}
        statements = ['INSERT INTO "Institution" (id,name) VALUES (\'inst-a\',\'SYN A\'),(\'inst-b\',\'SYN B\') ON CONFLICT (id) DO NOTHING;']
        for name, sub in PEOPLE.items():
            statements.append('INSERT INTO "MemberRights" (sub, username, email, name, "emailVerified", approved, suspended, institution, roles, "updatedAt") '
                              "VALUES ('%s','%s','%s@synthetic.test','SYN %s',true,true,false,'%s',ARRAY['%s'],now());"
                              % (sub, name, name, name, "inst-b" if name == "rb" else "inst-a", roles[name]))
        run(["docker", "exec", "-i", cls.db, "psql", "-X", "-U", "kin", "-d", "kin", "-v", "ON_ERROR_STOP=1"], input="\n".join(statements).encode())
        cls.state = cls.volume("state")

    @classmethod
    def cleanup_resources(cls):
        problems = []
        for kind in ("container", "volume", "image"):
            for name in reversed(cls.created[kind]):
                args = {"container": ["docker", "rm", "-f", "-v", name], "volume": ["docker", "volume", "rm", "-f", name],
                        "image": ["docker", "image", "rm", "-f", name]}[kind]
                if run(args, check=False, timeout=120).returncode:
                    problems.append(kind + " " + name)
        leftover = run(["docker", "ps", "-aq", "--filter", "label=" + cls.label], check=False).stdout.split()
        leftover += run(["docker", "volume", "ls", "-q", "--filter", "label=" + cls.label], check=False).stdout.split()
        if problems or leftover:
            raise RuntimeError("EMR-D live cleanup incomplete: %s %s" % (problems, leftover))

    # ── the disposable environment ──

    @classmethod
    def start_db(cls):
        name = "kin-emrd-%s-db" % cls.token
        cls.created["container"].append(name)
        run(["docker", "run", "-d", "--name", name, "--label", cls.label, "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
             "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700", "-e", "POSTGRES_USER=kin", "-e", "POSTGRES_PASSWORD",
             "-e", "POSTGRES_DB=kin", POSTGRES], env=cls.env)
        for _ in range(240):
            if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "kin"], check=False).returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("disposable database did not start")
        run(["docker", "exec", "-u", "postgres", name, "mkdir", "-m", "700", TABLESPACE])
        return name

    @classmethod
    def provision(cls):
        result = run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD", "-e", "KIN_EMR_READER_PASSWORD", "-e",
                      "KIN_EMR_RETENTION_PASSWORD", cls.db, "psql", "-X", "-U", "kin", "-d", "kin"],
                     env=cls.env, input=emr_compose.PROVISION_SQL.encode(), check=False)
        if result.returncode:
            raise RuntimeError("provisioning failed: " + result.stderr.decode("utf-8", "replace")[-800:])

    @classmethod
    def url(cls, role="kin_runtime"):
        password = {"kin_runtime": "KIN_EMR_RUNTIME_PASSWORD", "kin": "POSTGRES_PASSWORD"}[role]
        return "postgresql://%s:%s@127.0.0.1:5432/kin" % (role, cls.secrets[password])

    @classmethod
    def migrate(cls):
        env = {**cls.env, "DATABASE_URL": cls.url("kin")}
        result = run(["docker", "run", "--rm", "--label", cls.label, "--network", "container:" + cls.db, "-e", "DATABASE_URL",
                      cls.image, "sh", "/app/start-production.sh", "migrate"], env=env, check=False, timeout=300)
        if result.returncode:
            raise RuntimeError("migration failed: " + (result.stdout + result.stderr).decode("utf-8", "replace")[-1500:])

    @classmethod
    def volume(cls, suffix):
        name = "kin-emrd-%s-%s" % (cls.token, suffix)
        cls.created["volume"].append(name)
        run(["docker", "volume", "create", "--label", cls.label, name])
        return name

    def driver(self, operation, args=None, mutant=None):
        env = {**self.env, "DATABASE_URL": self.url(), "KIN_EMR_STATE_DIR": STATE, "NODE_PATH": "/app/node_modules"}
        extra = []
        if mutant:
            env["KIN_EMR_D_MUTANT"] = json.dumps(MUTANTS[mutant])
            extra = ["-e", "KIN_EMR_D_MUTANT"]
        result = run(["docker", "run", "--rm", "--label", self.label, "--network", "container:" + self.db, "-e", "DATABASE_URL",
                      "-e", "KIN_EMR_STATE_DIR", "-e", "NODE_PATH", *extra, "-v", self.state + ":" + STATE,
                      "-v", str(DRIVER_DIR) + ":/emr-d:ro", "-v", self.work + ":/work", "--entrypoint", "node", self.image,
                      "/emr-d/live_driver.cjs", operation, json.dumps(args or {})], env=env, check=False, timeout=600)
        lines = [line for line in result.stdout.decode("utf-8", "replace").splitlines() if line.startswith("EMR_D_RESULT ")]
        if len(lines) != 1:
            self.fail("driver %s gave no single result (exit %d): %s" % (operation, result.returncode,
                                                                          result.stderr.decode("utf-8", "replace")[-1500:]))
        value = json.loads(lines[0][len("EMR_D_RESULT "):])
        # Every driver answer (synthetic data only) is kept beside the run records for the inspection of a failed case.
        kept = ROOT / "tmp" / "emr-d" / "runs" / "driver"
        kept.mkdir(parents=True, exist_ok=True)
        (kept / ("%s-%s-%s%s.json" % (self.token, self._testMethodName, operation, "-" + mutant if mutant else ""))).write_text(
            json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
        if "crashed" in value:
            # Preserve closed original-state evidence before class cleanup removes this run's synthetic database.
            facts = self.json("SELECT json_agg(json_build_object('record', record, 'state', state, 'phase', phase, 'confirmed', confirmed)) FROM emr_clinical.request")
            attempts = self.json("SELECT json_agg(code) FROM emr_clinical.attempt")
            print("R5A_STORAGE_FACTS " + json.dumps({"originals": facts, "attempt_codes": attempts}), flush=True)
        self.assertNotIn("crashed", value, "driver %s crashed: %s" % (operation, value))
        self.assertNotIn("mutantAnchor", value, "a mutant anchor must occur exactly once: %s" % value)
        return value


    def psql(self, sql, user="kin"):
        """(exit, stdout, first SQLSTATE) of one psql run (local socket, trust) as the given role."""
        result = run(["docker", "exec", "-i", self.db, "psql", "-X", "-q", "-A", "-t", "-U", user, "-d", "kin", "-v", "ON_ERROR_STOP=1"],
                     input=("\\set VERBOSITY sqlstate\n" + sql).encode(), check=False)
        stderr = result.stderr.decode("utf-8", "replace")
        state = next((line.split()[1] for line in stderr.splitlines() if line.startswith("ERROR:") and len(line.split()) > 1), None)
        return result.returncode, result.stdout.decode("utf-8", "replace").strip(), state

    def json(self, sql):
        code, out, state = self.psql("SELECT COALESCE((" + sql + ")::text, 'null');")
        self.assertEqual((code, state), (0, None), sql[:300])
        return json.loads(out)

    def ok(self, sql):
        code, out, state = self.psql(sql)
        self.assertEqual((code, state), (0, None), sql[:300])
        return out

    def literal(self, value):
        return "'" + str(value).replace("'", "''") + "'"

    # ── synthetic records ──

    def study(self, institution="inst-a"):
        uid = "1.2.826.0.1.3680043.10.%d" % next(_studies)
        self.ok('INSERT INTO "StudyState" (uid, "institutionId", "updatedAt") VALUES (%s, %s, now());' % (self.literal(uid), self.literal(institution)))
        return uid

    def measurement(self, uid, author="r1"):
        """A stored manual length measurement on a CT image of `uid` (its head and its revision 1, as the viewer writes both),
        and the Orthanc tags that verify it."""
        item, series, sop, frame = str(uuid.uuid4()), uid + ".1", uid + ".1.1", uid + ".9"
        snapshot = {"kind": "length", "seriesUid": series, "sopUid": sop, "frame": 1, "frameOfReferenceUid": frame, "label": "SYN length",
                    "points": [[10, 10, 0], [20, 20, 0]], "viewPlaneNormal": [0, 0, 1], "viewUp": [0, -1, 0], "baseline": None,
                    "sourceDigest": "ab" * 32}
        self.ok('INSERT INTO "ViewerItem" (id, "studyUid", "authorSub", "authorActor", revision, snapshot, "updatedAt") VALUES (%s::uuid, %s, %s, %s, 1, %s::jsonb, now());'
                % (self.literal(item), self.literal(uid), self.literal(PEOPLE[author]), self.literal(author + "@synthetic.test"),
                   self.literal(json.dumps(snapshot))))
        self.revision(item, 1, snapshot, author, "create")
        tags = {"StudyInstanceUID": uid, "SeriesInstanceUID": series, "SOPInstanceUID": sop, "SOPClassUID": "1.2.840.10008.5.1.4.1.1.2",
                "FrameOfReferenceUID": frame, "Rows": 512, "Columns": 512, "ImagePositionPatient": "0\\0\\0", "ImageOrientationPatient": "1\\0\\0\\0\\1\\0",
                "PixelSpacing": "1\\1", "Modality": "CT", "PatientID": "SYN-PATIENT-1", "_kinSourceDigest": "ab" * 32}
        return item, sop, tags

    def revision(self, item, revision, snapshot, author, action):
        """The immutable viewer revision row of `item` (payloadBytes as the table's CHECK computes it)."""
        self.ok('INSERT INTO "ViewerRevision" ("itemId", revision, snapshot, action, reason, actor, "payloadBytes", at) '
                "SELECT %s::uuid, %d, s, %s, '', %s, octet_length(convert_to(s::text, 'UTF8')), now() FROM (SELECT %s::jsonb AS s) x;"
                % (self.literal(item), revision, self.literal(action), self.literal(author + "@synthetic.test"), self.literal(json.dumps(snapshot))))

    def source_digest(self, item, revision):
        """SHA-256 of the canonical JSON (sorted keys) of one stored viewer revision: what a finding citing it pins."""
        snapshot = self.json('SELECT snapshot FROM "ViewerRevision" WHERE "itemId" = %s::uuid AND revision = %d' % (self.literal(item), revision))
        return sha(json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    def prepared_sr(self, uid, item, author="r1"):
        """A prepared manual SR copy of `uid` (the bytes this server would have built), not yet attempted."""
        made = self.driver("r5a-prepared-sr-fixture", {"study": uid, "item": item, "author": author})
        return made["id"], made["sop"], bytes.fromhex(made["hex"])

    # ── stored facts ──

    def versions(self, record_id):
        rows = self.json("SELECT json_agg(json_build_object('body', v.body::json, 'signature', v.signature::json, 'entry', v.entry, 'sha256', v.sha256) "
                         "ORDER BY v.sequence) FROM emr_clinical.version v WHERE v.record_id = %s" % self.literal(record_id)) or []
        return rows

    def register(self, request_id):
        return self.json("SELECT json_agg(json_build_object('state', r.state, 'phase', r.phase, 'terminal', r.terminal::json, 'seed', r.seed, "
                         "'original', r.original_id, 'record_id', r.record_id, 'confirmed', r.confirmed)) FROM emr_clinical.request r "
                         "WHERE r.request_id = %s" % self.literal(request_id)) or []

    def change_events(self, record_id):
        return self.json("SELECT json_agg(json_build_object('stream', e.stream, 'act', e.statutory_act, 'event', e.payload::json -> 'event') "
                         "ORDER BY e.stream, e.sequence) FROM emr_clinical.request r JOIN emr_access.access_entry e "
                         "ON e.event_id = 'clinical-write:' || r.original_id::text WHERE r.record_id = %s" % self.literal(record_id)) or []

    def provisions(self, record_id):
        events = self.json("SELECT json_agg(e.payload::json -> 'event' ORDER BY e.sequence) FROM emr_access.access_entry e "
                           "WHERE e.stream = 'viewing' AND e.payload::json #>> '{event,action}' = 'provide-prepared'") or []
        return [e for e in events if any(t["recordId"].get("value") == record_id for t in e["targets"])]

    def identity(self, name):
        return self.json("SELECT to_json(id::text) FROM emr_access.member_identity WHERE subject = %s" % self.literal(PEOPLE[name]))

    # ── the checks of each behaviour (shared by the case and its mutant) ──

    def check_d01(self, out, uid):
        ids = out["ids"]
        self.assertTrue(out["question"]["ok"], out["question"])
        self.assertTrue(out["answer"]["ok"], out["answer"])
        q = self.versions(ids["question"])
        self.assertEqual([(v["entry"], v["body"]["kind"], v["body"]["author"]["id"]) for v in q],
                         [("clinical-entry", "clinical-question", self.identity("c1")), ("clinical-entry", "clinical-answer", self.identity("r1"))])
        for v in q:
            self.assertIsNotNone(v["signature"], "every clinical entry carries its verified signature")
            self.assertEqual(v["signature"]["evidence"]["signer"]["id"], v["body"]["author"]["id"], "signed by its own author, never a proxy")
            self.assertEqual(v["signature"]["evidence"]["verification"], {"integrity": "valid", "registeredIdentity": "matched",
                                                                          "keyAtSigningTime": "active", "compromise": "not-known"})
        self.assertEqual(q[0]["body"]["text"], TEXT["question"], "the signed text is stored exactly as written")
        events = self.change_events(ids["question"])
        self.assertEqual(sorted((e["stream"], e["act"]) for e in events),
                         [("history", "기재"), ("history", "추가기재"), ("viewing", "기재"), ("viewing", "추가기재")])
        self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestionEntry" WHERE "questionId" = %s::uuid' % self.literal(ids["question"])), 2)
        # No signature: refused before admission, nothing written anywhere.
        self.assertEqual((out["unsigned"]["ok"], err(out["unsigned"]).get("status"), err(out["unsigned"]).get("code")),
                         (False, 403, "CLINICAL_SIGNATURE_REQUIRED"))
        for refused in ("unsigned", "proxy"):
            self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestion" WHERE id = %s::uuid' % self.literal(ids[refused])), 0, refused)
            self.assertEqual(self.versions(ids[refused]), [], refused)
        self.assertEqual(self.register(ids["unsigned"]), [])
        self.assertEqual((out["proxy"]["ok"], err(out["proxy"]).get("code")), (False, "CLINICAL_SIGNATURE_REFUSED"))
        [proxy] = self.register(ids["proxy"])
        self.assertEqual((proxy["state"], proxy["terminal"]["proof"]["code"]), ("rejected", "SignatureFailed"))
        # An assignment is an operational version: no text, no signature.
        self.assertTrue(out["assignment"]["ok"], out["assignment"])
        assignment = self.json("SELECT to_json(record_id) FROM emr_clinical.unit WHERE record = 'assignment' AND study_id = %s" % self.literal(uid))
        [a] = self.versions(assignment)
        self.assertEqual((a["entry"], a["body"]["text"], a["signature"], a["body"]["readerId"]), ("assignment", None, None, self.identity("r1")))
        # The clinician's request is signed; the technician's processing is unsigned operational text and state.
        for step in ("imageRequest", "accept", "close"):
            self.assertTrue(out[step]["ok"], out[step])
        ir = self.versions(ids["imageRequest"])
        self.assertEqual([(v["entry"], v["body"]["capacity"], v["signature"] is not None, v["body"]["text"]) for v in ir],
                         [("clinical-entry", "clinical-author", True, TEXT["request"]), ("state-change", "operational-staff", False, None),
                          ("operational-note", "operational-staff", False, TEXT["close"])])
        row = self.json('SELECT json_build_object(\'state\', state, \'revision\', revision, \'note\', note) FROM "StudyImageRequest" WHERE id = %s::uuid'
                        % self.literal(ids["imageRequest"]))
        self.assertEqual(row, {"state": "Closed", "revision": 3, "note": TEXT["close"]}, "the legacy row is the fold of the versions")

    def check_d02(self, out, uid):
        ids = out["ids"]
        for step in ("consult", "consultAccept", "consultComplete", "imageRequest", "decline", "finding", "hide", "restore"):
            self.assertTrue(out[step]["ok"], (step, out[step]))
        c = self.versions(ids["consultation"])
        self.assertEqual([(v["entry"], v["body"]["text"], v["signature"] is not None) for v in c],
                         [("clinical-entry", TEXT["consult"], True), ("state-change", None, False), ("clinical-entry", TEXT["reply"], True)])
        ir = self.versions(ids["imageRequest"])
        self.assertEqual([(v["entry"], v["body"]["text"]) for v in ir], [("clinical-entry", TEXT["request"]), ("operational-note", TEXT["close"])])
        f = self.versions(ids["finding"])
        self.assertEqual([(v["entry"], v["body"]["act"], v["body"]["reasonSource"]) for v in f],
                         [("clinical-entry", "entry", None), ("clinical-entry", "correction", "work-context"), ("clinical-entry", "correction", "stated")])
        self.assertTrue(f[1]["body"]["reason"].startswith("work-context:reading:hold:"), "inside the reading the server binds the reason")
        self.assertEqual(f[2]["body"]["reason"], "SYN 오기재 복원")
        self.assertEqual([json.loads(v["body"]["text"])["hidden"] for v in f], [False, True, False])
        for versions in (c, ir, f):
            for previous, current in zip(versions, versions[1:]):
                self.assertEqual(current["body"]["previousVersion"], {"recordId": previous["body"]["recordId"],
                                 "versionId": previous["body"]["versionId"], "sha256": previous["sha256"]}, "each version extends the one before")
        # Outside the reading, a hide without a stated reason commits nothing.
        self.assertEqual((out["hideOutOfContext"]["ok"], err(out["hideOutOfContext"]).get("status")), (False, 400))
        self.assertEqual(len(self.versions(ids["finding"])), 3)
        self.assertEqual(self.json('SELECT count(*) FROM "FindingRevision" WHERE "findingId" = %s::uuid' % self.literal(ids["finding"])), 3)
        row = self.json('SELECT json_build_object(\'reason\', reason, \'reply\', reply, \'state\', state, \'revision\', revision) FROM "StudyConsultation" '
                        'WHERE id = %s::uuid' % self.literal(ids["consultation"]))
        self.assertEqual(row, {"reason": TEXT["consult"], "reply": TEXT["reply"], "state": "Completed", "revision": 3})

    def run_sr(self, mutant=None):
        uid = self.study()
        item, sop, tags = self.measurement(uid)
        a, sop_a, data_a = self.prepared_sr(uid, item)
        b, sop_b, data_b = self.prepared_sr(uid, item)
        c, sop_c, data_c = self.prepared_sr(uid, item)
        d, sop_d, data_d = self.prepared_sr(uid, item)
        e, sop_e, data_e = self.prepared_sr(uid, item)
        out = self.driver("d02-sr", {"study": uid, "adopt": [a, d], "unsigned": e, "tags": {sop: tags}, "orthancFailing": [sop_d]})
        self.ok('UPDATE "ManualSr" SET "createdAt" = "createdAt" - interval \'25 hours\' WHERE id IN (%s);' % ",".join(
            self.literal(x) + "::uuid" for x in (a, b, c, d)))
        sweep = self.driver("d02-sweep", {"orthancHolds": {sop_a: data_a.hex(), sop_c: data_c.hex()}}, mutant=mutant)
        reread = self.driver("d02-reread", {"ids": [a, d]})
        return {"out": out, "sweep": sweep, "reread": reread, "uid": uid, "rows": {"a": (a, data_a), "b": (b, data_b), "c": (c, data_c),
                "d": (d, data_d), "e": (e, data_e)}}

    def check_sr(self, sr):
        out, rows = sr["out"], sr["rows"]
        a, d, e = rows["a"][0], rows["d"][0], rows["e"][0]
        self.assertTrue(out["store:" + a]["ok"], out["store:" + a])
        self.assertTrue(out["store:" + a]["value"]["stored"])
        self.assertFalse(out["store:" + d]["ok"], "the upload of D failed after its adoption committed")
        self.assertEqual((out["unsignedStore"]["ok"], err(out["unsignedStore"]).get("code")), (False, "CLINICAL_SIGNATURE_REQUIRED"))
        facts = self.json('SELECT json_object_agg(id::text, json_build_object(\'attempted\', "attemptedAt" IS NOT NULL, \'stored\', "storedAt" IS NOT NULL, '
                          '\'sha\', encode(sha256(dicom), \'hex\'))) FROM "ManualSr" WHERE "studyUid" = %s' % self.literal(sr["uid"]))
        for key, (record, data) in rows.items():
            self.assertEqual(facts[record]["sha"], sha(data), key + ": the bytes are kept by D (only unit H erases)")
        self.assertEqual((facts[a]["attempted"], facts[a]["stored"], facts[d]["attempted"], facts[d]["stored"], facts[e]["attempted"]),
                         (True, True, True, False, False))
        adopted = self.json("SELECT json_agg(record_id) FROM emr_clinical.sr_adoption WHERE record_id IN (%s)"
                            % ",".join(self.literal(x) for x in (a, d, e))) or []
        self.assertEqual(sorted(adopted), sorted([a, d]), "an adoption exists exactly for the signed store intents")
        ended = self.json("SELECT json_agg(record_id) FROM emr_clinical.sr_purpose_end WHERE record_id IN (%s)"
                          % ",".join(self.literal(r[0]) for r in rows.values())) or []
        self.assertEqual(ended, [rows["b"][0]], "only the unattempted copy Orthanc does not hold reached its purpose end")
        deferred = self.json('SELECT count(*) FROM "AuditLog" WHERE action = \'manualSr.expire-deferred\' AND target = %s' % self.literal(sr["uid"]))
        self.assertEqual(deferred, 0, "the clean-up completed")
        for record in (a, d):
            reread = sr["reread"][record]
            self.assertEqual((reread["bytesSha256"], reread["adoption"]["bytesSha256"]), (reread["rowSha256"], reread["rowSha256"]),
                             "after a restart the stored bytes are the bytes the author signed")
            self.assertEqual((reread["verified"].get("integrity"), reread["verified"].get("key")), ("valid", "active"), reread["verified"])

    def run_d03(self, mutant=None):
        uid = self.study()
        out = self.driver("d03", {"study": uid}, mutant=mutant)
        return out, uid

    def check_d03(self, out):
        qid = out["ids"]["question"]
        for step in ("question", "answer"):
            self.assertTrue(out[step]["ok"], (step, out[step]))
        for name in ("c1", "r1", "ad"):
            read = out["read:" + name]
            self.assertTrue(read["ok"], (name, read))
            self.assertEqual([e["body"] for e in read["value"]["item"]["entries"]], [TEXT["question"], TEXT["answer"]], name)
        for name in ("c2", "rb"):
            self.assertEqual((out["read:" + name]["ok"], err(out["read:" + name]).get("status")), (False, 404), name)
        self.assertEqual((out["runtimeForeign"]["ok"], err(out["runtimeForeign"]).get("code")), (False, "NotFound"),
                         "another institution gets no body through the runtime either")
        self.assertTrue(out["runtimeLocal"]["ok"], out["runtimeLocal"])
        self.assertEqual([e["body"] for e in out["runtimeLocal"]["value"]["item"]["entries"]], [TEXT["question"], TEXT["answer"]])
        self.assertEqual((out["runtimeForged"]["ok"], err(out["runtimeForged"]).get("code")), (False, "CLINICAL_RESPONSE_REFUSED"),
                         "a copied DTO cannot carry the private response capability")
        self.assertEqual(out["rawWrites"], 0)
        self.assertEqual((out["planForeign"]["ok"], err(out["planForeign"]).get("code")), (False, "NotFound"))
        provided = self.provisions(qid)
        self.assertEqual(sorted(e["userId"]["value"]["subject"] for e in provided), sorted(PEOPLE[n] for n in ("c1", "r1", "ad", "r1")),
                         "one durable provision per served reader and none for a refused one")
        versions = self.versions(qid)
        for e in provided:
            self.assertEqual([t["versionId"]["value"] for t in e["targets"]], [v["body"]["versionId"] for v in versions], "exactly the served versions")

    def run_d04(self, mutant=None):
        uid = self.study()
        return self.driver("d04", {"study": uid}, mutant=mutant), uid

    def check_d04(self, out):
        ids = out["ids"]
        self.assertTrue(out["first"]["ok"], out["first"])
        self.assertEqual((out["first"]["value"]["replayed"], out["replay"]["value"]["replayed"]), (False, True))
        self.assertEqual(out["replay"]["value"]["applied"], out["first"]["value"]["applied"], "a replay answers the stored receipt")
        self.assertEqual((out["replayUnsigned"]["ok"], out["replayUnsigned"]["value"]["replayed"]), (True, True))
        self.assertEqual((out["reused"]["ok"], err(out["reused"]).get("code")), (False, "REQUEST_ID_REUSED"))
        self.assertEqual(len(self.versions(ids["question"])), 1, "one commit per request")
        self.assertEqual(len(self.change_events(ids["question"])), 2, "one change event, in both streams")
        for key in ("tampered", "tamperedAgain"):
            self.assertEqual((out[key]["ok"], err(out[key]).get("code")), (False, "CLINICAL_SIGNATURE_REFUSED"), key)
        self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestion" WHERE id = %s::uuid' % self.literal(ids["tampered"])), 0)
        self.assertEqual(self.versions(ids["tampered"]), [])
        [tampered] = self.register(ids["tampered"])
        self.assertEqual((tampered["state"], tampered["terminal"]["proof"]["code"]), ("rejected", "SignatureFailed"))
        self.assertEqual(json.loads(tampered["seed"])["body"]["body"], TEXT["question"], "the author's input is preserved with the refused original")
        self.assertEqual((out["stale"]["ok"], err(out["stale"]).get("code")), (False, "QUESTION_CHANGED"))
        self.assertEqual(self.json('SELECT revision FROM "StudyQuestion" WHERE id = %s::uuid' % self.literal(ids["question"])), 1)

    # ── the cases ──

    def test_d00_schema_roles_and_placement(self):
        """The migration's schema: placed, owned, granted exactly as declared, append-only for every role."""
        schema = DECLARATION["schema"]
        relations = self.json("SELECT json_agg(json_build_object('name', c.relname, 'kind', c.relkind, 'owner', pg_get_userbyid(c.relowner), "
                              "'tablespace', COALESCE(t.spcname, 'database-default')) ORDER BY c.relname) FROM pg_class c "
                              "JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace "
                              "WHERE n.nspname = 'emr_clinical' AND c.relkind IN ('r', 'i')")
        self.assertEqual(sorted(r["name"] for r in relations if r["kind"] == "r"), sorted(schema["tables"]))
        self.assertTrue(all(r["owner"] == schema["owner"] and r["tablespace"] == schema["tablespace"] for r in relations), relations)
        self.assertEqual(self.json("SELECT to_json(pg_get_userbyid(nspowner)::text) FROM pg_namespace WHERE nspname = 'emr_clinical'"), schema["owner"])
        functions = "SELECT json_agg(p.proname || '(' || replace(oidvectortypes(p.proargtypes), ' ', '') || ')') FROM pg_proc p " \
                    "JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'emr_clinical' AND has_function_privilege(%s, p.oid, 'EXECUTE')"
        self.assertEqual(sorted(self.json(functions % "'kin_runtime'") or []), sorted(schema["runtime_functions"]))
        self.assertEqual(sorted(self.json(functions % "'kin_emr_reader'") or []), sorted(schema["reader_functions"]))
        self.assertEqual(self.json(functions % "'kin_emr_retention'"), None, "the retention job has no D function")
        definers = self.json("SELECT json_agg(p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                             "WHERE n.nspname = 'emr_clinical' AND has_function_privilege('kin_runtime', p.oid, 'EXECUTE') AND NOT p.prosecdef")
        self.assertIsNone(definers, "every runtime entry point runs as the owner")
        privileges = self.json("SELECT json_agg(json_build_object('table', c.relname, 'runtime', has_table_privilege('kin_runtime', c.oid, "
                               "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'reader', has_table_privilege('kin_emr_reader', c.oid, 'SELECT'), "
                               "'reader_write', has_table_privilege('kin_emr_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) ORDER BY c.relname) "
                               "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'emr_clinical' AND c.relkind = 'r'")
        self.assertTrue(all(not p["runtime"] and not p["reader_write"] for p in privileges), privileges)
        self.assertEqual(sorted(p["table"] for p in privileges if p["reader"]), sorted(schema["reader_tables"]))
        # Direct DML by the runtime is refused by privilege; the owner path is refused by the append-only guard.
        _, _, state = self.psql("INSERT INTO emr_clinical.attempt VALUES ('x', 'Y', NULL, NULL, NULL, NULL, now());", user="kin_runtime")
        self.assertEqual(state, REFUSED)
        for table in sorted(schema["tables"]):
            _, _, state = self.psql("TRUNCATE emr_clinical.%s CASCADE;" % table)
            self.assertEqual(state, REFUSED, table)
        self.assertEqual(self.json("SELECT json_agg(DISTINCT tablespace) FROM emr_clinical.storage_placement()"), [schema["tablespace"]])
        code, out, state = self.psql("SELECT count(*) FROM emr_clinical.open_requests(10);", user="kin_runtime")
        self.assertEqual((code, out, state), (0, "0", None), "the runtime reaches its functions only")
        history = self.json('SELECT json_agg(migration_name ORDER BY migration_name COLLATE "C") FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
        self.assertEqual(len(history), DECLARATION["migrations"]["count"])
        self.assertEqual(history[-1], DECLARATION["migrations"]["added"][-1])

    def test_d01_clinical_vs_operational(self):
        """TEST-D-01: a clinical entry is its own author's verified signed version; operational steps are unsigned versions."""
        uid = self.study()
        self.check_d01(self.driver("d01", {"study": uid}), uid)

    def test_d02_versions_and_sr(self):
        """TEST-D-02: every change appends an exact version; SR adoption is signed, kept and re-read; the clean-up ends only an unclaimed copy."""
        uid = self.study()
        item, _sop, _tags = self.measurement(uid)
        self.check_d02(self.driver("d02", {"study": uid, "recipientSub": PEOPLE["r2"], "itemId": item}), uid)
        self.check_sr(self.run_sr())

    def test_d03_read_scope(self):
        """TEST-D-03: bodies only to permitted readers of the managing institution, each after its own durable provision."""
        out, _uid = self.run_d03()
        self.check_d03(out)

    def test_d03b_provision_not_durable(self):
        """TEST-D-03: when the provision cannot be made durable (B1 refuses to seal it), no body is handed out."""
        out, _uid = self.run_d03()
        for step in ("question", "answer", "read:c1"):
            self.assertTrue(out[step]["ok"], (step, out[step]))
        qid = out["ids"]["question"]
        before = len(self.provisions(qid))
        down = self.driver("d03-ledger-down", {"question": qid})
        self.assertEqual((down["read"]["ok"], err(down["read"]).get("status"), err(down["read"]).get("code")), (False, 503, "CLINICAL_STORAGE_UNAVAILABLE"),
                         "no body when the provision is not durable")
        self.assertNotIn("value", down["read"])
        self.assertTrue(down["sealRefused"], "B1's failure journal records that the provision could not be sealed")
        self.assertEqual(len(self.provisions(qid)), before + 1, "the provision row was committed, yet without its seal no body left the server")

    def test_d04_atomic_retry(self):
        """TEST-D-04: one commit per request; replays answer the stored receipt; refused or diverged commits change nothing."""
        out, uid = self.run_d04()
        self.check_d04(out)
        qid = out["ids"]["question"]
        # A row moved outside the clinical path (a fixture change as the installer) diverges from the versions: the next
        # write rolls back whole and is sealed with the service's own code.
        # (revision and entryCount move together: the table's own CHECK keeps them equal)
        self.ok('UPDATE "StudyQuestion" SET revision = revision + 7, "entryCount" = "entryCount" + 7 WHERE id = %s::uuid;' % self.literal(qid))
        diverged = self.driver("d04-diverged", {"study": uid, "question": qid})
        self.assertEqual((diverged["reply"]["ok"], err(diverged["reply"]).get("code")), (False, "QUESTION_CHANGED"))
        self.assertEqual(len(self.versions(qid)), 1)
        self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestionEntry" WHERE "questionId" = %s::uuid' % self.literal(qid)), 1)
        [register] = self.register(diverged["requestId"])
        self.assertEqual((register["state"], register["terminal"]["proof"]["code"]), ("rejected", "QUESTION_CHANGED"))
        self.assertEqual(len(self.change_events(qid)), 2, "the rolled-back commit appended no change event")
        self.ok('UPDATE "StudyQuestion" SET revision = revision - 7, "entryCount" = "entryCount" - 7 WHERE id = %s::uuid;' % self.literal(qid))

    def test_d_flow_write_amend_reopen(self):
        """G3 flow: a finding is written, amended by a signed correction keeping the original, and reopened by a new process."""
        uid = self.study()
        item, _sop, _tags = self.measurement(uid)
        written = self.driver("flow-write", {"study": uid, "itemId": item})
        for step in ("create", "edit", "question", "answer"):
            self.assertTrue(written[step]["ok"], (step, written[step]))
        ids = written["ids"]
        reopened = self.driver("flow-reopen", {"study": uid, "finding": ids["finding"], "question": ids["question"]})
        f = reopened["finding"]
        self.assertEqual((f["revision"], f["entries"], f["acts"]), (2, ["clinical-entry", "clinical-entry"], ["entry", "correction"]))
        self.assertIn("6 mm", f["texts"][0], "the original text is kept after the correction")
        self.assertIn("7 mm", f["texts"][1])
        self.assertEqual(f["previous"], [None, f["versionIds"][0]])
        self.assertEqual([(s["versionId"], s.get("signedVersion"), s.get("integrity"), s.get("key")) for s in f["signatures"]],
                         [(v, v, "valid", "active") for v in f["versionIds"]], "each version's own signature verifies again after the restart")
        self.assertEqual([s["text"] for s in f["signatures"]], f["texts"])
        self.assertTrue(reopened["revisions"]["ok"], reopened["revisions"])
        self.assertEqual([r["revision"] for r in reopened["revisions"]["value"]["revisions"]], [1, 2])
        self.assertTrue(reopened["thread"]["ok"], reopened["thread"])
        self.assertEqual([e["body"] for e in reopened["thread"]["value"]["item"]["entries"]], [TEXT["question"], TEXT["answer"]])
        self.assertEqual(reopened["open"], 0, "nothing is left open for recovery")

    # ── the live mutants: each change of the compiled code shows its own symptom and makes its behaviour check fail ──

    def test_m_d_01_clinical_entry_as_assignment(self):
        uid = self.study()
        out = self.driver("d01", {"study": uid}, mutant="M-D-01")
        stored = [v["entry"] for v in self.versions(out["ids"]["question"])]
        self.assertNotEqual(stored, ["clinical-entry", "clinical-entry"], "the question and its answer are no longer stored as clinical entries")
        with self.assertRaises(AssertionError):
            self.check_d01(out, uid)

    def test_m_d_02_version_text_dropped(self):
        uid = self.study()
        item, _sop, _tags = self.measurement(uid)
        out = self.driver("d02", {"study": uid, "recipientSub": PEOPLE["r2"], "itemId": item}, mutant="M-D-02")
        first = self.versions(out["ids"]["consultation"])[:1]
        self.assertEqual([(v["entry"], v["body"]["text"]) for v in first], [("clinical-entry", None)], "the stored version lost its text")
        with self.assertRaises(AssertionError):
            self.check_d02(out, uid)

    def test_m_d_03_unbound_signature_succeeds(self):
        out, _uid = self.run_d04(mutant="M-D-03")
        self.assertTrue(out["tampered"]["ok"], "a signature over another text is accepted for the server's text")
        with self.assertRaises(AssertionError):
            self.check_d04(out)

    def test_m_d_04_adopted_sr_cleared(self):
        sr = self.run_sr(mutant="M-D-04")
        rows = sr["rows"]
        self.assertTrue(sr["out"]["store:" + rows["a"][0]]["ok"], "the signed store intents committed before the clean-up ran")
        ended = self.json("SELECT json_agg(record_id) FROM emr_clinical.sr_purpose_end WHERE record_id IN (%s)"
                          % ",".join(self.literal(r[0]) for r in rows.values())) or []
        # The mutated planner hands the adopted, store-attempted copy D over; the schema refuses that purpose end (ED006),
        # so this clean-up transaction ends nothing at all - not even the unclaimed copy B.
        self.assertEqual(ended, [], "the clean-up that included an adopted copy committed nothing")
        with self.assertRaises(AssertionError):
            self.check_sr(sr)

    def test_m_d_05_institution_boundary_skipped(self):
        baseline, _uid = self.run_d03()
        self.check_d03(baseline)
        out, _uid = self.run_d03(mutant="M-D-05")
        self.assertTrue(out["planForeign"]["ok"], out["planForeign"])
        self.assertEqual((out["runtimeForeign"]["ok"], err(out["runtimeForeign"]).get("code")), (False, "NotFound"),
                         "the response boundary still withholds the foreign body when the planner is mutated")
        with self.assertRaises(AssertionError):
            self.check_d03(out)

    # ── round 3: Astra's findings on bfddc3d (DR2-01..05), each as the behaviour its acceptance names ──

    def no_text(self, answer, label, extra=()):
        """No clinical text of this suite anywhere in a driver answer (an error body included)."""
        dumped = json.dumps(answer, ensure_ascii=False)
        for text in (*TEXT.values(), *extra):
            self.assertNotIn(json.dumps(text, ensure_ascii=False)[1:-1], dumped, label)

    def sr_facts(self, ids):
        rows = self.json("SELECT json_object_agg(m.id::text, json_build_array(m.\"attemptedAt\" IS NOT NULL, m.\"storedAt\" IS NOT NULL, "
                         "(SELECT s.confirmed FROM emr_clinical.sr_adoption s WHERE s.record_id = m.id::text), "
                         "(SELECT count(*) FROM emr_clinical.sr_adoption s WHERE s.record_id = m.id::text))) FROM \"ManualSr\" m WHERE m.id IN (%s)"
                         % ",".join(self.literal(i) + "::uuid" for i in ids))
        return {key: tuple(value) for key, value in rows.items()}

    def test_dr2_01_sr_published_only_when_durable(self):
        """DR2-01: an SR whose signed adoption is not durable in the ledger is never uploaded or answered as stored - first store,
        resend, two concurrent stores (one finds it adopted) and an adoption that cannot be read; once durable, published once."""
        uid = self.study()
        self.driver("d03", {"study": uid})  # B1's seal holds committed entries before its tail is made unwritable
        item, sop, tags = self.measurement(uid)
        a, sop_a, _data_a = self.prepared_sr(uid, item)
        b, sop_b, _data_b = self.prepared_sr(uid, item)
        base = {"study": uid, "tags": {sop: tags}}
        # Two concurrent stores of SR b, in a process whose seal has not failed yet: one adopts (its event cannot be sealed),
        # the other finds it adopted (ED006); B1 refuses new appends after a seal failure, so each part runs in its own process.
        concurrent = self.driver("dr2-01-sr", {**base, "seal": "down", "steps": [{"kind": "concurrent", "id": b, "name": "stores"}]})
        down = self.driver("dr2-01-sr", {**base, "seal": "down", "steps": [{"kind": "signed", "id": a, "name": "first"},
                                                                          {"kind": "resend", "id": a, "name": "resend"}]})
        for run in (concurrent, down):
            self.assertTrue(run["sealRefused"], "the fault reached B1's sealing")
            self.assertEqual(run["uploads"], [], "nothing was handed to Orthanc")
        for name, answer in (("concurrent-1", concurrent["stores"][0]), ("concurrent-2", concurrent["stores"][1]), ("first", down["first"]),
                             ("resend", down["resend"])):
            self.assertEqual((answer["ok"], err(answer).get("status"), err(answer).get("code")), (False, 503, "CLINICAL_OUTCOME_PENDING"), name)
        self.assertEqual(self.sr_facts([a, b]), {a: (True, False, False, 1), b: (True, False, False, 1)},
                         "committed intents with unconfirmed adoptions, one each (the concurrent store adopted nothing); nothing stored")
        self.ok("REVOKE EXECUTE ON FUNCTION emr_clinical.sr_adoption_for(text) FROM kin_runtime;")
        try:
            lookup = self.driver("dr2-01-sr", {**base, "steps": [{"kind": "resend", "id": a, "name": "unreadable"}]})
        finally:
            self.ok("GRANT EXECUTE ON FUNCTION emr_clinical.sr_adoption_for(text) TO kin_runtime;")
        self.assertEqual((lookup["unreadable"]["ok"], err(lookup["unreadable"]).get("status")), (False, 503), "an adoption that cannot be read is no adoption")
        self.assertEqual(lookup["uploads"], [])
        self.assertEqual(self.sr_facts([a]), {a: (True, False, False, 1)})
        up = self.driver("dr2-01-sr", {**base, "steps": [{"kind": "resend", "id": a, "name": "retry"}, {"kind": "resend", "id": a, "name": "again"},
                                                        {"kind": "resend", "id": b, "name": "retryB"}]})
        for name, sop_uid in (("retry", sop_a), ("again", sop_a), ("retryB", sop_b)):
            self.assertTrue(up[name]["ok"], (name, up[name]))
            self.assertEqual((up[name]["value"]["stored"], up[name]["value"]["dataset"]["SOPInstanceUID"]), (True, sop_uid), name)
        self.assertEqual(up["uploads"], [sop_a, sop_b], "each SR handed to Orthanc exactly once, after its adoption was confirmed")
        self.assertEqual(self.sr_facts([a, b]), {a: (True, True, True, 1), b: (True, True, True, 1)})
        events = self.json("SELECT json_agg(e.event_id ORDER BY e.event_id) FROM emr_access.access_entry e WHERE e.stream = 'viewing' "
                           "AND e.event_id IN (%s)" % ",".join(self.literal("clinical-sr:" + i) for i in (a, b)))
        self.assertEqual(events, sorted("clinical-sr:" + i for i in (a, b)), "the original adoption event was sealed, never a second one")

    def test_dr2_02_signed_text_served(self):
        """DR2-02: reads and lists serve the signed versions' text; a projection whose text, recipient or author differs from its
        versions is refused without text, and serves the original again once the projection is back."""
        uid = self.study()
        written = self.driver("dr2-02", {"study": uid, "recipientSub": PEOPLE["r2"]})
        for step in ("question", "answer", "consult", "consultAccept", "consultComplete", "imageRequest", "decline"):
            self.assertTrue(written[step]["ok"], (step, written[step]))
        ids, args = written["ids"], {"study": uid, "ids": written["ids"]}
        control = self.driver("dr2-02-read", args)
        for name in control:
            self.assertTrue(control[name]["ok"], (name, control[name]))
        self.assertEqual([e["body"] for e in control["question"]["value"]["item"]["entries"]], [TEXT["question"], TEXT["answer"]])
        self.assertEqual((control["consultation"]["value"]["item"]["reason"], control["consultation"]["value"]["item"]["reply"]), (TEXT["consult"], TEXT["reply"]))
        self.assertEqual((control["imageRequest"]["value"]["item"]["reason"], control["imageRequest"]["value"]["item"]["note"]), (TEXT["request"], TEXT["close"]))
        before = self.json("SELECT json_build_array((SELECT body FROM \"StudyQuestionEntry\" WHERE \"questionId\" = %s::uuid AND seq = 1), "
                           "(SELECT \"recipientSub\" FROM \"StudyConsultation\" WHERE id = %s::uuid), (SELECT \"requesterSub\" FROM \"StudyImageRequest\" WHERE id = %s::uuid))"
                           % (self.literal(ids["question"]), self.literal(ids["consultation"]), self.literal(ids["imageRequest"])))
        forged = "SYN unsigned projection replacement"

        def project(body, recipient, requester):
            self.ok('UPDATE "StudyQuestionEntry" SET body = %s WHERE "questionId" = %s::uuid AND seq = 1; '
                    'UPDATE "StudyConsultation" SET "recipientSub" = %s WHERE id = %s::uuid; UPDATE "StudyImageRequest" SET "requesterSub" = %s WHERE id = %s::uuid;'
                    % (self.literal(body), self.literal(ids["question"]), self.literal(recipient), self.literal(ids["consultation"]),
                       self.literal(requester), self.literal(ids["imageRequest"])))
        # The projections change outside the clinical path (as the installer): the question's text, the consultation's recipient
        # (its reference) and the image request's author.
        project(forged, PEOPLE["c2"], PEOPLE["c2"])
        try:
            tampered = self.driver("dr2-02-read", args)
        finally:
            project(*before)
        for name, code in (("question", "QUESTION_CHANGED"), ("consultation", None), ("consultations", None), ("imageRequest", "IMAGE_REQUEST_CHANGED"),
                           ("studyRequests", "IMAGE_REQUEST_CHANGED")):
            self.assertEqual((tampered[name]["ok"], err(tampered[name]).get("status")), (False, 409), name)
            if code:
                self.assertEqual(err(tampered[name]).get("code"), code, name)
            self.no_text(tampered[name], name, (forged,))
        self.assertEqual(self.driver("dr2-02-read", args), control, "the original projection serves the signed text again")

    def test_dr2_03_text_needs_durable_provision(self):
        """DR2-03: every response carrying clinical text - consultation list, read and write answer, image-request list, study list
        and read, finding list, revisions and write answer - serves none while B1 cannot make its provision durable, and serves
        the signed text once it can; refusals (409) carry none."""
        uid = self.study()
        item, _sop, _tags = self.measurement(uid)
        written = self.driver("dr2-03", {"study": uid, "recipientSub": PEOPLE["r2"], "itemId": item})
        for step in ("consult", "consultAccept", "consultComplete", "imageRequest", "close", "finding"):
            self.assertTrue(written[step]["ok"], (step, written[step]))
        ids, finding_text = written["ids"], "SYN 우상엽 8 mm 결절"
        args = {"study": uid, "ids": ids, "replays": written["replays"]}
        served = ("consultations", "consultation", "consultationAnswer", "imageRequests", "studyRequests", "imageRequest", "findings", "revisions", "findingAnswer")
        down = self.driver("dr2-03-serve", {**args, "down": True})
        self.assertTrue(down["sealRefused"], "the fault reached B1's sealing")
        for name in served:
            self.assertEqual((down[name]["ok"], err(down[name]).get("status")), (False, 503), name)
            self.no_text(down[name], name, (finding_text,))
        for name in ("consultationAnswer", "findingAnswer"):
            self.assertEqual(err(down[name]).get("code"), "CLINICAL_OUTCOME_PENDING", "the committed write's answer stays pending: " + name)
        up = self.driver("dr2-03-serve", {**args, "down": False})
        for name in served:
            self.assertTrue(up[name]["ok"], (name, up[name]))
        mine = lambda items, key: next(i for i in items if i["id"] == ids[key])
        for consultation in (mine(up["consultations"]["value"]["items"], "consultation"), up["consultation"]["value"]["item"],
                             up["consultationAnswer"]["value"]["item"]):
            self.assertEqual((consultation["reason"], consultation["reply"]), (TEXT["consult"], TEXT["reply"]))
        for request in (mine(up["imageRequests"]["value"]["items"], "imageRequest"), mine(up["studyRequests"]["value"]["items"], "imageRequest"),
                        up["imageRequest"]["value"]["item"]):
            self.assertEqual((request["reason"], request["note"]), (TEXT["request"], TEXT["close"]))
        for snapshot in (mine(up["findings"]["value"]["items"], "finding")["item"], up["revisions"]["value"]["revisions"][0]["item"],
                         up["findingAnswer"]["value"]["item"]):
            self.assertEqual(snapshot["text"], finding_text)
        for name in ("stale", "reused"):
            self.assertEqual((up[name]["ok"], err(up[name]).get("status")), (False, 409), name)
            self.no_text(up[name], name, (finding_text,))
        routes = {e["surface"] for e in self.provisions(ids["consultation"])}
        self.assertTrue({"GET consultations", "GET consultations/:id", "POST consultations/:id"} <= routes, routes)
        routes = {e["surface"] for e in self.provisions(ids["finding"])}
        self.assertTrue({"GET studies/:uid/findings", "GET studies/:uid/findings/:id/revisions", "POST studies/:uid/findings"} <= routes, routes)

    def test_dr2_04_assignment_same_request(self):
        """DR2-04: an allocation resent, or sent twice at once, gives the same result and one version; only another meaning under
        a used request ID is refused; a row written before unit D keeps its own revision as the request's."""
        uid, legacy = self.study(), self.study()
        self.ok('INSERT INTO "ReaderAssignment" ("studyUid", "institutionId", revision, "changedBy", "lastRequest", "lastFingerprint", "updatedAt") '
                "VALUES (%s, 'inst-a', 3, 'legacy@synthetic.test', %s::uuid, 'legacy', now());" % (self.literal(legacy), self.literal(uuid.uuid4())))
        out = self.driver("dr2-04", {"study": uid, "legacyStudy": legacy})
        self.assertTrue(out["first"]["ok"], out["first"])
        self.assertEqual(out["resend"], out["first"], "the resend answers the same result")
        self.assertTrue(all(a["ok"] for a in out["parallel"]), out["parallel"])
        self.assertEqual(out["parallel"][0], out["parallel"][1], "two identical requests at once answer the same result")
        self.assertEqual(out["parallel"][0]["value"]["revision"], 2)
        self.assertEqual((out["reused"]["ok"], err(out["reused"]).get("status")), (False, 409), "another reader under a used request ID")
        self.assertTrue(out["legacy"]["ok"], out["legacy"])
        self.assertEqual(out["legacyResend"], out["legacy"])
        self.assertEqual(out["legacy"]["value"]["revision"], 4, "the row's own revision 3 was the request's")
        unit = lambda study: "assignment:" + sha(json.dumps([study, "inst-a"], separators=(",", ":")).encode())
        self.assertEqual([v["entry"] for v in self.versions(unit(uid))], ["assignment", "assignment"], "one version per request")
        self.assertEqual([v["entry"] for v in self.versions(unit(legacy))], ["assignment"])
        self.assertEqual(self.json('SELECT count(*) FROM "AuditLog" WHERE action = \'reader.assignment\' AND target = %s' % self.literal(uid)), 2)

    def test_dr2_05_incorporated_sources_fixed(self):
        """DR2-05: the measurements a finding copies are fixed references to their exact versions in every version, the signed
        payload and the reference index H reads; a later revision of the measurement does not move them; the comparison study
        linked for navigation is no reference."""
        uid, comparison = self.study(), self.study()
        item, _sop, _tags = self.measurement(uid)
        other, _sop2, _tags2 = self.measurement(comparison)
        written = self.driver("dr2-05", {"study": uid, "comparison": comparison, "item": item, "comparisonItem": other})
        self.assertTrue(written["create"]["ok"], written["create"])
        fid = written["finding"]
        snapshot = self.json('SELECT snapshot FROM "ViewerItem" WHERE id = %s::uuid' % self.literal(item))
        moved = {**snapshot, "label": "SYN length re-measured"}
        self.ok('UPDATE "ViewerItem" SET revision = 2, snapshot = %s::jsonb, "updatedAt" = now() WHERE id = %s::uuid;'
                % (self.literal(json.dumps(moved)), self.literal(item)))
        self.revision(item, 2, moved, "r1", "edit")
        edited = self.driver("dr2-05-edit", {"study": uid, "comparison": comparison, "finding": fid, "item": written["item"]})
        self.assertTrue(edited["edit"]["ok"], edited["edit"])
        expected = [["measurement", item, "revision:1", self.source_digest(item, 1)], ["measurement", other, "revision:1", self.source_digest(other, 1)]]
        self.assertNotEqual(self.source_digest(item, 2), expected[0][3], "control: the moved revision has other content")
        versions = self.versions(fid)
        self.assertEqual(len(versions), 2)
        for v in versions:
            self.assertEqual([[a["kind"], a["recordId"], a["versionId"], a["sha256"]] for a in v["body"]["attachments"]], expected)
            self.assertEqual(v["body"]["navigation"], [comparison], "the comparison study is linked for navigation")
            payload = v["signature"]["envelope"]["jws"]["payload"]
            signed = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            self.assertEqual([[a["kind"], a["recordId"], a["versionId"], a["sha256"]] for a in signed["attachments"]], expected, "signed by the author")
        stored = self.json("SELECT json_agg(json_build_array(sequence, kind, ref_record_id, ref_version_id, ref_sha256) ORDER BY sequence, position) "
                           "FROM emr_clinical.attachment WHERE record_id = %s" % self.literal(fid))
        self.assertEqual(stored, [[sequence] + e for sequence in (1, 2) for e in expected])
        code, out, state = self.psql("SELECT json_agg(json_build_array(record_id, kind) ORDER BY version_id) FROM emr_clinical.references_to(%s);"
                                     % self.literal(item), user="kin_emr_reader")
        self.assertEqual((code, state), (0, None))
        self.assertEqual(json.loads(out), [[fid, "measurement"], [fid, "measurement"]], "H's retention lookup finds both versions citing it")
        code, out, state = self.psql("SELECT count(*) FROM emr_clinical.references_to(%s);" % self.literal(comparison), user="kin_emr_reader")
        self.assertEqual((code, out, state), (0, "0", None), "navigation alone is no reference")

    # ── round 4: Astra's findings on a980357 (DR3-01..04), each as the behaviour its acceptance names ──

    CHECKPOINT = "emr_clinical.checkpoint(text,text,text,uuid,integer,text,text,text)"

    def assignment_unit(self, study):
        return "assignment:" + sha(json.dumps([study, "inst-a"], separators=(",", ":")).encode())

    def test_dr3_01_assignment_answer_of_its_request(self):
        """DR3-01: an allocation request answers its own committed result - after a later allocation, beside a parallel
        duplicate, after its reader's account was disabled - and nothing where its study is not visible today."""
        uid = self.study()
        out = self.driver("dr3-01", {"study": uid})
        for name in ("first", "later", "replay"):
            self.assertTrue(out[name]["ok"], (name, out[name]))
        first, later = out["first"]["value"], out["later"]["value"]
        self.assertEqual((first["revision"], first["reader"]["sub"], later["revision"], later["reader"]["sub"]), (1, PEOPLE["r1"], 2, PEOPLE["r2"]))
        self.assertEqual([h["detail"]["revision"] for h in first["history"]], [1], "the history up to its own revision")
        self.assertEqual([h["detail"]["revision"] for h in later["history"]], [2, 1])
        self.assertEqual(out["replay"], out["first"], "DR3-01: the earlier request answers its own result after a later allocation")
        self.assertEqual(out["replayLookups"], [], "a registered request asks the identity provider nothing")
        self.assertTrue(all(a["ok"] for a in out["parallel"]), out["parallel"])
        self.assertEqual(out["parallel"][0], out["parallel"][1], "two identical requests at once answer the same result")
        self.assertEqual(out["parallel"][0]["value"]["revision"], 3)
        self.assertEqual((out["reused"]["ok"], err(out["reused"]).get("status")), (False, 409), "another reader under a used request ID")
        for step in ("consult", "consultAccept", "consultComplete", "consultAcceptAgain"):
            self.assertTrue(out[step]["ok"], (step, out[step]))
        self.assertEqual(out["consultAcceptAgain"], out["consultAccept"], "the same for a consultation: the acceptance resent answers the acceptance")
        accepted = out["consultAccept"]["value"]["item"]
        self.assertEqual((accepted["state"], accepted["revision"], accepted["reply"], accepted["changedBy"]), ("Accepted", 2, None, "r2@synthetic.test"))
        self.assertEqual(out["consultComplete"]["value"]["item"]["reply"], TEXT["reply"])
        fresh = {"requestId": str(uuid.uuid4()), "expectedOwner": ["inst-a", PEOPLE["t1"]], "revision": 3, "readerSub": PEOPLE["r1"]}
        after = self.driver("dr3-01-after", {"study": uid, "a": out["bodies"]["a"], "fresh": fresh, "disabled": ["r1"]})
        self.assertEqual(after["replay"], out["first"], "DR3-01: its reader's account is disabled now - still the original result")
        self.assertEqual(after["replayLookups"], [], "the disabled account was never looked up for the registered request")
        self.assertEqual((after["fresh"]["ok"], err(after["fresh"]).get("status")), (False, 400), "a new request needs a reader assignable today")
        self.ok('UPDATE "StudyState" SET "institutionId" = \'inst-z\' WHERE uid = %s;' % self.literal(uid))
        try:
            moved = self.driver("dr3-01-after", {"study": uid, "a": out["bodies"]["a"]})
        finally:
            self.ok('UPDATE "StudyState" SET "institutionId" = \'inst-a\' WHERE uid = %s;' % self.literal(uid))
        self.assertEqual((moved["replay"]["ok"], err(moved["replay"]).get("status")), (False, 404), "a study not visible today answers nothing")
        self.assertEqual([v["entry"] for v in self.versions(self.assignment_unit(uid))], ["assignment"] * 3, "one version per committed request")
        self.assertEqual(self.json('SELECT count(*) FROM "AuditLog" WHERE action = \'reader.assignment\' AND target = %s' % self.literal(uid)), 3)
        self.assertEqual(self.json('SELECT revision FROM "ReaderAssignment" WHERE "studyUid" = %s' % self.literal(uid)), 3)

    def test_dr3_02_legacy_finding_without_text(self):
        """DR3-02: a finding written before unit D (no signed version) answers its revisions as operational summaries - none
        of its typed reasons, ledger up or down; a signed finding's reasons leave only through their durable provision, and a
        diverged revision is refused without any reason."""
        uid = self.study()
        item, _sop, _tags = self.measurement(uid)
        reasons = {"hide": "SYN 숨김 사유: 다른 환자 검사로 보임", "restore": "SYN 복원 사유: 같은 환자로 확인"}
        written = self.driver("dr3-02", {"study": uid, "itemId": item, "reasons": reasons})
        for step in ("create", "hide", "restore"):
            self.assertTrue(written[step]["ok"], (step, written[step]))
        signed = written["finding"]
        snapshot = self.json('SELECT snapshot FROM "Finding" WHERE id = %s::uuid' % self.literal(signed))
        legacy, legacy_reasons = str(uuid.uuid4()), ("SYN LEGACY 숨김 사유", "SYN LEGACY 복원 사유")
        self.ok('INSERT INTO "Finding" (id, "studyUid", "authorSub", "authorActor", revision, hidden, snapshot, "updatedAt") '
                "VALUES (%s::uuid, %s, %s, 'r1@synthetic.test', 4, false, %s::jsonb, now());"
                % (self.literal(legacy), self.literal(uid), self.literal(PEOPLE["r1"]), self.literal(json.dumps(snapshot))))
        for revision, action, reason, hidden in ((1, "create", "", False), (2, "edit", "", False), (3, "hide", legacy_reasons[0], True),
                                                 (4, "restore", legacy_reasons[1], False)):
            self.ok('INSERT INTO "FindingRevision" ("findingId", revision, action, reason, "authorSub", actor, "requestId", fingerprint, snapshot, "payloadBytes") '
                    "SELECT %s::uuid, %d, %s, %s, %s, 'r1@synthetic.test', %s::uuid, %s, s, octet_length(convert_to(s::text, 'UTF8')) FROM (SELECT %s::jsonb AS s) x;"
                    % (self.literal(legacy), revision, self.literal(action), self.literal(reason), self.literal(PEOPLE["r1"]), self.literal(uuid.uuid4()),
                       self.literal("ab" * 32), self.literal(json.dumps({**snapshot, "hidden": hidden}))))
        args = {"study": uid, "legacy": legacy, "signed": signed}
        down = self.driver("dr3-02-serve", {**args, "down": True})
        up = self.driver("dr3-02-serve", {**args, "down": False})
        self.assertTrue(down["sealRefused"], "the fault reached B1's sealing")
        for name, served in (("down", down), ("up", up)):
            self.assertTrue(served["legacy"]["ok"], (name, served["legacy"]))
            self.assertEqual([(r["revision"], r["action"], r["reason"], r["item"]) for r in served["legacy"]["value"]["revisions"]],
                             [(1, "create", None, None), (2, "edit", None, None), (3, "hide", None, None), (4, "restore", None, None)],
                             "DR3-02: the summary of a revision written before unit D, ledger " + name)
            self.no_text(served["legacy"], "legacy revisions " + name, legacy_reasons + tuple(reasons.values()) + ("SYN 우상엽",))
            self.no_text(served["list"], "finding list " + name, legacy_reasons)
        self.assertEqual(self.provisions(legacy), [], "nothing of the finding written before unit D was provided")
        self.assertEqual((down["signed"]["ok"], err(down["signed"]).get("status")), (False, 503))
        self.no_text(down["signed"], "signed revisions down", tuple(reasons.values()) + ("SYN 우상엽",))
        self.assertTrue(up["signed"]["ok"], up["signed"])
        self.assertEqual([r["reason"] for r in up["signed"]["value"]["revisions"]], ["", reasons["hide"], reasons["restore"]], "the signed versions' own reasons")
        self.assertIn("GET studies/:uid/findings/:id/revisions", {e["surface"] for e in self.provisions(signed)})
        self.ok('UPDATE "FindingRevision" SET reason = \'SYN 다른 사유\' WHERE "findingId" = %s::uuid AND revision = 2;' % self.literal(signed))
        try:
            diverged = self.driver("dr3-02-serve", {**args, "down": False})
        finally:
            self.ok('UPDATE "FindingRevision" SET reason = %s WHERE "findingId" = %s::uuid AND revision = 2;' % (self.literal(reasons["hide"]), self.literal(signed)))
        self.assertEqual((diverged["signed"]["ok"], err(diverged["signed"]).get("status")), (False, 409))
        self.no_text(diverged["signed"], "diverged revisions", tuple(reasons.values()) + ("SYN 다른 사유",))

    def saved_comparison(self, uid):
        """A stored saved comparison of `uid` (its head and revision 1) whose version 6 snapshot holds two 3D marks on one
        volume, and the image server's tags of that volume's first original."""
        job, marks = str(uuid.uuid4()), [str(uuid.uuid4()), str(uuid.uuid4())]
        series, sop, frame = uid + ".5", uid + ".5.1", uid + ".59"
        snapshot = {"version": 6, "volume": {"study": uid, "series": series, "sops": [sop], "sourceDigest": "cd" * 32},
                    "marks": {"marks": [{"id": m, "label": "SYN mark %d" % i, "point": [i, 2, 3]} for i, m in enumerate(marks)]}}
        self.ok('INSERT INTO "ViewerJob" (id, "studyUid", "authorSub", "authorActor", studies, fingerprint, snapshot, title, description, hidden, revision, "updatedAt") '
                "VALUES (%s::uuid, %s, %s, 'r1@synthetic.test', ARRAY[%s], %s, %s::jsonb, 'SYN saved comparison', '', false, 1, now());"
                % (self.literal(job), self.literal(uid), self.literal(PEOPLE["r1"]), self.literal(uid), self.literal("ef" * 32), self.literal(json.dumps(snapshot))))
        self.ok('INSERT INTO "ViewerJobRevision" ("jobId", revision, title, description, hidden, reason, actor) '
                "VALUES (%s::uuid, 1, 'SYN saved comparison', '', false, '', 'r1@synthetic.test');" % self.literal(job))
        tags = {sop: {"StudyInstanceUID": uid, "SeriesInstanceUID": series, "SOPInstanceUID": sop, "FrameOfReferenceUID": frame}}
        return job, marks, tags

    def test_dr3_03_marks_of_one_job_one_reference(self):
        """DR3-03: a finding citing two marks of one saved comparison, and one citing its saved view and a mark on it, each keep
        every copy in the text and cite that comparison revision once - planned, signed, stored, recovered and found by H."""
        uid = self.study()
        job, marks, tags = self.saved_comparison(uid)
        args = {"study": uid, "job": job, "marks": marks, "tags": tags}
        written = self.driver("dr3-03", args)
        for name in ("A", "B"):
            self.assertTrue(written[name]["ok"], ("DR3-03: refused as a duplicate reference", name, written[name]))
        stored = self.json('SELECT json_build_object(\'studyUid\', "studyUid", \'studies\', to_json(studies), \'snapshot\', snapshot, \'title\', title, '
                           '\'description\', description, \'hidden\', hidden) FROM "ViewerJob" WHERE id = %s::uuid' % self.literal(job))
        digest = sha(json.dumps(stored, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        expected = [["comparison-layout", job, "revision:1", digest]]
        self.ok("REVOKE EXECUTE ON FUNCTION %s FROM kin_runtime;" % self.CHECKPOINT)
        try:
            pending = self.driver("dr3-03", {**args, "only": "C"})
        finally:
            self.ok("GRANT EXECUTE ON FUNCTION %s TO kin_runtime;" % self.CHECKPOINT)
        self.assertEqual((pending["C"]["ok"], err(pending["C"]).get("code")), (False, "CLINICAL_OUTCOME_PENDING"), pending["C"])
        self.assertEqual([r["state"] for r in self.register(pending["ids"]["C"])], ["pending"])
        recovered = self.driver("recover-open", {"resend": {"study": uid, "body": pending["bodies"]["C"]}})
        self.assertTrue(recovered["resend"]["ok"], ("the recovered original answers its resend", recovered["resend"]))
        texts = {"A": [marks[0], marks[1]], "B": [None, marks[0]], "C": [marks[1], marks[0]]}
        ids = {**written["ids"], "C": pending["ids"]["C"]}
        for name, fid in ids.items():
            [v] = self.versions(fid)
            self.assertEqual([[a["kind"], a["recordId"], a["versionId"], a["sha256"]] for a in v["body"]["attachments"]], expected,
                             "DR3-03: %s cites the comparison revision once" % name)
            payload = v["signature"]["envelope"]["jws"]["payload"]
            signed = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            self.assertEqual([[a["kind"], a["recordId"], a["versionId"], a["sha256"]] for a in signed["attachments"]], expected, name + ": signed by its author")
            self.assertEqual([(s.get("mark") or {}).get("id") for s in json.loads(v["body"]["text"])["sources"]], texts[name], name + ": every copy kept")
            self.assertEqual(self.json("SELECT count(*) FROM emr_clinical.attachment WHERE record_id = %s" % self.literal(fid)), 1, name)
        code, out, state = self.psql("SELECT json_agg(record_id ORDER BY record_id) FROM emr_clinical.references_to(%s);" % self.literal(job), user="kin_emr_reader")
        self.assertEqual((code, state), (0, None))
        self.assertEqual(json.loads(out), sorted(ids.values()), "H's retention lookup finds each citing finding once")

    def test_dr3_04_recovery_keeps_stale_source(self):
        """DR3-04: a pending original whose cited measurement version is gone is sealed as that stale source, and its resend
        answers FINDING_SOURCE_STALE; while the source cannot be read, it stays pending; nothing is ever committed without it."""
        uid = self.study()
        item, _sop, _tags = self.measurement(uid)
        self.ok("REVOKE EXECUTE ON FUNCTION %s FROM kin_runtime;" % self.CHECKPOINT)
        try:
            written = self.driver("dr3-04-write", {"study": uid, "itemId": item})
        finally:
            self.ok("GRANT EXECUTE ON FUNCTION %s TO kin_runtime;" % self.CHECKPOINT)
        fid = written["finding"]
        self.assertEqual((written["create"]["ok"], err(written["create"]).get("code")), (False, "CLINICAL_OUTCOME_PENDING"), written["create"])
        self.assertEqual([r["state"] for r in self.register(fid)], ["pending"])
        self.ok('REVOKE SELECT ON "ViewerRevision" FROM kin_runtime;')
        try:
            unreadable = self.driver("recover-open", {})
        finally:
            self.ok('GRANT SELECT ON "ViewerRevision" TO kin_runtime;')
        self.assertGreaterEqual(unreadable["recovered"], 1)
        self.assertEqual([r["state"] for r in self.register(fid)], ["pending"], "DR3-04: a source that cannot be read now leaves the original pending")
        self.assertEqual(self.versions(fid), [])
        self.ok('DELETE FROM "ViewerRevision" WHERE "itemId" = %s::uuid AND revision = 1;' % self.literal(item))
        gone = self.driver("recover-open", {"resend": {"study": uid, "body": written["body"]}})
        [register] = self.register(fid)
        self.assertEqual((register["state"], register["terminal"]["proof"]["code"]), ("rejected", "ClinicalSourceMissing"),
                         "DR3-04: the recovery keeps the stale source as such")
        self.assertEqual((gone["resend"]["ok"], err(gone["resend"]).get("status"), err(gone["resend"]).get("code")), (False, 409, "FINDING_SOURCE_STALE"),
                         "DR3-04: the resend answers FINDING_SOURCE_STALE")
        self.no_text(gone["resend"], "stale resend", ("SYN 좌상엽",))
        self.assertEqual(self.versions(fid), [], "nothing committed: never a version without its reference")
        self.assertEqual(self.json('SELECT count(*) FROM "Finding" WHERE id = %s::uuid' % self.literal(fid)), 0)
        self.assertEqual(self.change_events(fid), [])

    def test_r5a_nc01_metadata_policy_and_recovery(self):
        """NC-01/R5-09: all five owned projectors admit a real metadata policy and recover with fresh metadata."""
        uid = self.study()
        item, _, _ = self.measurement(uid)
        out = self.driver("r5a-metadata", {"study": uid, "item": item})
        self.assertEqual(out["question"]["applied"]["revision"], 1)
        self.assertEqual(out["answer"]["applied"]["revision"], 2)
        self.assertEqual(out["imageChange"]["applied"]["revision"], 2)
        self.assertEqual(out["consultation"]["item"]["revision"], 1)
        self.assertEqual(out["finding"]["revision"], 1)
        self.assertEqual(out["assignment"]["revision"], 1)
        self.assertEqual(out["recovery"]["applied"]["revision"], 1)
        for record in out["ids"].values():
            self.assertTrue(self.versions(record))
            self.assertTrue(self.change_events(record))

    def test_r5a_nc02_maximum_history_sql(self):
        """NC-02/R5-16: actual SQL accepts every allowed entry, reserves close, and preserves history on overflow/replay."""
        for text in ("x" * 2000, "가" * 2000, "😀" * 1000):
            with self.subTest(utf8_bytes=len(text.encode())):
                out = self.driver("r5a-limits", {"study": self.study(), "text": text})
                self.assertFalse(out["over"]["ok"])
                self.assertEqual(err(out["over"]).get("code"), "QUESTION_ENTRY_LIMIT")
                self.assertEqual(out["closed"]["applied"], out["replay"]["applied"])
                versions = self.versions(out["id"])
                self.assertEqual(len(versions), 100)
                self.assertTrue(all(v["body"]["text"] == text for v in versions))
                maximum = self.json("SELECT max(octet_length(seed)) FROM emr_clinical.request WHERE record_id = %s" % self.literal(out["id"]))
                self.assertLessEqual(maximum, 524288)
                self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestionEntry" WHERE "questionId"=%s::uuid' % self.literal(out["id"])), 100)

    def test_r5a_nc04_business_ack(self):
        """NC-04: actual mutable receipt cannot add clinical fields or rewrite the original revision."""
        out = self.driver("r5a-acks", {"study": self.study()})
        self.assertNotIn("SYN forbidden", json.dumps(out["replay"]))
        self.assertFalse(out["corrupted"]["ok"])
        self.assertEqual(len(self.versions(out["id"])), 1)
        self.assertEqual([r["state"] for r in self.register(out["id"])], ["committed"])

    def test_r5a_nc05_original_refusal_seal_retry(self):
        """NC-05: SQL rollback/decision commits even when sealing is unreachable; clearing hold never changes its cause."""
        out = self.driver("r5a-seal-retry", {"study": self.study()})
        [record] = self.register(out["requestId"])
        print("R5A_SEAL_FACTS " + json.dumps({"out": out, "state": record["state"], "phase": record["phase"]}), flush=True)
        self.assertGreaterEqual(out["attempts"], 1)
        self.assertFalse(out["first"]["ok"])
        self.assertFalse(out["retry"]["ok"])
        self.assertEqual((record["state"], record["terminal"]["proof"]["code"]), ("rejected", "ASSIGNMENT_HELD"))
        decision = self.json("SELECT rejection_decision::json FROM emr_clinical.request WHERE request_id=%s" % self.literal(out["requestId"]))
        self.assertTrue(decision["noClinicalEffects"])
        self.assertEqual(decision["code"], "ASSIGNMENT_HELD")
        record_id = json.loads(record["seed"])["ids"]["recordId"]
        self.assertEqual(self.versions(record_id), [])
        self.assertEqual(self.change_events(record_id), [])

    def test_r5a_nc06_absent_admission_race(self):
        """NC-06: actual separate SQL transactions interleave absent lookup with another owner's complete registration."""
        out = self.driver("r5a-registry-race", {"study": self.study()})
        self.assertEqual(out["racing"], out["registered"])
        self.assertFalse(out["changed"]["ok"])
        [record] = self.register(out["requestId"])
        self.assertEqual(record["state"], "committed")
        self.assertEqual(len(self.versions(record["record_id"])), 1)

    # ── round 5 part (c): the receiving institution of an open tele channel keeps its own allocation row (D1190) ──

    def allocation_unit(self, study, institution):
        return "assignment:" + sha(json.dumps([study, institution], separators=(",", ":")).encode())

    def test_d1190_tele_assignment_receiver_row(self):
        """D1190 (I-TELE-ASSIGN, S7-U3a REQ-S7-U3a-TELE-ASSIGN): while the study's tele channel is open to inst-b, inst-b's
        radiologist writes inst-b's own allocation row - one operational version of inst-b's unit, acted by inst-b for the study
        inst-a manages, with its access event and audit row - beside the owner's row and unit, which stay the owner's; the same
        request sent again moves nothing; once the channel is closed the receiver is answered and writes nothing."""
        uid = self.study()
        self.ok('UPDATE "StudyState" SET "teleInstitutionId" = \'inst-b\' WHERE uid = %s;' % self.literal(uid))
        out = self.driver("d1190-tele", {"study": uid})
        for name in ("owner", "receiver", "resend"):
            self.assertTrue(out[name]["ok"], (name, out[name]))
        self.assertEqual(out["resend"], out["receiver"], "the same request answers its own committed result")
        receiver = out["receiver"]["value"]
        self.assertEqual((receiver["owner"], receiver["revision"], receiver["reader"]["sub"]), (["inst-b", PEOPLE["rb"]], 1, PEOPLE["rb"]))
        [b] = self.versions(self.allocation_unit(uid, "inst-b"))
        self.assertEqual((b["entry"], b["body"]["text"], b["signature"], b["body"]["actingInstitutionId"], b["body"]["managingInstitutionId"],
                          b["body"]["author"]["id"], b["body"]["readerId"]),
                         ("assignment", None, None, "inst-b", "inst-a", self.identity("rb"), self.identity("rb")))
        [a] = self.versions(self.allocation_unit(uid, "inst-a"))
        self.assertEqual((a["body"]["actingInstitutionId"], a["body"]["readerId"]), ("inst-a", self.identity("r1")))
        events = self.change_events(self.allocation_unit(uid, "inst-b"))
        self.assertTrue(events, "the receiver's write has its access event")
        self.assertEqual({(e["event"]["eventId"], e["event"]["actingInstitution"]["value"], e["event"]["managingInstitution"]["value"]) for e in events},
                         {(events[0]["event"]["eventId"], "inst-b", "inst-a")}, "one event, acted by the receiver for the managed study")
        rows = lambda: self.json('SELECT json_object_agg("institutionId", json_build_array(revision, "readerSub", "closedAt" IS NULL)) '
                                 'FROM "ReaderAssignment" WHERE "studyUid" = %s' % self.literal(uid))
        audits = lambda: self.json('SELECT json_agg(detail::json ->> \'institution\' ORDER BY id) FROM "AuditLog" '
                                   'WHERE action = \'reader.assignment\' AND target = %s' % self.literal(uid))
        self.assertEqual(rows(), {"inst-a": [1, PEOPLE["r1"], True], "inst-b": [1, PEOPLE["rb"], True]})
        self.assertEqual(audits(), ["inst-a", "inst-b"], "one audit row per write, recorded for the institution whose row it is")
        # The case clears the channel column itself: closing inst-b's legacy row with it is S7-U3a's close (PacsService,
        # tests/reader_assignment_scope_test.cjs); the claim here is that unit D and the service admit nothing afterwards.
        self.ok('UPDATE "StudyState" SET "teleInstitutionId" = NULL WHERE uid = %s;' % self.literal(uid))
        closed = self.driver("d1190-tele", {"study": uid, "receiver": out["bodies"]["receiver"]})
        for name in ("resend", "fresh"):
            self.assertEqual((closed[name]["ok"], err(closed[name]).get("status")), (False, 404), name + ": a closed channel answers nothing")
        self.assertEqual(len(self.versions(self.allocation_unit(uid, "inst-b"))), 1, "a closed channel writes no version")
        self.assertEqual(rows(), {"inst-a": [1, PEOPLE["r1"], True], "inst-b": [1, PEOPLE["rb"], True]})
        self.assertEqual(audits(), ["inst-a", "inst-b"])

if __name__ == "__main__":
    raise SystemExit("Run through scripts/run-tests.py --mode live")
