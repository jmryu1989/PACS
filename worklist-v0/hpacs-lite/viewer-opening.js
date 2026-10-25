/* Opening choices affect the next request, never the retained viewer document. */
(function (root) {
  'use strict';
  const PREFIX = 'kin-image-opening:v1:';
  const defaults = () => ({ version: 3, listTarget: 'window', includePrior: true, maxWindows: 1, autoLoad: false, reuseClean: false });
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== (value.version === 1 ? 'includePrior,listTarget,version' : value.version === 2 ? 'includePrior,listTarget,maxWindows,version' : 'autoLoad,includePrior,listTarget,maxWindows,reuseClean,version') ||
        ![1, 2, 3].includes(value.version) || !['window', 'workspace'].includes(value.listTarget) ||
        typeof value.includePrior !== 'boolean') return null;
    const maxWindows = value.version === 1 ? 1 : value.maxWindows;
    if (!Number.isInteger(maxWindows) || maxWindows < 1 || maxWindows > 4) return null;
    const autoLoad = value.version < 3 ? false : value.autoLoad;
    const reuseClean = value.version < 3 ? false : value.reuseClean;
    if (typeof autoLoad !== 'boolean' || typeof reuseClean !== 'boolean') return null;
    return { version: 3, listTarget: value.listTarget, includePrior: value.includePrior, maxWindows, autoLoad, reuseClean };
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
      '<p>Viewer Window는 한 창을 다시 사용합니다. Viewer Windows의 Detect Displays에서 두 화면에 걸쳐 배치하거나 창을 직접 늘릴 수 있습니다. 이전에 열린 다른 창은 자동으로 닫지 않습니다.</p>' +
      '<label><input id="image-opening-autoload" type="checkbox"> Open on Selection</label>' +
      '<p>목록 행이나 이전/다음 검사로 새 검사를 선택할 때 영상을 엽니다. 이미 열린 창의 미저장 작업·대화상자와 창 수 제한을 유지합니다.</p>' +
      '<p id="image-opening-status" role="status"></p>' +
      '<div class="image-opening-actions"><button class="chip" type="button" id="image-opening-reset">Reset</button><button class="chip" type="button" id="image-opening-done">Done</button></div>';
    document.body.append(dialog);
    const target = dialog.querySelector('#image-opening-target'), prior = dialog.querySelector('#image-opening-prior'), automatic = dialog.querySelector('#image-opening-autoload');
    const reset = dialog.querySelector('#image-opening-reset'), message = dialog.querySelector('[role=status]');
    const current = () => !ended && owner !== null && key(session()) === owner;
    function render(note) {
      if (note) feedback = note;
      target.value = value.listTarget; prior.checked = value.includePrior;
      automatic.checked = value.autoLoad;
      button.disabled = target.disabled = prior.disabled = automatic.disabled = reset.disabled = !current();
      message.textContent = feedback || ({ empty: '기본 설정 · 이 브라우저', restored: '설정 복원됨 · 이 브라우저',
        invalid: '저장된 설정 오류 · 기본 설정을 사용합니다.', unavailable: '저장소를 사용할 수 없어 기본 설정을 사용합니다.',
        disabled: '로그인을 확인한 뒤 설정을 변경하세요.' })[status];
    }
    function save(next) {
      if (work.state() !== 'active') return;
      if (!current()) { render('계정이 변경되었습니다. 다시 로그인한 뒤 설정을 여세요.'); return; }
      const clean = normalize(next);
      if (!clean) { render('설정을 확인하지 못했습니다. 다시 선택하세요.'); return; }
      value = clean;
      render(write(storage, owner, value) ? '설정 저장됨 · 다음 영상 열기부터 적용' : '설정 저장 안 됨 · 이 창에서만 유지');
    }
    target.onchange = prior.onchange = automatic.onchange = () => save({ version: 3, listTarget: target.value, includePrior: prior.checked, maxWindows: 1, autoLoad: automatic.checked, reuseClean: false });
    reset.onclick = () => save(defaults());
    button.onclick = () => { render(); if (current()) { dialog.showModal(); target.focus(); } };
    dialog.querySelector('#image-opening-done').onclick = () => dialog.close();
    // close() has already restored focus and the close event is queued after it, so a later move belongs to the user: only focus left on nothing, the body or the closed dialog goes back to the opener.
    dialog.addEventListener('close', () => { const active = document.activeElement; if (current() && (!active || active === document.body || dialog.contains(active))) button.focus(); });
    const work = root.KinWorkContext;
    work.onInvalidate(event => {
      if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) end();
    });
    function end() { ended = true; if (dialog.open) dialog.close(); render('로그인이 종료되었습니다.'); }
    let removeStorage = () => {};
    function subscribe() {
      removeStorage();
      const at = work.capture('document');
      const storageChanged = e => work.commit(at, () => {
        if (e.key !== owner && e.key !== null || !current()) return;
        ({ value, status } = read(storage, owner)); feedback = null;
        render(status === 'restored' ? '다른 창의 설정을 불러왔습니다 · 다음 영상 열기부터 적용' : null);
      });
      root.addEventListener('storage', storageChanged);
      removeStorage = () => root.removeEventListener('storage', storageChanged);
    }
    let pausedStorage;
    const storedValue=()=>{try{return storage.getItem(owner);}catch(_){return undefined;}};
    work.onInvalidate(event => {
      if(event.reason==='prepare')pausedStorage=storedValue();
      if(event.reason==='cancel'){
        subscribe();const currentStorage=storedValue();
        if(currentStorage!==undefined&&currentStorage!==pausedStorage){
          const at=work.capture('document');work.commit(at,()=>{({value,status}=read(storage,owner));feedback=null;render();});
        }
        pausedStorage=undefined;
      }
    });
    subscribe();
    root.addEventListener('pagehide', () => { end();  });
    render();
    return { snapshot: () => current() ? normalize(value) : defaults() };
  }
  const api = { PREFIX, defaults, normalize, key, read, write, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinViewerOpening = api;
})(globalThis);
