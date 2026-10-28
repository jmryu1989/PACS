
function kinCreateFrameCoverage() {
  let ready, current, services, epoch = 0;
  function prepare() {
    if (!ready) ready = (window.KinFrameCoverage ? Promise.resolve() : new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-frame-coverage.js';
      const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(Error('Frame Coverage 연결 시간이 지났습니다.')), 20000);
      script.onload = () => finish(window.KinFrameCoverage?.mount ? null : Error('Frame Coverage 도구를 확인할 수 없습니다.'));
      script.onerror = () => finish(Error('Frame Coverage를 불러오지 못했습니다.')); document.head.append(script);
    })).catch(error => { ready = null; throw error; });
    return ready;
  }
  const extension = { id: 'kin.frame-coverage', preRegistration({ servicesManager }) { services = servicesManager.services; },
    onModeEnter() {
      const ticket = ++epoch; kinToolRetry('kin-coverage-retry'); current?.stop(); current = null;
      window.kinViewerFrameCoverageState = () => ({ warn: true, phase: 'unverified' });
      window.kinViewerFrameCoverageConfirm = ask => (ask || window.confirm)('원본 프레임 표시 확인을 연결하지 못했습니다. 이 영상을 떠날까요?');
      prepare().then(() => { if (ticket === epoch) current = window.KinFrameCoverage.mount(services); })
        .catch(error => { if (ticket === epoch) kinToolRetry('kin-coverage-retry', error.message, () => extension.onModeEnter()); });
    }, onModeExit() { epoch++; kinToolRetry('kin-coverage-retry'); current?.stop(); current = null; } };
  return extension;
}
