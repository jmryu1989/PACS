"""C3-LIVE: current unsplit and delivered bundle have the same event behavior.

Historical original/approved/parent equality remains in main_split_historical.py.
This comparison includes every current listener; no W2 events are filtered out.
"""
import unittest
import main_early_input_dom_test as pre


def setUpModule():
    pre.Pages.open()


def tearDownModule():
    pre.Pages.close()


class CurrentLanding(pre.PreCase):
    both = pre.Registration.both

    def test_hosted_request_contract_retains_multiplicity(self):
        from main_load_hosted import assert_script_requests, assert_account_requests
        baseline = [('GET', '/worklist/hpacs-lite/auth.js', '')]
        candidate = baseline + [('GET', '/worklist/hpacs-lite/'+name, '')
                                for name in ('main-split.bundle.js', 'worklist-folder-tree.js')]
        assert_script_requests(baseline, candidate, landing=True)
        for bad in (candidate[:-1], candidate+[candidate[-1]], candidate+[('GET','/extra.js','')]):
            with self.assertRaises(AssertionError):
                assert_script_requests(baseline, bad, landing=True)
        account = [('GET', '/api/me', '')]
        reads = account + [('GET', path, '') for path in ('/api/filter-folders', '/api/shared-filters')]
        assert_account_requests(account, reads)
        for bad in (reads[:-1], reads+[reads[-1]], reads+[('GET','/api/unknown','')]):
            with self.assertRaises(AssertionError):
                assert_account_requests(account, bad)

    def test_current_registration_dispatch_and_retry_schedule(self):
        for outcome in pre.Registration.OUTCOMES:
            for schedule in pre.SCHEDULES if outcome == pre.Registration.OUTCOMES[-1] else ('default',):
                with self.subTest(outcome=outcome, schedule=schedule):
                    base, (before, _, old_errors), (after, _, errors) = self.both(
                        'landing-C3', outcome, schedule=schedule, reference='current')
                    self.assertEqual([], old_errors)
                    self.assertEqual([], errors)
                    self.compare_phases(base, before, after, 'current unsplit to current bundle', dispatches=True)
                    for phase in before:
                        self.assertEqual(before[phase]['screen'], after[phase]['screen'])

    def test_current_held_input_and_leave(self):
        unsplit, bundled = pre.Pages.current.layout(0), pre.Pages.current.layout('actual')
        for hazard in pre.HAZARDS:
            with self.subTest(hazard=hazard):
                before = self.early(hazard, unsplit, hold=unsplit[1]['scripts'][-1])
                after = self.early(hazard, bundled, hold=bundled[1]['bundle'])
                self.assertEqual(before.errors, after.errors)
                self.assertEqual(before.early_screen, after.early_screen)
                self.assertEqual(before.final_screen, after.final_screen)
                self.assertEqual(before.dialogs, after.dialogs)
        self.assertEqual([], self.leaving(bundled, hold=bundled[1]['bundle']))

    test_delivered_asset_hash_is_bound_to_the_actual_body = pre.ActualLayout.test_delivered_asset_hash_is_bound_to_the_actual_body


if __name__ == '__main__':
    unittest.main(verbosity=2)
