/* D1890: the existing preload panel, with encrypted disk usage and expiry. */
(function (root) {
  'use strict';
  const WORKER_URL = '/worklist/hpacs-lite/preload-worker.js', WORKER_NAME = 'kin-preload';
  const GB = 1024 ** 3;
  let port = null, state = null, broken = false;
  const views = new Set();

  function connect() {
    if (port || broken || typeof root.SharedWorker !== 'function') return port;
    try {
      const worker = new root.SharedWorker(WORKER_URL, { name: WORKER_NAME });
      port = worker.port;
      port.onmessage = event => {
        if (event.data?.type !== 'state') return;
        state = event.data;
        for (const render of views) { try { render(); } catch (_) {} }
      };
      worker.onerror = () => { broken = true; port = null; for (const render of views) { try { render(); } catch (_) {} } };
      port.start();
      port.postMessage({ type: 'hello', role: 'list' });
      const work = root.KinWorkContext;
      // Announce the session so the worker can silently restore its encrypted queue.
      const current = work?.session?.();
      if (current) port.postMessage({ type: 'session', session: current });
      work?.onInvalidate?.(event => {
        if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) port?.postMessage({ type: 'session', session: null });
      });
      root.addEventListener('pagehide', () => port?.postMessage({ type: 'bye' }));
      root.addEventListener('pageshow', event => { if (event.persisted) port?.postMessage({ type: 'hello', role: 'list' }); });
    } catch (_) { broken = true; port = null; }
    return port;
  }

  const available = () => typeof root.SharedWorker === 'function' && !broken;

  /** Queue studies `[{ uid, label }]` for the given session, in the reader's order. */
  function add(studies, session) {
    if (!connect() || typeof session !== 'string' || !session) return false;
    port.postMessage({ type: 'add', session, studies });
    return true;
  }

  const gb = bytes => (bytes / GB).toFixed(bytes < GB ? 2 : 1);

  /** The status panel inside `host` (the selection bar). Returns { end }. */
  function mount(host) {
    if (!connect()) return { end() {} };
    const panel = document.createElement('details');
    panel.id = 'preload-panel';
    const summary = document.createElement('summary');
    summary.className = 'chip';
    summary.title = '받은 뒤 72시간이 지나면 자동으로 지웁니다. 다른 계정으로는 읽을 수 없습니다.';
    const body = document.createElement('div');
    body.className = 'preload-panel-body';
    const storage = document.createElement('p');
    storage.setAttribute('role', 'status');
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Study</th><th>Status</th><th></th><th>Progress</th><th>Note</th></tr></thead><tbody></tbody>';
    const actions = document.createElement('p');
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'chip'; clear.textContent = 'Clear All'; clear.id = 'preload-clear';
    clear.title = '미리 받은 영상 사본을 저장소에서 모두 지웁니다.';
    clear.onclick = () => port?.postMessage({ type: 'clear' });
    actions.append(clear);
    body.append(storage, table, actions);
    panel.append(summary, body);
    host.append(panel);

    function render() {
      const list = state?.studies || [];
      panel.hidden = !list.length;
      const counts = {};
      for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
      summary.textContent = 'Preload: ' + (['Downloading', 'Queued', 'Ready', 'Failed', 'Evicted']
        .filter(name => counts[name]).map(name => `${counts[name]} ${name}`).join(' · ') || '0');
      storage.textContent = state?.budget == null
        ? state?.unavailable || '미리 받기 저장 용량을 확인하고 있습니다.'
        : `보관 ${gb(state.used)} / ${gb(state.budget)} GB · 받은 뒤 72시간이 지나면 자동으로 지웁니다. 다른 계정으로는 읽을 수 없습니다. 만료 항목은 표시하지 않으며, 실행 중 10분 이내 또는 다음 실행의 첫 응답 전에 지웁니다.`;
      const rows = table.tBodies[0];
      rows.replaceChildren();
      for (const s of list) {
        const tr = document.createElement('tr');
        tr.dataset.uid = s.uid;
        const cell = text => { const td = document.createElement('td'); td.textContent = text; tr.append(td); return td; };
        cell(s.label || s.uid);
        cell(s.status + (s.status === 'Ready' && s.expiresAt ? ' · ' + new Date(s.expiresAt).toLocaleString() + '까지' : '') + (s.open ? ' (Open)' : ''));
        // Retry beside the status, so it stays in view however long the note is.
        const act = cell('');
        cell(s.total ? `${s.done}/${s.total}` : '');
        cell(s.reason || '');
        if (s.status === 'Failed' || s.status === 'Evicted') {
          const retry = document.createElement('button');
          retry.type = 'button'; retry.className = 'chip'; retry.textContent = 'Retry';
          retry.title = '이 검사를 대기열 맨 앞에 다시 넣습니다.';
          retry.onclick = () => port?.postMessage({ type: 'retry', uid: s.uid });
          act.append(retry);
        }
        rows.append(tr);
      }
    }
    views.add(render);
    render();
    return { end() { views.delete(render); panel.remove(); } };
  }

  const api = Object.freeze({ available, add, mount, connect });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinPreloadQueue = api;
})(globalThis);
