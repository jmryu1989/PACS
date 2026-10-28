
function kinDicomPdfViewportGuard(extensionManager, options) {
  options = options || {};
  const entryId = '@ohif/extension-dicom-pdf.viewportModule.dicom-pdf';
  const handlerId = '@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf';
  const pdfSop = '1.2.840.10008.5.1.4.1.1.104.1';
  const objectIds = new WeakMap(); let nextObjectId = 0, patch = null, active = false, epoch = 0;
  let cache = new WeakMap(), sessionChannel = null, listening = false; const pending = new Set(), records = new Set(), activationWaiters = new Set(), urls = new Set();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const validUid = item => typeof item === 'string' && item.length <= 64 && /^\d+(?:\.\d+)+$/.test(item);
  function sourceOf(props) {
    const values = props?.displaySets;
    if (!Array.isArray(values) || values.length !== 1) return null;
    const value = values[0], instance = value?.instance;
    if (!value || typeof value.displaySetInstanceUID !== 'string' || !value.displaySetInstanceUID ||
        value.SOPClassHandlerId !== handlerId || value.SOPClassUID !== pdfSop || !instance || instance.SOPClassUID !== pdfSop ||
        ![value.StudyInstanceUID, value.SeriesInstanceUID, value.SOPInstanceUID].every(validUid) ||
        instance.StudyInstanceUID !== value.StudyInstanceUID || instance.SeriesInstanceUID !== value.SeriesInstanceUID ||
        instance.SOPInstanceUID !== value.SOPInstanceUID || instance.MIMETypeOfEncapsulatedDocument !== 'application/pdf' ||
        instance.EncapsulatedDocument?.InlineBinary || instance.EncapsulatedDocument?.DirectRetrieveURL) return null;
    const pdfUrl = value.pdfUrl; let urlIdentity;
    if ((typeof pdfUrl === 'object' && pdfUrl !== null) || typeof pdfUrl === 'function') {
      if (!objectIds.has(pdfUrl)) objectIds.set(pdfUrl, ++nextObjectId);
      urlIdentity = ['object', objectIds.get(pdfUrl)];
    } else if (typeof pdfUrl === 'string' && pdfUrl) urlIdentity = ['value', pdfUrl];
    else return null;
    const key = JSON.stringify(['kin-pdf-source-v2', value.displaySetInstanceUID, value.StudyInstanceUID,
      value.SeriesInstanceUID, value.SOPInstanceUID, urlIdentity]);
    return { value, instance, pdfUrl, key };
  }
  function matches(source) {
    const current = sourceOf({ displaySets: [source.value] });
    return !!current && current.key === source.key && current.pdfUrl === source.pdfUrl;
  }
  async function json(result) { try { return await result.json(); } catch (_) { throw new Error('원본 PDF 확인 응답이 올바르지 않습니다.'); } }
  function requireReply(reply, message) {
    if (reply?.ok) return reply;
    const error = window.KinSessionTransport.responseError(reply,
      reply?.status === 404 ? '원본 PDF를 찾을 수 없습니다.' : message,
      '원본 PDF 접근이 거절되었습니다. 검사 접근 권한을 확인하세요.');
    throw error;
  }
  function ownerOf(value) {
    return value && value.kind === 'member' && typeof value.institution === 'string' && value.institution &&
      typeof value.sub === 'string' && value.sub ? { institution: value.institution, sub: value.sub } : null;
  }
  function sameOwner(a, b) { return !!a && !!b && a.institution === b.institution && a.sub === b.sub; }
  function assertLive(source, ticket, controller) {
    if (!active || ticket !== epoch || controller.signal.aborted || !matches(source)) throw new Error('선택한 원본 문서가 변경되었습니다.');
  }
  function waitForActivation(ticket, controller) {
    if (active && ticket === epoch) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { ticket, resolve, reject }; activationWaiters.add(waiter);
      controller.signal.addEventListener('abort', () => { activationWaiters.delete(waiter); reject(new Error('원본 PDF 준비가 중단되었습니다.')); }, { once: true });
    });
  }
  async function resolveAttempt(source, ticket, controller) {
      const raw = await source.pdfUrl; assertLive(source, ticket, controller);
      if (typeof raw !== 'string') throw new Error('원본 PDF 경로를 확인할 수 없습니다.');
      const root = globalThis.location, parsed = new URL(raw, root.href);
      const rendered = '/dicom-web/studies/' + source.value.StudyInstanceUID + '/series/' + source.value.SeriesInstanceUID + '/instances/' + source.value.SOPInstanceUID + '/rendered';
      if (parsed.origin !== root.origin || parsed.pathname !== rendered || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('원본 PDF 경로를 확인할 수 없습니다.');
      const init = (method = 'GET', body) => ({ method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const firstReply = requireReply(await fetch('/api/me', init()), '로그인 세션을 확인할 수 없습니다.'); assertLive(source, ticket, controller);
      const first = ownerOf(await json(firstReply)); assertLive(source, ticket, controller);
      if (!first) throw new Error('로그인 세션을 확인할 수 없습니다.');
      const lookupReply = requireReply(await fetch('/api/dicom/lookup', init('POST', { studyUid: source.value.StudyInstanceUID, sopUid: source.value.SOPInstanceUID })), '원본 PDF 식별을 확인할 수 없습니다.'); assertLive(source, ticket, controller);
      const lookup = await json(lookupReply); assertLive(source, ticket, controller);
      if (!lookup || Object.keys(lookup).length !== 1 || typeof lookup.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(lookup.id)) throw new Error('원본 PDF 식별을 확인할 수 없습니다.');
      const lastReply = requireReply(await fetch('/api/me', init()), '로그인 세션을 확인할 수 없습니다.'); assertLive(source, ticket, controller);
      const last = ownerOf(await json(lastReply)); assertLive(source, ticket, controller);
      if (!sameOwner(first, last)) throw new Error('계정이 변경되어 원본 PDF를 표시하지 않았습니다.');
      const url = await window.KinViewerResource.read(root.origin + '/instances/' + lookup.id + '/pdf', { signal: controller.signal, type: 'application/pdf' });
      try { assertLive(source, ticket, controller); } catch (error) { window.KinViewerResource.release(url); throw error; }
      urls.add(url); return url;
  }
  async function resolve(source, ticket, controller) {
    await waitForActivation(ticket, controller); assertLive(source, ticket, controller);
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('원본 PDF 확인 시간이 지났습니다. 다시 시도하세요.'); error.retryable = true; reject(error); controller.abort(); }, timeoutMs); });
    try { return await Promise.race([resolveAttempt(source, ticket, controller), deadline]); }
    catch (error) { if (error?.name === 'TypeError') error.retryable = true; throw error; }
    finally { clearTimeout(timer); pending.delete(controller); }
  }
  function start(record) {
    const controller = new AbortController(); record.controller = controller; record.failed = false; pending.add(controller);
    resolve(record.source, record.ticket, controller).then(value => { if (!record.settled) { record.url = value; record.settled = true; records.delete(record); record.resolve(value); options.onSuccess?.(record.source.value, record.original); } else window.KinViewerResource.release(value); }, error => {
      if (!record.settled && active && record.ticket === epoch && matches(record.source)) {
        record.failed = !!error?.retryable; options.onFailure?.(error, record.source.value, record.original);
      }
      if (!record.settled && !record.failed) { record.settled = true; records.delete(record); record.reject(error); }
    });
  }
  function resolvedSource(source) {
    let record = cache.get(source.value);
    if (record?.key === source.key && record.original === source.pdfUrl && (!record.url || window.KinViewerResource.has(record.url))) return record;
    if (record?.url) { window.KinViewerResource.release(record.url); urls.delete(record.url); }
    if (record && !record.settled) { record.controller?.abort(); record.settled = true; records.delete(record); record.reject(new Error('선택한 원본 문서가 변경되었습니다.')); }
    let fulfill, reject; const promise = new Promise((resolve, fail) => { fulfill = resolve; reject = fail; }); promise.catch(() => {});
    record = { key: source.key, original: source.pdfUrl, source, ticket: epoch, promise, resolve: fulfill, reject, failed: false, settled: false, controller: null };
    cache.set(source.value, record); records.add(record); start(record); return record;
  }
  function install() {
    if (patch && patch.entry.component === patch.wrapper) return true;
    const entry = extensionManager?.getModuleEntry?.(entryId);
    if (!entry || typeof entry.component !== 'function') return false;
    const original = entry.component;
    const wrapper = function(props) {
      const source = sourceOf(props); if (!source) return null;
      const record = resolvedSource(source), key = JSON.stringify([source.key, 'lifecycle', epoch]);
      const element = original.call(this, { ...props, displaySets: [{ ...source.value, pdfUrl: record.promise }], key });
      return element && element.key === key ? element : null;
    };
    entry.component = wrapper;
    if (entry.component !== wrapper) return false;
    patch = { entry, original, wrapper }; return true;
  }
  function ownsWrapper() { return !!patch && patch.entry.component === patch.wrapper; }
  function sessionEnded() { deactivate(); options.onSessionEnd?.(); }

  function listen() { if (listening) return; listening = true;  try { sessionChannel = kinViewerOnEnd(() => sessionEnded()); } catch (_) {} }
  function unlisten() { if (!listening) return; listening = false;  sessionChannel?.close(); sessionChannel = null; }
  function activate() { active = true; listen(); for (const waiter of [...activationWaiters]) { if (waiter.ticket === epoch) waiter.resolve(); else waiter.reject(new Error('원본 PDF 준비가 중단되었습니다.')); activationWaiters.delete(waiter); } }
  function retry(value, pdfUrl) { for (const record of records) if (record.failed && !record.settled && record.ticket === epoch && matches(record.source) && (!value || record.source.value === value && record.original === pdfUrl)) start(record); }
  function deactivate() {
    active = false; epoch++; unlisten(); cache = new WeakMap(); for (const item of pending) item.abort(); pending.clear();
    for (const url of urls) window.KinViewerResource.release(url); urls.clear();
    for (const waiter of activationWaiters) waiter.reject(new Error('원본 PDF 준비가 중단되었습니다.')); activationWaiters.clear();
    for (const record of records) if (!record.settled) { record.settled = true; record.reject(new Error('원본 PDF 준비가 중단되었습니다.')); } records.clear();
  }
  function dispose() { deactivate(); if (patch && patch.entry.component === patch.wrapper) patch.entry.component = patch.original; patch = null; }
  return { install, ownsWrapper, activate, deactivate, retry, dispose };
}

function kinCreateDicomPdf() {
  let services, ready, current, viewportGuard, nativeErrors = new WeakMap(), epoch = 0;
  function retire() { epoch++; nativeErrors = new WeakMap(); current?.stop(); current = null; }
  function prepare() {
    if (window.KinDicomPdf) return Promise.resolve(window.KinDicomPdf);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-dicom-pdf.js';
      const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(window.KinDicomPdf); };
      const timer = setTimeout(() => finish(new Error('원본 PDF 도구 연결 시간이 지났습니다. 다시 시도하세요.')), 10000);
      script.onload = () => finish(window.KinDicomPdf?.create ? null : new Error('원본 PDF 도구를 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('원본 PDF 도구를 불러오지 못했습니다. 다시 시도하세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  const extension = { id: 'kin.source-pdf', preRegistration({ servicesManager, extensionManager }) {
    services = servicesManager.services;
    if (extensionManager) { viewportGuard = kinDicomPdfViewportGuard(extensionManager, { onSessionEnd: retire,
      onFailure: (error, value, pdfUrl) => { nativeErrors.set(value, { pdfUrl, error }); current?.nativeFailure?.(error, value, pdfUrl); },
      onSuccess: (value, pdfUrl) => { if (nativeErrors.has(value)) nativeErrors.delete(value); current?.nativeReady?.(value, pdfUrl); }
    }); if (!viewportGuard.install()) throw new Error('원본 PDF 화면을 안전하게 연결하지 못했습니다. 뷰어를 다시 여세요.'); }
  },
    onModeEnter() {
      kinToolRetry('kin-pdf-retry');
      if (viewportGuard && !viewportGuard.ownsWrapper() && !viewportGuard.install()) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = '원본 PDF 화면을 안전하게 연결하지 못했습니다. 뷰어를 다시 여세요.'; return; }
      viewportGuard?.activate();
      const ticket = ++epoch; current?.stop(); current = null;
      prepare().then(module => { if (ticket === epoch) { current = module.create(services, {
        nativeFailureFor: (value, pdfUrl) => { const saved = nativeErrors.get(value); return saved?.pdfUrl === pdfUrl ? saved.error : null; },
        onRetry: (value, pdfUrl) => viewportGuard?.retry(value, pdfUrl)
      }); current.mount(); } }).catch(error => {
        if (ticket === epoch) kinToolRetry('kin-pdf-retry', error.message, () => extension.onModeEnter());
      });
    },
    onModeExit() { kinToolRetry('kin-pdf-retry'); viewportGuard?.deactivate(); retire(); },
  };
  return extension;
}
