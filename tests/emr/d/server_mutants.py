# coding: utf-8
"""TEST-D round 3 server mutants: each reverts one round-3 fix of Astra's findings on bfddc3d (DR2-01..08) or removes the
signing-time check Astra's own mutant AM10 removed, in a COPY of the source, and runs tests/emr/d/server_test.cjs there.

REQ-EMR-01/03/04/05/07/10/17 -> RISK-D-01..04 -> TEST-D-01..04 server cases (tests/emr/d/server_test.cjs).

A mutant counts as killed only when ALL of these hold (the rules of tests/emr/d/mutants.py):
  * the unmutated tree passes every server case (here, in the repository) and the unmutated copy passes every named case;
  * the anchor occurs exactly once in its file (a missing or repeated anchor is a failure, not a survivor);
  * the child exits non-zero, the named case is reported `not ok` in the TAP stream with failureType testCodeFailure and
    code ERR_ASSERTION, and the mutant's own expect text is inside that case's failure block;
  * no crash marker (syntax/reference/module errors) appears: an import or process failure is never a kill.

The copy is a temporary root with api/src, the declaration, the workflow, the Dockerfile and tests/emr/d; api/node_modules
is linked (a junction on Windows), never copied, and the link is removed before the copy is. The source tree is never
modified. stdlib only. Usage: python -B tests/emr/d/server_mutants.py [--anchors-only] [--out PATH]; node from KIN_NODE or PATH.
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

ROOT = pathlib.Path(__file__).resolve().parents[3]
TEST = ROOT / "tests" / "emr" / "d" / "server_test.cjs"
CRASH_MARKERS = ("SyntaxError:", "ReferenceError:", "Cannot find module", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE")
COPIED = ["api/src", "api/prisma/migrations", "api/tsconfig.json", "api/Dockerfile", "emr/units/d.json", ".github/workflows/emr-d.yml",
          "tests/emr/d/server_test.cjs", "tests/emr/d/device.cjs", "tests/emr/d/live.py"]

CASE = {
    "recovery": "TEST-D-04 atomic_retry server: a recovery releases the original it took over - after a transient store failure the next recovery commits it once, and an original still executing is never fenced",
    "allocation": "TEST-D-04 atomic_retry server: an allocation request keeps its identity - the same request before and after its first commit, at any unit revision; another meaning under its request ID is another request",
    "provide": "TEST-D-03 read_scope server: a response serving many units hands out no text before every provision naming exactly its versions is durable; a projection naming another author or recipient is refused",
    "adoption": "TEST-D-02 versions_and_sr server: a manual SR adoption counts only once its access event is durable - a ledger that cannot confirm it leaves it unconfirmed, and the same event confirms it later",
    "workflow": "EMR-D workflow: the checkout, the image (label and tag), the live run and every record name one source SHA, and each record hashes what its command consumes",
    "sources": "TEST-D-02 versions_and_sr server: what a finding incorporates is a fixed reference to its source's exact version - planned, signed, stored and recovered alike; a navigation link is none",
    "composed": "TEST-D-04 atomic_retry server: the runtime is composed once with every port and refuses a second composition",
    "signature": "TEST-D-04 atomic_retry server: an absent, altered, held, inactive, offline or foreign-request signature is refused before any commit",
}
MUTANTS = [
    {"id": "M-D-R3-DR2-01", "finding": "DR2-01", "title": "an adoption without a durable ledger receipt is reported confirmed",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    if (stored.fact.confirmed) return stored.fact;\n    await this.parts.ledger.append(",
     "new": "    return stored.fact;\n    await this.parts.ledger.append(",
     "case": CASE["adoption"], "expect": "DR2-01: an adoption the ledger cannot make durable is never reported confirmed"},
    {"id": "M-D-R3-DR2-02", "finding": "DR2-02", "title": "the served projection's author and recipient are not compared with the unit's",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    if (!parties) return;\n", "new": "    return;\n",
     "case": CASE["provide"], "expect": "DR2-02: a projection naming another author is refused"},
    {"id": "M-D-R3-DR2-03", "finding": "DR2-03", "title": "a response is sent after only its first provision is durable",
     "file": "api/src/emr-clinical/records.ts",
     "old": "  for (const event of events) receipts.push(", "new": "  for (const event of events.slice(0, 1)) receipts.push(",
     "case": CASE["provide"], "expect": "70 versions: two provisions (64 + 6), both durable before the text is sent"},
    {"id": "M-D-R3-DR2-04", "finding": "DR2-04", "title": "an allocation's request revision is compared with D's unit revision again",
     "file": "api/src/emr-clinical/contract.ts",
     "old": "text: 'none', revisionField: null, act: 'additional-entry',", "new": "text: 'none', revisionField: 'revision', act: 'additional-entry',",
     "case": CASE["allocation"], "expect": "DR2-04: an allocation carrying its row"},
    {"id": "M-D-R3-DR2-05", "finding": "DR2-05", "title": "a recovered original drops the sources its text incorporates",
     "file": "api/src/emr-clinical/store.ts",
     "old": "  const attachments = await readClinicalSources(db, refs);", "new": "  const attachments = await readClinicalSources(db, []);",
     "case": CASE["sources"], "expect": "DR2-05: the recovered original resolves the same sources again and commits"},
    {"id": "M-D-R3-DR2-06", "finding": "DR2-06", "title": "a recovery keeps the original it took over after it ends",
     "file": "api/src/emr-clinical/runtime.ts",
     "old": "    } finally { this.store.release(acquired); }", "new": "    } finally { /* M-D-R3-DR2-06 */ }",
     "case": CASE["recovery"], "expect": "the failed recovery released the original it took over"},
    {"id": "M-D-R3-DR2-07a", "finding": "DR2-07", "title": "the image is labelled and tagged with the workflow ref, not the checked-out source",
     "file": ".github/workflows/emr-d.yml",
     "old": "--build-arg \"VCS_REF=${{ env.TARGET_SHA }}\" -t \"kin-emrd-ci:${{ env.TARGET_SHA }}\"",
     "new": "--build-arg \"VCS_REF=${{ github.sha }}\" -t \"kin-emrd-ci:${{ github.sha }}\"",
     "case": CASE["workflow"], "expect": "only TARGET_SHA names the source"},
    {"id": "M-D-R3-DR2-07b", "finding": "DR2-07", "title": "the image record leaves out a file the build copies",
     "file": ".github/workflows/emr-d.yml",
     "old": "--file api/tsconfig.json --file api/nest-cli.json -- docker build", "new": "--file api/nest-cli.json -- docker build",
     "case": CASE["workflow"], "expect": "the image record hashes api/tsconfig.json"},
    {"id": "M-D-R3-DR2-08", "finding": "DR2-08", "title": "a later binding replaces the port bound at server start",
     "file": "api/src/emr-clinical/services.ts",
     "old": "  if (bound) throw new ContractError('ClinicalRuntimeAlreadyComposed');\n", "new": "",
     # The composition needs A's adapters composed with D's sources first, which the sources case does in file order.
     "case": CASE["composed"], "with": [CASE["sources"]], "expect": "DR2-08: no later binding replaces the port bound at server start"},
    {"id": "M-D-R3-AM10", "finding": "AM10 (Astra's own mutant)", "title": "a signature whose signing time C cannot verify is accepted",
     "file": "api/src/emr-clinical/signing.ts",
     "old": "if (verified.time.status !== 'verified') refuse('SignatureTimeUnverified');",
     "new": "if (false && verified.time.status !== 'verified') refuse('SignatureTimeUnverified');",
     "case": CASE["signature"], "expect": "a reboot between anchor and signing"},
]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_lf(path):
    # Anchors are written with LF; a Windows checkout may hold CRLF. Compare and mutate on LF text.
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def check_anchors():
    return [f"{m['id']}: anchor occurs {read_lf(ROOT / m['file']).count(m['old'])} times in {m['file']}"
            for m in MUTANTS if read_lf(ROOT / m["file"]).count(m["old"]) != 1]


def node_binary():
    node = os.environ.get("KIN_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("node not found (set KIN_NODE)")
    return node


def link(target, at):
    if os.name == "nt":
        import _winapi
        _winapi.CreateJunction(str(target), str(at))
    else:
        os.symlink(target, at, target_is_directory=True)


class Copy:
    """A temporary root holding a copy of what server_test.cjs reads, with api/node_modules linked."""

    def __init__(self, mutant=None):
        self.mutant, self.hashes = mutant, {}

    def __enter__(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="emr-d-r3-mutant-"))
        for item in COPIED:
            source, target = ROOT / item, self.root / item
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copyfile(source, target)
        self.modules = self.root / "api" / "node_modules"
        link(ROOT / "api" / "node_modules", self.modules)
        if self.mutant:
            target = self.root / self.mutant["file"]
            text = read_lf(target)
            mutated = text.replace(self.mutant["old"], self.mutant["new"], 1)
            target.write_bytes(mutated.encode("utf-8"))
            self.hashes = {"source": sha(text.encode("utf-8")), "mutated": sha(mutated.encode("utf-8"))}
        return self

    def __exit__(self, *_):
        # The link goes first and alone: removing it never touches the linked node_modules.
        if os.name == "nt":
            os.rmdir(self.modules)
        else:
            os.unlink(self.modules)
        shutil.rmtree(self.root)


def run(node, test, cases=None):
    env = {**os.environ, "NODE_OPTIONS": ""}
    env.pop("KIN_EMR_D_ROOT", None)
    env.pop("KIN_EMR_D_API_SRC", None)
    selection = ["--test-name-pattern=^(" + "|".join(re.escape(case) for case in cases) + ")$"] if cases else []
    proc = subprocess.run([node, "--test", "--test-reporter=tap", *selection, str(test)], cwd=test.parents[3], env=env, capture_output=True, timeout=900)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


TAP_LINE = re.compile(r"^(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO).*)?$")


def tap_cases(stdout):
    lines, cases, i = stdout.splitlines(), {}, 0
    while i < len(lines):
        match = TAP_LINE.match(lines[i])
        i += 1
        if not match:
            continue
        block = []
        if i < len(lines) and lines[i].strip() == "---":
            i += 1
            while i < len(lines) and lines[i].strip() != "...":
                block.append(lines[i])
                i += 1
            i += 1
        cases[match.group(3)] = (match.group(1), match.group(4), block)
    return cases


def judge(mutant, code, stdout, stderr):
    entry = tap_cases(stdout).get(mutant["case"])
    block = "\n".join(entry[2]) if entry else ""
    reasons = []
    if code == 0:
        reasons.append("child exited 0")
    if entry is None:
        reasons.append("named case not reported")
    elif entry[0] != "not ok" or entry[1]:
        reasons.append(f"named case reported {entry[0]} {entry[1] or ''}".strip())
    if "failureType: 'testCodeFailure'" not in block:
        reasons.append("no testCodeFailure in the case block")
    if "code: 'ERR_ASSERTION'" not in block:
        reasons.append("no ERR_ASSERTION in the case block")
    if mutant["expect"] not in block:
        reasons.append("expect text not in the case block")
    crash = [marker for marker in CRASH_MARKERS if marker in stdout or marker in stderr]
    if crash:
        reasons.append("crash markers: " + ", ".join(crash))
    return {"killed": not reasons, "reasons": reasons, "case_block": entry[2] if entry else []}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--anchors-only", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()
    problems = check_anchors()
    summary = {"sources": {m["file"]: sha((ROOT / m["file"]).read_bytes()) for m in MUTANTS}, "anchors": problems or "ok", "baseline": None,
               "control": None, "mutants": []}
    if problems or args.anchors_only:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 1 if problems else 0
    node = node_binary()
    summary["node"] = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    code, stdout, stderr = run(node, TEST)
    cases = tap_cases(stdout)
    failing = sorted(name for name, (status, skip, _) in cases.items() if status != "ok" or skip)
    summary["baseline"] = {"exit": code, "collected": len(cases), "not_passing": failing}
    named = sorted({m["case"] for m in MUTANTS})
    with Copy() as copy:
        code2, stdout2, stderr2 = run(node, copy.root / "tests/emr/d/server_test.cjs", named)
    control = tap_cases(stdout2)
    summary["control"] = {"exit": code2, "passed": sorted(n for n, (s, k, _) in control.items() if s == "ok" and not k)}
    if code or failing or code2 or sorted(summary["control"]["passed"]) != named:
        summary["baseline"]["stderr_tail"], summary["control"]["stderr_tail"] = stderr[-2000:], stderr2[-2000:]
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 1
    for mutant in MUTANTS:
        with Copy(mutant) as copy:
            code, stdout, stderr = run(node, copy.root / "tests/emr/d/server_test.cjs", [mutant["case"], *mutant.get("with", [])])
        summary["mutants"].append({**{k: mutant[k] for k in ("id", "finding", "title", "file", "case", "expect")}, "exit": code,
                                   **copy.hashes, **judge(mutant, code, stdout, stderr), "stdout": stdout, "stderr": stderr})
    summary["result"] = {"killed": sum(m["killed"] for m in summary["mutants"]), "total": len(MUTANTS)}
    text = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        pathlib.Path(args.out).write_text(text, encoding="utf-8")
    print(text)
    return 0 if all(m["killed"] for m in summary["mutants"]) else 1


if __name__ == "__main__":
    sys.exit(main())
