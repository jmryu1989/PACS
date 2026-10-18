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
import uuid

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


class EvidenceError(ValueError):
    """Malformed or internally contradictory benchmark evidence."""


def number(value, field):
    if type(value) not in (int, float):
        raise EvidenceError(field + ': finite JSON number required')
    try:
        result = float(value)
    except (OverflowError, ValueError) as error:
        raise EvidenceError(field + ': number is not representable') from error
    if not math.isfinite(result):
        raise EvidenceError(field + ': finite JSON number required')
    return result


def count(value, field, positive=False):
    # Counts must remain exact across JSON consumers; do not coerce bool/float.
    if type(value) is not int or not (int(positive) <= value <= 9007199254740991):
        raise EvidenceError(field + ': exact bounded integer required')
    return value


def mapping(value, field):
    if type(value) is not dict:
        raise EvidenceError(field + ': object required')
    return value


def strings(value, field):
    if type(value) is not list or any(type(item) is not str for item in value):
        raise EvidenceError(field + ': list of strings required')
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError('duplicate JSON member: ' + key[:100])
        result[key] = value
    return result


def strict_json(raw):
    def constant(value):
        raise EvidenceError('nonfinite JSON token: ' + value)
    return json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=unique_object,
                      parse_constant=constant)


def load_summary(path):
    return strict_json(path.read_bytes())


def validate_summary(summary, cases, exit_code=None):
    """Validate every consumed row before returning any domain judgment.

    Missing measurements remain a domain outcome. Missing containers, malformed
    members and contradictory flags/diagnostics are failures of the harness.
    """
    mapping(summary, 'summary')
    failures = strings(summary.get('failures'), 'failures')
    rows = mapping(summary.get('cases'), 'cases')
    count(summary.get('repetitions'), 'repetitions', positive=True)
    if exit_code is not None:
        if type(exit_code) is not int or exit_code not in (0, 1):
            raise EvidenceError('benchmark exit is not 0 or 1')
        if exit_code != int(bool(failures)):
            raise EvidenceError('benchmark exit disagrees with diagnostics')
    unusable = set()
    for case in cases:
        for key in LATENCY_CASES.get(case, ()):
            if key not in rows:
                unusable.add(case)
                continue
            row = mapping(rows[key], key)
            count(row.get('failures'), key + '.failures')
            if type(row.get('gate_passed')) is not bool:
                raise EvidenceError(key + ': gate_passed must be boolean')
            ratio_limit = number(row.get('gate_ratio_limit'), key + '.gate_ratio_limit')
            delta_limit = number(row.get('gate_delta_floor_ms'), key + '.gate_delta_floor_ms')
            # Validate the remaining present number even if its partner is absent.
            for field in ('R', 'D'):
                if field in row:
                    number(row[field], key + '.' + field)
            if 'R' not in row or 'D' not in row:
                unusable.add(case)
                continue
            ratio, delta = number(row['R'], key + '.R'), number(row['D'], key + '.D')
            if ratio <= 0 or ratio_limit != GROSS_REGRESSION_RATIO or delta_limit != GROSS_DELTA_FLOOR_MS:
                unusable.add(case)
                continue
            regression = ratio > GROSS_REGRESSION_RATIO and delta > GROSS_DELTA_FLOOR_MS
            diagnostics = [f for f in failures if f.startswith(key + ':')]
            request_diagnostic = any(f.startswith(key + ': request failed') for f in diagnostics)
            latency_diagnostic = any(f.startswith(key + ': candidate p95 exceeds same-run r3 gross-regression bounds')
                                     for f in diagnostics)
            if (request_diagnostic != bool(row['failures']) or latency_diagnostic != regression
                    or row['gate_passed'] != (not regression and row['failures'] == 0)
                    or bool(diagnostics) != (regression or row['failures'] > 0)):
                raise EvidenceError(key + ': measured predicate, requests, gate and diagnostics disagree')
    return unusable


def source_hashes(root):
    files = [root / 'api/tsconfig.json']
    # os.walk's onerror propagates unreadable directories instead of silently
    # accepting a partial provenance set.
    def failed(error):
        raise error
    for directory, dirs, names in os.walk(root / 'api/src', onerror=failed):
        if any((Path(directory) / name).is_symlink() for name in dirs + names):
            raise EvidenceError('source symlinks are not a complete input snapshot')
        files.extend(Path(directory) / name for name in names)
    if len(files) == 1:
        raise EvidenceError('source input set is empty')
    return {file.relative_to(root).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted(files)}


def validate_sources(summary, expected):
    actual = mapping(summary.get('candidate_sources'), 'candidate_sources')
    if not expected or actual.keys() != expected.keys():
        raise EvidenceError('candidate_sources does not cover the complete expected input set')
    for name, digest in actual.items():
        if type(digest) is not str or len(digest) != 64 or digest != expected[name]:
            raise EvidenceError('source digest differs: ' + name)


def valid_latency_row(row):
    return (row['failures'] == 0 and row['R'] > 0
            and row['gate_ratio_limit'] == GROSS_REGRESSION_RATIO
            and row['gate_delta_floor_ms'] == GROSS_DELTA_FLOOR_MS)


def control_status(case, control):
    if case in validate_summary(control, [case]):
        return 'control_invalid'
    if property_failures(case, control['failures']):
        return 'control_failed'
    return None


def delay_control_validity(receipt_rows, repetitions, bound_ms=MP02_BASELINE_P95_BOUND_MS,
                           delay_ms=MP02_DELAY_MS, case=MP02_CASE):
    """Check all raw blocks, identities and receipts, without filtering bad rows."""
    count(repetitions, 'repetitions', positive=True)
    if type(receipt_rows) is not list:
        raise EvidenceError('receipt rows must be a list')
    name, concurrency, prefill = case
    baseline, mutant, receipts, reasons, identities = [], [], [], [], []
    for index, value in enumerate(receipt_rows):
        row = mapping(value, 'receipt row')
        for field in ('label', 'version'):
            if type(row.get(field)) is not str:
                raise EvidenceError('receipt.' + field + ': string required')
        for field in ('concurrency', 'prefill', 'failures', 'requests'):
            count(row.get(field), 'receipt.' + field)
        if row['version'] not in ('r3', 'r4d') or row['concurrency'] != concurrency or row['prefill'] != prefill:
            reasons.append('wrong receipt revision/workload at row ' + str(index))
        identities.append((row['label'], row['version']))
        if row['failures']:
            reasons.append('receipt block has request failures')
        if row['version'] == 'r3':
            value = number(row.get('p95'), 'receipt.p95')
            baseline.append(value)
            if value <= 0 or value > bound_ms:
                reasons.append('baseline block p95 is outside B')
        elif row['version'] == 'r4d':
            mutant.append(row)
            instruments = row.get('request_instruments')
            if type(instruments) is not list:
                raise EvidenceError('request_instruments: list required')
            if not instruments or len(instruments) != row['requests']:
                reasons.append('per-receipt coverage is incomplete')
            for item in instruments:
                mapping(item, 'instrument')
                value = number(item.get('receipt_ms'), 'receipt_ms')
                if 'error' in item and type(item['error']) is not str:
                    raise EvidenceError('instrument.error: string required')
                if item.get('error', ''):
                    reasons.append('receipt has a producer error')
                receipts.append(value)
                if value < delay_ms:
                    reasons.append('receipt is below L')
    # The driver always launches the unchanged ten-pair profile. Do not let an
    # external count control allocation or manufacture a shorter valid control.
    if repetitions != 10:
        reasons.append('receipt repetitions differ from the ten-pair profile')
    expected = {(f'{name}-{rep}-{version}', version) for rep in range(10) for version in ('r3', 'r4d')}
    if len(identities) != len(expected) or set(identities) != expected:
        reasons.append('missing, extra or duplicated block identity')
    return {'valid': not reasons, 'reasons': reasons, 'bound_ms': bound_ms, 'delay_ms': delay_ms,
            'baseline_blocks': len(baseline), 'mutant_blocks': len(mutant),
            'baseline_block_p95_max_ms': max(baseline) if baseline else None,
            'mutant_receipts': len(receipts), 'mutant_receipt_min_ms': min(receipts) if receipts else None}


def mutant_result(case, exit_code, summary, matching, validity=None):
    try:
        unusable = validate_summary(summary, [case], exit_code)
    except EvidenceError:
        return None, 'harness_error'
    if case not in LATENCY_CASES:
        return bool(matching), 'completed'
    if case in unusable or not all(valid_latency_row(summary['cases'][key]) for key in LATENCY_CASES[case]):
        return None, 'invalid_measurement'
    if validity is not None and not validity['valid']:
        return None, 'invalid_control'
    regression = any(summary['cases'][key]['R'] > GROSS_REGRESSION_RATIO
                     and summary['cases'][key]['D'] > GROSS_DELTA_FLOOR_MS for key in LATENCY_CASES[case])
    return regression, 'completed'


def error_record(error, phase):
    # Establish primitive evidence before invoking exception-owned formatting.
    record = {'phase': phase, 'type': 'BaseException', 'message': 'message unavailable'}
    try:
        record['type'] = type(error).__name__[:100]
        record['message'] = str(error)[:2000].encode('ascii', 'backslashreplace').decode('ascii')
    except BaseException as secondary:
        record['formatting_error'] = type(secondary).__name__[:100]
    return record


def no_verdict(name, status='harness_error'):
    return {'id': name, 'property': MUTANTS[name][0] if name in MUTANTS else None,
            'killed': None, 'status': status, 'diagnosis': DIAGNOSIS[status]}


class Evaluation:
    """One local transaction: errors replace, never append, a tentative verdict."""
    def __init__(self, name):
        self.name, self.phase, self.errors = name, 'setup', []

    def failed(self, error):
        self.errors.append(error_record(error, self.phase))

    def result(self):
        row = no_verdict(self.name)
        row['errors'] = self.errors[:16]
        row['harness_cause'] = '; '.join(e['type'] + ': ' + e['message'] for e in self.errors[:16])
        row['phase'] = self.errors[0]['phase'] if self.errors else self.phase
        return row


def evaluate(transaction, operation, cleanup=lambda: None):
    tentative = None
    cancellation = None
    try:
        tentative = operation(transaction)
    except BaseException as error:
        transaction.failed(error)
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            cancellation = error
    try:
        transaction.phase = 'cleanup'
        cleanup()
    except BaseException as error:
        transaction.failed(error)
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            cancellation = error
    if cancellation is not None:
        raise cancellation
    return transaction.result() if transaction.errors else tentative


def log_text(value):
    if value is None:
        return ''
    if type(value) is bytes:
        return value[:1048576].decode('utf-8', 'replace')
    if type(value) is str:
        return value[:1048576].encode('utf-8', 'backslashreplace').decode('utf-8')
    raise EvidenceError('subprocess output must be bytes, text or absent')


def run_benchmark(cmd, log, transaction):
    transaction.phase = 'launch'
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=1200,
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
    except BaseException as error:
        transaction.failed(error)
        try:
            transaction.phase = 'log'
            partial = log_text(error.stdout) + log_text(error.stderr) if isinstance(error, subprocess.TimeoutExpired) else ''
            log.write_text(partial + '\nHARNESS_ERROR timeout/launch: ' + transaction.errors[0]['message'], encoding='utf-8')
        except BaseException as secondary:
            transaction.failed(secondary)
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        return None
    transaction.phase = 'log'
    log.write_text(log_text(result.stdout) + log_text(result.stderr), encoding='utf-8')
    return result.returncode


def aggregate(selected, rows, identity, control):
    if not selected or len(selected) != len(set(selected)) or set(rows) != set(selected):
        raise EvidenceError('incomplete or duplicate selected results')
    results = [rows[name] for name in selected]
    if [r['id'] for r in results] != selected:
        raise EvidenceError('canonical result identity mismatch')
    invalid = {r['id']: r['status'] for r in results if r['killed'] is None}
    return {**identity, 'terminal': True, 'status': 'INVALID_CONTROL' if invalid else 'completed',
            'selected': selected, 'total': len(results), 'killed': sum(r['killed'] is True for r in results),
            'survived': [r['id'] for r in results if r['killed'] is False],
            'not_run': list(invalid), 'invalid': invalid, 'results': results, 'control': control}


def publish(out, payload, run_id):
    # A partial write can only damage this run's temporary file, never the last
    # terminal record. Even a successful replace is insufficient without exit 0.
    temporary = out / ('.summary-' + run_id + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, out / 'summary.json')


def encode_summary(summary):
    return (json.dumps(summary, ensure_ascii=True, allow_nan=False, indent=2) + '\n').encode('ascii')


def finalize(out, selected, rows, identity, control):
    errors = []
    try:
        summary = aggregate(selected, rows, identity, control)
        for row in summary['results']:
            if row['killed'] is None:
                print('INVALID_CONTROL ' + row['id'] + ': ' + row['status'], file=sys.stderr, flush=True)
        # Output is diagnostic until the terminal aggregate is published.
        print(json.dumps({'run_id': identity['run_id'], 'status': summary['status']}), flush=True)
        payload = encode_summary(summary)
        publish(out, payload, identity['run_id'])
        return int(bool(summary['survived'] or summary['not_run']))
    except BaseException as error:
        errors.append(error_record(error, 'publication'))
    # One independently guarded fallback, with no judgment or risky raw input.
    # Prior computed outcomes are not authoritative after finalizer failure.
    fallback_rows = []
    for name in selected:
        row = no_verdict(name)
        row['errors'] = rows.get(name, {}).get('errors', []) + errors
        row['harness_cause'] = '; '.join(e['type'] + ': ' + e['message'] for e in row['errors'])
        row['phase'] = 'publication'
        fallback_rows.append(row)
    fallback = {**identity, 'terminal': True, 'status': 'INVALID_CONTROL', 'selected': selected,
                'total': len(selected), 'killed': 0, 'survived': [], 'not_run': selected,
                'invalid': {name: 'harness_error' for name in selected}, 'results': fallback_rows,
                'publication_errors': errors, 'control': control}
    try:
        out.mkdir(parents=True, exist_ok=True)
        # Separate serialization protects failure of the normal encoder itself.
        payload = (json.JSONEncoder(ensure_ascii=True, allow_nan=False).encode(fallback) + '\n').encode('ascii')
        publish(out, payload, identity['run_id'])
    except BaseException as error:
        errors.append(error_record(error, 'fallback_publication'))
        try:
            message = 'INVALID_CONTROL summary unavailable/incomplete: ' + '; '.join(e['type'] + ': ' + e['message'] for e in errors)
            sys.stderr.write(message[:8000] + '\n')
            sys.stderr.flush()
        except BaseException:
            pass
    return 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--control', type=Path, required=True, help='same-source healthy performance summary')
    parser.add_argument('--image')
    parser.add_argument('--flock-ms', type=float)
    parser.add_argument('--only')
    args = parser.parse_args(argv)
    selected = list(MUTANTS) if args.only is None else args.only.split(',')
    # Invalid selections still receive one error row per requested ID.
    requested = list(dict.fromkeys(selected))
    identity = {'run_id': uuid.uuid4().hex, 'source_sha256': {}, 'control_sha256': None}
    rows = {name: no_verdict(name) for name in requested}
    out, healthy, control = args.out, Evaluation('healthy'), None

    def ingest(tx):
        tx.phase = 'selection'
        if not selected or any(name not in MUTANTS for name in selected) or len(selected) != len(requested):
            raise EvidenceError('nonempty unique known --only selection required')
        tx.phase = 'setup'
        out.mkdir(parents=True, exist_ok=True)
        tx.phase = 'healthy.read'
        raw = args.control.read_bytes()
        identity['control_sha256'] = hashlib.sha256(raw).hexdigest()
        tx.phase = 'healthy.parse'
        summary = strict_json(raw)
        tx.phase = 'healthy.validate'
        validate_summary(summary, [MUTANTS[name][0] for name in selected])
        tx.phase = 'healthy.hash'
        identity['source_sha256'] = source_hashes(ROOT)
        validate_sources(summary, identity['source_sha256'])
        tx.phase = 'healthy.judge'
        statuses = {name: control_status(MUTANTS[name][0], summary) for name in selected}
        return {'summary': summary, 'statuses': statuses}

    active = healthy
    try:
        control = evaluate(healthy, ingest)
        if healthy.errors:
            for name in requested:
                rows[name] = {**healthy.result(), **no_verdict(name)}
        elif any(control['statuses'].values()):
            # One invalid healthy basis blocks all dependent launches. Keep the
            # affected property's genuine failure separately from invalid design.
            for name in requested:
                status = control['statuses'][name] or 'control_invalid'
                rows[name] = no_verdict(name, status)
        else:
            for name in selected:
                active = Evaluation(name)
                scratch = []

                def cleanup():
                    if scratch:
                        scratch[0].cleanup()

                def run(tx):
                    case, filename, before, after, behaviour = MUTANTS[name]
                    if name == 'MP02' and MP02_DELAY_MS > MP02_MAX_DELAY_MS:
                        return no_verdict(name, 'no_valid_control')
                    tx.phase = 'setup'
                    scratch.append(tempfile.TemporaryDirectory(prefix='emr-perf-mutant-'))
                    candidate = Path(scratch[0].name)
                    tx.phase = 'copy'
                    shutil.copytree(ROOT / 'api/src', candidate / 'api/src')
                    shutil.copyfile(ROOT / 'api/tsconfig.json', candidate / 'api/tsconfig.json')
                    tx.phase = 'source.hash'
                    if source_hashes(candidate) != identity['source_sha256']:
                        raise EvidenceError('source changed since healthy validation')
                    tx.phase = 'mutation'
                    file = candidate / 'api/src/emr-runtime' / filename
                    original = file.read_text(encoding='utf-8')
                    if original.count(before) != 1:
                        raise EvidenceError('mutation location is ambiguous')
                    mutated = original.replace(before, after)
                    file.write_text(mutated, encoding='utf-8', newline='\n')
                    expected = source_hashes(candidate)
                    run = out / identity['run_id'] / name
                    cmd = [sys.executable, str(ROOT / 'tests/emr/b/performance.py'), '--out', str(run), '--candidate', str(candidate), '--cases', case]
                    if args.image:
                        cmd += ['--image', args.image]
                    if args.flock_ms is not None:
                        cmd += ['--flock-ms', str(args.flock_ms)]
                    exit_code = run_benchmark(cmd, out / (name + '.log'), tx)
                    if tx.errors:
                        return tx.result()
                    tx.phase = 'read'
                    summary = load_summary(run / 'summary.json')
                    tx.phase = 'validate'
                    validate_summary(summary, [case], exit_code)
                    validate_sources(summary, expected)
                    matching = property_failures(case, summary['failures'])
                    validity = None
                    if name == 'MP02':
                        tx.phase = 'receipt.read'
                        try:
                            raw = (run / 'receipt.jsonl').read_bytes()
                        except FileNotFoundError:
                            validity = {'valid': False, 'reasons': ['receipt.jsonl missing']}
                        else:
                            tx.phase = 'receipt.validate'
                            receipt = [strict_json(line) for line in raw.splitlines()]
                            validity = delay_control_validity(receipt, summary['repetitions'])
                    tx.phase = 'judge'
                    killed, status = mutant_result(case, exit_code, summary, matching, validity)
                    row = {'id': name, 'property': case, 'behaviour': behaviour, 'exit': exit_code,
                           'killed': killed, 'status': status, 'matching_assertions': matching,
                           'other_control_failures': control['summary']['failures'],
                           'source': file.relative_to(candidate).as_posix(),
                           'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
                           'mutant_sha256': hashlib.sha256(mutated.encode()).hexdigest(), 'failures': summary['failures']}
                    if validity is not None:
                        row['control_validity'] = validity
                    if killed is None:
                        row['diagnosis'] = DIAGNOSIS[status]
                    return row

                rows[name] = evaluate(active, run, cleanup)
    except BaseException as error:
        # Cancellation has propagated out of the evaluator. Normalize all
        # incomplete execution (including SystemExit(0/None)) to failure here.
        if not active.errors:
            active.failed(error)
        for name in requested:
            if name == active.name or active is healthy or rows[name].get('status') == 'harness_error':
                rows[name] = {**active.result(), **no_verdict(name)}
    try:
        control_record = {'errors': healthy.errors, 'statuses': control.get('statuses', {}) if control else {}}
        return finalize(out, requested, rows, identity, control_record)
    except BaseException as error:
        # The finalizer itself is a separate failure domain; never let an
        # exception in its handler override the nonzero exit latch.
        try:
            sys.stderr.write('INVALID_CONTROL summary unavailable/incomplete: ' + error_record(error, 'finalizer')['type'] + '\n')
        except BaseException:
            pass
        return 1


def entrypoint(argv=None):
    try:
        return main(argv)
    except BaseException:
        return 1


if __name__ == '__main__':
    raise SystemExit(entrypoint())
