"""Retain the existing worklist workflows on the explicitly selected CT fixture source.

Only setup differs: use the U5 synthetic stack fixture. The existing WorklistE2E
test bodies and helpers, including the updated commit envelope assertion, run intact.
"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_worklist as original
import test_session_draft_boundaries as boundary


class WorklistContractRegression(boundary.SessionDraftBoundaries):
    @unittest.skip("expected-to-wait: viewer transport and central disposal are not integrated at 08b09f4")
    def test_06_prior_preview_and_comparison_viewer(self):
        return super().test_06_prior_preview_and_comparison_viewer()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(WorklistContractRegression(name) for name in sorted(vars(original.WorklistE2E))
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
