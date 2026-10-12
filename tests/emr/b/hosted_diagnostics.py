"""REQ-D1038 -> RISK-HOST-OFFSET/START-ORDER -> hosted_diagnostics_test.

Record-only qualification. A/B still uses D1006; acceptance never enters here.
"""
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from noninferiority import noninferiority, concurrent_result, gate_result, p95, MIN_ATTRIBUTION

CONTROL_WORKLOADS = ('single', 'sustained')
ORDERS = ('r3-first', 'candidate-first')


def hosted_plan(workloads):
    """No I/O: exactly the plan executed below, including real fresh starts."""
    from live_acceptance import block_design, block_segments
    phases = []
    for phase, selected in [('ab', list(workloads)),
                            ('aa', [w for w in workloads if w in CONTROL_WORKLOADS])]:
        if not selected:
            continue
        phases.append({'phase': phase, 'pairs': [
            {'pair': i, 'start_order': ORDERS[i % 2],
             'prepare_order': ['r3', 'candidate'] if i % 2 == 0 else ['candidate', 'r3'],
             'fresh_db_and_state': True,
             'workloads': {w: {'segments': block_segments(w, i, block_design(w, 'ci-gross')[1]),
                               'plan_check': ['r3', 'candidate'] if w == 'sustained' else []}
                           for w in selected}}
            for i in range(6)]})
    return {'record_only': True, 'phases': phases, 'control_workloads': list(CONTROL_WORKLOADS),
            'control_orientation': 'second candidate in r3 slot; candidate minus r3 slot',
            'concurrent_control': False, 'added_hosted_minutes_estimate': 35,
            'estimate_scope': 'whole healthy hosted live suite; first hosted run must verify the 3600s budget'}


def order_statistics(pairs):
    """Recompute order medians from the recorded pairs, never from labels alone."""
    groups = {order: [] for order in ORDERS}
    valid = isinstance(pairs, list) and len(pairs) == 6
    if not isinstance(pairs, list):
        pairs = []
    for index, pair in enumerate(pairs):
        if not isinstance(pair, dict):
            valid = False
            continue
        order = pair.get('start_order')
        delta = pair.get('D_ms')
        good = (pair.get('pair') == index and order == ORDERS[index % 2]
                and type(delta) in (int, float) and math.isfinite(delta))
        valid = valid and good
        if good:
            groups[order].append(delta)
    return {'start_order_qualifies': bool(valid and all(len(g) == 3 for g in groups.values())),
            'D_ms_by_start_order': {key: statistics.median(g) if g else None for key, g in groups.items()}}


def control_statistics(samples, pairs, *, error=None):
    result = {'control_R': None, 'control_D_ms': None, 'control_pair_deltas_ms': [],
              'control_qualifies': False, **order_statistics(pairs)}
    try:
        if error:
            raise ValueError(error)
        if len(samples['r3']) != 6 or len(samples['candidate']) != 6:
            raise ValueError('six complete control pairs required')
        if any(type(v) not in (int, float) for blocks in samples.values() for block in blocks for v in block):
            raise ValueError('numeric control observations required')
        if not isinstance(pairs, list) or any(not isinstance(p, dict) for p in pairs):
            raise ValueError('control pair records required')
        stats = noninferiority(samples['r3'], samples['candidate'])
        qualifies = gate_result(stats, 'ci-gross')
        if [p.get('D_ms') for p in pairs] != stats['pair_deltas_ms']:
            raise ValueError('control pair records differ from samples')
        result.update(control_R=stats['R'], control_D_ms=stats['D'],
                      control_pair_deltas_ms=stats['pair_deltas_ms'],
                      control_qualifies=qualifies and result['start_order_qualifies'])
    except (KeyError, TypeError, ValueError, OverflowError) as failure:
        result['control_error'] = str(failure)
    return result


def run_qualification(reports):
    reasons = []
    controls = {w: [] for w in CONTROL_WORKLOADS}
    for report in reports:
        if report.get('verdict') == 'INCOMPLETE':
            reasons.append('incomplete A/B measurement')
        for workload in report.get('results', {}):
            if not order_statistics(report.get('pairs', {}).get(workload, []))['start_order_qualifies']:
                reasons.append(workload + ': missing or unbalanced start order')
        for workload, control in report.get('controls', {}).items():
            if workload in controls:
                controls[workload].append(control)
    for workload, values in controls.items():
        valid = len(values) == 1 and isinstance(values[0], dict)
        if valid:
            value = values[0]
            ratio, delta = value.get('control_R'), value.get('control_D_ms')
            deltas = value.get('control_pair_deltas_ms')
            valid = (value.get('control_qualifies') is True and value.get('start_order_qualifies') is True
                     and type(ratio) in (int, float) and math.isfinite(ratio) and ratio > 0
                     and type(delta) in (int, float) and math.isfinite(delta)
                     and isinstance(deltas, list) and len(deltas) == 6
                     and all(type(d) in (int, float) and math.isfinite(d) for d in deltas)
                     and delta == statistics.median(deltas)
                     and not (ratio > 1.25 and delta > 5))
        if not valid:
            reasons.append(workload + ': missing, invalid or noisy A/A control')
    return {'record_only': True, 'would_be': 'INVALID' if reasons else 'VALID',
            'reasons': reasons, 'proposal': 'Later decision only: INVALID -> re-run, never PASS',
            'verdict_changed': False}


class HostedPair:
    """One pair owns fresh labelled resources; release them before the next pair."""
    def __init__(self, fixture, out, token, images, record):
        self.fixture, self.out, self.token = fixture, out, token
        self.images, self.record = images, record
        self.sessions, self.streams = {}, []
        self.owned = {'container': [], 'volume': []}

    def command(self, version, request):
        process = self.sessions[version]
        process.stdin.write(json.dumps(request) + '\n')
        process.stdin.flush()
        while True:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError(version + ' benchmark ended before response')
            if line.startswith('EMR_BENCHMARK '):
                response = json.loads(line[len('EMR_BENCHMARK '):])
                with (self.out / (version + '.jsonl')).open('a', encoding='utf-8') as stream:
                    stream.write(json.dumps({'request': request, 'response': response}) + '\n')
                self.fixture.assertNotIn('error', response, response)
                if 'summary' in response:
                    self.fixture.assertEqual(response['summary']['failures'], 0, response)
                    self.fixture.assertEqual(len(response['results']), request['count'])
                return response

    def start(self, order):
        from live_acceptance import WARMUP_REQUESTS
        fixture, cls = self.fixture, type(self.fixture)
        before = {kind: list(cls.created[kind]) for kind in self.owned}
        started = time.monotonic()
        self.record['instances'] = []
        self.out.mkdir(parents=True)
        try:
            for version in order:
                image = self.images[version]
                cls.image = image
                suffix = self.token + '-' + version
                db = fixture.start_db(suffix, persistent=True)
                fixture.provision(db)
                fixture.migrate(db)
                fixture.ok(fixture.latency_probe, db=db)
                state = fixture.volume(suffix)
                name = 'kin-emrb-' + fixture.token + '-bench-' + suffix
                cls.created['container'].append(name)
                instance = {'version': version, 'image_digest': image, 'db': db, 'state_volume': state,
                            'container': name, 'prepared_at_monotonic': time.monotonic()}
                self.record['instances'].append(instance)
                stderr = (self.out / (version + '-stderr.log')).open('w', encoding='utf-8')
                self.streams.append(stderr)
                process = subprocess.Popen(['docker', 'run', '--name', name, '--label', fixture.label,
                    '-i', '--network', 'container:' + db, '-e', 'DATABASE_URL', '-e', 'KIN_EMR_STATE_DIR=/var/lib/kin-emr',
                    '-v', state + ':/var/lib/kin-emr', '-v', str(Path(__file__).parent.resolve()) + ':/emr-b:ro',
                    '--entrypoint', 'node', image, '/emr-b/contract_test.cjs', '--emr-b-live', 'benchmark', '{"measure":true}'],
                    env={**fixture.env, 'DATABASE_URL': fixture.url() + '?connection_limit=6'},
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding='utf-8')
                self.sessions[version] = process
                ready = process.stdout.readline()
                fixture.assertIn('"ready":true', ready, version + ' benchmark did not initialize: ' + ready)
                instance['warmup'] = self.command(version, {'kind': 'single', 'count': WARMUP_REQUESTS})
                instance['ready_at_monotonic'] = time.monotonic()
        finally:
            self.record['setup_seconds'] = time.monotonic() - started
            self.owned = {kind: [name for name in cls.created[kind] if name not in before[kind]]
                          for kind in self.owned}

    def close(self):
        started = time.monotonic()
        errors = []
        for process in self.sessions.values():
            try:
                process.stdin.write('{"kind":"close"}\n')
                process.stdin.flush()
                process.communicate(timeout=30)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.communicate(timeout=10)
        for stream in self.streams:
            stream.close()
        for kind, names in self.owned.items():
            for name in reversed(names):
                if kind == 'container':
                    result = subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True, timeout=120)
                else:
                    result = subprocess.run(['docker', 'volume', 'rm', name], capture_output=True, timeout=120)
                if result.returncode:
                    errors.append(kind + ': ' + name)
                else:
                    type(self.fixture).created[kind].remove(name)
        self.record['cleanup_seconds'] = time.monotonic() - started
        if errors:
            raise RuntimeError('pair cleanup incomplete: ' + ', '.join(errors))


def collect_phase(fixture, report, phase, images, out):
    from live_acceptance import (SINGLE_IDLE_MS, SETTLE_SECONDS, SUSTAINED_RPS,
                                 RETAINED_ROWS)
    selected = list(phase['pairs'][0]['workloads'])
    samples = {w: {'r3': [], 'candidate': []} for w in selected}
    rows = {w: {'r3': [], 'candidate': []} for w in selected}
    pairs = {w: [] for w in selected}
    target = report if phase['phase'] == 'ab' else report['control_measurements']
    target.update(samples=samples, pairs=pairs)
    for spec in phase['pairs']:
        pair_id = phase['phase'] + '-' + str(spec['pair'])
        record = {'pair': spec['pair'], 'start_order': spec['start_order'], 'workloads': {}}
        report.setdefault('preparations', []).append(record)
        record['phase'] = phase['phase']
        pair = HostedPair(fixture, out / pair_id, out.name + '-' + pair_id, images, record)
        try:
            pair.start(spec['prepare_order'])
            for workload, design in spec['workloads'].items():
                details = record['workloads'][workload] = {}
                if workload == 'sustained':
                    start = time.monotonic()
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        futures = {v: pool.submit(pair.command, v, {'kind': 'prefill', 'count': RETAINED_ROWS})
                                   for v in spec['prepare_order']}
                        for version, future in futures.items():
                            seed = future.result()
                            fixture.assertEqual(seed['after'] - seed['before'], RETAINED_ROWS)
                    details['prefill_seconds'] = time.monotonic() - start
                    details['prefill_per_revision'] = RETAINED_ROWS
                    details['plans'] = {v: pair.command(v, {'kind': 'plans'}) for v in spec['prepare_order']}
                time.sleep(SETTLE_SECONDS)
                details['block_start_monotonic'] = time.monotonic()
                observations = {'r3': [], 'candidate': []}
                for version, size in design['segments']:
                    request = {'kind': 'concurrent' if workload.startswith('concurrent-') else workload, 'count': size}
                    if workload == 'single':
                        request['idle_ms'] = SINGLE_IDLE_MS
                    if workload == 'sustained':
                        request['rps'] = SUSTAINED_RPS
                    data = pair.command(version, request)
                    observations[version].extend(row['receipt_ms'] for row in data['results'])
                    rows[workload][version].extend(data['results'])
                for version in observations:
                    samples[workload][version].append(observations[version])
                pairs[workload].append({'pair': spec['pair'], 'start_order': spec['start_order'],
                    'D_ms': p95(observations['candidate']) - p95(observations['r3']),
                    'raw_directory': str(pair.out), 'block_start_monotonic': details['block_start_monotonic']})
        finally:
            pair.close()
    return samples, rows, pairs


def compare_hosted(fixture, workloads):
    cls = type(fixture)
    if 'baseline_image' not in cls.__dict__:
        fixture.baseline_appends(1)
    candidate_image = cls.image
    # Pin the process and migration image references once, before either phase.
    # The fixture already pins candidate, but r3 is built under a local tag.
    images = {}
    for version, reference in [('candidate', candidate_image), ('r3', cls.baseline_image)]:
        inspected = subprocess.run(['docker', 'image', 'inspect', reference],
                                   check=True, capture_output=True, text=True)
        images[version] = json.loads(inspected.stdout)[0]['Id']
    root = Path(os.environ.get('KIN_EMR_LIVE_EVIDENCE', str(Path(__file__).resolve().parents[3] / 'tmp/emr-b1/live')))
    out = root / ('comparison-' + uuid.uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=False)
    from live_acceptance import block_design, WARMUP_REQUESTS
    report = {'decision': 'D961', 'mode': 'ci-gross', 'dry_run': False, 'workloads': workloads,
              'verdict': 'INCOMPLETE', 'candidate_image': images['candidate'], 'baseline_image': images['r3'],
              'design': {w: block_design(w, 'ci-gross') for w in workloads},
              'diagnostic_design': hosted_plan(workloads), 'warmup': WARMUP_REQUESTS,
              'fresh_db_and_state': True, 'postgres_storage': 'fresh durable local volumes',
              'samples': {}, 'results': {}, 'controls': {}, 'control_measurements': {}, 'raw_directory': str(out)}
    try:
        ab = report['diagnostic_design']['phases'][0]
        samples, rows, pairs = collect_phase(fixture, report, ab, images, out)
        for workload in workloads:
            estimator = concurrent_result if workload.startswith('concurrent-') else noninferiority
            result = estimator(samples[workload]['r3'], samples[workload]['candidate'])
            result['attribution'] = {v: sum(r['attributed_ms'] for r in data) / sum(r['receipt_ms'] for r in data)
                                     for v, data in rows[workload].items()}
            result['attribution_met'] = all(v >= MIN_ATTRIBUTION for v in result['attribution'].values())
            gate_result(result, 'ci-gross')
            result['noninferiority_met'] = result.pop('accepted')
            result['acceptance_preview'] = result['noninferiority_met'] and result['attribution_met']
            result.update(order_statistics(pairs[workload]))
            result['block_start_monotonic'] = [p['block_start_monotonic'] for p in pairs[workload]]
            result['block_start_span_seconds'] = result['block_start_monotonic'][-1] - result['block_start_monotonic'][0]
            report['results'][workload] = result
        # Record the unchanged A/B decision before the diagnostic, including FAIL.
        report['verdict'] = 'CI_PASS' if all(r['gate_passed'] for r in report['results'].values()) else 'FAIL'
        report['verdict_preview'] = 'PASS' if all(r['acceptance_preview'] for r in report['results'].values()) else 'FAIL'
        if len(report['diagnostic_design']['phases']) > 1:
            error = None
            try:
                collect_phase(fixture, report, report['diagnostic_design']['phases'][1],
                              {'candidate': images['candidate'], 'r3': images['candidate']}, out)
            except Exception as failure:
                # Diagnostic failure must not replace the A/B verdict or look like
                # a quiet control. Preserve raw partial evidence and explicit INVALID.
                error = type(failure).__name__ + ': ' + str(failure)
            for workload in workloads:
                if workload in CONTROL_WORKLOADS:
                    measured = report['control_measurements']
                    control = control_statistics(measured.get('samples', {}).get(workload, {}),
                                                 measured.get('pairs', {}).get(workload, []), error=error)
                    report['controls'][workload] = control
                    report['results'][workload].update({k: v for k, v in control.items() if k.startswith('control_')})
    finally:
        cls.image = candidate_image
        report['run_qualification'] = run_qualification([report])
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('EMR_LIVE_ACCEPTANCE ' + json.dumps({k: v for k, v in report.items()
          if k not in ('samples', 'control_measurements', 'preparations')}), flush=True)
    for workload, result in report['results'].items():
        fixture.assertTrue(result['gate_passed'], 'D961 ci-gross ' + workload + ': ' + json.dumps(result))
    return report


if __name__ == '__main__':
    # This is a plan-only dry run. The historic live pilot's dry_run=True remains
    # a different, longer design and still requires disposable containers.
    print(json.dumps(hosted_plan(['single', 'sustained', 'concurrent-24', 'concurrent-48']), indent=2))
