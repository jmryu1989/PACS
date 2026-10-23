"""TEST-S7-AUDIT-STORE-PURE: calendar retention, missing backups and retention-plan races.

D1799/D1803 retire the standalone sealed-checkpoint verifier proofs. The >=2-year
retention cases and real ledger/rotation failure boundaries remain. FakeDocker and
verifier_answer are also used by ops_backup_test.py and remain available there.
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


    # PV-11 (RT-P3-LEDGER-LOCK, prep5 readiness5 §3 B3): the ledger's writers take turns where the ledger lives.
    def test_pv11_ledger_writers_need_no_write_beside_the_tool_and_still_take_turns(self):
        """Production installs the tool where the operating account cannot write (/opt/kin-deploy, root 0755) and runs
        init as that account, which owns the backup root; init exited 2 (PermissionError) and wrote nothing. init and
        plan succeed while the tool's folder cannot be written, and the ledger still has one writer at a time: an init,
        a plan or a seal that starts while another writer of the same root is under way is refused and writes nothing;
        an existing ledger is still never replaced, and nothing of the turn-taking stays behind in the root."""
        def unwritable(ws):
            installed = Path(ws.temp.name) / "installed"
            if os.name == "posix" and os.geteuid() != 0:
                installed.mkdir()
                installed.chmod(0o555)          # as /opt/kin-deploy is to the operating account
                self.addCleanup(installed.chmod, 0o755)
            else:
                installed.write_text("a regular file: nothing can be created below it\n")
                installed = installed / "kin-deploy"
            ws.repo = installed

        unwritable(self.ws)
        code, report = self.ws.cli("init", self.ws.root, "--years", 5)
        self.assertEqual((code, report), (0, {"exit": 0, "ledger": "init", "years": 5}))
        code, report = self.ws.cli("plan", self.ws.root, "--years", 6)
        self.assertEqual((code, report), (0, {"exit": 0, "plan": 6}))
        self.assertEqual(self.ws.cli("init", self.ws.root, "--years", 7)[0], 2, "an existing ledger is never replaced")
        self.assertEqual([entry.get("years") for entry in self.ws.ledger()["entries"]], [5, 6])

        def while_writing(ws, action):
            """Run action while a writer of ws's root is writing the ledger; returns what it saw and what it did."""
            real, seen = audit.replace_json, {}

            def write(path, body):
                if Path(path).name == audit.LEDGER and "result" not in seen:
                    seen["before"] = ws.tree()
                    try:
                        seen["result"] = action()
                    except Exception as error:   # a refused seal raises; its type is the outcome
                        seen["result"] = type(error).__name__
                    seen["after"] = ws.tree()
                return real(path, body)
            return patch.object(audit, "replace_json", side_effect=write), seen

        # two inits of one root: the second starts while the first writes; it is refused and the first one's ledger stays
        fresh = Workspace()
        self.addCleanup(fresh.close)
        unwritable(fresh)
        writing, seen = while_writing(fresh, lambda: fresh.cli("init", fresh.root, "--years", 4))
        with writing:
            self.assertEqual(fresh.cli("init", fresh.root, "--years", 3)[0], 0)
        self.assertEqual(seen["result"][0], 2, seen["result"])
        self.assertEqual(seen["before"], seen["after"])
        self.assertEqual([entry["years"] for entry in fresh.ledger()["entries"]], [3])

        # a seal that starts while a plan writes is refused before it writes anything; afterwards it seals
        folder = self.ws.backup("2026-10-01T01:00:00Z")
        writing, seen = while_writing(self.ws, lambda: self.ws.seal(folder, stream({1: "a"})))
        with writing:
            self.assertEqual(self.ws.cli("plan", self.ws.root, "--years", 8)[0], 0)
        self.assertEqual(seen["result"], "Refused")
        self.assertEqual(seen["before"], seen["after"])
        self.assertNotIn(audit.CHECKPOINT, [path.name for path in folder.iterdir()])
        self.ws.seal(folder, stream({1: "a"}))
        self.assertEqual([entry["kind"] for entry in self.ws.ledger()["entries"]], ["init", "plan", "plan", "seal"])

        # a plan or an init that starts while a seal is under way is refused and writes nothing
        later = self.ws.backup("2026-10-02T01:00:00Z")
        during = {}

        def evaluation(*_):
            during["before"] = self.ws.tree()
            during["plan"] = self.ws.cli("plan", self.ws.root, "--years", 9)
            during["init"] = self.ws.cli("init", self.ws.root, "--after-loss", "--reason", "a concurrent init")
            during["after"] = self.ws.tree()
            return stream({1: "a", 2: "b"})
        with patch.object(audit, "evaluate", side_effect=evaluation):
            audit.seal(later, self.ws.root, self.ws.manifest(later))
        self.assertEqual((during["plan"][0], during["init"][0]), (2, 2), during)
        self.assertEqual(during["before"], during["after"])
        self.assertEqual([entry["kind"] for entry in self.ws.ledger()["entries"]], ["init", "plan", "plan", "seal", "seal"])
        # nothing of the turn-taking stays behind: the root holds the ledger and the backup folders only
        for ws in (self.ws, fresh):
            self.assertEqual(sorted(path.name for path in ws.root.iterdir() if not path.is_dir()), [audit.LEDGER])

    # PV-12 (P3R1-01, Astra review of 7adea16): a retention change and the daily rotation of the same root take turns.
    def test_pv12_a_retention_plan_never_lands_inside_a_rotations_deletion(self):
        """The plan moved off the operations lock (PV-11) and lost its turn-taking with rotation, which takes its last
        retention decision, renames the set and deletes it under that lock: a `plan --years 6` succeeded right before the
        deletion and the rotation then deleted a sealed set the new period keeps. With real daily sets (every component,
        sealed into the ledger), a plan that starts at either point - after the last retention decision, before the
        rename; after the rename, before the deletion - is refused and writes nothing, so a set the ledger's period keeps
        never disappears after a plan that succeeded. The other way round, a rotation that starts while a plan writes,
        or while a ledger lock is left behind by a writer that died, is refused, deletes nothing and leaves the lock."""
        old, new = datetime(2023, 1, 1, 20, 0, 2, tzinfo=timezone.utc), datetime(2026, 10, 15, 20, 0, 2, tzinfo=timezone.utc)
        now = datetime(2026, 10, 16, tzinfo=timezone.utc)

        def daily_set(ws, created):
            """A whole daily set as backup() leaves it (each component, SHA-256 and size in its manifest), then sealed."""
            folder = ws.root / (created.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
            folder.mkdir(mode=0o700)
            sums, sizes = {}, {}
            for component in ops.FILES:
                raw = ("synthetic " + component + " " + uuid.uuid4().hex).encode()
                (folder / component).write_bytes(raw)
                sums[component], sizes[component] = hashlib.sha256(raw).hexdigest(), len(raw)
            ops.write_json(folder / "manifest.json", {"format": 1, "complete": True, "created_utc": created.isoformat(),
                                                      "postgres_image": IMAGE, "ready": True, "resume_failures": [],
                                                      "sha256": sums, "bytes": sizes})
            ws.seal(folder, stream({1: "a"}))
            return folder

        def rotation(ws):
            with patch.object(ops, "ROOT", ws.repo):
                return ops.rotate(ws.root, 1, now=now)

        def gone(folder):
            return not folder.exists() and not (folder.parent / (ops.ROTATING + folder.name)).exists()

        for point in ("before the rename", "before the deletion"):
            with self.subTest(point=point):
                ws = Workspace()
                self.addCleanup(ws.close)
                ws.init("--years", 2)
                kept_by_six = daily_set(ws, old)       # past 2 years at `now`, inside 6
                daily_set(ws, new)
                seen = {}

                def plan_here(path):
                    if Path(path).name.removeprefix(ops.ROTATING) == kept_by_six.name and "plan" not in seen:
                        seen["before"] = ws.ledger()
                        seen["plan"] = ws.cli("plan", ws.root, "--years", 6)
                        seen["after"] = ws.ledger()
                real_rename, real_rmtree = ops.os.rename, ops.shutil.rmtree

                def rename(source, destination, *args, **kwargs):
                    if point == "before the rename":
                        plan_here(source)
                    return real_rename(source, destination, *args, **kwargs)

                def rmtree(path, *args, **kwargs):
                    if point == "before the deletion":
                        plan_here(path)
                    return real_rmtree(path, *args, **kwargs)
                with patch.object(ops.os, "rename", side_effect=rename), patch.object(ops.shutil, "rmtree", side_effect=rmtree):
                    result = rotation(ws)
                self.assertIn("plan", seen, "the plan ran inside the rotation's deletion")
                self.assertFalse(seen["plan"][0] == 0 and gone(kept_by_six),
                                 "a plan succeeded and the rotation then deleted a set its period keeps")
                self.assertEqual((seen["plan"][0], seen["plan"][1].get("error")), (2, "Refused"), seen["plan"])
                self.assertEqual(seen["before"], seen["after"])
                self.assertEqual((result["deleted"], audit.ledger_years(ws.ledger()["entries"])), ([kept_by_six.name], 2))
                # the turn was only the rotation's: the plan goes through afterwards and nothing is left in the root
                self.assertEqual(ws.cli("plan", ws.root, "--years", 6), (0, {"exit": 0, "plan": 6}))
                self.assertEqual(sorted(path.name for path in ws.root.iterdir() if not path.is_dir()), [audit.LEDGER])

        # a rotation that starts while a plan writes the ledger is refused and deletes nothing; afterwards the new period
        # keeps the set
        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init("--years", 2)
        kept_by_six = daily_set(ws, old)
        daily_set(ws, new)
        real, during = audit.replace_json, {}

        def write(path, body):
            if Path(path).name == audit.LEDGER and "rotation" not in during:
                during["before"] = ws.tree()
                try:
                    during["rotation"] = rotation(ws)
                except Exception as error:
                    during["rotation"] = type(error).__name__
                during["after"] = ws.tree()
            return real(path, body)
        with patch.object(audit, "replace_json", side_effect=write):
            self.assertEqual(ws.cli("plan", ws.root, "--years", 6)[0], 0)
        self.assertEqual(during["rotation"], "Refused")
        self.assertEqual(during["before"], during["after"])
        result = rotation(ws)
        self.assertEqual((result["deleted"], result["retained"].get(kept_by_six.name)), ([], "audit-retention"))
        self.assertTrue(kept_by_six.is_dir())

        # a ledger lock left by a writer that died: rotation refuses, deletes nothing and never removes that lock
        ws = Workspace()
        self.addCleanup(ws.close)
        ws.init("--years", 2)
        expired = daily_set(ws, old)
        daily_set(ws, new)
        (ws.root / audit.LEDGER_LOCK).write_text("a writer that died")
        before = ws.tree()
        with self.assertRaises(audit.Refused):
            rotation(ws)
        self.assertEqual(ws.tree(), before)
        self.assertTrue(expired.is_dir())


TARGET = "kin-syn-target"   # the named database's container in PV-08
LIMIT = 3                   # the time limit given to evaluate in the stall cases (seconds)
GRACE = 15                  # how long after its limit a stopped transfer may take to come back as a failure
PROMPT = 20                 # a failure of one side must come back well before a 60 s limit


if __name__ == "__main__":
    unittest.main(verbosity=2)
