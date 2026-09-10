/* Opening choices affect the next request, never the retained viewer document. */
(function (root) {
  'use strict';
  const PREFIX = 'kin-image-opening:v1:';
  const defaults = () => ({ version: 2, listTarget: 'window', includePrior: true, maxWindows: 1 });
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== (value.version === 1 ? 'includePrior,listTarget,version' : 'includePrior,listTarget,maxWindows,version') ||
        ![1, 2].includes(value.version) || !['window', 'workspace'].includes(value.listTarget) ||
        typeof value.includePrior !== 'boolean') return null;
    const maxWindows = value.version === 1 ? 1 : value.maxWindows;
    if (!Number.isInteger(maxWindows) || maxWindows < 1 || maxWindows > 4) return null;
    return { version: 2, listTarget: value.listTarget, includePrior: value.includePrior, maxWindows };
  }
  function key(session) {
    if (session?.state !== 'approved' || session.demo ||
        ![session.institution, session.sub].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) return null;
    return PREFIX + JSON.stringify([session.institution, session.sub]);
  }
  function read(storage, owner) {
    if (!owner) return { value: defaults(), status: 'disabled' };
    try {
      const raw = storage.getItem(owner);
      if (raw === null) return { value: defaults(), status: 'empty' };
      let value;
      try { value = typeof raw === 'string' && raw.length <= 512 && normalize(JSON.parse(raw)); } catch (_) {}
      return value ? { value, status: 'restored' } : { value: defaults(), status: 'invalid' };
    } catch (_) { return { value: defaults(), status: 'unavailable' }; }
  }
  function write(storage, owner, value) {
    const clean = normalize(value);
    if (!owner || !clean) return false;
    try { storage.setItem(owner, JSON.stringify(clean)); return true; } catch (_) { return false; }
  }
  function mount({ button, session }) {
    let storage;
    try { storage = root.localStorage; } catch (_) {}
    const owner = key(session());
    let { value, status } = read(storage, owner), ended = false, feedback = null;
    const dialog = document.createElement('dialog'); dialog.id = 'image-opening-dialog';
    dialog.setAttribute('aria-labelledby', 'image-opening-title');
    dialog.innerHTML = '<h2 id="image-opening-title">Image Opening</h2>' +
      '<p>이 계정의 현재 브라우저에서 다음 영상 열기부터 적용합니다. 이미 열린 영상·판독문은 바꾸지 않습니다.</p>' +
      '<label for="image-opening-target">From Worklist</label> ' +
      '<select id="image-opening-target"><option value="window">Viewer Window</option><option value="workspace">Reading Workspace</option></select>' +
      '<p>통합 판독 화면 안에서는 현재 작업공간을 계속 사용합니다. Open Viewer Window는 별도 창을 엽니다.</p>' +
      '<label><input id="image-opening-prior" type="checkbox"> Include Latest Prior</label>' +
      '<p>같은 환자·modality의 더 이른 검사 중 최근 검사를 함께 엽니다. 직접 선택한 관련 검사·시리즈와 저장 보기는 별도 선택을 따릅니다.</p>' +
      '<label for="image-opening-limit">Viewer Windows</label> <select id="image-opening-limit"><option value="1">1 · Reuse Window</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select>' +
      '<p>이 목록에서 관리하는 별도 창 수입니다. 2개 이상이면 다른 검사를 새 창에 유지하고, 가득 차면 기존 창을 먼저 저장 후 닫습니다. 제한을 줄여도 열린 창을 자동으로 닫지 않습니다.</p>' +
      '<p id="image-opening-status" role="status"></p>' +
      '<div class="image-opening-actions"><button class="chip" type="button" id="image-opening-reset">Reset</button><button class="chip" type="button" id="image-opening-done">Done</button></div>';
    document.body.append(dialog);
    const target = dialog.querySelector('#image-opening-target'), prior = dialog.querySelector('input'), limit = dialog.querySelector('#image-opening-limit');
    const reset = dialog.querySelector('#image-opening-reset'), message = dialog.querySelector('[role=status]');
    const current = () => !ended && owner !== null && key(session()) === owner;
    function render(note) {
      if (note) feedback = note;
      target.value = value.listTarget; prior.checked = value.includePrior; limit.value = String(value.maxWindows);
      button.disabled = target.disabled = prior.disabled = limit.disabled = reset.disabled = !current();
      message.textContent = feedback || ({ empty: '기본 설정 · 이 브라우저', restored: '설정 복원됨 · 이 브라우저',
        invalid: '저장된 설정 오류 · 기본 설정을 사용합니다.', unavailable: '저장소를 사용할 수 없어 기본 설정을 사용합니다.',
        disabled: '로그인을 확인한 뒤 설정을 변경하세요.' })[status];
    }
    function save(next) {
      if (!current()) { render('계정이 변경되었습니다. 다시 로그인한 뒤 설정을 여세요.'); return; }
      const clean = normalize(next);
      if (!clean) { render('설정을 확인하지 못했습니다. 다시 선택하세요.'); return; }
      value = clean;
      render(write(storage, owner, value) ? '설정 저장됨 · 다음 영상 열기부터 적용' : '설정 저장 안 됨 · 이 창에서만 유지');
    }
    target.onchange = prior.onchange = limit.onchange = () => save({ version: 2, listTarget: target.value, includePrior: prior.checked, maxWindows: Number(limit.value) });
    reset.onclick = () => save(defaults());
    button.onclick = () => { render(); if (current()) { dialog.showModal(); target.focus(); } };
    dialog.querySelector('#image-opening-done').onclick = () => dialog.close();
    dialog.addEventListener('close', () => { if (current()) button.focus(); });
    function end() { ended = true; if (dialog.open) dialog.close(); render('로그인이 종료되었습니다.'); }
    root.addEventListener('storage', e => {
      if (e.key === 'kin-session-ended') { end(); return; }
      if (e.key !== owner && e.key !== null || !current()) return;
      ({ value, status } = read(storage, owner)); feedback = null;
      render(status === 'restored' ? '다른 창의 설정을 불러왔습니다 · 다음 영상 열기부터 적용' : null);
    });
    let channel;
    try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
    root.addEventListener('pagehide', () => { end(); channel?.close(); });
    render();
    return { snapshot: () => current() ? normalize(value) : defaults() };
  }
  const api = { PREFIX, defaults, normalize, key, read, write, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinViewerOpening = api;
})(globalThis);
