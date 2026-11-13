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
  // Edits of the account values run one after another: each change is made to the value stored when its turn comes
  // (after the earlier edits saved), at the revision its window stands on then. Resolves { ok, value }.
  let queue = Promise.resolve();
  function edit(key, change, handle) {
    const run = queue.then(async () => {
      if (ended) return { ok: false };
      const value = change(store.get(key));
      if (value === null) return { ok: false, refused: true };
      const revision = handle?.revision;
      const ok = await store.set(key, value, revision != null ? { revision } : {});
      // Saved: the window stands on the new revision. Refused: the stored values were read again and are shown; the
      // next edit is made on them.
      if (handle) handle.revision = store.revision();
      return { ok, value };
    });
    queue = run.catch(() => {});
    return run;
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
  const activeStack = () => viewportOf(grid.getActiveViewportId?.()) || null;
  // The cell an action is for (the one it was started in); no other cell stands in for it.
  const need = viewportId => {
    const v = viewportOf(viewportId);
    if (!v || !imageId(v)) { ui.toast('The selected cell has no image open.'); return null; }
    return v;
  };
  const range = v => { try { return v.getProperties().voiRange || null; } catch (_) { return null; } };
  // W/L ↔ the viewer's window range by the viewer's own conversion (DICOM linear: W 400 / L 40 is −160 … 239).
  const windowLevel = () => window.cornerstone?.utilities?.windowLevel;
  const toRange = (w, l) => { const convert = windowLevel()?.toLowHighRange; return typeof convert === 'function' ? convert(w, l) : model.toRange(w, l); };
  const fromRange = value => {
    const convert = windowLevel()?.toWindowLevel;
    if (typeof convert !== 'function' || !value) return model.fromRange(value);
    const { windowWidth, windowCenter } = convert(value.lower, value.upper);
    return Number.isFinite(windowWidth) && Number.isFinite(windowCenter) ? { w: Math.round(windowWidth), l: Math.round(windowCenter) } : null;
  };
  const wlText = v => { const value = fromRange(range(v)); return value ? 'W ' + value.w + ' / L ' + value.l : 'W/L —'; };

  // The DICOM JSON of an image, read once from the same DICOMweb service the viewer reads, when a corner shows a tag
  // number: undefined while reading, null when there is none.
  const raws = new Map(), UID = /^\d+(?:\.\d+)+$/;
  function rawOf(instance) {
    const sop = instance?.SOPInstanceUID, study = instance?.StudyInstanceUID, series = instance?.SeriesInstanceUID;
    if (![study, series, sop].every(uid => typeof uid === 'string' && uid.length <= 64 && UID.test(uid))) return null;
    if (raws.has(sop)) { const value = raws.get(sop); return value === 'pending' ? undefined : value; }
    raws.set(sop, 'pending');
    if (raws.size > 200) raws.delete(raws.keys().next().value);
    fetch('/dicom-web/studies/' + study + '/series/' + series + '/instances/' + sop + '/metadata', { credentials: 'same-origin', headers: { Accept: 'application/dicom+json' }, signal })
      .then(response => response.ok ? response.json() : null)
      .then(json => { if (ended) return; const item = Array.isArray(json) ? json[0] : null; raws.set(sop, item && typeof item === 'object' ? item : null); refresh(); })
      .catch(() => { if (!ended) { raws.set(sop, null); refresh(); } });
    return undefined;
  }

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
    for (const fn of painters.values()) try { fn(); } catch (error) { console.error(error); }
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
      const raw = model.needsRaw(model.CORNERS.flatMap(corner => corners[corner])) ? rawOf(instance) : null;
      for (const corner of model.CORNERS) {
        const lines = corners[corner].filter(Boolean).map(field => model.line(field, instance, raw));
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
      // Imager Pixel Spacing measures at the detector; corrected by the stored magnification factor (ERMF) it is an
      // estimate at the patient.
      const basis = String(geometry.calculator || '').split(':').pop();
      return { pixels, label: '5 cm' + ({ detector: ' at detector', ermf: ' (ERMF estimate)' }[basis] || '') };
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
  // Per cell: the viewport and display set it was judged for, and whether this module's 180° is in its rotation (it
  // stays there through hand rotations; a camera reset to 0° takes it out).
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
    // A new viewport in the cell starts from its own camera.
    if (record && record.viewport !== v) { rotations.delete(v.id); record = null; }
    if (record && record.key !== key) {
      // Another display set in this cell: this module's 180° is taken back, a hand rotation is left as it is.
      if (record.applied) turn(v, -180);
      rotations.delete(v.id); record = null;
    }
    if (!record) rotations.set(v.id, record = { key, viewport: v, applied: false, checked: false });
    return record;
  }
  function autoRotate(v) {
    const record = rotationRecord(v);
    if (record.checked || !state.autoRotate || undone.has(record.key) || !imageId(v)) return;
    record.checked = true;
    if (judge(v).state === 'rotated-180') { turn(v, 180); record.applied = true; }
  }
  // Reset View puts the rotation back to 0°: this module's turn is no longer in it.
  function cameraReset(event) {
    const v = fromEvent(event), record = v && rotations.get(v.id);
    if (record?.viewport === v && record.applied && rotationOf(v) === 0) { record.applied = false; refresh(); }
  }

  // ── VOI LUT for standard 2D images (not MG, whose display rules stay as they are) ──
  // Per cell: the viewport and display set, the image's stored VOI kind, the check in this cell (null: the account
  // default), whether the reader set a window by hand (kept on later images, always linear), the last image handled and
  // what this module drew last ('lut', 'linear' or 'reader').
  const luts = new Map(), applying = new Set(), loading = new Set();
  function lutRecord(v) {
    const key = keyOf(v);
    let record = luts.get(v.id);
    if (!record || record.key !== key || record.viewport !== v)
      luts.set(v.id, record = { key, viewport: v, override: null, reader: false, on: false, drawn: null, image: null, kind: 'none', spec: null });
    return record;
  }
  const nonLinear = v => { try { const fn = v.getProperties().VOILUTFunction; return !!fn && fn !== 'LINEAR'; } catch (_) { return false; } };
  // The window the reader set, drawn linear: a stored table or a sigmoid does not stay under it.
  function readerLinear(v, record, range) {
    const kept = range || (() => { try { return v.getProperties().voiRange; } catch (_) { return null; } })();
    if (!kept) return;
    applying.add(v.id);
    try { v.setProperties({ VOILUTFunction: 'LINEAR' }); v.setVOI({ lower: kept.lower, upper: kept.upper }, { forceRecreateLUTFunction: true }); v.render(); }
    catch (error) { console.error(error); }
    finally { applying.delete(v.id); }
    record.drawn = 'reader'; record.on = false;
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
      else { linear(v); record.on = false; record.drawn = 'linear'; }
    } catch (error) { console.error(error); record.on = false; }
    finally { applying.delete(v.id); }
  }
  function voiLut(v) {
    const record = lutRecord(v);
    record.spec = voiSpec(v, true);
    record.kind = record.spec?.voi?.status === 'verified' ? model.voiKind(record.spec) : 'none';
    if (record.kind === 'none') { record.on = false; return; }
    const image = imageId(v), fresh = record.image !== image;
    record.image = image;
    // A window the reader set stays, drawn linear.
    if (record.reader) { if (record.drawn === 'lut' || nonLinear(v)) readerLinear(v, record); return; }
    // On: the stored table or function, drawn again for every image (the viewer's own window replaces a table).
    if (record.override ?? state.voiLut) { drawVoi(v, record, true); return; }
    // Off: the header window (or the pixel range), on each new image and wherever a non-linear function came back.
    if (fresh || record.drawn !== 'linear' || nonLinear(v)) drawVoi(v, record, false);
  }
  // A window set by the reader (drag, numbers, a preset): the cell stays on that window, drawn linear, and the check
  // goes off. Events while an image loads or while this module draws are the viewer's own, not the reader's.
  function voiChanged(event) {
    const v = viewportOf(event.detail?.viewportId); if (!v) return;
    if (applying.has(v.id) || loading.has(v.id)) return;
    const record = luts.get(v.id);
    if (record && record.viewport === v && record.key === keyOf(v) && record.kind !== 'none') {
      const was = record.on || record.drawn === 'lut' || nonLinear(v);
      record.reader = true; record.override = false; record.on = false;
      if (was) readerLinear(v, record, event.detail?.range);
      else record.drawn = 'reader';
    }
    refresh();
  }

  // ── Image events ──
  function examine(v) { try { autoRotate(v); voiLut(v); } catch (error) { console.error(error); } refresh(); }
  const fromEvent = event => viewportOf(event.detail?.viewportId) || stacks().find(v => v.element === event.detail?.element) || null;
  const on = (name, fn) => { if (name) document.addEventListener(name, fn, { capture: true, signal }); };
  // An image is loading from PRE_STACK_NEW_IMAGE until the viewer has also applied its per-image properties, which it
  // does after STACK_NEW_IMAGE (later in the same load): the cell is examined at the event and again after that.
  on(events.PRE_STACK_NEW_IMAGE, event => { const v = fromEvent(event); if (v) loading.add(v.id); });
  on(events.STACK_NEW_IMAGE, event => {
    const v = fromEvent(event); if (!v) return;
    loading.add(v.id); examine(v);
    setTimeout(() => { if (ended) return; if (viewportOf(v.id) === v) examine(v); loading.delete(v.id); }, 0);
  });
  on(events.VIEWPORT_NEW_IMAGE_SET, event => { const v = fromEvent(event); if (!v) return; loading.add(v.id); examine(v); loading.delete(v.id); });
  on(events.CAMERA_RESET, cameraReset);
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
  const painters = new Map();
  // A window; one opened for a cell (run) closes when that cell gets other images or the viewer switches patient.
  function panel(id, title, note, run) {
    const handle = ui.panel({ id, title });
    if (!handle) return null;
    handle.body.replaceChildren();
    painters.delete(id);
    if (note) element('p', note, handle.body, 'kin-display-note');
    handle.owner = run || null;
    if (run?.signal) {
      if (run.signal.aborted) { handle.close(); return null; }
      run.signal.addEventListener('abort', () => { if (handle.owner === run) handle.close(); }, { once: true });
    }
    return handle;
  }
  // Keeps the run going while its window is open, so that a change of the cell's images closes the window.
  const until = handle => handle ? new Promise(resolve => handle.onClose(resolve)) : undefined;
  function paints(id, handle, paint) { painters.set(id, paint); handle.onClose(() => { if (painters.get(id) === paint) painters.delete(id); }); paint(); }
  // The cell a window acts on: the same viewport with the same display set, and its run still current.
  function bound(v, run) {
    const key = keyOf(v);
    return () => (!run?.current || run.current()) && viewportOf(v.id) === v && keyOf(v) === key && !document.body.classList.contains('kin-patient-switching');
  }
  const CHANGED = 'The images in this cell changed. Open this window again.';
  const status = parent => { const node = element('p', '', parent, 'kin-display-note'); node.setAttribute('role', 'status'); return node; };
  const savedText = ok => ok ? (store.writable() ? 'Saved to your account.' : 'Applied in this window (not saved to your account).') : 'Not saved to your account. The reason is shown beside Viewer Settings.';

  function openOverlay() {
    const handle = panel('overlay-items', 'Overlay Items', 'Turn individual image overlays on or off. Changes appear on the image immediately.');
    if (!handle) return;
    const body = handle.body, line = status(body);
    const change = (key, value) => {
      state.overlay = model.overlay({ ...state.overlay, [key]: value });
      refresh();
      // The change itself is queued, so an earlier save's answer does not take it back.
      edit('overlayItems', stored => model.overlay({ ...model.overlay(stored), [key]: value })).then(result => {
        if (ended) return;
        line.textContent = savedText(result.ok);
        if (result.ok) { state.overlay = model.overlay({ ...state.overlay, [key]: value }); refresh(); }
      });
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
    paints('overlay-items', handle, () => {
      for (const [key, input] of Object.entries(inputs)) input.checked = state.overlay[key];
      const v = activeStack(); const ruler = state.overlay.ruler && v ? rulerOf(v, instanceOf(v)) : null;
      note.textContent = ruler?.text || '';
    });
    handle.focus();
  }

  function openCorners(viewportId) {
    const v = viewportId ? viewportOf(viewportId) : activeStack();
    let modality = v && instanceOf(v)?.Modality;
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
          for (const field of options) { const option = element('option', model.fieldLabel(field), select); option.value = field; }
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
      const chosen = structuredClone(working), name = modality;
      const result = await edit('cornerInfo', stored => model.corners({ ...model.corners(stored), [name]: chosen }), handle);
      if (ended) return;
      if (result.ok) { state.corners = model.corners(result.value); refresh(); }
      line.textContent = savedText(result.ok);
    });
    button('Restore Stock Overlay', actions, async () => {
      const name = modality;
      const result = await edit('cornerInfo', stored => { const next = model.corners(stored); delete next[name]; return Object.keys(next).length ? next : undefined; }, handle);
      if (ended) return;
      if (result.ok) { state.corners = model.corners(result.value); if (modality === name) { working = null; paint(); } refresh(); }
      line.textContent = savedText(result.ok);
    });
    handle.focus();
  }

  function openRotate(viewportId, run) {
    const v = need(viewportId); if (!v) return;
    const handle = panel('auto-rotate', 'Auto Rotate 180°', 'Images whose Image Orientation Patient shows them stored upside-down (both directions reversed) are turned 180° when shown, if Auto Rotate 180° is on in Viewer Settings. Show After turns this image by the same rule.', run);
    if (!handle) return;
    const ok = bound(v, run);
    const body = handle.body, iop = element('p', '', body), verdict = element('p', '', body);
    const actions = element('div', '', body, 'kin-display-row'), line = status(body);
    const STATES = { standard: 'This image is in the standard orientation.', 'rotated-180': 'This image is stored upside-down (180°).',
      mirrored: 'This image is mirrored, not turned; it is left as it is.', other: 'This image is turned by 90° or transposed; it is left as it is.',
      oblique: 'The orientation is oblique; nothing is decided.', missing: 'This image has no Image Orientation Patient.', mammography: 'Mammography images keep their own orientation rule.' };
    button('Show After', actions, () => {
      if (!ok()) { line.textContent = CHANGED; return; }
      const record = rotationRecord(v), result = judge(v).state;
      if (result !== 'rotated-180') { line.textContent = STATES[result]; return; }
      if (record.applied) { line.textContent = 'This image is already turned 180°.'; return; }
      turn(v, 180); record.applied = true; record.checked = true; undone.delete(record.key);
      line.textContent = 'Turned 180°.'; refresh();
    });
    button('Undo', actions, () => {
      if (!ok()) { line.textContent = CHANGED; return; }
      const record = rotationRecord(v);
      if (!record.applied) { line.textContent = 'There is no 180° turn to undo in this cell.'; return; }
      turn(v, -180); record.applied = false; record.checked = true; undone.add(record.key);
      line.textContent = 'The 180° turn is undone. It is not applied again to this series while the viewer stays open.'; refresh();
    });
    paints('auto-rotate', handle, () => {
      if (!ok()) return;
      iop.textContent = 'Image Orientation Patient: ' + (model.text(instanceOf(v)?.ImageOrientationPatient) || '—');
      verdict.textContent = STATES[judge(v).state] || '';
    });
    handle.focus();
    return until(handle);
  }

  function openZoom(viewportId, run) {
    const v = need(viewportId); if (!v) return;
    const handle = panel('zoom', 'Zoom', 'Use a preset button or enter a zoom value. At 100%, the image fits the cell.', run);
    if (!handle) return;
    const ok = bound(v, run);
    const body = handle.body, now = element('p', '', body), presets = element('div', '', body, 'kin-display-row');
    const typed = element('div', '', body, 'kin-display-row'), label = element('label', 'Zoom ', typed), input = element('input', '', label);
    const line = status(body);
    const set = zoom => { if (!ok()) { line.textContent = CHANGED; return; } v.setZoom(zoom); v.render(); paint(); refresh(); };
    for (const percent of model.ZOOM_PRESETS) button(percent + '%', presets, () => set(percent / 100));
    button('Fit', presets, () => {
      if (!ok()) { line.textContent = CHANGED; return; }
      v.setZoom(1); if (typeof v.setPan === 'function') v.setPan([0, 0]); v.render(); paint(); refresh();
    });
    input.type = 'number'; input.min = String(model.ZOOM_MIN); input.max = String(model.ZOOM_MAX); input.step = '10'; input.setAttribute('aria-label', 'Zoom percent');
    label.append('%');
    const apply = () => {
      const zoom = model.zoomFromPercent(input.value);
      if (!zoom) { line.textContent = 'Enter a zoom from ' + model.ZOOM_MIN + '% to ' + model.ZOOM_MAX + '%.'; return; }
      line.textContent = ''; set(zoom);
    };
    button('Apply', typed, apply);
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); apply(); } };
    function paint() {
      if (!ok()) return;
      const percent = model.zoomPercent(zoomOf(v));
      now.textContent = 'Current ' + (percent ?? '—') + '%';
      if (document.activeElement !== input && percent) input.value = String(percent);
    }
    paints('zoom', handle, paint);
    handle.focus();
    return until(handle);
  }

  let smart = null;
  function endSmart() { if (!smart) return; const { capture, keys } = smart; smart = null; capture.remove(); keys.abort(); }
  function openSmartZoom(viewportId, run) {
    const v = need(viewportId); if (!v) return;
    endSmart();
    const handle = panel('smart-zoom', 'Smart Zoom', 'Click a point in the cell: the image is zoomed 2 times around that point, which stays where you clicked. Each click zooms again. Press Escape or Close to stop.', run);
    if (!handle) return;
    const ok = bound(v, run);
    const entry = layerOf(v); if (!entry) { handle.close(); return; }
    const capture = element('div', '', entry.node, 'kin-display-capture');
    element('span', 'Smart Zoom: click where you want to zoom', capture);
    capture.addEventListener('pointerdown', event => {
      event.preventDefault(); event.stopPropagation();
      if (!ok()) { handle.close(); return; }
      const r = v.element.getBoundingClientRect();
      try {
        const world = v.canvasToWorld([event.clientX - r.left, event.clientY - r.top]);
        const next = model.anchoredZoom(v.getCamera(), world, 2);
        if (next) { v.setCamera(next); v.render(); refresh(); }
      } catch (error) { console.error(error); ui.toast('Smart Zoom could not zoom this image.'); }
    });
    const keys = new AbortController();
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && smart) { event.preventDefault(); event.stopPropagation(); handle.close(); } }, { capture: true, signal: keys.signal });
    smart = { capture, keys };
    handle.onClose(endSmart);
    handle.focus();
    return until(handle);
  }

  function openPresets(viewportId, run) {
    const v = need(viewportId ?? grid.getActiveViewportId?.()); if (!v) return;
    let modality = instanceOf(v)?.Modality;
    if (!model.modality(modality)) modality = 'CT';
    const handle = panel('wl-presets', 'My W/L Presets', 'Keep your own W/L presets for each modality and apply them to the selected image.', run);
    if (!handle) return;
    const ok = bound(v, run);
    const body = handle.body;
    const head = element('p', '', body), current = element('p', '', body);
    const typed = element('div', '', body, 'kin-display-row');
    const number = (text, label) => { const row = element('label', text + ' ', typed), input = element('input', '', row); input.type = 'number'; input.setAttribute('aria-label', label); input.style.width = '6em'; return input; };
    const width = number('W', 'Window Width'), level = number('L', 'Window Level');
    const line = status(body);
    const applyWindow = (w, l, name) => {
      if (!ok()) { line.textContent = CHANGED; return; }
      v.setProperties({ voiRange: toRange(w, l) }); v.render();
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
    const REASONS = { name: 'Enter a preset name.', 'name-length': 'A preset name has at most ' + model.PRESET_NAME + ' characters.',
      full: 'There are already ' + model.PRESETS_PER_MODALITY + ' presets for ' + modality + '. Delete one first.',
      space: 'Your account has no more room for presets. Delete one first.', numbers: 'This W/L cannot be saved.', modality: 'This W/L cannot be saved.' };
    button('Save Current W/L', nameRow, async () => {
      if (!ok()) { line.textContent = CHANGED; return; }
      const value = fromRange(range(v));
      if (!value) { line.textContent = 'This image has no W/L to save.'; return; }
      const item = { name: name.value, ...value }, check = model.savePreset(state.presets, modality, item);
      if (!check.ok) { line.textContent = REASONS[check.reason] || 'This preset cannot be saved.'; return; }
      let reason = null;
      const result = await edit('wlPresets', stored => { const next = model.savePreset(stored, modality, item); if (!next.ok) { reason = next.reason; return null; } return next.value; }, handle);
      if (ended) return;
      if (reason) { line.textContent = REASONS[reason] || 'This preset cannot be saved.'; return; }
      if (result.ok) { state.presets = model.presets(result.value); name.value = ''; paint(); }
      line.textContent = savedText(result.ok);
    });
    function paint() {
      head.textContent = 'Modality: ' + modality;
      current.textContent = 'Current ' + (ok() ? wlText(v) : 'W/L —');
      const list = state.presets[modality] || [];
      const signature = JSON.stringify(list);
      if (table.dataset.signature === signature) return;
      table.dataset.signature = signature; table.replaceChildren();
      const top = element('tr', '', table);
      for (const text of ['Name', 'W', 'L', '']) element('th', text, top);
      if (!list.length) { const row = element('tr', '', table), cell = element('td', 'No saved presets.', row); cell.colSpan = 4; return; }
      for (const item of list) {
        const row = element('tr', '', table); row.dataset.preset = item.name;
        element('td', item.name, row); element('td', String(item.w), row); element('td', String(item.l), row);
        const actions = element('td', '', row);
        button('Apply', actions, () => applyWindow(item.w, item.l, item.name)).setAttribute('aria-label', 'Apply ' + item.name);
        button('Delete', actions, async () => {
          const result = await edit('wlPresets', stored => { const next = model.deletePreset(stored, modality, item.name); return Object.keys(next).length ? next : undefined; }, handle);
          if (ended) return;
          if (result.ok) { state.presets = model.presets(result.value); paint(); }
          line.textContent = result.ok ? item.name + ' deleted. ' + savedText(true) : savedText(false);
        }).setAttribute('aria-label', 'Delete ' + item.name);
      }
    }
    paints('wl-presets', handle, paint);
    handle.focus();
    return until(handle);
  }

  function openVoi(viewportId, run) {
    const v = need(viewportId); if (!v) return;
    const handle = panel('voi-lut', 'VOI LUT', 'Turn the image\'s own VOI LUT on or off for standard 2D images. When off, the image uses its Window Center/Width (or its pixel range when it has none). Changing W/L by hand also turns it off for that cell.', run);
    if (!handle) return;
    const ok = bound(v, run);
    const body = handle.body, about = element('p', '', body);
    const line = status(body);
    const input = checkbox('Use VOI LUT', false, body, value => {
      if (!ok()) { line.textContent = CHANGED; paint(); return; }
      const record = lutRecord(v);
      if (record.kind === 'none') { paint(); return; }
      record.override = value; record.reader = false; drawVoi(v, record, value); refresh(); paint();
    });
    body.append(line);
    function paint() {
      if (!ok()) return;
      const record = lutRecord(v);
      if (!record.spec && record.kind === 'none') { record.spec = voiSpec(v, true); record.kind = record.spec?.voi?.status === 'verified' ? model.voiKind(record.spec) : 'none'; }
      about.textContent = instanceOf(v)?.Modality === 'MG' ? 'Mammography images keep their own VOI rule.'
        : record.kind === 'table' ? 'This image carries a VOI LUT (VOI LUT Sequence).'
        : record.kind === 'sigmoid' ? 'This image carries a VOI LUT Function (SIGMOID).' : 'This image has no VOI LUT.';
      input.disabled = record.kind === 'none';
      input.checked = record.kind !== 'none' && record.on;
      line.textContent = record.kind !== 'none' && record.reader ? 'Off in this cell: the W/L was changed by hand.' : '';
    }
    paints('voi-lut', handle, paint);
    handle.focus();
    return until(handle);
  }

  // ── Registration (names and order as on the Display menu) ──
  const menu = [
    ['displayOverlayItems', 'Overlay Items…', () => openOverlay()],
    ['displayCornerInformation', 'Corner Information…', ({ viewportId }) => openCorners(viewportId)],
    // These act on the cell they were started in, and their window closes when that cell gets other images.
    ['displayAutoRotate', 'Auto Rotate 180°', run => openRotate(run.viewportId, run)],
    ['displayZoom', 'Zoom…', run => openZoom(run.viewportId, run)],
    ['displaySmartZoom', 'Smart Zoom', run => openSmartZoom(run.viewportId, run)],
    ['displayWLPresets', 'My W/L Presets…', run => openPresets(run.viewportId, run)],
    ['displayVoiLut', 'VOI LUT', run => openVoi(run.viewportId, run)],
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
  store.subscribe('voiLut', value => { const was = state.voiLut; state.voiLut = value !== false; if (state.voiLut !== was) examineAll(); });
  examineAll();

  return () => {
    ended = true; endSmart(); abort.abort();
    for (const subscription of subscriptions) try { subscription?.unsubscribe?.(); } catch (_) {}
    for (const entry of layers.values()) { clearPane(entry.pane); entry.node.remove(); }
    layers.clear(); painters.clear(); style.remove();
  };
});
