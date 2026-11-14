// Viewer feature module: Monitors in Hanging Protocol. A Hanging Protocol rule may say, for each monitor (the n-th
// display from the left, as Viewer Windows > Detect Displays numbers them), how many of its cells that monitor shows
// (Images), whether the worklist belongs there, and where the thumbnail (series) strip and the toolbar stand on it.
// There is one viewer window; it covers one display or two side by side. When the rule is applied, the window is moved
// over its image monitors (only with the display permission the reader already gave), and its image area is split at
// the display edge: each monitor's part gets its own cells and its own rows. The worklist window is never moved (a
// browser does not move a window it did not open); the viewer reports whether it stands on its monitor.
// The pure part below (KinViewerMonitorPlan) turns a rule, the displays and the window into that split.
(function (root) {
  const THICKNESS = { toolbar: { across: 36, upright: 108 }, thumbs: { across: 66, upright: 156 } };
  const MIN_REGION = 200;
  const upright = side => side === 'left' || side === 'right';
  const finite = (...values) => values.every(Number.isFinite);

  // Displays (left to right, as KinViewerDisplayLayout.screens lists them) that this window covers, in its client px.
  // win: screenX/screenY/outerWidth/outerHeight/innerWidth/innerHeight; zoom: CSS px -> screen px, or null when unknown
  // (then only a plain window frame is accepted, as KinViewerDisplayLayout.seams does). Column: the image column's left
  // and right in client px. A part narrower than MIN_REGION (a window barely over the edge) is not a monitor's region.
  function regions(screens, win, zoom, column) {
    if (!win || !finite(win.screenX, win.screenY, win.outerWidth, win.outerHeight, win.innerWidth, win.innerHeight) || win.innerWidth <= 0) return [];
    let z = zoom;
    if (!(Number.isFinite(z) && z > 0)) { const plain = win.outerWidth - win.innerWidth; if (plain < 0 || plain > 40) return []; z = 1; }
    const frame = win.outerWidth - win.innerWidth * z;
    if (frame < -1 || frame > 80) return [];
    const side = Math.max(0, frame) / 2, left = win.screenX + side, top = win.screenY + (win.outerHeight - win.innerHeight * z) - side;
    const bottom = top + win.innerHeight * z, from = Math.max(0, column?.left ?? 0), to = Math.min(win.innerWidth, column?.right ?? win.innerWidth);
    const list = [];
    (screens || []).forEach((s, monitor) => {
      if (!s || !finite(s.left, s.top, s.width, s.height) || s.top >= bottom || s.top + s.height <= top) return;
      const a = Math.max(from, (s.left - left) / z), b = Math.min(to, (s.left + s.width - left) / z);
      if (b - a >= MIN_REGION) list.push({ monitor, left: Math.round(a * 100) / 100, right: Math.round(b * 100) / 100 });
    });
    return list.sort((x, y) => x.left - y.left);
  }

  // Where the window should stand for a rule: over its first image monitor, or that one and the next when both show
  // images and the two displays touch side by side (one window covers at most two displays, as Span Displays does). An
  // image monitor beyond the displays there are, or past those two, is listed as not applied.
  function target(monitors, screens) {
    const list = monitors?.list || [], images = list.map((m, i) => m.images !== 'none' ? i : -1).filter(i => i >= 0);
    const skipped = images.filter(i => i >= screens.length).map(monitor => ({ monitor, reason: 'no-display' }));
    const present = images.filter(i => i < screens.length);
    if (!present.length) return { monitors: [], rect: null, skipped };
    const first = present[0], next = present[1];
    const a = screens[first], b = next === first + 1 ? screens[next] : null;
    const touching = !!b && Math.abs(a.left + a.width - b.left) <= 2 && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) > 0;
    const covered = touching ? [first, next] : [first];
    for (const monitor of present) if (!covered.includes(monitor)) skipped.push({ monitor, reason: 'one-window' });
    const left = Math.min(...covered.map(i => screens[i].left)), top = Math.min(...covered.map(i => screens[i].top));
    const rect = { left, top, width: Math.max(...covered.map(i => screens[i].left + screens[i].width)) - left,
      height: Math.max(...covered.map(i => screens[i].top + screens[i].height)) - top };
    return { monitors: covered, rect, skipped: skipped.sort((x, y) => x.monitor - y.monitor) };
  }

  // The bands of one region's rows (the toolbar outside, the strip inside it, as Toolbar & Thumbnail Position places
  // them) and the image area left over, all in client px.
  function bands(box, rows) {
    const inset = { top: 0, right: 0, bottom: 0, left: 0 }, out = {};
    for (const row of ['toolbar', 'thumbs']) {
      const side = rows[row];
      if (!side) continue;
      const thick = THICKNESS[row][upright(side) ? 'upright' : 'across'];
      const left = box.left + inset.left, right = box.right - inset.right, top = box.top + inset.top, bottom = box.bottom - inset.bottom;
      // inset: the bands already taken on each edge of the region when this one is placed (for a stylesheet that keeps the
      // band on its edge when the window is resized), thick: its own thickness.
      out[row] = { side, left: side === 'right' ? right - thick : left, top: side === 'bottom' ? bottom - thick : top,
        width: upright(side) ? thick : right - left, height: upright(side) ? bottom - top : thick, inset: { ...inset }, thick };
      inset[side] += thick;
    }
    out.images = { left: box.left + inset.left, top: box.top + inset.top, right: box.right - inset.right, bottom: box.bottom - inset.bottom };
    return out;
  }

  // The split for a rule over the regions this window covers. model: KinHangingProtocolModel (monitorCells). column: the
  // image column (client px: left, top, right, bottom); grid: the native viewport grid's box (client px). Returns null
  // when no covered region shows images. Otherwise:
  //  rects / cells: one native position per entry, ordered top to bottom then left to right (the order the grid lists its
  //    viewports in); cells[i] is the rule cell shown there (an index into rule.layout.cells) or null for an empty one.
  //  numRows / numCols: a base grid with at least as many positions as rects.
  //  rows: { toolbar, thumbs } -> { original: band | null, copy: band | null } (band: client px + side + monitor).
  //  applied: the monitors shown; hidden: rule cells no applied monitor shows; toolbarKept: no applied monitor shows a
  //  toolbar, so it stays on top of the first one (Viewer Settings must stay reachable).
  function split(model, rule, covered, column, grid) {
    const list = rule?.monitors?.list;
    if (!list || !covered.length || !grid || !(grid.width > 0) || !(grid.height > 0)) return null;
    const dealt = model.monitorCells(rule).plan, byMonitor = new Map(dealt.map(entry => [entry.monitor, entry]));
    const parts = covered.map(region => ({ region, monitor: list[region.monitor], entry: byMonitor.get(region.monitor) || null }))
      .filter(part => part.monitor && part.entry);
    if (!parts.length) return null;
    const showing = row => parts.filter(part => part.monitor[row] !== 'none').map(part => ({ part, side: part.monitor[row] }));
    const toolbarKept = !showing('toolbar').length;
    const rows = { toolbar: toolbarKept ? [{ part: parts[0], side: 'top' }] : showing('toolbar'), thumbs: showing('thumbs') };
    const positions = [], placed = { toolbar: [], thumbs: [] };
    for (const part of parts) {
      const box = { left: part.region.left, right: part.region.right, top: column.top, bottom: column.bottom };
      const own = {};
      for (const row of ['toolbar', 'thumbs']) { const hit = rows[row].find(item => item.part === part); if (hit) own[row] = hit.side; }
      const b = bands(box, own), span = column.right - column.left;
      // The region's edges as fractions of the column's width.
      const from = (part.region.left - column.left) / span, to = (part.region.right - column.left) / span;
      for (const row of ['toolbar', 'thumbs']) if (b[row]) placed[row].push({ ...b[row], monitor: part.region.monitor, from, to });
      const { rows: r, cols: c, cells } = part.entry, area = b.images, w = (area.right - area.left) / c, h = (area.bottom - area.top) / r;
      cells.forEach((cell, index) => {
        const col = index % c, line = Math.floor(index / c);
        positions.push({ cell, left: area.left + col * w, top: area.top + line * h, width: w, height: h });
      });
    }
    const round = v => Math.round(v * 1e6) / 1e6;
    const rects = positions.map(p => ({ cell: p.cell, x: round((p.left - grid.left) / grid.width), y: round((p.top - grid.top) / grid.height),
      width: round(p.width / grid.width), height: round(p.height / grid.height) }))
      .sort((a, b) => Math.abs(a.y - b.y) > 1e-6 ? a.y - b.y : a.x - b.x);
    const shown = new Set(rects.map(r => r.cell).filter(cell => cell !== null));
    const hidden = rule.layout.cells.map((_, index) => index).filter(index => !shown.has(index));
    return {
      rects: rects.map(({ x, y, width, height }) => ({ x, y, width, height })), cells: rects.map(r => r.cell),
      numRows: Math.max(...parts.map(part => part.entry.rows)), numCols: parts.reduce((sum, part) => sum + part.entry.cols, 0),
      rows: { toolbar: { original: placed.toolbar[0] || null, copy: placed.toolbar[1] || null }, thumbs: { original: placed.thumbs[0] || null, copy: placed.thumbs[1] || null } },
      applied: parts.map(part => part.region.monitor), hidden, toolbarKept,
    };
  }

  // Which monitor (index into screens) a window rectangle stands on: the display holding its centre.
  function monitorOf(screens, rect) {
    if (!rect || !finite(rect.left, rect.top, rect.width, rect.height)) return -1;
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    return (screens || []).findIndex(s => x >= s.left && x < s.left + s.width && y >= s.top && y < s.top + s.height);
  }

  // A layout of rectangles this module could have made: 1..8 positions inside the screen, none overlapping another.
  function validRects(rects) {
    if (!Array.isArray(rects) || rects.length < 1 || rects.length > 8) return false;
    const ok = rects.every(r => r && finite(r.x, r.y, r.width, r.height) && r.x >= -1e-6 && r.y >= -1e-6 && r.width > 0.02 && r.height > 0.02 &&
      r.x + r.width <= 1 + 1e-6 && r.y + r.height <= 1 + 1e-6);
    if (!ok) return false;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w > 1e-4 && h > 1e-4) return false;
    }
    return true;
  }

  // The CSS box of one band: its region's edges as percentages of the column, the bands already on its edges and its own
  // thickness in px, so it stays on its edge of its monitor when the window is resized.
  function place(band) {
    const pct = v => Math.round(v * 1e6) / 1e4 + '%', px = v => Math.round(v * 100) / 100 + 'px';
    const left = 'calc(' + pct(band.from) + ' + ' + px(band.inset.left) + ')', right = 'calc(' + pct(1 - band.to) + ' + ' + px(band.inset.right) + ')';
    return upright(band.side)
      ? { top: px(band.inset.top), bottom: px(band.inset.bottom), width: px(band.thick), height: 'auto',
          left: band.side === 'left' ? left : 'auto', right: band.side === 'right' ? right : 'auto' }
      : { left, right, width: 'auto', height: px(band.thick),
          top: band.side === 'top' ? px(band.inset.top) : 'auto', bottom: band.side === 'bottom' ? px(band.inset.bottom) : 'auto' };
  }

  const plan = { THICKNESS, MIN_REGION, regions, target, bands, split, monitorOf, validRects, place };
  if (typeof module === 'object' && module.exports) module.exports = plan;
  if (root) root.KinViewerMonitorPlan = plan;
})(typeof window === 'object' ? window : null);

if (typeof window === 'object') window.KinViewerFeatures?.module('monitors', ({ store, ui }) => {
  const plan = window.KinViewerMonitorPlan;
  const IMAGES = [['none', 'None'], ['1x1', '1 × 1'], ['1x2', '1 × 2'], ['2x1', '2 × 1'], ['2x2', '2 × 2'], ['auto', 'Automatic']];
  const WORKLIST = [['show', 'Show'], ['none', 'None']];
  const SIDES = [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'None']];
  const label = (list, value) => (list.find(([v]) => v === value) || [, value])[1];
  const COLUMN = 'body[data-kin-monitor-rows] #root :has(> .kin-viewer-series-strip)';
  const fixedStyle = document.createElement('style'), placeStyle = document.createElement('style');
  fixedStyle.dataset.kinUxOwned = ''; placeStyle.dataset.kinUxOwned = '';
  // The rows of a window whose Hanging Protocol places them per monitor stand where the rule says, always shown; the
  // copy on the other display is shown in its own band. Copies keep the orientation of their own band.
  fixedStyle.textContent = [
    COLUMN + ' > .kin-ux-toolbar-slot, ' + COLUMN + ' > .kin-viewer-series-strip { opacity: 1 !important; pointer-events: auto !important; box-shadow: none !important; }',
    COLUMN + '::before, ' + COLUMN + '::after { display: none !important; }',
    'body[data-kin-monitor-rows][data-kin-monitor-no-thumbs] .kin-viewer-series-strip { display: none !important; }',
    'body.kin-second-display-tabs-off .kin-patient-tabs { display: none !important; }',
    '.kin-span-mirror.kin-span-fixed { opacity: 1 !important; pointer-events: auto !important; box-shadow: none; }',
    '.kin-span-mirror.kin-span-fixed.kin-span-across { flex-direction: row; align-items: stretch; }',
    '.kin-span-fixed.kin-span-across .kin-ux-tools-bar, .kin-span-fixed.kin-span-across .kin-series-list { flex-direction: row !important; overflow-x: auto !important; overflow-y: hidden !important; }',
    '.kin-span-fixed.kin-span-upright .kin-ux-tools-bar, .kin-span-fixed.kin-span-upright .kin-series-list { flex-direction: column !important; overflow-x: hidden !important; overflow-y: auto !important; }',
    '.kin-span-fixed.kin-span-upright .kin-series-card { flex: none; width: auto; }',
    '.kin-monitors-table { border-collapse: collapse; margin: .4em 0; }',
    '.kin-monitors-table th, .kin-monitors-table td { padding: .2em .5em; text-align: left; }',
    '.kin-monitors-list { color: #000; background: #9fb3c8; }',
  ].join('\n');
  document.head.append(fixedStyle, placeStyle);
  const body = document.body;
  let active = null;
  const event = () => window.dispatchEvent(new Event('kin-viewer-second-display'));
  const account = () => window.KinViewerChromePosition?.normalize(store.get('chrome'));
  const frames = n => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(n); });
  const aborted = () => new DOMException('Aborted', 'AbortError');

  // The rows as an applied rule leaves them ({ chrome, css, noThumbs, copies }), or null: the account's own.
  function show(state) {
    active = state;
    if (!state) {
      window.KinViewerMonitorRows = null; body.removeAttribute('data-kin-monitor-rows'); body.removeAttribute('data-kin-monitor-no-thumbs');
      placeStyle.textContent = '';
      window.KinViewerUXShell?.chrome?.(account());
    } else {
      window.KinViewerMonitorRows = { copies: state.copies };
      body.setAttribute('data-kin-monitor-rows', ''); body.toggleAttribute('data-kin-monitor-no-thumbs', state.noThumbs);
      placeStyle.textContent = state.css;
      window.KinViewerUXShell?.chrome?.(state.chrome);
    }
    event();
  }
  const declare = (selector, box) => selector + ' { ' + Object.entries(box).map(([k, v]) => k + ': ' + v + ' !important').join('; ') + '; }';

  async function screensInfo() {
    let details = null;
    try {
      const permission = await navigator.permissions?.query({ name: 'window-management' });
      // Reuse access the reader already gave; never ask here.
      if (permission?.state === 'granted') details = await window.getScreenDetails?.();
    } catch (_) { details = null; }
    const layout = window.KinViewerDisplayLayout;
    if (details?.screens?.length && layout) {
      const os = details.currentScreen?.devicePixelRatio;
      return { screens: layout.screens(details), granted: true, zoom: Number.isFinite(os) && os > 0 ? window.devicePixelRatio / os : null };
    }
    // One display and the browser says so: monitor 1 is the one this window is on.
    const s = window.screen;
    if (s?.isExtended === false && [s.availLeft ?? 0, s.availTop ?? 0, s.availWidth, s.availHeight].every(Number.isFinite))
      return { screens: [{ left: s.availLeft ?? 0, top: s.availTop ?? 0, width: s.availWidth, height: s.availHeight, primary: true }], granted: false, zoom: null };
    return null;
  }
  const geometry = () => ({ screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight });
  // Moves this window over the target and reads where it actually stands (a browser may refuse or clamp the move).
  async function move(rect, signal) {
    const now = () => ({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight });
    const close = value => ['left', 'top', 'width', 'height'].every(key => Math.abs(value[key] - rect[key]) <= 16);
    const start = now();
    try { window.moveTo(rect.left, rect.top); window.resizeTo(rect.width, rect.height); window.moveTo(rect.left, rect.top); } catch (_) { return { moved: false, reached: false }; }
    for (const until = Date.now() + 2500; Date.now() < until;) {
      if (signal?.aborted) break;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (close(now())) return { moved: true, reached: true };
    }
    return { moved: JSON.stringify(now()) !== JSON.stringify(start), reached: false };
  }
  const name = index => 'Monitor ' + (index + 1);

  // Hanging Protocols calls this when it applies a rule with monitors (viewer-hanging-protocol.js). It moves the window,
  // puts the rows in place and answers the split; undo() puts the rows back as they were, commit() keeps them.
  async function prepare(rule, { signal } = {}) {
    const before = active, notes = [];
    const answer = (split, moved = false) => ({ split, moved, note: notes.length ? ' · Monitors: ' + notes.join(' ') : '',
      undo: () => show(before), commit: () => { if (!split) show(null); } });
    const info = await screensInfo();
    if (signal?.aborted) throw aborted();
    if (!info) {
      notes.push('화면 정보를 확인할 수 없어 모니터별 배치를 적용하지 않았습니다. 창 관리 권한을 허용하면 적용됩니다(Viewer Windows › Detect Displays).');
      return answer(null);
    }
    const monitors = rule.monitors, aim = plan.target(monitors, info.screens);
    const column = () => document.querySelector('.kin-viewer-series-strip')?.parentElement || document.querySelector('[data-cy="viewport-grid"]')?.parentElement;
    const box = () => { const c = column()?.getBoundingClientRect(); return c ? { left: c.left, right: c.right, top: c.top, bottom: c.bottom } : null; };
    const covers = () => {
      const now = plan.regions(info.screens, geometry(), info.zoom, box()).map(region => region.monitor);
      return aim.monitors.every(monitor => now.includes(monitor));
    };
    let moved = false;
    if (aim.rect && !covers()) {
      const result = await move(aim.rect, signal);
      moved = result.moved;
      if (signal?.aborted) throw aborted();
      if (!result.reached) notes.push(info.granted ? '브라우저가 영상 창을 ' + aim.monitors.map(name).join('·') + '(으)로 옮기지 않았습니다. 창을 직접 옮긴 뒤 다시 Apply 하세요.'
        : '창 관리 권한이 없어 영상 창을 ' + aim.monitors.map(name).join('·') + '(으)로 옮기지 못했습니다.');
      await frames(2);
    }
    // The rows leave the column's flow, so the images fill it; the split is measured on that.
    show({ chrome: { toolbar: 'top', toolbarAutoHide: true, thumbs: 'top', thumbsAutoHide: true }, css: '', noThumbs: false, copies: {} });
    await frames(2);
    const undo = () => show(before);
    if (signal?.aborted) { undo(); throw aborted(); }
    const columnBox = box(), gridBox = document.querySelector('[data-cy="viewport-grid"]')?.getBoundingClientRect();
    const covered = columnBox ? plan.regions(info.screens, geometry(), info.zoom, columnBox) : [];
    const split = columnBox && gridBox ? plan.split(window.KinHangingProtocolModel, rule, covered.slice(0, 2), columnBox, gridBox) : null;
    for (const skipped of aim.skipped) notes.push(name(skipped.monitor) + ': ' + (skipped.reason === 'no-display' ? '이 화면 구성에 없어 적용하지 않았습니다.' : '한 영상 창은 이웃한 두 화면까지만 덮어 적용하지 않았습니다.'));
    if (!split) {
      undo();
      notes.push('영상 창이 영상 모니터 위에 있지 않아 모니터별 배치를 적용하지 않았습니다.');
      return answer(null, moved);
    }
    for (const monitor of aim.monitors) if (!split.applied.includes(monitor)) notes.push(name(monitor) + ': 영상 창이 그 화면을 덮지 않아 적용하지 않았습니다.');
    if (split.hidden.length) notes.push('규칙의 칸 ' + split.hidden.map(index => index + 1).join(', ') + '은(는) 모니터 칸 수가 모자라 보이지 않습니다.');
    if (split.toolbarKept) notes.push('도구 줄을 둘 모니터가 적용되지 않아 도구 줄을 ' + name(split.applied[0]) + ' 위에 둡니다.');
    const { toolbar, thumbs } = split.rows;
    const copy = band => band ? { css: plan.place(band), side: band.side, upright: band.side === 'left' || band.side === 'right' } : null;
    const css = [toolbar.original && declare(COLUMN + ' > .kin-ux-toolbar-slot', plan.place(toolbar.original)),
      thumbs.original && declare(COLUMN + ' > .kin-viewer-series-strip', plan.place(thumbs.original))].filter(Boolean).join('\n');
    show({ chrome: { toolbar: toolbar.original?.side || 'top', toolbarAutoHide: true, thumbs: thumbs.original?.side || 'top', thumbsAutoHide: true },
      css, noThumbs: !thumbs.original, copies: { 'Image Tools': copy(toolbar.copy), Series: copy(thumbs.copy) } });
    if (signal?.aborted) { undo(); throw aborted(); }
    notes.unshift('적용 ' + split.applied.map(name).join('·') + '.');
    // The worklist window is not moved: where it stands is read from it now.
    const listed = monitors.list.findIndex(m => m.worklist === 'show');
    if (listed >= 0) {
      let rect = null;
      try { rect = await window.kinViewerListPlace?.(); } catch (_) { rect = null; }
      if (signal?.aborted) { undo(); throw aborted(); }
      const at = rect ? plan.monitorOf(info.screens, rect) : -1;
      notes.push(!rect || at < 0 ? 'Worklist: 목록 창 위치를 확인할 수 없습니다.' : at === listed ? 'Worklist: 목록 창이 ' + name(listed) + '에 있습니다.'
        : 'Worklist: 목록 창이 ' + name(listed) + '에 있지 않습니다(' + name(at) + '). 브라우저는 목록 창을 옮기지 않습니다. 목록 창을 직접 옮기세요.');
    }
    return { ...answer(split, moved), undo };
  }
  window.KinViewerMonitors = { prepare, clear: () => { if (active) show(null); } };

  // ── The window: Viewer Settings › Monitors in Hanging Protocol… ──
  const element = (tag, attributes = {}, parent) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'text') node.textContent = value; else if (key === 'className') node.className = value; else node.setAttribute(key, value);
    }
    parent?.append(node); return node;
  };
  async function detected() {
    const info = await screensInfo();
    if (info) return Math.min(4, Math.max(1, info.screens.length));
    return window.screen?.isExtended === true ? 2 : 1;
  }
  function defaults(index) {
    const rows = account() || { toolbar: 'top', thumbs: 'top' };
    return { images: index === 0 ? 'auto' : 'none', worklist: 'none', thumbs: rows.thumbs, toolbar: rows.toolbar };
  }
  // A drawing of one monitor: its rows on their edges, its image grid (Automatic: the rule's grid), the worklist.
  function drawing(index, monitor, layout) {
    const figure = element('figure', { className: 'kin-chrome-figure' });
    const box = element('div', { className: 'kin-chrome-monitor', role: 'img' }, figure);
    box.style.width = '168px'; box.style.height = '104px';
    const area = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const [row, text, thick] of [['toolbar', 'Tools', 14], ['thumbs', 'Thumbs', 24]]) {
      const side = monitor[row];
      if (side === 'none' || monitor.images === 'none') continue;
      const part = element('div', { className: 'kin-chrome-' + row, text }, box), across = side === 'top' || side === 'bottom';
      Object.assign(part.style, { top: side === 'bottom' ? '' : area.top + 'px', bottom: side === 'top' ? '' : area.bottom + 'px',
        left: side === 'right' ? '' : area.left + 'px', right: side === 'left' ? '' : area.right + 'px', [across ? 'height' : 'width']: thick + 'px' });
      area[side] += thick;
    }
    const grid = window.KinHangingProtocolModel?.monitorGrid(monitor.images, layout || { rows: 1, cols: 1 });
    if (grid) {
      const images = element('div', { className: 'kin-chrome-images' }, box);
      Object.assign(images.style, { top: area.top + 'px', right: area.right + 'px', bottom: area.bottom + 'px', left: area.left + 'px',
        display: 'grid', gridTemplate: 'repeat(' + grid.rows + ', 1fr) / repeat(' + grid.cols + ', 1fr)' });
      for (let i = 0; i < grid.rows * grid.cols; i++) element('div', { text: 'Images', style: 'position: static; border: 1px solid #333; display: flex; align-items: center; justify-content: center' }, images);
    }
    if (monitor.worklist === 'show') {
      const list = element('div', { className: 'kin-monitors-list', text: 'Worklist' }, box);
      Object.assign(list.style, grid ? { left: '0', right: '0', bottom: '0', height: '16px' } : { inset: '0' });
    }
    box.setAttribute('aria-label', name(index) + ': Images ' + label(IMAGES, monitor.images) + ', Worklist ' + label(WORKLIST, monitor.worklist) +
      ', Thumbnails ' + label(SIDES, monitor.thumbs) + ', Toolbar ' + label(SIDES, monitor.toolbar));
    element('figcaption', { text: name(index) }, figure);
    return figure;
  }
  const REFUSED = {
    busy: 'Hanging Protocols is busy. Try again in a moment.', scope: 'Hanging Protocols is showing the Site rules. Switch it to Personal and try again.',
    missing: 'That Hanging Protocol is no longer in your Hanging Protocols.', invalid: 'These monitors cannot be saved with this Hanging Protocol.',
    storage: 'This browser could not keep the Hanging Protocols draft.', error: 'Not saved.',
  };
  function open() {
    const handle = ui.panel({ id: 'monitors', title: 'Monitors in Hanging Protocol' });
    if (!handle || handle.body.childElementCount) return handle;
    const hp = window.KinViewerHangingProtocol?.current?.(), model = window.KinHangingProtocolModel;
    element('p', { text: 'Set, for each monitor of a Hanging Protocol, the image layout, whether the worklist is there, and where the thumbnails and the toolbar stand. '
      + 'Monitor 1 is the display furthest left. Save keeps them in the Hanging Protocol; they are used each time it is applied (Apply in Hanging Protocols). '
      + 'The worklist window is not moved: the viewer tells whether it stands on its monitor.' }, handle.body);
    const status = element('p', { role: 'status' });
    if (!hp || !model) { handle.body.append(status); status.textContent = 'Hanging Protocols is not available in this viewer.'; return handle; }
    const top = element('div', { className: 'kin-chrome-row' }, handle.body);
    const ruleField = element('label', { className: 'kin-chrome-field' }, top); element('span', { text: 'Hanging Protocol' }, ruleField);
    const ruleSelect = element('select', { 'aria-label': 'Hanging Protocol' }, ruleField);
    const countField = element('label', { className: 'kin-chrome-field' }, top); element('span', { text: 'Monitors' }, countField);
    const countSelect = element('select', { 'aria-label': 'Monitors' }, countField);
    for (let n = 1; n <= model.MAX_MONITORS; n++) element('option', { value: String(n), text: String(n) }, countSelect);
    const table = element('table', { className: 'kin-monitors-table' }, handle.body);
    const diagram = element('div', { className: 'kin-chrome-diagram', role: 'group', 'aria-label': 'Monitor Layout' }, handle.body);
    const actions = element('div', { className: 'kin-chrome-actions' }, handle.body);
    const save = element('button', { type: 'button', text: 'Save' }, actions);
    handle.body.append(status);
    let live = true, saving = false;
    const draft = { ruleId: null, count: 1, list: [0, 1, 2, 3].map(defaults) };
    const rules = () => hp.scope() === 'personal' ? hp.read().rules : [];
    const rule = () => rules().find(value => value.id === draft.ruleId) || null;
    function load(id) {
      draft.ruleId = id;
      const saved = rule()?.monitors;
      draft.list = [0, 1, 2, 3].map(index => saved?.list[index] ? { ...saved.list[index] } : defaults(index));
      if (saved) draft.count = saved.count;
    }
    function paint() {
      const focused = document.activeElement?.closest?.('.kin-monitors-table') ? document.activeElement.getAttribute('aria-label') : null;
      table.replaceChildren();
      const head = element('tr', {}, table);
      for (const text of ['Monitor', 'Images', 'Worklist', 'Thumbnails', 'Toolbar']) element('th', { text }, head);
      draft.list.slice(0, draft.count).forEach((monitor, index) => {
        const line = element('tr', {}, table);
        element('td', { text: name(index) }, line);
        for (const [key, text, options] of [['images', 'Images', IMAGES], ['worklist', 'Worklist', WORKLIST], ['thumbs', 'Thumbnails', SIDES], ['toolbar', 'Toolbar', SIDES]]) {
          const select = element('select', { 'aria-label': name(index) + ' ' + text }, element('td', {}, line));
          for (const [value, words] of options) element('option', { value, text: words }, select);
          select.value = monitor[key];
          select.addEventListener('change', () => {
            monitor[key] = select.value;
            // The worklist window is one: Show on one monitor takes it from any other.
            if (key === 'worklist' && select.value === 'show') draft.list.forEach((other, i) => { if (i !== index) other.worklist = 'none'; });
            paint();
          });
        }
      });
      if (focused) table.querySelector('select[aria-label="' + CSS.escape(focused) + '"]')?.focus();
      diagram.replaceChildren(...draft.list.slice(0, draft.count).map((monitor, index) => drawing(index, monitor, rule()?.layout)));
      const list = rules();
      save.disabled = saving || !list.length || !rule();
      save.title = !list.length ? (hp.scope() === 'personal' ? 'There is no Hanging Protocol rule yet. Make one in Hanging Protocols.' : REFUSED.scope) : '';
    }
    function fill() {
      const list = rules();
      ruleSelect.replaceChildren(...list.map(value => { const option = document.createElement('option'); option.value = value.id; option.textContent = value.name; return option; }));
      ruleSelect.disabled = !list.length;
      if (!list.some(value => value.id === draft.ruleId)) {
        const applied = hp.applied?.(), chosen = applied?.scope === 'personal' && list.some(value => value.id === applied.ruleId) ? applied.ruleId
          : list.some(value => value.id === hp.selected?.()) ? hp.selected() : list[0]?.id || null;
        load(chosen);
      }
      ruleSelect.value = draft.ruleId || '';
      countSelect.value = String(draft.count);
      if (!list.length) status.textContent = hp.scope() === 'personal' ? 'There is no Hanging Protocol rule yet. Make one in Hanging Protocols.' : REFUSED.scope;
      paint();
    }
    ruleSelect.addEventListener('change', () => { load(ruleSelect.value); countSelect.value = String(draft.count); paint(); });
    countSelect.addEventListener('change', () => { draft.count = Number(countSelect.value); paint(); });
    save.addEventListener('click', async () => {
      if (saving || !rule()) return;
      const value = { count: draft.count, list: draft.list.slice(0, draft.count).map(monitor => ({ ...monitor })) };
      if (!model.monitorsRule(value)) {
        status.textContent = value.list.filter(m => m.worklist === 'show').length > 1 ? 'Only one monitor can show the worklist.'
          : 'At least one monitor must show images with a toolbar, so Viewer Settings stays within reach.';
        return;
      }
      saving = true; save.disabled = true; status.textContent = 'Saving…';
      let result;
      try { result = await hp.saveMonitors(draft.ruleId, value); } catch (error) { console.error(error); result = { ok: false, reason: 'error' }; }
      if (!live) return;
      saving = false;
      const named = '"' + (rule()?.name || '') + '"';
      status.textContent = !result?.ok ? (REFUSED[result?.reason] || REFUSED.error)
        : result.account === 'saved' ? 'Saved with Hanging Protocol ' + named + ' in this browser and your account. Apply it in Hanging Protocols to use it.'
        : result.account === 'failed' ? 'Saved with Hanging Protocol ' + named + ' in this browser. Saving to your account failed: the reason is shown in Hanging Protocols.'
        : 'Saved with Hanging Protocol ' + named + ' in this browser\'s Hanging Protocols. Your account is not updated: Hanging Protocols has not loaded your account in this window.';
      paint();
    });
    handle.onClose(() => { live = false; });
    fill();
    // A rule without saved monitors starts from the displays this browser reports.
    if (draft.ruleId && !rule()?.monitors) detected().then(count => { if (live && !rule()?.monitors && !saving) { draft.count = count; countSelect.value = String(count); paint(); } });
    handle.focus();
    return handle;
  }

  ui.setting({ id: 'monitorHanging', kind: 'button', label: 'Monitors in Hanging Protocol…', order: 61, run: () => open() });
  return () => {
    if (active) show(null);
    if (window.KinViewerMonitors?.prepare === prepare) window.KinViewerMonitors = null;
    fixedStyle.remove(); placeStyle.remove();
  };
});
