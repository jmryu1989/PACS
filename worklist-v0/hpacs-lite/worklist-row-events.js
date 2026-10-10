

    $("#qf").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b || !b.dataset.days) return;
      document.querySelectorAll("#qf button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); quickDays = +b.dataset.days; worklistSearch?.change(); render();
    });

    $("#heads").addEventListener("click", e => {
      const th = e.target.closest("th"); if (!th) return;
      const key = th.dataset.key;
      if (sortKey !== key) { sortKey = key; sortDir = 1; }
      else if (sortDir === 1) sortDir = -1;
      else { sortKey = null; sortDir = 0; }
      render();
    });

    /**
     * 예전엔 RS 뱃지를 클릭하면 W→T→A로 돌았다. 걷어냈다.
     *
     * 그 경로는 `PATCH {rs}`를 쏘아 **판독문 확정을 통째로 우회**했다. 판(version)도
     * 안 쌓이고, 승인자도 안 남고, A→W에 사유도 안 물었다. 사유를 강제하고 폐기 초안까지
     * 남기게 만들어 놓은 Reset이 뱃지 한 번으로 무의미해졌다.
     * (RS가 P인 검사를 클릭하면 매핑에 없어서 `undefined`가 되기까지 했다)
     *
     * RS는 판독문의 생애주기다. Approve/Save/Reset 버튼으로만 움직인다.
     * 서버도 이제 PATCH로 rs를 받지 않는다.
     */
    $("#rows").addEventListener("click", e => {
      const tr = e.target.closest("tr");
      if (!tr?.dataset.uid) return;
      const uid = tr.dataset.uid;
      if (e.target.closest('[data-tech-note]')) { techNote.open(studies.find(s => s.uid === uid)); return; }
      select(uid, { openSelected: true });
      // select()의 render가 클릭한 행을 새 DOM으로 바꾸므로, 새 행에 초점을 다시 남긴다.
      $("#rows").querySelector(`tr[data-uid="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true });
    });
    $("#rows").addEventListener("keydown", e => {
      if (e.target.closest('[data-tech-note]')) return;
      if (e.key !== "Enter" || e.isComposing || mode !== "Radiology") return;
      const tr = e.target.closest("tr[data-uid]");
      if (!tr || tr.dataset.uid !== selectedUid) return;
      e.preventDefault();
      $("#findings").focus();
    });
    $("#rows").addEventListener("dblclick", e => {
      if (e.target.closest('[data-tech-note]')) return;
      const tr = e.target.closest("tr");
      if (tr?.dataset.uid) openFilmbox(tr.dataset.uid, autoPrior(tr.dataset.uid));
    });