

    // ══════════ 받아쓰기 (S3-ASR-U4) ══════════
    /**
     * 받은 글은 **검토 창까지만** 온다. 판독문에는 사람이 Insert를 누른 그 순간, 상용구와 같은
     * `placeBlock` 경로로만 들어간다. 녹음 가능 여부·녹음·전송·응답 검사는 `dictation.js`가 하고,
     * 여기서는 편집기의 사실(선택·판·칸·커서·관문)과 쓰기 한 번만 건넨다.
     *
     * 이 블록은 스크립트 앞쪽에서 실행되므로 불러올 때는 뒤에 선언된 `let`/`const`를 읽지 않는다 —
     * 모두 누름·응답 때 불리는 함수 안에서만 읽는다.
     */
    let dictationField = null;
    // Recording and Insert require a connection. The review retains its text while that
    // transient barrier is closed; accepting an incoming transcript does not insert it.
    function dictationBlock() {
      const why = reportEditorBlock();
      if (why) return why;
      if (!serverMode || demoMode) return "서버에 연결돼 있을 때만 받아쓸 수 있습니다";
      if (offline) return "서버 연결이 끊겨 받아쓸 수 없습니다 — 연결된 뒤 다시 시도하세요";
      return null;
    }
    /** 칸을 말하지 않으면 이 선택에서 마지막으로 짚은 칸, 없으면 Findings. 커서가 없으면 그 칸 끝이다. */
    function dictationContext(field) {
      const target = field ?? (dictationField?.seq === selectionSeq ? dictationField.field : "findings");
      if (!RFIELDS.includes(target)) return null;
      const el = $("#" + target);
      if (!el) return null;
      const a = appState[selectedUid] ?? {};
      return { blocked: !!reportEditorBlock(), uid: selectedUid, selectionSeq,
        baseVersion: reportBaseVersion(selectedUid, a.draft?.baseVersion ?? a.version ?? 0),
        field: target, value: el.value, caret: caretAt(target) ?? { start: el.value.length, end: el.value.length } };
    }
    /**
     * Insert 한 번의 쓰기. 세션이 방금 확인한 그 화면인지 여기서 **동기로** 다시 본다 — 확정·다른 삽입이
     * 나가 있는지는 세션이 모르고, 그 사이에 넣은 글은 확정 응답의 다시 그리기가 지운다.
     */
    function dictationInsert(ins) {
      if (commitInFlight || insertInFlight || dictationBlock()) return false;
      const live = dictationContext(ins.field);
      if (!live || live.uid !== ins.uid || live.selectionSeq !== ins.selectionSeq ||
          live.baseVersion !== ins.baseVersion || live.value !== ins.expectedValue) return false;
      const el = $("#" + ins.field);
      // 줄 끝만 모으는 것은 상용구와 같다 — textarea 값은 CR을 LF로 바꾸므로 그러지 않으면 커서가 어긋난다.
      const plan = KinReportCitation.placeBlock(el.value, KinReportCitation.toLf(ins.text), ins.caret,
                                                citationGuards(ins.field));
      // 타이핑·상용구처럼 표시를 세우고 점유를 시작하며, 저장은 기존 자동 저장이 한 번 가져간다.
      return editReport([reportEditOf(ins.field, plan.text, plan.end)]);
    }
    function dictationPlacement(pin, text) {
      const el = $("#" + pin.field);
      if (!el) return "";
      return placementLine(pin.field, KinReportCitation.placeBlock(el.value, KinReportCitation.toLf(text),
                                                                   pin.caret, citationGuards(pin.field)));
    }
    const dictation = KinDictation.createController({
      session: KinDictationSession, capture: KinDictationCapture, env: window, apiBase: API,
      readContext: dictationContext, block: dictationBlock, insert: dictationInsert, placement: dictationPlacement,
      busy: () => commitInFlight || insertInFlight,
    });
    KinDictation.mount(dictation, {
      button: $("#b-dictate"), pane: $("#dictation-pane"), status: $("#dictation-status"),
      text: $("#dictation-text"), place: $("#dictation-place"), meta: $("#dictation-meta"),
      stop: $("#dictation-stop"), cancel: $("#dictation-cancel"), repin: $("#dictation-repin"),
      insert: $("#dictation-insert"), close: $("#dictation-close"),
    }, {
      inserted: field => {
        $("#" + field)?.focus();
        toast("받아쓴 글을 판독문에 넣었습니다 — 확정하려면 Save 또는 Approve", "ok");
      },
      closed: () => ($("#b-dictate").disabled ? $("#findings") : $("#b-dictate")).focus(),
    });
    for (const k of ["findings", "conclusion", "recommendation"]) {
      const el = $("#" + k);
      el.addEventListener("focus", () => { dictationField = { field: k, seq: selectionSeq }; });
      // 위치를 다시 고정하는 몸짓은 **칸 안을 누르는 것**이다. 다시 고정해도 넣지는 않는다.
      el.addEventListener("mouseup", () => { dictation.fieldClicked(); });
      // 사람이 고친 글은 새 편집 순번이다 — 그 전에 떠난 편집기 범위의 작업은 이 글 위에 쓰지 않는다.
      el.addEventListener("input", () => { work.edited(); dictation.redraw(); });
    }
    /**
     * 검토 단계에서 판독의가 읽고 눌러야 할 것(받아쓴 글, 위치를 다시 고를 판독문 칸, Insert)은 보고서 열
     * 폭이 약 420px일 때 모두 Image Findings 서랍 아래에 있다. 그래서 검토에 들어서는 순간 서랍을 한 번
     * 닫는다 — 인용을 넣으면 서랍이 물러나는 것과 같은 이유다(reading-findings.js `inserted`).
     * 한 번의 받아쓰기(asrSeq)에 한 번뿐이다: 같은 검토 안의 위치 재고정은 다시 닫지 않고, 사용자가 검토 중
     * 토글로 다시 연 서랍도 그대로 둔다. 취소·실패·삽입·닫기 뒤에도 저절로 다시 열지 않는다.
     * `readingFindings`는 아래에서 선언되지만 이 함수는 검토에 들어선 뒤에만 그것을 읽는다.
     */
    let dictationDrawerSeq = null;
    function standDownFindingsForDictationReview() {
      const s = dictation.snapshot();
      if (s.state !== "review" || s.asrSeq === dictationDrawerSeq) return;
      dictationDrawerSeq = s.asrSeq;
      readingFindings?.close();
    }
    dictation.subscribe(standDownFindingsForDictationReview);
    // 로그아웃도 페이지를 떠나므로(`KinAuth.logout` → location.replace) 여기서 함께 끝난다.
    window.addEventListener("pagehide", () => dictation.pageExit());