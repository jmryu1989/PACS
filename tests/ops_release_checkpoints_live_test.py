"""RELEASE-TOOLS-CHECKPOINTS live leaves (Astra spec D1336 T16/T17). Opt-in and native Linux only: every leaf needs the
process-local permission of scripts/run-tests.py (live mode, one exact selection from the frozen leaf registry),
KIN_TEST_EMR_CHECKPOINTS=1, the four rehearsal images and KIN_TEST_EMR_CHECKPOINT_REQUEST (a selection input, never a
permission). Elsewhere every leaf is skipped with its reason; importing or collecting this module runs nothing.

One leaf = one stage in a new process: admission strictly before any restore (gate and marker, the request's parent
lineage, the executing source bytes, the runtime and module origins, the parent bundle with its plan/target/B0 recomputed
from its own bytes, host and daemon, identity, time); the cold restore of the parent checkpoint and the re-observation of
its product facts; the stage's real product phases; a new checkpoint at the completed boundary; owned-resource cleanup
with observed absence; the raw product records preserved into the evidence before the private fixture is removed; one
segment.json announced on stdout. Same-tool resumes are checkpoint-resume, a changed tool is a diagnostic fork from
`introduced` (or `held`) only; neither is ever a fresh end-to-end pass. The two proofs: T16 (late-change resume equals
B's fresh forward verdict) and T17 (an earlier change is refused before any restore or resource creation). The exact
command sequence: `tests/ops_release_checkpoints.py commands` (tests/README.md, RELEASE-TOOLS-CHECKPOINTS).
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))
import live_test_gate as gate  # noqa: E402
import ops_release_checkpoints as cp  # noqa: E402
import ops_deploy_host_container_test as rehearsal  # noqa: E402

intro = cp.intro
REGISTRY_ENV = "KIN_TEST_EMR_CHECKPOINT_REGISTRY"
ENABLED = (sys.platform.startswith("linux") and os.environ.get(cp.OPT_IN_ENV) == "1"
           and all(os.environ.get(name) for name in rehearsal.REHEARSAL_IMAGES))
SKIP_REASON = ("opt-in RELEASE-TOOLS-CHECKPOINTS leaf: native Linux with KIN_TEST_EMR_CHECKPOINTS=1, the four rehearsal images and "
               "KIN_TEST_EMR_CHECKPOINT_REQUEST, run through scripts/run-tests.py (Windows/Docker Desktop: UNSUPPORTED_HOST)")
CONTEXT_FILE, SECRETS_INVENTORY, LINEAGE_STACK = cp.CONTEXT_FILE, cp.SECRETS_INVENTORY, cp.LINEAGE_STACK
SUFFIX_SECONDS, TEARDOWN_SECONDS = 3000, 300


def registry():
    """The commander's frozen leaf registry (KIN_TEST_EMR_CHECKPOINT_REGISTRY), else the harness's proof leaves."""
    path = os.environ.get(REGISTRY_ENV)
    return cp.registry_valid(json.loads(Path(path).read_bytes()) if path else list(cp.DEFAULT_PROOF_LEAVES))


def tool_tree_files(root):
    return {name: (Path(root) / name).read_bytes() for name in cp.tracked_files(root, "scripts/")}


def tool_tree_from_archive(path):
    with tarfile.open(path, "r:") as archive:
        return {member.name: archive.extractfile(member).read() for member in cp.archive_members(path) if member.isfile()}


def executing_modules():
    return {"ops_emr_introduction": intro, "ops_release_checkpoints": cp, "ops_deploy_host_container_test": rehearsal,
            "ops_release_checkpoints_live_test": sys.modules[__name__], "live_test_gate": gate}


@unittest.skipUnless(ENABLED, SKIP_REASON)
class CheckpointSegments(rehearsal.RehearsalStages, unittest.TestCase):
    def test_source_checkpoint(self):
        self.segment("source")

    def test_seed_checkpoint(self):
        self.segment("seed")

    def test_capture_checkpoint(self):
        self.segment("capture")

    def test_introduce_checkpoint(self):
        self.segment("introduce")

    def test_verify_checkpoint(self):
        self.segment("verify")

    def test_normal_tail(self):
        self.segment("normal-tail")

    def test_forward_tail(self):
        self.segment("forward-tail")

    def test_forced_capture(self):
        self.segment("forced-capture")

    def test_forced_tail(self):
        self.segment("forced-tail")

    def test_original_late_fault(self):
        """T16 late-fault: A's verified checkpoint restored cold (same tree) and its forward tail meets the expected L-11a
        STOP (mutant A's backup_readiness): status VERIFIED, no point of no return. One execution, both controls."""
        self.segment("forward-tail", expect_stop="L-11a")

    def test_late_change_resume(self):
        """T16 late-resume: B (the unmodified candidate) forks A's introduced checkpoint, re-runs verify with its own
        smoke under its own plan, then reopen and the ordinary recreate; compared with B's fresh forward control."""
        self.segment("verify", then=("forward-tail",))

    def test_earlier_change_refused(self):
        """T17: input C (HostOps.prepare changed) against A's introduced checkpoint: PREFIX_CHANGED before any restore,
        volume, container or phase; the bundle, the daemon inventory and the fixture root stay as they were."""
        self.segment("verify", refusal=True)

    # ── one leaf ──

    def segment(self, stage, *, expect_stop=None, then=(), refusal=False):
        gate.require_live_run()
        case = "CheckpointSegments." + self._testMethodName
        leaves = registry()
        # The request's parent checkpoint kind and lineage are checked here, before anything is read from the bundle.
        request, request_sha256 = cp.load_request(os.environ.get(cp.REQUEST_ENV), leaves, case=case)
        leaf = cp.registry_leaf(leaves, request["unit"])
        marker = cp.bind_marker(gate, request)
        started = cp.now_utc().isoformat()
        output, evidence = Path(request["output_root"]), Path(request["evidence_root"])
        evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
        fixture_root = output / "fixture"
        store = cp.BundleStore(output / "bundles", forbidden=[fixture_root, evidence, gate.STATE])
        source = json.loads(Path(request["source_manifest"]["path"]).read_bytes())
        actual = cp.source_identity(ROOT)
        cp.require(all(source[key] == actual[key] for key in ("tool", "source", "harness", "tool_files")), "SOURCE_MISMATCH",
                   "the executing bytes are not the request's source manifest")
        inputs_before = cp.inputs_summary(ROOT)
        runtime = cp.runtime_identity(rehearsal.CheckpointDocker.runtime_facts(), modules=executing_modules(), root=ROOT)
        manifest = parent_dir = None
        chain, bundle_facts = [], None
        if request["parent_manifest"]:
            manifest, parent_dir = cp.load_bundle(Path(request["parent_manifest"]["path"]).parent)
            # Plan, target and both B0 recomputed from the bundle's own bytes (CKPT-04), and its lineage walked (CKPT-03).
            bundle_facts = cp.bundle_inputs(manifest, parent_dir)
            chain = cp.parent_chain(store.root, parent_dir.name)
        facts = rehearsal.CheckpointDocker.host_facts(fixture_root)
        expected = None
        if manifest:
            recorded = manifest["identity"]
            expected = {"host_key_sha256": recorded["host_key_sha256"], "daemon_identity": recorded["daemon_identity"],
                        "architecture": recorded["runtime_identity"].get("arch"), "absolute_fixture_root": recorded["absolute_fixture_root"]}
        cp.stage_entry(gate, facts, expected)
        rehearsal.ops.require_local_docker()  # the product's own local-daemon rule as well (CKPT-01)
        helper = self.image_id("postgres:16-alpine")
        # r5: what every observation request of this leaf names (consult-checkpoints-r5-20261016 observe_fix).
        observation_leaf = {"unit": request["unit"], "case": case, "attempt": marker["attempt"], "stage": stage}
        observation_source = {key: actual[key]["sha256"] for key in ("tool", "source", "harness")}
        cleanup, executed, inherited, results, admission = {"complete": False}, [], [], {}, None
        observed_outcome, passed, ctx, records, before_names = {"outcome": "PASS"}, False, None, {}, {}
        current, restoring = None, False
        try:
            if manifest is not None:
                inherited = cp.leaf_phases(leaf)[1]
                # r9: an absent or mistyped time is TIME_INVALID (cp.utc), never a KeyError (the loader typed the boundary).
                cp.time_admission(created_utc=manifest["identity"]["created_utc"], window_end=manifest["boundary"].get("window_end"),
                                  tls_not_after=manifest["boundary"].get("tls_not_after"), suffix_seconds=SUFFIX_SECONDS,
                                  teardown_seconds=TEARDOWN_SECONDS)
                observed = self.observed_identity(manifest, actual, facts, helper, runtime, bundle_facts)
                cp.require(any(member["name"] == "tool-tree.tar" for member in manifest["members"]), "BUNDLE_INVALID",
                           "the parent bundle carries no tool tree")
                old_tool = tool_tree_from_archive(parent_dir / "payload" / "tool-tree.tar")
                cp.require(cp.tree_manifest_from_bytes(old_tool)["sha256"] == manifest["identity"]["tool_tree_sha256_at_checkpoint"],
                           "BUNDLE_INVALID", "the parent's tool bytes differ from its identity")
                suffix = [phase for name in (stage, *then) for phase in cp.STAGES[name]["phases"]]
            if refusal:
                cp.require(manifest is not None, "REQUEST_INVALID", "a refusal proof consumes a parent checkpoint")
                current = cp.current_identity(inputs_before, execution_kind=request["execution_kind"], plan_sha256=None, root=ROOT,
                                              resumed_utc=cp.now_utc().isoformat())
                inventory_before = rehearsal.CheckpointDocker(None, helper).inventory()
                self.refuse_earlier_change(manifest, parent_dir, observed, old_tool, suffix, fixture_root, inventory_before, helper)
                observed_outcome = {"outcome": "REFUSED", "code": "PREFIX_CHANGED"}
                cleanup = {"complete": True, "removed": [], "remaining": [], "errors": []}
            else:
                if manifest is not None:
                    decision = cp.admit_resume(manifest, observed, old_tool_files=old_tool, new_tool_files=tool_tree_files(ROOT),
                                               suffix_phases=suffix, parent_manifest_sha256=parent_dir.name, source_root=ROOT)
                    cp.require(decision["execution_kind"] == request["execution_kind"]
                               or (decision["execution_kind"] == "checkpoint-resume" and request["execution_kind"] == "reseed-from-recorded-b0"),
                               "REQUEST_INVALID", "the admission kind differs from the request")
                    admission = decision.get("admission")
                    if admission:
                        (evidence / "admission.json").write_bytes(cp.canonical(admission) + b"\n")
                    resumed_utc = (decision.get("identity") or {}).get("resumed_utc") or admission["admitted_utc"]
                    # D1034 again directly before the first mutation.
                    cp.host_admission(rehearsal.CheckpointDocker.host_facts(fixture_root), expected)
                    restoring = True
                    ctx, results["restore"] = self.restore(manifest, parent_dir, fixture_root, helper, leaf=observation_leaf,
                                                           source=observation_source)
                    if admission:
                        self.fork(ctx, manifest)
                else:
                    cp.require(not fixture_root.exists(), "RESOURCE_EXISTS", str(fixture_root))
                    fixture_root.mkdir(mode=0o700, parents=True)
                    ctx = self.rehearsal_context("unused", root=fixture_root)
                    resumed_utc = None
                records = self.records_of(ctx)
                before_names = cp.result_names(records)
                for name in (stage, *then):
                    if expect_stop:
                        reopened = ctx.clone.phase("reopen", "VERIFIED")
                        steps = [(step["step"], step["outcome"]) for step in reopened["steps"]]
                        self.assertEqual(steps, [(expect_stop, "STOP")], "the deterministic late fault of input A")
                        self.assertIsNone(ctx.clone.records.state()["ponr"])
                        observed_outcome = {"outcome": "STOP", "step": expect_stop}
                    else:
                        self.stage_table()[name](ctx)
                    executed += list(cp.STAGES[name]["phases"])
                stack = getattr(ctx, "failure" if leaf["scenario"] == "forced" else "source" if stage == "source" else "clone")
                current = cp.current_identity(inputs_before, execution_kind=request["execution_kind"], plan_sha256=stack.plan_sha256,
                                              root=ROOT, resumed_utc=resumed_utc,
                                              admission_sha256=cp.sha256(cp.canonical(admission)) if admission else None)
                produces = cp.leaf_produces(leaf)
                if produces:
                    produced = self.capture(produces, ctx, store, fixture_root, actual, facts, helper, manifest, parent_dir, request, runtime,
                                            leaf=observation_leaf, source=observation_source)
                    results["checkpoint"] = {"path": str(produced), "manifest_sha256": produced.name}
            passed = True
        finally:
            if not refusal:
                cleanup = self.cleanup(ctx, helper)
                if ctx is None and restoring:
                    # A restore that failed part-way: its resources carry the checkpoint's own token and project labels.
                    owned = manifest["owned"]
                    cleanup = cp.cleanup_owned(rehearsal.CheckpointDocker(None, helper),
                                               {"token": owned["token"], "projects": owned["projects"]})
            records = self.records_of(ctx) if ctx is not None else {}
            if current is None:
                current = cp.current_identity(inputs_before, execution_kind=request["execution_kind"], plan_sha256=None, root=ROOT,
                                              resumed_utc=cp.now_utc().isoformat())
            record, _ = cp.close_leaf(
                gate, request=request, request_sha256=request_sha256, marker=marker,
                identity=cp.segment_identity(current, parent_manifest=manifest, parent_dir=parent_dir), executed=executed,
                inherited=inherited, phase_rows=cp.phase_results(records, before_names) if records else [], results=results,
                admission=admission, cleanup=cleanup, observed=observed_outcome, expected=cp.leaf_outcome(leaf), records=records,
                evidence=evidence, fixture_root=fixture_root, output_root=output, source_root=ROOT, inputs_before=inputs_before,
                run_json=os.environ.get("KIN_TEST_EMR_CHECKPOINT_RUN_JSON", ""), started_utc=started, selected_tests=[case],
                passed=passed, chain=chain)
        self.assertTrue(record["passed"], json.dumps({"cleanup": cleanup, "inputs_unchanged": record["inputs_unchanged"]}))

    @staticmethod
    def records_of(ctx):
        return {name: getattr(ctx, name).records.directory for name in ("source", "clone", "failure") if hasattr(ctx, name)}

    def observed_identity(self, manifest, actual, facts, helper, runtime, bundle_facts):
        """Facts observed now: the source trees and tool files from the executing bytes, the image IDs re-inspected, the
        host, daemon, root and runtime from the host, and plan/target/B0 recomputed from the bundle's own bytes
        (cp.bundle_inputs), so no field is the parent's claim copied back."""
        recorded = manifest["identity"]
        images = {**self.rehearsal_images(), "helper": helper}
        return {**recorded, "tool_tree_sha256_at_checkpoint": actual["tool"]["sha256"], "source_tree_sha256": actual["source"]["sha256"],
                "harness_tree_sha256": actual["harness"]["sha256"], "tool_files_actual_raw_sha256": actual["tool_files"],
                "image_ids": images, "host_key_sha256": facts["host_key_sha256"], "daemon_identity": facts["daemon_identity"],
                "absolute_fixture_root": facts["absolute_fixture_root"], "runtime_identity": runtime,
                "plan_sha256": bundle_facts["plan_sha256"], "target_manifest_sha256": bundle_facts["target_manifest_sha256"],
                "source_b0_manifest_sha256": bundle_facts["source_b0_manifest_sha256"],
                "clone_b0_manifest_sha256": bundle_facts["clone_b0_manifest_sha256"]}

    def rehearsal_images(self):
        shared = {"db": self.image_id("postgres:16-alpine"), "keycloak": self.image_id("quay.io/keycloak/keycloak:26.7.3"),
                  "orthanc": self.image_id("orthancteam/orthanc:24.12.0")}
        return {"previous": {"api": self.image_id(os.environ["KIN_TEST_PREVIOUS_API_IMAGE"]),
                             "proxy": self.image_id(os.environ["KIN_TEST_PREVIOUS_PROXY_IMAGE"]), **shared},
                "release": {"api": self.image_id(os.environ["KIN_TEST_API_IMAGE"]), "proxy": self.image_id(os.environ["KIN_TEST_PROXY_IMAGE"]),
                            **shared}}

    def restore(self, manifest, parent_dir, fixture_root, helper, *, leaf=None, source=None):
        """Cold restore, then the product facts observed at the checkpoint observed again (only container IDs may differ;
        their old -> new correspondence is returned for the segment)."""
        holder = {}

        def load(root):
            holder["ctx"] = self.load_context(root)
            return getattr(holder["ctx"], LINEAGE_STACK[manifest["checkpoint"]])
        stack, _, mapping = restore_boundary(manifest, parent_dir, fixture_root=fixture_root, helper=helper, load=load, leaf=leaf,
                                             source=source)
        ctx = holder["ctx"]
        identity = manifest["identity"]
        state = stack.records.state()
        self.assertEqual(stack.plan_sha256, identity["plan_sha256"])
        self.assertEqual(state["plan_sha256"], identity["plan_sha256"])
        for name in json.loads((fixture_root / SECRETS_INVENTORY).read_bytes()):
            path = fixture_root / name["path"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), name["sha256"], "restored secret " + name["path"])
        # No login, session or token is carried over: the next phase's own smoke logs in after this restore.
        return ctx, mapping

    def fork(self, ctx, manifest):
        """The diagnostic fork on this leaf's private restored copy: child plan with B's actual tool, a new ComposeEntry
        generation, the child state with an empty history; the parent bundle is never written."""
        clone = getattr(ctx, LINEAGE_STACK[manifest["checkpoint"]])
        parent_plan, parent_sha = clone.plan_document, clone.plan_sha256
        child_plan, child_sha = cp.fork_plan(parent_plan, cp.tool_files_raw(ROOT))
        self.assertEqual(child_plan["tool"], intro.tool_hashes())
        state = clone.records.state()

        def validate(command, environment):
            rendered = subprocess.run(command, env={**cp.daemon_environment(), **environment}, capture_output=True, check=True,
                                      timeout=60).stdout
            self.assertIsInstance(json.loads(rendered), dict)
        pointer = cp.fork_compose_entry(clone.root / "compose-entries", state["compose_entry"], parent_plan_sha256=parent_sha,
                                        child_plan_sha256=child_sha, validate=validate)
        child_state = cp.fork_state(state, checkpoint_id=manifest["checkpoint"], child_plan_sha256=child_sha, child_pointer=pointer)
        self.assertTrue(cp.receipt_refused(child_state, child_plan, child_sha, clone.records))
        clone.records.save(child_state)
        clone.plan_document, clone.plan_sha256 = child_plan, child_sha
        print(json.dumps({"diagnostic_fork": {"parent_plan_sha256": parent_sha, "child_plan_sha256": child_sha, "entry": pointer,
                                              "fresh_e2e": False, "release_gate_eligible": False}}), flush=True)

    def refuse_earlier_change(self, manifest, parent_dir, observed, old_tool, suffix, fixture_root, inventory_before, helper):
        bundle_before = {path.relative_to(parent_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in sorted(parent_dir.rglob("*")) if path.is_file()}
        new_tool = tool_tree_files(ROOT)
        both = dict(new_tool)
        both[cp.PRODUCT_FILE] = cp.mutate_body(new_tool[cp.PRODUCT_FILE].decode("utf-8"), "HostOps.backup_readiness",
                                               ['raise Stop("RELEASE-TOOLS-CHECKPOINTS T17: late body too")']).encode("utf-8")
        restored = []
        for name, files in (("prepare changed", new_tool), ("prepare and a late body changed", both)):
            with self.assertRaises(cp.Refused) as refused:
                cp.resume_or_refuse(manifest, {**observed, "tool_tree_sha256_at_checkpoint": cp.tree_manifest_from_bytes(files)["sha256"]},
                                    restore=restored.append, old_tool_files=old_tool, new_tool_files=files, suffix_phases=suffix,
                                    parent_manifest_sha256=parent_dir.name)
            self.assertEqual(refused.exception.code, "PREFIX_CHANGED", name)
        self.assertEqual(restored, [])
        self.assertFalse(fixture_root.exists(), "no fixture root was created")
        self.assertEqual({path.relative_to(parent_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in sorted(parent_dir.rglob("*")) if path.is_file()}, bundle_before)
        after = rehearsal.CheckpointDocker(None, helper).inventory()
        ids = lambda inventory: {kind: sorted(item["id"] for item in inventory[kind]) for kind in inventory}
        self.assertEqual(ids(after), ids(inventory_before), "no daemon resource was created")
        print(json.dumps({"earlier_change": "PREFIX_CHANGED before restore", "new_resources": 0, "bundle_unchanged": True}), flush=True)

    def load_context(self, fixture_root):
        raw = json.loads((fixture_root / CONTEXT_FILE).read_bytes())
        ctx = SimpleNamespace(root=fixture_root, previous_sha=raw["previous_sha"], target_sha=raw["target_sha"], images=raw["images"],
                              legacy=raw.get("legacy"), members=raw.get("members"), b0=raw.get("b0"),
                              copy_dir=Path(raw["copy_dir"]) if raw.get("copy_dir") else None, production_plan=raw.get("production_plan"))
        for name, descriptor in raw["stacks"].items():
            setattr(ctx, name, rehearsal.SyntheticStack.restored(self, descriptor))
        return ctx

    def write_context(self, ctx, fixture_root):
        stacks = {name: getattr(ctx, name).descriptor() for name in ("source", "clone", "failure") if hasattr(ctx, name)}
        document = {"previous_sha": ctx.previous_sha, "target_sha": ctx.target_sha, "images": ctx.images,
                    "legacy": getattr(ctx, "legacy", None), "members": getattr(ctx, "members", None), "b0": getattr(ctx, "b0", None),
                    "copy_dir": str(ctx.copy_dir) if getattr(ctx, "copy_dir", None) else None,
                    "production_plan": getattr(ctx, "production_plan", None), "stacks": stacks}
        path = fixture_root / CONTEXT_FILE
        path.write_bytes(cp.canonical(document) + b"\n")
        path.chmod(0o600)

    def capture(self, checkpoint_id, ctx, store, fixture_root, actual, facts, helper, parent, parent_dir, request, runtime, *,
                leaf=None, source=None):
        stack = getattr(ctx, LINEAGE_STACK[checkpoint_id])
        self.assertEqual(actual["tool_files"], stack.plan_document["tool"], "the plan binds the executing tool files")
        spec = cp.CHECKPOINTS[checkpoint_id]

        def before_seal():
            self.write_context(ctx, fixture_root)
            secrets = [{"path": path.relative_to(fixture_root).as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                       for path in sorted(stack.records.secrets.rglob("*")) if path.is_file()] if stack.records.secrets.exists() else []
            (fixture_root / SECRETS_INVENTORY).write_bytes(cp.canonical(secrets) + b"\n")

        def identity(state):
            return {"tool_tree_sha256_at_checkpoint": actual["tool"]["sha256"], "tool_tree_sha256_at_resume": None,
                    "source_tree_sha256": actual["source"]["sha256"], "harness_tree_sha256": actual["harness"]["sha256"],
                    "tool_files_actual_raw_sha256": actual["tool_files"],
                    "source_b0_manifest_sha256": (getattr(ctx, "b0", None) or {}).get("manifest_sha256"),
                    "clone_b0_manifest_sha256": (state.get("b0") or {}).get("manifest_sha256") if stack.label != "source" else None,
                    "payload_manifest_sha256": "0" * 64, "image_ids": {**ctx.images, "helper": helper}, "plan_sha256": stack.plan_sha256,
                    "target_manifest_sha256": stack.plan_document["target_manifest_sha256"], "phase_reached": checkpoint_id,
                    "created_utc": cp.now_utc().isoformat(), "resumed_utc": None, "host_key_sha256": facts["host_key_sha256"],
                    "daemon_identity": facts["daemon_identity"], "absolute_fixture_root": str(fixture_root), "runtime_identity": runtime,
                    "segment_source_map": {**((parent or {}).get("identity", {}).get("segment_source_map") or {}),
                                           request["stage"]: {"tool_tree_sha256": actual["tool"]["sha256"],
                                                             "executed": list(cp.STAGES[request["stage"]]["phases"])}}}
        tool_tar = Path(store.root) / (".tool-" + checkpoint_id + ".tar")
        with tarfile.open(tool_tar, "x:", format=tarfile.PAX_FORMAT) as archive:
            for name in cp.tracked_files(ROOT, "scripts/"):
                archive.add(str(ROOT / name), arcname=name, recursive=False)
        owned = {"token": stack.token, "projects": {stack.project},
                 "networks": [{"name": stack.halo_network, "labels": {"kin.ops.run": stack.token}}] if stack.halo_network and spec["volumes"] else [],
                 "stack": {"root": str(stack.root), "containers": {role: stack.target["containers"][role] for role in intro.ROLES}}}
        try:
            produced, _ = seal_boundary(checkpoint_id, stack, store=store, fixture_root=fixture_root, helper=helper, identity=identity,
                                        owned=owned, execution_kind=request["execution_kind"], tls_not_after=certificate_not_after(stack.ca),
                                        parent=cp.parent_reference(parent, parent_dir) if parent else None, before_seal=before_seal,
                                        extra_members=[("tool-tree.tar", "tool-tree", tool_tar)], leaf=leaf, source=source)
            return produced
        finally:
            tool_tar.unlink(missing_ok=True)

    def cleanup(self, ctx, helper):
        """Every stack of this leaf: its own removal, then the exact-label inventory (with the aliases it tagged) decides
        completeness."""
        if ctx is None:
            return {"complete": True, "removed": [], "remaining": [], "errors": []}
        results = []
        for name in ("source", "clone", "failure"):
            stack = getattr(ctx, name, None)
            if stack is None:
                continue
            owned = self.owned_by(stack)
            stack.remove()
            results.append(cp.cleanup_owned(rehearsal.CheckpointDocker(stack, helper), owned))
        return {"complete": all(item["complete"] for item in results), "removed": [n for item in results for n in item["removed"]],
                "remaining": [n for item in results for n in item["remaining"]], "errors": [e for item in results for e in item["errors"]]}


def seal_boundary(checkpoint_id, stack, *, store, fixture_root, helper, identity, owned, execution_kind, tls_not_after, parent=None,
                  before_seal=None, extra_members=(), leaf=None, source=None, probe=None):
    """r5 (consult-checkpoints-r5-20261016 observe_fix): one checkpoint as one operation under the stack's own phase lease.
    The boundary state bytes S are read once; boundary_publishable judges them; a volume boundary is observed in the
    observation-only context (CheckpointDocker.observe) and its product facts taken; `before_seal` writes the stage context;
    the clones' Git closure is sealed; the bundle binds S's own SHA-256 as the state (the archived state.json must be S,
    never a state re-read after the observation) and the capture observation beside it, and the original records must
    still be the observation's `before` bytes. `identity(S)` returns the bundle identity. Returns (bundle, observation).
    Shared by CheckpointSegments and the native smoke (tests/ops_release_checkpoints_native_test.py). r6: the capture
    observation binds the regenerated-artifact descriptor of the stack's Orthanc container on its pinned image, and
    capture_checkpoint judges every stopped role's writable layer against it and binds that record (`layer`) before any
    bundle byte; every call here runs under the caller's active deadline when there is one (the native smoke's)."""
    spec = cp.CHECKPOINTS[checkpoint_id]
    docker = rehearsal.CheckpointDocker(stack, helper)
    with stack.records.lease():
        state_path = stack.records.directory / "state.json"
        state_raw = state_path.read_bytes()
        state = json.loads(state_raw)
        result_path = next(path for path in sorted(stack.records.directory.glob("result-*.json"))
                           if hashlib.sha256(path.read_bytes()).hexdigest() == state["history"][-1]["result_sha256"])
        result_raw = result_path.read_bytes()
        boundary = cp.boundary_publishable(checkpoint_id, state=state, result=json.loads(result_raw), result_raw=result_raw)
        observation = None
        if spec["volumes"]:
            observation = docker.observe(checkpoint_id, purpose="capture", state_raw=state_raw, leaf=leaf, source=source, probe=probe,
                                         parent_manifest_sha256=(parent or {}).get("manifest_sha256"))
            # What a restore must observe again (CKPT-04), taken while the boundary's services still run.
            boundary["facts"] = docker.boundary_facts()
        boundary.update(window_end=stack.plan_document["window"]["end"], tls_not_after=tls_not_after)
        if before_seal is not None:
            before_seal()
        rehearsal.CheckpointDocker.self_contained_git(fixture_root)
        rel = lambda path: Path(path).relative_to(fixture_root).as_posix()
        digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
        files = {"result": result_path, "secrets": fixture_root / SECRETS_INVENTORY, "compose_entry": stack.root / "compose-entries" / "active.json",
                 "ledger": stack.backups / intro_ledger(), "context": fixture_root / CONTEXT_FILE}
        if spec["lock"]:
            files["lock"] = intro.lock_path(stack.repo)
        bindings = {name: {"path": rel(path), "sha256": digest(path)} for name, path in files.items()}
        bindings["state"] = {"path": rel(state_path), "sha256": cp.sha256(state_raw)}
        if observation is not None:
            bindings["observation"] = cp.observation_binding(fixture_root, observation)
            now = cp.original_records(stack.records.directory, entry_root=stack.root / "compose-entries", lock_path=intro.lock_path(stack.repo))
            cp.require(now == observation["summary"]["original"]["before"], "ORIGINAL_CHANGED",
                       "the original records changed between the observation and the seal")
        volumes = {**stack.target["volumes"], "proxy_certs": stack.project + "_proxy-certs"}
        produced = cp.capture_checkpoint(checkpoint_id=checkpoint_id, store=store, backend=docker if spec["volumes"] else None,
                                         boundary=boundary, names=owned["stack"]["containers"], volumes=volumes, fixture_root=fixture_root,
                                         bindings=bindings, identity=identity(state), owned=owned, execution_kind=execution_kind,
                                         parent=parent, extra_members=extra_members)
    return produced, observation


def restore_boundary(manifest, parent_dir, *, fixture_root, helper, load, leaf=None, source=None):
    """r5: the cold restore (cp.restore_checkpoint) whose final observation runs under the restored stack's phase lease in
    the observation-only context (purpose restore, naming the parent bundle; the parent bundle is never written), then the
    boundary's product facts observed again (cp.restored_mapping). `load(fixture_root)` returns the restored lineage
    stack. Returns (stack, restore observation or None, mapping or None). Shared by CheckpointSegments and the native
    smoke. r9: the owned stack and token are type-checked before they are read (a caller's mistyped manifest is
    BUNDLE_INVALID before any adapter exists; restore_checkpoint then verifies the bundle itself)."""
    owned = manifest.get("owned") if type(manifest) is dict else None
    stack = owned.get("stack") if type(owned) is dict else None
    cp.require(type(stack) is dict and type(stack.get("root")) is str and type(stack.get("containers")) is dict and type(owned.get("token")) is str,
               "BUNDLE_INVALID", "the manifest names no owned stack and token")
    target = SimpleNamespace(root=Path(owned["stack"]["root"]), repo=Path(owned["stack"]["root"]) / "repo", token=owned["token"],
                             target={"containers": owned["stack"]["containers"]})
    docker = rehearsal.CheckpointDocker(target, helper)
    holder = {}

    def observe(sid):
        holder["stack"] = stack = load(fixture_root)
        with stack.records.lease():
            holder["observation"] = rehearsal.CheckpointDocker(stack, helper).observe(
                manifest["checkpoint"], purpose="restore", leaf=leaf, source=source, parent_manifest_sha256=Path(parent_dir).name)
    cp.restore_checkpoint(manifest, parent_dir, backend=docker, fixture_root=fixture_root, names=owned["stack"]["containers"],
                          images_present=docker.image_present, observe=observe)
    stack = holder["stack"] if "stack" in holder else load(fixture_root)
    mapping = None
    if cp.CHECKPOINTS[manifest["checkpoint"]]["volumes"]:
        mapping = cp.restored_mapping(manifest["boundary"]["facts"], rehearsal.CheckpointDocker(stack, helper).boundary_facts())
    return stack, holder.get("observation"), mapping


def intro_ledger():
    import ops_audit_integrity as audit
    return audit.LEDGER


def certificate_not_after(path):
    """The clone's own TLS certificate expiry (the CA file is that self-signed certificate), real UTC."""
    import ssl
    from datetime import datetime, timezone
    # The standard library's certificate decoder (used by CPython's own ssl tests); no third-party parser.
    decoded = ssl._ssl._test_decode_cert(str(path))
    return datetime.fromtimestamp(ssl.cert_time_to_seconds(decoded["notAfter"]), timezone.utc).isoformat()


if __name__ == "__main__":
    unittest.main(verbosity=2)
