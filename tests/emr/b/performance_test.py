"""REQ-D1006 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT/RECEIPT-DELAY -> hosted verdict controls.

Known observations exercise the report and negative-control consumer, without
timing a machine, pinning source text, or changing the live acceptance rule.
The negative-control driver runs for real on a copy of the runtime sources; only
its benchmark subprocess returns known summaries and raw sample rows.
"""
import contextlib
import copy
import runpy
import sys
import types
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from performance import ROOT, build_report, case_result
import performance_mutants as mutants
from performance_mutants import (MP02_BASELINE_P95_BOUND_MS as B, MP02_DELAY_MS as L,
                                 mutant_result, property_failures)

LATENCY_KEYS = {'sustained': [('sustained', 20, 20000)], 'concurrent': [('concurrent', 24, 0), ('concurrent', 48, 0)]}
# The audit's four attribution inputs (performance-mutant-verdict.json):
# (name, baseline p95, candidate p95, revision with one failed request).
ATTRIBUTION_INPUTS = [('latency_regression', 100, 140, None), ('baseline_request_failed', 100, 100, 'r3'),
                      ('candidate_request_failed', 100, 100, 'r4d'), ('no_regression', 100, 100, None)]


def sample(p95, **values):
    return {'p50': p95, 'p95': p95, 'p99': p95, 'failures': 0,
            'read_rows': 0, 'read_bytes': 0, **values}


def pairs(baseline=100., candidate=100., repetitions=10):
    return {'r3': [sample(baseline) for _ in range(repetitions)],
            'r4d': [sample(candidate) for _ in range(repetitions)]}


def measured(case, baseline, candidate, failed=None):
    """performance.py's own summary for one latency property's cases."""
    report = {'failures': [], 'cases': {}, 'repetitions': 10}
    for name, count, retained in LATENCY_KEYS[case]:
        pair = pairs(baseline, candidate)
        if failed:
            pair[failed][0]['failures'] = 1
        stats, failures = case_result(name, count, retained, pair)
        report['cases'][f'{name}-{count}-{retained}'] = stats
        report['failures'] += failures
    return report


def receipt_rows(baseline_p95, receipts, requests=4):
    """Raw sustained sample rows: ten r3 blocks and ten r4d blocks whose
    per-receipt times are `receipts(rep)` (a list per block)."""
    rows = []
    for rep in range(10):
        rows.append(dict(sample(baseline_p95), label=f'sustained-{rep}-r3', version='r3', concurrency=20, prefill=20000,
                         requests=requests, request_instruments=[{'receipt_ms': baseline_p95}] * requests))
        times = receipts(rep)
        rows.append(dict(sample(max(times)), label=f'sustained-{rep}-r4d', version='r4d', concurrency=20, prefill=20000,
                         requests=len(times), request_instruments=[{'receipt_ms': t} for t in times]))
    return rows


def observe_driver(only='MP03', report=None, receipt=None, control_update=None, raw_summary=None,
                   error=None, fault=None, entry=False, control_raw=None):
    """Real driver, disposable real runtime copy; only benchmark IO is replaced.

    Faults model one ordinary failure at a time. Escaped exceptions are captured
    as observations so regressions fail assertions, not test infrastructure.
    """
    case = 'sustained' if only == 'MP02' else 'concurrent'
    report = measured(case, B, L) if report is None else report
    with tempfile.TemporaryDirectory(prefix='emr-perf-driver-') as folder:
        base = Path(folder)
        (base / 'api/src/emr-runtime').mkdir(parents=True)
        sources = {}
        for name in ('seal.ts', 'store.ts', 'external-writer.ts'):
            raw = (ROOT / 'api/src/emr-runtime' / name).read_bytes()
            (base / 'api/src/emr-runtime' / name).write_bytes(raw)
            sources['api/src/emr-runtime/' + name] = hashlib.sha256(raw).hexdigest()
        (base / 'api/tsconfig.json').write_bytes((ROOT / 'api/tsconfig.json').read_bytes())
        healthy = {'candidate_sources': sources, 'failures': [],
                   'cases': {**measured('sustained', 100, 100)['cases'], **measured('concurrent', 100, 100)['cases']}}
        if control_update:
            control_update(healthy)
        control = base / 'healthy.json'
        control.write_text(json.dumps(healthy) if control_raw is None else control_raw, encoding='utf-8')
        mutated, launches = {}, []
        out, stderr, stdout = base / 'out', io.StringIO(), io.StringIO()

        def benchmark(argv, **kwargs):
            target = Path(argv[argv.index('--out') + 1])
            launches.append(target.name)
            target.mkdir(parents=True)
            candidate = Path(argv[argv.index('--candidate') + 1]) / 'api/src/emr-runtime'
            mutated.update({p.name: p.read_text(encoding='utf-8') for p in candidate.iterdir()})
            if error is not None:
                raise error
            (target / 'summary.json').write_text(json.dumps(report) if raw_summary is None else raw_summary, encoding='utf-8')
            if receipt is not None:
                (target / 'receipt.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in receipt), encoding='utf-8')
            if fault == 'publish':
                (out / 'summary.json').mkdir()
            return subprocess.CompletedProcess(argv, 1 if report['failures'] else 0, '', '')

        if fault == 'out':
            out.write_text('ordinary file blocks creation of output directory', encoding='utf-8')
        args = ['--out', str(out), '--control', str(control), '--only', only]
        escaped, exit_code = None, None
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(mutants, 'ROOT', base))
            stack.enter_context(patch.object(mutants.subprocess, 'run', benchmark))
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            if fault == 'judge':
                stack.enter_context(patch.object(mutants, 'mutant_result', side_effect=RuntimeError('judge failed')))
            if fault == 'cleanup':
                cleanup = tempfile.TemporaryDirectory.__exit__
                def fail_cleanup(directory, *args):
                    cleanup(directory, *args)
                    raise OSError('cleanup failed after provisional verdict')
                stack.enter_context(patch.object(tempfile.TemporaryDirectory, '__exit__', fail_cleanup))
            if fault == 'permission':
                write = Path.write_text
                def fail_write(path, *args, **kwargs):
                    if path == out / 'summary.json':
                        raise PermissionError('output directory is not writable')
                    return write(path, *args, **kwargs)
                stack.enter_context(patch.object(Path, 'write_text', fail_write))
            if fault == 'healthy_read':
                read = Path.read_text
                def fail_read(path, *args, **kwargs):
                    if path == control:
                        raise error if error is not None else SystemExit(0)
                    return read(path, *args, **kwargs)
                stack.enter_context(patch.object(Path, 'read_text', fail_read))
            try:
                if entry:
                    import performance
                    stack.enter_context(patch.object(performance, 'ROOT', base))
                    stack.enter_context(patch.object(sys, 'argv', [str(Path(mutants.__file__))] + args))
                    try:
                        runpy.run_path(str(Path(mutants.__file__)), run_name='__main__')
                    except SystemExit as outcome:
                        exit_code = outcome.code or 0
                else:
                    exit_code = mutants.main(args)
            except (Exception, SystemExit) as outcome:
                escaped = type(outcome).__name__ + ': ' + str(outcome)
        published = out / 'summary.json'
        summary = json.loads(published.read_text(encoding='utf-8')) if published.is_file() else None
        logs = {p.stem: p.read_text(encoding='utf-8') for p in out.glob('*.log')} if out.is_dir() else {}
        return {'summary': summary, 'exit': exit_code, 'escaped': escaped, 'launches': launches,
                'stderr': stderr.getvalue(), 'stdout': stdout.getvalue(), 'logs': logs, 'mutated': mutated}


def run_driver(only, report, receipt=None, control_failures=(), control_cases=None, raw_summary=None, error=None,
               capture=None):
    def update(control):
        control['failures'] = list(control_failures)
        if control_cases is not None:
            control['cases'] = control_cases
    seen = observe_driver(only, report, receipt, update, raw_summary, error)
    if capture is not None:
        capture.update(stderr=seen['stderr'], log=seen['logs'].get(only, ''), invalid=seen['summary']['invalid'])
    return seen['summary']['results'][0], bool(seen['exit']), seen['mutated']


class _PerformanceReportTest(unittest.TestCase):
    def test_gross_point_boundary_for_every_receipt_workload(self):
        for case, count, retained in [('ledger', 1, 0), ('sustained', 20, 20000),
                                      ('concurrent', 24, 0), ('concurrent', 48, 0)]:
            for baseline, candidate, fails in [(9, 12, False), (9, 14, False),
                    (9, 14.01, True), (100, 124, False), (100, 125, False),
                    (100, 125.01, True), (1, 160, True), (1, 230, True),
                    (100, 90, False), (100, 140, True)]:
                with self.subTest(case=case, count=count, baseline=baseline, candidate=candidate):
                    stats, failures = case_result(case, count, retained, pairs(baseline, candidate))
                    self.assertEqual(bool(failures), fails)
                    self.assertEqual(stats['gate_passed'], not fails)
                    self.assertEqual(stats['R'], candidate / baseline)
                    self.assertEqual(stats['pair_deltas_ms'], [candidate - baseline] * 10)
                    self.assertEqual(stats['D'], candidate - baseline)
                    self.assertEqual(stats['gate_ratio_limit'], 1.25)
                    self.assertEqual(stats['gate_delta_floor_ms'], 5.)
                    self.assertTrue(stats['gate_reason'])

    def test_delta_is_signed_pair_median_and_ratio_is_ratio_of_medians(self):
        pair = {'r3': [sample(v) for v in [1, 5, 100] * 2],
                'r4d': [sample(v) for v in [6, 105, 11] * 2]}
        stats, failures = case_result('sustained', 20, 0, pair)
        self.assertFalse(failures)
        self.assertTrue(stats['gate_passed'])
        self.assertEqual(stats['pair_deltas_ms'], [5, 100, -89] * 2)
        self.assertEqual(stats['D'], 5)
        self.assertEqual(stats['R'], 11 / 5)
        self.assertEqual(stats['ratio_method'], 'ratio of block-p95 medians')

    def test_missing_mismatched_or_nonfinite_pairs_never_pass(self):
        for bad in ({}, {'r3': [], 'r4d': []}, {'r3': [sample(1)], 'r4d': []},
                    {'r3': [sample(1)], 'r4d': [sample(float('nan'))]},
                    {'r3': [sample(1)], 'r4d': [sample(float('inf'))]},
                    {'r3': [sample(0)], 'r4d': [sample(1)]},
                    {'r3': [sample(1)], 'r4d': [{}]}):
            with self.subTest(pair=bad), self.assertRaises(ValueError):
                case_result('ledger', 1, 0, bad)

    def test_concurrent_does_not_require_superiority(self):
        for count in (24, 48):
            stats, failures = case_result('concurrent', count, 0, pairs(100, 105))
            self.assertFalse(failures)
            self.assertAlmostEqual(stats['p95_pct'], 5.)

    def test_gross_pass_does_not_imply_noninferiority_acceptance(self):
        stats, failures = case_result('sustained', 20, 20000, pairs(100, 111))
        self.assertFalse(failures)
        self.assertTrue(stats['gate_passed'])
        self.assertFalse(stats['noninferiority']['accepted'])

    def test_sustained_uncertainty_is_recorded_without_veto(self):
        pair = pairs(repetitions=3)
        pair['r4d'] = [sample(100 * math.exp(x)) for x in (-.1, 0, .1)]
        receipt = [dict(row, label='sustained-' + v, version=v, concurrency=20, prefill=20000)
                   for v, rows in pair.items() for row in rows]
        report = build_report(receipt, [('sustained', 20, 20000)], ['sustained'], 3, {})
        stats = report['cases']['sustained-20-20000']
        self.assertFalse(report['failures'])
        self.assertEqual(stats['r4d']['p95'] / stats['r3']['p95'], 1.)
        self.assertGreater(stats['noninferiority']['upper_95_ratio'], 1.10)
        self.assertFalse(stats['noninferiority']['accepted'])
        self.assertEqual(stats['noninferiority']['role'], 'recorded statistic only; not a CI verdict')

    def test_ten_pair_statistics_are_preserved(self):
        stats, failures = case_result('ledger', 1, 0, pairs(100, 124))
        self.assertFalse(failures)
        self.assertAlmostEqual(stats['permutation_p'], 2 / 1024)
        self.assertAlmostEqual(stats['paired_geometric_pct'], 24.)
        self.assertAlmostEqual(stats['paired_upper_95_pct'], 24.)
        self.assertAlmostEqual(stats['added_p95_ms_upper95'], 24.)
        self.assertAlmostEqual(stats['p95_pct'], 24.)

    def test_request_failure_in_either_revision_still_fails(self):
        for case in ('ledger', 'sustained', 'concurrent'):
            for version in ('r3', 'r4d'):
                pair = pairs(100, 90)
                pair[version][0]['failures'] = 1
                stats, failures = case_result(case, 1, 0, pair)
                self.assertEqual(stats['failures'], 1)
                self.assertEqual(len(failures), 1)
                self.assertFalse(stats['gate_passed'])

    def test_single_receipt_prefix_read_still_fails(self):
        for read_rows, fails in [(4, False), (5, True)]:
            pair = pairs()
            pair['r4d'][0]['read_rows'] = read_rows
            _, failures = case_result('ledger', 1, 20000, pair)
            self.assertEqual(bool(failures), fails)
            self.assertEqual(bool(property_failures('ledger', failures)), fails)

    def test_ledger_size_effect_requires_both_probability_and_ratio(self):
        for repetitions, ratio, fails in [(10, 1.20, False), (10, 1.21, True), (2, 1.21, False)]:
            configs = [('ledger', 1, n) for n in (0, 20000, 100000)]
            receipt = [sample(100. if n == 0 else 100. * ratio, label='ledger-' + v,
                              version=v, concurrency=1, prefill=n)
                       for _, _, n in configs for v in ('r3', 'r4d') for _ in range(repetitions)]
            report = build_report(receipt, configs, ['ledger'], repetitions, {})
            self.assertEqual(len(report['failures']), 2 if fails else 0)

    def test_journal_reread_still_fails_without_latency_regression(self):
        for read_bytes, fails in [(0, False), (1, True)]:
            rows = [sample(100., records=n, version=v, read_bytes=read_bytes if v == 'r4d' else 0)
                    for n in (0, 10000, 150000) for v in ('r3', 'r4d') for _ in range(10)]
            report = build_report([], [], ['journal'], 10, {}, journal_rows=rows)
            self.assertEqual(len(report['failures']), 3 if fails else 0)
            self.assertEqual(bool(property_failures('journal', report['failures'])), fails)

    def test_journal_size_effect_requires_both_probability_and_ratio(self):
        for repetitions, ratio, fails in [(10, 1.20, False), (10, 1.21, True), (2, 1.21, False)]:
            rows = [sample(100. if n == 0 else 100. * ratio, records=n, version=v)
                    for n in (0, 10000, 150000) for v in ('r3', 'r4d') for _ in range(repetitions)]
            report = build_report([], [], ['journal'], repetitions, {}, journal_rows=rows)
            self.assertEqual(len(report['failures']), 2 if fails else 0)

    def test_latency_mutants_require_both_ratio_and_signed_delta(self):
        for case, count in [('sustained', 20), ('concurrent', 24), ('concurrent', 48)]:
            for baseline, candidate, fails in [(9, 12, False), (9, 14, False),
                    (9, 14.01, True), (100, 124, False), (100, 125, False),
                    (100, 125.01, True), (1, 160, True), (1, 230, True)]:
                _, failures = case_result(case, count, 0, pairs(baseline, candidate))
                self.assertEqual(bool(property_failures(case, failures)), fails)
                other = 'concurrent' if case == 'sustained' else 'sustained'
                self.assertFalse(property_failures(other, failures))

    # REQ-D1550 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT: a request failure on either
    # side is no latency verdict; only a measured gross regression kills.
    def test_latency_kill_attribution_four_inputs(self):
        for case in ('sustained', 'concurrent'):
            for (name, baseline, candidate, failed), expected in zip(ATTRIBUTION_INPUTS, [True, None, None, False]):
                with self.subTest(case=case, input=name):
                    report = measured(case, baseline, candidate, failed)
                    exit_code = 1 if report['failures'] else 0
                    killed, status = mutant_result(case, exit_code, report, property_failures(case, report['failures']))
                    self.assertIs(killed, expected)
                    self.assertEqual(status, 'invalid_measurement' if failed else 'completed')

    def test_latency_kill_attribution_on_the_real_driver(self):
        for (name, baseline, candidate, failed), expected in zip(ATTRIBUTION_INPUTS, [True, None, None, False]):
            with self.subTest(input=name):
                verdict, failed_exit, _ = run_driver('MP03', measured('concurrent', baseline, candidate, failed))
                self.assertIs(verdict['killed'], expected)
                self.assertEqual(failed_exit, expected is not True)

    def test_latency_verdict_needs_every_case_statistic(self):
        report = measured('concurrent', 100, 140)
        del report['cases']['concurrent-48-0']
        self.assertEqual(mutant_result('concurrent', 1, report, property_failures('concurrent', report['failures'])),
                         (None, 'invalid_measurement'))
        for bad in (float('nan'), float('inf'), None):
            report = measured('sustained', 100, 140)
            report['cases']['sustained-20-20000']['D'] = bad
            self.assertEqual(mutant_result('sustained', 1, report, ['x'])[0], None)
        self.assertEqual(mutant_result('sustained', 2, measured('sustained', 100, 140), ['x']), (None, 'harness_error'))
        self.assertEqual(mutant_result('sustained', 1, None, []), (None, 'harness_error'))

    def test_healthy_control_failure_is_reported_apart_from_control_design(self):
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, 100),
                                             control_failures=measured('sustained', 100, 100, 'r3')['failures'],
                                             control_cases=measured('sustained', 100, 100, 'r3')['cases'])
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'control_failed', True))
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, 100), control_cases={})
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'control_invalid', True))

    def test_benchmark_errors_and_malformed_output_are_no_verdict(self):
        # PERF-R1-01/02: a benchmark that cannot finish, or whose summary has the
        # wrong shape, gives killed=None/harness_error, INVALID_CONTROL, non-zero exit.
        missing_failures = {k: v for k, v in measured('sustained', 100, 140).items() if k != 'failures'}
        inputs = {'timeout': dict(error=subprocess.TimeoutExpired(['benchmark'], 1200, output='partial-out', stderr='partial-err')),
                  'oserror': dict(error=FileNotFoundError(2, 'No such file', 'python')),
                  'cases_null': dict(raw_summary=json.dumps({'failures': [], 'cases': None, 'repetitions': 10})),
                  'array_summary': dict(raw_summary=json.dumps([{'failures': []}])),
                  'missing_key': dict(raw_summary=json.dumps(missing_failures)),
                  'invalid_json': dict(raw_summary='{"failures": [')}
        for only in ('MP02', 'MP03'):
            for name, kwargs in inputs.items():
                with self.subTest(mutant=only, input=name):
                    seen = {}
                    verdict, failed_exit, _ = run_driver(only, measured('sustained', 100, 140), capture=seen, **kwargs)
                    self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'harness_error', True))
                    self.assertTrue(verdict['harness_cause'])
                    self.assertEqual(seen['invalid'], {only: 'harness_error'})
                    self.assertIn('INVALID_CONTROL ' + only, seen['stderr'])
                    if name == 'timeout':
                        self.assertIn('partial-out', seen['log'])
                        self.assertIn('partial-err', seen['log'])
                        self.assertIn('timeout', seen['log'])

    # REQ-D1550 -> RISK-EMR-RECEIPT-DELAY: MP02 breaks R > 1.25 AND D > 5 ms by
    # construction (baseline <= B, every receipt >= L) or it is INVALID_CONTROL.
    def test_mp02_size_guarantees_both_bounds(self):
        self.assertEqual(L, max(50, math.ceil(1.5 * B + 10)))
        self.assertGreater(L / B, 1.25)
        self.assertGreater(L - B, 5.)

    def test_mp02_valid_control_is_killed_and_delays_every_receipt_return(self):
        verdict, failed_exit, mutated = run_driver('MP02', measured('sustained', B, L),
                                                   receipt_rows(B, lambda rep: [L, L + 1, L + 50, L + 2]))
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (True, 'completed', False))
        self.assertTrue(verdict['control_validity']['valid'])
        self.assertEqual(verdict['control_validity']['mutant_receipt_min_ms'], L)
        self.assertEqual(verdict['control_validity']['baseline_block_p95_max_ms'], B)
        # The copy differs from the product source by one awaited L ms timer and
        # nothing else; the product file is untouched. That the timer reaches
        # every receipt is measured (control_validity), not read from the text.
        original = (ROOT / 'api/src/emr-runtime/store.ts').read_text(encoding='utf-8').splitlines()
        added = list(mutated['store.ts'].splitlines())
        for line in original:
            added.remove(line)
        self.assertEqual([line.strip() for line in added], ['await new Promise(resolve => setTimeout(resolve, %d));' % L])

    def test_mp02_baseline_above_bound_is_invalid_control(self):
        rows = receipt_rows(B, lambda rep: [L] * 4)
        rows[8]['p95'] = B + .1
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', B, L), rows)
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'invalid_control', True))
        self.assertFalse(verdict['control_validity']['valid'])

    def test_mp02_receipt_below_delay_is_invalid_control(self):
        verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, L),
                                             receipt_rows(100, lambda rep: [L] * 3 + ([L - .001] if rep == 5 else [L])))
        self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'invalid_control', True))
        for rows in ([], receipt_rows(100, lambda rep: [L] * 4)[:-1], None):
            with self.subTest(rows=None if rows is None else len(rows)):
                verdict, failed_exit, _ = run_driver('MP02', measured('sustained', 100, L), rows)
                self.assertEqual((verdict['killed'], verdict['status'], failed_exit), (None, 'harness_error' if rows is None else 'invalid_control', True))


# REQ-D1592.1..5 -> RISK-EMR-FALSE-PERFORMANCE-ACCEPT -> R3B_*.
# Each case changes ONE field or injects ONE exception. No cross product of
# corruptions, sink failures, performance timings, or real stack execution.
FAMILIES = {'none': None, 'bool': True, 'str_number': '2', 'list': [], 'dict': {},
            'nan': float('nan'), 'inf': float('inf'), 'huge_int': 10 ** 400}
DRIVER_CASES = {}


def driver_case(name, **spec):
    DRIVER_CASES[name] = spec


for target in ('healthy', 'MP02', 'MP03'):
    for field in ('failures', 'failure_item', 'cases', 'row', 'R', 'D', 'gate_ratio_limit',
                  'gate_delta_floor_ms', 'gate_passed', 'request_failures'):
        for family, value in FAMILIES.items():
            expected = 'harness_error'
            if field == 'cases' and family == 'dict':
                expected = 'control_invalid' if target == 'healthy' else 'invalid_measurement'
            if target == 'healthy' and ((field == 'failures' and family == 'list')
                    or (field == 'failure_item' and family == 'str_number')
                    or (field == 'gate_passed' and family == 'bool')):
                expected = 'completed'
            driver_case(f'{target}_{field}_{family}', target=target, field=field, value=value, expected=expected)

# Raw MP02 fields that are actually consumed (one row/instrument per position).
for field in ('repetitions', 'receipt_row', 'label', 'version', 'concurrency', 'prefill',
              'failures', 'requests', 'p95', 'request_instruments', 'instrument', 'receipt_ms', 'error'):
    for family, value in FAMILIES.items():
        expected = 'harness_error'
        if ((field in ('label', 'version', 'error') and family == 'str_number')
                or (field in ('repetitions', 'concurrency', 'prefill', 'failures', 'requests') and family == 'huge_int')
                or (field == 'request_instruments' and family == 'list')):
            expected = 'invalid_control'
        driver_case(f'raw_{field}_{family}', target='MP02', raw_field=field, value=value, expected=expected)

for only in ('MP02', 'MP03'):
    for name, error in {'timeout': subprocess.TimeoutExpired(['benchmark'], 1200, output='partial-out', stderr='partial-err'),
                        'oserror': OSError('launch failed'),
                        'decode': UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid byte'),
                        'system_exit_zero': SystemExit(0), 'system_exit_none': SystemExit(None),
                        'bounded_cause': RuntimeError('x' * 2000)}.items():
        driver_case(f'{only}_{name}', target=only, error=error, expected='harness_error')
    driver_case(f'{only}_failures_one', target=only, field='failure_item', value=1, expected='harness_error')
    for name, raw in {'array_summary': '[]', 'invalid_json': '{'}.items():
        driver_case(f'{only}_{name}', target=only, raw_summary=raw, expected='harness_error')
    for fault in ('judge', 'cleanup'):
        driver_case(f'{only}_{fault}', target=only, fault=fault, expected='harness_error')
    for field in ('R', 'D', 'gate_passed', 'failures'):
        driver_case(f'{only}_inconsistent_{field}', target=only, inconsistent=field, expected='harness_error')
    for kind in ('regression', 'request'):
        driver_case(f'{only}_healthy_failure_{kind}', target=only, healthy_failure=kind, expected='control_failed')
    driver_case(f'{only}_valid', target=only, expected='completed')

for name, extra in {
        'healthy_false_pass': {'false_pass': True},
        'healthy_sources_empty': {'sources': 'empty', 'expected': 'control_invalid'},
        'healthy_sources_missing': {'sources': 'missing', 'expected': 'control_invalid'},
        'healthy_system_exit': {'fault': 'healthy_read'},
        'second_concurrent_row': {'second_row': True},
        'selected_control_invalid': {'selected_control_invalid': True, 'expected': 'control_invalid'},
        'unknown': {'selection': 'UNKNOWN', 'expected': 'selection'},
        'empty': {'selection': '', 'expected': 'selection'},
        'mixed_unknown': {'selection': 'MP03,UNKNOWN', 'expected': 'selection'},
        'publish': {'fault': 'publish', 'expected': 'publication'},
        'out': {'fault': 'out', 'expected': 'publication'},
        'permission': {'fault': 'permission', 'expected': 'publication'},
        'healthy_oserror': {'fault': 'healthy_read', 'error': OSError('healthy read failed')},
        'healthy_decode': {'fault': 'healthy_read', 'error': UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'bad byte')},
        'entry_zero': {'entry': True, 'error': SystemExit(0)},
        'entry_none': {'entry': True, 'error': SystemExit(None)},
        }.items():
    driver_case(name, **{'target': 'MP03', 'expected': 'harness_error', **extra})


for target in ('healthy', 'MP02', 'MP03'):
    for family, value in FAMILIES.items():
        driver_case(f'{target}_summary_{family}', target=target, root_value=value, expected='harness_error')


class DriverBoundaryTest(unittest.TestCase):
    def check_case(self, spec):
        spec = copy.deepcopy(spec)
        target = spec['target']
        only = spec.get('selection', 'MP03' if target == 'healthy' else target)
        if spec.get('selected_control_invalid'):
            only = 'MP02,MP03'
        case = 'sustained' if only == 'MP02' else 'concurrent'
        report = measured(case, B, L)
        receipt = receipt_rows(B, lambda rep: [L] * 4)
        key = next(iter(report['cases']))

        def alter(summary, row_key):
            field, value = spec.get('field'), spec.get('value')
            if field in ('failures', 'cases'):
                summary[field] = value
            elif field == 'failure_item':
                summary['failures'] = [value]
            elif field == 'row':
                summary['cases'][row_key] = value
            elif field:
                summary['cases'][row_key]['failures' if field == 'request_failures' else field] = value

        def control_update(control):
            if target == 'healthy':
                alter(control, 'concurrent-24-0')
            if spec.get('false_pass'):
                control['cases']['concurrent-24-0'].update(R=2, D=100, gate_passed=True)
            if 'sources' in spec:
                if spec['sources'] == 'missing':
                    del control['candidate_sources']
                else:
                    control['candidate_sources'] = {}
            if spec.get('healthy_failure'):
                bad = measured(case, 100, 140 if spec['healthy_failure'] == 'regression' else 100,
                               'r3' if spec['healthy_failure'] == 'request' else None)
                control['cases'].update(bad['cases'])
                control['failures'] = bad['failures']
            if spec.get('selected_control_invalid'):
                del control['cases']['sustained-20-20000']

        if target != 'healthy':
            alter(report, key)
        field, value = spec.get('raw_field'), spec.get('value')
        if field == 'repetitions':
            report[field] = value
        elif field == 'receipt_row':
            receipt[1] = value
        elif field == 'instrument':
            receipt[1]['request_instruments'][0] = value
        elif field in ('receipt_ms', 'error'):
            receipt[1]['request_instruments'][0][field] = value
        elif field:
            receipt[0 if field == 'p95' else 1][field] = value
        if spec.get('inconsistent'):
            field = spec['inconsistent']
            if field == 'failures':
                report['failures'] = []
            else:
                report['cases'][key][field] = {'R': 1, 'D': 0, 'gate_passed': True}[field]
        if spec.get('second_row'):
            report['cases']['concurrent-48-0']['gate_passed'] = True
        seen = observe_driver(only, report, receipt, control_update,
                              raw_summary=(json.dumps(spec['root_value']) if target != 'healthy' and 'root_value' in spec
                                           else spec.get('raw_summary')), error=spec.get('error'),
                              fault=spec.get('fault'), entry=spec.get('entry', False),
                              control_raw=json.dumps(spec['root_value']) if target == 'healthy' and 'root_value' in spec else None)
        self.assertIsNone(seen['escaped'], seen['escaped'])
        expected = spec['expected']
        if expected == 'publication':
            self.assertNotEqual(seen['exit'], 0)
            self.assertIsNone(seen['summary'])
            self.assertIn('HARNESS_ERROR', seen['stderr'])
            return
        self.assertIsNotNone(seen['summary'])
        summary = seen['summary']
        if expected == 'selection':
            self.assertNotEqual(seen['exit'], 0)
            self.assertEqual(summary['total'], 0)
            self.assertEqual(summary['results'], [])
            self.assertEqual(seen['launches'], [])
            return
        self.assertEqual(summary['total'], len(only.split(',')))
        self.assertEqual(len(summary['results']), summary['total'])
        self.assertEqual(len({row['id'] for row in summary['results']}), summary['total'])
        self.assertEqual(summary['killed'], summary['total'] if expected == 'completed' else 0)
        self.assertEqual(summary['survived'], [])
        self.assertEqual(bool(seen['exit']), expected != 'completed')
        for row in summary['results']:
            self.assertEqual(row['status'], expected)
            self.assertIs(row['killed'], True if expected == 'completed' else None)
            if expected == 'harness_error':
                self.assertRegex(row['harness_cause'], r'^\w+: .{0,500}$')
                self.assertIn(row['id'], summary['invalid'])
        if (target == 'healthy' or 'sources' in spec or spec.get('false_pass')
                or spec.get('healthy_failure') or spec.get('selected_control_invalid')
                or spec.get('fault') == 'healthy_read') and expected != 'completed':
            self.assertEqual(seen['launches'], [])
        if 'error' in spec:
            for row in summary['results']:
                self.assertTrue(row['harness_cause'].startswith(type(spec['error']).__name__ + ':'))
        if isinstance(spec.get('error'), subprocess.TimeoutExpired):
            self.assertIn('partial-out', seen['logs'][only])
            self.assertIn('partial-err', seen['logs'][only])

    def test_R3B_keyboard_interrupt_propagates(self):
        with self.assertRaises(KeyboardInterrupt):
            observe_driver(error=KeyboardInterrupt())

    def test_R3B_request_counts_cannot_be_negative(self):
        for target, field in [('healthy', 'request_failures'), ('MP03', 'request_failures')]:
            with self.subTest(target=target):
                self.check_case(dict(target=target, field=field, value=-1, expected='harness_error'))
        for field in ('repetitions', 'concurrency', 'prefill', 'requests', 'failures'):
            with self.subTest(field=field):
                self.check_case(dict(target='MP02', raw_field=field, value=-1, expected='harness_error'))


for name, spec in DRIVER_CASES.items():
    def test(self, spec=spec):
        self.check_case(spec)
    setattr(DriverBoundaryTest, 'test_R3B_' + name, test)


class BoundaryMutationTest(unittest.TestCase):
    def test_six_faults_are_killed_by_assertions(self):
        # These are mutations of this development tool, not implementation-text
        # assertions on product code. Each altered copy runs a real driver test.
        source = Path(mutants.__file__).read_text(encoding='utf-8')
        faults = {
            'F01_drop_SystemExit_boundary': (
                'except (Exception, SystemExit) as error:\n        return {**identity',
                'except Exception as error:\n        return {**identity', 'MP03_system_exit_zero'),
            'F02_exception_becomes_kill': (
                "return {**identity, 'killed': None, 'status': 'harness_error'",
                "return {**identity, 'killed': True, 'status': 'harness_error'", 'MP03_decode'),
            'F03_remove_consistency': (
                '        validate_consistency(key, row, failures)',
                '        pass  # fault: trust reported gate', 'healthy_false_pass'),
            'F04_accept_empty_sources': (
                "    if not sources:\n        return",
                "    if sources is None:\n        return", 'healthy_sources_empty'),
            'F05_incomplete_exits_zero': (
                "return int(selection_error or bool(summary['survived'] or summary['not_run']))",
                "return int(selection_error or bool(summary['survived']))", 'MP03_cases_dict'),
            'F06_publication_exits_zero': (
                '        return 1\n\n\nif __name__',
                '        return 0\n\n\nif __name__', 'publish'),
        }
        for name, (before, after, witness) in faults.items():
            with self.subTest(fault=name):
                self.assertEqual(source.count(before), 1, name)
                module = types.ModuleType('performance_mutants_fault')
                module.__file__ = mutants.__file__
                exec(compile(source.replace(before, after), module.__file__, 'exec'), module.__dict__)
                result = unittest.TestResult()
                with patch.dict(globals(), mutants=module):
                    DriverBoundaryTest('test_R3B_' + witness).run(result)
                self.assertEqual(result.testsRun, 1)
                self.assertEqual(result.errors, [], name)
                self.assertEqual(len(result.failures), 1, name + ' survived')
                print('BOUNDARY_MUTANT ' + name + ' KILLED by test_R3B_' + witness)


class PerformanceVerdictTest(_PerformanceReportTest, DriverBoundaryTest, BoundaryMutationTest):
    """The existing noninferiority_test.py CI import includes every driver test."""


def load_tests(loader, tests, pattern):
    # Direct execution and the existing CI import collect the same cases once.
    return loader.loadTestsFromTestCase(PerformanceVerdictTest)


if __name__ == '__main__':
    unittest.main()
