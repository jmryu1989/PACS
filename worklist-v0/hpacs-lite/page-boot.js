

    // ══════════ 시작 ══════════
    // 서버가 살아 있으면 서버 상태로 시작하고, 죽어 있으면 localStorage로 계속 굴러간다.
    // 서버 없이도 앱이 열려야 GitHub Pages 데모와 오프라인 작업이 가능하다.
    // 역할에 따라 화면을 잠근다. 서버가 어차피 막지만, 눌러보고 거절당하는 것보다
    // 처음부터 회색인 편이 낫다. (서버 검사가 진짜 방어선이고 이건 안내다)
    function applyRoleUi() {
      const rad = KinAuth.has("radiologist"), tec = KinAuth.has("technician");
      // Clear·Paste도 판독문을 고치는 버튼이다. 목록에서 빠져 있어서 기사에게도 열려 있었다.
      ["#b-approve", "#b-save", "#b-transcribe", "#b-unread", "#b-addendum", "#b-defer",
       "#b-clear", "#b-paste"].forEach(s => {
        const el = $(s); if (!el) return;
        el.disabled = !rad;
        if (!rad) el.title = "판독의(radiologist) 권한이 필요합니다";
      });
      ["#findings", "#conclusion", "#recommendation"].forEach(s => $(s).readOnly = !rad);
      ["#t-verify", "#t-unverify", "#t-modify"].forEach(s => {
        const el = $(s); el.disabled = !tec;
        if (!tec) el.title = "방사선사(technician) 권한이 필요합니다";
      });
      const r = sess.demo ? "데모" : (sess.roles.filter(x => ["radiologist","technician","admin"].includes(x)).join(", ") || "권한 없음");
      $("#roles").textContent = r;
      $("#member-link").style.display = !sess.demo && KinAuth.has("admin") ? "" : "none";
    }

    /**
     * 부트스트랩을 몇 번 더 시도한다.
     *
     * 예전엔 한 번 실패하면 그대로 로컬 모드였다 — 네트워크 blip 하나, 컨테이너가
     * 재시작하는 3초, 늦게 뜬 API. 한 번의 딸꾹질로 하루 종일 모드가 바뀌었고
     * 돌아올 방법도 없었다. **일시적 실패와 진짜 고장은 다르게 다뤄야 한다.**
     *
     * 인증 실패와 무효가 된 문맥(세션 종료·로그아웃 준비)은 다시 시도할 일이 아니다 — 인증 실패는 전송이 이미 넘겼다.
     */
    async function fetchBootstrap(at, tries = 3) {
      let last;
      for (let i = 0; i < tries; i++) {
        try { return await api("GET", "/bootstrap?states=omit", undefined, undefined, at); }
        catch (e) {
          last = e;
          if (e.auth || e.name === "AbortError") throw e;
          if (i < tries - 1) await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
        }
      }
      throw last;
    }

    // 판독 기록에는 안정적인 이메일 식별자가 남는다. 화면에서만 Keycloak 성명으로 바꾼다.
    async function loadActorNames(at = work.capture("document")) {
      if (!serverMode) return;
      try {
        const peers = await api("GET", "/colleagues", undefined, undefined, at);
        work.commit(at, () => peers.forEach(p => rememberActor(p.id, p.name, p.username)));
      } catch (e) { /* 이름 조회가 실패해도 이메일 표시는 유지한다. */ }
    }

    /** 서버가 살아 있을 때. 재연결에서도 다시 불리므로 누적되는 조작을 하지 않는다. */
    function goOnline(b) {
      serverMode = true; offline = false;
      $('#consultations-open').disabled=!!demoMode;consultations.refresh();
      stopReconnect();
      for (const [uid, state] of Object.entries(b.states ?? {})) appState[uid] = mergeObservedReportState(uid, state);
      orders = b.orders;
      myInstitution = b.me?.institution ?? null;
      myInstitutionName = b.me?.institutionName ?? "";
      institutions = b.institutions ?? [];
      // 서버가 말한 받아쓰기 가능 여부. 모양이 다르거나 없으면 쓸 수 없는 것으로 본다.
      dictation.setServerCapability(b.dictation);
      /**
       * 필터·상용구는 이제 계정에 있다. 이 브라우저에 뭐가 남아 있든 서버가 진실이다.
       *
       * 예전엔 `if (b.filters)` 였다 — 서버가 안 주면 **앞사람의 로컬 필터가 그대로
       * 살아남았다.** 공용 판독 PC에서 남의 칩이 내 화면에 보이는 것이고,
       * 그걸 눌러 저장하면 남의 필터 이름으로 내 화면이 만들어진다.
       * 계정에 붙인다고 해놓고 브라우저에 남은 것을 안 지우면 반쪽이다.
       */
      userFilters = validUserFilters(b.filters);
      mountWorklistFolders();
      void reloadFolderSearches();
      templates = Array.isArray(b.templates) ? b.templates : [];
      try { localStorage.removeItem("kin-filters"); localStorage.removeItem("kin-templates"); } catch (e) {}
      renderChips(); renderTemplates();
      $("#dbstat").innerHTML = `<span style="color:#4ac06a">●</span> DB Connected`;
      $("#dbstat").title = `상태·판독문이 서버(${API})에 저장됩니다 — 브라우저를 바꿔도 유지됩니다`;
      // 어느 기관으로 로그인했는지 항상 보이게. 두 기관을 오가며 시험할 때
      // "지금 누구로 보고 있는지"를 모르면 필터가 되는지 안 되는지도 알 수 없다.
      // `roleText`를 기준으로 다시 쓴다 — 재연결마다 앞에 덧붙으면 줄이 길어진다.
      $("#roles").textContent = `${myInstitutionName} · ${roleText}`;
      // 미배정 통로는 관리자에게만. 평소엔 0건이라 숨어 있어야 맞다.
      $("#m-unassigned").style.display = KinAuth.has("admin") ? "" : "none";
      startPolling();
      // 연결이 되살아났다: 앞서 실패해 멈춘 검사도 한 번 다시 보낸다(같은 거절이면 한 번 알리고 다시 멈춘다).
      reportSaveFailures.clear();
      reconcileReportDrafts();
    }

    /**
     * 로그인은 했는데 서버에 못 닿는다. **폴백이 아니라 고장으로 다룬다.**
     * 쓰기를 막고, 빨간 표시를 띄우고, 뒤에서 계속 다시 두드린다.
     */
    function goOffline(e) {
      reportPreview.close();
      serverMode = false; offline = true;
      folderLoadState = 'unknown'; filterCollection = null; ++filterReadSequence; ++sharedFilterReadSequence;
      updateWorklistFolders(); shortcutStatus('서버에 연결한 뒤 바로가기를 불러오세요.');
      // 녹음 중이던 받아쓰기는 여기서 멈춘다(보낼 곳이 없다). 받아 둔 글은 Insert가 거절한다.
      dictation.refresh();
      worklistBodyParts.sync(studies);
      $('#consultations-open').disabled=true;consultations.refresh();
      clearInterval(poll); poll = null; ++pollGeneration;
      $("#dbstat").innerHTML = `<span style="color:#ff6b6b">●</span> 서버 연결 끊김 — 저장 불가 (클릭: 재시도)`;
      $("#dbstat").title = `API에 연결하지 못했습니다 (${e?.message ?? ""}).\n` +
        `이 상태에서는 아무것도 저장되지 않습니다. 쓰던 판독문은 복사해 두세요.\n` +
        `docker compose up -d 로 API를 띄우면 자동으로 다시 붙습니다.`;
      $("#dbstat").style.cursor = "pointer";
      toast("서버 연결이 끊겼습니다 — 지금부터 저장되지 않습니다. 쓰던 판독문은 복사해 두세요.", "err");
      startReconnect();
    }

    /**
     * 재연결 시도. 서버가 돌아오면 스스로 붙는다.
     * 예전엔 복구 감지가 아예 없어서, API가 살아나도 사용자가 F5를 눌러야만 알았다.
     */
    let reconnectTimer = null;
    function stopReconnect() { clearInterval(reconnectTimer); reconnectTimer = null; $("#dbstat").style.cursor = ""; }
    function startReconnect() {
      if (reconnectTimer) return;
      reconnectTimer = setInterval(async () => {
        if (!offline) { stopReconnect(); return; }
        // 회차마다 그때의 문맥으로 지난다: 로그아웃 준비 중에는 두드리지 않고, 답은 그 문맥이 그대로일 때만 연결을 되살린다.
        const at = work.capture("document");
        if (!work.admits(at)) return;
        try {
          const b = await api("GET", "/bootstrap", undefined, undefined, at);
          if (!work.commit(at, () => goOnline(b))) return;
          await loadActorNames(at);
          await load();
          work.commit(at, () => toast("서버에 다시 연결됐습니다 — 저장이 가능합니다", "ok"));
        } catch (e) { /* 다음 회차에 다시 */ }
      }, 15000);
    }
    $("#dbstat").addEventListener("click", async () => {
      if (!offline) return;
      const at = work.capture("document");
      try {
        const b = await api("GET", "/bootstrap", undefined, undefined, at);
        if (!work.commit(at, () => goOnline(b))) return;
        await loadActorNames(at); await load();
        work.commit(at, () => toast("서버에 다시 연결됐습니다", "ok"));
      }
      catch (e) { work.commit(at, () => toast("아직 연결되지 않습니다: " + e.message, "err")); }
    });

    /** applyRoleUi가 만든 원본 역할 문자열. 기관 이름을 덧붙이는 기준점이다. */
    let roleText = "";

    /**
     * 미배정 검사 목록 (관리자).
     *
     * 기관을 못 알아본 검사는 어느 워크리스트에도 안 뜬다. 그건 의도한 설계지만,
     * **보이는 곳이 하나도 없으면 영영 고아로 남는다.** 장비 태그 오타 하나로
     * 영상이 들어와 있는데 아무도 모르고, 아무도 모르니 아무도 안 고친다.
     */
    async function showUnassigned() {
      const box = $("#un-body");
      $("#unmodal").classList.add("show");
      box.innerHTML = "<div style='color:#667;padding:10px'>불러오는 중…</div>";
      const at = work.capture("document");
      try {
        const r = await api("GET", "/unassigned", undefined, undefined, at);
        if (!work.admits(at)) return;
        if (!r.studies.length) {
          box.innerHTML = "<div style='color:#4ac06a;padding:10px'>미배정 검사가 없습니다.</div>";
          return;
        }
        const opts = r.institutions.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("");
        box.innerHTML = r.studies.map(s => `
          <div class="ver">
            <div class="vh">
              <b>${esc(s.name || "(이름 없음)")}</b>
              <span>${esc(s.id)}</span>
              <span style="color:#667">${esc(fmtD(s.date))} · ${esc(s.desc)}</span>
            </div>
            <div class="vr">DICOM 기관명: ${s.dicomInstitution ? `"${esc(s.dicomInstitution)}"` : "(비어 있음)"}</div>
            <div style="display:flex;gap:6px;align-items:center;padding:4px 0">
              <select data-uid="${esc(s.uid)}" class="un-sel"
                      style="background:#14181f;color:#cdd3dc;border:1px solid #3a4356;padding:3px 6px;font:inherit">${opts}</select>
              <button class="un-go" data-uid="${esc(s.uid)}"
                      style="background:#3b6ea5;color:#fff;border:1px solid #3b6ea5;padding:3px 12px;border-radius:3px;cursor:pointer;font-size:11px">배정</button>
            </div>
          </div>`).join("");
      } catch (e) {
        work.commit(at, () => { box.innerHTML = `<div style="color:#ff8080;padding:10px">${esc(e.message)}</div>`; });
      }
    }
    $("#un-body").addEventListener("click", async e => {
      const btn = e.target.closest(".un-go"); if (!btn) return;
      const uid = btn.dataset.uid;
      const sel = $(`.un-sel[data-uid="${CSS.escape(uid)}"]`);
      const name = sel.options[sel.selectedIndex].textContent;
      if (!confirm(`이 검사를 "${name}"에 배정합니다.\n배정하면 그 기관의 워크리스트에 나타납니다. 계속할까요?`)) return;
      btn.disabled = true;
      const at = work.capture("document");
      try {
        await api("POST", `/studies/${encodeURIComponent(uid)}/assign`, { institutionId: sel.value }, undefined, at);
        if (!work.commit(at, () => toast(`"${name}"에 배정했습니다`, "ok"))) return;
        await showUnassigned();
        await load();
      } catch (err) {
        // 이 배정이 잠근 단추는 이 배정이 푼다(자기 것만).
        btn.disabled = false;
        work.commit(at, () => toast("배정 실패: " + err.message, "err"));
      }
    });
    $("#m-unassigned").addEventListener("click", showUnassigned);
    $("#un-close").addEventListener("click", () => $("#unmodal").classList.remove("show"));

    // 세션 상세(S5-UI1): 헤더의 #user·#roles는 한 줄로 말줄임될 수 있다. 전체 문구를 단추의 툴팁과 Session details에
    // 옮겨 적는다. 두 칸을 쓰는 곳이 셋(boot·applyRoleUi·goOnline)이라 그 자리마다 부르지 않고 글자가 바뀔 때 따라 적는다 —
    // 쓰는 곳이 늘어도 상세가 옛 문구로 남지 않는다. 여는 순간에도 한 번 더 맞춘다.
    (() => {
      const user = document.getElementById("user"), roles = document.getElementById("roles");
      const who = document.getElementById("session-who"), details = document.getElementById("session-details");
      const sync = () => {
        document.getElementById("session-details-user").textContent = user.textContent;
        document.getElementById("session-details-roles").textContent = roles.textContent;
        who.title = [user.textContent, roles.textContent].filter(Boolean).join("\n");
      };
      const observer = new MutationObserver(sync);
      for (const el of [user, roles]) observer.observe(el, { childList: true, characterData: true, subtree: true });
      details.addEventListener("beforetoggle", sync);
      sync();
    })();

    function showMembershipState(state) {
      const pending = state === "pending";
      document.title = pending ? "관리자 승인 대기 — KIN" : "계정 설정 확인 — KIN";
      const panel = document.createElement("main");
      panel.style.cssText = "min-height:100vh;display:grid;place-items:center;background:#07101d;color:#eef4ff;font-family:system-ui,sans-serif;padding:24px";
      const card = document.createElement("section");
      card.style.cssText = "width:min(520px,100%);background:#111d2d;border:1px solid #29405d;border-radius:14px;padding:34px;box-shadow:0 18px 60px #0008";
      const brand = document.createElement("div");
      brand.textContent = "KOREA IMAGING NETWORK";
      brand.style.cssText = "font-size:12px;letter-spacing:.18em;color:#75a9dc;margin-bottom:18px";
      const title = document.createElement("h1");
      title.textContent = pending ? "관리자 승인 대기" : "계정 설정 확인 필요";
      title.style.cssText = "font-size:24px;margin:0 0 14px";
      const message = document.createElement("p");
      message.textContent = pending
        ? "가입 신청이 접수되었습니다. 관리자가 기관과 역할을 확인한 뒤 사용할 수 있습니다."
        : "기관 또는 업무 역할 설정이 올바르지 않습니다. 관리자에게 문의해 주세요.";
      message.style.cssText = "line-height:1.7;color:#c8d5e6;margin:0 0 24px";
      const logout = document.createElement("button");
      logout.textContent = "로그아웃";
      logout.style.cssText = "border:0;border-radius:8px;background:#2b78c5;color:white;padding:11px 20px;cursor:pointer";
      logout.addEventListener("click", () => KinAuth.logout());
      card.append(brand, title, message, logout);
      panel.append(card);
      document.body.replaceChildren(panel);
    }

    async function boot() {
      try {
        await KinAuth.init({ retry: true, onRetry: () => {
          work.commit(work.capture("lifecycle"), () => {
            $("#err").textContent = "세션을 다시 확인하고 있습니다. 확인되면 자동으로 들어갑니다…";
          });
        }, onHold: text => {
          // 다른 창의 로그아웃 준비가 살아 있는 동안 이 탭은 그 결과를 기다린다(A017) — 그동안의 안내 한 줄.
          work.commit(work.capture("lifecycle"), () => { $("#err").textContent = text ?? ""; });
        } });
        if (KinAuth.session()) work.commit(work.capture("document"), () => $("#err").replaceChildren());
      }
      catch {
        work.commit(work.capture("lifecycle"), () => {
          $("#err").textContent = "세션을 확인하지 못했습니다. 잠시 뒤 다시 확인해 주세요. ";
          const retry = document.createElement("button");
          retry.textContent = "Retry Session Check";
          retry.addEventListener("click", () => { retry.disabled = true; boot(); });
          $("#err").append(retry);
        });
        return;
      }
      sess = KinAuth.session();
      if (!sess) {
        // 평소의 진입(종료 기록이 없고 저장소를 믿을 수 있다)에서 세션이 없으면 로그인 화면으로 바로 보낸다 — 로그인 단추를
        // 한 번 더 누르게 하지 않는다. 그 밖(종료 기록, 믿을 수 없는 저장소, 진입 확인 실패)은 랜딩이 사정을 보인다.
        if (!KinAuth.autoLogin()) location.replace("index.html");
        return;
      }
      if (sess.state === "pending" || sess.state === "invalid") {
        showMembershipState(sess.state);
        return;
      }
      user = sess.user ?? "";
      if (!sess.demo && typeof sess.sub === "string")
        draftOwner = Object.freeze({ institution: sess.institution ?? null, sub: sess.sub, author: sess.actor });
      userDisplayName = sess.displayName || user;
      $("#user").textContent = userDisplayName;
      rememberActor(user, userDisplayName, user.split("@")[0]);
      columnPrefs = KinWorklistColumns.mount({ columns: COLS, session: sess, mode: () => mode,
        changed: () => { renderHeads(); render(); renderRelated(); } });
      renderHeads();
      renderTemplates();
      applyRoleUi();
      if (!sess.demo) userFilters = [];
      mountWorklistFolders();
      $('#consultations-open').hidden=!(KinAuth.has('radiologist')||KinAuth.has('admin'));
      imageOpening = KinViewerOpening.mount({ button: $('#image-opening-open'), session: () => KinAuth.session() });
      try {
        worklistStartup = KinWorklistStartup.mount({host:$('#image-opening-dialog'),
          owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key&&key.slice(KinViewerOpening.PREFIX.length);},
          current:()=>selectedUid,rows:orderedStudies,select:uid=>select(uid,{deferViewer:true}),
          allowed:()=>serverMode&&!offline&&!demoMode});
      } catch (_) { toast('시작 선택 설정을 불러오지 못해 자동 선택을 껐습니다.', 'err'); }

      worklistRefresh = KinWorklistRefresh.mount({select:$('#worklist-refresh'),status:$('#worklist-refresh-status'),
        owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key&&key.slice(KinViewerOpening.PREFIX.length);},
        changed:()=>startPolling()});
      worklistAlerts = KinWorklistAlerts.mount({button:$('#worklist-alerts-open'),owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key&&key.slice(KinViewerOpening.PREFIX.length);},refresh:()=>load(),available:()=>serverMode&&!offline});
      KinStudyAccessStatus.mount({button:$('#study-access-open'),session:()=>KinAuth.session(),refresh:async()=>(await load())===true});
      multiSelection = KinWorklistSelection.mount({host:$('#worklist-selection'),tbody:$('#rows'),owner:()=>KinViewerOpening.key(KinAuth.session()),rows:orderedStudies,current:()=>selectedUid,open:uid=>select(uid,{openSelected:true}),compare:(uid,prior)=>openFilmbox(uid,prior)});
      imagePreview = KinWorklistImagePreview.mount({owner:()=>KinViewerOpening.key(KinAuth.session()),currentUid:viewingUid,api});
      imageThumbnails = window.KinWorklistImageThumbnails?.mount?.({host:$('#thumbwrap'),owner:()=>KinViewerOpening.key(KinAuth.session()),currentUid:viewingUid,api,
        onPreview:value=>imagePreview?.open(value),onBack:()=>renderThumbs()}) || null;
      worklistSearch = KinWorklistSearch.mount({host:document.querySelector('.userfilter'),owner:()=>KinViewerOpening.key(KinAuth.session()),snapshot:searchCriteria,render});
      rowNavigation = KinWorklistRowNavigation.mount({tbody:$('#rows'),owner:()=>KinViewerOpening.key(KinAuth.session()),rows:orderedStudies,
        current:()=>selectedUid,reveal:uid=>render(uid),activate:uid=>{select(uid);if(mode==='Radiology')$('#findings').focus();}});
      relatedRowNavigation = KinWorklistRowNavigation.mount({tbody:$('#relrows'),owner:()=>KinViewerOpening.key(KinAuth.session()),rows:()=>relatedRows,
        current:()=>relatedUid||selectedUid,fallback:()=>$('#related-modality').disabled?$('#related-current'):$('#related-modality'),
        reveal:uid=>{const index=relatedRows.findIndex(row=>row.uid===uid);if(index>=0){relatedPage=Math.floor(index/50);renderRelated();}},
        activate:uid=>uid===selectedUid?returnToReportStudy():previewRelated(uid)});
      mountViewerWindows();
      restoreWorkspace();
      // Optional display controls must not prevent loading clinical work.
      try {
        const appearance=KinReadingAppearance({getMpr:()=>{try{return $('#reading-frame')?.contentWindow?.kinMprPreferences||null;}catch(_){return null;}},getToolbar:()=>{try{return $('#reading-frame')?.contentWindow?.kinViewerToolbarPreferences||null;}catch(_){return null;}},getDock:()=>{try{const dock=$('#reading-frame')?.contentWindow?.document.getElementById('kin-workspace-dock');return dock&&dock.preference()!==null?dock:null;}catch(_){return null;}},owner:()=>{
          const key=KinWorkspaceLayout.key(KinAuth.session());
          return key?key.slice(KinWorkspaceLayout.PREFIX.length):null;
        }});
        window.KinReadingAppearanceAccount?.({...appearance,owner:workspaceOwner?[sess.institution,sess.sub]:null,
          endpoint:API+'/reading-appearance',sessionEndpoint:API+'/me'});
      } catch (_) {
        $('#reading-appearance-open').disabled=true;
        $('#reading-appearance-open').title='글자 크기 설정을 불러오지 못했습니다. 판독 작업은 계속할 수 있습니다.';
      }
      KinReadingPreferences({ ...readingWorkspace.preferences,
        owner: workspaceOwner ? [sess.institution, sess.sub] : null,
        endpoint: API + '/reading-preferences', sessionEndpoint: API + '/me' });
      KinWorkspaceRoaming.mount({
        owner: workspaceOwner ? [sess.institution, sess.sub] : null,
        // A reset or legacy local record still comes from a client that can
        // preserve reading panels; never serialize it as an older v1 writer.
        read: () => KinWorkspaceLayout.withReading(workspaceState, readingWorkspace.snapshotPanels()),
        generation: () => workspaceGeneration,
        model: KinWorkspaceLayout, endpoint: API + '/workspace-layout', sessionEndpoint: API + '/me',
        localKept: () => workspaceLocalKept,
        apply: state => {
          state = KinWorkspaceLayout.mergeLoaded(workspaceState, state);
          if (!state) return false;
          workspaceGeneration++; workspaceState = state; layoutMode = state.mode; applyLayout();
          if (state.reading) readingWorkspace.applyPanels(state.reading);
          const saved = KinWorkspaceLayout.write(workspaceStorage, workspaceOwner, state);
          workspaceLocalKept = !!saved;
          $("#layout-status").textContent = saved ? "배치 복원됨 · 이 브라우저" : "배치 · 이 창에서만 유지";
          return saved;
        },
      });
      roleText = $("#roles").textContent;
      if (sess.demo) {
        serverMode = false; offline = false;
        Object.assign(appState, legacyAppState);
        $("#dbstat").innerHTML = `<span style="color:#7f8899">●</span> 데모 모드`;
        $("#dbstat").title = "로그인하지 않은 둘러보기 모드 — 변경 내용은 이 브라우저에만 남습니다";
        await load();
        return;
      }
      // 부팅의 남은 읽기는 이 세션의 문맥으로 나간다. 기다리는 사이 세션이 끝났으면(다른 문서의 종료, 첫 요청의 401) 그 답도
      // 실패도 화면에 쓰지 않는다 — 닫힌 화면은 종료 조정이 맡는다.
      const at = work.capture("document");
      try {
        const b = await fetchBootstrap(at);
        if (!work.admits(at)) return;
        /**
         * **이 브라우저에 남아 있던 로컬 작업 기록을 말없이 버리지 않는다.**
         *
         * `appState = b.states` 한 줄이 예전 로컬 모드에서 한 일 전부를 지웠다.
         * 경고도, 무엇이 사라지는지도 없었다. 이제 서버 것이 이기되(그건 맞다),
         * 버리기 전에 날짜를 붙여 따로 떼어두고 알려준다.
         */
        const localKeys = Object.keys(legacyAppState ?? {});
        if (localKeys.length) {
          const key = `kin-app-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
          try { localStorage.setItem(key, JSON.stringify(legacyAppState)); } catch (e) {}
          localStorage.removeItem("kin-app");
          toast(`이 브라우저에 남아 있던 기록 ${localKeys.length}건은 서버 데이터로 대체됩니다 ` +
                `(localStorage의 ${key}에 보관)`, "info");
        }
        goOnline(b);
        // No await between starting polling and establishing the default: even
        // Refresh during a delayed colleague lookup must keep the search scope.
        const def = userFilters.find(f => f.isDefault);
        if (def) {
          if (applyFilter(def)) toast(`기본 필터 "${def.name}" 적용됨 — Clear를 누르면 풀립니다`, "info");
          else {
            fval[KinCompoundFilter.KEY] = null;
            render();
            toast('기본 검색 오류(업무 화면·복합 조건)로 목록을 숨겼습니다. 다른 저장 검색을 적용하거나 Clear로 해제하세요.', 'err');
          }
        }
        await loadActorNames(at);
      } catch (e) {
        if (!work.admits(at)) return;
        goOffline(e);
      }
      await load();
    }
    boot();
  
