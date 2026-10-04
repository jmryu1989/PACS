/* KIN 세션 결속 전송 (S7-U5, U5S-REQ-12). 요청을 보내는 일만 한다 — 답을 화면에 쓰는 일은 KinWorkContext.commit의 몫이다.
 *
 * 맡는 것은 넷이다.
 *   · 승인: 요청은 자기 문맥(KinWorkContext.capture 또는 prepare가 내준 것)이 지금 통과할 때만 떠난다. 로그아웃 준비 중의
 *     일반 요청, 끝난 세션의 요청, 옮겨 간 검사의 요청은 네트워크에 닿지 않는다.
 *   · 결속: 모든 요청에 그 작업이 시작될 때의 세션 식별값을 `X-KIN-Session`으로 싣는다. 식별값 없는 요청은 보내지 않는다 —
 *     결속 없는 요청은 최초 신원 확인 하나뿐이고 그것은 auth.js만 한다(U5S-REQ-09).
 *   · 한도와 취소: 머리글과 본문을 합쳐 한 한도 안에서 끝낸다. 한도는 요청의 종류가 정한다 — 초안 명령은 10초, 그 밖의
 *     업무 API는 60초, 영상·DICOM·스트림은 부른 쪽이 준 것만 건다(초안의 10초를 영상 전송에 일괄로 씌우면 느린 영상이
 *     실패로 보인다). 부른 쪽의 signal, 한도, 문맥이 무효가 된 읽기는 같은 AbortController로 끊는다. 쓰기는 문맥이 무효가
 *     되어도 끊지 않는다 — 서버에서 이미 일어났을 수 있는 일의 결과를 모르게 만들 뿐이다. 그 결과를 화면에 쓸지는 commit이
 *     정한다.
 *   · 세션 종료 신호의 귀속: 서버가 "그 세션은 끝났다"(401 AUTH_SESSION_ENDED) 또는 "쿠키가 다른 로그인의 것이다"
 *     (AUTH_SESSION_MISMATCH)라고 답한 것만 그 요청이 실은 세션의 종료 신호로 알린다. 이전 세션의 늦은 답이 지금 세션을
 *     끝내지 못한다(받는 쪽이 세션을 대조한다). 그 밖의 401·403·409·428·5xx와 시간 초과·연결 실패는 그 요청 하나의
 *     실패다 — 한 번의 실패나 일시 오류로 화면을 닫지 않는다.
 *
 * Response의 메서드를 바꾸지 않고, 임의의 대입을 막아 준다고 하지도 않는다. 답은 값으로 돌려준다:
 *   { ok, status, code, body, headers, auth, incomplete }  (read: 'stream'이면 body 대신 stream)
 * `auth`는 그 답이 세션 종료 신호였다는 뜻이다(이미 알렸다 — 부른 쪽은 그 답을 실패로 그리지 않는다).
 * 실패는 `transport`(not-admitted·unbound·cancelled·stale·timeout·network)와 `sent`(요청이 떠났는가)를 가진 오류로 던진다.
 */
(function (root) {
  'use strict';

  // 종류별 한도(ms). 0은 "부른 쪽이 준 것만"이다.
  const DEADLINES = Object.freeze({ draft: 10000, api: 60000, media: 0 });
  const READS = ['json', 'text', 'blob', 'arrayBuffer', 'stream', 'none', 'response'];
  const MEDIA_READS = ['blob', 'arrayBuffer', 'stream', 'response'];
  // nginx의 auth_request는 401·403만 넘길 수 있어, 보호된 DICOM 경로의 결속 불일치는 코드 머리글이 붙은 403으로 온다.
  const MISMATCH_STATUSES = [403, 409];

  /** 서버가 이 요청의 세션에 대해 말한 종료 신호인가. 판정은 코드로만 한다 — 상태 번호만으로는 세션을 끝내지 않는다. */
  function endSignal(status, code) {
    return (status === 401 && code === 'AUTH_SESSION_ENDED')
      || (MISMATCH_STATUSES.includes(status) && code === 'AUTH_SESSION_MISMATCH');
  }

  // DICOM auth_request keeps the AUTH_* header but maps temporary failures to 403.
  // Consumers share this classification; only the transport reports an actual end.
  function refusal(reply) {
    const status = reply?.status;
    const code = reply?.headers?.get?.('X-KIN-Auth-Code')
      || reply?.getResponseHeader?.('X-KIN-Auth-Code')
      || reply?.request?.getResponseHeader?.('X-KIN-Auth-Code') || reply?.code;
    if (endSignal(status, code)) return 'ended';
    if (![401, 403].includes(status)) return null;
    return typeof code === 'string' && code.startsWith('AUTH_') ? 'temporary' : 'denied';
  }

  function responseError(reply, message = '요청을 완료하지 못했습니다.', denied = '검사 접근이 거절되었습니다. 접근 권한을 확인하세요.') {
    const kind = refusal(reply);
    return Object.assign(new Error(kind === 'temporary' ? '연결을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.'
      : kind === 'denied' ? denied : message), {
      status: reply?.status, code: reply?.headers?.get?.('X-KIN-Auth-Code') || reply?.code,
      retryable: kind === 'temporary' || !kind && (!reply || reply.status === 429 || reply.status >= 500),
    });
  }

  /** 요청의 종류: 부른 쪽이 밝힌 것, 아니면 읽는 방식과 주소로 가린다(`/api/` 밖은 DICOM·영상 경로다). */
  function kindOf(url, read, given) {
    if (given !== undefined) return Object.prototype.hasOwnProperty.call(DEADLINES, given) ? given : null;
    if (MEDIA_READS.includes(read)) return 'media';
    let path = String(url);
    try { path = new URL(path, 'http://kin.invalid').pathname; } catch (_) {}
    return path.startsWith('/api/') ? 'api' : 'media';
  }
  const MESSAGES = {
    'not-admitted': '지금 이 작업을 시작할 수 없어 요청을 보내지 않았습니다.',
    unbound: '세션 식별값이 없어 요청을 보내지 않았습니다.',
    cancelled: '요청을 취소했습니다.',
    stale: '작업 문맥이 바뀌어 요청을 취소했습니다.',
    timeout: '서버가 제한 시간 안에 답하지 않았습니다.',
    network: '서버에 연결하지 못했습니다.',
  };

  function failure(kind, sent) {
    const error = new Error(MESSAGES[kind]);
    error.name = kind === 'timeout' ? 'TimeoutError' : kind === 'network' ? 'TypeError' : 'AbortError';
    error.transport = kind;
    error.sent = sent;
    return error;
  }

  function create(options = {}) {
    const gate = options.gate;
    if (!gate || typeof gate.admits !== 'function' || typeof gate.onInvalidate !== 'function')
      throw new TypeError('KinSessionTransport.create: a work-context gate is required');
    // 다른 창의 요청을 대신 보내는 코드는 그 창의 fetch를 준다. 주지 않으면 이 문서의 fetch다(부를 때 찾는다).
    const send = options.fetch || ((input, init) => globalThis.fetch(input, init));
    const authFailure = typeof options.authFailure === 'function' ? options.authFailure : null;
    // 이 전송의 모든 요청에 한 한도를 주면(시험, 다른 창을 대신 조정하는 코드) 종류별 기본값 대신 그것을 쓴다.
    const fixedDeadline = options.deadlineMs;
    // A viewer may pause its UI scheduler after configuring the page transport.
    // Network deadlines must continue on the clock that admitted the request.
    const schedule = globalThis.setTimeout.bind(globalThis), unschedule = globalThis.clearTimeout.bind(globalThis);
    const open = new Set();

    // 문맥이 무효가 된 읽기는 여기서 끊는다. 쓰기는 남긴다(위 설명).
    gate.onInvalidate(() => {
      for (const operation of [...open])
        if (operation.abortWhenStale && !gate.admits(operation.context)) operation.cancel('stale');
    });

    function report(session, status, code) {
      if (!authFailure) return;
      try { authFailure({ session, status, code }); } catch (_) {}
    }

    function request(url, init = {}) {
      const read = init.read === undefined ? 'json' : init.read;
      if (!READS.includes(read)) return Promise.reject(new TypeError('KinSessionTransport.request: unknown read ' + String(read)));
      const kind = kindOf(url, read, init.kind);
      if (kind === null) return Promise.reject(new TypeError('KinSessionTransport.request: unknown kind ' + String(init.kind)));
      const context = init.context;
      if (!gate.admits(context)) return Promise.reject(failure('not-admitted', false));
      // 식별값은 작업이 시작될 때의 것이다. `session`은 사람이 명시로 시작한 복구 작업이 자기 결속을 줄 때만 쓴다.
      const session = init.session === undefined ? context.session : init.session;
      if (typeof session !== 'string' || !session) return Promise.reject(failure('unbound', false));

      const method = String(init.method || 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      headers.set('X-KIN-CSRF', '1');
      headers.set('X-KIN-Session', session);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const control = new AbortController();
      const operation = {
        context,
        abortWhenStale: init.abortWhenStale === undefined ? method === 'GET' || method === 'HEAD' : !!init.abortWhenStale,
        cause: null,
        cancel(cause) {
          if (operation.cause) return;
          operation.cause = cause;
          control.abort();
        },
      };
      const deadlineMs = init.deadlineMs !== undefined ? init.deadlineMs
        : fixedDeadline !== undefined ? fixedDeadline : DEADLINES[kind];
      const timer = deadlineMs > 0 ? schedule(() => {
        operation.cancel('timeout');
        // Response를 그대로 넘긴 요청은 본문이 언제 끝났는지 이 전송이 모른다 — 한도가 그 끝이다.
        if (read === 'response') finish();
      }, deadlineMs) : null;
      const outer = init.signal || null;
      const onAbort = () => operation.cancel('cancelled');
      if (outer) outer.addEventListener('abort', onAbort, { once: true });
      open.add(operation);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        open.delete(operation);
        if (timer !== null) unschedule(timer);
        if (outer) outer.removeEventListener('abort', onAbort);
      };
      const thrown = () => failure(operation.cause || 'network', true);

      return (async () => {
        if (outer && outer.aborted) operation.cancel('cancelled');
        // 취소가 먼저여서 보내지 않은 요청은 떠나지 않았다.
        if (operation.cause) { finish(); throw failure(operation.cause, false); }
        let response;
        try {
          // Keep the caller's Fetch policy (especially redirect: 'error' for uploads).
          // Binding headers, body encoding and the combined cancellation signal remain ours.
          const policy = {};
          for (const key of ['cache', 'credentials', 'mode', 'redirect', 'referrer', 'referrerPolicy',
            'integrity', 'keepalive', 'priority', 'duplex'])
            if (init[key] !== undefined) policy[key] = init[key];
          response = await send(url, {
            ...policy, method, headers, body, signal: control.signal,
          });
        } catch (_) {
          finish();
          throw thrown();
        }
        const status = response.status;
        const headerCode = response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('X-KIN-Auth-Code') : null;
        const answer = (fields) => Object.freeze({ ok: response.ok, status, code: null, body: null, headers: response.headers,
          auth: false, incomplete: false, ...fields });
        // An authenticated end in the headers is already known; a stalled error body cannot
        // postpone it. Body-only codes still use the same classification below, exactly once.
        const headerAuth = endSignal(status, headerCode);
        if (headerAuth) report(session, status, headerCode);

        if (read === 'response') {
          // 본문은 부른 쪽이 읽는다. 종료 신호는 머리글의 코드로만 가린다(본문을 여기서 읽으면 부른 쪽이 읽지 못한다) —
          // 서버는 AUTH_* 거절마다 같은 코드를 X-KIN-Auth-Code 머리글에도 싣는다.
          // 한도가 없으면 여기까지가 이 전송의 몫이다. 한도가 있으면 그 시각까지 같은 신호가 본문 읽기도 끊는다.
          if (timer === null) finish();
          return response;
        }

        if (!response.ok) {
          // 거절의 본문은 작다. 코드가 거기 실려 오므로 읽는 방식과 무관하게 여기서 읽는다.
          let parsed = null, incomplete = false;
          try {
            const text = await response.text();
            if (text) { try { parsed = JSON.parse(text); } catch (_) { incomplete = true; } }
          } catch (_) {
            if (operation.cause) { finish(); throw thrown(); }
            incomplete = true;
          }
          finish();
          const code = headerCode || (parsed && typeof parsed.code === 'string' ? parsed.code : null);
          const auth = endSignal(status, code);
          if (auth && !headerAuth) report(session, status, code);
          return answer({ code, body: parsed, auth, incomplete });
        }

        if (read === 'stream') {
          const reader = response.body ? response.body.getReader() : null;
          const stream = {
            async read() {
              if (!reader) { finish(); return { done: true, value: undefined }; }
              try {
                const chunk = await reader.read();
                if (chunk.done) finish();
                return chunk;
              } catch (_) {
                finish();
                throw thrown();
              }
            },
            async cancel() {
              finish();
              if (reader) { try { await reader.cancel(); } catch (_) {} }
            },
          };
          return answer({ stream });
        }
        if (read === 'none') {
          finish();
          if (response.body) { try { response.body.cancel(); } catch (_) {} }
          return answer({});
        }
        try {
          if (read === 'json') {
            const text = await response.text();
            finish();
            if (!text) return answer({});
            // 읽히지 않는 성공 본문은 성공의 증거가 아니다. 부른 쪽이 "결과 모름"으로 다룬다.
            try { return answer({ body: JSON.parse(text) }); } catch (_) { return answer({ incomplete: true }); }
          }
          const value = await response[read]();
          finish();
          return answer({ body: value });
        } catch (_) {
          finish();
          throw thrown();
        }
      })();
    }

    /**
     * fetch처럼 Response를 그대로 돌려주는 보내기 — 답을 스스로 읽는 소비자(모듈에 넘기는 fetch)를 위한 것이다. 승인·결속·
     * 취소·종료 신호의 귀속은 request와 같고, 문맥을 주지 않으면 부르는 순간의 문서 범위다. 한도는 주었을 때만 건다.
     * 읽은 것을 화면에 쓰는 자리의 관문은 그 소비자의 몫이다 — 이 함수는 그것을 대신하지 않는다.
     */
    function fetchBound(url, init = {}) {
      return request(url, { ...init, read: 'response',
        context: init.context === undefined ? gate.capture('document') : init.context,
        deadlineMs: init.deadlineMs === undefined ? 0 : init.deadlineMs });
    }

    return Object.freeze({ request, fetch: fetchBound, pending: () => open.size });
  }

  let shared = null;
  /**
   * 이 문서의 전송 하나: 이 문서의 관문(KinWorkContext)과 세션 권위(KinAuth)에 묶인다. KinAuth는 `const`로 선언된 전역이라
   * window의 속성이 아니다 — 이름으로 찾는다.
   */
  function page(options) {
    // A document without auth.js supplies its own authority once, before any consumer starts.
    // The gate remains the page default, so shared modules cannot accidentally use another gate.
    if (options !== undefined) {
      if (shared) throw new Error('KinSessionTransport.page: the page transport is already configured');
      if (!root?.KinWorkContext || typeof options?.authFailure !== 'function')
        throw new TypeError('KinSessionTransport.page: a page gate and authFailure are required');
      shared = create({ ...options, gate: root.KinWorkContext });
    }
    if (!shared) {
      const auth = typeof KinAuth === 'object' ? KinAuth : null;
      if (!root || !root.KinWorkContext || !auth || typeof auth.authFailure !== 'function')
        throw new Error('KinSessionTransport.page: work-context.js and auth.js must be loaded first');
      shared = create({ gate: root.KinWorkContext, authFailure: failed => auth.authFailure(failed) });
    }
    return shared;
  }

  const api = Object.freeze({ create, page, DEADLINES, refusal, responseError });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinSessionTransport = api;
})(typeof window === 'object' ? window : null);
