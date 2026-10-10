"""D837 CI selection: D717 subject is local-only; all other cases remain mandatory.

Case dependencies come from cases.json and sample identities from samples.json.
This changes execution scope only, never the product or a test's assertions (D73).
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
REASON = "D717 local-only sample"
sys.path.insert(0, str(HERE.parent))
from archive_download import download


def hosted():
    scope = os.environ.get("KIN_MG_CI_SCOPE", "local")
    if scope not in ("local", "hosted"):
        raise ValueError("unknown MG CI scope: " + scope)
    return scope == "hosted" or os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"


def manifest():
    return json.loads((HERE / "samples.json").read_text(encoding="utf-8"))


def d717_subject(row):
    return row["collection"] == "EA1141" and Path(row["path"]).parts[1] == "EA1141-4339969"


def d717_approved(spec, row):
    return spec["sets"][row["set"]].get("approval", "").split(" ", 1)[0] == "D717"


def local_only(row, spec=None):
    spec = manifest() if spec is None else spec
    # Folder aliases must not make the same series or bytes eligible for hosting.
    protected = [r for r in spec["used"] if d717_approved(spec, r) or d717_subject(r)]
    return (d717_approved(spec, row) or d717_subject(row) or
            any(Path(row["path"]).parent.name == Path(r["path"]).parent.name or
                row["sha256"] == r["sha256"] for r in protected))


def validate_manifest(spec):
    protected = [r for r in spec["used"] if d717_approved(spec, r)]
    if not protected:
        raise ValueError("D717 local-only approval has no samples; refusing MG sample processing")
    for row in spec["used"]:
        approved = d717_approved(spec, row)
        if approved != d717_subject(row):
            raise ValueError("D717 approval/subject mismatch: " + row["id"])
        if not approved and local_only(row, spec):
            raise ValueError("D717 series UID or sha256 reused outside local-only set: " + row["id"])


def selection(name):
    spec = manifest()
    validate_manifest(spec)
    body = next(s for s in json.loads((HERE / "cases.json").read_text(encoding="utf-8"))["suites"] if s["id"] == name)
    rows = {r["id"]: r for r in spec["used"]}
    selected, excluded = [], []
    for case in body["cases"]:
        restricted = [sid for sid in case.get("samples", []) if local_only(rows[sid], spec)]
        if hosted() and restricted:
            excluded.append({"case": body["class"] + "." + case["name"], "reason": REASON, "samples": restricted})
        else:
            selected.append(case["name"])
    return body, selected, excluded


def sample_target(spec, row):
    root = spec["sets"][row["set"]]
    return Path(os.environ.get(root["root_env"]) or root["default_root"]) / row["path"]


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def plan():
    spec = manifest()
    validate_manifest(spec)
    rows = [r for r in spec["used"] if not local_only(r, spec)]
    excluded = [r for r in spec["used"] if local_only(r, spec)]
    report = {"hosted_excluded": {"series": len({Path(r["path"]).parent.name for r in excluded}),
              "bytes": sum(r["bytes"] for r in excluded), "reason": REASON},
              "hosted_download_bytes": sum(r["bytes"] for r in rows),
              "not_run": [entry for name in ("dicom", "dom") for entry in selection(name)[2]]}
    print(json.dumps(report, indent=2))
    if os.environ.get("GITHUB_OUTPUT"):
        hashes = "\n".join(sorted(r["sha256"] for r in rows))
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("cache-key=mg-public-v1-" + hashlib.sha256(hashes.encode("ascii")).hexdigest() + "\n")
            # Cache only manifest-named permitted files, never a root that could hold local-only bytes.
            output.write("cache-paths<<MG_CACHE_PATHS\n")
            output.write("\n".join(str(sample_target(spec, r)) for r in rows) + "\nMG_CACHE_PATHS\n")
    summary("selection", report["not_run"])


def fetch():
    spec = manifest()
    # Validate every row before network, cache reads or filesystem writes.
    validate_manifest(spec)
    rows = [r for r in spec["used"] if not (hosted() and local_only(r, spec))]
    groups = {}
    for row in rows:
        target = sample_target(spec, row)
        if target.is_file():
            if digest(target) != row["sha256"]:
                raise RuntimeError("cached sample hash mismatch: " + row["id"])
            print("verified", row["id"], row["sha256"], flush=True)
            continue
        if local_only(row, spec):
            raise RuntimeError("local sample must already be present: " + row["id"])
        target.parent.mkdir(parents=True, exist_ok=True)
        groups.setdefault(Path(row["path"]).parent.name, []).append((row, target))
    for series, requested in groups.items():
        url = "https://services.cancerimagingarchive.net/nbia-api/services/v1/getImage?SeriesInstanceUID=" + series
        print("fetch", url, flush=True)
        with tempfile.TemporaryFile() as archive:
            download(url, archive)
            pending = {row["sha256"]: (row, target) for row, target in requested}
            with zipfile.ZipFile(archive) as zipped:
                for member in zipped.infolist():
                    if member.is_dir() or member.file_size not in {r["bytes"] for r, _ in pending.values()}:
                        continue
                    h = hashlib.sha256()
                    with zipped.open(member) as stream:
                        for block in iter(lambda: stream.read(1024 * 1024), b""):
                            h.update(block)
                    match = pending.pop(h.hexdigest(), None)
                    if match:
                        row, target = match
                        with zipped.open(member) as source, target.open("xb") as output:
                            shutil.copyfileobj(source, output, 1024 * 1024)
                        if digest(target) != row["sha256"]:
                            raise RuntimeError("downloaded sample hash mismatch: " + row["id"])
                        print("verified", row["id"], row["sha256"], flush=True)
                    if not pending:
                        break
            if pending:
                raise RuntimeError("public source lacks pinned samples: " + ", ".join(r["id"] for r, _ in pending.values()))
    print("all selected public samples verified:", len(rows))


def summary(name, not_run, counts=""):
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write("### MG " + name + "\n\n" + counts + "\n")
            for entry in not_run:
                output.write("- NOT RUN `" + entry["case"] + "`: " + entry["reason"] + "\n")


def run_suite(name):
    body, expected, excluded = selection(name)
    spec = importlib.util.spec_from_file_location("part1_mg_" + name, HERE / Path(body["file"]).name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def flatten(suite):
        for test in suite:
            if isinstance(test, unittest.TestSuite):
                yield from flatten(test)
            else:
                yield test

    collected = list(flatten(unittest.defaultTestLoader.loadTestsFromModule(module)))
    actual = [(t.__class__.__name__, t._testMethodName) for t in collected]
    all_declared = [(body["class"], c["name"]) for c in body["cases"]]
    if sorted(actual) != sorted(all_declared):
        raise RuntimeError("declared != collected: " + repr({"declared": all_declared, "collected": actual}))
    selected = [t for t in collected if t._testMethodName in expected]
    want = [(body["class"], method) for method in expected]
    actual = [(t.__class__.__name__, t._testMethodName) for t in selected]
    if sorted(actual) != sorted(want):
        raise RuntimeError("selected declaration != collected")
    # Publish the policy exclusions before execution so they survive a later failure.
    print(json.dumps({"declared": want, "collected": actual, "not_run": excluded}, indent=2), flush=True)
    summary(name, excluded, "Declared/collected: %d/%d; policy not run: %d." % (len(want), len(actual), len(excluded)))
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(selected))
    unexpected = [{"case": test.id(), "reason": reason} for test, reason in result.skipped]
    report = {"declared": len(want), "collected": actual, "run": result.testsRun, "not_run": excluded,
              "unexpected_not_run": unexpected, "errors": [t.id() for t, _ in result.errors],
              "failures": [t.id() for t, _ in result.failures]}
    print(json.dumps(report, indent=2))
    summary(name + " results", unexpected, "Run: %d; errors: %d; failures: %d; unexpected not run: %d." %
            (result.testsRun, len(result.errors), len(result.failures), len(unexpected)))
    return 0 if result.wasSuccessful() and not result.skipped and result.testsRun == len(want) else 1


if __name__ == "__main__":
    action = sys.argv[1]
    if action == "plan":
        plan()
    elif action == "fetch":
        fetch()
    elif action in ("dicom", "dom"):
        sys.exit(run_suite(action))
    else:
        raise SystemExit("unknown MG CI action: " + action)
