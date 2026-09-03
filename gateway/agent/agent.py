"""KIN Gateway upload agent.

Only UIDs and counts are logged. Patient demographics travel in DICOM bytes but are never
written to the queue or logs.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests


MANAGED_PHASES = ("pending", "announcing", "sending", "retry", "complete")


class GatewayError(RuntimeError):
    """An error safe to persist and print (it must not contain response bodies)."""


def log(event: str, *, uid: str | None = None, **fields: Any) -> None:
    safe = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
    if uid:
        safe["uid"] = uid
    safe.update(fields)
    print(json.dumps(safe, ensure_ascii=False, separators=(",", ":")), flush=True)


def truthy(value: str) -> bool:
    return value.strip().lower() not in {"0", "false", "no", "off"}


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise GatewayError(f"missing environment: {name}")
    return value


@dataclass(frozen=True)
class Config:
    orthanc_url: str
    orthanc_user: str
    orthanc_pass: str
    kin_base_url: str
    client_id: str
    client_secret: str
    tls_verify: bool
    queue_db: str
    byte_budget: int
    poll_seconds: float
    http_timeout: float
    stow_timeout: float
    backoff_base: float
    backoff_max: float

    @classmethod
    def from_env(cls) -> "Config":
        budget_mib = float(os.environ.get("BYTE_BUDGET_MIB", "24"))
        if budget_mib <= 0 or budget_mib > 24:
            raise GatewayError("BYTE_BUDGET_MIB must be > 0 and <= 24")
        return cls(
            orthanc_url=required("LOCAL_ORTHANC_URL").rstrip("/"),
            orthanc_user=required("LOCAL_ORTHANC_USER"),
            orthanc_pass=required("LOCAL_ORTHANC_PASS"),
            kin_base_url=required("KIN_BASE_URL").rstrip("/"),
            client_id=required("KIN_CLIENT_ID"),
            client_secret=required("KIN_CLIENT_SECRET"),
            tls_verify=truthy(os.environ.get("KIN_TLS_VERIFY", "true")),
            queue_db=os.environ.get("QUEUE_DB", "/data/queue.db"),
            byte_budget=int(budget_mib * 1024 * 1024),
            poll_seconds=max(0.2, float(os.environ.get("POLL_SECONDS", "2"))),
            http_timeout=max(1, float(os.environ.get("HTTP_TIMEOUT_SECONDS", "30"))),
            stow_timeout=max(1, float(os.environ.get("STOW_TIMEOUT_SECONDS", "300"))),
            backoff_base=max(0.2, float(os.environ.get("BACKOFF_BASE_SECONDS", "5"))),
            backoff_max=max(1, float(os.environ.get("BACKOFF_MAX_SECONDS", "300"))),
        )


class Queue:
    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS studies (
            uid TEXT PRIMARY KEY,
            orthanc_id TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'pending',
            batch_index INTEGER NOT NULL DEFAULT 0,
            successful_sops TEXT NOT NULL DEFAULT '[]',
            attempt INTEGER NOT NULL DEFAULT 0,
            next_at REAL NOT NULL DEFAULT 0,
            last_error TEXT,
            updated_at REAL NOT NULL
          );
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        """)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def changes_since(self) -> int:
        row = self.db.execute("SELECT value FROM meta WHERE key='changes_since'").fetchone()
        return int(row["value"]) if row else 0

    def record_changes(self, studies: Iterable[tuple[str, str]], last: int) -> None:
        now = time.time()
        with self.db:
            for uid, orthanc_id in studies:
                self.db.execute("""
                  INSERT INTO studies(uid, orthanc_id, phase, next_at, updated_at)
                  VALUES (?, ?, 'pending', 0, ?)
                  ON CONFLICT(uid) DO UPDATE SET
                    orthanc_id=excluded.orthanc_id,
                    phase='pending', batch_index=0, attempt=0, next_at=0,
                    last_error=NULL, updated_at=excluded.updated_at
                """, (uid, orthanc_id, now))
            self.db.execute("""
              INSERT INTO meta(key, value) VALUES ('changes_since', ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """, (str(last),))

    def due(self) -> sqlite3.Row | None:
        return self.db.execute("""
          SELECT * FROM studies
          WHERE phase <> 'complete' AND next_at <= ?
          ORDER BY updated_at, uid LIMIT 1
        """, (time.time(),)).fetchone()

    def successes(self, uid: str) -> set[str]:
        row = self.db.execute("SELECT successful_sops FROM studies WHERE uid=?", (uid,)).fetchone()
        if not row:
            return set()
        try:
            value = json.loads(row["successful_sops"])
            return {str(item) for item in value if isinstance(item, str)}
        except (TypeError, json.JSONDecodeError):
            return set()

    def phase(self, uid: str, phase: str, batch_index: int | None = None) -> None:
        if phase not in MANAGED_PHASES:
            raise ValueError(f"unknown phase: {phase}")
        values: list[Any] = [phase, time.time(), uid]
        sql = "UPDATE studies SET phase=?, updated_at=?"
        if batch_index is not None:
            sql += ", batch_index=?"
            values = [phase, time.time(), batch_index, uid]
        sql += " WHERE uid=?"
        with self.db:
            self.db.execute(sql, values)

    def add_successes(self, uid: str, sops: set[str], batch_index: int) -> None:
        merged = self.successes(uid) | sops
        with self.db:
            self.db.execute("""
              UPDATE studies SET successful_sops=?, batch_index=?, updated_at=? WHERE uid=?
            """, (json.dumps(sorted(merged)), batch_index, time.time(), uid))

    def complete(self, uid: str) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='complete', attempt=0, next_at=0,
                last_error=NULL, updated_at=? WHERE uid=?
            """, (time.time(), uid))

    def pending_now(self, uid: str) -> None:
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='pending', attempt=0, next_at=0,
                last_error=NULL, updated_at=? WHERE uid=?
            """, (time.time(), uid))

    def retry(self, uid: str, reason: str, base: float, maximum: float) -> tuple[int, float]:
        row = self.db.execute("SELECT attempt FROM studies WHERE uid=?", (uid,)).fetchone()
        attempt = int(row["attempt"] if row else 0) + 1
        delay = min(maximum, base * (2 ** min(attempt - 1, 16)))
        with self.db:
            self.db.execute("""
              UPDATE studies SET phase='retry', attempt=?, next_at=?, last_error=?, updated_at=?
              WHERE uid=?
            """, (attempt, time.time() + delay, reason[:160], time.time(), uid))
        return attempt, delay

    def summary(self) -> dict[str, Any]:
        counts = {row["phase"]: row["n"] for row in self.db.execute(
            "SELECT phase, count(*) AS n FROM studies GROUP BY phase"
        )}
        rows = [{
            "uid": row["uid"], "phase": row["phase"], "batchIndex": row["batch_index"],
            "successfulSops": len(json.loads(row["successful_sops"])), "attempt": row["attempt"],
        } for row in self.db.execute("SELECT * FROM studies ORDER BY updated_at, uid")]
        return {
            "pending": sum(count for phase, count in counts.items() if phase != "complete"),
            "complete": counts.get("complete", 0),
            "rows": rows,
        }


class Orthanc:
    def __init__(self, config: Config):
        self.base = config.orthanc_url
        self.auth = (config.orthanc_user, config.orthanc_pass)
        self.timeout = config.http_timeout
        self.session = requests.Session()

    def request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        try:
            response = self.session.request(
                method, self.base + path, auth=self.auth, timeout=self.timeout, **kwargs,
            )
        except requests.RequestException as error:
            raise GatewayError(f"local Orthanc {type(error).__name__}") from None
        if not response.ok:
            raise GatewayError(f"local Orthanc HTTP {response.status_code}")
        return response

    def changes(self, since: int) -> dict[str, Any]:
        return self.request("GET", "/changes", params={"since": since, "limit": 100}).json()

    def study(self, uid: str, preferred_id: str = "") -> tuple[str, dict[str, Any]]:
        if preferred_id:
            try:
                detail = self.request("GET", f"/studies/{preferred_id}").json()
                if str((detail.get("MainDicomTags") or {}).get("StudyInstanceUID", "")) == uid:
                    return preferred_id, detail
            except GatewayError:
                pass
        found = self.request(
            "POST", "/tools/lookup", data=uid.encode("ascii"),
            headers={"Content-Type": "text/plain"},
        ).json()
        studies = [item for item in found if item.get("Type") == "Study"]
        if len(studies) != 1:
            raise GatewayError(f"local study lookup count={len(studies)}")
        orthanc_id = str(studies[0]["ID"])
        return orthanc_id, self.request("GET", f"/studies/{orthanc_id}").json()

    def instances(self, uid: str, preferred_id: str) -> tuple[str, dict[str, Any], list[dict[str, Any]]]:
        orthanc_id, detail = self.study(uid, preferred_id)
        items = self.request("GET", f"/studies/{orthanc_id}/instances").json()
        normalized = []
        for item in items:
            sop = str((item.get("MainDicomTags") or {}).get("SOPInstanceUID", ""))
            instance_id = str(item.get("ID", ""))
            size = int(item.get("FileSize", 0))
            if not sop or not instance_id or size <= 0:
                raise GatewayError("local instance metadata incomplete")
            normalized.append({"sop": sop, "id": instance_id, "size": size})
        if len({item["sop"] for item in normalized}) != len(normalized):
            raise GatewayError("duplicate local SOPInstanceUID")
        normalized.sort(key=lambda item: item["sop"])
        return orthanc_id, detail, normalized

    def file(self, instance_id: str) -> bytes:
        return self.request("GET", f"/instances/{instance_id}/file").content


class Cloud:
    def __init__(self, config: Config):
        self.base = config.kin_base_url
        self.token_url = self.base + "/auth/realms/kin/protocol/openid-connect/token"
        self.client_id = config.client_id
        self.client_secret = config.client_secret
        self.verify = config.tls_verify
        self.http_timeout = config.http_timeout
        self.stow_timeout = config.stow_timeout
        self.session = requests.Session()
        self.access_token = ""
        self.token_until = 0.0
        if not self.verify:
            requests.packages.urllib3.disable_warnings(  # type: ignore[attr-defined]
                requests.packages.urllib3.exceptions.InsecureRequestWarning,  # type: ignore[attr-defined]
            )

    def token(self, force: bool = False) -> str:
        if not force and self.access_token and time.time() < self.token_until:
            return self.access_token
        try:
            response = self.session.post(self.token_url, data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }, timeout=self.http_timeout, verify=self.verify)
        except requests.RequestException as error:
            raise GatewayError(f"token request {type(error).__name__}") from None
        if not response.ok:
            raise GatewayError(f"token request HTTP {response.status_code}")
        try:
            payload = response.json()
            self.access_token = str(payload["access_token"])
            expires_in = max(1, int(payload.get("expires_in", 60)))
        except (KeyError, TypeError, ValueError, requests.JSONDecodeError):
            raise GatewayError("token response invalid") from None
        self.token_until = time.time() + max(1, expires_in - 30)
        return self.access_token

    def request(self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any) -> requests.Response:
        base_headers = dict(kwargs.pop("headers", {}))
        for index in range(2):
            headers = dict(base_headers)
            headers["Authorization"] = "Bearer " + self.token(force=index == 1)
            try:
                response = self.session.request(
                    method, self.base + path, headers=headers,
                    timeout=timeout or self.http_timeout, verify=self.verify, **kwargs,
                )
            except requests.RequestException as error:
                raise GatewayError(f"cloud request {type(error).__name__}") from None
            if response.status_code != 401 or index == 1:
                return response
        raise GatewayError("cloud authentication failed")

    def announce(self, uid: str, institution_name: str) -> None:
        response = self.request("POST", "/api/gateway/announce", json={
            "studyUid": uid,
            "institutionNameTag": institution_name,
        })
        if not response.ok:
            raise GatewayError(f"announce HTTP {response.status_code}")

    def stow(self, uid: str, body: bytes, content_type: str) -> set[str]:
        response = self.request(
            "POST", f"/dicom-web/studies/{uid}", data=body,
            headers={"Content-Type": content_type, "Accept": "application/dicom+json"},
            timeout=self.stow_timeout,
        )
        if not response.ok:
            raise GatewayError(f"STOW HTTP {response.status_code}")
        try:
            payload = response.json() if response.content else {}
        except requests.JSONDecodeError:
            raise GatewayError("STOW response invalid") from None
        return failed_sops(payload)


def failed_sops(payload: Any) -> set[str]:
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    if not isinstance(payload, dict):
        raise GatewayError("STOW response shape invalid")
    sequence = payload.get("00081198", {}).get("Value", [])
    if not isinstance(sequence, list):
        raise GatewayError("STOW failure sequence invalid")
    failures = set()
    for item in sequence:
        values = item.get("00081155", {}).get("Value", []) if isinstance(item, dict) else []
        if values and isinstance(values[0], str):
            failures.add(values[0])
        else:
            raise GatewayError("STOW failure item missing SOPInstanceUID")
    return failures


def plan_batches(instances: list[dict[str, Any]], budget: int) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    used = 128
    for item in instances:
        estimated = int(item["size"]) + 512
        if estimated + 128 > budget:
            raise GatewayError("single DICOM instance exceeds byte budget")
        if current and used + estimated > budget:
            batches.append(current)
            current = []
            used = 128
        current.append(item)
        used += estimated
    if current:
        batches.append(current)
    return batches


def multipart(parts: list[tuple[str, bytes]], budget: int) -> tuple[bytes, str]:
    boundary = "kin-gateway-" + uuid.uuid4().hex
    body = bytearray()
    for _sop, content in parts:
        body.extend(f"--{boundary}\r\n".encode("ascii"))
        body.extend(b"Content-Type: application/dicom\r\n")
        body.extend(f"Content-Length: {len(content)}\r\n\r\n".encode("ascii"))
        body.extend(content)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("ascii"))
    if len(body) > budget:
        raise GatewayError("multipart body exceeds byte budget")
    return bytes(body), f'multipart/related; type="application/dicom"; boundary={boundary}'


class Agent:
    def __init__(self, config: Config):
        self.config = config
        self.queue = Queue(config.queue_db)
        self.orthanc = Orthanc(config)
        self.cloud = Cloud(config)
        self.stopping = False

    def stop(self, *_args: Any) -> None:
        self.stopping = True

    def poll_changes(self) -> None:
        while not self.stopping:
            since = self.queue.changes_since()
            payload = self.orthanc.changes(since)
            changes = payload.get("Changes", [])
            stable: list[tuple[str, str]] = []
            for change in changes:
                if change.get("ChangeType") != "StableStudy":
                    continue
                orthanc_id = str(change.get("ID", ""))
                if not orthanc_id:
                    raise GatewayError("StableStudy missing Orthanc ID")
                detail = self.orthanc.request("GET", f"/studies/{orthanc_id}").json()
                uid = str((detail.get("MainDicomTags") or {}).get("StudyInstanceUID", ""))
                if not uid:
                    raise GatewayError("StableStudy missing StudyInstanceUID")
                stable.append((uid, orthanc_id))
            last = int(payload.get("Last", since))
            self.queue.record_changes(stable, last)
            for uid, _orthanc_id in stable:
                log("study.queued", uid=uid)
            if payload.get("Done", True):
                return

    def process(self, row: sqlite3.Row) -> None:
        uid = str(row["uid"])
        self.queue.phase(uid, "announcing")
        orthanc_id, detail, instances = self.orthanc.instances(uid, str(row["orthanc_id"]))
        institution_name = str((detail.get("MainDicomTags") or {}).get("InstitutionName", ""))
        self.cloud.announce(uid, institution_name)

        local_sops = {item["sop"] for item in instances}
        successful = self.queue.successes(uid)
        pending = [item for item in instances if item["sop"] not in successful]
        batches = plan_batches(pending, self.config.byte_budget)
        for batch_index, batch in enumerate(batches, int(row["batch_index"]) + 1):
            self.queue.phase(uid, "sending", batch_index)
            parts = [(item["sop"], self.orthanc.file(item["id"])) for item in batch]
            body, content_type = multipart(parts, self.config.byte_budget)
            failures = self.cloud.stow(uid, body, content_type)
            batch_sops = {item["sop"] for item in batch}
            unknown = failures - batch_sops
            if unknown:
                raise GatewayError("STOW response named an unknown failed SOP")
            self.queue.add_successes(uid, batch_sops - failures, batch_index)
            log(
                "batch.stored", uid=uid, batch=batch_index, sops=len(batch),
                failed=len(failures), bytes=len(body),
            )
            if failures:
                raise GatewayError(f"STOW failed SOP count={len(failures)}")

        # 전송 중 새 인스턴스가 도착했을 수 있다. 개수가 아니라 양쪽 SOP 집합이 같아야 끝난다.
        _orthanc_id, _detail, latest = self.orthanc.instances(uid, orthanc_id)
        latest_sops = {item["sop"] for item in latest}
        successful = self.queue.successes(uid)
        missing = latest_sops - successful
        extra = successful - latest_sops
        if extra:
            raise GatewayError(f"successful SOP absent locally count={len(extra)}")
        if missing:
            self.queue.pending_now(uid)
            log("study.delta", uid=uid, pending=len(missing))
            return
        self.queue.complete(uid)
        log("study.complete", uid=uid, sops=len(successful))

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        log("agent.started", byteBudget=self.config.byte_budget)
        while not self.stopping:
            try:
                self.poll_changes()
                row = self.queue.due()
                if row:
                    uid = str(row["uid"])
                    try:
                        self.process(row)
                    except Exception as error:
                        reason = str(error) if isinstance(error, GatewayError) else type(error).__name__
                        attempt, delay = self.queue.retry(
                            uid, reason, self.config.backoff_base, self.config.backoff_max,
                        )
                        log("study.retry", uid=uid, attempt=attempt, afterSeconds=round(delay, 2), error=reason)
                        continue
            except Exception as error:
                reason = str(error) if isinstance(error, GatewayError) else type(error).__name__
                log("agent.retry", error=reason)
            time.sleep(self.config.poll_seconds)
        self.queue.close()
        log("agent.stopped")


def status(path: str) -> int:
    queue = Queue(path)
    try:
        print(json.dumps(queue.summary(), separators=(",", ":")))
        return 0
    finally:
        queue.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run")
    show = sub.add_parser("status")
    show.add_argument("--db", default=os.environ.get("QUEUE_DB", "/data/queue.db"))
    args = parser.parse_args()
    if args.command == "status":
        return status(args.db)
    Agent(Config.from_env()).run()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GatewayError as error:
        log("agent.fatal", error=str(error))
        raise SystemExit(2)
