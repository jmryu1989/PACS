// A failed pixel request is otherwise only a console error in the pinned viewer. Keep its explanation on the
// affected frame until that image loads or the viewport changes; a failed prefetch must not cover a displayed image.
function kinCreateImageLoadStatus() {
  // The SOF3 decoder lives for the page: once it could not load, later mode entries keep the pinned path.
  let services, extensions, stop, handleGlobal, sof3, registered = false;
  const globalFailure = event => handleGlobal?.(event);
  function explanation(error) {
    const status = error?.status;
    const http = Number.isInteger(status) && status > 0 ? ' (HTTP ' + status + ')' : '';
    let body = error?.response;
    try {
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new TextDecoder().decode(body);
      if (typeof body === 'string') body = JSON.parse(body);
      if (['IMAGE_SOURCE_IDENTITY_UNAVAILABLE', 'ImageCurrentStudyChanged', 'ImageRequestContextUnavailable',
        'IMAGE_DELIVERY_RECORD_UNAVAILABLE', 'AUTH_SESSION_ENDED', 'AUTH_SESSION_MISMATCH'].includes(body?.code) &&
          typeof body.message === 'string') return body.message + http;
    } catch (_) { /* A non-JSON image-server error still has a visible explanation. */ }
    if (status === 401) return '로그인 세션을 확인할 수 없습니다. 업무 화면에서 다시 로그인한 뒤 검사를 여세요.' + http;
    if (status === 403) return '이 검사 영상의 접근 권한이 없습니다. 기관과 검사 접근 권한을 확인하세요.' + http;
    if (status === 404) return '요청한 원본 영상 또는 프레임이 없습니다. 검사 목록을 새로 고친 뒤 다시 여세요.' + http;
    if (status === 409) return '검사 원본이나 환자 연결이 변경되었습니다. 검사 목록에서 다시 여세요.' + http;
    if (status === 400 || status === 416) return '요청한 프레임 번호나 영상 범위가 올바르지 않습니다. 검사를 다시 열고 계속되면 관리자에게 문의하세요.' + http;
    if (status === 429 || status >= 500) return '영상 서버가 요청을 완료하지 못했습니다. 잠시 후 검사를 다시 열어 주세요.' + http;
    const message = String(error?.message ?? error ?? '');
    if (message === 'CACHE_SIZE_EXCEEDED' || /Array buffer allocation failed|Invalid typed array length|out of memory/i.test(message))
      return '영상 표시 메모리가 부족합니다. 사용하지 않는 영상 창을 닫고 검사를 다시 여세요.';
    if (error?.name === 'EvalError' || /WebAssembly|\bwasm\b|content security policy|unsafe-eval/i.test(message))
      return '압축 영상 프레임을 해독하지 못했습니다. 뷰어 보안 정책과 WebAssembly 디코더 설정을 관리자에게 확인해 주세요.';
    if (error?.code === 'IMAGE_DECODE_EMPTY' || /empty decoded image frame/i.test(message))
      return '압축 영상 프레임의 해독 결과가 비어 있거나 불완전합니다. 원본 파일 손상과 압축 형식을 관리자에게 확인해 주세요.';
    if (/transfer syntax|decode|decoder|codestream/i.test(message))
      return '압축 영상 프레임을 해독하지 못했습니다. 원본의 압축 형식과 파일 손상을 관리자에게 확인해 주세요.';
    if (error?.name === 'TimeoutError' || /timeout|timed out/i.test(message))
      return '영상 서버 응답 시간이 초과되었습니다. 연결 상태를 확인한 뒤 검사를 다시 여세요.';
    if (error?.name === 'AbortError') return '영상 요청이 취소되었습니다. 이 프레임이 필요하면 검사를 다시 여세요.';
    if (status === 0 || /Failed to fetch|NetworkError|Load failed|no image frame|multipart|truncat|short read|terminated/i.test(message))
      return '영상 전송이 끊겼거나 프레임이 완전하지 않습니다. 연결 상태를 확인한 뒤 검사를 다시 여세요.';
    return '영상 데이터를 불러오지 못했습니다' + http +
      '. 뷰어를 다시 열어 보고, 계속되면 관리자에게 문의하세요.';
  }
  function mount() {
    stop?.();
    const core = window.cornerstone, failures = new Map(), notices = new Map();
    const knownErrors = new WeakMap(), primitiveErrors = new Map(), announced = new Set();
    const rememberKnown = (error, detail) => {
      if (error && typeof error === 'object') knownErrors.set(error, detail);
      else if (typeof error === 'string' && error) primitiveErrors.set(error, detail);
    };
    const responses = new Map(), requests = new Map(), originalFetch = window.fetch;
    let active = true, sequence = 0;
    // Reject at the worker result boundary, before createImage/cache/IMAGE_LOADED can turn a corrupt codestream
    // into a successful blank frame. The loader's existing rejection path supplies the affected imageId.
    const workerManager = core.getWebWorkerManager?.(), executeTask = workerManager?.executeTask;
    sof3 ??= kinCreateSof3Decode({ size: window.config?.maxNumberOfWebWorkers || 3 });
    const checkedDecode = function (workerName, methodName, ...args) {
      const decode = active && workerName === 'dicomImageLoader' && methodName === 'decodeTask';
      const dispatch = task => executeTask.call(this, workerName, methodName, task, ...args.slice(1));
      const result = (decode && sof3.decode(args[0], dispatch)) || executeTask.call(this, workerName, methodName, ...args);
      if (!decode) return result;
      return result.then(frame => {
        if (!(frame?.rows > 0 && frame?.columns > 0 && frame?.pixelData?.length > 0)) {
          const error = new Error('Empty decoded image frame');
          error.code = 'IMAGE_DECODE_EMPTY';
          throw error;
        }
        return frame;
      });
    };
    if (executeTask) workerManager.executeTask = checkedDecode;
    // Orthanc supplies the data source configuration. The pinned loader reads that object on every beforeSend,
    // not window.config.acceptHeader. Restore it on mode exit, keeping any later owner's changes intact.
    const configurations = [];
    for (const source of extensions?.getActiveDataSource?.() || []) {
      const config = source.getConfig?.();
      if (!config) continue;
      const previous = config.acceptHeader;
      const accept = window.config?.acceptHeader;
      if (!Array.isArray(accept)) continue;
      config.acceptHeader = accept;
      configurations.push({ config, previous, accept });
    }
    const imageUrl = imageId => {
      try { return new URL(imageId.replace(/^wadors:/, ''), window.location.href).href; } catch (_) { return null; }
    };
    // The pinned loader's first-frame fetch throws only an Error(message), unlike its XHR loads. Its streaming
    // loop also spins at EOF on an empty 200. Validate the transport envelope while streaming (only a short tail
    // is retained), so empty/truncated frames reject before they can be counted as a completed image.
    const observedFetch = async function (input, init) {
      if (!active) return originalFetch.call(this, input, init);
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
      const frame = url.origin === window.location.origin &&
        /^\/dicom-web\/studies\/[^/]+\/series\/[^/]+\/instances\/[^/]+\/frames\//.test(url.pathname);
      const request = frame ? ++sequence : null;
      if (frame) requests.set(url.href, request);
      const remember = error => {
        if (active && error && typeof error === 'object') knownErrors.set(error,
          { imageId: 'wadors:' + url.href, text: explanation(error), url: url.href, request });
        return error;
      };
      let response;
      try { response = await originalFetch.call(this, input, init); }
      catch (error) { if (frame) remember(error); throw error; }
      if (!active || !frame) return response;
      if (!response.ok) {
        let body;
        try { body = await response.clone().json(); } catch (_) { /* Non-JSON failures still retain their HTTP status. */ }
        if (active && requests.get(url.href) === request) responses.set(url.href, { status: response.status, response: body });
        return response;
      }
      const method = init?.method || (typeof input === 'object' && input.method) || 'GET';
      if (method === 'HEAD') return response;
      const contentType = response.headers.get('Content-Type') || '';
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
      const closing = boundary && response.status === 200 ? new TextEncoder().encode('--' + (boundary[1] || boundary[2]) + '--') : null;
      let length = 0, tail = new Uint8Array();
      const incomplete = () => remember(new Error('Incomplete multipart image frame'));
      if (!response.body) throw incomplete();
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          length += chunk.byteLength;
          if (closing) {
            const joined = new Uint8Array(tail.length + chunk.length); joined.set(tail); joined.set(chunk, tail.length);
            tail = joined.slice(-closing.length - 2);
          }
          controller.enqueue(chunk);
        },
        flush() {
          if (!length) throw incomplete();
          if (closing) {
            const end = tail.length >= 2 && tail[tail.length - 2] === 13 && tail[tail.length - 1] === 10 ? tail.length - 2 : tail.length;
            const start = end - closing.length;
            if (start < 0 || !closing.every((byte, i) => tail[start + i] === byte)) throw incomplete();
          }
          const expected = response.headers.get('Content-Length');
          if (expected && !response.headers.get('Content-Encoding') && Number(expected) !== length) throw incomplete();
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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
      const observed = error && typeof error === 'object' ? knownErrors.get(error) : null;
      if (observed?.request && requests.get(observed.url) !== observed.request) return;
      responses.delete(url);
      const text = explanation(error?.status ? error : response ?? error);
      rememberKnown(error, { ...observed, imageId, text });
      // A completed load can overtake an older failed request for the same image during A -> B -> A navigation.
      if (core.cache.getImage(imageId)) return;
      failures.set(imageId, text); refresh();
    };
    // OHIF 3.9.1 ui-next ErrorBoundary also listens to global errors/rejections and emits its generic toast after
    // 100 ms. Handle only an error positively associated with an image request; unrelated errors retain that path.
    const unhandled = event => {
      const error = event.reason ?? event.error;
      let known = error && typeof error === 'object' ? knownErrors.get(error) : primitiveErrors.get(error);
      if (!known) {
        const match = /^Couldn't retrieve (\S+) got status (\d{3})$/.exec(error?.message || '');
        if (match) {
          try {
            const url = new URL(match[1], window.location.href);
            if (url.origin === window.location.origin && /^\/dicom-web\/studies\/[^/]+\/series\/[^/]+\/instances\/[^/]+\/frames\//.test(url.pathname))
              known = { imageId: 'wadors:' + url.href, text: explanation(responses.get(url.href) ?? { status: Number(match[2]) }) };
          } catch (_) {}
        }
      }
      if (!known) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (known.metadata) return; // Series recovery already showed the terminal reason after its one retry.
      if (known.request && requests.get(known.url) !== known.request) return;
      if (core.cache.getImage(known.imageId)) return;
      failures.set(known.imageId, known.text); refresh();
      if (!announced.has(known.imageId)) {
        announced.add(known.imageId);
        services.uiNotificationService?.show?.({ title: 'Image Loading', message: known.text, type: 'error' });
      }
    };
    const metadataFailed = event => {
      const { error, message } = event.detail || {};
      if (typeof message === 'string') rememberKnown(error, { metadata: true, text: message });
    };
    const loaded = event => {
      const imageId = event.detail?.imageId ?? event.detail?.image?.imageId;
      failures.delete(imageId);
      announced.delete(imageId);
      if (typeof imageId === 'string') responses.delete(imageUrl(imageId));
      refresh();
    };
    const events = core.Enums.Events;
    core.eventTarget.addEventListener(events.IMAGE_LOAD_FAILED, failed);
    if (events.IMAGE_LOAD_ERROR) core.eventTarget.addEventListener(events.IMAGE_LOAD_ERROR, failed);
    core.eventTarget.addEventListener(events.IMAGE_LOADED, loaded);
    document.addEventListener(events.STACK_NEW_IMAGE, refresh, true);
    document.addEventListener(events.VIEWPORT_NEW_IMAGE_SET, refresh, true);
    handleGlobal = unhandled;
    window.addEventListener('kin-series-metadata-failed', metadataFailed);
    // React can mount the viewport after the load has already failed. Observe that mount, without a polling timer.
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    const subscription = services.viewportGridService.subscribe(services.viewportGridService.EVENTS.GRID_STATE_CHANGED, refresh);
    stop = () => {
      active = false;
      if (window.fetch === observedFetch) window.fetch = originalFetch;
      if (workerManager?.executeTask === checkedDecode) workerManager.executeTask = executeTask;
      sof3.stop();
      core.eventTarget.removeEventListener(events.IMAGE_LOAD_FAILED, failed);
      if (events.IMAGE_LOAD_ERROR) core.eventTarget.removeEventListener(events.IMAGE_LOAD_ERROR, failed);
      core.eventTarget.removeEventListener(events.IMAGE_LOADED, loaded);
      document.removeEventListener(events.STACK_NEW_IMAGE, refresh, true);
      document.removeEventListener(events.VIEWPORT_NEW_IMAGE_SET, refresh, true);
      if (handleGlobal === unhandled) handleGlobal = null;
      window.removeEventListener('kin-series-metadata-failed', metadataFailed);
      for (const { config, previous, accept } of configurations) if (config.acceptHeader === accept) config.acceptHeader = previous;
      observer.disconnect(); subscription.unsubscribe();
      for (const notice of notices.values()) notice.remove();
      notices.clear(); failures.clear(); responses.clear(); requests.clear(); primitiveErrors.clear();
    };
  }
  return { id: 'kin.image-load-status', preRegistration({ servicesManager, extensionManager }) {
    services = servicesManager.services; extensions = extensionManager;
    // Support diagnostics: which decoder answered (routed, fallbacks, rejected) and why it is unavailable, if it is.
    window.kinSof3DecodeState = () => sof3?.state() ?? null;
    // Window-target events run listeners in registration order, even with capture. Register before React mounts
    // the route boundary, then delegate only to the active mode; installing onModeEnter would be too late.
    if (!registered) {
      window.addEventListener('unhandledrejection', globalFailure, true);
      window.addEventListener('error', globalFailure, true);
      registered = true;
    }
  },
    onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
