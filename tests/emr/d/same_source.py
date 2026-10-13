# coding: utf-8
"""The last step of .github/workflows/emr-d.yml: every record of this run is of TARGET_SHA, hashed exactly what its command
consumed as it is in TARGET_SHA, was not changed while the command ran and kept its raw logs; the image is of TARGET_SHA.

The reference is never the record itself (R5-21, DR4-06): what a record hashed before and after its command is compared
with TARGET_SHA's own git objects (`git ls-tree` and `git cat-file` of the commit, never the working tree) - every file of
a requested or declared tree and every declared file - and an input an earlier step of the same run produced
(emr/units/d.json ci.produced_inputs: the image identity) with that file as it is now. The declaration itself is read from
TARGET_SHA. The run fails (exit 1) on any of:
  * a declared step without a record (unrun), an unfinished or malformed record, or a record no step declares;
  * a record of another commit (git head before or after its command);
  * an input not hashed as present, without a valid SHA-256 and LF SHA-256, changed, added or removed between before and
    after, absent from TARGET_SHA or different from it; a file of TARGET_SHA in a declared input the record did not hash;
  * a log whose bytes are no longer the recorded ones; a non-zero exit;
  * collected cases (emr/units/d.json ci.outputs: node's junit report, the mutant drivers' JSON summary, the test runner's
    EXACT_TESTS/PLAN_RESULT lines) that are not exactly the declared ones - a skip is listed as a skip, never as a pass;
  * an image identity other than `<image id> TARGET_SHA`.
Every step's verdict (pass / fail / unrun / invalid) with its exit codes, collected cases and problems is written to
tmp/emr-d-ci/same-source.json and printed. Run from the checkout root with TARGET_SHA set. stdlib and git only; every tool
output is read with an installed parser (json, xml.etree) in the format that tool documents.
"""
import hashlib
import json
import os
import pathlib
import posixpath
import re
import subprocess
import sys
import xml.etree.ElementTree as ElementTree
import time
import signal

RUNS = pathlib.Path("tmp/emr-d-ci")
DECLARATION = "emr/units/d.json"
HEX = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"[0-9a-f]{40}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")


def recorded_execution(command, cwd, env, folder, timeout, selected):
    """Shared recorder owns raw streams; the caller retains selection and interruption state outside disposable copies."""
    folder = pathlib.Path(folder).resolve()
    folder.parent.mkdir(parents=True, exist_ok=True)
    argv = [sys.executable, "-B", str(pathlib.Path(__file__).resolve().parents[3] / "scripts/record-run.py"),
            "--run-dir", str(folder), "--cwd", str(cwd), "--tree", "api/src", "--tree", "tests/emr/d",
            "--file", "api/tsconfig.json", "--file", "api/package-lock.json", "--", *command]
    started = time.monotonic()
    status, code, error = "completed", None, None
    with (folder.parent / (folder.name + "-recorder.stdout.log")).open("wb") as out, (folder.parent / (folder.name + "-recorder.stderr.log")).open("wb") as err:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err,
                                start_new_session=os.name != "nt")
        try:
            code = proc.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
            status, code, error = "interrupted", 124, type(exc).__name__
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
    folder.mkdir(exist_ok=True)
    stdout = (folder / "stdout.log").read_text(encoding="utf-8", errors="replace") if (folder / "stdout.log").exists() else ""
    stderr = (folder / "stderr.log").read_text(encoding="utf-8", errors="replace") if (folder / "stderr.log").exists() else ""
    # This result never upgrades an unfinished recorder to completed.
    result = {"status": status, "exit": code, "recorder_process_exit": proc.returncode,
              "exit_note": "124 denotes wrapper timeout/interruption; unfinished child exit is unknown" if status != "completed" else None,
              "error": error, "selected": selected,
              "duration_seconds": time.monotonic() - started, "record": str(folder / "run.json")}
    (folder / "execution.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return code, stdout, stderr


class GitError(Exception):
    pass


def git(*args, data=None):
    done = subprocess.run(["git", *args], input=data, capture_output=True)
    if done.returncode:
        raise GitError("git %s: %s" % (args[0], done.stderr.decode("utf-8", "replace").strip()))
    return done.stdout


def lf_sha256(data):
    # What scripts/record-run.py records as lf_sha256: the bytes with CRLF turned into LF.
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def normal(name):
    return posixpath.normpath(str(name).replace("\\", "/"))


class Commit:
    """The files of one commit, read from git's object store."""

    def __init__(self, sha):
        self.sha, self.blobs, self.cache, self.raw_cache = sha, {}, {}, {}
        listing = git("ls-tree", "-r", "-z", "--full-tree", "--format=%(objecttype) %(objectname) %(path)", sha)
        for entry in filter(None, listing.split(b"\0")):
            kind, oid, name = entry.decode("utf-8").split(" ", 2)
            if kind == "blob":
                self.blobs[name] = oid

    def under(self, tree):
        return sorted(name for name in self.blobs if name.startswith(tree + "/"))

    def read(self, name):
        return git("cat-file", "blob", self.blobs[name])

    def digests(self, names):
        """The LF SHA-256 of each named file of the commit, read in one `git cat-file --batch`."""
        wanted = sorted({self.blobs[name] for name in names} - set(self.cache))
        if wanted:
            out, at = git("cat-file", "--batch", data="".join(oid + "\n" for oid in wanted).encode("ascii")), 0
            for oid in wanted:
                end = out.index(b"\n", at)
                header = out[at:end].decode("ascii").split()
                if len(header) != 3 or header[0] != oid:
                    raise GitError("cat-file answered %r for %s" % (header, oid))
                size = int(header[2])
                original = out[end + 1:end + 1 + size]
                lf = original.replace(b"\r\n", b"\n")
                self.cache[oid] = lf_sha256(original)
                self.raw_cache[oid] = {hashlib.sha256(b).hexdigest() for b in (original, lf, lf.replace(b"\n", b"\r\n"))}
                at = end + 1 + size + 1
        return {name: self.cache[self.blobs[name]] for name in names}


def file_sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def snapshot(items, phase, bad):
    """name -> (sha256, lf_sha256) of what a record hashed as present, and the trees it requested; any other entry is a problem."""
    files, trees = {}, set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("requested"), str):
            bad.append("%s: an entry that is not a recorder entry: %r" % (phase, item))
            continue
        name = normal(item["requested"])
        if item.get("tree") is not None:
            trees.add(normal(item["tree"]))
        digest, lf = item.get("sha256"), item.get("lf_sha256")
        if item.get("status") != "present":
            bad.append("%s %s: %s, not hashed as present" % (name, phase, item.get("status")))
        elif not (isinstance(digest, str) and HEX.fullmatch(digest) and isinstance(lf, str) and HEX.fullmatch(lf)):
            bad.append("%s %s: no valid SHA-256 (%r, %r)" % (name, phase, digest, lf))
        elif files.setdefault(name, (digest, lf)) != (digest, lf):
            bad.append("%s %s: hashed twice with different results" % (name, phase))
    return files, trees


def junit(path, section):
    cases = {"passed": [], "failed": [], "skipped": []}
    for case in ElementTree.parse(path).getroot().iter("testcase"):
        state = ("failed" if case.find("failure") is not None or case.find("error") is not None
                 else "skipped" if case.find("skipped") is not None else "passed")
        cases[state].append(case.get("name"))
    names, bad = sorted(sum(cases.values(), [])), []
    if "cases" in section:
        if names != sorted(section["cases"]):
            bad.append("collected cases are not the declared ones: missing %s, not declared %s"
                       % (sorted(set(section["cases"]) - set(names)), sorted(set(names) - set(section["cases"]))))
        if sorted(cases["skipped"]) != sorted(section.get("skipped", [])):
            bad.append("declared cases skipped, not passed: %s" % cases["skipped"])
    else:
        bad.append("no independent exact case declaration")
    return cases, bad, bool(cases["failed"])


def mutant_summary(path, section):
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    mutants, equivalents = data["mutants"], data.get("equivalents", [])
    cases = {"killed": [m["id"] for m in mutants if m["killed"] is True], "survived": [m["id"] for m in mutants if m["killed"] is not True],
             "equivalents_holding": [e["id"] for e in equivalents if e["holds"] is True],
             "equivalents_failing": [e["id"] for e in equivalents if e["holds"] is not True], "not_run": data.get("not_run", [])}
    bad = []
    if data["result"]["killed"] != data["result"]["total"] or data["result"]["total"] != len(mutants):
        bad.append("the summary does not count its own mutants: %r" % data["result"])
    if section is not None:
        if data.get("not_run", []) != section.get("not_run", []):
            bad.append("not_run differs from the explicit exclusions")
        if [m["id"] for m in mutants] != section["ids"]:
            bad.append("mutants run %s, declared %s" % ([m["id"] for m in mutants], section["ids"]))
        if [e["id"] for e in equivalents] != section.get("equivalents", []):
            bad.append("equivalents run %s, declared %s" % ([e["id"] for e in equivalents], section.get("equivalents", [])))
    return cases, bad, bool(cases["survived"] or cases["equivalents_failing"])


def runner_lines(path, section):
    exact, plans, images = [], [], []
    for line in pathlib.Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("EXACT_TESTS "):
            exact.append(json.loads(line[len("EXACT_TESTS "):]))
        elif line.startswith("PLAN_RESULT "):
            plans.append(json.loads(line[len("PLAN_RESULT "):]))
        elif line.startswith("EMR_D_USED_IMAGE "):
            images.append(json.loads(line[len("EMR_D_USED_IMAGE "):]))
    if len(exact) != 1 or len(plans) != 1:
        return None, ["%d EXACT_TESTS and %d PLAN_RESULT lines, one of each expected" % (len(exact), len(plans))], False
    parts = [test.rsplit(".", 2)[-2:] for test in exact[0]]
    cases, bad = {"collected": exact[0], "plan": plans[0]}, []
    identity = (RUNS / "image-identity.txt").read_text(encoding="utf-8").split()
    if len(identity) != 2 or images != [{"id": identity[0], "revision": identity[1]}]:
        bad.append("live used image does not match verified image identity: %r" % images)
    cases["used_image"] = images
    if sorted(method for _, method in parts) != sorted(section["cases"]) or any(cls != section["class"] for cls, _ in parts):
        bad.append("collected %s, declared %s.%s" % (exact[0], section["class"], section["cases"]))
    return cases, bad, plans[0].get("status") != "passed"


def collected(output, stdout, declaration):
    kind = output.get("kind")
    if kind == "exit":
        return None, [], False
    try:
        if kind == "tsc":
            text = pathlib.Path(stdout).read_text(encoding="utf-8")
            metrics = dict(re.findall(r"^(Files|Types|Check time|Total time):\s+([0-9.]+)s?\s*$", text, re.M))
            files = [normal(line.strip()) for line in text.splitlines() if line.strip().endswith(".ts")]
            expected = sorted(str(p.resolve()).replace("\\", "/") for p in pathlib.Path("api/src").rglob("*.ts"))
            missing = sorted(set(expected) - set(files))
            bad = []
            if set(metrics) != {"Files", "Types", "Check time", "Total time"} or not files or missing:
                bad.append("typecheck did not report a complete TypeScript check: missing files %s, metrics %s" % (missing, metrics))
            return {"files": files, "metrics": metrics}, bad, False
        if kind == "junit":
            return junit(stdout, declaration["cases"][output["declared"]])
        if kind == "mutants":
            return mutant_summary(stdout, declaration["mutants"][output["declared"]] if "declared" in output else None)
        if kind == "run-tests":
            return runner_lines(stdout, declaration["cases"][output["declared"]])
    except (OSError, ValueError, KeyError, TypeError, ElementTree.ParseError) as error:
        return None, ["the output of the command cannot be read as %s: %s: %s" % (kind, type(error).__name__, error)], False
    return None, ["ci.outputs declares no known kind: %r" % output], False


def check_step(step, needs, produced, output, declaration, commit):
    folder, sha = RUNS / step, commit.sha
    result = {"verdict": None, "exit_code": None, "recorder_exit_code": None, "collected": None, "problems": []}
    bad = result["problems"]
    try:
        run = json.loads((folder / "run.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        result.update(verdict="unrun", problems=["no record: the step did not run"])
        return result
    except (OSError, ValueError) as error:
        result.update(verdict="invalid", problems=["the record cannot be read: %s" % error])
        return result
    complete = (isinstance(run, dict) and run.get("schema_version") == 1 and run.get("status") == "completed"
                and all(isinstance(run.get(k), int) and not isinstance(run.get(k), bool) for k in ("exit_code", "recorder_exit_code"))
                and all(isinstance(run.get(k), list) for k in ("files_before", "files_after", "log_files")))
    if not complete:
        result.update(verdict="invalid", problems=["not a completed run: status %r" % (run.get("status") if isinstance(run, dict) else run)])
        return result
    result.update(exit_code=run["exit_code"], recorder_exit_code=run["recorder_exit_code"])
    if output.get("kind") == "tsc":
        # This is the public CLI identity, not a substring search of a shell
        # command. Bash has already produced argv; options are judged by the
        # compiler's file list, diagnostics and exit, not by a second parser.
        command = run.get("command")
        valid_cli = (isinstance(command, list) and len(command) >= 2
                     and all(isinstance(word, str) for word in command)
                     and normal(command[0]).rsplit("/", 1)[-1].lower() in ("node", "node.exe", "nodejs", "nodejs.exe")
                     and pathlib.Path(command[1]).resolve() == pathlib.Path("api/node_modules/typescript/bin/tsc").resolve())
        if not valid_cli:
            bad.append("typecheck: record does not identify the installed TypeScript CLI")
    if run.get("git_head_before") != sha or run.get("git_head_after") != sha:
        bad.append("a record of another commit (%s before, %s after), not of %s" % (run.get("git_head_before"), run.get("git_head_after"), sha))
    before, trees = snapshot(run["files_before"], "before", bad)
    after, _ = snapshot(run["files_after"], "after", bad)
    for name in sorted(set(before) | set(after)):
        if name not in after:
            bad.append("%s: gone or unhashed after the command" % name)
        elif name not in before:
            bad.append("%s: appeared during the command" % name)
        elif before[name] != after[name]:
            bad.append("%s: changed while the command ran" % name)
    tracked = [name for name in sorted(before) if name not in produced]
    digests = commit.digests([name for name in tracked if name in commit.blobs])
    for name in tracked:
        if name not in commit.blobs:
            bad.append("%s: not a file of %s (added, untracked or produced by the run)" % (name, sha))
        elif digests[name] != before[name][1]:
            bad.append("%s: differs from %s" % (name, sha))
        else:
            # Raw hashes must describe the commit's bytes or a permitted whole
            # LF/CRLF conversion, not merely accompany a plausible LF hash.
            allowed = commit.raw_cache[commit.blobs[name]]
            if before[name][0] not in allowed:
                bad.append("%s: raw hash differs from TARGET_SHA under the LF/CRLF policy" % name)
    for name in sorted(produced & set(before)):
        if not pathlib.Path(name).is_file() or lf_sha256(pathlib.Path(name).read_bytes()) != before[name][1]:
            bad.append("%s: not the file the run produced (changed or removed since)" % name)
    for tree in sorted(trees | {normal(need) for need in needs}):
        if tree in produced:
            continue
        if tree in commit.blobs:
            if tree not in before:
                bad.append("%s: a declared input the record did not hash" % tree)
            continue
        members = commit.under(tree)
        if not members:
            bad.append("%s: neither a file nor a tree of %s" % (tree, sha))
        bad.extend("%s: a file of %s in %s the record did not hash" % (name, sha, tree) for name in members if name not in before)
    # The final checkout is another boundary: a valid historical record alone
    # cannot certify files changed after the child returned.
    final_names = set(tracked)
    for need in sorted(trees | set(map(normal, needs))):
        if need in produced:
            continue
        members = commit.under(need)
        if members:
            actual = {p.as_posix() for p in pathlib.Path(need).rglob("*") if p.is_file()}
            expected = set(members)
            bad.extend("%s: final checkout path added under %s" % (p, need) for p in sorted(actual - expected))
            bad.extend("%s: final checkout path removed under %s" % (p, need) for p in sorted(expected - actual))
            final_names.update(expected)
        else:
            final_names.add(need)
    final_digests = commit.digests([n for n in final_names if n in commit.blobs])
    for name in sorted(final_names):
        path = pathlib.Path(name)
        if not path.is_file() or name not in final_digests or lf_sha256(path.read_bytes()) != final_digests[name]:
            bad.append("%s: final checkout differs from TARGET_SHA" % name)
    bad.extend("%s: a declared input the record did not hash" % need for need in sorted(produced & set(map(normal, needs))) if need not in before)
    logs = {item.get("requested"): item for item in run["log_files"] if isinstance(item, dict)}
    for name in ("stdout.log", "stderr.log"):
        item = logs.get(name) or {}
        if item.get("status") != "present" or not isinstance(item.get("sha256"), str) or not HEX.fullmatch(item["sha256"]):
            bad.append("%s: the log is not recorded with its hash" % name)
        elif not (folder / name).is_file() or file_sha256(folder / name) != item["sha256"]:
            bad.append("%s: not the recorded bytes (changed or removed after the run)" % name)
    cases, problems, failed = collected(output, folder / "stdout.log", declaration)
    result["collected"] = cases
    bad.extend(problems)
    if run["exit_code"] != 0 or run["recorder_exit_code"] != 0:
        failed = True
        bad.append("the command exited %d (recorder %d)" % (run["exit_code"], run["recorder_exit_code"]))
    elif failed:
        bad.append("the command exited 0 but its collected cases show a failure")
    result["verdict"] = "pass" if not bad else "fail" if failed else "invalid"
    return result


def main():
    sha = os.environ.get("TARGET_SHA", "")
    report = {"target_sha": sha, "steps": {}, "image_identity": None, "problems": []}
    problems = report["problems"]
    try:
        if not COMMIT.fullmatch(sha):
            raise GitError("TARGET_SHA is not a full lowercase 40-character commit SHA")
        commit = Commit(sha)
        if git("rev-parse", "HEAD").decode().strip() != sha:
            problems.append("final checkout HEAD differs from TARGET_SHA")
        declaration = json.loads(commit.read(DECLARATION).decode("utf-8"))
    except (GitError, KeyError, ValueError) as error:
        problems.append("no declaration of %r: %s" % (sha, error))
        commit = declaration = None
    if declaration is not None:
        ci = declaration["ci"]
        declared, produced, outputs = ci["recorded_inputs"], {normal(p) for p in ci["produced_inputs"]}, ci["outputs"]
        if sorted(outputs) != sorted(declared):
            problems.append("ci.outputs names %s, ci.recorded_inputs %s" % (sorted(outputs), sorted(declared)))
        for record in sorted(RUNS.glob("*/run.json")):
            if record.parent.name not in declared:
                problems.append("%s: a record no step declares" % record)
        for step in sorted(declared):
            report["steps"][step] = check_step(step, declared[step], produced, outputs.get(step, {}), declaration, commit)
    identity = RUNS / "image-identity.txt"
    words = identity.read_text(encoding="utf-8").split() if identity.is_file() else None
    report["image_identity"] = words
    if not (words and len(words) == 2 and IMAGE_ID.fullmatch(words[0]) and words[1] == sha):
        problems.append("%s: not the image of %s (%r)" % (identity, sha, words))
    passed = not problems and bool(report["steps"]) and all(s["verdict"] == "pass" for s in report["steps"].values())
    report["verdict"] = "pass" if passed else "fail"
    RUNS.mkdir(parents=True, exist_ok=True)
    (RUNS / "same-source.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = problems + ["%s: %s%s" % (step, s["verdict"], "".join("\n  " + p for p in s["problems"])) for step, s in sorted(report["steps"].items())]
    print("\n".join(lines))
    print("source = image = evidence = %s (%d records)" % (sha, len(report["steps"])) if passed else "evidence of %s refused" % sha)
    return 0 if passed else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
