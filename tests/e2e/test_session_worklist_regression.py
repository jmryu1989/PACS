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
    """Every WorklistE2E case, the comparison viewer included, on the stack that setup_stack selects."""


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(WorklistContractRegression(name) for name in sorted(vars(original.WorklistE2E))
                              if name.startswith("test_"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
