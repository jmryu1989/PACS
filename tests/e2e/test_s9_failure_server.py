"""SCN-S9-FAIL-03 -> TEST-S9-U3-SERVER5XX at real draft/list HTTP boundaries.

REQ-S9-U3-INPUT/NO-FALSE-SUCCESS/RECOVERY ->
RISK-S9-U3-LOST-INPUT/FALSE-SUCCESS/DUPLICATE-WRITE/STUCK.
503 is an existing scenario fault, not a new server policy. Both cases include
a real successful request before the fault and a real recovery after removal.
Settings and viewer failures reuse existing cases in the unit case-map.
"""
import unittest

import test_s9_failure_network as network
import test_worklist as worklist


class S9FailureServerE2E(network.FailureCases, worklist.WorklistE2E):
    def test_server_01_draft_503_preserves_input_and_retries(self):
        self.draft_failure(status=503)

    def test_server_02_list_503_preserves_rows_and_recovers(self):
        self.list_failure(status=503)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(S9FailureServerE2E(name) for name in sorted(vars(S9FailureServerE2E))
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
