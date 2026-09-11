/* Read-only link to the reading workspace's unsaved report editor.
 * The viewer never stores, relays or persists the editor body: it is asked for
 * on every check, verified against one owner/session/target, and kept in memory. */
(function (root) {
  'use strict';
  const FIELDS = ['findings', 'conclusion', 'recommendation'];
  const MAX = 200000;
  const REFUSALS = ['session', 'context', 'modal', 'unavailable', 'denied'];
  const REASONS = {
    session: '판독 화면의 세션이 바뀌었습니다. 다시 연결하세요.',
    context: '판독 화면의 편집 대상이 이 검사가 아닙니다.',
    modal: '판독 화면의 대화상자를 닫은 뒤 다시 확인하세요.',
    unavailable: '판독문 입력란을 확인할 수 없습니다.',
    denied: '편집문 출력 권한이 없습니다.',
    invalid: '편집문 응답을 확인할 수 없습니다.',
    timeout: '판독 화면의 응답이 없습니다. 목록 창에서 영상 창을 다시 연결하세요.',
    missing: '연결된 판독 화면이 없습니다. 판독 화면에서 연 영상 창에서만 편집문을 출력할 수 있습니다.',
  };
  function reasonText(reason) { return REASONS[reason] || REASONS.invalid; }
  const refusal = reason => ({ ok: false, reason });
  // Never throws: a malformed or foreign reply must close the choice, not the
  // dialog, and must never be mistaken for an answer about this study.
  function validReply(message, expected) {
    try {
      if (!message || typeof message !== 'object' || message.type !== 'kin-editor-reply') return refusal('invalid');
      if (!expected || typeof expected !== 'object') return refusal('invalid');
      if (typeof expected.request !== 'string' || typeof message.request !== 'string' ||
          message.request !== expected.request) return refusal('invalid');
      if (typeof expected.owner !== 'string' || typeof message.owner !== 'string' ||
          message.owner !== expected.owner) return refusal('invalid');
      if (!Array.isArray(expected.studies) || !Array.isArray(message.studies) ||
          message.studies.length !== expected.studies.length ||
          message.studies.some((uid, index) => uid !== expected.studies[index])) return refusal('invalid');
      if (typeof expected.activeUid !== 'string' || typeof message.activeUid !== 'string' ||
          message.activeUid !== expected.activeUid) return refusal('invalid');
      if (REFUSALS.includes(message.result)) return refusal(message.result);
      if (message.result !== 'ok') return refusal('invalid');
      if (typeof message.session !== 'string' || !message.session || message.session.length > MAX) return refusal('invalid');
      const body = message.editor;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refusal('invalid');
      const editor = {};
      for (const key of FIELDS) {
        const text = body[key];
        if (typeof text !== 'string' || text.length > MAX) return refusal('invalid');
        editor[key] = text;
      }
      return { ok: true, editor, session: message.session };
    } catch (_) { return refusal('invalid'); }
  }
  const shape = value => value && typeof value === 'object' && !Array.isArray(value)
    ? [value.owner, value.uid, value.session, FIELDS.map(key => value.editor ? value.editor[key] : undefined)] : null;
  function sameEditor(a, b) {
    const left = shape(a), right = shape(b);
    if (!left || !right) return false;
    return JSON.stringify(left) === JSON.stringify(right);
  }
  const api = { validReply, sameEditor, reasonText, FIELDS, MAX };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.kinViewerEditorLinkApi = api;
})(globalThis);
// The adapter is read-only: it asks one bound window for the current editor and
// answers with the exact body it received, or with the refusal reason.
globalThis.kinViewerEditorLink = function (options) {
  'use strict';
  const pure = globalThis.kinViewerEditorLinkApi;
  const settings = options || {};
  const view = settings.window || globalThis;
  const studies = Array.isArray(settings.studies) ? settings.studies.slice() : [];
  const owner = typeof settings.owner === 'function' ? settings.owner : () => null;
  const live = typeof settings.live === 'function' ? settings.live : () => false;
  const target = 'target' in settings ? settings.target
    : (view.opener || (view.parent !== view ? view.parent : null));
  const origin = settings.origin || view.location?.origin;
  const timeoutMs = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 2500;
  const pending = new Set();
  let disposed = false;
  function available() {
    if (disposed || !target || !studies.length || !origin) return false;
    try { return !!live() && !!owner(); } catch (_) { return false; }
  }
  function read(signal) {
    return new Promise((resolve, reject) => {
      let bound = null;
      try { const value = owner(); bound = value ? JSON.stringify(value) : null; } catch (_) { bound = null; }
      if (!available() || !bound) { resolve({ ok: false, reason: 'missing' }); return; }
      const request = view.crypto.randomUUID();
      const expected = { request, owner: bound, studies: studies.slice(), activeUid: studies[0] };
      const entry = { cancel: null };
      let timer = null;
      function finish(value, error) {
        if (!pending.has(entry)) return;
        pending.delete(entry);
        if (timer !== null) clearTimeout(timer);
        view.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      }
      function onAbort() { finish(null, new Error('출력 확인이 취소되었습니다.')); }
      // Only the bound window of this same origin can answer; every other
      // message on this window is ignored rather than refused.
      function onMessage(event) {
        if (event.origin !== origin || event.source !== target) return;
        const data = event.data;
        if (!data || typeof data !== 'object' || data.type !== 'kin-editor-reply' || data.request !== request) return;
        const checked = pure.validReply(data, expected);
        if (!checked.ok) { finish({ ok: false, reason: checked.reason }); return; }
        finish({ owner: expected.owner, uid: expected.activeUid, session: checked.session, editor: checked.editor });
      }
      entry.cancel = () => finish({ ok: false, reason: 'missing' });
      pending.add(entry);
      view.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
      try {
        target.postMessage({ type: 'kin-editor-request', request, owner: bound,
          studies: studies.slice(), activeUid: studies[0] }, origin);
      } catch (_) { finish({ ok: false, reason: 'missing' }); }
    });
  }
  function dispose() { disposed = true; for (const entry of [...pending]) entry.cancel(); }
  return { available, read, dispose };
};
