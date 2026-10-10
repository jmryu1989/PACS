"""D949: paired ABBA blocks, fresh durable volumes, explicit verdict mode.

Single: 30x40, 200 ms idle, first-to-last block starts >=600 seconds.
Concurrent: 24 bursts/size/revision, 2 s settle. Sustained: 12x200 at
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

from noninferiority import (noninferiority, gate_result, LATENCY_RATIO_LIMIT, CONCURRENT_RATIO_LIMIT,
                           SINGLE_BLOCKS, CONCURRENT_BLOCKS, SUSTAINED_BLOCKS, MIN_ATTRIBUTION)
from quiet_host import HostProbe, QuietMonitor, InvalidRun

WARMUP_REQUESTS = 5
SINGLE_PER_BLOCK = 40
SINGLE_IDLE_MS = 200
SETTLE_SECONDS = 2
MIN_SINGLE_SPAN_SECONDS = 600
SUSTAINED_RPS = 20
SUSTAINED_COUNT = 200
RETAINED_ROWS = 20000


def block_design(workload, mode):
    # Hosted CI samples are diagnostics for a gross-regression gate, never an
    # acceptance. Keep its fixed shorter design distinct in the raw report.
    if mode == 'ci-gross':
        return 6, {'single': 10, 'sustained': SUSTAINED_COUNT}.get(workload, int(workload.split('-')[-1]) if workload.startswith('concurrent-') else 10), 0
    count = SINGLE_BLOCKS if workload == 'single' else SUSTAINED_BLOCKS if workload == 'sustained' else CONCURRENT_BLOCKS
    size = SINGLE_PER_BLOCK if workload == 'single' else SUSTAINED_COUNT if workload == 'sustained' else int(workload.split('-')[-1])
    return count, size, MIN_SINGLE_SPAN_SECONDS / (SINGLE_BLOCKS - 1) if workload == 'single' else 0


def block_segments(workload, block, size):
    order = ['candidate', 'r3'] if block % 2 == 0 else ['r3', 'candidate']
    # Each single experimental block is a complete ABBA crossover: 20+20
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
    if mode == 'acceptance':
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            raise ValueError('hosted CI cannot run the NI acceptance verdict')
        preflight = json.loads(Path(os.environ['KIN_EMR_ACCEPTANCE_RECORD']).read_text(encoding='utf-8'))
        if preflight['verdict'] != 'QUIET' or preflight['unit'] != 'emr-b1-r7-jit':
            raise InvalidRun('missing commander pre-lease quiet-host record')
    cls = type(fixture)
    if 'baseline_image' not in cls.__dict__:
        fixture.baseline_appends(1)  # builds the pinned source; this cold observation is not accepted
    candidate_image = cls.image
    token = uuid.uuid4().hex[:8]
    root = Path(os.environ.get('KIN_EMR_LIVE_EVIDENCE', str(Path(__file__).resolve().parents[3] / 'tmp/emr-b1/live')))
    out = root / ('comparison-' + token)
    out.mkdir(parents=True, exist_ok=False)
    sessions, files = {}, []
    report = {'decision': 'D949', 'mode': mode, 'workloads': workloads, 'verdict': 'INCOMPLETE',
              'design': {w: block_design(w, mode) for w in workloads}, 'preflight': preflight,
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

        if mode == 'acceptance':
            monitor = QuietMonitor(HostProbe(preflight['probe']), out / 'host-during.jsonl',
                                   {preflight['probe_label'], fixture.label})
            monitor.preflight()  # Recheck after image/container setup, before measuring.
            stack.enter_context(monitor)
        for workload in workloads:
            if workload == 'sustained':
                for version in ['candidate', 'r3']:
                    seed = command(version, {'kind': 'prefill', 'count': RETAINED_ROWS})
                    fixture.assertEqual(seed['after'] - seed['before'], RETAINED_ROWS)
                    print('EMR_LIVE_PREFILL ' + json.dumps({'version': version, **seed}), flush=True)
                report['jit'] = command('candidate', {'kind': 'plans'})
                print('EMR_VERIFICATION_PLAN ' + json.dumps({k: v for k, v in report['jit'].items() if k != 'statements'}), flush=True)
            paired = {'candidate': [], 'r3': []}
            instrumented = {'candidate': [], 'r3': []}
            blocks, size, spacing = block_design(workload, mode)
            started = time.monotonic()
            block_starts = []
            for block in range(blocks):
                time.sleep(max(0, started + block * spacing - time.monotonic()))
                block_starts.append(time.monotonic())
                block_samples = {'candidate': [], 'r3': []}
                for segment, (version, segment_size) in enumerate(block_segments(workload, block, size)):
                    if monitor:
                        monitor.require_valid()
                        # Idle utilization must also be quiet; active samples alone
                        # cannot distinguish an overloaded host from our own work.
                        before = monitor.probe.counters()
                        time.sleep(SETTLE_SECONDS)
                        monitor.sample(before, False)
                    else:
                        time.sleep(SETTLE_SECONDS)
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
            ratio_limit = CONCURRENT_RATIO_LIMIT if workload.startswith('concurrent') else LATENCY_RATIO_LIMIT
            result = noninferiority(paired['r3'], paired['candidate'], ratio_limit)
            result['attribution'] = {version: sum(r['attributed_ms'] for r in rows) / sum(r['receipt_ms'] for r in rows)
                                     for version, rows in instrumented.items()}
            # Keep the verdict even when attribution is insufficient. An opaque
            # measurement cannot count as acceptance and is never silently retried.
            result['attribution_met'] = all(v >= MIN_ATTRIBUTION for v in result['attribution'].values())
            result['gate_passed'] = gate_result(result, mode)
            if mode == 'acceptance':
                result['gate_passed'] = result['gate_passed'] and result['attribution_met']
            result['noninferiority_met'] = result.pop('accepted')
            result['block_start_monotonic'] = block_starts
            result['block_start_span_seconds'] = block_starts[-1] - block_starts[0]
            report['samples'][workload] = paired
            report['results'][workload] = result
            if workload == 'single' and mode == 'acceptance':
                fixture.assertGreaterEqual(result['block_start_span_seconds'], MIN_SINGLE_SPAN_SECONDS)
                fixture.assertEqual(result['samples_per_revision'], SINGLE_BLOCKS * SINGLE_PER_BLOCK)
        stack.close()
        report['verdict'] = ('PASS' if mode == 'acceptance' else 'CI_PASS') if all(r['gate_passed'] for r in report['results'].values()) else 'FAIL'
    except InvalidRun as error:
        report.update(verdict='INVALID', invalid_reason=str(error), verdict_attempts_consumed=0,
                      runner_attempt_consumed=True)
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
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print('EMR_LIVE_ACCEPTANCE ' + json.dumps({k: v for k, v in report.items() if k not in ('samples', 'cold_and_warmup', 'jit')}), flush=True)
    for workload, result in report['results'].items():
        fixture.assertTrue(result['gate_passed'], 'D949 ' + mode + ' ' + workload + ': ' + json.dumps(result))
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
    print(json.dumps({'decision': 'D949', 'reports': reports}, indent=2))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--summarize', required=True)
    summarize(parser.parse_args().summarize)
