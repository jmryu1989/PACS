"""LOCAL DEVELOPMENT ONLY: destructive-to-fixtures C-6 verification.

The script creates isolated Keycloak identities, Gateway volumes, and DICOM fixtures, then
removes all of them. Generated secrets live only in a temporary .env file and are never printed.
Never point it at a production realm or a medical-institution Gateway.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from invariants_live import Fixture, HttpResult, LiveStack  # noqa: E402


def require(result: HttpResult, status: int, label: str) -> HttpResult:
    if result.status != status:
        raise AssertionError(f"{label}: HTTP {result.status}")
    return result


def run(command: list[str], *, env: dict[str, str] | None = None, timeout: int = 120,
        check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        command, cwd=ROOT, env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )
    if check and completed.returncode:
        raise RuntimeError(f"command failed ({command[0]} {command[1]}): exit {completed.returncode}")
    return completed


def add_mapper(stack: LiveStack, client_uuid: str, mapper: dict) -> None:
    require(
        stack.kc_admin("POST", f"/clients/{quote(client_uuid)}/protocol-mappers/models", mapper),
        201, "client mapper",
    )


def provision_gateway(stack: LiveStack, suffix: str, cleanup: dict[str, object]) -> tuple[str, str]:
    role = stack.kc_admin("GET", "/roles/gateway")
    if role.status == 404:
        require(stack.kc_admin("POST", "/roles", {"name": "gateway"}), 201, "gateway role create")
        cleanup["role_created"] = True
        role = require(stack.kc_admin("GET", "/roles/gateway"), 200, "gateway role lookup")
    else:
        require(role, 200, "gateway role lookup")

    groups = require(stack.kc_admin("GET", "/groups?search=kin-center"), 200, "institution group")
    exact = [group for group in groups.body if group.get("name") == "kin-center"]
    if len(exact) != 1:
        raise AssertionError("kin-center group must be unique")

    client_id = "gw-kin-center-c6-" + suffix
    secret = uuid.uuid4().hex + uuid.uuid4().hex
    created = require(stack.kc_admin("POST", "/clients", {
        "clientId": client_id,
        "name": "KIN temporary C-6 gateway verification",
        "enabled": True,
        "publicClient": False,
        "secret": secret,
        "standardFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": True,
        "protocol": "openid-connect",
    }), 201, "gateway client")
    client_uuid = str(created.body)
    cleanup["client_uuid"] = client_uuid
    add_mapper(stack, client_uuid, {
        "name": "kin-api-audience", "protocol": "openid-connect",
        "protocolMapper": "oidc-audience-mapper", "consentRequired": False,
        "config": {
            "included.custom.audience": "kin-api", "id.token.claim": "false",
            "access.token.claim": "true",
        },
    })
    add_mapper(stack, client_uuid, {
        "name": "kin-institution-groups", "protocol": "openid-connect",
        "protocolMapper": "oidc-group-membership-mapper", "consentRequired": False,
        "config": {
            "full.path": "false", "id.token.claim": "false",
            "access.token.claim": "true", "userinfo.token.claim": "false",
            "claim.name": "groups",
        },
    })
    service = require(
        stack.kc_admin("GET", f"/clients/{quote(client_uuid)}/service-account-user"),
        200, "service account",
    )
    service_id = quote(str(service.body["id"]))
    require(
        stack.kc_admin("PUT", f"/users/{service_id}/groups/{quote(str(exact[0]['id']))}"),
        204, "service group",
    )
    require(
        stack.kc_admin("POST", f"/users/{service_id}/role-mappings/realm", [role.body]),
        204, "service role",
    )
    return client_id, secret


def write_env(path: Path, values: dict[str, str]) -> None:
    path.write_text("\n".join(f"{key}={value}" for key, value in values.items()) + "\n", encoding="utf-8")


def compose(env_file: Path, *args: str, env: dict[str, str], timeout: int = 120,
            check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(
        ["docker", "compose", "--env-file", str(env_file), "-f", "gateway/docker-compose.yml", *args],
        env=env, timeout=timeout, check=check,
    )


def send_study(port: int, slices: int, *, largest: bool = False,
               study_uid: str | None = None, patient_id: str | None = None,
               offset: int = 0) -> str:
    fixture_patient_id = patient_id or "C6-" + uuid.uuid4().hex[:12]
    command = [
        sys.executable, str(ROOT / "scripts" / "send_cstore.py"),
        "--host", "127.0.0.1", "--port", str(port), "--called-aet", "KINGW",
        "--calling-aet", "KINC_CT", "--institution", "KIN 판독센터",
        "--name", "C6^FIXTURE", "--id", fixture_patient_id,
        "--desc", "C6 gateway verification", "--slices", str(slices),
        "--instance-offset", str(offset),
    ]
    if largest:
        command.append("--largest-series")
    if study_uid:
        command += ["--study-uid", study_uid]
    completed = run(command, timeout=1800)
    match = re.search(r"StudyUID\s+([0-9.]+)", completed.stdout)
    if not match:
        raise RuntimeError("send_cstore did not report a StudyUID")
    return match.group(1)


def status(container: str) -> dict:
    completed = run(
        ["docker", "exec", container, "python", "/app/agent.py", "status", "--db", "/data/queue.db"],
        timeout=30,
    )
    return json.loads(completed.stdout)


def wait_phase(container: str, uid: str, phase: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        summary = status(container)
        row = next((item for item in summary["rows"] if item["uid"] == uid), None)
        if row and row["phase"] == phase:
            return summary
        time.sleep(1)
    raise TimeoutError(f"gateway queue did not reach {phase}: {uid}")


def orthanc_sops(base: str, auth: tuple[str, str], uid: str) -> tuple[set[str], int]:
    found = requests.post(base + "/tools/lookup", data=uid, auth=auth, timeout=30)
    found.raise_for_status()
    studies = [item for item in found.json() if item.get("Type") == "Study"]
    if len(studies) != 1:
        raise AssertionError(f"study lookup count={len(studies)}")
    items = requests.get(
        base + f"/studies/{studies[0]['ID']}/instances", auth=auth, timeout=60,
    )
    items.raise_for_status()
    payload = items.json()
    sops = {
        str((item.get("MainDicomTags") or {}).get("SOPInstanceUID", ""))
        for item in payload
    }
    if "" in sops:
        raise AssertionError("missing SOPInstanceUID")
    return sops, len(payload)


def agent_events(container: str) -> list[dict]:
    completed = run(["docker", "logs", container], timeout=30)
    events = []
    for line in completed.stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def assert_worklist(stack: LiveStack, uid: str) -> None:
    listed = require(stack.request("GET", "/studies", "kdoctor"), 200, "worklist")
    row = next((study for study in listed.body.get("studies", []) if study.get("uid") == uid), None)
    if not row:
        raise AssertionError("gateway study missing from institution worklist")
    if row.get("institutionName") != "KIN 판독센터" or row.get("state", {}).get("ss") != "Unverified":
        raise AssertionError("gateway study ownership or initial state mismatch")


def audit_once(stack: LiveStack, uid: str) -> None:
    audits = require(stack.request("GET", "/audit?uid=" + quote(uid), "kdoctor"), 200, "audit")
    if len([row for row in audits.body if row.get("action") == "study.announce"]) != 1:
        raise AssertionError("study.announce audit count is not one")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LOCAL DEVELOPMENT ONLY: creates and removes Keycloak and DICOM fixtures",
    )
    parser.add_argument("--outage-seconds", type=int, default=300)
    parser.add_argument("--large-slices", type=int, default=501)
    parser.add_argument(
        "--invariant-smoke", action="store_true",
        help="run the local-only C-7 KIN_TEST_INGEST=gateway smoke and exit",
    )
    args = parser.parse_args()
    if args.outage_seconds < 1 or args.large_slices < 1:
        parser.error("durations and slice counts must be positive")

    stack = LiveStack()
    suffix = uuid.uuid4().hex[:8]
    cleanup_state: dict[str, object] = {"client_uuid": "", "role_created": False}
    started = False
    project = "kin-gateway-c6-" + suffix
    agent_container = "kin-gw-agent-c6-" + suffix
    orthanc_container = "kin-gw-orthanc-c6-" + suffix
    local_network = "kin-gateway-local-c6-" + suffix
    cloud_network = "kin-gateway-cloud-c6-" + suffix
    ingress_network = "kin-gateway-ingress-c6-" + suffix
    dicom_port = 14243
    http_port = 18043

    try:
        stack.require_stack()
        client_id, client_secret = provision_gateway(stack, suffix, cleanup_state)
        with tempfile.TemporaryDirectory(prefix="kin-c6-") as directory:
            env_file = Path(directory) / ".env"
            values = {
                "GW_PROJECT_NAME": project,
                "GW_AGENT_CONTAINER": agent_container,
                "GW_ORTHANC_CONTAINER": orthanc_container,
                "GW_LOCAL_NETWORK": local_network,
                "GW_CLOUD_NETWORK": cloud_network,
                "GW_INGRESS_NETWORK": ingress_network,
                "GW_ORTHANC_USER": "agent",
                "GW_ORTHANC_PASS": uuid.uuid4().hex + uuid.uuid4().hex,
                "GW_DICOM_PORT": str(dicom_port),
                "GW_ORTHANC_HTTP_PORT": str(http_port),
                "GW_STABLE_AGE": "2",
                "KIN_BASE_URL": "https://host.docker.internal:9443",
                "KIN_CLIENT_ID": client_id,
                "KIN_CLIENT_SECRET": client_secret,
                "KIN_TLS_VERIFY": "false",
                "GW_BYTE_BUDGET_MIB": "24",
                "GW_POLL_SECONDS": "1",
                "GW_HTTP_TIMEOUT_SECONDS": "5",
                "GW_STOW_TIMEOUT_SECONDS": "300",
                "GW_BACKOFF_BASE_SECONDS": "1",
                "GW_BACKOFF_MAX_SECONDS": "30",
            }
            write_env(env_file, values)
            process_env = {**os.environ, **values}
            started = True
            compose(env_file, "up", "-d", "--build", env=process_env, timeout=600)

            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                shown = compose(env_file, "ps", "--format", "json", env=process_env, timeout=30)
                if agent_container in shown.stdout and orthanc_container in shown.stdout:
                    try:
                        status(agent_container)
                        break
                    except Exception:
                        pass
                time.sleep(1)
            else:
                raise TimeoutError("gateway containers did not become ready")

            if args.invariant_smoke:
                smoke_env = {
                    **process_env,
                    "KIN_TEST_INGEST": "gateway",
                    "KIN_TEST_GATEWAY_HOST": "127.0.0.1",
                    "KIN_TEST_GATEWAY_PORT": str(dicom_port),
                    "KIN_TEST_GATEWAY_AET": "KINGW",
                    "KIN_TEST_GATEWAY_INSTITUTION_NAME": "KIN 판독센터",
                }
                smoke = run(
                    [
                        sys.executable, str(ROOT / "tests" / "invariants_live.py"),
                        "LiveInvariantTests.test_selected_ingest_reaches_worklist",
                    ],
                    env=smoke_env, timeout=300, check=False,
                )
                if smoke.returncode:
                    raise RuntimeError(
                        "C-7 gateway fixture smoke failed\n" + smoke.stdout + smoke.stderr
                    )
                if "Ran 1 test" not in smoke.stdout + smoke.stderr:
                    raise RuntimeError("C-7 gateway fixture smoke did not execute exactly one test")
                print("TEST-C-7 KIN_TEST_INGEST=gateway: fixture → KIN worklist PASS")
                return

            # 1) Connected two-stack receive and the late-instance base study.
            late_patient_id = "C6-" + uuid.uuid4().hex[:12]
            late_uid = send_study(dicom_port, 1, patient_id=late_patient_id)
            stack.active[late_uid] = Fixture(late_uid, "", "KIN 판독센터", "kdoctor", "")
            wait_phase(agent_container, late_uid, "complete", 180)
            assert_worklist(stack, late_uid)
            audit_once(stack, late_uid)

            # 2) Real 252 MiB public CT series, split below the unchanged nginx 32 MiB limit.
            large_uid = send_study(dicom_port, args.large_slices, largest=True)
            stack.active[large_uid] = Fixture(large_uid, "", "KIN 판독센터", "kdoctor", "")
            wait_phase(agent_container, large_uid, "complete", 1800)
            audit_once(stack, large_uid)

            local_auth = (values["GW_ORTHANC_USER"], values["GW_ORTHANC_PASS"])
            cloud_auth = (stack.orthanc_user, stack.orthanc_password)
            local_large, local_large_count = orthanc_sops(
                f"http://127.0.0.1:{http_port}", local_auth, large_uid,
            )
            cloud_large, cloud_large_count = orthanc_sops(stack.orthanc, cloud_auth, large_uid)
            large_bytes = sum(
                int(item.get("bytes", 0)) for item in agent_events(agent_container)
                if item.get("event") == "batch.stored" and item.get("uid") == large_uid
            )
            large_batches = [
                item for item in agent_events(agent_container)
                if item.get("event") == "batch.stored" and item.get("uid") == large_uid
            ]
            if any(int(item.get("bytes", 0)) > 24 * 1024 * 1024 for item in large_batches):
                raise AssertionError("a STOW batch exceeded 24 MiB")
            if args.large_slices == 501 and not (250 * 1024 * 1024 <= large_bytes <= 255 * 1024 * 1024):
                raise AssertionError(f"large series byte total outside expected range: {large_bytes}")

            # 3) Keep only the internal network for at least the requested outage duration.
            run(["docker", "network", "disconnect", cloud_network, agent_container], timeout=30)
            disconnected_at = time.monotonic()
            outage_uid = send_study(dicom_port, 1)
            stack.active[outage_uid] = Fixture(outage_uid, "", "KIN 판독센터", "kdoctor", "")
            wait_phase(agent_container, outage_uid, "retry", 60)
            first_pending = status(agent_container)["pending"]
            remaining = args.outage_seconds - (time.monotonic() - disconnected_at)
            if remaining > 0:
                time.sleep(remaining)
            held_seconds = time.monotonic() - disconnected_at
            last_pending = status(agent_container)["pending"]
            if first_pending != 1 or last_pending != 1:
                raise AssertionError(f"offline pending changed: {first_pending}->{last_pending}")
            run(["docker", "network", "connect", cloud_network, agent_container], timeout=30)
            recovered = wait_phase(agent_container, outage_uid, "complete", 180)
            if recovered["pending"] != 0:
                raise AssertionError("gateway queue did not drain")
            audit_once(stack, outage_uid)

            # 4/5) Compare SOP sets and counts on both sides; list length proves no duplicate rows.
            compared = []
            for uid in (late_uid, large_uid, outage_uid):
                local_sops, local_count = orthanc_sops(
                    f"http://127.0.0.1:{http_port}", local_auth, uid,
                )
                cloud_sops, cloud_count = orthanc_sops(stack.orthanc, cloud_auth, uid)
                if local_sops != cloud_sops:
                    raise AssertionError(f"SOP set mismatch: {uid}")
                if local_count != len(local_sops) or cloud_count != len(cloud_sops):
                    raise AssertionError(f"duplicate SOP rows: {uid}")
                compared.append((uid, len(local_sops)))

            # 6) A repeated StableStudy must retain the success set and send the one-SOP delta only.
            events_before = len([
                item for item in agent_events(agent_container)
                if item.get("event") == "batch.stored" and item.get("uid") == late_uid
            ])
            send_study(
                dicom_port, 1, study_uid=late_uid,
                patient_id=late_patient_id, offset=1,
            )
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                new_batches = [
                    item for item in agent_events(agent_container)
                    if item.get("event") == "batch.stored" and item.get("uid") == late_uid
                ][events_before:]
                row = next((
                    item for item in status(agent_container)["rows"] if item["uid"] == late_uid
                ), None)
                if new_batches and row and row["phase"] == "complete":
                    break
                time.sleep(1)
            else:
                raise TimeoutError("late SOP delta did not complete")
            local_late, local_late_count = orthanc_sops(
                f"http://127.0.0.1:{http_port}", local_auth, late_uid,
            )
            cloud_late, cloud_late_count = orthanc_sops(stack.orthanc, cloud_auth, late_uid)
            late_batches = [
                item for item in agent_events(agent_container)
                if item.get("event") == "batch.stored" and item.get("uid") == late_uid
            ][events_before:]
            if local_late != cloud_late or local_late_count != 2 or cloud_late_count != 2:
                raise AssertionError("late SOP did not converge")
            if len(late_batches) != 1 or int(late_batches[0].get("sops", 0)) != 1:
                raise AssertionError(f"late delta was not exactly one SOP: {late_batches}")
            audit_once(stack, late_uid)

            print(f"TEST-C-6 2스택 수신: Gateway C-STORE → KIN Unverified·kin-center 워크리스트 등장 PASS")
            print(f"TEST-C-6 252 MiB 완주: {local_large_count} SOP, {large_bytes / 1048576:.1f} MiB, {len(large_batches)} batches, max≤24 MiB PASS")
            print(f"TEST-C-6 300초 단절: cloud network {held_seconds:.1f}s 차단 중 pending=1 유지 → reconnect pending=0 PASS")
            print(f"TEST-C-6 SOP 집합: local/cloud 3 studies exact match ({sum(count for _, count in compared)} SOP before delta) PASS")
            print(f"TEST-C-6 중복 0: local/cloud instance rows 모두 unique SOP count와 일치 PASS")
            print(f"TEST-C-6 늦은 1건: 완료 후 StableStudy 재발화 → 새 batch 1개·SOP 1건만 전송, 양쪽 2건 PASS")
    finally:
        if started:
            # Only this run's unique project, containers, networks, and fixture volumes are targeted.
            try:
                with tempfile.TemporaryDirectory(prefix="kin-c6-clean-") as directory:
                    cleanup_env = Path(directory) / ".env"
                    cleanup_values = {
                        "GW_PROJECT_NAME": project,
                        "GW_AGENT_CONTAINER": agent_container,
                        "GW_ORTHANC_CONTAINER": orthanc_container,
                        "GW_LOCAL_NETWORK": local_network,
                        "GW_CLOUD_NETWORK": cloud_network,
                        "GW_INGRESS_NETWORK": ingress_network,
                        "GW_ORTHANC_PASS": "cleanup-placeholder",
                        "KIN_BASE_URL": "https://host.docker.internal:9443",
                        "KIN_CLIENT_ID": "gw-cleanup",
                        "KIN_CLIENT_SECRET": "cleanup-placeholder",
                    }
                    write_env(cleanup_env, cleanup_values)
                    compose(
                        cleanup_env, "down", "-v", "--remove-orphans",
                        env={**os.environ, **cleanup_values}, timeout=180, check=False,
                    )
            except Exception:
                pass
        try:
            stack.cleanup_all()
        finally:
            try:
                # The full outage test intentionally runs beyond Keycloak's short-lived
                # admin access token. Refresh before deleting generated users and clients.
                stack._admin_login()
                stack.cleanup_test_identities()
            finally:
                client_uuid = str(cleanup_state["client_uuid"])
                if client_uuid:
                    stack.kc_admin("DELETE", f"/clients/{quote(client_uuid)}")
                if cleanup_state["role_created"]:
                    stack.kc_admin("DELETE", "/roles/gateway")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"TEST-C-6 FAIL: {type(error).__name__}: {error}", file=sys.stderr)
        raise
