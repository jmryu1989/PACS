// Viewer feature module: Navigate menu. It registers through viewer-features.js.
//   Navigation Bar     a bar at the right edge of the active cell: drag or click it, or type a number and press Enter,
//                      to go to that image. Pressed again, the bar goes and the image stays.
//   Stack / Tile       a Stack | Tile switch in the cell; Tile lays the series out as a grid that fits the cell (the
//                      wheel moves it a row); a tile pressed is the image Stack then shows.
//   Folded / Unfolded  the same for a multi-frame image: Folded is one frame at a time (cine), Unfolded the frames as a grid.
//   Multi-frame Default…  (Viewer Settings) how a multi-frame image opens for each modality, saved in the account
//                      (features.multiframeDefault) and applied when such an image is put in a cell.
// The pure calculations are window.KinViewerNavigateModel.
window.KinViewerNavigateModel = (() => {
  const MIN_TILE = 96;
  const MODALITIES = ['XA', 'US', 'MR', 'NM', 'OT'];
  const DEFAULTS = { XA: 'folded', US: 'folded', MR: 'unfolded', NM: 'unfolded', OT: 'unfolded' };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  return {
    MIN_TILE, MODALITIES, DEFAULTS,
    // The image at a point of the bar (offset from its top over its length), and the bar position of an image (0 to 1).
    indexAt: (offset, length, total) => total > 1 && length > 0 ? clamp(Math.round(offset / length * (total - 1)), 0, total - 1) : 0,
    fraction: (index, total) => total > 1 ? clamp(index, 0, total - 1) / (total - 1) : 0,
    // A typed image number (1-based) as an index: past either end is the end; anything but digits is null.
    typed: (text, total) => total > 0 && /^\s*\d+\s*$/.test(String(text)) ? clamp(Number(text), 1, total) - 1 : null,
    // The grid in a cell: at most max × max, no tile under MIN_TILE pixels, and no more rows than the images need.
    grid(width, height, count, max) {
      let columns = clamp(Math.floor(width / MIN_TILE), 1, max), rows = clamp(Math.floor(height / MIN_TILE), 1, max);
      if (count > 0 && count < columns * rows) { columns = Math.min(columns, count); rows = Math.min(rows, Math.ceil(count / columns)); }
      return { columns, rows, size: columns * rows };
    },
    // The first tile: the current image, pulled back so the last page is full.
    first: (index, count, size) => clamp(index, 0, Math.max(0, count - size)),
    // The wheel moves the grid a row; the grid follows an image that moved out of it.
    scroll: (start, step, count, size) => clamp(start + step, 0, Math.max(0, count - size)),
    follow: (start, index, count, size) => clamp(index < start ? index : index >= start + size ? index - size + 1 : start, 0, Math.max(0, count - size)),
    // The stored table, with the defaults for anything missing or not understood.
    defaults(value) {
      const table = {};
      for (const modality of MODALITIES) {
        const mode = value && typeof value === 'object' ? value[modality] : undefined;
        table[modality] = mode === 'folded' || mode === 'unfolded' ? mode : DEFAULTS[modality];
      }
      return table;
    },
  };
})();

window.KinViewerFeatures?.module('navigate', ({ services, store, ui }) => {
  const model = window.KinViewerNavigateModel;
  const LIMITS = { tile: 3, unfolded: 4 };
  const cells = new Map(), seen = new Map();
  const abort = new AbortController();
  let defaults = model.defaults(store.get('multiframeDefault')), defaultsPanel = null;
  // The cell size changed (layout, window): a grid is laid out again for the new size.
  const resized = new ResizeObserver(() => { for (const cell of [...cells.values()]) if (cell.tiles) paint(cell.id); });

  const style = document.createElement('style');
  style.textContent = `
.kin-nav-bar{position:absolute;right:26px;top:40px;bottom:40px;width:44px;pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:4px;z-index:3}
.kin-nav-track{position:relative;flex:1;width:10px;background:#444;border-radius:5px;cursor:pointer;touch-action:none}
.kin-nav-track:focus-visible{outline:2px solid var(--kin-accent,#E8C547);outline-offset:2px}
.kin-nav-thumb{position:absolute;left:-5px;width:20px;height:14px;background:#E8C547;border-radius:3px;cursor:grab}
.kin-nav-bar input{width:40px;background:#000c;color:#E3E3E3;border:1px solid #777;font:11px sans-serif;text-align:center;-moz-appearance:textfield}
.kin-nav-bar input::-webkit-inner-spin-button{-webkit-appearance:none}
.kin-nav-bar small{color:#ddd;font:10px sans-serif;text-shadow:0 0 3px #000}
.kin-nav-switch{position:absolute;left:6px;top:30px;pointer-events:auto;display:flex;z-index:3}
.kin-nav-switch button{background:#000c;color:#ddd;border:1px solid #777;font:11px sans-serif;padding:1px 6px;cursor:pointer}
.kin-nav-switch button[aria-pressed=true]{border-color:#E8C547;color:#E8C547}
.kin-nav-tiles{position:absolute;inset:0;display:grid;gap:2px;background:#111;pointer-events:auto;z-index:1}
.kin-nav-tiles button{margin:0;padding:0;position:relative;background:#000;overflow:hidden;border:1px solid #333;cursor:pointer;min-width:0;min-height:0}
.kin-nav-tiles button[aria-current=true]{border:2px solid #E8C547}
.kin-nav-tiles canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
.kin-nav-tiles span{position:absolute;left:3px;bottom:2px;color:#ddd;font:11px sans-serif;text-shadow:0 0 3px #000}
.kin-nav-defaults table{border-collapse:collapse;margin:.5em 0}
.kin-nav-defaults th,.kin-nav-defaults td{padding:.2em .6em;text-align:left}`;
  document.head.append(style);

  // ── The cell: its viewport, images and where we are ──
  const viewport = id => { try { return services.cornerstoneViewportService?.getCornerstoneViewport(id) || null; } catch (_) { return null; } };
  const ids = v => { try { return v?.getImageIds?.() || []; } catch (_) { return []; } };
  // The pending target, as cine does: an image still loading is where the next move counts from.
  const index = v => { try { const n = v.getTargetImageIdIndex?.() ?? v.getCurrentImageIdIndex?.(); return Number.isInteger(n) ? n : 0; } catch (_) { return 0; } };
  const stack = v => v?.type === 'stack' && ids(v).length > 0;
  const instance = (v, imageId) => { try { return window.cornerstone?.metaData?.get('instance', imageId || v.getCurrentImageId?.() || ids(v)[0]) || {}; } catch (_) { return {}; } };
  const multiframe = v => Number(instance(v).NumberOfFrames) > 1;
  const modality = v => String(instance(v).Modality || '').trim().toUpperCase();
  const element = (tag, attributes = {}, parent) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== null) key === 'text' ? node.textContent = value : node.setAttribute(key, value);
    parent?.append(node); return node;
  };
  const laid = cell => cell.mode === 'tile' || cell.mode === 'unfolded';
  const cellOf = id => { if (!cells.has(id)) cells.set(id, { id, bar: null, kind: null, mode: null, start: null, tiles: null }); return cells.get(id); };

  // Cine in that cell stops before a move by hand and before the images are laid out.
  const cine = services.cineService;
  function stopCine(id) {
    try {
      if (!cine?.getState?.().cines?.[id]?.isPlaying) return;
      const v = viewport(id);
      if (v?.element) cine.stopClip?.(v.element, { viewportId: id });
      cine.setCine?.({ id, isPlaying: false });
    } catch (error) { console.error(error); }
  }
  function go(id, n) {
    const v = viewport(id), list = ids(v);
    if (!stack(v)) return;
    const imageIndex = Math.max(0, Math.min(list.length - 1, n));
    stopCine(id);
    try {
      clearTimeout(v.debouncedTimeout);
      Promise.resolve(window.cornerstone.utilities.jumpToSlice(v.element, { imageIndex, debounceLoading: true }))
        .then(() => refresh(id), () => refresh(id));
    } catch (_) { refresh(id); }
  }

  // The layer of a cell, made again when the viewer has drawn the cell anew.
  function layer(cell) {
    const v = viewport(cell.id), pane = v?.element?.closest?.('[data-cy=viewport-pane]') || v?.element?.parentElement || null;
    if (cell.layer?.isConnected && cell.layer.parentElement === pane) return cell.layer;
    cell.layer?.remove(); cell.layer = null; cell.barNode = cell.switchNode = cell.tiles = null;
    if (pane) { cell.layer = ui.cellLayer(cell.id); if (cell.layer) resized.observe(cell.layer); }
    return cell.layer;
  }
  function drop(cell) { cell.layer?.remove(); cells.delete(cell.id); }

  // ── Drawing a cell from its state ──
  // A cell between image sets (or showing a volume) draws nothing but keeps its bar for the next stack.
  function paint(id) {
    const cell = cells.get(id); if (!cell) return;
    if (!cell.bar && !cell.kind) { drop(cell); return; }
    const v = viewport(id), host = layer(cell); if (!host) return;
    host.hidden = !stack(v);
    if (host.hidden) return;
    paintBar(cell, v, host); paintSwitch(cell, host); paintTiles(cell, v, host);
    refresh(id);
  }

  function paintBar(cell, v, host) {
    if (!cell.bar) { cell.barNode?.remove(); cell.barNode = null; return; }
    if (cell.barNode?.parentElement === host) return;
    const bar = element('div', { class: 'kin-nav-bar', role: 'group', 'aria-label': 'Navigation Bar' }, host);
    const track = element('div', { class: 'kin-nav-track', role: 'slider', tabindex: '0', 'aria-label': 'Image Position', title: 'Drag or click to move to an image.' }, bar);
    const thumb = element('div', { class: 'kin-nav-thumb' }, track);
    const input = element('input', { type: 'number', min: '1', 'aria-label': 'Image Number', title: 'Enter an image number and press Enter.' }, bar);
    const total = element('small', {}, bar);
    cell.barNode = bar; Object.assign(cell, { track, thumb, input, total, editing: false });
    const jump = y => {
      const r = track.getBoundingClientRect(), count = ids(viewport(cell.id)).length;
      const n = model.indexAt(y - r.top, r.height, count);
      if (n !== cell.dragged) { cell.dragged = n; go(cell.id, n); }
    };
    track.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      cell.editing = false; if (document.activeElement === input) input.blur();
      track.focus({ preventScroll: true });
      try { track.setPointerCapture(event.pointerId); } catch (_) {}
      cell.dragged = null; jump(event.clientY);
      const move = m => jump(m.clientY);
      const end = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', end); track.removeEventListener('pointercancel', end); cell.dragged = null; };
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
    });
    track.addEventListener('keydown', event => {
      const count = ids(viewport(cell.id)).length, now = index(viewport(cell.id));
      const next = { ArrowUp: now - 1, ArrowDown: now + 1, PageUp: now - 10, PageDown: now + 10, Home: 0, End: count - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); event.stopPropagation(); go(cell.id, next);
    });
    // Typing replaces the number; it moves the image only on Enter.
    input.addEventListener('focus', () => { try { input.select(); } catch (_) {} });
    input.addEventListener('input', () => { cell.editing = true; });
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { cell.editing = false; refresh(cell.id); input.blur(); return; }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const n = model.typed(input.value, ids(viewport(cell.id)).length);
      cell.editing = false;
      if (n === null) refresh(cell.id); else { input.value = String(n + 1); go(cell.id, n); }
    });
    input.addEventListener('blur', () => { if (cell.editing) { cell.editing = false; refresh(cell.id); } });
  }

  function paintSwitch(cell, host) {
    if (!cell.kind) { cell.switchNode?.remove(); cell.switchNode = null; return; }
    if (cell.switchNode?.parentElement !== host || cell.switchNode.dataset.kind !== cell.kind) {
      cell.switchNode?.remove();
      const series = cell.kind === 'series';
      const node = element('div', { class: 'kin-nav-switch', role: 'group', 'aria-label': series ? 'Stack / Tile' : 'Folded / Unfolded' }, host);
      node.dataset.kind = cell.kind;
      for (const [mode, text] of series ? [['stack', 'Stack'], ['tile', 'Tile']] : [['folded', 'Folded (Cine)'], ['unfolded', 'Unfolded']]) {
        const button = element('button', { type: 'button', text }, node); button.dataset.mode = mode;
        button.addEventListener('click', event => { event.stopPropagation(); setMode(cell.id, mode); });
      }
      cell.switchNode = node;
    }
    for (const button of cell.switchNode.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === cell.mode));
  }

  function paintTiles(cell, v, host) {
    if (!laid(cell)) { cell.tiles?.remove(); cell.tiles = null; cell.start = null; return; }
    stopCine(cell.id);
    const list = ids(v), size = model.grid(host.clientWidth, host.clientHeight, list.length, LIMITS[cell.mode]);
    cell.start = model.first(cell.start ?? index(v), list.length, size.size);
    const key = [cell.mode, cell.start, size.columns, size.rows, host.clientWidth, host.clientHeight, list.length, list[0]].join('|');
    if (cell.tiles?.parentElement === host && cell.tiles.dataset.key === key) return;
    cell.tiles?.remove();
    const frames = cell.mode === 'unfolded';
    const tiles = element('div', { class: 'kin-nav-tiles', role: 'group', 'aria-label': frames ? 'Frames' : 'Series Tiles' }, host);
    tiles.dataset.key = key; cell.size = size;
    tiles.style.gridTemplateColumns = `repeat(${size.columns}, minmax(0, 1fr))`;
    tiles.style.gridTemplateRows = `repeat(${size.rows}, minmax(0, 1fr))`;
    const width = Math.max(1, Math.floor(host.clientWidth / size.columns)), height = Math.max(1, Math.floor(host.clientHeight / size.rows));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    for (let n = cell.start; n < Math.min(list.length, cell.start + size.size); n++) {
      const label = (frames ? 'Frame ' : 'Image ') + (n + 1);
      const tile = element('button', { type: 'button', 'aria-label': label }, tiles); tile.dataset.index = String(n);
      const canvas = element('canvas', {}, tile);
      canvas.width = Math.min(512, Math.round(width * ratio)); canvas.height = Math.min(512, Math.round(height * ratio));
      element('span', { text: label }, tile);
      tile.addEventListener('click', event => { event.stopPropagation(); mark(cell, n); go(cell.id, n); });
      try {
        const loading = window.cornerstone?.utilities?.loadImageToCanvas?.({ canvas, imageId: list[n], thumbnail: true });
        Promise.resolve(loading).catch(() => {});
      } catch (_) {}
    }
    tiles.addEventListener('wheel', event => {
      event.preventDefault(); event.stopPropagation();
      if (!event.deltaY) return;
      const count = ids(viewport(cell.id)).length;
      const next = model.scroll(cell.start, Math.sign(event.deltaY) * cell.size.columns, count, cell.size.size);
      if (next !== cell.start) { cell.start = next; cell.held = true; paint(cell.id); }
    }, { passive: false });
    cell.tiles = tiles;
  }
  function mark(cell, n) {
    for (const tile of cell.tiles?.children || []) tile.setAttribute('aria-current', String(Number(tile.dataset.index) === n));
  }

  // The bar, the switch and the highlighted tile follow the image now shown.
  function refresh(id) {
    const cell = cells.get(id); if (!cell?.layer) return;
    const v = viewport(id), count = ids(v).length, now = index(v);
    if (cell.barNode) {
      const f = model.fraction(now, count);
      cell.thumb.style.top = `calc(${f * 100}% - ${f * 14}px)`;
      cell.track.setAttribute('aria-valuemin', '1'); cell.track.setAttribute('aria-valuemax', String(count)); cell.track.setAttribute('aria-valuenow', String(now + 1));
      cell.input.max = String(count); cell.total.textContent = '/ ' + count;
      if (!cell.editing) cell.input.value = String(now + 1);
    }
    if (cell.tiles) {
      // An image moved out of the grid by the bar, the wheel on the image or cine: the grid follows it, unless the
      // grid itself was just scrolled with the wheel.
      if (!cell.held && (now < cell.start || now >= cell.start + cell.size.size)) { cell.start = model.follow(cell.start, now, count, cell.size.size); paint(id); return; }
      mark(cell, now);
    }
  }

  function setMode(id, mode) {
    const cell = cellOf(id);
    cell.mode = mode; cell.start = null; cell.held = false;
    paint(id);
  }

  // ── A new image set in a cell: Tile and Unfolded end; a multi-frame image opens as its modality's default ──
  function opened(id) {
    const v = viewport(id), list = ids(v), key = stack(v) ? list[0] + '|' + list.length : null;
    if (seen.get(id) === key) return false;
    seen.set(id, key);
    const cell = cells.get(id);
    if (cell) { cell.kind = cell.mode = null; cell.start = null; cell.held = false; }
    if (key && list.length > 1 && multiframe(v) && defaults[modality(v)] === 'unfolded') {
      Object.assign(cellOf(id), { kind: 'multiframe', mode: 'unfolded', start: null });
    }
    if (cells.has(id)) paint(id);
    return true;
  }
  const imageEvent = window.cornerstone?.Enums?.Events?.STACK_NEW_IMAGE || 'CORNERSTONE_STACK_NEW_IMAGE';
  document.addEventListener(imageEvent, event => {
    const id = event.detail?.viewportId; if (!id) return;
    if (!opened(id)) { const cell = cells.get(id); if (cell) { cell.held = false; refresh(id); } }
  }, { capture: true, signal: abort.signal });
  const subscriptions = [];
  const cellsService = services.cornerstoneViewportService;
  try {
    if (cellsService?.EVENTS?.VIEWPORT_DATA_CHANGED && typeof cellsService.subscribe === 'function')
      subscriptions.push(cellsService.subscribe(cellsService.EVENTS.VIEWPORT_DATA_CHANGED, event => { if (event?.viewportId) opened(event.viewportId); }));
  } catch (error) { console.error(error); }
  // Play pressed on a laid-out cell: the cell goes back to one image at a time, and plays there.
  try {
    if (cine?.EVENTS?.CINE_STATE_CHANGED && typeof cine.subscribe === 'function')
      subscriptions.push(cine.subscribe(cine.EVENTS.CINE_STATE_CHANGED, () => {
        for (const cell of [...cells.values()])
          if (laid(cell) && cine.getState?.().cines?.[cell.id]?.isPlaying) setMode(cell.id, cell.kind === 'multiframe' ? 'folded' : 'stack');
      }));
  } catch (error) { console.error(error); }

  // ── Menu ──
  const active = () => services.viewportGridService?.getActiveViewportId?.();
  const can = {
    bar: v => stack(v) && ids(v).length > 1,
    tile: v => stack(v) && ids(v).length > 1 && !multiframe(v),
    fold: v => stack(v) && ids(v).length > 1 && multiframe(v),
  };
  // The menu shows the switch at the mode the cell is in; pressed again it closes the switch and the cell is back to
  // one image at a time, at the image chosen (a multi-frame image opened Unfolded by its default closes the same way).
  function toggleSwitch(id, kind, resting) {
    const cell = cellOf(id);
    if (cell.kind === kind) { cell.kind = null; cell.mode = null; }
    else { cell.kind = kind; cell.mode = resting; }
    cell.start = null; cell.held = false;
    paint(id);
  }
  ui.menuItem('Navigate', { id: 'navigationBar', label: 'Navigation Bar', order: 1, enabled: () => can.bar(viewport(active())),
    run: ({ viewportId }) => {
      if (!can.bar(viewport(viewportId))) return;
      const cell = cellOf(viewportId); cell.bar = !cell.bar; paint(viewportId);
    } });
  ui.menuItem('Navigate', { id: 'stackTile', label: 'Stack / Tile', order: 2, enabled: () => can.tile(viewport(active())),
    run: ({ viewportId }) => { if (can.tile(viewport(viewportId))) toggleSwitch(viewportId, 'series', 'stack'); } });
  ui.menuItem('Navigate', { id: 'foldedUnfolded', label: 'Folded / Unfolded', order: 3, enabled: () => can.fold(viewport(active())),
    run: ({ viewportId }) => { if (can.fold(viewport(viewportId))) toggleSwitch(viewportId, 'multiframe', 'folded'); } });

  // ── Multi-frame Default… in Viewer Settings ──
  ui.setting({ id: 'multiframeDefault', kind: 'button', label: 'Multi-frame Default…', order: 1, run: () => openDefaults() });
  function openDefaults() {
    const panel = ui.panel({ id: 'multiframeDefault', title: 'Multi-frame Default' });
    if (!panel || panel.body.childElementCount) return panel;
    panel.element.classList.add('kin-nav-defaults');
    element('p', { text: '멀티프레임 영상을 모달리티마다 Folded (Cine: 한 프레임씩, 재생)나 Unfolded(프레임을 바둑판으로)로 엽니다. 바꾸면 계정에 저장되고, 그다음 여는 영상부터 적용됩니다.' }, panel.body);
    const table = element('table', {}, panel.body), head = element('tr', {}, element('thead', {}, table));
    element('th', { text: 'Modality', scope: 'col' }, head); element('th', { text: 'Open as', scope: 'col' }, head);
    const body = element('tbody', {}, table), selects = new Map();
    const status = element('p', { role: 'status' }, panel.body);
    let revision = panel.revision, saving = false, panelOpen = true;
    for (const name of model.MODALITIES) {
      const row = element('tr', {}, body);
      element('th', { text: name, scope: 'row' }, row);
      const select = element('select', { 'aria-label': name + ' Open as' }, element('td', {}, row));
      for (const [value, text] of [['folded', 'Folded (Cine)'], ['unfolded', 'Unfolded']]) element('option', { value, text }, select);
      select.value = defaults[name];
      select.addEventListener('change', async () => {
        if (saving) return;
        saving = true; for (const node of selects.values()) node.disabled = true;
        const table = Object.fromEntries([...selects].map(([key, node]) => [key, node.value]));
        status.textContent = '저장 중입니다…';
        // One save at a time: the five boxes wait while it saves. A refused save (another window saved, or the save
        // failed) reads the account again, shows what is stored and continues from that revision.
        const saved = await store.set('multiframeDefault', table, { revision });
        const read = !saved && await store.reload();
        if (saved || read) revision = store.revision();
        if (!panelOpen) return;
        saving = false; for (const node of selects.values()) node.disabled = false;
        show();
        status.textContent = saved ? (store.writable() ? '계정에 저장했습니다.' : '이 창에만 적용했습니다.')
          : read ? '저장하지 못해 계정에 저장된 값을 다시 읽었습니다. 다시 고르세요.' : '저장하지 못해 저장된 값으로 되돌렸습니다.';
      });
      selects.set(name, select);
    }
    const show = () => { for (const [name, select] of selects) select.value = defaults[name]; };
    defaultsPanel = { show };
    panel.onClose(() => { panelOpen = false; if (defaultsPanel?.show === show) defaultsPanel = null; });
    panel.focus();
    return panel;
  }
  store.subscribe('multiframeDefault', value => { defaults = model.defaults(value); defaultsPanel?.show(); });

  // Cells that already show a multi-frame image when the toolbar comes.
  try { for (const id of services.viewportGridService?.getState?.().viewports?.keys?.() || []) opened(id); } catch (_) {}

  return () => {
    abort.abort(); resized.disconnect();
    for (const subscription of subscriptions) try { subscription?.unsubscribe?.(); } catch (_) {}
    for (const cell of [...cells.values()]) drop(cell);
    style.remove();
  };
});
