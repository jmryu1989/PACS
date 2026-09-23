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
    the Log domain (amendment D2).
Every page-side read goes through PROBES; every state change is a real click or key press.

Not claimed: CSP enforcement (zero Log entries is not enforcement; U4b NC-11 is the only such proof), a
header-delivery verdict (G-CSP is Astra's conditional decision on the recorded observation), engine or model
availability, speech accuracy, physician acceptance, U5 or Stage 3 completion.
"""
import ast
import copy
import hashlib
import json
import math
import os
import re
import sys
import time
import traceback
import unittest
from pathlib import Path
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
               'dictation-close', 'dictation-repin', 'b-copy', 'm-reading')

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
# execution_selection_test.py); state changes are real clicks and key presses only.
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
  const drawer = q('#reading-findings'), pane = q('#dictation-pane'), findings = q('#findings'), right = q('.right');
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
  return { viewport: { w: innerWidth, h: innerHeight }, reading: document.body.classList.contains('reading'),
    rightScrollTop: right ? right.scrollTop : null, menubar: box(q('.menubar')), rbtns: box(q('.report-p .rbtns')),
    pane: box(pane), paneHidden: pane ? !!pane.hidden : null,
    redit: box(q('.report-p .redit')), reditMin: minHeight(q('.report-p .redit')), fields,
    rfoot: box(q('.report-p .rfoot2')), rfootInside: whole(q('.report-p .rfoot2')),
    drawer: box(drawer), drawerShown: !!drawer && !drawer.hidden,
    drawerTop: drawer ? drawer.style.getPropertyValue('--reading-findings-top') : null,
    findingsProbe: probe, status: q('#dictation-status') ? q('#dictation-status').textContent : null, controls };
}""" % json.dumps(list(GEO_HIT_IDS))
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


def launch_verdict(text, fixture_path, capture_version):
    """P0 (amendment D1, review N-1): one record per `<launching>` line, so the capture browser is judged on its
    own line and the base browser on its own - never the first line for both. The capture line is the one that
    carries the fixture argument, not the second one by position."""
    rows = [row for row in (text or '').splitlines() if '<launching> ' in row]
    fixture_arg = '--use-file-for-fake-audio-capture=%s' % fixture_path
    records, problems = [], []
    for index, row in enumerate(rows):
        parsed = parse_launch(row)
        judged = launch_problems(parsed)
        command = row.split('<launching> ', 1)[1].split(' ')
        records.append({'index': index, 'executable': parsed['executable'], 'flags': parsed['flags'],
                        'chrome_headless_shell': parsed['chrome_headless_shell'], 'capture': fixture_arg in command[1:],
                        'binary': judged['binary'], 'forbidden': judged['forbidden'],
                        'forbidden_text': [flag for flag in FORBIDDEN_LAUNCH_FLAGS if flag in row]})
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
    if len(captures) == 1:
        capture = captures[0]
        for flag in ('--headless', '--use-fake-device-for-media-stream', '--disable-audio-output'):
            if not capture['flags'].get(flag):
                problems.append('the capture launch lacks %s' % flag)
        if capture['chrome_headless_shell'] or not (capture['executable'] or '').endswith(FULL_CHROMIUM_SUFFIX):
            problems.append('the capture launch is not the full pinned Chromium: %s' % capture['executable'])
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
    """G1-G6 for one measured state (readiness §5), from rendered rectangles and hit tests only."""
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
    if not measured.get('drawerShown') or not drawer or not pane:
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
    return problems


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
                'drawer': {'x': 1248, 'y': 376, 'w': 420, 'h': 300, 'b': 676}, 'drawerShown': True, 'drawerTop': '376px',
                'findingsProbe': {'x': 818, 'y': 408, 'own': True, 'topId': 'findings'}, 'status': 'x',
                'controls': {name: control(300) for name in GEO_HIT_IDS}}
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

    def line(executable, extra):
        return 'T pw:browser <launching> %s --disable-field-trial-config --headless --mute-audio %s' % (executable, extra)
    base = line(full, '--enable-unsafe-swiftshader')
    media = '--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=%s --disable-audio-output' % fixture
    capture = line(full, media)
    log = lambda *rows: '\n'.join(rows + ('T pw:browser <launched> pid=7',))
    good = launch_verdict(log(base, capture), fixture, BROWSER_VERSION)
    if good['problems'] or [r['capture'] for r in good['records']] != [False, True]:
        problems.append('the pinned two-launch log must pass P0: %r' % good['problems'])
    for label, text, version in (
            ('one launch line', log(capture), BROWSER_VERSION),
            ('three launch lines', log(base, capture, base), BROWSER_VERSION),
            ('a headless-shell capture', log(base, line(shell, media)), BROWSER_VERSION),
            ('a headless-shell base browser (each process is judged)', log(line(shell, '--x'), capture), BROWSER_VERSION),
            ('a forbidden flag on the base line', log(line(full, FORBIDDEN_LAUNCH_FLAGS[0]), capture), BROWSER_VERSION),
            ('a forbidden flag on the capture line', log(base, capture + ' ' + FORBIDDEN_LAUNCH_FLAGS[2] + '=x'), BROWSER_VERSION),
            ('a capture without --disable-audio-output', log(base, capture.replace(' --disable-audio-output', '')), BROWSER_VERSION),
            ('two lines carrying the fixture', log(capture, capture), BROWSER_VERSION),
            ('another fixture path', log(base, capture.replace(fixture, fixture + '.x')), BROWSER_VERSION),
            ('another browser version', log(base, capture), '148.0.0.0'),
            ('an empty log', '', BROWSER_VERSION)):
        expect_problem(label, launch_verdict(text, fixture, version)['problems'])
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
    for state in GEO_CONTROLS:
        if geo_problems(state, initial, measured):
            problems.append('a consistent %s layout must pass G1-G6: %r' % (state, geo_problems(state, initial, measured)))

    def covered(name):
        return dict(measured, controls=dict(measured['controls'], **{name: dict(measured['controls'][name], own=False)}))
    for label, state, value in (
            ('a covered Stop', 'recording', covered('dictation-stop')), ('a covered Close', 'failed', covered('dictation-close')),
            ('a covered Insert', 'review', covered('dictation-insert')), ('a covered status', 'failed', covered('dictation-status')),
            ('a drawer over the pane', 'recording', dict(measured, drawer=dict(measured['drawer'], y=300))),
            ('a hidden drawer', 'failed', dict(measured, drawerShown=False)),
            ('a pane above the buttons', 'failed', dict(measured, pane=dict(measured['pane'], y=250))),
            ('a covered Reading Workspace toggle', 'recording', covered('m-reading')),
            ('a squeezed field', 'recording', dict(measured, fields=dict(measured['fields'], conclusion={
                'box': dict(measured['fields']['conclusion']['box'], h=20), 'min': {'raw': '34px', 'px': 34}}))),
            ('an unreachable findings field in review', 'review', dict(measured, findingsProbe=dict(measured['findingsProbe'], own=False))),
            ('a footer pushed out', 'failed', dict(measured, rfootInside=False))):
        expect_problem(label, geo_problems(state, initial, value))
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
            cls.capture_browser = cls.pw.chromium.launch(channel="chromium", headless=True, args=launch_args(cls.fixture_path))
            cls.addClassCleanup(cls.capture_browser.close)
            cls.capture_version = cls.capture_browser.version
            first = cls.read_launch(seconds=5)
            from importlib.metadata import version
            record.update(launch=first, channel=CHANNEL, capture_version=cls.capture_version,
                          base_version=cls.browser.version, playwright=version('playwright'),
                          default_executable_path=cls.pw.chromium.executable_path,
                          fixture={'path': str(cls.fixture_path), 'sha256': sha256(wav), 'bytes': len(wav)})
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
            verdict = launch_verdict(text, cls.fixture_path, cls.capture_version)
            if len(verdict['records']) >= 2 or time.monotonic() >= until:
                return verdict
            time.sleep(0.05)

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
            launch = launch_verdict(clean, cls.fixture_path, cls.capture_version)
            launch['sanitizer'] = {'generated_names': len(names), 'generated_values_present': len(values),
                                   'test_passwords': len(cls.hide),
                                   'hits': clean.count('[REDACTED') - text.count('[REDACTED')}
            launch['note'] = 'final read after every browser closed; P0 in the U4L-PATH line is the adjudicated limb'
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

    def press_or_escape(self, run, control):
        """A real click when the control is present and own; otherwise Escape inside the pane, which the pane
        maps to Cancel while active and Close after (dictation.js:464-468). Returns which one happened."""
        seen = run.js('geometry')['controls'][control]
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
        """P10 from the browser-attributed responses; a direct GET of the worklet is a labelled control only."""
        mains = [e for e in self.net.responses if e['path'] == MAIN_PATH and e['type'] == 'document']
        worklets = [e for e in self.net.responses if e['path'] == WORKLET_PATH]
        seen = {'main': self.response_record(mains[-1]['obj']) if mains else None,
                'worklet': self.response_record(worklets[0]['obj']) if worklets else None,
                'post': self.response_record(run.post_response) if run.post_response is not None else None}
        observed = {'counts': {'main': len(mains), 'worklet': len(worklets)}, 'responses': seen,
                    'template_csp': TEMPLATE_CSP[0] if len(TEMPLATE_CSP) == 1 else None}
        run.observed['headers'] = observed
        main, worklet = seen['main'], seen['worklet']
        run.check('P10', 'main-200-html', bool(main) and main['status'] == 200 and
                  main['headers'].get('content-type', '').startswith('text/html'), main and main['headers'].get('content-type'))
        if worklet is None:
            run.classes.append('INSTRUMENTATION:A-R')
        run.check('P10', 'worklet-browser-response-200', bool(worklet) and worklet['status'] == 200,
                  worklet and worklet['status'])
        for label, value in (('main', main), ('worklet', worklet)):
            headers = (value or {}).get('headers') or {}
            run.check('P10', label + '-coop-coep', headers.get('cross-origin-opener-policy') == 'same-origin' and
                      headers.get('cross-origin-embedder-policy') == 'require-corp',
                      [headers.get('cross-origin-opener-policy'), headers.get('cross-origin-embedder-policy')])
        # Recorded only: the G-CSP input, the worklet MIME verbatim and the control GET.
        observed['recorded'] = {label: {'csp_equals_template': (value or {}).get('headers', {}).get('content-security-policy')
                                        == observed['template_csp'],
                                        'present': {name: name in ((value or {}).get('headers') or {})
                                                    for name in GCSP_HEADERS + ('strict-transport-security',)}}
                                for label, value in seen.items()}
        observed['worklet_content_type'] = worklet and worklet['headers'].get('content-type')
        observed['gcsp_input'] = gcsp_input(*((value or {}).get('headers') if value else None
                                              for value in (main, worklet, seen['post'])))
        try:
            control = run.page.context.request.get(self.stack.proxy + WORKLET_PATH, timeout=WAIT_MS)
            observed['control_direct_get'] = {'status': control.status, 'headers': allowlisted(control.headers, RESPONSE_HEADERS),
                                              'label': 'control only; never substituted for the browser-attributed response'}
        except Exception as error:
            observed['control_direct_get'] = {'error': short(error)}

    # ── G-LIVE-GEO ──────────────────────────────────────────────────────────────────────────────
    def test_dictation_live_02_geometry_recording_failed_review(self):
        """G-LIVE-GEO (readiness §5, G0-G7): the pane in the real layouts at 1680x1100 and 1366x768, plain and
        Reading Workspace, with the Image Findings drawer open. Phase A measures recording and the real-503
        failed state; only after it, one declared route answers this study's POST with a fixed 200 review
        body for phase B's review state. Every hit test is taken before the real click it guards; each pass
        prints its own U4L-GEO line, and one failing pass stops the rest only when its cleanup failed. A GEO
        failure is a UI finding for Astra - never a reason to relax a limb or touch the PATH line."""
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
                rec['problems'] += geo_problems('review', initial, seen)
                rec['reached'].append('review')
                rec['presses']['cancel'] = self.press_or_escape(run, 'dictation-cancel')
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
