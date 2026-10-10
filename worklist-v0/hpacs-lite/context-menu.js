

    // ══════════ 우클릭 컨텍스트 메뉴 (모드·대상에 따라 항목이 달라짐) ══════════
    const ctx = $("#ctx");
    let ctxItems = [];
    let ctxOpener = null;
    function showCtx(e, items, keyboard = null) {
      ctxOpener = document.activeElement;
      ctxItems = items;
      ctx.setAttribute('role', 'menu');
      ctx.innerHTML = items.map((it, i) =>
        it.sep ? '<hr role="separator">' : `<div data-i="${i}" role="menuitem" tabindex="-1" aria-disabled="${!!it.dis}" class="${it.dis ? "dis" : ""}">${esc(it.label)}</div>`).join("");
      ctx.style.left = Math.max(0, Math.min(keyboard?.x ?? e.clientX, innerWidth - 200)) + "px";
      ctx.style.top = Math.max(0, Math.min(keyboard?.y ?? e.clientY, innerHeight - (items.length * 28 + 20))) + "px";
      ctx.style.display = "block";
      if (keyboard?.focus) ctx.querySelector('[data-i]:not(.dis)')?.focus();
    }
    ctx.addEventListener('keydown', e => {
      const items = [...ctx.querySelectorAll('[data-i]:not(.dis)')];
      const index = items.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation(); items[index]?.click();
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (e.key === 'Escape') e.preventDefault();
        e.stopPropagation(); ctx.style.display = 'none'; ctxOpener?.focus();
      }
    });
    ctx.addEventListener("click", async e => {
      const d = e.target.closest("div[data-i]"); if (!d) return;
      const it = ctxItems[+d.dataset.i];
      if (it.dis) return;
      ctx.style.display = 'none';
      ctxOpener?.focus();
      /**
       * **`act()`를 await하고 catch한다.**
       *
       * 메뉴 항목의 절반이 async다(원격판독 의뢰, Match/Unmatch, 삭제…).
       * 예전엔 그냥 `it.act()`라 예외가 unhandled rejection으로 콘솔에만 남고
       * **사용자에게는 아무 반응도 없었다.** 눌렀는데 아무 일도 안 일어나면
       * 사람은 한 번 더 누른다 — 되돌릴 수 없는 항목에서는 그게 두 번 실행이다.
       */
      const at = work.capture("document");
      try { await it.act(); }
      // 항목이 기다리는 사이 작업 문맥이 바뀌었으면(로그아웃 준비·세션 종료) 그 실패는 알릴 실패가 아니다.
      catch (err) { work.commit(at, () => toast(`"${it.label}" 실패: ${err?.message ?? err}`, "err")); }
    });
    document.addEventListener("click", () => ctx.style.display = "none");

    $("#rows").addEventListener("contextmenu", e => {
      const tr = e.target.closest("tr");
      if (!tr?.dataset.uid) return;
      e.preventDefault();
      const uid = tr.dataset.uid;
      select(uid);
      const s = studies.find(x => x.uid === uid);
      const forceReleaseItems = KinAuth.has("admin") && s?.holder ? [{
        label: "점유 강제 해제 (관리자)", dis: s.holder === user, act: async () => {
          if (!confirm(`${displayActor(s.holder)} 님의 점유를 강제로 해제합니다. 그쪽 화면은 다음 저장에서 거절됩니다. 계속할까요?`)) return;
          const at = work.capture("document");
          try { await api("POST", `/studies/${encodeURIComponent(uid)}/release/force`, undefined, undefined, at); }
          catch (e) { work.commit(at, () => apiFail(e)); return; }
          work.commit(at, () => {
            s.holder = null;
            appState[uid] = { ...appState[uid], holder: null };
            render();
            if (uid === selectedUid) { updateReportButtons(); loadReport(); }
            toast("점유를 해제했습니다 (감사로그 기록)");
          });
        },
      }] : [];
      if (mode === "Radiology") {
        const ts = appState[uid]?.ts ?? "none";
        const requested = !["none", "cancelled", "fail"].includes(ts);
        // 받는 쪽(원격판독으로 넘어온 검사)과 보내는 쪽은 할 수 있는 일이 다르다.
        // 서버도 같은 규칙으로 막지만, 회색으로 보이는 편이 눌러보고 거절당하는 것보다 낫다.
        const mine = !s?.tele;
        showCtx(e, [
          { label: "Film Box 열기", act: () => openFilmbox(uid) },
          { label: "판독문 작성으로", act: () => $("#findings").focus() },
          { sep: 1 },
          { label: "원격판독 의뢰 (Tele Request)", dis: !mine || requested, act: () => teleRequest(uid) },
          { label: "의뢰 취소", dis: !mine || !["wait", "sending", "sent"].includes(ts), act: () => setTs(uid, "cancelled") },
          { sep: 1 },
          { label: "판독 시작 (수신 기관)", dis: mine || ts !== "sent", act: () => setTs(uid, "inReading") },
          ...forceReleaseItems,
        ]);
      } else {
        const o = curOrder();
        showCtx(e, [
          { label: "Match", dis: !(o && s.matched === "U" && o.matched === "U"), act: doMatch },
          { label: "Unmatch", dis: s.matched !== "M", act: doUnmatch },
          { sep: 1 },
          { label: "Verify", dis: s.ss === "Verified", act: () => setSs(uid, "Verified") },
          { label: "Unverify", dis: s.ss === "Unverified", act: () => setSs(uid, "Unverified") },
          { label: "Modify Exam", dis: s.rs !== "W", act: openModify },
          { sep: 1 },
          emergencyMenu(uid),
          { label: "Switch ReqHosp", act: () => {
              const v = prompt("의뢰 병원(ReqHosp):", s.reqHosp);
              if (v == null) return;
              s.reqHosp = v.trim() || "KIN";
              appState[uid] = { ...appState[uid], reqHosp: s.reqHosp };
              saveApp(uid, { reqHosp: s.reqHosp }); render(); renderRelated();
            } },
          { label: "Merge / Split Exam", dis: 1, act: () => {} },
          { sep: 1 },
          { label: "Delete", dis: s.rs !== "W", act: () => doDelete(uid) },
          ...forceReleaseItems,
        ]);
      }
    });

    $("#orderrows").addEventListener("contextmenu", e => {
      const tr = e.target.closest("tr[data-oid]"); if (!tr) return;
      e.preventDefault();
      selectedOid = tr.dataset.oid; renderOrders();
      const o = curOrder(), s = cur();
      showCtx(e, [
        { label: "Match", dis: !(s && s.matched === "U" && o.matched === "U"), act: doMatch },
        // selectedUid를 직접 대입하면 안 된다. select()가 하는 일 — 쓰던 판독문 저장,
        // 점유 해제, 오른쪽 판 갱신 — 이 전부 건너뛰어진다. 그 상태로 다음 검사를 고르면
        // **앞 환자의 소견이 뒤 환자에게 저장된다.** 실제로 그렇게 되는 코드였다.
        { label: "Unmatch", dis: o.matched !== "M", act: async () => {
            const s2 = studies.find(x => x.uid === o.studyUid);
            if (!s2) { toast("이 오더에 매칭된 검사를 목록에서 찾을 수 없습니다", "err"); return; }
            await select(s2.uid);
            doUnmatch();
          } },
        { sep: 1 },
        { label: "New Exam (SC 생성)", dis: 1, act: () => {} },
      ]);
    });