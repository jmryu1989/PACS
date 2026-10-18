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
    ("unconfirmed-sent-again", ASSET, "      if (d.kind === 'result' && entry.outcome === 'unconfirmed') scheduleRecheck(op);",
     "      if (d.kind === 'result' && entry.outcome === 'unconfirmed') { entry.state = 'notSent'; entry.canRetry = true; retry(entry); }",
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
     "if (!saved || (saved.v !== 1 && saved.v !== 2) || JSON.stringify(saved.owner) !== JSON.stringify(owner) || !Array.isArray(saved.operations)) {",
     "if (!saved || (saved.v !== 1 && saved.v !== 2) || !Array.isArray(saved.operations)) {",
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
     "      if (unstarted && said.kind === 'manifest-changed') op.manifestChanged = true;\n", "",
     "test_c06_a_changed_manifest_offers_a_new_preparation_and_keeps_the_old_operation", "C-06"),
    # U4C-03: the 404 of a status read back as "none of its files reached the server" (the r2 reading).
    ("scoped-404-read-as-not-sent", ASSET,
     "view.kind === 'not-shown' ? { kind: 'unknown', notice: TEXT.unresolved }",
     "view.kind === 'not-shown' ? { kind: 'not-sent', canRetry: true, notice: '' }",
     "test_c07_a_lost_answer_of_a_stored_file_and_a_scoped_404_is_never_not_sent", "C-07"),
    # U4C-03b: a 200 status without the file read back as "it never reached the server" (the r2 reading).
    ("status-absence-read-as-not-sent", ASSET,
     "        if (row === undefined) return unknown(TEXT.pending);",
     "        if (row === undefined) return { kind: 'not-sent', proof: 'absence', canRetry: true, notice: '' };",
     "test_c07_a_status_read_without_the_file_leaves_it_undecided", "C-07"),
    # SRU4R3-4 (F4): files restored after a new login made sendable again without any server result.
    ("restored-file-read-as-not-sent", ASSET,
     "const entry = fileEntry(op, f.index, null, String(f.name ?? ''), Number(f.size) || 0, 'unknown');",
     "const entry = fileEntry(op, f.index, null, String(f.name ?? ''), Number(f.size) || 0, 'notSent');",
     "test_c07_a_file_restored_after_a_new_login_without_a_server_result_stays_undecided", "C-07"),
    # D1566 R4-M01..M16: each the inversion of one classifier decision, killed by its acceptance case's assertion.
    ("R4-M01-broad-post-fallback-refused", ASSET,
     "        return unknown(TEXT.unknownAnswer, true);\n      }\n      case 'status': {",
     "        return { kind: 'refused', proof: 'fallback', canRetry: true, notice: TEXT.httpFailure(answer.status), stop: true };\n      }\n      case 'status': {",
     "test_r4_a01_an_answer_that_proves_nothing_never_says_not_sent_or_offers_retry", "C-07"),
    ("R4-M02-non-write-from-a-status-whitelist", ASSET,
     "        const refusal = !answer.ok && isObject(b) && typeof b.code === 'string' && typeof b.message === 'string' && b.message\n          ? REQUEST_REFUSALS[answer.status + ' ' + b.code] : undefined;",
     "        const refusal = !answer.ok && [400, 403, 404, 409, 413, 415, 418, 503].includes(answer.status) ? 'again' : undefined;",
     "test_r4_a01_an_answer_that_proves_nothing_never_says_not_sent_or_offers_retry", "C-07"),
    ("R4-M03-retryable-from-the-outcome-name", ASSET,
     "    else if (o === 'retryable') { if (typeof c !== 'string' || !owns(RETRYABLE_HTTP, c) || written) return null; statuses = RETRYABLE_HTTP[c]; }",
     "    else if (o === 'retryable') { return r; }",
     "test_r4_a01_an_answer_that_proves_nothing_never_says_not_sent_or_offers_retry", "C-07"),
    ("R4-M04-status-rows-bypass-the-validator", ASSET,
     "        const result = validateImportResult(row, entry.op.id, entry.index, null);",
     "        const result = row;",
     "test_r4_a02_a_malformed_or_contradicting_status_row_changes_nothing", "C-07"),
    ("R4-M05-scoped-404-read-as-not-sent", ASSET,
     "view.kind === 'not-shown' ? { kind: 'unknown', notice: TEXT.unresolved }",
     "view.kind === 'not-shown' ? { kind: 'not-sent', canRetry: true, notice: '' }",
     "test_r4_a02_missing_then_404_then_503_then_stored_by_the_status_read_only", "C-07"),
    ("R4-M06-absence-read-as-not-sent", ASSET,
     "        if (row === undefined) return unknown(TEXT.pending);",
     "        if (row === undefined) return { kind: 'not-sent', proof: 'absence', canRetry: true, notice: '' };",
     "test_r4_a02_missing_then_404_then_503_then_stored_by_the_status_read_only", "C-07"),
    ("R4-M07-old-retry-permission-kept", ASSET,
     ["    entry.canRetry = false;\n    entry.fresh = false;", "  function applyImportDecision(entry, d) {\n    entry.canRetry = false;\n"],
     ["    entry.fresh = false;", "  function applyImportDecision(entry, d) {\n"],
     "test_r4_a03_an_older_attempt_retryable_does_not_answer_a_newer_request", "C-07"),
    ("R4-M08-generation-freshness-ignored", ASSET,
     "        if (!FINAL.has(result.outcome) && entry.pending !== null && !(result.generation > entry.pending)) return unknown(TEXT.pending);\n",
     "", "test_r4_a03_an_older_attempt_retryable_does_not_answer_a_newer_request", "C-07"),
    ("R4-M09-dispatch-marker-not-kept", ASSET,
     "generation: Number.isInteger(f.generation) ? f.generation : null, pending: f.pending }))",
     "generation: Number.isInteger(f.generation) ? f.generation : null, pending: null }))",
     "test_r4_a03_an_older_attempt_retryable_does_not_answer_a_newer_request", "C-07"),
    ("R4-M09b-failed-record-write-taken-as-done", ASSET,
     "      try { return sessionStorage.getItem(STORE_KEY) === null; } catch (_) { return true; }",
     "      return true;", "test_r4_a03_a_record_that_cannot_be_updated_stops_the_dispatch", "C-07"),
    ("R4-M10-controls-from-state-strings", ASSET,
     "    return !entry.final && entry.canRetry === true && !queue.includes(entry) && entry.state !== 'sending' && entry.state !== 'waiting';",
     "    return !entry.final && !queue.includes(entry) && (entry.state === 'notSent' || entry.state === 'refused' || (entry.state === 'result' && entry.outcome === 'retryable'));",
     "test_r4_a04_continuation_stays_possible_only_where_a_contract_allows_it", "C-02"),
    ("R4-M11-unknown-resent-by-itself", ASSET,
     "      if (d.readNeeded) readImport(op);",
     "      if (d.readNeeded) { entry.state = 'waiting'; entry.canRetry = true; queue.push(entry); }",
     "test_r4_a01_an_answer_that_proves_nothing_never_says_not_sent_or_offers_retry", "C-07"),
    ("R4-M12-retry-never-enabled", ASSET,
     "      entry.canRetry = d.canRetry === true && !entry.final;\n    } else if (d.kind === 'not-sent'",
     "      entry.canRetry = false;\n    } else if (d.kind === 'not-sent'",
     "test_r4_a04_continuation_stays_possible_only_where_a_contract_allows_it", "C-02"),
    ("R4-M13-final-result-taken-back-by-a-read", ASSET,
     "        if (entry.state === 'sending' || entry.state === 'waiting' || entry.final) continue;",
     "        if (entry.state === 'sending' || entry.state === 'waiting') continue;",
     "test_r4_a02_a_malformed_or_contradicting_status_row_changes_nothing", "C-07"),
    ("R4-M14-typed-413-retried-unchanged", ASSET,
     "'413 DICOM_IMPORT_TOO_LARGE': 'changed'", "'413 DICOM_IMPORT_TOO_LARGE': 'again'", "test_r4_a04_continuation_stays_possible_only_where_a_contract_allows_it", "C-02"),
    ("R4-M15-grant-ambiguity-called-a-refusal", ASSET,
     "        return { kind: 'unknown', notice: TEXT.grantUnknown };",
     "        return { kind: 'refused', notice: TEXT.httpFailure(answer?.status) };", "test_r4_a05_a_download_answer_that_proves_nothing_is_not_called_a_refusal", "C-06"),
    ("R4-M15b-poll-deadline-as-not-started", ASSET,
     "    notStarted: '내려받기가 시작됐는지 확인하지 못했습니다. 브라우저의 다운로드 목록을 확인한 뒤, 필요하면 다시 시도하세요.',",
     "    notStarted: '내려받기가 시작되지 않았습니다. 브라우저의 다운로드 목록을 확인한 뒤 다시 시도하세요.',", "test_r4_a05_a_download_answer_that_proves_nothing_is_not_called_a_refusal", "C-06"),
    ("R4-M16-incomplete-re-download-disabled", ASSET,
     "const RESTARTABLE = ['prepared', 'incomplete', 'unconfirmed'];", "const RESTARTABLE = ['prepared', 'unconfirmed'];",
     "test_c06_incomplete_and_unconfirmed_are_offered_again_for_the_same_operation", "C-06"),
    ("R4-M16b-unconfirmed-re-download-disabled", ASSET,
     "const RESTARTABLE = ['prepared', 'incomplete', 'unconfirmed'];", "const RESTARTABLE = ['prepared', 'incomplete'];",
     "test_c06_incomplete_and_unconfirmed_are_offered_again_for_the_same_operation", "C-06"),
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
        changed = source
        for one_old, one_new in zip(*((old, new) if isinstance(old, list) else ([old], [new]))):
            if changed.count(one_old) != 1:
                raise AssertionError("mutation location not unique: " + label)
            changed = changed.replace(one_old, one_new, 1)
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
