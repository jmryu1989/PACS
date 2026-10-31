#!/usr/bin/env python3
"""deploy/make-sandbox.py --refresh on a throwaway product repo (run: python tools/minhoon-studio/test/refresh_test.py).

The refresh contract: every studio commit stays on the branch, a file both sides changed keeps the studio version and
is listed, everything else main changed arrives, studio-base moves to the new main (the old one keeps a tag) so the
studio's history and "diff since base" stay what the server shows, and a second run with the same SHA changes nothing.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parents[1] / "deploy" / "make-sandbox.py"
IDENTITY = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]


def git(cwd, *args):
    return subprocess.run(["git", *IDENTITY, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def write(root, rel, text):
    path = Path(root, rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def tool(*args):
    return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True)


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.product, self.sandbox = root / "product", root / "sandbox"
        self.product.mkdir()
        git(self.product, "init", "-q", "-b", "main")
        git(self.product, "config", "core.autocrlf", "false")
        write(self.product, "worklist-v0/hpacs-lite/main.html", "<title>one</title>\nline2\nline3\n")
        write(self.product, "worklist-v0/hpacs-lite/other.js", "a\nb\n")
        git(self.product, "add", "-A"); git(self.product, "commit", "-q", "-m", "A")
        self.sha_a = git(self.product, "rev-parse", "HEAD")
        made = tool("--repo", str(self.product), "--sha", self.sha_a, "--out", str(self.sandbox), "--branch", "studio/t")
        self.assertEqual(made.returncode, 0, made.stderr)
        # Studio side: one change that main will also touch, one it will not, and an undone change.
        write(self.sandbox, "worklist-v0/hpacs-lite/main.html", "<title>studio</title>\nline2\nline3\n")
        git(self.sandbox, "commit", "-q", "-am", "studio title", "-m", "Studio-Kind: change")
        write(self.sandbox, "worklist-v0/hpacs-lite/new.css", "x{}\n")
        git(self.sandbox, "add", "-A"); git(self.sandbox, "commit", "-q", "-m", "studio css", "-m", "Studio-Kind: change")
        git(self.sandbox, "revert", "--no-edit", "HEAD")
        self.studio_commits = git(self.sandbox, "log", "--format=%H", "studio-base..HEAD").split()
        # Main moves on: the same title line, a separate file and a new one.
        write(self.product, "worklist-v0/hpacs-lite/main.html", "<title>main</title>\nline2\nline3 main\n")
        write(self.product, "worklist-v0/hpacs-lite/other.js", "a\nb\nc\n")
        write(self.product, "scripts/mg.py", "print(1)\n")
        git(self.product, "add", "-A"); git(self.product, "commit", "-q", "-m", "B")
        self.sha_b = git(self.product, "rev-parse", "HEAD")

    def tearDown(self):
        self.tmp.cleanup()

    def refresh(self):
        return tool("--repo", str(self.product), "--sha", self.sha_b, "--out", str(self.sandbox), "--refresh")

    def test_merge_keeps_studio_commits_and_side(self):
        run = self.refresh()
        self.assertEqual(run.returncode, 0, run.stderr)
        summary = json.loads(run.stdout)
        self.assertEqual(summary["result"], "merged")
        self.assertEqual(summary["kept_studio_side"], ["worklist-v0/hpacs-lite/main.html"])
        self.assertEqual(summary["studio_commits"], 3)
        head = git(self.sandbox, "rev-parse", "HEAD")
        for commit in self.studio_commits:
            subprocess.run(["git", "merge-base", "--is-ancestor", commit, head], cwd=self.sandbox, check=True)
        self.assertEqual(git(self.sandbox, "show", "HEAD:worklist-v0/hpacs-lite/main.html"), "<title>studio</title>\nline2\nline3")
        self.assertEqual(git(self.sandbox, "show", "HEAD:worklist-v0/hpacs-lite/other.js"), "a\nb\nc")
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
        self.assertEqual(git(self.sandbox, "diff", "--name-only", "studio-base..HEAD"), "worklist-v0/hpacs-lite/main.html")

    def test_second_run_is_a_no_op(self):
        self.assertEqual(self.refresh().returncode, 0)
        head = git(self.sandbox, "rev-parse", "HEAD")
        again = self.refresh()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)["result"], "already-at-base")
        self.assertEqual(git(self.sandbox, "rev-parse", "HEAD"), head)

    def test_refuses_a_dirty_sandbox(self):
        write(self.sandbox, "worklist-v0/hpacs-lite/other.js", "half an edit\n")
        head = git(self.sandbox, "rev-parse", "HEAD")
        run = self.refresh()
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(git(self.sandbox, "rev-parse", "HEAD"), head)
        self.assertEqual(git(self.sandbox, "log", "-1", "--format=%(trailers:key=Studio-Base-Sha,valueonly)", "studio-base"), self.sha_a)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main()
