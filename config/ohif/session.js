
// Consume the opener-less handoff before loading any other script. Neither the address nor
// a later document's window.name retains the expected session; the boundary records it locally.
const KIN_VIEWER_EXPECTED_SESSION = (() => {
  const prefix = 'kin-viewer-entry:';
  if (!window.name?.startsWith(prefix)) return null;
  const raw = window.name.slice(prefix.length); window.name = '';
  try {
    const entry = JSON.parse(raw);
    window.name = typeof entry.name === 'string' ? entry.name : '';
    const expected = typeof entry.session === 'string' && entry.session ? entry.session : null;
    // A fresh list action may reuse the named window and its URL. It starts a new
    // verification; a reload has no handoff and retains the previous entry instead.
    history.replaceState({ ...history.state, kinViewerSession: {
      session: null, ended: false, unresolved: true, expected, entryStopped: !expected,
    } }, '');
    return expected;
  } catch (_) { return null; }
})();

// The first extension sets the page defaults before shared modules and data sources start work.
function kinCreateSessionBoundary() {
  return { id: 'kin.session-boundary', async preRegistration() {
    for (const name of ['work-context.js', 'session-transport.js', 'viewer-resources.js', 'viewer-preload.js', 'viewer-session.js']) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/worklist/hpacs-lite/' + name;
        script.onload = resolve;
        script.onerror = () => reject(new Error('뷰어 세션 연결을 불러오지 못했습니다.'));
        document.head.append(script);
      });
    }
    const boundary = window.KinViewerSession.connect(window, KIN_VIEWER_EXPECTED_SESSION);
    // S7-U5 A006 (added): what this viewer holds unsaved, read from the guards its modules already keep for window
    // reuse and close - marks (kinViewerHistoryHasUnsaved), finding text (kinViewerFindingsState), Job / MIP edits
    // (kinViewerJobWorkspaceState), the Tech Note dialog (kinViewerTechNoteWorkspaceState). Log Out reads it before the real end
    // and asks only when something is there. A save still out counts as unsaved in each of these (the logout preparation
    // pauses this document, so its answer cannot arrive before the real end): marks count a busy entry, findings count a
    // pending/busy entry (set only by a save), Jobs count the kept request body from its build until the save is confirmed,
    // the note counts input that differs from its last confirmed version or a save whose result is not confirmed (dirty or
    // unknown). Their `busy` is not read here: for Jobs it is also a restore or a list read, for the note a note or history
    // read, which is not unsaved work. A guard that is missing or throws says nothing: unreadable is not unsaved.
    boundary.unsaved(() => {
      const kinds = [], holds = (kind, read) => { try { if (read() === true) kinds.push(kind); } catch (_) {} };
      holds('marks', () => window.kinViewerHistoryHasUnsaved?.());
      holds('findings', () => window.kinViewerFindingsState?.().dirty);
      holds('jobs', () => window.kinViewerJobWorkspaceState?.().dirty);
      holds('note', () => { const s = window.kinViewerTechNoteWorkspaceState?.(); return s?.dirty === true || s?.unknown === true; });
      return kinds;
    });
    boundary.onEnd(() => {
      kinViewerSession.refuse('logout');
      for (const extension of window.config.extensions) {
        try { extension?.onModeExit?.(); } catch (_) {}
      }
      for (const engine of window.cornerstone?.getRenderingEngines?.() || []) { try { engine.destroy(); } catch (_) {} }
      document.title = KIN_VIEWER_DEFAULT_TITLE;
      document.body.replaceChildren();
      try { if (window.frameElement) { window.frameElement.remove(); return; } } catch (_) {}
      try { window.close(); } catch (_) {}
      if (!window.closed) window.location.replace('/worklist/hpacs-lite/index.html');
    });
    await boundary.ready;
    window.dispatchEvent(new Event('kin-viewer-session-ready'));
    await boundary.wait();
  } };
}

// A subscription follows the document gate, never a raw cross-document notice.
function kinViewerOnEnd(run) {
  let off = null, done = false;
  const end = () => { if (!done) { done = true; run(); } };
  const attach = () => {
    const gate = window.KinWorkContext;
    if (!gate) return;
    off = gate.onInvalidate(event => {
      if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) end();
    });
    if (!['active', 'preparing'].includes(gate.state())) end();
  };
  if (window.KinWorkContext) attach(); else window.addEventListener?.('kin-viewer-session-ready', attach, { once: true });
  return { close() { off?.(); window.removeEventListener?.('kin-viewer-session-ready', attach); } };
}
window.kinViewerOnEnd = kinViewerOnEnd;
