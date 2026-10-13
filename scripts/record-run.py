#!/usr/bin/env python3
"""Run one command and retain local evidence; never publish or reuse a run directory."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def file_snapshot(paths, cwd):
    result = []
    for requested in paths:
        path = Path(requested)
        if not path.is_absolute():
            path = cwd / path
        item = {"requested": requested, "path": str(path.resolve())}
        try:
            digest, lf_digest = hashlib.sha256(), hashlib.sha256()
            pending = b""
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
                    # Retain a trailing CR so a split CRLF is normalized once.
                    data = pending + block
                    pending = b"\r" if data.endswith(b"\r") else b""
                    if pending:
                        data = data[:-1]
                    lf_digest.update(data.replace(b"\r\n", b"\n"))
            lf_digest.update(pending)
            # Byte-level CRLF -> LF only, including binary inputs. This is not
            # a Git blob id and does not apply attributes or clean filters.
            item.update(status="present", sha256=digest.hexdigest(), lf_sha256=lf_digest.hexdigest())
        except FileNotFoundError:
            item.update(status="missing", sha256=None, lf_sha256=None)
        except OSError as error:
            item.update(status="unreadable", sha256=None, lf_sha256=None, error=str(error))
        result.append(item)
    return result


def tree_snapshot(trees, cwd):
    def regular_files(directory):
        # scandir propagates traversal failures instead of silently omitting inputs.
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    yield from regular_files(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    yield Path(entry.path)

    result = []
    for requested in trees:
        path = Path(requested)
        if not path.is_absolute():
            path = cwd / path
        item = {"requested": requested, "path": str(path.resolve()), "tree": requested}
        try:
            files = sorted(regular_files(path), key=lambda file: file.as_posix())
        except FileNotFoundError:
            item.update(status="missing", sha256=None, lf_sha256=None)
            result.append(item)
        except OSError as error:
            item.update(status="unreadable", sha256=None, lf_sha256=None, error=str(error))
            result.append(item)
        else:
            names = [(Path(requested) / file.relative_to(path)).as_posix() for file in files]
            result.extend(dict(file, tree=requested) for file in file_snapshot(names, cwd))
    return result


def git_head(cwd):
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"], cwd=str(cwd),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, shell=False, timeout=10,
        )
        return result.stdout.decode("ascii").strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, UnicodeDecodeError):
        return None


def write_record(path, record):
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(record, stream, ensure_ascii=True, indent=2)
        stream.write("\n")


def workflow_contract_inputs(files, trees, cwd):
    """D1021: workflow readers consume the full catalogue after job relocation.

    Keep legacy workflow commands byte-identical. Expand only explicitly recorded
    CI contract consumers, and expose the expansion in the manifest. No imports,
    shell execution or general dependency inference is performed here.
    """
    consumers = {
        'tests/measurement_ci.py', 'tests/measurement_ci_test.py',
        'tests/asr_fixture_test.py', 'tests/gateway_pipeline_contract_test.py',
        'tests/gateway_receipt_source_test.py', 'tests/gateway_retry_source_test.py',
        'tests/order_reconciliation_source_test.py', 'tests/study_identity_source_test.py',
        'tests/stage_exit_test.py', 'tests/pacs_split_test.cjs', 'tests/ci_workflows.py',
        'tests/candidate_ci_test.py', 'tests/ci_artifacts.py', 'tests/ci_artifacts_test.py',
        'tests/ci_workflow_consumers.cjs', 'tests/ci_workflow_consumers_test.py',
        'tests/record_run_test.py',
        # They import, load or run a reader above (ci_workflow_consumers_test's import fixpoint).
        'tests/candidate_ci.py', 'tests/execution_guard_test.py', 'tests/execution_selection_test.py',
        'tests/e2e/test_critical_result.py', 'tests/e2e/test_dictation_live.py',
        'tests/report_citation_migration_test.py', 'tests/report_structure_migration_test.py',
        'tests/admin_audit_attribution_test.cjs',
        'tests/admin_member_policy_test.cjs',
        'tests/admin_metrics_test.cjs',
        'tests/clinical_context_model_test.cjs',
        'tests/clinician_policy_test.py',
        'tests/clinician_read_serializer_test.cjs',
        'tests/clinician_request_dom_test.py',
        'tests/clinician_request_mutants.py',
        'tests/context_loss_harness_test.py',
        'tests/critical_result_recipient_dom_test.py',
        'tests/critical_result_sender_dom_test.py',
        'tests/dictation_audio_test.cjs',
        'tests/dictation_refusal_oracle_test.py',
        'tests/e2e/test_compare_reports.py',
        'tests/e2e/test_context_loss.py',
        'tests/e2e/test_display_controls.py',
        'tests/e2e/test_dock_account.py',
        'tests/e2e/test_dock_autohide.py',
        'tests/e2e/test_dock_preferences.py',
        'tests/e2e/test_editor_compare_output.py',
        'tests/e2e/test_embedded_patient_copy.py',
        'tests/e2e/test_favorite_view.py',
        'tests/e2e/test_finding_locations.py',
        'tests/e2e/test_finding_navigation.py',
        'tests/e2e/test_finding_worklist.py',
        'tests/e2e/test_frame_coverage.py',
        'tests/e2e/test_held_measurements.py',
        'tests/e2e/test_image_context_copy.py',
        'tests/e2e/test_key_preview_controls.py',
        'tests/e2e/test_live_print.py',
        'tests/e2e/test_manual_measurements.py',
        'tests/e2e/test_manual_sr.py',
        'tests/e2e/test_measurement_calibration.py',
        'tests/e2e/test_measurement_panel.py',
        'tests/e2e/test_measurement_readback.py',
        'tests/e2e/test_measurement_recheck.py',
        'tests/e2e/test_native_toolbar.py',
        'tests/e2e/test_preview_controls.py',
        'tests/e2e/test_reading_appearance.py',
        'tests/e2e/test_reading_appearance_account.py',
        'tests/e2e/test_reading_colors.py',
        'tests/e2e/test_reading_context.py',
        'tests/e2e/test_reading_flow.py',
        'tests/e2e/test_reading_fonts.py',
        'tests/e2e/test_reading_note.py',
        'tests/e2e/test_reading_note_auto.py',
        'tests/e2e/test_reading_panel_layout.py',
        'tests/e2e/test_reading_preferences.py',
        'tests/e2e/test_reading_tool_focus.py',
        'tests/e2e/test_reading_window_reuse.py',
        'tests/e2e/test_reading_workspace.py',
        'tests/e2e/test_reading_workspace_dock.py',
        'tests/e2e/test_reading_workspace_guard.py',
        'tests/e2e/test_related_keyboard.py',
        'tests/e2e/test_report_preview.py',
        'tests/e2e/test_report_window.py',
        'tests/e2e/test_session_draft_boundaries.py',
        'tests/e2e/test_session_draft_mutants.py',
        'tests/e2e/test_session_worklist_regression.py',
        'tests/e2e/test_shortcut_account.py',
        'tests/e2e/test_sr_provenance.py',
        'tests/e2e/test_standalone_dock.py',
        'tests/e2e/test_study_access_refs.py',
        'tests/e2e/test_study_arrivals.py',
        'tests/e2e/test_thumbnail_requests.py',
        'tests/e2e/test_toolbar_account.py',
        'tests/e2e/test_toolbar_preferences.py',
        'tests/e2e/test_u5_fixups.py',
        'tests/e2e/test_viewer_autoload.py',
        'tests/e2e/test_viewer_cell_merge.py',
        'tests/e2e/test_viewer_display_scope.py',
        'tests/e2e/test_viewer_history.py',
        'tests/e2e/test_viewer_identity.py',
        'tests/e2e/test_viewer_identity_fields.py',
        'tests/e2e/test_viewer_identity_position.py',
        'tests/e2e/test_viewer_image_text.py',
        'tests/e2e/test_viewer_images_only.py',
        'tests/e2e/test_viewer_job_annotations.py',
        'tests/e2e/test_viewer_job_print.py',
        'tests/e2e/test_viewer_job_report.py',
        'tests/e2e/test_viewer_jobs.py',
        'tests/e2e/test_viewer_opening.py',
        'tests/e2e/test_viewer_patient_copy.py',
        'tests/e2e/test_viewer_precision.py',
        'tests/e2e/test_viewer_recovery.py',
        'tests/e2e/test_viewer_tech_note.py',
        'tests/e2e/test_viewer_title.py',
        'tests/e2e/test_viewer_tool_focus.py',
        'tests/e2e/test_viewer_windows.py',
        'tests/e2e/test_volume_average_affine.py',
        'tests/e2e/test_volume_batch.py',
        'tests/e2e/test_volume_batch_context.py',
        'tests/e2e/test_volume_batch_print.py',
        'tests/e2e/test_volume_batch_save.py',
        'tests/e2e/test_volume_batch_scout.py',
        'tests/e2e/test_volume_cine.py',
        'tests/e2e/test_volume_crosshair.py',
        'tests/e2e/test_volume_current_print.py',
        'tests/e2e/test_volume_current_print_failures.py',
        'tests/e2e/test_volume_curved.py',
        'tests/e2e/test_volume_display.py',
        'tests/e2e/test_volume_gesture.py',
        'tests/e2e/test_volume_jobs.py',
        'tests/e2e/test_volume_marks.py',
        'tests/e2e/test_volume_mip.py',
        'tests/e2e/test_volume_mip_batch.py',
        'tests/e2e/test_volume_mip_job.py',
        'tests/e2e/test_volume_mip_orient.py',
        'tests/e2e/test_volume_mip_output.py',
        'tests/e2e/test_volume_mip_voi.py',
        'tests/e2e/test_volume_mpr_print.py',
        'tests/e2e/test_volume_mpr_print_extra.py',
        'tests/e2e/test_volume_mpr_print_failures.py',
        'tests/e2e/test_volume_orientation.py',
        'tests/e2e/test_volume_path.py',
        'tests/e2e/test_volume_patient_copy.py',
        'tests/e2e/test_volume_preferences.py',
        'tests/e2e/test_volume_projection.py',
        'tests/e2e/test_volume_rendering.py',
        'tests/e2e/test_volume_study_workflow.py',
        'tests/e2e/test_volume_sync.py',
        'tests/e2e/test_volume_wheel.py',
        'tests/e2e/test_vr_resize_probe.py',
        'tests/e2e/test_window_return.py',
        'tests/e2e/test_worklist_row_navigation.py',
        'tests/e2e/test_worklist_selection.py',
        'tests/e2e/test_workspace_shortcuts.py',
        'tests/e2e/viewer_precision_support.py',
        'tests/emr/b/ab_latency.cjs',
        'tests/emr/b/ab_sustained.cjs',
        'tests/emr/b/client_pool_test.cjs',
        'tests/emr/b/contract_test.cjs',
        'tests/emr/b/dry_run.py',
        'tests/emr/b/hosted_diagnostics.py',
        'tests/emr/b/hosted_diagnostics_test.py',
        'tests/emr/b/journal_cost.cjs',
        'tests/emr/b/live.py',
        'tests/emr/b/live_acceptance.py',
        'tests/emr/b/live_mutants.py',
        'tests/emr/b/mutants.py',
        'tests/emr/b/noninferiority_test.py',
        'tests/emr/b/performance.py',
        'tests/emr/b/performance_mutants.py',
        'tests/emr/b/performance_test.py',
        'tests/emr/b/quiet_host.py',
        'tests/emr/b/quiet_host_test.py',
        'tests/emr/b/seal_checker.cjs',
        'tests/emr/b/throughput_live.py',
        'tests/emr/b/transaction_options_test.cjs',
        'tests/emr/c/contract_test.cjs',
        'tests/emr/c/mutants.py',
        'tests/emr/c/offline_queue_test.cjs',
        'tests/emr/d/contract_test.cjs',
        'tests/emr/d/mutants.py',
        'tests/emr/e/contract_test.cjs',
        'tests/emr/e/mutants.py',
        'tests/emr/f/contract_test.cjs',
        'tests/emr/f/mutants.py',
        'tests/emr/g/contract_test.cjs',
        'tests/emr/g/mutants.py',
        'tests/emr/h/contract_test.cjs',
        'tests/emr/h/mutants.py',
        'tests/emr_contract_test.cjs',
        'tests/filter_shortcuts_service_test.cjs',
        'tests/main_early_input_dom_test.py',
        'tests/main_early_input_mutants.py',
        'tests/main_move_contract.cjs',
        'tests/main_move_test.cjs',
        'tests/main_split_harness.cjs',
        'tests/main_split_harness.py',
        'tests/main_split_landing_dom_test.py',
        'tests/main_split_static_test.cjs',
        'tests/pacs_source.cjs',
        'tests/pacs_source.py',
        'tests/pacs_split_contract.cjs',
        'tests/pacs_split_modules_test.cjs',
        'tests/part1/mg/model_test.cjs',
        'tests/part1/mg/mutants.py',
        'tests/part1/xa/model_test.cjs',
        'tests/part1/xa/mutants.py',
        'tests/related_layout_dom_test.py',
        'tests/report_actions_dom_test.py',
        'tests/report_citation_dom_test.py',
        'tests/report_cursor_insert_dom_test.py',
        'tests/report_cursor_insert_mutants.py',
        'tests/report_dictation_capture_dom_test.py',
        'tests/report_dictation_host_dom_test.py',
        'tests/report_dictation_input_dom_test.py',
        'tests/report_rebase_dom_test.py',
        'tests/report_rebase_model_test.cjs',
        'tests/report_structure_client_test.cjs',
        'tests/report_structure_dom_test.py',
        'tests/report_structure_mutants.py',
        'tests/report_structure_vectors_test.py',
        'tests/report_version_citation_dom_test.py',
        'tests/report_version_citation_mutants.py',
        'tests/route_inventory_ts.js',
        'tests/service_test_loader.cjs',
        'tests/session_work_gate_test.cjs',
        'tests/study_access_policy_test.cjs',
        'tests/study_arrivals_counts_test.py',
        'tests/study_observation_test.py',
        'tests/tech_note_attempt_service_test.cjs',
        'tests/viewer_cell_merge_dom_test.py',
        'tests/viewer_context_event_service_test.cjs',
        'tests/viewer_ct_sync_test.cjs',
        'tests/viewer_dicom_pdf_dom_test.py',
        'tests/viewer_dicom_pdf_key_test.cjs',
        'tests/viewer_display_scope_dom_test.py',
        'tests/viewer_hanging_protocol_mount_dom_test.py',
        'tests/viewer_image_text_dom_test.py',
        'tests/viewer_image_text_loader_dom_test.py',
        'tests/viewer_image_text_test.cjs',
        'tests/viewer_images_only_dom_test.py',
        'tests/viewer_images_only_loader_dom_test.py',
        'tests/viewer_images_only_test.cjs',
        'tests/viewer_job_print_citation_mutants.py',
        'tests/viewer_jobs_session_test.cjs',
        'tests/viewer_note_connection_test.cjs',
        'tests/viewer_resource_guard_dom_test.py',
        'tests/viewer_session_dom_test.py',
        'tests/viewer_session_fixture.cjs',
        'tests/viewer_tech_note_dom_test.py',
        'tests/viewer_volume_job_capture_test.cjs',
        'tests/volume_curved_test.cjs',
        'tests/volume_mip_batch_test.cjs',
        'tests/volume_mip_job_test.cjs',
        'tests/volume_mip_output_test.cjs',
        'tests/volume_mip_test.cjs',
        'tests/volume_orientation_test.cjs',
        'tests/volume_path_test.cjs',
        'tests/volume_recipe_precision_test.py',
        'tests/worklist_columns_server_test.cjs',
        'tests/worklist_toolbar_dom_test.py',
    }
    requested = set()
    for name in files:
        path = Path(name)
        try:
            requested.add((cwd / path).resolve().relative_to(cwd).as_posix())
        except ValueError:
            pass
    for name in trees:
        directory = (cwd / name).resolve()
        requested.update(consumer for consumer in consumers
                         if (cwd / consumer).is_relative_to(directory))
    if not requested.intersection(consumers):
        return [], []
    extra_files = [name for name in ('tests/ci_workflows.py', 'scripts/record-run.py')
                   if name not in requested]
    extra_trees = [] if '.github/workflows' in trees else ['.github/workflows']
    # The recorder's AST guard scans tests rather than just its own source file.
    if requested.intersection({'tests/record_run_test.py', 'tests/ci_workflow_consumers_test.py'}):
        if 'tests' not in trees:
            extra_trees.append('tests')
        if 'api/package-lock.json' not in requested:
            extra_files.append('api/package-lock.json')
    return extra_files, extra_trees


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "Arguments and output are recorded verbatim. Do not supply secrets or "
        "patient data; review evidence before manually publishing it."
    ))
    parser.add_argument("--run-dir", required=True, help="New, unique output directory")
    parser.add_argument("--cwd", default=".", help="Command working directory")
    parser.add_argument("--file", action="append", default=[], help=(
        "File to hash before and after the command; repeat as needed; relative to --cwd"
    ))
    parser.add_argument("--tree", action="append", default=[], help=(
        "Directory of regular files to hash recursively before and after the command; "
        "repeat as needed; relative to --cwd"
    ))
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- executable argument ...")
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command after -- is required")
    run_dir = Path(args.run_dir).resolve()
    cwd = Path(args.cwd).resolve()
    extra_files, extra_trees = workflow_contract_inputs(args.file, args.tree, cwd)
    try:
        # Exclusive mkdir claims this run before any command or evidence is written.
        run_dir.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        print("Cannot create new run directory: {}".format(error), file=sys.stderr)
        return 125

    record = {
        "schema_version": 1, "command": command, "cwd": str(cwd),
        "status": "preparing", "started_at_utc": None, "ended_at_utc": None,
        "exit_code": None, "recorder_exit_code": None, "launch_error": None,
        "git_head_before": git_head(cwd), "git_head_after": None,
        "files_before": file_snapshot(args.file + extra_files, cwd) + tree_snapshot(args.tree + extra_trees, cwd), "files_after": None,
        "stdout": "stdout.log", "stderr": "stderr.log", "log_files": None,
        "workflow_contract_inputs": {"files": extra_files, "trees": extra_trees},
    }
    metadata = run_dir / "run.json"
    try:
        write_record(metadata, record)
        with (run_dir / "stdout.log").open("xb") as stdout, (run_dir / "stderr.log").open("xb") as stderr:
            record.update(status="running", started_at_utc=utc_now())
            write_record(metadata, record)
            started = time.monotonic()
            try:
                completed = subprocess.run(
                    command, cwd=str(cwd), stdin=subprocess.DEVNULL,
                    stdout=stdout, stderr=stderr, shell=False,
                )
                record.update(status="completed", exit_code=completed.returncode)
                wrapper_exit = completed.returncode
            except OSError as error:
                record.update(status="launch_failed", launch_error={
                    "type": type(error).__name__, "message": str(error),
                    "errno": error.errno,
                })
                wrapper_exit = 127
            record.update(ended_at_utc=utc_now(), duration_seconds=time.monotonic() - started)
        record.update(
            git_head_after=git_head(cwd),
            files_after=file_snapshot(args.file + extra_files, cwd) + tree_snapshot(args.tree + extra_trees, cwd),
            log_files=file_snapshot(["stdout.log", "stderr.log"], run_dir),
        )
        # A successful child is not proof of complete evidence if a requested hash failed.
        if wrapper_exit == 0 and (
            any(item["status"] == "unreadable" for item in record["files_before"] + record["files_after"])
            or any(item["status"] != "present" for item in record["log_files"])
        ):
            wrapper_exit = 125
        # Preserve signal-based child exit in JSON; use its conventional shell exit here.
        if wrapper_exit < 0:
            wrapper_exit = 128 - wrapper_exit
        record["recorder_exit_code"] = wrapper_exit
        write_record(metadata, record)
        return wrapper_exit
    except OSError as error:
        print("Evidence recording failed: {}".format(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
