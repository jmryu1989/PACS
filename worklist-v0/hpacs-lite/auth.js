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

  // 콜백 주소는 성공뿐 아니라 실패·재방문에서도 즉시 지운다.
  // code/state를 주소창과 히스토리에 남기지 않고, 같은 콜백을 새 로그인으로 오인하지 않는다.
  const cleanCallbackUrl = () => history.replaceState({}, '', location.pathname + location.hash);

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

  // actor 식별자는 이메일 그대로 유지한다. 성명은 화면에서만 쓰는 별도 값이다.
  const displayNameOf = c =>
    [c?.family_name, c?.given_name].filter(Boolean).join('') || c?.name ||
    c?.email || c?.preferred_username || '';

  function store(tok) {
    const c = claimsOf(tok.access_token);
    S.setItem('kin-at', tok.access_token);
    // OHIF의 DICOM 요청을 프록시 auth_request가 검증하기 위한 같은 출처 쿠키.
    // HttpOnly가 아니므로 임시책이고, BFF 도입 때 서버 세션 쿠키로 대체한다.
    document.cookie = `kin_at=${encodeURIComponent(tok.access_token)}`
      + `; Path=/; Secure; SameSite=Strict; Max-Age=${tok.expires_in}`;
    if (tok.refresh_token) S.setItem('kin-rt', tok.refresh_token);
    if (tok.id_token) S.setItem('kin-it', tok.id_token);
    // 만료 30초 전을 만료로 친다 — 네트워크 왕복 중에 죽는 걸 막는다
    S.setItem('kin-exp', String(Date.now() + (tok.expires_in - 30) * 1000));
    S.setItem('kin-user', c?.email ?? c?.preferred_username ?? '');
    S.setItem('kin-roles', JSON.stringify(c?.realm_access?.roles ?? []));
    S.removeItem('kin-demo');
  }

  function clear() {
    ['kin-at', 'kin-rt', 'kin-it', 'kin-exp', 'kin-user', 'kin-roles', 'kin-demo', 'kin-verifier', 'kin-state']
      .forEach(k => S.removeItem(k));
    document.cookie = 'kin_at=; Path=/; Max-Age=0; Secure; SameSite=Strict';

    // sessionStorage는 탭마다 따로라서 워크리스트 로그아웃만으로는 열린 뷰어가 모른다.
    // 같은 출처 채널과 storage 폴백을 함께 울려 모든 뷰어 탭의 환자명 title을 지운다.
    try {
      const channel = new BroadcastChannel('kin-session');
      channel.postMessage({ type: 'session-ended' });
      channel.close();
    } catch (e) { /* 구형 브라우저는 아래 storage 이벤트만 쓴다. */ }
    try {
      localStorage.setItem('kin-session-ended', String(Date.now()));
      localStorage.removeItem('kin-session-ended');
    } catch (e) {}
  }

  return {
    KC,

    /** 로그인 상태? {user, roles, demo} 또는 null */
    session() {
      if (S.getItem('kin-demo')) return { user: S.getItem('kin-user') || 'demo', roles: [], demo: true };
      if (!S.getItem('kin-at')) return null;
      const user = S.getItem('kin-user') || '';
      return {
        user,
        displayName: displayNameOf(claimsOf(S.getItem('kin-at'))) || user,
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

    /** 로그인 화면에서 돌아왔을 때 ?code= 를 토큰으로 바꾼다. 재로그인이 필요하면 'retry' */
    async handleRedirect() {
      const p = new URLSearchParams(location.search);
      const code = p.get('code');
      if (!code) {
        if (p.get('error')) {
          const message = p.get('error_description') || p.get('error');
          cleanCallbackUrl();
          S.removeItem('kin-verifier'); S.removeItem('kin-state');
          throw new Error(message);
        }
        return false;
      }

      const savedState = S.getItem('kin-state');

      // 성공한 콜백을 뒤로가기/새 탭에서 다시 연 경우다. 이미 세션이 있으면 boot가
      // 그대로 입장시키고, 세션이 없는 새 탭이면 깨끗한 주소에서 로그인을 한 번 재개한다.
      if (!savedState) {
        cleanCallbackUrl();
        S.removeItem('kin-verifier');
        return S.getItem('kin-at') ? false : 'retry';
      }

      // state 확인 — 이걸 빼면 CSRF로 남의 코드를 우리 세션에 심을 수 있다
      if (p.get('state') !== savedState) {
        cleanCallbackUrl();
        S.removeItem('kin-verifier'); S.removeItem('kin-state');
        throw new Error('state 불일치 — 로그인을 다시 시도하세요');
      }

      const verifier = S.getItem('kin-verifier');
      cleanCallbackUrl();
      S.removeItem('kin-verifier'); S.removeItem('kin-state');
      if (!verifier) throw new Error('로그인 검증 정보 없음 — 로그인을 다시 시도하세요');

      const c = await config();
      const res = await fetch(c.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: CLIENT, code,
          redirect_uri: REDIRECT, code_verifier: verifier,
        }),
      });
      const tok = await res.json();
      if (!res.ok) throw new Error(tok.error_description ?? tok.error ?? '토큰 교환 실패');
      store(tok);
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
      const redirect = location.origin + location.pathname.replace(/[^/]*$/, 'index.html');
      if (demo) { clear(); location.replace(redirect); return; }
      try {
        const c = await config();
        // 앱에서 이미 사용자 확인을 받았으므로 refresh token을 POST 본문으로 보내
        // Keycloak 세션을 바로 끊는다. GET URL에 refresh token을 넣으면 서버·브라우저
        // 기록에 남고, 토큰 힌트 없이 RP 로그아웃을 열면 확인 화면이 한 번 더 뜬다.
        if (rt) {
          const res = await fetch(c.end_session_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: CLIENT, refresh_token: rt }),
          });
          if (res.ok) {
            clear();
            location.replace(redirect);
            return;
          }
        }

        // refresh token이 없는 오래된 탭의 안전망. 토큰은 URL에 싣지 않는다.
        // Keycloak의 확인 화면을 거쳐 지정한 로그인 화면으로 돌아간다.
        const q = new URLSearchParams({
          client_id: CLIENT,
          post_logout_redirect_uri: redirect,
        });
        clear();
        location.replace(`${c.end_session_endpoint}?${q}`);
      } catch (e) {
        clear();
        location.replace(redirect);
      }
    },
  };
})();
