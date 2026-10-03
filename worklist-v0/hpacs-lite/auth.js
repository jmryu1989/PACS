/** KIN 인증 — 브라우저에는 HttpOnly 세션 쿠키만 둔다. */
const KinAuth = (() => {
  const API = `${location.origin}/api`;
  const KC = `${location.origin}/auth`;
  const S = sessionStorage;
  const LEGACY_KEYS = [
    'kin-at', 'kin-rt', 'kin-it', 'kin-exp', 'kin-verifier', 'kin-state', 'kin-user', 'kin-roles',
  ];

  // 배포 전부터 열려 있던 탭은 코드가 바뀌어도 저장된 토큰이 남는다. 모듈이 로드되는
  // 모든 탭에서 한 번 지워야 "새 코드는 안 쓴다"가 아니라 실제 토큰 부재가 된다.
  LEGACY_KEYS.forEach(key => S.removeItem(key));
  document.cookie = 'kin_at=; Path=/; Max-Age=0; Secure; SameSite=Strict';

  let cached = null;
  let initialized = false;
  let initializing = null;

  /**
   * 로그아웃의 브라우저 쪽 상태(S7-U5). 이 화면의 사용을 끝내는 것과 서버가 세션 종료를 확인한 것은 다르다: 기록이 없으면
   * 사용 중이고, 있으면 종료 요청 중(ending)·종료 미확인(unconfirmed)·종료 확인(confirmed)이다. 같은 출처의 모든 문서가 읽는
   * localStorage에 두어 새로고침·뒤로 가기·나중에 연 탭도 같은 상태를 본다 — 탭 범위면 나중에 연 탭이 남은 서버 세션으로
   * 들어간다. 담는 것은 상태·요청 순서·실패 구분뿐이고 sid·토큰·쿠키·계정·기관·환자 값은 담지 않는다. 지우는 것은 사용자의
   * 명시적 로그인·가입뿐이라 종료 확인도 그때까지 남는다.
   */
  const END_KEY = 'kin-session-end';
  /**
   * 종료 기록을 localStorage에 쓰지 못할 때(용량 초과처럼 읽기는 되는데 쓰기만 실패할 때)의 대체 자리(Astra S7-U5-R-001-F01).
   * 기록이 없으면 사용 중으로 읽히므로, 쓰기 실패를 그냥 넘기면 로그아웃하지 못한 서버 세션으로 랜딩이 자동 진입한다. 같은
   * 비밀 없는 기록을 같은 출처의 쿠키에 둔다 — 새로고침·문서 이동·다른 탭이 모두 읽는다. kin_sid처럼 세션 쿠키라 그 세션
   * 쿠키보다 오래 남지 않는다. 둘 다 남기지 못한 기록은 이 문서의 메모리(unkept)에만 있고, 떠날 때 랜딩 주소에 상태만 싣는다.
   */
  const END_COOKIE = 'kin-session-end';
  const END_CHANNEL = 'kin-session-end';
  const END_STATES = ['ending', 'unconfirmed', 'confirmed'];
  const END_REASONS = ['conflict', 'storage', 'network', 'timeout', 'refused', 'credentials'];
  // 서버가 이 요청의 세션(sid)을 찾아 본 뒤 그 세션이 없거나 끝났다고 답하는 401 문구(auth.service.ts의 문장 그대로): 세션 행
  // 없음, commit된 idle 종료, commit된 refresh 실패 종료. 이것만 종료 확인이다.
  const SESSION_ENDED = ['인증 세션이 없습니다', '인증 세션이 만료되었습니다', '인증 세션을 갱신할 수 없습니다'];
  // 요청에 세션 쿠키가 없다는 일반 401(auth.guard.ts). 서버는 어떤 세션도 찾아보지 않았다 — 쿠키만 빠졌고 서버의 세션 행은
  // 남아 있을 수 있으므로 종료 확인이 아니다(Astra S7-U5-SPEC-C-F03). 토큰 검증 실패·설정 오류의 401과 403도 세션 종료를
  // 증명하지 않는다.
  const NO_CREDENTIALS = '인증 정보가 없습니다';
  // 요청 시작부터 응답 본문 판정까지. 넘으면 종료 미확인이고 다시 보내는 것은 랜딩의 Retry Log Out뿐이다.
  const LOGOUT_WAIT_MS = 10000;
  // 페이지가 POST 앞에 끼우는 일(main.html의 점유 해제)의 한도. 그 일이 끝나지 않아도 종료는 막히지 않는다.
  const STEP_WAIT_MS = 5000;

  // 신원 세대. 이 문서에 종료가 닿을 때마다 넘겨, 그 전에 나간 /api/me의 늦은 답이 신원을 되살리지 못하게 한다.
  let generation = 0;
  // 이 문서의 사용이 끝났다(스스로 종료를 시작했거나 다른 문서의 종료를 받았다). 그 뒤의 401·계정 변경은 새 의도가 아니다.
  let closed = false;
  // 이 문서가 시작한 종료. 같은 문서의 겹친 Log out·401은 새 POST 없이 이것을 나눈다.
  let ending = null;
  // 페이지가 맡긴, 종료 기록·통지 뒤 POST 앞의 일(main.html의 점유 해제). 이 일이 도는 동안의 겹친 호출은 바로 돌아간다 —
  // 그 일 안의 401이 그 일을 기다리는 종료를 다시 기다리면 자기 자신을 기다리게 된다.
  let step = null;
  let stepping = false;
  // 이 문서의 이동은 한 번뿐이다(진행 중인 이동 위의 두 번째 이동은 첫 이동을 취소한다).
  let moved = false;
  // 페이지가 알린 "지금 이 문서를 떠나면 잃는 것이 있다" 판정(main.html의 저장을 확인하지 못한 판독문 초안, 조항 8-e).
  let keep = null;
  // 이 문서가 쓰거나 다른 문서의 통지로 받았지만 어느 저장소(localStorage·쿠키)에도 남지 않은 종료 기록.
  let unkept = null;
  const endedListeners = [];

  function broadcastEnded() {
    try {
      const channel = new BroadcastChannel('kin-session');
      channel.postMessage({ type: 'session-ended' });
      channel.close();
    } catch (e) {}
    try {
      localStorage.setItem('kin-session-ended', String(Date.now()));
      localStorage.removeItem('kin-session-ended');
    } catch (e) {}
  }

  /** 이 문서의 공개 신원을 내려놓는다. 이후 session()·has()는 이전 신원을 주지 않는다. */
  function dropIdentity() {
    cached = null;
    initialized = true;
    generation++;
  }

  function clearLocal() {
    [...LEGACY_KEYS, 'kin-demo'].forEach(key => S.removeItem(key));
    document.cookie = 'kin_at=; Path=/; Max-Age=0; Secure; SameSite=Strict';
    dropIdentity();
    broadcastEnded();
  }

  const UNKNOWN_END = () => ({ state: 'unknown', order: 0, reason: null });

  /** 종료 기록 하나(저장한 글자 또는 통지에 실린 값)를 읽는다. 없으면 null, 모양이 다르면 'unknown'. */
  function endOf(value) {
    if (value === null || value === undefined) return null;
    try {
      if (typeof value === 'string') value = JSON.parse(value);
      if (value && END_STATES.includes(value.state) && Number.isFinite(value.order))
        return { state: value.state, order: value.order, reason: END_REASONS.includes(value.reason) ? value.reason : null };
    } catch (e) {}
    return UNKNOWN_END();
  }

  /** 두 기록 중 나중 것. 같은 요청(순서)이면 결과(확인·미확인)가 요청 중(ending)보다 나중이다. */
  function later(a, b) {
    if (!a || !b) return a || b;
    if (a.order !== b.order) return a.order > b.order ? a : b;
    return a.state === 'ending' ? b : a;
  }

  /** 대체 쿠키의 글자. 없으면 null, 풀 수 없으면 ''(모양이 다른 기록 — 사용 중의 근거가 아니다). */
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

  /** 저장소(localStorage와 그 대체 쿠키)에 남은 기록. 없으면 null, 읽지 못하거나 모양이 다르면 'unknown'. */
  function storedEnd() {
    let text;
    try { text = localStorage.getItem(END_KEY); }
    catch (e) { return UNKNOWN_END(); }
    const stored = endOf(text), mirrored = endOf(cookieEnd());
    if (stored?.state === 'unknown' || mirrored?.state === 'unknown') return UNKNOWN_END();
    return later(stored, mirrored);
  }

  /**
   * 기록을 어디에도 남기지 못하고 떠난 문서가 랜딩 주소에 실어 보낸 상태(leave). 상태·순서·실패 구분뿐이고 이 주소를 다시
   * 읽는 새로고침에도 같다. 저장소의 기록이 있으면 그것이 먼저다.
   */
  function markedEnd() {
    const query = new URLSearchParams(location.search);
    const end = endOf({ state: query.get('end'), order: Number(query.get('order') ?? 0), reason: query.get('reason') });
    return end && end.state !== 'unknown' ? end : null;
  }

  /** 기록된 종료 상태. 기록이 없으면 null, 읽지 못하거나 모양이 다르면 'unknown' — 어느 쪽도 사용 중의 근거가 아니다. */
  function readEnd() {
    const stored = storedEnd();
    if (stored?.state === 'unknown') return stored;
    const end = later(stored, unkept) || markedEnd();
    return end && { ...end };
  }

  /**
   * 종료 기록을 남긴다. localStorage에 쓰고 다시 읽어 확인하며, 남지 않았으면 쿠키에 둔다. 둘 다 남지 않으면 이 문서가
   * 기억해 두고(unkept) 떠날 때 주소로 넘긴다 — 쓰기 실패를 "기록 없음(사용 중)"으로 두지 않는다(F01).
   *
   * localStorage가 받지 못한 기록은 그 storage 알림도 다른 문서에 가지 않으므로, 같은 기록을 종료 기록 전용 채널로 보낸다.
   * 기존 종료 통지(kin-session의 session-ended와 kin-session-ended 한 쌍)와는 다른 채널이다 — 비밀 없는 종료 기록과 화면을
   * 닫으라는 통지는 구분한다(조항 2). 기록이 localStorage에 남는 평소에는 보내지 않는다.
   */
  function writeEnd(state, order, reason) {
    const record = reason ? { state, order, reason } : { state, order };
    const text = JSON.stringify(record);
    let kept = false;
    try {
      localStorage.setItem(END_KEY, text);
      kept = localStorage.getItem(END_KEY) === text;
    } catch (e) {}
    if (kept) {
      unkept = null;
      return;
    }
    unkept = setCookieEnd(text) ? null : { state, order, reason: reason ?? null };
    try {
      const channel = new BroadcastChannel(END_CHANNEL);
      channel.postMessage(record);
      channel.close();
    } catch (e) {}
  }

  function forgetEnd() {
    unkept = null;
    try { localStorage.removeItem(END_KEY); } catch (e) {}
    if (cookieEnd() !== null) setCookieEnd(null);
  }

  function nextOrder() {
    const last = readEnd();
    return Math.max(Date.now(), (last ? last.order : 0) + 1);
  }

  /** 서버 응답만이 종료를 확인한다. 204와 식별한 세션의 부재·종료 401만 종료 확인이고, 나머지는 실패 구분과 함께 종료 미확인이다. */
  async function post() {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), LOGOUT_WAIT_MS);
    try {
      const response = await fetch(`${API}/auth/logout`, {
        method: 'POST',
        headers: { 'X-KIN-CSRF': '1' },
        signal: control.signal,
      });
      if (response.status === 204) return { state: 'confirmed', reason: null };
      let body = null;
      try { body = await response.json(); }
      catch (e) { if (control.signal.aborted) return { state: 'unconfirmed', reason: 'timeout' }; }
      if (response.status === 401 && SESSION_ENDED.includes(body?.message)) return { state: 'confirmed', reason: null };
      if (response.status === 401 && body?.message === NO_CREDENTIALS) return { state: 'unconfirmed', reason: 'credentials' };
      if (response.status === 409) return { state: 'unconfirmed', reason: 'conflict' };
      if (response.status === 500 && body?.code === 'AUTH_STORAGE_FAILURE') return { state: 'unconfirmed', reason: 'storage' };
      return { state: 'unconfirmed', reason: 'refused' };
    } catch (e) {
      return { state: 'unconfirmed', reason: control.signal.aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 종료 요청 하나. 그사이 더 새 요청(Retry)이나 명시적 로그인이 상태를 넘겨받았으면 늦은 결과로 덮지 않는다. */
  async function request(order) {
    const result = await post();
    const current = readEnd();
    if (current && current.order === order) writeEnd(result.state, order, result.reason);
    return result;
  }

  function leave() {
    if (moved || (keep && keep())) return;
    moved = true;
    // 종료를 어느 저장소에도 남기지 못했으면 랜딩이 그것을 알 길은 이 주소뿐이다 — 기록 없는 랜딩은 남은 세션으로 자동
    // 진입한다(F01). 싣는 것은 상태·순서·실패 구분뿐이다.
    const end = unkept;
    const query = end ? '?' + new URLSearchParams({ end: end.state, order: String(end.order), ...(end.reason ? { reason: end.reason } : {}) }) : '';
    location.replace(location.origin + location.pathname.replace(/[^/]*$/, 'index.html') + query);
  }

  /**
   * 다른 문서가 이 브라우저의 종료를 시작했다. 이 문서의 공개 신원을 내려놓을 뿐 새 POST나 이동은 하지 않는다 — 이동은 그
   * 문서의 조정자가 한다. 통지(BroadcastChannel·storage)와 종료 기록은 서로 다른 길로 와서 순서가 없으므로 둘 다 보고, 종료
   * 기록이 있을 때 한 번만 처리한다. 기록 없는 통지(데모 진입의 정리)는 신원을 건드리지 않는다. 종료 기록 채널로 온 기록은
   * 저장소에 기록이 없을 때 이 문서의 기록이 된다 — 보낸 문서가 어느 저장소에도 기록을 남기지 못했어도 사용을 끝낸다(F01).
   * 이미 끝난 문서도 그 기록은 받아 둔다(랜딩이 다시 읽을 때 최신 결과를 보인다).
   */
  function endedElsewhere(told) {
    const end = endOf(told ?? null);
    if (end && end.state !== 'unknown' && !storedEnd()) unkept = later(unkept, end);
    if (closed || !readEnd()) return;
    closed = true;
    dropIdentity();
    for (const listener of endedListeners) { try { listener(); } catch (e) {} }
  }
  try {
    const channel = new BroadcastChannel('kin-session');
    channel.onmessage = event => { if (event.data && event.data.type === 'session-ended') endedElsewhere(); };
  } catch (e) {}
  try {
    const records = new BroadcastChannel(END_CHANNEL);
    records.onmessage = event => endedElsewhere(event.data);
  } catch (e) {}
  addEventListener('storage', event => { if (event.key === 'kin-session-ended' || event.key === END_KEY) endedElsewhere(); });
  // 통지가 오지 않는 길(BroadcastChannel이 없고 종료 기록이 쿠키에만 남은 경우)에도 신원을 가진 문서는 사람이 돌아오는
  // 순간(창 초점, 탭 표시, 뒤로 가기 캐시 복원) 기록을 다시 본다 — 사람이 이 문서를 쓰려면 먼저 이 문서로 돌아와야 한다.
  const recheck = () => { if (cached) endedElsewhere(); };
  addEventListener('focus', recheck);
  addEventListener('pageshow', event => { if (event.persisted) recheck(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });

  async function loadSession() {
    if (S.getItem('kin-demo')) {
      cached = {
        state: 'approved', demo: true, user: 'demo', displayName: 'demo',
        roles: ['radiologist', 'technician', 'admin'], institution: 'demo',
      };
      return cached;
    }

    // 종료가 기록된 동안(또는 기록을 읽지 못하면) 남은 서버 세션으로 업무에 들어가지 않는다. 어느 문서든 같다 — 랜딩이
    // 상태를 보이고, 다시 들어가는 길은 사용자의 명시적 로그인뿐이다.
    if (readEnd()) {
      cached = null;
      return cached;
    }

    // 답을 기다리는 사이 이 문서의 사용이 끝났으면 그 답은 아무것도 정하지 않는다. 문서는 떠나는 중이고 이동은 종료를
    // 처리하는 쪽이 하므로, 기다리던 쪽(boot)이 두 번째 이동을 하지 않게 끝나지 않는 약속을 준다.
    const started = generation;
    const response = await fetch(`${API}/me`, { headers: { 'X-KIN-CSRF': '1' } });
    if (started !== generation) return new Promise(() => {});
    if (response.status === 401) {
      cached = null;
      return cached;
    }
    const body = await response.json().catch(() => ({}));
    if (started !== generation) return new Promise(() => {});
    if (response.status === 403) {
      if (body.code === 'INSTITUTION_PENDING') cached = { state: 'pending' };
      else if (body.code === 'INSTITUTION_INVALID') cached = { state: 'invalid' };
      else throw new Error('계정 상태를 확인할 수 없습니다');
      return cached;
    }
    if (!response.ok) throw new Error(`세션 확인 실패 (HTTP ${response.status})`);
    cached = {
      state: 'approved',
      sub: typeof body.sub === 'string' ? body.sub : null,
      user: body.user ?? body.actor ?? '',
      displayName: body.displayName ?? body.user ?? body.actor ?? '',
      roles: Array.isArray(body.roles) ? body.roles : [],
      institution: body.institution ?? null,
    };
    return cached;
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

  let retrying = null;

  return {
    KC,

    async init() {
      if (initialized) return cached;
      if (!initializing) {
        initializing = loadSession()
          .then(result => { initialized = true; return result; })
          .then(land)
          .finally(() => { initializing = null; });
      }
      return initializing;
    },

    session() { return cached; },

    home(session = cached) { return home(session); },

    has(role) {
      const session = cached;
      if (!session || session.state !== 'approved') return false;
      if (session.demo) return true;
      return session.roles.includes(role) || session.roles.includes('admin');
    },

    /** 랜딩이 먼저 보는 종료 상태: null(종료 의도 없음), ending·unconfirmed·confirmed, 또는 unknown(읽지 못함). */
    endState() {
      const end = readEnd();
      return end && { state: end.state, reason: end.reason };
    },

    async login(opts = {}) {
      forgetEnd();
      const query = opts.prompt ? `?prompt=${encodeURIComponent(opts.prompt)}` : '';
      location.href = `${API}/auth/login${query}`;
    },

    async register() {
      forgetEnd();
      location.href = `${API}/auth/register`;
    },

    demo() {
      clearLocal();
      S.setItem('kin-demo', '1');
      initialized = false;
    },

    /**
     * 업무 화면의 Log out과 401·계정 변경. 네트워크를 기다리기 전에 종료 상태를 남기고 이 문서의 신원을 내려놓으며 다른
     * 문서에 한 번 알린다(통지는 화면을 닫으라는 뜻이지 서버 종료의 증거가 아니다). 페이지가 맡긴 일(beforeLogoutPost)을
     * 한도 안에서 기다린 뒤 POST 하나를 보내고, 결과를 기록한 뒤 랜딩으로 한 번 옮긴다. 같은 문서의 겹친 호출은 새 POST
     * 없이 진행 중인 종료를 나눈다. 이미 끝난 문서이거나 종료가 기록돼 있으면(다른 문서가 시작함, 확인·미확인, 읽지 못함)
     * POST 없이 이 문서만 닫고 떠난다 — 다시 보내는 것은 랜딩의 Retry Log Out뿐이다. 데모는 서버 세션이 없어 로컬만 끝내고
     * 종료 확인으로 기록하지 않는다.
     */
    async logout() {
      if (ending) return stepping ? undefined : ending;
      if (S.getItem('kin-demo')) {
        clearLocal();
        leave();
        return;
      }
      if (closed || readEnd()) {
        closed = true;
        dropIdentity();
        leave();
        return;
      }
      const order = nextOrder();
      writeEnd('ending', order);
      closed = true;
      clearLocal();
      ending = (async () => {
        if (step) {
          stepping = true;
          let timer;
          try {
            await Promise.race([
              Promise.resolve().then(step).catch(() => {}),
              new Promise(resolve => { timer = setTimeout(resolve, STEP_WAIT_MS); }),
            ]);
          } finally {
            clearTimeout(timer);
            stepping = false;
          }
        }
        await request(order);
        leave();
      })();
      return ending;
    },

    /** 이 문서가 시작하는 종료마다 종료 기록·통지 뒤, POST 앞에 한도 안에서 기다릴 일(실패해도 종료는 막히지 않는다). */
    beforeLogoutPost(work) { step = typeof work === 'function' ? work : null; },

    /** 랜딩의 Retry Log Out: 누를 때마다 POST 하나(누르는 동안의 겹친 호출은 나눈다). 이동하지 않는다. */
    retryLogout() {
      if (retrying) return retrying;
      const order = nextOrder();
      writeEnd('ending', order);
      retrying = request(order).finally(() => { retrying = null; });
      return retrying;
    },

    /** 다른 문서가 이 브라우저의 종료를 시작한 것을 이 문서가 알게 되면 한 번 부른다(신원은 이미 내려놓았다). */
    onEndedElsewhere(listener) {
      if (typeof listener === 'function') endedListeners.push(listener);
    },

    /**
     * 조항 8-e. 판정이 참인 동안(이 문서를 떠나면 잃는 것이 있는 동안) 종료 뒤의 이동을 미룬다. 종료 기록·신원 해제·통지·
     * POST는 미루지 않는다. 판정이 거짓이 된 뒤 페이지가 leave()로 미룬 이동을 한다.
     */
    holdLeave(test) { keep = typeof test === 'function' ? test : null; },

    leave() { leave(); },
  };
})();
