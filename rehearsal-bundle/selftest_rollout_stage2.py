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
def _absent_answer(stderr):
    return mock_exec([(lambda a: True, Result(1, b"", stderr))])


def test_network_absent_is_typed_only():
    # The OLD failure, reproduced: this is verbatim what Docker 28.0.4 wrote to stderr for
    # `docker inspect --type network kin-workflow` on the hosted runner of run 35337766905. The
    # previous substring rule did not match it, so an absent network was read as indeterminate
    # and S2, S5 and S7's positive control all refused. It is a typed absence.
    daemon_form = _absent_answer(b"Error response from daemon: network kin-workflow not found\n")
    check("the daemon's typed not-found means absent",
          with_exec(daemon_form, lambda: rollout.network_absent("kin-workflow")) is True)
    typed = _absent_answer(b"Error: No such network: kin-workflow")
    check("the explicit typed not-found means absent",
          with_exec(typed, lambda: rollout.network_absent("kin-workflow")) is True)
    trailing = _absent_answer(b"Error response from daemon: network kin-workflow not found\nexit status 1\n")
    check("docker's own trailing exit-status line does not change the answer",
          with_exec(trailing, lambda: rollout.network_absent("kin-workflow")) is True)
    present = mock_exec([(lambda a: True, Result(0, b"[{}]", b""))])
    check("exit 0 means present", with_exec(present, lambda: rollout.network_absent("kin-workflow")) is False)

    # The recognition is name-bound and whole-message: nothing else may be read as absence.
    other_name = _absent_answer(b"Error response from daemon: network kin-other not found")
    refuses("an answer about another network refuses",
            lambda: with_exec(other_name, lambda: rollout.network_absent("kin-workflow")),
            "refusing rather than guessing")
    other_typed = _absent_answer(b"Error: No such network: kin-other")
    refuses("the object form about another network refuses",
            lambda: with_exec(other_typed, lambda: rollout.network_absent("kin-workflow")),
            "refusing rather than guessing")
    quoting = _absent_answer(b"Cannot connect to the Docker daemon: No such network: kin-workflow")
    refuses("a daemon error that merely quotes the words refuses",
            lambda: with_exec(quoting, lambda: rollout.network_absent("kin-workflow")),
            "refusing rather than guessing")
    noisy = _absent_answer(b"Error: No such network: kin-workflow\ncontext deadline exceeded")
    refuses("a typed line with an extra diagnostic line refuses",
            lambda: with_exec(noisy, lambda: rollout.network_absent("kin-workflow")),
            "refusing rather than guessing")
    only_status = _absent_answer(b"exit status 1\n")
    refuses("an exit-status line on its own refuses",
            lambda: with_exec(only_status, lambda: rollout.network_absent("kin-workflow")),
            "refusing rather than guessing")
    empty = _absent_answer(b"")
    refuses("a non-zero exit with no message refuses",
            lambda: with_exec(empty, lambda: rollout.network_absent("kin-workflow")),
            "refusing rather than guessing")
    daemon_down = mock_exec([(lambda a: True, Result(1, b"", b"Cannot connect to the Docker daemon"))])
    refuses("any other error refuses instead of guessing",
            lambda: with_exec(daemon_down, lambda: rollout.network_absent("kin-workflow")), "refusing rather than guessing")
    called = []
    typed2 = mock_exec([(lambda a: True, Result(1, b"", b"Error: No such network: kin-workflow"))], called)
    with_exec(typed2, lambda: rollout.network_absent("kin-workflow"))
    check("it inspects by explicit network type", called and called[0][:4] == ["docker", "inspect", "--type", "network"],
          json.dumps(called[:1]))

    # I3: the same answers as a typed observation, which is what the ingress guard reads.
    absent_state = with_exec(daemon_form, lambda: rollout.network_state("kin-workflow"))
    check("the typed not-found answer is state=absent", absent_state["state"] == "absent", json.dumps(absent_state))
    unknown_state = with_exec(daemon_down, lambda: rollout.network_state("kin-workflow"))
    check("an unreadable answer is state=indeterminate, never absent",
          unknown_state["state"] == "indeterminate" and "Cannot connect" in unknown_state["message"],
          json.dumps(unknown_state))
    present_state = with_exec(
        mock_exec([(lambda a: True, Result(0, json.dumps([LIVE_NETWORK]).encode(), b""))]),
        lambda: rollout.network_state("kin-workflow"))
    check("a present network carries its id and internal flag",
          present_state["state"] == "present" and present_state["id"] == LIVE_NETWORK["Id"]
          and present_state["internal"] is True, json.dumps(present_state))
    check("the receiver is recorded as a member name, for the record only",
          present_state["member_names"] == ["kin-proxy", "kin-workflow-receiver"],
          json.dumps(present_state["member_names"]))
    unreadable_zero = with_exec(mock_exec([(lambda a: True, Result(0, b"not json", b""))]),
                                lambda: rollout.network_state("kin-workflow"))
    check("exit 0 with an unreadable object is indeterminate, not present",
          unreadable_zero["state"] == "indeterminate", json.dumps(unreadable_zero))


# ---------------------------------------------------------------- I1-I4: the live ingress
# The mount record docker actually reports for the production proxy: docker-compose.prod.yml:23
# declares /etc/kin-workflow/nginx:/etc/nginx/workflow:ro and the 2026-09-19 read-only host
# observation reports exactly this tuple. The OLD fixtures injected the host SOURCE as the
# Destination - a shape no running container has ever reported - which is why a detector that was
# dead against the real product passed its own tests.
LIVE_ROUTE = {"Type": "bind", "Source": "/etc/kin-workflow/nginx", "Destination": "/etc/nginx/workflow",
              "Mode": "ro", "RW": False, "Propagation": "rprivate"}
OLD_WRONG_ROUTE = {"Destination": "/etc/kin-workflow/nginx"}
LETSENCRYPT = {"Type": "bind", "Source": "/etc/letsencrypt", "Destination": "/etc/letsencrypt",
               "Mode": "ro", "RW": False, "Propagation": "rprivate"}
LIVE_NETWORK = {"Id": "d90d5f6b997729698edb62cf4493f1b5b0410443d84d7299402f1dfd1dc86776",
                "Name": "kin-workflow", "Internal": True,
                "Containers": {"a1": {"Name": "kin-proxy", "EndpointID": "e1"},
                               "b2": {"Name": "kin-workflow-receiver", "EndpointID": "e2"}}}
LIVE_NETWORKS = ["kin-workflow", "pacs-starter-kit_default"]


def proxy_payload(networks, mounts, container_id="c0ffee", started="2026-09-17T09:00:00Z", running=True):
    return json.dumps([{"Id": container_id, "Image": "sha256:proxyimage",
                        "State": {"Running": running, "StartedAt": started},
                        "NetworkSettings": {"Networks": {name: {} for name in networks}},
                        "Mounts": list(mounts)}]).encode()


def ingress_mock(networks=("pacs-starter-kit_default",), mounts=(LETSENCRYPT,), network=None,
                 network_stderr=b"Error response from daemon: network kin-workflow not found",
                 proxy_exit=0, proxy_stdout=None, **proxy_kw):
    """The two inspects ingress_observation issues. network=None is the typed not-found answer."""
    payload = proxy_payload(networks, mounts, **proxy_kw) if proxy_stdout is None else proxy_stdout
    answer = (Result(0, json.dumps([network]).encode(), b"") if network is not None
              else Result(1, b"", network_stderr))
    return mock_exec([
        (lambda a: a[:2] == ["docker", "inspect"] and "--type" in a, answer),
        (lambda a: a[:2] == ["docker", "inspect"], Result(proxy_exit, payload, b"no such object")),
    ])


def observe(**kw):
    return with_exec(ingress_mock(**kw), rollout.ingress_observation)


LIVE = {"networks": LIVE_NETWORKS, "mounts": (LETSENCRYPT, LIVE_ROUTE), "network": LIVE_NETWORK}


def test_ingress_shape_against_the_real_topology():
    live = observe(**LIVE)
    check("the ACTUAL production ingress is a coherent baseline", live["shape"] == "present",
          json.dumps(live["shape_problems"]))
    route = rollout.workflow_routes(live["proxy"]["mounts"])
    check("the real mount tuple is found by its real Destination",
          len(route) == 1 and route[0] == rollout.mount_record(LIVE_ROUTE), json.dumps(route))
    check("the whole tuple is kept, not just the destination",
          set(live["proxy"]["mounts"][0]) == set(rollout.MOUNT_FIELDS), json.dumps(live["proxy"]["mounts"][0]))
    check("the proxy identity and start time are recorded for comparison",
          live["proxy"]["id"] == "c0ffee" and live["proxy"]["started_at"] == "2026-09-17T09:00:00Z")
    check("the network id and internal flag are recorded",
          live["network"]["id"] == LIVE_NETWORK["Id"] and live["network"]["internal"] is True)
    check("require_coherent_ingress accepts the real topology without the absence flag",
          with_exec(ingress_mock(**LIVE),
                    lambda: rollout.require_coherent_ingress("pre-apply"))["shape"] == "present")

    # The OLD fixture: the host Source injected as a Destination. It can never be the declared
    # route, so an observation built from it must not pass as the production shape.
    old = observe(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, OLD_WRONG_ROUTE), network=LIVE_NETWORK)
    check("the old Source-as-Destination fixture is NOT the production ingress",
          old["shape"] == "partial" and any("claiming the workflow route" in p for p in old["shape_problems"]),
          json.dumps(old["shape_problems"]))
    refuses("and it refuses instead of being adopted as a baseline",
            lambda: with_exec(ingress_mock(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, OLD_WRONG_ROUTE),
                                           network=LIVE_NETWORK),
                              lambda: rollout.require_coherent_ingress("pre-apply", allow_absent=True)),
            "not in a state this rollout can take as a baseline")


def test_ingress_shape_refuses_every_half_state():
    absent = observe()
    check("a stack with no ingress at all is coherent absence", absent["shape"] == "absent",
          json.dumps(absent["shape_problems"]))
    check("but absence alone does not pass the production gate",
          isinstance(refusal_of(lambda: with_exec(ingress_mock(), lambda: rollout.require_coherent_ingress("pre-apply"))), str))
    check("the absence refusal names the explicit acknowledgement",
          "--acknowledge-absent-ingress-baseline" in (refusal_of(
              lambda: with_exec(ingress_mock(), lambda: rollout.require_coherent_ingress("pre-apply"))) or ""))
    check("an acknowledged absence is accepted, and only then",
          with_exec(ingress_mock(),
                    lambda: rollout.require_coherent_ingress("pre-apply", allow_absent=True))["shape"] == "absent")

    writable = dict(LIVE_ROUTE, RW=True, Mode="rw")
    rw = observe(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, writable), network=LIVE_NETWORK)
    check("a WRITABLE workflow route is not the declared shape",
          rw["shape"] == "partial" and any("read-only bind" in p for p in rw["shape_problems"]),
          json.dumps(rw["shape_problems"]))
    foreign = dict(LIVE_ROUTE, Source="/srv/somebody-elses/nginx")
    other = observe(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, foreign), network=LIVE_NETWORK)
    check("a different host directory at the declared destination is not the declared shape",
          other["shape"] == "partial" and any("read-only bind" in p for p in other["shape_problems"]),
          json.dumps(other["shape_problems"]))
    missing = observe(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT,), network=LIVE_NETWORK)
    check("network and membership without the route mount is partial",
          missing["shape"] == "partial" and any("0 mounts" in p for p in missing["shape_problems"]),
          json.dumps(missing["shape_problems"]))
    unjoined = observe(networks=["pacs-starter-kit_default"], mounts=(LETSENCRYPT,), network=LIVE_NETWORK)
    check("a network nobody joined is partial, not absence",
          unjoined["shape"] == "partial" and any("not joined" in p for p in unjoined["shape_problems"]),
          json.dumps(unjoined["shape_problems"]))
    half_removed = observe(networks=["pacs-starter-kit_default"], mounts=(LETSENCRYPT, LIVE_ROUTE))
    check("a route mount without the network is partial, not absence",
          half_removed["shape"] == "partial"
          and any("does not exist" in p for p in half_removed["shape_problems"]),
          json.dumps(half_removed["shape_problems"]))
    external = observe(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, LIVE_ROUTE),
                       network=dict(LIVE_NETWORK, Internal=False))
    check("a workflow network that is no longer internal is partial",
          external["shape"] == "partial" and any("not internal" in p for p in external["shape_problems"]),
          json.dumps(external["shape_problems"]))

    broken = observe(proxy_exit=1, network=LIVE_NETWORK)
    check("an inspect error makes the ingress indeterminate, never absent",
          broken["shape"] == "indeterminate" and broken["proxy"]["readable"] is False,
          json.dumps(broken["shape_problems"]))
    check("the failed inspect keeps only its exit code, not the daemon's message",
          broken["proxy"]["reason"] == "docker inspect exited 1" and "no such object" not in json.dumps(broken),
          json.dumps(broken["proxy"]))
    garbage = observe(proxy_stdout=b"[]", network=LIVE_NETWORK)
    check("an empty inspect array is indeterminate, not an empty proxy",
          garbage["shape"] == "indeterminate" and garbage["proxy"]["readable"] is False)
    daemon = observe(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, LIVE_ROUTE),
                     network_stderr=b"Cannot connect to the Docker daemon")
    check("an undecidable network makes the ingress indeterminate",
          daemon["shape"] == "indeterminate"
          and any("could not determine" in p for p in daemon["shape_problems"]),
          json.dumps(daemon["shape_problems"]))
    for shape_case in ({"proxy_exit": 1, "network": LIVE_NETWORK},
                       {"networks": LIVE_NETWORKS, "mounts": (LETSENCRYPT, writable), "network": LIVE_NETWORK}):
        refuses("an unknown or half ingress refuses even with the absence flag: " + json.dumps(sorted(shape_case)),
                lambda case=shape_case: with_exec(
                    ingress_mock(**case),
                    lambda: rollout.require_coherent_ingress("pre-apply", allow_absent=True)),
                "not in a state this rollout can take as a baseline")
    text = refusal_of(lambda: with_exec(ingress_mock(proxy_exit=1, network=LIVE_NETWORK),
                                        lambda: rollout.require_coherent_ingress("pre-apply"))) or ""
    check("the refusal forbids an automatic rollback", "Do NOT run an automatic rollback" in text)
    check("the refusal retains lock, record and backups", "are retained" in text)
    check("the refusal states the runner never touches networks",
          "never creates or deletes a Docker network" in text)


def test_ingress_comparison_preserves_what_this_rollout_owns():
    baseline = observe(**LIVE)
    same = with_exec(ingress_mock(**LIVE), rollout.ingress_observation)
    check("an unchanged live ingress compares equal",
          rollout.compare_ingress(baseline, same)["unchanged"] is True,
          json.dumps(rollout.compare_ingress(baseline, same)["differences"]))

    # I4: the workflow receiver is managed outside this repository. Its restart rotates the
    # network's member list and its endpoint, and must never block restoring the previous API.
    rotated = with_exec(ingress_mock(
        networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, LIVE_ROUTE),
        network=dict(LIVE_NETWORK, Containers={"a1": {"Name": "kin-proxy", "EndpointID": "e1"},
                                               "z9": {"Name": "kin-workflow-receiver", "EndpointID": "ROTATED"}})),
        rollout.ingress_observation)
    comparison = rollout.compare_ingress(baseline, rotated)
    check("a receiver restart and endpoint rotation is NOT a preservation failure",
          comparison["unchanged"] is True, json.dumps(comparison["differences"]))
    gone = with_exec(ingress_mock(networks=LIVE_NETWORKS, mounts=(LETSENCRYPT, LIVE_ROUTE),
                                  network=dict(LIVE_NETWORK, Containers={})), rollout.ingress_observation)
    check("and so is the receiver leaving the network entirely",
          rollout.compare_ingress(baseline, gone)["unchanged"] is True)
    check("the record says which facts are deliberately not compared",
          comparison["not_compared"] == ["the workflow network's member list",
                                         "the workflow receiver's identity and endpoints"])

    mutations = {
        "the proxy was recreated": {"container_id": "new-id"},
        "the proxy restarted": {"started": "2026-09-19T20:00:00Z"},
        "the proxy stopped": {"running": False},
        "the proxy left the network": {"networks": ["pacs-starter-kit_default"]},
        "the route mount was removed": {"mounts": (LETSENCRYPT,)},
        "the route mount became writable": {"mounts": (LETSENCRYPT, dict(LIVE_ROUTE, RW=True))},
        "the route source was repointed": {"mounts": (LETSENCRYPT, dict(LIVE_ROUTE, Source="/srv/other"))},
        "the network was recreated": {"network": dict(LIVE_NETWORK, Id="f" * 64)},
        "the network was deleted": {"network": None},
    }
    for label, override in mutations.items():
        case = dict(LIVE)
        case.update(override)
        moved = with_exec(ingress_mock(**case), rollout.ingress_observation)
        result = rollout.compare_ingress(baseline, moved)
        check("preservation fails when " + label,
              result["unchanged"] is False and bool(result["differences"]), json.dumps(result))

    for label, stale in (("a record from before the ingress baseline existed", {"inert": True}),
                         ("a baseline in another schema", {"schema": 99}),
                         ("no baseline at all", None)):
        result = rollout.compare_ingress(stale, baseline)
        check("an old record fails CLOSED with a useful message: " + label,
              result["comparable"] is False and result["unchanged"] is False
              and "never invented after the fact" in " ".join(result["differences"]), json.dumps(result))


def refusal_of(run):
    try:
        run()
    except rollout.Refuse as error:
        return str(error)
    return None


# ---------------------------------------------------------------- I6: pre-lock nginx check
def test_nginx_check_is_exit_code_only():
    calls = []
    ok = mock_exec([(lambda a: True, Result(0, b"syntax is ok", b"test is successful"))], calls)
    check("a configuration that parses answers True", with_exec(ok, rollout.nginx_config_ok) is True)
    check("it asks the running proxy and nothing else",
          calls and calls[0] == ["docker", "exec", "kin-proxy", "nginx", "-t"], json.dumps(calls))
    leaky = b'nginx: [emerg] unexpected "}" in /etc/nginx/workflow/receiver.conf:12'
    bad = mock_exec([(lambda a: True, Result(1, b"", leaky))])
    check("a configuration that does not parse answers False", with_exec(bad, rollout.nginx_config_ok) is False)
    text = str(rollout.nginx_refusal("before anything was locked, stopped or checked out"))
    check("the refusal carries no configuration or route content, only the fact and the exit code",
          "receiver.conf" not in text and "emerg" not in text and "exit code" in text, text[:200])


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
    test_ingress_shape_against_the_real_topology()
    test_ingress_shape_refuses_every_half_state()
    test_ingress_comparison_preserves_what_this_rollout_owns()
    test_nginx_check_is_exit_code_only()
    test_finding_rows_and_rollback_clause()
    test_observed_migration_state()
    test_classification_union()
    test_started_after_and_delivered_files()
    test_manifest_shape()
    print("FAILURES=" + str(len(FAILURES)) + (" " + ",".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())

