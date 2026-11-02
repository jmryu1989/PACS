

    function relatedDateLabel(target) {
      const current = cur();
      // 수동 비교에는 이후 검사도 들어온다. 날짜를 모르는 경우와 같은 날의 선후를 과거로 추측하지 않는다.
      // 상태 이름은 영어, 설명은 relatedDateTitle의 한국어 툴팁이다(AGENTS §4).
      if (!current || !validPriorDate(current.date) || !validPriorDate(target.date)) return "Date Unknown";
      if (target.date === current.date) return "Same Day";
      return target.date < current.date ? "Prior" : "Later";
    }
    function relatedDateTitle(target) {
      return { "Date Unknown": "검사 날짜를 확인할 수 없어 판독 대상과의 선후를 알 수 없습니다",
        "Same Day": "판독 대상과 같은 날짜입니다 · 선후는 확인할 수 없습니다",
        Prior: "판독 대상보다 앞선 검사입니다", Later: "판독 대상보다 뒤의 검사입니다" }[relatedDateLabel(target)];
    }
    // Completed calendar months, without rounding a partial month up; under one month show UTC calendar days.
    // This keeps leap years and DST from making a prior look a month older when choosing a comparison.
    function relatedInterval(target) {
      const current = cur();
      if (!current || !validPriorDate(current.date) || !validPriorDate(target.date)) return "";
      if (target.date === current.date) return "same day";
      const [a, b] = target.date < current.date ? [target.date, current.date] : [current.date, target.date];
      const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number);
      const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
      const span = months >= 12 ? `${Math.floor(months / 12)}y${months % 12 ? ` ${months % 12}m` : ""}`
        : months >= 1 ? `${months}m`
        : `${Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)}d`;
      return `${span} ${target.date < current.date ? "before" : "after"}`;
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
