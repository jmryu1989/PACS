#!/usr/bin/env python3
"""deploy/make-sandbox.py --refresh on a throwaway product repo (run: python tools/minhoon-studio/test/refresh_test.py;
node 22 on PATH or in STUDIO_TEST_NODE, for the build/syntax check the refresh runs).

The refresh contract: every studio commit stays on the branch, studio and main changes to the same file both arrive
when they do not overlap, studio-base moves to the new main (the old one keeps a tag) so the studio's history and
"diff since base" stay what the server shows, and a second run with the same SHA changes nothing. When both sides
changed the same lines, or the merged files fail the chat's build/syntax check, the refresh fails and leaves HEAD,
studio-base and the working tree exactly as they were.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "deploy" / "make-sandbox.py"
IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
NODE = os.environ.get("STUDIO_TEST_NODE") or shutil.which("node")
PAGE = "worklist-v0/hpacs-lite/main.html"
OTHER = "worklist-v0/hpacs-lite/other.js"


def git(cwd, *args):
    return subprocess.run(["git", *IDENTITY, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def write(root, rel, text):
    path = Path(root, rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def tool(*args):
    return subprocess.run([sys.executable, str(TOOL), *args, "--node", NODE or "node"], capture_output=True, text=True)


@unittest.skipUnless(NODE, "node 22 is needed for the refresh's build/syntax check (PATH or STUDIO_TEST_NODE)")
class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.product, self.sandbox = root / "product", root / "sandbox"
        self.product.mkdir()
        git(self.product, "init", "-q", "-b", "main")
        git(self.product, "config", "core.autocrlf", "false")
        write(self.product, PAGE, "<title>one</title>\nline2\nline3\nline4\nline5\n")
        write(self.product, OTHER, "a;\nb;\nc;\nd;\ne;\n")
        write(self.product, "scripts/main-split-order.json",
              json.dumps({"page": PAGE, "sources": [], "artifact": "worklist-v0/hpacs-lite/main-split.bundle.js"}))
        self.commit_product("A")
        self.sha_a = git(self.product, "rev-parse", "HEAD")
        made = tool("--repo", str(self.product), "--sha", self.sha_a, "--out", str(self.sandbox), "--branch", "studio/t")
        self.assertEqual(made.returncode, 0, made.stderr)
        # Studio side: a title change, and an undone change.
        write(self.sandbox, PAGE, "<title>studio</title>\nline2\nline3\nline4\nline5\n")
        git(self.sandbox, "commit", "-q", "-am", "studio title", "-m", "Studio-Kind: change")
        write(self.sandbox, "worklist-v0/hpacs-lite/new.css", "x{}\n")
        git(self.sandbox, "add", "-A"); git(self.sandbox, "commit", "-q", "-m", "studio css", "-m", "Studio-Kind: change")
        git(self.sandbox, "revert", "--no-edit", "HEAD")
        self.studio_commits = git(self.sandbox, "log", "--format=%H", "studio-base..HEAD").split()
        # Main moves on: another line of the same page, a separate file and a new one.
        write(self.product, PAGE, "<title>one</title>\nline2\nline3\nline4\nline5 main\n")
        write(self.product, OTHER, "a;\nb;\nc;\nd;\ne;\nf;\n")
        write(self.product, "scripts/mg.py", "print(1)\n")
        self.sha_b = self.commit_product("B")

    def tearDown(self):
        self.tmp.cleanup()

    def commit_product(self, message):
        git(self.product, "add", "-A"); git(self.product, "commit", "-q", "-m", message)
        return git(self.product, "rev-parse", "HEAD")

    def refresh(self, sha=None):
        return tool("--repo", str(self.product), "--sha", sha or self.sha_b, "--out", str(self.sandbox), "--refresh")

    def sandbox_state(self):
        files = {rel: Path(self.sandbox, rel).read_bytes() for rel in (PAGE, OTHER)}
        return (git(self.sandbox, "rev-parse", "HEAD"), git(self.sandbox, "rev-parse", "studio-base^{commit}"),
                git(self.sandbox, "tag", "--list"), git(self.sandbox, "status", "--porcelain", "--untracked-files=all"),
                git(self.sandbox, "rev-parse", "--abbrev-ref", "HEAD"), files)

    def assert_stopped_unchanged(self, run, before, result):
        self.assertNotEqual(run.returncode, 0, run.stdout)
        summary = json.loads(run.stdout)
        self.assertEqual(summary["result"], result)
        self.assertTrue(summary["sandbox_restored"], summary)
        self.assertEqual(self.sandbox_state(), before)
        self.assertFalse(Path(self.sandbox, ".git", "MERGE_HEAD").exists())
        return summary

    def test_merge_keeps_studio_commits_and_both_sides(self):
        run = self.refresh()
        self.assertEqual(run.returncode, 0, run.stderr)
        summary = json.loads(run.stdout)
        self.assertEqual(summary["result"], "merged")
        self.assertEqual(summary["studio_commits"], 3)
        self.assertIn(OTHER, summary["syntax_checked"])
        head = git(self.sandbox, "rev-parse", "HEAD")
        for commit in self.studio_commits:
            subprocess.run(["git", "merge-base", "--is-ancestor", commit, head], cwd=self.sandbox, check=True)
        self.assertEqual(git(self.sandbox, "show", f"HEAD:{PAGE}"), "<title>studio</title>\nline2\nline3\nline4\nline5 main")
        self.assertEqual(git(self.sandbox, "show", f"HEAD:{OTHER}"), "a;\nb;\nc;\nd;\ne;\nf;")
        self.assertEqual(git(self.sandbox, "show", "HEAD:scripts/mg.py"), "print(1)")
        self.assertEqual(git(self.sandbox, "show", "HEAD:studio-mock/dataset.json")[:1], "{")
        self.assertEqual(git(self.sandbox, "rev-parse", "--abbrev-ref", "HEAD"), "studio/t")
        self.assertEqual(git(self.sandbox, "status", "--porcelain"), "")
        base_sha = git(self.sandbox, "log", "-1", "--format=%(trailers:key=Studio-Base-Sha,valueonly)", "studio-base")
        self.assertEqual(base_sha, self.sha_b)
        self.assertEqual(git(self.sandbox, "rev-parse", f"studio-base-{self.sha_a[:12]}^{{commit}}"),
                         git(self.sandbox, "rev-parse", "studio-base^"))
        # What the server lists (sandbox.js log/diffSinceBase): the studio commits plus the refresh, and only the
        # studio's own change against the new main.
        listed = git(self.sandbox, "log", "--format=%H", "studio-base..HEAD").split()
        self.assertEqual(listed[1:], self.studio_commits)
        self.assertIn("Studio-Kind: refresh", git(self.sandbox, "log", "-1", "--format=%B", "HEAD"))
        self.assertEqual(git(self.sandbox, "diff", "studio-base..HEAD", "--", PAGE).count("\n+<title>studio"), 1)
        self.assertEqual(git(self.sandbox, "diff", "--name-only", "studio-base..HEAD"), PAGE)

    def test_conflict_stops_and_changes_nothing(self):
        # Main also changes the title the studio changed, plus a line the studio did not touch.
        write(self.product, PAGE, "<title>main</title>\nline2\nline3\nline4\nline5 main\n")
        sha_c = self.commit_product("C")
        before = self.sandbox_state()
        summary = self.assert_stopped_unchanged(self.refresh(sha_c), before, "conflict")
        self.assertEqual(summary["conflicts"], [PAGE])
        self.assertEqual(git(self.sandbox, "log", "-1", "--format=%(trailers:key=Studio-Base-Sha,valueonly)", "studio-base"),
                         self.sha_a)

    def test_merged_syntax_error_stops_and_changes_nothing(self):
        # Each side declares the same name at the other end of the file: a clean text merge, invalid JavaScript.
        write(self.sandbox, OTHER, "let shared = 1;\na;\nb;\nc;\nd;\ne;\n")
        git(self.sandbox, "commit", "-q", "-am", "studio let", "-m", "Studio-Kind: change")
        write(self.product, OTHER, "a;\nb;\nc;\nd;\ne;\nf;\nlet shared = 2;\n")
        sha_c = self.commit_product("C")
        before = self.sandbox_state()
        summary = self.assert_stopped_unchanged(self.refresh(sha_c), before, "check-failed")
        self.assertTrue(any(OTHER in error and "shared" in error for error in summary["check_errors"]), summary)

    def test_builder_writing_other_files_stops_and_changes_nothing(self):
        # A builder that also writes outside its artifact leaves files in the tree; the abort must remove them.
        write(self.product, "scripts/build-ohif-config.py",
              "open('config/ohif.js', 'w').write('var x = 1;\\n')\nopen('stray.txt', 'w').write('x')\n")
        write(self.product, "config/ohif.js", "var x = 0;\n")
        sha_c = self.commit_product("C")
        before = self.sandbox_state()
        summary = self.assert_stopped_unchanged(self.refresh(sha_c), before, "rebuild-failed")
        self.assertFalse(Path(self.sandbox, "stray.txt").exists())
        self.assertFalse(Path(self.sandbox, "scripts/build-ohif-config.py").exists())
        self.assertEqual(summary["head"], before[0])

    def test_second_run_is_a_no_op(self):
        self.assertEqual(self.refresh().returncode, 0)
        head = git(self.sandbox, "rev-parse", "HEAD")
        again = self.refresh()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)["result"], "already-at-base")
        self.assertEqual(git(self.sandbox, "rev-parse", "HEAD"), head)

    def test_refuses_a_dirty_sandbox(self):
        write(self.sandbox, OTHER, "half an edit\n")
        head = git(self.sandbox, "rev-parse", "HEAD")
        run = self.refresh()
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(git(self.sandbox, "rev-parse", "HEAD"), head)
        self.assertEqual(git(self.sandbox, "log", "-1", "--format=%(trailers:key=Studio-Base-Sha,valueonly)", "studio-base"), self.sha_a)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
