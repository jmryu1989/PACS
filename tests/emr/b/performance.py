"""REQ-D878 -> RISK-EMR-RECEIPT-DELAY -> same-run performance/complexity contracts.

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
import shutil
import subprocess
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[3]
BASELINE = "9a1df0d1328d5b8ad979fc7d2ef65192d595cf4b"


def permutation(a, b):
    joined = a + b
    observed = abs(statistics.mean(a) - statistics.mean(b))
    differences = []
    for chosen in itertools.combinations(range(len(joined)), len(a)):
        indexes = set(chosen)
        differences.append(abs(statistics.mean(joined[i] for i in indexes) -
                               statistics.mean(joined[i] for i in range(len(joined)) if i not in indexes)))
    return sum(d >= observed - 1e-12 for d in differences) / len(differences)


def summarize(rows):
    return {q: statistics.median(row[q] for row in rows) for q in ("p50", "p95", "p99")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True)
    parser.add_argument("--candidate", type=Path, default=ROOT)
    parser.add_argument("--image")
    parser.add_argument("--flock-ms", type=float, help="measured Linux flock pair cost, emulated by the original Windows harness")
    parser.add_argument("--cases", default="ledger,sustained,concurrent,journal")
    args = parser.parse_args()
    if not args.image and args.flock_ms is None:
        parser.error('--flock-ms is required without a Linux image; measure lock_test.cjs first')
    candidate_input, out = args.candidate.resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cases = args.cases.split(",")
    env = {**os.environ, "AB_DURATION_MS": "6000", "JOURNAL_REPS": "5"}
    with tempfile.TemporaryDirectory(prefix="emr-r3-") as scratch:
        baseline, candidate = Path(scratch) / 'baseline', Path(scratch) / 'candidate'
        baseline.mkdir()
        shutil.copytree(candidate_input / 'api/src', candidate / 'api/src')
        shutil.copyfile(candidate_input / 'api/tsconfig.json', candidate / 'api/tsconfig.json')
        source_hashes = {str(p.relative_to(candidate)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest()
                         for p in candidate.rglob('*') if p.is_file()}
        archive = subprocess.check_output(["git", "archive", BASELINE, "api/src", "api/tsconfig.json"], cwd=ROOT)
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
                           "-e", "AB_DURATION_MS=6000", "-e", "JOURNAL_REPS=5", "--entrypoint", "tail", args.image, "-f", "/dev/null"]
                container = subprocess.check_output(command, text=True, timeout=60).strip()
                # Keep the execution argv private; evidence receives a value copy.
                (out / 'container.json').write_text(json.dumps({'id': container, 'command': command + []}) + '\n')
                # Each sample starts a fresh process. Keep its immutable source
                # and existing compiler on Linux too: repeated compiler/module
                # loads through a Windows bind mount are not receipt latency.
                subprocess.run(["docker", "exec", "--user", "0", container, "node", "-e",
                    "for (const p of ['/harness/tests/emr','/candidate','/baseline','/deps']) require('node:fs').mkdirSync(p,{recursive:true})"],
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
            for rep in range(5):
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
    failures, report = [], {"baseline": BASELINE, "candidate_sources": source_hashes, "repetitions": 5,
                           "lock": {"choice": "B", "linux_image": args.image, "emulated_pair_ms": args.flock_ms, "state_filesystem": "disposable-local-volume" if args.image else "host"}, "cases": {}}
    for case, count, retained in configs:
        selected = [r for r in receipt if r["label"].startswith(case + "-") and r["concurrency"] == count and r["prefill"] == retained]
        pair = {v: [r for r in selected if r["version"] == v] for v in ("r3", "r4d")}
        assert all(len(pair[v]) == 5 for v in pair), "missing or duplicated repetitions"
        stats = {v: summarize(pair[v]) for v in pair}
        stats["permutation_p"] = permutation([r["p95"] for r in pair["r3"]], [r["p95"] for r in pair["r4d"]])
        stats["failures"] = sum(r["failures"] for r in selected)
        report["cases"][f"{case}-{count}-{retained}"] = stats
        if stats["failures"]:
            failures.append(f"{case}-{count}-{retained}: request failed")
        if case != "ledger" and stats["r4d"]["p95"] > stats["r3"]["p95"] * (1.15 if case == "sustained" else 1.0):
            failures.append(f"{case}-{count}: candidate p95 exceeds same-run r3 budget (sustained +15%, concurrent +0%)")
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
