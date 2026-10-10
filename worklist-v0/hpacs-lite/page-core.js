
    // ── 로그인 가드 (4장) ──
    // init()이 쿠키 세션을 한 번 판정한 뒤 session()/has()는 동기로 읽는다. 이 변수들은
    // 함수 정의가 끝난 뒤 boot 첫 줄에서 채워져, 상태 판정보다 화면 코드가 먼저 돌지 않는다.
    let sess = null, user = "", userDisplayName = "";
    // 로그아웃 핸들러는 아래 "이탈 시 판독문 보존"에 있다 — 나가기 전에 초안을 저장하고
    // 점유를 풀어야 하므로, 그 함수들이 정의된 곳 옆에 둔다.

    const $ = s => document.querySelector(s);
    const actorNames = new Map();
    function rememberActor(id, name, username = "") {
      const key = String(id ?? "");
      const login = String(username ?? "");
      const shown = name && name !== login ? String(name) : key || login;
      if (!shown) return;
      for (const alias of [key, login, key.split("@")[0]].filter(Boolean)) actorNames.set(alias, shown);
    }
    function displayActor(value) {
      const raw = String(value ?? "");
      return actorNames.get(raw) || actorNames.get(raw.split("@")[0]) || raw;
    }
    function tagv(st, key) {
      const v = st[key]?.Value?.[0];
      if (v == null) return "";
      if (typeof v === "object") return v.Alphabetic ?? "";
      return String(v);
    }
    /**
     * HTML 이스케이프.
     *
     * 인증 토큰은 서버측 세션에만 있지만, XSS가 생기면 사용자 권한으로 API를 호출하거나
     * 화면의 환자정보를 읽을 수 있다. 그런데 워크리스트도 판독문 이력도 서버·DICOM에서
     * 온 문자열을 그대로 innerHTML에 넣고 있었다.
     *
     * 가장 현실적인 경로: 판독의 A가 소견에 `<img src=x onerror=...>`를 써서 저장하고,
     * 판독의 B가 그 검사의 "이력"을 누르는 순간 B의 세션으로 임의 요청이 실행된다.
     * 서버가 역할·기관·예비판독 접근을 아무리 잘 막아도 이 한 줄이면 무의미해진다.
     *
     * 속성값에도 쓰므로 따옴표까지 막는다.
     */
    const esc = v => String(v ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    const fmtD = d => d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
    const today = () => new Date().toISOString().slice(0, 10);
    function ageOf(birth, date) {
      if (!birth || !date) return "";
      const b = +birth.replace(/-/g, ""), d = +date.replace(/-/g, "");
      return b && d ? Math.floor((d - b) / 10000) : "";
    }

    // ══════════ 영속 상태: 서버(KIN API) 우선, 안 되면 localStorage ══════════
    // 3단계 이전에는 모든 상태가 이 브라우저에만 있었다. 브라우저를 바꾸면 사라지고,
    // 동업자는 다른 데이터를 봤다. 이제 서버가 진실의 원천이고 localStorage는 폴백일 뿐이다.
    /**
     * API 주소.
     *
     * 리버스 프록시 뒤에서는 **같은 출처의 `/api`**다. 그래서 CORS가 아예 없다 —
     * 프리플라이트도, Access-Control 헤더도, 포트를 맞추는 일도 없어진다.
     * 배포지가 바뀌어도 이 줄은 안 바뀐다.
     *
     * 8042로 직접 열었을 때(프록시 없이 확인할 때)만 옛 경로로 되돌아간다.
     */
    const API = location.port === "8042" || location.protocol === "file:"
      ? `${location.protocol === "file:" ? "http:" : location.protocol}//${location.hostname || "localhost"}:3000/api`
      : `${location.origin}/api`;
    let serverMode = false;
    /**
     * **로그인은 했는데 서버에 못 닿는 상태.**
     *
     * `serverMode = false`가 두 가지 아주 다른 상황을 함께 가리키고 있었다:
     *   ① 데모 모드 — 로그인 안 하고 둘러보는 중. localStorage에 쌓여도 괜찮다.
     *   ② 진짜 계정으로 일하는 중인데 API가 죽었다. 여기서 localStorage에 쌓이면
     *      판독의는 저장되는 줄 알고 하루를 일하고, 다음 로그인에서 `appState = b.states`가
     *      그걸 **말없이 전부 버린다.** 인계문서가 "데이터가 조용히 갈라지는 최악의 실패"라
     *      부른 그 상황이다.
     *
     * 둘을 갈랐다. ②는 폴백이 아니라 **고장**이므로 쓰기를 아예 막고 소리 내어 알린다.
     * 이미 §12에서 목록 조회에 대해 내린 결론("실패하면 데모 데이터로 안 내려간다")을
     * 부트스트랩까지 넓힌 것이다.
     */
    let offline = false;
    // 내 소속 기관. 서버가 토큰의 그룹에서 뽑아 bootstrap으로 알려준다.
    // 화면이 정하는 값이 아니다 — 여기 있는 건 표시용이고, 진짜 필터는 서버에 있다.
    let myInstitution = null, myInstitutionName = "", institutions = [];

    /**
     * 이 문서의 작업 문맥 관문과 세션 결속 전송(S7-U5, U5S-REQ-11·12). 관문은 auth.js의 세션 상태를 따른다. 요청은 떠날 때의
     * 문맥(work.capture)으로 승인받아 그 세션의 식별값을 싣고, 답·오류·finally·타이머가 화면이나 공유 상태를 바꾸는 자리는
     * work.commit(문맥, 효과)를 지난다 — 로그아웃 준비·그 취소·세션 종료·검사 이동 뒤에 온 것은 아무것도 쓰지 않는다.
     * fetch나 Response를 바꿔 끼우지 않는다: 이 두 가지를 지나지 않는 쓰기는 보호받지 않으므로 지나게 만든다.
     */
    const work = KinWorkContext;
    // 아래 받아쓰기 칸 focus 등록이 읽는 선택 순번이다. 분할된 script 사이에 온 초기 focus도 읽을 수 있게 그 등록보다 먼저 선언한다(S9-U0a-PRE).
    /**
     * 선택이 바뀐 횟수.
     *
     * 비동기 응답은 화면에 쓰기 직전에 **UID와 순번을 함께** 확인해야 한다. UID만 보면
     * A→B→A로 돌아온 화면이 "같은 검사"로 보이지만, 그 사이 화면은 다시 그려졌고
     * 지금 textarea에 있는 글은 그 요청이 떠날 때의 글이 아니다. `loadRelatedReport`가
     * `relatedReportSeq`로 하는 것과 같은 검사이며, 여기서 틀리면 **다른 환자의 판독문**이
     * 한 화면에 나란히 놓인다.
     */
    let selectionSeq = 0;
    work.follow(KinAuth);
    const transport = KinSessionTransport.page();
    /**
     * 이 문서의 세션이 끝날 때 한 번 부를 일들(영역의 end()). 영역마다 통지 채널을 따로 듣지 않는다 — 어느 로그인의 종료인지는
     * auth.js가 대조하고, 이 문서의 세션이 끝난 그 자리에서 아래 세션 종료 조정이 동기로 부른다.
     */
    const sessionEndHooks = [];
    function onSessionEnd(end) { sessionEndHooks.push(end); }
    const accountChangeHooks = [];
    function notifyAccountChanged(detail) {
      accountChangeHooks.forEach(done => { try { done('account-changed', detail); } catch (_) {} });
    }
    function onCommonEnd(end) {
      accountChangeHooks.push(end);
      work.onInvalidate(({ reason, state }) => {
        if (reason === 'lifecycle' && state !== 'active' && state !== 'preparing') end();
      });
    }

    /**
     * 목록 읽기(study-pages.js)가 계정이 바뀌었다고 판정했을 때의 확인. 그 판정은 401·403으로 읽지 못한 경우도 포함하므로
     * 그대로 화면을 닫지 않는다: 그 요청의 세션에 묶어 신원을 한 번 읽고, 서버가 다른 계정을 답할 때만 세션 교체다
     * (닫았으면 true). 서버가 그 세션의 종료·교체를 알렸으면 전송이 이미 넘겼다. 읽지 못했으면 증거가 없다 — 그 읽기 하나의
     * 실패로 남는다.
     */
    async function accountReplaced(at) {
      let answer = null;
      try { answer = await transport.request(API + "/me", { context: at, cache: "no-store" }); } catch (_) { return false; }
      if (answer.auth) return true;
      const me = answer.ok && !answer.incomplete ? answer.body : null;
      if (!me || !sess || (me.sub === sess.sub && (me.institution ?? null) === (sess.institution ?? null))) return false;
      KinAuth.replaced({ session: at.session });
      return true;
    }

    /** 무효가 된 문맥의 답은 취소로 끝낸다(AbortError) — 부른 쪽의 실패 처리가 그 답을 알릴 실패로 다루지 않게 한다. */
    function staleAnswer() {
      const error = new Error("작업 문맥이 바뀌어 이 요청의 답을 쓰지 않았습니다.");
      error.name = "AbortError";
      error.transport = "stale";
      error.sent = true;
      return error;
    }

    /**
     * 업무 요청 하나(JSON). `at`은 이 요청을 시작한 작업의 문맥이다 — 주지 않으면 부르는 순간의 문서 범위다. 요청은 그
     * 문맥으로 승인받아 떠나고, 답이 왔을 때 그 문맥이 무효이면 답 대신 취소로 끝난다. 답을 화면·공유 상태에 쓰는 자리는
     * 부른 쪽이 같은 문맥의 work.commit으로 지난다(이 함수의 검사는 그것을 대신하지 않는다). 401과 세션 결속 거절은 전송이
     * 그 요청의 세션으로 auth.js에 알린다 — 여기서 로그아웃을 부르지 않는다.
     */
    async function api(method, path, body, signal, at = work.capture("document")) {
      const answer = await transport.request(API + path, { method, json: body, signal, context: at });
      if (!work.admits(at)) throw staleAnswer();
      if (answer.auth)
        throw Object.assign(new Error("세션이 만료되었습니다"), { status: answer.status, code: answer.code, auth: true });
      if (!answer.ok) {
        const j = answer.body || {};
        if (answer.status === 409 && j.code === "REPORT_HELD") {
          const uid = decodeURIComponent(path.split("/")[2]);
          work.commit(at, () => noteHeld(uid, j.holder));
        }
        // 본문을 버리지 않는다. 거절이 "무엇을 확인해야 하는가"를 함께 보낼 때
        // (승인본 판 번호와 그 본문 같은 것) 메시지 한 줄만 남기면 화면은 사용자에게
        // 자기 캐시를 대신 보여주게 된다 — 그 캐시가 낡아서 거절당한 것인데도.
        throw Object.assign(new Error(j.message ?? `HTTP ${answer.status}`), { code: String(answer.code || '').startsWith('AUTH_') ? answer.code : j.code, status: answer.status, body: j, responseIncomplete: answer.incomplete });
      }
      // 읽을 수 없는 성공 본문은 성공이 아니다.
      if (answer.incomplete || answer.body === null)
        throw Object.assign(new Error("서버의 답을 읽지 못했습니다"), { status: answer.status, incomplete: true });
      return answer.body;
    }
    // ── 토스트: 무슨 일이 일어났는지 한 줄로 ──
    let toastTimer;
    function toast(msg, kind = "ok", ms = kind === "err" ? 4000 : 1900) {
      const el = $("#toast");
      el.textContent = msg;
      el.className = "show " + kind;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.className = kind; }, ms);
    }
    function apiFail(e) { toast("서버 저장 실패: " + e.message, "err"); }