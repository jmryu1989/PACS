

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

    function select(uid, { deferViewer = false, openSelected = false } = {}) {
      /**
       * **같은 검사를 다시 고르는 것은 이동이 아니다.**
       *
       * 예전엔 거르지 않아서, 이미 열어둔 행을 한 번 더 클릭할 때마다
       * `refreshRight()`가 통째로 다시 돌았다 — 썸네일을 다시 받아오고,
       * 점유 경고(`warnedFor = null`)가 초기화돼 **"OO 님이 작성 중입니다"가
       * 클릭할 때마다 다시 떴다.** 남발된 경고는 아무도 안 본다(교훈 §2).
       * 우클릭 메뉴도 `select(uid)`를 먼저 부르므로 메뉴를 열 때마다 같은 일이 났다.
      */
      if (uid === selectedUid) return;
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