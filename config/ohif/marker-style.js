
// Minhoon item 12 (MH-4): the account's measurement marker colour and line thickness in every
// viewer document, embedded or standalone, for writers and read-only readers alike. The work
// page's Appearance & Tools dialog writes the choice (worklist-v0/hpacs-lite/marker-style.js);
// this document only draws with it and follows later changes without a reload.
function kinCreateMarkerStyle() {
  let ready = null, current = null, epoch = 0, unwatch = null;
  const load = () => window.KinMarkerStyle ? Promise.resolve() : ready || (ready = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/marker-style.js';
    script.onload = () => resolve();
    // The stock marker style stays; a later mode entry tries again.
    script.onerror = () => { script.remove(); ready = null; reject(Error('Marker style loading failed')); };
    document.head.append(script);
  }));
  return { id: 'kin.marker-style',
    preRegistration() { load().catch(() => {}); },
    onModeEnter() {
      const ticket = ++epoch;
      const start = () => load().then(() => {
        const owner = kinViewerSession.owner();
        if (ticket !== epoch || current || kinViewerSession.ended() || !owner) return;
        current = window.KinMarkerStyle.mount({ tools: window.cornerstoneTools, cornerstone: window.cornerstone, owner: JSON.stringify(owner) });
      }).catch(() => {});
      // The owner is the account the document's /me answered; another extension's answer serves too.
      // A first /me that failed leaves no owner; the open viewer then follows from the later answer
      // that settles the role, instead of only after the next mode entry.
      unwatch?.(); unwatch = kinViewerSession.onChange(() => { start(); });
      (kinViewerSession.owner() ? Promise.resolve() : kinViewerSession.decide()).then(start);
    },
    // The drawn style stays for the document; the next mode entry re-reads the latest choice.
    onModeExit() { epoch++; unwatch?.(); unwatch = null; current?.dispose(); current = null; } };
}
