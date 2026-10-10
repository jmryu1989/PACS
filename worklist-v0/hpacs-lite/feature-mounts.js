

    favoriteList = KinFavoriteList({ api,
      identity: () => { const s=KinAuth.session(); return s?.state==='approved' ? [s.institution,s.sub] : null; },
      changed: () => { $('#favorite-clear').hidden = !favoriteList.label(); render(); },
    });
    $('#favorite-clear').onclick = () => favoriteList.clear();
    const favorites = KinFavorites({ api, allowed: () => !!sess && serverMode && !demoMode && !offline,
      identity: () => { const s=KinAuth.session(); return s?.state==='approved' ? [s.institution,s.sub] : null; },
      current: () => selectedUid, study: uid => studies.find(s => s.uid===uid), select,
      applyFolder: (value,id) => favoriteList.apply(value,id), changed: value => favoriteList.adopt(value), ended: () => favoriteList.end(),
      openSavedView: (uid,job) => { select(uid,{deferViewer:true});readingWorkspace.openJob(uid,job); },
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
        $('#clearfilter').click();const wanted=new Set(uids),known=new Set(studies.map(s=>s.uid));
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
    // 읽기 작업공간의 종료(pagehide)가 부르는 배치 적용이다. 분할된 script 사이에서 페이지를 떠나도 정의돼 있게 생성보다 앞에 둔다(S9-U0a-PRE).
    let layoutMode = "auto";
    let workspaceState = KinWorkspaceLayout.defaults();
    const portraitLayout = () => document.body.classList.contains("portrait");
    const workspaceAxis = () => portraitLayout() ? "portrait" : "landscape";
    function applyLayout() {
      const portrait = layoutMode === "portrait" || (layoutMode === "auto" && innerHeight > innerWidth);
      document.body.classList.toggle("portrait", portrait);
      $("#layout-toggle").textContent = {
        auto: "Layout: Auto", portrait: "Layout: Portrait", landscape: "Layout: Landscape",
      }[layoutMode];
      $("#layout-toggle").setAttribute("aria-label", `화면 배치 ${layoutMode}`);
      $("#resize-main").setAttribute("aria-orientation", portrait ? "horizontal" : "vertical");
      $("#resize-related").setAttribute("aria-orientation", portrait ? "horizontal" : "vertical");
      if (portrait) {
        $(".left").style.width = "";
        $(".related-p").style.width = "";
      } else {
        $(".left").style.height = "";
        $(".related-p").style.height = "";
      }
      // A temporary small window must not overwrite the user's preferred size.
      // Reapply stored pixels within today's bounds, separately for each orientation.
      const sizes = workspaceState[workspaceAxis()];
      const left = $(".left"), related = $(".related-p"), top = $(".rw"), prior = $(".related-list-pane");
      left.style[portrait ? "height" : "width"] = "";
      related.style[portrait ? "height" : "width"] = "";
      top.style.height = "";
      prior.style.height = "";
      prior.style.flex = "";
      const split = $(".split").getBoundingClientRect();
      if (sizes.main != null) left.style[portrait ? "height" : "width"] = clampPanel(sizes.main,
        portrait ? 180 : 500, portrait ? split.height - 420 : split.width - 426) + "px";
      if (sizes.top != null) top.style.height = clampPanel(sizes.top, 140, $(".right").getBoundingClientRect().height - 266) + "px";
      const row = $(".workrow").getBoundingClientRect();
      if (sizes.related != null) related.style[portrait ? "height" : "width"] = clampPanel(sizes.related,
        portrait ? 286 : 220, portrait ? row.height - 186 : row.width - 366) + "px";
      if (sizes.prior != null) {
        prior.style.flex = "none";
        prior.style.height = clampPanel(sizes.prior, 150, related.getBoundingClientRect().height - 136) + "px";
      }
    }
    const readingWorkspace = KinReadingWorkspace({
      current: () => selectedUid, study: uid => studies.find(s => s.uid === uid),
      prior: autoPrior, move, select, queue: orderedStudies, layout: () => applyLayout(), popup: openOhifWindow,
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