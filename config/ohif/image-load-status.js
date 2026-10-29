// A failed pixel request is otherwise only a console error in the pinned viewer. Keep its explanation on the
// affected frame until that image loads or the viewport changes; a failed prefetch must not cover a displayed image.
function kinCreateImageLoadStatus() {
  let services, stop;
  function explanation(error) {
    let body = error?.response ?? error?.request?.response;
    try {
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new TextDecoder().decode(body);
      if (typeof body === 'string') body = JSON.parse(body);
      if (body?.code === 'IMAGE_SOURCE_IDENTITY_UNAVAILABLE' && typeof body.message === 'string') return body.message;
    } catch (_) { /* A non-JSON image-server error still has a visible explanation. */ }
    const status = error?.status ?? error?.request?.status;
    return '영상 데이터를 불러오지 못했습니다' + (Number.isInteger(status) && status > 0 ? ' (HTTP ' + status + ')' : '') +
      '. 원본 검사와 환자 정보를 확인한 후 뷰어를 다시 열어 주세요.';
  }
  function mount() {
    stop?.();
    const core = window.cornerstone, failures = new Map(), notices = new Map();
    function refresh() {
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
      // A completed load can overtake an older failed request for the same image during A -> B -> A navigation.
      if (core.cache.getImage(imageId)) return;
      failures.set(imageId, explanation(error)); refresh();
    };
    const loaded = event => {
      failures.delete(event.detail?.imageId ?? event.detail?.image?.imageId); refresh();
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
      core.eventTarget.removeEventListener(events.IMAGE_LOAD_FAILED, failed);
      core.eventTarget.removeEventListener(events.IMAGE_LOADED, loaded);
      document.removeEventListener(events.STACK_NEW_IMAGE, refresh, true);
      document.removeEventListener(events.VIEWPORT_NEW_IMAGE_SET, refresh, true);
      observer.disconnect(); subscription.unsubscribe();
      for (const notice of notices.values()) notice.remove();
      notices.clear(); failures.clear();
    };
  }
  return { id: 'kin.image-load-status', preRegistration({ servicesManager }) { services = servicesManager.services; },
    onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
