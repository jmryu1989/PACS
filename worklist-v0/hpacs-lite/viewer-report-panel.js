/* The viewer window's Report Editor tab: a read-only mirror of the current patient tab's report.
 * Writing, saving, approving and holding stay with the reading screen. The panel reads the study's
 * own row (GET /api/studies?uids=, the existing access and audit path) and, while it is open, the
 * reading screen's text being typed (viewer-editor-link.js). It keeps what it read in memory only.
 * "Open in Reading Screen" asks the list that linked this window to select the study (through its own
 * study-move gate) and put the caret in Findings; only that list document's answer is read. */
(function (root) {
  'use strict';
  const FIELDS = ['findings', 'conclusion', 'recommendation'];
  const WORDS = { W: 'Unread', T: 'In Progress', P: 'Preliminary', H: 'On Hold', A: 'Approved' };
  const SOURCES = {
    live: 'Live — 판독 화면에서 쓰는 중인 글',
    none: 'No Report — 이 검사에는 아직 판독문이 없습니다',
    hidden: 'Hidden — 다른 판독의의 예비 판독(RS: P)입니다',
  };
  const TEXT = {
    loading: '판독문을 불러오는 중입니다.',
    failed: '판독문을 불러오지 못했습니다. Refresh를 누르세요.',
    asking: '판독 화면에 요청하는 중입니다.',
    missing: '연결된 판독 화면이 없습니다. 목록 창에서 이 검사를 고르면 판독문을 쓸 수 있습니다.',
    timeout: '판독 화면의 응답이 없습니다. 옮겨졌는지 판독 화면에서 확인하세요.',
  };
  // Why the reading screen did not move (viewer-windows.js editorOpen reasons).
  const OPEN_REASONS = {
    session: '로그인이 다름', unlisted: '목록에 없는 검사', modal: '대화상자가 열려 있음', busy: '이전 요청 처리 중',
    composing: '글자 조합 중', saving: '쓰던 글 저장 대기·거절', stale: '다른 검사가 선택됨',
    unresolved: '환자 식별 불일치', gone: '목록에서 빠진 검사', unavailable: '판독문 입력란을 쓸 수 없음',
  };
  const EMPTY = Object.freeze({ findings: '', conclusion: '', recommendation: '' });
  const pick = body => Object.fromEntries(FIELDS.map(key => [key, typeof body?.[key] === 'string' ? body[key] : '']));
  // The row the server answered for exactly this study and this patient tab, or null: a missing UID or a
  // patient key other than the tab's shows nothing (an earlier study's text never stays).
  function scopedRow(studies, uid, key) {
    if (!Array.isArray(studies) || typeof uid !== 'string' || typeof key !== 'string' || !key) return null;
    const row = studies.find(study => study && typeof study === 'object' && study.uid === uid);
    return row && row.sourcePatientKey === key && row.state && typeof row.state === 'object' ? row : null;
  }
  function clock(at) {
    const date = new Date(at);
    if (typeof at !== 'string' || Number.isNaN(date.getTime())) return '';
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }
  // Which text is shown and what the source line says. Hiding comes first; then Live > My Draft > saved.
  function choose({ uid, row, live }) {
    if (!row) return { kind: 'none', source: SOURCES.none, fields: { ...EMPTY } };
    const state = row.state;
    if (state.prelimHidden === true) return { kind: 'hidden', source: SOURCES.hidden, fields: { ...EMPTY } };
    if (live && live.uid === uid && live.editor && typeof live.editor === 'object')
      return { kind: 'live', source: SOURCES.live, fields: pick(live.editor) };
    if (state.draft && typeof state.draft === 'object') {
      const at = clock(state.draft.at);
      return { kind: 'draft', source: 'My Draft — 서버에 저장된 내 초안' + (at ? ' (저장 ' + at + ')' : ''), fields: pick(state.draft) };
    }
    if (Number.isInteger(state.version) && state.version > 0) {
      if (state.rs === 'A') return { kind: 'approved', source: 'Approved — ' + (state.repDoc || '-') + ' · ' + (state.confirm || '-'), fields: pick(state) };
      return { kind: 'saved', source: 'Saved — v' + state.version, fields: pick(state) };
    }
    return { kind: 'none', source: SOURCES.none, fields: { ...EMPTY } };
  }
  // A read is drawn only while everything it was sent under is still current.
  const TICKET = ['uid', 'sequence', 'request', 'session', 'list'];
  function current(ticket, now) {
    return !!ticket && !!now && TICKET.every(key => ticket[key] === now[key]) && ticket.uid !== null && ticket.uid !== undefined;
  }
  function heading(patient, row) {
    return [patient?.name, patient?.id, row?.modality].map(value => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean).join(' · ');
  }
  function word(row) { return row ? WORDS[row.state?.rs] || '' : ''; }
  function openText(result, name) {
    if (result && result.ok === true) return '판독 화면이 ' + (name || '이 환자') + ' 검사로 옮겨졌습니다 — 판독 화면 창에서 입력하세요.';
    const reason = result?.reason;
    if (reason === 'missing') return TEXT.missing;
    if (reason === 'timeout') return TEXT.timeout;
    return '판독 화면이 검사를 옮기지 못했습니다 (' + (OPEN_REASONS[reason] || '확인할 수 없는 답') + '). 판독 화면에서 확인하세요.';
  }
  const api = { FIELDS, WORDS, SOURCES, TEXT, OPEN_REASONS, scopedRow, choose, current, heading, word, clock, openText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinViewerReportPanelApi = api;
})(globalThis);

globalThis.KinViewerReportPanel = (() => {
  'use strict';
  const LIVE_EVERY_MS = 5000, OPEN_WAIT_MS = 6000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function mount(options) {
    const pure = globalThis.KinViewerReportPanelApi;
    const view = options.window || globalThis, doc = view.document;
    const { tabs, session, work } = options;
    const createLink = options.createLink || (settings => view.kinViewerEditorLink(settings));
    const request = options.fetch || ((url, init) => view.fetch(url, init));
    let ended = false, serverRequest = 0, liveRequest = 0, opening = false, shown = null, row = null, live = null, loaded = false, failed = false, timer = null;
    const el = (tag, props, parent) => { const node = doc.createElement(tag); Object.assign(node, props || {}); parent?.append(node); return node; };
    const panel = el('details', { id: 'kin-viewer-report', className: 'kin-viewer-report', open: true });
    panel.hidden = true;
    el('summary', { textContent: 'Report Editor' }, panel);
    const head = el('div', { className: 'kin-viewer-report-head' }, panel);
    const patient = el('strong', { id: 'kin-viewer-report-patient' }, head);
    const stateWord = el('span', { id: 'kin-viewer-report-state', className: 'kin-viewer-report-state' }, head);
    el('span', { className: 'kin-viewer-report-readonly', textContent: 'Read Only' }, head);
    const source = el('p', { id: 'kin-viewer-report-source', className: 'kin-viewer-report-source' }, panel);
    const grid = el('div', { className: 'kin-viewer-report-fields' }, panel);
    const fields = {};
    for (const [key, label] of [['findings', 'Findings'], ['conclusion', 'Conclusion'], ['recommendation', 'Recommendation']]) {
      const box = el('label', { className: 'kin-viewer-report-field' }, grid);
      el('span', { textContent: label }, box);
      fields[key] = el('textarea', { id: 'kin-viewer-report-' + key, readOnly: true, rows: 4, spellcheck: false }, box);
      fields[key].setAttribute('aria-readonly', 'true');
    }
    const actions = el('div', { className: 'kin-viewer-report-actions' }, panel);
    const openButton = el('button', { type: 'button', id: 'kin-viewer-report-open', textContent: 'Open in Reading Screen' }, actions);
    const refreshButton = el('button', { type: 'button', id: 'kin-viewer-report-refresh', textContent: 'Refresh' }, actions);
    const status = el('span', { id: 'kin-viewer-report-status' }, actions);
    status.setAttribute('role', 'status');

    const alive = () => {
      if (ended) return false;
      try { return !session.ended() && !session.readOnly() && !!session.owner() && (!work || work.state() === 'active'); } catch (_) { return false; }
    };
    const scope = () => {
      let value = null; try { value = tabs.snapshot(); } catch (_) { value = null; }
      return value && Array.isArray(value.studyUIDs) && typeof value.studyUIDs[0] === 'string'
        ? { uid: value.studyUIDs[0], key: value.key, sequence: value.sequence, patient: value.patient || {} } : null;
    };
    const sessionKey = () => { try { return JSON.stringify([session.owner(), work?.session?.() ?? null]); } catch (_) { return null; } };
    // The list document that linked this window (viewer-windows.js linked()); a relinked window is another link.
    const listKey = () => {
      try {
        const hash = new URLSearchParams(String(view.location.hash || '').slice(1));
        const groups = hash.getAll('kin-window-group'), lists = hash.getAll('kin-window-list');
        return groups.length === 1 && lists.length === 1 && UUID.test(groups[0]) && UUID.test(lists[0]) ? groups[0] + ' ' + lists[0] : '';
      } catch (_) { return ''; }
    };
    const now = counter => { const s = scope(); return s && { uid: s.uid, sequence: s.sequence, request: counter, session: sessionKey(), list: listKey() }; };
    // A read is also bound to this document's work generation (KinWorkContext): an answer from before a logout
    // preparation, or before its cancel, is not drawn.
    const capture = () => { try { return work?.capture?.('document') ?? null; } catch (_) { return null; } };
    const admitted = context => { if (!work) return true; try { return !!context && work.admits(context); } catch (_) { return false; } };
    const visible = () => alive() && panel.isConnected && !panel.hidden && !!panel.closest?.('#kin-workspace-dock') && doc.visibilityState !== 'hidden';

    function paint() {
      const s = scope();
      const chosen = loaded && !failed && s ? pure.choose({ uid: s.uid, row, live }) : null;
      patient.textContent = s ? pure.heading(s.patient, row) : '';
      stateWord.textContent = chosen && chosen.kind !== 'hidden' ? pure.word(row) : '';
      source.textContent = chosen ? chosen.source : !s ? pure.SOURCES.none : failed ? '' : loaded ? '' : pure.TEXT.loading;
      const body = chosen ? chosen.fields : { findings: '', conclusion: '', recommendation: '' };
      for (const key of pure.FIELDS) if (fields[key].value !== body[key]) fields[key].value = body[key];
      panel.dataset.source = chosen ? chosen.kind : failed ? 'failed' : loaded ? 'none' : 'loading';
      openButton.disabled = opening || !s || !alive();
      refreshButton.disabled = !s || !alive();
    }
    function clear() {
      serverRequest++; liveRequest++; row = null; live = null; loaded = false; failed = false;
      if (!opening) status.textContent = '';
      paint();
    }
    async function readServer() {
      const ticket = now(++serverRequest), context = capture();
      if (!ticket || !alive()) return;
      try {
        const response = await request('/api/studies?uids=' + encodeURIComponent(ticket.uid), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response || !response.ok) throw new Error('read');
        const data = await response.json();
        if (!alive() || !admitted(context) || !pure.current(ticket, now(serverRequest))) return;
        row = pure.scopedRow(data?.studies, ticket.uid, scope()?.key);
        loaded = true; failed = false;
        if (status.textContent === pure.TEXT.failed) status.textContent = '';
      } catch (_) {
        if (!alive() || !admitted(context) || !pure.current(ticket, now(serverRequest))) return;
        row = null; loaded = false; failed = true; status.textContent = pure.TEXT.failed;
      }
      paint();
    }
    async function readLive() {
      const ticket = now(++liveRequest), context = capture();
      if (!ticket || !alive()) return;
      let link = null, answer = null;
      try {
        link = createLink({ window: view, studies: [ticket.uid], owner: () => session.owner(), live: alive });
        answer = await link.read();
      } catch (_) { answer = null; }
      finally { try { link?.dispose(); } catch (_) {} }
      if (!alive() || !admitted(context) || !pure.current(ticket, now(liveRequest))) return;
      // Success carries the editor body (no ok flag); a refusal falls back silently to the server's text.
      live = answer && answer.editor && answer.uid === ticket.uid ? { uid: ticket.uid, editor: answer.editor } : null;
      paint();
    }
    function refresh() {
      if (!alive()) return;
      const s = scope();
      if (!s) { clear(); return; }
      readServer(); readLive();
    }
    async function openInReading() {
      if (opening || !alive()) return;
      const s = scope();
      if (!s) return;
      // The answer is told only on the same study, patient tab, session, work generation and list link it was asked from.
      const at = now(0), context = capture();
      opening = true; status.textContent = pure.TEXT.asking; paint();
      let link = null, result = null;
      try {
        link = createLink({ window: view, studies: [s.uid], owner: () => session.owner(), live: alive, openTimeoutMs: OPEN_WAIT_MS });
        result = await link.open(s.uid);
      } catch (_) { result = { ok: false, reason: 'unavailable' }; }
      finally { try { link?.dispose(); } catch (_) {} }
      opening = false;
      if (ended) return;
      const still = alive() && admitted(context) && pure.current(at, now(0));
      status.textContent = still ? pure.openText(result, s.patient?.name) : '';
      paint();
      // The reading screen's target is this study now: its text being typed is the Live source.
      if (still && result?.ok === true && visible()) readLive();
    }
    openButton.onclick = () => { openInReading(); };
    refreshButton.onclick = () => { status.textContent = ''; refresh(); };

    // The panel reads when it is shown and follows the patient tab; a hidden panel reads nothing.
    let wasVisible = false;
    function follow() {
      const shownNow = visible();
      if (shownNow && !wasVisible) refresh();
      wasVisible = shownNow;
    }
    const observer = new view.MutationObserver(() => follow());
    observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    const stopTabs = tabs.subscribe(() => {
      const s = scope(), key = s ? JSON.stringify([s.key, s.uid, s.sequence]) : null;
      if (key === shown) return;
      shown = key; clear();
      if (visible()) refresh();
    });
    // A relinked window (another list document) or a cancelled logout preparation starts over: earlier text is cleared
    // and a shown panel reads again.
    const restart = () => { if (ended) return; clear(); if (visible()) refresh(); };
    const relinkEvents = ['hashchange', 'kin-window-link-changed'];
    for (const type of relinkEvents) view.addEventListener(type, restart);
    const stopWork = work?.onInvalidate?.(event => {
      if (event?.reason === 'cancel' || event?.reason === 'lifecycle' && event.state === 'active') restart();
    });
    timer = view.setInterval(() => { if (visible()) readLive(); else follow(); }, LIVE_EVERY_MS);

    function stop() {
      if (ended) return;
      ended = true; serverRequest++; liveRequest++;
      view.clearInterval(timer); timer = null; observer.disconnect();
      try { stopTabs?.(); } catch (_) {}
      for (const type of relinkEvents) view.removeEventListener(type, restart);
      try { if (typeof stopWork === 'function') stopWork(); } catch (_) {}
      row = null; live = null; loaded = false; failed = false;
      for (const key of pure.FIELDS) fields[key].value = '';
      patient.textContent = stateWord.textContent = source.textContent = status.textContent = '';
      panel.dataset.source = 'ended';
      openButton.disabled = refreshButton.disabled = true;
    }
    const endChannel = options.onEnd ? options.onEnd(stop) : null;
    const stopSession = session.onChange?.(next => { if (next !== 'writer') stop(); });

    function attach() {
      if (ended) return;
      if (!panel.isConnected) doc.body.append(panel);
      doc.getElementById('kin-workspace-dock')?.refreshPanels?.();
      follow();
    }
    shown = (() => { const s = scope(); return s ? JSON.stringify([s.key, s.uid, s.sequence]) : null; })();
    paint();
    attach();
    return {
      panel, attach, refresh, stop,
      dispose() { stop(); endChannel?.close?.(); stopSession?.(); panel.remove(); },
    };
  }
  return { mount };
})();
