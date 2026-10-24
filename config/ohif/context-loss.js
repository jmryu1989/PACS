
function kinCreateContextLoss() {
  let ready, current, epoch = 0;
  return { id: 'kin.context-loss', preRegistration({ servicesManager }) {
    ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-context-loss.js';
      const timeout = setTimeout(() => reject(Error('Viewer recovery loading timeout')), 20000);
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); reject(Error('Viewer recovery loading failed')); }; document.head.append(script);
    }).then(() => {
      current = window.KinViewerContextLoss.create({ services: servicesManager.services, session: kinViewerSession });
      window.kinViewerContextLoss = current;
      window.dispatchEvent(new Event('kin-context-recovery-ready'));
    }); ready.catch(() => {});
  }, onModeEnter() {
    const ticket = ++epoch;
    ready?.then(() => { if (ticket === epoch) current.start(); }).catch(() => {
      if (ticket !== epoch) return;
      try { current?.stop(); } catch (_) {}
      const status = document.querySelector('#kin-viewer-layout-status');
      if (status) status.textContent = '영상 복구 도구를 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.';
    });
  }, onModeExit() { epoch++; current?.stop(); } };
}
