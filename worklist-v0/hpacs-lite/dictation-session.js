/* S3-ASR-U1a: review/insert lifecycle only. No microphone, transport, DOM or storage.
 * The host supplies live editor context (including reportEditorBlock), a finite
 * transcript policy, resource cleanup and a synchronous guarded insert operation.
 * Engine/capture integration and actual speech recognition are separate units.
 */
(function () {
  'use strict';
  const FIELDS = Object.freeze(['findings', 'conclusion', 'recommendation']);
  const ACTIVE = new Set(['requesting-permission', 'recording', 'uploading', 'review']);

  // Exact UTF-8 bytes: no NFC or line-ending normalization. The pin identifies
  // the field the user actually saw, not a normalized report representation.
  async function hashText(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function create(options) {
    if (!options || typeof options.readContext !== 'function' ||
        typeof options.validateTranscript !== 'function' || typeof options.insert !== 'function') {
      throw new TypeError('readContext, validateTranscript and synchronous insert are required');
    }
    const digest = options.hashText || hashText;
    if (typeof digest !== 'function') throw new TypeError('hashText must be a function');
    let available = false, state = 'unavailable', seq = 0, pin = null, text = '';
    let needsRepin = false, pending = false, ownsResources = false, error = null;

    function snapshot() {
      return Object.freeze({ state, asrSeq: seq, text, needsRepin, pending, error,
        pin: pin ? Object.freeze({ ...pin, caret: Object.freeze({ ...pin.caret }) }) : null });
    }
    function reply(ok, reason) { return { ok, reason: reason || null, token: seq, snapshot: snapshot() }; }
    function release(reason) {
      if (!ownsResources) return;
      ownsResources = false; // Clear before the callback, including reentrant cleanup.
      try { if (options.cleanup) options.cleanup(reason); }
      catch (_) { state = 'failed'; error = 'cleanup-failed'; }
    }
    function end(next, reason) {
      seq += 1; pending = false; pin = null; text = ''; needsRepin = false;
      state = next; error = reason || null; release(reason || next);
      return reply(next === 'inserted' && state === 'inserted', reason);
    }
    function current(token) { return token === seq && ACTIVE.has(state); }
    function context(field) {
      let v;
      try { v = options.readContext(field); } catch (_) { return null; }
      if (!v || v.blocked !== false || typeof v.uid !== 'string' || !v.uid ||
          !Number.isSafeInteger(v.selectionSeq) || v.selectionSeq < 0 ||
          !Number.isSafeInteger(v.baseVersion) || v.baseVersion < 0 ||
          !FIELDS.includes(v.field) || (field && field !== v.field) || typeof v.value !== 'string' ||
          !v.caret || !Number.isSafeInteger(v.caret.start) || !Number.isSafeInteger(v.caret.end) ||
          v.caret.start < 0 || v.caret.end < v.caret.start || v.caret.end > v.value.length) return null;
      return { uid: v.uid, selectionSeq: v.selectionSeq, baseVersion: v.baseVersion,
        field: v.field, value: v.value, caret: { start: v.caret.start, end: v.caret.end } };
    }
    function sameScope(a, b) {
      return !!a && !!b && a.uid === b.uid && a.selectionSeq === b.selectionSeq && a.baseVersion === b.baseVersion;
    }
    function checkScope(token, field) {
      if (!current(token)) return null;
      const live = context(field);
      if (!sameScope(live, pin)) { end('failed', 'editor-changed'); return null; }
      return live;
    }
    async function hashed(value) {
      const result = await digest(value);
      if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) throw new Error('Invalid SHA-256');
      return result;
    }
    function makePin(v, fieldValueHash) {
      return { uid: v.uid, selectionSeq: v.selectionSeq, baseVersion: v.baseVersion,
        field: v.field, caret: { ...v.caret }, asrSeq: seq, fieldValueHash };
    }
    function setAvailable(value) {
      available = value === true;
      if (!available) {
        if (ACTIVE.has(state)) end('unavailable', 'unavailable');
        else state = 'unavailable';
      } else if (state === 'unavailable') { state = 'idle'; error = null; }
      return snapshot();
    }
    async function begin() {
      if (!available) return reply(false, 'unavailable');
      if (ACTIVE.has(state)) return reply(false, 'busy');
      const start = context();
      if (!start) return reply(false, 'editor-blocked');
      const token = ++seq;
      state = 'requesting-permission'; error = null; text = ''; pin = null;
      needsRepin = false; pending = true; ownsResources = true;
      let h;
      try { h = await hashed(start.value); }
      catch (_) { return current(token) ? end('failed', 'hash-failed') : reply(false, 'stale'); }
      if (!current(token)) return reply(false, 'stale');
      const live = context(start.field);
      if (!sameScope(live, start) || live.value !== start.value) return end('failed', 'editor-changed');
      pin = makePin(start, h); pending = false;
      return reply(true);
    }
    function advance(token, from, to) {
      if (!current(token) || state !== from || pending || !pin) return reply(false, 'stale');
      if (!checkScope(token, pin.field)) return reply(false, 'editor-changed');
      state = to; return reply(true);
    }
    function receive(token, transcript) {
      if (!current(token) || state !== 'uploading' || pending || !pin) return reply(false, 'stale');
      if (!checkScope(token, pin.field)) return reply(false, 'editor-changed');
      let valid = false;
      try { valid = typeof transcript === 'string' && !!transcript.trim() && options.validateTranscript(transcript) === true; }
      catch (_) { /* A missing/failing host policy cannot admit a transcript. */ }
      if (!valid) return end('failed', 'invalid-transcript');
      text = transcript; state = 'review'; return reply(true);
    }
    async function repin(token) {
      if (!current(token) || state !== 'review') return reply(false, 'stale');
      if (pending) return reply(false, 'busy');
      if (!needsRepin) return reply(false, 'repin-not-required');
      const start = checkScope(token); // An explicit field selection may choose another permitted field.
      if (!start) return reply(false, 'editor-changed');
      pending = true;
      let h;
      try { h = await hashed(start.value); }
      catch (_) { return current(token) ? end('failed', 'hash-failed') : reply(false, 'stale'); }
      if (!current(token)) return reply(false, 'stale');
      const live = checkScope(token, start.field);
      if (!live) return reply(false, 'editor-changed');
      pending = false;
      if (live.value !== start.value) return reply(false, 'field-changed');
      pin = makePin(start, h); needsRepin = false; error = null;
      return reply(true); // Never inserts. A fresh, explicit Insert must follow.
    }
    async function insert(token) {
      if (!current(token) || state !== 'review') return reply(false, 'stale');
      if (pending) return reply(false, 'busy');
      const start = checkScope(token, pin.field);
      if (!start) return reply(false, 'editor-changed');
      if (needsRepin) return reply(false, 'field-changed');
      pending = true;
      let h;
      try { h = await hashed(start.value); }
      catch (_) { return current(token) ? end('failed', 'hash-failed') : reply(false, 'stale'); }
      if (!current(token)) return reply(false, 'stale');
      const live = checkScope(token, pin.field);
      if (!live) return reply(false, 'editor-changed');
      pending = false;
      if (live.value !== start.value || h !== pin.fieldValueHash) {
        needsRepin = true; error = 'field-changed'; return reply(false, 'field-changed');
      }
      const insertion = Object.freeze({ ...pin, caret: Object.freeze({ ...pin.caret }), text,
        expectedValue: start.value });
      // Consume before calling out: duplicate/reentrant Insert cannot use this session.
      seq += 1; state = 'inserted'; pin = null; text = ''; needsRepin = false; error = null;
      try {
        // The host must synchronously recheck its editor gate and perform placeBlock/normal
        // editor update. Async writes are forbidden: they would outlive the checked context.
        if (options.insert(insertion) !== true) { state = 'failed'; error = 'insert-refused'; }
      } catch (_) { state = 'failed'; error = 'insert-failed'; }
      release(state);
      return reply(state === 'inserted', error);
    }
    function cancel(reason) {
      if (!ACTIVE.has(state)) return reply(false, 'inactive');
      return end('cancelled', reason || 'cancelled');
    }
    function fail(token, reason) {
      // Transport/capture errors belong to acquisition, not to an already accepted review.
      if (!current(token) || state === 'review') return reply(false, 'stale');
      return end('failed', reason || 'failed');
    }
    return Object.freeze({ snapshot, setAvailable, begin, receive, repin, insert, cancel, fail,
      recording: token => advance(token, 'requesting-permission', 'recording'),
      uploading: token => advance(token, 'recording', 'uploading'),
      studyChanged: () => cancel('study-changed'), loggedOut: () => cancel('logged-out') });
  }
  const api = Object.freeze({ create, hashText });
  if (typeof window !== 'undefined') window.KinDictationSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
