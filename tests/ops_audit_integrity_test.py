"""TEST-S7-AUDIT-STORE-PURE (REQ-S7-AUDIT-STORE -> RISK-S7-AUDIT-TAMPER, RISK-S7-AUDIT-LOSS): the verdicts, exit codes,
checkpoint and ledger files, previous-checkpoint comparison, calendar retention and the ledger lifecycle of
scripts/ops_audit_integrity.py, without Docker.

PV-01..PV-07: only the isolated verifier boundary (evaluate: the one place that starts the networkless verifier and
returns the digest stream of an export) is replaced by a synthetic stream; its real behaviour on PostgreSQL is
tests/audit_store_db_test.py. Backup roots, folders and the ledger are made with the public commands (init, plan), the
public seal function and files; times enter only through a snapshot manifest's created_utc and retention --as-of.
PV-08 runs the real evaluate with its existing timeout argument against FakeDocker below: a test-side docker CLI whose
exporter and verifier are real processes that stall, refuse to read or fail as a case asks. Assertions are on exit
codes, the documented report, file contents (ids, digests, states), elapsed time and whether processes and containers
remain, never on implementation text.
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
import subprocess
import sys
import tempfile
import threading
import time
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


# The fake docker CLI (test side). Containers and volumes are files under the state directory given as its first
# argument; a container is found by its name or its 64-hex ID. `exec` runs in this very process what the container would
# run, told apart by the docker CLI's own options: an exec that sets an environment (-e) and stays attached is the
# exporter, a detached one (-d) the export's watchdog, one with stdin (-i) the verifier, any other `sh` exec into the
# target a control command. As plan.json says: exporter normal | short (1 KiB, exit 0) | stall (1 KiB, then nothing) |
# fail (1 KiB, exit 1);
# verifier normal (reads to EOF, answers) | no_read (never reads) | stall_after_read (reads to EOF, never answers) |
# fail_after_read (reads to EOF, exit 3) | fail (exit 3 at once); cancel clean (the run is gone: nothing left) | remaining (one process and one session left) |
# fail (exit 1) | unreadable (no result line) | hang (never answers); remove normal | fail | hang. In this fake the
# exporter's local client is its remote process too, so ending the client ends the export, as a cancel that answers
# "clean" reports.
FAKE_DOCKER = r'''
import hashlib, json, os, sys, time
from pathlib import Path

state, args = Path(sys.argv[1]), sys.argv[2:]
plan = json.loads((state / "plan.json").read_text())


def entry(kind, name):
    return state / kind / name


def resolve(name):
    if entry("containers", name).is_file():
        return name
    for path in (state / "containers").iterdir():
        if json.loads(path.read_text())["id"] == name:
            return path.name
    return None


def absent(name):
    sys.stderr.write("Error: No such object: %s\n" % name)
    sys.exit(1)


def label(command):
    return next(command[i + 1].split("=", 1)[1] for i, arg in enumerate(command) if arg == "--label")


def forever():
    time.sleep(3600)
    sys.exit(0)


if args[:2] == ["image", "inspect"]:
    print('[{"RepoDigests": []}]')
elif args[:2] == ["inspect", "--format"]:
    found = resolve(args[3])
    if found is None:
        absent(args[3])
    body = json.loads(entry("containers", found).read_text())
    print(args[2].replace("{{.Id}}", body["id"]).replace("{{.Image}}", body["image"]))
elif args[0] in ("container", "volume") and args[1] == "inspect":
    kind, name = args[0] + "s", args[-1]
    if not entry(kind, name).is_file():
        absent(name)
    print(json.loads(entry(kind, name).read_text())["label"] if "--format" in args else "[{}]")
elif args[:2] == ["volume", "create"]:
    entry("volumes", args[-1]).write_text(json.dumps({"label": label(args)}))
elif args[:2] == ["volume", "rm"]:
    entry("volumes", args[-1]).unlink()
elif args[0] == "run":
    name = args[args.index("--name") + 1]
    entry("containers", name).write_text(json.dumps({"label": label(args), "image": args[-1],
                                                     "id": hashlib.sha256(name.encode()).hexdigest()}))
    print(name)
elif args[0] == "rm":
    if plan["remove"] == "fail":
        sys.stderr.write("Error response from daemon: synthetic removal failure\n")
        sys.exit(1)
    if plan["remove"] == "hang":
        forever()
    entry("containers", args[-1]).unlink()
elif args[0] == "exec":
    options, command = [], args[1:]
    while command and command[0].startswith("-"):
        options.append(command[0])
        command = command[2:] if command[0] == "-e" else command[1:]
    if resolve(command[0]) is None:
        sys.stderr.write("Error: No such container: %s\n" % command[0])
        sys.exit(1)
    program = command[1]
    if program == "sh" and "-d" in options:
        pass
    elif program == "sh" and "-e" in options:
        out, block = sys.stdout.buffer, b"FAKE-EXPORT-" * 4096
        if plan["exporter"] == "short":
            out.write(block[:1024])
            out.flush()
            sys.exit(0)
        if plan["exporter"] in ("stall", "fail"):
            out.write(block[:1024])
            out.flush()
            forever() if plan["exporter"] == "stall" else sys.exit(1)
        sha = hashlib.sha256()
        for _ in range(plan["blocks"]):
            out.write(block)
            sha.update(block)
        out.flush()
        (state / "exported.json").write_text(json.dumps({"sha256": sha.hexdigest()}))
    elif program == "sh" and "-i" in options:
        if plan["verifier"] == "fail":
            sys.exit(3)
        if plan["verifier"] == "no_read":
            forever()
        data = sys.stdin.buffer.read()
        (state / "received.json").write_text(json.dumps({"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}))
        if plan["verifier"] == "fail_after_read":
            sys.exit(3)
        if plan["verifier"] == "stall_after_read":
            forever()
        sys.stdout.write("\n".join(plan["answer"]) + "\n")
    elif program == "sh":
        (state / "controls.json").write_text(json.dumps(command))
        if plan["cancel"] == "fail":
            sys.exit(1)
        if plan["cancel"] == "hang":
            forever()
        if plan["cancel"] == "unreadable":
            print("synthetic answer without a result")
        else:
            print("killed")
            print("result 1 0 0 0 63" if plan["cancel"] == "clean" else "result 1 1 0 1 63")
    elif program == "pg_restore":
        sys.stdin.buffer.read()
else:
    sys.stderr.write("fake docker: unexpected command\n")
    sys.exit(64)
'''
# The columns 0_init creates (api/prisma/migrations/0_init/migration.sql), as the verifier's catalog reports them.
SOUND_COLUMNS = {"id": ["integer", True], "at": ["timestamp(3) without time zone", True], "actor": ["text", True],
                 "action": ["text", True], "target": ["text", True], "detail": ["text", False]}


def verifier_answer(rows):
    """What the verifier prints for a sound AuditLog holding rows {id: content}: shape, one line per id, schema view."""
    return [json.dumps({"table": True, "relkind": "r", "columns": SOUND_COLUMNS}),
            *("%d|1|%s" % (key, row_digest(value)) for key, value in sorted(rows.items())),
            json.dumps({"relkind": "r", "inherits": 0, "shadows": 0, "probe": PRESENT["statements"]})]


class FakeDocker:
    """Test-side process harness: while active, every `docker ...` process the product starts (subprocess.Popen, which
    subprocess.run uses too) is FAKE_DOCKER run by this interpreter with this state directory. Every launched process is
    kept so that a case can tell whether any is still running."""

    def __init__(self, base):
        self.state = Path(base) / "fake-docker"
        for kind in ("containers", "volumes"):
            (self.state / kind).mkdir(parents=True)
        self.script = self.state / "docker.py"
        self.script.write_text(FAKE_DOCKER, encoding="utf-8")
        self.launched = []
        self.plan()

    def plan(self, exporter="normal", verifier="normal", answer=(), blocks=4, cancel="clean", remove="normal"):
        for name in ("exported.json", "received.json", "controls.json"):
            (self.state / name).unlink(missing_ok=True)
        (self.state / "plan.json").write_text(json.dumps({"exporter": exporter, "verifier": verifier,
                                                          "answer": list(answer), "blocks": blocks, "cancel": cancel,
                                                          "remove": remove}))

    def container(self, name, image=IMAGE):
        (self.state / "containers" / name).write_text(json.dumps({"label": "", "image": image,
                                                                  "id": hashlib.sha256(name.encode()).hexdigest()}))

    def container_id(self, name):
        return json.loads((self.state / "containers" / name).read_text())["id"]

    def names(self, kind):
        return sorted(path.name for path in (self.state / kind).iterdir())

    def note(self, name):
        path = self.state / name
        return json.loads(path.read_text()) if path.is_file() else None

    def running(self):
        return [args[:2] for args, process in self.launched if process.poll() is None]

    def kill_all(self):
        for _, process in self.launched:
            if process.poll() is None:
                process.kill()
                process.wait()

    @contextlib.contextmanager
    def active(self, verifier=None):
        """verifier, when given, makes the verifier's process: called with Popen's keyword arguments for the exec with
        stdin of `sh` in a container the product started, it returns the process object the product then holds."""
        real = subprocess.Popen

        def popen(args, *rest, **kwargs):
            if not (isinstance(args, (list, tuple)) and args and args[0] == "docker"):
                return real(args, *rest, **kwargs)
            if verifier is not None and args[1:3] == ["exec", "-i"] and args[4:5] == ["sh"]:
                process = verifier(kwargs)
            else:
                process = real([sys.executable, "-B", str(self.script), str(self.state), *args[1:]], *rest, **kwargs)
            self.launched.append((list(args[1:]), process))
            return process
        with patch.object(subprocess, "Popen", popen):
            yield self

    def bounded(self, call, seconds):
        """Run call() in a thread for at most seconds: (outcome, elapsed, finished). A call still running then has its
        fake processes killed so that it can end; the case reports it as not finished."""
        outcome = {}

        def target():
            try:
                outcome["value"] = call()
            except BaseException as error:   # the outcome is judged by the case
                outcome["error"] = error
        started = time.monotonic()
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        thread.join(seconds)
        elapsed = time.monotonic() - started
        finished = not thread.is_alive()
        if not finished:
            self.kill_all()
            thread.join(60)
        return outcome, elapsed, finished


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

    def interrupted(self, created, rows, previous=None):
        """A seal that stopped after its manifest declaration (§1 L rule 3): the checkpoint and its declaration exist
        and the ledger is as it was. previous, when given, replaces the checkpoint's link (it then does not continue
        the ledger's latest seal) and the declaration is made to match the changed file."""
        ledger = (self.root / audit.LEDGER).read_bytes()
        folder = self.sealed(created, rows)
        if previous is not None:
            body = self.checkpoint(folder)
            body["previous"] = previous
            (folder / audit.CHECKPOINT).write_text(json.dumps(body))
            manifest = self.manifest(folder)
            manifest["sha256"][audit.CHECKPOINT] = audit.sha256_file(folder / audit.CHECKPOINT)
            manifest["bytes"][audit.CHECKPOINT] = (folder / audit.CHECKPOINT).stat().st_size
            ops.write_json(folder / "manifest.json", manifest)
        (self.root / audit.LEDGER).write_bytes(ledger)
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

    # PV-07 (SE-13, RT-13; S7-AUDIT-STORE-F01): a later seal does not resolve a declaration the ledger lacks.
    def test_pv07_unrecovered_declaration_stays_reported_after_later_seals(self):
        def retention(day):
            return self.ws.cli("retention", self.ws.root, "--as-of", "2026-10-%02dT06:00:00Z" % day)

        self.ws.init()
        k0 = self.ws.sealed("2026-10-01T01:00:00Z", {1: "a"})
        broken = self.ws.interrupted("2026-10-02T01:00:00Z", {1: "a", 2: "b"},
                                     previous={"backup": k0.name, "sha256": "0" * 64, "seq": 1})
        code, report = retention(2)
        self.assertEqual((code, report["uncommitted"]), (1, [broken.name]))
        # the next seal cannot recover it (it does not continue the ledger) and records a past event
        rows = {1: "a", 2: "b", 3: "c"}
        after = self.ws.sealed("2026-10-03T01:00:00Z", rows)
        self.assertEqual(self.ws.checkpoint(after)["previous_verification"],
                         {"state": "unverifiable", "reason": "uncommitted_checkpoint"})
        # counterexample: the declaration is now older than the ledger's latest seal and is still unresolved
        code, report = retention(3)
        self.assertEqual((code, report["uncommitted"], report["latest"]), (1, [broken.name], after.name))
        # new backups keep being sealed and verified against the ledger; the declaration stays reported
        rows = {**rows, 4: "d"}
        later = self.ws.sealed("2026-10-04T01:00:00Z", rows)
        self.assertEqual(self.ws.checkpoint(later)["previous_verification"], {"state": "verified"})
        self.assertNotIn("backup_error", self.ws.manifest(later))
        code, report = retention(4)
        self.assertEqual((code, report["uncommitted"]), (1, [broken.name]))

        # whatever else happens to the unresolved folder, the report never turns into a pass
        def changed(path, data):
            kept = path.read_bytes()
            path.unlink() if data is None else path.write_bytes(data)
            try:
                return retention(4)
            finally:
                path.write_bytes(kept)
        manifest = self.ws.manifest(broken)
        variants = {"checkpoint unreadable": (broken / audit.CHECKPOINT, b"{not json"),
                    "checkpoint removed": (broken / audit.CHECKPOINT, None),
                    "kin.dump removed": (broken / "kin.dump", None),
                    "creation time unreadable": (broken / "manifest.json",
                                                 json.dumps(dict(manifest, created_utc="not a time")).encode())}
        for label, (path, data) in variants.items():
            with self.subTest(label):
                code, report = changed(path, data)
                self.assertEqual((code, report["uncommitted"]), (1, [broken.name]))

        # the snapshot whose seal recorded it holds only a past event: its own verification passes (RS-08)
        code, report = self.ws.cli("verify", "--backup", after, evaluation=stream({1: "a", 2: "b", 3: "c"}))
        self.assertEqual((code, report["previous_verification"]["state"]), (0, "unverifiable"))

        # preservation: a later interrupted seal that continues the ledger is recovered by the next seal and leaves
        # the report, the unresolved one does not
        rows = {**rows, 5: "e"}
        resumable = self.ws.interrupted("2026-10-05T01:00:00Z", rows)
        self.assertEqual(retention(5)[1]["uncommitted"], [broken.name, resumable.name])
        rows = {**rows, 6: "f"}
        nxt = self.ws.sealed("2026-10-06T01:00:00Z", rows)
        self.assertEqual([(e["backup"], e["recovered"]) for e in self.ws.ledger()["entries"][-2:]],
                         [(resumable.name, True), (nxt.name, False)])
        self.assertEqual(self.ws.checkpoint(nxt)["previous_verification"], {"state": "verified"})
        code, report = retention(6)
        self.assertEqual((code, report["uncommitted"]), (1, [broken.name]))

        # control: a recovered declaration is not reported however many seals follow it, and with nothing unresolved
        # retention passes
        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init()
        rows = {1: "a"}
        ws.sealed("2026-10-01T01:00:00Z", rows)
        ws.interrupted("2026-10-02T01:00:00Z", {**rows, 2: "b"})
        for day in (3, 4, 5):
            rows = {**rows, day: "x"}
            ws.sealed("2026-10-%02dT01:00:00Z" % day, rows)
        code, report = ws.cli("retention", ws.root, "--as-of", "2026-10-05T06:00:00Z")
        self.assertEqual((code, report["uncommitted"], report["sealed"]), (0, [], 5))

        # control: after a re-initialisation the former ledger's declarations belong to that ledger, not this one
        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init()
        ws.interrupted("2026-10-01T01:00:00Z", {1: "a"})
        (ws.root / audit.LEDGER).unlink()
        self.assertEqual(ws.cli("init", ws.root, "--after-loss", "--reason", "ledger volume lost")[0], 0)
        ws.sealed("2026-10-02T01:00:00Z", {1: "a", 2: "b"})
        code, report = ws.cli("retention", ws.root, "--as-of", "2026-10-02T06:00:00Z")
        self.assertEqual((code, report["uncommitted"]), (1, []))
        self.assertIsNotNone(report["discontinuity"])


TARGET = "kin-syn-target"   # the named database's container in PV-08
LIMIT = 3                   # the time limit given to evaluate in the stall cases (seconds)
GRACE = 15                  # how long after its limit a stopped transfer may take to come back as a failure
PROMPT = 20                 # a failure of one side must come back well before a 60 s limit


class TransferDeadline(unittest.TestCase):
    """PV-08 (S7-AUDIT-STORE-F02): evaluate's timeout bounds the export, its transfer and the verification together.
    An exporter that stops sending, a verifier that stops reading or never answers ends at the limit; one side failing
    ends it at once. Either way evaluate raises InputError (the callers' exit 2 / failure record), no exporter or
    verifier process is left running and the verifier container is removed. The normal transfer is unchanged."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="kin-audit-deadline-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.fake = FakeDocker(self.base)
        self.addCleanup(self.fake.kill_all)
        self.fake.container(TARGET)

    def snapshot(self, size=3 * 1024 * 1024):
        path = self.base / ("kin-%s.dump" % uuid.uuid4().hex[:8])
        path.write_bytes(os.urandom(size))
        return audit.SnapshotDump(path, audit.sha256_file(path), IMAGE)

    def evaluate(self, source, timeout, bound):
        with self.fake.active():
            outcome, elapsed, finished = self.fake.bounded(lambda: audit.evaluate(source, timeout=timeout), bound)
        self.assertTrue(finished, "evaluate was still running %.0f s after its %s s limit" % (bound, timeout))
        self.assertEqual(self.fake.running(), [], "no exporter or verifier process is left running")
        self.assertEqual(self.fake.names("containers"), [TARGET], "the verifier container is removed")
        if isinstance(source, audit.SnapshotDump):
            # the snapshot file is not held open afterwards (Windows refuses to rename a file another handle holds)
            moved = source.path.with_suffix(".moved")
            try:
                source.path.rename(moved)
            except OSError as error:
                self.fail("the snapshot file is still held open: %s" % error)
            moved.rename(source.path)
        return outcome, elapsed

    def assert_input_error(self, outcome):
        self.assertIsInstance(outcome.get("error"), audit.InputError, outcome)
        proof = outcome["error"].cleanup
        self.assertIsNotNone(proof, "the failure carries its termination proof")
        self.assertTrue(proof["confirmed"], proof)
        self.assertLessEqual(proof["elapsed_seconds"], GRACE)

    def test_pv08_a_stalled_side_ends_at_the_limit(self):
        cases = {"exporter stops sending": (dict(exporter="stall"), audit.DatabaseExport(TARGET, "kin", "kin")),
                 "verifier stops reading": (dict(verifier="no_read", blocks=64),
                                            audit.DatabaseExport(TARGET, "kin", "kin")),
                 "verifier stops reading a snapshot": (dict(verifier="no_read"), None),
                 "verifier never answers": (dict(verifier="stall_after_read"), None)}
        for label, (plan, source) in cases.items():
            with self.subTest(label):
                self.fake.plan(**plan)
                outcome, elapsed = self.evaluate(source or self.snapshot(), LIMIT, LIMIT + GRACE)
                self.assert_input_error(outcome)
                self.assertGreaterEqual(elapsed, LIMIT - 0.5, "the case stalled until its limit")

    def test_pv08_one_side_failing_ends_the_other_at_once(self):
        cases = {"verifier fails while the exporter stalls": dict(exporter="stall", verifier="fail"),
                 "exporter fails while the verifier does not read": dict(exporter="fail", verifier="no_read")}
        for label, plan in cases.items():
            with self.subTest(label):
                self.fake.plan(**plan)
                outcome, elapsed = self.evaluate(audit.DatabaseExport(TARGET, "kin", "kin"), 60, 60 + GRACE)
                self.assert_input_error(outcome)
                self.assertLess(elapsed, PROMPT, "a failed side is not waited out until the limit")
        with self.subTest("verifier fails on a snapshot"):
            self.fake.plan(verifier="fail")
            outcome, elapsed = self.evaluate(self.snapshot(), 60, 60 + GRACE)
            self.assert_input_error(outcome)
            self.assertLess(elapsed, PROMPT)

    def test_pv08_normal_transfer_and_the_verify_exit_codes(self):
        rows = {1: "a", 2: "b", 3: "c"}
        self.fake.plan(answer=verifier_answer(rows), blocks=64)
        outcome, _ = self.evaluate(audit.DatabaseExport(TARGET, "kin", "kin"), 60, 60 + GRACE)
        evaluation = outcome.get("value")
        self.assertIsInstance(evaluation, audit.Evaluation, outcome)
        self.assertEqual((sorted(evaluation.rows), evaluation.guard["state"], evaluation.schema),
                         (sorted(stream(rows).rows), "present", []))
        self.assertEqual(self.fake.note("received.json")["sha256"], self.fake.note("exported.json")["sha256"],
                         "the verifier received exactly the export")
        source = self.snapshot()
        self.fake.plan(answer=verifier_answer(rows))
        outcome, _ = self.evaluate(source, 60, 60 + GRACE)
        self.assertIsInstance(outcome.get("value"), audit.Evaluation, outcome)
        self.assertEqual(self.fake.note("received.json")["sha256"], source.sha256)

        # the caller's path: verify answers 0 for the sound export and 2 (an input error) when a side fails
        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init()
        folder = ws.sealed("2026-10-01T01:00:00Z", rows)

        def verify():
            output = io.StringIO()
            with patch.object(ops, "require_local_docker"), contextlib.redirect_stdout(output):
                code = audit.main(["verify", "--container", TARGET, "--database", "kin", "--user", "kin",
                                   "--checkpoint", str(folder / audit.CHECKPOINT)])
            return code, json.loads(output.getvalue())
        for label, plan, expected in (("sound", dict(answer=verifier_answer(rows)), 0),
                                      ("exporter fails", dict(exporter="fail", verifier="no_read"), 2)):
            with self.subTest(label):
                self.fake.plan(**plan)
                with self.fake.active():
                    outcome, elapsed, finished = self.fake.bounded(verify, 60)
                self.assertTrue(finished)
                code, report = outcome["value"]
                self.assertEqual((code, report["exit"]), (expected, expected), report)
                self.assertLess(elapsed, PROMPT)
                self.assertEqual(self.fake.running(), [])
                self.assertEqual(self.fake.names("containers"), [TARGET])


class Sink:
    """The scripted verifier's stdin, like a pipe to a process that reads everything (complete), has gone (broken: the
    first write fails) or stopped reading (blocked: a write waits until the process ends, then fails)."""

    def __init__(self, mode):
        self.mode = mode
        self.closed, self.entered, self.released = threading.Event(), threading.Event(), threading.Event()

    def write(self, chunk):
        if self.mode == "blocked":
            self.entered.set()
            self.released.wait(60)
        if self.mode != "complete":
            raise BrokenPipeError(32, "synthetic: the verifier does not read")
        return len(chunk)

    def flush(self):
        pass

    def close(self):
        self.closed.set()

    def settle(self):
        """The transfer has reached this mode's state (all sent, broken, or waiting in a write)."""
        (self.entered if self.mode == "blocked" else self.closed).wait(10)


class ScriptedVerifier:
    """A verifier process at the Popen boundary whose end is scripted: it runs until its end_at-th observation (every
    poll() and wait() call counts as one, so a wait can be the one it ends in) or until ends_after seconds after it
    started, then has exited with code - with code 0 it has printed answer - and stops reading its stdin. A wait it does
    not end in sleeps its timeout and then late seconds more, as an operating system wait can return late. Waits made
    while it ran are kept with the time left to the deadline the caller gave evaluate (counted from this process's
    start, so never earlier than the caller's own deadline)."""

    def __init__(self, kwargs, code, sink, answer, timeout, end_at=None, ends_after=None, late=0.05):
        self.stdin, self.stdout, self.pid, self.returncode = sink, None, 0, None
        self.output, self.code, self.answer, self.late = kwargs["stdout"], code, answer, late
        self.created = time.monotonic()
        self.deadline = self.created + timeout
        self.end_at, self.ends_at = end_at, None if ends_after is None else self.created + ends_after
        self.calls, self.running_waits = 0, []

    def _end(self, code):
        if self.returncode is None:
            # a real process writes through its own handle; once the caller closed its side nothing reads the answer
            if code == 0 and not self.output.closed:
                self.output.write(("\n".join(self.answer) + "\n").encode())
                self.output.flush()
            self.returncode = code
            self.stdin.released.set()

    def _observe(self):
        if not self.calls:
            self.stdin.settle()
        self.calls += 1
        if (self.end_at is not None and self.calls >= self.end_at) or \
                (self.ends_at is not None and time.monotonic() >= self.ends_at):
            self._end(self.code)
        return self.returncode

    def poll(self):
        return self._observe()

    def wait(self, timeout=None):
        now = time.monotonic()
        if self.returncode is None:
            self.running_waits.append((timeout, self.deadline - now))
        if self._observe() is not None:
            return self.returncode
        if timeout is None:
            raise AssertionError("an unbounded wait on a running verifier")
        if self.ends_at is not None and self.ends_at <= now + timeout:
            time.sleep(max(0.0, self.ends_at - time.monotonic()))
            self._end(self.code)
            return self.returncode
        time.sleep(timeout + self.late)
        raise subprocess.TimeoutExpired("docker", timeout)

    def kill(self):
        self._end(-9)


class ProducerlessEnd(unittest.TestCase):
    """PV-09 (S7-AUDIT-STORE-F03, SPEC-F02): a snapshot's verification has no exporter. The verifier process, scripted at
    the Popen boundary, ends at each of its first eight observations in turn - before the first poll, between two
    observations, during a wait, before the next pass - with exit 0 and 3, while the transfer has sent everything, has
    broken or is still blocked in a write. Only exit 0 after the whole export gives a result; every other case is an
    InputError with a confirmed termination proof; nothing else is raised (no wait on a process that is not there) and
    no wait made while the verifier ran reaches past the deadline. At the deadline: a verifier that ended just after the
    deadline, while the wait that ran up to it returned late, is judged by its exit code and the transfer when the next
    observation finds it ended; one still running fails. With a named database's exporter (no manifest digest behind
    it), a verifier that answers and exits 0 before the export reached it, while the exporter itself ended normally, is
    an input error too."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="kin-audit-f03-")
        self.addCleanup(temp.cleanup)
        self.fake = FakeDocker(temp.name)
        self.addCleanup(self.fake.kill_all)
        path = Path(temp.name) / "kin.dump"
        path.write_bytes(os.urandom(256 * 1024))
        self.source = audit.SnapshotDump(path, audit.sha256_file(path), IMAGE)
        self.rows = {1: "a", 2: "b"}

    def run_case(self, mode, code, timeout=30, **end):
        made = []

        def verifier(kwargs):
            made.append(ScriptedVerifier(kwargs, code, Sink(mode), verifier_answer(self.rows), timeout, **end))
            return made[-1]
        with self.fake.active(verifier=verifier):
            outcome, _, finished = self.fake.bounded(lambda: audit.evaluate(self.source, timeout=timeout),
                                                     timeout + GRACE)
        self.assertTrue(finished)
        self.assertEqual(self.fake.names("containers"), [], "the verifier container is removed")
        (process,) = made
        self.assertIsNotNone(process.returncode, "the verifier ended or was ended")
        for given, left in process.running_waits:
            self.assertIsNotNone(given, "a wait on a running verifier is bounded")
            self.assertLessEqual(given, max(0.0, left) + 0.01, "no wait reaches past the deadline")
        return outcome

    def assert_result(self, outcome, success):
        if success:
            self.assertIsInstance(outcome.get("value"), audit.Evaluation, outcome)
            self.assertEqual(sorted(outcome["value"].rows), sorted(stream(self.rows).rows))
        else:
            self.assertIsInstance(outcome.get("error"), audit.InputError, outcome)
            self.assertTrue(outcome["error"].cleanup["confirmed"], outcome["error"].cleanup)

    def test_pv09_every_end_transition_without_an_exporter(self):
        for mode in ("complete", "broken", "blocked"):
            for code in (0, 3):
                for end_at in range(1, 9):
                    with self.subTest(transfer=mode, code=code, end_at=end_at):
                        self.assert_result(self.run_case(mode, code, end_at=end_at), (mode, code) == ("complete", 0))

    def test_pv09_an_exit_0_before_the_whole_export_with_an_exporter(self):
        self.fake.container(TARGET)
        self.fake.plan(exporter="short")
        for end_at in (1, 2, 3):
            with self.subTest(end_at=end_at):
                made = []

                def verifier(kwargs):
                    made.append(ScriptedVerifier(kwargs, 0, Sink("blocked"), verifier_answer(self.rows), 30,
                                                 end_at=end_at))
                    return made[-1]
                with self.fake.active(verifier=verifier):
                    outcome, _, finished = self.fake.bounded(
                        lambda: audit.evaluate(audit.DatabaseExport(TARGET, "kin", "kin"), timeout=30), 30 + GRACE)
                self.assertTrue(finished)
                self.assert_result(outcome, False)
                self.assertEqual(self.fake.running(), [])
                self.assertEqual(self.fake.names("containers"), [TARGET])

    def test_pv09_an_end_at_the_deadline(self):
        for label, mode, code, ends_after, success in (
                ("ended with the whole export just after the deadline", "complete", 0, 1.1, True),
                ("ended with exit 3 just after the deadline", "complete", 3, 1.1, False),
                ("ended before the whole export just after the deadline", "blocked", 0, 1.1, False),
                ("still running at the deadline", "complete", 0, 30, False)):
            with self.subTest(label):
                self.assert_result(self.run_case(mode, code, timeout=1, ends_after=ends_after, late=0.5), success)


class CleanupBudget(unittest.TestCase):
    """PV-10 (S7-AUDIT-STORE-F02, SPEC-F01): after a failure everything shares one cleanup budget (15 s) and the failure
    carries the termination proof. The verifier fails at once while a named database's exporter still runs; the
    target's control command (the remote cancellation) answers that the run is gone, that a process and a session are
    left, fails, answers without a result or never answers, and the verifier's removal fails or never answers. Only the
    first is a confirmed cleanup. A verifier that fails only after it read the whole export gives the same complete
    proof. In every case evaluate raises the InputError within the budget after the failure, the
    proof names the run and its target (container ID, database, role, a session name holding the run that fits
    PostgreSQL's 63 bytes) and verify --container reports it with exit 2."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="kin-audit-budget-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.fake = FakeDocker(self.base)
        self.addCleanup(self.fake.kill_all)
        self.fake.container(TARGET)

    def evaluate(self, source, bound=2 * GRACE + 30):
        with self.fake.active():
            outcome, elapsed, finished = self.fake.bounded(lambda: audit.evaluate(source, timeout=60), bound)
        self.assertTrue(finished)
        self.assertIsInstance(outcome.get("error"), audit.InputError, outcome)
        self.assertEqual(self.fake.running(), [], "no process of the run is left running")
        return outcome["error"].cleanup, elapsed

    def forget_verifiers(self):
        for name in self.fake.names("containers"):
            if name != TARGET:
                (self.fake.state / "containers" / name).unlink()

    def test_pv10_what_the_proof_confirms(self):
        for answer, confirmed in (("clean", True), ("remaining", False), ("fail", False), ("unreadable", False)):
            with self.subTest(answer):
                self.fake.plan(exporter="stall", verifier="fail", cancel=answer)
                proof, elapsed = self.evaluate(audit.DatabaseExport(TARGET, "kin", "kin"))
                self.assertEqual((proof["confirmed"], proof["steps"]["remote"]["confirmed"]), (confirmed, confirmed), proof)
                self.assertTrue(proof["steps"]["verifier"]["confirmed"])
                self.assertTrue(proof["steps"]["local"]["confirmed"])
                self.assertRegex(proof["run"], r"^[0-9a-f]{32}$")
                target = proof["target"]
                self.assertEqual((target["container"], target["database"], target["role"]),
                                 (self.fake.container_id(TARGET), "kin", "kin"))
                self.assertIn(proof["run"], target["application_name"])
                self.assertLessEqual(len(target["application_name"].encode()), 63)
                self.assertTrue(proof["observed_utc"])
                self.assertLess(elapsed, PROMPT)
                self.assertLessEqual(proof["elapsed_seconds"], GRACE)
                self.assertEqual(self.fake.names("containers"), [TARGET])
                control = self.fake.note("controls.json")
                self.assertEqual(control[0], self.fake.container_id(TARGET), "the cancellation goes to the target's ID")
                self.assertIn(proof["run"], control, "and names this run")

    def test_pv10_a_failure_after_the_whole_export_carries_the_whole_proof(self):
        # the verifier reads the whole export and then fails: the failure surfaces after the transfer, not while it ran
        self.fake.plan(verifier="fail_after_read", cancel="clean")
        proof, elapsed = self.evaluate(audit.DatabaseExport(TARGET, "kin", "kin"))
        self.assertEqual(sorted(proof["steps"]), ["local", "remote", "verifier"], proof)
        self.assertTrue(proof["confirmed"], proof)
        self.assertIsNotNone(self.fake.note("controls.json"), "the ended remote export was observed again")
        self.assertEqual(self.fake.names("containers"), [TARGET])
        self.assertLess(elapsed, PROMPT)

    def test_pv10_one_budget_for_everything_after_the_failure(self):
        for label, plan in (("the cancellation never answers", dict(cancel="hang")),
                            ("neither the cancellation nor the removal answers", dict(cancel="hang", remove="hang"))):
            with self.subTest(label):
                self.fake.plan(exporter="stall", verifier="fail", **plan)
                proof, elapsed = self.evaluate(audit.DatabaseExport(TARGET, "kin", "kin"))
                self.assertFalse(proof["confirmed"], proof)
                self.assertFalse(proof["steps"]["remote"]["confirmed"])
                self.assertFalse(proof["steps"]["verifier"]["confirmed"], "no budget was left to remove it")
                self.assertLessEqual(proof["elapsed_seconds"], GRACE + 1)
                self.assertLess(elapsed, GRACE + 8, "the call fails within the budget after the failure")
                self.forget_verifiers()

    def test_pv10_a_verifier_left_behind_is_not_reported_as_removed(self):
        path = self.base / "kin.dump"
        path.write_bytes(os.urandom(64 * 1024))
        self.fake.plan(verifier="fail", remove="fail")
        proof, elapsed = self.evaluate(audit.SnapshotDump(path, audit.sha256_file(path), IMAGE))
        self.assertEqual((proof["confirmed"], proof["steps"]["verifier"]["confirmed"]), (False, False), proof)
        self.assertTrue(proof["steps"]["local"]["confirmed"])
        self.assertNotIn("remote", proof["steps"], "a snapshot has no remote export")
        self.assertLess(elapsed, PROMPT)
        self.forget_verifiers()

        # the operator's command: exit 2 with the failure and its proof
        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init()
        folder = ws.sealed("2026-10-01T01:00:00Z", {1: "a"})
        self.fake.plan(exporter="stall", verifier="fail", cancel="remaining")
        output = io.StringIO()
        with self.fake.active(), patch.object(ops, "require_local_docker"), contextlib.redirect_stdout(output):
            code = audit.main(["verify", "--container", TARGET, "--database", "kin", "--user", "kin",
                               "--checkpoint", str(folder / audit.CHECKPOINT)])
        report = json.loads(output.getvalue())
        self.assertEqual((code, report["exit"]), (2, 2), report)
        self.assertTrue(report["error"])
        self.assertFalse(report["cleanup"]["confirmed"])
        self.assertEqual(report["cleanup"]["steps"]["remote"]["processes_left"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
