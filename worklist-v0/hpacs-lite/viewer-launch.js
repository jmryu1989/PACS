

    function validPriorDate(value) {
      if (typeof value !== "string" || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [year, month, day] = value.split("-").map(Number);
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
    }

    let imageOpening = null, viewerWindows = null, viewerWindowCursor = null, worklistAlerts = null, worklistRefresh = null, worklistStartup = null;
    function autoPrior(uid) {
      if (imageOpening && !imageOpening.snapshot().includePrior) return null;
      const s = studies.find(x => x.uid === uid);
      if (!s?.sourcePatientKey || !validPriorDate(s.date)) return null;
      // fmtD는 모양만 바꾼다. 달력 검증 없이 정렬하면 미래·불량 날짜가 prior가 된다.
      // 같은 날의 선후는 StudyTime 근거가 없으므로 자동으로 추측하지 않는다.
      return studies.filter(x => x.sourcePatientKey === s.sourcePatientKey && x.uid !== uid && x.modality === s.modality
          && validPriorDate(x.date) && x.date < s.date)
        .sort((a, b) => b.date.localeCompare(a.date) || b.uid.localeCompare(a.uid))[0]?.uid ?? null;
    }

    function openFilmbox(uid, priorUid = autoPrior(uid), initialSeriesUid = null) {
      if (readingWorkspace.active() || imageOpening?.snapshot().listTarget === 'workspace')
        return readingWorkspace.open(uid, priorUid, initialSeriesUid);
      return openOhifWindow(uid, priorUid, initialSeriesUid);
    }
    function ohifScope(value) {
      try {
        const location = new URL(value, window.location.origin);
        if (location.origin !== window.location.origin || location.pathname !== "/ohif/viewer") return null;
        const studies = (location.searchParams.get("StudyInstanceUIDs") || "").split(",");
        if (studies.length < 1 || studies.length > 2 || studies.some(uid => !/^\d+(?:\.\d+)+$/.test(uid))) return null;
        return { studies, series: location.searchParams.get("initialSeriesInstanceUID") || null };
      } catch (_) { return null; }
    }
    function sameOhifScope(left, right) {
      const a = ohifScope(left), b = ohifScope(right);
      return !!a && !!b && a.series === b.series && JSON.stringify(a.studies) === JSON.stringify(b.studies);
    }
    function ohifPopupState(popup) {
      try {
        const href = popup.location.href;
        if (href === "about:blank") return { kind: "blank", busy: false, dirty: false };
        if (!ohifScope(href)) return { kind: "unknown", busy: true, dirty: true };
        const key = KinViewerOpening.key(KinAuth.session()), owner = key && key.slice(KinViewerOpening.PREFIX.length);
        if (!owner || typeof popup.kinViewerWindowOwner !== 'function' || popup.kinViewerWindowOwner() !== owner)
          return { kind: 'viewer', href, busy: true, dirty: false, ready: false };
        const history = popup.kinViewerHistoryWorkspaceState;
        const jobs = popup.kinViewerJobWorkspaceState;
        // A viewer document without both guards may still be loading or may
        // have lost an asset. Uncertainty is not permission to replace it.
        if (typeof history !== "function" || typeof jobs !== "function") {
          return { kind: "viewer", href, busy: true, dirty: false, ready: false };
        }
        const annotationState = history(), jobState = jobs();
        return { kind: "viewer", href, ready: true,
          busy: !!(annotationState?.busy || jobState?.busy || popup.document.querySelector('dialog[open]')),
          dirty: !!(annotationState?.dirty || jobState?.dirty) };
      } catch (_) {
        // Do not navigate a named window that no longer exposes the expected
        // same-origin viewer; the user can close it explicitly and reopen.
        return { kind: "unknown", busy: true, dirty: true };
      }
    }
    /**
     * 목록의 세션을 뷰어 창에 넘긴다(S7-U5 A015). 목록이 연 뷰어 창은 opener가 끊겨 있어 누가 열었는지 스스로 알 길이 없다.
     * 넘겨주지 않으면 그 창은 쿠키가 지금 가리키는 세션을 그대로 받아들인다 — 다른 탭에서 계정이 바뀐 뒤라면, 이 목록에서
     * 고른 검사가 다른 로그인의 이름으로 열린다. 그래서 새 문서를 읽게 하는 모든 이동 직전에 창 이름으로 넘긴다
     * (clinician.js와 같은 방식): 뷰어의 첫 설정 스크립트(config/ohif.js)가 읽어 원래 창 이름으로 되돌리고, 뷰어는 그
     * 세션일 때만 업무를 시작한다. 쿠키의 세션이 다르면 뷰어는 안내만 보인다 — 그 세션을 끝내지 않는다. 주소에도 서버
     * 기록에도 남지 않고, 누르는 횟수도 기다림도 늘지 않는다.
     */
    function handOverSession(popup, name) {
      const session = work.session();
      if (typeof session !== "string" || !session) return false;
      try { popup.name = "kin-viewer-entry:" + JSON.stringify({ session, name }); return true; } catch (_) { return false; }
    }
    /**
     * 그 창의 뷰어가 진입에서 멈춰 있는가("이 창을 연 세션을 확인할 수 없습니다. 목록에서 뷰어를 다시 열어 주세요"). 뷰어
     * 문서가 자기 이력 항목에 적어 둔 기록으로 안다(viewer-session.js의 `kinViewerSession`: 끝나지 않았고 진입이 멈췄다).
     * 그런 창은 업무를 시작한 적이 없어 지킬 작업이 없다 — 그 안내가 시키는 대로 목록에서 다시 열면, 새로 넘겨준 세션으로
     * 다시 확인하게 한다. 읽을 수 없으면 멈춘 창으로 보지 않는다(평소의 보호 그대로다).
     */
    function viewerEntryStopped(popup) {
      try {
        const entry = popup.history.state?.kinViewerSession;
        return !!entry && entry.ended === false && entry.entryStopped === true;
      } catch (_) { return false; }
    }
    function openOhifWindow(uid, priorUid = null, initialSeriesUid = null, readingReturn = null, openingOptions = null) {
      const freshDocument = openingOptions?.freshDocument === true;
      const notify = (message, kind, duration) => {
        if (freshDocument && typeof openingOptions?.notice === 'function') openingOptions.notice(message);
        toast(message, kind, duration);
      };
      if (demoMode) { alert("데모 모드에서는 뷰어를 열 수 없습니다.\n(실제 구동은 Orthanc 연결 환경에서)"); return; }
      // 썸네일에 Series 식별이 없으면 기본 시리즈를 대신 열어 선택이 맞는 것처럼 보이지 않는다.
      if (initialSeriesUid !== null && (typeof initialSeriesUid !== "string" || initialSeriesUid.length > 64 ||
          !/^\d+(?:\.\d+)+$/.test(initialSeriesUid))) {
        notify("시리즈 정보를 확인할 수 없어 열지 않았습니다.", "err");
        return;
      }
      const returnHash=typeof readingReturn==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(readingReturn)?'#kin-reading-return='+readingReturn:'';
      let url = `/ohif/viewer?StudyInstanceUIDs=${encodeURIComponent(uid)}` +
        (priorUid && priorUid !== uid ? `,${encodeURIComponent(priorUid)}&hangingProtocolId=@ohif/hpCompare` : "") +
        (initialSeriesUid === null ? "" : `&initialSeriesInstanceUID=${encodeURIComponent(initialSeriesUid)}`)+returnHash;
      const seq = ++ohifOpenSeq;
      if (!viewerWindows) { notify('영상 창 연결을 확인하지 못했습니다. 통합 판독 화면을 사용하거나 목록을 새로고침하세요.', 'err'); return; }
      const preferences = imageOpening?.snapshot(), limit = preferences?.maxWindows || 1;
      let choice = viewerWindows.choose(url, limit, { freshDocument });
      if (!freshDocument && choice.full && viewerWindows.available() && preferences?.reuseClean && limit > 1) {
        const rows = viewerWindows.rows();
        const clean = row => row.status?.kind === 'viewer' && row.status.ready && !row.status.busy && !row.status.dirty;
        const reusable = rows.length === limit && (rows.find(row => row.index !== viewerWindowCursor && clean(row)) || rows.find(clean));
        if (reusable) choice = { ...reusable, fresh: false };
      }
      if (choice.error) { notify(choice.error, 'err', 8000); if (choice.full && !freshDocument) $('#viewer-windows-open').click(); return; }
      if (freshDocument && (!choice.fresh || choice.pending)) { notify('기존 영상을 유지했습니다. 새 영상 창을 확보한 뒤 다시 여세요.', 'err'); return; }
      url = viewerWindows.linked(url, choice.index);
      const stored = readStoredOhifRect(choice.index);
      const initial = ohifPlacement(stored);
      /**
       * 이 문서가 그 자리의 창을 이미 쥐고 있으면 이름으로 다시 찾지 않는다. 세션을 넘겨받은 창은 뷰어의 첫 스크립트가
       * 이름을 되돌릴 때까지 인계 이름을 달고 있다(handOverSession) — 그 사이(불러오는 중)에 이름으로 찾으면 그 창을 찾지
       * 못해 같은 이름의 빈 창이 하나 더 열리고, 자리는 그 빈 창을 가리키게 된다. 쥔 창이 없을 때(새 자리, 목록을 새로 읽은
       * 뒤)에만 이름으로 연다.
       */
      let known = null;
      try { if (choice.popup && !choice.popup.closed) known = choice.popup; } catch (_) {}
      const popup = known || window.open(
        "",
        choice.name,
        `popup=yes,width=${initial.width},height=${initial.height},left=${initial.left},top=${initial.top},resizable=yes,scrollbars=yes`,
      );
      if (popup) {
        if (freshDocument && ohifPopupState(popup).kind !== "blank") {
          try { popup.opener = null; } catch (_) {}
          viewerWindows.blocked(choice);
          notify("새 창 이름에 기존 화면이 연결되어 열지 않았습니다. 기존 화면을 유지했습니다.", "err", 8000);
          try { popup.focus(); } catch (_) {}
          return;
        }
        viewerWindows.attach(choice, popup); viewerWindowCursor = choice.index; ohifPopupSlots.set(popup, choice.index);
        // Reopening a named window can restore its opener even without navigation.
        try{popup.opener=null;}catch(_){notify('영상 창 연결을 분리하지 못했습니다. 기존 창에서 작업을 저장한 뒤 닫고 다시 여세요.','err',8000);return;}
        if (choice.pending) {
          popup.focus(); watchOhifRect(popup);
          notify('기존 영상 창을 불러오는 중입니다. 계속되지 않으면 그 창을 닫은 뒤 다시 여세요.', 'info');
          return;
        }
        const previous = ohifPopupState(popup);
        const deferredPlacement = previous.kind === 'blank' && monitorPermissionGranted() && screen.isExtended === true;
        const placementWrite = deferredPlacement ? {pending:true,baseline:null} : null;
        if (placementWrite) ohifPlacementWrites.set(popup, placementWrite);
        // 진입에서 멈춘 창은 초점만 주거나 "닫고 다시 여세요"로 돌려보내지 않는다: 아래에서 새 세션 확인과 함께 다시 읽게 한다.
        const stopped = previous.kind === "viewer" && !previous.ready && viewerEntryStopped(popup);
        if (previous.kind === "viewer" && !stopped) {
          if (sameOhifScope(previous.href, url)) {
            if(popup.location.hash!==new URL(url,location.origin).hash){
              try{
                // Hash navigation can re-enter OHIF's mode and clear live job
                // inputs. Replace only this link metadata, then notify its bridge.
                const linked=new URL(popup.location.href), hash=new URLSearchParams(linked.hash.slice(1));
                const previousReturn=hash.get('kin-reading-return');
                for(const [key,value] of new URLSearchParams(new URL(url,location.origin).hash.slice(1)))hash.set(key,value);
                linked.hash=hash.toString();
                popup.history.replaceState(popup.history.state,'',linked.href);
                if(previousReturn!==hash.get('kin-reading-return'))popup.dispatchEvent(new popup.Event('kin-reading-link-changed'));
                popup.dispatchEvent(new popup.Event('kin-window-link-changed'));
              }catch(_){notify('판독문 복귀 연결을 확인하지 못했습니다. 목록 창을 직접 선택하세요.','info');}
            }
            popup.focus();
            watchOhifRect(popup);
            return;
          }
          if (previous.busy || previous.dirty || !previous.ready) {
            popup.focus();
            watchOhifRect(popup);
            notify(!previous.ready
              ? "기존 영상 창의 보호 상태를 확인할 수 없습니다. 로딩을 확인하고 계속되지 않으면 그 창을 닫은 뒤 다시 여세요."
              : previous.busy
              ? "기존 영상 창의 저장·복원 또는 상태 확인을 마치고 열린 대화상자를 닫은 뒤 다른 검사를 여세요."
              : "기존 영상 창에 저장하지 않은 표식이나 작업 내용(소견 작성 내용 포함)이 있습니다. 저장하거나 비운 뒤 다른 검사를 여세요.", "err", 8000);
            return;
          }
          if (typeof popup.kinViewerFrameCoverageConfirm !== 'function' || !popup.kinViewerFrameCoverageConfirm(message => confirm(message))) {
            popup.focus(); notify('기존 영상 창을 유지했습니다. Frame Coverage와 원본 영상을 확인하세요.', 'info'); return;
          }
          const rechecked = ohifPopupState(popup);
          if (popup.location.href !== previous.href || !rechecked.ready || rechecked.busy || rechecked.dirty) return;
          rememberOhifRect(popup);
        } else if (previous.kind !== "blank" && !stopped) {
          popup.focus();
          notify("기존 영상 창의 상태를 확인할 수 없습니다. 그 창을 닫은 뒤 다시 여세요.", "err", 8000);
          return;
        }
        // feature는 안쪽 크기이므로 저장된 바깥 크기로 맞춰 재열기 누적을 막는다.
        if (previous.kind === "blank") {
          try {
            popup.resizeTo(initial.width, initial.height);
            popup.moveTo(initial.left, initial.top);
          } catch (_) {}
        }
        if (!handOverSession(popup, choice.name)) {
          if (previous.kind === "blank") { try { popup.close(); } catch (_) {} viewerWindows.blocked(choice); }
          notify("이 목록의 로그인 세션을 확인할 수 없어 영상 창을 열지 않았습니다. 목록을 새로고침한 뒤 다시 여세요.", "err", 8000);
          return;
        }
        const previousDocument = popup.document;
        ohifPopupSequences.set(popup, seq);
        // 멈춘 창을 같은 검사로 다시 열 때는 주소가 같아(달라도 # 뒤만 다르다) 대입으로는 새 문서가 읽히지 않는다 —
        // 주소만 맞춘 뒤 그 창을 다시 읽게 한다. 넘겨준 세션은 다시 읽힌 문서의 첫 스크립트가 받는다.
        if (stopped && sameOhifScope(previous.href, url)) {
          try { popup.history.replaceState(popup.history.state, "", url); } catch (_) {}
          popup.location.reload();
        } else popup.location.href = url;
        viewerWindows.navigating(choice, url, previousDocument);
        popup.focus();
        watchOhifRect(popup);
        if (!monitorHintShown && monitorPermission?.state === "prompt" && screen.isExtended === true) {
          monitorHintShown = true;
          notify("판독 창을 다른 화면에 열려면 툴바 [다른 모니터로]에서 허용하세요.", "info", 8000);
        }
        // about:blank에서 opener를 분리한 직후에는 Chrome이 다른 화면 좌표를
        // 현재 화면으로 제한한다. 실제 뷰어 문서가 준비된 뒤 한 번 배치한다.
        if (deferredPlacement) {
          const placementOwner = KinViewerOpening.key(KinAuth.session()), deadline = Date.now() + 15000;
          // 이 배치를 시작한 문맥. 준비·종료 뒤에는 화면 정보의 답도 다시 시도하는 타이머도 창을 옮기지 않는다.
          const placementAt = work.capture("document");
          const currentPlacement = () => ohifPlacementWrites.get(popup) === placementWrite;
          const validPlacement = () => {
            try { return work.admits(placementAt) && seq === ohifPopupSequences.get(popup) && !popup.closed && monitorPermissionGranted() &&
              placementOwner && placementOwner === KinViewerOpening.key(KinAuth.session()); }
            catch (_) { return false; }
          };
          const stopPlacement = () => {
            if (currentPlacement()) { placementWrite.pending = false; placementWrite.baseline = popupRect(popup); }
          };
          // This timer also bounds a screen-details promise that never settles.
          const expiry = setTimeout(stopPlacement, 15000);
          try {
            window.getScreenDetails().then(details => {
              if (!validPlacement()) { clearTimeout(expiry); stopPlacement(); return; }
              cacheMonitorScreens(details);
              const rect = ohifPlacement(stored, details);
              const place = () => {
                if (!currentPlacement() || !placementWrite.pending) return;
                if (Date.now() >= deadline || !validPlacement()) { clearTimeout(expiry);stopPlacement();return; }
                try {
                  if (popup.document === previousDocument || popup.document.readyState === 'loading' || !sameOhifScope(popup.location.href, url)) {
                    if (Date.now() < deadline) setTimeout(place, 100);
                    return;
                  }
                  // Move before resizing so a smaller primary display cannot cap
                  // the saved size intended for a larger secondary display.
                  popup.moveTo(rect.left, rect.top);
                  popup.resizeTo(rect.width, rect.height);
                  popup.moveTo(rect.left, rect.top);
                  const settled = () => {
                    try {
                    if (!currentPlacement() || !placementWrite.pending) return;
                    if (Date.now() >= deadline || !validPlacement() || !sameOhifScope(popup.location.href,url)) { clearTimeout(expiry);stopPlacement();return; }
                    const actual = popupRect(popup);
                    if (actual && Object.keys(rect).every(k => Math.abs(actual[k]-rect[k]) <= 16)) {
                      clearTimeout(expiry);ohifPlacementWrites.delete(popup);rememberOhifRect(popup);
                    } else setTimeout(settled,100);
                    } catch (_) { clearTimeout(expiry);stopPlacement(); }
                  };
                  setTimeout(settled,100);
                } catch (_) { clearTimeout(expiry);stopPlacement(); }
              };
              place();
            }).catch(() => { clearTimeout(expiry);stopPlacement(); });
          } catch (_) { clearTimeout(expiry);stopPlacement(); }
        }
        return;
      }

      viewerWindows.blocked(choice);
      notify('팝업이 차단되었습니다. 브라우저에서 팝업을 허용하거나 Image Opening에서 Reading Workspace를 선택하세요.', 'err', 8000);
    }

    function mountViewerWindows() {
      const button = $('#viewer-windows-open'), dialog = document.createElement('dialog'); dialog.id = 'viewer-windows-dialog';
      dialog.setAttribute('aria-labelledby', 'viewer-windows-title');
      dialog.innerHTML = '<h2 id="viewer-windows-title">Viewer Windows</h2><p>이 목록에 연결된 영상 창입니다. 창 닫기는 저장 중이거나 미저장 작업이 있으면 거절합니다. 확인되지 않은 창은 Focus로 상태를 확인합니다.</p><nav aria-label="Opened viewer navigation"><button class="chip" id="viewer-windows-prev" type="button">Previous Window</button> <button class="chip" id="viewer-windows-next" type="button">Next Window</button></nav><p>이 목록에서 마지막으로 연 창 또는 Focus한 창을 기준으로 이동합니다. 판독 대상과 영상 내용은 바꾸지 않습니다.</p><div id="viewer-windows-list"></div><p id="viewer-windows-status" role="status"></p><button class="chip" id="viewer-windows-done" type="button">Done</button>';
      document.body.append(dialog);
      const list = $('#viewer-windows-list'), status = $('#viewer-windows-status'); let signature = '';
      let displayScreens = [], displaySequence = 0, displayMoveSequence = 0;
      const movingWindows = new WeakMap();
      const detectDisplays = document.createElement('button');detectDisplays.type='button';detectDisplays.className='chip';
      detectDisplays.id='viewer-windows-displays';detectDisplays.textContent='Detect Displays';
      detectDisplays.title='화면 접근 권한을 확인합니다. 번호는 좌표 순의 브라우저 목록이며 OS 설정 번호와 다를 수 있습니다.';
      list.before(detectDisplays);
      detectDisplays.onclick=async()=>{
        const request=++displaySequence,owner=KinViewerOpening.key(KinAuth.session());detectDisplays.disabled=true;
        // 화면 정보의 답은 이 확인을 시작한 문맥과 계정·요청 번호를 함께 지난다. 잠근 단추는 이 확인이 푼다(자기 것만).
        const at=work.capture('document');
        try{
          if(!viewerWindows.available()||typeof window.getScreenDetails!=='function')throw Error('unsupported');
          const details=await window.getScreenDetails();await initMonitorPermission();
          if(!work.admits(at)||request!==displaySequence||owner!==KinViewerOpening.key(KinAuth.session())||!viewerWindows.available())return;
          if(monitorQueryUnsupported)monitorSessionGranted=true;
          cacheMonitorScreens(details);displayScreens=KinViewerDisplayLayout.screens(details);render();
          status.textContent=displayScreens.length?'이동할 화면을 선택하세요. 화면 번호는 좌표 순이며 OS 설정 번호와 다를 수 있습니다.':'사용 가능한 화면을 확인하지 못했습니다.';
        }catch(_){if(work.admits(at)&&request===displaySequence){displayScreens=[];render();status.textContent='화면 권한을 허용한 뒤 다시 확인하세요. 이 브라우저가 지원하지 않으면 창을 직접 이동할 수 있습니다.';}}
        finally{detectDisplays.disabled=false;}
      };
      async function moveDisplay(index,chosen){
        const owner=KinViewerOpening.key(KinAuth.session());
        if(!viewerWindows.available()){status.textContent='현재 계정을 확인한 뒤 다시 여세요.';return;}
        const row=viewerWindows.rows().find(r=>r.index===index),popup=row?.popup;
        if(!popup||row.pending||!row.status?.ready||row.status.busy||movingWindows.has(popup)||ohifPlacementWrites.get(popup)?.pending){status.textContent='창을 불러오는 중이거나 작업 중입니다. 완료 후 다시 이동하세요.';return;}
        const request=++displayMoveSequence;movingWindows.set(popup,request);render();
        const href=row.status.href,sequence=ohifPopupSequences.get(popup);
        // 이 이동을 시작한 문맥. 화면 정보의 답·이동 확인 타이머·끝 안내는 이것과 계정·창·요청 번호를 함께 지난다.
        const at=work.capture('document'),shown=()=>work.admits(at)&&request===displayMoveSequence&&viewerWindows.available();
        const valid=()=>{
          try{const current=viewerWindows.rows().find(r=>r.index===index),state=ohifPopupState(popup);
            return work.admits(at)&&movingWindows.get(popup)===request&&owner&&owner===KinViewerOpening.key(KinAuth.session())&&viewerWindows.available()&&
              current?.popup===popup&&!current.pending&&sequence===ohifPopupSequences.get(popup)&&state.ready&&!state.busy&&state.href===href&&!popup.closed;
          }catch(_){return false;}
        };
        status.textContent='창을 이동하고 있습니다.';
        try{
          const details=await window.getScreenDetails();
          if(!valid()){if(shown())status.textContent='창 상태가 바뀌어 이동하지 않았습니다. 현재 창을 다시 확인하세요.';return;}
          const fresh=KinViewerDisplayLayout.screens(details),target=fresh.find(s=>KinViewerDisplayLayout.identity(s)===KinViewerDisplayLayout.identity(chosen));
          if(!target||!monitorPermissionGranted()){displayScreens=fresh;render();status.textContent='화면 구성이나 권한이 바뀌었습니다. 화면을 다시 확인한 뒤 선택하세요.';return;}
          const rect=KinViewerDisplayLayout.fit(popupRect(popup),target);
          if(!rect){status.textContent='창을 복원한 뒤 다시 이동하세요.';return;}
          const gate={pending:true,baseline:null};ohifPlacementWrites.set(popup,gate);
          const moved=await new Promise(resolve=>{
            let finished=false;
            const finish=ok=>{if(finished)return;finished=true;clearTimeout(timeout);
              let saved=false;
              if(ohifPlacementWrites.get(popup)===gate){if(ok){ohifPlacementWrites.delete(popup);saved=rememberOhifRect(popup);}else{gate.pending=false;gate.baseline=popupRect(popup);}}
              resolve({moved:ok,saved});
            };
            const timeout=setTimeout(()=>finish(false),2500);
            const check=()=>{if(finished)return;
              if(!valid()||!monitorPermissionGranted()||ohifPlacementWrites.get(popup)!==gate){finish(false);return;}
              const actual=popupRect(popup);
              if(actual&&Object.keys(rect).every(k=>Math.abs(actual[k]-rect[k])<=16))finish(true);else setTimeout(check,100);
            };
            try{popup.focus();popup.moveTo(rect.left,rect.top);popup.resizeTo(rect.width,rect.height);popup.moveTo(rect.left,rect.top);setTimeout(check,100);}
            catch(_){finish(false);}
          });
          if(shown())status.textContent=moved.saved?'지정 화면으로 이동하고 창 위치를 저장했습니다.':moved.moved?'창을 이동했지만 위치를 저장하지 못했습니다. 현재 창 상태와 브라우저 저장소를 확인하세요.':'창 이동을 확인하지 못해 이전 저장 위치를 유지했습니다. 창을 직접 이동하거나 다시 시도하세요.';
        }catch(_){if(shown())status.textContent='화면에 접근하지 못했습니다. 권한과 창 상태를 확인한 뒤 다시 시도하세요.';}
        finally{if(movingWindows.get(popup)===request)movingWindows.delete(popup);if(work.admits(at)&&viewerWindows.available())render();}
      }
      function render() {
        const rows = viewerWindows?.rows() || [], limit = imageOpening?.snapshot().maxWindows || 1;
        button.textContent = 'Viewer Windows · ' + rows.length + '/' + limit;
        $('#viewer-windows-prev').disabled = $('#viewer-windows-next').disabled = !rows.length;
        const values = rows.map(row => ({ index: row.index, scope: row.scope, state: row.pending ? 'Loading' : !row.status?.ready || row.status.kind !== 'viewer' ? 'Unverified' : movingWindows.has(row.popup) ? 'Moving' : row.status.busy ? 'Busy' : row.status.dirty ? 'Unsaved' : 'Open' }));
        const next = JSON.stringify([values,displayScreens]); if (next === signature) return; signature = next;
        const focused = document.activeElement, focusIndex = focused?.dataset.windowIndex, focusAction = focused?.dataset.windowAction;
        list.replaceChildren();
        for (const row of values) {
          const section = document.createElement('section'); section.className = 'viewer-window-row';
          const label = document.createElement('p'), study = studies.find(s => s.uid === row.scope?.studies[0]);
          label.textContent = 'Window ' + (row.index + 1) + ' · ' + row.state + ' · ' +
            (study ? [study.name, study.date, study.desc, study.uid].filter(Boolean).join(' · ') : row.scope?.studies.join(' / ') || 'Unverified');
          if (row.scope?.studies.length === 2) { const comparison = studies.find(s => s.uid === row.scope.studies[1]); label.textContent += ' · Comparison: ' + (comparison ? [comparison.date, comparison.uid].join(' · ') : row.scope.studies[1]); }
          section.append(label);
          for (const action of ['focus', 'latest', 'close']) {
            const control = document.createElement('button'); control.type = 'button'; control.className = 'chip';
            control.textContent = action === 'focus' ? 'Focus' : action === 'latest' ? 'Latest Images' : 'Close Window';
            if (action === 'latest') { control.disabled = !['Open', 'Unsaved'].includes(row.state); control.title = '추가된 영상을 같은 검사 범위의 새 창에서 조회합니다. 기존 화면과 미저장 작업은 유지하며 설정한 창 수 제한을 따릅니다.'; }
            control.dataset.windowIndex = String(row.index); control.dataset.windowAction = action;
            control.onclick = () => operate(row.index, action); section.append(control);
          }
          displayScreens.forEach((screen,i)=>{
            const control=document.createElement('button');control.type='button';control.className='chip';
            control.textContent='Move to Display '+(i+1)+(screen.primary?' · Primary':'');
            control.title=`사용 가능 영역 ${screen.left}, ${screen.top} · ${screen.width} × ${screen.height}`;
            control.dataset.windowIndex=String(row.index);control.dataset.windowAction='display-'+i;
            control.disabled=!['Open','Unsaved'].includes(row.state);control.onclick=()=>moveDisplay(row.index,screen);section.append(control);
          });
          list.append(section);
        }
        if (!rows.length) list.textContent = '연결된 영상 창이 없습니다.';
        if (dialog.open && focusIndex !== undefined) (list.querySelector('[data-window-index="' + focusIndex + '"][data-window-action="' + focusAction + '"]:not(:disabled)') || $('#viewer-windows-done')).focus();
      }
      function operate(index, action) {
        if (!viewerWindows?.available()) { status.textContent = viewerWindows?.error() || '현재 계정을 확인한 뒤 다시 여세요.'; return; }
        const row = viewerWindows.rows().find(r => r.index === index); if (!row) { render(); return; }
        let popup = row.popup;
        if (!popup) {
          popup = window.open('', row.name, 'popup=yes,resizable=yes,scrollbars=yes');
          if (!popup) { status.textContent = '팝업이 차단되어 창 상태를 확인하지 못했습니다.'; return; }
          viewerWindows.attach(row, popup); ohifPopupSlots.set(popup, index);
          try { popup.opener = null; if (popup.location.href === 'about:blank') { popup.close(); render(); status.textContent = '이미 닫힌 창의 연결을 정리했습니다.'; return; } } catch (_) {}
        }
        if (action === 'latest') {
          const state = ohifPopupState(popup), target = state.kind === 'viewer' && state.ready && !state.busy && !row.pending && ohifScope(state.href);
          if (!target) { status.textContent = '기존 영상 창의 검사와 계정을 확인한 뒤 다시 여세요.'; return; }
          status.textContent = '';
          const readingReturn = new URLSearchParams(new URL(state.href, location.origin).hash.slice(1)).get('kin-reading-return');
          openOhifWindow(target.studies[0], target.studies[1] || null, target.series, readingReturn, { freshDocument: true, notice: message => { status.textContent = message; } });
          render(); return;
        }
        if (action === 'close') {
          if (row.pending) {
            status.textContent = '창을 닫지 않았습니다. 영상 창을 불러오는 중입니다. 완료 후 다시 확인하세요.';
            popup.focus(); return;
          }
          if (movingWindows.has(popup) || ohifPlacementWrites.get(popup)?.pending) {
            status.textContent = '창을 닫지 않았습니다. 화면 이동과 위치 저장이 끝난 뒤 다시 확인하세요.';
            popup.focus(); return;
          }
          const owner = KinViewerOpening.key(KinAuth.session()), sequence = ohifPopupSequences.get(popup);
          let viewerDocument; try { viewerDocument = popup.document; } catch (_) {}
          const state = ohifPopupState(popup);
          if (state.kind !== 'viewer' || !state.ready || state.busy || state.dirty) {
            status.textContent = '창을 닫지 않았습니다. 해당 창의 저장·복원 또는 미저장 작업을 확인하고 열린 대화상자를 닫은 뒤 다시 시도하세요.';
            popup.focus(); return;
          }
          if (typeof popup.kinViewerFrameCoverageConfirm !== 'function' || !popup.kinViewerFrameCoverageConfirm(message => confirm(message))) {
            status.textContent = '창을 닫지 않았습니다. Frame Coverage와 원본 영상을 확인하세요.'; return;
          }
          const current = viewerWindows.rows().find(r => r.index === index), rechecked = ohifPopupState(popup);
          let sameDocument = false; try { sameDocument = popup.document === viewerDocument; } catch (_) {}
          if (!viewerWindows.available() || !owner || owner !== KinViewerOpening.key(KinAuth.session()) || current?.popup !== popup || current.pending ||
              movingWindows.has(popup) || ohifPlacementWrites.get(popup)?.pending ||
              sequence !== ohifPopupSequences.get(popup) || !sameDocument || popup.closed || popup.location.href !== state.href ||
              rechecked.kind !== 'viewer' || rechecked.href !== state.href || !rechecked.ready || rechecked.busy || rechecked.dirty) {
            status.textContent = '창 상태가 바뀌어 닫지 않았습니다. 다시 확인하세요.'; return;
          }
          rememberOhifRect(popup); popup.close(); render();
          status.textContent = popup.closed ? '영상 창을 닫았습니다.' : '브라우저에서 창을 닫지 못했습니다. 해당 창에서 닫으세요.';
        } else { viewerWindowCursor = index; dialog.close(); popup.focus(); watchOhifRect(popup, index); }
      }
      let storage; try { storage = sessionStorage; } catch (_) {}
      viewerWindows = KinViewerWindows.create({ storage, owner: () => { const key = KinViewerOpening.key(KinAuth.session()); return key ? key.slice(KinViewerOpening.PREFIX.length) : null; },
        newId: () => crypto.randomUUID(), origin: location.origin, describe: ohifPopupState, changed: render });
      button.disabled = false;
      function cycle(step) {
        const rows = viewerWindows.rows(); if (!rows.length) return;
        const current = rows.findIndex(row => row.index === viewerWindowCursor);
        const next = current < 0 ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
        operate(rows[next].index, 'focus');
      }
      $('#viewer-windows-prev').onclick = () => cycle(-1); $('#viewer-windows-next').onclick = () => cycle(1);
      button.onclick = () => { viewerWindows.refresh(); render(); status.textContent = viewerWindows.error() || ''; dialog.showModal(); $('#viewer-windows-done').focus(); };
      $('#viewer-windows-done').onclick = () => dialog.close(); dialog.addEventListener('close', () => { ++displaySequence;if (!button.disabled) button.focus(); });
      // 주기마다 그때의 문맥으로 지난다: 로그아웃 준비 중에는 다시 그리지 않고, 편집으로 돌아오면 다음 주기가 이어 간다.
      const timer = setInterval(() => { work.commit(work.capture('document'), () => { viewerWindows.refresh(); render(); }); }, 2000);
      const end = () => { ++displaySequence;displayScreens=[];clearInterval(timer); viewerWindows.end(); button.disabled = true; dialog.close(); list.replaceChildren(); };
      onSessionEnd(end); window.addEventListener('pagehide', end);
      render();
    }