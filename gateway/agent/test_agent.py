import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent import GatewayError, Queue, failed_sops, multipart, plan_batches


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


if __name__ == "__main__":
    unittest.main()
