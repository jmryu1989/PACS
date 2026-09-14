"""Pure checks of the A11-VOI-1 mutation harness: only an assertion at a preregistered detector is a detection candidate."""
import hashlib, importlib.util, json, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('voi_mutation_harness', HERE / 'harness.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
N1, N2 = harness.MANIFEST['cases']['N1'], harness.MANIFEST['cases']['N2']
TEST = '/home/runner/work/pacs/pacs/tests/e2e/test_volume_mip.py'
NUMPY = '/tmp/mipvoi-python/lib/python3.12/site-packages/numpy/testing/_private/utils.py'
PLAYWRIGHT = '/tmp/mipvoi-python/lib/python3.12/site-packages/playwright/_impl/_assertions.py'
HASHES = [{'path': 'worklist-v0/hpacs-lite/viewer-volume-mip.js', 'sha256': 'a', 'lf_sha256': 'a'}]
PIXELS = [(TEST, 403, N1), (TEST, 386, 'voi_pixels')]


def lf(path):
    return (harness.ROOT / path).read_bytes().replace(b'\r\n', b'\n')


def block(kind, method, frames, exception):
    lines = ['=' * 70, '%s: %s (%s.%s.%s)' % (kind, method, harness.SUITE, harness.WRAPPER_CLASS, method), '-' * 70,
             'Traceback (most recent call last):']
    for path, number, function in frames:
        lines += ['  File "%s", line %d, in %s' % (path, number, function), '    call()', '    ^^^^^^']
    return lines + exception.split('\n') + ['']


def suite_log(method, blocks=(), summary='FAILED (failures=1)', exact=None, status='failed'):
    exact = [harness.SUITE + '.' + harness.WRAPPER_CLASS + '.' + method] if exact is None else exact
    stdout = ['EXACT_TESTS ' + json.dumps(exact), 'PLAN_RESULT ' + json.dumps({'status': status, 'exit_code': 0 if status == 'passed' else 125})]
    stderr = ['%s (%s.%s.%s) ... %s' % (method, harness.SUITE, harness.WRAPPER_CLASS, method, 'FAIL' if blocks else 'ok')]
    for lines in blocks:
        stderr += lines
    stderr += ['-' * 70, 'Ran 1 test in 131.204s', '', summary]
    if status != 'passed':
        stderr.append('TEST_RUN_REFUSED: ' + harness.UNFINISHED_PLAN)
    return '\n'.join(stdout + stderr) + '\n'


def inputs(log, native_exit=1, suite_exit=125, stages=None, **changes):
    stages = [{'name': name, 'exit': 0} for name in harness.SETUP_STAGES] + [{'name': harness.SUITE, 'exit': suite_exit}] if stages is None else stages
    value = {'guard': {'status': 'applied'}, 'selection': {'status': 'frozen'}, 'native_start': {'before': HASHES},
             'native_end': {'after': HASHES, 'exception': 'RuntimeError', 'message': harness.SUITE + ' failed; see sanitized artifact'},
             'native_exit': native_exit, 'stages': stages, 'suite_log': log}
    value.update(changes)
    return value


def semantic(name):
    return harness.MANIFEST['variants'][name]['detectors'][0]['semantic']


def pixel_failure(name, actual, displayed=None, probe=None, cell=None):
    # The exact text voi_pixels produces: unittest's own assertLessEqual with the candidate's message tuple.
    pinned = semantic(name)
    probe = pinned['probe'] if probe is None else probe
    label = tuple(pinned['cell'] if cell is None else cell) + (pinned['label'] if displayed is None else displayed,)
    try:
        unittest.TestCase().assertLessEqual(min(abs(actual - w) for w in [probe['expected']]), 3, (label, 'expected', probe, actual))
    except AssertionError as error:
        return suite_log(N1, [block('FAIL', N1, PIXELS, 'AssertionError: ' + str(error))])
    raise AssertionError('the probe passed')


PLANES = 'AssertionError: 2 != 4 : [[[15.75, 15.75, 0.0], [0.0, 0.0, 1.0]], [[15.75, 15.75, 80.0], [0.0, 0.0, -1.0]]]'


class ObservationTest(unittest.TestCase):
    def test_m1_plane_readback_is_its_preregistered_first_detector_and_says_the_pixel_oracle_is_not_shown(self):
        log = suite_log(N1, [block('FAIL', N1, [(TEST, 395, N1), (TEST, 373, 'voi_native')], PLANES)])
        seen = harness.observe('M1', inputs(log))
        self.assertEqual((seen['observation'], seen['detection_candidate'], seen['detector']['id']),
                         ('assertion-failure-at-preregistered-detector', True, 'n1-readback-plane-count'))
        self.assertIn('zero-fill pixel oracle is not exercised', seen['detector']['proves'])

    def test_m3_world_origin_assertion_through_numpy_frames(self):
        exception = 'AssertionError: \nNot equal to tolerance rtol=0, atol=1e-06\n\nMismatched elements: 3 / 3 (100%)\n ACTUAL: array([31.5, 31.5, 22.2])'
        frames = [(TEST, 395, N1), (TEST, 377, 'voi_native'), (NUMPY, 1504, 'assert_allclose'), (NUMPY, 885, 'assert_array_compare')]
        seen = harness.observe('M3', inputs(suite_log(N1, [block('FAIL', N1, frames, exception)])))
        self.assertEqual((seen['observation'], seen['detector']['id']), ('assertion-failure-at-preregistered-detector', 'n1-world-plane-origin'))

    def test_m5_needs_a_raysum_cell_for_the_denominator_oracle(self):
        raysum = "AssertionError: 17.5 not less than or equal to 3 : (('negative', 'along-ray', 'Coronal', 'Raysum', 'Raysum · Coronal · Final'), 'expected', {}, 140.0)"
        seen = harness.observe('M5', inputs(suite_log(N1, [block('FAIL', N1, PIXELS, raysum)])))
        self.assertEqual(seen['detector']['id'], 'n1-raysum-pixel-oracle')
        mip = raysum.replace("'Raysum', 'Raysum", "'MIP', 'MIP")
        seen = harness.observe('M5', inputs(suite_log(N1, [block('FAIL', N1, PIXELS, mip)])))
        self.assertEqual((seen['observation'], seen['detection_candidate']), ('assertion-failure-outside-preregistered-detectors', False))

    def test_retired_m5_pattern_would_accept_a_rollback_display_which_is_why_it_is_not_dispatchable(self):
        rollback = pixel_failure('M5P', 128, displayed='MinIP · Axial · 91.6 mm · VOI Slab 41 mm · Final')
        self.assertEqual(harness.observe('M5', inputs(rollback))['observation'], 'assertion-failure-at-preregistered-detector')
        self.assertEqual(harness.observe('M5P', inputs(rollback))['observation'], 'assertion-failure-outside-preregistered-detectors')
        self.assertFalse(harness.MANIFEST['variants']['M5']['dispatchable'])

    def test_m1p_zero_fill_on_the_requested_final_display_at_the_preregistered_probe_is_its_detector(self):
        for actual in (127, 128, 124):
            seen = harness.observe('M1P', inputs(pixel_failure('M1P', actual)))
            self.assertEqual((seen['observation'], seen['detector']['id']), ('assertion-failure-at-preregistered-detector', 'n1-zero-fill-pixel-oracle'), actual)
            self.assertEqual(seen['facts']['semantic']['n1-zero-fill-pixel-oracle']['failed'], [])

    def test_m1p_rejects_rollback_other_probe_out_of_band_and_plane_count_failures(self):
        rejected = {
            'rollback to the kept MIP display': pixel_failure('M1P', 127, displayed='MIP · Axial · 91.6 mm · VOI Slab 41 mm · Final'),
            'another probe': pixel_failure('M1P', 127, probe={**semantic('M1P')['probe'], 'world': [5.0, 3.0, 40.0]}),
            'a deviation that is not the 0 HU fill': pixel_failure('M1P', 145),
            'a value nearer a different alternative': pixel_failure('M1P', 139),
            'the plane readback': suite_log(N1, [block('FAIL', N1, [(TEST, 395, N1), (TEST, 373, 'voi_native')], PLANES)]),
        }
        for reason, log in rejected.items():
            seen = harness.observe('M1P', inputs(log))
            self.assertEqual((seen['observation'], seen['detection_candidate']), ('assertion-failure-outside-preregistered-detectors', False), reason)

    def test_m5p_mean_denominator_band_on_raysum_only(self):
        seen = harness.observe('M5P', inputs(pixel_failure('M5P', 152)))
        self.assertEqual((seen['observation'], seen['detector']['id']), ('assertion-failure-at-preregistered-detector', 'n1-mean-denominator-pixel-oracle'))
        for reason, log in {'MinIP cell': pixel_failure('M1P', 127),
                            'expected-side value': pixel_failure('M5P', 170),
                            'Raysum cell elsewhere': pixel_failure('M5P', 152, cell=['negative', 'along-ray', 'Axial', 'Raysum'])}.items():
            self.assertEqual(harness.observe('M5P', inputs(log))['observation'], 'assertion-failure-outside-preregistered-detectors', reason)

    def test_semantic_facts_need_the_voi_pixels_text_and_a_numeric_gray(self):
        pinned = semantic('M1P')
        self.assertFalse(harness.semantic_facts(pinned, '2 != 4 : []')[0])
        detail = (tuple(pinned['cell']) + (pinned['label'],), 'expected', pinned['probe'], True)
        self.assertFalse(harness.semantic_facts(pinned, '23.2 not less than or equal to 3 : ' + repr(detail))[0])

    def test_m4_held_render_assertion_in_n2(self):
        exception = "AssertionError: Locator expected to have attribute 'data-kin-mip-state' 'pending'\nActual value: final"
        seen = harness.observe('M4', inputs(suite_log(N2, [block('FAIL', N2, [(TEST, 430, N2), (PLAYWRIGHT, 120, '_expect_impl')], exception)])))
        self.assertEqual(seen['detector']['id'], 'n2-held-render-pending')

    def test_setup_or_wrong_case_assertions_are_not_detection(self):
        opening = block('FAIL', N1, [(TEST, 392, N1), (TEST, 342, 'opened_voi_study')], 'AssertionError: Locator expected to be visible')
        self.assertEqual(harness.observe('M1', inputs(suite_log(N1, [opening])))['observation'], 'assertion-failure-outside-preregistered-detectors')
        other = block('FAIL', N1, [(TEST, 395, N1), (TEST, 373, 'voi_native')], PLANES)
        self.assertEqual(harness.observe('M4', inputs(suite_log(N1, [other])))['observation'], 'selection-mismatch')

    def test_errors_skips_and_nonzero_exits_without_an_assertion_are_never_detection(self):
        timeout = block('ERROR', N1, [(TEST, 395, N1), (TEST, 349, 'settled')], 'playwright._impl._errors.TimeoutError: Page.wait_for_function: Timeout 40000ms exceeded.')
        cases = {
            'non-assertion-error': inputs(suite_log(N1, [timeout], summary='FAILED (errors=1)')),
            'skipped-capability-or-precondition': inputs(suite_log(N1, summary='OK (skipped=1)')),
            'infrastructure-before-suite': inputs('', stages=[{'name': 'database', 'exit': 0}, {'name': 'stack', 'exit': 1}]),
            'infrastructure-no-stage-record': inputs('', stages='missing'),
            'suite-deadline': inputs('', suite_exit=124),
            'harness-refused-before-native': inputs('', guard={'status': 'refused', 'refusal': 'Refused: Run attempt 2 refused'}),
            'selection-not-frozen': inputs('', selection={'status': 'refused'}),
            'native-not-started': inputs('', native_start=None),
            'native-exit-unknown-cancelled-or-step-deadline': inputs('', native_exit=None),
            'source-hashes-unproven-after-native': inputs('', native_end={'after': [{'path': 'x', 'sha256': 'b', 'lf_sha256': 'b'}]}),
            'selection-mismatch': inputs(suite_log(N1, exact=[harness.SUITE + '.' + harness.WRAPPER_CLASS + '.' + N1, 'x.Y.' + N2])),
            'plan-refused': inputs(suite_log(N1).replace(harness.UNFINISHED_PLAN, 'Unit attempt budget exhausted')),
        }
        for expected, value in cases.items():
            for name in ('M2', 'M1P', 'M5P'):
                seen = harness.observe(name, value)
                self.assertEqual((seen['observation'], seen['detection_candidate']), (expected, False), (name, expected))

    def test_a_passing_target_case_is_reported_as_a_surviving_mutation(self):
        for name in ('M2', 'M1P', 'M5P'):
            seen = harness.observe(name, inputs(suite_log(N1, summary='OK', status='passed'), native_exit=0, suite_exit=0))
            self.assertEqual((seen['observation'], seen['detection_candidate']), ('mutation-survived-target-case-passed', False))


class PreparedFilesTest(unittest.TestCase):
    def test_manifest_keeps_the_five_contract_mutations_and_adds_two_pixel_variants_with_committed_patch_bytes(self):
        variants = harness.MANIFEST['variants']
        self.assertEqual(sorted(variants), ['M1', 'M1P', 'M2', 'M3', 'M4', 'M5', 'M5P'])
        self.assertEqual({name: variant['case'] for name, variant in variants.items()},
                         {'M1': 'N1', 'M2': 'N1', 'M3': 'N1', 'M4': 'N2', 'M5': 'N1', 'M1P': 'N1', 'M5P': 'N1'})
        self.assertEqual({name for name, variant in variants.items() if variant['dispatchable']}, {'M1P', 'M2', 'M3', 'M4', 'M5P'})
        self.assertEqual({variants[name]['superseded_by'] for name in ('M1', 'M5')}, {'M1P', 'M5P'})
        self.assertEqual(set(harness.MANIFEST['history']['attempts_used'].values()), {0})
        for name, variant in variants.items():
            self.assertEqual(hashlib.sha256(lf(variant['patch'])).hexdigest(), variant['patch_sha256'], name)
        self.assertEqual((variants['M1']['patch_sha256'], variants['M5']['patch_sha256']),
                         (variants['M1P']['derived_from']['patch_sha256'], variants['M5P']['derived_from']['patch_sha256']))

    def test_candidate_validate_copy_is_the_pinned_blob_and_the_retired_entry_is_gone(self):
        replaced = harness.MANIFEST['baseline']['replaced']
        copy = lf(replaced['copy'])
        self.assertEqual((harness.blob_id(copy), hashlib.sha256(copy).hexdigest()), (replaced['blob'], replaced['sha256']))
        self.assertNotEqual(harness.blob_id(lf(replaced['path'])), replaced['blob'])
        self.assertEqual(harness.MANIFEST['workflow'], replaced['path'])
        self.assertFalse((harness.ROOT / harness.RETIRED_WORKFLOW).exists())
        self.assertNotIn(replaced['path'], harness.MANIFEST['harness_paths'])

    def test_detectors_wrapper_workflow_dispatch_and_pixel_predictions_match_the_candidate_sources(self):
        test_source = lf(harness.ORACLE).decode('utf-8')
        workflow, validate = lf(harness.MANIFEST['workflow']).decode('utf-8'), lf(harness.MANIFEST['baseline']['replaced']['copy']).decode('utf-8')
        self.assertEqual(harness.detector_problems(test_source), [])
        self.assertEqual(harness.wrapper_problems(lf(harness.WRAPPER).decode('utf-8')), [])
        self.assertEqual(harness.workflow_problems(workflow, validate), [])
        self.assertEqual(harness.dispatch_problems(workflow), [])
        self.assertEqual(harness.semantic_problems(test_source), [])

    def test_workflow_checks_refuse_widened_triggers_credentials_retries_and_retired_variants(self):
        text, validate = lf(harness.MANIFEST['workflow']).decode('utf-8'), lf(harness.MANIFEST['baseline']['replaced']['copy']).decode('utf-8')
        for widened in (text.replace('  workflow_dispatch:\n', '  push:\n  workflow_dispatch:\n', 1),
                        text.replace('persist-credentials: false', 'persist-credentials: true'),
                        text.replace('max-parallel: 2', 'max-parallel: 5'),
                        text.replace('fail-fast: false', 'fail-fast: true'),
                        text.replace('    env:\n', '    continue-on-error: true\n    env:\n', 1),
                        text.replace('VARIANT: ${{ matrix.variant }}', 'VARIANT: ${{ matrix.variant }}\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}'),
                        text.replace('-attempt${{ github.run_attempt }}', '')):
            self.assertNotEqual(harness.workflow_problems(widened, validate), [])
        for widened in (text.replace('["M1P","M2","M5P"]', '["M1","M2","M5"]'),
                        text.replace('          - supplement-M3-M4\n', '          - supplement-M3-M4\n          - required-M1-M2-M5\n'),
                        text.replace('["M3","M4"]', '["M3","M4","M2"]')):
            self.assertNotEqual(harness.dispatch_problems(widened), [])

    def test_pixel_predictions_refuse_ambiguous_or_disagreeing_behaviours(self):
        oracle = harness.load_oracle(lf(harness.ORACLE).decode('utf-8'))
        with self.assertRaises(harness.Refused):
            # Along-ray Axial MIP has no probe, so MIP alternatives agree; MinIP alternatives fail first at different cells.
            harness.pixel_prediction(oracle, {'behaviours': {'MIP': ['expected'], 'MinIP': ['expected', 'zero_fill'], 'Raysum': ['zero_fill']}})
        with self.assertRaises(harness.Refused):
            harness.load_oracle(lf(harness.ORACLE).decode('utf-8').replace('def zero_fill_hu(', 'def zero_fill_hu_renamed('))


if __name__ == '__main__':
    unittest.main(verbosity=2)
