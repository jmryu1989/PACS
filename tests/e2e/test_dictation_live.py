# coding: utf-8
"""TEST-S3-ASR-U4L-PATH and TEST-S3-ASR-U4L-GEO: the shipped dictation chain and pane on the real stack.

REQ-S3-ASR-FIRST-PATH
  -> RISK-S3-ASR-FALSE-CAPTURE / RISK-S3-ASR-FORMAT / RISK-S3-ASR-DENIAL-WRITE
  -> TEST-S3-ASR-U4L-PATH (test 01, G-LIVE-PATH) and TEST-S3-ASR-U4L-GEO (test 02, G-LIVE-GEO).
The delivered-header and pane-geometry risks have no ledger ID at this revision. Linking them is a
publication obligation (Astra decision 2026-09-23); this file claims no risk ID for them.

Two adjudication lines that are never merged: a GEO failure does not touch the PATH line, and a PATH pass
does not pass GEO. Every line is printed from `finally`, so an assertion failure keeps its observations:
`U4L-LAUNCH` once after the launch, `U4L-PATH` once, `U4L-GEO` once per planned pass (8, executed or not)
and `U4L-GEO-SUMMARY` once. Adjudicate from those lines first, then the unittest outcomes, then the exit code.

What is real: nginx, the BFF login, Orthanc serving main.html and the worklet, the Nest route with its raw
parser and WAV validator, the AuditLog, and Chromium's own file-backed fake microphone in the full pinned
Chromium (U4b amendment D1). The running API is the development-target build of the same api/src
(docker-compose.yml:121-124); production image parity is not claimed.

What is declared instead, each recorded with hashes:
  * one context route on GET /api/bootstrap (any query) that changes only `dictation.available` to true,
    because this stack has no engine and the Dictate button would otherwise never enable;
  * in test 02 only, after its real-503 passes, one route on that study's dictation POST answering a fixed
    200 review body, so the review state can be measured. Insert is never pressed;
  * the U4b observer init script (it records and delegates only) and one CDP session per case limited to
    the Log domain (amendment D2);
  * two NetLog switches on the capture launch only (Astra decision 2026-09-23): the browser's own network log,
    written to a private directory outside every uploaded path, read once in memory for P10's worklet limbs,
    reduced to an allowlisted extract and removed.
Every page-side read goes through PROBES; every state change is a real click or key press.

Not claimed: CSP enforcement (zero Log entries is not enforcement; U4b NC-11 is the only such proof), a
header-delivery verdict (G-CSP is Astra's conditional decision on the recorded observation), engine or model
availability, speech accuracy, physician acceptance, U5 or Stage 3 completion, and that full Chromium honours
the NetLog switches or negotiates HTTP/2 here (review B1/B2: only a hosted run shows it; failing to is a failure).
"""
import ast
import copy
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
import unittest
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from playwright.sync_api import expect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_worklist  # noqa: E402  (the live base: C-STORE fixture, BFF login and zero-row cleanup)
from report_dictation_capture_dom_test import (  # noqa: E402  (U4b-accepted helpers; read-only reuse)
    OBSERVER, launch_args, parse_launch, launch_problems, CHANNEL, FULL_CHROMIUM_SUFFIX, FORBIDDEN_LAUNCH_FLAGS,
    log_entry, csp_log_verdict, UNCHANGED, BROWSER_VERSION)
import dictation_capture_signal as signal  # noqa: E402
import measurement_ci  # noqa: E402  (its sanitize() is the one CI redaction rule)

ROOT = Path(__file__).resolve().parents[2]
MAIN_PATH = '/worklist/hpacs-lite/main.html'
WORKLET_PATH = '/worklist/hpacs-lite/dictation-worklet.js'
DICTATION_PATH = '/api/studies/%s/dictation'
ARTIFACTS = Path(os.environ.get('KIN_U4L_ARTIFACTS', ROOT / 'tests/e2e/artifacts/measurement-ci/dictation-live'))
RFIELDS = ('findings', 'conclusion', 'recommendation')
REPORT_TABLES = ('Report', 'ReportDraft', 'ReportVersion')
CAPABILITY_KEYS = {'available', 'maxBytes', 'timeoutMs', 'languagePin', 'enginePin', 'modelPin'}
MAX_BYTES = 1048576                  # the code ceiling an unconfigured stack reports (asr.service.ts:18,27)
MAX_FRAMES = (MAX_BYTES - 44) // 2   # 524266: the node cap dictation-capture.js derives from maxBytes
WAIT_SECONDS = 20                    # every wait, as the page default (test_worklist.py:166)
WAIT_MS = WAIT_SECONDS * 1000
FRAME_SECONDS = 30                   # the one longer wait: the embedded viewer's first load (readiness §5)
PANE_NOT_CONFIGURED = '음성 인식기가 연결되지 않았습니다. — 판독문은 그대로입니다'   # dictation.js:55 + :28
ACTIVE_STATES = ('requesting-permission', 'recording', 'uploading', 'review')        # dictation-session.js:9
TERMINAL_STATES = ('failed', 'cancelled', 'unavailable', 'inserted')
ENVIRONMENT_TRUE = ('secure', 'gumIsWrapper', 'gumNative', 'contextObserved', 'nodeObserved', 'contextTarget',
                    'nodeTarget', 'fetchIsNative')
# Header evidence is an allowlist: no credential header name or value is ever written anywhere.
RESPONSE_HEADERS = ('content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy',
                    'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
                    'cross-origin-resource-policy', 'cache-control')
REQUEST_HEADERS = ('content-type', 'x-kin-csrf', 'content-length', 'origin', 'sec-fetch-dest', 'sec-fetch-mode',
                   'sec-fetch-site')
GCSP_HEADERS = ('content-security-policy', 'x-content-type-options', 'referrer-policy')
# Headers that describe the real body's bytes. A replaced body keeps every other real header, and the pinned
# client recomputes content-length when it is absent (playwright/_impl/_network.py:455-456).
BODY_BOUND_HEADERS = ('content-length', 'content-encoding', 'transfer-encoding', 'etag')
VIEWPORTS = ((1680, 1100), (1366, 768))
LAYOUTS = ('plain', 'reading')
GEO_CONTROLS = {'recording': ('dictation-stop', 'dictation-cancel'), 'failed': ('dictation-close',),
                'review': ('dictation-insert', 'dictation-cancel')}
GEO_HIT_IDS = ('b-dictate', 'dictation-status', 'dictation-stop', 'dictation-cancel', 'dictation-insert',
               'dictation-close', 'dictation-repin', 'b-copy', 'm-reading', 'reading-findings-open')

# ── P10 through the browser's own NetLog (Astra decision 2026-09-23, review F1-F5). The proof object is the
# original one: the worklet response the browser itself received, status 200, COOP same-origin, COEP
# require-corp. Playwright never reported that response (attempt 1, A-R), so it is read from the network
# stack's log over HTTP/2; whatever cannot be bound to exactly one exchange is an INSTRUMENTATION failure.
NETLOG_SECONDS = 120            # --net-log-duration: the network service stops, flushes and closes the log
NETLOG_DEADLINE_SECONDS = 140   # completion is waited for from the pre-launch clock, never longer
NETLOG_WINDOW_SECONDS = 115     # test 01's browser traffic ends within this; the logged POST decides (review N1)
NETLOG_POLL_SECONDS = 0.25
NETLOG_MAX_BYTES = 64 * 1024 * 1024   # bounds the one strict parse; login plus one capture is far below it
# F1: the only place these three switches are named. Absent capture mode is Default, absent size limit is one
# unstitched file, and no TLS key log; the launch oracle requires zero of each on both launch lines.
NETLOG_FORBIDDEN_FLAGS = ('--net-log-capture-mode', '--net-log-max-size-mb', '--ssl-key-log-file')
NETLOG_SWITCHES = ('--log-net-log', '--net-log-duration') + NETLOG_FORBIDDEN_FLAGS
NETLOG_SEND, NETLOG_RECV, NETLOG_SESSION = 'HTTP2_SESSION_SEND_HEADERS', 'HTTP2_SESSION_RECV_HEADERS', 'HTTP2_SESSION'
# F3: recorded guards, verbatim at the tag (network_service_instance_impl.cc:702-703, 759). A present line fails;
# an absent one proves nothing, since browser stderr reaching the pw:browser log is not guaranteed. The protection
# is completeness plus exactly one worklet exchange plus the PATH POST logged after it: a truncating restart
# cannot leave a complete file that still holds both in order.
NETLOG_GUARDS = (('NETLOG-OPEN', 'Failed opening NetLog: '),
                 ('NETLOG-RESTART', 'Network service crashed or was terminated, restarting service.'))
NETLOG_REQUEST_VALUES = (':method', ':scheme', ':authority', ':path', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site')
NETLOG_CLASSES = ('NETLOG-INCOMPLETE', 'NETLOG-SCHEMA', 'NETLOG-MODE', 'NETLOG-NOT-H2', 'NETLOG-NO-STREAM',
                  'NETLOG-AMBIGUOUS', 'NETLOG-NO-RESPONSE', 'NETLOG-ORDER', 'NETLOG-WINDOW', 'NETLOG-OPEN',
                  'NETLOG-RESTART', 'NETLOG-LEAK', 'NETLOG-ERROR')
NETLOG_EXTRACT = 'p10-netlog.json'
HEADER_NAME = re.compile(r':?[a-z0-9][a-z0-9-]*')   # a logged name kept in the extract can carry no value

ASR_SOURCE = (ROOT / 'api' / 'src' / 'asr.service.ts').read_text(encoding='utf-8')


def source_pin(name):
    """A configured label read from api/src, never retyped (asr.service.ts:5-6)."""
    found = re.findall(r"export const %s = '([^']+)';" % name, ASR_SOURCE)
    return found[0] if len(found) == 1 else None


ASR_ENGINE_PIN, ASR_MODEL_PIN = source_pin('ASR_ENGINE_PIN'), source_pin('ASR_MODEL_PIN')
TEMPLATE_CSP = re.findall(r'add_header Content-Security-Policy "([^"]*)" always;',
                          (ROOT / 'proxy' / 'nginx.conf.template').read_text(encoding='utf-8'))
# Sized to reach the pane's max-height cap (main.html:266), the worst case for the pane geometry.
REVIEW_TEXT = '\n'.join('U4L geometry review line %02d — 합성 검토 문장' % n for n in range(1, 13))
REVIEW_BODY = json.dumps({'text': REVIEW_TEXT, 'seconds': 1.0, 'languagePin': 'auto', 'enginePin': ASR_ENGINE_PIN,
                          'modelPin': ASR_MODEL_PIN}, ensure_ascii=False)

# ── Page-side reads. Nothing here calls a product mutator or names a media/network API (static pin in
# execution_selection_test.py); state changes are real clicks and key presses only. One declared exception, and it is
# not a state change the report or the dictation run can see: TOGGLE_REACH below scrolls the Image Findings toggle
# into view once per phase-B review, when it is out of view, and puts every scroll offset back before it returns
# (Astra B2 amendment, 2026-09-24). GEOMETRY itself never scrolls.
GEOMETRY = """() => {
  const q = s => document.querySelector(s);
  // One rounding of each edge; comparisons use `b`, never y+h rounded twice (R15-ENTRY precedent).
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }; };
  const name = el => el ? (el.id || String(el.className || '') || el.tagName.toLowerCase()) : null;
  // `present` travels with `own`, so "covered" and "absent" are never confused (a 0x0 control hit-tests the corner).
  const seen = el => { if (!el) return { present: false, own: false, topId: 'missing' };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { present: false, own: false, topId: 'zero-rect' };
    const top = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { present: true, own: !!top && el.contains(top), topId: name(top) }; };
  const minHeight = el => { if (!el) return null; const raw = getComputedStyle(el).minHeight, px = parseFloat(raw);
    return { raw, px: Number.isFinite(px) ? px : null }; };
  const whole = el => { if (!el) return false; const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; };
  const drawer = q('#reading-findings'), toggle = q('#reading-findings-open'), pane = q('#dictation-pane'), findings = q('#findings'), right = q('.right');
  const fields = {};
  for (const id of ['findings', 'conclusion', 'recommendation']) fields[id] = { box: box(q('#' + id)), min: minHeight(q('#' + id)) };
  let probe = null;
  if (findings) {
    const r = findings.getBoundingClientRect(), x = Math.round(r.x + 8), y = Math.round(r.y + 8);
    const top = document.elementFromPoint(x, y);
    probe = { x, y, own: !!top && findings.contains(top), topId: name(top) };
  }
  const controls = {};
  for (const id of %s) {
    const el = q('#' + id);
    controls[id] = Object.assign({ rect: box(el), hidden: el ? !!el.hidden : null, disabled: el ? !!el.disabled : null }, seen(el));
  }
  // G8 (D2): the transcript's own text box, record only, plus the facts G8 asserts - rendered lines lying whole
  // (vertically) inside what the reader can see of its scrollport, and whether the first of them is uncovered.
  const t = q('#dictation-text');
  let transcript = null;
  if (t && !t.hidden) {
    const n = v => parseFloat(v) || 0;
    const inset = (el, cs) => { const r = el.getBoundingClientRect();
      return { top: r.top + n(cs.borderTopWidth), bottom: r.bottom - n(cs.borderBottomWidth) }; };
    const cs = getComputedStyle(t), port = inset(t, cs);
    // B-1: the port as far as the viewport and every clipping ancestor (overflow not visible) let it be seen.
    const clip = { top: Math.max(port.top, 0), bottom: Math.min(port.bottom, innerHeight) };
    for (let a = t.parentElement; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
      const r = inset(a, as);
      clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom);
    }
    const range = document.createRange(); range.selectNodeContents(t);
    const lines = Array.from(range.getClientRects()).filter(x => x.width > 0 && x.height > 0);
    const LU = 1 / 64;  // one Blink layout unit: float noise only, never a fit allowance
    // Vertical edges only: pre-wrap lets trailing spaces hang past the content edge, so a right edge proves nothing.
    const readable = lines.filter(x => x.top >= clip.top - LU && x.bottom <= clip.bottom + LU), first = readable[0];
    const hit = first ? document.elementFromPoint(Math.round(first.left + Math.min(first.width, 8) / 2),
                                                  Math.round((first.top + first.bottom) / 2)) : null;
    transcript = { box: box(t), boxSizing: cs.boxSizing, fontSize: cs.fontSize, lineHeight: cs.lineHeight, minHeight: cs.minHeight,
      padding: [n(cs.paddingTop), n(cs.paddingBottom)], border: [n(cs.borderTopWidth), n(cs.borderBottomWidth)],
      contentHeight: port.bottom - port.top - n(cs.paddingTop) - n(cs.paddingBottom),
      clientHeight: t.clientHeight, scrollHeight: t.scrollHeight, scrollTop: t.scrollTop, overflowY: cs.overflowY, tabIndex: t.tabIndex,
      port, clip, lines: lines.length, readable: readable.length,
      firstReadable: first ? { top: first.top, bottom: first.bottom } : null, firstReadableOwn: !!hit && t.contains(hit) };
  }
  return { viewport: { w: innerWidth, h: innerHeight }, reading: document.body.classList.contains('reading'),
    rightScrollTop: right ? right.scrollTop : null, menubar: box(q('.menubar')), rbtns: box(q('.report-p .rbtns')),
    pane: box(pane), paneHidden: pane ? !!pane.hidden : null,
    redit: box(q('.report-p .redit')), reditMin: minHeight(q('.report-p .redit')), fields,
    rfoot: box(q('.report-p .rfoot2')), rfootInside: whole(q('.report-p .rfoot2')),
    drawer: box(drawer), drawerShown: !!drawer && !drawer.hidden,
    drawerExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
    drawerTop: drawer ? drawer.style.getPropertyValue('--reading-findings-top') : null,
    findingsProbe: probe, status: q('#dictation-status') ? q('#dictation-status').textContent : null, controls, transcript };
}""" % json.dumps(list(GEO_HIT_IDS))
# Astra B2 amendment (2026-09-24, after CI2): the reopen half of review G3. The toggle must be operable and either
# whole (both axes, inside the viewport and every border-inset clipping ancestor) and owning its centre where it is,
# or - when an ancestor has moved it out of view, as the review focus scroll does at 1366x768 reading - the same once
# brought into view instantly and nearest, with every ancestor/document offset saved first and put back in `finally`
# (each restore attempted even if another throws) and then verified. Rest is always recorded; the reveal runs only
# when rest is not whole. An exception becomes `error` in the record, never a lost pass. No focus, click or product
# call: scrollIntoView does not move focus. Evaluated once per phase-B pass, after the review geometry read (static
# pins in execution_selection_test.py).
TOGGLE_REACH = """() => {
  const tg = document.querySelector('#reading-findings-open');
  if (!tg) return { missing: true };
  const name = el => el ? (el.id || String(el.className || '') || el.tagName.toLowerCase()) : null;
  const n = v => parseFloat(v) || 0, LU = 1 / 64, userScroll = v => v === 'auto' || v === 'scroll';
  const place = () => {
    const r = tg.getBoundingClientRect(), by = [];
    let top = 0, bottom = innerHeight, left = 0, right = innerWidth;
    for (let a = tg.parentElement; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      const t = b.top + n(as.borderTopWidth), u = b.bottom - n(as.borderBottomWidth);
      const l = b.left + n(as.borderLeftWidth), w = b.right - n(as.borderRightWidth);
      if (r.top < t - LU || r.bottom > u + LU || r.left < l - LU || r.right > w + LU)
        by.push({ name: name(a), overflowX: as.overflowX, overflowY: as.overflowY });
      top = Math.max(top, t); bottom = Math.min(bottom, u); left = Math.max(left, l); right = Math.min(right, w);
    }
    const present = r.width > 0 && r.height > 0;
    const hit = present ? document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)) : null;
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, clip: { top, bottom, left, right }, by, present,
      whole: present && r.top >= top - LU && r.bottom <= bottom + LU && r.left >= left - LU && r.right <= right + LU,
      own: !!hit && tg.contains(hit), topId: name(hit) };
  };
  const out = { rest: null, disabled: !!tg.disabled, inert: !!tg.closest('[inert]'), tabIndex: tg.tabIndex,
                revealed: null, moved: null, restored: null, error: null };
  const saved = [];
  try {
    out.rest = place();
    if (!out.rest.whole) {
      for (let a = tg.parentElement; a; a = a.parentElement) saved.push([a, a.scrollTop, a.scrollLeft]);
      const root = document.scrollingElement;
      if (root && !saved.some(([a]) => a === root)) saved.push([root, root.scrollTop, root.scrollLeft]);
      tg.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      out.revealed = place();
      out.moved = saved.filter(([a, y, x]) => a.scrollTop !== y || a.scrollLeft !== x).map(([a, y, x]) => {
        const as = getComputedStyle(a);
        return { name: name(a), userScrollable: (a.scrollTop === y || userScroll(as.overflowY)) &&
                                                (a.scrollLeft === x || userScroll(as.overflowX)) }; });
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    const failed = [];
    for (const [a, y, x] of saved) {
      try { a.scrollTo({ top: y, left: x, behavior: 'instant' }); } catch (e) { failed.push(name(a) + ': ' + String((e && e.message) || e)); }
    }
    if (saved.length) out.restored = !failed.length && saved.every(([a, y, x]) => a.scrollTop === y && a.scrollLeft === x);
    if (failed.length) out.error = (out.error ? out.error + '; ' : '') + 'restore: ' + failed.join('; ');
  }
  return out;
}"""
PROBES = {
    'environment': "() => __u4b.environment()",
    'permission': "() => __u4b.permission()",
    'media': "() => __u4b.media()",
    'clicks': "() => __u4b.clicks()",
    'activation': "() => __u4b.activation()",
    'tracks': "() => __u4b.trackStates()",
    # Per node index: one page records several runs in test 02, so node 0 is not this run's node.
    'recorded_since': "([index, ms]) => { const t = __u4b.nodeTime(index); return t !== null && performance.now() - t >= ms; }",
    'contexts_closed': "() => { const m = __u4b.media(); return m.contexts.length > 0 && "
                       "m.contexts.every(c => c.state === 'closed'); }",
    'session': "() => { const s = dictation.snapshot(); return { state: s.state, error: s.error, asrSeq: s.asrSeq, "
               "pending: s.pending, needsRepin: s.needsRepin, cleanupFailed: s.cleanupFailed }; }",
    'strings': "() => ({ ready: KinDictation.TITLES.ready, reasons: KinDictation.REASONS, review: KinDictation.STATUS.review })",
    'pane': """() => { const q = s => document.querySelector(s);
  const c = id => { const el = q('#dictation-' + id); return el ? { hidden: !!el.hidden, disabled: !!el.disabled } : null; };
  const b = q('#b-dictate');
  return { hidden: !!q('#dictation-pane').hidden, status: q('#dictation-status').textContent,
    text: q('#dictation-text').textContent, meta: q('#dictation-meta').textContent,
    controls: { stop: c('stop'), cancel: c('cancel'), repin: c('repin'), insert: c('insert'), close: c('close') },
    button: b ? { disabled: !!b.disabled, title: b.getAttribute('title') } : null,
    focused: document.activeElement ? document.activeElement.id : null }; }""",
    'pane_hidden': "() => !!document.querySelector('#dictation-pane').hidden",
    'reading': "() => document.body.classList.contains('reading')",
    'plain': "() => !document.body.classList.contains('reading')",
    'frame': "() => { const f = document.querySelector('#reading-frame'); "
             "return f ? { present: true, inert: !!f.inert, hidden: !!f.hidden } : { present: false }; }",
    'drawer': "() => { const d = document.querySelector('#reading-findings'); "
              "return d ? { hidden: !!d.hidden, state: d.dataset.state || null, study: d.dataset.studyUid || null } : null; }",
    'geometry': GEOMETRY,
    'toggle_reach': TOGGLE_REACH,
    'frames2': "() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
}


# ── Pure oracles. They decide nothing at runtime that the readiness did not fix, and oracle_self_check()
# drives each one through the failure shapes it must reject.
def bootstrap_request(url):
    """The one declared replacement (R4): path equality with any query, so every bootstrap caller gets it."""
    return urlsplit(url).path == '/api/bootstrap'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def short(error):
    text = str(error)
    return (text.splitlines()[0] if text else type(error).__name__)[:300]


def allowlisted(headers, names):
    lowered = {str(key).lower(): value for key, value in (headers or {}).items()}
    return {name: lowered[name] for name in names if name in lowered}


def differing_paths(a, b, prefix=''):
    """JSON paths where two parsed documents differ; type counts (true is not 1)."""
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b), key=str):
            path = '%s.%s' % (prefix, key) if prefix else str(key)
            out += [path] if key not in a or key not in b else differing_paths(a[key], b[key], path)
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [prefix or '$']
        out = []
        for index, (x, y) in enumerate(zip(a, b)):
            out += differing_paths(x, y, '%s[%d]' % (prefix, index))
        return out
    return [] if type(a) is type(b) and a == b else [prefix or '$']


def capability_problems(real):
    """P1: the REAL bootstrap capability of a stack without KIN_ASR_* (asr.service.ts:17-28, pacs.service.ts:796)."""
    if not isinstance(real, dict) or set(real) != CAPABILITY_KEYS:
        return ['capability keys %r' % (sorted(real) if isinstance(real, dict) else real)]
    expected = {'available': False, 'maxBytes': MAX_BYTES, 'timeoutMs': 120000, 'languagePin': 'auto',
                'enginePin': ASR_ENGINE_PIN, 'modelPin': ASR_MODEL_PIN}
    return ['%s %r != %r' % (key, real[key], value) for key, value in expected.items()
            if value is None or type(real[key]) is not type(value) or real[key] != value]


def launch_verdict(text, fixture_path, capture_version, netlog_path):
    """P0 (amendment D1, review N-1): one record per `<launching>` line, so the capture browser is judged on its
    own line and the base browser on its own - never the first line for both. The capture line is the one that
    carries the fixture argument, not the second one by position. The NetLog delta: every token is named up to
    its first '='; the capture line carries exactly one '--log-net-log=<private path>' and one
    '--net-log-duration=NETLOG_SECONDS', the base line none of the five NetLog switches, and no line a forbidden
    one (review F1, F4)."""
    rows = [row for row in (text or '').splitlines() if '<launching> ' in row]
    fixture_arg = '--use-file-for-fake-audio-capture=%s' % fixture_path
    netlog_args = {'--log-net-log': ['--log-net-log=%s' % netlog_path],
                   '--net-log-duration': ['--net-log-duration=%d' % NETLOG_SECONDS]}
    records, problems = [], []
    for index, row in enumerate(rows):
        parsed = parse_launch(row)
        judged = launch_problems(parsed)
        command = row.split('<launching> ', 1)[1].split(' ')
        records.append({'index': index, 'executable': parsed['executable'], 'flags': parsed['flags'],
                        'chrome_headless_shell': parsed['chrome_headless_shell'], 'capture': fixture_arg in command[1:],
                        'binary': judged['binary'], 'forbidden': judged['forbidden'],
                        'forbidden_text': [flag for flag in FORBIDDEN_LAUNCH_FLAGS if flag in row],
                        'netlog': {name: [arg for arg in command[1:] if arg.split('=', 1)[0] == name]
                                   for name in NETLOG_SWITCHES},
                        'netlog_forbidden_text': [flag for flag in NETLOG_FORBIDDEN_FLAGS if flag in row]})
    if len(rows) != 2:
        problems.append('expected exactly 2 <launching> lines (base, capture), found %d' % len(rows))
    captures = [record for record in records if record['capture']]
    if len(captures) != 1:
        problems.append('expected exactly 1 launch carrying %s, found %d' % (fixture_arg, len(captures)))
    for record in records:
        for problem in record['binary']:
            problems.append('launch %d: %s' % (record['index'], problem))
        if record['forbidden'] or record['forbidden_text']:
            problems.append('launch %d carries %r' % (record['index'], record['forbidden'] or record['forbidden_text']))
        refused = [arg for name in (NETLOG_FORBIDDEN_FLAGS if record['capture'] else NETLOG_SWITCHES)
                   for arg in record['netlog'][name]]
        if refused or record['netlog_forbidden_text']:
            problems.append('launch %d carries NetLog switches it must not: %r'
                            % (record['index'], refused or record['netlog_forbidden_text']))
    if len(captures) == 1:
        capture = captures[0]
        for flag in ('--headless', '--use-fake-device-for-media-stream', '--disable-audio-output'):
            if not capture['flags'].get(flag):
                problems.append('the capture launch lacks %s' % flag)
        if capture['chrome_headless_shell'] or not (capture['executable'] or '').endswith(FULL_CHROMIUM_SUFFIX):
            problems.append('the capture launch is not the full pinned Chromium: %s' % capture['executable'])
        for name, expected in netlog_args.items():
            if capture['netlog'][name] != expected:
                problems.append('the capture launch NetLog switch %s is %r, not exactly %r'
                                % (name, capture['netlog'][name], expected))
    if capture_version != BROWSER_VERSION:
        problems.append('capture browser version %r != %r' % (capture_version, BROWSER_VERSION))
    return {'records': records, 'problems': problems}


def u5_problems(t0, t1, frames):
    """U5: the produced duration against the recorded interval, node construction to the Stop press."""
    if t0 is None or t1 is None or frames is None:
        return ['U5 inputs missing: t0=%r t1=%r frames=%r' % (t0, t1, frames)]
    elapsed, seconds = (t1 - t0) / 1000, frames / 16000
    return [] if 0.6 * elapsed <= seconds <= elapsed + 1.0 else \
        ['%.3f s of audio for %.3f s between node and Stop' % (seconds, elapsed)]


def audit_problems(before, after, body_len, frames):
    """P9: exactly one new dictation.request row whose detail binds the wire body and the validator's frames.
    `seconds` is compared exactly: both sides divide the same integer by 16000 in IEEE doubles and JSON keeps
    the shortest round-trip form (dictation-audio.ts:51-54, pacs.service.ts:90)."""
    problems = []
    new = after[len(before):] if len(after) >= len(before) else []
    if len(after) != len(before) + 1:
        problems.append('expected exactly one new dictation.request row, found %d' % (len(after) - len(before)))
    if len(new) != 1:
        return problems
    detail = new[0].get('detail')
    if not isinstance(detail, dict):
        return problems + ['detail is not a JSON object: %r' % new[0].get('raw')]
    bytes_, seconds, ms = detail.get('bytes'), detail.get('seconds'), detail.get('ms')
    if body_len is None or type(bytes_) is not int or bytes_ != body_len:
        problems.append('bytes %r != wire body %r' % (bytes_, body_len))
    if frames is None or isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds != frames / 16000:
        problems.append('seconds %r != frames/16000 %r' % (seconds, None if frames is None else frames / 16000))
    if detail.get('outcome') != 'DICTATION_NOT_CONFIGURED':
        problems.append('outcome %r' % detail.get('outcome'))
    if ASR_ENGINE_PIN is None or detail.get('engine') != ASR_ENGINE_PIN:
        problems.append('engine %r' % detail.get('engine'))
    if type(ms) is not int or ms < 0:
        problems.append('ms %r' % ms)
    return problems


def forbidden_writes(requests, uid):
    """P8/G7: the report writes the dictation path must never cause (main.html:4579-4597, 4677, 3471)."""
    targets = {('PUT', '/api/studies/%s/report' % uid), ('POST', '/api/studies/%s/report/commit' % uid),
               ('DELETE', '/api/studies/%s/draft' % uid)}
    return ['%s %s' % (entry['method'], entry['path']) for entry in requests if (entry['method'], entry['path']) in targets]


def gcsp_input(main, worklet, post):
    """Recorded only: the readiness §8 table applied to the observed header sets. It is the input to Astra's
    separate G-CSP decision, never a U4L limb. HSTS is excluded: outside production hsts.conf is empty."""
    if main is None or worklet is None or post is None:
        return 'unobserved'
    carried = lambda headers: {name for name in GCSP_HEADERS if name in headers}
    if not carried(main) and not carried(worklet) and not carried(post):
        return 'not-delivered'
    if carried(post) - carried(main) or carried(post) - carried(worklet):
        return 'location-override'
    return 'no-trigger'


def u4l_launch_args(fixture_path, netlog_path):
    """The U4b capture flags plus the two accepted NetLog switches and nothing else. The browser opens the path
    itself (network_service_instance_impl.cc:745-767) and NETLOG_SECONDS later stops, flushes and closes it while
    it keeps running (network_service.cc:683-709), so completion never waits on Browser.close."""
    return launch_args(fixture_path) + ['--log-net-log=%s' % netlog_path, '--net-log-duration=%d' % NETLOG_SECONDS]


def netlog_root():
    """R1: the runner's own temporary directory, discarded with the hosted runner and never uploaded (validate.yml
    uploads tests/e2e/artifacts/measurement-ci/ and tmp/workspace-ui-ci/ only). Read at launch, not at import."""
    return Path(os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()) / 'u4l-netlog'


def netlog_forbidden_roots():
    """F4: the uploaded artifact directory wherever KIN_U4L_ARTIFACTS put it, the uploaded tree, and tmp."""
    return ARTIFACTS.resolve(), (ROOT / 'tests/e2e/artifacts').resolve(), (ROOT / 'tmp').resolve()


def netlog_path_problems(path, roots):
    """F4, before launch: the launch oracle splits Playwright's line on spaces and each token at its first '=',
    so the path carries no whitespace, '=' or quote; and it lies outside every root that is uploaded or kept."""
    problems = []
    if re.search(r'[\s=\'"]', str(path)):
        problems.append('whitespace, "=" or a quote in the NetLog path')
    if not path.is_absolute():
        problems.append('the NetLog path is not absolute')
    return problems + ['the NetLog path is inside %s' % root for root in roots if path == root or root in path.parents]


def proxy_authority(proxy):
    """N2: the ':authority' the browser sends for the configured proxy, from its netloc, default port elided."""
    split = urlsplit(proxy)
    netloc, default = split.netloc.lower(), {'https': ':443', 'http': ':80'}.get(split.scheme)
    return netloc[:-len(default)] if default and netloc.endswith(default) else netloc


class NetlogSchema(Exception):
    """A whole log the strict parser refuses (a duplicate key, NaN or Infinity): complete, but not evidence."""


def _netlog_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise NetlogSchema('duplicate key')
        value[key] = item
    return value


def _netlog_constant(name):
    raise NetlogSchema('non-finite number')


def netlog_load(data, limit=NETLOG_MAX_BYTES):
    """Strict whole-file JSON: (document, None) or (None, class). Not parseable is NETLOG-INCOMPLETE, because the
    writer ends every event with ',\\n' and only its Stop writes ']' and '}' (file_net_log_observer.cc:667-668,
    756-781); parseable only by tolerating a duplicate key or a non-finite number, or over the bound, is
    NETLOG-SCHEMA."""
    if data is None:
        return None, 'NETLOG-INCOMPLETE'
    if len(data) > limit:
        return None, 'NETLOG-SCHEMA'
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=_netlog_object, parse_constant=_netlog_constant), None
    except (NetlogSchema, RecursionError):
        return None, 'NETLOG-SCHEMA'
    except ValueError:     # JSONDecodeError and UnicodeDecodeError: not a whole document (yet)
        return None, 'NETLOG-INCOMPLETE'


def wait_netlog(source, t0, limit=NETLOG_MAX_BYTES, clock=time.monotonic, sleep=time.sleep):
    """Q3/B4: nothing is read before t0 + NETLOG_SECONDS; then the whole file is read again every
    NETLOG_POLL_SECONDS until it parses strictly, and never after t0 + NETLOG_DEADLINE_SECONDS. Only the strict
    parse means complete - the writer flushes in batches (file_net_log_observer.cc:443), so an unchanged size
    means nothing. The bytes read are the snapshot judged; a later truncating restart cannot change them."""
    reads, data = 0, None
    while True:
        now = clock()
        if now < t0 + NETLOG_SECONDS:
            sleep(t0 + NETLOG_SECONDS - now)
            continue
        try:
            data = source.read_bytes()
        except FileNotFoundError:
            data = None
        reads += 1
        # The closing brace is necessary for a whole object, so a log still being written is never parsed in full.
        complete = data is not None and data[-64:].rstrip().endswith(b'}')
        loaded = netlog_load(data, limit) if complete else (None, 'NETLOG-INCOMPLETE')
        now = clock()
        if loaded[1] != 'NETLOG-INCOMPLETE' or now >= t0 + NETLOG_DEADLINE_SECONDS:
            return {'data': data, 'loaded': loaded, 'reads': reads, 'at_s': round(now - t0, 3)}
        sleep(min(NETLOG_POLL_SECONDS, t0 + NETLOG_DEADLINE_SECONDS - now))


def _netlog_headers(lines):
    """spdy_log_util.cc:27-35: one 'name: value' string per header, duplicates kept. Returns (lowercase name ->
    values in order, names in order), or None when any line is not of that shape."""
    if not isinstance(lines, list):
        return None
    values, names = {}, []
    for line in lines:
        if not isinstance(line, str) or ': ' not in line or line.startswith(': '):
            return None
        name, value = line.split(': ', 1)
        values.setdefault(name.lower(), []).append(value)
        names.append(name.lower())
    return values, names


def _netlog_mentions(value, needle):
    if isinstance(value, str):
        return needle in value
    if isinstance(value, dict):
        return any(_netlog_mentions(item, needle) for item in value.values())
    return isinstance(value, list) and any(_netlog_mentions(item, needle) for item in value)


def _netlog_response(values):
    return {name: values[name] for name in (':status',) + RESPONSE_HEADERS if name in values}


def netlog_bind(doc, uid, authority):
    """Schema, mode and the one worklet exchange (review B3/B5). An exchange is (HTTP2_SESSION source id, stream
    id): exactly one request block with exactly one each of :method GET, :scheme https, the proxy :authority and
    the exact worklet :path - any other request block for that path, under any method, query or origin, makes it
    ambiguous - and exactly one response block on the same key, after it. The PATH POST logged once after it is
    what shows the log's window covered this capture. Type ids come from the file's own constants."""
    out = {'classes': [], 'details': {}, 'mode': None, 'events': None, 'counts': {}, 'send': None, 'recv': None,
           'post': None, 'main': []}

    def fail(name, why):
        out['classes'].append(name)
        out['details'][name] = why
        return out
    if not isinstance(doc, dict) or set(doc) not in ({'constants', 'events'}, {'constants', 'events', 'polledData'}):
        return fail('NETLOG-SCHEMA', 'the top-level keys are not constants, events and optionally polledData')
    constants, events = doc['constants'], doc['events']
    if not isinstance(constants, dict) or not isinstance(events, list):
        return fail('NETLOG-SCHEMA', 'constants is not an object or events is not a list')
    out['events'], mode = len(events), constants.get('logCaptureMode')
    if not isinstance(mode, str):
        return fail('NETLOG-SCHEMA', 'constants.logCaptureMode is absent')
    out['mode'] = mode if re.fullmatch(r'[A-Za-z]{1,32}', mode) else '<not a mode name>'
    if mode != 'Default':
        return fail('NETLOG-MODE', 'the log was not captured in Default mode')
    ids = {}
    for table, name in (('logEventTypes', NETLOG_SEND), ('logEventTypes', NETLOG_RECV), ('logSourceType', NETLOG_SESSION)):
        mapping = constants.get(table)
        value = mapping.get(name) if isinstance(mapping, dict) else None
        if type(value) is not int or sum(1 for other in mapping.values() if type(other) is int and other == value) != 1:
            return fail('NETLOG-SCHEMA', 'constants.%s.%s is absent or shares its id' % (table, name))
        ids[name] = value
    kinds, sends, recvs = {}, [], []
    for index, event in enumerate(events):
        source = event.get('source') if isinstance(event, dict) else None
        if not isinstance(source, dict) or type(event.get('type')) is not int or type(event.get('phase')) is not int or \
                type(source.get('id')) is not int or type(source.get('type')) is not int or \
                not isinstance(event.get('params', {}), dict):
            return fail('NETLOG-SCHEMA', 'event %d is not {type, phase, source {id, type}, params}' % index)
        if kinds.setdefault(source['id'], source['type']) != source['type']:
            return fail('NETLOG-SCHEMA', 'source %d appears under two source types' % source['id'])
        if event['type'] not in (ids[NETLOG_SEND], ids[NETLOG_RECV]):
            continue
        params = event.get('params', {})
        parsed = _netlog_headers(params.get('headers'))
        if source['type'] != ids[NETLOG_SESSION] or parsed is None or type(params.get('stream_id')) is not int or \
                type(params.get('fin')) is not bool:
            return fail('NETLOG-SCHEMA', 'event %d is not an HTTP/2 header block of an HTTP2_SESSION source' % index)
        (sends if event['type'] == ids[NETLOG_SEND] else recvs).append(
            {'index': index, 'key': (source['id'], params['stream_id']), 'values': parsed[0], 'names': parsed[1],
             'event': event})
    if len({send['key'] for send in sends}) != len(sends):
        return fail('NETLOG-SCHEMA', 'two request blocks on one session stream')

    def exact(send, method, path):
        values = send['values']
        return values.get(':method') == [method] and values.get(':scheme') == ['https'] and \
            values.get(':authority') == [authority] and values.get(':path') == [path]
    for main in [send for send in sends if exact(send, 'GET', MAIN_PATH)]:
        answers = [recv for recv in recvs if recv['key'] == main['key']]    # recorded calibration only
        out['main'].append({'stream': main['key'][1], 'response_blocks': len(answers),
                            'response': _netlog_response(answers[0]['values']) if len(answers) == 1 else None})
    found = [send for send in sends if exact(send, 'GET', WORKLET_PATH)]
    near = [send for send in sends if send['index'] not in {one['index'] for one in found} and
            any(path.startswith(WORKLET_PATH) for path in send['values'].get(':path', []))]
    out['counts'] = {'request_blocks': len(sends), 'response_blocks': len(recvs), 'worklet_exact_gets': len(found),
                     'worklet_other_requests': len(near),
                     'main_with_query': sum(1 for send in sends
                                            if any(path.startswith(MAIN_PATH + '?') for path in send['values'].get(':path', [])))}
    if not found:
        outside = not near and any(_netlog_mentions(event.get('params'), WORKLET_PATH) for event in events
                                   if event['type'] not in (ids[NETLOG_SEND], ids[NETLOG_RECV]))
        out['counts']['worklet_path_outside_http2'] = outside
        if outside:
            return fail('NETLOG-NOT-H2', 'the worklet path is logged, but in no HTTP/2 request block (B2)')
        return fail('NETLOG-NO-STREAM', 'no HTTP/2 GET of exactly %s from %s' % (WORKLET_PATH, authority))
    if len(found) > 1 or near:
        return fail('NETLOG-AMBIGUOUS', '%d exact worklet GETs and %d other requests for its path' % (len(found), len(near)))
    send = out['send'] = found[0]
    answers = [recv for recv in recvs if recv['key'] == send['key']]
    out['counts']['worklet_response_blocks'] = len(answers)
    if not answers:
        return fail('NETLOG-NO-RESPONSE', 'no response block on the worklet stream')
    if len(answers) > 1:
        return fail('NETLOG-AMBIGUOUS', '%d response blocks on the worklet stream' % len(answers))
    if answers[0]['index'] < send['index']:
        return fail('NETLOG-ORDER', 'the worklet response block precedes its request block')
    out['recv'] = answers[0]
    posts = [one for one in sends if isinstance(uid, str) and re.fullmatch(r'[0-9.]+', uid) and
             exact(one, 'POST', DICTATION_PATH % uid)]
    out['post'] = {'count': len(posts), 'after_worklet': [one['index'] > send['index'] for one in posts]}
    if out['post']['after_worklet'] != [True]:
        fail('NETLOG-WINDOW', 'the PATH POST is not logged exactly once after the worklet exchange')
    return out


def _netlog_time(event):
    value = event.get('time')
    return value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,20}', value) else None


def _netlog_event_sha256(event):
    """Lets a later holder of the raw log re-verify the two bound events; the raw log itself is never kept (R1)."""
    return sha256(json.dumps(event, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))


def netlog_p10(source, t0, t_end, uid, authority, read_debug, hide, limit=NETLOG_MAX_BYTES,
               clock=time.monotonic, sleep=time.sleep):
    """P10's two worklet limbs from the NetLog. The raw bytes and the parsed document never leave this function:
    it returns the classes, the two verdicts, the allowlisted worklet headers for the recorded G-CSP input, the
    extract text for ARTIFACTS and a summary of it for the PATH line. Any class fails both limbs; only a bound
    exchange without one can pass, or fail as P10 on its status or policies. The extract keeps request values of
    NETLOG_REQUEST_VALUES and response values of RESPONSE_HEADERS only, response header names as a list (F2), and
    must come through measurement_ci.sanitize unchanged in every form it is written in, or it is withheld."""
    classes, details = [], {}

    def add(name, why):
        if name not in classes:
            classes.append(name)
            details[name] = why
    window = round(t_end - t0, 3)
    if window > NETLOG_WINDOW_SECONDS:
        add('NETLOG-WINDOW', 'test 01 ended %.1f s after launch, over %d s' % (window, NETLOG_WINDOW_SECONDS))
    extract = {'instrument': 'Chromium NetLog, Default capture, HTTP/2 header blocks; the raw log is not kept',
               'netlog_seconds': NETLOG_SECONDS, 'deadline_seconds': NETLOG_DEADLINE_SECONDS,
               'window_limit_seconds': NETLOG_WINDOW_SECONDS, 'window_s': window, 'reads': 0, 'read_at_s': None,
               'raw': None, 'guards': None, 'mode': None, 'events': None, 'counts': {}, 'exchange': None,
               'post': None, 'main_calibration': []}
    bound = None
    try:
        waited = wait_netlog(source, t0, limit, clock, sleep)
        data, (doc, problem) = waited['data'], waited['loaded']
        extract.update(reads=waited['reads'], read_at_s=waited['at_s'], raw={
            'present': data is not None, 'parsed': doc is not None,
            'bytes': None if data is None else len(data), 'sha256': None if data is None else sha256(data)})
        if problem:
            add(problem, 'no strict whole-file parse by the deadline' if problem == 'NETLOG-INCOMPLETE' else
                'a duplicate key, a non-finite number or more than %d bytes' % limit)
        try:
            debug = read_debug()
        except OSError:
            debug = None       # recorded as unread: an absent line never proved anything (F3)
        extract['guards'] = None if debug is None else {name: line in debug for name, line in NETLOG_GUARDS}
        for name in [name for name, present in (extract['guards'] or {}).items() if present]:
            add(name, 'its line is in browser-debug.log')
        if doc is not None:
            bound = netlog_bind(doc, uid, authority)
            for name in bound['classes']:
                add(name, bound['details'][name])
    except Exception as error:       # the type only: a message could quote the log
        add('NETLOG-ERROR', type(error).__name__)
    send, recv = (bound or {}).get('send'), (bound or {}).get('recv')
    if bound:
        extract.update(mode=bound['mode'], events=bound['events'], counts=bound['counts'], post=bound['post'],
                       main_calibration=bound['main'])
    if send and recv:
        names = [name for name in recv['names'] if HEADER_NAME.fullmatch(name)]
        extract['exchange'] = {
            'session': send['key'][0], 'stream': send['key'][1], 'request_index': send['index'],
            'response_index': recv['index'], 'request_time': _netlog_time(send['event']),
            'response_time': _netlog_time(recv['event']),
            'request': {name: send['values'][name] for name in NETLOG_REQUEST_VALUES if name in send['values']},
            'response': _netlog_response(recv['values']), 'response_header_names': names,
            'response_header_names_withheld': len(recv['names']) - len(names),
            'request_sha256': _netlog_event_sha256(send['event']), 'response_sha256': _netlog_event_sha256(recv['event'])}
    response = (extract['exchange'] or {}).get('response') or {}
    status, coop, coep = (response.get(name, []) for name in
                          (':status', 'cross-origin-opener-policy', 'cross-origin-embedder-policy'))
    headers = {name: values[0] if len(values) == 1 else values for name, values in response.items()
               if name != ':status'} if extract['exchange'] else None
    extract['classes'], extract['details'] = classes, details
    summary = {'classes': classes, 'details': details, 'raw': extract['raw'], 'mode': extract['mode'],
               'window_s': window, 'read_at_s': extract['read_at_s'], 'reads': extract['reads'],
               'exchange': None if not extract['exchange'] else {
                   'session': extract['exchange']['session'], 'stream': extract['exchange']['stream'],
                   'status': status, 'coop': coop, 'coep': coep},
               'post': extract['post']}
    text = json.dumps(extract, ensure_ascii=False, indent=2) + '\n'
    leaked = [label for label, form in (('extract', text), ('extract line', json.dumps(extract, ensure_ascii=False)),
                                        ('summary line', json.dumps(summary, ensure_ascii=False)))
              if measurement_ci.sanitize(form, hide) != form]
    if leaked:
        add('NETLOG-LEAK', 'measurement_ci.sanitize changes the ' + ', '.join(leaked))
        extract = {'withheld': True, 'classes': classes, 'details': {'NETLOG-LEAK': details['NETLOG-LEAK']},
                   'raw': extract['raw']}
        text, summary, headers = json.dumps(extract, ensure_ascii=False, indent=2) + '\n', dict(extract), None
    summary.update(extract=NETLOG_EXTRACT, extract_sha256=sha256(text.encode('utf-8')))
    bound_clean = not classes and bool(extract.get('exchange'))
    return {'classes': classes, 'status_ok': bound_clean and status == ['200'],
            'policy_ok': bound_clean and coop == ['same-origin'] and coep == ['require-corp'],
            'headers': headers, 'text': text, 'summary': summary}


def geo_entry_problems(initial):
    """G0, asserted from the rectangles BEFORE the click (the R15 lesson: a covered entry burns the click timeout
    and names nothing)."""
    if not isinstance(initial, dict) or 'controls' not in initial:
        return ['G0: geometry unreadable']
    problems, entry = [], initial['controls'].get('b-dictate') or {}
    if not initial.get('drawerShown'):
        problems.append('G0: the Image Findings drawer is not shown')
    if initial.get('paneHidden') is not True:
        problems.append('G0: the dictation pane is not hidden before Dictate')
    if not (entry.get('present') and entry.get('own') and entry.get('disabled') is False):
        problems.append('G0: #b-dictate not present, enabled and own (%s, disabled=%r)' % (entry.get('topId'), entry.get('disabled')))
    return problems


def geo_problems(state, initial, measured):
    """G1-G6 for one measured state (readiness §5), plus G8 in review, from rendered rectangles and hit tests only."""
    if not isinstance(measured, dict) or 'controls' not in measured:
        return ['%s: geometry unreadable' % state]
    problems, controls = [], measured['controls']

    def own(name):
        seen = controls.get(name) or {}
        return bool(seen.get('present') and seen.get('own'))

    def top(name):
        return (controls.get(name) or {}).get('topId')
    for name in GEO_CONTROLS[state]:
        if not own(name):
            problems.append('G1 %s: #%s not present and own (top %s)' % (state, name, top(name)))
    if not own('dictation-status'):
        problems.append('G2 %s: #dictation-status covered or clipped at its centre (top %s)' % (state, top('dictation-status')))
    drawer, pane, rbtns = measured.get('drawer'), measured.get('pane'), measured.get('rbtns')
    if state == 'review':
        # Astra B2 (2026-09-23): the product stands the drawer down once when a run enters review, so here
        # G3 is POSITIVE - hidden, its toggle says so, and the toggle is there to reopen it. A drawer still
        # open over the report column fails, and so does one that is gone without a reachable toggle.
        # Astra B2 amendment (2026-09-24, after CI2): "reachable" changed meaning. It was "owns its centre at the
        # measured scroll position"; it is now toggle_reach_problems - operable, and whole+own at rest or whole+own
        # after a measured reveal through user-scrollable ancestors only, every offset restored. The toggle no longer
        # has to be in view together with the pane. The stand-down limbs and their message are unchanged.
        if measured.get('drawerShown') is not False or measured.get('drawerExpanded') != 'false':
            problems.append('G3 review: drawer not stood down (drawerShown=%r, aria-expanded=%r, toggle top %s)'
                            % (measured.get('drawerShown'), measured.get('drawerExpanded'), top('reading-findings-open')))
        problems.extend(toggle_reach_problems(measured.get('toggleReach')))
    elif not measured.get('drawerShown') or not drawer or not pane:
        problems.append('G3 %s: drawer or pane missing (drawerShown=%r)' % (state, measured.get('drawerShown')))
    elif drawer['y'] < pane['b']:
        problems.append('G3 %s: drawer top %d above pane bottom %d (bound %r)' % (state, drawer['y'], pane['b'], measured.get('drawerTop')))
    if not pane or not rbtns or pane['y'] < rbtns['b']:
        problems.append('G4 %s: pane %s not below the report buttons %s' % (state, pane, rbtns))
    if not own('m-reading'):
        problems.append('G4 %s: #m-reading covered (top %s)' % (state, top('m-reading')))
    redit, redit_min = measured.get('redit'), (measured.get('reditMin') or {}).get('px')
    if not redit or (redit_min is not None and redit['h'] < redit_min):
        problems.append('G5 %s: .redit %s below its min-height %r' % (state, redit, redit_min))
    fields = measured.get('fields') or {}
    for name in RFIELDS:
        value = fields.get(name) or {}
        field, field_min = value.get('box'), (value.get('min') or {}).get('px')
        if not field or (field_min is not None and field['h'] < field_min):
            problems.append('G5 %s: #%s %s below its min-height %r' % (state, name, field, field_min))
    if state == 'review' and not (measured.get('findingsProbe') or {}).get('own'):
        problems.append('G5 review: #findings not reachable at its top-left probe (%s)' % measured.get('findingsProbe'))
    if (initial or {}).get('rfootInside') and not measured.get('rfootInside'):
        problems.append('G6 %s: .rfoot2 was fully in the viewport before and is not now (%s)' % (state, measured.get('rfoot')))
    if state == 'review':
        problems.extend(transcript_problems(measured.get('transcript')))
    return problems


def transcript_problems(t):
    """G8 (Astra D2, 2026-09-24), review only: the reader checks the transcript before Insert, so at least one
    whole rendered line of it is on screen and uncovered, and a transcript longer than its box keeps the
    capability to scroll by keyboard (overflow auto/scroll and focusable) - capability, not a performed scroll.
    Fails closed (B-3): a record whose counts are not plain ints or whose flags are not the exact types reads
    as malformed, never as a pass."""
    if not isinstance(t, dict):
        return ['G8 review: transcript missing (%r)' % (t,)]

    def count(name, low=0):
        value = t.get(name)
        return isinstance(value, int) and not isinstance(value, bool) and value >= low
    bad = [name for name in ('lines', 'readable', 'clientHeight', 'scrollHeight') if not count(name)]
    bad += [] if count('tabIndex', low=-1) else ['tabIndex']
    bad += [] if isinstance(t.get('overflowY'), str) else ['overflowY']
    bad += [] if isinstance(t.get('firstReadableOwn'), bool) else ['firstReadableOwn']
    if not bad and t['readable'] > t['lines']:
        bad.append('readable>lines')
    if bad:
        return ['G8 review: transcript record malformed (%s)' % ', '.join(bad)]
    problems = []
    if t['lines'] < 1:
        problems.append('G8 review: transcript has no rendered line')
    elif t['readable'] < 1 or t['firstReadableOwn'] is not True:
        problems.append('G8 review: no whole transcript line readable (lines=%r, readable=%r, own=%r, clip=%r, lineHeight=%r)'
                        % (t['lines'], t['readable'], t['firstReadableOwn'], t.get('clip'), t.get('lineHeight')))
    if t['scrollHeight'] > t['clientHeight'] and (t['overflowY'] not in ('auto', 'scroll') or t['tabIndex'] < 0):
        problems.append('G8 review: transcript overflows its box but is not keyboard-scrollable (overflowY=%r, tabIndex=%r)'
                        % (t['overflowY'], t['tabIndex']))
    return problems


def toggle_reach_problems(t):
    """Review G3, the reopen half (Astra B2 amendment, 2026-09-24): the reader can reopen Image Findings during review.
    The TOGGLE_REACH record must show the toggle operable (present, enabled, not inert, in the tab order) and either
    whole (both axes) and owning its centre where it is, or - out of view at rest - whole and owning its centre once
    scrolled to, where every ancestor that moved can be scrolled by the user and every offset was restored. It fails
    closed: a missing, errored or malformed record is a problem. Every message starts 'G3 review: toggle'."""
    if not isinstance(t, dict):
        return ['G3 review: toggle reachability record missing (%r)' % (t,)]
    if t.get('missing') is True:
        return ['G3 review: toggle gone (no #reading-findings-open in the page)']
    if t.get('error') is not None:
        return ['G3 review: toggle probe error (%s; restored=%r)' % (t.get('error'), t.get('restored'))]

    def side(s):
        return isinstance(s, dict) and all(isinstance(s.get(k), bool) for k in ('present', 'whole', 'own')) and \
            isinstance(s.get('topId'), (str, type(None))) and isinstance(s.get('by'), list)
    tab = t.get('tabIndex')
    bad = [] if side(t.get('rest')) else ['rest']
    bad += [key for key in ('disabled', 'inert') if not isinstance(t.get(key), bool)]
    bad += [] if isinstance(tab, int) and not isinstance(tab, bool) else ['tabIndex']
    if bad:
        return ['G3 review: toggle record malformed (%s)' % ', '.join(bad)]
    rest = t['rest']
    if not rest['present'] or t['disabled'] or t['inert'] or tab < 0:
        return ['G3 review: toggle not operable (present=%r, disabled=%r, inert=%r, tabIndex=%r)'
                % (rest['present'], t['disabled'], t['inert'], tab)]
    revealed, moved, restored = t.get('revealed'), t.get('moved'), t.get('restored')
    if rest['whole']:
        if (revealed, moved, restored) != (None, None, None):
            return ['G3 review: toggle record malformed (a reveal beside a whole toggle)']
        return [] if rest['own'] else ['G3 review: toggle covered in view (top %s)' % rest['topId']]
    if not side(revealed) or not isinstance(moved, list) or not isinstance(restored, bool) or \
            not all(isinstance(m, dict) and isinstance(m.get('userScrollable'), bool) for m in moved):
        return ['G3 review: toggle reveal record malformed']
    if not restored:
        return ['G3 review: toggle reveal did not restore every scroll offset']
    if not moved or not all(m['userScrollable'] for m in moved):
        return ['G3 review: toggle out of view and not revealed by user-scrollable ancestors only (%r)' % (moved,)]
    if not (revealed['whole'] and revealed['own']):
        return ['G3 review: toggle not whole and own when scrolled to (whole=%r, top %s)' % (revealed['whole'], revealed['topId'])]
    return []


def generated_secret_names():
    """The values measurement_ci.main() generates and masks (measurement_ci.py:466-467), read from its source."""
    tree = ast.parse(Path(measurement_ci.__file__).read_text(encoding='utf-8'))
    for node in ast.walk(tree):
        if isinstance(node, ast.DictComp) and 'token_hex' in ast.unparse(node.value) and \
                isinstance(node.generators[0].iter, (ast.List, ast.Tuple)):
            return tuple(item.value for item in node.generators[0].iter.elts if isinstance(item, ast.Constant))
    return ()


def sample_geometry(state_ok=True, **changes):
    """A consistent layout for oracle_self_check: buttons, then the pane, then the fields and the drawer below."""
    def control(y):
        return {'present': True, 'own': True, 'topId': 'x', 'hidden': False, 'disabled': False,
                'rect': {'x': 900, 'y': y, 'w': 40, 'h': 20, 'b': y + 20}}
    geometry = {'viewport': {'w': 1680, 'h': 1100}, 'reading': False, 'rightScrollTop': 0,
                'menubar': {'x': 0, 'y': 0, 'w': 1680, 'h': 30, 'b': 30},
                'rbtns': {'x': 800, 'y': 230, 'w': 800, 'h': 26, 'b': 256},
                'pane': {'x': 800, 'y': 256, 'w': 800, 'h': 120, 'b': 376}, 'paneHidden': not state_ok,
                'redit': {'x': 800, 'y': 376, 'w': 800, 'h': 400, 'b': 776}, 'reditMin': {'raw': 'auto', 'px': None},
                'fields': {name: {'box': {'x': 810, 'y': 400, 'w': 780, 'h': 100, 'b': 500}, 'min': {'raw': '50px', 'px': 50}}
                           for name in RFIELDS},
                'rfoot': {'x': 800, 'y': 780, 'w': 800, 'h': 26, 'b': 806}, 'rfootInside': True,
                'drawer': {'x': 1248, 'y': 376, 'w': 420, 'h': 300, 'b': 676}, 'drawerShown': True, 'drawerExpanded': 'true',
                'drawerTop': '376px',
                'findingsProbe': {'x': 818, 'y': 408, 'own': True, 'topId': 'findings'}, 'status': 'x',
                'controls': {name: control(300) for name in GEO_HIT_IDS}, 'transcript': None}
    geometry.update(changes)
    return geometry


def oracle_self_check():
    """Pure failure paths for every oracle above. No browser, stack or network (execution_selection_test.py)."""
    problems = []

    def expect_problem(label, result):
        if not result:
            problems.append('must reject: ' + label)
    # P0 launch lines, in the form Playwright's launchProcess writes them.
    full = '/home/runner/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'
    shell = '/home/runner/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell'
    fixture = '/w/tests/e2e/artifacts/measurement-ci/dictation-live/fixture.wav'
    netlog = '/home/runner/work/_temp/u4l-netlog/0123abcd/netlog.json'

    def line(executable, extra):
        return 'T pw:browser <launching> %s --disable-field-trial-config --headless --mute-audio %s' % (executable, extra)
    base = line(full, '--enable-unsafe-swiftshader')
    media = '--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=%s --disable-audio-output' % fixture
    switches = ' '.join(u4l_launch_args(fixture, netlog)[len(launch_args(fixture)):])
    capture = line(full, media + ' ' + switches)
    log = lambda *rows: '\n'.join(rows + ('T pw:browser <launched> pid=7',))
    good = launch_verdict(log(base, capture), fixture, BROWSER_VERSION, netlog)
    if good['problems'] or [r['capture'] for r in good['records']] != [False, True]:
        problems.append('the pinned two-launch log must pass P0: %r' % good['problems'])
    for label, text, version in (
            ('one launch line', log(capture), BROWSER_VERSION),
            ('three launch lines', log(base, capture, base), BROWSER_VERSION),
            ('a headless-shell capture', log(base, line(shell, media + ' ' + switches)), BROWSER_VERSION),
            ('a headless-shell base browser (each process is judged)', log(line(shell, '--x'), capture), BROWSER_VERSION),
            ('a forbidden flag on the base line', log(line(full, FORBIDDEN_LAUNCH_FLAGS[0]), capture), BROWSER_VERSION),
            ('a forbidden flag on the capture line', log(base, capture + ' ' + FORBIDDEN_LAUNCH_FLAGS[2] + '=x'), BROWSER_VERSION),
            ('a capture without --disable-audio-output', log(base, capture.replace(' --disable-audio-output', '')), BROWSER_VERSION),
            ('two lines carrying the fixture', log(capture, capture), BROWSER_VERSION),
            ('another fixture path', log(base, capture.replace(fixture, fixture + '.x')), BROWSER_VERSION),
            ('another browser version', log(base, capture), '148.0.0.0'),
            ('an empty log', '', BROWSER_VERSION)):
        expect_problem(label, launch_verdict(text, fixture, version, netlog)['problems'])
    # The NetLog delta, each rejected by a NetLog problem; forbidden tokens are built from the one tuple (F1).
    duration = '--net-log-duration=%d' % NETLOG_SECONDS
    for label, text in (
            ('a capture without --log-net-log', log(base, capture.replace(' --log-net-log=' + netlog, ''))),
            ('a NetLog path other than the private one', log(base, capture.replace(netlog, netlog + '.x'))),
            ('a second --log-net-log', log(base, capture + ' --log-net-log=' + netlog)),
            ('a capture without --net-log-duration', log(base, capture.replace(' ' + duration, ''))),
            ('another NetLog duration', log(base, capture.replace(duration, '--net-log-duration=60'))),
            ('a second --net-log-duration', log(base, capture + ' ' + duration)),
            ('a capture mode on the capture line', log(base, capture + ' ' + NETLOG_FORBIDDEN_FLAGS[0] + '=' + 'Include' + 'Sensitive')),
            ('a size limit on the capture line', log(base, capture + ' ' + NETLOG_FORBIDDEN_FLAGS[1] + '=1')),
            ('a TLS key log on the capture line', log(base, capture + ' ' + NETLOG_FORBIDDEN_FLAGS[2] + '=/tmp/k')),
            ('a bare forbidden switch on the capture line', log(base, capture + ' ' + NETLOG_FORBIDDEN_FLAGS[2])),
            ('the NetLog switches on the base line', log(line(full, '--enable-unsafe-swiftshader ' + switches), capture)),
            ('a forbidden NetLog switch on the base line',
             log(line(full, '--enable-unsafe-swiftshader ' + NETLOG_FORBIDDEN_FLAGS[0] + '=Default'), capture))):
        if not any('NetLog' in problem for problem in launch_verdict(text, fixture, BROWSER_VERSION, netlog)['problems']):
            problems.append('the NetLog launch oracle must reject: ' + label)
    # P1 predicate, diff and capability.
    for url, matches in (('https://localhost:9443/api/bootstrap?states=omit', True), ('https://localhost:9443/api/bootstrap', True),
                         ('https://localhost:9443/api/bootstrap/x', False), ('https://localhost:9443/api/bootstrapx', False),
                         ('https://localhost:9443/worklist/api/bootstrap', False),
                         ('https://localhost:9443/api/studies/1.2/dictation', False)):
        if bootstrap_request(url) is not matches:
            problems.append('bootstrap_request(%s) must be %r' % (url, matches))
    capability = {'available': False, 'maxBytes': MAX_BYTES, 'timeoutMs': 120000, 'languagePin': 'auto',
                  'enginePin': ASR_ENGINE_PIN, 'modelPin': ASR_MODEL_PIN}
    document = {'states': {}, 'dictation': capability, 'me': {'roles': ['radiologist']}}
    replaced = copy.deepcopy(document)
    replaced['dictation']['available'] = True
    if differing_paths(document, replaced) != ['dictation.available'] or differing_paths(document, document):
        problems.append('differing_paths must name exactly dictation.available')
    expect_problem('a new key', differing_paths(document, dict(document, extra=1)))
    expect_problem('true for 1', differing_paths({'a': True}, {'a': 1}))
    if capability_problems(capability):
        problems.append('the unconfigured capability must pass P1: %r' % capability_problems(capability))
    for label, value in (('available true', dict(capability, available=True)), ('available 0', dict(capability, available=0)),
                         ('an extra key', dict(capability, url='x')), ('a lowered maxBytes', dict(capability, maxBytes=MAX_BYTES - 1)),
                         ('another engine pin', dict(capability, enginePin='x'))):
        expect_problem(label, capability_problems(value))
    # P5 U5 and P9 audit.
    if u5_problems(1000.0, 2600.0, 24000):
        problems.append('1.5 s of audio for 1.6 s must pass U5')
    for label, args in (('too little audio', (1000.0, 2600.0, 8000)), ('too much audio', (1000.0, 2600.0, 60000)),
                        ('a missing Stop time', (1000.0, None, 24000))):
        expect_problem(label, u5_problems(*args))
    row = lambda **d: {'actor': 'doctor', 'detail': dict({'bytes': 48044, 'seconds': 24000 / 16000, 'ms': 3,
                                                          'engine': ASR_ENGINE_PIN, 'outcome': 'DICTATION_NOT_CONFIGURED'}, **d)}
    if audit_problems([], [row()], 48044, 24000):
        problems.append('the exact audit row must pass P9: %r' % audit_problems([], [row()], 48044, 24000))
    for label, args in (('no row', ([], [], 48044, 24000)), ('two rows', ([], [row(), row()], 48044, 24000)),
                        ('another byte count', ([], [row(bytes=48043)], 48044, 24000)),
                        ('a seconds value one ULP off', ([], [row(seconds=math.nextafter(24000 / 16000, 2))], 48044, 24000)),
                        ('another outcome', ([], [row(outcome='success')], 48044, 24000)),
                        ('another engine', ([], [row(engine='x')], 48044, 24000)),
                        ('a negative ms', ([], [row(ms=-1)], 48044, 24000)), ('a boolean ms', ([], [row(ms=True)], 48044, 24000)),
                        ('a text detail', ([], [{'actor': 'doctor', 'detail': None, 'raw': 'x'}], 48044, 24000)),
                        ('no wire body', ([], [row()], None, 24000))):
        expect_problem(label, audit_problems(*args))
    # P8/G7 writes, P10 allowlist and the recorded G-CSP input.
    uid = '1.2.3'
    writes = [{'method': 'PUT', 'path': '/api/studies/1.2.3/report'}, {'method': 'POST', 'path': '/api/studies/1.2.3/report/commit'},
              {'method': 'DELETE', 'path': '/api/studies/1.2.3/draft'}, {'method': 'POST', 'path': '/api/studies/1.2.3/dictation'},
              {'method': 'GET', 'path': '/api/studies/1.2.3/report'}]
    if len(forbidden_writes(writes, uid)) != 3:
        problems.append('forbidden_writes must name the three report writes and nothing else')
    credential = {'Cookie': 'a', 'Set-Cookie': 'b', 'Authorization': 'c', 'Content-Type': 'text/html'}
    if allowlisted(credential, RESPONSE_HEADERS + REQUEST_HEADERS) != {'content-type': 'text/html'}:
        problems.append('the header allowlist must never carry a credential header')
    api = {'content-security-policy': 'x', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'}
    for expected, args in (('location-override', ({}, {}, api)), ('not-delivered', ({}, {}, {})), ('no-trigger', (api, api, api)),
                           ('unobserved', (api, None, api))):
        if gcsp_input(*args) != expected:
            problems.append('gcsp_input must classify %s' % expected)
    # G0-G6.
    initial = sample_geometry(state_ok=False)
    if geo_entry_problems(initial):
        problems.append('a hidden pane with a reachable Dictate must pass G0: %r' % geo_entry_problems(initial))
    for label, value in (('a hidden drawer', dict(initial, drawerShown=False)), ('a visible pane', dict(initial, paneHidden=False)),
                         ('a covered Dictate', dict(initial, controls=dict(initial['controls'], **{'b-dictate': dict(
                             initial['controls']['b-dictate'], own=False)}))),
                         ('a disabled Dictate', dict(initial, controls=dict(initial['controls'], **{'b-dictate': dict(
                             initial['controls']['b-dictate'], disabled=True)})))):
        expect_problem(label, geo_entry_problems(value))
    measured = sample_geometry()
    # Review is measured after the product stood the drawer down (Astra B2), so it has its own consistent sample,
    # with the transcript shown (phase A keeps it hidden: `transcript` None there, and G8 never runs).
    seen_text = {'box': {'x': 810, 'y': 280, 'w': 780, 'h': 43, 'b': 323}, 'boxSizing': 'content-box', 'fontSize': '11px',
                 'lineHeight': '16.5px', 'minHeight': '16.5px', 'padding': [3, 3], 'border': [1, 1], 'contentHeight': 35.0,
                 'clientHeight': 41, 'scrollHeight': 240, 'scrollTop': 0, 'overflowY': 'auto', 'tabIndex': 0,
                 'port': {'top': 281.0, 'bottom': 322.0}, 'clip': {'top': 281.0, 'bottom': 322.0}, 'lines': 12, 'readable': 2,
                 'firstReadable': {'top': 285.5, 'bottom': 298.5}, 'firstReadableOwn': True}
    # The toggle whole and owning its centre where it is (1680 reading and both plain reviews in CI2): no reveal ran.
    reach_rest = {'rest': {'rect': {'x': 1583.0, 'y': 355.0, 'w': 93.0, 'h': 18.0}, 'by': [], 'present': True,
                           'clip': {'top': 52.0, 'bottom': 1100.0, 'left': 1261.0, 'right': 1680.0}, 'whole': True, 'own': True,
                           'topId': 'reading-findings-open'},
                  'disabled': False, 'inert': False, 'tabIndex': 0, 'revealed': None, 'moved': None, 'restored': None, 'error': None}
    stood = sample_geometry(drawerShown=False, drawerExpanded='false', drawer={'x': 0, 'y': 0, 'w': 0, 'h': 0, 'b': 0},
                            transcript=seen_text, toggleReach=reach_rest)
    for state in GEO_CONTROLS:
        sample = stood if state == 'review' else measured
        if geo_problems(state, initial, sample):
            problems.append('a consistent %s layout must pass G1-G6: %r' % (state, geo_problems(state, initial, sample)))

    def covered(name, base=None):
        base = base or measured
        return dict(base, controls=dict(base['controls'], **{name: dict(base['controls'][name], own=False)}))
    for label, state, value in (
            ('a covered Stop', 'recording', covered('dictation-stop')), ('a covered Close', 'failed', covered('dictation-close')),
            ('a covered Insert', 'review', covered('dictation-insert', stood)), ('a covered status', 'failed', covered('dictation-status')),
            ('a drawer over the pane', 'recording', dict(measured, drawer=dict(measured['drawer'], y=300))),
            ('a hidden drawer', 'failed', dict(measured, drawerShown=False)),
            ('a pane above the buttons', 'failed', dict(measured, pane=dict(measured['pane'], y=250))),
            ('a covered Reading Workspace toggle', 'recording', covered('m-reading')),
            ('a squeezed field', 'recording', dict(measured, fields=dict(measured['fields'], conclusion={
                'box': dict(measured['fields']['conclusion']['box'], h=20), 'min': {'raw': '34px', 'px': 34}}))),
            ('an unreachable findings field in review', 'review', dict(stood, findingsProbe=dict(stood['findingsProbe'], own=False))),
            ('a footer pushed out', 'failed', dict(measured, rfootInside=False))):
        expect_problem(label, geo_problems(state, initial, value))
    # The paired G3 contract, each rejected by G3 itself: phase A must keep the drawer shown and bounded,
    # review must have it stood down with a reachable toggle that says so.
    for label, state, value, limb in (
            ('a hidden drawer while recording (phase A)', 'recording', dict(measured, drawerShown=False, drawerExpanded='false'), 'G3 recording'),
            ('a review with the drawer still open', 'review', measured, 'G3 review'),
            ('a review whose drawer is still on screen though its toggle says collapsed', 'review',
             dict(stood, drawerShown=True, drawer=measured['drawer']), 'G3 review'),
            ('a review whose toggle still says expanded', 'review', dict(stood, drawerExpanded='true'), 'G3 review'),
            # Re-expressed through the TOGGLE_REACH record (Astra B2 amendment): the same two cases, still rejected.
            ('a review stood down with its toggle covered', 'review',
             dict(stood, toggleReach=dict(reach_rest, rest=dict(reach_rest['rest'], own=False, topId='x'))), 'G3 review'),
            ('a review stood down with its toggle gone', 'review', dict(stood, toggleReach={'missing': True}), 'G3 review')):
        if not any(problem.startswith(limb) for problem in geo_problems(state, initial, value)):
            problems.append('%s must reject: %s' % (limb, label))
    # Astra B2 amendment (2026-09-24, after CI2): the reopen half of review G3, read from TOGGLE_REACH. Each shape
    # differs from the consistent review only in `toggleReach` (or a stand-down field), so it must draw exactly the one
    # named problem. The CI2-shaped vector is built from CI2's measured rest facts; its reveal is a declared shape, not
    # an observation (the reveal first runs on the hosted attempt).
    out_of_view = {'rest': dict(reach_rest['rest'], rect={'x': 1269.0, 'y': 107.0, 'w': 93.0, 'h': 18.0}, whole=False, own=False,
                                topId='userfilter', by=[{'name': 'right', 'overflowX': 'auto', 'overflowY': 'auto'}]),
                   'disabled': False, 'inert': False, 'tabIndex': 0, 'revealed': dict(reach_rest['rest']),
                   'moved': [{'name': 'right', 'userScrollable': True}], 'restored': True, 'error': None}

    def reach(base, **changes):
        return dict(stood, toggleReach=dict(base, **changes))
    down = "G3 review: drawer not stood down (drawerShown=%r, aria-expanded=%r, toggle top x)"
    hidden_only, mixed = [{'name': 'split', 'userScrollable': False}], \
        [{'name': 'right', 'userScrollable': True}, {'name': 'html', 'userScrollable': False}]
    for label, value, expected in (
            ('whole and own at rest, no reveal', stood, []),
            ('the CI2 1366 reading shape: out of view in .right, revealed whole and own, restored', reach(out_of_view), []),
            ('the drawer still shown', dict(stood, drawerShown=True), [down % (True, 'false')]),
            ('aria-expanded still true', dict(stood, drawerExpanded='true'), [down % (False, 'true')]),
            ('covered where it is', reach(reach_rest, rest=dict(reach_rest['rest'], own=False, topId='structmodal')),
             ['G3 review: toggle covered in view (top structmodal)']),
            ('covered even when scrolled to', reach(out_of_view, revealed=dict(out_of_view['revealed'], own=False, topId='sticky')),
             ['G3 review: toggle not whole and own when scrolled to (whole=True, top sticky)']),
            ('not whole even when scrolled to', reach(out_of_view, revealed=dict(out_of_view['revealed'], whole=False)),
             ['G3 review: toggle not whole and own when scrolled to (whole=False, top reading-findings-open)']),
            ('revealed only through an overflow:hidden ancestor', reach(out_of_view, moved=hidden_only),
             ['G3 review: toggle out of view and not revealed by user-scrollable ancestors only (%r)' % (hidden_only,)]),
            ('revealed through a scrollable and a non-scrollable ancestor', reach(out_of_view, moved=mixed),
             ['G3 review: toggle out of view and not revealed by user-scrollable ancestors only (%r)' % (mixed,)]),
            ('out of view yet the reveal moved nothing', reach(out_of_view, moved=[]),
             ['G3 review: toggle out of view and not revealed by user-scrollable ancestors only ([])']),
            ('clipped sideways by an overflow:hidden ancestor, nothing scrollable moved', reach(
                out_of_view, rest=dict(out_of_view['rest'], by=[{'name': 'split', 'overflowX': 'hidden', 'overflowY': 'hidden'}]),
                revealed=dict(out_of_view['rest']), moved=[]),
             ['G3 review: toggle out of view and not revealed by user-scrollable ancestors only ([])']),
            ('scroll offsets not restored', reach(out_of_view, restored=False), ['G3 review: toggle reveal did not restore every scroll offset']),
            ('a probe error, offsets restored', reach(out_of_view, error='TypeError: x', restored=True),
             ['G3 review: toggle probe error (TypeError: x; restored=True)']),
            ('a probe error, offsets not restored', reach(out_of_view, error='restore: right: boom', restored=False),
             ['G3 review: toggle probe error (restore: right: boom; restored=False)']),
            ('the evaluate itself failed', dict(stood, toggleReach={'error': 'evaluate: Target closed', 'restored': None}),
             ['G3 review: toggle probe error (evaluate: Target closed; restored=None)']),
            ('the toggle gone from the page', dict(stood, toggleReach={'missing': True}),
             ['G3 review: toggle gone (no #reading-findings-open in the page)']),
            ('the toggle without a box', reach(reach_rest, rest=dict(reach_rest['rest'], present=False, whole=False, own=False, topId=None)),
             ['G3 review: toggle not operable (present=False, disabled=False, inert=False, tabIndex=0)']),
            ('the toggle disabled', reach(reach_rest, disabled=True),
             ['G3 review: toggle not operable (present=True, disabled=True, inert=False, tabIndex=0)']),
            ('the toggle inside an inert region', reach(reach_rest, inert=True),
             ['G3 review: toggle not operable (present=True, disabled=False, inert=True, tabIndex=0)']),
            ('the toggle out of the tab order', reach(reach_rest, tabIndex=-1),
             ['G3 review: toggle not operable (present=True, disabled=False, inert=False, tabIndex=-1)']),
            ('the record missing', dict(stood, toggleReach=None), ['G3 review: toggle reachability record missing (None)']),
            ('own as a string', reach(reach_rest, rest=dict(reach_rest['rest'], own='yes')), ['G3 review: toggle record malformed (rest)']),
            ('tabIndex True', reach(reach_rest, tabIndex=True), ['G3 review: toggle record malformed (tabIndex)']),
            ('restored as 1', reach(out_of_view, restored=1), ['G3 review: toggle reveal record malformed']),
            ('revealed whole as a string', reach(out_of_view, revealed=dict(out_of_view['revealed'], whole='yes')),
             ['G3 review: toggle reveal record malformed']),
            ('a reveal beside a whole toggle', reach(reach_rest, restored=True),
             ['G3 review: toggle record malformed (a reveal beside a whole toggle)'])):
        got = geo_problems('review', initial, value)
        if got != expected:
            problems.append('G3 toggle must give exactly %r for %s: %r' % (expected, label, got))
    # G8 (Astra D2): each shape differs from the consistent review only in its transcript, so it must draw exactly
    # one problem, from the named G8 check - nothing else may fire, and the right G8 message must be the one.
    unreadable, scroll = 'G8 review: no whole transcript line readable', 'G8 review: transcript overflows its box but is not'
    malformed = 'G8 review: transcript record malformed'
    for label, value, prefix in (
            ('F-1 at 1366: one 15px line in 9.6px of content, clipped', dict(
                seen_text, contentHeight=9.6, clientHeight=16, port={'top': 281.0, 'bottom': 296.6},
                clip={'top': 281.0, 'bottom': 296.6}, readable=0, firstReadable=None, firstReadableOwn=False), unreadable),
            ('a whole line whose centre is covered', dict(seen_text, firstReadableOwn=False), unreadable),
            ('no readable line beside a stale own flag', dict(seen_text, readable=0, firstReadable=None), unreadable),
            ('the transcript missing in review', None, 'G8 review: transcript missing'),
            ('a transcript record that is not an object', [seen_text], 'G8 review: transcript missing'),
            ('a transcript with no rendered line', dict(seen_text, lines=0, readable=0, firstReadable=None, firstReadableOwn=False),
             'G8 review: transcript has no rendered line'),
            ('an overflowing transcript that cannot scroll', dict(seen_text, overflowY='hidden'), scroll),
            ('an overflowing transcript the keyboard cannot reach', dict(seen_text, tabIndex=-1), scroll),
            ('scrollHeight None', dict(seen_text, scrollHeight=None), malformed + ' (scrollHeight)'),
            ('readable 1.0', dict(seen_text, readable=1.0), malformed + ' (readable)'),
            ('firstReadableOwn "yes"', dict(seen_text, firstReadableOwn='yes'), malformed + ' (firstReadableOwn)'),
            ('tabIndex True', dict(seen_text, tabIndex=True), malformed + ' (tabIndex)'),
            ('clientHeight NaN', dict(seen_text, clientHeight=float('nan')), malformed + ' (clientHeight)'),
            ('lines as text', dict(seen_text, lines='12'), malformed + ' (lines)'),
            ('overflowY missing', {k: v for k, v in seen_text.items() if k != 'overflowY'}, malformed + ' (overflowY)'),
            ('more readable lines than lines', dict(seen_text, readable=13), malformed + ' (readable>lines)')):
        got = geo_problems('review', initial, dict(stood, transcript=value))
        if len(got) != 1 or not got[0].startswith(prefix):
            problems.append('G8 must reject %s with exactly %r: %r' % (label, prefix, got))
    for label, state, value in (
            ('a short transcript that fits needs no scrolling', 'review',
             dict(stood, transcript=dict(seen_text, scrollHeight=41, overflowY='visible', tabIndex=-1))),
            ('a hidden transcript while recording', 'recording', dict(measured, transcript=None)),
            ('a hidden transcript after a failure', 'failed', dict(measured, transcript=None))):
        if geo_problems(state, initial, value):
            problems.append('G8 must stay silent for %s: %r' % (label, geo_problems(state, initial, value)))
    # B-1 lives in page code that only a browser runs: keep the port intersected with the viewport and every
    # clipping ancestor, and only lines vertically inside that intersection counted.
    for pin in ('const clip = { top: Math.max(port.top, 0), bottom: Math.min(port.bottom, innerHeight) };',
                'for (let a = t.parentElement; a; a = a.parentElement) {',
                "if (as.overflowX === 'visible' && as.overflowY === 'visible') continue;",
                'clip.top = Math.max(clip.top, r.top); clip.bottom = Math.min(clip.bottom, r.bottom);',
                'lines.filter(x => x.top >= clip.top - LU && x.bottom <= clip.bottom + LU)'):
        if GEOMETRY.count(pin) != 1:
            problems.append('GEOMETRY must keep the B-1 clip exactly once: %s' % pin)
    # Declared bodies and source-bound pins.
    body = json.loads(REVIEW_BODY)
    if len(body['text'].split('\n')) != 12 or len(body['text']) > 16384 or body['seconds'] != 1.0 or \
            not all(isinstance(body[k], str) and 0 < len(body[k]) <= 256 for k in ('languagePin', 'enginePin', 'modelPin')):
        problems.append('the review body must satisfy the client contract (dictation.js:101-119)')
    if ASR_ENGINE_PIN is None or ASR_MODEL_PIN is None or len(TEMPLATE_CSP) != 1:
        problems.append('the source-bound pins must each be found exactly once')
    if len(generated_secret_names()) != 6 or 'POSTGRES_PASSWORD' not in generated_secret_names():
        problems.append('the generated secret names must be read from measurement_ci.py')
    if CHANNEL != 'chromium' or MAX_FRAMES != 524266:
        problems.append('the launch channel and node cap pins moved')
    return problems + netlog_oracle_self_check()


def netlog_oracle_self_check():
    """Pure failure paths of the P10 NetLog instrument. The sample is a log in the writer's own framing
    (file_net_log_observer.cc:748-781) with the header-block shape observed at the tag ([RP]); every negative is
    one mutation of it and must fail with its own class alone (a status or policy mutation fails P10 with no
    class). The wait runs on a fake clock, and the private path and publication boundary are checked on values."""
    problems = []
    authority, uid = 'localhost:9443', '1.2.3'
    types = {'URL_REQUEST_START_JOB': 2, 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS': 160, NETLOG_SEND: 211, NETLOG_RECV: 215}
    sources = {'NONE': 0, 'URL_REQUEST': 1, NETLOG_SESSION: 9}
    constants = {'logCaptureMode': 'Default', 'clientInfo': {'name': 'synthetic'}, 'logEventTypes': types,
                 'logSourceType': sources}

    def block(kind, stream, headers, session=7):
        return {'type': types[kind], 'source': {'id': session, 'type': sources[NETLOG_SESSION], 'start_time': '1'},
                'phase': 0, 'params': {'headers': list(headers), 'stream_id': stream, 'fin': kind == NETLOG_SEND}}

    def other(kind, source, params):
        return {'type': types[kind], 'source': {'id': source, 'type': sources['URL_REQUEST'], 'start_time': '2'},
                'phase': 1, 'params': params}

    def request(method, path, *more):
        return [':method: ' + method, ':authority: ' + authority, ':scheme: https', ':path: ' + path] + list(more)
    worklet_response = [':status: 200', 'content-type: text/javascript', 'cross-origin-opener-policy: same-origin',
                        'cross-origin-embedder-policy: require-corp', 'x-content-type-options: nosniff',
                        'set-cookie: [12 bytes were stripped]', 'cookie: [7 bytes were stripped]']
    events = [block(NETLOG_SEND, 1, request('GET', MAIN_PATH, 'sec-fetch-dest: document', 'cookie: [20 bytes were stripped]')),
              block(NETLOG_RECV, 1, [':status: 200', 'content-type: text/html', 'cross-origin-opener-policy: same-origin',
                                     'cross-origin-embedder-policy: require-corp']),
              block(NETLOG_SEND, 3, request('GET', WORKLET_PATH, 'sec-fetch-dest: audioworklet', 'sec-fetch-mode: cors',
                                            'sec-fetch-site: same-origin', 'cookie: [20 bytes were stripped]')),
              block(NETLOG_RECV, 3, worklet_response),
              block(NETLOG_SEND, 5, request('POST', DICTATION_PATH % uid, 'content-type: audio/wav', 'x-kin-csrf: 1')),
              block(NETLOG_RECV, 5, [':status: 503', 'content-type: application/json'])]

    def framed(consts, rows, polled=None, complete=True):
        """The writer's framing: a header, each event followed by ',\\n'; Stop rewinds the last ',\\n' and writes
        ']', optionally polledData, and '}\\n'."""
        text = '{"constants":%s,\n"events": [\n' % json.dumps(consts) + ''.join(
            json.dumps(dict(row, time=str(4000 + n))) + ',\n' for n, row in enumerate(rows))
        if complete:
            text = (text[:-2] if rows else text) + ']' + \
                (',\n"polledData": %s\n' % json.dumps(polled) if polled is not None else '') + '}\n'
        return text.encode('utf-8')

    def variant(change, polled=None):
        consts, rows = copy.deepcopy(constants), copy.deepcopy(events)
        change(consts, rows)
        return framed(consts, rows, polled)

    def lines(row):
        return row['params']['headers']

    def swap(row, old, new):
        lines(row)[lines(row).index(old)] = new       # a vector whose line is gone raises instead of passing silently

    class Clock:
        now = 1000.0

        def time(self):
            return self.now

        def sleep(self, seconds):
            self.now += max(seconds, 0.001)

    class Source:
        """The file as read from each time on (seconds after launch): None is no file, an exception is raised."""

        def __init__(self, clock, frames):
            self.clock, self.frames, self.reads = clock, frames, []

        def read_bytes(self):
            at = round(self.clock.now - 1000.0, 3)
            self.reads.append(at)
            value = None
            for start, frame in self.frames:
                value = frame if at >= start else value
            if isinstance(value, Exception):
                raise value
            if value is None:
                raise FileNotFoundError('synthetic')
            return value

    def judge(data=None, frames=None, uid=uid, window=10.0, debug='', hide=(), limit=NETLOG_MAX_BYTES):
        clock = Clock()
        source = Source(clock, frames if frames is not None else
                        [(NETLOG_SECONDS + 1, framed(constants, events) if data is None else data)])
        result = netlog_p10(source, 1000.0, 1000.0 + window, uid, authority, lambda: debug, list(hide), limit,
                            clock.time, clock.sleep)
        return result, source

    # The sample passes, and its extract is exactly the allowlist: the request's seven values, the response's
    # allowlisted values, every response header name as a list member - set-cookie and cookie included (F2) -
    # unchanged by sanitize, and bound to the summary by its hash.
    good, source = judge()
    extract = json.loads(good['text'])
    exchange = extract.get('exchange') or {}
    if good['classes'] or not good['status_ok'] or not good['policy_ok']:
        problems.append('the NetLog sample must pass both worklet limbs: %r' % good['classes'])
    if exchange.get('request') != {':method': ['GET'], ':scheme': ['https'], ':authority': [authority],
                                   ':path': [WORKLET_PATH], 'sec-fetch-dest': ['audioworklet'],
                                   'sec-fetch-mode': ['cors'], 'sec-fetch-site': ['same-origin']} or \
            exchange.get('response') != {':status': ['200'], 'content-type': ['text/javascript'],
                                         'cross-origin-opener-policy': ['same-origin'],
                                         'cross-origin-embedder-policy': ['require-corp'],
                                         'x-content-type-options': ['nosniff']} or \
            exchange.get('response_header_names') != [':status', 'content-type', 'cross-origin-opener-policy',
                                                      'cross-origin-embedder-policy', 'x-content-type-options',
                                                      'set-cookie', 'cookie'] or \
            (exchange.get('session'), exchange.get('stream')) != (7, 3) or \
            extract.get('post') != {'count': 1, 'after_worklet': [True]} or len(extract.get('main_calibration')) != 1:
        problems.append('the NetLog sample extract must hold exactly the allowlisted values and the header names')
    if set(extract) != {'instrument', 'netlog_seconds', 'deadline_seconds', 'window_limit_seconds', 'window_s', 'reads',
                        'read_at_s', 'raw', 'guards', 'mode', 'events', 'counts', 'exchange', 'post', 'main_calibration',
                        'classes', 'details'} or \
            set(exchange) != {'session', 'stream', 'request_index', 'response_index', 'request_time', 'response_time',
                              'request', 'response', 'response_header_names', 'response_header_names_withheld',
                              'request_sha256', 'response_sha256'} or \
            set(extract['raw']) != {'present', 'parsed', 'bytes', 'sha256'} or \
            set(good['summary']) != {'classes', 'details', 'raw', 'mode', 'window_s', 'read_at_s', 'reads', 'exchange',
                                     'post', 'extract', 'extract_sha256'}:
        problems.append('the NetLog extract and summary must carry exactly their declared fields')
    if measurement_ci.sanitize(good['text'], []) != good['text'] or \
            good['summary'].get('extract_sha256') != sha256(good['text'].encode('utf-8')):
        problems.append('the NetLog extract must be sanitize-stable and bound to the summary by its hash (F2)')
    if good['headers'] != {'content-type': 'text/javascript', 'cross-origin-opener-policy': 'same-origin',
                           'cross-origin-embedder-policy': 'require-corp', 'x-content-type-options': 'nosniff'}:
        problems.append('the recorded worklet headers must be the allowlisted response values')
    # Q3/B4 on the fake clock: no read before NETLOG_SECONDS; completion is the parse, seen as soon as it holds.
    if min(source.reads) < NETLOG_SECONDS or extract.get('read_at_s') != NETLOG_SECONDS + 1:
        problems.append('the NetLog wait must not read before %d s and must stop at completion' % NETLOG_SECONDS)
    stuck, source = judge(frames=[(0, framed(constants, events, complete=False))])
    if stuck['classes'] != ['NETLOG-INCOMPLETE'] or min(source.reads) < NETLOG_SECONDS or \
            max(source.reads) != NETLOG_DEADLINE_SECONDS:
        problems.append('an unchanging unfinished log must be polled until the deadline and never read after it')
    # Unrelated credential-bearing traffic around the one exchange: nothing of it reaches any output.
    canaries = ['KINCANARY%02d' % n for n in range(11)]

    def noisy(consts, rows):
        consts['clientInfo'] = {'name': canaries[0]}
        swap(rows[2], 'cookie: [20 bytes were stripped]', 'cookie: kin_session=' + canaries[1])
        lines(rows[2]).extend(['authorization: Bearer ' + canaries[2], 'x-kin-csrf: ' + canaries[3],
                               'referer: https://%s/?code=%s' % (authority, canaries[4])])
        swap(rows[3], 'set-cookie: [12 bytes were stripped]', 'set-cookie: kin_session=' + canaries[5])
        lines(rows[3]).append('x-kin=%s: 1' % canaries[10])     # a "name" carrying a value
        rows[0:0] = [block(NETLOG_SEND, 9, request('GET', '/auth/callback?code=%s&state=%s' % (canaries[6], canaries[7]))),
                     block(NETLOG_RECV, 9, [':status: 302', 'location: https://%s/?code=%s' % (authority, canaries[8])])]
        rows.append(other('URL_REQUEST_START_JOB', 21, {'url': 'https://%s/api/x?token=%s' % (authority, canaries[9]),
                                                        'method': 'GET'}))
    loud, _ = judge(variant(noisy, polled={'contexts': canaries}))
    if loud['classes'] or not loud['status_ok'] or not loud['policy_ok'] or 'kincanary' in json.dumps(loud).lower() or \
            measurement_ci.sanitize('set-cookie: kin_session=' + canaries[5], []) == 'set-cookie: kin_session=' + canaries[5]:
        problems.append('credential-bearing traffic must neither change the verdict nor reach any output: %r' % loud['classes'])
    with_polled, _ = judge(variant(lambda consts, rows: None, polled={'contexts': []}))
    if with_polled['classes'] or not with_polled['status_ok']:
        problems.append('a footer carrying polledData must parse: %r' % with_polled['classes'])

    def rows_changed(change):
        return {'data': variant(lambda consts, rows: change(rows))}

    def constants_changed(change):
        return {'data': variant(lambda consts, rows: change(consts))}

    def splice(rows, start, stop, new=()):
        rows[start:stop] = list(new)

    def http1(rows):
        splice(rows, 2, 4, [other('URL_REQUEST_START_JOB', 21, {'url': 'https://%s%s' % (authority, WORKLET_PATH),
                                                                'method': 'GET'}),
                            other('HTTP_TRANSACTION_SEND_REQUEST_HEADERS', 21,
                                  {'line': 'GET %s HTTP/1.1\r\n' % WORKLET_PATH, 'headers': ['Host: ' + authority]})])
    complete = framed(constants, events)
    unfinished = framed(constants, events, complete=False)
    path_line, coop_line = ':path: ' + WORKLET_PATH, 'cross-origin-opener-policy: same-origin'
    coep_line = 'cross-origin-embedder-policy: require-corp'
    worklet_again = [block(NETLOG_SEND, 9, request('GET', WORKLET_PATH)), block(NETLOG_RECV, 9, worklet_response)]
    vectors = (
        # Completeness: only the strict parse of the whole file counts.
        ('a log whose last event still ends in ",\\n"', {'frames': [(0, unfinished)]}, 'NETLOG-INCOMPLETE'),
        ('a log with only its header', {'frames': [(0, framed(constants, [], complete=False))]}, 'NETLOG-INCOMPLETE'),
        ('an empty file', {'data': b''}, 'NETLOG-INCOMPLETE'),
        ('no file by the deadline', {'frames': []}, 'NETLOG-INCOMPLETE'),
        ('a footer written only after the deadline',
         {'frames': [(0, unfinished), (NETLOG_DEADLINE_SECONDS + 1, complete)]}, 'NETLOG-INCOMPLETE'),
        ('a second document after the footer', {'data': complete + complete}, 'NETLOG-INCOMPLETE'),
        ('a torn UTF-8 character', {'data': complete.replace(b'text/html', b'text/\xe2\x82html')}, 'NETLOG-INCOMPLETE'),
        # Schema and source/stream mapping.
        ('an extra top-level key', {'data': complete[:-2] + b',\n"extra": 1}\n'}, 'NETLOG-SCHEMA'),
        ('no events list', {'data': b'{"constants":' + json.dumps(constants).encode('utf-8') + b'}\n'}, 'NETLOG-SCHEMA'),
        ('a duplicate key in an event', {'data': complete.replace(b'"phase": 0', b'"phase": 0, "phase": 0', 1)}, 'NETLOG-SCHEMA'),
        ('a non-finite number where no field is typed',
         {'data': complete.replace(b'"name": "synthetic"', b'"name": NaN', 1)}, 'NETLOG-SCHEMA'),
        ('a log above the parse bound', {'limit': len(complete) - 1}, 'NETLOG-SCHEMA'),
        ('no capture mode in the constants', constants_changed(lambda consts: consts.pop('logCaptureMode')), 'NETLOG-SCHEMA'),
        ('the request event type missing from the constants',
         constants_changed(lambda consts: consts['logEventTypes'].pop(NETLOG_SEND)), 'NETLOG-SCHEMA'),
        ('a second event name on the response event id',
         constants_changed(lambda consts: consts['logEventTypes'].update(OTHER_EVENT=types[NETLOG_RECV])), 'NETLOG-SCHEMA'),
        ('no HTTP2_SESSION source type', constants_changed(lambda consts: consts['logSourceType'].pop(NETLOG_SESSION)), 'NETLOG-SCHEMA'),
        ('the session source id reused under another source type',
         rows_changed(lambda rows: rows.append(other('URL_REQUEST_START_JOB', 7, {}))), 'NETLOG-SCHEMA'),
        ('a header block on a URL_REQUEST source',
         rows_changed(lambda rows: rows[1]['source'].update(id=11, type=sources['URL_REQUEST'])), 'NETLOG-SCHEMA'),
        ('a header line that is not "name: value"',
         rows_changed(lambda rows: swap(rows[0], 'sec-fetch-dest: document', 'sec-fetch-dest document')), 'NETLOG-SCHEMA'),
        ('a boolean stream id', rows_changed(lambda rows: rows[4]['params'].update(stream_id=True)), 'NETLOG-SCHEMA'),
        ('an event without a phase', rows_changed(lambda rows: rows[5].pop('phase')), 'NETLOG-SCHEMA'),
        ('two request blocks on one session stream', rows_changed(lambda rows: rows.append(copy.deepcopy(rows[0]))), 'NETLOG-SCHEMA'),
        # Mode: the forbidden names are assembled here, never written whole (F1).
        ('a sensitive-including log', constants_changed(lambda consts: consts.update(logCaptureMode='Include' + 'Sensitive')),
         'NETLOG-MODE'),
        ('a log with socket bytes', constants_changed(lambda consts: consts.update(logCaptureMode='Every' + 'thing')), 'NETLOG-MODE'),
        ('a heavily redacted log', constants_changed(lambda consts: consts.update(logCaptureMode='Heavily' + 'Redacted')),
         'NETLOG-MODE'),
        # The one exchange: protocol, full URL and method.
        ('no worklet exchange', rows_changed(lambda rows: splice(rows, 2, 4)), 'NETLOG-NO-STREAM'),
        ('the worklet over HTTP/1 only', rows_changed(http1), 'NETLOG-NOT-H2'),
        ('the worklet from another port',
         rows_changed(lambda rows: swap(rows[2], ':authority: ' + authority, ':authority: localhost:9444')), 'NETLOG-NO-STREAM'),
        ('the worklet over :scheme http', rows_changed(lambda rows: swap(rows[2], ':scheme: https', ':scheme: http')), 'NETLOG-NO-STREAM'),
        ('the only worklet request with a query', rows_changed(lambda rows: swap(rows[2], path_line, path_line + '?v=1')),
         'NETLOG-NO-STREAM'),
        ('the worklet requested with POST', rows_changed(lambda rows: swap(rows[2], ':method: GET', ':method: POST')), 'NETLOG-NO-STREAM'),
        ('a second :method pseudo-header', rows_changed(lambda rows: lines(rows[2]).append(':method: GET')), 'NETLOG-NO-STREAM'),
        ('no :authority pseudo-header', rows_changed(lambda rows: lines(rows[2]).remove(':authority: ' + authority)), 'NETLOG-NO-STREAM'),
        # Duplicates, retries, preloads and a second session.
        ('an added worklet request with a query',
         rows_changed(lambda rows: rows.insert(4, block(NETLOG_SEND, 9, request('GET', WORKLET_PATH + '?v=1')))), 'NETLOG-AMBIGUOUS'),
        ('an added HEAD of the worklet', rows_changed(lambda rows: rows.insert(4, block(NETLOG_SEND, 9, request('HEAD', WORKLET_PATH)))),
         'NETLOG-AMBIGUOUS'),
        ('a retried worklet GET on a new stream', rows_changed(lambda rows: splice(rows, 4, 4, worklet_again)), 'NETLOG-AMBIGUOUS'),
        ('the worklet GET on a second session',
         rows_changed(lambda rows: rows.insert(4, block(NETLOG_SEND, 1, request('GET', WORKLET_PATH), session=8))), 'NETLOG-AMBIGUOUS'),
        ('an interim response before the 200', rows_changed(lambda rows: rows.insert(3, block(NETLOG_RECV, 3, [':status: 103']))),
         'NETLOG-AMBIGUOUS'),
        ('trailers after the 200', rows_changed(lambda rows: rows.insert(4, block(NETLOG_RECV, 3, ['x-trailer: 1']))), 'NETLOG-AMBIGUOUS'),
        ('the 200 only on another stream', rows_changed(lambda rows: rows[3]['params'].update(stream_id=9)), 'NETLOG-NO-RESPONSE'),
        ('the worklet stream answered on another session', rows_changed(lambda rows: rows[3]['source'].update(id=8)),
         'NETLOG-NO-RESPONSE'),
        ('the response logged before its request', rows_changed(lambda rows: rows.insert(2, rows.pop(3))), 'NETLOG-ORDER'),
        # The bound exchange itself: P10 fails without an INSTRUMENTATION class.
        ('a 304 for the worklet', rows_changed(lambda rows: swap(rows[3], ':status: 200', ':status: 304')), 'status'),
        ('a 302 for the worklet', rows_changed(lambda rows: swap(rows[3], ':status: 200', ':status: 302')), 'status'),
        ('two :status lines', rows_changed(lambda rows: lines(rows[3]).append(':status: 200')), 'status'),
        ('no COOP', rows_changed(lambda rows: lines(rows[3]).remove(coop_line)), 'policy'),
        ('COOP twice', rows_changed(lambda rows: lines(rows[3]).append(coop_line)), 'policy'),
        ('COOP unsafe-none', rows_changed(lambda rows: swap(rows[3], coop_line, 'cross-origin-opener-policy: unsafe-none')), 'policy'),
        ('COEP credentialless', rows_changed(lambda rows: swap(rows[3], coep_line, 'cross-origin-embedder-policy: credentialless')),
         'policy'),
        ('no COEP', rows_changed(lambda rows: lines(rows[3]).remove(coep_line)), 'policy'),
        # The window: the PATH POST logged once after the worklet, and the clock.
        ('no PATH POST', rows_changed(lambda rows: splice(rows, 4, 6)), 'NETLOG-WINDOW'),
        ('the PATH POST before the worklet', rows_changed(lambda rows: splice(rows, 2, 6, rows[4:6] + rows[2:4])), 'NETLOG-WINDOW'),
        ('two PATH POSTs', rows_changed(lambda rows: rows.append(block(NETLOG_SEND, 11, request('POST', DICTATION_PATH % uid)))),
         'NETLOG-WINDOW'),
        ('the POST of another study', {'uid': '1.2.4'}, 'NETLOG-WINDOW'),
        ('no study uid', {'uid': None}, 'NETLOG-WINDOW'),
        ('test 01 ending %d s after launch' % (NETLOG_WINDOW_SECONDS + 1), {'window': NETLOG_WINDOW_SECONDS + 1.0}, 'NETLOG-WINDOW'),
        # F3: a present line fails.
        ('the open-failure line', {'debug': '[pid=9][err] [ERROR:x.cc(759)] %s/r/netlog.json' % NETLOG_GUARDS[0][1]}, 'NETLOG-OPEN'),
        ('the restart line', {'debug': '[pid=9][err] [ERROR:x.cc(702)] %s' % NETLOG_GUARDS[1][1]}, 'NETLOG-RESTART'),
        # Publication: whatever sanitize would change is withheld and fails.
        ('a masked value in an allowlisted header', {'hide': ('text/javascript',)}, 'NETLOG-LEAK'),
        ('a JWT-shaped allowlisted value', rows_changed(lambda rows: swap(
            rows[3], 'content-type: text/javascript', 'content-type: eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl')), 'NETLOG-LEAK'),
        ('a bearer-shaped allowlisted value', rows_changed(lambda rows: lines(rows[3]).append('cache-control: bearer abcdef0123')),
         'NETLOG-LEAK'),
        ('an unreadable log', {'frames': [(0, PermissionError('synthetic'))]}, 'NETLOG-ERROR'))
    exercised = set()
    for label, arguments, expected in vectors:
        result, _ = judge(**arguments)
        exercised.add(expected)
        if expected == 'status':
            ok = not result['classes'] and not result['status_ok'] and result['policy_ok']
        elif expected == 'policy':
            ok = not result['classes'] and result['status_ok'] and not result['policy_ok']
        else:
            ok = result['classes'] == [expected] and not result['status_ok'] and not result['policy_ok']
        if not ok:
            problems.append('NetLog: %s must fail as %s alone, got %r' % (label, expected, result['classes']))
        if measurement_ci.sanitize(result['text'], list(arguments.get('hide', ()))) != result['text']:
            problems.append('NetLog: the written text for %s must be sanitize-stable' % label)
    if set(NETLOG_CLASSES) - exercised:
        problems.append('NetLog classes no vector produces: %r' % sorted(set(NETLOG_CLASSES) - exercised))
    # F4 on values: the one accepted shape, then each refusal.
    roots = (PurePosixPath('/elsewhere/dictation-live'), PurePosixPath('/w/tests/e2e/artifacts'), PurePosixPath('/w/tmp'))
    if netlog_path_problems(PurePosixPath('/home/runner/work/_temp/u4l-netlog/0123abcd/netlog.json'), roots):
        problems.append('a private NetLog path under RUNNER_TEMP must be accepted')
    for label, path in (('a space', '/home/runner/work/_temp/u4l netlog/netlog.json'), ('a tab', '/r/a\tb/netlog.json'),
                        ('an "="', '/r/a=b/netlog.json'), ('a single quote', "/r/a'b/netlog.json"),
                        ('a double quote', '/r/a"b/netlog.json'), ('a relative path', 'u4l-netlog/netlog.json'),
                        ('the relocated artifact directory', '/elsewhere/dictation-live/u4l-netlog/netlog.json'),
                        ('the uploaded artifact tree', '/w/tests/e2e/artifacts/u4l-netlog/netlog.json'),
                        ("the repository's tmp", '/w/tmp/u4l-netlog/netlog.json'), ('a root itself', '/w/tmp')):
        if not netlog_path_problems(PurePosixPath(path), roots):
            problems.append('F4 must refuse a NetLog path with ' + label)
    for proxy, expected in (('https://localhost:9443', 'localhost:9443'), ('https://LocalHost:443', 'localhost'),
                            ('https://localhost', 'localhost'), ('https://localhost:9443/', 'localhost:9443')):
        if proxy_authority(proxy) != expected:
            problems.append('proxy_authority(%s) must be %s' % (proxy, expected))
    return problems


def emit(tag, value):
    print('%s %s' % (tag, json.dumps(value, ensure_ascii=False, default=lambda o: '<%s>' % type(o).__name__)), flush=True)


def write_json(name, value):
    (ARTIFACTS / name).write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                             default=lambda o: '<%s>' % type(o).__name__) + '\n', encoding='utf-8')


class Stop(Exception):
    """A step whose precondition failed; the steps after it could only measure the same failure again."""

    def __init__(self, what, detail=None):
        super().__init__(what)
        self.what, self.detail = what, detail


class Run:
    """One adjudication line: named checks per limb, the steps reached and the raw observations."""

    def __init__(self, line, limbs):
        self.line, self.limbs = line, {limb: [] for limb in limbs}
        self.page = self.cdp = self.pre = self.strings = None
        self.post_request = self.post_response = self.body = self.frames = None
        self.reached, self.observed, self.log_entries, self.classes = [], {}, [], []
        self.error, self.aborted_after, self.started = None, None, time.monotonic()

    def js(self, name, arg=None):
        return self.page.evaluate(PROBES[name], arg)

    def check(self, limb, name, ok, detail=None):
        self.limbs[limb].append({'name': name, 'ok': bool(ok), 'detail': detail})
        return bool(ok)

    def require(self, limb, name, ok, detail=None):
        if not self.check(limb, name, ok, detail):
            raise Stop('%s %s' % (limb, name), detail)

    def session(self):
        try:
            return self.js('session')
        except Exception as error:
            return {'unreadable': short(error)}

    def primary(self):
        """What the page says now: the first cause, not the wait that followed it."""
        out = {'session': self.session()}
        for name in ('pane', 'media'):
            try:
                out[name] = self.js(name)
            except Exception as error:
                out[name] = {'unreadable': short(error)}
        out['log_tail'] = self.log_entries[-10:]
        return out

    def wait_session(self, target, since, seconds=WAIT_SECONDS):
        """Polled from Python, one evaluate per step. Only states of a run newer than `since` count, so the
        previous pass's terminal state is never read as this run's outcome."""
        deadline = time.monotonic() + seconds
        while True:
            snap = self.session()
            newer = isinstance(snap.get('asrSeq'), int) and snap['asrSeq'] > since
            if newer and snap.get('state') == target:
                return snap
            terminal = newer and snap.get('state') in TERMINAL_STATES
            if terminal or time.monotonic() >= deadline:
                raise Stop('state ' + target, {'target': target, 'since': since, 'session': snap,
                                               'ended_by': 'terminal-state' if terminal else 'deadline',
                                               'primary': self.primary()})
            self.page.wait_for_timeout(50)

    def wait_true(self, name, arg=None, since=None, seconds=WAIT_SECONDS):
        deadline, last = time.monotonic() + seconds, None
        while True:
            try:
                if self.js(name, arg) is True:
                    return
            except Exception as error:
                last = short(error)
            snap = self.session() if since is not None else {}
            terminal = since is not None and isinstance(snap.get('asrSeq'), int) and snap['asrSeq'] > since and \
                snap.get('state') in TERMINAL_STATES
            if terminal or time.monotonic() >= deadline:
                raise Stop(name, {'arg': arg, 'last_error': last, 'ended_by': 'terminal-state' if terminal else 'deadline',
                                  'primary': self.primary()})
            self.page.wait_for_timeout(50)

    def need(self, limb, name, wait):
        """A named wait whose failure is this limb's failed check (with the page's primary cause)."""
        try:
            value = wait()
        except Stop as stop:
            self.check(limb, name, False, stop.detail)
            raise
        self.check(limb, name, True)
        return value

    def limb_verdicts(self):
        return {limb: {'pass': bool(checks) and all(c['ok'] for c in checks), 'checks': checks}
                for limb, checks in self.limbs.items()}


class Net:
    """What the browser sent and received for /api/**, main.html and the worklet, in order. Request and
    Response objects are kept so headers are read after the action, outside the event handler."""

    def __init__(self):
        self.t0 = time.monotonic()
        self.requests, self.responses, self.failures, self.errors = [], [], [], []

    def now(self):
        return round(time.monotonic() - self.t0, 3)

    @staticmethod
    def watched(url):
        path = urlsplit(url).path
        return path.startswith('/api/') or path in (MAIN_PATH, WORKLET_PATH)

    def on_request(self, request):
        try:
            if self.watched(request.url):
                split = urlsplit(request.url)
                self.requests.append({'t': self.now(), 'method': request.method, 'path': split.path,
                                      'query': bool(split.query), 'type': request.resource_type, 'obj': request})
        except Exception as error:
            self.errors.append(short(error))

    def on_response(self, response):
        try:
            if self.watched(response.url):
                self.responses.append({'t': self.now(), 'method': response.request.method, 'path': urlsplit(response.url).path,
                                       'status': response.status, 'type': response.request.resource_type, 'obj': response})
        except Exception as error:
            self.errors.append(short(error))

    def on_failed(self, request):
        try:
            if self.watched(request.url):
                self.failures.append({'t': self.now(), 'method': request.method, 'path': urlsplit(request.url).path,
                                      'failure': request.failure})
        except Exception as error:
            self.errors.append(short(error))

    def plain(self):
        strip = lambda rows: [{k: v for k, v in row.items() if k != 'obj'} for row in rows]
        return {'requests': strip(self.requests), 'responses': strip(self.responses), 'failures': self.failures,
                'errors': self.errors}


class _Prepared:
    """The capture browser seen through the base's `self.browser`: every new context is prepared before its
    first page exists, so the base login() runs unchanged and its first navigation is already observed."""

    def __init__(self, browser, prepare):
        self._browser, self._prepare = browser, prepare

    def new_context(self, **kwargs):
        context = self._browser.new_context(**kwargs)
        try:
            self._prepare(context)
        except Exception:
            context.close()
            raise
        return context

    def __getattr__(self, name):
        return getattr(self._browser, name)


class DictationLiveE2E(test_worklist.WorklistE2E):
    # D1: the base's own launch (test_worklist.py:98-102) becomes full Chromium too; it stays idle.
    browser_channel = 'chromium'

    @classmethod
    def setUpClass(cls):
        record = {'first_read': True}
        cls.capture_browser = cls.fixture_path = cls.capture_version = None
        cls.netlog_dir = cls.netlog_path = cls.netlog_t0 = cls.netlog_removed = None
        cls.hide = ()
        try:
            ARTIFACTS.mkdir(parents=True, exist_ok=False)     # a fresh directory inside the uploaded artifact path
            cls.browser_log = (ARTIFACTS / 'browser-debug.log').resolve()
            # Registered before the base's cleanups, so it runs after every browser and the driver have closed.
            cls.addClassCleanup(cls.finalize_artifacts)
            # The pw:browser log names the binary each launch actually started. The driver reads these two at its
            # start inside super().setUpClass() (test_worklist.py:96), so they are set before it, as the readiness
            # fixes; the base's earlier docker/psql checks inherit them too and are judged by stdout and exit
            # status only. They are restored once the driver runs, so no later child process sees them.
            saved = {name: os.environ.get(name) for name in ('DEBUG', 'DEBUG_FILE')}
            os.environ['DEBUG'] = 'pw:browser'
            os.environ['DEBUG_FILE'] = str(cls.browser_log)
            try:
                super().setUpClass()
            finally:
                for name, value in saved.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
            cls.hide = tuple(value for value in cls.stack.passwords.values() if value and len(value) >= 8)
            wav = signal.fixture_wav()
            if sha256(wav) != signal.FIXTURE_SHA256:
                raise AssertionError('the fixture does not regenerate to its pin')
            cls.fixture_path = (ARTIFACTS / 'fixture.wav').resolve()
            cls.fixture_path.write_bytes(wav)
            # F4: a fresh private directory outside everything uploaded or kept, refused before launch otherwise.
            # Its removal is registered before the launch, so it runs after the capture browser has closed.
            directory = (netlog_root() / uuid.uuid4().hex).resolve()
            refused = netlog_path_problems(directory / 'netlog.json', netlog_forbidden_roots())
            if refused:
                raise AssertionError('NetLog path refused before launch: ' + '; '.join(refused))
            directory.parent.mkdir(parents=True, exist_ok=True)
            directory.mkdir(mode=0o700)
            cls.netlog_dir, cls.netlog_path = directory, directory / 'netlog.json'
            cls.addClassCleanup(cls.remove_netlog)
            cls.netlog_t0 = time.monotonic()       # before launch, so the log cannot stop before t0 + NETLOG_SECONDS
            cls.capture_browser = cls.pw.chromium.launch(channel="chromium", headless=True,
                                                         args=u4l_launch_args(cls.fixture_path, cls.netlog_path))
            cls.addClassCleanup(cls.capture_browser.close)
            cls.capture_version = cls.capture_browser.version
            first = cls.read_launch(seconds=5)
            from importlib.metadata import version
            record.update(launch=first, channel=CHANNEL, capture_version=cls.capture_version,
                          base_version=cls.browser.version, playwright=version('playwright'),
                          default_executable_path=cls.pw.chromium.executable_path,
                          fixture={'path': str(cls.fixture_path), 'sha256': sha256(wav), 'bytes': len(wav)},
                          netlog={'path': str(cls.netlog_path), 'seconds': NETLOG_SECONDS,
                                  'deadline_seconds': NETLOG_DEADLINE_SECONDS})
        except Exception:
            record['error'] = traceback.format_exc()[-2000:]
            raise
        finally:
            emit('U4L-LAUNCH', record)

    @classmethod
    def read_launch(cls, seconds=0):
        """The driver writes the log asynchronously; wait (bounded) for both launch lines, never invent them."""
        until = time.monotonic() + seconds
        while True:
            try:
                text = cls.browser_log.read_text(encoding='utf-8', errors='replace')
            except OSError:
                text = ''
            verdict = launch_verdict(text, cls.fixture_path, cls.capture_version, cls.netlog_path)
            if len(verdict['records']) >= 2 or time.monotonic() >= until:
                return verdict
            time.sleep(0.05)

    @classmethod
    def remove_netlog(cls):
        """The raw log and its private directory go on every path: test 01 removes them right after judging, and
        this class cleanup, which runs after the capture browser closed, removes whatever is left. Only a kill
        at the unit deadline skips both; RUNNER_TEMP is then discarded with the hosted runner."""
        directory = cls.netlog_dir
        if directory is not None and directory.exists():
            shutil.rmtree(directory)
        cls.netlog_removed = directory is None or not directory.exists()
        if not cls.netlog_removed:
            raise RuntimeError('the private NetLog directory remains')

    @classmethod
    def hidden_values(cls):
        """What measurement_ci.sanitize must mask: the generated values it knows by name, and the test passwords."""
        return [os.environ[name] for name in generated_secret_names() if len(os.environ.get(name, '')) >= 8] + list(cls.hide)

    @classmethod
    def finalize_artifacts(cls):
        """Last class cleanup: the debug log is passed through measurement_ci.sanitize with the generated values
        from the environment (and this run's test passwords), then launch.json and manifest.json are written."""
        if not ARTIFACTS.is_dir():
            return
        failures, launch = [], {}
        names = generated_secret_names()
        values = [os.environ[name] for name in names if len(os.environ.get(name, '')) >= 8]
        try:
            text = cls.browser_log.read_text(encoding='utf-8', errors='replace')
            clean = measurement_ci.sanitize(text, values + list(cls.hide))
            if clean != text:
                cls.browser_log.write_text(clean, encoding='utf-8')
            launch = launch_verdict(clean, cls.fixture_path, cls.capture_version, cls.netlog_path)
            launch['sanitizer'] = {'generated_names': len(names), 'generated_values_present': len(values),
                                   'test_passwords': len(cls.hide),
                                   'hits': clean.count('[REDACTED') - text.count('[REDACTED')}
            launch['note'] = 'final read after every browser closed; P0 in the U4L-PATH line is the adjudicated limb'
            launch['netlog_private_removed'] = cls.netlog_removed
        except Exception as error:
            failures.append('browser log: %s' % short(error))
        try:
            write_json('launch.json', launch)
            manifest = {path.name: {'sha256': sha256(path.read_bytes()), 'bytes': path.stat().st_size}
                        for path in sorted(ARTIFACTS.iterdir()) if path.is_file() and path.name != 'manifest.json'}
            write_json('manifest.json', manifest)
        except Exception as error:
            failures.append('artifacts: %s' % short(error))
        if failures:
            raise RuntimeError('U4L artifact finalization failed: ' + '; '.join(failures))

    def setUp(self):
        super().setUp()
        self.net, self.bootstraps = Net(), []
        self.browser = _Prepared(type(self).capture_browser, self.prepare_context)

    # ── context preparation (readiness §3 a-d) ──────────────────────────────────────────────────
    def prepare_context(self, context):
        context.grant_permissions(['microphone'], origin=self.stack.proxy)
        context.add_init_script(script=OBSERVER)
        context.route(bootstrap_request, self.replace_bootstrap)
        context.on('request', self.net.on_request)
        context.on('response', self.net.on_response)
        context.on('requestfailed', self.net.on_failed)

    def replace_bootstrap(self, route):
        """The declared replacement: only `dictation.available` changes, and only from a real false. It never
        raises and never invents a response - a failed fetch is recorded and aborted (review N-3; the page's
        own three tries then end), and every refusal serves the real answer unmodified."""
        entry = {'n': len(self.bootstraps), 'outcome': None}
        self.bootstraps.append(entry)
        try:
            split = urlsplit(route.request.url)
            entry.update(path=split.path, query=split.query)
        except Exception as error:
            entry['url_error'] = short(error)
        try:
            real = route.fetch(timeout=WAIT_MS)
        except Exception as error:
            entry.update(outcome='fetch-failed', error=short(error))
            try:
                route.abort()
            except Exception as abort_error:
                entry['abort_error'] = short(abort_error)
            return
        try:
            body = real.body()
            entry.update(status=real.status, real_sha256=sha256(body), real_bytes=len(body))
            original, reason = None, None
            if real.status != 200:
                reason = 'status-%d' % real.status
            else:
                try:
                    original = json.loads(body.decode('utf-8'))
                except ValueError:
                    reason = 'not-json'
            capability = original.get('dictation') if isinstance(original, dict) else None
            entry['real_capability'] = capability if isinstance(capability, dict) else None
            if reason is None and (not isinstance(capability, dict) or set(capability) != CAPABILITY_KEYS):
                reason = 'capability-keys'
            elif reason is None and capability.get('available') is not False:
                reason = 'available-not-false'
            if reason:
                route.fulfill(response=real)
                entry['outcome'] = 'refused:' + reason
                return
            replaced = copy.deepcopy(original)
            replaced['dictation']['available'] = True
            headers = {key: value for key, value in real.headers.items() if key.lower() not in BODY_BOUND_HEADERS}
            # The pinned client serializes json= with json.dumps defaults (_network.py:19,412): these bytes.
            entry.update(differing_paths=differing_paths(original, replaced),
                         fulfilled_sha256=sha256(json.dumps(replaced).encode('utf-8')),
                         dropped_headers=sorted(key.lower() for key in real.headers if key.lower() in BODY_BOUND_HEADERS))
            route.fulfill(response=real, json=replaced, headers=headers, content_type=real.headers.get('content-type'))
            entry['outcome'] = 'replaced'
        except Exception as error:
            entry.update(outcome='error', error=short(error))
            for label, fallback in (('real', lambda: route.fulfill(response=real)), ('abort', route.abort)):
                try:
                    fallback()
                    entry['fallback'] = label
                    break
                except Exception as fallback_error:
                    entry.setdefault('fallback_errors', []).append(short(fallback_error))

    # ── shared steps ────────────────────────────────────────────────────────────────────────────
    def attach_log(self, run):
        """D2: one raw CDP session per case, Log domain only; entries keep their raw source/level/text/url."""
        run.cdp = run.page.context.new_cdp_session(run.page)
        run.cdp.on('Log.entryAdded', lambda params: run.log_entries.append(log_entry(params)))
        run.cdp.send('Log.enable')

    def detach_log(self, run):
        if run.cdp is None:
            return
        for step in (lambda: run.page.wait_for_timeout(150), lambda: run.cdp.send('Log.disable'), lambda: run.cdp.detach()):
            try:
                step()
            except Exception as error:
                run.observed.setdefault('log_session_cleanup', []).append(short(error))
        run.cdp = None

    @staticmethod
    def uid_of(f):
        if not re.fullmatch(r'[0-9.]+', f.uid):
            raise RuntimeError('Invalid fixture UID')
        return f.uid

    def report_rows(self, f):
        uid = self.uid_of(f)
        return {table: test_worklist.psql('SELECT (to_jsonb(t))::text FROM "%s" t WHERE uid=\'%s\' '
                                          'ORDER BY (to_jsonb(t))::text COLLATE "C";' % (table, uid))
                for table in REPORT_TABLES}

    def dictation_audit(self, f):
        uid, rows = self.uid_of(f), []
        for raw in test_worklist.psql("SELECT actor || E'\\t' || coalesce(detail, '') FROM \"AuditLog\" WHERE target='%s' "
                                      "AND action='dictation.request' ORDER BY id;" % uid):
            actor, _, detail = raw.partition('\t')
            try:
                rows.append({'actor': actor, 'detail': json.loads(detail)})
            except ValueError:
                rows.append({'actor': actor, 'detail': None, 'raw': detail[:300]})
        return rows

    @staticmethod
    def field_values(page):
        return [page.locator('#' + name).input_value() for name in RFIELDS]

    def settle_dictation(self, run, close=False):
        """§6: a run still active after a failure is ended by the person's own controls - a real Cancel click
        when nothing covers it, otherwise Escape with focus in the pane - and the tracks are read afterwards."""
        page, out = run.page, {'by': None, 'ok': False}
        try:
            snap = run.session()
            if snap.get('state') in ACTIVE_STATES:
                cancel = run.js('geometry')['controls']['dictation-cancel']
                if cancel['present'] and cancel['own'] and not cancel['disabled']:
                    page.locator('#dictation-cancel').click(timeout=WAIT_MS)
                    out['by'] = 'cancel-click'
                else:
                    page.locator('#dictation-cancel').focus(timeout=WAIT_MS)
                    page.keyboard.press('Escape')
                    out['by'] = 'escape'
                deadline = time.monotonic() + WAIT_SECONDS
                while run.session().get('state') in ACTIVE_STATES and time.monotonic() < deadline:
                    page.wait_for_timeout(50)
            snap, tracks = run.session(), run.js('tracks')
            out.update(state=snap.get('state'), tracks=tracks)
            out['ok'] = 'unreadable' not in snap and snap.get('state') not in ACTIVE_STATES and \
                all(state == 'ended' for state in tracks)
        except Exception as error:
            out['error'] = short(error)
            out['ok'] = False
        # A pane that will not close is not a held microphone: the next pass's G0 reports it instead.
        if close and out['ok']:
            try:
                if not run.js('pane_hidden'):
                    out['closed_by'] = self.press_or_escape(run, 'dictation-close')
                    run.wait_true('pane_hidden')
            except Exception as error:
                out['close_error'] = short(error)
        return out

    def press_or_escape(self, run, control, scroll=None):
        """A real click when the control is present and own; otherwise Escape inside the pane, which the pane
        maps to Cancel while active and Close after (dictation.js:464-468). Returns which one happened.
        `scroll`, passed only by the review Cancel in geo_pass, receives the report column's scrollTop from this
        same read (record only): the B2 amendment's hosted check that the toggle probe left it where it was."""
        full = run.js('geometry')
        if scroll is not None:
            scroll['rightScrollTop'] = full.get('rightScrollTop')
        seen = full['controls'][control]
        if seen['present'] and seen['own'] and not seen['disabled']:
            run.page.locator('#' + control).click(timeout=WAIT_MS)
            return 'click'
        run.page.locator('#' + control).focus(timeout=WAIT_MS)
        run.page.keyboard.press('Escape')
        return 'escape (top %s)' % seen['topId']

    @staticmethod
    def answer(response):
        try:
            payload = response.json()
        except Exception as error:
            payload = {'unreadable': short(error)}
        return {'status': response.status, 'code': payload.get('code') if isinstance(payload, dict) else None}

    def response_record(self, response):
        headers = response.all_headers()
        return {'status': response.status, 'path': urlsplit(response.url).path, 'type': response.request.resource_type,
                'from_service_worker': response.from_service_worker, 'headers': allowlisted(headers, RESPONSE_HEADERS)}

    # ── G-LIVE-PATH ─────────────────────────────────────────────────────────────────────────────
    def test_dictation_live_01_path_real_api_not_configured(self):
        """G-LIVE-PATH (readiness §4, P0-P12): a real Dictate press records Chromium's fake device through the
        shipped worklet, and a real Stop posts the produced WAV to the real route, whose gate, raw parser and
        validator accept it before NOT_CONFIGURED - the one refusal raised only after validation
        (asr.service.ts:41). The AuditLog row binds the wire body and the validator's frames, the report is
        byte-identical, and the inherited cleanup (P12) leaves zero rows. Header delivery and the CDP Log are
        recorded; no route in this context matches the POST."""
        run, f = Run('G-LIVE-PATH', ['P%d' % n for n in range(12)]), None
        try:
            f = self.fixture()
            run.observed['uid'] = f.uid
            self.seed_report(f)
            run.reached.append('fixture')
            run.page = self.login()
            run.reached.append('login')
            self.attach_log(run)
            self.select(run.page, f)
            expect(run.page.locator('#findings')).to_have_value(f.secret)
            run.reached.append('selected')
            self.path_flow(run, f)
        except Stop:
            pass
        except Exception:
            run.error = traceback.format_exc()[-3000:]
            if run.page is not None:
                run.observed['primary_at_error'] = run.primary()
        finally:
            record = self.path_finish(run, f)
        self.assertTrue(record['pass'], 'G-LIVE-PATH failed limbs %s; see the U4L-PATH line' % record['failed_limbs'])

    def path_flow(self, run, f):
        page, dictation_path = run.page, DICTATION_PATH % f.uid
        run.pre = {'fields': self.field_values(page), 'rows': self.report_rows(f), 'audit': self.dictation_audit(f)}
        run.reached.append('pre-snapshot')
        env, permission = run.js('environment'), run.js('permission')
        run.observed.update(environment=env, permission=permission, crossOriginIsolated=env.get('crossOriginIsolated'))
        for key in ENVIRONMENT_TRUE:
            run.check('P2', key, env.get(key) is True, env.get(key))
        run.check('P2', 'permission-granted', permission == 'granted', permission)
        run.strings = run.js('strings')

        def enabled():
            deadline = time.monotonic() + WAIT_SECONDS
            while True:
                pane = run.js('pane')
                if pane['button'] and pane['button']['disabled'] is False or time.monotonic() >= deadline:
                    return pane
                page.wait_for_timeout(50)
        pane = enabled()
        run.check('P3', 'dictate-enabled', bool(pane['button']) and pane['button']['disabled'] is False, pane['button'])
        run.check('P3', 'title-ready', bool(pane['button']) and pane['button']['title'] == run.strings['ready'],
                  {'title': (pane['button'] or {}).get('title'), 'ready': run.strings['ready']})
        run.check('P3', 'pane-hidden', pane['hidden'] is True, pane['hidden'])
        if not pane['button'] or pane['button']['disabled'] is not False:
            raise Stop('P3 dictate-enabled', pane['button'])
        # Activation is recorded, never credited to the Dictate click: the search fill and the row click
        # before it were real input too, and Playwright may simulate a gesture for its own calls [U].
        run.observed['activation_before_press'] = run.js('activation')
        since, nodes_before = run.session().get('asrSeq', 0), len(run.js('media')['nodes'])
        run.observed['nodes_before_press'] = nodes_before
        page.locator('#b-dictate').click()
        run.reached.append('dictate-click')
        run.need('P4', 'state-recording', lambda: run.wait_session('recording', since))
        run.reached.append('recording')
        media = run.js('media')
        contexts, nodes, gum = media['contexts'], media['nodes'], media['gumCalls']
        run.observed['capture'] = {'contexts': contexts, 'nodes': nodes, 'gum': gum, 'tracks': media['tracks']}
        run.check('P4', 'one-context-16k-running', len(contexts) == 1 and contexts[0]['sampleRate'] == 16000 and
                  contexts[0]['state'] == 'running', contexts)
        options = nodes[0]['options'] if len(nodes) == 1 else None
        run.check('P4', 'one-node-options', len(nodes) == 1 and nodes[0]['name'] == 'kin-dictation-pcm' and
                  isinstance(options, dict) and options.get('channelCount') == 1 and
                  options.get('channelCountMode') == 'explicit' and options.get('outputChannelCount') == [1] and
                  (options.get('processorOptions') or {}).get('maxFrames') == MAX_FRAMES, nodes)
        audio = [track for track in media['tracks'] if track['kind'] == 'audio']
        run.check('P4', 'one-granted-capture', len(gum) == 1 and gum[0]['outcome'] == 'resolved' and len(audio) >= 1, gum)
        presses = [c for c in run.js('clicks') if c['id'] == 'b-dictate']
        run.observed['activation'] = {'at_press': presses[-1]['activation'] if presses else None,
                                      'at_context_construct': contexts[0]['activation'] if contexts else None,
                                      'attributed_to_the_click': False}
        run.need('P4', 'recorded-1500ms', lambda: run.wait_true('recorded_since', [nodes_before, 1500], since))
        run.reached.append('recorded-1500ms')
        stop = run.js('geometry')['controls']['dictation-stop']
        run.require('P4', 'stop-reachable', stop['present'] and stop['own'] and not stop['disabled'], stop)
        with page.expect_response(lambda r: r.request.method == 'POST' and urlsplit(r.url).path == dictation_path,
                                  timeout=WAIT_MS) as reply:
            page.locator('#dictation-stop').click()
        run.reached.append('stop-click')
        response = run.post_response = reply.value
        request = run.post_request = response.request
        run.reached.append('post-answered')
        # P5: what went on the wire.
        headers = request.all_headers()
        run.observed['post_request'] = {'headers': allowlisted(headers, REQUEST_HEADERS),
                                        'authz_header_absent': 'authorization' not in headers}
        run.check('P5', 'content-type-audio-wav', headers.get('content-type') == 'audio/wav', headers.get('content-type'))
        run.check('P5', 'csrf-header', headers.get('x-kin-csrf') == '1', headers.get('x-kin-csrf'))
        run.check('P5', 'no-credential-header', 'authorization' not in headers)
        body = request.post_data_buffer
        declared = headers.get('content-length')
        if body is None or (declared is not None and declared != str(len(body))):
            run.classes.append('INSTRUMENTATION:A-B')
        run.check('P5', 'post-data-buffer-complete', body is not None and (declared is None or declared == str(len(body))),
                  {'bytes': None if body is None else len(body), 'content_length': declared})
        if body is not None:
            run.body = body
            (ARTIFACTS / 'path-body.wav').write_bytes(body)
            verdict = signal.judge(body, MAX_BYTES)
            reasons = [reason for reason in verdict['signal']['reasons'] if reason != 'all-zero']
            windows = verdict['signal']['windows']
            run.frames = verdict['layout']['frames']
            clicks = run.js('clicks')
            t0 = nodes[0]['t'] if nodes else None
            t1 = next((c['t'] for c in clicks if c['id'] == 'dictation-stop'), None)
            run.observed['wire'] = {'sha256': verdict['sha256'], 'bytes': len(body), 'layout': verdict['layout'],
                                    'windows': windows, 'reasons': reasons, 'all_zero': verdict['signal']['all_zero'],
                                    'u5': {'t0_ms': t0, 't1_ms': t1, 'frames': run.frames}}
            run.check('P5', 'U2-producer-layout', verdict['layout']['ok'], verdict['layout']['reasons'])
            run.check('P5', 'U3-spectral', not reasons and len(windows) >= 1,
                      {'reasons': reasons, 'windows': len(windows), 'expected_windows': 2})
            run.check('P5', 'U4-non-zero', verdict['signal']['all_zero'] is False)
            run.check('P5', 'U5-duration', not u5_problems(t0, t1, run.frames), u5_problems(t0, t1, run.frames))
        # P6: the real answer, from the real route.
        answer = self.answer(response)
        run.observed['post_answer'] = answer
        run.check('P6', 'status-503', response.status == 503, response.status)
        run.check('P6', 'code-not-configured', answer['code'] == 'DICTATION_NOT_CONFIGURED', answer)
        run.check('P6', 'not-from-service-worker', response.from_service_worker is False, response.from_service_worker)
        run.check('P6', 'no-context-route-matches-the-post', bootstrap_request(response.url) is False,
                  {'context_routes': ['bootstrap_request'], 'post_path': urlsplit(response.url).path})
        # P7: the pane says the stack is not connected and the microphone is released.
        run.need('P7', 'state-failed', lambda: run.wait_session('failed', since))
        run.reached.append('failed')
        run.js('frames2')
        snap, pane = run.session(), run.js('pane')
        expected = (run.strings['reasons'].get('DICTATION_NOT_CONFIGURED') or '') + UNCHANGED
        run.observed['failed'] = {'session': snap, 'pane': pane}
        run.check('P7', 'pane-text', pane['status'] == expected == PANE_NOT_CONFIGURED,
                  {'shown': pane['status'], 'expected': expected})
        run.check('P7', 'close-enabled', pane['controls']['close'] == {'hidden': False, 'disabled': False},
                  pane['controls']['close'])
        tracks = run.js('tracks')
        run.check('P7', 'tracks-ended', bool(tracks) and all(state == 'ended' for state in tracks), tracks)
        run.need('P7', 'contexts-closed', lambda: run.wait_true('contexts_closed'))
        run.reached.append('released')

    def path_finish(self, run, f):
        """Every limb that can still be judged is judged here, whatever stopped the flow; the line is printed
        before the inherited cleanup (P12) runs."""
        page = run.page
        if page is not None:
            run.observed['settle'] = self.settle_dictation(run)
        if f is not None and page is not None:
            try:
                fields, rows = self.field_values(page), self.report_rows(f)
                pre = run.pre or {}
                run.observed['post_rows'] = {table: len(value) for table, value in rows.items()}
                run.check('P8', 'fields-byte-equal', pre.get('fields') is not None and fields == pre['fields'],
                          {'pre_taken': pre.get('fields') is not None})
                run.check('P8', 'report-rows-byte-equal', pre.get('rows') is not None and rows == pre['rows'],
                          {table: len(value) for table, value in rows.items()})
                writes = forbidden_writes(self.net.requests, f.uid)
                run.check('P8', 'no-report-writes', not writes, writes)
            except Exception as error:
                run.check('P8', 'readable', False, short(error))
            try:
                after = self.dictation_audit(f)
                before = (run.pre or {}).get('audit')
                run.observed['audit'] = after
                run.check('P9', 'no-row-before', before == [], before)
                problems = audit_problems(before or [], after, None if run.body is None else len(run.body), run.frames)
                run.check('P9', 'one-row-binds-body-and-frames', not problems, problems)
            except Exception as error:
                run.check('P9', 'readable', False, short(error))
            posts = [e for e in self.net.requests if e['method'] == 'POST' and e['path'] == DICTATION_PATH % f.uid]
            run.check('P5', 'exactly-one-post', len(posts) == 1, len(posts))
            try:
                self.delivered_headers(run)
            except Exception as error:
                run.check('P10', 'readable', False, short(error))
        if page is not None:
            self.detach_log(run)
            verdict = csp_log_verdict(run.log_entries)
            run.check('P11', 'zero-csp-log-entries', not verdict['problems'], verdict['csp_entries'])
        launch = type(self).read_launch()
        run.observed['launch'] = launch
        for problem in launch['problems']:
            run.check('P0', 'launch', False, problem)
        if not launch['problems']:
            run.check('P0', 'launch', True, [r['executable'] for r in launch['records']])
        records = self.bootstraps
        run.check('P1', 'invoked', len(records) >= 1, len(records))
        for entry in records:
            run.check('P1', 'replaced #%d' % entry['n'], entry.get('outcome') == 'replaced', entry.get('outcome'))
            run.check('P1', 'real-capability #%d' % entry['n'], not capability_problems(entry.get('real_capability')),
                      capability_problems(entry.get('real_capability')))
            run.check('P1', 'only-dictation.available #%d' % entry['n'],
                      entry.get('differing_paths') == ['dictation.available'], entry.get('differing_paths'))
        # Last, because the log completes about NETLOG_SECONDS after launch: every other limb keeps its window.
        self.netlog_p10_step(run)
        limbs = run.limb_verdicts()
        failed = [limb for limb, verdict in limbs.items() if not verdict['pass']]
        if 'P0' in failed:
            run.classes.insert(0, 'LAUNCH')
        record = {'case': run.line, 'test': 'TEST-S3-ASR-U4L-PATH', 'pass': not failed and run.error is None,
                  'failed_limbs': failed, 'classes': sorted(set(run.classes)), 'reached': run.reached,
                  'limbs': limbs, 'error': run.error, 'elapsed_s': round(time.monotonic() - run.started, 3),
                  'P12': 'the inherited zero-row cleanup runs after this line; adjudicate it from test 01 unittest outcome',
                  'bootstraps': records, 'log_entry_count': len(run.log_entries), 'observed': run.observed}
        emit('U4L-PATH', record)
        try:
            write_json('path.json', dict(record, log_entries=run.log_entries, net=self.net.plain(), pre=run.pre))
        except Exception as error:
            record['pass'] = False
            record['artifact_error'] = short(error)
        return record

    def delivered_headers(self, run):
        """P10's main.html limbs from the browser-attributed document response. The worklet limbs and the recorded
        G-CSP input are completed from the NetLog at the end of the test (netlog_p10_step); Playwright's worklet
        response stays recorded with its count, and a direct GET of the worklet is a labelled control only."""
        mains = [e for e in self.net.responses if e['path'] == MAIN_PATH and e['type'] == 'document']
        worklets = [e for e in self.net.responses if e['path'] == WORKLET_PATH]
        seen = {'main': self.response_record(mains[-1]['obj']) if mains else None,
                'worklet': self.response_record(worklets[0]['obj']) if worklets else None,
                'post': self.response_record(run.post_response) if run.post_response is not None else None}
        observed = {'counts': {'main': len(mains), 'worklet': len(worklets)}, 'responses': seen,
                    'template_csp': TEMPLATE_CSP[0] if len(TEMPLATE_CSP) == 1 else None}
        run.observed['headers'] = observed
        main = seen['main']
        run.check('P10', 'main-200-html', bool(main) and main['status'] == 200 and
                  main['headers'].get('content-type', '').startswith('text/html'), main and main['headers'].get('content-type'))
        if seen['worklet'] is None:
            run.classes.append('INSTRUMENTATION:A-R')      # recorded; the worklet limbs are read from the NetLog
        headers = (main or {}).get('headers') or {}
        run.check('P10', 'main-coop-coep', headers.get('cross-origin-opener-policy') == 'same-origin' and
                  headers.get('cross-origin-embedder-policy') == 'require-corp',
                  [headers.get('cross-origin-opener-policy'), headers.get('cross-origin-embedder-policy')])
        try:
            control = run.page.context.request.get(self.stack.proxy + WORKLET_PATH, timeout=WAIT_MS)
            observed['control_direct_get'] = {'status': control.status, 'headers': allowlisted(control.headers, RESPONSE_HEADERS),
                                              'label': 'control only; never substituted for the browser-attributed response'}
        except Exception as error:
            observed['control_direct_get'] = {'error': short(error)}

    def netlog_p10_step(self, run):
        """P10's worklet limbs from the browser's own NetLog, judged in memory by netlog_p10; only its allowlisted
        extract is written, and the raw log is removed on every path. B5: the logged exchange is the one that
        delivered the module only together with the worklet having run in this PATH (P4) and the PATH POST logged
        after it, so all three are required here."""
        cls, t_end, result, removed = type(self), time.monotonic(), None, None
        try:
            if cls.netlog_path is None or cls.netlog_t0 is None:
                raise RuntimeError('the capture browser was not launched with a NetLog')
            result = netlog_p10(cls.netlog_path, cls.netlog_t0, t_end, run.observed.get('uid'),
                                proxy_authority(self.stack.proxy),
                                lambda: cls.browser_log.read_text(encoding='utf-8', errors='replace'), cls.hidden_values())
            (ARTIFACTS / NETLOG_EXTRACT).write_bytes(result['text'].encode('utf-8'))
        except Exception as error:
            run.check('P10', 'netlog-readable', False, type(error).__name__)
        finally:
            try:
                cls.remove_netlog()
                removed = True
            except Exception as error:
                removed = type(error).__name__
        classes = result['classes'] if result else ['NETLOG-ERROR']
        run.observed['netlog'] = dict(result['summary'] if result else {'classes': classes}, raw_removed=removed)
        run.classes += ['INSTRUMENTATION:' + name for name in classes]
        exchange = (run.observed['netlog'].get('exchange') or {})
        run.check('P10', 'worklet-browser-response-200', bool(result) and result['status_ok'],
                  {'classes': classes, 'status': exchange.get('status'), 'extract': NETLOG_EXTRACT})
        run.check('P10', 'worklet-coop-coep', bool(result) and result['policy_ok'],
                  {'classes': classes, 'coop': exchange.get('coop'), 'coep': exchange.get('coep')})
        ran = {check['name']: check['ok'] for check in run.limbs['P4']}
        run.check('P10', 'worklet-executed', ran.get('one-node-options') is True and ran.get('recorded-1500ms') is True,
                  {name: ran.get(name) for name in ('one-node-options', 'recorded-1500ms')})
        observed = run.observed.get('headers')
        if observed is None:
            run.check('P10', 'main-observed', False, 'the browser-attributed main.html response was never read')
            return
        # Recorded only, as before: the G-CSP input and the worklet MIME, the worklet side now from the NetLog.
        responses, worklet = observed['responses'], result['headers'] if result else None
        inputs = {'main': (responses['main'] or {}).get('headers'), 'worklet': worklet,
                  'post': (responses['post'] or {}).get('headers')}
        observed['recorded'] = {label: {'csp_equals_template': (headers or {}).get('content-security-policy')
                                        == observed['template_csp'],
                                        'present': {name: name in (headers or {})
                                                    for name in GCSP_HEADERS + ('strict-transport-security',)}}
                                for label, headers in inputs.items()}
        observed['recorded_worklet_from'] = 'netlog' if worklet is not None else 'unobserved'
        observed['worklet_content_type'] = worklet.get('content-type') if worklet is not None else None
        observed['gcsp_input'] = gcsp_input(inputs['main'], inputs['worklet'], inputs['post'])

    # ── G-LIVE-GEO ──────────────────────────────────────────────────────────────────────────────
    def test_dictation_live_02_geometry_recording_failed_review(self):
        """G-LIVE-GEO (readiness §5, G0-G7): the pane in the real layouts at 1680x1100 and 1366x768, plain and
        Reading Workspace, with the Image Findings drawer open. Phase A measures recording and the real-503
        failed state; only after it, one declared route answers this study's POST with a fixed 200 review
        body for phase B's review state. Every hit test is taken before the real click it guards; each pass
        prints its own U4L-GEO line, and one failing pass stops the rest only when its cleanup failed. A GEO
        failure is a UI finding for Astra - never a reason to relax a limb or touch the PATH line.

        Attempt 1 measured the drawer covering the report fields in review. The product now stands it down
        once per run on entering review (Astra B2, 2026-09-23), so each pass first reopens it through its
        real toggle when hidden. Recording and failed keep G3 shown-and-bounded; review requires it stood
        down - hidden, aria-expanded false, its toggle present and reachable - and G1/G5 are measured after
        that, unchanged."""
        run, f, records = Run('G-LIVE-GEO', ['G7']), None, []
        plan = [(phase, width, height, layout) for phase in ('a', 'b') for width, height in VIEWPORTS for layout in LAYOUTS]
        try:
            f = self.fixture()
            run.observed['uid'] = f.uid
            self.seed_report(f)
            run.reached.append('fixture')
            page = run.page = self.login()
            run.reached.append('login')
            self.attach_log(run)
            self.select(page, f)
            expect(page.locator('#findings')).to_have_value(f.secret)
            run.pre = {'fields': self.field_values(page), 'rows': self.report_rows(f)}
            run.reached.append('selected')
            dictation_path = DICTATION_PATH % f.uid
            page.locator('#reading-findings-open').click()
            expect(page.locator('#reading-findings')).to_be_visible()
            expect(page.locator('#reading-findings-open')).to_have_attribute('aria-expanded', 'true')
            run.observed['drawer'] = self.drawer_settled(run)
            run.reached.append('drawer-open')
            for phase, width, height, layout in plan[:4]:
                if run.aborted_after:
                    break
                records.append(self.geo_pass(run, phase, width, height, layout, dictation_path))
            if not run.aborted_after:
                answered = run.observed['review_answers'] = []

                def review_answer(route):
                    entry = {'path': urlsplit(route.request.url).path, 'method': route.request.method}
                    answered.append(entry)
                    try:
                        route.fulfill(status=200, content_type='application/json', body=REVIEW_BODY)
                        entry['fulfilled'] = True
                    except Exception as error:
                        entry['error'] = short(error)
                        try:
                            route.abort()
                        except Exception as abort_error:
                            entry['abort_error'] = short(abort_error)
                page.context.route(lambda url: urlsplit(url).path == dictation_path, review_answer)
                run.observed['review_route'] = {'path': dictation_path, 'body_sha256': sha256(REVIEW_BODY.encode('utf-8')),
                                                'installed_after_pass': len(records)}
                for phase, width, height, layout in plan[4:]:
                    if run.aborted_after:
                        break
                    records.append(self.geo_pass(run, phase, width, height, layout, dictation_path))
        except Exception:
            run.error = traceback.format_exc()[-3000:]
            if run.page is not None:
                run.observed['primary_at_error'] = run.primary()
        finally:
            summary = self.geo_finish(run, f, plan, records)
        self.assertTrue(summary['pass'], 'G-LIVE-GEO failed; see the U4L-GEO and U4L-GEO-SUMMARY lines')

    def drawer_settled(self, run):
        """A-F: the drawer leaves idle/loading for a study with zero findings. Bounded and recorded, never assumed."""
        started, value = time.monotonic(), None
        while time.monotonic() - started < WAIT_SECONDS:
            value = run.js('drawer')
            if value and value['state'] not in (None, 'idle', 'loading'):
                break
            run.page.wait_for_timeout(100)
        return {'drawer': value, 'settled': bool(value) and value['state'] not in (None, 'idle', 'loading'),
                'waited_s': round(time.monotonic() - started, 3)}

    def reopen_drawer(self, run):
        """Astra B2: a phase-B review stands the drawer down and nothing reopens it, so every pass (both
        phases) starts by reopening it through its real toggle when it is hidden, then asserts it shown and
        expanded and waits (bounded) for it to settle. Setup only: G0 still asserts the drawer, the pane and
        the entry from the rectangles before Dictate."""
        page, before = run.page, run.js('drawer')
        reopened = not before or bool(before.get('hidden'))
        if reopened:
            page.locator('#reading-findings-open').click(timeout=WAIT_MS)
        try:
            expect(page.locator('#reading-findings')).to_be_visible()
            expect(page.locator('#reading-findings-open')).to_have_attribute('aria-expanded', 'true')
        except AssertionError as error:
            raise Stop('drawer reopen', {'reopened': reopened, 'before': before, 'error': short(error)})
        return {'reopened': reopened, 'before': before, 'settle': self.drawer_settled(run)}

    def enter_layout(self, run, layout, rec):
        want = layout == 'reading'
        if run.js('reading') is not want:
            run.page.locator('#m-reading').click(timeout=WAIT_MS)
            run.wait_true('reading' if want else 'plain')
            rec['reached'].append('layout')
        if want and 'reading_frame' not in run.observed:
            # N-5: the capture browser carries only the three media flags, so the embedded viewer may not come
            # up. An inert frame after this bounded wait is INSTRUMENTATION, never product evidence; GEO measures
            # the report column either way.
            started, frame = time.monotonic(), None
            while time.monotonic() - started < FRAME_SECONDS:
                frame = run.js('frame')
                if frame.get('present') and not frame.get('inert'):
                    break
                run.page.wait_for_timeout(250)
            ready = bool(frame) and frame.get('present') and not frame.get('inert')
            run.observed['reading_frame'] = {'frame': frame, 'waited_s': round(time.monotonic() - started, 3),
                                             'class': None if ready else 'INSTRUMENTATION'}

    def geo_pass(self, run, phase, width, height, layout, dictation_path):
        page = run.page
        name = '%s-%dx%d-%s' % (phase, width, height, layout)
        rec = {'pass_id': name, 'phase': phase, 'viewport': [width, height], 'layout': layout, 'run': True, 'reached': [],
               'initial': None, 'measured': {}, 'problems': [], 'post': None, 'presses': {}, 'cleanup': None}
        try:
            page.set_viewport_size({'width': width, 'height': height})
            # set_viewport_size resolves on the CDP acknowledgement; two frames put the reads on the new layout.
            run.js('frames2')
            self.enter_layout(run, layout, rec)
            rec['drawer_reopen'] = self.reopen_drawer(run)
            run.js('frames2')
            initial = rec['initial'] = run.js('geometry')
            rec['reached'].append('initial')
            entry = geo_entry_problems(initial)
            rec['problems'] += entry
            if entry:
                raise Stop('G0', entry)
            since, nodes = run.session().get('asrSeq', 0), len(run.js('media')['nodes'])
            page.locator('#b-dictate').click()
            rec['reached'].append('dictate')
            run.wait_session('recording', since)
            run.wait_true('recorded_since', [nodes, 500], since)
            run.js('frames2')
            seen = run.js('geometry')
            if phase == 'a':
                rec['measured']['recording'] = seen
                rec['problems'] += geo_problems('recording', initial, seen)
            rec['reached'].append('recording')
            stop = seen['controls']['dictation-stop']
            if not (stop['present'] and stop['own'] and not stop['disabled']):
                if phase == 'b':
                    rec['problems'].append('flow: Stop not reachable before review (top %s)' % stop['topId'])
                raise Stop('stop', stop)
            if phase == 'a':
                with page.expect_response(lambda r: r.request.method == 'POST' and urlsplit(r.url).path == dictation_path,
                                          timeout=WAIT_MS) as reply:
                    page.locator('#dictation-stop').click()
                rec['post'] = self.answer(reply.value)
                rec['reached'].append('post')
                run.wait_session('failed', since)
                run.js('frames2')
                seen = rec['measured']['failed'] = run.js('geometry')
                rec['problems'] += geo_problems('failed', initial, seen)
                rec['reached'].append('failed')
            else:
                page.locator('#dictation-stop').click()
                run.wait_session('review', since)
                run.js('frames2')
                seen = rec['measured']['review'] = run.js('geometry')
                # Astra B2 amendment: the one transient, restored scroll probe - here, after the observational read,
                # once per phase-B pass. An evaluate that fails is recorded as an error and fails G3; it is not lost.
                try:
                    seen['toggleReach'] = run.js('toggle_reach')
                except Exception as error:
                    seen['toggleReach'] = {'error': 'evaluate: ' + short(error), 'restored': None}
                rec['problems'] += geo_problems('review', initial, seen)
                rec['reached'].append('review')
                rec['after_toggle_probe'] = {}
                rec['presses']['cancel'] = self.press_or_escape(run, 'dictation-cancel', scroll=rec['after_toggle_probe'])
                run.wait_session('cancelled', since)
                rec['reached'].append('cancelled')
            rec['presses']['close'] = self.press_or_escape(run, 'dictation-close')
            run.wait_true('pane_hidden')
            rec['reached'].append('closed')
        except Stop as stop:
            rec['problems'].append('stopped at %s' % stop.what)
            rec['stop_detail'] = stop.detail
        except Exception:
            rec['problems'].append('harness: ' + traceback.format_exc()[-1500:])
        finally:
            if 'closed' not in rec['reached']:
                # The layout where the pass stopped, read before cleanup presses anything.
                try:
                    rec['measured']['at_failure'] = run.js('geometry')
                except Exception as error:
                    rec['measured']['at_failure'] = {'error': short(error)}
            rec['cleanup'] = self.settle_dictation(run, close=True)
            if not rec['cleanup']['ok']:
                run.aborted_after = name
                rec['problems'].append('cleanup did not reach a non-active state with every track ended')
            rec['pass'] = not rec['problems']
            emit('U4L-GEO', rec)
            try:
                write_json('geo-%s.json' % name, rec)
            except Exception as error:
                rec['artifact_error'] = short(error)
        return rec

    def geo_finish(self, run, f, plan, records):
        executed = {record['pass_id'] for record in records}
        reason = 'aborted after %s' % run.aborted_after if run.aborted_after else 'not reached: %s' % (
            (run.error or 'no error').strip().splitlines()[-1][:200])
        for phase, width, height, layout in plan:
            name = '%s-%dx%d-%s' % (phase, width, height, layout)
            if name not in executed:
                emit('U4L-GEO', {'pass_id': name, 'phase': phase, 'viewport': [width, height], 'layout': layout,
                                 'run': False, 'reason': reason, 'pass': False})
        page = run.page
        if page is not None:
            run.observed['settle'] = self.settle_dictation(run)
        if f is not None and page is not None:
            try:
                pre = run.pre or {}
                fields, rows = self.field_values(page), self.report_rows(f)
                run.check('G7', 'fields-byte-equal', pre.get('fields') is not None and fields == pre['fields'])
                run.check('G7', 'report-rows-byte-equal', pre.get('rows') is not None and rows == pre['rows'],
                          {table: len(value) for table, value in rows.items()})
                writes = forbidden_writes(self.net.requests, f.uid)
                run.check('G7', 'no-report-writes', not writes, writes)
            except Exception as error:
                run.check('G7', 'readable', False, short(error))
        phase_a = [record for record in records if record['phase'] == 'a']
        run.check('G7', 'four-phase-a-passes', len(phase_a) == 4, len(phase_a))
        for record in phase_a:
            run.check('G7', 'real-503 ' + record['pass_id'], record.get('post') == {'status': 503, 'code': 'DICTATION_NOT_CONFIGURED'},
                      record.get('post'))
        if page is not None:
            self.detach_log(run)
        g7 = run.limb_verdicts()['G7']
        instrumentation = [('reading_frame', run.observed.get('reading_frame'))] \
            if (run.observed.get('reading_frame') or {}).get('class') else []
        summary = {'case': run.line, 'test': 'TEST-S3-ASR-U4L-GEO',
                   'pass': len(records) == len(plan) and all(r['pass'] for r in records) and g7['pass'] and run.error is None,
                   'passes': {r['pass_id']: r['pass'] for r in records}, 'planned': len(plan), 'executed': len(records),
                   'aborted_after': run.aborted_after, 'G7': g7, 'instrumentation': instrumentation,
                   'reached': run.reached, 'error': run.error, 'elapsed_s': round(time.monotonic() - run.started, 3),
                   'bootstraps': [{k: e.get(k) for k in ('n', 'outcome', 'differing_paths')} for e in self.bootstraps],
                   'log_entry_count': len(run.log_entries), 'observed': run.observed,
                   'launch_problems': type(self).read_launch()['problems']}
        emit('U4L-GEO-SUMMARY', summary)
        try:
            write_json('geo-summary.json', dict(summary, bootstraps=self.bootstraps, log_entries=run.log_entries,
                                                net=self.net.plain(), pre=run.pre))
        except Exception as error:
            summary['pass'] = False
            summary['artifact_error'] = short(error)
        return summary


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    unittest.main(defaultTest=[f'DictationLiveE2E.{n}' for n in DictationLiveE2E.__dict__ if n.startswith('test_')], verbosity=2)
