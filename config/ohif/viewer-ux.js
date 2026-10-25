// The stock mode owns the grid and Cornerstone elements. This extension owns
// only its chrome and removes it when that mode or document ends.
function kinCreateViewerUX() {
  let services, dispose, generation = 0, ready;
  const assets = ['viewer-info-bar.js', 'viewer-series-strip.js', 'viewer-patient-tabs.js', 'viewer-ux-shell.js'];
  // The theme fixes the chrome rows' heights. It is loaded once per document,
  // before the first mount, and stays: a stylesheet attached per mount and
  // dropped on mode exit left a window on re-entry (saved Job, patient tab) in
  // which the stock grid measured unstyled rows, so a camera applied then was
  // re-fitted when the rows took their height.
  function stylesheet() {
    return new Promise((resolve, reject) => {
      const href = '/worklist/hpacs-lite/viewer-ux-theme.css';
      const existing = document.head.querySelector('link[rel="stylesheet"][href="' + href + '"]');
      if (existing?.sheet) { resolve(); return; }
      const link = existing || document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => { link.remove(); reject(new Error('뷰어 화면 모듈을 불러오지 못했습니다.')); }, { once: true });
      if (!existing) document.head.append(link);
    });
  }
  function load() {
    return ready ||= assets.reduce((previous, name) => previous.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/worklist/hpacs-lite/' + name;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('뷰어 화면 모듈을 불러오지 못했습니다.')); };
      document.head.append(script);
    })), stylesheet()).catch(error => { ready = null; throw error; });
  }
  function stop() { generation++; dispose?.(); dispose = null; }
  return {
    id: 'kin.viewer-ux',
    preRegistration({ servicesManager }) { services = servicesManager.services; },
    onModeEnter() {
      stop();
      if (window.top !== window) return;
      const ticket = generation;
      load().then(() => {
        if (ticket !== generation || kinViewerSession.ended()) return;
        const shell = window.KinViewerUXShell.mount({ services });
        const channel = kinViewerOnEnd(() => { window.KinViewerPatientTabs.end(); stop(); });
        dispose = () => { channel?.close(); shell.dispose(); };
      }).catch(error => {
        if (ticket !== generation) return;
        services.uiNotificationService?.show({ title: 'Viewer', message: error.message, type: 'error' });
      });
    },
    onModeExit: stop,
  };
}
