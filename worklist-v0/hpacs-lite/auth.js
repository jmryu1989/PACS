/** KIN 인증 — 브라우저에는 HttpOnly 세션 쿠키만 둔다. 이 문서의 세션 상태는 이 파일 하나가 정한다(S7-U5). */
const KinAuth = (() => {
  const API = `${location.origin}/api`;
  const KC = `${location.origin}/auth`;
  const LEGACY_KEYS = [
    'kin-at', 'kin-rt', 'kin-it', 'kin-exp', 'kin-verifier', 'kin-state', 'kin-user', 'kin-roles',
  ];
  // 저장소가 막힌 브라우저에서도 이 파일은 끝까지 실행돼야 한다 — 실행이 끊기면 닫힘 안내도 로그인도 없다.
  const tab = {
    get(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch (e) {} },
    remove(key) { try { sessionStorage.removeItem(key); } catch (e) {} },
  };

  // 배포 전부터 열려 있던 탭은 코드가 바뀌어도 저장된 토큰이 남는다. 모듈이 로드되는
  // 모든 탭에서 한 번 지워야 "새 코드는 안 쓴다"가 아니라 실제 토큰 부재가 된다.
  LEGACY_KEYS.forEach(key => tab.remove(key));
  try { document.cookie = 'kin_at=; Path=/; Max-Age=0; Secure; SameSite=Strict'; } catch (e) {}

  /**
   * 이 문서의 세션 상태(U5S-REQ-04). 화면의 사용을 끝내는 것과 서버가 세션 종료를 확인한 것은 다르다.
   *   unknown      신원을 확인하지 못했다. 보호 화면을 열지 않는다. 사유가 있으면(저장소를 믿을 수 없음·기록을 읽을 수 없음·
   *                로그인 확인 실패) 서버에 묻지도 않고 명시적 로그인만 받는다.
   *   active       서버가 확인한 세션 하나에 묶여 일하는 중. 그 세션의 식별값(sessionId)을 모든 요청이 싣는다.
   *   ending       종료 요청 중 — 이 문서는 이미 닫혔다.
   *   unconfirmed  서버의 종료를 확인하지 못했다(실패 구분이 함께 남는다). 다시 보내는 것은 Retry Log Out뿐이다.
   *   confirmed    서버가 그 세션의 종료를 확인했다.
   * 한 문서는 신원을 한 번만 받는다. 닫힌 문서는 늦은 답·지워진 기록·통지로 다시 열리지 않는다 — 다시 들어가는 길은 새 문서의
   * 진입이다. 로그아웃 준비(preparing)는 세션이 아니라 업무의 멈춤이라 work-context.js가 맡는다.
   *
   * 일하는 문서를 닫는 것은 셋뿐이다: 이 세션에 묶인 명시적 종료 의도(이 문서나 같은 세션의 다른 문서의 Log out), 서버가
   * 확인한 이 세션의 종료(AUTH_SESSION_ENDED), 서버가 확인한 세션 교체(AUTH_SESSION_MISMATCH·다른 계정의 답). 코드 없는
   * 401·403·409, 결속 누락(428), 5xx, 시간 초과, 연결 끊김, 저장소 오류, 다른 세션의 통지는 닫지 않는다 — 그 요청 하나가
   * 실패할 뿐이고 의사의 화면은 그대로다.
   */
  const CLOSED = ['ending', 'unconfirmed', 'confirmed'];
  const END_REASONS = ['conflict', 'storage', 'network', 'timeout', 'refused', 'credentials', 'replaced'];
  /**
   * 종료 기록(U5S-REQ-06). 담는 것은 세션 식별값·요청 번호·닫힘 상태(와 실패 구분)뿐이다 — sid·토큰·쿠키·계정·기관·환자
   * 값은 담지 않는다. 같은 출처의 모든 문서가 읽는 localStorage에 두어 새로고침·뒤로 가기·나중에 연 탭도 같은 상태를 본다.
   * 이 기록은 화면을 닫고 알리고 다시 보여 주는 데만 쓴다 — 서버 세션이 끝났다는 증거도, 초안의 보관소도 아니다.
   * localStorage가 받지 않으면(용량 초과처럼 읽기는 되는데 쓰기만 실패) 같은 기록을 같은 출처의 세션 쿠키에 둔다.
   * 어느 쪽에도 남기지 못해도 새 문서는 열리지 않는다: 저장소에 쓰고 되읽을 수 없는 문서는 unknown으로 시작한다(아래 probe).
   */
  const END_KEY = 'kin-session-end';
  const END_COOKIE = 'kin-session-end';
  const PROBE_KEY = 'kin-session-probe';
  const CHANNEL = 'kin-session';
  // 로그인 콜백이 주소 조각으로 넘기는 일회용 진입 증명의 이름(U5S-REQ-09).
  const ENTRY_MARK = 'kin-entry';
  // 요청 시작부터 응답 본문 판정까지. 넘으면 결과를 모르는 것이고 다시 보내는 것은 사람뿐이다.
  const REQUEST_WAIT_MS = 10000;
  // 페이지가 POST 앞에 끼우는 일(main.html의 점유 해제)의 한도. 그 일이 끝나지 않아도 종료는 막히지 않는다.
  const STEP_WAIT_MS = 5000;
  // 자동 로그인이 세션을 만들지 못하고 되돌아온 탭은 이 시간 안에 다시 자동으로 보내지 않는다(IdP와의 되돌이 고리를 끊는다).
  const AUTO_LOGIN_KEY = 'kin-auto-login';
  const AUTO_LOGIN_GAP_MS = 60000;
  const UNREADABLE = Object.freeze({ unreadable: true });

  let state = 'unknown';
  // unknown의 사유(storage·record·entry) 또는 unconfirmed의 실패 구분.
  let reason = null;
  let sessionId = null;
  let cached = null;
  // 이 문서의 닫힘 상태가 말하는 종료 요청.
  let operation = 0;
  let entered = false;
  let initializing = null;
  // 이 문서가 시작한 종료. 같은 문서의 겹친 Log out·401은 새 POST 없이 이것을 나눈다.
  let ending = null;
  // 페이지가 맡긴, 종료 기록·통지 뒤 POST 앞의 일(main.html의 점유 해제). 이 일이 도는 동안의 겹친 호출은 바로 돌아간다 —
  // 그 일 안의 401이 그 일을 기다리는 종료를 다시 기다리면 자기 자신을 기다리게 된다.
  let step = null;
  let stepping = false;
  // 이 문서의 이동은 한 번뿐이다(진행 중인 이동 위의 두 번째 이동은 첫 이동을 취소한다).
  let moved = false;
  // 페이지가 알린 "지금 이 문서를 떠나면 잃는 것이 있다" 판정(main.html의 저장을 확인하지 못한 판독문 초안).
  let keep = null;
  let retrying = null;
  // 로그인 시작이 결속 거절을 받았다. 다음 누름은 이 브라우저의 지금 세션을 다시 확인한다.
  let rebind = false;
  // 평소의 진입에서 서버가 "이 브라우저에 세션이 없다"고 방금 답했다. 자동 로그인의 유일한 근거다.
  let absent = false;
  // 통지로 들은 종료(세션 식별값별). 신원 확인을 기다리는 문서가 그 답을 받기 직전에 대조한다.
  const heard = new Map();
  const lifecycleListeners = [];
  const endedListeners = [];

  function announce() {
    const event = Object.freeze({ state, session: sessionId });
    for (const listener of [...lifecycleListeners]) { try { listener(event); } catch (e) {} }
  }

  function notifyEnded() {
    for (const listener of [...endedListeners]) { try { listener(); } catch (e) {} }
  }

  /** 종료 기록 하나(저장한 글자 또는 통지에 실린 값)를 읽는다. 없으면 null, 모양이 다르면 UNREADABLE. */
  function endOf(value) {
    if (value === null || value === undefined) return null;
    try {
      if (typeof value === 'string') value = JSON.parse(value);
      if (value && typeof value.session === 'string' && value.session && Number.isFinite(value.operation)
        && CLOSED.includes(value.status))
        return { session: value.session, operation: value.operation, status: value.status,
          reason: END_REASONS.includes(value.reason) ? value.reason : null };
    } catch (e) {}
    return UNREADABLE;
  }

  /** 두 기록 중 나중 것. 같은 요청이면 결과(확인·미확인)가 요청 중(ending)보다 나중이다. */
  function later(a, b) {
    if (!a || !b) return a || b;
    if (a.operation !== b.operation) return a.operation > b.operation ? a : b;
    return a.status === 'ending' ? b : a;
  }

  /** 대체 쿠키의 글자. 없으면 null, 풀 수 없으면 ''(모양이 다른 기록). */
  function cookieEnd() {
    let jar;
    try { jar = document.cookie; } catch (e) { return null; }
    for (const part of jar.split(';')) {
      const at = part.indexOf('=');
      if (at > 0 && part.slice(0, at).trim() === END_COOKIE) {
        try { return decodeURIComponent(part.slice(at + 1).trim()); } catch (e) { return ''; }
      }
    }
    return null;
  }

  function setCookieEnd(text) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    try {
      document.cookie = text === null
        ? `${END_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`
        : `${END_COOKIE}=${encodeURIComponent(text)}; Path=/; SameSite=Strict${secure}`;
    } catch (e) {}
    return cookieEnd() === text;
  }

  /** 남아 있는 종료 기록. 없으면 null, 읽지 못하거나 모양이 다르면 UNREADABLE — 어느 쪽도 사용 중의 근거가 아니다. */
  function readEnd() {
    let text;
    try { text = localStorage.getItem(END_KEY); }
    catch (e) { return UNREADABLE; }
    const stored = endOf(text), mirrored = endOf(cookieEnd());
    if (stored === UNREADABLE || mirrored === UNREADABLE) return UNREADABLE;
    return later(stored, mirrored);
  }

  /** 종료 기록을 남긴다. localStorage에 쓰고 되읽어 확인하며, 남지 않았으면 쿠키에 둔다. 남았는지를 돌려준다. */
  function writeEnd(record) {
    const text = JSON.stringify(record.reason ? record
      : { session: record.session, operation: record.operation, status: record.status });
    try {
      localStorage.setItem(END_KEY, text);
      if (localStorage.getItem(END_KEY) === text) return true;
    } catch (e) {}
    return setCookieEnd(text);
  }

  function removeEnd() {
    try { localStorage.removeItem(END_KEY); } catch (e) {}
    if (cookieEnd() !== null) setCookieEnd(null);
  }

  /**
   * 이 문서가 저장소에 쓰고 되읽을 수 있는가. 쓸 수 없는 저장소의 "기록 없음"은 "종료한 적 없음"이 아니다 — 앞선 문서의
   * 실패한 로그아웃도 같은 저장소에 기록을 남기지 못했을 것이다(Sol U5R2-F01). 기록과 같은 크기의 값을 써 본다: 가득 찬
   * 저장소는 작은 값은 받고 기록은 받지 않을 수 있다.
   */
  function probeStorage() {
    try {
      const mark = `${Date.now()}.${Math.random()}`.padEnd(160, '.');
      localStorage.setItem(PROBE_KEY, mark);
      const kept = localStorage.getItem(PROBE_KEY) === mark;
      localStorage.removeItem(PROBE_KEY);
      return kept && localStorage.getItem(PROBE_KEY) === null;
    } catch (e) {
      return false;
    }
  }

  /**
   * 로그인 콜백이 주소 조각에 실어 준 일회용 진입 증명을 꺼내고 그 조각을 바로 지운다 — 주소 표시줄·방문 기록·복사한 주소에
   * 남지 않게 한다. 증명은 쿠키 없이는 아무것도 열지 못하고, 서버가 한 번만 받는다.
   */
  function takeProof() {
    let found = null;
    try {
      const fragment = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
      if (!fragment.has(ENTRY_MARK)) return null;
      found = fragment.get(ENTRY_MARK) || null;
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch (e) {}
    return found;
  }

  const reliable = probeStorage();
  let proof = takeProof();

  /** 저장소가 말하는 이 문서의 시작 상태. 종료 기록이 있으면 그 상태로 닫혀 있고, 저장소를 믿을 수 없으면 unknown이다. */
  function classify() {
    const record = readEnd();
    if (record === UNREADABLE) {
      state = 'unknown';
      reason = 'record';
    } else if (record) {
      state = record.status;
      reason = record.reason;
      sessionId = record.session;
      operation = record.operation;
    } else if (!reliable) {
      state = 'unknown';
      reason = 'storage';
    }
  }
  if (!proof) classify();

  /** 서버에 물을 수 있는 시작인가: 아직 아무것도 정해지지 않은 unknown뿐이다. */
  function undecided() { return state === 'unknown' && reason === null; }

  /**
   * 이 파일의 요청 하나. 머리글과 본문을 한 한도 안에서 읽고, 서버의 코드(머리글 X-KIN-Auth-Code 또는 본문 code)를 함께
   * 돌려준다. 업무 요청은 session-transport.js가 보낸다 — 여기는 신원 확인·진입·로그인 시작·종료뿐이다.
   */
  async function send(path, { method = 'GET', session = null, json } = {}) {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), REQUEST_WAIT_MS);
    try {
      const headers = { 'X-KIN-CSRF': '1' };
      if (session) headers['X-KIN-Session'] = session;
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${API}${path}`, {
        method, headers, signal: control.signal,
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      let body = null;
      if (response.status !== 204) {
        try { body = await response.json(); }
        catch (e) { if (control.signal.aborted) throw e; }
      }
      const code = response.headers.get('X-KIN-Auth-Code') || (body && typeof body.code === 'string' ? body.code : null);
      return { status: response.status, ok: response.ok, code, body };
    } catch (e) {
      throw Object.assign(new Error(control.signal.aborted ? '서버가 제한 시간 안에 답하지 않았습니다' : '서버에 연결하지 못했습니다'),
        { kind: control.signal.aborted ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  function identityOf(body) {
    return {
      state: 'approved',
      sub: typeof body.sub === 'string' ? body.sub : null,
      actor: body.actor ?? body.user ?? '',
      user: body.user ?? body.actor ?? '',
      displayName: body.displayName ?? body.user ?? body.actor ?? '',
      roles: Array.isArray(body.roles) ? body.roles : [],
      institution: body.institution ?? null,
    };
  }

  /** /api/me의 답을 신원으로 읽는다. 세션 식별값이 없는 답은 신원이 아니다 — 묶을 것이 없는 문서는 일하지 않는다. */
  function readIdentity(answer) {
    const body = answer.body || {};
    const id = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
    if (answer.status === 403 && (body.code === 'INSTITUTION_PENDING' || body.code === 'INSTITUTION_INVALID') && id)
      return { id, identity: { state: body.code === 'INSTITUTION_PENDING' ? 'pending' : 'invalid' } };
    if (answer.status === 403) throw new Error('계정 상태를 확인할 수 없습니다');
    if (answer.status !== 200) throw new Error(`세션 확인 실패 (HTTP ${answer.status})`);
    if (!id) throw new Error('세션 확인 실패 (세션 식별값 없음)');
    return { id, identity: identityOf(body) };
  }

  /**
   * 확인한 신원을 이 문서의 것으로 삼는다 — 삼기 직전에 한 번 더 본다(Sol U5R2-F02). 답을 기다리는 사이 이 문서가 닫혔거나,
   * 그 세션의 종료가 기록되었거나 통지되었으면 그 답은 신원을 만들지 않는다.
   */
  function adopt(id, identity, viaProof) {
    if (!undecided()) return null;
    // 증명으로 들어가는 문서는 저장소를 읽지 못해도 들어간다(서버가 방금의 로그인을 확인했다). 그 밖에는 읽지 못하면 닫힌다.
    const read = readEnd(), record = read === UNREADABLE ? null : read;
    if (read === UNREADABLE && !viaProof) {
      reason = 'record';
      announce();
      return null;
    }
    const ended = record && (record.session === id || !viaProof) ? record : null;
    if (ended || heard.has(id)) {
      state = ended ? ended.status : 'ending';
      reason = ended ? ended.reason : null;
      sessionId = ended ? ended.session : id;
      operation = ended ? ended.operation : heard.get(id);
      announce();
      return null;
    }
    // 명시적 로그인이 성공했고 그 세션에 묶인 신원 확인까지 끝났다. 앞선 세션의 종료 기록은 여기서만 지운다.
    if (viaProof && record) removeEnd();
    tab.remove(AUTO_LOGIN_KEY);
    cached = identity;
    sessionId = id;
    state = 'active';
    announce();
    return cached;
  }

  /**
   * 종료 기록 없는 평소의 진입: 쿠키의 세션을 서버에 한 번 묻는다. 세션 식별값 없이 보내는 인증 요청은 이 문서에서 이것
   * 하나다(U5S-REQ-09) — 그 뒤의 모든 요청은 여기서 받은 식별값을 싣는다.
   */
  async function bootstrap() {
    const answer = await send('/me');
    if (!undecided()) return null;
    // 세션이 없다고 서버가 답했다. 종료 기록도 없고 저장소도 믿을 수 있는 문서이므로(undecided) 페이지가 자동 로그인을
    // 시작할 수 있다(autoLogin). 5xx·시간 초과·읽을 수 없는 답은 "세션 없음"이 아니라 확인 실패다 — 아래에서 던진다.
    if (answer.status === 401) {
      absent = true;
      return null;
    }
    const { id, identity } = readIdentity(answer);
    return adopt(id, identity, false);
  }

  /**
   * 명시적 로그인을 마친 문서의 진입: 증명을 서버에 한 번 내고(쓰면 사라진다), 받은 세션 식별값에 묶어 신원을 확인한다.
   * 저장소를 쓸 수 없거나 앞선 종료 기록이 남아 있어도 이 길로는 들어간다 — 서버가 방금의 로그인을 확인했기 때문이다.
   * 거절된 증명(다른 세션·만료·재사용)은 아무것도 열지 않는다.
   */
  async function enterWithProof() {
    const offered = proof;
    proof = null;
    let entry;
    try { entry = await send('/auth/entry', { method: 'POST', json: { proof: offered } }); }
    catch (e) { entry = null; }
    const id = entry && entry.status === 200 && entry.body && typeof entry.body.sessionId === 'string' && entry.body.sessionId
      ? entry.body.sessionId : null;
    let found = null;
    if (id) {
      try {
        const answer = await send('/me', { session: id });
        const read = readIdentity(answer);
        if (read.id === id) found = read;
      } catch (e) {}
    }
    if (!undecided()) return null;
    if (!found) {
      classify();
      if (undecided()) reason = 'entry';
      announce();
      return null;
    }
    return adopt(found.id, found.identity, true);
  }

  async function enter() {
    if (tab.get('kin-demo')) {
      cached = {
        state: 'approved', demo: true, user: 'demo', actor: 'demo', displayName: 'demo',
        roles: ['radiologist', 'technician', 'admin'], institution: 'demo',
      };
      sessionId = 'demo';
      state = 'active';
      reason = null;
      announce();
      return cached;
    }
    // 종료가 기록된 동안, 또는 저장소를 믿을 수 없는 동안에는 남은 서버 세션으로 업무에 들어가지 않는다. 어느 문서든 같다 —
    // 랜딩이 상태를 보이고, 다시 들어가는 길은 사용자의 명시적 로그인뿐이다.
    const result = proof ? await enterWithProof() : undecided() ? await bootstrap() : null;
    // 답을 기다리는 사이 이 문서가 이동을 시작했으면 기다리던 쪽(boot)이 두 번째 이동을 하지 않게 끝나지 않는 약속을 준다.
    if (moved) return new Promise(() => {});
    return result;
  }

  /**
   * S5-U2a 첫 화면. 업무 역할이 clinician뿐인 세션은 main.html(Radiology/Technician 탭)이 아니라 clinician.html로 간다.
   * 판정은 guard의 clinician-only 게이트(api/src/clinician-policy.ts clinicianOnly)와 같은 규칙이다 — clinician이 있고
   * 기존 세 역할이 하나도 없음. Keycloak 기본 역할은 보지 않는다. 어느 페이지를 여는지만 정할 뿐 권한이 아니다:
   * 두 페이지의 모든 요청은 서버가 역할·기관을 다시 판정한다.
   */
  const LEGACY_ROLES = ['radiologist', 'technician', 'admin'];
  function home(session) {
    const roles = session && session.state === 'approved' && !session.demo && Array.isArray(session.roles) ? session.roles : [];
    return roles.includes('clinician') && !roles.some(role => LEGACY_ROLES.includes(role)) ? 'clinician.html' : 'main.html';
  }

  /**
   * OIDC 콜백(api/src/auth.controller.ts)은 모든 로그인을 main.html로 돌려보낸다. clinician-only 세션이 그 페이지의
   * 작업을 시작하지 않도록 main.html에서만 clinician.html로 옮기고, 옮기는 동안 init()을 끝내지 않는다 —
   * main.html의 boot는 `await KinAuth.init()` 다음 줄로 넘어가지 않는다.
   */
  function land(session) {
    if (!/\/main\.html$/.test(location.pathname) || home(session) !== 'clinician.html') return session;
    location.replace('clinician.html');
    return new Promise(() => {});
  }

  function leave() {
    if (moved || (keep && keep())) return;
    moved = true;
    location.replace(location.origin + location.pathname.replace(/[^/]*$/, 'index.html'));
  }

  /** 이 문서를 닫는다: 신원을 내려놓고 상태를 알린다. 이후 session()·has()는 이전 신원을 주지 않는다. */
  function closeHere(next, why, op) {
    state = next;
    reason = why ?? null;
    if (op !== undefined) operation = op;
    cached = null;
    entered = true;
    announce();
  }

  function nextOperation() {
    const last = readEnd();
    return Math.max(Date.now(), operation + 1, (last && last !== UNREADABLE ? last.operation : 0) + 1);
  }

  /** 종료를 시작한 문서가 같은 세션의 다른 문서에 한 번 알린다. 화면을 닫으라는 뜻이지 서버 종료의 증거가 아니다. */
  function tell(session, op) {
    try {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage({ type: 'session-ended', session, operation: op, status: 'ending' });
      channel.close();
    } catch (e) {}
  }

  /**
   * 서버 응답만이 종료를 확인한다(코드로 읽는다 — 문구는 안내문이다). 204와 "그 세션은 끝났다"(AUTH_SESSION_ENDED)만 종료
   * 확인이다. 결속 불일치(AUTH_SESSION_MISMATCH)는 이 브라우저의 쿠키가 다른 로그인의 것이라는 뜻이다 — 그 로그인을 끝내지
   * 않고 이 문서만 닫힌 채 남는다. 나머지는 실패 구분과 함께 종료 미확인이다.
   */
  async function post(session) {
    let answer;
    try { answer = await send('/auth/logout', { method: 'POST', session }); }
    catch (e) { return { state: 'unconfirmed', reason: e.kind === 'timeout' ? 'timeout' : 'network' }; }
    if (answer.status === 204 || (answer.status === 401 && answer.code === 'AUTH_SESSION_ENDED'))
      return { state: 'confirmed', reason: null };
    if (answer.code === 'AUTH_SESSION_MISMATCH') return { state: 'unconfirmed', reason: 'replaced' };
    if (answer.status === 401 && answer.code === 'AUTH_CREDENTIALS_MISSING') return { state: 'unconfirmed', reason: 'credentials' };
    if (answer.status === 409) return { state: 'unconfirmed', reason: 'conflict' };
    if (answer.status === 500 && answer.code === 'AUTH_STORAGE_FAILURE') return { state: 'unconfirmed', reason: 'storage' };
    return { state: 'unconfirmed', reason: 'refused' };
  }

  /**
   * 종료 요청 하나의 결과를 남긴다. 그사이 더 새 요청(Retry)이나 명시적 로그인이 기록을 넘겨받았으면 늦은 결과로 덮지
   * 않는다. 쿠키가 다른 로그인의 것이면 이 세션은 이 브라우저의 새 문서가 다시 쓸 수 없으므로 그 기록은 치운다 — 남겨 두면
   * 그 로그인의 새 문서까지 막는다.
   */
  async function conclude(session, op) {
    const result = await post(session);
    const current = readEnd();
    if (current && current !== UNREADABLE && current.session === session && current.operation === op) {
      if (result.reason === 'replaced') removeEnd();
      else writeEnd({ session, operation: op, status: result.state, reason: result.reason });
    }
    if (sessionId === session && operation === op && CLOSED.includes(state)) {
      state = result.state;
      reason = result.reason;
      announce();
    }
    return result;
  }

  /**
   * 다른 곳에서 이 문서의 세션이 끝났다(다른 문서의 종료 기록·통지, 요청의 답이 알려 준 세션 종료). 이 문서를 닫고 페이지에
   * 한 번 알린다. 새 POST도 다시 알림도 없다 — 이동은 페이지의 조정자가 한다.
   */
  function endedElsewhere(next, why, op) {
    closeHere(next, why, op);
    notifyEnded();
  }

  /**
   * 종료 기록을 다시 읽는다(storage 알림, 창 초점·탭 표시·뒤로 가기 복원). 일하는 문서는 자기 세션의 기록에만 닫힌다 — 다른
   * 세션의 기록은 그 문서들의 일이고, 읽을 수 없게 된 저장소는 종료 신호가 아니다(저장소 오류로 의사의 화면을 닫지 않는다;
   * 그 세션이 정말 끝났으면 다음 요청의 답이 말한다). 아직 들어가지 않은 문서와 닫힌 문서(랜딩)는 가장 나중의 기록을
   * 따르되, 기록이 지워진 것(다른 탭의 명시적 로그인)으로 다시 열리지 않는다.
   */
  function recheck() {
    const record = readEnd();
    if (state === 'active') {
      if (record && record !== UNREADABLE && record.session === sessionId)
        endedElsewhere(record.status, record.reason, record.operation);
      return;
    }
    if (!record || record === UNREADABLE) return;
    if (CLOSED.includes(state)) {
      // 이 문서가 이미 아는 것보다 나중의 기록만 따른다.
      if (record.operation === operation && record.status === state && record.session === sessionId) return;
      if (later({ operation, status: state }, record) !== record) return;
    } else if (!undecided()) {
      // 사유가 있는 unknown(저장소·진입 실패)은 기록이 생겨도 명시적 로그인만 받는다.
      return;
    }
    state = record.status;
    reason = record.reason;
    sessionId = record.session;
    operation = record.operation;
    announce();
    notifyEnded();
  }

  function noticed(data) {
    // 세션을 밝히지 않은 통지는 아무것도 닫지 않는다 — 어느 로그인의 종료인지 모르는 소식으로 지금 세션을 끝내지 않는다.
    if (!data || data.type !== 'session-ended' || typeof data.session !== 'string' || !data.session) return;
    heard.set(data.session, Number.isFinite(data.operation) ? data.operation : 0);
    if (state === 'active') {
      if (data.session !== sessionId) return;
      const record = readEnd();
      if (record && record !== UNREADABLE && record.session === sessionId)
        endedElsewhere(record.status, record.reason, record.operation);
      else endedElsewhere('ending', null, heard.get(data.session));
      return;
    }
    recheck();
  }
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = event => noticed(event.data);
  } catch (e) {}
  addEventListener('storage', event => { if (event.key === END_KEY || event.key === null) recheck(); });
  // 통지가 오지 않는 길(BroadcastChannel이 없고 종료 기록이 쿠키에만 남은 경우)에도 사람이 이 문서로 돌아오는 순간(창 초점,
  // 탭 표시, 뒤로 가기 캐시 복원) 기록을 다시 본다 — 신원 확인을 기다리는 중이어도 같다.
  addEventListener('focus', recheck);
  addEventListener('pageshow', event => { if (event.persisted) recheck(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });

  /**
   * 로그인·가입 시작(U5S-REQ-09). 누르는 것만으로는 종료 기록을 지우지도 업무를 열지도 않는다 — 그것은 성공한 로그인의 진입
   * 증명이 한다. 이 브라우저에 세션이 남아 있으면 그 세션을 밝혀 POST로 시작한다: 서버가 그 세션을 감사와 함께 끝낸 뒤
   * 로그인 주소를 준다. 밝힌 세션이 쿠키의 세션과 다르면(그사이 다른 로그인) 서버는 아무것도 끝내지 않고 거절하며, 다음
   * 누름이 지금 세션을 다시 확인한다. 남은 세션이 없으면 평범한 링크로 간다.
   */
  async function initiate(path, json, query) {
    let binding = rebind ? null : sessionId;
    if (!binding) {
      // 명시적 로그인을 위한 한 번의 확인: 이 POST가 대신할 세션이 무엇인지 알 뿐, 이 문서의 신원으로 삼지 않는다.
      const answer = await send('/me');
      const id = answer.body && typeof answer.body.sessionId === 'string' ? answer.body.sessionId : null;
      binding = (answer.status === 200 || answer.status === 403) && id ? id : null;
    }
    if (binding) {
      const answer = await send(path, { method: 'POST', session: binding, ...(json === undefined ? {} : { json }) });
      const target = answer.status === 200 && answer.body && typeof answer.body.location === 'string' ? answer.body.location : null;
      if (target && new URL(target, location.origin).origin === location.origin) {
        location.href = target;
        return;
      }
      if (answer.code === 'AUTH_SESSION_MISMATCH' || answer.code === 'AUTH_SESSION_REQUIRED') {
        rebind = true;
        throw new Error('이 브라우저의 로그인 세션이 바뀌어 로그인을 시작하지 않았습니다. 버튼을 다시 눌러 주세요.');
      }
      if (answer.status !== 401) {
        throw new Error(answer.status === 409 ? '다른 요청과 겹쳐 로그인을 시작하지 못했습니다. 버튼을 다시 눌러 주세요.'
          : '로그인을 시작하지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
      }
      // 401: 밝힌 세션은 이미 없다 — 대신할 세션이 없으므로 평범한 링크로 간다.
    }
    location.href = `${API}${path}${query}`;
  }

  /**
   * 서버가 확인한 세션 교체: 이 브라우저의 쿠키가 다른 로그인의 것이 되었다(결속 불일치, 또는 이 세션에 묶어 보낸 요청에
   * 다른 계정의 답이 왔다). 이 문서만 닫는다 — 종료 기록도 로그아웃 POST도 없다. 그 POST는 다른 로그인의 세션을 겨눌
   * 뿐이고, 기록은 그 로그인의 새 문서까지 막는다. 같은 세션의 다른 문서에는 한 번 알린다(그 문서들도 쓸 수 없는 세션이다).
   */
  function closeReplaced() {
    const session = sessionId, op = nextOperation();
    tell(session, op);
    endedElsewhere('unconfirmed', 'replaced', op);
  }

  return {
    KC,

    async init() {
      if (entered) return cached;
      if (!initializing) {
        initializing = enter()
          .then(result => { entered = true; return result; })
          .then(land)
          .finally(() => { initializing = null; });
      }
      return initializing;
    },

    session() { return cached; },

    /** 이 문서가 묶인 세션의 식별값(비밀이 아니다). 일하는 중이 아니면 null. */
    sessionId() { return state === 'active' ? sessionId : null; },

    home(session = cached) { return home(session); },

    has(role) {
      const session = cached;
      if (!session || session.state !== 'approved') return false;
      if (session.demo) return true;
      return session.roles.includes(role) || session.roles.includes('admin');
    },

    /** 이 문서의 세션 상태와 묶인 세션. work-context.js가 이것을 따라 업무 문맥을 연다·닫는다. */
    lifecycle() { return Object.freeze({ state, session: sessionId }); },

    /** 지금 상태를 한 번 알리고, 그 뒤의 전이를 일어나는 그 자리에서(동기로) 알린다. */
    onLifecycle(listener) {
      if (typeof listener !== 'function') return;
      lifecycleListeners.push(listener);
      try { listener(Object.freeze({ state, session: sessionId })); } catch (e) {}
    },

    /**
     * 랜딩이 먼저 보는 닫힘 상태: null(막는 것이 없다 — 일하는 중이거나 서버에 물어도 된다), ending·unconfirmed·confirmed
     * (실패 구분과 함께), 또는 unknown(사유: storage·record·entry).
     */
    endState() {
      if (state !== 'active') recheck();
      if (CLOSED.includes(state) || (state === 'unknown' && reason)) return { state, reason };
      return null;
    },

    async login(opts = {}) {
      const prompt = opts.prompt ? String(opts.prompt) : '';
      return initiate('/auth/login', prompt ? { prompt } : {}, prompt ? `?prompt=${encodeURIComponent(prompt)}` : '');
    },

    async register() {
      return initiate('/auth/register', undefined, '');
    },

    /**
     * 평소의 진입에서 세션이 없을 때 스스로 로그인 화면으로 보낸다 — 의사가 로그인 단추를 한 번 더 누르게 하지 않는다.
     * 근거는 하나뿐이다: 저장소를 믿을 수 있고 종료 기록이 없는 문서에서 서버가 방금 "세션 없음"(401)이라고 답했다.
     * 종료 기록이 있거나(명시적 로그아웃·미확인 종료), 저장소를 믿을 수 없거나, 확인이 실패했으면(5xx·시간 초과·진입 증명
     * 거절) 시작하지 않는다 — 그때는 랜딩이 사정을 보이고 사람이 누른다. 방금의 자동 로그인이 세션 없이 되돌아온 탭도 다시
     * 보내지 않는다. 시작했으면 true다(부른 쪽은 그 뒤 화면을 그리지 않는다).
     */
    autoLogin() {
      if (!absent || !undecided() || moved) return false;
      const last = Number(tab.get(AUTO_LOGIN_KEY));
      if (last > 0 && Date.now() - last < AUTO_LOGIN_GAP_MS) return false;
      tab.set(AUTO_LOGIN_KEY, String(Date.now()));
      moved = true;
      location.href = `${API}/auth/login`;
      return true;
    },

    demo() {
      [...LEGACY_KEYS, 'kin-demo'].forEach(key => tab.remove(key));
      tab.set('kin-demo', '1');
      entered = false;
    },

    /**
     * 업무 화면의 Log out — 이 세션에 묶인 명시적 종료 의도다. 네트워크를 기다리기 전에 종료 기록을 남기고 이 문서의 신원을
     * 내려놓으며 같은 세션의 다른 문서에 한 번 알린다. 페이지가 맡긴 일(beforeLogoutPost)을 한도 안에서 기다린 뒤 이 세션을
     * 밝힌 POST 하나를 보내고, 서버의 답(KIN 세션 폐기의 확인)을 기록하는 대로 랜딩으로 한 번 옮긴다 — 그 뒤의 IdP 처리는
     * 서버의 일이고 이 문서는 기다리지 않는다. 같은 문서의 겹친 호출은 새 POST 없이 진행 중인 종료를 나눈다. 일하는 중이
     * 아닌 문서(이미 닫혔다, 들어간 적 없다)와 다른 문서가 이 세션의 종료를 이미 기록한 문서는 POST 없이 떠난다 — 다시
     * 보내는 것은 랜딩의 Retry Log Out뿐이다. 데모는 서버 세션이 없어 로컬만 끝낸다.
     */
    async logout() {
      if (ending) return stepping ? undefined : ending;
      if (tab.get('kin-demo')) {
        [...LEGACY_KEYS, 'kin-demo'].forEach(key => tab.remove(key));
        closeHere('unknown', null);
        leave();
        return;
      }
      if (state === 'active') recheck();
      if (state !== 'active') {
        cached = null;
        leave();
        return;
      }
      const session = sessionId, op = nextOperation();
      writeEnd({ session, operation: op, status: 'ending' });
      closeHere('ending', null, op);
      tell(session, op);
      ending = (async () => {
        if (step) {
          stepping = true;
          let timer;
          try {
            await Promise.race([
              Promise.resolve().then(() => step(session)).catch(() => {}),
              new Promise(resolve => { timer = setTimeout(resolve, STEP_WAIT_MS); }),
            ]);
          } finally {
            clearTimeout(timer);
            stepping = false;
          }
        }
        await conclude(session, op);
        leave();
      })();
      return ending;
    },

    /**
     * 요청의 답이 알려 준 세션 종료 신호(session-transport.js가 그 요청이 실은 세션과 함께 넘긴다). 이 문서의 지금 세션이
     * 아닌 신호는 아무것도 하지 않는다 — 이전 세션의 늦은 답이 지금 세션을 끝내지 못한다. 서버가 "그 세션은 끝났다"
     * (AUTH_SESSION_ENDED)고 답했으면 POST 없이 종료 확인으로 닫고, 결속 불일치(AUTH_SESSION_MISMATCH)는 세션 교체로
     * 닫는다. 그 밖의 것은 여기서 아무것도 닫지 않는다: 코드 없는 401, 자격 없음, 결속 누락(428), 403·409·5xx는 그 요청
     * 하나의 실패이고 종료의 증거가 아니다 — 쿠키도 기록도 건드리지 않는다.
     */
    authFailure(failure) {
      if (!failure || state !== 'active' || failure.session !== sessionId) return;
      // 데모에는 끝낼 서버 세션이 없다 — 서버 없는 둘러보기의 거절은 세션 사건이 아니다.
      if (cached && cached.demo) return;
      if (failure.code === 'AUTH_SESSION_ENDED') {
        const session = sessionId, op = nextOperation();
        writeEnd({ session, operation: op, status: 'confirmed' });
        tell(session, op);
        endedElsewhere('confirmed', null, op);
      } else if (failure.code === 'AUTH_SESSION_MISMATCH') {
        closeReplaced();
      }
    },

    /**
     * 이 세션에 묶어 보낸 요청에 다른 계정의 답이 왔다(목록의 주인, 초안 작성자 대조의 거절). 서버가 확인한 세션 교체와
     * 같게 이 문서만 닫는다. 페이지가 그 요청이 실은 세션과 함께 알린다 — 지금 세션의 것이 아니면 아무것도 하지 않는다.
     */
    replaced(failure) {
      if (!failure || state !== 'active' || failure.session !== sessionId) return;
      if (cached && cached.demo) return;
      closeReplaced();
    },

    /**
     * 로그아웃 준비의 시작('preparing')과 취소('resumed')를 이 세션의 뷰어 문서(판독 창의 iframe, 따로 연 영상 창)에
     * 알린다. 준비는 종료가 아니다 — 뷰어는 닫히지 않고 멈춰 있다가 취소되면 보던 그대로 이어 간다. 세션 식별값과 준비
     * 번호를 함께 싣는다: 받는 쪽은 자기 세션의 것만 따르고 지난 준비의 늦은 재개는 버린다. auth.js를 싣는 문서(다른 탭의
     * 업무 화면)는 이 신호를 따르지 않는다 — 그 문서의 일은 그 문서의 관문이 정한다. 실제 종료는 따로 알린다(session-ended).
     */
    notifyPreparation(status, preparation) {
      if (state !== 'active' || !sessionId || (status !== 'preparing' && status !== 'resumed')) return;
      try {
        const channel = new BroadcastChannel(CHANNEL);
        channel.postMessage({ type: 'session-' + status, session: sessionId, preparation });
        channel.close();
      } catch (e) {}
    },

    /** 이 문서가 시작하는 종료마다 종료 기록·통지 뒤, POST 앞에 한도 안에서 기다릴 일(실패해도 종료는 막히지 않는다). */
    beforeLogoutPost(work) { step = typeof work === 'function' ? work : null; },

    /** 랜딩의 Retry Log Out: 누를 때마다 기록된 세션을 밝힌 POST 하나(누르는 동안의 겹친 호출은 나눈다). 이동하지 않는다. */
    retryLogout() {
      if (retrying) return retrying;
      if (!CLOSED.includes(state) || !sessionId) return Promise.resolve(null);
      const session = sessionId, op = nextOperation();
      writeEnd({ session, operation: op, status: 'ending' });
      state = 'ending';
      reason = null;
      operation = op;
      announce();
      retrying = conclude(session, op).finally(() => { retrying = null; });
      return retrying;
    },

    /** 이 문서의 세션이 다른 곳에서 끝난 것을 알게 되면 한 번 부른다(신원은 이미 내려놓았다). 랜딩에는 기록이 바뀔 때 부른다. */
    onEndedElsewhere(listener) {
      if (typeof listener === 'function') endedListeners.push(listener);
    },

    /**
     * 닫힌 문서의 Recover Draft를 위한 한 번의 확인: 사람이 누를 때마다 이 브라우저의 지금 세션이 누구의 것인지 읽는다.
     * 이 문서의 신원으로 삼지 않고 업무를 열지 않는다 — 돌려준 식별값은 그 복구 요청 하나의 결속으로만 쓴다.
     */
    async recoveryBinding() {
      let answer;
      try { answer = await send('/me'); }
      catch (e) { return { status: 'unreachable' }; }
      if (answer.status === 401) return { status: 'none' };
      const body = answer.body || {};
      if (answer.status !== 200 || typeof body.sessionId !== 'string' || !body.sessionId) return { status: 'unavailable' };
      return { status: 'ok', session: body.sessionId, roles: Array.isArray(body.roles) ? body.roles : [],
        owner: { institution: body.institution ?? null, sub: typeof body.sub === 'string' ? body.sub : null,
          author: body.actor ?? body.user ?? '' } };
    },

    /**
     * 판정이 참인 동안(이 문서를 떠나면 잃는 것이 있는 동안) 종료 뒤의 이동을 미룬다. 종료 기록·신원 해제·통지·POST는
     * 미루지 않는다. 판정이 거짓이 된 뒤 페이지가 leave()로 미룬 이동을 한다.
     */
    holdLeave(test) { keep = typeof test === 'function' ? test : null; },

    leave() { leave(); },
  };
})();
