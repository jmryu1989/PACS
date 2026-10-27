# coding: utf-8
"""TEST-ASR-FIRST-SITE: dictation configured the way a first site configures it, on the real served page.

REQ-S3-ASR-FIRST-PATH -> RISK-S3-R14-LOST-DICTATED-TEXT (Part 1 re-plan "받아쓰기 첫 사이트 구성·품질·복구 확인",
census C13 and C24) -> this file. Docs: docs/ops/dictation-first-site.md.

The stack is the product's (nginx, BFF login, Nest API, PostgreSQL, Orthanc), plus a Compose service `asr` that
runs the pinned whisper.cpp engine and model of the CI fixture (tests/fixtures/asr, engine target). The heavy-host
driver adds that service and sets KIN_ASR_* on the API: the endpoint is a dotted hospital-style DNS name (a network
alias), the size limit and timeout are left unset so the shipped defaults are what is measured. Chromium's own
file-backed fake microphone plays the synthetic eSpeak passage of tests/dictation_first_site_passage.py
(KIN_FIRST_SITE_SPEECH). Every state change on the page is a real click or key press; page reads are read-only.

  01  the configured capability, and one recording left running until the default limit stops it (180 s): the
      wire size, the time to the transcript, the audit row and a synthetic recognition score; Insert, Save and a
      reload show the text kept.
  02  engine process down behind a name that still resolves (a hospital DNS record of a stopped service): the
      reader records, the request fails, the recording is held with Retry while the draft they typed stays (on
      screen and as the server draft); the engine comes back, Retry transcribes the very same bytes, Insert,
      Save, reload.
  03  engine frozen (paused): the request runs into the default timeout while the reader keeps typing; the held
      recording is sent again once the engine runs, and both the typed and the dictated text are saved.
  04  engine container stopped (a Compose-local engine): its name stops resolving; that too is a held recording,
      not a configuration error, and Retry succeeds once the container runs again.

The `asr` service runs whisper-server under a small test-only shell loop (the driver's override) that keeps the
container, and so its DNS name, alive while /tmp/kin-engine-down exists; that is how 02 takes the engine process
down without touching DNS.

Not claimed: real speech quality (a radiologist's voice, accent, vocabulary, microphone or room), Korean
recognition, a hospital's GPU/CPU, the timing of an engine on another host, physician acceptance. Those need
real use and stay NOT_RUN in the run's record. Run only through scripts/run-tests.py --mode live with
--class DictationFirstSiteE2E (the inherited worklist cases are not this suite).
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unittest
import wave
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_worklist  # noqa: E402  (the live base: C-STORE fixture, BFF login and zero-row cleanup)
from report_dictation_capture_dom_test import launch_args  # noqa: E402  (the accepted fake-microphone flags)
import dictation_first_site_passage as passage  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(os.environ.get('KIN_FIRST_SITE_ARTIFACTS', ROOT / 'tests/e2e/artifacts/dictation-first-site'))
ENGINE_SERVICE = 'asr'
DEFAULT_BYTES = 180 * 32000 + 44          # the unconfigured limit (api/src/dictation-audio.ts)
DEFAULT_TIMEOUT_MS = 120000               # the unconfigured engine timeout (api/src/asr.service.ts)
WAIT_MS = 20000
ENGINE_READY_SECONDS = 180
ASR_SOURCE = (ROOT / 'api' / 'src' / 'asr.service.ts').read_text(encoding='utf-8')
# Asked from inside the API container, so DNS and routing are the product's own: any HTTP answer on the
# configured origin means the engine is listening. Prints the status, or the error code.
ENGINE_PROBE = ("const u=new URL(process.env.KIN_ASR_URL);fetch(u.origin+'/',{redirect:'manual'})"
                ".then(r=>{console.log('status '+r.status)}).catch(e=>{console.log('error '+((e.cause&&e.cause.code)||e.name))})")
PANE = """() => { const q = s => document.querySelector(s), v = dictation.view();
  const c = id => { const el = q('#dictation-' + id); return el ? { hidden: !!el.hidden, disabled: !!el.disabled } : null; };
  return { state: v.state, held: v.held, status: q('#dictation-status').textContent, text: q('#dictation-text').textContent,
    controls: { stop: c('stop'), cancel: c('cancel'), retry: c('retry'), insert: c('insert'), close: c('close') },
    button: { disabled: !!q('#b-dictate').disabled, title: q('#b-dictate').getAttribute('title') },
    focused: document.activeElement ? document.activeElement.id : null }; }"""
STRINGS = "() => ({ reasons: KinDictation.REASONS, held: KinDictation.STATUS.held, uploading: KinDictation.STATUS.uploading, " \
          "capped: KinDictation.STATUS.capped, ready: KinDictation.TITLES.ready, capability: dictation.view().serverAvailable })"


def source_pin(name):
    found = re.findall(r"export const %s = '([^']+)';" % name, ASR_SOURCE)
    return found[0] if len(found) == 1 else None


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def run(argv, timeout=120):
    done = subprocess.run(argv, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
                          timeout=timeout)
    if done.returncode:
        raise RuntimeError('%s exited %d: %s' % (argv[:3], done.returncode, (done.stdout + done.stderr)[-600:]))
    return done.stdout.strip()


class Engine:
    """The stack's ASR engine container, found through the api service's own Compose project label, so it is the
    engine of the stack this process selected and no container name is fixed here."""

    def __init__(self):
        api = subprocess.run(['docker', 'compose', 'ps', '-q', 'api'], cwd=ROOT, capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=60)
        ids = api.stdout.split()
        if api.returncode or len(ids) != 1:
            raise RuntimeError('the selected stack has no single api container: %s' % (api.stdout + api.stderr)[-300:])
        project = run(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', ids[0]])
        found = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project,
                     '--filter', 'label=com.docker.compose.service=' + ENGINE_SERVICE]).split()
        if len(found) != 1:
            raise RuntimeError('expected one %s engine in project %s, found %d' % (ENGINE_SERVICE, project, len(found)))
        self.id, self.project = found[0], project

    def status(self):
        return run(['docker', 'inspect', '--format', '{{.State.Status}}', self.id])

    def stop(self):
        run(['docker', 'stop', self.id], timeout=120)

    def start(self):
        run(['docker', 'start', self.id], timeout=120)

    def pause(self):
        run(['docker', 'pause', self.id], timeout=60)

    def unpause(self):
        run(['docker', 'unpause', self.id], timeout=60)

    def down(self):
        """The engine process ends and stays down; the container and its DNS name stay (the driver's loop)."""
        run(['docker', 'exec', self.id, 'sh', '-c', 'touch /tmp/kin-engine-down && kill "$(cat /tmp/kin-engine.pid)"'])

    def up(self):
        run(['docker', 'exec', self.id, 'rm', '-f', '/tmp/kin-engine-down'])

    def probe(self):
        done = subprocess.run(['docker', 'compose', 'exec', '-T', 'api', 'node', '-e', ENGINE_PROBE], cwd=ROOT,
                              capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
        return (done.stdout.strip() or done.stderr.strip())[-200:]

    def ready(self, seconds=ENGINE_READY_SECONDS):
        """Running, unpaused and answering on the configured name, as the API sees it."""
        state = self.status()
        if state == 'paused':
            self.unpause()
        elif state != 'running':
            self.start()
        self.up()
        until, last = time.monotonic() + seconds, None
        while time.monotonic() < until:
            last = self.probe()
            if last.startswith('status '):
                return last
            time.sleep(1)
        raise RuntimeError('the engine did not answer on the configured name: %r' % last)


def api_log_since(since):
    return subprocess.run(['docker', 'compose', 'logs', '--no-color', '--since', since, 'api'], cwd=ROOT,
                          capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60).stdout


def utc_stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


class _Granting:
    """The capture browser; each new context already allows this origin's microphone (headless has no prompt)."""

    def __init__(self, browser, origin):
        self._browser, self._origin = browser, origin

    def new_context(self, **kwargs):
        context = self._browser.new_context(**kwargs)
        context.grant_permissions(['microphone'], origin=self._origin)
        return context


class DictationFirstSiteE2E(test_worklist.WorklistE2E):
    browser_channel = 'chromium'
    record = {}

    @classmethod
    def setUpClass(cls):
        speech = os.environ.get('KIN_FIRST_SITE_SPEECH')
        if not speech or not Path(speech).is_file():
            raise RuntimeError('KIN_FIRST_SITE_SPEECH must name the generated passage WAV')
        cls.speech = Path(speech).resolve()
        with wave.open(str(cls.speech), 'rb') as w:
            cls.speech_seconds = w.getnframes() / w.getframerate()
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        cls.record = {'speech': {'path': str(cls.speech), 'sha256': sha256(cls.speech.read_bytes()),
                                 'seconds': round(cls.speech_seconds, 3), 'sentences': passage.COUNT},
                      'tests': {}}
        cls.addClassCleanup(cls.write_record)
        super().setUpClass()
        cls.capture = cls.pw.chromium.launch(channel='chromium', headless=True, args=launch_args(cls.speech))
        cls.addClassCleanup(cls.capture.close)
        cls.engine = Engine()
        cls.record['engine'] = {'project': cls.engine.project, 'service': ENGINE_SERVICE}

    @classmethod
    def write_record(cls):
        text = json.dumps(cls.record, ensure_ascii=False, indent=2, sort_keys=True)
        (ARTIFACTS / 'first-site.json').write_text(text + '\n', encoding='utf-8')
        print('FIRST-SITE ' + json.dumps(cls.record, ensure_ascii=False, sort_keys=True), flush=True)

    def setUp(self):
        super().setUp()
        self.browser = _Granting(type(self).capture, self.stack.proxy)
        # Each case starts with the engine running and leaves it running, whatever it did to it.
        self.engine.ready()
        self.addCleanup(self.engine.ready)
        self.out = type(self).record['tests'].setdefault(self._testMethodName, {})

    # ── shared steps ─────────────────────────────────────────────────────────────────────────────
    def open_study(self):
        f = self.fixture()
        self.seed_report(f)
        page = self.login()
        self.select(page, f)
        expect(page.locator('#findings')).to_have_value(f.secret)
        return f, page

    def type_into(self, page, field, text):
        page.locator('#' + field).click()
        page.keyboard.press('Control+End')
        page.keyboard.type(text)
        return page.locator('#' + field).input_value()

    def pane(self, page):
        return page.evaluate(PANE)

    def strings(self, page):
        return page.evaluate(STRINGS)

    def wait_pane(self, page, predicate, seconds, what):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            seen = self.pane(page)
            if predicate(seen):
                return seen
            page.wait_for_timeout(100)
        self.fail('%s; pane %r' % (what, self.pane(page)))

    @staticmethod
    def is_dictation(uid):
        path = '/api/studies/%s/dictation' % uid
        return lambda r: r.request.method == 'POST' and urlsplit(r.url).path == path

    def record_short(self, page, uid, seconds=6, answer_seconds=60):
        """Dictate, speak for `seconds`, Stop: the request's response and the bytes it carried."""
        page.locator('#b-dictate').click()
        self.wait_pane(page, lambda p: p['state'] == 'recording', 20, 'recording did not start')
        page.wait_for_timeout(seconds * 1000)
        started = time.monotonic()
        with page.expect_response(self.is_dictation(uid), timeout=answer_seconds * 1000) as reply:
            page.locator('#dictation-stop').click()
        response = reply.value
        return response, response.request.post_data_buffer, round(time.monotonic() - started, 3)

    def audit(self, f):
        if not re.fullmatch(r'[0-9.]+', f.uid):
            raise RuntimeError('Invalid fixture UID')
        rows = []
        for raw in test_worklist.psql("SELECT coalesce(detail, '') FROM \"AuditLog\" WHERE target='%s' "
                                      "AND action='dictation.request' ORDER BY id;" % f.uid):
            rows.append(json.loads(raw))
        return rows

    def insert_save_reopen(self, page, f, expected):
        """Insert the reviewed text, Save, then a fresh page load of the same study shows what was saved."""
        self.wait_pane(page, lambda p: p['state'] == 'review' and p['controls']['insert'] == {'hidden': False, 'disabled': False},
                       20, 'review with an enabled Insert did not appear')
        page.locator('#dictation-insert').click()
        self.wait_pane(page, lambda p: p['state'] == 'inserted', 20, 'Insert did not complete')
        values = {name: page.locator('#' + name).input_value() for name in ('findings', 'conclusion')}
        for name, parts in expected.items():
            for part in parts:
                self.assertIn(part, values[name], name)
        with page.expect_response(lambda r: r.request.method == 'POST' and
                                  r.url.endswith('/studies/%s/report/commit' % f.uid)) as reply:
            page.locator('#b-save').click()
        self.assertEqual(reply.value.status, 201)
        state = self.state(f)
        for name, parts in expected.items():
            for part in parts:
                self.assertIn(part, state[name], 'saved ' + name)
        # A leave prompt would be the page's own question; accepting it is what a reader who reloads does.
        page.once('dialog', lambda dialog: dialog.accept())
        page.reload()
        expect(page.locator('#dbstat')).to_contain_text('DB Connected')
        self.select(page, f)
        for name in expected:
            expect(page.locator('#' + name)).to_have_value(state[name])
        return values

    # ── 01 ───────────────────────────────────────────────────────────────────────────────────────
    def test_first_site_01_configured_and_a_180_second_recording(self):
        out = self.out
        engine_pin, model_pin = source_pin('ASR_ENGINE_PIN'), source_pin('ASR_MODEL_PIN')
        configured = self.stack.request('GET', '/bootstrap', 'doctor').body['dictation']
        out['capability'] = configured
        self.assertEqual(configured, {'available': True, 'maxBytes': DEFAULT_BYTES, 'timeoutMs': DEFAULT_TIMEOUT_MS,
                                      'languagePin': configured.get('languagePin'), 'enginePin': engine_pin,
                                      'modelPin': model_pin})
        printed = subprocess.run(['docker', 'compose', 'exec', '-T', 'api', 'printenv', 'KIN_ASR_URL'], cwd=ROOT,
                                 capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
        self.assertEqual(printed.returncode, 0, printed.stderr[-300:])
        url = urlsplit(printed.stdout.strip())
        out['endpoint_host'] = url.hostname
        # C24: the endpoint is a dotted DNS name, not an IP and not a single compose label.
        self.assertIn('.', url.hostname)
        self.assertFalse(re.fullmatch(r'[0-9.]+|\[.*\]', url.hostname))
        self.assertLessEqual(self.speech_seconds, 175, 'the passage must end inside the 180 s recording')

        f, page = self.open_study()
        strings = self.strings(page)
        expect(page.locator('#b-dictate')).to_be_enabled()
        self.assertEqual(page.locator('#b-dictate').get_attribute('title'), strings['ready'])
        typed = self.type_into(page, 'findings', ' / typed before a long dictation.')
        sent, path = {}, '/api/studies/%s/dictation' % f.uid

        def on_request(request):
            if request.method == 'POST' and urlsplit(request.url).path == path:
                sent.setdefault('t', time.monotonic())
        page.on('request', on_request)
        clicked = time.monotonic()
        with page.expect_response(self.is_dictation(f.uid), timeout=(185 + DEFAULT_TIMEOUT_MS // 1000 + 15) * 1000) as reply:
            page.locator('#b-dictate').click()
            recording = self.wait_pane(page, lambda p: p['state'] == 'recording', 20, 'recording did not start')
            out['recording_status'] = recording['status']
            self.assertIn('최대 약 180초', recording['status'], 'the reader is told the limit')
            capped = self.wait_pane(page, lambda p: p['state'] == 'uploading', 200, 'the 180 s limit did not stop the recording')
            out['capped_status'] = capped['status']
            self.assertEqual(capped['status'], strings['capped'])
        answered = time.monotonic()
        response = reply.value
        body = response.request.post_data_buffer
        payload = response.json()
        transcript = payload.get('text', '') if isinstance(payload, dict) else ''
        rows = self.audit(f)
        out.update(status=response.status, wire_bytes=len(body), wire_sha256=sha256(body),
                   seconds_dictate_to_request=round(sent.get('t', answered) - clicked, 3),
                   seconds_request_to_transcript=round(answered - sent.get('t', answered), 3),
                   audit=rows, score=passage.score(transcript), transcript_chars=len(transcript))
        (ARTIFACTS / '01-transcript.txt').write_text(transcript, encoding='utf-8')
        self.assertEqual(response.status, 200, payload)
        self.assertEqual(len(body), DEFAULT_BYTES, 'the capture stops at exactly the configured limit')
        self.assertEqual([(r['bytes'], r['seconds'], r['outcome']) for r in rows], [(DEFAULT_BYTES, 180, 'success')])
        # The end of the passage was spoken after 140 s: hearing it shows the whole recording reached the engine.
        self.assertGreaterEqual(out['score']['tail_recognised'], 1, out['score'])
        self.insert_save_reopen(page, f, {'findings': [typed, transcript.strip()[:60]]})

    # ── 02 and 04 ────────────────────────────────────────────────────────────────────────────────
    def test_first_site_02_engine_process_down_holds_the_recording_until_it_is_back(self):
        self.down_and_back(self.engine.down)

    def test_first_site_04_engine_container_stopped_is_held_too_not_a_configuration_error(self):
        self.down_and_back(self.engine.stop)

    def down_and_back(self, take_down):
        out = self.out
        f, page = self.open_study()
        strings = self.strings(page)
        typed = self.type_into(page, 'findings', ' / typed while the engine is down.')
        take_down()
        out['engine_state'] = self.engine.status()
        out['engine_probe_down'] = self.engine.probe()
        since = utc_stamp()
        first, bytes_first, waited = self.record_short(page, f.uid)
        payload = first.json()
        out.update(down_status=first.status, down_code=payload.get('code'), down_seconds=waited)
        self.assertEqual((first.status, payload.get('code')), (503, 'DICTATION_ENGINE_FAILED'))
        held = self.wait_pane(page, lambda p: p['held'], 20, 'the recording was not held')
        out['held_pane'] = held
        self.assertEqual(held['status'], strings['reasons']['DICTATION_ENGINE_FAILED'] + strings['held'])
        self.assertEqual(held['controls']['retry'], {'hidden': False, 'disabled': False})
        self.assertEqual(held['controls']['cancel'], {'hidden': False, 'disabled': False})
        self.assertEqual(held['focused'], 'dictation-retry', 'a second Enter must not land on Cancel')
        self.assertEqual(page.locator('#findings').input_value(), typed, 'the draft on screen is untouched')
        self.wait_state(page, f, lambda s: (s.get('draft') or {}).get('findings') == typed, timeout=45000)
        log = api_log_since(since)
        out['api_log'] = [line for line in log.splitlines() if 'AsrService' in line][-5:]
        self.assertTrue(any('음성 인식기 요청 실패' in line for line in out['api_log']), out['api_log'])
        self.assertFalse(any('KIN_ASR_URL 설정 오류' in line for line in out['api_log']), 'an absent engine is not a configuration error')

        out['engine_back'] = self.engine.ready()
        retried_at = time.monotonic()
        with page.expect_response(self.is_dictation(f.uid), timeout=(DEFAULT_TIMEOUT_MS // 1000 + 15) * 1000) as reply:
            page.locator('#dictation-retry').click()
        second = reply.value
        bytes_second = second.request.post_data_buffer
        transcript = second.json().get('text', '')
        out.update(retry_status=second.status, retry_seconds=round(time.monotonic() - retried_at, 3),
                   same_recording=sha256(bytes_first) == sha256(bytes_second), wire_bytes=len(bytes_second),
                   score=passage.score(transcript), transcript=transcript)
        self.assertEqual(second.status, 200)
        self.assertEqual(sha256(bytes_second), sha256(bytes_first), 'Retry sends the very same recording')
        self.assertEqual([r['outcome'] for r in self.audit(f)], ['DICTATION_ENGINE_FAILED', 'success'])
        self.insert_save_reopen(page, f, {'findings': [typed, transcript.strip()[:40]]})

    # ── 03 ───────────────────────────────────────────────────────────────────────────────────────
    def test_first_site_03_engine_frozen_times_out_and_the_reader_keeps_working(self):
        out = self.out
        f, page = self.open_study()
        strings = self.strings(page)
        typed = self.type_into(page, 'findings', ' / typed before the engine froze.')
        self.engine.pause()
        out['engine_state'] = self.engine.status()
        page.locator('#b-dictate').click()
        self.wait_pane(page, lambda p: p['state'] == 'recording', 20, 'recording did not start')
        page.wait_for_timeout(6000)
        started = time.monotonic()
        with page.expect_response(self.is_dictation(f.uid), timeout=(DEFAULT_TIMEOUT_MS // 1000 + 30) * 1000) as reply:
            page.locator('#dictation-stop').click()
            waiting = self.wait_pane(page, lambda p: p['state'] == 'uploading', 20, 'the request did not start')
            self.assertEqual(waiting['status'], strings['uploading'])
            self.assertEqual(waiting['controls']['cancel'], {'hidden': False, 'disabled': False})
            page.wait_for_timeout(3000)
            # The reader goes on with the report while the engine does not answer.
            conclusion = self.type_into(page, 'conclusion', ' typed while waiting for the engine.')
        first = reply.value
        out.update(frozen_status=first.status, frozen_code=first.json().get('code'),
                   seconds_to_timeout=round(time.monotonic() - started, 3))
        self.assertEqual((first.status, first.json().get('code')), (503, 'DICTATION_TIMEOUT'))
        held = self.wait_pane(page, lambda p: p['held'], 20, 'the recording was not held')
        out['held_pane'] = held
        self.assertEqual(held['status'], strings['reasons']['DICTATION_TIMEOUT'] + strings['held'])
        self.assertEqual(page.locator('#findings').input_value(), typed)
        self.assertEqual(page.locator('#conclusion').input_value(), conclusion)

        self.engine.unpause()
        out['engine_back'] = self.engine.ready()
        retried_at = time.monotonic()
        # The engine may first finish the abandoned request; whisper.cpp serves one inference at a time.
        with page.expect_response(self.is_dictation(f.uid), timeout=(DEFAULT_TIMEOUT_MS // 1000 + 30) * 1000) as reply:
            page.locator('#dictation-retry').click()
        second = reply.value
        transcript = second.json().get('text', '') if second.status == 200 else ''
        out.update(retry_status=second.status, retry_code=None if second.status == 200 else second.json().get('code'),
                   retry_seconds=round(time.monotonic() - retried_at, 3), score=passage.score(transcript),
                   transcript=transcript)
        self.assertEqual(second.status, 200, out.get('retry_code'))
        self.assertEqual([r['outcome'] for r in self.audit(f)], ['DICTATION_TIMEOUT', 'success'])
        self.insert_save_reopen(page, f, {'findings': [typed, transcript.strip()[:40]], 'conclusion': [conclusion]})


if __name__ == '__main__':
    unittest.main()
