

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