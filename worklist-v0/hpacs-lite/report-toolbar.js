

    /**
     * Clear — 세 칸을 한 번에 비운다.
     *
     * 예전엔 확인창도, 권한 검사도, 잠금 검사도 없었다. 그리고 비운 뒤 다른 검사를
     * 클릭하면 초안 저장이 조용히 빈 판독문을 `Report`에 써서 **승인본까지 지웠다.**
     *
     * 초안이 분리된 지금 Clear가 비우는 것은 **내 초안뿐**이다. 저장된 판독문은
     * 손댈 수 없다 — 뒷문이 코드가 아니라 구조에서 없어졌다.
     * 아래 세 검사는 이제 안전장치가 아니라 예의다:
     *   ① 승인된 판독문에서는 막는다. 지워지진 않지만 빈 화면이 "사라졌다"로 읽힌다.
     *   ② 권한·예비판독 잠금.
     *   ③ 확인창 — 되돌릴 수 없는 동작에 손이 미끄러질 자리를 주지 않는다 (교훈 §5).
     */
    $("#b-clear").addEventListener("click", () => {
      const why = reportWriteBlock();
      if (why) { toast(why, "err"); return; }
      const s = cur();
      if (s?.rs === "A") {
        toast("승인된 판독문은 Clear로 비울 수 없습니다 — 판독 취소(Reset)를 사용하세요", "err");
        return;
      }
      const has = $("#findings").value || $("#conclusion").value || $("#recommendation").value;
      if (!has) return;
      if (!confirm("쓰고 있던 판독문 세 칸(Findings/Conclusion/Recommendation)을 모두 비웁니다.\n" +
                   "저장된 판독문은 그대로 남습니다. 계속할까요?")) return;
      // 비운 것도 이 문서의 편집이다: 표시가 서야 다음 폴링이 옛 글을 되살리지 않고, 비운 초안이 서버에 닿는다.
      if (!editReport(RFIELDS.map(field => ({ field, start: 0, end: $("#" + field).value.length, text: "" })))) return;
      toast("쓰던 내용을 비웠습니다 — 저장된 판독문은 그대로입니다", "info");
    });
    $("#b-copy").addEventListener("click", () => {
      const t = `Findings:\n${$("#findings").value}\n\nConclusion:\n${$("#conclusion").value}\n\nRecommendation:\n${$("#recommendation").value}`;
      navigator.clipboard?.writeText(t);
      toast("판독문을 복사했습니다");
    });
    // Paste도 `.value`에 직접 쓴다 — readOnly를 무시하는 같은 경로다.
    $("#b-paste").addEventListener("click", async () => {
      const why = reportWriteBlock();
      if (why) { toast(why, "err"); return; }
      // 붙여넣기는 편집기에 쓴다. 클립보드를 읽는 사이 검사가 바뀌었거나, 로그아웃 준비·세션 종료가 있었거나, 그 칸의 글이
      // 달라졌으면 쓰지 않는다 — 읽기 전에 본 글 위에 덮어쓰지 않는다. (붙여넣기 자체의 편집 안전은 편집기 단위의 몫이다.)
      const at = work.capture("editor");
      const frame = mountReportFrame();
      if (!frame) return;
      const end = frame.read("findings").length;
      const insertion = frame.capture("findings", { start: end, end });
      let text;
      try { text = await navigator.clipboard.readText(); } catch (e) { return; }
      work.commit(at, () => {
        if (reportWriteBlock()) return;
        // Findings 끝에 붙인다. 붙여 넣은 글은 타이핑한 글과 같은 이 문서의 편집이다 — 표시 없이 대입만 하면 자동 저장도
        // 로그아웃도 그 글을 모르고 다음 폴링이 서버 글로 덮는다(U5CLI-F09).
        editReport([{ field: "findings", at: insertion, text }]);
      });
    });
    const reportPreview = KinReportPreview({ api, actorName: displayActor, toast,
      context: () => ({ uid: selectedUid, online: serverMode && !offline && !demoMode,
        editor: Object.fromEntries(RFIELDS.map(key => [key, $("#" + key).value])) }) });
    $("#b-print").addEventListener("click", () => reportPreview.open());

    // Prev/Next: 필터된 목록에서 이전/다음 검사로 이동
    /**
     * Prev/Next — 필터된 목록에서 이전/다음 검사로.
     *
     * 선택된 검사가 목록에 없으면 `findIndex`가 **-1**이다. 예전엔 그대로 더해서
     * `list[-1 + 1]` = 목록 맨 위로 튀었다. 탭을 바꾸거나 필터를 걸어 선택이 빠지면
     * Next가 "다음"이 아니라 "처음"이 되는 것이다. Prev는 `list[-2]`라 아무 일도 안 났다 —
     * 두 버튼이 서로 다르게 틀렸다.
     * 목록 밖이면 방향에 맞게 끝에서 시작한다: Next는 첫 번째, Prev는 마지막.
     *
     * 단, 선택이 목록에서 **빠진 것**은 목록 밖이 아니다(W4-PAGE-05, 설계 v5 §3 "첫 행 회귀 없음"). Approve로 그 검사가 W 필터에서
     * 빠지면 Next는 "처음"이 아니라 그 검사가 서 있던 자리의 다음이어야 한다. 그래서 다음을 줄(queue anchor)로 정한다:
     * 그 검사가 지금 목록에 있으면 지금 목록에서, 없으면 그 검사가 마지막으로 보였던 순서에서 그 뒤(Prev는 그 앞) 검사 가운데
     * 지금 목록에 있는 첫 검사다. 그 검사를 본 순서가 아예 없을 때만(목록 밖에서 연 검사) 예전처럼 끝에서 시작한다.
     */
    function nextStudyFrom(anchor, step) {
      const list = orderedStudies();
      if (!list.length) return null;
      const here = list.findIndex(s => s.uid === anchor.uid);
      if (here !== -1) return list[here + step]?.uid ?? null;
      const order = anchor.order ?? [], at = order.indexOf(anchor.uid);
      if (at === -1) return (step > 0 ? list[0] : list[list.length - 1]).uid;
      const shown = new Set(list.map(s => s.uid));
      for (let i = at + step; i >= 0 && i < order.length; i += step) if (shown.has(order[i])) return order[i];
      return null;
    }
    function move(step) {
      const next = nextStudyFrom({ uid: selectedUid, order: queueSeen?.uid === selectedUid ? queueSeen.order : null }, step);
      if (next) select(next, { openSelected: true });
    }
    $("#b-prev").addEventListener("click", () => move(-1));
    $("#b-next").addEventListener("click", () => move(1));