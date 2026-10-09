# coding: utf-8
"""EMR-E R1 mutants M-E-01..07 (required) and M-E-X1..X5 (supplementary), against tests/emr/e/contract_test.cjs.

Each mutant rewrites one decision in a copy of api/src made outside the repository; the product tree is never written.
The contract test then runs against that copy (KIN_EMR_E_SOURCE_DIR). A mutant is killed only when every declared case
was collected and at least one of the behaviour cases it names fails on an assertion (node:assert, ERR_ASSERTION); the
assertion text is kept as evidence. A load failure, a crash, a missing or repeated anchor or a timeout is a harness
error, never a kill. The anchors below only locate the line to mutate; they are not assertions about the product.

    python -B tests/emr/e/mutants.py [--out tmp/emr-e/mutants.json]
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[3]
TEST = ROOT / "tests" / "emr" / "e" / "contract_test.cjs"
SOURCE = ROOT / "api" / "src"
COPIED = ("emr-contract", "emr-image")
TIMEOUT = 180

MUTANTS = [
    {"id": "M-E-01", "required": True, "title": "authz 204 recorded as download complete", "file": "emr-image/contract.ts",
     "find": "if (stage === 'authorized') { const o = object(raw, ['stage', 'status']); if (o.status !== 204 || durable) refuse('ObservationOrderInvalid'); continue; }",
     "replace": "if (stage === 'authorized') { for (const u of p.units) { const slot = units.get(u.key); slot.confirmed.push([0, u.expectedBytes ?? 1]); slot.hash = true; slot.derivedDone = true; } continue; }",
     "kills": ["TEST-E-01 delivery_states R1"]},
    {"id": "M-E-02", "required": True, "title": "manifest ignores a missing last frame", "file": "emr-image/manifest.ts",
     "find": "if (declaredFrameCount < 1 || frames.length !== declaredFrameCount || frames.some((f, i) => f.number !== i + 1)) refuse('FrameSetIncomplete');",
     "replace": "if (declaredFrameCount < 1 || frames.some((f, i) => f.number !== i + 1)) refuse('FrameSetIncomplete');",
     "kills": ["TEST-E-02 manifest_sources R2"]},
    {"id": "M-E-03", "required": True, "title": "direct Orthanc /instances path allowed", "file": "emr-image/contract.ts",
     "find": "  if (s[0] !== 'dicom-web') refuse(DIRECT_ORTHANC_ROOTS.includes(s[0]) ? 'DirectOrthancPathRefused' : 'ImagePathRefused');",
     "replace": "  if (s[0] === 'instances') { const direct = freeze({ method: m as 'GET' | 'HEAD', kind: 'object' as ImageRequestKind, studyUid: null, seriesUid: null,"
                " sopInstanceUid: s[1] ?? null, frames: null, bulkTag: null, query: {} }); parsed.add(direct); return direct; }\n"
                "  if (s[0] !== 'dicom-web') refuse(DIRECT_ORTHANC_ROOTS.includes(s[0]) ? 'DirectOrthancPathRefused' : 'ImagePathRefused');",
     "kills": ["TEST-E-03 basis_and_bypass R3"]},
    {"id": "M-E-04", "required": True, "title": "aborted transfer counted as complete", "file": "emr-image/contract.ts",
     "find": "const confirmed = terminal === 'transfer-ended';",
     "replace": "const confirmed = terminal === 'transfer-ended' || terminal === 'transfer-aborted';",
     "kills": ["TEST-E-01 delivery_states R2"]},
    {"id": "M-E-05", "required": True, "title": "DBT accepted as synthetic 2D", "file": "emr-image/manifest.ts",
     "find": "  if (entry.family === 'breast-tomosynthesis' && !['dbt', 'unverified'].includes(kind)) refuse('MammographyKindMismatch');\n",
     "replace": "",
     "kills": ["TEST-E-02 manifest_sources R5"]},
    {"id": "M-E-06", "required": True, "title": "reconnect IP written into the offline records", "file": "emr-image/contract.ts",
     "find": "relatedOfflineEventIds: offline.map(x => x.eventId) }, offline: [...offline] });",
     "replace": "relatedOfflineEventIds: offline.map(x => x.eventId) }, offline: offline.map(x => ({ ...x, trustedProxyIp: { status: 'known' as const,"
                " value: { address: ip.address, source: 'trusted-proxy' as const } } })) as any });",
     "kills": ["TEST-E-04 offline_ready A3"]},
    {"id": "M-E-07", "required": True, "title": "Offline Ready ignores a missing decoder", "file": "emr-image/contract.ts",
     "find": "if (!got) reasons.push({ code: `${part.kind}-missing` as ReadinessReason['code'], key: part.key });",
     "replace": "if (!got) { if (part.kind !== 'decoder') reasons.push({ code: `${part.kind}-missing` as ReadinessReason['code'], key: part.key }); }",
     "kills": ["TEST-E-04 offline_ready R3"]},
    {"id": "M-E-X1", "required": False, "title": "background load recorded as a display", "file": "emr-image/contract.ts",
     "find": "if (choice(r.cause, ['user-view', 'background-fetch', 'service-job']) !== 'user-view') refuse('BackgroundIsNotDisplay');",
     "replace": "choice(r.cause, ['user-view', 'background-fetch', 'service-job']);",
     "kills": ["TEST-E-05 display_epoch R1"]},
    {"id": "M-E-X2", "required": False, "title": "cache re-display not recorded", "file": "emr-image/contract.ts",
     "find": "if ((source === 'network') !== (r.deliveryEventId !== null)) refuse('DisplaySourceMismatch');",
     "replace": "if (source !== 'network' || r.deliveryEventId === null) refuse('DisplaySourceMismatch');",
     "kills": ["TEST-E-05 display_epoch A1"]},
    {"id": "M-E-X3", "required": False, "title": "ACK of an earlier generation accepted", "file": "emr-image/contract.ts",
     "find": "if (!sameOpening(a as any, current) || !sameOpening(display, current) || display.manifestSha256 !== current.manifestSha256) refuse('StaleAckRefused');",
     "replace": "if (!sameOpening(a as any, current)) refuse('StaleAckRefused');",
     "kills": ["TEST-E-05 display_epoch R2"]},
    {"id": "M-E-X4", "required": False, "title": "third-party image delivery switched on in Part 1", "file": "emr-image/contract.ts",
     "find": "export const PART1_THIRD_PARTY_DELIVERY = false;",
     "replace": "export const PART1_THIRD_PARTY_DELIVERY = true;",
     "kills": ["TEST-E-03 basis_and_bypass A2"]},
    {"id": "M-E-X5", "required": False, "title": "revoked consent still accepted", "file": "emr-image/contract.ts",
     "find": "  if (revokedAt !== null && revokedAt <= at) refuse('BasisRevoked');\n",
     "replace": "",
     "kills": ["TEST-E-03 basis_and_bypass R1"]},
]

TOP = re.compile(r"^(ok|not ok) (\d+) - (.*)$")


def node():
    found = shutil.which("node")
    if not found:
        raise SystemExit("node is not on PATH")
    return found


def declared():
    out = subprocess.run([node(), str(TEST), "--list-cases"], cwd=ROOT, capture_output=True, timeout=TIMEOUT)
    if out.returncode != 0:
        raise SystemExit("cannot list the declared cases: " + out.stderr.decode("utf-8", "replace"))
    cases = json.loads(out.stdout.decode("utf-8"))
    if not cases or len(set(cases)) != len(cases):
        raise SystemExit("declared case list is empty or repeats a case")
    return cases


def parse_tap(text):
    """Top-level results only: name -> {ok, code, failureType, message}. Nested subtests are indented and ignored."""
    results, lines, index = {}, text.splitlines(), 0
    while index < len(lines):
        match = TOP.match(lines[index])
        index += 1
        if not match:
            continue
        name = match.group(3).replace("\\#", "#")
        entry = {"ok": match.group(1) == "ok", "code": None, "failureType": None, "message": []}
        if index < len(lines) and lines[index].strip() == "---":
            index += 1
            in_error = False
            while index < len(lines) and lines[index].strip() != "...":
                line = lines[index]
                stripped = line.strip()
                if line.startswith("  code: "):
                    entry["code"], in_error = stripped.split(": ", 1)[1].strip("'\""), False
                elif line.startswith("  failureType: "):
                    entry["failureType"], in_error = stripped.split(": ", 1)[1].strip("'\""), False
                elif line.startswith("  error: "):
                    in_error = True
                    rest = stripped.split(": ", 1)[1]
                    if rest not in ("|-", "|", ">-"):
                        entry["message"].append(rest.strip("'\""))
                elif in_error and line.startswith("    "):
                    entry["message"].append(stripped)
                elif line.startswith("  ") and not line.startswith("    "):
                    in_error = False
                index += 1
            index += 1
        if name in results:
            entry["duplicate"] = True
        results[name] = entry
    return results


def run_against(source_dir):
    env = dict(os.environ, KIN_EMR_E_SOURCE_DIR=str(source_dir))
    try:
        out = subprocess.run([node(), "--test", "--test-reporter=tap", str(TEST)], cwd=ROOT, env=env, capture_output=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "timeout", ""
    text = out.stdout.decode("utf-8", "replace")
    return out.returncode, text, out.stderr.decode("utf-8", "replace")


def copy_tree(target):
    for name in COPIED:
        shutil.copytree(SOURCE / name, target / name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out")
    args = parser.parse_args()
    cases = declared()
    report = {"declared": cases, "baseline": None, "mutants": []}
    ok = True
    with tempfile.TemporaryDirectory(prefix="emr-e-mutants-") as temporary:
        base = Path(temporary) / "baseline" / "src"
        copy_tree(base)
        code, text, stderr = run_against(base)
        results = parse_tap(text) if code is not None else {}
        baseline_ok = code == 0 and list(results) == cases and all(r["ok"] for r in results.values())
        report["baseline"] = {"exit": code, "collected": list(results), "passed": sum(r["ok"] for r in results.values()),
                              "failed": [n for n, r in results.items() if not r["ok"]], "matches_declared": list(results) == cases}
        if not baseline_ok:
            report["baseline"]["stderr"] = stderr[-4000:]
            print("BASELINE FAILED", json.dumps(report["baseline"], ensure_ascii=False))
            ok = False
        for mutant in MUTANTS:
            entry = {key: mutant[key] for key in ("id", "required", "title", "file", "kills")}
            work = Path(temporary) / mutant["id"] / "src"
            copy_tree(work)
            path = work / mutant["file"]
            original = path.read_text(encoding="utf-8")
            count = original.count(mutant["find"])
            if count != 1:
                entry.update(status="harness-error", reason=f"anchor occurs {count} times")
                report["mutants"].append(entry)
                ok = False
                print(mutant["id"], "harness-error", entry["reason"])
                continue
            path.write_text(original.replace(mutant["find"], mutant["replace"]), encoding="utf-8")
            code, text, stderr = run_against(work)
            results = parse_tap(text) if code is not None else {}
            collected = list(results)
            named = [n for n in collected if any(n.startswith(prefix + " ") for prefix in mutant["kills"])]
            killed_by = [n for n in named if not results[n]["ok"] and results[n]["code"] == "ERR_ASSERTION"]
            others = [n for n, r in results.items() if not r["ok"] and n not in killed_by]
            entry.update(exit=code, collected_all=collected == cases, named_cases=named,
                         killed_by=[{"case": n, "assertion": results[n]["message"][:6]} for n in killed_by],
                         other_failures=[{"case": n, "code": results[n]["code"], "assertion": results[n]["message"][:3]} for n in others])
            if code is None:
                entry.update(status="harness-error", reason="timeout")
            elif collected != cases or not named:
                entry.update(status="harness-error", reason="the mutated copy did not run every declared case", stderr=stderr[-2000:])
            else:
                entry["status"] = "killed" if killed_by else "survived"
            if entry["status"] != "killed":
                ok = False
            report["mutants"].append(entry)
            print(mutant["id"], entry["status"], "|", "; ".join(k["case"] for k in entry["killed_by"]) or entry.get("reason", ""))
    report["result"] = "pass" if ok else "fail"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("RESULT", report["result"], f"{sum(m.get('status') == 'killed' for m in report['mutants'])}/{len(MUTANTS)} killed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
