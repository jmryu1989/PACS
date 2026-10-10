

    // ── 원격판독 의뢰 상태머신 (TS, 6.3.2) ──
    // none → wait → sending → sent → inReading → completed  (+ cancelled/fail)
    async function setTs(uid, ts, teleTo, at = work.capture("document")) {
      const s = studies.find(x => x.uid === uid);
      if (!s) return;
      if (serverMode) {
        // TS는 유일하게 기관을 넘는 상태다. 서버가 거절하면 화면도 되돌린다 —
        // 화면만 앞서 나가면 "보낸 줄 알았는데 안 갔다"가 된다.
        try {
          const st = await api("PATCH", `/studies/${encodeURIComponent(uid)}`,
            teleTo ? { ts, teleTo } : { ts }, undefined, at);
          // 같은 이유로 같은 규칙을 지난다. 이 타이머는 요청된 uid로 돌아오므로 그 검사가
          // 지금 고른 검사가 아닐 수 있다.
          work.commit(at, () => {
            appState[uid] = mergeObservedReportState(uid, st);
            syncStudy(uid); render();
          });
        } catch (e) { work.commit(at, () => toast("원격판독 상태 변경 실패: " + e.message, "err")); }
        return;
      }
      s.ts = ts;
      appState[uid] = { ...appState[uid], ts };
      saveApp(uid, { ts }); render();
    }

    /**
     * 원격판독 의뢰. 이제 "어디로 보내는가"를 반드시 고른다.
     *
     * 예전 시뮬은 혼자서 completed까지 굴러갔다. 기관이 생긴 지금은 그러면 안 된다 —
     * inReading·completed는 **받는 쪽**이 실제로 열고 판독해야 찍히는 상태다.
     * 보낸 쪽이 혼자 "완료"를 그리면 그건 워크플로가 아니라 애니메이션이다. (교훈 §10)
     */
    async function teleRequest(uid) {
      const others = institutions.filter(i => i.id !== myInstitution);
      if (!others.length) { toast("보낼 수 있는 다른 기관이 없습니다", "err"); return; }
      let target = others[0];
      if (others.length > 1) {
        const pick = prompt(
          "원격판독을 받을 기관 번호:\n" + others.map((i, n) => `${n + 1}. ${i.name}`).join("\n"), "1");
        const n = +pick;
        if (!n || !others[n - 1]) return;
        target = others[n - 1];
      } else if (!confirm(`${target.name} 에 원격판독을 의뢰할까요?`)) return;

      // 이 의뢰를 시작한 문맥. 뒤따르는 안내와 예약한 단계는 그것이 그대로일 때만 한다 — 로그아웃 준비·세션 종료 뒤의
      // 타이머가 다음 상태를 서버에 보내지 않는다.
      const at = work.capture("document");
      await setTs(uid, "wait", target.id, at);
      if (!work.commit(at, () => toast(`${target.name} 에 원격판독을 의뢰했습니다 — TS 열에서 진행 상태를 보세요`, "info"))) return;
      // 전송 파이프라인 시뮬레이션(우리 쪽 구간만). 실제 전송 큐는 5단계 Connect.
      setTimeout(() => work.commit(at, () => { if (tsIs(uid, "wait")) setTs(uid, "sending", undefined, at); }), 1200);
      setTimeout(() => work.commit(at, () => { if (tsIs(uid, "sending")) setTs(uid, "sent", undefined, at); }), 3500);
    }
    const tsIs = (uid, v) => (appState[uid]?.ts ?? "none") === v;