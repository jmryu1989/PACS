// Viewer feature module: Display Set Presets — the display of each cell (Display Set): Magnification, Windowing,
// Filter, Sort, Rotate, Flip, First image, GSPS auto and Overlay. Apply to This Study puts them on the cells now; Save
// with Hanging Protocol keeps them in the Hanging Protocol applied to the screen (its rule's `display` list, one entry
// per layout cell), and they are put on the cells each time that Hanging Protocol is applied. Only stack (2D) cells
// take part; MPR keeps its own display. Rule values and orders are in hanging-protocol-model.js, the filters in
// viewer-image-filter.js and the presentation state reading in viewer-gsps.js.
window.KinViewerFeatures?.module('view', async ({ services, commands, store, ui }) => {
  await ui.load(['hanging-protocol-model.js', 'viewer-image-filter.js', 'viewer-gsps.js']);
  const model = window.KinHangingProtocolModel, filters = window.KinImageFilter, gsps = window.KinGsps;
  const grid = services.viewportGridService, cells = services.cornerstoneViewportService;
  const abort = new AbortController(), { signal } = abort;
  let ended = false, painter = null;  // painter: repaints the open window

  const element = (tag, text, parent, className) => {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
  };
  const button = (text, parent, click) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; return node; };
  const style = element('style', `
[data-kin-cell-overlay="none"] .viewport-overlay,[data-kin-cell-overlay="none"] [data-cy^="viewport-overlay-"],
[data-kin-cell-overlay="none"] .kin-viewer-identity,[data-kin-cell-overlay="none"] .orientation-marker,
[data-kin-cell-overlay="none"] .kin-display-text{visibility:hidden!important}
.kin-view-marks{position:absolute;left:50%;top:34px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:none}
.kin-view-marks>span{background:#0b182bcc;border:1px solid #E8C547;border-radius:3px;padding:1px 5px;font:11px/1.35 sans-serif;color:#fff;white-space:nowrap}
.kin-view-gsps{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.kin-view-gsps text{font:12px sans-serif;fill:#E8C547;stroke:#000;stroke-width:2px;paint-order:stroke}
.kin-ux-feature-panel table.kin-view-table{border-collapse:collapse;margin:6px 0}
.kin-ux-feature-panel table.kin-view-table td,.kin-ux-feature-panel table.kin-view-table th{padding:2px 4px;text-align:left;white-space:nowrap}
.kin-view-wide{overflow:auto;max-width:min(96vw,1180px)}
.kin-view-row{display:flex;flex-wrap:wrap;align-items:center;gap:.4em;margin:6px 0}
.kin-view-note{color:var(--kin-ux-secondary);margin:0 0 6px;max-width:46em}
`, document.head);

  // ── Cells ──
  const events = window.cornerstone?.Enums?.Events || {};
  const SETTLED = 'kin-display-image-settled';  // viewer-features-display.js: a new image's own display is in place
  const ordered = () => { try { return [...grid.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x); } catch (_) { return []; } };
  const viewportOf = id => { try { const v = cells.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected ? v : null; } catch (_) { return null; } };
  const anyViewport = id => { try { return cells.getCornerstoneViewport(id) || null; } catch (_) { return null; } };
  const imageId = v => { try { return v.getCurrentImageId?.() || null; } catch (_) { return null; } };
  const metadata = id => { try { return window.cornerstone.metaData.get('instance', id) || null; } catch (_) { return null; } };
  const instanceOf = v => { const id = imageId(v); return id ? metadata(id) : null; };
  // The DICOM frame the shown image is (from its id, not its place in a sorted stack).
  const frameOf = v => gsps.frameOf(imageId(v), instanceOf(v)?.NumberOfFrames);
  const setOf = id => { try { return grid.getState().viewports.get(id)?.displaySetInstanceUIDs?.[0] || ''; } catch (_) { return ''; } };
  const keyOf = v => v.id + '|' + setOf(v.id);
  const paneOf = v => v.element.closest('[data-cy=viewport-pane]') || v.element.parentElement;
  const canvasOf = v => v.element.querySelector('canvas');
  const UID = /^\d+(?:\.\d+)+$/;
  const report = text => ui.toast(text, 'error');

  // Each cell has a generation that only grows: it moves on when the grid names the cell (or names none) or the cell
  // gets new viewport data. Work for a cell is pinned to the viewport, its display set and that generation (a target);
  // when any of them moves on, the work stops for that cell.
  const moves = new Map();
  let everyCell = 0;
  const generation = id => everyCell + (moves.get(id) ?? 0);
  function moved(ids) { if (ids) for (const id of ids) moves.set(id, (moves.get(id) ?? 0) + 1); else everyCell++; }
  function targetOf(id) { const v = viewportOf(id); return v && imageId(v) ? { id, v, key: keyOf(v), at: generation(id) } : null; }
  const current = target => !!target && !ended && viewportOf(target.id) === target.v && keyOf(target.v) === target.key && generation(target.id) === target.at;

  // ── What this module did to each cell (by viewport): its images' stock order, the rule, the presentation state ──
  const records = new Map();
  function recordOf(v) {
    let record = records.get(v.id);
    if (record && (record.viewport !== v || record.key !== keyOf(v))) { clearMarks(record); records.delete(v.id); record = null; }
    if (!record) records.set(v.id, record = { viewport: v, key: keyOf(v), pane: paneOf(v), stock: [...(v.getImageIds?.() || [])], rule: null,
      presentations: null, presentation: null, shown: null, signature: '', notes: [], invertBefore: null, busy: false, layer: null });
    return record;
  }
  // Takes off what this module put over or on the cell's picture (not the camera or window the reader now has).
  function clearMarks(record) {
    const canvas = record.viewport?.element ? canvasOf(record.viewport) : null;
    if (canvas) filters.apply(canvas, 'none');
    if (record.pane?.dataset.kinCellOverlay) delete record.pane.dataset.kinCellOverlay;
    record.layer?.remove(); record.layer = null;
  }
  // A cell given other images, or gone: its marks go with it.
  function sweep() {
    for (const [id, record] of records) {
      const v = viewportOf(id);
      if (!v || v !== record.viewport || keyOf(v) !== record.key) { clearMarks(record); records.delete(id); }
    }
  }

  // ── Presentation states (GSPS) of a study, read once per viewer from the DICOMweb service the viewer reads ──
  const studies = new Map();
  async function json(path) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/dicom+json' }, signal });
    if (response.status === 204) return [];
    if (!response.ok) throw new Error('GSPS could not be read (' + response.status + ').');
    const value = await response.json();
    return Array.isArray(value) ? value : [];
  }
  function presentations(study) {
    if (!UID.test(study || '')) return Promise.resolve([]);
    if (!studies.has(study)) {
      const read = (async () => {
        const list = [];
        for (const row of await json('/dicom-web/studies/' + study + '/series?Modality=PR&limit=101')) {
          const series = row?.['0020000E']?.Value?.[0];
          if (!UID.test(series || '')) continue;
          for (const item of await json('/dicom-web/studies/' + study + '/series/' + series + '/metadata')) { const p = gsps.parse(item); if (p) list.push(p); }
        }
        return list;
      })();
      read.catch(() => studies.delete(study));
      studies.set(study, read);
    }
    return studies.get(study);
  }

  // ── Putting a rule on a cell ──
  const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  // Changes the cell's image and resolves once the viewer's own display of the new image is in place: where the
  // Display module draws this cell, after it has (its own stored VOI included), so what is set next is not replaced.
  async function changeImage(v, change) {
    const display = paneOf(v)?.dataset.kinDisplay === 'on';
    let done;
    const settled = new Promise(resolve => { done = resolve; });
    const heard = event => { if (event.detail?.viewportId === v.id) done(); };
    if (display) v.element.addEventListener(SETTLED, heard);
    try {
      await change();
      if (display) await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 2000))]);
    } finally { v.element.removeEventListener(SETTLED, heard); }
  }
  async function jump(v, index) {
    const go = window.cornerstone?.utilities?.jumpToSlice;
    if (typeof go === 'function') await go(v.element, { imageIndex: index });
    else await v.setImageIdIndex?.(index);
  }
  // The world point of DICOM image coordinates (0\0 = the top left corner of the top left pixel). The image data's
  // index 0 is the centre of the first pixel; the viewer's own conversion takes the DICOM coordinates as they are.
  function worldAt(v, x, y) {
    const data = v.getImageData?.();
    if (typeof data?.imageData?.indexToWorld === 'function') return data.imageData.indexToWorld([x - 0.5, y - 0.5, 0]);
    const convert = window.cornerstone?.utilities?.imageToWorldCoords;
    return typeof convert === 'function' ? convert(imageId(v), [x, y]) : null;
  }
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
  const turned = rotation => rotation === 90 || rotation === 270;
  // World length of one image pixel along the screen's vertical, for the cell's turn.
  function spacingUp(v, rotation) {
    const spacing = v.getImageData?.()?.spacing;
    if (!Array.isArray(spacing)) return null;
    return turned(rotation) ? spacing[0] : spacing[1];
  }
  function centreOn(v, centre, parallelScale) {
    const camera = v.getCamera(), shift = centre.map((value, i) => value - camera.focalPoint[i]);
    v.setCamera({ focalPoint: [...centre], position: camera.position.map((value, i) => value + shift[i]), parallelScale });
  }
  function magnify(v, value, rotation) {
    v.setZoom(value === '150' ? 1.5 : value === '200' ? 2 : 1);
    if (typeof v.setPan === 'function') v.setPan([0, 0]);
    if (value === '1:1') {
      const up = spacingUp(v, rotation), height = v.element.clientHeight;
      if (up > 0 && height > 0) v.setCamera({ parallelScale: height / 2 * up });
    }
  }
  // The displayed area of a presentation state: SCALE TO FIT fits it to the cell, MAGNIFY shows image pixels at the
  // given ratio around its centre, TRUE SIZE (which needs a calibrated display the viewer does not have) is fitted.
  function displayArea(v, area, rotation) {
    const a = worldAt(v, area.from[0], area.from[1]), right = worldAt(v, area.to[0], area.from[1]), down = worldAt(v, area.from[0], area.to[1]);
    const b = worldAt(v, area.to[0], area.to[1]);
    if (!a || !right || !down || !b) return false;
    const centre = a.map((value, i) => (value + b[i]) / 2);
    const across = distance(a, right), along = distance(a, down);
    const width = turned(rotation) ? along : across, height = turned(rotation) ? across : along;
    const w = v.element.clientWidth, h = v.element.clientHeight;
    if (!(w > 0 && h > 0)) return false;
    let scale = Math.max(height / 2, width / 2 * h / w);
    if (area.mode === 'MAGNIFY' && area.magnification > 0) { const up = spacingUp(v, rotation); if (up > 0) scale = h / 2 * up / area.magnification; }
    centreOn(v, centre, scale);
    return true;
  }
  function turnAndFlip(v, rotation, flip) {
    // Both flips are set (not toggled): no earlier flip stays, and the turn is counted from the unflipped image. The
    // turn comes first, then the flip of the turned picture (the order a presentation state also uses).
    v.setCamera({ flipHorizontal: false, flipVertical: false });
    v.setViewPresentation({ ...v.getViewPresentation(), rotation });
    v.setCamera({ flipHorizontal: flip === 'horizontal', flipVertical: flip === 'vertical' });
  }
  // A window by the viewer's own command. After a stored table was drawn on the cell (a presentation state's VOI LUT),
  // the same window would not replace the table, so the linear window is drawn anew instead (as the Display module
  // does for a reader's window); the Display module hears it as the reader's window either way.
  function windowTo(v, w, l, record) {
    if (record?.table) {
      record.table = false;
      const convert = window.cornerstone?.utilities?.windowLevel?.toLowHighRange;
      const range = typeof convert === 'function' ? convert(w, l) : { lower: l - 0.5 - (w - 1) / 2, upper: l - 0.5 + (w - 1) / 2 };
      v.setProperties({ VOILUTFunction: 'LINEAR' });
      v.setVOI(range, { forceRecreateLUTFunction: true });
      return;
    }
    commands.runCommand('setViewportWindowLevel', { viewportId: v.id, window: w, level: l }, 'CORNERSTONE');
  }
  // Stock: the window stored with the shown image (Window Center/Width), else the viewer's own default.
  function stockWindow(v, record) {
    let module = null;
    try { module = window.cornerstone.metaData.get('voiLutModule', imageId(v)); } catch (_) {}
    const first = value => Number(Array.isArray(value) ? value[0] : value);
    const w = first(module?.windowWidth), l = first(module?.windowCenter);
    if (w > 0 && Number.isFinite(l)) windowTo(v, w, l, record);
    else { record && (record.table = false); v.resetProperties?.(); }
  }
  // The row's own turn, flip and size.
  function baseSpace(v, record) {
    turnAndFlip(v, record.rule.rotate, record.rule.flip);
    magnify(v, record.rule.magnification, record.rule.rotate);
  }
  // The row's own window and the stored inversion back.
  function baseWindow(v, record) {
    if (record.rule.windowing) windowTo(v, record.rule.windowing.w, record.rule.windowing.l, record); else stockWindow(v, record);
    if (record.invertBefore !== null) { v.setProperties({ invert: record.invertBefore }); record.invertBefore = null; }
  }
  function base(v, record) { baseSpace(v, record); baseWindow(v, record); }
  // The presentation state for the image now shown. Its turn, flip and displayed area go on when they differ from what
  // was put there last (the row's own come back when there is none); its window (or the row's) is put on for every image,
  // once that image's own display is in place. Returns what could not be done, for the cell's line.
  function present(v, record) {
    const instance = instanceOf(v), sop = instance?.SOPInstanceUID, frame = frameOf(v);
    const p = gsps.latest(record.presentations, sop, frame), shown = p && gsps.forImage(p, sop, frame);
    const space = shown && (shown.rotation !== null || shown.horizontalFlip !== null || shown.area) ? p.sop + '|' + JSON.stringify([shown.rotation, shown.horizontalFlip, shown.area]) : '';
    record.presentation = shown ? p : null; record.shown = shown;
    const notes = [];
    if (!record.presented || space !== record.signature) {
      if (record.signature) baseSpace(v, record);
      record.presented = true; record.signature = space;
      if (space) {
        const spatial = shown.rotation !== null || shown.horizontalFlip !== null;
        const rotation = spatial ? shown.rotation ?? 0 : record.rule.rotate;
        if (spatial) turnAndFlip(v, rotation, shown.horizontalFlip ? 'horizontal' : 'none');
        if (shown.area && !displayArea(v, shown.area, rotation)) record.areaNote = 'GSPS displayed area not shown'; else record.areaNote = '';
      } else record.areaNote = '';
    }
    if (record.areaNote) notes.push(record.areaNote);
    if (shown?.area?.mode === 'TRUE SIZE') notes.push('GSPS true size is not supported: fitted to the cell');
    if (shown?.area?.aspect) {
      const spacing = instance?.PixelSpacing || instance?.ImagerPixelSpacing, own = Array.isArray(spacing) && spacing[1] > 0 ? spacing[0] / spacing[1] : 1;
      if (Math.abs(shown.area.aspect / own - 1) > 0.01) notes.push('GSPS pixel aspect ratio is not supported: the image keeps its own');
    }
    if (!shown) { baseWindow(v, record); return (record.notes = ['no GSPS']); }
    let invertNow = false;
    try { invertNow = !!v.getProperties().invert; } catch (_) {}
    if (shown.invert !== null && record.invertBefore === null) record.invertBefore = invertNow;
    const invert = shown.invert ?? (record.invertBefore ?? invertNow);
    if (shown.voi?.lut) {
      const drawn = window.kinStoredVoi?.apply?.(v, { voi: { status: 'verified', fn: 'TABLE', source: 'GSPS Softcopy VOI LUT', lut: shown.voi.lut }, invert }) === true;
      if (drawn) record.table = true;
      else { notes.push('GSPS VOI LUT could not be drawn: the row\'s window is used'); baseWindow(v, record); }
    } else {
      if (shown.voi?.unreadable) notes.push('GSPS VOI LUT could not be read: the row\'s window is used');
      if (shown.voi && !shown.voi.unreadable) windowTo(v, shown.voi.width, shown.voi.center, record);
      else if (record.rule.windowing) windowTo(v, record.rule.windowing.w, record.rule.windowing.l, record); else stockWindow(v, record);
      if (shown.invert !== null) v.setProperties({ invert: shown.invert });
      else if (record.invertBefore !== null) { v.setProperties({ invert: record.invertBefore }); record.invertBefore = null; }
    }
    return (record.notes = notes);
  }
  let pass = 0;
  let rulesPass = null;
  // Track every replacement, including Apply to This Study and a saved rule, before it can await image loading.
  function startPass(work) {
    const current = { run: ++pass, outcome: null };
    rulesPass = current;
    return Promise.resolve().then(() => work(current.run)).then(value => {
      current.outcome = 'done'; return value;
    }, error => { current.outcome = 'failed'; throw error; });
  }
  // Puts one rule on one cell (a target). Resolves the notes of what was not done, or null when the cell changed or
  // another pass began while it ran.
  // `alive`: the caller's own condition to go on (Auto Save View turned off stops a saved rule going back).
  async function applyCell(target, rule, run, alive) {
    const v = target.v, live = () => run === pass && current(target) && (!alive || alive());
    if (!live()) return null;
    const record = recordOf(v);
    record.busy = true;
    try {
      // Sort, then the first image of the sorted stack.
      const order = model.sortOrder(record.stock.map(metadata), rule.sort).map(i => record.stock[i]);
      const index = model.firstIndex(order.length, rule.firstImage);
      if (!sameList(v.getImageIds?.() || [], order)) await changeImage(v, () => v.setStack(order, index));
      else if ((v.getCurrentImageIdIndex?.() ?? 0) !== index) await changeImage(v, () => jump(v, index));
      if (!live()) return null;
      clearMarks(record);
      record.rule = rule; record.presentations = null; record.presentation = null; record.shown = null; record.signature = ''; record.presented = false; record.notes = [];
      base(v, record);
      filters.apply(canvasOf(v), rule.filter);
      if (rule.overlay === 'none') record.pane.dataset.kinCellOverlay = 'none';
      let notes = [];
      if (rule.gspsAuto) {
        const study = instanceOf(v)?.StudyInstanceUID;
        let list = null;
        try { list = await presentations(study); } catch (error) { if (!live()) return null; notes = [error.message]; }
        if (!live()) return null;
        if (list) { record.presentations = list; notes = present(v, record); }
      }
      v.render();
      draw(record);
      return notes;
    } finally {
      record.busy = false;
      // An image the reader moved to while this ran gets its own presentation state now.
      if (record.pendingTrack) { record.pendingTrack = false; if (!ended && current(target)) track(v); }
    }
  }
  // A row left at the defaults: the cell goes back to its stock order and loses this module's filter, overlay setting
  // and presentation state; its camera and window stay as the reader has them.
  async function clearCell(target, run) {
    const v = target.v, record = records.get(target.id);
    if (!current(target) || run !== pass || !record || record.viewport !== v || record.key !== target.key) return;
    clearMarks(record);
    if (record.table) stockWindow(v, record);
    record.rule = null; record.presentations = null;
    if (record.invertBefore !== null) { v.setProperties({ invert: record.invertBefore }); record.invertBefore = null; }
    const now = imageId(v), stock = record.stock;
    if (!sameList(v.getImageIds?.() || [], stock)) await changeImage(v, () => v.setStack(stock, Math.max(0, stock.indexOf(now))));
    if (!current(target) || run !== pass) return;
    records.delete(target.id);
    v.render();
  }

  // ── Drawing: the cell's marks and its presentation state's annotations (read-only), over the image ──
  const SVG = 'http://www.w3.org/2000/svg';
  function draw(record) {
    const v = record.viewport;
    if (!record.rule || viewportOf(v.id) !== v || keyOf(v) !== record.key) return;
    if (!record.layer?.isConnected) { record.layer = ui.cellLayer(v.id); if (!record.layer) return; }
    const layer = record.layer;
    layer.replaceChildren();
    const marks = [];
    if (record.rule.filter !== 'none') marks.push('Filter: ' + filters.LABELS[record.rule.filter]);
    if (record.presentation) marks.push('GSPS: ' + (record.presentation.label || 'applied'));
    for (const note of record.notes) if (note.startsWith('GSPS ')) marks.push(note);
    if (marks.length) { const box = element('div', '', layer, 'kin-view-marks'); for (const text of marks) element('span', text, box); }
    if (!record.presentation) return;
    const instance = instanceOf(v), shown = gsps.forImage(record.presentation, instance?.SOPInstanceUID, frameOf(v));
    if (!shown || (!shown.graphics.length && !shown.texts.length)) return;
    const canvas = canvasOf(v), origin = layer.getBoundingClientRect(), box = (canvas || v.element).getBoundingClientRect();
    const dx = box.left - origin.left, dy = box.top - origin.top;
    const pixel = (x, y) => { const world = worldAt(v, x, y), point = world && v.worldToCanvas(world); return point ? [dx + point[0], dy + point[1]] : null; };
    // DISPLAY units are fractions of the displayed area as it stands on the screen (the whole image without one).
    const area = shown.area || { from: [0, 0], to: [Number(instance?.Columns) || 0, Number(instance?.Rows) || 0] };
    const corners = [[area.from[0], area.from[1]], [area.to[0], area.from[1]], [area.from[0], area.to[1]], [area.to[0], area.to[1]]].map(([x, y]) => pixel(x, y));
    const bounds = corners.every(Boolean) ? { left: Math.min(...corners.map(c => c[0])), top: Math.min(...corners.map(c => c[1])),
      right: Math.max(...corners.map(c => c[0])), bottom: Math.max(...corners.map(c => c[1])) } : null;
    const at = (units, [x, y]) => units === 'DISPLAY' ? bounds && [bounds.left + x * (bounds.right - bounds.left), bounds.top + y * (bounds.bottom - bounds.top)] : pixel(x, y);
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('class', 'kin-view-gsps'); svg.setAttribute('aria-hidden', 'true');
    for (const graphic of shown.graphics) {
      const shape = gsps.outline(graphic), points = shape.points.map(point => at(graphic.units, point));
      if (points.some(point => !point)) continue;
      if (shape.point) {
        const [x, y] = points[0], path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', `M${x - 5} ${y}H${x + 5}M${x} ${y - 5}V${y + 5}`); path.setAttribute('stroke', '#E8C547'); path.setAttribute('stroke-width', '1.5');
        svg.append(path); continue;
      }
      const line = document.createElementNS(SVG, shape.closed ? 'polygon' : 'polyline');
      line.setAttribute('points', points.map(point => point.map(n => n.toFixed(1)).join(',')).join(' '));
      line.setAttribute('stroke', '#E8C547'); line.setAttribute('stroke-width', '1.5');
      line.setAttribute('fill', graphic.filled ? '#E8C54755' : 'none');
      line.dataset.gspsType = graphic.type;
      svg.append(line);
    }
    for (const item of shown.texts) {
      const place = item.anchor ? at(item.anchorUnits, item.anchor) : at(item.boxUnits, item.box.tl);
      if (!place) continue;
      const text = document.createElementNS(SVG, 'text');
      text.setAttribute('x', place[0].toFixed(1)); text.setAttribute('y', (place[1] + (item.anchor ? 0 : 12)).toFixed(1));
      text.textContent = item.text; svg.append(text);
    }
    layer.append(svg);
  }
  let drawing = false;
  const redraw = () => { if (drawing || ended) return; drawing = true; requestAnimationFrame(() => { drawing = false; if (ended) return; sweep(); for (const record of records.values()) draw(record); }); };
  // Another image in a cell with GSPS auto: that image's presentation state (or the row's own values) once the image's
  // own display is in place. A cell this module is changing itself waits for its own pass.
  function track(v) {
    const record = records.get(v.id);
    if (record?.busy) record.pendingTrack = true;
    else if (record && record.viewport === v && record.key === keyOf(v) && record.rule?.gspsAuto && record.presentations) {
      try { present(v, record); v.render(); } catch (error) { console.error(error); }
    }
    redraw();
  }
  const on = (name, fn) => { if (name) document.addEventListener(name, fn, { capture: true, signal }); };
  on(SETTLED, event => { const v = viewportOf(event.detail?.viewportId); if (v) track(v); });
  on(events.STACK_NEW_IMAGE, event => {
    const v = viewportOf(event.detail?.viewportId) || [...records.values()].find(r => r.viewport.element === event.detail?.element)?.viewport;
    if (v && paneOf(v)?.dataset.kinDisplay !== 'on') setTimeout(() => { if (!ended && viewportOf(v.id) === v) track(v); }, 0);
    redraw();
  });
  on(events.CAMERA_MODIFIED, redraw); on(events.IMAGE_RENDERED, () => { if ([...records.values()].some(r => r.layer && !r.layer.isConnected)) redraw(); });
  addEventListener('resize', redraw, { signal });
  const subscriptions = [];
  for (const [service, name, ids] of [
    [grid, grid?.EVENTS?.GRID_STATE_CHANGED, event => Array.isArray(event?.viewports) ? [...event.viewports.map(view => view?.viewportId), ...(event.removedViewportIds || [])].filter(Boolean) : null],
    [cells, cells?.EVENTS?.VIEWPORT_DATA_CHANGED, event => event?.viewportId ? [event.viewportId] : null],
  ]) {
    if (!name || typeof service?.subscribe !== 'function') continue;
    try { subscriptions.push(service.subscribe(name, event => { if (ended) return; moved(ids(event)); redraw(); painter?.(); })); } catch (error) { console.error(error); }
  }

  // ── Applying rules to cells (Apply to This Study, and a Hanging Protocol's rules once it stands) ──
  // list: [{ index, target, rule | null }], each target taken when the work was asked for. A rule left at the defaults
  // clears the cell. Resolves a status line, or null when another pass began.
  function applyAll(list, run) {
    return run === undefined ? startPass(next => applyList(list, next)) : applyList(list, run);
  }
  async function applyList(list, run) {
    const notes = [];
    let applied = 0;
    for (const { index, target, rule, alive } of list) {
      if (ended || run !== pass) return null;
      const name = 'Set ' + (index + 1);
      if (!current(target)) { notes.push(name + ': its images changed, not applied'); continue; }
      try {
        if (!rule || model.isDefaultDisplay(rule)) { await clearCell(target, run); continue; }
        const result = await applyCell(target, rule, run, alive);
        if (result === null) { if (run === pass) notes.push(name + ': its images changed, not applied'); continue; }
        applied++;
        if (result.length) notes.push(name + ': ' + result.join('; '));
      } catch (error) { console.error(error); notes.push(name + ': ' + (error?.message || 'not applied')); }
    }
    if (run !== pass) return null;
    return (applied ? 'Applied to ' + applied + (applied === 1 ? ' cell.' : ' cells.') : 'No cell has a rule to apply.') + (notes.length ? ' ' + notes.join('; ') + '.' : '');
  }
  // A Hanging Protocol was applied: once each of its cells shows an image, its display rule is put on it.
  const rendered = () => window.cornerstone?.Enums?.ViewportStatus?.RENDERED || 'rendered';
  async function shown(viewportId, run) {
    for (let i = 0; i < 200; i++) {
      if (ended || run !== pass) return null;
      const v = viewportOf(viewportId);
      if (v && imageId(v) && (v.viewportStatus === undefined || v.viewportStatus === rendered())) return targetOf(viewportId);
      const other = anyViewport(viewportId);
      if (other && other.type && other.type !== 'stack') return null;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }
  addEventListener('kin-hanging-protocol-applied', event => {
    const ids = event.detail?.viewportIds, display = event.detail?.display;
    if (!Array.isArray(ids)) return;
    const list = ids.map((viewportId, index) => ({ index, viewportId, rule: model.displayRule(Array.isArray(display) ? display[index] ?? null : null) || null }))
      .filter(item => item.rule && !model.isDefaultDisplay(item.rule));
    // An earlier pass still running stops.
    startPass(async run => {
      // Every cell is watched at once and pinned when it first shows its image: a cell given other images later is
      // not that cell any more.
      const targets = await Promise.all(list.map(item => shown(item.viewportId, run)));
      const ready = list.map((item, i) => ({ ...item, target: targets[i] })).filter(item => item.target);
      if (run !== pass || ended) return 'done';
      await applyAll(ready, run);
      painter?.();
      return 'done';
    }).catch(error => { console.error(error); report(error?.message || 'Display set presets were not applied.'); });
  }, { signal });

  // ── The window ──
  const COLUMNS = [
    ['magnification', 'Magnification', [['fit', 'Fit to window'], ['1:1', '1:1'], ['150', '150%'], ['200', '200%']]],
    ['windowing', 'Windowing', null],
    ['filter', 'Filter', model.DISPLAY.filter.map(kind => [kind, filters.LABELS[kind]])],
    ['sort', 'Sort', [['stock', 'Stock'], ['instance', 'Instance number'], ['position-asc', 'Slice position ↑'], ['position-desc', 'Slice position ↓'], ['acquisition', 'Acquisition time']]],
    ['rotate', 'Rotate', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']]],
    ['flip', 'Flip', [['none', 'None'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']]],
    ['firstImage', 'First image', [['first', 'First'], ['middle', 'Middle'], ['last', 'Last']]],
    ['gspsAuto', 'GSPS auto', [[false, 'Off'], [true, 'On']]],
    ['overlay', 'Overlay', [['full', 'Full'], ['none', 'None']]],
  ];
  const presetNumber = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
  // Windowing choices for a cell: Stock, the viewer's presets for its modality, then the reader's own (My W/L Presets).
  function windowings(modality, keep) {
    const list = [];
    const add = (name, w, l, label) => { const entry = model.displayRule({ ...model.defaultDisplay(), windowing: { name, w, l } }); if (entry && !list.some(item => item.name === name && item.w === w && item.l === l)) list.push({ name, w, l, label: label || name }); };
    let stock = [];
    try { stock = services.customizationService?.get?.('cornerstone.windowLevelPresets')?.presets?.[modality] || []; } catch (_) {}
    for (const preset of Array.isArray(stock) ? stock : []) {
      const w = presetNumber(preset?.window), l = presetNumber(preset?.level), name = typeof preset?.description === 'string' ? preset.description.trim() : '';
      if (name && w > 0 && l !== null) add(name.slice(0, 60), w, l);
    }
    const mine = store.get('wlPresets')?.[modality];
    for (const preset of Array.isArray(mine) ? mine : []) {
      const name = typeof preset?.name === 'string' ? preset.name.trim() : '';
      if (name && Number(preset.w) > 0 && Number.isFinite(Number(preset.l))) add(name.slice(0, 60), Number(preset.w), Number(preset.l), name.slice(0, 60) + ' (My preset)');
    }
    if (keep && !list.some(item => item.name === keep.name && item.w === keep.w && item.l === keep.l)) list.push({ ...keep, label: keep.name });
    return list;
  }
  const wlValue = item => JSON.stringify([item.name, item.w, item.l]);

  const working = new Map();  // viewportId|set → the row's values while the window is open
  function open() {
    const handle = ui.panel({ id: 'display-set-presets', title: 'Display Set Presets' });
    if (!handle) return;
    const body = handle.body;
    body.replaceChildren();
    element('p', 'Set the display of each cell (Display Set): magnification, windowing, filter, sort, rotate, flip, first image, GSPS auto and overlay. '
      + 'Apply to This Study shows them in the cells now. Save with Hanging Protocol keeps them in the applied Hanging Protocol, and they are applied each time it is applied. '
      + 'A filter changes only the picture: measurements use the original pixels.', body, 'kin-view-note');
    const wide = element('div', '', body, 'kin-view-wide'), table = element('table', '', wide, 'kin-view-table');
    const actions = element('div', '', body, 'kin-view-row');
    const line = element('p', '', body, 'kin-view-note'); line.setAttribute('role', 'status');
    working.clear();
    const rows = () => ordered().map((view, index) => {
      const v = viewportOf(view.viewportId), id = view.viewportId, key = id + '|' + (view.displaySetInstanceUIDs?.[0] || '');
      const kind = !view.displaySetInstanceUIDs?.length ? 'empty' : !v ? (anyViewport(id) ? 'mpr' : 'loading') : 'stack';
      return { index, id, key, v, kind };
    });
    function valuesOf(row) {
      if (!working.has(row.key)) {
        const record = records.get(row.id);
        working.set(row.key, structuredClone(record && record.key === row.key && record.rule ? record.rule : model.defaultDisplay()));
      }
      return working.get(row.key);
    }
    function paint() {
      if (!table.isConnected) return;
      const focused = document.activeElement?.closest?.('.kin-view-table') ? document.activeElement.getAttribute('aria-label') : null;
      table.replaceChildren();
      const head = element('tr', '', table);
      element('th', 'Display Set', head);
      for (const [, label] of COLUMNS) element('th', label, head);
      for (const row of rows()) {
        const tr = element('tr', '', table), name = 'Set ' + (row.index + 1);
        tr.dataset.viewportId = row.id;
        element('td', name, tr);
        if (row.kind !== 'stack') {
          const td = element('td', row.kind === 'mpr' ? 'MPR — keeps its own display' : row.kind === 'empty' ? 'No image' : 'Loading', tr);
          td.colSpan = COLUMNS.length; continue;
        }
        const values = valuesOf(row), modality = instanceOf(row.v)?.Modality || '';
        for (const [field, label, options] of COLUMNS) {
          const select = element('select', '', element('td', '', tr));
          select.setAttribute('aria-label', name + ' ' + label);
          if (field === 'windowing') {
            const stock = element('option', 'Stock', select); stock.value = '';
            for (const item of windowings(modality, values.windowing)) { const option = element('option', item.label, select); option.value = wlValue(item); }
            select.value = values.windowing ? wlValue(values.windowing) : '';
            select.onchange = () => { const picked = select.value ? JSON.parse(select.value) : null; values.windowing = picked ? { name: picked[0], w: picked[1], l: picked[2] } : null; };
          } else {
            for (const [value, text] of options) { const option = element('option', text, select); option.value = String(value); }
            select.value = String(values[field]);
            select.onchange = () => { values[field] = options.find(([value]) => String(value) === select.value)[0]; };
          }
        }
      }
      if (focused) table.querySelector('select[aria-label="' + CSS.escape(focused) + '"]')?.focus();
      saveState();
    }
    const apply = button('Apply to This Study', actions, async () => {
      // Each row is for the cell (viewport, images and generation) it stands for now.
      const list = rows().filter(row => row.kind === 'stack').map(row => ({ index: row.index, target: targetOf(row.id), rule: model.displayRule(valuesOf(row)) }))
        .filter(item => item.target);
      line.textContent = 'Applying…';
      const text = await applyAll(list);
      if (text !== null && !ended) line.textContent = text;
    });
    apply.dataset.featureAction = 'apply';
    const save = button('Save with Hanging Protocol', actions, async () => {
      const state = saveState();
      if (!state.ok) { line.textContent = state.reason; return; }
      const byId = new Map(rows().map(row => [row.id, row]));
      const display = state.applied.viewportIds.map(id => { const row = byId.get(id); return row?.kind === 'stack' ? model.displayRule(valuesOf(row)) : null; });
      save.disabled = true; line.textContent = 'Saving…';
      let result;
      try { result = await state.hp.saveDisplay(display); } catch (error) { console.error(error); result = { ok: false, reason: 'error' }; }
      if (ended) return;
      const named = '"' + state.applied.name + '"';
      line.textContent = !result?.ok ? (SAVE_REFUSED[result?.reason] || 'Not saved.')
        : result.account === 'saved' ? 'Saved with Hanging Protocol ' + named + ' in this browser and your account.'
        : result.account === 'failed' ? 'Saved with Hanging Protocol ' + named + ' in this browser. Saving to your account failed: the reason is shown in Hanging Protocols.'
        : 'Saved with Hanging Protocol ' + named + ' in this browser\'s Hanging Protocols. Your account is not updated: Hanging Protocols has not loaded your account in this window.';
      saveState();
    });
    save.dataset.featureAction = 'save';
    // Save is for the Hanging Protocol applied to this screen, when it is one of the reader's own.
    function saveState() {
      const hp = window.KinViewerHangingProtocol?.current?.(), applied = hp?.applied?.() || null;
      const views = ordered().map(view => view.viewportId);
      const reason = !hp ? 'Hanging Protocols is not available in this viewer.'
        : !applied ? 'No Hanging Protocol is applied to this screen. Apply one in Hanging Protocols first.'
        : applied.scope !== 'personal' ? 'The applied Hanging Protocol is an institution (Site) rule. Only your own rules can be changed here.'
        : !sameList(views, applied.viewportIds) ? 'The screen no longer shows the applied Hanging Protocol. Apply it again first.' : '';
      if (save.isConnected) { save.disabled = !!reason; save.title = reason || 'Keep these rules in the Hanging Protocol "' + applied.name + '"'; }
      return { ok: !reason, reason, hp, applied };
    }
    painter = paint;
    handle.onClose(() => { if (painter === paint) painter = null; working.clear(); });
    paint();
    handle.focus();
  }
  const SAVE_REFUSED = {
    busy: 'Hanging Protocols is busy. Try again in a moment.', none: 'No Hanging Protocol is applied to this screen.',
    site: 'The applied Hanging Protocol is an institution (Site) rule. Only your own rules can be changed here.',
    scope: 'Hanging Protocols is showing the Site rules. Switch it to Personal and try again.',
    missing: 'The applied Hanging Protocol is no longer in your Hanging Protocols.',
    changed: 'The cells of the applied Hanging Protocol were changed in its editor. Apply it again first.',
    invalid: 'These rules cannot be saved with this Hanging Protocol.', storage: 'This browser could not keep the Hanging Protocols draft.',
    error: 'Not saved.',
  };

  ui.setting({ id: 'displaySetPresets', kind: 'button', label: 'Display Set Presets…', order: 60, run: () => open() });

  // For Auto Save View (viewer-features-autosave.js): the rule this module has put on a cell now, and putting a saved
  // rule on a cell again (sort and first image first, as Apply to This Study does). Resolves true when the rule stands.
  const cellRules = Object.freeze({
    rule(viewportId) {
      const v = viewportOf(viewportId), record = records.get(viewportId);
      return !ended && v && record && record.viewport === v && record.key === keyOf(v) && record.rule ? structuredClone(record.rule) : null;
    },
    async apply(viewportId, value, alive) {
      const rule = model.displayRule(value), target = targetOf(viewportId);
      if (ended || !rule || !target || (alive && !alive())) return false;
      const text = await applyAll([{ index: 0, target, rule, alive }]);
      return text !== null && current(target) && (!alive || alive()) && (model.isDefaultDisplay(rule) || !!records.get(viewportId)?.rule);
    },
    busy() { return !ended && !!rulesPass && rulesPass.outcome === null; },
    revision() { return pass; },
    // Follow replacements until the current pass ends. Replacing a stalled pass is not completion of its successor.
    async settled() {
      for (;;) {
        if (ended) return 'ended';
        if (!rulesPass) return 'none';
        if (rulesPass.outcome) return rulesPass.outcome;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    },
  });
  window.KinViewerCellRules = cellRules;

  return () => {
    ended = true; abort.abort(); painter = null;
    if (window.KinViewerCellRules === cellRules) delete window.KinViewerCellRules;
    for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (_) {}
    for (const record of records.values()) clearMarks(record);
    records.clear(); style.remove();
  };
});
