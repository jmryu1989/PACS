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

from performance import ROOT, GROSS_REGRESSION_RATIO, GROSS_DELTA_FLOOR_MS, build_report

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
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def require_number(value, field):
    if not _finite(value):
        raise ValueError(field + ' must be a finite real number')


def require_count(value, field):
    if type(value) is not int or value < 0:
        raise ValueError(field + ' must be a non-negative integer')


def validate_summary(summary):
    """Validate only the containers and statistics consumed by this driver."""
    if not isinstance(summary, dict):
        raise ValueError('summary must be an object')
    failures = summary.get('failures')
    if not isinstance(failures, list) or any(not isinstance(f, str) for f in failures):
        raise ValueError('summary failures must be a list of strings')
    if not isinstance(summary.get('cases'), dict):
        raise ValueError('summary cases must be an object')
    for key, row in summary['cases'].items():
        if not isinstance(row, dict):
            raise ValueError(key + ' must be an object')
        if key not in {k for keys in LATENCY_CASES.values() for k in keys}:
            continue
        for field in ('R', 'D', 'gate_ratio_limit', 'gate_delta_floor_ms'):
            require_number(row.get(field), key + '.' + field)
        require_count(row.get('failures'), key + '.failures')
        if type(row.get('gate_passed')) is not bool:
            raise ValueError(key + '.gate_passed must be a boolean')
        validate_consistency(key, row, failures)


def validate_consistency(key, row, failures):
    regression = row['R'] > GROSS_REGRESSION_RATIO and row['D'] > GROSS_DELTA_FLOOR_MS
    request_failed = row['failures'] > 0
    listed = [f for f in failures if f.startswith(key + ':')]
    # performance.py emits one assertion per failed condition. Check both
    # reasons, including when both fail, without depending on numeric formatting.
    requests = sum(f == key + ': request failed' for f in listed)
    regressions = sum(f.startswith(key + ': candidate p95 exceeds same-run r3 gross-regression bounds (')
                      for f in listed)
    if (row['gate_passed'] != (not (regression or request_failed))
            or requests != int(request_failed) or regressions != int(regression)
            or len(listed) != requests + regressions):
        raise ValueError(key + ': gate_passed or listed failures disagree with measured R/D/request failures')


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
    require_count(repetitions, 'repetitions')
    for row in receipt_rows:
        if not isinstance(row, dict):
            raise ValueError('receipt row must be an object')
        for field in ('label', 'version'):
            if not isinstance(row.get(field), str):
                raise ValueError('receipt ' + field + ' must be a string')
        for field in ('concurrency', 'prefill', 'failures', 'requests'):
            require_count(row.get(field), 'receipt ' + field)
        if row['version'] == 'r3':
            require_number(row.get('p95'), 'receipt p95')
        else:
            if not isinstance(row.get('request_instruments'), list):
                raise ValueError('request_instruments must be a list')
            for item in row['request_instruments']:
                if not isinstance(item, dict):
                    raise ValueError('request instrument must be an object')
                require_number(item.get('receipt_ms'), 'receipt_ms')
                if 'error' in item and not isinstance(item['error'], str):
                    raise ValueError('receipt error must be a string when present')
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
    summary = json.loads(path.read_text(encoding='utf-8'))
    validate_summary(summary)
    return summary


def validated_io_failures(case, summary, directory):
    """The summary omits IO counts. Reconcile it with the existing raw samples
    before using a prefix-read or journal assertion as evidence of a kill.
    Use the producer's predicates so this consumer cannot invent a new gate.
    """
    repetitions = summary.get('repetitions')
    require_count(repetitions, 'repetitions')
    if not repetitions:
        raise ValueError('IO measurement needs at least one repetition')
    ledger = case == 'ledger'
    sizes = (0, 20000, 100000) if ledger else (0, 10000, 150000)
    if ledger:
        raw = [json.loads(line) for line in (directory / 'receipt.jsonl').read_text(encoding='utf-8').splitlines()]
    else:
        raw = json.loads((directory / 'journal.json').read_text(encoding='utf-8'))
    if not isinstance(raw, list):
        raise ValueError(case + ': raw samples must be a list')
    rows = []
    for row in raw:
        if not isinstance(row, dict):
            raise ValueError(case + ': sample must be an object')
        if ledger:
            if not isinstance(row.get('label'), str):
                raise ValueError('receipt label must be a string')
            # A healthy report also contains sustained/concurrent samples.
            if not row['label'].startswith('ledger-'):
                continue
            require_count(row.get('concurrency'), 'concurrency')
            if row['concurrency'] != 1:
                raise ValueError('ledger sample must have concurrency 1')
            require_count(row.get('failures'), 'failures')
        size = row.get('prefill' if ledger else 'records')
        require_count(size, 'retained size')
        if size not in sizes or row.get('version') not in ('r3', 'r4d'):
            raise ValueError(case + ': unexpected sample group')
        require_count(row.get('read_rows' if ledger else 'read_bytes'), 'IO count')
        for field in ('p50', 'p95', 'p99'):
            require_number(row.get(field), field)
            if row[field] < 0 or (field == 'p95' and row[field] == 0):
                raise ValueError(case + ': invalid latency')
        rows.append(row)
    for size in sizes:
        for version in ('r3', 'r4d'):
            group = [row for row in rows if row['version'] == version
                     and row['prefill' if ledger else 'records'] == size]
            if len(group) != repetitions:
                raise ValueError(case + ': missing or duplicated sample blocks')
    configs = [('ledger', 1, size) for size in sizes] if ledger else []
    measured = build_report(rows if ledger else [], configs, [case], repetitions, {},
                            journal_rows=[] if ledger else rows)
    listed = [failure for failure in summary['failures'] if failure.startswith(case + '-')]
    if sorted(listed) != sorted(measured['failures']):
        raise ValueError(case + ': listed failures disagree with measured rows')
    if ledger:
        for key, expected in measured['cases'].items():
            row = summary['cases'].get(key)
            if not isinstance(row, dict):
                raise ValueError(key + ': missing case row')
            for field in ('R', 'D', 'gate_ratio_limit', 'gate_delta_floor_ms'):
                require_number(row.get(field), key + '.' + field)
            require_count(row.get('failures'), key + '.failures')
            if type(row.get('gate_passed')) is not bool:
                raise ValueError(key + ': gate_passed must be boolean')
            if any(row[field] != expected[field] for field in
                   ('R', 'D', 'gate_ratio_limit', 'gate_delta_floor_ms', 'failures', 'gate_passed')):
                raise ValueError(key + ': summary disagrees with measured rows')
    section = 'ledger_size' if ledger else 'journal'
    recorded = summary.get(section)
    if not isinstance(recorded, dict):
        raise ValueError(section + ': expected measured rows')
    for size in measured[section]:
        row = recorded.get(size)
        if not isinstance(row, dict):
            raise ValueError(section + ': missing size row')
        for field in ('permutation_p', 'ratio' if ledger else 'size_permutation_p'):
            require_number(row.get(field), section + '.' + field)
        if not ledger:
            for version in ('r3', 'r4d'):
                if not isinstance(row.get(version), dict):
                    raise ValueError('journal: missing revision statistics')
                for field in ('p50', 'p95', 'p99'):
                    require_number(row[version].get(field), 'journal.' + field)
    # These recorded size/latency rows are the complete inputs to the size-effect
    # predicates; equality also refuses missing rows and nonfinite statistics.
    if recorded != measured[section]:
        raise ValueError(section + ': summary disagrees with measured rows')
    return property_failures(case, measured['failures'])


def run_benchmark(cmd, log):
    def text(value):
        return value.decode('utf-8', 'replace') if isinstance(value, bytes) else (value or '')
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200,
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    except subprocess.TimeoutExpired as error:
        log.write_text(text(error.stdout) + text(error.stderr) + '\nHARNESS_ERROR timeout\n', encoding='utf-8')
        raise
    log.write_text(text(result.stdout) + text(result.stderr), encoding='utf-8')
    return result.returncode


def mutant_result(case, exit_code, summary, matching, validity=None, io_failures=None):
    """(killed, status). killed is True/False only for a completed, valid run."""
    if summary_shape_error(summary) or exit_code not in (0, 1):
        return None, 'harness_error'
    if case not in LATENCY_CASES:
        if io_failures is None:
            return None, 'harness_error'
        regression = bool(io_failures)
        if (regression != (exit_code == 1) or matching != io_failures
                or (case == 'ledger' and any(row['failures'] for key, row in summary['cases'].items()
                                            if key.startswith('ledger-')))):
            return None, 'harness_error'
        return regression, 'completed'
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


def error_cause(error):
    return type(error).__name__ + ': ' + str(error)[:500]


def evaluate_run(identity, evaluate):
    """Commit exactly one result after evaluation and cleanup have finished.

    SystemExit is an evaluation failure too (including code 0/None), while
    KeyboardInterrupt remains an operator interrupt. Never retain a provisional
    kill when a later step in this run raises.
    """
    try:
        row = {**identity, **evaluate()}
        print(json.dumps({k: v for k, v in row.items() if k != 'summary'}), flush=True)
        return row
    except (Exception, SystemExit) as error:
        return {**identity, 'killed': None, 'status': 'harness_error',
                'diagnosis': DIAGNOSIS['harness_error'], 'harness_cause': error_cause(error)}


def evaluate_control(path, chosen):
    control = load_summary(path)
    sources = control.get('candidate_sources')
    if sources is not None and not isinstance(sources, dict):
        raise ValueError('candidate_sources must be an object')
    if not sources:
        return {'killed': None, 'status': 'control_invalid'}
    for name, expected in sources.items():
        if not isinstance(expected, str):
            raise ValueError('candidate source hash must be a string')
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
            raise ValueError('healthy control source differs: ' + name)
    for case in {MUTANTS[name][0] for name in chosen} - LATENCY_CASES.keys():
        validated_io_failures(case, control, path.parent)
    statuses = [control_status(MUTANTS[name][0], control) for name in chosen]
    status = ('control_invalid' if 'control_invalid' in statuses else
              'control_failed' if 'control_failed' in statuses else 'completed')
    return {'killed': None, 'status': status, 'summary': control}


def evaluate_mutant(name, args, out, control):
    case, filename, before, after, behaviour = MUTANTS[name]
    if name == 'MP02' and MP02_DELAY_MS > MP02_MAX_DELAY_MS:
        return {'killed': None, 'status': 'no_valid_control',
                'delay_ms': MP02_DELAY_MS, 'max_delay_ms': MP02_MAX_DELAY_MS}
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
        cmd = [sys.executable, str(ROOT / 'tests/emr/b/performance.py'), '--out', str(run),
               '--candidate', str(candidate), '--cases', case]
        if args.image:
            cmd += ['--image', args.image]
        if args.flock_ms is not None:
            cmd += ['--flock-ms', str(args.flock_ms)]
        exit_code = run_benchmark(cmd, out / (name + '.log'))
        summary = load_summary(run / 'summary.json')
        matching = property_failures(case, summary['failures'])
        io_failures = validated_io_failures(case, summary, run) if case not in LATENCY_CASES else None
        validity = None
        if name == 'MP02':
            receipt = [json.loads(line) for line in (run / 'receipt.jsonl').read_text(encoding='utf-8').splitlines()]
            validity = delay_control_validity(receipt, summary.get('repetitions'))
        killed, status = mutant_result(case, exit_code, summary, matching, validity, io_failures)
        row = {'behaviour': behaviour, 'exit': exit_code, 'killed': killed, 'status': status,
               'matching_assertions': matching, 'other_control_failures': control['failures'],
               'source': str(file.relative_to(candidate)),
               'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
               'mutant_sha256': hashlib.sha256(mutated.encode()).hexdigest(), 'failures': summary['failures']}
        if validity is not None:
            row['control_validity'] = validity
        if killed is None:
            row['diagnosis'] = DIAGNOSIS[status]
    return row


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--control', type=Path, required=True, help='same-source healthy performance summary')
    parser.add_argument('--image')
    parser.add_argument('--flock-ms', type=float)
    parser.add_argument('--only')
    args = parser.parse_args(argv)
    chosen = list(MUTANTS) if args.only is None else args.only.split(',')
    selection_error = not chosen or any(name not in MUTANTS for name in chosen)
    if selection_error:
        chosen = []
    out = args.out.resolve()
    rows = []
    healthy = None
    try:
        out.mkdir(parents=True, exist_ok=False)
        if not selection_error:
            healthy = evaluate_run({'id': 'healthy'}, lambda: evaluate_control(args.control, chosen))
            for name in dict.fromkeys(chosen):
                identity = {'id': name, 'property': MUTANTS[name][0]}
                if healthy['status'] != 'completed':
                    row = {**identity, 'killed': None, 'status': healthy['status'],
                           'diagnosis': DIAGNOSIS[healthy['status']]}
                    if 'harness_cause' in healthy:
                        row['harness_cause'] = healthy['harness_cause']
                else:
                    row = evaluate_run(identity, lambda: evaluate_mutant(name, args, out, healthy['summary']))
                rows.append(row)
        summary = {'total': len(rows), 'killed': sum(r['killed'] is True for r in rows),
                   'survived': [r['id'] for r in rows if r['killed'] is False],
                   'not_run': [r['id'] for r in rows if r['killed'] is None],
                   'invalid': {r['id']: r['status'] for r in rows if r['killed'] is None}, 'results': rows,
                   'control': {k: v for k, v in healthy.items() if k != 'summary'} if healthy else None,
                   'selection_error': selection_error}
        (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8', newline='\n')
        if selection_error:
            print('INVALID_SELECTION: --only requires known, non-empty mutant IDs; zero verdicts', file=sys.stderr)
        for r in rows:
            if r['killed'] is None:
                print(f"INVALID_CONTROL {r['id']}: {r['status']}: {r.get('harness_cause') or r.get('diagnosis')}",
                      file=sys.stderr, flush=True)
        return int(selection_error or bool(summary['survived'] or summary['not_run']))
    except (Exception, SystemExit) as error:
        # Publication can fail. Report best effort, without promising an artifact.
        try:
            print('HARNESS_ERROR output/publication: ' + error_cause(error), file=sys.stderr, flush=True)
        except (Exception, SystemExit):
            pass
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
