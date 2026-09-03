import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent import Agent, Config, PermanentGatewayError, Queue, failed_sops, multipart, plan_batches


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
            queue.complete("1.2.3")
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


if __name__ == "__main__":
    unittest.main()
