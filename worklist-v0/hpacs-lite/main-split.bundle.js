
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

    const appState = {};
    // Legacy demo data has no authenticated owner; never merge it into this session's drafts.
    let legacyAppState = {};
    try { legacyAppState = JSON.parse(localStorage.getItem("kin-app") ?? "{}"); } catch (e) {}

    // PATCH로 보낼 수 있는 필드. 서버의 STATE_FIELDS와 같아야 한다.
    // 판독 생애주기는 commitReport, matched·orig는 /match·/unmatch만 움직인다.
    const STATE_KEYS = ["ss", "em", "ts", "ward", "reqHosp", "ov"];
    // 서버에서 내려오는(=화면이 못 정하는) 읽기 전용 필드. 이건 PATCH로 보내지 않는다.
    // S4-U5: the display overlay (ov) and a claimed original may only carry these fields, as text (age may be the number
    // ageOf gives). The server refuses any other shape; older stored values are filtered the same way before use.
    const OVERLAY_KEYS = ["id", "name", "sex", "birth", "age", "desc", "ward", "date", "acc", "modality"];
    const overlayValue = (key, value) => typeof value === "string" || (key === "age" && Number.isFinite(value));

    /**
     * 상태 저장. 로컬 모드면 통째로 localStorage에, 서버 모드면 **바뀐 필드만** PATCH.
     *
     * 전체를 보내면 안 되는 이유: 서버가 필드별로 권한을 본다. 방사선사가 Verify(ss)만
     * 눌렀는데 판독의가 남긴 rs까지 딸려 보내면 "판독 상태 변경은 radiologist 권한이
     * 필요합니다"로 거절당한다. 보내는 것이 곧 요구하는 권한이다.
     */
    function saveApp(uid, patch) {
      // 로그인한 계정으로 일하는 중에 서버가 죽었다면, localStorage는 안전한 곳이 아니라
      // **다음 로그인에 조용히 버려질 곳**이다. 쌓지 않고 막는다.
      if (offline) { toast("서버에 연결돼 있지 않습니다 — 저장되지 않았습니다", "err"); return false; }
      if (!serverMode) {
        try { localStorage.setItem("kin-app", JSON.stringify(appState)); } catch (e) {}
        return;
      }
      if (!uid || !patch) return;
      const body = {};
      for (const k of STATE_KEYS) if (patch[k] !== undefined) body[k] = patch[k];
      if (!Object.keys(body).length) return;

      /**
       * **응답을 받아 화면에 반영하고, 실패하면 되돌린다.**
       *
       * 예전엔 쏘고 잊었다(fire-and-forget). 서버가 403·400으로 거절해도 빨간 토스트
       * 한 줄이 전부였고 화면은 바꾼 채로 남았다 — 기사가 뱃지를 눌러 "승인됨"으로
       * 보이는 미판독 검사가 만들어졌다. 화면이 서버보다 앞서 나가면, 사용자는
       * 자기가 한 일이 저장됐다고 믿는다. 그게 조용히 갈라지는 시작이다.
       */
      // 한 검사의 서버 투영이 화면 상태를 대신하는 자리도 목록과 같은 규칙을 지난다 —
      // 이 응답에도 그 검사의 초안이 실려 오므로(`toClient`), 고른 검사가 아닌데 아직
      // 보내지 못한 글을 담고 있으면 그대로 덮여 사라진다.
      // S4-U5: the answer is also returned (true accepted / false refused) so a caller can wait for it before
      // painting; callers that ignore it behave exactly as before.
      const at = work.capture("document");
      return api("PATCH", `/studies/${encodeURIComponent(uid)}`, body, undefined, at)
        .then(st => work.commit(at, () => { appState[uid] = mergeObservedReportState(uid, st); syncStudy(uid); render(); }))
        .catch(async e => {
          if (!work.commit(at, () => apiFail(e))) return false;
          let fresh = null;
          try {
            const r = await api("GET", "/studies", undefined, undefined, at);
            fresh = r.studies.find(x => x.uid === uid);
          } catch (e2) {}
          work.commit(at, () => {
            if (fresh) { appState[uid] = mergeObservedReportState(uid, fresh.state); syncStudy(uid); }
            render(); refreshRight();
          });
          return false;
        });
    }

    // ── Order List (8.2.2): HRIS에서 온 오더 목록 (여기선 가짜) ──
    const SEED_ORDERS = [
      { oid: "O-9001", id: "P-1001", name: "KIM CHULSOO",  sex: "M", birth: "1962-03-04", sched: today() + " 09:10", modality: "CT", desc: "Brain CT without contrast", ward: "NR",  reqDoc: "PARK MD" },
      { oid: "O-9002", id: "P-1002", name: "LEE YOUNGHEE", sex: "F", birth: "1975-11-22", sched: today() + " 09:40", modality: "CT", desc: "Brain CT with contrast",    ward: "ER",  reqDoc: "KIM MD" },
      { oid: "O-9003", id: "P-2001", name: "HAN JIWOO",    sex: "F", birth: "1990-07-14", sched: today() + " 10:05", modality: "CT", desc: "Brain CT screening",       ward: "OPD", reqDoc: "CHOI MD" },
      { oid: "O-9004", id: "P-2002", name: "OH SEUNGMIN",  sex: "M", birth: "1984-01-30", sched: today() + " 10:30", modality: "CR", desc: "Chest PA",                 ward: "OPD", reqDoc: "KIM MD" },
      { oid: "O-9005", id: "P-2003", name: "SEO YUNA",     sex: "F", birth: "2001-09-02", sched: today() + " 11:00", modality: "CT", desc: "Brain CT f/u",             ward: "NR",  reqDoc: "PARK MD" },
      { oid: "O-9006", id: "P-2004", name: "BAEK DOYUN",   sex: "M", birth: "1958-12-19", sched: today() + " 11:25", modality: "US", desc: "Abdominal US",             ward: "GI",  reqDoc: "LEE MD" },
    ];
    let orders = null;
    try { orders = JSON.parse(localStorage.getItem("kin-orders")); } catch (e) {}
    if (!Array.isArray(orders) || !orders.length)
      orders = SEED_ORDERS.map(o => ({ ...o, matched: "U", studyUid: null }));
    const saveOrders = () => { try { localStorage.setItem("kin-orders", JSON.stringify(orders)); } catch (e) {} };
    saveOrders();

    // 상용구 검색·View·삽입 관문과 그 등록(아래)이 부르는 선언이다. script를 나눠 실어도 틈의 초기 입력이 미정의를 만나지 않게 등록보다 앞에 둔다(S9-U0a-PRE).
    let studies = [];
    let selectedUid = null;
    function cur() { return studies.find(s => s.uid === selectedUid); }
    const RFIELDS = ["findings", "conclusion", "recommendation"];
    /**
     * 판독문 textarea를 **스크립트로** 고쳐도 되는가.
     *
     * `readOnly`는 사람의 타이핑만 막는다. `el.value = ...` 대입은 그대로 통과한다.
     * 그래서 Clear·Paste 같은 버튼은 잠금을 스스로 확인해야 한다 —
     * 예비 판독 잠금이 이 두 버튼에서만 열려 있었다.
     * 막는 이유를 문자열로 돌려준다. 통과면 null.
     */
    function reportWriteBlock() {
      if (!selectedUid) return "검사를 선택하세요";
      if (!KinAuth.has("radiologist")) return "판독문 편집은 판독의 권한이 필요합니다";
      if (appState[selectedUid]?.prelimHidden) return "다른 판독의의 예비 판독(RS: P)입니다";
      return null;
    }

    // ── Reading Template ──
    // **계정에 붙는다.** 서버 모드면 bootstrap이 내 것을 실어 오고, 로컬 모드에서만
    // localStorage를 쓴다. 판독의는 자기 상용구를 하루 종일 쓰는데 PC를 바꿨다고
    // 사라지면 깨지는 건 작업이 아니라 신뢰다 (교훈 §6).
    // 매뉴얼이 "Upload/Download **My** Template File"이라고 부르듯 기관 공용이 아니라 개인 것이다.
    let templates = null;
    try { templates = JSON.parse(localStorage.getItem("kin-templates")); } catch (e) {}
    templates ??= [
      { title: "Normal Brain CT", shortcut: "nbct", modality: "CT",
        findings: "No evidence of acute intracranial hemorrhage.\nNo mass effect or midline shift.\nVentricles and sulci are within normal limits.",
        conclusion: "No acute intracranial abnormality." },
      { title: "Brain CT f/u nodule", shortcut: "fu", modality: "CT",
        findings: "Known hyperdense nodule in right frontal region.\nNo interval change in size.\nNo new lesion.",
        conclusion: "Stable known nodule. No interval change." },
      { title: "Screening", shortcut: "scr", modality: "",
        findings: "Screening examination.\n", conclusion: "" },
    ];
    const saveTemplatesLocal = () => {
      try { localStorage.setItem("kin-templates", JSON.stringify(templates)); } catch (e) {}
    };
    saveTemplatesLocal();

    const templateClass = value => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const templateModalities = value => String(value ?? "").split(",").map(templateClass).filter(Boolean);
    function renderTemplateBodyparts() {
      const select = $("#t-body"), chosen = select.value, label = select.selectedOptions[0]?.textContent;
      const classes = new Map();
      for (const t of templates) {
        const key = templateClass(t.bodypart);
        if (key && !classes.has(key)) classes.set(key, String(t.bodypart).trim().replace(/\s+/g, " "));
      }
      const options = [new Option("전체 부위", ""), new Option("미지정", JSON.stringify("")),
        ...[...classes].sort(([a], [b]) => a.localeCompare(b)).map(([key, name]) => new Option(name, JSON.stringify(key)))];
      // 마지막 항목의 부위를 바꿔도 사용자가 고른 조건을 몰래 '전체'로 넓히지 않는다.
      if (chosen && !options.some(option => option.value === chosen)) options.push(new Option(label, chosen));
      select.replaceChildren(...options); select.value = chosen;
    }
    function renderTemplates() {
      const s = cur();
      const useMod = $("#t-mod").checked, modalities = templateModalities(s?.modality);
      renderTemplateBodyparts();
      const body = $("#t-body").value;
      const words = $("#tpl-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const list = templates.filter(t => {
        const text = [t.title, t.shortcut, t.modality, t.bodypart].map(v => String(v ?? "").toLowerCase()).join(" ");
        const kinds = templateModalities(t.modality);
        // CT가 SCT 같은 다른 코드의 일부라는 이유로 분류에 들어오면 안 된다.
        return (!useMod || !modalities.length || !kinds.length || kinds.some(kind => modalities.includes(kind)))
          && (!body || JSON.stringify(templateClass(t.bodypart)) === body) && words.every(word => text.includes(word));
      });
      const modStatus = !useMod ? "Modality 전체" : !s ? "검사 미선택 · Modality 미적용"
        : !modalities.length ? "검사 Modality 없음 · 미적용" : "Modality: " + modalities.join(", ").toUpperCase();
      $("#tpl-filter-status").textContent = `${list.length} / ${templates.length}개 · ${modStatus} · ${$("#t-body").selectedOptions[0].textContent}${words.length ? " · 검색 적용" : ""}`;
      $("#tplrows").innerHTML = list.map(t => `
        <tr data-i="${templates.indexOf(t)}" title="더블클릭: 판독문에 삽입${
          t.shortcut ? ` / 판독문에서 &quot;${esc(t.shortcut)}&quot; 입력 후 Tab` : ""} / 우클릭: 편집">
          <td>${esc(t.title)}</td><td>${esc(t.shortcut)}</td><td>${esc(t.modality)}</td>
          <td><button type="button" class="chip" data-tpl-preview aria-label="상용구 미리보기: ${esc(t.title)}">View</button></td>
        </tr>`).join("") || `<tr><td class="empty" colspan="4">${templates.length ? "조건에 맞는 상용구가 없습니다" : "상용구 없음 — 우클릭해서 추가하세요"}</td></tr>`;
      updateTemplatePreview();
    }
    /**
     * 스크립트가 판독문 칸에 글을 넣어도 되는가. 상용구 삽입과 소견 인용이 **같은 관문
     * 하나**를 쓴다 — 둘이 각자 검사를 들고 있으면 언젠가 한쪽만 고쳐진다.
     */
    function reportEditorBlock() {
      const why = reportWriteBlock();
      if (why) return why;
      // value 대입은 촬영 중/타인 점유의 readOnly도 우회한다. 타이핑과 같은 관문을 거친다.
      if (RFIELDS.some(k => $("#" + k).readOnly)) return "현재 판독문은 편집할 수 없습니다";
      return null;
    }
    function templateInsertionBlock(t, emptyMessage = "삽입할 내용이 없습니다") {
      const why = reportEditorBlock();
      if (why) return why;
      if (!t || RFIELDS.every(k => !t[k])) return emptyMessage;
      return null;
    }
    function insertTemplate(t) {
      const why = templateInsertionBlock(t);
      if (why) { toast(why, why === "삽입할 내용이 없습니다" ? "info" : "err"); return false; }
      // S3-U6: 상용구도 사람이 둔 커서 자리에 줄 단위로 들어간다. 저장된 상용구에는 CR이
      // 섞일 수 있어 줄 끝을 먼저 모은다 — 아니면 넣은 뒤 커서가 CR 수만큼 어긋난다.
      // 쓰기는 편집기의 한 자리(`editReport`)로 간다: 표시를 세우고, 타이핑/Tab처럼 점유를 시작해 다른 판독의에게 편집
      // 중임이 보이게 한다.
      return editReport(RFIELDS.filter(k => t[k]).map(k => {
        const plan = KinReportCitation.placeBlock($("#" + k).value, KinReportCitation.toLf(t[k]),
                                                  caretAt(k), citationGuards(k));
        return reportEditOf(k, plan.text, plan.end);
      }));
    }
    $("#tplrows").addEventListener("dblclick", e => {
      if (e.target.closest("button")) return;
      const tr = e.target.closest("tr[data-i]"); if (!tr?.isConnected) return;
      insertTemplate(templates[+tr.dataset.i]);
    });

    // ══════════ 받아쓰기 (S3-ASR-U4) ══════════
    /**
     * 받은 글은 **검토 창까지만** 온다. 판독문에는 사람이 Insert를 누른 그 순간, 상용구와 같은
     * `placeBlock` 경로로만 들어간다. 녹음 가능 여부·녹음·전송·응답 검사는 `dictation.js`가 하고,
     * 여기서는 편집기의 사실(선택·판·칸·커서·관문)과 쓰기 한 번만 건넨다.
     *
     * 이 블록은 스크립트 앞쪽에서 실행되므로 불러올 때는 뒤에 선언된 `let`/`const`를 읽지 않는다 —
     * 모두 누름·응답 때 불리는 함수 안에서만 읽는다.
     */
    let dictationField = null;
    // Recording and Insert require a connection. The review retains its text while that
    // transient barrier is closed; accepting an incoming transcript does not insert it.
    function dictationBlock() {
      const why = reportEditorBlock();
      if (why) return why;
      if (!serverMode || demoMode) return "서버에 연결돼 있을 때만 받아쓸 수 있습니다";
      if (offline) return "서버 연결이 끊겨 받아쓸 수 없습니다 — 연결된 뒤 다시 시도하세요";
      return null;
    }
    /** 칸을 말하지 않으면 이 선택에서 마지막으로 짚은 칸, 없으면 Findings. 커서가 없으면 그 칸 끝이다. */
    function dictationContext(field) {
      const target = field ?? (dictationField?.seq === selectionSeq ? dictationField.field : "findings");
      if (!RFIELDS.includes(target)) return null;
      const el = $("#" + target);
      if (!el) return null;
      const a = appState[selectedUid] ?? {};
      return { blocked: !!reportEditorBlock(), uid: selectedUid, selectionSeq,
        baseVersion: reportBaseVersion(selectedUid, a.draft?.baseVersion ?? a.version ?? 0),
        field: target, value: el.value, caret: caretAt(target) ?? { start: el.value.length, end: el.value.length } };
    }
    /**
     * Insert 한 번의 쓰기. 세션이 방금 확인한 그 화면인지 여기서 **동기로** 다시 본다 — 확정·다른 삽입이
     * 나가 있는지는 세션이 모르고, 그 사이에 넣은 글은 확정 응답의 다시 그리기가 지운다.
     */
    function dictationInsert(ins) {
      if (commitInFlight || insertInFlight || dictationBlock()) return false;
      const live = dictationContext(ins.field);
      if (!live || live.uid !== ins.uid || live.selectionSeq !== ins.selectionSeq ||
          live.baseVersion !== ins.baseVersion || live.value !== ins.expectedValue) return false;
      const el = $("#" + ins.field);
      // 줄 끝만 모으는 것은 상용구와 같다 — textarea 값은 CR을 LF로 바꾸므로 그러지 않으면 커서가 어긋난다.
      const plan = KinReportCitation.placeBlock(el.value, KinReportCitation.toLf(ins.text), ins.caret,
                                                citationGuards(ins.field));
      // 타이핑·상용구처럼 표시를 세우고 점유를 시작하며, 저장은 기존 자동 저장이 한 번 가져간다.
      return editReport([reportEditOf(ins.field, plan.text, plan.end)]);
    }
    function dictationPlacement(pin, text) {
      const el = $("#" + pin.field);
      if (!el) return "";
      return placementLine(pin.field, KinReportCitation.placeBlock(el.value, KinReportCitation.toLf(text),
                                                                   pin.caret, citationGuards(pin.field)));
    }
    const dictation = KinDictation.createController({
      session: KinDictationSession, capture: KinDictationCapture, env: window, apiBase: API,
      readContext: dictationContext, block: dictationBlock, insert: dictationInsert, placement: dictationPlacement,
      busy: () => commitInFlight || insertInFlight,
    });
    KinDictation.mount(dictation, {
      button: $("#b-dictate"), pane: $("#dictation-pane"), status: $("#dictation-status"),
      text: $("#dictation-text"), place: $("#dictation-place"), meta: $("#dictation-meta"),
      stop: $("#dictation-stop"), cancel: $("#dictation-cancel"), repin: $("#dictation-repin"),
      insert: $("#dictation-insert"), close: $("#dictation-close"),
    }, {
      inserted: field => {
        $("#" + field)?.focus();
        toast("받아쓴 글을 판독문에 넣었습니다 — 확정하려면 Save 또는 Approve", "ok");
      },
      closed: () => ($("#b-dictate").disabled ? $("#findings") : $("#b-dictate")).focus(),
    });
    for (const k of ["findings", "conclusion", "recommendation"]) {
      const el = $("#" + k);
      el.addEventListener("focus", () => { dictationField = { field: k, seq: selectionSeq }; });
      // 위치를 다시 고정하는 몸짓은 **칸 안을 누르는 것**이다. 다시 고정해도 넣지는 않는다.
      el.addEventListener("mouseup", () => { dictation.fieldClicked(); });
      // 사람이 고친 글은 새 편집 순번이다 — 그 전에 떠난 편집기 범위의 작업은 이 글 위에 쓰지 않는다.
      el.addEventListener("input", () => { work.edited(); dictation.redraw(); });
    }
    /**
     * 검토 단계에서 판독의가 읽고 눌러야 할 것(받아쓴 글, 위치를 다시 고를 판독문 칸, Insert)은 보고서 열
     * 폭이 약 420px일 때 모두 Image Findings 서랍 아래에 있다. 그래서 검토에 들어서는 순간 서랍을 한 번
     * 닫는다 — 인용을 넣으면 서랍이 물러나는 것과 같은 이유다(reading-findings.js `inserted`).
     * 한 번의 받아쓰기(asrSeq)에 한 번뿐이다: 같은 검토 안의 위치 재고정은 다시 닫지 않고, 사용자가 검토 중
     * 토글로 다시 연 서랍도 그대로 둔다. 취소·실패·삽입·닫기 뒤에도 저절로 다시 열지 않는다.
     * `readingFindings`는 아래에서 선언되지만 이 함수는 검토에 들어선 뒤에만 그것을 읽는다.
     */
    let dictationDrawerSeq = null;
    function standDownFindingsForDictationReview() {
      const s = dictation.snapshot();
      if (s.state !== "review" || s.asrSeq === dictationDrawerSeq) return;
      dictationDrawerSeq = s.asrSeq;
      readingFindings?.close();
    }
    dictation.subscribe(standDownFindingsForDictationReview);
    // 로그아웃도 페이지를 떠나므로(`KinAuth.logout` → location.replace) 여기서 함께 끝난다.
    window.addEventListener("pagehide", () => dictation.pageExit());
    $("#t-mod").addEventListener("change", renderTemplates);
    $("#t-body").addEventListener("change", renderTemplates);
    $("#tpl-filter-clear").addEventListener("click", () => {
      $("#tpl-search").value = ""; $("#t-body").value = ""; $("#t-mod").checked = false;
      renderTemplates(); $("#tpl-search").focus();
    });
    $("#tpl-search").addEventListener("input", renderTemplates);
    $("#tpl-search-clear").addEventListener("click", () => {
      $("#tpl-search").value = ""; renderTemplates(); $("#tpl-search").focus();
    });

    let templatePreview = null, templatePreviewReturn = null;
    function closeTemplatePreview(returnFocus = true) {
      if (!templatePreview) return;
      templatePreview = null;
      $("#tpl-preview").classList.remove("show");
      $("#tpl-preview-insert").disabled = true;
      delete $("#tpl-preview-target").dataset.uid;
      for (const id of ["title", "meta", "target", "status", ...RFIELDS]) $("#tpl-preview-" + id).textContent = "";
      if (returnFocus) (templatePreviewReturn?.isConnected ? templatePreviewReturn : $("#tpl-search")).focus();
      templatePreviewReturn = null;
    }
    function updateTemplatePreview() {
      if (!templatePreview) return;
      if (templatePreview.uid !== selectedUid) { closeTemplatePreview(false); return; }
      const s = cur(), why = templateInsertionBlock(templatePreview.template);
      $("#tpl-preview-target").dataset.uid = selectedUid ?? "";
      $("#tpl-preview-target").textContent = s ? `삽입 대상: ${s.name} (${s.id})\n${s.date} · ${shownStudyDesc(s)} · AccNo: ${s.acc || "없음"}` : "삽입 대상: 검사 미선택";
      $("#tpl-preview-status").textContent = why ?? (s?.rs === "A"
        ? "삽입은 개인 초안에 반영됩니다. 승인본에 추가하려면 Addendum을 사용하세요."
        : "삽입은 개인 초안에 반영됩니다. 확정하려면 Save 또는 Approve를 사용하세요.");
      $("#tpl-preview-insert").disabled = !!why;
    }
    $("#tplrows").addEventListener("click", e => {
      const button = e.target.closest("[data-tpl-preview]"); if (!button) return;
      const tr = button.closest("tr[data-i]"), t = templates[+tr.dataset.i]; if (!t) return;
      // 목록이 새로 로드돼도, 삽입은 사람이 미리보기에서 읽은 문장과 같아야 한다.
      templatePreview = { uid: selectedUid, template: Object.fromEntries(
        ["title", "shortcut", "modality", "bodypart", ...RFIELDS].map(k => [k, String(t[k] ?? "")])) };
      templatePreviewReturn = button;
      const snapshot = templatePreview.template;
      $("#tpl-preview-title").textContent = `상용구 미리보기 — ${snapshot.title}`;
      $("#tpl-preview-meta").textContent = `단축어: ${snapshot.shortcut || "없음"} · Modality: ${snapshot.modality || "전체"} · Bodypart: ${snapshot.bodypart || "미지정"}`;
      for (const k of RFIELDS) $("#tpl-preview-" + k).textContent = snapshot[k] || "(내용 없음)";
      updateTemplatePreview();
      $("#tpl-preview").classList.add("show");
      $("#tpl-preview-close").focus();
    });
    $("#tpl-preview-close").addEventListener("click", () => closeTemplatePreview());
    $("#tpl-preview-insert").addEventListener("click", () => {
      if (!templatePreview || templatePreview.uid !== selectedUid) { closeTemplatePreview(false); return; }
      if (insertTemplate(templatePreview.template)) closeTemplatePreview();
      else updateTemplatePreview();
    });
    $("#tpl-preview").addEventListener("click", e => { if (e.target.id === "tpl-preview") closeTemplatePreview(); });
    $("#tpl-preview").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeTemplatePreview(); }
      if (e.key === "Tab") {
        e.preventDefault();
        // 긴 문장을 키보드로 스크롤하면서도 삽입 대상은 계속 볼 수 있어야 한다.
        const controls = [$("#tpl-preview .tpl-preview-body"), $("#tpl-preview-close"), $("#tpl-preview-insert")].filter(b => !b.disabled);
        const index = controls.indexOf(document.activeElement);
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    });
    window.addEventListener("pagehide", () => closeTemplatePreview(false));

    /**
     * **단축어(shortcut)를 실제로 동작시킨다.**
     *
     * 지금까지 이 필드는 등록도 되고 목록에 보이기도 했지만 **아무 데도 안 쓰였다.**
     * 판독의가 "nbct"를 등록하고 눌러봐야 아무 일도 안 일어난다 — 있는 척하는 기능은
     * 없는 기능보다 나쁘다. 무엇을 잘못했나 찾게 만들기 때문이다.
     *
     * 동작: 판독문 칸에서 단축어를 치고 **Tab**을 누르면 그 자리에서 펼쳐진다.
     * Tab을 가로채는 건 커서 바로 앞 단어가 등록된 단축어일 때뿐이다 —
     * 그 외에는 평소대로 다음 칸으로 넘어간다.
     */
    function expandShortcut(el) {
      const pos = el.selectionStart;
      if (pos !== el.selectionEnd) return false;
      const before = el.value.slice(0, pos);
      const word = (before.match(/[A-Za-z0-9가-힣_-]+$/) ?? [""])[0];
      if (!word) return false;
      const t = templates.find(x => x.shortcut && x.shortcut === word);
      if (!t) return false;
      // 어느 칸에서 눌렀든 그 칸에 맞는 내용을 넣는다. Findings 칸에서 Conclusion을
      // 펼치면 판독문이 섞인다 — 상용구는 칸마다 다른 문장이다.
      const text = el.id === "conclusion" ? (t.conclusion ?? "")
                 : el.id === "recommendation" ? (t.recommendation ?? "")
                 : (t.findings ?? "");
      if (!text) return false;
      // 단축어 자리를 그 칸의 문장으로 바꾼다. 표시·점유·자동 저장은 편집기의 한 자리(`editReport`)가 챙긴다.
      if (!editReport([{ field: el.id, start: pos - word.length, end: pos, text }])) return false;
      toast(`상용구 "${t.title}" 삽입`, "info");
      return true;
    }
    // 단축어 Tab(아래 등록)이 부르는 편집기의 한 자리다. 분할된 script 사이의 Tab이 미정의를 만나지 않게 등록보다 앞에 둔다(S9-U0a-PRE).
    /**
     * 판독문 칸(`#findings`·`#conclusion`·`#recommendation`)의 글을 **이 문서의 코드가** 바꾸는 한 자리.
     *
     * 사람의 타건은 input 이벤트가 알리지만 스크립트의 `.value` 대입은 아무것도 알리지 않는다. 대입하는 자리마다 "이 글은
     * 서버가 아직 모른다"는 표시를 각자 챙기게 두면, 한 자리가 빠지는 순간 그 글은 자동 저장·로그아웃 보존·떠나기 경고
     * 어디에도 없고 다음 폴링이 서버 글로 덮는다(U5CLI-F09: Paste와 Clear가 그랬다). 그래서 값을 바꾸는 일과 그 기록을
     * 이 함수 하나가 함께 한다 — 붙여넣기·비우기·상용구·받아쓰기·단축어·인용·구조화가 모두 여기를 지난다. 이 함수 밖에서
     * 세 칸에 대입하는 곳은 둘뿐이다: 서버의 글을 그리는 `loadReport`와 화면을 닫는 `closeWork`(둘 다 이 문서의 편집이
     * 아니다).
     *
     * `edits`는 `{ field, start, end, text[, caret] }`의 목록이다: 그 칸의 지금 글에서 [start, end)를 text로 바꾸고 커서를
     * caret(없으면 넣은 글의 끝)에 둔다. 칸·범위·넣을 글로 받는 것은 편집기 경계 모듈(report-editor-frame.js의
     * capture + insert / insertMany)이 같은 것을 받기 때문이다. 쓸 수 있는가(권한·잠금·그때 그 선택인가)는 부르는 쪽이
     * 이미 확인했다. 여기서는 업무 중인 문서의 고른 검사일 때만 쓰고, 글이 실제로 바뀌었는지를 돌려준다 — 아무것도 바꾸지
     * 않은 호출(빈 붙여넣기 등)은 편집이 아니므로 표시도 세우지 않는다.
     */
    function editReport(edits) {
      if (work.state() !== "active" || !selectedUid) return false;
      const changed = [];
      for (const { field, start, end, text, caret } of edits) {
        const el = $("#" + field), was = el.value;
        if (was.slice(start, end) === text) continue;
        el.value = was.slice(0, start) + text + was.slice(end);
        const at = caret ?? start + text.length;
        el.setSelectionRange(at, at);
        changed.push(el);
      }
      if (!changed.length) return false;
      // 편집기의 글이 바뀌었다 — 그 전에 떠난 편집기 범위의 작업(클립보드 읽기 등)은 이 글 위에 쓰지 않는다.
      work.edited();
      recordReportEdit();
      // 글이 바뀐 뒤에 따라오는 일(점유 시작, 인용 다시 세기, 상용구 단추, 받아쓰기 자리)은 타이핑과 같은 input이 알린다.
      for (const el of changed) el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    ["#findings", "#conclusion", "#recommendation"].forEach(sel =>
      $(sel).addEventListener("keydown", e => {
        if (e.key !== "Tab" || e.shiftKey || e.target.readOnly) return;
        if (expandShortcut(e.target)) e.preventDefault();
      }));

    /**
     * 상용구 편집. 매뉴얼 7.3.5.1.1대로 목록에서 우클릭해 만든다.
     * 지금까지는 기본 3종만 있고 추가할 방법이 아예 없었다 — 있으나 마나였다.
     *
     * **입력을 prompt에서 모달로 바꿨다.** prompt는 줄바꿈을 입력할 수 없어서,
     * 여러 줄인 기본 상용구를 "수정"으로 열면 한 줄로 뭉개진 채 영구 저장됐다.
     * 게다가 `?? ""` 때문에 중간에 Cancel을 눌러도 빈 값이 저장됐다 —
     * 취소가 취소가 아니라 삭제였다.
     */
    let templateEditor = null;
    function currentTemplateText() {
      return Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value]));
    }
    function reportTemplateAccessBlock() {
      const why = reportWriteBlock();
      if (why) return why;
      if (!cur()) return "출처 검사를 확인할 수 없습니다. Refresh로 다시 확인하세요";
      if (RFIELDS.some(k => $("#" + k).readOnly)) return "현재 판독문은 편집할 수 없습니다";
      return null;
    }
    function reportTemplateBlock() {
      return reportTemplateAccessBlock() || (RFIELDS.every(k => !$("#" + k).value) ? "상용구로 저장할 내용이 없습니다" : null);
    }
    function updateReportTemplateButton() {
      const why = reportTemplateBlock();
      $("#b-report-template").disabled = !!why;
      $("#b-report-template").title = why ?? "현재 세 칸을 새 개인 상용구 편집창으로 가져옵니다";
      if (templateEditor?.source && templateEditor.source.uid !== selectedUid) closeTemplateEditor(false);
      updateTemplateEditor();
    }
    function updateTemplateEditor() {
      const session = templateEditor;
      if (!session) return;
      // 늦은 초안 버리기 응답은 원판독을 비울 수 있다. 이미 복사한 편집문은 출처 접근 조건만 다시 검사한다.
      const why = session.source ? reportTemplateAccessBlock() : null;
      for (const el of document.querySelectorAll("#tplmodal input, #tplmodal textarea")) el.disabled = session.pending;
      $("#tpl-cancel").disabled = session.pending;
      $("#tpl-save").disabled = session.pending || !!why;
      $("#tpl-save").textContent = session.pending ? "저장 중…" : "저장";
      $("#tpl-save").title = why ?? "";
      if (session.source) $("#tpl-source").textContent = session.source.label + "\n"
        + (why ?? "재사용할 문장만 남기고 제목을 입력하세요. 저장은 개인 상용구에만 반영됩니다.");
    }
    function closeTemplateEditor(returnFocus = true) {
      const session = templateEditor;
      if (!session) return;
      templateEditor = null;
      $("#tplmodal").classList.remove("show");
      for (const el of document.querySelectorAll("#tplmodal input, #tplmodal textarea")) { el.value = ""; el.disabled = false; }
      $("#tpl-source").textContent = ""; $("#tpl-source").hidden = true;
      delete $("#tpl-source").dataset.uid;
      $("#tpl-save").disabled = true; $("#tpl-save").textContent = "저장";
      $("#tpl-cancel").disabled = false;
      if (returnFocus && session.returnFocus?.isConnected) session.returnFocus.focus();
    }
    function editTemplate(t, source = null, seed = t) {
      if (!KinAuth.has("radiologist")) { toast("판독의만 상용구를 편집할 수 있습니다", "err"); return; }
      templateEditor = { editing: t, source, pending: false, returnFocus: document.activeElement };
      $("#tpl-title").textContent = source ? "현재 판독문으로 새 상용구" : t ? `상용구 수정 — ${t.title}` : "새 상용구";
      for (const [id, key] of [["t", "title"], ["s", "shortcut"], ["m", "modality"], ["b", "bodypart"],
                               ["f", "findings"], ["c", "conclusion"], ["r", "recommendation"]]) {
        $("#tpl-" + id).value = seed?.[key] ?? "";
      }
      $("#tpl-source").hidden = !source;
      if (source) $("#tpl-source").dataset.uid = source.uid;
      else { $("#tpl-source").textContent = ""; delete $("#tpl-source").dataset.uid; }
      updateTemplateEditor();
      $("#tplmodal").classList.add("show");
      $("#tpl-t").focus();
    }
    $("#b-report-template").addEventListener("click", () => {
      const why = reportTemplateBlock();
      if (why) { toast(why, why === "상용구로 저장할 내용이 없습니다" ? "info" : "err"); return; }
      const s = cur(), text = currentTemplateText();
      const modalities = String(s.modality ?? "").split(",").map(value => value.trim()).filter(Boolean);
      // 환자 식별은 출처 확인에만 쓴다. 재사용 문장/제목에 검사 식별을 자동으로 섞지 않는다.
      editTemplate(null, { uid: selectedUid,
        label: `가져온 검사: ${s.name} (${s.id})\n${s.date} · ${shownStudyDesc(s)} · AccNo: ${s.acc || "없음"}` },
        { ...text, modality: modalities.length === 1 ? modalities[0] : "" });
    });
    // 취소는 아무것도 안 한다. 저장을 누른 것만이 저장이다.
    $("#tpl-cancel").addEventListener("click", () => { if (!templateEditor?.pending) closeTemplateEditor(); });
    $("#tplmodal").addEventListener("click", e => { if (e.target.id === "tplmodal") $("#tpl-cancel").click(); });
    $("#tplmodal").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#tpl-cancel").click(); }
      if (e.key === "Tab") {
        const controls = [...document.querySelectorAll("#tplmodal input, #tplmodal textarea, #tplmodal button")].filter(el => !el.disabled);
        e.preventDefault();
        if (controls.length) controls[(controls.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    });
    window.addEventListener("pagehide", () => closeTemplateEditor(false));
    $("#tpl-save").addEventListener("click", async () => {
      const session = templateEditor;
      if (!session || session.pending) return;
      if (!KinAuth.has("radiologist")) { toast("판독의만 상용구를 편집할 수 있습니다", "err"); return; }
      if (session.source) {
        if (session.source.uid !== selectedUid) { closeTemplateEditor(false); return; }
        const why = reportTemplateAccessBlock();
        if (why) { toast(why, "err"); updateTemplateEditor(); return; }
      }
      const t = session.editing;
      const title = $("#tpl-t").value.trim();
      if (!title) { toast("제목은 비울 수 없습니다", "err"); $("#tpl-t").focus(); return; }
      const shortcut = $("#tpl-s").value.trim();
      // 단축어가 겹치면 어느 쪽이 나올지 모른다 — 먼저 등록된 것이 이기고, 뒤엣것은 죽는다.
      const dup = shortcut && templates.find(x => x !== t && x.shortcut === shortcut);
      if (dup) { toast(`단축어 "${shortcut}" 은(는) "${dup.title}" 이(가) 쓰고 있습니다`, "err"); return; }
      const body = { id: t?.id, title, shortcut,
                     modality: $("#tpl-m").value.trim(),
                     bodypart: $("#tpl-b").value.trim(),
                     findings: $("#tpl-f").value, conclusion: $("#tpl-c").value,
                     recommendation: $("#tpl-r").value,
                     // API는 전체 상용구를 저장한다. 제목만 고쳐도 생략한 분류/권고문/순서가 지워졌다.
                     ...(t ? { ord: t.ord ?? 0 } : {}) };
      session.pending = true; updateTemplateEditor();
      const at = work.capture("document");
      try {
        if (serverMode) {
          const saved = await api("POST", "/templates", body, undefined, at);
          if (!work.commit(at, () => {
            const index = templates.findIndex(x => x.id === saved.id);
            if (index < 0) templates.push(saved); else templates[index] = saved;
          })) return;
        } else {
          if (t) Object.assign(t, body); else templates.push(body);
          saveTemplatesLocal();
        }
      } catch (e) {
        work.commit(at, () => { if (templateEditor === session) toast("상용구 저장 실패: " + e.message, "err"); });
        return;
      } finally {
        // 이 저장이 건 대기 표시는 이 저장이 푼다(자기 것만). 그리는 일은 문맥이 그대로일 때만 한다.
        session.pending = false;
        work.commit(at, () => { if (templateEditor === session) updateTemplateEditor(); });
      }
      // 저장 응답이 늦어도 그동안 연 새 편집창을 닫거나 입력을 지우지 않는다.
      if (!work.commit(at, () => {
        if (templateEditor === session) closeTemplateEditor();
        renderTemplates();
        toast(`상용구 "${body.title}" 저장`);
      })) return;
      // POST 성공과 목록 갱신 실패를 합치면 '저장 실패' 재시도로 같은 문장을 두 번 만든다.
      if (serverMode) {
        try { await reloadPrefs(at); }
        catch (e) { work.commit(at, () => toast("상용구는 저장됐지만 목록 갱신에 실패했습니다. Refresh로 다시 확인하세요", "err")); }
      }
    });

    $("#tplrows").addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!KinAuth.has("radiologist")) { toast("판독의만 상용구를 편집할 수 있습니다", "err"); return; }
      const tr = e.target.closest("tr[data-i]");
      const t = tr ? templates[+tr.dataset.i] : null;
      showCtx(e, [
        { label: "＋ 새 상용구", act: () => editTemplate(null) },
        { label: "수정", dis: !t, act: () => editTemplate(t) },
        { sep: 1 },
        { label: "삭제", dis: !t, act: async () => {
            if (!confirm(`상용구 "${t.title}" 을(를) 삭제할까요?`)) return;
            const at = work.capture("document");
            if (serverMode) {
              try { await api("DELETE", `/templates/${t.id}`, undefined, undefined, at); await reloadPrefs(at); }
              catch (err) { work.commit(at, () => toast("삭제 실패: " + err.message, "err")); return; }
            } else {
              templates.splice(templates.indexOf(t), 1); saveTemplatesLocal(); renderTemplates();
            }
            work.commit(at, () => toast("상용구를 삭제했습니다", "info"));
          } },
      ]);
    });

    // ══════════ 컬럼 스펙: 모드별로 다른 워크리스트 (6.3 / 8.1.1) ══════════
    // f: 없으면 필터 없음 / 'text' = 입력칸 / 배열 = 드롭다운
    const COLS = {
      Radiology: [
        { k: "pf", t: "PF" },
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note" },
        { k: "no", t: "No", num: 1 },
        { k: "viewing", t: "Viewing" },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "rs", t: "RS", f: ["A", "H", "O", "P", "T", "W"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "ts", t: "TS" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1 },
        { k: "birth", t: "BirthDate" },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate" },
        // 예비 판독을 쓴 사람과, 최종 판독을 맡은 상급 판독의.
        // HPACS도 2025.07에 이 둘을 컬럼으로 붙였다 (교훈 §13 — 컬럼은 끝없이 늘어난다)
        { k: "preDoc", t: "PreDoc", f: "text" },
        { k: "preReviewer", t: "PreReviewer", f: "text" },
        // S7-U3b: 검사를 소유한 기관의 등록 이름(목록 행의 institutionName 그대로). 서버 목록(worklist-columns.ts)과 같은
        // 끝자리라 이 열이 생기기 전 저장된 열 설정에도 순서를 바꾸지 않고 맨 뒤에 보인다(두 정규화기의 규칙).
        { k: "institutionName", t: "Hospital", f: "text" },
      ],
      Technician: [
        { k: "assignedReader", t: "Assigned Reader", f: "text" },
        { k: "techNote", t: "Tech Note" },
        { k: "no", t: "No", num: 1 },
        { k: "count", t: "Count", num: 1 },
        { k: "series", t: "Series", num: 1 },
        { k: "em", t: "EM", f: ["E", "N"] },
        { k: "ss", t: "SS", f: ["Verified", "Unverified"] },
        { k: "matched", t: "Mt", f: ["M", "U"] },
        { k: "rs", t: "RS", f: ["A", "H", "O", "P", "T", "W"] },
        { k: "acc", t: "Accession No", f: "text" },
        { k: "id", t: "ID", f: "text" },
        { k: "name", t: "Name", f: "text" },
        { k: "age", t: "Age", num: 1 },
        { k: "sex", t: "Sex", f: ["M", "F", "O"] },
        { k: "modality", t: "Modality", f: ["CT", "MR", "CR", "US", "SC"] },
        { k: "desc", t: "StudyDesc", f: "text" },
        { k: "date", t: "StudyDate" },
        { k: "ward", t: "Ward", f: "text" },
        { k: "reqHosp", t: "ReqHosp" },
      ],
    };
    // 빈 StudyDescription을 데이터에 채우면 "같은 검사명" 묶음과 Modify 원본까지
    // 모달리티로 바뀐다. 원본 의미는 보존하고, 사람이 읽는 자리에서만 대체한다.
    function shownStudyDesc(s) {
      return String(s?.desc ?? "").trim()
        || String(s?.modality ?? "").trim()
        || "(설명 없음)";
    }

    // 특수 렌더링이 필요한 칸만 함수로
    let studyPriority = null;
    const CELL = {
      assignedReader:s=>`<button type="button" class="chip" data-reader-assignment="${esc(s.uid)}" ${!serverMode||demoMode||offline?'disabled':''}>${esc(s.assignedReader||'Unassigned')}</button>`,
      techNote: s => `<button type="button" class="chip" data-tech-note="${esc(s.uid)}" aria-label="${esc(s.id)} Tech 메모 ${noteLabel(s.uid)}" ${!serverMode || demoMode || offline ? 'disabled' : ''}>${noteLabel(s.uid)}</button>`,
      em: s => {const phase=studyPriority?.get(s.uid)?.phase;return phase?`<span title="${phase==='saving'?'응급 상태를 저장 중입니다':'저장 결과 미확인 — 문맥 메뉴의 Refresh Status로 확인하세요'}">${phase==='saving'?'Saving':'Unverified'}</span>`:s.em === "E" ? `<span class="em-e">E</span>` : "";},
      rs: s => `<span class="rs ${esc(s.rs)}" title="${esc(s.holdReason ?? "")}">${esc(s.rs)}</span>`,
      ts: s => `<span class="ts ts-${esc(s.ts)}">${esc(s.ts)}</span>`,
      ss: s => `<span class="ss ${esc(s.ss)}">${esc(s.ss)}</span>`,
      // S4-U5: server values too, but escaped like every other cell; a stored value never becomes markup.
      matched: s => `<span class="mt ${esc(s.matched)}">${esc(s.matched)}</span>`,
      desc: s => esc(shownStudyDesc(s)),
      preDoc: s => esc(displayActor(s.preDoc)),
      preReviewer: s => esc(displayActor(s.preReviewer)),
      // Viewing: 지금 이 검사의 판독문을 쓰고 있는 사람
      viewing: s => !s.holder ? ""
        : s.holder === user
          ? `<span class="hold me" title="내가 작성 중">✎ 나</span>`
          : `<span class="hold other" title="${esc(displayActor(s.holder))} 님이 작성 중">✎ ${esc(displayActor(s.holder))}</span>`,
      // S7-U3b Hospital: 서버가 준 소유 기관 이름만 쓴다. Tele는 행의 tele만 따른다 — 이름을 내 기관 이름과 비교하면
      // 등록 이름이 같은 두 기관에서 틀리고, reqHosp는 Technician에서 손으로 바꿀 수 있는 값이다.
      institutionName: s => {
        const name = typeof s.institutionName === "string" && s.institutionName !== "" ? esc(s.institutionName) : "—";
        return s.tele === true ? `${name} <span class="tele-tag" title="원격판독으로 의뢰받은 검사입니다.">Tele</span>` : name;
      },
    };

    let mode = "Radiology";
    const fval = {};   // 컬럼필터 값 (컬럼 key → 문자열)
    let columnPrefs = null, multiSelection = null, imagePreview = null, imageThumbnails = null, worklistSearch = null, rowNavigation = null, relatedRowNavigation = null, relatedRows = [];
    const shownColumns = () => columnPrefs ? columnPrefs.columns(mode) : COLS[mode];

    function renderHeads() {
      $("#heads").innerHTML = shownColumns().map(c => `<th data-key="${c.k}" class="${c.num ? "num" : ""}">${c.t}</th>`).join("");
      $("#filterrow").innerHTML = shownColumns().map(c => {
        if (!c.f) return "<th></th>";
        if (c.f === "text" || c.k === 'modality')
          return `<th><input data-f="${c.k}" value="${esc(fval[c.k] ?? "")}"></th>`;
        return `<th><select data-f="${c.k}">` +
          ["", ...c.f].map(o => `<option value="${o}"${(fval[c.k] ?? "") === o ? " selected" : ""}>${o}</option>`).join("") +
          `</select></th>`;
      }).join("");
    }
    $("#filterrow").addEventListener("input", e => {
      const el = e.target.closest("[data-f]"); if (!el) return;
      fval[el.dataset.f] = el.value.trim();
      if (el.dataset.f === 'modality') { folderAppliedSearch = null; activeFilterName = null; }
      worklistSearch?.change();
      render();
    });


    // ── 데이터 ──
    // S4-U1b session-local KIN observation (renderObservation). Memory only; a page load starts over.
    let studyObservationModel = window.KinStudyArrivals?.observationStart?.() ?? null;
    // S4-U2 order reconciliation answer (renderOrderReconciliation). Memory only, engineering only.
    let orderReconciliationModel = window.KinOrderReconciliation?.start?.() ?? null;
    // S4-U5 server-read tags and linked-order relations per row (renderStudyIdentity). Memory only, engineering only.
    let studyIdentityModel = window.KinStudyIdentity?.start?.() ?? null;
    // S4-U5 Order List refresh tokens (refreshOrders): only the latest answer may replace the list.
    let orderRefreshSequence = 0;
    // S4-U4 Now Retry request tokens (requestGatewayRetry). Memory only; the server answers a repeat with the first time.
    let gatewayRetryRequestSeq = 0;
    let favoriteList = null, studyTagList = null, studyTagScope = 'personal';
    let demoMode = false;
    let quickDays = -1, sortKey = null, sortDir = 0, selectedOid = null;
    let worklistFolders = null, folderLoadState = 'unknown', folderAppliedSearch = null;
    let filterCollection = null, sharedSearches = [], shortcutDraft = null, shortcutBusy = false, filterReadSequence = 0, sharedFilterReadSequence = 0;
    let storedShortcuts = [];
    // 워크리스트 선택은 "지금 작성할 검사", Related 선택은 썸네일과 이전 판독문에만 쓴다.
    // 둘을 한 변수로 쓰면 prior를 클릭한 순간 저장·승인 대상까지 prior로 바뀐다.
    let relatedUid = null;
    let relatedModality = "", relatedBodyPart = "", relatedIncludeCurrent = false;
    // relatedParts의 종료(pagehide)가 부르는 Related 목록 그리기다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).
    function relatedModalities(study) {
      return [...new Set(String(study.modality ?? "").split(",").map(x => x.trim().toUpperCase()).filter(Boolean))];
    }
    let relatedPage = 0, relatedPageQuery = '';
    function renderRelated(reveal = false) {
      relatedRowNavigation?.beforeRender();
      const s = cur();
      relatedParts.sync(s?.uid||'');
      $('#related-include-current').checked=relatedIncludeCurrent;$('#related-include-current').disabled=!s;
      $('#related-load-parts').disabled=!s||!serverMode||offline||demoMode||relatedParts.busy();
      $('#related-cancel-parts').hidden=!relatedParts.busy();
      $("#related-return").disabled = !s || !relatedUid;
      $("#related-current").textContent = s
        ? `판독 대상 · ${s.date || "날짜 없음"} · ${s.modality} · ${s.name} (${s.id}) · ${shownStudyDesc(s)}`
        : "판독 대상을 선택하세요";
      $("#related-current").title = $("#related-current").textContent;
      let rel = [];
      if (s) {
        rel = relatedCandidates().filter(x => relatedIncludeCurrent || x.uid !== s.uid);
        rel = [...rel].sort((a, b) => b.date.localeCompare(a.date) || b.uid.localeCompare(a.uid));
      }
      const total = rel.length;
      const known=relatedCandidates().filter(x=>relatedParts.get(x.uid)?.parts).length;
      const partTokens=[...new Set(relatedCandidates().flatMap(x=>relatedParts.get(x.uid)?.parts||[]))].filter(Boolean).sort();
      const body=$('#related-body-part'),bodyOptions=[new Option('All Body Parts',''),new Option('Unverified','?'),new Option('Unspecified',JSON.stringify('')),
        ...partTokens.map(v=>new Option(v,JSON.stringify(v)))];
      if(relatedBodyPart&&!bodyOptions.some(o=>o.value===relatedBodyPart))bodyOptions.push(new Option(JSON.parse(relatedBodyPart),relatedBodyPart));
      body.replaceChildren(...bodyOptions);body.value=relatedBodyPart;body.disabled=!s;body.title=body.selectedOptions[0]?.textContent||'';
      $('#related-parts-status').textContent=relatedParts.note() || (s?`${relatedParts.busy()?'조회 중 · ':''}부위 확인 ${known}/${relatedCandidates().length} · 미조회·실패는 Unverified` : '');
      const modality = $("#related-modality");
      const tokens = [...new Set(rel.flatMap(relatedModalities))].sort();
      const options = [new Option("All Modalities", ""), new Option("Unspecified", JSON.stringify("")),
        ...tokens.map(token => new Option(token, JSON.stringify(token)))];
      // 마지막 일치 항목이 사라져도 사용자가 고른 조건을 몰래 전체로 넓히지 않는다.
      if (relatedModality && !options.some(option => option.value === relatedModality))
        options.push(new Option(JSON.parse(relatedModality), relatedModality));
      modality.replaceChildren(...options);
      modality.value = relatedModality;
      modality.disabled = !s;
      modality.title = modality.selectedOptions[0]?.textContent || "";
      if (relatedModality) {
        const token = JSON.parse(relatedModality);
        rel = rel.filter(x => token ? relatedModalities(x).includes(token) : !relatedModalities(x).length);
      }
      if(relatedBodyPart)rel=rel.filter(x=>{const parts=relatedParts.get(x.uid)?.parts;return relatedBodyPart==='?'?!parts:!!parts&&parts.includes(JSON.parse(relatedBodyPart));});
      $("#related-filter-count").textContent = `${rel.length} / ${total}`;
      $("#related-filter-hidden").hidden = !s || !relatedUid || rel.some(x => x.uid === relatedUid);
      const pageQuery = JSON.stringify([selectedUid, relatedModality, relatedBodyPart, relatedIncludeCurrent]);
      if (pageQuery !== relatedPageQuery) { relatedPage = 0; relatedPageQuery = pageQuery; }
      const viewed = rel.findIndex(x => x.uid === relatedUid), pages = Math.max(1, Math.ceil(rel.length / 50));
      if (reveal === true && viewed >= 0) relatedPage = Math.floor(viewed / 50);
      relatedPage = Math.max(0, Math.min(relatedPage, pages - 1));
      $('#related-pages').hidden = pages <= 1;
      $('#related-page-prev').disabled = relatedPage === 0; $('#related-page-next').disabled = relatedPage >= pages - 1;
      $('#related-page-current').disabled = viewed < 0;
      $('#related-page-status').textContent = `${relatedPage + 1}/${pages}페이지`;
      relatedRows = rel;
      $("#relrows").innerHTML = s
        ? (rel.slice(relatedPage * 50, (relatedPage + 1) * 50).map(x => {
            return `
            <tr data-uid="${esc(x.uid)}" class="${x.uid === relatedUid || (x.uid === s.uid && !relatedUid) ? "related-selected" : ""}">
              <td>${x.uid === s.uid ? "Reading Target" : relatedDateLabel(x)} · ${x.uid === relatedUid || (x.uid === s.uid && !relatedUid) ? "👁 열람 중" : "비교"}</td>
              <td>${esc(x.date)}</td><td>${esc(x.modality)}</td><td>${esc(shownStudyDesc(x))}</td><td class="num">${esc(x.count)}</td>
              <td><span class="rs ${esc(x.rs)}">${esc(x.rs)}</span></td>
              <td>${x.rs === "A" ? "Approved" : "No Report"} <button class="chip" type="button" data-related-open="${esc(x.uid)}">${x.uid === s.uid ? 'Open Images' : 'Compare Images'}</button></td>
            </tr>`;
          }).join("") || `<tr><td class="empty" colspan="7">${relatedModality || relatedBodyPart ? "조건에 맞는 관련 검사 없음" : "관련 검사 없음"}</td></tr>`)
        : `<tr><td class="empty" colspan="7">검사를 선택하세요</td></tr>`;
      columnPrefs?.decorateRelated(mode);
      relatedRowNavigation?.sync();
    }

    const relatedParts = KinRelatedParts.create({
      owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key||null;},
      changed:()=>renderRelated()
    });
    const worklistBodyParts = mountWorklistBodyParts();
    function mountWorklistBodyParts() {
      let frame = null, ended = false;
      const model = KinWorklistBodyParts.create({
        owner: () => !ended && serverMode && !offline && !demoMode
          ? KinViewerOpening.key(KinAuth.session()) || null : null,
        changed: () => {
          if (frame !== null) return;
          // 부위 조회가 알린 변화를 그리는 일도 그 알림이 온 때의 문맥을 지난다 — 준비·종료 뒤의 프레임은 목록을 다시 그리지 않는다.
          const at = work.capture("document");
          frame = requestAnimationFrame(() => {
            frame = null;
            work.commit(at, () => {
              render();
              savedFilterManager.refreshCounts();
            });
          });
        }
      });
      const read = refresh => { model.sync(studies); return model.load({refresh}); };
      $('#body-parts-load').addEventListener('click', () => read(false));
      $('#body-parts-refresh').addEventListener('click', () => read(true));
      $('#body-parts-cancel').addEventListener('click', () => model.cancel());
      const end = () => { ended = true; model.end(); };
      onSessionEnd(end);
      window.addEventListener('pagehide', end);
      return model;
    }
    function bodyPartCountNote(filter) {
      const columns = COLS[filter?.mode] || COLS[mode];
      if (!KinCompoundFilter.usesField(filter?.cols?.[KinCompoundFilter.KEY], 'bodyPart', columns)) return '';
      worklistBodyParts.sync(studies);
      const missing = studies.filter(s => worklistBodyParts.get(s.uid) === undefined).length;
      return missing ? `Partial · 부위 미확인 ${missing}건이 있어 결과가 아직 완전하지 않습니다. Read Body Parts로 조회하세요.` : '';
    }
    function renderBodyParts() {
      const state = worklistBodyParts.sync(studies);
      $('#body-parts-load').disabled = !state.allowed || state.busy || !state.total || state.verified === state.total;
      $('#body-parts-load').textContent = state.failed ? 'Retry Body Parts' : state.verified ? 'Resume Body Parts' : 'Read Body Parts';
      $('#body-parts-refresh').hidden = !state.verified && !state.failed;
      $('#body-parts-refresh').disabled = !state.allowed || state.busy;
      $('#body-parts-cancel').hidden = !state.busy;
      $('#body-parts-status').textContent = state.note || (state.busy
        ? `부위 조회 중 · ${state.verified}/${state.total}건 확인`
        : state.verified || state.failed ? `부위 ${state.verified}/${state.total}건 확인 · 실패 ${state.failed}건`
        : 'Body Part 검색은 촬영 부위 조회 후 사용할 수 있습니다.');
    }
    function relatedCandidates() {
      const s=cur();return s ? studies.filter(x=>x.uid===s.uid || (s.sourcePatientKey&&x.sourcePatientKey===s.sourcePatientKey)) : [];
    }

    const DEMO_IMG = "data:image/svg+xml," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='black'/><ellipse cx='60' cy='60' rx='42' ry='50' fill='%23555'/><ellipse cx='60' cy='60' rx='36' ry='44' fill='%23888'/><ellipse cx='60' cy='55' rx='10' ry='6' fill='%23333'/><text x='60' y='112' fill='%23666' font-size='9' text-anchor='middle'>DEMO</text></svg>`);

    // 저장된 상태를 검사 객체에 얹는다. Match로 덮어쓴 값(ov)이 가장 마지막에 적용된다.
    function applyState(s) {
      const a = appState[s.uid] ?? {};
      s.em = a.em ?? s.em ?? "N";
      s.rs = a.rs ?? "W";
      s.holdReason = a.holdReason ?? null;
      s.ts = a.ts ?? "none";
      s.ss = a.ss ?? s.ss ?? "Verified";
      s.matched = a.matched ?? "U";
      s.ward = a.ward ?? s.ward ?? "";
      // 기관명은 서버가 정한다. Switch ReqHosp로 손으로 적어 넣던 값은
      // 기관이 실제 데이터가 된 지금 그것을 덮으면 안 된다.
      s.reqHosp = s.institutionName ? s.reqHosp : (a.reqHosp ?? s.reqHosp ?? "KIN");
      s.preDoc = a.preDoc ?? "";
      s.preReviewer = a.preReviewer ?? "";
      s.prelimHidden = a.prelimHidden;
      s.holder = a.holder;          // 서버가 만료된 점유는 빼고 준다
      s.version = a.version ?? 0;   // 낙관적 락 기준
      // S4-U5: the overlay repaints display fields only. RS, matching, UID, patient key and the rest of the row state
      // above always stay as the server sent them, whatever a stored overlay carries.
      for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) s[key] = a.ov[key];
      return s;
    }

    /**
     * 검사 목록.
     *
     * 서버 모드에서는 **API가 준 목록만** 쓴다. 예전엔 여기서 Orthanc의
     * /dicom-web/studies 를 직접 불렀는데, 그러면 기관 필터를 걸 곳이 화면밖에 없다.
     * 화면 필터는 경계가 아니라 커튼이다 — 주소창에 그 URL을 치면 다 보인다.
     * 이제 서버가 QIDO를 대신 부르고 기관으로 거른 뒤 상태까지 얹어서 준다.
     *
     * 서버가 없을 때(데모·오프라인)만 Orthanc 직통 경로가 남는다. 그 경로에는
     * 기관 개념이 없으므로 전부 "(로컬)"로 보인다 — 진짜처럼 보이면 안 되니까.
     */
    /** API가 준 검사 하나를 화면이 쓰는 모양으로 */
    const noteSummaries = new Map();
    function noteLabel(uid) {
      const note = noteSummaries.get(uid);
      return !note ? '미확인' : note.present ? '있음' : note.version ? '비움·이력' : '없음';
    }
    function updateNoteSummary(uid, value) {
      if (!value || !Number.isInteger(value.version) || value.version < 0 || typeof value.present !== 'boolean') return;
      // A list poll started before a local save must not roll the badge backward.
      if ((noteSummaries.get(uid)?.version ?? -1) > value.version) return;
      noteSummaries.set(uid, value);
      const study = studies.find(s => s.uid === uid);
      const button = $('#rows').querySelector(`[data-tech-note="${CSS.escape(uid)}"]`);
      if (button && study) { button.textContent = noteLabel(uid); button.setAttribute('aria-label', study.id + ' Tech 메모 ' + noteLabel(uid)); }
    }
    const readerAssignments=new Map();
    function updateReaderAssignment(uid,value){
      const previous=readerAssignments.get(uid);if(value&&previous&&value.revision<previous.revision)return;
      readerAssignments.set(uid,value);const study=studies.find(s=>s.uid===uid);if(study)study.assignedReader=value?.reader?[value.reader.name,value.reader.actor].filter(Boolean).join(' · '):'';
    }
    function fromApi(s) {
      updateReaderAssignment(s.uid,s.readerAssignment);
      updateNoteSummary(s.uid, s.techNote);
      /**
       * **서버 상태가 화면 상태를 대신하는 자리는 전부 같은 규칙을 지난다**(`mergeObservedReportState`).
       *
       * 여기가 목록 한 줄의 상태를 실제로 갈아끼우는 곳이고, 폴링만이 아니라 **Refresh 단추**가
       * 부르는 `load()`도 이 함수를 지난다(Auto Refresh를 Manual로 두면 그게 유일한 갱신이다).
       * 규칙을 부르는 쪽마다 따로 두면 그중 하나가 빠지고, 실제로 그렇게 빠져 있었다 —
       * 아직 서버에 보내지 못한 글을 담은 검사가 고른 검사가 아니면 그 글이 사라졌다.
       * 바로 아래 `applyState`가 `appState`를 읽으므로 목록 행의 판 번호도 여기서 맞는다.
       */
      appState[s.uid] = mergeObservedReportState(s.uid, s.state);
      return applyState({
        uid: s.uid, pf: "·", assignedReader:readerAssignments.get(s.uid)?.reader?[readerAssignments.get(s.uid).reader.name,readerAssignments.get(s.uid).reader.actor].filter(Boolean).join(" · "):"",
        count: s.count, series: s.series, acc: s.acc,
        id: s.id, name: s.name, sourcePatientKey: s.sourcePatientKey,
        age: (s.birth && s.date) ? Math.floor((+s.date - +s.birth) / 10000) : "",
        birth: fmtD(s.birth), sex: s.sex,
        modality: s.modality, desc: s.desc, date: fmtD(s.date),
        // ReqHosp 열에 들어가는 진짜 기관명. 원격판독으로 받은 검사는 표시를 붙인다 —
        // 내 병원 검사인지 남의 병원 검사인지가 판독의에게 한눈에 보여야 한다.
        institutionName: s.institutionName,
        reqHosp: s.tele ? `${s.institutionName} ▸원격` : s.institutionName,
        tele: s.tele,
        gatewayReceipt: s.gatewayReceipt ?? null,
      });
    }

    let listLoadSequence = 0;
    // studyPriority·Quick Match·검색·기능 패널의 종료가 부르는 목록·칩·판독 단추 그리기 묶음이다. 분할된 script 사이의 입력·종료가 미정의를 만나지 않게 이 생성보다 앞에 둔다(S9-U0a-PRE).
    function savedFilterDays(value) {
      if (value === null || value === "" || typeof value === "boolean") return -1;
      const days = Number(value);
      return Number.isFinite(days) ? days : -1;
    }
    /** 저장된 필터도 현재 목록과 같은 규칙으로 센다. 화면 상태를 바꾸지 않으므로
     * 다른 저장 필터의 건수를 보려고 지금 하던 검색이 흔들리지 않는다. */
    function filteredFor(filter, rows = studies) {
      if (rows === studies) worklistBodyParts.sync(studies);
      return rows.filter(filterPredicate(filter));
    }
    function filterPredicate(filter) {
      const filterMode = Array.isArray(COLS[filter?.mode]) ? filter.mode : mode;
      const cols = COLS[filterMode].filter(c => c.f);
      const days = savedFilterDays(filter?.days);
      const values = filter?.cols && typeof filter.cols === "object" ? filter.cols : {};
      const needsParts = KinCompoundFilter.usesField(values[KinCompoundFilter.KEY], 'bodyPart', COLS[filterMode]);
      const matchCompound = KinCompoundFilter.compile(values[KinCompoundFilter.KEY], COLS[filterMode]);
      const matchQuick = KinCompoundFilter.compileQuick(filter?.quick, values[KinCompoundFilter.KEY], COLS[filterMode]);
      return s => {
        if (!matchQuick(s)) return false;
        if (!withinDays(s.date, days)) return false;
        return cols.every(c => testCol(s, c, values))
          && matchCompound(needsParts ? {...s, bodyPart: worklistBodyParts.get(s.uid)} : s);
      };
    }
    let consultationFilter = null;
    const searchCriteria = () => ({mode,quick:$('#quick').value,days:quickDays,cols:JSON.parse(JSON.stringify(fval))});
    function folderSearches() {
      return [...userFilters.filter(f => Number.isInteger(f.id)).map(f => ({ ...f, treeId: 'own:' + f.id })),
        ...sharedSearches.map(f => ({ ...f, treeId: 'shared:' + f.id }))];
    }
    function folderSearchAvailable() {
      if (!folderAppliedSearch) return true;
      return folderSearches().some(f => f.treeId === folderAppliedSearch.id
        && (!f.treeId.startsWith('shared:') || f.name === folderAppliedSearch.name));
    }
    function updateWorklistFolders() {
      if (!worklistFolders) return;
      const searches = folderSearches().filter(f => Array.isArray(COLS[f.mode])
        && !KinCompoundFilter.validate(f.cols?.[KinCompoundFilter.KEY], COLS[f.mode]))
        .filter(f => !(folderAppliedSearch?.id === f.treeId && f.treeId.startsWith('shared:') && f.name !== folderAppliedSearch.name))
        .map(f => {
          const criteria = JSON.parse(JSON.stringify(f));
          // Compile once per search update, not once for every row counted in the tree.
          const match = filterPredicate(criteria), unknown = !!bodyPartCountNote(criteria);
          return { id: f.treeId, name: f.name, matches: row => unknown ? null : match(row) };
        });
      worklistFolders.update({ rows: studies, loadState: offline ? 'unknown' : folderLoadState, searches,
        shortcuts: shortcutDraft ?? storedShortcuts });
      if (!folderAppliedSearch) {
        const value = (worklistSearch?.read(searchCriteria()).criteria || searchCriteria()).cols?.modality;
        const tokens = Array.isArray(value) ? value : String(value || '').split(/[,\\]/).map(v => v.trim().toUpperCase()).filter(Boolean);
        const ids = Array.isArray(value) || tokens.length ? tokens.map(v => 'modality:' + v) : ['all'];
        if (JSON.stringify(worklistFolders.snapshot().selectedIds) !== JSON.stringify(ids)) worklistFolders.setApplied(ids);
      }
    }
    function alignWorklistFolder(filter, id) {
      if (!worklistFolders) return;
      updateWorklistFolders();
      if (id) { worklistFolders.setApplied(id); return; }
      const value = filter?.cols?.modality;
      const modalities = Array.isArray(value) ? value : String(value || '').split(/[,\\]/).map(v => v.trim().toUpperCase()).filter(Boolean);
      worklistFolders.setApplied(Array.isArray(value) || modalities.length ? modalities.map(v => 'modality:' + v) : 'all');
    }
    function mountWorklistFolders() {
      if (worklistFolders || !$('#worklist-folders')) return;
      worklistFolders = KinWorklistFolderTree.mount({ host: $('#worklist-folders'),
        onSelect(item) {
          if (!work.admits(work.capture('document'))) return;
          if (item.kind === 'search' || item.kind === 'shortcut') {
            const filter = folderSearches().find(f => f.treeId === item.searchId);
            if (filter) applyFilter(filter, item.id);
            return;
          }
          folderAppliedSearch = null; activeFilterName = null;
          if (item.kind === 'all') delete fval.modality;
          else fval.modality = [...item.modalities];
          worklistSearch?.apply(); renderHeads(); render();
        },
        onChange: saveFolderShortcuts,
      });
      $('#shortcuts-reload').addEventListener('click', () => reloadFolderSearches());
      $('#shortcuts-save').addEventListener('click', () => saveFolderShortcuts(shortcutDraft));
      updateWorklistFolders();
    }
    function filtered() {
      if (!folderSearchAvailable()) return [];
      const search = worklistSearch?.read(searchCriteria());
      const list = search?.empty ? [] : filteredFor(search?.criteria || searchCriteria());
      const favorites = favoriteList ? favoriteList.filter(list) : list;
      const tagged = studyTagList ? studyTagList.filter(favorites) : favorites;
      return consultationFilter ? tagged.filter(s => consultationFilter.uids.has(s.uid)) : tagged;
    }
    // Navigation and its position indicator must use the same order the reader sees.
    function orderedStudies() {
      const list = filtered();
      if (sortDir !== 0 && sortKey)
        list.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0) * sortDir);
      return list;
    }
    let resultPage = 0, resultQuery = '', resultPageSize = 100;
    function render(revealUid) {
      updateWorklistFolders();
      const cols = COLS[mode], shown = shownColumns();
      const list = orderedStudies();
      const appliedSearch = worklistSearch?.read(searchCriteria());
      const bodyPartNote = appliedSearch?.empty ? '' : bodyPartCountNote(appliedSearch?.criteria || searchCriteria());
      renderBodyParts();
      const query = JSON.stringify([appliedSearch?.criteria || searchCriteria(), appliedSearch?.empty, sortKey, sortDir, favoriteList?.key(), studyTagList?.key(), consultationFilter?.revision ?? 0]);
      if (query !== resultQuery) { resultPage = 0; resultQuery = query; }
      if (typeof revealUid === 'string') {
        const index = list.findIndex(s => s.uid === revealUid);
        if (index >= 0) resultPage = Math.floor(index / resultPageSize);
      }
      const pages = Math.max(1, Math.ceil(list.length / resultPageSize));
      resultPage = Math.max(0, Math.min(resultPage, pages - 1));
      const offset = resultPage * resultPageSize;
      // Keep restored form-control values consistent with the actual page size.
      $('#page-size').value = String(resultPageSize);
      $('#page-prev').disabled = resultPage === 0; $('#page-next').disabled = resultPage >= pages - 1;
      $('#page-current').disabled = !list.some(s => s.uid === selectedUid);
      $('#row-keyboard-help').textContent='↑/↓ · Home/End 이동 · Space 선택 · Enter '+(mode==='Radiology'?'판독 진입':'검사 선택');
      $('#page-status').textContent = `불러온 목록 중 ${list.length ? offset + 1 : 0}–${Math.min(offset + resultPageSize, list.length)} / ${list.length}건 · ${resultPage + 1}/${pages}페이지` + (bodyPartNote ? ` · ${bodyPartNote}` : '');

      rowNavigation?.beforeRender();
      $("#rows").innerHTML = list.slice(offset, offset + resultPageSize).map((s, i) => `
        <tr data-uid="${esc(s.uid)}" tabindex="-1" class="st-${esc(String(s.rs).toLowerCase())}${s.uid === selectedUid ? " sel" : ""}${mode === "Radiology" && s.ss === "Unverified" && s.em !== "E" ? " unv" : ""}">` +
        shown.map(c => {
          // CELL[]은 우리가 만든 HTML이라 그대로, 나머지는 전부 외부 문자열이라 이스케이프
          const v = c.k === "no" ? offset + i + 1 : (CELL[c.k] ? CELL[c.k](s) : esc(s[c.k] ?? ""));
          const classes = [c.num ? "num" : "", c.k === "acc" ? "acc" : "", ["id", "birth"].includes(c.k) ? "dim" : ""];
          return `<td class="${classes.filter(Boolean).join(" ")}">${v}</td>`;
        }).join("") + `</tr>`).join("")
        || `<tr><td class="empty" colspan="${shown.length}">${bodyPartNote ? '부위 확인 전인 검사가 있어 검색 결과가 아직 완전하지 않습니다.' : 'No records found'}</td></tr>`;
      columnPrefs?.decorate(mode);
      multiSelection?.sync();
      rowNavigation?.sync();
      worklistSearch?.show();

      const active = [];
      if (consultationFilter) {
        const known = new Set(studies.map(s=>s.uid));
        const missing = [...consultationFilter.uids].filter(uid=>!known.has(uid)).length;
        active.push(consultationFilter.label + (missing ? ` · ${missing} not in loaded worklist` : ''));
      }
      if (favoriteList?.label()) active.push(favoriteList.label());
      if (studyTagList?.label()) active.push(studyTagList.label());
      // `.on` 버튼이 없으면 `.textContent`가 TypeError를 내고 **render() 전체가 죽는다** —
      // 목록도, 카운트도, 필터 표시도 안 그려진다. 서버 필터가 0/3/7/30/60/-1 외의
      // days를 주면 어느 버튼도 `.on`이 아니라 실제로 도달한다.
      // 화면 한 줄을 못 쓰는 것과 화면 전체가 안 그려지는 것은 다른 사고다.
      if (quickDays >= 0)
        active.push(`StudyDate(${$("#qf .on")?.textContent ?? `최근 ${quickDays}일`})`);
      cols.forEach(c => { if (fval[c.k]) active.push(`${c.t}(${fval[c.k]})${shown.includes(c) ? '' : ' [숨긴 열]'}`); });
      if (sortKey && sortDir && !shown.some(c => c.k === sortKey)) active.push(`숨긴 열 정렬: ${COLS[mode].find(c => c.k === sortKey)?.t ?? sortKey} ${sortDir > 0 ? '오름차순' : '내림차순'}`);
      const compound = fval[KinCompoundFilter.KEY];
      const compoundError = KinCompoundFilter.validate(compound, cols);
      $("#quick-match").value = compoundError ? "" : KinCompoundFilter.quickMode(compound);
      if (!compoundError && compound?.version === 2) active.push("Patient Search: " + (compound.quickMatch === "exact" ? "Exact" : "Starts With"));
      if (compoundError) active.push(`복합 조건 오류: ${compoundError} · 조건을 수정하거나 Clear로 해제하세요`);
      else if (compound?.rules.length) {
        active.push('복합 ' + KinCompoundFilter.describe(compound, cols));
      }
      $("#filterlist").textContent = (appliedSearch?.pending ? "Draft Filter (not applied) : " : "Filter : ") + (active.join(", ") || "-");

      const n = (k, v) => list.filter(s => s[k] === v).length;
      if (mode === "Radiology") {
        $("#countlist").innerHTML =
          `<span class="count"><span class="dot dot-w"></span>W:${n("rs","W")}</span>` +
          `<span class="count"><span class="dot dot-a"></span>A:${n("rs","A")}</span>` +
          `<span class="count"><span class="dot dot-ho"></span>H:${n("rs","H")}</span>` +
          `<span class="count"><span class="dot dot-ho"></span>O:${n("rs","O")}</span>` +
          `<span class="count"><span class="dot dot-t"></span>T:${n("rs","T")}</span>` +
          `<span class="count"><span class="dot dot-p"></span>P:${n("rs","P")}</span>` +
          `<span class="count">Unverified:${n("ss","Unverified")}</span>`;
      } else {
        $("#countlist").textContent =
          `Verified:${n("ss","Verified")} Unverified:${n("ss","Unverified")} · Unmatched:${n("matched","U")} · Total ${list.length}`;
      }
      renderChips();
      // S4-U5: the poll merges row state after it reports the observation, so the identity panel is redrawn here
      // too; its stale rule reads that merged state (a correction answer or a newer poll), never an older one.
      renderStudyIdentity();
    }
    function relatedStudy() { return relatedUid ? studies.find(s => s.uid === relatedUid) : null; }
    function viewed() { return relatedStudy() ?? cur(); }
    function renderStudyIdentity() {
      const box = $("#study-identity");
      if (!box || !studyIdentityModel) return;
      const s = viewed();
      const view = s ? KinStudyIdentity.view(studyIdentityModel, s.uid, appState[s.uid] ?? {}) : { hidden: true };
      const drawn = JSON.stringify(view);
      if (box.dataset.view === drawn) return;   // unchanged: keep the open panel and any text selection as they are
      box.dataset.view = drawn;
      box.hidden = view.hidden;
      if (view.hidden) return;
      $("#study-identity-summary").textContent = view.summary.text;
      $("#study-identity-summary").title = view.summary.title;
      const order = $("#study-identity-order");
      order.textContent = view.order?.text ?? ""; order.title = view.order?.title ?? "";
      $("#study-identity-tags").replaceChildren(...view.rows.map(row => {
        const line = document.createElement("div"), value = document.createElement("span"), relation = document.createElement("span");
        line.setAttribute("role", "listitem"); line.dataset.tag = row.key;
        value.textContent = `${row.tag} ${row.label}: ${row.value}`; value.title = row.valueTitle;
        relation.textContent = row.relation ? ` · ${row.relation}` : ""; relation.title = row.title;
        line.append(value, relation);
        return line;
      }));
      $("#study-identity-guidance").textContent = view.guidance;
    }
    /**
     * 표시줄이 안내하는 확정 단추는 **지금 눌리는 것뿐이다.** 승인된 판독문에서 Save·Approve는 잠겨 있는데 "확정하려면 Save
     * 또는 Approve"라고 쓰면 사람은 갈 수 없는 길을 안내받는다(U5CLI-F11). 무엇이 눌리는가는 단추를 잠그는
     * `updateReportButtons`가 정한 그대로 읽는다 — 같은 판단을 여기서 다시 계산하면 언젠가 한쪽만 고쳐진다. 그래서 단추를
     * 다시 잠그거나 푸는 그 함수가 끝에 이것을 부른다. 확정이 나가 있는 동안은 눌리는 것이 없으므로 안내도 없다.
     */
    function renderDraftHint() {
      const hint = $("#drafthint");
      if (!hint) return;
      const open = id => { const el = $(id); return !!el && !el.disabled; };
      hint.textContent = open("#b-addendum") ? " · 추가기재로 확정하려면 More ▸ Addendum"
        : open("#b-save") && open("#b-approve") ? " · 확정하려면 Save 또는 Approve"
        : open("#b-save") ? " · 확정하려면 Save" : open("#b-approve") ? " · 확정하려면 Approve" : "";
    }
    function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
    function updateReportButtons() {
      const s = cur();
      const rad = KinAuth.has("radiologist");
      const filming = s?.ss === "Unverified" && s?.em !== "E";
      const filmingTitle = "촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다";
      const held = heldByOther(s);
      const heldTitle = `${displayActor(held)} 님이 판독 중입니다`;
      $("#holdbar").style.display = held ? "flex" : "none";
      $("#holdmsg").textContent = held ? `✎ ${heldTitle} — 잠금이 풀리면 이어서 판독할 수 있습니다` : "";
      $("#deferbar").style.display = s?.rs === "H" ? "flex" : "none";
      $("#defermsg").textContent = s?.rs === "H" ? `⏸ On Hold — ${s.holdReason ?? ""}` : "";
      // 남의 예비 판독은 읽지도 쓰지도 못한다. 서버가 막지만 회색으로 보이는 편이 낫다 —
      // 눌러보고 거절당하는 건 "왜 안 되지"를 만들고, 회색은 "내 것이 아니구나"를 만든다.
      const locked = !!appState[selectedUid]?.prelimHidden;
      // Clear·Paste가 여기 들어와야 하는 이유: 둘 다 textarea의 `.value`에 직접 쓴다.
      // `readOnly`는 스크립트 대입을 안 막으므로, 잠긴 판독문이 이 두 버튼으로 지워졌다.
      for (const id of ["#b-approve", "#b-save", "#b-transcribe", "#b-unread", "#b-clear", "#b-paste", "#b-defer"]) {
        const el = $(id);
        if (!el) continue;
        el.disabled = !rad || locked || filming || !!held;
        el.title = held ? heldTitle : filming ? filmingTitle : locked ? "다른 판독의의 예비 판독(RS: P)입니다"
          : !rad ? "판독의 권한이 필요합니다" : "";
      }
      // 승인된 판독문을 비우는 길은 사유가 남는 Reset뿐이다. Clear는 그 뒷문이었다.
      $("#b-defer").disabled = !rad || !s || s.rs === "A" || s.rs === "P" || locked || filming || !!held || !serverMode;
      $("#b-defer").title = held ? heldTitle : filming ? filmingTitle
        : locked ? "다른 판독의의 예비 판독(RS: P)입니다"
        : s?.rs === "A" ? "승인된 판독문은 보류할 수 없습니다. 먼저 판독 취소(Reset)를 하세요"
        : s?.rs === "P" ? "예비 판독(RS: P)은 보류할 수 없습니다 — 승인 또는 취소만 가능합니다"
        : !rad ? "판독의 권한이 필요합니다" : !serverMode ? "서버에 연결돼 있을 때만 보류할 수 있습니다" : "";
      if (s?.rs === "A" && rad && !locked && !filming && !held) {
        $("#b-clear").disabled = true;
        $("#b-clear").title = "승인된 판독문은 판독 취소(Reset)로만 비울 수 있습니다";
        // 승인에서 나가는 길은 Addendum·Reset뿐이다. Save(Transcribe도 save다)는 사유 없이 승인을 풀고
        // Approve는 승인자를 갈아치우는 재승인이었다 — 서버가 400으로 막고, 여기서는 회색으로 미리 말해준다.
        for (const id of ["#b-save", "#b-transcribe", "#b-approve"]) {
          $(id).disabled = true;
          $(id).title = "승인된 판독문은 추가기재(Addendum) 또는 판독 취소(Reset)로만 바꿀 수 있습니다";
        }
      }
      // Addendum은 승인된 판독문에만 붙는다
      $("#b-addendum").disabled = s?.rs !== "A" || !rad || locked || filming || !!held;
      $("#b-addendum").title = held ? heldTitle : filming ? filmingTitle : s?.rs !== "A" ? "승인된 판독문에만 추가기재할 수 있습니다" : "";
      /**
       * Prelim은 "아직 확정 안 된 판독을 상급자에게 넘기는" 동작이다.
       * 이미 승인(A)된 것에는 의미가 없고, 이미 P인 것을 다시 넘기면 지정이 덮어써진다.
       * 넘긴 뒤에는 지정된 상급자가 Approve로 끝낸다 — 그건 서버가 강제한다.
       */
      const b = $("#b-prelim");
      if (b) {
        b.disabled = !rad || !s || s.rs === "A" || s.rs === "P" || locked || filming || !!held || !serverMode;
        b.title = held ? heldTitle : filming ? filmingTitle : !serverMode ? "서버에 연결돼 있을 때만 지정할 수 있습니다"
          : s?.rs === "P" ? "이미 예비 판독 중입니다"
          : s?.rs === "A" ? "이미 승인된 판독입니다"
          : "상급 판독의를 지정해 최종 판독을 맡깁니다 (RS: P)";
      }
      for (const id of ["#findings", "#conclusion", "#recommendation"]) {
        $(id).readOnly = !rad || locked || filming || !!held;
      }
      if(studyPriority?.get(selectedUid))for(const id of ['#b-save','#b-approve','#b-transcribe','#b-unread','#b-addendum','#b-prelim','#b-defer']) {
        const button=$(id);if(button){button.disabled=true;button.title='응급 상태 저장 결과를 확인한 뒤 판독을 저장하세요';}
      }
      // 초안 표시줄의 확정 안내는 방금 정한 단추 상태를 그대로 따른다(눌리지 않는 단추를 안내하지 않는다).
      renderDraftHint();
      updateTemplatePreview();
      updateReportTemplateButton();
      // 받아쓰기 단추도 같은 관문을 따른다. 검사 이동도 여기를 지나므로(refreshRight) 떠난 검사의
      // 녹음·요청은 여기서 끝난다 — select()에 두면 그 구역을 실행하는 다른 시험 틀이 깨진다.
      dictation.refresh();
    }
    const validUserFilters = value => Array.isArray(value)
      ? value.filter(uf => uf && typeof uf === "object" && typeof uf.name === "string") : [];
    let userFilters = [];
    try { userFilters = validUserFilters(JSON.parse(localStorage.getItem("kin-filters") ?? "[]")); } catch (e) {}
    let activeFilterName = null;
    function renderActiveFilter() {
      const holder = $('#active-filter-info');
      holder.hidden = activeFilterName === null;
      if (holder.hidden) return;
      const stored = folderAppliedSearch ? folderSearches().find(f => f.treeId === folderAppliedSearch.id) : userFilters.find(f => f.name === activeFilterName);
      if (stored && folderSearchAvailable()) activeFilterName = stored.name;
      const modified = !!stored && (filterCriteriaKey(stored) !== filterCriteriaKey(snapshotFilter())
        || !!favoriteList?.key() || !!studyTagList?.key());
      $('#active-filter-name').textContent = activeFilterName;
      $('#active-filter-state').textContent = !stored || !folderSearchAvailable() ? 'Unavailable' : modified ? 'Search Draft' : 'Saved';
      holder.title = !stored ? '저장 검색이 삭제됐습니다. 현재 목록 조건은 유지됩니다.' : modified
        ? '현재 목록 조건과 저장된 조건이 다릅니다. 저장 검색을 다시 적용하거나 현재 조건을 새 검색으로 저장하세요.'
        : '저장된 검색 조건을 적용 중입니다. 결과 건수는 현재 불러온 목록을 기준으로 합니다.';
      $('#edit-active-filter').disabled = !stored;
    }
    function renderChips() {
      updateWorklistFolders();
      const holder = $("#chips");
      if (!holder) return;
      renderActiveFilter();
      const rows = userFilters.map((uf, i) => {
        const count = filteredFor(uf).length;
        const note = bodyPartCountNote(uf);
        const label = `${uf.name}, 로드된 목록 기준 ${count}건${uf.isDefault ? ", 기본 필터" : ""}${note ? ' · ' + note : ''}`;
        return { i, uf, count, label, partial: !!note };
      });
      // 검색 글자 하나마다 같은 버튼을 다시 만들면 저장 필터에 있던 키보드 포커스가
      // 사라진다. 실제 이름·기본 여부·건수가 바뀔 때만 DOM을 교체한다.
      const signature = JSON.stringify(rows.map(x => [x.uf.id ?? null, x.uf.name, !!x.uf.isDefault, x.count, x.label]));
      if (holder.dataset.renderSignature === signature) {
        holder.querySelectorAll('button[data-i]').forEach(b => b.setAttribute('aria-pressed', String(userFilters[+b.dataset.i]?.name === activeFilterName)));
        return;
      }
      const focused = holder.contains(document.activeElement) ? userFilters[+document.activeElement.dataset.i]?.name : null;
      holder.innerHTML = rows.map(({ i, uf, count, label, partial }) =>
        `<button class="chip" data-i="${i}" data-name="${esc(uf.name)}" aria-label="${esc(label)}" aria-pressed="${uf.name === activeFilterName}" aria-haspopup="menu" ` +
        `title="${esc(label)} · 클릭: 적용 / 우클릭 또는 Shift+F10: 메뉴">` +
        `${uf.isDefault ? "⚑ " : ""}${esc(uf.name)} <span aria-hidden="true">(${count}${partial ? ' · Partial' : ''})</span></button>`
      ).join("");
      holder.dataset.renderSignature = signature;
      if (focused !== null) focusFilterChip(focused);
    }
    studyPriority=KinStudyPriority.create({
      owner:()=>KinViewerOpening.key(KinAuth.session()),
      allowed:uid=>serverMode&&!offline&&!demoMode&&!commitInFlight&&KinAuth.has('technician')&&!!studies.find(s=>s.uid===uid&&!s.tele),
      request:async(uid,em,at)=>{const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
        try{return await api('PATCH','/studies/'+encodeURIComponent(uid),{em},controller.signal,at);}finally{clearTimeout(timeout);}},
      apply:(uid,em)=>{appState[uid]={...appState[uid],em};syncStudy(uid);},
      invalidate:()=>{commitEpoch++;listLoadSequence++;},
      changed:()=>{render();renderRelated();updateReportButtons();},
      notify:(message,error)=>toast(message,error?'err':'')
    });
    function emergencyMenu(uid) {
      const s=studies.find(s=>s.uid===uid),state=studyPriority.get(uid),desired=s?.em==='E'?'N':'E';
      if(state?.phase==='unknown')return {label:'Refresh Status',dis:offline||!serverMode,act:()=>load()};
      return {label:state?.phase==='saving'?'Saving Emergency Status':s?.em==='E'?'Switch to Normal':'Switch to Emergency',
        dis:!!state||!studyPriority.active()||!serverMode||offline||demoMode||commitInFlight||!KinAuth.has('technician')||!s||s.tele,
        act:()=>studyPriority.set(uid,desired)};
    }
    const studyPageClient = KinStudyPages.create({
      request: (path, signal, at) => api('GET', path, undefined, signal, at),
      identity: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution,s.sub] : null; },
      changed: state => {
        if (state.busy) { folderLoadState = studies.length ? 'partial' : 'unknown'; updateWorklistFolders(); }
        $('#study-fetch').hidden = !state.busy && !state.resumable && !state.message;
        $('#study-fetch-status').textContent = state.message + (state.total == null ? '' : ` (${state.received}/${state.total}건 받음 · 완료 후 목록 반영)`);
        $('#study-fetch-resume').hidden = state.busy || !state.resumable; $('#study-fetch-cancel').hidden = !state.busy;
      },
    });
    $('#study-fetch-resume').addEventListener('click', () => load({ resume:true }));
    $('#study-fetch-cancel').addEventListener('click', () => { listLoadSequence++; studyPageClient.cancel(); });
    window.addEventListener('pagehide', () => studyPageClient.clear(), {once:true});
    function assertStudyOwner(result) {
      const session = KinAuth.session();
      if (session?.state !== 'approved' || JSON.stringify(result.owner) !== JSON.stringify([session.institution, session.sub]))
        throw Object.assign(new Error('Study account changed before applying the list.'), {ownerChanged:true});
    }
    /**
     * S5-U6b-F02 메뉴바 저장량(`#storage`). Orthanc 서버 전체의 TotalDiskSize(모든 기관의 영상, D11)이고, 운영 지표의
     * 서버 줄(api/src/pacs.service.ts orthancDiskBytes)과 같은 규칙으로 그 값 하나만 읽는다. 숫자는 범위·원천·이 화면이
     * 답을 받은 시각과 함께만 보인다. 읽기 전과 실패한 뒤에는 `Storage Unobservable`이다 — 예전 기본값 '0.0GB / -'처럼
     * 실패가 0으로 읽히지 않고, 앞서 받은 값이 지금 값처럼 남지 않는다(마지막 값은 설명에만 그 시각과 함께 둔다).
     * 가장 늦게 시작한 읽기만 그린다(A→B→A). 목록 읽기를 실패로 돌리지 않도록 어떤 실패도 밖으로 던지지 않는다.
     */
    let storageSeq = 0, storageLast = null;
    async function refreshStorage(at = work.capture("document")) {
      const seq = ++storageSeq;
      let bytes = null, reason = "원천 조회에 실패했습니다.";
      try {
        const answer = await transport.request("/statistics", { context: at });
        if (answer.status === 403) reason = "이 계정으로는 서버 전체 저장량을 볼 수 없습니다.";
        else if (!answer.ok) reason = `원천이 HTTP ${answer.status}로 답했습니다.`;
        else {
          const raw = answer.body?.TotalDiskSize;
          const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
          if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) bytes = Number(text);
          else reason = "응답 형식을 확인할 수 없습니다.";
        }
      } catch (e) {}
      work.commit(at, () => { if (seq === storageSeq) paintStorage(bytes, reason); });
    }
    function paintStorage(bytes, reason) {
      const box = $("#storage");
      if (!box) return;
      // The Operations row's units (admin.html KinAdminMetrics.formatBytes): powers of 1024, never rounded to 0.
      const size = n => {
        for (const [name, unit] of [["TiB", 2 ** 40], ["GiB", 2 ** 30], ["MiB", 2 ** 20], ["KiB", 2 ** 10]])
          if (n >= unit) return `${(n / unit).toFixed(2)} ${name}`;
        return `${n} B`;
      };
      let view;
      try {
        if (bytes !== null) {
          const at = new Date().toISOString();
          view = { state: "observed", text: `Storage ${size(bytes)} (Server-wide)`,
            title: `Orthanc 서버 전체(모든 기관)의 디스크 사용량입니다. 이 기관 몫이 아닙니다. 원천: Orthanc GET /statistics TotalDiskSize(원천 값 ${bytes}바이트). `
              + `관측 시각: ${KinStudyArrivals.formatTime(at)}(이 화면이 답을 받은 시각). 전체 용량은 원천이 없어 사용률(%)을 보이지 않습니다.` };
          storageLast = { bytes, at };
        } else {
          view = { state: "unobservable", text: "Storage Unobservable",
            title: `서버 전체 저장량을 관측하지 못했습니다. 0으로 두지 않습니다. ${reason}` + (storageLast
              ? ` 마지막으로 관측한 값은 ${size(storageLast.bytes)}(${KinStudyArrivals.formatTime(storageLast.at)})이며 지금 값이 아닐 수 있습니다.` : "") };
        }
      } catch (e) {
        view = { state: "unobservable", text: "Storage Unobservable", title: "서버 전체 저장량을 표시하지 못했습니다. 0으로 두지 않습니다." };
      }
      box.dataset.state = view.state;
      box.textContent = view.text;
      box.title = view.title;
    }
    async function load(options = {}) {
      const loadSequence = ++listLoadSequence, epoch = commitEpoch;
      // 이 읽기를 시작한 문맥. 목록·관측·안내를 쓰는 자리는 모두 이것을 지난다 — 준비·종료 뒤에 온 답은 목록을 바꾸지 않는다.
      const at = work.capture("document");
      /**
       * **서버가 죽었다고 Orthanc를 직접 부르지 않는다.**
       *
       * Orthanc는 API와 다른 컨테이너라 API가 죽어도 살아 있다. 그런데 기관 필터는
       * 서버에 있다 — 브라우저가 `/dicom-web/studies`를 직접 부르면 **남의 병원 검사가
       * 그대로 보인다.** 멀티테넌시를 서버로 옮긴 이유가 "화면 필터는 커튼"이었는데,
       * 고장 경로 하나가 그 커튼마저 걷어버리는 자리였다.
       */
      if (offline) {
        // S4-U1b: 관측 실패는 아무것도 비우지 않는다. 마지막 목록과 관측 시각을 두고 `관측 불가`만 더한다.
        // 차가운 시작에는 둘 목록이 없으므로 빈 스냅숏을 지어내지도 않는다.
        markObservationUnavailable();
        $("#err").textContent = "서버 연결이 끊겨 검사 목록을 불러올 수 없습니다 — 보이는 목록은 마지막 관측값입니다. 우측 상단에서 재시도할 수 있습니다";
        render(); refreshRight();
        return;
      }
      try {
        if (!serverMode) throw new Error("no-server");
        const r = await studyPageClient.read({ resume:!!options.resume, epoch, valid:() => !commitInFlight && epoch === commitEpoch });
        if (!work.admits(at) || loadSequence !== listLoadSequence || commitInFlight || epoch !== commitEpoch) return;
        assertStudyOwner(r);
        await Promise.all([favoriteList?.refresh(),studyTagList?.refresh()]);
        let applied = false;
        work.commit(at, () => {
          if (loadSequence !== listLoadSequence || commitInFlight || epoch !== commitEpoch) return;
        /**
         * **가져오기와 그리기를 나눈다.**
         *
         * 예전엔 `render()`도 이 try 안에 있었다. 목록은 멀쩡히 도착했는데
         * 렌더링에서 예외가 하나 나면(예: `$("#qf .on")` TypeError) 아래 catch가
         * 그걸 "목록 실패"로 처리하고 `studies = []`로 **성공한 데이터를 버렸다.**
         * 화면 그리기 버그가 데이터 없음으로 둔갑하면, 원인을 서버에서 찾게 된다.
         */
        // 편집 중인 검사의 판 번호·초안을 되돌려 놓던 블록은 없앴다 — `fromApi`가 그 규칙을
        // 모든 검사에 대해 먼저 적용하므로, 여기서 한 검사만 다시 손보면 규칙이 둘로 갈린다.
          studies = r.studies.map(fromApi);
          folderLoadState = 'complete';
          applyObservation(r);
          studyPriority.observed(r.studies.map(s=>s.uid));
          worklistAlerts?.observe(r.studies.map(s=>({uid:s.uid,em:s.state.em})));
          $('#err').textContent = '';
          applied = true;
        });
        if (!applied) return;
        await refreshStorage(at);
        // 그리기 실패는 그리기 실패라고 말한다. 데이터는 이미 들어와 있고, 버리지 않는다.
        return work.commit(at, () => {
          try { render(); refreshRight(); worklistStartup?.afterList(); }
          catch (e2) { console.error(e2); toast("화면 그리기 오류: " + e2.message, "err"); }
        }) ? true : undefined;
      } catch (e) {
        if (!work.admits(at) || loadSequence !== listLoadSequence) return;
        // 목록 읽기가 "계정이 바뀌었다"고 했다. 이 세션에 묶어 한 번 확인해 정말 다른 계정의 답일 때만 세션 교체로 닫는다.
        if (e.ownerChanged) {
          studyPageClient.clear();
          if (await accountReplaced(at)) return;
          if (!work.admits(at) || loadSequence !== listLoadSequence) return;
        }
        // 서버 모드에서 목록이 실패하면 **가짜 데이터로 내려가지 않는다.**
        // Incomplete page batches never replace the last complete list or report input.
        if (serverMode) {
          work.commit(at, () => {
            folderLoadState = 'unknown';
            // A superseded or changed-list answer is not a failed observation; the last one still stands.
            if (!e.stale && e.code !== 'STUDY_LIST_CHANGED') markObservationUnavailable();
            $("#err").textContent = "검사 목록을 불러오지 못했습니다. 현재 목록과 입력은 유지했습니다 — " + e.message;
            toast("검사 목록 실패: " + e.message, "err");
            render();
          });
          return;
        }
      }
      try {
        const res = await transport.request("/dicom-web/studies?includefield=00081030,00201206,00201208", { context: at });
        if (!res.ok || !Array.isArray(res.body)) throw new Error("HTTP " + res.status);
        // Refresh and Home read again without waiting: only the last read started may write the list, the notice or
        // the demo flag, so an earlier answer arriving late (success or failure) leaves the newer list alone.
        const answer = res.body;
        if (!work.commit(at, () => {
          if (loadSequence !== listLoadSequence) return;
          studies = answer.map(st => {
          const uid = tagv(st, "0020000D");
          const birth = tagv(st, "00100030"), date = tagv(st, "00080020");
          return applyState({
            uid, pf: "·",
            count: +tagv(st, "00201208") || 0,
            series: +tagv(st, "00201206") || 0,
            acc: tagv(st, "00080050"),
            id: tagv(st, "00100020"),
            name: tagv(st, "00100010").replace(/\^/g, " "),
            age: (birth && date) ? Math.floor((+date - +birth) / 10000) : "",
            birth: fmtD(birth), sex: tagv(st, "00100040"),
            modality: st["00080061"]?.Value?.join(",") ?? "",
            desc: tagv(st, "00081030"), date: fmtD(date),
              reqHosp: "(로컬)",
            });
          });
          render(); refreshRight();
        })) return;
        await refreshStorage(at);
      } catch (e) {
        // 문맥이 무효가 되어 보내지 않았거나 끊긴 읽기는 "Orthanc 미연결"이 아니다 — 가짜 데이터로 내려가지 않는다.
        if (!work.commit(at, () => {
          if (loadSequence !== listLoadSequence) return;
          paintDemoList();
        })) return;
      }
    }
    // ── 데모 모드: Orthanc 없이 열람 시 (GitHub Pages 등) 가짜 데이터로 전환 ──
    function paintDemoList() {
      demoMode = true;
      $("#err").textContent = "데모 모드 — 가짜 데이터 (Orthanc 미연결)";
      const P = (uid, id, name, age, birth, sex, desc, date, acc) => applyState(
        { uid, pf: "·", count: 20, series: 1, acc, id, name, age, birth, sex, modality: "CT", desc, date });
      studies = [
        P("demo-1",  "P-1001", "KIM CHULSOO",  64, "1962-03-04", "M", "Brain CT (synthetic)",         "2026-08-28", "KIN20261000"),
        P("demo-1p", "P-1001", "KIM CHULSOO",  63, "1962-03-04", "M", "Brain CT initial (synthetic)", "2026-02-10", "KIN20260950"),
        P("demo-2",  "P-1002", "LEE YOUNGHEE", 50, "1975-11-22", "F", "Brain CT (synthetic)",         "2026-08-27", "KIN20261001"),
        P("demo-3",  "P-1003", "PARK MINJUN",  37, "1988-10-09", "M", "Brain CT f/u (synthetic)",     "2026-08-27", "KIN20261002"),
        P("demo-4",  "P-1004", "CHOI SUJIN",   33, "1993-05-17", "F", "Brain CT (synthetic)",         "2026-08-26", "KIN20261003"),
        P("demo-5",  "P-1005", "JUNG DOHYUN",  69, "1957-02-28", "M", "Brain CT f/u (synthetic)",     "2026-08-25", "KIN20261004"),
      ];
      render(); refreshRight();
    }


    /**
     * 날짜 퀵필터. "최근 N일" — **양쪽 끝을 다 본다.**
     *
     * 두 가지가 틀려 있었다:
     *
     * ① 타임존. `new Date("2026-08-28")`은 ISO 날짜만 있는 문자열이라 **UTC 자정**으로
     *    읽히는데, 비교 대상은 `setHours(0,0,0,0)`이 만든 **로컬 자정**이었다.
     *    KST(UTC+9)에서는 검사 날짜가 9시간 앞으로 밀려 우연히 맞았지만,
     *    UTC 음수 오프셋에서는 뒤로 밀려 **"Today"가 오늘 검사를 숨긴다.**
     *    숫자를 직접 뜯어 로컬 기준으로 만든다 — 파서의 기분에 맡기지 않는다.
     *
     * ② 상한이 없었다. 미래 날짜(장비 시계가 틀렸거나 오타)가 "최근 7일"에 걸렸다.
     *    "최근"은 과거를 가리키는 말이다.
     */
    function dayStart(dateStr) {
      const m = String(dateStr).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
      if (!m) return null;
      return new Date(+m[1], +m[2] - 1, +m[3]);   // 로컬 자정
    }
    function withinDays(dateStr, days) {
      if (days < 0 || !dateStr) return true;
      const d = dayStart(dateStr);
      if (!d) return true;                        // 못 읽는 날짜는 숨기지 않는다
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const from = new Date(today); from.setDate(from.getDate() - days);
      const to = new Date(today); to.setDate(to.getDate() + 1);   // 오늘 끝까지
      return d >= from && d < to;
    }

    function testCol(s, c, values = fval) {
      const v = values?.[c.k] ?? "";
      if (v === "") return true;
      if (c.k === 'modality') {
        const selected = Array.isArray(v) ? v : String(v).split(/[,\\]/);
        return selected.some(token => KinWorklistFolderTree.matchesModality(s.modality, token));
      }
      const wanted = String(v);
      if (c.f === "text") return String(s[c.k] ?? "").toUpperCase().includes(wanted.toUpperCase());
      return String(s[c.k]) === wanted;
    }

    let consultationFilterSequence = 0;

    // ── 모드 전환 ──
    function setMode(m) {
      mode = m;
      document.querySelectorAll(".tabs > div").forEach(x => x.classList.toggle("on", x.dataset.tab === m));
      const tech = m === "Technician";
      $("#ctxbar").classList.toggle("show", tech);
      document.querySelector(".s-template").style.display = tech ? "none" : "flex";
      document.querySelector(".s-clinical").style.width = tech ? "66%" : "30%";
      document.querySelector(".report-p").style.display = tech ? "none" : "flex";
      document.querySelector(".order-p").style.display = tech ? "flex" : "none";
      $("#routing-factors").hidden = tech;
      // 탭을 바꿔도 **같은 컬럼이 양쪽에 있으면 정렬을 유지한다.**
      // 두 탭의 컬럼 구성이 달라서 예전엔 무조건 초기화했는데, id·name·date처럼
      // 양쪽에 다 있는 컬럼까지 풀리는 건 그냥 손해다.
      // 탭 전환은 화면 전환이지 상태 초기화가 아니다 (교훈 §6 — HPACS가 세 번 낸 버그).
      if (sortKey && !COLS[m].some(c => c.k === sortKey)) { sortKey = null; sortDir = 0; }
      worklistSearch?.apply();
      renderHeads(); render(); renderOrders(); renderRelated();
      applyLayout();
    }
    document.querySelector(".tabs").addEventListener("click", e => {
      const t = e.target.closest("div[data-tab]"); if (!t) return;
      setMode(t.dataset.tab);
    });
    $("#fold").addEventListener("click", () => {
      const b = $("#ctxbtns");
      const hidden = b.style.display === "none";
      b.style.display = hidden ? "flex" : "none";
      $("#fold").textContent = hidden ? "▽" : "△";
    });


    function srTree(dataset, expected) {
      const classes = ['11', '22', '33', '34'].map(n => '1.2.840.10008.5.1.4.1.1.88.' + n);
      const first = tag => dataset?.[tag]?.Value?.[0];
      if (!dataset || first('0020000D') !== expected.study || first('0020000E') !== expected.series ||
          first('00080018') !== expected.sop || first('00080016') !== expected.sopClass ||
          !classes.includes(first('00080016')) || first('00080060') !== 'SR' || first('0040A040') !== 'CONTAINER')
        throw new Error('SR 문서 식별 또는 지원 형식이 일치하지 않습니다.');
      const labels = {'0040A730':'Content Sequence', '0040A040':'Value Type', '0040A010':'Relationship Type',
        '0040A043':'Concept Name', '0040A160':'Text Value', '0040A168':'Concept Code', '0040A300':'Measured Value',
        '0040A30A':'Numeric Value', '004008EA':'Measurement Units', '00080100':'Code Value', '00080102':'Coding Scheme',
        '00080104':'Code Meaning', '0040A120':'DateTime', '0040A121':'Date', '0040A122':'Time', '0040A123':'Person Name',
        '0040A124':'UID', '00081199':'Referenced SOP', '00081150':'Referenced SOP Class', '00081155':'Referenced SOP Instance',
        '00081160':'Referenced Frame', '00700022':'Graphic Data', '00700023':'Graphic Type', '0040DB73':'Referenced Content Item'};
      let nodes = 0, chars = 0;
      const plain = v => v && typeof v === 'object' && !Array.isArray(v);
      const text = v => {
        if (typeof v !== 'string' && typeof v !== 'number' && v !== null) throw new Error('지원하지 않는 SR 값입니다.');
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('잘못된 SR 숫자입니다.');
        const s = v === null ? '(빈 값)' : String(v); chars += s.length;
        if (++nodes > 2000 || chars > 200000) throw new Error('SR 원문 표시 상한을 초과했습니다.');
        return s;
      };
      function walk(ds, depth) {
        if (++nodes > 2000) throw new Error('SR 원문 표시 상한을 초과했습니다.');
        if (!plain(ds) || depth > 32) throw new Error('SR 원문 구조 또는 깊이가 지원 범위를 벗어납니다.');
        return Object.entries(ds).map(([tag, attr]) => {
          if (++nodes > 2000) throw new Error('SR 원문 표시 상한을 초과했습니다.');
          if (!/^[0-9A-F]{8}$/.test(tag) || !plain(attr) || !/^[A-Z]{2}$/.test(attr.vr)) throw new Error('잘못된 DICOM JSON 구조입니다.');
          // External/binary values must never be silently omitted or fetched as links.
          if ('BulkDataURI' in attr || 'InlineBinary' in attr) throw new Error('외부 또는 바이너리 값을 포함한 SR은 지원하지 않습니다.');
          if (Object.keys(attr).some(k => !['vr','Value'].includes(k)) || attr.Value !== undefined && !Array.isArray(attr.Value)) throw new Error('잘못된 DICOM JSON 값입니다.');
          const values = (attr.Value || []).map(v => attr.vr === 'SQ' ? walk(v, depth + 1) : attr.vr === 'PN' && plain(v)
            ? Object.entries(v).map(([k, value]) => text(k) + ': ' + text(value)).join(' / ') : text(v));
          return { tag, label: labels[tag] || '', vr: attr.vr, values };
        });
      }
      return walk(dataset, 0);
    }

    // SR reader UI: a document belongs to one explicit viewing selection and request generation.
    const srStyle = document.createElement('style'); srStyle.textContent = '#sr-dialog::backdrop{background:#0009}#sr-dialog button,#sr-dialog select{background:#1b2b42;color:#dae6f6;border:1px solid #6683aa;border-radius:4px;padding:5px;font:inherit}#sr-dialog button:disabled{opacity:.45}#sr-tree details{margin:6px 0}#sr-tree summary{cursor:pointer;color:#9fceff}'; document.head.append(srStyle);
    const srDialog = document.createElement('dialog'); srDialog.id = 'sr-dialog';
    srDialog.setAttribute('aria-labelledby','sr-title');
    srDialog.style.cssText = 'width:min(900px,94vw);max-height:88vh;background:#141c29;color:#dae6f6;border:1px solid #6683aa;border-radius:8px;padding:16px;overflow:auto';
    srDialog.innerHTML = `<h2 id="sr-title" style="margin:0 0 8px">외부 SR 원문 · 읽기 전용</h2><div id="sr-context" style="overflow-wrap:anywhere"></div>
      <p>외부 문서의 값과 참조를 그대로 표시합니다. 판독 저장·확정과 별개입니다.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button id="sr-reload" type="button">Refresh List</button><button id="sr-close" type="button">Close</button></div>
      <p><label>SR 시리즈 <select id="sr-series" style="max-width:100%"></select></label></p>
      <p><label>SR 문서 <select id="sr-document" style="max-width:100%"></select></label> <button id="sr-read" type="button" disabled>Read Source</button></p>
      <p id="sr-status" role="status" aria-live="polite"></p><div id="sr-tree" style="overflow-wrap:anywhere;white-space:pre-wrap"></div>`;
    document.body.append(srDialog);
    let srEpoch = 0, srAbort = null, srUid = null, srSeries = [], srDocuments = [];
    const srVal = (ds, tag) => String(ds?.[tag]?.Value?.[0] ?? '');
    const srValidUid = value => typeof value === 'string' && /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value) && value.length <= 64;
    function srClear() {
      ++srEpoch; srAbort?.abort(); srAbort = null;
      $('#sr-tree').replaceChildren(); $('#sr-status').textContent = ''; $('#sr-read').disabled = true;
    }
    function closeSR() { srClear(); srUid = null; srSeries = []; srDocuments = []; $('#sr-context').textContent = ''; $('#sr-series').replaceChildren(); $('#sr-document').replaceChildren(); if (srDialog.open) srDialog.close(); }
    async function srLoad(path, consume) {
      srClear(); const epoch = srEpoch, uid = srUid, controller = srAbort = new AbortController();
      const at = work.capture("document");
      const active = () => epoch === srEpoch && uid === srUid && uid === viewingUid() && srDialog.open;
      // 이 읽기의 답·실패·끝이 화면에 닿는 자리는 모두 이 읽기를 시작한 문맥과 이 창의 세대를 함께 지난다. 받은 조각은 이
      // 읽기만의 것이라 쌓는 데는 관문이 없고, 다 받아 해석한 뒤 화면에 쓰는 한 자리에서 지난다.
      const apply = effect => work.commit(at, () => { if (active()) effect(); });
      $('#sr-status').textContent = '불러오는 중…';
      try {
        const res = await transport.request(path, { context: at, signal: controller.signal, cache: 'no-store',
          headers: { Accept: 'application/dicom+json' }, read: 'stream', deadlineMs: 15000 });
        if (!res.ok) {
          if ([401,403].includes(res.status)) apply(() => {
            srSeries = []; srDocuments = []; $('#sr-series').replaceChildren(); $('#sr-document').replaceChildren();
          });
          throw new Error('문서를 읽을 수 없습니다 (HTTP ' + res.status + '). 로그인과 접근 권한을 확인하세요.');
        }
        const chunks = []; let total = 0;
        while (true) {
          const { done, value } = await res.stream.read(); if (done) break;
          total += value.byteLength;
          if (total > 2 * 1024 * 1024) { await res.stream.cancel(); throw new Error('SR 응답이 2 MiB 상한을 초과했습니다.'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!Array.isArray(data)) throw new Error('잘못된 SR 목록 또는 문서입니다.');
        apply(() => { consume(data); $('#sr-status').textContent = data.length ? '불러왔습니다. 지원 범위의 원문 트리이며 임상 해석을 추가하지 않습니다.' : 'SR 항목이 없습니다.'; });
      } catch (e) {
        apply(() => { $('#sr-tree').replaceChildren(); $('#sr-status').textContent = e.transport === 'timeout' ? '요청 시간이 초과되었습니다. 다시 시도하세요.' : 'SR 열람 실패: ' + e.message; });
      } finally { apply(() => { $('#sr-read').disabled = !srDocuments.some(d => srVal(d,'00080018') === $('#sr-document').value); }); }
    }
    function srOptions(select, rows, tag, label) {
      select.replaceChildren(new Option('선택하세요', ''), ...rows.map(ds => new Option(label(ds), srVal(ds,tag))));
    }
    function srList() {
      srSeries = []; srDocuments = []; $('#sr-series').replaceChildren(); $('#sr-document').replaceChildren();
      if (!srValidUid(srUid)) return;
      srLoad('/dicom-web/studies/' + srUid + '/series?Modality=SR&limit=101', rows => {
        if (rows.length > 100) throw new Error('SR 시리즈 100개 상한을 초과했습니다.');
        const seen = new Set();
        for (const ds of rows) {
          const id = srVal(ds,'0020000E');
          if (srVal(ds,'0020000D') !== srUid || srVal(ds,'00080060') !== 'SR' || !srValidUid(id) || seen.has(id)) throw new Error('SR 시리즈 식별이 일치하지 않습니다.');
          seen.add(id);
        }
        srSeries = rows; srOptions($('#sr-series'), rows, '0020000E', d => (srVal(d,'00200011') || '번호 없음') + ' · ' + (srVal(d,'0008103E') || '설명 없음') + ' · ' + srVal(d,'0020000E'));
      });
    }
    $('#sr-open').addEventListener('click', () => {
      closeSR(); const s = viewed(); if (!s || demoMode || !srValidUid(s.uid)) return;
      srUid = s.uid; $('#sr-context').textContent = '열람 검사 · ' + s.name + ' (' + s.id + ') · ' + s.date + ' · ' + shownStudyDesc(s);
      srDialog.showModal(); srList();
    });
    $('#sr-series').addEventListener('change', () => {
      srClear(); srDocuments = []; $('#sr-document').replaceChildren(); const series = $('#sr-series').value;
      if (!srSeries.some(d => srVal(d,'0020000E') === series)) return;
      srLoad('/dicom-web/studies/' + srUid + '/series/' + series + '/instances?includefield=00080016&limit=201', rows => {
        if (rows.length > 200) throw new Error('SR 문서 200개 상한을 초과했습니다.');
        const seen = new Set();
        for (const ds of rows) {
          const id = srVal(ds,'00080018');
          if (srVal(ds,'0020000D') !== srUid || srVal(ds,'0020000E') !== series || !srValidUid(id) || seen.has(id)) throw new Error('SR 문서 식별이 일치하지 않습니다.');
          seen.add(id);
        }
        srDocuments = rows; srOptions($('#sr-document'), rows, '00080018', d => (srVal(d,'00200013') || '번호 없음') + ' · ' + srVal(d,'00080018'));
      });
    });
    $('#sr-document').addEventListener('change', () => { srClear(); $('#sr-read').disabled = !srDocuments.some(d => srVal(d,'00080018') === $('#sr-document').value); });
    $('#sr-read').addEventListener('click', () => {
      const sop = $('#sr-document').value, ds = srDocuments.find(d => srVal(d,'00080018') === sop); if (!ds) return;
      const expected = { study: srUid, series: $('#sr-series').value, sop, sopClass: srVal(ds,'00080016') };
      srLoad('/dicom-web/studies/' + expected.study + '/series/' + expected.series + '/instances/' + sop + '/metadata', rows => {
        if (rows.length !== 1) throw new Error('선택한 SR 한 문서가 아닙니다.');
        const tree = srTree(rows[0], expected), fragment = document.createDocumentFragment();
        function render(entries, parent, depth) {
          for (const entry of entries) {
            const title = '(' + entry.tag.slice(0,4) + ',' + entry.tag.slice(4) + ') ' + entry.label + ' [' + entry.vr + ']';
            if (entry.vr === 'SQ') {
              const details = document.createElement('details'), summary = document.createElement('summary');
              summary.textContent = title + ' · ' + entry.values.length + '개'; details.append(summary); details.open = depth < 2;
              entry.values.forEach((item, i) => { const group = document.createElement('div'); group.style.marginLeft = '16px'; const heading = document.createElement('strong'); heading.textContent = 'Item ' + (i + 1); group.append(heading); render(item,group,depth+1); details.append(group); }); parent.append(details);
            } else { const line = document.createElement('div'); line.textContent = title + ' = ' + (entry.values.length ? entry.values.join(' \\ ') : '(빈 값)'); parent.append(line); }
          }
        }
        const primary = new Set(['0040A040','0040A043','0040A050','0040A491','0040A493','0040A730']);
        render(tree.filter(e => primary.has(e.tag)),fragment,0);
        const metadata = document.createElement('details'), summary = document.createElement('summary'); metadata.dataset.srMetadata = '';
        summary.textContent = '문서 식별정보 및 기타 태그'; metadata.append(summary); render(tree.filter(e => !primary.has(e.tag)),metadata,2); fragment.append(metadata);
        $('#sr-tree').replaceChildren(fragment);
      });
    });
    $('#sr-reload').addEventListener('click', srList); $('#sr-close').addEventListener('click', closeSR);
    srDialog.addEventListener('cancel', e => { e.preventDefault(); closeSR(); });
    window.addEventListener('pagehide', closeSR);

    // ── 선택 ──
    function viewingUid() { return viewed()?.uid ?? null; }
    function curOrder() { return orders.find(o => o.oid === selectedOid); }

    let patientCopyContext = '', patientCopyEpoch = 0, patientCopyBusy = false, patientCopyEnded = false;
    function patientCopyTarget() {
      const s = viewed();
      return !patientCopyEnded && serverMode && !demoMode && s?.uid && s.sourcePatientKey &&
        typeof s.id === 'string' && s.id.trim() && s.institutionName ? s : null;
    }
    function renderPatientCopy() {
      const s = patientCopyTarget();
      const context = s ? JSON.stringify([s.uid, s.id, s.institutionName, s.name, s.date]) : '';
      if (context !== patientCopyContext) {
        patientCopyContext = context; patientCopyEpoch++;
        $('#copy-patient-status').textContent = '';
      }
      $('#copy-patient-id').disabled = !s || patientCopyBusy;
      $('#copy-patient-context').textContent = s
        ? `열람 대상 · ${s.institutionName} · ${s.name} (${s.id}) · ${s.date || '날짜 없음'}`
        : '복사할 환자 ID가 있는 열람 검사를 선택하세요';
    }
    async function copyViewedPatientId() {
      renderPatientCopy();
      const s = patientCopyTarget();
      if (!s || patientCopyBusy) return;
      const epoch = patientCopyEpoch;
      if (!navigator.clipboard?.writeText) {
        $('#copy-patient-status').textContent = '이 브라우저는 복사를 지원하지 않습니다. 표시된 ID를 직접 선택해 복사하세요.';
        return;
      }
      patientCopyBusy = true; renderPatientCopy();
      $('#copy-patient-status').textContent = '환자 ID 복사 중…';
      const at = work.capture("document");
      try {
        // Keep the user gesture and its exact ID together. An OS clipboard write
        // cannot be recalled on navigation; only its late UI result is discarded.
        await navigator.clipboard.writeText(s.id);
        work.commit(at, () => {
          renderPatientCopy();
          if (epoch === patientCopyEpoch) $('#copy-patient-status').textContent = '환자 ID를 복사했습니다.';
        });
      } catch (e) {
        work.commit(at, () => {
          renderPatientCopy();
          if (epoch === patientCopyEpoch) $('#copy-patient-status').textContent = '복사가 허용되지 않았거나 실패했습니다. 표시된 ID를 직접 선택해 복사하거나 다시 시도하세요.';
        });
      } finally {
        // 이 복사가 건 대기 표시는 이 복사가 푼다. 다시 그리는 것은 문맥이 그대로일 때만 한다.
        patientCopyBusy = false;
        work.commit(at, () => renderPatientCopy());
      }
    }
    function endPatientCopy() { patientCopyEnded = true; patientCopyEpoch++; renderPatientCopy(); }
    $('#copy-patient-id').addEventListener('click', copyViewedPatientId);
    document.addEventListener('keydown', e => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.metaKey || e.shiftKey ||
          !e.ctrlKey || !e.altKey || e.code !== 'KeyC' ||
          e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') ||
          // 구조화 입력 창은 `show`가 아니라 `on`으로 열린다(`:3778`). 이 목록에 없으면 그 창이
          // 떠 있는 동안에도 단축키가 지나가 환자 ID가 클립보드에 적힌다 — 되돌릴 수 없는 쓰기다.
          // 열려 **있는** 그 창만 적는다: 다섯 모달은 늘 DOM에 있어서 넓은 선택자는 단축키를 영영 막는다.
          document.querySelector('dialog[open],.modal.show,#structmodal.modal.on') || !patientCopyTarget()) return;
      e.preventDefault(); copyViewedPatientId();
    });
    window.addEventListener('pagehide', endPatientCopy);

    function select(uid, { deferViewer = false, openSelected = false } = {}) {
      /**
       * **같은 검사를 다시 고르는 것은 이동이 아니다.**
       *
       * 예전엔 거르지 않아서, 이미 열어둔 행을 한 번 더 클릭할 때마다
       * `refreshRight()`가 통째로 다시 돌았다 — 썸네일을 다시 받아오고,
       * 점유 경고(`warnedFor = null`)가 초기화돼 **"OO 님이 작성 중입니다"가
       * 클릭할 때마다 다시 떴다.** 남발된 경고는 아무도 안 본다(교훈 §2).
       * 우클릭 메뉴도 `select(uid)`를 먼저 부르므로 메뉴를 열 때마다 같은 일이 났다.
      */
      if (uid === selectedUid) return;
      reportPreview.close();
      if (templateEditor?.source) closeTemplateEditor(false);
      // A→B→A로 돌아와도 이전 검사에서 읽던 미리보기의 삽입 버튼은 재사용하지 않는다.
      closeTemplatePreview(false);
      // 인용 미리보기도 같다. 응답을 기다리는 중이면 창은 그대로 두고, 늦게 온 응답은
      // 요청이 떠날 때의 선택과 대조해 화면에 쓰지 않는다.
      if (!citeBusy) closeCitePreview(false);
      // 구조화 입력도 같은 규칙이다(B4). 나가 있는 요청이 없으면 창을 닫는다 — 열린 채로 두면
      // 다음 누름이 **떠난 검사의 항목**을 지금 검사에 적으려 한다. 진행 중이면 창을 두고,
      // 늦게 온 응답은 요청이 떠날 때의 선택과 대조해 화면에 쓰지 않는다.
      if (!structPane?.busy) closeStructure();
      // 사유를 고르는 동안 A→B→A로 이동해도 이전 모달의 결정을 새 선택에 적용하지 않는다.
      if (reasonResolve) reasonResolve(null);
      stashReport();
      if (heldUid && heldUid !== uid) releaseHold();   // 다른 검사로 가면 잡고 있던 걸 놓는다
      warnedFor = null;
      relatedUid = null;
      relatedReportSeq += 1;
      clearRelatedReport();
      markSelectionChanged(uid);
      relatedModality = ""; relatedBodyPart = ""; relatedIncludeCurrent = false;
      relatedParts.reset(uid);
      render(uid); refreshRight({ forceReport: true, deferViewer });
      if (mode === "Technician") renderOrders();   // 선택 표시줄·ID sync 갱신
      if (openSelected && !deferViewer && !readingWorkspace.active() && imageOpening?.snapshot().autoLoad) openFilmbox(uid);
    }
    function refreshRight({ forceReport = false, deferViewer = false } = {}) {
      renderClinical(); renderRelated(); renderThumbs(); renderTemplates();
      if (relatedUid) loadRelatedReport();
      else clearRelatedReport();
      loadReport({ force: forceReport });
      updateReportButtons();
      readingWorkspace.selectionChanged(deferViewer);
      readingFindings?.sync();
    }

    function renderClinical() {
      imagePreview?.sync();
      const s = viewed();
      renderPatientCopy();
      imageRequests?.sync();
      if (srUid && srUid !== s?.uid) closeSR();
      $('#sr-open').disabled = !s || demoMode;
      $('#tech-note-open').disabled = !s || demoMode || !serverMode || offline;
      // S5-U4b: 판독 대상이 바뀐 때만 그 검사의 임상의 질문을 읽는다(같은 대상이면 요청도 그리기도 없다).
      studyQuestions?.sync();
      // S7-U1b: 판독 대상이나 화면이 아는 판독 상태가 바뀐 때만 Mark CVR의 서버 답(#1)을 다시 읽는다.
      criticalResults?.sync();
      // S7-U4b: 보는 검사가 바뀐 때만 Clinical Context를 다시 읽는다(같은 검사면 요청도 그리기도 없다).
      clinicalContext?.sync();
      $("#clinical").innerHTML = s ? `
        <div class="clinical-scope">${s.uid === selectedUid ? '판독 대상 검사 정보' : '관련 검사 정보 · 판독 대상은 바뀌지 않습니다'}</div>
        <table>
          <tr><td>Patient</td><td>${esc(s.name)} (${esc(s.id)})</td></tr>
          <tr><td>Sex/Age</td><td>${esc(s.sex)} / ${esc(s.age)}</td></tr>
          <tr><td>Birth</td><td>${esc(s.birth)}</td></tr>
          <tr><td>Study</td><td>${esc(shownStudyDesc(s))}</td></tr>
          <tr><td>Date</td><td>${esc(s.date)}</td></tr>
          <tr><td>AccNo</td><td>${esc(s.acc)}</td></tr>
          <tr><td>Img/Se</td><td>${esc(s.count)} / ${esc(s.series)}</td></tr>
          <tr><td>SS / Mt</td><td>${esc(s.ss)} / ${s.matched === "M" ? "Matched" : "Unmatched"}</td></tr>
          <tr><td>Ward</td><td>${esc(s.ward) || "-"}</td></tr>
          <tr><td>Study UID</td><td>${esc(s.uid)}</td></tr>
        </table>` : "No clinical information provided.";
      renderStudyIdentity();
      renderObservation();
    }

    /**
     * S4-U1b 수신 표시. 세 축을 한 단어로 접지 않는다 — 기관 배정(A), KIN이 관측한 보유(B),
     * Gateway가 보고한 전송(C). 관측은 이 탭의 메모리에만 있고 서버에 이력을 남기지 않는다.
     * 관측 실패는 아무것도 비우지 않고 `관측 불가`만 더한다. 상태 `studyObservationModel`은 `studies` 옆에 둔다.
     * S4-U3: 축 C는 서버가 목록 행에 실어 준 마지막 Gateway 영수증이다. 영수증이 없으면 `No Gateway Report`(정상)다.
     */
    function applyObservation(result) {
      if (!studyObservationModel) return;
      const next = KinStudyArrivals.observationSucceeded(studyObservationModel, result);
      // A response whose observation cannot be read is not an observation; the last one stays.
      studyObservationModel = next.ok ? next.model : KinStudyArrivals.observationFailed(studyObservationModel);
      // The poll renders before it updates rows in place, so the receipt rides on this same readable answer;
      // an unreadable one keeps the last receipt, like everything else here.
      if (next.ok) {
        const receipts = new Map(result.studies.map(row => [row.uid, row.gatewayReceipt ?? null]));
        for (const study of studies) if (receipts.has(study.uid)) study.gatewayReceipt = receipts.get(study.uid);
      }
      // S4-U2: the order answer rides on this same observation and fails with it.
      applyOrderReconciliation(next.ok ? result : null);
      // S4-U5: so do the server-read tags and the linked-order relations of each row.
      applyStudyIdentity(next.ok ? result : null);
      // S7-U4b: the Clinical Context panel compares this same readable answer with the answer it shows (contract 8.1).
      clinicalContext?.observe(next.ok ? result : null);
      renderObservation();
    }
    function markObservationUnavailable() {
      if (!studyObservationModel) return;
      studyObservationModel = KinStudyArrivals.observationFailed(studyObservationModel);
      applyOrderReconciliation(null);
      applyStudyIdentity(null);
      renderObservation();
    }
    function renderObservation() {
      if (!studyObservationModel) return;
      const summary = KinStudyArrivals.observationSummary(studyObservationModel), status = $("#observation-status");
      if (status) { status.hidden = !summary.text; status.textContent = summary.text; status.title = summary.title; }
      // S4-U4 Now Retry, drawn only from labels.retry. Another study or a newer receipt drops the in-flight token
      // and the requested mark, so an answer for what was drawn before is never written over it (A->B->A too).
      // S4-F01V: one drawing serves the worklist panel and every Not Observed item, so both keep the same rules.
      const drawRetry = (s, retry, retryButton, retryNote) => {
        const retryKey = retry?.kind === "now_retry" ? retry.key : "";
        if (retryButton.dataset.uid !== s.uid || retryButton.dataset.key !== retryKey) {
          Object.assign(retryButton.dataset, { uid: s.uid, key: retryKey, request: "", requested: "" });
          retryNote.textContent = ""; retryNote.title = "";
        }
        retryButton.hidden = !retryKey || retryButton.dataset.requested === "1"
          || !(serverMode && !offline && !demoMode && KinAuth.has("technician"));
        retryButton.disabled = !!retryButton.dataset.request; retryButton.title = retry?.title ?? "";
        // Without a bindable retry the note is labels.retry itself: the F-01 sentence for failed, else nothing.
        if (!retryKey) { retryNote.textContent = retry?.text ?? ""; retryNote.title = retry?.title ?? ""; }
      };
      const absent = summary.notObserved ?? [], box = $("#not-observed");
      if (box) {
        box.hidden = !absent.length;
        $("#not-observed-summary").textContent = absent.length
          ? `Not Observed (${absent.length})` + (summary.key === "observation_unavailable" ? " · 마지막 관측 기준" : "") : "";
        // S4-F01V: every item is an own study (axis A assigned) and its own receipt adds the Gateway text and Now Retry.
        // Items are kept per UID so a request in flight survives a redraw. An item that leaves the list drops its
        // token, so a late answer is never written anywhere, and one that comes back is built new (A->B->A).
        const list = $("#not-observed-list"), kept = new Map([...list.children].map(item => [item.dataset.uid, item]));
        const items = absent.map(row => {
          let item = kept.get(row.uid);
          kept.delete(row.uid);
          if (!item) {
            const control = document.createElement("button");
            control.type = "button"; control.className = "chip"; control.hidden = true;
            control.textContent = KinStudyArrivals.RETRY_TEXT.button;
            control.addEventListener("click", requestGatewayRetry);
            item = document.createElement("div"); item.dataset.uid = row.uid;
            item.append(document.createElement("span"), " ", control, " ", document.createElement("span"));
          }
          const gateway = row.gatewayReceipt ?? null, [text, button, note] = item.children;
          const labels = KinStudyArrivals.receiptLabels({ assignment: "assigned",
            observation: KinStudyArrivals.studyObservation(studyObservationModel, row.uid), gateway });
          // Without a receipt the text stays the U1b item text; no No Gateway Report is added to this list.
          text.textContent = `${row.uid} · ${row.origin} · ${KinStudyArrivals.formatTime(row.createdAt)}`
            + (gateway === null ? "" : ` · ${labels.gateway.text}`);
          text.title = gateway === null ? "" : labels.gateway.title;
          drawRetry(row, labels.retry, button, note);
          return item;
        });
        for (const item of kept.values()) item.querySelector("button").dataset.request = "";
        // Moving a kept item would drop keyboard focus, so the children are replaced only when the items change.
        if (items.length !== list.children.length || items.some((item, index) => item !== list.children[index])) list.replaceChildren(...items);
      }
      const s = viewed(), receipt = $("#study-receipt");
      if (!receipt) return;
      receipt.hidden = !s;
      if (!s) return;
      // Every worklist row passed the visible() boundary on the server, so axis A is `assigned` here;
      // institution-less studies only appear in the admin Unmatched Studies list.
      const labels = KinStudyArrivals.receiptLabels({ assignment: "assigned",
        observation: KinStudyArrivals.studyObservation(studyObservationModel, s.uid), gateway: s.gatewayReceipt ?? null });
      $("#receipt-assignment").textContent = labels.assignment.text; $("#receipt-assignment").title = labels.assignment.title;
      $("#receipt-observation").textContent = [labels.observation.text, labels.change?.text].filter(Boolean).join(" · ");
      $("#receipt-observation").title = labels.observation.title;
      drawRetry(s, labels.retry, $("#receipt-retry"), $("#receipt-retry-note"));
      $("#receipt-gateway").textContent = labels.gateway.text; $("#receipt-gateway").title = labels.gateway.title;
    }

    /**
     * S4-U4 Now Retry: one POST with an empty body and nothing shown before the answer. The answer is written
     * only while the same study and receipt are still drawn with this request's token (renderObservation drops
     * it when either changes). `Retry Requested` means the request is stored at KIN, never that a retry ran.
     * S4-F01V: the clicked control is the one bound (the panel or a Not Observed item), and its note is the element
     * right after it; a call without an event is the panel.
     */
    async function requestGatewayRetry(event) {
      const button = event?.currentTarget ?? $("#receipt-retry"), uid = button.dataset.uid, key = button.dataset.key;
      if (!uid || !key || button.hidden || button.dataset.request) return;
      const token = String(++gatewayRetryRequestSeq);
      button.dataset.request = token; button.disabled = true;
      let answer = null, error = null;
      const at = work.capture("document");
      try { answer = await api("POST", `/studies/${encodeURIComponent(uid)}/gateway-retry`, {}, undefined, at); }
      catch (e) { error = e ?? new Error("request failed"); }
      work.commit(at, () => {
        if (button.dataset.request !== token || button.dataset.uid !== uid || button.dataset.key !== key) return;
        const shown = KinStudyArrivals.gatewayRetryAnswer(uid, answer, error);
        Object.assign(button.dataset, { request: "", requested: shown.requested ? "1" : "" });
        const note = button.nextElementSibling;
        note.textContent = shown.text; note.title = shown.title;
        renderObservation();
      });
    }
    $("#receipt-retry").addEventListener("click", requestGatewayRetry);

    /**
     * S4-U2 오더 측 대사 표시 — **엔지니어링 전용**. 입력은 서버가 목록을 완성한 관측과 함께 준 답뿐이다.
     * 브라우저의 `orders`(오프라인이면 localStorage 시드다)는 이 면에 들어오지 않는다. 관측 실패는
     * 마지막 답을 지우지 않고 `관측 불가`만 더한다. 환자 칸·예정 시각은 그리지 않는다.
     */
    function applyOrderReconciliation(result) {
      if (!orderReconciliationModel) return;
      orderReconciliationModel = result ? KinOrderReconciliation.succeeded(orderReconciliationModel, result)
        : KinOrderReconciliation.failed(orderReconciliationModel);
      renderOrderReconciliation();
    }
    function renderOrderReconciliation() {
      const box = $("#order-reconciliation");
      if (!box || !orderReconciliationModel) return;
      const summary = KinOrderReconciliation.summary(orderReconciliationModel);
      box.hidden = summary.hidden;
      $("#order-reconciliation-summary").textContent = summary.text;
      $("#order-reconciliation-summary").title = summary.title;
      $("#order-reconciliation-list").replaceChildren(...summary.rows.map(row => {
        const item = document.createElement("div");
        item.textContent = row.text; item.title = row.title;
        return item;
      }));
    }

    /**
     * S4-U5 DICOM Identity panel — read-only, engineering only. The tags are the ones the server read for the list row
     * (never the row object, which carries the display overlay); the relations are the server's, shown only while this
     * screen's own row state still names the same linked order. A failed observation keeps the last answer and says so.
     */
    function applyStudyIdentity(result) {
      if (!studyIdentityModel) return;
      studyIdentityModel = result ? KinStudyIdentity.succeeded(studyIdentityModel, result)
        : KinStudyIdentity.failed(studyIdentityModel);
      renderStudyIdentity();
    }
    // A correction answer (Match, Unmatch, Modify Exam) for the panel's next-action line. Memory only.
    function noteIdentityCorrection(uid, ok) {
      if (studyIdentityModel) studyIdentityModel = KinStudyIdentity.correction(studyIdentityModel, uid, ok);
      renderStudyIdentity();
    }

    function relatedDateLabel(target) {
      const current = cur();
      // 수동 비교에는 이후 검사도 들어온다. 날짜를 모르는 경우와 같은 날의 선후를 과거로 추측하지 않는다.
      if (!current || !validPriorDate(current.date) || !validPriorDate(target.date)) return "날짜 미확인";
      if (target.date === current.date) return "같은 날짜 · 선후 미확인";
      return target.date < current.date ? "과거" : "이후";
    }
    function relatedReportMeta(s) {
      return `${relatedDateLabel(s)} · ${s.name} (${s.id}) · ${s.date || "날짜 없음"} · ${s.modality} · ${shownStudyDesc(s)}`;
    }

    // Related Exam: 서버가 원본 기관+PatientID로 만든 키가 같은 "다른" 검사만.
    $('#related-page-prev').addEventListener('click', () => { relatedPage--; renderRelated(); });
    $('#related-page-next').addEventListener('click', () => { relatedPage++; renderRelated(); });
    $('#related-page-current').addEventListener('click', () => renderRelated(true));

    /**
     * 썸네일. **PACS에서 wrong-patient image display는 그 자체로 사고 분류 항목이다.**
     *
     * 예전엔 `selectedUid`를 캡처하지 않고, 여러 await 뒤의 결과를 무조건 써넣었다.
     * Prev/Next로 빠르게 넘기면 **A의 응답이 B의 화면에 도착한다** — 워크리스트도
     * Clinical Info도 B인데 썸네일만 A인 상태. 판독의가 알아챌 방법이 없다.
     * (`const s = cur();`가 쓰이지도 않은 채 남아 있었다. 원래 여기서 uid를 잡으려던 흔적)
     *
     * 두 가지를 함께 막는다:
     *   uid  — 내가 그리려던 검사가 아직 선택돼 있는가
     *   seq  — 그 사이 더 새로운 요청이 시작되지 않았는가 (A→B→A로 돌아오면 uid만으로는 못 잡는다)
     * await가 있는 모든 지점 뒤에서, 화면에 쓰기 직전에 확인한다. 에러 표시도 마찬가지다 —
     * A의 실패 메시지가 B의 썸네일을 덮으면 그것도 같은 종류의 거짓말이다.
     */
    let thumbSeq = 0, thumbController = null, thumbDone = Promise.resolve(), thumbUrls = [], thumbSort = "source";
    function orderedThumbs(reps) {
      if (thumbSort === "source") return reps;
      const number = value => /^[+-]?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
      const direction = thumbSort === "number-desc" ? -1 : 1;
      // 캐시 원본을 정렬하면 원래 순서를 복원할 수 없다. 불량 번호는 양 방향 모두 뒤로 보낸다.
      return [...reps].sort((a, b) => {
        const x = number(a.number), y = number(b.number);
        if (x === null && y !== null) return 1;
        if (x !== null && y === null) return -1;
        return (x !== null && y !== null ? direction * (x - y) : 0)
          || (a.seriesUid < b.seriesUid ? -1 : a.seriesUid > b.seriesUid ? 1 : 0);
      });
    }
    function cancelThumbs(keepImageGrid = false) {
      ++thumbSeq;
      thumbController?.abort();
      thumbController = null;
      thumbUrls.forEach(url => URL.revokeObjectURL(url));
      thumbUrls = [];
      if (keepImageGrid !== true) imageThumbnails?.close();
    }
    window.addEventListener("pagehide", cancelThumbs);
    window.addEventListener("pageshow", e => { if (e.persisted) renderThumbs(); });
    function renderThumbs(page = 0, cached = null) {
      const wrap = $("#thumbwrap");
      const uid = viewingUid();
      // Polling may repaint the surrounding study without changing its source. Keep an explicitly
      // opened Images page in place; owner or study changes make sync close it synchronously.
      if (imageThumbnails?.sync()) return;
      cancelThumbs();
      if (!uid) { wrap.innerHTML = ""; return; }
      const seq = thumbSeq;
      const controller = thumbController = new AbortController();
      const signal = controller.signal;
      // 이 그리기를 시작한 문맥. 받은 목록·영상·실패가 화면에 닿는 자리는 모두 이 문맥(세션·작업 세대)과 아래 stale()
      // (요청 세대·보는 검사)을 함께 지난다. 받은 blob으로 만든 URL은 이 그리기의 것이라 통과한 뒤에만 만든다.
      const at = work.capture("document");
      const stale = () => signal.aborted || seq !== thumbSeq || uid !== viewingUid();
      const apply = effect => work.commit(at, () => { if (!stale()) effect(); });
      if (demoMode) {
        wrap.innerHTML = `<div class="thumbs" style="grid-template-columns:repeat(2,1fr)"><img src="${DEMO_IMG}"></div>`;
        return;
      }
      wrap.innerHTML = `<div style="color:#556;padding:20px">로딩…</div>`;
      // 이전 fetch뿐 아니라 body 소비까지 끝내야 빠른 전환에도 worker 수가 누적되지 않는다.
      thumbDone = thumbDone.then(async () => {
        if (stale() || !work.admits(at)) return;
        try {
          let reps = cached?.uid === uid ? cached.reps : null;
          if (!reps) {
            const res = await transport.request(`/dicom-web/studies/${uid}/instances`, { context: at, signal, cache: "no-store", deadlineMs: 30000 });
            if (!res.ok || !Array.isArray(res.body)) throw new Error(`HTTP ${res.status}`);
            const inst = res.body;
            const bySeries = new Map();
            for (const i of inst) {
              const series = tagv(i, "0020000E");
              if (!bySeries.has(series)) bySeries.set(series, []);
              bySeries.get(series).push(i);
            }
            reps = [...bySeries.values()].map(arr => {
              arr.sort((a, b) => (+tagv(a, "00200013") || 0) - (+tagv(b, "00200013") || 0));
              const representative = arr[Math.floor(arr.length / 2)];
              // 순번은 DICOM 번호가 아니며, 표시 정보도 실제 preview의 대표 SOP와 함께 캐시해야 한다.
              return { sopUid: tagv(representative, "00080018"), seriesUid: tagv(representative, "0020000E"),
                number: tagv(representative, "00200011").trim(), description: tagv(representative, "0008103E").trim() };
            });
          }
          const start = page * 24, batch = orderedThumbs(reps).slice(start, start + 24);
          const n = Math.max(Math.ceil(Math.sqrt(batch.length)), 2);
          let cells = null;
          if (!apply(() => {
          wrap.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px">
            <button id="thumb-prev" class="chip" type="button" ${page === 0 ? "disabled" : ""}>Previous</button>
            <span id="thumb-range">시리즈 ${batch.length ? start + 1 : 0}–${start + batch.length} / ${reps.length}</span>
            <button id="thumb-next" class="chip" type="button" ${start + 24 >= reps.length ? "disabled" : ""}>Next</button>
            <label>정렬 <select id="thumb-sort" aria-label="시리즈 정렬" style="max-width:100%;background:#14181f;color:#cdd3dc;border:1px solid #3a4356;font:inherit">
              <option value="source">원래 순서</option><option value="number-asc">번호 오름차순</option><option value="number-desc">번호 내림차순</option>
            </select></label>
            </div><div class="thumbs" style="grid-template-columns:repeat(${n},1fr)"></div>`;
          const sort = wrap.querySelector("#thumb-sort");
          sort.value = thumbSort;
          sort.onchange = () => {
            if (stale() || !["source", "number-asc", "number-desc"].includes(sort.value)) return;
            thumbSort = sort.value;
            renderThumbs(0, { uid, reps });
          };
          wrap.querySelector("#thumb-prev").onclick = () => { if (!stale()) renderThumbs(page - 1, { uid, reps }); };
          wrap.querySelector("#thumb-next").onclick = () => { if (!stale()) renderThumbs(page + 1, { uid, reps }); };
          const grid = wrap.querySelector(".thumbs");
          cells = batch.map((rep, index) => {
            const cell = document.createElement("div");
            cell.className = "thumb-card";
            const heading = `항목 ${start + index + 1} · ${rep.number ? `번호 ${rep.number}` : "번호 없음"}`;
            const description = rep.description || "설명 없음";
            cell.title = `${heading}\n${description}\nSeries UID: ${rep.seriesUid || "없음"}\n더블클릭: Film Box`;
            const preview = document.createElement("div");
            preview.className = "thumb-preview";
            preview.textContent = "로딩…";
            const label = document.createElement("div");
            label.className = "thumb-label";
            const number = document.createElement("div"), detail = document.createElement("div");
            number.className = "thumb-number"; number.textContent = heading;
            detail.className = "thumb-description"; detail.textContent = description;
            label.append(number, detail);
            // title과 생략 표시만으로는 키보드나 터치에서 전체 식별 정보를 읽을 수 없다.
            const disclosure = document.createElement("details"), summary = document.createElement("summary"), full = document.createElement("div");
            disclosure.className = "thumb-details"; summary.textContent = "상세 정보";
            full.className = "thumb-full"; full.textContent = `${heading}\n${description}\nSeries UID: ${rep.seriesUid || "없음"}`;
            disclosure.append(summary, full);
            const open = document.createElement("button");
            open.type = "button"; open.className = "chip thumb-open"; open.textContent = "시리즈 열기"; open.disabled = true;
            open.setAttribute("aria-label", `시리즈 열기 · ${heading} · ${description} · Series UID: ${rep.seriesUid || "없음"}`);
            open.onclick = () => { if (!stale() && !open.disabled) openFilmbox(uid, null, rep.seriesUid); };
            const inspect=document.createElement('button');inspect.type='button';inspect.className='chip thumb-preview-open';inspect.textContent='Image Preview';inspect.disabled=true;
            inspect.onclick=()=>{if(!stale()&&!inspect.disabled){const study=viewed();if(study?.uid===uid)imagePreview?.open({...study,series:rep.seriesUid,sop:rep.sopUid});}};
            const images=document.createElement('button');images.type='button';images.className='chip thumb-images-open';images.textContent='Images';images.disabled=true;
            if(!imageThumbnails)images.title='Images 모듈을 불러오지 못했습니다. 페이지를 다시 열어 주세요.';
            images.onclick=()=>{if(!stale()&&!images.disabled){const study=viewed();if(study?.uid!==uid)return;cancelThumbs(true);if(!imageThumbnails?.open({...study,series:rep.seriesUid}))renderThumbs();}};
            cell.append(label, disclosure, preview, open, inspect, images);
            grid.appendChild(cell);
            return { preview, open, inspect, images, alt: `${heading} · ${description}` };
          });
          }) || !cells) return;
          let next = 0, stopped = false;
          const worker = async () => {
            while (!stopped && !stale() && work.admits(at) && next < batch.length) {
              const index = next++;
              try {
                // 한 항목의 조회 실패가 다른 영상과 실패한 항목의 식별 정보까지 지우면 대조할 수 없다.
                const lk = await api("POST", "/dicom/lookup", { studyUid: uid, sopUid: batch[index].sopUid }, signal, at);
                const res = await transport.request(`/instances/${encodeURIComponent(lk.id)}/preview`,
                  { context: at, signal, cache: "no-store", read: "blob", deadlineMs: 30000 });
                if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
                const blob = res.body;
                // 받은 영상을 화면에 놓는 자리(디코딩 뒤, 적용 전): 그 사이 보는 검사나 작업 문맥이 바뀌었으면 URL도 만들지 않는다.
                if (!apply(() => {
                  const url = URL.createObjectURL(blob);
                  thumbUrls.push(url);
                  const img = document.createElement("img");
                  img.alt = cells[index].alt;
                  img.onerror = () => apply(() => { cells[index].open.disabled = cells[index].inspect.disabled = cells[index].images.disabled = true; cells[index].preview.textContent = "썸네일 표시 실패"; });
                  img.ondblclick = () => { if (!stale()) openFilmbox(uid, null, batch[index].seriesUid); };
                  img.src = url;
                  cells[index].preview.replaceChildren(img);
                  cells[index].open.disabled = false;
                  cells[index].inspect.disabled = false;
                  cells[index].images.disabled = !imageThumbnails;
                })) return;
              } catch (e) {
                if (!apply(() => {
                  cells[index].preview.textContent = `썸네일 실패: ${e.message}`;
                  cells[index].images.disabled = true;
                  // 연결/세션 전체의 실패를 24개 개별 결함처럼 재요청하지 않는다. 이미 시작한 항목은 마저 종결한다.
                  if (e.transport === "network" || e.status === 401) {
                    stopped = true;
                    cells.slice(next).forEach(cell => { cell.preview.textContent = "요청 중단 · 새로고침하여 다시 시도하세요"; });
                  }
                })) return;
              }
            }
          };
          const results = await Promise.allSettled(Array.from({ length: Math.min(4, batch.length) }, worker));
          const failure = results.find(r => r.status === "rejected");
          if (failure) throw failure.reason;
        } catch (e) {
          apply(() => {
            thumbUrls.forEach(url => URL.revokeObjectURL(url));
            thumbUrls = [];
            wrap.innerHTML = `<div style="color:#ff8080;padding:10px">썸네일 실패: ${esc(e.message)}</div>`;
          });
        }
      });
      return thumbDone;
    }

    // ══════════ Order List (8.2.2) ══════════
    const ofval = {};
    $(".order-p .filters").addEventListener("input", e => {
      const el = e.target.closest("[data-o]"); if (!el) return;
      ofval[el.dataset.o] = el.value.trim().toUpperCase();
      renderOrders();
    });

    function filteredOrders() {
      const s = cur();
      return orders.filter(o => {
        if ($("#o-sync").checked && s && o.id !== s.id) return false;
        return Object.entries(ofval).every(([k, v]) => !v || String(o[k] ?? "").toUpperCase().includes(v));
      });
    }

    function renderOrders() {
      if (mode !== "Technician") return;
      const list = filteredOrders();
      $("#orderrows").innerHTML = list.map((o, i) => `
        <tr data-oid="${esc(o.oid)}" class="${o.oid === selectedOid ? "sel" : ""}">
          <td class="num">${i + 1}</td>
          <td><span class="mt ${esc(o.matched)}">${esc(o.matched)}</span></td>
          <td>${esc(o.id)}</td><td>${esc(o.name)}</td><td>${esc(o.sex)}</td><td>${esc(o.birth)}</td>
          <td>${esc(o.sched)}</td><td>${esc(o.modality)}</td><td>${esc(o.desc)}</td><td>${esc(o.ward)}</td><td>${esc(o.reqDoc)}</td>
        </tr>`).join("") || `<tr><td class="empty" colspan="11">오더 없음</td></tr>`;

      const s = cur(), o = curOrder();
      $("#orderhint").textContent =
        `선택: 검사 ${s ? s.name + " / " + s.date : "(없음)"}  ·  오더 ${o ? o.name + " / " + o.sched : "(없음)"}` +
        (s && o && s.matched === "U" && o.matched === "U" ? "  → 우클릭 Match 가능" : "");
    }
    $("#orderrows").addEventListener("click", e => {
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      selectedOid = tr.dataset.oid;
      renderOrders();
    });
    $("#o-sync").addEventListener("change", renderOrders);
    /**
     * S4-U5 Order List refresh. The server list is read through the existing guarded bootstrap read (own institution,
     * access-filtered); only the latest answer for this account's institution replaces it, and the selected order stays
     * selected while it is still listed. Without a server this only redraws, as before.
     */
    async function refreshOrders() {
      if (!serverMode) { renderOrders(); return; }
      const token = ++orderRefreshSequence;
      let answer = null;
      const at = work.capture("document");
      try { answer = await api("GET", "/bootstrap?states=omit", undefined, undefined, at); } catch (e) { answer = null; }
      work.commit(at, () => {
        if (token !== orderRefreshSequence || !serverMode) return;
        if (!Array.isArray(answer?.orders) || !myInstitution || answer.me?.institution !== myInstitution) {
          toast("오더 목록을 다시 받지 못했습니다 — 보이는 목록은 이전 것입니다. 잠시 후 Refresh를 다시 누르세요.", "err");
          return;
        }
        orders = answer.orders;
        if (!orders.some(o => o.oid === selectedOid)) selectedOid = null;
        renderOrders();
      });
    }
    $("#o-refresh").addEventListener("click", refreshOrders);
    $("#o-clear").addEventListener("click", () => {
      Object.keys(ofval).forEach(k => ofval[k] = "");
      document.querySelectorAll(".order-p .filters input").forEach(i => i.value = "");
      $("#o-sync").checked = false;
      renderOrders();
    });

    // ── 영상 요청(S5-U4c) ──
    // REQ-S5-U4c-REQUEST-UI → RISK-S5-U4c-STALE → TEST-S5-U4c-DOM (tests/clinician_request_dom_test.py가 이 절을 잘라 실행한다).
    // 임상의가 남긴 외부영상(External Images)·영상전송(Send Images) 요청을 두 곳에 보인다. Technician 모드 Order List 패널 안의
    // 대기열은 #7 view=queue(쪽 50·cursor), #8 단건, #11 accept·close·decline·cancel을 쓰고, 판독 화면의 줄은 판독 대상 검사의 #9를
    // 읽기만 한다. 질문·consultation 창과 섞지 않는다(별도 칸·별도 읽기). 요청은 처리 상태의 기록일 뿐이라 이 절은 영상을 옮기거나
    // Connect 경로를 부르지 않고, Closed 옆에는 그 기록이 실제 전송 여부를 나타내지 않는다고 쓴다. 역할에 맞지 않는 처리 단추는
    // applyRoleUi처럼 회색으로 두어 안내만 하고 판정은 서버가 한다(거절은 코드·문구 그대로 보인다).
    // 늦은 답은 대기열 쪽 번호(queueSeq), 단건 번호(detailSeq)와 연 요청 id, 판독 쪽 번호(readSeq)와 대상 검사로 버린다(A→B→A).
    // 서버가 읽기를 거절(403)했거나 다른 계정의 답·OWNER_CHANGED가 오면 이 문서에서는 더 읽거나 쓰지 않고(뷰어 세션의 거절과 같은
    // 한 방향), 세션이 끝나면(로그아웃·다른 탭·401) 두 칸을 내린다. 이 페이지가 로그아웃을 시작하는 곳(api()의 401, 확정한 Log out,
    // Module teardown follows the page work-context lifecycle.
    // 부른다 — 로그아웃 통지는 POST /auth/logout(제한 시간 없음)이 끝난 뒤에야 오므로 그것을 기다리면 그사이 도착한 이전 세션의 답이
    // 그려진다. 계정 변경은 같은 목록에 사유 'account-changed'로 알려 이 페이지의 다른 영역(S5-U4b 질문 줄)도 같은 자리에서 잠근다.
    // 쓰던 note는 요청별로 이 문서의 메모리에만 두고, 잠그거나 끝나면 이전 계정의 글이라 버린다.
    function mountImageRequests({ api, apiBase, work, transport, owner, allowed, current, study, institution, can }) {
      const TEXT = {
        queueHint: '소속 기관 검사에 임상의가 남긴 외부영상(External Images)·영상전송(Send Images) 요청입니다. 요청은 처리 상태의 '
          + '기록이며 이 칸은 영상을 옮기지 않습니다. 영상은 기존 경로에서 따로 옮기고, 처리를 마치면 Close에 처리 기록을 남기세요.',
        noteHint: 'Accept는 note 없이 기록합니다. Close·Decline·Cancel은 note(1~2,000자)가 필요합니다. 처리자·시각은 서버가 로그인한 계정으로 기록합니다.',
        offline: '서버에 연결된 동안에만 영상 요청을 읽습니다.',
        queueLoading: '요청 대기열을 불러오는 중입니다…',
        queueFailed: '요청 대기열을 불러오지 못했습니다.',
        queueEmpty: '이 조건의 영상 요청이 없습니다. 목록 조회는 성공했습니다.',
        queueReady: (n, more) => `영상 요청 ${n}건을 최신순으로 표시합니다.${more ? ' More로 다음 요청을 이어서 읽습니다.' : ''}`,
        detailLoading: '요청을 불러오는 중입니다…',
        detailFailed: '요청을 불러오지 못했습니다.',
        malformed: '영상 요청 응답 형식을 확인할 수 없습니다. 다시 불러오세요.',
        notFound: '요청이나 검사를 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다.',
        // U4p §3.3 화면 문구 규칙: Closed 옆에 늘 함께 쓴다.
        closedNote: '이 기록은 실제 전송 여부를 나타내지 않습니다',
        unlisted: '워크리스트에 없는 검사',
        meta: (created, name) => `${created} 요청 · ${name}`,
        registered: '등록 기관',
        noNote: '이 동작에는 note(1~2,000자)가 필요합니다.',
        sending: '보내는 중입니다…',
        saved: { accept: 'Accepted로 기록했습니다.', close: 'Closed로 기록했습니다. 이 기록은 실제 전송 여부를 나타내지 않습니다.',
          decline: 'Declined로 기록했습니다.', cancel: 'Cancelled로 기록했습니다.' },
        replayed: '이미 저장된 요청입니다. 서버가 처음 저장한 결과를 돌려주었습니다.',
        unknown: '저장되었는지 알 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인하고, Discard는 이 요청을 버립니다.',
        discarded: '보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 요청에서 확인하세요.',
        writeMalformed: '저장 응답의 형식을 확인할 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인합니다.',
        noRequestId: '요청 ID를 만들지 못해 보내지 않았습니다.',
        refused: '서버가 이 계정의 영상 요청 읽기를 거절했습니다. 권한이 바뀌었다면 화면을 다시 불러오세요.',
        ownerChanged: '로그인한 계정이 바뀌었습니다. 이 화면에서는 영상 요청을 더 읽거나 쓰지 않습니다. 화면을 다시 불러오세요.',
        ended: '세션이 끝났습니다. 영상 요청을 더 읽거나 쓰지 않습니다.',
        rejected: '서버가 요청을 거절했습니다.',
        expired: '세션이 만료되었습니다. 다시 로그인하세요.',
        noResponse: '응답이 없어 요청을 멈췄습니다.',
        noServer: '서버에 연결하지 못했습니다.',
        roleStaff: '방사선사(technician) 또는 관리자 권한이 필요합니다.',
        roleCancel: '요청한 임상의 또는 관리자만 취소할 수 있습니다.',
        ownChecking: '이 계정이 남긴 요청인지 서버의 내 요청 목록에서 확인하는 중입니다.',
        ownFailed: '이 계정이 남긴 요청인지 확인하지 못해 Cancel을 막았습니다. Reload로 다시 확인하세요.',
        ownTooMany: '내 요청 목록을 끝까지 보지 못해 이 요청을 찾지 못했습니다.',
        stateAccept: 'Requested 상태의 요청만 Accept할 수 있습니다.',
        stateDone: '처리가 끝난 요청입니다.',
        tips: { accept: '요청을 받아 처리 중(Accepted)으로 기록합니다.', close: '처리를 마쳤다고(Closed) 기록합니다. 실제 전송 여부를 나타내지 않습니다.',
          decline: '요청을 거절(Declined)로 기록합니다.', cancel: '요청을 취소(Cancelled)로 기록합니다.' },
        readHint: '이 검사에 임상의가 남긴 영상 요청입니다. 판독 화면에서는 읽기만 하고, 처리는 Technician 모드의 Image Requests에서 합니다.',
        readLoading: '이 검사의 영상 요청을 불러오는 중입니다…',
        readFailed: '이 검사의 영상 요청을 불러오지 못했습니다.',
        readCounts: (n, parts) => `이 검사의 영상 요청 ${n}건 · ${parts}`,
        codes: {
          IMAGE_REQUEST_CHANGED: '그사이 이 요청이 바뀌었습니다. 요청을 다시 불러왔으니 상태를 확인한 뒤 다시 보내세요.',
          IMAGE_REQUEST_STATE: '지금 요청 상태에서는 할 수 없는 동작입니다. 이미 처리가 끝났을 수 있어 요청을 다시 불러왔습니다.',
          REQUEST_ID_REUSED: '같은 요청 ID가 다른 내용에 이미 쓰였습니다. 요청을 다시 불러온 뒤 새로 보내세요.',
          IMAGE_REQUEST_INPUT_INVALID: '서버가 입력 형식을 거절했습니다. note의 길이와 줄바꿈·탭 외의 제어 문자를 확인하세요.',
          IMAGE_REQUEST_ROLE_REQUIRED: '이 계정에는 이 동작에 필요한 역할이 없습니다.',
          IMAGE_REQUEST_ACTION_FORBIDDEN: '이 요청에는 이 동작을 할 수 없습니다.',
          IMAGE_REQUEST_BUSY: '서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.',
          STUDY_ACCESS_CHANGED: '요청 중 검사 접근 조건이 바뀌었습니다. 저장되었을 수 있으니 Retry로 같은 요청을 다시 보내 확인하세요.',
        },
        statuses: { 400: '서버가 입력을 거절했습니다.', 403: '서버가 이 동작을 거절했습니다.' },
      };
      const STATES = ['Requested', 'Accepted', 'Closed', 'Declined', 'Cancelled'];
      const ACTIVE = ['Requested', 'Accepted'];
      // 동작마다 적용 결과가 가야 할 상태(U4p §5.2 전이표). 쓰기 응답의 to가 이것과 다르면 저장 결과로 받지 않는다.
      const TARGET = { accept: 'Accepted', close: 'Closed', decline: 'Declined', cancel: 'Cancelled' };
      // API 값 image-transfer는 화면에 쓰지 않는다: transfer는 Connect 전송의 말이고 요청은 전송이 아니다(U4p R06).
      const KINDS = { 'external-image': 'External Images', 'image-transfer': 'Send Images' };
      const KIND_TIPS = { 'external-image': '다른 병원의 영상을 이 기관으로 가져오도록 한 요청입니다.',
        'image-transfer': '이 검사의 영상을 다른 병원에 보내도록 한 요청입니다.' };
      const NOTE_LABEL = { Closed: 'Handling Note', Declined: 'Decline Reason', Cancelled: 'Cancel Reason' };
      const FILTERS = [['active', 'Active'], ['closed', 'Closed'], ['declined', 'Declined'], ['cancelled', 'Cancelled'], ['all', 'All']];
      const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      const STUDY = /^\d+(?:\.\d+)+$/;
      const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
      // OWN_PAGES: 본인 요청을 찾으려 읽는 #7 view=mine의 최대 쪽 수(50건씩). 넘기면 모르는 채로 두어 Cancel을 닫는다.
      const TIMEOUT_MS = 60000, NOTE_MAX = 2000, PAGE = 50, OWN_PAGES = 20;
      const queueRoot = document.getElementById('image-request-queue');
      const queueBody = document.getElementById('image-request-queue-body');
      const readRoot = document.getElementById('image-request-p');
      const readSummary = document.getElementById('image-request-summary');
      const readToggle = document.getElementById('image-request-toggle');
      const readPane = document.getElementById('image-request-pane');
      let ended = false, lock = null;
      // queueLoaded: 지금 조건의 첫 쪽을 읽은 적이 있는가. 읽기 전의 빈 목록을 "조회 성공, 요청 없음"으로 쓰지 않기 위해서다.
      let queueState = 'active', queueKind = '', queueItems = [], queueCursor = null, queueFailure = null, queueLoading = false;
      let queueLoaded = false;
      let queueSeq = 0, detailId = null, detailItem = null, detailFailure = null, detailLoading = false, detailSeq = 0;
      let readUid = null, readItems = null, readFailure = null, readLoading = false, readSeq = 0, readOpen = false;
      // 요청 id별로 쓰던 note, 결과를 모르는 쓰기(같은 requestId로 다시 보낼 것), 마지막 결과 문구.
      const drafts = new Map(), attempts = new Map(), notes = new Map();
      // 요청 id별로 이 계정이 남긴 요청인지(true·false, 서버 목록이 정한 값)와, 확인 중('checking')·확인 실패(오류)인 것.
      const ownIds = new Map(), ownReads = new Map();
      const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const button = (label, onClick) => {
        const node = make('button', null, label);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
      };
      const stateBox = () => {
        const box = make('div', 'image-request-box');
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.append(make('p', 'image-request-line'), make('p', 'image-request-detail'));
        return box;
      };
      const setState = (box, state, text, detail) => {
        box.dataset.state = state;
        box.querySelector('.image-request-line').textContent = text;
        box.querySelector('.image-request-detail').textContent = detail || '';
      };
      const dash = value => typeof value === 'string' && value.trim() ? value : '—';
      const person = value => dash(value && (value.name || value.actor));
      const time = value => {
        const date = typeof value === 'string' ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '—';
        const two = part => String(part).padStart(2, '0');
        return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
      };
      const describe = error => {
        const parts = [];
        if (error && error.status) parts.push(`HTTP ${error.status}`);
        if (error && error.code) parts.push(error.code);
        const message = error && error.message ? error.message : TEXT.rejected;
        return parts.length ? `${message} (${parts.join(' · ')})` : message;
      };
      const readDetail = error => `${error && error.status === 404 ? `${TEXT.notFound}\n` : ''}${describe(error)}`;
      // 상태명은 색과 함께 늘 글자로 쓰고(UXR-G-12), Closed에는 기록일 뿐이라는 문구를 바로 옆에 붙인다.
      const badge = state => {
        const wrap = make('span');
        const name = make('span', 'image-request-status', state);
        name.dataset.state = state;
        wrap.append(name);
        if (state === 'Closed') {
          const note = make('span', 'image-request-closed', TEXT.closedNote);
          note.dataset.closedNote = '';
          wrap.append(' ', note);
        }
        return wrap;
      };
      const kindName = kind => {
        const name = make('strong', null, KINDS[kind]);
        name.title = KIND_TIPS[kind];
        return name;
      };
      const line = (label, value) => {
        const node = make('p', 'image-request-text');
        node.append(make('span', 'image-request-muted', label), ' ', value);
        return node;
      };
      const studyLabel = uid => {
        const row = study(uid);
        return row ? `${dash(row.name)} · ${dash(row.id)} · ${dash(row.date)} · ${dash(row.desc)}` : `${TEXT.unlisted} · ${uid}`;
      };

      /** 응답의 owner가 이 화면의 계정인가. 다르면 false(다른 계정의 답), 모양이 틀리면 null(형식 오류)이다. */
      function ownerOf(data) {
        const value = data && data.owner, mine = owner();
        if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null;
        return !!mine && value[0] === mine[0] && value[1] === mine[1];
      }

      /** 쓰기마다 새 UUID v4. randomUUID가 없는 브라우저는 같은 형식을 getRandomValues로 만든다. */
      function newRequestId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map(part => part.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }

      /**
       * 읽기(#7·#8·#9). api()에 제한 시간을 둔다. 연결 실패·제한 시간은 status 0이다. `at`은 그 읽기를 시작한 작업 문맥이다 —
       * 답과 실패를 그리는 자리는 부른 쪽이 이 문맥(work.admits)과 자기 번호를 함께 본다(로그아웃 준비·그 취소 뒤의 답은
       * 이 칸의 것이 아니다).
       */
      async function call(method, path, body, at) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          return await api(method, path, body, controller.signal, at);
        } catch (error) {
          if (error && Number.isInteger(error.status)) throw error;
          throw Object.assign(new Error(error && error.name === 'AbortError' ? TEXT.noResponse : TEXT.noServer), { status: 0, code: null });
        } finally {
          clearTimeout(timer);
        }
      }

      /**
       * 쓰기(#11, 제한 시간 60초). api()는 성공 응답의 본문만 돌려주어 HTTP 상태를 버린다 — 적용 결과는 201뿐이라(U4p §3.4)
       * 200·202·204 같은 다른 성공 상태를 저장 결과로 받지 않으려면 상태가 필요하다(Astra S5-U4bc-R-001 F02). api()를 쓰는
       * 다른 호출자는 그대로 두고 이 쓰기만 상태와 본문을 함께 돌려준다(appliedOf). 같은 전송으로 보낸다: 시작할 때의 문맥으로
       * 승인받고 그 세션의 식별값을 싣는다. 401은 전송이 그 요청의 세션으로 auth.js에 알린다 — 이 칸은 세션 종료 조정이
       * 부르는 end()로 닫히고 여기서 로그아웃을 부르지 않는다. 연결 실패·제한 시간은 status 0이다 — 서버가 적용했는지 모르는
       * 결과다.
       */
      async function post(path, body, at) {
        try {
          const answer = await transport.request(apiBase + path, { method: 'POST', json: body, context: at, deadlineMs: TIMEOUT_MS });
          if (answer.auth) throw Object.assign(new Error(TEXT.expired), { status: answer.status, code: null, auth: true });
          if (!answer.ok) {
            throw Object.assign(new Error(answer.body && typeof answer.body.message === 'string' ? answer.body.message : `HTTP ${answer.status}`),
              { status: answer.status, code: answer.code });
          }
          return { status: answer.status, data: answer.incomplete ? null : answer.body };
        } catch (error) {
          if (error && Number.isInteger(error.status)) throw error;
          throw Object.assign(new Error(error && error.transport === 'timeout' ? TEXT.noResponse : TEXT.noServer), { status: 0, code: null });
        }
      }

      /**
       * 요청 DTO 한 건(U4p §3.3). target이 있으면 그 검사의 행이어야 한다. 처리 중(Requested·Accepted)이면 note가 없고 끝난
       * 상태면 있다(서버 CHECK와 같은 조건).
       */
      function itemOk(item, target) {
        const text = value => typeof value === 'string';
        const who = value => !!value && typeof value === 'object' && text(value.actor) && text(value.name);
        return !!item && typeof item === 'object' && text(item.id) && ID.test(item.id) && text(item.studyUid)
          && (target === null ? item.studyUid.length <= 64 && STUDY.test(item.studyUid) : item.studyUid === target)
          && Object.prototype.hasOwnProperty.call(KINDS, item.kind) && STATES.includes(item.state)
          && Number.isSafeInteger(item.revision) && item.revision >= 1 && who(item.requester)
          && !!item.counterparty && typeof item.counterparty === 'object' && text(item.counterparty.text)
          && (item.counterparty.institutionId === null || text(item.counterparty.institutionId)) && text(item.reason)
          && (item.handler === null || who(item.handler)) && (item.note === null || text(item.note))
          && ACTIVE.includes(item.state) === (item.note === null);
      }

      /** #7·#9 응답의 items. 하나라도 틀리면 답 전체를 그리지 않는다. */
      function itemsOf(data, target) {
        const rows = data && data.items;
        if (!Array.isArray(rows) || rows.length > PAGE || !rows.every(row => itemOk(row, target))
            || new Set(rows.map(row => row.id)).size !== rows.length)
          throw new Error(TEXT.malformed);
        return rows;
      }

      /**
       * 쓰기 응답(U4p §3.4)이 보낸 그 쓰기의 적용 결과인가: HTTP 201이고 봉투가 이 requestId·요청·검사·동작, 보낼 때 읽은 종류와
       * 상태(from), 동작의 목적 상태(to), 보낸 revision + 1, 서버가 쓰는 형식의 시각(at). 재전송 답(replayed)도 처음 적용한 그
       * 결과라 지금 요청이 더 진행되었어도 같은 조건이다. 하나라도 어긋나면 저장 결과가 아니라 결과를 모르는 쓰기로 둔다(같은
       * requestId로 Retry).
       */
      function appliedOf(sent, attempt) {
        const answer = sent.data, applied = answer && answer.applied;
        const at = applied && typeof applied.at === 'string' ? new Date(applied.at) : null;
        return sent.status === 201 && !!applied && typeof applied === 'object' && typeof answer.replayed === 'boolean'
          && typeof applied.requestId === 'string' && applied.requestId.toLowerCase() === attempt.requestId
          && applied.id === attempt.id && applied.studyUid === attempt.studyUid && applied.action === attempt.action
          && applied.kind === attempt.kind && applied.from === attempt.from && applied.to === TARGET[attempt.action]
          && applied.revision === attempt.payload.revision + 1
          && !!at && !Number.isNaN(at.getTime()) && at.toISOString() === applied.at;
      }

      /** 요청 한 건의 읽기 전용 줄들: 종류·상태·검사·요청자와 상대 기관·사유·처리자·note. */
      function itemLines(item, withStudy) {
        const head = make('p');
        head.append(badge(item.state), ' ', kindName(item.kind), ` · ${TEXT.meta(time(item.createdAt), person(item.requester))}`);
        const lines = [head];
        if (withStudy) lines.push(line('Study', studyLabel(item.studyUid)));
        const registered = item.counterparty.institutionId === null ? null : institution(item.counterparty.institutionId);
        lines.push(line('Counterparty', item.counterparty.institutionId === null ? item.counterparty.text
          : `${item.counterparty.text} (${TEXT.registered}: ${registered || item.counterparty.institutionId})`));
        lines.push(line('Reason', item.reason));
        if (item.handler) lines.push(line('Handler', person(item.handler)));
        if (item.note !== null) lines.push(line(NOTE_LABEL[item.state] || 'Note', item.note));
        return lines;
      }

      // ── 대기열(Technician 모드) ──
      // 칸은 한 번 만든다: 조건 줄, 목록, 단건과 처리 칸, 잠금 안내.
      const lockBox = stateBox();
      lockBox.id = 'image-request-queue-lock';
      lockBox.dataset.state = 'failed';
      lockBox.setAttribute('role', 'alert');
      const queueView = make('div');
      const filters = make('div', 'image-request-actions');
      const stateLabel = make('label', null, 'State');
      stateLabel.htmlFor = 'image-request-queue-state';
      const stateFilter = make('select');
      stateFilter.id = 'image-request-queue-state';
      for (const [value, label] of FILTERS) {
        const option = make('option', null, label);
        option.value = value;
        stateFilter.append(option);
      }
      const kindLabel = make('label', null, 'Kind');
      kindLabel.htmlFor = 'image-request-queue-kind';
      const kindFilter = make('select');
      kindFilter.id = 'image-request-queue-kind';
      for (const [value, label] of [['', 'All Kinds'], ...Object.entries(KINDS)]) {
        const option = make('option', null, label);
        option.value = value;
        kindFilter.append(option);
      }
      const reload = button('Reload', () => { loadQueue(false); if (detailId !== null) loadDetail(detailId); });
      reload.id = 'image-request-queue-reload';
      filters.append(stateLabel, stateFilter, kindLabel, kindFilter, reload);
      const queueLine = stateBox();
      queueLine.id = 'image-request-queue-status';
      const queueRetry = button('Retry', () => loadQueue(queueItems.length > 0));
      queueRetry.id = 'image-request-queue-retry';
      queueLine.append(queueRetry);
      const queueList = make('ol');
      queueList.id = 'image-request-queue-list';
      const queueMore = button('More', () => loadQueue(true));
      queueMore.id = 'image-request-queue-more';
      const detailBox = make('section');
      detailBox.id = 'image-request-detail';
      detailBox.setAttribute('aria-labelledby', 'image-request-detail-title');
      const detailHead = make('div', 'image-request-actions');
      const detailTitle = make('h4', null, 'Request');
      detailTitle.id = 'image-request-detail-title';
      const detailStatus = make('span');
      detailHead.append(detailTitle, detailStatus);
      const detailLine = stateBox();
      detailLine.dataset.part = 'read';
      const detailRetry = button('Retry', () => { if (detailId !== null) loadDetail(detailId); });
      detailLine.append(detailRetry);
      const detailLines = make('div');
      detailLines.dataset.part = 'lines';
      const noteLabel = make('label', null, 'Note');
      noteLabel.htmlFor = 'image-request-note';
      const noteHint = make('p', 'image-request-muted', TEXT.noteHint);
      noteHint.id = 'image-request-note-hint';
      const noteField = make('textarea');
      noteField.id = 'image-request-note';
      noteField.rows = 2;
      noteField.maxLength = NOTE_MAX;
      noteField.setAttribute('aria-describedby', 'image-request-note-hint');
      noteField.addEventListener('input', () => { if (detailId !== null && !attempts.has(detailId)) drafts.set(detailId, noteField.value); });
      const actions = {};
      const actionRow = make('div', 'image-request-actions');
      for (const [action, label] of [['accept', 'Accept'], ['close', 'Close'], ['decline', 'Decline'], ['cancel', 'Cancel']]) {
        actions[action] = button(label, () => submit(action));
        actions[action].dataset.action = action;
        actionRow.append(actions[action]);
      }
      const retryRow = make('div', 'image-request-actions');
      const writeRetry = button('Retry', () => resend());
      writeRetry.dataset.write = 'retry';
      const writeDiscard = button('Discard', () => drop());
      writeDiscard.dataset.write = 'discard';
      retryRow.append(writeRetry, writeDiscard);
      const writeNote = stateBox();
      writeNote.dataset.part = 'write';
      detailBox.append(detailHead, detailLine, detailLines, noteLabel, noteHint, noteField, actionRow, retryRow, writeNote);
      queueView.append(make('p', 'image-request-muted', TEXT.queueHint), filters, queueLine, queueList, queueMore, detailBox);
      queueBody.append(lockBox, queueView);

      function renderQueue() {
        const unavailable = !ended && lock === null && !allowed();
        lockBox.hidden = !ended && lock === null;
        setState(lockBox, 'failed', ended ? TEXT.ended : lock ? lock.text : '', lock && !ended ? lock.detail : '');
        queueView.hidden = ended || lock !== null;
        const state = unavailable ? 'offline' : queueLoading ? 'loading' : queueFailure ? 'failed' : !queueLoaded ? 'idle'
          : queueItems.length ? 'ready' : 'empty';
        setState(queueLine, state, { offline: TEXT.offline, loading: TEXT.queueLoading, failed: TEXT.queueFailed, empty: TEXT.queueEmpty,
          idle: '' }[state] ?? TEXT.queueReady(queueItems.length, queueCursor !== null), queueFailure ? readDetail(queueFailure) : '');
        queueRetry.hidden = !queueFailure;
        queueMore.hidden = queueCursor === null || queueLoading || !!queueFailure;
        stateFilter.value = queueState;
        kindFilter.value = queueKind;
      }

      function queueItem(item) {
        const li = make('li');
        li.dataset.id = item.id;
        const info = make('div');
        info.dataset.part = 'info';
        info.append(...itemLines(item, true));
        const open = button('Open', () => openDetail(item.id));
        open.dataset.open = '';
        open.title = '이 요청을 읽고 처리 칸을 엽니다.';
        li.append(info, open);
        if (item.id === detailId) li.setAttribute('aria-current', 'true');
        li.dataset.state = item.state;
        return li;
      }

      function renderQueueList() {
        queueList.replaceChildren(...queueItems.map(queueItem));
        queueList.hidden = !queueItems.length;
      }

      /** 연 요청 표시만 제자리에서 바꾼다(목록을 다시 만들면 방금 누른 Open 단추의 포커스가 사라진다). */
      function markCurrent() {
        for (const li of queueList.children) {
          if (li.dataset.id === detailId) li.setAttribute('aria-current', 'true');
          else li.removeAttribute('aria-current');
        }
      }

      /** 단건을 다시 읽으면 대기열의 같은 줄도 그 내용으로 바꾼다(Open 단추는 그대로 둔다). */
      function refreshQueueItem(item) {
        const at = queueItems.findIndex(entry => entry.id === item.id);
        if (at < 0) return;
        queueItems[at] = item;
        const li = [...queueList.children].find(entry => entry.dataset.id === item.id);
        if (!li) return;
        const info = make('div');
        info.dataset.part = 'info';
        info.append(...itemLines(item, true));
        li.querySelector('[data-part="info"]').replaceWith(info);
        li.dataset.state = item.state;
      }

      /** #7 view=queue. 조건을 바꾸거나 다시 읽으면 첫 쪽부터, More는 서버가 준 cursor를 그대로 넘겨 이어 붙인다. */
      async function loadQueue(more) {
        if (ended || lock !== null || !queueRoot.open) return;
        const mine = ++queueSeq, cursor = more ? queueCursor : null;
        if (!more) {
          queueItems = [];
          queueCursor = null;
          queueLoaded = false;
          renderQueueList();
        }
        queueFailure = null;
        if (!allowed()) {
          queueLoading = false;
          renderQueue();
          return;
        }
        queueLoading = true;
        renderQueue();
        const query = `view=queue&state=${encodeURIComponent(queueState)}${queueKind ? `&kind=${encodeURIComponent(queueKind)}` : ''}`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const at = work.capture('document');
        let data;
        try {
          data = await call('GET', `/image-requests?${query}`, undefined, at);
        } catch (error) {
          if (!work.admits(at) || ended || lock !== null || mine !== queueSeq) return;
          queueLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          queueFailure = error;
          renderQueue();
          return;
        }
        if (!work.admits(at) || ended || lock !== null || mine !== queueSeq) return;
        queueLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          const page = itemsOf(data, null), next = data.nextCursor;
          if (!(next === null || (typeof next === 'string' && CURSOR.test(next) && next !== cursor))
              || page.some(item => queueItems.some(seen => seen.id === item.id)))
            throw new Error(TEXT.malformed);
          queueItems = [...queueItems, ...page];
          queueCursor = next;
          queueLoaded = true;
        } catch (error) {
          queueFailure = error;
        }
        renderQueueList();
        renderQueue();
      }

      function openDetail(id) {
        if (ended || lock !== null) return;
        if (detailId !== id) {
          detailId = id;
          detailItem = null;
          detailFailure = null;
          detailSeq++;
        }
        markCurrent();
        loadDetail(id);
      }

      /** #8. 연 요청 한 건. 늦은 답은 번호와 연 요청 id로 버린다. */
      async function loadDetail(id) {
        if (ended || lock !== null || detailId !== id) return;
        const mine = ++detailSeq;
        detailLoading = true;
        detailFailure = null;
        renderDetail();
        const at = work.capture('document');
        let data;
        try {
          data = await call('GET', `/image-requests/${encodeURIComponent(id)}`, undefined, at);
        } catch (error) {
          if (!work.admits(at) || ended || lock !== null || mine !== detailSeq || detailId !== id) return;
          detailLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          detailItem = null;
          detailFailure = error;
          renderDetail();
          return;
        }
        if (!work.admits(at) || ended || lock !== null || mine !== detailSeq || detailId !== id) return;
        detailLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null || !itemOk(data.item, null) || data.item.id !== id) throw new Error(TEXT.malformed);
          detailItem = data.item;
          refreshQueueItem(detailItem);
          checkOwn(detailItem);
        } catch (error) {
          detailItem = null;
          detailFailure = error;
        }
        renderDetail();
      }

      function loadedDetail() {
        return !detailFailure && detailItem !== null && detailItem.id === detailId ? detailItem : null;
      }

      /**
       * 이 요청의 Cancel 안내(U4p §5.2·RM-R7): 관리자이거나, clinician 역할이 있고 이 요청을 남긴 본인일 때만. 역할만 보면
       * 기관 전체 요청을 읽는 혼합 역할(clinician+radiologist 등)에게 남의 요청 취소가 열린다. 본인인지는 서버가 요청자 sub로 고른
       * #7 view=mine에 그 id가 있는지로만 정한다(ownIds) — requester.actor는 email 등이 바뀌면 같은 사람의 것이 달라지고 다른
       * 계정의 값과 겹칠 수 있다. 확인 중이거나 확인하지 못했으면 닫는다. 판정은 서버가 sub로 다시 한다.
       */
      function canCancel(item) {
        return can('admin') || (can('clinician') && !!item && ownIds.get(item.id) === true);
      }

      /** 닫힌 Cancel의 이유: 역할·타인의 요청, 확인 중, 확인 실패(Reload로 다시 확인). */
      function cancelHint(item) {
        if (canCancel(item)) return '';
        const reading = item ? ownReads.get(item.id) : undefined;
        if (!can('clinician') || !item || ownIds.has(item.id)) return TEXT.roleCancel;
        if (reading === 'checking') return TEXT.ownChecking;
        return reading ? `${TEXT.ownFailed}\n${describe(reading)}` : TEXT.roleCancel;
      }

      /**
       * #7 view=mine(state=all)을 필요한 쪽까지 읽어 targets 각각이 이 계정의 요청인지 정한다(true·false). 목록은 생성 시각이 늦은
       * 것부터라, 한 쪽의 마지막 행이 남은 요청보다 확실히 이르거나 다음 쪽이 없으면 남은 요청은 이 계정의 것이 아니다. 요청자는
       * 요청이 생긴 뒤 바뀌지 않으므로 한 번 정한 값은 이 문서(같은 계정) 안에서 그대로다. OWN_PAGES 쪽을 넘기면 오류로 둔다.
       * live()가 거짓이 되면(세션 종료·잠금) null이다.
       */
      async function readOwn(targets, live, at) {
        const left = new Map(targets.map(item => [item.id, Date.parse(item.createdAt)])), found = new Map();
        let cursor = null;
        for (let page = 0; left.size && page < OWN_PAGES; page++) {
          const query = 'view=mine&state=all' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
          const data = await call('GET', `/image-requests?${query}`, undefined, at);
          if (!live()) return null;
          const same = ownerOf(data);
          if (same === false) {
            accountChanged('');
            return null;
          }
          if (same === null) throw new Error(TEXT.malformed);
          const rows = itemsOf(data, null), next = data.nextCursor;
          if (!(next === null || (typeof next === 'string' && CURSOR.test(next) && next !== cursor))) throw new Error(TEXT.malformed);
          for (const row of rows) if (left.delete(row.id)) found.set(row.id, true);
          const last = rows.length ? Date.parse(rows[rows.length - 1].createdAt) : NaN;
          for (const [id, at] of left) {
            if (next !== null && !(last < at)) continue;
            left.delete(id);
            found.set(id, false);
          }
          cursor = next;
        }
        if (left.size) throw new Error(TEXT.ownTooMany);
        return found;
      }

      /**
       * 연 요청이 처리 중이고 이 계정이 관리자가 아닌 clinician이면 본인 요청인지 확인한다(관리자는 누구의 요청이든 취소할 수
       * 있고, clinician이 아니면 요청자일 수 없다). 403은 서버가 이 계정에 요청자 범위를 주지 않은 것이라 본인 요청이 아니다.
       * 그 밖의 실패는 확인 실패로 남겨 Cancel을 닫고, Reload(단건 다시 읽기)가 다시 확인한다.
       */
      async function checkOwn(item) {
        if (ended || lock !== null || can('admin') || !can('clinician') || !ACTIVE.includes(item.state) || ownIds.has(item.id)
            || ownReads.get(item.id) === 'checking') return;
        const at = work.capture('document');
        const live = () => work.admits(at) && !ended && lock === null;
        ownReads.set(item.id, 'checking');
        paintComposer();
        let found = null, failure = null;
        try {
          found = await readOwn([item], live, at);
        } catch (error) {
          failure = error;
        }
        // 이 확인이 건 "확인 중" 표시는 이 확인이 푼다(자기 것만). 그리는 것은 문맥이 그대로일 때만 한다.
        if (!live()) { if (ownReads.get(item.id) === 'checking') ownReads.delete(item.id); return; }
        if (failure && failure.auth) return;
        ownReads.delete(item.id);
        if (failure && failure.status === 403) found = new Map([[item.id, false]]);
        else if (failure) ownReads.set(item.id, failure);
        if (found) for (const [id, own] of found) ownIds.set(id, own);
        paintComposer();
      }

      function renderDetail() {
        detailBox.hidden = detailId === null;
        if (detailId === null) return;
        const loaded = loadedDetail();
        detailBox.dataset.id = detailId;
        detailBox.dataset.state = loaded ? loaded.state : detailFailure ? 'failed' : 'loading';
        detailStatus.replaceChildren(...(loaded ? [badge(loaded.state)] : []));
        const state = detailFailure ? 'failed' : detailLoading || !loaded ? 'loading' : 'ready';
        setState(detailLine, state, { failed: TEXT.detailFailed, loading: TEXT.detailLoading }[state] || '',
          detailFailure ? readDetail(detailFailure) : '');
        detailLine.hidden = state === 'ready';
        detailRetry.hidden = !detailFailure;
        detailLines.replaceChildren(...(loaded ? itemLines(loaded, true) : []));
        paintComposer();
      }

      /**
       * 처리 칸의 모양은 맵(쓰던 note·결과를 모르는 쓰기)과 마지막으로 읽은 그 요청에서만 정한다. 결과를 모르는 쓰기가 있는 동안
       * note는 바꿀 수 없고 Retry(같은 requestId)와 Discard만 있다 — 고쳐 새로 보내면 같은 처리가 두 번 기록될 수 있다.
       */
      function paintComposer() {
        const id = detailId, attempt = id === null ? null : attempts.get(id) || null, loaded = loadedDetail();
        detailBox.dataset.write = !attempt ? 'idle' : attempt.busy ? 'busy' : 'unknown';
        const value = attempt ? attempt.text : id === null ? '' : drafts.get(id) || '';
        // 같은 글이면 쓰지 않는다: 값을 다시 넣으면 치고 있던 커서·한글 조합이 끊긴다.
        if (noteField.value !== value) noteField.value = value;
        noteField.readOnly = attempt !== null;
        const staff = can('technician'), cancel = cancelHint(loaded);
        const state = loaded ? loaded.state : null;
        for (const [action, control] of Object.entries(actions)) {
          const role = action === 'cancel' ? cancel : staff ? '' : TEXT.roleStaff;
          const stale = !loaded ? '' : action === 'accept' ? (state === 'Requested' ? '' : TEXT.stateAccept)
            : ACTIVE.includes(state) ? '' : TEXT.stateDone;
          control.disabled = attempt !== null || !loaded || !!role || !!stale;
          control.title = role || stale || TEXT.tips[action];
        }
        writeRetry.hidden = writeDiscard.hidden = !attempt || attempt.busy;
        const note = id === null ? null : notes.get(id) || null;
        writeNote.hidden = note === null;
        setState(writeNote, note ? note.state : 'idle', note ? note.text : '', note ? note.detail : '');
      }

      function setNote(id, state, text, detail) {
        notes.set(id, { state, text, detail: detail || '' });
        if (id === detailId) paintComposer();
      }

      /** 새 쓰기: 새 requestId(UUID v4), 이 화면의 계정([기관, sub]), 마지막으로 읽은 그 요청의 revision. Accept는 빈 note다. */
      function submit(action) {
        const id = detailId, loaded = loadedDetail(), who = owner();
        if (ended || lock !== null || id === null || !loaded || attempts.has(id) || !who) return;
        if (action === 'cancel' && !canCancel(loaded)) return;
        const text = noteField.value, note = action === 'accept' ? '' : text;
        if (action !== 'accept' && (!note.trim() || note.length > NOTE_MAX)) {
          setNote(id, 'failed', TEXT.noNote);
          return;
        }
        let requestId;
        try {
          requestId = newRequestId();
        } catch (_) {
          setNote(id, 'failed', TEXT.noRequestId);
          return;
        }
        // kind·from은 보낼 때 읽은 그 요청의 값이다. 적용 결과가 이 둘과 맞아야 저장 결과로 받는다(appliedOf).
        const attempt = { requestId, owner: who, id, studyUid: loaded.studyUid, kind: loaded.kind, from: loaded.state, action, text,
          busy: false, unknown: false, payload: { revision: loaded.revision, action, note } };
        drafts.set(id, text);
        attempts.set(id, attempt);
        transmit(attempt);
      }

      /** 결과를 모르는 쓰기만 같은 requestId·같은 본문으로 다시 보낸다. 이미 적용되었으면 서버가 저장한 결과를 돌려준다. */
      function resend() {
        const attempt = detailId === null ? null : attempts.get(detailId);
        if (ended || lock !== null || !attempt || attempt.busy || !attempt.unknown) return;
        transmit(attempt);
      }

      /** 결과를 모르는 쓰기를 버린다. note는 칸에 남기고, 저장되었는지는 다시 읽은 요청으로 보인다. */
      function drop() {
        const attempt = detailId === null ? null : attempts.get(detailId);
        if (ended || !attempt || attempt.busy) return;
        attempts.delete(attempt.id);
        drafts.set(attempt.id, attempt.text);
        setNote(attempt.id, 'discarded', TEXT.discarded);
        afterWrite(attempt);
      }

      async function transmit(attempt) {
        attempt.busy = true;
        attempt.unknown = false;
        setNote(attempt.id, 'busy', TEXT.sending);
        const at = work.capture('document');
        let sent = null, error = null;
        try {
          sent = await post(`/image-requests/${encodeURIComponent(attempt.id)}`,
            { requestId: attempt.requestId, expectedOwner: attempt.owner, ...attempt.payload }, at);
        } catch (caught) {
          error = caught;
        }
        // 세션이 끝났거나 잠겨 맵을 비웠으면 이 결과는 어디에도 쓰지 않는다.
        if (ended || attempts.get(attempt.id) !== attempt) return;
        // 로그아웃 준비·그 취소 뒤에 온 답은 저장 결과로 그리지 않는다. 그 쓰기는 결과를 모르는 것으로 남아 같은 요청 ID의
        // Retry가 서버의 결과를 확인한다(보낸 것을 잊지 않는다).
        if (!work.admits(at)) {
          attempt.busy = false;
          attempt.unknown = true;
          notes.set(attempt.id, { state: 'unknown', text: TEXT.unknown, detail: '' });
          return;
        }
        attempt.busy = false;
        if (error) {
          writeFailed(attempt, error);
          return;
        }
        const same = ownerOf(sent.data);
        if (same === false) {
          accountChanged('');
          return;
        }
        // 201이 아닌 성공 상태는 적용 결과가 아니다. 그 상태를 자세한 줄에 보이고 같은 requestId의 Retry·Discard를 남긴다.
        if (same === null || !appliedOf(sent, attempt)) {
          attempt.unknown = true;
          setNote(attempt.id, 'unknown', TEXT.writeMalformed, sent.status === 201 ? '' : `HTTP ${sent.status}`);
          return;
        }
        attempts.delete(attempt.id);
        // Accept는 note를 보내지 않았으니 쓰던 note는 다음 처리(Close 등)를 위해 남긴다.
        if (attempt.action !== 'accept') drafts.delete(attempt.id);
        setNote(attempt.id, 'saved', sent.data.replayed ? TEXT.replayed : TEXT.saved[attempt.action]);
        afterWrite(attempt);
      }

      /**
       * 쓰기 실패. 연결 실패·제한 시간·5xx·IMAGE_REQUEST_BUSY·STUDY_ACCESS_CHANGED(커밋 뒤 최종 확인일 수 있다)는 적용 여부를 모르는
       * 결과라 Retry(같은 requestId)를 남긴다. 그 밖의 거절은 쓰기를 버리고 note는 칸에 둔다. OWNER_CHANGED는 계정이 바뀐 것이다.
       */
      function writeFailed(attempt, error) {
        if (error.auth) return;
        if (error.code === 'OWNER_CHANGED') {
          accountChanged(describe(error));
          return;
        }
        if (error.status === 0 || error.status >= 500 || error.code === 'STUDY_ACCESS_CHANGED') {
          attempt.unknown = true;
          setNote(attempt.id, 'unknown', TEXT.codes[error.code] || TEXT.unknown, describe(error));
          return;
        }
        attempts.delete(attempt.id);
        setNote(attempt.id, 'failed', TEXT.codes[error.code] || (error.status === 404 ? TEXT.notFound : TEXT.statuses[error.status])
          || TEXT.rejected, describe(error));
        // 요청이 바뀌었거나 끝났거나 보이지 않게 되었으면 지금 서버 상태를 다시 읽는다(note는 칸에 남는다).
        if (error.status === 404 || error.status === 409) afterWrite(attempt);
      }

      /** 화면은 쓰기 응답(적용 결과)이 아니라 읽기 route로 다시 읽은 현재 상태로만 그린다: 그 요청, 대기열 첫 쪽, 같은 검사의 판독 쪽 줄. */
      function afterWrite(attempt) {
        if (ended || lock !== null) return;
        if (detailId === attempt.id) loadDetail(attempt.id);
        else paintComposer();
        if (queueRoot.open) loadQueue(false);
        if (readUid !== null && readUid === attempt.studyUid) loadReading();
      }

      // ── 판독 화면(읽기 전용) ──
      const readLine = stateBox();
      readLine.id = 'image-request-read-status';
      const readRetry = button('Retry', () => loadReading());
      readLine.append(readRetry);
      const readList = make('ol');
      readList.id = 'image-request-read-list';
      readPane.append(make('p', 'image-request-muted', TEXT.readHint), readLine, readList);
      // 접힌 줄에도 Closed 옆 문구가 보여야 한다(U4p §3.3). 요약은 말줄임으로 잘리므로 그 안에 두지 않고 바로 아래에 줄을 넘기는
      // 한 줄로 둔다 — Closed가 있을 때만 서므로 Closed 없는 검사의 판독 화면 배치는 그대로다.
      const readClosed = make('p', 'image-request-closed-line');
      readClosed.dataset.part = 'closed';
      readClosed.append(badge('Closed'));
      readRoot.insertBefore(readClosed, readPane);

      function readCounts(items) {
        return STATES.map(state => [state, items.filter(item => item.state === state).length]).filter(([, n]) => n)
          .map(([state, n]) => `${state} ${n}`).join(' · ');
      }

      /** 줄은 요청이 있거나 읽기가 실패했거나 잠긴 동안만 보인다 — 요청 없는 검사의 판독 화면 배치를 바꾸지 않는다. */
      function renderReading() {
        const visible = !ended && (lock !== null || readFailure !== null || (readItems !== null && readItems.length > 0));
        readRoot.hidden = !visible;
        readRoot.dataset.state = ended ? 'ended' : lock ? 'locked' : readFailure ? 'failed' : readLoading ? 'loading'
          : readItems === null ? 'idle' : readItems.length ? 'ready' : 'empty';
        const text = lock ? lock.text : readFailure ? TEXT.readFailed : readItems && readItems.length
          ? TEXT.readCounts(readItems.length, readCounts(readItems)) : TEXT.readLoading;
        readSummary.textContent = text;
        readSummary.title = lock ? `${lock.text}\n${lock.detail}`.trim() : readFailure ? readDetail(readFailure) : text;
        readClosed.hidden = !!lock || !!readFailure || !readItems || !readItems.some(item => item.state === 'Closed');
        readToggle.hidden = lock !== null;
        readToggle.textContent = readOpen ? 'Hide Requests' : 'Show Requests';
        readToggle.setAttribute('aria-expanded', String(readOpen && lock === null));
        readPane.hidden = !readOpen || lock !== null;
        const state = readFailure ? 'failed' : readLoading ? 'loading' : 'ready';
        setState(readLine, state, { failed: TEXT.readFailed, loading: TEXT.readLoading }[state] || '',
          readFailure ? readDetail(readFailure) : '');
        readLine.hidden = state === 'ready';
        readRetry.hidden = !readFailure;
        readList.replaceChildren(...(readFailure || !readItems ? [] : readItems).map(item => {
          const li = make('li');
          li.dataset.id = item.id;
          li.dataset.state = item.state;
          li.append(...itemLines(item, false));
          return li;
        }));
        readList.hidden = !readList.children.length;
      }

      /** #9. 판독 대상 검사의 요청(최신 50). 늦은 답은 번호와 대상 검사로 버린다. */
      async function loadReading() {
        if (ended || lock !== null || readUid === null) return;
        const target = readUid, mine = ++readSeq;
        readLoading = true;
        readFailure = null;
        renderReading();
        const at = work.capture('document');
        let data;
        try {
          data = await call('GET', `/studies/${encodeURIComponent(target)}/image-requests`, undefined, at);
        } catch (error) {
          if (!work.admits(at) || ended || lock !== null || mine !== readSeq || target !== readUid) return;
          readLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          readItems = null;
          readFailure = error;
          renderReading();
          return;
        }
        if (!work.admits(at) || ended || lock !== null || mine !== readSeq || target !== readUid) return;
        readLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          readItems = itemsOf(data, target);
        } catch (error) {
          readItems = null;
          readFailure = error;
        }
        renderReading();
      }

      /**
       * renderClinical()이 부른다(선택·목록 갱신·관련 검사 보기마다). 판독 대상이 바뀐 때만 이전 대상의 줄을 내리고 새 대상을
       * 읽는다 — 같은 대상이면 요청도 그리기도 없다. refreshRight()에 두지 않는다: report_* 시험은 select()·refreshRight()를
       * 잘라 그대로 돌리고 renderClinical()만 비워 두므로, 거기서 선언되지 않은 이름은 ReferenceError가 된다.
       * 원격판독으로 받은 검사는 읽지 않는다: 요청은 소유 기관 안에서만 오가고(U4p T-4) 늘 404다.
       */
      function sync() {
        if (ended) return;
        const target = allowed() ? current() : null;
        const row = target ? study(target) : null;
        const next = row && row.tele !== true ? target : null;
        if (next === readUid) return;
        readUid = next;
        readSeq++;
        readItems = null;
        readFailure = null;
        readLoading = false;
        renderReading();
        if (readUid !== null && lock === null) loadReading();
      }

      /**
       * 확인된 계정 변경(다른 계정의 봉투 owner·OWNER_CHANGED)은 이 칸만의 일이 아니다. 이 칸을 잠그고 notifyAccountChanged로 onCommonEnd 구독자에게
       * 사유 'account-changed'로 알려, 네트워크를 기다리기 전에 같은 페이지의 다른 영역(S5-U4b 질문 줄)도
       * 쓰던 글·결과를 모르는 요청·읽기/쓰기 번호를 버리게 한다 — 이 칸만 잠그면 다른 영역에 이전 계정의 글과 Retry가 남고 나가
       * 있던 쓰기의 늦은 영수증이 저장 결과로 그려진다(Astra S5-U4bc-R-001 F01). 한 요청·검사의 읽기를 서버가 403으로 거절한 것은
       * 계정 변경이 아니라서 lockPanel로 이 칸만 잠근다.
       */
      function accountChanged(detail) {
        lockPanel(TEXT.ownerChanged, detail, true);
        notifyAccountChanged(detail);
      }

      /**
       * 서버가 읽기를 거절했거나(403) 계정이 바뀌었다(accountChanged, 이 칸이나 다른 영역이 알아챘다). 이 문서에서는 요청을 더
       * 읽거나 쓰지 않고 진행 중인 요청의 답도 그리지 않는다(뷰어 세션의 거절·계정 변경과 같은 한 방향). 쓰던 note는 이전 계정의
       * 것이라 버린다. 403으로 이미 잠긴 뒤 계정 변경을 알면(account) 그 까닭으로 바꿔 쓴다.
       */
      function lockPanel(text, detail, account = false) {
        if (ended || (lock !== null && (lock.account || !account))) return;
        lock = { text, detail: detail || '', account };
        queueSeq++;
        detailSeq++;
        readSeq++;
        drafts.clear();
        attempts.clear();
        notes.clear();
        ownIds.clear();
        ownReads.clear();
        noteField.value = '';
        queueItems = [];
        queueCursor = null;
        queueLoading = false;
        queueFailure = null;
        detailId = null;
        detailItem = null;
        detailFailure = null;
        detailLoading = false;
        readItems = null;
        readFailure = null;
        readLoading = false;
        renderQueueList();
        renderQueue();
        renderDetail();
        renderReading();
      }

      /**
       * 세션 관문이 실제 종료를 알렸다(명시적 로그아웃·같은 세션의 종료 통지·서버의 종료 코드). 두 칸을 내리고 쓰던 note를 버리며 나간 요청의 답은 어디에도 그리지 않는다. 공통 목록이
       * 사유 'account-changed'로 부르면 세션은 그대로이고 계정이 바뀐 것이라 잠근다(accountChanged).
       */
      function end(reason, detail) {
        if (reason === 'account-changed') {
          lockPanel(TEXT.ownerChanged, detail, true);
          return;
        }
        if (ended) return;
        ended = true;
        queueSeq++;
        detailSeq++;
        readSeq++;
        drafts.clear();
        attempts.clear();
        notes.clear();
        ownIds.clear();
        ownReads.clear();
        // 숨긴 칸에도 이전 계정이 치던 글을 남기지 않는다.
        noteField.value = '';
        queueItems = [];
        queueCursor = null;
        detailId = null;
        detailItem = null;
        readUid = null;
        readItems = null;
        readFailure = null;
        renderQueueList();
        renderQueue();
        renderDetail();
        renderReading();
      }

      /**
       * 로그아웃 준비에서 편집으로 돌아왔다. 준비가 끊은 읽기는 답을 쓰지 않고 끝났으므로, 그 읽기가 건 대기 표시를 풀고
       * 지금 문맥에서 다시 읽는다. 결과를 모르는 쓰기는 그대로 남는다(사람이 Retry·Discard를 고른다).
       */
      function resume() {
        if (ended || lock !== null) return;
        queueLoading = detailLoading = readLoading = false;
        if (queueRoot.open) { loadQueue(false); if (detailId !== null) loadDetail(detailId); }
        else { renderQueue(); renderDetail(); }
        if (readUid !== null) loadReading(); else renderReading();
        paintComposer();
      }

      queueRoot.addEventListener('toggle', () => {
        if (ended) return;
        if (!queueRoot.open) {
          // 닫으면 나간 읽기의 답을 버린다. 다시 열면 처음부터 읽는다.
          queueSeq++;
          detailSeq++;
          queueLoading = false;
          detailLoading = false;
          return;
        }
        renderQueue();
        renderDetail();
        if (lock !== null) return;
        loadQueue(false);
        if (detailId !== null) loadDetail(detailId);
      });
      stateFilter.addEventListener('change', () => { queueState = stateFilter.value; loadQueue(false); });
      kindFilter.addEventListener('change', () => { queueKind = kindFilter.value; loadQueue(false); });
      readToggle.addEventListener('click', () => {
        if (ended || lock !== null) return;
        readOpen = !readOpen;
        renderReading();
      });
      window.addEventListener('pagehide', end);
      // 이 문서의 세션이 끝나면(Log out, 요청의 401, 다른 문서의 종료) 세션 종료 조정이 네트워크를 기다리기 전에 동기로 부르는
      // 목록이다. 칸마다 자기 end()를 넣는다(S5-U4b 등도 같은 목록). 한 영역이 알아챈 계정 변경도 이 목록으로 사유
      // 'account-changed'와 함께 온다(accountChanged). 어느 로그인의 종료인지는 auth.js가 대조한다 — 이 칸은 통지 채널을
      // 따로 듣지 않는다.
      onCommonEnd(end);
      renderQueueList();
      renderQueue();
      renderDetail();
      renderReading();
      return { sync, end, resume };
    }
    let imageRequests = null;
    try {
      imageRequests = mountImageRequests({ api, apiBase: API, work, transport,
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; },
        allowed: () => !!sess && serverMode && !demoMode && !offline,
        current: () => selectedUid, study: uid => studies.find(s => s.uid === uid) || null,
        institution: id => institutions.find(i => i.id === id)?.name || null, can: role => KinAuth.has(role) });
    } catch (_) { toast('영상 요청 칸을 준비하지 못했습니다. 판독·검사 작업은 계속할 수 있습니다.', 'err'); }

    // ── Match / Unmatch (8.1.2.1.1 ~ 2) ──
    async function doMatch() {
      const s = cur(), o = curOrder();
      if (!s || !o) { alert("Study List에서 검사 1건, Order List에서 오더 1건을 각각 선택하세요."); return; }
      if (s.matched === "M" || o.matched === "M") { alert("이미 매칭된 항목입니다."); return; }
      if (!confirm(`아래 오더 정보를 검사에 덮어씁니다.\n\n검사: ${s.name} (${s.id}) ${s.date}\n오더: ${o.name} (${o.id}) ${o.sched}\n\n진행할까요?`)) return;

      const a = appState[s.uid] ??= {};
      const orig = a.orig ?? { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      const ov = { id: o.id, name: o.name, sex: o.sex, birth: o.birth, age: ageOf(o.birth, s.date), desc: o.desc, ward: o.ward };

      if (serverMode) {
        // 검사와 오더를 함께 바꾸는 일이라 서버 트랜잭션에 맡긴다.
        // 한쪽만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
        // S4-U5: the server stores a claimed original only in the overlay shape, so only those fields are sent
        // (an age the row could not compute is dropped rather than sent as null).
        const claimed = {};
        for (const key of OVERLAY_KEYS) if (overlayValue(key, orig?.[key])) claimed[key] = orig[key];
        const at = work.capture("document");
        let st;
        try {
          st = await api("POST", "/match", { uid: s.uid, oid: o.oid, patient: { age: ov.age, orig: claimed } }, undefined, at);
        } catch (e) {
          work.commit(at, () => {
            alert("매칭 실패: " + e.message);
            // S4-U5: the refusal keeps the server wording; the panel adds the next step and the Order List is read
            // again, since the server may have refused because the list on this screen was stale.
            noteIdentityCorrection(s.uid, false); refreshOrders();
          });
          return;
        }
        work.commit(at, () => {
          appState[s.uid] = mergeObservedReportState(s.uid, st);
          Object.assign(s, st.ov ?? {}, { matched: "M", ward: st.ward });
          o.matched = "M"; o.studyUid = s.uid;
          // S4-U5: a list answer requested before this match would re-install the unmatched row; drop it and read again.
          commitEpoch++; listLoadSequence++;
          noteIdentityCorrection(s.uid, true); load(); refreshOrders();
          render(); renderOrders(); renderClinical(); renderRelated();
          toast(`매칭 완료 — ${o.name} (${o.id})`);
        });
        return;
      } else {
        a.orig ??= orig; a.ov = ov; a.matched = "M"; a.oid = o.oid;
        Object.assign(s, ov, { matched: "M" });
        o.matched = "M"; o.studyUid = s.uid;
        saveApp(); saveOrders();
      }
      render(); renderOrders(); renderClinical(); renderRelated();
      toast(`매칭 완료 — ${o.name} (${o.id})`);
    }

    async function doUnmatch() {
      const s = cur();
      if (!s || s.matched !== "M") { alert("매칭(M)된 검사를 선택하세요."); return; }
      const a = appState[s.uid] ?? {};

      if (serverMode) {
        const at = work.capture("document");
        let st;
        try {
          st = await api("POST", "/unmatch", { uid: s.uid }, undefined, at);
        } catch (e) {
          work.commit(at, () => {
            alert("매칭 해제 실패: " + e.message);
            noteIdentityCorrection(s.uid, false);
          });
          return;
        }
        work.commit(at, () => {
          appState[s.uid] = { ...mergeObservedReportState(s.uid, st), ov: undefined };
          // S4-U5: back to what the server last read from the DICOM, never to the client-claimed orig. Without
          // those tags the fields stay until the list read below repaints them.
          const read = studyIdentityModel ? KinStudyIdentity.tags(studyIdentityModel, s.uid) : null;
          if (read) Object.assign(s, { id: read.id, name: read.name, sex: read.sex, birth: fmtD(read.birth),
            age: ageOf(fmtD(read.birth), s.date), desc: read.desc });
          s.matched = "U";
          const o = orders.find(x => x.studyUid === s.uid);
          if (o) { o.matched = "U"; o.studyUid = null; }
          commitEpoch++; listLoadSequence++;
          noteIdentityCorrection(s.uid, true); load(); refreshOrders();
          render(); renderOrders(); renderClinical(); renderRelated();
          toast("매칭을 해제했습니다 — 원래 정보로 되돌렸습니다", "info");
        });
        return;
      } else {
        if (a.orig) Object.assign(s, a.orig);
        delete a.ov; a.matched = "U";
        const o = orders.find(x => x.oid === a.oid);
        if (o) { o.matched = "U"; o.studyUid = null; }
        delete a.oid;
        s.matched = "U";
        saveApp(); saveOrders();
      }
      render(); renderOrders(); renderClinical(); renderRelated();
      toast("매칭을 해제했습니다 — 원래 정보로 되돌렸습니다", "info");
    }

    // ── Verify / Unverify (8.1.3) ──
    function setSs(uid, ss) {
      const s = studies.find(x => x.uid === uid); if (!s) return;
      s.ss = ss;
      appState[uid] = { ...appState[uid], ss };
      saveApp(uid, { ss }); render(); renderClinical();
      if (uid === selectedUid) { loadReport(); updateReportButtons(); }
      toast(ss === "Verified"
        ? "검사를 확인했습니다 — 판독할 수 있습니다"
        : "확인을 해제했습니다 — Unverified로 표시되고 판독이 잠깁니다 (응급 제외)", "info");
    }
    $("#t-verify").addEventListener("click", () => selectedUid ? setSs(selectedUid, "Verified") : alert("검사를 선택하세요."));
    $("#t-unverify").addEventListener("click", () => selectedUid ? setSs(selectedUid, "Unverified") : alert("검사를 선택하세요."));

    // ── 장비 수신 ──
    // 예전엔 여기 "장비 수신 시뮬" 버튼이 있었다. localStorage에 가짜 행을 만들 뿐이라
    // 영상도 없고 서버도 몰랐다 — 화면에만 있는 검사였다.
    //
    // 지금은 진짜 장비가 진짜 프로토콜로 보낸다: scripts/send_cstore.py 가
    // DICOM Association을 맺고 C-STORE로 Orthanc(4242)에 인스턴스를 밀어넣는다.
    // 그러면 서버의 검사 목록에 새 검사가 생기고, 아래 폴링이 그걸 집어온다.
    //     python3 send_cstore.py --institution "한림병원"
    // 도착 검사는 Radiology에 촬영중으로 보이고, 비응급은 Verify 뒤에 판독할 수 있다.

    // ── Modify Exam (8.1.2.1.5) ──
    function openModify() {
      const s = cur();
      if (!s) { alert("검사를 선택하세요."); return; }
      if (s.rs !== "W") { alert("판독 전(RS: W)인 검사만 수정할 수 있습니다.\n현재 RS: " + s.rs); return; }
      $("#m-id").value = s.id; $("#m-name").value = s.name; $("#m-sex").value = s.sex || "O";
      $("#m-birth").value = s.birth; $("#m-desc").value = s.desc; $("#m-ward").value = s.ward;
      $("#m-guidance").hidden = true; $("#m-guidance").textContent = "";
      $("#modal").classList.add("show");
    }
    $("#m-cancel").addEventListener("click", () => $("#modal").classList.remove("show"));
    /**
     * S4-U5 Modify Exam save. With a server, nothing is painted, stored locally or announced before the PATCH answer:
     * a refusal leaves the row as it was and the modal open with what was typed, plus the server's own words (toast)
     * and the next step; an accepted answer repaints the row from the server's overlay through applyState. The local
     * (no server) path is the previous behavior.
     */
    async function saveModify(event) {
      const s = cur(); if (!s) return;
      const uid = s.uid, button = event.currentTarget;
      const a = appState[uid] ??= {};
      const birth = $("#m-birth").value.trim();
      const ov = {};
      for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) ov[key] = a.ov[key];
      Object.assign(ov, {
        id: $("#m-id").value.trim(), name: $("#m-name").value.trim(), sex: $("#m-sex").value,
        birth, age: ageOf(birth, s.date), desc: $("#m-desc").value.trim(), ward: $("#m-ward").value.trim() });
      if (serverMode || offline) {
        const guidance = $("#m-guidance");
        guidance.hidden = true; guidance.textContent = "";
        button.disabled = true;
        const at = work.capture("document");
        let ok = false;
        // 이 저장이 잠근 단추는 이 저장이 푼다(자기 것만).
        try { ok = await saveApp(uid, { ov }) === true; } finally { button.disabled = false; }
        work.commit(at, () => {
          if (!ok) {
            if (!serverMode) return;
            noteIdentityCorrection(uid, false);
            guidance.textContent = window.KinStudyIdentity?.guidance(appState[uid]?.rs ?? "W", true, s.tele === true) ?? "";
            guidance.hidden = !guidance.textContent;
            return;
          }
          const row = studies.find(x => x.uid === uid);
          if (row) applyState(row);
          noteIdentityCorrection(uid, true);
          modified();
        });
        return;
      }
      a.orig ??= { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      a.ov = ov;
      Object.assign(s, a.ov);
      saveApp(uid, { ov: a.ov });
      modified();
      function modified() {
        $("#modal").classList.remove("show");
        render(); renderClinical(); renderRelated(); renderOrders();
        toast("검사 정보를 수정했습니다");
        // An older list answer would still carry the previous overlay; drop it and read the list again.
        if (serverMode) { commitEpoch++; listLoadSequence++; load(); }
      }
    }
    $("#m-save").addEventListener("click", saveModify);
    $("#t-modify").addEventListener("click", openModify);

    // ── Delete (8.1.2.1.8) ──
    async function doDelete(uid) {
      const s = studies.find(x => x.uid === uid); if (!s) return;
      if (s.rs !== "W") { alert("RS가 W(Wait)인 검사만 삭제할 수 있습니다."); return; }
      // 영상 자체(Orthanc)를 지우는 것은 아직 안 한다. 되돌릴 수 없는 동작이라
      // 권한·감사로그·연쇄 해제를 갖춰야 한다 (교훈 §5). 지금 지울 수 있는 건
      // "영상에 대한 사람의 결정"뿐이고, 그러면 다음 목록 조회 때 그 검사는
      // **막 도착한 검사처럼 다시 나타난다.** 그게 이 동작의 진짜 의미다.
      if (!confirm(`이 검사의 판독 상태·매칭 기록을 지웁니다.\n${s.name} (${s.id}) ${s.date}\n` +
                   `영상은 남고, 검사는 방금 도착한 것처럼 다시 나타납니다. 계속할까요?`)) return;
      // 서버가 거절했는데 화면부터 지우면 검사가 사라진 것처럼 거짓말한다.
      // 응답을 기다려야 판독 이력·다른 사람의 초안 때문에 거절된 이유도 메뉴의 catch가 보여준다.
      const at = work.capture("document");
      if (serverMode) await api("DELETE", `/studies/${encodeURIComponent(uid)}`, undefined, undefined, at);
      else saveApp();
      work.commit(at, () => {
        studies = studies.filter(x => x.uid !== uid);
        delete appState[uid];
        if (selectedUid === uid) {
          markSelectionChanged(null);
          relatedUid = null;
          relatedReportSeq += 1;
          clearRelatedReport();
          refreshRight();
        }
        render();
        toast("검사를 삭제했습니다", "info");
      });
    }

    // ── Report ──
    let relatedReportSeq = 0;

    function clearRelatedReport(message = "Related Exam을 선택하세요") {
      $("#prior-report-meta").textContent = "";
      $("#prior-report-meta").title = "";
      $("#prior-report-status").textContent = message;
      $("#prior-report-status").style.display = "";
      $("#prior-report-content").style.display = "none";
      for (const id of ["#prior-findings", "#prior-conclusion", "#prior-recommendation"])
        $(id).textContent = "";
    }

    /**
     * Related에서 고른 검사는 승인 판독문만 열람한다.
     *
     * 목록 응답의 `state`에도 현재 Report가 있지만 내 초안이 함께 올 수 있다. 그 값을 그대로
     * 그리면 prior의 미확정 초안이 "이전 판독문"으로 보인다. 이미 쓰는 이력 조회 경로에서
     * approve/addendum 판만 골라 읽어야 읽기 전용의 의미가 맞는다.
     */
    async function loadRelatedReport() {
      const s = relatedStudy();
      if (!s) { clearRelatedReport(); return; }
      const uid = s.uid;
      const currentUid = selectedUid;
      const seq = ++relatedReportSeq;
      // 이 읽기의 답·실패가 이전 판독문 칸에 닿는 자리는 이 읽기를 시작한 문맥과 요청 번호·선택을 함께 지난다.
      const at = work.capture("study");
      const stale = () => !work.admits(at) || seq !== relatedReportSeq || uid !== relatedUid || selectedUid !== currentUid;
      $("#prior-report-meta").textContent = relatedReportMeta(s);
      $("#prior-report-meta").title = $("#prior-report-meta").textContent;
      $("#prior-report-status").textContent = s.rs === "A" ? "승인 판독문 불러오는 중…" : "판독문 없음";
      $("#prior-report-status").style.display = "";
      $("#prior-report-content").style.display = "none";

      let report = null;
      try {
        if (serverMode && s.rs === "A") {
          const list = await api("GET", `/studies/${encodeURIComponent(uid)}/report/versions`, undefined, undefined, at);
          if (stale()) return;
          report = list.find(v => v.action === "addendum" || v.action === "approve") ?? null;
        } else if (!serverMode && s.rs === "A") {
          // 서버가 없는 데모에서는 이력 API가 없으므로 확정본만 사용한다. draft는 절대 고르지 않는다.
          const r = appState[uid] ?? {};
          report = {
            findings: r.findings, conclusion: r.conclusion, recommendation: r.recommendation,
            author: r.repDoc,
          };
        }
      } catch (e) {
        if (stale()) return;
        $("#prior-report-status").textContent = `판독문 조회 실패: ${e.message}`;
        return;
      }
      if (stale()) return;
      if (!report) { $("#prior-report-status").textContent = "판독문 없음"; return; }
      $("#prior-report-meta").textContent =
        `${relatedReportMeta(s)} · 판독의 ${displayActor(report.author) || "-"}`;
      $("#prior-report-meta").title = $("#prior-report-meta").textContent;
      $("#prior-findings").textContent = report.findings ?? "";
      $("#prior-conclusion").textContent = report.conclusion ?? "";
      $("#prior-recommendation").textContent = report.recommendation ?? "";
      $("#prior-report-status").style.display = "none";
      $("#prior-report-content").style.display = "";
    }

    function returnToReportStudy() {
      if (!cur() || !relatedUid) return;
      // 같은 판독 행 재선택은 의도적으로 무동작이다. 영상만 돌아가려다 판독문을 재로딩하거나 점유를 풀면 안 된다.
      relatedUid = null;
      ++relatedReportSeq;
      clearRelatedReport();
      renderClinical(); renderRelated(); renderThumbs(); renderTemplates();
      $("#related-current").focus({ preventScroll: true });
    }

    function previewRelated(uid) {
      const current = cur();
      const target = studies.find(s => s.uid === uid);
      if (!current || !target || target.uid === current.uid || !current.sourcePatientKey ||
          target.sourcePatientKey !== current.sourcePatientKey) return;
      // 같은 prior를 다시 고르는 것은 이동이 아니다. 행을 다시 만들면
      // 뒤따르는 dblclick이 떼어진 옛 행에 떨어져 목록 리스너에 도달하지 않는다.
      if (uid === relatedUid) return;
      relatedUid = uid;
      renderClinical(); renderRelated(); renderThumbs(); renderTemplates(); loadRelatedReport();
    }

    /**
     * ── 기준 판(baseVersion)의 출처 ──
     *
     * `baseVersion`은 "내가 **화면에서 본** 판"이어야 한다. 그런데 `appState[uid].version`은
     * 본문을 다시 그리지 않고도 올라간다 — PATCH 응답 한 번이면 충분하다(`:1175`).
     * 그 값을 확정에 실어 보내면 서버의 낙관적 락은 통과하고, 내가 읽은 적 없는
     * 승인본이 내 초안으로 대체된다. 그래서 **textarea에 값을 실제로 넣은 순간의**
     * 판 번호만 여기에 남기고, 초안 저장·확정은 그 값을 쓴다.
     *
     * 초안을 그렸다면 기준은 그 초안이 딛고 선 판이다. 화면에 있는 글자의 출처가
     * 확정본이 아니라 초안이기 때문이다.
     */
    /**
     * S3-U6: **사람이 커서를 둔 적이 있는 칸**의 이름들.
     *
     * 커서 자리 자체는 브라우저가 이미 들고 있다 — textarea는 초점을 잃어도 자기
     * `selectionStart/selectionEnd`를 유지하므로 화면이 사본을 두면 그 사본만 낡는다.
     * 화면이 기억할 것은 하나뿐이다: **그 칸을 짚은 적이 있는가.** 한 번도 초점을 받지 않은
     * 칸도 `0`을 답하는데, 그 `0`은 "맨 앞을 가리킨다"가 아니라 "자리가 없다"이기 때문이다.
     * 그 둘을 구별하지 못하면 커서를 둔 적 없는 칸의 **맨 위**에 문장이 들어간다.
     *
     * 잊는 자리는 둘뿐이다 — 검사 선택이 바뀔 때(아래)와 `loadReport`가 그 칸의 값을 실제로
     * 갈아끼울 때. 그 밖에는 잊지 않는다: 같은 값 재대입은 캐럿을 옮기지 않는다.
     */
    const caretFields = new Set();
    function noteCaret(field) { caretFields.add(field); }
    function forgetCaret(field) { caretFields.delete(field); }
    function caretAt(field) {
      if (!caretFields.has(field)) return null;
      const el = $("#" + field);
      return el ? { start: el.selectionStart, end: el.selectionEnd } : null;
    }
    function markSelectionChanged(uid) {
      selectedUid = uid;
      // 선택 순번은 이 문서의 관문이 센다 — 검사 범위의 작업 문맥이 같은 값을 본다(A→B→A도 같은 선택이 아니다).
      selectionSeq = work.select(uid);
      // 커서 자리는 그 검사의 그 글에 대한 것이다. A→B→A도 같은 화면이 아니다.
      caretFields.clear();
      // 그 검사를 열었다 — 떠나 있는 동안 남겨 둔 안내는 이제 그 검사의 초안 표시줄이 이어받는다.
      dropLeftNote(uid);
    }

    /**
     * 떠난 검사에 대한 안내(U5CLI-F13). 확정이 나가 있는 동안 글을 더 치고 다른 검사로 옮겼다면, 그 확정이 싣지 않은 글이
     * 있다는 사실을 말할 자리가 지금 화면에는 없다 — 초안 표시줄은 고른 검사의 것이고, 토스트는 사라진다. 놓치면 그 문장은
     * 승인본에도 없고 다시 상기되지도 않는다. 그래서 이 안내는 사람이 닫거나(Dismiss) 그 검사를 열 때까지 남는다. 뒤에 친
     * 글이 없는 평소 경로에는 생기지 않고, Log out에 묻는 것을 더하지도 않는다 — 그 글은 초안으로 남아 평소처럼 저장된다.
     */
    const leftNotes = new Map();
    function renderLeftNotes() {
      $("#leftnotes").replaceChildren(...[...leftNotes].map(([uid, text]) => {
        const row = document.createElement("div"), message = document.createElement("span");
        const open = document.createElement("button"), dismiss = document.createElement("button");
        row.className = "leftnote";
        message.textContent = text;
        open.type = dismiss.type = "button";
        open.textContent = "Open Study";
        dismiss.textContent = "Dismiss";
        // 목록에 없는 검사는 여기서 열 수 없다(목록 조건이 바뀌었다) — 눌리지 않는 단추에 그 까닭을 적는다.
        open.disabled = !studies.some(s => s.uid === uid);
        if (open.disabled) open.title = "이 검사는 지금 목록에 없습니다. 목록 조건을 바꾼 뒤 여세요.";
        open.addEventListener("click", () => { if (studies.some(s => s.uid === uid)) select(uid); else renderLeftNotes(); });
        dismiss.addEventListener("click", () => dropLeftNote(uid));
        row.append(message, open, dismiss);
        return row;
      }));
    }
    function noteLeftStudy(uid, text) { leftNotes.set(uid, text); renderLeftNotes(); }
    function dropLeftNote(uid) { if (leftNotes.delete(uid)) renderLeftNotes(); }

    const reportOrigin = new Map();
    function recordReportOrigin(uid, version) {
      if (!uid) return;
      reportOrigin.set(uid, Number.isSafeInteger(version) && version >= 0 ? version : 0);
    }
    function reportBaseVersion(uid, fallback) {
      return reportOrigin.has(uid) ? reportOrigin.get(uid) : fallback;
    }
    function renderedOrigin(r) {
      if (!r) return 0;
      const d = r.prelimHidden ? null : r.draft;
      return (d ? d.baseVersion ?? r.version ?? 0 : r.version ?? 0);
    }

    /**
     * 확정 실패를 어떻게 다룰 것인가.
     *
     * 예전엔 메시지의 부분 문자열(`저장했습니다`) 하나로 갈랐다. 그 분기는 서버 판독문을
     * 다시 불러와 화면을 덮으므로, 같은 문구를 쓰는 새 거절이 생기면 저장 안 된 입력이
     * 사라진다. **코드를 먼저 본다** — 문구는 안내문이고 코드가 계약이다.
     */
    function commitFailureRoute(e) {
      if (e?.code === "REPORT_HELD") return "held";
      if (e?.code === "REPORT_DRAFT_STALE") return "stale";
      if (String(e?.message ?? "").includes("저장했습니다")) return "reload";
      return "toast";
    }

    /**
     * 거절 본문에 실려 온 승인본. **서버가 잠근 행에서 그대로 온 다섯 칸만** 믿는다.
     * `appState`의 본문은 폴링이 판 번호만 올려둔 낡은 사본일 수 있고, 사람이 확인해야
     * 하는 것은 바로 그 낡음의 반대편이다. 모양이 아니면 아무것도 보여주지 않는다 —
     * 잘못 만든 문자열을 "승인된 판독문"이라고 보여주는 것이 제일 나쁘다.
     */
    function staleHeadOf(e) {
      const h = e?.body?.head;
      if (!h || typeof h !== "object") return null;
      if (!Number.isSafeInteger(h.version) || h.version <= 0) return null;
      const text = v => (typeof v === "string" ? v : "");
      return { version: h.version, updatedBy: typeof h.updatedBy === "string" ? h.updatedBy : "",
        findings: text(h.findings), conclusion: text(h.conclusion), recommendation: text(h.recommendation),
        draftBaseVersion: Number.isSafeInteger(e?.body?.draftBaseVersion) ? e.body.draftBaseVersion : null };
    }

    /**
     * 지금 화면에 있어야 할 판독문의 출처.
     *
     * 초안이 있으면 초안, 없으면 확정본. **초안은 내 것뿐이다** — 서버가 남의 초안을
     * 안 보내준다. 초안은 아직 진술이 아니고, 남이 쓰고 있다는 사실은 점유 표시가 말한다.
     */
    function reportSource() {
      const r = appState[selectedUid] ?? {};
      return r.draft ?? r;
    }

    let reportRefreshPendingFor = null;
    function loadReport({ force = false } = {}) {
      /**
       * 판독문을 그리는 함수가 **스스로** 저장 안 된 입력을 덮지 않는다.
       * Refresh·Home·재연결처럼 호출자가 늘 때마다 바깥에 가드를 하나씩 달면
       * 다음 호출 지점이 또 빠진다. 정말 덮어야 하는 생애주기 전환만 force로 밝힌다.
       *
       * 단, 보호하는 것은 textarea의 **값뿐**이다. 잠금·권한까지 함께 건너뛰면
       * 다른 사람이 Prelim으로 넘긴 뒤에도 계속 쓸 수 있는 화면이 남는다.
       * "무엇이 들어 있는가"와 "지금 쓸 수 있는가"는 서로 다른 상태다.
       */
      const r = appState[selectedUid] ?? {};
      // 예비 판독(RS=P) 중이고 내가 지정된 사람이 아니면 서버가 내용을 안 준다.
      // 이때 빈 칸을 그대로 보여주면 "판독문이 없다"로 읽힌다 — 없는 것과 못 보는 것은 다르다.
      const locked = !!r.prelimHidden;
      if (locked) reportPreview.close();
      // 자동 저장된 내 초안은 DOM과 같아 dirty가 아니어도, 잠금 전환이 그 글을 지워서는 안 된다.
      const preserveValue = !force && (reportConverge.has(selectedUid) || (locked && !!r.draft));
      reportRefreshPendingFor = preserveValue && (locked || reportDirty()) ? selectedUid : null;
      const src = locked ? {} : reportSource();
      // 값을 실제로 넣는 이 호출만이 기준 판을 바꾼다. 입력을 보존하는 호출(폴링·잠금
      // 전환)은 화면의 글자를 그대로 두므로 그 글자가 딛고 선 판도 그대로다.
      if (!preserveValue) {
        recordReportOrigin(selectedUid, renderedOrigin(r));
        // 이 글이 딛고 선 초안 revision도 같은 자리에서 정한다: 다음 초안 쓰기·확정은 "화면이 본 그 초안 위에서"만 통과한다.
        // 화면에 보인 초안은 이 문서가 본 원문으로 기억된다 — 나중의 충돌이 그 글과의 것이면 사람에게 묻지 않고 이어 간다.
        if (selectedUid && !reportConverge.has(selectedUid))
          draftClient.observe(selectedUid, r.draftRevision, locked ? undefined : r.draft ?? null);
        // 편집기의 글이 바뀐다 — 그 전에 떠난 편집기 범위의 작업(붙여넣기 등)은 이 글 위에 쓰지 않는다.
        work.edited();
      }
      const ph = locked
        ? `${displayActor(r.preReviewer) || "지정된 판독의"} 님이 최종 판독 중입니다 (RS: P) — 내용은 지정된 판독의만 볼 수 있습니다`
        : "";
      for (const [sel, base] of [["#findings", "Please enter findings"],
                                 ["#conclusion", "Please enter conclusion"],
                                 ["#recommendation", "Please enter recommendation"]]) {
        const el = $(sel);
        // S3-U6: 값이 **실제로** 달라졌을 때만 그 칸의 커서 자리를 잊는다. 폴링이 같은 글을
        // 다시 대입하는 것은 화면에서 아무 일도 아니고(명세상 캐럿도 그대로다), 그때까지
        // 잊으면 사람이 짚어둔 자리가 30초마다 사라진다. 비교는 대입 전후의 API 값으로 한다 —
        // 원문과 API 값이 줄 끝에서 다를 수 있으므로 문자열 예측이 아니라 결과를 본다.
        if (!preserveValue) {
          const was = el.value;
          // 서버의 글을 그리는 대입이다(이 문서의 편집이 아니다) — `editReport` 밖의 두 대입 가운데 하나.
          el.value = locked ? "" : (src[sel.slice(1)] ?? "");
          if (el.value !== was) forgetCaret(sel.slice(1));
        }
        el.placeholder = locked ? (sel === "#findings" ? ph : "") : base;
        el.readOnly = !!heldByOther(cur()) || locked || (cur()?.ss === "Unverified" && cur()?.em !== "E") || !KinAuth.has("radiologist");
      }
      renderDraftBar();
      updateReportTemplateButton();
      // 인용 건수·출처·존재 상태는 **관문을 다시 거는 전용 읽기**에서만 온다. 목록·상태
      // 페이로드에는 인용이 실리지 않으므로 여기서 한 번 물어보지 않으면 알 길이 없다.
      ensureCitations(selectedUid);
      // 구조화도 같은 이유로 전용 읽기에서만 온다 — 목록·상태 페이로드에는 실리지 않는다.
      ensureStructure(selectedUid);
      // 초안 쓰기가 실을 유지 목록(서버가 지금 가진 인용·구조화 id 전부)의 기준을 편집기를 그릴 때 미리 알아 둔다 —
      // 탭이 닫히는 순간의 저장은 읽으러 갈 수 없다.
      if (!preserveValue && selectedUid && serverMode && !offline && !demoMode && !locked && KinAuth.has("radiologist"))
        draftClient.prime(selectedUid, { owner: draftOwner, context: work.capture("study") });
      // 이 검사에 결과를 모르는 버리기가 남아 있으면 그 결과부터 안다(다시 그리는 글이 서버의 지금 초안이 되게).
      if (selectedUid && reportUnknownDiscards.has(selectedUid)) learnDiscardOutcome(selectedUid);
    }

    /**
     * 초안 표시줄.
     *
     * 초안을 사람에게 붙이고 나면 화면이 확정본이 아닌 것을 보여줄 수 있게 된다.
     * 그 사실을 말해주지 않으면 사용자는 저장된 것을 보고 있다고 믿는다 —
     * "조용히 갈라지는" 실패가 여기서 다시 생긴다.
     */
    function renderDraftBar() {
      // 인용 줄은 초안과 별개다 — 초안이 없어도 승인본에 이월된 인용은 남아 있다.
      // 아래 분기들이 일찍 빠져나가므로 여기서 먼저 그린다.
      renderCitationBar();
      const bar = $("#draftbar");
      const r = appState[selectedUid] ?? {};
      const d = r.prelimHidden ? null : r.draft;
      const pending = !!selectedUid && reportRefreshPendingFor === selectedUid;
      /**
       * 초안 충돌(S7-U5): 서버에 이 화면이 본 적 없는 다른 초안이 있어(다른 창의 글, 남이 치운 초안) 이 화면의 글을 저장하지
       * 못했다. 같은 글이거나 이 문서의 늦게 닿은 저장이면 프로그램이 이미 이어 갔고 여기 오지 않는다. 자동 저장은 멈춰 있고
       * 글은 화면에 그대로다. 저장된 것처럼도, 서버 것으로 바뀐 것처럼도 보이지 않게 한 줄로 말하고 한 번 고르게 한다.
       */
      const conflict = selectedUid ? draftClient.conflict(selectedUid) : null;
      $("#b-draft-keep").style.display = $("#b-draft-load").style.display = conflict ? "" : "none";
      $("#b-draft-keep").disabled = $("#b-draft-load").disabled = !conflict?.latest;
      /**
       * 승인된 판독문 위에 그 승인본과 다른 내 초안이 있다(U5CLI-F11). 편집기는 그 초안을 보이므로 화면의 글은 승인본이
       * 아니다 — Approve가 나가 있는 동안 더 친 글이든, 추가기재를 쓰다 만 글이든 같다. 이 줄이 그 사실을 말하지 않으면
       * 판독의는 그 문장이 승인된 판독문에 있다고 믿고, 임상의는 그 문장이 없는 승인본을 읽는다. 충돌·서버 새 내용 안내가
       * 먼저다(그때 고를 것은 그쪽이다).
       */
      const apart = !conflict && !pending && reportApart(r);
      $("#b-approved-view").style.display = apart ? "" : "none";
      if (conflict) {
        bar.style.display = "flex";
        $("#b-draft-discard").style.display = $("#b-report-reload").style.display = "none";
        $("#draftmsg").innerHTML = `<b>● 서버의 초안이 이 화면과 다릅니다</b> — 입력한 내용은 그대로 있습니다 · ` +
          (conflict.latest ? `이 화면의 글을 남기려면 Keep This Text, 서버의 초안으로 바꾸려면 Load Server Draft`
                           : `서버의 초안을 확인하지 못했습니다 — 연결되면 다시 확인합니다`);
        return;
      }
      if (!d && !pending && !reportConverge.has(selectedUid)) { bar.style.display = "none"; return; }
      bar.style.display = "flex";
      $("#b-draft-discard").style.display = d ? "" : "none";
      // pending은 초안이 없어도 생긴다. 서버 값과 화면 값이 갈라졌다고 알려놓고
      // 검사 재선택만을 탈출구로 남기지 않는다. 가려진 Prelim에는 불러올 본문이 없으므로 숨긴다.
      $("#b-report-reload").style.display = pending && !r.prelimHidden ? "" : "none";
      if (pending) {
        $("#draftmsg").innerHTML = r.prelimHidden
          ? `<b>● 다른 판독의가 이 검사를 예비 판독으로 넘겼습니다</b> — 쓰던 내용은 그대로 두었지만 저장할 수 없습니다`
          : `<b>● 서버에 새 내용이 있습니다</b> — 저장 안 된 입력은 덮지 않고 그대로 유지했습니다` +
            (d ? ` · 초안 버리기를 누르면 서버 내용으로 돌아갑니다` : ``);
        return;
      }
      // 결과를 모르는 버리기 뒤(아래 reportUnknownDiscards): 이 화면의 글은 저장된 초안도, 버려진 것으로 확인된 것도 아니다.
      if (reportUnknownDiscards.has(selectedUid) && !reportConverge.has(selectedUid)) {
        $("#draftmsg").innerHTML = `<b>● 초안을 버렸는지 아직 확인하지 못했습니다</b> — 서버의 초안을 다시 읽으면 결과를 화면에 반영합니다`;
        return;
      }
      const at = d?.at ? String(d.at).replace("T", " ").slice(0, 16) : "";
      // 내가 이 초안을 쓰기 시작한 뒤 남이 확정을 했다면, 그걸 지금 말해야 한다.
      // 확정 버튼을 누른 다음에야 알게 되면 이미 늦다.
      const behind = reportDraftBehind(r);
      /**
       * 서버로 보내기를 미룬 글은 **저장된 것이 아니다.** 인용이 나가 있는 동안 검사를
       * 옮기면 글자는 여기 담기지만 요청은 그 뒤에 나간다. 그 사이에 "자동 저장됨"이라고
       * 쓰면 저장 안 됐다는 사실을 알려주는 자리가 저장됐다고 말하는 셈이다.
       */
      const deferred = !!selectedUid && reportConverge.has(selectedUid);
      // 서버가 이 검사에 쓸 수 없다고 답해 자동 저장을 멈춘 글이다. 한 번 알린 뒤에는 이 줄이 그 사실을 말한다.
      const stopped = deferred && reportSaveFailures.get(selectedUid) === "stop";
      // 누가 확정했는지는 여기서 알 수 없다 — 내가 누른 Approve가 떠난 뒤의 쓰기도 이 자리에 온다. 아는 사실만 말한다.
      $("#draftmsg").innerHTML =
        (apart ? `<b>● 승인된 판독문에 포함되지 않은 글이 있습니다</b> — 이 화면의 글은 승인본(v${esc(r.version)})과 다릅니다 · `
               : `<b>● 저장 안 된 초안</b> — `) +
        (stopped ? `이 화면에 담아 두었습니다 · 서버가 저장을 받지 않아 자동 저장을 멈췄습니다 — 글을 고치면 다시 시도합니다`
         : deferred ? `이 화면에 담아 두었습니다 · 서버 저장은 아직 확인되지 않았습니다`
                  : `${esc(at)}에 ${apart ? "초안으로 " : ""}자동 저장됨`) +
        (behind ? ` · <b>주의</b> 이 초안을 쓰기 시작한 뒤 v${esc(r.version)}이 확정됐습니다`
                : `<span id="drafthint"></span>`);
      renderDraftHint();
    }

    /**
     * 승인된 판독문과 내 초안이 갈라져 있는가. 기록된 사실만 본다: 그 검사가 승인 상태(RS A)이고, 내 초안이 있고, 그 초안의
     * 세 칸이 승인본의 세 칸과 다르다. 이 문서가 한 일(무엇을 언제 쳤는가)을 보지 않으므로 새로 고침·다른 검사에 다녀옴·
     * 다음 날 다시 열기에서도 같은 답이다. "서버가 아직 확인하지 않은 글" 표시(`reportConverge`)와는 다른 물음이다 —
     * 자동 저장된 초안도 승인본과는 여전히 다르다.
     */
    function reportApart(r) {
      const d = r?.prelimHidden ? null : r?.draft;
      // 편집기(textarea)는 서버 글의 CR LF·CR을 LF로 바꿔 보이고, 그 값이 초안으로 저장된다. 줄 끝만 다른 초안은 승인본과
      // 갈라진 것이 아니다(쳤다 되돌리기만 해도 생긴다) — 편집기와 같은 규칙으로 줄 끝을 모은 뒤 견준다(U5CLI-F12).
      return !!d && r.rs === "A" && RFIELDS.some(k => KinReportCitation.toLf(d[k]) !== KinReportCitation.toLf(r[k]));
    }

    /**
     * 이 초안이 딛고 선 판보다 승인본이 앞서 있는가. 표시줄의 경고와 §6의 인용 거절이
     * **같은 식 하나**를 쓴다 — 둘이 각자 계산하면 언젠가 한쪽만 고쳐진다.
     */
    function reportDraftBehind(r) {
      const d = r?.prelimHidden ? null : r?.draft;
      return !!d && (r.version ?? 0) > (d.baseVersion ?? 0);
    }

    /** 초안 버리기 — 확정본으로 돌아간다 */
    async function discardDraft() {
      const uid = selectedUid;
      if (!uid || !appState[uid]?.draft) return;
      if (!confirm("쓰다 만 초안을 버리고 저장된 판독문으로 돌아갑니다.\n계속할까요?")) return;
      const at = work.capture("document");
      // 버리기를 누른 때까지의 편집 차례(버리기 표시). 답이 올 때 "누른 뒤에 고친 글이 있는가"를 이것으로 안다 — 글을 견주지
      // 않는다. 사람이 버리기로 한 것은 이 차례까지의 글이다.
      const pressedAt = reportEdits;
      let state = { ...appState[uid], draft: null };
      discardsOut += 1;
      try {
        if (serverMode) {
          // 버리기도 초안의 경계를 넘기는 명령이다: 화면이 본 그 초안(revision)일 때만 버려진다.
          // 버리기는 이 문서의 글을 보내는 명령이 아니다: 거절되거나 결과를 모르면 표시는 버리기 전 그대로다(없었으면 없다 —
          // 버리려던 초안을 자동 저장이 되살리지 않는다, U5CLI-F10).
          const result = await draftClient.discard(uid, { owner: draftOwner, context: at });
          if (result.outcome !== "saved") {
            if (result.outcome === "unknown") noteUnknownDiscard(uid, at, pressedAt);
            draftNotSaved(uid, at, result, { converge: false, discard: true });
            return false;
          }
          // 답을 잃었지만 전체 읽기가 초안이 버려졌음을 보인 경우에는 검사 상태가 함께 오지 않는다. 버리기가 바꾸는 것은
          // 초안 행뿐이므로, 이 화면이 아는 상태에서 초안만 없앤 것이 그 상태다.
          state = result.state ?? { ...appState[uid], draft: null, draftRevision: result.envelope.revision };
        }
        return work.commit(at, () => {
          /**
           * **답은 그 요청 뒤에 친 글을 지우지 않는다.** 버리기가 나가 있는 동안 이 문서가 그 검사의 글을 더 고쳤으면(기록된
           * 편집이다) 그 글은 사람이 버리기로 한 글이 아니다. 저장된 판독문으로 다시 그리면 그 글은 편집기에도 서버에도
           * 남지 않고, 떠날 때 묻지도 않는다. 그래서 확정의 답과 같이 다룬다(`applyAcceptedCommit`): 고른 검사면 편집기의
           * 글을 그대로 두고, 떠난 검사면 떠날 때 담아 둔 사본을 지켜, 확인되지 않은 글로 남긴다 — 다음 자동 저장·검사
           * 이동·로그아웃이 초안으로 가져간다. 누른 뒤에 고친 글이 없으면 버리기는 정확히 버리기다: 표시가 내려가고,
           * 버리기 뒤에 줄 서 있던 쓰기(버리기가 나가 있는 동안 검사를 옮겼다)는 차례가 와도 보낼 글이 없다 — 버린 글이
           * 초안으로 되살아나지 않는다.
           */
          const later = reportEditedSince(uid, pressedAt)
            ? (uid === selectedUid ? Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value])) : appState[uid]?.draft) : null;
          appState[uid] = replaceReportState(uid, state, { confirmed: serverMode });
          // 초안 행이 사라지면 그 행의 인용도 함께 사라진다. 머리 판의 인용은 그대로이므로
          // 모르는 상태로 되돌리고 `loadReport`의 전용 읽기가 남은 것을 다시 가져온다.
          citations.forget(uid);
          citationNotes.delete(uid);
          // 구조화 건도 그 행과 함께 사라졌다. 머리 판의 건은 그대로이므로 모르는 상태로
          // 되돌리고 `loadReport`의 전용 읽기가 남은 것을 다시 가져온다.
          structureState.forget(uid);
          structureNotes.delete(uid);
          reportConverge.delete(uid);
          if (later) {
            appState[uid] = { ...appState[uid], draft: { ...Object.fromEntries(RFIELDS.map(k => [k, later[k] ?? ""])),
              baseVersion: reportBaseVersion(uid, state.version ?? 0), at: null } };
            reportConverge.add(uid);
          }
          if (!serverMode) saveApp();
          if (selectedUid === uid) { loadReport({ force: !later }); updateReportButtons(); }
          if (!later) toast("초안을 버렸습니다", "info");
          else toast((uid === selectedUid ? "" : studyLabel(uid) + " — ") + "저장돼 있던 초안은 버렸습니다. Discard Draft를 누른 뒤 입력한 글은 버리지 않았습니다 — " +
            (uid === selectedUid ? "화면에 초안으로 남아 있습니다." : "그 검사를 열면 초안으로 남아 있습니다."), "info", 12000);
        });
      } finally {
        // 이 버리기가 세운 표시는 이 버리기가 내린다(자기 것만). 기다리던 Log out은 위의 답 처리 뒤에 이어 간다.
        discardsOut -= 1;
        wakeIdle();
      }
    }
    $("#b-draft-discard").addEventListener("click", discardDraft);

    /**
     * 결과를 모르는 초안 버리기(S7-U5). DELETE의 답을 잃었고 그 뒤의 확인 읽기도 실패했다 — 서버가 그 초안을 버렸는지
     * 모른다. 이때 "확인되지 않은 글" 표시를 그대로 두면, 서버가 실제로 버렸을 때 다음 자동 저장·검사 이동·Log out 보존이
     * 버리기 전의 글을 초안으로 다시 쓴다(버린 초안의 부활). 그런데 누른 순간까지의 글은 사람이 버리기로 한 글이다 — 서버
     * 행의 결과를 몰라도 이 부분은 이 문서에서 정해진 사실이다. 그래서 누른 뒤에 고친 글이 없으면 표시를 내리고, 결과는
     * 기록해 두었다가 다음에 그 검사의 초안을 성공적으로 읽을 때 알린다(`learnDiscardOutcome`). 답을 잃은 DELETE를
     * "버려짐"으로 확정하지는 않는다 — 닿지 않았으면 서버의 초안은 남아 있다. 누른 뒤에 고친 글이 있으면 그 글은 새 글이다:
     * 표시는 그대로이고 평소처럼 저장된다.
     */
    const reportUnknownDiscards = new Map();
    function noteUnknownDiscard(uid, at, pressedAt) {
      work.commit(at, () => {
        if (reportEditedSince(uid, pressedAt)) return;
        reportConverge.delete(uid);
        reportSaveFailures.delete(uid);
        reportUnknownDiscards.set(uid, { reading: false });
      });
    }
    /**
     * 기록된 결과 모르는 버리기의 결과를 그 검사의 초안 전체 읽기 하나로 안다. 읽지 못하면 기록을 남긴다(다음 자동 저장
     * 주기나 그 검사를 다시 그릴 때 다시 읽는다). 읽었으면 화면을 서버의 지금 초안으로 바꾼다: 초안이 없으면 버려진 것이고,
     * 있으면 버리기가 닿지 않은 것(또는 그 뒤에 쓰인 초안)이다 — 어느 쪽인지 사실대로 알린다. 그 사이 사람이 그 검사의 글을
     * 고쳤으면(표시가 다시 섰다) 그 글이 사람의 글이다: 화면은 건드리지 않고 기록만 지운다.
     * 읽기가 나가 있는 사이 이 문서가 그 검사의 더 새 초안 상태를 확인했으면(누른 뒤에 친 글의 저장) 그 답은 낡은 관측이다
     * (`stale`): 화면에도 기준에도 쓰지 않는다 — 늦게 온 "초안 없음"이 그 뒤에 저장된 글을 지우지 않게. 그때 버리기의
     * 결과는 더 물을 것이 없다: 그 검사의 초안은 이제 확인된 그 저장이다.
     */
    async function learnDiscardOutcome(uid) {
      const known = reportUnknownDiscards.get(uid);
      if (!known || known.reading || !serverMode || offline || demoMode) return;
      const at = work.capture("document");
      known.reading = true;
      let got;
      try { got = await draftClient.read(uid, { context: at }); }
      finally { known.reading = false; }
      work.commit(at, () => {
        if (reportUnknownDiscards.get(uid) !== known || !["read", "stale"].includes(got.outcome) || got.read.uid !== uid) return;
        reportUnknownDiscards.delete(uid);
        if (got.outcome === "stale") {
          console.warn("KIN report draft: a late draft read was older than the state this document has confirmed since; not applied",
            uid, got.read.revision, got.revision);
          return;
        }
        if (reportConverge.has(uid)) return;
        const read = got.read;
        const draft = read.present
          ? { ...Object.fromEntries(RFIELDS.map(k => [k, read.snapshot[k]])), baseVersion: read.snapshot.baseVersion, at: read.updatedAt }
          : null;
        appState[uid] = replaceReportState(uid, { ...appState[uid], draft, draftRevision: read.revision }, { confirmed: true });
        if (uid === selectedUid) { loadReport({ force: true }); updateReportButtons(); }
        toast((uid === selectedUid ? "" : studyLabel(uid) + " — ") + (read.present
          ? "초안이 버려지지 않고 서버에 남아 있습니다 — 그 초안을 보입니다. 버리려면 Discard Draft를 다시 누르세요."
          : "확인하지 못했던 초안 버리기가 서버에서 처리된 것을 확인했습니다 — 초안을 버렸습니다."), "info", 8000);
      });
    }

    /**
     * 초안 충돌을 사람이 정한다(S7-U5 U5S-REQ-17). 여기 오는 것은 프로그램이 스스로 풀지 못한 충돌뿐이다 — 초안 명령
     * 경로가 충돌 때 서버의 지금 초안을 읽어, 같은 글이거나 이 문서의 글이면 묻지 않고 이어 간다. 남은 것(다른 글, 남이 치운
     * 초안)은 한 줄로 알리고 한 번 고르게 한다: 이 화면의 글로 덮어쓰거나(Keep This Text), 서버의 초안을 불러오거나(Load
     * Server Draft). 어느 쪽이든 읽어 온 그 revision을 새 기준으로 삼은 뒤에 한다. 누르는 것이 곧 선택이라 확인창을 더
     * 띄우지 않는다. 서버의 초안을 아직 읽지 못했으면(연결 실패) 여기서 다시 읽는다.
     */
    function openDraftConflict(uid) {
      if (uid === selectedUid) keepReportEditor();
      if (uid === selectedUid) renderDraftBar();
      toast("서버의 초안이 이 화면과 달라 저장하지 않았습니다 — 입력한 내용은 그대로 있습니다. 초안 표시줄에서 고르세요.", "err");
      if (!draftClient.conflict(uid)?.latest) readDraftConflict(uid);
    }
    /** 충돌한 검사의 서버 초안을 다시 읽는다(충돌 때의 읽기가 실패했을 때; 자동 저장 주기가 이어서 부른다). */
    async function readDraftConflict(uid) {
      const at = work.capture("document");
      await draftClient.latest(uid, { owner: draftOwner, context: at });
      work.commit(at, () => { if (uid === selectedUid) renderDraftBar(); });
    }
    $("#b-draft-keep").addEventListener("click", () => {
      const uid = selectedUid;
      if (!uid || !draftClient.conflict(uid)?.latest || reportWriteBlock()) return;
      keepReportEditor();
      if (!draftClient.resolve(uid)) return;
      markConverge(uid);
      renderDraftBar();
      stashReport();
    });
    $("#b-draft-load").addEventListener("click", reloadServerReport);
    $("#b-report-reload").addEventListener("click", reloadServerReport);

    async function reloadServerReport() {
      const uid = selectedUid, at = work.capture("editor");
      if (!uid || appState[uid]?.prelimHidden) return;
      try {
        await draftClient.settled(uid);
        if (!work.admits(at)) return;
        const b = await api("GET", "/bootstrap", undefined, undefined, at);
        work.commit(at, () => {
          appState[uid] = replaceReportState(uid, b.states?.[uid]);
          syncStudy(uid);
          loadReport({ force: true });
          updateReportButtons();
          toast("서버의 판독문을 불러왔습니다", "info");
        });
      } catch (e) { work.commit(at, () => toast("서버 판독문을 불러오지 못했습니다: " + e.message, "err")); }
    }

    /**
     * ── 낡은 초안 재기준 ──
     *
     * 서버가 추가기재를 거절하면서 승인본을 함께 보냈다. 여기서 할 일은 **보여주는 것뿐**이다.
     * 쓰던 글은 한 글자도 건드리지 않고, 다시 불러오기도 하지 않는다. 사람이 승인본을 읽고
     * ① 그 판을 기준으로 다시 잡거나 ② 초안을 버리거나 ③ 닫고 더 고친 뒤 다시 누른다.
     * 병합은 하지 않는다 — 두 판독문을 기계가 섞으면 누구의 진술도 아닌 글이 남는다.
     */
    let staleSeq = 0, stalePane = null, staleBusy = false;
    function openStaleRebase(uid, seq, e) {
      /**
       * **그리기 전에** UID와 선택 순번을 함께 확인한다.
       *
       * 확정 요청이 나가 있는 동안 다른 검사를 고르면 textarea에는 이미 **그 검사의**
       * 판독문이 들어 있다. 거기에 A의 승인본을 나란히 그리면 두 환자의 판독문이
       * 한 비교 화면이 된다 — 아무것도 쓰지 않더라도 그 자체가 오독의 원인이다.
       * A→B→A도 같은 선택이 아니다: 그 사이 화면이 다시 그려졌다.
       */
      if (uid !== selectedUid || seq !== selectionSeq) {
        toast("다른 검사로 옮기기 전에 누른 추가기재가 거절됐습니다 — 승인본이 바뀌었습니다. " +
              "그 검사로 돌아가 다시 확인하세요. 쓰던 내용은 그대로 있습니다.", "err");
        return;
      }
      const head = staleHeadOf(e);
      // 모양이 아니면 아무것도 "승인본"이라고 보여주지 않는다. 그때는 일반 실패로 끝낸다.
      if (!head) { toast("저장 실패: " + e.message, "err"); return; }
      stalePane = { uid, seq: ++staleSeq, selSeq: selectionSeq, head };
      drawApprovedPane(head, {
        title: "Approved Report Changed",
        message: `이 초안은 v${head.draftBaseVersion ?? "?"}을 기준으로 씁니다. 그 뒤 v${head.version}이 승인됐습니다 — ` +
          `아래 승인본을 확인한 뒤 정하세요. 쓰던 내용은 그대로 두었습니다.`,
        mine: "지금 쓰던 내용 (저장되지 않음)", rebase: true });
      toast(`승인본이 v${head.version}으로 바뀌어 추가기재를 붙이지 못했습니다 — 승인본을 확인하세요`, "err");
    }
    /** 승인본(서버가 준 다섯 칸)과 편집기의 지금 글을 나란히 그린다. 두 쓰임(재기준, 승인본 보기)이 같은 창을 쓴다. */
    function drawApprovedPane(head, { title, message, mine, rebase }) {
      $("#stale-title").textContent = title;
      $("#stale-msg").textContent = message;
      $("#stale-head-title").textContent =
        `승인본 v${head.version}` + (head.updatedBy ? ` · ${displayActor(head.updatedBy)}` : "");
      $("#stale-draft-title").textContent = mine;
      for (const k of RFIELDS) {
        $("#stale-head-" + k).textContent = head[k];
        $("#stale-draft-" + k).textContent = $("#" + k).value;
      }
      $("#stale-rebase").style.display = rebase ? "" : "none";
      $("#stale-rebase").textContent = `v${head.version} 기준으로 다시 잡기`;
      $("#stale-rebase").disabled = !rebase;
      $("#stale-status").textContent = "";
      $("#stalemodal").classList.add("show");
    }
    function closeStaleRebase() { stalePane = null; $("#stalemodal").classList.remove("show"); }

    /**
     * ── 승인본 보기 (U5CLI-F11) ──
     *
     * 승인된 판독문 위에 그와 다른 내 초안이 있으면 편집기는 초안을 보인다. 무엇이 승인됐는지를 사람이 **그대로** 볼 수
     * 있어야 한다: 서버의 판 이력에서 지금의 승인 판을 읽어, 재기준 창과 같은 창에 편집기의 글과 나란히 놓는다. 읽기만
     * 한다 — 편집기도 초안도 기준 판도 바꾸지 않는다. 화면이 들고 있는 사본으로 그리지 않는 이유는 재기준 창과 같다:
     * 사람이 확인하려는 것이 바로 "서버에 승인된 것"이다. 그 뒤의 길은 기존 그대로다 — 닫고 Addendum(추가기재),
     * Discard Draft(승인본만 남긴다), 또는 닫고 계속 쓴다.
     */
    async function viewApprovedReport() {
      const uid = selectedUid;
      if (!uid || !reportApart(appState[uid])) return;
      // 답이 올 때도 그때 그 선택이어야 한다(검사 범위의 문맥은 UID와 선택 순번을 함께 본다 — A→B→A도 같은 선택이
      // 아니다). 다른 검사의, 또는 다시 그려진 편집기 옆에 이 승인본을 놓지 않는다.
      const at = work.capture("study");
      let head = null;
      try {
        if (serverMode) {
          const list = await api("GET", `/studies/${encodeURIComponent(uid)}/report/versions`, undefined, undefined, at);
          // 폐기된 초안의 기록은 판독문의 판이 아니다. 남은 것 가운데 가장 새 판이 지금의 승인본이어야 한다.
          const top = (Array.isArray(list) ? list : []).filter(v => v?.action !== "discarded")
            .sort((a, b) => b.version - a.version)[0];
          if (top && Number.isSafeInteger(top.version) && ["approve", "addendum"].includes(top.action))
            head = { version: top.version, updatedBy: typeof top.author === "string" ? top.author : "",
              ...Object.fromEntries(RFIELDS.map(k => [k, typeof top[k] === "string" ? top[k] : ""])) };
        } else {
          // 서버 없는 모드에는 이력이 없다 — 이 브라우저의 저장본이 곧 승인본이다.
          const a = appState[uid];
          head = { version: a.version ?? 0, updatedBy: "", ...Object.fromEntries(RFIELDS.map(k => [k, a[k] ?? ""])) };
        }
      } catch (e) {
        work.commit(at, () => toast("승인본을 불러오지 못했습니다: " + e.message, "err"));
        return;
      }
      work.commit(at, () => {
        // 승인본이 아닌 것을 "승인본"이라고 보여 주지 않는다(그 사이 판독이 취소됐거나 이력을 읽을 수 없다).
        if (!head) { toast("승인본을 확인하지 못했습니다 — 목록을 새로 고친 뒤 다시 확인하세요", "err"); return; }
        stalePane = { uid, seq: ++staleSeq, selSeq: selectionSeq, head, view: true };
        drawApprovedPane(head, {
          title: "Approved Report",
          message: `왼쪽이 승인된 판독문(v${head.version})입니다. 오른쪽은 지금 이 화면의 글이고, 승인된 판독문에 포함되지 않았습니다.` +
            ($("#b-addendum").disabled ? `` : ` 승인본에 덧붙이려면 닫고 More ▸ Addendum을 누르세요.`),
          mine: "이 화면의 글 (승인본에 포함되지 않음)", rebase: false });
      });
    }
    $("#b-approved-view").addEventListener("click", viewApprovedReport);

    async function rebaseDraft() {
      const pane = stalePane;
      // 승인본 보기로 연 창에는 다시 잡을 기준이 없다(단추도 없다).
      if (!pane || pane.view || staleBusy) return;
      // 화면에 쓰기 직전에 UID와 순번을 함께 확인한다. 안내가 열린 사이에 검사를 옮겼다면
      // 지금 textarea에 있는 글은 **다른 검사의 글**이다 (교훈: A→B→A — 돌아와도 같은 선택이 아니다).
      if (pane.uid !== selectedUid || pane.seq !== staleSeq || pane.selSeq !== selectionSeq) {
        $("#stale-status").textContent = "검사가 바뀌었습니다 — 이 안내를 닫고 다시 확인하세요.";
        $("#stale-rebase").disabled = true;
        return;
      }
      const why = reportWriteBlock();
      if (why) { $("#stale-status").textContent = why; return; }
      const next = Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value]));
      // 빈 초안은 행을 지운다(서버 규칙). 기준을 잡을 대상이 없다.
      if (RFIELDS.every(k => !next[k])) {
        $("#stale-status").textContent = "내용이 비어 있어 기준을 잡을 수 없습니다.";
        return;
      }
      staleBusy = true;
      $("#stale-rebase").disabled = true;
      $("#stale-status").textContent = "기준을 다시 잡는 중…";
      /**
       * **화면에 보인 그 판 번호 그대로** 보낸다. 그 사이 승인본이 또 올라갔더라도
       * 여기서 따라 올리지 않는다 — 사람이 본 적 없는 판을 기준으로 삼는 것이
       * 애초에 이 단위가 막는 일이다. 다음 추가기재가 새 승인본을 다시 보여준다.
       * 다른 초안 쓰기와 같은 명령 경로다(작성자·초안 revision·전체 원문): 답은 이 재기준을 누른 그 선택일 때만 화면에 쓴다.
       */
      const at = work.capture("study");
      const result = await draftClient.write(pane.uid, { ...next, baseVersion: pane.head.version },
        { owner: draftOwner, context: at });
      // 이 재기준이 건 대기 표시와 잠근 단추는 이 재기준이 푼다(자기 것만).
      staleBusy = false;
      if (stalePane === pane) $("#stale-rebase").disabled = false;
      if (result.outcome !== "saved") {
        work.commit(at, () => { $("#stale-status").textContent = "기준을 다시 잡지 못했습니다: " + draftFailureText(result); });
        draftNotSaved(pane.uid, at, result, { quiet: true });
        return;
      }
      work.commit(at, () => {
        // 서버에 남은 것은 이 검사의 초안이다. 화면 갱신은 지금 그 검사·그 안내일 때만 한다.
        const a = appState[pane.uid] ?? {};
        appState[pane.uid] = { ...a, draftRevision: result.envelope.revision };
        if (RFIELDS.every(k => (a.draft ?? a)[k] === next[k])) {
          appState[pane.uid].draft = { ...next, baseVersion: pane.head.version, at: new Date().toISOString() };
          recordReportOrigin(pane.uid, pane.head.version);
          reportConverge.delete(pane.uid);
        }
        if (pane.seq !== staleSeq) return;
        closeStaleRebase();
        if (selectedUid === pane.uid) renderDraftBar();
        toast(`v${pane.head.version} 기준으로 다시 잡았습니다 — 내용을 확인하고 Addendum을 누르세요`, "ok");
      });
    }
    $("#stale-close").addEventListener("click", closeStaleRebase);
    $("#stale-rebase").addEventListener("click", rebaseDraft);
    $("#stale-discard").addEventListener("click", async () => {
      // 기존 출구 그대로다. 버리는 것은 여전히 사람이 명시로 고르는 일이고 확인창도 그대로다.
      const uid = stalePane?.uid;
      if (!uid || uid !== selectedUid || stalePane.selSeq !== selectionSeq) { closeStaleRebase(); return; }
      const at = work.capture("study");
      await discardDraft();
      work.commit(at, () => { if (!appState[uid]?.draft) closeStaleRebase(); });
    });
    /** 지금 textarea 내용이 마지막으로 저장된 것(초안이 있으면 초안)과 다른가 */
    function reportDirty() {
      if (!selectedUid) return false;
      const src = reportSource();
      return RFIELDS.some(k => (src[k] ?? "") !== $("#" + k).value);
    }

    /**
     * ── 소견 인용 (S3-U2b) ──
     *
     * Image Findings의 한 출처를 판독문에 넣는다. 순서가 계약이다: **서버가 먼저**
     * 문장과 증언을 한 쓰기로 기록하고, 200을 받은 **뒤에야** 화면의 글자가 바뀐다.
     * 거절·오프라인·비서버 모드에서는 판독문을 한 글자도 건드리지 않는다 — 증언 없는
     * 문장을 만들지 않기 위해서다.
     *
     * 인용 집합은 `appState[uid].draft` **바깥**에 산다. 초안 객체는 저장할 때마다
     * 새로 만들어지고 서버 투영이 통째로 갈아끼우므로, 그 안에 두면 조용히 사라진다.
     * 그리고 **사라진 것과 아직 모르는 것은 다르다** — 모르면 `citationIds` 키를 아예
     * 보내지 않는다. `[]`는 "내 초안의 인용을 전부 지워라"라는 뜻이기 때문이다.
     */
    const citations = KinReportCitation.createState();
    /** 이 검사의 전용 읽기를 실제로 시도했는가 / 그 결과 안내 문구. */
    const citationReads = new Map(), citationNotes = new Map();
    let citationListOpen = false;

    /**
     * 검사마다 하나의 사실: **이 문서에 서버가 아직 확인하지 않은 글이 있다.** 글을 비교해 짐작하지 않고 이 문서가 한 일로만
     * 세운다 — 편집기의 글을 바꿨거나(`recordReportEdit`: 사람의 타건과 `editReport`), 그 글을 싣고 나간 쓰기가 있다(초안
     * 명령 경로의 `onWrite`: write·preserve·writeOnUnload). 서버에서 온 글(목록·폴링·bootstrap·다른 탭의 저장)과 버리기·
     * 확정 명령은 세우지 않는다. 내리는 것은 지금의 글 그대로를 서버가 확인했을 때와 사람이 서버 것을 골랐을 때·버렸을 때뿐이다.
     * 자동 저장·로그아웃 보존·떠나기 경고·폴링의 입력 보호가 모두 이 표시 하나만 본다.
     */
    const reportConverge = new Set();
    /**
     * 자동 저장이 실패한 검사와 그 뒤에 할 일. 같은 글을 20초마다 다시 보내 같은 실패를 다시 알리지 않는다: 처음 한 번만
     * 알린다. 서버가 그 검사에 쓸 수 없다고 답한 거절(4xx — 권한·기관 이동으로 목록에서 사라진 검사 등)은 다시 보내도 같은
     * 답이므로 자동 저장을 멈추고("stop"), 지나갈 수 있는 실패(5xx·결과 모름)는 조용히 다시 해 본다("retry"). 글과 표시는
     * 어느 쪽이든 그대로다 — Log out과 떠나기 경고는 표시만 보므로 그 글을 그대로 묻는다. 그 검사의 글이 다시 바뀌거나,
     * 저장이 확인되거나, 연결이 되살아나면 지운다.
     */
    const reportSaveFailures = new Map();
    function markConverge(uid) {
      if (!uid) return;
      reportConverge.add(uid);
      if (uid === selectedUid) renderDraftBar();
    }
    /** Only this document's recorded edits/commands can require a write. */
    function reportNeedsWrite() {
      return !!selectedUid && reportConverge.has(selectedUid);
    }
    /**
     * 삽입(인용·구조화)이 싣고 나가는 글은 지금 글에 넣을 문장을 더한, 아직 화면에 없는 글이다. 그 쓰기도 표시를 세운다
     * (답을 기다리는 동안 폴링이 편집기를 다시 그리지 않게 한다). 그런데 서버가 그 삽입을 기록하지 않았다고 분명히 답했고
     * (거절), 삽입을 누른 뒤로 편집기가 그대로이며, 삽입 전에 표시가 없었으면 — 이 문서에 확인되지 않은 글은 여전히 없다.
     * 그때 표시를 남기면 고치지 않은 검사의 저장된 판독문이 20초 뒤 초안으로 보내진다(U5CLI-F10과 같은 부류).
     * `pristineEditor`는 삽입을 보내기 전에 "표시가 없는 지금의 편집기"를 잡고(표시가 있으면 null), `insertLeftNoText`는
     * 실패한 삽입이 그 상태를 그대로 두었는지를 답한다. 결과를 모르는 삽입(서버에 닿았을 수 있다)과 충돌은 표시를 남긴다.
     */
    function pristineEditor(uid) {
      return uid === selectedUid && !reportConverge.has(uid) ? work.capture("editor") : null;
    }
    function insertLeftNoText(pristine, result) {
      return !!pristine && work.admits(pristine)
        && (result.outcome === "owner" || (result.outcome === "refused" && result.answer?.status !== 503));
    }

    /**
     * 폴링이 한 검사의 상태를 합칠 때 **화면 것을 지켜야 하는 칸**. 규칙은 여기 하나뿐이고
     * 폴링의 세 자리가 모두 이것을 쓴다 — 세 곳이 각자 판단하면 언젠가 한 곳만 고쳐진다.
     *
     *   version — 고른 검사에 로컬 편집이 있으면 그 글이 딛고 선 판을 지킨다.
     *   draft  — 아직 서버에 보내지 못한 글. 삽입이 나가 있는 동안 검사를 옮기면 그 타건은
     *     **여기에만** 담겨 있고(쓰기는 미뤘다), 폴링이 서버 투영으로 갈아끼우면 사람이 친
     *     글이 어디에도 남지 않는다. 그래서 수렴 표시가 있는 검사는 고르지 않았어도 지킨다.
     *     수렴이 끝나 표시가 내려간 뒤에는 평소처럼 서버 투영을 받는다.
     */
    function preservedLocal(uid, mine) {
      const local = {};
      if (reportConverge.has(uid)) {
        if (uid === selectedUid) local.version = mine?.version ?? 0;
        local.draft = mine?.draft ?? null;
        // 초안과 그 revision은 한 쌍이다. 화면의 초안을 지키면서 revision만 폴링의 것으로 바꾸면, 본 적 없는 서버 초안을
        // 기준으로 쓰게 된다.
        local.draftRevision = mine?.draftRevision;
        local.draftEpoch = mine?.draftEpoch;
      }
      return local;
    }
    /** 폴링 응답 한 건을 그 검사의 화면 상태에 합친다. 가려진 예비 판독은 서버가 본문을 안 준다. */
    function mergeObservedReportState(uid, st) {
      // An observation can update an idle document, including its draft command baseline.
      const mine = appState[uid] ?? {};
      if (!reportConverge.has(uid) && st)
        draftClient.observe(uid, st.draftRevision, st.prelimHidden ? undefined : st.draft ?? null);
      return { ...mine, ...st, ...preservedLocal(uid, mine) };
    }

    /**
     * A person's server choice (or confirmed discard/commit) replaces all report baselines together.
     *
     * 읽어 온 상태로 바꾸는 선택(Load Server Draft·Reload Report·최신 불러오기)은 초안 명령 경로의 기준도 함께 바꿔야 하므로
     * 그 검사에 나가 있는 명령이 없을 때만 된다. `confirmed`는 확정·버리기의 답이다: 그 명령이 기준을 이미 그 상태로 옮겼고
     * 뒤에 줄 선 명령은 그 위에서 나간다 — 서버가 받아들인 확정을 여기서 실패로 바꾸지 않는다.
     */
    function replaceReportState(uid, st, { confirmed = false } = {}) {
      const rebased = !!st && (demoMode || draftClient.replace(uid, st.draftRevision, st.draft ?? null));
      if (!st || (!rebased && !confirmed))
        throw new Error("서버 판독문의 기준을 확인하지 못했습니다. 다시 불러오세요.");
      reportConverge.delete(uid);
      reportSaveFailures.delete(uid);
      recordReportOrigin(uid, renderedOrigin(st));
      citations.forget(uid); citationNotes.delete(uid);
      structureState.forget(uid); structureNotes.delete(uid);
      return { ...appState[uid], ...st, draft: st.draft ?? null };
    }

    /** 삽입이 나가 있는 동안의 비-keepalive 초안 저장을 **전부** 비켜세운다(B1). */
    let insertInFlight = false;
    /**
     * 나가 있는 초안 버리기의 수. 버리기의 답도 화면의 글과 서버 행을 함께 바꾼다(편집기가 저장된 판독문으로 돌아가고 표시가
     * 내려간다) — Log out이 그 답을 보기 전에 글을 잡으면 사람이 버리기로 한 글을 보존 저장이 초안으로 되살린다.
     */
    let discardsOut = 0;
    /**
     * 나가 있는 확정·삽입·버리기가 끝날 때. Log out은 그 답을 본 뒤의 화면을 잡아야 하므로 이것을 기다린다 — 사람에게 "끝난 뒤
     * 다시 누르라"고 하지 않는다. 그 표시들이 내려가는 자리(자기 것만 내린다)가 기다리는 쪽을 깨운다.
     */
    const idleWaiters = [];
    function workBusy() { return commitInFlight || insertInFlight || discardsOut > 0; }
    function workIdle() {
      return workBusy() ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
    }
    function wakeIdle() {
      if (!workBusy()) for (const wake of idleWaiters.splice(0)) wake();
    }
    /**
     * 초안의 명령 프로토콜(S7-U5 U5S-REQ-15·17, report-draft-client.js). 이 문서가 초안을 바꾸는 모든 길 — 자동 저장·검사
     * 이동·탭 닫기·재기준·인용 삽입·구조화 적용·초안 버리기·확정·로그아웃 준비의 보존·Recover Draft — 이 이것 하나로 간다.
     * 요청마다 작성자와 그 글이 딛고 선 초안 revision, 전체 원문을 싣고, 서버는 저장된 revision이 그것과 같을 때만 바꾼다.
     * 한 검사의 명령은 차례로 나간다(뒤의 명령은 앞의 명령이 올린 revision을 싣는다). 그래서 끊긴 쓰기가 늦게 닿아도 그 뒤의
     * 글을 덮지 못하고, 결과를 모르는 쓰기 뒤에는 다음 명령이 서버 상태부터 읽는다. 저장 확인은 답의 봉투(작성자·revision·
     * 전체 원문)가 보낸 것과 전부 같을 때뿐이다.
     */
    const draftClient = KinReportDraftClient.create({ transport, base: API,
      // 이 문서의 글을 싣고 나간 쓰기는 답이 확인할 때까지 표시로 남는다. 버리기·확정은 표시를 세우지 않는다(U5CLI-F10).
      onWrite: uid => reportConverge.add(uid) });

    /** 점유 거절(REPORT_HELD): 누가 잡고 있는지 화면에 반영하고 그 검사에 한 번만 알린다. */
    function noteHeld(uid, holder) {
      appState[uid] = { ...appState[uid], holder };
      syncStudy(uid);
      if (uid === selectedUid) { updateReportButtons(); loadReport(); }
      if (warnedFor !== uid) {
        warnedFor = uid;
        toast(`${displayActor(holder)} 님이 판독 중입니다 — 저장되지 않았습니다`, "err");
      }
    }

    function draftFailureText(result) {
      return result.message ?? (result.outcome === "unknown" ? "서버의 답을 확인하지 못했습니다"
        : result.outcome === "conflict" ? "서버의 초안이 이 화면과 다릅니다"
        : result.outcome === "owner" ? "이 화면의 계정으로 쓴 초안이 아니라고 서버가 답했습니다"
        : "요청을 보내지 못했습니다");
    }

    /**
     * 저장되지 않은 초안 명령의 결과를 사실대로 남긴다(saved는 부른 쪽이 다룬다). 명령 경로가 이미 서버의 지금 초안을 읽어
     * 확인을 끝낸 뒤의 결과다 — 같은 글이거나 이 문서의 글과의 충돌, 답만 잃은 저장은 여기 오지 않는다. 남은 충돌은 자동
     * 쓰기를 멈추고 사람이 한 번 고르게 하고(openDraftConflict), 결과를 모르는 쓰기와 거절은 수렴 표시로 남겨 저장된 것처럼
     * 두지 않는다. 떠나지 않은 요청(문맥이 무효), 서버가 알린 세션 종료(종료 조정이 맡는다), 더 새 저장에 합쳐진 쓰기는 알릴
     * 실패가 아니다. 작성자 대조의 거절은 그 쓰기 하나의 거절이다 — 아무것도 다른 계정으로 저장되지 않았고, 화면을 닫을
     * 일이 아니다. `quiet`는 부른 쪽이 자기 자리에 이미 알렸을 때(또는 같은 실패를 이미 알렸을 때), `converge: false`는
     * 화면의 글을 다시 보낼 일이 아닐 때(버리기, 아무것도 남기지 않은 삽입 거절), `discard`는 실패한 것이 버리기일 때다.
     */
    function draftNotSaved(uid, at, result, { quiet = false, converge = true, discard = false } = {}) {
      // withdrawn: 차례가 왔을 때 보낼 글이 없었다(그 글은 그 사이 확정됐거나 사람이 버렸다) — 실패가 아니다.
      if (["unsent", "auth", "merged", "withdrawn"].includes(result.outcome)) return;
      work.commit(at, () => {
        if (converge) reportConverge.add(uid);
        if (result.outcome === "conflict") { openDraftConflict(uid); return; }
        if (result.code === "REPORT_HELD") { noteHeld(uid, result.answer?.body?.holder); return; }
        if (uid === selectedUid) renderDraftBar();
        if (quiet) return;
        // 버리기의 실패는 저장의 실패가 아니다 — 무엇이 되지 않았는지를 그대로 말한다. 화면의 글은 어느 쪽이든 그대로다.
        if (discard) toast(result.outcome === "unknown"
          ? "초안을 버렸는지 확인하지 못했습니다 — 화면은 그대로 두었습니다. 서버의 상태는 다음 새로 고침에 반영됩니다"
          : "초안을 버리지 못했습니다: " + draftFailureText(result), "err");
        else toast(result.outcome === "unknown"
          ? "초안 저장을 확인하지 못했습니다 — 입력한 내용은 그대로 있고, 다음 저장이 서버 상태부터 확인합니다"
          : "서버 저장 실패: " + draftFailureText(result), "err");
      });
    }

    /**
     * 인용 전용 읽기. 판독문 관문(기관·예비 판독)에 더해 **소견 가독을 다시 거는**
     * 유일한 표면이고, 축약된 건과 `sameTextCount`도 여기서만 온다.
     * 같은 검사를 한 번 확인했으면 다시 묻지 않는다 — 다시 묻는 것은 사람이 고르는 일이다.
     */
    async function ensureCitations(uid, { force = false } = {}) {
      if (!uid || !serverMode || offline || demoMode) return false;
      if (!KinAuth.has("radiologist") || appState[uid]?.prelimHidden) return false;
      if (citationReads.has(uid)) return false;
      if (!force && (citations.known(uid) || citationNotes.has(uid))) return false;
      const ticket = {};
      citationReads.set(uid, ticket);
      // 이 읽기를 시작한 문맥. 답도 실패도 표시줄도 이것을 지난다 — 로그아웃 준비·그 취소·세션 종료 뒤에 온 것은 확인 상태도
      // 안내도 바꾸지 않는다(편집으로 돌아간 뒤에는 그때의 문맥으로 다시 읽는다).
      const at = work.capture("document");
      let mine = true;
      try {
        const answer = await api("GET", `/studies/${encodeURIComponent(uid)}/report/citations`, undefined, undefined, at);
        // 늦게 온 답이 더 새 답을 덮지 않는다. 상태는 uid로 키가 잡혀 있으므로
        // 다른 검사의 답이 이 검사에 들어올 길은 없다.
        if (!work.admits(at) || citationReads.get(uid) !== ticket) return mine = false;
        citations.confirm(uid, answer);
        citationNotes.delete(uid);
        return true;
      } catch (e) {
        if (!work.admits(at) || citationReads.get(uid) !== ticket) return mine = false;
        // 확인하지 못한 것과 인용이 없는 것은 다르다. 모른다고 말하고, 키는 만들지 않는다.
        citationNotes.set(uid, "인용 건수를 확인하지 못했습니다: " + e.message);
        return false;
      } finally {
        // 이 읽기의 표는 이 읽기가 치운다(자기 것만).
        if (citationReads.get(uid) === ticket) citationReads.delete(uid);
        // 버려진 읽기(더 새 읽기가 맡았거나 문맥이 무효가 됐다)는 표시줄도 그리지 않는다 — 그리는 것은 맡은 읽기다.
        if (mine) work.commit(at, () => { if (uid === selectedUid) renderCitationBar(); });
      }
    }

    /**
     * **삽입 뒤 서버 행을 모르게 됐을 때 초안 쪽 상태를 되돌린다.**
     *
     * 거절·늦은 응답·확인 전 200 — 어느 쪽이든 그 뒤 행에 무엇이 들어 있는지 화면은 모른다.
     * 그런데도 "확인됨"으로 남겨 두면 다음 저장이 **새 `cid`가 빠진 유지 목록**을 싣고, 서버의
     * 교집합이 그 증언만 지운다. 문장은 본문에 남고 증언만 사라지는 것이 이 단위가 막아야 할
     * 바로 그 상태다. 머리 판의 제거 선택은 사람이 고른 것이므로 함께 지우지 않는다.
     *
     * 나가 있던 전용 읽기의 표도 함께 버린다 — 삽입 **전에** 떠난 답이 삽입 **뒤의** 목록으로
     * 굳으면 같은 구멍이 다시 열린다.
     */
    function invalidateCitations(uid) {
      if (!uid) return false;
      const changed = citations.unconfirm(uid);
      citationReads.delete(uid);
      citationNotes.delete(uid);
      if (uid === selectedUid) { renderCitationBar(); ensureCitations(uid, { force: true }); }
      return changed;
    }

    /* ── 구조화 판독 본문 (S3-structured-report) ─────────────────────────────────────
     *
     * 제품 서식 목록은 **비어 있다**(P6). 그래서 아래 단추는 그려지지 않고, 이 코드는
     * 목록이 채워지는 날에 그대로 도는 기반이다. 시험만이 합성 목록(`SYN-*`)을 자기
     * 인스턴스에 주입한다 — 제품 코드나 HTTP로 합성 항목에 닿는 길은 없다.
     */
    const structureForm = KinReportStructure.create(KinReportCitation, KinReportStructure.PRODUCT_CATALOG);
    const structureState = KinReportStructure.createState();
    const structureReads = new Map(), structureNotes = new Map();
    /** 구조화 적용의 세대. 인용의 `citeSeq`와 별개로 센다(P14). */
    let structSeq = 0;
    let structPane = null;

    /**
     * 구조화 전용 읽기. 확정은 매번 초안 행을 지우므로, 한 번 저장한 뒤의 값은 전부
     * 머리 판에 있다 — 이 읽기가 없으면 Save 한 번에 화면의 구조화 상태가 사라진다.
     */
    async function ensureStructure(uid, { force = false } = {}) {
      if (!uid || !serverMode || offline || demoMode) return false;
      if (structureForm.empty) return false;
      if (!KinAuth.has("radiologist") || appState[uid]?.prelimHidden) return false;
      if (structureReads.has(uid)) return false;
      if (!force && (structureState.known(uid) || structureNotes.has(uid))) return false;
      const ticket = {};
      structureReads.set(uid, ticket);
      const at = work.capture("document");
      try {
        const answer = await api("GET", `/studies/${encodeURIComponent(uid)}/report/structure`, undefined, undefined, at);
        if (!work.admits(at) || structureReads.get(uid) !== ticket) return false;
        structureState.confirm(uid, answer);
        structureNotes.delete(uid);
        return true;
      } catch (e) {
        if (!work.admits(at) || structureReads.get(uid) !== ticket) return false;
        // 확인하지 못한 것과 구조화 건이 없는 것은 다르다. 모른다고 말하고 키는 만들지 않는다.
        structureNotes.set(uid, "구조화 항목을 확인하지 못했습니다: " + e.message);
        return false;
      } finally {
        if (structureReads.get(uid) === ticket) structureReads.delete(uid);
      }
    }

    /**
     * 적용·거절·늦은 응답 뒤에는 서버 행에 무엇이 있는지 화면이 모른다. 확인됨으로 남겨 두면
     * 다음 자동 저장이 **새 `sid`가 빠진 유지 목록**을 실어 방금 기록된 증언을 지운다.
     * 그래서 모르는 상태로 되돌리고 전용 읽기 한 번이 서버의 바이트로 채우게 한다.
     */
    function invalidateStructure(uid) {
      if (!uid) return false;
      const changed = structureState.unconfirm(uid);
      structureReads.delete(uid);
      structureNotes.delete(uid);
      if (uid === selectedUid) ensureStructure(uid, { force: true });
      return changed;
    }

    /**
     * 이 항목의 **지금 값**을 들고 있는 건 (B3).
     *
     * 내 초안 건이 먼저다 — 그 문장이 지금 화면의 칸에 있는 건이고, 같은 항목의 머리 건은
     * 한 번 고친 뒤라면 이미 바꿔치워져 본문에 없다. 머리를 먼저 고르면 사람이 방금 넣은 값
     * 대신 **옛 값**을 보여주고, 그 옛 문장을 지우려는 계획을 세운다.
     */
    function structurePrevious(uid, templateId, itemCode) {
      const row = uid ? structureState.get(uid) : null;
      if (!row) return null;
      const same = e => e && e.templateId === templateId && e.itemCode === itemCode;
      if (structureState.known(uid)) { const mine = row.draft.find(same); if (mine) return mine; }
      return row.head.find(same) ?? null;
    }

    /**
     * 지금 고른 항목의 계획. **화면이 보여주는 답 하나가 서버로 가는 답 하나**다.
     * 이미 값이 있는 항목이면 그 문장을 그 자리에서 바꾸고, 없으면 커서 자리에 넣는다.
     */
    function structurePlan(pane) {
      const el = $("#" + pane.field);
      const guards = citationGuards(pane.field);
      if (pane.previous)
        return structureForm.replacePlan(el.value, String(pane.previous.renderedText), pane.line,
                                         caretAt(pane.field), guards);
      return structureForm.placePlan(el.value, pane.line, caretAt(pane.field), guards);
    }

    /**
     * 고를 수 있는 항목 전부. 서식이 여럿이면 **서식별로 묶지 않고 한 목록**에 펼친다 —
     * 서식 고르기 화면을 먼저 만들면 그 화면의 규칙(기본값·필터·기억)을 지금 정해야 하는데,
     * 어느 서식이 실제로 쓰일지는 D2의 답이 와야 알 수 있다.
     */
    function structureItems() {
      const out = [];
      for (const template of structureForm.templates())
        for (const item of template.items) out.push({ template, item });
      return out;
    }
    const structureItemKey = pair => pair.template.templateId + "\u0000" + pair.item.code;

    function closeStructure() {
      structPane = null;
      $("#structmodal").classList.remove("on");
    }

    function renderStructure() {
      if (!structPane) return;
      const pane = structPane;
      const item = pane.item;
      $("#struct-template").textContent = pane.template ? pane.template.title : "";
      for (const [id, on] of [["#struct-value-choice", item.valueType === "choice"],
                              ["#struct-value-number", item.valueType === "number"],
                              ["#struct-value-text", item.valueType === "text"],
                              ["#struct-value-bool-label", item.valueType === "boolean"]])
        $(id).style.display = on ? "" : "none";
      $("#struct-value-bool-text").textContent = item.valueType === "boolean"
        ? (pane.value ? String(item.trueText) : String(item.falseText)) : "";
      const why = structureForm.validateValue(item, pane.value);
      pane.line = why ? null : structureForm.renderItem(item, pane.value);
      const plan = why ? null : structurePlan(pane);
      pane.plan = plan && plan.mode2 !== "refuse" ? plan : null;
      /**
       * 문장은 `textContent`로만 쓴다 — 자유 입력 값이 들어가는 자리이고 지면은 기록이다.
       *
       * 바꾸기일 때는 **지워질 문장도 함께** 보인다(P3). 이 창은 판독문 칸을 덮고 있어서 사람은
       * 무엇이 사라지는지 눈으로 볼 수 없는데, 이 단위에서 본문 글자를 지우는 경로는 여기 하나뿐이다.
       * 줄 번호만 말하면 "몇 번째 줄"이 맞는지 확인할 방법이 없다.
       */
      $("#struct-line").textContent = pane.line ?? "";
      const removing = pane.plan && pane.plan.mode2 === "replace" && pane.previous
        ? String(pane.previous.renderedText ?? "") : "";
      $("#struct-removed").textContent = removing;
      $("#struct-removed-label").style.display = removing ? "" : "none";
      const label = KinReportCitation.FIELD_LABEL[pane.field] ?? pane.field;
      $("#struct-place").textContent = !pane.plan ? ""
        : (pane.plan.mode2 === "replace"
            ? `${label} ${pane.plan.removedLine}번째 줄의 위 문장을 지우고 이 문장으로 바꿉니다.`
            : `${label} ${pane.plan.line}번째 줄부터 넣습니다. 기존 내용은 지우지 않습니다.`);
      $("#struct-status").textContent = pane.status || why || (plan && plan.message) || "";
      // 다른 판의 서식으로 적힌 값은 보여주기만 한다. 지금 서식으로 다시 렌더해 보내면 서명된
      // 판의 문장을 새 문면으로 조용히 바꾸는 일이 된다.
      $("#struct-apply").disabled = !pane.plan || !!pane.busy || !!pane.readOnly;
    }

    function selectStructureItem(key) {
      const pairs = structureItems();
      const pair = pairs.find(p => structureItemKey(p) === key) ?? pairs[0];
      if (!pair) return;
      const template = pair.template, item = pair.item;
      const previous = structurePrevious(structPane?.uid ?? selectedUid, template.templateId, item.code);
      const value = previous && !structureForm.unknownRevision(previous) ? previous.value
        : item.valueType === "boolean" ? false
        : item.valueType === "choice" ? (item.choices[0] ?? {}).code
        : item.valueType === "number" ? item.min : "";
      structPane = { uid: structPane?.uid ?? selectedUid, selSeq: structPane?.selSeq ?? selectionSeq,
        template, item, field: item.field, value, previous, status: "", busy: false, line: null, plan: null };
      if (previous && structureForm.unknownRevision(previous)) {
        structPane.status = KinReportStructure.MESSAGES.unknownRevision;
        structPane.readOnly = true;
      }
      $("#struct-item").value = structureItemKey(pair);
      $("#struct-value-choice").replaceChildren(
        ...(item.choices ?? []).map(choice => new Option(choice.text, choice.code)));
      if (item.valueType === "choice") $("#struct-value-choice").value = String(value ?? "");
      if (item.valueType === "number") $("#struct-value-number").value = String(value ?? "");
      if (item.valueType === "text") $("#struct-value-text").value = String(value ?? "");
      if (item.valueType === "boolean") $("#struct-value-bool").checked = !!value;
      renderStructure();
    }

    function openStructure() {
      if (structureForm.empty) return;
      const why = reportEditorBlock();
      if (why) { toast(why, "err"); return; }
      const pairs = structureItems();
      if (!pairs.length) return;
      $("#struct-item").replaceChildren(
        ...pairs.map(pair => new Option(pair.item.label, structureItemKey(pair))));
      $("#structmodal").classList.add("on");
      /**
       * **이 창은 열린 그 검사의 것이다** (B4).
       *
       * 창을 연 검사와 선택 세대를 여기서 못 박는다. 못 박지 않으면 창이 떠 있는 동안 사람이
       * 다른 환자로 옮겼을 때 누르는 순간의 `selectedUid`로 계획이 다시 서고, 두 번째 누름에서
       * 계획이 일치해 **A 환자의 항목이 B 환자의 판독문에 적힌다.**
       */
      structPane = { uid: selectedUid, selSeq: selectionSeq };
      selectStructureItem(structureItemKey(pairs[0]));
    }

    /**
     * 적용. 순서는 **서버 먼저**다(P8) — 서버가 값과 문장을 한 번에 기록하고 200을 받은
     * 뒤에만 판독문 칸이 바뀐다. 거절되면 판독문은 한 글자도 움직이지 않는다.
     *
     * 열어둔 사이에 본문·커서·보호 구간이 바뀌었으면 **아무것도 보내지 않고** 다시 확인시킨다.
     * 소견 패널이 판독문 칸을 덮고 있어 사람은 자리를 눈으로 확인할 수 없고, 그래서 화면이
     * 말한 자리가 낡으면 그것은 거짓 확인이다.
     */
    async function applyStructure() {
      const pane = structPane;
      if (!pane || pane.busy) return;
      /**
       * **다른 검사로 옮겼으면 여기서 끝난다** (B4).
       *
       * 계획을 다시 세우기 **전에**, 요청을 만들기 **전에** 묻는다. 뒤에서 물으면 계획이 이미
       * 새 검사의 칸으로 다시 서고, 두 번째 누름에서는 그 계획이 자기 자신과 일치해
       * **A 환자의 항목이 B 환자의 판독문에 적힌다.** 진행 중이 아니면 창도 닫는다 —
       * 남겨두면 같은 손가락이 한 번 더 눌러 같은 일을 한다.
       */
      if (pane.uid !== selectedUid || pane.selSeq !== selectionSeq) {
        closeStructure();
        toast("다른 검사로 옮겨서 구조화 입력을 닫았습니다 — 판독문은 그대로입니다.", "err");
        return;
      }
      if (pane.readOnly) { pane.status = KinReportStructure.MESSAGES.unknownRevision; renderStructure(); return; }
      const why = reportEditorBlock();
      if (why) { pane.status = why; renderStructure(); return; }
      // 한 번에 한 삽입만 나간다(P14). 인용과 구조화가 같은 본문을 두고 겹치지 않게 한다.
      if (insertInFlight) { pane.status = "다른 삽입이 처리 중입니다 — 잠시 뒤 다시 시도하세요"; renderStructure(); return; }
      const shown = pane.plan;
      const fresh = structurePlan(pane);
      if (!shown || fresh.mode2 === "refuse" || !structureForm.samePlan(shown, fresh)) {
        pane.status = fresh.mode2 === "refuse" ? fresh.message : KinReportStructure.MESSAGES.stale;
        pane.plan = fresh.mode2 === "refuse" ? null : fresh;
        renderStructure();
        return;
      }
      // 위에서 확인한 그 검사다. 누르는 순간의 선택이 아니라 **창이 열린 검사**를 쓴다.
      const uid = pane.uid;
      const content = Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value]));
      content[pane.field] = fresh.text;
      const a = appState[uid] ?? {};
      const baseVersion = reportBaseVersion(uid, a.draft?.baseVersion ?? a.version ?? 0);
      const epoch = { uid, selSeq: selectionSeq, seq: ++structSeq };
      pane.busy = true;
      renderStructure();
      insertInFlight = true;
      structureReads.delete(uid);
      // 이 적용을 시작한 문맥(세션·작업 세대). 검사와 창의 세대는 아래 epoch이 본다 — 떠난 검사에도 수렴 표시는 남겨야 한다.
      // 쓰기는 초안의 명령 경로로 간다: 작성자·초안 revision·전체 원문에 이 적용을 실어 한 번에 기록한다.
      const at = work.capture("document");
      const pristine = pristineEditor(uid);
      const result = await draftClient.write(uid, { ...content, baseVersion }, { owner: draftOwner, context: at,
        operation: { structure: {
          op: pane.previous ? "replace" : "apply", field: pane.field,
          templateId: pane.template.templateId, templateRevision: pane.template.revision,
          itemCode: pane.item.code, valueType: pane.item.valueType, value: pane.value,
          renderedText: pane.line,
          ...(pane.previous ? { replacesSid: String(pane.previous.sid) } : {}),
        } } });
      // 이 적용이 세운 표시는 이 적용이 내린다(자기 것만).
      insertInFlight = false;
      wakeIdle();
      if (result.outcome !== "saved") {
        pane.busy = false;
        const untouched = insertLeftNoText(pristine, result);
        work.commit(at, () => {
          // 판독문은 한 글자도 바뀌지 않았다. 다만 요청이 서버에 닿았는지는 알 수 없으므로
          // 수렴을 표시하고 구조화 상태를 모르는 것으로 되돌린다 — 서버가 기록하지 않았다고 분명히 답했고 고친 글도
          // 없으면 표시는 적용 전 그대로다.
          if (untouched) reportConverge.delete(epoch.uid); else markConverge(epoch.uid);
          invalidateStructure(epoch.uid);
          pane.status = "적용하지 못했습니다: " + draftFailureText(result) + " — 판독문은 그대로입니다.";
          // 그 사이 이 창이 닫히고 다른 창이 열렸다면 남의 창에 이 실패를 그리지 않는다.
          if (structPane === pane) renderStructure();
        });
        draftNotSaved(epoch.uid, at, result, { quiet: true, converge: !untouched });
        return;
      }
      work.commit(at, () => {
        appState[uid] = { ...appState[uid], draftRevision: result.envelope.revision };
        if (epoch.uid !== selectedUid || epoch.selSeq !== selectionSeq || epoch.seq !== structSeq) {
          // 서버는 기록했는데 화면은 그 `sid`를 쓰지 못했다. 떠난 검사의 창을 남겨두면
          // 다음 확인이 **다른 환자의** 판독문에 그 문장을 넣는다. 그 사이 새로 열린 창은
          // 이 요청의 것이 아니므로 건드리지 않는다.
          markConverge(epoch.uid);
          invalidateStructure(epoch.uid);
          if (structPane === pane) closeStructure();
          toast("다른 검사로 옮기기 전에 누른 구조화 적용의 응답이 늦게 도착해 화면에 반영하지 않았습니다.", "err");
          return;
        }
        editReport([reportEditOf(pane.field, fresh.text, fresh.end)]);
        // The edit retained all current fields, including edits made while this command was out.
        if (sameDraftText(appState[uid]?.draft, { ...content, baseVersion })) reportConverge.delete(uid);
        // 새 `sid`를 지어내지 않는다 — 서버가 무엇을 기록했는지는 전용 읽기 하나가 말한다.
        invalidateStructure(uid);
        if (structPane === pane) closeStructure();
      });
    }

    $("#struct-item").addEventListener("change", e => selectStructureItem(e.target.value));
    $("#struct-value-choice").addEventListener("change", e => {
      if (structPane) { structPane.value = e.target.value; structPane.status = ""; renderStructure(); }
    });
    $("#struct-value-number").addEventListener("input", e => {
      if (structPane) { structPane.value = e.target.value === "" ? null : Number(e.target.value); structPane.status = ""; renderStructure(); }
    });
    $("#struct-value-text").addEventListener("input", e => {
      if (structPane) { structPane.value = e.target.value; structPane.status = ""; renderStructure(); }
    });
    $("#struct-value-bool").addEventListener("change", e => {
      if (structPane) { structPane.value = e.target.checked; structPane.status = ""; renderStructure(); }
    });
    $("#struct-cancel").addEventListener("click", () => closeStructure());
    $("#struct-apply").addEventListener("click", () => { applyStructure(); });

    /**
     * 서식 목록이 비어 있으면 단추를 **그리지 않는다**(P6). 비활성 단추는 "곧 된다"는 약속이고,
     * 지금 약속할 수 있는 것이 없다. 목록이 채워지면 이 한 줄이 단추를 만든다.
     */
    if (!structureForm.empty) {
      const button = document.createElement("button");
      button.id = "b-structured";
      button.type = "button";
      button.textContent = "Structured";
      button.title = "서식에서 고른 값을 판독문 본문에 한 줄로 넣습니다";
      button.addEventListener("click", () => openStructure());
      $("#b-print").before(button);
    }

    /** 이 건이 딛고 볼 본문 — 머리 건은 승인본, 초안 건은 지금 편집 중인 textarea. */
    function citationBody(scope, field) {
      if (!RFIELDS.includes(field)) return "";
      return scope === "head" ? String(appState[selectedUid]?.[field] ?? "") : $("#" + field).value;
    }
    function citationEntryText(entry, scope) {
      const C = KinReportCitation;
      const when = entry?.insertedAt ? String(entry.insertedAt).replace("T", " ").slice(0, 16) : "시각 미확인";
      // 작성자는 서버가 쓰는 값이고 삽입 응답에는 실려 오지 않는다. 화면이 그 자리를
      // 추측한 문자열로 채우면 증언이 아닌 것이 증언처럼 보인다 — 방금 넣은 건은
      // 그렇게 말하고, 다음 전용 읽기가 서버의 바이트로 바꾼다.
      const who = entry?.mine ? "방금 이 화면에서 넣음" : (displayActor(entry?.insertedBy) || "작성자 미확인");
      const field = C.FIELD_LABEL[entry?.field] ?? "알 수 없는 칸";
      if (C.isReduced(entry)) return `${field} · ${who} · ${when} — ${C.UNAVAILABLE_TEXT}`;
      const state = C.presenceOf(entry, citationBody(scope, entry.field));
      const source = `소견 r${entry.findingRevision} · 출처 ${Number(entry.sourceIndex) + 1}번` +
        (entry.linkStateAtInsert ? ` · 인용 당시 연결 ${entry.linkStateAtInsert}` : "");
      return `${field} · ${source} · ${who} · ${when} — ${C.STATE_TEXT[state] ?? ""}`;
    }

    /**
     * 인용 줄과 목록. **전용 읽기가 성공했을 때만** 건수·출처·상태를 말한다 —
     * 확인하지 못했는데 "0건"이라고 쓰면 그것이 곧 거짓말이다.
     */
    function renderCitationBar() {
      const bar = $("#citebar"), list = $("#citelist"), uid = selectedUid;
      const row = uid ? citations.get(uid) : null;
      const note = uid ? citationNotes.get(uid) : null;
      const hidden = !!appState[uid]?.prelimHidden;
      // 초안 쪽을 모르는 상태로 되돌린 뒤에는 `draft`가 비어 있지만 그것은 **0건이 아니라
      // 모름**이다. 0건이라고 쓰면 그 자체가 거짓말이므로 건수를 말하지 않는다.
      const unknownDraft = !!row && !citations.known(uid);
      const count = row ? row.head.length + row.draft.length : 0;
      if (!uid || hidden || (!count && !note && !unknownDraft)) {
        bar.style.display = "none"; list.hidden = true; list.replaceChildren();
        $("#b-cite-list").setAttribute("aria-expanded", "false");
        return;
      }
      bar.style.display = "flex";
      $("#b-cite-list").style.display = row ? "" : "none";
      $("#citemsg").textContent = row
        ? (unknownDraft
            ? `● 승인본 ${row.head.length}건 · 저장된 초안의 인용은 다시 확인하는 중입니다` + (note ? ` (${note})` : "")
            : `● 인용 ${count}건 — 승인본 ${row.head.length}건 · 저장된 초안 ${row.draft.length}건`) +
          (reportConverge.has(uid) ? " · 마지막 인용이 화면에 반영되지 않아 다음 자동 저장이 서버 내용을 화면에 맞춥니다" : "")
        : `● ${note}`;
      if (!row || !citationListOpen) {
        list.hidden = true; list.replaceChildren();
        $("#b-cite-list").setAttribute("aria-expanded", "false");
        return;
      }
      $("#b-cite-list").setAttribute("aria-expanded", "true");
      list.hidden = false;
      // 30초 폴링도 이 목록을 다시 만든다. 사람이 제거를 고르는 중에 체크상자가 통째로
      // 갈리면 포커스가 사라지므로, 같은 건의 상자로 되돌려 놓는다(소견 패널과 같은 규칙).
      const active = document.activeElement;
      const focused = active && list.contains(active) ? active.dataset.citeRemove : null;
      const nodes = [];
      const add = (tag, text, className) => {
        const el = document.createElement(tag);
        el.textContent = text;
        if (className) el.className = className;
        nodes.push(el);
        return el;
      };
      add("h5", `승인본 v${row.version}에 남은 인용 ${row.head.length}건`);
      if (!row.head.length) add("p", "없습니다", "cite-note");
      for (const entry of row.head) {
        const line = document.createElement("p");
        line.className = "cite-entry";
        line.dataset.citeScope = "head";
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.citeRemove = String(entry?.cid ?? "");
        box.checked = citations.marked(uid, entry?.cid);
        box.disabled = !!reportWriteBlock();
        label.append(box, document.createTextNode(" 다음 확정에서 제거"));
        line.append(document.createTextNode(citationEntryText(entry, "head") + " · "), label);
        nodes.push(line);
      }
      if (unknownDraft) {
        add("h5", "저장된 초안의 인용");
        add("p", "다시 확인하는 중입니다 — 확인될 때까지 이 화면은 초안의 인용을 지우지도, 건수를 말하지도 않습니다.", "cite-note");
      } else {
        add("h5", `저장된 초안의 인용 ${row.draft.length}건`);
        if (!row.draft.length) add("p", "없습니다", "cite-note");
        for (const entry of row.draft) add("p", citationEntryText(entry, "draft"), "cite-entry");
      }
      add("p", KinReportCitation.PRESENT_CAVEAT, "cite-note");
      add("p", "승인본의 인용은 다음 확정에서 제거를 골랐을 때만 빠집니다. 초안의 인용은 그 초안을 버릴 때 함께 없어집니다.", "cite-note");
      list.replaceChildren(...nodes);
      if (focused) list.querySelector(`[data-cite-remove="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }
    /**
     * 본문이 바뀌면 존재 상태도 바뀐다. 다만 글자마다 목록을 다시 만들면 타이핑이 무거워지고
     * 포커스가 흔들리므로, 목록이 열려 있을 때 **잠깐 멈춘 뒤** 한 번 다시 센다.
     * `n`은 인용 집합의 성질이라 편집 중에 변하지 않는다 — 여기서 변하는 것은 `k`뿐이다.
     */
    let citationRefreshTimer = null;
    function scheduleCitationRefresh() {
      if (!citationListOpen) return;
      clearTimeout(citationRefreshTimer);
      // 다시 세는 일은 이 타건이 있던 그 선택의 것이다 — 그 사이 검사를 옮겼거나 로그아웃 준비·세션 종료가 있었으면 그리지 않는다.
      const at = work.capture("study");
      citationRefreshTimer = setTimeout(() => { citationRefreshTimer = null; work.commit(at, renderCitationBar); }, 400);
    }
    for (const k of RFIELDS) $("#" + k).addEventListener("input", scheduleCitationRefresh);
    // S3-U6: 커서 자리 자체는 그 칸이 들고 있다. 화면은 "이 칸을 짚은 적이 있다"만 표시해 둔다.
    for (const k of RFIELDS) $("#" + k).addEventListener("focus", () => noteCaret(k));
    $("#b-cite-list").addEventListener("click", () => {
      citationListOpen = !citationListOpen;
      renderCitationBar();
    });
    $("#b-cite-reload").addEventListener("click", () => {
      if (!selectedUid) return;
      citationNotes.delete(selectedUid);
      ensureCitations(selectedUid, { force: true });
    });
    $("#citelist").addEventListener("change", e => {
      const box = e.target.closest("[data-cite-remove]");
      if (!box || !selectedUid) return;
      // 제거는 **확정에서만** 일어난다. 여기서 고르는 것은 의사표시이고, 서명 전까지
      // 승인본의 어떤 행도 바뀌지 않는다.
      const why = reportWriteBlock();
      if (why) { box.checked = false; toast(why, "err"); return; }
      citations.mark(selectedUid, box.dataset.citeRemove, box.checked);
    });

    /**
     * S3-U6: 이 칸에서 **쪼개면 안 되는 줄 블록**들 — 알려진 인용이 가리키는 그 글이다.
     *
     * 머리 판 건은 행이 있는 한 언제나 싣는다(초안 쪽을 모르는 상태로 되돌려도 머리는 남는다).
     * 초안 건은 **확인된 동안에만** 싣는다 — 모르는 상태의 빈 목록을 "보호할 것이 없다"로 읽으면
     * 보호하지 않고도 보호했다고 말하게 된다. 축약된 건은 대조할 글 자체가 오지 않아 보호할 수 없다.
     */
    function citationGuards(field) {
      const uid = selectedUid, row = uid ? citations.get(uid) : null;
      if (!row) return [];
      const entries = citations.known(uid) ? [...row.head, ...row.draft] : [...row.head];
      return entries.filter(e => e && e.field === field && !KinReportCitation.isReduced(e))
                    .map(e => e.insertedText);
    }
    /** 지금 이 칸에 넣는다면 어디에 들어가는가. 화면은 이 답 하나를 보여주고 이 답 하나를 보낸다. */
    function citationPlan(field, block) {
      return KinReportCitation.placeBlock($("#" + field).value, block, caretAt(field), citationGuards(field));
    }
    /**
     * 삽입 자리를 사람이 읽는 한 줄로. 숫자는 **줄바꿈 기준** 줄 번호다 — 화면에서 접혀 보이는
     * 줄이 아니라 저장되는 글의 줄이다. 소견 패널이 판독문 칸을 덮고 있어 사람은 자리를 눈으로
     * 확인할 수 없으므로, 이 줄이 유일한 고지이며 낡으면 안 된다.
     */
    function placementLine(field, plan) {
      if (!plan) return "";
      const label = KinReportCitation.FIELD_LABEL[field] ?? field;
      if (plan.mode === "end")
        return `삽입 위치: ${label} 칸 맨 끝 — 이 칸에서 확인된 커서 자리가 없어 끝에 붙입니다`;
      return `삽입 위치: ${label} 칸 ${plan.line}번째 줄(줄바꿈 기준)부터` +
        (plan.snapped === "line-end" ? " · 커서가 줄 중간이라 그 줄 다음으로 맞췄습니다" : "") +
        (plan.snapped === "past-citation" ? " · 이미 인용된 문장을 쪼개지 않도록 그 뒤로 옮겼습니다" : "") +
        (plan.mode === "selection" ? " · 선택한 글은 지우지 않고 그 뒤에 넣습니다" : "");
    }
    /**
     * 200을 받은 뒤 **화면에** 놓을 계획(P-10). 보낸 문자열이 딛고 선 값이 아직 그대로면 그
     * 문자열을 그대로 쓴다. 그 사이 이 칸이 프로그램으로 갈렸다면 그 글을 덮지 않고 지금 값 위에
     * 같은 규칙으로 다시 놓는다 — 어느 쪽이든 사람이 쓴 글자를 잃지 않는다.
     */
    function screenPlan(field, block, before, plan) {
      return $("#" + field).value === before ? plan : citationPlan(field, block);
    }

    /**
     * 삽입을 막는 이유. 권한·점유·촬영 중·예비 판독은 **상용구 삽입과 같은 관문 함수**가
     * 같은 문자열로 답한다. 여기서 더하는 것은 §6이 인용에만 요구하는 것들뿐이다 —
     * 인용은 서버 증언이 있어야 성립하므로 오프라인·비서버 모드에서는 아예 못 한다.
     */
    function citationInsertBlock() {
      const why = reportEditorBlock();
      if (why) return why;
      if (!serverMode || demoMode) return "서버에 연결돼 있을 때만 인용할 수 있습니다";
      if (offline) return "서버 연결이 끊겨 인용할 수 없습니다 — 연결된 뒤 다시 시도하세요";
      if (commitInFlight) return "판독문 확정이 끝난 뒤 다시 시도하세요";
      /**
       * **낡은 초안(behind)에서는 인용하지 않는다** (§6 마지막 항목).
       *
       * 이 초안이 딛고 선 판보다 승인본이 앞서 있으면, 지금 넣는 문장은 사람이 읽은 적 없는
       * 판 위에 쌓인다. 출구는 U3가 만든 비파괴 경로뿐이다 — Addendum을 눌러 승인본을
       * 나란히 보고 그 판 번호로 기준을 다시 잡은 뒤에 인용한다.
       */
      if (reportDraftBehind(appState[selectedUid] ?? {}))
        return "이 초안은 더 낡은 승인본을 기준으로 씁니다 — Addendum을 눌러 승인본을 확인하고 기준을 다시 잡은 뒤 인용하세요";
      return null;
    }

    /**
     * 인용 미리보기. 여기 보이는 바이트가 그대로 요청이 되고, 그대로 판독문에 들어가며,
     * 그대로 증언에 남는다. 사이에서 다듬거나 자르거나 고쳐 쓰지 않는다.
     */
    let citePane = null, citeSeq = 0, citeBusy = false, citeReturn = null;
    function closeCitePreview(returnFocus = true) {
      if (!citePane) return;
      // 순번을 올린다. 닫힌 창에 묶여 있던 응답은 더는 이 화면에 쓸 수 없다.
      citePane = null; citeSeq += 1;
      $("#cite-preview").classList.remove("show");
      for (const id of ["target", "source", "place", "status"]) $("#cite-preview-" + id).textContent = "";
      $("#cite-preview-block").textContent = "";
      if (returnFocus) (citeReturn?.isConnected ? citeReturn : $("#findings")).focus();
      citeReturn = null;
    }
    function setCiteBusy(busy) {
      citeBusy = busy;
      $("#cite-preview-insert").disabled = busy;
      $("#cite-preview-close").disabled = busy;
      $("#cite-preview-field").disabled = busy;
    }
    function renderCitePreview() {
      if (!citePane) return;
      const s = cur();
      const why = citationInsertBlock();
      $("#cite-preview-target").textContent = s
        ? `삽입 대상: ${s.name} (${s.id})\n${s.date} · ${shownStudyDesc(s)} · AccNo: ${s.acc || "없음"}`
        : "삽입 대상: 검사 미선택";
      $("#cite-preview-source").textContent =
        `출처: ${citePane.sourceLabel} · 소견 r${citePane.findingRevision} · 인용 당시 연결 ${citePane.linkState}`;
      // 미리보기는 **조립된 그 유니코드 문자열 그대로**를 보인다. 공백도 줄바꿈도 보존된다.
      $("#cite-preview-block").textContent = citePane.block;
      // 여기서 계획을 **다시 세우지 않는다.** 이 함수는 누름 자체에서도 여러 번 불리므로,
      // 여기서 갱신하면 열고 나서 바뀐 것을 조용히 흡수해 "확인한 자리"가 사라진다.
      $("#cite-preview-place").textContent = placementLine($("#cite-preview-field").value, citePane.plan);
      $("#cite-preview-status").textContent = why ?? citePane.status ??
        (`확인을 누르면 서버가 이 문장과 증언을 함께 기록한 뒤 ${KinReportCitation.FIELD_LABEL[$("#cite-preview-field").value]} 칸에 붙입니다.` +
         " 기존 내용은 한 글자도 지우지 않고 위 위치에 줄 단위로 넣습니다.");
      $("#cite-preview-insert").disabled = !!why || citeBusy;
    }
    /**
     * `reading-findings.js`가 부르는 유일한 입구. 요청은 그 패널이 **지금 읽고 있는**
     * 행에서 만든 것이고, 여기서는 그것이 지금 선택된 검사의 것인지만 다시 본다.
     */
    function openCitePreview(request, origin) {
      if (!request || !request.uid || request.uid !== selectedUid) {
        toast("선택한 검사의 소견만 판독문에 인용할 수 있습니다", "err");
        return false;
      }
      const refusal = KinReportCitation.refuseBlock(request.block);
      if (refusal) { toast(refusal, "err"); return false; }
      const why = citationInsertBlock();
      if (why) { toast(why, "err"); return false; }
      citeSeq += 1;
      citePane = { ...request, seq: citeSeq, selSeq: selectionSeq, warned: false, status: null };
      citeReturn = origin?.isConnected ? origin : null;
      // 대상 칸은 언제나 명시적이고, 기본은 Findings다. 커서는 **자리**만 정하고 **칸**은 이 선택이 정한다.
      $("#cite-preview-field").value = "findings";
      citePane.plan = citationPlan("findings", citePane.block);
      setCiteBusy(false);
      renderCitePreview();
      $("#cite-preview").classList.add("show");
      $("#cite-preview-close").focus();
      return true;
    }
    $("#cite-preview-field").addEventListener("change", () => {
      if (!citePane || citeBusy) return;
      // 대상을 바꾸면 앞서 읽고 누른 확인은 이 대상에 대한 것이 아니다.
      // 중복 경고도 새 칸 기준으로 다시 받고, 삽입 자리도 그 칸의 커서로 다시 잡는다.
      citePane.warned = false; citePane.status = null;
      citePane.plan = citationPlan($("#cite-preview-field").value, citePane.block);
      renderCitePreview();
    });
    $("#cite-preview-close").addEventListener("click", () => { if (!citeBusy) closeCitePreview(); });
    $("#cite-preview").addEventListener("click", e => {
      // 응답을 기다리는 동안에는 바깥 클릭으로 닫히지 않는다(B3) — 무엇이 기록됐는지
      // 모르는 채로 창만 사라지면 사용자는 다시 누르고, 같은 문장이 두 번 남는다.
      if (e.target.id === "cite-preview" && !citeBusy) closeCitePreview();
    });
    $("#cite-preview").addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (!citeBusy) closeCitePreview();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const controls = [$("#cite-preview-field"), $("#cite-preview .tpl-preview-body"),
                          $("#cite-preview-close"), $("#cite-preview-insert")].filter(b => !b.disabled);
        if (!controls.length) return;
        const index = controls.indexOf(document.activeElement);
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    });
    window.addEventListener("pagehide", () => { if (!citeBusy) closeCitePreview(false); });

    /**
     * 확인 → **서버 먼저**.
     *
     * ① 같은 검사의 비-keepalive 초안 저장이 나가 있으면 그것이 끝난 뒤에 보낸다(B1).
     *    먼저 보내면 T0만 실은 그 저장이 나중에 도착해 방금 확인한 문장을 지운다.
     * ② 요청 본문은 세 칸 + 삽입될 문장이 이미 붙은 값이다. textarea는 아직 그대로다.
     * ③ 응답의 본문을 화면에 대입하지 않는다(서버도 본문을 돌려보내지 않는다).
     * ④ 200을 받고 **그 요청이 떠날 때의 선택·창일 때만** 글자를 붙인다(A→B→A 포함).
     * ⑤ 그 밖의 모든 출구에서는 수렴 표시를 남긴다 — 무엇이 기록됐는지 모르기 때문이다.
     */
    async function insertCitation() {
      const pane = citePane;
      if (!pane || citeBusy) return;
      const void_ = () => pane.uid !== selectedUid || pane.seq !== citeSeq || pane.selSeq !== selectionSeq;
      if (void_()) {
        $("#cite-preview-status").textContent = "검사가 바뀌었습니다 — 이 창을 닫고 다시 확인하세요.";
        $("#cite-preview-insert").disabled = true;
        return;
      }
      const why = citationInsertBlock();
      if (why) { pane.status = why; renderCitePreview(); return; }
      const field = $("#cite-preview-field").value;
      if (!RFIELDS.includes(field)) return;
      // 같은 칸에 같은 출처를 또 넣는 것은 거절이 아니라 **한 번의 경고**다.
      if (!pane.warned && citations.duplicate(pane.uid, field, pane)) {
        pane.warned = true;
        pane.status = "이 칸에 같은 출처를 이미 인용했습니다. 그래도 넣으려면 한 번 더 누르세요.";
        renderCitePreview();
        return;
      }
      setCiteBusy(true);
      pane.status = "서버에 기록하는 중…";
      renderCitePreview();
      // 이 삽입을 시작한 문맥(세션·작업 세대). 검사와 창의 세대는 void_()와 아래 epoch이 본다.
      const at = work.capture("document");
      try {
        // 앞서 나간 초안 저장이 끝난 뒤에 화면을 다시 본다 — 그 저장이 올린 revision 위에 이 삽입이 선다(명령은 차례로 나간다).
        await draftClient.settled(pane.uid);
        if (!work.admits(at)) return;
        // 아직 아무것도 보내지 않았다 — 서버 행은 앞선 저장이 남긴 그대로이므로 수렴 표시는
        // 필요 없다. 창만 닫고 넣지 않았다는 사실을 말한다.
        if (void_()) {
          closeCitePreview(false);
          toast("검사가 바뀌어 인용을 넣지 않았습니다 — 그 검사로 돌아가 다시 확인하세요.", "err");
          return;
        }
        const why2 = citationInsertBlock();
        if (why2) { pane.status = why2; renderCitePreview(); return; }
        /**
         * **보여준 자리로만 보낸다**(D-9). 미리보기를 연 뒤 이 칸이 갈렸거나 보호할 인용이
         * 달라졌으면 지금 넣을 자리는 사람이 읽은 그 자리가 아니다. 그때는 **아무것도 보내지 않고**
         * 새 자리를 보여준 뒤 한 번 더 누르게 한다 — 판독문은 한 글자도 움직이지 않는다.
         */
        const plan2 = citationPlan(field, pane.block);
        if (!pane.plan || plan2.text !== pane.plan.text) {
          pane.plan = plan2;
          pane.status = "판독문이나 삽입 위치가 그 사이 바뀌었습니다 — 위의 삽입 위치를 다시 확인하고 한 번 더 누르세요.";
          renderCitePreview();
          return;
        }
        const content = Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value]));
        // 구분자(LF)는 `insertedText` 바깥이다. 증언이 가리키는 것은 그 블록뿐이고,
        // 보내는 문자열과 화면에 들어갈 문자열은 **이 계획 하나**에서 나온다.
        const before = content[field];
        content[field] = plan2.text;
        const a = appState[pane.uid] ?? {};
        const baseVersion = reportBaseVersion(pane.uid, a.draft?.baseVersion ?? a.version ?? 0);
        const epoch = { uid: pane.uid, selSeq: selectionSeq, seq: pane.seq };
        insertInFlight = true;
        /**
         * 나가 있는 전용 읽기의 표를 **보내기 직전에** 버린다. 그 답은 이 삽입 **전의** 행을
         * 말하므로, 뒤늦게 도착해 확인됨으로 굳으면 새 `cid`가 빠진 유지 목록이 만들어진다.
         */
        citationReads.delete(pane.uid);
        const pristine = pristineEditor(pane.uid);
        // 쓰기는 초안의 명령 경로로 간다: 작성자·초안 revision·전체 원문에 이 삽입을 실어 한 번에 기록한다.
        const result = await draftClient.write(pane.uid, { ...content, baseVersion }, { owner: draftOwner, context: at,
          operation: { insert: { field, findingId: pane.findingId, findingRevision: pane.findingRevision,
            sourceIndex: pane.sourceIndex, insertedText: pane.block,
            expectedLinkState: pane.linkState, expectedHeadRevision: pane.headRevision } } });
        // 이 삽입이 세운 표시는 이 삽입이 내린다(자기 것만).
        insertInFlight = false;
        wakeIdle();
        if (result.outcome !== "saved") {
          const untouched = insertLeftNoText(pristine, result);
          work.commit(at, () => {
            // 판독문은 한 글자도 바뀌지 않았다. 다만 이 요청이 서버에 닿았는지는 알 수 없으므로
            // 다음 자동 저장이 서버 행을 화면에 맞추도록 표시하고, 인용 상태는 **모르는 것**으로
            // 되돌린다 — 아는 척하는 유지 목록이 그 사이 기록된 증언을 지울 수 있다. 서버가 기록하지 않았다고
            // 분명히 답했고 고친 글도 없으면 표시는 삽입 전 그대로다.
            if (untouched) reportConverge.delete(epoch.uid); else markConverge(epoch.uid);
            invalidateCitations(epoch.uid);
            // 이 요청이 서버에 닿았는지 모르는 것은 구조화 쪽도 같다. 같은 자리에서 같이 되돌린다.
            invalidateStructure(epoch.uid);
            pane.status = "인용하지 못했습니다: " + draftFailureText(result) + " — 판독문은 그대로입니다.";
            renderCitePreview();
            if (result.code === "REPORT_CITATION_STALE" || result.code === "REPORT_CITATION_SOURCE")
              toast("소견이 그 사이 바뀌었습니다 — Image Findings에서 Reload Findings를 누른 뒤 다시 인용하세요", "err");
          });
          draftNotSaved(epoch.uid, at, result, { quiet: true, converge: !untouched });
          return;
        }
        const answer = result.answer.body;
        if (!work.admits(at)) return;
        appState[pane.uid] = { ...appState[pane.uid], draftRevision: result.envelope.revision };
        if (epoch.uid !== selectedUid || epoch.selSeq !== selectionSeq || epoch.seq !== citeSeq) {
          markConverge(epoch.uid);
          // 서버는 문장과 증언을 기록했을 수 있는데 화면은 그 `cid`를 쓰지 못했다.
          // 확인됨으로 남겨 두면 다음 저장의 유지 목록이 바로 그 증언을 지운다.
          invalidateCitations(epoch.uid);
          invalidateStructure(epoch.uid);
          // 이 창은 떠난 검사의 것이다. 지금 화면에 남겨두면 다음 확인이 **다른 환자의**
          // 판독문에 그 문장을 넣는다. 거절과 달리 여기서는 읽을 이유도 없다.
          closeCitePreview(false);
          toast("다른 검사로 옮기기 전에 누른 인용의 응답이 늦게 도착해 화면에 반영하지 않았습니다. " +
                "그 검사를 다시 열어 인용 목록에서 확인하세요.", "err");
          return;
        }
        // 기존 삽입 기전 그대로다 — 목록 삽입도 타이핑처럼 점유를 시작해야 한다.
        // 달라진 것은 자리뿐이고, 들어가는 문자열은 방금 서버에 보낸 그 문자열이다.
        const el = $("#" + field);
        const shown = screenPlan(field, pane.block, before, plan2);
        // 커서는 넣은 글 끝에 선다. 가운데에 넣고 화면 끝으로 튀면 사람이 자기 글을 다시 찾아야 한다.
        editReport([reportEditOf(field, shown.text, shown.end)]);
        // 서버 행은 방금 우리가 보낸 세 칸이다. 초안 표시가 그 사실을 말하게 한다.
        // A confirmed insertion does not confirm later typing in any of the three fields.
        if (sameDraftText(appState[pane.uid]?.draft, { ...content, baseVersion })) reportConverge.delete(pane.uid);
        /**
         * B2: **확인된 상태만** 넓힌다. 확인 전이었다면 한 건짜리 목록을 지어내지 않는다 —
         * 그 목록을 실어 보내면 화면이 본 적 없는 나머지 증언이 전부 지워진다.
         * 그리고 넓히지 못했다면 이 행에 무엇이 들어 있는지 여전히 모르므로, 아는 척하는
         * 유지 목록이 방금 기록된 증언을 지우지 않도록 초안 쪽을 모르는 상태로 되돌린다.
         * 다음 전용 읽기 한 번이 서버의 바이트로 그것을 채운다.
         */
        const extended = !!answer?.inserted?.cid &&
          citations.extend(pane.uid, { v: KinReportCitation.SCHEMA, cid: answer.inserted.cid, field,
            findingId: pane.findingId, findingRevision: pane.findingRevision, sourceIndex: pane.sourceIndex,
            linkStateAtInsert: pane.linkState, headRevisionAtInsert: pane.headRevision,
            insertedText: pane.block, insertedAt: answer.inserted.insertedAt, insertedBy: null,
            mine: true, sameTextCount: 1 });
        if (!extended) invalidateCitations(pane.uid);
        /**
         * 인용 삽입은 **본문을 바꿨다.** 구조화 건의 존재 상태는 그 본문에 대해 계산되므로
         * 지금 화면이 들고 있는 상태는 옛 것이다. 값이 바뀐 것은 없지만 "그 문장이 아직
         * 본문에 있는가"의 답은 바뀔 수 있으므로 다시 묻는다.
         */
        invalidateStructure(pane.uid);
        /**
         * 인용을 건넨 목록은 판독문 **위에** 떠 있다 — 관련 영역이 가진 고정 패널이라 열어도
         * 목록·판독문·영상의 배치를 바꾸지 않는 대신, 화면의 그 자리를 덮는다. 서버가 받아
         * 준 뒤에도 그대로 열려 있으면 방금 들어간 문장도, 그 문장을 세는 인용 표시줄도 그
         * 패널 뒤에 가려 사람은 자기가 한 일을 읽지 못하고 그 줄의 단추를 누르지도 못한다.
         * 그래서 **서버가 받아들인 삽입에서만** 그 패널이 물러나고, 초점은 글이 들어간 칸으로
         * 간다. 거절·중복 경고·늦은 응답에서는 그대로 둔다 — 그때 다음 누름은 그 목록에서
         * 나오기 때문이다.
         */
        if (typeof pane.inserted === "function") {
          try { pane.inserted(); } catch (_) { /* 패널이 없어도 판독문 쪽은 이미 끝났다 */ }
          citeReturn = el;
        }
        closeCitePreview();
        renderDraftBar();
        toast("판독문에 넣었습니다 — 같은 저장에 출처 증언이 함께 기록됐습니다", "ok");
      } finally {
        // 이 삽입이 잠근 창의 단추는 이 삽입이 푼다(자기 것만). 창을 다시 그리는 것은 문맥이 그대로일 때만 한다.
        setCiteBusy(false);
        work.commit(at, () => { if (citePane) renderCitePreview(); });
      }
    }
    $("#cite-preview-insert").addEventListener("click", insertCitation);

    /**
     * 이 페이지가 열린 계정({ 기관, 사용자 ID, 작성자 }, 시작할 때 한 번 정하고 바꾸지 않는다). 초안을 바꾸는 요청마다
     * `expectedOwner`로 실어 보내면 서버가 지금 세션의 계정과 대조한다(S7-U5): 이 페이지의 글이 다른 사람의 초안을 만들거나
     * 덮거나 지우지 않는다. 계정을 정하는 값이 아니라 대조할 값이다 — 권한과 작성자는 서버가 세션에서 정한다.
     */
    let draftOwner = null;

    /** 두 초안 사본이 같은 글인가(세 칸과 기준 판). 둘 다 없으면 같다. */
    function sameDraftText(a, b) {
      if (!a || !b) return !a && !b;
      return RFIELDS.every(k => (a[k] ?? "") === (b[k] ?? "")) && a.baseVersion === b.baseVersion;
    }

    /**
     * 판독문 초안 저장. 사용자가 누르지 않아도 나가는 요청이다 — 검사 이동·인쇄·자동 저장·탭 닫기.
     *
     * 초안은 `Report`가 아니라 내 `ReportDraft` 행에 들어가므로 남의 확정본도 남의 초안도 건드릴 수 없다. 그래도 **내 행을
     * 두고는 겨룬다**(S7-U5): 같은 계정의 다른 탭, 끊긴 뒤 늦게 닿은 내 요청, 그 사이의 버리기·확정. 그래서 쓰기마다 이 글이
     * 딛고 선 초안 revision을 싣고(draftClient) 서버는 그 revision일 때만 받는다. 어긋나면 충돌이고, 그때는 스스로 다시
     * 보내지 않는다 — 글은 화면에 그대로 두고 초안 표시줄에서 사람이 고른다.
     *
     * `keepalive`는 탭이 닫히는 중에도 요청이 끝까지 가게 한다(beforeunload용). 그 답은 볼 수 없다.
     *
     * 결과: 서버가 이 쓰기를 받았음을 답으로 확인했으면(비서버 모드는 로컬 저장) "saved"로 끝난다. 값 없이 끝나면 저장을
     * 확인한 것이 없다 — 보낼 것이 없었거나, 남의 점유·권한·오프라인·삽입 중 미룸으로 보내지 않았거나, 서버가 거절했거나,
     * 충돌했거나, 결과를 모른다. 확인되지 않은 글은 수렴 표시로 남아 다음 저장이 다시 가져간다.
     */
    async function stashReport({ keepalive = false } = {}) {
      if (!selectedUid) return;
      const uid = selectedUid;
      const a = appState[uid] ?? {};
      const next = {
        findings: $("#findings").value,
        conclusion: $("#conclusion").value,
        recommendation: $("#recommendation").value,
      };
      // 검사를 옮겨다닐 때마다 호출되므로, 바뀐 게 없으면 서버를 부르지 않는다.
      // 다만 버려진 삽입 뒤에는 글자가 같아 보여도 서버 행이 다를 수 있다(B3) —
      // 그때는 명시 표시가 이 비교를 이긴다. 그러지 않으면 갈라짐이 영영 남는다.
      if (!reportNeedsWrite()) return;

      /**
       * **가려진 판독문은 저장하지 않는다.**
       * 남의 예비 판독(RS=P)이면 화면은 빈 칸이다. 그 빈 칸을 초안으로 보내면
       * 내 초안이 남의 판독문 자리에 생긴다. 서버도 403으로 막는다.
       * 판독 권한이 없을 때(기사)도 같은 이유로 보내지 않는다.
       */
      if (!KinAuth.has("radiologist")) return;
      const empty = RFIELDS.every(k => !next[k]);
      // 화면에 그려진 판이 기준이다. 초안이 아직 없을 때도 마찬가지다 —
      // 첫 자동 저장이 남의 판 번호를 기준으로 박아두면 그 뒤 모든 판단이 그 위에 선다.
      const baseVersion = reportBaseVersion(uid, a.draft?.baseVersion ?? a.version ?? 0);
      // Keep an unconfirmed clear as an empty edit; only a confirmed clear may reveal the final report.
      const draft = { ...next, baseVersion, at: new Date().toISOString() };
      /**
       * **삽입이 나가 있는 동안 비켜서는 것은 쓰기뿐이다 (B1).**
       *
       * 타이머만 막는 것으로는 부족하다 — 검사 이동도 이 함수를 부른다. 그러나
       * 이 함수보다 먼저 빠져나가면 **화면의 글자를 담아 두는 일까지** 건너뛴다. 그러면
       * 검사가 바뀌는 순간 `loadReport({force:true})`가 textarea를 옛 초안으로 덮고,
       * 아직 저장되지 않은 타건은 어디에도 남지 않는다. 담아 두는 일은 하고, 네트워크
       * 요청만 미룬다. 미룬 사실은 수렴 표시로 남아 다음 저장이 서버를 화면에 맞춘다.
       *
       * `keepalive`는 예외다 — 탭이 닫히는 중에는 보내는 것 자체가 마지막 기회다.
       */
      const deferWrite = insertInFlight && !keepalive;
      appState[uid] = { ...a, draft };
      // 화면에 담아 둔 글은 아직 저장된 것이 아니다. 저장이 확인될 때까지 수렴 표시를 세워 둔다 — 미룬 쓰기, 거절, 결과를
      // 모르는 쓰기, 로그아웃 준비가 버린 답 뒤에도 다음 저장이 이 글을 다시 가져간다.
      if (!demoMode) reportConverge.add(uid);
      if (selectedUid === uid) renderDraftBar();
      draftClient.keep(uid, { ...next, baseVersion });
      if (deferWrite || offline || a.prelimHidden || heldByOther(cur()) || (serverMode && draftClient.conflict(uid))) return;
      if (!serverMode) { if (empty) appState[uid].draft = null; saveApp(); reportConverge.delete(uid); return "saved"; }

      return saveReportDraft(uid, { keepalive });
    }

    /**
     * 줄 서 있던 초안 쓰기의 차례가 왔다: 이 검사에서 **지금** 보낼 글(없으면 null). 쓰기를 세울 때의 글이 아니다.
     *
     * 쓰기는 그 검사의 앞선 명령 뒤에 줄을 선다. 줄 서 있는 동안 앞선 확정이 그 글을 판독문으로 받아들였거나 사람이 그
     * 초안을 버렸을 수 있다 — 세울 때의 글을 그대로 보내면 서버는 새 revision 위의 그 쓰기를 받아들이고, 방금 저장한 글이
     * "저장 안 된 초안"으로, 버린 글이 초안으로 되살아난다. 그래서 차례가 왔을 때의 기록으로 정한다(글을 견주지 않는다):
     *   · 그 검사에 확인되지 않은 글이 있다는 표시(`reportConverge`)가 내려가 있으면 보낼 것이 없다. 받아들여진 확정과
     *     버리기는 그 답을 받은 자리에서 "누른 뒤에 고친 글이 있는가"(편집 차례)로 표시를 정한다 — 그 자리는 뒤에 줄 선
     *     쓰기의 차례보다 먼저 실행된다(초안 명령 경로는 앞 명령의 결과를 부른 쪽에 돌려준 뒤에 다음 명령을 시작한다).
     *   · 표시가 있으면 그 검사의 지금 글을 보낸다: 고른 검사는 편집기의 글, 떠난 검사는 담아 둔 사본. 누른 뒤에 친 글은
     *     여기에 있고, 그 기준 판도 받아들여진 확정이 올린 새 판이다.
     *   · 결과를 모르는 확정이 남아 있으면 그 글을 초안으로 쓰기 전에 서버의 판독 상태부터 읽는다(`learnCommitOutcome`).
     *     읽지 못하면 보내지 않는다 — 표시는 그대로라 글은 지켜지고 다음 저장이 다시 확인한다.
     * 이 쓰기를 세운 문맥이 끝났으면(로그아웃 준비·세션 종료) 일반 쓰기는 더 나가지 않는다.
     */
    async function reportTextToSend(uid, at) {
      if (!work.admits(at)) return null;
      if (reportUnknownCommits.has(uid) && (await learnCommitOutcome(uid, at)).outcome === "unknown") return null;
      if (!work.admits(at) || !reportConverge.has(uid)) return null;
      return unconfirmedReport(uid);
    }

    async function saveReportDraft(uid, { keepalive = false } = {}) {
      const at = work.capture("document");
      const textsOf = draft => ({ ...Object.fromEntries(RFIELDS.map(k => [k, draft[k] ?? ""])), baseVersion: draft.baseVersion });
      if (keepalive) {
        // 탭이 닫히는 중이라 응답을 볼 수 없다. 기준과 유지 목록을 이미 알 때만 보낼 수 있다 — 보내는 것까지가 우리 몫이다.
        const closing = appState[uid]?.draft;
        if (closing) draftClient.writeOnUnload(uid, textsOf(closing), { owner: draftOwner, context: at });
        return;
      }
      // 보낸 글(차례가 왔을 때 정해진다). 답이 무엇을 확인했는지는 이것과 견준다.
      let draft = null;
      const bind = async () => {
        try { draft = await reportTextToSend(uid, at); } catch (error) { console.error(error); draft = null; }
        return draft && textsOf(draft);
      };
      const result = await draftClient.write(uid, bind, { owner: draftOwner, context: at });
      if (result.outcome !== "saved") {
        // 같은 글의 같은 실패는 처음 한 번만 알린다. 서버가 그 검사에 쓸 수 없다고 답했으면 자동 저장도 멈춘다(위 설명).
        const failed = ["refused", "unknown", "owner"].includes(result.outcome) && result.code !== "REPORT_HELD";
        // 다시 보내도 같은 답인 거절: 권한(403)·보이지 않는 검사(404)·받을 수 없는 내용이나 상태(400·409·410·413·422).
        // 세션 저장소가 잠깐 바빴다는 409(AUTH_SESSION_BUSY)는 그 검사나 그 글에 대한 답이 아니다 — 지나가는 실패다.
        const standing = result.outcome === "owner"
          || (result.outcome === "refused" && result.code !== "AUTH_SESSION_BUSY"
              && [400, 403, 404, 409, 410, 413, 422].includes(result.answer?.status));
        // 표시는 이 쓰기가 떠날 때 이미 섰다. 그 사이 사람이 서버 것을 골랐거나 확정이 그 글을 받아들여 표시가 내려갔다면
        // (확정이 나가 있는 동안 검사를 옮겨 이 쓰기가 그 뒤에 줄 섰을 때), 이 쓰기가 실었던 글은 더는 확인을 기다리는 글이
        // 아니다: 늦게 온 이 실패는 표시를 되살리지 않고, 저장 실패로 알릴 일도 아니다.
        const moot = !reportConverge.has(uid);
        draftNotSaved(uid, at, result, { quiet: moot || (failed && reportSaveFailures.has(uid)), converge: false });
        if (failed && !moot) work.commit(at, () => {
          reportSaveFailures.set(uid, standing ? "stop" : "retry");
          if (uid === selectedUid) renderDraftBar();
        });
        return;
      }
      return work.commit(at, () => {
        const now = appState[uid] ?? {};
        const empty = RFIELDS.every(k => !draft[k]);
        appState[uid] = { ...now, draftRevision: result.envelope.revision };
        reportSaveFailures.delete(uid);
        // 결과를 모르는 확정과 이 쓰기는 같은 초안 revision을 두고 겨뤘다. 서버가 이 쓰기를 받아 revision이 넘어갔으면 그
        // 확정은 이제 닿아도 거절된다 — 더 확인할 것이 없다.
        if (reportUnknownCommits.has(uid) && reportUnknownCommits.get(uid).revision !== result.envelope.revision)
          reportUnknownCommits.delete(uid);
        // 서버 행이 방금 보낸 글자와 같아졌다. 수렴 표시는 여기서만 내린다 — 그 사이 더 새 글을 담아 두었으면(다음 저장이
        // 줄 서 있다) 그 글은 아직 확인되지 않았으므로 그대로 둔다.
        const current = now.draft ?? { ...now, baseVersion: reportBaseVersion(uid, now.version ?? 0) };
        // 확인된 글이 지금 담아 둔 그 글이면 확인한 시각을 적는다 — 표시줄의 "…에 자동 저장됨"이 말하는 시각이다.
        if (now.draft && sameDraftText(now.draft, draft)) appState[uid].draft = { ...now.draft, at: new Date().toISOString() };
        if (sameDraftText(current, draft)) reportConverge.delete(uid);
        // 비운 초안은 서버에서 행이 지워진다 — 그 행의 인용도 함께 없어진 것이 사실이다.
        if (empty) {
          if (sameDraftText(now.draft, draft)) appState[uid].draft = null;
          citations.emptied(uid); structureState.emptied(uid);
        }
        if (uid === selectedUid) renderDraftBar();
      }) ? "saved" : undefined;
    }

    /**
     * 표시된 검사의 확인되지 않은 글: 고른 검사는 편집기의 글(방금 담았다), 그 밖의 검사는 떠날 때 담아 둔 사본이다. 표시는
     * 있는데 담아 둔 글이 없으면 기록이 어긋난 것이다(있어서는 안 되는 상태). 그때 저장된 판독문을 초안인 것처럼 지어내
     * 보내지 않는다(U5CLI-F10) — 이 문서가 지킬 글이 없으므로 표시를 내리고, 조용히 넘기지 않게 콘솔에 오류로 남긴다.
     * 그 검사는 그 뒤 서버의 상태를 그대로 받는다.
     */
    function unconfirmedReport(uid) {
      if (uid === selectedUid) keepReportEditor();
      const draft = appState[uid]?.draft;
      if (draft) return draft;
      reportConverge.delete(uid);
      reportSaveFailures.delete(uid);
      console.error("KIN report draft: a study was marked as holding unconfirmed text but no local text was kept", uid);
      return null;
    }

    // Reconnect and later autosaves reconcile every retained edit, even when its study is no longer in the list.
    function reconcileReportDrafts() {
      if (!serverMode || offline || demoMode || commitInFlight || insertInFlight || work.state() !== "active"
          || !KinAuth.has("radiologist")) return;
      for (const uid of [...reportConverge]) {
        const draft = unconfirmedReport(uid);
        if (!draft) continue;
        const a = appState[uid];
        if (a.prelimHidden || (a.holder && a.holder !== user) || draftClient.busy(uid)) continue;
        const conflict = draftClient.conflict(uid);
        if (conflict) {
          draftClient.keep(uid, draft);
          if (!conflict.latest) readDraftConflict(uid);
          continue;
        }
        // 서버가 이 검사에 쓸 수 없다고 답한 글은 다시 보내지 않는다 — 글은 그대로 있고, 고치면 다시 시도한다.
        if (reportSaveFailures.get(uid) === "stop") continue;
        saveReportDraft(uid);
      }
    }

    /**
     * 이 문서가 고른 검사의 편집기 글을 바꿨다는 기록. 사람의 타건(input)과 프로그램의 쓰기(`editReport`)가 같은 것을 남긴다:
     * 표시를 세우고, 그 글을 그 검사의 사본에 담는다 — 보낼 수 없는 사정(충돌·오프라인·점유·삽입 중)이 있어도 가장 새 글이
     * 버려질 수 있는 textarea에만 남지 않게 한다. 새로 고친 글은 서버가 앞서 거절한 그 글이 아니므로 자동 저장도 다시 시도한다.
     * 검사마다 마지막으로 고친 차례도 적는다 — 나가 있던 확정의 답이 "그 뒤에 고친 글이 있는가"를 글을 견주지 않고 안다.
     */
    let reportEdits = 0;
    const reportEditedAt = new Map();
    /** 그 편집 차례(`turn`) 뒤에 이 문서가 그 검사의 글을 더 고쳤는가. 기록된 편집으로 답한다 — 글을 견주지 않는다. */
    function reportEditedSince(uid, turn) { return (reportEditedAt.get(uid) ?? 0) > turn; }
    function recordReportEdit() {
      if (work.state() !== "active" || !selectedUid) return;
      reportEditedAt.set(selectedUid, ++reportEdits);
      reportConverge.add(selectedUid);
      reportSaveFailures.delete(selectedUid);
      keepReportEditor();
    }
    for (const field of RFIELDS) $("#" + field).addEventListener("input", recordReportEdit);

    /**
     * 계획이 낸 **칸 전체의 새 글**을, 지금 글에서 달라지는 한 구간의 편집으로 옮긴다(앞뒤의 같은 글자는 건드리지 않는다).
     * 적용한 결과는 그 계획의 글과 글자까지 같다 — 삽입 자리 규칙(placeBlock·구조화 계획)은 그 계획들이 그대로 정한다.
     */
    function reportEditOf(field, text, caret) {
      const was = $("#" + field).value, shared = Math.min(was.length, text.length);
      let start = 0, tail = 0;
      while (start < shared && was[start] === text[start]) start += 1;
      while (tail < shared - start && was[was.length - 1 - tail] === text[text.length - 1 - tail]) tail += 1;
      return { field, start, end: was.length - tail, text: text.slice(start, text.length - tail), caret };
    }

    function keepReportEditor() {
      const uid = selectedUid;
      if (!uid || !reportConverge.has(uid)) return;
      const a = appState[uid] || {};
      const texts = { ...Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value])),
        baseVersion: reportBaseVersion(uid, a.draft?.baseVersion ?? a.version ?? 0) };
      appState[uid] = { ...a, draft: { ...texts, at: a.draft?.at ?? null } };
      draftClient.keep(uid, texts);
    }

    /**
     * 판독문 확정. action: save | approve | addendum | reset
     * 서버 모드에서는 내용·버전·RS가 한 요청으로 함께 간다 — 따로 보내면 순서가 뒤집혀
     * "승인됐는데 내용은 이전 것"이 될 수 있다.
     */
    /**
     * 확정이 나가 있는 동안 다른 것이 끼어들면 안 된다.
     *
     * ① 자동 저장 — 같은 검사에 초안이 겹쳐 나간다.
     * ② 30초 폴링 — t=0.9s 폴링 요청 → t=1.0s Approve → t=1.2s commit 응답(rs=A) →
     *    t=1.5s **폴링 응답(rs=T)이 rs·repDoc·confirm을 덮는다.** 워크리스트가 A→T로
     *    되돌아가고, 판독의는 "저장이 안 됐나?" 하고 Approve를 또 누른다.
     * ③ 버튼 중복 클릭 — 같은 baseVersion으로 두 POST가 나가면 **둘째가 자기 자신 때문에**
     *    "그 사이 다른 사용자가 저장했습니다"를 띄운다. 오탐 충돌은 진짜 경고의 신뢰를 깎는다.
     */
    let commitInFlight = false;
    /**
     * 확정이 일어난 횟수. 폴링이 "내 요청을 보낸 뒤 확정이 있었는가"를 알려면
     * 플래그만으로는 부족하다 — 폴링 요청과 응답 **사이에** 확정이 시작되고 끝나면
     * 두 시점 모두 `commitInFlight === false`다. 그 창으로 낡은 상태가 들어온다.
     */
    let commitEpoch = 0;

    /**
     * 서버가 받아들인 확정을 이 문서의 상태에 옮긴다. 확정의 답에서 오거나, 답을 잃은 확정이 서버에 기록돼 있음을 읽어서
     * 알았을 때 온다(`learnCommitOutcome`) — 어느 쪽이든 같은 일이다. `sentAt`은 그 확정이 싣고 간 글까지의 편집 차례다.
     *
     * 확정이 나가 있는 동안 이 문서가 그 검사의 글을 더 고쳤으면(기록된 편집이다 — 글을 견주어 짐작하지 않는다) 그 글은
     * 이 확정이 받아들인 글이 아니다. 확정본으로 다시 그리면 말없이 사라진다. 그래서 새 판 위의 확인되지 않은 글로
     * 남긴다: 고른 검사면 편집기의 글을 그대로 두고, 떠난 검사면 떠날 때 담아 둔 사본을 지킨다 — 다음 자동 저장·검사
     * 이동·로그아웃이 그 글을 초안으로 가져간다. 그 글을 확정본에 넣지도, 스스로 추가기재하지도 않는다: 사람이
     * 확정을 누른 글은 떠날 때의 그 글이다. 대신 갈라졌다는 사실을 말한다 — 지금은 완료 안내가, 그 뒤로는 초안
     * 표시줄이(U5CLI-F11). 그 뒤에 고친 글이 없으면 그 검사에 확인되지 않은 글은 없다: 표시가 내려가고, 확정 뒤에 줄 서
     * 있던 쓰기(확정이 나가 있는 동안 검사를 옮겼다)는 차례가 와도 보낼 글이 없다 — 방금 판독문이 된 글이 초안으로 다시
     * 서지 않는다. 그 확정이 싣지 않은 글이 남았는지를 돌려준다.
     */
    function applyAcceptedCommit(uid, st, sentAt) {
      const later = reportEditedSince(uid, sentAt)
        ? (uid === selectedUid ? Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value])) : appState[uid]?.draft) : null;
      // 서버가 받아들인 확정이다: 확정이 나가 있는 동안 검사를 옮겨 그 검사의 쓰기가 뒤에 줄 서 있어도 실패로 알리지 않는다.
      appState[uid] = replaceReportState(uid, st, { confirmed: true });
      reportUnknownCommits.delete(uid);
      syncStudy(uid);
      /**
       * 확정은 머리 판과 초안 행을 **함께** 움직였다. 화면이 들고 있던 인용 집합은
       * 그 순간 옛 것이므로 "모르는 상태"로 되돌리고, 아래 `loadReport`가 부르는
       * 전용 읽기가 새 머리 판의 증언을 다시 가져온다.
       */
      citations.forget(uid);
      citationNotes.delete(uid);
      // 확정은 초안 행을 지우고 새 머리 판을 만들었다. 화면이 들고 있던 구조화 집합은
      // 그 순간 전부 옛 것이므로 버리고, 아래 `loadReport`의 전용 읽기가 **새 머리 판의**
      // 건을 다시 가져온다 — 그래야 Save 한 번 뒤에도 값이 화면에 남는다.
      structureState.forget(uid);
      structureNotes.delete(uid);
      reportConverge.delete(uid);
      if (later) {
        appState[uid] = { ...appState[uid], draft: { ...Object.fromEntries(RFIELDS.map(k => [k, later[k] ?? ""])),
          baseVersion: reportBaseVersion(uid, st.version ?? 0), at: null } };
        reportConverge.add(uid);
      }
      // 확정 응답은 내가 방금 선택한 서버 상태다. 여기서는 입력 보호보다 그 결과가 우선한다 — 그 확정이 싣지 않은,
      // 나가 있는 동안 고친 글만 예외다(위).
      loadReport({ force: !(later && uid === selectedUid) });
      return !!later;
    }

    /** 받아들여진 확정의 완료 안내. `lateText`는 그 확정이 싣지 않은, 누른 뒤에 친 글이 남았다는 뜻이다. */
    function announceCommit(uid, action, reason, lateText) {
      const done = {
        save: "임시 저장했습니다 (RS: T)",
        defer: `보류했습니다 (RS: H) — ${reason}`,
        approve: "판독문을 승인했습니다 (RS: A)",
        addendum: "추가기재를 저장했습니다 — 이전 승인본은 그대로 남습니다",
        reset: "판독을 취소했습니다 (RS: W). 사유가 이력에 기록됐습니다",
        preliminary: "예비 판독으로 넘겼습니다 (RS: P) — 지정한 상급 판독의만 내용을 볼 수 있습니다",
      }[action];
      if (!lateText) { toast(done, action === "reset" ? "info" : "ok"); return; }
      /**
       * 확정은 됐고, 그 확정이 싣지 않은 글이 화면에 남았다. "승인했습니다"만 말하면 판독의는 마지막에 친 문장도 승인된
       * 줄 안다(U5CLI-F11). 무엇이 들어가지 않았는지를 같은 안내에서 말한다 — 실패가 아니므로 오류 색을 쓰지 않고, 읽을
       * 시간을 준다. 그 뒤로는 초안 표시줄이 같은 사실을 계속 말한다. 그 검사를 떠나 있었으면 어느 검사인지부터 말한다
       * (로그아웃 창과 같은 표기).
       */
      const missed = action === "approve" ? "Approve를 누른 뒤 입력한 글은 승인된 판독문에 포함되지 않았습니다"
        : action === "addendum" ? "Addendum을 누른 뒤 입력한 글은 승인된 판독문에 포함되지 않았습니다"
        : "단추를 누른 뒤 입력한 글은 저장된 판독문에 포함되지 않았습니다";
      if (uid === selectedUid) {
        toast(`${done}. ${missed} — 그 글은 초안으로 화면에 남아 있습니다.`, "info", 12000);
        return;
      }
      // 그 검사를 떠나 있다: 그 검사의 표시줄이 보일 때까지 이 안내가 유일한 자리이므로 사라지게 두지 않는다(U5CLI-F13).
      noteLeftStudy(uid, `${studyLabel(uid)} — ${done}. ${missed} — 그 검사를 열면 초안으로 남아 있습니다.`);
    }

    /**
     * 결과를 모르는 확정(답을 잃었거나 한도를 넘겼다). **모르는 것은 "되지 않은 것"이 아니다**: 서버가 그 글을 이미
     * 판독문으로 기록했을 수 있다. 그런데 그 검사의 글에는 "확인되지 않았다"는 표시가 그대로 있어서, 다음 자동 저장·검사
     * 이동·로그아웃이 방금 확정된 글을 옛 판을 기준으로 한 초안으로 다시 써 넣었다 — 다시 열면 저장된 글이 "저장 안 된
     * 초안"으로 보이고, 다음 Save는 자기 자신이 저장한 판과 충돌한다.
     *
     * 그래서 사실을 적어 둔다: 어느 검사에, 어느 편집 차례까지의 무슨 글을, 어느 판 위에 확정하려 했는가(`sentAt`·`texts`·
     * `baseVersion`), 그 확정이 실은 초안 revision은 무엇이었나(`revision`). 그 기록이 있는 동안 그 검사의 글을 초안으로
     * 쓰려는 길은 모두 먼저 서버의 판독 상태를 읽는다(`learnCommitOutcome`). 초안 행이 없어진 것만으로는 확정됐다고 하지
     * 않는다(다른 창의 버리기일 수 있다 — 그때 표시를 내리면 글을 잃는다).
     */
    const reportUnknownCommits = new Map();
    /**
     * 결과를 모르는 확정이 서버에 있는가를 판독 상태 한 번의 읽기로 안다. 돌려주는 `outcome`:
     *   "landed"  — 그 판 뒤의 판독문이 보낸 글 그대로다. 받아들여진 확정이다: 누른 뒤에 고친 글이 없으면 그 검사에
     *               확인되지 않은 글은 없고(`later: false`), 있으면 그 글은 새 판(`version`) 위의 확인되지 않은 글이다.
     *   "absent"  — 서버의 판이 그대로이거나(아직 닿지 않았다) 다른 글의 판이 섰다(이 확정은 판 대조에 걸려 영영 닿지
     *               않는다). 그 글은 여전히 이 문서의 확인되지 않은 글이고, 초안으로 써도 된다 — 판이 그대로인 쪽은 늦게
     *               닿을 수 있어 기록을 남겨 두지만, 초안 쓰기와 그 확정은 같은 초안 revision을 두고 겨루므로 둘 다 설 수는
     *               없다(쓰기가 서면 그때 기록을 지운다 — `saveReportDraft`).
     *   "unknown" — 읽지 못했다. 아무것도 바꾸지 않고, 그 글을 초안으로 쓰지도 않는다(표시는 그대로라 글은 지켜진다).
     *   "none"    — 기록이 없다.
     * `at`은 이 읽기의 문맥이다(업무 중이면 문서 범위, 로그아웃 준비면 준비 문맥, 닫힌 문서의 Recover Draft면 수명주기
     * 문맥과 그 세션). 답을 쓰는 자리는 그 문맥을 지난다. 업무 중인 문서에서는 받아들여진 확정의 답과 똑같이 화면에
     * 옮기고(`applyAcceptedCommit`), 준비 중이거나 닫힌 문서에서는 화면을 그리지 않고 사실만 적는다 — 잡아 둔 원문을
     * 어떻게 할지는 부른 쪽(보존 저장·Recover Draft)이 그 답으로 정한다.
     */
    async function learnCommitOutcome(uid, at, session) {
      const sent = reportUnknownCommits.get(uid);
      if (!sent) return { outcome: "none" };
      // 같은 것을 묻는 읽기가 이미 나가 있고 그 문맥이 살아 있으면 그 답을 함께 쓴다(확정 직후의 읽기와 뒤에 줄 선 쓰기).
      if (sent.reading && sent.reading.session === session && work.admits(sent.reading.at)) return sent.reading.done;
      const done = readCommitOutcome(uid, sent, at, session);
      sent.reading = { at, session, done };
      try { return await done; } finally { if (sent.reading?.done === done) sent.reading = null; }
    }
    async function readCommitOutcome(uid, sent, at, session) {
      let st = null;
      try {
        const answer = await transport.request(API + "/bootstrap", { context: at, kind: "draft", ...(session ? { session } : {}) });
        if (answer.ok && !answer.incomplete) st = answer.body?.states?.[uid] ?? null;
      } catch (_) {}
      // 그 사이 다른 읽기나 확정이 이 기록을 이미 매듭지었으면 이 답으로 할 일이 없다.
      if (reportUnknownCommits.get(uid) !== sent) return { outcome: "none" };
      // 가려진 예비 판독은 본문을 주지 않는다 — 견줄 글이 없으므로 모르는 채로 둔다.
      if (!st || st.prelimHidden || !Number.isSafeInteger(st.version)) return { outcome: "unknown" };
      if (st.version <= sent.baseVersion) return work.admits(at) ? { outcome: "absent" } : { outcome: "unknown" };
      let learned = { outcome: "unknown" };
      work.commit(at, () => {
        if (RFIELDS.some(k => KinReportCitation.toLf(st[k] ?? "") !== KinReportCitation.toLf(sent.texts[k]))) {
          reportUnknownCommits.delete(uid);
          learned = { outcome: "absent" };
          return;
        }
        const later = reportEditedSince(uid, sent.sentAt);
        learned = { outcome: "landed", version: st.version, later };
        if (work.state() !== "active") {
          reportUnknownCommits.delete(uid);
          recordReportOrigin(uid, st.version);
          if (!later) reportConverge.delete(uid);
          else if (appState[uid]?.draft) appState[uid] = { ...appState[uid], draft: { ...appState[uid].draft, baseVersion: st.version } };
          return;
        }
        if (heldUid === uid) { heldUid = null; clearInterval(heartbeat); heartbeat = null; }   // 확정하면 서버가 점유를 푼다
        // 이 읽기보다 먼저 떠난 목록 읽기·폴링의 답은 그 확정 이전의 사진일 수 있다 — 확정의 답과 같이 그것들을 무효로 한다.
        commitEpoch += 1; listLoadSequence++;
        const lateText = applyAcceptedCommit(uid, st, sent.sentAt);
        render(); renderRelated(); updateReportButtons();
        announceCommit(uid, sent.action, sent.reason, lateText);
      });
      return learned;
    }

    async function commitReport(action, reason, reviewer) {
      if (!selectedUid) return;
      // 확정은 겹쳐 부르지 않는다. 더블클릭이 만든 판 하나가 더 쌓이는 걸 여기서 막는다.
      // 삽입이 나가 있는 동안도 같다 — 그 응답 전에 서명하면 사람이 확인한 문장이
      // 이번 판에 들어갈지 다음 판에 들어갈지가 도착 순서로 정해진다.
      if (commitInFlight || insertInFlight) return;
      /**
       * 이 검사에 결과를 모르는 확정이 남아 있으면, 같은 글을 또 확정하기 전에 서버가 무엇을 가졌는지부터 안다. 답을 잃은
       * 확정 뒤에 사람이 가장 먼저 하는 일이 같은 단추를 다시 누르는 것이다 — 그 확정이 서버에 있는데 옛 판을 기준으로
       * 또 보내면 "그 사이 (자기 자신)이 저장했습니다"라는 거절과 확인창을 만난다. 이미 확정돼 있었으면 화면이 그 상태로
       * 바뀌고 이 누름은 거기서 끝난다(같은 확정을 두 번 쌓지 않는다). 그렇지 않으면 평소대로 이어 간다.
       */
      if (serverMode && !offline && reportUnknownCommits.has(selectedUid)) {
        const uid = selectedUid, seq = selectionSeq;
        commitInFlight = true;
        let learned;
        try { learned = await learnCommitOutcome(uid, work.capture("document")); }
        finally {
          commitInFlight = false;
          if (work.state() === "active") updateReportButtons();
          wakeIdle();
        }
        if (learned.outcome === "landed" || uid !== selectedUid || seq !== selectionSeq) return;
      }
      if(studyPriority?.get(selectedUid)){toast('응급 상태를 확인한 뒤 판독을 저장하세요. 저장 결과 미확인은 Technician 메뉴의 Refresh Status로 확인할 수 있습니다.','err');return;}
      // 서버가 죽었는데 로컬에 확정을 쌓으면, 그건 확정이 아니라 이 브라우저의 메모다.
      if (offline) {
        toast("서버 연결이 끊겨 저장할 수 없습니다. 쓰던 내용을 복사해 두고 연결을 기다리세요.", "err");
        return;
      }
      const uid = selectedUid;
      const content = {
        findings: $("#findings").value,
        conclusion: $("#conclusion").value,
        recommendation: $("#recommendation").value,
      };
      // 받아들여진 확정이 싣지 않은, 그 뒤에 친 글이 남았는가(아래) — 완료 안내가 그 사실을 함께 말한다.
      let lateText = false;

      if (serverMode) {
        commitInFlight = true;
        // 요청이 나가 있는 동안 버튼을 회색으로. 플래그만으로도 두 번째 호출은 막히지만,
        // 눌리는데 아무 일도 안 일어나는 버튼은 "먹통"으로 읽혀 또 누르게 만든다.
        for (const id of ["#b-approve", "#b-save", "#b-transcribe", "#b-addendum", "#b-unread", "#b-prelim", "#b-defer"])
          if ($(id)) $(id).disabled = true;
        // 내 글을 확정하는 중이라면(초안이 있거나 편집기가 dirty) 기준은 **화면에 그려진 판**이다.
        // `appState.version`은 본문을 다시 그리지 않고도 올라가므로, 그대로 보내면
        // 못 본 승인본 위에 낙관적 락이 조용히 통과한다.
        const mine = !!appState[uid]?.draft || reportDirty();
        const baseVersion = mine ? reportBaseVersion(uid, appState[uid]?.version ?? 0)
                                 : (appState[uid]?.version ?? 0);
        // 응답이 돌아왔을 때 "그때 그 선택인가"를 판단할 기준. 요청이 떠나기 전에 잡는다.
        const seq = selectionSeq;
        /**
         * `citationIds`는 **내 초안 건에 대한 유지 목록**, `removeCitationIds`는 사람이
         * 목록에서 명시로 고른 **머리 판 건의 제거 의사**다. 둘 다 확인된 상태에서만
         * 실린다 — 모르면 키가 없고, 키가 없으면 서버는 아무것도 바꾸지 않는다.
         * 그래서 낡은 화면은 제거에 실패할 수는 있어도 보지 못한 건을 지울 수는 없다.
         */
        const keepIds = citations.keepIds(uid), removeCitationIds = citations.removeIds(uid);
        // 구조화에는 제거 목록이 없다 — 머리 건이 빠지는 길은 그 문장이 본문을 떠나는 것뿐이다.
        const structureIds = structureState.keepIds(uid);
        // 이 확정을 시작한 문맥(세션·작업 세대). 그때 그 선택인가는 아래의 uid·seq 대조가 본다 — 받아 온 상태는 자료라
        // 다른 검사로 옮겼어도 남기고, 그리는 것만 그 선택일 때 한다.
        const at = work.capture("document");
        // 이 확정이 싣고 나가는 글(content)까지의 편집 차례. 답이 올 때 그 뒤의 편집이 있었는지를 이것으로 안다.
        const sentAt = reportEdits;
        // 확정은 초안 행도 함께 치운다. 그래서 초안의 명령 경로로 간다: 작성자와 화면이 본 초안 revision을 싣고, 답의 봉투와
        // 그 안의 검사 상태(state)가 확인될 때만 확정으로 본다.
        const result = await draftClient.commit(uid,
          { action, reason, reviewer, baseVersion, ...content,
            ...(keepIds ? { citationIds: keepIds } : {}),
            ...(removeCitationIds ? { removeCitationIds } : {}),
            ...(structureIds ? { structureIds } : {}) }, { owner: draftOwner, context: at });
        try {
          // 로그아웃 준비·세션 종료 뒤에 온 답은 화면에도 상태에도 쓰지 않는다. 초안의 기준(revision)은 명령 경로가 이미 옮겼다.
          if (!work.admits(at)) return;
          if (result.outcome !== "saved") {
            if (result.outcome === "unsent" || result.outcome === "auth") return;
            if (result.outcome === "conflict") { openDraftConflict(uid); return; }
            if (result.outcome === "unknown") {
              /**
               * 확정됐을 수도 아닐 수도 있다. 저장됐다고도 실패했다고도 하지 않는다 — 무엇을 보냈는지를 적어 두고
               * (`reportUnknownCommits`), 서버의 지금 판독 상태를 읽어 프로그램이 확인한다. 글은 그대로 둔다. 읽어서
               * 확정됐음을 알면 받아들여진 확정과 똑같이 화면에 옮기고, 아직 모르면 그 기록이 남아 그 글을 초안으로 쓰려는
               * 다음 길(자동 저장·검사 이동·Log out)이 먼저 다시 읽는다. 여기서 목록 읽기(`load`)를 쓰지 않는 까닭: 이
               * 확정이 끝나며 `commitEpoch`이 올라가 그 읽기의 답은 버려진다 — 읽는다고 말해 놓고 읽지 않는 셈이 된다.
               */
              reportUnknownCommits.set(uid, { sentAt, action, reason, baseVersion,
                texts: action === "reset" ? Object.fromEntries(RFIELDS.map(k => [k, ""])) : content,
                revision: draftClient.revision(uid) });
              toast("확정의 결과를 확인하지 못해 판독 상태를 다시 읽습니다 — 입력한 내용은 그대로 있습니다.", "err");
              learnCommitOutcome(uid, at);
              return;
            }
            // 작성자 대조의 거절을 포함해, 서버가 이유를 대고 받지 않은 확정이다. 아무것도 바뀌지 않았다.
            const refused = result.answer?.body || {};
            if (refused.code === "REPORT_HELD") noteHeld(uid, refused.holder);
            throw Object.assign(new Error(draftFailureText(result)), { code: result.code ?? refused.code, status: result.answer?.status, body: refused });
          }
          heldUid = null; clearInterval(heartbeat); heartbeat = null;   // 확정하면 서버가 점유를 푼다
          lateText = applyAcceptedCommit(uid, result.state, sentAt);
        } catch (e) {
          // 낙관적 락에 걸린 경우 — 그 사이 남이 저장했다.
          // 내가 쓴 내용을 지우지 않는다. 서버 것을 보여주고 사용자가 판단하게 한다.
          const route = commitFailureRoute(e);
          if (route === "held") return;
          /**
           * 낡은 초안으로 추가기재를 시도했다. 여기서 아무것도 덮지 않는다 —
           * textarea도, 초안 행도 그대로 두고 **서버가 보낸 승인본**을 옆에 펼쳐
           * 사람이 읽고 정하게 한다. 다시 불러오기(force)는 하지 않는다.
           */
          if (route === "stale") { openStaleRebase(uid, seq, e); return; }
          if (route === "reload") {
            toast(e.message, "err");
            if (confirm(e.message + "\n\n서버의 최신 판독문을 불러올까요?\n(지금 쓰던 내용은 클립보드로 복사됩니다)")) {
              navigator.clipboard?.writeText(
                [content.findings, content.conclusion, content.recommendation].filter(Boolean).join("\n\n"));
              /**
               * 최신 판독문을 읽지 못했거나(연결 실패), 읽은 답에 그 검사가 없거나(그 사이 권한·기관이 바뀌었다), 그 검사의
               * 초안 기준을 바꿀 수 없으면 아무것도 바꾸지 않는다: 화면의 글과 표시는 그대로이고 그 사실을 알린다. 이 실패가
               * 처리되지 않은 오류로 빠져나가면 사람은 눌렀는데 아무 일도 없는 화면만 본다.
               */
              let latest;
              try {
                const b = await api("GET", "/bootstrap", undefined, undefined, at);
                await draftClient.settled(uid);
                if (!work.admits(at)) return;
                latest = replaceReportState(uid, b.states?.[uid]);
              } catch (failure) {
                if (work.admits(at))
                  toast("서버의 최신 판독문을 불러오지 못했습니다 — 쓰던 내용은 화면에 그대로 있습니다" +
                        (failure?.message ? ` (${failure.message})` : ""), "err");
                return;
              }
              appState[uid] = latest;
              syncStudy(uid);
              // 확인창과 응답을 기다리는 사이에 다른 검사로 갔다면 그 화면을 덮지 않는다.
              // 받아온 상태는 남기되(자료다), 그리는 것은 그때 그 선택일 때만 한다.
              if (uid !== selectedUid || seq !== selectionSeq) { render(); return; }
              loadReport({ force: true }); render(); renderRelated(); updateReportButtons();
              // The replacement may itself contain the reader's server draft; name the source shown.
              if (appState[uid]?.draft)
                toast("서버의 초안을 불러왔습니다 — 화면에 보이는 것은 초안입니다. " +
                      (appState[uid]?.rs === "A"
                        ? "Discard Draft로 서버 내용을 보거나, Addendum을 눌러 승인본을 확인하고 기준을 다시 잡으세요."
                        : "Discard Draft를 누르면 서버 내용으로 돌아갑니다.") +
                      " 쓰던 내용은 클립보드에 있습니다.", "info");
              else
                toast("서버 판독문을 불러왔습니다. 쓰던 내용은 클립보드에 있습니다.", "info");
            }
            return;
          }
          // 문맥이 무효가 된 뒤의 실패(이어진 읽기의 취소 등)는 알릴 실패가 아니다.
          if (work.admits(at)) toast("저장 실패: " + e.message, "err");
          return;
        } finally {
          // 이 확정이 세운 표시는 이 확정이 내린다(자기 것만). 단추를 다시 그리는 것은 문맥이 그대로일 때만 한다 — 편집으로
          // 돌아오면 그때 다시 그린다.
          commitInFlight = false;
          commitEpoch += 1;
          work.commit(at, () => updateReportButtons());   // 성공·실패·중단 어느 쪽으로 빠져나가도 버튼은 되살아난다
          wakeIdle();
        }
      } else {
        // 로컬 폴백에는 사용자 명단도 접근 제어도 없다. 여기서 P를 흉내내면
        // "가려진 줄 알았는데 안 가려진" 판독문이 생긴다 — 그건 없는 것만 못하다.
        if (action === "preliminary") {
          toast("예비 판독 지정은 서버에 연결돼 있을 때만 가능합니다", "err");
          return;
        }
        const rs = { save: "T", approve: "A", addendum: "A", reset: "W", defer: "H" }[action];
        // 서버 확정은 ReportDraft를 회수한다. 로컬도 초안을 남기면 force 로드가
        // 방금 확정한 내용 대신 옛 초안을 다시 고르는 서로 다른 생애주기가 된다.
        appState[uid] = { ...appState[uid], ...content, rs, draft: null, holdReason: action === "defer" ? reason : null };
        if (rs === "A") {
          appState[uid].repDoc = user.split("@")[0];
          appState[uid].confirm = today();
        }
        if (action === "reset") {
          Object.assign(appState[uid], { findings: "", conclusion: "", recommendation: "" });
        }
        loadReport({ force: true });
        cur().rs = rs;
        cur().holdReason = appState[uid].holdReason;
        saveApp();
      }
      render(); renderRelated(); updateReportButtons();
      announceCommit(uid, action, reason, lateText);
    }

    /** 검사를 사람에게 가리키는 표기: 환자 이름 · 접수번호 · 검사일. 목록에서 사라진 검사는 남은 이름(UID)으로 부른다. */
    function studyLabel(uid) {
      const study = studies.find(s => s.uid === uid);
      return study ? [study.name, study.acc, study.date].filter(Boolean).join(" · ") : uid;
    }

    /**
     * Preliminary — 상급 판독의를 지정한다.
     *
     * 지정 대상은 서버가 Keycloak에 물어 만든 **실제 명단**에서 고른다.
     * 이 값이 판독문 접근을 좌우하므로 손으로 타이핑하게 두면 오타 하나에
     * 아무도 못 여는 판독문이 생긴다.
     */
    async function doPreliminary() {
      if (!selectedUid) { alert("검사를 선택하세요."); return; }
      /**
       * **uid를 여기서 잡는다.**
       *
       * 아래에는 `await`(동료 목록)와 `prompt`(사람이 읽고 고르는 시간)가 있다.
       * 그 사이에 다른 검사를 클릭하면 `selectedUid`가 바뀌고, `commitReport`는
       * 그때 다시 `selectedUid`를 읽으므로 **엉뚱한 검사가 예비 판독으로 넘어간다.**
       * 게다가 P는 접근 제어라, 잘못 넘어간 검사는 지정된 두 사람 말고는 못 본다.
       */
      const uid = selectedUid;
      // 명단을 받아 사람이 고르는 동안에도 같은 문맥이어야 한다 — 그 사이 준비·종료·검사 이동이 있었으면 아무것도 걸지 않는다.
      const at = work.capture("study");
      let peers;
      try { peers = await api("GET", "/colleagues", undefined, undefined, at); }
      catch (e) { work.commit(at, () => toast("판독의 목록을 불러오지 못했습니다: " + e.message, "err")); return; }
      if (!work.admits(at)) return;
      if (!peers.length) { alert("이 기관에 지정할 다른 판독의가 없습니다."); return; }

      const s = studies.find(x => x.uid === uid);
      const pick = prompt(
        `${s?.name ?? ""} (${s?.id ?? ""}) — 최종 판독을 맡길 상급 판독의 번호:\n` +
        peers.map((u, i) => `${i + 1}. ${u.name} (${u.username})`).join("\n"), "1");
      const n = +pick;
      if (!n || !peers[n - 1]) return;
      if (uid !== selectedUid) {
        // 고르는 동안 선택이 옮겨갔다. 조용히 원래 검사에 걸지 않는다 —
        // 사용자가 보고 있는 것과 다른 검사를 건드리는 건 어느 쪽이든 사고다.
        toast("고르는 동안 다른 검사로 이동했습니다. 예비 판독을 취소했습니다.", "err");
        return;
      }
      await commitReport("preliminary", null, peers[n - 1].id);
    }
    $("#b-prelim")?.addEventListener("click", doPreliminary);
    $("#b-save").addEventListener("click", () => commitReport("save"));
    $("#b-transcribe").addEventListener("click", () => commitReport("save"));
    $("#b-approve").addEventListener("click", () => commitReport("approve"));
    $("#b-addendum").addEventListener("click", () => commitReport("addendum"));
    let reasonResolve = null;
    function askReason({ title, choices }) {
      if (reasonResolve) reasonResolve(null);
      const modal = $("#reasonmodal"), extra = $("#reason-extra"), ok = $("#reason-ok");
      $("#reason-title").textContent = title;
      $("#reason-choices").innerHTML = choices.map(choice =>
        `<label style="display:block"><input type="radio" name="reason-choice" value="${esc(choice)}"> ${esc(choice)}</label>`).join("");
      extra.value = "";
      const value = () => {
        const choice = modal.querySelector('input[name="reason-choice"]:checked')?.value;
        const detail = extra.value.trim();
        if (!choice || (choice === "기타" && !detail) || detail.length > 200) return null;
        return detail ? `${choice} — ${detail}` : choice;
      };
      const update = () => { ok.disabled = !value(); };
      update();
      modal.classList.add("show");
      return new Promise(resolve => {
        const finish = reason => {
          modal.classList.remove("show");
          modal.oninput = modal.onchange = modal.onkeydown = null;
          ok.onclick = $("#reason-cancel").onclick = null;
          reasonResolve = null;
          resolve(reason);
        };
        reasonResolve = finish;
        modal.oninput = modal.onchange = update;
        modal.onkeydown = e => { if (e.key === "Escape") finish(null); };
        $("#reason-cancel").onclick = () => finish(null);
        ok.onclick = () => { const reason = value(); if (reason) finish(reason); };
      });
    }
    $("#b-unread").addEventListener("click", async () => {
      // 판독을 되돌리는 것은 저장된 진술을 지우는 일이다. 사유 없이는 보내지 않는다.
      const uid = selectedUid, at = work.capture("study");
      const reason = await askReason({ title: "판독 취소 사유", choices: ["내용 정정 필요", "환자·검사 불일치", "잘못된 검사에 작성", "의뢰 취소", "기타"] });
      // 사유를 고르는 사이 준비·종료·검사 이동이 있었으면 그 결정은 지금 화면의 것이 아니다.
      if (!reason || uid !== selectedUid || !work.admits(at)) return;
      commitReport("reset", reason);
    });
    $("#b-defer").addEventListener("click", async () => {
      const uid = selectedUid, at = work.capture("study");
      const reason = await askReason({ title: "판독 보류 사유", choices: ["prior 없음", "임상정보 부족", "영상 불량", "재촬영 필요", "기타"] });
      if (!reason || uid !== selectedUid || !work.admits(at)) return;
      commitReport("defer", reason);
    });

    /**
     * appState → studies 동기화. 화면은 studies 배열을 그리므로, appState만 고치면
     * 데이터는 맞는데 화면이 옛것을 보여준다. 이 불일치 버그를 세 번 만들고 나서야
     * 갱신 경로를 하나로 모았다 — 상태를 두 곳에 두면 반드시 어긋난다.
     */
    function syncStudy(uid) {
      const s = studies.find(x => x.uid === uid);
      const a = appState[uid];
      if (!s || !a) return;
      for (const k of ["rs", "ss", "em", "ts", "matched", "holder", "version", "repDoc", "confirm",
                        "preDoc", "preReviewer", "prelimHidden", "holdReason"])
        if (a[k] !== undefined) s[k] = a[k];
      if (a.holder === null || a.holder === undefined) s.holder = a.holder;
      if (a.ward) s.ward = a.ward;
      if (a.reqHosp && !s.institutionName) s.reqHosp = a.reqHosp;
    }

    // ══════════ 동시 판독 점유 (교훈 §2) ══════════
    // 점유는 **열람이 아니라 쓰기**로 시작한다. 검사를 열어보는 건 흔한 일이고,
    // 그걸 점유로 치면 경고가 남발되며, 남발된 경고는 아무도 안 본다.
    let heldUid = null, heartbeat = null, warnedFor = null, holdPending = null;
    const HOLD_MIN_CHARS = 2;      // "두 글자 이상 입력" — HPACS가 2021년에 정한 기준
    const HEARTBEAT_MS = 60000;    // 서버 TTL(5분)보다 충분히 짧게

    /** 충돌로 점유를 못 잡은 검사. 키 입력마다 다시 물어보지 않기 위한 기억 */
    let holdBlocked = null;   // { uid, at }
    const HOLD_RETRY_MS = 60000;

    async function claimHold(uid) {
      // 타이핑은 글자마다 input 이벤트를 낸다. 가드가 없으면 요청이 열 개씩 겹치고,
      // 뒤늦게 도착한 하나가 `await releaseHold()` 구간에서 방금 잡은 점유를 스스로 푼다.
      // (실제로 그렇게 됐다 — 화면엔 잡힌 것처럼 보이는데 서버는 비어 있었다)
      if (!serverMode || heldUid === uid || holdPending === uid) return;
      /**
       * **충돌한 검사에 키 입력마다 요청을 보내지 않는다.**
       *
       * 충돌(`r.conflict`) 시에는 `heldUid`를 안 잡는다 — 잡으면 안 되니까. 그런데
       * 그러면 위의 `heldUid === uid` 가드가 영원히 통과하지 못해, 글자마다
       * `POST /hold`가 나갔다. 500자를 쓰면 요청 500번. 토스트는 한 번만 떠서
       * 아무도 눈치채지 못한다.
       * 그렇다고 영영 포기하지도 않는다 — 상대가 놓을 수 있으므로 1분마다 다시 묻는다.
       */
      if (holdBlocked?.uid === uid && Date.now() - holdBlocked.at < HOLD_RETRY_MS) return;
      holdPending = uid;
      // 이 점유 요청을 시작한 문맥. 답이 화면·점유 상태에 닿는 자리는 이것을 지난다 — 준비·종료 뒤에 온 답은 점유도 갱신
      // 타이머도 세우지 않는다(그 점유는 서버의 TTL이 거둔다).
      const at = work.capture("document");
      try {
        if (heldUid && heldUid !== uid) await releaseHold();
      } catch (e) {}
      try {
        const r = await api("POST", `/studies/${encodeURIComponent(uid)}/hold`, undefined, undefined, at);
        if (!work.admits(at)) return;
        const s = studies.find(x => x.uid === uid);
        if (s) s.holder = r.holder;
        appState[uid] = { ...appState[uid], holder: r.holder };
        render();
        if (uid === selectedUid) { updateReportButtons(); loadReport(); }

        if (r.conflict) {
          // 남의 점유는 뺏지 않는다. 잠금 해제는 폴링이나 다음 점유 응답으로 반영한다.
          holdBlocked = { uid, at: Date.now() };
          if (warnedFor !== uid) {
            warnedFor = uid;
            toast(`${displayActor(r.holder)} 님이 먼저 판독을 시작했습니다 — 잠금이 풀리면 이어서 할 수 있습니다`, "err");
          }
          return;
        }
        holdBlocked = null;

        /**
         * **응답이 돌아왔을 때 내가 아직 그 검사에 있는가.**
         *
         * `claimHold(A)`가 나가 있는 동안 B를 선택하면, `select()`의 `releaseHold()`는
         * 아무것도 안 한다 — 아직 `heldUid`가 A가 아니기 때문이다. 그리고 A의 응답이
         * 도착해 **떠나온 A를 내 이름으로 점유**한 채 60초마다 하트비트를 돈다.
         * 다른 판독의에게는 내가 A를 붙잡고 있는 것으로 보인다. 영원히.
         *
         * 가드가 한 방향(요청 겹침)만 막고 반대 방향(선택 이동)을 안 막은 자리였다.
         */
        if (uid !== selectedUid) {
          try { await api("POST", `/studies/${encodeURIComponent(uid)}/release`, undefined, undefined, at); } catch (e) {}
          work.commit(at, () => {
            if (appState[uid]) appState[uid].holder = null;
            const s2 = studies.find(x => x.uid === uid);
            if (s2) s2.holder = null;
            render();
          });
          return;
        }

        heldUid = uid;
        clearInterval(heartbeat);
        // 갱신은 주기마다 그때의 문맥으로 나간다: 준비 중에는 전송이 보내지 않고, 세션이 끝나면 종료 조정이 타이머를 치운다.
        heartbeat = setInterval(() => {
          if (heldUid) api("POST", `/studies/${encodeURIComponent(heldUid)}/hold`).catch(() => {});
        }, HEARTBEAT_MS);
      } catch (e) { /* 점유 실패로 판독을 막지는 않는다 */ }
      // 이 요청이 세운 대기 표시는 이 요청이 내린다(자기 것만).
      finally { if (holdPending === uid) holdPending = null; }
    }

    async function releaseHold({ closing = false } = {}) {
      if (!serverMode || !heldUid) return;
      const uid = heldUid;
      heldUid = null;
      clearInterval(heartbeat); heartbeat = null;
      const s = studies.find(x => x.uid === uid);
      if (s) s.holder = undefined;
      if (appState[uid]) appState[uid].holder = undefined;
      // 세션을 끝내는 중의 해제(auth.js가 종료 기록·통지 뒤, 로그아웃 POST 앞에 부른다)는 업무가 아니라 그 종료의 일부다:
      // 닫힌 문서의 수명주기 문맥으로, 끝나는 그 세션의 식별값을 실어 나간다. 그 밖에는 평소의 업무 요청이다.
      const at = work.capture(closing ? "lifecycle" : "document");
      try { await transport.request(`${API}/studies/${encodeURIComponent(uid)}/release`, { method: "POST", context: at }); } catch (e) {}
    }

    // 판독문에 두 글자 이상 쓰면 그때 점유가 시작된다
    ["#findings", "#conclusion", "#recommendation"].forEach(sel =>
      $(sel).addEventListener("input", () => {
        updateReportTemplateButton();
        if (!selectedUid) return;
        const total = $("#findings").value.length + $("#conclusion").value.length + $("#recommendation").value.length;
        if (total >= HOLD_MIN_CHARS) claimHold(selectedUid);
      }));

    // ══════════ 이탈 시 판독문 보존 (교훈 §1) ══════════
    /**
     * 초안 저장은 **검사를 옮길 때만** 작동했다. 서버 주석은 그 기능의 목적을
     * "손실 방지 하나뿐"이라고 적어놨는데, 정작 판독문이 사라지는 흔한 세 경우를
     * 아무것도 안 막았다:
     *   ① 탭/브라우저를 닫는다        ② 로그아웃한다        ③ 그냥 자리를 뜬다
     * ②는 점유(TTL 5분)까지 남겨서, 사라진 판독문 + 잠긴 검사가 동시에 생겼다.
     *
     * 셋 다 같은 답이다: **나가기 전에 저장한다.** 그리고 저장이 확실하지 않은
     * 경로(탭 닫기)에서만 브라우저 경고를 띄운다.
     */
    const AUTOSAVE_MS = 20000;

    // ③ 주기적 자동 저장. 20초면 사고로 잃는 양이 "방금 친 문장"을 넘지 않는다.
    setInterval(() => {
      // 삽입이 나가 있는 동안은 확정과 똑같이 비켜선다(B1). `stashReport`에도 같은 검사가
      // 있지만, 다른 경로가 늘어도 여기 한 줄이 빠지지 않게 둘 다 둔다.
      if (!serverMode || commitInFlight || insertInFlight) return;
      // 로그아웃 준비 중에는 보존 작업만 쓴다(S7-U5): 이 문서의 관문이 업무를 받아들일 때만 저장을 시작한다.
      if (work.state() !== "active") return;
      for (const uid of [...reportUnknownDiscards.keys()]) learnDiscardOutcome(uid);
      reconcileReportDrafts();
    }, AUTOSAVE_MS);

    // ① 탭·브라우저를 닫거나 새로고침
    window.addEventListener("beforeunload", e => {
      if (logoutPrep && ["closing", "done"].includes(logoutPrep.state)) return;
      const capture = logoutPrep?.reports ? logoutPrep : captureReport();
      const pending = (capture.reports || []).filter(report => !report.safe);
      if (!pending.length) return;
      // Navigation is a document boundary: unselected studies need the same protection.
      if (work.state() === "active") {
        if (demoMode) stashReport({ keepalive: true });
        else {
          keepReportEditor();
          const context = work.capture("document");
          for (const report of pending)
            draftClient.writeOnUnload(report.uid, report.texts, { owner: capture.owner, context });
        }
      }
      if (serverMode && heldUid) {
        transport.request(`${API}/studies/${encodeURIComponent(heldUid)}/release`,
          { method: "POST", keepalive: true, read: "none", deadlineMs: 0, context: work.capture("document") }).catch(() => {});
      }
      e.preventDefault();
      e.returnValue = "";   // 구형 브라우저는 이 대입이 있어야 경고가 뜬다
      return "";
    });

    // ② 로그아웃 — 저장하고, 점유를 풀고, 그 다음에 나간다
    /**
     * S7-U5 로그아웃. Log Out을 한 번 누르면 프로그램이 나머지를 한다(확인창도 다시 누르기도 없다). 먼저 초안 보존 준비: 이
     * 문서의 관문이 preparing이 되어 일반 업무(새 요청, 앞서 나간 요청의 답, 타이머가 시작하는 일)가 멈추고, 지금 작성자의
     * 판독문(검사·세 칸·기준 판)을 이 문서의 메모리에 얼려 잡는다. 이 단계는 아직 종료가 아니다 — 신원은 그대로이고 다른
     * 업무 문서에 알리지 않으며, 연결된 뷰어도 닫지 않는다(멈추라는 신호만 보낸다). 보존 저장은 그 준비 문맥으로만 나간다
     * (URL이나 메서드가 아니라 살아 있는 준비 하나에 묶인다): 작성자·초안 revision·전체 원문을 싣고, 그 원문 전부가 서버에
     * 있음이 확인될 때만 저장으로 본다. 저장을 확인했거나 보낼 것이 없으면 묻지 않고 실제 종료까지 간다. 사람에게 묻는 것은
     * 그대로 나가면 글을 잃을 때뿐이다(저장 거절·실제 충돌·결과 모름): 원문은 화면과 메모리에 그대로 있고 Retry·Back to
     * Editing·명시적 폐기 중에서 고른다. Back to Editing은 준비를 취소한다 — 글도 뷰어도 보던 그대로다. 준비 중에 세션이
     * 끝나면(서버가 알린 종료·다른 문서의 종료) 인증 종료가 먼저다: 준비는 그 순간 끝나고, 업무 화면은 닫히고, 원문은 이 창의
     * 메모리에만 남아 자동 이동으로 잃지 않으며, 같은 계정으로 다시 로그인한 뒤 사람이 누를 때만 다시 저장한다(Recover
     * Draft). 확정(commitReport)·판 이력·승인 상태·권한 규칙은 이 절차가 건드리지 않는다.
     */
    let loggingOut = false;
    let logoutPrep = null;
    /**
     * 준비 하나(번호 P — 모든 문서에 걸쳐 그 준비 하나의 것이다)가 뷰어와 맺는 계약은 잠금이다(gate-api §6). 뷰어는 준비
     * 통지로 멈추고, 멈추게 한 이 문서가 살아서 준비 중인 동안만 멈춰 있어야 한다. 그 "살아 있음"을 타이머로 다시 알리면
     * 가려진 탭에서 어긋난다 — 브라우저가 숨은 문서의 타이머를 분 단위까지 늦춰, 준비 중인데 뷰어가 풀렸다 멈췄다 한다
     * (U5VW-F07). 그래서 브라우저가 지키는 Web Lock을 쥔다: `kin-preparation:P`를 배타로 얻은 **뒤에야** 준비에 들어서
     * 통지하고, 준비 내내(Retry도 같은 준비다) 쥔다. 뷰어는 같은 이름을 공유로 기다린다 — 이 문서가 닫히거나 죽거나
     * 버려지면 브라우저가 풀어 주므로 타이머도, 떠나면서 보내는 통지도 없다. 이 문서가 푸는 자리는 하나다: Back to
     * Editing이 재개를 알린 뒤(returnToEditing의 finally). 실제 종료에서는 풀지 않는다 — 종료 통지보다 해제를 먼저 본
     * 뷰어는 종료를 취소로 읽는다(U5VW-F11). 그때는 이 문서가 사라질 때 브라우저가 푼다. P는 Log Out을 누를 때마다 새로
     * 정하므로 다른 문서가 같은 이름을 쥘 일이 없고, 얻는 데 기다림이 없다. 잠금을 쓸 수 없는 브라우저(지원 대상
     * Chromium에는 있다)에서는 통지만으로 간다. 잠금을 요청하는 호출이 거절로 답하든 그 자리에서 예외를 던지든(잠금
     * 관리자를 읽는 것부터 던지는 문서도 있다) 마찬가지다 — 잠금 없이 준비를 이어 간다. 그 예외가 Log out 처리기 밖으로
     * 나가면 `loggingOut`만 선 채 준비도 창도 없어, 다시 눌러도 아무 일이 없는 Log out이 남는다.
     */
    function holdPreparation(prep, enter) {
      const waiting = () => logoutPrep === prep && prep.state === "waiting";
      if (!waiting()) return;
      let asked = null;
      try {
        asked = navigator.locks ? navigator.locks.request("kin-preparation:" + prep.id, { mode: "exclusive" }, () => {
          // 얻기 전에 취소됐거나 세션이 끝났으면 알린 것이 없다 — 쥐지 않는다.
          if (!waiting()) return undefined;
          // 준비는 이 콜백 밖에서 시작한다: 그 안의 예외가 이 약속을 끝내(잠금을 풀어) 버리지 못한다.
          queueMicrotask(enter);
          return new Promise(release => { prep.release = release; });
        }) : null;
      } catch (_) { asked = null; }
      // 잠금 없이 가는 길은 하나다(관리자 없음·예외·거절). `enter`는 이미 들어선 준비에는 아무것도 하지 않는다.
      if (!asked || typeof asked.then !== "function") { enter(); return; }
      asked.then(undefined, () => enter());
    }

    /**
     * 같은 사용자로 편집에 돌아왔다(준비 취소 = 새 작업 세대). 준비 전에 나갔던 일의 답은 돌아오지 않으므로, 그 일들이 그리던
     * 것을 지금 문맥에서 다시 시작한다: 폴링, 판독문의 인용·구조화 읽기, 단추, 영역들의 읽기.
     */
    function resumeWork() {
      startPolling();
      updateReportButtons();
      renderDraftBar();
      ensureCitations(selectedUid);
      ensureStructure(selectedUid);
      imageRequests?.resume();
      studyQuestions?.resume();
      clinicalContext?.resume();
    }

    $("#logout").addEventListener("click", () => {
      if (loggingOut || work.state() !== "active") return;
      loggingOut = true;
      const prep = logoutPrep = { uid: null, seq: selectionSeq, owner: draftOwner, state: "waiting", reason: null, attempt: 0,
        panel: null, recovering: false, permit: null, id: crypto.randomUUID(), release: null, needsWrite: false, texts: null };
      // 누른 그 순간의 "떠나려는 중" 표지(S7-U5 A017) — 어떤 기다림보다 먼저. 저장을 기다리는 사이 창이 닫혀도 다음 문서가
      // 이 세션으로 스스로 들어가지 않고, 창이 살아 있는 동안 연 새 탭은 이 준비를 기다린다. 종료가 아니다(아무도 닫지 않는다).
      KinAuth.leaving(prep.id);
      const begin = () => {
        // 기다리는 사이 취소했거나 세션이 끝났으면(닫힌 화면이 이어받았다) 여기서 할 일이 없다.
        if (logoutPrep !== prep || prep.state !== "waiting" || work.state() !== "active") return;
        Object.assign(prep, captureReport());
        saveForLogout(prep);
      };
      /**
       * 확정·삽입·초안 버리기가 나가 있으면 그 답이 화면의 글과 서버 행을 함께 바꾼다 — 답을 보기 전에 잡은 글은 어느 쪽과도
       * 다를 수 있다. 그래서 그 답을 본 뒤에 잡는다. 다시 누르라고 하지 않고 스스로 기다렸다가 이어 간다. 이 기다림은 아직
       * 준비가 아니다: 업무는 멈추지 않았고 그 답은 평소처럼 화면에 쓰인다(창이 새 입력만 막는다). 글을 잡고 준비에
       * 들어서는 것은 준비 잠금을 얻은 그 자리다(holdPreparation).
       */
      if (workBusy()) {
        showLogoutPanel(prep);
        workIdle().then(() => holdPreparation(prep, begin));
      } else holdPreparation(prep, begin);
    });

    /**
     * 파괴적인 closer·신원 해제보다 먼저, 지금 작성자의 판독문을 이 문서의 메모리에 잡는다. 잡은 글과 기준 판은 얼린 값이라
     * 그 뒤 화면이나 상태가 달라져도 그대로다. 그 글의 계정(owner)은 이 페이지가 열린 계정이다 — 보존 저장과 Recover Draft가
     * 서버에 대조를 맡긴다. 보낼 것이 있는가도 여기서 정한다: 화면의 글이 저장된 것과 다르거나, 저장이 확인되지 않았거나
     * (수렴 표시·결과를 모르는 쓰기), 저장이 아직 나가 있으면 보낸다.
     */
    function captureReport() {
      const reader = !!sess && sess.state === "approved" && Array.isArray(sess.roles)
        && (sess.roles.includes("radiologist") || sess.roles.includes("admin"));
      const reports = [];
      if (reader) {
        for (const uid of [...reportConverge]) {
          // 고른 검사는 편집기의 글, 그 밖의 검사는 담아 둔 사본. 저장된 판독문을 초안인 것처럼 잡지 않는다.
          const source = unconfirmedReport(uid);
          if (!source) continue;
          const a = appState[uid] || {};
          const texts = Object.freeze({ ...Object.fromEntries(RFIELDS.map(k => [k, source[k] ?? ""])),
            baseVersion: reportBaseVersion(uid, a.draft?.baseVersion ?? a.version ?? 0) });
          reports.push({ uid, label: studyLabel(uid), texts, safe: false });
        }
      }
      return { uid: null, seq: selectionSeq, owner: draftOwner, reports, needsWrite: reports.length > 0 };
    }

    /**
     * 보존 저장. 준비에 들어서고(다시 누른 Retry도 새 준비다), 앞서 나간 초안 쓰기의 결과와 유지 목록의 기준을 확인한 뒤,
     * 작성자·기대 revision·전체 원문을 얼려 묶은 준비 문맥으로 쓰기 하나를 보낸다. 그 답은 이 준비의 결과만 바꾼다 — 편집기도
     * 목록도 건드리지 않는다. 저장을 확인했거나 보낼 것이 없으면 실제 종료로, 아니면 나가지 않는다. 충돌과 결과 모름은 명령
     * 경로가 서버의 지금 초안을 읽어 먼저 확인한다: 잡아 둔 원문이 거기 전부 있으면 저장이고, 거기 있는 것이 이 문서의
     * 글이면(늦게 닿은 자동 저장) 그 기준 위에서 새 준비로 한 번 다시 보낸다 — 사람에게 묻는 것은 그 뒤에 남은 것뿐이다.
     */
    async function saveForLogout(prep) {
      const attempt = ++prep.attempt;
      prep.state = "saving";
      prep.reason = null;
      let permit = prep.permit = work.prepare({ preparationId: prep.id, owner: prep.owner, snapshot: prep.reports });
      if (!permit) return;
      // 통지는 준비마다 한 번이다 — Retry와 덮어쓰기는 같은 준비(같은 번호, 같은 잠금)의 다음 시도다.
      if (attempt === 1) KinAuth.notifyPreparation("preparing", prep.id);
      clearInterval(poll); poll = null;
      const mine = () => logoutPrep === prep && prep.attempt === attempt && prep.permit === permit && work.admits(permit);
      const fail = reason => work.commit(permit, () => { if (mine()) failLogout(prep, reason); });
      // 판독문 글은 다 지켰다. 실제 종료 전에 판독문 초안 밖의 저장하지 않은 작업을 확인한다(concludeLogout).
      const finish = () => { if (mine()) concludeLogout(prep); };
      if (!prep.needsWrite) { finish(); return; }
      showLogoutPanel(prep);
      // Every command in this document must settle before deciding that any text is safe.
      await draftClient.settled();
      if (!mine()) return;
      if (offline && !demoMode) {
        for (const report of prep.reports) if (!report.safe) report.reason = "offline";
        fail("offline");
        return;
      }
      for (const report of prep.reports) {
        if (report.safe) continue;
        work.commit(permit, () => { prep.uid = report.uid; prep.texts = report.texts; report.reason = null; });
        if (demoMode) {
          work.commit(permit, () => {
            appState[report.uid] = { ...appState[report.uid], draft: { ...report.texts, at: new Date().toISOString() } };
            saveApp(); report.safe = true;
          });
          continue;
        }
        /**
         * 이 검사에 결과를 모르는 확정이 남아 있으면, 잡아 둔 글을 초안으로 보존하기 전에 서버의 판독 상태부터 읽는다
         * (준비 문맥으로). 그 글이 이미 판독문으로 확정돼 있으면 보존할 것이 없다 — 초안으로 다시 쓰면 다음 로그인에서
         * 저장된 글이 "저장 안 된 초안"으로 보인다. 누른 뒤에 친 글이 있으면 그 글은 새 판 위의 글로 보존한다. 읽지
         * 못하면 묻는다(결과 모름) — 모르는 채로 쓰지도 버리지도 않는다.
         */
        if (reportUnknownCommits.has(report.uid)) {
          const learned = await learnCommitOutcome(report.uid, permit);
          if (!mine()) return;
          if (learned.outcome === "unknown") { report.reason = "unknown"; continue; }
          if (learned.outcome === "landed") {
            if (!learned.later) { work.commit(permit, () => { report.safe = true; }); continue; }
            work.commit(permit, () => { prep.texts = report.texts = Object.freeze({ ...report.texts, baseVersion: learned.version }); });
          }
        }
        if (heldByOther(studies.find(s => s.uid === report.uid))) { report.reason = "held"; continue; }
        const failed = result => {
          if (result.outcome === "auth" || !mine()) return;
          report.reason = result.outcome === "conflict" ? "conflict" : ["unknown", "rebased"].includes(result.outcome) ? "unknown"
            : result.code === "REPORT_HELD" ? "held" : "refused";
        };
        for (let round = 0; ; round += 1) {
          const base = await draftClient.base(report.uid, { owner: prep.owner, context: permit });
          if (!mine()) return;
          if (base.outcome === "conflict" && !base.latest) {
            const got = await draftClient.latest(report.uid, { owner: prep.owner, context: permit });
            if (!mine()) return;
            if (got.resolved && round === 0) continue;
          }
          if (base.outcome !== "ready") { failed(base); break; }
          const snapshot = { ...report.texts, citations: base.lists.citations, structured: base.lists.structured };
          if (KinReportDraftClient.sameSnapshot(base.stored, RFIELDS.every(k => !report.texts[k]) ? null : snapshot)) break;
          permit = prep.permit = work.prepare({ preparationId: prep.id, owner: prep.owner, expectedRevision: base.revision, snapshot });
          if (!permit) return;
          const capture = { uid: report.uid, owner: permit.owner, expectedRevision: permit.expectedRevision, snapshot: permit.snapshot };
          const result = await draftClient.preserve(capture, { context: permit });
          if (!mine()) return;
          if (result.outcome === "saved") break;
          if (result.outcome === "rebased" && round === 0) continue;
          failed(result);
          break;
        }
        if (!mine()) return;
        if (report.reason) continue;
        work.commit(permit, () => { report.safe = true; reportConverge.delete(report.uid); });
      }
      const pending = prep.reports.filter(report => !report.safe);
      if (pending.length) {
        const current = pending.find(report => report.reason === "conflict") || pending[0];
        prep.uid = current.uid; prep.texts = current.texts;
        fail(current.reason);
        return;
      }
      finish();
    }

    /** 저장을 확인하지 못했다. 나가지 않는다 — 원문은 메모리와 화면에 있고 고르는 것은 사람이다. */
    function failLogout(prep, reason) {
      if (logoutPrep !== prep || prep.state !== "saving") return;
      prep.state = "failed";
      prep.reason = reason;
      // 서버 행은 화면과 다를 수 있다. 편집으로 돌아가면 다음 저장이 이 글을 다시 가져가게 표시해 둔다.
      if (prep.uid) reportConverge.add(prep.uid);
      showLogoutPanel(prep);
    }

    /**
     * 실제 종료. auth.js가 같은 호출 안에서 네트워크 전에 종료 기록·신원 해제·다른 문서 통지를 하고, 이 문서의 관문이 닫히는
     * 그 자리에서 세션 종료 조정이 화면·영역을 닫는다. 그 뒤 이 페이지가 맡긴 점유 해제(beforeLogoutPost, 한도 안에서만
     * 기다린다) → 로그아웃 POST 하나가 나간다. 준비 잠금은 여기서 풀지 않는다(위 holdPreparation) — auth.js가 종료 표지
     * 잠금을 통지보다 먼저 걸고, 둘 다 이 문서가 사라질 때 풀린다.
     */
    function endUse(prep) {
      prep.state = "closing";
      showLogoutPanel(prep);
      return KinAuth.logout();
    }

    /**
     * 판독문 초안 밖의 저장하지 않은 작업(S7-U5 A006). 실제 종료는 같은 세션의 뷰어 문서를 모두 닫는다 — 저장하지 않은
     * 측정·표식, 잡아 둔 소견 글, Job·MIP 편집, 뷰어 Tech Note 창의 메모, 아직 답을 받지 못한 그 저장들, 검토 중인 받아쓰기가
     * 한마디 없이 사라진다. Log Out의 일반 확인창은 없앴으므로
     * (한 번 누르면 프로그램이 나머지를 한다), 그 확인은 프로그램이 한다: 판독문 글을 다 지킨 뒤, 실제 종료 직전에 같은 세션의
     * 문서들과 이 문서의 모듈에 묻고, **정말 있을 때만** 같은 준비 창에서 무엇이 있는지 말하고 고르게 한다(Back to Editing —
     * 보던 그대로 돌아간다 / Discard and Log Out). 없으면 묻지도 기다리지도 않는다.
     *
     * 각 문서는 자기가 기록한 상태로 답한다(이 문서가 남의 창을 들여다보고 짐작하지 않는다):
     *   · 뷰어 문서(창·판독 화면의 뷰어)는 저장하지 않은 작업이 있는 동안 Web Lock `kin-unsaved:<세션>:<문서>:<종류>`를 쥔다
     *     (viewer-session.js). 그 잠금은 브라우저가 지킨다: 닫혔거나 죽었거나 끝난 문서의 것은 없다 — 읽을 수 없거나 없는
     *     창은 "저장하지 않은 작업이 있는 창"이 아니다. 준비 통지로 뷰어는 이미 멈춰 있어 그 상태는 더 바뀌지 않는다.
     *   · 잠금을 쥔 문서가 있을 때만 세션 채널로 지금 상태를 묻고(`session-work-query` → `session-work`) 짧게 기다린다.
     *     그 사이 답하지 않는 문서는 "확인하지 못함"으로 말한다 — 저장하지 않은 작업이 있다고 알렸던 문서이기 때문이다.
     *     알린 적 없는 문서는 기다리지 않는다.
     *   · 이 문서의 받아쓰기는 그 모듈의 상태로 안다(녹음·인식 중이거나 검토 중인 글).
     * 잠금을 쓸 수 없거나 읽지 못하면 알린 문서가 없는 것으로 본다(읽을 수 없는 것은 저장하지 않은 작업이 아니다).
     */
    const WORK_ANSWER_MS = 1500;
    // 뷰어의 종류는 저장하지 않은 것과 아직 저장 중인 것(답을 받기 전)을 함께 말한다. 준비가 뷰어를 멈춰 두므로 그 답은
    // 실제 종료 전에 올 수 없다 — 기다리지 않고 묻는다(Back to Editing이면 뷰어가 재개되어 답을 받는다).
    const WORK_LINES = {
      marks: "뷰어에 저장하지 않았거나 아직 저장 중인 측정·표식이 있습니다.",
      findings: "뷰어에 저장하지 않았거나 아직 저장 중인 소견 글이 있습니다.",
      jobs: "뷰어에 저장하지 않았거나 아직 저장 중인 Job·MIP 편집이 있습니다.",
      note: "뷰어의 Tech Note 창에 저장하지 않았거나 아직 저장 중인 메모가 있습니다.",
      "worklist-note": "Worklist 탭의 Tech Note에 저장하지 않았거나 아직 저장 중인 메모가 있습니다.",
      dictation: "받아쓰기가 끝나지 않았거나, 받아쓴 글을 아직 판독문에 넣지 않았습니다.",
    };
    const workLine = kind => WORK_LINES[kind] || "뷰어에 저장하지 않은 작업이 있습니다.";
    async function otherUnsavedWork() {
      const lines = new Set(), session = work.session();
      try { if (dictation.view().active) lines.add(WORK_LINES.dictation); } catch (_) {}
      const declared = new Map();
      try {
        const prefix = "kin-unsaved:" + session + ":";
        for (const lock of (await navigator.locks.query()).held) {
          if (typeof lock.name !== "string" || !lock.name.startsWith(prefix)) continue;
          const [id, kinds] = lock.name.slice(prefix.length).split(":");
          if (id && kinds) declared.set(id, kinds.split(","));
        }
      } catch (_) {}
      if (!declared.size) return [...lines];
      const answers = new Map(), query = crypto.randomUUID();
      let channel = null, timer = null;
      await new Promise(resolve => {
        timer = setTimeout(resolve, WORK_ANSWER_MS);
        try {
          channel = new BroadcastChannel("kin-session");
          channel.onmessage = event => {
            const answer = event.data;
            if (!answer || answer.type !== "session-work" || answer.session !== session || answer.query !== query
                || typeof answer.document !== "string" || !Array.isArray(answer.unsaved)) return;
            answers.set(answer.document, answer.unsaved.filter(kind => typeof kind === "string"));
            if ([...declared.keys()].every(id => answers.has(id))) resolve();
          };
          channel.postMessage({ type: "session-work-query", session, query });
        } catch (_) { resolve(); }
      });
      clearTimeout(timer);
      try { channel?.close(); } catch (_) {}
      for (const [id, kinds] of answers) for (const kind of kinds) lines.add(workLine(kind));
      for (const [id, kinds] of declared)
        if (!answers.has(id))
          lines.add("저장하지 않은 작업이 있다고 알린 창의 지금 상태를 확인하지 못했습니다 — 알린 내용: " +
            kinds.map(kind => workLine(kind).replace(/\.$/, "")).join(" · ") + ".");
      return [...lines];
    }

    /**
     * 실제 종료 전의 마지막 확인. 판독문 글은 이미 지켰다(저장을 확인했거나 사람이 버렸다). 다른 저장하지 않은 작업이 없으면
     * 그대로 끝내고, 있으면 준비 창에서 묻는다 — 그 물음에 Discard and Log Out을 고른 뒤에는 다시 묻지 않는다.
     */
    async function concludeLogout(prep) {
      const permit = prep.permit, attempt = prep.attempt;
      const mine = () => logoutPrep === prep && prep.attempt === attempt && prep.permit === permit && work.admits(permit)
        && prep.state === "saving";
      if (!prep.workAccepted) {
        const unsaved = await otherUnsavedWork();
        if (!mine()) return;
        if (unsaved.length) {
          work.commit(permit, () => { prep.state = "failed"; prep.reason = "work"; prep.work = unsaved; showLogoutPanel(prep); });
          return;
        }
      }
      work.commit(permit, () => { if (mine()) endUse(prep); });
    }

    /** 저장하지 않은 작업을 묻는 창에서 사람이 버리고 나가기로 했다. 누르는 것이 곧 선택이라 확인창을 더 띄우지 않는다. */
    function logOutAnyway(prep) {
      if (logoutPrep !== prep || prep.state !== "failed" || prep.reason !== "work") return;
      prep.workAccepted = true;
      endUse(prep);
    }

    /** 잡아 둔 원문을 메모리에서 지운다(저장을 확인했거나 사람이 버렸다). */
    function forgetCapture(prep) {
      prep.reports = [];
      prep.texts = null;
      prep.needsWrite = false;
    }

    function discardAndLogOut(prep) {
      if (logoutPrep !== prep || prep.state !== "failed") return;
      const pending = prep.reports.filter(report => !report.safe);
      if (!confirm(`저장하지 못한 ${pending.length}건의 판독문 초안을 버리고 로그아웃할까요?\n` +
          pending.map(report => `${report.label || report.uid} (${report.uid})`).join("\n") +
          "\n버린 내용은 되돌릴 수 없습니다. 저장을 확인한 검사는 그대로 보존됩니다.")) return;
      for (const report of pending) {
        reportConverge.delete(report.uid);
        if (appState[report.uid]) appState[report.uid].draft = null;
      }
      forgetCapture(prep);
      // 판독문 초안은 사람이 버렸다. 그 밖의 저장하지 않은 작업은 종료 직전에 따로 확인한다.
      prep.state = "saving";
      prep.reason = null;
      concludeLogout(prep);
    }

    /**
     * 충돌 뒤 사람이 고른 덮어쓰기: 읽어 온 서버의 초안을 새 기준으로 삼고 잡아 둔 원문을 그 위에 다시 보낸다. 준비 중이면 보존
     * 저장을, 세션이 끝난 뒤면 Recover Draft를 그 기준에서 다시 한다. 새 revision만 바꿔 끼운 자동 재전송이 아니다 — 서버에
     * 이 문서가 본 적 없는 초안이 있다고 알린 뒤 사람이 누를 때만 한다. 누르는 것이 곧 선택이라 확인창을 더 띄우지 않는다.
     */
    function overwriteServerDraft(prep) {
      if (logoutPrep !== prep || !prep.uid || !["failed", "ended"].includes(prep.state)) return;
      if (!draftClient.resolve(prep.uid)) {
        logoutStatus(prep, "서버의 초안을 아직 확인하지 못했습니다. Retry 또는 Recover Draft로 다시 확인하세요.");
        return;
      }
      if (prep.state === "failed") saveForLogout(prep);
      else recoverEndedDraft(prep);
    }

    /**
     * Back to Editing: 준비(또는 그 앞의 기다림)를 취소하고 편집으로 돌아간다. 묻지도 기다리지도 않는다 — 글은 화면에
     * 그대로이고, 연결된 뷰어는 닫힌 적이 없으니 보던 그대로 이어 간다(재개를 알린다). 준비의 취소는 새 작업 세대다: 준비
     * 전에 나갔던 일의 답은 돌아오지 않고, 멈췄던 일은 지금 문맥에서 다시 시작한다. 보존 저장이 아직 나가 있어도 돌아간다:
     * 그 쓰기와 뒤의 쓰기는 초안 revision으로 차례가 정해지고, 저장을 확인하지 못한 글은 수렴 표시로 남아 다음 자동 저장이
     * 다시 가져간다. 서버에 연결되지 않아 저장이 실패한 때에도 돌아갈 수 있어야 하므로 여기서 서버에 묻지 않는다 — 그 사이
     * 이 세션이 끝났는지는 다음 요청의 답이 말하고, 그때는 글을 잡아 둔 채 화면이 닫힌다.
     */
    function returnToEditing(prep) {
      if (logoutPrep !== prep || !["waiting", "saving", "failed"].includes(prep.state)) return;
      const permit = prep.permit, prepared = prep.state !== "waiting";
      prep.state = "cancelled";
      // Back to Editing: 이 준비의 표지만 지운다(다른 준비·다른 세션의 기록과 이미 실제 종료로 올라간 기록은 그대로).
      KinAuth.cancelLeaving(prep.id);
      try {
        prep.panel?.close();
        prep.panel?.remove();
        logoutPrep = null;
        loggingOut = false;
        // 준비에 들어선 적이 없으면(나가 있는 확정·삽입을 기다리던 중) 멈춘 것도 없다.
        if (!prepared) return;
        for (const report of prep.reports || []) if (!report.safe) reportConverge.add(report.uid);
        if (!work.cancelPreparation(permit)) return;
        KinAuth.notifyPreparation("resumed", prep.id);
        resumeWork();
      } finally {
        // 준비 잠금을 푸는 한 자리: 재개를 알린 뒤에 푼다. 그 밖의 길(실제 종료, 닫힌 탭)은 이 문서가 사라질 때 브라우저가 푼다.
        prep.release?.();
      }
    }

    /** 세션이 끝난 뒤 사람이 버리기로 했다. 그제야 이 문서를 떠난다. */
    function dropEndedDraft(prep) {
      // 무엇을 버리는지 말한다: 저장을 확인한 검사는 여기 없다. 세션이 끝난 뒤이므로 검사는 식별값으로만 부른다.
      const pending = (prep.reports || []).filter(report => !report.safe);
      if (!confirm(`저장하지 못한 ${pending.length}건의 판독문 초안을 버릴까요?\n` + pending.map(report => report.uid).join("\n") +
          "\n버린 내용은 되돌릴 수 없습니다. 저장을 확인한 검사는 그대로 보존됩니다.")) return;
      if (logoutPrep !== prep || prep.state !== "ended") return;
      forgetCapture(prep);
      prep.state = "done";
      KinAuth.leave();
    }

    /**
     * Recover Draft: 사람이 다른 창에서 다시 로그인한 뒤 누른다. 이 문서는 닫힌 채이고 화면을 다시 열지 않는다. 누를 때마다
     * 이 브라우저의 지금 세션이 누구의 것인지 한 번 읽고(auth.js recoveryBinding — 이 문서의 신원으로 삼지 않는다), 받아 둔
     * 글의 계정과 같을 때만 그 세션의 식별값으로 요청을 보낸다: 다른 계정의 세션으로는 이 글을 보이지도 저장하지도 않는다.
     * 쓰기는 다른 초안 쓰기와 같은 명령 경로다. 먼저 서버의 지금 초안과 revision을 읽어 기준을 정한다 — 이 문서가 앞서 보낸
     * 쓰기(답 없이 끊긴 것 포함)가 그 사이 기록됐으면 그 위에, 아니면 원래 기준 위에 쓴다. 서버가 revision을 대조하므로 끊긴
     * 쓰기가 나중에 닿아도 복구한 글을 덮지 못한다. 다른 내용이 먼저 기록돼 있으면 충돌이고 사람이 덮어쓰기를 고를 때만 다시
     * 보낸다. 잡아 둔 원문은 답의 봉투(또는 그 뒤의 전체 읽기)가 작성자·검사·revision·원문 전부의 일치를 보일 때만 버린다.
     */
    async function recoverEndedDraft(prep) {
      if (logoutPrep !== prep || prep.state !== "ended" || prep.recovering) return;
      prep.recovering = true;
      // 닫힌 문서의 일이다: 업무 문맥이 아니라 이 문서의 닫힘 안내만 바꾸는 수명주기 문맥을 지난다.
      const at = work.capture("lifecycle");
      const ended = () => logoutPrep === prep && prep.state === "ended";
      const say = text => work.commit(at, () => { if (ended()) logoutStatus(prep, text); });
      const kept = " 입력한 내용은 이 창에 그대로 있습니다.";
      const noSession = "로그인한 세션이 없습니다. 다른 창에서 같은 계정으로 로그인한 뒤 다시 누르세요.";
      const otherAccount = "같은 계정·기관으로 로그인했을 때만 저장합니다. 지금 세션으로는 저장하지 않았습니다.";
      // 어느 검사에나 같은 답이 올 실패의 안내(아래 everyStudy). 검사 하나의 거절은 그 검사의 사유로 목록에 적힌다.
      const explain = result => result.outcome === "auth" ? noSession
        : result.outcome === "owner" ? otherAccount
        : result.outcome === "unsent" ? "요청을 보내지 못했습니다." + kept
        : "서버의 답을 확인하지 못했습니다." + kept;
      try {
        say("로그인 상태를 확인하는 중입니다…");
        const binding = await KinAuth.recoveryBinding();
        if (!ended()) return;
        if (binding.status === "none") { say(noSession); return; }
        if (binding.status !== "ok") { say("로그인 상태를 확인하지 못했습니다. 잠시 뒤 다시 누르세요." + kept); return; }
        const owner = prep.owner ?? {};
        if (binding.owner.sub !== owner.sub || (binding.owner.institution ?? null) !== (owner.institution ?? null)
            || binding.owner.author !== owner.author) { say(otherAccount); return; }
        const via = { context: at, session: binding.session };
        await draftClient.settled();
        if (!ended() || !work.admits(at)) return;
        /**
         * 검사 하나가 받아들여지지 않는다고 나머지를 버려 두지 않는다. 예전에는 서버가 받지 않는 첫 검사에서 돌아 나와,
         * 그 뒤 검사들의 글은 몇 번을 눌러도 시도조차 되지 않았고 남은 단추는 전부를 버리는 것뿐이었다. 그 검사 하나의
         * 답(점유·권한·보이지 않는 검사·받을 수 없는 상태·기준을 모름·실제 충돌)은 그 검사에 사유로 적고 다음 검사로
         * 간다 — 받아들여지지 않은 검사를 저장된 것으로 세지 않고, 충돌은 여전히 사람이 Overwrite Server Draft를 고를
         * 때까지 기다린다. 어느 검사에나 같은 답이 올 것(세션 없음·다른 계정·연결 실패·결과 모름)에서만 멈춘다.
         */
        const everyStudy = result => ["auth", "owner", "unknown", "unsent"].includes(result.outcome);
        const refusalOf = result => result.code === "REPORT_HELD" ? "held" : "refused";
        for (const report of prep.reports) {
          if (report.safe) continue;
          if (!work.commit(at, () => { prep.uid = report.uid; prep.texts = report.texts; report.reason = null; })) return;
          // 결과를 모르는 확정이 남은 검사는 그 글을 초안으로 쓰기 전에 판독 상태부터 읽는다(보존 저장과 같다).
          if (reportUnknownCommits.has(report.uid)) {
            say("서버의 판독 상태를 확인하는 중입니다…");
            const learned = await learnCommitOutcome(report.uid, at, binding.session);
            if (!ended()) return;
            if (learned.outcome === "unknown") { say("서버의 판독 상태를 확인하지 못했습니다. 잠시 뒤 다시 누르세요." + kept); return; }
            if (learned.outcome === "landed") {
              if (!learned.later) { if (!work.commit(at, () => { report.safe = true; })) return; continue; }
              if (!work.commit(at, () => { prep.texts = report.texts = Object.freeze({ ...report.texts, baseVersion: learned.version }); })) return;
            }
          }
          let reason = null;
          for (let round = 0; ; round += 1) {
            say("서버의 초안을 확인하는 중입니다…");
            const base = await draftClient.base(prep.uid, { owner: prep.owner, ...via });
            if (!ended()) return;
            if (base.outcome === "conflict") {
              // 충돌 때의 읽기가 실패했었으면 여기서 다시 읽는다. 서버에 있는 것이 이 문서의 글이면 풀리고 이어 간다.
              const got = base.latest ? null : await draftClient.latest(prep.uid, { owner: prep.owner, ...via });
              if (!ended()) return;
              if (got?.resolved && round === 0) continue;
              reason = "conflict";
              break;
            }
            if (base.outcome !== "ready") {
              if (everyStudy(base)) { say(explain(base)); return; }
              reason = refusalOf(base);
              break;
            }
            const capture = { uid: prep.uid, owner: prep.owner, expectedRevision: base.revision,
              snapshot: { ...prep.texts, citations: base.lists.citations, structured: base.lists.structured } };
            // 서버가 이미 이 원문 전부를 갖고 있다(답을 잃었던 저장이 기록돼 있었다): 다시 쓸 것 없이 저장이 확인됐다.
            if (KinReportDraftClient.sameSnapshot(base.stored, RFIELDS.every(k => !prep.texts[k]) ? null : capture.snapshot)) break;
            say("판독문 초안을 저장하는 중입니다…");
            // 명령 경로가 충돌·결과 모름을 서버의 지금 초안으로 먼저 확인한다: 잡아 둔 원문이 거기 전부 있을 때만 저장이다.
            const result = await draftClient.preserve(capture, via);
            if (!ended()) return;
            if (result.outcome === "rebased" && round === 0) continue;
            if (result.outcome === "saved") break;
            if (result.outcome === "conflict") { reason = "conflict"; break; }
            if (everyStudy(result)) { say(explain(result)); return; }
            // 두 번째에도 기준만 옮겨졌다(그 사이 이 문서의 다른 쓰기가 또 닿았다): 이 검사의 저장은 확인하지 못했다.
            reason = result.outcome === "rebased" ? "unknown" : refusalOf(result);
            break;
          }
          if (!work.commit(at, () => {
            if (reason) report.reason = reason;
            else { report.safe = true; reportConverge.delete(report.uid); }
          })) return;
        }
        work.commit(at, () => {
          if (!ended()) return;
          const left = prep.reports.filter(report => !report.safe);
          if (left.length) {
            // 남은 것과 그 사유를 다시 그린다. 덮어쓰기를 고를 수 있는 충돌이 있으면 그 검사가 다음에 고를 대상이다.
            const current = left.find(report => report.reason === "conflict") || left[0];
            const stored = prep.reports.length - left.length;
            prep.uid = current.uid; prep.texts = current.texts; prep.reason = current.reason;
            showLogoutPanel(prep);
            logoutStatus(prep, (stored ? `${stored}건은 저장했습니다. ` : "") + `${left.length}건은 저장하지 못했습니다 — 사유는 위 목록에 있습니다.`
              + (current.reason === "conflict" ? " Overwrite Server Draft를 누르면 충돌한 검사를 이 창의 내용으로 덮어씁니다." : "") + kept);
            return;
          }
          forgetCapture(prep);
          prep.state = "done";
          logoutStatus(prep, "판독문 초안을 저장했습니다. 로그인 화면으로 이동합니다…");
          KinAuth.leave();
        });
      } finally {
        // 이 복구가 세운 표시는 이 복구가 내린다(자기 것만).
        prep.recovering = false;
      }
    }

    const LOGOUT_TITLES = { waiting: "Logging Out", saving: "Saving Draft", failed: "Draft Not Saved", closing: "Logging Out",
      ended: "Session Ended" };
    const LOGOUT_NOTES = {
      waiting: "진행 중인 저장 또는 초안 버리기가 끝나는 대로 로그아웃을 이어 갑니다. 다시 누를 필요가 없습니다.",
      saving: "작성 중인 판독문 초안을 저장한 뒤 로그아웃합니다. 저장을 확인하면 바로 이어 갑니다.",
      closing: "로그아웃하는 중입니다. 업무 화면은 닫혔습니다.",
      ended: "로그인 세션이 끝나 판독문 초안을 저장하지 못했습니다. 입력한 내용은 이 창의 메모리에만 있고 새로고침하거나 창을 닫으면 "
        + "사라집니다. 다른 창에서 같은 계정으로 다시 로그인한 뒤 Recover Draft를 누르면 저장을 다시 시도합니다.",
    };
    const LOGOUT_FAILED = {
      offline: "서버에 연결되지 않아 판독문 초안을 저장하지 못했습니다.",
      held: "다른 판독의가 이 검사를 판독 중이라 판독문 초안을 저장하지 못했습니다.",
      refused: "서버가 판독문 초안 저장을 받아들이지 않았습니다.",
      unknown: "판독문 초안 저장의 결과를 확인하지 못했습니다. 저장됐을 수도 있고 아닐 수도 있습니다.",
      conflict: "서버에 이 화면과 다른 초안이 있어 판독문 초안을 저장하지 않았습니다. Overwrite Server Draft를 누르면 이 화면의 내용으로 덮어씁니다.",
    };

    function logoutStatus(prep, text) {
      const line = prep.panel?.querySelector("[role=status]");
      if (line) line.textContent = text;
    }

    /**
     * 준비·종료 창. 모달이라 뒤의 업무 화면은 가려지고 누를 수 없다(편집·검사 이동·새 작업 없음). Escape로 닫지 않는다.
     * After session end, show only study identifiers, never patient labels or report text.
     */
    function showLogoutPanel(prep) {
      if (!prep.panel) {
        prep.panel = document.createElement("dialog");
        prep.panel.className = "kin-logout";
        prep.panel.setAttribute("aria-labelledby", "kin-logout-title");
        prep.panel.addEventListener("cancel", event => event.preventDefault());
        document.body.append(prep.panel);
      }
      const title = document.createElement("h2");
      title.id = "kin-logout-title";
      // 판독문 초안 밖의 저장하지 않은 작업을 묻는 창(A006): 같은 창, 같은 두 갈래(돌아가기 / 버리고 나가기).
      const otherWork = prep.state === "failed" && prep.reason === "work";
      title.textContent = otherWork ? "Unsaved Work" : LOGOUT_TITLES[prep.state] || LOGOUT_TITLES.closing;
      const note = document.createElement("p");
      note.textContent = otherWork
        ? "저장하지 않은 작업이 있어 로그아웃하지 않았습니다. 로그아웃하면 아래 작업은 사라집니다. Back to Editing을 누르면 보던 그대로 돌아갑니다."
        : prep.state === "failed"
        ? `${LOGOUT_FAILED[prep.reason] || LOGOUT_FAILED.refused} 로그아웃하지 않았고 입력한 내용은 이 화면에 그대로 있습니다.`
        : LOGOUT_NOTES[prep.state] || LOGOUT_NOTES.closing;
      const pending = document.createElement("p");
      if (otherWork) pending.textContent = (prep.work || []).join("\n");
      else if (["failed", "ended"].includes(prep.state)) {
        const label = report => prep.state === "ended" ? report.uid : `${report.label || report.uid} (${report.uid})`;
        const current = (prep.reports || []).find(report => report.uid === prep.uid);
        pending.textContent = "보존이 필요한 검사: " + (prep.reports || []).filter(r => !r.safe)
          .map(report => label(report) + (report.reason ? " — " + LOGOUT_FAILED[report.reason] : "")).join("\n")
          + (current ? " · 현재 확인 중: " + label(current) : "");
      }
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      const actions = document.createElement("div");
      const button = (label, act) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", act);
        actions.append(b);
      };
      // 덮어쓰기는 충돌했고 서버의 초안을 읽어 온 뒤에만 고를 수 있다.
      const overwritable = prep.reason === "conflict" && !!prep.uid && !!draftClient.conflict(prep.uid)?.latest;
      if (prep.state === "waiting" || prep.state === "saving") {
        // 기다리는 동안에도 돌아갈 수 있다 — 준비의 취소는 아무것도 잃지 않는다.
        button("Back to Editing", () => returnToEditing(prep));
      } else if (otherWork) {
        button("Back to Editing", () => returnToEditing(prep));
        button("Discard and Log Out", () => logOutAnyway(prep));
      } else if (prep.state === "failed") {
        button("Retry", () => { if (logoutPrep === prep && prep.state === "failed") saveForLogout(prep); });
        if (overwritable) button("Overwrite Server Draft", () => overwriteServerDraft(prep));
        button("Back to Editing", () => returnToEditing(prep));
        button("Discard and Log Out", () => discardAndLogOut(prep));
      } else if (prep.state === "ended") {
        button("Recover Draft", () => recoverEndedDraft(prep));
        if (overwritable) button("Overwrite Server Draft", () => overwriteServerDraft(prep));
        button("Discard Draft", () => dropEndedDraft(prep));
      }
      prep.panel.replaceChildren(title, note, pending, status, actions);
      if (!prep.panel.open) prep.panel.showModal();
      actions.querySelector("button")?.focus();
    }

    // 다른 사람이 잡거나 놓은 걸 보려면 주기적으로 확인해야 한다.
    // 기본 30초. 간격 변경은 진행 중인 이전 조회도 무효화한다.
    let poll = null, pollGeneration = 0;
    function startPolling() {
      clearInterval(poll); poll = null;
      const generation = ++pollGeneration;
      const seconds = worklistRefresh?.seconds() ?? 30;
      if (!serverMode || !seconds) return;
      poll = setInterval(async () => {
        if (generation !== pollGeneration || !serverMode || document.hidden || studyPageClient.busy || studyPageClient.paused) return;
        /**
         * 확정이 나가 있으면 이번 회차는 건너뛴다.
         * 폴링 요청이 확정보다 **먼저 나가고 나중에 도착**하면, 방금 승인한 rs=A를
         * 낡은 rs=T로 되돌린다. 화면이 되돌아가면 판독의는 Approve를 또 누르고,
         * baseVersion이 맞아 통과하므로 판이 하나 더 쌓인다.
         */
        if (commitInFlight) return;
        // 이 회차를 시작한 문맥. 로그아웃 준비 중에는 시작하지 않고, 답과 실패가 목록·판독문·연결 상태에 닿는 자리는 모두
        // 이것을 지난다 — 준비·그 취소·세션 종료 뒤에 온 회차는 아무것도 바꾸지 않고 실패로 세지도 않는다.
        const at = work.capture("document");
        if (!work.admits(at)) return;
        const live = () => work.admits(at) && generation === pollGeneration;
        const epoch = commitEpoch;
        try {
          /**
           * **`/bootstrap`이 아니라 `/studies`를 본다.**
           *
           * bootstrap은 StudyState 행만 준다. 그런데 장비에서 막 C-STORE로 도착한
           * 검사는 아직 행이 없다 — 서버가 목록을 만들 때 비로소 생긴다. bootstrap만
           * 보면 그 검사는 다음 새로고침 전까지 아무에게도 안 보인다. 방사선사가
           * 확인해야 판독이 시작되는 구조에서, 도착을 못 보는 건 워크플로가 멈춘 것이다.
           *
           * /studies는 목록과 상태를 함께 주므로 도착·원격판독 수신·상태 변화를
           * 한 번에 잡는다. (오더는 자주 안 바뀌므로 여기서 갱신하지 않는다)
           */
          const r = await studyPageClient.read({ epoch, valid:() => live() && !commitInFlight && epoch === commitEpoch });
          // 요청을 보낸 뒤 확정이 일어났다면 이 응답은 그 이전 사진이다. 버린다.
          if (!live() || commitInFlight || epoch !== commitEpoch) return;
          assertStudyOwner(r);
          await Promise.all([favoriteList?.refresh(),studyTagList?.refresh()]);
          if (!live() || commitInFlight || epoch !== commitEpoch) return;
          pollFails = 0;
          worklistAlerts?.observe(r.studies.map(s=>({uid:s.uid,em:s.state.em})));
          applyObservation(r);
          const arrivals = window.KinStudyArrivals?.diff(studies, r.studies);
          const arrivalNotice = arrivals?.ok && arrivals.changes.length
            ? `기존 검사 ${arrivals.changes.length}건에 영상 또는 시리즈가 추가됐습니다. 현재 영상 화면은 자동 교체하지 않습니다.` : '';
          const known = new Map(studies.map(x => [x.uid, x]));
          const fresh = r.studies.filter(s => !known.has(s.uid));

          // 목록이 달라졌으면(도착·삭제) 통째로 다시 그린다.
          if (fresh.length || r.studies.length !== studies.length) {
            // 지키는 칸은 `fromApi`가 지나는 `mergeObservedReportState` 한 곳이 정한다 — 목록을 통째로
            // 다시 그리는 이 길도 결국 그 함수를 지나므로 여기서 따로 되돌릴 것이 없다.
            studies = r.studies.map(fromApi);
            // 썸네일 등 오른쪽 전체를 다시 그릴 필요는 없지만, 판독문 잠금은 반영해야 한다.
            // loadReport가 값만 보호하므로 새 검사 도착과 Prelim 전환이 겹쳐도 입력은 유지된다.
            render();
            if (selectedUid) { loadReport(); updateReportButtons(); }
            if (fresh.length || arrivalNotice)
              toast([fresh.length ? `새 검사 ${fresh.length}건이 도착했습니다` +
                    (fresh.some(s => s.state.ss === "Unverified") ? " — Technician 탭에서 확인(Verify)하세요" : "") : '', arrivalNotice].filter(Boolean).join(' · '), "info");
            return;
          }

          for (const s of r.studies) {
            const uid = s.uid, st = s.state, existing = known.get(uid);
            if (existing) for (const field of ['count', 'series'])
              if (Number.isSafeInteger(s[field]) && s[field] >= 0) existing[field] = s[field];
            updateNoteSummary(uid, s.techNote);
            updateReaderAssignment(uid, s.readerAssignment);
            if (uid === selectedUid) {
              // 지금 편집 중인 검사는 두 가지만 보호한다:
              //   version — baseVersion은 "내가 화면에서 본 판"이어야 한다. 폴링이 몰래
              //     올리면 남이 저장한 걸 본 적도 없으면서 최신을 아는 셈이 되어, 다음
              //     저장이 충돌 경고 없이 남의 판독문을 덮는다. 낙관적 락의 조용한 무력화.
              //   draft — 타이핑 중인 내 초안. 서버 응답이 한 박자 늦으면 방금 친 문장이
              //     되돌아간다. 확정본(findings 등)은 갱신해도 된다 — 초안이 있는 동안
              //     화면은 초안을 그리고, 확정본은 "그 사이 남이 v5를 확정했다" 안내에만 쓰인다.
              // 나머지(rs·ss·holder 등)도 갱신한다. 남이 승인한 게 화면에 보여야 하니까.
              appState[uid] = mergeObservedReportState(uid, st);
              /**
               * 판독문 값은 loadReport가 스스로 지키므로, 호출자는 항상 상태를 반영한다.
               * 예전엔 폴링이 `prelimHidden`만 반영하고 판독문 패널은 그대로 뒀다 —
               * 내가 읽는 중에 남이 그 검사를 Prelim으로 넘기면 내용이 그대로 남고
               * 버튼도 활성인 채라, Save를 눌러야 403을 만났다. (남은버그 3-1)
               */
            } else {
              /**
               * 고르지 않은 검사도 **수렴을 기다리는 초안**은 덮지 않는다. 삽입이 나가 있는
               * 동안 검사를 옮기면 그때 담아 둔 타건이 이 칸에만 있고, 그 삽입이 거절되면
               * 서버 어디에도 없다. 폴링 한 번이 그것을 서버 투영으로 갈아끼우면 돌아온
               * 화면은 옛 글을 그리고, 수렴 저장이 그 옛 글을 서버에 밀어 넣는다.
               */
              appState[uid] = mergeObservedReportState(uid, st);
            }
            syncStudy(uid);
            if (selectedUid === uid) { loadReport(); updateReportButtons(); }
          }
          render();
          if (arrivalNotice) toast(arrivalNotice, 'info');
          pollFails = 0;
        } catch (e) {
          if (!live()) return;
          // 목록 읽기가 "계정이 바뀌었다"고 했다. 이 세션에 묶어 한 번 확인해 정말 다른 계정의 답일 때만 세션 교체로 닫는다.
          // 401·403으로 읽지 못한 것은 이 회차의 실패일 뿐이다.
          if (e.ownerChanged) {
            studyPageClient.clear();
            if (await accountReplaced(at)) return;
            if (!live()) return;
          }
          if (e.stale || e.code === 'STUDY_LIST_CHANGED') return;
          // The first failure already says 관측 불가 beside the kept list; going offline waits for two.
          markObservationUnavailable();
          /**
           * **일하는 도중에 서버가 죽는 경우.**
           *
           * 예전엔 폴링의 catch가 통째로 비어 있어서, API가 죽어도 화면은 아무 말도
           * 안 했다. 판독의는 계속 쓰고 Save를 누를 때가 되어서야 알게 됐다.
           * 두 번 연속 실패하면 고장으로 본다. 한 번은 blip일 수 있다.
           */
          if (++pollFails >= 2) goOffline(e);
        }
      }, seconds * 1000);
    }
    let pollFails = 0;

    // ── 판독문 이력 ──
    /**
     * 이 모달 한 번의 열람을 가르는 번호. 목록 읽기와 판별 인용 읽기가 전부 이 번호를 들고
     * 나가고, 돌아왔을 때 번호가 다르면 **아무것도 쓰지 않는다.** 검사 A→B→A도 같은 규칙이다.
     */
    let historyEpoch = 0, historyUid = null;
    const historyReads = new Set();   // 지금 나가 있는 판. 한 판에 한 건만 나간다.
    function historyLive(epoch, uid) {
      return epoch === historyEpoch && uid === historyUid && $("#histmodal").classList.contains("show");
    }
    /**
     * 닫으면 그린 블록과 판별 상태를 **버린다.** 회수된 가독이 숨은 DOM에 살아남지 않게 하는
     * 유일한 규칙이고, 다음에 열면 목록도 증적도 다시 읽는다.
     */
    function closeHistory() {
      historyEpoch += 1;
      historyUid = null;
      historyReads.clear();
      $("#hist-body").replaceChildren();
      $("#histmodal").classList.remove("show");
    }
    /**
     * 답은 **그 판 하나**에 대한 것인가. 존재 상태는 서버가 그 판 자신의 본문에 대해 계산해
     * 보내므로, 축약이 아닌 건에 그 낱말이 없으면 그 판 전체를 모른다고 말한다 — 상태 없는
     * 줄을 「확인된 증적」처럼 그리지 않는다.
     */
    function historyAnswerOk(answer, version) {
      if (!answer || typeof answer !== "object") return false;
      if (!Number.isSafeInteger(answer.version) || answer.version !== version) return false;
      if (typeof answer.actor !== "string" || !answer.actor) return false;
      if (!Array.isArray(answer.entries)) return false;
      for (const entry of answer.entries) {
        if (!entry || typeof entry !== "object") return false;
        if (!RFIELDS.includes(entry.field)) return false;
        if (entry.state === "source-unavailable") continue;
        if (!["present", "absent", "ambiguous"].includes(entry.presence)) return false;
      }
      return true;
    }
    function historyNote(host, text) {
      const note = document.createElement("div");
      note.className = "vcite";
      const line = document.createElement("p");
      line.textContent = text;
      note.append(line);
      host.replaceChildren(note);
    }
    /**
     * 지면과 **같은 포매터**를 쓰되 본문은 넘기지 않는다. 축약 판별과 존재 상태만 이 화면의
     * 답으로 바꿔 끼운다(출하된 판별은 `insertedText`가 없는 건을 전부 축약으로 본다).
     * 라이브러리는 **호출 시점에** 읽는다.
     */
    function historyCitationBlock(host, state, answer) {
      const citation = KinReportCitation;
      const part = KinReportPaper.citationSection({
        state, entries: answer ? answer.entries : [], texts: {}, actorName: displayActor,
        actor: answer ? answer.actor : null,
        citation: { ...citation, isReduced: e => !e || e.state === "source-unavailable",
          presenceOf: e => (!e || e.state === "source-unavailable") ? null : e.presence } });
      const box = document.createElement("div");
      box.className = "vcite";
      const title = document.createElement("h5");
      title.textContent = part.heading;
      box.append(title);
      // 줄은 전부 텍스트 노드다. 작성자 표시명은 사용자 입력이고 이 화면은 기록이다.
      for (const line of part.lines) {
        const row = document.createElement("p");
        row.textContent = line;
        box.append(row);
      }
      host.replaceChildren(box);
    }
    async function loadHistoryCitations(uid, version, host, button) {
      if (historyReads.has(version)) return;
      const epoch = historyEpoch;
      historyReads.add(version);
      button.disabled = true;
      historyNote(host, "확인하는 중입니다");
      const at = work.capture("document");
      let answer = null, state = "unknown";
      try {
        answer = await api("GET", `/studies/${encodeURIComponent(uid)}/report/versions/${version}/citations`, undefined, undefined, at);
        state = historyAnswerOk(answer, version) ? "ok" : "unknown";
      } catch (e) {
        // 서버가 알린 세션 종료는 전송이 이미 넘겼다. 끝난 화면에 증적 상태를 그리지 않는다.
        if (e?.auth) return;
        state = e?.status === 403 ? "refused" : "unknown";
      }
      // 닫혔거나 다른 열람이거나 작업 문맥이 바뀌었으면 아무것도 쓰지 않는다. 같은 판을 다시 눌러 실패하면 그 판의
      // 이전 줄은 **교체된다** — 회수된 가독이 옛 줄로 남아 있으면 확인이 아니게 된다.
      if (!work.admits(at) || !historyLive(epoch, uid)) return;
      historyReads.delete(version);
      button.disabled = false;
      historyCitationBlock(host, state, state === "ok" ? answer : null);
    }
    async function showHistory() {
      const uid = selectedUid;
      if (!uid) { alert("검사를 선택하세요."); return; }
      const box = $("#hist-body");
      const epoch = ++historyEpoch;
      historyUid = uid;
      historyReads.clear();
      $("#histmodal").classList.add("show");
      box.innerHTML = "<div style='color:#667;padding:10px'>불러오는 중…</div>";
      if (!serverMode) {
        box.innerHTML = "<div style='color:#d8b24a;padding:10px'>서버에 연결돼 있을 때만 이력이 남습니다.</div>";
        return;
      }
      const at = work.capture("document");
      try {
        const list = await api("GET", `/studies/${encodeURIComponent(uid)}/report/versions`, undefined, undefined, at);
        // 늦게 온 답이 새 열람의 목록을 덮지 않는다.
        if (!work.admits(at) || !historyLive(epoch, uid)) return;
        const LABEL = { save: "임시저장", approve: "승인", addendum: "추가기재", reset: "판독취소",
                        preliminary: "예비판독", discarded: "폐기된 초안" };
        box.innerHTML = list.length ? list.map(v => `
          <div class="ver" data-version="${esc(v.version)}">
            <div class="vh">
              <b>v${v.version}</b>
              <span class="tag ${esc(v.action)}">${esc(LABEL[v.action] ?? v.action)}</span>
              <span>${esc(displayActor(v.author))}</span>
              <span style="color:#667">${esc(String(v.at).replace("T", " ").slice(0, 19))}</span>
            </div>
            ${v.reason ? `<div class="vr">사유: ${esc(v.reason)}</div>` : ""}
            ${v.findings || v.conclusion || v.recommendation
              ? `<pre>${esc([v.findings, v.conclusion, v.recommendation].filter(Boolean).join("\n---\n"))}</pre>`
              : `<div style="color:#556;padding:4px 0">(내용 없음)</div>`}
            <div class="vcite-row"><button class="vcite-btn" data-version="${esc(v.version)}"
                 title="이 판의 인용 증적을 서버에서 확인합니다">Show Citations</button></div>
            <div class="vcite-host" data-version="${esc(v.version)}"></div>
          </div>`).join("")
          : "<div style='color:#667;padding:10px'>아직 확정된 판이 없습니다. Save 또는 Approve를 누르면 여기 쌓입니다.</div>";
        // 증적은 **사람이 고른 판만** 읽는다. 이력이 길어도 한 번 열람의 비용이 늘지 않는다.
        for (const button of box.querySelectorAll(".vcite-btn")) {
          const version = Number(button.dataset.version);
          const host = button.closest(".ver")?.querySelector(".vcite-host");
          if (!Number.isSafeInteger(version) || version < 1 || !host) { button.remove(); continue; }
          button.addEventListener("click", () => loadHistoryCitations(uid, version, host, button));
        }
      } catch (e) {
        // 늦게 온 **실패**도 새 열람의 목록을 오류 문구로 덮지 않는다.
        if (!work.admits(at) || !historyLive(epoch, uid)) return;
        box.innerHTML = `<div style="color:#ff8080;padding:10px">${esc(e.message)}</div>`;
      }
    }
    $("#b-history").addEventListener("click", showHistory);
    $("#hist-close").addEventListener("click", closeHistory);

    /**
     * Clear — 세 칸을 한 번에 비운다.
     *
     * 예전엔 확인창도, 권한 검사도, 잠금 검사도 없었다. 그리고 비운 뒤 다른 검사를
     * 클릭하면 초안 저장이 조용히 빈 판독문을 `Report`에 써서 **승인본까지 지웠다.**
     *
     * 초안이 분리된 지금 Clear가 비우는 것은 **내 초안뿐**이다. 저장된 판독문은
     * 손댈 수 없다 — 뒷문이 코드가 아니라 구조에서 없어졌다.
     * 아래 세 검사는 이제 안전장치가 아니라 예의다:
     *   ① 승인된 판독문에서는 막는다. 지워지진 않지만 빈 화면이 "사라졌다"로 읽힌다.
     *   ② 권한·예비판독 잠금.
     *   ③ 확인창 — 되돌릴 수 없는 동작에 손이 미끄러질 자리를 주지 않는다 (교훈 §5).
     */
    $("#b-clear").addEventListener("click", () => {
      const why = reportWriteBlock();
      if (why) { toast(why, "err"); return; }
      const s = cur();
      if (s?.rs === "A") {
        toast("승인된 판독문은 Clear로 비울 수 없습니다 — 판독 취소(Reset)를 사용하세요", "err");
        return;
      }
      const has = $("#findings").value || $("#conclusion").value || $("#recommendation").value;
      if (!has) return;
      if (!confirm("쓰고 있던 판독문 세 칸(Findings/Conclusion/Recommendation)을 모두 비웁니다.\n" +
                   "저장된 판독문은 그대로 남습니다. 계속할까요?")) return;
      // 비운 것도 이 문서의 편집이다: 표시가 서야 다음 폴링이 옛 글을 되살리지 않고, 비운 초안이 서버에 닿는다.
      if (!editReport(RFIELDS.map(field => ({ field, start: 0, end: $("#" + field).value.length, text: "" })))) return;
      toast("쓰던 내용을 비웠습니다 — 저장된 판독문은 그대로입니다", "info");
    });
    $("#b-copy").addEventListener("click", () => {
      const t = `Findings:\n${$("#findings").value}\n\nConclusion:\n${$("#conclusion").value}\n\nRecommendation:\n${$("#recommendation").value}`;
      navigator.clipboard?.writeText(t);
      toast("판독문을 복사했습니다");
    });
    // Paste도 `.value`에 직접 쓴다 — readOnly를 무시하는 같은 경로다.
    $("#b-paste").addEventListener("click", async () => {
      const why = reportWriteBlock();
      if (why) { toast(why, "err"); return; }
      // 붙여넣기는 편집기에 쓴다. 클립보드를 읽는 사이 검사가 바뀌었거나, 로그아웃 준비·세션 종료가 있었거나, 그 칸의 글이
      // 달라졌으면 쓰지 않는다 — 읽기 전에 본 글 위에 덮어쓰지 않는다. (붙여넣기 자체의 편집 안전은 편집기 단위의 몫이다.)
      const at = work.capture("editor");
      let text;
      try { text = await navigator.clipboard.readText(); } catch (e) { return; }
      work.commit(at, () => {
        if (reportWriteBlock()) return;
        // Findings 끝에 붙인다. 붙여 넣은 글은 타이핑한 글과 같은 이 문서의 편집이다 — 표시 없이 대입만 하면 자동 저장도
        // 로그아웃도 그 글을 모르고 다음 폴링이 서버 글로 덮는다(U5CLI-F09).
        const end = $("#findings").value.length;
        editReport([{ field: "findings", start: end, end, text }]);
      });
    });
    const reportPreview = KinReportPreview({ api, actorName: displayActor, toast,
      context: () => ({ uid: selectedUid, online: serverMode && !offline && !demoMode,
        editor: Object.fromEntries(RFIELDS.map(key => [key, $("#" + key).value])) }) });
    $("#b-print").addEventListener("click", () => reportPreview.open());

    // Prev/Next: 필터된 목록에서 이전/다음 검사로 이동
    /**
     * Prev/Next — 필터된 목록에서 이전/다음 검사로.
     *
     * 선택된 검사가 목록에 없으면 `findIndex`가 **-1**이다. 예전엔 그대로 더해서
     * `list[-1 + 1]` = 목록 맨 위로 튀었다. 탭을 바꾸거나 필터를 걸어 선택이 빠지면
     * Next가 "다음"이 아니라 "처음"이 되는 것이다. Prev는 `list[-2]`라 아무 일도 안 났다 —
     * 두 버튼이 서로 다르게 틀렸다.
     * 목록 밖이면 방향에 맞게 끝에서 시작한다: Next는 첫 번째, Prev는 마지막.
     */
    function move(step) {
      const list = orderedStudies();
      if (!list.length) return;
      const i = list.findIndex(s => s.uid === selectedUid);
      if (i === -1) { select(step > 0 ? list[0].uid : list[list.length - 1].uid, { openSelected: true }); return; }
      const next = list[i + step];
      if (next) select(next.uid, { openSelected: true });
    }
    $("#b-prev").addEventListener("click", () => move(-1));
    $("#b-next").addEventListener("click", () => move(1));

    // ── 공통 이벤트 ──
    // 판독 창 위치는 계정 데이터가 아니라 이 브라우저·이 장비의 작업환경 설정이다.
    const OHIF_RECT_KEY = "kin.ohif.current.rect";
    let ohifPopupHandle = null;
    const ohifRectPolls = new Map(), ohifPopupSlots = new WeakMap(), ohifPopupSequences = new WeakMap();
    const ohifPlacementWrites = new WeakMap();
    let ohifOpenSeq = 0;
    let monitorPermission = null;
    let monitorQueryUnsupported = false;
    let monitorSessionGranted = false;
    let screensCache = [];
    let monitorDetails = null;
    let monitorHintShown = false;

    function monitorPermissionGranted() {
      return monitorPermission?.state === "granted" ||
        (monitorQueryUnsupported && monitorSessionGranted);
    }

    function updateMonitorButton() {
      // PBP 기계 대수가 아니라 OS가 인식한 확장 디스플레이 구성으로 판단.
      // OS가 2개를 확장 화면으로 인식하면 true; 복제 출력·단일 논리 화면이면 보장 없음.
      // Permissions Policy 차단 시 false이므로 false만으로 물리 1대라 단정하지 않음.
      const visible = typeof window.getScreenDetails === "function" && screen.isExtended === true &&
        (monitorPermission?.state === "prompt" || (monitorQueryUnsupported && !monitorSessionGranted));
      $("#b-monitor").style.display = visible ? "" : "none";
    }

    function cacheMonitorScreens(details) {
      if (!monitorPermissionGranted()) return;
      if (monitorDetails && monitorDetails !== details) monitorDetails.onscreenschange = null;
      monitorDetails = details;
      const refresh = () => {
        if (monitorPermissionGranted()) screensCache = details.screens.map(usableScreenRect).filter(Boolean);
        updateMonitorButton();
      };
      details.onscreenschange = refresh;
      refresh();
    }

    async function initMonitorPermission() {
      if (typeof window.getScreenDetails !== "function") return;
      try {
        monitorPermission = await navigator.permissions.query({ name: "window-management" });
        monitorPermission.onchange = () => {
          // 철회 뒤에는 이전 화면 목록으로 저장 위치를 보정하지 않는다.
          if (!monitorPermissionGranted()) {
            screensCache = [];
            if (monitorDetails) monitorDetails.onscreenschange = null;
            monitorDetails = null;
          }
          updateMonitorButton();
        };
        updateMonitorButton();
      } catch (e) {
        monitorQueryUnsupported = e instanceof TypeError;
        updateMonitorButton();
        return;
      }
      if (monitorPermissionGranted()) {
        try { cacheMonitorScreens(await window.getScreenDetails()); } catch (_) {}
      }
    }

    $("#b-monitor").addEventListener("click", async () => {
      // 권한 창에 답하는 사이 준비·종료가 있었으면 그 답으로 업무 화면의 안내·저장 위치를 바꾸지 않는다.
      const at = work.capture("document");
      let details = null;
      try { details = await window.getScreenDetails(); } catch (_) {}
      work.commit(at, () => {
        if (details) {
          if (monitorQueryUnsupported) monitorSessionGranted = true;
          cacheMonitorScreens(details);
          for (let i = 0; i < 4; i++) localStorage.removeItem(i ? OHIF_RECT_KEY + ':' + i : OHIF_RECT_KEY);
          updateMonitorButton();
          toast("모니터 배치 허용됨 — 판독 창이 다른 모니터에 열립니다", "info");
        } else {
          monitorSessionGranted = false;
          updateMonitorButton();
          toast("허용되지 않아 창 자리 기억만 동작합니다 — 다시 켜려면 크롬 사이트 설정에서 '창 관리' 허용", "info");
        }
      });
    });
    screen.addEventListener?.("change", updateMonitorButton);
    initMonitorPermission();

    function usableScreenRect(value) {
      const left = Number(value?.availLeft ?? value?.left ?? 0);
      const top = Number(value?.availTop ?? value?.top ?? 0);
      const width = Number(value?.availWidth ?? value?.width ?? 0);
      const height = Number(value?.availHeight ?? value?.height ?? 0);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      return { left, top, width, height };
    }

    function currentScreenRect() {
      return usableScreenRect(screen) || { left: 0, top: 0, width: 1280, height: 720 };
    }

    function defaultOhifRect(target = currentScreenRect()) {
      const width = Math.min(target.width, Math.max(640, Math.min(1600, target.width - 80)));
      const height = Math.min(target.height, Math.max(600, Math.min(1000, target.height - 80)));
      return {
        left: Math.min(target.left + 40, target.left + target.width - width),
        top: Math.min(target.top + 40, target.top + target.height - height),
        width,
        height,
      };
    }

    function readStoredOhifRect(slot = 0) {
      try {
        const value = JSON.parse(localStorage.getItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY) || "null");
        const rect = {
          left: Number(value?.left), top: Number(value?.top),
          width: Number(value?.width), height: Number(value?.height),
        };
        return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) &&
          rect.left > -30000 && rect.top > -30000 &&
          rect.width >= 320 && rect.height >= 240 ? rect : null;
      } catch (_) { return null; }
    }

    function rectInsideScreen(rect, target) {
      return rect.left >= target.left && rect.top >= target.top &&
        rect.left + rect.width <= target.left + target.width &&
        rect.top + rect.height <= target.top + target.height;
    }

    function overlapArea(rect, target) {
      const width = Math.max(0, Math.min(rect.left + rect.width, target.left + target.width) -
        Math.max(rect.left, target.left));
      const height = Math.max(0, Math.min(rect.top + rect.height, target.top + target.height) -
        Math.max(rect.top, target.top));
      return width * height;
    }

    function clampOhifRect(rect, screens) {
      const targets = screens.length ? screens : [currentScreenRect()];
      if (targets.some(target => rectInsideScreen(rect, target))) return rect;
      const target = targets.reduce((best, candidate) =>
        overlapArea(rect, candidate) > overlapArea(rect, best) ? candidate : best);
      const width = Math.min(rect.width, target.width);
      const height = Math.min(rect.height, target.height);
      return {
        left: Math.min(Math.max(rect.left, target.left), target.left + target.width - width),
        top: Math.min(Math.max(rect.top, target.top), target.top + target.height - height),
        width,
        height,
      };
    }

    function ohifPlacement(stored, details = null) {
      const screens = (details?.screens || []).map(usableScreenRect).filter(Boolean);
      // 권한 없이 현재 화면 하나로 clamp하면 다른 모니터의 저장 자리를 끌어온다.
      if (stored) return monitorPermissionGranted() && screensCache.length
        ? clampOhifRect(stored, screensCache) : stored;

      if (screens.length > 1) {
        const current = usableScreenRect(details.currentScreen);
        const other = screens.find(candidate => !current ||
          candidate.left !== current.left || candidate.top !== current.top ||
          candidate.width !== current.width || candidate.height !== current.height);
        // 화면을 꽉 채우면 드래그 뒤 크롬이 원점으로 밀어 넣어 자리 기억 실패처럼 보인다.
        if (other) return defaultOhifRect(other);
      }
      return defaultOhifRect(currentScreenRect());
    }

    function popupRect(popup) {
      try {
        if (!popup || popup.closed) return null;
        const rect = {left:Number(popup.screenX),top:Number(popup.screenY),width:Number(popup.outerWidth),height:Number(popup.outerHeight)};
        return Object.values(rect).every(Number.isFinite) && rect.left > -30000 && rect.top > -30000 && rect.width >= 320 && rect.height >= 240 ? rect : null;
      } catch (_) { return null; }
    }
    function rememberOhifRect(popup = ohifPopupHandle) {
      try {
        if (!popup || popup.closed) return false;
        // 최소화·닫힘 전이의 좌표로 마지막 정상 자리를 덮지 않는다.
        try { if (popup.document.visibilityState === "hidden") return false; } catch (_) {}
        const rect = popupRect(popup);if (!rect) return false;
        const suspended = ohifPlacementWrites.get(popup);
        if (suspended) {
          if (suspended.pending) return false;
          // A minimized/unreadable window has no baseline. Establish one after
          // restoration, preserving the saved position until a subsequent move.
          if (!suspended.baseline) { suspended.baseline = rect; return false; }
          if (Object.keys(rect).every(k => rect[k] === suspended.baseline[k])) return false;
          // After a failed placement, an actual user move resumes position saving.
          ohifPlacementWrites.delete(popup);
        }
        const slot = ohifPopupSlots.get(popup) || 0;
        localStorage.setItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY, JSON.stringify(rect));
        return true;
      } catch (_) { return false; }
    }

    function watchOhifRect(popup, slot = ohifPopupSlots.get(popup) || 0) {
      ohifPopupHandle = popup;
      ohifPopupSlots.set(popup, slot);
      rememberOhifRect(popup);
      if (ohifRectPolls.has(popup)) return;
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer); ohifRectPolls.delete(popup);
          return;
        }
        // 창 자리를 적는 일도 주기마다 그때의 문맥을 지난다: 로그아웃 준비 중이나 세션이 끝난 뒤에는 저장소에 쓰지 않는다.
        work.commit(work.capture("document"), () => { rememberOhifRect(popup); });
      }, 2000);
      ohifRectPolls.set(popup, timer);
    }

    window.addEventListener("pagehide", () => { for (const [popup, timer] of ohifRectPolls) { rememberOhifRect(popup); clearInterval(timer); } ohifRectPolls.clear(); });

    function validPriorDate(value) {
      if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split("-").map(Number);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
    }

    let imageOpening = null, viewerWindows = null, viewerWindowCursor = null, worklistAlerts = null, worklistRefresh = null, worklistStartup = null;
    function autoPrior(uid) {
      if (imageOpening && !imageOpening.snapshot().includePrior) return null;
      const s = studies.find(x => x.uid === uid);
      if (!s?.sourcePatientKey || !validPriorDate(s.date)) return null;
      // fmtD는 모양만 바꾼다. 달력 검증 없이 정렬하면 미래·불량 날짜가 prior가 된다.
      // 같은 날의 선후는 StudyTime 근거가 없으므로 자동으로 추측하지 않는다.
      return studies.filter(x => x.sourcePatientKey === s.sourcePatientKey && x.uid !== uid && x.modality === s.modality
          && validPriorDate(x.date) && x.date < s.date)
        .sort((a, b) => b.date.localeCompare(a.date) || b.uid.localeCompare(a.uid))[0]?.uid ?? null;
    }

    function openFilmbox(uid, priorUid = autoPrior(uid), initialSeriesUid = null) {
      if (readingWorkspace.active() || imageOpening?.snapshot().listTarget === 'workspace')
        return readingWorkspace.open(uid, priorUid, initialSeriesUid);
      return openOhifWindow(uid, priorUid, initialSeriesUid);
    }
    function ohifScope(value) {
      try {
        const location = new URL(value, window.location.origin);
        if (location.origin !== window.location.origin || location.pathname !== "/ohif/viewer") return null;
        const studies = (location.searchParams.get("StudyInstanceUIDs") || "").split(",");
        if (studies.length < 1 || studies.length > 2 || studies.some(uid => !/^\d+(?:\.\d+)+$/.test(uid))) return null;
        return { studies, series: location.searchParams.get("initialSeriesInstanceUID") || null };
      } catch (_) { return null; }
    }
    function sameOhifScope(left, right) {
      const a = ohifScope(left), b = ohifScope(right);
      return !!a && !!b && a.series === b.series && JSON.stringify(a.studies) === JSON.stringify(b.studies);
    }
    function ohifPopupState(popup) {
      try {
        const href = popup.location.href;
        if (href === "about:blank") return { kind: "blank", busy: false, dirty: false };
        if (!ohifScope(href)) return { kind: "unknown", busy: true, dirty: true };
        const key = KinViewerOpening.key(KinAuth.session()), owner = key && key.slice(KinViewerOpening.PREFIX.length);
        if (!owner || typeof popup.kinViewerWindowOwner !== 'function' || popup.kinViewerWindowOwner() !== owner)
          return { kind: 'viewer', href, busy: true, dirty: false, ready: false };
        const history = popup.kinViewerHistoryWorkspaceState;
        const jobs = popup.kinViewerJobWorkspaceState;
        // A viewer document without both guards may still be loading or may
        // have lost an asset. Uncertainty is not permission to replace it.
        if (typeof history !== "function" || typeof jobs !== "function") {
          return { kind: "viewer", href, busy: true, dirty: false, ready: false };
        }
        const annotationState = history(), jobState = jobs();
        return { kind: "viewer", href, ready: true,
          busy: !!(annotationState?.busy || jobState?.busy || popup.document.querySelector('dialog[open]')),
          dirty: !!(annotationState?.dirty || jobState?.dirty) };
      } catch (_) {
        // Do not navigate a named window that no longer exposes the expected
        // same-origin viewer; the user can close it explicitly and reopen.
        return { kind: "unknown", busy: true, dirty: true };
      }
    }
    /**
     * 목록의 세션을 뷰어 창에 넘긴다(S7-U5 A015). 목록이 연 뷰어 창은 opener가 끊겨 있어 누가 열었는지 스스로 알 길이 없다.
     * 넘겨주지 않으면 그 창은 쿠키가 지금 가리키는 세션을 그대로 받아들인다 — 다른 탭에서 계정이 바뀐 뒤라면, 이 목록에서
     * 고른 검사가 다른 로그인의 이름으로 열린다. 그래서 새 문서를 읽게 하는 모든 이동 직전에 창 이름으로 넘긴다
     * (clinician.js와 같은 방식): 뷰어의 첫 설정 스크립트(config/ohif.js)가 읽어 원래 창 이름으로 되돌리고, 뷰어는 그
     * 세션일 때만 업무를 시작한다. 쿠키의 세션이 다르면 뷰어는 안내만 보인다 — 그 세션을 끝내지 않는다. 주소에도 서버
     * 기록에도 남지 않고, 누르는 횟수도 기다림도 늘지 않는다.
     */
    function handOverSession(popup, name) {
      const session = work.session();
      if (typeof session !== "string" || !session) return false;
      try { popup.name = "kin-viewer-entry:" + JSON.stringify({ session, name }); return true; } catch (_) { return false; }
    }
    /**
     * 그 창의 뷰어가 진입에서 멈춰 있는가("이 창을 연 세션을 확인할 수 없습니다. 목록에서 뷰어를 다시 열어 주세요"). 뷰어
     * 문서가 자기 이력 항목에 적어 둔 기록으로 안다(viewer-session.js의 `kinViewerSession`: 끝나지 않았고 진입이 멈췄다).
     * 그런 창은 업무를 시작한 적이 없어 지킬 작업이 없다 — 그 안내가 시키는 대로 목록에서 다시 열면, 새로 넘겨준 세션으로
     * 다시 확인하게 한다. 읽을 수 없으면 멈춘 창으로 보지 않는다(평소의 보호 그대로다).
     */
    function viewerEntryStopped(popup) {
      try {
        const entry = popup.history.state?.kinViewerSession;
        return !!entry && entry.ended === false && entry.entryStopped === true;
      } catch (_) { return false; }
    }
    function openOhifWindow(uid, priorUid = null, initialSeriesUid = null, readingReturn = null, openingOptions = null) {
      const freshDocument = openingOptions?.freshDocument === true;
      const notify = (message, kind, duration) => {
        if (freshDocument && typeof openingOptions?.notice === 'function') openingOptions.notice(message);
        toast(message, kind, duration);
      };
      if (demoMode) { alert("데모 모드에서는 뷰어를 열 수 없습니다.\n(실제 구동은 Orthanc 연결 환경에서)"); return; }
      // 썸네일에 Series 식별이 없으면 기본 시리즈를 대신 열어 선택이 맞는 것처럼 보이지 않는다.
      if (initialSeriesUid !== null && (typeof initialSeriesUid !== "string" || initialSeriesUid.length > 64 ||
          !/^\d+(?:\.\d+)+$/.test(initialSeriesUid))) {
        notify("시리즈 정보를 확인할 수 없어 열지 않았습니다.", "err");
        return;
      }
      const returnHash=typeof readingReturn==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(readingReturn)?'#kin-reading-return='+readingReturn:'';
      let url = `/ohif/viewer?StudyInstanceUIDs=${encodeURIComponent(uid)}` +
        (priorUid && priorUid !== uid ? `,${encodeURIComponent(priorUid)}&hangingProtocolId=@ohif/hpCompare` : "") +
        (initialSeriesUid === null ? "" : `&initialSeriesInstanceUID=${encodeURIComponent(initialSeriesUid)}`)+returnHash;
      const seq = ++ohifOpenSeq;
      if (!viewerWindows) { notify('영상 창 연결을 확인하지 못했습니다. 통합 판독 화면을 사용하거나 목록을 새로고침하세요.', 'err'); return; }
      const preferences = imageOpening?.snapshot(), limit = preferences?.maxWindows || 1;
      let choice = viewerWindows.choose(url, limit, { freshDocument });
      if (!freshDocument && choice.full && viewerWindows.available() && preferences?.reuseClean && limit > 1) {
        const rows = viewerWindows.rows();
        const clean = row => row.status?.kind === 'viewer' && row.status.ready && !row.status.busy && !row.status.dirty;
        const reusable = rows.length === limit && (rows.find(row => row.index !== viewerWindowCursor && clean(row)) || rows.find(clean));
        if (reusable) choice = { ...reusable, fresh: false };
      }
      if (choice.error) { notify(choice.error, 'err', 8000); if (choice.full && !freshDocument) $('#viewer-windows-open').click(); return; }
      if (freshDocument && (!choice.fresh || choice.pending)) { notify('기존 영상을 유지했습니다. 새 영상 창을 확보한 뒤 다시 여세요.', 'err'); return; }
      url = viewerWindows.linked(url, choice.index);
      const stored = readStoredOhifRect(choice.index);
      const initial = ohifPlacement(stored);
      /**
       * 이 문서가 그 자리의 창을 이미 쥐고 있으면 이름으로 다시 찾지 않는다. 세션을 넘겨받은 창은 뷰어의 첫 스크립트가
       * 이름을 되돌릴 때까지 인계 이름을 달고 있다(handOverSession) — 그 사이(불러오는 중)에 이름으로 찾으면 그 창을 찾지
       * 못해 같은 이름의 빈 창이 하나 더 열리고, 자리는 그 빈 창을 가리키게 된다. 쥔 창이 없을 때(새 자리, 목록을 새로 읽은
       * 뒤)에만 이름으로 연다.
       */
      let known = null;
      try { if (choice.popup && !choice.popup.closed) known = choice.popup; } catch (_) {}
      const popup = known || window.open(
        "",
        choice.name,
        `popup=yes,width=${initial.width},height=${initial.height},left=${initial.left},top=${initial.top},resizable=yes,scrollbars=yes`,
      );
      if (popup) {
        if (freshDocument && ohifPopupState(popup).kind !== "blank") {
          try { popup.opener = null; } catch (_) {}
          viewerWindows.blocked(choice);
          notify("새 창 이름에 기존 화면이 연결되어 열지 않았습니다. 기존 화면을 유지했습니다.", "err", 8000);
          try { popup.focus(); } catch (_) {}
          return;
        }
        viewerWindows.attach(choice, popup); viewerWindowCursor = choice.index; ohifPopupSlots.set(popup, choice.index);
        // Reopening a named window can restore its opener even without navigation.
        try{popup.opener=null;}catch(_){notify('영상 창 연결을 분리하지 못했습니다. 기존 창에서 작업을 저장한 뒤 닫고 다시 여세요.','err',8000);return;}
        if (choice.pending) {
          popup.focus(); watchOhifRect(popup);
          notify('기존 영상 창을 불러오는 중입니다. 계속되지 않으면 그 창을 닫은 뒤 다시 여세요.', 'info');
          return;
        }
        const previous = ohifPopupState(popup);
        const deferredPlacement = previous.kind === 'blank' && monitorPermissionGranted() && screen.isExtended === true;
        const placementWrite = deferredPlacement ? {pending:true,baseline:null} : null;
        if (placementWrite) ohifPlacementWrites.set(popup, placementWrite);
        // 진입에서 멈춘 창은 초점만 주거나 "닫고 다시 여세요"로 돌려보내지 않는다: 아래에서 새 세션 확인과 함께 다시 읽게 한다.
        const stopped = previous.kind === "viewer" && !previous.ready && viewerEntryStopped(popup);
        if (previous.kind === "viewer" && !stopped) {
          if (sameOhifScope(previous.href, url)) {
            if(popup.location.hash!==new URL(url,location.origin).hash){
              try{
                // Hash navigation can re-enter OHIF's mode and clear live job
                // inputs. Replace only this link metadata, then notify its bridge.
                const linked=new URL(popup.location.href), hash=new URLSearchParams(linked.hash.slice(1));
                const previousReturn=hash.get('kin-reading-return');
                for(const [key,value] of new URLSearchParams(new URL(url,location.origin).hash.slice(1)))hash.set(key,value);
                linked.hash=hash.toString();
                popup.history.replaceState(popup.history.state,'',linked.href);
                if(previousReturn!==hash.get('kin-reading-return'))popup.dispatchEvent(new popup.Event('kin-reading-link-changed'));
                popup.dispatchEvent(new popup.Event('kin-window-link-changed'));
              }catch(_){notify('판독문 복귀 연결을 확인하지 못했습니다. 목록 창을 직접 선택하세요.','info');}
            }
            popup.focus();
            watchOhifRect(popup);
            return;
          }
          if (previous.busy || previous.dirty || !previous.ready) {
            popup.focus();
            watchOhifRect(popup);
            notify(!previous.ready
              ? "기존 영상 창의 보호 상태를 확인할 수 없습니다. 로딩을 확인하고 계속되지 않으면 그 창을 닫은 뒤 다시 여세요."
              : previous.busy
              ? "기존 영상 창의 저장·복원 또는 상태 확인을 마치고 열린 대화상자를 닫은 뒤 다른 검사를 여세요."
              : "기존 영상 창에 저장하지 않은 표식이나 작업 내용(소견 작성 내용 포함)이 있습니다. 저장하거나 비운 뒤 다른 검사를 여세요.", "err", 8000);
            return;
          }
          if (typeof popup.kinViewerFrameCoverageConfirm !== 'function' || !popup.kinViewerFrameCoverageConfirm(message => confirm(message))) {
            popup.focus(); notify('기존 영상 창을 유지했습니다. Frame Coverage와 원본 영상을 확인하세요.', 'info'); return;
          }
          const rechecked = ohifPopupState(popup);
          if (popup.location.href !== previous.href || !rechecked.ready || rechecked.busy || rechecked.dirty) return;
          rememberOhifRect(popup);
        } else if (previous.kind !== "blank" && !stopped) {
          popup.focus();
          notify("기존 영상 창의 상태를 확인할 수 없습니다. 그 창을 닫은 뒤 다시 여세요.", "err", 8000);
          return;
        }
        // feature는 안쪽 크기이므로 저장된 바깥 크기로 맞춰 재열기 누적을 막는다.
        if (previous.kind === "blank") {
          try {
            popup.resizeTo(initial.width, initial.height);
            popup.moveTo(initial.left, initial.top);
          } catch (_) {}
        }
        if (!handOverSession(popup, choice.name)) {
          if (previous.kind === "blank") { try { popup.close(); } catch (_) {} viewerWindows.blocked(choice); }
          notify("이 목록의 로그인 세션을 확인할 수 없어 영상 창을 열지 않았습니다. 목록을 새로고침한 뒤 다시 여세요.", "err", 8000);
          return;
        }
        const previousDocument = popup.document;
        ohifPopupSequences.set(popup, seq);
        // 멈춘 창을 같은 검사로 다시 열 때는 주소가 같아(달라도 # 뒤만 다르다) 대입으로는 새 문서가 읽히지 않는다 —
        // 주소만 맞춘 뒤 그 창을 다시 읽게 한다. 넘겨준 세션은 다시 읽힌 문서의 첫 스크립트가 받는다.
        if (stopped && sameOhifScope(previous.href, url)) {
          try { popup.history.replaceState(popup.history.state, "", url); } catch (_) {}
          popup.location.reload();
        } else popup.location.href = url;
        viewerWindows.navigating(choice, url, previousDocument);
        popup.focus();
        watchOhifRect(popup);
        if (!monitorHintShown && monitorPermission?.state === "prompt" && screen.isExtended === true) {
          monitorHintShown = true;
          notify("판독 창을 다른 화면에 열려면 툴바 [다른 모니터로]에서 허용하세요.", "info", 8000);
        }
        // about:blank에서 opener를 분리한 직후에는 Chrome이 다른 화면 좌표를
        // 현재 화면으로 제한한다. 실제 뷰어 문서가 준비된 뒤 한 번 배치한다.
        if (deferredPlacement) {
          const placementOwner = KinViewerOpening.key(KinAuth.session()), deadline = Date.now() + 15000;
          // 이 배치를 시작한 문맥. 준비·종료 뒤에는 화면 정보의 답도 다시 시도하는 타이머도 창을 옮기지 않는다.
          const placementAt = work.capture("document");
          const currentPlacement = () => ohifPlacementWrites.get(popup) === placementWrite;
          const validPlacement = () => {
            try { return work.admits(placementAt) && seq === ohifPopupSequences.get(popup) && !popup.closed && monitorPermissionGranted() &&
              placementOwner && placementOwner === KinViewerOpening.key(KinAuth.session()); }
            catch (_) { return false; }
          };
          const stopPlacement = () => {
            if (currentPlacement()) { placementWrite.pending = false; placementWrite.baseline = popupRect(popup); }
          };
          // This timer also bounds a screen-details promise that never settles.
          const expiry = setTimeout(stopPlacement, 15000);
          try {
            window.getScreenDetails().then(details => {
              if (!validPlacement()) { clearTimeout(expiry); stopPlacement(); return; }
              cacheMonitorScreens(details);
              const rect = ohifPlacement(stored, details);
              const place = () => {
                if (!currentPlacement() || !placementWrite.pending) return;
                if (Date.now() >= deadline || !validPlacement()) { clearTimeout(expiry);stopPlacement();return; }
                try {
                  if (popup.document === previousDocument || popup.document.readyState === 'loading' || !sameOhifScope(popup.location.href, url)) {
                    if (Date.now() < deadline) setTimeout(place, 100);
                    return;
                  }
                  // Move before resizing so a smaller primary display cannot cap
                  // the saved size intended for a larger secondary display.
                  popup.moveTo(rect.left, rect.top);
                  popup.resizeTo(rect.width, rect.height);
                  popup.moveTo(rect.left, rect.top);
                  const settled = () => {
                    try {
                    if (!currentPlacement() || !placementWrite.pending) return;
                    if (Date.now() >= deadline || !validPlacement() || !sameOhifScope(popup.location.href,url)) { clearTimeout(expiry);stopPlacement();return; }
                    const actual = popupRect(popup);
                    if (actual && Object.keys(rect).every(k => Math.abs(actual[k]-rect[k]) <= 16)) {
                      clearTimeout(expiry);ohifPlacementWrites.delete(popup);rememberOhifRect(popup);
                    } else setTimeout(settled,100);
                    } catch (_) { clearTimeout(expiry);stopPlacement(); }
                  };
                  setTimeout(settled,100);
                } catch (_) { clearTimeout(expiry);stopPlacement(); }
              };
              place();
            }).catch(() => { clearTimeout(expiry);stopPlacement(); });
          } catch (_) { clearTimeout(expiry);stopPlacement(); }
        }
        return;
      }

      viewerWindows.blocked(choice);
      notify('팝업이 차단되었습니다. 브라우저에서 팝업을 허용하거나 Image Opening에서 Reading Workspace를 선택하세요.', 'err', 8000);
    }

    function mountViewerWindows() {
      const button = $('#viewer-windows-open'), dialog = document.createElement('dialog'); dialog.id = 'viewer-windows-dialog';
      dialog.setAttribute('aria-labelledby', 'viewer-windows-title');
      dialog.innerHTML = '<h2 id="viewer-windows-title">Viewer Windows</h2><p>이 목록에 연결된 영상 창입니다. 창 닫기는 저장 중이거나 미저장 작업이 있으면 거절합니다. 확인되지 않은 창은 Focus로 상태를 확인합니다.</p><nav aria-label="Opened viewer navigation"><button class="chip" id="viewer-windows-prev" type="button">Previous Window</button> <button class="chip" id="viewer-windows-next" type="button">Next Window</button></nav><p>이 목록에서 마지막으로 연 창 또는 Focus한 창을 기준으로 이동합니다. 판독 대상과 영상 내용은 바꾸지 않습니다.</p><div id="viewer-windows-list"></div><p id="viewer-windows-status" role="status"></p><button class="chip" id="viewer-windows-done" type="button">Done</button>';
      document.body.append(dialog);
      const list = $('#viewer-windows-list'), status = $('#viewer-windows-status'); let signature = '';
      let displayScreens = [], displaySequence = 0, displayMoveSequence = 0;
      const movingWindows = new WeakMap();
      const detectDisplays = document.createElement('button');detectDisplays.type='button';detectDisplays.className='chip';
      detectDisplays.id='viewer-windows-displays';detectDisplays.textContent='Detect Displays';
      detectDisplays.title='화면 접근 권한을 확인합니다. 번호는 좌표 순의 브라우저 목록이며 OS 설정 번호와 다를 수 있습니다.';
      list.before(detectDisplays);
      detectDisplays.onclick=async()=>{
        const request=++displaySequence,owner=KinViewerOpening.key(KinAuth.session());detectDisplays.disabled=true;
        // 화면 정보의 답은 이 확인을 시작한 문맥과 계정·요청 번호를 함께 지난다. 잠근 단추는 이 확인이 푼다(자기 것만).
        const at=work.capture('document');
        try{
          if(!viewerWindows.available()||typeof window.getScreenDetails!=='function')throw Error('unsupported');
          const details=await window.getScreenDetails();await initMonitorPermission();
          if(!work.admits(at)||request!==displaySequence||owner!==KinViewerOpening.key(KinAuth.session())||!viewerWindows.available())return;
          if(monitorQueryUnsupported)monitorSessionGranted=true;
          cacheMonitorScreens(details);displayScreens=KinViewerDisplayLayout.screens(details);render();
          status.textContent=displayScreens.length?'이동할 화면을 선택하세요. 화면 번호는 좌표 순이며 OS 설정 번호와 다를 수 있습니다.':'사용 가능한 화면을 확인하지 못했습니다.';
        }catch(_){if(work.admits(at)&&request===displaySequence){displayScreens=[];render();status.textContent='화면 권한을 허용한 뒤 다시 확인하세요. 이 브라우저가 지원하지 않으면 창을 직접 이동할 수 있습니다.';}}
        finally{detectDisplays.disabled=false;}
      };
      async function moveDisplay(index,chosen){
        const owner=KinViewerOpening.key(KinAuth.session());
        if(!viewerWindows.available()){status.textContent='현재 계정을 확인한 뒤 다시 여세요.';return;}
        const row=viewerWindows.rows().find(r=>r.index===index),popup=row?.popup;
        if(!popup||row.pending||!row.status?.ready||row.status.busy||movingWindows.has(popup)||ohifPlacementWrites.get(popup)?.pending){status.textContent='창을 불러오는 중이거나 작업 중입니다. 완료 후 다시 이동하세요.';return;}
        const request=++displayMoveSequence;movingWindows.set(popup,request);render();
        const href=row.status.href,sequence=ohifPopupSequences.get(popup);
        // 이 이동을 시작한 문맥. 화면 정보의 답·이동 확인 타이머·끝 안내는 이것과 계정·창·요청 번호를 함께 지난다.
        const at=work.capture('document'),shown=()=>work.admits(at)&&request===displayMoveSequence&&viewerWindows.available();
        const valid=()=>{
          try{const current=viewerWindows.rows().find(r=>r.index===index),state=ohifPopupState(popup);
            return work.admits(at)&&movingWindows.get(popup)===request&&owner&&owner===KinViewerOpening.key(KinAuth.session())&&viewerWindows.available()&&
              current?.popup===popup&&!current.pending&&sequence===ohifPopupSequences.get(popup)&&state.ready&&!state.busy&&state.href===href&&!popup.closed;
          }catch(_){return false;}
        };
        status.textContent='창을 이동하고 있습니다.';
        try{
          const details=await window.getScreenDetails();
          if(!valid()){if(shown())status.textContent='창 상태가 바뀌어 이동하지 않았습니다. 현재 창을 다시 확인하세요.';return;}
          const fresh=KinViewerDisplayLayout.screens(details),target=fresh.find(s=>KinViewerDisplayLayout.identity(s)===KinViewerDisplayLayout.identity(chosen));
          if(!target||!monitorPermissionGranted()){displayScreens=fresh;render();status.textContent='화면 구성이나 권한이 바뀌었습니다. 화면을 다시 확인한 뒤 선택하세요.';return;}
          const rect=KinViewerDisplayLayout.fit(popupRect(popup),target);
          if(!rect){status.textContent='창을 복원한 뒤 다시 이동하세요.';return;}
          const gate={pending:true,baseline:null};ohifPlacementWrites.set(popup,gate);
          const moved=await new Promise(resolve=>{
            let finished=false;
            const finish=ok=>{if(finished)return;finished=true;clearTimeout(timeout);
              let saved=false;
              if(ohifPlacementWrites.get(popup)===gate){if(ok){ohifPlacementWrites.delete(popup);saved=rememberOhifRect(popup);}else{gate.pending=false;gate.baseline=popupRect(popup);}}
              resolve({moved:ok,saved});
            };
            const timeout=setTimeout(()=>finish(false),2500);
            const check=()=>{if(finished)return;
              if(!valid()||!monitorPermissionGranted()||ohifPlacementWrites.get(popup)!==gate){finish(false);return;}
              const actual=popupRect(popup);
              if(actual&&Object.keys(rect).every(k=>Math.abs(actual[k]-rect[k])<=16))finish(true);else setTimeout(check,100);
            };
            try{popup.focus();popup.moveTo(rect.left,rect.top);popup.resizeTo(rect.width,rect.height);popup.moveTo(rect.left,rect.top);setTimeout(check,100);}
            catch(_){finish(false);}
          });
          if(shown())status.textContent=moved.saved?'지정 화면으로 이동하고 창 위치를 저장했습니다.':moved.moved?'창을 이동했지만 위치를 저장하지 못했습니다. 현재 창 상태와 브라우저 저장소를 확인하세요.':'창 이동을 확인하지 못해 이전 저장 위치를 유지했습니다. 창을 직접 이동하거나 다시 시도하세요.';
        }catch(_){if(shown())status.textContent='화면에 접근하지 못했습니다. 권한과 창 상태를 확인한 뒤 다시 시도하세요.';}
        finally{if(movingWindows.get(popup)===request)movingWindows.delete(popup);if(work.admits(at)&&viewerWindows.available())render();}
      }
      function render() {
        const rows = viewerWindows?.rows() || [], limit = imageOpening?.snapshot().maxWindows || 1;
        button.textContent = 'Viewer Windows · ' + rows.length + '/' + limit;
        $('#viewer-windows-prev').disabled = $('#viewer-windows-next').disabled = !rows.length;
        const values = rows.map(row => ({ index: row.index, scope: row.scope, state: row.pending ? 'Loading' : !row.status?.ready || row.status.kind !== 'viewer' ? 'Unverified' : movingWindows.has(row.popup) ? 'Moving' : row.status.busy ? 'Busy' : row.status.dirty ? 'Unsaved' : 'Open' }));
        const next = JSON.stringify([values,displayScreens]); if (next === signature) return; signature = next;
        const focused = document.activeElement, focusIndex = focused?.dataset.windowIndex, focusAction = focused?.dataset.windowAction;
        list.replaceChildren();
        for (const row of values) {
          const section = document.createElement('section'); section.className = 'viewer-window-row';
          const label = document.createElement('p'), study = studies.find(s => s.uid === row.scope?.studies[0]);
          label.textContent = 'Window ' + (row.index + 1) + ' · ' + row.state + ' · ' +
            (study ? [study.name, study.date, study.desc, study.uid].filter(Boolean).join(' · ') : row.scope?.studies.join(' / ') || 'Unverified');
          if (row.scope?.studies.length === 2) { const comparison = studies.find(s => s.uid === row.scope.studies[1]); label.textContent += ' · Comparison: ' + (comparison ? [comparison.date, comparison.uid].join(' · ') : row.scope.studies[1]); }
          section.append(label);
          for (const action of ['focus', 'latest', 'close']) {
            const control = document.createElement('button'); control.type = 'button'; control.className = 'chip';
            control.textContent = action === 'focus' ? 'Focus' : action === 'latest' ? 'Latest Images' : 'Close Window';
            if (action === 'latest') { control.disabled = !['Open', 'Unsaved'].includes(row.state); control.title = '추가된 영상을 같은 검사 범위의 새 창에서 조회합니다. 기존 화면과 미저장 작업은 유지하며 설정한 창 수 제한을 따릅니다.'; }
            control.dataset.windowIndex = String(row.index); control.dataset.windowAction = action;
            control.onclick = () => operate(row.index, action); section.append(control);
          }
          displayScreens.forEach((screen,i)=>{
            const control=document.createElement('button');control.type='button';control.className='chip';
            control.textContent='Move to Display '+(i+1)+(screen.primary?' · Primary':'');
            control.title=`사용 가능 영역 ${screen.left}, ${screen.top} · ${screen.width} × ${screen.height}`;
            control.dataset.windowIndex=String(row.index);control.dataset.windowAction='display-'+i;
            control.disabled=!['Open','Unsaved'].includes(row.state);control.onclick=()=>moveDisplay(row.index,screen);section.append(control);
          });
          list.append(section);
        }
        if (!rows.length) list.textContent = '연결된 영상 창이 없습니다.';
        if (dialog.open && focusIndex !== undefined) (list.querySelector('[data-window-index="' + focusIndex + '"][data-window-action="' + focusAction + '"]:not(:disabled)') || $('#viewer-windows-done')).focus();
      }
      function operate(index, action) {
        if (!viewerWindows?.available()) { status.textContent = viewerWindows?.error() || '현재 계정을 확인한 뒤 다시 여세요.'; return; }
        const row = viewerWindows.rows().find(r => r.index === index); if (!row) { render(); return; }
        let popup = row.popup;
        if (!popup) {
          popup = window.open('', row.name, 'popup=yes,resizable=yes,scrollbars=yes');
          if (!popup) { status.textContent = '팝업이 차단되어 창 상태를 확인하지 못했습니다.'; return; }
          viewerWindows.attach(row, popup); ohifPopupSlots.set(popup, index);
          try { popup.opener = null; if (popup.location.href === 'about:blank') { popup.close(); render(); status.textContent = '이미 닫힌 창의 연결을 정리했습니다.'; return; } } catch (_) {}
        }
        if (action === 'latest') {
          const state = ohifPopupState(popup), target = state.kind === 'viewer' && state.ready && !state.busy && !row.pending && ohifScope(state.href);
          if (!target) { status.textContent = '기존 영상 창의 검사와 계정을 확인한 뒤 다시 여세요.'; return; }
          status.textContent = '';
          const readingReturn = new URLSearchParams(new URL(state.href, location.origin).hash.slice(1)).get('kin-reading-return');
          openOhifWindow(target.studies[0], target.studies[1] || null, target.series, readingReturn, { freshDocument: true, notice: message => { status.textContent = message; } });
          render(); return;
        }
        if (action === 'close') {
          if (row.pending) {
            status.textContent = '창을 닫지 않았습니다. 영상 창을 불러오는 중입니다. 완료 후 다시 확인하세요.';
            popup.focus(); return;
          }
          if (movingWindows.has(popup) || ohifPlacementWrites.get(popup)?.pending) {
            status.textContent = '창을 닫지 않았습니다. 화면 이동과 위치 저장이 끝난 뒤 다시 확인하세요.';
            popup.focus(); return;
          }
          const owner = KinViewerOpening.key(KinAuth.session()), sequence = ohifPopupSequences.get(popup);
          let viewerDocument; try { viewerDocument = popup.document; } catch (_) {}
          const state = ohifPopupState(popup);
          if (state.kind !== 'viewer' || !state.ready || state.busy || state.dirty) {
            status.textContent = '창을 닫지 않았습니다. 해당 창의 저장·복원 또는 미저장 작업을 확인하고 열린 대화상자를 닫은 뒤 다시 시도하세요.';
            popup.focus(); return;
          }
          if (typeof popup.kinViewerFrameCoverageConfirm !== 'function' || !popup.kinViewerFrameCoverageConfirm(message => confirm(message))) {
            status.textContent = '창을 닫지 않았습니다. Frame Coverage와 원본 영상을 확인하세요.'; return;
          }
          const current = viewerWindows.rows().find(r => r.index === index), rechecked = ohifPopupState(popup);
          let sameDocument = false; try { sameDocument = popup.document === viewerDocument; } catch (_) {}
          if (!viewerWindows.available() || !owner || owner !== KinViewerOpening.key(KinAuth.session()) || current?.popup !== popup || current.pending ||
              movingWindows.has(popup) || ohifPlacementWrites.get(popup)?.pending ||
              sequence !== ohifPopupSequences.get(popup) || !sameDocument || popup.closed || popup.location.href !== state.href ||
              rechecked.kind !== 'viewer' || rechecked.href !== state.href || !rechecked.ready || rechecked.busy || rechecked.dirty) {
            status.textContent = '창 상태가 바뀌어 닫지 않았습니다. 다시 확인하세요.'; return;
          }
          rememberOhifRect(popup); popup.close(); render();
          status.textContent = popup.closed ? '영상 창을 닫았습니다.' : '브라우저에서 창을 닫지 못했습니다. 해당 창에서 닫으세요.';
        } else { viewerWindowCursor = index; dialog.close(); popup.focus(); watchOhifRect(popup, index); }
      }
      let storage; try { storage = sessionStorage; } catch (_) {}
      viewerWindows = KinViewerWindows.create({ storage, owner: () => { const key = KinViewerOpening.key(KinAuth.session()); return key ? key.slice(KinViewerOpening.PREFIX.length) : null; },
        newId: () => crypto.randomUUID(), origin: location.origin, describe: ohifPopupState, changed: render });
      button.disabled = false;
      function cycle(step) {
        const rows = viewerWindows.rows(); if (!rows.length) return;
        const current = rows.findIndex(row => row.index === viewerWindowCursor);
        const next = current < 0 ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
        operate(rows[next].index, 'focus');
      }
      $('#viewer-windows-prev').onclick = () => cycle(-1); $('#viewer-windows-next').onclick = () => cycle(1);
      button.onclick = () => { viewerWindows.refresh(); render(); status.textContent = viewerWindows.error() || ''; dialog.showModal(); $('#viewer-windows-done').focus(); };
      $('#viewer-windows-done').onclick = () => dialog.close(); dialog.addEventListener('close', () => { ++displaySequence;if (!button.disabled) button.focus(); });
      // 주기마다 그때의 문맥으로 지난다: 로그아웃 준비 중에는 다시 그리지 않고, 편집으로 돌아오면 다음 주기가 이어 간다.
      const timer = setInterval(() => { work.commit(work.capture('document'), () => { viewerWindows.refresh(); render(); }); }, 2000);
      const end = () => { ++displaySequence;displayScreens=[];clearInterval(timer); viewerWindows.end(); button.disabled = true; dialog.close(); list.replaceChildren(); };
      onSessionEnd(end); window.addEventListener('pagehide', end);
      render();
    }

    favoriteList = KinFavoriteList({ api,
      identity: () => { const s=KinAuth.session(); return s?.state==='approved' ? [s.institution,s.sub] : null; },
      changed: () => { $('#favorite-clear').hidden = !favoriteList.label(); render(); },
    });
    $('#favorite-clear').onclick = () => favoriteList.clear();
    const favorites = KinFavorites({ api, allowed: () => !!sess && serverMode && !demoMode && !offline,
      identity: () => { const s=KinAuth.session(); return s?.state==='approved' ? [s.institution,s.sub] : null; },
      current: () => selectedUid, study: uid => studies.find(s => s.uid===uid), select,
      applyFolder: (value,id) => favoriteList.apply(value,id), changed: value => favoriteList.adopt(value), ended: () => favoriteList.end(),
      openSavedView: (uid,job) => { select(uid,{deferViewer:true});readingWorkspace.openJob(uid,job); },
      notice: message => toast(message,'err'),
    });
    $('#favorite-open').onclick = () => favorites.open();
    function tagScopeState(data,scope){
      const catalog=data?.catalogs?.find(c=>c.scope===scope);
      if(!catalog||!Array.isArray(catalog.tags))throw new Error('태그 범위를 확인할 수 없습니다');
      return {owner:data.owner,revision:catalog.revision,folders:catalog.tags.map(t=>({...t,name:(scope==='personal'?'[개인] ':'[기관] ')+t.name}))};
    }
    studyTagList=KinFavoriteList({api,label:'태그',noun:'태그',
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      read:async (signal,at)=>tagScopeState(await api('GET','/study-tags',undefined,signal,at),studyTagScope),
      changed:()=>{$('#study-tag-clear').hidden=!studyTagList.label();render();},
    });
    const studyTags=KinStudyTags({api,allowed:()=>!!sess&&serverMode&&!demoMode&&!offline,
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      current:()=>selectedUid,study:uid=>studies.find(s=>s.uid===uid),notice:message=>toast(message,'err'),
      changed:data=>{if(studyTagList.key())studyTagList.adopt(tagScopeState(data,studyTagScope));},ended:()=>studyTagList.end(),
      apply:(data,scope,id)=>{studyTagScope=scope;studyTagList.apply(tagScopeState(data,scope),id);},
    });
    $('#study-tag-open').onclick=()=>studyTags.open();$('#study-tag-clear').onclick=()=>studyTagList.clear();
    const consultations=KinConsultations({api,
      allowed:()=>!!sess&&serverMode&&!demoMode&&!offline&&(KinAuth.has('radiologist')||KinAuth.has('admin')),
      admin:()=>KinAuth.has('admin'),identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      current:()=>studies.find(s=>s.uid===selectedUid),study:uid=>studies.find(s=>s.uid===uid),
      openStudy:uid=>select(uid,{openSelected:true}),
      filter:(uids,direction)=>{
        $('#clearfilter').click();const wanted=new Set(uids),known=new Set(studies.map(s=>s.uid));
        consultationFilter={uids:wanted,revision:++consultationFilterSequence,label:(direction==='received'?'Received':'Sent')+' Consultations · Loaded Requests'};render();
        const missing=[...wanted].filter(uid=>!known.has(uid)).length;
        if(missing)toast(`자문 검사 ${wanted.size}건 중 ${missing}건이 현재 불러온 검사 목록에 없습니다. Refresh 후 접근 가능한 검사를 확인하세요.`, 'info');
      },
      clearFilter:()=>{consultationFilter=null;render();},
    });
    $('#consultations-open').onclick=()=>consultations.open();

    const readerAssignment=KinReaderAssignment({api,allowed:()=>!!sess&&serverMode&&!demoMode&&!offline,
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      changed:(uid,value)=>{updateReaderAssignment(uid,value);render();},
    });
    $('#rows').addEventListener('click',event=>{const button=event.target.closest('[data-reader-assignment]');if(!button)return;event.stopPropagation();readerAssignment.open(studies.find(s=>s.uid===button.dataset.readerAssignment));},true);


    const techNote = KinTechNote({ api, allowed: () => !!sess && serverMode && !demoMode && !offline,
      changed: (uid, note) => { updateNoteSummary(uid, { version: note?.version ?? 0, present: !!note?.text }); readingWorkspace.refreshNote(); },
      restoreFocus: uid => $('#rows').querySelector(`[data-tech-note="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true }),
    });
    $('#tech-note-open').onclick = () => techNote.open(viewed());
    /**
     * 이 Worklist 탭의 Tech Note도 Log out이 묻는 작업이다(S7-U5 fix-up E, 입력 유실). 같은 세션의 다른 탭에서 Log out을 누르면
     * 그 탭은 이 탭을 들여다보지 않는다 — 뷰어 문서와 같은 계약으로 이 탭이 스스로 알린다: 저장하지 않았거나 아직 저장 중인
     * 메모가 있는 동안 Web Lock `kin-unsaved:<세션>:<문서>:worklist-note`를 쥐고(탭이 닫히면 브라우저가 놓는다), 같은 세션의
     * `session-work-query`에 지금 상태로 답한다(viewer-session.js와 같은 방식, otherUnsavedWork가 읽는다). 메모를 열기만 했거나
     * 읽는 중이면 알리지 않는다(tech-note.js dirty — 쳐 둔 글이나 답을 받지 못한 저장만).
     */
    const workDocument = crypto.randomUUID();
    let workDeclared = null;
    const ownUnsavedKinds = () => {
      try { return work.state() === "active" && techNote.dirty?.() ? ["worklist-note"] : []; } catch (_) { return []; }
    };
    function declareOwnWork() {
      const session = work.session(), kinds = session ? ownUnsavedKinds() : [];
      const name = kinds.length ? "kin-unsaved:" + session + ":" + workDocument + ":" + kinds.join(",") : null;
      if ((workDeclared ? workDeclared.name : null) === name) return;
      const previous = workDeclared, next = name ? { name, release: null, dropped: false } : null;
      const drop = held => { if (held) { held.dropped = true; held.release?.(); } };
      workDeclared = next;
      if (!next) { drop(previous); return; }
      // 새 알림을 받은 뒤에 옛 알림을 놓는다: 알림이 없는 순간이 없다.
      try {
        navigator.locks.request(name, () => new Promise(resolve => { next.release = resolve; drop(previous); if (next.dropped) resolve(); }))
          .catch(() => { drop(previous); if (workDeclared === next) workDeclared = null; });
      } catch (_) { drop(previous); workDeclared = null; }
    }
    setInterval(declareOwnWork, 500);
    for (const type of ["input", "change", "pointerup", "keyup"]) document.addEventListener(type, () => setTimeout(declareOwnWork, 0), true);
    try {
      const workChannel = new BroadcastChannel("kin-session");
      workChannel.onmessage = event => {
        const data = event.data, session = work.session();
        if (!session || !data || data.type !== "session-work-query" || data.session !== session) return;
        declareOwnWork();
        try { workChannel.postMessage({ type: "session-work", session, document: workDocument, query: data.query, unsaved: ownUnsavedKinds() }); } catch (_) {}
      };
    } catch (_) {}
    // 읽기 작업공간의 종료(pagehide)가 부르는 배치 적용이다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).
    let layoutMode = "auto";
    let workspaceState = KinWorkspaceLayout.defaults();
    const portraitLayout = () => document.body.classList.contains("portrait");
    const workspaceAxis = () => portraitLayout() ? "portrait" : "landscape";
    function applyLayout() {
      const portrait = layoutMode === "portrait" || (layoutMode === "auto" && innerHeight > innerWidth);
      document.body.classList.toggle("portrait", portrait);
      $("#layout-toggle").textContent = {
        auto: "Layout: Auto", portrait: "Layout: Portrait", landscape: "Layout: Landscape",
      }[layoutMode];
      $("#layout-toggle").setAttribute("aria-label", `화면 배치 ${layoutMode}`);
      $("#resize-main").setAttribute("aria-orientation", portrait ? "horizontal" : "vertical");
      $("#resize-related").setAttribute("aria-orientation", portrait ? "horizontal" : "vertical");
      if (portrait) {
        $(".left").style.width = "";
        $(".related-p").style.width = "";
      } else {
        $(".left").style.height = "";
        $(".related-p").style.height = "";
      }
      // A temporary small window must not overwrite the user's preferred size.
      // Reapply stored pixels within today's bounds, separately for each orientation.
      const sizes = workspaceState[workspaceAxis()];
      const left = $(".left"), related = $(".related-p"), top = $(".rw"), prior = $(".related-list-pane");
      left.style[portrait ? "height" : "width"] = "";
      related.style[portrait ? "height" : "width"] = "";
      top.style.height = "";
      prior.style.height = "";
      prior.style.flex = "";
      const split = $(".split").getBoundingClientRect();
      if (sizes.main != null) left.style[portrait ? "height" : "width"] = clampPanel(sizes.main,
        portrait ? 180 : 500, portrait ? split.height - 420 : split.width - 426) + "px";
      if (sizes.top != null) top.style.height = clampPanel(sizes.top, 140, $(".right").getBoundingClientRect().height - 266) + "px";
      const row = $(".workrow").getBoundingClientRect();
      if (sizes.related != null) related.style[portrait ? "height" : "width"] = clampPanel(sizes.related,
        portrait ? 286 : 220, portrait ? row.height - 186 : row.width - 366) + "px";
      if (sizes.prior != null) {
        prior.style.flex = "none";
        prior.style.height = clampPanel(sizes.prior, 150, related.getBoundingClientRect().height - 136) + "px";
      }
    }
    const readingWorkspace = KinReadingWorkspace({
      current: () => selectedUid, study: uid => studies.find(s => s.uid === uid),
      prior: autoPrior, move, select, queue: orderedStudies, layout: () => applyLayout(), popup: openOhifWindow,
      onPanelsEdit: () => { workspaceGeneration++; },
      onPanelsChange: reading => {
        const state = KinWorkspaceLayout.withReading(workspaceState, reading);
        if (state) { workspaceState = state; saveWorkspace(); }
      },
      noteLabel, openNote: uid => techNote.open(studies.find(s => s.uid === uid)),
      hasNote: uid => noteSummaries.get(uid)?.present,
      noteOwner: () => { const key = KinWorkspaceLayout.key(KinAuth.session()); return key ? key.slice(KinWorkspaceLayout.PREFIX.length) : null; },
      allowed: () => !!sess && serverMode && !demoMode && !offline,
      notice: message => toast(message, 'err'),
    });
    $('#m-reading').addEventListener('click', () => {
      if (readingWorkspace.active()) { readingWorkspace.exit(); return; }
      if (!selectedUid) { toast('판독할 검사를 먼저 선택하세요.', 'info'); return; }
      readingWorkspace.resume(selectedUid, relatedUid || autoPrior(selectedUid));
    });
    // Read-only Image Findings of the selected study; an unavailable list must not block reading.
    let readingFindings = null;
    try {
      readingFindings = KinReadingFindings({
        current: () => selectedUid, allowed: () => !!sess && serverMode && !demoMode && !offline, api,
        owner: () => { const key = KinViewerOpening.key(KinAuth.session()); return key ? key.slice(KinViewerOpening.PREFIX.length) : null; },
        sub: () => KinAuth.session()?.sub || null,
        workspace: readingWorkspace, windows: () => viewerWindows?.available() ? viewerWindows.rows() : [],
        popup: openOhifWindow, open: uid => openFilmbox(uid),
        // 판독문 쪽 관문·미리보기·서버 요청은 전부 이쪽에 있다. 소견 패널은 자기가 지금
        // 읽고 있는 행에서 요청을 만들어 건네기만 하고 판독문을 직접 쓰지 않는다.
        cite: (request, origin) => openCitePreview(request, origin),
      });
    } catch (_) { toast('영상 소견 목록을 불러오지 못했습니다. 영상 화면의 Findings를 사용하세요.', 'err'); }

    // ── 임상 정보 패널(S7-U4b) ──
    // REQ-S7-U4b-PANEL → RISK-S7-U4b-STALE-PANEL/FAIL-AS-EMPTY → TEST-S7-U4b-DOM (tests/clinical_context_dom_test.py가 이 절을
    // 잘라 clinical-context.js·auth.js와 함께 실행한다) · TEST-S7-U4b-MODEL. 계약 S7-U4p §7·§8·§10.
    // 보고 있는 검사(viewed(), Related 미리보기 포함)의 서명된 과거 판독문·검사 이력·DICOM 요청 태그·Tech Note 메타를 서버의 닫힌 답
    // 하나(GET studies/:uid/clinical-context)로 그린다. 보는 검사가 바뀔 때만 읽고, 같은 검사의 renderClinical은 요청도 다시 그리기도
    // 하지 않는다. 시간이 지나거나 목록이 바뀌어도 스스로 다시 읽지 않는다 — Refresh·Retry는 사람이 누른다(CS-11).
    // 답은 요청 번호·요청 UID·보는 UID·계정이 모두 같을 때만 그린다(ABA-3). 새 요청이 앞 요청을 abort해도 앞 답은 이미 오고 있을
    // 수 있으므로 abort는 전송을 줄일 뿐이고 방어는 이 대조다. 다른 검사를 말하는 답은 상태를 바꾸지 않고 버린다(OP-2, D172).
    // 404·403·409와 모양이 다른 답은 항목을 지우고(ABA-6), 503·그 밖의 5xx·연결 실패는 같은 검사의 앞 답을 Stale로 남긴다(ABA-7, OP-1).
    // 역할에 radiologist·admin이 없으면 숨기고 요청하지 않는다 — 경계는 서버이고 숨김은 편의다. 세션 종료는 이 페이지가 맡는다:
    // Module teardown follows the page work-context lifecycle.
    // 답은 이 문서의 메모리에만 두고, 모든 값은 textContent로 쓴다.
    function mountClinicalContext({ work, allowed, target, owner, read, actor }) {
      const model = KinClinicalContext;
      const root = $('#clinical-context'), status = $('#clinical-context-status'), refresh = $('#clinical-context-refresh'),
        conflict = $('#clinical-context-conflict'), list = $('#clinical-context-sections');
      const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== null && text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
      };
      const retry = node('button', model.TEXT.retry, 'chip');
      retry.type = 'button';
      retry.hidden = true;
      status.after(retry);
      // shownUid: the study the panel is for (null = hidden). A request is one generation of seq; only the newest may paint.
      let ended = false, seq = 0, controller = null, loading = false, shownUid = null;
      let answer = null, stale = {}, failure = null, observation = null;
      const opened = new Map();

      function parts(items) {
        const out = document.createDocumentFragment();
        items.forEach((part, i) => {
          if (i) out.append(' · ');
          const span = node('span', part.text, part.badge ? 'cc-badge' : null);
          if (part.title) span.title = part.title;
          out.append(span);
        });
        return out;
      }
      function line(summary) {
        if (summary.label) status.append(node('strong', summary.label), ' ');
        status.append(summary.text);
        status.title = summary.title || '';
      }
      function paint() {
        const visible = !ended && shownUid !== null;
        // A report text the reader opened stays open when the same answer is painted again (a later list observation).
        const wasOpen = new Set([...opened].filter(([, details]) => details.open).map(([key]) => key));
        opened.clear();
        root.hidden = !visible;
        refresh.disabled = !visible || loading;
        retry.disabled = loading;
        retry.hidden = true;
        status.replaceChildren();
        status.title = '';
        conflict.replaceChildren();
        conflict.hidden = true;
        list.replaceChildren();
        if (!visible) return;
        if (loading) status.textContent = model.TEXT.loading;
        if (!answer) {
          if (!loading && failure) {
            line(model.failedSummary(failure));
            retry.hidden = false;
          }
          return;
        }
        const shown = model.view(answer, stale, { actor });
        if (shown.conflict) {
          conflict.append(node('strong', shown.conflict.title), ' ', shown.conflict.text);
          conflict.hidden = false;
        }
        for (const section of shown.sections) {
          const box = node('div', null, 'cc-section');
          box.setAttribute('role', 'group');
          box.setAttribute('aria-label', section.title);
          box.dataset.section = section.name;
          box.dataset.state = section.state;
          const head = node('div', null, 'cc-section-head');
          head.append(node('span', section.count ? section.title + ' ' + section.count : section.title));
          if (section.label) head.append(' ', node('span', section.label, 'cc-state'));
          if (section.retry) {
            const again = node('button', model.TEXT.retry, 'chip');
            again.type = 'button';
            again.disabled = loading;
            again.addEventListener('click', reread);
            head.append(' ', again);
          }
          box.append(head, node('div', section.description, 'cc-note'));
          if (section.checked) box.append(node('div', section.checked, 'cc-note'));
          if (section.items.length) {
            const items = node('ul');
            for (const item of section.items) {
              const entry = node('li');
              entry.append(parts(item.line));
              for (const mark of item.marks) entry.append(' ', node('span', mark, 'cc-mark'));
              const source = node('div', null, 'cc-source');
              source.append(parts(item.source));
              entry.append(source);
              if (item.details) {
                const details = node('details'), key = section.name + ' ' + item.key;
                details.append(node('summary', model.TEXT.reportText));
                for (const body of item.details) details.append(node('div', body.label, 'cc-note'), node('div', body.text, 'cc-body'));
                details.open = wasOpen.has(key);
                opened.set(key, details);
                entry.append(details);
              }
              items.append(entry);
            }
            box.append(items);
          }
          list.append(box);
        }
        if (!loading) line(model.summary(answer, stale, failure));
      }

      function start(uid) {
        if (controller) controller.abort();
        const mine = ++seq, who = owner(), own = new AbortController();
        controller = own;
        loading = true;
        paint();
        // 이 읽기를 시작한 작업 문맥. 답도 실패도 그것이 그대로일 때만 이 패널에 닿는다.
        const at = work.capture('document');
        read(uid, own.signal, at).then(value => settle(mine, uid, who, value, null, at), error => settle(mine, uid, who, null, error, at));
      }
      function settle(mine, uid, who, value, error, at) {
        // 로그아웃 준비·그 취소 뒤에 온 답은 아무것도 그리지 않는다. 그 읽기가 세운 대기 표시만 내려 두고(자기 것만),
        // 편집으로 돌아오면 resume()이 지금 문맥에서 다시 읽는다.
        if (!work.admits(at)) {
          if (!ended && mine === seq) { controller = null; loading = false; }
          return;
        }
        // ABA-3: the newest request, for the study still viewed, of the account that asked. Anything else changes nothing.
        if (ended || mine !== seq) return;
        const me = owner();
        if ((allowed() ? target() : null) !== uid || !who || !me || who[0] !== me[0] || who[1] !== me[1]) return;
        if (error && error.name === 'AbortError') return;
        const bad = error ? null : model.shapeError(value);
        if (!error && bad === null && value.uid !== uid) return;
        controller = null;
        loading = false;
        if (error || bad !== null) {
          const failed = error ? model.failure(error) : { reason: 'malformed', status: null, code: null, keep: false };
          if (failed.keep && answer) stale = model.refreshFailed(answer, stale);
          else { answer = null; stale = {}; }
          failure = failed;
        } else {
          answer = value;
          failure = null;
          // An observation that arrived while this read was out is compared now (it may be later than the answer).
          stale = observation ? model.staleAfter(value, observation, {}) : {};
        }
        paint();
      }
      function sync() {
        if (ended) return;
        const uid = allowed() ? target() : null;
        if (uid === shownUid) return;
        // ABA-4: another study's items go at once; nothing of it is kept for a later return (A->B->A reads A again).
        shownUid = uid;
        answer = null;
        stale = {};
        failure = null;
        loading = false;
        seq++;
        if (controller) controller.abort();
        controller = null;
        if (uid === null) paint();
        else start(uid);
      }
      function reread() {
        if (ended || loading) return;
        const uid = allowed() ? target() : null;
        if (uid === null || uid !== shownUid) { sync(); return; }
        start(uid);
      }
      function observe(result) {
        if (ended || !result) return;
        observation = result;
        if (!answer) return;
        const next = model.staleAfter(answer, result, stale);
        if (model.SECTIONS.every(name => (next[name] || null) === (stale[name] || null))) return;
        stale = next;
        paint();
      }
      /**
       * 세션이 끝났다(로그아웃·다른 탭·401·계정 변경). 패널을 비우고 숨기며 나간 요청을 멈추고, 그 답은 어디에도 그리지 않는다.
       * 이 문서에서는 다시 읽지 않는다. 방송·storage·pagehide와 겹쳐 여러 번 불려도 처음 한 번만 끝낸다.
       */
      function end() {
        if (ended) return;
        ended = true;
        seq++;
        if (controller) controller.abort();
        controller = null;
        loading = false;
        shownUid = null;
        answer = null;
        stale = {};
        failure = null;
        observation = null;
        paint();
      }
      /** 로그아웃 준비에서 편집으로 돌아왔다: 준비가 끊은 읽기가 있었으면 지금 문맥에서 다시 읽는다. */
      function resume() {
        if (ended) return;
        if (shownUid !== null && !loading && !answer && !failure) start(shownUid);
        else paint();
      }

      refresh.addEventListener('click', reread);
      retry.addEventListener('click', reread);
      window.addEventListener('pagehide', () => end());
      // 이 문서의 세션이 끝나면 세션 종료 조정이 이 목록을 동기로 부른다. 어느 로그인의 종료인지는 auth.js가 대조한다.
      onCommonEnd(() => end());
      paint();
      return { sync, observe, end, resume };
    }
    let clinicalContext = null;
    try {
      clinicalContext = mountClinicalContext({ work,
        allowed: () => !!sess && serverMode && !demoMode && !offline && (KinAuth.has('radiologist') || KinAuth.has('admin')),
        target: () => viewed()?.uid ?? null,
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; },
        read: (uid, signal, at) => api('GET', '/studies/' + encodeURIComponent(uid) + '/clinical-context', undefined, signal, at),
        actor: value => displayActor(value) });
    } catch (_) { toast('Clinical Context 패널을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }

    // ── 중요 결과 수신(S7-U2a) ──
    // REQ-S7-U2a-RECIPIENT-LIST/EXPLICIT-ACK/WORDING → TEST-S7-U2a-DOM (tests/critical_result_recipient_dom_test.py가 이 절을
    // 잘라 critical-result-inbox.js와 함께 실행한다). 판독 화면의 Critical Results 패널은 판독 대상과 무관한 이 계정의 받은 목록이다.
    // 받는 역할은 clinician 또는 radiologist를 정확히 본다 — KinAuth.has()는 admin을 모든 역할로 통과시키지만 서버는 admin만·
    // technician만인 계정의 받은 목록을 거절한다(계약 §14). 이 절은 부팅이 세션과 서버 연결을 확인하기 전에 돌므로, 영역은 이
    // Module teardown follows the page work-context lifecycle.
    // Module teardown follows the page work-context lifecycle.
    let criticalInbox = null;
    try {
      criticalInbox = KinCriticalResultInbox.mount({ apiBase: API, root: 'cvr-inbox-p', prefix: 'cvr-inbox', fold: true,
        onAccountChanged: notifyAccountChanged,
        eligible: () => { const s = KinAuth.session(); return !!sess && serverMode && !demoMode && !offline && s?.state === 'approved'
          && Array.isArray(s.roles) && (s.roles.includes('clinician') || s.roles.includes('radiologist')); },
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; } });
      accountChangeHooks.push((reason, detail) => criticalInbox.lock(detail));
    } catch (_) { toast('중요 결과 수신 화면을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }

    // ── 중요 결과 발신(S7-U1b) ──
    // REQ-S7-U1b-SENDER-UI/FAILURE/ABA → TEST-S7-U1b-DOM (tests/critical_result_sender_dom_test.py가 이 절을 잘라
    // critical-result-send.js와 함께 실행한다). Mark CVR·발신 창·보낸 목록은 그 파일이 서버 S7-U1a route로만 움직인다.
    // 보내는 역할은 radiologist를 정확히 본다 — KinAuth.has()는 admin을 모든 역할로 통과시키지만 서버는 admin만인
    // 계정의 발신을 거절한다(D-S7-02 a). 판독 상태 {version, rs}가 바뀌면 그 파일이 #1을 다시 읽는다.
    let criticalResults = null;
    try {
      criticalResults = KinCriticalResultSend.mount({ apiBase: API,  current: () => selectedUid,
        onAccountChanged: notifyAccountChanged,
        study: uid => studies.find(s => s.uid === uid),
        report: uid => { const a = appState[uid]; return a ? { version: a.version ?? 0, rs: a.rs ?? null } : null; },
        online: () => !!sess && serverMode && !demoMode && !offline,
        radiologist: () => { const s = KinAuth.session(); return s?.state === 'approved' && Array.isArray(s.roles) && s.roles.includes('radiologist'); },
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; },
        actorName: value => displayActor(value) });
      accountChangeHooks.push((reason, detail) => criticalResults.lock(detail));
    } catch (_) { toast('중요 결과 발신 화면을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }

    // ── 임상의 질문 답변(S5-U4b) ──
    // REQ-S5-U4b-QUESTION-UI → RISK-S5-U4b-STALE → TEST-S5-U4b-DOM (tests/clinician_question_dom_test.py가 이 절을 잘라 실행한다).
    // 판독 대상 검사(selectedUid)의 임상의 질문을 서버 S5-U4a route로 읽고(#3 검사별·#2 스레드·#1 view=inbox) 답변(#5)과
    // 사유 있는 닫기(#6)를 쓴다. consultation 창·요청과 섞지 않는다. 판독문 칸·버튼 줄 밖의 줄이며 판독문을 읽거나 쓰지 않는다.
    // 역할로 쓰기 컨트롤을 숨기지 않는다 — 관리자 답변 403처럼 서버 거절을 그대로 보인다. 읽기는 판독의·관리자 세션에서만 시작한다.
    // 줄은 질문이 있거나 읽기가 실패했거나 사용자가 창을 연 동안만 보인다: 질문 없는 검사의 판독 화면 배치를 바꾸지 않는다.
    // 원격판독으로 받은 검사는 읽지 않는다 — 질문은 소유 기관 안에서만 오가고(OQ-1 a) 수신 기관의 읽기는 늘 404다.
    // 검사를 바꾸면 이전 검사의 스레드를 내린다. 쓰던 글은 검사·스레드별로 이 문서의 메모리에만 두어 그 스레드에서만 다시 보인다.
    // 요청은 api()가 아니라 이 절의 call()로 보낸다 — 401에서 이 줄을 로그아웃 POST보다 먼저 끝내야 한다(call·expire).
    // Module teardown follows the page work-context lifecycle.
    // api()의 401, 확정한 Log out, 받아쓰기의 401, 목록의 계정 변경, 이 절의 401(expire) — 은 로그아웃 POST·초안 저장 같은
    // 네트워크 대기 전에 그 목록을 동기로 부른다. auth.js의 session-ended 방송은 그 POST가 끝난 뒤라 기다리지 않는다.
    // 한 영역이 알아챈 계정 변경(다른 계정의 봉투·OWNER_CHANGED)은 같은 목록에 사유 'account-changed'로 알려 두 영역을 함께 잠근다.
    function mountStudyQuestions({ apiBase, work, transport, current, study, openStudy, allowed, owner }) {
      const root = $('#question-p'), summary = $('#question-summary'), toggle = $('#question-toggle');
      const inboxButton = $('#question-inbox'), pane = $('#question-pane');
      const TEXT = {
        loading: '이 검사의 질문을 불러오는 중입니다…',
        failed: '이 검사의 질문을 불러오지 못했습니다.',
        empty: '이 검사에는 질문이 없습니다.',
        none: '판독 대상 검사를 고르면 그 검사의 질문을 표시합니다.',
        counts: (n, open, answered, closed) => `이 검사의 질문 ${n}건 · Open ${open} · Answered ${answered} · Closed ${closed}`,
        ready: n => `이 검사의 질문 ${n}건을 최신순으로 표시합니다.`,
        malformed: '질문 응답 형식을 확인할 수 없습니다. 다시 불러오세요.',
        notFound: '검사나 질문을 찾을 수 없습니다. 접근 조건이 바뀌었거나 검사가 옮겨졌을 수 있습니다.',
        item: (created, name, count, last) => `${created} 등록 · ${name} · 항목 ${count}개 · 최근 ${last}`,
        threadLoading: '질문 스레드를 불러오는 중입니다…',
        threadFailed: '질문 스레드를 불러오지 못했습니다.',
        otherStudy: '이 질문은 판독 대상 검사의 질문이 아니어서 열지 않았습니다. Inbox를 다시 불러오세요.',
        threadMeta: (created, name) => `${created} 등록 · 질문 ${name}`,
        closedNote: '닫힌 질문입니다. 새 답변·닫기는 서버가 거절합니다.',
        anchorChanged: '답변 이후 판독 상태가 바뀌었습니다.',
        anchorDetail: (then, now) => `답변 때 ${then} → 지금 ${now}`,
        closeEmpty: '사유 없이 닫았습니다.',
        nonFinal: '확정 전 소견을 적으면 임상의에게 그대로 보입니다.',
        replyHint: '질문한 임상의가 이 스레드에서 그대로 읽습니다. 답변은 판독문에 들어가지 않습니다.',
        closeHint: '작성자가 아닌 사람이 닫을 때는 사유가 필요합니다. 닫은 질문에는 더 쓸 수 없습니다.',
        inboxHint: '소속 기관 검사에 남은 임상의 질문입니다. Open Study는 그 검사를 판독 대상으로 엽니다.',
        inboxLoading: '받은 질문을 불러오는 중입니다…',
        inboxFailed: '받은 질문을 불러오지 못했습니다.',
        inboxEmpty: '이 조건의 질문이 없습니다.',
        inboxReady: (n, more) => `질문 ${n}건을 최신순으로 표시합니다.${more ? ' More로 이어서 읽습니다.' : ''}`,
        notListed: '이 검사는 지금 워크리스트에 없어 열 수 없습니다. 목록을 새로고침하거나 검색 조건을 바꾸세요.',
        unlisted: '워크리스트에 없는 검사',
        noText: '1~2,000자의 내용을 입력하세요.',
        sending: '보내는 중입니다…',
        saved: '저장했습니다.',
        replayed: '이미 저장된 요청입니다. 서버가 처음 저장한 결과를 돌려주었습니다.',
        discarded: '보낸 요청을 버렸습니다. 저장되었을 수 있으니 다시 불러온 스레드에서 확인하세요.',
        writeMalformed: '저장 응답의 형식을 확인할 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인합니다.',
        noRequestId: '요청 ID를 만들지 못해 보내지 않았습니다.',
        unknown: '저장되었는지 알 수 없습니다. Retry는 같은 요청 ID로 다시 보내 저장 결과를 확인하고, Discard는 이 요청을 버립니다.',
        refused: '서버가 이 계정의 질문 읽기를 거절했습니다. 권한이 바뀌었다면 화면을 다시 불러오세요.',
        ownerChanged: '로그인한 계정이 바뀌었습니다. 이 화면에서는 질문을 더 읽거나 쓰지 않습니다. 화면을 다시 불러오세요.',
        rejected: '서버가 요청을 거절했습니다.',
        expired: '세션이 만료되었습니다. 다시 로그인하세요.',
        noResponse: '응답이 없어 요청을 멈췄습니다.',
        noServer: '서버에 연결하지 못했습니다.',
        codes: {
          QUESTION_CHANGED: '그사이 이 질문이 바뀌었습니다. 스레드를 다시 불러왔으니 내용을 확인한 뒤 다시 보내세요.',
          QUESTION_CLOSED: '이미 닫힌 질문이라 더 쓸 수 없습니다.',
          QUESTION_STATE: '지금 질문 상태에서는 할 수 없는 동작입니다.',
          QUESTION_ENTRY_LIMIT: '이 스레드의 항목 수가 상한에 도달했습니다.',
          REQUEST_ID_REUSED: '같은 요청 ID가 다른 내용에 이미 쓰였습니다. 다시 불러온 뒤 새로 보내세요.',
          QUESTION_BUSY: '서버가 다른 요청을 처리하고 있어 저장하지 못했을 수 있습니다. Retry는 같은 요청 ID로 다시 보냅니다.',
          STUDY_ACCESS_CHANGED: '요청 중 검사 접근 조건이 바뀌었습니다. 저장되었을 수 있으니 Retry로 같은 요청을 다시 보내 확인하세요.',
        },
        statuses: { 400: '서버가 입력을 거절했습니다.', 403: '서버가 이 동작을 거절했습니다.' },
      };
      const STATES = ['Open', 'Answered', 'Closed'];
      const KINDS = { question: 'Question', followup: 'Follow-up', answer: 'Answer', close: 'Close' };
      const ROLES = { clinician: 'Clinician', radiologist: 'Radiologist', admin: 'Admin' };
      const REPORT = { W: 'Awaiting Report', T: 'In Progress', P: 'Preliminary', A: 'Approved', H: 'On Hold' };
      // 계약 §5.1 전이표(이 화면이 쓰는 동작만). 쓰기 응답의 action마다 항목 종류·가능한 이전 상태·다음 상태가 하나다.
      const STEPS = {
        answer: { kind: 'answer', from: ['Open', 'Answered'], to: 'Answered' },
        followup: { kind: 'followup', from: ['Open', 'Answered'], to: 'Open' },
        close: { kind: 'close', from: ['Open', 'Answered'], to: 'Closed' },
      };
      // 쓰는 칸마다 서버가 고를 수 있는 action. Reply는 작성자면 followup, 아니면 answer다(서버가 정한다).
      const ACTIONS = { reply: ['answer', 'followup'], close: ['close'] };
      const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const STUDY = /^\d+(?:\.\d+)+$/;
      const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
      const TIMEOUT_MS = 60000, TEXT_MAX = 2000;
      let ended = false, lock = null;
      // 나가 있는 질문 요청. 세션이 끝나면(end) 모두 멈춘다 — 답은 번호로도 버려지지만 끝난 세션의 응답을 기다리지 않는다.
      const inflight = new Set();
      // uid는 지금 읽는 판독 대상. epoch는 대상이 바뀌거나 잠길 때마다 오르고, 읽기마다 자기 번호와 함께 들고 떠난다.
      let uid = null, epoch = 0, listSeq = 0, threadSeq = 0, inboxSeq = 0;
      let items = null, listFailure = null, listLoading = false;
      let mode = null, threadId = null, thread = null, threadFailure = null, threadLoading = false, pendingThread = null;
      let inboxState = 'open', inboxItems = [], inboxCursor = null, inboxFailure = null, inboxLoading = false;
      // 검사·스레드·동작별로 쓰던 글, 결과를 모르는 요청(같은 requestId로 다시 보낼 것), 스레드별 마지막 결과 문구.
      const drafts = new Map(), attempts = new Map(), notes = new Map();
      const fresh = (era, target) => !ended && lock === null && era === epoch && target === uid;
      const keyOf = (target, id, action) => `${target}\n${id}\n${action}`;
      const noteOf = (target, id) => `${target}\n${id}`;
      const make = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const button = (label, onClick) => {
        const node = make('button', null, label);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
      };
      const stateBox = id => {
        const box = make('div', 'question-state');
        box.id = id;
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.append(make('p', 'question-text'), make('p', 'question-detail'));
        return box;
      };
      const setState = (box, state, text, detail) => {
        box.dataset.state = state;
        box.querySelector('.question-text').textContent = text;
        box.querySelector('.question-detail').textContent = detail || '';
      };
      const dash = value => typeof value === 'string' && value.trim() ? value : '—';
      const person = value => dash(value && (value.name || value.actor));
      const badge = state => {
        const node = make('span', 'question-status', state);
        node.dataset.state = state;
        return node;
      };
      const time = value => {
        const date = typeof value === 'string' ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) return '—';
        const two = part => String(part).padStart(2, '0');
        return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
      };
      const reportText = anchor => {
        const name = REPORT[anchor.rs] || `RS ${anchor.rs}`;
        return anchor.version === null ? name : `${name} · Version ${anchor.version}`;
      };
      const describe = error => {
        const parts = [];
        if (error && error.status) parts.push(`HTTP ${error.status}`);
        if (error && error.code) parts.push(error.code);
        const message = error && error.message ? error.message : TEXT.rejected;
        return parts.length ? `${message} (${parts.join(' · ')})` : message;
      };
      const readDetail = error => `${error && error.status === 404 ? `${TEXT.notFound}\n` : ''}${describe(error)}`;

      /** 응답의 owner가 이 화면의 계정인가. 다르면 false(다른 계정의 답), 모양이 틀리면 null(형식 오류)이다. */
      function ownerOf(data) {
        const value = data && data.owner, mine = owner();
        if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null;
        return !!mine && value[0] === mine[0] && value[1] === mine[1];
      }

      /** 요청마다 새 UUID v4. randomUUID가 없는 브라우저는 같은 형식을 getRandomValues로 만든다. */
      function newRequestId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map(part => part.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }

      /**
       * 질문 route 요청(제한 시간 60초). 이 문서의 전송으로 보낸다: 부르는 순간의 작업 문맥으로 승인받고 그 세션의 식별값을
       * 싣는다. 쓰기는 HTTP 상태가 필요해 성공 응답을 상태와 함께 돌려준다 — 201만 적용 결과다(appliedOf). 401은 전송이 그
       * 요청의 세션으로 auth.js에 알리고, 이 줄은 세션 종료 조정이 부르는 end()로 닫힌다(여기서 로그아웃을 부르지 않는다).
       * 연결 실패·제한 시간·세션 종료로 멈춘 요청은 status 0이다 — 쓰기라면 서버가 적용했는지 모르는 결과다. 답이 왔을 때 그
       * 문맥이 무효이면(로그아웃 준비·그 취소) `stale`을 단 status 0으로 끝난다: 읽기는 번호로 버려지고(suspend), 쓰기는 결과를
       * 모르는 것으로 남는다.
       */
      async function call(method, path, body) {
        const controller = new AbortController(), at = work.capture('document');
        inflight.add(controller);
        try {
          const answer = await transport.request(apiBase + path, { method, json: body, signal: controller.signal, context: at,
            deadlineMs: TIMEOUT_MS, abortWhenStale: false });
          if (!work.admits(at)) throw Object.assign(new Error(TEXT.noResponse), { status: 0, code: null, stale: true });
          if (answer.auth) throw Object.assign(new Error(TEXT.expired), { status: answer.status, code: null, auth: true });
          if (!answer.ok) {
            throw Object.assign(new Error(answer.body && typeof answer.body.message === 'string' ? answer.body.message : `HTTP ${answer.status}`),
              { status: answer.status, code: answer.code });
          }
          return { status: answer.status, data: answer.incomplete ? null : answer.body };
        } catch (error) {
          if (error && Number.isInteger(error.status)) throw error;
          throw Object.assign(new Error(error && error.transport === 'timeout' ? TEXT.noResponse : TEXT.noServer),
            { status: 0, code: null, stale: !work.admits(at) });
        } finally {
          inflight.delete(controller);
        }
      }

      /** #3·#1 응답의 모양 검사. target이 있으면 모든 행이 그 검사의 것이어야 한다. 하나라도 틀리면 답 전체를 그리지 않는다. */
      function readSummaries(data, target) {
        const rows = data && data.items;
        if (!Array.isArray(rows) || rows.length > 50) throw new Error(TEXT.malformed);
        for (const row of rows) {
          if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !ID.test(row.id) || typeof row.studyUid !== 'string'
              || (target === null ? row.studyUid.length > 64 || !STUDY.test(row.studyUid) : row.studyUid !== target)
              || !STATES.includes(row.state) || !Number.isSafeInteger(row.revision) || row.revision < 1
              || !Number.isSafeInteger(row.entryCount) || row.entryCount < 1 || !row.author || typeof row.author !== 'object')
            throw new Error(TEXT.malformed);
        }
        return rows;
      }

      /** #2 응답의 모양 검사: 요청한 스레드·판독 대상의 답, seq 1부터 빈틈없는 항목, revision = 항목 수(서버 CHECK). */
      function readThread(data, target, id) {
        const item = data && data.item;
        const text = value => typeof value === 'string';
        const who = (value, role) => !!value && typeof value === 'object' && text(value.actor) && text(value.name)
          && (!role || Object.prototype.hasOwnProperty.call(ROLES, value.role));
        const anchor = value => !!value && typeof value === 'object' && text(value.rs) && value.rs.length > 0
          && (value.version === null || (Number.isSafeInteger(value.version) && value.version > 0));
        if (!item || typeof item !== 'object' || item.id !== id) throw new Error(TEXT.malformed);
        // 다른 검사의 질문이면 판독 대상 곁에 열지 않고 그 이유를 보인다(Inbox에서 고른 질문도 이 단건 읽기로 확인한다).
        if (item.studyUid !== target) throw new Error(TEXT.otherStudy);
        if (!STATES.includes(item.state) || !who(item.author) || !Array.isArray(item.entries) || !item.entries.length || item.entries.length > 100
            || item.revision !== item.entries.length || item.entryCount !== item.entries.length || !anchor(item.current)
            || (item.state === 'Closed') !== (!!item.closed && typeof item.closed === 'object'))
          throw new Error(TEXT.malformed);
        item.entries.forEach((entry, index) => {
          if (!entry || typeof entry !== 'object' || entry.seq !== index + 1
              || !Object.prototype.hasOwnProperty.call(KINDS, entry.kind) || (index === 0) !== (entry.kind === 'question')
              || !text(entry.body) || (entry.kind !== 'close' && !entry.body.trim()) || !who(entry.author, true) || !anchor(entry.reportAnchor))
            throw new Error(TEXT.malformed);
        });
        return item;
      }

      /**
       * 쓰기 응답이 이 요청의 적용 결과인가(계약 §3.4 QuestionApplied·§5.1 전이). HTTP 201만 받고 필수 칸을 모두 본다:
       * requestId·검사·스레드, entry.id = requestId, entry.seq = revision, revision = 보낸 기준 revision + 1, from = 보낸 때의
       * 상태, action·entry.kind·from·to가 전이표의 한 줄, at은 시각. 기준은 원래 요청(attempt)이다 — 지금 화면의 스레드로 보면
       * 그사이 전이·종결된 스레드에 보낸 Retry의 정상 재전송(저장된 결과)을 틀렸다고 한다. 어긋나면 결과를 모르는 응답이다.
       */
      function appliedOf(sent, attempt) {
        const answer = sent.data, applied = answer && answer.applied;
        if (sent.status !== 201 || !applied || typeof applied !== 'object' || typeof answer.replayed !== 'boolean'
            || !ACTIONS[attempt.action].includes(applied.action)) return false;
        const step = STEPS[applied.action], entry = applied.entry, base = attempt.base;
        const mine = value => typeof value === 'string' && value.toLowerCase() === attempt.requestId;
        return mine(applied.requestId) && applied.studyUid === attempt.uid && applied.id === attempt.threadId
          && !!entry && typeof entry === 'object' && mine(entry.id) && entry.kind === step.kind && entry.seq === applied.revision
          && applied.revision === base.revision + 1 && step.from.includes(applied.from) && applied.from === base.state
          && applied.to === step.to && typeof applied.at === 'string' && !Number.isNaN(Date.parse(applied.at));
      }

      // 창은 한 번 만든다: 목록·스레드·받은편지함·잠금 안내.
      const lockBox = make('div', 'question-state');
      lockBox.id = 'question-lock';
      lockBox.dataset.state = 'failed';
      lockBox.setAttribute('role', 'alert');
      lockBox.append(make('p', 'question-text'), make('p', 'question-detail'));
      const studyView = make('div');
      studyView.dataset.view = 'study';
      const listState = stateBox('question-list-state');
      const listRetry = button('Retry', () => loadList());
      listRetry.id = 'question-list-retry';
      listState.append(listRetry);
      const list = make('ol');
      list.id = 'question-list';
      const threadBox = make('section', 'question-thread');
      threadBox.id = 'question-thread';
      threadBox.setAttribute('aria-label', 'Thread');
      threadBox.hidden = true;
      studyView.append(listState, list, threadBox);
      const inboxView = make('div');
      inboxView.dataset.view = 'inbox';
      const inboxHead = make('div', 'question-actions');
      const inboxLabel = make('label', null, 'State');
      inboxLabel.htmlFor = 'question-inbox-filter';
      const inboxFilter = make('select');
      inboxFilter.id = 'question-inbox-filter';
      for (const [value, label] of [['open', 'Open'], ['answered', 'Answered'], ['closed', 'Closed'], ['all', 'All']]) {
        const option = make('option', null, label);
        option.value = value;
        inboxFilter.append(option);
      }
      inboxFilter.addEventListener('change', () => { inboxState = inboxFilter.value; loadInbox(false); });
      const inboxReload = button('Reload', () => loadInbox(false));
      inboxReload.id = 'question-inbox-reload';
      inboxHead.append(inboxLabel, inboxFilter, inboxReload);
      const inboxLine = stateBox('question-inbox-state');
      const inboxRetry = button('Retry', () => loadInbox(inboxItems.length > 0));
      inboxRetry.id = 'question-inbox-retry';
      inboxLine.append(inboxRetry);
      const inboxList = make('ol');
      inboxList.id = 'question-inbox-list';
      const inboxMore = button('More', () => loadInbox(true));
      inboxMore.id = 'question-inbox-more';
      inboxView.append(make('p', 'question-muted', TEXT.inboxHint), inboxHead, inboxLine, inboxList, inboxMore);
      pane.append(lockBox, studyView, inboxView);

      /** 줄과 창의 겉모습. 줄은 질문이 있거나·읽기가 실패했거나·잠겼거나·창을 연 동안만 보인다. */
      function paint() {
        const visible = !ended && allowed() && (lock !== null || mode !== null || listFailure !== null || (items !== null && items.length > 0));
        root.hidden = !visible;
        root.dataset.state = ended ? 'ended' : lock ? 'locked' : listFailure ? 'failed' : listLoading ? 'loading'
          : items === null ? 'idle' : items.length ? 'ready' : 'empty';
        const counts = state => (items || []).filter(item => item.state === state).length;
        const line = lock ? lock.text : uid === null ? TEXT.none : listFailure ? TEXT.failed : items === null ? TEXT.loading
          : items.length ? TEXT.counts(items.length, counts('Open'), counts('Answered'), counts('Closed')) : TEXT.empty;
        summary.textContent = line;
        summary.title = line;
        toggle.textContent = mode === 'study' ? 'Hide Questions' : 'Show Questions';
        toggle.setAttribute('aria-expanded', String(mode === 'study'));
        inboxButton.setAttribute('aria-expanded', String(mode === 'inbox'));
        pane.hidden = mode === null;
        pane.dataset.mode = mode || '';
        lockBox.hidden = lock === null;
        lockBox.querySelector('.question-text').textContent = lock ? lock.text : '';
        lockBox.querySelector('.question-detail').textContent = lock ? lock.detail : '';
        studyView.hidden = lock !== null || mode !== 'study';
        inboxView.hidden = lock !== null || mode !== 'inbox';
      }

      function renderList() {
        const state = uid === null ? 'none' : listFailure ? 'failed' : listLoading || items === null ? 'loading' : items.length ? 'ready' : 'empty';
        setState(listState, state, { none: TEXT.none, failed: TEXT.failed, loading: TEXT.loading, empty: TEXT.empty }[state]
          || TEXT.ready(items.length), listFailure ? readDetail(listFailure) : '');
        listRetry.hidden = !listFailure;
        list.replaceChildren(...(listFailure || !items ? [] : items).map(listItem));
        list.hidden = !list.children.length;
      }

      function listItem(item) {
        const li = make('li');
        li.dataset.id = item.id;
        if (item.id === threadId) li.setAttribute('aria-current', 'true');
        const open = button('Open Thread', () => openThread(item.id));
        open.dataset.openThread = '';
        li.append(badge(item.state), ' ',
          TEXT.item(time(item.createdAt), person(item.author), item.entryCount, time(item.lastEntryAt)), ' ', open);
        return li;
      }

      function clearThreadBox() {
        threadBox.hidden = true;
        threadBox.replaceChildren();
        delete threadBox.dataset.id;
        delete threadBox.dataset.state;
      }

      /**
       * 스레드 자리. 같은 스레드를 다시 읽을 때는 머리·항목만 바꾸고 쓰는 칸은 그대로 둔다 — 다시 만들면 치고 있던 글자와
       * 커서가 사라진다. 다른 스레드(다른 검사의 스레드 포함)를 열 때만 새로 만든다.
       */
      function buildThread(target, id) {
        threadBox.dataset.id = id;
        const head = make('div', 'question-actions');
        const title = make('h4', null, 'Thread');
        const status = make('span');
        status.dataset.part = 'status';
        head.append(title, status);
        const meta = make('p', 'question-muted');
        meta.dataset.part = 'meta';
        const state = stateBox('question-thread-state');
        state.dataset.part = 'state';
        const retry = button('Retry', () => loadThread());
        retry.dataset.part = 'retry';
        state.append(retry);
        const entries = make('ol');
        entries.id = 'question-entries';
        entries.dataset.part = 'entries';
        const closed = make('p', 'question-muted', TEXT.closedNote);
        closed.dataset.part = 'closed';
        const reply = composer(target, id, 'reply', { label: 'Reply', hint: TEXT.replyHint, button: 'Reply', multiline: true });
        // OQ-11 (a): 서버는 답변 문장을 거르지 않는다. 확정 전 소견이 그대로 전해진다는 사실을 입력 곁에 둔다.
        const nonFinal = make('p', 'question-nonfinal', TEXT.nonFinal);
        nonFinal.id = 'question-nonfinal';
        reply.querySelector('textarea').before(nonFinal);
        reply.querySelector('textarea').setAttribute('aria-describedby', 'question-reply-hint question-nonfinal');
        const close = composer(target, id, 'close', { label: 'Close Reason', hint: TEXT.closeHint, button: 'Close', multiline: false });
        const note = noteBox(noteOf(target, id));
        threadBox.replaceChildren(head, meta, state, entries, closed, reply, close, note);
      }

      function renderThread() {
        if (uid === null || threadId === null || listFailure !== null) {
          clearThreadBox();
          return;
        }
        if (threadBox.dataset.id !== threadId) buildThread(uid, threadId);
        threadBox.hidden = false;
        const part = name => threadBox.querySelector(`[data-part="${name}"]`);
        const loaded = !threadFailure && thread !== null && thread.id === threadId ? thread : null;
        threadBox.dataset.state = loaded ? loaded.state : threadFailure ? 'failed' : 'loading';
        part('status').replaceChildren(...(loaded ? [badge(loaded.state)] : []));
        part('meta').textContent = loaded ? TEXT.threadMeta(time(loaded.createdAt), person(loaded.author)) : '';
        const state = threadFailure ? 'failed' : threadLoading || !loaded ? 'loading' : 'ready';
        setState(part('state'), state, { failed: TEXT.threadFailed, loading: TEXT.threadLoading }[state] || '',
          threadFailure ? readDetail(threadFailure) : '');
        part('state').hidden = state === 'ready';
        part('retry').hidden = !threadFailure;
        part('entries').replaceChildren(...(loaded ? loaded.entries.map(item => entryItem(item, loaded.current)) : []));
        part('closed').hidden = !loaded || loaded.state !== 'Closed';
        for (const wrap of threadBox.querySelectorAll('.question-compose')) {
          paintComposer(wrap);
          // 닫힌 스레드에는 쓰는 칸을 두지 않는다. 쓰던 글이나 결과를 모르는 요청이 남은 칸만 그대로 둔다.
          wrap.hidden = !!loaded && loaded.state === 'Closed' && !attempts.has(wrap.dataset.key) && !(drafts.get(wrap.dataset.key) || '');
        }
      }

      function entryItem(entry, current) {
        const li = make('li');
        li.dataset.seq = String(entry.seq);
        li.dataset.kind = entry.kind;
        const meta = make('p', 'question-muted');
        meta.append(make('strong', null, KINDS[entry.kind]), ` · ${person(entry.author)} (${ROLES[entry.author.role]}) · ${time(entry.at)}`);
        const body = entry.body ? make('p', 'question-body', entry.body) : make('p', 'question-muted', TEXT.closeEmpty);
        li.append(meta, body);
        // 답변 뒤 판독이 승인·Addendum·Reset되었으면 그 답이 어느 판독 상태를 보고 쓴 것인지 알린다(서버는 스레드를 다시 열지 않는다).
        if (entry.kind === 'answer' && (entry.reportAnchor.rs !== current.rs || entry.reportAnchor.version !== current.version)) {
          const note = make('p', 'question-anchor');
          note.dataset.anchor = '';
          note.append(make('strong', null, TEXT.anchorChanged), ' ', TEXT.anchorDetail(reportText(entry.reportAnchor), reportText(current)));
          li.append(note);
        }
        return li;
      }

      /**
       * 쓰는 칸 하나(Reply·Close Reason). 결과를 모르는 요청이 있는 동안 글은 바꿀 수 없고 Retry(같은 requestId)와 Discard만
       * 있다 — 글을 고쳐 새 requestId로 보내면 이미 저장된 답 위에 하나가 더 생길 수 있다.
       */
      function composer(target, id, action, spec) {
        const key = keyOf(target, id, action);
        const wrap = make('div', 'question-compose');
        wrap.dataset.key = key;
        wrap.dataset.action = action;
        const fieldId = `question-${action}-text`, hintId = `question-${action}-hint`;
        const label = make('label', null, spec.label);
        label.htmlFor = fieldId;
        const hint = make('p', 'question-muted', spec.hint);
        hint.id = hintId;
        const field = make(spec.multiline ? 'textarea' : 'input');
        field.id = fieldId;
        field.dataset.field = '';
        if (spec.multiline) field.rows = 3;
        else field.type = 'text';
        field.maxLength = TEXT_MAX;
        field.setAttribute('aria-describedby', hintId);
        field.addEventListener('input', () => {
          if (!attempts.has(key)) drafts.set(key, field.value);
        });
        const actions = make('div', 'question-actions');
        const send = button(spec.button, () => submit(target, id, action, field));
        send.dataset.send = '';
        const retry = button('Retry', () => resend(key));
        retry.dataset.retry = '';
        const discard = button('Discard', () => drop(key));
        discard.dataset.discard = '';
        actions.append(send, retry, discard);
        wrap.append(label, hint, field, actions);
        paintComposer(wrap);
        return wrap;
      }

      /** 쓰는 칸의 모양은 맵(쓰던 글·결과를 모르는 요청)과 마지막으로 읽힌 그 스레드에서만 정한다. */
      function paintComposer(wrap) {
        const key = wrap.dataset.key, [, id] = key.split('\n');
        const attempt = attempts.get(key) || null, field = wrap.querySelector('[data-field]');
        wrap.dataset.state = !attempt ? 'idle' : attempt.busy ? 'busy' : 'unknown';
        field.readOnly = attempt !== null;
        // 같은 글이면 쓰지 않는다: 값을 다시 넣으면 치고 있던 커서·한글 조합이 끊긴다.
        const value = attempt ? attempt.text : drafts.get(key) || '';
        if (field.value !== value) field.value = value;
        // 기준 revision은 마지막으로 읽힌 그 스레드에서만 온다. 한 번도 읽히지 않았거나 읽기에 실패했으면 보내지 않는다.
        const ready = !threadFailure && thread !== null && thread.id === id;
        wrap.querySelector('[data-send]').disabled = attempt !== null || !ready;
        for (const name of ['retry', 'discard']) wrap.querySelector(`[data-${name}]`).hidden = !attempt || attempt.busy;
      }

      function repaintComposer(key) {
        for (const wrap of threadBox.querySelectorAll('.question-compose')) if (wrap.dataset.key === key) paintComposer(wrap);
      }

      function noteBox(key) {
        const box = make('div', 'question-state');
        box.dataset.noteKey = key;
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        box.append(make('p', 'question-text'), make('p', 'question-detail'));
        paintNote(box);
        return box;
      }

      function paintNote(box) {
        const note = notes.get(box.dataset.noteKey) || null;
        box.hidden = note === null;
        setState(box, note ? note.state : 'idle', note ? note.text : '', note ? note.detail : '');
      }

      function setNote(key, state, text, detail) {
        notes.set(key, { state, text, detail: detail || '' });
        for (const box of threadBox.querySelectorAll('[data-note-key]')) if (box.dataset.noteKey === key) paintNote(box);
      }

      /**
       * 새 쓰기: 새 requestId(UUID v4), 이 화면의 계정([기관, sub]), 마지막으로 읽힌 스레드의 revision을 싣는다. 그 revision과
       * 상태를 요청에 적어 두고 응답(Retry의 재전송 포함)은 이 기준으로만 확인한다(appliedOf).
       */
      function submit(target, id, action, field) {
        const key = keyOf(target, id, action), noteKey = noteOf(target, id);
        const loaded = !threadFailure && thread !== null && thread.id === id ? thread : null;
        const who = owner();
        if (ended || lock !== null || target !== uid || attempts.has(key) || !loaded || !who) return;
        const value = field.value;
        if (!(action === 'close' && value === '') && (!value.trim() || value.length > TEXT_MAX)) {
          setNote(noteKey, 'failed', TEXT.noText);
          return;
        }
        let requestId;
        try {
          requestId = newRequestId();
        } catch (_) {
          setNote(noteKey, 'failed', TEXT.noRequestId);
          return;
        }
        const path = `/questions/${encodeURIComponent(id)}/${action === 'close' ? 'close' : 'entries'}`;
        const attempt = { requestId, owner: who, uid: target, threadId: id, action, noteKey, path, text: value, busy: false, unknown: false,
          base: { revision: loaded.revision, state: loaded.state },
          payload: { revision: loaded.revision, [action === 'close' ? 'note' : 'body']: value } };
        drafts.set(key, value);
        attempts.set(key, attempt);
        transmit(key, attempt);
      }

      /** 결과를 모르는 요청만 같은 requestId·같은 본문으로 다시 보낸다. 이미 적용되었으면 서버가 저장한 결과를 돌려준다. */
      function resend(key) {
        const attempt = attempts.get(key);
        if (ended || lock !== null || !attempt || attempt.busy || !attempt.unknown) return;
        transmit(key, attempt);
      }

      /** 결과를 모르는 요청을 버린다. 글은 칸에 남기고, 저장되었는지는 다시 읽은 스레드로 보인다. */
      function drop(key) {
        const attempt = attempts.get(key);
        if (ended || !attempt || attempt.busy) return;
        attempts.delete(key);
        drafts.set(key, attempt.text);
        setNote(attempt.noteKey, 'discarded', TEXT.discarded);
        repaintComposer(key);
        if (lock === null && attempt.uid === uid) loadList();
      }

      async function transmit(key, attempt) {
        attempt.busy = true;
        attempt.unknown = false;
        setNote(attempt.noteKey, 'busy', TEXT.sending);
        repaintComposer(key);
        let sent = null, error = null;
        try {
          sent = await call('POST', attempt.path, { requestId: attempt.requestId, expectedOwner: attempt.owner, ...attempt.payload });
        } catch (caught) {
          error = caught;
        }
        // 세션이 끝났거나 잠겨 맵을 비웠으면 이 결과는 어디에도 쓰지 않는다.
        if (ended || attempts.get(key) !== attempt) return;
        attempt.busy = false;
        // 로그아웃 준비·그 취소 뒤에 온 답은 저장 결과로 그리지 않는다. 그 쓰기는 결과를 모르는 것으로 남아 같은 요청 ID의
        // Retry가 서버의 결과를 확인한다(보낸 것을 잊지 않는다).
        if (error && error.stale) {
          attempt.unknown = true;
          notes.set(attempt.noteKey, { state: 'unknown', text: TEXT.unknown, detail: '' });
          return;
        }
        if (error) {
          writeFailed(key, attempt, error);
          return;
        }
        const same = ownerOf(sent.data);
        if (same === false) {
          accountChanged('');
          return;
        }
        if (same === null || !appliedOf(sent, attempt)) {
          attempt.unknown = true;
          setNote(attempt.noteKey, 'unknown', TEXT.writeMalformed, sent.status === 201 ? '' : `HTTP ${sent.status}`);
          repaintComposer(key);
          return;
        }
        attempts.delete(key);
        drafts.delete(key);
        setNote(attempt.noteKey, 'saved', sent.data.replayed ? TEXT.replayed : TEXT.saved);
        repaintComposer(key);
        // 화면의 스레드는 쓰기 응답(적용 결과)이 아니라 읽기 route로 다시 읽은 현재 상태로만 그린다.
        if (lock === null && attempt.uid === uid) loadList();
      }

      /**
       * 쓰기 실패. 연결 실패·제한 시간·5xx·QUESTION_BUSY·STUDY_ACCESS_CHANGED(커밋 뒤 최종 확인일 수 있다)는 적용 여부를 모르는
       * 결과라 Retry(같은 requestId)를 남긴다. 그 밖의 거절은 요청을 버리고 쓰던 글은 칸에 둔다. OWNER_CHANGED는 계정이 바뀐 것이다.
       */
      function writeFailed(key, attempt, error) {
        if (error.auth) return;
        if (error.code === 'OWNER_CHANGED') {
          accountChanged(describe(error));
          return;
        }
        if (error.status === 0 || error.status >= 500 || error.code === 'STUDY_ACCESS_CHANGED') {
          attempt.unknown = true;
          setNote(attempt.noteKey, 'unknown', TEXT.codes[error.code] || TEXT.unknown, describe(error));
          repaintComposer(key);
          return;
        }
        attempts.delete(key);
        setNote(attempt.noteKey, 'failed',
          TEXT.codes[error.code] || (error.status === 404 ? TEXT.notFound : TEXT.statuses[error.status]) || TEXT.rejected, describe(error));
        repaintComposer(key);
        // 질문이 바뀌었거나 닫혔거나 보이지 않게 되었으면 지금 서버 상태를 다시 읽는다(쓰던 글은 칸에 남는다).
        if ((error.status === 404 || error.status === 409) && lock === null && attempt.uid === uid) loadList();
      }

      /**
       * 확인된 계정 변경(다른 계정의 봉투 owner·OWNER_CHANGED)은 이 줄만의 일이 아니다. 이 줄을 잠그고 notifyAccountChanged로 onCommonEnd 구독자에게
       * 사유 'account-changed'로 알려, 네트워크를 기다리기 전에 같은 페이지의 다른 영역(S5-U4c 영상 요청)도
       * 쓰던 글·결과를 모르는 요청·읽기/쓰기 번호를 버리게 한다 — 이 줄만 잠그면 다른 영역에 이전 계정의 note와 Retry가 남고 나가
       * 있던 쓰기의 늦은 영수증이 저장 결과로 그려진다(Astra S5-U4bc-R-001 F01). 질문 읽기를 서버가 403으로 거절한 것은 계정 변경이
       * 아니라서 lockPanel로 이 줄만 잠근다.
       */
      function accountChanged(detail) {
        lockPanel(TEXT.ownerChanged, detail, true);
        notifyAccountChanged(detail);
      }

      /**
       * 서버가 질문 읽기를 거절했거나(403) 계정이 바뀌었다(accountChanged, 이 줄이나 다른 영역이 알아챘다). 이 문서에서는 질문을
       * 더 읽거나 쓰지 않고 진행 중인 요청의 답도 그리지 않는다(뷰어 세션의 거절·계정 변경과 같은 한 방향). 쓰던 글은 이전 계정의
       * 것이라 버린다. 403으로 이미 잠긴 뒤 계정 변경을 알면(account) 그 까닭으로 바꿔 쓴다.
       */
      function lockPanel(text, detail, account = false) {
        if (ended || (lock !== null && (lock.account || !account))) return;
        lock = { text, detail: detail || '', account };
        epoch++;
        listSeq++;
        threadSeq++;
        inboxSeq++;
        drafts.clear();
        attempts.clear();
        notes.clear();
        items = null;
        listFailure = null;
        listLoading = false;
        threadId = null;
        thread = null;
        threadFailure = null;
        threadLoading = false;
        pendingThread = null;
        inboxItems = [];
        inboxCursor = null;
        inboxFailure = null;
        inboxLoading = false;
        if (mode === null) mode = 'study';
        clearThreadBox();
        list.replaceChildren();
        inboxList.replaceChildren();
        paint();
      }

      /**
       * #3. 판독 대상의 스레드 요약(최신 50). 성공하면 연 스레드를 단건 읽기(#2)로 다시 읽는다. 연 스레드는 이 목록에 있는지로
       * 고르거나 내리지 않는다 — 목록은 최신 50개뿐이라 Inbox에서 고른 오래된 질문이나 쓰기 뒤 다시 읽은 목록에 없을 수 있다
       * (Astra S5-U4b-R-001 F3). 그 스레드를 열 수 있는지는 loadThread가 owner·studyUid·요청 번호로 정하고 404·403·다른 검사는
       * 명시 문구로 보인다. 목록을 읽지 못하면 스레드 칸을 내리되(그 내용은 버린다) 고른 스레드는 두어 Retry 뒤 다시 읽는다.
       */
      async function loadList() {
        if (ended || lock !== null || uid === null) return;
        const target = uid, era = epoch, mine = ++listSeq;
        listLoading = true;
        listFailure = null;
        paint();
        renderList();
        let data;
        try {
          data = (await call('GET', `/studies/${encodeURIComponent(target)}/questions`)).data;
        } catch (error) {
          if (!fresh(era, target) || mine !== listSeq) return;
          listLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          items = null;
          listFailure = error;
          thread = null;
          paint();
          renderList();
          renderThread();
          return;
        }
        if (!fresh(era, target) || mine !== listSeq) return;
        listLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          items = readSummaries(data, target);
        } catch (error) {
          items = null;
          listFailure = error;
          thread = null;
        }
        paint();
        renderList();
        renderThread();
        if (items && threadId !== null) loadThread();
      }

      function openThread(id) {
        if (ended || lock !== null || uid === null) return;
        if (threadId !== id) {
          threadId = id;
          thread = null;
          threadFailure = null;
          threadSeq++;
        }
        renderList();
        renderThread();
        loadThread();
      }

      /** #2. 연 스레드 전체. 늦은 답은 번호·epoch·판독 대상·연 스레드로 버린다. */
      async function loadThread() {
        if (ended || lock !== null || uid === null || threadId === null) return;
        const target = uid, id = threadId, era = epoch, mine = ++threadSeq;
        threadLoading = true;
        threadFailure = null;
        renderThread();
        let data;
        try {
          data = (await call('GET', `/questions/${encodeURIComponent(id)}`)).data;
        } catch (error) {
          if (!fresh(era, target) || mine !== threadSeq || threadId !== id) return;
          threadLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          thread = null;
          threadFailure = error;
          renderThread();
          return;
        }
        if (!fresh(era, target) || mine !== threadSeq || threadId !== id) return;
        threadLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          thread = readThread(data, target, id);
        } catch (error) {
          thread = null;
          threadFailure = error;
        }
        renderThread();
      }

      /** #1 view=inbox. 판독 대상과 무관한 목록이라 epoch가 아니라 자기 번호와 창의 모드로 늦은 답을 버린다. */
      async function loadInbox(more) {
        if (ended || lock !== null || mode !== 'inbox') return;
        const mine = ++inboxSeq, cursor = more ? inboxCursor : null;
        if (!more) {
          inboxItems = [];
          inboxCursor = null;
        }
        inboxLoading = true;
        inboxFailure = null;
        renderInbox();
        let data;
        try {
          data = (await call('GET', `/questions?view=inbox&state=${encodeURIComponent(inboxState)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).data;
        } catch (error) {
          if (ended || lock !== null || mine !== inboxSeq) return;
          inboxLoading = false;
          if (error.auth) return;
          if (error.status === 403) {
            lockPanel(TEXT.refused, describe(error));
            return;
          }
          inboxFailure = error;
          renderInbox();
          return;
        }
        if (ended || lock !== null || mine !== inboxSeq) return;
        inboxLoading = false;
        const same = ownerOf(data);
        if (same === false) {
          accountChanged('');
          return;
        }
        try {
          if (same === null) throw new Error(TEXT.malformed);
          const page = readSummaries(data, null), next = data.nextCursor;
          if (!(next === null || (typeof next === 'string' && CURSOR.test(next) && next !== cursor))) throw new Error(TEXT.malformed);
          inboxItems = [...inboxItems, ...page];
          inboxCursor = next;
        } catch (error) {
          inboxFailure = error;
        }
        renderInbox();
      }

      function renderInbox() {
        const state = inboxLoading ? 'loading' : inboxFailure ? 'failed' : inboxItems.length ? 'ready' : 'empty';
        setState(inboxLine, state, { loading: TEXT.inboxLoading, failed: TEXT.inboxFailed, empty: TEXT.inboxEmpty }[state]
          || TEXT.inboxReady(inboxItems.length, inboxCursor !== null), inboxFailure ? describe(inboxFailure) : '');
        inboxRetry.hidden = !inboxFailure;
        inboxList.replaceChildren(...inboxItems.map(inboxItem));
        inboxList.hidden = !inboxItems.length;
        inboxMore.hidden = inboxCursor === null || inboxLoading || !!inboxFailure;
        inboxFilter.value = inboxState;
      }

      function inboxItem(item) {
        const li = make('li');
        li.dataset.id = item.id;
        li.dataset.uid = item.studyUid;
        const row = study(item.studyUid);
        const label = row ? `${dash(row.name)} · ${dash(row.id)} · ${dash(row.date)} · ${dash(row.desc)}` : `${TEXT.unlisted} · ${item.studyUid}`;
        const open = button('Open Study', () => openFromInbox(item));
        open.dataset.openStudy = '';
        if (!row) {
          open.disabled = true;
          open.title = TEXT.notListed;
        }
        li.append(badge(item.state), ' ', make('span', null, label), ' ',
          make('span', 'question-muted', TEXT.item(time(item.createdAt), person(item.author), item.entryCount, time(item.lastEntryAt))), ' ', open);
        return li;
      }

      /**
       * Inbox의 질문을 연다: 그 검사를 판독 대상으로 고르고(select) 그 검사의 목록을 읽은 뒤 이 스레드를 단건 읽기(#2)로 연다.
       * 스레드는 그 검사의 목록(최신 50)에 있는지와 무관하게 연다(sync·loadList).
       */
      function openFromInbox(item) {
        if (ended || lock !== null || !study(item.studyUid)) return;
        inboxSeq++;
        mode = 'study';
        if (item.studyUid === uid) {
          paint();
          openThread(item.id);
          return;
        }
        pendingThread = { uid: item.studyUid, id: item.id };
        paint();
        openStudy(item.studyUid);
      }

      /**
       * renderClinical()이 부른다(선택·관련 검사 보기·검사 정보 갱신마다). 판독 대상이 바뀐 때만 이전 대상의 스레드를 내리고
       * 새 대상의 목록을 읽는다 — 같은 대상이면 요청도 그리기도 없다.
       */
      function sync() {
        if (ended) return;
        const selectedUid = allowed() ? current() : null;
        const row = selectedUid ? study(selectedUid) : null;
        const next = row && row.tele !== true ? selectedUid : null;
        if (next === uid) return;
        uid = next;
        epoch++;
        listSeq++;
        threadSeq++;
        items = null;
        listFailure = null;
        listLoading = false;
        // Inbox에서 고른 질문의 검사가 판독 대상이 되었으면 그 스레드가 연 스레드다. 목록을 읽은 뒤 단건으로 읽는다(loadList).
        threadId = pendingThread && pendingThread.uid === uid ? pendingThread.id : null;
        pendingThread = null;
        thread = null;
        threadFailure = null;
        threadLoading = false;
        clearThreadBox();
        paint();
        renderList();
        if (uid !== null && lock === null) loadList();
      }

      /**
       * 세션 관문이 실제 종료를 알렸다(명시적 로그아웃·같은 세션의 종료 통지·서버의 종료 코드). 줄을 내리고 쓰던 글을 버리며 나간 요청은 멈추고 그 답은 어디에도 그리지 않는다.
       * 일반 401은 요청 실패로만 남고, 실제 종료는 관문의 lifecycle 변경에서 onCommonEnd 구독자에게 동기로 전달된다.
       * 방송·storage·pagehide와 겹쳐 여러 번 불려도 처음 한 번만 끝낸다. 목록이 사유 'account-changed'로 부르면 세션은 그대로이고
       * 계정이 바뀐 것이라 잠근다(accountChanged).
       */
      function end(reason, detail) {
        if (reason === 'account-changed') {
          lockPanel(TEXT.ownerChanged, detail, true);
          return;
        }
        if (ended) return;
        ended = true;
        epoch++;
        listSeq++;
        threadSeq++;
        inboxSeq++;
        for (const controller of inflight) controller.abort();
        inflight.clear();
        drafts.clear();
        attempts.clear();
        notes.clear();
        uid = null;
        items = null;
        mode = null;
        threadId = null;
        thread = null;
        pendingThread = null;
        inboxItems = [];
        clearThreadBox();
        list.replaceChildren();
        inboxList.replaceChildren();
        paint();
      }

      /**
       * 이 문서의 작업 문맥이 바뀌었다(로그아웃 준비에 들어섰다). 그 전에 나간 읽기의 답은 이 줄의 것이 아니다: 읽기 번호를
       * 넘겨 늦은 답과 실패를 버리고, 그 읽기들이 세운 대기 표시를 내린다. 쓰던 글과 결과를 모르는 쓰기는 그대로 둔다.
       */
      function suspend() {
        if (ended) return;
        listSeq++;
        threadSeq++;
        inboxSeq++;
        listLoading = threadLoading = inboxLoading = false;
      }
      /** 편집으로 돌아왔다: 준비가 버린 읽기를 지금 문맥에서 다시 읽는다. */
      function resume() {
        if (ended || lock !== null) return;
        paint();
        if (uid !== null) loadList();
        if (mode === 'inbox') loadInbox(false);
      }
      work.onInvalidate(event => { if (event.reason === 'prepare') suspend(); });

      toggle.addEventListener('click', () => {
        if (ended) return;
        inboxSeq++;
        mode = mode === 'study' ? null : 'study';
        paint();
        renderList();
        renderThread();
      });
      inboxButton.addEventListener('click', () => {
        if (ended) return;
        if (mode === 'inbox') {
          inboxSeq++;
          mode = lock === null ? null : 'study';
          paint();
          return;
        }
        mode = 'inbox';
        paint();
        if (lock === null) loadInbox(false);
      });
      window.addEventListener('pagehide', end);
      // 이 문서의 세션이 끝나면 세션 종료 조정이 이 목록을 동기로 부른다. 어느 로그인의 종료인지는 auth.js가 대조한다.
      onCommonEnd(end);
      paint();
      return { sync, end, resume };
    }
    let studyQuestions = null;
    try {
      studyQuestions = mountStudyQuestions({ apiBase: API, work, transport, current: () => selectedUid,
        study: uid => studies.find(s => s.uid === uid),
        openStudy: uid => select(uid),
        allowed: () => !!sess && serverMode && !demoMode && !offline && (KinAuth.has('radiologist') || KinAuth.has('admin')),
        owner: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution ?? null, s.sub ?? null] : null; } });
    } catch (_) { toast('임상의 질문 줄을 준비하지 못했습니다. 판독 작업은 계속할 수 있습니다.', 'err'); }

    // ── 패널 크기 조절 ──
    function bindPanelResize(selector, axis, resize) {
      const handle = $(selector);
      handle.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        workspaceGeneration++;
        e.preventDefault();
        const dragAxis = typeof axis === "function" ? axis() : axis;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        document.body.classList.add("resizing", dragAxis === "x" ? "resizing-x" : "resizing-y");

        const move = event => {
          if (event.pointerId === e.pointerId) resize(event, dragAxis);
        };
        const end = event => {
          if (event.pointerId !== e.pointerId) return;
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          handle.classList.remove("dragging");
          document.body.classList.remove("resizing", "resizing-x", "resizing-y");
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
          if (event.type === "pointerup") rememberPanelSize(selector);
          else applyLayout();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      });
    }
    const clampPanel = (value, min, max) => Math.max(min, Math.min(max, value));
    let workspaceOwner = null, workspaceStorage = null, workspaceGeneration = 0;
    // 이 브라우저에 배치를 남겼는가(마지막 쓰기·읽기의 결과). 계정 배치를 확인하지 못했을 때 "이 브라우저에서 계속 쓴다"고
    // 말해도 되는지를 이것이 정한다 — 남기지 못했으면 새로고침하면 사라진다고 말한다(workspace-roaming.js).
    let workspaceLocalKept = true;
    function saveWorkspace() {
      workspaceGeneration++;
      workspaceState.mode = layoutMode;
      workspaceState = KinWorkspaceLayout.withReading(workspaceState, readingWorkspace.snapshotPanels());
      const saved = KinWorkspaceLayout.write(workspaceStorage, workspaceOwner, workspaceState);
      workspaceLocalKept = !!saved;
      $("#layout-status").textContent = saved ? "배치 저장됨 · 이 브라우저" : "배치 저장 안 됨 · 이 창에서만 유지";
    }
    function rememberPanelSize(selector) {
      const targets = { "#resize-main": ["main", ".left"], "#resize-top": ["top", ".rw"],
        "#resize-related": ["related", ".related-p"], "#resize-prior": ["prior", ".related-list-pane"] };
      const [name, panel] = targets[selector];
      const dimension = !portraitLayout() && ["main", "related"].includes(name) ? "width" : "height";
      workspaceState[workspaceAxis()][name] = Math.round($(panel).getBoundingClientRect()[dimension]);
      saveWorkspace();
    }
    function restoreWorkspace() {
      workspaceOwner = KinWorkspaceLayout.key(sess);
      try { workspaceStorage = localStorage; } catch (_) { workspaceStorage = null; }
      const result = KinWorkspaceLayout.read(workspaceStorage, workspaceOwner);
      workspaceState = result.state;
      workspaceLocalKept = !["disabled", "unavailable"].includes(result.status);
      layoutMode = workspaceState.mode;
      readingWorkspace.applyPanels(workspaceState.reading || KinReadingPanelLayout.defaults());
      $("#layout-status").textContent = ({ restored: "배치 복원됨 · 이 브라우저", empty: "배치 · 이 브라우저",
        disabled: "배치 · 이 창에서만 유지", invalid: "저장된 배치 오류 · 기본 배치", unavailable: "배치 저장소 사용 불가 · 기본 배치" })[result.status];
      applyLayout();
    }
    $("#layout-toggle").addEventListener("click", () => {
      layoutMode = layoutMode === "auto" ? "portrait" : layoutMode === "portrait" ? "landscape" : "auto";
      applyLayout();
      saveWorkspace();
    });
    $("#layout-reset").addEventListener("click", () => {
      workspaceGeneration++;
      const removed = KinWorkspaceLayout.remove(workspaceStorage, workspaceOwner);
      workspaceLocalKept = !!removed;
      workspaceState = KinWorkspaceLayout.defaults(); layoutMode = "auto";
      readingWorkspace.applyPanels(KinReadingPanelLayout.defaults());
      applyLayout();
      $("#layout-status").textContent = removed ? "기본 배치 · 이 브라우저" : "초기화 저장 안 됨 · 이 창에서만 유지";
    });
    window.addEventListener("resize", applyLayout);
    /**
     * 작업 영역은 창 크기가 그대로여도 줄고 는다: 열린 툴바 메뉴(View 묶음)는 흐름 안에서 툴바의 둘째 줄이 되고, 알림 줄이
     * 생기고, 글이 줄바꿈된다. applyLayout은 저장한 크기를 그때의 공간 안으로 깎아 적용하고 깎은 값을 저장하지 않으므로, 공간이
     * 돌아오면 저장한 크기를 다시 적용해야 한다 — 그러지 않으면 메뉴를 연 채 불러온 Related 목록이 창 크기를 바꿀 때까지 깎인
     * 높이로 남는다(roam_01). 크기가 바뀐 프레임마다 한 번, 끌기 중에는 하지 않는다(끌기의 끝이 적용하거나 저장한다).
     * `.split`의 크기는 applyLayout이 바꾸는 자식 크기와 무관하다 — 되먹임이 없다.
     * 작업 영역이 문서에서 빠지면(가입 승인 대기·계정 설정 화면이 body를 바꾼다) 관찰은 크기 0을 한 번 알린다 — 배치할 곳이 없으니
     * 아무것도 하지 않는다.
     */
    const workArea = $(".split");
    let splitFrame = 0, splitSize = "";
    new ResizeObserver(() => {
      if (!workArea.isConnected) return;
      const box = workArea.getBoundingClientRect(), size = Math.round(box.width) + "x" + Math.round(box.height);
      if (size === splitSize || splitFrame) { splitSize = size; return; }
      splitSize = size;
      splitFrame = requestAnimationFrame(() => {
        splitFrame = 0;
        if (workArea.isConnected && !document.body.classList.contains("resizing")) applyLayout();
      });
    }).observe(workArea);
    applyLayout();

    bindPanelResize("#resize-main", () => portraitLayout() ? "y" : "x", (e, axis) => {
      const box = $(".split").getBoundingClientRect();
      if (axis === "y")
        $(".left").style.height = clampPanel(e.clientY - box.top, 180, box.height - 420) + "px";
      else
        $(".left").style.width = clampPanel(e.clientX - box.left, 500, box.width - 426) + "px";
    });
    bindPanelResize("#resize-top", "y", e => {
      const right = $(".right"), box = right.getBoundingClientRect();
      // 세로 작업공간을 스크롤한 뒤에도 패널 자체의 높이를 조절한다.
      $(".rw").style.height = clampPanel(e.clientY - box.top + right.scrollTop, 140, box.height - 266) + "px";
    });
    bindPanelResize("#resize-related", () => portraitLayout() ? "y" : "x", (e, axis) => {
      const box = $(".workrow").getBoundingClientRect();
      if (axis === "y")
        $(".related-p").style.height = clampPanel(e.clientY - box.top, 286, box.height - 186) + "px";
      else
        $(".related-p").style.width = clampPanel(e.clientX - box.left, 220, box.width - 366) + "px";
    });
    bindPanelResize("#resize-prior", "y", e => {
      const box = $(".related-p").getBoundingClientRect();
      const list = $(".related-list-pane");
      list.style.flex = "none";
      list.style.height = clampPanel(e.clientY - box.top, 150, box.height - 136) + "px";
    });

    $("#quick").addEventListener("input", () => { worklistSearch?.change(); render(); });
    for (const host of [$('#quick'),$('#filterrow')]) host.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&!e.isComposing&&e.keyCode!==229){e.preventDefault();worklistSearch?.apply();}
    });
    $("#quick-match").addEventListener("change", () => {
      try {
        const next = KinCompoundFilter.withQuickMode(fval[KinCompoundFilter.KEY], $("#quick-match").value, COLS[mode]);
        if (next) fval[KinCompoundFilter.KEY] = next; else delete fval[KinCompoundFilter.KEY];
        activeFilterName = null;
      } catch (error) { toast(error.message, 'err'); }
      worklistSearch?.change();
      render();
    });
    $("#refresh").addEventListener("click", load);
    $('#page-prev').addEventListener('click', () => { resultPage--; render(); });
    $('#page-next').addEventListener('click', () => { resultPage++; render(); });
    $('#page-current').addEventListener('click', () => render(selectedUid));
    $('#page-size').addEventListener('change', () => {
      const size = Number($('#page-size').value);
      if (![25,50,100].includes(size)) return;
      resultPage = Math.floor(resultPage * resultPageSize / size); resultPageSize = size; render();
    });
    $("#m-home").addEventListener("click", load);
    $("#m-filmbox").addEventListener("click", () => { if (selectedUid) openFilmbox(selectedUid); });


    // ── User Filter List (6.2.1) ──
    // 현재 필터 조합에 이름을 붙여 **계정에** 저장한다. 칩을 누르면 그대로 돌아온다.
    // 정렬(sortKey/sortDir)도 함께 저장한다 — 필터가 같아도 정렬이 다르면 다른 화면이다.
    // (HPACS도 2025년에야 "정렬을 적용하여 사용자 필터로 저장"을 넣었다)
    const saveFiltersLocal = () => { try { localStorage.setItem("kin-filters", JSON.stringify(userFilters)); } catch (e) {} };
    function acceptFilterCollection(snapshot) {
      if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub])
        || !Number.isInteger(snapshot.revision) || snapshot.revision < 0
        || !Array.isArray(snapshot.filters) || !Array.isArray(snapshot.folders) || !Array.isArray(snapshot.shortcuts)
        || snapshot.shortcuts.length > 200 || snapshot.shortcuts.some(s => !s || Object.keys(s).sort().join() !== 'id,name,searchId'
          || [s.id, s.name, s.searchId].some(v => typeof v !== 'string' || !v.trim() || v.length > 400 || /[\r\n]/.test(v))
          || !/^(own|shared):[1-9]\d*$/.test(s.searchId))
        || new Set(snapshot.shortcuts.map(s => s.id)).size !== snapshot.shortcuts.length)
        throw new Error('계정 또는 검색 모음 응답을 확인할 수 없습니다. 다시 불러오세요.');
      if (filterCollection && snapshot.revision < filterCollection.revision) throw staleAnswer();
      filterCollection = JSON.parse(JSON.stringify(snapshot));
      storedShortcuts = filterCollection.shortcuts;
      userFilters = validUserFilters(snapshot.filters);
      renderChips();
    }
    function shortcutStatus(message) {
      const status = $('#shortcuts-status');
      if (status && status.textContent !== message) status.textContent = message;
      const save = $('#shortcuts-save');
      if (save) save.disabled = !shortcutDraft || !filterCollection || shortcutBusy || !serverMode || offline || work.state() !== 'active';
    }
    async function reloadFolderSearches(at = work.capture('document')) {
      const sequence = ++filterReadSequence;
      const sharedSequence = ++sharedFilterReadSequence;
      filterCollection = null;
      shortcutStatus('바로가기를 불러오는 중입니다.');
      if (!serverMode || offline) { shortcutStatus('서버에 연결한 뒤 바로가기를 불러오세요.'); return; }
      const results = await Promise.allSettled([
        api('GET', '/filter-folders', undefined, undefined, at),
        api('GET', '/shared-filters', undefined, undefined, at),
      ]);
      if (!work.admits(at) || sequence !== filterReadSequence || sharedSequence !== sharedFilterReadSequence) return;
      work.commit(at, () => {
        const [personal, shared] = results;
        sharedSearches = shared.status === 'fulfilled'
          && JSON.stringify(shared.value?.owner) === JSON.stringify([sess.institution, sess.sub])
          && Array.isArray(shared.value.filters) ? validUserFilters(shared.value.filters) : [];
        try {
          if (personal.status === 'rejected') throw personal.reason;
          acceptFilterCollection(personal.value);
          shortcutStatus(shortcutDraft ? '편집 내용을 유지했습니다. 확인 후 Save Shortcuts로 저장하세요.'
            : shared.status === 'rejected' ? '기관 검색을 불러오지 못했습니다. 해당 바로가기는 Unavailable입니다.' : '');
        } catch (error) {
          filterCollection = null;
          shortcutStatus('검색 모음을 읽지 못해 저장을 막았습니다. Reload Shortcuts로 다시 불러오세요. ' + error.message);
        }
        updateWorklistFolders(); render();
      });
    }
    async function saveFolderShortcuts(next) {
      if (!Array.isArray(next) || !work.admits(work.capture('document'))) return;
      shortcutDraft = JSON.parse(JSON.stringify(next));
      if (shortcutBusy) { shortcutStatus('저장 중입니다. 추가 편집은 현재 저장 뒤에 반영합니다.'); return; }
      if (!filterCollection || !serverMode || offline) {
        shortcutStatus('검색 모음 버전을 확인해야 저장할 수 있습니다. Reload Shortcuts로 다시 불러오세요.'); return;
      }
      const at = work.capture('document'), sent = JSON.stringify(shortcutDraft);
      const body = { expectedOwner: [...filterCollection.owner], revision: filterCollection.revision,
        command: { action: 'replace-shortcuts', shortcuts: JSON.parse(sent) } };
      shortcutBusy = true; ++filterReadSequence; shortcutStatus('바로가기를 저장 중입니다.');
      let saved = false;
      try {
        await filterWriteReady(undefined, at);
        const answer = await api('POST', '/filter-folders', body, undefined, at);
        if (!work.admits(at)) return;
        work.commit(at, () => {
          acceptFilterCollection(answer);
          if (JSON.stringify(shortcutDraft) === sent) shortcutDraft = null;
          saved = true;
        });
      } catch (error) {
        work.commit(at, () => {
          filterCollection = null;
          shortcutStatus('저장 결과를 확인하지 못했습니다. 편집은 유지됩니다. Reload Shortcuts 후 확인해 주세요. ' + error.message);
        });
      } finally {
        work.commit(at, () => {
          shortcutBusy = false; updateWorklistFolders();
          if (saved) shortcutStatus('바로가기를 저장했습니다.');
        });
      }
      if (saved && shortcutDraft && work.admits(at)) await saveFolderShortcuts(shortcutDraft);
    }
    work.onInvalidate(event => {
      if (event.reason === 'prepare') {
        ++filterReadSequence; ++sharedFilterReadSequence;
        if (shortcutBusy) {
          shortcutBusy = false; filterCollection = null;
          shortcutStatus('저장 결과를 확인해야 합니다. 편집으로 돌아온 뒤 Reload Shortcuts로 확인해 주세요.');
        } else shortcutStatus($('#shortcuts-status')?.textContent || '');
      } else if (event.reason === 'cancel') {
        // Resuming never revives the previous write ticket or silently resends its array.
        shortcutStatus($('#shortcuts-status')?.textContent || '');
      }
    });

    const snapshotFilter = () => ({
      quick: $("#quick").value, days: quickDays, mode, cols: { ...fval },
      sortKey, sortDir,
    });
    function filterCriteriaKey(filter) {
      const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
      const cols = Object.fromEntries(Object.entries(filter.cols || {}).filter(([, v]) => v !== '' && v != null));
      const key = COLS[filter.mode]?.some(c => c.k === filter.sortKey) ? filter.sortKey : null;
      return JSON.stringify(canonical({ mode: filter.mode, quick: filter.quick ?? '', days: savedFilterDays(filter.days),
        cols, sortKey: key, sortDir: key ? filter.sortDir || 0 : 0 }));
    }
    function focusFilterChip(name) {
      const chip = [...$('#chips').querySelectorAll('button[data-i]')].find(b => userFilters[+b.dataset.i]?.name === name);
      (chip || $('#managefilters')).focus();
    }
    function editSavedFilter(name) {
      focusFilterChip(name);
      savedFilterManager.open({ name });
    }
    async function filterWriteReady(signal, at) {
      if (sess?.demo && !offline && !serverMode) return true;
      const disconnected = () => offline || !serverMode;
      if (disconnected()) throw new Error('서버 연결을 확인한 뒤 다시 저장하세요. 입력은 유지됩니다.');
      const me = await api('GET', '/me', undefined, signal, at);
      if (me.sub !== sess.sub || me.institution !== sess.institution)
        throw new Error('로그인 계정이 변경됐습니다. 이 창을 다시 로그인한 뒤 사용하세요.');
      if (disconnected()) throw new Error('서버 연결을 확인한 뒤 다시 저장하세요. 입력은 유지됩니다.');
      return false;
    }
    function acceptSavedFilter(saved, local) {
      const next = userFilters.filter(f => f.name !== saved.name).map(f => saved.isDefault ? { ...f, isDefault: false } : f);
      // Keep the existing item's position when editing it.
      const index = userFilters.findIndex(f => f.name === saved.name);
      next.splice(index < 0 ? next.length : index, 0, saved);
      if (local) localStorage.setItem('kin-filters', JSON.stringify(next));
      userFilters = next; renderChips();
    }
    // 관리 창이 부르는 읽기·쓰기는 저마다 시작할 때의 작업 문맥을 잡는다. 요청도, 답을 검색 목록에 쓰는 자리도 그 문맥을
    // 지난다 — 로그아웃 준비·세션 종료 뒤에 온 답은 목록을 바꾸지 않고 취소로 끝난다.
    const savedFilterManager = KinSavedFilterManager.mount({
      columns: COLS, days: savedFilterDays, list: () => userFilters, snapshot: snapshotFilter,
      count: f => filteredFor(f).length, countNote: bodyPartCountNote, apply: applyFilter,
      bodyParts: { snapshot: () => worklistBodyParts.sync(studies),
        load: refresh => { worklistBodyParts.sync(studies); return worklistBodyParts.load({refresh}); },
        cancel: () => worklistBodyParts.cancel() },
      async readFolders(signal, at = work.capture("document")) {
        const sequence = ++filterReadSequence;
        work.commit(at, () => { filterCollection = null; shortcutStatus('검색 모음을 불러오는 중입니다.'); });
        if (await filterWriteReady(signal, at)) throw new Error('폴더 관리는 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('GET', '/filter-folders', undefined, signal, at);
        if (!work.admits(at) || sequence !== filterReadSequence) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub]) || !Array.isArray(snapshot.filters) || !Array.isArray(snapshot.folders))
          throw new Error('계정 또는 검색 모음 응답을 확인할 수 없습니다. 다시 로그인하세요.');
        if (!work.commit(at, () => { acceptFilterCollection(snapshot); shortcutStatus(''); })) throw staleAnswer();
        return snapshot;
      },
      async writeFolders(body, signal, at = work.capture("document")) {
        ++filterReadSequence;
        work.commit(at, () => { filterCollection = null; shortcutStatus('검색 모음을 저장 중입니다.'); });
        if (await filterWriteReady(signal, at)) throw new Error('폴더 관리는 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('POST', '/filter-folders', body, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub]) || !Array.isArray(snapshot.filters) || !Array.isArray(snapshot.folders))
          throw new Error('응답을 확인할 수 없습니다. 검색 모음을 다시 불러오세요.');
        if (!work.commit(at, () => { ++filterReadSequence; acceptFilterCollection(snapshot); })) throw staleAnswer();
        return snapshot;
      },
      async readShared(signal, at = work.capture("document")) {
        const sequence = ++sharedFilterReadSequence;
        // An unreadable shared library cannot keep a previously granted target available.
        work.commit(at, () => { sharedSearches = []; renderChips(); render(); });
        if (await filterWriteReady(signal, at)) throw new Error('기관 검색은 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('GET', '/shared-filters', undefined, signal, at);
        if (!work.admits(at) || sequence !== sharedFilterReadSequence) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub])) throw new Error('계정이 변경되었습니다. 다시 로그인하세요.');
        work.commit(at, () => { sharedSearches = validUserFilters(snapshot.filters); renderChips(); render(); });
        return snapshot;
      },
      async writeShared(body, signal, at = work.capture("document")) {
        ++sharedFilterReadSequence;
        if (await filterWriteReady(signal, at)) throw new Error('기관 검색은 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('POST', '/shared-filters', body, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub])) throw new Error('응답 계정을 확인할 수 없습니다. 공유 목록을 다시 불러오세요.');
        work.commit(at, () => { ++sharedFilterReadSequence; sharedSearches = validUserFilters(snapshot.filters); renderChips(); render(); });
        return snapshot;
      },
      async copyShared(body, signal, at = work.capture("document")) {
        if (await filterWriteReady(signal, at)) throw new Error('기관 검색은 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('POST', '/shared-filters/copy', body, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub]) || !Array.isArray(snapshot.filters))
          throw new Error('응답을 확인할 수 없습니다. 개인 폴더를 다시 불러오세요.');
        if (!work.commit(at, () => { ++filterReadSequence; acceptFilterCollection(snapshot); })) throw staleAnswer();
        return snapshot;
      },
      restoreFocus(opener) {
        if (opener?.isConnected && !opener.disabled && !opener.closest('[hidden]')) opener.focus();
        else if (opener?.id === 'edit-active-filter') $('#clearfilter').focus();
        else if (opener?.dataset.name) focusFilterChip(opener.dataset.name);
        else $('#managefilters').focus();
      },
      async save(filter, signal, at = work.capture("document")) {
        // Capture the transport before the request: a later disconnect must never
        // turn a completed account save into browser-local preference data.
        const local = await filterWriteReady(signal, at);
        const saved = local ? filter : await api('POST', '/filters', filter, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (!work.commit(at, () => acceptSavedFilter(saved, local))) throw staleAnswer();
        if (!local) await reloadFolderSearches(at);
        return saved;
      },
      async remove(filter, signal, at = work.capture("document")) {
        const local = await filterWriteReady(signal, at);
        if (!local) await api('DELETE', `/filters/${filter.id}`, undefined, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        const next = userFilters.filter(f => f.name !== filter.name);
        if (!work.commit(at, () => {
          if (local) localStorage.setItem('kin-filters', JSON.stringify(next));
          userFilters = next; renderChips();
        })) throw staleAnswer();
        if (!local) await reloadFolderSearches(at);
      },
      async reload(signal, at = work.capture("document")) {
        const local = await filterWriteReady(signal, at);
        if (!local) {
          const p = await api('GET', '/prefs', undefined, signal, at);
          if (!work.admits(at)) throw staleAnswer();
          if (!Array.isArray(p?.filters)) throw new Error('저장 검색 목록을 불러오지 못했습니다. 다시 시도하세요.');
          if (!work.commit(at, () => { userFilters = validUserFilters(p.filters); renderChips(); })) throw staleAnswer();
        }
      },
    });
    $('#managefilters').addEventListener('click', () => savedFilterManager.open());
    $('#edit-active-filter').addEventListener('click', () => savedFilterManager.open({ name: activeFilterName }));
    function applyFilter(f, folderId) {
      if (!f || !Array.isArray(COLS[f.mode])) { toast('저장 검색의 업무 화면을 확인할 수 없습니다.', 'err'); return false; }
      const compoundError = KinCompoundFilter.validate(f.cols?.[KinCompoundFilter.KEY], COLS[f.mode]);
      if (compoundError) { toast('복합 조건을 적용하지 못했습니다: ' + compoundError, 'err'); return false; }
      activeFilterName = userFilters.some(saved => saved.name === f.name) ? f.name : null;
      const source = folderSearches().find(saved => saved.treeId === (f.treeId || 'own:' + f.id));
      folderAppliedSearch = source ? { id: source.treeId, name: source.name } : null;
      if (source) activeFilterName = source.name;
      $("#quick").value = f.quick ?? "";
      quickDays = savedFilterDays(f.days);
      document.querySelectorAll("#qf button").forEach(x => x.classList.toggle("on", +x.dataset.days === quickDays));
      Object.keys(fval).forEach(k => delete fval[k]);
      Object.assign(fval, f.cols ?? {});
      // setMode()가 정렬을 지우므로 모드를 먼저 바꾸고 정렬을 나중에 얹는다
      if (f.mode && f.mode !== mode) setMode(f.mode);
      /**
       * **저장된 정렬이 지금 모드에 있는 컬럼인지 확인한다.**
       *
       * setMode에는 이 검사가 있는데(`COLS[m].some(...)`), applyFilter는 그 **뒤에**
       * 값을 얹으므로 검사를 건너뛴다. Technician 모드에서 저장한 필터를 Radiology에
       * 적용하면 없는 컬럼으로 정렬이 걸리고, `a[sortKey]`가 전부 undefined라
       * 목록이 아무 순서로나 늘어선다 — 정렬이 걸린 줄도 모른 채.
       */
      const okSort = f.sortKey && COLS[mode].some(c => c.k === f.sortKey);
      sortKey = okSort ? f.sortKey : null;
      sortDir = okSort ? (f.sortDir ?? 0) : 0;
      worklistSearch?.apply();
      alignWorklistFolder(f, folderId || (f.cols?.modality ? undefined : source?.treeId));
      renderHeads(); render();
      return true;
    }

    /**
     * 서버에서 필터·상용구를 다시 받아온다.
     *
     * **응답을 검증한다.** 예전엔 `templates = p.templates`를 그대로 대입해서,
     * 한쪽이 빠진 응답 하나에 전역 `templates`가 `undefined`가 됐다.
     * 그 뒤로는 `renderTemplates()`가 매번 죽고 — 상용구 패널뿐 아니라
     * `refreshRight()`가 통째로 멈춰서 검사를 선택해도 오른쪽이 안 그려진다.
     * 한 번 깨지면 F5 전까지 안 돌아온다. 못 믿을 값은 안 받는 편이 낫다.
     */
    async function reloadPrefs(at = work.capture("document")) {
      if (!serverMode) return;
      const p = await api("GET", "/prefs", undefined, undefined, at);
      work.commit(at, () => {
        if (!Array.isArray(p?.filters) || !Array.isArray(p?.templates)) {
          toast("환경설정 응답이 올바르지 않아 이전 값을 유지합니다", "err");
          return;
        }
        userFilters = validUserFilters(p.filters); templates = p.templates;
        renderChips(); renderTemplates();
      });
      if (work.admits(at)) await reloadFolderSearches(at);
    }

    $("#savefilter").addEventListener("click", () => {
      const current = snapshotFilter();
      const error = KinCompoundFilter.validate(current.cols[KinCompoundFilter.KEY], COLS[current.mode]);
      if (error) { toast('복합 조건을 저장하지 못했습니다: ' + error, 'err'); return; }
      savedFilterManager.open();
    });

    $("#chips").addEventListener("click", e => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      applyFilter(userFilters[+b.dataset.i]);
    });

    // 우클릭에 바로 삭제를 걸어두면 손이 미끄러진 한 번으로 사라진다.
    // 되돌릴 수 없는 동작은 메뉴를 한 겹 두른다 (교훈 §5).
    function showFilterMenu(e, b) {
      e.preventDefault();
      const i = +b.dataset.i, f = userFilters[i];
      if (!f) return;
      b.focus();
      const rect = b.getBoundingClientRect();
      showCtx(e, [
        { label: "Apply", act: () => applyFilter(f) },
        { label: "Edit", act: () => editSavedFilter(f.name) },
        { label: f.isDefault ? "Clear Default" : "Set as Default", act: async () => {
            const on = !f.isDefault;
            if (on && (!Array.isArray(COLS[f.mode]) || KinCompoundFilter.validate(f.cols?.[KinCompoundFilter.KEY], COLS[f.mode]))) {
              toast('복합 조건 또는 업무 화면을 확인할 수 없어 기본 필터로 지정하지 못했습니다.', 'err'); return;
            }
            const at = work.capture("document");
            if (serverMode) {
              try { await api("PATCH", `/filters/${f.id}/default`, { on }, undefined, at); await reloadPrefs(at); }
              catch (err) { work.commit(at, () => toast("실패: " + err.message, "err")); return; }
            } else {
              userFilters.forEach(x => x.isDefault = false);
              f.isDefault = on; saveFiltersLocal(); renderChips();
            }
            work.commit(at, () => toast(on ? `"${f.name}" 을 기본 필터로 지정했습니다` : "기본 필터에서 해제했습니다"));
          } },
        { sep: 1 },
        { label: "Delete", act: async () => {
            if (!confirm(`필터 "${f.name}" 을(를) 삭제할까요?`)) return;
            const at = work.capture("document");
            if (serverMode) {
              try { await api("DELETE", `/filters/${f.id}`, undefined, undefined, at); await reloadPrefs(at); }
              catch (err) { work.commit(at, () => toast("삭제 실패: " + err.message, "err")); return; }
            } else {
              userFilters.splice(i, 1); saveFiltersLocal(); renderChips();
            }
            work.commit(at, () => toast("필터를 삭제했습니다", "info"));
          } },
      ], e.type === 'keydown' ? { x: rect.left, y: rect.bottom, focus: true } : null);
    }
    $("#chips").addEventListener("contextmenu", e => {
      const b = e.target.closest('button[data-i]'); if (b) showFilterMenu(e, b);
    });
    $("#chips").addEventListener("keydown", e => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      const b = e.target.closest('button[data-i]'); if (b) showFilterMenu(e, b);
    });
    renderChips();

    $("#clearfilter").addEventListener("click", () => {
      activeFilterName = null;
      folderAppliedSearch = null;
      favoriteList?.clear();studyTagList?.clear();consultationFilter=null;
      $("#quick").value = "";
      Object.keys(fval).forEach(k => delete fval[k]);
      quickDays = -1;
      document.querySelectorAll("#qf button").forEach(x => x.classList.toggle("on", x.dataset.days === "-1"));
      worklistSearch?.clear();
      alignWorklistFolder(null);
      renderHeads(); render();
    });


    $("#qf").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b || !b.dataset.days) return;
      document.querySelectorAll("#qf button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); quickDays = +b.dataset.days; worklistSearch?.change(); render();
    });

    $("#heads").addEventListener("click", e => {
      const th = e.target.closest("th"); if (!th) return;
      const key = th.dataset.key;
      if (sortKey !== key) { sortKey = key; sortDir = 1; }
      else if (sortDir === 1) sortDir = -1;
      else { sortKey = null; sortDir = 0; }
      render();
    });

    /**
     * 예전엔 RS 뱃지를 클릭하면 W→T→A로 돌았다. 걷어냈다.
     *
     * 그 경로는 `PATCH {rs}`를 쏘아 **판독문 확정을 통째로 우회**했다. 판(version)도
     * 안 쌓이고, 승인자도 안 남고, A→W에 사유도 안 물었다. 사유를 강제하고 폐기 초안까지
     * 남기게 만들어 놓은 Reset이 뱃지 한 번으로 무의미해졌다.
     * (RS가 P인 검사를 클릭하면 매핑에 없어서 `undefined`가 되기까지 했다)
     *
     * RS는 판독문의 생애주기다. Approve/Save/Reset 버튼으로만 움직인다.
     * 서버도 이제 PATCH로 rs를 받지 않는다.
     */
    $("#rows").addEventListener("click", e => {
      const tr = e.target.closest("tr");
      if (!tr?.dataset.uid) return;
      const uid = tr.dataset.uid;
      if (e.target.closest('[data-tech-note]')) { techNote.open(studies.find(s => s.uid === uid)); return; }
      select(uid, { openSelected: true });
      // select()의 render가 클릭한 행을 새 DOM으로 바꾸므로, 새 행에 초점을 다시 남긴다.
      $("#rows").querySelector(`tr[data-uid="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true });
    });
    $("#rows").addEventListener("keydown", e => {
      if (e.target.closest('[data-tech-note]')) return;
      if (e.key !== "Enter" || e.isComposing || mode !== "Radiology") return;
      const tr = e.target.closest("tr[data-uid]");
      if (!tr || tr.dataset.uid !== selectedUid) return;
      e.preventDefault();
      $("#findings").focus();
    });
    $("#rows").addEventListener("dblclick", e => {
      if (e.target.closest('[data-tech-note]')) return;
      const tr = e.target.closest("tr");
      if (tr?.dataset.uid) openFilmbox(tr.dataset.uid, autoPrior(tr.dataset.uid));
    });

    // ── 원격판독 의뢰 상태머신 (TS, 6.3.2) ──
    // none → wait → sending → sent → inReading → completed  (+ cancelled/fail)
    async function setTs(uid, ts, teleTo, at = work.capture("document")) {
      const s = studies.find(x => x.uid === uid);
      if (!s) return;
      if (serverMode) {
        // TS는 유일하게 기관을 넘는 상태다. 서버가 거절하면 화면도 되돌린다 —
        // 화면만 앞서 나가면 "보낸 줄 알았는데 안 갔다"가 된다.
        try {
          const st = await api("PATCH", `/studies/${encodeURIComponent(uid)}`,
            teleTo ? { ts, teleTo } : { ts }, undefined, at);
          // 같은 이유로 같은 규칙을 지난다. 이 타이머는 요청된 uid로 돌아오므로 그 검사가
          // 지금 고른 검사가 아닐 수 있다.
          work.commit(at, () => {
            appState[uid] = mergeObservedReportState(uid, st);
            syncStudy(uid); render();
          });
        } catch (e) { work.commit(at, () => toast("원격판독 상태 변경 실패: " + e.message, "err")); }
        return;
      }
      s.ts = ts;
      appState[uid] = { ...appState[uid], ts };
      saveApp(uid, { ts }); render();
    }

    /**
     * 원격판독 의뢰. 이제 "어디로 보내는가"를 반드시 고른다.
     *
     * 예전 시뮬은 혼자서 completed까지 굴러갔다. 기관이 생긴 지금은 그러면 안 된다 —
     * inReading·completed는 **받는 쪽**이 실제로 열고 판독해야 찍히는 상태다.
     * 보낸 쪽이 혼자 "완료"를 그리면 그건 워크플로가 아니라 애니메이션이다. (교훈 §10)
     */
    async function teleRequest(uid) {
      const others = institutions.filter(i => i.id !== myInstitution);
      if (!others.length) { toast("보낼 수 있는 다른 기관이 없습니다", "err"); return; }
      let target = others[0];
      if (others.length > 1) {
        const pick = prompt(
          "원격판독을 받을 기관 번호:\n" + others.map((i, n) => `${n + 1}. ${i.name}`).join("\n"), "1");
        const n = +pick;
        if (!n || !others[n - 1]) return;
        target = others[n - 1];
      } else if (!confirm(`${target.name} 에 원격판독을 의뢰할까요?`)) return;

      // 이 의뢰를 시작한 문맥. 뒤따르는 안내와 예약한 단계는 그것이 그대로일 때만 한다 — 로그아웃 준비·세션 종료 뒤의
      // 타이머가 다음 상태를 서버에 보내지 않는다.
      const at = work.capture("document");
      await setTs(uid, "wait", target.id, at);
      if (!work.commit(at, () => toast(`${target.name} 에 원격판독을 의뢰했습니다 — TS 열에서 진행 상태를 보세요`, "info"))) return;
      // 전송 파이프라인 시뮬레이션(우리 쪽 구간만). 실제 전송 큐는 5단계 Connect.
      setTimeout(() => work.commit(at, () => { if (tsIs(uid, "wait")) setTs(uid, "sending", undefined, at); }), 1200);
      setTimeout(() => work.commit(at, () => { if (tsIs(uid, "sending")) setTs(uid, "sent", undefined, at); }), 3500);
    }
    const tsIs = (uid, v) => (appState[uid]?.ts ?? "none") === v;

    // ══════════ 우클릭 컨텍스트 메뉴 (모드·대상에 따라 항목이 달라짐) ══════════
    const ctx = $("#ctx");
    let ctxItems = [];
    let ctxOpener = null;
    function showCtx(e, items, keyboard = null) {
      ctxOpener = document.activeElement;
      ctxItems = items;
      ctx.setAttribute('role', 'menu');
      ctx.innerHTML = items.map((it, i) =>
        it.sep ? '<hr role="separator">' : `<div data-i="${i}" role="menuitem" tabindex="-1" aria-disabled="${!!it.dis}" class="${it.dis ? "dis" : ""}">${esc(it.label)}</div>`).join("");
      ctx.style.left = Math.max(0, Math.min(keyboard?.x ?? e.clientX, innerWidth - 200)) + "px";
      ctx.style.top = Math.max(0, Math.min(keyboard?.y ?? e.clientY, innerHeight - (items.length * 28 + 20))) + "px";
      ctx.style.display = "block";
      if (keyboard?.focus) ctx.querySelector('[data-i]:not(.dis)')?.focus();
    }
    ctx.addEventListener('keydown', e => {
      const items = [...ctx.querySelectorAll('[data-i]:not(.dis)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation(); items[index]?.click();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        e.stopPropagation(); ctx.style.display = 'none'; ctxOpener?.focus();
      }
    });
    ctx.addEventListener("click", async e => {
      const d = e.target.closest("div[data-i]"); if (!d) return;
      const it = ctxItems[+d.dataset.i];
      if (it.dis) return;
      ctx.style.display = 'none';
      ctxOpener?.focus();
      /**
       * **`act()`를 await하고 catch한다.**
       *
       * 메뉴 항목의 절반이 async다(원격판독 의뢰, Match/Unmatch, 삭제…).
       * 예전엔 그냥 `it.act()`라 예외가 unhandled rejection으로 콘솔에만 남고
       * **사용자에게는 아무 반응도 없었다.** 눌렀는데 아무 일도 안 일어나면
       * 사람은 한 번 더 누른다 — 되돌릴 수 없는 항목에서는 그게 두 번 실행이다.
       */
      const at = work.capture("document");
      try { await it.act(); }
      // 항목이 기다리는 사이 작업 문맥이 바뀌었으면(로그아웃 준비·세션 종료) 그 실패는 알릴 실패가 아니다.
      catch (err) { work.commit(at, () => toast(`"${it.label}" 실패: ${err?.message ?? err}`, "err")); }
    });
    document.addEventListener("click", () => ctx.style.display = "none");

    $("#rows").addEventListener("contextmenu", e => {
      const tr = e.target.closest("tr");
      if (!tr?.dataset.uid) return;
      e.preventDefault();
      const uid = tr.dataset.uid;
      select(uid);
      const s = studies.find(x => x.uid === uid);
      const forceReleaseItems = KinAuth.has("admin") && s?.holder ? [{
        label: "점유 강제 해제 (관리자)", dis: s.holder === user, act: async () => {
          if (!confirm(`${displayActor(s.holder)} 님의 점유를 강제로 해제합니다. 그쪽 화면은 다음 저장에서 거절됩니다. 계속할까요?`)) return;
          const at = work.capture("document");
          try { await api("POST", `/studies/${encodeURIComponent(uid)}/release/force`, undefined, undefined, at); }
          catch (e) { work.commit(at, () => apiFail(e)); return; }
          work.commit(at, () => {
            s.holder = null;
            appState[uid] = { ...appState[uid], holder: null };
            render();
            if (uid === selectedUid) { updateReportButtons(); loadReport(); }
            toast("점유를 해제했습니다 (감사로그 기록)");
          });
        },
      }] : [];
      if (mode === "Radiology") {
        const ts = appState[uid]?.ts ?? "none";
        const requested = !["none", "cancelled", "fail"].includes(ts);
        // 받는 쪽(원격판독으로 넘어온 검사)과 보내는 쪽은 할 수 있는 일이 다르다.
        // 서버도 같은 규칙으로 막지만, 회색으로 보이는 편이 눌러보고 거절당하는 것보다 낫다.
        const mine = !s?.tele;
        showCtx(e, [
          { label: "Film Box 열기", act: () => openFilmbox(uid) },
          { label: "판독문 작성으로", act: () => $("#findings").focus() },
          { sep: 1 },
          { label: "원격판독 의뢰 (Tele Request)", dis: !mine || requested, act: () => teleRequest(uid) },
          { label: "의뢰 취소", dis: !mine || !["wait", "sending", "sent"].includes(ts), act: () => setTs(uid, "cancelled") },
          { sep: 1 },
          { label: "판독 시작 (수신 기관)", dis: mine || ts !== "sent", act: () => setTs(uid, "inReading") },
          ...forceReleaseItems,
        ]);
      } else {
        const o = curOrder();
        showCtx(e, [
          { label: "Match", dis: !(o && s.matched === "U" && o.matched === "U"), act: doMatch },
          { label: "Unmatch", dis: s.matched !== "M", act: doUnmatch },
          { sep: 1 },
          { label: "Verify", dis: s.ss === "Verified", act: () => setSs(uid, "Verified") },
          { label: "Unverify", dis: s.ss === "Unverified", act: () => setSs(uid, "Unverified") },
          { label: "Modify Exam", dis: s.rs !== "W", act: openModify },
          { sep: 1 },
          emergencyMenu(uid),
          { label: "Switch ReqHosp", act: () => {
              const v = prompt("의뢰 병원(ReqHosp):", s.reqHosp);
              if (v == null) return;
              s.reqHosp = v.trim() || "KIN";
              appState[uid] = { ...appState[uid], reqHosp: s.reqHosp };
              saveApp(uid, { reqHosp: s.reqHosp }); render(); renderRelated();
            } },
          { label: "Merge / Split Exam", dis: 1, act: () => {} },
          { sep: 1 },
          { label: "Delete", dis: s.rs !== "W", act: () => doDelete(uid) },
          ...forceReleaseItems,
        ]);
      }
    });

    $("#orderrows").addEventListener("contextmenu", e => {
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      e.preventDefault();
      selectedOid = tr.dataset.oid; renderOrders();
      const o = curOrder(), s = cur();
      showCtx(e, [
        { label: "Match", dis: !(s && s.matched === "U" && o.matched === "U"), act: doMatch },
        // selectedUid를 직접 대입하면 안 된다. select()가 하는 일 — 쓰던 판독문 저장,
        // 점유 해제, 오른쪽 판 갱신 — 이 전부 건너뛰어진다. 그 상태로 다음 검사를 고르면
        // **앞 환자의 소견이 뒤 환자에게 저장된다.** 실제로 그렇게 되는 코드였다.
        { label: "Unmatch", dis: o.matched !== "M", act: async () => {
            const s2 = studies.find(x => x.uid === o.studyUid);
            if (!s2) { toast("이 오더에 매칭된 검사를 목록에서 찾을 수 없습니다", "err"); return; }
            await select(s2.uid);
            doUnmatch();
          } },
        { sep: 1 },
        { label: "New Exam (SC 생성)", dis: 1, act: () => {} },
      ]);
    });

    $('#related-include-current').addEventListener('change',e=>{if(cur()){relatedIncludeCurrent=e.target.checked;renderRelated();}});
    $('#related-body-part').addEventListener('change',e=>{if(cur()){relatedBodyPart=e.target.value;renderRelated();}});
    $('#related-load-parts').addEventListener('click',()=>{if(cur()&&serverMode&&!offline&&!demoMode)relatedParts.load(relatedCandidates().map(x=>x.uid));});
    $('#related-cancel-parts').addEventListener('click',()=>relatedParts.cancel());
    $("#related-return").addEventListener("click", returnToReportStudy);
    $("#related-modality").addEventListener("change", e => {
      if (!cur()) return;
      // 목록을 좁히는 동작이 현재 영상/판독문을 다시 읽거나 점유를 옮겨서는 안 된다.
      relatedModality = e.target.value;
      renderRelated();
    });
    $("#relrows").addEventListener("click", e => {
      const open = e.target.closest('[data-related-open]');
      if (open) { openRelatedImages(open.dataset.relatedOpen); return; }
      const tr = e.target.closest("tr");
      if (tr?.dataset.uid) { if(tr.dataset.uid === selectedUid)returnToReportStudy();else previewRelated(tr.dataset.uid); }
    });
    $("#relrows").addEventListener("dblclick", e => {
      if (e.target.closest('button')) return;
      const tr = e.target.closest("tr");
      if (tr?.dataset.uid) openRelatedImages(tr.dataset.uid);
    });
    function openRelatedImages(uid) {
      if (!cur() || !relatedRows.some(row=>row.uid===uid)) return;
      if(uid===selectedUid)returnToReportStudy();else previewRelated(uid);
      openFilmbox(selectedUid,uid===selectedUid?null:uid);
    }

    // ══════════ 세션 종료 조정 (S7-U5) ══════════
    /**
     * 이 페이지의 세션이 끝났다 — Log out의 실제 종료, 요청의 답이 알려 준 세션 종료·결속 거절, 목록·폴링의 계정 변경,
     * 다른 문서의 종료. auth.js가 이 문서를 닫는 그 자리에서(네트워크를 기다리기 전에, 동기로) 관문이 알리고 아래 closeSession이
     * onCommonEnd로 등록한 종료 구독자를 부른다. 업무 화면을 닫는다: 목록·선택·폴링의 나간 답을 버리고, 점유 갱신과 자동
     * 저장을 멈추고(선택이 없으면 저장하지 않는다), 목록·판독문·신원 표시를 비운 뒤 닫힘 안내만 남긴다. 영역들은 같은 목록의
     * 자기 end()로 닫힌다. 다시 열지 않는다 — 다시 보내는 것은 랜딩의 Retry Log Out이다. 영역이 알아챈 계정 변경
     * ('account-changed')은 영역들이 잠그는 일이고 종료가 아니지만, 로그아웃 준비 중이면 인증 종료가 먼저라 목록·폴링의 계정
     * 변경처럼 종료를 시작한다 — 다른 계정으로 초안을 쓰지 않는다.
     */
    let workClosed = false;
    function closeWork(reason) {
      let preparing = !!logoutPrep && (logoutPrep.state === "saving" || logoutPrep.state === "failed");
      if (reason === "account-changed") {
        // 이 세션에 묶어 보낸 요청에 다른 계정의 답이 왔다고 영역이 알렸다. 준비 중이면 세션 교체로 닫는다.
        if (preparing) { const session = work.session(); queueMicrotask(() => KinAuth.replaced({ session })); }
        return;
      }
      /**
       * 준비 밖에서 세션이 끝났는데(서버가 알린 종료, 다른 문서의 Log out, 세션 교체) 저장을 확인하지 못한 글이 화면에 있다.
       * 그대로 닫으면 그 글이 사라진다 — 준비 중의 종료와 같게 이 문서의 메모리에 잡아 두고 Recover Draft를 보인다. 이
       * 문서가 스스로 끝내는 중(종료를 확정한 Log out·명시적 폐기)에는 잡을 것이 없다.
       */
      if (!workClosed && !preparing && (!logoutPrep || logoutPrep.state === "waiting") && !demoMode) {
        const capture = captureReport();
        if (capture.needsWrite) {
          logoutPrep = { state: "saving", reason: null, attempt: 0, panel: null, recovering: false, permit: null, id: null,
            ...(logoutPrep || {}), ...capture };
          loggingOut = preparing = true;
        }
      }
      // 준비 중에 세션이 끝났다. 원문은 이미 이 문서의 메모리에 있다 — 화면은 닫고 이동은 사람이 고를 때까지 미룬다.
      if (preparing) {
        logoutPrep.state = "ended";
        showLogoutPanel(logoutPrep);
      }
      if (workClosed) return;
      workClosed = true;
      closeSR();
      endPatientCopy();
      reportPreview.close();
      pollGeneration++;
      clearInterval(poll); poll = null;
      clearInterval(heartbeat); heartbeat = null;
      listLoadSequence++; commitEpoch++;
      markSelectionChanged(null);
      relatedUid = null; studies = [];
      worklistFolders?.destroy(); worklistFolders = null;
      folderLoadState = 'unknown'; folderAppliedSearch = null; filterCollection = null;
      sharedSearches = []; storedShortcuts = []; shortcutDraft = null; shortcutBusy = false; ++filterReadSequence; ++sharedFilterReadSequence;
      userFilters = []; activeFilterName = null;
      $('#chips')?.replaceChildren(); $('#worklist-folders')?.replaceChildren(); shortcutStatus('');
      // 닫는 화면을 비우는 대입이다(편집이 아니다; 확인되지 않은 글은 위에서 이미 잡았다) — `editReport` 밖의 두 대입 가운데 하나.
      for (const k of RFIELDS) $("#" + k).value = "";
      leftNotes.clear();
      for (const id of ["rows", "relrows", "user", "roles", "clinical", "thumbwrap", "ctx", "err", "leftnotes"]) $("#" + id)?.replaceChildren();
      document.querySelectorAll(".modal.show").forEach(modal => modal.classList.remove("show"));
      document.querySelectorAll("dialog[open]").forEach(dialog => { if (!dialog.classList.contains("kin-logout")) dialog.close(); });
      document.documentElement.classList.add("kin-closed");
      if (logoutPrep?.state === "ended") return;
      const note = document.createElement("p");
      note.className = "kin-closed-note";
      note.setAttribute("role", "status");
      note.textContent = "세션을 닫았습니다. 로그인 화면으로 이동하는 중입니다…";
      document.body.append(note);
    }
    onCommonEnd(closeWork);
    /**
     * 이 문서의 세션이 끝난 그 자리. 관문이 업무를 닫는 전이(active·preparing 밖으로)를 알리면 공통 종료 목록과 이 페이지가
     * 등록한 영역의 end()를 한 번 부른다. 어느 로그인의 종료인지는 auth.js가 이미 대조했다 — 다른 세션의 통지나 이전 요청의
     * 늦은 401은 여기에 오지 않는다.
     */
    let sessionClosed = false;
    function closeSession() {
      if (sessionClosed) return;
      sessionClosed = true;
      for (const end of sessionEndHooks.splice(0)) { try { end(); } catch (_) {} }
    }
    work.onInvalidate(event => {
      if (event.reason === "lifecycle" && event.state !== "active" && event.state !== "preparing") closeSession();
    });
    // 다른 곳에서 끝난 종료(다른 문서의 종료, 요청의 답이 알려 준 종료)는 새 POST 없이 이 문서를 떠난다. 화면은 위에서 이미
    // 닫혔다. 저장을 확인하지 못한 판독문이 남아 있으면 떠나지 않는다(아래 holdLeave).
    KinAuth.onEndedElsewhere(() => KinAuth.leave());
    // 이 문서가 시작하는 종료는 POST 앞에 내 점유를 푼다(서버는 남의 점유를 건드리지 않는다).
    KinAuth.beforeLogoutPost(() => releaseHold({ closing: true }));
    // 저장을 확인하지 못한 판독문이 메모리에 있는 동안에는 종료 뒤에도 이 문서를 떠나지 않는다.
    KinAuth.holdLeave(() => !!logoutPrep && ["saving", "failed", "ended"].includes(logoutPrep.state));


    // ══════════ 시작 ══════════
    // 서버가 살아 있으면 서버 상태로 시작하고, 죽어 있으면 localStorage로 계속 굴러간다.
    // 서버 없이도 앱이 열려야 GitHub Pages 데모와 오프라인 작업이 가능하다.
    // 역할에 따라 화면을 잠근다. 서버가 어차피 막지만, 눌러보고 거절당하는 것보다
    // 처음부터 회색인 편이 낫다. (서버 검사가 진짜 방어선이고 이건 안내다)
    function applyRoleUi() {
      const rad = KinAuth.has("radiologist"), tec = KinAuth.has("technician");
      // Clear·Paste도 판독문을 고치는 버튼이다. 목록에서 빠져 있어서 기사에게도 열려 있었다.
      ["#b-approve", "#b-save", "#b-transcribe", "#b-unread", "#b-addendum", "#b-defer",
       "#b-clear", "#b-paste"].forEach(s => {
        const el = $(s); if (!el) return;
        el.disabled = !rad;
        if (!rad) el.title = "판독의(radiologist) 권한이 필요합니다";
      });
      ["#findings", "#conclusion", "#recommendation"].forEach(s => $(s).readOnly = !rad);
      ["#t-verify", "#t-unverify", "#t-modify"].forEach(s => {
        const el = $(s); el.disabled = !tec;
        if (!tec) el.title = "방사선사(technician) 권한이 필요합니다";
      });
      const r = sess.demo ? "데모" : (sess.roles.filter(x => ["radiologist","technician","admin"].includes(x)).join(", ") || "권한 없음");
      $("#roles").textContent = r;
      $("#member-link").style.display = !sess.demo && KinAuth.has("admin") ? "" : "none";
    }

    /**
     * 부트스트랩을 몇 번 더 시도한다.
     *
     * 예전엔 한 번 실패하면 그대로 로컬 모드였다 — 네트워크 blip 하나, 컨테이너가
     * 재시작하는 3초, 늦게 뜬 API. 한 번의 딸꾹질로 하루 종일 모드가 바뀌었고
     * 돌아올 방법도 없었다. **일시적 실패와 진짜 고장은 다르게 다뤄야 한다.**
     *
     * 인증 실패와 무효가 된 문맥(세션 종료·로그아웃 준비)은 다시 시도할 일이 아니다 — 인증 실패는 전송이 이미 넘겼다.
     */
    async function fetchBootstrap(at, tries = 3) {
      let last;
      for (let i = 0; i < tries; i++) {
        try { return await api("GET", "/bootstrap?states=omit", undefined, undefined, at); }
        catch (e) {
          last = e;
          if (e.auth || e.name === "AbortError") throw e;
          if (i < tries - 1) await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
        }
      }
      throw last;
    }

    // 판독 기록에는 안정적인 이메일 식별자가 남는다. 화면에서만 Keycloak 성명으로 바꾼다.
    async function loadActorNames(at = work.capture("document")) {
      if (!serverMode) return;
      try {
        const peers = await api("GET", "/colleagues", undefined, undefined, at);
        work.commit(at, () => peers.forEach(p => rememberActor(p.id, p.name, p.username)));
      } catch (e) { /* 이름 조회가 실패해도 이메일 표시는 유지한다. */ }
    }

    /** 서버가 살아 있을 때. 재연결에서도 다시 불리므로 누적되는 조작을 하지 않는다. */
    function goOnline(b) {
      serverMode = true; offline = false;
      $('#consultations-open').disabled=!!demoMode;consultations.refresh();
      stopReconnect();
      for (const [uid, state] of Object.entries(b.states ?? {})) appState[uid] = mergeObservedReportState(uid, state);
      orders = b.orders;
      myInstitution = b.me?.institution ?? null;
      myInstitutionName = b.me?.institutionName ?? "";
      institutions = b.institutions ?? [];
      // 서버가 말한 받아쓰기 가능 여부. 모양이 다르거나 없으면 쓸 수 없는 것으로 본다.
      dictation.setServerCapability(b.dictation);
      /**
       * 필터·상용구는 이제 계정에 있다. 이 브라우저에 뭐가 남아 있든 서버가 진실이다.
       *
       * 예전엔 `if (b.filters)` 였다 — 서버가 안 주면 **앞사람의 로컬 필터가 그대로
       * 살아남았다.** 공용 판독 PC에서 남의 칩이 내 화면에 보이는 것이고,
       * 그걸 눌러 저장하면 남의 필터 이름으로 내 화면이 만들어진다.
       * 계정에 붙인다고 해놓고 브라우저에 남은 것을 안 지우면 반쪽이다.
       */
      userFilters = validUserFilters(b.filters);
      mountWorklistFolders();
      void reloadFolderSearches();
      templates = Array.isArray(b.templates) ? b.templates : [];
      try { localStorage.removeItem("kin-filters"); localStorage.removeItem("kin-templates"); } catch (e) {}
      renderChips(); renderTemplates();
      $("#dbstat").innerHTML = `<span style="color:#4ac06a">●</span> DB Connected`;
      $("#dbstat").title = `상태·판독문이 서버(${API})에 저장됩니다 — 브라우저를 바꿔도 유지됩니다`;
      // 어느 기관으로 로그인했는지 항상 보이게. 두 기관을 오가며 시험할 때
      // "지금 누구로 보고 있는지"를 모르면 필터가 되는지 안 되는지도 알 수 없다.
      // `roleText`를 기준으로 다시 쓴다 — 재연결마다 앞에 덧붙으면 줄이 길어진다.
      $("#roles").textContent = `${myInstitutionName} · ${roleText}`;
      // 미배정 통로는 관리자에게만. 평소엔 0건이라 숨어 있어야 맞다.
      $("#m-unassigned").style.display = KinAuth.has("admin") ? "" : "none";
      startPolling();
      // 연결이 되살아났다: 앞서 실패해 멈춘 검사도 한 번 다시 보낸다(같은 거절이면 한 번 알리고 다시 멈춘다).
      reportSaveFailures.clear();
      reconcileReportDrafts();
    }

    /**
     * 로그인은 했는데 서버에 못 닿는다. **폴백이 아니라 고장으로 다룬다.**
     * 쓰기를 막고, 빨간 표시를 띄우고, 뒤에서 계속 다시 두드린다.
     */
    function goOffline(e) {
      reportPreview.close();
      serverMode = false; offline = true;
      folderLoadState = 'unknown'; filterCollection = null; ++filterReadSequence; ++sharedFilterReadSequence;
      updateWorklistFolders(); shortcutStatus('서버에 연결한 뒤 바로가기를 불러오세요.');
      // 녹음 중이던 받아쓰기는 여기서 멈춘다(보낼 곳이 없다). 받아 둔 글은 Insert가 거절한다.
      dictation.refresh();
      worklistBodyParts.sync(studies);
      $('#consultations-open').disabled=true;consultations.refresh();
      clearInterval(poll); poll = null; ++pollGeneration;
      $("#dbstat").innerHTML = `<span style="color:#ff6b6b">●</span> 서버 연결 끊김 — 저장 불가 (클릭: 재시도)`;
      $("#dbstat").title = `API에 연결하지 못했습니다 (${e?.message ?? ""}).\n` +
        `이 상태에서는 아무것도 저장되지 않습니다. 쓰던 판독문은 복사해 두세요.\n` +
        `docker compose up -d 로 API를 띄우면 자동으로 다시 붙습니다.`;
      $("#dbstat").style.cursor = "pointer";
      toast("서버 연결이 끊겼습니다 — 지금부터 저장되지 않습니다. 쓰던 판독문은 복사해 두세요.", "err");
      startReconnect();
    }

    /**
     * 재연결 시도. 서버가 돌아오면 스스로 붙는다.
     * 예전엔 복구 감지가 아예 없어서, API가 살아나도 사용자가 F5를 눌러야만 알았다.
     */
    let reconnectTimer = null;
    function stopReconnect() { clearInterval(reconnectTimer); reconnectTimer = null; $("#dbstat").style.cursor = ""; }
    function startReconnect() {
      if (reconnectTimer) return;
      reconnectTimer = setInterval(async () => {
        if (!offline) { stopReconnect(); return; }
        // 회차마다 그때의 문맥으로 지난다: 로그아웃 준비 중에는 두드리지 않고, 답은 그 문맥이 그대로일 때만 연결을 되살린다.
        const at = work.capture("document");
        if (!work.admits(at)) return;
        try {
          const b = await api("GET", "/bootstrap", undefined, undefined, at);
          if (!work.commit(at, () => goOnline(b))) return;
          await loadActorNames(at);
          await load();
          work.commit(at, () => toast("서버에 다시 연결됐습니다 — 저장이 가능합니다", "ok"));
        } catch (e) { /* 다음 회차에 다시 */ }
      }, 15000);
    }
    $("#dbstat").addEventListener("click", async () => {
      if (!offline) return;
      const at = work.capture("document");
      try {
        const b = await api("GET", "/bootstrap", undefined, undefined, at);
        if (!work.commit(at, () => goOnline(b))) return;
        await loadActorNames(at); await load();
        work.commit(at, () => toast("서버에 다시 연결됐습니다", "ok"));
      }
      catch (e) { work.commit(at, () => toast("아직 연결되지 않습니다: " + e.message, "err")); }
    });

    /** applyRoleUi가 만든 원본 역할 문자열. 기관 이름을 덧붙이는 기준점이다. */
    let roleText = "";

    /**
     * 미배정 검사 목록 (관리자).
     *
     * 기관을 못 알아본 검사는 어느 워크리스트에도 안 뜬다. 그건 의도한 설계지만,
     * **보이는 곳이 하나도 없으면 영영 고아로 남는다.** 장비 태그 오타 하나로
     * 영상이 들어와 있는데 아무도 모르고, 아무도 모르니 아무도 안 고친다.
     */
    async function showUnassigned() {
      const box = $("#un-body");
      $("#unmodal").classList.add("show");
      box.innerHTML = "<div style='color:#667;padding:10px'>불러오는 중…</div>";
      const at = work.capture("document");
      try {
        const r = await api("GET", "/unassigned", undefined, undefined, at);
        if (!work.admits(at)) return;
        if (!r.studies.length) {
          box.innerHTML = "<div style='color:#4ac06a;padding:10px'>미배정 검사가 없습니다.</div>";
          return;
        }
        const opts = r.institutions.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("");
        box.innerHTML = r.studies.map(s => `
          <div class="ver">
            <div class="vh">
              <b>${esc(s.name || "(이름 없음)")}</b>
              <span>${esc(s.id)}</span>
              <span style="color:#667">${esc(fmtD(s.date))} · ${esc(s.desc)}</span>
            </div>
            <div class="vr">DICOM 기관명: ${s.dicomInstitution ? `"${esc(s.dicomInstitution)}"` : "(비어 있음)"}</div>
            <div style="display:flex;gap:6px;align-items:center;padding:4px 0">
              <select data-uid="${esc(s.uid)}" class="un-sel"
                      style="background:#14181f;color:#cdd3dc;border:1px solid #3a4356;padding:3px 6px;font:inherit">${opts}</select>
              <button class="un-go" data-uid="${esc(s.uid)}"
                      style="background:#3b6ea5;color:#fff;border:1px solid #3b6ea5;padding:3px 12px;border-radius:3px;cursor:pointer;font-size:11px">배정</button>
            </div>
          </div>`).join("");
      } catch (e) {
        work.commit(at, () => { box.innerHTML = `<div style="color:#ff8080;padding:10px">${esc(e.message)}</div>`; });
      }
    }
    $("#un-body").addEventListener("click", async e => {
      const btn = e.target.closest(".un-go"); if (!btn) return;
      const uid = btn.dataset.uid;
      const sel = $(`.un-sel[data-uid="${CSS.escape(uid)}"]`);
      const name = sel.options[sel.selectedIndex].textContent;
      if (!confirm(`이 검사를 "${name}"에 배정합니다.\n배정하면 그 기관의 워크리스트에 나타납니다. 계속할까요?`)) return;
      btn.disabled = true;
      const at = work.capture("document");
      try {
        await api("POST", `/studies/${encodeURIComponent(uid)}/assign`, { institutionId: sel.value }, undefined, at);
        if (!work.commit(at, () => toast(`"${name}"에 배정했습니다`, "ok"))) return;
        await showUnassigned();
        await load();
      } catch (err) {
        // 이 배정이 잠근 단추는 이 배정이 푼다(자기 것만).
        btn.disabled = false;
        work.commit(at, () => toast("배정 실패: " + err.message, "err"));
      }
    });
    $("#m-unassigned").addEventListener("click", showUnassigned);
    $("#un-close").addEventListener("click", () => $("#unmodal").classList.remove("show"));

    // 세션 상세(S5-UI1): 헤더의 #user·#roles는 한 줄로 말줄임될 수 있다. 전체 문구를 단추의 툴팁과 Session details에
    // 옮겨 적는다. 두 칸을 쓰는 곳이 셋(boot·applyRoleUi·goOnline)이라 그 자리마다 부르지 않고 글자가 바뀔 때 따라 적는다 —
    // 쓰는 곳이 늘어도 상세가 옛 문구로 남지 않는다. 여는 순간에도 한 번 더 맞춘다.
    (() => {
      const user = document.getElementById("user"), roles = document.getElementById("roles");
      const who = document.getElementById("session-who"), details = document.getElementById("session-details");
      const sync = () => {
        document.getElementById("session-details-user").textContent = user.textContent;
        document.getElementById("session-details-roles").textContent = roles.textContent;
        who.title = [user.textContent, roles.textContent].filter(Boolean).join("\n");
      };
      const observer = new MutationObserver(sync);
      for (const el of [user, roles]) observer.observe(el, { childList: true, characterData: true, subtree: true });
      details.addEventListener("beforetoggle", sync);
      sync();
    })();

    function showMembershipState(state) {
      const pending = state === "pending";
      document.title = pending ? "관리자 승인 대기 — KIN" : "계정 설정 확인 — KIN";
      const panel = document.createElement("main");
      panel.style.cssText = "min-height:100vh;display:grid;place-items:center;background:#07101d;color:#eef4ff;font-family:system-ui,sans-serif;padding:24px";
      const card = document.createElement("section");
      card.style.cssText = "width:min(520px,100%);background:#111d2d;border:1px solid #29405d;border-radius:14px;padding:34px;box-shadow:0 18px 60px #0008";
      const brand = document.createElement("div");
      brand.textContent = "KOREA IMAGING NETWORK";
      brand.style.cssText = "font-size:12px;letter-spacing:.18em;color:#75a9dc;margin-bottom:18px";
      const title = document.createElement("h1");
      title.textContent = pending ? "관리자 승인 대기" : "계정 설정 확인 필요";
      title.style.cssText = "font-size:24px;margin:0 0 14px";
      const message = document.createElement("p");
      message.textContent = pending
        ? "가입 신청이 접수되었습니다. 관리자가 기관과 역할을 확인한 뒤 사용할 수 있습니다."
        : "기관 또는 업무 역할 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.";
      message.style.cssText = "line-height:1.7;color:#c8d5e6;margin:0 0 24px";
      const logout = document.createElement("button");
      logout.textContent = "로그아웃";
      logout.style.cssText = "border:0;border-radius:8px;background:#2b78c5;color:white;padding:11px 20px;cursor:pointer";
      logout.addEventListener("click", () => KinAuth.logout());
      card.append(brand, title, message, logout);
      panel.append(card);
      document.body.replaceChildren(panel);
    }

    async function boot() {
      try {
        await KinAuth.init({ retry: true, onRetry: () => {
          work.commit(work.capture("lifecycle"), () => {
            $("#err").textContent = "세션을 다시 확인하고 있습니다. 확인되면 자동으로 들어갑니다…";
          });
        }, onHold: text => {
          // 다른 창의 로그아웃 준비가 살아 있는 동안 이 탭은 그 결과를 기다린다(A017) — 그동안의 안내 한 줄.
          work.commit(work.capture("lifecycle"), () => { $("#err").textContent = text ?? ""; });
        } });
        if (KinAuth.session()) work.commit(work.capture("document"), () => $("#err").replaceChildren());
      }
      catch {
        work.commit(work.capture("lifecycle"), () => {
          $("#err").textContent = "세션을 확인하지 못했습니다. 잠시 뒤 다시 확인해 주세요. ";
          const retry = document.createElement("button");
          retry.textContent = "Retry Session Check";
          retry.addEventListener("click", () => { retry.disabled = true; boot(); });
          $("#err").append(retry);
        });
        return;
      }
      sess = KinAuth.session();
      if (!sess) {
        // 평소의 진입(종료 기록이 없고 저장소를 믿을 수 있다)에서 세션이 없으면 로그인 화면으로 바로 보낸다 — 로그인 단추를
        // 한 번 더 누르게 하지 않는다. 그 밖(종료 기록, 믿을 수 없는 저장소, 진입 확인 실패)은 랜딩이 사정을 보인다.
        if (!KinAuth.autoLogin()) location.replace("index.html");
        return;
      }
      if (sess.state === "pending" || sess.state === "invalid") {
        showMembershipState(sess.state);
        return;
      }
      user = sess.user ?? "";
      if (!sess.demo && typeof sess.sub === "string")
        draftOwner = Object.freeze({ institution: sess.institution ?? null, sub: sess.sub, author: sess.actor });
      userDisplayName = sess.displayName || user;
      $("#user").textContent = userDisplayName;
      rememberActor(user, userDisplayName, user.split("@")[0]);
      columnPrefs = KinWorklistColumns.mount({ columns: COLS, session: sess, mode: () => mode,
        changed: () => { renderHeads(); render(); renderRelated(); } });
      renderHeads();
      renderTemplates();
      applyRoleUi();
      if (!sess.demo) userFilters = [];
      mountWorklistFolders();
      $('#consultations-open').hidden=!(KinAuth.has('radiologist')||KinAuth.has('admin'));
      imageOpening = KinViewerOpening.mount({ button: $('#image-opening-open'), session: () => KinAuth.session() });
      try {
        worklistStartup = KinWorklistStartup.mount({host:$('#image-opening-dialog'),
          owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key&&key.slice(KinViewerOpening.PREFIX.length);},
          current:()=>selectedUid,rows:orderedStudies,select:uid=>select(uid,{deferViewer:true}),
          allowed:()=>serverMode&&!offline&&!demoMode});
      } catch (_) { toast('시작 선택 설정을 불러오지 못해 자동 선택을 껐습니다.', 'err'); }

      worklistRefresh = KinWorklistRefresh.mount({select:$('#worklist-refresh'),status:$('#worklist-refresh-status'),
        owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key&&key.slice(KinViewerOpening.PREFIX.length);},
        changed:()=>startPolling()});
      worklistAlerts = KinWorklistAlerts.mount({button:$('#worklist-alerts-open'),owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key&&key.slice(KinViewerOpening.PREFIX.length);},refresh:()=>load(),available:()=>serverMode&&!offline});
      KinStudyAccessStatus.mount({button:$('#study-access-open'),session:()=>KinAuth.session(),refresh:async()=>(await load())===true});
      multiSelection = KinWorklistSelection.mount({host:$('#worklist-selection'),tbody:$('#rows'),owner:()=>KinViewerOpening.key(KinAuth.session()),rows:orderedStudies,current:()=>selectedUid,open:uid=>select(uid,{openSelected:true}),compare:(uid,prior)=>openFilmbox(uid,prior)});
      imagePreview = KinWorklistImagePreview.mount({owner:()=>KinViewerOpening.key(KinAuth.session()),currentUid:viewingUid,api});
      imageThumbnails = window.KinWorklistImageThumbnails?.mount?.({host:$('#thumbwrap'),owner:()=>KinViewerOpening.key(KinAuth.session()),currentUid:viewingUid,api,
        onPreview:value=>imagePreview?.open(value),onBack:()=>renderThumbs()}) || null;
      worklistSearch = KinWorklistSearch.mount({host:document.querySelector('.userfilter'),owner:()=>KinViewerOpening.key(KinAuth.session()),snapshot:searchCriteria,render});
      rowNavigation = KinWorklistRowNavigation.mount({tbody:$('#rows'),owner:()=>KinViewerOpening.key(KinAuth.session()),rows:orderedStudies,
        current:()=>selectedUid,reveal:uid=>render(uid),activate:uid=>{select(uid);if(mode==='Radiology')$('#findings').focus();}});
      relatedRowNavigation = KinWorklistRowNavigation.mount({tbody:$('#relrows'),owner:()=>KinViewerOpening.key(KinAuth.session()),rows:()=>relatedRows,
        current:()=>relatedUid||selectedUid,fallback:()=>$('#related-modality').disabled?$('#related-current'):$('#related-modality'),
        reveal:uid=>{const index=relatedRows.findIndex(row=>row.uid===uid);if(index>=0){relatedPage=Math.floor(index/50);renderRelated();}},
        activate:uid=>uid===selectedUid?returnToReportStudy():previewRelated(uid)});
      mountViewerWindows();
      restoreWorkspace();
      // Optional display controls must not prevent loading clinical work.
      try {
        const appearance=KinReadingAppearance({getMpr:()=>{try{return $('#reading-frame')?.contentWindow?.kinMprPreferences||null;}catch(_){return null;}},getToolbar:()=>{try{return $('#reading-frame')?.contentWindow?.kinViewerToolbarPreferences||null;}catch(_){return null;}},getDock:()=>{try{const dock=$('#reading-frame')?.contentWindow?.document.getElementById('kin-workspace-dock');return dock&&dock.preference()!==null?dock:null;}catch(_){return null;}},owner:()=>{
          const key=KinWorkspaceLayout.key(KinAuth.session());
          return key?key.slice(KinWorkspaceLayout.PREFIX.length):null;
        }});
        window.KinReadingAppearanceAccount?.({...appearance,owner:workspaceOwner?[sess.institution,sess.sub]:null,
          endpoint:API+'/reading-appearance',sessionEndpoint:API+'/me'});
      } catch (_) {
        $('#reading-appearance-open').disabled=true;
        $('#reading-appearance-open').title='글자 크기 설정을 불러오지 못했습니다. 판독 작업은 계속할 수 있습니다.';
      }
      KinReadingPreferences({ ...readingWorkspace.preferences,
        owner: workspaceOwner ? [sess.institution, sess.sub] : null,
        endpoint: API + '/reading-preferences', sessionEndpoint: API + '/me' });
      KinWorkspaceRoaming.mount({
        owner: workspaceOwner ? [sess.institution, sess.sub] : null,
        // A reset or legacy local record still comes from a client that can
        // preserve reading panels; never serialize it as an older v1 writer.
        read: () => KinWorkspaceLayout.withReading(workspaceState, readingWorkspace.snapshotPanels()),
        generation: () => workspaceGeneration,
        model: KinWorkspaceLayout, endpoint: API + '/workspace-layout', sessionEndpoint: API + '/me',
        localKept: () => workspaceLocalKept,
        apply: state => {
          state = KinWorkspaceLayout.mergeLoaded(workspaceState, state);
          if (!state) return false;
          workspaceGeneration++; workspaceState = state; layoutMode = state.mode; applyLayout();
          if (state.reading) readingWorkspace.applyPanels(state.reading);
          const saved = KinWorkspaceLayout.write(workspaceStorage, workspaceOwner, state);
          workspaceLocalKept = !!saved;
          $("#layout-status").textContent = saved ? "배치 복원됨 · 이 브라우저" : "배치 · 이 창에서만 유지";
          return saved;
        },
      });
      roleText = $("#roles").textContent;
      if (sess.demo) {
        serverMode = false; offline = false;
        Object.assign(appState, legacyAppState);
        $("#dbstat").innerHTML = `<span style="color:#7f8899">●</span> 데모 모드`;
        $("#dbstat").title = "로그인하지 않은 둘러보기 모드 — 변경 내용은 이 브라우저에만 남습니다";
        await load();
        return;
      }
      // 부팅의 남은 읽기는 이 세션의 문맥으로 나간다. 기다리는 사이 세션이 끝났으면(다른 문서의 종료, 첫 요청의 401) 그 답도
      // 실패도 화면에 쓰지 않는다 — 닫힌 화면은 종료 조정이 맡는다.
      const at = work.capture("document");
      try {
        const b = await fetchBootstrap(at);
        if (!work.admits(at)) return;
        /**
         * **이 브라우저에 남아 있던 로컬 작업 기록을 말없이 버리지 않는다.**
         *
         * `appState = b.states` 한 줄이 예전 로컬 모드에서 한 일 전부를 지웠다.
         * 경고도, 무엇이 사라지는지도 없었다. 이제 서버 것이 이기되(그건 맞다),
         * 버리기 전에 날짜를 붙여 따로 떼어두고 알려준다.
         */
        const localKeys = Object.keys(legacyAppState ?? {});
        if (localKeys.length) {
          const key = `kin-app-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
          try { localStorage.setItem(key, JSON.stringify(legacyAppState)); } catch (e) {}
          localStorage.removeItem("kin-app");
          toast(`이 브라우저에 남아 있던 기록 ${localKeys.length}건은 서버 데이터로 대체됩니다 ` +
                `(localStorage의 ${key}에 보관)`, "info");
        }
        goOnline(b);
        // No await between starting polling and establishing the default: even
        // Refresh during a delayed colleague lookup must keep the search scope.
        const def = userFilters.find(f => f.isDefault);
        if (def) {
          if (applyFilter(def)) toast(`기본 필터 "${def.name}" 적용됨 — Clear를 누르면 풀립니다`, "info");
          else {
            fval[KinCompoundFilter.KEY] = null;
            render();
            toast('기본 검색 오류(업무 화면·복합 조건)로 목록을 숨겼습니다. 다른 저장 검색을 적용하거나 Clear로 해제하세요.', 'err');
          }
        }
        await loadActorNames(at);
      } catch (e) {
        if (!work.admits(at)) return;
        goOffline(e);
      }
      await load();
    }
    boot();
  
