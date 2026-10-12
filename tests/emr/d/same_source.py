# coding: utf-8
"""The last step of .github/workflows/emr-d.yml: every record of this run and the image are of TARGET_SHA, and each
declared record hashed what its command consumes (source = image = evidence).

DR2-07: a record whose git head before or after its command is not TARGET_SHA, or an image whose revision label is
another commit, fails the run. DR3-05: emr/units/d.json `ci.recorded_inputs` names, for each recording step (its step
`id`, also its run directory under tmp/emr-d-ci), the inputs that step's command consumes; a record that is missing, or
that did not hash one of them as present (the file itself, or a hashed tree holding it), fails the run - an input left
out of a recorder is caught on the record itself. Run from the checkout root with TARGET_SHA set. stdlib only.
"""
import json
import os
import pathlib
import sys

RUNS = pathlib.Path("tmp/emr-d-ci")


def hashed(run, need):
    """Whether the record hashed `need` as present: the file itself, or any file of a requested tree that is or holds it."""
    for item in run.get("files_before") or []:
        if item.get("status") != "present":
            continue
        tree = item.get("tree")
        if (tree is None and item.get("requested") == need) or (tree is not None and (need == tree or need.startswith(tree + "/"))):
            return True
    return False


def main():
    sha, bad = os.environ["TARGET_SHA"], []
    declared = json.loads(pathlib.Path("emr/units/d.json").read_text(encoding="utf-8"))["ci"]["recorded_inputs"]
    records = sorted(RUNS.glob("*/run.json"))
    for record in records:
        run = json.loads(record.read_text(encoding="utf-8"))
        if run.get("git_head_before") != sha or run.get("git_head_after") != sha:
            bad.append("%s: not a record of %s" % (record, sha))
    for step, inputs in sorted(declared.items()):
        record = RUNS / step / "run.json"
        if not record.is_file():
            bad.append("%s: no record" % record)
            continue
        run = json.loads(record.read_text(encoding="utf-8"))
        bad.extend("%s: %s not hashed" % (record, need) for need in inputs if not hashed(run, need))
    identity = RUNS / "image-identity.txt"
    if not identity.is_file() or identity.read_text(encoding="utf-8").split()[1:] != [sha]:
        bad.append("%s: not the image of %s" % (identity, sha))
    print("\n".join(bad) if bad else "source = image = evidence = %s (%d records, %d declared)" % (sha, len(records), len(declared)))
    return 1 if bad or not records else 0


if __name__ == "__main__":
    sys.exit(main())
