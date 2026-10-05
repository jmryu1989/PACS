/* REQ-S8-CTX -> RISK-CTX-BLANK/WORK/SESSION -> CTX-DOM/CONSUMER/SERVER.
 * A lost context is a renderer fact. Neither a browser event nor a slow frame proves it.
 */
(function (root) {
  'use strict';
  const REPEAT = '영상 표시 장애가 반복되고 있습니다. 3D 기능 사용을 중단하고 지원 담당자에게 문의해 주세요. 다시 불러와도 재발할 수 있습니다.';
  const NOTICE = '영상 표시가 중단되어 영향을 받은 화면을 가렸습니다. Reload Viewer를 누르면 이 뷰어만 다시 불러옵니다.\n검사·비교·진입 시리즈와 저장된 표식·소견·Job을 다시 조회합니다. 판독문 입력과 받아쓰기는 유지됩니다.\n현재 배치, Window / Level, 확대·이동, MPR/MIP/VR 보기와 임시 미리보기, Frame Coverage 표시 기록은 초기화됩니다. 미저장 작업과 저장 결과를 확인하지 못한 항목을 먼저 확인하세요.';
  function context(engine) {
    return engine?.offscreenMultiRenderWindow?.getOpenGLRenderWindow?.()?.getContext?.() || null;
  }
  function lost(engine) {
    try { return context(engine)?.isContextLost() === true; } catch (_) { return false; }
  }
  function create({ services, session }) {
    const boundary = root.KinViewerSessionBoundary, gate = root.KinWorkContext;
    const records = new Map(), borrowers = new Set(), subscribers = new Set(), covers = new Map(), rendered = new Map();
    const recovery = boundary.recovery;
    let active = false, timer = null, fault = null, attempt = 0, checking = false, account = recovery?.account || null;
    let repeat = 1, auditState = 'unknown', resultSent = false, resultTimer = null, pendingReload = null;
    const previous = root.history.state?.kinViewerContext;
    let viewId = recovery?.viewId || root.crypto.randomUUID();
    const entry = root.crypto.randomUUID();
    const now = () => Date.now();
    const accountOf = me => me?.kind === 'member' && typeof me.sub === 'string' && typeof me.institution === 'string'
      ? JSON.stringify([me.institution, me.sub]) : null;
    const gridViews = () => {
      const state = services.viewportGridService.getState(), rows = state?.viewports;
      return [...(rows instanceof Map ? rows.keys() : Object.keys(rows || {}))]
        .map(id => services.cornerstoneViewportService.getCornerstoneViewport(id)).filter(Boolean);
    };
    function consumers() {
      const views = gridViews();
      // These are product borrowers of a grid engine, never arbitrary print/thumbnail canvases.
      for (const element of root.document.querySelectorAll('[data-kin-vr-render],[data-kin-mip-render]')) {
        const view = root.cornerstone?.getEnabledElement?.(element)?.viewport;
        if (view && element.isConnected && element.closest('dialog')?.open) views.push(view);
      }
      const result = views.map(view => ({ engine: view.getRenderingEngine(), element: view.element, type: view.type || 'unknown' }));
      for (const borrower of borrowers) if (borrower.current()) result.push(borrower);
      return result.filter(row => row.engine);
    }
    const kind = value => ['stack', 'orthographic', 'volume3d'].includes(String(value).toLowerCase()) ? String(value).toLowerCase() : 'unknown';
    function notify(record) {
      for (const sub of [...subscribers]) {
        if (sub.seen.has(record.engine)) continue;
        sub.seen.add(record.engine);
        try { sub.release(Object.freeze({ engine: record.engine, faultId: fault.id })); } catch (_) { /* Other borrowers still stop. */ }
      }
    }
    async function audit(stage, reason = 'none', result = 'unknown', source = fault) {
      if (!source || !account || !boundary.active() || session.ended()) return;
      const at = gate.capture('document'), uid = new URLSearchParams(root.location.search).get('StudyInstanceUIDs')?.split(',')[0];
      if (!uid) return;
      const event = { eventId: root.crypto.randomUUID(), faultId: source.id, stage, occurredAt: new Date(stage === 'manual-retry' ? source.at : now()).toISOString(),
        engine: 'webgl', viewport: source.kind, cause: 'context-lost', repeatCount: source.repeatCount || repeat, attempt: source.attempt || attempt, reason, result };
      if ((await boundary.recoveryAdmission()).status !== 'allowed' || !gate.admits(at)) return;
      boundary.transport.request('/api/studies/' + encodeURIComponent(uid) + '/viewer-context-events',
        { context: at, method: 'POST', json: event, deadlineMs: 10000 }).then(answer => {
          gate.commit(at, () => { auditState = answer.ok ? 'recorded' : 'unknown'; });
        }, () => { gate.commit(at, () => { auditState = 'unknown'; }); });
    }
    function countFault() {
      if (!account) return;
      const key = 'kin-viewer-faults:' + viewId;
      try {
        const old = JSON.parse(root.sessionStorage.getItem(key) || 'null');
        const times = old?.account === account && old.session === boundary.session() && Array.isArray(old.times)
          ? old.times.filter(t => Number.isFinite(t) && t <= now() && now() - t < 300000) : [];
        times.push(now()); repeat = times.length;
        root.sessionStorage.setItem(key, JSON.stringify({ account, session: boundary.session(), times }));
      } catch (_) { repeat = recovery?.account === account && now() - recovery.at < 300000 ? recovery.repeatCount + 1 : 1; }
    }
    function message(text) { for (const cover of covers.values()) cover.status.textContent = text; }
    function coverArea(element) {
      if (!element?.isConnected || covers.has(element)) return;
      const box = root.document.createElement('section'); box.setAttribute('aria-label', 'Viewer Recovery');
      box.style.cssText = 'position:absolute;inset:0;z-index:100;background:#13202b;color:white;overflow:auto;padding:12px;box-sizing:border-box;font:14px/1.5 system-ui';
      const heading = root.document.createElement('h2'); heading.textContent = 'Viewer Recovery';
      const text = root.document.createElement('p'); text.textContent = NOTICE; text.style.whiteSpace = 'pre-line';
      const repeated = root.document.createElement('p'); repeated.textContent = repeat > 1 ? REPEAT : '';
      const status = root.document.createElement('p'); status.setAttribute('role', 'status');
      const button = (label, run) => { const b = root.document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = run; box.append(b); return b; };
      box.append(heading, text, repeated, status);
      button('Reload Viewer', () => retry(false));
      const review = button('Review Unsaved Work', () => message('입력한 표식·소견·Job·Tech Note와 저장 상태를 확인하세요. 영상 영역 밖의 저장 컨트롤은 계속 사용할 수 있습니다.'));
      const discard = button('Discard Viewer Changes & Reload', () => retry(true)); discard.hidden = true; review.hidden = true;
      // The cover belongs to the renderer's image element, never its panel or the parent document.
      const position = element.style.position;
      if (root.getComputedStyle(element).position === 'static') element.style.position = 'relative';
      element.append(box); covers.set(element, { box, status, discard, review, repeated, position });
    }
    function confirmLoss(record, rows) {
      if (record.lost || !lost(record.engine) || !rows.some(row => row.engine === record.engine)) return;
      record.lost = true;
      if (!fault) {
        finishRecovery('failed');
        fault = { id: root.crypto.randomUUID(), kind: kind(rows.find(row => row.engine === record.engine)?.type) }; countFault(); audit('loss');
      }
      // Synchronous release precedes any consumer's later readback or commit.
      notify(record);
      for (const row of rows) if (row.engine === record.engine) coverArea(row.element);
    }
    function watch(engine) {
      let record = records.get(engine);
      if (record?.restore.length) return record;
      if (!record) { record = { engine, lost: false, restore: [] }; records.set(engine, record); }
      const canvas = context(engine)?.canvas;
      const detect = event => {
        if (!active) return false;
        const broken = record.lost || lost(engine);
        if (!broken) return false;
        try { confirmLoss(record, consumers()); } catch (_) { /* The scan retries discovery; a lost engine must not draw. */ }
        if (record.lost) event?.preventDefault();
        return true;
      };
      if (canvas) {
        canvas.addEventListener('webglcontextlost', detect);
        record.restore.push(() => canvas.removeEventListener('webglcontextlost', detect));
      }
      // A VR borrower without its optional callback is still stopped at the shared engine.
      for (const name of ['render', 'renderViewport', 'renderViewports', 'renderFrameOfReference', '_renderFlaggedViewports', 'resize']) {
        const original = engine[name]; if (typeof original !== 'function') continue;
        const guarded = function (...args) {
          if (detect()) return;
          return original.apply(this, args);
        };
        engine[name] = guarded;
        record.restore.push(() => { if (engine[name] === guarded) engine[name] = original; });
      }
      return record;
    }
    function scan() {
      if (!active) return;
      let rows; try { rows = consumers(); } catch (_) { return; }
      const used = new Set(rows.map(row => row.engine));
      for (const engine of used) confirmLoss(watch(engine), rows);
      for (const row of rows) if (records.get(row.engine)?.lost) coverArea(row.element);
      for (const [element, cover] of covers) if (!rows.some(row => row.element === element && records.get(row.engine)?.lost)) {
        cover.box.remove(); element.style.position = cover.position; covers.delete(element);
      }
      if (recovery && !resultSent && rows.length && rows.every(row => !lost(row.engine))) {
        // A new engine alone is not an image recovery receipt; wait for its rendered event.
        for (const row of rows) if (row.element && !rendered.has(row.element)) {
          const event = root.cornerstone.Enums.Events.IMAGE_RENDERED;
          row.element.addEventListener(event, recovered);
          rendered.set(row.element, () => row.element.removeEventListener(event, recovered));
        }
      }
      for (const [element, remove] of rendered) if (resultSent || !rows.some(row => row.element === element)) {
        remove(); rendered.delete(element);
      }
    }
    function recovered() {
      if (resultSent || fault || !account || account !== recovery?.account || !boundary.active()) return;
      const rows = consumers(); if (!rows.length || rows.some(row => lost(row.engine))) return;
      finishRecovery('succeeded');
    }
    function finishRecovery(result) {
      if (!recovery || resultSent) return;
      resultSent = true; root.clearTimeout(resultTimer);
      audit('recovery-result', 'none', result, { ...recovery, id: recovery.faultId, kind: 'unknown' });
    }
    function workState() {
      if (!['writer', 'read-only'].includes(session.state())) return { reason: 'guard-unavailable' };
      const readers = ['kinViewerHistoryWorkspaceState'];
      if (session.writer()) readers.push('kinViewerJobWorkspaceState', 'kinViewerTechNoteWorkspaceState');
      let dirty = false;
      try {
        for (const name of readers) {
          if (typeof root[name] !== 'function') return { reason: 'guard-unavailable' };
          const value = root[name]();
          if (!value || typeof value.dirty !== 'boolean' || typeof value.busy !== 'boolean') return { reason: 'guard-unavailable' };
          if (value.busy || value.unknown) return { reason: value.busy ? 'busy' : 'save-unknown' };
          dirty ||= value.dirty;
        }
        if (session.writer()) {
          if (!root.kinViewerJobCommand || typeof root.kinViewerJobCommand.pending !== 'function') return { reason: 'guard-unavailable' };
          if (root.kinViewerJobCommand.pending()) return { reason: 'save-unknown' };
          const mip = root.kinVolumeMipJob?.recoveryState?.();
          if (mip?.busy || mip?.unknown) return { reason: mip.busy ? 'busy' : 'save-unknown' };
          dirty ||= !!mip?.dirty;
        }
      } catch (_) { return { reason: 'guard-unavailable' }; }
      return { dirty };
    }
    function refuse(reason) {
      const messages = { preparing: '로그아웃 준비 중입니다. 편집으로 돌아온 뒤 다시 시도하세요.', 'session-ended': '이 뷰어의 세션이 종료되어 다시 불러올 수 없습니다.',
        unknown: '지금 복구 허가를 확인할 수 없습니다. 같은 버튼으로 다시 시도하세요.', busy: '진행 중인 작업이 끝난 뒤 다시 시도하세요.',
        'save-unknown': '저장 결과를 확인하지 못한 항목이 있습니다. 저장 결과를 먼저 확인하세요.',
        'guard-unavailable': '미저장 작업의 상태를 확인할 수 없습니다. 작성 도구의 연결을 확인한 뒤 다시 시도하세요.',
        dirty: '미저장 영상 작업이 있습니다. 저장하거나 명시적으로 폐기한 뒤 다시 불러오세요.', account: '원래 계정과 로그인 세션을 확인하지 못했습니다.',
        request: '로그인 확인 요청이 완료되지 않았습니다. 연결을 확인한 뒤 다시 시도하세요.', coverage: '다시 불러오기를 취소했습니다.', marker: '복구 정보를 보존하지 못했습니다. 브라우저 저장소를 확인한 뒤 다시 시도하세요.' };
      message(messages[reason] || messages.unknown); audit('refused', reason);
    }
    async function retry(discard) {
      if (!fault || checking) return;
      checking = true; attempt++;
      const at = gate.capture('document');
      try {
        let admission = await boundary.recoveryAdmission();
        if (admission.status !== 'allowed') return refuse(admission.reason || 'unknown');
        if (!gate.admits(at) || at.session !== boundary.session()) return refuse('preparing');
        let work = workState();
        for (const cover of covers.values()) { cover.discard.hidden = !work.dirty || !!work.reason; cover.review.hidden = !work.dirty && !work.reason; }
        if (work.reason) return refuse(work.reason);
        if (work.dirty && !discard) return refuse('dirty');
        if (work.dirty && !root.confirm('저장하지 않은 영상 작업을 버리고 이 뷰어를 다시 불러올까요? 판독문 입력은 유지됩니다.')) return refuse('dirty');
        const start = now();
        const answer = await boundary.transport.request('/api/me', { context: at, deadlineMs: 10000, cache: 'no-store' });
        if (!answer.ok) return refuse('request');
        const me = answer.body;
        if (now() - start >= 10000) return refuse('request');
        if (session.sameAccount(me) !== true || me.sessionId !== boundary.session() || !accountOf(me) || account && accountOf(me) !== account) return refuse('account');
        if (!gate.commit(at, () => bindAccount(me, at))) return refuse('preparing');
        admission = await boundary.recoveryAdmission();
        if (admission.status !== 'allowed') return refuse(admission.reason || 'unknown');
        work = workState(); if (work.reason || work.dirty && !discard) return refuse(work.reason || 'dirty');
        if (typeof root.kinViewerFrameCoverageConfirm !== 'function') return refuse('guard-unavailable');
        if (!root.kinViewerFrameCoverageConfirm(root.confirm.bind(root))) return refuse('coverage');
        // No asynchronous work after the epoch-bound Coverage permit. commit rejects preparation
        // or an account/session race without mutating input or suppressing beforeunload guards.
        if (!gate.commit(at, () => {
          const admitted = boundary.recoveryAdmission(true);
          if (admitted.status !== 'allowed') { refuse(admitted.reason || 'unknown'); return; }
          const final = workState(); if (final.reason || final.dirty && !discard) { refuse(final.reason || 'dirty'); return; }
          const marker = { entry, session: at.session, account, href: root.location.href, viewId, faultId: fault.id, repeatCount: repeat, attempt, at: now() };
          pendingReload?.();
          const persist = () => {
            root.sessionStorage.setItem('kin-viewer-recovery', JSON.stringify(marker));
            root.history.replaceState({ ...root.history.state, kinViewerRecovery: marker }, '');
            if (root.sessionStorage.getItem('kin-viewer-recovery') !== JSON.stringify(marker)) throw Error();
          };
          const clear = () => {
            if (root.sessionStorage.getItem('kin-viewer-recovery') === JSON.stringify(marker)) root.sessionStorage.removeItem('kin-viewer-recovery');
            const state = root.history.state;
            if (state?.kinViewerRecovery?.entry === entry && state.kinViewerRecovery.attempt === marker.attempt) {
              const { kinViewerRecovery, ...rest } = state; root.history.replaceState(rest, '');
            }
          };
          try { persist(); clear(); } catch (_) { try { clear(); } catch (_) {} refuse('marker'); return; }
          // Only pagehide proves that this reload left the document. A cancelled
          // prompt writes no marker; the next beforeunload retires this attempt
          // before an ordinary F5/back/link navigation can reach pagehide.
          let unloadingSeen = false;
          const retire = () => {
            root.removeEventListener('beforeunload', unloading);
            root.removeEventListener('pagehide', leaving);
            if (pendingReload === retire) pendingReload = null;
          };
          const unloading = () => { if (unloadingSeen) retire(); else unloadingSeen = true; };
          const leaving = () => {
            retire();
            try { root.sessionStorage.setItem('kin-viewer-recovery-departure', JSON.stringify(marker)); }
            catch (_) { /* Without an actual departure receipt the next document starts normally. */ }
          };
          pendingReload = retire;
          root.addEventListener('beforeunload', unloading);
          root.addEventListener('pagehide', leaving);
          try { root.location.reload(); } catch (error) { retire(); throw error; }
        })) refuse('preparing');
      } catch (_) { refuse('request'); }
      finally { checking = false; }
    }
    function bindAccount(me, at) {
      const who = accountOf(me);
      if (!recovery && previous?.account === who && previous.session === boundary.session()) viewId = previous.viewId;
      const first = !account; account = who;
      try { root.history.replaceState({ ...root.history.state, kinViewerContext: { viewId, entry, session: at.session, account } }, ''); } catch (_) {}
      if (first && fault) { countFault(); audit('loss'); for (const cover of covers.values()) cover.repeated.textContent = repeat > 1 ? REPEAT : ''; }
    }
    async function identify() {
      const at = gate.capture('document');
      try {
        const answer = await boundary.transport.request('/api/me', { context: at, deadlineMs: 10000 });
        if (!answer.ok) return;
        const me = answer.body;
        gate.commit(at, () => {
          if (session.sameAccount(me) !== true || me.sessionId !== boundary.session()) return;
          const who = accountOf(me); if (!who || account && who !== account) return;
          bindAccount(me, at);
          if (recovery) audit('manual-retry', 'none', 'unknown', { ...recovery, id: recovery.faultId, kind: 'unknown' });
        });
      } catch (_) { /* Retry performs its own bounded account confirmation. */ }
    }
    const api = Object.freeze({
      start() { if (active) return; active = true; scan(); identify(); timer = root.setInterval(scan, 200);
        // No rendered receipt within this observation window is one unknown
        // result, never an early unknown followed by a contradictory success.
        if (recovery && !resultSent) resultTimer = root.setTimeout(() => finishRecovery('unknown'), 30000);
      },
      stop() { finishRecovery('unknown'); root.clearTimeout(resultTimer); active = false; root.clearInterval(timer); for (const r of records.values()) for (const restore of r.restore.splice(0)) restore();
        for (const remove of rendered.values()) remove(); rendered.clear();
        for (const [element, cover] of covers) { cover.box.remove(); element.style.position = cover.position; } covers.clear(); },
      onContextLoss(release) {
        const sub = { release, seen: new Set() }; subscribers.add(sub);
        for (const record of records.values()) if (record.lost) notify(record);
        return () => subscribers.delete(sub);
      },
      borrow(engine, element, current = () => true) {
        const row = { engine, element, current, type: 'orthographic' }; borrowers.add(row); scan();
        return () => borrowers.delete(row);
      },
      usable(engine) {
        if (!engine) return true;
        const record = watch(engine); if (active) confirmLoss(record, consumers());
        return !record.lost && !lost(engine);
      },
      auditState: () => auditState,
    });
    boundary.onEnd(() => api.stop());
    return api;
  }
  root.KinViewerContextLoss = Object.freeze({ create, lost });
})(window);
