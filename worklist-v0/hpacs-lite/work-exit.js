

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