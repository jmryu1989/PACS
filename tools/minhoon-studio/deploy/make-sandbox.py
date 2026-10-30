#!/usr/bin/env python3
"""Create the studio sandbox: a fresh git repository holding the product tree at one main SHA (tag studio-base),
plus the studio's editable mock data in studio-mock/. The chat edits this copy; the commander collects its branch.

  python make-sandbox.py --archive base.tar --sha <sha> --out /opt/minhoon-studio/sandbox
  python make-sandbox.py --repo <product checkout> --sha <sha> --out <dir>      (runs git archive itself)

It never touches the product checkout beyond `git archive`, and refuses to overwrite an existing sandbox.
"""
import argparse
import datetime
import io
import os
import shutil
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "..", "sandbox-seed", "studio-mock")
IDENTITY = ["-c", "user.name=Minhoon Studio", "-c", "user.email=studio@minhoon-studio.local", "-c", "commit.gpgsign=false"]


def git(out, *args):
    subprocess.run(["git", *IDENTITY, *args], cwd=out, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--archive", help="tar produced by `git archive <sha>`")
    source.add_argument("--repo", help="product checkout to run `git archive` in")
    parser.add_argument("--sha", required=True, help="the main SHA the archive holds (recorded in the base commit)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--branch", default="studio/minhoon-" + datetime.date.today().strftime("%Y%m%d"))
    args = parser.parse_args()

    out = os.path.abspath(args.out)
    if os.path.exists(os.path.join(out, ".git")):
        sys.exit(f"{out} already holds a sandbox; refusing to overwrite it")
    os.makedirs(out, exist_ok=True)
    if args.repo:
        data = subprocess.run(["git", "archive", "--format=tar", args.sha], cwd=args.repo, check=True, capture_output=True).stdout
        archive = tarfile.open(fileobj=io.BytesIO(data))
    else:
        archive = tarfile.open(args.archive)
    for member in archive.getmembers():
        if member.name.startswith("/") or ".." in member.name.split("/"):
            sys.exit(f"unsafe path in archive: {member.name}")
    archive.extractall(out)
    shutil.copytree(SEED, os.path.join(out, "studio-mock"), dirs_exist_ok=True)

    git(out, "init", "-q", "-b", args.branch)
    # Byte-exact files: the bundle builder refuses CRLF sources, so a revert or checkout must never convert line ends.
    git(out, "config", "core.autocrlf", "false")
    git(out, "config", "core.safecrlf", "false")
    git(out, "add", "-A")
    git(out, "commit", "-q", "-m", f"studio base: product main {args.sha}\n\nStudio-Kind: base\nStudio-Base-Sha: {args.sha}\n")
    git(out, "tag", "studio-base")
    print(f"sandbox ready at {out} on {args.branch} (base {args.sha})")


if __name__ == "__main__":
    main()
