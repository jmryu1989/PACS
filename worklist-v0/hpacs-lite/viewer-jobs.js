/* The saved state references original DICOM. No viewer runtime IDs or pixels persist. */
window.kinViewerJobs = function (services, model) {
  let stop = () => {};
  function mount() {
    stop();
    const search = location.search, scope = model.scope(search);
    if (!scope) return;
    const studies = new URLSearchParams(search).get('StudyInstanceUIDs').split(',');
    const grid = services.viewportGridService, cs = services.cornerstoneViewportService, ds = services.displaySetService;
    // The MPR Job owns the volume layout; the ordinary frame cell of a mixed layout stays
    // this panel's own shape and is lent to it rather than reimplemented there.
    const volumeJobs = window.kinCreateVolumeJob?.({grid,cs,ds,studies,
      stack:{cell:(g,measure)=>stackCell(g,measure),resolve:cell=>resolve(cell),apply:(id,cell,current)=>applyStackCell(id,cell,current)}});
    const volumeTools = () => { if(!volumeJobs)throw new Error('MPR 저장 도구를 불러오지 못했습니다. 미저장 입력을 보존한 뒤 뷰어를 다시 여세요.');return volumeJobs; };
    const parent = document.querySelector('#kin-viewer-layout'); if (!parent) return;
    parent.style.maxHeight = '40vh'; parent.style.overflow = 'auto';
    parent.querySelector('summary').textContent = 'Comparison & Layout';
    const panel = document.createElement('details'); panel.id = 'kin-viewer-jobs'; panel.open = true;
    const text = (tag, value, host = panel) => { const e = document.createElement(tag); e.textContent = value; host.append(e); return e; };
    text('summary', 'Saved Comparison Jobs');
    text('p', '영상 위치·표시·배치를 저장합니다. 미저장 표식은 먼저 저장하세요.');
    const help = document.createElement('details'); panel.append(help); text('summary', 'Annotation Help', help);
    text('p', '주석 함께 저장은 선택 프레임의 서버 저장 주석 이력을 고정합니다. 복원은 최신 주석, 출력은 고정한 주석을 사용하며 실제 크기 출력은 아닙니다.', help);
    const field = (label, tag, max) => { const l = text('label', label), e = document.createElement(tag); e.maxLength = max; e.setAttribute('aria-label', label); e.style.cssText = 'display:block;width:100%;color:#111;background:#fff'; l.append(e); return e; };
    const title = field('Job Title', 'input', 120), description = field('Description', 'textarea', 2000);
    const filters = text('div', ''), mine = text('select', '', filters); mine.setAttribute('aria-label', 'Job Author'); mine.style.cssText = 'color:#111;background:#fff';
    for (const [value, label] of [['true', 'My Jobs'], ['false', 'All Jobs']]) { const o = text('option', label, mine); o.value = value; }
    const hiddenLabel = text('label', ' Include Hidden', filters), hidden = document.createElement('input'); hidden.type = 'checkbox'; hidden.setAttribute('aria-label', 'Include Hidden Jobs'); hiddenLabel.prepend(hidden);
    const controls = text('div', ''), status = text('p', '계정 확인 중…'), list = text('div', ''); status.id = 'kin-viewer-jobs-status'; status.setAttribute('role', 'status');
    parent.insertBefore(panel, parent.children[1]);
    let ended = false, busy = false, me = null, serial = 0, editSerial = 0, pending = null, editRow = null, applying = false, channel, lastAuth = 0, checking = false;
    const workspaceState = () => ({ busy: !ended && (busy || applying), dirty: !ended && !!(pending || editRow || title.value || description.value || window.kinMprMarks?.dirty?.() || window.kinMprCurved?.dirty?.() || window.kinMprPath?.dirty?.() || window.kinVolumeMipJob?.dirty?.()) });
    window.kinViewerJobWorkspaceState = workspaceState;
    // This panel also runs in the separate named viewer window, where the
    // worklist's embedded-frame guard cannot protect an unfinished title,
    // edit, or request when the window is closed directly.
    const beforeUnload = e => {
      const state = workspaceState();
      if (state.busy || state.dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    const ownsWindowUnload = window.top === window;
    if (ownsWindowUnload) window.addEventListener('beforeunload', beforeUnload);
    const abort = new AbortController(), buttons = new Set();
    const live = () => !ended && location.search === search;
    const path = '/studies/' + studies[0] + '/viewer-jobs';
    const ordered = () => [...grid.getState().viewports.values()].sort((a, b) => a.y-b.y || a.x-b.x);
    const writable = () => me?.roles?.includes('radiologist');
    let printer, printLoading, openingPrint = false;
    async function openPrint(row) {
      if (!live() || openingPrint) return;
      openingPrint = true;
      try {
        const currentSnapshot=(readOnly=false)=>{const value=capture(true,readOnly,true);if(value.version===5){value.version=4;delete value.batch;}else if(value.version===6)value.batch=null;return value;};
        const snapshot = row ? null : currentSnapshot();
        // The MPR output renderer reconstructs a fixed, vacancy-free cell list
        // (viewer-volume-job-print.js:68-69) and the ordinary frame renderer lays its pages
        // out on a uniform grid. A version 7 plane layout, a version 8 mixed layout and a
        // version 9 merged layout are refused here, before any export, rather than falling
        // through to a renderer that would print a page the saved screen never was.
        const shape = row?.snapshotVersion ?? snapshot?.version;
        if (shape === 7) throw new Error('MPR 평면 배치 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.');
        if (shape === 8) throw new Error('MPR 평면과 일반 영상이 섞인 배치 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.');
        if (shape === 9) throw new Error('칸을 병합한 배치 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.');
        // A curved MPR is a derived display on an arc-length axis; it has no print page yet.
        if (shape === 10) throw new Error('Curved MPR 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.');
        // A 3D path and its unfolded display are derived displays too; saving and restoring only.
        if (shape === 11) throw new Error('3D Path 작업은 아직 출력할 수 없습니다. 저장과 복원만 지원합니다.');
        // A saved MIP Viewer or MIP Batch Job prints from its saved conditions (viewer-volume-mip-print.js). The current MIP screen has
        // no print page: it is shown behind the MIP Viewer's own modal dialog, and its preview is never output.
        if (!row && (shape === 12 || shape === 14)) throw new Error('MIP Viewer 작업은 아직 출력할 수 없습니다. 현재 화면 출력은 지원하지 않으며, 저장한 작업은 Print Saved Images로 출력합니다.');
        if (!row && (shape === 13 || shape === 15)) throw new Error('MIP Batch 작업은 아직 출력할 수 없습니다. 현재 화면 출력은 지원하지 않으며, 저장한 작업은 Print Saved Images로 출력합니다.');
        const unchanged = () => live() && JSON.stringify(currentSnapshot(true)) === JSON.stringify(snapshot);
        // Each asset is ready by its own predicate. The MIP models are frozen objects rather than functions, and a module already present
        // (the model of an open or closed MIP Viewer included) is never requested, and so never replaced, again.
        const fn=name=>()=>typeof window[name]==='function',members=(name,keys)=>()=>{const value=window[name];return !!value&&keys.every(key=>typeof value[key]==='function');};
        const volumePrint=['viewer-volume-job-print.js',fn('kinRenderVolumeJobPrint')];
        const mipPrint=[volumePrint,['volume-mip.js',members('KinVolumeMip',['verifyState','clipShader','averageShader','voiPlanes','voiPlane','corners','preset','view','projectionThickness','sampleDistance','affine','verifyBinding'])],
          ['volume-mip-job.js',members('KinVolumeMipJob',['validate','validateFor','restoreRequest','intersects'])],
          ['volume-mip-output.js',members('KinVolumeMipOutput',['plan','verifyClip','verifyDisplay','caption','supports','timer','saved','frames','bind','displayCaption','bytes'])],
          ['viewer-volume-mip-print.js',fn('kinRenderVolumeMipPrint')]];
        // S3-U5: the citation evidence on a report page is written by the same pure
        // functions the worklist preview uses, and this document has neither file.
        // They sit right after the base pair so the version-specific assets keep
        // their place in the request order.
        const assets=[['viewer-job-print.js',fn('kinViewerJobPrint')],['viewer-editor-link.js',fn('kinViewerEditorLink')],
          ['report-citation.js',members('KinReportCitation',['presenceOf','isReduced'])],
          ['report-preview.js',members('KinReportPaper',['citationSection','citationAnswerOk'])],
          ...([4,5,6].includes(shape)?[volumePrint]:[12,14].includes(shape)?mipPrint:[13,15].includes(shape)?[...mipPrint,['volume-mip-batch.js',members('KinVolumeMipBatch',['validate','plan','verifyCamera','budget'])]]:[])].filter(([,ready])=>!ready());
        if (assets.length) {
          // A print-only asset failure must leave saving/restoring available.
          if (!printLoading) printLoading = Promise.all(assets.map(([file,ready])=>new Promise((resolve, reject) => {
            const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/'+file;
            const cancel = () => finish(new Error('출력 화면 확인이 취소되었습니다.'));
            const timer = setTimeout(() => finish(new Error('출력 화면을 불러오지 못했습니다. 다시 누르세요.')), 30000);
            function finish(error) { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(); }
            script.onload = () => finish(ready() ? null : new Error('출력 화면을 불러오지 못했습니다. 다시 누르세요.'));
            script.onerror = () => finish(new Error('출력 화면을 불러오지 못했습니다. 다시 누르세요.'));
            abort.signal.addEventListener('abort', cancel, { once: true }); document.head.append(script);
          })));
          await printLoading;
        }
        if (!live()) return;
        printer ||= window.kinViewerJobPrint({ api, authenticate, live,
          editor: window.kinViewerEditorLink({ studies, owner: () => me ? [me.institution, me.sub] : null, live }) });
        if (row) printer.open(studies[0], row.id,row.snapshotVersion);
        else { if (!unchanged()) throw new Error('현재 영상이 바뀌었습니다. 다시 출력하세요.'); printer.openCurrent(studies[0], snapshot, unchanged); }
      } catch (e) { if (live()) status.textContent = e.message; }
      finally { printLoading = null; openingPrint = false; }
    }
    function refresh() { for (const b of buttons) { if (!b.isConnected) { buttons.delete(b); continue; } b.disabled = !live() || busy || !me || b.dataset.write === 'true' && !writable(); } }
    function button(host, label, action, write = false) {
      const b = text('button', label, host); b.type = 'button'; b.dataset.write = String(write); b.style.cssText = 'margin:3px;padding:4px;border:1px solid #657c9f;border-radius:4px';
      b.onclick = action; buttons.add(b); return b;
    }
    function end() { ended = true; serial++; printer?.close(); abort.abort(); me = null; pending = editRow = null; title.value = description.value = ''; list.replaceChildren(); status.textContent = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'; refresh(); }
    async function api(url, options = {}) {
      // `foreign`: a saved-location restore reads a Job that may name a comparison study; its 403 is that Job's refusal,
      // and only the anchor list read that follows may end the panel.
      const { idempotent = false, foreign = false, ...request } = options;
      const controller = new AbortController(), cancel = () => controller.abort(); abort.signal.addEventListener('abort', cancel, { once: true });
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted || abort.signal.aborted) cancel();
      const timer = setTimeout(cancel, 30000);
      // A read that fetch() rejects before any response is sent once more on this call's own signal and 30-second timer. Hosted
      // diagnostic run 35022850312: Chromium 148 fails a request whose HTTP/2 connection received GOAWAY before the request's stream
      // was created with ERR_FAILED, and does not resend it itself. Only GET, HEAD or a POST its caller declares read-only
      // (idempotent: true) is sent again; an abort, any HTTP response and every write are not, and a second rejection keeps the
      // browser's own error.
      const read = idempotent === true || ['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase());
      const send = () => fetch('/api' + url, { ...request, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'X-KIN-CSRF': '1', ...(me ? { 'X-KIN-Subject': me.sub } : {}), ...(request.body ? { 'Content-Type': 'application/json' } : {}) } });
      try {
        let r;
        try { r = await send(); } catch (error) { if (!read || controller.signal.aborted || error?.name !== 'TypeError' || !live()) throw error; r = await send(); }
        if (!live()) throw new Error('화면이 변경되었습니다.');
        if (r.status === 401 || r.status === 403 && !foreign) { end(); throw new Error('검사 접근 권한을 확인할 수 없습니다.'); }
        const value = await r.json().catch(() => null);
        if (!live()) throw new Error('화면이 변경되었습니다.');
        if (!r.ok || !value) { const e = new Error(typeof value?.message === 'string' ? value.message : '서버 연결을 확인한 뒤 다시 시도하세요.'); e.status = r.status; throw e; }
        return value;
      } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); options.signal?.removeEventListener('abort', cancel); }
    }
    async function authenticate(signal) {
      const next = await api('/me', { signal });
      if (next.kind !== 'member' || !next.sub || !next.institution || me && (next.sub !== me.sub || next.institution !== me.institution)) { end(); throw new Error('계정이 변경되었습니다.'); }
      me = next; lastAuth = Date.now();
    }
    function resolve(cell) {
      if (!cell) return null;
      const matches = ds.getActiveDisplaySets().filter(d => d.StudyInstanceUID === cell.study && d.SeriesInstanceUID === cell.series);
      if (matches.length !== 1 || !matches[0].images?.length || !matches[0].images.every(i => i.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2') ||
          !matches[0].images.some(i => i.SOPInstanceUID === cell.sop)) throw new Error('저장한 원본 시리즈와 프레임을 찾을 수 없습니다.');
      return matches[0].displaySetInstanceUID;
    }
    // One ordinary frame cell, captured from the live viewport. This is the only definition
    // of that shape: the version 2 layout below and the mixed MPR layout in
    // viewer-volume-job.js both go through it, so neither can drift from the other.
    // `measure` receives the canvas so each caller applies its own size budget.
    function stackCell(g, measure) {
      const sets = g.displaySetInstanceUIDs || [];
      const v = cs.getCornerstoneViewport(g.viewportId), id = v?.getCurrentImageId?.(), image = id && window.cornerstone.metaData.get('instance', id);
      if (sets.length !== 1 || v?.type !== 'stack' || !v.getDefaultActor?.()?.actor || !image || !studies.includes(image.StudyInstanceUID)) throw new Error('원본 영상 로딩을 마친 뒤 저장하세요.');
      const camera = v.getCamera(), properties = v.getProperties(), canvas = v.getCanvas();
      measure(canvas);
      if (properties.colormap?.name && properties.colormap.name !== 'Grayscale') throw new Error('현재는 회색조 표시 상태를 저장합니다.');
      const cell = { study: image.StudyInstanceUID, series: image.SeriesInstanceUID, sop: image.SOPInstanceUID, frame: 1,
        viewport: { width: canvas.width, height: canvas.height },
        camera: Object.fromEntries(['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'parallelScale', 'rotation', 'flipHorizontal', 'flipVertical'].map(k => [k, camera[k]])),
        properties: { voiRange: properties.voiRange, VOILUTFunction: properties.VOILUTFunction || 'LINEAR', invert: !!properties.invert, interpolationType: properties.interpolationType ?? 1 } };
      if (resolve(cell) !== sets[0]) throw new Error('선택한 영상과 시리즈가 일치하지 않습니다.');
      return cell;
    }
    function capture(checkOutputSize = false, readOnly = false, currentOutput = false) {
      const state = grid.getState(), views = ordered(), { numRows: rows, numCols: cols, layoutType } = state.layout;
      // A merged screen is one whose cells no longer fill the grid uniformly. The MPR Job
      // owns every rectangle-bearing layout, frame cells included, so a merged grid of
      // ordinary CT cells is captured there rather than growing a second geometry rule here.
      const uniform = views.length === rows*cols && views.every((g, i) =>
        Math.abs(g.x-(i%cols)/cols)<=1e-6 && Math.abs(g.y-Math.floor(i/cols)/rows)<=1e-6 &&
        Math.abs(g.width-1/cols)<=1e-6 && Math.abs(g.height-1/rows)<=1e-6);
      if(layoutType==='grid'&&(!uniform||views.some(g=>cs.getCornerstoneViewport(g.viewportId)?.type==='orthographic')))return volumeTools().capture(readOnly,!currentOutput);
      if (layoutType !== 'grid' || ![1, 2].includes(rows) || ![1, 2].includes(cols)) throw new Error('현재 일반 CT 1·2·4화면 배치에서 저장할 수 있습니다.');
      let totalPixels = 0;
      const cells = views.map(g => {
        const sets = g.displaySetInstanceUIDs || []; if (!sets.length) return null;
        return stackCell(g, canvas => {
          if (!checkOutputSize) return;
          const width = canvas?.width, height = canvas?.height; totalPixels += width * height;
          if (![width, height].every(n => Number.isInteger(n) && n >= 1)) throw new Error('영상 화면 크기가 준비되지 않았습니다. 로딩을 마친 뒤 저장하세요.');
          if (width > 8192 || height > 8192 || width * height > 16777216 || totalPixels > 33554432)
            throw new Error('저장할 화면이 너무 큽니다. 브라우저 창 크기나 배율을 줄인 뒤 다시 저장하세요.');
        });
      });
      if (cells.every(c => !c)) throw new Error('저장할 영상이 없습니다.');
      return JSON.parse(JSON.stringify({ version: 2, studies, rows, cols, active: views.findIndex(v => v.viewportId === state.activeViewportId), cells }));
    }
    const signature = (readOnly = false) => { try { return JSON.stringify(capture(false, readOnly)); } catch (_) { return JSON.stringify(ordered().map(g => [g.viewportId, g.displaySetInstanceUIDs])); } };
    function show(rows) {
      list.replaceChildren();
      if (!rows.length) { text('p', '저장한 비교 작업이 없습니다.', list); return; }
      for (const row of rows) {
        const item = text('div', '', list); item.style.cssText = 'border-top:1px solid #657c9f;padding:8px 0';
        text('strong', row.title + (row.hidden ? ' · Hidden' : ''), item);
        text('p', row.authorActor + ' · ' + new Date(row.createdAt).toLocaleString() + ' · r' + row.revision, item); text('p', row.description, item);
        if (!row.hidden) button(item, 'Restore Job', () => run('restore', row));
        // An allowlist of printable versions: a later version stays without Print until it has an output page of its own.
        if (!row.hidden && [1,2,3,4,5,6,12,13,14,15].includes(row.snapshotVersion)) button(item, 'Print Saved Images', () => openPrint(row));
        // A merged layout may hold no reconstructed cell at all, so it is not labelled as one.
        if(row.snapshotVersion===9)text('p','Merged Cell Layout · 출력 미지원',item);
        else if(row.snapshotVersion===12||row.snapshotVersion===14)text('p','MIP Viewer · 저장 조건 재구성 출력 · 표시 전용 투영 작업',item);
        else if(row.snapshotVersion===13||row.snapshotVersion===15)text('p','MIP Batch · 회전 투영 재구성 출력 · 표시 조건 작업',item);
        else if(row.snapshotVersion===10)text('p','Curved MPR · 출력 미지원 · 곡선을 따라 펼친 재구성 표시 작업',item);
        else if(row.snapshotVersion===11)text('p','3D Path · 출력 미지원 · 경로 평면과 경로를 따라 펼친 재구성 표시 작업',item);
        else if([4,5,6,7,8].includes(row.snapshotVersion))text('p',(row.snapshotVersion===8?'MPR Mixed Layout · 출력 미지원':row.snapshotVersion===7?'MPR Plane Layout · 출력 미지원':row.snapshotVersion===6?'MPR 3D Annotations':row.snapshotVersion===5?'MPR Batch':'MPR')+' · 재구성 표시 작업',item);
        if (row.authorSub === me?.sub) {
          button(item, 'Edit Details', () => { title.value = row.title; description.value = row.description; editSerial++; editRow = row; pending = null; status.textContent = '편집 후 변경 저장을 누르세요.'; }, true);
          button(item, row.hidden ? 'Unhide Job' : 'Hide Job', () => { const reason = window.prompt('숨김 또는 해제 사유'); if (reason?.trim()) run('hide', row, reason); }, true);
        }
      }
    }
    async function load() { const result = await api(path + '?mine=' + mine.value + '&includeHidden=' + hidden.checked); if (live()) show(result.jobs); }
    // Restore one ordinary frame cell into an existing viewport. Shared with the mixed MPR
    // layout, which calls it for its frame cells and then reads the shown instance back.
    async function applyStackCell(viewportId, cell, current) {
      for (let n = 0; n < 150; n++) {
        if (!current()) throw new Error('화면이 변경되어 복원을 중단했습니다.');
        const v = cs.getCornerstoneViewport(viewportId), index = (v?.getImageIds?.() || []).findIndex(id => {
          const m = window.cornerstone.metaData.get('instance', id); return m?.StudyInstanceUID === cell.study && m?.SeriesInstanceUID === cell.series && m?.SOPInstanceUID === cell.sop;
        });
        if (index >= 0 && v.getCurrentImageId?.() && v.getDefaultActor?.()?.actor) {
          await v.setImageIdIndex(index); if (!current()) throw new Error('화면이 변경되었습니다.');
          // setImageIdIndex loads pixels but leaves the native scroll target
          // and OHIF scrollbar/instance overlay at the old frame.
          v.scroll(index - v.getTargetImageIdIndex(), false);
          v.setProperties({ ...cell.properties, colormap: { name: 'Grayscale', opacity: [] } });
          // Native flips adjust the camera too; perform them before assigning
          // physical coordinates so saved pan is not applied twice.
          v.setCamera({ flipHorizontal: cell.camera.flipHorizontal, flipVertical: cell.camera.flipVertical });
          const camera = { ...cell.camera }; delete camera.flipHorizontal; delete camera.flipVertical;
          v.setCamera(camera); v.render(); return;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('원본 프레임 로딩에 실패했습니다.');
    }
    async function apply(value, ticket) {
      if([4,5,6,7,8,9,10,11,12,13,14,15].includes(value.version))return volumeTools().apply(value,()=>live()&&serial===ticket);
      const sets = value.cells.map(resolve), ids = value.cells.map(() => 'kin-job-' + crypto.randomUUID());
      if (JSON.stringify(value.studies) !== JSON.stringify(studies)) throw new Error('저장한 현재·비교 검사를 같은 순서로 먼저 여세요.');
      const current = () => live() && serial === ticket;
      await grid.setLayout({ numRows: value.rows, numCols: value.cols, activeViewportId: ids[value.active], isHangingProtocolLayout: false,
        findOrCreateViewport: index => ({ displaySetInstanceUIDs: sets[index] ? [sets[index]] : [], displaySetOptions: [{}],
          viewportOptions: { viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
      for (let i = 0; i < value.cells.length; i++) {
        const cell = value.cells[i]; if (!cell) continue;
        await applyStackCell(ids[i], cell, current);
      }
      if (!current()) throw new Error('화면이 변경되었습니다.'); grid.setActiveViewportId(ids[value.active]);
      return ids;
    }
    // A saved-location restore of a version 1-3 layout proves what the stack cells show before it reports a restore: every
    // saved cell's original instance and the active cell. Versions 4 and later are proved inside the MPR apply.
    function readBack(value, ids) {
      if (!Array.isArray(ids)) return;
      value.cells.forEach((cell, i) => {
        if (!cell) return;
        const v = cs.getCornerstoneViewport(ids[i]), shown = window.cornerstone.metaData.get('instance', v?.getCurrentImageId?.());
        if (shown?.StudyInstanceUID !== cell.study || shown?.SeriesInstanceUID !== cell.series || shown?.SOPInstanceUID !== cell.sop)
          throw new Error('저장한 영상 위치를 확인하지 못했습니다. 이전 화면을 확인하세요.');
      });
      if (grid.getState().activeViewportId !== ids[value.active]) throw new Error('저장한 영상 위치를 확인하지 못했습니다. 이전 화면을 확인하세요.');
    }
    /* One restore for Restore Job, the kinJob page and a finding's saved location (S2-L2a). It returns {state:'restored'|'continuing',
       message} or throws an Error carrying kinRestore {state, reason}: 'refused' changed nothing on screen, 'rolled-back' applied the
       saved state, failed and re-applied the previous screen, 'screen-unknown' could prove neither. Every text is the shipped one.
       `ctx.location` (a finding's request) adds the live pre-read, the frozen-copy checks, the read-back of versions 1-3, the
       continuation URL and the owned deadline; without it the Restore Job button behaves as it always did. */
    const outcome = (state, reason, message) => Object.assign(new Error(message), { kinRestore: { state, reason } });
    const refusal = (reason, message) => outcome('refused', reason, message);
    const LOCATION_TEXT = {
      'job-unavailable': '연결한 저장 작업을 볼 수 없거나 더 이상 없어 복원하지 않았습니다. 영상은 바꾸지 않았습니다.',
      'job-hidden': '연결한 저장 작업이 숨겨져 있어 복원하지 않았습니다. 영상은 바꾸지 않았습니다.',
      'source-changed': '연결 당시와 저장 작업의 영상 상태나 3D 표식이 달라 복원하지 않았습니다. 영상은 바꾸지 않았습니다.',
      'job-studies': '이 화면의 검사 조합이 저장 작업과 달라 복원하지 않았습니다. 영상은 바꾸지 않았습니다.',
      timeout: '제한 시간 안에 저장 작업을 확인하지 못해 복원하지 않았습니다. 영상은 바꾸지 않았습니다.',
      owner: '다른 계정의 영상 화면이라 복원하지 않았습니다.',
      busy: '영상 작업 처리가 끝난 뒤 다시 누르세요. 영상은 바꾸지 않았습니다.',
      ended: '로그인이나 화면이 바뀌어 복원하지 않았습니다.',
      'tool-missing': '저장 작업 복원 도구가 준비되지 않았습니다. 뷰어를 다시 여세요.',
      waiting: '영상 로딩을 기다리는 동안 복원하지 않았습니다. 목록의 이 소견 위치로 다시 시도하세요.',
      continuing: '저장 작업의 검사 조합으로 새 화면을 엽니다. 결과는 새 화면의 이 소견에 표시됩니다.',
    };
    const VOLUME_VERSIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    let lastJob = null, restoring = null;
    const sameNumbers = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((n, i) => n === b[i]);
    // The frame of reference of a volume's first original from its displayed metadata, when the display set carries it.
    function shownFrame(volume) {
      try {
        const set = ds.getActiveDisplaySets().find(d => d.StudyInstanceUID === volume.study && d.SeriesInstanceUID === volume.series);
        const image = (set?.images || []).find(i => i.SOPInstanceUID === volume.sops[0]), value = image?.FrameOfReferenceUID;
        return typeof value === 'string' && value ? value : null;
      } catch (_) { return null; }
    }
    function restoredText(version) {
      // A merged layout is restored as the screen it was saved as. The grid it was merged
      // from was never part of that snapshot, so the message says so instead of implying
      // that Restore Grid - which has no record of this screen - could undo it.
      return version === 9
        ? '병합한 칸 배치를 복원했습니다. 병합 전 격자는 저장된 적이 없어 되돌릴 수 없으며, 다른 배치를 적용하거나 다른 저장 작업을 복원하세요.'
        : version === 10 ? 'Curved MPR 작업을 복원했습니다. 곡선을 따라 펼친 재구성 표시이며 원본 영상이 아니고 직선 거리·측정 의미가 없습니다.'
        : version === 11 ? '3D Path 작업을 복원했습니다. 경로 수직·평행 평면과 펼친 표시는 재구성이며 원본 영상이 아니고 직선 거리·측정 의미가 없습니다.'
        : version === 12 || version === 14 ? 'MIP 작업을 복원했습니다. 표시 전용 투영이며 원본 영상과 W/L은 바뀌지 않았습니다.'
        : version === 13 || version === 15 ? 'MIP Batch 작업을 복원했습니다. 회전 투영 미리보기는 표시 전용이며 원본 영상과 W/L은 바뀌지 않았습니다.'
        : [4,5,6,7,8].includes(version) ? 'MPR 작업을 복원했습니다. 재구성 표시이며 원본 프레임 표식과 별개입니다.' : '비교 작업을 복원했습니다. 표식은 별도 저장한 최신 이력입니다.';
    }
    async function restoreJob(row, ctx) {
      const { ticket, before, initialRestore } = ctx, located = ctx.location;
      if (window.kinViewerHistoryHasUnsaved?.() || window.kinMprMarks?.dirty?.()) throw refusal('unsaved', '미저장 표식을 먼저 저장하거나 편집을 마친 뒤 복원하세요.');
      if (window.kinMprCurved?.dirty?.()) throw refusal('unsaved', '미저장 곡면 MPR 곡선이 있어 복원하지 않았습니다. 곡선을 저장하거나 Clear Curve로 지운 뒤 복원하세요.');
      if (window.kinMprPath?.dirty?.()) throw refusal('unsaved', '미저장 3D Path가 있어 복원하지 않았습니다. 경로를 저장하거나 Clear Path로 지운 뒤 복원하세요.');
      let listed = null;
      if (located) {
        // The live pre-read of this anchor's Jobs (a 403 here is the anchor's and ends the panel): hidden and absent Jobs are
        // refused before the Job itself is read; a changed title or description is only reported.
        located.ensure();
        const page = await api(path + '?mine=false&includeHidden=true', { signal: located.signal });
        listed = Array.isArray(page?.jobs) ? page.jobs.find(j => j?.id === row.id) || null : null;
        if (!listed) throw refusal('job-unavailable', LOCATION_TEXT['job-unavailable']);
        if (listed.hidden === true) throw refusal('job-hidden', LOCATION_TEXT['job-hidden']);
        if (listed.snapshotVersion !== located.request.snapshotVersion) throw refusal('source-changed', LOCATION_TEXT['source-changed']);
        located.ensure();
      }
      const job = await api(path + '/' + row.id, located ? { signal: located.signal, foreign: true } : {}); await authenticate(located?.signal);
      // On a fresh kinJob document, native hanging-protocol initialization
      // can change the grid while the saved job is fetched. User interaction
      // still advances serial; only that initial automatic layout is allowed.
      if (!live() || ticket !== serial || !initialRestore && before !== signature()) throw refusal(live() ? 'busy' : 'ended', '영상 조작이 변경되어 복원하지 않았습니다. 다시 시도하세요.');
      if (window.kinViewerHistoryHasUnsaved?.() || window.kinMprMarks?.dirty?.()) throw refusal('unsaved', '미저장 표식이 있어 복원하지 않았습니다.');
      if (window.kinMprCurved?.dirty?.()) throw refusal('unsaved', '미저장 곡면 MPR 곡선이 있어 복원하지 않았습니다. 곡선을 저장하거나 Clear Curve로 지운 뒤 복원하세요.');
      if (window.kinMprPath?.dirty?.()) throw refusal('unsaved', '미저장 3D Path가 있어 복원하지 않았습니다. 경로를 저장하거나 Clear Path로 지운 뒤 복원하세요.');
      // Restore Grid exists only in the cell merge module's memory, keyed by viewports a
      // restored Job never reuses. A restore that failed after its layout landed would roll
      // back onto fresh viewports and silently discard that record with the cells it hid, so
      // a held or in-flight merge is refused here, before any dispatch or navigation. With no
      // module loaded there is no record to lose; a reader that will not answer is refused.
      const mergeState = window.kinCellMergeWorkspaceState;
      if (typeof mergeState === 'function') {
        let held = null; try { held = mergeState(); } catch (_) { held = null; }
        if (!held || typeof held !== 'object') throw refusal('layout-merged', '칸 병합 상태를 확인할 수 없어 복원하지 않았습니다. 뷰어를 다시 연 뒤 복원하세요.');
        if (held.busy) throw refusal('busy', '칸 배치 요청이 끝난 뒤 다시 복원하세요.');
        if (held.merged) throw refusal('layout-merged', '병합한 칸이 있어 복원하지 않았습니다. 복원에 실패하면 병합 전 격자로 돌아갈 수 없게 되므로 Restore Grid로 격자를 되돌린 뒤 복원하세요.');
      }
      if (located) {
        // §2.4: the Job read now must be the one the finding copied: its version and ordered studies, and for a 3D point the
        // same volume (study, series, digest, size) and the exact mark. The frame of reference is compared when shown already.
        const request = located.request, snapshot = job?.snapshot, mark = request.mark;
        if (job?.id !== request.jobId || snapshot?.version !== request.snapshotVersion || JSON.stringify(snapshot?.studies) !== JSON.stringify(request.studies))
          throw refusal('source-changed', LOCATION_TEXT['source-changed']);
        if (mark) {
          const volume = snapshot.volume, saved = Array.isArray(snapshot.marks?.marks) ? snapshot.marks.marks.find(m => m?.id === mark.id) : null;
          if (!volume || volume.study !== mark.volume.study || volume.series !== mark.volume.series || volume.sourceDigest !== mark.volume.sourceDigest ||
              !Array.isArray(volume.sops) || volume.sops.length !== mark.volume.sopCount || !saved || saved.label !== mark.label || !sameNumbers(saved.point, mark.point))
            throw refusal('source-changed', LOCATION_TEXT['source-changed']);
          const frame = shownFrame(volume);
          if (frame !== null && frame !== mark.volume.frameOfReferenceUid) throw refusal('source-changed', LOCATION_TEXT['source-changed']);
        }
      }
      if (JSON.stringify(job.snapshot.studies) !== JSON.stringify(studies)) {
        if (located && located.request.mode !== 'continue') throw refusal('job-studies', LOCATION_TEXT['job-studies']);
        if (title.value || description.value) throw refusal('unsaved', '작성 중인 작업 제목·설명을 저장하거나 비운 뒤 비교 검사를 여세요.');
        // Opening the saved comparison replaces this document; finding drafts (held ones included)
        // would be lost. A same-document restore stays allowed: a study switch holds them.
        let findings = null; try { findings = typeof window.kinViewerFindingsState === 'function' ? window.kinViewerFindingsState() : null; } catch (_) { findings = { dirty: true }; }
        if (findings?.dirty || findings?.busy) { ctx.refused = 'findings-unsaved'; throw new Error('저장하지 않은 소견 작성 내용이 있어 비교 검사를 열지 않았습니다. 소견을 저장하거나 버린 뒤 복원하세요.'); }
        // The server rechecks both studies on the new page before applying;
        // this same-origin navigation never changes the worklist report target.
        const next = new URL('/ohif/viewer', location.origin);
        next.searchParams.set('StudyInstanceUIDs', job.snapshot.studies.join(','));
        if (located) {
          // A finding continues in the new page, where its own store proves the result: no kinJob, a one-use nonce, and a text
          // that holds for a one- or two-study target alike.
          const finding = located.request.finding, nonce = crypto.randomUUID();
          try { sessionStorage.setItem('kin-finding-continue:' + nonce, JSON.stringify({ finding: finding.id, revision: finding.revision, source: finding.source, jobId: job.id })); } catch (_) {}
          for (const [key, value] of [['kinFinding', finding.id], ['kinFindingRevision', String(finding.revision)], ['kinFindingSource', String(finding.source)], ['kinFindingNonce', nonce]])
            next.searchParams.set(key, value);
          status.textContent = LOCATION_TEXT.continuing;
        } else {
          status.textContent = '저장한 비교 검사를 함께 여는 중…';
          next.searchParams.set('kinJob', job.id);
        }
        location.assign(next.href);
        return { state: 'continuing', message: located ? LOCATION_TEXT.continuing : '' };
      }
      // No restore without a rollback snapshot of the current screen. When this screen is
      // one no saved shape can hold, that is a reason not to restore — but it is not the
      // saved Job's problem, so it must not be reported with the Save guidance.
      // A missing MPR asset is not a shape problem, so that reason is kept as it is.
      let previous; try { previous = capture(); }
      catch (e) { throw refusal(volumeJobs ? 'busy' : 'tool-missing', volumeJobs ? '현재 화면을 저장 형식으로 읽을 수 없어 복원하지 않았습니다. 복원할 수 있는 배치를 먼저 여세요.' : e.message); }
      try { if (VOLUME_VERSIONS.includes(job.snapshot.version)) volumeTools().resolve(job.snapshot); else job.snapshot.cells.forEach(resolve); }
      catch (e) { throw refusal(/도구/.test(e.message) ? 'tool-missing' : 'job-studies', e.message); }
      located?.ensure();
      ctx.mutating = true; applying = true;
      try { const ids = await apply(job.snapshot, ticket); if (located && !VOLUME_VERSIONS.includes(job.snapshot.version)) readBack(job.snapshot, ids); }
      catch (e) {
        const message = /[가-힣]/.test(e.message) ? e.message : '영상 상태를 적용하지 못했습니다. 이전 화면을 확인하세요.';
        if (!(live() && serial === ticket)) throw outcome('screen-unknown', 'apply-failed', message);
        try { await apply(previous, ticket); } catch (_) { throw outcome('screen-unknown', 'apply-failed', '복원과 이전 화면 복구에 실패했습니다. 검사를 다시 여세요.'); }
        throw outcome('rolled-back', 'apply-failed', message);
      }
      finally { if (!located) applying = false; }
      const marks = job.snapshot.version === 6 ? window.KinVolumeMarks?.normalize?.(job.snapshot.marks) ?? null : null;
      lastJob = { jobId: job.id, revision: job.revision, snapshotVersion: job.snapshot.version, marks };
      return { state: 'restored', message: restoredText(job.snapshot.version), revision: job.revision, snapshotVersion: job.snapshot.version };
    }
    /* A finding's saved location (kinViewerJobLocation.restore). The restore owns one deadline: requests stop before the last
       60 s, apply never starts with less than the 60 s apply bound left, and once it starts the promise settles after the apply
       and, when needed, the rollback (worst case LOCATION_MS + 60 s = 240 s after the claim, plus at most WAIT_MS before it).
       The point moves inside the same owned operation; a verified view whose point move fails stays restored. */
    const LOCATION_MS = 180000, APPLY_MS = 60000, WAIT_MS = 20000;
    const uuidOk = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
    const uidOk = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(s);
    const countOk = n => Number.isSafeInteger(n) && n >= 1 && n <= 2147483647;
    // The request comes from the Findings store of this or another document: every field is read once and copied.
    function locationRequest(value) {
      try {
        const studiesIn = value.studies, markIn = value.mark, findingIn = value.finding;
        const request = { subject: value.subject, jobId: value.jobId, revision: value.revision, snapshotVersion: value.snapshotVersion, mode: value.mode,
          waitReady: value.waitReady === true, studies: Array.isArray(studiesIn) ? Array.from({ length: studiesIn.length }, (_, i) => studiesIn[i]) : null, mark: null, finding: null };
        if (typeof request.subject !== 'string' || !request.subject || !uuidOk(request.jobId) || !countOk(request.revision) ||
            !VOLUME_VERSIONS.concat([1, 2, 3]).includes(request.snapshotVersion) || !['same-document', 'continue'].includes(request.mode) ||
            !request.studies || request.studies.length < 1 || request.studies.length > 2 || !request.studies.every(uidOk) ||
            new Set(request.studies).size !== request.studies.length) return null;
        if (markIn !== null && markIn !== undefined) {
          const point = markIn.point, volume = markIn.volume;
          const mark = { id: markIn.id, label: markIn.label, point: Array.isArray(point) && point.length === 3 ? [point[0], point[1], point[2]] : null,
            volume: { study: volume.study, series: volume.series, frameOfReferenceUid: volume.frameOfReferenceUid, sourceDigest: volume.sourceDigest, sopCount: volume.sopCount } };
          if (request.snapshotVersion !== 6 || !uuidOk(mark.id) || typeof mark.label !== 'string' || !mark.point || !mark.point.every(n => typeof n === 'number' && Number.isFinite(n)) ||
              !request.studies.includes(mark.volume.study) || !uidOk(mark.volume.series) || !uidOk(mark.volume.frameOfReferenceUid) ||
              typeof mark.volume.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(mark.volume.sourceDigest) || !countOk(mark.volume.sopCount)) return null;
          request.mark = mark;
        }
        if (request.mode === 'continue') {
          const finding = { id: findingIn.id, revision: findingIn.revision, source: findingIn.source };
          if (!uuidOk(finding.id) || !countOk(finding.revision) || !Number.isSafeInteger(finding.source) || finding.source < 0 || finding.source > 7) return null;
          request.finding = finding;
        }
        return request;
      } catch (_) { return null; }
    }
    const plainOutcome = result => ({ state: result.state, reason: result.reason ?? null, message: String(result.message ?? ''), point: result.point ?? 'none',
      pointMessage: String(result.pointMessage ?? ''), metadataRevision: result.metadataRevision ?? null, snapshotVersion: result.snapshotVersion ?? null });
    async function waitReady(request) {
      const until = Date.now() + WAIT_MS;
      while (Date.now() < until) {
        if (!live()) return false;
        let loaded = null;
        try { loaded = new Set(ds.getActiveDisplaySets().map(d => d.StudyInstanceUID)); } catch (_) { loaded = null; }
        if (me && !busy && loaded && studies.every(s => loaded.has(s)) && ordered().some(g => cs.getCornerstoneViewport(g.viewportId)?.getDefaultActor?.()?.actor)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    }
    async function restoreLocation(input) {
      const request = locationRequest(input);
      const refuse = reason => plainOutcome({ state: 'refused', reason, message: LOCATION_TEXT[reason] });
      if (!request) return refuse('tool-missing');
      if (request.waitReady && !await waitReady(request)) return refuse(live() ? 'busy' : 'ended');
      if (!live() || !me) return refuse('ended');
      if (request.subject !== me.sub) return refuse('owner');
      if (busy) return refuse('busy');
      busy = true; refresh();
      const ticket = ++serial, before = signature(), controller = new AbortController(), deadline = Date.now() + LOCATION_MS;
      // Requests are cut before the last apply window; nothing started after it may change the screen.
      const timer = setTimeout(() => controller.abort(), LOCATION_MS - APPLY_MS);
      const ctx = { ticket, before, initialRestore: request.waitReady, mutating: false, location: { request, signal: controller.signal,
        ensure: () => { if (controller.signal.aborted || Date.now() > deadline - APPLY_MS) throw refusal('timeout', LOCATION_TEXT.timeout); } } };
      const pass = Object.freeze({ live: () => live() && serial === ticket && applying && restoring === pass });
      let result;
      status.textContent = '저장 작업 복원 중…';
      try {
        await authenticate(controller.signal);
        if (me.sub !== request.subject) throw refusal('owner', LOCATION_TEXT.owner);
        const restored = await restoreJob({ id: request.jobId }, ctx);
        result = { ...restored, metadataRevision: restored.state === 'restored' && restored.revision !== request.revision ? restored.revision : null, point: 'none' };
        if (restored.state === 'restored' && request.mark) {
          // B3: the point moves while this restore still owns the screen; only its own camera move is rolled back on failure.
          let moved;
          restoring = pass;
          try { moved = typeof window.kinMprMarks?.goTo === 'function' ? window.kinMprMarks.goTo(request.mark.id, { label: request.mark.label, point: request.mark.point,
            volume: { study: request.mark.volume.study, series: request.mark.volume.series, frameOfReferenceUid: request.mark.volume.frameOfReferenceUid } }, pass) : { ok: false, reason: 'tool-missing', rolledBack: null }; }
          catch (_) { moved = { ok: false, reason: 'failed', rolledBack: false }; }
          finally { restoring = null; }
          if (moved?.ok === true) result.point = moved.moved === 'all' ? 'all-planes' : 'source-plane';
          else {
            result.point = 'failed';
            result.reason = moved?.reason === 'mismatch' ? 'point-mismatch' : moved?.reason === 'tool-missing' ? 'tool-missing' : 'point-failed';
            result.pointMessage = moved?.rolledBack === false ? '저장 화면은 복원했지만 3D 표식 위치로 이동하지 못했고 이동 전 평면으로도 되돌리지 못했습니다. 현재 영상을 확인하세요.'
              : '저장 화면은 복원했지만 3D 표식 위치로는 이동하지 않았습니다.' + (moved?.reason === 'mismatch' ? ' 연결 당시의 표식·볼륨과 다릅니다.' : '');
          }
        }
      } catch (e) {
        const known = e?.kinRestore;
        if (known) result = { state: known.state, reason: known.reason, message: e.message };
        else if (ctx.refused && !ctx.mutating) result = { state: 'refused', reason: ctx.refused, message: e.message };
        else if (ctx.mutating) result = { state: 'screen-unknown', reason: 'apply-failed', message: '복원 결과를 확인하지 못했습니다. 현재 영상을 확인하세요.' };
        else if (!live()) result = { state: 'refused', reason: 'ended', message: LOCATION_TEXT.ended };
        else if (e?.name === 'AbortError' || controller.signal.aborted) result = { state: 'refused', reason: 'timeout', message: LOCATION_TEXT.timeout };
        else if (e?.status === 403 || e?.status === 404) {
          result = { state: 'refused', reason: 'job-unavailable', message: LOCATION_TEXT['job-unavailable'] };
          // A refused Job may mean a withdrawn comparison study: the anchor list decides whether this panel ends.
          if (e.status === 403) load().catch(() => {});
        } else if (e?.status === 409 || e?.status === 400) result = { state: 'refused', reason: 'job-conflict', message: e.message };
        else result = { state: 'refused', reason: 'job-unavailable', message: LOCATION_TEXT['job-unavailable'] };
      } finally { clearTimeout(timer); controller.abort(); restoring = null; busy = false; applying = false; refresh(); }
      if (live()) status.textContent = [result.message, result.pointMessage].filter(Boolean).join(' ');
      return plainOutcome(result);
    }
    const jobLocation = Object.freeze({
      version: 1,
      // The Job this panel last applied or saved, while the 3D marks shown are exactly its saved marks.
      shown: () => {
        try {
          if (!live() || !me || !lastJob || busy || applying || window.kinMprMarks?.dirty?.()) return null;
          const marks = lastJob.snapshotVersion === 6 ? window.kinMprMarks?.capture?.(true) : null;
          if (lastJob.snapshotVersion === 6 && (!marks || JSON.stringify(marks) !== JSON.stringify(lastJob.marks))) return null;
          return { jobId: lastJob.jobId, revision: lastJob.revision, snapshotVersion: lastJob.snapshotVersion, studies: [...studies],
            marks: lastJob.snapshotVersion === 6 ? lastJob.marks.marks.map(m => ({ id: m.id, label: m.label })) : [] };
        } catch (_) { return null; }
      },
      restore: input => restoreLocation(input),
      owns: pass => pass !== null && pass !== undefined && pass === restoring && pass.live() === true,
    });
    window.kinViewerJobLocation = jobLocation;
    // `fields` and `outcome` belong to the MIP Viewer's own Save MIP Job and Retry MIP Save: the same request path with
    // the MIP Viewer's title and description, reporting what actually happened to the request instead of only status text.
    async function run(action, row, reason, initialRestore = false, fields = null, outcome = null) {
      if (!live() || busy || !me) { if (outcome) outcome.message = busy ? '영상 작업 처리가 끝난 뒤 다시 저장하세요.' : '계정이나 화면을 확인할 수 없어 저장하지 않았습니다.'; return; }
      busy = true; refresh(); const ticket = ++serial, edit = editSerial, before = signature(action === 'saveMip'); status.textContent = '비교 작업 확인 중…';
      let dispatched = false;
      try {
        await authenticate();
        if (action === 'list') { await load(); status.textContent = '현재 판독 대상의 저장 작업 목록입니다.'; return; }
        if (action === 'restore') {
          const restored = await restoreJob(row, { ticket, before, initialRestore, location: null });
          if (restored.state === 'restored') status.textContent = restored.message;
        } else {
          if (!writable()) throw new Error('판독의 계정에서 저장할 수 있습니다.');
          if (action !== 'retry' && action !== 'retryMip' && pending) throw new Error('이전 요청의 결과를 먼저 같은 요청 재시도로 확인하세요.');
          if (action === 'save' || action === 'saveAnnotations' || action === 'saveMip') {
            // Native frame marks have separate persistence; MPR points are captured in this Job.
            if (window.kinViewerHistoryHasUnsaved?.()) throw new Error('미저장 표식을 먼저 저장하거나 편집을 마친 뒤 작업을 저장하세요.');
            // Save MIP Job is pressed inside the MIP Viewer's own modal dialog, and the standalone viewer refuses every MPR tool a
            // permitted target while a dialog is open. Like the print dialog's unchanged check, that save only reads the screen
            // behind it: each tool still refuses unfinished input, and the MIP Viewer has already checked its source, owner, role,
            // busy state and Final display. Every other save captures as before.
            const readOnly = action === 'saveMip';
            if (before !== signature(readOnly)) throw new Error('영상 조작이 변경되었습니다. 다시 저장하세요.');
            const snapshot = capture(true, readOnly); if (action === 'saveAnnotations') {
              if([4,5,6,7,8,9,10,11,12,13,14,15].includes(snapshot.version))throw new Error('MPR 작업은 원본 표식 저장과 별개입니다. Save New Job으로 표시 상태를 저장하세요.');
              snapshot.version = 3;
            }
            // Save MIP Job sends only a MIP Job (version 13 when a MIP Batch preview is shown with it); on a screen that is not the
            // three-plane layout the capture is another shape.
            if (action === 'saveMip' && ![12,13,14,15].includes(snapshot.version)) throw new Error('MIP 작업은 3평면 1×3·3×1 MPR 배치에서 저장할 수 있습니다.');
            const mipFields = action === 'saveMip';
            pending = { body: JSON.stringify({ id: crypto.randomUUID(), title: mipFields ? String(fields?.title ?? '').trim() : title.value, description: mipFields ? String(fields?.description ?? '') : description.value, snapshot }), url: path };
          } else if (action === 'retryMip') {
            // Retry MIP Save resends the kept body only while it is the display the viewer still shows: the same block with the same
            // MIP Batch recipe, or none (a version 12 body has no mipBatch key, which the model compares as none).
            let kept = null, shown = null, shownBatch = null;
            try { kept = pending && JSON.parse(pending.body); } catch (_) { kept = null; }
            try { shown = window.kinVolumeMipJob?.capture?.(true) ?? null; shownBatch = shown ? window.kinVolumeMipJob?.batch?.(true) ?? null : null; } catch (_) { shown = null; }
            const keptPair = kept?.snapshot ? { version: kept.snapshot.version, mip: kept.snapshot.mip, mipBatch: kept.snapshot.mipBatch } : null;
            if (!shown || !window.KinVolumeMipJob?.retryable?.(keptPair, shown, shownBatch))
              throw new Error('재시도할 MIP 저장 요청이 현재 표시와 같지 않습니다. MIP Viewer를 닫고 Retry Request로 이전 요청을 확인하세요.');
          } else if (action === 'edit') {
            if (!editRow) throw new Error('수정할 작업의 제목·설명 수정 버튼을 누르세요.'); row = editRow;
            pending = { body: JSON.stringify({ expectedRevision: row.revision, title: title.value, description: description.value, hidden: row.hidden, reason: '' }), url: path + '/' + row.id + '/revisions' };
          } else if (action === 'hide') {
            pending = { body: JSON.stringify({ expectedRevision: row.revision, title: row.title, description: row.description, hidden: !row.hidden, reason }), url: path + '/' + row.id + '/revisions' };
          }
          if (!pending) throw new Error('재시도할 요청이 없습니다.');
          const sent=JSON.parse(pending.body);dispatched=true;const receipt=await api(pending.url, { method: 'POST', body: pending.body });
          // A MIP Job is Saved only for this very body: the committed summary names the sent id and its version, 12 or 13. That is
          // decided here, before the list refresh, so a refresh failure cannot turn a committed save into an error.
          const committedMip = [12, 13, 14, 15].includes(sent.snapshot?.version) && receipt?.id === sent.id && receipt?.snapshotVersion === sent.snapshot.version;
          const mipAction = action === 'saveMip' || action === 'retryMip';
          if (outcome) { outcome.state = committedMip ? 'saved' : 'not-saved'; outcome.sent = true; outcome.message = committedMip ? 'MIP 작업을 저장했습니다. 판독문과 원본 영상은 그대로입니다.' : 'MIP 작업 저장 응답을 확인할 수 없습니다. 작업 목록을 확인하세요.'; }
          if(sent.snapshot?.volume)window.kinMprMarks?.saved(sent.snapshot.marks||{version:1,visible:true,sync:true,marks:[]},sent.snapshot.volume);
          if(sent.snapshot?.volume)window.kinMprCurved?.saved(sent.snapshot.curved||null,sent.snapshot.volume);
          if(sent.snapshot?.volume)window.kinMprPath?.saved(sent.snapshot.path||null,sent.snapshot.volume);
          if(committedMip)window.kinVolumeMipJob?.saved(sent.snapshot.mip,sent.snapshot.volume,sent.snapshot.mipBatch??null);
          // The saved Job is the one shown now (kinViewerJobLocation.shown), named by its committed receipt.
          if (sent.snapshot && receipt?.id === sent.id && receipt?.snapshotVersion === sent.snapshot.version)
            lastJob = { jobId: sent.id, revision: receipt.revision, snapshotVersion: sent.snapshot.version,
              marks: sent.snapshot.version === 6 ? window.KinVolumeMarks?.normalize?.(sent.snapshot.marks) ?? null : null };
          pending = editRow = null;
          // The MIP Viewer's request never clears the panel's own Job Title or Description.
          if (editSerial === edit && !['hide', 'retry', 'saveMip', 'retryMip'].includes(action)) { title.value = ''; description.value = ''; }
          await load(); status.textContent = mipAction && committedMip ? 'MIP 작업을 저장했습니다. 판독문과 원본 영상은 그대로입니다.' : '비교 작업을 저장했습니다. 판독문과 원본 영상은 그대로입니다.' + (action === 'saveAnnotations' ? ' 저장된 주석 이력도 함께 고정했습니다.' : '');
        }
      } catch (e) {
        if (live()) { if (e.status >= 400 && e.status < 500) pending = null;
          status.textContent = (e.name === 'AbortError' ? '응답을 확인하지 못했습니다. 같은 요청을 재시도하세요.' : e.message) + ' 입력은 유지됩니다.'; }
        // A committed MIP save stays Saved when only the list refresh failed; a sent request whose body is still kept has
        // an unknown receipt (abort, timeout, 5xx); anything else was not saved.
        if (outcome) {
          if (outcome.state === 'saved') outcome.message = 'MIP 작업을 저장했습니다. 작업 목록을 새로 고치지 못했습니다. Refresh Jobs로 목록을 확인하세요.';
          else {
            outcome.state = dispatched && pending ? 'unconfirmed' : 'not-saved'; outcome.sent = dispatched;
            outcome.message = outcome.state === 'unconfirmed' ? '저장 응답을 확인하지 못했습니다. Retry MIP Save로 같은 요청을 다시 보내세요.' : e.message;
          }
        }
      } finally { busy = false; applying = false; refresh(); }
    }
    button(controls, 'Save New Job', () => run('save'), true); button(controls, 'Save Changes', () => run('edit'), true);
    button(controls, 'Save Job with Annotations', () => run('saveAnnotations'), true);
    button(controls, 'Print Current View', () => openPrint(null));
    button(controls, 'Retry Request', () => run('retry'), true); button(controls, 'Refresh Jobs', () => run('list'));
    mine.onchange = hidden.onchange = () => run('list');
    title.oninput = description.oninput = () => { editSerial++; };
    // The MIP Viewer's Save MIP Job and Retry MIP Save run through run() itself: authentication, role, the kept body, the
    // idempotent id, retry and 4xx handling. The panel's own Job Title and Description are never read or cleared by them.
    const mipCommand = Object.freeze({
      owner: () => live() && me ? JSON.stringify([me.institution, me.sub]) : null,
      writable: () => live() && !!me && !!writable(),
      busy: () => !live() || busy || applying,
      // A version 12 body has no mipBatch key, so mipBatch is undefined there; the MIP Job model compares it as no preview.
      pending: () => { if (!pending) return null; try { const b = JSON.parse(pending.body); return { version: b?.snapshot?.version, mip: b?.snapshot?.mip, mipBatch: b?.snapshot?.mipBatch }; } catch (_) { return { version: undefined }; } },
      save: async fields => { const outcome = { state: 'not-saved', message: '', sent: false }; await run('saveMip', null, undefined, false, fields, outcome); return { ...outcome, message: outcome.message || 'MIP 작업을 저장하지 않았습니다.' }; },
      retry: async () => { const outcome = { state: 'not-saved', message: '', sent: false }; await run('retryMip', null, undefined, false, null, outcome); return { ...outcome, message: outcome.message || 'MIP 작업을 저장하지 않았습니다.' }; },
    });
    window.kinViewerJobCommand = mipCommand;
    // While a restore is applied, input outside this panel is swallowed so it cannot race the restore. The one exception is
    // closing the MIP Viewer the restore itself opened (Close MIP Viewer, or Escape inside it), which cancels that restore.
    // It returns without advancing serial: the rollback runs only while serial === ticket, so it must still own the screen.
    const interaction = e => {
      const inPanel = panel.contains(e.target), effect = window.kinViewerJobs.interaction({ inPanel, applying, cancelsRestore: !inPanel && applying && !!window.kinVolumeMipJob?.cancels?.(e) });
      if (effect === 'swallow') { e.preventDefault(); e.stopImmediatePropagation(); } else if (effect === 'advance') serial++;
    };
    for (const event of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(event, interaction, { capture: true, passive: false });
    const storage = e => { if (e.key === 'kin-session-ended') end(); }; window.addEventListener('storage', storage);
    try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
    const timer = setInterval(() => {
      if (!live()) { end(); return; }
      if (!busy && !checking && Date.now()-lastAuth > 15000) {
        checking = true; authenticate().catch(() => {}).finally(() => { checking = false; refresh(); });
      }
    }, 1000);
    async function initialize() {
      await authenticate(); await run('list');
      const requested = new URLSearchParams(search).get('kinJob');
      if (!requested || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requested)) return;
      const ticket = serial; status.textContent = '저장한 비교 영상 로딩 중…';
      for (let n = 0; n < 200; n++) {
        if (!live() || ticket !== serial) return;
        const loaded = new Set(ds.getActiveDisplaySets().map(d => d.StudyInstanceUID));
        if (studies.every(s => loaded.has(s)) && ordered().some(g => cs.getCornerstoneViewport(g.viewportId)?.getDefaultActor?.()?.actor)) {
          await run('restore', { id: requested }, undefined, true); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      status.textContent = '비교 영상 로딩을 완료하지 못했습니다. 목록의 이 작업 복원으로 다시 시도하세요.';
    }
    initialize().catch(e => { if (live()) status.textContent = e.message; }).finally(refresh);
    stop = () => { if (window.kinViewerJobWorkspaceState === workspaceState) delete window.kinViewerJobWorkspaceState; if (window.kinViewerJobCommand === mipCommand) delete window.kinViewerJobCommand; if (window.kinViewerJobLocation === jobLocation) delete window.kinViewerJobLocation; end(); printer?.destroy(); clearInterval(timer); channel?.close(); window.removeEventListener('storage', storage); if (ownsWindowUnload) window.removeEventListener('beforeunload', beforeUnload); for (const event of ['pointerdown', 'wheel', 'keydown']) document.removeEventListener(event, interaction, true); panel.remove(); };
  }
  return { mount, stop: () => stop() };
};
/* Input outside the Jobs panel: while a restore is applied it is swallowed so it cannot race the restore, otherwise it
   advances serial so a pending restore or save sees the screen changed. The one exception is closing the MIP Viewer that a
   restore opened (Close MIP Viewer, or Escape inside it): that is the user's cancel, and it is neither swallowed nor allowed
   to advance serial, because the rollback runs only while serial === ticket. */
window.kinViewerJobs.interaction = ({ inPanel, applying, cancelsRestore }) => inPanel ? 'pass' : !applying ? 'advance' : cancelsRestore ? 'pass' : 'swallow';
