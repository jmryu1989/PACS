"""D941 fixed live protocol: fresh durable volumes, warmup, interleaved blocks.

Single = 6 blocks x 10 requests; sustained = 6 x 200 at 20 rps after 20k
product appends; concurrent = 6 independent bursts at each selected size.
No fixed-delay model result is consumed here.
"""
import json
import os
from pathlib import Path
import subprocess
import uuid

from noninferiority import (noninferiority, LATENCY_RATIO_LIMIT, CONCURRENT_RATIO_LIMIT,
                           MIN_SINGLE_SAMPLES, MIN_INTERLEAVED_BLOCKS, MIN_ATTRIBUTION)

WARMUP_REQUESTS = 5
SINGLE_PER_BLOCK = 10
SUSTAINED_RPS = 20
SUSTAINED_COUNT = 200
RETAINED_ROWS = 20000


def compare(fixture, workloads):
    cls = type(fixture)
    if 'baseline_image' not in cls.__dict__:
        fixture.baseline_appends(1)  # builds the pinned source; this cold observation is not accepted
    candidate_image = cls.image
    token = uuid.uuid4().hex[:8]
    root = Path(os.environ.get('KIN_EMR_LIVE_EVIDENCE', str(Path(__file__).resolve().parents[3] / 'tmp/emr-b1/live')))
    out = root / ('comparison-' + token)
    out.mkdir(parents=True, exist_ok=False)
    sessions, files = {}, []
    report = {'decision': 'D941', 'workloads': workloads, 'blocks': MIN_INTERLEAVED_BLOCKS,
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
            for block in range(MIN_INTERLEAVED_BLOCKS):
                # ABBA across consecutive pairs; both processes remain warm.
                order = ['candidate', 'r3'] if block % 2 == 0 else ['r3', 'candidate']
                for version in order:
                    if workload.startswith('concurrent-'):
                        request = {'kind': 'concurrent', 'count': int(workload.split('-')[1])}
                    elif workload == 'sustained':
                        request = {'kind': 'sustained', 'count': SUSTAINED_COUNT, 'rps': SUSTAINED_RPS}
                    else:
                        request = {'kind': 'single', 'count': SINGLE_PER_BLOCK}
                    data = command(version, request)
                    paired[version].append([r['receipt_ms'] for r in data['results']])
                    instrumented[version].extend(data['results'])
                    print('EMR_LIVE_BLOCK ' + json.dumps({'workload': workload, 'block': block, 'version': version, **data['summary']}), flush=True)
            ratio_limit = CONCURRENT_RATIO_LIMIT if workload.startswith('concurrent') else LATENCY_RATIO_LIMIT
            result = noninferiority(paired['r3'], paired['candidate'], ratio_limit)
            result['attribution'] = {version: sum(r['attributed_ms'] for r in rows) / sum(r['receipt_ms'] for r in rows)
                                     for version, rows in instrumented.items()}
            # Keep the verdict even when attribution is insufficient. An opaque
            # measurement cannot count as acceptance and is never silently retried.
            result['attribution_met'] = all(v >= MIN_ATTRIBUTION for v in result['attribution'].values())
            result['accepted'] = result['accepted'] and result['attribution_met']
            report['samples'][workload] = paired
            report['results'][workload] = result
            if workload == 'single':
                fixture.assertGreaterEqual(result['samples_per_revision'], MIN_SINGLE_SAMPLES)
    finally:
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
        fixture.assertTrue(result['accepted'], 'D941 ' + workload + ': ' + json.dumps(result))
    return report
