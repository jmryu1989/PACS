"""CD-09-P served: a private draft work's purpose end, its destruction, re-reading and the restore re-application.

REQ: consult-cd09-split-report.md section 5 (unit P) acceptance 1-3 and 5, and the decision S2 of 2026-11-03 (정모 님:
another reader's approval or the parent's cancellation is not an end; a draft is kept until its own author ends it)
-> RISK: an ended draft's text survives, is served again, comes back from an older backup, or another member's act
destroys a draft its author still holds -> TEST: this file (HTTP through the HTTPS proxy and, for responses held open,
straight to the API inside its container; real PostgreSQL; the API's own startup gate and sweep process; the external
ledger file in the API's purpose volume).

Run only through the guarded runner on an operator-owned synthetic stack (KIN_SYNTHETIC_REALM=1 and its Compose
project). LiveStack supplies the accounts and the study; every row read or changed belongs to this file's fixture study
or its synthetic accounts. The restore cases drop and restore the synthetic stack's own `kin` database from a dump taken
in the same case, and the failure cases install a synthetic trigger on this stack's own tables for the length of one
case: never run this against any other stack.

What is asserted is behaviour: HTTP statuses and envelopes, the stored rows, the ledger's lines, the sweep's report and
exit, whether the server opens. A ledger line may carry only the opaque unit and the destruction facts; the test reads
the whole file for the study, author and text. The browser is tests/e2e/test_draft_purpose_screen.py.

CD-09-C (claude-plan-cd-09c.md RC8): DraftPurposeUpgradeServed runs the CD-09-P release's own image (KIN_CD09C_P_IMAGE,
built from 1f8249a by the run) on this stack's volumes to write a format-1 ledger, then this tree's API over it; the
records this tree writes are format 2 (RECORD_FIELDS).
"""
from __future__ import annotations

import json
import os
import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path
import queue
import random
import re
import subprocess
import sys
import threading
import time
import unittest
import uuid
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import LiveStack, ROOT, psql

LEDGER = "/var/lib/kin-purpose/purpose-ledger.jsonl"
# CD-09-C: the record this tree writes (format 2). The P release's format-1 field set is V1_RECORD_FIELDS below.
RECORD_FIELDS = sorted(["formatVersion", "kind", "operationId", "phase", "occurredAt", "day", "disposalUnitId", "classes", "clauseIds",
                        "partCount", "expiryDay", "extensionUsed", "dueDay", "timeliness", "delayReasonStatus", "justifiedDelay",
                        "method", "basis"])
STRUCT_TEMPLATE, STRUCT_REVISION = "GEN-1", 1

# A client inside the API container that keeps responses of the API open: it sends `count` pipelined requests on one
# connection and reads nothing until told to ("read": read everything, report statuses and whether a marker was in the
# bytes; "cut": close the connection unread). Node pauses the socket, so the server's writes back up and the responses
# it has already built stay unfinished - exactly a response that read the draft and is still being delivered.
HOLDING_CLIENT = r"""
const net = require('net');
const [method, path, token, body, count, marker] = process.argv.slice(1);
const n = Number(count);
const socket = net.connect(3000, '127.0.0.1', () => {
  let text = '';
  for (let i = 0; i < n; i++) {
    text += method + ' ' + path + ' HTTP/1.1\r\nHost: api\r\nAccept: application/json\r\nAuthorization: Bearer ' + token + '\r\n';
    text += body ? 'Content-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body : '\r\n';
  }
  socket.write(text);
  socket.pause();
  console.log('SENT');
});
socket.pause();
let chunks = [], quiet = null;
function finish() {
  const all = Buffer.concat(chunks).toString('latin1');
  const statuses = [...all.matchAll(/HTTP\/1\.1 (\d{3})/g)].map(m => Number(m[1]));
  console.log(JSON.stringify({ bytes: all.length, statuses, marker: all.includes(marker) }));
  socket.destroy(); process.exit(0);
}
process.stdin.on('data', data => {
  const command = String(data).trim();
  if (command === 'cut') { socket.destroy(); console.log(JSON.stringify({ cut: true })); process.exit(0); }
  if (command === 'read') {
    socket.on('data', chunk => { chunks.push(chunk); clearTimeout(quiet); quiet = setTimeout(finish, 3000); });
    socket.on('end', finish);
    socket.resume();
    quiet = setTimeout(finish, 15000);
  }
});
"""

# One request whose answer is never read: written, then the connection is destroyed at once.
LOST_ANSWER_CLIENT = r"""
const net = require('net');
const [method, path, token, body] = process.argv.slice(1);
const socket = net.connect(3000, '127.0.0.1', () => {
  socket.write(method + ' ' + path + ' HTTP/1.1\r\nHost: api\r\nAccept: application/json\r\nAuthorization: Bearer ' + token +
    '\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body, () => {
      socket.destroy(); console.log('LOST'); process.exit(0);
    });
});
"""


def event(stage, **result):
    print("CD09P " + json.dumps({"stage": stage, **result}, ensure_ascii=True), flush=True)


def _checked(result, what, check=True):
    if check and result.returncode:
        raise RuntimeError("compose " + what + " failed: " + result.stdout.decode(errors="replace")[-1500:]
                           + result.stderr.decode(errors="replace")[-1500:])
    return result


# Each Compose verb is literal at its call (the guarded runner's inherited project selection, tests/execution_guard_test.py TG-02).
def compose_exec(*args, timeout=300, check=True, stdin=None):
    return _checked(subprocess.run(["docker", "compose", "exec", *args], cwd=ROOT, capture_output=True, timeout=timeout,
                                   input=stdin), "exec " + " ".join(args[:3]), check)


def compose_exec_open(*args):
    """A long-lived exec whose stdin the case writes to (a psql transaction held open, a client holding responses)."""
    return subprocess.Popen(["docker", "compose", "exec", "-T", *args], cwd=ROOT, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")


def compose_stop_api():
    return _checked(subprocess.run(["docker", "compose", "stop", "api"], cwd=ROOT, capture_output=True, timeout=120), "stop api")


def compose_start_api():
    return _checked(subprocess.run(["docker", "compose", "start", "api"], cwd=ROOT, capture_output=True, timeout=120), "start api")


def compose_restart_api():
    return _checked(subprocess.run(["docker", "compose", "restart", "api"], cwd=ROOT, capture_output=True, timeout=300), "restart api")


def compose_migrate():
    """The stack's own reviewed migration step (the installer credential's one-shot service), as a deployment runs it."""
    return _checked(subprocess.run(["docker", "compose", "run", "--rm", "--no-deps", "api-migrate"], cwd=ROOT,
                                   capture_output=True, timeout=600), "run api-migrate")


def compose_api_logs(since):
    return subprocess.run(["docker", "compose", "logs", "--no-color", "--since", since, "api"], cwd=ROOT, capture_output=True,
                          timeout=120).stdout.decode(errors="replace")


def compose_db_logs(since):
    return subprocess.run(["docker", "compose", "logs", "--no-color", "--since", since, "db"], cwd=ROOT, capture_output=True,
                          timeout=120).stdout.decode(errors="replace")


def compose_run_api_open(script):
    """A one-off process of the API service while the API itself is stopped: the same service definition, so the same
    purpose-ledger volume, runtime credential and mounted source; --no-deps, so no migration runs. The development image
    has no dist in a new container: it builds first (to stderr, keeping stdout's last line the command's JSON)."""
    return subprocess.Popen(["docker", "compose", "run", "--rm", "--no-deps", "-T", "api", "sh", "-c", script], cwd=ROOT,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def compose_run_api(script, timeout=600):
    process = compose_run_api_open(script)
    out, err = process.communicate(timeout=timeout)
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def started_of(record, unit):
    """A started record of another unit made from a valid one: in format 2 a new attempt has its own operation (one
    reused from another attempt is a different refusal, PurposeLedgerRecordInvalid)."""
    started = dict(record, phase="started", disposalUnitId=unit)
    if record.get("formatVersion") == 2:
        started["operationId"] = str(uuid.uuid4())
    return started


class HeldTransaction:
    """A psql session of this stack's database kept inside one transaction until the case ends it."""

    def __init__(self, tag):
        self.tag = tag
        self.process = compose_exec_open("db", "psql", "-U", "kin", "-d", "kin", "-v", "ON_ERROR_STOP=1", "-qAt")

    def send(self, sql):
        self.process.stdin.write(sql + "\n")
        self.process.stdin.flush()

    def wait_idle_in_transaction(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if psql("SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction' AND query LIKE "
                    + sql_text("%" + self.tag + "%"))[0] != "0":
                return
            time.sleep(0.2)
        raise AssertionError("the held transaction did not start: " + self.tag)

    def end(self, verb="COMMIT"):
        # communicate() flushes and closes stdin itself: the closing statement goes as its input.
        out, err = self.process.communicate(input=verb + ";\n" if self.process.poll() is None else None, timeout=60)
        return self.process.returncode, out, err


class Session:
    """r3: one psql session of this stack's database that stays open; each statement's answer is read back up to a
    marker line, with a finite wait. Used for the key holder K, the lock session L and the observer O (a polling
    connection: one `docker compose exec` per poll would be too slow to see a 3-second lock wait)."""

    def __init__(self, tag):
        self.tag = tag
        self.process = compose_exec_open("db", "psql", "-U", "kin", "-d", "kin", "-qAt")
        self.lines = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self.pending = None
        self.pid = int(self.query("SELECT pg_backend_pid()")[0])

    def _pump(self):
        for line in self.process.stdout:
            self.lines.put(line.rstrip("\n"))
        self.lines.put(None)

    def _send(self, sql):
        marker = "END-" + uuid.uuid4().hex
        self.process.stdin.write(sql.rstrip().rstrip(";") + ";\nSELECT '" + marker + "';\n")
        self.process.stdin.flush()
        return marker

    def _until(self, marker, timeout):
        out, deadline = [], time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"session {self.tag}: no answer within {timeout}s")
            try:
                line = self.lines.get(timeout=remaining)
            except queue.Empty:
                raise AssertionError(f"session {self.tag}: no answer within {timeout}s") from None
            if line is None:
                raise AssertionError(f"session {self.tag} ended")
            if line == marker:
                return out
            out.append(line)

    def query(self, sql, timeout=30):
        return self._until(self._send(sql), timeout)

    def start(self, sql):
        """A statement expected to wait (a lock request); its answer is collected by `answered`."""
        self.pending = self._send(sql)

    def answered(self, timeout):
        marker, self.pending = self.pending, None
        return self._until(marker, timeout)

    def close(self):
        try:
            self.process.stdin.write("ROLLBACK;\n\\q\n")
            self.process.stdin.flush()
        except (OSError, ValueError):
            pass
        try:
            self.process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.process.kill()


class DraftPurposeServed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("KIN_SYNTHETIC_REALM") != "1" or not os.environ.get("COMPOSE_PROJECT_NAME"):
            raise RuntimeError("NOT_RUN_ENV: operator-owned synthetic realm and Compose project required")
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()

    def setUp(self):
        self.fixture = self.stack.create_fixture()
        self.uid = self.fixture.uid
        self.addCleanup(self.drop_ended_rows)

    def drop_ended_rows(self):
        # Ended rows (held or refused cases) of this fixture study only; the study's own cleanup removes the drafts.
        psql(f'DELETE FROM "ReportDraftPurposeEnd" WHERE uid={sql_text(self.uid)}')

    # ── product calls (a commit is a POST: 201 Created; the draft routes answer 200) ──

    def path(self, tail=""):
        return f"/studies/{quote(self.uid)}" + tail

    def save(self, user, text, *, revision=None, base=0, extra=None):
        body = {"findings": text, "conclusion": "SYN conclusion", "recommendation": "", "baseVersion": base,
                "citationIds": [], "structureIds": [], **(extra or {})}
        if revision is not None:
            body.update(expectedOwner=self.owner(user), expectedRevision=revision)
        return self.stack.request("PUT", self.path("/report"), user, body)

    def apply_structure(self, user, findings, conclusion_value, keep=None):
        """One structured entry the reader typed (CONCLUSION of the shipped template), written with the text it renders."""
        line = "Conclusion: " + conclusion_value
        body = {"findings": findings, "conclusion": line, "recommendation": "", "baseVersion": 0,
                "structure": {"op": "apply", "field": "conclusion", "templateId": STRUCT_TEMPLATE,
                              "templateRevision": STRUCT_REVISION, "itemCode": "CONCLUSION", "valueType": "text",
                              "value": conclusion_value, "renderedText": line}}
        if keep is not None:
            body["structureIds"] = keep
        result = self.stack.request("PUT", self.path("/report"), user, body)
        self.assertEqual(result.status, 200, result.text)
        return result.body["applied"]["sid"]

    def commit(self, user, action, base, text="", reason=None):
        body = {"action": action, "baseVersion": base, "findings": text, "conclusion": "SYN conclusion" if text else "",
                "recommendation": ""}
        if reason:
            body["reason"] = reason
        result = self.stack.request("POST", self.path("/report/commit"), user, body)
        self.assertEqual(result.status, 201, result.text)
        return result.body

    def discard(self, user, revision=None):
        body = {} if revision is None else {"expectedOwner": self.owner(user), "expectedRevision": revision}
        return self.stack.request("DELETE", self.path("/draft"), user, body)

    def read(self, user):
        result = self.stack.request("GET", self.path("/draft"), user)
        self.assertEqual(result.status, 200, result.text)
        return result.body

    def owner(self, user):
        me = self.stack.request("GET", "/me", user).body
        return {"institution": me["institution"], "sub": me["sub"], "author": me["actor"]}

    # ── stored facts ──

    def row(self, user):
        actor = self.stack.actor(user)
        lines = psql('SELECT row_to_json(d)::text FROM (SELECT present, findings, conclusion, revision, "workUnit", "workIntent", '
                     f'structured FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND author={sql_text(actor)}) d')
        return json.loads(lines[0]) if lines else None

    def ended(self, unit):
        lines = psql('SELECT row_to_json(e)::text FROM (SELECT trigger, findings, structured, "lastRefusal", "deliverySettled", '
                     f'attempts FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId"={sql_text(unit)}) e')
        return json.loads(lines[0]) if lines else None

    def ledger_bytes(self):
        result = compose_exec("-T", "api", "sh", "-c", f"if [ -f {LEDGER} ]; then cat {LEDGER}; fi")
        return result.stdout

    def ledger(self):
        text = self.ledger_bytes().decode()
        lines = [json.loads(line) for line in text.splitlines()]
        return lines[0] if lines else None, lines[1:]

    def phases(self, unit):
        return [entry["record"]["phase"] for entry in self.ledger()[1] if entry["record"]["disposalUnitId"] == unit]

    def wait_destroyed(self, unit, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ended(unit) is None and "completed" in self.phases(unit):
                return
            time.sleep(0.5)
        self.fail(f"unit not destroyed within {timeout}s: phases={self.phases(unit)} row={self.ended(unit)}")

    def wait_refusal(self, unit, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and (self.ended(unit) or {}).get("lastRefusal") is None:
            time.sleep(0.5)
        return self.ended(unit)

    def assert_ledger_names_nothing(self, *secrets):
        text = self.ledger_bytes().decode()
        for secret in secrets:
            self.assertNotIn(secret, text, "the operational ledger carries a record identifier or text")
        header, entries = self.ledger()
        for entry in entries:
            self.assertEqual(sorted(entry["record"]), V1_RECORD_FIELDS if entry["record"].get("formatVersion") == 1 else RECORD_FIELDS)

    def sweep(self, *env):
        result = compose_exec("-T", "api", "env", *env, "node", "dist/emr-retention/draft-purpose-sweep.js", check=False)
        out = result.stdout.decode(errors="replace").strip().splitlines()
        return result.returncode, json.loads(out[-1]) if out else None

    def access_entries(self):
        return int(psql("SELECT count(*) FROM emr_access.access_entry")[0])

    def anchor(self):
        return json.loads(psql('SELECT row_to_json(a)::text FROM "PurposeLedgerAnchor" a WHERE id=1')[0])

    def hold_open(self, user, method, path, count, marker, body=None):
        client = compose_exec_open("api", "node", "-e", HOLDING_CLIENT, method, "/api" + path, self.stack.token(user),
                                   json.dumps(body) if body is not None else "", str(count), marker)
        self.assertEqual(client.stdout.readline().strip(), "SENT", client.stderr.read() if client.poll() is not None else "")
        return client

    def release_held(self, client, command):
        client.stdin.write(command + "\n")
        client.stdin.flush()
        line = client.stdout.readline().strip()
        client.communicate(timeout=60)
        return json.loads(line)

    # ── A1/A2: the author's discard ──

    def test_p01_discard_destroys_exactly_the_authors_work_and_keeps_everything_else(self):
        doctor, other = "doctor", "doctor2"
        secret, kept = "SYN-P1 private " + uuid.uuid4().hex, "SYN-P1 colleague " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        self.assertEqual(self.save(other, kept).status, 200)
        mine = self.row(doctor)
        self.assertTrue(mine["present"])
        self.assertRegex(mine["workUnit"], r"^disposal:[0-9a-f-]{36}$")
        self.assertTrue(self.anchor()["initialized"], "the ledger exists before the first work is handed out")
        before_access = self.access_entries()
        # Save again: the same work continues (one unit for one work).
        again = self.save(doctor, secret + " more")
        self.assertEqual(again.status, 200)
        self.assertEqual(self.row(doctor)["workUnit"], mine["workUnit"])
        stale = self.read(doctor)["revision"]
        discarded = self.discard(doctor)
        self.assertEqual(discarded.status, 200, discarded.text)
        self.assertFalse(discarded.body["present"])
        unit = mine["workUnit"]
        self.wait_destroyed(unit)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        row = self.row(doctor)
        self.assertEqual((row["present"], row["findings"], row["workUnit"]), (False, "", None))
        self.assertGreater(row["revision"], mine["revision"] + 1)
        self.assertEqual(self.ended(unit), None)
        # Re-read: no content, the empty boundary only.
        envelope = self.read(doctor)
        self.assertEqual((envelope["present"], envelope["snapshot"]), (False, None))
        # The colleague's work, the access records and the ledger's privacy all hold.
        self.assertEqual((self.row(other)["present"], self.row(other)["findings"]), (True, kept))
        self.assertGreaterEqual(self.access_entries(), before_access)
        self.assert_ledger_names_nothing(self.uid, self.stack.actor(doctor), secret)
        # A request of the ended work (its old revision) cannot write it back.
        late = self.save(doctor, secret, revision=stale)
        self.assertEqual(late.status, 409, late.text)
        self.assertEqual(self.row(doctor)["findings"], "")
        # The author can start a new work explicitly; it has its own unit.
        fresh = self.save(doctor, "SYN-P1 new work")
        self.assertEqual(fresh.status, 200, fresh.text)
        self.assertNotEqual(self.row(doctor)["workUnit"], unit)
        event("p01", unit_destroyed=True, late_write=late.status)

    def test_p02_clear_and_own_reset_end_the_work_but_save_and_forced_release_do_not(self):
        doctor, admin = "doctor", "jmryu"
        # Clear: every field emptied by the author.
        self.assertEqual(self.save(doctor, "SYN-P2 clear").status, 200)
        unit = self.row(doctor)["workUnit"]
        cleared = self.stack.request("PUT", self.path("/report"), doctor,
                                     {"findings": "", "conclusion": "", "recommendation": "", "baseVersion": 0})
        self.assertEqual(cleared.status, 200, cleared.text)
        self.wait_destroyed(unit)
        # Save (an unsigned version): the text lives on in the report version; no purpose end is recorded.
        self.assertEqual(self.save(doctor, "SYN-P2 saved").status, 200)
        unit = self.row(doctor)["workUnit"]
        self.commit(doctor, "save", 0, "SYN-P2 saved")
        self.assertEqual(self.phases(unit), [])
        self.assertIsNone(self.ended(unit))
        self.assertEqual(psql(f'SELECT findings FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND action=\'save\''), ["SYN-P2 saved"])
        # Forced release by the administrator keeps the text as a discarded version: no purpose end.
        self.assertEqual(self.save(doctor, "SYN-P2 forced", base=1).status, 200)
        unit = self.row(doctor)["workUnit"]
        forced = self.stack.request("DELETE", self.path("/draft/force"), admin, {})
        self.assertEqual(forced.status, 200, forced.text)
        self.assertEqual(self.phases(unit), [])
        self.assertEqual(psql(f'SELECT count(*) FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND action=\'discarded\' '
                              f'AND findings=\'SYN-P2 forced\''), ["1"])
        # The author's own Reset keeps nothing of the draft: an explicit discard.
        self.assertEqual(self.save(doctor, "SYN-P2 reset draft", base=1).status, 200)
        unit = self.row(doctor)["workUnit"]
        self.commit(doctor, "reset", 1, reason="SYN reset")
        self.wait_destroyed(unit)
        event("p02", clear=True, save_kept=True, forced_kept=True, reset=True)

    def test_p03_signed_results_end_only_their_authors_work_and_another_members_acts_end_none(self):
        """S2: another reader's approval, the parent's cancellation and an earlier approval end no one's draft; the
        author's own signed approval or Addendum ends exactly the author's work."""
        doctor, other = "doctor", "doctor2"
        colleague = "SYN-P3 colleague " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, "SYN-P3 to sign").status, 200)
        self.assertEqual(self.save(other, colleague).status, 200)
        unit, kept_unit = self.row(doctor)["workUnit"], self.row(other)["workUnit"]
        approved = self.commit(doctor, "approve", 0, "SYN-P3 to sign")
        self.wait_destroyed(unit)
        self.assertEqual(psql(f'SELECT action FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND findings=\'SYN-P3 to sign\''),
                         ["approve"])
        # Another member's approval: the colleague's draft is kept, and its author sees it as written.
        envelope = self.read(other)
        self.assertEqual((envelope["present"], envelope["snapshot"]["findings"]), (True, colleague))
        self.assertEqual((self.row(other)["workUnit"], self.phases(kept_unit), self.ended(kept_unit)), (kept_unit, [], None))
        # The colleague keeps writing the same work, now toward an Addendum of the approved report.
        version = approved["version"]
        self.assertEqual(self.save(other, colleague + " addendum", base=version).status, 200)
        self.assertEqual((self.row(other)["workUnit"], self.row(other)["workIntent"]), (kept_unit, "addendum"))
        # The parent's cancellation (the signer's Reset with a reason) is not an end of the colleague's draft either.
        reset = self.commit(doctor, "reset", version, reason="SYN-P3 parent cancelled")
        envelope = self.read(other)
        self.assertEqual((envelope["present"], envelope["snapshot"]["findings"]), (True, colleague + " addendum"))
        self.assertEqual(self.phases(kept_unit), [])
        # The colleague's own signed approval ends the colleague's work.
        signed = self.commit(other, "approve", reset["version"], colleague + " signed")
        self.wait_destroyed(kept_unit)
        # A work started after that approval (an Addendum draft) is not ended by the earlier approval; its own signed
        # Addendum ends it, and the version it signed is the Addendum.
        addendum = "SYN-P3 addendum " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, addendum, base=signed["version"]).status, 200)
        late_unit = self.row(doctor)["workUnit"]
        self.assertEqual((self.row(doctor)["workIntent"], self.phases(late_unit)), ("addendum", []))
        self.commit(doctor, "addendum", signed["version"], addendum)
        self.wait_destroyed(late_unit)
        self.assertEqual(psql(f'SELECT action FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND findings={sql_text(addendum)}'),
                         ["addendum"])
        event("p03", signed_destroyed=True, colleague_kept_after_approval=True, colleague_kept_after_cancel=True,
              addendum_destroyed=True)

    # ── A3: overlap, retry and failure recovery ──

    def test_p04_save_and_discard_overlap_one_wins_and_the_loser_changes_nothing(self):
        doctor = "doctor"
        outcomes = []
        for attempt in range(8):
            self.assertEqual(self.save(doctor, f"SYN-P4 base {attempt}").status, 200)
            unit, revision = self.row(doctor)["workUnit"], self.read(doctor)["revision"]
            owner = self.owner(doctor)
            results = {}
            body_save = {"findings": f"SYN-P4 late {attempt}", "conclusion": "", "recommendation": "", "baseVersion": 0,
                         "citationIds": [], "structureIds": [], "expectedOwner": owner, "expectedRevision": revision}
            body_discard = {"expectedOwner": owner, "expectedRevision": revision}
            go = threading.Barrier(2)

            def run(name, method, path, body):
                go.wait()
                results[name] = self.stack._send(method, path, doctor, body)
            threads = [threading.Thread(target=run, args=("save", "PUT", self.path("/report"), body_save)),
                       threading.Thread(target=run, args=("discard", "DELETE", self.path("/draft"), body_discard))]
            for thread in threads: thread.start()
            for thread in threads: thread.join(60)
            statuses = (results["save"].status, results["discard"].status)
            self.assertIn(statuses, [(200, 409), (409, 200)], f"exactly one of the same-boundary writes wins: {statuses}")
            row = self.row(doctor)
            if statuses == (409, 200):
                self.wait_destroyed(unit)
                self.assertEqual((row["present"], row["findings"]), (False, ""))
            else:
                self.assertEqual((row["present"], row["findings"]), (True, f"SYN-P4 late {attempt}"))
                self.assertEqual(self.phases(unit), [])
                self.assertEqual(self.discard(doctor).status, 200)
                self.wait_destroyed(unit)
            outcomes.append(statuses)
        event("p04", outcomes=outcomes)

    def test_p05_a_lost_answer_is_re_read_and_retried_and_the_work_ends_once(self):
        doctor = "doctor"
        # Concurrent retries of one discard: one wins, the others meet the moved boundary.
        self.assertEqual(self.save(doctor, "SYN-P5 retry").status, 200)
        unit, revision = self.row(doctor)["workUnit"], self.read(doctor)["revision"]
        owner, results = self.owner(doctor), []
        go = threading.Barrier(3)

        def run():
            go.wait()
            results.append(self.stack._send("DELETE", self.path("/draft"), doctor, {"expectedOwner": owner, "expectedRevision": revision}).status)
        threads = [threading.Thread(target=run) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(60)
        self.assertEqual(sorted(results), [200, 409, 409])
        self.wait_destroyed(unit)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        # A discard whose answer is really lost: the client closes its connection right after sending it.
        self.assertEqual(self.save(doctor, "SYN-P5 lost").status, 200)
        unit, revision = self.row(doctor)["workUnit"], self.read(doctor)["revision"]
        body = json.dumps({"expectedOwner": owner, "expectedRevision": revision})
        lost = compose_exec("-T", "api", "node", "-e", LOST_ANSWER_CLIENT, "DELETE", "/api" + self.path("/draft"),
                            self.stack.token(doctor), body)
        self.assertIn(b"LOST", lost.stdout)
        # The client re-reads what is stored. Either the discard committed (the empty boundary, destroyed once) or it
        # did not (the draft as it was); a retry with the revision it held then either meets the moved boundary or ends
        # the work - never a second end, never a new draft.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and self.read(doctor)["present"] and self.ended(unit) is None and not self.phases(unit):
            time.sleep(0.5)
        envelope = self.read(doctor)
        retry = self.stack._send("DELETE", self.path("/draft"), doctor, {"expectedOwner": owner, "expectedRevision": revision})
        if envelope["present"]:
            self.assertEqual(retry.status, 200, retry.text)
        else:
            self.assertEqual((envelope["snapshot"], retry.status), (None, 409))
        self.wait_destroyed(unit)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        self.assertEqual(self.read(doctor)["present"], False)
        event("p05", retries=sorted(results), lost_answer_committed=not envelope["present"], retry=retry.status)
        # C8(i), T3: the answer is held unread while the end commits; the commit is observed in the database first, and
        # only then is the connection cut. The client never heard the answer: it re-reads, retries with the revision it
        # held and meets the moved boundary; the unit is ended and destroyed exactly once.
        self.assertEqual(self.save(doctor, "SYN-P5 committed " + uuid.uuid4().hex).status, 200)
        before = self.row(doctor)
        unit, revision = before["workUnit"], self.read(doctor)["revision"]
        client = self.hold_open(doctor, "DELETE", self.path("/draft"), 1, "SYN-P5",
                                body={"expectedOwner": owner, "expectedRevision": revision})
        try:
            deadline, stored = time.monotonic() + 30, before
            while time.monotonic() < deadline:
                stored = self.row(doctor)
                if not stored["present"] and stored["revision"] > before["revision"]:
                    break
                time.sleep(0.2)
            committed = not stored["present"] and stored["revision"] > before["revision"]
            ended_row, phases_at_cut = self.ended(unit), self.phases(unit)
            self.assertTrue(committed, f"the end was not observed committed before the cut: {stored}")
            self.assertTrue(ended_row is not None or "started" in phases_at_cut, (ended_row, phases_at_cut))
        finally:
            cut = self.release_held(client, "cut")
        self.assertEqual(cut, {"cut": True})
        envelope = self.read(doctor)
        self.assertEqual((envelope["present"], envelope["snapshot"]), (False, None))
        self.assertNotEqual(envelope["revision"], revision)
        retry = self.stack._send("DELETE", self.path("/draft"), doctor, {"expectedOwner": owner, "expectedRevision": revision})
        self.assertEqual(retry.status, 409, retry.text)
        self.wait_destroyed(unit)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        self.assertIsNone(self.ended(unit))
        self.assertEqual(psql(f'SELECT count(*) FROM "ReportDraft" WHERE "workUnit"={sql_text(unit)}'), ["0"])
        self.assertEqual(self.read(doctor)["present"], False)
        event("p05", branch="t3", lost_answer_committed=committed, observed_before_cut={
            "present": stored["present"], "revision_moved": stored["revision"] - before["revision"],
            "ended_row": ended_row is not None, "phases": phases_at_cut}, retry=retry.status, phases=self.phases(unit))

    def test_p06_reads_overlapping_the_discard_never_return_the_text_after_the_end(self):
        doctor, secret = "doctor", "SYN-P6 " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit, stop, after_end, seen = self.row(doctor)["workUnit"], threading.Event(), threading.Event(), []

        def reader():
            while not stop.is_set():
                started_after = after_end.is_set()
                result = self.stack._send("GET", self.path("/draft"), doctor, None)
                if result.status == 200:
                    seen.append((started_after, bool(result.body.get("present"))))
        threads = [threading.Thread(target=reader) for _ in range(3)]
        for thread in threads: thread.start()
        time.sleep(1)
        self.assertEqual(self.discard(doctor).status, 200)
        after_end.set()
        self.wait_destroyed(unit)
        time.sleep(1)
        stop.set()
        for thread in threads: thread.join(60)
        self.assertTrue(any(not started for started, _ in seen))
        self.assertFalse([1 for started, present in seen if started and present], "a read begun after the end returned the draft")
        event("p06", reads=len(seen))

    def place_hold(self, record):
        at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        hold_id = "syn-cd09p-" + uuid.uuid4().hex
        hold = {"holdId": hold_id, "recordId": record, "actorId": "syn-custodian", "at": at, "release": None,
                "basis": {"type": "court-order", "clause": {"law": "synthetic-law", "article": "article-1", "version": "2026-v1"},
                          "clauseId": "synthetic-law:article-1", "authorityKind": "court", "managingInstitutionId": "hallym",
                          "requestId": "syn-request", "authorityId": "syn-court", "scope": [record], "verified": True,
                          "validity": {"from": at, "until": None, "condition": "order-in-force"}}}
        psql("INSERT INTO emr_access.clause_version SELECT 'synthetic-law:article-1','2026-v1','synthetic-law','article-1',"
             "'2026-01-01','2026-01-01',now() WHERE NOT EXISTS (SELECT 1 FROM emr_access.clause_version "
             "WHERE clause_id='synthetic-law:article-1')")
        return hold

    def release_hold(self, hold):
        released_at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 1))
        time.sleep(1.5)
        released = {**hold, "release": {"holdId": hold["holdId"], "actorId": "syn-custodian", "at": released_at,
                                        "evidenceId": "syn-ending", "authorityVerified": True, "reason": "order-ended"}}
        psql(f"SELECT emr_access.release_hold({sql_text(hold['holdId'])}, {sql_text(json.dumps(released))})::text")

    def test_p07_a_hold_keeps_the_whole_payload_until_its_release_then_the_sweep_destroys_it(self):
        doctor, other = "doctor", "doctor2"
        secret, value = "SYN-P7 held " + uuid.uuid4().hex, "SYN-P7 structured " + uuid.uuid4().hex
        # The work carries text and a structured entry (a non-empty JSONB payload); the colleague has one too.
        self.apply_structure(doctor, secret, value)
        colleague_value = "SYN-P7 colleague " + uuid.uuid4().hex
        self.apply_structure(other, "SYN-P7 colleague text", colleague_value)
        self.assertIn(value, json.dumps(self.row(doctor)["structured"]))
        unit = self.row(doctor)["workUnit"]
        record = json.dumps([self.uid, self.stack.actor(doctor)], separators=(",", ":"))
        # A hold binds this work only from its own placement on (never before the work started): place it a second later.
        time.sleep(1.1)
        hold = self.place_hold(record)
        psql(f"SELECT emr_access.place_hold({sql_text(hold['holdId'])}, {sql_text(record)}, {sql_text(json.dumps(hold))})::text")
        self.assertEqual(self.discard(doctor).status, 200)
        held = self.wait_refusal(unit)
        self.assertEqual((held["findings"], held["lastRefusal"]), (secret, "LegalHoldActive"))
        self.assertIn(value, json.dumps(held["structured"]), "the held payload is the whole work, structured entries included")
        self.assertEqual(self.phases(unit), [], "nothing recorded while the hold is live")
        # The author's view is the empty boundary; the held payload is not served.
        self.assertEqual(self.read(doctor)["present"], False)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIn({"unit": unit, "outcome": "held", "code": "LegalHoldActive"}, report["results"])
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIn(unit, [r["unit"] for r in report["results"] if r["outcome"] == "destroyed"])
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.phases(unit), ["started", "completed"])
        # Nothing of the work is left in any draft-side row; the colleague's structured entry is as it was.
        for table in ("ReportDraft", "ReportDraftPurposeEnd"):
            self.assertEqual(psql(f'SELECT count(*) FROM "{table}" WHERE structured::text LIKE {sql_text("%" + value + "%")} '
                                  f'OR findings LIKE {sql_text("%" + secret + "%")}'), ["0"], table)
        self.assertIsNone(self.row(doctor)["structured"])
        structure = self.stack.request("GET", self.path("/report/structure"), other)
        self.assertEqual(structure.status, 200, structure.text)
        self.assertIn(colleague_value, json.dumps(structure.body["draft"]))
        self.assert_ledger_names_nothing(value, secret)
        event("p07", held=True, structured_held=True, released_then_destroyed=True)

    def test_p08_a_ledger_failure_keeps_the_payload_pending_and_the_sweep_resumes_exactly(self):
        doctor, secret = "doctor", "SYN-P8 " + uuid.uuid4().hex
        # A first destruction so that the ledger exists.
        self.assertEqual(self.save(doctor, "SYN-P8 first").status, 200)
        first = self.row(doctor)["workUnit"]
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(first)
        original = self.ledger_bytes()
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        try:
            compose_exec("-T", "api", "sh", "-c", f"printf '%s' '{{\"kind\":\"entry\"' >> {LEDGER}")
            self.assertEqual(self.discard(doctor).status, 200, "the end itself does not depend on the ledger")
            pending = self.wait_refusal(unit)
            self.assertEqual((pending["findings"], pending["lastRefusal"]), (secret, "PurposeLedgerPartialTail"))
            code, report = self.sweep()
            self.assertEqual(code, 1, "an unreadable ledger is a failed sweep, never a success")
        finally:
            compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=original)
        self.assertEqual(self.ledger_bytes(), original)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("p08", failure_kept_pending=True, resumed=True)

    # ── F1/F5/F7: a response that already read the draft, held open; the sweep's honest pending ──

    def test_p10_a_destruction_waits_for_every_open_response_that_read_the_draft(self):
        doctor = "doctor"
        # Big enough that the paused connection backs up: each answer carries this text.
        secret = "SYN-P10 " + uuid.uuid4().hex + " " + "x" * 90000
        marker = secret[:40]
        # The PATCH is a real study-state change whose answer carries the caller's draft: its author must be allowed to
        # change a technician field and to write a draft (jmryu: radiologist and technician of the fixture's institution).
        cases = [(doctor, "GET", self.path("/draft"), None, "read"), ("jmryu", "PATCH", self.path(), {"ward": "SYN-P10 ward"}, "cut"),
                 (doctor, "GET", self.path("/draft"), None, "cut")]
        for user, method, path, body, ending in cases:
            self.assertEqual(self.save(user, secret).status, 200)
            unit = self.row(user)["workUnit"]
            probe = self.stack.request(method, path, user, body)
            self.assertEqual(probe.status, 200, probe.text)
            self.assertIn(marker, probe.text, "the answer of this route carries the caller's draft")
            client = self.hold_open(user, method, path, 40, marker, body)
            try:
                time.sleep(3)   # the handlers run, read the draft and build their answers; the connection holds them
                self.assertEqual(self.discard(user).status, 200)
                time.sleep(5)
                pending = self.ended(unit)
                self.assertIsNotNone(pending, f"{method} {path}: destroyed while a response that read the draft was open")
                self.assertEqual((pending["deliverySettled"], self.phases(unit)), (False, []))
            finally:
                outcome = self.release_held(client, ending)
            if ending == "read":
                self.assertTrue(outcome["marker"], "the held answers carried the draft read before the end")
                # A request the server could not take within its wait answers 503 without any draft; none is another error.
                self.assertTrue(200 in outcome["statuses"] and set(outcome["statuses"]) <= {200, 503}, outcome["statuses"])
            self.wait_destroyed(unit)
            event("p10", route=method + " " + path.rsplit("/", 1)[-1], ending=ending)

    def test_p17_the_sweep_run_reports_an_unsettled_delivery_and_the_server_retries_a_failed_settle(self):
        doctor = "doctor"
        secret = "SYN-P17 " + uuid.uuid4().hex + " " + "x" * 90000
        marker = secret[:40]
        # F5: while the server is still sending a response that read the draft, the sweep run cannot settle that work:
        # it reports it delivery-pending and does not count the run as complete.
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        client = self.hold_open(doctor, "GET", self.path("/draft"), 40, marker)
        try:
            time.sleep(3)
            self.assertEqual(self.discard(doctor).status, 200)
            time.sleep(2)
            code, report = self.sweep()
            self.assertEqual(code, 1, report)
            self.assertFalse(report["complete"])
            self.assertIn({"unit": unit, "outcome": "delivery-pending"}, report["results"])
            self.assertEqual(self.ended(unit)["findings"], secret)
        finally:
            self.release_held(client, "cut")
        self.wait_destroyed(unit)
        event("p17", sweep_reported_pending=True)
        # F5: the settle step fails once (its database connection is cut while it waits on a row lock); the server
        # retries it and the work is destroyed without a restart or a sweep.
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        client = self.hold_open(doctor, "GET", self.path("/draft"), 40, marker)
        lock = None
        try:
            time.sleep(3)
            self.assertEqual(self.discard(doctor).status, 200)
            lock = HeldTransaction("cd09p-settle-" + uuid.uuid4().hex[:8])
            lock.send(f"BEGIN; SELECT 1 /* {lock.tag} */ FROM \"ReportDraftPurposeEnd\" WHERE \"disposalUnitId\"={sql_text(unit)} FOR UPDATE;")
            lock.wait_idle_in_transaction()
            self.release_held(client, "cut")
            client = None
            deadline, victim = time.monotonic() + 30, []
            while time.monotonic() < deadline and not victim:
                victim = psql("SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE "
                              "'UPDATE \"ReportDraftPurposeEnd\" SET \"deliverySettled\"%'")
                time.sleep(0.3)
            self.assertTrue(victim, "the server's settle step did not reach the locked row")
            self.assertEqual(psql(f"SELECT pg_terminate_backend({int(victim[0])})"), ["t"])
        finally:
            if client is not None:
                self.release_held(client, "cut")
            if lock is not None:
                lock.end("ROLLBACK")
        self.wait_destroyed(unit, timeout=90)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("p17", settle_failure_retried=True)

    # ── F2: a hold placed while the destruction runs ──

    def test_p11_a_hold_placement_in_flight_is_seen_by_the_destruction(self):
        doctor, secret = "doctor", "SYN-P11 " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        record = json.dumps([self.uid, self.stack.actor(doctor)], separators=(",", ":"))
        time.sleep(1.1)
        hold = self.place_hold(record)
        # A second connection places the hold and has not committed when the work ends.
        placing = HeldTransaction("cd09p-hold-" + uuid.uuid4().hex[:8])
        try:
            placing.send(f"BEGIN; SELECT emr_access.place_hold({sql_text(hold['holdId'])}, {sql_text(record)}, "
                         f"{sql_text(json.dumps(hold))})::text /* {placing.tag} */;")
            placing.wait_idle_in_transaction()
            self.assertEqual(self.discard(doctor).status, 200)
            time.sleep(4)
            waiting = self.ended(unit)
            self.assertIsNotNone(waiting, "destroyed before the hold being placed committed")
            self.assertEqual((waiting["findings"], self.phases(unit)), (secret, []))
        finally:
            code, out, err = placing.end("COMMIT")
        self.assertEqual(code, 0, err)
        held = self.wait_refusal(unit)
        self.assertEqual((held["findings"], held["lastRefusal"], self.phases(unit)), (secret, "LegalHoldActive", []))
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("p11", hold_in_flight_held=True)

    # ── F3/F7: a commit that fails after started, and an end transaction that fails ──

    def failing_commit(self, table, event_name):
        psql("CREATE OR REPLACE FUNCTION public.cd09p_fail_commit() RETURNS trigger LANGUAGE plpgsql AS "
             "$$BEGIN RAISE EXCEPTION 'SYN-CD09P commit failure'; END$$")
        psql(f'CREATE CONSTRAINT TRIGGER cd09p_fail_commit AFTER {event_name} ON "{table}" DEFERRABLE INITIALLY DEFERRED '
             "FOR EACH ROW EXECUTE FUNCTION public.cd09p_fail_commit()")
        self.addCleanup(lambda: psql(f'DROP TRIGGER IF EXISTS cd09p_fail_commit ON "{table}"'))

    def test_p12_a_destruction_whose_commit_fails_is_recorded_failed_and_resumed(self):
        doctor, secret = "doctor", "SYN-P12 " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        seq = self.anchor()["seq"]
        self.failing_commit("PurposeLedgerAnchor", "UPDATE")
        self.assertEqual(self.discard(doctor).status, 200)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and "failed" not in self.phases(unit):
            time.sleep(0.5)
        phases = self.phases(unit)
        self.assertEqual(phases[:2], ["started", "failed"], phases)
        self.assertNotIn("completed", phases, "completed recorded for a deletion that was rolled back")
        kept = self.ended(unit)
        self.assertEqual(kept["findings"], secret)
        self.assertEqual(self.anchor()["seq"], seq)
        psql('DROP TRIGGER cd09p_fail_commit ON "PurposeLedgerAnchor"')
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIsNone(self.ended(unit))
        phases = self.phases(unit)
        self.assertEqual(phases[-2:], ["started", "completed"])
        self.assertEqual(phases.count("completed"), 1)
        self.assertTrue(all(a == "started" and b in ("failed", "completed") for a, b in zip(phases[::2], phases[1::2])), phases)
        event("p12", commit_failure=phases)

    def test_p13_an_end_whose_transaction_fails_leaves_the_work_as_it_was(self):
        doctor, secret = "doctor", "SYN-P13 " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        before = self.row(doctor)
        self.failing_commit("ReportDraftPurposeEnd", "INSERT")
        failed = self.discard(doctor)
        # Not a success: the end did not commit (the server checks its committed row) and says so in Korean.
        self.assertEqual(failed.status, 503, failed.text)
        self.assertRegex(json.dumps(failed.body, ensure_ascii=False), "[가-힣]")
        after = self.row(doctor)
        self.assertEqual((after["present"], after["findings"], after["workUnit"], after["revision"]),
                         (True, secret, before["workUnit"], before["revision"]))
        self.assertEqual((self.ended(before["workUnit"]), self.phases(before["workUnit"])), (None, []))
        psql('DROP TRIGGER cd09p_fail_commit ON "ReportDraftPurposeEnd"')
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(before["workUnit"])
        event("p13", end_rolled_back=failed.status)

    # ── A5: restore re-application and the closed gate ──

    def restart_api(self):
        compose_restart_api()

    def wait_api(self, healthy=True, timeout=240, code=None, since=None):
        """healthy: the API answers ok. Otherwise: the API reports `code` in its log and never answers ok meanwhile."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                health = self.stack.request("GET", "/health")
            except OSError:   # the proxy or the API not accepting connections yet: not open
                health = None
            opened = health is not None and health.status == 200 and isinstance(health.body, dict) and health.body.get("ok")
            if opened:
                if healthy:
                    return
                self.fail("the API opened although its draft ledger could not be matched")
            if not healthy and code and code in compose_api_logs(since):
                return
            time.sleep(2)
        self.fail(f"API {'did not open' if healthy else 'did not report ' + str(code)} within {timeout}s")

    def reload_proxy(self):
        compose_exec("-T", "proxy", "nginx", "-s", "reload", check=False)

    def closed_then_reopened(self, code, damage, repair):
        since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        damage()
        try:
            self.restart_api()
            self.wait_api(healthy=False, code=code, since=since)
            # Closed means closed: still not answering after the refusal was logged.
            time.sleep(3)
            health = self.stack.request("GET", "/health")
            self.assertFalse(health.status == 200 and isinstance(health.body, dict) and health.body.get("ok"), health.text)
        finally:
            repair()
            self.restart_api()
            self.reload_proxy()
            self.wait_api()
        event("gate_closed", code=code)

    def dump(self, name):
        compose_exec("-T", "db", "pg_dump", "-U", "kin", "-d", "kin", "-Fc", "--create", "-f", "/tmp/" + name)

    def restore(self, name):
        compose_exec("-T", "db", "psql", "-U", "kin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE kin WITH (FORCE)")
        compose_exec("-T", "db", "pg_restore", "-U", "kin", "-d", "postgres", "--create", "--exit-on-error", "/tmp/" + name, timeout=600)

    def test_p09_restore_reapplies_the_destruction_and_a_mismatched_ledger_keeps_the_server_closed(self):
        doctor, other = "doctor", "doctor2"
        secret, kept = "SYN-P9 destroyed " + uuid.uuid4().hex, "SYN-P9 colleague " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        self.assertEqual(self.save(other, kept).status, 200)
        unit, colleague = self.row(doctor)["workUnit"], self.row(other)["workUnit"]
        self.dump("cd09p-before.dump")
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(unit)
        ledger_after = self.ledger_bytes()
        header, entries = self.ledger()
        completed_day = [e["record"]["day"] for e in entries if e["record"]["disposalUnitId"] == unit and e["record"]["phase"] == "completed"]
        # The old copy is restored over the live database while the API is stopped; the ledger volume is not touched.
        compose_stop_api()
        try:
            self.restore("cd09p-before.dump")
            restored = psql(f'SELECT findings FROM "ReportDraft" WHERE "workUnit"={sql_text(unit)}')
            self.assertEqual(restored, [secret], "the restored copy holds the destroyed text before the gate")
        finally:
            compose_start_api()
            self.reload_proxy()
        self.wait_api()
        row = self.row(doctor)
        self.assertEqual((row["present"], row["findings"], row["workUnit"]), (False, "", None))
        self.assertEqual(self.read(doctor)["present"], False)
        self.assertEqual((self.row(other)["present"], self.row(other)["findings"], self.row(other)["workUnit"]), (True, kept, colleague))
        self.assertEqual(self.ledger_bytes(), ledger_after, "re-application writes no new record and no new five-day clock")
        self.assertEqual([e["record"]["day"] for e in self.ledger()[1] if e["record"]["disposalUnitId"] == unit and e["record"]["phase"] == "completed"],
                         completed_day)
        # A second re-application (restart) changes nothing; a new work started now survives it.
        self.assertEqual(self.save(doctor, "SYN-P9 after restore").status, 200)
        fresh = self.row(doctor)["workUnit"]
        self.restart_api(); self.reload_proxy(); self.wait_api()
        self.assertEqual((self.row(doctor)["findings"], self.row(doctor)["workUnit"]), ("SYN-P9 after restore", fresh))
        self.assertEqual(self.row(other)["findings"], kept)
        self.assertEqual(self.ledger_bytes(), ledger_after)
        event("p09_restore", reapplied=True, idempotent=True)
        # One more completed destruction, so that this database has seen the ledger (the gate cases below need it).
        self.assertEqual(self.save(other, "SYN-P9 anchor").status, 200)
        moved = self.row(other)["workUnit"]
        self.assertEqual(self.discard(other).status, 200)
        self.wait_destroyed(moved)
        self.assertGreater(int(psql('SELECT seq FROM "PurposeLedgerAnchor" WHERE id=1')[0]), 0)

        anchor = psql('SELECT "ledgerId"::text FROM "PurposeLedgerAnchor" WHERE id=1')[0]
        # A copy that never saw this ledger (another ledger ID) stays closed.
        self.closed_then_reopened("PurposeLedgerMismatch",
            lambda: psql('UPDATE "PurposeLedgerAnchor" SET "ledgerId"=gen_random_uuid() WHERE id=1'),
            lambda: psql(f'UPDATE "PurposeLedgerAnchor" SET "ledgerId"={sql_text(anchor)}::uuid WHERE id=1'))
        # The ledger is missing beside a copy that saw completions.
        self.closed_then_reopened("PurposeLedgerMissing",
            lambda: compose_exec("-T", "api", "mv", LEDGER, LEDGER + ".moved"),
            lambda: compose_exec("-T", "api", "mv", LEDGER + ".moved", LEDGER))
        # A started attempt this copy cannot settle (its end is not in this copy).
        header, entries = self.ledger()
        started = started_of(entries[-1]["record"], "disposal:" + str(uuid.uuid4()))
        line = json.dumps({"kind": "entry", "seq": len(entries) + 1, "ledgerId": header["ledgerId"],
                           "appendedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "record": started}) + "\n"
        whole = self.ledger_bytes()
        self.closed_then_reopened("PurposeIntentIncomplete",
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat >> {LEDGER}", stdin=line.encode()),
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=whole))
        self.assertEqual(self.ledger_bytes(), whole)
        event("p09_gate", closed=["PurposeLedgerMismatch", "PurposeLedgerMissing", "PurposeIntentIncomplete"])

    def test_p14_a_copy_from_before_any_destruction_without_its_ledger_stays_closed(self):
        """F4: a copy whose anchor never moved (seq 0) but that already handed out works, restored without its ledger."""
        doctor = "doctor"
        self.assertEqual(self.save(doctor, "SYN-P14 live work").status, 200)
        saved = self.anchor()
        # The anchor as a copy taken before this database's first destruction has it (seq 0, no completion named).
        completion = "lastCompletedUnit" in saved

        def literal(value, cast=""):
            return "NULL" if value is None else sql_text(value) + cast

        def damage():
            psql('UPDATE "PurposeLedgerAnchor" SET seq=0' + (', "lastCompletedUnit"=NULL, "lastCompletedAt"=NULL' if completion else "")
                 + " WHERE id=1")
            compose_exec("-T", "api", "mv", LEDGER, LEDGER + ".lost")

        def repair():
            compose_exec("-T", "api", "mv", LEDGER + ".lost", LEDGER)
            psql(f'UPDATE "PurposeLedgerAnchor" SET seq={int(saved["seq"])}'
                 + (f', "lastCompletedUnit"={literal(saved["lastCompletedUnit"])}, '
                    f'"lastCompletedAt"={literal(saved["lastCompletedAt"], "::timestamp")}' if completion else "") + " WHERE id=1")
        self.closed_then_reopened("PurposeLedgerMissing", damage, repair)
        self.assertEqual(self.anchor(), saved)
        # A ledger directory inside the backed-up EMR state, or none at all, is refused by every process that opens it.
        code, report = self.sweep("KIN_PURPOSE_LEDGER_DIR=/var/lib/kin-emr/purpose-ledger")
        self.assertEqual((code, report), (1, {"ran": False, "error": "PurposeLedgerInsideBackup"}))
        code, report = self.sweep("-u", "KIN_PURPOSE_LEDGER_DIR")
        self.assertEqual((code, report), (1, {"ran": False, "error": "PurposeLedgerDirectoryRequired"}))
        event("p14", seq0_without_ledger_closed=True, fallback_refused=True)

    def test_p15_a_completion_lost_after_its_commit_is_written_from_the_anchor_at_the_next_start(self):
        """F3: the process stops between the committed deletion and the completed record."""
        doctor = "doctor"
        self.assertEqual(self.save(doctor, "SYN-P15").status, 200)
        unit = self.row(doctor)["workUnit"]
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(unit)
        whole = self.ledger_bytes()
        lines = whole.decode().splitlines(keepends=True)
        last = json.loads(lines[-1])
        self.assertEqual((last["record"]["disposalUnitId"], last["record"]["phase"]), (unit, "completed"))
        # What a stop between the commit and the completed record leaves: the ledger ends with that unit's started.
        # Nothing else writes the ledger in between (the server reads it only to destroy, and the next start's gate).
        compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin="".join(lines[:-1]).encode())
        try:
            self.restart_api()
            self.reload_proxy()
            self.wait_api()
        except AssertionError:
            # Leave the stack open for the cases after this one; the failure stands.
            compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=whole)
            self.restart_api(); self.reload_proxy(); self.wait_api()
            raise
        header, entries = self.ledger()
        rewritten = entries[-1]
        self.assertEqual((rewritten["seq"], rewritten["record"]), (last["seq"], last["record"]),
                         "the completed record comes back with its original completion facts")
        self.assertEqual(int(self.anchor()["seq"]), last["seq"])
        event("p15", completion_restored=True)

    def test_p16_a_legacy_copy_through_the_real_migration_does_not_open(self):
        """F7: a database from before the P migration (no work identity, no anchor) is migrated by the stack's own
        migration step and started beside the existing ledger: the server refuses it."""
        doctor = "doctor2"
        self.assertEqual(self.save(doctor, "SYN-P16 legacy draft").status, 200)
        self.dump("cd09p-legacy-base.dump")
        compose_stop_api()
        since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            # The legacy shape: the P migration's tables, columns and record of having run are absent.
            psql('BEGIN; DROP TABLE "ReportDraftPurposeEnd"; DROP TABLE "PurposeLedgerAnchor"; '
                 'ALTER TABLE "ReportDraft" DROP COLUMN "workUnit", DROP COLUMN "workSince", DROP COLUMN "workIntent"; '
                 "DELETE FROM _prisma_migrations WHERE migration_name = '20261103150000_cd09p_draft_purpose'; COMMIT")
            self.assertEqual(psql(f'SELECT count(*) FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND present'), ["1"])
            compose_migrate()
            self.assertEqual(psql(f'SELECT count(*) FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND present AND "workUnit" IS NOT NULL'), ["1"])
            compose_start_api()
            self.wait_api(healthy=False, code="PurposeLedgerMismatch", since=since)
            time.sleep(3)
            health = self.stack.request("GET", "/health")
            self.assertFalse(health.status == 200 and isinstance(health.body, dict) and health.body.get("ok"), health.text)
        finally:
            compose_stop_api()
            self.restore("cd09p-legacy-base.dump")
            compose_start_api()
            self.reload_proxy()
        self.wait_api()
        self.assertEqual(self.row(doctor)["findings"], "SYN-P16 legacy draft")
        event("p16", legacy_migrated_closed=True)


SWEEP_CLI = "npm run build >&2 && exec node dist/emr-retention/draft-purpose-sweep.js"
PREPARE_CLI = "npm run build >&2 && exec node dist/emr-retention/draft-purpose-prepare.js"
ADOPTION = "/var/lib/kin-purpose/purpose-adoption.json"


class DraftPurposeCommitJudgement(DraftPurposeServed):
    """CD-09-P r3 (consult-cd09p-r3-precheck-report.md C2-C5, C8; plan claude-plan-cd-09p-r3.md section 4, review
    astra-review-cd-09p-r3-plan3.md attachments 1-2): every path answers from one commit judgement.

    The controls are external and synthetic. K is a psql session that only holds an advisory key; T1 is a deferred
    constraint trigger on the target row only, which waits for that key at COMMIT (and then passes or raises); L is a
    second psql session that queues for the row (or table) the target transaction holds, so that the product's own
    confirmation read P_R waits behind L and meets its 3-second lock wait. Each case observes the branch first - P_C
    waiting at COMMIT on K, L queued behind P_C, L granted, the durable state, P_R waiting on L (P_R is neither K nor L)
    and its lock timeout in the database log - and only then asserts the product's outcome.
    """

    # ── controls ──

    def setUp(self):
        super().setUp()
        self.sessions = []
        self.observer = self.session("O")
        self.since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def session(self, tag):
        session = Session(tag)
        self.sessions.append(session)
        # LIFO cleanup: L before K before the observer, each with a finite wait.
        self.addCleanup(session.close)
        return session

    def restore(self, name):
        # DROP DATABASE ... WITH (FORCE) ends every session of the old database, the observer's too.
        super().restore(name)
        self.observer = self.session("O")

    def last_json(self, code, out, err):
        lines = out.strip().splitlines()
        self.assertTrue(lines, f"the command printed no JSON line (exit {code}): {err[-2000:]}")
        return json.loads(lines[-1])

    def key_holder(self):
        key = random.randint(1 << 20, 1 << 30)
        holder = self.session("K")
        holder.query(f"BEGIN; SELECT pg_advisory_xact_lock({key})")
        self.assertEqual(self.observer.query(f"SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted AND pid={holder.pid}"), ["1"])
        return key, holder

    def t1(self, table, event_name, condition, key, fail):
        """The target transaction's COMMIT waits for K, then passes (fail=False) or raises (fail=True)."""
        action = "RAISE EXCEPTION 'SYN-CD09P commit failure'; " if fail else ""
        psql("CREATE OR REPLACE FUNCTION public.cd09p_t1() RETURNS trigger LANGUAGE plpgsql AS "
             f"$$BEGIN IF {condition} THEN PERFORM pg_advisory_xact_lock({key}); {action}END IF; RETURN NULL; END$$")
        psql(f'CREATE CONSTRAINT TRIGGER cd09p_t1 AFTER {event_name} ON "{table}" DEFERRABLE INITIALLY DEFERRED '
             "FOR EACH ROW EXECUTE FUNCTION public.cd09p_t1()")
        self.addCleanup(lambda: psql(f'DROP TRIGGER IF EXISTS cd09p_t1 ON "{table}"'))
        return lambda: psql(f'DROP TRIGGER IF EXISTS cd09p_t1 ON "{table}"')

    def poll(self, sql, what, timeout, interval=0.05):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            rows = [row for row in self.observer.query(sql) if row]
            if rows:
                return rows
            time.sleep(interval)
        self.fail(f"not observed within {timeout}s: {what}")

    def commit_waiting(self, holder, timeout=60):
        """P_C: a backend whose COMMIT waits for K's advisory key."""
        rows = self.poll("SELECT pid FROM pg_stat_activity WHERE query = 'COMMIT' AND wait_event_type = 'Lock' "
                         f"AND wait_event = 'advisory' AND {holder.pid} = ANY(pg_blocking_pids(pid))",
                         "the target COMMIT waiting on K", timeout)
        return int(rows[0])

    def queue_behind(self, lock_sql, p_c):
        """L queues for what P_C holds; returns L once it is seen waiting on P_C."""
        lock = self.session("L")
        lock.query("BEGIN; SET LOCAL lock_timeout = '120s'")
        lock.start(lock_sql)
        self.poll(f"SELECT pid FROM pg_stat_activity WHERE pid = {lock.pid} AND wait_event_type = 'Lock' "
                  f"AND {p_c} = ANY(pg_blocking_pids(pid))", "L queued behind P_C", 30)
        return lock

    def confirmation_waiting(self, holder, lock, timeout=30):
        """P_R: the product's confirmation read waiting on L (never K or L itself)."""
        rows = self.poll(f"SELECT pid::text || '|' || query FROM pg_stat_activity WHERE pid NOT IN ({holder.pid}, {lock.pid}, "
                         f"{self.observer.pid}) AND wait_event_type = 'Lock' AND {lock.pid} = ANY(pg_blocking_pids(pid))",
                         "the confirmation read waiting on L", timeout)
        pid, query = rows[0].split("|", 1)
        self.assertNotIn(int(pid), (holder.pid, lock.pid))
        return int(pid), query

    def lock_timeout_logged(self, pid, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            log = compose_db_logs(self.since)
            if re.search(rf"\[{pid}\] ERROR:\s+canceling statement due to lock timeout", log):
                return True
            time.sleep(1)
        self.fail(f"no lock timeout of the confirmation read [{pid}] in the database log")

    def commit_failure_logged(self, pid, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if re.search(rf"\[{pid}\] ERROR:\s+SYN-CD09P commit failure", compose_db_logs(self.since)):
                return True
            time.sleep(1)
        self.fail(f"no commit failure of [{pid}] in the database log")

    def stopped_ledger(self):
        code, out, err = compose_run_api(f"if [ -f {LEDGER} ]; then cat {LEDGER}; fi", timeout=300)
        self.assertEqual(code, 0, err)
        return out.encode()

    def stopped_file(self, path):
        code, out, err = compose_run_api(f"if [ -f {path} ]; then cat {path}; else echo ABSENT; fi", timeout=300)
        self.assertEqual(code, 0, err)
        return out

    def cli(self, process, timeout=600):
        out, err = process.communicate(timeout=timeout)
        out, err = out.decode(errors="replace"), err.decode(errors="replace")
        return process.returncode, self.last_json(process.returncode, out, err), err[-3000:]

    def held_end(self, user, secret):
        """An ended work whose payload is still stored (a hold keeps it): the copy a backup takes between end and destruction."""
        self.assertEqual(self.save(user, secret).status, 200)
        unit = self.row(user)["workUnit"]
        record = json.dumps([self.uid, self.stack.actor(user)], separators=(",", ":"))
        time.sleep(1.1)
        hold = self.place_hold(record)
        psql(f"SELECT emr_access.place_hold({sql_text(hold['holdId'])}, {sql_text(record)}, {sql_text(json.dumps(hold))})::text")
        self.assertEqual(self.discard(user).status, 200)
        self.assertEqual(self.wait_refusal(unit)["lastRefusal"], "LegalHoldActive")
        return unit, hold

    def reopen(self):
        compose_start_api()
        self.reload_proxy()
        self.wait_api()

    # ── C3: a new destruction whose confirmation read cannot run ──

    def test_c3a_a_committed_deletion_whose_confirmation_times_out_is_neither_completed_nor_failed_until_judged(self):
        doctor, secret = "doctor", "SYN-R3-C3a " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit, before = self.row(doctor)["workUnit"], self.anchor()
        key, holder = self.key_holder()
        self.t1("ReportDraftPurposeEnd", "DELETE", f'OLD."disposalUnitId" = {sql_text(unit)}', key, fail=False)
        self.assertEqual(self.discard(doctor).status, 200)
        p_c = self.commit_waiting(holder)
        lock = self.queue_behind('SELECT 1 FROM "PurposeLedgerAnchor" WHERE id = 1 FOR UPDATE', p_c)
        holder.query("COMMIT")
        lock.answered(30)
        # L holds the anchor: the deletion committed (durable), its confirmation must wait for L.
        self.assertEqual(self.ended(unit), None)
        anchor = self.anchor()
        self.assertEqual(anchor["lastCompletedUnit"], unit)
        p_r, query = self.confirmation_waiting(holder, lock)
        self.assertEqual(self.phases(unit), ["started"], "until the first judgement: started only")
        self.lock_timeout_logged(p_r)
        self.assertNotIn("failed", self.phases(unit), "an unknown outcome is never written as failed")
        # Recovery, while L still holds the anchor: the committed anchor proves the deletion (R1).
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and "completed" not in self.phases(unit):
            time.sleep(0.5)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        completed = [e["record"] for e in self.ledger()[1] if e["record"]["disposalUnitId"] == unit and e["record"]["phase"] == "completed"][0]
        at = datetime.fromisoformat(anchor["lastCompletedAt"][:19]).replace(tzinfo=timezone.utc)
        self.assertEqual(completed["day"], (at + timedelta(hours=9)).date().isoformat(), "the commit's own completion time")
        lock.query("COMMIT")
        time.sleep(2)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        self.assertEqual(int(self.anchor()["seq"]), int(anchor["seq"]))
        self.assertGreater(int(anchor["seq"]), int(before["seq"]))
        event("c3a", p_c=p_c, p_r=p_r, confirmation=query[:120], phases=self.phases(unit))

    def test_c3a2_c3db_a_rolled_back_deletion_whose_confirmation_times_out_blocks_other_units_then_fails_once(self):
        doctor, other = "doctor", "doctor2"
        secret, kept = "SYN-R3-C3a2 " + uuid.uuid4().hex, "SYN-R3-C3db " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        self.assertEqual(self.save(other, kept).status, 200)
        unit, b_unit, before = self.row(doctor)["workUnit"], self.row(other)["workUnit"], self.anchor()
        key, holder = self.key_holder()
        drop = self.t1("ReportDraftPurposeEnd", "DELETE", f'OLD."disposalUnitId" = {sql_text(unit)}', key, fail=True)
        self.assertEqual(self.discard(doctor).status, 200)
        p_c = self.commit_waiting(holder)
        lock = self.queue_behind('SELECT 1 FROM "PurposeLedgerAnchor" WHERE id = 1 FOR UPDATE', p_c)
        holder.query("COMMIT")
        lock.answered(30)
        self.commit_failure_logged(p_c)
        self.assertEqual(self.ended(unit)["findings"], secret, "the deletion rolled back")
        self.assertEqual((self.anchor()["seq"], self.anchor()["lastCompletedUnit"]), (before["seq"], before["lastCompletedUnit"]))
        p_r, _ = self.confirmation_waiting(holder, lock)
        self.lock_timeout_logged(p_r)
        self.assertEqual(self.phases(unit), ["started"], "unknown: no failed while it cannot be judged")
        # C3-d(b): B ends now; its destruction does not start while A is unknown.
        self.assertEqual(self.discard(other).status, 200)
        refused = self.wait_refusal(b_unit)
        self.assertEqual(refused["lastRefusal"], "PurposeIntentIncomplete")
        self.assertEqual((self.phases(b_unit), refused["findings"]), ([], kept))
        self.assertEqual(self.phases(unit), ["started"])
        # L released: A is judged not committed -> failed (then its retries fail on the trigger); once the trigger is gone
        # the sweep destroys A and B, each completed once.
        lock.query("COMMIT")
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and "failed" not in self.phases(unit):
            time.sleep(0.5)
        self.assertEqual(self.phases(unit)[:2], ["started", "failed"])
        drop()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            code, report = self.sweep()
            if code == 0:
                break
            time.sleep(2)
        self.assertEqual(code, 0, report)
        self.assertEqual((self.ended(unit), self.ended(b_unit)), (None, None))
        self.assertEqual(self.phases(unit).count("completed"), 1)
        self.assertEqual(self.phases(b_unit), ["started", "completed"])
        event("c3a2_c3db", p_c=p_c, p_r=p_r, a=self.phases(unit), b=self.phases(b_unit))

    # ── C8-b: an end whose commit cannot be confirmed ──

    def test_c8b_an_end_whose_confirmation_times_out_answers_unconfirmed_then_ends_once(self):
        doctor, secret = "doctor", "SYN-R3-C8b " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        key, holder = self.key_holder()
        self.t1("ReportDraftPurposeEnd", "INSERT", f'NEW."disposalUnitId" = {sql_text(unit)}', key, fail=False)
        answers = []
        request = threading.Thread(target=lambda: answers.append(self.discard(doctor)))
        request.start()
        p_c = self.commit_waiting(holder)
        lock = self.queue_behind(f'SELECT 1 FROM "StudyState" WHERE uid = {sql_text(self.uid)} FOR UPDATE', p_c)
        holder.query("COMMIT")
        lock.answered(30)
        # The end committed (durable): the author's row is the emptied boundary and the unit is no longer its work.
        row = self.row(doctor)
        self.assertEqual((row["present"], row["workUnit"]), (False, None), "the end committed")
        p_r, _ = self.confirmation_waiting(holder, lock)
        request.join(60)
        self.assertEqual(len(answers), 1)
        answer = answers[0]
        self.assertEqual((answer.status, (answer.body or {}).get("code")), (503, "REPORT_DRAFT_END_UNCONFIRMED"), answer.text)
        self.assertRegex(json.dumps(answer.body, ensure_ascii=False), "[가-힣]")
        self.assertNotIn("그대로", json.dumps(answer.body, ensure_ascii=False))
        self.lock_timeout_logged(p_r)
        time.sleep(2)
        self.assertEqual(self.phases(unit), [], "nothing destroyed while the end is unconfirmed")
        self.assertEqual(self.ended(unit)["findings"], secret)
        lock.query("COMMIT")
        self.wait_destroyed(unit, timeout=60)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("c8b", p_c=p_c, p_r=p_r, answer=answer.status)

    # ── C3-c and C4-d: what the ledger says that this copy cannot settle ──

    def test_c3c_c4d_a_ledger_that_contradicts_the_anchor_or_ends_in_an_unsettled_start_keeps_everything_closed(self):
        doctor, secret = "doctor", "SYN-R3-C3c " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, "SYN-R3-C3c first").status, 200)
        first = self.row(doctor)["workUnit"]
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(first)
        whole = self.ledger_bytes()
        lines = whole.decode().splitlines(keepends=True)
        last = json.loads(lines[-1])
        self.assertEqual((last["record"]["phase"], int(self.anchor()["seq"])), ("completed", last["seq"]))
        # C3-c: same length, another meaning at the anchor's position.
        changed = dict(last, record=dict(last["record"], phase="failed"))
        damaged = "".join(lines[:-1]).encode() + (json.dumps(changed) + "\n").encode()
        self.closed_then_reopened("PurposeLedgerAnchorMismatch",
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=damaged),
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=whole))
        self.assertEqual(self.ledger_bytes(), whole)
        # C4-d: A ended (held), and the ledger ends with a started of A that no process can settle.
        unit, hold = self.held_end(doctor, secret)
        whole = self.ledger_bytes()
        header, entries = self.ledger()
        started = started_of(entries[-1]["record"], unit)
        line = json.dumps({"kind": "entry", "seq": len(entries) + 1, "ledgerId": header["ledgerId"],
                           "appendedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "record": started}) + "\n"
        self.assertNotEqual(self.anchor()["lastCompletedUnit"], unit)
        self.closed_then_reopened("PurposeIntentIncomplete",
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat >> {LEDGER}", stdin=line.encode()),
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=whole))
        self.assertEqual(self.ledger_bytes(), whole, "no failed synthesized from this copy")
        self.assertEqual(self.ended(unit)["findings"], secret)
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("c3c_c4d", closed=["PurposeLedgerAnchorMismatch", "PurposeIntentIncomplete"])

    # ── C4: re-application to a restored copy, by the sweep run and by the gate ──

    def test_c4a_c4b_a_restored_ended_copy_whose_reapplication_does_not_commit_is_not_reported_done(self):
        doctor, secret = "doctor", "SYN-R3-C4a " + uuid.uuid4().hex
        unit, hold = self.held_end(doctor, secret)
        self.dump("cd09p-c4a.dump")
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        ledger_after = self.ledger_bytes()
        compose_stop_api()
        try:
            self.restore("cd09p-c4a.dump")
            self.assertEqual(self.ended(unit)["findings"], secret, "the restored copy holds the destroyed payload")
            key, holder = self.key_holder()
            drop = self.t1("ReportDraftPurposeEnd", "DELETE", f'OLD."disposalUnitId" = {sql_text(unit)}', key, fail=True)
            run = compose_run_api_open(SWEEP_CLI)
            p_c = self.commit_waiting(holder, timeout=600)
            holder.query("COMMIT")
            code, report, err = self.cli(run)
            self.commit_failure_logged(p_c)
            self.assertEqual(code, 1, err)
            self.assertIn({"unit": unit, "outcome": "reapply-not-committed"}, report["results"])
            self.assertFalse(report["complete"])
            self.assertEqual(self.ended(unit)["findings"], secret)
            self.assertEqual(self.stopped_ledger(), ledger_after, "the original completed stands; nothing new is recorded")
            drop()
            code, report, err = self.cli(compose_run_api_open(SWEEP_CLI))
            self.assertEqual(code, 0, err)
            self.assertIn({"unit": unit, "outcome": "reapplied"}, report["results"])
            self.assertIsNone(self.ended(unit))
            event("c4a", p_c=p_c, sweep="reapply-not-committed then reapplied")
            # C4-b: the gate meets the same failing re-application and stays closed.
            self.restore("cd09p-c4a.dump")
            self.assertEqual(self.ended(unit)["findings"], secret)
            key, holder = self.key_holder()
            drop = self.t1("ReportDraftPurposeEnd", "DELETE", f'OLD."disposalUnitId" = {sql_text(unit)}', key, fail=True)
            since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            compose_start_api()
            p_c = self.commit_waiting(holder, timeout=300)
            holder.query("COMMIT")
            self.wait_api(healthy=False, code="PurposeReapplyNotCommitted", since=since)
            self.assertEqual(self.ended(unit)["findings"], secret)
            drop()
            self.restart_api()
            self.reload_proxy()
            self.wait_api()
        finally:
            compose_start_api()
            self.reload_proxy()
        self.wait_api()
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.ledger_bytes(), ledger_after)
        event("c4b", p_c=p_c, gate="PurposeReapplyNotCommitted then opened")

    def test_c4a2_a_restored_live_copy_is_reapplied_by_the_sweep_run_only_when_it_commits(self):
        doctor, secret = "doctor", "SYN-R3-C4a2 " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        self.dump("cd09p-c4a2.dump")
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(unit)
        ledger_after = self.ledger_bytes()
        compose_stop_api()
        try:
            self.restore("cd09p-c4a2.dump")
            restored = self.row(doctor)
            self.assertEqual((restored["workUnit"], restored["findings"], self.ended(unit)), (unit, secret, None))
            key, holder = self.key_holder()
            drop = self.t1("ReportDraft", "UPDATE", f'OLD."workUnit" = {sql_text(unit)}', key, fail=True)
            run = compose_run_api_open(SWEEP_CLI)
            p_c = self.commit_waiting(holder, timeout=600)
            holder.query("COMMIT")
            code, report, err = self.cli(run)
            self.commit_failure_logged(p_c)
            self.assertEqual(code, 1, err)
            self.assertIn({"unit": unit, "outcome": "reapply-not-committed"}, report["results"])
            self.assertEqual(self.row(doctor)["findings"], secret)
            drop()
            code, report, err = self.cli(compose_run_api_open(SWEEP_CLI))
            self.assertEqual(code, 0, err)
            self.assertIn({"unit": unit, "outcome": "reapplied"}, report["results"])
            emptied = self.row(doctor)
            self.assertEqual((emptied["present"], emptied["findings"], emptied["workUnit"], emptied["revision"]),
                             (False, "", None, restored["revision"] + 1))
            self.assertEqual(self.stopped_ledger(), ledger_after)
        finally:
            compose_start_api()
            self.reload_proxy()
        self.wait_api()
        event("c4a2", p_c=p_c, sweep="reapply-not-committed then reapplied")

    def test_c4e_a_reapplication_whose_confirmation_times_out_is_unconfirmed_for_the_sweep_and_closes_the_gate(self):
        doctor, secret = "doctor", "SYN-R3-C4e " + uuid.uuid4().hex
        unit, hold = self.held_end(doctor, secret)
        self.dump("cd09p-c4e.dump")
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        ledger_after = self.ledger_bytes()
        table = 'LOCK TABLE "ReportDraftPurposeEnd" IN ACCESS EXCLUSIVE MODE'
        count = f'SELECT count(*) FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId" = {sql_text(unit)}'
        compose_stop_api()
        try:
            for door in ("sweep", "gate"):
                self.restore("cd09p-c4e.dump")
                self.assertEqual(self.ended(unit)["findings"], secret)
                key, holder = self.key_holder()
                drop = self.t1("ReportDraftPurposeEnd", "DELETE", f'OLD."disposalUnitId" = {sql_text(unit)}', key, fail=False)
                since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                if door == "sweep":
                    run = compose_run_api_open(SWEEP_CLI)
                else:
                    compose_start_api()
                p_c = self.commit_waiting(holder, timeout=600)
                lock = self.queue_behind(table, p_c)
                holder.query("COMMIT")
                lock.answered(30)
                # Attachment 2: the durable state is read in L's own transaction (any other reader would queue behind L).
                self.assertEqual(lock.query(count), ["0"], "the re-application committed")
                p_r, _ = self.confirmation_waiting(holder, lock)
                self.lock_timeout_logged(p_r)
                if door == "sweep":
                    code, report, err = self.cli(run)
                    self.assertEqual(code, 1, err)
                    self.assertIn({"unit": unit, "outcome": "reapply-unconfirmed"}, report["results"])
                else:
                    self.wait_api(healthy=False, code="PurposeReapplyUnconfirmed", since=since)
                lock.query("COMMIT")
                drop()
                compose_stop_api()
                self.assertEqual(self.stopped_ledger(), ledger_after, "the original completed stands; nothing new is recorded")
                event("c4e", door=door, p_c=p_c, p_r=p_r)
            # Once the read can run, the same database opens (its re-application had committed).
            self.reopen()
        finally:
            compose_start_api()
            self.reload_proxy()
        self.wait_api()
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.ledger_bytes(), ledger_after)

    # ── C7: citations inserted through the real API ──

    def test_c7_non_empty_citations_are_held_whole_then_destroyed_with_the_work_and_kept_everywhere_else(self):
        doctor, colleague, signer = "doctor", "doctor2", "jmryu"
        # The finding and viewer rows reference the study with RESTRICT: this case removes its own, child first.
        uid = sql_text(self.uid)
        self.addCleanup(lambda: psql(
            f'BEGIN; DELETE FROM "FindingRevision" WHERE "findingId" IN (SELECT id FROM "Finding" WHERE "studyUid"={uid}); '
            f'DELETE FROM "Finding" WHERE "studyUid"={uid}; '
            f'DELETE FROM "ViewerRequest" WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid}); '
            f'DELETE FROM "ViewerRevision" WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={uid}); '
            f'DELETE FROM "ViewerItem" WHERE "studyUid"={uid}; DELETE FROM "ViewerStorageBudget" WHERE "studyUid"={uid}; COMMIT;'))
        # A key image of this study and one finding citing it, both through the product API.
        found = self.stack._orthanc_request("POST", "/tools/lookup", self.uid.encode())
        study = next(x["ID"] for x in found.body if x["Type"] == "Study")
        instance = self.stack._orthanc_request("GET", "/studies/" + study + "/instances").body[0]
        tags = self.stack._orthanc_request("GET", "/instances/" + instance["ID"] + "/simplified-tags").body
        key = self.stack.request("POST", self.path("/viewer-items"), doctor, {"requestId": str(uuid.uuid4()), "item": {
            "schemaVersion": 1, "kind": "key", "seriesUid": tags["SeriesInstanceUID"], "sopUid": tags["SOPInstanceUID"], "frame": 1,
            "title": "SYN key", "description": ""}})
        self.assertEqual(key.status, 200, key.text)
        finding = self.stack.request("POST", self.path("/findings"), doctor, {"requestId": str(uuid.uuid4()), "item": {
            "schemaVersion": 1, "title": "SYN-R3-C7 finding", "text": "SYN cited text " + uuid.uuid4().hex, "primary": 0,
            "sources": [{"itemId": key.body["id"], "revision": key.body["revision"]}]}})
        self.assertEqual(finding.status, 200, finding.text)
        block = finding.body["item"]["title"] + "\n" + finding.body["item"]["text"]

        def cite(user, text):
            body = {"findings": text + "\n" + block, "conclusion": "SYN conclusion", "recommendation": "", "baseVersion": 0,
                    "citationIds": [], "structureIds": [], "insert": {
                        "field": "findings", "findingId": finding.body["id"], "findingRevision": 1, "sourceIndex": 0,
                        "insertedText": block, "expectedLinkState": "current", "expectedHeadRevision": key.body["revision"]}}
            result = self.stack.request("PUT", self.path("/report"), user, body)
            self.assertEqual(result.status, 200, result.text)
            return result.body["inserted"]["cid"]

        secret = "SYN-R3-C7 private " + uuid.uuid4().hex
        mine, theirs = cite(doctor, secret), cite(colleague, "SYN-R3-C7 colleague")
        signed_cid = cite(signer, "SYN-R3-C7 signed")
        approved = self.stack.request("POST", self.path("/report/commit"), signer, {
            "action": "approve", "baseVersion": 0, "findings": "SYN-R3-C7 signed\n" + block, "conclusion": "SYN conclusion",
            "recommendation": "", "citationIds": [signed_cid]})
        self.assertEqual(approved.status, 201, approved.text)
        # ① the citation is readable as the author's ② both drafts carry one ③ the signed version carries one.
        self.assertEqual([c["cid"] for c in self.citations(doctor)["draft"]], [mine])
        stored = {u: psql(f'SELECT citations::text FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND author={sql_text(self.stack.actor(u))}')
                  for u in (doctor, colleague)}
        self.assertIn(mine, stored[doctor][0]); self.assertIn(theirs, stored[colleague][0])
        head = self.citations(signer)["head"]
        self.assertEqual([c["cid"] for c in head], [signed_cid])
        unit = self.row(doctor)["workUnit"]
        record = json.dumps([self.uid, self.stack.actor(doctor)], separators=(",", ":"))
        time.sleep(1.1)
        hold = self.place_hold(record)
        psql(f"SELECT emr_access.place_hold({sql_text(hold['holdId'])}, {sql_text(record)}, {sql_text(json.dumps(hold))})::text")
        discarded = self.discard(doctor)
        self.assertEqual(discarded.status, 200, discarded.text)
        held = self.wait_refusal(unit)
        self.assertEqual(held["lastRefusal"], "LegalHoldActive")
        # ④ the ended row holds the exact citations while the hold lasts; the ledger has nothing of the unit.
        self.assertEqual(psql(f'SELECT citations::text FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId"={sql_text(unit)}'), stored[doctor])
        self.assertEqual(self.phases(unit), [])
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.phases(unit), ["started", "completed"])
        row = self.row(doctor)
        self.assertEqual((row["present"], row["revision"]), (False, int(discarded.body["revision"].rsplit(":", 1)[1])))
        self.assertEqual(psql(f'SELECT citations IS NULL FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND author={sql_text(self.stack.actor(doctor))}'), ["t"])
        self.assertEqual(psql(f'SELECT citations::text FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND author={sql_text(self.stack.actor(colleague))}'),
                         stored[colleague])
        self.assertEqual(self.citations(signer)["head"], head)
        self.assert_ledger_names_nothing(mine, secret, block, finding.body["id"])
        event("c7", held_citations=True, destroyed=True, colleague_kept=True, signed_kept=True)

    def citations(self, user):
        result = self.stack.request("GET", self.path("/report/citations"), user)
        self.assertEqual(result.status, 200, result.text)
        return result.body

    # ── C5: the first start, and the copies the product can tell apart ──

    def test_c5_a_prepared_first_start_opens_once_and_every_distinguishable_copy_stays_closed(self):
        doctor, legacy = "doctor", "doctor2"
        self.assertEqual(self.save(legacy, "SYN-R3-C5 legacy draft").status, 200)
        self.dump("cd09p-c5-original.dump")
        original_ledger = self.ledger_bytes()
        compose_exec("-T", "api", "sh", "-c", f"mv {LEDGER} {LEDGER}.c5saved; rm -f {ADOPTION}")
        compose_stop_api()

        def directory(ledger=None, adoption=None):
            """The ledger directory's two files set exactly (absent when None); bytes travel base64-encoded."""
            script = f"rm -f {LEDGER} {ADOPTION}"
            for path, content in ((LEDGER, ledger), (ADOPTION, adoption)):
                if content is not None:
                    data = content if isinstance(content, bytes) else content.encode()
                    script += f"; echo {base64.b64encode(data).decode()} | base64 -d > {path}"
            code, _, err = compose_run_api(script, timeout=300)
            self.assertEqual(code, 0, err)

        def closed(code_name):
            since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            compose_start_api()
            self.wait_api(healthy=False, code=code_name, since=since)
            compose_stop_api()

        try:
            # Common preparation: the legacy shape (before the P migration), an empty ledger directory, the preparation,
            # then the stack's own migration.
            psql('BEGIN; DROP TABLE "ReportDraftPurposeEnd"; DROP TABLE "PurposeLedgerAnchor"; '
                 'ALTER TABLE "ReportDraft" DROP COLUMN "workUnit", DROP COLUMN "workSince", DROP COLUMN "workIntent"; '
                 "DELETE FROM _prisma_migrations WHERE migration_name = '20261103150000_cd09p_draft_purpose'; COMMIT")
            self.dump("cd09p-c5-legacy.dump")
            directory()
            code, out, err = compose_run_api(PREPARE_CLI)
            self.assertEqual((code, self.last_json(code, out, err)), (0, {"prepared": True, "state": "prepared"}), err)
            prepared = self.stopped_file(ADOPTION)
            compose_migrate()
            # S0
            self.assertEqual(json.loads(prepared)["state"], "prepared")
            self.assertEqual(self.stopped_ledger(), b"")
            self.assertEqual((self.anchor()["initialized"], int(self.anchor()["seq"])), (False, 0))
            self.assertEqual(psql(f'SELECT count(*) FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND "workUnit" IS NOT NULL'), ["1"])
            self.dump("cd09p-c5-d0.dump")
            # C5-5 P4: the preparation after the migration refuses and writes nothing.
            code, out, err = compose_run_api(PREPARE_CLI)
            self.assertEqual((code, self.last_json(code, out, err)["error"]), (1, "PurposeAdoptionExists"), err)
            directory(adoption=None)
            code, out, err = compose_run_api(PREPARE_CLI)
            self.assertEqual((code, self.last_json(code, out, err)["error"]), (1, "PurposeAdoptionAfterMigration"), err)
            self.assertEqual(self.stopped_file(ADOPTION).strip(), "ABSENT")
            directory(adoption=prepared)
            # C5-2 (I2): the first start consumes it - S1.
            self.reopen()
            anchor = self.anchor()
            adoption = json.loads(compose_exec("-T", "api", "cat", ADOPTION).stdout)
            self.assertEqual((adoption["state"], adoption["ledgerId"]), ("consumed", anchor["ledgerId"]))
            self.assertEqual((self.ledger()[0]["ledgerId"], anchor["initialized"]), (anchor["ledgerId"], True))
            self.assertEqual(self.row(legacy)["findings"], "SYN-R3-C5 legacy draft")
            consumed = compose_exec("-T", "api", "cat", ADOPTION).stdout.decode()
            # S2: a normal end and destruction.
            self.assertEqual(self.save(doctor, "SYN-R3-C5 after").status, 200)
            unit = self.row(doctor)["workUnit"]
            self.assertEqual(self.discard(doctor).status, 200)
            self.wait_destroyed(unit)
            latest = self.ledger_bytes()
            compose_stop_api()
            self.dump("cd09p-c5-s2.dump")
            event("c5_2", adopted=True)
            # C5-3 (I3): no ledger, no adoption, D0 -> closed, nothing created; C5-6: the sweep run refuses too.
            directory()
            self.restore("cd09p-c5-d0.dump")
            closed("PurposeLedgerInitializationRequired")
            code, report, err = self.cli(compose_run_api_open(SWEEP_CLI))
            self.assertEqual((code, report), (1, {"ran": False, "error": "PurposeLedgerInitializationRequired"}), err)
            self.assertEqual(self.stopped_ledger(), b"")
            self.assertEqual(self.row(legacy)["findings"], "SYN-R3-C5 legacy draft")
            # C5-4 (I4): the consumed adoption without its ledger beside D0 -> missing.
            directory(adoption=consumed)
            closed("PurposeLedgerMissing")
            # C5-8 (I5): the current database beside the directory as it was before the first start (prepared only).
            self.restore("cd09p-c5-s2.dump")
            directory(adoption=prepared)
            closed("PurposeLedgerMissing")
            self.assertEqual(json.loads(self.stopped_file(ADOPTION))["state"], "prepared", "not consumed")
            # C5-4b (I6, attachment 1): the pre-migration shape migrated again beside the latest ledger: another ledger ID.
            directory(ledger=latest, adoption=consumed)
            self.restore("cd09p-c5-legacy.dump")
            compose_migrate()
            self.assertNotEqual(self.anchor()["ledgerId"], json.loads(latest.decode().splitlines()[0])["ledgerId"])
            closed("PurposeLedgerMismatch")
            self.assertEqual(self.stopped_ledger(), latest)
            self.assertEqual(self.row(legacy)["findings"], "SYN-R3-C5 legacy draft")
            # The same-ID input (D0 beside the latest ledger) is not I6: the gate matches it, re-applies what it holds of
            # the completed units (nothing: U was created after D0) and opens.
            self.restore("cd09p-c5-d0.dump")
            self.reopen()
            self.assertEqual(self.ledger_bytes(), latest)
            self.assertEqual(self.row(legacy)["findings"], "SYN-R3-C5 legacy draft")
            compose_stop_api()
            event("c5", closed=["PurposeLedgerInitializationRequired", "PurposeLedgerMissing", "PurposeLedgerMissing", "PurposeLedgerMismatch"])
        finally:
            compose_stop_api()
            self.restore("cd09p-c5-original.dump")
            compose_run_api(f"rm -f {ADOPTION} {LEDGER}; if [ -f {LEDGER}.c5saved ]; then mv {LEDGER}.c5saved {LEDGER}; fi", timeout=300)
            self.reopen()
        self.assertEqual(self.ledger_bytes(), original_ledger)


# ── CD-09-C RC8: a server of the CD-09-P release (1f8249a) upgraded to this tree, and back ──

P_IMAGE_ENV = "KIN_CD09C_P_IMAGE"
V1_RECORD_FIELDS = sorted(["formatVersion", "phase", "day", "disposalUnitId", "classes", "clauseIds", "partCount", "expiryDay",
                           "extensionUsed", "dueDay", "timeliness", "method", "basis"])
SAVED = ".cd09c-saved"
# Requests to the P server straight to its process (as the holding client does to the API): one answer per call.
P_CLIENT = r"""
const [method, path, token, body] = process.argv.slice(1);
const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
if (body) headers['Content-Type'] = 'application/json';
fetch('http://127.0.0.1:3000/api' + path, { method, headers, body: body || undefined })
  .then(async r => console.log(JSON.stringify({ status: r.status, text: await r.text() })),
        e => console.log(JSON.stringify({ status: 0, text: String(e) })));
"""
LISTENING = r"""
const s = require('net').connect(3000, '127.0.0.1');
s.on('connect', () => { console.log('open'); s.destroy(); });
s.on('error', () => console.log('closed'));
"""


class DraftPurposeUpgradeServed(DraftPurposeServed):
    """CD-09-C RC8 (claude-plan-cd-09c.md section 5, plan review section 6 item 2): the P release's own image writes the
    format-1 ledger, this tree's API takes it over without preparation, and the way back is refused.

    The P image (built from 1f8249a by the run, named in KIN_CD09C_P_IMAGE) runs as one container of this stack's own
    network, with the API service's environment and its purpose-ledger and EMR state volumes, while the stack's API is
    stopped; it runs as root because the development API writes those volumes as root. For the P era the stack's own
    ledger and anchor are set aside (the P server adopts a fresh ledger through the prepared first start it supports)
    and put back exactly at the end. Three separate flows: the normal upgrade with a mixed-format restore and the
    rollback (no unsettled started in it), the R1 recovery of a completion the P server lost, and the R4 refusal of a
    started record no process can settle."""

    @classmethod
    def setUpClass(cls):
        cls.p_image = os.environ.get(P_IMAGE_ENV)
        if not cls.p_image:
            raise RuntimeError("NOT_RUN_ENV: " + P_IMAGE_ENV + " (the CD-09-P release image) is required")
        super().setUpClass()
        ids = subprocess.run(["docker", "compose", "ps", "-a", "-q", "api"], cwd=ROOT, capture_output=True, timeout=60,
                             check=True).stdout.decode().split()
        if len(ids) != 1:
            raise RuntimeError("expected one API container of this stack: " + repr(ids))
        api = json.loads(subprocess.run(["docker", "inspect", ids[0]], capture_output=True, timeout=60, check=True).stdout)[0]
        mounts = {m["Destination"]: m for m in api["Mounts"]}
        cls.volumes = [mounts[d]["Name"] for d in ("/var/lib/kin-purpose", "/var/lib/kin-emr")]
        if any(mounts[d]["Type"] != "volume" for d in ("/var/lib/kin-purpose", "/var/lib/kin-emr")):
            raise RuntimeError("the API's ledger and state must be named volumes")
        cls.network = sorted(api["NetworkSettings"]["Networks"])[0]
        cls.p_name = api["Name"].lstrip("/") + "-cd09c-p"
        skip = ("PATH=", "HOSTNAME=", "HOME=", "NODE_VERSION=", "YARN_VERSION=", "TERM=")
        cls.p_env = [entry for entry in api["Config"]["Env"] if not entry.startswith(skip)]

    # ── the P release's server ──

    def volume_sh(self, script, stdin=None, check=True):
        """A shell in the ledger directory while neither server runs (the P image's own sh, as root)."""
        result = subprocess.run(["docker", "run", "--rm", "-i", "--network", "none", "-u", "0:0", "-v", self.volumes[0] + ":/var/lib/kin-purpose",
                                 "--entrypoint", "sh", self.p_image, "-c", script], input=stdin, capture_output=True, timeout=300)
        if check and result.returncode:
            raise RuntimeError("volume shell failed: " + result.stderr.decode(errors="replace")[-1500:])
        return result.stdout

    def volume_ledger(self):
        return self.volume_sh(f"if [ -f {LEDGER} ]; then cat {LEDGER}; fi")

    def start_p(self):
        subprocess.run(["docker", "rm", "-f", self.p_name], capture_output=True, timeout=120)
        args = ["docker", "run", "-d", "--name", self.p_name, "--network", self.network, "-u", "0:0",
                "-v", self.volumes[0] + ":/var/lib/kin-purpose", "-v", self.volumes[1] + ":/var/lib/kin-emr"]
        for entry in self.p_env:
            args += ["-e", entry]
        subprocess.run(args + [self.p_image, "sh", "/app/start-production.sh", "serve"], capture_output=True, timeout=120, check=True)
        self.addCleanup(lambda: subprocess.run(["docker", "rm", "-f", self.p_name], capture_output=True, timeout=120))

    def p_state(self):
        info = subprocess.run(["docker", "inspect", self.p_name], capture_output=True, timeout=60)
        return json.loads(info.stdout)[0]["State"] if info.returncode == 0 else None

    def p_logs(self):
        result = subprocess.run(["docker", "logs", self.p_name], capture_output=True, timeout=60)
        return (result.stdout + result.stderr).decode(errors="replace")

    def p_listening(self):
        state = self.p_state()
        if not state or not state.get("Running"):
            return False
        out = subprocess.run(["docker", "exec", self.p_name, "node", "-e", LISTENING], capture_output=True, timeout=60).stdout
        return out.decode().strip() == "open"

    def wait_p(self, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.p_listening() and self.p_request("GET", "/health", None)["status"] == 200:
                return
            state = self.p_state()
            if state and not state.get("Running"):
                self.fail("the P server stopped: " + self.p_logs()[-3000:])
            time.sleep(1)
        self.fail("the P server did not open: " + self.p_logs()[-3000:])

    def p_request(self, method, path, user, body=None):
        token = self.stack.token(user) if user else ""
        out = subprocess.run(["docker", "exec", self.p_name, "node", "-e", P_CLIENT, method, path, token,
                              json.dumps(body) if body is not None else ""], capture_output=True, timeout=120).stdout
        return json.loads(out.decode().strip().splitlines()[-1])

    def p_document(self, user):
        """What a page that has just read the study sends with a draft mutation (LiveStack._as_document), read from the
        P server itself: the account and the draft boundary of this study."""
        me = json.loads(self.p_request("GET", "/me", user)["text"])
        read = self.p_request("GET", self.path("/draft"), user)
        mine = json.loads(read["text"]) if read["status"] == 200 else None
        revision = mine.get("revision") if isinstance(mine, dict) else None
        if not revision:
            boot = json.loads(self.p_request("GET", "/bootstrap", user)["text"])
            revision = ((boot.get("states") or {}).get(self.uid) or {}).get("draftRevision") or LiveStack._NO_EPOCH + ":0"
        return {"expectedOwner": {"institution": me["institution"], "sub": me["sub"], "author": me["actor"]}, "expectedRevision": revision}

    def p_save(self, user, text):
        body = {"findings": text, "conclusion": "SYN conclusion", "recommendation": "", "baseVersion": 0, "citationIds": [],
                "structureIds": [], **self.p_document(user)}
        answer = self.p_request("PUT", self.path("/report"), user, body)
        self.assertEqual(answer["status"], 200, answer["text"])

    def p_discard(self, user):
        answer = self.p_request("DELETE", self.path("/draft"), user, self.p_document(user))
        self.assertEqual(answer["status"], 200, answer["text"])

    def stop_p(self):
        subprocess.run(["docker", "stop", "-t", "30", self.p_name], capture_output=True, timeout=120)
        subprocess.run(["docker", "rm", "-f", self.p_name], capture_output=True, timeout=120)

    def records(self, data):
        return [json.loads(line) for line in data.decode().splitlines()[1:]]

    def wait_p_completed(self, unit, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            out = subprocess.run(["docker", "exec", self.p_name, "sh", "-c", f"cat {LEDGER}"], capture_output=True, timeout=60).stdout
            if any(e["record"]["disposalUnitId"] == unit and e["record"]["phase"] == "completed" for e in self.records(out)) \
                    and self.ended(unit) is None:
                return
            time.sleep(0.5)
        self.fail("the P server did not destroy " + unit)

    def api_listening(self):
        result = compose_exec("-T", "api", "node", "-e", LISTENING, check=False)
        return result.stdout.decode().strip() == "open"

    def p_era(self):
        """Set this stack's ledger, adoption record and anchor aside; the P server then adopts a fresh ledger (the
        prepared first start). Everything is put back exactly by the cleanup registered here."""
        compose_stop_api()
        saved_anchor = self.anchor()
        self.volume_sh(f"cd /var/lib/kin-purpose && for f in purpose-ledger.jsonl purpose-adoption.json; do "
                       f"if [ -f $f ]; then mv $f $f{SAVED}; fi; done")

        def literal(value, cast=""):
            return "NULL" if value is None else sql_text(value) + cast

        def put_back():
            self.stop_p()
            compose_stop_api()
            self.volume_sh(f"cd /var/lib/kin-purpose && rm -f purpose-ledger.jsonl purpose-adoption.json && "
                           f"for f in purpose-ledger.jsonl purpose-adoption.json; do if [ -f $f{SAVED} ]; then mv $f{SAVED} $f; fi; done")
            psql(f'UPDATE "PurposeLedgerAnchor" SET "ledgerId"={sql_text(saved_anchor["ledgerId"])}::uuid, seq={int(saved_anchor["seq"])}, '
                 f'initialized={"true" if saved_anchor["initialized"] else "false"}, '
                 f'"lastCompletedUnit"={literal(saved_anchor["lastCompletedUnit"])}, '
                 f'"lastCompletedAt"={literal(saved_anchor["lastCompletedAt"], "::timestamp")} WHERE id=1')
            # The ended rows this case made in the P era (a held work) are not in the state being put back: on a stack
            # whose anchor was never initialized they would keep the API closed (PurposeLedgerInitializationRequired,
            # VM run cd09c-c2-7425d24). The fixture's own cleanup removes them later anyway; it runs after this one.
            self.drop_ended_rows()
            compose_start_api()
            self.reload_proxy()
            self.wait_api()
        self.addCleanup(put_back)
        # The prepared adoption, in the preparation command's own format (that command refuses after the P migration).
        adoption = json.dumps({"kind": "adoption", "formatVersion": 1, "state": "prepared",
                               "preparedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}) + "\n"
        self.volume_sh("umask 077; cat > /var/lib/kin-purpose/purpose-adoption.json", stdin=adoption.encode())
        psql('UPDATE "PurposeLedgerAnchor" SET "ledgerId"=gen_random_uuid(), seq=0, initialized=false, "lastCompletedUnit"=NULL, '
             '"lastCompletedAt"=NULL WHERE id=1')
        self.start_p()
        self.wait_p()
        header = json.loads(self.volume_ledger().decode().splitlines()[0])
        self.assertEqual(header["ledgerId"], self.anchor()["ledgerId"], "the P server wrote the header of the anchor's ledger")
        self.assertTrue(self.anchor()["initialized"])

    def hold_work(self, user):
        record = json.dumps([self.uid, self.stack.actor(user)], separators=(",", ":"))
        time.sleep(1.1)
        hold = self.place_hold(record)
        psql(f"SELECT emr_access.place_hold({sql_text(hold['holdId'])}, {sql_text(record)}, {sql_text(json.dumps(hold))})::text")
        return hold

    # ── the three flows ──

    def test_u1_a_p_ledger_opens_on_c_keeps_its_bytes_restores_both_formats_and_refuses_the_way_back(self):
        doctor, other = "doctor", "doctor2"
        secret_a, secret_b = "SYN-CD09C-U1 A " + uuid.uuid4().hex, "SYN-CD09C-U1 B " + uuid.uuid4().hex
        self.p_era()
        self.p_save(doctor, secret_a)
        self.p_save(other, secret_b)
        unit_a, unit_b = self.row(doctor)["workUnit"], self.row(other)["workUnit"]
        hold = self.hold_work(other)
        # The copy restored later: both works still live (their text in the authors' rows).
        self.dump("cd09c-u1-before.dump")
        self.p_discard(doctor)
        self.wait_p_completed(unit_a)
        self.p_discard(other)
        held = self.wait_refusal(unit_b)
        self.assertEqual((held["findings"], held["lastRefusal"]), (secret_b, "LegalHoldActive"))
        self.stop_p()
        p_bytes = self.volume_ledger()
        p_records = [e["record"] for e in self.records(p_bytes)]
        self.assertTrue(p_records and all(r["formatVersion"] == 1 and sorted(r) == V1_RECORD_FIELDS for r in p_records),
                        "the P server wrote format 1 only")
        self.assertEqual([r["phase"] for r in p_records if r["disposalUnitId"] == unit_a], ["started", "completed"])
        self.assertEqual([r for r in p_records if r["disposalUnitId"] == unit_b], [], "the held work has no record")
        # Upgrade: this tree's API on the same database and volume. No preparation command.
        compose_start_api()
        self.reload_proxy()
        self.wait_api()
        self.assertEqual(self.ledger_bytes(), p_bytes, "the startup sweep found B held and wrote nothing")
        self.release_hold(hold)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIsNone(self.ended(unit_b))
        upgraded = self.ledger_bytes()
        self.assertEqual(upgraded[:len(p_bytes)], p_bytes, "the P lines stay byte for byte")
        added = [e["record"] for e in self.records(upgraded)[len(p_records):]]
        self.assertEqual([(r["formatVersion"], r["phase"], r["disposalUnitId"]) for r in added],
                         [(2, "started", unit_b), (2, "completed", unit_b)])
        self.assertEqual(sorted(added[0]), RECORD_FIELDS)
        self.assertEqual(added[0]["operationId"], added[1]["operationId"])
        self.assertEqual(added[1]["method"], "operational-store-deletion")
        # The database from before both destructions, beside the newest ledger: both formats are re-applied.
        compose_stop_api()
        self.restore("cd09c-u1-before.dump")
        self.assertEqual(sorted(psql(f'SELECT findings FROM "ReportDraft" WHERE "workUnit" IN ({sql_text(unit_a)}, {sql_text(unit_b)})')),
                         sorted([secret_a, secret_b]), "the restored copy holds both texts before the gate")
        compose_start_api()
        self.reload_proxy()
        self.wait_api()
        for user in (doctor, other):
            row = self.row(user)
            self.assertEqual((row["present"], row["findings"], row["workUnit"]), (False, "", None), user)
        self.assertEqual(self.ledger_bytes(), upgraded, "a re-application writes nothing")
        event("cd09c_u1_upgrade", p_lines=len(p_records), format2_lines=len(added), restored_reapplied=2)
        # Back to the P image after format 2: refused, nothing changed.
        compose_stop_api()
        anchor, works = self.anchor(), psql(f'SELECT row_to_json(d)::text FROM (SELECT author, present, findings, revision, "workUnit" '
                                            f'FROM "ReportDraft" WHERE uid={sql_text(self.uid)} ORDER BY author) d')
        ended_rows = psql('SELECT count(*) FROM "ReportDraftPurposeEnd"')
        self.start_p()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and "PurposeLedgerRecordInvalid" not in self.p_logs():
            self.assertFalse(self.p_listening(), "the P server opened on a format-2 ledger")
            time.sleep(1)
        self.assertIn("PurposeLedgerRecordInvalid", self.p_logs())
        time.sleep(3)
        self.assertFalse(self.p_listening(), "closed means not listening")
        self.assertEqual(self.volume_ledger(), upgraded, "the ledger is kept byte for byte")
        self.assertEqual((self.anchor(), psql(f'SELECT row_to_json(d)::text FROM (SELECT author, present, findings, revision, "workUnit" '
                                               f'FROM "ReportDraft" WHERE uid={sql_text(self.uid)} ORDER BY author) d'),
                          psql('SELECT count(*) FROM "ReportDraftPurposeEnd"')), (anchor, works, ended_rows))
        event("cd09c_u1_rollback", refused="PurposeLedgerRecordInvalid")

    def test_u2_a_completion_the_p_server_lost_is_written_by_c_in_format_1_from_the_anchor(self):
        doctor = "doctor"
        self.p_era()
        self.p_save(doctor, "SYN-CD09C-U2 " + uuid.uuid4().hex)
        unit = self.row(doctor)["workUnit"]
        self.p_discard(doctor)
        self.wait_p_completed(unit)
        self.stop_p()
        whole = self.volume_ledger()
        lines = whole.decode().splitlines(keepends=True)
        last = json.loads(lines[-1])
        self.assertEqual((last["record"]["formatVersion"], last["record"]["phase"], last["record"]["disposalUnitId"]), (1, "completed", unit))
        # What a stop between the committed deletion and the completed record leaves: the file ends with the started.
        self.volume_sh(f"cat > {LEDGER}", stdin="".join(lines[:-1]).encode())
        anchor = self.anchor()
        self.assertEqual((int(anchor["seq"]), anchor["lastCompletedUnit"]), (last["seq"], unit), "the anchor proves the commit")
        self.assertIsNotNone(anchor["lastCompletedAt"])
        self.assertIsNone(self.ended(unit), "the payload is gone")
        self.assertEqual(json.loads(lines[-2])["record"]["phase"], "started")
        compose_start_api()
        self.reload_proxy()
        self.wait_api()
        rewritten = self.records(self.ledger_bytes())[-1]
        self.assertEqual((rewritten["seq"], rewritten["record"]), (last["seq"], last["record"]), "closed in format 1, as the P server would")
        self.assertEqual(sorted(rewritten["record"]), V1_RECORD_FIELDS)
        event("cd09c_u2_r1", closed_format=1)

    def test_u3_a_started_the_p_server_left_unsettled_keeps_c_closed_and_everything_kept(self):
        doctor, other = "doctor", "doctor2"
        secret = "SYN-CD09C-U3 " + uuid.uuid4().hex
        self.p_era()
        self.p_save(doctor, secret)
        unit = self.row(doctor)["workUnit"]
        hold = self.hold_work(doctor)
        self.p_discard(doctor)
        self.assertEqual(self.wait_refusal(unit)["lastRefusal"], "LegalHoldActive")
        self.p_save(other, "SYN-CD09C-U3 other")
        unit_other = self.row(other)["workUnit"]
        self.p_discard(other)
        self.wait_p_completed(unit_other)
        self.stop_p()
        whole = self.volume_ledger()
        entries = self.records(whole)
        header = json.loads(whole.decode().splitlines()[0])
        template = next(e["record"] for e in entries if e["record"]["phase"] == "started")
        self.assertEqual(template["formatVersion"], 1)
        started = dict(template, disposalUnitId=unit)
        line = json.dumps({"kind": "entry", "seq": len(entries) + 1, "ledgerId": header["ledgerId"],
                           "appendedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "record": started}) + "\n"
        self.volume_sh(f"cat >> {LEDGER}", stdin=line.encode())
        # The input: a format-1 started of a unit whose payload is still there and that the anchor does not name.
        self.assertNotEqual(self.anchor()["lastCompletedUnit"], unit)
        self.assertEqual(self.ended(unit)["findings"], secret)
        damaged = self.volume_ledger()
        since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        compose_start_api()
        self.wait_api(healthy=False, code="PurposeIntentIncomplete", since=since)
        self.assertIn("draft-purpose PurposeIntentIncomplete", compose_api_logs(since))
        time.sleep(3)
        self.assertFalse(self.api_listening(), "closed means not listening")
        self.assertEqual(self.ledger_bytes(), damaged, "no failed is synthesized")
        self.assertEqual(self.ended(unit)["findings"], secret)
        compose_stop_api()
        self.volume_sh(f"cat > {LEDGER}", stdin=whole)
        self.release_hold(hold)
        event("cd09c_u3_r4", closed="PurposeIntentIncomplete")


def load_tests(loader, tests, pattern):
    suite = loader.loadTestsFromTestCase(DraftPurposeServed)
    # The r3 and CD-09-C classes reuse the fixture's helpers; only their own cases run under them.
    for case in (DraftPurposeCommitJudgement, DraftPurposeUpgradeServed):
        suite.addTests(case(name) for name in sorted(vars(case)) if name.startswith("test_"))
    return suite


if __name__ == "__main__":
    unittest.main()
