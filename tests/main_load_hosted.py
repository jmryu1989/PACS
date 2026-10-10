"""D906 / REQ-S9-U0a-PRE-ORDER -> RISK-LOAD-REGRESSION -> TEST-PRE-LOAD-BUDGET.

The real, unchanged proxy and Orthanc ServeFolders serve both byte-pinned sides.
Only API answers are synthetic. No browser routing or product instrumentation is
used. This fixture requires run-tests.py's live lease, even though it has no real
accounts, DICOM, database, host credentials, or persistent Docker volumes.
"""
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

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def assert_script_requests(baseline, candidate):
    """Only the approved bundle request may differ; retain names and occurrences."""
    expected = Counter(map(tuple, baseline))
    expected[("GET", "/worklist/hpacs-lite/main-split.bundle.js", "")] += 1
    actual = Counter(map(tuple, candidate))
    assert actual == expected, f"different script requests: expected={expected!r}, actual={actual!r}"


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
        self.me_received.clear()
        self.me_release.clear()

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
        deadline = time.monotonic() + 60
        while True:
            try:
                with urlopen(self.url, context=ssl._create_unverified_context(), timeout=2) as response:
                    assert hashlib.sha256(response.read()).hexdigest() == self.versions["baseline"]["main.html"]
                    save(self.root / "readiness-headers.json", dict(response.headers))
                break
            except (OSError, AssertionError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.2)
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
                stamp = time.perf_counter()
                url = urlparse(self.path)
                stack.requests.append({"method": "GET", "path": url.path, "query": url.query, "received": stamp})
                if url.path == "/api/health":
                    return self.fulfill(json={"ok": True, "synthetic": True})
                if url.path == "/api/me":
                    stack.me_received.set()
                    if not stack.me_release.wait(30):
                        stack.violations.append("auth release timeout")
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
                        account, refused = stack.site.authenticate(request, strict=True)
                        if refused:
                            return stack.site.refuse(self, *refused)
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
                        stack.site.api(self, request, "GET", url.path, url.query)
                    else:
                        self.fulfill(status=404, body="synthetic endpoint absent")
                except Exception as error:
                    stack.violations.append(repr(error))
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


def wait(page, predicate, label):
    deadline = time.perf_counter() + 30
    while not predicate():
        if time.perf_counter() >= deadline:
            raise AssertionError("hosted timeout: " + label)
        page.wait_for_timeout(10)


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
    result = {**metadata, "side": stack.side, "url": stack.url, "valid": False}
    try:
        started = time.perf_counter()
        page.goto(stack.url, wait_until="commit")
        wait(page, lambda: bool(auth) and stack.me_received.is_set(), "first auth")
        answered = time.perf_counter()
        stack.me_release.set()  # same observation point as the PRE route fixture
        wait(page, lambda: patient in page.locator("#rows").inner_text(), "usable list")
        page.locator("#quick").fill(patient)
        wait(page, lambda: page.locator('#rows tr[data-uid]').count() > 0, "usable search")
        usable = time.perf_counter()
        performance = waterfall.performance()
        # Freeze both timing observations before collecting the complete startup
        # request set. Body hashing can otherwise cross the delayed inbox poll
        # on only one side. Observe its real response on both pages; do not drop
        # requests or move the usable boundary to make the budget pass.
        def inbox_complete():
            return any(urlparse(row.get("url", "")).path == "/api/critical-results"
                       and parse_qs(urlparse(row["url"]).query).get("view") == ["received"]
                       and parse_qs(urlparse(row["url"]).query).get("state") == ["pending"]
                       and row.get("status") == 200 and "end" in row
                       for row in waterfall.rows.values())
        wait(page, inbox_complete, "first received-inbox response")
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
        assert not stack.violations, stack.violations
        assert result["navigation"][0]["type"] == "navigate", "warm visit must be a new document"
        # Real wire checks, not inferred from an https URL or the template alone.
        static = [r for r in waterfall.rows.values() if "/worklist/" in r.get("url", "") and "status" in r]
        assert static and all(r["protocol"] == "h2" for r in static), "static protocol mismatch"
        scripts = [r for r in static if urlparse(r["url"]).path.endswith(".js")]
        assert len(scripts) == (57 if stack.side == "candidate" else 56), "execution request count"
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
    finally:
        result["waterfall"] = list(waterfall.rows.values())
        save(stack.root.parent / f"visit-{metadata['visit']:02d}.json", result)
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
