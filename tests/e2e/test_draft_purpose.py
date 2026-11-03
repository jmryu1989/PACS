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
"""
from __future__ import annotations

import json
import os
from pathlib import Path
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
RECORD_FIELDS = sorted(["formatVersion", "phase", "day", "disposalUnitId", "classes", "clauseIds", "partCount", "expiryDay",
                        "extensionUsed", "dueDay", "timeliness", "method", "basis"])
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


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


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
            self.assertEqual(sorted(entry["record"]), RECORD_FIELDS)

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
        cases = [("GET", self.path("/draft"), None, "read"), ("PATCH", self.path(), {}, "cut"), ("GET", self.path("/draft"), None, "cut")]
        for method, path, body, ending in cases:
            self.assertEqual(self.save(doctor, secret).status, 200)
            unit = self.row(doctor)["workUnit"]
            client = self.hold_open(doctor, method, path, 40, marker, body)
            try:
                time.sleep(3)   # the handlers run, read the draft and build their answers; the connection holds them
                self.assertEqual(self.discard(doctor).status, 200)
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
        started = dict(entries[-1]["record"], phase="started", disposalUnitId="disposal:" + str(uuid.uuid4()))
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


if __name__ == "__main__":
    unittest.main()
