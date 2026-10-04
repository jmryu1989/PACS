/* KIN 세션 결속 전송 (S7-U5, U5S-REQ-12). 요청을 보내는 일만 한다 — 답을 화면에 쓰는 일은 KinWorkContext.commit의 몫이다.
 *
 * 맡는 것은 넷이다.
 *   · 승인: 요청은 자기 문맥(KinWorkContext.capture 또는 prepare가 내준 것)이 지금 통과할 때만 떠난다. 로그아웃 준비 중의
 *     일반 요청, 끝난 세션의 요청, 옮겨 간 검사의 요청은 네트워크에 닿지 않는다.
 *   · 결속: 모든 요청에 그 작업이 시작될 때의 세션 식별값을 `X-KIN-Session`으로 싣는다. 식별값 없는 요청은 보내지 않는다 —
 *     결속 없는 요청은 최초 신원 확인 하나뿐이고 그것은 auth.js만 한다(U5S-REQ-09).
 *   · 한도와 취소: 머리글과 본문을 합쳐 한 한도(기본 10초) 안에서 끝낸다. 부른 쪽의 signal, 한도, 문맥이 무효가 된 읽기는
 *     같은 AbortController로 끊는다. 쓰기는 문맥이 무효가 되어도 끊지 않는다 — 서버에서 이미 일어났을 수 있는 일의 결과를
 *     모르게 만들 뿐이다. 그 결과를 화면에 쓸지는 commit이 정한다.
 *   · 인증 실패의 귀속: 401과 결속 거절(AUTH_SESSION_REQUIRED·AUTH_SESSION_MISMATCH)은 그 요청이 실은 세션의 것으로
 *     알린다. 이전 세션의 늦은 401이 지금 세션을 끝내지 못한다(받는 쪽이 세션을 대조한다).
 *
 * Response의 메서드를 바꾸지 않고, 임의의 대입을 막아 준다고 하지도 않는다. 답은 값으로 돌려준다:
 *   { ok, status, code, body, headers, auth, incomplete }  (read: 'stream'이면 body 대신 stream)
 * 실패는 `transport`(not-admitted·unbound·cancelled·stale·timeout·network)와 `sent`(요청이 떠났는가)를 가진 오류로 던진다.
 */
(function (root) {
  'use strict';

  const DEADLINE_MS = 10000;
  const READS = ['json', 'text', 'blob', 'arrayBuffer', 'stream', 'none'];
  // 서버(와 nginx의 auth_request)가 세션 결속을 거절할 때의 코드. 401은 코드와 무관하게 인증 실패다.
  const BINDING_CODES = ['AUTH_SESSION_REQUIRED', 'AUTH_SESSION_MISMATCH'];
  const BINDING_STATUSES = [403, 409, 428];
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
    const defaultDeadline = options.deadlineMs === undefined ? DEADLINE_MS : options.deadlineMs;
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
      const context = init.context;
      if (!gate.admits(context)) return Promise.reject(failure('not-admitted', false));
      // 식별값은 작업이 시작될 때의 것이다. `session`은 사람이 명시로 시작한 복구 작업이 자기 결속을 줄 때만 쓴다.
      const session = init.session === undefined ? context.session : init.session;
      if (typeof session !== 'string' || !session) return Promise.reject(failure('unbound', false));

      const method = String(init.method || 'GET').toUpperCase();
      const headers = { ...(init.headers || {}), 'X-KIN-CSRF': '1', 'X-KIN-Session': session };
      let body = init.body;
      if (init.json !== undefined) {
        headers['Content-Type'] = 'application/json';
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
      const deadlineMs = init.deadlineMs === undefined ? defaultDeadline : init.deadlineMs;
      const timer = deadlineMs > 0 ? setTimeout(() => operation.cancel('timeout'), deadlineMs) : null;
      const outer = init.signal || null;
      const onAbort = () => operation.cancel('cancelled');
      if (outer) outer.addEventListener('abort', onAbort, { once: true });
      open.add(operation);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        open.delete(operation);
        if (timer !== null) clearTimeout(timer);
        if (outer) outer.removeEventListener('abort', onAbort);
      };
      const thrown = () => failure(operation.cause || 'network', true);

      return (async () => {
        if (outer && outer.aborted) operation.cancel('cancelled');
        // 취소가 먼저여서 보내지 않은 요청은 떠나지 않았다.
        if (operation.cause) { finish(); throw failure(operation.cause, false); }
        let response;
        try {
          response = await send(url, {
            method, headers, body, signal: control.signal,
            ...(init.keepalive ? { keepalive: true } : {}),
            ...(init.cache ? { cache: init.cache } : {}),
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
          const auth = status === 401 || (BINDING_STATUSES.includes(status) && BINDING_CODES.includes(code));
          if (auth) report(session, status, code);
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

    return Object.freeze({ request, pending: () => open.size });
  }

  let shared = null;
  /**
   * 이 문서의 전송 하나: 이 문서의 관문(KinWorkContext)과 세션 권위(KinAuth)에 묶인다. KinAuth는 `const`로 선언된 전역이라
   * window의 속성이 아니다 — 이름으로 찾는다.
   */
  function page() {
    if (!shared) {
      const auth = typeof KinAuth === 'object' ? KinAuth : null;
      if (!root || !root.KinWorkContext || !auth || typeof auth.authFailure !== 'function')
        throw new Error('KinSessionTransport.page: work-context.js and auth.js must be loaded first');
      shared = create({ gate: root.KinWorkContext, authFailure: failed => auth.authFailure(failed) });
    }
    return shared;
  }

  const api = Object.freeze({ create, page, DEADLINE_MS });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinSessionTransport = api;
})(typeof window === 'object' ? window : null);
