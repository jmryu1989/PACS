/* S3-ASR-U4 host adapter. It decides whether this browser may record, runs one
 * capture -> request -> review cycle on top of the shipped session core (dictation-session.js) and
 * capture module (dictation-capture.js), and draws the review pane. It never writes the report: the
 * host's synchronous insert callback does that, and only after an explicit Insert.
 *
 * Browser capture capability names appear here and in dictation-capture.js only. main.html,
 * report-citation.js and report-structure.js must stay free of them (DI-13).
 * No logging, storage or Blob URL for audio or transcript.
 */
(function () {
  'use strict';
  const TEXT_CAP = 16384;          // JS UTF-16 code units, identical to the server's ASR_TEXT_CAP
  const MAX_WAV_BYTES = 1048576;   // the server's code ceiling; bootstrap may lower it, never raise it
  const MAX_TIMEOUT_MS = 240000;
  const CLIENT_MARGIN_MS = 5000;
  // A 16384-unit string escaped as \uXXXX is 98304 characters; this bound is only against a body
  // that is not the contract at all, so it is read before anything is parsed.
  const RESPONSE_CHARS = 262144;
  const REFUSAL_CHARS = 8192;
  const LABEL_CHARS = 256;
  const ACTIVE = new Set(['requesting-permission', 'recording', 'uploading', 'review']);

  const TITLES = Object.freeze({
    browser: '이 브라우저 환경에서는 녹음할 수 없습니다 — 보안 연결(HTTPS)과 마이크 기능이 필요합니다',
    ready: '말한 내용을 받아 적어 검토 창에 보여 줍니다 — 판독문에는 Insert를 눌러야 들어갑니다',
    active: '받아쓰기가 진행 중입니다 — 아래 검토 창에서 멈추거나 취소하세요',
  });
  const UNCHANGED = ' — 판독문은 그대로입니다';
  const CANCELLED = '취소됨(엔진 상태 미확인)';
  const REASONS = Object.freeze({
    cancelled: CANCELLED,
    'page-exit': CANCELLED,
    'study-changed': '검사가 바뀌어 받아쓰기를 멈췄습니다 · ' + CANCELLED,
    unavailable: '음성 인식을 더 이상 쓸 수 없어 받아쓰기를 멈췄습니다',
    'editor-changed': '검사·판독문 판 또는 편집 가능 상태가 바뀌어 받아쓴 글을 넣지 않았습니다',
    'editor-blocked': '지금은 이 판독문에 받아쓸 수 없습니다',
    'hash-failed': '판독문 위치를 고정하지 못했습니다',
    'invalid-transcript': '받아쓴 글을 확인할 수 없습니다',
    'transcript-empty': '인식된 글이 없습니다',
    'transcript-too-long': `인식된 글이 ${TEXT_CAP}자를 넘어 받지 않았습니다 — 더 짧게 나눠 녹음하세요`,
    'invalid-response': '음성 인식 응답을 확인할 수 없습니다',
    network: '음성 인식 서버에 연결하지 못했습니다',
    'client-timeout': '음성 인식 응답이 없어 요청을 멈췄습니다',
    unauthorized: '세션이 만료되었습니다',
    'insert-refused': '판독문이 그 사이 바뀌어 받아쓴 글을 넣지 않았습니다',
    'insert-failed': '받아쓴 글을 넣지 못했습니다',
    'cleanup-failed': '녹음 자원을 정리하지 못했습니다',
    'capture-empty': '녹음된 소리가 없습니다 — 다시 녹음하세요',
    DICTATION_CAPTURE_DENIED: '마이크 사용이 허용되지 않았습니다 — 브라우저의 마이크 권한을 확인하세요',
    DICTATION_CAPTURE_UNAVAILABLE: '이 브라우저에서는 녹음할 수 없습니다',
    DICTATION_CAPTURE_FORMAT: '녹음 장치가 필요한 형식(16kHz 모노)을 지원하지 않습니다',
    DICTATION_CAPTURE_FAILED: '녹음이 중단되었습니다 — 마이크 연결을 확인하고 다시 녹음하세요',
    DICTATION_AUDIO_INVALID: '녹음된 음성 형식이 올바르지 않습니다 — 다시 녹음하세요',
    DICTATION_AUDIO_TOO_LARGE: '녹음이 너무 깁니다 — 더 짧게 나눠 다시 녹음하세요',
    DICTATION_NOT_CONFIGURED: '음성 인식기가 연결되지 않았습니다.',
    DICTATION_BUSY: '다른 음성 인식이 처리 중입니다 — 잠시 뒤 다시 시도하세요',
    DICTATION_TIMEOUT: '음성 인식 시간이 초과되었습니다',
    DICTATION_ENGINE_FAILED: '음성 인식에 실패했습니다',
  });
  const NOTICES = Object.freeze({
    'field-changed': '본문이 바뀌었습니다 — 넣을 칸을 클릭하거나 Pin Caret을 눌러 위치를 다시 고정한 뒤 Insert를 다시 누르세요',
    repinned: '새 위치에 고정했습니다 — Insert를 누르면 넣습니다',
    'report-busy': '판독문 저장이 끝난 뒤 Insert를 다시 누르세요 — 받아쓴 글은 그대로 있습니다',
    'editor-blocked': REASONS['editor-blocked'],
  });
  const STATUS = Object.freeze({
    'requesting-permission': '마이크 사용 허가를 기다리는 중입니다 — 브라우저가 묻는 경우 허용하세요',
    recording: seconds => `녹음 중입니다 — 말한 뒤 Stop을 누르세요 (최대 약 ${seconds}초, 넘으면 자동으로 멈춥니다)`,
    stopping: '녹음을 마무리하는 중입니다',
    uploading: '인식을 요청하는 중입니다 — 판독문은 아직 바뀌지 않았습니다',
    capped: '최대 녹음 길이에 도달해 녹음을 멈췄습니다 — 인식을 요청하는 중입니다',
    review: '받아쓴 글을 확인하세요 — Insert를 눌러야 판독문에 들어갑니다',
    inserted: '받아쓴 글을 판독문에 넣었습니다',
    placementStale: '본문이 고정한 뒤 바뀌었습니다 — Insert를 누르면 넣지 않고 위치를 다시 고정하라고 안내합니다',
    cleanup: ' · 녹음 자원을 정리하지 못했을 수 있습니다 — 브라우저 탭을 닫았다 다시 여세요',
  });

  const label = value => typeof value === 'string' && value.length > 0 && value.length <= LABEL_CHARS;
  const OFF = Object.freeze({ available: false });

  /** Anything other than the exact bootstrap shape is "not available". */
  function parseCapability(value) {
    if (!value || typeof value !== 'object' || value.available !== true) return OFF;
    const { maxBytes, timeoutMs, languagePin, enginePin, modelPin } = value;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 46 || maxBytes > MAX_WAV_BYTES) return OFF;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return OFF;
    if (![languagePin, enginePin, modelPin].every(label)) return OFF;
    return Object.freeze({ available: true, maxBytes, timeoutMs, languagePin, enginePin, modelPin });
  }

  /** Server "available" cannot override a browser that cannot capture. Reading never prompts. */
  function browserCapable(env, capture) {
    try {
      return !!env && env.isSecureContext === true &&
        typeof env.navigator?.mediaDevices?.getUserMedia === 'function' &&
        !!capture && typeof capture.available === 'function' && capture.available(env) === true;
    } catch (_) { return false; }
  }

  /** The 200 body, checked for shape only. The text itself is judged by transcriptProblem. */
  function readResponse(raw) {
    if (typeof raw !== 'string' || raw.length > RESPONSE_CHARS) return null;
    let v;
    try { v = JSON.parse(raw); } catch (_) { return null; }
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.text !== 'string') return null;
    // Configured labels, not attestation: they must be well-formed to be shown, nothing more.
    if (![v.languagePin, v.enginePin, v.modelPin].every(label)) return null;
    if (typeof v.seconds !== 'number' || !Number.isFinite(v.seconds) || v.seconds < 0) return null;
    return Object.freeze({ text: v.text, seconds: v.seconds, languagePin: v.languagePin,
      enginePin: v.enginePin, modelPin: v.modelPin });
  }

  /** Whitespace-only is a predicate, never a transform; nothing is trimmed or cut. */
  function transcriptProblem(text) {
    if (typeof text !== 'string') return 'invalid-transcript';
    if (text.length > TEXT_CAP) return 'transcript-too-long';
    if (!text.trim()) return 'transcript-empty';
    return null;
  }

  /** A refusal may come from nginx (HTML 413) as well as from Nest; JSON is never assumed. */
  function refusal(status, raw) {
    if (status === 413) return { code: 'DICTATION_AUDIO_TOO_LARGE', message: null };
    let body = null;
    if (typeof raw === 'string' && raw.length <= REFUSAL_CHARS) { try { body = JSON.parse(raw); } catch (_) {} }
    const code = body && typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code) ? body.code : null;
    const message = body && typeof body.message === 'string' && body.message.length <= 300 ? body.message : null;
    // The route's own codes carry the code as their message; they get the Korean mapping instead.
    if (code && code.startsWith('DICTATION_')) return { code, message: null };
    // The shared report refusals (hold, role, institution, Unverified, prelim) speak Korean already.
    return { code: code || `HTTP_${Number.isSafeInteger(status) ? status : 0}`, message };
  }

  function captureReason(code) {
    if (code === 'DICTATION_AUDIO_INVALID') return 'capture-empty';  // capture-side: no frames (review N-6)
    return ['DICTATION_CAPTURE_DENIED', 'DICTATION_CAPTURE_UNAVAILABLE', 'DICTATION_CAPTURE_FORMAT']
      .includes(code) ? code : 'DICTATION_CAPTURE_FAILED';
  }

  function failureMessage(reason, detail) {
    if (detail) return detail;
    if (Object.prototype.hasOwnProperty.call(REASONS, reason)) return REASONS[reason];
    if (typeof reason === 'string' && /^HTTP_\d+$/.test(reason))
      return `음성 인식 요청이 거절되었습니다 (HTTP ${reason.slice(5)})`;
    return '받아쓰기를 마치지 못했습니다';
  }

  function zero(bytes) { try { if (bytes && typeof bytes.fill === 'function') bytes.fill(0); } catch (_) {} }

  function createController(o) {
    if (!o || !o.session || typeof o.session.create !== 'function' || !o.capture ||
        typeof o.capture.createCapture !== 'function' || typeof o.readContext !== 'function' ||
        typeof o.insert !== 'function' || typeof o.fetch !== 'function' || typeof o.apiBase !== 'string')
      throw new TypeError('session, capture, readContext, insert, fetch and apiBase are required');
    const timers = o.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) };
    let server = OFF, browser = false, run = null, starting = false;
    let notice = null, extra = null, pinned = null, dismissed = -1;
    const listeners = new Set();

    function emit() { for (const fn of listeners) { try { fn(); } catch (_) { /* a view cannot stop the cycle */ } } }
    function context(field) { try { return o.readContext(field) || null; } catch (_) { return null; } }

    /** Session cleanup. Every exit path of every run comes through here exactly once. */
    function release() {
      const r = run;
      run = null; pinned = null;
      if (!r) return;
      let failed = false;
      if (r.timer !== null) { try { timers.clear(r.timer); } catch (_) { failed = true; } r.timer = null; }
      try { r.abort.abort(); } catch (_) { failed = true; }
      try { if (r.capture) r.capture.cancel(); } catch (_) { failed = true; }
      zero(r.wav); r.wav = null;
      // Rethrow so the session records cleanupFailed instead of the pane claiming a clean stop.
      if (failed) throw new Error('cleanup-failed');
    }

    const session = o.session.create({
      readContext: o.readContext,
      validateTranscript: text => typeof text === 'string' && text.length <= TEXT_CAP,
      insert: o.insert,
      cleanup: release,
      hashText: o.hashText,
    });

    function capable() { return server.available && browser; }
    function sync() {
      browser = browserCapable(o.env, o.capture);
      session.setAvailable(capable());
    }
    function setServerCapability(value) { server = parseCapability(value); sync(); emit(); }

    /** One report for one run. A second signal for the same run (callback + rejection) is stale. */
    function failRun(cur, reason, detail) {
      if (run !== cur) return;
      session.fail(cur.token, reason);
      if (detail) extra = { seq: session.snapshot().asrSeq, text: detail };
      emit();
    }
    function remember(field) {
      const live = context(field);
      pinned = live && typeof live.value === 'string' ? live.value : null;
    }

    function gate() { try { return o.block ? o.block() || null : null; } catch (_) { return '지금은 받아쓸 수 없습니다'; } }

    async function start() {
      if (starting || run) return;
      notice = null; extra = null;
      sync();
      if (!capable()) { emit(); return; }
      // The start gate (editor + server connection); the session's own context covers the editor.
      if (gate()) { notice = 'editor-blocked'; dismissed = -1; emit(); return; }
      starting = true;
      let r;
      try { r = await session.begin(); } finally { starting = false; }
      if (!r.ok) {
        if (r.reason === 'editor-blocked') { notice = 'editor-blocked'; dismissed = -1; }
        emit();
        return;
      }
      const cur = { token: r.token, abort: new AbortController(), capture: null, timer: null, wav: null,
        stopping: false, auto: false, timedOut: false, meta: null };
      run = cur;
      remember(session.snapshot().pin.field);
      try {
        cur.capture = o.capture.createCapture({ env: o.env, maxBytes: server.maxBytes,
          // Only the worklet's own cap reaches here; a user Stop settles the stop() promise instead.
          onComplete: () => { if (run === cur) { cur.auto = true; finish(cur); } },
          onFailure: code => failRun(cur, captureReason(code)) });
      } catch (_) { failRun(cur, 'DICTATION_CAPTURE_FAILED'); return; }
      emit();
      try { await cur.capture.start(); }
      catch (e) { failRun(cur, captureReason(e && e.message)); return; }
      if (run !== cur) return;
      session.recording(cur.token);
      emit();
    }

    async function finish(cur) {
      if (run !== cur || cur.stopping || session.snapshot().state !== 'recording') return;
      cur.stopping = true;
      emit();
      let wav;
      try { wav = await cur.capture.stop(); }
      catch (e) { failRun(cur, captureReason(e && e.message)); return; }
      if (run !== cur) { zero(wav); return; }
      cur.wav = wav;
      if (!session.uploading(cur.token).ok) { emit(); return; }
      await send(cur);
    }

    async function send(cur) {
      const pin = session.snapshot().pin;
      const url = `${o.apiBase}/studies/${encodeURIComponent(pin.uid)}/dictation`;
      cur.timer = timers.set(() => { cur.timedOut = true; try { cur.abort.abort(); } catch (_) {} },
        server.timeoutMs + CLIENT_MARGIN_MS);
      emit();
      let res, raw;
      try {
        const pending = o.fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          redirect: 'error', headers: { 'Content-Type': 'audio/wav', 'X-KIN-CSRF': '1' },
          body: cur.wav, signal: cur.abort.signal });
        // fetch() copied the bytes when it built the request; the page keeps no audio after this.
        zero(cur.wav); cur.wav = null;
        res = await pending;
        if (run !== cur) return;
        if (res.status === 401) {
          failRun(cur, 'unauthorized');
          try { if (o.onUnauthorized) o.onUnauthorized(); } catch (_) {}
          return;
        }
        raw = await res.text();
      } catch (_) {
        failRun(cur, cur.timedOut ? 'client-timeout' : 'network');
        return;
      }
      if (run !== cur) return;
      if (cur.timer !== null) { timers.clear(cur.timer); cur.timer = null; }
      if (!res.ok) { const f = refusal(res.status, raw); failRun(cur, f.code, f.message); return; }
      const value = readResponse(raw);
      if (!value) { failRun(cur, 'invalid-response'); return; }
      const problem = transcriptProblem(value.text);
      if (problem) { failRun(cur, problem); return; }
      cur.meta = value;
      session.receive(cur.token, value.text);
      emit();
    }

    function stop() { if (run) finish(run); }

    async function insert() {
      const snap = session.snapshot();
      if (snap.state !== 'review' || snap.pending || !run) return null;
      notice = null;
      let busy = false;
      try { busy = !!(o.busy && o.busy()); } catch (_) { busy = true; }
      // A save or another insertion in flight is transient: say so and keep the transcript.
      if (busy) { notice = 'report-busy'; emit(); return null; }
      const field = snap.pin.field;
      const res = await session.insert(snap.asrSeq);
      const inserted = res.inserted === true;
      if (!inserted && res.reason === 'field-changed') notice = 'field-changed';
      emit();
      return { ...res, inserted, field };
    }

    async function repin() {
      const snap = session.snapshot();
      if (snap.state !== 'review' || !snap.needsRepin || snap.pending) return null;
      const res = await session.repin(snap.asrSeq);
      if (res.ok) { remember(session.snapshot().pin.field); notice = 'repinned'; }
      else if (res.reason === 'field-changed') notice = 'field-changed';
      emit();
      return res;
    }
    /** An explicit click in a report field is the re-pin gesture, and only when one is asked for. */
    function fieldClicked() { if (session.snapshot().needsRepin) return repin(); return null; }

    function cancel(reason) {
      if (!ACTIVE.has(session.snapshot().state)) return;
      notice = null;
      session.cancel(reason || 'cancelled');
      emit();
    }
    function close() {
      if (ACTIVE.has(session.snapshot().state)) return;
      dismissed = session.snapshot().asrSeq; notice = null; extra = null;
      emit();
    }

    /**
     * Called from the editor's one "report state changed" point. A study move (A->B->A included)
     * ends the session; outside review a changed base or a newly blocked editor ends it at once, so
     * the microphone is released without waiting for Stop, and so does a lost start gate (server)
     * while the microphone is still open. In review the transcript stays and the Insert press
     * refuses (session rule).
     */
    function refresh() {
      sync();
      const snap = session.snapshot();
      if (ACTIVE.has(snap.state) && snap.pin) {
        const live = context(snap.pin.field);
        if (!live || live.uid !== snap.pin.uid || live.selectionSeq !== snap.pin.selectionSeq) session.studyChanged();
        else if (snap.state !== 'review' && !snap.pending &&
                 (live.blocked !== false || live.baseVersion !== snap.pin.baseVersion ||
                  (snap.state !== 'uploading' && gate()))) session.fail(snap.asrSeq, 'editor-changed');
      }
      emit();
    }

    function view() {
      const s = session.snapshot();
      const active = ACTIVE.has(s.state);
      const cur = run;
      const v = { state: s.state, asrSeq: s.asrSeq, serverAvailable: server.available, browser, active,
        block: null, visible: false, status: '', text: '', placement: '', meta: '', metaTitle: '',
        needsRepin: s.needsRepin, pending: s.pending, cleanupFailed: s.cleanupFailed, stopping: false,
        controls: { stop: 'hidden', cancel: 'hidden', repin: 'hidden', insert: 'hidden', close: 'hidden' } };
      if (capable() && !active) v.block = gate();
      // A session the capability withdrawal ended says so; the plain unavailable default stays silent.
      const terminal = ['failed', 'cancelled'].includes(s.state) || (s.state === 'inserted' && s.cleanupFailed) ||
        (s.state === 'unavailable' && s.error === 'unavailable');
      v.visible = active || (terminal && dismissed !== s.asrSeq) || (notice === 'editor-blocked' && dismissed === -1);
      if (s.state === 'requesting-permission') {
        v.status = STATUS['requesting-permission'];
        v.controls.stop = 'disabled'; v.controls.cancel = 'enabled';
      } else if (s.state === 'recording') {
        v.stopping = !!(cur && cur.stopping);
        v.status = v.stopping ? STATUS.stopping
          : STATUS.recording(Math.floor(((server.available ? server.maxBytes : MAX_WAV_BYTES) - 44) / 32000));
        v.controls.stop = v.stopping ? 'disabled' : 'enabled'; v.controls.cancel = 'enabled';
      } else if (s.state === 'uploading') {
        v.status = cur && cur.auto ? STATUS.capped : STATUS.uploading;
        v.controls.stop = 'disabled'; v.controls.cancel = 'enabled';
      } else if (s.state === 'review') {
        v.status = s.needsRepin ? NOTICES['field-changed'] : (notice && NOTICES[notice]) || STATUS.review;
        v.text = s.text;
        v.controls.cancel = 'enabled';
        v.controls.insert = s.pending || s.needsRepin ? 'disabled' : 'enabled';
        if (s.needsRepin) v.controls.repin = s.pending ? 'disabled' : 'enabled';
        if (s.pin) {
          const live = context(s.pin.field);
          if (live && typeof live.value === 'string' && pinned !== null && live.value !== pinned) v.placement = STATUS.placementStale;
          else { try { v.placement = o.placement ? String(o.placement(s.pin, s.text) || '') : ''; } catch (_) { v.placement = ''; } }
        }
        if (cur && cur.meta) {
          v.meta = `${cur.meta.seconds.toFixed(1)}초 녹음 · 언어 설정 ${cur.meta.languagePin}(감지된 언어 아님)`;
          v.metaTitle = `서버에 설정된 표시값이며 실제 처리 엔진·모델을 증명하지 않습니다 — 엔진 ${cur.meta.enginePin} · 모델 ${cur.meta.modelPin}`;
        }
      } else if (notice === 'editor-blocked' && dismissed === -1) {
        // A press that the editor gate refused before anything started; an older outcome is not it.
        v.status = NOTICES['editor-blocked'];
        v.controls.close = 'enabled';
      } else if (terminal) {
        const detail = extra && extra.seq === s.asrSeq ? extra.text : null;
        v.status = s.state === 'inserted' ? STATUS.inserted : failureMessage(s.error, detail) + UNCHANGED;
        if (s.cleanupFailed) v.status += STATUS.cleanup;
        v.controls.close = 'enabled';
      }
      return v;
    }

    return Object.freeze({
      view, refresh, setServerCapability, start, stop, insert, repin, fieldClicked, cancel, close,
      pageExit: () => cancel('page-exit'),
      redraw: emit,
      snapshot: () => session.snapshot(),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    });
  }

  /**
   * The pane. Text goes through textContent only. Focus moves on the user's own steps, or when it
   * is already inside the pane; an answer arriving while someone types in a report field never
   * takes the keyboard away.
   */
  function mount(controller, el, hooks = {}) {
    const doc = el.pane.ownerDocument;
    // The unavailable title is the markup's own text, never a second copy of it (DI-13).
    const unavailableTitle = el.button.getAttribute('title');
    let paneFocus = false, lastState = null;
    const names = ['stop', 'cancel', 'repin', 'insert', 'close'];
    function primary(v) {
      if (v.controls.stop === 'enabled') return el.stop;
      if (v.state === 'review') return el.text;
      if (v.controls.cancel === 'enabled') return el.cancel;
      if (v.controls.close === 'enabled') return el.close;
      return null;
    }
    function render() {
      const v = controller.view();
      let disabled = true, title = unavailableTitle;
      if (v.serverAvailable && !v.browser) title = TITLES.browser;
      else if (v.serverAvailable && v.active) title = TITLES.active;
      else if (v.serverAvailable) { disabled = !!v.block; title = v.block || TITLES.ready; }
      if (el.button.disabled !== disabled) el.button.disabled = disabled;
      if (el.button.getAttribute('title') !== title) el.button.setAttribute('title', title);
      el.pane.hidden = !v.visible;
      el.status.textContent = v.status;
      el.text.textContent = v.text;
      el.text.hidden = !v.text;
      el.place.textContent = v.placement;
      el.meta.textContent = v.meta;
      if (v.metaTitle) el.meta.setAttribute('title', v.metaTitle); else el.meta.removeAttribute('title');
      for (const name of names) {
        const mode = v.controls[name];
        el[name].hidden = mode === 'hidden';
        el[name].disabled = mode !== 'enabled';
      }
      const advanced = v.state !== lastState;
      lastState = v.state;
      if (!v.visible) { paneFocus = false; return; }
      // Following the pane's own step keeps a second Enter from landing on Cancel by accident. A
      // control that just became disabled or hidden may still hold focus; that counts as lost.
      const current = doc.activeElement;
      const lost = !el.pane.contains(current) || !!current.disabled || !!current.hidden;
      if (paneFocus && (advanced || lost)) {
        const target = primary(v);
        if (target && doc.activeElement !== target) target.focus();
      }
    }
    el.pane.addEventListener('focusin', () => { paneFocus = true; });
    el.pane.addEventListener('focusout', e => { if (e.relatedTarget && !el.pane.contains(e.relatedTarget)) paneFocus = false; });
    el.pane.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (controller.view().active) controller.cancel(); else { controller.close(); if (hooks.closed) hooks.closed(); }
    });
    el.button.addEventListener('click', () => {
      if (el.button.disabled) return;
      paneFocus = true;
      controller.start();
    });
    el.stop.addEventListener('click', () => controller.stop());
    el.cancel.addEventListener('click', () => controller.cancel());
    el.repin.addEventListener('click', () => { controller.repin(); });
    el.close.addEventListener('click', () => { controller.close(); if (hooks.closed) hooks.closed(); });
    el.insert.addEventListener('click', async () => {
      const res = await controller.insert();
      if (res && res.inserted && hooks.inserted) hooks.inserted(res.field);
    });
    controller.subscribe(render);
    render();
    return Object.freeze({ render });
  }

  const api = Object.freeze({ TEXT_CAP, MAX_WAV_BYTES, CLIENT_MARGIN_MS, TITLES, REASONS, NOTICES, STATUS,
    parseCapability, browserCapable, readResponse, transcriptProblem, refusal, failureMessage, createController, mount });
  if (typeof window !== 'undefined') window.KinDictation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
