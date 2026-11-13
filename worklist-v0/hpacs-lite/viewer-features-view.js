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
  const ordered = () => { try { return [...grid.getState().viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x); } catch (_) { return []; } };
  const viewportOf = id => { try { const v = cells.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected ? v : null; } catch (_) { return null; } };
  const anyViewport = id => { try { return cells.getCornerstoneViewport(id) || null; } catch (_) { return null; } };
  const imageId = v => { try { return v.getCurrentImageId?.() || null; } catch (_) { return null; } };
  const metadata = id => { try { return window.cornerstone.metaData.get('instance', id) || null; } catch (_) { return null; } };
  const instanceOf = v => { const id = imageId(v); return id ? metadata(id) : null; };
  const frameOf = (v, instance) => Number(instance?.NumberOfFrames) > 1 ? (v.getCurrentImageIdIndex?.() ?? 0) + 1 : 1;
  const setOf = id => { try { return grid.getState().viewports.get(id)?.displaySetInstanceUIDs?.[0] || ''; } catch (_) { return ''; } };
  const keyOf = v => v.id + '|' + setOf(v.id);
  const paneOf = v => v.element.closest('[data-cy=viewport-pane]') || v.element.parentElement;
  const canvasOf = v => v.element.querySelector('canvas');
  const UID = /^\d+(?:\.\d+)+$/;
  const report = text => ui.toast(text, 'error');

  // ── What this module did to each cell (by viewport): its images' stock order, the rule, the presentation state ──
  const records = new Map();
  function recordOf(v) {
    let record = records.get(v.id);
    if (record && (record.viewport !== v || record.key !== keyOf(v))) { clearMarks(record); records.delete(v.id); record = null; }
    if (!record) records.set(v.id, record = { viewport: v, key: keyOf(v), pane: paneOf(v), stock: [...(v.getImageIds?.() || [])], rule: null, presentation: null,
      invertBefore: null, trueSize: false, layer: null });
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
  const ALIGN = 1e-6;
  const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  async function jump(v, index) {
    const go = window.cornerstone?.utilities?.jumpToSlice;
    if (typeof go === 'function') await go(v.element, { imageIndex: index });
    else await v.setImageIdIndex?.(index);
  }
  // The world point of DICOM image coordinates (0\0 = the top left corner of the top left pixel).
  function worldAt(v, x, y) {
    const data = v.getImageData?.(), index = [x - 0.5, y - 0.5, 0];
    if (typeof data?.imageData?.indexToWorld === 'function') return data.imageData.indexToWorld(index);
    const convert = window.cornerstone?.utilities?.imageToWorldCoords;
    return typeof convert === 'function' ? convert(imageId(v), [index[0], index[1]]) : null;
  }
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
  // World length of one image pixel along the screen's vertical, for the cell's turn.
  function spacingUp(v, rotation) {
    const spacing = v.getImageData?.()?.spacing;
    if (!Array.isArray(spacing)) return null;
    return rotation === 90 || rotation === 270 ? spacing[0] : spacing[1];
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
  // given ratio around its centre. TRUE SIZE needs a calibrated display, which the viewer does not have: fitted, and
  // the cell says so.
  function displayArea(v, area, rotation) {
    const a = worldAt(v, area.from[0], area.from[1]), right = worldAt(v, area.to[0], area.from[1]), down = worldAt(v, area.from[0], area.to[1]);
    const b = worldAt(v, area.to[0], area.to[1]);
    if (!a || !right || !down || !b) return false;
    const centre = a.map((value, i) => (value + b[i]) / 2);
    const across = distance(a, right), along = distance(a, down), turned = rotation === 90 || rotation === 270;
    const width = turned ? along : across, height = turned ? across : along;
    const w = v.element.clientWidth, h = v.element.clientHeight;
    if (!(w > 0 && h > 0)) return false;
    let scale = Math.max(height / 2, width / 2 * h / w);
    if (area.mode === 'MAGNIFY' && area.magnification > 0) { const up = spacingUp(v, rotation); if (up > 0) scale = h / 2 * up / area.magnification; }
    centreOn(v, centre, scale);
    return true;
  }
  function turnAndFlip(v, rotation, flip) {
    // Both flips are set (not toggled): no earlier flip stays, and the turn is counted from the unflipped image.
    v.setCamera({ flipHorizontal: false, flipVertical: false });
    v.setViewPresentation({ ...v.getViewPresentation(), rotation });
    v.setCamera({ flipHorizontal: flip === 'horizontal', flipVertical: flip === 'vertical' });
  }
  function windowTo(v, w, l) {
    commands.runCommand('setViewportWindowLevel', { viewportId: v.id, window: w, level: l }, 'CORNERSTONE');
  }

  let pass = 0;
  // Puts one rule on one cell. Resolves a short note of what was not done ('' when all was), or null when the cell
  // changed while it ran.
  async function applyCell(viewportId, rule, run) {
    const v = viewportOf(viewportId);
    if (!v || !imageId(v)) return 'no image';
    const record = recordOf(v), key = record.key;
    const live = () => !ended && run === pass && viewportOf(viewportId) === v && keyOf(v) === key;
    // Sort, then the first image of the sorted stack.
    const order = model.sortOrder(record.stock.map(metadata), rule.sort).map(i => record.stock[i]);
    const index = model.firstIndex(order.length, rule.firstImage);
    if (!sameList(v.getImageIds?.() || [], order)) await v.setStack(order, index);
    else if ((v.getCurrentImageIdIndex?.() ?? 0) !== index) await jump(v, index);
    if (!live()) return null;
    // The latest presentation state for the image now shown.
    let presentation = null, shown = null;
    if (rule.gspsAuto) {
      const instance = instanceOf(v), sop = instance?.SOPInstanceUID, frame = frameOf(v, instance);
      try { presentation = gsps.latest(await presentations(instance?.StudyInstanceUID), sop, frame); } catch (error) { if (!live()) return null; report(error.message); }
      if (!live()) return null;
      shown = presentation && gsps.forImage(presentation, sop, frame);
    }
    clearMarks(record);
    // Turn and flip first (the displayed area is measured on the turned image), then the size, then the window.
    const spatial = shown && (shown.rotation !== null || shown.horizontalFlip !== null);
    const rotation = spatial ? shown.rotation ?? 0 : rule.rotate, flip = spatial ? (shown.horizontalFlip ? 'horizontal' : 'none') : rule.flip;
    turnAndFlip(v, rotation, flip);
    record.trueSize = false;
    if (shown?.area) { if (!displayArea(v, shown.area, rotation)) magnify(v, rule.magnification, rotation); record.trueSize = shown.area.mode === 'TRUE SIZE'; }
    else magnify(v, rule.magnification, rotation);
    if (shown?.voi) windowTo(v, shown.voi.width, shown.voi.center);
    else if (rule.windowing) windowTo(v, rule.windowing.w, rule.windowing.l);
    if (shown && shown.invert !== null) {
      if (record.invertBefore === null) { try { record.invertBefore = !!v.getProperties().invert; } catch (_) { record.invertBefore = false; } }
      v.setProperties({ invert: shown.invert });
    } else if (record.invertBefore !== null) { v.setProperties({ invert: record.invertBefore }); record.invertBefore = null; }
    filters.apply(canvasOf(v), rule.filter);
    if (rule.overlay === 'none') record.pane.dataset.kinCellOverlay = 'none';
    record.rule = rule; record.presentation = presentation;
    v.render();
    draw(record);
    return rule.gspsAuto && !presentation ? 'no GSPS' : '';
  }
  // A row left at the defaults: the cell goes back to its stock order and loses this module's filter, overlay setting
  // and presentation state drawing; its camera and window stay as the reader has them.
  async function clearCell(viewportId, run) {
    const v = viewportOf(viewportId), record = records.get(viewportId);
    if (!v || !record || record.viewport !== v || record.key !== keyOf(v)) return;
    clearMarks(record);
    if (record.invertBefore !== null) { v.setProperties({ invert: record.invertBefore }); record.invertBefore = null; }
    const now = imageId(v), stock = record.stock;
    if (!sameList(v.getImageIds?.() || [], stock)) await v.setStack(stock, Math.max(0, stock.indexOf(now)));
    if (ended || run !== pass) return;
    records.delete(viewportId);
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
    if (record.trueSize) marks.push('GSPS true size is not supported: fitted to the cell');
    if (marks.length) { const box = element('div', '', layer, 'kin-view-marks'); for (const text of marks) element('span', text, box); }
    if (!record.presentation) return;
    const instance = instanceOf(v), shown = gsps.forImage(record.presentation, instance?.SOPInstanceUID, frameOf(v, instance));
    if (!shown || (!shown.graphics.length && !shown.texts.length)) return;
    const canvas = canvasOf(v), base = layer.getBoundingClientRect(), box = (canvas || v.element).getBoundingClientRect();
    const dx = box.left - base.left, dy = box.top - base.top;
    const at = (units, [x, y]) => {
      if (units === 'DISPLAY') return [dx + x * box.width, dy + y * box.height];
      const world = worldAt(v, x, y), point = world && v.worldToCanvas(world);
      return point ? [dx + point[0], dy + point[1]] : null;
    };
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
  const on = (name, fn) => { if (name) document.addEventListener(name, fn, { capture: true, signal }); };
  on(events.STACK_NEW_IMAGE, redraw); on(events.CAMERA_MODIFIED, redraw); on(events.IMAGE_RENDERED, () => { if ([...records.values()].some(r => r.layer && !r.layer.isConnected)) redraw(); });
  addEventListener('resize', redraw, { signal });
  const subscriptions = [];
  for (const [service, name] of [[grid, grid?.EVENTS?.GRID_STATE_CHANGED], [cells, cells?.EVENTS?.VIEWPORT_DATA_CHANGED]]) {
    if (!name || typeof service?.subscribe !== 'function') continue;
    try { subscriptions.push(service.subscribe(name, () => { if (!ended) { redraw(); painter?.(); } })); } catch (error) { console.error(error); }
  }

  // ── Applying rules to cells (Apply to This Study, and a Hanging Protocol's rules once it stands) ──
  // rules: [{ viewportId, rule | null }]. A rule left at the defaults clears the cell. Resolves a status line.
  async function applyAll(list, run = ++pass) {
    const notes = [];
    let applied = 0;
    for (const [index, { viewportId, rule }] of list.entries()) {
      if (ended || run !== pass) return null;
      try {
        if (!rule || model.isDefaultDisplay(rule)) { await clearCell(viewportId, run); continue; }
        const note = await applyCell(viewportId, rule, run);
        if (note === null) continue;
        applied++;
        if (note) notes.push('Set ' + (index + 1) + ': ' + note);
      } catch (error) { console.error(error); notes.push('Set ' + (index + 1) + ': ' + (error?.message || 'not applied')); }
    }
    if (run !== pass) return null;
    return (applied ? 'Applied to ' + applied + (applied === 1 ? ' cell.' : ' cells.') : 'No cell has a rule to apply.') + (notes.length ? ' ' + notes.join('; ') + '.' : '');
  }
  // A Hanging Protocol was applied: once each of its cells shows an image, its display rule is put on it.
  const rendered = () => window.cornerstone?.Enums?.ViewportStatus?.RENDERED || 'rendered';
  async function shown(viewportId, run) {
    for (let i = 0; i < 200; i++) {
      if (ended || run !== pass) return false;
      const v = viewportOf(viewportId);
      if (v && imageId(v) && (v.viewportStatus === undefined || v.viewportStatus === rendered())) return true;
      const other = anyViewport(viewportId);
      if (other && other.type && other.type !== 'stack') return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  addEventListener('kin-hanging-protocol-applied', event => {
    const ids = event.detail?.viewportIds, display = event.detail?.display;
    if (!Array.isArray(ids)) return;
    const list = ids.map((viewportId, i) => ({ viewportId, rule: model.displayRule(Array.isArray(display) ? display[i] ?? null : null) || null }))
      .filter(item => item.rule && !model.isDefaultDisplay(item.rule));
    // The new layout's cells have no marks of an earlier pass; an earlier pass still running stops.
    const run = ++pass;
    if (!list.length) return;
    (async () => {
      const ready = [];
      for (const item of list) if (await shown(item.viewportId, run)) ready.push(item);
      if (run !== pass || ended) return;
      await applyAll(ready, run);
      painter?.();
    })().catch(error => { console.error(error); report(error?.message || 'Display set presets were not applied.'); });
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
      const list = rows().filter(row => row.kind === 'stack').map(row => ({ viewportId: row.id, rule: model.displayRule(valuesOf(row)) }));
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

  return () => {
    ended = true; abort.abort(); painter = null;
    for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (_) {}
    for (const record of records.values()) clearMarks(record);
    records.clear(); style.remove();
  };
});
