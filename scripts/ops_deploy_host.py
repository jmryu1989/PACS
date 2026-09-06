"""Protected Linux host adapter for the C1 runner. No caller-selected commands.

Install via the separate isolated entrypoint. An enabled root-owned policy and
verified, request-bound operator attestations are prerequisites, not generated here.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default as email_policy
import hashlib
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler, HTTPSHandler
import uuid

import ops_backup as ops
import ops_deploy_preflight as pre
import ops_deploy_runner as runner
from ops_monitor import NoRedirect, origin_url
from ops_email_monitor import credentials, address

ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8",
       "DOCKER_HOST": "unix:///var/run/docker.sock", "GIT_CONFIG_NOSYSTEM": "1",
       "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
FRAME = re.compile(r"/dicom-web/studies/[0-9.]{1,64}/series/[0-9.]{1,64}/instances/[0-9.]{1,64}/frames/[1-9][0-9]{0,7}")
DIRS = ("approvals", "evidence", "used", "journal", "outbox", "refusals")
POLICY_KEYS = {"schema", "enabled", "repository", "state_dir", "compose_sha256", "origin", "smoke", "mail"}
MAX_FRAME = 16 * 1024 * 1024


def require(value):
    pre.require(value, "Invalid protected deployment state")


def protected(path, *, private=False, directory=False):
    path = Path(path)
    require(os.name == "posix" and os.geteuid() == 0 and path.is_absolute())
    require(".." not in path.parts)
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0)
        # A root-owned sticky /tmp may contain a private rehearsal root. A
        # writable non-sticky ancestor would allow replacing the protected tree.
        require(not info.st_mode & 0o022 or (item != path and stat.S_ISDIR(info.st_mode)
                                           and info.st_mode & stat.S_ISVTX))
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    require(not private or not info.st_mode & 0o077)
    return path


def read_secure(path, limit=65536):
    path = protected(path, private=True)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        info = os.fstat(stream.fileno())
        require(info.st_uid == 0 and info.st_nlink == 1 and stat.S_ISREG(info.st_mode)
                and not info.st_mode & 0o077 and info.st_size <= limit)
        value = stream.read(limit + 1)
        require(len(value) <= limit)
        return value


def decode(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pre.unique_object)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_secure(path, value, *, exclusive=False, append=False):
    path = Path(path)
    protected(path.parent, private=True, directory=True)
    if path.exists() or path.is_symlink():
        protected(path, private=True)
    raw = (json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n").encode()
    if append or exclusive:
        flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_APPEND if append else os.O_EXCL)
        with os.fdopen(os.open(path, flags, 0o600), "ab" if append else "wb") as stream:
            info = os.fstat(stream.fileno())
            require(info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        sync_dir(path.parent)
        return
    temporary = path.parent / (".pending-" + uuid.uuid4().hex)
    try:
        write_secure(temporary, value, exclusive=True)
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def policy_valid(value):
    require(type(value) is dict and set(value) == POLICY_KEYS)
    require(type(value["schema"]) is int and value["schema"] == 1 and type(value["enabled"]) is bool)
    require(type(value["compose_sha256"]) is str and pre.HASH.fullmatch(value["compose_sha256"]))
    for key in ("repository", "state_dir"):
        require(type(value[key]) is str and value[key].startswith("/") and "\x00" not in value[key])
    require(type(value["origin"]) is str and origin_url(value["origin"]) == value["origin"])
    smoke = value["smoke"]
    require(type(smoke) is dict and set(smoke) == {"token_file", "frame_path", "bytes", "sha256", "ca_file"})
    require(type(smoke["frame_path"]) is str and FRAME.fullmatch(smoke["frame_path"]))
    require(type(smoke["bytes"]) is int and 0 < smoke["bytes"] <= MAX_FRAME)
    require(type(smoke["sha256"]) is str and pre.HASH.fullmatch(smoke["sha256"]))
    require(type(smoke["token_file"]) is str and smoke["token_file"].startswith("/"))
    require(smoke["ca_file"] is None or type(smoke["ca_file"]) is str and smoke["ca_file"].startswith("/"))
    mail = value["mail"]
    require(type(mail) is dict and set(mail) == {"credentials", "recipient"})
    require(type(mail["credentials"]) is str and mail["credentials"].startswith("/"))
    address(mail["recipient"])
    return value


def compose_digest(repository):
    digest = hashlib.sha256()
    for name in (*pre.COMPOSE, ".env"):
        path = protected(repository / name, private=(name == ".env"))
        require(path.stat().st_size <= 1024 * 1024)
        raw = path.read_bytes()
        digest.update(name.encode() + b"\0" + len(raw).to_bytes(8, "big") + raw)
    return digest.hexdigest()


def event_valid(event):
    keys = {"version", "event_id", "request_sha256", "previous_sha", "target_sha",
            "previous_api_image", "target_api_image", "status", "stage", "lock_retained", "notification"}
    proofs = {"approval_sha256", "restore_sha256", "compatibility_sha256"}
    require(type(event) is dict and set(event) in (keys, keys | proofs))
    require(type(event["version"]) is int and event["version"] == 1)
    for key in ({"event_id", "request_sha256"} | (proofs & set(event))):
        require(type(event[key]) is str and pre.HASH.fullmatch(event[key]))
    for key in ("previous_sha", "target_sha"):
        require(type(event[key]) is str and pre.SHA.fullmatch(event[key]))
    for key in ("previous_api_image", "target_api_image"):
        require(type(event[key]) is str and pre.IMAGE.fullmatch(event[key]))
    require(event["status"] in ("STARTED", "ROLLING_BACK", "DEPLOYED", "ROLLED_BACK", "REJECTED", "NEEDS_ATTENTION"))
    require(event["stage"] in ("authorize", "observe", "apply", "smoke", "rollback", "rollback_smoke", "record", "complete"))
    require(type(event["lock_retained"]) is bool and event["notification"] in ("not_required", "pending", "accepted"))
    require(event["event_id"] == hashlib.sha256(
        f"{event['request_sha256']}:{event['status']}:{event['stage']}".encode("ascii")).hexdigest())
    return event


class HostAdapter:
    def __init__(self, policy_path):
        self.policy = policy_valid(decode(read_secure(policy_path)))
        require(self.policy["enabled"] is True)
        self.repository = protected(self.policy["repository"], private=True, directory=True)
        protected(self.repository / ".git", directory=True)
        self.state = protected(self.policy["state_dir"], private=True, directory=True)
        require(self.state != self.repository and self.state not in self.repository.parents
                and self.repository not in self.state.parents)
        for name in DIRS:
            protected(self.state / name, private=True, directory=True)
        self.plan = None

    def command(self, args, *, input_data=None, timeout=60, check=True, **kwargs):
        require(args[0] in ("git", "docker") and not kwargs)
        command = ["/usr/bin/" + args[0], *args[1:]]
        if args[0] == "git":
            command = [command[0], "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *command[1:]]
        result = subprocess.run(command, cwd=self.repository, env=ENV, input=input_data,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError("Fixed host command failed")
        return result

    @contextmanager
    def bound(self):
        # The isolated entrypoint is synchronous and handles one request. Bind
        # legacy read-only helpers without inheriting caller PATH/Docker settings.
        previous = ops.ROOT, ops.run
        ops.ROOT, ops.run = self.repository, self.command
        try:
            yield
        finally:
            ops.ROOT, ops.run = previous

    def evidence(self, digest, kind, plan):
        require(type(digest) is str and pre.HASH.fullmatch(digest))
        raw = read_secure(self.state / "evidence" / (digest + ".json"))
        require(hashlib.sha256(raw).hexdigest() == digest)
        proof = decode(raw)
        require(type(proof) is dict and set(proof) == {"schema", "kind", "request_sha256", "passed", "evidence_sha256"})
        require(type(proof["schema"]) is int and proof["schema"] == 1 and proof["kind"] == kind
                and proof["request_sha256"] == plan.request_sha256 and proof["passed"] is True)
        require(type(proof["evidence_sha256"]) is str and pre.HASH.fullmatch(proof["evidence_sha256"]))

    def authorize(self, plan):
        raw = read_secure(self.state / "approvals" / (plan.request_sha256 + ".json"))
        receipt = decode(raw)
        require(type(receipt) is dict and set(receipt) == {"schema", "request_sha256", "expires_at", "restore_sha256", "compatibility_sha256"})
        require(type(receipt["schema"]) is int and receipt["schema"] == 1
                and receipt["request_sha256"] == plan.request_sha256)
        now = int(time.time())
        require(type(receipt["expires_at"]) is int and now < receipt["expires_at"] <= now + 86400)
        self.evidence(receipt["restore_sha256"], "offsite-restore", plan)
        self.evidence(receipt["compatibility_sha256"], "app-compatibility", plan)
        require(compose_digest(self.repository) == self.policy["compose_sha256"])
        # This validates a protected token's format, never logs or copies it into
        # the request/evidence/journal. Actual authority is checked by HTTPS smoke.
        self.token()
        credentials(protected(self.policy["mail"]["credentials"], private=True))
        write_secure(self.state / "used" / (plan.request_sha256 + ".json"),
                     {"request_sha256": plan.request_sha256, "consumed_at": now}, exclusive=True)
        self.plan = plan
        return {"request_sha256": plan.request_sha256, "approval_sha256": hashlib.sha256(raw).hexdigest(),
                "restore_sha256": receipt["restore_sha256"], "compatibility_sha256": receipt["compatibility_sha256"], "consumed": True}

    def observe(self, plan):
        return pre.observe(plan.request())

    def record(self, event):
        event_valid(event)
        # event_id is the delivery deduplication key; repeated state transitions
        # must remain separate journal entries, including pending -> accepted.
        write_secure(self.state / "journal" / (event["request_sha256"] + ".jsonl"),
                     {"recorded_at": datetime.now(timezone.utc).isoformat(), "record_id": uuid.uuid4().hex, "event": event}, append=True)

    def apply_api(self, sha, image):
        require(self.plan is not None and (sha, image) in (
            (self.plan.previous_sha, self.plan.previous_api_image), (self.plan.target_sha, self.plan.target_api_image)))
        require(compose_digest(self.repository) == self.policy["compose_sha256"])
        self.command(["git", "checkout", "--detach", sha], timeout=45)
        require(compose_digest(self.repository) == self.policy["compose_sha256"])
        override = {"services": {"api": {"image": image, "labels": {"kin.deploy.release": sha}}}}
        args = ["docker", "compose", "--project-directory", str(self.repository)]
        for name in pre.COMPOSE:
            args += ["-f", str(self.repository / name)]
        args += ["-f", "-", "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "api"]
        # Nonzero exits and timeouts are deliberately not translated to settled.
        # The daemon can outlive its client, so the core must retain the lock.
        self.command(args, input_data=json.dumps(override).encode(), timeout=150)
        ops.reload_proxy()
        return {"settled": True, "succeeded": True}

    def token(self):
        value = decode(read_secure(self.policy["smoke"]["token_file"], 32768))
        require(type(value) is dict and set(value) == {"access_token", "subject"})
        require(type(value["access_token"]) is str and 0 < len(value["access_token"]) <= 16384
                and re.fullmatch(r"[A-Za-z0-9._~-]+", value["access_token"]))
        require(type(value["subject"]) is str and 0 < len(value["subject"]) <= 256)
        return value

    def fetch(self, path, *, token=None, limit=32768, accept="application/json"):
        ca = self.policy["smoke"]["ca_file"]
        if ca:
            protected(ca, private=True)
        context = ssl.create_default_context(cafile=ca)
        opener = build_opener(ProxyHandler({}), NoRedirect(), HTTPSHandler(context=context))
        headers = {"Accept": accept}
        if token:
            headers["Authorization"] = "Bearer " + token
        try:
            response = opener.open(Request(self.policy["origin"] + path, headers=headers), timeout=5)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read(limit + 1)
            require(len(raw) <= limit)
            return response.code, response.headers.get("Content-Type", ""), raw

    def smoke_once(self, sha, image):
        container = pre.inspect_one(["inspect", "kin-api"])
        pre.check_running_api(container, image)
        require(container["Config"]["Labels"].get("kin.deploy.release") == sha and pre.git("rev-parse", "HEAD") == sha)
        code, _, raw = self.fetch("/api/health")
        health = decode(raw)
        require(code == 200 and type(health) is dict and health.get("ok") is True and health.get("auth") is True)
        require(self.fetch("/api/me")[0] == 401)
        token = self.token()
        code, _, raw = self.fetch("/api/me", token=token["access_token"])
        require(code == 200 and decode(raw).get("sub") == token["subject"])
        config = self.policy["smoke"]
        code, kind, raw = self.fetch(config["frame_path"], token=token["access_token"],
                                    limit=config["bytes"] + 65536, accept='multipart/related; type="application/octet-stream"')
        require(code == 200 and len(kind) <= 1024)
        message = BytesParser(policy=email_policy).parsebytes(("Content-Type: " + kind + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii") + raw)
        require(message.is_multipart())
        parts = list(message.iter_parts())
        require(len(parts) == 1 and parts[0].get_content_type() == "application/octet-stream"
                and parts[0].get("Content-Transfer-Encoding", "binary").lower() in ("binary", "8bit"))
        payload = parts[0].get_payload(decode=True)
        require(len(payload) == config["bytes"] and hashlib.sha256(payload).hexdigest() == config["sha256"])
        return {"sha": sha, "image": image, "health": True, "auth": True, "image_read": True}

    def smoke(self, sha, image):
        deadline = time.monotonic() + 90
        while True:
            try:
                return self.smoke_once(sha, image)
            except Exception:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Host smoke failed") from None
                time.sleep(1)

    def send_failure(self, event):
        values = credentials(protected(self.policy["mail"]["credentials"], private=True))
        message = EmailMessage()
        sender = values["HANMAIL_USER"]
        message["From"] = address(sender if "@" in sender else sender + "@hanmail.net")
        message["To"] = address(self.policy["mail"]["recipient"])
        message["Subject"] = "[KIN PACS] Deployment failure"
        message["Message-ID"] = "<deploy-" + event["event_id"] + "@koreaimagingnetwork.com>"
        message.set_content(json.dumps(event, ensure_ascii=True, sort_keys=True))
        with smtplib.SMTP_SSL("smtp.daum.net", 465, timeout=30, context=ssl.create_default_context()) as smtp:
            smtp.login(values["HANMAIL_USER"], values["HANMAIL_APP_PW"])
            require(not smtp.send_message(message))

    def deliver(self, path):
        state = decode(read_secure(path))
        require(type(state) is dict and set(state) == {"event", "accepted"} and type(state["accepted"]) is bool)
        event_valid(state["event"])
        require(state["event"]["notification"] == "pending")
        require(path.name == state["event"]["event_id"] + ".json")
        if state["accepted"]:
            return True
        now = int(time.time())
        budget_path = self.state / "mail-budget.json"
        budget = decode(read_secure(budget_path))
        require(type(budget) is dict and set(budget) == {"day", "attempts", "last_attempt"})
        require(all(type(budget[key]) is int for key in budget) and 0 <= budget["attempts"] <= 24)
        require(now >= budget["last_attempt"] and now // 86400 >= budget["day"])
        if now // 86400 > budget["day"]:
            budget["day"], budget["attempts"] = now // 86400, 0
        require(budget["attempts"] < 24)
        budget["attempts"] += 1
        budget["last_attempt"] = now
        write_secure(budget_path, budget)
        self.send_failure(state["event"])
        state["accepted"] = True
        write_secure(path, state)
        return True

    def notify_failure(self, event):
        event_valid(event)
        path = self.state / "outbox" / (event["event_id"] + ".json")
        if not path.exists():
            write_secure(path, {"event": event, "accepted": False}, exclusive=True)
        else:
            require(decode(read_secure(path))["event"] == event)
        return self.deliver(path)

    def execute(self, raw):
        digest = hashlib.sha256(raw).hexdigest()
        plan = runner.make_plan(raw, digest)
        with self.bound():
            try:
                return runner.execute(raw, digest, self)
            except FileExistsError:
                write_secure(self.state / "refusals" / (uuid.uuid4().hex + ".json"),
                             {"request_sha256": plan.request_sha256, "code": "lock_busy", "at": int(time.time())}, exclusive=True)
                return {"status": "REJECTED", "stage": "lock", "request_sha256": digest}

    def drain(self):
        count = 0
        with self.bound(), ops.lock():
            for path in sorted((self.state / "outbox").glob("*.json")):
                require(pre.HASH.fullmatch(path.stem))
                if not decode(read_secure(path))["accepted"]:
                    self.deliver(path)
                    count += 1
                if count == 24:
                    break
        return {"notifications_accepted": count}
