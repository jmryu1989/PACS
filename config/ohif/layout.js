
function kinCreateViewerLayout() {
  let services, stop;
  function mount() {
    stop?.();
    const model = kinViewerLayoutModel, grid = services.viewportGridService;
    const cs = services.cornerstoneViewportService, ds = services.displaySetService;
    const search = location.search, studies = model.scope(search);
    const panel = document.createElement('details'); panel.id = 'kin-viewer-layout'; panel.open = true;
    panel.style.cssText = 'position:fixed;left:8px;bottom:30px;z-index:41;width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:8px;padding:8px;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = 'Recent Layout'; panel.append(summary);
    const note = document.createElement('p'); note.textContent = '최근 1건만 저장합니다. 영상 위치·확대·주석은 포함하지 않습니다.'; panel.append(note);
    const status = document.createElement('p'); status.id = 'kin-viewer-layout-status'; status.setAttribute('role', 'status'); panel.append(status);
    const controls = document.createElement('div'); panel.append(controls); document.body.append(panel);
    let ended = false, busy = false, key = null, channel, hpOwner = null, hp = null, hpHost = null;
    const controller = new AbortController();
    const buttons = [];
    const live = () => !ended && location.search === search;
    const refresh = () => buttons.forEach(b => { b.disabled = ended || busy || !key || !studies; });
    function end() { if (ended) return; ended = true; controller.abort(); hp?.end(); key = null; status.textContent = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'; refresh(); }
    // Session termination is owned by the page transport and gate.
    function sessionEnded(reason) { kinViewerSession.refuse(reason); end(); }
    async function get(path, signal) {
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted || signal?.aborted) abort();
      const timer = setTimeout(abort, 10000);
      try {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal, headers: { 'X-KIN-CSRF': '1' } });
        if (!live()) {
          // Session termination is owned by the page transport and gate.
          if (path === '/api/me' && response.ok) kinViewerSession.sameAccount(await response.json().catch(() => null));
          throw new Error('화면이 변경되어 배치를 적용하지 않았습니다.');
        }
        if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
        if (!response.ok) throw new Error('서버 연결을 확인한 뒤 다시 시도하세요.');
        return await response.json();
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); }
    }
    async function authenticate(signal) {
      const me = await get('/api/me', signal), next = model.owner(me);
      // Validate the owner before adopting layout data; a rejected response cannot end the session.
      if (kinViewerSession.sameAccount(me) !== true) throw new Error('계정 응답이 일치하지 않습니다.');
      kinViewerSession.note(me);
      if (!live() || !next) { end(); throw new Error('계정이 변경되어 배치를 적용하지 않았습니다.'); }
      key = next;
      hpOwner = { institution: me.institution, subject: me.sub };
    }
    // S5-U2b: 배치 저장·복원과 Hanging Protocol은 작성자 목록을 읽고 계정에 쓰므로, 문서가 clinician-only로 확인되면(이 패널의
    // /me든 다른 확장의 것이든, 이 모드 진입 전이든) 없애고 다른 확장이 적는 상태 줄만 남긴다.
    function readOnlyPanel() {
      for (const b of buttons.splice(0)) b.remove();
      hp?.end(); hp = null; hpHost?.remove(); hpHost = null;
      summary.textContent = 'Viewer Status'; note.textContent = '읽기 전용 화면입니다. 배치 저장·복원과 Hanging Protocol은 제공하지 않습니다. 화면 배치는 뷰어의 기본 레이아웃 도구로 바꿀 수 있습니다.';
    }
    async function mountProtocols() {
      const load = (name, global) => window[global] ? Promise.resolve() : new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
        const finish = error => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(); };
        const abort = () => finish(new Error('Hanging Protocol 연결이 중단되었습니다.'));
        const timer = setTimeout(abort, 10000);
        script.onload = () => finish(window[global] ? null : new Error('Hanging Protocol 모듈을 확인할 수 없습니다.'));
        script.onerror = () => finish(new Error('Hanging Protocol 화면을 불러오지 못했습니다.'));
        controller.signal.addEventListener('abort', abort, { once: true }); document.head.append(script);
      });
      await load('hanging-protocol-model.js', 'KinHangingProtocolModel');
      if (!live()) return;
      await load('viewer-hanging-protocol.js', 'KinViewerHangingProtocol');
      if (kinViewerSession.ended() || !live() || kinViewerSession.readOnly()) return;
      const host = hpHost = document.createElement('section'); panel.append(host);
      hp = window.KinViewerHangingProtocol.mount({ services, host, owner: hpOwner, live,
        access: async ({ signal }) => {
          await authenticate(signal);
          const data = await get('/api/studies', signal);
          // Current/Related follows the opening order, unlike Recent Layout's canonical scope.
          const uids = new URLSearchParams(search).get('StudyInstanceUIDs').split(',');
          const rows = uids.map(uid => data.studies?.find(row => row.uid === uid));
          if (rows.some(row => !row)) throw new Error('현재 검사 접근 권한을 확인할 수 없습니다.');
          await authenticate(signal);
          if (signal.aborted) throw new Error('Hanging Protocol 확인이 중단되었습니다.');
          return { studies: rows, displaySets: kinHangingProtocolDisplaySets(ds.getActiveDisplaySets()) };
        } });
    }
    const ordered = state => [...state.viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x);
    const signature = () => {
      const state = grid.getState();
      return JSON.stringify([state.layout, state.activeViewportId, ordered(state).map(v => [v.viewportId, v.x, v.y, v.width, v.height, v.displaySetInstanceUIDs])]);
    };
    function reference(d) {
      return { study: d.StudyInstanceUID, series: d.SeriesInstanceUID, handler: d.SOPClassHandlerId || '',
        sops: [...new Set((d.images || [d.instance || d]).map(i => i.SOPInstanceUID).filter(Boolean))].sort() };
    }
    function resolve(cell) {
      if (!cell) return null;
      const matches = ds.getActiveDisplaySets().filter(d => d.StudyInstanceUID === cell.study && d.SeriesInstanceUID === cell.series &&
        (!cell.sops || JSON.stringify(reference(d)) === JSON.stringify(cell)));
      if (matches.length !== 1) throw new Error('저장한 영상 구성을 찾을 수 없습니다. 현재 배치를 유지합니다.');
      return matches[0].displaySetInstanceUID;
    }
    function capture() {
      const state = grid.getState(), views = ordered(state), { numRows: rows, numCols: cols } = state.layout;
      const cells = views.map(v => {
        const refs = (v.displaySetInstanceUIDs || []).map(id => {
          const d = ds.getDisplaySetByUID(id);
          if (!d || !studies.includes(d.StudyInstanceUID)) throw new Error('영상 로딩이 끝난 뒤 다시 저장하세요.');
          const ref = reference(d);
          if (resolve(ref) !== id) throw new Error('표시 영상의 구성을 확인할 수 없습니다.');
          return ref;
        });
        const { viewportId, ...viewportOptions } = v.viewportOptions || {};
        return { x: v.x, y: v.y, width: v.width, height: v.height, sets: refs,
          viewportOptions, displaySetOptions: v.displaySetOptions || refs.map(() => ({})) };
      });
      const value = model.normalize({ version: 2, studies, rows, cols, active: views.findIndex(v => v.viewportId === state.activeViewportId), cells });
      if (!value) throw new Error('현재 화면의 배치를 확인할 수 없습니다.');
      return value;
    }
    async function run(action) {
      if (kinViewerSession.ended() || busy || !live() || !key || !studies || kinViewerSession.readOnly()) return;
      busy = true; refresh(); status.textContent = '계정과 검사 접근 확인 중…'; const before = signature();
      try {
        await authenticate();
        const data = await get('/api/studies');
        const rows = studies.map(uid => data.studies?.find(s => s.uid === uid));
        if (rows.some(s => !s) || (rows.length > 1 && (!rows[0].sourcePatientKey || rows.some(s => s.sourcePatientKey !== rows[0].sourcePatientKey)))) throw new Error('현재 검사의 접근 권한과 같은 환자 여부를 확인할 수 없습니다.');
        // A delayed permission response must not overwrite a newer manual layout or selection.
        if (!live() || before !== signature()) throw new Error('화면 배치가 변경되어 작업을 적용하지 않았습니다. 다시 시도하세요.');
        if (action === 'save') { model.write(localStorage, key, capture()); status.textContent = '최근 배치를 이 브라우저에 저장했습니다.'; }
        else if (action === 'remove') { localStorage.removeItem(key); status.textContent = '이 계정의 최근 배치를 삭제했습니다. 현재 화면은 유지됩니다.'; }
        else {
          const value = model.read(localStorage, key);
          if (!value) throw new Error('이 계정에서 저장한 최근 배치가 없습니다.');
          if (JSON.stringify(value.studies) !== JSON.stringify(studies)) throw new Error('다른 검사의 배치입니다. 저장한 검사를 먼저 여세요.');
          const cells = value.version === 2 ? value.cells : value.cells.map((ref, i) => ({
            x: i % value.cols / value.cols, y: Math.floor(i / value.cols) / value.rows, width: 1 / value.cols, height: 1 / value.rows,
            sets: ref ? [ref] : [], viewportOptions: { viewportType: 'stack', toolGroupId: 'default' }, displaySetOptions: [{}] }));
          const sets = cells.map(cell => cell.sets.map(resolve)), ids = cells.map(() => 'kin-layout-' + crypto.randomUUID());
          await grid.setLayout({ numRows: value.rows, numCols: value.cols, activeViewportId: ids[value.active], isHangingProtocolLayout: false,
            layoutOptions: cells.map(({ x, y, width, height }) => ({ x, y, width, height })),
            findOrCreateViewport: index => ({ displaySetInstanceUIDs: sets[index], displaySetOptions: cells[index].displaySetOptions,
              viewportOptions: { ...cells[index].viewportOptions, viewportId: ids[index], allowUnmatchedView: true } }) });
          if (live()) status.textContent = '저장한 시리즈 배치를 적용했습니다. 영상 로딩 상태를 확인하세요.';
        }
      } catch (error) {
        if (live()) status.textContent = error?.name === 'QuotaExceededError' || error?.name === 'SecurityError' ? '브라우저 저장소를 사용할 수 없습니다. 현재 화면은 유지됩니다.' : error instanceof SyntaxError ? '저장한 배치가 손상되었습니다. 현재 화면은 유지됩니다.' : error?.message || '배치 작업에 실패했습니다.';
      } finally { busy = false; refresh(); }
    }
    for (const [label, action] of [['Save Recent Layout', 'save'], ['Restore Recent Layout', 'restore'], ['Delete Recent Layout', 'remove']]) {
      const b = document.createElement('button'); b.textContent = label; b.type = 'button'; b.disabled = true;
      b.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
      b.onclick = () => run(action); controls.append(b); buttons.push(b);
    }
    const unwatch = kinViewerSession.onReadOnly(readOnlyPanel);
    if (kinViewerSession.readOnly()) readOnlyPanel();
    // F01: refused by any extension's /me (before this panel's own answer or after it enabled the account buttons) ends this panel;
    // its late writer /me then finds it ended and neither keys the buttons nor mounts the Hanging Protocol editor.
    const unwatchEnd = kinViewerSession.onChange(next => { if (next === 'refused') end(); });
    // Astra S5-U2b-X4-R-001 F02: the logout broadcast ends the document's session here too, not only this panel — a document whose
    // Measurements panel is not mounted (or has already left) must not open this panel's account controls again on a mode re-entry.

    const onMessage = () => { sessionEnded('logout'); };

    try { channel = kinViewerOnEnd(() => onMessage()); } catch (_) {}
    // A mode entry in a document whose login already ended starts ended: no /me, no account buttons, no editor.
    if (kinViewerSession.ended()) end();
    else if (studies) authenticate().then(async () => {
      if (!live()) return;
      if (kinViewerSession.readOnly()) { readOnlyPanel(); return; }
      status.textContent = '현재 검사의 배치를 직접 저장하거나 복원하세요.'; await mountProtocols();
    }).catch(error => { if (live()) status.textContent = error?.message || '계정 정보를 확인할 수 없습니다. 뷰어를 다시 여세요.'; }).finally(refresh);
    else status.textContent = '현재 검사의 식별 정보를 확인할 수 없습니다.';
    stop = () => { unwatch(); unwatchEnd(); end();  channel?.close(); panel.remove(); };
  }
  return { id: 'kin.viewer-layout', preRegistration({ servicesManager }) { services = servicesManager.services; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
