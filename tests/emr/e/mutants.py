# coding: utf-8
"""EMR-E R1 mutants M-E-01..07, M-E-F01..F06 and M-E-D1..D7 (required) and M-E-X1..X6 (supplementary), against tests/emr/e/contract_test.cjs.

Each mutant rewrites one decision in a copy of api/src (or, for M-E-F06, of the test file) made outside the repository;
the product tree is never written.
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
     "replace": "if (stage === 'authorized') { for (const u of p.units) { const slot = units.get(u.key); slot.ranges.push({ start: 0, end: u.expectedBytes ?? 1,"
                " response: p.eventId, confirmed: true, verifiedBy: u.sha256 ? { source: 'store-read', readId: 'authz', sha256: u.sha256 } : null });"
                " slot.derivedDone = true; } continue; }",
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
    # Round 2 (E-R1-05): the old M-E-05 removed a guard that refused every generated 2D of the Breast Tomosynthesis IOD,
    # which the standard allows. The required defect is a multi-frame DBT accepted as synthetic 2D.
    # Round 3 (D735): the classifier reads the stored header; a multi-frame tomosynthesis object is never synthetic 2D.
    {"id": "M-E-05", "required": True, "title": "multi-frame DBT accepted as synthetic 2D", "file": "emr-image/manifest.ts",
     "find": "    if (n === 1 && key === ",
     "replace": "    if (key === ",
     "kills": ["TEST-D735-BTO-GENERATED-TWO-FRAMES"]},
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
     "find": "if ((source === 'network') !== (r.deliveryEventId !== null) || (source !== 'network' && delivery !== null)) refuse('DisplaySourceMismatch');",
     "replace": "if (source !== 'network' || r.deliveryEventId === null) refuse('DisplaySourceMismatch');",
     "kills": ["TEST-E-05 display_epoch A1"]},
    {"id": "M-E-X6", "required": False, "title": "network display accepted without its own opening's delivery", "file": "emr-image/contract.ts",
     "find": "    refuse('DisplayDeliveryMismatch');",
     "replace": "    void 0;",
     "kills": ["TEST-E-05 display_epoch R1"]},
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
    # Round 2: each fix of the Astra review of 775a31b re-broken, killed by its own behaviour case.
    {"id": "M-E-F01", "required": True, "title": "E-R1-01 one verified range marks the whole unit verified", "file": "emr-image/contract.ts",
     "find": "    const verified = slot.unit.sha256 === null ? [] : span(slot.ranges.filter(x => x.confirmed && x.verifiedBy?.sha256 === slot.unit.sha256));",
     "replace": "    const verified = slot.unit.sha256 === null ? [] : slot.ranges.some(x => x.confirmed && x.verifiedBy?.sha256 === slot.unit.sha256) ? confirmed : [];",
     "kills": ["TEST-E-01 delivery_states R7"]},
    {"id": "M-E-F02", "required": True, "title": "E-R1-02 ranges of another receiver summed into one provision", "file": "emr-image/contract.ts",
     "find": "    if (!sameReceiver(p.receiver, first.receiver)) refuse('DeliveryContextMismatch');\n",
     "replace": "",
     "kills": ["TEST-E-01 delivery_states R8"]},
    {"id": "M-E-F03", "required": True, "title": "E-R1-03 Offline Ready ignores objects left out of the copy", "file": "emr-image/contract.ts",
     "find": "  for (const x of plan.excluded) reasons.push({ code: 'object-unsupported', key: `object:${x.studyUid}/${x.sopInstanceUid}` });\n",
     "replace": "",
     "kills": ["TEST-E-04 offline_ready R5"]},
    {"id": "M-E-F04", "required": True, "title": "E-R1-04 HEAD or header bulk accepted as display evidence", "file": "emr-image/contract.ts",
     "find": "  return delivery.body && delivery.units.some(u => u.displayable && u.sopInstanceUid === sopInstanceUid && (frame === null || u.frame === null || u.frame === frame));",
     "replace": "  return delivery.units.some(u => u.recordKind !== 'study-metadata' && u.sopInstanceUid === sopInstanceUid && (frame === null || u.frame === null || u.frame === frame));",
     "kills": ["TEST-E-05 display_epoch R3"]},
    {"id": "M-E-F05", "required": True, "title": "E-R1-05 standard generated 2D of the tomosynthesis IOD refused", "file": "emr-image/manifest.ts",
     "find": "    if (n === 1 && key === ",
     "replace": "    if (false && n === 1 && key === ",
     "kills": ["TEST-D735-BTO-HOLOGIC-GENERATED"]},
    {"id": "M-E-F06", "required": True, "title": "E-R1-06 refusal check counts the body only when the call returns", "target": "test",
     "file": "tests/emr/e/contract_test.cjs",
     "find": "function bodyNeverStarts(fn, code) {\n  const spy = { body: 0, prepared: [] };\n  refused(() => fn(spy), code);\n"
             "  assert.equal(spy.body, 0, 'no body source may start on a refused provision');\n"
             "  assert.equal(spy.prepared.length, 0, 'no delivery plan may be issued on a refused provision');\n}",
     "replace": "function bodyNeverStarts(fn, code) {\n  let reached = 0;\n"
                "  refused(() => { const spy = { body: 0, prepared: [] }; fn(spy); reached += spy.body; }, code);\n"
                "  assert.equal(reached, 0, 'no body source may start on a refused provision');\n}",
     "kills": ["TEST-E-03 basis_and_bypass R5"]},
    # Round 3 (D735, rule.md EMR-E deltas E-1..E-7): one mutant per delta class, killed by the shared table or its own case.
    {"id": "M-E-D1", "required": True, "title": "E-1 only the first frame's Frame Type is read", "file": "emr-image/manifest.ts",
     "find": "  for (const f of perFrame) {", "replace": "  for (const f of perFrame.slice(0, 1)) {",
     "kills": ["TEST-D735-BTO-ONE-FRAME-TYPE-MISSING"]},
    {"id": "M-E-D2", "required": True, "title": "E-2 Image Type and Frame Type mismatch accepted (E-R2-01)", "file": "emr-image/manifest.ts",
     "find": "    if (typeKey(strings(ft[0], '00089007')) !== key) fail('frame-type-mismatch');\n", "replace": "",
     "kills": ["TEST-D735-BTO-TYPE-MISMATCH-ORIGIN"]},
    {"id": "M-E-D3", "required": True, "title": "E-3 Volumetric Properties alone decides slices or slab (E-R2-03)", "file": "emr-image/manifest.ts",
     "find": "  const g = geometry(shared, perFrame, itemsOf(h, '00209222'));",
     "replace": "  let g: { t: number; d: number }; try { g = geometry(shared, perFrame, itemsOf(h, '00209222')); } catch {"
                " return { base: vp === 'VOLUME' ? 'dbt-slices' : 'dbt-slab', basis: 'volumetric-properties', representation: vp === 'VOLUME' ? 'slices' : 'slab', biopsy: null }; }",
     "kills": ["TEST-D735-DBT-SAMPLED-ALONE"]},
    {"id": "M-E-D4", "required": True, "title": "E-4 unknown partial counted as a full view", "file": "emr-image/manifest.ts",
     "find": "    f.partial === 'no' && presentation !== 'processing'",
     "replace": "    f.partial !== 'yes' && f.partial !== 'conflict' && presentation !== 'processing'",
     "kills": ["TEST-D735-PARTIAL-ABSENT"]},
    {"id": "M-E-D5", "required": True, "title": "E-5 an unverified target accepted as a synthetic 2D source (E-R2-02)", "file": "emr-image/manifest.ts",
     "find": "  if (target.c.result.status !== 'verified' || !SOURCE_CLASSES.includes(target.c.result.baseClass)) return",
     "replace": "  if (target.c.result.status === 'verified' && !SOURCE_CLASSES.includes(target.c.result.baseClass)) return",
     "kills": ["TEST-D735-SOURCE-SC-UNVERIFIED"]},
    {"id": "M-E-D6", "required": True, "title": "E-6 classification and rule version left out of the manifest digest", "file": "emr-image/manifest.ts",
     "find": "JSON.stringify({ formatVersion: 1, classificationRule, studyUid, managingInstitution, patient, objects, decoders, viewer })",
     "replace": "JSON.stringify({ formatVersion: 1, studyUid, managingInstitution, patient, objects: objects.map(o => ({ ...o, mammography: null })), decoders, viewer })",
     "kills": ["TEST-E-02 manifest_sources A4"]},
    {"id": "M-E-D7", "required": True, "title": "E-7 thick geometry alone named a slab without an aggregation pair", "file": "emr-image/manifest.ts",
     "find": "  if (g.t > 3 && g.t + tol(g.d) >= g.d && SLAB_PAIRS.includes(`${v4}|${technique}`))",
     "replace": "  if (g.t > 3 && g.t + tol(g.d) >= g.d)",
     "kills": ["TEST-D735-DBT-THICKNESS-ALONE"]},
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


def run_against(source_dir, test_path=TEST):
    # A mutated copy of the test file runs from outside the tree, so the API directory is named explicitly.
    env = dict(os.environ, KIN_EMR_E_SOURCE_DIR=str(source_dir), KIN_EMR_E_API_DIR=str(ROOT / "api"))
    try:
        out = subprocess.run([node(), "--test", "--test-reporter=tap", str(test_path)], cwd=ROOT, env=env, capture_output=True, timeout=TIMEOUT)
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
        # Collection is compared as a set: node reports cases in registration order, the declaration groups them by TEST-ID.
        matches = sorted(results) == sorted(cases) and not any(r.get("duplicate") for r in results.values())
        baseline_ok = code == 0 and matches and all(r["ok"] for r in results.values())
        report["baseline"] = {"exit": code, "collected": list(results), "passed": sum(r["ok"] for r in results.values()),
                              "failed": [n for n, r in results.items() if not r["ok"]], "matches_declared": matches}
        if not baseline_ok:
            report["baseline"]["stderr"] = stderr[-4000:]
            print("BASELINE FAILED", json.dumps(report["baseline"], ensure_ascii=False))
            ok = False
        for mutant in MUTANTS:
            entry = {key: mutant[key] for key in ("id", "required", "title", "file", "kills")}
            entry["target"] = mutant.get("target", "src")
            if entry["target"] == "test":
                # The defect lives in the test harness: mutate a copy of the test file, run it on the unmutated product copy.
                work = Path(temporary) / mutant["id"] / "test"
                work.mkdir(parents=True)
                path, source_dir = work / TEST.name, base
                shutil.copy2(TEST, path)
                shutil.copy2(TEST.parent / "rule-cases.json", work / "rule-cases.json")
                test_path = path
            else:
                work = Path(temporary) / mutant["id"] / "src"
                copy_tree(work)
                path, source_dir, test_path = work / mutant["file"], work, TEST
            original = path.read_text(encoding="utf-8")
            count = original.count(mutant["find"])
            if count != 1:
                entry.update(status="harness-error", reason=f"anchor occurs {count} times")
                report["mutants"].append(entry)
                ok = False
                print(mutant["id"], "harness-error", entry["reason"])
                continue
            path.write_text(original.replace(mutant["find"], mutant["replace"]), encoding="utf-8")
            code, text, stderr = run_against(source_dir, test_path)
            results = parse_tap(text) if code is not None else {}
            collected = list(results)
            collected_all = sorted(collected) == sorted(cases) and not any(r.get("duplicate") for r in results.values())
            named = [n for n in collected if any(n == prefix or n.startswith(prefix + " ") for prefix in mutant["kills"])]
            killed_by = [n for n in named if not results[n]["ok"] and results[n]["code"] == "ERR_ASSERTION"]
            others = [n for n, r in results.items() if not r["ok"] and n not in killed_by]
            entry.update(exit=code, collected_all=collected_all, named_cases=named,
                         killed_by=[{"case": n, "assertion": results[n]["message"][:6]} for n in killed_by],
                         other_failures=[{"case": n, "code": results[n]["code"], "assertion": results[n]["message"][:3]} for n in others])
            if code is None:
                entry.update(status="harness-error", reason="timeout")
            elif not collected_all or not named:
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
