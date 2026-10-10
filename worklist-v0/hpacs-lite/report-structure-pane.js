

    /* ── 구조화 판독 본문 (S3-structured-report) ─────────────────────────────────────
     *
     * 제품 서식 목록은 **비어 있다**(P6). 그래서 아래 단추는 그려지지 않고, 이 코드는
     * 목록이 채워지는 날에 그대로 도는 기반이다. 시험만이 합성 목록(`SYN-*`)을 자기
     * 인스턴스에 주입한다 — 제품 코드나 HTTP로 합성 항목에 닿는 길은 없다.
     */
    const structureForm = KinReportStructure.create(KinReportCitation, KinReportStructure.PRODUCT_CATALOG);
    const structureState = KinReportStructure.createState();
    const structureReads = new Map(), structureNotes = new Map();
    /** 구조화 적용의 세대. 인용의 `citeSeq`와 별개로 센다(P14). */
    let structSeq = 0;
    let structPane = null;

    /**
     * 구조화 전용 읽기. 확정은 매번 초안 행을 지우므로, 한 번 저장한 뒤의 값은 전부
     * 머리 판에 있다 — 이 읽기가 없으면 Save 한 번에 화면의 구조화 상태가 사라진다.
     */
    async function ensureStructure(uid, { force = false } = {}) {
      if (!uid || !serverMode || offline || demoMode) return false;
      if (structureForm.empty) return false;
      if (!KinAuth.has("radiologist") || appState[uid]?.prelimHidden) return false;
      if (structureReads.has(uid)) return false;
      if (!force && (structureState.known(uid) || structureNotes.has(uid))) return false;
      const ticket = {};
      structureReads.set(uid, ticket);
      const at = work.capture("document");
      try {
        const answer = await api("GET", `/studies/${encodeURIComponent(uid)}/report/structure`, undefined, undefined, at);
        if (!work.admits(at) || structureReads.get(uid) !== ticket) return false;
        structureState.confirm(uid, answer);
        structureNotes.delete(uid);
        return true;
      } catch (e) {
        if (!work.admits(at) || structureReads.get(uid) !== ticket) return false;
        // 확인하지 못한 것과 구조화 건이 없는 것은 다르다. 모른다고 말하고 키는 만들지 않는다.
        structureNotes.set(uid, "구조화 항목을 확인하지 못했습니다: " + e.message);
        return false;
      } finally {
        if (structureReads.get(uid) === ticket) structureReads.delete(uid);
      }
    }

    /**
     * 적용·거절·늦은 응답 뒤에는 서버 행에 무엇이 있는지 화면이 모른다. 확인됨으로 남겨 두면
     * 다음 자동 저장이 **새 `sid`가 빠진 유지 목록**을 실어 방금 기록된 증언을 지운다.
     * 그래서 모르는 상태로 되돌리고 전용 읽기 한 번이 서버의 바이트로 채우게 한다.
     */
    function invalidateStructure(uid) {
      if (!uid) return false;
      const changed = structureState.unconfirm(uid);
      structureReads.delete(uid);
      structureNotes.delete(uid);
      if (uid === selectedUid) ensureStructure(uid, { force: true });
      return changed;
    }

    /**
     * 이 항목의 **지금 값**을 들고 있는 건 (B3).
     *
     * 내 초안 건이 먼저다 — 그 문장이 지금 화면의 칸에 있는 건이고, 같은 항목의 머리 건은
     * 한 번 고친 뒤라면 이미 바꿔치워져 본문에 없다. 머리를 먼저 고르면 사람이 방금 넣은 값
     * 대신 **옛 값**을 보여주고, 그 옛 문장을 지우려는 계획을 세운다.
     */
    function structurePrevious(uid, templateId, itemCode) {
      const row = uid ? structureState.get(uid) : null;
      if (!row) return null;
      const same = e => e && e.templateId === templateId && e.itemCode === itemCode;
      if (structureState.known(uid)) { const mine = row.draft.find(same); if (mine) return mine; }
      return row.head.find(same) ?? null;
    }

    /**
     * 지금 고른 항목의 계획. **화면이 보여주는 답 하나가 서버로 가는 답 하나**다.
     * 이미 값이 있는 항목이면 그 문장을 그 자리에서 바꾸고, 없으면 커서 자리에 넣는다.
     */
    function structurePlan(pane) {
      const el = $("#" + pane.field);
      const guards = citationGuards(pane.field);
      if (pane.previous)
        return structureForm.replacePlan(el.value, String(pane.previous.renderedText), pane.line,
                                         caretAt(pane.field), guards);
      return structureForm.placePlan(el.value, pane.line, caretAt(pane.field), guards);
    }

    /**
     * 고를 수 있는 항목 전부. 서식이 여럿이면 **서식별로 묶지 않고 한 목록**에 펼친다 —
     * 서식 고르기 화면을 먼저 만들면 그 화면의 규칙(기본값·필터·기억)을 지금 정해야 하는데,
     * 어느 서식이 실제로 쓰일지는 D2의 답이 와야 알 수 있다.
     */
    function structureItems() {
      const out = [];
      for (const template of structureForm.templates())
        for (const item of template.items) out.push({ template, item });
      return out;
    }
    const structureItemKey = pair => pair.template.templateId + "\u0000" + pair.item.code;

    function closeStructure() {
      structPane = null;
      $("#structmodal").classList.remove("on");
    }

    function renderStructure() {
      if (!structPane) return;
      const pane = structPane;
      const item = pane.item;
      $("#struct-template").textContent = pane.template ? pane.template.title : "";
      for (const [id, on] of [["#struct-value-choice", item.valueType === "choice"],
                              ["#struct-value-number", item.valueType === "number"],
                              ["#struct-value-text", item.valueType === "text"],
                              ["#struct-value-bool-label", item.valueType === "boolean"]])
        $(id).style.display = on ? "" : "none";
      $("#struct-value-bool-text").textContent = item.valueType === "boolean"
        ? (pane.value ? String(item.trueText) : String(item.falseText)) : "";
      const why = structureForm.validateValue(item, pane.value);
      pane.line = why ? null : structureForm.renderItem(item, pane.value);
      const plan = why ? null : structurePlan(pane);
      pane.plan = plan && plan.mode2 !== "refuse" ? plan : null;
      /**
       * 문장은 `textContent`로만 쓴다 — 자유 입력 값이 들어가는 자리이고 지면은 기록이다.
       *
       * 바꾸기일 때는 **지워질 문장도 함께** 보인다(P3). 이 창은 판독문 칸을 덮고 있어서 사람은
       * 무엇이 사라지는지 눈으로 볼 수 없는데, 이 단위에서 본문 글자를 지우는 경로는 여기 하나뿐이다.
       * 줄 번호만 말하면 "몇 번째 줄"이 맞는지 확인할 방법이 없다.
       */
      $("#struct-line").textContent = pane.line ?? "";
      const removing = pane.plan && pane.plan.mode2 === "replace" && pane.previous
        ? String(pane.previous.renderedText ?? "") : "";
      $("#struct-removed").textContent = removing;
      $("#struct-removed-label").style.display = removing ? "" : "none";
      const label = KinReportCitation.FIELD_LABEL[pane.field] ?? pane.field;
      $("#struct-place").textContent = !pane.plan ? ""
        : (pane.plan.mode2 === "replace"
            ? `${label} ${pane.plan.removedLine}번째 줄의 위 문장을 지우고 이 문장으로 바꿉니다.`
            : `${label} ${pane.plan.line}번째 줄부터 넣습니다. 기존 내용은 지우지 않습니다.`);
      $("#struct-status").textContent = pane.status || why || (plan && plan.message) || "";
      // 다른 판의 서식으로 적힌 값은 보여주기만 한다. 지금 서식으로 다시 렌더해 보내면 서명된
      // 판의 문장을 새 문면으로 조용히 바꾸는 일이 된다.
      $("#struct-apply").disabled = !pane.plan || !!pane.busy || !!pane.readOnly;
    }

    function selectStructureItem(key) {
      const pairs = structureItems();
      const pair = pairs.find(p => structureItemKey(p) === key) ?? pairs[0];
      if (!pair) return;
      const template = pair.template, item = pair.item;
      const previous = structurePrevious(structPane?.uid ?? selectedUid, template.templateId, item.code);
      const value = previous && !structureForm.unknownRevision(previous) ? previous.value
        : item.valueType === "boolean" ? false
        : item.valueType === "choice" ? (item.choices[0] ?? {}).code
        : item.valueType === "number" ? item.min : "";
      structPane = { uid: structPane?.uid ?? selectedUid, selSeq: structPane?.selSeq ?? selectionSeq,
        template, item, field: item.field, value, previous, status: "", busy: false, line: null, plan: null };
      if (previous && structureForm.unknownRevision(previous)) {
        structPane.status = KinReportStructure.MESSAGES.unknownRevision;
        structPane.readOnly = true;
      }
      $("#struct-item").value = structureItemKey(pair);
      $("#struct-value-choice").replaceChildren(
        ...(item.choices ?? []).map(choice => new Option(choice.text, choice.code)));
      if (item.valueType === "choice") $("#struct-value-choice").value = String(value ?? "");
      if (item.valueType === "number") $("#struct-value-number").value = String(value ?? "");
      if (item.valueType === "text") $("#struct-value-text").value = String(value ?? "");
      if (item.valueType === "boolean") $("#struct-value-bool").checked = !!value;
      renderStructure();
    }

    function openStructure() {
      if (structureForm.empty) return;
      const why = reportEditorBlock();
      if (why) { toast(why, "err"); return; }
      const pairs = structureItems();
      if (!pairs.length) return;
      $("#struct-item").replaceChildren(
        ...pairs.map(pair => new Option(pair.item.label, structureItemKey(pair))));
      $("#structmodal").classList.add("on");
      /**
       * **이 창은 열린 그 검사의 것이다** (B4).
       *
       * 창을 연 검사와 선택 세대를 여기서 못 박는다. 못 박지 않으면 창이 떠 있는 동안 사람이
       * 다른 환자로 옮겼을 때 누르는 순간의 `selectedUid`로 계획이 다시 서고, 두 번째 누름에서
       * 계획이 일치해 **A 환자의 항목이 B 환자의 판독문에 적힌다.**
       */
      structPane = { uid: selectedUid, selSeq: selectionSeq };
      selectStructureItem(structureItemKey(pairs[0]));
    }

    /**
     * 적용. 순서는 **서버 먼저**다(P8) — 서버가 값과 문장을 한 번에 기록하고 200을 받은
     * 뒤에만 판독문 칸이 바뀐다. 거절되면 판독문은 한 글자도 움직이지 않는다.
     *
     * 열어둔 사이에 본문·커서·보호 구간이 바뀌었으면 **아무것도 보내지 않고** 다시 확인시킨다.
     * 소견 패널이 판독문 칸을 덮고 있어 사람은 자리를 눈으로 확인할 수 없고, 그래서 화면이
     * 말한 자리가 낡으면 그것은 거짓 확인이다.
     */
    async function applyStructure() {
      const pane = structPane;
      if (!pane || pane.busy) return;
      /**
       * **다른 검사로 옮겼으면 여기서 끝난다** (B4).
       *
       * 계획을 다시 세우기 **전에**, 요청을 만들기 **전에** 묻는다. 뒤에서 물으면 계획이 이미
       * 새 검사의 칸으로 다시 서고, 두 번째 누름에서는 그 계획이 자기 자신과 일치해
       * **A 환자의 항목이 B 환자의 판독문에 적힌다.** 진행 중이 아니면 창도 닫는다 —
       * 남겨두면 같은 손가락이 한 번 더 눌러 같은 일을 한다.
       */
      if (pane.uid !== selectedUid || pane.selSeq !== selectionSeq) {
        closeStructure();
        toast("다른 검사로 옮겨서 구조화 입력을 닫았습니다 — 판독문은 그대로입니다.", "err");
        return;
      }
      if (pane.readOnly) { pane.status = KinReportStructure.MESSAGES.unknownRevision; renderStructure(); return; }
      const why = reportEditorBlock();
      if (why) { pane.status = why; renderStructure(); return; }
      // 한 번에 한 삽입만 나간다(P14). 인용과 구조화가 같은 본문을 두고 겹치지 않게 한다.
      if (insertInFlight) { pane.status = "다른 삽입이 처리 중입니다 — 잠시 뒤 다시 시도하세요"; renderStructure(); return; }
      const shown = pane.plan;
      const fresh = structurePlan(pane);
      if (!shown || fresh.mode2 === "refuse" || !structureForm.samePlan(shown, fresh)) {
        pane.status = fresh.mode2 === "refuse" ? fresh.message : KinReportStructure.MESSAGES.stale;
        pane.plan = fresh.mode2 === "refuse" ? null : fresh;
        renderStructure();
        return;
      }
      // 위에서 확인한 그 검사다. 누르는 순간의 선택이 아니라 **창이 열린 검사**를 쓴다.
      const uid = pane.uid;
      const content = Object.fromEntries(RFIELDS.map(k => [k, $("#" + k).value]));
      content[pane.field] = fresh.text;
      const a = appState[uid] ?? {};
      const baseVersion = reportBaseVersion(uid, a.draft?.baseVersion ?? a.version ?? 0);
      const epoch = { uid, selSeq: selectionSeq, seq: ++structSeq };
      pane.busy = true;
      renderStructure();
      insertInFlight = true;
      structureReads.delete(uid);
      // 이 적용을 시작한 문맥(세션·작업 세대). 검사와 창의 세대는 아래 epoch이 본다 — 떠난 검사에도 수렴 표시는 남겨야 한다.
      // 쓰기는 초안의 명령 경로로 간다: 작성자·초안 revision·전체 원문에 이 적용을 실어 한 번에 기록한다.
      const at = work.capture("document");
      const pristine = pristineEditor(uid);
      const result = await draftClient.write(uid, { ...content, baseVersion }, { owner: draftOwner, context: at,
        operation: { structure: {
          op: pane.previous ? "replace" : "apply", field: pane.field,
          templateId: pane.template.templateId, templateRevision: pane.template.revision,
          itemCode: pane.item.code, valueType: pane.item.valueType, value: pane.value,
          renderedText: pane.line,
          ...(pane.previous ? { replacesSid: String(pane.previous.sid) } : {}),
        } } });
      // 이 적용이 세운 표시는 이 적용이 내린다(자기 것만).
      insertInFlight = false;
      wakeIdle();
      if (result.outcome !== "saved") {
        pane.busy = false;
        const untouched = insertLeftNoText(pristine, result);
        work.commit(at, () => {
          // 판독문은 한 글자도 바뀌지 않았다. 다만 요청이 서버에 닿았는지는 알 수 없으므로
          // 수렴을 표시하고 구조화 상태를 모르는 것으로 되돌린다 — 서버가 기록하지 않았다고 분명히 답했고 고친 글도
          // 없으면 표시는 적용 전 그대로다.
          if (untouched) reportConverge.delete(epoch.uid); else markConverge(epoch.uid);
          invalidateStructure(epoch.uid);
          pane.status = "적용하지 못했습니다: " + draftFailureText(result) + " — 판독문은 그대로입니다.";
          // 그 사이 이 창이 닫히고 다른 창이 열렸다면 남의 창에 이 실패를 그리지 않는다.
          if (structPane === pane) renderStructure();
        });
        draftNotSaved(epoch.uid, at, result, { quiet: true, converge: !untouched });
        return;
      }
      work.commit(at, () => {
        appState[uid] = { ...appState[uid], draftRevision: result.envelope.revision };
        if (epoch.uid !== selectedUid || epoch.selSeq !== selectionSeq || epoch.seq !== structSeq) {
          // 서버는 기록했는데 화면은 그 `sid`를 쓰지 못했다. 떠난 검사의 창을 남겨두면
          // 다음 확인이 **다른 환자의** 판독문에 그 문장을 넣는다. 그 사이 새로 열린 창은
          // 이 요청의 것이 아니므로 건드리지 않는다.
          markConverge(epoch.uid);
          invalidateStructure(epoch.uid);
          if (structPane === pane) closeStructure();
          toast("다른 검사로 옮기기 전에 누른 구조화 적용의 응답이 늦게 도착해 화면에 반영하지 않았습니다.", "err");
          return;
        }
        editReport([reportEditOf(pane.field, fresh.text, fresh.end)]);
        // The edit retained all current fields, including edits made while this command was out.
        if (sameDraftText(appState[uid]?.draft, { ...content, baseVersion })) reportConverge.delete(uid);
        // 새 `sid`를 지어내지 않는다 — 서버가 무엇을 기록했는지는 전용 읽기 하나가 말한다.
        invalidateStructure(uid);
        if (structPane === pane) closeStructure();
      });
    }

    $("#struct-item").addEventListener("change", e => selectStructureItem(e.target.value));
    $("#struct-value-choice").addEventListener("change", e => {
      if (structPane) { structPane.value = e.target.value; structPane.status = ""; renderStructure(); }
    });
    $("#struct-value-number").addEventListener("input", e => {
      if (structPane) { structPane.value = e.target.value === "" ? null : Number(e.target.value); structPane.status = ""; renderStructure(); }
    });
    $("#struct-value-text").addEventListener("input", e => {
      if (structPane) { structPane.value = e.target.value; structPane.status = ""; renderStructure(); }
    });
    $("#struct-value-bool").addEventListener("change", e => {
      if (structPane) { structPane.value = e.target.checked; structPane.status = ""; renderStructure(); }
    });
    $("#struct-cancel").addEventListener("click", () => closeStructure());
    $("#struct-apply").addEventListener("click", () => { applyStructure(); });

    /**
     * 서식 목록이 비어 있으면 단추를 **그리지 않는다**(P6). 비활성 단추는 "곧 된다"는 약속이고,
     * 지금 약속할 수 있는 것이 없다. 목록이 채워지면 이 한 줄이 단추를 만든다.
     */
    if (!structureForm.empty) {
      const button = document.createElement("button");
      button.id = "b-structured";
      button.type = "button";
      button.textContent = "Structured";
      button.title = "서식에서 고른 값을 판독문 본문에 한 줄로 넣습니다";
      button.addEventListener("click", () => openStructure());
      $("#b-print").before(button);
    }