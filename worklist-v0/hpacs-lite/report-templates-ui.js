
    $("#t-mod").addEventListener("change", renderTemplates);
    $("#t-body").addEventListener("change", renderTemplates);
    $("#tpl-filter-clear").addEventListener("click", () => {
      $("#tpl-search").value = ""; $("#t-body").value = ""; $("#t-mod").checked = false;
      renderTemplates(); $("#tpl-search").focus();
    });
    $("#tpl-search").addEventListener("input", renderTemplates);
    $("#tpl-search-clear").addEventListener("click", () => {
      $("#tpl-search").value = ""; renderTemplates(); $("#tpl-search").focus();
    });

    let templatePreview = null, templatePreviewReturn = null;
    function closeTemplatePreview(returnFocus = true) {
      if (!templatePreview) return;
      templatePreview = null;
      $("#tpl-preview").classList.remove("show");
      $("#tpl-preview-insert").disabled = true;
      delete $("#tpl-preview-target").dataset.uid;
      for (const id of ["title", "meta", "target", "status", ...RFIELDS]) $("#tpl-preview-" + id).textContent = "";
      if (returnFocus) (templatePreviewReturn?.isConnected ? templatePreviewReturn : $("#tpl-search")).focus();
      templatePreviewReturn = null;
    }
    function updateTemplatePreview() {
      if (!templatePreview) return;
      if (templatePreview.uid !== selectedUid) { closeTemplatePreview(false); return; }
      const s = cur(), why = templateInsertionBlock(templatePreview.template);
      $("#tpl-preview-target").dataset.uid = selectedUid ?? "";
      $("#tpl-preview-target").textContent = s ? `삽입 대상: ${s.name} (${s.id})\n${s.date} · ${shownStudyDesc(s)} · AccNo: ${s.acc || "없음"}` : "삽입 대상: 검사 미선택";
      $("#tpl-preview-status").textContent = why ?? (s?.rs === "A"
        ? "삽입은 개인 초안에 반영됩니다. 승인본에 추가하려면 Addendum을 사용하세요."
        : "삽입은 개인 초안에 반영됩니다. 확정하려면 Save 또는 Approve를 사용하세요.");
      $("#tpl-preview-insert").disabled = !!why;
    }
    $("#tplrows").addEventListener("click", e => {
      const button = e.target.closest("[data-tpl-preview]"); if (!button) return;
      const tr = button.closest("tr[data-i]"), t = templates[+tr.dataset.i]; if (!t) return;
      // 목록이 새로 로드돼도, 삽입은 사람이 미리보기에서 읽은 문장과 같아야 한다.
      templatePreview = { uid: selectedUid, template: Object.fromEntries(
        ["title", "shortcut", "modality", "bodypart", ...RFIELDS].map(k => [k, String(t[k] ?? "")])) };
      templatePreviewReturn = button;
      const snapshot = templatePreview.template;
      $("#tpl-preview-title").textContent = `상용구 미리보기 — ${snapshot.title}`;
      $("#tpl-preview-meta").textContent = `단축어: ${snapshot.shortcut || "없음"} · Modality: ${snapshot.modality || "전체"} · Bodypart: ${snapshot.bodypart || "미지정"}`;
      for (const k of RFIELDS) $("#tpl-preview-" + k).textContent = snapshot[k] || "(내용 없음)";
      updateTemplatePreview();
      $("#tpl-preview").classList.add("show");
      $("#tpl-preview-close").focus();
    });
    $("#tpl-preview-close").addEventListener("click", () => closeTemplatePreview());
    $("#tpl-preview-insert").addEventListener("click", () => {
      if (!templatePreview || templatePreview.uid !== selectedUid) { closeTemplatePreview(false); return; }
      if (insertTemplate(templatePreview.template)) closeTemplatePreview();
      else updateTemplatePreview();
    });
    $("#tpl-preview").addEventListener("click", e => { if (e.target.id === "tpl-preview") closeTemplatePreview(); });
    $("#tpl-preview").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeTemplatePreview(); }
      if (e.key === "Tab") {
        e.preventDefault();
        // 긴 문장을 키보드로 스크롤하면서도 삽입 대상은 계속 볼 수 있어야 한다.
        const controls = [$("#tpl-preview .tpl-preview-body"), $("#tpl-preview-close"), $("#tpl-preview-insert")].filter(b => !b.disabled);
        const index = controls.indexOf(document.activeElement);
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    });
    window.addEventListener("pagehide", () => closeTemplatePreview(false));

    /**
     * **단축어(shortcut)를 실제로 동작시킨다.**
     *
     * 지금까지 이 필드는 등록도 되고 목록에 보이기도 했지만 **아무 데도 안 쓰였다.**
     * 판독의가 "nbct"를 등록하고 눌러봐야 아무 일도 안 일어난다 — 있는 척하는 기능은
     * 없는 기능보다 나쁘다. 무엇을 잘못했나 찾게 만들기 때문이다.
     *
     * 동작: 판독문 칸에서 단축어를 치고 **Tab**을 누르면 그 자리에서 펼쳐진다.
     * Tab을 가로채는 건 커서 바로 앞 단어가 등록된 단축어일 때뿐이다 —
     * 그 외에는 평소대로 다음 칸으로 넘어간다.
     */
    function expandShortcut(el) {
      const pos = el.selectionStart;
      if (pos !== el.selectionEnd) return false;
      const before = el.value.slice(0, pos);
      const word = (before.match(/[A-Za-z0-9가-힣_-]+$/) ?? [""])[0];
      if (!word) return false;
      const t = templates.find(x => x.shortcut && x.shortcut === word);
      if (!t) return false;
      // 어느 칸에서 눌렀든 그 칸에 맞는 내용을 넣는다. Findings 칸에서 Conclusion을
      // 펼치면 판독문이 섞인다 — 상용구는 칸마다 다른 문장이다.
      const text = el.id === "conclusion" ? (t.conclusion ?? "")
                 : el.id === "recommendation" ? (t.recommendation ?? "")
                 : (t.findings ?? "");
      if (!text) return false;
      // 단축어 자리를 그 칸의 문장으로 바꾼다. 표시·점유·자동 저장은 편집기의 한 자리(`editReport`)가 챙긴다.
      if (!editReport([{ field: el.id, start: pos - word.length, end: pos, text }])) return false;
      toast(`상용구 "${t.title}" 삽입`, "info");
      return true;
    }
    // 단축어 Tab(아래 등록)이 부르는 편집기의 한 자리다. 분할된 script 사이의 Tab이 미정의를 만나지 않게 등록보다 앞에 둔다(S9-U0a-PRE).
    /**
     * 판독문 칸(`#findings`·`#conclusion`·`#recommendation`)의 글을 **이 문서의 코드가** 바꾸는 한 자리.
     *
     * 사람의 타건은 input 이벤트가 알리지만 스크립트의 `.value` 대입은 아무것도 알리지 않는다. 대입하는 자리마다 "이 글은
     * 서버가 아직 모른다"는 표시를 각자 챙기게 두면, 한 자리가 빠지는 순간 그 글은 자동 저장·로그아웃 보존·떠나기 경고
     * 어디에도 없고 다음 폴링이 서버 글로 덮는다(U5CLI-F09: Paste와 Clear가 그랬다). 그래서 값을 바꾸는 일과 그 기록을
     * 이 함수 하나가 함께 한다 — 붙여넣기·비우기·상용구·받아쓰기·단축어·인용·구조화가 모두 여기를 지난다. 이 함수 밖에서
     * 세 칸에 대입하는 곳은 둘뿐이다: 서버의 글을 그리는 `loadReport`와 화면을 닫는 `closeWork`(둘 다 이 문서의 편집이
     * 아니다).
     *
     * `edits`는 `{ field, start, end, text[, caret] }`의 목록이다: 그 칸의 지금 글에서 [start, end)를 text로 바꾸고 커서를
     * caret(없으면 넣은 글의 끝)에 둔다. 칸·범위·넣을 글로 받는 것은 편집기 경계 모듈(report-editor-frame.js의
     * capture + insert / insertMany)이 같은 것을 받기 때문이다. 쓸 수 있는가(권한·잠금·그때 그 선택인가)는 부르는 쪽이
     * 이미 확인했다. 여기서는 업무 중인 문서의 고른 검사일 때만 쓰고, 글이 실제로 바뀌었는지를 돌려준다 — 아무것도 바꾸지
     * 않은 호출(빈 붙여넣기 등)은 편집이 아니므로 표시도 세우지 않는다.
     */
    function editReport(edits) {
      if (work.state() !== "active" || !selectedUid) return false;
      const changed = [];
      for (const { field, start, end, text, caret } of edits) {
        const el = $("#" + field), was = el.value;
        if (was.slice(start, end) === text) continue;
        el.value = was.slice(0, start) + text + was.slice(end);
        const at = caret ?? start + text.length;
        el.setSelectionRange(at, at);
        changed.push(el);
      }
      if (!changed.length) return false;
      // 편집기의 글이 바뀌었다 — 그 전에 떠난 편집기 범위의 작업(클립보드 읽기 등)은 이 글 위에 쓰지 않는다.
      work.edited();
      recordReportEdit();
      // 글이 바뀐 뒤에 따라오는 일(점유 시작, 인용 다시 세기, 상용구 단추, 받아쓰기 자리)은 타이핑과 같은 input이 알린다.
      for (const el of changed) el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    ["#findings", "#conclusion", "#recommendation"].forEach(sel =>
      $(sel).addEventListener("keydown", e => {
        if (e.key !== "Tab" || e.shiftKey || e.target.readOnly) return;
        if (expandShortcut(e.target)) e.preventDefault();
      }));

    /**
     * 상용구 편집. 매뉴얼 7.3.5.1.1대로 목록에서 우클릭해 만든다.
     * 지금까지는 기본 3종만 있고 추가할 방법이 아예 없었다 — 있으나 마나였다.
     *
     * **입력을 prompt에서 모달로 바꿨다.** prompt는 줄바꿈을 입력할 수 없어서,
     * 여러 줄인 기본 상용구를 "수정"으로 열면 한 줄로 뭉개진 채 영구 저장됐다.
     * 게다가 `?? ""` 때문에 중간에 Cancel을 눌러도 빈 값이 저장됐다 —
     * 취소가 취소가 아니라 삭제였다.
     */
    let templateEditor = null;
    function currentTemplateText() {
      return Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value]));
    }
    function reportTemplateAccessBlock() {
      const why = reportWriteBlock();
      if (why) return why;
      if (!cur()) return "출처 검사를 확인할 수 없습니다. Refresh로 다시 확인하세요";
      if (RFIELDS.some(k => $("#" + k).readOnly)) return "현재 판독문은 편집할 수 없습니다";
      return null;
    }
    function reportTemplateBlock() {
      return reportTemplateAccessBlock() || (RFIELDS.every(k => !$("#" + k).value) ? "상용구로 저장할 내용이 없습니다" : null);
    }
    function updateReportTemplateButton() {
      const why = reportTemplateBlock();
      $("#b-report-template").disabled = !!why;
      $("#b-report-template").title = why ?? "현재 세 칸을 새 개인 상용구 편집창으로 가져옵니다";
      if (templateEditor?.source && templateEditor.source.uid !== selectedUid) closeTemplateEditor(false);
      updateTemplateEditor();
    }
    function updateTemplateEditor() {
      const session = templateEditor;
      if (!session) return;
      // 늦은 초안 버리기 응답은 원판독을 비울 수 있다. 이미 복사한 편집문은 출처 접근 조건만 다시 검사한다.
      const why = session.source ? reportTemplateAccessBlock() : null;
      for (const el of document.querySelectorAll("#tplmodal input, #tplmodal textarea")) el.disabled = session.pending;
      $("#tpl-cancel").disabled = session.pending;
      $("#tpl-save").disabled = session.pending || !!why;
      $("#tpl-save").textContent = session.pending ? "저장 중…" : "저장";
      $("#tpl-save").title = why ?? "";
      if (session.source) $("#tpl-source").textContent = session.source.label + "\n"
        + (why ?? "재사용할 문장만 남기고 제목을 입력하세요. 저장은 개인 상용구에만 반영됩니다.");
    }
    function closeTemplateEditor(returnFocus = true) {
      const session = templateEditor;
      if (!session) return;
      templateEditor = null;
      $("#tplmodal").classList.remove("show");
      for (const el of document.querySelectorAll("#tplmodal input, #tplmodal textarea")) { el.value = ""; el.disabled = false; }
      $("#tpl-source").textContent = ""; $("#tpl-source").hidden = true;
      delete $("#tpl-source").dataset.uid;
      $("#tpl-save").disabled = true; $("#tpl-save").textContent = "저장";
      $("#tpl-cancel").disabled = false;
      if (returnFocus && session.returnFocus?.isConnected) session.returnFocus.focus();
    }
    function editTemplate(t, source = null, seed = t) {
      if (!KinAuth.has("radiologist")) { toast("판독의만 상용구를 편집할 수 있습니다", "err"); return; }
      templateEditor = { editing: t, source, pending: false, returnFocus: document.activeElement };
      $("#tpl-title").textContent = source ? "현재 판독문으로 새 상용구" : t ? `상용구 수정 — ${t.title}` : "새 상용구";
      for (const [id, key] of [["t", "title"], ["s", "shortcut"], ["m", "modality"], ["b", "bodypart"],
                               ["f", "findings"], ["c", "conclusion"], ["r", "recommendation"]]) {
        $("#tpl-" + id).value = seed?.[key] ?? "";
      }
      $("#tpl-source").hidden = !source;
      if (source) $("#tpl-source").dataset.uid = source.uid;
      else { $("#tpl-source").textContent = ""; delete $("#tpl-source").dataset.uid; }
      updateTemplateEditor();
      $("#tplmodal").classList.add("show");
      $("#tpl-t").focus();
    }
    $("#b-report-template").addEventListener("click", () => {
      const why = reportTemplateBlock();
      if (why) { toast(why, why === "상용구로 저장할 내용이 없습니다" ? "info" : "err"); return; }
      const s = cur(), text = currentTemplateText();
      const modalities = String(s.modality ?? "").split(",").map(value => value.trim()).filter(Boolean);
      // 환자 식별은 출처 확인에만 쓴다. 재사용 문장/제목에 검사 식별을 자동으로 섞지 않는다.
      editTemplate(null, { uid: selectedUid,
        label: `가져온 검사: ${s.name} (${s.id})\n${s.date} · ${shownStudyDesc(s)} · AccNo: ${s.acc || "없음"}` },
        { ...text, modality: modalities.length === 1 ? modalities[0] : "" });
    });
    // 취소는 아무것도 안 한다. 저장을 누른 것만이 저장이다.
    $("#tpl-cancel").addEventListener("click", () => { if (!templateEditor?.pending) closeTemplateEditor(); });
    $("#tplmodal").addEventListener("click", e => { if (e.target.id === "tplmodal") $("#tpl-cancel").click(); });
    $("#tplmodal").addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); $("#tpl-cancel").click(); }
      if (e.key === "Tab") {
        const controls = [...document.querySelectorAll("#tplmodal input, #tplmodal textarea, #tplmodal button")].filter(el => !el.disabled);
        e.preventDefault();
        if (controls.length) controls[(controls.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    });
    window.addEventListener("pagehide", () => closeTemplateEditor(false));
    $("#tpl-save").addEventListener("click", async () => {
      const session = templateEditor;
      if (!session || session.pending) return;
      if (!KinAuth.has("radiologist")) { toast("판독의만 상용구를 편집할 수 있습니다", "err"); return; }
      if (session.source) {
        if (session.source.uid !== selectedUid) { closeTemplateEditor(false); return; }
        const why = reportTemplateAccessBlock();
        if (why) { toast(why, "err"); updateTemplateEditor(); return; }
      }
      const t = session.editing;
      const title = $("#tpl-t").value.trim();
      if (!title) { toast("제목은 비울 수 없습니다", "err"); $("#tpl-t").focus(); return; }
      const shortcut = $("#tpl-s").value.trim();
      // 단축어가 겹치면 어느 쪽이 나올지 모른다 — 먼저 등록된 것이 이기고, 뒤엣것은 죽는다.
      const dup = shortcut && templates.find(x => x !== t && x.shortcut === shortcut);
      if (dup) { toast(`단축어 "${shortcut}" 은(는) "${dup.title}" 이(가) 쓰고 있습니다`, "err"); return; }
      const body = { id: t?.id, title, shortcut,
                     modality: $("#tpl-m").value.trim(),
                     bodypart: $("#tpl-b").value.trim(),
                     findings: $("#tpl-f").value, conclusion: $("#tpl-c").value,
                     recommendation: $("#tpl-r").value,
                     // API는 전체 상용구를 저장한다. 제목만 고쳐도 생략한 분류/권고문/순서가 지워졌다.
                     ...(t ? { ord: t.ord ?? 0 } : {}) };
      session.pending = true; updateTemplateEditor();
      const at = work.capture("document");
      try {
        if (serverMode) {
          const saved = await api("POST", "/templates", body, undefined, at);
          if (!work.commit(at, () => {
            const index = templates.findIndex(x => x.id === saved.id);
            if (index < 0) templates.push(saved); else templates[index] = saved;
          })) return;
        } else {
          if (t) Object.assign(t, body); else templates.push(body);
          saveTemplatesLocal();
        }
      } catch (e) {
        work.commit(at, () => { if (templateEditor === session) toast("상용구 저장 실패: " + e.message, "err"); });
        return;
      } finally {
        // 이 저장이 건 대기 표시는 이 저장이 푼다(자기 것만). 그리는 일은 문맥이 그대로일 때만 한다.
        session.pending = false;
        work.commit(at, () => { if (templateEditor === session) updateTemplateEditor(); });
      }
      // 저장 응답이 늦어도 그동안 연 새 편집창을 닫거나 입력을 지우지 않는다.
      if (!work.commit(at, () => {
        if (templateEditor === session) closeTemplateEditor();
        renderTemplates();
        toast(`상용구 "${body.title}" 저장`);
      })) return;
      // POST 성공과 목록 갱신 실패를 합치면 '저장 실패' 재시도로 같은 문장을 두 번 만든다.
      if (serverMode) {
        try { await reloadPrefs(at); }
        catch (e) { work.commit(at, () => toast("상용구는 저장됐지만 목록 갱신에 실패했습니다. Refresh로 다시 확인하세요", "err")); }
      }
    });

    $("#tplrows").addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!KinAuth.has("radiologist")) { toast("판독의만 상용구를 편집할 수 있습니다", "err"); return; }
      const tr = e.target.closest("tr[data-i]");
      const t = tr ? templates[+tr.dataset.i] : null;
      showCtx(e, [
        { label: "＋ 새 상용구", act: () => editTemplate(null) },
        { label: "수정", dis: !t, act: () => editTemplate(t) },
        { sep: 1 },
        { label: "삭제", dis: !t, act: async () => {
            if (!confirm(`상용구 "${t.title}" 을(를) 삭제할까요?`)) return;
            const at = work.capture("document");
            if (serverMode) {
              try { await api("DELETE", `/templates/${t.id}`, undefined, undefined, at); await reloadPrefs(at); }
              catch (err) { work.commit(at, () => toast("삭제 실패: " + err.message, "err")); return; }
            } else {
              templates.splice(templates.indexOf(t), 1); saveTemplatesLocal(); renderTemplates();
            }
            work.commit(at, () => toast("상용구를 삭제했습니다", "info"));
          } },
      ]);
    });