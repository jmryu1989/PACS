

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