# coding: utf-8
"""TEST-MG-MUTANTS (E-MG): the twelve required mutants M1-M12 of the order and M13-M23 of the round-2
review fixes (D730), each killed by a named behaviour test.

A mutant that is merely declared is not a kill. This runner breaks the product on purpose - in a COPY
under a temporary directory - and requires the named case to fail on its own named assertion:

  * the product tree is never edited: every mutant is a copy reached through KIN_MG_MODEL /
    KIN_MG_VIEWER, and the source hashes before and after the run must be equal;
  * every anchor must occur exactly once in its file, or that is a failure, not a survivor;
  * the unmutated copies must first pass the three suites through the same overrides;
  * a kill needs a non-zero child exit AND the named case reported as failed (never only ERROR) AND an
    assertion error AND the mutant's own expect text in the output AND no harness crash;
  * the mutant table must agree with tests/part1/mg/cases.json (case and expect of every mutant).

Anchors are product source text by necessity (a mutant is a source edit); the tests themselves never
read product source. stdlib only; it launches the suites as child processes.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCES = {"model": ROOT / "worklist-v0" / "hpacs-lite" / "mammography-model.js",
           "viewer": ROOT / "worklist-v0" / "hpacs-lite" / "viewer-mammography.js"}
ENV_KEY = {"model": "KIN_MG_MODEL", "viewer": "KIN_MG_VIEWER"}
SUITES = {
    "model": {"file": HERE / "model_test.cjs"},
    "dicom": {"file": HERE / "dicom_contract_test.py", "class": "MammographyDicomContractTest"},
    "dom": {"file": HERE / "viewer_dom_test.py", "class": "MammographyViewerDOMTest"},
}
# A harness crash (import/syntax failure, a browser timeout) is never a kill.
CRASH_MARKERS = ("ModuleNotFoundError", "ReferenceError:", "SyntaxError:", "Cannot find module", "playwright._impl._errors")

MUTANTS = [
    {"id": "M1", "file": "model", "suite": "model", "case": "MG01-reject",
     "title": "DERIVED Image Type is taken as a synthetic 2D view",
     "expect": "MG01 M1: DERIVED pixel data is not evidence of a synthetic view",
     "old": "    out.kind='conventional';out.basis=v3===null?'digital-mammography-legacy-null-v3':'digital-mammography';",
     "new": "    if(type[0]==='DERIVED'){out.kind='generated2d';return 'device-synthetic-2d';}out.kind='conventional';out.basis=v3===null?'digital-mammography-legacy-null-v3':'digital-mammography';"},
    {"id": "M2", "file": "model", "suite": "model", "case": "MG01-reject",
     "title": "a series description alone classifies the object",
     "expect": "MG01 M2: a series description alone never confirms a synthetic view",
     "old": "    if(['0008103E','00181030','00082111'].some(tag=>LEGACY_HINT.test(text(item,tag)))){issue('possible-legacy-generated-2d');return null;}",
     "new": "    if(['0008103E','00181030','00082111'].some(tag=>LEGACY_HINT.test(text(item,tag)))){out.kind='generated2d';return 'device-synthetic-2d';}"},
    {"id": "M3", "file": "model", "suite": "model", "case": "MG02-allow",
     "title": "the last stored slice is left out of the frame index",
     "expect": "MG02 M3: the first and the last stored slice are both reachable",
     "old": "    for(let frame=1;frame<=declared;frame++){",
     "new": "    for(let frame=1;frame<declared;frame++){"},
    {"id": "M4", "file": "model", "suite": "model", "case": "MG02-allow",
     "title": "after a position sort the display index is reported as the stored frame",
     "expect": "MG02 M4: a sorted entry still names the stored frame that lies at its position",
     "old": "    const entries=order.map((s,i)=>({sop,frame:s.frame,index:i+1,total:declared,",
     "new": "    const entries=order.map((s,i)=>({sop,frame:i+1,index:i+1,total:declared,"},
    {"id": "M5", "file": "viewer", "suite": "dom", "case": "test_mg03_dom_same_length_dbts_are_not_linked_and_missing_positions_stay_unverified",
     "title": "scrolling one DBT forces the same slice number on every other DBT",
     "expect": "MG03 M5: the same slice number is not forced on the other DBT",
     "old": "      event.preventDefault();go(cell,target);",
     "new": "      event.preventDefault();go(cell,target);for(const other of cells)if(other!==cell&&other.object&&other.index.entries.length>1)go(other,target);"},
    {"id": "M6", "file": "model", "suite": "dom", "case": "test_mg05_dom_real_pixels_fit_one_to_one_and_pan_reach_all_tissue",
     "title": "right-breast images are mirrored by side instead of by Patient Orientation",
     "expect": "MG05 M6: chest wall side on screen for",
     "old": "    const flipH=c.laterality==='R'?row.includes('A'):row.includes('P');",
     "new": "    const flipH=c.laterality==='R';"},
    {"id": "M7", "file": "model", "suite": "dom", "case": "test_mg05_dom_real_pixels_fit_one_to_one_and_pan_reach_all_tissue",
     "title": "Fit fills the viewport and crops part of the acquired area",
     "expect": "MG05 M7: Fit shows the whole acquired",
     "old": "    return Math.min(view.width/image.columns,view.height/image.rows);",
     "new": "    return Math.max(view.width/image.columns,view.height/image.rows);"},
    {"id": "M8", "file": "model", "suite": "model", "case": "MG04-reject",
     "title": "the prior's patient identity is no longer checked",
     "expect": "MG04 M8: a prior of another patient is refused even on the same date",
     "old": "      else if(!samePatient(cur.patient,pri.patient)){priorStatus='refused';priorReason='prior-different-patient';}",
     "new": "      else if(false){priorStatus='refused';priorReason='prior-different-patient';}"},
    {"id": "M9", "file": "model", "suite": "model", "case": "MG06-reject",
     "title": "a ticket is checked by image key instead of request sequence (A->B->A)",
     "expect": "MG06 M9: returning to the same image does not revive the first request",
     "old": "return !ended&&!!now&&t.generation===generation&&now.seq===t.seq;",
     "new": "return !ended&&!!now&&t.generation===generation&&now.key===t.key;"},
    {"id": "M10", "file": "viewer", "suite": "dom", "case": "test_mg06_dom_dispose_layout_switch_and_account_change_stop_late_results",
     "title": "a retired or disposed cell's viewport is still drawn into",
     "expect": "MG06 M10: a released viewport is never drawn into again",
     "old": "    const usable=cell=>!ended&&!cell.disposed;",
     "new": "    const usable=cell=>true;"},
    {"id": "M11", "file": "viewer", "suite": "dom", "case": "test_mg04_dom_other_patient_duplicate_and_partial_switch_are_never_applied",
     "title": "a layout change in which some images failed is committed",
     "expect": "MG04 M11: a partly failed change is not applied",
     "old": "      if(shown.some(ok=>!ok)){",
     "new": "      if(shown.every(ok=>!ok)){"},
    {"id": "M12", "file": "viewer", "suite": "dom", "case": "test_mg02_dom_prefetch_wrong_frame_and_wrong_total_never_count_as_displayed",
     "title": "a prefetched frame is reported and counted as displayed",
     "expect": "MG02 M12: a prefetched frame is not a displayed frame",
     "old": "        const pending=load(cell,entry,'prefetch',c.signal).then(image=>{if(usable(cell))remember(key,image);return image;},",
     "new": "        const pending=load(cell,entry,'prefetch',c.signal).then(image=>{if(usable(cell)){remember(key,image);cell.coverage.mark(entry);emit('displayed',record(cell,entry,'display'));}return image;},"},
    # Round 2 (D730): one mutant per fix, each re-introducing the defect the review found.
    {"id": "M13", "file": "viewer", "suite": "dom", "case": "test_mg06_dom_latest_intent_wins_over_delayed_seek_and_scroll_bursts",
     "title": "F01: a request back to the slice on screen does not supersede the delayed one",
     "expect": "MG06 M13: a request back to the current slice cancels the delayed one",
     "old": "      const ticket=gate.begin(cell.id,entry.sop+'#'+entry.frame);cell.intent=target;",
     "new": "      if(target===cell.position&&cell.shown&&!force)return;const ticket=gate.begin(cell.id,entry.sop+'#'+entry.frame);cell.intent=target;"},
    {"id": "M14", "file": "viewer", "suite": "dom", "case": "test_mg06_dom_superseded_renders_are_neither_painted_nor_reported",
     "title": "F01: no sequence check after the render completes",
     "expect": "MG06 M14: a render superseded after its paint is not reported as the current display",
     "old": "        if(!current){relabel(cell);return false;}",
     "new": "        if(false){relabel(cell);return false;}"},
    {"id": "M15", "file": "viewer", "suite": "dom", "case": "test_mg06_dom_superseded_renders_are_neither_painted_nor_reported",
     "title": "F01: the renderer's pre-paint check always answers current",
     "expect": "MG06 M15: a render superseded before its paint is not painted",
     "old": "try{result=await cell.handle.render(image,display(cell,image,entry),{current:latest});}catch(_){result=null;}",
     "new": "try{result=await cell.handle.render(image,display(cell,image,entry),{current:()=>true});}catch(_){result=null;}"},
    {"id": "M16", "file": "viewer", "suite": "dom", "case": "test_mg06_dom_latest_intent_wins_over_delayed_seek_and_scroll_bursts",
     "title": "F01: a key step is taken from the slice on screen, not from the latest intent",
     "expect": "MG06 M16: a scroll burst moves from the latest intent",
     "old": "      if(event.key in moves)target=cell.intent+moves[event.key];",
     "new": "      if(event.key in moves)target=cell.position+moves[event.key];"},
    {"id": "M17", "file": "model", "suite": "model", "case": "MG01-reject",
     "title": "F02: Image Type and Frame Type are not compared",
     "expect": "MG01 M17: Image Type and Frame Type must agree before any kind is trusted",
     "old": "      if(normalizedType(typeOf(t[0],'00089007'))!==imageType){issue('image-frame-type-conflict');return null;}",
     "new": "      if(false){issue('image-frame-type-conflict');return null;}"},
    {"id": "M18", "file": "model", "suite": "model", "case": "MG01-reject",
     "title": "F02: the device exception no longer names its manufacturer and model",
     "expect": "MG01 M18: a one-frame tomosynthesis GENERATED_2D object is synthetic 2D only as the named device exception",
     "old": "    return HOLOGIC_MANUFACTURERS.includes(manufacturer)&&model===HOLOGIC_MODEL&&profile.software.some(s=>software.includes(s));",
     "new": "    return true;"},
    {"id": "M19", "file": "model", "suite": "model", "case": "MG04-reject",
     "title": "F03: only the Partial View flag marks a partial acquisition",
     "expect": "MG04 M19: a partial view is never matched as the full standard view",
     "old": "    const evidence=codeItems.length>0||!!description;",
     "new": "    const evidence=false;"},
    {"id": "M20", "file": "model", "suite": "model", "case": "MG02-reject",
     "title": "F04: the frame-count limit is not applied before classification",
     "expect": "MG02 M20: a frame count outside the limit is refused before any per-frame work",
     "old": "    if(!Number.isInteger(declared)||declared<1||declared>MAX_FRAMES){issue('frame-count-invalid');return null;}",
     "new": "    if(!Number.isInteger(declared)||declared<1){issue('frame-count-invalid');return null;}"},
    {"id": "M21", "file": "model", "suite": "model", "case": "MG02-reject",
     "title": "F05: Dimension Index Values are not cross-checked",
     "expect": "MG02 M21: dimension index values that contradict the positions never report complete",
     "old": "    dimensionCheck(item,fg,stored,known).forEach(issue);",
     "new": "    void dimensionCheck;"},
    {"id": "M22", "file": "model", "suite": "model", "case": "MG05-allow",
     "title": "F06: every frame takes the first frame's orientation",
     "expect": "MG05 M22: the orientation of the requested frame decides its flips",
     "old": "    const plane=macro(fg,frame,'00209116'),iop=(plane?numbers(plane,'00200037',6):null)||numbers(item,'00200037',6);",
     "new": "    const plane=macro(fg,1,'00209116'),iop=(plane?numbers(plane,'00200037',6):null)||numbers(item,'00200037',6);"},
    {"id": "M23", "file": "model", "suite": "model", "case": "MG01-allow",
     "title": "ruling 2: Volumetric Properties alone decides slices vs slab",
     "expect": "MG01 M23: slices vs slab follow thickness and contiguous positions, not Volumetric Properties alone",
     "old": "    const tol=lengthTolerance(g.spacing),contiguous=Math.abs(g.thickness-g.spacing)<=tol;",
     "new": "    if(volumetric==='VOLUME'){out.kind='dbt';out.sliceKind='slices';return 'dbt-slices';}if(volumetric==='SAMPLED'){out.kind='dbt';out.sliceKind='slab';return 'dbt-slab';}const tol=lengthTolerance(g.spacing),contiguous=Math.abs(g.thickness-g.spacing)<=tol;"},
]


def node():
    found = os.environ.get("KIN_NODE") or shutil.which("node")
    if not found:
        raise SystemExit("node is required")
    return found


def command(suite, case):
    spec = SUITES[suite]
    if suite == "model":
        pattern = ["--test-name-pattern=^" + re.escape(case).replace("\\-", "-")] if case else []
        return [node(), "--test", "--test-reporter=spec"] + pattern + [str(spec["file"])]
    return [sys.executable, "-B", str(spec["file"])] + ([spec["class"] + "." + case] if case else [])


def run(suite, case, overrides, timeout):
    env = dict(os.environ)
    for key, path in overrides.items():
        env[ENV_KEY[key]] = str(path)
    env["PYTHONIOENCODING"] = "utf-8"
    done = subprocess.run(command(suite, case), cwd=str(ROOT), env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)
    return done, (done.stdout or "") + (done.stderr or "")


def ran_count(suite, output):
    if suite == "model":
        found = re.search(r"^\S*\s*tests (\d+)", output, re.MULTILINE)
        failed = re.search(r"^\S*\s*fail (\d+)", output, re.MULTILINE)
        return (int(found.group(1)) if found else None), (int(failed.group(1)) if failed else None)
    found = re.search(r"Ran (\d+) tests?", output)
    return (int(found.group(1)) if found else None), (0 if re.search(r"^OK$", output, re.MULTILINE) else None)


def named_failure(suite, output, case):
    if suite == "model":
        named = [l.strip() for l in output.splitlines() if l.strip().startswith("✖ " + case)]
        assertion = [l.strip() for l in output.splitlines() if "AssertionError" in l]
    else:
        named = [l.strip() for l in output.splitlines() if l.startswith("FAIL: " + case + " ")]
        blocks = [b for b in re.split(r"^={10,}$", output, flags=re.MULTILINE) if ("FAIL: " + case + " ") in b]
        assertion = [l.strip() for b in blocks for l in b.splitlines() if l.startswith("AssertionError")]
    return (named[0] if named else ""), (assertion[0][:400] if assertion else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", help="Directory for the per-mutant logs and summary.json")
    parser.add_argument("--timeout", type=int, default=900, help="Seconds per child run")
    parser.add_argument("--only", nargs="*", help="Run only these mutant ids (baseline still runs)")
    parser.add_argument("--anchors-only", action="store_true", help="Check anchors, cases and expects, then stop")
    args = parser.parse_args()

    source = {name: path.read_text(encoding="utf-8") for name, path in SOURCES.items()}
    before = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in SOURCES.items()}
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    declared = cases["mutants"]
    problems = []
    if {m["id"] for m in MUTANTS} != set(declared) or len(MUTANTS) != 23:
        problems.append("mutant ids differ from cases.json")
    tests_text = {suite: spec["file"].read_text(encoding="utf-8") for suite, spec in SUITES.items()}
    seen = set()
    for m in MUTANTS:
        d = declared.get(m["id"], {})
        if (d.get("suite"), d.get("case"), d.get("expect"), d.get("file")) != (m["suite"], m["case"], m["expect"], m["file"]):
            problems.append("%s differs from cases.json" % m["id"])
        found = source[m["file"]].count(m["old"])
        print("anchor %-3s file=%-6s occurrences=%d" % (m["id"], m["file"], found))
        if found != 1:
            problems.append("%s anchor occurs %d times" % (m["id"], found))
        if m["new"] in source[m["file"]]:
            problems.append("%s mutation is already the shipped text" % m["id"])
        if m["expect"] not in tests_text[m["suite"]]:
            problems.append("%s expect text is in no assertion of %s" % (m["id"], m["suite"]))
        if m["suite"] == "model":
            if "test('" + m["case"] not in tests_text["model"]:
                problems.append("%s names no model case" % m["id"])
        elif "def %s(" % m["case"] not in tests_text[m["suite"]]:
            problems.append("%s names no %s case" % (m["id"], m["suite"]))
        if m["expect"] in seen:
            problems.append("%s reuses an expect text" % m["id"])
        seen.add(m["expect"])
    for name in sorted(before):
        print("%s sha256 %s" % (SOURCES[name].name, before[name]))
    if problems:
        for p in problems:
            print("ANCHOR FAILURE:", p)
        return 1
    if args.anchors_only:
        print("anchors ok (no run requested)")
        return 0

    out = pathlib.Path(args.out) if args.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    scratch = pathlib.Path(tempfile.mkdtemp(prefix="kin-mg-mutants-"))
    results = []
    try:
        clean = {}
        for name, path in SOURCES.items():
            clean[name] = scratch / ("baseline-" + path.name)
            shutil.copyfile(path, clean[name])
        expected = {s["id"]: s["expected"] for s in cases["suites"]}
        for suite in SUITES:
            done, output = run(suite, None, clean, args.timeout)
            if out:
                (out / ("baseline-%s.log" % suite)).write_text(output, encoding="utf-8")
            total, failed = ran_count(suite, output)
            ok = done.returncode == 0 and total == expected[suite] and failed == 0
            print("BASELINE %-5s exit=%d ran=%s expected=%d ok=%s" % (suite, done.returncode, total, expected[suite], ok))
            results.append({"id": "BASELINE-" + suite, "child_exit": done.returncode, "ran": total, "expected": expected[suite], "ok": ok})
            if not ok:
                print(output[-3000:])
                print("BASELINE FAILED - refusing to report kills")
                return 1
        for m in MUTANTS:
            if args.only and m["id"] not in args.only:
                continue
            broken = scratch / ("%s-%s" % (m["id"], SOURCES[m["file"]].name))
            text = source[m["file"]].replace(m["old"], m["new"])
            if text == source[m["file"]]:
                raise AssertionError(m["id"])
            broken.write_text(text, encoding="utf-8")
            overrides = dict(clean)
            overrides[m["file"]] = broken
            done, output = run(m["suite"], m["case"], overrides, args.timeout)
            if out:
                (out / ("%s.log" % m["id"])).write_text(output, encoding="utf-8")
            named, assertion = named_failure(m["suite"], output, m["case"])
            crashed = any(marker in output for marker in CRASH_MARKERS)
            matched = m["expect"] in output
            killed = done.returncode != 0 and bool(named) and bool(assertion) and matched and not crashed
            print("%-3s suite=%-5s exit=%d named=%s expect=%s crash=%s killed=%s" % (m["id"], m["suite"], done.returncode, bool(named), matched, crashed, killed))
            print("      " + (assertion or named or "no failure reported"))
            results.append({"id": m["id"], "title": m["title"], "file": str(SOURCES[m["file"]].relative_to(ROOT)).replace("\\", "/"),
                            "suite": m["suite"], "case": m["case"], "child_exit": done.returncode, "named_failure": named,
                            "assertion": assertion, "expect": m["expect"], "expect_matched": matched, "harness_crash": crashed,
                            "killed": killed, "mutant_sha256": hashlib.sha256(broken.read_bytes()).hexdigest()})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    after = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in SOURCES.items()}
    unchanged = after == before
    survivors = [r["id"] for r in results if r["id"].startswith("M") and not r["killed"]]
    summary = {"source_sha256_before": before, "source_sha256_after": after, "source_unchanged": unchanged,
               "results": results, "survivors": survivors}
    if out:
        (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print("sources unchanged=%s" % unchanged)
    if survivors:
        print("SURVIVORS: " + ", ".join(survivors))
        return 1
    if not unchanged:
        print("SOURCE CHANGED - refusing to report a clean run")
        return 1
    print("all %d mutants killed" % len([r for r in results if r["id"].startswith("M")]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
