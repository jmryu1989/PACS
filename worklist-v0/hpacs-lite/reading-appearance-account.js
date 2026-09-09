/* Explicit account text restore preserves newer local appearance choices. */
window.KinReadingAppearanceAccount = function ({ owner, host, read, apply, generation, normalize, allowed, endpoint, sessionEndpoint }) {
  host.textContent='';
  const make = (tag, text, id) => { const el = document.createElement(tag); el.textContent = text; el.id = id; host.append(el); return el; };
  const load = make('button', '글자 설정 불러오기', 'appearance-account-load');
  const save = make('button', '글자 설정 계정 저장', 'appearance-account-save');
  for (const b of [load, save]) { b.type = 'button'; b.className = 'chip'; }
  const status = make('span', '', 'appearance-account-status'); status.setAttribute('role', 'status');
  let revision = null, busy = false, ended = false, request, channel;
  const refresh = () => { load.disabled = ended || busy || !owner || !allowed(); save.disabled = load.disabled || revision === null; };
  function end() { ended = true; revision = null; request?.abort(); refresh(); }
  const sessionEnd = () => { end(); status.textContent = '세션이 변경되었습니다. 다시 로그인하세요.'; };
  const storage = e => { if (e.key === 'kin-session-ended') sessionEnd(); };
  window.addEventListener('storage', storage);
  try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') sessionEnd(); }; } catch (_) {}
  window.addEventListener('pagehide', () => { end(); channel?.close(); window.removeEventListener('storage', storage); }, { once: true });
  async function run(action) {
    if (ended || busy || !owner || !allowed() || action === 'save' && revision === null) return;
    const before = generation(), value = read(); busy = true; refresh();
    request = new AbortController(); const timer = setTimeout(() => request.abort(), 10000);
    status.textContent = '글자 설정 확인 중…';
    try {
      const response = await fetch(endpoint, { method: action === 'save' ? 'PUT' : 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: request.signal, headers: { 'X-KIN-CSRF': '1', 'Content-Type': 'application/json' },
        ...(action === 'save' ? { body: JSON.stringify({ expectedOwner: owner, revision, sizes: value }) } : {}) });
      if (ended || !allowed()) { end(); return; }
      if ([401,403].includes(response.status)) { sessionEnd(); return; }
      if (!response.ok) { revision = null; throw new Error(response.status === 409 ? '다른 창에서 설정이 바뀌었습니다. 불러온 뒤 다시 저장하세요.' : '설정 저장 여부를 확인하지 못했습니다. 불러와 확인하세요.'); }
      const data = await response.json();
      if (ended || !allowed()) { end(); return; }
      if (JSON.stringify(data.owner) !== JSON.stringify(owner)) { sessionEnd(); return; }
      if (!Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647 ||
          (data.revision === 0 ? data.sizes !== null : !normalize(data.sizes))) throw new Error('계정 설정 응답을 확인할 수 없습니다.');
      const meResponse = await fetch(sessionEndpoint, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
      if (ended || !allowed()) { end(); return; }
      if (!meResponse.ok) { sessionEnd(); return; }
      const me = await meResponse.json();
      if (ended || !allowed()) { end(); return; }
      if (me.kind !== 'member' || JSON.stringify([me.institution,me.sub]) !== JSON.stringify(owner)) { sessionEnd(); return; }
      if (action !== 'save' && before !== generation()) { status.textContent = '현재 설정이 바뀌어 적용하지 않았습니다. 다시 불러오세요.'; return; }
      revision = data.revision;
      if (action === 'load' && data.sizes !== null) { status.textContent = apply(data.sizes) ? '계정의 글자 설정을 불러왔습니다.' : '현재 화면에는 적용하지 않았습니다. 계정 상태를 확인하세요.'; }
      else if (action === 'save') status.textContent = before === generation() ? '글자 설정을 계정에 저장했습니다.' : '요청 당시 설정을 저장했습니다. 이후 변경은 저장되지 않았습니다.';
      else status.textContent = data.sizes === null ? '계정에 저장된 글자 설정이 없습니다.' : '계정 설정이 있습니다. 불러오기를 누르면 적용합니다.';
    } catch (e) {
      if (!ended) { revision = null; status.textContent = e?.name === 'AbortError' || e instanceof TypeError ? '응답을 확인하지 못했습니다. 불러와 확인하세요.' : (e instanceof SyntaxError ? '계정 설정 응답 형식을 확인하지 못했습니다.' : e.message); }
    } finally { clearTimeout(timer); request = null; busy = false; refresh(); }
  }
  load.onclick = () => run('load'); save.onclick = () => run('save'); refresh();
  if (owner) run('inspect');
};
