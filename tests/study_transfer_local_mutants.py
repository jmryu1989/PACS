# coding: utf-8
"""S9-U4b part (c) CT-2: page mutants of the transfer panel, each killed by a named C-row assertion.

Each mutant is a one-off copy of one shipped file, served in place of the real one for one case of
tests/study_transfer_local_dom_test.py (a bundle source is served inside a rebuilt bundle, study-transfer-local.js at
its own URL, as the W4 flow mutants do); no file in the tree is written. A mutant counts as killed only when its case
fails - not errors - and the failure names the C-row it was written for (the assertion messages carry "C-0n"): a
startup error, a timeout without that row's assertion or a skip is NOT PROVEN. The baseline (every named case, on the
shipped files) must pass first, or no kill is claimed.

Run with scripts/record-run.py --tree worklist-v0/hpacs-lite --tree tests: the hashes before and after show the shipped
files were not changed by the run.
"""
import io
import json
import sys
import unittest
from pathlib import Path

import study_transfer_local_dom_test as t

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0/hpacs-lite"
ASSET = "study-transfer-local.js"

# (label, file, old, new, case, row)
MUTANTS = [
    ("import-shown-to-a-radiologist", ASSET, "const canImport = () => !app.demo() && app.can('technician');",
     "const canImport = () => !app.demo() && (app.can('technician') || app.can('radiologist'));",
     "test_c01_import_entry_shows_only_for_technician_or_admin_and_the_row_item_names_its_study", "C-01"),
    ("row-import-drops-expect-study", ASSET, "if (op.expect) headers['X-KIN-Expect-Study'] = op.expect;", "",
     "test_c01_import_entry_shows_only_for_technician_or_admin_and_the_row_item_names_its_study", "C-01"),
    ("two-uploads-in-flight", ASSET, "if (await inLane(() => send(entry)) === 'stop') break;", "void send(entry);",
     "test_c02_one_request_in_flight_one_operation_its_indexes_and_the_bytes_as_chosen", "C-02"),
    ("more-than-100-files-sent", ASSET, "if (files.length > MAX_FILES) {", "if (files.length > 1000) {",
     "test_c02_more_than_100_files_are_refused_before_any_request", "C-02"),
    ("unconfirmed-sent-again", ASSET, "if (entry.outcome === 'unconfirmed') scheduleRecheck(op);",
     "if (entry.outcome === 'unconfirmed') { entry.state = 'notSent'; retry(entry); }",
     "test_c02_an_unconfirmed_file_is_never_sent_again_and_the_panel_reads_the_operation", "C-02"),
    ("retry-with-a-new-operation-id", ASSET, "    entry.state = 'waiting';\n    queue.push(entry);\n    render();\n    pump();\n  }\n\n  /** The one",
     "    entry.state = 'waiting';\n    entry.op.id = crypto.randomUUID();\n    queue.push(entry);\n    render();\n    pump();\n  }\n\n  /** The one",
     "test_c02_a_retryable_file_goes_again_with_the_same_operation_index_and_bytes_and_a_final_one_never", "C-02"),
    ("may-have-written-says-not-stored", ASSET,
     "if (f.outcome === 'rejected' && f.writeDisposition === 'may-have-written') return TEXT.mayHaveWritten;", "",
     "test_c03_display_names_server_messages_unverified_and_may_have_written", "C-03"),
    ("panel-takes-focus", ASSET, "    root.hidden = false;\n    body.hidden = false;\n    hide.textContent = 'Hide';",
     "    root.hidden = false;\n    body.hidden = false;\n    hide.textContent = 'Hide';\n    close.focus();",
     "test_c03_c08_the_panel_never_takes_focus_opens_a_dialog_or_loses_the_draft", "C-03"),
    ("copy-id-copies-the-prefix", ASSET, "const text = `${entry.op.id} ${entry.index}`",
     "const text = `${entry.op.id.slice(0, 8)} ${entry.index}`",
     "test_c04_still_unconfirmed_after_the_recheck_names_the_operation_and_copy_id_copies_it_whole", "C-04"),
    ("resolve-shown-to-a-technician", ASSET, "const isAdmin = () => !app.demo() && app.can('admin');",
     "const isAdmin = () => !app.demo() && app.can('technician');",
     "test_c05_resolve_unconfirmed_is_admin_only_sends_the_closed_body_and_shows_the_answer", "C-05"),
    ("sent-claims-the-file-was-saved", ASSET,
     "sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',",
     "sent: '서버가 이 검사의 모든 원본을 보냈고 내 컴퓨터에 저장했습니다.',",
     "test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation", "C-06"),
    ("sent-downloaded-again", ASSET, "const RESTARTABLE = ['prepared', 'incomplete', 'unconfirmed'];",
     "const RESTARTABLE = ['prepared', 'incomplete', 'unconfirmed', 'sent'];",
     "test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation", "C-06"),
    ("download-enabled-on-a-tele-row", "context-menu.js",
     '[{ sep: 1 }, { label: "Download Originals", dis: !!s?.tele, act: () => studyTransfer.download(opened.uid) }]',
     '[{ sep: 1 }, { label: "Download Originals", dis: false, act: () => studyTransfer.download(opened.uid) }]',
     "test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation", "C-06"),
    # The row menu's item runs on the selection its menu was opened on (W4 MENU-TARGET), also for Download Originals.
    ("menu-item-acts-on-the-previous-selection", "context-menu.js",
     "if (target && (target.uid !== selectedUid || target.seq !== selectionSeq || target.oid !== selectedOid)) {",
     "if (false) {", "test_c06_the_download_item_acts_only_on_the_selection_its_menu_opened_on", "C-06"),
    ("late-answer-written-after-the-context-changed", ASSET,
     "    let go = 'next';\n    const applied = work.commit(at, () => {",
     "    let go = 'next';\n    const applied = (effect => (effect(), true))(() => {",
     "test_c07_an_answer_from_before_a_cancelled_logout_preparation_is_not_shown_the_server_is_read_instead", "C-07"),
    ("another-person-resumes", ASSET,
     "if (!saved || saved.v !== 1 || JSON.stringify(saved.owner) !== JSON.stringify(owner) || !Array.isArray(saved.operations)) {",
     "if (!saved || saved.v !== 1 || !Array.isArray(saved.operations)) {",
     "test_c07_the_same_person_resumes_after_a_new_login_another_person_never_sees_the_operation", "C-07"),
    # D1489 DG-M10: the grant's answer clicks its link only while the context, the sequence and the person still hold.
    ("late-grant-clicked", ASSET,
     "    const applied = work.commit(at, () => {\n      if (!live(op) || op.gen !== gen) return;\n      op.inFlight = false;\n"
     "      if (op.readSeq !== seq || !usable() || JSON.stringify(app.identity()) !== who) { render(); return; }",
     "    const applied = (effect => (effect(), true))(() => {\n      if (!live(op) || op.gen !== gen) return;\n      op.inFlight = false;\n"
     "      if (false) { render(); return; }",
     "test_c06_a_late_or_refused_grant_starts_nothing_and_the_status_says_why", "C-07"),
    # A refused or lost grant is a notice; the status read that follows it must not wipe it (hosted G3/CI on b64abb4).
    ("refusal-notice-wiped-by-its-read", ASSET, "        readDownload(op, false, true);", "        readDownload(op);",
     "test_c06_a_late_or_refused_grant_starts_nothing_and_the_status_says_why", "C-06"),
    # U4C-04: the press belongs to the study selection it was made in; a grant answered after A->B or A->B->A clicks nothing.
    ("late-grant-after-the-selection-moved-clicked", ASSET, "      if (grant && !work.admits(pressed)) {", "      if (false) {",
     "test_c06_a_grant_answered_after_the_selection_moved_starts_no_download", "C-07"),
    # ... and A->B->A is another selection: a check of the UID alone would click after coming back to A.
    ("late-grant-checked-by-the-uid-only", ASSET, "      if (grant && !work.admits(pressed)) {",
     "      if (grant && pressed.uid !== work.selection().uid) {",
     "test_c06_a_grant_answered_after_the_selection_moved_starts_no_download", "C-07"),
    # U4C-02: a refused MANIFEST_CHANGED operation is replaced by a new preparation, never offered for download again.
    ("manifest-change-keeps-the-stale-download", ASSET,
     "      if (unstarted && request.code === 'MANIFEST_CHANGED') op.manifestChanged = true;\n", "",
     "test_c06_a_changed_manifest_offers_a_new_preparation_and_keeps_the_old_operation", "C-06"),
    # U4C-03: the 404 of a status read back as "none of its files reached the server" (the r2 reading).
    ("scoped-404-read-as-not-sent", ASSET,
     "&& Array.isArray(answer.body.files) ? answer.body.files : null;",
     "&& Array.isArray(answer.body.files) ? answer.body.files : !failed && answer.status === 404 ? [] : null;",
     "test_c07_a_lost_answer_of_a_stored_file_and_a_scoped_404_is_never_not_sent", "C-07"),
    # U4C-03b: a 200 status without the file read back as "it never reached the server" (the r2 reading).
    ("status-absence-read-as-not-sent", ASSET,
     "          entry.state = 'unresolved';\n          entry.message = TEXT.pending;",
     "          entry.state = 'notSent';\n          entry.message = '';",
     "test_c07_a_status_read_without_the_file_leaves_it_undecided", "C-07"),
    # The grant lives in memory and the one link only.
    ("grant-kept-in-storage", ASSET,
     "      link.href = base + '?grant=' + encodeURIComponent(grant);\n      grant = null;",
     "      link.href = base + '?grant=' + encodeURIComponent(grant);\n"
     "      try { sessionStorage.setItem('kin-study-transfer-grant', grant); } catch (_) {}\n      grant = null;",
     "test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation", "C-06"),
]


def run():
    case = t.TransferPanelPage
    names = sorted({row[4] for row in MUTANTS})
    baseline = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    if not baseline.wasSuccessful() or baseline.skipped or baseline.testsRun != len(names):
        print("S9-U4B-C MUTANT BASELINE FAILED; no kills claimed")
        return 1
    order = json.loads((ROOT / "scripts/main-split-order.json").read_text(encoding="utf-8"))["sources"]
    originals = {row["file"]: (LITE / row["file"]).read_text(encoding="utf-8") for row in order}
    killed = []
    for label, file, old, new, name, row in MUTANTS:
        source = originals[file] if file in originals else (LITE / file).read_text(encoding="utf-8")
        if source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        changed = source.replace(old, new, 1)
        case.bundle_source = "".join(changed if r["file"] == file else originals[r["file"]] for r in order) if file in originals else None
        case.asset_source = (file, changed) if file not in originals else None
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(unittest.TestSuite([case(name)]))
        text = output.getvalue()
        named = any(row in failure for _, failure in result.failures)
        caught = result.testsRun == 1 and len(result.failures) == 1 and not result.errors and not result.skipped and named
        print(label, file, row, "KILLED" if caught else "NOT PROVEN", flush=True)
        print(text, end="")
        if caught:
            killed.append(label)
    case.bundle_source = None
    case.asset_source = None
    print("S9-U4B-C page mutants killed by their named C-row: %d/%d" % (len(killed), len(MUTANTS)))
    return 0 if len(killed) == len(MUTANTS) else 1


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    return run()


if __name__ == "__main__":
    raise SystemExit(main())
