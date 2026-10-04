/* Server preferences are applied only by an explicit load, never by login or resize. */
(function (root) {
  'use strict';
  function mount({ owner, read, apply, generation, model, endpoint, sessionEndpoint }) {
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
    const refresh = () => buttons.forEach(b => {
      b.disabled = ended || busy || !owner || (b.dataset.action !== 'load' && revision === null);
    });
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
      if (work.state() !== 'active' || ended || busy || !owner || (action !== 'load' && action !== 'inspect' && revision === null)) return;
      const at = work.capture('document'); interrupted = action;
      busy = true; refresh(); const before = generation();
      const snapshot = model.normalize(read());
      const local = request = new AbortController(); const timer = setTimeout(() => local.abort(), 10000);
      status.textContent = '서버 배치 확인 중…';
      try {
        const method = action === 'save' ? 'PUT' : action === 'clear' ? 'DELETE' : 'GET';
        const body = method === 'GET' ? undefined : { expectedOwner: owner, revision, ...(action === 'save' ? { layout: snapshot } : {}) };
        const response = await transport.request(endpoint, { context: at, method, credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-KIN-CSRF': '1' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: local.signal });
        if (response.auth || !work.admits(at)) return;
        const data = response.body;
        if (ended) return;
        if (!response.ok) {
          if (data?.code === 'WORKSPACE_OWNER_CHANGED') throw new Error('계정이 변경되었습니다. 다시 불러오세요.');
          if (response.status === 409) throw new Error('다른 창에서 서버 배치가 변경되었습니다. 불러온 뒤 다시 시도하세요.');
          throw new Error('서버 배치 작업에 실패했습니다. 쓰기는 완료됐을 수 있으니 불러와 확인하세요.');
        }
        const saved = decode(data);
        work.commit(at, () => {
        // A late read must not replace the user's newer local choice or update its write baseline.
        if ((action === 'load' || action === 'inspect') && before !== generation()) {
          status.textContent = '현재 배치가 변경되어 적용하지 않았습니다. 다시 불러오세요.'; return;
        }
        revision = saved.revision;
        if (action === 'load' && saved.layout) {
          const localSaved = apply(model.normalize(saved.layout));
          status.textContent = localSaved ? '서버 배치를 불러왔습니다 · 이 브라우저에도 저장됨' : '서버 배치를 불러왔습니다 · 이 창에만 적용됨';
        } else if (action === 'save') {
          status.textContent = before === generation() ? '현재 배치를 계정에 저장했습니다.' : '요청 당시 배치를 저장했습니다. 이후 변경은 아직 서버에 저장되지 않았습니다.';
        } else if (action === 'clear') {
          status.textContent = '계정의 서버 배치를 초기화했습니다. 현재 창의 배치는 유지합니다.';
        } else {
          status.textContent = saved.layout ? '서버에 저장된 배치가 있습니다. 불러오기를 누르면 적용합니다.' : '계정에 저장한 배치가 없습니다. 현재 창의 배치를 유지합니다.';
        }
        });
      } catch (error) {
        work.commit(at, () => {
        if (!ended) status.textContent = error?.name === 'AbortError' || error instanceof TypeError ?
          '서버 응답을 확인할 수 없습니다. 쓰기는 완료됐을 수 있으니 불러와 확인하세요.' :
          error?.message || '서버 배치를 확인할 수 없습니다. 현재 배치를 유지합니다.';
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
