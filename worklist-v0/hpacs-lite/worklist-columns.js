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
    let saved = read(), state = saved.state, lastRaw = saved.raw, draft, baseline, openedMode, opener, ended = false;
    const dialog = document.createElement('dialog'); dialog.id = 'column-manager';
    dialog.setAttribute('aria-labelledby', 'wc-title');
    dialog.innerHTML = `<header><h2 id="wc-title">목록 열 설정</h2><button type="button" id="wc-close">닫기</button></header>
      <p>이 브라우저·계정별 설정입니다. 판독/촬영 화면을 따로 저장합니다. 다른 컴퓨터와 자동 동기화하지 않습니다.</p>
      <p>ID·Name은 항상 표시합니다. 숨긴 열의 검색 조건과 정렬은 유지됩니다.</p>
      <div id="wc-list"></div><p id="wc-status" role="status" aria-live="polite"></p>
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
          part.hidden = input.checked ? part.hidden.filter(k => k !== key) : [...part.hidden, key];
        });
        label.append(input, document.createTextNode(column.t + (REQUIRED.includes(key) ? ' (필수)' : ''))); row.append(label);
        for (const [action, text, delta] of [['up', '위로', -1], ['down', '아래로', 1]]) {
          const button = document.createElement('button'); button.type = 'button'; button.dataset.move = action;
          button.textContent = text; button.setAttribute('aria-label', column.t + ' ' + text);
          button.disabled = index + delta < 0 || index + delta >= part.order.length;
          button.addEventListener('click', () => {
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
      state = next; baseline = JSON.stringify(draft); changed(); dialog.close();
      document.querySelector('#columnsettings').title = persist ? '열 설정 저장됨 · 이 브라우저·계정별' : '열 설정 · 이번 창에만 적용됨';
    }
    $('save').addEventListener('click', () => apply(true));
    $('memory').addEventListener('click', () => apply(false));
    $('reset').addEventListener('click', () => { draft.modes[openedMode] = defaults(columns).modes[openedMode]; renderEditor(); status('기본 열을 준비했습니다. 적용 버튼을 누르면 반영됩니다.'); });
    $('reload').addEventListener('click', () => {
      if (!mayLeave()) return;
      saved = read(); lastRaw = saved.raw; draft = copy(saved.state); baseline = JSON.stringify(draft);
      renderEditor(); status(saved.message);
    });
    $('close').addEventListener('click', () => { if (mayLeave()) dialog.close(); });
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (mayLeave()) dialog.close(); });
    dialog.addEventListener('close', () => opener?.focus());
    function stop() { ended = true; if (dialog.open) dialog.close(); document.querySelector('#columnsettings').disabled = true; }
    window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') stop(); });
    let channel;
    try { channel = new BroadcastChannel('kin-session'); channel.addEventListener('message', e => { if (e.data?.type === 'session-ended') stop(); }); } catch (_) {}
    window.addEventListener('pagehide', () => { stop(); channel?.close(); }, { once: true });
    window.addEventListener('beforeunload', e => { if (dialog.open && dirty()) { e.preventDefault(); e.returnValue = ''; } });
    document.querySelector('#columnsettings').addEventListener('click', () => {
      if (ended || dialog.open) return;
      opener = document.activeElement; openedMode = mode(); saved = read();
      // Do not overwrite a newer tab's preferences with this tab's stale state.
      draft = copy(saved.raw !== lastRaw ? saved.state : state); lastRaw = saved.raw;
      baseline = JSON.stringify(draft); $('title').textContent = '목록 열 설정 · ' + (openedMode === 'Radiology' ? '판독' : '촬영');
      $('save').disabled = !owner; renderEditor(); status(saved.message); dialog.showModal(); $('close').focus();
    });
    return { columns: m => visible(columns, state, m) };
  }
  const api = { defaults, normalize, key, visible, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinWorklistColumns = api;
})(globalThis);
