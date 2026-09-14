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
        frames = [(TEST, 403, N1), (TEST, 386, 'voi_pixels')]
        raysum = "AssertionError: 17.5 not less than or equal to 3 : (('negative', 'along-ray', 'Coronal', 'Raysum', 'Raysum · Coronal · Final'), 'expected', {}, 140.0)"
        seen = harness.observe('M5', inputs(suite_log(N1, [block('FAIL', N1, frames, raysum)])))
        self.assertEqual(seen['detector']['id'], 'n1-raysum-pixel-oracle')
        mip = raysum.replace("'Raysum', 'Raysum", "'MIP', 'MIP")
        seen = harness.observe('M5', inputs(suite_log(N1, [block('FAIL', N1, frames, mip)])))
        self.assertEqual((seen['observation'], seen['detection_candidate']), ('assertion-failure-outside-preregistered-detectors', False))

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
            seen = harness.observe('M2', value)
            self.assertEqual((seen['observation'], seen['detection_candidate']), (expected, False), expected)

    def test_a_passing_target_case_is_reported_as_a_surviving_mutation(self):
        seen = harness.observe('M2', inputs(suite_log(N1, summary='OK', status='passed'), native_exit=0, suite_exit=0))
        self.assertEqual((seen['observation'], seen['detection_candidate']), ('mutation-survived-target-case-passed', False))


class PreparedFilesTest(unittest.TestCase):
    def test_manifest_holds_exactly_the_five_contract_mutations_with_their_committed_patch_bytes(self):
        variants = harness.MANIFEST['variants']
        self.assertEqual(sorted(variants), ['M1', 'M2', 'M3', 'M4', 'M5'])
        self.assertEqual({name: variant['case'] for name, variant in variants.items()}, {'M1': 'N1', 'M2': 'N1', 'M3': 'N1', 'M4': 'N2', 'M5': 'N1'})
        for name, variant in variants.items():
            self.assertEqual(hashlib.sha256(lf(variant['patch'])).hexdigest(), variant['patch_sha256'], name)

    def test_detectors_wrapper_and_workflow_match_the_candidate_sources(self):
        self.assertEqual(harness.detector_problems(lf('tests/e2e/test_volume_mip.py').decode('utf-8')), [])
        self.assertEqual(harness.wrapper_problems(lf(harness.WRAPPER).decode('utf-8')), [])
        self.assertEqual(harness.workflow_problems(lf(harness.MANIFEST['workflow']).decode('utf-8'), lf('.github/workflows/validate.yml').decode('utf-8')), [])

    def test_workflow_checks_refuse_widened_triggers_credentials_and_retries(self):
        text, validate = lf(harness.MANIFEST['workflow']).decode('utf-8'), lf('.github/workflows/validate.yml').decode('utf-8')
        for widened in (text.replace('  workflow_dispatch:\n', '  push:\n  workflow_dispatch:\n', 1),
                        text.replace('persist-credentials: false', 'persist-credentials: true'),
                        text.replace('max-parallel: 2', 'max-parallel: 5'),
                        text.replace('fail-fast: false', 'fail-fast: true'),
                        text.replace('    env:\n', '    continue-on-error: true\n    env:\n', 1),
                        text.replace('VARIANT: ${{ matrix.variant }}', 'VARIANT: ${{ matrix.variant }}\n      TOKEN: ${{ secrets.GITHUB_TOKEN }}'),
                        text.replace('-attempt${{ github.run_attempt }}', '')):
            self.assertNotEqual(harness.workflow_problems(widened, validate), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
