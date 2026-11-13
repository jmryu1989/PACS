// Viewer feature module: Compare menu. Related Studies (three views of the patient's studies), Exam Marks on Images,
// Prev / Next Prior Exam (and the ‹ Prior · Prior › toolbar buttons), Manual Sync…, Scout Navigation, Match Zoom and
// Match Ratio…. The study list and every opening go through the Prior Studies extension's own controller
// (KinViewerUX.related()), so they keep its patient and cell checks; calculations are in viewer-compare-model.js.
window.KinViewerFeatures?.module('compare', ({ services, store, ui }) => {
  const grid = services.viewportGridService, cellService = services.cornerstoneViewportService, setService = services.displaySetService;
  const core = () => window.cornerstone;
  const seam = () => window.KinViewerUX || null;
  const related = () => seam()?.related?.() || null;
  let ended = false, model = null;
  const ready = ui.load(['viewer-compare-model.js']).then(() => { model = window.KinCompareModel; });
  const subscriptions = [], disposers = [];
  const style = document.createElement('style');
  style.textContent = `.kin-compare-table{border-collapse:collapse;width:100%;margin:6px 0}.kin-compare-table th,.kin-compare-table td{padding:3px 6px;text-align:left;border-bottom:1px solid #555;white-space:nowrap}
    .kin-compare-table tr[tabindex]{cursor:pointer}.kin-compare-table tr[tabindex]:hover,.kin-compare-table tr[tabindex]:focus{background:#3b4c54;outline:none}
    .kin-compare-prior{font-style:italic;font-family:"Batang",serif}.kin-compare-row{display:flex;gap:6px;align-items:center;margin:4px 0}
    .kin-compare-actions{display:flex;gap:6px;margin:6px 0}.kin-compare-status{min-height:1.2em;margin:4px 0}.kin-compare-wide{min-width:420px}
    .kin-compare-scout-frame{position:relative;width:220px;height:300px;margin:6px auto;background:#000;border:1px solid #555}
    .kin-compare-scout-image,.kin-compare-scout-viewport{position:absolute;inset:0}.kin-compare-scout-line{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    .kin-compare-scout-line line{stroke:#E8C547;stroke-width:2}
    .kin-compare-badge{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:2px 6px;border-radius:3px;background:#0b182bcc;color:#E8C547;font-size:12px;pointer-events:none;white-space:nowrap}
    .kin-compare-badge[data-compare-badge=ratio]{bottom:48px}`;
  document.head.append(style);
  const element = (tag, text, parent, className) => {
    const node = document.createElement(tag); if (text !== undefined && text !== null && text !== '') node.textContent = text;
    if (className) node.className = className; parent?.append(node); return node;
  };
  const button = (text, parent, click) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; return node; };
  const listen = (service, event, fn) => {
    if (!event || typeof service?.subscribe !== 'function') return;
    try { const subscription = service.subscribe(event, fn); if (subscription) subscriptions.push(subscription); } catch (error) { console.error(error); }
  };
  const on = (target, type, fn, options) => { if (!type) return; target.addEventListener(type, fn, options); disposers.push(() => target.removeEventListener(type, fn, options)); };
  const events = () => core()?.Enums?.Events || {};

  // ── Cells ──
  // The grid's cells in reading order (top to bottom, left to right), numbered from 1 in every window.
  const cellIds = () => [...grid.getState().viewports.entries()]
    .sort(([, a], [, b]) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0)).map(([id]) => id);
  const shownSets = id => grid.getState().viewports.get(id)?.displaySetInstanceUIDs || [];
  const viewport = id => { try { return cellService.getCornerstoneViewport(id) || null; } catch (_) { return null; } };
  const context = id => { try { return seam()?.viewport?.(id) || null; } catch (_) { return null; } };
  const currentStudy = () => seam()?.snapshot?.()?.studyUIDs?.[0] || null;
  const tagsOf = imageId => { try { return imageId ? core().metaData.get('instance', imageId) || null : null; } catch (_) { return null; } };
  const tags = id => tagsOf(viewport(id)?.getCurrentImageId?.());
  const date = value => typeof value === 'string' && /^\d{8}$/.test(value) ? value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6) : (value || '');
  const stack = id => { const v = viewport(id); return v && v.type === 'stack' && typeof v.getImageIds === 'function' && v.getImageIds().length ? v : null; };
  // Moves a stack the way the reader's own scrolling does (cornerstone's jumpToSlice). A bare setImageIdIndex leaves the
  // stack's scroll target behind, and the reader's next wheel step or jump on that cell would start from the old image.
  // debounceLoading: the step is counted from the stack's pending scroll target (as the wheel does), so moves in quick
  // succession land on the last one instead of adding up.
  const jump = (v, index) => {
    const to = core()?.utilities?.jumpToSlice;
    try { return Promise.resolve(to && v.element ? to(v.element, { imageIndex: index, debounceLoading: true }) : v.setImageIdIndex(index)); }
    catch (error) { return Promise.reject(error); }
  };
  // Where a stack is going: its pending scroll target, or the image it shows.
  const target = v => { try { const value = v.getTargetImageIdIndex?.(); return Number.isInteger(value) ? value : v.getCurrentImageIdIndex(); } catch (_) { return v.getCurrentImageIdIndex(); } };
  const seriesText = set => set ? [set.SeriesNumber ?? '', set.SeriesDescription || set.Modality || ''].join(' ').trim() : '';

  // Small labels on a cell (ui.cellLayer), one per kind and cell.
  const badges = new Map();
  function badge(kind, id, text) {
    const key = kind + '\u0000' + id, old = badges.get(key);
    if (old && old.text === text && old.node.isConnected) return;
    old?.node.remove(); badges.delete(key);
    if (!text || ended) return;
    const node = ui.cellLayer(id);
    if (!node) return;
    node.classList.add('kin-compare-badge'); node.dataset.compareBadge = kind; node.textContent = text;
    badges.set(key, { node, text });
  }
  const clearBadges = kind => { for (const key of [...badges.keys()]) if (key.startsWith(kind + '\u0000')) { badges.get(key).node.remove(); badges.delete(key); } };

  // An opening (Prev/Next prior, a Related Studies row) applies only while every cell it was asked for has not been
  // given other images since — even when the same images come back (A→B→A) — and only while it is the latest opening.
  const watchers = new Set();
  let opening = null;
  function watchCells(ids, parent) {
    opening?.abort();
    const controller = opening = new AbortController(), entry = { ids: new Set(ids.filter(Boolean)), controller };
    watchers.add(entry);
    controller.signal.addEventListener('abort', () => watchers.delete(entry), { once: true });
    if (parent) { if (parent.aborted) controller.abort(); else parent.addEventListener('abort', () => controller.abort(), { once: true }); }
    return { signal: controller.signal, abort: () => controller.abort(), done: () => { watchers.delete(entry); if (opening === controller) opening = null; } };
  }
  // ids: the cells an event names; null when it does not say (every watched opening ends).
  const touched = ids => { for (const entry of [...watchers]) if (!ids || ids.some(id => entry.ids.has(id))) entry.controller.abort(); };

  // ── Related studies (05-1) and exam marks (05-2) ──
  // The patient's related studies for a cell, marked (* current, P1… earlier); null when the list cannot be read for it.
  async function marked(viewportId, signal) {
    await ready;
    const api = related(), value = context(viewportId) || cellIds().map(context).find(Boolean);
    if (!api) throw new Error('관련 검사 목록을 사용할 수 없습니다.');
    if (!value) throw new Error('영상이 열린 칸이 없습니다.');
    const rows = await api.studies(value, signal);
    if (!rows) return null;
    return { value, rows, list: model.marks(rows, currentStudy()) };
  }

  let examMarks = false, markMap = new Map(), markPatient = null, markSignature = '', markRequest = null;
  // Marks are read for one patient tab and given only while that tab is shown.
  const examMark = uid => markPatient !== null && markPatient === seam()?.snapshot?.()?.key ? markMap.get(uid) || '' : '';
  async function refreshMarks(force) {
    if (ended) return;
    if (!examMarks) { markRequest?.abort(); markMap = new Map(); markSignature = ''; if (window.kinViewerExamMark === examMark) delete window.kinViewerExamMark; return; }
    window.kinViewerExamMark = examMark;
    const signature = JSON.stringify([seam()?.snapshot?.()?.key, cellIds().map(id => context(id)?.studyUid || '')]);
    if (!force && signature === markSignature) return;
    markSignature = signature; markRequest?.abort();
    const request = markRequest = new AbortController();
    try {
      const patient = seam()?.snapshot?.()?.key ?? null;
      const found = await marked(grid.getActiveViewportId?.(), request.signal);
      if (ended || request !== markRequest || request.signal.aborted || !examMarks) return;
      markMap = new Map((found?.list || []).filter(row => row.mark).map(row => [row.uid, row.mark]));
      markPatient = found && found.value.patientKey === patient ? patient : null;
    } catch (_) { if (request === markRequest) { markMap = new Map(); markSignature = ''; } }
  }
  let marksTimer = 0;
  const scheduleMarks = () => { if (!examMarks || ended) return; clearTimeout(marksTimer); marksTimer = setTimeout(() => refreshMarks(false), 250); };
  const examListeners = new Set();
  // features.examMarks: a boolean; anything else reads as off.
  store.subscribe('examMarks', value => { examMarks = value === true; for (const fn of examListeners) fn(); refreshMarks(true); });
  const setExamMarks = value => store.set('examMarks', !!value);

  function openRelated({ viewportId }) {
    const panel = ui.panel({ id: 'related', title: 'Related Studies' });
    if (!panel || panel.element.dataset.ready) return;
    panel.element.dataset.ready = '1'; panel.element.classList.add('kin-compare-panel', 'kin-compare-wide');
    let mode = 'related', data = null, request = null;
    const top = element('label', '', panel.body, 'kin-compare-row'); element('span', 'View', top);
    const select = element('select', '', top); select.setAttribute('aria-label', 'View');
    for (const [value, label] of [['related', 'Related Studies'], ['with-current', 'Related Studies with Current Study'], ['series', 'Series']]) {
      const option = element('option', label, select); option.value = value;
    }
    const table = element('table', '', panel.body, 'kin-compare-table');
    const checkRow = element('label', '', panel.body, 'kin-compare-row');
    const check = element('input', '', checkRow); check.type = 'checkbox'; check.checked = examMarks;
    element('span', 'Show Exam Mark on images (prior in a different font)', checkRow);
    check.onchange = async () => { const want = check.checked; if (!await setExamMarks(want)) check.checked = examMarks; };
    const examChanged = () => { check.checked = examMarks; }; examListeners.add(examChanged);
    const status = element('p', '', panel.body, 'kin-compare-status'); status.setAttribute('role', 'status');
    const viewing = () => new Set(cellIds().map(id => context(id)?.studyUid).filter(Boolean));
    const viewingSets = () => new Set(cellIds().flatMap(shownSets));
    async function openRow(uid, seriesUid) {
      const api = related();
      if (!api || !data) return;
      const value = context(grid.getActiveViewportId?.()) || cellIds().map(context).find(Boolean);
      if (!value) { status.textContent = '영상이 열린 칸이 없습니다.'; return; }
      if (!seriesUid && viewing().has(uid)) { status.textContent = '이미 열려 있는 검사입니다.'; return; }
      status.textContent = '영상을 불러오는 중…';
      // A newer opening, closing this window or any cell given other images meanwhile drops this one.
      const watch = rowOpening = watchCells(cellIds()), signal = watch.signal;
      try {
        const ok = await api.open(value, uid, { seriesUid, studies: data.rows, signal });
        if (!panel.element.isConnected || (signal.aborted && !ok)) return;
        status.textContent = ok ? '' : '저장·편집 또는 배치를 확인한 뒤 다시 시도하세요. 현재 영상은 유지합니다.';
      } catch (error) { if (panel.element.isConnected && !signal.aborted) status.textContent = error?.message || '영상을 열지 못했습니다.'; }
      finally { watch.done(); }
      paint();
    }
    let rowOpening = null;
    panel.onClose(() => rowOpening?.abort());
    function row(cells, onOpen) {
      const tr = element('tr', '', table); tr.tabIndex = 0;
      cells.forEach(([text, className]) => element('td', text, tr, className));
      tr.ondblclick = onOpen; tr.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); onOpen(); } };
      return tr;
    }
    function paint() {
      table.replaceChildren();
      if (!data) return;
      const marks = new Map(data.list.map(item => [item.uid, item]));
      if (mode === 'series') {
        const head = element('tr', '', table);
        for (const text of ['Mark', 'Viewing', 'Study', 'Series No', 'Description', 'Images']) element('th', text, head);
        const order = data.list.map(item => item.uid), open = viewingSets();
        const list = (setService.getActiveDisplaySets?.() || []).filter(set => marks.has(set.StudyInstanceUID) && set.images?.length)
          .sort((a, b) => order.indexOf(a.StudyInstanceUID) - order.indexOf(b.StudyInstanceUID)
            || Number(a.SeriesNumber || 0) - Number(b.SeriesNumber || 0) || String(a.SeriesInstanceUID).localeCompare(String(b.SeriesInstanceUID)));
        for (const set of list) {
          const study = marks.get(set.StudyInstanceUID);
          const tr = row([[study.mark, study.mark && study.mark !== '*' ? 'kin-compare-prior' : ''], [open.has(set.displaySetInstanceUID) ? 'Open' : ''],
            [study.date || ''], [String(set.SeriesNumber ?? '')], [set.SeriesDescription || set.Modality || ''], [String(set.numImageFrames ?? set.images.length)]],
            () => openRow(set.StudyInstanceUID, set.SeriesInstanceUID));
          tr.dataset.series = set.SeriesInstanceUID;
        }
        return;
      }
      const head = element('tr', '', table);
      for (const text of ['Mark', 'Viewing', 'Study Date', 'Modality', 'Description']) element('th', text, head);
      const open = viewing(), now = currentStudy();
      for (const item of data.list.filter(item => mode === 'with-current' || item.uid !== now)) {
        const tr = row([[item.mark, item.mark && item.mark !== '*' ? 'kin-compare-prior' : ''], [open.has(item.uid) ? 'Open' : ''], [item.date || ''],
          [item.modality || ''], [item.desc || '']], () => openRow(item.uid));
        tr.dataset.study = item.uid;
      }
    }
    async function load() {
      request?.abort(); const mine = request = new AbortController();
      status.textContent = '불러오는 중…';
      try {
        const found = await marked(viewportId, mine.signal);
        if (mine !== request || !panel.element.isConnected) return;
        data = found; status.textContent = found ? '' : '이 칸의 검사를 목록에서 확인할 수 없습니다.';
      } catch (error) { if (mine === request && panel.element.isConnected) { data = null; status.textContent = error?.message || '목록을 불러오지 못했습니다.'; } }
      paint();
    }
    select.onchange = () => { mode = select.value; paint(); };
    const repaint = () => { if (panel.element.isConnected) paint(); };
    const relisten = [];
    const api = related();
    if (api?.subscribe) relisten.push(api.subscribe(() => { if (panel.element.isConnected) load(); }));
    for (const [service, event] of [[grid, grid.EVENTS?.GRID_STATE_CHANGED], [cellService, cellService.EVENTS?.VIEWPORT_DATA_CHANGED]]) {
      if (!event || typeof service?.subscribe !== 'function') continue;
      try { relisten.push(service.subscribe(event, repaint)); } catch (_) {}
    }
    panel.onClose(() => { request?.abort(); examListeners.delete(examChanged); for (const stop of relisten) try { typeof stop === 'function' ? stop() : stop?.unsubscribe?.(); } catch (_) {} });
    load();
  }

  // ── Prev / Next Prior Exam (05-3) ──
  // Every comparison cell (a cell showing a study other than the current one) changes together to the prior before or
  // after the one shown; with no comparison cell, the nearest prior opens beside the current images.
  async function prior(direction, { viewportId, signal }) {
    await ready;
    // The press takes its place among openings at once, before anything is read: a later opening drops it, and it
    // never drops a later one. Every cell is watched until the change applies.
    const now = currentStudy(), compare = cellIds().map(context).filter(value => value && value.studyUid !== now);
    const watch = watchCells(cellIds(), signal);
    let ok, row, next;
    try {
      const found = await marked(viewportId, watch.signal);
      if (watch.signal.aborted) return;
      if (!found) { ui.toast('이 칸의 검사를 관련 검사 목록에서 확인할 수 없습니다.'); return; }
      next = model.step(model.priorUids(found.list), compare[0]?.studyUid ?? null, direction);
      if (next.end) { ui.toast(next.end === 'none' ? '과거 검사가 없습니다.' : next.end === 'older' ? '더 이전 검사가 없습니다.' : '더 이후 검사가 없습니다.'); return; }
      row = found.list.find(item => item.uid === next.uid);
      const api = related();
      ok = compare.length ? await api.replace(compare.map(value => ({ value, uid: next.uid })), { signal: watch.signal, studies: found.rows })
        : await api.open(found.value, next.uid, { signal: watch.signal, studies: found.rows });
    } catch (error) { if (watch.signal.aborted) return; throw error; }
    finally { watch.done(); }
    if (ok) { ui.toast([direction < 0 ? 'Prev Prior Exam' : 'Next Prior Exam', '→', row.mark, row.date, row.modality, row.desc].filter(Boolean).join(' ')); scheduleMarks(); return; }
    if (!watch.signal.aborted) throw new Error('저장·편집 또는 배치를 확인한 뒤 다시 시도하세요. 현재 영상은 유지합니다.');
  }

  // ── Manual Sync (05-5) ──
  // One group (A). A member is an image set (display set) of one patient with the image number it had when tied
  // (anchor). It follows whichever cell shows that set; a cell given other images or another patient leaves the group
  // unless the group is locked, and then the set waits for a cell that shows it again. Only image numbers are tied.
  const group = { members: [], locked: false, picked: new Set() };
  const bound = new Map();   // viewportId -> member
  const syncListeners = new Set();
  // Read by the automatic CT position sync (config/ohif/ct-sync.js): a tied cell neither leads nor follows it.
  const manualApi = { has: id => bound.has(id) };
  window.kinManualSync = manualApi;
  // The patient of this viewer's tab. A cell's own rendered identity is absent while its next image loads, so a tie is
  // kept by image set and patient tab, never by whether the cell has painted yet.
  const patientKey = () => seam()?.snapshot?.()?.key ?? null;
  const shows = (cell, set) => shownSets(cell).length === 1 && shownSets(cell)[0] === set;
  function bind() {
    bound.clear();
    const ids = cellIds(), patient = patientKey();
    const members = group.members.filter(member => member.patientKey === patient);
    // The cell a member was tied in keeps it while it still shows that set (another cell showing the same set is not
    // taken instead); only a locked group looks for another cell showing the set after a new layout.
    for (const member of members)
      if (member.viewportId && ids.includes(member.viewportId) && !bound.has(member.viewportId) && shows(member.viewportId, member.set)) bound.set(member.viewportId, member);
    if (group.locked) for (const member of members) {
      if ([...bound.values()].includes(member)) continue;
      const id = ids.find(cell => !bound.has(cell) && shows(cell, member.set));
      if (id) bound.set(id, member);
    }
    for (const member of group.members) member.viewportId = [...bound].find(([, value]) => value === member)?.[0] || null;
    // Unlocked, a cell given other images leaves the group, and a group of one is no group.
    if (!group.locked) {
      group.members = group.members.filter(member => member.viewportId);
      if (group.members.length < 2) { group.members = []; bound.clear(); }
    }
    for (const id of ids) badge('sync', id, bound.has(id) ? (group.locked ? '🔒 Manual Sync A (locked)' : 'Manual Sync A') : null);
    for (const key of [...badges.keys()]) if (key.startsWith('sync\u0000') && !bound.has(key.slice(5))) { badges.get(key).node.remove(); badges.delete(key); }
    for (const fn of syncListeners) fn();
  }
  function tie(ids) {
    const members = [], patient = patientKey();
    for (const id of ids) {
      const v = stack(id), sets = shownSets(id);
      if (!v || sets.length !== 1 || !patient) continue;
      members.push({ set: sets[0], patientKey: patient, anchor: v.getCurrentImageIdIndex(), count: v.getImageIds().length, viewportId: id, expected: null });
    }
    group.members = members.length >= 2 ? members : [];
    if (!group.members.length) group.locked = false;
    bind();
    return group.members.length;
  }
  function moved(event) {
    const id = event.detail?.viewportId, member = id && bound.get(id);
    if (!member || !model) return;
    const v = stack(id);
    if (!v || shownSets(id)[0] !== member.set) { bind(); return; }
    const index = v.getCurrentImageIdIndex();
    // The move this group made itself is not a new lead: neither its arrival nor an image that arrives while the move
    // is still on its way (the stack's scroll target is still where this group sent it).
    if (member.expected !== null) {
      if (index === member.expected) { member.expected = null; return; }
      if (target(v) === member.expected) return;
      member.expected = null;
    }
    member.count = v.getImageIds().length;
    const targets = model.follow(group.members.filter(item => item.viewportId).map(item => ({ id: item.viewportId, anchor: item.anchor, count: item.count })), id, index);
    for (const [cell, value] of Object.entries(targets)) {
      const other = stack(cell), follower = bound.get(cell);
      // Compared with where the stack is going, not only what it shows, so a quick move back also replaces a move
      // still on its way.
      if (!other || !follower || shownSets(cell)[0] !== follower.set || (target(other) === value && other.getCurrentImageIdIndex() === value)) continue;
      follower.expected = value;
      jump(other, value).catch(() => { follower.expected = null; });
    }
  }

  function openManualSync() {
    const panel = ui.panel({ id: 'manual-sync', title: 'Manual Sync' });
    if (!panel || panel.element.dataset.ready) return;
    panel.element.dataset.ready = '1'; panel.element.classList.add('kin-compare-panel');
    group.picked = new Set(bound.keys());
    const table = element('table', '', panel.body, 'kin-compare-table');
    const actions = element('div', '', panel.body, 'kin-compare-actions');
    const status = element('p', '', panel.body, 'kin-compare-status'); status.setAttribute('role', 'status');
    const apply = button('Apply', actions, () => {
      const count = tie([...group.picked]);
      status.textContent = group.picked.size && !count ? '영상이 있는 칸을 두 개 이상 고르세요.' : '';
      paint();
    });
    const lock = button('Lock Selection', actions, () => {
      if (group.locked) group.locked = false;
      else {
        // Locking ties the ticked cells first when they are not tied yet.
        const same = group.picked.size === bound.size && [...group.picked].every(id => bound.has(id));
        if (!same && tie([...group.picked]) < 2) { status.textContent = '영상이 있는 칸을 두 개 이상 고르세요.'; paint(); return; }
        if (!group.members.length) { status.textContent = '영상이 있는 칸을 두 개 이상 고르세요.'; paint(); return; }
        group.locked = true;
      }
      status.textContent = ''; bind(); paint();
    });
    function paint() {
      table.replaceChildren();
      const head = element('tr', '', table);
      for (const text of ['Sync', 'Cell', 'Study Date', 'Series']) element('th', text, head);
      cellIds().forEach((id, index) => {
        const tr = element('tr', '', table), cell = element('td', '', tr);
        const input = element('input', '', cell); input.type = 'checkbox'; input.setAttribute('aria-label', 'Sync cell ' + (index + 1));
        input.checked = group.picked.has(id); input.disabled = group.locked;
        input.onchange = () => { if (input.checked) group.picked.add(id); else group.picked.delete(id); };
        const t = shownSets(id).length ? tags(id) : null, set = shownSets(id).length === 1 ? setService.getDisplaySetByUID?.(shownSets(id)[0]) : null;
        element('td', String(index + 1), tr); element('td', t ? date(t.StudyDate) : '', tr); element('td', seriesText(set), tr);
      });
      lock.textContent = group.locked ? 'Unlock' : 'Lock Selection';
      lock.setAttribute('aria-pressed', String(group.locked));
    }
    const changed = () => { if (!panel.element.isConnected) return; if (group.locked) group.picked = new Set(bound.keys()); paint(); };
    syncListeners.add(changed);
    panel.onClose(() => syncListeners.delete(changed));
    paint();
  }

  // ── Scout Navigation (05-6) ──
  let scoutSequence = 0;
  function openScout({ viewportId }) {
    const panel = ui.panel({ id: 'scout', title: 'Scout Navigation' });
    if (!panel || panel.element.dataset.ready) return;
    panel.element.dataset.ready = '1'; panel.element.classList.add('kin-compare-panel', 'kin-compare-scout');
    const studyRow = element('label', '', panel.body, 'kin-compare-row'); element('span', 'Study', studyRow);
    const studySelect = element('select', '', studyRow); studySelect.setAttribute('aria-label', 'Study');
    const seriesRow = element('label', '', panel.body, 'kin-compare-row'); element('span', 'Series', seriesRow);
    const seriesSelect = element('select', '', seriesRow); seriesSelect.setAttribute('aria-label', 'Series');
    const frame = element('div', '', panel.body, 'kin-compare-scout-frame');
    const host = element('div', '', frame, 'kin-compare-scout-image'); host.setAttribute('aria-label', 'Scout Image');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('kin-compare-scout-line'); frame.append(svg);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); svg.append(line);
    const info = element('p', '', panel.body, 'kin-compare-status'); info.setAttribute('role', 'status');
    let engine = null, scout = null, scoutSet = null, closed = false, loading = 0;
    const engineId = 'kin-compare-scout-' + (++scoutSequence);
    // The studies loaded in this viewer (one patient per tab), one display set each for its labels.
    const studies = () => {
      const seen = new Map();
      for (const set of setService.getActiveDisplaySets?.() || []) if (set.images?.length && !seen.has(set.StudyInstanceUID)) seen.set(set.StudyInstanceUID, set);
      return [...seen.values()];
    };
    const imageIds = set => (set?.images || []).map(image => image.imageId).filter(Boolean);
    const firstTags = set => tagsOf(imageIds(set)[0]);
    const isLocalizer = set => { const type = firstTags(set)?.ImageType; return (Array.isArray(type) ? type : String(type || '').split('\\')).some(t => String(t).toUpperCase() === 'LOCALIZER'); };
    // The scout for the active cell's study: a series marked LOCALIZER, or else the first in another plane.
    function defaultSeries(studyUid) {
      const list = (setService.getActiveDisplaySets?.() || []).filter(set => set.StudyInstanceUID === studyUid && imageIds(set).length);
      const active = model.plane(tags(grid.getActiveViewportId?.() || viewportId));
      return list.find(isLocalizer) || list.find(set => {
        const p = model.plane(firstTags(set));
        return p && active && p.frame === active.frame && Math.abs(p.normal[0] * active.normal[0] + p.normal[1] * active.normal[1] + p.normal[2] * active.normal[2]) < 1 - 1e-3;
      }) || null;
    }
    function fillSeries(studyUid, chosen) {
      seriesSelect.replaceChildren();
      const list = (setService.getActiveDisplaySets?.() || []).filter(set => set.StudyInstanceUID === studyUid && imageIds(set).length);
      for (const set of list) {
        const option = element('option', seriesText(set) + ' (' + imageIds(set).length + (imageIds(set).length === 1 ? ' image)' : ' images)') + (isLocalizer(set) ? ' · Localizer' : ''), seriesSelect);
        option.value = set.displaySetInstanceUID;
      }
      seriesSelect.value = chosen?.displaySetInstanceUID || '';
    }
    // The scout's own tools, on this window's viewport only: Window/Level on the left button, Pan on the middle,
    // Zoom on the right. The image cells' tools and settings are not touched.
    const toolGroupId = engineId + '-tools';
    function release() {
      const tools = window.cornerstoneTools;
      try { if (tools?.ToolGroupManager?.getToolGroup(toolGroupId)) tools.ToolGroupManager.destroyToolGroup(toolGroupId); } catch (_) {}
      if (engine) { try { engine.destroy(); } catch (_) {} engine = null; }
    }
    function attachTools() {
      const tools = window.cornerstoneTools, buttons = tools?.Enums?.MouseBindings;
      if (!tools?.ToolGroupManager || !buttons) return false;
      try {
        const group = tools.ToolGroupManager.createToolGroup(toolGroupId);
        for (const [tool, button] of [[tools.WindowLevelTool, buttons.Primary], [tools.PanTool, buttons.Auxiliary], [tools.ZoomTool, buttons.Secondary]]) {
          group.addTool(tool.toolName);
          group.setToolActive(tool.toolName, { bindings: [{ mouseButton: button }] });
        }
        group.addViewport(engineId + '-view', engineId);
        return true;
      } catch (error) { console.error(error); return false; }
    }
    host.addEventListener('contextmenu', event => event.preventDefault());
    async function show(set) {
      const mine = ++loading;
      scoutSet = set; scout = null; line.setAttribute('visibility', 'hidden');
      release();
      host.replaceChildren();
      if (!set) { info.textContent = '이 검사에는 scout으로 쓸 영상이 없습니다.'; return; }
      const ids = imageIds(set);
      try {
        const cs = core();
        engine = new cs.RenderingEngine(engineId);
        const node = element('div', '', host, 'kin-compare-scout-viewport');
        engine.enableElement({ viewportId: engineId + '-view', type: cs.Enums.ViewportType.STACK, element: node });
        frame.dataset.tools = attachTools() ? 'on' : 'off';
        const view = engine.getViewport(engineId + '-view');
        await view.setStack(ids, Math.floor((ids.length - 1) / 2));
        if (closed || mine !== loading) return;
        scout = view; view.render(); draw();
      } catch (error) { if (!closed && mine === loading) info.textContent = '영상을 불러오지 못했습니다.'; }
    }
    const REASONS = { frame: '이 시리즈와는 위치를 맞출 수 없습니다.', parallel: '지금 칸과 같은 방향의 영상이라 위치선을 그릴 수 없습니다.',
      outside: '지금 단면이 이 영상 밖에 있습니다.', geometry: '영상의 위치 정보를 확인할 수 없어 위치선을 그리지 않습니다.' };
    // The active cell's slice on the scout, only for one patient and one frame of reference with real geometry.
    function geometry() {
      const active = grid.getActiveViewportId?.() || viewportId, v = stack(active);
      if (!scout || !v) return { reason: 'geometry' };
      const scoutTags = tagsOf(scout.getCurrentImageId()), sliceTags = tags(active);
      if (!scoutTags || !sliceTags || !scoutTags.PatientID || scoutTags.PatientID !== sliceTags.PatientID) return { reason: 'frame' };
      const a = model.plane(scoutTags), b = model.plane(sliceTags);
      if (!a || !b) return { reason: 'geometry' };
      const crossing = model.crossLine(a, b);
      return { ...crossing, scout: a, slice: b, active, view: v };
    }
    function draw() {
      if (closed || !scout || !model) return;
      const found = geometry(), total = stack(found.active || viewportId)?.getImageIds().length || 0;
      const index = (stack(found.active || viewportId)?.getCurrentImageIdIndex() ?? -1) + 1;
      if (found.reason) { line.setAttribute('visibility', 'hidden'); info.textContent = REASONS[found.reason]; frame.dataset.line = 'none'; return; }
      const [x1, y1] = scout.worldToCanvas(model.scoutPoint(found.scout, ...found.from)), [x2, y2] = scout.worldToCanvas(model.scoutPoint(found.scout, ...found.to));
      for (const [key, value] of [['x1', x1], ['y1', y1], ['x2', x2], ['y2', y2]]) line.setAttribute(key, String(value));
      line.setAttribute('visibility', 'visible');
      frame.dataset.line = [x1, y1, x2, y2].map(n => n.toFixed(1)).join(' ');
      info.textContent = 'Image ' + index + ' / ' + total;
    }
    // A click on the scout takes the active cell to the slice nearest that point.
    function go(event) {
      const found = geometry();
      if (found.reason || !scout) { if (found.reason) info.textContent = REASONS[found.reason]; return; }
      const box = scout.element.getBoundingClientRect(), point = scout.canvasToWorld([event.clientX - box.left, event.clientY - box.top]);
      const planes = found.view.getImageIds().map(id => { const p = model.plane(tagsOf(id)); return p && p.frame === found.slice.frame ? p : null; });
      const index = model.nearestSlice(planes, point);
      if (index >= 0 && index !== found.view.getCurrentImageIdIndex()) jump(found.view, index).catch(() => {});
    }
    let down = null;
    host.addEventListener('pointerdown', event => { down = [event.clientX, event.clientY]; });
    host.addEventListener('pointerup', event => { if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) < 4) go(event); down = null; });
    host.addEventListener('wheel', event => {
      if (!scout) return;
      event.preventDefault();
      const count = scout.getImageIds().length, next = Math.max(0, Math.min(count - 1, target(scout) + Math.sign(event.deltaY)));
      if (next !== target(scout)) jump(scout, next).then(draw, () => {});
    }, { passive: false });
    let queued = false;
    const redraw = () => { if (closed || queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); };
    const types = [events().STACK_NEW_IMAGE, events().IMAGE_RENDERED].filter(Boolean);
    for (const type of types) document.addEventListener(type, redraw, true);
    const stops = [];
    for (const event of [grid.EVENTS?.ACTIVE_VIEWPORT_ID_CHANGED, grid.EVENTS?.GRID_STATE_CHANGED]) {
      if (!event) continue;
      try { stops.push(grid.subscribe(event, redraw)); } catch (_) {}
    }
    panel.onClose(() => {
      closed = true; loading++;
      for (const type of types) document.removeEventListener(type, redraw, true);
      for (const stop of stops) try { stop?.unsubscribe?.(); } catch (_) {}
      release();
    });
    for (const set of studies()) {
      const t = firstTags(set), option = element('option', [date(t?.StudyDate || set.StudyDate), t?.StudyDescription || ''].filter(Boolean).join(' ') || set.StudyInstanceUID, studySelect);
      option.value = set.StudyInstanceUID;
    }
    const startStudy = context(viewportId)?.studyUid || studySelect.options[0]?.value || '';
    studySelect.value = startStudy;
    const start = defaultSeries(startStudy);
    fillSeries(startStudy, start);
    studySelect.onchange = () => { const set = defaultSeries(studySelect.value); fillSeries(studySelect.value, set); show(set); };
    seriesSelect.onchange = () => show(setService.getDisplaySetByUID?.(seriesSelect.value) || null);
    show(start);
  }

  // ── Match Zoom (05-7) ──
  function matchZoom({ viewportId }) {
    const reference = viewport(viewportId);
    if (!reference?.getZoom) throw new Error('기준이 될 영상이 없습니다.');
    const zoom = reference.getZoom();
    let count = 0;
    for (const id of cellIds()) {
      const v = viewport(id);
      if (!v || id === viewportId || typeof v.setZoom !== 'function' || !shownSets(id).length) continue;
      v.setZoom(zoom); v.render(); count++;
    }
    ui.toast('Match Zoom: ' + count + ' other image' + (count === 1 ? '' : 's') + ' now at the zoom of the selected image (' + Math.round(zoom * 100) + '%).');
  }

  // ── Match Ratio (05-8) ──
  // Screen pixels per image pixel along the image row, from the cell's own camera.
  function pxPerPixel(v) {
    try {
      const plane = core().metaData.get('imagePlaneModule', v.getCurrentImageId());
      const row = plane?.rowCosines, step = plane?.columnPixelSpacing;
      if (!row || !(step > 0)) return null;
      const box = v.element.getBoundingClientRect(), a = v.canvasToWorld([box.width / 2, box.height / 2]);
      const p = v.worldToCanvas(a), q = v.worldToCanvas(a.map((n, i) => n + row[i] * step));
      const size = Math.hypot(q[0] - p[0], q[1] - p[1]);
      return size > 0 ? size : null;
    } catch (_) { return null; }
  }
  function scale(id) {
    const v = viewport(id), t = tags(id);
    if (!v || !t || !shownSets(id).length) return null;
    const spacing = model.spacing(t), px = pxPerPixel(v);
    return { v, spacing, perMm: spacing ? model.pxPerMm(px, spacing.value[1]) : null };
  }
  // The cells Match Ratio matched, labelled while each still shows the reference's px per mm (within 1 %): a zoom,
  // other images or a cell's spacing changing afterwards takes the label off.
  let ratio = null, ratioFrame = 0;
  function checkRatio() {
    if (!ratio || !model) return;
    const ref = scale(ratio.reference);
    for (const id of [...ratio.cells]) {
      const now = scale(id);
      if (!ref?.perMm || !now?.perMm || Math.abs(now.perMm / ref.perMm - 1) > 0.01) { ratio.cells.delete(id); badge('ratio', id, null); }
    }
    if (!ratio.cells.size) { badge('ratio', ratio.reference, null); ratio = null; }
  }
  function openMatchRatio({ viewportId }) {
    const panel = ui.panel({ id: 'match-ratio', title: 'Match Ratio' });
    if (!panel || panel.element.dataset.ready) return;
    panel.element.dataset.ready = '1'; panel.element.classList.add('kin-compare-panel', 'kin-compare-wide');
    const reference = viewportId;
    const table = element('table', '', panel.body, 'kin-compare-table');
    const actions = element('div', '', panel.body, 'kin-compare-actions');
    const status = element('p', '', panel.body, 'kin-compare-status'); status.setAttribute('role', 'status');
    const skipped = new Set();
    const match = button('Match Ratio', actions, () => {
      const ref = scale(reference);
      if (!ref?.perMm) { status.textContent = '기준 칸(선택한 칸)의 픽셀 간격을 확인할 수 없어 맞추지 않았습니다.'; paint(); return; }
      skipped.clear(); clearBadges('ratio');
      const detector = ref.spacing.source !== 'patient', matched = new Set();
      for (const id of cellIds()) {
        if (id === reference) continue;
        const now = scale(id);
        if (!now) continue;
        if (!now.perMm) { skipped.add(id); badge('ratio', id, null); continue; }
        const zoom = model.ratioZoom(now.v.getZoom(), ref.perMm, now.perMm);
        if (!zoom) { skipped.add(id); continue; }
        now.v.setZoom(zoom); now.v.render(); matched.add(id);
        badge('ratio', id, 'Match Ratio (same mm on screen)' + (detector || now.spacing.source !== 'patient' ? ' · detector scale' : ''));
      }
      if (matched.size) {
        badge('ratio', reference, 'Match Ratio (same mm on screen) · reference' + (detector ? ' · detector scale' : ''));
        ratio = { reference, cells: matched };
      } else ratio = null;
      status.textContent = skipped.size ? '간격을 확인할 수 없어 제외한 칸: ' + cellIds().map((id, i) => skipped.has(id) ? i + 1 : null).filter(Boolean).join(', ') : '';
      requestAnimationFrame(paint);
    });
    function paint() {
      if (!panel.element.isConnected) return;
      table.replaceChildren();
      const head = element('tr', '', table);
      for (const text of ['Cell', 'Pixel Spacing', 'Spacing Source', 'Screen px per mm']) element('th', text, head);
      cellIds().forEach((id, index) => {
        const found = scale(id);
        if (!found) return;
        const tr = element('tr', '', table); tr.dataset.cell = id;
        element('td', (index + 1) + (id === reference ? ' (reference)' : ''), tr);
        element('td', found.spacing ? found.spacing.value.map(n => String(+n.toPrecision(10))).join('\\') : '—', tr);
        element('td', found.spacing ? found.spacing.label : '간격을 확인할 수 없어 제외', tr);
        element('td', found.perMm ? found.perMm.toFixed(2) : '—', tr);
      });
      const ref = scale(reference);
      match.disabled = !ref?.perMm;
      if (!ref?.perMm) status.textContent = '기준 칸(선택한 칸)의 픽셀 간격을 확인할 수 없어 맞출 수 없습니다.';
    }
    paint();
  }

  // ── Registration ──
  const withModel = fn => async options => { await ready; return fn(options); };
  const available = () => !!related();
  ui.menuItem('Compare', { id: 'compareRelatedStudies', label: 'Related Studies', order: 1, enabled: available, run: withModel(openRelated) });
  ui.menuItem('Compare', { id: 'compareExamMarks', label: 'Exam Marks on Images', order: 2, enabled: available, run: () => setExamMarks(!examMarks) });
  ui.menuItem('Compare', { id: 'comparePrevPrior', label: 'Prev Prior Exam', order: 3, enabled: available, run: options => prior(-1, options) });
  ui.menuItem('Compare', { id: 'compareNextPrior', label: 'Next Prior Exam', order: 4, enabled: available, run: options => prior(1, options) });
  ui.menuItem('Compare', { id: 'compareManualSync', label: 'Manual Sync…', order: 5, run: withModel(openManualSync) });
  ui.menuItem('Compare', { id: 'compareScout', label: 'Scout Navigation', order: 6, run: withModel(openScout) });
  ui.menuItem('Compare', { id: 'compareMatchZoom', label: 'Match Zoom', order: 7, run: matchZoom });
  ui.menuItem('Compare', { id: 'compareMatchRatio', label: 'Match Ratio…', order: 8, run: withModel(openMatchRatio) });
  ui.toolbarButton({ id: 'comparePrevPriorButton', label: '‹ Prior', title: 'Prev Prior Exam', order: 1, run: options => prior(-1, options) });
  ui.toolbarButton({ id: 'compareNextPriorButton', label: 'Prior ›', title: 'Next Prior Exam', order: 2, run: options => prior(1, options) });

  const changed = () => { if (ended) return; bind(); scheduleMarks(); checkRatio(); };
  // Cells given other images: openings watching them end, and a matched cell is no longer matched.
  const imagesChanged = ids => {
    touched(ids);
    if (ratio && (!ids || ids.some(id => id === ratio.reference || ratio.cells.has(id)))) { clearBadges('ratio'); ratio = null; }
    changed();
  };
  listen(grid, grid.EVENTS?.GRID_STATE_CHANGED, event =>
    imagesChanged(Array.isArray(event?.viewports) ? [...event.viewports.map(view => view?.viewportId), ...(event.removedViewportIds || [])].filter(Boolean) : null));
  listen(cellService, cellService.EVENTS?.VIEWPORT_DATA_CHANGED, event => imagesChanged(event?.viewportId ? [event.viewportId] : null));
  on(document, events().CAMERA_MODIFIED, () => { if (ratio) { cancelAnimationFrame(ratioFrame); ratioFrame = requestAnimationFrame(checkRatio); } }, true);
  on(document, events().STACK_NEW_IMAGE, moved, true);

  return () => {
    ended = true; clearTimeout(marksTimer); markRequest?.abort(); cancelAnimationFrame(ratioFrame); opening?.abort();
    for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (error) { console.error(error); }
    for (const dispose of disposers) dispose();
    if (window.kinViewerExamMark === examMark) delete window.kinViewerExamMark;
    group.members = []; bound.clear();
    if (window.kinManualSync === manualApi) delete window.kinManualSync;
    for (const { node } of badges.values()) node.remove();
    badges.clear(); style.remove();
  };
});
