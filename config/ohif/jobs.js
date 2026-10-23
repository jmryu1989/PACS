
function kinCreateViewerJobs() {
  let ready, current, epoch = 0, active = false;
  function connect(ticket = epoch) {
    ready?.then(extension => { if (active && ticket === epoch && !current && kinViewerSession.writer()) { current = extension; current.mount(); } }).catch(error => { if (active && ticket === epoch) { const p = document.querySelector('#kin-viewer-layout-status'); if (p) p.textContent = error.message; } });
  }
  // A later successful role check may resolve an initially unconfirmed mount.
  // Clinician-only transitions remove authoring; the page boundary disposes every module at an end.
  kinViewerSession.onChange(next => { if (next === 'writer') { connect(); return; } epoch++; if (next === 'read-only') { current?.stop(); current = null; } });
  return { id: 'kin.viewer-jobs', preRegistration({ servicesManager, extensionManager }) {
    const load = name => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = resolve;
      script.onerror = () => reject(new Error('비교 작업 화면을 불러오지 못했습니다.')); document.head.append(script);
    });
    ready = load('viewer-volume-job.js').catch(() => {}).then(() => load('viewer-stack-restore.js')).then(() => load('viewer-jobs.js'))
      .then(() => window.kinViewerJobs(servicesManager.services, kinViewerLayoutModel, kinViewerSession.writeModule,
        () => extensionManager.getActiveDataSource()[0]));
    ready.catch(() => {});
  }, onModeEnter() {
    const ticket = ++epoch; active = true;
    // S5-U2b: saved jobs are written and read on writer routes; only a /me that answered writer mounts the Job panel.
    kinViewerSession.decide().then(session => { if (session === 'writer') connect(ticket); }).catch(e => {
      if (ticket === epoch) { const p = document.querySelector('#kin-viewer-layout-status'); if (p) p.textContent = e.message; }
    });
  }, onModeExit() { epoch++; active = false; current?.stop(); current = null; } };
}
