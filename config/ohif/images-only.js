
function kinCreateImagesOnly() {
  let ready, current, epoch = 0, ended = false, listening = false, channel;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
     window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }

  function watchSession() {
    if (listening) return; listening = true;
     window.addEventListener('pagehide', endSession);
    try { channel = kinViewerOnEnd(() => endSession()); } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerImagesOnly) return Promise.resolve(window.KinViewerImagesOnly);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-images-only.js';
      const timer = setTimeout(() => finish(new Error('Images Only 도구를 불러오지 못했습니다. 다시 시도하세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerImagesOnly); }
      script.onload = () => finish(window.KinViewerImagesOnly ? null : new Error('Images Only 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('Images Only 도구를 불러오지 못했습니다. 다시 시도하세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  const extension = { id: 'kin.images-only', onModeEnter({ servicesManager }) {
    if (ended) return; watchSession(); kinToolRetry('kin-images-retry');
    const ticket = ++epoch; current?.stop(); current = null;
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw new Error('Images Only 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { kinToolRetry('kin-images-retry', error.message, () => extension.onModeEnter({ servicesManager })); } });
  }, onModeExit() { kinToolRetry('kin-images-retry'); epoch++; current?.stop(); current = null; } };
  return extension;
}
