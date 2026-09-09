(function (root) {
  'use strict';
  const MODES = ['Radiology', 'Technician'], REQUIRED = ['id', 'name'];
  const PREFIX = 'kin-worklist-columns:v1:';
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const copy = v => JSON.parse(JSON.stringify(v));
  function defaults(columns) {
    return { version: 1, modes: Object.fromEntries(MODES.map(mode => [mode,
      { order: columns[mode].map(c => c.k), hidden: [] }])) };
  }
  function normalize(value, columns) {
    if (!object(value) || value.version !== 1 || Object.keys(value).sort().join() !== 'modes,version'
      || !object(value.modes) || Object.keys(value.modes).sort().join() !== MODES.join()) return null;
    const next = defaults(columns);
    for (const mode of MODES) {
      const part = value.modes[mode], allowed = new Set(next.modes[mode].order);
      if (!object(part) || Object.keys(part).sort().join() !== 'hidden,order') return null;
      for (const key of ['order', 'hidden']) {
        const list = part[key];
        if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length
          || list.some(k => typeof k !== 'string' || !allowed.has(k))) return null;
      }
      if (part.hidden.some(k => REQUIRED.includes(k))) return null;
      // Newly introduced columns remain visible; existing order is preserved.
      next.modes[mode] = { order: [...part.order, ...[...allowed].filter(k => !part.order.includes(k))], hidden: [...part.hidden] };
    }
    return next;
  }
  function key(session) {
    if (!session || session.state !== 'approved' || session.demo
      || ![session.institution, session.sub].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) return null;
    return PREFIX + JSON.stringify([session.institution, session.sub]);
  }
  function visible(columns, state, mode) {
    const part = state.modes[mode];
    return part.order.filter(k => !part.hidden.includes(k)).map(k => columns[mode].find(c => c.k === k));
  }
  function mount({ columns, session, mode, changed }) {
    const owner = key(session);
    let storage;
    try { storage = localStorage; } catch (_) {}
    function read() {
      if (!owner) return { state: defaults(columns), raw: null, message: '로그인 계정이 없어 이번 창에만 적용할 수 있습니다.' };
      let raw;
      try {
        raw = storage.getItem(owner);
      } catch (_) { return { state: defaults(columns), raw: undefined, message: '브라우저 저장소를 읽을 수 없습니다. 이번 창에만 적용할 수 있습니다.' }; }
      try {
        if (raw === null) return { state: defaults(columns), raw, message: '저장된 열 설정이 없습니다.' };
        const state = raw.length <= 8192 ? normalize(JSON.parse(raw), columns) : null;
        return { state: state || defaults(columns), raw, message: state ? '저장된 열 설정을 불러왔습니다.' : '저장 형식이 잘못되어 기본 열을 표시합니다. 기존 저장값은 아직 변경하지 않았습니다.' };
      } catch (_) { return { state: defaults(columns), raw, message: '저장 형식이 잘못되어 기본 열을 표시합니다. 기본값을 적용해 복구할 수 있습니다.' }; }
    }
    let saved = read(), state = saved.state, lastRaw = saved.raw, stateRaw = saved.raw, draft, baseline, openedMode, opener, ended = false;
    let generation = 0, serverRevision = null, serverBusy = false, request;
    const identity = owner ? [session.institution, session.sub] : null;
    const dialog = document.createElement('dialog'); dialog.id = 'column-manager';
    dialog.setAttribute('aria-labelledby', 'wc-title');
    dialog.innerHTML = `<header><h2 id="wc-title">목록 열 설정</h2><button type="button" id="wc-close">닫기</button></header>
      <p>판독/촬영 화면을 따로 저장합니다. 다른 컴퓨터에서는 계정 설정을 불러오세요. 자동 동기화하지 않습니다.</p>
      <p>ID·Name은 항상 표시합니다. 숨긴 열의 검색 조건과 정렬은 유지됩니다.</p>
      <div id="wc-list"></div><p id="wc-status" role="status" aria-live="polite"></p>
      <section aria-label="계정 서버 열 설정"><p>계정 불러오기는 편집창에만 가져옵니다. 아래 적용 버튼으로 목록에 반영하세요.</p>
      <button type="button" id="wc-server-inspect">계정 저장 상태 확인</button><button type="button" id="wc-server-load">계정 설정 불러오기</button>
      <button type="button" id="wc-server-save">편집값을 계정에 저장</button><button type="button" id="wc-server-clear">계정 저장값 지우기</button>
      <p id="wc-server-status" role="status" aria-live="polite"></p></section>
      <footer><button type="button" id="wc-reset">현재 화면 기본값</button><button type="button" id="wc-reload">저장값 다시 불러오기</button>
      <button type="button" id="wc-memory">이번 창에만 적용</button><button type="button" id="wc-save">적용·이 브라우저 저장</button></footer>`;
    document.body.append(dialog);
    const $ = id => dialog.querySelector('#wc-' + id);
    const status = text => { $('status').textContent = text; };
    const dirty = () => JSON.stringify(draft) !== baseline;
    const mayLeave = () => !dirty() || confirm('적용하지 않은 열 설정 변경을 버릴까요?');
    function renderEditor(focus) {
      const part = draft.modes[openedMode];
      $('list').replaceChildren(...part.order.map((key, index) => {
        const column = columns[openedMode].find(c => c.k === key);
        const row = document.createElement('div'); row.className = 'wc-row'; row.dataset.column = key;
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = !part.hidden.includes(key); input.disabled = REQUIRED.includes(key);
        input.setAttribute('aria-label', column.t + ' 표시');
        input.addEventListener('change', () => {
          generation++;
          part.hidden = input.checked ? part.hidden.filter(k => k !== key) : [...part.hidden, key];
        });
        label.append(input, document.createTextNode(column.t + (REQUIRED.includes(key) ? ' (필수)' : ''))); row.append(label);
        for (const [action, text, delta] of [['up', '위로', -1], ['down', '아래로', 1]]) {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.move = action;
          button.textContent = text; button.setAttribute('aria-label', column.t + ' ' + text);
          button.disabled = index + delta < 0 || index + delta >= part.order.length;
          button.addEventListener('click', () => {
            generation++;
            [part.order[index], part.order[index + delta]] = [part.order[index + delta], part.order[index]];
            renderEditor({ key, action });
          }); row.append(button);
        }
        return row;
      }));
      if (focus) {
        const row = $('list').querySelector(`[data-column="${focus.key}"]`);
        const button = row.querySelector(`[data-move="${focus.action}"]`);
        (button.disabled ? row.querySelector('button:not(:disabled)') : button)?.focus();
      }
    }
    function apply(persist) {
      if (ended) return;
      const next = normalize(draft, columns);
      if (!next) { status('열 설정을 확인할 수 없습니다. 기본값으로 다시 설정하세요.'); return; }
      if (persist) {
        if (!owner) return;
        try {
          if (storage.getItem(owner) !== lastRaw) { status('다른 창에서 저장값이 변경됐습니다. 다시 불러온 뒤 적용하세요. 편집 내용은 유지했습니다.'); return; }
          const raw = JSON.stringify(next); storage.setItem(owner, raw); lastRaw = raw;
        } catch (_) { status('저장하지 못했습니다. 편집 내용은 유지했습니다. 이번 창에만 적용할 수 있습니다.'); return; }
      }
      generation++; state = next; stateRaw = lastRaw; baseline = JSON.stringify(draft); changed(); dialog.close();
      document.querySelector('#columnsettings').title = persist ? '열 설정 저장됨 · 이 브라우저·계정별' : '열 설정 · 이번 창에만 적용됨';
    }
    $('save').addEventListener('click', () => apply(true));
    $('memory').addEventListener('click', () => apply(false));
    $('reset').addEventListener('click', () => { generation++; draft.modes[openedMode] = defaults(columns).modes[openedMode]; renderEditor(); status('기본 열을 준비했습니다. 적용 버튼을 누르면 반영됩니다.'); });
    $('reload').addEventListener('click', () => {
      if (!mayLeave()) return;
      generation++; saved = read(); lastRaw = saved.raw; draft = copy(saved.state); baseline = JSON.stringify(draft);
      renderEditor(); status(saved.message);
    });
    $('close').addEventListener('click', () => { if (mayLeave()) dialog.close(); });
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (mayLeave()) dialog.close(); });
    dialog.addEventListener('close', () => { generation++; request?.abort(); opener?.focus(); });
    function stop() { ended = true; request?.abort(); if (dialog.open) dialog.close(); document.querySelector('#columnsettings').disabled = true; }
    function refreshServer() {
      for (const action of ['inspect','load','save','clear']) $('server-' + action).disabled = ended || !identity || serverBusy || (['save','clear'].includes(action) && serverRevision === null);
    }
    async function server(action) {
      if (ended || !identity || serverBusy || !dialog.open || (['save','clear'].includes(action) && serverRevision === null)) return;
      if (action === 'load' && !mayLeave()) return;
      if (action === 'clear' && !confirm('계정에 저장된 열 설정만 지울까요? 현재 목록과 브라우저 저장값은 유지합니다.')) return;
      const before = generation, snapshot = action === 'save' ? normalize(draft, columns) : null;
      if (action === 'save' && !snapshot) { $('server-status').textContent = '편집 중인 열 설정 형식이 잘못되었습니다. 다시 불러오거나 기본값으로 설정하세요.'; return; }
      serverBusy = true; refreshServer(); $('server-status').textContent = '계정 설정 확인 중…';
      request = new AbortController(); const signal = request.signal, timer = setTimeout(() => request?.abort(), 10000);
      const active = () => !ended && dialog.open && !signal.aborted;
      try {
        const method = action === 'save' ? 'PUT' : action === 'clear' ? 'DELETE' : 'GET';
        const body = method === 'GET' ? undefined : { expectedOwner: identity, revision: serverRevision, ...(action === 'save' ? { columns: snapshot } : {}) };
        const r = await fetch('/api/worklist-columns', { method, credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-KIN-CSRF': '1' }, body: body && JSON.stringify(body), signal });
        if (!active()) return;
        if (r.status === 401 || r.status === 403) { stop(); return; }
        if (!r.ok) {
          serverRevision = null;
          const data = await r.json().catch(() => null); if (!active()) return;
          if (data?.code === 'COLUMNS_OWNER_CHANGED') { stop(); return; }
          throw new Error(r.status === 409 ? 'conflict' : r.status === 400 ? 'invalid-settings' : 'save-failed');
        }
        const data = await r.json(); if (!active()) return;
        if (JSON.stringify(data.owner) !== JSON.stringify(identity)) { stop(); return; }
        if (!Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647 ||
            (data.columns !== null && !normalize(data.columns, columns))) throw new Error('format');
        const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal });
        if (!active()) return;
        if (me.status === 401 || me.status === 403) { stop(); return; }
        if (!me.ok) throw new Error('session-unavailable');
        const current = await me.json(); if (!active()) return;
        if (current.kind !== 'member' || JSON.stringify([current.institution, current.sub]) !== JSON.stringify(identity)) { stop(); return; }
        if (action === 'load' && generation !== before) {
          $('server-status').textContent = '응답을 기다리는 동안 편집값이 바뀌어 불러오지 않았습니다. 다시 불러오세요.'; return;
        }
        serverRevision = data.revision;
        if (action === 'load' && data.columns) {
          generation++; draft = normalize(data.columns, columns); renderEditor();
          $('server-status').textContent = '계정 설정을 편집창에 불러왔습니다. 아래 적용 버튼으로 목록에 반영하세요.';
        } else if (action === 'save') {
          $('server-status').textContent = generation === before ? '편집값을 계정에 저장했습니다. 목록 반영은 아래 적용 버튼을 누르세요.' : '요청 당시 편집값을 계정에 저장했습니다. 이후 편집은 아직 저장되지 않았습니다.';
        } else if (action === 'clear') $('server-status').textContent = '계정 저장값을 지웠습니다. 현재 목록·편집값·브라우저 저장값은 유지합니다.';
        else $('server-status').textContent = data.columns ? '계정에 저장된 열 설정이 있습니다.' : '계정에 저장된 열 설정이 없습니다. 현재 편집값은 유지합니다.';
      } catch (error) {
        serverRevision = null;
        if (!ended && dialog.open) {
          const messages = {
            conflict: '다른 창에서 계정 설정이 변경됐습니다. 편집 내용은 유지했습니다. 저장 상태를 확인한 뒤 다시 시도하세요.',
            'invalid-settings': '서버가 열 설정 형식을 거절했습니다. 편집 내용은 유지했습니다. 기본값 또는 저장값을 확인하세요.',
            format: '서버가 반환한 열 설정 형식을 확인할 수 없습니다. 현재 편집 내용은 유지했습니다.',
            'session-unavailable': '계정 상태를 일시적으로 확인하지 못했습니다. 편집 내용은 유지했습니다. 쓰기는 완료됐을 수 있으니 다시 불러와 확인하세요.',
          };
          $('server-status').textContent = messages[error?.message] || '계정 설정 응답을 확인할 수 없습니다. 편집 내용은 유지했습니다. 쓰기는 완료됐을 수 있으니 계정 설정을 불러와 확인하세요.';
        }
      } finally { clearTimeout(timer); request = null; serverBusy = false; refreshServer(); }
    }
    for (const action of ['inspect','load','save','clear']) $('server-' + action).addEventListener('click', () => server(action));
    window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') stop(); });
    let channel;
    try { channel = new BroadcastChannel('kin-session'); channel.addEventListener('message', e => { if (e.data?.type === 'session-ended') stop(); }); } catch (_) {}
    window.addEventListener('pagehide', () => { stop(); channel?.close(); }, { once: true });
    window.addEventListener('beforeunload', e => { if (dialog.open && dirty()) { e.preventDefault(); e.returnValue = ''; } });
    document.querySelector('#columnsettings').addEventListener('click', () => {
      if (ended || dialog.open) return;
      generation++; serverRevision = null; opener = document.activeElement; openedMode = mode(); saved = read();
      // Merely reading another tab's settings is not applying them. Keep the
      // active-state baseline separate so cancel/reopen cannot restore stale data.
      draft = copy(saved.raw !== stateRaw ? saved.state : state); lastRaw = saved.raw;
      baseline = JSON.stringify(draft); $('title').textContent = '목록 열 설정 · ' + (openedMode === 'Radiology' ? '판독' : '촬영');
      $('save').disabled = !owner; renderEditor(); status(saved.message); dialog.showModal(); $('close').focus(); refreshServer();
      $('server-status').textContent = '계정 저장 상태를 확인하거나 불러오세요.';
    });
    return { columns: m => visible(columns, state, m) };
  }
  const api = { defaults, normalize, key, visible, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinWorklistColumns = api;
})(globalThis);
