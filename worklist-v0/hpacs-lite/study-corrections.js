

    // ── Match / Unmatch (8.1.2.1.1 ~ 2) ──
    async function doMatch() {
      const s = cur(), o = curOrder();
      if (!s || !o) { alert("Study List에서 검사 1건, Order List에서 오더 1건을 각각 선택하세요."); return; }
      if (s.matched === "M" || o.matched === "M") { alert("이미 매칭된 항목입니다."); return; }
      if (!confirm(`아래 오더 정보를 검사에 덮어씁니다.\n\n검사: ${s.name} (${s.id}) ${s.date}\n오더: ${o.name} (${o.id}) ${o.sched}\n\n진행할까요?`)) return;

      const a = appState[s.uid] ??= {};
      const orig = a.orig ?? { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      const ov = { id: o.id, name: o.name, sex: o.sex, birth: o.birth, age: ageOf(o.birth, s.date), desc: o.desc, ward: o.ward };

      if (serverMode) {
        // 검사와 오더를 함께 바꾸는 일이라 서버 트랜잭션에 맡긴다.
        // 한쪽만 바뀌면 M/U가 어긋난 유령 상태가 남는다.
        // S4-U5: the server stores a claimed original only in the overlay shape, so only those fields are sent
        // (an age the row could not compute is dropped rather than sent as null).
        const claimed = {};
        for (const key of OVERLAY_KEYS) if (overlayValue(key, orig?.[key])) claimed[key] = orig[key];
        const at = work.capture("document");
        let st;
        try {
          st = await api("POST", "/match", { uid: s.uid, oid: o.oid, patient: { age: ov.age, orig: claimed } }, undefined, at);
        } catch (e) {
          work.commit(at, () => {
            alert("매칭 실패: " + e.message);
            // S4-U5: the refusal keeps the server wording; the panel adds the next step and the Order List is read
            // again, since the server may have refused because the list on this screen was stale.
            noteIdentityCorrection(s.uid, false); refreshOrders();
          });
          return;
        }
        work.commit(at, () => {
          appState[s.uid] = mergeObservedReportState(s.uid, st);
          Object.assign(s, st.ov ?? {}, { matched: "M", ward: st.ward });
          o.matched = "M"; o.studyUid = s.uid;
          // S4-U5: a list answer requested before this match would re-install the unmatched row; drop it and read again.
          commitEpoch++; listLoadSequence++;
          noteIdentityCorrection(s.uid, true); load(); refreshOrders();
          render(); renderOrders(); renderClinical(); renderRelated();
          toast(`매칭 완료 — ${o.name} (${o.id})`);
        });
        return;
      } else {
        a.orig ??= orig; a.ov = ov; a.matched = "M"; a.oid = o.oid;
        Object.assign(s, ov, { matched: "M" });
        o.matched = "M"; o.studyUid = s.uid;
        saveApp(); saveOrders();
      }
      render(); renderOrders(); renderClinical(); renderRelated();
      toast(`매칭 완료 — ${o.name} (${o.id})`);
    }

    async function doUnmatch() {
      const s = cur();
      if (!s || s.matched !== "M") { alert("매칭(M)된 검사를 선택하세요."); return; }
      const a = appState[s.uid] ?? {};

      if (serverMode) {
        const at = work.capture("document");
        let st;
        try {
          st = await api("POST", "/unmatch", { uid: s.uid }, undefined, at);
        } catch (e) {
          work.commit(at, () => {
            alert("매칭 해제 실패: " + e.message);
            noteIdentityCorrection(s.uid, false);
          });
          return;
        }
        work.commit(at, () => {
          appState[s.uid] = { ...mergeObservedReportState(s.uid, st), ov: undefined };
          // S4-U5: back to what the server last read from the DICOM, never to the client-claimed orig. Without
          // those tags the fields stay until the list read below repaints them.
          const read = studyIdentityModel ? KinStudyIdentity.tags(studyIdentityModel, s.uid) : null;
          if (read) Object.assign(s, { id: read.id, name: read.name, sex: read.sex, birth: fmtD(read.birth),
            age: ageOf(fmtD(read.birth), s.date), desc: read.desc });
          s.matched = "U";
          const o = orders.find(x => x.studyUid === s.uid);
          if (o) { o.matched = "U"; o.studyUid = null; }
          commitEpoch++; listLoadSequence++;
          noteIdentityCorrection(s.uid, true); load(); refreshOrders();
          render(); renderOrders(); renderClinical(); renderRelated();
          toast("매칭을 해제했습니다 — 원래 정보로 되돌렸습니다", "info");
        });
        return;
      } else {
        if (a.orig) Object.assign(s, a.orig);
        delete a.ov; a.matched = "U";
        const o = orders.find(x => x.oid === a.oid);
        if (o) { o.matched = "U"; o.studyUid = null; }
        delete a.oid;
        s.matched = "U";
        saveApp(); saveOrders();
      }
      render(); renderOrders(); renderClinical(); renderRelated();
      toast("매칭을 해제했습니다 — 원래 정보로 되돌렸습니다", "info");
    }

    // ── Verify / Unverify (8.1.3) ──
    function setSs(uid, ss) {
      const s = studies.find(x => x.uid === uid); if (!s) return;
      s.ss = ss;
      appState[uid] = { ...appState[uid], ss };
      saveApp(uid, { ss }); render(); renderClinical();
      if (uid === selectedUid) { loadReport(); updateReportButtons(); }
      toast(ss === "Verified"
        ? "검사를 확인했습니다 — 판독할 수 있습니다"
        : "확인을 해제했습니다 — Unverified로 표시되고 판독이 잠깁니다 (응급 제외)", "info");
    }
    $("#t-verify").addEventListener("click", () => selectedUid ? setSs(selectedUid, "Verified") : alert("검사를 선택하세요."));
    $("#t-unverify").addEventListener("click", () => selectedUid ? setSs(selectedUid, "Unverified") : alert("검사를 선택하세요."));

    // ── 장비 수신 ──
    // 예전엔 여기 "장비 수신 시뮬" 버튼이 있었다. localStorage에 가짜 행을 만들 뿐이라
    // 영상도 없고 서버도 몰랐다 — 화면에만 있는 검사였다.
    //
    // 지금은 진짜 장비가 진짜 프로토콜로 보낸다: scripts/send_cstore.py 가
    // DICOM Association을 맺고 C-STORE로 Orthanc(4242)에 인스턴스를 밀어넣는다.
    // 그러면 서버의 검사 목록에 새 검사가 생기고, 아래 폴링이 그걸 집어온다.
    //     python3 send_cstore.py --institution "한림병원"
    // 도착 검사는 Radiology에 촬영중으로 보이고, 비응급은 Verify 뒤에 판독할 수 있다.

    // ── Modify Exam (8.1.2.1.5) ──
    function openModify() {
      const s = cur();
      if (!s) { alert("검사를 선택하세요."); return; }
      if (s.rs !== "W") { alert("판독 전(RS: W)인 검사만 수정할 수 있습니다.\n현재 RS: " + s.rs); return; }
      $("#m-id").value = s.id; $("#m-name").value = s.name; $("#m-sex").value = s.sex || "O";
      $("#m-birth").value = s.birth; $("#m-desc").value = s.desc; $("#m-ward").value = s.ward;
      $("#m-guidance").hidden = true; $("#m-guidance").textContent = "";
      $("#modal").classList.add("show");
    }
    $("#m-cancel").addEventListener("click", () => $("#modal").classList.remove("show"));
    /**
     * S4-U5 Modify Exam save. With a server, nothing is painted, stored locally or announced before the PATCH answer:
     * a refusal leaves the row as it was and the modal open with what was typed, plus the server's own words (toast)
     * and the next step; an accepted answer repaints the row from the server's overlay through applyState. The local
     * (no server) path is the previous behavior.
     */
    async function saveModify(event) {
      const s = cur(); if (!s) return;
      const uid = s.uid, button = event.currentTarget;
      const a = appState[uid] ??= {};
      const birth = $("#m-birth").value.trim();
      const ov = {};
      for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) ov[key] = a.ov[key];
      Object.assign(ov, {
        id: $("#m-id").value.trim(), name: $("#m-name").value.trim(), sex: $("#m-sex").value,
        birth, age: ageOf(birth, s.date), desc: $("#m-desc").value.trim(), ward: $("#m-ward").value.trim() });
      if (serverMode || offline) {
        const guidance = $("#m-guidance");
        guidance.hidden = true; guidance.textContent = "";
        button.disabled = true;
        const at = work.capture("document");
        let ok = false;
        // 이 저장이 잠근 단추는 이 저장이 푼다(자기 것만).
        try { ok = await saveApp(uid, { ov }) === true; } finally { button.disabled = false; }
        work.commit(at, () => {
          if (!ok) {
            if (!serverMode) return;
            noteIdentityCorrection(uid, false);
            guidance.textContent = window.KinStudyIdentity?.guidance(appState[uid]?.rs ?? "W", true, s.tele === true) ?? "";
            guidance.hidden = !guidance.textContent;
            return;
          }
          const row = studies.find(x => x.uid === uid);
          if (row) applyState(row);
          noteIdentityCorrection(uid, true);
          modified();
        });
        return;
      }
      a.orig ??= { id: s.id, name: s.name, sex: s.sex, birth: s.birth, age: s.age, desc: s.desc, ward: s.ward };
      a.ov = ov;
      Object.assign(s, a.ov);
      saveApp(uid, { ov: a.ov });
      modified();
      function modified() {
        $("#modal").classList.remove("show");
        render(); renderClinical(); renderRelated(); renderOrders();
        toast("검사 정보를 수정했습니다");
        // An older list answer would still carry the previous overlay; drop it and read the list again.
        if (serverMode) { commitEpoch++; listLoadSequence++; load(); }
      }
    }
    $("#m-save").addEventListener("click", saveModify);
    $("#t-modify").addEventListener("click", openModify);

    // ── Delete (8.1.2.1.8) ──
    async function doDelete(uid) {
      const s = studies.find(x => x.uid === uid); if (!s) return;
      if (s.rs !== "W") { alert("RS가 W(Wait)인 검사만 삭제할 수 있습니다."); return; }
      // 영상 자체(Orthanc)를 지우는 것은 아직 안 한다. 되돌릴 수 없는 동작이라
      // 권한·감사로그·연쇄 해제를 갖춰야 한다 (교훈 §5). 지금 지울 수 있는 건
      // "영상에 대한 사람의 결정"뿐이고, 그러면 다음 목록 조회 때 그 검사는
      // **막 도착한 검사처럼 다시 나타난다.** 그게 이 동작의 진짜 의미다.
      if (!confirm(`이 검사의 판독 상태·매칭 기록을 지웁니다.\n${s.name} (${s.id}) ${s.date}\n` +
                   `영상은 남고, 검사는 방금 도착한 것처럼 다시 나타납니다. 계속할까요?`)) return;
      // 서버가 거절했는데 화면부터 지우면 검사가 사라진 것처럼 거짓말한다.
      // 응답을 기다려야 판독 이력·다른 사람의 초안 때문에 거절된 이유도 메뉴의 catch가 보여준다.
      const at = work.capture("document");
      if (serverMode) await api("DELETE", `/studies/${encodeURIComponent(uid)}`, undefined, undefined, at);
      else saveApp();
      work.commit(at, () => {
        studies = studies.filter(x => x.uid !== uid);
        delete appState[uid];
        if (selectedUid === uid) {
          markSelectionChanged(null);
          relatedUid = null;
          relatedReportSeq += 1;
          clearRelatedReport();
          refreshRight();
        }
        render();
        toast("검사를 삭제했습니다", "info");
      });
    }