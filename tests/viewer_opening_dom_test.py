# coding: utf-8
"""REQ-D-WORKSPACE-OPENING -> RISK-D-WORKSPACE-FOCUS-STEAL -> TEST-VIEWER-OPENING-FOCUS-DOM.

The Image Opening dialog's close listener used to call button.focus() whenever the session was
current. close() restores focus itself and the close event is queued after it, so a focus move made
in between (Tab, a shortcut, a programmatic focus) was taken back. This isolated harness puts the
Done press and the move in ONE task, so the order is fixed and nothing depends on timing:

  V1-old     the pre-fix listener must take the moved focus back. It is the shipped file with exactly
             the fixed block put back, and its git blob must equal the pre-fix blob, so no other line
             differs. If it keeps the focus, the hypothesis is refuted and this case FAILS saying so.
  V1         the shipped listener keeps the moved focus.
  V2-body    focus left on the body when the close event runs still goes back to the opener.
  V2-dialog  a dialog opened with nothing focused has no restore target; focus goes to the opener.
  V3         a session ended while the dialog is open never sends focus to the opener.
  V4         the old listener, loaded through the same override as the shipped file, FAILs V1 on its
             own assertion text (never ERROR); an unmutated copy through that override passes first.

A synthetic approved session object only: no server, no network, no credentials, no storage beyond
the harness origin. The recorder notes every focusin and the active element at the start of the
close dispatch (window capture) and after the product listener (a listener added after mount), so a
move between those two notes is the product listener's. This shows the mechanism exists; it does not
prove it caused the hosted E2E failure, which needs a failure-time capture in that run.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SHIPPED = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-opening.js"
OVERRIDE = "KIN_VIEWER_OPENING_JS"
CASE = "ViewerOpeningFocusDOMTest"
V1_CASE = "test_v1_fixed_listener_keeps_focus_moved_after_done"

# The old form is the shipped file with this exact block put back to the pre-fix line; the blob pin
# (5834d1f and 04be726 share it) proves the variant is the whole pre-fix file, not a lookalike. A later
# edit elsewhere in viewer-opening.js must re-derive and re-pin, not loosen this.
FIXED_BLOCK = (
    "    // close() has already restored focus and the close event is queued after it, so a later move belongs to the user: only focus left on nothing, the body or the closed dialog goes back to the opener.\n"
    "    dialog.addEventListener('close', () => { const active = document.activeElement; if (current() && (!active || active === document.body || dialog.contains(active))) button.focus(); });\n"
)
OLD_LISTENER = "    dialog.addEventListener('close', () => { if (current()) button.focus(); });\n"
PRE_FIX_BLOB = "a97c477fd136a8c36a96b5f7af19dd1de3cacaaa"

EXPECT_V1 = "S4-U3 focus V1: a focus move made after Done must survive the queued close event"
EXPECT_V2_BODY = "S4-U3 focus V2: focus left on the body must go back to the opener"
EXPECT_V2_DIALOG = "S4-U3 focus V2: focus with no restore target must go back to the opener"
EXPECT_V3 = "S4-U3 focus V3: an ended session must not send focus to the opener"
REFUTED = "V1 hypothesis refuted: the pre-fix close listener did not take focus back from #other"

# A crash is not a kill: these only appear when the harness itself broke.
CRASH_MARKERS = ("playwright._impl._errors", "ModuleNotFoundError")

HARNESS = r"""<!doctype html>
<meta charset="utf-8">
<button id="image-opening-open" type="button" disabled>Image Opening</button>
<button id="other" type="button">Other</button>
<script>
window.__session = {state: 'approved', institution: 'SYN-FOCUS-INSTITUTION', sub: 'SYN-FOCUS-USER'};
window.__rec = [];
window.__id = el => el === null ? null : el === document.body ? 'BODY' : (el.id || el.tagName);
window.__note = (t, extra) => { __rec.push(Object.assign({seq: __rec.length, t, active: __id(document.activeElement),
  open: !!document.querySelector('#image-opening-dialog')?.open}, extra || {})); };
document.addEventListener('focusin', e => __note('focusin', {target: __id(e.target)}), true);
window.addEventListener('close', e => { if (e.target.id === 'image-opening-dialog') __note('close-capture'); }, true);
</script>
"""

MOUNT = """
window.__opening = KinViewerOpening.mount({button: document.querySelector('#image-opening-open'), session: () => window.__session});
document.querySelector('#image-opening-dialog').addEventListener('close', () => __note('close-after'));
"""

SETTLE = "() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 0))))"


def lf_text(data):
    return data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")


def git_blob(text):
    data = text.encode("utf-8")
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def describe(role, path, raw):
    lf = lf_text(raw)
    return {"role": role, "path": str(path), "raw_sha256": hashlib.sha256(raw).hexdigest(),
            "lf_sha256": hashlib.sha256(lf.encode("utf-8")).hexdigest(), "git_blob": git_blob(lf)}


class ViewerOpeningFocusDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = Path(os.environ.get("KIN_EVIDENCE_DIR") or tempfile.mkdtemp(prefix="kin-viewer-opening-focus-"))
        cls.evidence.mkdir(parents=True, exist_ok=True)
        shipped_raw = SHIPPED.read_bytes()
        cls.shipped_lf = lf_text(shipped_raw)
        found = cls.shipped_lf.count(FIXED_BLOCK)
        if found != 1:
            raise AssertionError(f"setup: the fixed close-listener block occurs {found} times in {SHIPPED.name}")
        cls.old_lf = cls.shipped_lf.replace(FIXED_BLOCK, OLD_LISTENER)
        if git_blob(cls.old_lf) != PRE_FIX_BLOB:
            raise AssertionError(f"setup: the derived old form is blob {git_blob(cls.old_lf)}, not the pre-fix {PRE_FIX_BLOB}")
        loaded_path = Path(os.environ[OVERRIDE]).resolve() if os.environ.get(OVERRIDE) else SHIPPED
        loaded_raw = loaded_path.read_bytes()
        cls.loaded = loaded_raw.decode("utf-8-sig")
        sources = [describe("shipped", SHIPPED, shipped_raw), describe("loaded", loaded_path, loaded_raw),
                   describe("old-form", "derived:shipped-with-pre-fix-listener", cls.old_lf.encode("utf-8"))]
        for row in sources:
            print("VIEWER_OPENING_SOURCE role=%s path=%s raw_sha256=%s lf_sha256=%s git_blob=%s"
                  % (row["role"], row["path"], row["raw_sha256"], row["lf_sha256"], row["git_blob"]), flush=True)
        (cls.evidence / "sources.json").write_text(json.dumps(
            {"override": os.environ.get(OVERRIDE), "pre_fix_blob": PRE_FIX_BLOB, "sources": sources},
            ensure_ascii=False, indent=2), encoding="utf-8")
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open_page(self, source):
        page = self.browser.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=HARNESS)
                   if route.request.url == "https://example.test/harness" else route.abort())
        page.goto("https://example.test/harness")
        page.add_script_tag(content=source)
        page.add_script_tag(content=MOUNT)
        self.addCleanup(page.close)
        return page, errors

    def finish(self, page, errors, label, extra):
        page.wait_for_function("__rec.some(r => r.t === 'close-after')", timeout=5000)
        page.evaluate(SETTLE)
        state = page.evaluate("""() => ({final: __id(document.activeElement), rec: __rec,
          open: document.querySelector('#image-opening-dialog').open,
          disabled: document.querySelector('#image-opening-open').disabled,
          status: document.querySelector('#image-opening-status').textContent})""")
        rec = state["rec"]
        start = next(i for i, row in enumerate(rec) if row["t"] == "close-capture")
        end = next(i for i, row in enumerate(rec) if row["t"] == "close-after")
        result = dict(extra, label=label, final=state["final"], open=state["open"], disabled=state["disabled"],
                      status=state["status"], capture_active=rec[start]["active"], after_active=rec[end]["active"],
                      listener_moves=[row["target"] for row in rec[start + 1:end] if row["t"] == "focusin"],
                      page_errors=list(errors), rec=rec)
        (self.evidence / f"{label}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print("OBSERVED %s %s" % (label, json.dumps({k: v for k, v in result.items() if k != "rec"}, ensure_ascii=False)), flush=True)
        print("OBSERVED_ORDER %s %s" % (label, " ".join(row["t"] for row in rec)), flush=True)
        self.assertEqual(result["page_errors"], [], "setup: page errors")
        return result

    def move_focus_after_done(self, source, label):
        page, errors = self.open_page(source)
        # A real click focuses the opener, so it is the dialog's restore target, as in the E2E.
        page.locator("#image-opening-open").click()
        opened = page.evaluate("() => ({open: document.querySelector('#image-opening-dialog').open, active: __id(document.activeElement)})")
        close_in_task = page.evaluate("""() => {
          document.querySelector('#image-opening-done').click();
          __note('after-close-call');
          document.querySelector('#other').focus();
          __note('after-other-focus');
          setTimeout(() => __note('timeout-0'), 0);
          requestAnimationFrame(() => __note('raf-1'));
          return __rec.some(r => r.t === 'close-capture');
        }""")
        result = self.finish(page, errors, label, {"opened": opened, "close_in_task": close_in_task})
        self.assertTrue(opened["open"], "setup: the opener click did not open the dialog")
        self.assertFalse(close_in_task, "V1 premise refuted: the close event ran inside close(), before the move")
        self.assertEqual(result["capture_active"], "other", "V1 premise refuted: focus was not on #other when the close event began")
        return result

    def test_v1_old_listener_takes_back_focus_moved_after_done(self):
        result = self.move_focus_after_done(self.old_lf, "v1-old-listener")
        self.assertEqual(result["listener_moves"], ["image-opening-open"], REFUTED)
        self.assertEqual(result["final"], "image-opening-open", REFUTED)

    def test_v1_fixed_listener_keeps_focus_moved_after_done(self):
        result = self.move_focus_after_done(self.loaded, "v1-loaded-listener")
        self.assertEqual(result["final"], "other", EXPECT_V1)
        self.assertEqual(result["listener_moves"], [], EXPECT_V1)

    def test_v2_focus_left_on_the_body_goes_back_to_the_opener(self):
        page, errors = self.open_page(self.loaded)
        page.locator("#image-opening-open").click()
        page.evaluate("""() => {
          document.querySelector('#image-opening-done').click();
          __note('after-close-call');
          document.activeElement.blur();
          __note('after-blur');
        }""")
        result = self.finish(page, errors, "v2-body", {})
        self.assertEqual(result["capture_active"], "BODY", "V2 premise: focus was not stranded on the body")
        self.assertEqual(result["listener_moves"], ["image-opening-open"], EXPECT_V2_BODY)
        self.assertEqual(result["final"], "image-opening-open", EXPECT_V2_BODY)

    def test_v2_focus_without_restore_target_goes_back_to_the_opener(self):
        page, errors = self.open_page(self.loaded)
        # A programmatic click does not focus the opener, so showModal() records no restore target and
        # focus stays inside the dialog (or falls to the body) when it closes.
        opened = page.evaluate("""() => {
          document.querySelector('#image-opening-open').click();
          return {open: document.querySelector('#image-opening-dialog').open, active: __id(document.activeElement)};
        }""")
        page.evaluate("() => { document.querySelector('#image-opening-done').click(); __note('after-close-call'); }")
        result = self.finish(page, errors, "v2-dialog", {"opened": opened})
        self.assertTrue(opened["open"], "setup: the programmatic click did not open the dialog")
        self.assertNotIn(result["capture_active"], ("image-opening-open", "other"),
                         "V2 premise: something restored focus before the close event")
        self.assertEqual(result["listener_moves"], ["image-opening-open"], EXPECT_V2_DIALOG)
        self.assertEqual(result["final"], "image-opening-open", EXPECT_V2_DIALOG)

    def test_v3_ended_session_never_sends_focus_to_the_opener(self):
        # end() closes, and the native restore may land on the opener before render() disables it; the
        # listener's own window is what V3 bounds. The storage form strands focus so a fallback would fire.
        forms = {
            "channel": "() => { window.__end = new BroadcastChannel('kin-session'); __end.postMessage({type: 'session-ended'}); }",
            "storage-stranded": """() => {
              window.dispatchEvent(new StorageEvent('storage', {key: 'kin-session-ended'}));
              __note('after-end');
              document.activeElement.blur();
              __note('after-blur');
            }""",
        }
        for form, script in forms.items():
            with self.subTest(form=form):
                page, errors = self.open_page(self.loaded)
                page.locator("#image-opening-open").click()
                page.evaluate(script)
                result = self.finish(page, errors, f"v3-{form}", {})
                self.assertFalse(result["open"], "setup: the ended session did not close the dialog")
                self.assertTrue(result["disabled"], "setup: the ended session did not disable the opener")
                self.assertEqual(result["status"], "로그인이 종료되었습니다.", "setup: the ended session did not render its notice")
                if form == "storage-stranded":
                    self.assertEqual(result["capture_active"], "BODY", "V3 premise: focus was not stranded on the body")
                    self.assertEqual(result["final"], "BODY", EXPECT_V3)
                self.assertEqual(result["listener_moves"], [], EXPECT_V3)

    def test_v4_old_listener_mutant_fails_v1_on_its_own_assertion(self):
        scratch = Path(tempfile.mkdtemp(prefix="kin-viewer-opening-mutant-"))
        self.addCleanup(shutil.rmtree, scratch, True)
        copies = {"baseline": self.shipped_lf, "old-listener": self.old_lf}
        runs = {}
        for label, text in copies.items():
            path = scratch / f"{label}-viewer-opening.js"
            path.write_bytes(text.encode("utf-8"))
            env = dict(os.environ, PYTHONIOENCODING="utf-8", KIN_EVIDENCE_DIR=str(self.evidence / f"v4-{label}"))
            env[OVERRIDE] = str(path)
            done = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), f"{CASE}.{V1_CASE}"],
                                  cwd=str(ROOT), env=env, capture_output=True, text=True,
                                  encoding="utf-8", errors="replace", timeout=180)
            output = (done.stdout or "") + (done.stderr or "")
            (self.evidence / f"v4-{label}.log").write_text(output, encoding="utf-8")
            runs[label] = {"exit": done.returncode, "output": output, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                           "git_blob": git_blob(text)}

        baseline, mutant = runs["baseline"], runs["old-listener"]
        named = [line.strip() for line in mutant["output"].splitlines() if V1_CASE in line and line.rstrip().endswith("... FAIL")]
        blocks = [block for block in re.split(r"^={10,}$", mutant["output"], flags=re.MULTILINE) if f"FAIL: {V1_CASE}" in block]
        crashed = [marker for marker in CRASH_MARKERS if marker in mutant["output"]]
        verdict = {"baseline": {k: v for k, v in baseline.items() if k != "output"},
                   "old_listener": {k: v for k, v in mutant.items() if k != "output"},
                   "named_failure": named, "expect": EXPECT_V1,
                   "expect_in_block": bool(blocks) and EXPECT_V1 in blocks[0], "crash_markers": crashed}
        verdict["killed"] = (mutant["exit"] != 0 and len(named) == 1 and len(blocks) == 1 and verdict["expect_in_block"]
                             and "AssertionError: 'image-opening-open' != 'other'" in blocks[0]
                             and "FAILED (failures=1)" in mutant["output"] and not crashed)
        (self.evidence / "v4-mutant.json").write_text(json.dumps(verdict, ensure_ascii=False, indent=2), encoding="utf-8")
        print("OBSERVED v4-mutant %s" % json.dumps(verdict, ensure_ascii=False), flush=True)

        self.assertEqual(baseline["exit"], 0, "V4 setup: the unmutated copy must pass V1 through the override first")
        self.assertIn(f"role=loaded path={Path(scratch / 'baseline-viewer-opening.js').resolve()} raw_sha256={baseline['sha256']}",
                      baseline["output"], "V4 setup: the baseline child did not load the unmutated copy")
        self.assertRegex(baseline["output"], r"Ran 1 test in .*\n\nOK", "V4 setup: the baseline child did not run exactly V1")
        self.assertEqual(mutant["git_blob"], PRE_FIX_BLOB, "V4 setup: the mutant is not the pre-fix blob")
        self.assertIn(f"role=loaded path={Path(scratch / 'old-listener-viewer-opening.js').resolve()} raw_sha256={mutant['sha256']}",
                      mutant["output"], "V4 setup: the mutant child did not load the old listener")
        self.assertEqual(crashed, [], "V4: the mutant run crashed; a crash is not a kill")
        self.assertTrue(verdict["killed"], "V4: the old listener survived V1 or failed it on another assertion")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
