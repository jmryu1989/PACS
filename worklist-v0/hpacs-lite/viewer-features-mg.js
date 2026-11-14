// Viewer feature module: MG menu — Mirrored, Quadrant Zoom, Tomo (DBT) Slices, Breast Display, Mammo Keypad and
// Magnifier. It registers through viewer-features.js; the calculations are in mg-breast-model.js. Only stack cells with
// an MG image (or a breast tomosynthesis stack) take part. Laterality, view and the stored orientation come from the
// image's own DICOM header (mammography-model.js), read from the same DICOMweb service the viewer reads. Every display
// change is made only when the reader presses for it, is marked on the cell it changed and goes back in one step.
(() => {
  // A Patient ▶ move remounts the viewer, and this module with it: the keypad opens again there with the move's result.
  const carry = { busy: false, message: null, listener: null, reportTarget: null };

  window.KinViewerFeatures?.module('mg', async ({ services, ui }) => {
    await ui.load('mg-breast-model.js');
    const M = window.KinMgBreastModel, core = window.cornerstone, events = core?.Enums?.Events || {};
    const grid = services.viewportGridService, cellService = services.cornerstoneViewportService;
    const abort = new AbortController(), { signal } = abort;
    let ended = false;
    const timers = new Set();

    const element = (tag, text, parent, className) => {
      const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
    };
    const button = (text, parent, click, title) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; if (title) node.title = title; return node; };
    const note = (text, parent) => element('p', text, parent, 'kin-mg-note');
    const statusLine = parent => { const node = element('p', '', parent, 'kin-mg-status'); node.setAttribute('role', 'status'); return node; };
    const style = element('style', `
.kin-mg-layer{position:absolute;inset:0;pointer-events:none;z-index:6}
.kin-mg-badges{position:absolute;left:50%;top:22px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:3px;font:11px sans-serif;color:#fff}
.kin-mg-badges>span{background:#0b182bcc;border:1px solid #E8C547;border-radius:3px;padding:1px 5px;white-space:nowrap}
.kin-mg-capture{position:absolute;inset:0;pointer-events:auto;cursor:zoom-in;touch-action:none}
.kin-mg-capture[data-mode=slab]{cursor:ns-resize}
.kin-mg-outline{position:absolute;inset:0;width:100%;height:100%}
.kin-mg-lens{position:absolute;width:160px;height:160px;border:2px solid #E8C547;border-radius:50%;overflow:hidden;transform:translate(-50%,-50%);box-shadow:0 0 0 1px #000}
.kin-mg-lens>canvas{width:100%;height:100%;display:block}
[data-kin-mg-slab] svg{visibility:hidden!important}
.kin-mg-note{color:var(--kin-ux-secondary);margin:0 0 6px;max-width:34em}
.kin-mg-status{margin:6px 0 0;max-width:34em;min-height:1.2em}
.kin-mg-row{display:flex;flex-wrap:wrap;align-items:center;gap:.4em;margin:6px 0}
.kin-mg-row[hidden],.kin-mg-question[hidden]{display:none}
.kin-mg-patients{margin:4px 0;padding-left:1.4em}
.kin-mg-patients>li[aria-current=true]{font-weight:bold}
.kin-mg-question{border:1px solid #E8C547;border-radius:4px;padding:6px;margin:6px 0;max-width:34em}
`, document.head);

    // ── Cells ──
    const cellIds = () => { try { return [...grid.getState().viewports.keys()]; } catch (_) { return []; } };
    const viewportOf = id => { try { const v = cellService.getCornerstoneViewport(id); return v?.type === 'stack' && v.element?.isConnected ? v : null; } catch (_) { return null; } };
    const imageIdOf = v => { try { return v.getCurrentImageId?.() || null; } catch (_) { return null; } };
    const instanceOf = v => { const id = imageIdOf(v); try { return id ? core.metaData.get('instance', id) || null : null; } catch (_) { return null; } };
    const imageData = v => { try { return v.getImageData()?.imageData || null; } catch (_) { return null; } };
    const opened = () => new URLSearchParams(location.search).get('StudyInstanceUIDs')?.split(',')[0] || null;

    // The DICOM JSON of an image, once per SOP (a Promise of the item or null).
    const raws = new Map(), UID = /^\d+(?:\.\d+)+$/;
    function rawOf(instance) {
      const sop = instance?.SOPInstanceUID, study = instance?.StudyInstanceUID, series = instance?.SeriesInstanceUID;
      if (![study, series, sop].every(uid => typeof uid === 'string' && uid.length <= 64 && UID.test(uid))) return Promise.resolve(null);
      if (!raws.has(sop)) {
        if (raws.size > 200) raws.delete(raws.keys().next().value);
        raws.set(sop, fetch('/dicom-web/studies/' + study + '/series/' + series + '/instances/' + sop + '/metadata',
          { credentials: 'same-origin', headers: { Accept: 'application/dicom+json' }, signal })
          .then(response => response.ok ? response.json() : null)
          .then(json => { const item = Array.isArray(json) ? json[0] : null; return item && typeof item === 'object' ? item : null; })
          .catch(() => { raws.delete(sop); return null; }));
      }
      return raws.get(sop);
    }
    // One cell as the calculations see it: { id, v, imageId, mg, side, view, verified, flipH, flipV, columns, rows, monochrome1, study }.
    async function describe(v) {
      const instance = instanceOf(v), imageId = imageIdOf(v);
      if (!instance || !imageId) return null;
      const item = await rawOf(instance), model = window.KinMammographyModel;
      if (ended || !item || !model) return null;
      let c = null, orientation = null;
      try { c = model.classify(item); } catch (_) { return null; }
      const mg = item['00080060']?.Value?.[0] === 'MG' || !!c.kind || c.basis === 'ct-breast-tomosynthesis';
      const frame = Number(item['00280008']?.Value?.[0]) > 1 ? (v.getCurrentImageIdIndex?.() ?? 0) + 1 : 1;
      try { orientation = model.displaySpec(item, frame).orientation; } catch (_) { orientation = null; }
      const dimensions = (() => { try { return v.getImageData()?.dimensions || null; } catch (_) { return null; } })();
      return { id: v.id, v, imageId, mg, kind: c.kind, basis: c.basis, side: c.laterality, view: c.view, verified: orientation?.status === 'verified',
        flipH: orientation?.flipH, flipV: orientation?.flipV,
        columns: Number(dimensions?.[0] ?? item['00280011']?.Value?.[0]), rows: Number(dimensions?.[1] ?? item['00280010']?.Value?.[0]),
        monochrome1: String(item['00280004']?.Value?.[0] || '').toUpperCase() === 'MONOCHROME1', study: instance.StudyInstanceUID };
    }
    async function mgCells() {
      const list = await Promise.all(cellIds().map(viewportOf).filter(Boolean).map(v => describe(v).catch(() => null)));
      // A cell whose image changed while its header was read is not described by that header.
      return list.filter(cell => cell?.mg && viewportOf(cell.id) === cell.v && imageIdOf(cell.v) === cell.imageId);
    }
    const labelOf = cell => (cell.study === opened() ? 'Current' : 'Prior') + ' · ' + (cell.side || '?') + ' ' + (cell.view || '?');
    const REASONS = { 'orientation-unverified': 'orientation unverified', 'laterality-unknown': 'laterality unknown', 'view-unknown': 'view unknown',
      'size-unknown': 'image size unknown', 'no-image': 'no image' };

    // ── Geometry of a cell: image points (pixel edges 0 … columns), world points and the camera ──
    function toImage(v, world) {
      const data = imageData(v); if (!data || !world) return null;
      const index = data.worldToIndex([...world], new Float64Array(3));
      return [index[0] + 0.5, index[1] + 0.5];
    }
    function toWorld(v, point) {
      const data = imageData(v); if (!data || !point) return null;
      return Array.from(data.indexToWorld([point[0] - 0.5, point[1] - 0.5, 0], new Float64Array(3)));
    }
    function centerOn(v, world) {
      const camera = v.getCamera(), delta = world.map((n, i) => n - camera.focalPoint[i]);
      v.setCamera({ focalPoint: [...world], position: camera.position.map((n, i) => n + delta[i]) });
    }
    const zoomOf = v => { try { const zoom = v.getZoom(); return Number.isFinite(zoom) && zoom > 0 ? zoom : null; } catch (_) { return null; } };
    // CSS pixels one image pixel spans now.
    function perPixel(v) {
      try {
        const camera = v.getCamera(), spacing = v.getImageData().spacing, a = camera.focalPoint, b = a.map((n, i) => n + camera.viewUp[i]);
        const p = v.worldToCanvas(a), q = v.worldToCanvas(b);
        const value = Math.hypot(p[0] - q[0], p[1] - q[1]) * (spacing?.[1] || 1);
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch (_) { return null; }
    }
    const cellSize = v => ({ cellWidth: v.element.clientWidth, cellHeight: v.element.clientHeight });
    // Camera changes this module makes: the cell's own camera events then are not the reader's (no echo between cells).
    const applying = new Set(), lastSet = new Map();
    const signature = v => { try { const c = v.getCamera(); return [c.parallelScale, ...c.focalPoint].map(n => Number(n).toFixed(4)).join(','); } catch (_) { return ''; } };
    function steer(v, change) {
      applying.add(v.id);
      try { change(); v.render(); return true; } catch (error) { console.error(error); return false; }
      finally { lastSet.set(v.id, signature(v)); applying.delete(v.id); }
    }
    const fit = v => steer(v, () => { v.setZoom(1); v.setPan([0, 0]); });

    // ── This module's layer over each cell: badges, the outline, the press layer and the lens ──
    const layers = new Map();
    function layerOf(v) {
      let entry = layers.get(v.id);
      if (entry && (!entry.node.isConnected || entry.viewport !== v)) { entry.node.remove(); layers.delete(v.id); entry = null; }
      if (!entry) {
        const host = ui.cellLayer(v.id); if (!host) return null;
        host.classList.add('kin-mg-layer');
        entry = { node: host, viewport: v, badges: element('div', '', host, 'kin-mg-badges'), marks: new Map(), outline: null, capture: null, lens: null };
        layers.set(v.id, entry);
      }
      return entry;
    }
    function badge(v, key, text) {
      const entry = text ? layerOf(v) : layers.get(v.id);
      if (!entry) return;
      if (!text) { entry.marks.get(key)?.remove(); entry.marks.delete(key); return; }
      let node = entry.marks.get(key);
      if (!node) { node = element('span', '', entry.badges); node.dataset.mgBadge = key; entry.marks.set(key, node); }
      node.textContent = text;
    }
    const clearBadges = key => { for (const entry of layers.values()) { entry.marks.get(key)?.remove(); entry.marks.delete(key); } };

    // ── The breast region of a cell's image now (cached for that image and pixel array) ──
    const regions = new Map();
    function regionOf(cell) {
      const data = imageData(cell.v); if (!data) return { found: false, reason: 'no-pixels' };
      let values; try { values = data.getPointData().getScalars().getData(); } catch (_) { return { found: false, reason: 'no-pixels' }; }
      const cached = regions.get(cell.id);
      if (cached?.imageId === cell.imageId && cached.values === values) return cached.region;
      const region = M.detect(values, cell.columns, cell.rows, { monochrome1: cell.monochrome1 });
      regions.set(cell.id, { imageId: cell.imageId, values, region });
      return region;
    }

    // ── Mirrored ──
    const mirror = { on: false, invert: true, panel: null, status: null, before: new Map() };
    async function openMirrored() {
      const panel = ui.panel({ id: 'mirrored', title: 'Mirrored' });
      if (!panel || panel === mirror.panel) return;
      mirror.panel = panel;
      note('MG 영상의 한 점을 누르세요. 그 자리를 2배로 크게 보이고, 같은 뷰의 다른 칸(반대쪽 유방·과거 검사)은 대응하는 자리를 같은 배율로 보입니다. ' +
        '한 칸의 확대·이동·반전·돋보기도 같은 뷰의 칸에 함께 걸립니다.', panel.body);
      note('대응 자리는 영상 좌표로 정합니다(반대쪽은 좌우 거울). 같은 조직이 아닐 수 있습니다. CC와 MLO 사이에는 걸지 않습니다.', panel.body);
      const label = element('label', '', panel.body, 'kin-mg-row'), invert = element('input', '', label);
      invert.type = 'checkbox'; invert.checked = mirror.invert; invert.setAttribute('aria-label', 'Invert together'); element('span', 'Invert together', label);
      invert.onchange = () => { mirror.invert = invert.checked; };
      const row = element('div', '', panel.body, 'kin-mg-row');
      button('Reset', row, () => resetMirrored(), '켜기 전의 보기로 되돌립니다');
      mirror.status = statusLine(panel.body);
      // Close turns the link off and leaves the views as they are.
      panel.onClose(() => { if (mirror.panel !== panel) return; mirror.on = false; mirror.panel = mirror.status = null; clearBadges('mirrored'); });
      // Reset goes back to the views as they were when Mirrored was turned on (every cell's camera now; the link starts at
      // once — a point pressed before the image headers are read waits for them in pick()).
      mirror.before.clear();
      for (const id of cellIds()) {
        const v = viewportOf(id); if (!v) continue;
        let props = {}; try { props = v.getProperties(); } catch (_) {}
        try { mirror.before.set(id, { viewport: v, imageId: imageIdOf(v), camera: structuredClone(v.getCamera()), invert: !!props.invert }); } catch (_) {}
      }
      mirror.on = true;
      await markUnlinked();
    }
    async function markUnlinked() {
      const list = await mgCells();
      if (!mirror.on) return;
      clearBadges('mirrored');
      const lines = [];
      for (const cell of list) {
        const reason = M.unlinkable(cell);
        if (!reason) continue;
        badge(cell.v, 'mirrored', 'Mirrored: ' + (REASONS[reason] || reason) + ' — not linked');
        lines.push(labelOf(cell) + ': ' + (REASONS[reason] || reason));
      }
      if (mirror.status) mirror.status.textContent = lines.length ? '연동하지 않는 칸 — ' + lines.join(' / ') : '';
    }
    function resetMirrored() {
      for (const [id, before] of mirror.before) {
        const v = viewportOf(id);
        if (v !== before.viewport || imageIdOf(v) !== before.imageId) continue;
        steer(v, () => {
          const { flipHorizontal, flipVertical, ...camera } = before.camera;
          v.setCamera({ ...camera, flipHorizontal, flipVertical });
          if (!!v.getProperties().invert !== before.invert) v.setProperties({ invert: before.invert });
        });
      }
    }
    // A point pressed in one cell: that place twice as large in it and the counterpart in the same view's other cells.
    async function pick(viewportId, canvasPoint) {
      const list = await mgCells(), t = M.targets(viewportId, list);
      if (!mirror.on) return;
      if (t.reason) { if (mirror.status) mirror.status.textContent = '이 칸은 연동할 수 없습니다: ' + (REASONS[t.reason] || t.reason); return; }
      const source = t.source, point = toImage(source.v, source.v.canvasToWorld(canvasPoint));
      if (!point) return;
      for (const cell of [source, ...t.linked.map(id => list.find(c => c.id === id))]) {
        const at = cell === source ? point : M.counterpart(point, source, cell), world = at && toWorld(cell.v, at);
        if (world) steer(cell.v, () => { cell.v.setZoom(2); centerOn(cell.v, world); });
      }
    }
    // A reader's zoom or pan in one MG cell: the same zoom (relative to Fit) and the counterpart centre in the others.
    const pendingCamera = new Set();
    let cameraFrame = 0;
    function cameraChanged(event) {
      const id = event.detail?.viewportId;
      if (!mirror.on || !id || applying.has(id)) return;
      const v = viewportOf(id);
      if (!v || lastSet.get(id) === signature(v)) return;
      pendingCamera.add(id);
      if (!cameraFrame) cameraFrame = requestAnimationFrame(() => { cameraFrame = 0; const ids = [...pendingCamera]; pendingCamera.clear(); ids.forEach(id => followCamera(id)); });
    }
    async function followCamera(sourceId) {
      const list = await mgCells(), t = M.targets(sourceId, list);
      if (!mirror.on || t.reason) return;
      const source = t.source, zoom = zoomOf(source.v), focal = toImage(source.v, source.v.getCamera().focalPoint);
      if (!zoom || !focal) return;
      for (const id of t.linked) {
        const cell = list.find(c => c.id === id), at = M.counterpart(focal, source, cell), world = at && toWorld(cell.v, at);
        if (world) steer(cell.v, () => { cell.v.setZoom(zoom); centerOn(cell.v, world); });
      }
    }
    async function voiChanged(event) {
      const id = event.detail?.viewportId;
      if (!mirror.on || !mirror.invert || !id || applying.has(id)) return;
      const list = await mgCells(), t = M.targets(id, list);
      if (!mirror.on || t.reason) return;
      let invert; try { invert = !!t.source.v.getProperties().invert; } catch (_) { return; }
      for (const target of t.linked) {
        const v = list.find(c => c.id === target)?.v;
        try { if (v && !!v.getProperties().invert !== invert) steer(v, () => v.setProperties({ invert })); } catch (error) { console.error(error); }
      }
    }
    // A press without a drag in an MG cell while Mirrored is on is a point.
    let press = null;
    document.addEventListener('pointerdown', event => {
      press = null;
      if (!mirror.on || event.button !== 0) return;
      const v = cellIds().map(viewportOf).find(v => v?.element.contains(event.target));
      if (v) press = { id: v.id, x: event.clientX, y: event.clientY };
    }, { capture: true, signal });
    document.addEventListener('pointerup', event => {
      const start = press; press = null;
      if (!start || !mirror.on || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const v = viewportOf(start.id); if (!v) return;
      const rect = v.element.getBoundingClientRect();
      pick(start.id, [event.clientX - rect.left, event.clientY - rect.top]).catch(error => console.error(error));
    }, { capture: true, signal });

    // ── Magnifier: while pressed, the place under the pointer twice as large (and its counterparts with Mirrored on) ──
    const lens = { on: false };
    const LENS = 160, LENS_ZOOM = 2;
    function lensAt(v, point) {
      const entry = layerOf(v); if (!entry) return;
      if (!entry.lens) { entry.lens = element('div', '', entry.node, 'kin-mg-lens'); element('canvas', '', entry.lens); }
      const canvas = entry.lens.firstChild, source = v.canvas, ratio = source && source.clientWidth ? source.width / source.clientWidth : 1;
      canvas.width = Math.round(LENS * ratio); canvas.height = Math.round(LENS * ratio);
      Object.assign(entry.lens.style, { left: point[0] + 'px', top: point[1] + 'px' });
      entry.lens.dataset.at = point.map(n => Math.round(n)).join(',');
      const side = LENS / LENS_ZOOM * ratio;
      try { canvas.getContext('2d').drawImage(source, point[0] * ratio - side / 2, point[1] * ratio - side / 2, side, side, 0, 0, canvas.width, canvas.height); }
      catch (_) { /* a canvas not drawn yet */ }
    }
    const hideLenses = () => { for (const entry of layers.values()) { entry.lens?.remove(); entry.lens = null; } };
    async function magnify(viewportId, point) {
      const v = viewportOf(viewportId); if (!v) return;
      hideLenses(); lensAt(v, point);
      if (!mirror.on) return;
      const list = await mgCells(), t = M.targets(viewportId, list);
      if (t.reason || !lens.pressed) return;
      const at = toImage(v, v.canvasToWorld(point));
      for (const id of t.linked) {
        const cell = list.find(c => c.id === id), p = at && M.counterpart(at, t.source, cell), world = p && toWorld(cell.v, p);
        if (world) lensAt(cell.v, cell.v.worldToCanvas(world));
      }
    }

    // ── The press layer: the Magnifier on every MG cell, the slab cell's wheel (its mouse tools are off) ──
    function pressLayers(list) {
      const want = new Map();
      if (lens.on) for (const cell of list) want.set(cell.id, 'lens');
      if (tomo.slabbed) want.set(tomo.slabbed.id, lens.on ? 'lens' : 'slab');
      for (const [id, entry] of layers) if (!want.has(id) && entry.capture) { entry.capture.remove(); entry.capture = null; }
      for (const [id, mode] of want) {
        const v = viewportOf(id), entry = v && layerOf(v); if (!entry) continue;
        if (!entry.capture) {
          entry.capture = element('div', '', entry.node, 'kin-mg-capture');
          const at = event => { const r = entry.capture.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top]; };
          entry.capture.addEventListener('pointerdown', event => {
            event.stopPropagation(); event.preventDefault();
            if (entry.capture.dataset.mode !== 'lens' || event.button !== 0) return;
            entry.capture.setPointerCapture?.(event.pointerId); lens.pressed = true; magnify(id, at(event));
          });
          entry.capture.addEventListener('pointermove', event => { if (lens.pressed && entry.capture.dataset.mode === 'lens') magnify(id, at(event)); });
          for (const type of ['pointerup', 'pointercancel']) entry.capture.addEventListener(type, () => { lens.pressed = false; hideLenses(); });
          entry.capture.addEventListener('mousedown', event => event.stopPropagation());
          entry.capture.addEventListener('wheel', event => {
            if (tomo.slabbed?.id !== id) return;
            event.preventDefault(); event.stopPropagation(); tomoStep(Math.sign(event.deltaY) || 1);
          }, { passive: false });
          entry.capture.addEventListener('contextmenu', event => event.preventDefault());
        }
        entry.capture.dataset.mode = mode;
      }
    }
    async function setMagnifier(on) {
      lens.on = on; lens.pressed = false; hideLenses();
      pressLayers(on ? await mgCells() : []);
      ui.toast(on ? 'Magnifier: MG 영상을 누르고 있는 동안 그 자리를 2배로 보입니다. MG ▾ › Magnifier로 끕니다.' : 'Magnifier를 껐습니다.');
    }

    // ── Quadrant Zoom ──
    const quad = { panel: null, step: 0 };
    function openQuadrant() {
      const panel = ui.panel({ id: 'quadrant', title: 'Quadrant Zoom' });
      if (!panel || panel === quad.panel) return;
      quad.panel = panel; quad.step = 0;
      const order = element('label', '', panel.body, 'kin-mg-row'); element('span', 'Order', order);
      const select = element('select', '', order); select.setAttribute('aria-label', 'Order');
      element('option', 'R/L symmetric', select).value = 'symmetric';
      const heading = element('b', '', panel.body);
      const row = element('div', '', panel.body, 'kin-mg-row');
      button('Previous Quadrant', row, () => show(quad.step - 1));
      button('Next Quadrant', row, () => show(quad.step + 1));
      note('모든 MG 칸이 같은 사분면을 칸에 채워 보입니다(유방 영역의 상자를 가로·세로 반으로 나눈 것 — 영역을 찾지 못한 칸은 영상 전체). 좌우는 거울입니다. ' +
        '한 장의 뷰는 사분면 이름의 한 축만 보입니다(CC: 가쪽/안쪽, MLO: 위/아래). 보이지 않는 축의 두 단계는 흉벽 쪽과 유두 쪽을 나누어 훑는 순서이며, 해부학적 사분면을 구분한 것이 아닙니다.', panel.body);
      const status = statusLine(panel.body);
      async function show(step) {
        quad.step = ((step % 4) + 4) % 4;
        heading.textContent = `Quadrant ${quad.step + 1}/4: ${M.QUADRANTS[quad.step]} (R/L matched)`;
        const skipped = [];
        for (const cell of await mgCells()) {
          if (quad.panel !== panel) return;
          const reason = M.unlinkable(cell);
          if (reason) { skipped.push(labelOf(cell) + ': ' + (REASONS[reason] || reason)); badge(cell.v, 'quadrant', 'Quadrant: ' + (REASONS[reason] || reason)); continue; }
          const region = regionOf(cell), q = M.quadrant(quad.step, cell, region.found ? region.box : null);
          const zoom = M.fitRect({ zoom: zoomOf(cell.v), perPixel: perPixel(cell.v), ...cellSize(cell.v), width: q.box.x1 - q.box.x0, height: q.box.y1 - q.box.y0 });
          const world = toWorld(cell.v, [(q.box.x0 + q.box.x1) / 2, (q.box.y0 + q.box.y1) / 2]);
          if (!zoom || !world) continue;
          steer(cell.v, () => { cell.v.setZoom(zoom); centerOn(cell.v, world); });
          badge(cell.v, 'quadrant', `Q${quad.step + 1} ${q.name}` + (region.found ? '' : ' · whole image'));
        }
        status.textContent = skipped.length ? '방향을 확인할 수 없어 확대하지 않은 칸 — ' + skipped.join(' / ') : '';
      }
      panel.onClose(async () => {
        if (quad.panel !== panel) return;
        quad.panel = null; clearBadges('quadrant');
        for (const cell of await mgCells()) fit(cell.v);
      });
      show(0);
    }

    // ── Tomo (DBT) Slices ──
    const tomo = { panel: null, v: null, id: null, imageIds: null, timer: 0, step: 1, slab: 1, ticket: 0, original: null, applied: null, slabbed: null, sync: null };
    const idsOf = v => { try { return v.getImageIds?.() || []; } catch (_) { return []; } };
    const indexOf = v => { try { return v.getCurrentImageIdIndex(); } catch (_) { return 0; } };
    function tomoGo(index) {
      const v = tomo.v; if (!v || viewportOf(tomo.id) !== v) return;
      const total = idsOf(v).length, at = Math.max(0, Math.min(total - 1, index));
      try { Promise.resolve(core.utilities.jumpToSlice(v.element, { imageIndex: at })).catch(error => console.error(error)); } catch (error) { console.error(error); }
    }
    const tomoStep = direction => { if (tomo.v) tomoGo(indexOf(tomo.v) + direction * tomo.step); };
    function stopPlay() {
      if (!tomo.timer) return;
      clearInterval(tomo.timer); timers.delete(tomo.timer); tomo.timer = 0; tomo.sync?.();
    }
    function play() {
      const v = tomo.v; if (!v) return;
      if (tomo.timer) { stopPlay(); return; }
      // One player at a time: the viewer's own Cine stops in this cell while this plays, and this stops when it starts.
      const cine = services.cineService;
      try { cine?.setCine?.({ id: v.id, isPlaying: false }); cine?.stopClip?.(v.element, { viewportId: v.id }); } catch (_) {}
      const rate = Number(cine?.getState?.()?.cines?.[v.id]?.frameRate) || 24;
      tomo.timer = setInterval(() => {
        if (!tomo.v || viewportOf(tomo.id) !== tomo.v) { stopPlay(); return; }
        const total = idsOf(tomo.v).length, next = indexOf(tomo.v) + tomo.step;
        tomoGo(next >= total ? 0 : next);
      }, 1000 / Math.max(1, Math.min(60, rate)));
      timers.add(tomo.timer); tomo.sync?.();
    }
    function cineChanged() {
      try { if (tomo.timer && services.cineService.getState().cines?.[tomo.id]?.isPlaying) stopPlay(); } catch (_) {}
    }
    // The slab: the mean of the slices around the one shown, drawn in the cell's own display array. The array as it was
    // (a copy, for that viewport, stack and image) comes back at 1 slice, Close, and whenever the cell changes.
    const pixelsOf = image => { try { return image.voxelManager?.getScalarData?.() || image.getPixelData?.() || null; } catch (_) { return null; } };
    function planeOf(image) {
      let plane = null; try { plane = core.metaData.get('imagePlaneModule', image.imageId); } catch (_) {}
      const list = value => value ? Array.from(value).map(Number) : null;
      return { rows: image.rows, columns: image.columns, slope: image.slope ?? null, intercept: image.intercept ?? null, scaled: !!image.preScale?.scaled,
        rowCosines: list(plane?.rowCosines), columnCosines: list(plane?.columnCosines), position: list(plane?.imagePositionPatient),
        spacing: plane?.rowPixelSpacing != null ? [Number(plane.rowPixelSpacing), Number(plane.columnPixelSpacing)] : null };
    }
    function scalarsOf(v) { try { return v.getImageData().imageData.getPointData().getScalars(); } catch (_) { return null; } }
    function putScalars(v, array) {
      const scalars = scalarsOf(v); if (!scalars) return false;
      scalars.setData(array, scalars.getNumberOfComponents?.() || 1);
      v.getImageData().imageData.modified();
      v.render();
      return true;
    }
    function restoreSlab() {
      const v = tomo.v, original = tomo.original, applied = tomo.applied;
      tomo.applied = null; tomo.ticket++;
      if (tomo.slabbed) { const pane = viewportOf(tomo.slabbed.id)?.element.closest('[data-cy=viewport-pane]'); if (pane) delete pane.dataset.kinMgSlab; badge(tomo.slabbed.v, 'slab', null); }
      tomo.slabbed = null;
      if (v && original && applied && viewportOf(original.id) === original.viewport && imageIdOf(v) === original.imageId && scalarsOf(v)?.getData() === applied.array)
        try { putScalars(v, original.copy); } catch (error) { console.error(error); }
      tomo.original = null;
      mgCells().then(pressLayers).catch(() => {});
    }
    async function drawSlab() {
      const v = tomo.v, ticket = ++tomo.ticket;
      if (!v || tomo.slab <= 1) { restoreSlab(); return; }
      const ids = idsOf(v), center = indexOf(v), shownId = imageIdOf(v), range = M.slabRange(center, tomo.slab, ids.length);
      if (!range || ids[center] !== shownId) return;
      const scalars = scalarsOf(v); if (!scalars) return;
      // The array on screen is this slice's own unless it is the slab drawn last for this same slice.
      const current = scalars.getData();
      if (!(tomo.applied?.array === current && tomo.original?.imageId === shownId && tomo.original.viewport === v))
        tomo.original = { id: tomo.id, viewport: v, imageId: shownId, copy: current.slice() };
      let images;
      try { images = await Promise.all(ids.slice(range.first, range.last + 1).map(id => core.imageLoader.loadAndCacheImage(id))); }
      catch (_) { if (ticket === tomo.ticket) tomo.sync?.('Slab: 단면을 불러오지 못했습니다.'); return; }
      if (ended || ticket !== tomo.ticket || viewportOf(tomo.id) !== v || imageIdOf(v) !== shownId) return;
      const arrays = images.map(pixelsOf), own = arrays[center - range.first], copy = tomo.original.copy;
      // Same grid, same conversion, and the slice's own pixels (the averaging input) are the values shown, every one of them:
      // the slices are averaged in the very value space the cell draws.
      let sameValues = !!own && own.length === copy.length;
      for (let i = 0; sameValues && i < copy.length; i++) if (own[i] !== copy[i]) sameValues = false;
      if (!M.slabCompatible(images.map(planeOf)) || !sameValues || arrays.some(a => !a || a.length !== copy.length)) {
        tomo.sync?.('Slab: 격자나 픽셀 값 변환이 다른 단면이 있어 합치지 않았습니다.'); return;
      }
      const out = new copy.constructor(copy.length);
      if (!M.slabAverage(arrays, out) || !putScalars(v, out)) return;
      tomo.applied = { array: out, range };
      tomo.slabbed = { id: tomo.id, v };
      const pane = v.element.closest('[data-cy=viewport-pane]'); if (pane) pane.dataset.kinMgSlab = 'on';
      badge(v, 'slab', M.slabLabel(range));
      pressLayers(await mgCells());
      tomo.sync?.();
    }
    // The DBT cell: the active cell when the classifier confirms it holds a breast tomosynthesis stack, else the first such
    // cell; a CT, MR or other multi-image stack is never a Tomo cell.
    async function openTomo(viewportId) {
      let v = null;
      const candidates = [viewportOf(viewportId), ...cellIds().map(viewportOf)].filter((view, i, list) => view && list.indexOf(view) === i && idsOf(view).length > 1);
      for (const view of candidates) {
        const cell = await describe(view).catch(() => null);
        if (cell && (cell.kind === 'dbt' || cell.basis === 'ct-breast-tomosynthesis')) { v = view; break; }
      }
      if (ended) return;
      const panel = ui.panel({ id: 'tomo', title: 'Tomo (DBT) Slices' });
      if (!panel || panel === tomo.panel) return;
      tomo.panel = panel; tomo.v = v; tomo.id = v?.id ?? null; tomo.imageIds = v ? idsOf(v) : null; tomo.step = 1; tomo.slab = 1;
      const label = element('b', '', panel.body);
      const slider = element('input', '', panel.body); slider.type = 'range'; slider.min = '1'; slider.setAttribute('aria-label', 'Slice'); slider.style.width = '100%';
      const row = element('div', '', panel.body, 'kin-mg-row');
      const prev = button('◀ Prev', row, () => tomoStep(-1)), playButton = button('Play', row, () => play()), next = button('Next ▶', row, () => tomoStep(1));
      const choose = (name, options, change) => {
        const holder = element('label', '', panel.body, 'kin-mg-row'); element('span', name, holder);
        const select = element('select', '', holder); select.setAttribute('aria-label', name);
        for (const [value, text] of options) element('option', text, select).value = value;
        select.onchange = () => change(Number(select.value)); return select;
      };
      const step = choose('Step Interval', [1, 2, 3, 5, 10].map(n => [n, n + (n === 1 ? ' slice' : ' slices')]), n => { tomo.step = n; });
      const slab = choose('Slab Thickness', [1, 3, 5, 10].map(n => [n, n + (n === 1 ? ' slice' : ' slices')]), n => { tomo.slab = n; drawSlab(); });
      note('Slab Thickness: 지금 단면을 가운데로 한 n장의 평균을 이 칸에 그립니다(짝수는 뒤쪽으로 한 장 더, 끝에서는 있는 장만). ' +
        'Slab을 보는 동안 이 칸의 측정 표시와 마우스 도구는 꺼지고, 휠은 단면을 넘깁니다. 1 slice로 돌리면 원래 단면입니다.', panel.body);
      const status = statusLine(panel.body);
      let message = '';
      tomo.sync = text => {
        if (text !== undefined) message = text;
        const live = tomo.v && viewportOf(tomo.id) === tomo.v;
        const total = live ? idsOf(tomo.v).length : 0, at = live ? indexOf(tomo.v) + 1 : 0;
        label.textContent = live ? `Slice ${at} / ${total}` : 'Slice — / —';
        slider.max = String(Math.max(1, total)); slider.value = String(at || 1);
        playButton.textContent = tomo.timer ? 'Stop' : 'Play';
        for (const node of [slider, prev, next, playButton, step, slab]) node.disabled = !live;
        status.textContent = !v ? '여러 단면이 있는 DBT(유방 단층) 칸이 없습니다. DBT 칸을 고른 뒤 다시 여세요.' : !live ? '칸의 영상이 바뀌어 멈췄습니다. 다시 여세요.' : message;
      };
      slider.oninput = () => tomoGo(Number(slider.value) - 1);
      panel.onClose(() => {
        if (tomo.panel !== panel) return;
        stopPlay(); restoreSlab();
        tomo.panel = tomo.v = tomo.id = tomo.sync = null;
      });
      tomo.sync('');
    }
    // The tomo cell shows a new slice (scrolled, played): the panel follows and a slab is drawn again for it.
    function tomoImage(event) {
      if (!tomo.panel || event.detail?.viewportId !== tomo.id) return;
      tomo.sync?.();
      if (tomo.slab > 1) drawSlab();
    }
    // The tomo cell was given other images, or the grid changed: stop, and the cell's own array comes back.
    function tomoCell(ids) {
      if (!tomo.panel || (ids && !ids.includes(tomo.id))) return;
      const v = viewportOf(tomo.id);
      if (v === tomo.v && JSON.stringify(idsOf(v)) === JSON.stringify(tomo.imageIds)) return;
      stopPlay(); restoreSlab(); tomo.v = null; tomo.sync?.();
    }

    // ── Breast Display ──
    const PITCH_KEY = 'kin-mg-monitor-pitch:v1';
    const pitches = () => { try { const value = JSON.parse(localStorage.getItem(PITCH_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; } };
    // The screen this window stands on. With the window-management permission already granted (it is never asked for here)
    // the browser's own screen details name it (label, place, size); otherwise the size and place of window.screen. That is
    // a key of the screen arrangement now, not a lasting monitor id: without one, or with two screens alike, there is no
    // key and no stored value is reused.
    let screenDetails = null;
    (async () => {
      try {
        const permission = await navigator.permissions?.query?.({ name: 'window-management' });
        if (permission?.state !== 'granted' || typeof window.getScreenDetails !== 'function' || ended) return;
        screenDetails = await window.getScreenDetails();
        for (const type of ['currentscreenchange', 'screenschange']) screenDetails.addEventListener?.(type, event => screenChanged(event), { signal });
      } catch (_) { screenDetails = null; }
    })();
    function screenNow() {
      const dpr = window.devicePixelRatio || 1, s = screenDetails?.currentScreen;
      if (!s) return { key: M.monitorKey(window.screen), dpr };
      const keyOf = o => M.monitorKey(o) && (o.label || '') + '|' + M.monitorKey(o);
      const key = keyOf(s), twins = (screenDetails.screens || [s]).filter(o => keyOf(o) === key).length;
      return { key: twins > 1 ? null : key, dpr };
    }
    // The browser's zoom or the screen's scale changed (devicePixelRatio).
    let dprQuery = null;
    const onDpr = event => { watchDpr(); screenChanged(event); };
    function watchDpr() {
      dprQuery?.removeEventListener?.('change', onDpr);
      try { dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)'); dprQuery.addEventListener?.('change', onDpr); } catch (_) { dprQuery = null; }
    }
    watchDpr();    const pitchFor = key => { const value = key ? pitches()[key] : undefined; return M.validPitch(value) ? value : null; };
    function savePitch(key, value) {
      if (!key || !M.validPitch(value)) return false;
      try { localStorage.setItem(PITCH_KEY, JSON.stringify({ ...pitches(), [key]: value })); return true; } catch (_) { return false; }
    }
    const show = { panel: null, status: null, pitchRow: null, edge: false, wl: new Map(), modes: new Map(), screen: null, sessionPitch: null };
    const setMode = (v, text) => { show.modes.set(v.id, { viewport: v, text }); badge(v, 'zoom', 'Zoom mode: ' + text); };
    function geometryOf(v) {
      const instance = instanceOf(v);
      if (!instance || typeof window.kinPlanarGeometry !== 'function') return null;
      try {
        const frame = Number(instance.NumberOfFrames) > 1 ? indexOf(v) + 1 : 1, g = window.kinPlanarGeometry(instance, frame);
        return g?.spacing ? { spacing: Number(g.spacing[0]), basis: String(g.calculator || '').split(':').pop() } : null;
      } catch (_) { return null; }
    }
    function drawOutline(cell, region) {
      const entry = layerOf(cell.v); if (!entry) return;
      if (!entry.outline) entry.outline = element('canvas', '', entry.node, 'kin-mg-outline');
      const canvas = entry.outline, width = cell.v.element.clientWidth, height = cell.v.element.clientHeight, ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      const g = canvas.getContext('2d'); g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, width, height);
      g.strokeStyle = '#E8C547'; g.lineWidth = 1.5; g.beginPath();
      region.outline.forEach((point, i) => { const p = cell.v.worldToCanvas(toWorld(cell.v, point)); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
      g.closePath(); g.stroke();
      canvas.dataset.points = String(region.outline.length);
    }
    async function drawEdges() {
      for (const entry of layers.values()) { entry.outline?.remove(); entry.outline = null; }
      clearBadges('edge');
      if (!show.edge) return;
      for (const cell of await mgCells()) {
        const region = regionOf(cell);
        if (region.found) drawOutline(cell, region); else badge(cell.v, 'edge', '경계를 찾지 못했습니다');
      }
    }
    // The cell's VOI as it is (window, function, inversion and a stored table on the GPU actor), and back.
    function transfer(v) { try { return v.getDefaultActor()?.actor?.getProperty().getRGBTransferFunction(0) || null; } catch (_) { return null; } }
    function voiNow(v) {
      const props = v.getProperties(), tf = transfer(v), nodes = [];
      if (tf) for (let i = 0; i < tf.getSize(); i++) { const node = []; tf.getNodeValue(i, node); nodes.push(node.slice(0, 6)); }
      return { voiRange: props.voiRange ? { ...props.voiRange } : null, VOILUTFunction: props.VOILUTFunction, invert: !!props.invert, nodes };
    }
    function voiBack(v, before) {
      v.setProperties({ VOILUTFunction: before.VOILUTFunction, invert: before.invert });
      if (before.voiRange) v.setVOI({ ...before.voiRange }, { forceRecreateLUTFunction: true });
      const tf = transfer(v);
      if (tf && before.nodes.length) { tf.removeAllPoints(); for (const [x, r, g, b, mid, sharp] of before.nodes) tf.addRGBPointLong(x, r, g, b, mid ?? 0.5, sharp ?? 0); }
      v.render();
    }
    function wlOff() {
      for (const [id, entry] of show.wl) {
        const v = viewportOf(id);
        if (v === entry.viewport && stackKey(v) === entry.stack) try { applying.add(id); voiBack(v, entry.before); } catch (error) { console.error(error); } finally { applying.delete(id); }
        badge(entry.viewport, 'wl', null);
      }
      show.wl.clear();
    }
    async function breastWl() {
      if (show.wl.size) { wlOff(); say('Breast W/L을 껐습니다. 원래 창(VOI LUT·반전 포함)으로 돌아갔습니다.'); return; }
      const failed = [];
      for (const cell of await mgCells()) {
        const region = regionOf(cell);
        let values; try { values = imageData(cell.v).getPointData().getScalars().getData(); } catch (_) { values = null; }
        const window_ = region.found && values ? M.regionWindow(values, cell.columns, cell.rows, region) : null;
        if (!window_) { failed.push(labelOf(cell)); badge(cell.v, 'wl', 'Breast W/L: 경계를 찾지 못했습니다'); continue; }
        const before = voiNow(cell.v);
        applying.add(cell.id);
        try {
          cell.v.setProperties({ VOILUTFunction: 'LINEAR', invert: before.invert });
          cell.v.setVOI({ lower: window_.lower, upper: window_.upper }, { forceRecreateLUTFunction: true }); cell.v.render();
        } finally { applying.delete(cell.id); }
        show.wl.set(cell.id, { viewport: cell.v, stack: stackKey(cell.v), before, window: window_ });
        badge(cell.v, 'wl', 'Breast W/L');
      }
      say(failed.length ? '경계를 찾지 못해 창을 바꾸지 않은 칸 — ' + failed.join(' / ') : 'Breast W/L: 유방 영역 픽셀(1–99 백분위)로 창을 정했습니다. 다시 누르면 원래 창입니다.');
    }
    const say = text => { if (show.status) show.status.textContent = text; };
    async function zoomMode(kind) {
      const list = await mgCells(), skipped = [];
      if (kind === 'match') {
        const groups = new Map();
        for (const cell of list) { if (!cell.view) { skipped.push(labelOf(cell)); continue; } groups.set(cell.view, [...(groups.get(cell.view) || []), cell]); }
        for (const group of groups.values()) {
          const entries = group.map(cell => { const region = regionOf(cell); if (!region.found) skipped.push(labelOf(cell));
            return { cell, region, id: cell.id, zoom: zoomOf(cell.v), perPixel: perPixel(cell.v), length: region.found ? region.box.x1 - region.box.x0 : 0 }; });
          const zooms = M.matchSize(entries);
          for (const entry of entries) if (zooms[entry.id]) { steer(entry.cell.v, () => entry.cell.v.setZoom(zooms[entry.id])); setMode(entry.cell.v, 'Match Size'); }
        }
        say(skipped.length ? '경계를 찾지 못해 맞추지 않은 칸 — ' + skipped.join(' / ') : 'Match Size: 같은 뷰의 칸끼리 흉벽–유두 길이를 화면에서 같게 맞췄습니다(가장 작게 보이던 칸에 맞춤).');
        return;
      }
      if (kind === 'true') {
        const now = screenNow(), pitch = pitchFor(now.key) ?? (show.sessionPitch?.key === now.key && now.key === null ? show.sessionPitch.value : null);
        if (!pitch) { openPitch(); return; }
        show.screen = now;
        for (const cell of list) {
          const g = geometryOf(cell.v), zoom = g && M.trueSize({ zoom: zoomOf(cell.v), perPixel: perPixel(cell.v), spacing: g.spacing, pitch, dpr: now.dpr });
          if (!zoom) { skipped.push(labelOf(cell)); continue; }
          steer(cell.v, () => cell.v.setZoom(zoom)); setMode(cell.v, M.trueSizeLabel(g.basis));
        }
        say((skipped.length ? '픽셀 간격을 확인할 수 없어 바꾸지 않은 칸 — ' + skipped.join(' / ') + '. ' : '') + `True Size: 이 화면의 픽셀 크기 ${pitch} mm 기준입니다.`);
        return;
      }
      for (const cell of list) {
        const v = cell.v;
        if (kind === 'fit') { fit(v); setMode(v, 'Fit'); continue; }
        if (kind === 'pixel') {
          const zoom = M.onePixel({ zoom: zoomOf(v), perPixel: perPixel(v), dpr: window.devicePixelRatio || 1 });
          if (zoom) { steer(v, () => v.setZoom(zoom)); setMode(v, '1:1'); } else skipped.push(labelOf(cell));
          continue;
        }
        if (kind === 'breast') {
          const region = regionOf(cell);
          if (!region.found) { skipped.push(labelOf(cell)); badge(v, 'edge', '경계를 찾지 못했습니다'); continue; }
          const box = region.box, zoom = M.fitRect({ zoom: zoomOf(v), perPixel: perPixel(v), ...cellSize(v), width: box.x1 - box.x0, height: box.y1 - box.y0 });
          const world = toWorld(v, [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2]);
          if (zoom && world) { steer(v, () => { v.setZoom(zoom); centerOn(v, world); }); setMode(v, 'Fit Breast'); }
        }
      }
      say(skipped.length ? '바꾸지 않은 칸 — ' + skipped.join(' / ') : '');
    }
    function openPitch() {
      if (!show.pitchRow) return;
      show.pitchRow.hidden = false; show.pitchRow.querySelector('input').focus();
      say('True Size에는 이 모니터의 실제 픽셀 크기가 필요합니다(브라우저는 알 수 없습니다). 모니터 사양의 픽셀 피치(mm)를 넣으세요. 이 PC의 이 브라우저에 화면별로 저장합니다.');
    }
    // The window moved to another screen or the browser's zoom changed: True Size is drawn again for that screen's value,
    // or the cells go back to Fit and the value is asked for.
    // A screen change event (the browser moved the window to another screen) is a change in itself: on screens that cannot
    // be told apart (no key) it is never taken as the same screen. A resize only counts when the key or the scale changed.
    function screenChanged(event) {
      const was = show.screen, now = screenNow();
      if (!was) return;
      const moved = event?.type === 'currentscreenchange' || event?.type === 'change';
      const unknown = was.key === null || now.key === null;
      if (was.key === now.key && was.dpr === now.dpr && !(moved && unknown)) return;
      show.sessionPitch = null;
      const trueCells = [...show.modes].filter(([, mode]) => mode.text.startsWith('True Size'));
      show.screen = null;
      if (!trueCells.length) return;
      if (!unknown && pitchFor(now.key)) { zoomMode('true'); return; }
      for (const [id, mode] of trueCells) { const v = viewportOf(id); if (v === mode.viewport) { fit(v); setMode(v, 'Fit'); } }
      if (show.panel) openPitch(); else ui.toast('화면이 바뀌어 True Size를 Fit으로 돌렸습니다. Breast Display에서 이 화면의 픽셀 크기를 넣으세요.');
    }
    function openBreastDisplay() {
      const panel = ui.panel({ id: 'breast', title: 'Breast Display' });
      if (!panel || panel === show.panel) return;
      show.panel = panel;
      const row = element('div', '', panel.body, 'kin-mg-row');
      button('Breast Edge', row, () => { show.edge = !show.edge; drawEdges(); say(show.edge ? '유방 경계를 그렸습니다. 다시 누르면 지웁니다.' : ''); }, '각 MG 칸에서 유방 영역을 찾아 경계선을 그립니다');
      button('Breast W/L', row, () => breastWl(), '유방 영역 안의 픽셀만으로 창을 정합니다');
      button('Fit', row, () => zoomMode('fit'), '영상을 칸에 맞춥니다');
      button('1:1', row, () => zoomMode('pixel'), '영상 픽셀 1개를 화면 픽셀 1개로');
      button('True Size', row, () => zoomMode('true'), '화면의 1 mm를 영상의 1 mm로(모니터 픽셀 크기 필요)');
      button('Fit Breast', row, () => zoomMode('breast'), '유방 영역을 칸에 맞춥니다');
      button('Match Size', row, () => zoomMode('match'), '같은 뷰의 칸끼리 유방 크기를 맞춥니다');
      show.pitchRow = element('label', '', panel.body, 'kin-mg-row'); show.pitchRow.hidden = true;
      element('span', 'Monitor pixel pitch (mm)', show.pitchRow);
      const pitch = element('input', '', show.pitchRow); pitch.type = 'number'; pitch.step = '0.001'; pitch.min = '0.05'; pitch.max = '1';
      pitch.setAttribute('aria-label', 'Monitor pixel pitch (mm)');
      const current = pitchFor(screenNow().key); if (current) pitch.value = String(current);
      pitch.onchange = () => {
        const value = Number(pitch.value), key = screenNow().key;
        if (!M.validPitch(value)) { say('0.05–1 mm 사이의 값을 넣으세요.'); return; }
        // Without a screen key the value serves this window only (it is not stored for a screen it may not be).
        if (!savePitch(key, value)) show.sessionPitch = { key, value };
        show.pitchRow.hidden = true; zoomMode('true');
      };
      note('표시 처리(경계·창·크기)는 누를 때만 걸리고 칸마다 표지가 붙습니다. Fit으로 돌아가고, Breast W/L은 다시 누르면 원래 창입니다.', panel.body);
      show.status = statusLine(panel.body);
      panel.onClose(() => { if (show.panel !== panel) return; show.panel = show.status = show.pitchRow = null; });
    }
    // A cell given another image drops what was drawn for the earlier one.
    const stackKey = v => { const ids = idsOf(v); return ids.length + '|' + (ids[0] || '') + '|' + (ids[ids.length - 1] || ''); };
    function cellImage(id) {
      const v = viewportOf(id);
      const entry = show.wl.get(id);
      // Another slice or frame of the same stack keeps the window (the viewer does not set the stored one again for it), so it
      // keeps its mark and its way back; another stack or viewport drops it.
      if (entry && (v !== entry.viewport || stackKey(v) !== entry.stack)) { show.wl.delete(id); badge(entry.viewport, 'wl', null); }
      const mode = show.modes.get(id);
      if (mode && v !== mode.viewport) { show.modes.delete(id); badge(mode.viewport, 'zoom', null); }
      if (show.edge) drawEdges();
    }

    // ── Mammo Keypad ──
    const tabs = () => window.KinViewerPatientTabs;
    const pad = { panel: null, paint: null };
    function openKeypad() {
      const panel = ui.panel({ id: 'keypad', title: 'Mammo Keypad' });
      if (!panel) return null;
      if (panel === pad.panel) return pad;
      pad.panel = panel;
      const keys = element('div', '', panel.body, 'kin-mg-row');
      const next = button('Patient ▶', keys, () => pressNext(), '다음 열린 환자의 검사로 영상과 판독 대상을 옮깁니다');
      next.dataset.mgKey = 'next-patient';
      element('b', 'Open Patients', panel.body);
      const list = element('ol', '', panel.body, 'kin-mg-patients');
      const question = element('div', '', panel.body, 'kin-mg-question'); question.hidden = true; question.setAttribute('role', 'alertdialog');
      const status = statusLine(panel.body);
      pad.question = question;
      pad.paint = () => {
        const open = tabs()?.list?.() || [];
        list.replaceChildren(...open.map(tab => {
          // The report target is named only where the reading screen confirmed it (the last keypad move or its way back).
          const item = element('li', [tab.patient.name, tab.patient.id].join(' | ') + (tab.current ? '  ← images' + (carry.reportTarget && carry.reportTarget === tab.studies[0] ? ' · report target' : '') : ''));
          item.setAttribute('aria-current', String(tab.current)); return item;
        }));
        next.disabled = open.length < 2 || carry.busy || !!tabs()?.moving?.();
        status.textContent = carry.busy ? '환자를 옮기는 중입니다…' : carry.message || (open.length < 2 ? '열린 다른 환자가 없습니다.' : '');
      };
      panel.onClose(() => { if (pad.panel !== panel) return; pad.panel = pad.paint = pad.question = null; carry.message = null; });
      pad.paint();
      return pad;
    }
    // Patient ▶ (the button, or the Next Patient key): moves at once when the reading screens hold no unconfirmed text of
    // this patient's studies; otherwise asks Save Draft & Move / Discard & Move / Cancel.
    async function pressNext() {
      const opened = openKeypad();
      if (!opened || carry.busy || tabs()?.moving?.()) return;
      const open = tabs()?.list?.() || [];
      if (open.length < 2) { opened.paint(); return; }
      carry.message = null; opened.paint();
      const reason = await tabs().unsaved();
      if (ended || pad !== opened || !pad.panel) return;
      if (reason === null) { move('save'); return; }
      const now = open.find(tab => tab.current)?.patient.name || '';
      const question = pad.question; question.hidden = false; question.replaceChildren();
      element('p', `${now}의 판독 초안이 저장되지 않았습니다 (${reason}).`, question);
      element('p', 'Discard & Move는 자동 저장된 부분을 포함해 이 검사의 초안 전체를 버리고 저장된 판독문으로 돌아갑니다.', question);
      const row = element('div', '', question, 'kin-mg-row');
      button('Save Draft & Move', row, () => move('save'), '판독 화면에서 초안을 저장하고, 저장이 확인되면 옮깁니다');
      button('Discard & Move', row, () => move('discard'), '판독 화면에서 이 검사의 초안 전체를 버리고(저장된 판독문으로 돌아감), 버린 것이 확인되면 옮깁니다');
      button('Cancel', row, () => { question.hidden = true; question.replaceChildren(); pad.panel?.focus(); });
      row.querySelector('button').focus();
    }
    async function move(intent) {
      if (carry.busy || !tabs()?.next) return;
      if (pad.question) { pad.question.hidden = true; pad.question.replaceChildren(); }
      carry.busy = true; carry.message = null; pad.paint?.();
      let result;
      try { result = await tabs().next(intent); } catch (error) { result = { ok: false, message: error?.message || '환자를 옮기지 못했습니다.' }; }
      carry.busy = false; carry.message = result?.message || '';
      carry.reportTarget = result?.reportTarget ?? null;
      // This module may have been replaced by the viewer of the patient moved to: that one shows the result.
      carry.listener?.();
    }

    // ── Events ──
    const listen = (type, fn) => { if (type) document.addEventListener(type, fn, { capture: true, signal }); };
    listen(events.CAMERA_MODIFIED, event => { cameraChanged(event); if (show.edge) drawEdges(); });
    listen(events.VOI_MODIFIED, event => { voiChanged(event); });
    listen(events.STACK_NEW_IMAGE, event => { tomoImage(event); const id = event.detail?.viewportId; if (id) cellImage(id); });
    window.addEventListener('resize', screenChanged, { signal });
    try { window.screen.addEventListener?.('change', screenChanged, { signal }); } catch (_) {}
    const subscriptions = [];
    const subscribe = (service, event, fn) => { try { if (event && service?.subscribe) subscriptions.push(service.subscribe(event, fn)); } catch (error) { console.error(error); } };
    subscribe(grid, grid?.EVENTS?.GRID_STATE_CHANGED, () => { tomoCell(null); for (const id of cellIds()) cellImage(id); if (lens.on) mgCells().then(pressLayers).catch(() => {}); if (mirror.on) markUnlinked(); });
    subscribe(cellService, cellService?.EVENTS?.VIEWPORT_DATA_CHANGED, event => { tomoCell(event?.viewportId ? [event.viewportId] : null); if (event?.viewportId) cellImage(event.viewportId); });
    subscribe(services.cineService, services.cineService?.EVENTS?.CINE_STATE_CHANGED, cineChanged);

    // ── Menu ──
    ui.menuItem('MG', { id: 'mgMirrored', label: 'Mirrored', order: 1, run: () => openMirrored() });
    ui.menuItem('MG', { id: 'mgQuadrantZoom', label: 'Quadrant Zoom', order: 2, run: () => openQuadrant() });
    ui.menuItem('MG', { id: 'mgTomoSlices', label: 'Tomo (DBT) Slices', order: 3, run: ({ viewportId }) => openTomo(viewportId) });
    ui.menuItem('MG', { id: 'mgBreastDisplay', label: 'Breast Display', order: 4, run: () => openBreastDisplay() });
    ui.menuItem('MG', { id: 'mgKeypad', label: 'Mammo Keypad', order: 5, run: () => { openKeypad(); } });
    ui.menuItem('MG', { id: 'mgMagnifier', label: 'Magnifier', order: 6, run: () => setMagnifier(!lens.on) });
    ui.shortcut({ id: 'mgNextPatient', label: 'Next Patient', run: () => pressNext() });

    // The report target the reading screen confirmed holds only until the viewer shows other studies (a tab switch, an
    // opening) or this window is linked to another list.
    const forget = () => { if (carry.busy) return; carry.reportTarget = null; pad.paint?.(); };
    const stopTabs = tabs()?.subscribe?.(forget);
    for (const type of ['hashchange', 'kin-window-link-changed']) window.addEventListener(type, forget, { signal });
    // After a Patient ▶ move the keypad is open again, with the move's result when it comes.
    const listener = () => { if (!ended) { openKeypad(); pad.paint?.(); } };
    carry.listener = listener;
    if (carry.busy || carry.message) openKeypad();

    return () => {
      ended = true;
      if (carry.listener === listener) carry.listener = null;
      try { stopTabs?.(); } catch (_) {}
      stopPlay(); restoreSlab(); wlOff();
      abort.abort(); dprQuery?.removeEventListener?.('change', onDpr);
      for (const timer of timers) clearInterval(timer);
      if (cameraFrame) cancelAnimationFrame(cameraFrame);
      for (const subscription of subscriptions) try { subscription?.unsubscribe?.(); } catch (_) {}
      for (const entry of layers.values()) entry.node.remove();
      layers.clear(); style.remove();
    };
  });
})();
