

    function relatedDateLabel(target) {
      const current = cur();
      // 수동 비교에는 이후 검사도 들어온다. 날짜를 모르는 경우와 같은 날의 선후를 과거로 추측하지 않는다.
      if (!current || !validPriorDate(current.date) || !validPriorDate(target.date)) return "날짜 미확인";
      if (target.date === current.date) return "같은 날짜 · 선후 미확인";
      return target.date < current.date ? "과거" : "이후";
    }
    function relatedReportMeta(s) {
      return `${relatedDateLabel(s)} · ${s.name} (${s.id}) · ${s.date || "날짜 없음"} · ${s.modality} · ${shownStudyDesc(s)}`;
    }
    /**
     * W5 Related Report mode의 두 식별 카드(설계 v5 §1.4): 같은 환자의 다른 검사를 헷갈리지 않게 두 검사를 같은 항목으로 나란히 보인다.
     * 값은 목록 행과 판독 상태에서만 온다. 없는 값은 null로 두고 화면이 "확인할 수 없음"이라 쓴다 — 지어내지 않는다.
     */
    function relatedIdentity(s) {
      return { uid: s.uid, name: s.name || null, id: s.id || null, institution: s.institutionName || null,
        date: s.date || null, desc: String(s.desc ?? "").trim() || null, acc: s.acc || null };
    }
    function relatedTargetCard() {
      const s = cur();
      if (!s) return null;
      const a = appState[s.uid] ?? {};
      return { ...relatedIdentity(s), version: Number.isSafeInteger(a.version) ? a.version : null, rs: s.rs || null,
        draft: relatedDraftStatus(s.uid) };
    }
    function relatedSourceCard() {
      const s = relatedStudy();
      if (!s) return null;
      return { ...relatedIdentity(s), unresolved: appState[s.uid]?.identityUnresolved ? RELATED_IDENTITY : null };
    }

    // Related Exam: 서버가 원본 기관+PatientID로 만든 키가 같은 "다른" 검사만.
    $('#related-page-prev').addEventListener('click', () => { relatedPage--; renderRelated(); });
    $('#related-page-next').addEventListener('click', () => { relatedPage++; renderRelated(); });
    $('#related-page-current').addEventListener('click', () => renderRelated(true));