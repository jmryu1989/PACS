

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