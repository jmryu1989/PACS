# coding: utf-8
"""S9-U4b part (c) round 2, D1489: mutants of the original-download grant (consult u4b-download-grant DG-M01..M08).

Each mutant is a one-off copy of api/src with one change in auth.guard.ts or study-transfer-local.service.ts, compiled by
tests/service_test_loader.cjs (KIN_TEST_API_SRC selects the copy) and run against the one server case written for it in
tests/study_transfer_local_server_test.cjs, whose Nest application puts the product's own AuthGuard in front (harness
realGuard). A mutant is killed only when that case fails on an assertion (ERR_ASSERTION, no TypeError, no load error)
within the bound; anything else is NOT PROVEN. The unchanged copy (baseline) must pass every named case first. The
product tree is never written; the copies live under the --out directory and are removed after each run.

DG-M09 (a raw request line back in the proxy log) needs the real nginx: tests/proxy_grant_log_test.py runs it as its
DetectorSelfCheck (and the hosted DG-T05 run checks the logs); DG-M10 (the UI's stale grant answer) is
tests/study_transfer_local_mutants.py's "late-grant-clicked". DG-M11 (U4C-05) is this file's.

Also the WORKLIST-SPLIT-UID hand-over mutants of S9-U4b: M-WSU-19 (the download routes' source check skipped) the same
way against S9U4-B81, and M-WSU-17 (the identity case's registration oracle back to list visibility), a copy of
tests/invariants_live.py first on the import path, killed only by a failing assertion of the pure S9U4RegisterTests.

Usage: python -B tests/original_download_grant_mutants.py --out <new directory>   (node on PATH or NODE=...)
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GUARD, SERVICE = "auth.guard.ts", "study-transfer-local.service.ts"

# (id, file, old, new, case)
MUTANTS = [
    ("DG-M01-any-route-takes-a-grant", GUARD,
     "this.reflector.get(PATH_METADATA, ctx.getHandler())) === ARCHIVE_ROUTE_KEY && this.transfer.archiveGrantPath(req, path);",
     "this.reflector.get(PATH_METADATA, ctx.getHandler())) !== null;", "S9U4-B78"),
    ("DG-M02-not-consumed", SERVICE,
     "          download.archiveGrantUses.push({ ...bound, admittedAt: admission!.admittedAt, consumedAt: now.toISOString(), attemptId: attempt.attemptId });\n"
     "          download.activeArchiveGrant = null;\n          checkDownloadRow({ ...op, status: 'sending', download });\n",
     "", "S9U4-B79"),
    ("DG-M03-no-session-binding", SERVICE,
     "    if (grant.sessionRef !== sessionRef) throw authRefusal(", "    if (false) throw authRefusal(", "S9U4-B78"),
    ("DG-M04-no-current-original-check", SERVICE,
     "      await this.unchangedOriginals(uid, stored);\n      await this.storageRead(() => this.currentRights(c, 'download', uid, req), downloadStorage);\n    } catch (failure) { throw await refused(failure); }",
     "      await this.storageRead(() => this.currentRights(c, 'download', uid, req), downloadStorage);\n    } catch (failure) { throw await refused(failure); }",
     "S9U4-B80"),
    ("DG-M05-expiry-boundary", SERVICE,
     "if (now.getTime() >= Date.parse(active.expiresAt)) throw error(410", "if (now.getTime() > Date.parse(active.expiresAt)) throw error(410", "S9U4-B79"),
    ("DG-M06-no-recheck-under-the-lock", SERVICE,
     "          if (download.schemaVersion === 2 && download.archiveGrantUses.some((u: any) => u.grantId === admission.grantId))\n"
     "            throw error(409, 'DOWNLOAD_GRANT_CONSUMED', TRANSFER_MESSAGES.grantConsumed);\n",
     "", "S9U4-B79"),
    ("DG-M07-wrong-header-rescued", GUARD,
     "        const native = grant && this.auth.binding(req, sid) === 'missing';\n        if (!bootstrap && !native) this.auth.requireBinding(req, sid);",
     "        const native = grant;\n        if (!bootstrap && !native) this.auth.requireBinding(req, sid);", "S9U4-B78"),
    ("DG-M08-sent-without-the-finish", SERVICE,
     "const state = t.stop === 'fenced' || !exact ? 'unconfirmed' : t.stop === 'aborted' || !finished ? 'incomplete' : 'sent';",
     "const state = t.stop === 'fenced' ? 'unconfirmed' : 'sent';", "S9U4-B79"),
    # U4C-05: the rights read again inside the consume transaction, under its lock - without it a right lost after the
    # preflight still consumes the grant and opens an attempt with its intent.
    ("DG-M11-no-rights-under-the-consume-lock", SERVICE,
     "          if (process.env.AUTH_REQUIRED !== 'false') await this.memberRightsNow(tx, c, 'download');\n"
     "          await this.ownStudyLocked(tx, op.studyUid, c);\n",
     "", "S9U4-B84"),
    # WORKLIST-SPLIT-UID hand-over (spec M-WSU-19): the download routes' current source check skipped - the replay and
    # the start of an operation prepared before its Study UID became split would go on.
    ("M-WSU-19-download-source-check-skipped", SERVICE,
     "    this.studyAccess.assertUnsplitSource(c, uid);\n", "", "S9U4-B81"),
]
CASES = sorted({m[4] for m in MUTANTS})
# The hand-over's oracle mutant (spec M-WSU-17): the identity case's registration check back to list visibility. It is a
# test-code mutant of tests/invariants_live.py, killed by the pure S9U4RegisterTests (the list answers 409 or never shows
# a split UID while the product's StudyState row exists); the copy is put first on the import path.
ORACLE_MUTANTS = [
    ("M-WSU-17-registration-oracle-is-the-list", "invariants_live.py",
     "        if rows == expected:\n            return answers\n",
     "        if answers[-1].status == 200 and any(s.get(\"uid\") == uid for s in (answers[-1].body or {}).get(\"studies\", [])):\n"
     "            return answers\n", "S9U4RegisterTests"),
]


def run_case(node, src, cases, log):
    env = {**os.environ, "KIN_TEST_API_SRC": str(Path(src).resolve())}
    pattern = "|".join(cases)
    start = time.monotonic()
    done = subprocess.run([node, "--test", f"--test-name-pattern={pattern}", "tests/study_transfer_local_server_test.cjs"], cwd=ROOT,
                          env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900)
    text = done.stdout + done.stderr
    log.write_text(text, encoding="utf-8")
    return done.returncode, text, round(time.monotonic() - start)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    out = Path(parser.parse_args().out)
    out.mkdir(parents=True, exist_ok=False)
    node = os.environ.get("NODE", "node")
    base = out / "baseline" / "src"
    shutil.copytree(ROOT / "api/src", base)
    code, text, seconds = run_case(node, base, CASES, out / "baseline.log")
    passed = re.search(r"^# pass (\d+)", text, re.M)
    baseline_ok = code == 0 and passed is not None and int(passed.group(1)) == len(CASES)
    print(json.dumps({"baseline": baseline_ok, "cases": CASES, "seconds": seconds}), flush=True)
    shutil.rmtree(out / "baseline")
    if not baseline_ok:
        print("DG mutants: baseline failed, no kill claimed", flush=True)
        return 1
    killed = 0
    for label, file, old, new, case in MUTANTS:
        src = out / label / "src"
        shutil.copytree(ROOT / "api/src", src)
        target = src / file
        source = target.read_text(encoding="utf-8")
        if source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        target.write_text(source.replace(old, new, 1), encoding="utf-8", newline="\n")
        code, text, seconds = run_case(node, src, [case], out / f"{label}.log")
        failed = re.search(r"^# fail (\d+)", text, re.M)
        kill = code != 0 and failed is not None and int(failed.group(1)) >= 1 and "ERR_ASSERTION" in text and "TypeError" not in text
        killed += kill
        print(json.dumps({"mutant": label, "case": case, "exit": code, "seconds": seconds, "killed": kill}), flush=True)
        shutil.rmtree(out / label)
    print(f"DG mutants killed by their named server case: {killed}/{len(MUTANTS)} (DG-M09 in proxy_grant_log_test, DG-M10 in the UI mutants)", flush=True)
    oracle_killed = 0
    for label, file, old, new, case in [("baseline-oracle", "invariants_live.py", "", "", "S9U4RegisterTests")] + ORACLE_MUTANTS:
        copy = out / label / "tests"
        copy.mkdir(parents=True)
        source = (ROOT / "tests" / file).read_text(encoding="utf-8")
        if old and source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        (copy / file).write_text(source.replace(old, new, 1) if old else source, encoding="utf-8", newline="\n")
        env = {**os.environ, "PYTHONPATH": os.pathsep.join([str(copy.resolve()), str(ROOT / "tests")])}
        done = subprocess.run([sys.executable, "-B", "-m", "unittest", f"invariants_live.{case}"], cwd=ROOT, env=env,
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        text = done.stdout + done.stderr
        (out / f"{label}.log").write_text(text, encoding="utf-8")
        shutil.rmtree(out / label)
        if not old:
            if done.returncode != 0 or not re.search(r"^OK", text, re.M):
                print("oracle baseline failed, no kill claimed", flush=True)
                return 1
            continue
        kill = done.returncode != 0 and "FAIL: test_" in text and "ERROR: " not in text and "AssertionError" in text
        oracle_killed += kill
        print(json.dumps({"mutant": label, "case": case, "exit": done.returncode, "killed": kill}), flush=True)
    print(f"hand-over oracle mutants killed by {ORACLE_MUTANTS[0][4]}: {oracle_killed}/{len(ORACLE_MUTANTS)}", flush=True)
    return 0 if killed == len(MUTANTS) and oracle_killed == len(ORACLE_MUTANTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
