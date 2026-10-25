/* W9 multi-study view, viewer side. A viewer opened by the worklist's Multi-Study View carries its opening id in the URL
 * fragment (`kin-w9=<uuid>`). This document then reports, on the channel of that opening only, the first original frame of
 * each of its own studies that its renderer actually showed: a stack viewport that rendered the requested image, visible
 * and not inert, whose image id names that study's Series/SOP/frame (Frame Coverage's public reference rule). An HTTP
 * answer, a load, a canvas or the other study's image is not reported for a member. It also shows the composition's strip
 * (sanitized state from the worklist) and sends its two page buttons back as intents; the worklist decides everything.
 * Nothing is recorded or sent to the server here, and the strip never names another patient's study.
 */
(function (root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const uid = v => typeof v === 'string' && v.length <= 64 && /^\d+(?:\.\d+)+$/.test(v);
  // Display sets whose modality is a document, not an original image (SR/SEG/PR/KO/DOC/RTSTRUCT): a study with only these
  // has nothing to display as an image.
  const DOCUMENTS = new Set(['SR', 'SEG', 'PR', 'KO', 'DOC', 'RTSTRUCT']);

  function opening(href) {
    try {
      const values = new URLSearchParams(new URL(href).hash.slice(1)).getAll('kin-w9');
      return values.length === 1 && UUID.test(values[0]) ? values[0] : null;
    } catch (_) { return null; }
  }
  function studiesOf(href) {
    try {
      const values = new URL(href).searchParams.getAll('StudyInstanceUIDs');
      const list = values.length === 1 ? values[0].split(',') : [];
      return list.length >= 1 && list.length <= 2 && list.every(uid) && new Set(list).size === list.length ? list : null;
    } catch (_) { return null; }
  }
  /** Shown to the reader: the element is connected, laid out, not hidden or inert, in a visible document and frame. */
  function visible(element) {
    try {
      let w = root, e = element;
      if (!e?.isConnected) return false;
      while (e) {
        if (w.document.hidden || e.closest('[hidden],[inert]') || !e.getClientRects().length) return false;
        for (let a = e; a; a = a.parentElement) {
          const s = w.getComputedStyle(a);
          if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
        }
        if (w === w.top) break;
        e = w.frameElement; w = w.parent;
      }
      return true;
    } catch (_) { return false; }
  }

  function mount(services) {
    const core = root.cornerstone, search = root.location.search;
    let id = null, studies = null, channel = null, shown = new Set(), noImages = new Set(), state = null, ended = false;
    let sessionChannel = null, timer = null, unsubscribe = [];
    const strip = document.createElement('section'); strip.id = 'kin-multi-study';
    strip.setAttribute('aria-label', 'Multi-Study View');
    strip.innerHTML = '<h3>Multi-Study View</h3><p data-summary role="status"></p><ol data-members></ol>' +
      '<p><button type="button" data-action="previous">Previous</button> <button type="button" data-action="next">Next</button> ' +
      '<button type="button" data-action="pages">Back to Pages</button></p><p data-note>목록 창의 여러 검사 보기와 연결된 영상입니다. 판독 대상은 바꾸지 않습니다.</p>';
    const summary = strip.querySelector('[data-summary]'), members = strip.querySelector('[data-members]');
    const buttons = [...strip.querySelectorAll('button')];
    const live = () => !ended && root.location.search === search;

    function render() {
      const s = state;
      summary.textContent = !live() ? '세션이 종료되었습니다.' : s === 'ended' ? '목록 창과의 연결이 끊어졌습니다. 목록에서 다시 여세요.'
        : !s ? '목록 창의 상태를 기다리는 중입니다.' : [s.summary, s.status].filter(Boolean).join(' · ');
      members.replaceChildren(...(s && s !== 'ended' ? s.members : []).map(m => {
        const li = document.createElement('li');
        li.textContent = [m.label, m.state, m.viewing ? 'Viewing' : ''].filter(Boolean).join(' · ');
        return li;
      }));
      for (const b of buttons) {
        const action = b.dataset.action;
        b.disabled = !live() || !s || s === 'ended' || s.busy ||
          !(action === 'previous' ? s.canPrevious : action === 'next' ? s.canNext : s.canPages);
      }
      strip.hidden = !id;
    }
    function send(message) { try { channel?.postMessage({ ...message, opening: id }); } catch (_) {} }
    function bind() {
      const next = live() ? opening(root.location.href) : null;
      if (next === id) return;
      channel?.close(); channel = null;
      id = next; studies = studiesOf(root.location.href); shown = new Set(); noImages = new Set(); state = null;
      if (id && studies) {
        try {
          channel = new BroadcastChannel('kin-w9:' + id);
          channel.onmessage = event => {
            const m = event.data;
            if (!live() || !m || m.opening !== id) return;
            if (m.type === 'state' && Array.isArray(m.members)) { state = m; render(); }
            else if (m.type === 'ended' || m.type === 'replaced') { state = 'ended'; render(); }
          };
        } catch (_) { channel = null; }
        send({ type: 'hello' });
        // A reused document (the same studies, a new opening) shows its current images again through the renderer; a cached
        // image is never reported without that render.
        try { for (const e of core.getEnabledElements()) e.viewport.render(); } catch (_) {}
        checkDocuments();
      }
      render();
    }
    function onImage(event) {
      if (!live() || !id || !studies) return;
      try {
        const element = event.detail?.element, v = core.getEnabledElement(element)?.viewport;
        if (!v || v.type !== 'stack' || v.id !== event.detail.viewportId || v.viewportStatus !== 'rendered' || !visible(element)) return;
        const image = v.getCurrentImageId();
        // The renderer advances its current index before the pixels arrive; a redraw of the previous actor is not this image.
        if (v.csImage?.imageId !== image || v.stackInvalidated) return;
        const ref = root.KinFrameCoverage?.reference(image, core.metaData.get('instance', image));
        if (!ref || !studies.includes(ref.study) || shown.has(ref.study)) return;
        const engine = v.getRenderingEngine?.();
        if (engine?.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.()?.getContext?.()?.isContextLost() ||
            root.kinViewerContextLoss?.usable(engine) === false) return;
        shown.add(ref.study);
        send({ type: 'displayed', study: ref.study, series: ref.series, sop: ref.sop, frame: ref.frame });
      } catch (_) {}
    }
    function checkDocuments() {
      if (!live() || !id || !studies) return;
      try {
        const sets = services.displaySetService.getActiveDisplaySets();
        for (const study of studies) {
          const own = sets.filter(ds => ds.StudyInstanceUID === study);
          if (own.length && own.every(ds => DOCUMENTS.has(String(ds.Modality || '').toUpperCase())) && !shown.has(study) && !noImages.has(study)) {
            noImages.add(study); send({ type: 'no-images', study });
          }
        }
      } catch (_) {}
    }
    const onLink = () => bind();
    root.addEventListener('hashchange', onLink);
    root.addEventListener('kin-window-link-changed', onLink);
    document.addEventListener(core.Enums.Events.IMAGE_RENDERED, onImage, true);
    try {
      const ds = services.displaySetService, events = ds.EVENTS || {};
      for (const name of ['DISPLAY_SETS_ADDED', 'DISPLAY_SETS_CHANGED']) if (events[name]) unsubscribe.push(ds.subscribe(events[name], checkDocuments).unsubscribe);
    } catch (_) {}
    // A lost rendering context is the whole viewer failing without a member attribution (the viewer's existing context-loss
    // signal, which may finish loading after this mount): the worklist marks every member not yet shown Unverified at once
    // instead of at the display bound.
    let watching = false;
    const watchContext = () => {
      if (watching || ended) return;
      try {
        const stop = root.kinViewerContextLoss?.onContextLoss?.(() => { if (live() && id && studies) send({ type: 'failed' }); });
        if (typeof stop === 'function') { watching = true; unsubscribe.push(stop); }
      } catch (_) {}
    };
    root.addEventListener('kin-context-recovery-ready', watchContext);
    watchContext();
    for (const b of buttons) b.onclick = () => { if (!b.disabled) send({ type: 'intent', action: b.dataset.action }); };
    function end() { if (ended) return; ended = true; channel?.close(); channel = null; render(); }
    try { sessionChannel = root.kinViewerOnEnd(() => end()); } catch (_) {}
    // The KIN tools panel (#kin-viewer-layout) is built by another extension; attach there once it exists.
    timer = setInterval(() => { if (!live()) { end(); return; } if (!strip.isConnected) document.querySelector('#kin-viewer-layout')?.append(strip); }, 250);
    bind();
    return { stop() {
      end(); clearInterval(timer); sessionChannel?.close?.(); unsubscribe.forEach(u => { try { u(); } catch (_) {} });
      root.removeEventListener('hashchange', onLink); root.removeEventListener('kin-window-link-changed', onLink);
      root.removeEventListener('kin-context-recovery-ready', watchContext);
      document.removeEventListener(core.Enums.Events.IMAGE_RENDERED, onImage, true); strip.remove();
    } };
  }

  const api = { opening, studiesOf, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinViewerMultiStudy = api;
})(globalThis);
