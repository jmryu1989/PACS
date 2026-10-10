

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

    // Related Exam: 서버가 원본 기관+PatientID로 만든 키가 같은 "다른" 검사만.
    $('#related-page-prev').addEventListener('click', () => { relatedPage--; renderRelated(); });
    $('#related-page-next').addEventListener('click', () => { relatedPage++; renderRelated(); });
    $('#related-page-current').addEventListener('click', () => renderRelated(true));