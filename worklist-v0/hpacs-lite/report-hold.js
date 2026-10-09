

    // ══════════ 동시 판독 점유 (교훈 §2) ══════════
    // 점유는 **열람이 아니라 쓰기**로 시작한다. 검사를 열어보는 건 흔한 일이고,
    // 그걸 점유로 치면 경고가 남발되며, 남발된 경고는 아무도 안 본다.
    let heldUid = null, heartbeat = null, warnedFor = null, holdPending = null;
    const HOLD_MIN_CHARS = 2;      // "두 글자 이상 입력" — HPACS가 2021년에 정한 기준
    const HEARTBEAT_MS = 60000;    // 서버 TTL(5분)보다 충분히 짧게

    /** 충돌로 점유를 못 잡은 검사. 키 입력마다 다시 물어보지 않기 위한 기억 */
    let holdBlocked = null;   // { uid, at }
    const HOLD_RETRY_MS = 60000;

    async function claimHold(uid) {
      // 타이핑은 글자마다 input 이벤트를 낸다. 가드가 없으면 요청이 열 개씩 겹치고,
      // 뒤늦게 도착한 하나가 `await releaseHold()` 구간에서 방금 잡은 점유를 스스로 푼다.
      // (실제로 그렇게 됐다 — 화면엔 잡힌 것처럼 보이는데 서버는 비어 있었다)
      if (!serverMode || heldUid === uid || holdPending === uid) return;
      /**
       * **충돌한 검사에 키 입력마다 요청을 보내지 않는다.**
       *
       * 충돌(`r.conflict`) 시에는 `heldUid`를 안 잡는다 — 잡으면 안 되니까. 그런데
       * 그러면 위의 `heldUid === uid` 가드가 영원히 통과하지 못해, 글자마다
       * `POST /hold`가 나갔다. 500자를 쓰면 요청 500번. 토스트는 한 번만 떠서
       * 아무도 눈치채지 못한다.
       * 그렇다고 영영 포기하지도 않는다 — 상대가 놓을 수 있으므로 1분마다 다시 묻는다.
       */
      if (holdBlocked?.uid === uid && Date.now() - holdBlocked.at < HOLD_RETRY_MS) return;
      holdPending = uid;
      // 이 점유 요청을 시작한 문맥. 답이 화면·점유 상태에 닿는 자리는 이것을 지난다 — 준비·종료 뒤에 온 답은 점유도 갱신
      // 타이머도 세우지 않는다(그 점유는 서버의 TTL이 거둔다).
      const at = work.capture("document");
      try {
        if (heldUid && heldUid !== uid) await releaseHold();
      } catch (e) {}
      try {
        const r = await api("POST", `/studies/${encodeURIComponent(uid)}/hold`, undefined, undefined, at);
        if (!work.admits(at)) return;
        const s = studies.find(x => x.uid === uid);
        if (s) s.holder = r.holder;
        appState[uid] = { ...appState[uid], holder: r.holder };
        render();
        if (uid === selectedUid) { updateReportButtons(); loadReport(); }

        if (r.conflict) {
          // 남의 점유는 뺏지 않는다. 잠금 해제는 폴링이나 다음 점유 응답으로 반영한다.
          holdBlocked = { uid, at: Date.now() };
          if (warnedFor !== uid) {
            warnedFor = uid;
            toast(`${displayActor(r.holder)} 님이 먼저 판독을 시작했습니다 — 잠금이 풀리면 이어서 할 수 있습니다`, "err");
          }
          return;
        }
        holdBlocked = null;

        /**
         * **응답이 돌아왔을 때 내가 아직 그 검사에 있는가.**
         *
         * `claimHold(A)`가 나가 있는 동안 B를 선택하면, `select()`의 `releaseHold()`는
         * 아무것도 안 한다 — 아직 `heldUid`가 A가 아니기 때문이다. 그리고 A의 응답이
         * 도착해 **떠나온 A를 내 이름으로 점유**한 채 60초마다 하트비트를 돈다.
         * 다른 판독의에게는 내가 A를 붙잡고 있는 것으로 보인다. 영원히.
         *
         * 가드가 한 방향(요청 겹침)만 막고 반대 방향(선택 이동)을 안 막은 자리였다.
         */
        if (uid !== selectedUid) {
          try { await api("POST", `/studies/${encodeURIComponent(uid)}/release`, undefined, undefined, at); } catch (e) {}
          work.commit(at, () => {
            if (appState[uid]) appState[uid].holder = null;
            const s2 = studies.find(x => x.uid === uid);
            if (s2) s2.holder = null;
            render();
          });
          return;
        }

        heldUid = uid;
        clearInterval(heartbeat);
        // 갱신은 주기마다 그때의 문맥으로 나간다: 준비 중에는 전송이 보내지 않고, 세션이 끝나면 종료 조정이 타이머를 치운다.
        heartbeat = setInterval(() => {
          if (heldUid) api("POST", `/studies/${encodeURIComponent(heldUid)}/hold`).catch(() => {});
        }, HEARTBEAT_MS);
      } catch (e) { /* 점유 실패로 판독을 막지는 않는다 */ }
      // 이 요청이 세운 대기 표시는 이 요청이 내린다(자기 것만).
      finally { if (holdPending === uid) holdPending = null; }
    }

    async function releaseHold({ closing = false } = {}) {
      if (!serverMode || !heldUid) return;
      const uid = heldUid;
      heldUid = null;
      clearInterval(heartbeat); heartbeat = null;
      const s = studies.find(x => x.uid === uid);
      if (s) s.holder = undefined;
      if (appState[uid]) appState[uid].holder = undefined;
      // 세션을 끝내는 중의 해제(auth.js가 종료 기록·통지 뒤, 로그아웃 POST 앞에 부른다)는 업무가 아니라 그 종료의 일부다:
      // 닫힌 문서의 수명주기 문맥으로, 끝나는 그 세션의 식별값을 실어 나간다. 그 밖에는 평소의 업무 요청이다.
      const at = work.capture(closing ? "lifecycle" : "document");
      try { await transport.request(`${API}/studies/${encodeURIComponent(uid)}/release`, { method: "POST", context: at }); } catch (e) {}
    }

    // 판독문에 두 글자 이상 쓰면 그때 점유가 시작된다
    ["#findings", "#conclusion", "#recommendation"].forEach(sel =>
      $(sel).addEventListener("input", () => {
        updateReportTemplateButton();
        if (!selectedUid) return;
        const total = $("#findings").value.length + $("#conclusion").value.length + $("#recommendation").value.length;
        if (total >= HOLD_MIN_CHARS) claimHold(selectedUid);
      }));