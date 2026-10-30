'use strict';
// The product screen inside a same-origin iframe that fills its window: open a screen, reload after a change and
// measure until the screen is usable again, keep the selected study, collect the screen's JavaScript errors.
// Used by the product window (two-window mode) and by the studio window itself (overlay mode).
(() => {
  const { api } = window.Studio;

  window.StudioMirror = function StudioMirror(iframe, hooks = {}) {
    const state = { errors: [], pending: null };
    const call = (name, ...args) => { if (hooks[name]) hooks[name](...args); };

    function doc() { try { return iframe.contentDocument; } catch { return null; } }

    function selectedStudy() {
      try {
        const tr = doc() && doc().querySelector('#rows tr.sel');
        if (!tr) return null;
        const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim()).filter(Boolean).slice(0, 6).join(' · ');
        return { uid: tr.dataset.uid, label: cells };
      } catch { return null; }
    }

    // hooks.heldField: the product field picking took the keyboard from, which is still where he is typing.
    function typing() {
      try {
        const active = (hooks.heldField && hooks.heldField()) || (doc() && doc().activeElement);
        return !!active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /text|search/.test(active.type)) || active.isContentEditable);
      } catch { return false; }
    }

    function page() {
      try { return iframe.contentWindow.location.pathname + iframe.contentWindow.location.search; } catch { return ''; }
    }

    function pushError(text) {
      state.errors.push(text);
      if (state.errors.length > 20) state.errors.shift();
      call('onErrors', state.errors.slice());
    }

    // Each navigation gives a new window object inside the iframe; hook it once.
    function watch() {
      try {
        const win = iframe.contentWindow;
        if (!win || win.__studioWatched) return;
        win.__studioWatched = true;
        win.addEventListener('error', e => pushError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
        win.addEventListener('unhandledrejection', e => pushError(`unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
        call('onWindow', win);
        if (win.document.title) call('onTitle', win.document.title);
      } catch { /* about:blank or navigating */ }
    }
    iframe.addEventListener('load', () => { watch(); call('onLoad'); });

    // The caller remembers the chosen screen; this value may already be mapped for the role (Clinician).
    function open(value) {
      state.errors = []; call('onErrors', []);
      iframe.src = value;
    }

    // Reload and measure until the screen is usable again (the worklist rows are back, not just DOMContentLoaded),
    // then put the same study back in focus.
    function reload(ev = {}) {
      state.pending = null;
      call('onPending', null);
      const keep = selectedStudy();
      const started = performance.now();
      const onLoad = () => {
        iframe.removeEventListener('load', onLoad);
        const deadline = started + 30000;
        const poll = () => {
          const d = doc();
          const isList = d && /main\.html/.test(d.location.pathname);
          const ready = d && d.readyState === 'complete' && (!isList || d.querySelector('#rows tr[data-uid]'));
          if (ready || performance.now() > deadline) {
            const reloadMs = Math.round(performance.now() - started);
            const readyKind = ready ? (isList ? 'rows' : 'load') : 'timeout';
            if (ev.jobId) api('metrics/reload', { json: { jobId: ev.jobId, reloadMs, readyKind } }).catch(() => {});
            if (keep && isList) {
              const row = d.querySelector(`#rows tr[data-uid="${CSS.escape(keep.uid)}"]`);
              if (row) row.click();
            }
            call('onReloaded', { jobId: ev.jobId || null, reason: ev.reason || 'manual', reloadMs, readyKind });
            return;
          }
          setTimeout(poll, 50);
        };
        poll();
      };
      iframe.addEventListener('load', onLoad);
      try { iframe.contentWindow.location.reload(); } catch { iframe.src = iframe.src; }
    }

    // An edit that lands while he is typing in the product waits for "지금 보기" instead of wiping the text.
    function request(ev) {
      if (typing() && ev.reason === 'edit') { state.pending = ev; call('onPending', ev); return 'deferred'; }
      reload(ev);
      return 'reloaded';
    }

    return {
      iframe, open, reload, request, page, selectedStudy, typing,
      applyPending: () => reload(state.pending || {}),
      errors: () => state.errors.slice(),
      context() {
        const study = selectedStudy();
        return { page: page(), study: study ? `${study.uid} (${study.label})` : null, errors: state.errors.slice(-5) };
      },
    };
  };
})();
