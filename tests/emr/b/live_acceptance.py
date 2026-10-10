"""D952: paired ABBA blocks, fresh durable volumes, explicit verdict mode.

Single: 10x120, 200 ms idle, first-to-last block starts >=600 seconds.
Concurrent: 24 bursts/size/revision, quiet settle before each pair. Sustained: 12x200 at
20 rps after 20k product appends. CI records the same statistics but only
point<=1.25 gates; only the commander's reviewed live plan uses the NI bound.
"""
import contextlib
import json
import os
from pathlib import Path
import subprocess
import uuid
import time
import hashlib
import statistics
from concurrent.futures import ThreadPoolExecutor

from noninferiority import (noninferiority, concurrent_result, gate_result,
                           SINGLE_BLOCKS, SINGLE_REQUESTS, CONCURRENT_BLOCKS, SUSTAINED_BLOCKS, MIN_ATTRIBUTION, T95)
from quiet_host import HostProbe, QuietMonitor, InvalidRun

WARMUP_REQUESTS = 5
SINGLE_PER_BLOCK = SINGLE_REQUESTS
SINGLE_IDLE_MS = 200
SETTLE_SECONDS = 2
MIN_SINGLE_SPAN_SECONDS = 600
SUSTAINED_RPS = 20
SUSTAINED_COUNT = 200
RETAINED_ROWS = 20000
PASSED_CONTROLS = {}


def estimate_duration(plan):
    """R9 pilot timings plus explicit overhead; refuse unknown case mixes.

    Parallel prefill took 128.39 s for 2400 rows/revision: project linearly
    to 20k and add 10%. Ordinary burst budgets round up the pilot observations;
    busy-host windows are budgeted separately, not multiplied into every burst.
    The reduced pilot's setup/build/functional/cleanup remainder was <300 s.
    This is a planning estimate, not a guarantee on an arbitrarily busy host.
    """
    expected = [
        ('tests/emr/b/live.py', 'EmrBLedgerLive.test_b03_idempotency_and_concurrent_append'),
        ('tests/emr/b/live.py', 'EmrBLedgerLive.test_b03b_concurrent_48_receipts'),
        ('tests/emr/b/live.py', 'EmrBLedgerLive.test_b03c_warm_single_sustained_and_verification_plans'),
        ('tests/emr/b/live_mutants.py', 'EmrBLiveMutants.test_m36_receipt_startup_delay')]
    if [(t['file'], t['case']) for t in plan.get('tests', [])] != expected:
        raise ValueError('duration model requires reviewed L03/L03b/L03c/M36 order')
    segment = (SINGLE_PER_BLOCK / 2 - 1) * SINGLE_IDLE_MS / 1000 + SINGLE_PER_BLOCK / 2 * .050
    block_seconds = 2.8 + 4 * segment
    # The last block starts at/after 600s and still has to finish. Counting only
    # 600s hides that last block when the natural run is shorter than the spread.
    parts = {'single': max(2.8 + MIN_SINGLE_SPAN_SECONDS + block_seconds, SINGLE_BLOCKS * block_seconds),
             'concurrent_24_and_48': CONCURRENT_BLOCKS * ((2.8 + 2 * .6) + (2.8 + 2 * 1.6)),
             'sustained': SUSTAINED_BLOCKS * (2.8 + 2 * ((SUSTAINED_COUNT - 1) / SUSTAINED_RPS + .55)),
             'parallel_prefill': 128.4 * RETAINED_ROWS / 2400 * 1.10,
             'm36_mutant': CONCURRENT_BLOCKS * (2.8 + 2.3 + 1.0),
             'setup_builds_functional_cleanup': 300, 'quiet_wait_allowance': 180}
    total = sum(parts.values())
    cap = min(3000, .85 * plan['timeout_seconds'])
    return {'components_seconds': parts, 'estimated_seconds': total,
            'estimated_minutes': total / 60, 'cap_seconds': cap, 'within_cap': total <= cap,
            'm36_control': 'reuse same-process successful L03; no repeated healthy comparison',
            'basis': 'D956: 10x120 single at 50ms/receipt with 200ms request gaps, including final block after 600s; R9 pilot prefill 128.39 s/2400 rows/revision',
            'limitation': '20k parallel prefill is extrapolated, not measured in R9; 10% prefill margin and 180 s extra quiet waiting included; persistent noise can still invalidate before the 3600 s runner cap'}


def control_key(image):
    preflight = os.environ.get('KIN_EMR_ACCEPTANCE_RECORD', '')
    digest = hashlib.sha256(Path(preflight).read_bytes()).hexdigest() if preflight else None
    return (image, os.environ.get('KIN_EMR_BENCHMARK_MODE', 'ci-gross'),
            str(Path(os.environ.get('KIN_EMR_LIVE_EVIDENCE', '.')).resolve()),
            preflight, digest)


def register_l03_control(image, report):
    """Called only after the full L03 method and its comparison have passed."""
    if report['verdict'] not in ('PASS', 'CI_PASS'):
        raise ValueError('cannot reuse an unsuccessful L03')
    path = Path(report['raw_directory']) / 'summary.json'
    PASSED_CONTROLS[control_key(image)] = {
        'passed': True, 'reused': True, 'case': 'L03', 'image': image,
        'log': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def reusable_l03_control(image):
    value = PASSED_CONTROLS.get(control_key(image))
    if value and hashlib.sha256(Path(value['log']).read_bytes()).hexdigest() == value['sha256']:
        return dict(value)
    return None


def block_design(workload, mode, dry_run=False):
    # Hosted CI samples are diagnostics for a gross-regression gate, never an
    # acceptance. Keep its fixed shorter design distinct in the raw report.
    if mode == 'ci-gross':
        if dry_run:
            if workload == 'single':
                return SINGLE_BLOCKS, SINGLE_PER_BLOCK, MIN_SINGLE_SPAN_SECONDS / (SINGLE_BLOCKS - 1)
            return 6, {'single': 40, 'sustained': 40}.get(workload, int(workload.split('-')[-1]) if workload.startswith('concurrent-') else 40), 0
        return 6, {'single': 10, 'sustained': SUSTAINED_COUNT}.get(workload, int(workload.split('-')[-1]) if workload.startswith('concurrent-') else 10), 0
    count = SINGLE_BLOCKS if workload == 'single' else SUSTAINED_BLOCKS if workload == 'sustained' else CONCURRENT_BLOCKS
    size = SINGLE_PER_BLOCK if workload == 'single' else SUSTAINED_COUNT if workload == 'sustained' else int(workload.split('-')[-1])
    return count, size, MIN_SINGLE_SPAN_SECONDS / (SINGLE_BLOCKS - 1) if workload == 'single' else 0


def block_segments(workload, block, size):
    order = ['candidate', 'r3'] if block % 2 == 0 else ['r3', 'candidate']
    # Each single experimental block is a complete ABBA crossover: two halves
    # requests per revision, pooled to one block p95 before the paired t test.
    # A burst is indivisible, so concurrent pairs alternate AB then BA.
    if workload == 'single':
        return [(version, size // 2) for version in order + order[::-1]]
    return [(version, size) for version in order]


def compare(fixture, workloads):
    mode = os.environ.get('KIN_EMR_BENCHMARK_MODE', 'ci-gross')
    if mode not in ('acceptance', 'ci-gross'):
        raise ValueError('unknown benchmark mode')
    preflight = None
    dry_run = getattr(fixture, 'dry_run', False)
    gap_diagnostic = getattr(fixture, 'gap_diagnostic', False)
    if gap_diagnostic and (not dry_run or workloads):
        raise ValueError('idle diagnostic is a separate attempt-free pilot, not an acceptance workload')
    if not workloads and not gap_diagnostic:
        raise ValueError('at least one reviewed workload required')
    if dry_run and mode != 'ci-gross':
        raise ValueError('dry run requires the hosted ci-gross path')
    if mode == 'acceptance':
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            raise ValueError('hosted CI cannot run the NI acceptance verdict')
        preflight = json.loads(Path(os.environ['KIN_EMR_ACCEPTANCE_RECORD']).read_text(encoding='utf-8'))
        raw_plan = Path(os.environ['KIN_EMR_ACCEPTANCE_PLAN']).read_bytes()
        plan = json.loads(raw_plan)
        if (preflight['verdict'] != 'QUIET' or preflight['unit'] != plan['unit']
                or preflight['plan_sha256'] != hashlib.sha256(raw_plan).hexdigest()):
            raise InvalidRun('missing commander pre-lease quiet-host record')
    elif dry_run:
        preflight = fixture.dry_run_preflight
    cls = type(fixture)
    if 'baseline_image' not in cls.__dict__:
        fixture.baseline_appends(1)  # builds the pinned source; this cold observation is not accepted
    candidate_image = cls.image
    token = uuid.uuid4().hex[:8]
    root = Path(os.environ.get('KIN_EMR_LIVE_EVIDENCE', str(Path(__file__).resolve().parents[3] / 'tmp/emr-b1/live')))
    out = root / ('comparison-' + token)
    out.mkdir(parents=True, exist_ok=False)
    sessions, files = {}, []
    report = {'decision': 'D952', 'mode': mode, 'dry_run': dry_run, 'workloads': workloads, 'verdict': 'INCOMPLETE',
              'candidate_image': candidate_image, 'baseline_image': cls.baseline_image,
              'design': {w: block_design(w, mode, dry_run) for w in workloads}, 'preflight': preflight,
              'warmup': WARMUP_REQUESTS, 'fresh_db_and_state': True, 'postgres_storage': 'fresh durable local volumes',
              'samples': {}, 'results': {}, 'raw_directory': str(out)}

    def command(version, value):
        process = sessions[version]
        process.stdin.write(json.dumps(value) + '\n')
        process.stdin.flush()
        while True:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError(version + ' benchmark ended before response; inspect stderr')
            if line.startswith('EMR_BENCHMARK '):
                result = json.loads(line[len('EMR_BENCHMARK '):])
                with (out / (version + '.jsonl')).open('a', encoding='utf-8') as log:
                    log.write(json.dumps({'request': value, 'response': result}) + '\n')
                fixture.assertNotIn('error', result, result)
                if 'summary' in result:
                    fixture.assertEqual(result['summary']['failures'], 0, result)
                    fixture.assertEqual(len(result['results']), value['count'])
                return result

    stack = contextlib.ExitStack()
    monitor = None
    try:
        for version, image in [('candidate', candidate_image), ('r3', cls.baseline_image)]:
            cls.image = image
            db = fixture.start_db(token + '-' + version, persistent=True)
            fixture.provision(db)
            fixture.migrate(db)
            fixture.ok(fixture.latency_probe, db=db)
            if gap_diagnostic:
                # Only synthetic diagnostic DBs log statements. The measured
                # receipt performs no extra connection/plan introspection SQL.
                fixture.ok("ALTER SYSTEM SET log_min_duration_statement = 0; ALTER SYSTEM SET log_connections = on; ALTER SYSTEM SET log_disconnections = on; SELECT pg_reload_conf();", db=db)
                report.setdefault('diagnostic_databases', {})[version] = db
            state = fixture.volume(token + '-' + version)
            name = 'kin-emrb-' + fixture.token + '-bench-' + token + '-' + version
            cls.created['container'].append(name)
            env = {**fixture.env, 'DATABASE_URL': fixture.url() + '?connection_limit=6'}
            stderr = (out / (version + '-stderr.log')).open('w', encoding='utf-8')
            files.append(stderr)
            process = subprocess.Popen(['docker', 'run', '--name', name, '--label', fixture.label,
                '-i', '--network', 'container:' + db, '-e', 'DATABASE_URL', '-e', 'KIN_EMR_STATE_DIR=/var/lib/kin-emr',
                '-v', state + ':/var/lib/kin-emr', '-v', str(Path(__file__).parent.resolve()) + ':/emr-b:ro',
                '--entrypoint', 'node', image, '/emr-b/contract_test.cjs', '--emr-b-live', 'benchmark', '{"measure":true}'],
                env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding='utf-8')
            sessions[version] = process
            ready = process.stdout.readline()
            fixture.assertIn('"ready":true', ready, version + ' benchmark did not initialize: ' + ready)
            report.setdefault('cold_and_warmup', {})[version] = command(version, {'kind': 'single', 'count': WARMUP_REQUESTS})

        if preflight:
            monitor = QuietMonitor(HostProbe(preflight['probe']), out / 'host-during.jsonl',
                                   {preflight['probe_label'], fixture.label})
            monitor.preflight()  # Recheck after image/container setup, before measuring.
            stack.enter_context(monitor)
        if gap_diagnostic:
            diagnostics = {'candidate': [], 'r3': []}
            for block in range(6):
                monitor.wait_quiet()
                for version, _ in block_segments('concurrent-24', block, 40):
                    data = command(version, {'kind': 'gap-sweep', 'count': 40, 'block': block})
                    groups = {g['id']: g for g in data['drain_groups']}
                    for row in data['results']:
                        parts = [row] + [groups[key] for key in row['drain_groups']]
                        for field in ('pool_wait_ms', 'coordinator_ms', 'fsync_ms', 'commit_ms'):
                            row['total_' + field] = sum(p.get(field, 0) for p in parts)
                        row['transaction_sql_ms'] = sum(s['ms'] for p in parts for s in p.get('statements', []))
                    diagnostics[version].append(data['results'])
                    print('EMR_GAP_SWEEP ' + json.dumps({'block': block, 'version': version, **data['summary']}), flush=True)
            report['gap_sweep_samples'] = diagnostics
            report['gap_diagnostic'] = summarize_gap_diagnostic(diagnostics)
        for workload in workloads:
            if workload == 'sustained':
                count = 2400 if dry_run else RETAINED_ROWS
                prefill_start = time.monotonic()
                # Distinct processes, pipes, files and DBs. No measured work
                # overlaps the other revision; only unmeasured seeding does.
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = {version: pool.submit(command, version, {'kind': 'prefill', 'count': count})
                               for version in ['candidate', 'r3']}
                    for version, future in futures.items():
                        seed = future.result()
                        fixture.assertEqual(seed['after'] - seed['before'], count)
                        print('EMR_LIVE_PREFILL ' + json.dumps({'version': version, **seed}), flush=True)
                report['prefill'] = {'parallel': True, 'per_revision': count,
                                     'elapsed_seconds': time.monotonic() - prefill_start}
                report['jit'] = command('candidate', {'kind': 'plans'})
                print('EMR_VERIFICATION_PLAN ' + json.dumps({k: v for k, v in report['jit'].items() if k != 'statements'}), flush=True)
            paired = {'candidate': [], 'r3': []}
            instrumented = {'candidate': [], 'r3': []}
            blocks, size, spacing = block_design(workload, mode, dry_run)
            started = time.monotonic()
            block_starts = []
            for block in range(blocks):
                # Quiet settling precedes the first actual measurement. Anchor
                # subsequent deadlines there, so a shorter later quiet window
                # cannot erode the required first-to-last start separation.
                origin = block_starts[0] if block_starts else started
                time.sleep(max(0, origin + block * spacing - time.monotonic()))
                if monitor:
                    monitor.wait_quiet()
                else:
                    time.sleep(SETTLE_SECONDS)
                block_starts.append(time.monotonic())
                block_samples = {'candidate': [], 'r3': []}
                for segment, (version, segment_size) in enumerate(block_segments(workload, block, size)):
                    if monitor:
                        monitor.require_valid()
                    if workload.startswith('concurrent-'):
                        request = {'kind': 'concurrent', 'count': segment_size}
                    elif workload == 'sustained':
                        request = {'kind': 'sustained', 'count': segment_size, 'rps': SUSTAINED_RPS}
                    else:
                        request = {'kind': 'single', 'count': segment_size, 'idle_ms': SINGLE_IDLE_MS}
                    data = command(version, request)
                    block_samples[version].extend(r['receipt_ms'] for r in data['results'])
                    instrumented[version].extend(data['results'])
                    print('EMR_LIVE_BLOCK ' + json.dumps({'workload': workload, 'block': block,
                        'segment': segment, 'version': version, **data['summary']}), flush=True)
                for version in paired:
                    fixture.assertEqual(len(block_samples[version]), size)
                    paired[version].append(block_samples[version])
            estimator = concurrent_result if workload.startswith('concurrent') else noninferiority
            result = estimator(paired['r3'], paired['candidate'])
            result['attribution'] = {version: sum(r['attributed_ms'] for r in rows) / sum(r['receipt_ms'] for r in rows)
                                     for version, rows in instrumented.items()}
            # Keep the verdict even when attribution is insufficient. An opaque
            # measurement cannot count as acceptance and is never silently retried.
            result['attribution_met'] = all(v >= MIN_ATTRIBUTION for v in result['attribution'].values())
            result['gate_passed'] = gate_result(result, mode)
            if mode == 'acceptance':
                result['gate_passed'] = result['gate_passed'] and result['attribution_met']
            result['noninferiority_met'] = result.pop('accepted')
            result['acceptance_preview'] = result['noninferiority_met'] and result['attribution_met']
            result['block_start_monotonic'] = block_starts
            result['block_start_span_seconds'] = block_starts[-1] - block_starts[0]
            report['samples'][workload] = paired
            report['results'][workload] = result
            if workload == 'single':
                # Within-process warm-up is gap-free; every measured request
                # after the first in a segment has an observed >=200 ms gap.
                medians = {}
                for version, rows in instrumented.items():
                    post = [r['receipt_ms'] for r in rows if r.get('segment_request', 0) > 0
                            and (r.get('idle_gap_ms') or 0) >= SINGLE_IDLE_MS - 1]
                    warm = [r['receipt_ms'] for r in report['cold_and_warmup'][version]['results'][1:]]
                    medians[version] = {'post_gap_ms': statistics.median(post) if post else None,
                                        'gap_free_warm_ms': statistics.median(warm)}
                report['post_gap'] = medians
                if all(v['post_gap_ms'] is not None for v in medians.values()):
                    report['post_gap']['warmup_based_offset_ms'] = (
                        medians['candidate']['post_gap_ms'] - medians['candidate']['gap_free_warm_ms']
                        - medians['r3']['post_gap_ms'] + medians['r3']['gap_free_warm_ms'])
                    report['post_gap']['limitation'] = 'four gap-free warm-up rows per revision are not a balanced idle-effect control; use the separate gap diagnostic'
            if workload == 'single' and (mode == 'acceptance' or dry_run):
                fixture.assertGreaterEqual(result['block_start_span_seconds'], MIN_SINGLE_SPAN_SECONDS)
                fixture.assertEqual(result['samples_per_revision'], SINGLE_BLOCKS * SINGLE_PER_BLOCK)
        stack.close()
        report['verdict'] = ('PASS' if mode == 'acceptance' else 'CI_PASS') if all(r['gate_passed'] for r in report['results'].values()) else 'FAIL'
        report['verdict_preview'] = 'PASS' if all(r['acceptance_preview'] for r in report['results'].values()) else 'FAIL'
        if gap_diagnostic:
            report.update(verdict='DIAGNOSTIC_ONLY', verdict_preview=None)
    except InvalidRun as error:
        report.update(verdict='INVALID', invalid_reason=str(error), verdict_attempts_consumed=0,
                      runner_attempt_consumed=mode == 'acceptance', verdict_preview='INVALID')
        for result in report['results'].values():
            result['gate_passed'] = None
        (out / 'invalid.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        raise
    finally:
        # Stop observers even after a benchmark failure without replacing that
        # exception or skipping resource cleanup with a second validity error.
        stack.__exit__(RuntimeError, RuntimeError('cleanup'), None)
        cls.image = candidate_image
        for process in sessions.values():
            try:
                process.stdin.write('{"kind":"close"}\n')
                process.stdin.flush()
                process.communicate(timeout=30)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                process.kill()
                process.communicate(timeout=10)
        for stream in files:
            stream.close()
        for version, db in report.get('diagnostic_databases', {}).items():
            logs = subprocess.run(['docker', 'logs', '--timestamps', db], capture_output=True, check=True)
            (out / (version + '-postgres.log')).write_bytes(logs.stdout + logs.stderr)
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('EMR_LIVE_ACCEPTANCE ' + json.dumps({k: v for k, v in report.items() if k not in ('samples', 'cold_and_warmup', 'jit')}), flush=True)
    for workload, result in report['results'].items():
        fixture.assertTrue(result['gate_passed'], 'D952 ' + mode + ' ' + workload + ': ' + json.dumps(result))
    return report


def summarize(directory):
    """Record every full statistics result; raw request streams stay alongside it."""
    import hashlib
    files = sorted(Path(directory).glob('comparison-*/summary.json'))
    if not files:
        raise ValueError('no live benchmark statistics were produced')
    reports = []
    for path in files:
        raw = path.read_bytes()
        value = json.loads(raw)
        reports.append({'file': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
                        'mode': value['mode'], 'verdict': value['verdict'],
                        'design': value['design'], 'results': value['results'],
                        'jit': value.get('jit'), 'raw_directory': value['raw_directory']})
    print(json.dumps({'decision': 'D952', 'reports': reports}, indent=2))


def summarize_gap_diagnostic(samples):
    """Paired block difference-in-differences; no warm-up rows enter the offset."""
    fields = ('receipt_ms', 'pool_wait_ms', 'admission_wait_ms', 'coordinator_ms',
              'append_callback_ms', 'confirm_ms', 'verification_sql_ms',
              'total_pool_wait_ms', 'total_coordinator_ms', 'total_fsync_ms',
              'total_commit_ms', 'transaction_sql_ms')
    result, effects = {}, []
    deltas = {}
    for version, blocks in samples.items():
        gaps = sorted({row['scheduled_gap_ms'] for block in blocks for row in block})
        groups = {gap: [row for block in blocks for row in block if row['scheduled_gap_ms'] == gap]
                  for gap in gaps}
        result[version] = {str(gap): {'count': len(rows), 'median': {
            key: statistics.median(row.get(key, 0) for row in rows) for key in fields},
            'mean': {key: statistics.mean(row.get(key, 0) for row in rows) for key in fields}}
            for gap, rows in groups.items()}
        deltas[version] = [statistics.median(row['receipt_ms'] for row in block if row['scheduled_gap_ms'] == SINGLE_IDLE_MS)
                           - statistics.median(row['receipt_ms'] for row in block if row['scheduled_gap_ms'] == 0)
                           for block in blocks]
    effects = [c-b for c, b in zip(deltas['candidate'], deltas['r3'])]
    point = statistics.mean(effects)
    half = T95[len(effects)-1] * statistics.stdev(effects) / len(effects)**.5
    return {'conditions': result, 'block_candidate_only_offsets_ms': effects,
            'post_gap_offset_ms': point, 'lower_95_one_sided_ms': point-half,
            'upper_95_one_sided_ms': point+half,
            'method': 'six paired block medians; (candidate 200ms-gap minus 0-gap) minus (r3 200ms-gap minus 0-gap); t bound',
            'scope': 'diagnostic only, excludes warm-up; original acceptance preview remains unchanged'}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--summarize', required=True)
    summarize(parser.parse_args().summarize)
