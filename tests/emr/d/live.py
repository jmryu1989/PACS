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

import hashlib
import importlib.util
import json
import os
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


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
            cls.image = json.loads(run(["docker", "image", "inspect", image]).stdout)[0]["Id"]
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
        """A stored manual length measurement on a CT image of `uid`, and the Orthanc tags that verify it."""
        item, series, sop, frame = str(uuid.uuid4()), uid + ".1", uid + ".1.1", uid + ".9"
        snapshot = {"kind": "length", "seriesUid": series, "sopUid": sop, "frame": 1, "frameOfReferenceUid": frame, "label": "SYN length",
                    "points": [[10, 10, 0], [20, 20, 0]], "viewPlaneNormal": [0, 0, 1], "viewUp": [0, -1, 0], "baseline": None,
                    "sourceDigest": "ab" * 32}
        self.ok('INSERT INTO "ViewerItem" (id, "studyUid", "authorSub", "authorActor", revision, snapshot, "updatedAt") VALUES (%s::uuid, %s, %s, %s, 1, %s::jsonb, now());'
                % (self.literal(item), self.literal(uid), self.literal(PEOPLE[author]), self.literal(author + "@synthetic.test"),
                   self.literal(json.dumps(snapshot))))
        tags = {"StudyInstanceUID": uid, "SeriesInstanceUID": series, "SOPInstanceUID": sop, "SOPClassUID": "1.2.840.10008.5.1.4.1.1.2",
                "FrameOfReferenceUID": frame, "Rows": 512, "Columns": 512, "ImagePositionPatient": "0\\0\\0", "ImageOrientationPatient": "1\\0\\0\\0\\1\\0",
                "PixelSpacing": "1\\1", "Modality": "CT", "PatientID": "SYN-PATIENT-1", "_kinSourceDigest": "ab" * 32}
        return item, sop, tags

    def prepared_sr(self, uid, item, author="r1"):
        """A prepared manual SR copy of `uid` (the bytes this server would have built), not yet attempted."""
        # A DICOM-shaped synthetic file (128-byte preamble, DICM, synthetic payload): the table keeps 132 B to 512 KiB.
        sr, sop = str(uuid.uuid4()), uid + ".77." + str(next(_studies))
        data = b"\0" * 128 + b"DICM" + ("SYNTHETIC-SR-" + uuid.uuid4().hex).encode()
        self.ok('INSERT INTO "ManualSr" (id, "studyUid", "authorSub", "authorActor", "requestId", fingerprint, selection, dataset, dicom, sha256) '
                "VALUES (%s::uuid, %s, %s, %s, %s::uuid, %s, %s::jsonb, %s::jsonb, decode(%s, 'hex'), %s);"
                % (self.literal(sr), self.literal(uid), self.literal(PEOPLE[author]), self.literal(author + "@synthetic.test"),
                   self.literal(uuid.uuid4()), self.literal("ab" * 32), self.literal(json.dumps([{"id": item, "revision": 1}])),
                   self.literal(json.dumps({"SOPInstanceUID": sop})), self.literal(data.hex()), self.literal(sha(data))))
        return sr, sop, data

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
        self.assertEqual((out["unsigned"]["ok"], out["unsigned"]["error"]["status"], out["unsigned"]["error"]["code"]),
                         (False, 403, "CLINICAL_SIGNATURE_REQUIRED"))
        for refused in ("unsigned", "proxy"):
            self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestion" WHERE id = %s::uuid' % self.literal(ids[refused])), 0, refused)
            self.assertEqual(self.versions(ids[refused]), [], refused)
        self.assertEqual(self.register(ids["unsigned"]), [])
        self.assertEqual((out["proxy"]["ok"], out["proxy"]["error"]["code"]), (False, "CLINICAL_SIGNATURE_REFUSED"))
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
        self.assertEqual((out["hideOutOfContext"]["ok"], out["hideOutOfContext"]["error"]["status"]), (False, 400))
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
        self.assertEqual((out["unsignedStore"]["ok"], out["unsignedStore"]["error"]["code"]), (False, "CLINICAL_SIGNATURE_REQUIRED"))
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
            self.assertEqual((out["read:" + name]["ok"], out["read:" + name]["error"]["status"]), (False, 404), name)
        self.assertEqual((out["runtimeForeign"]["ok"], out["runtimeForeign"]["error"]["code"]), (False, "NotFound"),
                         "another institution gets no body through the runtime either")
        self.assertEqual((out["runtimeForged"]["ok"], out["runtimeForged"]["error"]["code"]), (False, "NotFound"),
                         "rows that were not read from storage are never served")
        provided = self.provisions(qid)
        self.assertEqual(sorted(e["userId"]["value"]["subject"] for e in provided), sorted(PEOPLE[n] for n in ("c1", "r1", "ad")),
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
        self.assertEqual((out["reused"]["ok"], out["reused"]["error"]["code"]), (False, "REQUEST_ID_REUSED"))
        self.assertEqual(len(self.versions(ids["question"])), 1, "one commit per request")
        self.assertEqual(len(self.change_events(ids["question"])), 2, "one change event, in both streams")
        for key in ("tampered", "tamperedAgain"):
            self.assertEqual((out[key]["ok"], out[key]["error"]["code"]), (False, "CLINICAL_SIGNATURE_REFUSED"), key)
        self.assertEqual(self.json('SELECT count(*) FROM "StudyQuestion" WHERE id = %s::uuid' % self.literal(ids["tampered"])), 0)
        self.assertEqual(self.versions(ids["tampered"]), [])
        [tampered] = self.register(ids["tampered"])
        self.assertEqual((tampered["state"], tampered["terminal"]["proof"]["code"]), ("rejected", "SignatureFailed"))
        self.assertEqual(json.loads(tampered["seed"])["body"]["body"], TEXT["question"], "the author's input is preserved with the refused original")
        self.assertEqual((out["stale"]["ok"], out["stale"]["error"]["code"]), (False, "QUESTION_CHANGED"))
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
        self.assertEqual((down["read"]["ok"], down["read"]["error"]["status"], down["read"]["error"]["code"]), (False, 503, "CLINICAL_STORAGE_UNAVAILABLE"),
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
        self.assertEqual((diverged["reply"]["ok"], diverged["reply"]["error"]["code"]), (False, "QUESTION_CHANGED"))
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
        out, _uid = self.run_d03(mutant="M-D-05")
        # The service's own row check still hides the row from rb; the runtime boundary itself now hands out the body.
        self.assertTrue(out["runtimeForeign"]["ok"], "another institution's verified reader received a body through the runtime")
        with self.assertRaises(AssertionError):
            self.check_d03(out)

if __name__ == "__main__":
    raise SystemExit("Run through scripts/run-tests.py --mode live")
