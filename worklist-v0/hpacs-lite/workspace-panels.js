

    // ── 패널 크기 조절 ──
    let workspaceDragCancel = null;
    function workspaceEditable() {
      return !workspaceEnded && work.state() === 'active' && workspaceOwner === KinWorkspaceLayout.key(KinAuth.session());
    }
    function bindPanelResize(selector, axis, resize) {
      const handle = $(selector);
      handle.tabIndex = 0;
      handle.addEventListener('keydown', e => {
        if (!workspaceEditable() || e.isComposing || e.keyCode === 229) return;
        const direction = typeof axis === 'function' ? axis() : axis;
        const keys = direction === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (![...keys, 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const box = handle.getBoundingClientRect(), step = e.shiftKey ? 40 : 10;
        const delta = e.key === 'Home' ? -16384 : e.key === 'End' ? 16384 : e.key === keys[0] ? -step : step;
        resize({ clientX: box.left + (direction === 'x' ? delta : 0), clientY: box.top + (direction === 'y' ? delta : 0) }, direction, delta);
        rememberPanelSize(selector);
      });
      handle.addEventListener("pointerdown", e => {
        if (e.button !== 0 || !workspaceEditable()) return;
        workspaceDragCancel?.();
        const at = work.capture('document');
        workspaceGeneration++;
        e.preventDefault();
        const dragAxis = typeof axis === "function" ? axis() : axis;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        document.body.classList.add("resizing", dragAxis === "x" ? "resizing-x" : "resizing-y");

        let previous = dragAxis === 'x' ? e.clientX : e.clientY;
        const move = event => {
          if (event.pointerId !== e.pointerId) return;
          const position = dragAxis === 'x' ? event.clientX : event.clientY, delta = position - previous;
          previous = position;
          work.commit(at, () => resize(event, dragAxis, delta));
        };
        const end = event => {
          if (event.pointerId !== e.pointerId) return;
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          handle.classList.remove("dragging");
          document.body.classList.remove("resizing", "resizing-x", "resizing-y");
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
          workspaceDragCancel = null;
          work.commit(at, () => {
            if (event.type === "pointerup") rememberPanelSize(selector);
            else applyLayout();
          });
        };
        workspaceDragCancel = () => end({ pointerId: e.pointerId, type: 'pointercancel' });
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      });
    }
    const clampPanel = (value, min, max) => Math.max(min, Math.min(max, value));
    let workspaceOwner = null, workspaceStorage = null, workspaceGeneration = 0;
    // 이 브라우저에 배치를 남겼는가(마지막 쓰기·읽기의 결과). 계정 배치를 확인하지 못했을 때 "이 브라우저에서 계속 쓴다"고
    // 말해도 되는지를 이것이 정한다 — 남기지 못했으면 새로고침하면 사라진다고 말한다(workspace-roaming.js).
    let workspaceLocalKept = true;
    // The v3 tab belongs to this login. A layout saved by an earlier login may
    // restore sizes, but must not replace the pilot's initial Info tab.
    const studyPanelSessionKey = () => workspaceOwner ? 'kin-study-panel-session:' + workspaceOwner : null;
    function rememberStudyPanelSession() {
      try {
        const key = studyPanelSessionKey();
        if (key && work.session()) workspaceStorage?.setItem(key, work.session());
      } catch (_) { /* Unavailable storage keeps the current document's tab. */ }
    }
    // fromStudyPanel: a choice made in the open Study Panel (its tab, size, Text Size, Default; W3R7-04). The toolbar
    // status line is not rewritten for it: in narrower windows that line wraps when its text grows, and the list,
    // Related and report below would move under the reader's hand. A success is quiet; a failed save, and the first
    // success after one, is said in the panel itself, which lies over the page. Other layout saves keep the toolbar
    // line (the Rail/Layout wrap is a separate toolbar matter).
    function saveWorkspace(fromStudyPanel = false) {
      if (!workspaceEditable()) return;
      workspaceGeneration++;
      workspaceState.mode = layoutMode;
      workspaceState = KinWorkspaceLayout.toVersion3(KinWorkspaceLayout.withReading(workspaceState, readingWorkspace.snapshotPanels()));
      const saved = KinWorkspaceLayout.write(workspaceStorage, workspaceOwner, workspaceState);
      if (saved) rememberStudyPanelSession();
      const kept = workspaceLocalKept;
      workspaceLocalKept = !!saved;
      const said = saved ? "배치 저장됨 · 이 브라우저" : "배치 저장 안 됨 · 이 창에서만 유지";
      if (!fromStudyPanel) $("#layout-status").textContent = said;
      else if (!saved || !kept) studyPanel?.setNotice(said);
    }
    function rememberPanelSize(selector) {
      if (!workspaceEditable()) return;
      workspaceState = KinWorkspaceLayout.toVersion3(workspaceState);
      if (selector === '#resize-rail') {
        workspaceState.workspace.rail = Math.round($('#worklist-folders-panel').getBoundingClientRect().width);
        saveWorkspace(); return;
      }
      const targets = { "#resize-main": ["main", ".left"], "#resize-top": ["top", ".rw"],
        "#resize-related": ["related", ".related-p"], "#resize-prior": ["prior", ".related-list-pane"] };
      const [name, panel] = targets[selector];
      const dimension = !portraitLayout() && ["main", "related"].includes(name) ? "width" : "height";
      workspaceState[workspaceAxis()][name] = Math.round($(panel).getBoundingClientRect()[dimension]);
      saveWorkspace();
    }
    function restoreWorkspace() {
      workspaceOwner = KinWorkspaceLayout.key(sess);
      try { workspaceStorage = localStorage; } catch (_) { workspaceStorage = null; }
      const result = KinWorkspaceLayout.read(workspaceStorage, workspaceOwner);
      // Restore legacy display state as it was saved. Adopt v3 only on an
      // explicit edit/open/save, so new geometry cannot affect the first paint.
      workspaceState = result.state;
      if (workspaceState.workspace) {
        let sameSession = false;
        try { sameSession = !!work.session() && workspaceStorage?.getItem(studyPanelSessionKey()) === work.session(); } catch (_) {}
        if (!sameSession) workspaceState.workspace.studyPanelTab = 'info';
      }
      workspaceLocalKept = !["disabled", "unavailable"].includes(result.status);
      layoutMode = workspaceState.mode;
      readingWorkspace.applyPanels(workspaceState.reading || KinReadingPanelLayout.defaults());
      $("#layout-status").textContent = ({ restored: "배치 복원됨 · 이 브라우저", empty: "배치 · 이 브라우저",
        disabled: "배치 · 이 창에서만 유지", invalid: "저장된 배치 오류 · 기본 배치", unavailable: "배치 저장소 사용 불가 · 기본 배치" })[result.status];
      applyLayout();
    }
    $("#layout-toggle").addEventListener("click", () => {
      if (!workspaceEditable()) return;
      layoutMode = layoutMode === "auto" ? "portrait" : layoutMode === "portrait" ? "landscape" : "auto";
      applyLayout();
      saveWorkspace();
    });
    $("#layout-reset").addEventListener("click", () => {
      if (!workspaceEditable()) return;
      workspaceGeneration++;
      const removed = KinWorkspaceLayout.remove(workspaceStorage, workspaceOwner);
      workspaceLocalKept = !!removed;
      workspaceState = KinWorkspaceLayout.toVersion3(KinWorkspaceLayout.defaults()); layoutMode = "auto";
      readingWorkspace.applyPanels(KinReadingPanelLayout.defaults());
      applyLayout();
      $("#layout-status").textContent = removed ? "기본 배치 · 이 브라우저" : "초기화 저장 안 됨 · 이 창에서만 유지";
    });
    window.addEventListener("resize", applyLayout);
    /**
     * 작업 영역은 창 크기가 그대로여도 줄고 는다: 열린 툴바 메뉴(View 묶음)는 흐름 안에서 툴바의 둘째 줄이 되고, 알림 줄이
     * 생기고, 글이 줄바꿈된다. applyLayout은 저장한 크기를 그때의 공간 안으로 깎아 적용하고 깎은 값을 저장하지 않으므로, 공간이
     * 돌아오면 저장한 크기를 다시 적용해야 한다 — 그러지 않으면 메뉴를 연 채 불러온 Related 목록이 창 크기를 바꿀 때까지 깎인
     * 높이로 남는다(roam_01). 크기가 바뀐 프레임마다 한 번, 끌기 중에는 하지 않는다(끌기의 끝이 적용하거나 저장한다).
     * `.split`의 크기는 applyLayout이 바꾸는 자식 크기와 무관하다 — 되먹임이 없다.
     * 작업 영역이 문서에서 빠지면(가입 승인 대기·계정 설정 화면이 body를 바꾼다) 관찰은 크기 0을 한 번 알린다 — 배치할 곳이 없으니
     * 아무것도 하지 않는다.
     */
    const workArea = $(".split");
    let splitFrame = 0, splitSize = "";
    const workspaceObservedSizes = new WeakMap();
    const workspaceObserver = new ResizeObserver(entries => {
      if (workspaceEnded || !workArea.isConnected) return;
      const at = work.capture('document');
      let changed = false;
      for (const entry of entries) {
        const box = entry.target.getBoundingClientRect(), size = box.width + 'x' + box.height;
        if (entry.target === workArea) {
          if (splitSize !== size) changed = true;
          splitSize = size;
        } else {
          if (workspaceObservedSizes.get(entry.target) !== size) changed = true;
          workspaceObservedSizes.set(entry.target, size);
        }
      }
      if (changed) scheduleWorkspaceLayout(at);
    });
    // One layout pass before the next paint, coalesced with any pending one.
    function scheduleWorkspaceLayout(at = work.capture('document')) {
      if (workspaceEnded || splitFrame) return;
      splitFrame = requestAnimationFrame(() => {
        splitFrame = 0;
        work.commit(at, () => {
          if (!workspaceEnded && workArea.isConnected && !document.body.classList.contains("resizing")) applyLayout();
        });
      });
    }
    workspaceObserver.observe(workArea);
    // A notice, wrapped filter or list control changes a row floor even in a
    // fixed window, and so do the first rendered rows.
    for (const node of [...$('.related-list-pane').children, $('#relrows'), $('.left > .grid thead'), $('#rows'),
      ...[...$('.left').children].filter(child => !child.matches('.grid, #worklist-folders-panel'))]) workspaceObserver.observe(node);
    // ── Panel Settings (Minhoon 2026-10-27 item 9) ──
    // Which report window panels stay on screen. Kept in the same layout record as the rail and panel sizes, so
    // Account Layout carries it to another browser and Reset Layout shows every panel again. Display only: the panels
    // and their content stay in the document; AI Report / Image Report remain the placeholder tabs.
    const panelDialog = document.createElement('dialog');
    panelDialog.id = 'panel-settings-dialog'; panelDialog.setAttribute('aria-labelledby', 'panel-settings-title');
    panelDialog.innerHTML = `<h2 id="panel-settings-title">Panel Settings</h2>
      <p>판독 창 위쪽 패널을 보이거나 숨깁니다. 숨긴 패널의 자리는 옆 패널과 관련 검사·판독문 영역이 씁니다.
      Study Panel과 판독 화면의 검사 정보 열기에서는 모든 패널을 볼 수 있습니다.</p>
      <fieldset><legend>Show Panels</legend>${[['thumbnail', 'Thumbnail'], ['aiReport', 'AI Report'], ['imageReport', 'Image Report'],
        ['clinical', 'Clinical Information'], ['template', 'Reading Template']].map(([key, label]) =>
        `<label${key === 'aiReport' || key === 'imageReport' ? ' title="추후 구현 탭입니다. 표시 여부만 정합니다."' : ''}><input type="checkbox" data-panel="${key}"> ${label}</label>`).join('')}</fieldset>
      <p>이 브라우저에 계정별로 기억합니다. 다른 기기에서는 View &gt; Account Layout으로 계정에 저장하고 불러오세요.</p>
      <p id="panel-settings-status" role="status"></p>
      <footer><button type="button" id="panel-settings-show-all">Show All Panels</button><button type="button" id="panel-settings-close">Close</button></footer>`;
    document.body.append(panelDialog);
    const hiddenPanelsNow = () => workspaceState.workspace?.hiddenPanels?.slice() || [];
    function renderPanelSettings() {
      const hidden = hiddenPanelsNow(), editable = workspaceEditable();
      for (const input of panelDialog.querySelectorAll('input[data-panel]')) { input.checked = !hidden.includes(input.dataset.panel); input.disabled = !editable; }
      $('#panel-settings-show-all').disabled = !editable || !hidden.length;
    }
    function choosePanels(hidden) {
      if (!workspaceEditable()) { renderPanelSettings(); return; }
      const next = KinWorkspaceLayout.withHiddenPanels(workspaceState, KinWorkspaceLayout.PANELS.filter(key => hidden.includes(key)));
      if (!next) { $('#panel-settings-status').textContent = '패널 설정을 확인할 수 없습니다. Reset Layout으로 기본 배치를 사용할 수 있습니다.'; return; }
      // The dialog says the outcome itself: rewriting the toolbar status line would wrap it in narrow windows and move
      // the list and the work area under the reader (W3R7-04, as for Study Panel choices).
      workspaceState = next; applyLayout(); saveWorkspace(true); renderPanelSettings();
      $('#panel-settings-status').textContent = workspaceLocalKept ? '패널 표시를 기억했습니다 · 이 브라우저'
        : '패널 표시를 이 창에만 적용했습니다. 브라우저에 저장하지 못했습니다.';
    }
    panelDialog.querySelector('fieldset').addEventListener('change', event => {
      const input = event.target.closest('input[data-panel]'); if (!input) return;
      const hidden = hiddenPanelsNow().filter(key => key !== input.dataset.panel);
      choosePanels(input.checked ? hidden : [...hidden, input.dataset.panel]);
    });
    $('#panel-settings-show-all').addEventListener('click', () => choosePanels([]));
    $('#panel-settings-close').addEventListener('click', () => panelDialog.close());
    panelDialog.addEventListener('close', () => { const opener = $('#panel-settings-open'); if (!opener.disabled) opener.focus({ preventScroll: true }); });
    $('#panel-settings-open').addEventListener('click', () => {
      if (!workspaceEditable() || panelDialog.open) return;
      $('#panel-settings-status').textContent = ''; renderPanelSettings(); panelDialog.showModal();
      panelDialog.querySelector('input[data-panel]').focus();
    });
    function stopWorkspaceLayout() {
      if (panelDialog.open) panelDialog.close();
      workspaceEnded = true; workspaceGeneration++;
      workspaceDragCancel?.(); workspaceObserver.disconnect(); cancelAnimationFrame(splitFrame); splitFrame = 0;
      window.removeEventListener('resize', applyLayout);
      studyPanel?.destroy(); studyPanel = null;
      document.body.classList.remove('study-panel-open');
    }
    window.addEventListener('pagehide', stopWorkspaceLayout, { once: true });
    work.onInvalidate(event => {
      if (event.reason === 'prepare') workspaceDragCancel?.();
      // The tab strip, the narrow stacking and the row floors follow the selected
      // study: settle them before the selection's first paint, so opening the
      // drawer later moves nothing (W3R-03).
      if (event.reason === 'select') scheduleWorkspaceLayout();
    });
    $('#rail-collapse').addEventListener('click', () => {
      if (!workspaceEditable()) return;
      workspaceState = KinWorkspaceLayout.toVersion3(workspaceState);
      workspaceState.workspace.railCollapsed = !workspaceState.workspace.railCollapsed;
      applyLayout(); saveWorkspace();
    });
    bindPanelResize('#resize-rail', 'x', e => {
      const left = $('.left').getBoundingClientRect();
      document.body.style.setProperty('--workspace-rail-width', clampPanel(e.clientX - left.left, 160, innerWidth / 3) + 'px');
    });
    applyLayout();

    bindPanelResize("#resize-main", () => portraitLayout() ? "y" : "x", (e, axis) => {
      const box = $(".split").getBoundingClientRect();
      if (axis === "y")
        $(".left").style.height = clampPanel(e.clientY - box.top, 180, box.height - 420) + "px";
      else
        $(".left").style.width = clampPanel(e.clientX - box.left, 500, box.width - 426) + "px";
    });
    bindPanelResize("#resize-top", "y", (e, axis, delta) => {
      const top = $(".rw"), current = top.getBoundingClientRect().height;
      // 목록의 최소 높이 때문에 상한이 현재 띠보다 작아도 손과 반대로 줄이지 않는다.
      // 포인터 이동량을 쓰므로 손잡이 안의 누른 위치나 작업공간 스크롤에 영향받지 않는다.
      const maximum = Math.max(current, 140, $(".right").getBoundingClientRect().height - 266);
      top.style.height = clampPanel(current + delta, Math.min(current, 140), maximum) + "px";
    });
    bindPanelResize("#resize-related", () => portraitLayout() ? "y" : "x", (e, axis) => {
      const box = $(".workrow").getBoundingClientRect();
      if (axis === "y")
        $(".related-p").style.height = clampPanel(e.clientY - box.top, 286, box.height - 186) + "px";
      else
        $(".related-p").style.width = clampPanel(e.clientX - box.left, 220, box.width - 366) + "px";
    });
    bindPanelResize("#resize-prior", "y", e => {
      const box = $(".related-p").getBoundingClientRect();
      const list = $(".related-list-pane");
      list.style.flex = "none";
      list.style.height = clampPanel(e.clientY - box.top, 150, box.height - 136) + "px";
    });
