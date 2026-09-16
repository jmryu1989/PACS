# coding: utf-8
"""NEVER MERGE. Observation-only recorder for one isolated hosted diagnosis of
test_marks_19_receipt_after_layout_change_acknowledges_saved_source (evidence stage1-marks-receipt-diagnosis-02).

ReceiptObserver(page) opens its own CDP session on the viewer page and records the Network lifecycle of /api/me and
/api/studies/<study>/viewer-jobs[/...] requests only: method, path kind, query key names, resource and initiator type,
CDP timestamps, response status, protocol and timing numbers, failure text. It never records a URL query value, header,
cookie, body or study id; ExtraInfo events are recorded as presence only. A page script samples the Jobs panel (busy,
kept request, 3D annotation dirty, Job Title length, status text) on every status mutation and on change every 100 ms, and
records whether each pointerdown was inside the panel (an outside pointerdown is what advances the panel's private serial).
mark() stores a named Python monotonic and wall time. Nothing here routes, continues, fulfills, aborts, retries or waits for
a request; a failure inside the observer is recorded, never raised into the test. finish() prints one bounded
'MARKS_RECEIPT_DIAGNOSTIC {json}' line to stderr, which measurement_ci.py keeps in the sanitized suite log (the upload
tests/e2e/artifacts/volume-marks-ci/test_volume_marks.log)."""
import json
import re
import sys
import time
from urllib.parse import parse_qsl, urlsplit

PREFIX = 'MARKS_RECEIPT_DIAGNOSTIC '
EVENTS = ('requestWillBeSent', 'requestWillBeSentExtraInfo', 'responseReceived', 'responseReceivedExtraInfo',
          'loadingFinished', 'loadingFailed')
LIMITS = {'requests': 200, 'events': 1200, 'marks': 80, 'early': 4000, 'ignored': 20000, 'errors': 40, 'pageRows': 800,
          'intervalMs': 100}
TIMING = ('requestTime', 'connectStart', 'connectEnd', 'sendStart', 'sendEnd', 'receiveHeadersStart', 'receiveHeadersEnd')
VIEWER_JOBS = re.compile(r'/api/studies/[^/]+/viewer-jobs((?:/[^/]+)*)/?')
PAGE_OBSERVER = r'''limits => {
  if (window.__kinMarksReceiptObserver) return 'already installed';
  const rows = [], errors = [], panel = document.getElementById('kin-viewer-jobs'), status = document.getElementById('kin-viewer-jobs-status');
  const title = panel ? panel.querySelector('input[aria-label="Job Title"]') : null;
  let dropped = 0, last = '';
  const push = row => { if (rows.length < limits.pageRows) rows.push(row); else dropped++; };
  const fail = (where, e) => { if (errors.length < 20) errors.push(where + ':' + String(e && e.name)); };
  const read = () => {
    const s = {};
    try { const w = window.kinViewerJobWorkspaceState ? window.kinViewerJobWorkspaceState() : null; s.busy = w ? w.busy : null; s.workspaceDirty = w ? w.dirty : null; } catch (e) { s.busy = s.workspaceDirty = 'error'; }
    try { const c = window.kinViewerJobCommand; s.commandBusy = c ? c.busy() : null; s.pendingKept = c ? c.pending() !== null : null; } catch (e) { s.commandBusy = s.pendingKept = 'error'; }
    try { s.marksDirty = window.kinMprMarks ? !!window.kinMprMarks.dirty() : null; } catch (e) { s.marksDirty = 'error'; }
    s.titleLength = title ? title.value.length : null;
    s.status = status ? String(status.textContent).slice(0, 160) : null;
    return s;
  };
  const sample = source => {
    try {
      const s = read(), key = JSON.stringify(s);
      if (source === 'tick' && key === last) return;
      last = key; push(Object.assign({ source, t: performance.now() }, s));
    } catch (e) { fail(source, e); }
  };
  const mutations = new MutationObserver(() => sample('status'));
  if (status) mutations.observe(status, { childList: true, characterData: true, subtree: true });
  const pointer = e => { try { push({ source: 'pointerdown', t: performance.now(), inPanel: !!(panel && panel.contains(e.target)) }); } catch (error) { fail('pointer', error); } };
  document.addEventListener('pointerdown', pointer, { capture: true, passive: true });
  const interval = setInterval(() => sample('tick'), limits.intervalMs);
  sample('start');
  window.__kinMarksReceiptObserver = { stop: () => {
    clearInterval(interval); mutations.disconnect(); document.removeEventListener('pointerdown', pointer, true); sample('stop');
    delete window.__kinMarksReceiptObserver;
    return { timeOrigin: performance.timeOrigin, found: { panel: !!panel, status: !!status, title: !!title }, rows, dropped, errors };
  } };
  return 'installed';
}'''
COLLECT = '() => window.__kinMarksReceiptObserver ? window.__kinMarksReceiptObserver.stop() : null'


def request_kind(url):
    """'me', 'viewer-jobs' or 'viewer-jobs/{id}[/name]' for the two watched API paths; None for every other URL."""
    try:
        path = urlsplit(str(url)).path
    except ValueError:
        return None
    if path == '/api/me':
        return 'me'
    match = VIEWER_JOBS.fullmatch(path)
    if not match:
        return None
    parts = [part for part in match.group(1).split('/') if part]
    return '/'.join(['viewer-jobs'] + ['{id}' if i == 0 else part if re.fullmatch(r'[a-z-]{1,20}', part) else '{x}'
                                       for i, part in enumerate(parts)])


def query_keys(url):
    try:
        return sorted({key for key, _ in parse_qsl(urlsplit(str(url)).query, keep_blank_values=True)})
    except ValueError:
        return ['<unparseable>']


class ReceiptObserver:
    def __init__(self, page):
        self.page, self.t0, self.wall0 = page, time.monotonic(), time.time()
        self.marks, self.requests, self.events, self.errors = [], [], [], []
        self.ordinals, self.early, self.ignored = {}, {}, set()
        self.dropped = {'requests': 0, 'events': 0, 'marks': 0, 'early': 0, 'errors': 0, 'ignored': 0}
        self.session, self.install, self.done = None, None, False
        try:
            self.session = page.context.new_cdp_session(page)
            for name in EVENTS:
                self.session.on('Network.' + name, self._handler(name))
            self.session.send('Network.enable')
        except Exception as error:
            self._error('cdp', error)
        try:
            self.install = page.evaluate(PAGE_OBSERVER, LIMITS)
        except Exception as error:
            self._error('page', error)
        self.mark('observer-ready')

    def _now(self):
        return round(time.monotonic() - self.t0, 4)

    def _error(self, where, error):
        try:
            if len(self.errors) < LIMITS['errors']:
                self.errors.append({'where': where, 'py': self._now(), 'error': type(error).__name__ + ': ' + str(error)[:200]})
            else:
                self.dropped['errors'] += 1
        except Exception:
            pass

    def mark(self, name):
        try:
            if len(self.marks) < LIMITS['marks']:
                self.marks.append({'name': name, 'py': self._now(), 'wall': round(time.time(), 4)})
            else:
                self.dropped['marks'] += 1
        except Exception as error:
            self._error('mark', error)

    def _handler(self, name):
        def handle(params):
            try:
                self._event(name, params or {})
            except Exception as error:
                self._error('event:' + name, error)
        return handle

    def _event(self, name, params):
        now, rid = self._now(), params.get('requestId')
        if name == 'requestWillBeSent' and rid not in self.ordinals:
            request = params.get('request') or {}
            kind = request_kind(request.get('url', ''))
            if kind is None:
                self.early.pop(rid, None)
                if len(self.ignored) < LIMITS['ignored']:
                    self.ignored.add(rid)
                else:
                    self.dropped['ignored'] += 1
                return
            if len(self.requests) >= LIMITS['requests']:
                self.dropped['requests'] += 1
                return
            self.ordinals[rid] = len(self.requests)
            self.requests.append({'n': len(self.requests), 'kind': kind, 'method': request.get('method'),
                                  'queryKeys': query_keys(request.get('url', '')), 'type': params.get('type'),
                                  'initiator': (params.get('initiator') or {}).get('type'), 'py': now,
                                  'timestamp': params.get('timestamp'), 'wallTime': params.get('wallTime'),
                                  'extraInfoBefore': self.early.pop(rid, None)})
            return
        n = self.ordinals.get(rid)
        if n is None:
            # ExtraInfo can precede requestWillBeSent; it is kept only for a request not yet known to be unwatched.
            if name.endswith('ExtraInfo') and rid is not None and rid not in self.ignored:
                if rid in self.early or len(self.early) < LIMITS['early']:
                    self.early.setdefault(rid, [])
                    if len(self.early[rid]) < 4:
                        self.early[rid].append({'ev': name, 'py': now})
                else:
                    self.dropped['early'] += 1
            return
        if len(self.events) >= LIMITS['events']:
            self.dropped['events'] += 1
            return
        row = {'n': n, 'ev': name, 'py': now}
        if 'timestamp' in params:
            row['timestamp'] = params['timestamp']
        if name == 'requestWillBeSent':
            row['redirect'] = 'redirectResponse' in params
        elif name == 'requestWillBeSentExtraInfo':
            row['requestTime'] = (params.get('connectTiming') or {}).get('requestTime')
        elif name == 'responseReceivedExtraInfo':
            row['statusCode'] = params.get('statusCode')
        elif name == 'responseReceived':
            response = params.get('response') or {}
            timing = response.get('timing') or {}
            row.update({'status': response.get('status'), 'protocol': response.get('protocol'),
                        'hasExtraInfo': params.get('hasExtraInfo'), 'fromServiceWorker': response.get('fromServiceWorker'),
                        'fromDiskCache': response.get('fromDiskCache'),
                        'timing': {key: timing[key] for key in TIMING if key in timing}})
        elif name == 'loadingFinished':
            row['encodedDataLength'] = params.get('encodedDataLength')
        elif name == 'loadingFailed':
            row.update({'errorText': params.get('errorText'), 'canceled': params.get('canceled'),
                        'blockedReason': params.get('blockedReason'), 'type': params.get('type')})
        self.events.append(row)

    def finish(self, test_id):
        if self.done:
            return
        self.done = True
        self.mark('finish')
        page = None
        try:
            page = self.page.evaluate(COLLECT)
        except Exception as error:
            self._error('collect', error)
        try:
            if self.session is not None:
                self.session.detach()
        except Exception as error:
            self._error('detach', error)
        record = {'schema': 'marks-receipt-diagnostic/1', 'test': test_id, 'install': self.install,
                  'clock': {'pyMonotonic0': self.t0, 'pyWall0': round(self.wall0, 4)}, 'limits': LIMITS,
                  'dropped': self.dropped, 'marks': self.marks, 'requests': self.requests, 'events': self.events,
                  'page': page, 'errors': self.errors}
        try:
            text = json.dumps(record, ensure_ascii=False, separators=(',', ':'), default=str)
        except Exception as error:
            text = json.dumps({'schema': 'marks-receipt-diagnostic/1', 'test': str(test_id),
                               'errors': [{'where': 'serialize', 'error': type(error).__name__}]})
        try:
            # unittest has already written 'test_name (...) ... ' without a newline when cleanups run.
            print('\n' + PREFIX + text, file=sys.stderr, flush=True)
        except Exception:
            pass
