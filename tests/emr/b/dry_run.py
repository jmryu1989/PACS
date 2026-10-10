"""D952 attempt-free pilot of the hosted ci-gross path, on owned disposable DBs.

Explicit entrypoint only: does not call run-tests, grant a live ticket, acquire
a lease, or masquerade as GitHub Actions. The runner-facing cases retain their
live guard. Full single and reduced other workloads report D961 statistics;
never final acceptance. D956 also permits a separate instrumented idle sweep.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid
from unittest.mock import patch

from live import EmrBLedgerLive, run
from live_mutants import EmrBLiveMutants
from live_acceptance import estimate_duration
from quiet_host import HostProbe, QuietMonitor, InvalidRun, command


def pilot(plan_path, output, image, source_manifest=None, gap_diagnostic_only=False):
    if os.environ.get('KIN_EMR_BENCHMARK_MODE') == 'acceptance':
        raise ValueError('pilot cannot inherit acceptance mode')
    plan_path, output = Path(plan_path).resolve(), Path(output).resolve()
    plan = json.loads(plan_path.read_bytes())
    estimate = estimate_duration(plan)
    output.mkdir(parents=True, exist_ok=False)
    token = uuid.uuid4().hex
    name, label = 'kin-emrb-pilot-' + token[:12], 'kin.emrb.quiet=' + token
    report = {'decision': 'D956', 'mode': 'ci-gross', 'dry_run': True,
              'runner_attempts_consumed': 0, 'lease_acquired': False,
              'plan_sha256': hashlib.sha256(plan_path.read_bytes()).hexdigest(),
              'duration_estimate': estimate, 'verdict_preview': 'INVALID',
              'purpose': 'gap-diagnostic-only' if gap_diagnostic_only else 'full-single-reduced-rest'}
    started = time.monotonic()
    probe_started = False
    try:
        if not estimate['within_cap'] and not gap_diagnostic_only:
            raise InvalidRun('full plan exceeds pre-lease duration cap')
        command(['docker', 'run', '-d', '--name', name, '--label', label,
                 '--network', 'none', 'postgres:16-alpine', 'sleep', 'infinity'])
        probe_started = True
        QuietMonitor(HostProbe(name), output / 'host-before.jsonl', {label}).preflight()
        preflight = {'verdict': 'QUIET', 'probe': name, 'probe_label': label,
                     'plan_sha256': report['plan_sha256'], 'dry_run': True}
        (output / 'preflight.json').write_text(json.dumps(preflight, indent=2) + '\n', encoding='utf-8')

        class PilotFixture(EmrBLedgerLive):
            dry_run = True
            label_namespace = 'kin.emrb.dryrun'
            dry_run_preflight = preflight

            @classmethod
            def setUpClass(cls):
                if os.environ.get('KIN_EMR_BENCHMARK_MODE') != 'ci-gross':
                    raise ValueError('disposable pilot requires ci-gross')
                cls.setup_disposable_resources()

        class PilotMutant(EmrBLiveMutants):
            fixture_class = PilotFixture
            controls = {}

            def test_m36_receipt_startup_delay(self):
                self.run_disposable_mutant('M36')

        class GapFixture(PilotFixture):
            gap_diagnostic = True

            def test_idle_gap_diagnostic(self):
                from live_acceptance import compare
                compare(self, [])

        environment = {'KIN_EMR_BENCHMARK_MODE': 'ci-gross', 'KIN_TEST_API_IMAGE': image,
                       'KIN_EMR_LIVE_EVIDENCE': str(output / 'data'),
                       'KIN_EMR_MUTANT_SOURCE_MANIFEST': str(Path(source_manifest).resolve()) if source_manifest else ''}
        if not gap_diagnostic_only and not source_manifest:
            raise ValueError('full reduced plan requires the frozen mutant source manifest')
        with patch.dict(os.environ, environment):
            if gap_diagnostic_only:
                cases = [GapFixture('test_idle_gap_diagnostic')]
            else:
                cases = [PilotFixture(item['case'].split('.')[-1]) for item in plan['tests'][:3]]
                cases.append(PilotMutant('test_m36_receipt_startup_delay'))
            result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(cases))
        summaries = [json.loads(path.read_bytes()) for path in (output / 'data').glob('comparison-*/summary.json')]
        if gap_diagnostic_only:
            report.update(diagnostics=[s.get('gap_diagnostic') for s in summaries],
                          diagnostic_passed=result.wasSuccessful(),
                          invalid_reasons=[s.get('invalid_reason') for s in summaries if s['verdict'] == 'INVALID'],
                          verdict_preview=None if result.wasSuccessful() else 'INVALID')
            return 0 if result.wasSuccessful() else 1
        # The delayed mutant is expected to fail; it is not a healthy estimate.
        image_id = json.loads(run(['docker', 'image', 'inspect', image]).stdout)[0]['Id']
        healthy = [s for s in summaries if s.get('candidate_image') == image_id]
        metrics = {work: stats for s in healthy for work, stats in s['results'].items()}
        complete = set(metrics) == {'single', 'sustained', 'concurrent-24', 'concurrent-48'}
        report.update(cases_run=result.testsRun, ci_gross_passed=result.wasSuccessful(),
                      results=metrics, reports=[s['raw_directory'] for s in summaries])
        if complete and not any(s['verdict'] in ('INVALID', 'INCOMPLETE') for s in healthy):
            report['verdict_preview'] = 'PASS' if result.wasSuccessful() and all(r['acceptance_preview'] for r in metrics.values()) else 'FAIL'
        report['post_gap'] = next((s.get('post_gap') for s in healthy if 'single' in s['results']), None)
        mutant = output / 'data/mutants/M36/result.json'
        report['m36'] = json.loads(mutant.read_bytes()) if mutant.exists() else None
        return 0 if result.wasSuccessful() else 1
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        if probe_started:
            actual = json.loads(command(['docker', 'inspect', name]))[0]
            if actual['Config']['Labels'].get('kin.emrb.quiet') != token:
                raise RuntimeError('pilot probe ownership mismatch')
            run(['docker', 'rm', '-f', '-v', name])
        report['elapsed_seconds'] = time.monotonic() - started
        (output / 'pilot.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print('EMR_DRY_RUN ' + json.dumps(report), flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--source-manifest')
    parser.add_argument('--gap-diagnostic-only', action='store_true')
    args = parser.parse_args()
    raise SystemExit(pilot(args.plan, args.out, args.image, args.source_manifest, args.gap_diagnostic_only))
