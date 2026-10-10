

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