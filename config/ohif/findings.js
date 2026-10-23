
// Findings live inside the Measurements panel; the dock keeps its two panels unchanged.
function kinCreateViewerFindings() {
  let ready, current, epoch = 0, active = false;
  function connect(ticket = epoch) {
    ready?.then(extension => { if (active && ticket === epoch && !current && kinViewerSession.writer()) { current = extension; current.mount(); } }).catch(error => {
      if (!active || ticket !== epoch) return;
      const host = document.querySelector('#kin-viewer-history');
      if (host) { const p = document.createElement('p'); p.id = 'kin-viewer-findings-unavailable'; p.textContent = error.message; host.append(p); }
    });
  }
  // Keep the mount eligible for a successful account retry while this mode is active.
  kinViewerSession.onChange(next => { if (next === 'writer') { connect(); return; } epoch++; if (next === 'read-only') { current?.stop(); current = null; } });
  return { id: 'kin.viewer-findings', preRegistration({ servicesManager }) {
    const load = name => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = resolve;
      script.onerror = () => reject(new Error('소견 화면을 불러오지 못했습니다. 뷰어를 다시 여세요.')); document.head.append(script);
    });
    ready = load('finding-link-model.js').then(() => load('viewer-findings.js')).then(() => {
      if (typeof window.kinViewerFindings !== 'function' || !window.kinFindingLinkModel) throw new Error('소견 화면을 불러오지 못했습니다. 뷰어를 다시 여세요.');
      // The section builds its store itself: every store it creates here is given the document's session (its /me and its end).
      const model = window.kinFindingLinkModel, session = kinViewerSession.writeModule;
      const connected = Object.create(model, { createStore: { value: deps => model.createStore({ ...deps, session }) } });
      return window.kinViewerFindings(servicesManager.services, connected, session);
    });
    ready.catch(() => {});
  }, onModeEnter() {
    const ticket = ++epoch; active = true;
    // S5-U2b: findings are written and linked on writer routes; only a /me that answered writer mounts the Findings section.
    kinViewerSession.decide().then(session => { if (session === 'writer') connect(ticket); }).catch(e => {
      if (ticket !== epoch) return;
      const host = document.querySelector('#kin-viewer-history');
      if (host) { const p = document.createElement('p'); p.id = 'kin-viewer-findings-unavailable'; p.textContent = e.message; host.append(p); }
    });
  }, onModeExit() { epoch++; active = false; current?.stop(); current = null; } };
}
