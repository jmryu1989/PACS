

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