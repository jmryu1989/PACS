"""U5S-REQ-26 -> U5S-RISK-EVIDENCE -> entry-test sensitivity.

Single-line product mutants exist only in a browser-served memory copy. The real
BFF/Keycloak stack is unchanged. Only each named behavioral assertion is accepted
as a kill; network errors, setup failures and unexpected passes fail this suite.
"""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_session_draft_boundaries as boundary


class SessionDraftMutants(boundary.SessionDraftBoundaries):
    def profile(self, session=None):
        context = super().profile(session)
        if self.mutation is None:
            return context
        source = (Path(__file__).resolve().parents[2] / "worklist-v0/hpacs-lite/auth.js").read_text(encoding="utf-8")
        original, replacement = self.mutation
        self.assertEqual(source.count(original), 1, "Mutation anchor must be unambiguous")
        copied = source.replace(original, replacement)
        context.route("**/worklist/hpacs-lite/auth.js", lambda route: route.fulfill(
            status=200, content_type="application/javascript", body=copied))
        return context

    def test_m01_disabled_auto_login_is_detected(self):
        self.mutation = None
        self.test_no_session_starts_real_idp_login_automatically()
        self.mutation = ("if (!absent || !undecided() || moved) return false;", "return false;")
        with self.assertRaisesRegex(AssertionError, "U5_AUTO_LOGIN"):
            self.test_no_session_starts_real_idp_login_automatically()
        print("U5-MUTANT M01 killed: U5_AUTO_LOGIN")

    def test_m02_bypassed_proof_consumption_is_detected(self):
        self.mutation = None
        self.test_entry_proof_consumed_automatically_once()
        self.mutation = (
            # Since the session end split enter() in two, this line chooses between the proof entry and the plain one.
            "const result = proof || entryBinding ? await enterWithProof() : await enterPlain();",
            "const result = await enterPlain();")
        with self.assertRaisesRegex(AssertionError, "U5_ENTRY_PROOF"):
            self.test_entry_proof_consumed_automatically_once()
        print("U5-MUTANT M02 killed: U5_ENTRY_PROOF")

    def test_m03_disabled_valid_session_bootstrap_is_detected(self):
        self.mutation = None
        self.test_entry_valid_session_and_second_tab_require_no_click()
        self.mutation = (
            "const result = proof || entryBinding ? await enterWithProof() : await enterPlain();",
            "const result = proof || entryBinding ? await enterWithProof() : null;")
        with self.assertRaisesRegex(AssertionError, "U5_ENTRY_ACTIVE"):
            self.test_entry_valid_session_and_second_tab_require_no_click()
        print("U5-MUTANT M03 killed: U5_ENTRY_ACTIVE")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(SessionDraftMutants(name) for name in sorted(vars(SessionDraftMutants))
                              if name.startswith("test_m"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
