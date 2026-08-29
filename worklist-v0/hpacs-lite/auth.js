/**
 * KIN 인증 — Keycloak OIDC Authorization Code + PKCE
 *
 * 왜 라이브러리(keycloak-js)를 안 쓰나:
 *  - 흐름이 80줄이면 끝난다. 이 정도는 직접 보는 편이 배우기에도 낫다.
 *  - 외부 스크립트 하나 줄이면 그만큼 공급망이 줄어든다.
 *
 * 왜 PKCE인가:
 *  브라우저 앱은 비밀키를 숨길 수 없다(소스가 다 보인다). 그래서 client_secret 없는
 *  public 클라이언트로 등록하고, 대신 요청마다 일회용 비밀(code_verifier)을 만들어
 *  그 해시(code_challenge)를 먼저 보낸다. 인가 코드를 가로챈 공격자도 원본 verifier가
 *  없으면 토큰으로 바꿀 수 없다.
 *
 * 토큰은 sessionStorage에 둔다. XSS가 나면 털린다 — 즉 이 앱에서 XSS는 곧 계정 탈취다.
 * (더 안전한 방법은 HttpOnly 쿠키 + BFF지만, 그건 리버스 프록시를 세운 뒤의 일이다.)
 */
const KinAuth = (() => {
  /**
   * Keycloak 주소.
   *
   * 예전엔 `:8080`을 직접 박았다 — 화면(8042)과 인증(8080)과 API(3000)가 각각 다른
   * 출처였고, 그래서 CORS를 계속 맞춰야 했고 토큰은 sessionStorage 말고 둘 곳이 없었다.
   *
   * 이제 리버스 프록시가 셋을 한 출처로 모은다. 같은 출처의 `/auth`를 쓰므로
   * 주소를 알 필요가 없다 — 어디에 배포하든 그 호스트가 곧 인증 서버다.
   * (프록시 없이 8042로 직접 열었을 때만 옛 경로로 되돌아간다)
   */
  const PROXIED = location.port !== '8042';
  const KC = PROXIED
    ? `${location.origin}/auth`
    : `${location.protocol}//${location.hostname || 'localhost'}:8080`;
  const REALM = 'kin';
  const CLIENT = 'kin-web';
  const REDIRECT = location.origin + location.pathname;   // index.html 자기 자신
  const S = sessionStorage;

  let conf = null;
  async function config() {
    if (conf) return conf;
    const res = await fetch(`${KC}/realms/${REALM}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error('Keycloak 응답 없음 (' + res.status + ')');
    return (conf = await res.json());
  }

  // ── PKCE 도구 ──
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomStr = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
  const sha256 = async s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

  const claimsOf = tok => {
    try {
      const p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(p.padEnd(p.length + (4 - p.length % 4) % 4, '=')))));
    } catch (e) { return null; }
  };

  function store(tok) {
    const c = claimsOf(tok.access_token);
    S.setItem('kin-at', tok.access_token);
    if (tok.refresh_token) S.setItem('kin-rt', tok.refresh_token);
    // 만료 30초 전을 만료로 친다 — 네트워크 왕복 중에 죽는 걸 막는다
    S.setItem('kin-exp', String(Date.now() + (tok.expires_in - 30) * 1000));
    S.setItem('kin-user', c?.email ?? c?.preferred_username ?? '');
    S.setItem('kin-roles', JSON.stringify(c?.realm_access?.roles ?? []));
    S.removeItem('kin-demo');
  }

  function clear() {
    ['kin-at', 'kin-rt', 'kin-exp', 'kin-user', 'kin-roles', 'kin-demo', 'kin-verifier', 'kin-state']
      .forEach(k => S.removeItem(k));
  }

  return {
    KC,

    /** 로그인 상태? {user, roles, demo} 또는 null */
    session() {
      if (S.getItem('kin-demo')) return { user: S.getItem('kin-user') || 'demo', roles: [], demo: true };
      if (!S.getItem('kin-at')) return null;
      return {
        user: S.getItem('kin-user'),
        roles: JSON.parse(S.getItem('kin-roles') ?? '[]'),
        demo: false,
      };
    },

    has(role) {
      const s = this.session();
      if (!s) return false;
      if (s.demo) return true;                       // 데모는 서버를 안 부르므로 화면만 다 열어둔다
      return s.roles.includes(role) || s.roles.includes('admin');
    },

    /**
     * Keycloak 로그인 화면으로 보낸다.
     * opts.prompt === 'login' 이면 이미 로그인된 세션이 있어도 아이디를 다시 묻는다.
     * 공용 판독 PC에서 앞사람 계정으로 그냥 들어가지는 걸 막는다.
     */
    async login(opts = {}) {
      const c = await config();
      const verifier = randomStr();
      const state = randomStr();
      S.setItem('kin-verifier', verifier);
      S.setItem('kin-state', state);
      const challenge = b64url(await sha256(verifier));
      const q = new URLSearchParams({
        client_id: CLIENT, response_type: 'code', scope: 'openid profile email',
        redirect_uri: REDIRECT, state,
        code_challenge: challenge, code_challenge_method: 'S256',
      });
      if (opts.prompt) q.set('prompt', opts.prompt);
      location.href = `${c.authorization_endpoint}?${q}`;
    },

    /** 로그인 화면에서 돌아왔을 때 ?code= 를 토큰으로 바꾼다. 처리했으면 true */
    async handleRedirect() {
      const p = new URLSearchParams(location.search);
      const code = p.get('code');
      if (!code) {
        if (p.get('error')) throw new Error(p.get('error_description') || p.get('error'));
        return false;
      }
      // state 확인 — 이걸 빼면 CSRF로 남의 코드를 우리 세션에 심을 수 있다
      if (p.get('state') !== S.getItem('kin-state')) throw new Error('state 불일치 — 로그인을 다시 시도하세요');

      const c = await config();
      const res = await fetch(c.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: CLIENT, code,
          redirect_uri: REDIRECT, code_verifier: S.getItem('kin-verifier'),
        }),
      });
      const tok = await res.json();
      if (!res.ok) throw new Error(tok.error_description ?? tok.error ?? '토큰 교환 실패');
      store(tok);
      S.removeItem('kin-verifier'); S.removeItem('kin-state');
      history.replaceState({}, '', location.pathname);   // 주소창에서 code 지우기
      return true;
    },

    /** 유효한 access token. 만료됐으면 refresh, 그것도 안 되면 null */
    async token() {
      if (S.getItem('kin-demo')) return null;
      const at = S.getItem('kin-at');
      if (!at) return null;
      if (Date.now() < +(S.getItem('kin-exp') ?? 0)) return at;

      const rt = S.getItem('kin-rt');
      if (!rt) { clear(); return null; }
      try {
        const c = await config();
        const res = await fetch(c.token_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: rt }),
        });
        if (!res.ok) { clear(); return null; }
        store(await res.json());
        return S.getItem('kin-at');
      } catch (e) { clear(); return null; }
    },

    /** 서버 없이 둘러보는 모드 (GitHub Pages 공유용) */
    demo(name = 'demo@kin.kr') {
      clear();
      S.setItem('kin-demo', '1');
      S.setItem('kin-user', name);
    },

    async logout() {
      const rt = S.getItem('kin-rt');
      const demo = S.getItem('kin-demo');
      clear();
      if (demo) { location.href = 'index.html'; return; }
      try {
        const c = await config();
        // Keycloak 세션까지 끊는다. 이걸 안 하면 다시 로그인 버튼을 눌렀을 때
        // 아이디도 안 묻고 그냥 들어가진다 — 병원 공용 PC에서 사고가 난다.
        const q = new URLSearchParams({
          client_id: CLIENT,
          post_logout_redirect_uri: location.origin + location.pathname.replace(/[^/]*$/, 'index.html'),
        });
        if (rt) q.set('refresh_token', rt);
        location.href = `${c.end_session_endpoint}?${q}`;
      } catch (e) { location.href = 'index.html'; }
    },
  };
})();
