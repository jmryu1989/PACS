# coding: utf-8
"""One-off editor for the S9-U0a-PRE CI registration (validate.yml). Every edit asserts its anchor occurs exactly once.
Usage: ci_edit.py <P sha>"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
P = sys.argv[1]
assert re.fullmatch(r"[0-9a-f]{40}", P)
path = ROOT / ".github" / "workflows" / "validate.yml"
text = path.read_text(encoding="utf-8")
NL = "\r\n" if "\r\n" in text else "\n"
text = text.replace("\r\n", "\n")


def once(old, new):
    global text
    assert text.count(old) == 1, (text.count(old), old[:120])
    text = text.replace(old, new)


# The main page's own scripts, in document order (what the PRE suite serves from the tree as well as main.html).
scripts = subprocess.check_output(
    ["node", "-e", "const {scripts}=require('./tests/page_source.cjs');const fs=require('fs');"
     "const html=fs.readFileSync('worklist-v0/hpacs-lite/main.html','utf8');"
     "const links=[...html.matchAll(/<link\\b[^>]*\\bhref=[\"']([^\"']+)[\"']/g)].map(m=>m[1])"
     ".filter(h=>!/^(https?:|\\/|data:)/.test(h)&&fs.existsSync('worklist-v0/hpacs-lite/'+h));"
     "process.stdout.write(JSON.stringify([...links,...scripts(html).filter(t=>t.src).map(t=>t.src)]))"],
    cwd=ROOT, text=True)
import json  # noqa: E402
page_files = " ".join(f"--file worklist-v0/hpacs-lite/{name}" for name in json.loads(scripts))
FIXTURE = "--file tests/main_split_harness.cjs --file tests/main_split_harness.py --file tests/main_split_harness_fixture.json --file api/package-lock.json"

# 1. measurements: room for the PRE steps (the job took ~56 of 90 minutes before them).
once("  measurements:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 90\n",
     "  measurements:\n    runs-on: ubuntu-24.04\n    # S9-U0a-PRE adds about 20 minutes (A1, the early-input suite and its 37 mutants) to the ~56 the job took.\n"
     "    timeout-minutes: 120\n")

# 2. The Stage 3 anchor loop: the two report mutant drivers now import the fixture projection's Python adapter.
once('--file worklist-v0/hpacs-lite/main.html --file "tests/$script.py" -- python3 -B "tests/$script.py" --anchors-only',
     '--file worklist-v0/hpacs-lite/main.html --file "tests/$script.py" --file tests/main_split_harness.py -- python3 -B "tests/$script.py" --anchors-only')

# 3. After the S7-PINS fetch: the PRE fixed commits, A1, the fixture reference, the PRE suite and its mutants.
pins = ("        run: git fetch --no-tags --depth=1 origin 7a35570826072c0da1f79e7951f218df38fd0156 5ed77ded757e923d8dbed502b2180d5e091928c1 "
        "ae04b19d1b98b57b3ff7de006e5dc38d83ef8e64 aaf53dccad2ed140b4a2c6610e9690d33fbab2dc 64225c5aa7157c898d9e44969a3bd86099c857ab\n")
PRE_FILES = (f"--file worklist-v0/hpacs-lite/main.html {page_files} --file tests/main_early_input_dom_test.py "
             f"--file tests/auth_logout_dom_test.py --file tests/main_move_spec.json --file tests/main_move_contract.cjs "
             f"--file tests/page_source.cjs --file tests/page_source.py {FIXTURE}")
once(pins, pins +
     "      # S9-U0a-PRE (D707/D714): the early-input suite reads the f1d5406 page (main.html, its scripts and move spec) as the\n"
     "      # ORIGINAL it compares with, and A1 and the split generator read the main.html of tests/main_move_spec.json `base`\n"
     "      # (the PRE commit P); this depth-1 checkout has neither (public repository, no token).\n"
     "      - name: S9-U0a-PRE fixed commits for the original page and the move baseline\n"
     "        if: ${{ !cancelled() }}\n"
     "        timeout-minutes: 3\n"
     f"        run: git fetch --no-tags --depth=1 origin f1d540626aac03f46de23a9620d69f4c9da66037 {P}\n"
     "      # A1: the spec's 45 runs flatten to the page's statements in order; dropped/duplicated/swapped statements, moved-byte,\n"
     "      # order, async and missing-asset mutants are refused (PRE has no moved file yet, so none is recorded here).\n"
     "      - name: S9-U0a byte move map and loss, duplication and order mutants (A1)\n"
     "        if: ${{ !cancelled() }}\n"
     "        timeout-minutes: 3\n"
     "        run: python3 scripts/record-run.py --run-dir tmp/workspace-ui-ci/main-move --cwd . --file tests/main_move_test.cjs "
     "--file tests/main_move_contract.cjs --file tests/main_move_spec.json --file tests/page_source.cjs --file tests/page_source.py "
     "--file api/package-lock.json --file worklist-v0/hpacs-lite/main.html -- node --test tests/main_move_test.cjs\n"
     "      # The fixture projection's f1d5406 statement list (the report harness tests read it instead of git history) is the\n"
     "      # f1d5406 page's.\n"
     "      - name: S9-U0a-PRE fixture reference of the report harness tests against the f1d5406 page\n"
     "        if: ${{ !cancelled() }}\n"
     "        timeout-minutes: 3\n"
     "        run: python3 scripts/record-run.py --run-dir tmp/workspace-ui-ci/pre-fixture-reference --cwd . "
     "--file tests/main_split_harness.cjs --file tests/main_split_harness_fixture.json --file tests/page_source.cjs "
     "--file tests/main_move_spec.json --file api/package-lock.json -- node tests/main_split_harness.cjs fixture-check\n"
     "      # REQ-S9-U0a-PRE-ORDER: early inputs, pagehide and window/session events in the gaps of temporary 18/30/45-part\n"
     "      # copies (0/150 ms, held boundaries) end as on the f1d5406 page; registrations equal it per (target, event)\n"
     "      # before and after each session outcome; Retry adds none. No stack, network or credential.\n"
     "      - name: S9-U0a-PRE early input, pagehide and registration order on 18/30/45-part pages against the f1d5406 page\n"
     "        if: ${{ !cancelled() }}\n"
     "        timeout-minutes: 20\n"
     "        run: |\n"
     f"          python3 scripts/record-run.py --run-dir tmp/workspace-ui-ci/pre-early-input-dom --cwd . {PRE_FILES} "
     "-- \"$RUNNER_TEMP/measurement-python/bin/python\" -B tests/main_early_input_dom_test.py -v\n"
     "      # M01-M35 (one moved declaration back at its f1d5406 place), M36 (Retry registers a second Quick Match closure),\n"
     "      # M37 (dictation edit notice after the citation input listener): each killed by its own case, after the unmutated\n"
     "      # page passed the same cases.\n"
     "      - name: S9-U0a-PRE 37 mutants killed by their own early-input, pagehide and registration cases\n"
     "        if: ${{ !cancelled() }}\n"
     "        timeout-minutes: 25\n"
     "        run: |\n"
     f"          python3 scripts/record-run.py --run-dir tmp/workspace-ui-ci/pre-mutants --cwd . {PRE_FILES} "
     "--file tests/main_early_input_mutants.py -- \"$RUNNER_TEMP/measurement-python/bin/python\" -B "
     "tests/main_early_input_mutants.py --out tmp/workspace-ui-ci/pre-mutants.json\n")

# 4. The report harness steps that compile BASE_BLOCK/REPORT_BLOCK now take them by the fixture projection.
for run_dir in ("report-rebase", "report-citation-dom", "report-cursor-insert-dom", "report-cursor-insert-mutants",
                "report-dictation-input-dom", "report-dictation-host-dom", "report-structure-dom", "report-structure-mutants"):
    pattern = re.compile(r"(python3 scripts/record-run\.py --run-dir tmp/workspace-ui-ci/" + re.escape(run_dir) + r" [^\n]*?) -- ")
    found = pattern.findall(text)
    assert len(found) == 1, (run_dir, len(found))
    text = pattern.sub(lambda m: m.group(1) + " " + FIXTURE + " -- ", text, count=1)

# 5. runtime: the rebase model runs in a read-only node container over the checkout; TypeScript must be in api/.
model = ("      - name: Report base-version origin, commit failure routing and refused-head model\n"
         "        run: python3 scripts/record-run.py --run-dir tmp/runtime-ci/report-rebase-model --cwd . "
         "--file worklist-v0/hpacs-lite/main.html --file tests/report_rebase_model_test.cjs -- ")
once(model,
     "      # S9-U0a-PRE: the model takes its base-version run by the fixture projection (TypeScript AST), so the read-only\n"
     "      # container needs api/node_modules from the checkout.\n"
     "      - name: TypeScript for the report harness fixture projection\n"
     "        timeout-minutes: 5\n"
     "        run: npm ci --prefix api --ignore-scripts --no-audit --no-fund\n"
     + model.replace("--file tests/report_rebase_model_test.cjs -- ",
                     "--file tests/report_rebase_model_test.cjs --file tests/main_split_harness.cjs "
                     "--file tests/main_split_harness_fixture.json --file tests/page_source.cjs --file tests/main_move_spec.json "
                     "--file tests/main_move_contract.cjs --file api/package-lock.json -- "))

# 6. dictation-capture: the capture test imports the host test's fixtures (the projection needs TypeScript).
capture_name = "      - name: S3-ASR-U4b fake-device capture, worklet, upload bytes, release and refusals in pinned Chromium\n"
once(capture_name,
     "      # S9-U0a-PRE: the host test's BASE_BLOCK/REPORT_BLOCK come from the fixture projection (TypeScript AST).\n"
     "      - name: TypeScript for the report harness fixture projection\n"
     "        timeout-minutes: 5\n"
     "        run: npm ci --prefix api --ignore-scripts --no-audit --no-fund\n" + capture_name)
once("--file tests/report_dictation_host_dom_test.py --file worklist-v0/hpacs-lite/work-context.js --file worklist-v0/hpacs-lite/session-transport.js "
     "--file worklist-v0/hpacs-lite/report-draft-client.js -- \"$RUNNER_TEMP/capture-python/bin/python\"",
     "--file tests/report_dictation_host_dom_test.py --file worklist-v0/hpacs-lite/work-context.js --file worklist-v0/hpacs-lite/session-transport.js "
     "--file worklist-v0/hpacs-lite/report-draft-client.js " + FIXTURE + " --file tests/page_source.cjs --file tests/main_move_spec.json "
     "--file tests/main_move_contract.cjs -- \"$RUNNER_TEMP/capture-python/bin/python\"")

path.write_text(text.replace("\n", NL), encoding="utf-8")
print("validate.yml edited")
