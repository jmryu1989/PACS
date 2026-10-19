# coding: utf-8
"""W5 Related Report mode counterexamples (W5-UI round 1; §V "Minimum counterexamples" and the R1/R2/R3 additions).

Each mutant is a one-off copy of one shipped file served to the page under test (a bundle source through the bundle route,
a standalone asset at its own URL); the product tree is never written. The named behavior case must pass on the shipped
files first (baseline), then fail on the mutant by an assertion (a setup error, a skip or an exception is not a kill).

Not counted here: W5-API-04 (report provide/transfer/display records) is NOT COMPLETED until the shared EMR read adapter
and W9-LITE's view-observations route exist (D1423 R5); no stub stands in for its mutants. The receipt-before-CAS,
tombstone and lock-order mutants of the server are W5-API's (tests/related_report_insert_service_test.cjs).
Redundant layers that no page path can reach on their own are recorded as such, not as kills: the draft client's hold on
ordinary writes beside the page's own save guards (stashReport, the queued write's turn, reconcile, beforeunload); the
mode's own Source sequence check beside the page's stale check; and, during the native edit, the mode's one-shot
admission and the operation's write block beside the shared frame's own `writing` flag, which already refuses every
reentrant editor write in that span (test_w5_reentrant_... proves the combined behavior).
"""
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

import related_report_mode_dom_test as w5

ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / "worklist-v0/hpacs-lite"

# (label, file, old, new, the behavior case that must catch it)
MUTANTS = [
    ("W5A-01-first-pair-trusted", "report-draft-client.js",
     "return receipt.requestHash === hashes.requestHash && receipt.proposalHash === hashes.proposalHash;",
     "return true;", "test_w5r2_first_receipt_hash_must_match_frozen_request"),
    ("W5A-02-incomplete-applied-proof", "report-draft-client.js",
     "if (r.state !== null && (r.requestHash === null || r.proposalHash === null || r.expectedRevision === null\n          || r.receiptRevision === null)) return null;",
     "", "test_w5r2_incomplete_applied_receipt_must_stay_unknown"),
    ("W5A-02-incomplete-tombstone-proof", "report-draft-client.js",
     "const receipt = receiptOf(body, id);", "const receipt = body?.relatedInsert;",
     "test_w5r2_tombstone_proof_fields_are_required_individually"),
    ("W5A-03-frozen-source-ignored", "report-draft-sync.js",
     "return !appState[op.uid]?.identityUnresolved && !appState[op.source.uid]?.identityUnresolved;",
     "return !appState[op.uid]?.identityUnresolved;",
     "test_w5r2_source_identity_is_rechecked_when_discard_reply_arrives"),
    ("W5A-03-transport-admission-removed", "report-draft-client.js",
     "        if (!admit()) return { outcome: 'unsent' };", "",
     "test_w5r2_identity_is_rechecked_after_digest_await_before_transport"),
    ("W5A-03-inverse-focus-retires-unresolved", "report-draft-sync.js",
     '      if (!relatedInsertIdentityResolved(op)) { op.state = "discard-unknown"; return; }', "",
     "test_w5r2_source_identity_on_inverse_focus_after_back_keeps_operation"),
    ("W5A-04-cvr-mode-admission-removed", "critical-result-mounts.js",
     "blocked: () => relatedMode?.active() ? relatedMode.reason() : null", "blocked: () => null",
     "test_w5r2_cvr_unknown_retry_is_blocked_in_related_mode"),
    ("W5A-05-source-provenance-dropped", "related-report-mode.js",
     "const pair = (...values) => values.filter", "const pair = (a, b) => [a, b].filter",
     "test_w5r2_source_card_includes_signer_and_time"),
    ("W5A-06-codepoints-as-utf16", "related_report_mode_dom_test.py",
     'return raw[start * 2:None if end is None else end * 2].decode("utf-16-le", errors="surrogatepass")',
     "return text[start:end]", "test_w5r2_wire_unicode_and_canonical_digest_vectors"),
    ("W5A-06-object-digest", "related_report_mode_dom_test.py",
     'return sha(["related-insert-v1", r["insertRequestId"],',
     'return sha(["wrong-object-contract", r["insertRequestId"],', "test_w5r2_wire_unicode_and_canonical_digest_vectors"),
    ("W5A-07-historical-runtime-as-current", "report-draft-client.js", None,
     "c8e4f1b485ec05ccbb97589c74a573b3f48b70ce", "test_w5r2_runtime_assets_are_current_phase_a_sources"),
    # PAGE-01: only clear/saved enters; an unknown save is not an entry permission.
    ("entry-on-unknown-save", "related-report.js",
     'if (pass.status !== "clear" && pass.status !== "saved") { refuse(pass.status, pass.reason); return; }',
     'if (pass.status === "refused") { refuse(pass.status, pass.reason); return; }\n        if (pass.status === "unknown") break;',
     "test_w5_entry_unknown_save_stays_and_check_reads_then_enters"),
    # D1423 R2: a clean Target with an approval out is not idle.
    ("entry-ignores-a-writer-out", "related-report.js",
     "        if (workBusy() || draftClient.busy(target)) {\n          const left = deadline - Date.now();",
     "        if (false) {\n          const left = deadline - Date.now();",
     "test_w5_entry_waits_for_an_approval_in_flight_and_enters_only_after_its_answer"),
    # Source as editor text.
    ("source-into-the-editor", "related-report.js",
     '$("#prior-findings").textContent = report.findings ?? "";',
     '$("#prior-findings").textContent = report.findings ?? ""; $("#findings").value = report.findings ?? "";',
     "test_w5_entry_from_a_clean_target_shows_two_cards_hides_the_editor_and_focuses_the_title"),
    # A -> B -> A: a late Source answer reaches the screen.
    ("late-source-answer-applied", "related-report.js",
     "const stale = () => !work.admits(at) || seq !== relatedReportSeq || uid !== relatedUid || selectedUid !== currentUid;",
     "const stale = () => false;",
     "test_w5_source_states_load_failed_restricted_none_and_a_late_answer_after_a_source_move"),
    # Source permission: an access refusal shown as a load failure (Retry would never help; the reader is misled).
    ("access-restricted-as-load-failed", "related-report.js",
     "const restricted = e?.status === 403 || e?.status === 404;", "const restricted = false;",
     "test_w5_source_states_load_failed_restricted_none_and_a_late_answer_after_a_source_move"),
    # The Source must be the current approved head.
    ("first-approve-as-source", "related-report.js",
     'const top = (Array.isArray(list) ? list : []).filter(v => v?.action !== "discarded").sort((a, b) => b.version - a.version)[0];',
     'const top = (Array.isArray(list) ? list : []).find(v => ["approve", "addendum"].includes(v?.action));',
     "test_w5_source_is_the_current_approved_head_only"),
    # Old revision Back: Back after an Insert puts back the text the mode was entered with.
    ("back-restores-the-old-text", "related-report-mode.js",
     "      el.focus({ preventScroll: true });\n      if (inserted && el.value === inserted.after) {",
     "      el.focus({ preventScroll: true });\n      if (inserted) el.value = point.value;\n      if (inserted && el.value === inserted.after) {",
     "test_w5_insert_applies_once_with_its_receipt_and_back_returns_to_the_insertion_end"),
    # PAGE-08: direct commit / CVR bypass, late writers.
    ("commit-in-the-mode", "report-commit.js",
     '      const related = relatedCommandBlock(action);\n      if (related) { toast(related, "err"); relatedInsertNotice(selectedUid); return; }',
     "", "test_w5_mode_blocks_every_report_command_shortcut_and_late_writer"),
    ("cvr-in-the-mode", "critical-result-mounts.js",
     "blocked: () => relatedMode?.active() ? relatedMode.reason() : null", "blocked: () => null",
     "test_w5_mode_blocks_every_report_command_shortcut_and_late_writer"),
    ("late-writer-in-the-mode", "order-list-store.js",
     "return relatedMode?.blocked(admission) ?? relatedInsertWriteBlock(selectedUid, admission);",
     "return relatedInsertWriteBlock(selectedUid, admission);",
     "test_w5_mode_blocks_every_report_command_shortcut_and_late_writer"),
    # Reentrant entry: a second entry made while the first waits for the Target's save; the reader's later choice wins.
    ("reentrant-entry-older-wins", "related-report.js",
     "const same = () => ticket === relatedEntrySeq && selectedUid === target", "const same = () => selectedUid === target",
     "test_w5_a_second_entry_while_the_first_waits_is_the_one_that_enters"),
    # PAGE-06: Back is never refused (a Target the refreshed list no longer holds must not strand the reader in the mode).
    ("back-refused-without-a-listed-target", "related-report.js",
     "    function backToCurrentDraft() {\n      const left", "    function backToCurrentDraft() {\n      if (!cur()) return false;\n      const left",
     "test_w5_back_is_never_refused_when_a_refresh_leaves_the_target_out_of_the_list"),
    # body.reading parity: the mode keys treat the list overlay and a hidden Related panel as the panes' keys do.
    ("related-key-leaves-the-panel-hidden", "reading-workspace.js",
     "      if (which === 'prior' && panelValues.relatedHidden) setRelatedHidden(false);\n      closeList();\n      return;",
     "      closeList();\n      return;",
     "test_w5_reading_workspace_panels_follow_the_mode_keys_as_they_follow_the_panes"),
    ("mode-keys-leave-the-list-open", "reading-workspace.js",
     "      if (which === 'prior' && panelValues.relatedHidden) setRelatedHidden(false);\n      closeList();\n      return;",
     "      if (which === 'prior' && panelValues.relatedHidden) setRelatedHidden(false);\n      return;",
     "test_w5_reading_workspace_panels_follow_the_mode_keys_as_they_follow_the_panes"),
    # Return to Current in the mode gives the viewing back to the Target and must also leave the mode.
    ("return-to-current-stays-in-the-mode", "related-report.js",
     "      const left = relatedMode?.exit() ?? null;\n      // 같은 판독 행", "      const left = null;\n      // 같은 판독 행",
     "test_w5_return_to_current_leaves_the_mode_and_gives_the_viewing_back_to_the_target"),
    # PAGE-06 / D1244: Back keeps the Source viewed beside the editor (reading while writing); only Return to Current resets it.
    ("back-forgets-the-viewed-study", "page-boot.js",
     "back: backToCurrentDraft,", "back: returnToReportStudy,",
     "test_w5_escape_closes_the_confirmation_first_then_leaves_and_the_keys_enter_and_back"),
    ("restriction-not-restored", "related-report-mode.js",
     "finally { if (was && held === was) { editor.hidden = true; editor.inert = true; } }", "finally {}",
     "test_w5_reentrant_writes_during_the_native_edit_are_refused_and_the_text_is_exactly_the_insertion"),
    ("sent-before-the-native-edit", "related-report-mode.js",
     "try { applied = withEditor(() => app.edit(frozen, token)) === true; } catch (_) { applied = false; }",
     "app.submit(frozen.op); try { applied = withEditor(() => app.edit(frozen, token)) === true; } catch (_) { applied = false; }",
     "test_w5_native_edit_refusal_restores_hidden_inert_and_focus_and_sends_nothing"),
    # R1: a Retry with a new ID / the same ID with a different payload (rebased on the current revision).
    ("retry-with-a-new-id", "report-draft-sync.js",
     ": await draftClient.relatedInsert(op.uid, op.request, { context, session, admit });",
     ": await draftClient.relatedInsert(op.uid, { ...op.request, relatedInsert: { ...op.request.relatedInsert, insertRequestId: crypto.randomUUID() } }, { context, session, admit });",
     "test_w5_unknown_retry_resends_the_same_id_and_body_and_inserts_once"),
    ("retry-rebased-on-the-current-revision", "report-draft-sync.js",
     ": await draftClient.relatedInsert(op.uid, op.request, { context, session, admit });",
     ": await draftClient.relatedInsert(op.uid, { ...op.request, expectedRevision: (await draftClient.read(op.uid, { context }))?.read?.revision ?? op.request.expectedRevision }, { context, session, admit });",
     "test_w5_lost_then_retry_replays_the_applied_receipt_without_a_second_insertion"),
    # Text-only / receipt-only promotion to Draft Saved.
    ("text-only-promotion", "report-draft-client.js",
     "      if (!ours || !receipt || !matchesInsertHashes(receipt, hashes)) return { outcome: 'unknown', answer, code };",
     "      if (ours && ours.present && sameSnapshot(ours.snapshot, proposalOf(request))) { adopt(line(uid), ours); return { outcome: 'applied', envelope: ours, receipt, answer }; }\n"
     "      if (!ours || !receipt || !matchesInsertHashes(receipt, hashes)) return { outcome: 'unknown', answer, code };",
     "test_w5_same_text_without_a_receipt_is_never_saved"),
    ("receipt-only-promotion", "report-draft-client.js",
     "const proves = receipt.result === 'applied' && receipt.state === 'applied' && receipt.currentMatches === true",
     "const proves = receipt.state === 'applied' || receipt.currentMatches === true",
     "test_w5_superseded_insert_goes_to_the_explicit_conflict_review_never_reapplied"),
    # R1: Discard Insert removes the text before the tombstone is confirmed.
    ("inverse-edit-before-the-tombstone", "report-draft-sync.js",
     '      if (!relatedInsertIdentityResolved(op)) { toast(RELATED_IDENTITY, "err"); return; }\n      relatedInsertSend(op, "discard");',
     '      if (!relatedInsertIdentityResolved(op)) { toast(RELATED_IDENTITY, "err"); return; }\n      relatedInsertReverted(op);\n      relatedInsertSend(op, "discard");',
     "test_w5_discard_insert_tombstone_first_then_exactly_the_inserted_span_is_removed"),
    # Discard offered for an unknown operation (unknown is never proof of no insert).
    ("discard-offered-for-unknown", "report-editor.js",
     'relatedMode?.noticeDiscard(["refused", "discard-unknown"].includes(s) && Number.isSafeInteger(op.receiptRevision) && !unresolved',
     'relatedMode?.noticeDiscard(["refused", "discard-unknown", "unknown"].includes(s) && !unresolved',
     "test_w5_lost_answer_is_unknown_and_check_promotes_only_with_the_receipt_and_the_whole_draft"),
    # R3/R4: the Notice of a refused move forgets the operation, so its Check is W4's text comparison.
    ("notice-forgets-the-operation", "report-editor.js",
     'const op = !notice.action && notice.status !== "composing" ? relatedInsertPending(notice.uid) : null;',
     "const op = null;", "test_w5_pending_insert_holds_decisions_and_the_move_until_check_settles_then_the_move_continues"),
    # R3: a late answer re-renders the editor over later typing.
    ("applied-answer-redraws-the-editor", "report-draft-sync.js",
     '      op.state = "applied";\n      op.at = envelope.updatedAt ?? new Date().toISOString();',
     '      op.state = "applied";\n      op.at = envelope.updatedAt ?? new Date().toISOString();\n'
     '      if (uid === selectedUid) { appState[uid] = { ...a, draft: { ...op.proposal, at: null } }; reportConverge.delete(uid); loadReport({ force: true }); }',
     "test_w5_back_after_an_unknown_insert_keeps_later_typing_and_a_late_check_saves_only_the_insert"),
    # R3/O4-15: Log out preserves an unsettled insert's text as an ordinary draft.
    ("logout-preserves-the-pending-insert", "work-exit.js",
     '          if (relatedInsertPending(report.uid)) { report.reason = "insert"; continue; }', "",
     "test_w5_logout_with_an_unknown_insert_reads_the_receipt_and_never_preserves_it_as_a_draft"),
    # PAGE-10: a double click opens the comparison viewer again.
    ("double-click-opens-images", "related-controls.js", "    function openRelatedImages(uid) {",
     '    $("#relrows").addEventListener("dblclick", e => { const tr = e.target.closest("tr"); if (tr?.dataset.uid) openRelatedImages(tr.dataset.uid); });\n'
     "    function openRelatedImages(uid) {",
     "test_w5_double_click_no_longer_opens_images_and_compare_images_opens_target_and_source"),
]


def run():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    case = w5.RelatedModePage
    names = sorted({row[-1] for row in MUTANTS})
    baseline = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    if not baseline.wasSuccessful() or baseline.skipped:
        print("W5 RELATED MODE BASELINE FAILED; no kills claimed", flush=True)
        return 1
    order = json.loads((ROOT / "scripts/main-split-order.json").read_text(encoding="utf-8"))["sources"]
    originals = {row["file"]: (LITE / row["file"]).read_text(encoding="utf-8") for row in order}
    killed, results = 0, []
    for label, file, old, new, name in MUTANTS:
        case = w5.RelatedModePage
        source = originals[file] if file in originals else ((ROOT / "tests" if file.endswith('.py') else LITE) / file).read_text(encoding="utf-8")
        if old is not None and source.count(old) != 1:
            raise AssertionError("mutation location not unique: " + label)
        changed = source.replace(old, new, 1) if old is not None else subprocess.check_output(
            ['git', 'show', new + ':worklist-v0/hpacs-lite/' + file], cwd=ROOT).decode('utf-8')
        if file.endswith('.py'):
            namespace = {'__name__': 'w5_wire_mutant', '__file__': str(ROOT / 'tests' / file)}
            exec(compile(changed, namespace['__file__'], 'exec'), namespace)
            case = namespace['RelatedModePage']
        elif file in originals:
            case.bundle_source = "".join(changed if row["file"] == file else originals[row["file"]] for row in order)
        else:
            case.asset_source = (file, changed)
        output = io.StringIO()
        try:
            result = unittest.TextTestRunner(stream=output, verbosity=2, failfast=True).run(unittest.TestSuite([case(name)]))
        finally:
            case.bundle_source = None
            case.asset_source = None
        caught = result.testsRun == 1 and bool(result.failures) and not result.errors and not result.skipped
        results.append({"mutant": label, "file": file, "case": name, "killed": caught})
        print(label, file, "KILLED" if caught else "NOT PROVEN", flush=True)
        print(output.getvalue(), end="", flush=True)
        killed += int(caught)
    print("W5-UI-MUTANTS " + json.dumps(results), flush=True)
    print("W5 related report mode mutants killed: %s/%s" % (killed, len(MUTANTS)), flush=True)
    return 0 if killed == len(MUTANTS) else 1


if __name__ == "__main__":
    raise SystemExit(run())
