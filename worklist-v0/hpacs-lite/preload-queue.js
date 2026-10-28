/* D1880 memory-only preload, worklist side (Minhoon P0 item 1; design fable-design-preload-memory-20261027 §4.1 item 4).
 *
 * Preload on a multi-selection queues the selected studies in the preload SharedWorker (preload-worker.js); this panel
 * shows each one's status - Queued, Downloading, Ready, Failed, Evicted - with Retry, and the store's memory against the
 * budget the browser's reported memory allows. The images stay in that worker's memory only and are gone when the last
 * worklist or viewer window of this browser closes; nothing is written to the reading PC's disk (D1880).
 *
 * The worker serves one session: the worklist tells it the session it works for, and a session that ended or changed
 * empties the store. Labels shown here are the worklist's own row text, kept in the worker's memory with the queue so a
 * reloaded worklist can show the queue again.
 */
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
      // A store filled under another login is emptied before this worklist shows or adds anything.
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
    summary.title = '미리 받은 검사의 상태를 펼칩니다. 영상은 이 브라우저 메모리에만 있고, 목록과 뷰어 창을 모두 닫으면 사라집니다.';
    const body = document.createElement('div');
    body.className = 'preload-panel-body';
    const memory = document.createElement('p');
    memory.setAttribute('role', 'status');
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Study</th><th>Status</th><th></th><th>Progress</th><th>Note</th></tr></thead><tbody></tbody>';
    const actions = document.createElement('p');
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'chip'; clear.textContent = 'Clear All'; clear.id = 'preload-clear';
    clear.title = '미리 받은 영상을 모두 메모리에서 비웁니다.';
    clear.onclick = () => port?.postMessage({ type: 'clear' });
    actions.append(clear);
    body.append(memory, table, actions);
    panel.append(summary, body);
    host.append(panel);

    function render() {
      const list = state?.studies || [];
      panel.hidden = !list.length;
      const counts = {};
      for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
      summary.textContent = 'Preload: ' + (['Downloading', 'Queued', 'Ready', 'Failed', 'Evicted']
        .filter(name => counts[name]).map(name => `${counts[name]} ${name}`).join(' · ') || '0');
      memory.textContent = state?.budget == null
        ? '이 브라우저가 메모리 크기를 알려 주지 않아 미리 받기를 할 수 없습니다.'
        : `메모리 ${gb(state.used)} / ${gb(state.budget)} GB (이 브라우저가 알려 준 메모리로 정한 한도). 디스크에는 저장하지 않습니다.`;
      const rows = table.tBodies[0];
      rows.replaceChildren();
      for (const s of list) {
        const tr = document.createElement('tr');
        tr.dataset.uid = s.uid;
        const cell = text => { const td = document.createElement('td'); td.textContent = text; tr.append(td); return td; };
        cell(s.label || s.uid);
        cell(s.status + (s.open ? ' (Open)' : ''));
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
