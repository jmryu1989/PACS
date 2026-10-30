# coding: utf-8
"""S9-U4b DG-T05 (REQ-S9-U4-DG-05, D1489; U4C-01): no nginx log line and no redirect Location carries a download grant.

Real nginx over the repository's own proxy configuration, in both deployment modes:
- the snippets are the ones the real proxy/15-kin-config.envsh writes (it is run by `sh`, sourced as the image's
  entrypoint does, with only its snippet directory moved into a temporary folder): in production the two default
  servers (`return 444`), ACME, HSTS and the admin guards; in development the empty ones;
- proxy/nginx.conf.template is rendered as the image's envsubst step does, with the values that script exported;
- the http block around it is the nginx:1.27-alpine image's own nginx.conf (`log_format main` with `$request`,
  `access_log ... main`, `error_log ... notice`) - so a server that forgets its own access_log logs the raw request.
What is changed for a loopback run, and only that: listen addresses (ephemeral 127.0.0.1 ports), file paths (snippets,
workflow includes, logs, temp), upstream host names (one local HTTP upstream answering the status a case names) and the
TLS lines (`ssl_*`, `http2`, the `ssl` listen flag) - so the "443" servers are spoken to in plain HTTP. TLS itself is not
exercised here; nginx's routing, maps, `if`, `return` and logging are.

Each case sends a synthetic 43-character grant-shaped marker and then reads the access log, the error log and the
answer's Location. A case passes only if the marker is in none of them, the answer is the one the configuration owes
(the API's status for the canonical archive, 400 for a grant key anywhere else, 444 on a default server) and the request
was logged at all (a log that wrote nothing would hide nothing). The detector is checked against itself: the same cases
with the archive format turned back into `$request` (DG-M09) must show the marker in the log.

nginx and sh come from PATH or from KIN_PROXY_NGINX / KIN_PROXY_SH (a host without them fails here; it is never a skip).
"""
import http.client
import http.server
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "proxy/nginx.conf.template"
ENVSH = ROOT / "proxy/15-kin-config.envsh"
WINDOWS = os.name == "nt"
ARCHIVE = "/api/studies/2.25.1/original-downloads/11111111-abcd-4111-8111-111111111111/archive"
STATUS_PATH = ARCHIVE[:-len("/archive")]
PRODUCTION_HOST = "pacs.koreaimagingnetwork.com"
# The nginx:1.27-alpine image's /etc/nginx/nginx.conf http block, as far as logging goes (the image's own file).
IMAGE_HTTP = """log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                  '$status $body_bytes_sent "$http_referer" '
                  '"$http_user_agent" "$http_x_forwarded_for"';
access_log  {logs}/access.log  main;
default_type application/octet-stream;
server_names_hash_bucket_size 64;
"""
# (The bucket size is the 64-bit image's own default, given explicitly for a 32-bit nginx build such as Windows'.)
# Spellings of the key "grant" a receiver decodes to the same key (case, one or more letters percent-encoded, an
# encoding encoded again) and separators/positions of a key.
KEY_SPELLINGS = ["grant", "GRANT", "Grant", "%67rant", "%47%52%41%4E%54", "gr%61nt", "%2567rant", "gran%74"]


def tool(name, variable):
    found = os.environ.get(variable) or shutil.which(name)
    if not found or not Path(found).is_file():
        raise AssertionError(f"{name} is required for this suite (PATH or {variable}); it is never skipped")
    return found


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def marker(n):
    """A grant-shaped value (43 base64url characters) unique to one request."""
    return ("SYNGRANT" + str(n) + "x" * 43)[:43]


class Upstream(http.server.BaseHTTPRequestHandler):
    """Every proxied service: answers the status the case asked for and records the request line it was given."""
    seen = []

    def do_GET(self):
        Upstream.seen.append(self.path)
        code = int(self.headers.get("X-Probe-Status", "200"))
        self.send_response(code)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"OK")

    def log_message(self, *args):
        pass


class Proxy:
    """One nginx over the rendered repository configuration in a temporary prefix."""

    def __init__(self, mode, upstream_port, raw_request_log=False, deployment=None):
        """deployment: what the compose service gives the proxy container beyond ports, mode and the Orthanc credential
        (today KIN_EMR_IMAGE_ASSET_CATALOG, which turns the E image route on). Nothing of it is read from this process."""
        self.mode = mode
        self.deployment = dict(deployment or {})
        self.dir = Path(tempfile.mkdtemp(prefix="kin-proxy-grant-"))
        for sub in ("conf", "snippets", "workflow", "logs", "temp"):
            (self.dir / sub).mkdir()
        self.p80, self.p443 = free_port(), free_port()
        exported = self.run_envsh()
        conf = self.render(exported, upstream_port, raw_request_log)
        (self.dir / "conf/nginx.conf").write_text(conf, encoding="utf-8", newline="\n")
        self.nginx = tool("nginx", "KIN_PROXY_NGINX")
        self.base = [self.nginx, "-p", self.dir.as_posix() + "/", "-c", "conf/nginx.conf", "-e", "logs/error.log"]
        check = subprocess.run(self.base + ["-t"], capture_output=True, timeout=30)
        if check.returncode != 0:
            raise AssertionError("nginx -t refused the rendered configuration: " + (check.stdout + check.stderr).decode(errors="replace"))
        extra = [] if WINDOWS else ["-g", "daemon off;"]
        flags = subprocess.CREATE_NO_WINDOW if WINDOWS else 0
        self.proc = subprocess.Popen(self.base + extra, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.p443), timeout=0.2):
                    with socket.create_connection(("127.0.0.1", self.p80), timeout=0.2):
                        return
            except OSError:
                time.sleep(0.05)
        self.stop()
        raise AssertionError("nginx did not start listening")

    def run_envsh(self):
        """The real 15-kin-config.envsh, sourced by sh, with its snippet directory moved here; returns what it exported."""
        sh = tool("sh", "KIN_PROXY_SH")
        script = ENVSH.read_text(encoding="utf-8").replace("\r\n", "\n")
        line = "SNIPPET_DIR=/etc/nginx/snippets"
        if script.count(line) != 1:
            raise AssertionError("15-kin-config.envsh no longer names its snippet directory in one line")
        copy = self.dir / "conf/15-kin-config.envsh"
        copy.write_text(script.replace(line, "SNIPPET_DIR='" + (self.dir / "snippets").as_posix() + "'"), encoding="utf-8", newline="\n")
        env = dict(os.environ, ORTHANC_USER="syn-user", ORTHANC_PASS="syn-pass", DEPLOYMENT_MODE=self.mode,
                   TLS_CERTIFICATE="/syn/cert.pem", TLS_CERTIFICATE_KEY="/syn/key.pem")
        if self.mode == "production":
            env.update(PUBLIC_PORT="443", SERVER_NAME=PRODUCTION_HOST)
        else:
            env.update(PUBLIC_PORT="9443")
            env.pop("SERVER_NAME", None)
        env.pop("KIN_EMR_IMAGE_ASSET_CATALOG", None)
        env.update(self.deployment)
        if not shutil.which("base64", path=env.get("PATH")):
            # A host sh without coreutils' base64 (Windows MinGit): a stand-in with the same output, for the Orthanc header.
            shim = self.dir / "shim"
            shim.mkdir()
            # Binary stdout preserves Unix LF on Windows; a CR would survive tr -d '\n' and truncate HTTP headers.
            (shim / "base64").write_text('#!/bin/sh\nexec "%s" -c "import base64,sys;sys.stdout.buffer.write(base64.b64encode(sys.stdin.buffer.read())+bytes([10]))"\n'
                                         % Path(sys.executable).as_posix(), encoding="utf-8", newline="\n")
            env["PATH"] = str(shim) + os.pathsep + env.get("PATH", "")
        names = ["PUBLIC_PORT", "PUBLIC_PORT_SUFFIX", "SERVER_NAME", "TLS_CERTIFICATE", "TLS_CERTIFICATE_KEY"]
        show = "; ".join(f'printf "%s\\n" "${name}"' for name in names)
        done = subprocess.run([sh, "-c", f". '{copy.as_posix()}' && {show}"], capture_output=True, env=env, timeout=60)
        if done.returncode != 0:
            raise AssertionError("15-kin-config.envsh failed: " + done.stderr.decode(errors="replace"))
        values = done.stdout.decode().replace("\r\n", "\n").split("\n")[:len(names)]
        return dict(zip(names, values))

    def render(self, exported, upstream_port, raw_request_log):
        logs, temp = (self.dir / "logs").as_posix(), (self.dir / "temp").as_posix()
        conf = TEMPLATE.read_text(encoding="utf-8").replace("\r\n", "\n")
        for name, value in exported.items():
            conf = conf.replace("${" + name + "}", value)
        if "${" in conf:
            raise AssertionError("an unsubstituted template variable is left")
        snippets = {}
        for path in sorted((self.dir / "snippets").glob("*.conf")):
            snippets[path.name] = path.read_text(encoding="utf-8")
        default_servers = snippets.get("default-servers.conf", "")
        if (self.mode == "production") != ("default_server" in default_servers):
            raise AssertionError("the default servers are not what the deployment mode writes")
        # TLS surrogate and loopback ports: every replaced form must be present, so a structural change fails here.
        def once(text, old, new, count):
            if text.count(old) != count:
                raise AssertionError(f"expected {count} x {old!r} in the rendered configuration")
            return text.replace(old, new)
        conf = once(conf, "listen 80;", f"listen 127.0.0.1:{self.p80};", 1)
        conf = once(conf, "listen 443 ssl;", f"listen 127.0.0.1:{self.p443};", 1)
        if self.mode == "production":
            default_servers = once(default_servers, "listen 80 default_server;", f"listen 127.0.0.1:{self.p80} default_server;", 1)
            default_servers = once(default_servers, "listen 443 ssl default_server;", f"listen 127.0.0.1:{self.p443} default_server;", 1)
        snippets["default-servers.conf"] = default_servers
        strip = lambda text: "\n".join(l for l in text.split("\n") if not l.strip().startswith(("ssl_", "http2 ")))
        conf = strip(conf)
        for name, text in snippets.items():
            (self.dir / "snippets" / name).write_text(strip(text).replace("/var/log/nginx/", logs + "/"), encoding="utf-8", newline="\n")
        conf = conf.replace("/etc/nginx/snippets/", (self.dir / "snippets").as_posix() + "/")
        conf = conf.replace("/etc/nginx/workflow/", (self.dir / "workflow").as_posix() + "/")
        conf = conf.replace("/var/log/nginx/", logs + "/")
        if WINDOWS:
            conf = conf.replace("/dev/null", "NUL")
        for host in ("api:3000", "orthanc:8042", "keycloak:8080"):
            conf = conf.replace(host, f"127.0.0.1:{upstream_port}")
        if raw_request_log:
            conf = once(conf, '"$request_method $uri"', '"$request"', 1)
        head = (f"worker_processes 1;\nerror_log {logs}/error.log notice;\npid {logs}/nginx.pid;\n"
                f"events {{ worker_connections 64; }}\nhttp {{\n" + IMAGE_HTTP.format(logs=logs)
                + "".join(f"{kind}_temp_path {temp}/{kind};\n" for kind in ("client_body", "proxy", "fastcgi", "uwsgi", "scgi")))
        return head + conf + "\n}\n"

    def logs(self):
        read = lambda name: (self.dir / "logs" / name).read_text(encoding="utf-8", errors="replace") if (self.dir / "logs" / name).exists() else ""
        return read("access.log"), read("error.log")

    def get(self, port, host, target, status=200):
        """One raw request (the target is sent as written: nothing re-encodes it). 444 = the connection was closed."""
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.putrequest("GET", target, skip_host=True, skip_accept_encoding=True)
            connection.putheader("Host", host)
            connection.putheader("X-Probe-Status", str(status))
            connection.endheaders()
            answer = connection.getresponse()
            answer.read()
            return answer.status, answer.getheader("Location", "")
        except (http.client.RemoteDisconnected, ConnectionResetError):
            return 444, ""
        finally:
            connection.close()

    def raw(self, port, data):
        """Bytes as written on one connection; the answer's status code (444 = closed without an answer)."""
        with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
            s.sendall(data)
            answer = b""
            try:
                while True:
                    chunk = s.recv(65536)
                    if not chunk:
                        break
                    answer += chunk
            except (socket.timeout, ConnectionResetError):
                pass
        if not answer:
            return 444
        return int(answer.split(b"\r\n", 1)[0].split()[1])
    def stop(self):
        try:
            subprocess.run(self.base + ["-s", "quit"], capture_output=True, timeout=15)
            self.proc.wait(timeout=15)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


class GrantLogTests(unittest.TestCase):
    mode = "production"
    raw_request_log = False

    @classmethod
    def setUpClass(cls):
        Upstream.seen = []
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.proxy = Proxy(cls.mode, cls.upstream.server_port, cls.raw_request_log)
        cls.host = PRODUCTION_HOST if cls.mode == "production" else "localhost"
        cls.count = 0

    @classmethod
    def tearDownClass(cls):
        cls.proxy.stop()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def send(self, path, key="grant", port=None, host=None, status=200, separator="?"):
        """One request carrying a fresh marker as the value of `key`; returns (status, location, marker, new log lines)."""
        type(self).count += 1
        value = marker(type(self).count)
        before, _ = self.proxy.logs()
        upstream_before = len(Upstream.seen)
        code, location = self.proxy.get(port or self.proxy.p443, host or self.host, path + separator + key + "=" + value, status)
        for _ in range(40):          # nginx writes the access log line when the request ends; wait for it
            access, error = self.proxy.logs()
            if len(access) > len(before):
                break
            time.sleep(0.025)
        reached = Upstream.seen[upstream_before:]
        return code, location, value, access[len(before):], error, reached

    def assertNothingCarries(self, label, value, lines, error, location):
        self.assertTrue(lines.strip(), f"{label}: the request was logged at all (an empty log would hide nothing)")
        self.assertNotIn(value, lines, f"DG-T05 {label}: the grant is in the access log")
        self.assertNotIn(value, error, f"DG-T05 {label}: the grant is in the error log")
        self.assertNotIn(value, location, f"DG-T05 {label}: the grant is in the redirect Location")

    def test_canonical_archive_logs_no_grant_for_every_api_answer(self):
        for status in (200, 401, 409, 410, 503):
            with self.subTest(status=status):
                code, location, value, lines, error, reached = self.send(ARCHIVE, status=status)
                self.assertEqual(status, code, "the API's answer passes")
                self.assertEqual(1, len(reached), "the canonical archive reaches the API")
                self.assertNothingCarries(f"canonical {status}", value, lines, error, location)
                self.assertIn(f'"GET {ARCHIVE}" {status} ', lines, "logged in the archive format")

    def test_an_encoded_key_on_the_canonical_archive_reaches_the_api_and_is_logged_without_the_query(self):
        for key in KEY_SPELLINGS[1:]:
            with self.subTest(key=key):
                code, location, value, lines, error, reached = self.send(ARCHIVE, key=key)
                self.assertEqual(200, code)
                self.assertNothingCarries("archive " + key, value, lines, error, location)

    def test_a_grant_key_anywhere_else_is_refused_before_any_upstream_in_every_spelling(self):
        paths = [ARCHIVE.replace("abcd", "ABCD"), ARCHIVE + "/", ARCHIVE.replace("/api/", "/API/"), STATUS_PATH,
                 "/api/health", "/", "/worklist/hpacs-lite/main.html", "/auth/realms/kin/account", "/dicom-web/studies",
                 "/not-exposed"]
        for path in paths:
            for key in KEY_SPELLINGS:
                with self.subTest(path=path, key=key):
                    code, location, value, lines, error, reached = self.send(path, key=key)
                    self.assertEqual(400, code, "DG-T05 a grant key outside the canonical archive is refused")
                    self.assertEqual([], reached, "DG-T05 it reaches no upstream")
                    self.assertNothingCarries(f"{path} {key}", value, lines, error, location)

    def test_a_grant_key_after_other_parameters_or_with_brackets_is_still_a_grant_key(self):
        for separator, key in (("?q=1&", "grant"), ("?q=1;", "grant"), ("?q=1&", "%67rant"), ("?", "grant[]"), ("?", "grant%5B%5D")):
            with self.subTest(separator=separator, key=key):
                code, location, value, lines, error, reached = self.send(STATUS_PATH, key=key, separator=separator)
                self.assertEqual(400, code)
                self.assertEqual([], reached)
                self.assertNothingCarries(separator + key, value, lines, error, location)

    def test_http_to_https_redirect_never_carries_a_grant_and_drops_every_query(self):
        for key in KEY_SPELLINGS:
            with self.subTest(key=key):
                code, location, value, lines, error, reached = self.send(ARCHIVE, key=key, port=self.proxy.p80)
                self.assertEqual(400, code, "DG-T05 a grant key over HTTP is refused, never redirected")
                self.assertEqual("", location)
                self.assertNothingCarries("http " + key, value, lines, error, location)
        # SRU4R3-3: other positions and spellings on port 80 - refused when the request line names the word, and any other
        # redirect carries the path only (the query is dropped), so no value reaches a Location.
        for target in ("??grant={V}", "?%20grant={V}", "?+grant={V}", "?a[grant={V}", "?q=grant={V}", "/grant={V}", ";grant={V}",
                       "%3Fgrant={V}", "?%25%36%37rant={V}", "?x={V}"):
            with self.subTest(target=target):
                type(self).count += 1
                value = marker(type(self).count)
                path = ARCHIVE + target.replace("{V}", value)
                before, _ = self.proxy.logs()
                code, location = self.proxy.get(self.proxy.p80, self.host, path)
                time.sleep(0.1)
                access, error = self.proxy.logs()
                self.assertIn(code, (301, 400), target)
                if code == 301:
                    self.assertTrue(location.endswith(ARCHIVE) or "?" not in location, "SRU4R3-3 the redirect drops the query: " + location)
                if target.startswith(("/", ";", "%3F")):
                    # The value is in the path itself: refused and never redirected; an access log line records the path it
                    # was asked for (the API never takes a grant from a path - only from the literal query `grant=`).
                    self.assertEqual((400, ""), (code, location), "SRU4R3-3 a path naming the word is refused over HTTP")
                    self.assertNotIn(value, error, "the error log")
                else:
                    self.assertNothingCarries("http80 " + target, value, access[len(before):], error, location)
        code, location = self.proxy.get(self.proxy.p80, self.host, "/api/health?q=1")
        self.assertEqual((301, True), (code, location.endswith("/api/health")), "an ordinary redirect keeps its path, never its query")

    def test_requests_nginx_ends_while_reading_them_log_no_grant(self):
        """SRU4R3-1/2: a request refused while its header or URI is read (bad header line, duplicate Host, header or cookie
        over the buffers, a URI over the buffers) never reaches the rewrite phase; no access or error log line (notice)
        may carry its grant - on the canonical archive, the status path and over HTTP."""
        cases = [("bad header line", b"Bad Header Line\r\n", ""), ("duplicate Host", b"Host: x.test\r\n", ""),
                 ("494 big header", b"X-Big: " + b"b" * 9000 + b"\r\n", ""), ("494 big cookie", b"Cookie: kin_sid=" + b"c" * 9000 + b"\r\n", ""),
                 ("414 long URI", b"", "&pad=" + "a" * 9000)]
        for path in (ARCHIVE, STATUS_PATH):
            for port in (self.proxy.p443, self.proxy.p80):
                for label, extra, tail in cases:
                    with self.subTest(path=path, port=port, case=label):
                        type(self).count += 1
                        value = marker(type(self).count)
                        before, error_before = self.proxy.logs()
                        head = f"GET {path}?grant={value}{tail} HTTP/1.1\r\nHost: {self.host}\r\nConnection: close\r\n".encode()
                        code = self.proxy.raw(port, head + extra + b"\r\n")
                        for _ in range(40):
                            access, error = self.proxy.logs()
                            if len(access) > len(before):
                                break
                            time.sleep(0.025)
                        self.assertIn(code, (400, 414, 494), label)
                        self.assertNothingCarries(f"{label} {port} {path}", value, access[len(before):], error[len(error_before):], "")
    def test_ordinary_requests_keep_the_image_log_with_their_query_and_a_value_is_not_a_key(self):
        before, _ = self.proxy.logs()
        upstream_before = len(Upstream.seen)
        self.assertEqual(200, self.proxy.get(self.proxy.p443, self.host, "/api/health?q=1")[0])
        self.assertEqual(200, self.proxy.get(self.proxy.p443, self.host, "/api/studies?q=grantham")[0],
                         "a value containing the word is not a grant key (no false refusal)")
        time.sleep(0.2)
        access, _ = self.proxy.logs()
        self.assertEqual(2, len(Upstream.seen) - upstream_before)
        self.assertIn('"GET /api/health?q=1 HTTP/1.1"', access[len(before):], "the image's main log is kept for ordinary requests")
        self.assertNotIn("grantham", access[len(before):], "the word anywhere in a query: logged without the query")


class DevelopmentGrantLogTests(GrantLogTests):
    """The same over the development snippets (no default servers: the two servers answer every Host)."""
    mode = "development"


class ProductionDefaultServerTests(unittest.TestCase):
    """Another Host on either port reaches the production default servers (444): their log carries no grant either."""

    @classmethod
    def setUpClass(cls):
        GrantLogTests.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        GrantLogTests.tearDownClass.__func__(cls)

    send = GrantLogTests.send
    assertNothingCarries = GrantLogTests.assertNothingCarries
    mode = "production"
    raw_request_log = False

    def test_default_servers_log_no_grant(self):
        for port in (self.proxy.p443, self.proxy.p80):
            for key in KEY_SPELLINGS:
                with self.subTest(port=port, key=key):
                    code, location, value, lines, error, reached = self.send(ARCHIVE, key=key, port=port, host="other.test")
                    self.assertEqual(444, code, "the default server closes the connection")
                    self.assertEqual([], reached)
                    self.assertNothingCarries(f"default {port} {key}", value, lines, error, location)


class DetectorSelfCheck(unittest.TestCase):
    """DG-M09: with the archive format turned back into the raw request line, the same checks must see the grant."""

    def test_raw_request_format_is_detected(self):
        cls = type("Raw", (GrantLogTests,), {"raw_request_log": True})
        cls.setUpClass()
        try:
            case = cls("test_canonical_archive_logs_no_grant_for_every_api_answer")
            for status in (200, 401, 409, 410, 503):
                code, location, value, lines, error, reached = case.send(ARCHIVE, status=status)
                self.assertEqual(status, code)
                self.assertIn(value, lines, f"DG-M09 the detector sees a raw request line ({status})")
        finally:
            cls.tearDownClass()


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    for case in (GrantLogTests, DevelopmentGrantLogTests, ProductionDefaultServerTests, DetectorSelfCheck):
        suite.addTests(loader.loadTestsFromTestCase(case))
    return suite


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    suite = load_tests(unittest.defaultTestLoader, None, None)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() and not result.skipped and result.testsRun else 1


if __name__ == "__main__":
    raise SystemExit(main())
