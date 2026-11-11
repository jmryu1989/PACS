

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

    /**
     * FC-040 진행 중 판독 되돌리기의 답(`released`)을 사람의 말로. 서버는 남의 글 내용이 아니라 **있다는 사실만** 보낸다.
     * 점유자(holder)와 저장 글을 쓴 사람(savedBy)은 다른 사람일 수 있어 섞지 않는다. `savedKept`는 그 저장 글을 쓴 사람의
     * 개인 임시글로 옮겼는가다(그 사람에게 살아 있는 임시글이 이미 있으면 옮기지 않고 이력에만 남는다).
     */
    function releasedText(r) {
      const parts = [];
      // 점유자가 곧 저장 글을 쓴 사람이고 임시글이 있으면 아래 저장 글 문장이 같은 사실을 말한다.
      if (r.holder && r.holderDraft && r.holder !== r.savedBy) {
        const who = displayActor(r.holder);
        parts.push(`${who} 선생님이 쓰던 글이 있습니다 — 그 글은 ${who} 선생님의 개인 임시글로 남아 있습니다.`);
      }
      if (r.savedBy) {
        const who = displayActor(r.savedBy);
        parts.push(r.savedKept ? `${who} 선생님이 저장해 둔 글은 ${who} 선생님의 개인 임시글로 옮겼습니다.`
          : `${who} 선생님의 개인 임시글은 그대로 두었고, 저장해 둔 글은 이력(History)에 남겼습니다.`);
      }
      return parts.length ? parts.join(" ") + " 판독 상태를 Unread로 되돌렸습니다."
        : `${displayActor(r.holder)} 님의 판독 점유를 풀고 Unread로 되돌렸습니다.`;
    }

    /** 받아들여진 확정의 완료 안내. `lateText`는 그 확정이 싣지 않은, 누른 뒤에 친 글이 남았다는 뜻이다. */
    function announceCommit(uid, action, reason, lateText, released = null) {
      const done = action === "reset" && released ? releasedText(released) : {
        save: "임시 저장했습니다 (RS: T)",
        defer: `보류했습니다 (RS: H)${reason ? ' — ' + reason : ''}`,
        approve: "판독문을 승인했습니다 (RS: A)",
        amend: "수정한 판독문을 다시 승인했습니다 — 이전 승인본은 이력에 남습니다",
        addendum: "추가기재를 저장했습니다 — 이전 승인본은 그대로 남습니다",
        reset: "판독을 취소했습니다 (RS: W). 사유가 이력에 기록됐습니다",
        preliminary: "예비 판독으로 넘겼습니다 (RS: P) — 지정한 상급 판독의만 내용을 볼 수 있습니다",
      }[action];
      if (!lateText) { toast(done, action === "reset" ? "info" : "ok", released ? 9000 : undefined); return; }
      /**
       * 확정은 됐고, 그 확정이 싣지 않은 글이 화면에 남았다. "승인했습니다"만 말하면 판독의는 마지막에 친 문장도 승인된
       * 줄 안다(U5CLI-F11). 무엇이 들어가지 않았는지를 같은 안내에서 말한다 — 실패가 아니므로 오류 색을 쓰지 않고, 읽을
       * 시간을 준다. 그 뒤로는 초안 표시줄이 같은 사실을 계속 말한다. 그 검사를 떠나 있었으면 어느 검사인지부터 말한다
       * (로그아웃 창과 같은 표기).
       */
      const missed = action === "approve" || action === "amend" ? "Approve를 누른 뒤 입력한 글은 승인된 판독문에 포함되지 않았습니다"
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
      if (sent.batch) return readBatchCommitOutcome(uid, sent, at, session);
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
      // WORKLIST-SPLIT-UID: no decision of any kind is sent for a study the last list excluded as unresolved; the text stays.
      if (appState[selectedUid]?.identityUnresolved) {
        toast("환자 식별 불일치로 이 검사를 사용할 수 없습니다. 원본 확인이 필요합니다. 입력한 글은 화면에 그대로 있습니다.", "err");
        return;
      }
      // W5: every decision waits for Back in Related Report mode, and for the receipt of an unsettled Related insert.
      const related = relatedCommandBlock(action);
      if (related) { toast(related, "err"); relatedInsertNotice(selectedUid); return; }
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
        // W5: the mode or an Insert may have started while that read was out; the decision is checked again before it leaves.
        if (relatedCommandBlock(action)) return;
      }
      if(studyPriority?.get(selectedUid)){toast('응급 상태를 확인한 뒤 판독을 저장하세요. 저장 결과 미확인은 Technician 메뉴의 Refresh Status로 확인할 수 있습니다.','err');return;}
      // 서버가 죽었는데 로컬에 확정을 쌓으면, 그건 확정이 아니라 이 브라우저의 메모다.
      if (offline) {
        toast("서버 연결이 끊겨 저장할 수 없습니다. 쓰던 내용을 복사해 두고 연결을 기다리세요.", "err");
        return;
      }
      /**
       * FC-034: 승인본(RS A)의 Approve는 24시간 안의 수정이다 — 서버에는 amend로 간다. Approve 단추·Approve & Next·Ctrl+S·
       * 뷰어 창의 Finalize가 모두 이 한 자리를 지난다. 창·승인자·Addendum·고친 글은 단추가 미리 말하고, 판정은 서버가 한다.
       */
      if (action === "approve" && appState[selectedUid]?.rs === "A") action = "amend";
      const uid = selectedUid, pressedSeq = selectionSeq;
      const content = {
        findings: $("#findings").value,
        conclusion: $("#conclusion").value,
        recommendation: $("#recommendation").value,
      };
      // 받아들여진 확정이 싣지 않은, 그 뒤에 친 글이 남았는가(아래) — 완료 안내가 그 사실을 함께 말한다.
      let lateText = false;
      // 진행 중 판독 되돌리기의 답이 말하는 남의 점유·글의 자리(있을 때만). 완료 안내가 그대로 옮긴다.
      let released = null;

      if (serverMode) {
        commitInFlight = true;
        // 요청이 나가 있는 동안 버튼을 회색으로. 플래그만으로도 두 번째 호출은 막히지만,
        // 눌리는데 아무 일도 안 일어나는 버튼은 "먹통"으로 읽혀 또 누르게 만든다.
        for (const id of ["#b-approve", "#b-approve-next", "#b-save", "#b-addendum", "#b-unread", "#b-prelim", "#b-defer"])
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
          released = action === "reset" ? result.answer?.body?.released ?? null : null;
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
        const rs = { save: "T", approve: "A", amend: "A", addendum: "A", reset: "W", defer: "H" }[action];
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
      announceCommit(uid, action, reason, lateText, released);
      // 받아들여진 확정이다. 누른 그 검사·그 선택과, 그 확정이 싣지 않은 글이 남았는지를 부른 쪽(Approve & Next)에 알린다.
      return { accepted: true, uid, seq: pressedSeq, lateText };
    }

    /**
     * Approve & Next(W4-PAGE-04/08 — 설계 v5 §3의 Finalize & Next; 이름은 D1358 ①로 Approve를 지킨다). Approve는 그
     * 검사에 머물고, 이 단추는 승인이 **서버에 받아들여지고 그 승인본이 편집기에 그려진 뒤에만** 다음 검사로 옮긴다. 결과를
     * 모르는 확정·거절·점유·낡은 판, 누른 뒤에 친 글이 남은 확정, 글자 조합 때문에 그리지 못한 승인본이면 머문다 — 무엇이 됐는지
     * 사람이 보지 못한 채 다음 환자로 넘어가지 않는다. 다음 검사는 누른 순간의 줄(queue anchor: 이 검사와 그 자리, 그 다음 검사와
     * 그 뒤의 후보들)이 정하고, 승인이 받아들여져 그려진 **뒤에** 그 줄로 다시 확인한다(`queueAnchor`/`queueTarget`): 그 사이
     * 목록이 다시 정렬됐어도 다른 행으로 가지 않고, 승인으로 이 검사가 필터에서 빠져도 "누르기 전 이 검사의 다음"이지 목록의 첫
     * 행이 아니며, 그 다음 검사가 빠졌으면 그 줄의 다음 후보로, 후보가 없으면 머문다. 늦게 온 답은 다른 선택을 옮기지 않는다(A→B→A).
     */
    async function approveAndNext() {
      const why = reportCommandBlocked("finalize-next");
      if (why) { toast(why, "err"); return; }
      const anchor = queueAnchor(1), asked = studyRequests;
      const done = await commitReport("approve");
      if (!done?.accepted || done.lateText || done.uid !== selectedUid || done.seq !== selectionSeq || !reportShowsAccepted(done.uid)) return;
      // 답을 기다리는 사이 사람이 다른 검사를 골랐다(옮겨졌든 저장을 기다리며 머물렀든): 늦게 온 답이 그 뜻을 덮지 않는다.
      if (studyRequests !== asked) return;
      const next = queueTarget(anchor);
      if (!next) { toast("이 목록의 마지막 검사입니다 — 다음 검사가 없어 이 검사에 머뭅니다", "info"); return; }
      // 여기서는 확인되지 않은 글이 없다(위의 조건) — 관문은 같은 자리에서 옮기므로, 방금 다시 확인한 그 검사로 간다.
      select(next, { openSelected: true });
    }
    /** 편집기가 그 검사의 서버 판독문을 그리고 있는가: 미뤄 둔 다시 그리기도, 확인되지 않은 글도 없는 그 선택의 opening. */
    function reportShowsAccepted(uid) {
      return reportRefreshPendingFor !== uid && !reportConverge.has(uid)
        && reportOpening?.uid === uid && reportOpening.selectionSeq === selectionSeq;
    }
    /**
     * 이 문서가 그 검사에 대해 가진 초안의 사진(W5 인터페이스 ④, impact §10). 읽기만 한다 — 요청도, 표시·기준·화면의 변경도 없다.
     * 한 동기 구간에서 함께 읽은 값이고 모두 사본이다(부른 쪽이 고쳐도 이 문서의 상태는 그대로다). Notice의 Check가 서버의 전체 읽기를
     * 이것과 견주고, W5의 Check가 같은 자리를 쓴다.
     *   uid · author(이 페이지의 계정: 기관·사용자 ID·작성자) · selectionSeq(그 검사가 지금 선택일 때만, 아니면 null)
     *   revision(초안 명령 경로가 딛고 선 초안 revision, 모르면 null) · baseVersion(이 글이 딛고 선 판)
     *   texts(이 문서의 초안 글 세 칸: 고른 검사는 편집기의 글, 떠난 검사는 담아 둔 사본. 초안도 확인되지 않은 글도 없으면 null —
     *     편집기는 저장된 판독문을 보이고 있다) · lists(그 revision에서 서버가 가진 인용·구조화 id, 초안 쓰기가 함께 싣는 목록; 모르면
     *     null) · unconfirmed(서버가 아직 확인하지 않은 글이 있는가)
     */
    function reportDraftSnapshot(uid = selectedUid) {
      if (!uid) return null;
      const a = appState[uid] ?? {}, draft = a.prelimHidden ? null : a.draft ?? null;
      const unconfirmed = reportConverge.has(uid);
      const texts = !unconfirmed && !draft ? null
        : Object.fromEntries(RFIELDS.map(k => [k, uid === selectedUid ? $("#" + k).value : String(draft?.[k] ?? "")]));
      const lists = draftClient.lists(uid);
      return {
        uid,
        author: draftOwner ? { institution: draftOwner.institution ?? null, sub: draftOwner.sub, author: draftOwner.author } : null,
        selectionSeq: uid === selectedUid ? selectionSeq : null,
        revision: draftClient.revision(uid),
        baseVersion: reportBaseVersion(uid, draft?.baseVersion ?? a.version ?? 0),
        texts,
        lists: lists ? { citations: [...lists.citations], structured: [...lists.structured] } : null,
        unconfirmed,
      };
    }
    /**
     * 판독 명령을 지금 할 수 없는 까닭, 할 수 있으면 null — 명령의 공통 차단점이다(W5 인터페이스 ③, impact §10). command는
     * "approve"(Approve 단추)·"finalize-next"(Approve & Next)·"next"·"prev"(Next/Prev 단추와 통합 판독 화면의 이전/다음)·
     * "finalize"(Ctrl+S와 뷰어 창이 넘기는 Finalize)이고, 이 명령들은 모두 실행 직전에 이것을 지난다: 까닭이 있으면 검사를
     * 옮기지도 확정하지도 않고 그 까닭을 말한다. 까닭이 없으면 지금까지의 같은 길이다(같은 이벤트·같은 클릭 수). W5 Related
     * Report mode가 자기 까닭을 여기에 더한다(설계 v5 §1.6).
     *
     * W4가 정하는 까닭은 단추가 아닌 길(키·다른 문서)로 오는 확정과 Approve & Next의 것뿐이다: 승인 단추가 잠겨 있으면 그 단추가
     * 말하는 까닭이 그대로 까닭이다(같은 판단을 두 번 하지 않는다). Approve 단추·Next·Prev는 눌릴 때 이미 자기 상태(잠김·목록 끝·
     * 이동 관문)를 지니므로 W4가 까닭을 더하지 않는다.
     */
    function reportCommandBlocked(command) {
      const related = relatedCommandBlock(command);
      if (related) return related;
      if (!["finalize", "finalize-next"].includes(command)) return null;
      if (!selectedUid) return "검사를 선택하세요";
      if (pendingLeave) return "쓰던 글의 저장을 기다려 검사를 옮기는 중입니다";
      const button = $("#b-approve");
      if (button.disabled) return button.title || "지금은 승인할 수 없습니다";
      return null;
    }
    /**
     * W5의 까닭(설계 v5 §1.6, D1423 R4). Related Report 모드에서는 모든 판독 명령이 Back까지 기다린다 — Approve & Next를 포함한다. Next·Prev만
     * 예외다: 검사 이동의 관문(select)이 판독 대상이 깨끗하면 모드를 닫고 옮기고, 아니면 Notice로 머문다. 모드 밖에서도 저장 영수증이
     * 확인되지 않은 Related 삽입이 있으면 그 글을 싣는 확정·버리기는 기다린다(Check·Retry가 먼저다). 환자 식별 불일치의 거절이 늘 먼저다.
     */
    function relatedCommandBlock(command) {
      if (!selectedUid || appState[selectedUid]?.identityUnresolved || ["next", "prev"].includes(command)) return null;
      if (relatedMode.active()) return relatedMode.reason();
      return relatedInsertPending(selectedUid) ? RELATED_PENDING_REASON : null;
    }
    /**
     * 단축키 목록의 "Finalize (Approve)"(Ctrl+S). 명령을 실행했으면 true — 그때만 브라우저의 페이지 저장을 막는다.
     * 확정·삽입이 나가 있으면 commitReport는 아무것도 하지 않고 돌아온다(삽입 중에는 Approve 단추도 잠기지 않는다) —
     * 그때 "실행했다"고 답하면 Ctrl+S가 아무 일도 하지 않은 채 사라진다.
     */
    function finalizeCommand() {
      if (mode !== "Radiology" || commitInFlight || insertInFlight || reportCommandBlocked("finalize")) return false;
      commitReport("approve");
      return true;
    }

    /**
     * FC-028 Batch Reading·FC-029 Batch Approve의 페이지 쪽(분류기·실행기·대화상자는 worklist-batch-report.js). 묶음은 검사마다
     * 기존 한 검사 확정(`POST /studies/:uid/report/commit`, action save 또는 approve)을 차례로 부른다 — 검사마다 판·감사·
     * 접속기록이 따로 남고, 승인은 검사마다 그 판이 따로 서명된다.
     *
     * 실행 동안은 한 건 확정과 같은 잠금(`commitInFlight`)을 쥔다: 한 건 확정 단추가 잠기고, 자동 저장·목록과 폴링의 반영·
     * Log out이 그 답을 기다린다. 끝나면 확정 세대(`commitEpoch`)를 올려 그 사이 떠난 목록 읽기의 답을 버린다.
     */
    function batchReportFacts(uid) {
      const a = appState[uid];
      if (!a) return null;
      const holder = heldByOther(a);
      return {
        rs: a.rs, ss: a.ss, em: a.em, prelimHidden: !!a.prelimHidden, identityUnresolved: !!a.identityUnresolved,
        /**
         * FC-029: a Preliminary that may be mine to approve. The server shows a Preliminary only to its author and its designated
         * reviewer and judges the designation by account id first; the list carries names only, and names can change. So every
         * Preliminary not hidden from me is offered and the server decides each approval: its author's request is refused
         * (403) and that row alone is Failed, unsigned. No name comparison here can leave the designated reviewer out.
         */
        designated: a.rs === "P" && !a.prelimHidden,
        texts: Object.fromEntries(RFIELDS.map(k => [k, String(a[k] ?? "")])),
        draft: !a.prelimHidden && !!a.draft,
        holder: holder ? (holder === "다른 기관" || holder === "작성자 비공개" ? holder : displayActor(holder)) : null,
        // 이 문서에 서버가 확인하지 않은 글·나가 있는 초안 명령·결과를 모르는 확정·확정되지 않은 Related 삽입이 있다.
        unconfirmed: reportConverge.has(uid) || draftClient.busy(uid) || draftClient.uncertain(uid) || !!draftClient.conflict(uid)
          || reportUnknownCommits.has(uid) || relatedInsertPending(uid) || (uid === selectedUid && reportDirty()),
        priority: !!studyPriority?.get(uid),
        version: Number.isSafeInteger(a.version) ? a.version : 0,
        draftRevision: typeof a.draftRevision === "string" ? a.draftRevision : null,
        draftEpoch: a.draftEpoch ?? null,
      };
    }
    /** 묶음 실행이 한 건 확정의 잠금을 쥔다. 확정·삽입이 나가 있으면 시작하지 않는다(false). */
    function batchReportBegin() {
      if (commitInFlight || insertInFlight || !serverMode || offline) return false;
      commitInFlight = true;
      for (const id of ["#b-approve", "#b-approve-next", "#b-save", "#b-addendum", "#b-unread", "#b-prelim", "#b-defer"])
        if ($(id)) $(id).disabled = true;
      return true;
    }
    function batchReportEnd(at) {
      commitInFlight = false;
      commitEpoch += 1; listLoadSequence++;
      work.commit(at, () => { render(); renderRelated(); updateReportButtons(); });
      wakeIdle();
    }
    /**
     * 받아들여진 묶음 저장 한 건을 상태·목록 행에 옮긴다. 편집기는 따로다: 그 검사가 지금 선택이고, 보낼 때의 선택 순번
     * 그대로이고, 보낸 뒤 고친 글이 없을 때만 다시 그린다. 그리지 않을 때 그 검사가 지금 선택이면 그 편집기의 글이 딛고 선
     * 판(기준 판)·확인되지 않은 글 표시·초안을 그대로 둔다 — 보이지 않은 상용구 판 위에 사람의 글이 조용히 서지 않는다(그 뒤의
     * 확정은 판 대조에서 거절되고 서버 글을 보여 준다). 선택되지 않은 검사의 성공은 지금 편집 중인 글을 건드리지 않는다.
     */
    function applyBatchCommit(uid, st, sentAt, seq) {
      const selected = uid === selectedUid;
      const redraw = selected && seq === selectionSeq && !reportEditedSince(uid, sentAt);
      // 떠난 검사에 남겨 둔 확인되지 않은 글(떠날 때 담아 둔 사본)도 같다: 그 글이 딛고 선 판과 사본을 그대로 둔다.
      const kept = !redraw && (selected || reportConverge.has(uid))
        ? { origin: reportBaseVersion(uid, null), converge: reportConverge.has(uid), draft: appState[uid]?.draft ?? null } : null;
      appState[uid] = replaceReportState(uid, st, { confirmed: true });
      if (kept) {
        if (kept.origin !== null) recordReportOrigin(uid, kept.origin);
        if (kept.converge) { reportConverge.add(uid); appState[uid] = { ...appState[uid], draft: kept.draft }; }
      }
      syncStudy(uid);
      if (heldUid === uid) { heldUid = null; clearInterval(heartbeat); heartbeat = null; }   // 확정하면 서버가 점유를 푼다
      if (redraw) loadReport({ force: true });
    }
    /**
     * 한 줄을 보낸다. `item`은 대화상자가 연 순간의 사진({ uid, version, draftRevision, draftEpoch, texts })이고 `texts`는
     * 보낼 세 칸이다 — Batch Reading은 상용구, Batch Approve(FC-029, action approve)는 대화상자가 보여 준 그 저장본. 판
     * (`baseVersion`)은 보여 준 판이라 그 사이 저장된 글이 있으면 서버가 409로 거절한다. 인용·구조화의 유지·제거 목록은 싣지
     * 않는다(내 초안이 없는 검사뿐이라 머리 판의 것이 그대로 이월된다). 붙잡은 revision이 차례가 왔을 때와 같을 때만
     * 보낸다(`pinned`) — 바뀌었으면 기준을 옮겨 다시 보내지 않는다.
     * 돌려주는 status: saved · skipped(reason) · failed(reason) · unknown · stopped(문맥이 끝났다).
     */
    async function batchReportSave(item, texts, reason, at, action = "save") {
      const uid = item.uid;
      if (!work.admits(at)) return { status: "stopped" };
      const sentAt = reportEdits, seq = selectionSeq;
      const result = await draftClient.commit(uid, { action, reason, baseVersion: item.version, ...texts },
        { owner: draftOwner, context: at, pinned: { revision: item.draftRevision } });
      if (!work.admits(at)) return { status: "stopped" };
      if (result.outcome === "saved") {
        commitEpoch += 1; listLoadSequence++;
        applyBatchCommit(uid, result.state, sentAt, seq);
        return { status: "saved", sentAt };
      }
      if (result.outcome === "changed" || result.outcome === "conflict")
        return { status: "skipped", reason: "그 사이 초안이 바뀌었습니다" };
      if (result.outcome === "unknown") return { status: "unknown", sentAt, seq };
      if (result.outcome === "unsent" || result.outcome === "auth") return { status: "stopped" };
      const refused = result.answer?.body || {};
      if (refused.code === "REPORT_HELD") noteHeld(uid, refused.holder);
      return { status: "failed", reason: draftFailureText(result), code: result.code ?? refused.code ?? null };
    }
    /**
     * 답을 잃은 묶음 저장(§2-5). 한 건 확정의 판정(판이 오르고 글이 같으면 성공)을 쓰지 않는다 — 같은 글을 남이 저장했을 수
     * 있다. 그 검사의 판 목록에서 action·작성자·사유·세 칸·판 번호(보낸 기준 판 + 1)가 내가 보낸 것과 같은 판을 찾는다.
     * 찾으면 saved, 그 판 번호 이후에 다른 판이 있으면 이 요청은 판 대조에 걸려 닿을 수 없다(failed), 판이 그대로이거나
     * 읽지 못했으면 unknown으로 남긴다(판이 그대로라는 것만으로 "저장 안 됨"이라 하지 않는다 — 늦게 닿을 수 있다). unknown은
     * 결과 모름 확정의 기록(`reportUnknownCommits`)에도 남겨, 그 검사의 자동 저장·한 건 확정이 먼저 서버 상태를 읽게 한다.
     */
    async function batchReportVerify(item, texts, reason, at, sent, action = "save") {
      const uid = item.uid;
      let list = null;
      try { list = await api("GET", `/studies/${encodeURIComponent(uid)}/report/versions`, undefined, undefined, at); }
      catch (_) { list = null; }
      if (!work.admits(at)) return { status: "stopped" };
      const record = { batch: true, sentAt: sent?.sentAt ?? reportEdits, seq: sent?.seq ?? null, action, reason,
        author: draftOwner?.author ?? null, baseVersion: item.version, texts: { ...texts }, revision: draftClient.revision(uid) };
      const found = batchVersionOutcome(list, record);
      if (found === "mine") {
        if (heldUid === uid) { heldUid = null; clearInterval(heartbeat); heartbeat = null; }
        // 저장은 확인됐다. 그 검사의 지금 상태(판·초안 revision)를 읽어 한 줄 저장의 답과 같이 옮긴다 — 그래야 결과를 모르던
        // 초안 명령 줄의 기준이 풀리고, 그 뒤의 쓰기(탭이 닫힐 때의 쓰기 포함)가 새 revision 위에서 나간다.
        let st = null;
        try { st = (await api("GET", "/bootstrap", undefined, undefined, at))?.states?.[uid] ?? null; } catch (_) {}
        if (st && Number.isSafeInteger(st.version) && work.admits(at)) {
          commitEpoch += 1; listLoadSequence++;
          applyBatchCommit(uid, st, record.sentAt, record.seq);
          // 답을 받은 저장은 그 revision에서 서버의 초안(없음)을 함께 알지만, 여기서는 revision만 안다. 그 검사의 초안 전체를
          // 한 번 읽어 둔다 — 탭이 닫힐 때의 쓰기는 읽으러 갈 수 없어, 그 사이 친 글(A→B→A)이 그것 없이는 보내지지 않는다.
          await draftClient.prime(uid, { owner: draftOwner, context: at });
        }
        return { status: "saved", verified: true };
      }
      if (found === "other") {
        // 이 요청은 판 대조에 걸려 닿을 수 없다(확정된 실패). 결과를 모르던 초안 명령 줄의 기준을 전체 읽기 한 번으로 풀어
        // 둔다 — 그대로 두면 Retry가 그 검사를 "저장을 확인하는 중"으로 건너뛰어, 새 글을 보여 주고 다시 보낼 길이 막힌다.
        try { await draftClient.base(uid, { owner: draftOwner, context: at }); } catch (_) {}
        return { status: "failed", reason: "그 사이 다른 판이 저장됐습니다" };
      }
      reportUnknownCommits.set(uid, record);
      return { status: "unknown" };
    }
    /**
     * 묶음 저장 하나가 판 목록에 있는가: "mine"(그 판 번호에 action·작성자·사유·세 칸이 보낸 것과 같은 판), "other"(보낸 기준
     * 판 뒤에 다른 판이 섰다 — 이 요청은 판 대조에 걸려 닿을 수 없다), "none"(판이 그대로이거나 읽지 못했다 — 모른다).
     */
    function batchVersionOutcome(list, sent) {
      if (!Array.isArray(list)) return "none";
      const same = v => RFIELDS.every(k => KinReportCitation.toLf(String(v?.[k] ?? "")) === KinReportCitation.toLf(sent.texts[k]));
      if (list.some(v => v && v.version === sent.baseVersion + 1 && v.action === sent.action && !!sent.author && v.author === sent.author
        && v.reason === sent.reason && same(v))) return "mine";
      return list.some(v => v && Number.isSafeInteger(v.version) && v.version > sent.baseVersion) ? "other" : "none";
    }
    /**
     * 결과를 모르는 묶음 저장을 그 검사의 다음 쓰기(자동 저장·한 건 확정·Log out 보존)가 다시 확인한다 — 한 건 확정의 판정
     * (판이 오르고 글이 같으면 landed)이 아니라 판 목록의 대조로(§2-5). 판이 그대로면 기록을 남긴 채 "absent"다: 그 검사의
     * 초안 쓰기는 늦게 닿을 수 있는 그 저장과 같은 초안 revision을 두고 겨루므로 둘 다 설 수는 없다. 내 판을 찾았으면 상태를
     * 옮기되 편집기와 사람의 글은 `applyBatchCommit`의 규칙대로 지킨다 — 보낸 뒤 고친 글이 있으면 그 글은 상용구 판 위의 글이
     * 아니므로 "landed"로 돌려주지 않는다(부른 쪽이 그 글을 새 판 위로 옮기지 않게 "absent").
     */
    async function readBatchCommitOutcome(uid, sent, at, session) {
      let list = null;
      try {
        const answer = await transport.request(`${API}/studies/${encodeURIComponent(uid)}/report/versions`,
          { context: at, kind: "draft", ...(session ? { session } : {}) });
        if (answer.ok && !answer.incomplete && Array.isArray(answer.body)) list = answer.body;
      } catch (_) {}
      if (reportUnknownCommits.get(uid) !== sent) return { outcome: "none" };
      if (!list) return { outcome: "unknown" };
      const found = batchVersionOutcome(list, sent);
      if (found !== "mine") {
        if (!work.admits(at)) return { outcome: "unknown" };
        if (found === "other") reportUnknownCommits.delete(uid);
        return { outcome: "absent" };
      }
      let st = null;
      try {
        const answer = await transport.request(API + "/bootstrap", { context: at, kind: "draft", ...(session ? { session } : {}) });
        if (answer.ok && !answer.incomplete) st = answer.body?.states?.[uid] ?? null;
      } catch (_) {}
      if (reportUnknownCommits.get(uid) !== sent) return { outcome: "none" };
      if (!st || !Number.isSafeInteger(st.version)) return { outcome: "unknown" };
      let learned = { outcome: "unknown" };
      work.commit(at, () => {
        const later = reportEditedSince(uid, sent.sentAt);
        reportUnknownCommits.delete(uid);
        learned = later ? { outcome: "absent" } : { outcome: "landed", version: st.version, later: false };
        if (work.state() !== "active") return;
        if (heldUid === uid) { heldUid = null; clearInterval(heartbeat); heartbeat = null; }
        commitEpoch += 1; listLoadSequence++;
        applyBatchCommit(uid, st, sent.sentAt, sent.seq);
        draftClient.prime(uid, { owner: draftOwner, context: at });   // 위 batchReportVerify와 같은 까닭
        render(); renderRelated(); updateReportButtons();
        if (uid === selectedUid)
          toast(sent.action === "approve" ? "Batch Approve의 승인이 확인됐습니다 (RS: A) — 판독문을 확인한 뒤 다시 누르세요"
            : "Batch Reading의 저장이 확인됐습니다 (RS: T) — 판독문을 확인한 뒤 다시 누르세요", "info");
      });
      return learned;
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
    $("#b-approve").addEventListener("click", () => {
      const why = reportCommandBlocked("approve");
      if (why) { toast(why, "err"); return; }
      commitReport("approve");
    });
    $("#b-approve-next").addEventListener("click", approveAndNext);
    $("#b-addendum").addEventListener("click", () => commitReport("addendum"));
    let reasonResolve = null;
    function askReason({ title, choices, optional = false }) {
      if (reasonResolve) reasonResolve(null);
      const modal = $("#reasonmodal"), extra = $("#reason-extra"), ok = $("#reason-ok");
      $("#reason-title").textContent = title;
      $("#reason-choices").innerHTML = choices.map(choice =>
        `<label style="display:block"><input type="radio" name="reason-choice" value="${esc(choice)}"> ${esc(choice)}</label>`).join("");
      extra.value = "";
      const value = () => {
        const choice = modal.querySelector('input[name="reason-choice"]:checked')?.value;
        const detail = extra.value.trim();
        if (detail.length > 200) return null;
        if (!choice) return optional ? detail : null;
        if (choice === "기타" && !detail && !optional) return null;
        return detail ? `${choice} — ${detail}` : choice;
      };
      const update = () => { ok.disabled = value() === null; };
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
        ok.onclick = () => { const reason = value(); if (reason !== null) finish(reason); };
      });
    }
    $("#b-unread").addEventListener("click", async () => {
      // FC-040: 남이 판독 중이거나 남이 저장해 둔 진행 중 판독(W·T·H)은 묻지 않고 보낸다 — 사유는 서버가 검사를 잠근 채 만든다.
      if (inProgressReset(cur())) { commitReport("reset"); return; }
      // 판독을 되돌리는 것은 저장된 진술을 지우는 일이다. 사유 없이는 보내지 않는다.
      const uid = selectedUid, at = work.capture("study");
      const reason = await askReason({ title: "판독 취소 사유", choices: ["내용 정정 필요", "환자·검사 불일치", "잘못된 검사에 작성", "의뢰 취소", "기타"] });
      // 사유를 고르는 사이 준비·종료·검사 이동이 있었으면 그 결정은 지금 화면의 것이 아니다.
      if (!reason || uid !== selectedUid || !work.admits(at)) return;
      commitReport("reset", reason);
    });
    $("#b-defer").addEventListener("click", async () => {
      const uid = selectedUid, at = work.capture("study");
      const reason = await askReason({ title: "Defer (Optional Reason)", optional: true, choices: ["prior 없음", "임상정보 부족", "영상 불량", "재촬영 필요", "기타"] });
      if (reason === null || uid !== selectedUid || !work.admits(at)) return;
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
