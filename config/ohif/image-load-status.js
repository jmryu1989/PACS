// A failed pixel request is otherwise only a console error in the pinned viewer. Keep its explanation on the
// affected frame until that image loads or the viewport changes; a failed prefetch must not cover a displayed image.
function kinCreateImageLoadStatus() {
  let services, stop;
  function explanation(error) {
    const status = error?.status;
    const http = Number.isInteger(status) && status > 0 ? ' (HTTP ' + status + ')' : '';
    let body = error?.response;
    try {
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new TextDecoder().decode(body);
      if (typeof body === 'string') body = JSON.parse(body);
      if (body?.code === 'IMAGE_SOURCE_IDENTITY_UNAVAILABLE' && typeof body.message === 'string') return body.message + http;
    } catch (_) { /* A non-JSON image-server error still has a visible explanation. */ }
    return '영상 데이터를 불러오지 못했습니다' + http +
      '. 뷰어를 다시 열어 보고, 계속되면 관리자에게 문의하세요.';
  }
  function mount() {
    stop?.();
    const core = window.cornerstone, failures = new Map(), notices = new Map();
    const responses = new Map(), originalFetch = window.fetch;
    let active = true;
    const imageUrl = imageId => {
      try { return new URL(imageId.replace(/^wadors:/, ''), window.location.href).href; } catch (_) { return null; }
    };
    // The pinned loader's first-frame fetch throws only an Error(message), unlike its XHR loads.
    // Keep the failed response's explanation before that conversion; return the same Response and never retry pixels.
    const observedFetch = async function (input, init) {
      const response = await originalFetch.call(this, input, init);
      if (!active || response.ok) return response;
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
      if (url.origin === window.location.origin &&
          url.pathname.startsWith('/dicom-web/') && url.pathname.includes('/frames/')) {
        let body;
        try { body = await response.clone().json(); } catch (_) { /* Non-JSON failures still retain their HTTP status. */ }
        if (active) responses.set(url.href, { status: response.status, response: body });
      }
      return response;
    };
    window.fetch = observedFetch;
    function refresh() {
      if (!failures.size && !notices.size) return;
      const current = new Map();
      for (const engine of core.getRenderingEngines()) for (const view of engine.getViewports()) {
        const text = failures.get(view.getCurrentImageId?.());
        if (text && view.element?.isConnected) current.set(view.element, text);
      }
      for (const [element, notice] of notices) if (!current.has(element)) { notice.remove(); notices.delete(element); }
      for (const [element, text] of current) {
        let notice = notices.get(element);
        if (!notice) {
          notice = document.createElement('p'); notice.setAttribute('role', 'alert');
          notice.style.cssText = 'position:absolute;inset:12px 12px auto;margin:0;padding:12px;background:#161c25;color:#ffb4a8;z-index:10;pointer-events:none;white-space:normal';
          notices.set(element, notice); element.append(notice);
        }
        if (notice.textContent !== text) notice.textContent = text;
      }
    }
    const failed = event => {
      const { imageId, error } = event.detail || {};
      if (typeof imageId !== 'string') return;
      const url = imageUrl(imageId), response = responses.get(url);
      responses.delete(url);
      // A completed load can overtake an older failed request for the same image during A -> B -> A navigation.
      if (core.cache.getImage(imageId)) return;
      failures.set(imageId, explanation(error?.status ? error : response ?? error)); refresh();
    };
    const loaded = event => {
      const imageId = event.detail?.imageId ?? event.detail?.image?.imageId;
      failures.delete(imageId);
      if (typeof imageId === 'string') responses.delete(imageUrl(imageId));
      refresh();
    };
    const events = core.Enums.Events;
    core.eventTarget.addEventListener(events.IMAGE_LOAD_FAILED, failed);
    core.eventTarget.addEventListener(events.IMAGE_LOADED, loaded);
    document.addEventListener(events.STACK_NEW_IMAGE, refresh, true);
    document.addEventListener(events.VIEWPORT_NEW_IMAGE_SET, refresh, true);
    // React can mount the viewport after the load has already failed. Observe that mount, without a polling timer.
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    const subscription = services.viewportGridService.subscribe(services.viewportGridService.EVENTS.GRID_STATE_CHANGED, refresh);
    stop = () => {
      active = false;
      if (window.fetch === observedFetch) window.fetch = originalFetch;
      core.eventTarget.removeEventListener(events.IMAGE_LOAD_FAILED, failed);
      core.eventTarget.removeEventListener(events.IMAGE_LOADED, loaded);
      document.removeEventListener(events.STACK_NEW_IMAGE, refresh, true);
      document.removeEventListener(events.VIEWPORT_NEW_IMAGE_SET, refresh, true);
      observer.disconnect(); subscription.unsubscribe();
      for (const notice of notices.values()) notice.remove();
      notices.clear(); failures.clear(); responses.clear();
    };
  }
  return { id: 'kin.image-load-status', preRegistration({ servicesManager }) { services = servicesManager.services; },
    onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
