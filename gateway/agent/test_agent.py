import ast
import dataclasses
import json
import re
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent as agent_module
from agent import (
    GATEWAY_ERROR_CODES, GATEWAY_ERROR_FALLBACK, Agent, Config, GatewayError, PermanentGatewayError, Queue,
    error_code, failed_sops, multipart, plan_batches,
)

SOURCE = (Path(__file__).resolve().parent / "agent.py").read_text(encoding="utf-8")
RECEIPT_KEYS = {"studyUid", "phase", "attempt", "successCount", "localCount", "errorCode", "epoch", "seq"}
EPOCH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def config(database: str, **changes) -> Config:
    base = Config(
        orthanc_url="http://local.invalid", orthanc_user="u", orthanc_pass="p",
        kin_base_url="https://cloud.invalid", client_id="c", client_secret="s",
        tls_verify=True, queue_db=database, byte_budget=24 * 1024 * 1024,
        poll_seconds=0.2, http_timeout=1, stow_timeout=1, backoff_base=1, backoff_max=10,
    )
    return dataclasses.replace(base, **changes)


def error_classes(tree: ast.AST) -> set[str]:
    names = {"GatewayError"}
    grew = True
    while grew:
        grew = False
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name not in names and any(
                    isinstance(base, ast.Name) and base.id in names for base in node.bases):
                names.add(node.name)
                grew = True
    return names


def message_template(call: ast.Call) -> str | None:
    """The literal a GatewayError is built from, each f-string field as {}; None when it is not a literal."""
    if len(call.args) != 1 or call.keywords:
        return None
    argument = call.args[0]
    if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
        return argument.value
    if isinstance(argument, ast.JoinedStr):
        parts = []
        for value in argument.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                parts.append("{}")
            else:
                return None
        return "".join(parts)
    return None


def constructed_errors(source: str) -> list[tuple[int, str | None]]:
    tree = ast.parse(source)
    names = error_classes(tree)
    return [(node.lineno, message_template(node)) for node in ast.walk(tree)
            if isinstance(node, ast.Call) and (
                isinstance(node.func, ast.Name) and node.func.id in names
                or isinstance(node.func, ast.Attribute) and node.func.attr in names)]


class FakeResponse:
    def __init__(self, status: int, body=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self.body = body

    def json(self):
        if self.body is None:
            raise ValueError("no JSON body")
        return self.body


class FakeOrthanc:
    def __init__(self, sops):
        self.sops = sorted(sops)

    def instances(self, uid, preferred_id):
        return "orthanc-id", {"MainDicomTags": {"InstitutionName": "SYNTHETIC"}}, [
            {"sop": sop, "id": "id-" + sop, "size": 16} for sop in self.sops]

    def file(self, instance_id):
        return b"0" * 16


class FakeCloud:
    def __init__(self, receipt):
        self.announced, self.stowed, self.answer = [], [], receipt

    def announce(self, uid, institution_name):
        self.announced.append(uid)

    def stow(self, uid, body, content_type):
        self.stowed.append(uid)
        return set()

    def receipt(self, body):
        return self.answer(body)


class AgentUnitTests(unittest.TestCase):
    def test_batches_never_exceed_budget(self):
        budget = 24 * 1024 * 1024
        instances = [
            {"sop": str(index), "id": str(index), "size": 1024 * 1024}
            for index in range(30)
        ]
        batches = plan_batches(instances, budget)
        self.assertEqual(sum(map(len, batches)), 30)
        for batch in batches:
            parts = [(item["sop"], b"0" * item["size"]) for item in batch]
            body, _content_type = multipart(parts, budget)
            self.assertLessEqual(len(body), budget)

    def test_failed_sop_sequence_is_exact(self):
        self.assertEqual(failed_sops({
            "00081198": {"vr": "SQ", "Value": [{
                "00081155": {"vr": "UI", "Value": ["1.2.3"]},
            }]},
        }), {"1.2.3"})

    def test_completed_study_reopens_without_forgetting_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Queue(str(Path(directory) / "queue.db"))
            queue.record_changes([("1.2.3", "orthanc-id")], 10)
            queue.add_successes("1.2.3", {"1.2.3.1"}, 1)
            queue.complete("1.2.3", 1)
            queue.close()

            reopened = Queue(str(Path(directory) / "queue.db"))
            reopened.record_changes([("1.2.3", "orthanc-id")], 11)
            self.assertEqual(reopened.due()["phase"], "pending")
            self.assertEqual(reopened.successes("1.2.3"), {"1.2.3.1"})
            reopened.close()

    def test_single_oversize_instance_is_terminal_and_visible(self):
        budget = 24 * 1024 * 1024
        with self.assertRaises(PermanentGatewayError):
            plan_batches([{"sop": "1.2.3.1", "id": "one", "size": budget}], budget)

        with tempfile.TemporaryDirectory() as directory:
            queue = Queue(str(Path(directory) / "queue.db"))
            queue.record_changes([("1.2.3", "orthanc-id")], 10)
            queue.fail("1.2.3", "single DICOM instance exceeds byte budget")
            summary = queue.summary()
            self.assertEqual(summary["pending"], 0)
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(summary["rows"][0]["phase"], "failed")
            self.assertIn("byte budget", summary["rows"][0]["lastError"])
            self.assertIsNone(queue.due())
            queue.close()

    def test_agent_stops_retrying_a_permanent_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "queue.db")
            config = Config(
                orthanc_url="http://local.invalid", orthanc_user="u", orthanc_pass="p",
                kin_base_url="https://cloud.invalid", client_id="c", client_secret="s",
                tls_verify=True, queue_db=database, byte_budget=24 * 1024 * 1024,
                poll_seconds=0.2, http_timeout=1, stow_timeout=1,
                backoff_base=1, backoff_max=10,
            )
            agent = Agent(config)
            agent.queue.record_changes([("1.2.3", "orthanc-id")], 10)
            agent.poll_changes = lambda: None

            def permanent(_row):
                agent.stopping = True
                raise PermanentGatewayError("single DICOM instance exceeds byte budget")

            agent.process = permanent
            agent.run()

            queue = Queue(database)
            summary = queue.summary()
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(summary["pending"], 0)
            self.assertEqual(summary["rows"][0]["attempt"], 0)
            self.assertIsNone(queue.due())
            queue.close()


class ReceiptErrorCodeTests(unittest.TestCase):
    """S4-U3 contract test 8 (agent side): every GatewayError message has an explicit errorCode."""

    def test_every_gateway_error_literal_is_mapped_and_nothing_else_is(self):
        found = constructed_errors(SOURCE)
        self.assertGreaterEqual(len(found), len(GATEWAY_ERROR_CODES))
        unmapped = [(line, template) for line, template in found if template not in GATEWAY_ERROR_CODES]
        self.assertEqual(unmapped, [], "a GatewayError whose message has no errorCode mapping")
        self.assertEqual(set(GATEWAY_ERROR_CODES), {template for _line, template in found}, "stale mapping entry")

    def test_a_new_unmapped_or_non_literal_error_is_caught(self):
        for added in ('raise GatewayError("a new failure nobody mapped")',
                      'raise PermanentGatewayError(f"a new permanent failure {x}")',
                      'raise GatewayError(reason)',
                      'raise GatewayError("a %s" % x)',
                      'error = GatewayError("built, raised later")'):
            with self.subTest(added=added):
                probe = SOURCE + "\n\ndef _probe(x, reason):\n    " + added + "\n"
                self.assertTrue([t for _line, t in constructed_errors(probe) if t not in GATEWAY_ERROR_CODES])

    def test_codes_follow_templates_and_everything_else_is_other(self):
        for template, code in GATEWAY_ERROR_CODES.items():
            message = template.replace("{}", "X9")
            with self.subTest(template=template):
                self.assertEqual(error_code(GatewayError(message)), code)
                self.assertEqual(error_code(PermanentGatewayError(message)), code)
                # One template per sample: the table order can never be what decides a code.
                self.assertEqual(1, sum(1 for pattern, _code in agent_module._ERROR_PATTERNS if pattern.fullmatch(message)))
        self.assertEqual(error_code(GatewayError("local Orthanc ConnectionError")), "local_orthanc_unreachable")
        self.assertEqual(error_code(GatewayError("local Orthanc HTTP 503")), "local_orthanc_http")
        for error in (GatewayError("unheard of"), GatewayError("STOW HTTP 500 extra words"),
                      ValueError("STOW HTTP 500"), KeyError("StudyInstanceUID"), RuntimeError("")):
            with self.subTest(error=repr(error)):
                self.assertEqual(error_code(error), GATEWAY_ERROR_FALLBACK)
        for code in [*GATEWAY_ERROR_CODES.values(), GATEWAY_ERROR_FALLBACK]:
            self.assertRegex(code, r"^[a-z][a-z_]{0,39}$")


class ReceiptQueueTests(unittest.TestCase):
    """S4-U3 queue side: epoch with the database, seq with every receipt field, closed body."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.path = str(self.directory / "queue.db")

    def queue(self, path: str | None = None) -> Queue:
        queue = Queue(path or self.path)
        self.addCleanup(queue.close)
        return queue

    def announced(self, queue: Queue, uid: str = "1.2.3", local: int = 12, success: int = 0) -> None:
        queue.record_changes([(uid, "orthanc-id")], 1)
        queue.phase(uid, "announcing")
        queue.announced(uid, local, success)

    def seq(self, queue: Queue, uid: str = "1.2.3") -> int:
        return int(queue.db.execute("SELECT seq FROM studies WHERE uid=?", (uid,)).fetchone()["seq"])

    def test_epoch_is_born_with_the_queue_and_survives_reopen(self):
        first = self.queue()
        self.assertIsNotNone(EPOCH.fullmatch(first.epoch), first.epoch)
        epoch = first.epoch
        first.close()
        self.assertEqual(self.queue().epoch, epoch)
        self.assertNotEqual(self.queue(str(self.directory / "recreated.db")).epoch, epoch)

    def test_pre_receipt_queue_is_upgraded_in_place_and_owes_nothing(self):
        db = sqlite3.connect(self.path)
        db.executescript("""
          CREATE TABLE studies (
            uid TEXT PRIMARY KEY, orthanc_id TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'pending',
            batch_index INTEGER NOT NULL DEFAULT 0, successful_sops TEXT NOT NULL DEFAULT '[]',
            attempt INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, last_error TEXT,
            updated_at REAL NOT NULL);
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO studies(uid, orthanc_id, phase, successful_sops, updated_at)
            VALUES ('1.2.3', 'orthanc-id', 'complete', '["1.2.3.1"]', 1);
          INSERT INTO meta(key, value) VALUES ('changes_since', '42');
        """)
        db.commit()
        db.close()
        queue = self.queue()
        self.assertIsNotNone(EPOCH.fullmatch(queue.epoch))
        self.assertEqual(queue.changes_since(), 42)
        self.assertEqual(queue.successes("1.2.3"), {"1.2.3.1"})
        self.assertEqual((queue.summary()["complete"], queue.summary()["pending"]), (1, 0))
        # The pre-receipt agent finished this study; this one never announced it, so nothing is owed or sent.
        self.assertIsNone(queue.receipt("1.2.3"))
        self.assertEqual(queue.unreported(), [])
        epoch = queue.epoch
        queue.close()
        self.assertEqual(self.queue().epoch, epoch)   # a second open neither re-adds columns nor re-mints

    def test_seq_advances_in_the_same_update_as_every_receipt_field(self):
        queue = self.queue()
        queue.record_changes([("1.2.3", "orthanc-id")], 1)
        steps = [
            lambda: queue.phase("1.2.3", "announcing"),
            lambda: queue.announced("1.2.3", 4, 0),
            lambda: queue.phase("1.2.3", "sending", 1),
            lambda: queue.counts("1.2.3", 4, 2),
            lambda: queue.retry("1.2.3", "STOW HTTP 503", 1, 10, "stow_http"),
            lambda: queue.pending_now("1.2.3", 5, 2),
            lambda: queue.complete("1.2.3", 5),
            lambda: queue.record_changes([("1.2.3", "orthanc-id")], 2),
            lambda: queue.fail("1.2.3", "single DICOM instance exceeds byte budget", "instance_exceeds_budget"),
        ]
        seen = [self.seq(queue)]
        for step in steps:
            step()
            seen.append(self.seq(queue))
        self.assertEqual(seen, list(range(seen[0], seen[0] + len(steps) + 1)))
        queue.add_successes("1.2.3", {"1.2.3.9"}, 3)   # not a receipt field
        self.assertEqual(self.seq(queue), seen[-1])
        for phase in ("done", "retry", "failed"):     # refused writes allocate nothing
            with self.assertRaises(ValueError):
                queue.phase("1.2.3", phase)
        self.assertEqual(self.seq(queue), seen[-1])
        # The phase and its seq are one statement: an aborted phase write moves neither.
        queue.db.execute("CREATE TRIGGER refuse_sending BEFORE UPDATE OF phase ON studies "
                         "WHEN NEW.phase='sending' BEGIN SELECT RAISE(ABORT, 'refused'); END")
        before = tuple(queue.db.execute("SELECT phase, seq FROM studies WHERE uid='1.2.3'").fetchone())
        with self.assertRaises(sqlite3.DatabaseError):
            queue.phase("1.2.3", "sending", 4)
        self.assertEqual(tuple(queue.db.execute("SELECT phase, seq FROM studies WHERE uid='1.2.3'").fetchone()), before)

    def test_receipt_exists_only_after_announce_and_is_the_closed_body(self):
        queue = self.queue()
        queue.record_changes([("1.2.3", "orthanc-id")], 1)
        queue.phase("1.2.3", "announcing")
        self.assertIsNone(queue.receipt("1.2.3"))     # KIN would answer 404 before announce
        self.assertEqual(queue.unreported(), [])
        queue.announced("1.2.3", 12, 0)
        body = queue.receipt("1.2.3")
        self.assertEqual(set(body), RECEIPT_KEYS)
        self.assertEqual(body, {"studyUid": "1.2.3", "phase": "announcing", "attempt": 0, "successCount": 0,
                                "localCount": 12, "errorCode": None, "epoch": queue.epoch, "seq": body["seq"]})
        reason = "STOW HTTP 503 SYNTHETIC^PATIENT free text"
        queue.retry("1.2.3", reason, 1, 10, error_code(GatewayError("STOW HTTP 503")))
        body = queue.receipt("1.2.3")
        self.assertEqual((body["phase"], body["attempt"], body["errorCode"]), ("retry", 1, "stow_http"))
        self.assertNotIn("SYNTHETIC", json.dumps(body))
        self.assertNotIn("free text", json.dumps(body))
        queue.complete("1.2.3", 12)
        body = queue.receipt("1.2.3")
        self.assertEqual((body["phase"], body["attempt"], body["successCount"], body["localCount"], body["errorCode"]),
                         ("complete", 0, 12, 12, None))
        queue.fail("1.2.3", "anything", "Not A Code")  # a stored code is always one of the closed set
        self.assertEqual(queue.receipt("1.2.3")["errorCode"], GATEWAY_ERROR_FALLBACK)
        self.assertEqual(set(queue.receipt("1.2.3")), RECEIPT_KEYS)

    def test_host_clock_jumps_do_not_order_receipts(self):
        """Contract test 7: a host clock a year ahead or behind changes neither seq nor epoch."""
        queue = self.queue()
        self.announced(queue, local=3)
        year, real, seqs = 365 * 24 * 3600, time.time(), []
        for index, offset in enumerate((year, -year, year, -2 * year)):
            with patch.object(agent_module.time, "time", return_value=real + offset):
                queue.counts("1.2.3", 3, index % 4)
                body = queue.receipt("1.2.3")
            seqs.append(body["seq"])
            self.assertEqual(body["epoch"], queue.epoch)
            self.assertEqual(set(body), RECEIPT_KEYS)
        self.assertEqual(seqs, list(range(seqs[0], seqs[0] + 4)))

    def test_reopen_after_complete_is_a_newer_report_never_a_rewrite(self):
        """Contract test 9 (agent side): complete M==N, then a late instance reopens the study."""
        queue = self.queue()
        self.announced(queue, local=3)
        queue.complete("1.2.3", 3)
        done = queue.receipt("1.2.3")
        queue.record_changes([("1.2.3", "orthanc-id")], 2)
        reopened = queue.receipt("1.2.3")
        self.assertEqual((done["phase"], done["successCount"], done["localCount"]), ("complete", 3, 3))
        self.assertGreater(reopened["seq"], done["seq"])
        self.assertEqual(reopened["epoch"], done["epoch"])
        self.assertEqual((reopened["phase"], reopened["successCount"], reopened["localCount"]), ("pending", 3, 3))
        self.assertEqual(queue.unreported(), ["1.2.3"])


class ReceiptDeliveryTests(unittest.TestCase):
    """S4-U3 delivery: final KIN answers are recorded, owed receipts retried, the transfer never touched."""

    def agent(self, **changes) -> Agent:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        agent = Agent(config(str(Path(directory.name) / "queue.db"), **changes))
        self.addCleanup(agent.queue.close)
        return agent

    def announced(self, agent: Agent, uid: str = "1.2.3") -> None:
        agent.queue.record_changes([(uid, "orthanc-id")], 1)
        agent.queue.phase(uid, "announcing")
        agent.queue.announced(uid, 4, 1)

    def test_final_answers_are_recorded_and_owed_ones_stay_owed(self):
        agent, answers, sent = self.agent(), [], []

        def receipt(body):
            sent.append(json.dumps(body, sort_keys=True))
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        agent.cloud.receipt = receipt
        self.announced(agent)
        for answer, final in ((FakeResponse(503), False), (GatewayError("cloud request ConnectTimeout"), False),
                              (FakeResponse(401), False), (FakeResponse(200, {"result": "stored"}), True)):
            answers.append(answer)
            self.assertEqual(agent.report("1.2.3"), final)
            self.assertEqual(agent.queue.unreported(), [] if final else ["1.2.3"])
        self.assertEqual(len(set(sent)), 1, "an owed receipt is resent unchanged")
        agent.flush_receipts()
        self.assertEqual(len(sent), 4, "an answered receipt is not sent again")
        for status, code in ((404, None), (409, "GATEWAY_EPOCH_UNRECOGNISED"), (409, "GATEWAY_RECEIPT_CONFLICT"),
                             (400, None)):
            with self.subTest(status=status, code=code):
                agent.queue.counts("1.2.3", 4, 2)   # a newer state
                answers.append(FakeResponse(status, {"code": code} if code else None))
                self.assertTrue(agent.report("1.2.3"))
                self.assertEqual(agent.queue.unreported(), [], "a refused body is final; it is not retried")
        self.assertEqual(answers, [])

    def test_flush_stops_at_the_first_failure_backs_off_and_resumes(self):
        agent, calls = self.agent(), []
        self.announced(agent, "1.2.3")
        self.announced(agent, "1.2.4")
        agent.cloud.receipt = lambda body: calls.append(body["studyUid"]) or FakeResponse(503)
        agent.flush_receipts()
        self.assertEqual(len(calls), 1)
        self.assertGreater(agent.receipts_resume_at, time.monotonic())
        agent.flush_receipts()
        self.assertEqual(len(calls), 1, "still backing off")
        agent.receipts_resume_at = 0.0
        agent.cloud.receipt = lambda body: calls.append(body["studyUid"]) or FakeResponse(200, {"result": "stored"})
        agent.flush_receipts()
        self.assertEqual(sorted(calls[1:]), ["1.2.3", "1.2.4"])
        self.assertEqual((agent.receipt_failures, agent.queue.unreported()), (0, []))

    def test_a_failing_receipt_never_changes_the_transfer(self):
        for failure in (GatewayError("cloud request ConnectionError"), RuntimeError("boom"), FakeResponse(500)):
            with self.subTest(failure=repr(failure)):
                agent = self.agent()
                agent.orthanc = FakeOrthanc(["1.2.3.1", "1.2.3.2"])

                def receipt(body, failure=failure):
                    if isinstance(failure, Exception):
                        raise failure
                    return failure

                agent.cloud = FakeCloud(receipt)
                agent.queue.record_changes([("1.2.3", "orthanc-id")], 1)
                agent.process(agent.queue.due())
                row = agent.queue.summary()["rows"][0]
                self.assertEqual((row["phase"], row["successfulSops"], row["attempt"]), ("complete", 2, 0))
                self.assertEqual(agent.cloud.stowed, ["1.2.3"])
                body = agent.queue.receipt("1.2.3")
                self.assertEqual((body["phase"], body["successCount"], body["localCount"]), ("complete", 2, 2))
                self.assertEqual(agent.queue.unreported(), ["1.2.3"], "the final state is still owed")

    def test_process_reports_announce_and_each_batch_then_flush_sends_the_final_state(self):
        # A 700-byte budget holds one 16-byte instance per batch, so three instances are three batches.
        agent, sent = self.agent(byte_budget=700), []
        agent.orthanc = FakeOrthanc(["1.2.3.1", "1.2.3.2", "1.2.3.3"])
        agent.cloud = FakeCloud(lambda body: sent.append(dict(body)) or FakeResponse(200, {"result": "stored"}))
        agent.queue.record_changes([("1.2.3", "orthanc-id")], 1)
        agent.process(agent.queue.due())
        self.assertEqual(agent.cloud.stowed, ["1.2.3"] * 3)
        self.assertEqual([(b["phase"], b["successCount"], b["localCount"]) for b in sent],
                         [("announcing", 0, 3), ("sending", 1, 3), ("sending", 2, 3), ("sending", 3, 3)])
        self.assertEqual(agent.queue.unreported(), ["1.2.3"])
        agent.flush_receipts()
        self.assertEqual((sent[-1]["phase"], sent[-1]["successCount"], sent[-1]["localCount"]), ("complete", 3, 3))
        seqs = [b["seq"] for b in sent]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertTrue(all(set(b) == RECEIPT_KEYS and b["epoch"] == agent.queue.epoch for b in sent))
        self.assertEqual(agent.queue.unreported(), [])


UID = "1.2.3"


def duplicate_or_stored(body):
    """KIN's answer when it already holds the retry state and stores everything newer."""
    return FakeResponse(200, {"studyUid": body["studyUid"], "result": "duplicate" if body["phase"] == "retry" else "stored"})


class RetryCloud:
    """The Now Retry poll and the receipt route; queued answers first, then `default`. Records every call."""

    def __init__(self):
        self.polls, self.confirms, self.default = [], [], duplicate_or_stored
        self.poll_epochs, self.sent, self.announced, self.stowed, self.stow_error = [], [], [], [], None

    def retry_requests(self, epoch):
        self.poll_epochs.append(epoch)
        answer = self.polls.pop(0) if self.polls else FakeResponse(200, {"studyUids": []})
        if isinstance(answer, Exception):
            raise answer
        return answer

    def receipt(self, body):
        self.sent.append(dict(body))
        answer = self.confirms.pop(0) if self.confirms else self.default
        answer = answer(body) if callable(answer) else answer
        if isinstance(answer, Exception):
            raise answer
        return answer

    def announce(self, uid, institution_name):
        self.announced.append(uid)

    def stow(self, uid, body, content_type):
        self.stowed.append(uid)
        if self.stow_error:
            raise self.stow_error()
        return set()


class NoOrthanc:
    """The Now Retry path must never read the hospital Orthanc; any attribute use is recorded."""

    def __init__(self):
        self.touched = []

    def __getattr__(self, name):
        self.touched.append(name)
        raise AssertionError("the retry path touched Orthanc." + name)


class RetryNowTests(unittest.TestCase):
    """S4-U4 Now Retry, agent side: one exact retry state made eligible now; nothing else moves."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "queue.db")
        self.events = []
        logging = patch.object(agent_module, "log", side_effect=lambda event, **fields: self.events.append((event, fields)))
        logging.start()
        self.addCleanup(logging.stop)

    def agent(self, cloud: RetryCloud) -> Agent:
        agent = Agent(config(self.path, backoff_base=60, backoff_max=600))
        self.addCleanup(agent.queue.close)
        agent.cloud, agent.orthanc = cloud, NoOrthanc()
        agent.retry_poll_at = 0.0   # the next call polls; test T5 holds the real schedule
        return agent

    def queue(self) -> Queue:
        queue = Queue(self.path)
        self.addCleanup(queue.close)
        return queue

    def in_retry(self, queue: Queue, uid: str = UID) -> float:
        """A study that sent one of its SOPs, failed a batch and is backing off; KIN already holds this state."""
        queue.record_changes([(uid, "orthanc-id")], 1)
        queue.phase(uid, "announcing")
        queue.announced(uid, 4, 1)
        queue.add_successes(uid, {uid + ".1"}, 1)
        queue.phase(uid, "sending", 2)
        _attempt, delay = queue.retry(uid, "STOW HTTP 503 SYNTHETIC^PATIENT free text", 60, 600, "stow_http")
        queue.reported(uid, queue.receipt(uid)["seq"])
        return delay

    def row(self, queue: Queue, uid: str = UID):
        found = queue.db.execute("SELECT * FROM studies WHERE uid=?", (uid,)).fetchone()
        return dict(found) if found else None

    def rows(self, queue: Queue):
        return [dict(row) for row in queue.db.execute("SELECT * FROM studies ORDER BY uid")]

    def deliver(self, agent: Agent, *uids: str) -> None:
        agent.cloud.polls.append(FakeResponse(200, {"studyUids": list(uids)}))
        agent.retry_poll_at = 0.0
        agent.retry_requests()

    def test_t1_retry_now_moves_only_next_at_of_the_exact_retry_state(self):
        queue = self.queue()
        self.in_retry(queue)
        before, body, owed = self.row(queue), queue.receipt(UID), queue.unreported()
        meta = [tuple(row) for row in queue.db.execute("SELECT key, value FROM meta ORDER BY key")]
        now = time.time()
        self.assertGreater(before["next_at"], now)
        self.assertIsNone(queue.due())
        self.assertTrue(queue.waiting(UID, before["seq"], now))
        self.assertTrue(queue.retry_now(UID, before["seq"], now))
        after = self.row(queue)
        self.assertEqual({key for key in before if before[key] != after[key]}, {"next_at"})
        self.assertEqual(after["next_at"], 0)
        # attempt, the free reason, the code, the sent SOPs, the counts, seq and updated_at all stay.
        self.assertEqual((after["attempt"], after["error_code"], after["successful_sops"], after["batch_index"]),
                         (1, "stow_http", '["1.2.3.1"]', 2))
        self.assertIn("SYNTHETIC", after["last_error"])
        self.assertEqual(queue.receipt(UID), body, "nothing new for KIN: the receipt and its seq did not move")
        self.assertEqual(queue.unreported(), owed)
        self.assertEqual([tuple(row) for row in queue.db.execute("SELECT key, value FROM meta ORDER BY key")], meta)
        self.assertEqual(queue.due()["uid"], UID, "eligible now")
        self.assertFalse(queue.waiting(UID, before["seq"], now))
        self.assertFalse(queue.retry_now(UID, before["seq"], now), "a second nudge changes nothing")
        self.assertEqual(self.row(queue), after)

    def test_t2_every_other_state_seq_or_uid_is_refused_byte_identically(self):
        queue = self.queue()
        self.in_retry(queue, "1.2.15")
        for uid, steps in (
            ("1.2.10", [lambda u: queue.fail(u, "single DICOM instance exceeds byte budget", "instance_exceeds_budget")]),
            ("1.2.11", [lambda u: queue.complete(u, 4)]),
            ("1.2.12", []),
            ("1.2.13", [lambda u: queue.phase(u, "announcing")]),
            ("1.2.14", [lambda u: queue.phase(u, "announcing"), lambda u: queue.announced(u, 4, 0),
                        lambda u: queue.phase(u, "sending", 1)]),
        ):
            queue.record_changes([(uid, "orthanc-id")], 1)
            for step in steps:
                step(uid)
        now, before = time.time(), self.rows(queue)
        expected = {"1.2.10": "failed", "1.2.11": "complete", "1.2.12": "pending", "1.2.13": "announcing",
                    "1.2.14": "sending", "1.2.15": "retry"}
        self.assertEqual({row["uid"]: row["phase"] for row in before}, expected)
        seq = {row["uid"]: row["seq"] for row in before}
        refused = [(uid, seq[uid], now) for uid in expected if uid != "1.2.15"]
        refused += [("1.2.15", seq["1.2.15"] - 1, now), ("1.2.15", seq["1.2.15"] + 1, now),
                    ("1.2.15", seq["1.2.15"], now + 3600),   # the backoff is already over at that time
                    ("9.9.9", 1, now), ("9.9.9", 0, now)]
        for uid, value, at in refused:
            with self.subTest(uid=uid, seq=value, at=at - now):
                self.assertFalse(queue.waiting(uid, value, at))
                self.assertFalse(queue.retry_now(uid, value, at))
                self.assertEqual(self.rows(queue), before, "a refused nudge changed or inserted a row")

    def test_t3_only_an_exact_duplicate_of_the_current_body_applies(self):
        cloud = RetryCloud()
        agent = self.agent(cloud)
        self.in_retry(agent.queue)
        seq = agent.queue.receipt(UID)["seq"]
        cases = [
            (FakeResponse(200, {"studyUid": UID, "result": "stored"}), True),     # KIN held an older state
            (FakeResponse(200, {"studyUid": UID, "result": "stale"}), True),      # this queue went back in time
            (FakeResponse(200, {"studyUid": "1.2.4", "result": "duplicate"}), True),
            (FakeResponse(200, {"studyUid": UID, "result": "duplicate", "extra": 1}), True),
            (FakeResponse(200, {"result": "duplicate"}), True),
            (FakeResponse(200, None), True),
            (FakeResponse(200, ["duplicate"]), True),
            (FakeResponse(400, {"code": "GATEWAY_RECEIPT_INVALID"}), True),
            (FakeResponse(404, {"code": "GATEWAY_RECEIPT_STUDY_NOT_FOUND"}), True),
            (FakeResponse(409, {"code": "GATEWAY_EPOCH_UNRECOGNISED"}), True),
            (FakeResponse(409, {"code": "GATEWAY_RECEIPT_CONFLICT"}), True),
            (FakeResponse(401), False),
            (FakeResponse(503, {"studyUid": UID, "result": "duplicate"}), False),
            (GatewayError("cloud request ConnectTimeout"), False),
            (RuntimeError("boom"), False),
        ]
        for answer, final in cases:
            with self.subTest(answer=repr(getattr(answer, "body", answer)), status=getattr(answer, "status_code", None)):
                with agent.queue.db:
                    agent.queue.db.execute("UPDATE studies SET reported_seq=0 WHERE uid=?", (UID,))
                before = self.row(agent.queue)
                cloud.confirms.append(answer)
                self.deliver(agent, UID)
                after = self.row(agent.queue)
                self.assertEqual(after["next_at"], before["next_at"], "applied without an exact duplicate")
                # U3's final-answer bookkeeping: a 2xx or 400/404/409 answered this body; anything else stays owed.
                self.assertEqual({key for key in before if before[key] != after[key]}, {"reported_seq"} if final else set())
                self.assertEqual(after["reported_seq"], seq if final else 0)
        self.assertEqual(len(cloud.sent), len(cases))
        self.assertTrue(all(body == agent.queue.receipt(UID) for body in cloud.sent), "the confirmation is the unchanged U3 body")
        self.deliver(agent, UID)   # the default answer: KIN holds exactly this retry state
        self.assertEqual((self.row(agent.queue)["next_at"], self.row(agent.queue)["seq"]), (0, seq))
        self.assertEqual([fields for event, fields in self.events if event == "study.retry_now"], [{"uid": UID, "attempt": 1}])

    def test_t4_repeat_delivery_and_restart_apply_at_most_once(self):
        cloud = RetryCloud()
        self.in_retry(self.queue())
        # Restart before the nudge: a new process on the same queue (same epoch) applies it once.
        agent = self.agent(cloud)
        self.deliver(agent, UID)
        applied = self.row(agent.queue)
        self.assertEqual((len(cloud.sent), applied["next_at"]), (1, 0))
        # A poll answer lost and asked again, or simply delivered twice more: no POST and no change.
        self.deliver(agent, UID)
        self.deliver(agent, UID)
        self.assertEqual(len(cloud.sent), 1)
        self.assertEqual(self.row(agent.queue), applied)
        # Restart after the nudge: it is durable, the row is eligible, and another delivery still sends nothing.
        agent.queue.close()
        agent = self.agent(cloud)
        self.assertEqual(self.row(agent.queue), applied)
        self.assertEqual(agent.queue.due()["uid"], UID)
        self.deliver(agent, UID)
        self.assertEqual(len(cloud.sent), 1)
        self.assertEqual(cloud.poll_epochs, [agent.queue.epoch] * 4)
        self.assertEqual(len([event for event, _fields in self.events if event == "study.retry_now"]), 1)

    def test_t4_a_failed_manual_attempt_climbs_the_ladder_and_a_stale_redelivery_applies_nothing(self):
        first_delay = self.in_retry(self.queue())
        cloud = RetryCloud()
        agent = self.agent(cloud)
        first = self.row(agent.queue)
        agent.orthanc = FakeOrthanc([UID + ".1", UID + ".2"])
        agent.poll_changes = lambda: None

        def refused_batch():
            agent.stopping = True
            return GatewayError("STOW HTTP 503")

        cloud.stow_error = refused_batch
        cloud.polls.append(FakeResponse(200, {"studyUids": [UID]}))
        with patch.object(Queue, "pending_now") as pending_now:
            agent.run()   # flush, Now Retry (applied), then the real process() of the nudged row fails again
        self.assertFalse(pending_now.called)
        self.assertEqual(cloud.stowed, [UID])
        queue = self.queue()
        second = self.row(queue)
        self.assertEqual((second["phase"], second["attempt"], second["error_code"], second["successful_sops"]),
                         ("retry", first["attempt"] + 1, "stow_http", '["1.2.3.1"]'))
        self.assertGreater(second["seq"], first["seq"])
        [retried] = [fields for event, fields in self.events if event == "study.retry"]
        self.assertEqual(retried["attempt"], 2)
        self.assertGreaterEqual(retried["afterSeconds"], first_delay, "the ladder kept climbing; nothing reset it")
        self.assertGreater(second["next_at"] - time.time(), first_delay - 1)
        queue.close()
        # KIN still (wrongly) delivers the old request: `stored` or `stale` for the current body applies nothing.
        agent = self.agent(cloud)
        for answer in (FakeResponse(200, {"studyUid": UID, "result": "stored"}),
                       FakeResponse(200, {"studyUid": UID, "result": "stale"})):
            cloud.confirms.append(answer)
            self.deliver(agent, UID)
            self.assertEqual(self.row(agent.queue)["next_at"], second["next_at"])
        self.assertEqual(len([event for event, _fields in self.events if event == "study.retry_now"]), 1)

    def test_t5_fixed_slow_poll_first_after_a_full_period_and_nothing_shortens_it(self):
        clock = [1000.0]
        invalid = [FakeResponse(503), FakeResponse(200, None), FakeResponse(200, {"studyUids": UID}),
                   FakeResponse(200, {"studyUids": [1]}), FakeResponse(200, {"studyUids": [UID], "count": 1}),
                   FakeResponse(200, {"studyUids": [UID, UID]}), FakeResponse(200, {"studyUids": ["1.2.x"]}),
                   FakeResponse(200, {"studyUids": ["%d.1" % n for n in range(101)] + [UID]}),
                   FakeResponse(200, [[UID]]), GatewayError("cloud request ConnectionError"), RuntimeError("boom")]
        with patch.object(agent_module.time, "monotonic", lambda: clock[0]):
            cloud = RetryCloud()
            agent = Agent(config(self.path, backoff_base=60, backoff_max=600))
            self.addCleanup(agent.queue.close)
            agent.cloud, agent.orthanc = cloud, NoOrthanc()
            self.in_retry(agent.queue)   # a lax parser would confirm UID from one of the invalid answers
            cloud.polls.extend(invalid)
            polled = []
            for t in range(0, 301, 2):
                clock[0] = 1000.0 + t
                before = len(cloud.poll_epochs)
                agent.retry_requests()   # never raises
                if len(cloud.poll_epochs) > before:
                    polled.append(t)
            self.assertEqual(polled, list(range(30, 301, 30)), "first poll one period after start, then every 30 s")
            self.assertEqual(cloud.sent, [], "no invalid answer reached a confirmation")
            self.assertGreater(self.row(agent.queue)["next_at"], time.time(), "the retry row still waits out its backoff")
            # Owed receipts backing off (F6): the tick passes without a poll and the cadence is not shortened after.
            agent.receipts_resume_at = 1000.0 + 365
            polled = []
            for t in range(302, 421, 2):
                clock[0] = 1000.0 + t
                before = len(cloud.poll_epochs)
                agent.retry_requests()
                if len(cloud.poll_epochs) > before:
                    polled.append(t)
            self.assertEqual(polled, [390, 420])
        self.assertEqual(set(cloud.poll_epochs), {agent.queue.epoch}, "the poll carries only this queue's epoch")
        codes = [event for event, _fields in self.events if event.startswith("retry_request.")]
        self.assertEqual(len(codes), len(invalid))
        self.assertFalse(any("SYNTHETIC" in json.dumps(fields) for _event, fields in self.events))

    def test_t6_retry_path_never_announces_stows_or_reads_orthanc_and_ignores_unknown_uids(self):
        cloud = RetryCloud()
        agent = self.agent(cloud)
        self.in_retry(agent.queue, "1.2.3")
        agent.queue.record_changes([("1.2.5", "orthanc-id")], 2)   # pending, never announced: no receipt
        self.in_retry(agent.queue, "1.2.6")
        agent.queue.fail("1.2.6", "single DICOM instance exceeds byte budget", "instance_exceeds_budget")
        before = self.rows(agent.queue)
        self.deliver(agent, "9.9.9", "1.2.5", "1.2.6", "1.2.3", "1.2.7")
        self.assertEqual([body["studyUid"] for body in cloud.sent], ["1.2.3"])
        self.assertEqual((cloud.announced, cloud.stowed, agent.orthanc.touched), ([], [], []))
        after = self.rows(agent.queue)
        self.assertEqual([row["uid"] for row in after], [row["uid"] for row in before], "no row for an unknown UID")
        changed = [(b["uid"], sorted(k for k in b if b[k] != a[k])) for b, a in zip(before, after) if b != a]
        self.assertEqual(changed, [("1.2.3", ["next_at"])])
        self.assertTrue(all(set(fields) <= {"uid", "attempt", "status", "error"} for _event, fields in self.events))


if __name__ == "__main__":
    unittest.main()
