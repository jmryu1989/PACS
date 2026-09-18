#!/usr/bin/env python3
"""Pure selftests for the Stage-2 option-B additions to rollout.py and derive-manifest.py.

Every child process is a mock installed on the module's own `_EXECUTE` indirection, so the
actual script entry paths run with no Docker daemon, database, network, server or credential.
Run: python3 selftest_rollout_stage2.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


rollout = load("rollout_stage2", "rollout.py")
derive = load("derive_manifest_stage2", "derive-manifest.py")

FAILURES = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + ((" :: " + detail) if detail and not condition else ""))
    if not condition:
        FAILURES.append(name)


def refuses(name, run, fragment=None):
    try:
        run()
        check(name, False, "no refusal")
    except rollout.Refuse as error:
        check(name, fragment is None or fragment.lower() in str(error).lower(), str(error)[:160])
    except Exception as error:  # noqa: BLE001 - a different exception is still a failure
        check(name, False, type(error).__name__ + ": " + str(error)[:120])


class Result:
    def __init__(self, returncode=0, stdout=b"", stderr=b""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def mock_exec(table, calls=None):
    """table: list of (predicate, Result). First match wins; no match is an explicit failure."""
    def run(args, **kwargs):
        if calls is not None:
            calls.append(list(args))
        for predicate, result in table:
            if predicate(args):
                return result() if callable(result) else result
        raise AssertionError("unmocked command: " + " ".join(args))
    return run


def with_exec(mock, body):
    previous = rollout._EXECUTE
    rollout._EXECUTE = mock
    try:
        return body()
    finally:
        rollout._EXECUTE = previous


# ---------------------------------------------------------------- C2: allowlist preserved
def test_allowlist_keeps_the_accepted_path():
    repo = pathlib.Path("/home/ubuntu/pacs-starter-kit")
    accepted = [
        rollout.compose(repo) + ["stop", "api", "orthanc"],
        rollout.compose(repo) + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "api", "orthanc"],
        rollout.compose(repo) + ["run", "--rm", "--no-deps", "--entrypoint", "sh", "api", "-c",
                                 "./node_modules/.bin/prisma migrate deploy"],
        ["docker", "exec", "kin-proxy", "nginx", "-t"],
        ["docker", "exec", "kin-proxy", "nginx", "-s", "reload"],
        ["docker", "exec", "kin-db", "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c", "SELECT 1;"],
        ["docker", "inspect", "kin-api"],
        ["docker", "inspect", "--type", "network", "kin-workflow"],
        ["docker", "image", "inspect", "sha256:" + "0" * 64],
        ["docker", "tag", "a", "b"],
        ["git", "checkout", "--detach", "5dd76a6318cb751c531b2e61f9f0d4f94577c5fd"],
        ["python3", "scripts/ops_backup.py", "backup"],
    ]
    for args in accepted:
        try:
            rollout.check_command(args)
            check("allowed: " + " ".join(args[:4]), True)
        except rollout.Refuse as error:
            check("allowed: " + " ".join(args[:4]), False, str(error)[:140])
    check("services are api and orthanc", rollout.SERVICES == ("api", "orthanc"))
    check("two accepted compose files", rollout.COMPOSE_FILES == ("docker-compose.yml", "docker-compose.prod.yml"))


def test_allowlist_new_refusals():
    repo = pathlib.Path("/repo")
    refuses("bare compose up is refused",
            lambda: rollout.check_command(rollout.compose(repo) + ["up", "-d"]), "must name explicit services")
    refuses("compose up naming the proxy is refused",
            lambda: rollout.check_command(rollout.compose(repo) + ["up", "-d", "api", "proxy"]), "never addresses the proxy")
    refuses("compose stop without services is refused",
            lambda: rollout.check_command(rollout.compose(repo) + ["stop"]), "must name explicit services")
    refuses("docker network is refused", lambda: rollout.check_command(["docker", "network", "rm", "kin-workflow"]))
    refuses("docker network create is refused", lambda: rollout.check_command(["docker", "network", "create", "x"]))
    refuses("compose down is refused", lambda: rollout.check_command(rollout.compose(repo) + ["down"]))
    refuses("container name in compose is refused",
            lambda: rollout.check_command(rollout.compose(repo) + ["up", "-d", "kin-api"]))
    refuses("git reset is refused", lambda: rollout.check_command(["git", "reset", "--hard"]))
    refuses("mkdir is refused", lambda: rollout.check_command(["mkdir", "-p", "/etc/kin-workflow/nginx"]))
    refuses("ssh is refused", lambda: rollout.check_command(["ssh", "host"]))


# ---------------------------------------------------------------- C5: network inspection
def test_network_absent_is_typed_only():
    absent = mock_exec([(lambda a: True, Result(1, b"", b"Error response from daemon: network kin-workflow not found"))])
    check("plain not-found text is not accepted",
          with_exec(absent, lambda: _swallow(lambda: rollout.network_absent("kin-workflow"))) == "refused")
    typed = mock_exec([(lambda a: True, Result(1, b"", b"Error: No such network: kin-workflow"))])
    check("the explicit typed not-found means absent",
          with_exec(typed, lambda: rollout.network_absent("kin-workflow")) is True)
    present = mock_exec([(lambda a: True, Result(0, b"[{}]", b""))])
    check("exit 0 means present", with_exec(present, lambda: rollout.network_absent("kin-workflow")) is False)
    daemon_down = mock_exec([(lambda a: True, Result(1, b"", b"Cannot connect to the Docker daemon"))])
    refuses("any other error refuses instead of guessing",
            lambda: with_exec(daemon_down, lambda: rollout.network_absent("kin-workflow")), "refusing rather than guessing")
    called = []
    typed2 = mock_exec([(lambda a: True, Result(1, b"", b"Error: No such network: kin-workflow"))], called)
    with_exec(typed2, lambda: rollout.network_absent("kin-workflow"))
    check("it inspects by explicit network type", called and called[0][:4] == ["docker", "inspect", "--type", "network"],
          json.dumps(called[:1]))


def _swallow(body):
    try:
        body()
        return "returned"
    except rollout.Refuse:
        return "refused"


def proxy_mock(networks, mounts, network_present=False):
    payload = json.dumps([{"Image": "sha256:proxy", "State": {"StartedAt": "2026-09-16T23:00:00Z"},
                           "NetworkSettings": {"Networks": {name: {} for name in networks}},
                           "Mounts": [{"Destination": dest} for dest in mounts]}]).encode()
    return mock_exec([
        (lambda a: a[:2] == ["docker", "inspect"] and "--type" in a,
         Result(0, b"[{}]", b"") if network_present else Result(1, b"", b"Error: No such network: kin-workflow")),
        (lambda a: a[:2] == ["docker", "inspect"], Result(0, payload, b"")),
    ])


# ---------------------------------------------------------------- C4: proxy guard
def test_proxy_guard():
    clean = proxy_mock(["kin_default"], ["/etc/letsencrypt", "/var/www/certbot"])
    guard = with_exec(clean, rollout.proxy_guard)
    check("an untouched proxy is inert", guard["inert"] is True and guard["network_absent"] is True)
    check("guard records networks and mounts for the record",
          guard["proxy_networks"] == ["kin_default"] and "/etc/letsencrypt" in guard["proxy_mounts"])
    check("require_proxy_inert passes on an untouched proxy",
          with_exec(clean, lambda: rollout.require_proxy_inert("pre-apply"))["inert"] is True)

    joined = proxy_mock(["kin_default", "kin-workflow"], ["/etc/letsencrypt"], network_present=True)
    # The recorded evidence must describe what was actually observed, not a fixed answer.
    joined_guard = with_exec(joined, rollout.proxy_guard)
    check("the guard reports the observed network state",
          joined_guard["network_absent"] is False and joined_guard["proxy_joined_workflow_network"] is True
          and "kin-workflow" in joined_guard["proxy_networks"], json.dumps(joined_guard))
    mount_guard = with_exec(proxy_mock(["kin_default"], ["/etc/kin-workflow/nginx"]), rollout.proxy_guard)
    check("the guard reports the observed mount state",
          mount_guard["proxy_has_workflow_mount"] is True and mount_guard["inert"] is False)
    check("the guard reports the observed proxy start time, not a fixed value",
          joined_guard["proxy_started_at"] == "2026-09-16T23:00:00Z", str(joined_guard["proxy_started_at"]))
    refuses("a proxy joined to kin-workflow trips the guard",
            lambda: with_exec(joined, lambda: rollout.require_proxy_inert("post-apply")), "Proxy guard tripped at post-apply")
    mounted = proxy_mock(["kin_default"], ["/etc/letsencrypt", "/etc/kin-workflow/nginx"])
    refuses("a workflow mount trips the guard",
            lambda: with_exec(mounted, lambda: rollout.require_proxy_inert("pre-apply")))
    network_only = proxy_mock(["kin_default"], ["/etc/letsencrypt"], network_present=True)
    refuses("an unreferenced kin-workflow network still trips the guard",
            lambda: with_exec(network_only, lambda: rollout.require_proxy_inert("post-apply")))
    try:
        with_exec(joined, lambda: rollout.require_proxy_inert("post-apply"))
    except rollout.Refuse as error:
        text = str(error)
        check("the trip forbids an automatic rollback", "Do NOT run an automatic rollback" in text)
        check("the trip retains lock, record and backups", "are retained" in text)
        check("the trip states the runner never touches networks", "never creates or deletes a Docker network" in text)


# ---------------------------------------------------------------- C6: findings rollback
def psql_mock(answers):
    def predicate_for(fragment):
        return lambda a: "psql" in a and any(fragment in part for part in a)
    table = [(predicate_for(fragment), Result(0, value.encode(), b"")) for fragment, value in answers]
    table.append((lambda a: True, Result(0, b"", b"")))
    return mock_exec(table)


def test_finding_rows_and_rollback_clause():
    present = psql_mock([('to_regclass(\'public."Finding"\')', "t"),
                         ('to_regclass(\'public."FindingRevision"\')', "t"),
                         ('count(*) FROM "Finding";', "7"),
                         ('count(*) FROM "FindingRevision";', "19")])
    rows = with_exec(present, rollout.finding_rows)
    check("finding rows are counted, not read",
          rows["Finding"]["rows"] == 7 and rows["FindingRevision"]["rows"] == 19 and rows["total_rows"] == 26,
          json.dumps(rows))
    absent = psql_mock([("to_regclass", "f")])
    empty = with_exec(absent, rollout.finding_rows)
    check("to_regclass guards a rollback taken before the migration exists",
          empty["Finding"]["table"] == "absent" and empty["total_rows"] == 0)

    compat = {"findings": rows, "findings_blocking": True}
    check("findings have their own blocking flag", compat["findings_blocking"] is True)
    source = (HERE / "rollout.py").read_text(encoding="utf-8")
    # B2: behavioural, not a source-string pin. Findings must never set `blocking`, and an
    # owned HangingProtocolPreference table must never set it either.
    owning = {"hanging_protocol": {"baseline_owns_table": True}}
    findings_only = psql_mock([('to_regclass', "t"), ('count(*) FROM "Finding";', "5"),
                               ('count(*) FROM "FindingRevision";', "6"),
                               ("HangingProtocolPreference", "40"), ("ViewerJob", '{"6": 2}')])
    compat = with_exec(findings_only, lambda: rollout.rollback_compatibility(
        {**owning, "snapshot_versions": {"previous_api_accepts": [1, 2, 3, 4, 5, 6]}}))
    check("findings are not folded into the ViewerJob blocking flag",
          compat["blocking"] is False and compat["findings_blocking"] is True, json.dumps(compat["blocking"]))
    check("an owned hanging-protocol table does not block",
          compat["hanging_protocol"]["blocking"] is False and compat["hanging_protocol"]["rows"] == 40)
    check("a separate acknowledgement flag exists", "--acknowledge-finding-inaccessibility" in source)
    check("the ViewerJob acknowledgement cannot cover findings",
          'args.acknowledge_finding_inaccessibility' in source)
    # Both gates must survive: the pre-stop refusal and the post-quiesce refusal.
    check("the pre-stop findings gate is intact",
          'if compatibility["findings_blocking"] and not args.acknowledge_finding_inaccessibility:' in source)
    check("the post-quiesce findings gate is intact",
          'if after_quiesce["findings_blocking"] and not args.acknowledge_finding_inaccessibility:' in source)
    check("the disclosure says inaccessible, not read-only",
          "becomes completely inaccessible through the product" in source and "read-only mode" not in source)
    check("no destructive database rollback is offered",
          "never deletes, resets, truncates or rewrites finding data" in source)
    for forbidden in ("DROP TABLE", "TRUNCATE ", "DELETE FROM"):
        check("runner never issues " + forbidden.strip(), forbidden not in source)


# ---------------------------------------------------------------- N1/C7/C8 pure logic
def test_observed_migration_state():
    manifest = {"migrations": {"baseline_names": ["a", "b"], "target_names": ["a", "b", "c"],
                               "baseline_migration_count": 2, "new": ["c"]}}
    ok = rollout.verify_observed_migration_state({"names": ["a", "b"], "unfinished_or_rolled_back": 0}, manifest)
    check("a clean observation reconciles", ok["pending"] == ["c"] and ok["observed_count"] == 2)
    refuses("a duplicate row refuses",
            lambda: rollout.verify_observed_migration_state({"names": ["a", "a", "b"], "unfinished_or_rolled_back": 0}, manifest),
            "duplicate")
    refuses("a missing baseline migration refuses",
            lambda: rollout.verify_observed_migration_state({"names": ["a"], "unfinished_or_rolled_back": 0}, manifest),
            "absent from the database")
    refuses("a row the target lacks refuses",
            lambda: rollout.verify_observed_migration_state({"names": ["a", "b", "z"], "unfinished_or_rolled_back": 0}, manifest),
            "target does not contain")
    refuses("an already-applied pending set refuses",
            lambda: rollout.verify_observed_migration_state({"names": ["a", "b", "c"], "unfinished_or_rolled_back": 0}, manifest),
            "pending set")
    refuses("an unfinished or rolled-back row refuses",
            lambda: rollout.verify_observed_migration_state({"names": ["a", "b"], "unfinished_or_rolled_back": 1}, manifest),
            "unfinished or rolled back")


def test_classification_union():
    classes = {"delivered": ["api/src", "config"], "drift": ["docker-compose.prod.yml"],
               "declared_inert": ["tests", ".github"]}
    good = rollout.classify_changed_paths(
        ["api/src/x.ts", "config/ohif.js", "docker-compose.prod.yml", "tests/a.py", ".github/workflows/v.yml"], classes)
    check("every declared path classifies once", not good["unclassified"] and not good["ambiguous"])
    check("counts are reported per class",
          good["counts"]["delivered"] == 2 and good["counts"]["drift"] == 1 and good["counts"]["declared_inert"] == 2)
    stray = rollout.classify_changed_paths(["scripts/new.py"], classes)
    check("an undeclared path is unclassified", stray["unclassified"] == ["scripts/new.py"])
    overlap = rollout.classify_changed_paths(["config/ohif.js"], {"delivered": ["config"], "drift": ["config/ohif.js"],
                                                                 "declared_inert": []})
    check("a path owned twice is ambiguous", overlap["ambiguous"] == ["config/ohif.js"])
    # p5 regression: a DELETED path is part of the diff and must still be classified.
    deleted = rollout.classify_changed_paths(["proxy/gone.conf"], classes)
    check("a deleted, undeclared path is not silently dropped", deleted["unclassified"] == ["proxy/gone.conf"])
    # The same pure rule in the deriver.
    assignment, unclassified, ambiguous = derive.classify(["tests/x.py", "api/src/y.ts"], classes)
    check("the deriver applies the same rule", not unclassified and not ambiguous and len(assignment) == 2)
    _a, u2, _b = derive.classify(["scripts/z.py"], classes)
    check("the deriver refuses an unclassified path", u2 == ["scripts/z.py"])


def test_started_after_and_delivered_files():
    check("a later start passes", rollout.started_after("2026-09-18T10:00:01Z", "2026-09-18T10:00:00Z") is True)
    check("an earlier start fails", rollout.started_after("2026-09-18T09:59:59Z", "2026-09-18T10:00:00Z") is False)
    check("an equal instant is not later", rollout.started_after("2026-09-18T10:00:00Z", "2026-09-18T10:00:00Z") is False)
    refuses("an unparsable time refuses", lambda: rollout.started_after("not-a-time", "2026-09-18T10:00:00Z"))
    refuses("a naive time refuses", lambda: rollout.started_after("2026-09-18T10:00:01", "2026-09-18T10:00:00Z"))

    with tempfile.TemporaryDirectory() as tmp:
        repo = pathlib.Path(tmp)
        (repo / "config").mkdir()
        (repo / "config" / "ohif.js").write_bytes(b"// viewer config\n")
        digest = hashlib.sha256(b"// viewer config\n").hexdigest()
        manifest = {"delivered_files_sha256": {"config/ohif.js": digest}}
        started = mock_exec([(lambda a: True, Result(0, b"2026-09-18T10:00:01Z", b""))])
        proof = with_exec(started, lambda: rollout.verify_delivered_on_disk(repo, manifest, "2026-09-18T10:00:00Z"))
        check("the on-disk viewer config is proved by content", proof["files"]["config/ohif.js"] == digest)
        stale = mock_exec([(lambda a: True, Result(0, b"2026-09-18T09:00:00Z", b""))])
        refuses("an orthanc that did not restart after the checkout refuses",
                lambda: with_exec(stale, lambda: rollout.verify_delivered_on_disk(repo, manifest, "2026-09-18T10:00:00Z")),
                "did not restart after the checkout")
        wrong = {"delivered_files_sha256": {"config/ohif.js": "0" * 64}}
        refuses("a different on-disk viewer config refuses",
                lambda: with_exec(started, lambda: rollout.verify_delivered_on_disk(repo, wrong, "2026-09-18T10:00:00Z")),
                "differs from the pinned target content")


# ---------------------------------------------------------------- manifest produced here
def test_manifest_shape():
    path = HERE / "manifest-stage2.json"
    if not path.is_file():
        check("manifest-stage2.json exists", False, "run derive-manifest.py first")
        return
    manifest = json.loads(path.read_text(encoding="utf-8"))
    check("manifest baseline is the Stage-1 applied commit",
          manifest["baseline_sha"] == "17980d522b260b59fa97c96924f96038b63551ae")
    check("manifest target and tree are the fixed main",
          manifest["target_sha"] == "5dd76a6318cb751c531b2e61f9f0d4f94577c5fd"
          and manifest["target_tree"] == "c8ec68e5ef97fddac5c2e928e1d43ead3aa4c747")
    for key in ("compatibility_boundary_unchanged", "delivered_trees", "delivered_files_sha256",
                "drift_pins", "change_classes", "migrations", "snapshot_versions"):
        check("manifest carries " + key, key in manifest)
    check("the api tree is still delivered", "api" in manifest["delivered_trees"])
    check("worklist and config are delivered",
          "worklist-v0" in manifest["delivered_trees"] and "config" in manifest["delivered_trees"])
    check("both drift paths are pinned at both ends",
          set(manifest["drift_pins"]) == {"docker-compose.prod.yml", "proxy/nginx.conf.template"}
          and all(entry["baseline"] != entry["target"] for entry in manifest["drift_pins"].values()))
    check("drift is declared undelivered",
          all(entry["delivered_to_running_container"] is False for entry in manifest["drift_pins"].values()))
    check("the whole diff is classified exactly once",
          sum(manifest["change_classes"]["counts"].values()) == manifest["change_classes"]["changed_count"],
          json.dumps(manifest["change_classes"]["counts"]))
    check("exactly one migration is pending", manifest["migrations"]["new"] == ["20260917120000_findings"])
    check("the findings migration sha256 is pinned to the real bytes",
          manifest["migrations"]["detail"]["20260917120000_findings"]["sha256"]
          == "950d9eb8a127ce27b135518da36690ec07ed22aff635671ac7db1d36d1a06118")
    check("the baseline migration set is 23 names",
          manifest["migrations"]["baseline_migration_count"] == 23 and len(manifest["migrations"]["baseline_names"]) == 23)
    check("snapshot compatibility is re-derived for the current baseline",
          manifest["snapshot_versions"]["previous_api_accepts"] == manifest["snapshot_versions"]["target_api_accepts"])
    check("the proxy remainder is pinned inside the compatibility boundary",
          any(path.startswith("proxy/") for path in manifest["compatibility_boundary_unchanged"]))
    check("the drift template is NOT in the compatibility boundary",
          "proxy/nginx.conf.template" not in manifest["compatibility_boundary_unchanged"])
    check("the previous api image is the Stage-1 verified one",
          manifest["live"]["previous_api_image"].endswith("24380d3d02423824345ceac12ea3b3d2f76568bb437d319ef748b8773cc3a131"))
    check("delivery names api and orthanc with the proxy untouched",
          manifest["live"]["delivery"]["services"] == ["api", "orthanc"]
          and manifest["live"]["delivery"]["running_proxy"] == "untouched")


def main():
    test_allowlist_keeps_the_accepted_path()
    test_allowlist_new_refusals()
    test_network_absent_is_typed_only()
    test_proxy_guard()
    test_finding_rows_and_rollback_clause()
    test_observed_migration_state()
    test_classification_union()
    test_started_after_and_delivered_files()
    test_manifest_shape()
    print("FAILURES=" + str(len(FAILURES)) + (" " + ",".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())

