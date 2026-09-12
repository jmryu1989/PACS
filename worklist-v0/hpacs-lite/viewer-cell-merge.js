/* Session-only cell merge / maximize for the fixed viewer grid.
   The native grid already renders per-position fractional rectangles through
   setLayout({layoutOptions}); this module only decides which rectangles to ask for,
   records what was on screen first, and refuses whatever it cannot put back. */
(function (root) {
  'use strict';
  const BASES = [[1, 2], [2, 1], [2, 2]];
  const CAMERA_KEYS = ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'parallelScale', 'flipHorizontal', 'flipVertical'];
  const near = (a, b) => Math.abs(a - b) <= 1e-6;
  const copy = value => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
  const rect = (x, y, width, height) => ({ x, y, width, height });

  // Rectangles per operation, in native position order (position = col + row*numCols).
  // `merged` is the slot that keeps the anchor cell's source.
  function shape(op, side) {
    if (op === 'maximize') return { options: [rect(0, 0, 1, 1)], merged: 0 };
    if (op === 'merge-column') {
      return side === 0
        ? { options: [rect(0, 0, .5, 1), rect(.5, 0, .5, .5), rect(.5, .5, .5, .5)], merged: 0 }
        : { options: [rect(0, 0, .5, .5), rect(.5, 0, .5, 1), rect(0, .5, .5, .5)], merged: 1 };
    }
    if (op === 'merge-row') {
      return side === 0
        ? { options: [rect(0, 0, 1, .5), rect(0, .5, .5, .5), rect(.5, .5, .5, .5)], merged: 0 }
        : { options: [rect(0, 0, .5, .5), rect(.5, 0, .5, .5), rect(0, .5, 1, .5)], merged: 2 };
    }
    return null;
  }

  // A cell is {viewportId,x,y,width,height,sets,kind}; kind is 'stack' for a loaded
  // classic stack and 'empty' for a cell with no source. Anything else refuses whole.
  function plan(request) {
    const { rows, cols, cells, anchorId, op } = request || {};
    if (!BASES.some(([r, c]) => r === rows && c === cols) || !Array.isArray(cells) || cells.length !== rows * cols)
      return { ok: false, reason: '1·2·4화면의 일반 CT 격자에서만 셀을 병합할 수 있습니다.' };
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      if (!cell || typeof cell.viewportId !== 'string' || !cell.viewportId) return { ok: false, reason: '화면 구성을 확인할 수 없습니다.' };
      if (!near(cell.x, (index % cols) / cols) || !near(cell.y, Math.floor(index / cols) / rows) ||
          !near(cell.width, 1 / cols) || !near(cell.height, 1 / rows))
        return { ok: false, reason: '이미 병합되었거나 특수한 배치입니다. 먼저 Restore Grid로 격자를 되돌리세요.' };
      if (!['stack', 'empty'].includes(cell.kind))
        return { ok: false, reason: 'MPR·3D·SR·PDF 화면이나 아직 불러오지 못한 칸이 있어 병합하지 않았습니다. 일반 CT 격자에서 사용하세요.' };
    }
    if (new Set(cells.map(cell => cell.viewportId)).size !== cells.length) return { ok: false, reason: '화면 구성을 확인할 수 없습니다.' };
    const anchorIndex = cells.findIndex(cell => cell.viewportId === anchorId);
    if (anchorIndex < 0) return { ok: false, reason: '확대할 칸을 먼저 선택하세요.' };
    if (!['maximize', 'merge-column', 'merge-row'].includes(op)) return { ok: false, reason: '지원하지 않는 병합입니다.' };
    if (op !== 'maximize' && (rows !== 2 || cols !== 2)) return { ok: false, reason: '열·행 병합은 2×2 배치에서만 사용할 수 있습니다.' };
    const column = anchorIndex % cols, row = Math.floor(anchorIndex / cols);
    const block = op === 'maximize' ? cells.slice()
      : cells.filter((_, index) => (op === 'merge-column' ? index % cols === column : Math.floor(index / cols) === row));
    // Only the cell that survives the merge has to carry an image; an empty cell in the
    // block is recorded as empty and comes back empty, which loses nothing.
    if (cells[anchorIndex].kind !== 'stack')
      return { ok: false, reason: '영상이 표시된 일반 CT 칸을 선택한 뒤 병합하세요.' };
    const { options, merged } = shape(op, op === 'maximize' ? 0 : op === 'merge-column' ? column : row);
    const survivors = cells.filter(cell => !block.includes(cell));
    if (survivors.length !== options.length - 1) return { ok: false, reason: '화면 구성을 확인할 수 없습니다.' };
    const slots = [];
    for (let index = 0, next = 0; index < options.length; index++)
      slots.push(index === merged ? cells[anchorIndex] : survivors[next++]);
    return { ok: true, op, rows, cols, anchorId, merged, layoutOptions: options.map(copy), slots,
      displaced: block.filter(cell => cell.viewportId !== anchorId).map(cell => cell.viewportId) };
  }

  const sameCameraKeys = (a, b, keys) => !!a && !!b && keys.every(key => Array.isArray(a[key])
    ? Array.isArray(b[key]) && a[key].length === b[key].length && a[key].every((value, index) => Math.abs(value - b[key][index]) < 1e-6)
    : typeof a[key] === 'number' ? Math.abs(a[key] - b[key]) < 1e-6 : a[key] === b[key]);
  const sameCamera = (a, b) => sameCameraKeys(a, b, CAMERA_KEYS);
  // A camera is not one decision. Scrolling a stack moves focalPoint and position along
  // the normal, so comparing the camera whole would read every slice change as a zoom the
  // user made and hand back the merge's own refit with it. Zoom, where the camera sits and
  // how it is oriented are judged separately; the last group is the remainder by
  // construction, so every key stays covered exactly once.
  const CAMERA_ZOOM = ['parallelScale'], CAMERA_PLACE = ['focalPoint', 'position'];
  const CAMERA_GROUPS = [CAMERA_ZOOM, CAMERA_PLACE,
    CAMERA_KEYS.filter(key => !CAMERA_ZOOM.includes(key) && !CAMERA_PLACE.includes(key))];

  function create(services, options = {}) {
    const doc = options.doc || root.document, win = options.root || doc?.defaultView || root;
    const grid = services?.viewportGridService, cornerstone = services?.cornerstoneViewportService, sets = services?.displaySetService;
    const live = () => !ended && options.live?.() !== false;
    let ended = false, busy = false, quarantined = false, record = null, panel = null, status = null, hint = null;
    const subscriptions = []; let listening = false, channel = null;

    const ordered = () => [...(grid?.getState?.().viewports?.values?.() || [])]
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0) || String(a.viewportId).localeCompare(String(b.viewportId)));
    const viewportOf = id => { try { return cornerstone?.getCornerstoneViewport?.(id) || null; } catch (_) { return null; } };
    function note(message) { if (status && message) status.textContent = message; return message; }

    function cameraOf(viewport) {
      try {
        const camera = viewport?.getCamera?.(); if (!camera) return null; const value = {};
        for (const key of CAMERA_KEYS) {
          const part = camera[key];
          if (key === 'parallelScale') { if (!Number.isFinite(part)) return null; value[key] = part; continue; }
          if (key === 'flipHorizontal' || key === 'flipVertical') { value[key] = !!part; continue; }
          if (!Array.isArray(part) || part.length !== 3 || !part.every(Number.isFinite)) return null;
          value[key] = [...part];
        }
        return value;
      } catch (_) { return null; }
    }

    // One cell as this module needs it. Anything it cannot read becomes an unknown
    // kind, which refuses the whole operation before anything is dispatched.
    function cellOf(view) {
      const ids = [...(view.displaySetInstanceUIDs || [])], viewport = viewportOf(view.viewportId);
      const base = { viewportId: view.viewportId, x: view.x, y: view.y, width: view.width, height: view.height, sets: ids,
        optionsId: view.viewportOptions?.id ?? null, toolGroupId: view.viewportOptions?.toolGroupId ?? null,
        camera: null, voiRange: null, invert: null, imageId: null, imageIndex: null };
      let imageId = null, imageIndex = null, properties = null;
      try {
        imageId = viewport?.getCurrentImageId?.() || null;
        imageIndex = viewport?.getCurrentImageIdIndex?.() ?? null;
        properties = viewport?.getProperties?.() || null;
      } catch (_) { return { ...base, kind: 'unreadable' }; }
      if (!ids.length && !imageId) return { ...base, kind: 'empty' };
      const camera = cameraOf(viewport);
      if (ids.length !== 1 || viewport?.type !== 'stack' || !imageId || !camera || !sets?.getDisplaySetByUID?.(ids[0])) return { ...base, kind: 'unreadable' };
      return { ...base, kind: 'stack', camera, voiRange: properties?.voiRange ? copy(properties.voiRange) : null,
        invert: properties?.invert ?? null, imageId, imageIndex };
    }

    // Layout identity only: which sources sit in which rectangles. Scrolling, W/L and
    // the active cell are the user's own work and must not invalidate a merge record.
    function layoutSignature() {
      const state = grid?.getState?.(), layout = state?.layout || {};
      return JSON.stringify([layout.layoutType, layout.numRows, layout.numCols,
        ordered().map(view => [view.viewportId, view.x, view.y, view.width, view.height, [...(view.displaySetInstanceUIDs || [])]])]);
    }

    // Every reason the screen must not be rebuilt right now. All of them refuse before
    // any dispatch, so a refusal never changes what the user is looking at.
    function blocked() {
      if (!live()) return '영상 세션이 변경되었습니다. 뷰어를 다시 여세요.';
      if (quarantined) return '이전 배치 요청의 완료를 확인하지 못했습니다. 현재 영상을 확인하고 뷰어 창을 닫은 뒤 다시 열어 주세요.';
      if (busy) return '이전 배치 요청이 끝난 뒤 다시 시도하세요.';
      try { if (doc.fullscreenElement) return '전체 화면을 종료한 뒤 칸 배치를 바꾸세요.'; } catch (_) { }
      try { if (doc.querySelector?.('dialog[open],[role="dialog"][aria-modal="true"],.modal.show')) return '열린 대화상자를 닫은 뒤 다시 시도하세요.'; } catch (_) { }
      try {
        const cines = services?.cineService?.getState?.()?.cines || {};
        if (Object.values(cines).some(value => value?.isPlaying)) return 'Cine 재생을 멈춘 뒤 칸 배치를 바꾸세요.';
      } catch (_) { return '영상 재생 상태를 확인할 수 없습니다.'; }
      // Only work that is in flight blocks a merge. An unsaved measurement does NOT:
      // merge changes geometry, never removes an annotation and never replaces a source,
      // and reading with a drawn measurement on screen is exactly when a clinician
      // enlarges a cell. Hanging Protocol Apply keeps its stricter guard because it
      // replaces the sources themselves.
      for (const name of ['kinViewerJobWorkspaceState', 'kinViewerHistoryWorkspaceState']) {
        try {
          const value = typeof win[name] === 'function' ? win[name]() : null;
          if (value?.busy) return '저장 또는 영상 작업이 끝난 뒤 다시 시도하세요.';
        } catch (_) { return '영상 작업 상태를 확인할 수 없습니다.'; }
      }
      return null;
    }

    function snapshot() {
      const state = grid?.getState?.(), layout = state?.layout || {}, views = ordered();
      const rows = layout.numRows, cols = layout.numCols;
      if (layout.layoutType !== 'grid' || !Number.isInteger(rows) || !Number.isInteger(cols) || views.length !== rows * cols) return null;
      return { rows, cols, active: state.activeViewportId, cells: views.map(cellOf), signature: layoutSignature() };
    }

    const requestFor = cell => ({
      displaySetInstanceUIDs: [...cell.sets], displaySetOptions: [{}],
      viewportOptions: { viewportId: cell.viewportId, ...(cell.optionsId ? { id: cell.optionsId } : {}),
        viewportType: 'stack', toolGroupId: cell.toolGroupId || 'default', allowUnmatchedView: true } });

    function boundedNative(promise, timeout) {
      const task = Promise.resolve(promise); task.catch(() => { });
      return new Promise((resolve, reject) => {
        let settled = false, timer = null;
        const finish = (fn, value) => { if (settled) return; settled = true; if (timer !== null) win.clearTimeout(timer); fn(value); };
        task.then(value => finish(resolve, value), error => finish(reject, error));
        if (timeout > 0 && !settled) timer = win.setTimeout(() => finish(reject, Error('Native layout timeout')), timeout);
      });
    }
    const pause = () => new Promise(resolve => win.setTimeout(resolve, 25));

    // The achieved geometry, not the resolved promise, decides success.
    function geometryIs(expected) {
      const state = grid?.getState?.(), layout = state?.layout || {}, views = ordered();
      const wanted = expected.cells.slice().sort((a, b) => a.y - b.y || a.x - b.x || String(a.viewportId).localeCompare(String(b.viewportId)));
      return layout.numRows === expected.rows && layout.numCols === expected.cols && views.length === wanted.length &&
        views.every((view, index) => view.viewportId === wanted[index].viewportId &&
          JSON.stringify([...(view.displaySetInstanceUIDs || [])]) === JSON.stringify(wanted[index].sets) &&
          near(view.x, wanted[index].x) && near(view.y, wanted[index].y) &&
          near(view.width, wanted[index].width) && near(view.height, wanted[index].height));
    }

    // A rebuilt grid is only a restoration when every expected source is back with the
    // image, window and camera it is owed. Cells that stayed on screen are owed their
    // newest state, cells this module removed are owed the recorded one.
    function restored(target) {
      if (!geometryIs(target)) return false;
      return target.cells.every(cell => {
        if (cell.kind !== 'stack') return true;
        const viewport = viewportOf(cell.viewportId); if (viewport?.type !== 'stack') return false;
        let properties = null, imageId = null;
        try { properties = viewport.getProperties?.() || null; imageId = viewport.getCurrentImageId?.() || null; } catch (_) { return false; }
        return imageId === cell.imageId && sameCamera(cameraOf(viewport), cell.camera) &&
          JSON.stringify(properties?.voiRange ?? null) === JSON.stringify(cell.voiRange) &&
          (properties?.invert ?? null) === cell.invert;
      });
    }

    // Native restores camera and W/L from its own presentation cache; where it did not,
    // the owed values are put back explicitly instead of being reported as restored.
    function reapply(target) {
      for (const cell of target.cells) {
        if (cell.kind !== 'stack') continue;
        const viewport = viewportOf(cell.viewportId); if (viewport?.type !== 'stack') continue;
        try {
          if (Number.isInteger(cell.imageIndex) && viewport.getCurrentImageId?.() !== cell.imageId && typeof viewport.setImageIdIndex === 'function')
            Promise.resolve(viewport.setImageIdIndex(cell.imageIndex)).catch(() => { });
          const properties = viewport.getProperties?.() || {};
          if (cell.voiRange && JSON.stringify(properties.voiRange ?? null) !== JSON.stringify(cell.voiRange))
            viewport.setVOI?.(copy(cell.voiRange), { forceRecreateLUTFunction: true, voiUpdatedWithSetProperties: true });
          if (cell.invert !== null && (properties.invert ?? null) !== cell.invert) viewport.setProperties?.({ invert: cell.invert });
          if (cell.camera && !sameCamera(cameraOf(viewport), cell.camera)) {
            const camera = copy(cell.camera);
            viewport.setCamera?.({ flipHorizontal: camera.flipHorizontal, flipVertical: camera.flipVertical });
            delete camera.flipHorizontal; delete camera.flipVertical;
            viewport.setCamera?.(camera);
          }
          viewport.render?.();
        } catch (_) { }
      }
    }

    const dispatch = (rows, cols, layoutOptions, cells, active) => grid.setLayout({
      numRows: rows, numCols: cols, activeViewportId: active, isHangingProtocolLayout: false,
      ...(layoutOptions ? { layoutOptions: layoutOptions.map(copy) } : {}),
      findOrCreateViewport: index => requestFor(cells[index]) });

    async function settle(check, deadline) {
      for (let count = 0; count < 120 && Date.now() < deadline; count++) { if (check()) return true; await pause(); }
      return check();
    }

    const sameState = (a, b) => !!a && !!b && sameCamera(a.camera, b.camera) && a.imageId === b.imageId &&
      JSON.stringify(a.voiRange ?? null) === JSON.stringify(b.voiRange ?? null) && (a.invert ?? null) === (b.invert ?? null);

    // The native viewport refits its camera when a pane changes shape, on its own resize
    // observer, and that refit is not reversible by resizing back. Nothing may be recorded
    // or re-applied before it has settled, so this waits for two identical readings and
    // never accepts the first ones.
    async function settledState(minimum = 4) {
      let previous = null;
      for (let count = 0; count < 32; count++) {
        const current = new Map(ordered().map(view => [view.viewportId, cellOf(view)]));
        if (count >= minimum && previous && previous.size === current.size &&
            [...current].every(([id, cell]) => cell.kind !== 'stack' || sameState(cell, previous.get(id)))) return current;
        previous = current;
        await pause();
      }
      return previous;
    }

    // What unmerge owes each recorded cell, decided one field at a time against `after`,
    // the reading taken once the merge had settled. A field that still holds what the
    // merge itself produced - including the native refit - is owed the pre-merge value;
    // only a field the user has actually moved since then keeps its newest value. Judging
    // the four fields as one unit would let a single scroll hand the whole cell its refit
    // camera back as if the user had zoomed. A cell this module removed, one whose source
    // changed, or one with no trustworthy post-merge reading is owed the record whole,
    // because nothing about it can be attributed to the user.
    function unmergeTarget(base, after, input) {
      const present = new Map(ordered().map(view => [view.viewportId, cellOf(view)]));
      const sameVoi = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const touched = input?.touched || null, interacted = !!input?.interacted;
      let ambiguous = false;
      const cells = base.cells.map(cell => {
        const current = present.get(cell.viewportId), merged = after?.get(cell.viewportId);
        if (!current || current.kind !== 'stack' || JSON.stringify(current.sets) !== JSON.stringify(cell.sets)) return cell;
        if (!merged || merged.kind !== 'stack' || cell.kind !== 'stack') return cell;
        const atInput = touched?.get(cell.viewportId);
        const placed = !interacted || (!!atInput && atInput.kind === 'stack');
        // One field, decided on evidence. A value the user moved after the merge settled is
        // theirs. A value that is identical in the settled reading but was different at the
        // instant their input arrived was changed by that input and is theirs as well, so
        // `after` never folds their edit into this module's own baseline. Only a value with
        // no user input behind it is owed the pre-merge record. Where an input happened but
        // could not be placed on the screen, the newer value is kept and the restore says so:
        // an unattributable value is never silently reverted.
        const decide = (untouched, steady, recorded, actual, unchanged) => {
          if (!untouched || steady === false) return actual;
          if (placed || unchanged) return recorded;
          ambiguous = true; return actual;
        };
        // imageId and imageIndex are one decision: an index without the image it belongs
        // to would scroll the cell to a slice the user never asked for.
        const scrolled = current.imageId !== merged.imageId;
        const image = decide(!scrolled, atInput ? atInput.imageId === merged.imageId : null,
          cell, current, current.imageId === cell.imageId);
        const camera = {};
        for (const keys of CAMERA_GROUPS) {
          const owed = decide(sameCameraKeys(current.camera, merged.camera, keys),
            atInput?.camera ? sameCameraKeys(atInput.camera, merged.camera, keys) : null,
            cell.camera, current.camera, sameCameraKeys(current.camera, cell.camera, keys));
          for (const key of keys) camera[key] = owed[key];
        }
        return { ...cell, camera,
          voiRange: decide(sameVoi(current.voiRange, merged.voiRange), atInput ? sameVoi(atInput.voiRange, merged.voiRange) : null,
            cell.voiRange, current.voiRange, sameVoi(current.voiRange, cell.voiRange)),
          invert: decide((current.invert ?? null) === (merged.invert ?? null), atInput ? (atInput.invert ?? null) === (merged.invert ?? null) : null,
            cell.invert, current.invert, (current.invert ?? null) === (cell.invert ?? null)),
          imageId: image.imageId, imageIndex: image.imageIndex };
      });
      return { rows: base.rows, cols: base.cols, active: base.active, cells, ambiguous };
    }

    // A screen this module is still allowed to rebuild. Its own dispatch can only ever
    // leave the viewports and the sources it started from, inside the grid it started from;
    // which rectangles native chose, and how many of the cells it kept, is native's answer
    // and may deviate - that deviation is this module's own doing and is rolled back.
    // A viewport or a source that was never in the record belongs to another operation -
    // a Hanging Protocol Apply or a Load Job that landed while this merge was settling -
    // whose provenance cannot be established from here, so it is never rebuilt over.
    function ours(base) {
      const layout = grid?.getState?.()?.layout || {}, views = ordered();
      if (layout.numRows !== base.rows || layout.numCols !== base.cols) return false;
      if (!views.length || views.length > base.cells.length) return false;
      const known = new Map(base.cells.map(cell => [cell.viewportId, JSON.stringify(cell.sets)]));
      return views.every(view => {
        const sets = [...(view.displaySetInstanceUIDs || [])], recorded = known.get(view.viewportId);
        // A cell that is momentarily carrying nothing is native still building this module's
        // own request; an unknown viewport, or a source that was never in the record, is not.
        return recorded !== undefined && (!sets.length || recorded === JSON.stringify(sets));
      });
    }

    // Rollback runs only while this module still owns the screen: a user who already
    // moved on, or another panel that has put its own work there, must never have it
    // overwritten by our restore.
    async function rebuild(target, owned) {
      if (!owned()) return false;
      try { await boundedNative(dispatch(target.rows, target.cols, null, target.cells, target.active), 2000); } catch (_) { }
      const deadline = Date.now() + 5000;
      let confirmed = 0;
      while (Date.now() < deadline) {
        if (!owned()) return false;
        if (!geometryIs(target)) { confirmed = 0; await pause(); continue; }
        // Re-applying into an ongoing native refit only loses the value again, and a late
        // refit could undo an accepted restore, so each decision is taken on a settled
        // screen and the restore must hold twice.
        await settledState();
        if (!owned()) return false;
        if (restored(target)) { if (++confirmed >= 2) return true; }
        else { confirmed = 0; reapply(target); }
      }
      return false;
    }

    function quarantine(message) {
      quarantined = true; record = null; refresh();
      return note(message || '배치 요청 또는 복원 완료를 확인하지 못했습니다. 현재 영상을 확인하고 뷰어 창을 닫은 뒤 다시 열어 주세요.');
    }
    const FOREIGN = '병합을 확인하는 동안 다른 기능이 화면을 바꾸어, 이전 배치로 되돌리지 않고 지금 화면을 그대로 두었습니다. 화면을 확인한 뒤 뷰어 창을 닫고 다시 열어 주세요.';

    // `capture` reads the screen at the instant the first input arrives, in the capture
    // phase, before any tool has acted on it. A value that is identical in that reading and
    // in the settled one cannot be that input's work, which is how a user edit made inside
    // the settling wait is told apart from the merge's own refit later on.
    function watchInteraction(capture) {
      let interacted = false, armed = false, touched = null;
      const handler = () => {
        if (!armed || interacted) return;
        interacted = true;
        if (capture) try { touched = new Map(ordered().map(view => [view.viewportId, cellOf(view)])); } catch (_) { touched = null; }
      };
      for (const type of ['pointerdown', 'wheel', 'keydown']) doc.addEventListener(type, handler, true);
      queueMicrotask(() => { armed = true; });
      return { owned: () => !interacted && !ended && live(), input: () => ({ interacted, touched }),
        release: () => { for (const type of ['pointerdown', 'wheel', 'keydown']) doc.removeEventListener(type, handler, true); } };
    }

    async function run(op, anchorId) {
      const reason = blocked(); if (reason) return { ok: false, message: note(reason) };
      const base = snapshot();
      if (!base) return { ok: false, message: note(record
        ? '이미 병합된 화면입니다. 먼저 Restore Grid로 격자를 되돌리세요.'
        : '1·2·4화면의 일반 CT 격자에서만 셀을 병합할 수 있습니다.') };
      const anchor = anchorId || base.active;
      const result = plan({ rows: base.rows, cols: base.cols, cells: base.cells, anchorId: anchor, op });
      if (!result.ok) return { ok: false, message: note(result.reason) };
      const expected = { rows: base.rows, cols: base.cols,
        cells: result.slots.map((cell, index) => ({ viewportId: cell.viewportId, sets: cell.sets, ...result.layoutOptions[index] })) };
      const watch = watchInteraction(true);
      const owned = () => watch.owned() && ours(base);
      // The rollback is owed `base` itself, not a fresh reading of the screen: it runs only
      // while nothing else has touched the screen, so every difference on it - the refit
      // this failed merge caused above all - is self-inflicted and must not be adopted as
      // the state the user is owed. When the screen is no longer this module's, nothing is
      // dispatched at all: another panel's newer work is left exactly where it is.
      const rollback = async message => {
        if (!watch.owned()) return { ok: false, message: quarantine() };
        if (!ours(base)) return { ok: false, message: quarantine(FOREIGN) };
        return await rebuild(base, owned)
          ? { ok: false, message: note(message) }
          : { ok: false, message: quarantine() };
      };
      busy = true; refresh(); note('칸 배치를 적용하는 중…');
      try {
        const deadline = Date.now() + 4000;
        try { await boundedNative(dispatch(base.rows, base.cols, result.layoutOptions, result.slots, anchor), 2000); } catch (_) { }
        const achieved = await settle(() => geometryIs(expected), deadline);
        if (ended || !live()) return { ok: false, message: '' };
        if (achieved) {
          const after = await settledState();
          if (ended || !live()) return { ok: false, message: '' };
          // Waiting for the screen to settle is time in which another panel - Hanging
          // Protocol Apply, Load Job - can land a layout of its own. The signature read
          // after that wait would then describe their screen, and Restore Grid would
          // later rebuild the pre-merge grid over their work and call it a restore. The
          // requested geometry is confirmed once more, on the same synchronous reading
          // the signature is taken from, so a record only ever describes this merge.
          if (geometryIs(expected)) {
            record = { base, op, anchorId: anchor, after, input: watch.input(), signature: layoutSignature() };
            return { ok: true, op, message: note(op === 'maximize'
              ? '선택한 칸을 한 화면으로 확대했습니다. 다시 더블클릭하거나 Restore Grid로 이전 배치로 돌아갑니다.'
              : '선택한 칸을 병합했습니다. Restore Grid로 이전 배치로 돌아갑니다. 병합 화면은 저장할 수 없습니다.') };
          }
        }
        return await rollback('요청한 칸 배치를 확인하지 못해 이전 배치로 복구했습니다.');
      } catch (_) {
        return await rollback('칸 배치에 실패해 이전 배치로 복구했습니다.');
      } finally { watch.release(); busy = false; refresh(); }
    }

    async function unmerge() {
      const reason = blocked(); if (reason) return { ok: false, message: note(reason) };
      if (!record) return { ok: false, message: note('되돌릴 병합 기록이 없습니다.') };
      if (layoutSignature() !== record.signature) {
        record = null; refresh();
        return { ok: false, message: note('화면 또는 원본이 변경되어 병합 기록을 지웠습니다. 현재 화면은 유지됩니다.') };
      }
      const target = unmergeTarget(record.base, record.after, record.input), watch = watchInteraction();
      busy = true; refresh(); note('이전 배치로 되돌리는 중…');
      try {
        const back = await rebuild(target, () => watch.owned() && ours(target));
        if (ended || !live()) return { ok: false, message: '' };
        if (back) {
          record = null;
          return { ok: true, message: note(target.ambiguous
            ? '이전 칸 배치로 되돌렸습니다. 병합 중 조작한 영상 상태는 확인되지 않아 되돌리지 않고 그대로 두었습니다.'
            : '이전 칸 배치와 영상 상태로 되돌렸습니다.') };
        }
        return { ok: false, message: quarantine() };
      } finally { watch.release(); busy = false; refresh(); }
    }

    // A double click a native tool consumed never reaches document: the pinned
    // cornerstoneTools listeners call stopImmediatePropagation on the element for both
    // tool-handled and drag-ignored double clicks, so this handler cannot double-handle
    // a measurement gesture. Images Only blocks the same event for 400ms after exit.
    function onDoubleClick(event) {
      if (ended || busy || event.defaultPrevented || event.button !== 0 || (event.detail || 0) < 2) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (!target || panel?.contains?.(target) || target.closest?.('#kin-viewer-layout,#kin-workspace-dock,dialog,[role="dialog"]')) return;
      const matches = ordered().filter(view => {
        const element = viewportOf(view.viewportId)?.element;
        return element?.isConnected && element.contains(target);
      });
      if (matches.length !== 1) return;
      if (record) { unmerge(); return; }
      run('maximize', matches[0].viewportId);
    }

    function refresh() {
      if (!panel) return;
      const reason = ended ? '세션이 종료되었습니다.' : quarantined ? '뷰어 창을 다시 열어 주세요.' : busy ? '요청 처리 중입니다.' : '';
      panel.querySelectorAll('button[data-cell-merge]').forEach(button => {
        const restore = button.dataset.cellMerge === 'restore';
        button.disabled = !!reason || (restore ? !record : !!record);
        button.title = reason || (restore ? '병합 전 격자와 영상 상태로 되돌립니다.' : '선택한 칸을 확대하거나 인접한 칸과 병합합니다.');
      });
      if (hint) hint.textContent = record
        ? '현재 병합 상태입니다. 병합 화면은 저장할 수 없으며 Restore Grid 후 저장할 수 있습니다.'
        : '영상 칸을 더블클릭하면 그 칸이 한 화면이 되고, 다시 더블클릭하면 이전 배치로 돌아갑니다.';
    }

    // Any layout or source change this module did not make invalidates the record, so a
    // stale record can never rebuild cells into a different screen.
    function observe() {
      if (ended || busy || !record) return;
      let current = null; try { current = layoutSignature(); } catch (_) { current = null; }
      if (current !== record.signature) {
        record = null; note('화면 또는 원본이 변경되어 병합 기록을 지웠습니다. 현재 화면은 유지됩니다.'); refresh();
      }
    }

    const sessionEnd = event => { if (event.key === 'kin-session-ended') stop(); };
    function stop() {
      if (ended) return; ended = true; record = null;
      subscriptions.splice(0).forEach(item => item?.unsubscribe?.());
      doc.removeEventListener('dblclick', onDoubleClick);
      channel?.close(); channel = null;
      if (listening) { win.removeEventListener?.('storage', sessionEnd); win.removeEventListener?.('pagehide', stop); listening = false; }
      panel?.remove(); panel = status = hint = null;
    }

    function mount(host = options.host || doc?.querySelector?.('#kin-viewer-layout')) {
      if (ended || panel || !host) return false;
      panel = doc.createElement('section'); panel.id = 'kin-cell-merge';
      panel.style.cssText = 'border-top:1px solid #657c9f;margin-top:8px;padding-top:8px';
      panel.innerHTML = '<strong>Cell Merge</strong>' +
        '<p>칸을 확대하거나 인접한 칸을 하나로 묶습니다. 이 뷰어 격자만 바뀌며 브라우저 전체 화면(Images Only)과는 다릅니다.</p>' +
        '<div><button type="button" data-cell-merge="maximize">Maximize Cell</button> ' +
        '<button type="button" data-cell-merge="merge-column">Merge Column</button> ' +
        '<button type="button" data-cell-merge="merge-row">Merge Row</button> ' +
        '<button type="button" data-cell-merge="restore">Restore Grid</button></div>' +
        '<p data-cell-merge-hint></p><p role="status"></p>';
      status = panel.querySelector('[role=status]'); hint = panel.querySelector('[data-cell-merge-hint]');
      host.append(panel);
      panel.querySelectorAll('button[data-cell-merge]').forEach(button => {
        button.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
        button.onclick = () => (button.dataset.cellMerge === 'restore' ? unmerge() : run(button.dataset.cellMerge));
      });
      for (const event of new Set(Object.values(grid?.EVENTS || {})))
        try { subscriptions.push(grid.subscribe(event, observe)); } catch (_) { }
      doc.addEventListener('dblclick', onDoubleClick);
      if (!listening) {
        listening = true;
        win.addEventListener?.('storage', sessionEnd); win.addEventListener?.('pagehide', stop);
        try { channel = new win.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') stop(); }; } catch (_) { }
      }
      refresh(); note('칸을 선택한 뒤 확대·병합하거나 영상 칸을 더블클릭하세요.');
      return true;
    }

    return { mount, stop, merge: run, unmerge,
      state: () => ({ merged: !!record, op: record?.op || null, busy, quarantined, ended }), refresh: observe };
  }

  const api = { create, plan, shape, sameCamera, BASES };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinViewerCellMerge = api;
})(typeof globalThis === 'object' ? globalThis : this);
