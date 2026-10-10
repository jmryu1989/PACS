

    // ── 패널 크기 조절 ──
    function bindPanelResize(selector, axis, resize) {
      const handle = $(selector);
      handle.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        workspaceGeneration++;
        e.preventDefault();
        const dragAxis = typeof axis === "function" ? axis() : axis;
        handle.setPointerCapture(e.pointerId);
        handle.classList.add("dragging");
        document.body.classList.add("resizing", dragAxis === "x" ? "resizing-x" : "resizing-y");

        const move = event => {
          if (event.pointerId === e.pointerId) resize(event, dragAxis);
        };
        const end = event => {
          if (event.pointerId !== e.pointerId) return;
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          handle.classList.remove("dragging");
          document.body.classList.remove("resizing", "resizing-x", "resizing-y");
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
          if (event.type === "pointerup") rememberPanelSize(selector);
          else applyLayout();
        };
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
    function saveWorkspace() {
      workspaceGeneration++;
      workspaceState.mode = layoutMode;
      workspaceState = KinWorkspaceLayout.withReading(workspaceState, readingWorkspace.snapshotPanels());
      const saved = KinWorkspaceLayout.write(workspaceStorage, workspaceOwner, workspaceState);
      workspaceLocalKept = !!saved;
      $("#layout-status").textContent = saved ? "배치 저장됨 · 이 브라우저" : "배치 저장 안 됨 · 이 창에서만 유지";
    }
    function rememberPanelSize(selector) {
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
      workspaceState = result.state;
      workspaceLocalKept = !["disabled", "unavailable"].includes(result.status);
      layoutMode = workspaceState.mode;
      readingWorkspace.applyPanels(workspaceState.reading || KinReadingPanelLayout.defaults());
      $("#layout-status").textContent = ({ restored: "배치 복원됨 · 이 브라우저", empty: "배치 · 이 브라우저",
        disabled: "배치 · 이 창에서만 유지", invalid: "저장된 배치 오류 · 기본 배치", unavailable: "배치 저장소 사용 불가 · 기본 배치" })[result.status];
      applyLayout();
    }
    $("#layout-toggle").addEventListener("click", () => {
      layoutMode = layoutMode === "auto" ? "portrait" : layoutMode === "portrait" ? "landscape" : "auto";
      applyLayout();
      saveWorkspace();
    });
    $("#layout-reset").addEventListener("click", () => {
      workspaceGeneration++;
      const removed = KinWorkspaceLayout.remove(workspaceStorage, workspaceOwner);
      workspaceLocalKept = !!removed;
      workspaceState = KinWorkspaceLayout.defaults(); layoutMode = "auto";
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
    new ResizeObserver(() => {
      if (!workArea.isConnected) return;
      const box = workArea.getBoundingClientRect(), size = Math.round(box.width) + "x" + Math.round(box.height);
      if (size === splitSize || splitFrame) { splitSize = size; return; }
      splitSize = size;
      splitFrame = requestAnimationFrame(() => {
        splitFrame = 0;
        if (workArea.isConnected && !document.body.classList.contains("resizing")) applyLayout();
      });
    }).observe(workArea);
    applyLayout();

    bindPanelResize("#resize-main", () => portraitLayout() ? "y" : "x", (e, axis) => {
      const box = $(".split").getBoundingClientRect();
      if (axis === "y")
        $(".left").style.height = clampPanel(e.clientY - box.top, 180, box.height - 420) + "px";
      else
        $(".left").style.width = clampPanel(e.clientX - box.left, 500, box.width - 426) + "px";
    });
    bindPanelResize("#resize-top", "y", e => {
      const right = $(".right"), box = right.getBoundingClientRect();
      // 세로 작업공간을 스크롤한 뒤에도 패널 자체의 높이를 조절한다.
      $(".rw").style.height = clampPanel(e.clientY - box.top + right.scrollTop, 140, box.height - 266) + "px";
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