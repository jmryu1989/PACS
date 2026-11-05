"""CD-09 W-R: isolated PG, real HTTP/C2/B2, using the existing fixture runner."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from online_live import ReportCommitPg


class RelatedBoundariesPg(ReportCommitPg):
    script = 'related_boundaries_pg_test.cjs'

    def test_related_boundaries_http(self):
        self.run_http_script()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite([RelatedBoundariesPg('test_related_boundaries_http')])
