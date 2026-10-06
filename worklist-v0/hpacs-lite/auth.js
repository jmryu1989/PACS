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
   * 종료 기록(U5S-REQ-06, S7-U5 세션 종료 설계 3.1). 담는 것은 세션 식별값·요청 번호·상태(와 실패 구분)·출처뿐이다 — sid·토큰·
   * 쿠키·계정·기관·환자 값은 담지 않는다. 같은 출처의 모든 문서가 읽는 localStorage에 두어 새로고침·뒤로 가기·나중에 연 탭도
   * 같은 상태를 본다. 이 기록은 화면을 닫고 알리고 다시 보여 주는 데만 쓴다 — 서버 세션이 끝났다는 증거도, 초안의 보관소도 아니다.
   *
   * 기록은 **세션마다 자기 키**에 둔다(`kin-session-end:<세션>`). 한 칸에 두던 때에는 옛 세션 문서의 Log out이 지금 세션의
   * 기록을 덮거나 지웠다. 여러 세션의 기록을 한 값(지도)에 모으지도 않는다 — 읽고 고쳐 쓰는 사이 다른 탭의 쓰기를 잃는다.
   *
   * 출처(origin)는 그 세션이 **왜** 끝났는지다:
   *   logout      사람이 Log out을 눌렀다. 새 문서는 이 기록이 있으면 스스로 들어가지 않는다(명시적 로그아웃 뒤에는 Login 한 번).
   *   server_end  서버가 그 세션이 끝났다고 답했다(만료 등). 새 문서를 랜딩에 세우지 않는다 — 평소처럼 로그인으로 간다.
   *   replaced    다른 로그인이 그 세션을 대신했다. 역시 새 문서를 세우지 않는다.
   * 같은 세션의 logout은 뒤에 온 server_end·replaced가 낮추지 못한다. 출처 없는 기록(이 형식 전의 한 칸짜리 기록)은 사람이
   * 떠난 것으로도, 아무 일 없던 것으로도 읽지 않는다 — "알 수 없음"이고, 새 문서는 명시적 로그인만 받는다.
   *
   * 상태 `leaving`은 종료가 아니다: Log out을 누른 순간부터 실제 종료 전까지의 "떠나려는 중"이다(준비 번호와 함께). 다른 탭도
   * 뷰어도 닫지 않고 알리지도 않으며, Back to Editing이 자기 준비의 것만 지운다. 그 준비를 하던 창이 사라졌을 때에만 새 문서가
   * 끝내지 못한 로그아웃으로 읽는다(아래 leavingAlive).
   *
   * localStorage가 받지 않으면(용량 초과처럼 읽기는 되는데 쓰기만 실패) 같은 기록을 같은 출처의 세션 쿠키에, 역시 세션마다
   * 따로 둔다. 어느 쪽에도 남기지 못해도 새 문서는 열리지 않는다: 저장소에 쓰고 되읽을 수 없는 문서는 unknown으로 시작한다.
   */
  const END_KEY = 'kin-session-end';
  const END_PREFIX = 'kin-session-end:';
  const END_COOKIE = 'kin-session-end';
  const END_COOKIE_PREFIX = 'kin-session-end.';
  const STATUSES = ['leaving', ...CLOSED];
  const ORIGINS = ['logout', 'server_end', 'replaced'];
  // 사람의 로그아웃이 아닌 기록(server_end·replaced)은 아무도 막지 않는다. SSO 세션의 최대 수명이 지나면 쓸 데가 없어 치운다.
  const PASSIVE_KEEP_MS = 12 * 60 * 60 * 1000;
  const PROBE_KEY = 'kin-session-probe';
  const CHANNEL = 'kin-session';
  // 로그인 콜백이 주소 조각으로 넘기는 일회용 진입 증명의 이름(U5S-REQ-09).
  const ENTRY_MARK = 'kin-entry';
  // 요청 시작부터 응답 본문 판정까지. 넘으면 결과를 모르는 것이고 다시 보내는 것은 사람뿐이다.
  const REQUEST_WAIT_MS = 10000;
  // 페이지가 POST 앞에 끼우는 일(main.html의 점유 해제)의 한도. 그 일이 끝나지 않아도 종료는 막히지 않는다.
  const STEP_WAIT_MS = 5000;
  // 인증 서버가 답하는지 보는 확인의 한도(A011). 넘으면 "닿지 않음"이다 — 확인 중인 채로 남지 않는다.
  const IDP_WAIT_MS = 5000;
  // 자동 로그인이 세션을 만들지 못하고 되돌아온 탭은 이 시간 안에 다시 자동으로 보내지 않는다(IdP와의 되돌이 고리를 끊는다).
  const AUTO_LOGIN_KEY = 'kin-auto-login';
  const AUTO_LOGIN_GAP_MS = 60000;
  const UNREADABLE = Object.freeze({ unreadable: true });
  // 다른 창의 로그아웃 준비가 살아 있는 동안 새 문서가 보이는 문장(A017·SEB-F06). 그 창의 결과를 기다릴 뿐 아무것도 끝내지 않는다.
  const PREPARING_ELSEWHERE = '다른 창에서 로그아웃을 준비하고 있습니다. 그 창에서 편집으로 돌아가면 이 화면도 이어서 열립니다.';
  // 그 기다림 동안 다시 보는 간격. 창이 닫혀 잠금이 풀리는 것은 사건으로 오지 않는다.
  const PREPARING_RECHECK_MS = 1000;

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
  // 평소의 진입에서 서버가 "이 브라우저에 세션이 없다"고 방금 답했다. 자동 로그인의 유일한 근거다.
  let absent = false;
  // 통지로 들은 종료(세션 식별값별: 요청 번호와 출처). 신원 확인을 기다리는 문서가 그 답을 받기 직전에 대조한다.
  const heard = new Map();
  // 이 문서가 남긴 "떠나려는 중" 표지(준비 번호별)와, 그 표지가 살아 있는 창의 것임을 알리는 잠금의 해제.
  const leavings = new Map();
  const lifecycleListeners = [];
  const endedListeners = [];
  // 페이지가 init({ onHold })로 맡긴 안내: 다른 창의 로그아웃 준비를 기다리는 동안 문장, 끝나면 null로 한 번씩 부른다.
  let holdListener = null;
  // 그 기다림을 깨우는 일(기록의 storage 알림·종료 통지·창 초점). 기다리는 중이 아니면 null이다.
  let wake = null;

  function announce() {
    const event = Object.freeze({ state, session: sessionId });
    for (const listener of [...lifecycleListeners]) { try { listener(event); } catch (e) {} }
  }

  function notifyEnded() {
    for (const listener of [...endedListeners]) { try { listener(); } catch (e) {} }
  }

  /** 종료 기록 하나(저장한 글자 또는 통지에 실린 값)를 읽는다. 없으면 null, 모양이 다르거나 출처가 없으면 UNREADABLE. */
  function endOf(value) {
    if (value === null || value === undefined) return null;
    try {
      if (typeof value === 'string') value = JSON.parse(value);
      if (value && typeof value.session === 'string' && value.session && Number.isFinite(value.operation)
        && STATUSES.includes(value.status) && ORIGINS.includes(value.origin)
        && (value.status !== 'leaving' || (typeof value.preparation === 'string' && value.preparation)))
        return { session: value.session, operation: value.operation, status: value.status, origin: value.origin,
          reason: END_REASONS.includes(value.reason) ? value.reason : null,
          preparation: value.status === 'leaving' ? value.preparation : null };
    } catch (e) {}
    return UNREADABLE;
  }

  /** 두 기록 중 나중 것. 같은 요청이면 떠나려는 중 < 요청 중(ending) < 결과(확인·미확인) 순이다. */
  function later(a, b) {
    if (!a || !b) return a || b;
    if (a.operation !== b.operation) return a.operation > b.operation ? a : b;
    const rank = record => record.status === 'leaving' ? 0 : record.status === 'ending' ? 1 : 2;
    return rank(a) >= rank(b) ? a : b;
  }

  /** 종료 기록의 대체 쿠키들: [이름, 글자]. 풀 수 없는 값은 ''(모양이 다른 기록)이다. */
  function cookieEnds() {
    let jar;
    try { jar = document.cookie; } catch (e) { return []; }
    const found = [];
    for (const part of String(jar || '').split(';')) {
      const at = part.indexOf('=');
      const name = at > 0 ? part.slice(0, at).trim() : '';
      if (name !== END_COOKIE && !name.startsWith(END_COOKIE_PREFIX)) continue;
      let text = '';
      try { text = decodeURIComponent(part.slice(at + 1).trim()); } catch (e) { text = ''; }
      found.push([name, text]);
    }
    return found;
  }

  function setCookieEnd(name, text) {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    try {
      document.cookie = text === null
        ? `${name}=; Path=/; Max-Age=0; SameSite=Strict${secure}`
        : `${name}=${encodeURIComponent(text)}; Path=/; SameSite=Strict${secure}`;
    } catch (e) {}
    const kept = cookieEnds().find(([other]) => other === name);
    return text === null ? !kept : !!kept && kept[1] === text;
  }

  /**
   * 남아 있는 종료 기록 전부: 세션별 기록과, 읽지 못했거나 모양이 다르거나 출처 없는 기록이 있었는가(unreadable).
   * 출처 없는 옛 기록(한 칸짜리 키·쿠키)은 여기서 unreadable로 센다 — 어느 쪽도 사용 중의 근거가 아니다.
   */
  function readAll() {
    const records = new Map();
    let unreadable = false;
    const take = (session, text) => {
      const record = endOf(text);
      if (record === null) return;
      if (record === UNREADABLE || record.session !== session) { unreadable = true; return; }
      records.set(session, later(records.get(session), record));
    };
    try {
      if (localStorage.getItem(END_KEY) !== null) unreadable = true;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (typeof key === 'string' && key.startsWith(END_PREFIX)) take(key.slice(END_PREFIX.length), localStorage.getItem(key));
      }
    } catch (e) {
      unreadable = true;
    }
    for (const [name, text] of cookieEnds()) {
      if (name === END_COOKIE) unreadable = true;
      else take(name.slice(END_COOKIE_PREFIX.length), text);
    }
    return { records, unreadable };
  }

  /** 새 문서를 세우는 기록: 사람의 로그아웃(출처 logout)의 닫힘 상태 가운데 가장 나중 것. 없으면 null. */
  function blocking(records) {
    let found = null;
    for (const record of records.values())
      if (record.origin === 'logout' && CLOSED.includes(record.status)) found = later(found, record);
    return found;
  }

  /**
   * 그 세션 자신의 종료 기록(떠나려는 중은 종료가 아니다). 일하는 문서를 닫는 것은 이것뿐이다 — 다른 세션의 기록은 그
   * 문서들의 일이다. 이 형식 전의 한 칸짜리 기록이 그 세션을 가리키면 그것도 종료다(배포 전부터 열려 있던 탭의 Log out).
   */
  function ownEnd(session) {
    const { records } = readAll();
    const own = records.get(session);
    if (own && own.status !== 'leaving') return own;
    try {
      const old = JSON.parse(localStorage.getItem(END_KEY));
      if (old && old.session === session)
        return { session, operation: Number.isFinite(old.operation) ? old.operation : 0,
          status: CLOSED.includes(old.status) ? old.status : 'ending',
          reason: END_REASONS.includes(old.reason) ? old.reason : null, origin: 'logout', preparation: null };
    } catch (e) {}
    return null;
  }

  /**
   * 종료 기록을 그 세션의 키에 남긴다. localStorage에 쓰고 되읽어 확인하며, 남지 않았으면 그 세션의 쿠키에 둔다. 남았는지를
   * 돌려준다. 같은 세션에 사람의 로그아웃 기록이 이미 있으면 출처는 logout으로 남는다(뒤의 server_end가 낮추지 못한다).
   */
  function writeEnd(record) {
    const before = readAll().records.get(record.session);
    const origin = before && before.origin === 'logout' ? 'logout' : record.origin;
    const stored = { session: record.session, operation: record.operation, status: record.status, origin };
    if (record.reason) stored.reason = record.reason;
    if (record.status === 'leaving') stored.preparation = record.preparation;
    const text = JSON.stringify(stored), key = END_PREFIX + record.session;
    try {
      localStorage.setItem(key, text);
      if (localStorage.getItem(key) === text) return true;
    } catch (e) {}
    return setCookieEnd(END_COOKIE_PREFIX + record.session, text);
  }

  /** 그 세션의 기록만 지운다. 다른 세션의 기록은 건드리지 않는다. */
  function removeEnd(session) {
    try { localStorage.removeItem(END_PREFIX + session); } catch (e) {}
    if (cookieEnds().some(([name]) => name === END_COOKIE_PREFIX + session)) setCookieEnd(END_COOKIE_PREFIX + session, null);
  }

  /**
   * 명시적 로그인이 지금 세션을 확인했다: 앞선 세션들의 기록(과 출처 없는 옛 기록)은 여기서만 넘겨받아 지운다. 지금 세션
   * 자신의 기록은 지우지 않는다.
   */
  function supersede(current) {
    try {
      localStorage.removeItem(END_KEY);
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (typeof key === 'string' && key.startsWith(END_PREFIX) && key !== END_PREFIX + current) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
    } catch (e) {}
    for (const [name] of cookieEnds()) if (name !== END_COOKIE_PREFIX + current) setCookieEnd(name, null);
  }

  /** 아무도 막지 않는 오래된 기록(server_end·replaced)을 치운다. 사람의 로그아웃 기록은 다음 로그인까지 남는다. */
  function prune() {
    for (const record of readAll().records.values())
      if (record.origin !== 'logout' && Date.now() - record.operation > PASSIVE_KEEP_MS) removeEnd(record.session);
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
  let entryBinding = null;
  /**
   * 이 문서는 로그인 증명으로 들어가는 중이다(A013). 그동안에는 이 브라우저에 남은 **다른** 세션의 기록·통지로 판정하지
   * 않는다: 어제의 Log out 기록은 이 로그인이 넘겨받을 것이고, 확인을 기다리는 사이의 창 초점·탭 표시·저장소 알림이 그
   * 기록으로 이 문서를 닫으면 방금 한 로그인이 버려진다. 새 세션의 식별값을 알게 된 뒤에는 그 세션 자신의 종료만 따른다.
   */
  let proofEntry = !!proof;
  // 진입 증명의 답을 잃었다(A012). 증명은 다시 내지 않고, 이 문서는 증명 없는 평소의 문서로 한 번 확인한다.
  let entryLost = false;
  // 새 문서가 발견한 "떠나려는 중" 기록. 그 준비를 하던 창이 살아 있는지는 비동기로만 알 수 있어 진입(enter)이 가린다.
  let pendingLeaving = null;

  /**
   * 저장소가 말하는 이 문서의 시작 상태. 사람의 로그아웃 기록이 있으면 그 상태로 닫혀 있고, 저장소를 믿을 수 없으면 unknown이다.
   * "떠나려는 중" 기록이 있으면 저장소 판정은 그 준비가 끝난 뒤로 미룬다(settleLeaving이 다시 부른다) — 판정이 먼저 서면 Login이
   * 살아 있는 준비의 세션을 끝낼 수 있다. 미루는 것이지 건너뛰는 것이 아니다.
   * 증명의 답을 잃은 문서(entryLost)는 방금 명시적 로그인을 마친 문서다: 다른 세션의 사람의 로그아웃 기록(어제의 Log out)은
   * 이 문서를 세우지 않는다 — 그 기록은 이 로그인이 넘겨받을 것이고, 자기 세션의 기록·통지는 진입(adopt)이 따로 막는다.
   */
  function classify() {
    const { records, unreadable } = readAll();
    pendingLeaving = null;
    if (unreadable) {
      state = 'unknown';
      reason = 'record';
      return;
    }
    const record = entryLost ? null : blocking(records);
    if (record) {
      state = record.status;
      reason = record.reason;
      sessionId = record.session;
      operation = record.operation;
      return;
    }
    for (const other of records.values())
      if (other.status === 'leaving' && other.origin === 'logout') pendingLeaving = later(pendingLeaving, other);
    if (!pendingLeaving && !reliable) {
      state = 'unknown';
      reason = 'storage';
    }
  }
  prune();
  if (!proof) classify();

  /** 서버에 물을 수 있는 시작인가: 아직 아무것도 정해지지 않은 unknown뿐이다. */
  function undecided() { return state === 'unknown' && reason === null; }

  /**
   * 그 "떠나려는 중" 표지를 남긴 창이 아직 살아 있는가(A017). 표지를 남긴 문서는 그 순간부터 Web Lock `kin-leaving:<준비>`를
   * 쥐고, 준비에 들어서면 페이지가 `kin-preparation:<준비>`도 쥔다 — 창이 닫히거나 죽으면 브라우저가 둘 다 푼다. 어느 하나라도
   * 쥐였거나 요청 중이면 살아 있다. 잠금은 요청 직후 잠깐 보이지 않을 수 있어 한 번 더 본다. 잠금을 쓸 수 없는 브라우저에서는
   * 알 길이 없다 — 살아 있다고 보지 않는다(스스로 들어가지 않고 랜딩이 사정을 보인다; 끝내는 것은 사람이 Login을 누를 때뿐이다).
   */
  async function leavingAlive(record) {
    let manager = null;
    try { manager = navigator.locks; } catch (e) {}
    if (!manager || typeof manager.query !== 'function') return false;
    const names = ['kin-leaving:' + record.preparation, 'kin-preparation:' + record.preparation];
    for (const wait of [0, 300]) {
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      try {
        const snapshot = await manager.query();
        if ([...(snapshot.held || []), ...(snapshot.pending || [])].some(lock => names.includes(lock.name))) return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /** 기다림을 깨운다(기록이 바뀌었을 수 있다). */
  function rouse() {
    const run = wake;
    wake = null;
    if (run) run();
  }

  function holding(text) {
    try { if (holdListener) holdListener(text); } catch (e) {}
  }

  /**
   * 그 기록의 준비를 하던 창이 살아 있는 동안 기다린다(A017·SEB-F06). 이 문서는 들어가지도, 아무것도 끝내지도 않고 준비 중
   * 정지를 따른다 — 페이지에는 그동안 PREPARING_ELSEWHERE를 보이게 한다. 기록이 바뀌거나(편집으로 돌아감·실제 종료로
   * 올라감·다른 준비), 창이 사라지거나, 이 문서가 그사이 정해지면(종료 통지·기록) 돌아온다. 기다림은 그 준비의 수명만큼이다.
   */
  async function waitWhileAlive(record) {
    holding(PREPARING_ELSEWHERE);
    try {
      for (;;) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, PREPARING_RECHECK_MS);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = null;
        if (!undecided()) return;
        const now = readAll().records.get(record.session);
        if (!now || now.status !== 'leaving' || now.preparation !== record.preparation) return;
        if (!await leavingAlive(record)) return;
      }
    } finally {
      holding(null);
    }
  }

  /**
   * 새 문서가 본 "떠나려는 중" 기록을 가린다. 그 창이 살아 있으면 그 준비가 끝날 때까지 기다린다 — 그 창의 미저장 글을
   * 지키기 위해 아무것도 끝내지 않고, 이 문서도 그 준비의 정지를 따른다(들어가지 않는다). 창이 사라졌으면 끝내지 못한
   * 로그아웃이다: 스스로 들어가지 않고 랜딩에 선다. 기록이 실제 종료로 올라갔거나 지워졌거나 다른 준비로 바뀌었으면 처음부터
   * 다시 판정한다 — 미뤄 둔 저장소 판정(믿을 수 없는 저장소는 unknown)도 여기서 선다.
   */
  async function settleLeaving() {
    while (pendingLeaving && undecided()) {
      const record = pendingLeaving;
      pendingLeaving = null;
      // 이미 본 답(창이 없다)은 다시 묻지 않는다. 기다린 뒤에는 그 끝이 무엇이었는지 다시 본다.
      const gone = !await leavingAlive(record);
      if (!gone) await waitWhileAlive(record);
      if (!undecided()) return;
      const now = readAll().records.get(record.session);
      if (now && now.status === 'leaving' && now.preparation === record.preparation && (gone || !await leavingAlive(record))) {
        if (!undecided()) return;
        state = 'unconfirmed';
        reason = 'abandoned';
        sessionId = record.session;
        operation = record.operation;
        announce();
        notifyEnded();
        return;
      }
      classify();
      if (!undecided()) { pendingLeaving = null; announce(); notifyEnded(); return; }
    }
  }

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

  /**
   * 인증 서버가 지금 답하는가(A011). 한도 안에 답이 없으면 닿지 않는 것이다. 랜딩의 상태 줄과, 인증 서버로 이동하기 직전의
   * 확인이 쓴다 — 닿지 않는 인증 서버로 사람을 보내 프록시의 오류 화면에 세우지 않는다. 살아 있는 세션으로 들어가는 Login은
   * 이것을 기다리지 않는다(그 길은 `/api/me`만으로 간다).
   */
  async function idpReachable() {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), IDP_WAIT_MS);
    try {
      const response = await fetch(`${KC}/realms/kin/.well-known/openid-configuration`, { signal: control.signal });
      return response.ok;
    } catch (e) {
      return false;
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
    if (['AUTH_IDP_UNAVAILABLE', 'AUTH_SESSION_BUSY', 'AUTH_STORAGE_FAILURE'].includes(answer.code))
      throw Object.assign(new Error('세션 연결을 확인하지 못했습니다'), { retryable: true });
    if (answer.status === 403) throw new Error('계정 상태를 확인할 수 없습니다');
    if (answer.status !== 200) throw Object.assign(new Error(`세션 확인 실패 (HTTP ${answer.status})`),
      { retryable: answer.status >= 500 });
    if (!id) throw new Error('세션 확인 실패 (세션 식별값 없음)');
    return { id, identity: identityOf(body) };
  }

  /**
   * 확인한 신원을 이 문서의 것으로 삼는다 — 삼기 직전에 한 번 더 본다(Sol U5R2-F02). 답을 기다리는 사이 이 문서가 닫혔거나,
   * 그 세션의 종료가 기록되었거나 통지되었으면 그 답은 신원을 만들지 않는다. 증명 없는 진입은 어느 세션의 것이든 사람의
   * 로그아웃 기록 앞에 선다. 그 세션의 "떠나려는 중"은 막지 않는다 — 살아 있는 창의 것인지는 진입이 이미 가렸다.
   */
  function adopt(id, identity, viaProof) {
    if (!undecided()) return null;
    // 증명으로 들어가는 문서는 저장소를 읽지 못해도 들어간다(서버가 방금의 로그인을 확인했다). 그 밖에는 읽지 못하면 닫힌다 —
    // 증명의 답을 잃은 문서도 그렇다(서버의 확인은 증명이 아니라 결속 없는 /api/me였다).
    const { records, unreadable } = readAll();
    if (unreadable && (!viaProof || entryLost)) {
      reason = 'record';
      announce();
      return null;
    }
    const own = records.get(id), told = heard.get(id);
    const ended = own && own.status !== 'leaving' ? own : viaProof ? null : blocking(records);
    if (ended || told) {
      [state, reason] = ended ? [ended.status, ended.reason] : heardState(told);
      sessionId = ended ? ended.session : id;
      operation = ended ? ended.operation : told.operation;
      announce();
      return null;
    }
    // 증명 진입 또는 사람이 누른 Login이 현재 세션을 확인했다. 앞선 세션의 종료 기록은 여기서만 지운다.
    if (viaProof) supersede(id);
    tab.remove(AUTO_LOGIN_KEY);
    cached = identity;
    sessionId = id;
    state = 'active';
    proofEntry = false;
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
    // 증명의 답을 잃은 문서(A012·SEB-F01)는 방금 명시적 로그인을 마친 문서다: 서버가 확인해 준 세션으로, 성공한 증명 진입처럼
    // 앞선 세션들의 기록을 넘겨받는다. 그 세션 자신의 기록·통지는 여전히 막는다(adopt).
    return adopt(id, identity, entryLost);
  }

  /**
   * 명시적 로그인을 마친 문서의 진입: 증명을 서버에 한 번 내고(쓰면 사라진다), 받은 세션 식별값에 묶어 신원을 확인한다.
   * 저장소를 쓸 수 없거나 앞선 종료 기록이 남아 있어도 이 길로는 들어간다 — 서버가 방금의 로그인을 확인했기 때문이다.
   * 거절된 증명(다른 세션·만료·재사용)은 아무것도 열지 않는다.
   *
   * 증명의 답을 잃었으면(연결 끊김·5xx·읽지 못한 답, A012) 그 증명은 다시 내지 않는다 — 쓰였는지 모른다. 이 문서는 증명
   * 없는 평소의 문서로 돌아가 한 번 확인한다: 서버가 살아 있는 세션을 답하고 막는 기록이 없으면 새 탭이 그러듯 클릭 없이
   * 들어간다. 그 확인도 얻지 못할 때에만 랜딩이 사정을 한 번 알린다.
   */
  async function enterWithProof() {
    if (!entryBinding) {
      const offered = proof;
      proof = null;
      let entry = null;
      try { entry = await send('/auth/entry', { method: 'POST', json: { proof: offered } }); }
      catch (_) { entry = null; }
      if (!entry || entry.status >= 500 || entry.status === 429 || (entry.status === 200 && !entry.body?.sessionId)) {
        // A012·SEB-F01: 어제의 Log out 기록(다른 세션)은 이 문서를 세우지 않는다 — 결속 없는 /api/me 한 번이 정한다. 그 답을
        // 기다리는 동안에도 다른 세션의 기록·통지·창 사건으로 판정하지 않는다(A013과 같은 보류: proofEntry는 그대로이고,
        // 새 세션의 식별값을 아직 모르므로 닫는 것은 진입이 확인한 그 세션 자신의 기록·통지뿐이다). 믿을 수 없는 저장소와
        // 읽을 수 없는 기록은 지금처럼 랜딩이다.
        entryLost = true;
        classify();
        if (!undecided()) { proofEntry = false; announce(); return null; }
        return enterPlain();
      }
      entryBinding = entry.status === 200 && typeof entry.body?.sessionId === 'string' && entry.body.sessionId
        ? entry.body.sessionId : null;
    }
    const id = entryBinding;
    let found = null;
    if (id) {
      try {
        const answer = await send('/me', { session: id });
        const read = readIdentity(answer);
        if (read.id === id) found = read;
      } catch (error) { if (error.retryable || ['network', 'timeout'].includes(error.kind)) throw error; }
    }
    if (!undecided()) return null;
    // Roles may change after the callback chose this document. A consumed proof cannot be
    // forwarded to a different document; only the bound identity may admit this one.
    if (found && found.identity.state === 'approved') {
      const roles = found.identity.roles;
      if ((/\/main\.html$/.test(location.pathname) && home(found.identity) === 'clinician.html')
        || (/\/clinician\.html$/.test(location.pathname) && !roles.includes('clinician') && !roles.includes('admin')))
        found = null;
    }
    if (!found) {
      proofEntry = false;
      classify();
      pendingLeaving = null;
      if (undecided()) reason = 'entry';
      announce();
      return null;
    }
    return adopt(found.id, found.identity, true);
  }

  /** 증명 없는 문서의 진입: 남은 "떠나려는 중" 표지를 먼저 가리고, 막는 것이 없으면 서버에 한 번 묻는다. */
  async function enterPlain() {
    if (pendingLeaving) await settleLeaving();
    const result = undecided() ? await bootstrap() : null;
    // 증명의 답을 잃은 문서가 세션을 확인하지 못했다(서버가 세션 없음을 답했다): 스스로 로그인을 다시 시작하지 않는다.
    if (entryLost && !result && undecided() && !moved) return entryUnconfirmed();
    if (entryLost && !undecided()) proofEntry = false;
    return result;
  }

  function entryUnconfirmed() {
    proofEntry = false;
    if (!undecided()) return null;
    reason = 'entry-unconfirmed';
    announce();
    leave();
    return moved ? new Promise(() => {}) : null;
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
    // 사람의 로그아웃이 기록된 동안, 또는 저장소를 믿을 수 없는 동안에는 남은 서버 세션으로 업무에 들어가지 않는다. 어느
    // 문서든 같다 — 랜딩이 상태를 보이고, 다시 들어가는 길은 사용자의 명시적 로그인뿐이다.
    const result = proof || entryBinding ? await enterWithProof() : await enterPlain();
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
   * Login callbacks already select the final document before delivering its proof. This redirect
   * handles ordinary main.html entry without a proof. Keep boot pending until navigation finishes
   * so a clinician-only account never starts the main worklist.
   */
  function land(session) {
    if (!/\/main\.html$/.test(location.pathname) || home(session) !== 'clinician.html') return session;
    location.replace('clinician.html');
    return new Promise(() => {});
  }

  function leave() {
    if (moved || (keep && keep())) return;
    moved = true;
    // 진입을 확인하지 못했다는 표지는 랜딩이 한 번 읽고 지우는 알림일 뿐이다 — 상태도, 들어갈 권한도 아니다.
    location.replace(location.origin + location.pathname.replace(/[^/]*$/, 'index.html')
      + (reason === 'entry-unconfirmed' ? '?auth_error=entry_unconfirmed' : ''));
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

  function nextOperation(session = sessionId) {
    const last = session ? readAll().records.get(session) : null;
    return Math.max(Date.now(), operation + 1, (last ? last.operation : 0) + 1);
  }

  /**
   * 종료 표지. 이 문서가 자기 세션의 실제 종료를 알리거나 알게 되는 자리에서, 통지보다 **먼저** Web Lock
   * `kin-session-ended:<세션>`을 요청해 이 문서가 사라질 때까지 쥔다. 통지(BroadcastChannel)와 잠금 해제는 브라우저의 서로
   * 다른 줄로 전달되어 순서가 없다 — 로그아웃 준비로 멈춘 뷰어가 준비 잠금의 해제를 종료 통지보다 먼저 보면 종료를 취소로
   * 읽는다. 뷰어는 풀려날 때 이 표지부터 본다(쥐었거나 기다리는 요청이 있으면 종료다). 요청은 걸어 두기만 하고 기다리지
   * 않는다: 같은 세션의 다른 문서가 이미 쥐고 있으면 그것으로 충분하고, 종료는 잠금 때문에 늦어지거나 막히지 않는다. 잠금을
   * 쓸 수 없는 브라우저에서는 통지만 간다.
   */
  const marked = new Set();
  function markEnded(session) {
    if (!session || marked.has(session)) return;
    marked.add(session);
    try {
      const request = navigator.locks && navigator.locks.request('kin-session-ended:' + session, { mode: 'exclusive' },
        () => new Promise(() => {}));
      if (request) request.catch(() => {});
    } catch (e) {}
  }

  /**
   * 종료를 시작한 문서가 같은 세션의 다른 문서에 한 번 알린다. 화면을 닫으라는 뜻이지 서버 종료의 증거가 아니다. 출처를 함께
   * 싣는다 — 듣는 쪽이 서버가 끝낸 세션을 사람의 로그아웃으로 읽지 않게.
   */
  function tell(session, op, origin) {
    markEnded(session);
    try {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage({ type: 'session-ended', session, operation: op, status: 'ending', origin });
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
   * 종료 요청 하나의 결과를 그 세션의 기록에 남긴다. 그사이 더 새 요청(Retry)이나 명시적 로그인이 기록을 넘겨받았으면 늦은
   * 결과로 덮지 않는다. 쿠키가 다른 로그인의 것이면 이 세션은 이 브라우저의 새 문서가 다시 쓸 수 없으므로 그 기록은 치운다 —
   * 남겨 두면 그 로그인의 새 문서까지 막는다. 다른 세션의 기록은 어느 경우에도 건드리지 않는다.
   */
  async function conclude(session, op) {
    const result = await post(session);
    const current = readAll().records.get(session);
    if (current && current.operation === op) {
      if (result.reason === 'replaced') removeEnd(session);
      else writeEnd({ session, operation: op, status: result.state, reason: result.reason, origin: 'logout' });
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
    // 통지를 받은 문서도 표지를 건다 — 종료를 시작한 문서가 먼저 떠나도, 이 문서가 남아 있는 동안 표지가 남는다.
    markEnded(sessionId);
    closeHere(next, why, op);
    notifyEnded();
  }

  /** 증명으로 들어가는 중인 문서가 **자기 새 세션의** 종료를 알았다: 그 종료는 언제나 따른다(증명도 자기 종료는 넘지 못한다). */
  function closeEntry() {
    if (!undecided() || !entryBinding) return;
    const own = ownEnd(entryBinding), told = heard.get(entryBinding);
    if (!own && !told) return;
    proofEntry = false;
    [state, reason] = own ? [own.status, own.reason] : heardState(told);
    sessionId = entryBinding;
    operation = own ? own.operation : told.operation;
    announce();
    notifyEnded();
  }

  /**
   * 통지로만 들은 종료의 [상태, 사유]: 서버가 끝낸 세션은 끝난 세션, 다른 로그인이 대신한 세션은 교체(확인되지 않은 종료),
   * 그 밖(사람의 로그아웃·출처 모름)은 요청 중이다.
   */
  function heardState(told) {
    if (told.origin === 'server_end') return ['confirmed', null];
    if (told.origin === 'replaced') return ['unconfirmed', 'replaced'];
    return ['ending', null];
  }

  /**
   * 종료 기록을 다시 읽는다(storage 알림, 창 초점·탭 표시·뒤로 가기 복원). 일하는 문서는 자기 세션의 기록에만 닫힌다 — 다른
   * 세션의 기록과 "떠나려는 중"은 그 문서들의 일이고, 읽을 수 없게 된 저장소는 종료 신호가 아니다(저장소 오류로 의사의 화면을
   * 닫지 않는다; 그 세션이 정말 끝났으면 다음 요청의 답이 말한다). 증명으로 들어가는 중인 문서는 자기 새 세션의 종료만
   * 따른다(A013). 아직 들어가지 않은 문서와 닫힌 문서(랜딩)는 가장 나중의 사람의 로그아웃 기록을 따르되, 기록이 지워진 것
   * (다른 탭의 명시적 로그인)으로 다시 열리지 않는다.
   */
  function recheck() {
    // 다른 창의 준비를 기다리는 중이면 그 기다림도 지금 다시 본다(기록이 바뀌었을 수 있다).
    rouse();
    if (state === 'active') {
      const own = ownEnd(sessionId);
      if (own) endedElsewhere(own.status, own.reason, own.operation);
      return;
    }
    if (proofEntry && undecided()) {
      if (entryBinding && (ownEnd(entryBinding) || heard.has(entryBinding))) closeEntry();
      return;
    }
    const { records, unreadable } = readAll();
    if (unreadable) return;
    const record = blocking(records);
    if (!record) return;
    if (CLOSED.includes(state)) {
      // 이 문서가 이미 아는 것보다 나중의 기록만 따른다.
      if (record.operation === operation && record.status === state && record.session === sessionId) return;
      if (later({ operation, status: state }, record) !== record) return;
    } else if (!undecided()) {
      // 사유가 있는 unknown(저장소·진입 실패)은 기록이 생겨도 명시적 로그인만 받는다.
      return;
    }
    pendingLeaving = null;
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
    // 출처를 밝히지 않은 통지(이 형식 전의 문서)는 사람의 로그아웃으로 읽지 않는다.
    heard.set(data.session, { operation: Number.isFinite(data.operation) ? data.operation : 0,
      origin: ORIGINS.includes(data.origin) ? data.origin : null });
    if (state === 'active') {
      if (data.session !== sessionId) return;
      const own = ownEnd(sessionId), told = heard.get(data.session);
      if (own) endedElsewhere(own.status, own.reason, own.operation);
      else endedElsewhere(...heardState(told), told.operation);
      return;
    }
    // A013: 증명으로 들어가는 중에는 들은 것을 적어 둘 뿐, 자기 새 세션의 통지만 따른다.
    if (proofEntry && undecided()) {
      if (entryBinding && data.session === entryBinding) closeEntry();
      return;
    }
    recheck();
  }
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = event => noticed(event.data);
  } catch (e) {}
  addEventListener('storage', event => {
    if (event.key === null || event.key === END_KEY || (typeof event.key === 'string' && event.key.startsWith(END_PREFIX))) recheck();
  });
  // 통지가 오지 않는 길(BroadcastChannel이 없고 종료 기록이 쿠키에만 남은 경우)에도 사람이 이 문서로 돌아오는 순간(창 초점,
  // 탭 표시, 뒤로 가기 캐시 복원) 기록을 다시 본다 — 무엇을 따를지는 recheck가 문서의 상태에 따라 정한다.
  addEventListener('focus', recheck);
  addEventListener('pageshow', event => { if (event.persisted) recheck(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });

  /** 인증 서버로 이동한다 — 닿는지 먼저 본다. 닿지 않으면 이동하지 않고, 같은 버튼으로 다시 할 수 있는 문장을 준다. */
  async function toIdp(url) {
    if (!await idpReachable()) throw new Error('인증 서버에 연결하지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
    moved = true;
    location.href = url;
  }

  /**
   * 로그인·계정 전환·가입 시작(U5S-REQ-09, S7-U5 세션 종료 설계 3.2). 누를 때마다 이 브라우저의 지금 세션을 서버에 먼저
   * 묻는다(`/api/me`) — 무엇을 할지는 그 답과 이 브라우저의 기록이 정한다:
   *
   *   살아 있는 세션 + 그 세션의 기록 없음(기록이 없거나 다른 세션의 것뿐)  → 그 세션으로 들어간다. 추가 클릭도 재인증도 없다.
   *   살아 있는 세션 + 그 세션의 사람의 로그아웃 기록(또는 들은 로그아웃)   → 재인증, 사유 logout_unfinished
   *   살아 있는 세션 + 믿을 수 없는 저장소 / 읽을 수 없는 기록              → 재인증, 사유 storage_untrusted / record_unreadable
   *   세션 없음(401) + 사람의 로그아웃 기록 또는 믿을 수 없는 저장소·기록    → 재인증(끝낼 세션은 없다 — 서버가 SSO를 알아내 끝낸다)
   *   세션 없음(401) + 그 밖(서버가 끝낸 세션의 기록, 기록 없음)            → 평범한 로그인 링크
   *   계정 전환                                                            → 재인증, 사유 switch_account
   *   확인 실패(5xx·시간 초과·연결)                                         → 안내, 같은 버튼으로 다시
   *
   * 재인증은 사유를 밝힌 POST로만 시작한다: 서버가 그 세션을 감사와 함께 끝내고 인증 서버의 세션도 끝낸 뒤에 로그인 주소를
   * 준다 — 그 로그인은 자격을 실제로 입력해야 한다. 밝힌 세션이 쿠키의 세션과 다르면(그사이 다른 로그인) 서버는 아무것도
   * 끝내지 않고 거절하며, 다음 누름이 지금 세션을 다시 확인한다.
   */
  async function begin(kind) {
    let answer;
    try { answer = await send('/me'); }
    catch (error) { throw new Error(error.message + ' · 잠시 뒤 Login을 다시 누르세요.'); }
    const body = answer.body || {};
    const id = (answer.status === 200 || answer.status === 403) && typeof body.sessionId === 'string' && body.sessionId
      ? body.sessionId : null;
    if (!id && answer.status !== 401) throw new Error('세션을 확인하지 못했습니다. 잠시 뒤 Login을 다시 누르세요.');

    const { records, unreadable } = readAll();
    const own = id ? records.get(id) || null : null, told = id ? heard.get(id) || null : null;
    // 그 세션의 Log out 준비가 다른 창에서 살아 있다(A017·SEB-F06): 어느 버튼이든 그 세션으로 들어가지도, 끝내지도 않는다 —
    // 끝내면 그 창의 저장하지 못한 글을 잃고, 들어가면 떠나려는 사람의 세션으로 일하게 된다. 그 창의 결과를 기다린다. 저장소를
    // 믿을 수 없는 브라우저에서도 같다(그 경우 준비가 끝난 뒤의 판정은 저장소 규칙이 한다).
    if (own && own.status === 'leaving' && await leavingAlive(own)) throw new Error(PREPARING_ELSEWHERE);
    if (kind === 'login' && id) {
      if (reliable && !unreadable && !own && !told) {
        let read;
        try { read = readIdentity(answer); }
        catch (error) { throw new Error(error.message + ' · "다른 계정으로 로그인"을 눌러 다시 로그인하세요.'); }
        // 이 명시적 확인은 성공한 증명 진입처럼 앞선 세션의 기록만 넘겨받는다.
        state = 'unknown'; reason = null; sessionId = null; operation = 0; pendingLeaving = null;
        if (adopt(read.id, read.identity, true)) { moved = true; location.href = home(cached); return; }
        throw new Error('그사이 이 로그인 세션의 종료가 기록되었습니다. 버튼을 다시 눌러 주세요.');
      }
    }

    let why = null;
    if (kind === 'switch') why = 'switch_account';
    else if (kind === 'login') {
      const human = id ? !!own && own.origin === 'logout' || !!told && told.origin === 'logout'
        : !!blocking(records) || [...records.values()].some(record => record.status === 'leaving');
      // 저장소 자체를 믿을 수 없으면(읽기·쓰기 실패) 그것이 사유다. 저장소는 멀쩡한데 기록만 읽을 수 없거나 출처가 없으면
      // 기록의 문제다. 어느 쪽이든 떠났는지 알 수 없는 것이고, 서버는 둘을 재인증으로 적는다.
      if (human) why = 'logout_unfinished';
      else if (!reliable) why = 'storage_untrusted';
      else if (unreadable || own || told) why = 'record_unreadable';
    }
    if (kind === 'login' && !why) return toIdp(`${API}/auth/login`);
    if (kind === 'register' && !id) return toIdp(`${API}/auth/register`);

    // 401을 받은 문서는 지금 쿠키의 세션을 모른다: 결속 없이 보낸다(서버는 끝낼 세션이 있을 때에만 결속을 요구한다).
    try {
      answer = kind === 'register' ? await send('/auth/register', { method: 'POST', session: id })
        : await send('/auth/login', { method: 'POST', session: id, json: { intent: 'reauthenticate', reason: why } });
    } catch (error) { throw new Error(error.message + ' · 잠시 뒤 다시 눌러 주세요.'); }
    const target = answer.status === 200 && answer.body && typeof answer.body.location === 'string' ? answer.body.location : null;
    if (target && new URL(target, location.origin).origin === location.origin) return toIdp(target);
    // 랜딩의 end_unconfirmed와 같은 사정·같은 안내다: 답을 잃은 종료는 저절로 확인되지 않으므로 관리자에게 넘긴다.
    if (answer.code === 'AUTH_IDP_END_UNCONFIRMED')
      throw new Error('이전 로그인 종료를 확인하지 못했습니다. 이 상태는 기다려도 풀리지 않을 수 있으니 관리자에게 문의하세요. Login을 다시 누를 수는 있습니다.');
    if (answer.code === 'AUTH_SESSION_MISMATCH' || answer.code === 'AUTH_SESSION_REQUIRED')
      throw new Error('이 브라우저의 로그인 세션이 바뀌어 로그인을 시작하지 않았습니다. 버튼을 다시 눌러 주세요.');
    throw new Error(answer.status === 409 ? '다른 요청과 겹쳐 로그인을 시작하지 못했습니다. 버튼을 다시 눌러 주세요.'
      : '로그인을 시작하지 못했습니다. 잠시 뒤 다시 눌러 주세요.');
  }

  /**
   * 서버가 확인한 세션 교체: 이 브라우저의 쿠키가 다른 로그인의 것이 되었다(결속 불일치, 또는 이 세션에 묶어 보낸 요청에
   * 다른 계정의 답이 왔다). 이 문서만 닫는다 — 종료 기록도 로그아웃 POST도 없다. 그 POST는 다른 로그인의 세션을 겨눌
   * 뿐이고, 기록은 쓸모가 없다(그 세션의 식별값은 다시 살아 돌아오지 않고, 새 문서는 그 로그인의 것이다). 떠나려는 중이던
   * 세션이면 그 표지는 치운다. 같은 세션의 다른 문서에는 출처 replaced로 한 번 알린다(그 문서들도 쓸 수 없는 세션이다).
   */
  function closeReplaced() {
    const session = sessionId, op = nextOperation();
    removeEnd(session);
    tell(session, op, 'replaced');
    endedElsewhere('unconfirmed', 'replaced', op);
  }

  return {
    KC,

    /**
     * `onHold(text)`: 다른 창의 로그아웃 준비가 살아 있어 이 문서가 그 결과를 기다리는 동안 보일 문장(끝나면 null). 이 문서는
     * 그동안 들어가지 않고 아무것도 끝내지 않는다 — 그 창이 편집으로 돌아가면 클릭 없이 이어서 들어간다.
     */
    async init({ retry = false, onRetry, onHold } = {}) {
      if (typeof onHold === 'function') holdListener = onHold;
      if (entered) return cached;
      if (!initializing) {
        initializing = (async () => {
          const delays = retry || proof || entryBinding ? [1000, 2000, 4000] : [];
          for (let attempt = 0; ; attempt += 1) {
            try { return await enter(); }
            catch (error) {
              if (!undecided() || moved) return null;
              if (attempt >= delays.length || !(error.retryable || ['network', 'timeout'].includes(error.kind))) {
                if (entryBinding || entryLost) return entryUnconfirmed();
                throw error;
              }
              if (typeof onRetry === 'function') onRetry();
              await new Promise(resolve => setTimeout(resolve, delays[attempt]));
              // 기다리는 사이의 기록을 다시 본다: 증명으로 들어가는 문서는 자기 새 세션의 종료만, 그 밖의 문서는 평소대로.
              recheck();
              if (!undecided() || moved) return null;
            }
          }
        })()
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

    /** 랜딩의 Login. `{ prompt: 'login' }`은 계정 전환이다(switchAccount와 같다). */
    async login(opts = {}) {
      return begin(opts && opts.prompt === 'login' ? 'switch' : 'login');
    },

    /** 다른 계정으로 로그인: 지금 세션(있다면)을 끝내고, 이름을 칠 수 있는 로그인 화면으로 간다. */
    async switchAccount() {
      return begin('switch');
    },

    async register() {
      return begin('register');
    },

    /** 인증 서버가 지금 답하는가(랜딩의 상태 줄). 한도 안에 답이 없으면 false다. */
    idpReachable() { return idpReachable(); },

    /**
     * 평소의 진입에서 세션이 없을 때 스스로 로그인 화면으로 보낸다 — 의사가 로그인 단추를 한 번 더 누르게 하지 않는다.
     * 근거는 하나뿐이다: 저장소를 믿을 수 있고 사람의 로그아웃 기록이 없는 문서에서 서버가 방금 "세션 없음"(401)이라고
     * 답했다. 그런 기록이 있거나(명시적 로그아웃·미확인 종료), 저장소를 믿을 수 없거나, 확인이 실패했으면(5xx·시간 초과·
     * 진입 증명 거절) 시작하지 않는다 — 그때는 랜딩이 사정을 보이고 사람이 누른다. 방금의 자동 로그인이 세션 없이 되돌아온
     * 탭도 다시 보내지 않는다. 시작했으면 true다(부른 쪽은 그 뒤 화면을 그리지 않는다).
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
     * Log out을 누른 그 순간의 표지(A017): 이 세션에 "떠나려는 중"을 남긴다 — 초안 저장이나 나가 있는 확정의 답을 기다리기
     * **전에** 부른다. 그 기다림 사이에 창이 닫혀도 떠나려던 뜻이 남아, 다음 사람이 연 새 문서가 앞사람의 세션으로 스스로
     * 들어가지 않는다. 이 표지는 종료가 아니다: 다른 탭도 뷰어도 닫거나 멈추지 않고 아무에게도 알리지 않는다. 표지와 함께
     * 이 문서가 살아 있는 동안 쥐는 잠금을 건다 — 새 문서는 그것으로 "그 창이 아직 있다"를 안다(있으면 아무것도 끝내지 않는다).
     * 준비 번호는 페이지가 그 Log out 누름에 붙인 값이다. 남겼으면 true다.
     */
    leaving(preparation) {
      if (state !== 'active' || !sessionId || typeof preparation !== 'string' || !preparation) return false;
      if (cached && cached.demo) return false;
      const entry = { session: sessionId, release: null };
      leavings.set(preparation, entry);
      try {
        const request = navigator.locks && navigator.locks.request('kin-leaving:' + preparation, { mode: 'exclusive' },
          () => leavings.get(preparation) !== entry ? undefined : new Promise(release => { entry.release = release; }));
        if (request) request.catch(() => {});
      } catch (e) {}
      return writeEnd({ session: sessionId, operation: nextOperation(), status: 'leaving', origin: 'logout', preparation });
    },

    /**
     * Back to Editing: 자기 준비의 "떠나려는 중"만 지운다. 그사이 실제 종료로 올라간 기록이나 다른 준비·다른 세션의 기록은
     * 건드리지 않는다.
     */
    cancelLeaving(preparation) {
      const entry = leavings.get(preparation);
      if (!entry) return;
      leavings.delete(preparation);
      if (entry.release) entry.release();
      const own = readAll().records.get(entry.session);
      if (own && own.status === 'leaving' && own.preparation === preparation) removeEnd(entry.session);
    },

    /**
     * 업무 화면의 Log out — 이 세션에 묶인 명시적 종료 의도다. 네트워크를 기다리기 전에 종료 기록을 남기고(떠나려는 중이
     * 있었으면 여기서 실제 종료로 올린다) 이 문서의 신원을 내려놓으며 같은 세션의 다른 문서에 한 번 알린다. 페이지가 맡긴
     * 일(beforeLogoutPost)을 한도 안에서 기다린 뒤 이 세션을 밝힌 POST 하나를 보내고, 서버의 답(KIN 세션 폐기의 확인)을
     * 기록하는 대로 랜딩으로 한 번 옮긴다 — 그 뒤의 IdP 처리는 서버의 일이고 이 문서는 기다리지 않는다. 같은 문서의 겹친
     * 호출은 새 POST 없이 진행 중인 종료를 나눈다. 일하는 중이 아닌 문서(이미 닫혔다, 들어간 적 없다)와 다른 문서가 이
     * 세션의 종료를 이미 기록한 문서는 POST 없이 떠난다 — 다시 보내는 것은 랜딩의 Retry Log Out뿐이다. 데모는 서버 세션이
     * 없어 로컬만 끝낸다.
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
      writeEnd({ session, operation: op, status: 'ending', origin: 'logout' });
      closeHere('ending', null, op);
      tell(session, op, 'logout');
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
     * (AUTH_SESSION_ENDED)고 답했으면 POST 없이 종료 확인으로 닫고(기록의 출처는 server_end다 — 사람이 누른 것이 아니다),
     * 결속 불일치(AUTH_SESSION_MISMATCH)는 세션 교체로 닫는다. 그 밖의 것은 여기서 아무것도 닫지 않는다: 코드 없는 401,
     * 자격 없음, 결속 누락(428), 403·409·5xx는 그 요청 하나의 실패이고 종료의 증거가 아니다 — 쿠키도 기록도 건드리지 않는다.
     */
    authFailure(failure) {
      if (!failure || state !== 'active' || failure.session !== sessionId) return;
      // 데모에는 끝낼 서버 세션이 없다 — 서버 없는 둘러보기의 거절은 세션 사건이 아니다.
      if (cached && cached.demo) return;
      if (failure.code === 'AUTH_SESSION_ENDED') {
        const session = sessionId, op = nextOperation();
        writeEnd({ session, operation: op, status: 'confirmed', origin: 'server_end' });
        tell(session, op, 'server_end');
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

    /**
     * 랜딩의 Retry Log Out: 누를 때마다 기록된 세션을 밝힌 POST 하나(누르는 동안의 겹친 호출은 나눈다). 이동하지 않는다.
     * 기록은 그 세션 자신의 키에만 쓴다 — 그사이 이 브라우저의 세션이 다른 로그인으로 바뀌었어도 그 로그인의 기록은 건드리지
     * 않고, 서버가 결속 불일치로 답하면 이 기록은 치워진다(conclude).
     */
    retryLogout() {
      if (retrying) return retrying;
      if (!CLOSED.includes(state) || !sessionId) return Promise.resolve(null);
      const session = sessionId, op = nextOperation();
      /**
       * A014·SEB-F05: 기록은 그 세션의 기록이 아직 이 브라우저에 있을 때만 고쳐 쓴다. 없으면(이 브라우저의 나중 명시적 로그인이
       * 넘겨받아 지웠다) 이 랜딩은 지난 세션의 것이다 — 요청은 그대로 보내되(서버가 그 세션을 아직 알면 끝내고, 모르면 아무것도
       * 하지 않는다) 기록을 다시 만들지 않는다. 다시 만들면 사람의 로그아웃 기록이 되살아나 살아 있는 새 세션의 새 탭·뷰어가
       * 모두 랜딩에 선다. 결과도 같은 이유로 그 세션의 기록이 있을 때만 남는다(conclude).
       */
      if (readAll().records.get(session)) writeEnd({ session, operation: op, status: 'ending', origin: 'logout' });
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
