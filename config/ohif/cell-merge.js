
// Session-only cell merge/maximize. Loaded beside the existing layout controls and
// mounted into the same panel with its own id, so the Recent Layout and Hanging
// Protocol sections keep their markup and their own tests.
function kinCreateCellMerge() {
  let ready, current, epoch = 0, ended = false, listening = false, channel, restoreOneUp;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
    restoreOneUp?.(); restoreOneUp = null;
     window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  // One double click reaches both the native one-up (on the viewport element) and the cell
  // merge (on document). The native toggle reads only numRows/numCols, so on a screen the
  // merge holds - 1x2 with one cell covering it, or still settling - it switches to its own
  // 1x1 and the merge can no longer put its grid back. While the merge holds the screen the
  // gesture is the merge's alone; everywhere else (3x3, VR/SR/PDF cells, no merge module)
  // the native toggle runs unchanged. Only this one command is replaced, so the click
  // bindings and the right-click menu that share its customization are untouched.
  function guardOneUp(commandsManager) {
    restoreOneUp?.(); restoreOneUp = null;
    const native = commandsManager?.getCommand?.('toggleOneUp', 'DEFAULT');
    if (typeof native?.commandFn !== 'function') return;
    const guarded = { ...native, commandFn: options => {
      const merge = current?.state?.();
      if (merge && (merge.busy || merge.merged)) return;
      return native.commandFn(options);
    } };
    commandsManager.registerCommand('DEFAULT', 'toggleOneUp', guarded);
    restoreOneUp = () => { if (commandsManager.getCommand('toggleOneUp', 'DEFAULT') === guarded) commandsManager.registerCommand('DEFAULT', 'toggleOneUp', native); };
  }

  function watchSession() {
    if (listening) return; listening = true;
     window.addEventListener('pagehide', endSession);
    try { channel = kinViewerOnEnd(() => endSession()); } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerCellMerge) return Promise.resolve(window.KinViewerCellMerge);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-cell-merge.js';
      const timer = setTimeout(() => finish(new Error('칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerCellMerge); }
      script.onload = () => finish(window.KinViewerCellMerge ? null : new Error('칸 병합 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.cell-merge', onModeEnter({ servicesManager, commandsManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    guardOneUp(commandsManager);
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw new Error('칸 병합 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; restoreOneUp?.(); restoreOneUp = null; } };
}
