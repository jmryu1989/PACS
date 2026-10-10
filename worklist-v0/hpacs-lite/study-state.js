

    const appState = {};
    // Legacy demo data has no authenticated owner; never merge it into this session's drafts.
    let legacyAppState = {};
    try { legacyAppState = JSON.parse(localStorage.getItem("kin-app") ?? "{}"); } catch (e) {}

    // PATCH로 보낼 수 있는 필드. 서버의 STATE_FIELDS와 같아야 한다.
    // 판독 생애주기는 commitReport, matched·orig는 /match·/unmatch만 움직인다.
    const STATE_KEYS = ["ss", "em", "ts", "ward", "reqHosp", "ov"];
    // 서버에서 내려오는(=화면이 못 정하는) 읽기 전용 필드. 이건 PATCH로 보내지 않는다.
    // S4-U5: the display overlay (ov) and a claimed original may only carry these fields, as text (age may be the number
    // ageOf gives). The server refuses any other shape; older stored values are filtered the same way before use.
    const OVERLAY_KEYS = ["id", "name", "sex", "birth", "age", "desc", "ward", "date", "acc", "modality"];
    const overlayValue = (key, value) => typeof value === "string" || (key === "age" && Number.isFinite(value));

    /**
     * 상태 저장. 로컬 모드면 통째로 localStorage에, 서버 모드면 **바뀐 필드만** PATCH.
     *
     * 전체를 보내면 안 되는 이유: 서버가 필드별로 권한을 본다. 방사선사가 Verify(ss)만
     * 눌렀는데 판독의가 남긴 rs까지 딸려 보내면 "판독 상태 변경은 radiologist 권한이
     * 필요합니다"로 거절당한다. 보내는 것이 곧 요구하는 권한이다.
     */
    function saveApp(uid, patch) {
      // 로그인한 계정으로 일하는 중에 서버가 죽었다면, localStorage는 안전한 곳이 아니라
      // **다음 로그인에 조용히 버려질 곳**이다. 쌓지 않고 막는다.
      if (offline) { toast("서버에 연결돼 있지 않습니다 — 저장되지 않았습니다", "err"); return false; }
      if (!serverMode) {
        try { localStorage.setItem("kin-app", JSON.stringify(appState)); } catch (e) {}
        return;
      }
      if (!uid || !patch) return;
      const body = {};
      for (const k of STATE_KEYS) if (patch[k] !== undefined) body[k] = patch[k];
      if (!Object.keys(body).length) return;

      /**
       * **응답을 받아 화면에 반영하고, 실패하면 되돌린다.**
       *
       * 예전엔 쏘고 잊었다(fire-and-forget). 서버가 403·400으로 거절해도 빨간 토스트
       * 한 줄이 전부였고 화면은 바꾼 채로 남았다 — 기사가 뱃지를 눌러 "승인됨"으로
       * 보이는 미판독 검사가 만들어졌다. 화면이 서버보다 앞서 나가면, 사용자는
       * 자기가 한 일이 저장됐다고 믿는다. 그게 조용히 갈라지는 시작이다.
       */
      // 한 검사의 서버 투영이 화면 상태를 대신하는 자리도 목록과 같은 규칙을 지난다 —
      // 이 응답에도 그 검사의 초안이 실려 오므로(`toClient`), 고른 검사가 아닌데 아직
      // 보내지 못한 글을 담고 있으면 그대로 덮여 사라진다.
      // S4-U5: the answer is also returned (true accepted / false refused) so a caller can wait for it before
      // painting; callers that ignore it behave exactly as before.
      const at = work.capture("document");
      return api("PATCH", `/studies/${encodeURIComponent(uid)}`, body, undefined, at)
        .then(st => work.commit(at, () => { appState[uid] = mergeObservedReportState(uid, st); syncStudy(uid); render(); }))
        .catch(async e => {
          if (!work.commit(at, () => apiFail(e))) return false;
          let fresh = null;
          try {
            const r = await api("GET", "/studies", undefined, undefined, at);
            fresh = r.studies.find(x => x.uid === uid);
          } catch (e2) {}
          work.commit(at, () => {
            if (fresh) { appState[uid] = mergeObservedReportState(uid, fresh.state); syncStudy(uid); }
            render(); refreshRight();
          });
          return false;
        });
    }