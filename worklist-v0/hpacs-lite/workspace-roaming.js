/* Server preferences are applied only by an explicit load, never by login or resize. */
(function (root) {
  'use strict';
  /*
   * A read of the account copy that fails (Load, the check at start, Retry) never says anything about a write, and it
   * takes away the right to write: Save and Reset Account Layout stay off until a later read confirms the account copy
   * (the revision they would overwrite is no longer known). The local layout goes on as before. The Load button becomes
   * Retry, a read that does not change the screen. The kind of failure decides the sentence (decided rule, Astra
   * roaming-403 consult 2026-10-05): a refusal of this account (denied), an authentication request that was not
   * accepted for now (temporary), or anything else whose cause is not known (unknown). A refused Save is the refusal of
   * that save; only a Save whose answer was lost or is not known says that its result is not known.
   */
  const READ_FAILED = {
    denied: { lead: '계정 배치 접근이 거절되어 ', save: '계정 배치 접근을 다시 확인하기 전에는 저장 요청을 보내지 않습니다.',
      recheck: '이 브라우저의 배치를 유지하며 계정 배치 접근을 다시 확인합니다.' },
    temporary: { lead: '계정 배치를 지금 확인하지 못해 ', save: 'Retry로 계정 배치를 다시 확인한 뒤 저장할 수 있습니다.',
      recheck: '이 브라우저의 배치를 유지하며 계정 배치를 다시 확인합니다.' },
    unknown: { lead: '계정 배치를 확인하지 못해 ', save: '덮어쓸 계정 배치를 확인하기 전에는 저장 요청을 보내지 않습니다.',
      recheck: '이 브라우저의 배치를 유지하며 계정 배치를 다시 확인합니다.' },
  };
  const KEPT = '현재 배치를 이 브라우저에서 계속 사용합니다.', NOT_KEPT = '현재 변경은 이 창에만 남으며 새로고침하면 사라집니다.';
  const DIFFERENT = '계정 배치와 현재 배치가 다르며, Save to Account는 계정본을 교체하고 Load from Account는 현재 배치를 교체합니다.';
  const WRITE_UNKNOWN = { save: '계정 저장 결과를 확인하지 못했으며 현재 배치는 유지합니다.',
    clear: '계정 배치 초기화 결과를 확인하지 못했으며 현재 배치는 유지합니다.' };
  const WRITE_REFUSED = { save: '계정 배치 저장이 거절되었습니다. 현재 배치는 유지합니다.',
    clear: '계정 배치 초기화가 거절되었습니다. 현재 배치는 유지합니다.' };
  const WRITE_NOT_ACCEPTED = { save: '저장 요청이 받아들여지지 않았습니다. 현재 배치는 유지합니다. 다시 저장하세요.',
    clear: '초기화 요청이 받아들여지지 않았습니다. 현재 배치는 유지합니다. 다시 시도하세요.' };
  const WRITE_FAILED = { save: '계정 배치를 저장하지 못했습니다. 현재 배치는 유지합니다.',
    clear: '계정 배치를 초기화하지 못했습니다. 현재 배치는 유지합니다.' };
  function mount({ owner, read, apply, generation, model, endpoint, sessionEndpoint, localKept }) {
    const menu = document.querySelector('#workspace-server-menu');
    const status = document.querySelector('#workspace-server-status');
    const buttons = [...menu.querySelectorAll('button')];
    const panel = document.querySelector('#workspace-server-panel');
    const place = () => {
      if (!menu.open) return;
      const box = menu.querySelector('summary').getBoundingClientRect();
      panel.style.left = Math.max(12, Math.min(box.left, innerWidth - panel.offsetWidth - 12)) + 'px';
      panel.style.top = Math.max(12, Math.min(box.bottom, innerHeight - panel.offsetHeight - 12)) + 'px';
    };
    let placeListener;
    let revision = null, busy = false, ended = false, request;
  const work = window.KinWorkContext, transport = window.KinSessionTransport.page();
  let interrupted = null;
    function observePlace(){
      if(placeListener){menu.removeEventListener('toggle',placeListener);window.removeEventListener('resize',placeListener);window.removeEventListener('scroll',placeListener,true);}
      const at=work.capture('document');placeListener=()=>work.commit(at,place);
      menu.addEventListener('toggle',placeListener);window.addEventListener('resize',placeListener);window.addEventListener('scroll',placeListener,true);
    }
    work.onInvalidate(event=>{if(event.reason==='cancel'||event.reason==='lifecycle'&&event.state==='active'){observePlace();place();}});
    observePlace();
    // The kind of the last failed read of the account copy (null after a read that confirmed it). It survives a reload of
    // this tab only (sessionStorage), so the check at start can say what it is re-checking; nothing depends on it.
    let access = null;
    const loadButton = buttons.find(b => b.dataset.action === 'load'), loadLabel = loadButton?.textContent, loadTitle = loadButton?.title;
    const memory = owner ? 'kin-workspace-account-check:' + JSON.stringify(owner) : null;
    const remember = kind => { try { if (!memory) return; if (kind) sessionStorage.setItem(memory, kind); else sessionStorage.removeItem(memory); } catch (_) {} };
    try { const kind = memory && sessionStorage.getItem(memory); if (READ_FAILED[kind]) access = kind; } catch (_) {}
    const refresh = () => {
      buttons.forEach(b => {
        b.disabled = ended || busy || !owner || (b.dataset.action !== 'load' && revision === null);
      });
      if (loadButton) {
        loadButton.textContent = access ? 'Retry' : loadLabel;
        loadButton.title = access ? '화면을 바꾸지 않고 계정 배치를 다시 확인합니다.' : loadTitle || '';
      }
    };
    const kept = () => { try { return localKept?.() !== false; } catch (_) { return true; } };
    const readFailedText = kind => READ_FAILED[kind].lead + (kept() ? KEPT : NOT_KEPT) + ' ' + READ_FAILED[kind].save;
    const stop = () => { ended = true; request?.abort(); refresh(); };
    const endSession = () => { stop(); status.textContent = '세션이 변경되었습니다. 다시 로그인한 뒤 여세요.'; };
      const unsubscribe = work.onInvalidate(event => {
      if (event.reason === 'lifecycle' && !['active', 'preparing'].includes(event.state)) endSession();
      if (event.reason === 'cancel') {
        request = null; busy = false; refresh();
        const action = interrupted; interrupted = null;
        if (action) run(action === 'load' ? 'load' : 'inspect');
      }
    });
    window.addEventListener('pagehide', () => { stop(); unsubscribe(); }, { once: true });
    function decode(data) {
      if (!data || JSON.stringify(data.owner) !== JSON.stringify(owner)) {
        throw new Error('계정이 변경되었습니다. 다시 로그인한 뒤 여세요.');
      }
      if (!Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647 ||
          (data.layout !== null && !model.normalize(data.layout)))
        throw new Error('서버 배치 형식을 확인할 수 없습니다. 현재 배치를 유지합니다.');
      return data;
    }
    async function run(action) {
      // While the last read of the account copy failed, the Load button is Retry: a read that changes nothing on screen.
      if (action === 'load' && access) action = 'retry';
      const reading = action === 'load' || action === 'inspect' || action === 'retry';
      if (work.state() !== 'active' || ended || busy || !owner || (!reading && revision === null)) return;
      const at = work.capture('document'); interrupted = action;
      busy = true; refresh(); const before = generation();
      const snapshot = model.normalize(read());
      const local = request = new AbortController(); const timer = setTimeout(() => local.abort(), 10000);
      const rechecking = access && action !== 'load' ? access : null;
      status.textContent = rechecking ? READ_FAILED[rechecking].recheck : '서버 배치 확인 중…';
      // A failed read: the account copy is not known any more, so neither is the revision a write would replace.
      const readFailed = (kind, text) => work.commit(at, () => {
        if (ended) return;
        revision = null; access = kind; remember(kind);
        status.textContent = text || readFailedText(kind);
      });
      try {
        const method = action === 'save' ? 'PUT' : action === 'clear' ? 'DELETE' : 'GET';
        const body = method === 'GET' ? undefined : { expectedOwner: owner, revision, ...(action === 'save' ? { layout: snapshot } : {}) };
        // Only a write carries a body and the CSRF header the server requires of a write.
        const response = await transport.request(endpoint, { context: at, method, credentials: 'same-origin', cache: 'no-store',
          headers: reading ? {} : { 'Content-Type': 'application/json', 'X-KIN-CSRF': '1' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: local.signal });
        if (response.auth || !work.admits(at)) return;
        const data = response.body;
        if (ended) return;
        if (!response.ok) {
          const kind = window.KinSessionTransport.refusal(response);
          if (reading) {
            readFailed(kind === 'denied' || kind === 'temporary' ? kind : 'unknown',
              data?.code === 'WORKSPACE_OWNER_CHANGED' ? '계정이 변경되었습니다. 다시 로그인한 뒤 여세요.' : null);
            return;
          }
          if (data?.code === 'WORKSPACE_OWNER_CHANGED') throw new Error('계정이 변경되었습니다. 다시 불러오세요.');
          if (response.status === 409) throw new Error('다른 창에서 서버 배치가 변경되었습니다. 불러온 뒤 다시 시도하세요.');
          // The server answered this write: a refusal is the refusal of this request; a 5xx (a proxy's or the server's)
          // does not say whether the write happened.
          throw new Error(kind === 'denied' ? WRITE_REFUSED[action] : kind === 'temporary' ? WRITE_NOT_ACCEPTED[action]
            : response.status >= 500 ? WRITE_UNKNOWN[action] : WRITE_FAILED[action]);
        }
        let saved;
        try { saved = decode(data); }
        catch (error) { if (!reading) throw error; readFailed('unknown', error.message.startsWith('계정이 변경') ? error.message : null); return; }
        work.commit(at, () => {
        // A late read must not replace the user's newer local choice or update its write baseline.
        if (reading && before !== generation()) {
          status.textContent = '현재 배치가 변경되어 적용하지 않았습니다. 다시 불러오세요.'; return;
        }
        revision = saved.revision;
        const confirmed = !!access;
        if (reading) { access = null; remember(null); }
        if (action === 'load' && saved.layout) {
          const localSaved = apply(model.normalize(saved.layout));
          status.textContent = localSaved ? '서버 배치를 불러왔습니다 · 이 브라우저에도 저장됨' : '서버 배치를 불러왔습니다 · 이 창에만 적용됨';
        } else if (action === 'save') {
          status.textContent = before === generation() ? '현재 배치를 계정에 저장했습니다.' : '요청 당시 배치를 저장했습니다. 이후 변경은 아직 서버에 저장되지 않았습니다.';
        } else if (action === 'clear') {
          status.textContent = '계정의 서버 배치를 초기화했습니다. 현재 창의 배치는 유지합니다.';
        } else if (confirmed) {
          // The account copy is known again after a failure. Nothing is applied or uploaded: the reader chooses.
          const differs = saved.layout && JSON.stringify(model.normalize(saved.layout)) !== JSON.stringify(snapshot);
          status.textContent = differs ? DIFFERENT : saved.layout ? '계정 배치를 다시 확인했습니다. 현재 배치와 같습니다.'
            : '계정 배치를 다시 확인했습니다. 계정에 저장한 배치가 없으며 현재 창의 배치를 유지합니다.';
        } else {
          status.textContent = saved.layout ? '서버에 저장된 배치가 있습니다. 불러오기를 누르면 적용합니다.' : '계정에 저장한 배치가 없습니다. 현재 창의 배치를 유지합니다.';
        }
        });
      } catch (error) {
        if (reading) { readFailed('unknown'); return; }
        // A write that left and whose answer did not come back (lost, cut, timed out) has an unknown result; one the
        // transport never sent says so in its own words; a refusal the server answered was thrown above with its sentence.
        const lost = error?.transport ? error.sent !== false : error?.name === 'AbortError' || error instanceof TypeError;
        work.commit(at, () => {
        if (!ended) status.textContent = lost ? WRITE_UNKNOWN[action] : error?.message || WRITE_UNKNOWN[action];
        });
      } finally {
        clearTimeout(timer);
        if (request === local) { request = null; busy = false; }
        work.commit(at, () => { interrupted = null; refresh(); place(); });
      }
    }
    buttons.forEach(b => b.addEventListener('click', () => run(b.dataset.action)));
    refresh();
    if (owner) run('inspect');
    else status.textContent = '로그인한 회원만 계정 배치를 사용할 수 있습니다.';
  }
  root.KinWorkspaceRoaming = { mount };
})(globalThis);
