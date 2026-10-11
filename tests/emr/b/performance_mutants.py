"""D878 negative controls: one executable regression for each performance property.

Every mutant runs the same relative A/B or measured IO complexity assertion as its
healthy control. A build/import failure is a harness error, never a kill.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from performance import ROOT

MUTANTS = {
    "MP01": ("ledger", "seal.ts", "    const current = state.tail.streams[stream];\n    if (tail.chainId",
             "    full = true;\n    const current = state.tail.streams[stream];\n    if (tail.chainId", "single receipt rereads the retained prefix"),
    "MP02": ("sustained", "seal.ts", "      void Promise.resolve().then(drain);",
             "      void new Promise(resolve => setTimeout(resolve, 50)).then(drain);", "fixed receipt delay exceeds the sustained receipt budget"),
    "MP03": ("concurrent", "external-writer.ts", "  const { directory, operation, value } = request, context = request.context ?? {};",
             "  const { directory, operation, value } = request, context = request.context ?? {};\n"
             "  if (operation === 'reserve') require('node:child_process').spawnSync(process.execPath, ['-e', '']);",
             "per-reservation process startup serializes concurrent receipts"),
    "MP04": ("journal", "external-writer.ts", "    const journal = context.journal ??= new JournalFile(directory);",
             "    const journal = new JournalFile(directory);", "each append rereads the full failure journal"),
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--control', type=Path, required=True, help='same-source healthy performance summary')
    parser.add_argument('--image')
    parser.add_argument('--flock-ms', type=float)
    parser.add_argument('--only')
    args = parser.parse_args()
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
        unhealthy = property_failures(case, control['failures'])
        if unhealthy:
            rows.append({'id': name, 'property': case, 'killed': None, 'status': 'control_failed',
                         'control_failures': unhealthy, 'reason': 'No valid mutant verdict: its healthy property control failed.'})
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
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=1200, env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            (out / (name + '.log')).write_text(result.stdout + result.stderr, encoding='utf-8')
            summary = json.loads((run / 'summary.json').read_text()) if (run / 'summary.json').exists() else None
            matching = property_failures(case, summary['failures']) if summary else []
            killed = result.returncode == 1 and summary is not None and bool(matching)
            rows.append({'id': name, 'property': case, 'behaviour': behaviour, 'exit': result.returncode, 'killed': killed,
                         'status': 'completed', 'matching_assertions': matching,
                         'other_control_failures': control['failures'],
                         'source': str(file.relative_to(candidate)), 'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
                         'mutant_sha256': hashlib.sha256(mutated.encode()).hexdigest(), 'failures': summary and summary['failures']})
            print(json.dumps(rows[-1]), flush=True)
    summary = {'total': len(rows), 'killed': sum(r['killed'] is True for r in rows),
               'survived': [r['id'] for r in rows if r['killed'] is False],
               'not_run': [r['id'] for r in rows if r['killed'] is None], 'results': rows}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    return bool(summary['survived'] or summary['not_run'])


if __name__ == '__main__':
    raise SystemExit(main())
