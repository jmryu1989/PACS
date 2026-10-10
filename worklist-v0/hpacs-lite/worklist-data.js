
    const relatedParts = KinRelatedParts.create({
      owner:()=>{const key=KinViewerOpening.key(KinAuth.session());return key||null;},
      changed:()=>renderRelated()
    });
    const worklistBodyParts = mountWorklistBodyParts();
    function mountWorklistBodyParts() {
      let frame = null, ended = false;
      const model = KinWorklistBodyParts.create({
        owner: () => !ended && serverMode && !offline && !demoMode
          ? KinViewerOpening.key(KinAuth.session()) || null : null,
        changed: () => {
          if (frame !== null) return;
          // 부위 조회가 알린 변화를 그리는 일도 그 알림이 온 때의 문맥을 지난다 — 준비·종료 뒤의 프레임은 목록을 다시 그리지 않는다.
          const at = work.capture("document");
          frame = requestAnimationFrame(() => {
            frame = null;
            work.commit(at, () => {
              render();
              savedFilterManager.refreshCounts();
            });
          });
        }
      });
      const read = refresh => { model.sync(studies); return model.load({refresh}); };
      $('#body-parts-load').addEventListener('click', () => read(false));
      $('#body-parts-refresh').addEventListener('click', () => read(true));
      $('#body-parts-cancel').addEventListener('click', () => model.cancel());
      const end = () => { ended = true; model.end(); };
      onSessionEnd(end);
      window.addEventListener('pagehide', end);
      return model;
    }
    function bodyPartCountNote(filter) {
      const columns = COLS[filter?.mode] || COLS[mode];
      if (!KinCompoundFilter.usesField(filter?.cols?.[KinCompoundFilter.KEY], 'bodyPart', columns)) return '';
      worklistBodyParts.sync(studies);
      const missing = studies.filter(s => worklistBodyParts.get(s.uid) === undefined).length;
      return missing ? `Partial · 부위 미확인 ${missing}건이 있어 결과가 아직 완전하지 않습니다. Read Body Parts로 조회하세요.` : '';
    }
    function renderBodyParts() {
      const state = worklistBodyParts.sync(studies);
      $('#body-parts-load').disabled = !state.allowed || state.busy || !state.total || state.verified === state.total;
      $('#body-parts-load').textContent = state.failed ? 'Retry Body Parts' : state.verified ? 'Resume Body Parts' : 'Read Body Parts';
      $('#body-parts-refresh').hidden = !state.verified && !state.failed;
      $('#body-parts-refresh').disabled = !state.allowed || state.busy;
      $('#body-parts-cancel').hidden = !state.busy;
      $('#body-parts-status').textContent = state.note || (state.busy
        ? `부위 조회 중 · ${state.verified}/${state.total}건 확인`
        : state.verified || state.failed ? `부위 ${state.verified}/${state.total}건 확인 · 실패 ${state.failed}건`
        : 'Body Part 검색은 촬영 부위 조회 후 사용할 수 있습니다.');
    }
    function relatedCandidates() {
      const s=cur();return s ? studies.filter(x=>x.uid===s.uid || (s.sourcePatientKey&&x.sourcePatientKey===s.sourcePatientKey)) : [];
    }

    const DEMO_IMG = "data:image/svg+xml," + encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='black'/><ellipse cx='60' cy='60' rx='42' ry='50' fill='%23555'/><ellipse cx='60' cy='60' rx='36' ry='44' fill='%23888'/><ellipse cx='60' cy='55' rx='10' ry='6' fill='%23333'/><text x='60' y='112' fill='%23666' font-size='9' text-anchor='middle'>DEMO</text></svg>`);

    // 저장된 상태를 검사 객체에 얹는다. Match로 덮어쓴 값(ov)이 가장 마지막에 적용된다.
    function applyState(s) {
      const a = appState[s.uid] ?? {};
      s.em = a.em ?? s.em ?? "N";
      s.rs = a.rs ?? "W";
      s.holdReason = a.holdReason ?? null;
      s.ts = a.ts ?? "none";
      s.ss = a.ss ?? s.ss ?? "Verified";
      s.matched = a.matched ?? "U";
      s.ward = a.ward ?? s.ward ?? "";
      // 기관명은 서버가 정한다. Switch ReqHosp로 손으로 적어 넣던 값은
      // 기관이 실제 데이터가 된 지금 그것을 덮으면 안 된다.
      s.reqHosp = s.institutionName ? s.reqHosp : (a.reqHosp ?? s.reqHosp ?? "KIN");
      s.preDoc = a.preDoc ?? "";
      s.preReviewer = a.preReviewer ?? "";
      s.prelimHidden = a.prelimHidden;
      s.holder = a.holder;          // 서버가 만료된 점유는 빼고 준다
      s.version = a.version ?? 0;   // 낙관적 락 기준
      // S4-U5: the overlay repaints display fields only. RS, matching, UID, patient key and the rest of the row state
      // above always stay as the server sent them, whatever a stored overlay carries.
      for (const key of OVERLAY_KEYS) if (overlayValue(key, a.ov?.[key])) s[key] = a.ov[key];
      return s;
    }

    /**
     * 검사 목록.
     *
     * 서버 모드에서는 **API가 준 목록만** 쓴다. 예전엔 여기서 Orthanc의
     * /dicom-web/studies 를 직접 불렀는데, 그러면 기관 필터를 걸 곳이 화면밖에 없다.
     * 화면 필터는 경계가 아니라 커튼이다 — 주소창에 그 URL을 치면 다 보인다.
     * 이제 서버가 QIDO를 대신 부르고 기관으로 거른 뒤 상태까지 얹어서 준다.
     *
     * 서버가 없을 때(데모·오프라인)만 Orthanc 직통 경로가 남는다. 그 경로에는
     * 기관 개념이 없으므로 전부 "(로컬)"로 보인다 — 진짜처럼 보이면 안 되니까.
     */
    /** API가 준 검사 하나를 화면이 쓰는 모양으로 */
    const noteSummaries = new Map();
    function noteLabel(uid) {
      const note = noteSummaries.get(uid);
      return !note ? '미확인' : note.present ? '있음' : note.version ? '비움·이력' : '없음';
    }
    function updateNoteSummary(uid, value) {
      if (!value || !Number.isInteger(value.version) || value.version < 0 || typeof value.present !== 'boolean') return;
      // A list poll started before a local save must not roll the badge backward.
      if ((noteSummaries.get(uid)?.version ?? -1) > value.version) return;
      noteSummaries.set(uid, value);
      const study = studies.find(s => s.uid === uid);
      const button = $('#rows').querySelector(`[data-tech-note="${CSS.escape(uid)}"]`);
      if (button && study) { button.textContent = noteLabel(uid); button.setAttribute('aria-label', study.id + ' Tech 메모 ' + noteLabel(uid)); }
    }
    const readerAssignments=new Map();
    function updateReaderAssignment(uid,value){
      const previous=readerAssignments.get(uid);if(value&&previous&&value.revision<previous.revision)return;
      readerAssignments.set(uid,value);const study=studies.find(s=>s.uid===uid);if(study)study.assignedReader=value?.reader?[value.reader.name,value.reader.actor].filter(Boolean).join(' · '):'';
    }
    function fromApi(s) {
      updateReaderAssignment(s.uid,s.readerAssignment);
      updateNoteSummary(s.uid, s.techNote);
      /**
       * **서버 상태가 화면 상태를 대신하는 자리는 전부 같은 규칙을 지난다**(`mergeObservedReportState`).
       *
       * 여기가 목록 한 줄의 상태를 실제로 갈아끼우는 곳이고, 폴링만이 아니라 **Refresh 단추**가
       * 부르는 `load()`도 이 함수를 지난다(Auto Refresh를 Manual로 두면 그게 유일한 갱신이다).
       * 규칙을 부르는 쪽마다 따로 두면 그중 하나가 빠지고, 실제로 그렇게 빠져 있었다 —
       * 아직 서버에 보내지 못한 글을 담은 검사가 고른 검사가 아니면 그 글이 사라졌다.
       * 바로 아래 `applyState`가 `appState`를 읽으므로 목록 행의 판 번호도 여기서 맞는다.
       */
      appState[s.uid] = mergeObservedReportState(s.uid, s.state);
      return applyState({
        uid: s.uid, pf: "·", assignedReader:readerAssignments.get(s.uid)?.reader?[readerAssignments.get(s.uid).reader.name,readerAssignments.get(s.uid).reader.actor].filter(Boolean).join(" · "):"",
        count: s.count, series: s.series, acc: s.acc,
        id: s.id, name: s.name, sourcePatientKey: s.sourcePatientKey,
        age: (s.birth && s.date) ? Math.floor((+s.date - +s.birth) / 10000) : "",
        birth: fmtD(s.birth), sex: s.sex,
        modality: s.modality, desc: s.desc, date: fmtD(s.date),
        // ReqHosp 열에 들어가는 진짜 기관명. 원격판독으로 받은 검사는 표시를 붙인다 —
        // 내 병원 검사인지 남의 병원 검사인지가 판독의에게 한눈에 보여야 한다.
        institutionName: s.institutionName,
        reqHosp: s.tele ? `${s.institutionName} ▸원격` : s.institutionName,
        tele: s.tele,
        gatewayReceipt: s.gatewayReceipt ?? null,
      });
    }

    let listLoadSequence = 0;
    // studyPriority·Quick Match·검색·기능 패널의 종료가 부르는 목록·칩·판독 단추 그리기 묶음이다. 분할된 script 사이의 입력·종료가 미정의를 만나지 않게 이 생성보다 앞에 둔다(S9-U0a-PRE).
    function savedFilterDays(value) {
      if (value === null || value === "" || typeof value === "boolean") return -1;
      const days = Number(value);
      return Number.isFinite(days) ? days : -1;
    }
    /** 저장된 필터도 현재 목록과 같은 규칙으로 센다. 화면 상태를 바꾸지 않으므로
     * 다른 저장 필터의 건수를 보려고 지금 하던 검색이 흔들리지 않는다. */
    function filteredFor(filter, rows = studies) {
      if (rows === studies) worklistBodyParts.sync(studies);
      return rows.filter(filterPredicate(filter));
    }
    function filterPredicate(filter) {
      const filterMode = Array.isArray(COLS[filter?.mode]) ? filter.mode : mode;
      const cols = COLS[filterMode].filter(c => c.f);
      const days = savedFilterDays(filter?.days);
      const values = filter?.cols && typeof filter.cols === "object" ? filter.cols : {};
      const needsParts = KinCompoundFilter.usesField(values[KinCompoundFilter.KEY], 'bodyPart', COLS[filterMode]);
      const matchCompound = KinCompoundFilter.compile(values[KinCompoundFilter.KEY], COLS[filterMode]);
      const matchQuick = KinCompoundFilter.compileQuick(filter?.quick, values[KinCompoundFilter.KEY], COLS[filterMode]);
      return s => {
        if (!matchQuick(s)) return false;
        if (!withinDays(s.date, days)) return false;
        return cols.every(c => testCol(s, c, values))
          && matchCompound(needsParts ? {...s, bodyPart: worklistBodyParts.get(s.uid)} : s);
      };
    }
    let consultationFilter = null;
    const searchCriteria = () => ({mode,quick:$('#quick').value,days:quickDays,cols:JSON.parse(JSON.stringify(fval))});
    function folderSearches() {
      return [...userFilters.filter(f => Number.isInteger(f.id)).map(f => ({ ...f, treeId: 'own:' + f.id })),
        ...sharedSearches.map(f => ({ ...f, treeId: 'shared:' + f.id }))];
    }
    function folderSearchAvailable() {
      if (!folderAppliedSearch) return true;
      return folderSearches().some(f => f.treeId === folderAppliedSearch.id
        && (!f.treeId.startsWith('shared:') || f.name === folderAppliedSearch.name));
    }
    let folderRenderKey = '', chipCountKey = '', chipCountRows = [];
    // Rows can be edited in place (report status, assignments, and body-part answers).
    // Include those values and the local date, while excluding the quick-search draft.
    function folderInputsKey() {
      return JSON.stringify([studies, userFilters, sharedSearches, mode, new Date().toDateString(),
        studies.map(s => worklistBodyParts.get(s.uid))]);
    }
    function updateWorklistFolders() {
      if (!worklistFolders) return;
      const key = JSON.stringify([folderInputsKey(), offline, folderLoadState, folderAppliedSearch, shortcutDraft ?? storedShortcuts]);
      if (key !== folderRenderKey) {
      const searches = folderSearches().filter(f => Array.isArray(COLS[f.mode])
        && !KinCompoundFilter.validate(f.cols?.[KinCompoundFilter.KEY], COLS[f.mode]))
        .filter(f => folderAppliedSearch?.id !== f.treeId || folderSearchAvailable())
        .map(f => {
          const criteria = JSON.parse(JSON.stringify(f));
          // Compile once per search update, not once for every row counted in the tree.
          const match = filterPredicate(criteria), unknown = !!bodyPartCountNote(criteria);
          return { id: f.treeId, name: f.name, matches: row => unknown ? null : match(row) };
        });
      worklistFolders.update({ rows: studies, loadState: offline ? 'unknown' : folderLoadState, searches,
        shortcuts: shortcutDraft ?? storedShortcuts });
      folderRenderKey = key;
      }
      if (!folderAppliedSearch) {
        const value = (worklistSearch?.read(searchCriteria()).criteria || searchCriteria()).cols?.modality;
        const tokens = Array.isArray(value) ? value : String(value || '').split(/[,\\]/).map(v => v.trim().toUpperCase()).filter(Boolean);
        const ids = Array.isArray(value) || tokens.length ? tokens.map(v => 'modality:' + v) : ['all'];
        if (JSON.stringify(worklistFolders.snapshot().selectedIds) !== JSON.stringify(ids)) worklistFolders.setApplied(ids);
      }
    }
    function alignWorklistFolder(filter, id) {
      if (!worklistFolders) return;
      updateWorklistFolders();
      if (id) { worklistFolders.setApplied(id); return; }
      const value = filter?.cols?.modality;
      const modalities = Array.isArray(value) ? value : String(value || '').split(/[,\\]/).map(v => v.trim().toUpperCase()).filter(Boolean);
      worklistFolders.setApplied(Array.isArray(value) || modalities.length ? modalities.map(v => 'modality:' + v) : 'all');
    }
    function mountWorklistFolders() {
      if (worklistFolders || !$('#worklist-folders')) return;
      worklistFolders = KinWorklistFolderTree.mount({ host: $('#worklist-folders'),
        onSelect(item) {
          if (!work.admits(work.capture('document'))) return;
          if (item.kind === 'search' || item.kind === 'shortcut') {
            const filter = folderSearches().find(f => f.treeId === item.searchId);
            if (filter) applyFilter(filter, item.id);
            return;
          }
          folderAppliedSearch = null; activeFilterName = null;
          $('#quick').value = ''; quickDays = -1;
          document.querySelectorAll('#qf button').forEach(x => x.classList.toggle('on', +x.dataset.days === quickDays));
          Object.keys(fval).forEach(k => delete fval[k]);
          if (item.kind !== 'all') fval.modality = [...item.modalities];
          worklistSearch?.apply(); renderHeads(); render();
        },
        onChange: saveFolderShortcuts,
      });
      const panel = $('#worklist-folders-panel'), toggle = $('#worklist-folders-toggle');
      toggle.addEventListener('click', () => { panel.open = !panel.open; toggle.setAttribute('aria-expanded', String(panel.open)); });
      panel.addEventListener('toggle', () => toggle.setAttribute('aria-expanded', String(panel.open)));
      $('#shortcuts-reload').addEventListener('click', () => reloadFolderSearches());
      $('#shortcuts-save').addEventListener('click', () => saveFolderShortcuts(shortcutDraft));
      updateWorklistFolders();
    }
    function filtered() {
      const search = worklistSearch?.read(searchCriteria());
      const list = search?.empty ? [] : filteredFor(search?.criteria || searchCriteria());
      const favorites = favoriteList ? favoriteList.filter(list) : list;
      const tagged = studyTagList ? studyTagList.filter(favorites) : favorites;
      return consultationFilter ? tagged.filter(s => consultationFilter.uids.has(s.uid)) : tagged;
    }
    // Navigation and its position indicator must use the same order the reader sees.
    function orderedStudies() {
      const list = filtered();
      if (sortDir !== 0 && sortKey)
        list.sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0) * sortDir);
      return list;
    }
    let resultPage = 0, resultQuery = '', resultPageSize = 100;
    function render(revealUid) {
      updateWorklistFolders();
      const cols = COLS[mode], shown = shownColumns();
      const list = orderedStudies();
      const appliedSearch = worklistSearch?.read(searchCriteria());
      const bodyPartNote = appliedSearch?.empty ? '' : bodyPartCountNote(appliedSearch?.criteria || searchCriteria());
      renderBodyParts();
      const query = JSON.stringify([appliedSearch?.criteria || searchCriteria(), appliedSearch?.empty, sortKey, sortDir, favoriteList?.key(), studyTagList?.key(), consultationFilter?.revision ?? 0]);
      if (query !== resultQuery) { resultPage = 0; resultQuery = query; }
      if (typeof revealUid === 'string') {
        const index = list.findIndex(s => s.uid === revealUid);
        if (index >= 0) resultPage = Math.floor(index / resultPageSize);
      }
      const pages = Math.max(1, Math.ceil(list.length / resultPageSize));
      resultPage = Math.max(0, Math.min(resultPage, pages - 1));
      const offset = resultPage * resultPageSize;
      // Keep restored form-control values consistent with the actual page size.
      $('#page-size').value = String(resultPageSize);
      $('#page-prev').disabled = resultPage === 0; $('#page-next').disabled = resultPage >= pages - 1;
      $('#page-current').disabled = !list.some(s => s.uid === selectedUid);
      $('#row-keyboard-help').textContent='↑/↓ · Home/End 이동 · Space 선택 · Enter '+(mode==='Radiology'?'판독 진입':'검사 선택');
      $('#page-status').textContent = `불러온 목록 중 ${list.length ? offset + 1 : 0}–${Math.min(offset + resultPageSize, list.length)} / ${list.length}건 · ${resultPage + 1}/${pages}페이지` + (bodyPartNote ? ` · ${bodyPartNote}` : '');

      rowNavigation?.beforeRender();
      $("#rows").innerHTML = list.slice(offset, offset + resultPageSize).map((s, i) => `
        <tr data-uid="${esc(s.uid)}" tabindex="-1" class="st-${esc(String(s.rs).toLowerCase())}${s.uid === selectedUid ? " sel" : ""}${mode === "Radiology" && s.ss === "Unverified" && s.em !== "E" ? " unv" : ""}">` +
        shown.map(c => {
          // CELL[]은 우리가 만든 HTML이라 그대로, 나머지는 전부 외부 문자열이라 이스케이프
          const v = c.k === "no" ? offset + i + 1 : (CELL[c.k] ? CELL[c.k](s) : esc(s[c.k] ?? ""));
          const classes = [c.num ? "num" : "", c.k === "acc" ? "acc" : "", ["id", "birth"].includes(c.k) ? "dim" : ""];
          return `<td class="${classes.filter(Boolean).join(" ")}">${v}</td>`;
        }).join("") + `</tr>`).join("")
        || `<tr><td class="empty" colspan="${shown.length}">${bodyPartNote ? '부위 확인 전인 검사가 있어 검색 결과가 아직 완전하지 않습니다.' : 'No records found'}</td></tr>`;
      columnPrefs?.decorate(mode);
      multiSelection?.sync();
      rowNavigation?.sync();
      worklistSearch?.show();

      const active = [];
      if (consultationFilter) {
        const known = new Set(studies.map(s=>s.uid));
        const missing = [...consultationFilter.uids].filter(uid=>!known.has(uid)).length;
        active.push(consultationFilter.label + (missing ? ` · ${missing} not in loaded worklist` : ''));
      }
      if (favoriteList?.label()) active.push(favoriteList.label());
      if (studyTagList?.label()) active.push(studyTagList.label());
      // `.on` 버튼이 없으면 `.textContent`가 TypeError를 내고 **render() 전체가 죽는다** —
      // 목록도, 카운트도, 필터 표시도 안 그려진다. 서버 필터가 0/3/7/30/60/-1 외의
      // days를 주면 어느 버튼도 `.on`이 아니라 실제로 도달한다.
      // 화면 한 줄을 못 쓰는 것과 화면 전체가 안 그려지는 것은 다른 사고다.
      if (quickDays >= 0)
        active.push(`StudyDate(${$("#qf .on")?.textContent ?? `최근 ${quickDays}일`})`);
      cols.forEach(c => { if (fval[c.k]) active.push(`${c.t}(${fval[c.k]})${shown.includes(c) ? '' : ' [숨긴 열]'}`); });
      if (sortKey && sortDir && !shown.some(c => c.k === sortKey)) active.push(`숨긴 열 정렬: ${COLS[mode].find(c => c.k === sortKey)?.t ?? sortKey} ${sortDir > 0 ? '오름차순' : '내림차순'}`);
      const compound = fval[KinCompoundFilter.KEY];
      const compoundError = KinCompoundFilter.validate(compound, cols);
      $("#quick-match").value = compoundError ? "" : KinCompoundFilter.quickMode(compound);
      if (!compoundError && compound?.version === 2) active.push("Patient Search: " + (compound.quickMatch === "exact" ? "Exact" : "Starts With"));
      if (compoundError) active.push(`복합 조건 오류: ${compoundError} · 조건을 수정하거나 Clear로 해제하세요`);
      else if (compound?.rules.length) {
        active.push('복합 ' + KinCompoundFilter.describe(compound, cols));
      }
      $("#filterlist").textContent = (appliedSearch?.pending ? "Draft Filter (not applied) : " : "Filter : ") + (active.join(", ") || "-");

      const n = (k, v) => list.filter(s => s[k] === v).length;
      if (mode === "Radiology") {
        $("#countlist").innerHTML =
          `<span class="count"><span class="dot dot-w"></span>W:${n("rs","W")}</span>` +
          `<span class="count"><span class="dot dot-a"></span>A:${n("rs","A")}</span>` +
          `<span class="count"><span class="dot dot-ho"></span>H:${n("rs","H")}</span>` +
          `<span class="count"><span class="dot dot-ho"></span>O:${n("rs","O")}</span>` +
          `<span class="count"><span class="dot dot-t"></span>T:${n("rs","T")}</span>` +
          `<span class="count"><span class="dot dot-p"></span>P:${n("rs","P")}</span>` +
          `<span class="count">Unverified:${n("ss","Unverified")}</span>`;
      } else {
        $("#countlist").textContent =
          `Verified:${n("ss","Verified")} Unverified:${n("ss","Unverified")} · Unmatched:${n("matched","U")} · Total ${list.length}`;
      }
      renderChips();
      // S4-U5: the poll merges row state after it reports the observation, so the identity panel is redrawn here
      // too; its stale rule reads that merged state (a correction answer or a newer poll), never an older one.
      renderStudyIdentity();
    }
    function relatedStudy() { return relatedUid ? studies.find(s => s.uid === relatedUid) : null; }
    function viewed() { return relatedStudy() ?? cur(); }
    function renderStudyIdentity() {
      const box = $("#study-identity");
      if (!box || !studyIdentityModel) return;
      const s = viewed();
      const view = s ? KinStudyIdentity.view(studyIdentityModel, s.uid, appState[s.uid] ?? {}) : { hidden: true };
      const drawn = JSON.stringify(view);
      if (box.dataset.view === drawn) return;   // unchanged: keep the open panel and any text selection as they are
      box.dataset.view = drawn;
      box.hidden = view.hidden;
      if (view.hidden) return;
      $("#study-identity-summary").textContent = view.summary.text;
      $("#study-identity-summary").title = view.summary.title;
      const order = $("#study-identity-order");
      order.textContent = view.order?.text ?? ""; order.title = view.order?.title ?? "";
      $("#study-identity-tags").replaceChildren(...view.rows.map(row => {
        const line = document.createElement("div"), value = document.createElement("span"), relation = document.createElement("span");
        line.setAttribute("role", "listitem"); line.dataset.tag = row.key;
        value.textContent = `${row.tag} ${row.label}: ${row.value}`; value.title = row.valueTitle;
        relation.textContent = row.relation ? ` · ${row.relation}` : ""; relation.title = row.title;
        line.append(value, relation);
        return line;
      }));
      $("#study-identity-guidance").textContent = view.guidance;
    }
    /**
     * 표시줄이 안내하는 확정 단추는 **지금 눌리는 것뿐이다.** 승인된 판독문에서 Save·Approve는 잠겨 있는데 "확정하려면 Save
     * 또는 Approve"라고 쓰면 사람은 갈 수 없는 길을 안내받는다(U5CLI-F11). 무엇이 눌리는가는 단추를 잠그는
     * `updateReportButtons`가 정한 그대로 읽는다 — 같은 판단을 여기서 다시 계산하면 언젠가 한쪽만 고쳐진다. 그래서 단추를
     * 다시 잠그거나 푸는 그 함수가 끝에 이것을 부른다. 확정이 나가 있는 동안은 눌리는 것이 없으므로 안내도 없다.
     */
    function renderDraftHint() {
      const hint = $("#drafthint");
      if (!hint) return;
      const open = id => { const el = $(id); return !!el && !el.disabled; };
      hint.textContent = open("#b-addendum") ? " · 추가기재로 확정하려면 More ▸ Addendum"
        : open("#b-save") && open("#b-approve") ? " · 확정하려면 Save 또는 Approve"
        : open("#b-save") ? " · 확정하려면 Save" : open("#b-approve") ? " · 확정하려면 Approve" : "";
    }
    function heldByOther(s) { return s?.holder && s.holder !== user ? s.holder : null; }
    function updateReportButtons() {
      const s = cur();
      const rad = KinAuth.has("radiologist");
      const filming = s?.ss === "Unverified" && s?.em !== "E";
      const filmingTitle = "촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다";
      const held = heldByOther(s);
      const heldTitle = `${displayActor(held)} 님이 판독 중입니다`;
      $("#holdbar").style.display = held ? "flex" : "none";
      $("#holdmsg").textContent = held ? `✎ ${heldTitle} — 잠금이 풀리면 이어서 판독할 수 있습니다` : "";
      $("#deferbar").style.display = s?.rs === "H" ? "flex" : "none";
      $("#defermsg").textContent = s?.rs === "H" ? `⏸ On Hold — ${s.holdReason ?? ""}` : "";
      // 남의 예비 판독은 읽지도 쓰지도 못한다. 서버가 막지만 회색으로 보이는 편이 낫다 —
      // 눌러보고 거절당하는 건 "왜 안 되지"를 만들고, 회색은 "내 것이 아니구나"를 만든다.
      const locked = !!appState[selectedUid]?.prelimHidden;
      // Clear·Paste가 여기 들어와야 하는 이유: 둘 다 textarea의 `.value`에 직접 쓴다.
      // `readOnly`는 스크립트 대입을 안 막으므로, 잠긴 판독문이 이 두 버튼으로 지워졌다.
      for (const id of ["#b-approve", "#b-save", "#b-transcribe", "#b-unread", "#b-clear", "#b-paste", "#b-defer"]) {
        const el = $(id);
        if (!el) continue;
        el.disabled = !rad || locked || filming || !!held;
        el.title = held ? heldTitle : filming ? filmingTitle : locked ? "다른 판독의의 예비 판독(RS: P)입니다"
          : !rad ? "판독의 권한이 필요합니다" : "";
      }
      // 승인된 판독문을 비우는 길은 사유가 남는 Reset뿐이다. Clear는 그 뒷문이었다.
      $("#b-defer").disabled = !rad || !s || s.rs === "A" || s.rs === "P" || locked || filming || !!held || !serverMode;
      $("#b-defer").title = held ? heldTitle : filming ? filmingTitle
        : locked ? "다른 판독의의 예비 판독(RS: P)입니다"
        : s?.rs === "A" ? "승인된 판독문은 보류할 수 없습니다. 먼저 판독 취소(Reset)를 하세요"
        : s?.rs === "P" ? "예비 판독(RS: P)은 보류할 수 없습니다 — 승인 또는 취소만 가능합니다"
        : !rad ? "판독의 권한이 필요합니다" : !serverMode ? "서버에 연결돼 있을 때만 보류할 수 있습니다" : "";
      if (s?.rs === "A" && rad && !locked && !filming && !held) {
        $("#b-clear").disabled = true;
        $("#b-clear").title = "승인된 판독문은 판독 취소(Reset)로만 비울 수 있습니다";
        // 승인에서 나가는 길은 Addendum·Reset뿐이다. Save(Transcribe도 save다)는 사유 없이 승인을 풀고
        // Approve는 승인자를 갈아치우는 재승인이었다 — 서버가 400으로 막고, 여기서는 회색으로 미리 말해준다.
        for (const id of ["#b-save", "#b-transcribe", "#b-approve"]) {
          $(id).disabled = true;
          $(id).title = "승인된 판독문은 추가기재(Addendum) 또는 판독 취소(Reset)로만 바꿀 수 있습니다";
        }
      }
      // Addendum은 승인된 판독문에만 붙는다
      $("#b-addendum").disabled = s?.rs !== "A" || !rad || locked || filming || !!held;
      $("#b-addendum").title = held ? heldTitle : filming ? filmingTitle : s?.rs !== "A" ? "승인된 판독문에만 추가기재할 수 있습니다" : "";
      /**
       * Prelim은 "아직 확정 안 된 판독을 상급자에게 넘기는" 동작이다.
       * 이미 승인(A)된 것에는 의미가 없고, 이미 P인 것을 다시 넘기면 지정이 덮어써진다.
       * 넘긴 뒤에는 지정된 상급자가 Approve로 끝낸다 — 그건 서버가 강제한다.
       */
      const b = $("#b-prelim");
      if (b) {
        b.disabled = !rad || !s || s.rs === "A" || s.rs === "P" || locked || filming || !!held || !serverMode;
        b.title = held ? heldTitle : filming ? filmingTitle : !serverMode ? "서버에 연결돼 있을 때만 지정할 수 있습니다"
          : s?.rs === "P" ? "이미 예비 판독 중입니다"
          : s?.rs === "A" ? "이미 승인된 판독입니다"
          : "상급 판독의를 지정해 최종 판독을 맡깁니다 (RS: P)";
      }
      for (const id of ["#findings", "#conclusion", "#recommendation"]) {
        $(id).readOnly = !rad || locked || filming || !!held;
      }
      if(studyPriority?.get(selectedUid))for(const id of ['#b-save','#b-approve','#b-transcribe','#b-unread','#b-addendum','#b-prelim','#b-defer']) {
        const button=$(id);if(button){button.disabled=true;button.title='응급 상태 저장 결과를 확인한 뒤 판독을 저장하세요';}
      }
      // 초안 표시줄의 확정 안내는 방금 정한 단추 상태를 그대로 따른다(눌리지 않는 단추를 안내하지 않는다).
      renderDraftHint();
      updateTemplatePreview();
      updateReportTemplateButton();
      // 받아쓰기 단추도 같은 관문을 따른다. 검사 이동도 여기를 지나므로(refreshRight) 떠난 검사의
      // 녹음·요청은 여기서 끝난다 — select()에 두면 그 구역을 실행하는 다른 시험 틀이 깨진다.
      dictation.refresh();
    }
    const validUserFilters = value => Array.isArray(value)
      ? value.filter(uf => uf && typeof uf === "object" && typeof uf.name === "string") : [];
    let userFilters = [];
    try { userFilters = validUserFilters(JSON.parse(localStorage.getItem("kin-filters") ?? "[]")); } catch (e) {}
    let activeFilterName = null;
    function renderActiveFilter() {
      const holder = $('#active-filter-info');
      holder.hidden = activeFilterName === null;
      if (holder.hidden) return;
      const stored = userFilters.find(f => f.name === activeFilterName);
      const modified = !!stored && (filterCriteriaKey(stored) !== filterCriteriaKey(snapshotFilter())
        || !!favoriteList?.key() || !!studyTagList?.key());
      $('#active-filter-name').textContent = activeFilterName;
      $('#active-filter-state').textContent = !stored ? 'Deleted' : modified ? 'Modified' : 'Saved';
      holder.title = !stored ? '저장 검색이 삭제됐습니다. 현재 목록 조건은 유지됩니다.' : modified
        ? '현재 목록 조건과 저장된 조건이 다릅니다. 저장 검색을 다시 적용하거나 현재 조건을 새 검색으로 저장하세요.'
        : '저장된 검색 조건을 적용 중입니다. 결과 건수는 현재 불러온 목록을 기준으로 합니다.';
      $('#edit-active-filter').disabled = !stored;
    }
    function renderChips() {
      updateWorklistFolders();
      const holder = $("#chips");
      if (!holder) return;
      renderActiveFilter();
      const countKey = folderInputsKey();
      if (countKey !== chipCountKey) {
      chipCountRows = userFilters.map((uf, i) => {
        const count = filteredFor(uf).length;
        const note = bodyPartCountNote(uf);
        const label = `${uf.name}, 로드된 목록 기준 ${count}건${uf.isDefault ? ", 기본 필터" : ""}${note ? ' · ' + note : ''}`;
        return { i, uf, count, label, partial: !!note };
      });
      chipCountKey = countKey;
      }
      const rows = chipCountRows;
      // 검색 글자 하나마다 같은 버튼을 다시 만들면 저장 필터에 있던 키보드 포커스가
      // 사라진다. 실제 이름·기본 여부·건수가 바뀔 때만 DOM을 교체한다.
      const signature = JSON.stringify(rows.map(x => [x.uf.id ?? null, x.uf.name, !!x.uf.isDefault, x.count, x.label]));
      if (holder.dataset.renderSignature === signature) {
        holder.querySelectorAll('button[data-i]').forEach(b => b.setAttribute('aria-pressed', String(userFilters[+b.dataset.i]?.name === activeFilterName)));
        return;
      }
      const focused = holder.contains(document.activeElement) ? userFilters[+document.activeElement.dataset.i]?.name : null;
      holder.innerHTML = rows.map(({ i, uf, count, label, partial }) =>
        `<button class="chip" data-i="${i}" data-name="${esc(uf.name)}" aria-label="${esc(label)}" aria-pressed="${uf.name === activeFilterName}" aria-haspopup="menu" ` +
        `title="${esc(label)} · 클릭: 적용 / 우클릭 또는 Shift+F10: 메뉴">` +
        `${uf.isDefault ? "⚑ " : ""}${esc(uf.name)} <span aria-hidden="true">(${count}${partial ? ' · Partial' : ''})</span></button>`
      ).join("");
      holder.dataset.renderSignature = signature;
      if (focused !== null) focusFilterChip(focused);
    }
    studyPriority=KinStudyPriority.create({
      owner:()=>KinViewerOpening.key(KinAuth.session()),
      allowed:uid=>serverMode&&!offline&&!demoMode&&!commitInFlight&&KinAuth.has('technician')&&!!studies.find(s=>s.uid===uid&&!s.tele),
      request:async(uid,em,at)=>{const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
        try{return await api('PATCH','/studies/'+encodeURIComponent(uid),{em},controller.signal,at);}finally{clearTimeout(timeout);}},
      apply:(uid,em)=>{appState[uid]={...appState[uid],em};syncStudy(uid);},
      invalidate:()=>{commitEpoch++;listLoadSequence++;},
      changed:()=>{render();renderRelated();updateReportButtons();},
      notify:(message,error)=>toast(message,error?'err':'')
    });
    function emergencyMenu(uid) {
      const s=studies.find(s=>s.uid===uid),state=studyPriority.get(uid),desired=s?.em==='E'?'N':'E';
      if(state?.phase==='unknown')return {label:'Refresh Status',dis:offline||!serverMode,act:()=>load()};
      return {label:state?.phase==='saving'?'Saving Emergency Status':s?.em==='E'?'Switch to Normal':'Switch to Emergency',
        dis:!!state||!studyPriority.active()||!serverMode||offline||demoMode||commitInFlight||!KinAuth.has('technician')||!s||s.tele,
        act:()=>studyPriority.set(uid,desired)};
    }
    const studyPageClient = KinStudyPages.create({
      request: (path, signal, at) => api('GET', path, undefined, signal, at),
      identity: () => { const s = KinAuth.session(); return s?.state === 'approved' ? [s.institution,s.sub] : null; },
      changed: state => {
        if (state.busy) { folderLoadState = studies.length ? 'partial' : 'unknown'; updateWorklistFolders(); }
        $('#study-fetch').hidden = !state.busy && !state.resumable && !state.message;
        $('#study-fetch-status').textContent = state.message + (state.total == null ? '' : ` (${state.received}/${state.total}건 받음 · 완료 후 목록 반영)`);
        $('#study-fetch-resume').hidden = state.busy || !state.resumable; $('#study-fetch-cancel').hidden = !state.busy;
      },
    });
    $('#study-fetch-resume').addEventListener('click', () => load({ resume:true }));
    $('#study-fetch-cancel').addEventListener('click', () => { listLoadSequence++; studyPageClient.cancel(); });
    window.addEventListener('pagehide', () => studyPageClient.clear(), {once:true});
    function assertStudyOwner(result) {
      const session = KinAuth.session();
      if (session?.state !== 'approved' || JSON.stringify(result.owner) !== JSON.stringify([session.institution, session.sub]))
        throw Object.assign(new Error('Study account changed before applying the list.'), {ownerChanged:true});
    }
    /**
     * S5-U6b-F02 메뉴바 저장량(`#storage`). Orthanc 서버 전체의 TotalDiskSize(모든 기관의 영상, D11)이고, 운영 지표의
     * 서버 줄(api/src/pacs.service.ts orthancDiskBytes)과 같은 규칙으로 그 값 하나만 읽는다. 숫자는 범위·원천·이 화면이
     * 답을 받은 시각과 함께만 보인다. 읽기 전과 실패한 뒤에는 `Storage Unobservable`이다 — 예전 기본값 '0.0GB / -'처럼
     * 실패가 0으로 읽히지 않고, 앞서 받은 값이 지금 값처럼 남지 않는다(마지막 값은 설명에만 그 시각과 함께 둔다).
     * 가장 늦게 시작한 읽기만 그린다(A→B→A). 목록 읽기를 실패로 돌리지 않도록 어떤 실패도 밖으로 던지지 않는다.
     */
    let storageSeq = 0, storageLast = null;
    async function refreshStorage(at = work.capture("document")) {
      const seq = ++storageSeq;
      let bytes = null, reason = "원천 조회에 실패했습니다.";
      try {
        const answer = await transport.request("/statistics", { context: at });
        if (answer.status === 403) reason = "이 계정으로는 서버 전체 저장량을 볼 수 없습니다.";
        else if (!answer.ok) reason = `원천이 HTTP ${answer.status}로 답했습니다.`;
        else {
          const raw = answer.body?.TotalDiskSize;
          const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
          if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) bytes = Number(text);
          else reason = "응답 형식을 확인할 수 없습니다.";
        }
      } catch (e) {}
      work.commit(at, () => { if (seq === storageSeq) paintStorage(bytes, reason); });
    }
    function paintStorage(bytes, reason) {
      const box = $("#storage");
      if (!box) return;
      // The Operations row's units (admin.html KinAdminMetrics.formatBytes): powers of 1024, never rounded to 0.
      const size = n => {
        for (const [name, unit] of [["TiB", 2 ** 40], ["GiB", 2 ** 30], ["MiB", 2 ** 20], ["KiB", 2 ** 10]])
          if (n >= unit) return `${(n / unit).toFixed(2)} ${name}`;
        return `${n} B`;
      };
      let view;
      try {
        if (bytes !== null) {
          const at = new Date().toISOString();
          view = { state: "observed", text: `Storage ${size(bytes)} (Server-wide)`,
            title: `Orthanc 서버 전체(모든 기관)의 디스크 사용량입니다. 이 기관 몫이 아닙니다. 원천: Orthanc GET /statistics TotalDiskSize(원천 값 ${bytes}바이트). `
              + `관측 시각: ${KinStudyArrivals.formatTime(at)}(이 화면이 답을 받은 시각). 전체 용량은 원천이 없어 사용률(%)을 보이지 않습니다.` };
          storageLast = { bytes, at };
        } else {
          view = { state: "unobservable", text: "Storage Unobservable",
            title: `서버 전체 저장량을 관측하지 못했습니다. 0으로 두지 않습니다. ${reason}` + (storageLast
              ? ` 마지막으로 관측한 값은 ${size(storageLast.bytes)}(${KinStudyArrivals.formatTime(storageLast.at)})이며 지금 값이 아닐 수 있습니다.` : "") };
        }
      } catch (e) {
        view = { state: "unobservable", text: "Storage Unobservable", title: "서버 전체 저장량을 표시하지 못했습니다. 0으로 두지 않습니다." };
      }
      box.dataset.state = view.state;
      box.textContent = view.text;
      box.title = view.title;
    }
    async function load(options = {}) {
      const loadSequence = ++listLoadSequence, epoch = commitEpoch;
      // 이 읽기를 시작한 문맥. 목록·관측·안내를 쓰는 자리는 모두 이것을 지난다 — 준비·종료 뒤에 온 답은 목록을 바꾸지 않는다.
      const at = work.capture("document");
      /**
       * **서버가 죽었다고 Orthanc를 직접 부르지 않는다.**
       *
       * Orthanc는 API와 다른 컨테이너라 API가 죽어도 살아 있다. 그런데 기관 필터는
       * 서버에 있다 — 브라우저가 `/dicom-web/studies`를 직접 부르면 **남의 병원 검사가
       * 그대로 보인다.** 멀티테넌시를 서버로 옮긴 이유가 "화면 필터는 커튼"이었는데,
       * 고장 경로 하나가 그 커튼마저 걷어버리는 자리였다.
       */
      if (offline) {
        // S4-U1b: 관측 실패는 아무것도 비우지 않는다. 마지막 목록과 관측 시각을 두고 `관측 불가`만 더한다.
        // 차가운 시작에는 둘 목록이 없으므로 빈 스냅숏을 지어내지도 않는다.
        markObservationUnavailable();
        $("#err").textContent = "서버 연결이 끊겨 검사 목록을 불러올 수 없습니다 — 보이는 목록은 마지막 관측값입니다. 우측 상단에서 재시도할 수 있습니다";
        render(); refreshRight();
        return;
      }
      try {
        if (!serverMode) throw new Error("no-server");
        const r = await studyPageClient.read({ resume:!!options.resume, epoch, valid:() => !commitInFlight && epoch === commitEpoch });
        if (!work.admits(at) || loadSequence !== listLoadSequence || commitInFlight || epoch !== commitEpoch) return;
        assertStudyOwner(r);
        await Promise.all([favoriteList?.refresh(),studyTagList?.refresh()]);
        let applied = false;
        work.commit(at, () => {
          if (loadSequence !== listLoadSequence || commitInFlight || epoch !== commitEpoch) return;
        /**
         * **가져오기와 그리기를 나눈다.**
         *
         * 예전엔 `render()`도 이 try 안에 있었다. 목록은 멀쩡히 도착했는데
         * 렌더링에서 예외가 하나 나면(예: `$("#qf .on")` TypeError) 아래 catch가
         * 그걸 "목록 실패"로 처리하고 `studies = []`로 **성공한 데이터를 버렸다.**
         * 화면 그리기 버그가 데이터 없음으로 둔갑하면, 원인을 서버에서 찾게 된다.
         */
        // 편집 중인 검사의 판 번호·초안을 되돌려 놓던 블록은 없앴다 — `fromApi`가 그 규칙을
        // 모든 검사에 대해 먼저 적용하므로, 여기서 한 검사만 다시 손보면 규칙이 둘로 갈린다.
          studies = r.studies.map(fromApi);
          folderLoadState = 'complete';
          applyObservation(r);
          studyPriority.observed(r.studies.map(s=>s.uid));
          worklistAlerts?.observe(r.studies.map(s=>({uid:s.uid,em:s.state.em})));
          $('#err').textContent = '';
          applied = true;
        });
        if (!applied) return;
        await refreshStorage(at);
        // 그리기 실패는 그리기 실패라고 말한다. 데이터는 이미 들어와 있고, 버리지 않는다.
        return work.commit(at, () => {
          try { render(); refreshRight(); worklistStartup?.afterList(); }
          catch (e2) { console.error(e2); toast("화면 그리기 오류: " + e2.message, "err"); }
        }) ? true : undefined;
      } catch (e) {
        if (!work.admits(at) || loadSequence !== listLoadSequence) return;
        // 목록 읽기가 "계정이 바뀌었다"고 했다. 이 세션에 묶어 한 번 확인해 정말 다른 계정의 답일 때만 세션 교체로 닫는다.
        if (e.ownerChanged) {
          studyPageClient.clear();
          if (await accountReplaced(at)) return;
          if (!work.admits(at) || loadSequence !== listLoadSequence) return;
        }
        // 서버 모드에서 목록이 실패하면 **가짜 데이터로 내려가지 않는다.**
        // Incomplete page batches never replace the last complete list or report input.
        if (serverMode) {
          work.commit(at, () => {
            folderLoadState = 'unknown';
            // A superseded or changed-list answer is not a failed observation; the last one still stands.
            if (!e.stale && e.code !== 'STUDY_LIST_CHANGED') markObservationUnavailable();
            $("#err").textContent = "검사 목록을 불러오지 못했습니다. 현재 목록과 입력은 유지했습니다 — " + e.message;
            toast("검사 목록 실패: " + e.message, "err");
            render();
          });
          return;
        }
      }
      try {
        const res = await transport.request("/dicom-web/studies?includefield=00081030,00201206,00201208", { context: at });
        if (!res.ok || !Array.isArray(res.body)) throw new Error("HTTP " + res.status);
        // Refresh and Home read again without waiting: only the last read started may write the list, the notice or
        // the demo flag, so an earlier answer arriving late (success or failure) leaves the newer list alone.
        const answer = res.body;
        if (!work.commit(at, () => {
          if (loadSequence !== listLoadSequence) return;
          studies = answer.map(st => {
          const uid = tagv(st, "0020000D");
          const birth = tagv(st, "00100030"), date = tagv(st, "00080020");
          return applyState({
            uid, pf: "·",
            count: +tagv(st, "00201208") || 0,
            series: +tagv(st, "00201206") || 0,
            acc: tagv(st, "00080050"),
            id: tagv(st, "00100020"),
            name: tagv(st, "00100010").replace(/\^/g, " "),
            age: (birth && date) ? Math.floor((+date - +birth) / 10000) : "",
            birth: fmtD(birth), sex: tagv(st, "00100040"),
            modality: st["00080061"]?.Value?.join(",") ?? "",
            desc: tagv(st, "00081030"), date: fmtD(date),
              reqHosp: "(로컬)",
            });
          });
          render(); refreshRight();
        })) return;
        await refreshStorage(at);
      } catch (e) {
        // 문맥이 무효가 되어 보내지 않았거나 끊긴 읽기는 "Orthanc 미연결"이 아니다 — 가짜 데이터로 내려가지 않는다.
        if (!work.commit(at, () => {
          if (loadSequence !== listLoadSequence) return;
          paintDemoList();
        })) return;
      }
    }
    // ── 데모 모드: Orthanc 없이 열람 시 (GitHub Pages 등) 가짜 데이터로 전환 ──
    function paintDemoList() {
      demoMode = true;
      $("#err").textContent = "데모 모드 — 가짜 데이터 (Orthanc 미연결)";
      const P = (uid, id, name, age, birth, sex, desc, date, acc) => applyState(
        { uid, pf: "·", count: 20, series: 1, acc, id, name, age, birth, sex, modality: "CT", desc, date });
      studies = [
        P("demo-1",  "P-1001", "KIM CHULSOO",  64, "1962-03-04", "M", "Brain CT (synthetic)",         "2026-08-28", "KIN20261000"),
        P("demo-1p", "P-1001", "KIM CHULSOO",  63, "1962-03-04", "M", "Brain CT initial (synthetic)", "2026-02-10", "KIN20260950"),
        P("demo-2",  "P-1002", "LEE YOUNGHEE", 50, "1975-11-22", "F", "Brain CT (synthetic)",         "2026-08-27", "KIN20261001"),
        P("demo-3",  "P-1003", "PARK MINJUN",  37, "1988-10-09", "M", "Brain CT f/u (synthetic)",     "2026-08-27", "KIN20261002"),
        P("demo-4",  "P-1004", "CHOI SUJIN",   33, "1993-05-17", "F", "Brain CT (synthetic)",         "2026-08-26", "KIN20261003"),
        P("demo-5",  "P-1005", "JUNG DOHYUN",  69, "1957-02-28", "M", "Brain CT f/u (synthetic)",     "2026-08-25", "KIN20261004"),
      ];
      render(); refreshRight();
    }