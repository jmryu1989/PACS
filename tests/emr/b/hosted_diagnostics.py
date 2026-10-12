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

from noninferiority import (noninferiority, concurrent_result, gate_result, p95, MIN_ATTRIBUTION,
                           CI_RATIO_LIMIT, CI_DELTA_FLOOR_MS)

CONTROL_WORKLOADS = ('single', 'sustained')
ORDERS = ('r3-first', 'candidate-first')
START_ORDERS = ('r3-first', 'r3-first', 'candidate-first', 'candidate-first', 'r3-first', 'candidate-first')
UNIT_LIMIT_SECONDS = 3600
AA_MINIMUM_SECONDS = 6 * (40 + 5 + 142 + 22 + 10)
FOLLOWING_CASES_RESERVE_SECONDS = 300


def unit_elapsed_seconds():
    """Worker age includes fixture/image setup and earlier cases, including mutants.

    Reading the OS process clock avoids resetting the budget at each comparison.
    An unavailable clock skips diagnostics; it never relaxes the binding A/B gate.
    """
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        stamps = [wintypes.FILETIME() for _ in range(4)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), *(ctypes.byref(s) for s in stamps)):
            raise OSError(ctypes.get_last_error(), 'GetProcessTimes')
        created = ((stamps[0].dwHighDateTime << 32) | stamps[0].dwLowDateTime) / 10**7 - 11644473600
        return max(0, time.time() - created)
    fields = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
    return max(0, time.clock_gettime(time.CLOCK_BOOTTIME) - int(fields[19]) / os.sysconf('SC_CLK_TCK'))


def control_budget(report):
    measured = [r['elapsed_seconds'] for r in report.get('preparations', []) if r['phase'] == 'ab']
    required = max(AA_MINIMUM_SECONDS, 6 * max(measured, default=0) * 1.2)
    try:
        elapsed = unit_elapsed_seconds()
    except (OSError, ValueError, AttributeError, IndexError) as error:
        return {'allowed': False, 'reason': 'budget', 'clock_error': str(error)}
    remaining = UNIT_LIMIT_SECONDS - elapsed
    return {'allowed': remaining >= required + FOLLOWING_CASES_RESERVE_SECONDS,
            'reason': 'budget', 'unit_limit_seconds': UNIT_LIMIT_SECONDS, 'elapsed_seconds': elapsed,
            'remaining_seconds': remaining, 'required_aa_seconds': required,
            'following_cases_reserve_seconds': FOLLOWING_CASES_RESERVE_SECONDS}


def hosted_plan(workloads):
    """No I/O: exactly the plan executed below, including real fresh starts."""
    from live_acceptance import block_design, block_segments
    phases = []
    for phase, selected in [('ab', list(workloads)),
                            ('aa', [w for w in workloads if w in CONTROL_WORKLOADS])]:
        if not selected:
            continue
        phases.append({'phase': phase, 'pairs': [
            {'pair': i, 'start_order': START_ORDERS[i],
             'prepare_order': ['r3', 'candidate'] if START_ORDERS[i] == 'r3-first' else ['candidate', 'r3'],
             'request_order': 'candidate-first' if i % 2 == 0 else 'r3-first',
             'fresh_db_and_state': True,
             'workloads': {w: {'segments': block_segments(w, i, block_design(w, 'ci-gross')[1]),
                               'plan_check': ['r3', 'candidate'] if w == 'sustained' else []}
                           for w in selected}}
            for i in range(6)]})
    return {'record_only': True, 'phases': phases, 'control_workloads': list(CONTROL_WORKLOADS),
            'control_orientation': 'second candidate in r3 slot; candidate minus r3 slot',
            'concurrent_control': False, 'request_order_phi': -1 / 3,
            'added_hosted_minutes_estimate': {'live': [35, 43], 'mutants': [3, 7]},
            'estimate_scope': 'fresh process/DB/volume per A/B pair; earlier hosted runs are not like-for-like; '
                              'includes ten extra M03/M36 setups; verify actual costs on first green hosted run'}


def order_statistics(pairs):
    """Recompute order medians from the recorded pairs, never from labels alone."""
    groups = {order: [] for order in ORDERS}
    requests = {order: [] for order in ORDERS}
    cells = {start: {request: [] for request in ORDERS} for start in ORDERS}
    valid = isinstance(pairs, list) and len(pairs) == 6
    if not isinstance(pairs, list):
        pairs = []
    for index, pair in enumerate(pairs):
        if not isinstance(pair, dict):
            valid = False
            continue
        order = pair.get('start_order')
        delta = pair.get('D_ms')
        request = pair.get('request_order')
        good = (index < 6 and pair.get('pair') == index and order == START_ORDERS[index]
                and request == ('candidate-first' if index % 2 == 0 else 'r3-first')
                and type(delta) in (int, float) and math.isfinite(delta))
        valid = valid and good
        if good:
            groups[order].append(delta)
            requests[request].append(delta)
            cells[order][request].append(delta)
    a, b = (len(cells[ORDERS[0]][r]) for r in ORDERS)
    c, d = (len(cells[ORDERS[1]][r]) for r in ORDERS)
    denominator = ((a+b)*(c+d)*(a+c)*(b+d)) ** .5
    return {'start_order_qualifies': bool(valid and all(len(g) == 3 for g in groups.values())),
            'D_ms_by_start_order': {key: statistics.median(g) if g else None for key, g in groups.items()},
            'D_ms_by_request_order': {key: statistics.median(g) if g else None for key, g in requests.items()},
            'start_request_table': {s: {r: {'count': len(g), 'D_ms': statistics.median(g) if g else None}
                                        for r, g in row.items()} for s, row in cells.items()},
            'request_order_phi': (a*d-b*c)/denominator if denominator else None}


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
        if report.get('control_budget', {}).get('allowed') is False:
            reasons.append('budget')
        if 'budget' in report.get('run_qualification', {}).get('reasons', []):
            reasons.append('budget')
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
                     and not (ratio > CI_RATIO_LIMIT and delta > CI_DELTA_FLOOR_MS))
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

    def command(self, version, request, *, binding=True):
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
                if binding:
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
    target.update(samples=samples, pairs=pairs, rows=rows)
    for spec in phase['pairs']:
        pair_id = phase['phase'] + '-' + str(spec['pair'])
        record = {'pair': spec['pair'], 'start_order': spec['start_order'],
                  'request_order': spec['request_order'], 'workloads': {}}
        report.setdefault('preparations', []).append(record)
        record['phase'] = phase['phase']
        pair = HostedPair(fixture, out / pair_id, out.name + '-' + pair_id, images, record)
        pair_started = time.monotonic()
        print('EMR_LIVE_PAIR ' + json.dumps({'phase': phase['phase'], **spec}), flush=True)
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
                            print('EMR_LIVE_PREFILL ' + json.dumps({'phase': phase['phase'], 'pair': spec['pair'],
                                  'version': version, **seed}), flush=True)
                    details['prefill_seconds'] = time.monotonic() - start
                    details['prefill_per_revision'] = RETAINED_ROWS
                    details['plans'], details['plan_seconds'] = {}, {}
                    for version in spec['prepare_order']:
                        start = time.monotonic()
                        # r3 predates jit=off and verificationPage. Preserve its
                        # early error, without turning it into a candidate guard.
                        plan = pair.command(version, {'kind': 'plans'}, binding=False)
                        details['plans'][version] = plan
                        details['plan_seconds'][version] = time.monotonic() - start
                        if phase['phase'] == 'ab' and version == 'candidate':
                            report['jit'] = plan
                        print('EMR_VERIFICATION_PLAN ' + json.dumps({'phase': phase['phase'], 'pair': spec['pair'],
                              'version': version, **{k: v for k, v in plan.items() if k != 'statements'}}), flush=True)
                        if phase['phase'] == 'aa' or version == 'candidate':
                            fixture.assertNotIn('error', plan, plan)
                time.sleep(SETTLE_SECONDS)
                details['block_start_monotonic'] = time.monotonic()
                observations = {'r3': [], 'candidate': []}
                for segment, (version, size) in enumerate(design['segments']):
                    request = {'kind': 'concurrent' if workload.startswith('concurrent-') else workload, 'count': size}
                    if workload == 'single':
                        request['idle_ms'] = SINGLE_IDLE_MS
                    if workload == 'sustained':
                        request['rps'] = SUSTAINED_RPS
                    data = pair.command(version, request)
                    observations[version].extend(row['receipt_ms'] for row in data['results'])
                    rows[workload][version].extend(data['results'])
                    print('EMR_LIVE_BLOCK ' + json.dumps({'phase': phase['phase'], 'workload': workload,
                          'block': spec['pair'], 'segment': segment, 'version': version, **data['summary']}), flush=True)
                for version in observations:
                    samples[workload][version].append(observations[version])
                pairs[workload].append({'pair': spec['pair'], 'start_order': spec['start_order'],
                    'request_order': spec['request_order'],
                    'D_ms': p95(observations['candidate']) - p95(observations['r3']),
                    'raw_directory': str(pair.out), 'block_start_monotonic': details['block_start_monotonic']})
        finally:
            try:
                pair.close()
            finally:
                record['elapsed_seconds'] = time.monotonic() - pair_started
    return samples, rows, pairs


def record_ab_results(report):
    """Keep completed blocks even when a later request/plan aborts the phase."""
    from live_acceptance import SINGLE_IDLE_MS
    for workload, samples in report.get('samples', {}).items():
        pairs = report['pairs'][workload]
        count = len(pairs)
        if not count:
            continue
        if count != 6:
            report['results'][workload] = {'complete': False, 'paired_blocks': count,
                                          'pair_deltas_ms': [p['D_ms'] for p in pairs]}
        else:
            estimator = concurrent_result if workload.startswith('concurrent-') else noninferiority
            result = estimator(samples['r3'], samples['candidate'])
            result['attribution'] = {v: sum(r['attributed_ms'] for r in data) / sum(r['receipt_ms'] for r in data)
                                     for v, data in report['rows'][workload].items()}
            result['attribution_met'] = all(v >= MIN_ATTRIBUTION for v in result['attribution'].values())
            gate_result(result, 'ci-gross')
            result['noninferiority_met'] = result.pop('accepted')
            result['acceptance_preview'] = result['noninferiority_met'] and result['attribution_met']
            result.update(order_statistics(pairs))
            result['block_start_monotonic'] = [p['block_start_monotonic'] for p in pairs]
            result['block_start_span_seconds'] = result['block_start_monotonic'][-1] - result['block_start_monotonic'][0]
            report['results'][workload] = result
        if workload == 'single':
            medians = {}
            for version, rows in report['rows'][workload].items():
                post = [r['receipt_ms'] for r in rows if r.get('segment_request', 0) > 0
                        and (r.get('idle_gap_ms') or 0) >= SINGLE_IDLE_MS - 1]
                warm = [row['receipt_ms'] for p in report['preparations'] if p['phase'] == 'ab'
                        for instance in p.get('instances', []) if instance['version'] == version
                        for row in instance.get('warmup', {}).get('results', [])[1:]]
                medians[version] = {'post_gap_ms': statistics.median(post) if post else None,
                                    'gap_free_warm_ms': statistics.median(warm) if warm else None}
            report['post_gap'] = medians
            if all(v['post_gap_ms'] is not None and v['gap_free_warm_ms'] is not None for v in medians.values()):
                report['post_gap']['warmup_based_offset_ms'] = (
                    medians['candidate']['post_gap_ms'] - medians['candidate']['gap_free_warm_ms']
                    - medians['r3']['post_gap_ms'] + medians['r3']['gap_free_warm_ms'])
                report['post_gap']['limitation'] = 'fresh-pair warm-up rows are not a balanced idle-effect control; use the separate gap diagnostic'


def persist_report(report, out):
    report['run_qualification'] = run_qualification([report])
    (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


def print_report(report):
    print('EMR_LIVE_ACCEPTANCE ' + json.dumps({k: v for k, v in report.items()
          if k not in ('samples', 'rows', 'control_measurements', 'preparations')}), flush=True)


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
        try:
            collect_phase(fixture, report, ab, images, out)
        finally:
            record_ab_results(report)
        # Record the unchanged A/B decision before the diagnostic, including FAIL.
        report['verdict'] = 'CI_PASS' if all(r['gate_passed'] for r in report['results'].values()) else 'FAIL'
        report['verdict_preview'] = 'PASS' if all(r['acceptance_preview'] for r in report['results'].values()) else 'FAIL'
        persist_report(report, out)
        print_report(report)
        if len(report['diagnostic_design']['phases']) > 1:
            error = None
            try:
                report['control_budget'] = control_budget(report)
                if not report['control_budget']['allowed']:
                    raise RuntimeError('budget')
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
        persist_report(report, out)
    print_report(report)
    for workload, result in report['results'].items():
        fixture.assertTrue(result['gate_passed'], 'D961 ci-gross ' + workload + ': ' + json.dumps(result))
    return report


if __name__ == '__main__':
    # This is a plan-only dry run. The historic live pilot's dry_run=True remains
    # a different, longer design and still requires disposable containers.
    print(json.dumps(hosted_plan(['single', 'sustained', 'concurrent-24', 'concurrent-48']), indent=2))
