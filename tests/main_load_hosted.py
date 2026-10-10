"""D906 / REQ-S9-U0a-PRE-ORDER -> RISK-LOAD-REGRESSION -> TEST-PRE-LOAD-BUDGET.

The real, unchanged proxy and Orthanc ServeFolders serve both byte-pinned sides.
Only API answers are synthetic. No browser routing or product instrumentation is
used. This fixture requires run-tests.py's live lease, even though it has no real
accounts, DICOM, database, host credentials, or persistent Docker volumes.
"""
import copy
import hashlib
import json
import shutil
import socket
import ssl
import subprocess
import threading
import time
import uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

import live_test_gate as gate
from playwright.sync_api import TimeoutError as BrowserTimeoutError

ROOT = Path(__file__).resolve().parents[1]
# Shared CI runners can spend tens of seconds starting the proxy/upstreams.
# These are failure deadlines, not performance budgets; no sample starts here.
STACK_READINESS_TIMEOUT_S = 180
FIRST_AUTH_TIMEOUT_S = 90  # Allow CI scheduling/script compilation; retain every measured millisecond.
WARMUP_ATTEMPTS = 3
NETWORK_SETTLE_WINDOW_S = 3
NETWORK_SETTLE_TIMEOUT_S = 30
# Both timing observations (including usable) are frozen before this collection
# deadline. Allow three 30s app polls on CI; this cannot change a timing metric.
STARTUP_COLLECTION_TIMEOUT_S = 90
MAX_REPLACED_PAIRS_PER_PHASE = 2
NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED"
DISCOVERY_PATH = "/auth/realms/kin/.well-known/openid-configuration"
READINESS_CHECKS = {"api": "/api/health", "auth_realm": DISCOVERY_PATH,
                    "orthanc": "/worklist/hpacs-lite/main.html"}


class WaitTimeout(AssertionError):
    pass


class VisitFailure(AssertionError):
    def __init__(self, error, result):
        super().__init__(str(error))
        self.result = result


def network_changed(result):
    """Predeclared invalidity: an unanswered request plus network-change evidence.

    A console-only notification without an unanswered/aborted waterfall row is
    insufficient. CDP may omit loadingFailed on the runner, hence the fallback.
    Timing values never participate in this decision.
    """
    console = any(NETWORK_CHANGED in error for error in result.get("console_errors", []))
    return any(row.get("status") is None and (
        row.get("failed", {}).get("errorText") == NETWORK_CHANGED or
        (console and "end" not in row)) for row in result.get("waterfall", []))


def incomplete_requests(result):
    return [row for row in result.get("waterfall", []) if "end" not in row and "failed" not in row]


def sampling_policy():
    return {"warmup_attempts": WARMUP_ATTEMPTS,
            "settle_window_s": NETWORK_SETTLE_WINDOW_S,
            "settle_timeout_s": NETWORK_SETTLE_TIMEOUT_S,
            "collection_deadline_s": STARTUP_COLLECTION_TIMEOUT_S,
            "max_replaced_pairs_per_phase": MAX_REPLACED_PAIRS_PER_PHASE,
            "required_valid_pairs": 5,
            "invalidity": "status None plus CDP ERR_NETWORK_CHANGED, or console ERR_NETWORK_CHANGED plus a row without status/end; dependent warm invalid after invalid cold",
            "warmup_retry": "wait failure or network change; otherwise successful visits with pending (not completed/failed) requests; never retry unrelated assertions",
            "replacement": "after five planned pairs, at most two additional rounds; accept only deficient phases chosen before each round; timing never selects pairs; alternate order by physical round without rebalancing accepted pairs",
            "overall_bound": "existing run-tests.py 600s deadline still applies to all phases and attempts",
            "docker_operations": "prepare build/up/ps/inspect/exec precede settle; activate only copies owned files; no Docker operation between visits; down in close after all visits"}


def settle_network(browser, origin, record_path, clock=time.monotonic):
    """Disposable health-page traffic; no app boot, auth, cache or sample survives."""
    started = clock()
    deadline = started + NETWORK_SETTLE_TIMEOUT_S
    stable_since = started
    record = {"ready": False, "window_s": NETWORK_SETTLE_WINDOW_S,
              "timeout_s": NETWORK_SETTLE_TIMEOUT_S, "attempts": [], "events": []}
    context = None

    def disturbed(kind, detail):
        nonlocal stable_since
        stable_since = clock()
        record["events"].append({"elapsed_s": clock() - started, "kind": kind, "detail": detail})

    try:
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()
        page.on("requestfailed", lambda request: disturbed("requestfailed", str(request.failure)))
        page.on("console", lambda message: disturbed("console", message.text)
                if NETWORK_CHANGED in message.text else None)
        stable_since = clock()  # Context creation was not browser observation time.
        while clock() < deadline:
            attempt = {"elapsed_s": clock() - started}
            try:
                response = page.goto(origin + "/api/health", wait_until="load",
                                     timeout=max(1, min(2000, (deadline - clock()) * 1000)))
                attempt["status"] = response.status if response else None
                if attempt["status"] != 200:
                    disturbed("health", str(attempt["status"]))
            except Exception as error:
                attempt["error"] = str(error)
                disturbed("navigation", str(error))
            record["attempts"].append(attempt)
            if attempt.get("status") == 200 and clock() - stable_since >= NETWORK_SETTLE_WINDOW_S and clock() < deadline:
                record["ready"] = True
                return record
            page.wait_for_timeout(max(0, min(250, (deadline - clock()) * 1000)))
        raise AssertionError("hosted timeout: network settle")
    finally:
        record["duration_seconds"] = clock() - started
        save(record_path, record)
        if context is not None:
            context.close()


def new_context(browser):
    return browser.new_context(viewport={"width": 1400, "height": 900},
        locale="ko-KR", timezone_id="Asia/Seoul", ignore_https_errors=True)


def run_warmups(stack, browser, clock_start, patient, result, visit_fn=None):
    visit_fn = visit_fn or visit
    result["warmups"] = []
    for side in ("baseline", "candidate"):
        stack.activate(side)
        for attempt in range(1, WARMUP_ATTEMPTS + 1):
            context = new_context(browser)
            metadata = {"mode": "warmup", "visit": -len(result["warmups"]) - 1,
                        "attempt": attempt, "note": "non-sample; excluded by design"}
            try:
                try:
                    sample = visit_fn(stack, context, clock_start, patient, metadata)
                except VisitFailure as error:
                    sample = error.result
                    if not (sample.get("wait_failed") or network_changed(sample)):
                        result["warmups"].append(sample)
                        save(stack.root.parent / "samples.json", result)
                        raise
                result["warmups"].append(sample)
                save(stack.root.parent / "samples.json", result)
                if sample["valid"] and not network_changed(sample) and not incomplete_requests(sample):
                    break
            finally:
                context.close()
        else:
            raise AssertionError(f"hosted warmup exhausted: {side} ({WARMUP_ATTEMPTS} attempts): "
                                 + sample.get("failure", "network change or pending requests"))


def collect_pairs(stack, browser, clock_start, patient, result, visit_fn=None):
    """Keep physical rounds, including failures and predetermined diagnostic peers."""
    visit_fn = visit_fn or visit
    result["pair_attempts"] = []
    result["replacements"] = {"cold": 0, "warm": 0}
    for index in range(5 + MAX_REPLACED_PAIRS_PER_PHASE):
        phases = [mode for mode in ("cold", "warm") if result["valid_pairs"][mode] < 5]
        if not phases:
            break
        if index >= 5:
            for mode in phases:
                result["replacements"][mode] += 1
        order = ("baseline", "candidate") if index % 2 == 0 else ("candidate", "baseline")
        pairs = {"cold": {}, "warm": {}}
        attempt = {"pair": index + 1, "eligible_phases": phases, "pairs": pairs, "accepted": []}
        result["pair_attempts"].append(attempt)
        try:
            for side in order:
                stack.activate(side)
                context = new_context(browser)
                try:
                    for mode in ("cold", "warm"):
                        metadata = {"pair": index + 1, "order": list(order), "context": f"pair-{index + 1}-{side}",
                                    "mode": mode, "visit": len(result["visits"]) + 1,
                                    "eligible_phase": mode in phases}
                        try:
                            sample = visit_fn(stack, context, clock_start, patient, metadata)
                        except VisitFailure as error:
                            sample = error.result
                            result["visits"].append(sample)
                            pairs[mode][side] = sample
                            if not network_changed(sample):
                                raise
                        else:
                            result["visits"].append(sample)
                            pairs[mode][side] = sample
                finally:
                    context.close()
            cold_invalid = any(network_changed(sample) for sample in pairs["cold"].values())
            for mode in phases:
                pair = pairs[mode]
                invalid = any(network_changed(sample) for sample in pair.values()) or (mode == "warm" and cold_invalid)
                if invalid:
                    attempt.setdefault("invalid", {})[mode] = "network change" if mode == "cold" or not cold_invalid else "network change in preceding cold visit"
                    continue
                assert all(sample["valid"] for sample in pair.values()), "invalid visit without network-change evidence"
                result[mode].append(pair)
                result["valid_pairs"][mode] += 1
                attempt["accepted"].append(mode)
        finally:
            save(stack.root.parent / "samples.json", result)


def probe_endpoint(origin, name, path, timeout_s, document_sha256):
    """Check the actual HTTPS proxy routes, including the served Orthanc bytes."""
    try:
        with urlopen(origin + path, context=ssl._create_unverified_context(), timeout=timeout_s) as response:
            body = response.read()
            assert response.status == 200, f"HTTP {response.status}"
            if name in ("api", "auth_realm"):
                payload = json.loads(body)
                assert isinstance(payload, dict), "expected JSON object"
            if name == "api":
                assert payload.get("ok") is True, "API not healthy"
            elif name == "auth_realm":
                assert payload.get("issuer") == origin + "/auth/realms/kin", "wrong OIDC issuer"
            else:
                assert hashlib.sha256(body).hexdigest() == document_sha256, "Orthanc document hash mismatch"
            return {"ready": True, "status": response.status, "headers": dict(response.headers)}
    except (OSError, ValueError, AssertionError) as error:
        return {"ready": False, "error": str(error)}


def poll_readiness(origin, document_sha256, record_path, timeout_s=STACK_READINESS_TIMEOUT_S,
                   probe=probe_endpoint, clock=time.monotonic, sleep=time.sleep):
    started = clock()
    deadline = started + timeout_s
    record = {"origin": origin, "timeout_s": timeout_s, "checks": READINESS_CHECKS,
              "attempts": [], "ready": False,
              "auth_backend": "synthetic discovery via existing keycloak alias; no real Keycloak"}
    try:
        while clock() < deadline:
            checks = {}
            for name, path in READINESS_CHECKS.items():
                remaining = deadline - clock()
                if remaining <= 0:
                    break
                checks[name] = probe(origin, name, path, min(2, remaining), document_sha256)
            record["attempts"].append({"elapsed_s": clock() - started, "checks": checks})
            if len(checks) == len(READINESS_CHECKS) and all(c["ready"] for c in checks.values()) and clock() <= deadline:
                record["ready"] = True
                return record
            sleep(max(0, min(.5, deadline - clock())))
        raise AssertionError("hosted timeout: stack readiness")
    finally:
        record["duration_seconds"] = clock() - started
        save(record_path, record)


def record_auth_timeout(stack, page, waterfall, navigation, auth, result, record_path):
    """Persist browser state before probing health; a failed probe cannot erase it."""
    diagnostic = {"timeout_s": FIRST_AUTH_TIMEOUT_S, "url": page.url,
                  "navigation": list(navigation), "auth_observed": bool(auth),
                  "server_me_received": stack.me_received.is_set(),
                  "pending_requests": [dict(row) for row in waterfall.rows.values()
                                       if "end" not in row and "failed" not in row],
                  "stack_health": {}}
    result["first_auth_timeout"] = diagnostic
    save(record_path, result)
    for name, path in READINESS_CHECKS.items():
        diagnostic["stack_health"][name] = probe_endpoint(
            stack.origin, name, path, 2, stack.versions[stack.side]["main.html"])
        save(record_path, result)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def assert_script_requests(baseline, candidate, *, landing=False):
    """Only the approved bundle request may differ; retain names and occurrences."""
    expected = Counter(map(tuple, baseline))
    expected[("GET", "/worklist/hpacs-lite/main-split.bundle.js", "")] += 1
    if landing:
        expected[("GET", "/worklist/hpacs-lite/worklist-folder-tree.js", "")] += 1
    actual = Counter(map(tuple, candidate))
    assert actual == expected, f"different script requests: expected={expected!r}, actual={actual!r}"


def assert_account_requests(baseline, candidate):
    """W2 adds exactly one personal and one shared search read at startup."""
    expected = Counter(map(tuple, baseline))
    for path in ('/api/filter-folders', '/api/shared-filters'):
        expected[('GET', path, '')] += 1
    assert Counter(map(tuple, candidate)) == expected, 'different account startup requests'


class HostedStack:
    def __init__(self, directory, site_factory, baseline_sha, candidate_dir):
        self.root = Path(directory).resolve()
        self.root.mkdir(parents=True, exist_ok=False)
        self.site_factory = site_factory
        self.baseline_sha = baseline_sha
        self.candidate_dir = Path(candidate_dir)
        self.project = "kin-load-" + uuid.uuid4().hex[:12]
        self.commands, self.requests, self.violations = [], [], []
        self.me_received, self.me_release = threading.Event(), threading.Event()
        self.server = self.thread = None
        self.started = False
        self.side = None
        self.reset()

    def reset(self):
        self.site = self.site_factory()
        self.requests = []
        # In-flight handlers retain their own visit's state after a failed page
        # closes; a retry must neither clear their release nor inherit errors.
        self.me_received, self.me_release = threading.Event(), threading.Event()
        self.visit_violations = []

    def command(self, *args, check=True):
        started = time.perf_counter()
        result = subprocess.run(list(args), cwd=ROOT, capture_output=True, timeout=300)
        index = len(self.commands)
        (self.root / f"command-{index:02d}.stdout").write_bytes(result.stdout)
        (self.root / f"command-{index:02d}.stderr").write_bytes(result.stderr)
        self.commands.append({"argv": list(args), "exit": result.returncode,
                              "duration_seconds": time.perf_counter() - started,
                              "stdout": f"command-{index:02d}.stdout", "stderr": f"command-{index:02d}.stderr"})
        save(self.root / "commands.json", self.commands)
        if check and result.returncode:
            raise AssertionError(f"hosted command {index} failed ({result.returncode}); see {self.root}")
        return result

    def compose(self, *args, check=True):
        return self.command("docker", "compose", "--project-name", self.project, "--file",
                            str(self.root / "compose.json"), *args, check=check)

    def prepare(self):
        gate.require_live_run()
        versions = {}
        for side in ("baseline", "candidate"):
            directory = self.root / side / "hpacs-lite"
            directory.mkdir(parents=True)
            if side == "baseline":
                names = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", self.baseline_sha,
                                                 "--", "worklist-v0/hpacs-lite"], cwd=ROOT, text=True).splitlines()
                for name in names:
                    target = directory / Path(name).relative_to("worklist-v0/hpacs-lite")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(subprocess.check_output(["git", "cat-file", "blob", f"{self.baseline_sha}:{name}"], cwd=ROOT))
            else:
                for source in self.candidate_dir.rglob("*"):
                    if source.is_file():
                        target = directory / source.relative_to(self.candidate_dir)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(source.read_bytes())
            versions[side] = {p.relative_to(directory).as_posix(): digest(p) for p in directory.rglob("*") if p.is_file()}
        save(self.root / "sources.json", {"baseline_sha": self.baseline_sha,
             "candidate_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
             "versions": versions})
        self.versions = versions
        self.active = self.root / "active" / "hpacs-lite"
        self.active.mkdir(parents=True)
        self.activate("baseline")
        # The same product build context supplies nginx, entrypoint, TLS and includes.
        shutil.copytree(ROOT / "proxy", self.root / "proxy")
        config = json.loads((ROOT / "config/orthanc.json").read_text(encoding="utf-8"))
        config["Name"] = self.project
        config["RegisteredUsers"] = {"SYN-LOAD": uuid.uuid4().hex}
        config["DicomServerEnabled"] = False
        save(self.root / "orthanc.json", config)
        shutil.copyfile(ROOT / "config/ohif.js", self.root / "ohif.js")
        self.start_api()
        # The relay changes no browser/static path. It puts the existing Python
        # API fixture behind nginx's real api:3000 upstream, on the same origin.
        relay = ("events {}\nhttp { server { listen 3000; listen 8080; location / { "
                 f"proxy_pass http://host.docker.internal:{self.server.server_port}; "
                 "proxy_http_version 1.1; } } }\n")
        (self.root / "api-nginx.conf").write_text(relay, encoding="utf-8", newline="\n")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.origin = f"https://localhost:{self.port}"
        self.url = self.origin + "/worklist/hpacs-lite/main.html"
        mount = lambda name, target: {"type": "bind", "source": str(self.root / name), "target": target, "read_only": True}
        compose = {"services": {
            "proxy": {"build": {"context": str(self.root / "proxy")}, "image": self.project + "-proxy",
                      "environment": {"PUBLIC_PORT": str(self.port), "ORTHANC_USER": "SYN-LOAD",
                          "ORTHANC_PASS": config["RegisteredUsers"]["SYN-LOAD"],
                          "NGINX_ENVSUBST_FILTER": "^(PUBLIC_PORT|PUBLIC_PORT_SUFFIX|SERVER_NAME|TLS_CERTIFICATE|TLS_CERTIFICATE_KEY)"},
                      "ports": [f"127.0.0.1:{self.port}:443"], "tmpfs": ["/etc/nginx/certs"],
                      "depends_on": ["orthanc", "api"]},
            "orthanc": {"image": "orthancteam/orthanc:24.12.0", "environment": {"OHIF_PLUGIN_ENABLED": "true"},
                        "volumes": [mount("orthanc.json", "/etc/orthanc/orthanc.json"), mount("ohif.js", "/etc/orthanc/ohif.js"),
                                    mount("active", "/worklist")], "tmpfs": ["/var/lib/orthanc/db"]},
            "api": {"image": self.project + "-proxy", "entrypoint": ["nginx", "-g", "daemon off;", "-c", "/fixture.conf"],
                    "volumes": [mount("api-nginx.conf", "/fixture.conf")],
                    "extra_hosts": ["host.docker.internal:host-gateway"],
                    "networks": {"default": {"aliases": ["keycloak"]}}}},
            "networks": {"default": {"name": self.project}}}
        save(self.root / "compose.json", compose)
        files = [p for p in (self.root / "proxy").rglob("*") if p.is_file()]
        files += [self.root / n for n in ("orthanc.json", "ohif.js", "api-nginx.conf", "compose.json")]
        save(self.root / "config.json", {"hashes": {str(p.relative_to(self.root)): digest(p) for p in files},
             "product_lines": {str(p.relative_to(ROOT)): [f"{i}: {line}" for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)]
                               for p in (ROOT / "proxy/nginx.conf.template", ROOT / "proxy/Dockerfile", ROOT / "config/orthanc.json")},
             "cache_note": "max-age=3600 is /kin-brand/ only; /worklist/ inherits real Orthanc headers; no cache/gzip override",
             "isolation": "unique network; only copied public source/config binds; DB/certs tmpfs; new synthetic Orthanc credential; no operational mounts/accounts"})
        self.compose("build", "proxy")
        self.started = True
        self.compose("up", "-d", "--no-build")
        self.compose("ps", "--format", "json")
        ids = self.compose("ps", "-q").stdout.decode().split()
        inspected = json.loads(self.command("docker", "inspect", *ids).stdout)
        for container in inspected:
            for mounted in container["Mounts"]:
                if mounted["Type"] == "bind":
                    # Docker Desktop translates C:/ paths, so compare the unique run-directory suffix too.
                    assert self.root.name in mounted["Source"], mounted
                    assert not mounted["RW"], mounted
                else:
                    assert mounted["Type"] == "tmpfs", mounted
            assert all(name == self.project for name in container["NetworkSettings"]["Networks"])
        self.command("docker", "image", "inspect", *sorted({c["Image"] for c in inspected}))
        self.readiness = poll_readiness(self.origin, self.versions["baseline"]["main.html"],
                                        self.root / "readiness.json")
        save(self.root / "readiness-headers.json", self.readiness["attempts"][-1]["checks"]["orthanc"]["headers"])
        self.compose("exec", "-T", "proxy", "nginx", "-T")
        template = self.compose("exec", "-T", "proxy", "cat", "/etc/nginx/templates/default.conf.template").stdout
        assert hashlib.sha256(template).hexdigest() == digest(ROOT / "proxy/nginx.conf.template"), "proxy template mismatch"
        self.compose("exec", "-T", "orthanc", "Orthanc", "--version")

    def activate(self, side):
        # No browser/context survives a version switch. Do not mutate the repo.
        for old in self.active.rglob("*"):
            if old.is_file():
                old.unlink()
        shutil.copytree(self.root / side / "hpacs-lite", self.active, dirs_exist_ok=True)
        assert {p.relative_to(self.active).as_posix(): digest(p) for p in self.active.rglob("*") if p.is_file()} == self.versions[side]
        self.side = side

    def start_api(self):
        stack = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def fulfill(self, status=200, body=None, json=None, headers=None, content_type=None):
                if json is not None:
                    import json as codec
                    body = codec.dumps(json, ensure_ascii=False).encode("utf-8")
                    content_type = "application/json; charset=utf-8"
                if isinstance(body, str):
                    body = body.encode("utf-8")
                body = body or b""
                self.send_response(status)
                self.send_header("Content-Type", content_type or "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                site, requests = stack.site, stack.requests
                me_received, me_release = stack.me_received, stack.me_release
                violations = stack.visit_violations

                def violation(message):
                    violations.append(message)
                    stack.violations.append(message)  # Full history survives in cleanup.json.

                stamp = time.perf_counter()
                url = urlparse(self.path)
                requests.append({"method": "GET", "path": url.path, "query": url.query, "received": stamp})
                if url.path == "/api/health":
                    return self.fulfill(json={"ok": True, "synthetic": True})
                if url.path == DISCOVERY_PATH:
                    # This fixture already aliases keycloak to the API relay.
                    # Probe that proxy route without introducing real accounts.
                    issuer = stack.origin + "/auth/realms/kin"
                    return self.fulfill(json={"issuer": issuer, "synthetic": True,
                        "authorization_endpoint": issuer + "/protocol/openid-connect/auth",
                        "token_endpoint": issuer + "/protocol/openid-connect/token",
                        "jwks_uri": issuer + "/protocol/openid-connect/certs"})
                if url.path == "/api/me":
                    me_received.set()
                    if not me_release.wait(30):
                        violation("auth release timeout")
                        return self.fulfill(status=504, body="synthetic auth release timeout")
                request = SimpleNamespace(method="GET", url="https://syn.test" + self.path,
                    headers={k.lower(): v for k, v in self.headers.items()}, post_data=None,
                    frame=SimpleNamespace(page=SimpleNamespace(url="https://syn.test/worklist/hpacs-lite/main.html")))
                try:
                    # Complete the successful synthetic startup contract. The
                    # earlier fixture's 404s/failed auth subrequest are retained
                    # in p3b evidence; neither side receives those errors here.
                    if url.path in ("/api/authz/dicom", "/api/study-access", "/api/reading-appearance",
                                    "/api/reading-preferences", "/api/workspace-layout", "/api/critical-results"):
                        account, refused = site.authenticate(request, strict=True)
                        if refused:
                            return site.refuse(self, *refused)
                        if url.path == "/api/authz/dicom":
                            return self.fulfill(status=204)
                        if url.path == "/api/study-access":
                            from auth_logout_dom_test import INSTITUTION
                            return self.fulfill(json={"owner": [INSTITUTION, account["sub"]], "revision": 0,
                                "restricted": False, "windowOpen": True, "denied": False, "needsInstitutionReview": False,
                                "startsAt": None, "endsAt": None})
                        if url.path == "/api/critical-results":
                            return self.fulfill(json={"view": parse_qs(url.query).get("view", ["received"])[0],
                                "items": [], "nextCursor": None, "pending": 0})
                        from auth_logout_dom_test import owner_of
                        field = {"/api/reading-appearance": "sizes", "/api/reading-preferences": "autoNote",
                                 "/api/workspace-layout": "layout"}[url.path]
                        return self.fulfill(json={"owner": owner_of(account), "revision": 0, field: None})
                    if url.path.startswith("/api/"):
                        site.api(self, request, "GET", url.path, url.query)
                    else:
                        self.fulfill(status=404, body="synthetic endpoint absent")
                except Exception as error:
                    violation(repr(error))
                    self.fulfill(status=500, body="synthetic fixture error")

        self.server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.me_release.set()
        if self.started:
            self.compose("logs", "--no-color", check=False)
            result = self.compose("down", "--volumes", "--remove-orphans", check=False)
            assert result.returncode == 0, "owned hosted fixture cleanup failed"
            remaining = self.command("docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={self.project}", "-q")
            assert not remaining.stdout.strip(), "owned hosted containers remain"
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=5)
        save(self.root / "cleanup.json", {"project": self.project, "containers_removed": self.started,
             "persistent_volumes": [], "violations": self.violations})


class Waterfall:
    """Read-only CDP Network observation; never sets cache or request policies."""
    def __init__(self, context, page):
        self.rows = {}
        self.session = context.new_cdp_session(page)
        self.session.send("Network.enable")
        self.session.on("Network.requestWillBeSent", self.request)
        self.session.on("Network.responseReceived", self.response)
        self.session.on("Network.requestServedFromCache", lambda e: self.row(e)["cache"].update(event=True))
        self.session.on("Network.loadingFinished", self.finished)
        self.session.on("Network.loadingFailed", lambda e: self.row(e).update(failed=e))

    def row(self, event):
        return self.rows.setdefault(event["requestId"], {"id": event["requestId"], "cache": {}})

    def request(self, event):
        self.row(event).update(url=event["request"]["url"], method=event["request"]["method"],
                              type=event.get("type"), start=event["timestamp"], wall_time=event.get("wallTime"))

    def response(self, event):
        response = event["response"]
        self.row(event).update(response_at=event["timestamp"], status=response["status"], protocol=response["protocol"],
            headers=response["headers"], timing=response.get("timing"), remote_ip=response.get("remoteIPAddress"),
            cache={**self.row(event)["cache"], "disk": response.get("fromDiskCache", False),
                   "service_worker": response.get("fromServiceWorker", False), "prefetch": response.get("fromPrefetchCache", False)})

    def finished(self, event):
        self.row(event).update(end=event["timestamp"], transfer_size=event["encodedDataLength"])

    def performance(self):
        # An isolated world gives native timing values independently of any
        # page library. Host monotonic remains the predefined budget clock.
        frame = self.session.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
        world = self.session.send("Page.createIsolatedWorld", {"frameId": frame, "worldName": "kin-hosted-native"})
        return self.session.send("Runtime.evaluate", {"contextId": world["executionContextId"],
            "expression": "({now:performance.now(),timeOrigin:performance.timeOrigin,resources:performance.getEntriesByType('resource').map(e=>e.toJSON()), navigation:performance.getEntriesByType('navigation').map(e=>e.toJSON())})",
            "returnByValue": True})["result"]["value"]

    def close(self):
        self.session.detach()


def wait(page, predicate, label, timeout_s=30, on_timeout=None):
    deadline = time.perf_counter() + timeout_s
    while not predicate():
        if time.perf_counter() >= deadline:
            if on_timeout:
                on_timeout()
            raise WaitTimeout("hosted timeout: " + label)
        page.wait_for_timeout(10)


def collect_startup_requests(page, waterfall, result, record_path):
    def inbox_complete():
        return any(urlparse(row.get("url", "")).path == "/api/critical-results"
                   and parse_qs(urlparse(row["url"]).query).get("view") == ["received"]
                   and parse_qs(urlparse(row["url"]).query).get("state") == ["pending"]
                   and row.get("status") == 200 and "end" in row
                   for row in waterfall.rows.values())

    def diagnostic():
        rows = copy.deepcopy(list(waterfall.rows.values()))
        result["startup_collection_timeout"] = {
            "timeout_s": STARTUP_COLLECTION_TIMEOUT_S,
            "pending_requests": [row for row in rows if "end" not in row and "failed" not in row],
            "console_errors": list(result["console_errors"]), "waterfall": rows}
        save(record_path, result)

    wait(page, inbox_complete, "first received-inbox response", timeout_s=STARTUP_COLLECTION_TIMEOUT_S,
         on_timeout=diagnostic)


def visit(stack, browser_context, clock_start, patient, metadata):
    stack.reset()
    page = browser_context.new_page()  # a new Document; never reload/history/BFCache
    # Hosted timing is uninstrumented: installing Playwright's clock also
    # injects scripts into sandboxed print iframes and replaces Performance.
    # Both versions use the native clock; host monotonic remains the verdict.
    waterfall = Waterfall(browser_context, page)
    errors, console_errors, auth, responses, static_responses = [], [], [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("request", lambda request: auth.append(time.perf_counter()) if urlparse(request.url).path == "/api/me" else None)
    page.on("response", lambda response: responses.append(time.perf_counter()) if urlparse(response.url).path == "/api/me" else None)
    page.on("response", lambda response: static_responses.append(response) if "/worklist/" in urlparse(response.url).path else None)
    result = {**metadata, "side": stack.side, "url": stack.url, "valid": False,
              "page_errors": errors, "console_errors": console_errors}
    record_path = stack.root.parent / f"visit-{metadata['visit']:02d}.json"
    navigation = []
    page.on("framenavigated", lambda frame: navigation.append({"url": frame.url, "at": time.perf_counter()})
            if frame == page.main_frame else None)
    try:
        started = time.perf_counter()
        page.goto(stack.url, wait_until="commit")
        wait(page, lambda: bool(auth) and stack.me_received.is_set(), "first auth",
             timeout_s=FIRST_AUTH_TIMEOUT_S,
             on_timeout=lambda: record_auth_timeout(stack, page, waterfall, navigation, auth, result, record_path))
        answered = time.perf_counter()
        stack.me_release.set()  # same observation point as the PRE route fixture
        wait(page, lambda: patient in page.locator("#rows").inner_text(), "usable list")
        page.locator("#quick").fill(patient)
        wait(page, lambda: page.locator('#rows tr[data-uid]').count() > 0, "usable search")
        usable = time.perf_counter()
        performance = waterfall.performance()
        result.update(navigation_to_auth_ms=(auth[0] - started) * 1000,
                      auth_to_usable_ms=(usable - answered) * 1000,
                      raw={"navigation": started, "first_auth_request": auth[0],
                           "auth_release": answered, "usable_list": usable})
        # Freeze both timing observations before collecting the complete startup
        # request set. Body hashing can otherwise cross the delayed inbox poll
        # on only one side. Observe its real response on both pages; do not drop
        # requests or move the usable boundary to make the budget pass.
        collect_startup_requests(page, waterfall, result, record_path)
        collected = time.perf_counter()
        wire = []
        for response in static_responses:
            name = urlparse(response.url).path.split("/worklist/hpacs-lite/", 1)[-1]
            payload = response.body()
            actual_hash = hashlib.sha256(payload).hexdigest()
            assert actual_hash == stack.versions[stack.side][name], "hosted body hash differs: " + name
            headers = response.all_headers()
            wire.append({"name": name, "sha256": actual_hash, "bytes": len(payload), "headers": headers})
            if name.endswith(".js"):
                assert headers.get("content-type", "").split(";", 1)[0] in ("application/javascript", "text/javascript"), "ServeFolders JavaScript MIME: " + str(headers)
        auth_resource = next(r for r in performance["resources"] if urlparse(r["name"]).path == "/api/me")
        result.update(navigation_to_auth_ms=(auth[0] - started) * 1000, auth_to_usable_ms=(usable - answered) * 1000,
            raw={"navigation": started, "first_auth_request": auth[0], "auth_release": answered,
                 "auth_response_observed": responses, "usable_list": usable,
                 "startup_request_collection": collected},
            request_collection="after first received-inbox response; timing observations frozen beforehand",
            page_errors=errors, console_errors=console_errors,
            wire=wire, native_cdp={"navigation_to_auth_ms": auth_resource["startTime"],
                "auth_to_usable_ms": performance["now"] - auth_resource["responseEnd"],
                "usable_observation_ms": performance["now"], "auth_resource": auth_resource,
                "note": "native responseEnd differs from retained host auth-release observation; diagnostic only"},
            resources=performance["resources"], navigation=performance["navigation"],
            non_script_requests=[(r["method"], r["path"], r["query"]) for r in stack.requests],
            server_requests=list(stack.requests), inputs=stack.versions[stack.side])
        result["script_requests"] = [(r["method"], urlparse(r["url"]).path, urlparse(r["url"]).query)
                                     for r in waterfall.rows.values() if r.get("type") == "Script"]
        assert not errors, errors
        assert not console_errors, console_errors
        assert not stack.visit_violations, stack.visit_violations
        assert result["navigation"][0]["type"] == "navigate", "warm visit must be a new document"
        # Real wire checks, not inferred from an https URL or the template alone.
        static = [r for r in waterfall.rows.values() if "/worklist/" in r.get("url", "") and "status" in r]
        assert static and all(r["protocol"] == "h2" for r in static), "static protocol mismatch"
        scripts = [r for r in static if urlparse(r["url"]).path.endswith(".js")]
        assert len(scripts) == (58 if stack.side == "candidate" else 56), "execution request count"
        assert all(urlparse(r["url"]).netloc == urlparse(stack.origin).netloc for r in scripts), "script-src 'self' compatibility"
        document = next(r for r in wire if r["name"] == "main.html")
        result["csp"] = {"header": document["headers"].get("content-security-policy"),
                         "all_scripts_same_origin": True,
                         "note": "Actual response header retained; absent inheritance is not claimed as enforced CSP"}
        if stack.side == "candidate":
            assert sum(urlparse(r["url"]).path.endswith("/main-split.bundle.js") for r in scripts) == 1
        assert all(r["status"] in (200, 304) for r in static), "static serving failure"
        assert not any(r["cache"].get("service_worker") for r in static), "unexpected service worker"
        if metadata["mode"] == "cold":
            assert not any(any(r["cache"].values()) or r.get("transfer_size") == 0 for r in static), "cold cache was not empty"
        result["valid"] = True
        return result
    except Exception as error:
        result.update(failure=f"{type(error).__name__}: {error}",
                      wait_failed=isinstance(error, (WaitTimeout, BrowserTimeoutError)))
        raise VisitFailure(error, result) from error
    finally:
        result["waterfall"] = copy.deepcopy(list(waterfall.rows.values()))
        result["console_errors"] = list(console_errors)
        result["page_errors"] = list(errors)
        result["fixture_violations"] = list(stack.visit_violations)
        # A failed navigation/auth wait may leave a synthetic handler held.
        # Release this visit's event before its page closes and reset replaces it.
        stack.me_release.set()
        result["network_changed"] = network_changed(result)
        if result["network_changed"]:
            result["valid"] = False
        save(record_path, result)
        waterfall.close()
        page.close()


def missing_bundle(stack, browser):
    """Exercise a real 404 and recovery on owned synthetic files, without routing."""
    stack.activate("candidate")
    stack.reset()
    target = stack.active / "main-split.bundle.js"
    kept = target.read_bytes()
    evidence = {"artifact_sha256": hashlib.sha256(kept).hexdigest()}
    context = browser.new_context(ignore_https_errors=True)
    page = context.new_page()
    responses, errors = [], []
    page.on("response", lambda response: responses.append((urlparse(response.url).path, response.status)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    try:
        target.unlink()  # one exactly identified synthetic copy; never a product source
        page.goto(stack.url, wait_until="load")
        evidence.update(responses=responses, console_errors=errors, requests=list(stack.requests))
        assert [(path, status) for path, status in responses if path.endswith("/main-split.bundle.js")] == [
            ("/worklist/hpacs-lite/main-split.bundle.js", 404)], "real bundle failure must be visible"
        assert not stack.me_received.is_set(), "missing bundle must not start a partial boot"
        assert page.locator("#rows tr[data-uid]").count() == 0, "missing script cannot display a usable study list"
    finally:
        target.write_bytes(kept)
        assert digest(target) == evidence["artifact_sha256"]
        context.close()
        save(stack.root.parent / "external-load-failure.json", evidence)
