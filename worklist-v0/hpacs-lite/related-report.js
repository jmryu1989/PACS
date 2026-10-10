

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