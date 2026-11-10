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

  /** Queue studies `[{ uid, label, urgent? }]` for the given session, in the reader's order. `auto`: an Auto Preload add. */
  function add(studies, session, { auto = false } = {}) {
    if (!connect() || typeof session !== 'string' || !session) return false;
    port.postMessage(auto ? { type: 'add', session, studies, auto: true } : { type: 'add', session, studies });
    return true;
  }

  // FC-073 (A1 unit 15; Minhoon M-099 "당직 때 볼 검사·과거 영상 미리 내려받기"): Auto Preload of one saved search.
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }
  /** The prior a viewer would open beside `s` (viewer-launch.js autoPrior): same patient key and modality, the latest earlier valid date. */
  function prior(s, all) {
    if (!s?.sourcePatientKey || !validDate(s.date)) return null;
    return all.filter(x => x.sourcePatientKey === s.sourcePatientKey && x.uid !== s.uid && x.modality === s.modality
        && validDate(x.date) && x.date < s.date)
      .sort((a, b) => b.date.localeCompare(a.date) || b.uid.localeCompare(a.uid))[0] || null;
  }
  /**
   * What Auto Preload queues from the studies a saved search matches (`matched`, in worklist order) among the loaded
   * list (`all`): emergency studies (EM E) first, each followed by its prior when `priors`; then the rest. A study met
   * twice is queued once, with the earliest (most urgent) place.
   */
  function pick(matched, all, { priors = false, label = s => s.uid } = {}) {
    const out = [], seen = new Set();
    const put = (s, urgent) => { if (s && !seen.has(s.uid)) { seen.add(s.uid); out.push({ uid: s.uid, label: label(s), urgent }); } };
    for (const urgent of [true, false]) {
      for (const s of matched) {
        if ((s.em === 'E') !== urgent) continue;
        put(s, urgent);
        if (priors) put(prior(s, all), urgent);
      }
    }
    return out;
  }
  const AUTO_KEY = 'kin-preload-auto:v1:';
  function normalizeAuto(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && value.version === 1
      && Object.keys(value).sort().join() === 'priors,search,version' && typeof value.priors === 'boolean'
      && (value.search === null || (typeof value.search === 'string' && value.search.length <= 200))
      ? { version: 1, search: value.search, priors: value.priors } : null;
  }
  /**
   * The More menu's Auto Preload: Off or one saved search, Include Priors, kept for this account in this browser
   * (like Auto Refresh). `afterList()` is called after every list read the page drew (Refresh, auto refresh, arrivals):
   * it sends the search's studies to the worker, which queues only the ones it does not have yet.
   * options: { select, priors, status, owner, session, allowed, searches: () => [{ id, name, filter }], match: filter => rows,
   *   rows: () => all loaded rows, label: row => text }
   */
  function mountAuto(o) {
    const bound = o.owner(), key = bound && AUTO_KEY + bound;
    let setting = { version: 1, search: null, priors: false }, ended = false, note = '';
    try {
      const raw = key && root.localStorage.getItem(key);
      if (raw !== null && raw !== undefined && raw !== false) {
        const saved = typeof raw === 'string' && raw.length <= 400 && normalizeAuto(JSON.parse(raw));
        if (saved) setting = saved;
        else note = '저장된 자동 미리 받기 설정을 확인할 수 없어 Off로 둡니다.';
      }
    } catch (_) { note = '자동 미리 받기 설정을 불러오지 못했습니다. Off로 둡니다.'; }
    const live = () => !ended && bound && o.owner() === bound;
    // The worker's setup failure can arrive after the add (the key read is slower than the list): the line follows each report.
    let base = '', sending = false;
    const paint = () => {
      const session = o.session(), own = state && session && state.session === session ? state : null;
      o.status.textContent = base + (sending && own?.unavailable ? ' ' + own.unavailable : '');
    };
    const unwatch = watch(() => { if (live()) paint(); });
    function fill() {
      const list = o.searches();
      const options = [new Option('Off', ''), ...list.map(s => new Option(s.name, s.id))];
      if (setting.search && !list.some(s => s.id === setting.search)) options.push(new Option('(저장 검색 없음)', setting.search));
      o.select.replaceChildren(...options);
      o.select.value = setting.search || '';
      o.priors.checked = setting.priors;
      o.select.disabled = o.priors.disabled = !live() || !available();
    }
    function save() {
      try { root.localStorage.setItem(key, JSON.stringify(setting)); return true; } catch (_) { return false; }
    }
    function run() {
      if (!live()) { o.select.disabled = o.priors.disabled = true; return; }
      sending = false;
      if (!setting.search) { base = note || 'Auto Preload: Off'; paint(); return; }
      const search = o.searches().find(s => s.id === setting.search);
      if (!search) { base = '고른 저장 검색을 찾을 수 없어 자동 미리 받기를 하지 않습니다. 다른 저장 검색을 고르거나 Off로 두세요.'; paint(); return; }
      const session = o.session();
      if (!o.allowed() || !session) { base = '서버에 연결된 동안에만 자동 미리 받기를 합니다.'; paint(); return; }
      const list = pick(o.match(search.filter), o.rows(), { priors: setting.priors, label: o.label });
      if (list.length) add(list, session, { auto: true });
      const urgent = list.filter(s => s.urgent).length;
      base = `Auto Preload: ${search.name} · 대상 ${list.length}건${urgent ? ` (응급 ${urgent}건 먼저)` : ''} · 진행은 PF 열과 Preload 패널에서 봅니다.`;
      sending = true; paint();
    }
    const changed = () => {
      if (!live()) { o.select.disabled = o.priors.disabled = true; return; }
      setting = { version: 1, search: o.select.value || null, priors: o.priors.checked };
      note = save() ? '' : '설정을 저장하지 못했습니다. 현재 창에만 적용합니다.';
      run();
    };
    o.select.addEventListener('change', changed);
    o.priors.addEventListener('change', changed);
    root.addEventListener('pagehide', () => { ended = true; unwatch(); o.select.disabled = o.priors.disabled = true; }, { once: true });
    fill(); o.status.textContent = note;
    return { afterList() { if (!live()) return; fill(); run(); }, end() { ended = true; unwatch(); fill(); } };
  }

  const gb = bytes => (bytes / GB).toFixed(bytes < GB ? 2 : 1);

  // FC-071: the worklist PF cell shows the same queue state as this panel (C-R01-033 #12-#13).
  /** This session's queue entry for a study, as the worker last reported it, or null (another session's queue shows nothing). */
  function study(uid) {
    const current = root.KinWorkContext?.session?.();
    if (broken || !current || state?.session !== current) return null;
    return (state.studies || []).find(s => s.uid === uid) || null;
  }
  /** The PF cell words for a queue entry: 'Downloading NN%' while fetching, otherwise the panel's status; null when not queued. */
  function cell(entry) {
    if (!entry || typeof entry.status !== 'string') return null;
    if (entry.status !== 'Downloading') return entry.status;
    const percent = entry.total > 0 ? Math.min(100, Math.floor(entry.done * 100 / entry.total)) : 0;
    return `Downloading ${percent}%`;
  }
  /** Call `fn` whenever the worker reports its queue; returns the function that stops it. Opens no connection itself. */
  function watch(fn) { views.add(fn); return () => views.delete(fn); }

  /**
   * The worker's last state if it is this page's session's, else null: the worker reports to every list page, and another
   * login's queue (patient labels, Retry, Clear All) is not this reader's. A page without a work context (the standalone
   * panel) takes it as it is.
   */
  function mine() {
    const work = root.KinWorkContext;
    if (broken || !state) return null;
    if (typeof work?.session !== 'function') return state;
    const current = work.session();
    return current && state.session === current ? state : null;
  }

  /** The status panel inside `host` (the selection bar). Returns { end }. `shown(visible)` hears whether it has rows. */
  function mount(host, { shown } = {}) {
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
    clear.onclick = () => { if (mine()) port?.postMessage({ type: 'clear' }); };
    actions.append(clear);
    body.append(storage, table, actions);
    panel.append(summary, body);
    host.append(panel);

    function render() {
      const own = mine(), list = own?.studies || [];
      panel.hidden = !list.length;
      // FC-073: Auto Preload queues without a selection; the selection bar keeps this panel (Retry, Clear All) reachable.
      try { shown?.(!panel.hidden); } catch (_) {}
      const counts = {};
      for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
      summary.textContent = 'Preload: ' + (['Downloading', 'Queued', 'Ready', 'Failed', 'Evicted']
        .filter(name => counts[name]).map(name => `${counts[name]} ${name}`).join(' · ') || '0');
      storage.textContent = own?.budget == null
        ? own?.unavailable || '미리 받기 저장 용량을 확인하고 있습니다.'
        : `보관 ${gb(own.used)} / ${gb(own.budget)} GB · 받은 뒤 72시간이 지나면 자동으로 지웁니다. 다른 계정으로는 읽을 수 없습니다. 만료 항목은 표시하지 않으며, 실행 중 10분 이내 또는 다음 실행의 첫 응답 전에 지웁니다.`;
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
          retry.onclick = () => { if (mine()) port?.postMessage({ type: 'retry', uid: s.uid }); };
          act.append(retry);
        }
        rows.append(tr);
      }
    }
    views.add(render);
    render();
    return { end() { views.delete(render); panel.remove(); } };
  }

  const api = Object.freeze({ available, add, mount, connect, study, cell, watch, pick, normalizeAuto, mountAuto });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinPreloadQueue = api;
})(globalThis);
