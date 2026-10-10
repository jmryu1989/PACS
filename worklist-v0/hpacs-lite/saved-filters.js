

    // ── User Filter List (6.2.1) ──
    // 현재 필터 조합에 이름을 붙여 **계정에** 저장한다. 칩을 누르면 그대로 돌아온다.
    // 정렬(sortKey/sortDir)도 함께 저장한다 — 필터가 같아도 정렬이 다르면 다른 화면이다.
    // (HPACS도 2025년에야 "정렬을 적용하여 사용자 필터로 저장"을 넣었다)
    const saveFiltersLocal = () => { try { localStorage.setItem("kin-filters", JSON.stringify(userFilters)); } catch (e) {} };

    const snapshotFilter = () => ({
      quick: $("#quick").value, days: quickDays, mode, cols: { ...fval },
      sortKey, sortDir,
    });
    function filterCriteriaKey(filter) {
      const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
      const cols = Object.fromEntries(Object.entries(filter.cols || {}).filter(([, v]) => v !== '' && v != null));
      const key = COLS[filter.mode]?.some(c => c.k === filter.sortKey) ? filter.sortKey : null;
      return JSON.stringify(canonical({ mode: filter.mode, quick: filter.quick ?? '', days: savedFilterDays(filter.days),
        cols, sortKey: key, sortDir: key ? filter.sortDir || 0 : 0 }));
    }
    function focusFilterChip(name) {
      const chip = [...$('#chips').querySelectorAll('button[data-i]')].find(b => userFilters[+b.dataset.i]?.name === name);
      (chip || $('#managefilters')).focus();
    }
    function editSavedFilter(name) {
      focusFilterChip(name);
      savedFilterManager.open({ name });
    }
    async function filterWriteReady(signal, at) {
      if (sess?.demo && !offline && !serverMode) return true;
      const disconnected = () => offline || !serverMode;
      if (disconnected()) throw new Error('서버 연결을 확인한 뒤 다시 저장하세요. 입력은 유지됩니다.');
      const me = await api('GET', '/me', undefined, signal, at);
      if (me.sub !== sess.sub || me.institution !== sess.institution)
        throw new Error('로그인 계정이 변경됐습니다. 이 창을 다시 로그인한 뒤 사용하세요.');
      if (disconnected()) throw new Error('서버 연결을 확인한 뒤 다시 저장하세요. 입력은 유지됩니다.');
      return false;
    }
    function acceptSavedFilter(saved, local) {
      const next = userFilters.filter(f => f.name !== saved.name).map(f => saved.isDefault ? { ...f, isDefault: false } : f);
      // Keep the existing item's position when editing it.
      const index = userFilters.findIndex(f => f.name === saved.name);
      next.splice(index < 0 ? next.length : index, 0, saved);
      if (local) localStorage.setItem('kin-filters', JSON.stringify(next));
      userFilters = next; renderChips();
    }
    // 관리 창이 부르는 읽기·쓰기는 저마다 시작할 때의 작업 문맥을 잡는다. 요청도, 답을 검색 목록에 쓰는 자리도 그 문맥을
    // 지난다 — 로그아웃 준비·세션 종료 뒤에 온 답은 목록을 바꾸지 않고 취소로 끝난다.
    const savedFilterManager = KinSavedFilterManager.mount({
      columns: COLS, days: savedFilterDays, list: () => userFilters, snapshot: snapshotFilter,
      count: f => filteredFor(f).length, countNote: bodyPartCountNote, apply: applyFilter,
      bodyParts: { snapshot: () => worklistBodyParts.sync(studies),
        load: refresh => { worklistBodyParts.sync(studies); return worklistBodyParts.load({refresh}); },
        cancel: () => worklistBodyParts.cancel() },
      async readFolders(signal, at = work.capture("document")) {
        if (await filterWriteReady(signal, at)) throw new Error('폴더 관리는 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('GET', '/filter-folders', undefined, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub]) || !Array.isArray(snapshot.filters) || !Array.isArray(snapshot.folders))
          throw new Error('계정 또는 검색 모음 응답을 확인할 수 없습니다. 다시 로그인하세요.');
        if (!work.commit(at, () => { userFilters = validUserFilters(snapshot.filters); renderChips(); })) throw staleAnswer();
        return snapshot;
      },
      async writeFolders(body, signal, at = work.capture("document")) {
        if (await filterWriteReady(signal, at)) throw new Error('폴더 관리는 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('POST', '/filter-folders', body, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub]) || !Array.isArray(snapshot.filters) || !Array.isArray(snapshot.folders))
          throw new Error('응답을 확인할 수 없습니다. 검색 모음을 다시 불러오세요.');
        if (!work.commit(at, () => { userFilters = validUserFilters(snapshot.filters); renderChips(); })) throw staleAnswer();
        return snapshot;
      },
      async readShared(signal, at = work.capture("document")) {
        if (await filterWriteReady(signal, at)) throw new Error('기관 검색은 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('GET', '/shared-filters', undefined, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub])) throw new Error('계정이 변경되었습니다. 다시 로그인하세요.');
        return snapshot;
      },
      async writeShared(body, signal, at = work.capture("document")) {
        if (await filterWriteReady(signal, at)) throw new Error('기관 검색은 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('POST', '/shared-filters', body, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub])) throw new Error('응답 계정을 확인할 수 없습니다. 공유 목록을 다시 불러오세요.');
        return snapshot;
      },
      async copyShared(body, signal, at = work.capture("document")) {
        if (await filterWriteReady(signal, at)) throw new Error('기관 검색은 서버 계정으로 로그인한 뒤 사용할 수 있습니다.');
        const snapshot = await api('POST', '/shared-filters/copy', body, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (JSON.stringify(snapshot?.owner) !== JSON.stringify([sess.institution, sess.sub]) || !Array.isArray(snapshot.filters))
          throw new Error('응답을 확인할 수 없습니다. 개인 폴더를 다시 불러오세요.');
        if (!work.commit(at, () => { userFilters = validUserFilters(snapshot.filters); renderChips(); })) throw staleAnswer();
        return snapshot;
      },
      restoreFocus(opener) {
        if (opener?.isConnected && !opener.disabled && !opener.closest('[hidden]')) opener.focus();
        else if (opener?.id === 'edit-active-filter') $('#clearfilter').focus();
        else if (opener?.dataset.name) focusFilterChip(opener.dataset.name);
        else $('#managefilters').focus();
      },
      async save(filter, signal, at = work.capture("document")) {
        // Capture the transport before the request: a later disconnect must never
        // turn a completed account save into browser-local preference data.
        const local = await filterWriteReady(signal, at);
        const saved = local ? filter : await api('POST', '/filters', filter, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        if (!work.commit(at, () => acceptSavedFilter(saved, local))) throw staleAnswer();
        return saved;
      },
      async remove(filter, signal, at = work.capture("document")) {
        const local = await filterWriteReady(signal, at);
        if (!local) await api('DELETE', `/filters/${filter.id}`, undefined, signal, at);
        if (!work.admits(at)) throw staleAnswer();
        const next = userFilters.filter(f => f.name !== filter.name);
        if (!work.commit(at, () => {
          if (local) localStorage.setItem('kin-filters', JSON.stringify(next));
          userFilters = next; renderChips();
        })) throw staleAnswer();
      },
      async reload(signal, at = work.capture("document")) {
        const local = await filterWriteReady(signal, at);
        if (!local) {
          const p = await api('GET', '/prefs', undefined, signal, at);
          if (!work.admits(at)) throw staleAnswer();
          if (!Array.isArray(p?.filters)) throw new Error('저장 검색 목록을 불러오지 못했습니다. 다시 시도하세요.');
          if (!work.commit(at, () => { userFilters = validUserFilters(p.filters); renderChips(); })) throw staleAnswer();
        }
      },
    });
    $('#managefilters').addEventListener('click', () => savedFilterManager.open());
    $('#edit-active-filter').addEventListener('click', () => savedFilterManager.open({ name: activeFilterName }));
    function applyFilter(f) {
      if (!f || !Array.isArray(COLS[f.mode])) { toast('저장 검색의 업무 화면을 확인할 수 없습니다.', 'err'); return false; }
      const compoundError = KinCompoundFilter.validate(f.cols?.[KinCompoundFilter.KEY], COLS[f.mode]);
      if (compoundError) { toast('복합 조건을 적용하지 못했습니다: ' + compoundError, 'err'); return false; }
      activeFilterName = userFilters.some(saved => saved.name === f.name) ? f.name : null;
      $("#quick").value = f.quick ?? "";
      quickDays = savedFilterDays(f.days);
      document.querySelectorAll("#qf button").forEach(x => x.classList.toggle("on", +x.dataset.days === quickDays));
      Object.keys(fval).forEach(k => delete fval[k]);
      Object.assign(fval, f.cols ?? {});
      // setMode()가 정렬을 지우므로 모드를 먼저 바꾸고 정렬을 나중에 얹는다
      if (f.mode && f.mode !== mode) setMode(f.mode);
      /**
       * **저장된 정렬이 지금 모드에 있는 컬럼인지 확인한다.**
       *
       * setMode에는 이 검사가 있는데(`COLS[m].some(...)`), applyFilter는 그 **뒤에**
       * 값을 얹으므로 검사를 건너뛴다. Technician 모드에서 저장한 필터를 Radiology에
       * 적용하면 없는 컬럼으로 정렬이 걸리고, `a[sortKey]`가 전부 undefined라
       * 목록이 아무 순서로나 늘어선다 — 정렬이 걸린 줄도 모른 채.
       */
      const okSort = f.sortKey && COLS[mode].some(c => c.k === f.sortKey);
      sortKey = okSort ? f.sortKey : null;
      sortDir = okSort ? (f.sortDir ?? 0) : 0;
      worklistSearch?.apply();
      renderHeads(); render();
      return true;
    }

    /**
     * 서버에서 필터·상용구를 다시 받아온다.
     *
     * **응답을 검증한다.** 예전엔 `templates = p.templates`를 그대로 대입해서,
     * 한쪽이 빠진 응답 하나에 전역 `templates`가 `undefined`가 됐다.
     * 그 뒤로는 `renderTemplates()`가 매번 죽고 — 상용구 패널뿐 아니라
     * `refreshRight()`가 통째로 멈춰서 검사를 선택해도 오른쪽이 안 그려진다.
     * 한 번 깨지면 F5 전까지 안 돌아온다. 못 믿을 값은 안 받는 편이 낫다.
     */
    async function reloadPrefs(at = work.capture("document")) {
      if (!serverMode) return;
      const p = await api("GET", "/prefs", undefined, undefined, at);
      work.commit(at, () => {
        if (!Array.isArray(p?.filters) || !Array.isArray(p?.templates)) {
          toast("환경설정 응답이 올바르지 않아 이전 값을 유지합니다", "err");
          return;
        }
        userFilters = validUserFilters(p.filters); templates = p.templates;
        renderChips(); renderTemplates();
      });
    }

    $("#savefilter").addEventListener("click", () => {
      const current = snapshotFilter();
      const error = KinCompoundFilter.validate(current.cols[KinCompoundFilter.KEY], COLS[current.mode]);
      if (error) { toast('복합 조건을 저장하지 못했습니다: ' + error, 'err'); return; }
      savedFilterManager.open();
    });

    $("#chips").addEventListener("click", e => {
      const b = e.target.closest("button[data-i]"); if (!b) return;
      applyFilter(userFilters[+b.dataset.i]);
    });

    // 우클릭에 바로 삭제를 걸어두면 손이 미끄러진 한 번으로 사라진다.
    // 되돌릴 수 없는 동작은 메뉴를 한 겹 두른다 (교훈 §5).
    function showFilterMenu(e, b) {
      e.preventDefault();
      const i = +b.dataset.i, f = userFilters[i];
      if (!f) return;
      b.focus();
      const rect = b.getBoundingClientRect();
      showCtx(e, [
        { label: "Apply", act: () => applyFilter(f) },
        { label: "Edit", act: () => editSavedFilter(f.name) },
        { label: f.isDefault ? "Clear Default" : "Set as Default", act: async () => {
            const on = !f.isDefault;
            if (on && (!Array.isArray(COLS[f.mode]) || KinCompoundFilter.validate(f.cols?.[KinCompoundFilter.KEY], COLS[f.mode]))) {
              toast('복합 조건 또는 업무 화면을 확인할 수 없어 기본 필터로 지정하지 못했습니다.', 'err'); return;
            }
            const at = work.capture("document");
            if (serverMode) {
              try { await api("PATCH", `/filters/${f.id}/default`, { on }, undefined, at); await reloadPrefs(at); }
              catch (err) { work.commit(at, () => toast("실패: " + err.message, "err")); return; }
            } else {
              userFilters.forEach(x => x.isDefault = false);
              f.isDefault = on; saveFiltersLocal(); renderChips();
            }
            work.commit(at, () => toast(on ? `"${f.name}" 을 기본 필터로 지정했습니다` : "기본 필터에서 해제했습니다"));
          } },
        { sep: 1 },
        { label: "Delete", act: async () => {
            if (!confirm(`필터 "${f.name}" 을(를) 삭제할까요?`)) return;
            const at = work.capture("document");
            if (serverMode) {
              try { await api("DELETE", `/filters/${f.id}`, undefined, undefined, at); await reloadPrefs(at); }
              catch (err) { work.commit(at, () => toast("삭제 실패: " + err.message, "err")); return; }
            } else {
              userFilters.splice(i, 1); saveFiltersLocal(); renderChips();
            }
            work.commit(at, () => toast("필터를 삭제했습니다", "info"));
          } },
      ], e.type === 'keydown' ? { x: rect.left, y: rect.bottom, focus: true } : null);
    }
    $("#chips").addEventListener("contextmenu", e => {
      const b = e.target.closest('button[data-i]'); if (b) showFilterMenu(e, b);
    });
    $("#chips").addEventListener("keydown", e => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      const b = e.target.closest('button[data-i]'); if (b) showFilterMenu(e, b);
    });
    renderChips();

    $("#clearfilter").addEventListener("click", () => {
      activeFilterName = null;
      favoriteList?.clear();studyTagList?.clear();consultationFilter=null;
      $("#quick").value = "";
      Object.keys(fval).forEach(k => delete fval[k]);
      quickDays = -1;
      document.querySelectorAll("#qf button").forEach(x => x.classList.toggle("on", x.dataset.days === "-1"));
      worklistSearch?.clear();
      renderHeads(); render();
    });