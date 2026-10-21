# coding: utf-8
"""D1606 R5-M01..M18, the r6 (D1668) R6 faults and retained transfer/context/privacy mutants.

Only the exception's own named behavior assertion can kill a mutant. A test name, setup/precondition timeout,
compile/import error or skip cannot. D1606_SUPERSESSION accounts for every r4 mutant; server/grant mutants remain
separate unchanged suites. Mutants are served as one-off copies, never written over product assets (D73).
A kill counts only in one complete run of this inventory on the final bytes; kills are never carried across runs.
"""
import argparse
import io
import json
import sys
import unittest
from pathlib import Path
import study_transfer_local_dom_test as t
ROOT = Path(__file__).resolve().parents[1]
LITE = ROOT / 'worklist-v0/hpacs-lite'

D1606_SUPERSESSION = {'import-shown-to-a-radiologist': 'retained unchanged',
 'row-import-drops-expect-study': 'retained unchanged',
 'two-uploads-in-flight': 'retained unchanged',
 'more-than-100-files-sent': 'retained unchanged',
 'unconfirmed-sent-again': 'R5-M01/M01-get and M07: spent result cannot regain permission or auto-enqueue.',
 'retry-with-a-new-operation-id': 'superseded by D1606: dispatched same-id retry removed; M11 import new UUID and '
                                  'A01 sibling original operation retained.',
 'may-have-written-says-not-stored': 'R5-M02: dispatched negatives stay unconfirmed; A02 includes '
                                     'may-have-written and raw non-write messages.',
 'panel-takes-focus': 'retained unchanged',
 'copy-id-copies-the-prefix': 'retained: exact complete ID assertion in R5-A07-GET',
 'resolve-shown-to-a-technician': 'retained unchanged',
 'sent-claims-the-file-was-saved': 'retained unchanged',
 'sent-downloaded-again': 'R5-M13/M14 and M15-native-sent: one-shot budget and truthful server Sent; A09 retains '
                          'no old-op Download.',
 'download-enabled-on-a-tele-row': 'retained unchanged',
 'menu-item-acts-on-the-previous-selection': 'retained unchanged',
 'late-answer-written-after-the-context-changed': 'R5-M17-context: real logout preparation rejects late import; '
                                                  'later GET only.',
 'another-person-resumes': 'R5-M17-owner: other sub cannot restore/query/display old operation.',
 'late-grant-clicked': 'R5-M17-document and M17-sequence: context ended or newer read prevents native click.',
 'refusal-notice-wiped-by-its-read': 'superseded by D1606: refusal certificate removed; M13 and M13-poll preserve '
                                     'spent budget after GET and polling.',
 'late-grant-after-the-selection-moved-clicked': 'R5-M17-selection: A-B zero native click.',
 'late-grant-checked-by-the-uid-only': 'R5-M17-selection: A-B-A zero native click, selection sequence remains '
                                       'binding.',
 'manifest-change-keeps-the-stale-download': 'R5-M13-poll: no status/poll restart; A11-valid explicitly includes '
                                             'MANIFEST_CHANGED and A10 new manifest/UUID.',
 'scoped-404-read-as-not-sent': 'R5-M03: ordered A03 scoped 404 cannot restore capability.',
 'status-absence-read-as-not-sent': 'R5-M03: ordered A03 missing index cannot restore capability.',
 'restored-file-read-as-not-sent': 'R5-M05: copied/legacy restore is observation-only.',
 'R4-M01-broad-post-fallback-refused': 'R5-M02: no received-answer Not Sent, including opaque/replaced/partial '
                                       'bodies.',
 'R4-M02-non-write-from-a-status-whitelist': 'R5-M02: no received-answer Not Sent, including typed 413, auth '
                                             'lifecycle and HTTP/body mismatch.',
 'R4-M03-retryable-from-the-outcome-name': 'R5-M01/M01-get: even complete retryable never returns send authority '
                                           '(D1606).',
 'R4-M04-status-rows-bypass-the-validator': 'R5-M10 + A07-GET: status positives require full contract; R5-M01-get '
                                            'blocks negative-derived capability.',
 'R4-M05-scoped-404-read-as-not-sent': 'R5-M03 ordered 404; no old-key permission.',
 'R4-M06-absence-read-as-not-sent': 'R5-M03 missing row and R5-M05 restored descriptors.',
 'R4-M07-old-retry-permission-kept': 'R5-M04/M07: atomic consume and spent-file queue exclusion.',
 'R4-M08-generation-freshness-ignored': 'superseded by D1606: attempt freshness no longer authorizes retry; '
                                        'R5-M01-get/M05 deny old generation in copied/legacy operations.',
 'R4-M09-dispatch-marker-not-kept': 'superseded by D1606: no serialized dispatch capability; R5-M05/M06 '
                                    'restore/storage faults.',
 'R4-M09b-failed-record-write-taken-as-done': 'R5-M06: storage failure cannot restore capability; A05 '
                                              'unavailable-history disclosure and recovery.',
 'R4-M10-controls-from-state-strings': 'R5-M01/M05/M07: rendering/enqueue depend on local capability, not result '
                                       'state.',
 'R4-M11-unknown-resent-by-itself': 'R5-M07: no auto-enqueue of dispatched unknown; A03 timers/reload only read.',
 'R4-M12-retry-never-enabled': 'superseded by D1606 for dispatched retry: R5-M08 positive genuine local '
                               'sent=false; A01 resident siblings still send once.',
 'R4-M13-final-result-taken-back-by-a-read': 'R5-M17-final: validated prior Stored survives missing/unknown '
                                             'status.',
 'R4-M14-typed-413-retried-unchanged': 'R5-M01/M02 A02 typed 413 plus A01 oversized selection; no old-file retry.',
 'R4-M15-grant-ambiguity-called-a-refusal': 'R5-M12/M15: unknown preparation not clearable; invalid grant cannot '
                                            'start native download.',
 'R4-M15b-poll-deadline-as-not-started': 'R5-M13-poll: deadline never restores Download; A11 neutral notice/no '
                                         'non-start certificate.',
 'R4-M16-incomplete-re-download-disabled': 'superseded by D1606: R5-M18-first/M18-new require first native '
                                           'download and explicit new preparation; old incomplete history '
                                           'retained.',
 'R4-M16b-unconfirmed-re-download-disabled': 'superseded by D1606: R5-M18-first/M18-new positive controls; '
                                             'R5-M16-clear retains uncertain history.',
 'grant-kept-in-storage': 'retained unchanged'}

MUTANTS = [('import-shown-to-a-radiologist',
  'study-transfer-local.js',
  "const canImport = () => !app.demo() && app.can('technician');",
  "const canImport = () => !app.demo() && (app.can('technician') || app.can('radiologist'));",
  'test_c01_import_entry_shows_only_for_technician_or_admin_and_the_row_item_names_its_study',
  'C-01 toolbar Import DICOM by role'),
 ('row-import-drops-expect-study',
  'study-transfer-local.js',
  "if (op.expect) headers['X-KIN-Expect-Study'] = op.expect;",
  '',
  'test_c01_import_entry_shows_only_for_technician_or_admin_and_the_row_item_names_its_study',
  'C-01 X-KIN-Expect-Study from the row only'),
 ('two-uploads-in-flight',
  'study-transfer-local.js',
  "if (await inLane(() => send(entry)) === 'stop') break;",
  'void send(entry);',
  'test_c02_one_request_in_flight_one_operation_its_indexes_and_the_bytes_as_chosen',
  'C-02 exactly one upload in flight'),
 ('more-than-100-files-sent',
  'study-transfer-local.js',
  'if (files.length > MAX_FILES) {',
  'if (files.length > 1000) {',
  'test_c02_more_than_100_files_are_refused_before_any_request',
  'C-02 nothing of a 101-file selection is sent'),
 ('panel-takes-focus',
  'study-transfer-local.js',
  "    root.hidden = false;\n    body.hidden = false;\n    hide.textContent = 'Hide';",
  "    root.hidden = false;\n    body.hidden = false;\n    hide.textContent = 'Hide';\n    close.focus();",
  'test_c03_c08_the_panel_never_takes_focus_opens_a_dialog_or_loses_the_draft',
  'C-03 focus stays in the report editor'),
 ('resolve-shown-to-a-technician',
  'study-transfer-local.js',
  "const isAdmin = () => !app.demo() && app.can('admin');",
  "const isAdmin = () => !app.demo() && app.can('technician');",
  'test_c05_resolve_unconfirmed_is_admin_only_sends_the_closed_body_and_shows_the_answer',
  'C-05 hidden from a non-admin'),
 ('sent-claims-the-file-was-saved',
  'study-transfer-local.js',
  "sent: '서버가 이 검사의 모든 원본을 보냈습니다. 내 컴퓨터에 저장됐는지는 브라우저의 다운로드 목록에서 확인하세요.',",
  "sent: '서버가 이 검사의 모든 원본을 보냈고 내 컴퓨터에 저장했습니다.',",
  'test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation',
  'C-06 the Sent sentence'),
 ('download-enabled-on-a-tele-row',
  'context-menu.js',
  '[{ sep: 1 }, { label: "Download Originals", dis: !!s?.tele, act: () => studyTransfer.download(opened.uid) }]',
  '[{ sep: 1 }, { label: "Download Originals", dis: false, act: () => studyTransfer.download(opened.uid) }]',
  'test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation',
  'C-06 disabled on a tele row'),
 ('menu-item-acts-on-the-previous-selection',
  'context-menu.js',
  'if (target && (target.uid !== selectedUid || target.seq !== selectionSeq || target.oid !== selectedOid)) {',
  'if (false) {',
  'test_c06_the_download_item_acts_only_on_the_selection_its_menu_opened_on',
  'C-06 nothing for the old or the new selection'),
 ('grant-kept-in-storage',
  'study-transfer-local.js',
  "      link.href = base + '?grant=' + encodeURIComponent(grant);\n      grant = null;",
  "      link.href = base + '?grant=' + encodeURIComponent(grant);\n"
  "      try { sessionStorage.setItem('kin-study-transfer-grant', grant); } catch (_) {}\n"
  '      grant = null;',
  'test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation',
  'C-06 the grant is never stored'),
 ('R5-M01',
  'study-transfer-local.js',
  '          uncertain(entry, diagnostic(answer?.body, failure ? TEXT.lost : TEXT.unknownAnswer));',
  '          uncertain(entry, diagnostic(answer?.body, failure ? TEXT.lost : TEXT.unknownAnswer)); '
  'unsent.add(entry);',
  'test_r5_a02_all_received_negatives_are_observation_only',
  'R5-A02: no spent retry'),
 ('R5-M02',
  'study-transfer-local.js',
  "    entry.state = 'unresolved';",
  "    entry.state = 'notSent';",
  'test_r5_a02_all_received_negatives_are_observation_only',
  'R5-A02: unconfirmed state'),
 ('R5-M03',
  'study-transfer-local.js',
  '      const rows = importRows(answer, op);',
  '      const rows = importRows(answer, op); if (!rows || !rows.size) for (const e of op.files) unsent.add(e);',
  'test_r5_a03_lost_answer_ordered_status_chain_then_exact_stored',
  'R5-A03: no spent retry'),
 ('R5-M04',
  'study-transfer-local.js',
  ["    unsent.delete(entry);\n    entry.state = 'sending';",
   '    op.inFlight = true;\n    render();\n    const headers ='],
  ["    entry.state = 'sending';",
   '    op.inFlight = true;\n'
   '    if (!entry.reentered) { entry.reentered = true; void send(entry); }\n'
   '    render();\n'
   '    const headers ='],
  'test_r5_a01_spent_file_pauses_two_unsent_siblings_and_atomic_retry_all',
  'R5-A01: pause unsent siblings'),
 ('R5-M05',
  'study-transfer-local.js',
  '          entry.sha256 = hash(f.sha256) ? f.sha256 : null;',
  '          entry.file = new File([new Uint8Array(f.size)], entry.name); unsent.add(entry);\n'
  '          entry.sha256 = hash(f.sha256) ? f.sha256 : null;',
  'test_r5_a04_real_copied_tabs_and_legacy_snapshots_are_read_only',
  'R5-A04: copied unsent descriptor has no capability'),
 ('R5-M06',
  'study-transfer-local.js',
  '    } catch (_) { persistenceFailed = true; }',
  "    } catch (_) { persistenceFailed = true; for (const op of operations) if (op.kind === 'import') for (const "
  'f of op.files) if (f.file) unsent.add(f); }',
  'test_r5_a05_storage_faults_cap_pressure_and_clear_preserve_uncertainty',
  'R5-A05: no spent retry'),
 ('R5-M07',
  'study-transfer-local.js',
  '          uncertain(entry, diagnostic(answer?.body, failure ? TEXT.lost : TEXT.unknownAnswer));',
  '          uncertain(entry, diagnostic(answer?.body, failure ? TEXT.lost : TEXT.unknownAnswer)); '
  "unsent.add(entry); retry(entry); go = 'next';",
  'test_r5_a01_spent_file_pauses_two_unsent_siblings_and_atomic_retry_all',
  'R5-A01: pause unsent siblings'),
 ('R5-M08',
  'study-transfer-local.js',
  '        unsent.add(entry);\n        localUnsent(entry);',
  '        localUnsent(entry);',
  'test_r5_a01_real_transport_sent_false_can_make_its_first_dispatch',
  'R5-A01-local: local continuation available'),
 ('R5-M09',
  'study-transfer-local.js',
  '  function importPositive(r, entry) {',
  '  function importPositive(r, entry) { return null;',
  'test_r5_a07_complete_positive_and_dedup_are_accepted',
  'R5-A07: complete immutable positive accepted'),
 ('R5-M10',
  'study-transfer-local.js',
  '  function importPositive(r, entry) {',
  '  function importPositive(r, entry) { if (isObject(r) && POSITIVE.has(r.outcome)) return r;',
  'test_r5_a07_each_import_positive_field_and_final_attempt_are_required',
  'R5-A07: unconfirmed state'),
 ('R5-M11',
  'study-transfer-local.js',
  'const op = importOperation(crypto.randomUUID(), target.expect ?? null);',
  "const op = importOperation(operations.find(o => o.kind === 'import')?.id || crypto.randomUUID(), target.expect "
  '?? null);',
  'test_r5_a08_explicit_reimport_keeps_old_operation',
  'R5-A08: new UUID'),
 ('R5-M12',
  'study-transfer-local.js',
  'else { op.notice = TEXT.prepareUnknown; readDownload(op, false, true); }',
  "else { op.notice = TEXT.prepareUnknown; op.state = 'sent'; }",
  'test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears',
  'R5-A10: uncertain preparation cannot be discarded'),
 ('R5-M13',
  'study-transfer-local.js',
  '    op.state = view.state;',
  '    op.state = view.state; firstDownloads.add(op);',
  'test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears',
  'R5-A10: prepared GET cannot reset grant budget'),
 ('R5-M14',
  'study-transfer-local.js',
  '        op = op || downloadOperation(kept.id, kept.uid);',
  '        op = op || downloadOperation(kept.id, kept.uid); firstDownloads.add(op);',
  'test_r5_a11_restored_ready_is_read_only',
  'R5-A11: restored Ready read-only'),
 ('R5-M15',
  'study-transfer-local.js',
  '  function grantPositive(answer, op) {',
  '  function grantPositive(answer, op) { if (answer?.body?.grant) return answer.body;',
  'test_r5_a10_every_partial_or_mismatched_grant_has_zero_native_click',
  'R5-A10-grant: malformed grant zero native clicks'),
 ('R5-M16-cap',
  'study-transfer-local.js',
  'operations.filter(op => !finished(op) || confirmed++ < STORE_OPERATIONS)',
  'operations.slice(0, STORE_OPERATIONS)',
  'test_r5_a05_storage_faults_cap_pressure_and_clear_preserve_uncertainty',
  'R5-A05: pending descriptors never pruned'),
 ('R5-M16-clear',
  'study-transfer-local.js',
  "if (op.kind === 'download') return op.state === 'sent';",
  "if (op.kind === 'download') return !!op.state;",
  'test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears',
  'R5-A10: uncertain preparation cannot be discarded'),
 ('R5-M17-owner',
  'study-transfer-local.js',
  '    if (first && sameOwner(first.owner)) {',
  '    if (first) {',
  'test_r5_a06_same_owner_changed_actor_reads_different_owner_never_queries',
  'R5-A06: other owner no query'),
 ('R5-M17-context',
  'study-transfer-local.js',
  '    const applied = work.commit(at, () => {\n'
  '      if (!live(op) || op.gen !== gen) return;\n'
  '      op.inFlight = false;\n'
  '      if (failure',
  '    const applied = ((at, fn) => { fn(); return true; })(at, () => {\n'
  '      if (!live(op) || op.gen !== gen) return;\n'
  '      op.inFlight = false;\n'
  '      if (failure',
  'test_r5_a06_cancelled_logout_discards_late_import_and_preserves_draft',
  'R5-A06-context: no late import during logout preparation'),
 ('R5-M17-sequence',
  'study-transfer-local.js',
  'if (!live(op) || op.gen !== gen || op.readSeq !== seq || !usable()',
  'if (!live(op) || op.gen !== gen || !usable()',
  'test_r5_a12_read_sequence_and_pagehide_discard_valid_grant',
  'R5-A12-sequence: superseded read sequence zero native clicks'),
 ('R5-M17-document',
  'study-transfer-local.js',
  "  window.addEventListener('pagehide', end);",
  '',
  'test_r5_a12_read_sequence_and_pagehide_discard_valid_grant',
  'R5-A12-document: suspended document zero native clicks'),
 ('R5-M17-selection',
  'study-transfer-local.js',
  '      work.commit(pressed, () => {',
  '      work.commit(at, () => {',
  'test_r5_a12_complete_sent_required_and_late_A_B_A_grant_zero',
  'R5-A12: stale selection zero native clicks'),
 ('R5-M17-lifetime',
  'study-transfer-local.js',
  '    firstDownloads.delete(op);\n    pendingClicks.delete(op);',
  '    firstDownloads.delete(op);',
  'test_r5_a12_close_during_grant_does_not_start_a_late_download',
  'R5-A12-close: closed panel cannot start a late native download'),
 ('R5-M17-immediate',
  'study-transfer-local.js',
  '            || JSON.stringify(app.identity()) !== who || !pendingClicks.has(op)) return;',
  '            || JSON.stringify(app.identity()) !== who) return;',
  'test_r5_a12_close_in_native_link_insertion_is_checked_before_click',
  'R5-A12-immediate: lifetime checked immediately before native click'),
 ('R5-M18-first',
  'study-transfer-local.js',
  '    firstDownloads.add(op);',
  '',
  'test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears',
  'R5-A10: first preparation recovered by GET'),
 ('R5-M18-new',
  'study-transfer-local.js',
  "button('Prepare Again', () => download(op.uid))",
  "button('Prepare Again', () => {})",
  'test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears',
  'R5-A10: explicit new preparation works'),
 ('copy-id-copies-the-prefix',
  'study-transfer-local.js',
  '`${entry.op.id} ${entry.index}`',
  '`${entry.op.id.slice(0, 8)} ${entry.index}`',
  'test_r5_a07_status_positive_fields_and_preserved_final',
  'R5-A07-GET: Copy ID keeps full operation/index')]

# Separate mutations retain the GET/final-result/poll/native-event detectors from the r4 contract.
MUTANTS += [
 ('R5-M06-history', 'study-transfer-local.js',
  '      const history = readHistory();\n      added = mergeHistory(history.operations);',
  '      const history = { key: STORE_KEY, operations: [] };',
  'test_r5_a05_failed_restore_read_then_new_operation_preserves_surviving_history',
  'R5-A05-new: failed or unverified read/write never replaces the surviving snapshot'),
 ('R5-M01-get', 'study-transfer-local.js',
  '        else uncertain(entry, diagnostic(row, !rows ? TEXT.unread : TEXT.pending));',
  "        else { uncertain(entry, diagnostic(row, !rows ? TEXT.unread : TEXT.pending)); if (row?.outcome === 'retryable') unsent.add(entry); }",
  'test_r5_a02_all_received_negatives_are_observation_only', 'R5-A02: no spent retry'),
 ('R5-M13-poll', 'study-transfer-local.js',
  "else { stopPolling(op); op.notice = TEXT.notStarted; }",
  "else { stopPolling(op); firstDownloads.add(op); op.notice = TEXT.notStarted; }",
  'test_r5_a11_archive_uncertainty_and_restored_ready_never_rearm', 'R5-A11: malformed status or poll deadline no rearm'),
 ('R5-M15-native-sent', 'study-transfer-local.js',
  "      op.notice = '';\n      op.polls = 0;",
  "      op.notice = '';\n      op.state = 'sent';\n      op.polls = 0;",
  'test_c06_download_items_tele_disabled_ready_browser_download_sent_and_a_new_preparation', 'C-06 native start is not Sent'),
 ('R5-M11-download', 'study-transfer-local.js',
  'const op = downloadOperation(crypto.randomUUID(), uid);',
  "const op = downloadOperation(operations.find(o => o.kind === 'download')?.id || crypto.randomUUID(), uid);",
  'test_r5_a10_lost_prepare_or_grant_never_rearms_or_clears', 'R5-A10: new preparation UUID'),
 ('R5-M17-final', 'study-transfer-local.js',
  ['    if (entry.final) return;', "        if (entry.final || unsent.has(entry) || entry.state === 'sending') continue;"],
  ['', "        if (unsent.has(entry) || entry.state === 'sending') continue;"],
  'test_r5_a07_status_positive_fields_and_preserved_final', 'R5-A07-GET: uncertainty never downgrades final'),
]

# r6 (D1668): OPUS-08's three surviving faults and one fault for every boundary the round repaired (positive history,
# server calendar/recovery time forms, poll ownership, owner-specific kept history, never-invoked capability).
MUTANTS += [
 ('R6-F2-sent-without-finished-response', 'study-transfer-local.js',
  "      if (a.state === 'sent' ? !(hash(a.archiveSha256) && a.responseFinished && a.objectsComplete",
  "      if (a.state === 'sent' ? !(hash(a.archiveSha256) && a.objectsComplete",
  'test_r6_f2_sent_needs_a_finished_response', 'R6-F2: false responseFinished cannot confirm Sent'),
 ('R6-F4-partly-confirmed-clearable', 'study-transfer-local.js',
  '    return op.files.every(f => f.final);',
  '    return op.files.some(f => f.final);',
  'test_r6_f4_a_partly_confirmed_operation_survives_clear_finished', 'R6-F4: Clear Finished retains a partly confirmed operation'),
 ('R6-F9-status-of-another-operation', 'study-transfer-local.js',
  '    if (!complete(answer) || answer.body.operationId !== op.id || ',
  '    if (!complete(answer) || ',
  'test_r6_f9_a_status_of_another_operation_confirms_nothing', 'R6-F9: another operation cannot confirm this file'),
 ('R6-M01-predecessor', 'study-transfer-local.js',
  '      if (i < r.attempts.length - 1 && !retryEnded(a)) return null;\n',
  '',
  'test_r6_a01_contradictory_positive_post_stays_unconfirmed_kept_and_a_later_positive_works',
  'R6-A01-post: contradictory positive is not confirmed'),
 ('R6-M01-transport', 'study-transfer-local.js',
  '      && last.code === null && time(last.finishedAt) && transports.includes(last.transport) ? r : null;',
  '      && last.code === null && time(last.finishedAt) ? r : null;',
  'test_r6_a01_contradictory_positive_post_stays_unconfirmed_kept_and_a_later_positive_works',
  'R6-A01-post: contradictory positive is not confirmed'),
 ('R6-M01-recovery-unresolved', 'study-transfer-local.js',
  "    if (a.code === 'RECOVERED_NO_OBJECT') return a.transport !== 'certain-no-write' && a.recovery !== null && a.recovery.resolvedAt !== null;",
  "    if (a.code === 'RECOVERED_NO_OBJECT') return a.transport !== 'certain-no-write';",
  'test_r6_a01_status_transition_table_is_enforced_by_the_get', 'R6-A01-get: contradictory status is not confirmed'),
 ('R6-M01-ended-without-time', 'study-transfer-local.js',
  "\n          // A running attempt (prepared/dispatching) has no end time; every ended one has its own.\n"
  "          || ['prepared', 'dispatching'].includes(a.phase) !== (a.finishedAt === null)) return null;",
  ') return null;',
  'test_r6_a01_status_transition_table_is_enforced_by_the_get', 'R6-A01-get: contradictory status is not confirmed'),
 ('R6-M02-calendar-rollover', 'study-transfer-local.js',
  '  const time = v => { const at = utcInstant(v); return at !== null && new Date(at).toISOString() === v; };',
  "  const time = v => typeof v === 'string' && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));",
  'test_r6_a02_real_calendar_instants_and_the_recovery_time_forms',
  'R6-A02-time: an instant the server never writes is not confirmed'),
 ('R6-M02-before-1970', 'study-transfer-local.js',
  '    if (year < 1970 || month < 1 ',
  '    if (month < 1 ',
  'test_r6_a02_real_calendar_instants_and_the_recovery_time_forms',
  'R6-A02-time: an instant the server never writes is not confirmed'),
 ('R6-M02-recovery-form-refused', 'study-transfer-local.js',
  '          || utcInstant(a.recovery.checkedAt) === null || !time(a.recovery.requestedAt)',
  '          || !time(a.recovery.checkedAt) || !time(a.recovery.requestedAt)',
  'test_r6_a02_real_calendar_instants_and_the_recovery_time_forms',
  'R6-A02-time: a real instant in its server form is accepted'),
 ('R6-M02-leap-day-refused', 'study-transfer-local.js',
  '    return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day ? at : null;',
  '    return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day'
  ' && !(month === 2 && day === 29) ? at : null;',
  'test_r6_a02_real_calendar_instants_and_the_recovery_time_forms',
  'R6-A02-time: a real instant in its server form is accepted'),
 ('R6-M02-grant-expiry-rollover', 'study-transfer-local.js',
  "/^[A-Za-z0-9_-]{43}$/.test(b.grant) && time(b.expiresAt) ? b : null;",
  "/^[A-Za-z0-9_-]{43}$/.test(b.grant) && Number.isFinite(Date.parse(b.expiresAt)) ? b : null;",
  'test_r6_a02_invalid_calendar_grant_preparation_and_supply_times',
  'R6-A02-grant: only a real expiry instant starts the native download'),
 ('R6-M03-manual-read-leaves-polling', 'study-transfer-local.js',
  '      if (op.polling || polled) {',
  '      if (polled && op.polling) {',
  'test_r6_a03_a_terminal_read_overtaking_a_poll_ends_polling',
  'R6-A03-terminal: a confirmed Sent overtaking a poll is clearable'),
 ('R6-M03-no-successor', 'study-transfer-local.js',
  '        else if (op.polls < DOWNLOAD_START_POLLS) poll(op);',
  '        else if (polled && op.polls < DOWNLOAD_START_POLLS) poll(op);',
  'test_r6_a03_a_nonterminal_read_overtaking_a_poll_leaves_one_successor',
  'R6-A03-successor: exactly one automatic successor read'),
 ('R6-M03-stale-poll-applied', 'study-transfer-local.js',
  '      if (!live(op) || op.gen !== gen || op.readSeq !== seq) return;\n      const view = downloadPositive(answer, op);',
  '      if (!live(op) || op.gen !== gen) return;\n      const view = downloadPositive(answer, op);',
  'test_r6_a03_a_terminal_read_overtaking_a_poll_ends_polling',
  'R6-A03-stale: an overtaken poll changes nothing'),
 ('R6-M07-one-slot-for-all-owners', 'study-transfer-local.js',
  "  const ownerKey = () => STORE_KEY + ':' + JSON.stringify(owner);",
  '  const ownerKey = () => STORE_KEY;',
  'test_r6_a07_a_second_person_in_the_same_tab_keeps_both_histories',
  'R6-A07: the second owner history is kept'),
 ('R6-M07-foreign-history-replaced', 'study-transfer-local.js',
  '    return { key: first ? mine : STORE_KEY, operations: [] };',
  '    return { key: STORE_KEY, operations: [] };',
  'test_r6_a07_a_second_person_in_the_same_tab_keeps_both_histories',
  'R6-A07: the first owner history is untouched'),
 ('R6-M09-never-invoked-lost', 'study-transfer-local.js',
  '      if (live(op) && op.gen === gen && entry.file && sameOwner(app.identity())) { unsent.add(entry); localUnsent(entry); }',
  '',
  'test_r6_a09_a_never_invoked_file_keeps_its_first_send_after_a_cancelled_logout',
  'R6-A09: a never-invoked File is Not Sent, never Not confirmed'),
 ('R6-M09-invoked-restored', 'study-transfer-local.js',
  '      if (failure && failure.sent === false) {',
  '      if (failure) {',
  'test_r6_a09_an_invoked_request_stays_spent',
  'R6-A09-invoked: a lost answer of an invoked request stays spent'),
]

class Attribution(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.behaviors=[]
    def addFailure(self,test,err):
        self.behaviors.append((issubclass(err[0],AssertionError),str(err[1])))
        super().addFailure(test,err)
    def addSubTest(self,test,subtest,err):
        if err is not None:self.behaviors.append((issubclass(err[0],AssertionError),str(err[1])))
        super().addSubTest(test,subtest,err)

def run(selected=None):
    selected = MUTANTS if selected is None else selected
    case=t.TransferPanelPage
    names=sorted({row[4] for row in selected})
    baseline=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(case(n) for n in names))
    if not baseline.wasSuccessful() or baseline.skipped or baseline.testsRun!=len(names):
        print('BASELINE FAILED; no kills claimed',flush=True)
        return 1
    order=json.loads((ROOT/'scripts/main-split-order.json').read_text(encoding='utf-8'))['sources']
    originals={row['file']:(LITE/row['file']).read_text(encoding='utf-8') for row in order}
    results=[]
    try:
        for label,file,old,new,name,assertion in selected:
            source=originals[file] if file in originals else (LITE/file).read_text(encoding='utf-8')
            changed=source
            for before,after in zip(old if isinstance(old,list) else [old],new if isinstance(new,list) else [new]):
                if changed.count(before)!=1:
                    print(json.dumps({'mutant':label,'status':'INVALID','reason':'mutation location not unique'}),flush=True)
                    return 1
                changed=changed.replace(before,after,1)
            case.bundle_source=''.join(changed if r['file']==file else originals[r['file']] for r in order) if file in originals else None
            case.asset_source=(file,changed) if file not in originals else None
            output=io.StringIO()
            result=unittest.TextTestRunner(stream=output,verbosity=2,resultclass=Attribution).run(unittest.TestSuite([case(name)]))
            failures=result.behaviors
            caught=bool(failures) and result.testsRun==1 and not result.errors and not result.skipped and all(
                is_assert and assertion in message and not any(word in message for word in ('not observed','Timeout','timed out','page errors'))
                for is_assert,message in failures)
            row={'mutant':label,'case':name,'named_assertion':assertion,'status':'KILLED' if caught else 'NOT PROVEN',
                 'behavior_failures':[message for _,message in failures],
                 'errors':[trace for _,trace in result.errors], 'skips':[reason for _,reason in result.skipped]}
            if not caught:
                row['reason'] = ('survived its behavioral oracle' if result.wasSuccessful() and not result.skipped
                                 else 'errors, skips or failures not attributable exclusively to the named assertion')
            results.append(row); print(json.dumps(row,ensure_ascii=False),flush=True); print(output.getvalue(),end='')
            # D1620: attribution failures stay NOT PROVEN while remaining variants run. A survivor still stops.
            if result.wasSuccessful() and not result.skipped:return 1
    finally:
        case.bundle_source=None; case.asset_source=None
    killed=sum(row['status']=='KILLED' for row in results)
    print(json.dumps({'killed':killed,'selected':len(selected),'inventory':len(MUTANTS)}),flush=True)
    return 0 if killed==len(selected) else 1

def main():
    sys.stdout.reconfigure(encoding='utf-8',errors='replace'); sys.stderr.reconfigure(encoding='utf-8',errors='replace')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-mutant', choices=[row[0] for row in MUTANTS],
                        help='Resume the ordered inventory at this variant; earlier evidence is not rerun or inferred.')
    args=parser.parse_args()
    start=next((i for i,row in enumerate(MUTANTS) if row[0]==args.from_mutant),0)
    return run(MUTANTS[start:])
if __name__=='__main__':raise SystemExit(main())
