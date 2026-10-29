

    // ── Report ──
    let relatedReportSeq = 0;

    function clearRelatedReport(message = "Related Exam을 선택하세요") {
      // A5: the Source opening ends with its text; a later read of any Source is a new display.
      KinReportViews.end("related");
      $("#prior-report-meta").textContent = "";
      $("#prior-report-meta").title = "";
      $("#prior-report-status").textContent = message;
      $("#prior-report-status").style.display = "";
      $("#prior-report-content").style.display = "none";
      for (const id of ["#prior-findings", "#prior-conclusion", "#prior-recommendation"])
        $(id).textContent = "";
      showPriorRecommendation();
      // W5: the Source display context follows (an empty Source never keeps an older read's text).
      relatedMode.showSource({ seq: relatedReportSeq, uid: null, state: "idle" });
    }

    /**
     * 지금의 승인 판독문: 폐기 기록을 뺀 가장 새 판이 approve/addendum일 때만 그 판이다(W5 Source는 승인/추가기재 ReportVersion뿐).
     * 그 뒤에 취소(reset) 같은 판이 섰으면 예전 승인을 지금의 승인본으로 보이지 않는다 — 서버도 그런 Source의 삽입을 받지 않는다.
     */
    /**
     * W-07b: Findings and Conclusion are the report's two sections. A stored Recommendation (legacy or template value) is
     * shown read-only only when it has text; an empty one shows no heading. The value itself is never dropped.
     */
    function showPriorRecommendation() {
      const value = $("#prior-recommendation");
      value.closest(".prior-report-section").hidden = !value.textContent;
    }

    function relatedReportHead(list) {
      const top = (Array.isArray(list) ? list : []).filter(v => v?.action !== "discarded").sort((a, b) => b.version - a.version)[0];
      return top && Number.isSafeInteger(top.version) && ["approve", "addendum"].includes(top.action) ? top : null;
    }

    /**
     * Related에서 고른 검사는 승인 판독문만 열람한다.
     *
     * 목록 응답의 `state`에도 현재 Report가 있지만 내 초안이 함께 올 수 있다. 그 값을 그대로
     * 그리면 prior의 미확정 초안이 "이전 판독문"으로 보인다. 이미 쓰는 이력 조회 경로에서
     * approve/addendum 판만 골라 읽어야 읽기 전용의 의미가 맞는다.
     *
     * W5(설계 v5 §1.5): 읽기마다 요청 번호가 있고, 답은 그 번호·검사·판독 대상·선택이 그대로일 때만 쓴다(A→B→A의 늦은 답 포함).
     * Load Failed(다시 읽기)와 Access Restricted(403/404: 권한·범위)를 가르고, 승인본이 없는 것은 실패가 아니다.
     */
    async function loadRelatedReport() {
      const s = relatedStudy();
      if (!s) { clearRelatedReport(); return; }
      const uid = s.uid;
      const currentUid = selectedUid;
      const seq = ++relatedReportSeq;
      // A5: another Source ends the shown Source's opening now; a re-read of the same Source continues it.
      KinReportViews.open("related", uid);
      // 이 읽기의 답·실패가 이전 판독문 칸에 닿는 자리는 이 읽기를 시작한 문맥과 요청 번호·선택을 함께 지난다.
      const at = work.capture("study");
      const stale = () => !work.admits(at) || seq !== relatedReportSeq || uid !== relatedUid || selectedUid !== currentUid;
      const shown = view => relatedMode.showSource({ seq, uid, ...view });
      $("#prior-report-meta").textContent = relatedReportMeta(s);
      $("#prior-report-meta").title = $("#prior-report-meta").textContent;
      $("#prior-report-status").textContent = s.rs === "A" ? "승인 판독문 불러오는 중…" : "판독문 없음";
      $("#prior-report-status").style.display = "";
      $("#prior-report-content").style.display = "none";
      shown({ state: s.rs === "A" ? "loading" : "none" });

      let report = null;
      try {
        if (serverMode && s.rs === "A") {
          const list = await api("GET", `/studies/${encodeURIComponent(uid)}/report/versions`, undefined, undefined, at);
          if (stale()) return;
          report = relatedReportHead(list);
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
        const restricted = e?.status === 403 || e?.status === 404;
        $("#prior-report-status").textContent = restricted
          ? "이 판독문을 볼 권한이 없습니다 (Access Restricted)" : `판독문 조회 실패: ${e.message}`;
        KinReportViews.end("related");
        shown({ state: restricted ? "restricted" : "failed" });
        return;
      }
      if (stale()) return;
      if (!report) {
        KinReportViews.end("related");
        $("#prior-report-status").textContent = "판독문 없음"; shown({ state: "none" }); return;
      }
      $("#prior-report-meta").textContent =
        `${relatedReportMeta(s)} · 판독의 ${displayActor(report.author) || "-"}`;
      $("#prior-report-meta").title = $("#prior-report-meta").textContent;
      $("#prior-findings").textContent = report.findings ?? "";
      $("#prior-conclusion").textContent = report.conclusion ?? "";
      $("#prior-recommendation").textContent = report.recommendation ?? "";
      showPriorRecommendation();
      $("#prior-report-status").style.display = "none";
      $("#prior-report-content").style.display = "";
      shown({ state: "ready", version: Number.isSafeInteger(report.version) ? report.version : null, action: report.action ?? null,
        author: displayActor(report.author) || null, at: typeof report.at === "string" ? report.at.replace("T", " ").slice(0, 16) : null,
        texts: { findings: report.findings ?? "", conclusion: report.conclusion ?? "", recommendation: report.recommendation ?? "" } });
      // A5: only the version this Source shows is displayed (the read provided every version row). Its display report names
      // this read's provision; a re-read of the same Source and version (every list refresh) is the same display.
      const key = "report-version:" + report.version;
      KinReportViews.end("related", [key]);
      KinReportViews.watch("related", uid, key, { uid, accessRef: report.accessRef,
        nodes: [$("#prior-report-content"), document.querySelector("#related-mode .related-mode-body")], live: () => !stale(),
        report: body => api("POST", `/studies/${encodeURIComponent(uid)}/view-observations`, body, undefined, at) });
    }

    function returnToReportStudy() {
      if (!cur() || !relatedUid) return;
      // W5: in Related Report mode, Return to Current also leaves the mode — the editor comes back with its caret, selection
      // and scroll (Back to Current Draft alone keeps the Related study viewed: backToCurrentDraft).
      const left = relatedMode.exit();
      // 같은 판독 행 재선택은 의도적으로 무동작이다. 영상만 돌아가려다 판독문을 재로딩하거나 점유를 풀면 안 된다.
      relatedUid = null;
      ++relatedReportSeq;
      clearRelatedReport();
      renderClinical(); renderRelated(); renderThumbs(); renderTemplates();
      if (left) { criticalInbox?.sync(); updateReportButtons(); renderDraftBar(); relatedMode.restore(left); return; }
      $("#related-current").focus({ preventScroll: true });
    }

    /**
     * W5 Back to Current Draft (Back, Esc, Report Editor/Ctrl+Alt+4): leaves the mode and gives the editor back with its caret,
     * selection and scroll (or the insertion end). Never refused. The Viewed Study stays the Source, so its report stays in the
     * Related Report pane beside the editor (reading while writing, D1244); Return to Current (#related-return) is the separate
     * action that gives the viewing back to the Target, and in the mode it also leaves the mode.
     */
    function backToCurrentDraft() {
      const left = relatedMode.exit();
      if (!left) return false;
      renderClinical(); updateReportButtons(); renderDraftBar();
      criticalInbox?.sync();
      relatedMode.restore(left);
      return true;
    }

    /**
     * The worklist's ways to the report editor (Enter on the current row, its keyboard activation, the row menu's
     * 판독문 작성으로). In Related Report mode the editor is hidden, so this is the mode's Back (Report Editor): the Target,
     * its text and its caret come back. Otherwise the Findings field takes the focus as before.
     */
    function focusReportEditor() {
      if (backToCurrentDraft()) return;
      $("#findings").focus();
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
     * W5 Related Report mode entry (설계 v5 §1.2, D1423 R2/R4/R6). A row click, Enter or the Related Report key opens the mode on
     * that Source — but only from a Target whose text the server has confirmed: the W4 move gate (leaveStudyGate) must answer
     * clear or saved, and nothing that decides the Target's text may be out (a commit, a citation/structure insert, a discard,
     * a draft command), within the same bounded wait. Otherwise the reader stays where they are and the one Notice says why
     * (its Retry/Check continue this entry; the Source is never selected as the Target). Inside the mode a new Source is a
     * Source move: no gate (the Source is read-only), a pending Insert stays as it is.
     */
    let relatedEntrySeq = 0;
    async function enterRelatedMode(uid, { focus = true } = {}) {
      if (work.state() !== "active") return;
      if (relatedMode.active()) {
        if (uid !== relatedUid) previewRelated(uid);
        if (focus) relatedMode.focus();
        return;
      }
      const current = cur(), source = studies.find(s => s.uid === uid);
      if (!current || !source || source.uid === current.uid || !current.sourcePatientKey
          || source.sourcePatientKey !== current.sourcePatientKey) return;
      const target = selectedUid, seq = selectionSeq, owner = draftOwner, opening = reportOpening, ticket = ++relatedEntrySeq;
      const refuse = (status, reason) => showReportNotice({ status, uid: target, seq, reason, action: { kind: "related-enter", source: uid } });
      // WORKLIST-SPLIT-UID: neither the Target nor the Source may be a study two patient resources answer.
      if (appState[target]?.identityUnresolved || appState[uid]?.identityUnresolved) {
        toast("환자 식별 불일치로 이 검사를 사용할 수 없습니다. 원본 확인이 필요합니다.", "err");
        return;
      }
      if (!opening || opening.uid !== target || opening.selectionSeq !== seq) return;
      if (relatedInsertPending(target)) { relatedInsertNotice(target); return; }
      if (reportFrame?.isComposing()) { refuse("composing"); return; }
      // The same Target opening (a re-render of the same opening keeps it; another selection, even of the same study, does not).
      const same = () => ticket === relatedEntrySeq && selectedUid === target && selectionSeq === seq && reportOpening?.uid === target
        && reportOpening?.selectionSeq === seq && draftOwner === owner && work.state() === "active" && !relatedMode.active();
      const deadline = Date.now() + LEAVE_WAIT_MS;
      for (;;) {
        if (workBusy() || draftClient.busy(target)) {
          const left = deadline - Date.now();
          if (left <= 0) { if (same()) refuse("unknown"); return; }
          await leaveWithin(Promise.all([workIdle(), draftClient.settled(target)]), left);
          if (!same()) return;
          continue;
        }
        let pass = leaveStudyGate("related");
        if (pass instanceof Promise) pass = await pass;
        if (!same()) return;
        // An answer for no Target is not an entry permission (R4); a stale one belongs to a move that no longer stands.
        if (pass.uid !== target || pass.status === "stale") return;
        if (pass.status !== "clear" && pass.status !== "saved") { refuse(pass.status, pass.reason); return; }
        if (workBusy() || draftClient.busy(target) || reportConverge.has(target)) {
          if (Date.now() >= deadline) { refuse("unknown"); return; }
          continue;
        }
        break;
      }
      if (appState[target]?.identityUnresolved || appState[uid]?.identityUnresolved || relatedInsertPending(target)) return;
      if (uid !== relatedUid) previewRelated(uid);
      if (relatedUid !== uid) return;
      relatedMode.enter({ target, selectionSeq: seq, owner, opening, focus });
      // The controls that wait for Back say so now (report buttons, Send CVR, the draft line).
      renderClinical(); updateReportButtons(); renderDraftBar();
      criticalInbox?.sync();
    }

    /** The Related row's own action (click, Enter): the mode's entry. */
    function relatedActivate(uid, options) {
      enterRelatedMode(uid, options);
    }

    /**
     * The Related Report and Report Editor keys (Ctrl+Alt+3/4 or their remaps) and the reading workspace buttons: the mode's
     * entry for the viewed Related study and its Back. True when the mode took the key; otherwise the caller's focus action runs.
     */
    function relatedModeCommand(which) {
      if (which === "report") return backToCurrentDraft();
      if (which !== "prior" || work.state() !== "active") return false;
      if (relatedMode.active()) { relatedMode.focus(); return true; }
      if (!relatedUid || relatedUid === selectedUid) return false;
      enterRelatedMode(relatedUid, { focus: true });
      return true;
    }