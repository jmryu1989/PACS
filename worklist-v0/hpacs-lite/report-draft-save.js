

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