

    /**
     * 날짜 퀵필터. "최근 N일" — **양쪽 끝을 다 본다.**
     *
     * 두 가지가 틀려 있었다:
     *
     * ① 타임존. `new Date("2026-08-28")`은 ISO 날짜만 있는 문자열이라 **UTC 자정**으로
     *    읽히는데, 비교 대상은 `setHours(0,0,0,0)`이 만든 **로컬 자정**이었다.
     *    KST(UTC+9)에서는 검사 날짜가 9시간 앞으로 밀려 우연히 맞았지만,
     *    UTC 음수 오프셋에서는 뒤로 밀려 **"Today"가 오늘 검사를 숨긴다.**
     *    숫자를 직접 뜯어 로컬 기준으로 만든다 — 파서의 기분에 맡기지 않는다.
     *
     * ② 상한이 없었다. 미래 날짜(장비 시계가 틀렸거나 오타)가 "최근 7일"에 걸렸다.
     *    "최근"은 과거를 가리키는 말이다.
     */
    function dayStart(dateStr) {
      const m = String(dateStr).match(/^(\d{4})-?(\d{2})-?(\d{2})/);
      if (!m) return null;
      return new Date(+m[1], +m[2] - 1, +m[3]);   // 로컬 자정
    }
    function withinDays(dateStr, days) {
      if (days < 0 || !dateStr) return true;
      const d = dayStart(dateStr);
      if (!d) return true;                        // 못 읽는 날짜는 숨기지 않는다
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const from = new Date(today); from.setDate(from.getDate() - days);
      const to = new Date(today); to.setDate(to.getDate() + 1);   // 오늘 끝까지
      return d >= from && d < to;
    }

    function testCol(s, c, values = fval) {
      const v = values?.[c.k] ?? "";
      if (v === "") return true;
      const wanted = String(v);
      if (c.f === "text") return String(s[c.k] ?? "").toUpperCase().includes(wanted.toUpperCase());
      return String(s[c.k]) === wanted;
    }

    let consultationFilterSequence = 0;

    // ── 모드 전환 ──
    function setMode(m) {
      mode = m;
      document.querySelectorAll(".tabs > div").forEach(x => x.classList.toggle("on", x.dataset.tab === m));
      const tech = m === "Technician";
      $("#ctxbar").classList.toggle("show", tech);
      document.querySelector(".s-template").style.display = tech ? "none" : "flex";
      document.querySelector(".s-clinical").style.width = tech ? "66%" : "30%";
      document.querySelector(".report-p").style.display = tech ? "none" : "flex";
      document.querySelector(".order-p").style.display = tech ? "flex" : "none";
      $("#routing-factors").hidden = tech;
      // 탭을 바꿔도 **같은 컬럼이 양쪽에 있으면 정렬을 유지한다.**
      // 두 탭의 컬럼 구성이 달라서 예전엔 무조건 초기화했는데, id·name·date처럼
      // 양쪽에 다 있는 컬럼까지 풀리는 건 그냥 손해다.
      // 탭 전환은 화면 전환이지 상태 초기화가 아니다 (교훈 §6 — HPACS가 세 번 낸 버그).
      if (sortKey && !COLS[m].some(c => c.k === sortKey)) { sortKey = null; sortDir = 0; }
      worklistSearch?.apply();
      renderHeads(); render(); renderOrders(); renderRelated();
      applyLayout();
    }
    document.querySelector(".tabs").addEventListener("click", e => {
      const t = e.target.closest("div[data-tab]"); if (!t) return;
      setMode(t.dataset.tab);
    });
    $("#fold").addEventListener("click", () => {
      const b = $("#ctxbtns");
      const hidden = b.style.display === "none";
      b.style.display = hidden ? "flex" : "none";
      $("#fold").textContent = hidden ? "▽" : "△";
    });