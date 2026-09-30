"""TEST-S7-AUDIT-STORE-PURE (REQ-S7-AUDIT-STORE -> RISK-S7-AUDIT-TAMPER, RISK-S7-AUDIT-LOSS): the verdicts, exit codes,
checkpoint and ledger files, previous-checkpoint comparison, calendar retention and the ledger lifecycle of
scripts/ops_audit_integrity.py, without Docker.

Only the isolated verifier boundary (evaluate: the one place that starts the networkless verifier and returns the digest
stream of an export) is replaced by a synthetic stream; its real behaviour on PostgreSQL is tests/audit_store_db_test.py.
Backup roots, folders and the ledger are made with the public commands (init, plan), the public seal function and files;
times enter only through a snapshot manifest's created_utc and retention --as-of. Assertions are on exit codes, the
documented report and file contents (ids, digests, states), never on implementation text.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import random
import stat
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_audit_integrity as audit  # noqa: E402
import ops_backup as ops  # noqa: E402

IMAGE = "sha256:" + "a" * 64
SENTINEL = "SYNTHETIC-ROW-CONTENT actor=syn-sentinel detail=private-sentinel"
PRESENT = {"state": "present", "statements": {"insert": "accepted", "update": "refused", "delete": "refused",
                                              "truncate": "refused"}}
INEFFECTIVE = {"state": "ineffective", "statements": {"insert": "accepted", "update": "accepted", "delete": "accepted",
                                                      "truncate": "refused"}}


def utc(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def row_digest(content):
    return hashlib.sha256(str(content).encode()).hexdigest()


def stream(rows, guard=PRESENT, schema=(), table=True, order=None):
    """A synthetic verifier answer: rows {id: content} -> the (id, count, digest) stream."""
    items = [(key, 1, row_digest(value)) for key, value in rows.items()]
    if order is not None:
        random.Random(order).shuffle(items)
    return audit.Evaluation(table=table, rows=items, guard=dict(guard), schema=list(schema))


class Workspace:
    """A temporary repository stand-in (where the operations lock lives) beside a private backup root."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kin-audit-pure-")
        base = Path(self.temp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        self.root = base / "backups"
        self.root.mkdir(mode=0o700)

    def close(self):
        self.temp.cleanup()

    def cli(self, *args, evaluation=None):
        output = io.StringIO()
        boundary = patch.object(audit, "evaluate", return_value=evaluation) if evaluation is not None else \
            patch.object(audit, "evaluate", side_effect=AssertionError("the verifier boundary was not expected"))
        with patch.object(ops, "ROOT", self.repo), patch.object(ops, "require_local_docker"), boundary as fake, \
                contextlib.redirect_stdout(output):
            code = audit.main([str(arg) for arg in args])
        self.last_boundary = fake
        return code, json.loads(output.getvalue())

    def init(self, *extra):
        code, report = self.cli("init", self.root, *extra)
        assert code == 0, report
        return report

    def backup(self, created, dump=None):
        created = utc(created) if isinstance(created, str) else created
        folder = self.root / (created.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
        folder.mkdir(mode=0o700)
        data = (dump or (SENTINEL + " " + uuid.uuid4().hex)).encode()
        (folder / "kin.dump").write_bytes(data)
        manifest = {"format": 1, "complete": True, "created_utc": created.isoformat(), "postgres_image": IMAGE,
                    "ready": True, "resume_failures": [],
                    "sha256": {"kin.dump": hashlib.sha256(data).hexdigest()}, "bytes": {"kin.dump": len(data)}}
        ops.write_json(folder / "manifest.json", manifest)
        return folder

    def seal(self, folder, evaluation):
        manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        with patch.object(audit, "evaluate", return_value=evaluation) as fake:
            alarm = audit.seal(folder, self.root, manifest)
        self.last_boundary = fake
        return alarm

    def sealed(self, created, rows, **kw):
        folder = self.backup(created)
        self.seal(folder, stream(rows, **kw))
        return folder

    def checkpoint(self, folder):
        return json.loads((folder / audit.CHECKPOINT).read_text(encoding="utf-8"))

    def manifest(self, folder):
        return json.loads((folder / "manifest.json").read_text(encoding="utf-8"))

    def ledger(self):
        return json.loads((self.root / audit.LEDGER).read_text(encoding="utf-8"))

    def tree(self):
        return {path.relative_to(self.root).as_posix(): path.read_bytes() for path in sorted(self.root.rglob("*"))
                if path.is_file()}


def remove_folder(folder):
    for path in sorted(folder.rglob("*"), reverse=True):
        path.unlink() if path.is_file() else path.rmdir()
    folder.rmdir()


class AuditIntegrityPure(unittest.TestCase):
    def setUp(self):
        self.ws = Workspace()
        self.addCleanup(self.ws.close)

    # PV-01 (IV-01..06, IV-11, IV-12): the digest stream against the checkpoint.
    def test_pv01_stream_verdicts_per_kind_and_order_independence(self):
        self.ws.init()
        rows = {1: "a", 2: "b", 3: "c", 5: "e"}          # id 4 is a gap (a rolled-back insert)
        folder = self.ws.sealed("2026-09-30T01:00:00Z", rows)
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=stream(rows))
        self.assertEqual(code, 0, report)
        self.assertEqual([report[k]["count"] for k in ("changed", "deleted", "inserted")], [0, 0, 0])
        self.assertEqual(report["tail"], 0)
        target = self.ws.last_boundary.call_args.args[0]
        self.assertEqual((target.path, target.image), (folder / "kin.dump", IMAGE))

        mixed = {1: "a", 2: "B", 4: "inserted", 5: "e", 6: "later", 7: "later"}
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=stream(mixed))
        self.assertEqual(code, 1)
        self.assertEqual((report["changed"]["ids"], report["deleted"]["ids"], report["inserted"]["ids"], report["tail"]),
                         ([2], [3], [4], 2))

        swapped = {1: "b", 2: "a", 3: "c", 5: "e"}
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=stream(swapped))
        self.assertEqual((code, report["changed"]["ids"]), (1, [1, 2]))

        # behaviour-preserving variant: the same rows in another stream order give the same report
        for seed in (1, 2, 3):
            self.assertEqual(self.ws.cli("verify", "--backup", folder, evaluation=stream(mixed, order=seed))[1],
                             self.ws.cli("verify", "--backup", folder, evaluation=stream(mixed))[1])
        # the sequence moved back (rows unchanged) is not a row change: V judges rows only (IV-12)
        self.assertEqual(self.ws.cli("verify", "--backup", folder, evaluation=stream(rows, order=9))[0], 0)

        # a stream that repeats an id cannot come from the verifier: an input error, not a verdict
        repeated = stream(rows)
        repeated.rows.append((2, 1, row_digest("b")))
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=repeated)
        self.assertEqual((code, report["exit"]), (2, 2))

    # PV-02 (IV-10, IV-13): exit 0/1/2 and the bounded report.
    def test_pv02_input_errors_are_exit_2_and_integrity_failures_exit_1(self):
        self.ws.init()
        rows = {n: "row %d" % n for n in range(1, 151)}
        folder = self.ws.sealed("2026-09-30T01:00:00Z", rows)
        original = self.ws.checkpoint(folder)

        def with_checkpoint(body, raw=None):
            path = Path(self.ws.temp.name) / ("k-%s.json" % uuid.uuid4().hex[:6])
            path.write_bytes(raw if raw is not None else json.dumps(body).encode())
            return self.ws.cli("verify", "--backup", folder, "--checkpoint", path, evaluation=stream(rows))

        variants = {"unknown format": dict(original, format=99), "columns differ": dict(original, columns=["id", "at"]),
                    "rows out of order": dict(original, rows=list(reversed(original["rows"]))),
                    "repeated id": dict(original, rows=original["rows"][:1] + original["rows"]),
                    "endpoint differs": dict(original, through_id=original["through_id"] + 1)}
        for label, body in variants.items():
            with self.subTest(label):
                self.assertEqual(with_checkpoint(body)[0], 2)
        with self.subTest("not JSON"):
            self.assertEqual(with_checkpoint(None, raw=b"{not json")[0], 2)
        with self.subTest("the checkpoint as written verifies"):
            self.assertEqual(with_checkpoint(original)[0], 0)

        # the export differs from its manifest digest: exit 2 before any verifier starts
        dump = folder / "kin.dump"
        kept = dump.read_bytes()
        dump.write_bytes(kept + b"changed")
        code, report = self.ws.cli("verify", "--backup", folder)   # the boundary raises if it is reached
        self.assertEqual(code, 2, report)
        dump.write_bytes(kept)

        # every row deleted: an integrity failure (1) with the count and the 100 smallest ids
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=stream({}))
        self.assertEqual(code, 1)
        self.assertEqual(report["deleted"], {"count": 150, "ids": list(range(1, 101))})
        # the export's own guard and shape are part of the verdict and the report
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=stream(rows, guard=INEFFECTIVE))
        self.assertEqual((code, report["guard"]["state"]), (1, "ineffective"))
        code, report = self.ws.cli("verify", "--backup", folder, evaluation=stream(rows, schema=["shadow_relation"]))
        self.assertEqual((code, report["schema"]), (1, ["shadow_relation"]))
        # a verify without a target is refused as an input error
        self.assertEqual(self.ws.cli("verify", "--checkpoint", folder / audit.CHECKPOINT)[0], 2)

    # PV-03 (SE-01, SE-09): files, refusals and what may appear in them.
    def test_pv03_private_files_refusals_and_no_row_content(self):
        refused = self.ws.cli("init", self.ws.repo / "inside")
        self.assertEqual(refused[0], 2)
        self.assertNotIn(str(self.ws.repo), json.dumps(refused[1]))
        real = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda path: path == self.ws.root or real(path)):
            self.assertEqual(self.ws.cli("init", self.ws.root)[0], 2)
        self.assertFalse((self.ws.root / audit.LEDGER).exists())

        self.ws.init()
        folder = self.ws.sealed("2026-09-30T01:00:00Z", {1: "a", 2: "b"})
        if os.name == "posix":
            for path in (folder / audit.CHECKPOINT, folder / "manifest.json", self.ws.root / audit.LEDGER):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path.name)
        # a backup that already holds a checkpoint is never sealed again
        before = self.ws.tree()
        with self.assertRaises(audit.Refused):
            self.ws.seal(folder, stream({1: "a", 2: "b"}))
        self.assertEqual(self.ws.tree(), before)
        # checkpoint, ledger and reports carry ids, digests, counts and folder names only
        _, report = self.ws.cli("verify", "--backup", folder, evaluation=stream({1: "a", 2: "b"}))
        written = [json.dumps(report), (folder / audit.CHECKPOINT).read_text(), (self.ws.root / audit.LEDGER).read_text()]
        for text in written:
            self.assertNotIn("syn-sentinel", text)
            self.assertNotIn("private-sentinel", text)
        self.assertEqual([row[0] for row in self.ws.checkpoint(folder)["rows"]], [1, 2])
        self.assertTrue(all(len(row[1]) == 64 for row in self.ws.checkpoint(folder)["rows"]))

    def _chain(self):
        """K0, K1, K2 sealed a day apart with growing rows; returns the folders."""
        self.ws.init()
        rows = {1: "a", 2: "b"}
        folders = []
        for day, extra in ((1, {}), (2, {3: "c"}), (3, {4: "d"})):
            rows = {**rows, **extra}
            folders.append(self.ws.sealed("2026-10-%02dT01:00:00Z" % day, rows))
        return folders

    # PV-04 (RT-02..05, RT-07..09, RT-12, SE-06): retention against the ledger.
    def test_pv04_retention_expected_list_comes_from_the_ledger(self):
        k0, k1, k2 = self._chain()
        as_of = "2026-10-03T06:00:00Z"
        before = self.ws.tree()
        code, report = self.ws.cli("retention", self.ws.root, "--as-of", as_of)
        self.assertEqual(code, 0, report)
        self.assertEqual((report["sealed"], report["years"], report["latest"]), (3, 2, k2.name))
        self.assertEqual(self.ws.tree(), before, "retention never writes or deletes")
        # folders made in another order and unrelated folders do not change the verdict
        (self.ws.root / "20250101-000000-00000000").mkdir()
        (self.ws.root / "notes").mkdir()
        self.assertEqual(self.ws.cli("retention", self.ws.root, "--as-of", as_of)[0], 0)

        def without(*folders):
            saved = {folder: {p.name: p.read_bytes() for p in folder.iterdir()} for folder in folders}
            for folder in folders:
                remove_folder(folder)
            try:
                return self.ws.cli("retention", self.ws.root, "--as-of", as_of)
            finally:
                for folder, files in saved.items():
                    folder.mkdir(mode=0o700)
                    for name, data in files.items():
                        (folder / name).write_bytes(data)

        for label, folders in (("middle", (k1,)), ("latest", (k2,)), ("latest two", (k1, k2)), ("all", (k0, k1, k2))):
            with self.subTest(label):
                code, report = without(*folders)
                self.assertEqual((code, report["missing"]), (1, sorted(folder.name for folder in folders)))
        dump = k2 / "kin.dump"
        kept = dump.read_bytes()
        dump.write_bytes(kept + b"x")
        self.assertEqual(self.ws.cli("retention", self.ws.root, "--as-of", as_of)[1]["dump_changed"], [k2.name])
        dump.unlink()
        self.assertEqual(self.ws.cli("retention", self.ws.root, "--as-of", as_of)[1]["dump_missing"], [k2.name])
        dump.write_bytes(kept)
        # the latest seal older than the monitor's backup age: stale
        code, report = self.ws.cli("retention", self.ws.root, "--as-of", "2026-10-04T08:00:00Z")
        self.assertEqual((code, report["stale"]), (1, True))
        # past a sealed backup's retention window its absence is not a finding (expired-only control)
        with self.subTest("expired only"):
            ws = Workspace()
            self.addCleanup(ws.close)
            ws.init()
            old = ws.sealed("2024-01-01T00:00:00Z", {1: "a"})
            ws.sealed("2026-10-03T01:00:00Z", {1: "a", 2: "b"})
            remove_folder(old)
            self.assertEqual(ws.cli("retention", ws.root, "--as-of", as_of)[0], 0)

    def test_pv04_init_only_and_integrity_events_are_reported_not_failed(self):
        self.ws.init()
        code, report = self.ws.cli("retention", self.ws.root, "--as-of", "2026-10-01T00:00:00Z")
        self.assertEqual((code, report["no_seal"]), (1, True))
        self.ws.sealed("2026-10-01T01:00:00Z", {1: "a", 2: "b"})
        self.ws.sealed("2026-10-02T01:00:00Z", {1: "a", 2: "CHANGED", 3: "c"})              # a past event
        self.ws.sealed("2026-10-03T01:00:00Z", {1: "a", 2: "CHANGED", 3: "c"}, guard=INEFFECTIVE)   # a current defect
        code, report = self.ws.cli("retention", self.ws.root, "--as-of", "2026-10-03T06:00:00Z")
        self.assertEqual(code, 0, report)
        self.assertEqual([event["state"] for event in report["integrity_events"]["past"]], ["failed"])
        self.assertEqual([event["guard"] for event in report["integrity_events"]["current"]], ["ineffective"])

    # PV-05 (SE-04..07): the previous checkpoint, file to file.
    def test_pv05_previous_checkpoint_comparison(self):
        self.ws.init()
        k0 = self.ws.sealed("2026-10-01T01:00:00Z", {1: "a", 2: "b"})
        first = self.ws.checkpoint(k0)
        self.assertEqual((first["previous"], first["previous_verification"]["state"]), (None, "none"))
        self.assertNotIn("backup_error", self.ws.manifest(k0))

        k1 = self.ws.sealed("2026-10-02T01:00:00Z", {1: "a", 2: "b", 3: "c"})
        second = self.ws.checkpoint(k1)
        seal0 = self.ws.ledger()["entries"][1]
        self.assertEqual(second["previous"], {"backup": k0.name, "sha256": seal0["checkpoint_sha256"], "seq": 1})
        self.assertEqual(second["previous_verification"]["state"], "verified")

        k2 = self.ws.backup("2026-10-03T01:00:00Z")
        alarm = self.ws.seal(k2, stream({1: "a", 2: "B", 3: "c", 4: "d"}))
        third = self.ws.checkpoint(k2)
        self.assertEqual(third["previous_verification"]["state"], "failed")
        self.assertEqual(third["previous_verification"]["changed"]["ids"], [2])
        self.assertEqual(self.ws.manifest(k2)["backup_error"], {"stage": "audit integrity", "type": alarm})
        self.assertEqual(self.ws.manifest(k2)["complete"], True)
        self.assertEqual(self.ws.ledger()["entries"][-1]["previous_verification"]["state"], "failed")

        # the ledger's latest folder is gone: unverifiable, and the link keeps the ledger's latest (never null)
        latest = self.ws.ledger()["entries"][-1]
        remove_folder(k2)
        k3 = self.ws.sealed("2026-10-04T01:00:00Z", {1: "a", 2: "B", 3: "c", 4: "d"})
        fourth = self.ws.checkpoint(k3)
        self.assertEqual(fourth["previous_verification"], {"state": "unverifiable", "reason": "previous_missing"})
        self.assertEqual(fourth["previous"], {"backup": latest["backup"], "sha256": latest["checkpoint_sha256"],
                                              "seq": latest["seq"]})
        self.assertEqual(self.ws.manifest(k3)["backup_error"]["stage"], "audit integrity")

        # the latest checkpoint file no longer matches the ledger: failed (previous_changed)
        path = k3 / audit.CHECKPOINT
        path.write_text(path.read_text().replace('"seq": ', '"seq":  '))
        k4 = self.ws.sealed("2026-10-05T01:00:00Z", {1: "a", 2: "B", 3: "c", 4: "d"})
        self.assertEqual(self.ws.checkpoint(k4)["previous_verification"], {"state": "failed", "reason": "previous_changed"})

    # PV-06 (RT-01, RT-11): the calendar rule and the plan's years.
    def test_pv06_calendar_retention_and_plan_years(self):
        self.ws.init()
        expected = {"2026-09-30T01:02:03Z": "2028-09-30T01:02:03+00:00", "2027-02-28T05:00:00Z": "2029-02-28T05:00:00+00:00",
                    "2027-03-01T05:00:00Z": "2029-03-01T05:00:00+00:00", "2028-02-29T05:00:00Z": "2030-03-01T05:00:00+00:00",
                    "2028-03-01T05:00:00Z": "2030-03-01T05:00:00+00:00"}
        folders = {}
        for index, (created, until) in enumerate(expected.items()):
            folders[created] = self.ws.sealed(created, {n: "row" for n in range(1, index + 2)})
            self.assertEqual(self.ws.checkpoint(folders[created])["retain_until"], until, created)
        # boundary of the first backup's window: two calendar years, not 730 days
        self.ws.sealed("2028-09-29T23:30:00Z", {n: "row" for n in range(1, 8)})
        remove_folder(folders["2026-09-30T01:02:03Z"])
        for as_of, code in (("2028-09-29T23:59:59Z", 1), ("2028-09-30T01:02:02Z", 1), ("2028-09-30T01:02:03Z", 0)):
            with self.subTest(as_of=as_of):
                self.assertEqual(self.ws.cli("retention", self.ws.root, "--as-of", as_of)[0], code)

        ws = Workspace()
        self.addCleanup(ws.close)
        self.assertEqual(ws.cli("init", ws.root, "--years", 1)[0], 2)
        ws.init()
        old = ws.sealed("2026-01-01T00:00:00Z", {1: "a"})
        ws.sealed("2028-07-01T00:00:00Z", {1: "a", 2: "b"})
        remove_folder(old)
        as_of = "2028-07-01T06:00:00Z"
        self.assertEqual(ws.cli("retention", ws.root, "--as-of", as_of)[0], 0)      # two years: expired
        self.assertEqual(ws.cli("plan", ws.root, "--years", 3)[0], 0)
        self.assertEqual(ws.cli("retention", ws.root, "--as-of", as_of)[0], 1)      # three years: still required
        self.assertEqual(ws.cli("plan", ws.root, "--years", 3)[0], 2)               # the plan only goes up
        self.assertEqual(ws.cli("plan", ws.root, "--years", 2)[0], 2)

    # PV-07 (SE-12, SE-13, RT-10, RT-13): the ledger lifecycle.
    def test_pv07_no_automatic_first_and_explicit_reinit(self):
        folder = self.ws.backup("2026-10-01T01:00:00Z")
        before = self.ws.tree()
        with self.assertRaises(audit.LedgerMissing):
            self.ws.seal(folder, stream({1: "a"}))
        self.assertEqual(self.ws.tree(), before, "no ledger, checkpoint or declaration is created")
        code, report = self.ws.cli("retention", self.ws.root, "--as-of", "2026-10-01T02:00:00Z")
        self.assertEqual((code, report["error"]), (2, "ledger_missing"))

        self.ws.init()
        self.assertEqual(self.ws.cli("init", self.ws.root)[0], 2, "an existing ledger is never replaced")
        self.ws.seal(folder, stream({1: "a"}))
        (self.ws.root / audit.LEDGER).unlink()                      # the ledger is lost; the sealed folder remains
        self.assertEqual(self.ws.cli("init", self.ws.root)[0], 2)
        self.assertEqual(self.ws.cli("init", self.ws.root, "--after-loss")[0], 2)
        self.assertEqual(self.ws.cli("init", self.ws.root, "--after-loss", "--reason", "ledger volume lost")[0], 0)
        first = self.ws.ledger()["entries"][0]
        self.assertEqual((first["kind"], first["found"]), ("reinit_after_loss", [folder.name]))
        self.ws.sealed("2026-10-02T01:00:00Z", {1: "a", 2: "b"})
        code, report = self.ws.cli("retention", self.ws.root, "--as-of", "2026-10-02T02:00:00Z")
        self.assertEqual(code, 1)
        self.assertEqual(report["discontinuity"], first["at"])

    def test_pv07_append_only_and_interrupted_seals(self):
        self.ws.init()
        k0 = self.ws.sealed("2026-10-01T01:00:00Z", {1: "a"})
        prefix = self.ws.ledger()["entries"]
        self.ws.sealed("2026-10-02T01:00:00Z", {1: "a", 2: "b"})
        self.assertEqual(self.ws.ledger()["entries"][:len(prefix)], prefix)

        # a ledger changed while a seal runs is not extended
        def change_ledger(*_):
            body = self.ws.ledger()
            body["entries"][1]["checkpoint_sha256"] = "0" * 64
            (self.ws.root / audit.LEDGER).write_text(json.dumps(body))
            return stream({1: "a", 2: "b", 3: "c"})
        folder = self.ws.backup("2026-10-03T01:00:00Z")
        with patch.object(audit, "evaluate", side_effect=change_ledger), self.assertRaises(audit.LedgerChanged):
            audit.seal(folder, self.ws.root, self.ws.manifest(folder))
        self.assertEqual(len(self.ws.ledger()["entries"]), 3)

        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init()
        ws.sealed("2026-10-01T01:00:00Z", {1: "a"})
        ledger_bytes = (ws.root / audit.LEDGER).read_bytes()
        # (a) declared in its manifest but not in the ledger (stopped before the ledger step)
        declared = ws.sealed("2026-10-02T01:00:00Z", {1: "a", 2: "b"})
        (ws.root / audit.LEDGER).write_bytes(ledger_bytes)
        code, report = ws.cli("retention", ws.root, "--as-of", "2026-10-02T06:00:00Z")
        self.assertEqual((code, report["uncommitted"]), (1, [declared.name]))
        after = ws.sealed("2026-10-03T01:00:00Z", {1: "a", 2: "b", 3: "c"})
        entries = ws.ledger()["entries"]
        self.assertEqual([(e["backup"], e["recovered"]) for e in entries[2:]], [(declared.name, True), (after.name, False)])
        self.assertEqual(ws.checkpoint(after)["previous_verification"]["state"], "verified")
        self.assertEqual(ws.cli("retention", ws.root, "--as-of", "2026-10-03T06:00:00Z")[0], 0)

        # (b) a checkpoint file written but never declared is not trusted and not recovered
        ledger_bytes = (ws.root / audit.LEDGER).read_bytes()
        undeclared = ws.backup("2026-10-04T01:00:00Z")
        manifest_bytes = (undeclared / "manifest.json").read_bytes()
        ws.seal(undeclared, stream({1: "a", 2: "b", 3: "c", 4: "d"}))
        (undeclared / "manifest.json").write_bytes(manifest_bytes)
        (ws.root / audit.LEDGER).write_bytes(ledger_bytes)
        nxt = ws.sealed("2026-10-05T01:00:00Z", {1: "a", 2: "b", 3: "c", 4: "d", 5: "e"})
        self.assertEqual(ws.checkpoint(nxt)["previous"]["backup"], after.name)
        self.assertEqual(ws.checkpoint(nxt)["previous_verification"]["state"], "verified")
        self.assertNotIn(undeclared.name, [e.get("backup") for e in ws.ledger()["entries"]])

        # (c) a declared checkpoint that does not continue the ledger's latest: not recovered, unverifiable
        ledger_bytes = (ws.root / audit.LEDGER).read_bytes()
        broken = ws.sealed("2026-10-06T01:00:00Z", {n: "x" for n in range(1, 7)})
        body = ws.checkpoint(broken)
        body["previous"] = {"backup": k0.name, "sha256": "0" * 64, "seq": 1}
        (broken / audit.CHECKPOINT).write_text(json.dumps(body))
        manifest = ws.manifest(broken)
        manifest["sha256"][audit.CHECKPOINT] = audit.sha256_file(broken / audit.CHECKPOINT)
        ops.write_json(broken / "manifest.json", manifest)
        (ws.root / audit.LEDGER).write_bytes(ledger_bytes)
        last = ws.backup("2026-10-07T01:00:00Z")
        alarm = ws.seal(last, stream({n: "x" for n in range(1, 8)}))
        self.assertEqual(ws.checkpoint(last)["previous_verification"],
                         {"state": "unverifiable", "reason": "uncommitted_checkpoint"})
        self.assertEqual(ws.manifest(last)["backup_error"], {"stage": "audit integrity", "type": alarm})
        self.assertNotIn(broken.name, [e.get("backup") for e in ws.ledger()["entries"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
