"""D878 negative controls: one executable regression for each performance property.

Every mutant runs the same relative A/B or measured IO complexity assertion as its
healthy control. A build/import failure is a harness error, never a kill.

D1550: a latency mutant (sustained/concurrent) is killed only by its own measured
gross regression: every required case statistic present and finite, zero request
failures on both revisions, and the unchanged D1006 R/D bounds exceeded. A request
failure, a missing statistic or a harness error is no verdict (killed=None): never
a kill and never a survival, and the driver exits non-zero.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from performance import ROOT, GROSS_REGRESSION_RATIO, GROSS_DELTA_FLOOR_MS

# MP02 receipt-delay control (D1550). The delay must break the gate's real
# condition (R > 1.25 AND paired median D > 5 ms) by construction, not by luck:
# with every same-run baseline block p95 <= B and every mutant receipt >= L,
# R >= L/B > 1.25 and every paired difference >= L - B > 5 ms.
# B is a stated prior upper bound for the hosted sustained-20-20000 r3 block p95.
# Hosted Linux evidence before this choice (18 ten-block r3 samples kept from nine
# emr-b runs, healthy + MP02 steps): most block maxima 5.9..8 ms, later runs 242..476
# ms, the largest 1348.2 ms (PR #181 MP02 step, blocks 84..1348.2). B = 2000 ms
# leaves ~1.5x headroom over that maximum; a later baseline above it makes the
# control INVALID (reported, never a kill or a pass), not a silent retry.
MP02_BASELINE_P95_BOUND_MS = 2000.0
MP02_DELAY_MS = max(50, math.ceil(1.5 * MP02_BASELINE_P95_BOUND_MS + 10))
# Each sample process awaits its five sequential warm-up receipts and its last
# open-loop receipt (>= 6 L beyond the 6 s run) inside performance.py's 240 s
# per-process limit, and four mutants share the step's 30-minute limit. A larger
# L is reported as "no valid control" instead of being run.
MP02_MAX_DELAY_MS = 30000
MP02_CASE = ('sustained', 20, 20000)

# acknowledge() is the last wait of every successful receipt, including a
# receipt that joined a running drain or took the sealed-receipt fast path; a
# delay right before `return receipt` therefore reaches every receipt. The delay
# lives only in the mutant copy; product source is unchanged.
_CONFIRM_END = ("    await Promise.all(appended.entries.map(p => this.seal.acknowledge(p.stream, p.attemptId)));\n"
                "    return receipt;")

MUTANTS = {
    "MP01": ("ledger", "seal.ts", "    const current = state.tail.streams[stream];\n    if (tail.chainId",
             "    full = true;\n    const current = state.tail.streams[stream];\n    if (tail.chainId", "single receipt rereads the retained prefix"),
    "MP02": ("sustained", "store.ts", _CONFIRM_END,
             _CONFIRM_END.replace("    return receipt;",
                                  f"    await new Promise(resolve => setTimeout(resolve, {MP02_DELAY_MS}));\n    return receipt;"),
             f"every durable receipt waits {MP02_DELAY_MS} ms before it is returned"),
    "MP03": ("concurrent", "external-writer.ts", "  const { directory, operation, value } = request, context = request.context ?? {};",
             "  const { directory, operation, value } = request, context = request.context ?? {};\n"
             "  if (operation === 'reserve') require('node:child_process').spawnSync(process.execPath, ['-e', '']);",
             "per-reservation process startup serializes concurrent receipts"),
    "MP04": ("journal", "external-writer.ts", "    const journal = context.journal ??= new JournalFile(directory);",
             "    const journal = new JournalFile(directory);", "each append rereads the full failure journal"),
}

# The case statistics a latency verdict needs; every one of them must be valid.
LATENCY_CASES = {'sustained': ('sustained-20-20000',), 'concurrent': ('concurrent-24-0', 'concurrent-48-0')}

DIAGNOSIS = {
    'control_failed': 'the healthy candidate failed this property (regression or request failure); no mutant verdict',
    'control_invalid': 'the healthy control has no valid statistics for this property; no mutant verdict',
    'invalid_measurement': 'mutant measurement incomplete or had request failures; no mutant verdict',
    'invalid_control': 'the control design did not hold in this run (bound or delay condition failed); no mutant verdict',
    'no_valid_control': 'no valid control: the required delay exceeds the time budget',
    'harness_error': 'harness error; no mutant verdict',
}


def property_failures(case, failures):
    """The negative control must kill its own assertion, never an existing
    regression in another property. MP01 checks IO complexity; its latency
    goals remain reported by the complete healthy A/B run."""
    if case == 'ledger':
        return [f for f in failures if 'single receipt reads retained prefix' in f]
    # MP02/MP03 corrupt receipt latency, so both their healthy control and kill
    # must use the same request/budget assertions. Insufficient paired evidence
    # (case + ':') remains a delivery failure in performance.py and is retained
    # as other_control_failures; it cannot itself kill a latency mutant.
    return [f for f in failures if f.startswith(case + '-')]


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_latency_row(row):
    """A case statistic usable for a latency verdict: finite R/D under the
    unchanged D1006 bounds and zero request failures on both revisions."""
    return (isinstance(row, dict) and type(row.get('failures')) is int and row['failures'] == 0
            and _finite(row.get('R')) and _finite(row.get('D')) and row['R'] > 0
            and row.get('gate_ratio_limit') == GROSS_REGRESSION_RATIO
            and row.get('gate_delta_floor_ms') == GROSS_DELTA_FLOOR_MS)


def control_status(case, control):
    """None when the same-source healthy control is a valid basis for this
    property's mutant; otherwise the no-verdict status."""
    if property_failures(case, control.get('failures') or []):
        return 'control_failed'
    if case in LATENCY_CASES:
        rows = [control.get('cases', {}).get(key) for key in LATENCY_CASES[case]]
        if not all(valid_latency_row(row) and row.get('gate_passed') is True for row in rows):
            return 'control_invalid'
    return None


def delay_control_validity(receipt_rows, repetitions, bound_ms=MP02_BASELINE_P95_BOUND_MS, delay_ms=MP02_DELAY_MS,
                           case=MP02_CASE):
    """Check the MP02 guarantee from the raw sample rows of the same run: every
    baseline block p95 <= B, every mutant receipt >= L, zero request failures."""
    name, count, retained = case
    selected = [r for r in receipt_rows if isinstance(r, dict) and str(r.get('label', '')).startswith(name + '-')
                and r.get('concurrency') == count and r.get('prefill') == retained]
    baseline = [r for r in selected if r.get('version') == 'r3']
    mutant = [r for r in selected if r.get('version') == 'r4d']
    reasons = []
    if len(baseline) != repetitions or len(mutant) != repetitions:
        reasons.append(f'expected {repetitions} blocks per revision, got r3={len(baseline)} r4d={len(mutant)}')
    for r in selected:
        if type(r.get('failures')) is not int or r['failures'] != 0:
            reasons.append(f"{r.get('label')}: request failures {r.get('failures')!r}")
    baseline_p95 = []
    for r in baseline:
        if not _finite(r.get('p95')) or r['p95'] <= 0:
            reasons.append(f"{r.get('label')}: baseline block p95 missing or not finite")
            continue
        baseline_p95.append(r['p95'])
        if r['p95'] > bound_ms:
            reasons.append(f"{r.get('label')}: baseline block p95 {r['p95']} ms exceeds B={bound_ms} ms")
    receipts = []
    for r in mutant:
        instruments = r.get('request_instruments')
        if (not isinstance(instruments, list) or not instruments or type(r.get('requests')) is not int
                or len(instruments) != r['requests']):
            reasons.append(f"{r.get('label')}: per-receipt instruments missing or incomplete")
            continue
        for item in instruments:
            value = item.get('receipt_ms') if isinstance(item, dict) else None
            if not _finite(value) or (isinstance(item, dict) and item.get('error')):
                reasons.append(f"{r.get('label')}: a receipt has no finite time or failed")
                break
            receipts.append(value)
        short = [v for v in (item.get('receipt_ms') for item in instruments if isinstance(item, dict))
                 if _finite(v) and v < delay_ms]
        if short:
            reasons.append(f"{r.get('label')}: {len(short)} receipts below L={delay_ms} ms (min {min(short)} ms)")
    return {'valid': not reasons, 'reasons': reasons, 'bound_ms': bound_ms, 'delay_ms': delay_ms,
            'baseline_blocks': len(baseline), 'mutant_blocks': len(mutant),
            'baseline_block_p95_max_ms': max(baseline_p95) if baseline_p95 else None,
            'mutant_receipts': len(receipts), 'mutant_receipt_min_ms': min(receipts) if receipts else None}


def summary_shape_error(summary):
    """None when performance.py's summary has the containers a verdict reads:
    a mapping with a failures list and, when present, a cases mapping."""
    if not isinstance(summary, dict):
        return 'summary is not a JSON object' if summary is not None else 'no summary'
    if not isinstance(summary.get('failures'), list):
        return 'summary failures is not a list'
    if not isinstance(summary.get('cases', {}), dict):
        return 'summary cases is not a JSON object'
    return None


def load_summary(path):
    """(summary or None, cause or None) from the benchmark's summary.json."""
    try:
        summary = json.loads(path.read_text())
    except FileNotFoundError:
        return None, 'summary.json missing'
    except (OSError, ValueError) as error:
        return None, f'summary.json unreadable: {type(error).__name__}: {error}'
    cause = summary_shape_error(summary)
    return (None, cause) if cause else (summary, None)


def run_benchmark(cmd, log):
    """Exit code of the benchmark, or None when it could not run to completion;
    the log keeps any partial output and the cause."""
    def text(value):
        return value.decode('utf-8', 'replace') if isinstance(value, bytes) else (value or '')
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200, env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    except subprocess.TimeoutExpired as error:
        log.write_text(text(error.stdout) + text(error.stderr) + f'\nHARNESS_ERROR timeout after {error.timeout} s\n', encoding='utf-8')
        return None, f'benchmark timed out after {error.timeout} s'
    except OSError as error:
        log.write_text(f'HARNESS_ERROR launch failed: {type(error).__name__}: {error}\n', encoding='utf-8')
        return None, f'benchmark launch failed: {type(error).__name__}: {error}'
    log.write_text(text(result.stdout) + text(result.stderr), encoding='utf-8')
    return result.returncode, None


def mutant_result(case, exit_code, summary, matching, validity=None):
    """(killed, status). killed is True/False only for a completed, valid run."""
    if summary_shape_error(summary) or exit_code not in (0, 1):
        return None, 'harness_error'
    if case not in LATENCY_CASES:
        return exit_code == 1 and bool(matching), 'completed'
    rows = [summary.get('cases', {}).get(key) for key in LATENCY_CASES[case]]
    if not all(valid_latency_row(row) for row in rows):
        return None, 'invalid_measurement'
    if validity is not None and not validity.get('valid'):
        return None, 'invalid_control'
    regression = any(row['R'] > GROSS_REGRESSION_RATIO and row['D'] > GROSS_DELTA_FLOOR_MS for row in rows)
    # With zero request failures the only failures of a latency-only run are its
    # bounds, so the exit status and the measured bounds must agree.
    if regression != (exit_code == 1) or regression != bool(matching):
        return None, 'harness_error'
    return regression, 'completed'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--control', type=Path, required=True, help='same-source healthy performance summary')
    parser.add_argument('--image')
    parser.add_argument('--flock-ms', type=float)
    parser.add_argument('--only')
    args = parser.parse_args(argv)
    control = json.loads(args.control.read_text())
    for name, expected in control['candidate_sources'].items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise RuntimeError('healthy control source differs: ' + name)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    rows = []
    for name, (case, filename, before, after, behaviour) in MUTANTS.items():
        if args.only and name not in args.only.split(','):
            continue
        unhealthy = control_status(case, control)
        if unhealthy:
            rows.append({'id': name, 'property': case, 'killed': None, 'status': unhealthy,
                         'diagnosis': DIAGNOSIS[unhealthy],
                         'control_failures': property_failures(case, control.get('failures') or []),
                         'reason': 'No valid mutant verdict: its healthy property control is not valid.'})
            print(json.dumps(rows[-1]), flush=True)
            continue
        if name == 'MP02' and MP02_DELAY_MS > MP02_MAX_DELAY_MS:
            rows.append({'id': name, 'property': case, 'killed': None, 'status': 'no_valid_control',
                         'diagnosis': DIAGNOSIS['no_valid_control'], 'delay_ms': MP02_DELAY_MS,
                         'max_delay_ms': MP02_MAX_DELAY_MS})
            print(json.dumps(rows[-1]), flush=True)
            continue
        with tempfile.TemporaryDirectory(prefix='emr-perf-mutant-') as folder:
            candidate = Path(folder)
            shutil.copytree(ROOT / 'api/src', candidate / 'api/src')
            shutil.copyfile(ROOT / 'api/tsconfig.json', candidate / 'api/tsconfig.json')
            file = candidate / 'api/src/emr-runtime' / filename
            original = file.read_text(encoding='utf-8')
            if original.count(before) != 1:
                raise RuntimeError(name + ': mutation location is ambiguous')
            mutated = original.replace(before, after)
            file.write_text(mutated, encoding='utf-8', newline='\n')
            run = out / name
            cmd = [sys.executable, str(ROOT / 'tests/emr/b/performance.py'), '--out', str(run), '--candidate', str(candidate), '--cases', case]
            if args.image:
                cmd += ['--image', args.image]
            if args.flock_ms is not None:
                cmd += ['--flock-ms', str(args.flock_ms)]
            exit_code, harness_cause = run_benchmark(cmd, out / (name + '.log'))
            summary = None
            if harness_cause is None:
                summary, harness_cause = load_summary(run / 'summary.json')
            matching = property_failures(case, summary['failures']) if summary else []
            validity = None
            if name == 'MP02' and summary is not None:
                try:
                    receipt = [json.loads(line) for line in (run / 'receipt.jsonl').read_text().splitlines()]
                except (OSError, ValueError) as error:
                    receipt, validity = [], {'valid': False, 'reasons': ['receipt.jsonl unreadable: ' + type(error).__name__]}
                if validity is None:
                    repetitions = summary.get('repetitions')
                    validity = delay_control_validity(receipt, repetitions if type(repetitions) is int else -1)
            killed, status = mutant_result(case, exit_code, summary, matching, validity)
            rows.append({'id': name, 'property': case, 'behaviour': behaviour, 'exit': exit_code, 'killed': killed,
                         'status': status, 'matching_assertions': matching,
                         'other_control_failures': control['failures'],
                         'source': str(file.relative_to(candidate)), 'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
                         'mutant_sha256': hashlib.sha256(mutated.encode()).hexdigest(),
                         'failures': summary and summary.get('failures')})
            if validity is not None:
                rows[-1]['control_validity'] = validity
            if harness_cause is not None:
                rows[-1]['harness_cause'] = harness_cause
            if killed is None:
                rows[-1]['diagnosis'] = DIAGNOSIS[status]
            print(json.dumps(rows[-1]), flush=True)
    summary = {'total': len(rows), 'killed': sum(r['killed'] is True for r in rows),
               'survived': [r['id'] for r in rows if r['killed'] is False],
               'not_run': [r['id'] for r in rows if r['killed'] is None],
               'invalid': {r['id']: r['status'] for r in rows if r['killed'] is None}, 'results': rows}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    for r in rows:
        if r['killed'] is None:
            print(f"INVALID_CONTROL {r['id']}: {r['status']}: {r.get('harness_cause') or r.get('diagnosis')}", file=sys.stderr, flush=True)
    return bool(summary['survived'] or summary['not_run'])


if __name__ == '__main__':
    raise SystemExit(main())
