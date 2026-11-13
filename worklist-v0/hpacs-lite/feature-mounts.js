

    favoriteList = KinFavoriteList({ api,
      identity: () => { const s=KinAuth.session(); return s?.state==='approved' ? [s.institution,s.sub] : null; },
      changed: () => { $('#favorite-clear').hidden = !favoriteList.label(); render(); },
    });
    $('#favorite-clear').onclick = () => favoriteList.clear();
    const favorites = KinFavorites({ api, allowed: () => !!sess && serverMode && !demoMode && !offline,
      identity: () => { const s=KinAuth.session(); return s?.state==='approved' ? [s.institution,s.sub] : null; },
      current: () => selectedUid, study: uid => studies.find(s => s.uid===uid), select,
      applyFolder: (value,id) => favoriteList.apply(value,id), changed: value => favoriteList.adopt(value), ended: () => favoriteList.end(),
      // The saved view opens on its study only once the selection has moved there (W4 navigation gate).
      openSavedView: (uid,job) => whenSelected(select(uid,{deferViewer:true}),uid,()=>readingWorkspace.openJob(uid,job)),
      notice: message => toast(message,'err'),
    });
    $('#favorite-open').onclick = () => favorites.open();
    function tagScopeState(data,scope){
      const catalog=data?.catalogs?.find(c=>c.scope===scope);
      if(!catalog||!Array.isArray(catalog.tags))throw new Error('태그 범위를 확인할 수 없습니다');
      return {owner:data.owner,revision:catalog.revision,folders:catalog.tags.map(t=>({...t,name:(scope==='personal'?'[개인] ':'[기관] ')+t.name}))};
    }
    studyTagList=KinFavoriteList({api,label:'태그',noun:'태그',
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      read:async (signal,at)=>tagScopeState(await api('GET','/study-tags',undefined,signal,at),studyTagScope),
      changed:()=>{$('#study-tag-clear').hidden=!studyTagList.label();render();},
    });
    const studyTags=KinStudyTags({api,allowed:()=>!!sess&&serverMode&&!demoMode&&!offline,
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      current:()=>selectedUid,study:uid=>studies.find(s=>s.uid===uid),notice:message=>toast(message,'err'),
      changed:data=>{if(studyTagList.key())studyTagList.adopt(tagScopeState(data,studyTagScope));},ended:()=>studyTagList.end(),
      apply:(data,scope,id)=>{studyTagScope=scope;studyTagList.apply(tagScopeState(data,scope),id);},
    });
    $('#study-tag-open').onclick=()=>studyTags.open();$('#study-tag-clear').onclick=()=>studyTagList.clear();
    const consultations=KinConsultations({api,
      allowed:()=>!!sess&&serverMode&&!demoMode&&!offline&&(KinAuth.has('radiologist')||KinAuth.has('admin')),
      admin:()=>KinAuth.has('admin'),identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      current:()=>studies.find(s=>s.uid===selectedUid),study:uid=>studies.find(s=>s.uid===uid),
      openStudy:uid=>select(uid,{openSelected:true}),
      filter:(uids,direction)=>{
        clearWorklistFilters();const wanted=new Set(uids),known=new Set(studies.map(s=>s.uid));
        consultationFilter={uids:wanted,revision:++consultationFilterSequence,label:(direction==='received'?'Received':'Sent')+' Consultations · Loaded Requests'};render();
        const missing=[...wanted].filter(uid=>!known.has(uid)).length;
        if(missing)toast(`자문 검사 ${wanted.size}건 중 ${missing}건이 현재 불러온 검사 목록에 없습니다. Refresh 후 접근 가능한 검사를 확인하세요.`, 'info');
      },
      clearFilter:()=>{consultationFilter=null;render();},
    });
    $('#consultations-open').onclick=()=>consultations.open();

    const readerAssignment=KinReaderAssignment({api,allowed:()=>!!sess&&serverMode&&!demoMode&&!offline,
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.institution,s.sub]:null;},
      changed:(uid,value)=>{updateReaderAssignment(uid,value);render();},
    });
    $('#rows').addEventListener('click',event=>{const button=event.target.closest('[data-reader-assignment]');if(!button)return;event.stopPropagation();readerAssignment.open(studies.find(s=>s.uid===button.dataset.readerAssignment));},true);
    // S9-U4b: Import DICOM (toolbar, Technician rows), Download Originals (rows) and their non-modal result panel.
    // D1691: the transfer owner is the login server, the institution and the subject, as the service keys an operation.
    const studyTransfer=KinStudyTransferLocal({api:API,transport,allowed:()=>!!sess&&serverMode&&!demoMode&&!offline,
      identity:()=>{const s=KinAuth.session();return s?.state==='approved'?[s.issuer,s.institution,s.sub]:null;},
      can:role=>KinAuth.has(role),demo:()=>!!KinAuth.session()?.demo,study:uid=>studies.find(s=>s.uid===uid),
    });
    // FC-076: Attach Document (Technician rows and #t-attach, the end of the Radiology rows) and its dialog.
    const studyAttachments=KinStudyAttachments({api:API,transport,allowed:()=>!!sess&&serverMode&&!demoMode&&!offline,
      can:role=>KinAuth.has(role),demo:()=>!!KinAuth.session()?.demo,study:uid=>studies.find(s=>s.uid===uid),
      current:()=>selectedUid,button:$('#t-attach'),notice:message=>toast(message,'err'),
    });


    const techNote = KinTechNote({ api, allowed: () => !!sess && serverMode && !demoMode && !offline,
      changed: (uid, note) => { updateNoteSummary(uid, { version: note?.version ?? 0, present: !!note?.text }); readingWorkspace.refreshNote(); },
      restoreFocus: uid => $('#rows').querySelector(`[data-tech-note="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true }),
    });
    $('#tech-note-open').onclick = () => techNote.open(viewed());
    /**
     * 이 Worklist 탭의 Tech Note도 Log out이 묻는 작업이다(S7-U5 fix-up E, 입력 유실). 같은 세션의 다른 탭에서 Log out을 누르면
     * 그 탭은 이 탭을 들여다보지 않는다 — 뷰어 문서와 같은 계약으로 이 탭이 스스로 알린다: 저장하지 않았거나 아직 저장 중인
     * 메모가 있는 동안 Web Lock `kin-unsaved:<세션>:<문서>:worklist-note`를 쥐고(탭이 닫히면 브라우저가 놓는다), 같은 세션의
     * `session-work-query`에 지금 상태로 답한다(viewer-session.js와 같은 방식, otherUnsavedWork가 읽는다). 메모를 열기만 했거나
     * 읽는 중이면 알리지 않는다(tech-note.js dirty — 쳐 둔 글이나 답을 받지 못한 저장만).
     */
    const workDocument = crypto.randomUUID();
    let workDeclared = null;
    const ownUnsavedKinds = () => {
      try { return work.state() === "active" && techNote.dirty?.() ? ["worklist-note"] : []; } catch (_) { return []; }
    };
    function declareOwnWork() {
      const session = work.session(), kinds = session ? ownUnsavedKinds() : [];
      const name = kinds.length ? "kin-unsaved:" + session + ":" + workDocument + ":" + kinds.join(",") : null;
      if ((workDeclared ? workDeclared.name : null) === name) return;
      const previous = workDeclared, next = name ? { name, release: null, dropped: false } : null;
      const drop = held => { if (held) { held.dropped = true; held.release?.(); } };
      workDeclared = next;
      if (!next) { drop(previous); return; }
      // 새 알림을 받은 뒤에 옛 알림을 놓는다: 알림이 없는 순간이 없다.
      try {
        navigator.locks.request(name, () => new Promise(resolve => { next.release = resolve; drop(previous); if (next.dropped) resolve(); }))
          .catch(() => { drop(previous); if (workDeclared === next) workDeclared = null; });
      } catch (_) { drop(previous); workDeclared = null; }
    }
    setInterval(declareOwnWork, 500);
    for (const type of ["input", "change", "pointerup", "keyup"]) document.addEventListener(type, () => setTimeout(declareOwnWork, 0), true);
    try {
      const workChannel = new BroadcastChannel("kin-session");
      workChannel.onmessage = event => {
        const data = event.data, session = work.session();
        if (!session || !data || data.type !== "session-work-query" || data.session !== session) return;
        declareOwnWork();
        try { workChannel.postMessage({ type: "session-work", session, document: workDocument, query: data.query, unsaved: ownUnsavedKinds() }); } catch (_) {}
      };
    } catch (_) {}
    // C-R01-139: 영상 창의 환자 탭을 바꾸는 것도 그 검사를 떠나는 길이다(viewer-patient-tabs.js). 같은 세션의 영상 창이 떠나려는
    // 탭의 검사를 물으면('check') 이 문서에 서버가 아직 확인하지 않은 글(reportConverge)이 그 검사에 있는지만 답하고, 저장을
    // 청하면('save') 이 문서의 검사 이동과 같은 관문(leaveStudyGate)으로 쓰던 글을 저장한 뒤 지금의 선택·세션·글자 조합을 다시
    // 보고 답한다. 글·선택·Notice는 바꾸지 않는다. 지금 고른 검사가 아닌 검사의 글은 보내지 않는다 — 그 글은 이 화면에서 그
    // 검사를 다시 고를 때 관문이 맡는다. 세션이 살아 있는 동안 Web Lock `kin-report-reader:<세션>:<문서>`를 쥔다: 이 페이지가
    // 닫히거나 죽으면 브라우저가 놓으므로, 영상 창은 없는 판독 화면을 기다리지 않고 답하지 않는 판독 화면을 저장으로 보지 않는다.
    try {
      const leaveChannel = new BroadcastChannel("kin-report-unconfirmed");
      const leaveDocument = crypto.randomUUID();
      const leaveSession = () => { try { return work.state() === "active" ? work.session() || null : null; } catch (_) { return null; } };
      let leaveLock = null;
      function holdLeaveLock() {
        const session = leaveSession();
        if ((leaveLock ? leaveLock.session : null) === session) return;
        const previous = leaveLock;
        leaveLock = null;
        if (previous) { previous.dropped = true; previous.release?.(); }
        if (!session) return;
        const held = leaveLock = { session, release: null, dropped: false };
        // Reading the lock manager can itself throw (a SecurityError); like a missing one, that is no lock and no page error.
        try {
          if (!navigator.locks) { leaveLock = null; return; }
          navigator.locks.request("kin-report-reader:" + session + ":" + leaveDocument,
            () => new Promise(resolve => { held.release = resolve; if (held.dropped) resolve(); }))
            .catch(() => { if (leaveLock === held) leaveLock = null; });
        } catch (_) { leaveLock = null; }
      }
      // The lock follows the session as it is admitted or ends (lifecycle notices), with the same 500 ms repair as above.
      work.onInvalidate(event => { if (event?.reason === "lifecycle") holdLeaveLock(); });
      setInterval(holdLeaveLock, 500);
      holdLeaveLock();
      const leavePost = (session, message) => { try { leaveChannel.postMessage({ ...message, id: leaveDocument, session }); } catch (_) {} };
      leaveChannel.onmessage = async event => {
        const m = event.data, session = leaveSession();
        if (!session || !m || m.session !== session) return;
        if (m.type === "hello") { leavePost(session, { type: "here" }); return; }
        if (!["check", "save"].includes(m.type) || typeof m.request !== "string" || !Array.isArray(m.uids)) return;
        const uid = selectedUid, seq = selectionSeq, mine = !!uid && m.uids.includes(uid);
        let result = null;
        if (mine && reportFrame?.isComposing()) result = { status: "composing" };
        else if (m.type === "save") {
          result = { status: "clear" };
          if (mine && reportConverge.has(uid)) {
            try { result = await leaveStudyGate("viewer"); } catch (_) { result = { status: "unknown" }; }
            // 기다리는 사이 바뀐 것: 이 답은 그 세션·그 선택·조합이 끝난 글에 대한 것이어야 한다.
            if (leaveSession() !== session || selectedUid !== uid || selectionSeq !== seq) result = { status: "stale" };
            else if (reportFrame?.isComposing()) result = { status: "composing" };
          } else if (m.uids.some(other => reportConverge.has(other))) {
            result = { status: "refused", reason: "판독 화면에서 그 검사를 다시 고른 뒤 저장하세요" };
          }
        }
        if (leaveSession() !== session) return;
        leavePost(session, { type: "answer", request: m.request, result: result && { status: result.status, reason: result.reason ?? null },
          held: m.uids.filter(other => reportConverge.has(other)) });
      };
      const announce = type => { const session = leaveSession(); if (session) leavePost(session, { type }); };
      announce("here");
      window.addEventListener("pagehide", () => announce("gone"));
      window.addEventListener("pageshow", event => { if (event.persisted) announce("here"); });
    } catch (_) {}
    // 읽기 작업공간의 종료(pagehide)가 부르는 배치 적용이다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).
    let layoutMode = "auto";
    let workspaceState = KinWorkspaceLayout.defaults();
    let workspaceEnded = false, studyPanel = null, studyPanelRestoring = false, workspaceWasNarrow = false;
    // A size under a drag is shown but stored only when the drag ends; the edge being resized now.
    let studyPanelPreview = null, studyPanelEdge = null;
    const studyPanelAvailable = () => KinAuth.has('radiologist') ? ['images', 'info', 'templates'] : ['images', 'info'];
    // The report section the drawer's focus came from. A study opening replaces the report fields, so the drawer's
    // remembered node can be a removed one; the section it named is still the reader's (W6-PAGE-18).
    let studyPanelField = null;
    function noteStudyPanelOpener(el) {
      // The drawer keeps the last outside element focus came from; the page and its own controls do not replace it.
      if (!el || el === document.body || el === document.documentElement || $('#study-panel-host').contains(el)) return;
      studyPanelField = RFIELDS.includes(el.id) && el === $('#' + el.id) ? el.id : null;
    }
    $('#study-panel-host').addEventListener('focusin', event => noteStudyPanelOpener(event.relatedTarget));
    function openStudyPanel(tab) {
      if (workspaceEnded || work.state() !== 'active') return false;
      if (tab && !studyPanelAvailable().includes(tab)) return false;
      // A new drawer starts from the focus it is opened from.
      if (!studyPanel) studyPanelField = null;
      noteStudyPanelOpener(document.activeElement);
      workspaceState = KinWorkspaceLayout.toVersion3(workspaceState);
      if (!studyPanel) {
        // Mount on the explicit open: legacy layouts keep their first paint.
        // destroy() returns these same nodes, with their listeners, to the row.
        studyPanel = KinStudyPanel({ host: $('#study-panel-host'), opener: document.activeElement,
          content: { images: $('.s-thumb'), info: $('.s-clinical'), templates: $('.s-template') },
          available: studyPanelAvailable(), fallbackFocus: () => [studyPanelField && $('#' + studyPanelField), $('#findings'), $('#quick'), $('#study-panel-open')]
            .find(node => node?.isConnected && !node.disabled && !node.closest('[hidden], [inert]')
              && node.getClientRects().length && getComputedStyle(node).visibility === 'visible'),
          escapeClaimed: () => !!document.querySelector('dialog[open], .modal.show, [popover]:popover-open'),
          onChange: state => {
            $('#study-panel-open').setAttribute('aria-expanded', String(state.open));
            document.querySelector('#reading-bar [aria-controls="study-panel-host"]')?.setAttribute('aria-expanded', String(state.open));
            if (!studyPanelRestoring && workspaceState.workspace.studyPanelTab !== state.tab) {
              workspaceState.workspace.studyPanelTab = state.tab; saveWorkspace(true);
            }
            $('#study-panel-status').textContent = state.open ? 'Study Panel을 열었습니다.' : 'Study Panel을 닫았습니다.';
            if (!state.open && !studyPanelRestoring) {
              const panel = studyPanel; studyPanel = null; panel?.destroy();
              studyPanelPreview = null;
              document.body.classList.remove('study-panel-open');
            }
          },
          onResize: resizeStudyPanel,
          onText: text => changeStudyPanel({ text }),
          // The drawer has already ended a drag in progress; its preview never outlives Default (W3R7-06).
          onReset: () => { studyPanelPreview = null; changeStudyPanel(null); },
        });
        studyPanelRestoring = true;
        studyPanel.restore({ open: false, tab: workspaceState.workspace.studyPanelTab });
        studyPanelRestoring = false;
      }
      document.body.classList.add('study-panel-open');
      const opened = studyPanel.open(tab);
      applyLayout();
      return opened;
    }
    const portraitLayout = () => document.body.classList.contains("portrait");
    const workspaceAxis = () => portraitLayout() ? "portrait" : "landscape";
    function applyLayout() {
      if (workspaceEnded) return;
      // A selected study needs a usable row hit area even in a narrow landscape
      // window. The stacked panels scroll vertically without changing saved sizes.
      const narrow = innerWidth < 900 && innerHeight <= innerWidth && !!selectedUid;
      const portrait = narrow || layoutMode === "portrait" || (layoutMode === "auto" && innerHeight > innerWidth);
      document.body.classList.toggle("portrait", portrait);
      document.body.classList.toggle('workspace-narrow', narrow);
      // A strip consumes height only in stacked layouts. Short side-by-side
      // windows retain their existing prior-report line; View opens the drawer.
      document.body.classList.toggle('workspace-strip', portrait && innerWidth <= 1100 && !!selectedUid);
      $("#layout-toggle").textContent = {
        auto: "Layout: Auto", portrait: "Layout: Portrait", landscape: "Layout: Landscape",
      }[layoutMode];
      $("#layout-toggle").setAttribute("aria-label", `화면 배치 ${layoutMode}`);
      $("#resize-main").setAttribute("aria-orientation", portrait ? "horizontal" : "vertical");
      // Related Report sits above Report Editor in every layout: its handle is always a height handle.
      $("#resize-related").setAttribute("aria-orientation", "horizontal");
      $(".related-p").style.width = "";
      if (portrait) $(".left").style.width = "";
      else $(".left").style.height = "";
      // A temporary small window must not overwrite the user's preferred size.
      // Reapply stored pixels within today's bounds, separately for each orientation:
      // a landscape width is never a portrait height (W3R-07).
      const sizes = workspaceState[workspaceAxis()], geometry = workspaceState.workspace;
      if (geometry) {
        // The Rail button is gone, so a saved "collapsed" value must not keep the panel narrow.
        document.body.classList.remove('workspace-rail-collapsed');
        document.body.style.setProperty('--workspace-rail-width', clampPanel(geometry.rail ?? 220, 160, Math.max(160, innerWidth / 3)) + 'px');
        $('#rail-collapse')?.setAttribute('aria-expanded', String(!geometry.railCollapsed));
      }
      const left = $(".left"), related = $(".related-p"), top = $(".rw"), prior = $(".related-list-pane");
      // Before any measuring below: the workflow mode and the hidden panels decide the band's panels and their columns.
      // Each column is its share of the shown shares; the last takes the remainder, as Template always has, so the
      // default band paints to the same sub-pixel as the percentage widths it replaces.
      // Panels에서 되살린 선택을 기본 숨김 규칙으로 다시 덮지 않는다.
      const band = KinWorkspaceLayout.reportWindow(mode, geometry?.hiddenPanels || []);
      for (const [name, on] of Object.entries(band.classes)) document.body.classList.toggle(name, on);
      const shares = band.content.reduce((sum, p) => sum + p.share, 0);
      top.style.setProperty('--kin-rw-columns', band.content.map((p, i) => i === band.content.length - 1 ? 'minmax(0, 1fr)'
        : `${100 * p.share / shares}%`).join(' ') || 'minmax(0, 1fr)');
      left.style[portrait ? "height" : "width"] = "";
      related.style.height = "";
      top.style.height = "";
      prior.style.height = "";
      prior.style.flex = "";
      const split = $(".split").getBoundingClientRect();
      if (sizes.main != null) left.style[portrait ? "height" : "width"] = clampPanel(sizes.main,
        portrait ? 180 : 500, portrait ? split.height - 420 : split.width - 426) + "px";
      // Every worklist keeps its column header and one whole row in view, as in the
      // approved portrait picture (W3R-09; the Related list follows the same rule,
      // D383). Wrapped list controls take their own height, not the rows'. A stacked
      // list grows into the work area below it. A side-by-side list column, and the
      // narrow sheet's band (which also shows the next row where it has room, so the
      // next study is one click away), keep that floor and scroll vertically instead:
      // past the minimums the page scrolls, nothing is clipped (design v4 §1, v5 §2).
      left.style.minHeight = "";
      const listGrid = left.querySelector(":scope > .grid"), listTable = listGrid?.querySelector("table");
      // Each pass measures the list without its floor; a re-measure (rendered rows,
      // a resize) keeps where the reader had scrolled the column and the list.
      const listScroll = [left.scrollTop, listGrid?.scrollTop || 0];
      if (listGrid) listGrid.style.minHeight = "";
      document.body.classList.remove("workspace-list-scroll");
      let listNeed = 0, listFloor = 0;
      const becameNarrow = narrow && !workspaceWasNarrow;
      const keepListFloor = () => {
        const scrolling = document.body.classList.contains("workspace-list-scroll");
        if (listFloor - listGrid.getBoundingClientRect().height > 0.5) {
          listGrid.style.minHeight = Math.ceil(listFloor) + "px";
          document.body.classList.add("workspace-list-scroll");
        }
        if (!document.body.classList.contains("workspace-list-scroll")) return;
        left.style.setProperty("--workspace-list-height", left.clientHeight + "px");
        if (!scrolling && !becameNarrow) [left.scrollTop, listGrid.scrollTop] = listScroll;
      };
      if (!document.body.classList.contains("reading") && listTable?.tHead && listGrid.getClientRects().length) {
        const grid = listGrid, table = listTable, rows = table.tBodies[0]?.rows || [];
        const rowHeight = index => rows[index]?.getBoundingClientRect().height || 41;
        const need = listNeed = table.tHead.getBoundingClientRect().height + rowHeight(0) + grid.offsetHeight - grid.clientHeight;
        const short = need - grid.getBoundingClientRect().height;
        if (portrait && !narrow) {
          // Grow by whole pixels: the work area below moves down unchanged, keeping
          // the sub-pixel position each of its lines and borders had at first paint.
          if (short > 0) left.style.minHeight = left.getBoundingClientRect().height + Math.ceil(short) + "px";
          // Controls that wrap to more lines than the column holds overflow it with
          // the list already at 0 px; part of that first grow goes to the overflow, so
          // grow again by what the list still misses (row 0 was cut at 768x1024 once
          // the Selected toolbar wrapped to a third line).
          const still = need - grid.getBoundingClientRect().height;
          if (short > 0 && still > 0.5) left.style.minHeight = left.getBoundingClientRect().height + Math.ceil(still) + "px";
        } else {
          listFloor = need + (narrow && rows.length > 1 ? rowHeight(1) : 0);
          keepListFloor();
        }
      }
      workspaceWasNarrow = narrow;
      const topMaximum = $(".right").getBoundingClientRect().height - 266;
      if (sizes.top != null) {
        // A tight column may keep its default band, but a taller window's saved
        // height must still yield to this window's prior report line below.
        const maximum = topMaximum < 140 ? top.getBoundingClientRect().height : topMaximum;
        top.style.height = clampPanel(sizes.top, 140, maximum) + "px";
      }
      const row = $(".workrow").getBoundingClientRect();
      if (sizes.related != null) related.style.height = clampPanel(sizes.related,
        portrait ? 286 : 150, row.height - 186) + "px";
      if (sizes.prior != null) {
        prior.style.flex = "none";
        prior.style.height = clampPanel(sizes.prior, 80, left.getBoundingClientRect().height - 170) + "px";
      }
      if (selectedUid && !document.body.classList.contains('reading') && (portrait || innerWidth < 900)) {
        // Wrapped controls and the hidden-filter notice belong above the table,
        // not on top of its selected row. Keep a full header + row hit area.
        const grid = prior.querySelector('.grid2'), table = grid.querySelector('table');
        const fixed = [...prior.children].filter(child => child !== grid && !child.matches('[popover]'))
          .reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
        const floor = Math.ceil(fixed + (table.tHead?.getBoundingClientRect().height || 24)
          + (table.tBodies[0]?.rows[0]?.getBoundingClientRect().height || 41) + 2);
        if (portrait) {
          prior.style.maxHeight = ''; prior.style.overflowY = '';
          related.querySelector('.prior-report-pane').style.minHeight = '';
          prior.style.minHeight = floor + 'px';

        } else {
          prior.style.minHeight = floor + 'px'; prior.style.overflowY = 'auto';
          related.querySelector('.prior-report-pane').style.minHeight = '43px';
        }
      } else {
        prior.style.minHeight = ''; prior.style.maxHeight = ''; prior.style.overflowY = '';
        related.style.minHeight = ''; related.querySelector('.prior-report-pane').style.minHeight = '';
      }
      // The worklist floor must not push the prior report's first line out of a
      // stacked work area (D383). The report window band yields first, only as much
      // as needed and never below its 140 px drag minimum. In a tight column even
      // a stored band must yield, without overwriting the reader's saved height.
      // The pane's text is its plain view's body or, while Related Report mode stands in that view's place (Minhoon item 8),
      // the mode's text region: the one on screen is measured (a hidden one measures at the top of the window).
      const priorText = () => related.querySelector("#related-mode:not([hidden]) .related-mode-scroll")
        || related.querySelector(".prior-report-body");
      // How far that line (two text lines into the pane's body) lies below the work area.
      const lineOver = () => {
        const area = $(".right"), body = priorText(), style = getComputedStyle(body);
        const line = body.getBoundingClientRect().top + area.scrollTop + parseFloat(style.paddingTop) + 2 * parseFloat(style.fontSize);
        return line - area.getBoundingClientRect().bottom;
      };
      // The list band yields to that line only as much as needed and never below
      // the list's header and one whole row; the list then fills the shorter band
      // and scrolls inside it, and the controls under it scroll in the column.
      const listYields = over => {
        if (!(over > 0 && listNeed)) return;
        const band = Math.max(Math.ceil(listNeed), Math.floor(left.getBoundingClientRect().height - over));
        left.style.setProperty("height", band + "px", "important");
        left.style.minHeight = band + "px";
        listFloor = Math.max(listNeed, Math.min(listFloor, band));
        listGrid.style.minHeight = "";
        keepListFloor();
      };
      if (portrait && !narrow && (sizes.top == null || topMaximum < 140) && !document.body.classList.contains("reading")) {
        const over = lineOver();
        if (over > 0) top.style.height = Math.max(140, Math.floor(top.getBoundingClientRect().height - over)) + "px";
        // A band at its minimum can still leave the line below: the list's controls
        // took a line more (at 768x1024 the Selected toolbar wraps to a third line
        // since Preload, D1880). The stacked list yields the rest, as the narrow
        // sheet's does.
        if (over > 0) listYields(lineOver());
      }
      // In the narrow sheet the list band yields to that line the same way; the
      // next row is then a wheel turn away inside the band.
      if (narrow && listNeed) listYields(lineOver());
      // Becoming the narrow sheet at selection reflows the list: bring the band's
      // top and the selected row back into view, scrolling inside the band only.
      if (becameNarrow && listNeed) {
        left.scrollTop = 0;
        const selected = selectedUid && listTable.tBodies[0]?.querySelector(`tr[data-uid="${CSS.escape(selectedUid)}"]`);
        if (selected) {
          const area = listGrid.getBoundingClientRect(), box = selected.getBoundingClientRect();
          const top = area.top + listTable.tHead.getBoundingClientRect().height;
          const bottom = Math.min(area.bottom - (listGrid.offsetHeight - listGrid.clientHeight), left.getBoundingClientRect().top + left.clientHeight);
          if (box.top < top) listGrid.scrollTop -= top - box.top;
          else if (box.bottom > bottom) listGrid.scrollTop += box.bottom - bottom;
        }
      }
      if (studyPanel) placeStudyPanel();
    }
    // The open Study Panel never covers the report section (W3R5-03 ②). Wide
    // landscape: the 360 px column left of the report, from the work area's top.
    // Stacked layouts and small windows: across the window from the work area's top,
    // the approved 55 % of the window high at most and ending 12 px above the report
    // section; it follows the report as the work area scrolls, so Approve/Save/Prelim
    // and the fields stay where the reader sees them, and the work area below the
    // panel stays in view to scroll to the report.
    //
    // The reader may move the panel's free edge (pilot D1160): its width where it is a column, its height where
    // it spans the window, stored per orientation with the Text Size step. With nothing stored and Normal text
    // every form is exactly the placement above. A chosen size stays between a minimum and the room this rule
    // gives: never under the report section or its column (W3R5-03 ②). The minimum keeps the panel usable,
    // larger with the text: a column fits its header row and three tabs in one row (320 px), a band holds 240 px
    // (the room below which this rule already puts the panel beside the report instead).
    function placeStudyPanel() {
      const host = $('#study-panel-host');
      host.style.width = '';
      const axis = workspaceAxis();
      const chosen = workspaceState.workspace?.studyPanel?.[axis] || {}, text = chosen.text || 0;
      const scale = KinStudyPanel.TEXT_SCALES[text], minWidth = Math.ceil(320 * scale), minHeight = Math.ceil(240 * scale);
      // A preview belongs to the edge (orientation and dimension) its drag started on (W3R7-02).
      const wanted = name => studyPanelPreview?.key === axis + ':' + name ? studyPanelPreview.size : chosen[name];
      // The default when nothing was chosen; otherwise the choice (or the default) within [minimum, room].
      const size = (name, initial, minimum, room) => wanted(name) == null && !text ? initial
        : Math.min(room, Math.max(minimum, wanted(name) ?? initial));
      const edge = (name, value, minimum, room) => {
        const key = axis + ':' + name;
        // The window turned or the panel changed form under a drag: that drag ends here without a result, and
        // the drawer stops it too (setSize names the new edge), so its release changes neither record.
        if (studyPanelPreview && studyPanelPreview.key !== key) studyPanelPreview = null;
        studyPanelEdge = { key, name, value, min: Math.min(minimum, room), max: room };
        studyPanel.setSize({ axis: name === 'width' ? 'x' : 'y', key, value, min: studyPanelEdge.min, max: room });
      };
      studyPanel.setText(text);
      const report = $('.report-p').getBoundingClientRect();
      if (portraitLayout() || innerWidth <= 1100) {
        const area = $('.split').getBoundingClientRect();
        const top = Math.max(0, area.top), bottom = Math.min(report.top, area.bottom, innerHeight) - 12;
        host.style.top = top + 'px';
        // Too little room above a report column beside the work area (Reading
        // Workspace, short side-by-side windows): the column left of it instead.
        if (bottom - top < 240 && report.left - 24 >= 240) {
          const room = report.left - 24, width = size('width', room, minWidth, room);
          host.style.width = width + 'px';
          host.style.height = Math.max(120, Math.min(area.bottom, innerHeight) - 12 - top) + 'px';
          edge('width', width, minWidth, room);
          return;
        }
        const room = Math.max(120, bottom - top);
        const height = Math.max(120, size('height', Math.min(innerHeight * 0.55, bottom - top), minHeight, room));
        host.style.height = height + 'px';
        edge('height', height, Math.max(120, minHeight), room);
        return;
      }
      const top = Math.max(0, $('.right').getBoundingClientRect().top);
      host.style.top = top + 'px';
      host.style.height = Math.max(120, innerHeight - top - 12) + 'px';
      // The 360 px column (D1041 3-①) is the stylesheet's; any width, the default included, ends 12 px before the
      // report column, so neither the panel nor its edge reaches a report column widened to its largest
      // (Reading Workspace, Image and Report Size at End: W3R7-05). Where there is room it is the 360 px column.
      const room = Math.max(120, Math.min(innerWidth, report.width ? report.left : innerWidth) - 24);
      const width = size('width', Math.min(360, room), minWidth, room);
      if (wanted('width') != null || text || width !== 360) host.style.width = width + 'px';
      edge('width', width, minWidth, room);
    }
    // The drawer reports the reader's drag/keys; the page clamps, shows and (when the drag ends) stores.
    function resizeStudyPanel(value, phase) {
      if (!studyPanel || !studyPanelEdge) return;
      // A cancelled drag, or one the workspace stopped accepting (a session ending), leaves the stored size shown.
      if (phase === 'cancel' || !workspaceEditable()) {
        if (studyPanelPreview) { studyPanelPreview = null; placeStudyPanel(); }
        return;
      }
      const size = Math.round(Math.min(studyPanelEdge.max, Math.max(studyPanelEdge.min, value)));
      const preview = studyPanelPreview?.key === studyPanelEdge.key ? studyPanelPreview : null;
      if (phase === 'move') {
        // The drag's first move that changes the shown size is the reader's newer local choice: an account Load
        // still on its way then gives way to it (W3R7-03). A press without movement, a move held at a bound and
        // Default at the default are no change; the choice itself is stored once, when the drag ends.
        const changed = !!preview?.changed || size !== Math.round(studyPanelEdge.value);
        if (changed && !preview?.changed) workspaceGeneration++;
        studyPanelPreview = { key: studyPanelEdge.key, name: studyPanelEdge.name, size, changed };
        placeStudyPanel(); return;
      }
      studyPanelPreview = null;
      // A drag that never changed the shown size ends as it began: nothing is chosen or stored.
      if (preview && !preview.changed && size === Math.round(studyPanelEdge.value)) { placeStudyPanel(); return; }
      changeStudyPanel({ [studyPanelEdge.name]: size });
    }
    // A change of this orientation's size or Text Size step, or (null) the default for this orientation.
    function changeStudyPanel(change) {
      if (!workspaceEditable()) return;
      const next = KinWorkspaceLayout.withStudyPanel(workspaceState, workspaceAxis(), change);
      if (!next) return;
      // The same choice again (Default at the default, End at the largest size) writes nothing: a write would also
      // make an account Load that is still on its way give way to a change that did not happen.
      const same = JSON.stringify(next.workspace.studyPanel || {}) === JSON.stringify(workspaceState.workspace?.studyPanel || {});
      workspaceState = next;
      if (studyPanel) placeStudyPanel();
      if (!same) saveWorkspace(true);
    }
    document.addEventListener('scroll', event => {
      if (studyPanel && !workspaceEnded && event.target instanceof Element && event.target.matches('.split, .right')) placeStudyPanel();
    }, { capture: true, passive: true });
    const readingWorkspace = KinReadingWorkspace({
      current: () => selectedUid, study: uid => studies.find(s => s.uid === uid),
      formatDate: fmtD,
      prior: autoPrior, move, select, queue: orderedStudies, layout: () => applyLayout(), popup: openOhifWindow,
      // A viewer window's Open in Reading Screen ends where the worklist's own ways to the editor end (related-report.js).
      focusReport: () => focusReportEditor(),
      onPanelsEdit: () => { workspaceGeneration++; },
      onPanelsChange: reading => {
        const state = KinWorkspaceLayout.withReading(workspaceState, reading);
        if (state) { workspaceState = state; saveWorkspace(); }
      },
      noteLabel, openNote: uid => techNote.open(studies.find(s => s.uid === uid)),
      hasNote: uid => noteSummaries.get(uid)?.present,
      noteOwner: () => { const key = KinWorkspaceLayout.key(KinAuth.session()); return key ? key.slice(KinWorkspaceLayout.PREFIX.length) : null; },
      allowed: () => !!sess && serverMode && !demoMode && !offline,
      notice: message => toast(message, 'err'),
    });
    $('#m-reading').addEventListener('click', () => {
      if (readingWorkspace.active()) { readingWorkspace.exit(); return; }
      if (!selectedUid) { toast('판독할 검사를 먼저 선택하세요.', 'info'); return; }
      readingWorkspace.resume(selectedUid, relatedUid || autoPrior(selectedUid));
    });
    // Read-only Image Findings of the selected study; an unavailable list must not block reading.
    let readingFindings = null;
    try {
      readingFindings = KinReadingFindings({
        current: () => selectedUid, allowed: () => !!sess && serverMode && !demoMode && !offline, api,
        owner: () => { const key = KinViewerOpening.key(KinAuth.session()); return key ? key.slice(KinViewerOpening.PREFIX.length) : null; },
        sub: () => KinAuth.session()?.sub || null,
        workspace: readingWorkspace, windows: () => viewerWindows?.available() ? viewerWindows.rows() : [],
        popup: openOhifWindow, open: uid => openFilmbox(uid),
        // 판독문 쪽 관문·미리보기·서버 요청은 전부 이쪽에 있다. 소견 패널은 자기가 지금
        // 읽고 있는 행에서 요청을 만들어 건네기만 하고 판독문을 직접 쓰지 않는다.
        cite: (request, origin) => openCitePreview(request, origin),
      });
    } catch (_) { toast('영상 소견 목록을 불러오지 못했습니다. 영상 화면의 Findings를 사용하세요.', 'err'); }

    /**
     * Add-on features of the worklist page. A feature file loaded before this bundle registers itself with
     * `(window.KinWorklistAddOns ||= []).push(install)` and is installed here once, with one frozen context: it reads copies
     * of the page's state and acts only through the page's own paths (the request gate, select, the report edit gate).
     * Each install runs on its own; a failing one is reported by name and the next one is still installed.
     *
     *   api(method, path, body?, signal?, at?)  the page's request; `at` defaults to work('study'), so an answer that arrives
     *                                           after the study changed (or the session ended) is dropped as an AbortError
     *   work(scope = 'study')                   the current work context ('document' | 'study' | 'editor') to pass to api
     *   toast(message, kind)                    the page's one-line notice ('ok' | 'info' | 'err')
     *   studies(), study(uid)                   copies of the loaded list / one row (changing them changes nothing)
     *   selectedUid(), select(uid, opts)        the selected study; a move through the page's own gate ({ deferViewer, openSelected })
     *   mode(), has(role), session()            'Radiology' | 'Technician'; the signed-in roles; a copy of the session
     *   allowed()                               signed in to the server, not demo, not offline, and the work session active
     *   reload()                                read the list again
     *   onRender(fn), onSelect(fn), onEnd(fn)   after the list is drawn / after a move to another study / once when the
     *                                           session ends or the page goes away; each returns a function that removes it
     *   report.insertAtTop(field, text, { sourceUid }), report.undoInsert()
     */
    function copyOf(value) {
      if (value === undefined || value === null) return value ?? null;
      try { return structuredClone(value); } catch (_) { return JSON.parse(JSON.stringify(value)); }
    }
    const addOnContext = Object.freeze({
      api: (method, path, body, signal, at = work.capture('study')) => api(method, path, body, signal, at),
      work: (scope = 'study') => {
        if (!['document', 'study', 'editor'].includes(scope)) throw new TypeError('Unknown work scope: ' + String(scope));
        return work.capture(scope);
      },
      toast: (message, kind = 'info') => toast(String(message ?? ''), ['ok', 'info', 'err'].includes(kind) ? kind : 'info'),
      studies: () => copyOf(studies),
      study: uid => copyOf(studies.find(s => s.uid === uid) ?? null),
      selectedUid: () => selectedUid,
      select: (uid, { deferViewer = false, openSelected = false } = {}) => select(uid, { deferViewer: !!deferViewer, openSelected: !!openSelected }),
      mode: () => mode,
      has: role => KinAuth.has(role),
      session: () => copyOf(KinAuth.session()),
      allowed: () => !!sess && serverMode && !demoMode && !offline && work.state() === 'active',
      reload: () => load(),
      onRender: fn => addOnListener('render', fn),
      onSelect: fn => addOnListener('select', fn),
      onEnd: fn => {
        if (typeof fn !== 'function') throw new TypeError('onEnd needs a function');
        let done = false;
        const end = () => { if (done) return; done = true; window.removeEventListener('pagehide', end); try { fn(); } catch (error) { console.error('Worklist add-on end listener failed', error); } };
        onSessionEnd(end); window.addEventListener('pagehide', end);
        return () => { done = true; window.removeEventListener('pagehide', end); };
      },
      report: Object.freeze({
        insertAtTop: (field, text, { sourceUid } = {}) => insertReportTop(field, text, sourceUid),
        undoInsert: () => undoReportTopInsert(),
      }),
    });
    function addOnListener(kind, fn) {
      if (typeof fn !== 'function') throw new TypeError('An add-on listener must be a function');
      const listener = (...args) => fn(...args);
      addOnListeners[kind].add(listener);
      return () => { addOnListeners[kind].delete(listener); };
    }
    for (const install of Array.isArray(window.KinWorklistAddOns) ? [...window.KinWorklistAddOns] : []) {
      const name = String(install?.addOnName || install?.name || 'unnamed');
      const failed = error => {
        console.error('Worklist add-on "' + name + '" could not be installed', error);
        toast('추가 기능 "' + name + '"을(를) 불러오지 못했습니다. 다른 기능은 그대로 사용할 수 있습니다.', 'err');
      };
      try {
        if (typeof install !== 'function') throw new TypeError('not a function');
        const started = install(addOnContext);
        if (started && typeof started.then === 'function') started.then(undefined, failed);
      } catch (error) { failed(error); }
    }
