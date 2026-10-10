"""REQ-D878 -> RISK-EMR-RECEIPT-DELAY -> same-run performance/complexity contracts.

Developer smoke check only; NOT a performance acceptance measurement (D941).
Reuses Opus's real-code A/B DB-boundary harness, with constant-cost MVCC snapshots.
No DB, network, LiveStack or existing fixture. Baseline is the pinned round-3 blob.
Optional --image runs both revisions on the same disposable Linux filesystem and
uses the image's existing flock(1) with the actual coordinator. No absolute historical latency SLO.
"""
import argparse
import hashlib
import io
import itertools
import json
import os
from pathlib import Path
import statistics
import math
import shutil
import subprocess
import tarfile
import tempfile
import uuid
from noninferiority import noninferiority

ROOT = Path(__file__).resolve().parents[3]
BASELINE = "9a1df0d1328d5b8ad979fc7d2ef65192d595cf4b"


def permutation(a, b):
    # Each interleaved repetition is a same-run pair. Enumerate every paired
    # label swap (2**n), not independent reassignments that discard that pairing.
    differences = [x - y for x, y in zip(a, b)]
    observed = abs(sum(differences))
    choices = list(itertools.product((-1, 1), repeat=len(differences)))
    return sum(abs(sum(s * d for s, d in zip(signs, differences))) >= observed - 1e-12
               for signs in choices) / len(choices)


def relative_bound(a, b):
    """Paired geometric ratio, two-sided 95% t interval (10 pairs, df=9)."""
    ratios = [math.log(y / x) for x, y in zip(a, b)]
    center = statistics.mean(ratios)
    # The public measurement uses ten pairs; do not imply a calibrated interval
    # for shorter diagnostic runs.
    upper = center + 2.262157 * statistics.stdev(ratios) / math.sqrt(len(ratios)) if len(ratios) == 10 else None
    return {"paired_geometric_pct": (math.exp(center) - 1) * 100,
            "paired_upper_95_pct": None if upper is None else (math.exp(upper) - 1) * 100,
            "interval_method": "paired log-ratio Student t, df=9" if upper is not None else "not computed"}


def summarize(rows):
    return {q: statistics.median(row[q] for row in rows) for q in ("p50", "p95", "p99")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--candidate", type=Path, default=ROOT)
    parser.add_argument("--image")
    parser.add_argument("--flock-ms", type=float, help="measured Linux flock pair cost, emulated by the original Windows harness")
    parser.add_argument("--cases", default="ledger,sustained,concurrent,journal")
    parser.add_argument("--reps", type=int, default=10)
    args = parser.parse_args()
    if not args.image and args.flock_ms is None:
        parser.error('--flock-ms is required without a Linux image; measure lock_test.cjs first')
    candidate_input, out = args.candidate.resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cases = args.cases.split(",")
    env = {**os.environ, "AB_DURATION_MS": "6000", "JOURNAL_REPS": str(args.reps)}
    with tempfile.TemporaryDirectory(prefix="emr-r3-") as scratch:
        baseline, candidate = Path(scratch) / 'baseline', Path(scratch) / 'candidate'
        baseline.mkdir()
        shutil.copytree(candidate_input / 'api/src', candidate / 'api/src')
        shutil.copyfile(candidate_input / 'api/tsconfig.json', candidate / 'api/tsconfig.json')
        source_hashes = {str(p.relative_to(candidate)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in candidate.rglob('*') if p.is_file()}
        archive = subprocess.check_output(["git", "archive", BASELINE, "api/src", "api/tsconfig.json"],
                                         cwd=os.environ.get("KIN_EMR_BASELINE_REPOSITORY", ROOT))
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(baseline, filter="data")

        container = None
        volume = None
        try:
            if args.image:
                # Match the product's protected-state storage: a disposable local
                # volume, not the container's copy-on-write image layer. Both
                # revisions use this same durable filesystem; this is not tmpfs.
                token = uuid.uuid4().hex
                volume = subprocess.check_output(["docker", "volume", "create", "--label",
                    "kin.emrb.performance=" + token, "kin-emrb-perf-" + token], text=True, timeout=60).strip()
                command = ["docker", "run", "-d", "--rm", "--network", "none",
                           "--label", "kin.emrb.performance=" + token,
                           "--mount", f"type=volume,source={volume},target=/tmp",
                           "--mount", f"type=bind,source={out},target=/evidence",
                           "-e", "KIN_EMR_TYPESCRIPT=/deps/typescript",
                           "-e", "AB_DURATION_MS=6000", "-e", "JOURNAL_REPS=" + str(args.reps), "--entrypoint", "tail", args.image, "-f", "/dev/null"]
                container = subprocess.check_output(command, text=True, timeout=60).strip()
                # Keep the execution argv private; evidence receives a value copy.
                (out / 'container.json').write_text(json.dumps({'id': container, 'command': command + []}) + '\n')
                # Each sample starts a fresh process. Keep its immutable source
                # and existing compiler on Linux too: repeated compiler/module
                # loads through a Windows bind mount are not receipt latency.
                # The image runs as the unprivileged `node` user while the
                # /evidence bind mount is a directory the host runner created
                # (owner runner, mode 755 on Linux CI): without this the first
                # receipt append fails with EACCES. Docker Desktop on Windows
                # never showed it because its bind mounts are world-writable.
                subprocess.run(["docker", "exec", "--user", "0", container, "node", "-e",
                    "for (const p of ['/harness/tests/emr','/candidate','/baseline','/deps']) require('node:fs').mkdirSync(p,{recursive:true});"
                    "require('node:fs').chmodSync('/evidence', 0o1777)"],
                    check=True, capture_output=True, timeout=60)
                for source, destination in ((ROOT / 'tests/emr/b', '/harness/tests/emr/b'),
                        (str(candidate) + '/.', '/candidate'), (str(baseline) + '/.', '/baseline'),
                        ((ROOT / 'api/node_modules').resolve() / 'typescript', '/deps/typescript')):
                    subprocess.run(["docker", "cp", str(source), container + ':' + destination],
                                   check=True, capture_output=True, timeout=120)
            def run(harness, values):
                if args.image:
                    command = ["docker", "exec", container, "node", "/harness/tests/emr/b/" + harness, *values]
                else:
                    command = ["node", str(ROOT / "tests/emr/b" / harness), *values]
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=240)
                with (out / "raw.log").open("a", encoding="utf-8") as log:
                    log.write(json.dumps(command + []) + "\n" + result.stdout + result.stderr)
                if result.returncode:
                    raise RuntimeError(f"A/B harness failed ({result.returncode}): {result.stderr[-2000:]}")

            roots = {"r3": "/baseline" if args.image else str(baseline), "r4d": "/candidate" if args.image else str(candidate)}
            result_file = "/evidence/receipt.jsonl" if args.image else str(out / "receipt.jsonl")
            configs = []
            if "ledger" in cases:
                configs += [("ledger", 1, n) for n in (0, 20000, 100000)]
            if "sustained" in cases:
                configs += [("sustained", 20, 20000)]
            if "concurrent" in cases:
                configs += [("concurrent", n, 0) for n in (24, 48)]
            for rep in range(args.reps):
                # Balance size/workload order as well as revision order.
                ordered = configs if rep % 2 == 0 else list(reversed(configs))
                for case, count, retained in ordered:
                    for version in (["r3", "r4d"] if rep % 2 == 0 else ["r4d", "r3"]):
                        run("ab_sustained.cjs" if case == "sustained" else "ab_latency.cjs",
                            [roots[version], f"{case}-{rep}-{version}", str(count), str(retained), result_file, "0.5", "1", str(args.flock_ms or 0), "9"])
            if "journal" in cases:
                run("journal_cost.cjs", [roots["r3"], roots["r4d"], "/evidence/journal.json" if args.image else str(out / "journal.json")])

        finally:
            if container:
                subprocess.run(["docker", "rm", "-f", container], check=True, capture_output=True, timeout=60)
            if volume:
                subprocess.run(["docker", "volume", "rm", volume], check=True, capture_output=True, timeout=60)

    receipt = [json.loads(line) for line in (out / "receipt.jsonl").read_text().splitlines()] if configs else []
    failures, report = [], {"purpose": "developer smoke only; SQL/COMMIT delays are modeled; no acceptance verdict",
                           "baseline": BASELINE, "candidate_sources": source_hashes, "repetitions": args.reps,
                           "lock": {"choice": "B", "linux_image": args.image, "emulated_pair_ms": args.flock_ms, "state_filesystem": "disposable-local-volume" if args.image else "host"}, "cases": {}}
    for case, count, retained in configs:
        selected = [r for r in receipt if r["label"].startswith(case + "-") and r["concurrency"] == count and r["prefill"] == retained]
        pair = {v: [r for r in selected if r["version"] == v] for v in ("r3", "r4d")}
        assert all(len(pair[v]) == args.reps for v in pair), "missing or duplicated repetitions"
        stats = {v: summarize(pair[v]) for v in pair}
        stats["permutation_p"] = permutation([r["p95"] for r in pair["r3"]], [r["p95"] for r in pair["r4d"]])
        stats["p95_pct"] = (stats["r4d"]["p95"] / stats["r3"]["p95"] - 1) * 100
        stats.update(relative_bound([r["p95"] for r in pair["r3"]], [r["p95"] for r in pair["r4d"]]))
        added = [b["p95"] - a["p95"] for a, b in zip(pair["r3"], pair["r4d"])]
        stats["added_p95_ms_upper95"] = (statistics.mean(added) + 2.262157 * statistics.stdev(added) / math.sqrt(len(added))) if len(added) == 10 else None
        stats["added_interval_method"] = "paired difference Student t upper endpoint of two-sided 95% interval, df=9" if len(added) == 10 else "not computed"
        stats["failures"] = sum(r["failures"] for r in selected)
        report["cases"][f"{case}-{count}-{retained}"] = stats
        if stats["failures"]:
            failures.append(f"{case}-{count}-{retained}: request failed")
        if stats["r4d"]["p95"] > stats["r3"]["p95"] * (1.0 if case == "concurrent" else 1.10):
            failures.append(f"{case}-{count}-{retained}: candidate p95 exceeds same-run r3 budget (+10%, concurrent +0%)")
        if case == "sustained" and args.reps >= 2:
            stats['noninferiority'] = noninferiority([[r['p95']] for r in pair['r3']], [[r['p95']] for r in pair['r4d']])
            if not stats['noninferiority']['accepted']:
                failures.append('sustained: one-sided 95% p95 ratio bound exceeds 1.10 (developer smoke)')
        if case == "ledger" and max(r["read_rows"] for r in pair["r4d"]) > 4:
            failures.append(f"ledger-{retained}: single receipt reads retained prefix")
    if "ledger" in cases:
        groups = {n: [r["p95"] for r in receipt if r["version"] == "r4d" and r["concurrency"] == 1 and r["prefill"] == n] for n in (0, 20000, 100000)}
        comparisons = {}
        for n in (20000, 100000):
            p = permutation(groups[0], groups[n])
            comparisons[str(n)] = {"permutation_p": p, "ratio": statistics.median(groups[n]) / statistics.median(groups[0])}
            if p < .05 and comparisons[str(n)]["ratio"] > 1.2:
                failures.append(f"ledger-{n}: size effect exceeds same-run noise")
        report["ledger_size"] = comparisons
    if "journal" in cases:
        rows = json.loads((out / "journal.json").read_text())
        report["journal"] = {}
        for n in (0, 10000, 150000):
            pair = {v: [r for r in rows if r["version"] == v and r["records"] == n] for v in ("r3", "r4d")}
            report["journal"][str(n)] = {v: summarize(pair[v]) for v in pair}
            report["journal"][str(n)]["permutation_p"] = permutation([r["p95"] for r in pair["r3"]], [r["p95"] for r in pair["r4d"]])
            if any(r["read_bytes"] for r in pair["r4d"]):
                failures.append(f"journal-{n}: append rereads verified bytes")
            small = [r["p95"] for r in rows if r["version"] == "r4d" and r["records"] == 0]
            large = [r["p95"] for r in pair["r4d"]]
            p = permutation(small, large)
            report["journal"][str(n)]["size_permutation_p"] = p
            if p < .05 and statistics.median(large) > statistics.median(small) * 1.2:
                failures.append(f"journal-{n}: size effect exceeds same-run noise")
    report["failures"] = failures
    (out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
