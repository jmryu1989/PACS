// Viewer feature module: the Measure menu. It registers through viewer-features.js and adds the measuring frame and its
// base tools: Circle by Diameter, Spine Label, Marking, Text and Memo.
//
// The frame (window.KinMeasureFrame, also used by the Measure menu's other modules):
// - A step panel (the registry's ui.panel): title, the tool's own fields, the list of steps (the current one marked, done ones
//   struck through), a result line, a status line, Restart, Close. While it is open a left press on an image cell is the
//   current step's point, and the cell's own left tool does not run. Every press and every drag asks the History panel's
//   edit gate (kinViewerHistoryMarkGate: session, account, held work, a Job being restored, this study) and refuses during a
//   patient switch or an emptied viewer. Close keeps finished marks and drops the points of an unfinished one.
// - Marks live in the annotation state under their own tool names (KinText, KinMemo, KinSpineLabel, KinCircleDiameter), so
//   the History panel drafts, saves, locks and restores them as its other marks; points are world coordinates. No
//   cornerstone tool draws these names: this module draws them in an SVG layer over each cell, from image pixel coordinates
//   through the viewport, so zoom, pan, rotation and flips are followed. An unlocked mark can be dragged; a locked one (saved,
//   not being edited) cannot.
// - Units: a length is in mm only where the image's spacing is known and the shown spacing is that spacing (planar-geometry.js,
//   MG through mg-length.js, ultrasound through its Region Calibration); otherwise a tool says it cannot give mm.
window.KinViewerFeatures?.module('measure', ({ services, store, ui }) => {
  const cs = window.cornerstone, ct = window.cornerstoneTools;
  if (!cs?.utilities || !ct?.annotation?.state) return undefined;
  const SVG = 'http://www.w3.org/2000/svg';
  const TOOLS = { text: 'KinText', memo: 'KinMemo', spine: 'KinSpineLabel', circle: 'KinCircleDiameter' };
  const renderers = new Map(), layers = new Map(), created = new Set(), cleanups = [];
  let model = null, active = null, drag = null, ended = false, queued = false;
  const loaded = ui.load(['measure-tools-model.js']).then(() => { model = window.KinMeasureToolsModel; schedule(); }, () => {});

  const el = (tag, text, parent, attributes = {}) => {
    const node = document.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent?.append(node); return node;
  };
  const svg = (tag, parent, attributes = {}, text) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    parent?.append(node); return node;
  };

  // ── Cells, images and coordinates ──
  const viewports = () => (cs.getEnabledElements?.() || []).map(entry => entry?.viewport).filter(v => v?.element && typeof v.getCurrentImageId === 'function');
  const viewportOf = target => viewports().find(v => v.element.contains(target)) || null;
  const imageOf = v => { try { return v.getCurrentImageId() || null; } catch (_) { return null; } };
  // World ↔ image pixel coordinates as the stack viewport places the image: the first pixel's centre at the image position,
  // whole numbers at pixel centres (the rule of planar-geometry.js and of the server's check), spacing 1 where none is given.
  function plane(imageId) {
    const p = cs.metaData.get('imagePlaneModule', imageId) || {};
    const vector = (value, fallback) => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(Number(n))) ? value.map(Number) : fallback;
    const spacing = value => Number(value) > 0 ? Number(value) : 1;
    return { origin: vector(p.imagePositionPatient, [0, 0, 0]), u: vector(p.rowCosines, [1, 0, 0]), v: vector(p.columnCosines, [0, 1, 0]),
      row: spacing(p.rowPixelSpacing), column: spacing(p.columnPixelSpacing) };
  }
  const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
  function toImage(imageId, world) {
    const { origin, u, v, row, column } = plane(imageId), d = world.map((n, i) => n - origin[i]);
    const uu = dot(u, u), vv = dot(v, v), uv = dot(u, v), det = uu * vv - uv * uv;
    return [(dot(d, u) * vv - dot(d, v) * uv) / det / column, (dot(d, v) * uu - dot(d, u) * uv) / det / row];
  }
  const toWorld = (imageId, [x, y]) => { const { origin, u, v, row, column } = plane(imageId); return origin.map((n, i) => n + u[i] * x * column + v[i] * y * row); };
  const instance = imageId => cs.metaData.get('instance', imageId) || null;
  const frameOf = imageId => window.kinViewerImageReference?.(imageId)?.frame ?? 1;
  const size = imageId => { const image = cs.cache?.getImage?.(imageId), tags = instance(imageId); return { rows: Number(image?.rows ?? tags?.Rows), columns: Number(image?.columns ?? tags?.Columns) }; };
  const insideImage = (imageId, [x, y]) => { const { rows, columns } = size(imageId); return x >= -.5 && y >= -.5 && x <= columns - .5 && y <= rows - .5; };
  // The canvas point of a press, in the coordinates canvasToWorld reads.
  const canvasPoint = (v, event) => { const rect = (v.canvas || v.element).getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; };

  // The spacing of a measurement on an image, or a reason. points: image pixel coordinates that must share one spacing.
  // tags: the original's tags when the image has no instance metadata of its own (the Job print's offscreen copy).
  function geometry(imageId, points = [], tags = instance(imageId)) {
    if (!tags) return { reason: '영상 정보를 확인할 수 없습니다' };
    if (cs.cache?.getImage?.(imageId)?.calibration?.type) return { reason: '보정한 간격의 영상에서는 mm 값을 내지 않습니다' };
    const plane = cs.metaData.get('imagePlaneModule', imageId) || {};
    const us = typeof window.kinUsRegionGeometry === 'function' ? window.kinUsRegionGeometry(tags) : null;
    if (us) {
      const region = us.region(points);
      if (!region) return { reason: '초음파 보정 영역 안에서만 mm로 잴 수 있습니다' };
      return { spacing: region.spacing, basis: 'us', label: us.label };
    }
    try {
      const planar = window.kinPlanarGeometry(tags, frameOf(imageId));
      if (Number(plane.rowPixelSpacing) !== planar.spacing[0] || Number(plane.columnPixelSpacing) !== planar.spacing[1]) return { reason: '표시 간격과 원본 간격이 일치하지 않습니다' };
      return { spacing: planar.spacing, basis: planar.calculator.split(':')[1], label: planar.label };
    } catch (_) { return { reason: '이 영상에서는 간격을 확인할 수 없습니다' }; }
  }

  // ── The edit gate, asked before every press and every drag ──
  function gate(v, imageId) {
    if (ended) return '뷰어가 닫혔습니다';
    if (['kin-patient-switching', 'kin-viewer-empty'].some(name => document.body.classList.contains(name))) return '환자를 바꾸는 중에는 표식을 만들거나 옮기지 않습니다';
    // As the toolbar's own tools: not while a History or Job workspace is being restored or saved.
    if ([window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()].some(state => state?.busy)) return '영상 작업을 불러오거나 저장하는 중입니다. 완료 후 다시 누르세요';
    if (!v || v.type !== 'stack' || !imageId) return '원본 프레임 화면(일반 영상 칸)에서 누르세요';
    if (typeof window.kinViewerHistoryMarkGate !== 'function') return '측정 기록을 확인할 수 없어 표식을 만들지 않습니다';
    return window.kinViewerHistoryMarkGate(imageId) || '';
  }

  // ── Marks in the annotation state ──
  const marks = () => ct.annotation.state.getAllAnnotations().filter(a => renderers.has(a?.metadata?.toolName));
  const locked = a => !!ct.annotation.locking?.isAnnotationLocked?.(a.annotationUID) || !!a.isLocked;
  function addMark(v, imageId, toolName, points, data) {
    const camera = v.getCamera(), uid = crypto.randomUUID();
    const a = { annotationUID: uid, highlighted: false, invalidated: false, isLocked: false, isVisible: true,
      metadata: { toolName, FrameOfReferenceUID: v.getFrameOfReferenceUID?.(), referencedImageId: imageId, viewPlaneNormal: [...camera.viewPlaneNormal], viewUp: [...camera.viewUp] },
      data: { text: '', label: '', ...data, handles: { points: points.map(p => [...p]), activeHandleIndex: null, textBox: { hasMoved: false } } } };
    a.data.label = a.data.text;
    ct.annotation.state.addAnnotation(a, v.element);
    created.add(uid); schedule();
    return a;
  }
  function removeMark(uid) {
    if (ct.annotation.state.getAnnotation(uid)) ct.annotation.state.removeAnnotation(uid);
    created.delete(uid); schedule();
  }

  // ── Drawing ──
  const style = () => {
    const g = ct.annotation?.config?.style?.getDefaultToolStyles?.()?.global || {};
    return { color: g.color || 'rgb(255, 255, 0)', locked: g.colorLocked || g.color || 'rgb(255, 255, 0)', width: parseFloat(g.lineWidth) || 1.5,
      font: (parseFloat(g.textBoxFontSize) || 14) + 'px ' + (g.textBoxFontFamily || 'Helvetica Neue, Helvetica, Arial, sans-serif') };
  };
  function layerOf(v) {
    let entry = layers.get(v.id);
    if (entry && !entry.layer.isConnected) { layers.delete(v.id); entry = null; }
    if (!entry) {
      const layer = ui.cellLayer(v); if (!layer) return null;
      const root = svg('svg', layer, { width: '100%', height: '100%', style: 'position:absolute;inset:0;overflow:visible;pointer-events:none' });
      root.dataset.kinMeasureLayer = v.id;
      entry = { layer, root }; layers.set(v.id, entry);
    }
    return entry;
  }
  function draw() {
    queued = false;
    if (ended) return;
    const shown = new Set(), all = marks(), look = style();
    for (const v of viewports()) {
      const imageId = imageOf(v); if (!imageId) continue;
      const own = all.filter(a => a.metadata.referencedImageId === imageId && a.isVisible !== false);
      const pending = active?.presses.filter(p => p.viewportId === v.id && p.imageId === imageId) || [];
      const entry = own.length || pending.length || layers.has(v.id) ? layerOf(v) : null;
      if (!entry) continue;
      shown.add(v.id); entry.root.replaceChildren();
      const offset = (() => { const a = v.element.getBoundingClientRect(), b = entry.layer.getBoundingClientRect(); return [a.left - b.left, a.top - b.top]; })();
      const canvas = point => { const c = v.worldToCanvas(toWorld(imageId, point)); return [c[0] + offset[0], c[1] + offset[1]]; };
      const fromWorld = world => { const c = v.worldToCanvas(world); return [c[0] + offset[0], c[1] + offset[1]]; };
      for (const a of own) {
        const g = svg('g', entry.root); g.dataset.kinMark = a.metadata.toolName; g.dataset.annotationUid = a.annotationUID;
        try { renderers.get(a.metadata.toolName)({ g, a, v, imageId, canvas, fromWorld, look, color: locked(a) ? look.locked : look.color, editable: !locked(a) }); }
        catch (error) { console.error(error); }
      }
      for (const p of pending) {
        const [x, y] = fromWorld(p.world);
        svg('path', entry.root, { d: `M${x - 5} ${y}h10M${x} ${y - 5}v10`, stroke: look.color, 'stroke-width': look.width, fill: 'none' }).dataset.kinPending = '';
      }
    }
    for (const [id, entry] of layers) if (!shown.has(id)) { entry.root.replaceChildren(); }
  }
  function schedule() { if (!queued && !ended) { queued = true; requestAnimationFrame(draw); } }
  // A text with a dark outline, as the viewer's own text boxes.
  const label = (g, x, y, text, look, color, attributes = {}) =>
    svg('text', g, { x, y, fill: color, stroke: '#000', 'stroke-width': 3, 'paint-order': 'stroke', style: 'font:' + look.font, ...attributes }, text);
  // A handle that moves the whole mark: shown only on a mark that may be moved.
  function handle(g, a, x, y, look, color) {
    const node = svg('circle', g, { cx: x, cy: y, r: Math.max(4, look.width * 3), fill: 'transparent', stroke: color, 'stroke-width': look.width, style: 'pointer-events:all;cursor:move' });
    node.dataset.kinHandle = a.annotationUID;
    node.addEventListener('pointerdown', event => startDrag(event, a));
    return node;
  }

  renderers.set(TOOLS.text, ({ g, a, imageId, fromWorld, look, color, editable }) => {
    const [x, y] = fromWorld(a.data.handles.points[0]);
    String(a.data.text ?? '').split('\n').forEach((line, i) => label(g, x + 6, y + 5 + i * (parseFloat(look.font) * 1.25), line, look, color));
    if (editable) handle(g, a, x, y, look, color);
  });
  renderers.set(TOOLS.spine, ({ g, a, fromWorld, look, color, editable }) => {
    const [x, y] = fromWorld(a.data.handles.points[0]);
    svg('circle', g, { cx: x, cy: y, r: 3, fill: color });
    label(g, x + 8, y + 5, String(a.data.text ?? ''), look, color, { 'font-weight': 700 });
    if (editable) handle(g, a, x, y, look, color);
  });
  renderers.set(TOOLS.memo, ({ g, a, fromWorld, look, editable }) => {
    const [x, y] = fromWorld(a.data.handles.points[0]), size = parseFloat(look.font) || 14;
    const lines = String(a.data.text ?? '').split('\n'), title = String(a.data.title ?? '');
    const width = Math.max(120, ...[title, ...lines].map(line => [...line].length * size * .6 + 12)), height = (lines.length + 1) * size * 1.3 + 8;
    svg('rect', g, { x, y, width, height, fill: '#f3e58a', stroke: '#b9a640', 'stroke-width': 1 });
    svg('rect', g, { x, y, width, height: size * 1.3 + 4, fill: '#e2cf5d' });
    svg('text', g, { x: x + 5, y: y + size * 1.1, fill: '#222', style: 'font:700 ' + look.font }, title);
    lines.forEach((line, i) => svg('text', g, { x: x + 5, y: y + size * 1.3 + 4 + (i + 1) * size * 1.2, fill: '#222', style: 'font:' + look.font }, line));
    if (editable) handle(g, a, x, y, look, '#b9a640');
  });
  renderers.set(TOOLS.circle, ({ g, a, imageId, canvas, look, color, editable }) => {
    const [center, edge] = a.data.handles.points.map(p => toImage(imageId, p));
    const check = circleCheck(a, imageId);
    const rx = check.shape ? check.shape.rx : Math.hypot(edge[0] - center[0], edge[1] - center[1]), ry = check.shape ? check.shape.ry : rx;
    const ring = Array.from({ length: 73 }, (_, i) => canvas([center[0] + rx * Math.cos(i * Math.PI / 36), center[1] + ry * Math.sin(i * Math.PI / 36)]));
    svg('polyline', g, { points: ring.map(p => p.join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': look.width });
    const right = Math.max(...ring.map(p => p[0])), top = Math.min(...ring.map(p => p[1]));
    const lines = check.reason ? [check.reason] : model ? model.circleLines(a.data.kinBaseline?.values, a.data.kinBaseline?.calculator?.endsWith(':hu') ? 'HU' : '', check.label) : [];
    lines.forEach((line, i) => label(g, right + 6, top + 12 + i * size14(look), line, look, check.reason ? '#ff6b6b' : color));
    if (editable) { const [x, y] = canvas(center); handle(g, a, x, y, look, color); }
  });
  const size14 = look => (parseFloat(look.font) || 14) * 1.25;

  // ── Circle by Diameter values ──
  // The circle's values from the original pixels: [diameter, area] and, for a grey-scale image, [mean, SD, min, max, count].
  function circleValues(imageId, center, diameter, tags = instance(imageId)) {
    const shapeOf = spacing => model.circleShape(center, diameter, spacing);
    let found = geometry(imageId, [center], tags);
    if (found.reason) return { reason: found.reason };
    let shape = shapeOf(found.spacing);
    if (found.basis === 'us') {
      found = geometry(imageId, [center, [center[0] - shape.rx, center[1]], [center[0] + shape.rx, center[1]], [center[0], center[1] - shape.ry], [center[0], center[1] + shape.ry]], tags);
      if (found.reason) return { reason: '원이 초음파 보정 영역을 벗어납니다' };
      shape = shapeOf(found.spacing);
    }
    const image = cs.cache?.getImage?.(imageId);
    let stats = null, unit = 'value';
    const components = Number(image?.numberOfComponents ?? (image?.color ? 3 : 1));
    if (image && !image.color && components === 1 && typeof image.getPixelData === 'function') {
      const pixels = image.getPixelData(), columns = image.columns, rows = image.rows;
      const scaled = image.preScale?.scaled === true;
      const lut = cs.metaData.get('modalityLutModule', imageId) || {};
      const slope = scaled ? 1 : Number(image.slope ?? lut.rescaleSlope ?? 1), intercept = scaled ? 0 : Number(image.intercept ?? lut.rescaleIntercept ?? 0);
      stats = model.circleStats(shape, rows, columns, found.spacing, (x, y) => pixels[y * columns + x] * slope + intercept);
      // A CT value is in HU unless the image names another rescale type (the CT Image module's Rescale Type default).
      if (stats && tags?.Modality === 'CT' && (tags.RescaleType === undefined || tags.RescaleType === 'HU')) unit = 'hu';
    }
    return { shape, values: model.circleValues(diameter, stats), unit, basis: found.basis, label: found.label,
      calculator: 'kin-circle-v1:' + found.basis + ':' + (stats ? unit : 'value') };
  }
  // A drawn circle checked against its stored values, once per position: a mismatch is said, not hidden.
  // fresh: computed from the pixels now, not taken from an earlier verdict (the check before a save).
  const checks = new Map();
  function circleCheck(a, imageId, fresh = false) {
    if (!model) return { reason: '' };
    const key = JSON.stringify([imageId, a.data.handles.points, a.data.kinBaseline]);
    const cached = checks.get(a.annotationUID);
    if (!fresh && cached?.key === key) return cached.result;
    let result;
    try {
      const center = toImage(imageId, a.data.handles.points[0]), stored = a.data.kinBaseline;
      const now = stored && circleValues(imageId, center, stored.values?.[0]);
      if (!now || now.reason) result = { reason: '재확인 필요: ' + (now?.reason || '값을 확인할 수 없습니다') };
      else if (now.calculator !== stored.calculator || now.values.length !== stored.values.length || now.values.some((n, i) => Math.abs(n - stored.values[i]) > Math.max(1e-6, Math.abs(n) * 1e-9)))
        result = { reason: '재확인 필요: 저장 당시 값과 다릅니다', shape: now.shape };
      else result = { shape: now.shape, label: now.label };
    } catch (error) { result = { reason: '재확인 필요: ' + error.message }; }
    checks.set(a.annotationUID, { key, result });
    return result;
  }

  // ── Dragging a mark that may be moved ──
  function startDrag(event, a) {
    if (event.button !== 0 || drag) return;
    event.preventDefault(); event.stopPropagation();
    const v = viewports().find(view => imageOf(view) === a.metadata.referencedImageId && layers.get(view.id)?.layer.contains(event.target));
    const imageId = v && imageOf(v);
    const reason = locked(a) ? '저장한 표식은 측정 기록의 Edit를 누른 뒤 옮깁니다' : gate(v, imageId);
    if (reason) { say(reason); return; }
    drag = { a, v, imageId, start: a.data.handles.points.map(p => [...p]), baseline: a.data.kinBaseline ? structuredClone(a.data.kinBaseline) : undefined,
      from: toImage(imageId, v.canvasToWorld(canvasPoint(v, event))), moved: false };
  }
  function dragTo(event, done) {
    const { a, v, imageId } = drag;
    const reason = !ct.annotation.state.getAnnotation(a.annotationUID) ? '표식이 없어졌습니다' : locked(a) ? '표식이 잠겼습니다' : imageOf(v) !== imageId ? '영상이 바뀌어 옮기기를 멈췄습니다' : gate(v, imageId);
    if (reason) return cancelDrag(reason);
    const at = toImage(imageId, v.canvasToWorld(canvasPoint(v, event))), delta = [at[0] - drag.from[0], at[1] - drag.from[1]];
    const moved = drag.start.map(p => { const q = toImage(imageId, p); return [q[0] + delta[0], q[1] + delta[1]]; });
    if (!moved.every(p => insideImage(imageId, p))) return done ? cancelDrag('영상 밖으로는 옮기지 않습니다') : undefined;
    // A circle's values follow it: computed again at every position; one where they cannot be is not taken.
    if (a.metadata.toolName === TOOLS.circle) {
      const next = model ? circleValues(imageId, moved[0], a.data.kinBaseline?.values?.[0]) : { reason: '측정 계산을 불러오지 못했습니다' };
      if (next.reason) return done ? cancelDrag(next.reason) : undefined;
      a.data.kinBaseline = { calculator: next.calculator, values: next.values };
      a.data.handles.points = [toWorld(imageId, next.shape.center), toWorld(imageId, next.shape.edge)];
    } else a.data.handles.points = moved.map(p => toWorld(imageId, p));
    drag.moved = true; a.invalidated = true;
    if (done) { drag = null; ct.annotation.state.triggerAnnotationModified?.(a, v.element); }
    schedule();
  }
  function cancelDrag(reason) {
    if (!drag) return;
    // Back where it was, with the values of that place.
    const { a, start, baseline } = drag; drag = null;
    if (ct.annotation.state.getAnnotation(a.annotationUID)) { a.data.handles.points = start; if (baseline !== undefined) a.data.kinBaseline = baseline; }
    if (reason) say(reason);
    schedule();
  }
  const onMove = event => { if (drag) dragTo(event, false); };
  const onUp = event => { if (drag) dragTo(event, true); };
  window.addEventListener('pointermove', onMove, true); window.addEventListener('pointerup', onUp, true);
  cleanups.push(() => { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); });

  // ── The step panel ──
  function say(text) { if (active) active.status.textContent = text; else if (text) ui.toast(text, 'warning'); }
  const total = steps => steps.reduce((sum, step) => sum + step.points, 0);
  // The steps of the mark being made: those whose points are all given are struck through, the next one is marked.
  function paintSteps(tool) {
    let given = tool.presses.length, marked = false;
    tool.list.replaceChildren(...tool.spec.steps.map(step => {
      const item = el('li', step.text);
      if (given >= step.points) { item.style.textDecoration = 'line-through'; item.dataset.step = 'done'; }
      else if (!marked) { marked = true; item.style.fontWeight = '700'; item.dataset.step = 'now'; item.setAttribute('aria-current', 'step'); }
      given = Math.max(0, given - step.points);
      return item;
    }));
  }
  // spec: { id, title, note, fields(body, tool), steps: [{ text, points }], complete(tool, presses) → string (a reason) or
  //         nothing, result(tool) → text, restart(tool) }. A tool of one step of one point stamps a mark on every press.
  function open(spec) {
    if (ended) return null;
    active?.close();
    const panel = ui.panel({ id: spec.id, title: spec.title });
    if (!panel) return null;
    // A narrow window beside the images: long lines (the level preview) wrap instead of covering the image.
    panel.element.style.width = '22em'; panel.element.style.overflowWrap = 'anywhere';
    const body = panel.body;
    if (spec.note) el('p', spec.note, body);
    const fields = el('div', '', body); fields.dataset.measureFields = spec.id;
    el('b', '단계 (영상을 누르세요)', body);
    const list = el('ol', '', body); list.dataset.measureSteps = spec.id;
    const result = el('p', '', body, { 'data-measure-result': spec.id }); result.style.fontWeight = '600';
    const status = el('p', '', body, { role: 'status' });
    const tool = { spec, panel, body, fields, list, result, status, presses: [], marks: [], state: {},
      close: () => panel.close(), refresh: () => { paintSteps(tool); result.textContent = spec.result?.(tool) || ''; schedule(); } };
    const restart = el('button', 'Restart', el('div', '', body), { type: 'button' });
    restart.onclick = () => {
      tool.presses = [];
      // Restart takes back the marks this panel made that are not saved (unlocked); saved ones stay.
      for (const uid of tool.marks) { const a = ct.annotation.state.getAnnotation(uid); if (a && !locked(a)) removeMark(uid); }
      tool.marks = []; status.textContent = ''; spec.restart?.(tool); tool.refresh();
    };
    panel.onClose(() => { if (active === tool) active = null; tool.presses = []; schedule(); });
    spec.fields?.(fields, tool);
    active = tool; tool.refresh(); panel.focus();
    return tool;
  }
  // A press on an image cell while a panel is open: the current step's point. The cell's left tool does not see it.
  function press(event) {
    if (!active || event.button !== 0) return;
    const v = viewportOf(event.target); if (!v) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const tool = active, imageId = imageOf(v), reason = gate(v, imageId);
    if (reason) { tool.status.textContent = reason; return; }
    if (!model) { tool.status.textContent = '측정 계산을 불러오는 중입니다. 잠시 뒤 다시 누르세요.'; return; }
    const world = v.canvasToWorld(canvasPoint(v, event)), image = toImage(imageId, world);
    if (!insideImage(imageId, image)) { tool.status.textContent = '영상 안을 누르세요'; return; }
    // The points of one mark are on one image: a press on another image starts the mark again there.
    if (tool.presses.length && tool.presses[0].imageId !== imageId) { tool.presses = []; tool.status.textContent = '다른 영상을 눌러 그 영상에서 다시 시작합니다'; }
    else tool.status.textContent = '';
    tool.presses.push({ viewportId: v.id, v, imageId, world, image });
    if (tool.presses.length >= total(tool.spec.steps)) {
      const presses = tool.presses; tool.presses = [];
      let outcome;
      try { outcome = tool.spec.complete(tool, presses); } catch (error) { outcome = error.message || '표식을 만들지 못했습니다'; }
      if (typeof outcome === 'string' && outcome) tool.status.textContent = outcome;
    }
    tool.refresh();
  }
  const swallow = event => { if (active && event.button === 0 && viewportOf(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); } };
  window.addEventListener('mousedown', press, true);
  for (const name of ['dblclick', 'click']) window.addEventListener(name, swallow, true);
  cleanups.push(() => { window.removeEventListener('mousedown', press, true); for (const name of ['dblclick', 'click']) window.removeEventListener(name, swallow, true); });
  // A mark this panel made, remembered for Restart.
  const stamp = (tool, press, toolName, points, data) => { const a = addMark(press.v, press.imageId, toolName, points, data); tool.marks.push(a.annotationUID); return a; };

  // ── Redraw when the images, the camera or the marks change ──
  const imageEvents = [cs.Enums?.Events?.IMAGE_RENDERED, cs.Enums?.Events?.CAMERA_MODIFIED, cs.Enums?.Events?.STACK_NEW_IMAGE].filter(Boolean);
  // Another image in a cell: a drag on it stops, and the points of an unfinished mark are dropped (they belong to one image).
  function imageChanged() {
    if (drag && imageOf(drag.v) !== drag.imageId) cancelDrag('영상이 바뀌어 옮기기를 멈췄습니다');
    const first = active?.presses[0];
    if (first) {
      const v = viewports().find(view => view.id === first.viewportId);
      if (!v || imageOf(v) !== first.imageId || ['kin-patient-switching', 'kin-viewer-empty'].some(name => document.body.classList.contains(name))) {
        active.presses = []; active.status.textContent = '영상이 바뀌어 그리던 표식의 점을 지웠습니다'; active.refresh();
      }
    }
    schedule();
  }
  const onImage = () => imageChanged();
  for (const name of imageEvents) document.addEventListener(name, onImage, true);
  const markEvents = ['ANNOTATION_ADDED', 'ANNOTATION_MODIFIED', 'ANNOTATION_REMOVED', 'ANNOTATION_LOCK_CHANGE'].map(name => ct.Enums?.Events?.[name]).filter(Boolean);
  for (const name of markEvents) cs.eventTarget?.addEventListener(name, schedule);
  // The History panel changes a mark's text and lock in place; a light tick follows it.
  const tick = setInterval(imageChanged, 300);
  cleanups.push(() => { clearInterval(tick); for (const name of imageEvents) document.removeEventListener(name, onImage, true); for (const name of markEvents) cs.eventTarget?.removeEventListener(name, schedule); });

  // ── The tools ──
  const field = (parent, text, control) => { const wrap = el('label', '', parent); wrap.style.cssText = 'display:flex;gap:.5em;align-items:center;margin:.3em 0'; wrap.append(text, control); return control; };
  const textarea = (parent, name) => { const node = el('textarea', '', parent, { rows: 3, 'aria-label': name }); node.style.cssText = 'display:block;width:100%;box-sizing:border-box;background:var(--kin-panel);color:var(--kin-ux-text);border:1px solid var(--kin-ux-secondary)'; return node; };

  const circle = {
    id: 'measure-circle-diameter', title: 'Circle by Diameter',
    note: '지름(mm)을 넣고 영상에서 원의 가운데를 누르면 그 크기의 원형 ROI와 통계가 나옵니다.',
    steps: [{ text: '원의 가운데를 누르세요', points: 1 }],
    fields(body, tool) {
      const input = el('input', '', null, { type: 'number', min: '1', step: '0.5', 'aria-label': 'Diameter mm' }); input.value = '10'; input.style.width = '6em';
      const wrap = field(body, 'Diameter', input); wrap.after(' mm'); tool.state.input = input;
    },
    complete(tool, [press]) {
      const diameter = Number(tool.state.input.value);
      if (!Number.isFinite(diameter) || diameter <= 0 || diameter > 1000) return '지름을 0보다 크고 1000 mm 이하로 넣으세요';
      const found = circleValues(press.imageId, press.image, diameter);
      if (found.reason) return found.reason === '이 영상에서는 간격을 확인할 수 없습니다' ? '이 영상에서는 mm 지름을 쓸 수 없습니다' : found.reason;
      stamp(tool, press, TOOLS.circle, [toWorld(press.imageId, found.shape.center), toWorld(press.imageId, found.shape.edge)],
        { kinBaseline: { calculator: found.calculator, values: found.values } });
      tool.state.last = model.circleLines(found.values, found.calculator.endsWith(':hu') ? 'HU' : '', found.label).join(' · ');
      return '';
    },
    result: tool => tool.state.last ? 'Result: ' + tool.state.last : '',
  };

  const spine = {
    id: 'measure-spine-label', title: 'Spine Label',
    note: '시작 레벨을 고르고 척추체를 차례로 누르면 누를 때마다 다음 레벨 이름이 붙습니다. C8·L6은 이행 척추를 넣을 때 고릅니다.',
    steps: [{ text: '척추체를 차례로 누르세요', points: 1 }],
    fields(body, tool) {
      const s = tool.state;
      Object.assign(s, { start: 'C1', c8: false, l6: false, direction: model?.DIRECTIONS[0] || 'Top to bottom', next: 0 });
      const start = field(body, 'Start Level', el('select', '', null, { 'aria-label': 'Start Level' }));
      const c8 = field(body, 'Include C8', el('input', '', null, { type: 'checkbox', 'aria-label': 'Include C8' }));
      const l6 = field(body, 'Include L6', el('input', '', null, { type: 'checkbox', 'aria-label': 'Include L6' }));
      const direction = field(body, 'Direction', el('select', '', null, { 'aria-label': 'Direction' }));
      for (const name of model?.DIRECTIONS || ['Top to bottom', 'Bottom to top']) el('option', name, direction, { value: name });
      const preview = el('p', '', body, { 'data-spine-preview': '' }); preview.style.fontFamily = 'monospace';
      s.paint = () => {
        const levels = model ? model.spineLevels(s.c8, s.l6) : [];
        if (!levels.includes(s.start)) s.start = levels[Math.min(levels.length - 1, Math.max(0, start.selectedIndex))] || 'C1';
        start.replaceChildren(...levels.map(level => { const o = el('option', level, null, { value: level }); o.selected = level === s.start; return o; }));
        preview.textContent = model ? model.spinePreview(levels, s.start) : '';
      };
      const changed = () => { s.next = 0; s.paint(); tool.refresh(); };
      start.onchange = () => { s.start = start.value; changed(); };
      c8.onchange = () => { s.c8 = c8.checked; changed(); };
      l6.onchange = () => { s.l6 = l6.checked; changed(); };
      direction.onchange = () => { s.direction = direction.value; changed(); };
      if (model) s.paint(); else loaded.then(() => { if (!ended) { s.paint(); tool.refresh(); } });
    },
    complete(tool, [press]) {
      const s = tool.state, order = model.spineOrder({ start: s.start, includeC8: s.c8, includeL6: s.l6, direction: s.direction })?.order || [];
      if (s.next >= order.length) return '마지막 레벨까지 붙였습니다. Restart로 다시 시작하거나 시작 레벨을 바꾸세요';
      stamp(tool, press, TOOLS.spine, [press.world], { text: order[s.next] });
      s.next++;
      return '';
    },
    result(tool) {
      const s = tool.state, order = model?.spineOrder({ start: s.start, includeC8: s.c8, includeL6: s.l6, direction: s.direction })?.order || [];
      return order.length ? (s.next < order.length ? 'Next level: ' + order[s.next] : 'All levels placed (' + order[order.length - 1] + ')') : '';
    },
    restart: tool => { tool.state.next = 0; },
  };

  const marking = {
    id: 'measure-marking', title: 'Marking',
    note: '목록에서 문구를 고르고 영상을 누르면 그 자리에 찍힙니다. 새 문구를 목록에 더할 수 있습니다(계정에 저장).',
    steps: [{ text: '고른 문구를 찍을 자리를 누르세요', points: 1 }],
    fields(body, tool) {
      const s = tool.state; s.list = [];
      const list = el('select', '', body, { size: '6', 'aria-label': 'Marking Text List' }); list.style.width = '100%';
      const row = el('div', '', body); row.style.marginTop = '.3em';
      const add = el('input', '', row, { 'aria-label': 'New marking text', placeholder: 'New marking text', maxlength: '60' });
      const addButton = el('button', 'Add to List', row, { type: 'button' }), remove = el('button', 'Delete', row, { type: 'button', 'aria-label': 'Delete Selected Marking Text' });
      const paint = (choose = list.value) => {
        list.replaceChildren(...s.list.map(text => { const o = el('option', text, null, { value: text }); o.selected = text === choose; return o; }));
        remove.disabled = !list.value;
      };
      list.onchange = () => { remove.disabled = !list.value; };
      // The list is the account's (viewerSettings.features.markingTexts); it is read again whenever the account values are.
      const unsubscribe = store.subscribe('markingTexts', value => { s.list = model ? model.markingList(value) : []; paint(); });
      tool.panel.onClose(unsubscribe);
      const save = async (next, choose) => {
        const before = s.list; s.list = next; paint(choose);
        const saved = await store.set('markingTexts', next);
        if (!saved) { tool.status.textContent = '목록을 저장하지 못했습니다. 다시 시도하세요.'; s.list = model.markingList(store.get('markingTexts') ?? before); paint(); }
        else if (!store.writable()) tool.status.textContent = '이 창에서만 적용합니다(저장하지 않는 세션).';
      };
      addButton.onclick = () => {
        if (!model) return;
        const { list: next, error } = model.addMarking(s.list, add.value);
        if (error) { tool.status.textContent = error; return; }
        add.value = ''; tool.status.textContent = ''; save(next, next[next.length - 1]);
      };
      remove.onclick = () => { const chosen = list.value; if (chosen) save(s.list.filter(text => text !== chosen), null); };
      s.chosen = () => list.value;
    },
    complete(tool, [press]) {
      const text = tool.state.chosen();
      if (!text) return '목록에서 문구를 고르세요';
      stamp(tool, press, TOOLS.text, [press.world], { text });
      return '';
    },
  };

  const plainText = {
    id: 'measure-text', title: 'Text', note: '화살표 없이 글만 영상 위에 놓습니다. 글을 넣고 영상을 누르세요.',
    steps: [{ text: '글을 놓을 자리를 누르세요', points: 1 }],
    fields(body, tool) { el('div', 'Text', body); tool.state.text = textarea(body, 'Text'); },
    complete(tool, [press]) {
      const text = model.cleanText(tool.state.text.value);
      if (!text) return '글을 넣은 뒤 영상을 누르세요(' + model.TEXT_LIMIT + '자까지)';
      stamp(tool, press, TOOLS.text, [press.world], { text });
      return '';
    },
  };

  const memo = {
    id: 'measure-memo', title: 'Memo', note: '제목과 글을 넣고 영상을 누르면 제목 달린 메모 상자가 붙습니다.',
    steps: [{ text: '메모를 붙일 자리를 누르세요', points: 1 }],
    fields(body, tool) {
      tool.state.title = field(body, 'Title', el('input', '', null, { 'aria-label': 'Memo Title', maxlength: '200' }));
      el('div', 'Text', body); tool.state.text = textarea(body, 'Memo Text');
    },
    complete(tool, [press]) {
      const title = tool.state.title.value.trim(), raw = tool.state.text.value.trim();
      const text = raw ? model.cleanText(raw) : '';
      if (title && !model.cleanText(title, model.TITLE_LIMIT) || text === null) return '제목은 ' + model.TITLE_LIMIT + '자, 글은 ' + model.TEXT_LIMIT + '자까지입니다';
      if (!title && !text) return '제목이나 글을 넣은 뒤 영상을 누르세요';
      stamp(tool, press, TOOLS.memo, [press.world], { text, title });
      return '';
    },
  };

  // The menu items, in the order of the Measure menu (the other measuring modules fill the gaps).
  for (const [order, spec] of [[20, circle], [30, spine], [130, marking], [140, plainText], [150, memo]])
    ui.menuItem('Measure', { id: spec.id, label: spec.title, order, run: () => { open(spec); } });

  // circleValues is also the Job print's recheck of a saved circle; it needs the calculation file loaded.
  window.KinMeasureFrame = { open, renderer: (toolName, fn) => { renderers.set(toolName, fn); schedule(); }, geometry, gate, toImage, toWorld, addMark, removeMark, label, handle, svg,
    circleValues: (imageId, center, diameter, tags) => model ? circleValues(imageId, center, diameter, tags ?? instance(imageId)) : { reason: '측정 계산을 불러오지 못했습니다' },
    // The History panel's check before it saves a mark: '' when a circle's stored values are those of its place now.
    verify: a => a?.metadata?.toolName !== TOOLS.circle ? '' : !model ? '측정 계산을 불러오지 못했습니다' : circleCheck(a, a.metadata.referencedImageId, true).reason || '',
    model: () => model };
  return () => {
    ended = true; drag = null; active?.close(); active = null;
    for (const cleanup of cleanups) try { cleanup(); } catch (error) { console.error(error); }
    for (const entry of layers.values()) entry.root.remove();
    layers.clear(); checks.clear();
    if (window.KinMeasureFrame?.open === open) delete window.KinMeasureFrame;
  };
});
