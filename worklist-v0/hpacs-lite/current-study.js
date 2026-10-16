

    // ── 선택 ──
    function viewingUid() { return viewed()?.uid ?? null; }
    function curOrder() { return orders.find(o => o.oid === selectedOid); }

    let patientCopyContext = '', patientCopyEpoch = 0, patientCopyBusy = false, patientCopyEnded = false;
    function patientCopyTarget() {
      const s = viewed();
      return !patientCopyEnded && serverMode && !demoMode && s?.uid && s.sourcePatientKey &&
        typeof s.id === 'string' && s.id.trim() && s.institutionName ? s : null;
    }
    function renderPatientCopy() {
      const s = patientCopyTarget();
      const context = s ? JSON.stringify([s.uid, s.id, s.institutionName, s.name, s.date]) : '';
      if (context !== patientCopyContext) {
        patientCopyContext = context; patientCopyEpoch++;
        $('#copy-patient-status').textContent = '';
      }
      $('#copy-patient-id').disabled = !s || patientCopyBusy;
      $('#copy-patient-context').textContent = s
        ? `열람 대상 · ${s.institutionName} · ${s.name} (${s.id}) · ${s.date || '날짜 없음'}`
        : '복사할 환자 ID가 있는 열람 검사를 선택하세요';
    }
    async function copyViewedPatientId() {
      renderPatientCopy();
      const s = patientCopyTarget();
      if (!s || patientCopyBusy) return;
      const epoch = patientCopyEpoch;
      if (!navigator.clipboard?.writeText) {
        $('#copy-patient-status').textContent = '이 브라우저는 복사를 지원하지 않습니다. 표시된 ID를 직접 선택해 복사하세요.';
        return;
      }
      patientCopyBusy = true; renderPatientCopy();
      $('#copy-patient-status').textContent = '환자 ID 복사 중…';
      const at = work.capture("document");
      try {
        // Keep the user gesture and its exact ID together. An OS clipboard write
        // cannot be recalled on navigation; only its late UI result is discarded.
        await navigator.clipboard.writeText(s.id);
        work.commit(at, () => {
          renderPatientCopy();
          if (epoch === patientCopyEpoch) $('#copy-patient-status').textContent = '환자 ID를 복사했습니다.';
        });
      } catch (e) {
        work.commit(at, () => {
          renderPatientCopy();
          if (epoch === patientCopyEpoch) $('#copy-patient-status').textContent = '복사가 허용되지 않았거나 실패했습니다. 표시된 ID를 직접 선택해 복사하거나 다시 시도하세요.';
        });
      } finally {
        // 이 복사가 건 대기 표시는 이 복사가 푼다. 다시 그리는 것은 문맥이 그대로일 때만 한다.
        patientCopyBusy = false;
        work.commit(at, () => renderPatientCopy());
      }
    }
    function endPatientCopy() { patientCopyEnded = true; patientCopyEpoch++; renderPatientCopy(); }
    $('#copy-patient-id').addEventListener('click', copyViewedPatientId);
    document.addEventListener('keydown', e => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.metaKey || e.shiftKey ||
          !e.ctrlKey || !e.altKey || e.code !== 'KeyC' ||
          e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') ||
          // 구조화 입력 창은 `show`가 아니라 `on`으로 열린다(`:3778`). 이 목록에 없으면 그 창이
          // 떠 있는 동안에도 단축키가 지나가 환자 ID가 클립보드에 적힌다 — 되돌릴 수 없는 쓰기다.
          // 열려 **있는** 그 창만 적는다: 다섯 모달은 늘 DOM에 있어서 넓은 선택자는 단축키를 영영 막는다.
          document.querySelector('dialog[open],.modal.show,#structmodal.modal.on') || !patientCopyTarget()) return;
      e.preventDefault(); copyViewedPatientId();
    });
    window.addEventListener('pagehide', endPatientCopy);

    /**
     * 검사 이동의 단일 관문(W4-PAGE-06/05/10). 행 클릭·키보드 진입·Next/Prev·Approve & Next·우클릭 메뉴·질문·자문·즐겨찾기·
     * 통합 판독 화면 — 검사를 바꾸는 길은 모두 여기를 지난다.
     *
     * 이 검사에 서버가 아직 확인하지 않은 글(`reportConverge`)이 없으면 지금처럼 그 자리에서 옮긴다(판독의의 평소 길: 클릭 수도
     * 지연도 그대로다). 있으면 그 글의 초안 저장을 기다려 **저장이 확인될 때만** 옮긴다. 저장이 거절됐거나 결과를 모르거나
     * 충돌했으면 옮기지 않고 그 사실을 Notice로 말한다(Retry/Check/Stay) — 글은 어느 쪽이든 화면에 그대로다. "그래도 떠나기"는
     * 없다: 떠난 뒤의 글은 사람이 다시 볼 자리가 없다. 글자 조합(IME) 중에는 옮기지 않고 그렇다고 말한다.
     *
     * 돌려주는 것: 바로 정해지면 결과 `{status, uid}`, 저장의 답을 기다리면 그 결과의 Promise. status는 same(이미 그 검사)·
     * clear(바로 옮겼다)·saved(저장 확인 뒤 옮겼다)·composing·refused·unknown·conflict·owner(옮기지 않았다)·stale(기다리는
     * 사이 선택이나 문맥이 바뀌어 옮기지 않았다)·stayed(기다리는 사이 사람이 지금 검사를 다시 골랐다)·gone(줄로 정한 목적지가
     * 기다리는 사이 목록에서 빠졌고 그 뒤의 후보도 없다). 결과에 따라 무엇을 할 부른 쪽은 `whenSelected`를 쓴다 — 옮겨진
     * 뒤에만, 그 검사일 때만 한다.
     *
     * `revalidate`는 줄(queue anchor)로 정한 이동(Next·Prev·Approve & Next)이 주는 다시 확인이다: 옮기기 직전에 불러 그때의
     * 목적지를 받는다(누른 순간의 줄 기준, 없으면 null). 같은 이벤트에서 옮기면 누를 때 정한 그 검사이고, 저장을 기다린 뒤나
     * Notice의 Retry·Check로 나중에 옮길 때는 그 사이 바뀐 목록에 맞춘 답이다. 사람이 고른 행(클릭·메뉴·키보드 진입)은 그 행 그대로다.
     */
    function select(uid, { deferViewer = false, openSelected = false, revalidate = null } = {}) {
      const options = { deferViewer, openSelected };
      if (uid !== selectedUid) studyRequests += 1;
      /**
       * **같은 검사를 다시 고르는 것은 이동이 아니다.**
       *
       * 예전엔 거르지 않아서, 이미 열어둔 행을 한 번 더 클릭할 때마다
       * `refreshRight()`가 통째로 다시 돌았다 — 썸네일을 다시 받아오고,
       * 점유 경고(`warnedFor = null`)가 초기화돼 **"OO 님이 작성 중입니다"가
       * 클릭할 때마다 다시 떴다.** 남발된 경고는 아무도 안 본다(교훈 §2).
       * 우클릭 메뉴도 `select(uid)`를 먼저 부르므로 메뉴를 열 때마다 같은 일이 났다.
      */
      if (uid === selectedUid) {
        // 저장을 기다리는 사이 지금 검사를 다시 골랐다: 그 이동은 하지 않는다.
        if (pendingLeave) pendingLeave.target = null;
        return { status: "same", uid };
      }
      // WORKLIST-SPLIT-UID: a stale row, link or keyboard target never selects a study the last list excluded as unresolved.
      if (appState[uid]?.identityUnresolved) {
        toast("환자 식별 불일치로 이 검사를 사용할 수 없습니다. 원본 확인이 필요합니다.", "err");
        return { status: "unresolved", uid };
      }
      // 기다리는 이동이 있으면 마지막으로 고른 검사가 그 이동의 목적지다(저장은 한 번만 기다린다).
      if (pendingLeave) { pendingLeave.target = { uid, options, revalidate }; return pendingLeave.done; }
      const pass = leaveStudyGate("select");
      if (!(pass instanceof Promise)) {
        if (pass.status !== "clear") return { ...pass, uid };
        const to = moveDestination({ uid, revalidate });
        if (!to) return { status: "gone", uid };
        enterStudy(to, options);
        return { status: "clear", uid: to };
      }
      const leave = pendingLeave = { target: { uid, options, revalidate }, from: { uid: selectedUid, seq: selectionSeq } };
      leave.done = pass.then(result => {
        if (pendingLeave === leave) pendingLeave = null;
        const target = leave.target;
        if (!target) return { status: "stayed", uid: leave.from.uid };
        if (result.status !== "saved") {
          showReportNotice({ ...result, uid: leave.from.uid, seq: leave.from.seq, target });
          return { ...result, uid: target.uid };
        }
        // 기다리는 사이 선택이 바뀌었거나 이 문서의 작업이 끝났으면(로그아웃 준비·세션 종료) 그 이동은 지금의 것이 아니다.
        if (selectedUid !== leave.from.uid || selectionSeq !== leave.from.seq || work.state() !== "active")
          return { status: "stale", uid: target.uid };
        // 기다리는 사이 글자 조합을 시작했거나 글을 더 쳤다: 그 글은 이 저장이 확인한 글이 아니다 — 옮기지 않는다.
        if (reportFrame?.isComposing()) {
          showReportNotice({ status: "composing", uid: leave.from.uid, seq: leave.from.seq, target });
          return { status: "composing", uid: target.uid };
        }
        if (reportConverge.has(leave.from.uid)) return { status: "stayed", uid: leave.from.uid };
        // 기다리는 사이 목록이 다시 정렬되거나 새로 고쳐졌을 수 있다: 줄로 정한 목적지는 누른 순간의 줄로 다시 확인한다.
        const to = moveDestination(target);
        if (!to) return { status: "gone", uid: target.uid };
        enterStudy(to, target.options);
        return { status: "saved", uid: to };
      });
      return leave.done;
    }
    /** 옮겨 갈 검사: 사람이 고른 행이면 그 행, 줄로 정한 이동이면 지금 다시 확인한 목적지. 줄에 남은 검사가 없으면 그렇다고 말한다. */
    function moveDestination(target) {
      const to = target.revalidate ? target.revalidate() : target.uid;
      if (!to) toast("가려던 다음 검사가 목록에서 빠졌고 그 뒤에 남은 검사도 없어 이 검사에 머뭅니다", "info");
      return to;
    }
    // 저장을 기다리는 이동(하나)과, 이 문서에서 다른 검사를 고른 횟수(늦게 온 Approve & Next의 답이 그 뒤의 선택을 덮지 않게).
    let pendingLeave = null, studyRequests = 0;
    /** 옮겨진 뒤에만, 그 검사일 때만 `then`을 한다(우클릭 메뉴·키보드 진입의 Findings focus·Unmatch). */
    function whenSelected(result, uid, then) {
      const run = () => { if (selectedUid === uid) then(); };
      if (result instanceof Promise) result.then(run); else run();
    }

    /**
     * 지금 검사를 떠나도 되는가(W5 인터페이스 `leaveStudyGate`). 바로 정해지면 결과를, 저장의 답을 기다려야 하면 Promise를
     * 돌려준다 — 결과는 `{status, uid, selectionSeq}`. 판정은 초안 명령 경로의 결과와 수렴 표시를 그대로 읽는다: 새 큐·순번·
     * 재시도 규칙을 만들지 않는다. 기다림의 상한은 LEAVE_WAIT_MS다 — 넘으면 결과를 모르는 것으로 멈춘다(Notice).
     */
    const LEAVE_WAIT_MS = 3000;
    function leaveStudyGate(reason) {
      const uid = selectedUid, seq = selectionSeq;
      if (reportFrame?.isComposing()) {
        showReportNotice({ status: "composing", uid, seq, reason });
        return { status: "composing", uid, selectionSeq: seq };
      }
      if (!uid || !reportConverge.has(uid)) return { status: "clear", uid, selectionSeq: seq };
      return settleStudyText(uid, seq).then(result => ({ ...result, uid, selectionSeq: seq }));
    }
    const LEAVE_TIMEOUT = Symbol("timeout");
    function leaveWithin(promise, ms) {
      let timer;
      return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(LEAVE_TIMEOUT), Math.max(0, ms)); })])
        .finally(() => clearTimeout(timer));
    }
    /** 이 검사의 확인되지 않은 글을 기존 초안 저장으로 보내고 그 결과를 읽는다. 표시가 내려가면 저장이 확인된 것이다. */
    async function settleStudyText(uid, seq) {
      const deadline = Date.now() + LEAVE_WAIT_MS;
      while (reportConverge.has(uid)) {
        if (selectedUid !== uid || selectionSeq !== seq) return { status: "stale" };
        const left = deadline - Date.now();
        if (left <= 0) return { status: "unknown" };
        // 나가 있는 확정·삽입·버리기의 답이 먼저다 — 그 답이 이 글의 운명(판독문이 됐는가)을 정한다.
        if (workBusy()) {
          if (await leaveWithin(workIdle(), left) === LEAVE_TIMEOUT) return { status: "unknown" };
          continue;
        }
        const why = leaveSaveBlock(uid);
        if (why) return { status: why.status, reason: why.reason };
        const written = await leaveWithin(stashReport(), left);
        if (written === LEAVE_TIMEOUT) return { status: "unknown" };
        if (!reportConverge.has(uid)) break;
        // 이 문서의 작업이 끝났거나(로그아웃 준비·세션 종료) 요청이 떠나지 않았다 — 이동할 문맥이 아니다.
        if (written === undefined || ["unsent", "auth"].includes(written)) return { status: "stale" };
        if (written === "conflict" || (serverMode && draftClient.conflict(uid))) return { status: "conflict" };
        if (written === "unknown") return { status: "unknown" };
        if (written === "owner") return { status: "owner", reason: "이 화면의 계정으로 쓴 초안이 아니라고 서버가 답했습니다" };
        if (written !== "saved" && written !== "merged" && written !== "withdrawn")
          return { status: "refused", reason: leaveSaveBlock(uid)?.reason ?? reportSaveOutcome.get(uid)?.reason ?? "서버가 저장을 받지 않았습니다" };
        // 저장은 됐지만 그 사이 더 친 글이 있다: 그 글도 같은 길로 한 번 더 보낸다(상한 안에서).
      }
      return { status: "saved" };
    }
    /** 이 검사의 글을 지금 보낼 수 없는 사정(보내 봐야 같은 답이다). 없으면 null. */
    function leaveSaveBlock(uid) {
      if (serverMode && draftClient.conflict(uid)) return { status: "conflict" };
      if (offline) return { status: "refused", reason: "서버 연결이 끊겨 저장할 수 없습니다" };
      if (!KinAuth.has("radiologist")) return { status: "refused", reason: "판독의 권한이 없어 저장할 수 없습니다" };
      const a = appState[uid] ?? {};
      if (a.prelimHidden) return { status: "refused", reason: "다른 판독의의 예비 판독(RS: P)입니다" };
      const held = heldByOther(studies.find(s => s.uid === uid));
      if (held) return { status: "refused", reason: `${displayActor(held)} 님이 판독 중입니다` };
      return null;
    }

    function enterStudy(uid, { deferViewer = false, openSelected = false } = {}) {
      clearReportNotice();
      reportPreview.close();
      if (templateEditor?.source) closeTemplateEditor(false);
      // A→B→A로 돌아와도 이전 검사에서 읽던 미리보기의 삽입 버튼은 재사용하지 않는다.
      closeTemplatePreview(false);
      // 인용 미리보기도 같다. 응답을 기다리는 중이면 창은 그대로 두고, 늦게 온 응답은
      // 요청이 떠날 때의 선택과 대조해 화면에 쓰지 않는다.
      if (!citeBusy) closeCitePreview(false);
      // 구조화 입력도 같은 규칙이다(B4). 나가 있는 요청이 없으면 창을 닫는다 — 열린 채로 두면
      // 다음 누름이 **떠난 검사의 항목**을 지금 검사에 적으려 한다. 진행 중이면 창을 두고,
      // 늦게 온 응답은 요청이 떠날 때의 선택과 대조해 화면에 쓰지 않는다.
      if (!structPane?.busy) closeStructure();
      // 사유를 고르는 동안 A→B→A로 이동해도 이전 모달의 결정을 새 선택에 적용하지 않는다.
      if (reasonResolve) reasonResolve(null);
      stashReport();
      if (heldUid && heldUid !== uid) releaseHold();   // 다른 검사로 가면 잡고 있던 걸 놓는다
      warnedFor = null;
      relatedUid = null;
      relatedReportSeq += 1;
      clearRelatedReport();
      markSelectionChanged(uid);
      relatedModality = ""; relatedBodyPart = ""; relatedIncludeCurrent = false;
      relatedParts.reset(uid);
      render(uid); refreshRight({ forceReport: true, deferViewer });
      if (mode === "Technician") renderOrders();   // 선택 표시줄·ID sync 갱신
      if (openSelected && !deferViewer && !readingWorkspace.active() && imageOpening?.snapshot().autoLoad) openFilmbox(uid);
    }
    function refreshRight({ forceReport = false, deferViewer = false } = {}) {
      renderClinical(); renderRelated(); renderThumbs(); renderTemplates();
      if (relatedUid) loadRelatedReport();
      else clearRelatedReport();
      loadReport({ force: forceReport });
      updateReportButtons();
      readingWorkspace.selectionChanged(deferViewer);
      readingFindings?.sync();
    }