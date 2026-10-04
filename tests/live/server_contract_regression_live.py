"""Run the existing server regression assertions with an explicit public CT source.

The root live module is outside this worker's writable paths. Only its fixture
constructor is substituted during class setup; HTTP requests, expected outcomes,
test methods and cleanup remain the existing suite's. This is not a product mock.
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from session_support import SessionStack
import invariants_live as original


class EntryPointManifestTests(original.EntryPointManifestTests):
    pass


class BffInvariantTests(original.BffInvariantTests):
    @classmethod
    def setUpClass(cls):
        with patch.object(original, "LiveStack", SessionStack):
            super().setUpClass()


class LiveInvariantTests(original.LiveInvariantTests):
    @classmethod
    def setUpClass(cls):
        with patch.object(original, "LiveStack", SessionStack):
            super().setUpClass()


class CriticalResultInvariantTests(original.CriticalResultInvariantTests):
    @classmethod
    def setUpClass(cls):
        with patch.object(original, "LiveStack", SessionStack):
            super().setUpClass()


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(loader.loadTestsFromTestCase(case) for case in (
        EntryPointManifestTests, BffInvariantTests, LiveInvariantTests, CriticalResultInvariantTests))


def tearDownModule():
    original.tearDownModule()


if __name__ == "__main__":
    unittest.main(verbosity=2)
