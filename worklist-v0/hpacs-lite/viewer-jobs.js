/* The saved state references original DICOM. No viewer runtime IDs or pixels persist. */
window.kinViewerJobs = function (services, model) {
  let stop = () => {};
  function mount() {
    stop();
    const search = location.search, scope = model.scope(search);
    if (!scope) return;
    const studies = new URLSearchParams(search).get('StudyInstanceUIDs').split(',');
    const grid = services.viewportGridService, cs = services.cornerstoneViewportService, ds = services.displaySetService;
    const parent = document.querySelector('#kin-viewer-layout'); if (!parent) return;
    parent.style.maxHeight = '64vh'; parent.style.overflow = 'auto';
    parent.querySelector('summary').textContent = '비교 작업 · 배치';
    const panel = document.createElement('details'); panel.id = 'kin-viewer-jobs'; panel.open = true;
    const text = (tag, value, host = panel) => { const e = document.createElement(tag); e.textContent = value; host.append(e); return e; };
    text('summary', '저장한 비교 작업 · 서버');
    text('p', '영상 위치·표시·배치를 저장합니다. 표식은 별도 저장한 최신 이력을 읽습니다.');
    const field = (label, tag, max) => { const l = text('label', label), e = document.createElement(tag); e.maxLength = max; e.setAttribute('aria-label', label); e.style.cssText = 'display:block;width:100%;color:#111;background:#fff'; l.append(e); return e; };
    const title = field('작업 제목', 'input', 120), description = field('작업 설명', 'textarea', 2000);
    const filters = text('div', ''), mine = text('select', '', filters); mine.setAttribute('aria-label', '작업 작성자 필터'); mine.style.cssText = 'color:#111;background:#fff';
    for (const [value, label] of [['true', '내 작업'], ['false', '전체 작업']]) { const o = text('option', label, mine); o.value = value; }
    const hiddenLabel = text('label', ' 숨김 포함', filters), hidden = document.createElement('input'); hidden.type = 'checkbox'; hidden.setAttribute('aria-label', '숨김 작업 포함'); hiddenLabel.prepend(hidden);
    const controls = text('div', ''), status = text('p', '계정 확인 중…'), list = text('div', ''); status.id = 'kin-viewer-jobs-status'; status.setAttribute('role', 'status');
    parent.insertBefore(panel, parent.children[1]);
    let ended = false, busy = false, me = null, serial = 0, editSerial = 0, pending = null, editRow = null, applying = false, channel, lastAuth = 0, checking = false;
    const abort = new AbortController(), buttons = new Set();
    const live = () => !ended && location.search === search;
    const path = '/studies/' + studies[0] + '/viewer-jobs';
    const ordered = () => [...grid.getState().viewports.values()].sort((a, b) => a.y-b.y || a.x-b.x);
    const writable = () => me?.roles?.includes('radiologist');
    function refresh() { for (const b of buttons) { if (!b.isConnected) { buttons.delete(b); continue; } b.disabled = !live() || busy || !me || b.dataset.write === 'true' && !writable(); } }
    function button(host, label, action, write = false) {
      const b = text('button', label, host); b.type = 'button'; b.dataset.write = String(write); b.style.cssText = 'margin:3px;padding:4px;border:1px solid #657c9f;border-radius:4px';
      b.onclick = action; buttons.add(b); return b;
    }
    function end() { ended = true; serial++; abort.abort(); me = null; pending = editRow = null; title.value = description.value = ''; list.replaceChildren(); status.textContent = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'; refresh(); }
    async function api(url, options = {}) {
      const controller = new AbortController(), cancel = () => controller.abort(); abort.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 30000);
      try {
        const r = await fetch('/api' + url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: { 'X-KIN-CSRF': '1', ...(me ? { 'X-KIN-Subject': me.sub } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
        if (!live()) throw new Error('화면이 변경되었습니다.');
        if (r.status === 401 || r.status === 403) { end(); throw new Error('검사 접근 권한을 확인할 수 없습니다.'); }
        const value = await r.json().catch(() => null);
        if (!live()) throw new Error('화면이 변경되었습니다.');
        if (!r.ok || !value) { const e = new Error(typeof value?.message === 'string' ? value.message : '서버 연결을 확인한 뒤 다시 시도하세요.'); e.status = r.status; throw e; }
        return value;
      } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel); }
    }
    async function authenticate() {
      const next = await api('/me');
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
    function capture() {
      const state = grid.getState(), views = ordered(), { numRows: rows, numCols: cols, layoutType } = state.layout;
      if (layoutType !== 'grid' || ![1, 2].includes(rows) || ![1, 2].includes(cols) || views.length !== rows*cols) throw new Error('현재 일반 CT 1·2·4화면 배치에서 저장할 수 있습니다.');
      const cells = views.map((g, i) => {
        if (Math.abs(g.x-(i%cols)/cols)>1e-6 || Math.abs(g.y-Math.floor(i/cols)/rows)>1e-6 || Math.abs(g.width-1/cols)>1e-6 || Math.abs(g.height-1/rows)>1e-6) throw new Error('병합 또는 특수 배치는 아직 저장할 수 없습니다.');
        const sets = g.displaySetInstanceUIDs || []; if (!sets.length) return null;
        const v = cs.getCornerstoneViewport(g.viewportId), id = v?.getCurrentImageId?.(), image = id && window.cornerstone.metaData.get('instance', id);
        if (sets.length !== 1 || v?.type !== 'stack' || !v.getDefaultActor?.()?.actor || !image || !studies.includes(image.StudyInstanceUID)) throw new Error('원본 영상 로딩을 마친 뒤 저장하세요.');
        const camera = v.getCamera(), properties = v.getProperties();
        if (properties.colormap?.name && properties.colormap.name !== 'Grayscale') throw new Error('현재는 회색조 표시 상태를 저장합니다.');
        const cell = { study: image.StudyInstanceUID, series: image.SeriesInstanceUID, sop: image.SOPInstanceUID, frame: 1,
          camera: Object.fromEntries(['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'parallelScale', 'rotation', 'flipHorizontal', 'flipVertical'].map(k => [k, camera[k]])),
          properties: { voiRange: properties.voiRange, VOILUTFunction: properties.VOILUTFunction || 'LINEAR', invert: !!properties.invert } };
        if (resolve(cell) !== sets[0]) throw new Error('선택한 영상과 시리즈가 일치하지 않습니다.');
        return cell;
      });
      if (cells.every(c => !c)) throw new Error('저장할 영상이 없습니다.');
      return JSON.parse(JSON.stringify({ version: 1, studies, rows, cols, active: views.findIndex(v => v.viewportId === state.activeViewportId), cells }));
    }
    const signature = () => { try { return JSON.stringify(capture()); } catch (_) { return JSON.stringify(ordered().map(g => [g.viewportId, g.displaySetInstanceUIDs])); } };
    function show(rows) {
      list.replaceChildren();
      if (!rows.length) { text('p', '저장한 비교 작업이 없습니다.', list); return; }
      for (const row of rows) {
        const item = text('div', '', list); item.style.cssText = 'border-top:1px solid #657c9f;padding:8px 0';
        text('strong', row.title + (row.hidden ? ' · 숨김' : ''), item);
        text('p', row.authorActor + ' · ' + new Date(row.createdAt).toLocaleString() + ' · r' + row.revision, item); text('p', row.description, item);
        if (!row.hidden) button(item, '이 작업 복원', () => run('restore', row));
        if (row.authorSub === me?.sub) {
          button(item, '제목·설명 수정', () => { title.value = row.title; description.value = row.description; editSerial++; editRow = row; pending = null; status.textContent = '편집 후 변경 저장을 누르세요.'; }, true);
          button(item, row.hidden ? '숨김 해제' : '작업 숨김', () => { const reason = window.prompt('숨김 또는 해제 사유'); if (reason?.trim()) run('hide', row, reason); }, true);
        }
      }
    }
    async function load() { const result = await api(path + '?mine=' + mine.value + '&includeHidden=' + hidden.checked); if (live()) show(result.jobs); }
    async function apply(value, ticket) {
      const sets = value.cells.map(resolve), ids = value.cells.map(() => 'kin-job-' + crypto.randomUUID());
      if (JSON.stringify(value.studies) !== JSON.stringify(studies)) throw new Error('저장한 현재·비교 검사를 같은 순서로 먼저 여세요.');
      const current = () => live() && serial === ticket;
      await grid.setLayout({ numRows: value.rows, numCols: value.cols, activeViewportId: ids[value.active], isHangingProtocolLayout: false,
        findOrCreateViewport: index => ({ displaySetInstanceUIDs: sets[index] ? [sets[index]] : [], displaySetOptions: [{}],
          viewportOptions: { viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
      for (let i = 0; i < value.cells.length; i++) {
        const cell = value.cells[i]; if (!cell) continue;
        let ready = false;
        for (let n = 0; n < 150; n++) {
          if (!current()) throw new Error('화면이 변경되어 복원을 중단했습니다.');
          const v = cs.getCornerstoneViewport(ids[i]), index = (v?.getImageIds?.() || []).findIndex(id => {
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
            v.setCamera(camera); v.render(); ready = true; break;
          }
          await new Promise(r => setTimeout(r, 100));
        }
        if (!ready) throw new Error('원본 프레임 로딩에 실패했습니다.');
      }
      if (!current()) throw new Error('화면이 변경되었습니다.'); grid.setActiveViewportId(ids[value.active]);
    }
    async function run(action, row, reason) {
      if (!live() || busy || !me) return;
      busy = true; refresh(); const ticket = ++serial, edit = editSerial, before = signature(); status.textContent = '비교 작업 확인 중…';
      try {
        await authenticate();
        if (action === 'list') { await load(); status.textContent = '현재 판독 대상의 저장 작업 목록입니다.'; return; }
        if (action === 'restore') {
          if (window.kinViewerHistoryHasUnsaved?.()) throw new Error('미저장 표식을 먼저 저장하거나 편집을 마친 뒤 복원하세요.');
          const job = await api(path + '/' + row.id); await authenticate();
          if (!live() || ticket !== serial || before !== signature()) throw new Error('영상 조작이 변경되어 복원하지 않았습니다. 다시 시도하세요.');
          if (window.kinViewerHistoryHasUnsaved?.()) throw new Error('미저장 표식이 있어 복원하지 않았습니다.');
          if (JSON.stringify(job.snapshot.studies) !== JSON.stringify(studies)) {
            if (title.value || description.value) throw new Error('작성 중인 작업 제목·설명을 저장하거나 비운 뒤 비교 검사를 여세요.');
            status.textContent = '저장한 비교 검사를 함께 여는 중…';
            // The server rechecks both studies on the new page before applying;
            // this same-origin navigation never changes the worklist report target.
            const next = new URL('/ohif/viewer', location.origin);
            next.searchParams.set('StudyInstanceUIDs', job.snapshot.studies.join(',')); next.searchParams.set('kinJob', job.id);
            location.assign(next.href); return;
          }
          const previous = capture(); job.snapshot.cells.forEach(resolve); applying = true;
          try { await apply(job.snapshot, ticket); }
          catch (e) { if (live() && serial === ticket) { try { await apply(previous, ticket); } catch (_) { throw new Error('복원과 이전 화면 복구에 실패했습니다. 검사를 다시 여세요.'); } } throw new Error(/[가-힣]/.test(e.message) ? e.message : '영상 상태를 적용하지 못했습니다. 이전 화면을 확인하세요.'); }
          finally { applying = false; }
          status.textContent = '비교 작업을 복원했습니다. 표식은 별도 저장한 최신 이력입니다.';
        } else {
          if (!writable()) throw new Error('판독의 계정에서 저장할 수 있습니다.');
          if (action !== 'retry' && pending) throw new Error('이전 요청의 결과를 먼저 같은 요청 재시도로 확인하세요.');
          if (action === 'save') {
            if (window.kinViewerHistoryHasUnsaved?.()) throw new Error('미저장 표식을 먼저 저장하거나 편집을 마친 뒤 작업을 저장하세요.');
            if (before !== signature()) throw new Error('영상 조작이 변경되었습니다. 다시 저장하세요.');
            pending = { body: JSON.stringify({ id: crypto.randomUUID(), title: title.value, description: description.value, snapshot: capture() }), url: path };
          } else if (action === 'edit') {
            if (!editRow) throw new Error('수정할 작업의 제목·설명 수정 버튼을 누르세요.'); row = editRow;
            pending = { body: JSON.stringify({ expectedRevision: row.revision, title: title.value, description: description.value, hidden: row.hidden, reason: '' }), url: path + '/' + row.id + '/revisions' };
          } else if (action === 'hide') {
            pending = { body: JSON.stringify({ expectedRevision: row.revision, title: row.title, description: row.description, hidden: !row.hidden, reason }), url: path + '/' + row.id + '/revisions' };
          }
          if (!pending) throw new Error('재시도할 요청이 없습니다.');
          await api(pending.url, { method: 'POST', body: pending.body }); pending = editRow = null;
          if (editSerial === edit && !['hide', 'retry'].includes(action)) { title.value = ''; description.value = ''; }
          await load(); status.textContent = '비교 작업을 저장했습니다. 판독문과 원본 영상은 그대로입니다.';
        }
      } catch (e) {
        if (live()) { if (e.status >= 400 && e.status < 500) pending = null;
          status.textContent = (e.name === 'AbortError' ? '응답을 확인하지 못했습니다. 같은 요청을 재시도하세요.' : e.message) + ' 입력은 유지됩니다.'; }
      } finally { busy = false; applying = false; refresh(); }
    }
    button(controls, '새 비교 작업 저장', () => run('save'), true); button(controls, '변경 저장', () => run('edit'), true);
    button(controls, '같은 요청 재시도', () => run('retry'), true); button(controls, '작업 목록 새로고침', () => run('list'));
    mine.onchange = hidden.onchange = () => run('list');
    title.oninput = description.oninput = () => { editSerial++; };
    const interaction = e => { if (panel.contains(e.target)) return; if (applying) { e.preventDefault(); e.stopImmediatePropagation(); return; } serial++; };
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
          await run('restore', { id: requested }); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      status.textContent = '비교 영상 로딩을 완료하지 못했습니다. 목록의 이 작업 복원으로 다시 시도하세요.';
    }
    initialize().catch(e => { if (live()) status.textContent = e.message; }).finally(refresh);
    stop = () => { end(); clearInterval(timer); channel?.close(); window.removeEventListener('storage', storage); for (const event of ['pointerdown', 'wheel', 'keydown']) document.removeEventListener(event, interaction, true); panel.remove(); };
  }
  return { mount, stop: () => stop() };
};
