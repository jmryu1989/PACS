// Viewer feature module: Display menu — Overlay Items, Corner Information, Auto Rotate 180°, Zoom, Smart Zoom,
// My W/L Presets and VOI LUT. It registers through viewer-features.js; the account values live in
// viewerSettings.features (overlayItems, cornerInfo, autoRotate, wlPresets, voiLut). Calculations are in
// viewer-display-model.js. Only stack (2D) cells take part; MPR keeps its own display settings.
window.KinViewerFeatures?.module('display', async ({ services, store, ui }) => {
  await ui.load('viewer-display-model.js');
  const model = window.KinViewerDisplayModel;
  const grid = services.viewportGridService, cells = services.cornerstoneViewportService;
  const abort = new AbortController(), { signal } = abort;
  let ended = false;

  const element = (tag, text, parent, className) => {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
  };
  const button = (text, parent, click) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; return node; };
  const checkbox = (label, checked, parent, change) => {
    const row = element('label', '', parent, 'kin-display-check'), input = element('input', '', row);
    input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label); input.onchange = () => change(input.checked);
    element('span', label, row); return input;
  };
  const style = element('style', `
.kin-display-text{position:absolute;inset:0;pointer-events:none;color:#fff;font:12px/1.35 sans-serif;text-shadow:0 0 2px #000,0 0 2px #000}
.kin-display-text>div{position:absolute;white-space:pre}
.kin-display-badges{right:8px;top:34px;display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.kin-display-badges>span{background:#0b182bcc;border:1px solid #8AB4C8;border-radius:3px;padding:1px 5px;font-size:11px}
.kin-display-border{inset:0;box-sizing:border-box}
.kin-display-ruler{right:44px;top:50%;width:6px;border:2px solid #E8C547;border-right:0;transform:translateY(-50%)}
.kin-display-ruler>span{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#E8C547;white-space:nowrap}
.kin-display-capture{position:absolute;inset:0;pointer-events:auto;cursor:crosshair}
.kin-display-capture>span{position:absolute;left:50%;top:8px;transform:translateX(-50%);background:#0b182bcc;border:1px solid #E8C547;border-radius:3px;padding:2px 6px;font:12px sans-serif;color:#fff}
.kin-display-check{display:flex;align-items:center;gap:.4em;margin:3px 0}
.kin-ux-feature-panel table.kin-display-table{border-collapse:collapse;margin:6px 0}
.kin-ux-feature-panel table.kin-display-table td,.kin-ux-feature-panel table.kin-display-table th{padding:2px 6px;text-align:left}
.kin-display-row{display:flex;flex-wrap:wrap;align-items:center;gap:.4em;margin:6px 0}
.kin-display-note{color:var(--kin-ux-secondary);margin:0 0 6px;max-width:34em}
[data-kin-display] [data-cy="viewport-overlay-bottom-left"]>div:nth-child(2){display:none!important}
[data-kin-display-wl="off"] [data-cy="viewport-overlay-bottom-left"]>div:first-child{display:none!important}
[data-kin-display-dicom="off"] [data-cy="viewport-overlay-top-left"],[data-kin-display-dicom="off"] [data-cy="viewport-overlay-top-right"],
[data-kin-display-dicom="off"] [data-cy="viewport-overlay-bottom-right"],[data-kin-display-dicom="off"] .kin-display-corner,
[data-kin-display-corners="on"] [data-cy="viewport-overlay-top-left"],[data-kin-display-corners="on"] [data-cy="viewport-overlay-top-right"],
[data-kin-display-corners="on"] [data-cy="viewport-overlay-bottom-right"],
[data-kin-image-text-hidden] .kin-display-text{visibility:hidden!important}
`, document.head);

  // ── Account values ──
  const state = { overlay: model.overlay(null), corners: {}, presets: {}, autoRotate: false, voiLut: true };
  // One save of a key at a time; a change made while one is saving is saved after it, on the revision it left.
  const savers = new Map();
  function save(key, value, revision) {
    let entry = savers.get(key);
    if (!entry) savers.set(key, entry = { busy: null, next: undefined });
    entry.next = { value };
    if (!entry.busy) entry.busy = (async () => {
      let saved = false, first = true;
      while (entry.next && !ended) {
        const { value: latest } = entry.next; entry.next = undefined;
        saved = await store.set(key, latest, first && revision != null ? { revision } : {});
        first = false;
      }
      entry.busy = null;
      return saved;
    })();
    return entry.busy;
  }

  // ── Cells ──
  const events = window.cornerstone?.Enums?.Events || {};
  const cellIds = () => { try { return [...grid.getState().viewports.keys()]; } catch (_) { return []; } };
  const viewportOf = id => { try { const v = cells.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected ? v : null; } catch (_) { return null; } };
  const stacks = () => cellIds().map(viewportOf).filter(Boolean);
  const imageId = v => { try { return v.getCurrentImageId?.() || null; } catch (_) { return null; } };
  const instanceOf = v => { const id = imageId(v); try { return id ? window.cornerstone.metaData.get('instance', id) || null : null; } catch (_) { return null; } };
  const paneOf = v => v.element.closest('[data-cy=viewport-pane]') || v.element.parentElement;
  const keyOf = v => { try { return v.id + '|' + (grid.getState().viewports.get(v.id)?.displaySetInstanceUIDs?.[0] || ''); } catch (_) { return v.id + '|'; } };
  const frameOf = (v, instance) => Number(instance?.NumberOfFrames) > 1 ? (v.getCurrentImageIdIndex?.() ?? 0) + 1 : 1;
  const zoomOf = v => { try { return v.getZoom(); } catch (_) { return null; } };
  const target = viewportId => viewportOf(viewportId) || stacks().find(imageId) || null;
  const need = viewportId => {
    const v = target(viewportId);
    if (!v || !imageId(v)) { ui.toast('No viewport has an image open.'); return null; }
    return v;
  };
  const range = v => { try { return v.getProperties().voiRange || null; } catch (_) { return null; } };
  const wlText = v => { const value = model.fromRange(range(v)); return value ? 'W ' + value.w + ' / L ' + value.l : 'W/L —'; };

  // The cell layer of this module: text, badges, ruler and border over the image (beside, not inside, OHIF's overlay).
  const layers = new Map();
  function layerOf(v) {
    let entry = layers.get(v.id);
    const pane = paneOf(v);
    if (entry && (!entry.node.isConnected || entry.node.parentElement !== pane)) { entry.node.remove(); entry = null; }
    if (!entry) {
      const node = ui.cellLayer(v.id); if (!node) return null;
      const text = element('div', '', node, 'kin-display-text');
      entry = { node, text, pane, parts: {} };
      layers.set(v.id, entry);
    }
    return entry;
  }
  const part = (entry, name, className) => entry.parts[name]?.isConnected ? entry.parts[name] : (entry.parts[name] = element('div', '', entry.text, className));
  const drop = (entry, name) => { entry.parts[name]?.remove(); delete entry.parts[name]; };
  const rectIn = (node, box) => { const r = node.getBoundingClientRect(); return { left: r.left - box.left, top: r.top - box.top, right: box.right - r.right, bottom: box.bottom - r.bottom, width: r.width, height: r.height }; };

  // ── Drawing (coalesced to one frame) ──
  let queued = false;
  const refresh = () => { if (!queued && !ended) { queued = true; requestAnimationFrame(() => { queued = false; if (!ended) draw(); }); } };
  function draw() {
    const live = new Set();
    for (const v of stacks()) { live.add(v.id); drawCell(v); }
    for (const [id, entry] of layers) if (!live.has(id)) { clearPane(entry.pane); entry.node.remove(); layers.delete(id); }
    for (const fn of painters) try { fn(); } catch (error) { console.error(error); }
  }
  function clearPane(pane) { if (pane) for (const name of ['kinDisplay', 'kinDisplayWl', 'kinDisplayDicom', 'kinDisplayCorners']) delete pane.dataset[name]; }
  function drawCell(v) {
    const entry = layerOf(v); if (!entry) return;
    const { pane } = entry, overlay = state.overlay, instance = instanceOf(v), box = pane.getBoundingClientRect();
    pane.dataset.kinDisplay = 'on';
    pane.dataset.kinDisplayWl = overlay.wl ? 'on' : 'off';
    pane.dataset.kinDisplayDicom = overlay.dicom ? 'on' : 'off';
    const corners = instance && state.corners[instance.Modality];
    pane.dataset.kinDisplayCorners = corners ? 'on' : 'off';
    // Bottom left: above OHIF's own W/L line when it shows.
    const stockLeft = pane.querySelector('[data-cy="viewport-overlay-bottom-left"]');
    let bottom = 8, left = 8;
    if (stockLeft) {
      const r = rectIn(stockLeft, box);
      left = Math.max(4, r.left);
      if (stockLeft.textContent.trim() && r.height) bottom = r.bottom + r.height + 2;
    }
    const zoom = zoomOf(v);
    if (overlay.zoom && zoom) {
      const node = part(entry, 'zoom', 'kin-display-zoom'); node.textContent = 'Zoom ' + model.zoomPercent(zoom) + '%';
      Object.assign(node.style, { left: left + 'px', bottom: bottom + 'px' }); bottom += node.offsetHeight + 2;
    } else drop(entry, 'zoom');
    // Corner Information: the chosen items where the usual corner text is.
    if (corners) {
      const place = { TL: '[data-cy="viewport-overlay-top-left"]', TR: '[data-cy="viewport-overlay-top-right"]', BR: '[data-cy="viewport-overlay-bottom-right"]' };
      for (const corner of model.CORNERS) {
        const lines = corners[corner].filter(Boolean).map(field => model.line(field, instance));
        if (!lines.length) { drop(entry, 'corner' + corner); continue; }
        const node = part(entry, 'corner' + corner, 'kin-display-corner'); node.textContent = lines.join('\n');
        node.dataset.corner = corner;
        const stock = place[corner] && pane.querySelector(place[corner]), r = stock && rectIn(stock, box);
        const at = corner === 'BL' ? { left: left + 'px', bottom: bottom + 'px' }
          : corner === 'TL' ? { left: (r ? r.left : 8) + 'px', top: (r ? r.top : 8) + 'px' }
          : corner === 'TR' ? { right: (r ? r.right : 8) + 'px', top: (r ? r.top : 8) + 'px', textAlign: 'right' }
          : { right: (r ? r.right : 8) + 'px', bottom: (r ? r.bottom : 8) + 'px', textAlign: 'right' };
        node.removeAttribute('style'); Object.assign(node.style, at);
      }
    } else for (const corner of model.CORNERS) drop(entry, 'corner' + corner);
    drawRuler(v, entry, instance);
    if (overlay.border) {
      const node = part(entry, 'border', 'kin-display-border');
      node.style.border = overlay.width + 'px solid ' + overlay.colour;
    } else drop(entry, 'border');
    drawBadges(v, entry);
  }
  // A 5 cm bar in the image's own scale; none where the image has no usable pixel spacing.
  function rulerOf(v, instance) {
    if (!instance || typeof window.kinPlanarGeometry !== 'function') return { text: 'This image has no pixel spacing; the ruler is not shown.' };
    let geometry;
    try { geometry = window.kinPlanarGeometry(instance, frameOf(v, instance)); } catch (_) { return { text: 'This image has no reliable pixel spacing; the ruler is not shown.' }; }
    try {
      const data = v.getImageData(), spacing = data?.spacing, camera = v.getCamera();
      const a = camera.focalPoint, up = camera.viewUp, b = a.map((n, i) => n + up[i]);
      const [p, q] = [v.worldToCanvas(a), v.worldToCanvas(b)];
      const perWorld = Math.hypot(p[0] - q[0], p[1] - q[1]);
      const pixels = model.rulerPixels(50, geometry.spacing[0], perWorld * (spacing?.[1] || 1));
      if (!pixels) return { text: 'The ruler cannot be measured on this image.' };
      const detector = /detector|ermf/.test(geometry.calculator || '');
      return { pixels, label: '5 cm' + (detector ? ' at detector' : '') };
    } catch (_) { return { text: 'The ruler cannot be measured on this image.' }; }
  }
  function drawRuler(v, entry, instance) {
    const ruler = state.overlay.ruler ? rulerOf(v, instance) : null;
    if (!ruler?.pixels) { drop(entry, 'ruler'); return; }
    const node = part(entry, 'ruler', 'kin-display-ruler');
    node.style.height = Math.round(ruler.pixels) + 'px';
    if (node.firstChild?.textContent !== ruler.label) node.replaceChildren(element('span', ruler.label));
  }
  function drawBadges(v, entry) {
    const list = [];
    const rotation = rotations.get(v.id);
    if (rotation?.applied && rotation.key === keyOf(v)) list.push('Auto-rotated 180°');
    const lut = luts.get(v.id);
    if (lut?.on && lut.key === keyOf(v)) list.push('VOI LUT');
    if (!list.length) { drop(entry, 'badges'); return; }
    const node = part(entry, 'badges', 'kin-display-badges');
    if (node.textContent !== list.join('')) node.replaceChildren(...list.map(text => element('span', text)));
  }

  // ── Auto Rotate 180° (one rule for the automatic turn and Show After) ──
  // Per cell: the display set it was judged for, whether this module turned it 180° and the rotation it left.
  const rotations = new Map(), undone = new Set();
  const rotationOf = v => { try { return ((Number(v.getViewPresentation().rotation) || 0) % 360 + 360) % 360; } catch (_) { return null; } };
  function turn(v, degrees) {
    const presentation = v.getViewPresentation();
    v.setViewPresentation({ ...presentation, rotation: ((Number(presentation.rotation) || 0) + degrees + 360) % 360 });
    v.render();
    return rotationOf(v);
  }
  const judge = v => { const instance = instanceOf(v); return instance?.Modality === 'MG' ? { state: 'mammography' } : model.orientation(instance?.ImageOrientationPatient); };
  function rotationRecord(v) {
    const key = keyOf(v);
    let record = rotations.get(v.id);
    if (record && record.key !== key) {
      // Another display set in this cell: a turn of ours that the cell kept is taken back.
      if (record.applied && rotationOf(v) === record.after) turn(v, -180);
      rotations.delete(v.id); record = null;
    }
    if (!record) rotations.set(v.id, record = { key, applied: false, after: null, checked: false });
    return record;
  }
  function autoRotate(v) {
    const record = rotationRecord(v);
    if (record.checked || !state.autoRotate || undone.has(record.key) || !imageId(v)) return;
    record.checked = true;
    if (judge(v).state === 'rotated-180') { record.after = turn(v, 180); record.applied = true; }
  }

  // ── VOI LUT for standard 2D images (not MG, whose display rules stay as they are) ──
  // Per cell: the display set, the image's stored VOI kind, the reader's choice in this cell (null: the account
  // default) and what this module drew last ('lut' or 'linear').
  const luts = new Map(), applying = new Set(), loading = new Set();
  function lutRecord(v) {
    const key = keyOf(v);
    let record = luts.get(v.id);
    if (!record || record.key !== key) luts.set(v.id, record = { key, override: null, on: false, drawn: null, kind: 'none', spec: null });
    return record;
  }
  function voiSpec(v, preferTable) {
    const instance = instanceOf(v);
    if (!instance || instance.Modality === 'MG' || !window.kinStoredVoi) return null;
    try { return window.kinStoredVoi.spec(instance.SOPInstanceUID, frameOf(v, instance), { preferTable }); } catch (_) { return null; }
  }
  function linear(v) {
    const header = voiSpec(v, false);
    if (header?.voi?.status === 'verified' && !header.voi.lut && ['Window Center/Width', 'Frame VOI LUT'].includes(header.voi.source))
      return window.kinStoredVoi.apply(v, { ...header, voi: { ...header.voi, fn: 'LINEAR' } }) === true;
    // No stored window: the image's own pixel range.
    let low, high;
    try { [low, high] = v.getImageData().imageData.getPointData().getScalars().getRange(); } catch (_) { return false; }
    if (!(Number.isFinite(low) && Number.isFinite(high) && high > low)) return false;
    v.setProperties({ VOILUTFunction: 'LINEAR' });
    v.setVOI({ lower: low, upper: high }, { forceRecreateLUTFunction: true });
    v.render();
    return true;
  }
  function drawVoi(v, record, on) {
    applying.add(v.id);
    try {
      if (on) { record.on = window.kinStoredVoi?.apply(v, record.spec) === true; record.drawn = record.on ? 'lut' : null; }
      else { if (record.drawn === 'lut') linear(v); record.on = false; record.drawn = 'linear'; }
    } catch (error) { console.error(error); record.on = false; }
    finally { applying.delete(v.id); }
  }
  function voiLut(v) {
    const record = lutRecord(v);
    record.spec = voiSpec(v, true);
    record.kind = record.spec?.voi?.status === 'verified' ? model.voiKind(record.spec) : 'none';
    if (record.kind === 'none') { record.on = false; return; }
    const on = record.override ?? state.voiLut;
    // A table on the GPU actor does not survive the next image; a window the reader set is never overwritten.
    if (on || record.drawn === 'lut') drawVoi(v, record, on);
  }
  // A window set by the reader (drag, numbers, a preset) takes the cell to the linear window.
  function voiChanged(event) {
    const v = viewportOf(event.detail?.viewportId); if (!v) return;
    if (applying.has(v.id) || loading.has(v.id)) return;
    const record = luts.get(v.id);
    if (record?.on && record.key === keyOf(v)) { record.on = false; record.override = false; record.drawn = null; }
    refresh();
  }

  // ── Image events ──
  function examine(v) { try { autoRotate(v); voiLut(v); } catch (error) { console.error(error); } refresh(); }
  const fromEvent = event => viewportOf(event.detail?.viewportId) || stacks().find(v => v.element === event.detail?.element) || null;
  const on = (name, fn) => { if (name) document.addEventListener(name, fn, { capture: true, signal }); };
  on(events.PRE_STACK_NEW_IMAGE, event => { const v = fromEvent(event); if (v) loading.add(v.id); });
  for (const name of [events.STACK_NEW_IMAGE, events.VIEWPORT_NEW_IMAGE_SET]) on(name, event => {
    const v = fromEvent(event); if (!v) return;
    examine(v); loading.delete(v.id);
  });
  on(events.CAMERA_MODIFIED, refresh);
  on(events.VOI_MODIFIED, voiChanged);
  on(events.IMAGE_RENDERED, () => { if (!layers.size) refresh(); });
  const subscriptions = [];
  for (const [service, name] of [[grid, grid?.EVENTS?.GRID_STATE_CHANGED], [cells, cells?.EVENTS?.VIEWPORT_DATA_CHANGED]]) {
    if (!name || typeof service?.subscribe !== 'function') continue;
    try { subscriptions.push(service.subscribe(name, refresh)); } catch (error) { console.error(error); }
  }
  addEventListener('resize', refresh, { signal });
  const examineAll = () => { for (const v of stacks()) if (imageId(v)) examine(v); };

  // ── Windows ──
  const painters = new Set();
  function panel(id, title, note) {
    const handle = ui.panel({ id, title });
    if (!handle) return null;
    handle.body.replaceChildren();
    if (note) element('p', note, handle.body, 'kin-display-note');
    return handle;
  }
  const status = parent => { const node = element('p', '', parent, 'kin-display-note'); node.setAttribute('role', 'status'); return node; };
  const savedText = ok => ok ? (store.writable() ? 'Saved to your account.' : 'Applied in this window (not saved to your account).') : 'Could not save. Try again after the current save.';

  function openOverlay() {
    const handle = panel('overlay-items', 'Overlay Items', 'Turn individual image overlays on or off. Changes appear on the image immediately.');
    if (!handle) return;
    const body = handle.body, line = status(body);
    const change = (key, value) => {
      state.overlay = model.overlay({ ...state.overlay, [key]: value });
      refresh();
      save('overlayItems', state.overlay).then(ok => { if (!ended) line.textContent = savedText(ok); });
    };
    const inputs = {};
    for (const [key, label] of [['wl', 'W/L Value'], ['zoom', 'Zoom'], ['ruler', 'Ruler'], ['dicom', 'DICOM Information'], ['border', 'Cell Border']])
      inputs[key] = checkbox(label, state.overlay[key], body, value => change(key, value));
    const colourRow = element('label', 'Border Colour ', body, 'kin-display-row'), colour = element('input', '', colourRow);
    colour.type = 'color'; colour.value = state.overlay.colour.toLowerCase(); colour.setAttribute('aria-label', 'Border Colour');
    colour.onchange = () => change('colour', colour.value);
    const widthRow = element('label', 'Border Width ', body, 'kin-display-row'), width = element('select', '', widthRow);
    width.setAttribute('aria-label', 'Border Width');
    for (const n of [1, 2, 3, 4]) { const option = element('option', String(n), width); option.value = String(n); }
    width.value = String(state.overlay.width); width.onchange = () => change('width', Number(width.value));
    const note = element('p', '', body, 'kin-display-note');
    const paint = () => {
      for (const [key, input] of Object.entries(inputs)) input.checked = state.overlay[key];
      const v = target(); const ruler = state.overlay.ruler && v ? rulerOf(v, instanceOf(v)) : null;
      note.textContent = ruler?.text || '';
    };
    painters.add(paint); handle.onClose(() => painters.delete(paint)); paint();
    handle.focus();
  }

  function openCorners(viewportId) {
    const v = target(viewportId);
    let modality = instanceOf(v || {})?.Modality;
    if (!model.modality(modality)) modality = 'CT';
    const handle = panel('corner-information', 'Corner Information', 'Choose DICOM items for the four image corners for each modality. Enter a DICOM keyword or tag number in Other Tag for items not listed. Apply to Image saves the choice and shows it on images of that modality.');
    if (!handle) return;
    const body = handle.body;
    const modalities = [...new Set([modality, ...Object.keys(state.corners), 'CT', 'MR', 'CR', 'DX', 'MG', 'US', 'XA'])];
    const modalityRow = element('label', 'Modality ', body, 'kin-display-row'), pick = element('select', '', modalityRow);
    pick.setAttribute('aria-label', 'Modality');
    for (const name of modalities) { const option = element('option', name, pick); option.value = name; }
    pick.value = modality;
    let working = null, focused = null;
    const table = element('table', '', body, 'kin-display-table');
    const NAMES = { TL: 'Top Left', TR: 'Top Right', BL: 'Bottom Left', BR: 'Bottom Right' };
    const label = field => model.fieldLabel(field);
    function paint() {
      working ||= structuredClone(state.corners[modality] || model.cornerDefaults());
      table.replaceChildren();
      const head = element('tr', '', table);
      for (const text of ['Corner', 'Line 1', 'Line 2', 'Line 3']) element('th', text, head);
      for (const corner of model.CORNERS) {
        const row = element('tr', '', table); element('td', NAMES[corner], row);
        working[corner].forEach((value, i) => {
          const select = element('select', '', element('td', '', row));
          select.setAttribute('aria-label', NAMES[corner] + ' line ' + (i + 1)); select.dataset.corner = corner; select.dataset.line = String(i);
          const options = ['', ...model.TAGS]; if (value && !options.includes(value)) options.push(value);
          for (const field of options) { const option = element('option', field ? label(field) : '(none)', select); option.value = field; }
          select.value = value;
          select.onchange = () => { working[corner][i] = select.value; };
          select.onfocus = () => { focused = select; };
        });
      }
    }
    pick.onchange = () => { modality = pick.value; working = null; focused = null; paint(); };
    paint();
    const otherRow = element('div', '', body, 'kin-display-row');
    const otherLabel = element('label', 'Other Tag ', otherRow), other = element('input', '', otherLabel);
    other.placeholder = '(0018,0050)'; other.size = 14; other.setAttribute('aria-label', 'Other Tag');
    const line = status(body);
    button('Use in Selected Line', otherRow, () => {
      const field = model.field(other.value);
      if (!field) { line.textContent = 'Enter a DICOM keyword (SliceThickness) or a tag number (0018,0050).'; return; }
      const select = focused?.isConnected ? focused : table.querySelector('select');
      working[select.dataset.corner][Number(select.dataset.line)] = field;
      const keep = select.getAttribute('aria-label'); paint(); focused = table.querySelector('select[aria-label="' + keep + '"]');
      other.value = ''; line.textContent = field + ' is set in ' + keep + '. Apply to Image to use it.';
    });
    const actions = element('div', '', body, 'kin-display-row');
    button('Apply to Image', actions, async () => {
      const next = { ...state.corners, [modality]: structuredClone(working) };
      const ok = await save('cornerInfo', model.corners(next), handle.revision);
      if (ended) return;
      if (ok) { state.corners = model.corners(next); handle.revision = store.revision(); refresh(); }
      line.textContent = savedText(ok);
    });
    button('Restore Stock Overlay', actions, async () => {
      const next = { ...state.corners }; delete next[modality];
      const ok = await save('cornerInfo', Object.keys(next).length ? next : undefined, handle.revision);
      if (ended) return;
      if (ok) { state.corners = next; handle.revision = store.revision(); working = null; paint(); refresh(); }
      line.textContent = savedText(ok);
    });
    handle.focus();
  }

  function openRotate(viewportId) {
    const v = need(viewportId); if (!v) return;
    const handle = panel('auto-rotate', 'Auto Rotate 180°', 'Images whose Image Orientation Patient shows them stored upside-down (both directions reversed) are turned 180° when shown, if Auto Rotate 180° is on in Viewer Settings. Show After turns this image by the same rule.');
    if (!handle) return;
    const body = handle.body, iop = element('p', '', body), verdict = element('p', '', body);
    const actions = element('div', '', body, 'kin-display-row'), line = status(body);
    const STATES = { standard: 'This image is in the standard orientation.', 'rotated-180': 'This image is stored upside-down (180°).',
      mirrored: 'This image is mirrored, not turned; it is left as it is.', other: 'This image is turned by 90° or transposed; it is left as it is.',
      oblique: 'The orientation is oblique; nothing is decided.', missing: 'This image has no Image Orientation Patient.', mammography: 'Mammography images keep their own orientation rule.' };
    const paint = () => {
      const now = viewportOf(v.id); if (!now) return;
      const instance = instanceOf(now);
      iop.textContent = 'Image Orientation Patient: ' + (model.text(instance?.ImageOrientationPatient) || '—');
      verdict.textContent = STATES[judge(now).state] || '';
    };
    button('Show After', actions, () => {
      const now = viewportOf(v.id); if (!now) return;
      const record = rotationRecord(now), result = judge(now).state;
      if (result !== 'rotated-180') { line.textContent = STATES[result]; return; }
      if (record.applied) { line.textContent = 'This image is already turned 180°.'; return; }
      record.after = turn(now, 180); record.applied = true; record.checked = true; undone.delete(record.key);
      line.textContent = 'Turned 180°.'; refresh();
    });
    button('Undo', actions, () => {
      const now = viewportOf(v.id); if (!now) return;
      const record = rotationRecord(now);
      if (!record.applied) { line.textContent = 'There is no 180° turn to undo in this cell.'; return; }
      turn(now, -180); record.applied = false; record.after = null; record.checked = true; undone.add(record.key);
      line.textContent = 'The 180° turn is undone. It is not applied again to this series while the viewer stays open.'; refresh();
    });
    painters.add(paint); handle.onClose(() => painters.delete(paint)); paint();
    handle.focus();
  }

  function openZoom(viewportId) {
    const v = need(viewportId); if (!v) return;
    const handle = panel('zoom', 'Zoom', 'Use a preset button or enter a zoom value. At 100%, the image fits the cell.');
    if (!handle) return;
    const body = handle.body, now = element('p', '', body), presets = element('div', '', body, 'kin-display-row');
    const set = zoom => { const cell = viewportOf(v.id); if (!cell) return; cell.setZoom(zoom); cell.render(); paint(); refresh(); };
    for (const percent of model.ZOOM_PRESETS) button(percent + '%', presets, () => set(percent / 100));
    button('Fit', presets, () => {
      const cell = viewportOf(v.id); if (!cell) return;
      cell.setZoom(1); if (typeof cell.setPan === 'function') cell.setPan([0, 0]); cell.render(); paint(); refresh();
    });
    const typed = element('div', '', body, 'kin-display-row'), label = element('label', 'Zoom ', typed), input = element('input', '', label);
    input.type = 'number'; input.min = String(model.ZOOM_MIN); input.max = String(model.ZOOM_MAX); input.step = '10'; input.setAttribute('aria-label', 'Zoom percent');
    label.append('%');
    const line = status(body);
    const apply = () => {
      const zoom = model.zoomFromPercent(input.value);
      if (!zoom) { line.textContent = 'Enter a zoom from ' + model.ZOOM_MIN + '% to ' + model.ZOOM_MAX + '%.'; return; }
      line.textContent = ''; set(zoom);
    };
    button('Apply', typed, apply);
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } };
    function paint() {
      const cell = viewportOf(v.id), percent = cell && model.zoomPercent(zoomOf(cell));
      now.textContent = 'Current ' + (percent ?? '—') + '%';
      if (document.activeElement !== input && percent) input.value = String(percent);
    }
    painters.add(paint); handle.onClose(() => painters.delete(paint)); paint();
    handle.focus();
  }

  let smart = null;
  function endSmart() { if (!smart) return; const { capture, keys } = smart; smart = null; capture.remove(); keys.abort(); }
  function openSmartZoom(viewportId) {
    const v = need(viewportId); if (!v) return;
    endSmart();
    const handle = panel('smart-zoom', 'Smart Zoom', 'Click a point in the cell: the image is zoomed 2 times around that point, which stays where you clicked. Each click zooms again. Press Escape or Close to stop.');
    if (!handle) return;
    const entry = layerOf(v); if (!entry) { handle.close(); return; }
    const capture = element('div', '', entry.node, 'kin-display-capture');
    element('span', 'Smart Zoom: click where you want to zoom', capture);
    capture.addEventListener('pointerdown', event => {
      event.preventDefault(); event.stopPropagation();
      const cell = viewportOf(v.id); if (!cell) return;
      const r = cell.element.getBoundingClientRect();
      try {
        const world = cell.canvasToWorld([event.clientX - r.left, event.clientY - r.top]);
        const next = model.anchoredZoom(cell.getCamera(), world, 2);
        if (next) { cell.setCamera(next); cell.render(); refresh(); }
      } catch (error) { console.error(error); ui.toast('Smart Zoom could not zoom this image.'); }
    });
    const keys = new AbortController();
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && smart) { event.preventDefault(); event.stopPropagation(); handle.close(); } }, { capture: true, signal: keys.signal });
    smart = { capture, keys, viewportId: v.id };
    handle.onClose(endSmart);
    handle.focus();
  }

  function openPresets(viewportId) {
    const v = target(viewportId);
    let modality = instanceOf(v || {})?.Modality;
    if (!model.modality(modality)) modality = 'CT';
    const handle = panel('wl-presets', 'My W/L Presets', 'Keep your own W/L presets for each modality and apply them to the selected image.');
    if (!handle) return;
    const body = handle.body;
    const head = element('p', '', body), current = element('p', '', body);
    const typed = element('div', '', body, 'kin-display-row');
    const number = (text, label) => { const row = element('label', text + ' ', typed), input = element('input', '', row); input.type = 'number'; input.setAttribute('aria-label', label); input.style.width = '6em'; return input; };
    const width = number('W', 'Window Width'), level = number('L', 'Window Level');
    const line = status(body);
    const cell = () => viewportOf(v?.id) || need();
    const applyWindow = (w, l, name) => {
      const now = cell(); if (!now) return;
      now.setProperties({ voiRange: model.toRange(w, l) }); now.render();
      line.textContent = (name ? name + ': ' : '') + 'W ' + w + ' / L ' + l + ' applied.'; refresh();
    };
    button('Apply', typed, () => {
      const valid = model.preset({ name: 'typed', w: Number(width.value), l: Number(level.value) });
      if (!valid || width.value === '' || level.value === '') { line.textContent = 'Enter W (1 or more) and L as numbers.'; return; }
      applyWindow(valid.w, valid.l);
    });
    const table = element('table', '', body, 'kin-display-table');
    const nameRow = element('div', '', body, 'kin-display-row'), name = element('input', '', nameRow);
    name.placeholder = 'Preset name'; name.maxLength = model.PRESET_NAME; name.setAttribute('aria-label', 'Preset name');
    button('Save Current W/L', nameRow, async () => {
      const now = cell(), value = now && model.fromRange(range(now));
      if (!value) { line.textContent = 'This image has no W/L to save.'; return; }
      const result = model.savePreset(state.presets, modality, { name: name.value, ...value });
      if (!result.ok) {
        line.textContent = { name: 'Enter a preset name.', 'name-length': 'A preset name has at most ' + model.PRESET_NAME + ' characters.', full: 'There are already ' + model.PRESETS_PER_MODALITY + ' presets for ' + modality + '. Delete one first.', numbers: 'This W/L cannot be saved.' }[result.reason] || 'This preset cannot be saved.';
        return;
      }
      const ok = await save('wlPresets', result.value, handle.revision);
      if (ended) return;
      if (ok) { state.presets = result.value; handle.revision = store.revision(); name.value = ''; paint(); }
      line.textContent = savedText(ok);
    });
    function paint() {
      head.textContent = 'Modality: ' + modality;
      const now = viewportOf(v?.id);
      current.textContent = 'Current ' + (now ? wlText(now) : 'W/L —');
      const list = state.presets[modality] || [];
      const signature = JSON.stringify(list);
      if (table.dataset.signature === signature) return;
      table.dataset.signature = signature; table.replaceChildren();
      const top = element('tr', '', table);
      for (const text of ['Name', 'W', 'L', '']) element('th', text, top);
      if (!list.length) { const row = element('tr', '', table), cellNode = element('td', 'No saved presets.', row); cellNode.colSpan = 4; return; }
      for (const item of list) {
        const row = element('tr', '', table); row.dataset.preset = item.name;
        element('td', item.name, row); element('td', String(item.w), row); element('td', String(item.l), row);
        const actions = element('td', '', row);
        button('Apply', actions, () => applyWindow(item.w, item.l, item.name)).setAttribute('aria-label', 'Apply ' + item.name);
        button('Delete', actions, async () => {
          const next = model.deletePreset(state.presets, modality, item.name);
          const ok = await save('wlPresets', Object.keys(next).length ? next : undefined, handle.revision);
          if (ended) return;
          if (ok) { state.presets = next; handle.revision = store.revision(); paint(); }
          line.textContent = ok ? item.name + ' deleted. ' + savedText(ok) : savedText(ok);
        }).setAttribute('aria-label', 'Delete ' + item.name);
      }
    }
    painters.add(paint); handle.onClose(() => painters.delete(paint)); paint();
    handle.focus();
  }

  function openVoi(viewportId) {
    const v = need(viewportId); if (!v) return;
    const handle = panel('voi-lut', 'VOI LUT', 'Turn the image\'s own VOI LUT on or off for standard 2D images. When off, the image uses its Window Center/Width (or its pixel range when it has none). Changing W/L by hand also turns it off for that cell.');
    if (!handle) return;
    const body = handle.body, about = element('p', '', body);
    const input = checkbox('Use VOI LUT', false, body, value => {
      const cell = viewportOf(v.id); if (!cell) return;
      const record = lutRecord(cell);
      if (record.kind === 'none') { paint(); return; }
      record.override = value; drawVoi(cell, record, value); refresh(); paint();
    });
    const line = status(body);
    function paint() {
      const cell = viewportOf(v.id); if (!cell) return;
      const record = lutRecord(cell);
      if (!record.spec && record.kind === 'none') { record.spec = voiSpec(cell, true); record.kind = record.spec?.voi?.status === 'verified' ? model.voiKind(record.spec) : 'none'; }
      const instance = instanceOf(cell);
      about.textContent = instance?.Modality === 'MG' ? 'Mammography images keep their own VOI rule.'
        : record.kind === 'table' ? 'This image carries a VOI LUT (VOI LUT Sequence).'
        : record.kind === 'sigmoid' ? 'This image carries a VOI LUT Function (SIGMOID).' : 'This image has no VOI LUT.';
      input.disabled = record.kind === 'none';
      input.checked = record.kind !== 'none' && record.on;
      line.textContent = record.kind !== 'none' && record.override === false && !record.on ? 'Off in this cell.' : '';
    }
    painters.add(paint); handle.onClose(() => painters.delete(paint)); paint();
    handle.focus();
  }

  // ── Registration (names and order as on the Display menu) ──
  const menu = [
    ['displayOverlayItems', 'Overlay Items…', () => openOverlay()],
    ['displayCornerInformation', 'Corner Information…', ({ viewportId }) => openCorners(viewportId)],
    ['displayAutoRotate', 'Auto Rotate 180°', ({ viewportId }) => openRotate(viewportId)],
    ['displayZoom', 'Zoom…', ({ viewportId }) => openZoom(viewportId)],
    ['displaySmartZoom', 'Smart Zoom', ({ viewportId }) => openSmartZoom(viewportId)],
    ['displayWLPresets', 'My W/L Presets…', ({ viewportId }) => openPresets(viewportId)],
    ['displayVoiLut', 'VOI LUT', ({ viewportId }) => openVoi(viewportId)],
  ];
  menu.forEach(([id, label, run], i) => ui.menuItem('Display', { id, label, order: (i + 1) * 10, run }));
  ui.setting({ id: 'displayAutoRotateCheck', kind: 'check', label: 'Auto Rotate 180° from Image Orientation Patient', order: 40, key: 'autoRotate', default: false });
  ui.setting({ id: 'displayVoiLutCheck', kind: 'check', label: 'Use VOI LUT for standard 2D images', order: 50, key: 'voiLut', default: true });
  ui.setting({ id: 'displayOverlaySettings', kind: 'button', label: 'Overlay Items…', order: 40, run: () => openOverlay() });
  ui.setting({ id: 'displayCornerSettings', kind: 'button', label: 'Corner Information…', order: 41, run: () => openCorners() });
  ui.setting({ id: 'displayPresetSettings', kind: 'button', label: 'My W/L Presets…', order: 42, run: () => openPresets() });

  store.subscribe('overlayItems', value => { state.overlay = model.overlay(value); refresh(); });
  store.subscribe('cornerInfo', value => { state.corners = model.corners(value); refresh(); });
  store.subscribe('wlPresets', value => { state.presets = model.presets(value); refresh(); });
  store.subscribe('autoRotate', value => { const was = state.autoRotate; state.autoRotate = value === true; if (state.autoRotate && !was) examineAll(); });
  store.subscribe('voiLut', value => { state.voiLut = value !== false; examineAll(); });
  examineAll();

  return () => {
    ended = true; endSmart(); abort.abort();
    for (const subscription of subscriptions) try { subscription?.unsubscribe?.(); } catch (_) {}
    for (const entry of layers.values()) { clearPane(entry.pane); entry.node.remove(); }
    layers.clear(); painters.clear(); style.remove();
  };
});
