

    // ── 공통 이벤트 ──
    // 판독 창 위치는 계정 데이터가 아니라 이 브라우저·이 장비의 작업환경 설정이다.
    const OHIF_RECT_KEY = "kin.ohif.current.rect";
    let ohifPopupHandle = null;
    const ohifRectPolls = new Map(), ohifPopupSlots = new WeakMap(), ohifPopupSequences = new WeakMap();
    const ohifPlacementWrites = new WeakMap();
    let ohifOpenSeq = 0;
    let monitorPermission = null;
    let monitorQueryUnsupported = false;
    let monitorSessionGranted = false;
    let screensCache = [];
    let monitorDetails = null;
    let monitorHintShown = false;

    function monitorPermissionGranted() {
      return monitorPermission?.state === "granted" ||
        (monitorQueryUnsupported && monitorSessionGranted);
    }

    function updateMonitorButton() {
      // PBP 기계 대수가 아니라 OS가 인식한 확장 디스플레이 구성으로 판단.
      // OS가 2개를 확장 화면으로 인식하면 true; 복제 출력·단일 논리 화면이면 보장 없음.
      // Permissions Policy 차단 시 false이므로 false만으로 물리 1대라 단정하지 않음.
      const visible = typeof window.getScreenDetails === "function" && screen.isExtended === true &&
        (monitorPermission?.state === "prompt" || (monitorQueryUnsupported && !monitorSessionGranted));
      $("#b-monitor").style.display = visible ? "" : "none";
    }

    function cacheMonitorScreens(details) {
      if (!monitorPermissionGranted()) return;
      if (monitorDetails && monitorDetails !== details) monitorDetails.onscreenschange = null;
      monitorDetails = details;
      const refresh = () => {
        if (monitorPermissionGranted()) screensCache = details.screens.map(usableScreenRect).filter(Boolean);
        updateMonitorButton();
      };
      details.onscreenschange = refresh;
      refresh();
    }

    async function initMonitorPermission() {
      if (typeof window.getScreenDetails !== "function") return;
      try {
        monitorPermission = await navigator.permissions.query({ name: "window-management" });
        monitorPermission.onchange = () => {
          // 철회 뒤에는 이전 화면 목록으로 저장 위치를 보정하지 않는다.
          if (!monitorPermissionGranted()) {
            screensCache = [];
            if (monitorDetails) monitorDetails.onscreenschange = null;
            monitorDetails = null;
          }
          updateMonitorButton();
        };
        updateMonitorButton();
      } catch (e) {
        monitorQueryUnsupported = e instanceof TypeError;
        updateMonitorButton();
        return;
      }
      if (monitorPermissionGranted()) {
        try { cacheMonitorScreens(await window.getScreenDetails()); } catch (_) {}
      }
    }

    $("#b-monitor").addEventListener("click", async () => {
      // 권한 창에 답하는 사이 준비·종료가 있었으면 그 답으로 업무 화면의 안내·저장 위치를 바꾸지 않는다.
      const at = work.capture("document");
      let details = null;
      try { details = await window.getScreenDetails(); } catch (_) {}
      work.commit(at, () => {
        if (details) {
          if (monitorQueryUnsupported) monitorSessionGranted = true;
          cacheMonitorScreens(details);
          for (let i = 0; i < 4; i++) localStorage.removeItem(i ? OHIF_RECT_KEY + ':' + i : OHIF_RECT_KEY);
          updateMonitorButton();
          toast("모니터 배치 허용됨 — 판독 창이 다른 모니터에 열립니다", "info");
        } else {
          monitorSessionGranted = false;
          updateMonitorButton();
          toast("허용되지 않아 창 자리 기억만 동작합니다 — 다시 켜려면 크롬 사이트 설정에서 '창 관리' 허용", "info");
        }
      });
    });
    screen.addEventListener?.("change", updateMonitorButton);
    initMonitorPermission();

    function usableScreenRect(value) {
      const left = Number(value?.availLeft ?? value?.left ?? 0);
      const top = Number(value?.availTop ?? value?.top ?? 0);
      const width = Number(value?.availWidth ?? value?.width ?? 0);
      const height = Number(value?.availHeight ?? value?.height ?? 0);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
      return { left, top, width, height };
    }

    function currentScreenRect() {
      return usableScreenRect(screen) || { left: 0, top: 0, width: 1280, height: 720 };
    }

    function defaultOhifRect(target = currentScreenRect()) {
      const width = Math.min(target.width, Math.max(640, Math.min(1600, target.width - 80)));
      const height = Math.min(target.height, Math.max(600, Math.min(1000, target.height - 80)));
      return {
        left: Math.min(target.left + 40, target.left + target.width - width),
        top: Math.min(target.top + 40, target.top + target.height - height),
        width,
        height,
      };
    }

    function readStoredOhifRect(slot = 0) {
      try {
        const value = JSON.parse(localStorage.getItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY) || "null");
        const rect = {
          left: Number(value?.left), top: Number(value?.top),
          width: Number(value?.width), height: Number(value?.height),
        };
        return [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) &&
          rect.left > -30000 && rect.top > -30000 &&
          rect.width >= 320 && rect.height >= 240 ? rect : null;
      } catch (_) { return null; }
    }

    function rectInsideScreen(rect, target) {
      return rect.left >= target.left && rect.top >= target.top &&
        rect.left + rect.width <= target.left + target.width &&
        rect.top + rect.height <= target.top + target.height;
    }

    function overlapArea(rect, target) {
      const width = Math.max(0, Math.min(rect.left + rect.width, target.left + target.width) -
        Math.max(rect.left, target.left));
      const height = Math.max(0, Math.min(rect.top + rect.height, target.top + target.height) -
        Math.max(rect.top, target.top));
      return width * height;
    }

    function clampOhifRect(rect, screens) {
      const targets = screens.length ? screens : [currentScreenRect()];
      if (targets.some(target => rectInsideScreen(rect, target))) return rect;
      const target = targets.reduce((best, candidate) =>
        overlapArea(rect, candidate) > overlapArea(rect, best) ? candidate : best);
      const width = Math.min(rect.width, target.width);
      const height = Math.min(rect.height, target.height);
      return {
        left: Math.min(Math.max(rect.left, target.left), target.left + target.width - width),
        top: Math.min(Math.max(rect.top, target.top), target.top + target.height - height),
        width,
        height,
      };
    }

    function ohifPlacement(stored, details = null) {
      const screens = (details?.screens || []).map(usableScreenRect).filter(Boolean);
      // 권한 없이 현재 화면 하나로 clamp하면 다른 모니터의 저장 자리를 끌어온다.
      if (stored) return monitorPermissionGranted() && screensCache.length
        ? clampOhifRect(stored, screensCache) : stored;

      if (screens.length > 1) {
        const current = usableScreenRect(details.currentScreen);
        const other = screens.find(candidate => !current ||
          candidate.left !== current.left || candidate.top !== current.top ||
          candidate.width !== current.width || candidate.height !== current.height);
        // 화면을 꽉 채우면 드래그 뒤 크롬이 원점으로 밀어 넣어 자리 기억 실패처럼 보인다.
        if (other) return defaultOhifRect(other);
      }
      return defaultOhifRect(currentScreenRect());
    }

    function popupRect(popup) {
      try {
        if (!popup || popup.closed) return null;
        const rect = {left:Number(popup.screenX),top:Number(popup.screenY),width:Number(popup.outerWidth),height:Number(popup.outerHeight)};
        return Object.values(rect).every(Number.isFinite) && rect.left > -30000 && rect.top > -30000 && rect.width >= 320 && rect.height >= 240 ? rect : null;
      } catch (_) { return null; }
    }
    function rememberOhifRect(popup = ohifPopupHandle) {
      try {
        if (!popup || popup.closed) return false;
        // 최소화·닫힘 전이의 좌표로 마지막 정상 자리를 덮지 않는다.
        try { if (popup.document.visibilityState === "hidden") return false; } catch (_) {}
        const rect = popupRect(popup);if (!rect) return false;
        const suspended = ohifPlacementWrites.get(popup);
        if (suspended) {
          if (suspended.pending) return false;
          // A minimized/unreadable window has no baseline. Establish one after
          // restoration, preserving the saved position until a subsequent move.
          if (!suspended.baseline) { suspended.baseline = rect; return false; }
          if (Object.keys(rect).every(k => rect[k] === suspended.baseline[k])) return false;
          // After a failed placement, an actual user move resumes position saving.
          ohifPlacementWrites.delete(popup);
        }
        const slot = ohifPopupSlots.get(popup) || 0;
        localStorage.setItem(slot ? OHIF_RECT_KEY + ':' + slot : OHIF_RECT_KEY, JSON.stringify(rect));
        return true;
      } catch (_) { return false; }
    }

    function watchOhifRect(popup, slot = ohifPopupSlots.get(popup) || 0) {
      ohifPopupHandle = popup;
      ohifPopupSlots.set(popup, slot);
      rememberOhifRect(popup);
      if (ohifRectPolls.has(popup)) return;
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer); ohifRectPolls.delete(popup);
          return;
        }
        // 창 자리를 적는 일도 주기마다 그때의 문맥을 지난다: 로그아웃 준비 중이나 세션이 끝난 뒤에는 저장소에 쓰지 않는다.
        work.commit(work.capture("document"), () => { rememberOhifRect(popup); });
      }, 2000);
      ohifRectPolls.set(popup, timer);
    }

    window.addEventListener("pagehide", () => { for (const [popup, timer] of ohifRectPolls) { rememberOhifRect(popup); clearInterval(timer); } ohifRectPolls.clear(); });