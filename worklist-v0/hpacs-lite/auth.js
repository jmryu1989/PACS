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

  function clearLocal() {
    [...LEGACY_KEYS, 'kin-demo'].forEach(key => S.removeItem(key));
    document.cookie = 'kin_at=; Path=/; Max-Age=0; Secure; SameSite=Strict';
    cached = null;
    initialized = true;
    broadcastEnded();
  }

  async function loadSession() {
    if (S.getItem('kin-demo')) {
      cached = {
        state: 'approved', demo: true, user: 'demo', displayName: 'demo',
        roles: ['radiologist', 'technician', 'admin'], institution: 'demo',
      };
      return cached;
    }

    const response = await fetch(`${API}/me`, { headers: { 'X-KIN-CSRF': '1' } });
    if (response.status === 401) {
      cached = null;
      return cached;
    }
    const body = await response.json().catch(() => ({}));
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

    async login(opts = {}) {
      const query = opts.prompt ? `?prompt=${encodeURIComponent(opts.prompt)}` : '';
      location.href = `${API}/auth/login${query}`;
    },

    async register() {
      location.href = `${API}/auth/register`;
    },

    demo() {
      clearLocal();
      S.setItem('kin-demo', '1');
      initialized = false;
    },

    async logout() {
      const demo = !!S.getItem('kin-demo');
      const redirect = location.origin + location.pathname.replace(/[^/]*$/, 'index.html');
      try {
        if (!demo) await fetch(`${API}/auth/logout`, {
          method: 'POST',
          headers: { 'X-KIN-CSRF': '1' },
        });
      } catch (e) {
        // 네트워크가 죽어도 브라우저는 로그인 화면으로 돌아간다. 서버 행은 idle 수거가 맡는다.
      } finally {
        clearLocal();
        location.replace(redirect);
      }
    },
  };
})();
