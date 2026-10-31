#!/usr/bin/env python3
"""Create the studio sandbox: a fresh git repository holding the product tree at one main SHA (tag studio-base),
plus the studio's editable mock data in studio-mock/. The chat edits this copy; the commander collects its branch.

  python make-sandbox.py --archive base.tar --sha <sha> --out /opt/minhoon-studio/sandbox
  python make-sandbox.py --repo <product checkout> --sha <sha> --out <dir>      (runs git archive itself)
  python make-sandbox.py --archive base.tar --sha <sha> --out <existing sandbox> --refresh

It never touches the product checkout beyond `git archive`, and refuses to overwrite an existing sandbox.

--refresh brings an existing sandbox to a new main SHA without losing a studio commit: the new product tree (plus the
current studio-mock seed) becomes a commit on top of the old base, that commit is merged into the studio branch, and
studio-base moves to it (the old base keeps a tag studio-base-<sha12>). `studio-base..HEAD` then still lists every
studio commit plus the merge, and the diff against studio-base is the studio's own change on the new main. The
generated bundle and OHIF config are rebuilt from the merged sources and the result goes through the chat's own
build/syntax check (server/build.js), as after a chat edit.

The refresh stops and puts the sandbox back exactly as it was (HEAD, branch, studio-base and every other ref, index,
working tree) when both sides changed the same lines (the conflicted files are listed in the stdout JSON), when a
builder fails, when the merged files fail the syntax check (two clean merges can still declare one name twice), when
the commit or a tag update fails, or on any other error or SIGTERM/SIGHUP. The JSON's sandbox_restored is true only
when that state was verified afterwards. Resolving is a person's call, not this tool's.
"""
import argparse
import datetime
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(HERE, "..", "sandbox-seed", "studio-mock")
BUILD_JS = os.path.join(HERE, "..", "server", "build.js")
IDENTITY = ["-c", "user.name=Minhoon Studio", "-c", "user.email=studio@minhoon-studio.local", "-c", "commit.gpgsign=false"]
# What the product builders write (server/build.js runs the same two after a chat edit).
BUILDERS = [("scripts/build-main-split-bundle.py", None), ("scripts/build-ohif-config.py", "config/ohif.js")]


def git(out, *args):
    # git's own messages go to stderr: stdout carries only the --refresh summary JSON (install.sh keeps it).
    subprocess.run(["git", *IDENTITY, *args], cwd=out, check=True, stdout=sys.stderr)


def git_out(out, *args, env=None):
    return subprocess.run(["git", *IDENTITY, *args], cwd=out, check=True, capture_output=True, text=True,
                          env=env).stdout


def open_archive(args):
    if args.repo:
        data = subprocess.run(["git", "archive", "--format=tar", args.sha], cwd=args.repo, check=True, capture_output=True).stdout
        archive = tarfile.open(fileobj=io.BytesIO(data))
    else:
        archive = tarfile.open(args.archive)
    for member in archive.getmembers():
        if member.name.startswith("/") or ".." in member.name.split("/"):
            sys.exit(f"unsafe path in archive: {member.name}")
    return archive


def product_tree(out, archive):
    """Write the product tree + studio-mock seed as a tree object of the sandbox repo; the working tree is untouched."""
    with tempfile.TemporaryDirectory(prefix="studio-refresh-") as work:
        tree_dir = os.path.join(work, "tree")
        archive.extractall(tree_dir)
        shutil.copytree(SEED, os.path.join(tree_dir, "studio-mock"), dirs_exist_ok=True)
        env = {**os.environ, "GIT_INDEX_FILE": os.path.join(work, "index")}
        git_dir = os.path.join(out, ".git")
        subprocess.run(["git", "--git-dir", git_dir, "--work-tree", tree_dir, "add", "-A"], cwd=out, check=True, env=env)
        return subprocess.run(["git", "--git-dir", git_dir, "write-tree"], cwd=out, check=True, capture_output=True,
                              text=True, env=env).stdout.strip()


def rebuild_generated(out, python):
    """Regenerate the builders' outputs from the merged sources; returns the generated files that changed."""
    generated = []
    for script, artifact in BUILDERS:
        if not os.path.exists(os.path.join(out, script)):
            continue
        if artifact is None:
            artifact = json.load(open(os.path.join(out, "scripts/main-split-order.json"), encoding="utf-8"))["artifact"]
        subprocess.run([python, script], cwd=out, check=True, stdout=sys.stderr)
        generated.append(artifact)
    # Against the index (the merge result so far), not HEAD: HEAD lacks everything main brought in.
    changed = [f for f in (git_out(out, "diff", "--name-only").splitlines()
                           + git_out(out, "ls-files", "--others", "--exclude-standard").splitlines()) if f]
    stray = [f for f in changed if f not in generated]
    if stray:
        raise RuntimeError(f"the builders changed files they do not own: {stray}")
    if changed:
        git(out, "add", "--", *changed)
    return changed


def check_merged(out, args):
    """Run the chat's build/syntax check (server/build.js) on every file the merge changed against the studio HEAD;
    returns (errors, checked files). Files only the studio changed were checked when the chat made them."""
    changed = [f for f in git_out(out, "diff", "--cached", "--name-only", "HEAD").splitlines() if f]
    script = ("const files = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
              "require(process.argv[1]).buildAndCheck(process.argv[2], files, { python: process.argv[3] })"
              ".then(r => { process.stdout.write(JSON.stringify(r)); })"
              ".catch(e => { process.stdout.write(JSON.stringify({ ok: false, errors: [String(e && e.stack || e)] })); });")
    try:
        run = subprocess.run([args.node, "-e", script, os.path.abspath(BUILD_JS), out, args.python], cwd=out,
                             input=json.dumps(changed), capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as error:
        return [f"could not run the syntax check with {args.node}: {error}"], []
    try:
        result = json.loads(run.stdout)
    except ValueError:
        return [f"the syntax check gave no result (exit {run.returncode}): {(run.stderr or run.stdout).strip()[-2000:]}"], []
    checked = next((s.get("files", []) for s in result.get("steps", []) if s.get("name") == "syntax-check"), [])
    # buildAndCheck reruns the builders when bundle sources changed; their output must equal what is staged.
    unstaged = [f for f in git_out(out, "diff", "--name-only").splitlines() if f]
    if unstaged:
        result.setdefault("errors", []).append(f"the builders' second run changed: {unstaged}")
        result["ok"] = False
    return ([] if result.get("ok") else (result.get("errors") or ["the syntax check failed without a message"])), checked


class Stop(Exception):
    """A refresh step failed; `result` names it in the summary JSON."""

    def __init__(self, result, message, **extra):
        super().__init__(message)
        self.result, self.extra = result, extra


def interrupted(signum, _frame):
    # Default SIGTERM/SIGHUP (e.g. the ssh session running install.sh drops) would end the run with a half-made merge
    # or commit and no restore; as an exception it goes through the same restore as any failed step.
    raise Stop("interrupted", f"signal {signum}")


def snapshot(out):
    """What a failed refresh must put back: HEAD (sha and branch) and every ref, tags included."""
    symbolic = subprocess.run(["git", "symbolic-ref", "-q", "HEAD"], cwd=out, capture_output=True, text=True).stdout.strip()
    refs = dict(line.split(" ", 1)[::-1] for line in
                git_out(out, "for-each-ref", "--format=%(objectname) %(refname)").splitlines() if line)
    return {"head": git_out(out, "rev-parse", "HEAD").strip(), "symbolic": symbolic, "refs": refs}


def restore(out, before):
    """Put HEAD, every ref, the index and the working tree back as they were at `before`; returns what is still wrong
    afterwards (empty when the sandbox is as before). Each step runs even if an earlier one failed."""
    def quiet(*args):
        subprocess.run(["git", *args], cwd=out, capture_output=True)

    quiet("merge", "--abort")
    try:
        now = snapshot(out)["refs"]
    except (subprocess.CalledProcessError, OSError):
        now = {}
    for ref, sha in before["refs"].items():
        if now.get(ref) != sha:
            quiet("update-ref", "--no-deref", ref, sha)
    for ref in now.keys() - before["refs"].keys():
        quiet("update-ref", "--no-deref", "-d", ref)
    if before["symbolic"]:
        quiet("symbolic-ref", "HEAD", before["symbolic"])
    # reset --hard also drops a staged merge and MERGE_HEAD; clean removes what a builder wrote. The refresh started
    # from a clean tree with no untracked files (checked first), so everything it removes came from this run.
    quiet("reset", "-q", "--hard", before["head"])
    quiet("clean", "-fdq")
    problems = []
    try:
        after = snapshot(out)
        status = git_out(out, "status", "--porcelain=v1", "--untracked-files=all").strip()
    except (subprocess.CalledProcessError, OSError) as error:
        return [f"could not read the sandbox state: {error}"]
    if after["head"] != before["head"] or after["symbolic"] != before["symbolic"]:
        problems.append("HEAD moved")
    changed = sorted(r for r in before["refs"].keys() | after["refs"].keys() if before["refs"].get(r) != after["refs"].get(r))
    if changed:
        problems.append(f"refs differ: {changed}")
    if status:
        problems.append("the working tree is not clean")
    if os.path.exists(os.path.join(out, ".git", "MERGE_HEAD")):
        problems.append("a merge is still in progress")
    return problems


def merge_and_check(out, args, summary, old_base, old_sha):
    """Every step that writes the sandbox: merge, rebuild, check, commit, tags. Raises on any failure; the caller
    restores the snapshot taken before it."""
    tree = product_tree(out, open_archive(args))
    message = f"studio base: product main {args.sha}\n\nStudio-Kind: base\nStudio-Base-Sha: {args.sha}\n"
    new_base = subprocess.run(["git", *IDENTITY, "commit-tree", tree, "-p", old_base, "-F", "-"], cwd=out, check=True,
                              capture_output=True, text=True, input=message).stdout.strip()
    merged = subprocess.run(["git", *IDENTITY, "merge", "--no-ff", "--no-commit", new_base], cwd=out,
                            capture_output=True, text=True)
    conflicts = [f for f in git_out(out, "diff", "--name-only", "--diff-filter=U").splitlines() if f]
    if conflicts:
        # Taking one side per file would also drop the other side's non-conflicting changes in that file.
        raise Stop("conflict", "both sides changed " + ", ".join(conflicts), conflicts=conflicts, new_base_commit=new_base)
    if merged.returncode:
        raise Stop("merge-failed", merged.stderr.strip() or merged.stdout.strip())
    try:
        regenerated = rebuild_generated(out, args.python)
    except Exception as error:  # a builder's own failure, a stray file, or a manifest without "artifact" (KeyError)
        raise Stop("rebuild-failed", f"rebuild after the merge failed: {type(error).__name__}: {error}") from error
    errors, checked = check_merged(out, args)
    if errors:
        raise Stop("check-failed", "the merged files fail the build/syntax check:\n" + "\n".join(errors),
                   check_errors=errors)
    branch, head_before = summary["branch"], summary["head_before"]
    body = [f"studio refresh: product main {args.sha}", "",
            f"Merged the product tree at main {args.sha} (was {old_sha}) into {branch}; every studio commit is kept.",
            "No file was changed on both sides; the merged files passed the build/syntax check.", "",
            "Studio-Kind: refresh", f"Studio-Base-Sha: {args.sha}", f"Studio-Previous-Base-Sha: {old_sha}"]
    old_tag = "studio-base-" + (old_sha or old_base)[:12]
    try:
        subprocess.run(["git", *IDENTITY, "commit", "-q", "-F", "-"], cwd=out, check=True, input="\n".join(body) + "\n",
                       text=True, stdout=sys.stderr)
        if subprocess.run(["git", "rev-parse", "-q", "--verify", f"refs/tags/{old_tag}"], cwd=out, capture_output=True).returncode:
            git(out, "tag", old_tag, old_base)
        git(out, "tag", "-f", "studio-base", new_base)
    except (subprocess.CalledProcessError, OSError) as error:
        raise Stop("commit-failed", f"commit or tag after the merge failed: {error}") from error
    return {**summary, "result": "merged", "new_base_commit": new_base, "head": git_out(out, "rev-parse", "HEAD").strip(),
            "old_base_tag": old_tag, "regenerated": regenerated, "syntax_checked": checked,
            "studio_commits": len(git_out(out, "log", "--format=%H", f"{old_base}..{head_before}").split())}


def refresh(args):
    """sandbox_restored in the summary JSON is true only when the sandbox was verified to be as before the run
    (install.sh starts the studio again only then)."""
    out = os.path.abspath(args.out)
    if not os.path.exists(os.path.join(out, ".git")):
        sys.exit(f"{out} holds no sandbox to refresh")
    before = snapshot(out)
    head_before = before["head"]
    branch = git_out(out, "rev-parse", "--abbrev-ref", "HEAD").strip()
    summary = {"sandbox": out, "branch": branch, "base_sha": args.sha, "head_before": head_before}
    if git_out(out, "status", "--porcelain=v1", "--untracked-files=all").strip():
        print(json.dumps({**summary, "result": "dirty", "head": head_before, "sandbox_restored": True,
                          "restore_problems": []}, indent=1))
        sys.exit(f"{out} has uncommitted changes (a chat edit in progress?); nothing was changed")
    old_base = git_out(out, "rev-parse", "studio-base^{commit}").strip()
    old_sha = git_out(out, "log", "-1", "--format=%(trailers:key=Studio-Base-Sha,valueonly)", old_base).strip()
    summary["previous_base_sha"] = old_sha
    if old_sha == args.sha:
        print(json.dumps({**summary, "result": "already-at-base", "head": head_before}, indent=1))
        return
    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupted)
    try:
        done = merge_and_check(out, args, summary, old_base, old_sha)
    except BaseException as error:  # includes KeyboardInterrupt: nothing may leave a half-made refresh behind
        for name in ("SIGTERM", "SIGHUP", "SIGINT"):  # a second signal must not cut the restore short
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_IGN)
        result, extra = (error.result, error.extra) if isinstance(error, Stop) else ("failed", {})
        message = str(error) if isinstance(error, Stop) else f"{type(error).__name__}: {error}"
        problems = restore(out, before)
        try:
            head = git_out(out, "rev-parse", "HEAD").strip()
        except (subprocess.CalledProcessError, OSError):
            head = None
        print(json.dumps({**summary, "result": result, **extra, "head": head,
                          "sandbox_restored": not problems, "restore_problems": problems}, indent=1))
        where = (f"sandbox left at {head_before}, studio-base and every other ref as before" if not problems else
                 f"ALSO the restore did not put the sandbox back ({'; '.join(problems)}); inspect {out}")
        sys.exit(f"refresh stopped: {message}; {where}")
    print(json.dumps(done, indent=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--archive", help="tar produced by `git archive <sha>`")
    source.add_argument("--repo", help="product checkout to run `git archive` in")
    parser.add_argument("--sha", required=True, help="the main SHA the archive holds (recorded in the base commit)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--branch", default="studio/minhoon-" + datetime.date.today().strftime("%Y%m%d"))
    parser.add_argument("--refresh", action="store_true", help="merge a new main into an existing sandbox (see above)")
    parser.add_argument("--python", default=sys.executable, help="python for the product builders (--refresh)")
    parser.add_argument("--node", default="node", help="node for the build/syntax check of the merge (--refresh)")
    args = parser.parse_args()
    if args.refresh:
        return refresh(args)

    out = os.path.abspath(args.out)
    if os.path.exists(os.path.join(out, ".git")):
        sys.exit(f"{out} already holds a sandbox; refusing to overwrite it")
    os.makedirs(out, exist_ok=True)
    open_archive(args).extractall(out)
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
