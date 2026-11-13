// Viewer feature module: the Measure menu's orthopaedic and spine measurements — Limb Length Discrepancy, Acetabular Angle,
// Spine Balance, Cobb Angle (Lordosis / Kyphosis) and Pelvic Incidence. It registers through viewer-features.js and draws on
// the measuring frame of viewer-features-measure.js (window.KinMeasureFrame): the step panel takes the points in order, the
// values come from measure-ortho-model.js, and the marks are saved, locked and restored by the History panel as the frame's
// other marks (each under its own tool name, its values in data.kinBaseline: { calculator, values }).
// - The reader places every point on the image; nothing is found automatically.
// - A finished mark that may be edited shows a handle on each point: dragging one (with no measuring panel open) moves that
//   point only and the values follow; a place where they cannot be calculated is not taken. Every drag asks the edit gate.
// - Units: mm only where the frame says the spacing is that of the original; where the original has no spacing at all, the
//   values are in pixels and say so. A spacing that is known but not the one shown is refused, not turned into pixels.
// - The values a mark holds are checked again before it is saved (the frame's verify) and when it is drawn: a mark whose
//   stored values are not those of its points now says "재확인 필요" instead of its values.
window.KinViewerFeatures?.module('measure-ortho', ({ services, ui }) => {
  const cs = window.cornerstone, ct = window.cornerstoneTools;
  if (!cs?.utilities || !ct?.annotation?.state) return undefined;
  const TOOLS = { limbLength: 'KinLimbLength', acetabular: 'KinAcetabular', spineBalance: 'KinSpineBalance', spineCobb: 'KinSpineCobb', pelvicIncidence: 'KinPelvicIncidence' };
  const KINDS = Object.fromEntries(Object.entries(TOOLS).map(([kind, tool]) => [tool, kind]));
  const NUMBERS = ['①', '②', '③', '④', '⑤', '⑥'];
  let model = null, ended = false, attached = null, drag = null;
  const unregister = [], checks = new Map();
  const loaded = ui.load(['measure-ortho-model.js']).then(() => { model = window.KinMeasureOrthoModel; attach(); }, () => {});
  const frame = () => window.KinMeasureFrame || null;

  // ── Images ──
  const viewports = () => (cs.getEnabledElements?.() || []).map(entry => entry?.viewport).filter(v => v?.element && typeof v.getCurrentImageId === 'function');
  const imageOf = v => { try { return v.getCurrentImageId() || null; } catch (_) { return null; } };
  const instance = imageId => cs.metaData.get('instance', imageId) || null;
  const size = imageId => { const image = cs.cache?.getImage?.(imageId), tags = instance(imageId); return { rows: Number(image?.rows ?? tags?.Rows), columns: Number(image?.columns ?? tags?.Columns) }; };
  const insideImage = (imageId, [x, y]) => { const { rows, columns } = size(imageId); return x >= -.5 && y >= -.5 && x <= columns - .5 && y <= rows - .5; };
  const canvasPoint = (v, event) => { const rect = (v.canvas || v.element).getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; };
  const locked = a => !!ct.annotation.locking?.isAnnotationLocked?.(a.annotationUID) || !!a.isLocked;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  // The spacing of a measurement: { spacing, basis, label } or { reason }. The frame's answer, except that an original
  // with no spacing tags at all (ultrasound included: its calibration is per region and not for these radiographs) is
  // measured in pixels. Spacing tags that are there but cannot be used (an orientation that does not hold, a calibration,
  // a shown spacing that is not the original's) are refused, not turned into pixels.
  function spacingOf(imageId, points, tags) {
    const found = frame().geometry(imageId, points, tags);
    if (!model.hasSpacingTags(tags) && (found.basis === 'us' || found.reason === '이 영상에서는 간격을 확인할 수 없습니다' || found.reason === '초음파 보정 영역 안에서만 mm로 잴 수 있습니다'))
      return { spacing: null, basis: 'px', label: '' };
    if (found.basis === 'us') return { reason: '간격 태그가 있는 초음파 영상은 이 도구로 재지 않습니다' };
    if (found.reason) return { reason: found.reason === '이 영상에서는 간격을 확인할 수 없습니다' ? '간격 태그를 쓸 수 없어 재지 않습니다(영상 방향·간격 확인 불가)' : found.reason };
    return found;
  }
  // { values, calculator, basis, label } or { reason }. points: image pixel coordinates.
  function measure(kind, imageId, points, backSide, tags = instance(imageId)) {
    if (!model || !frame()) return { reason: '측정 계산을 불러오는 중입니다' };
    const found = spacingOf(imageId, points, tags);
    if (found.reason) return { reason: found.reason };
    const result = model.compute(kind, points, found.spacing, { backSide });
    if (result.reason) return { reason: result.reason };
    return { values: result.values, calculator: model.calculator(kind, found.basis, backSide), basis: found.basis, label: found.label, spacing: found.spacing };
  }
  // The values of a saved or drawn mark's points now, on its image.
  function remeasure(kind, imageId, worldPoints, calculator, tags) {
    const parsed = model?.parseCalculator(calculator);
    if (!parsed || parsed.kind !== kind) return { reason: '측정 종류를 확인할 수 없습니다' };
    return measure(kind, imageId, worldPoints.map(p => frame().toImage(imageId, p)), parsed.backSide, tags);
  }
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((n, i) => n === null || b[i] === null ? n === b[i] : Math.abs(n - b[i]) <= Math.max(1e-6, Math.abs(n) * 1e-9));
  // A mark against its stored values, once per position. fresh: computed now, not taken from an earlier verdict.
  function check(a, fresh = false) {
    const imageId = a.metadata.referencedImageId, stored = a.data.kinBaseline, kind = KINDS[a.metadata.toolName];
    const key = JSON.stringify([imageId, a.data.handles.points, stored]);
    const cached = checks.get(a.annotationUID);
    if (!fresh && cached?.key === key) return cached.result;
    let result;
    try {
      const now = remeasure(kind, imageId, a.data.handles.points, stored?.calculator);
      if (now.reason) result = { reason: '재확인 필요: ' + now.reason };
      else if (now.calculator !== stored.calculator || !same(now.values, stored.values)) result = { reason: '재확인 필요: 저장 당시 값과 다릅니다' };
      else result = { values: now.values, basis: now.basis, label: now.label, spacing: now.spacing, backSide: model.parseCalculator(stored.calculator).backSide };
    } catch (error) { result = { reason: '재확인 필요: ' + error.message }; }
    checks.set(a.annotationUID, { key, result });
    return result;
  }
  const textOf = (kind, imageId, result) => model.lines(kind, result.values, { basis: result.basis, sides: model.sideNames(instance(imageId)), backSide: result.backSide });

  // ── Drawing ──
  // While a measuring panel is open, a press is that panel's next point even over a handle (a point may sit where another
  // mark's point is); the points are dragged once the panel is closed.
  const measuring = () => !!document.querySelector('.kin-ux-feature-panel [data-measure-steps]');
  const N = 5;
  function renderer(kind) {
    return ({ g, a, imageId, canvas, look, color, editable }) => {
      const f = frame(); if (!f || !model) return;
      const image = a.data.handles.points.map(p => f.toImage(imageId, p)), c = image.map(canvas);
      const result = check(a);
      const line = (p, q, extra = {}) => f.svg('line', g, { x1: p[0], y1: p[1], x2: q[0], y2: q[1], stroke: color, 'stroke-width': look.width, ...extra });
      const dashed = { 'stroke-dasharray': '6 4' };
      const at = (i, j) => [(image[i][0] + image[j][0]) / 2, (image[i][1] + image[j][1]) / 2];
      const text = result.reason ? [result.reason] : textOf(kind, imageId, result);
      const red = result.reason ? '#ff6b6b' : color, step = (parseFloat(look.font) || 14) * 1.25;
      const block = (x, y, rows) => rows.forEach((row, i) => f.label(g, x, y + i * step, row, look, red));
      if (kind === 'limbLength') {
        line(c[0], c[1]); line(c[2], c[3], dashed); line(c[4], c[5], dashed);
        const anchor = c[0][0] >= c[1][0] ? c[0] : c[1];
        block(anchor[0] + 8, anchor[1] + 4, text);
      } else if (kind === 'acetabular') {
        line(c[0], c[1]); line(c[2], c[3]); line(c[4], c[5]);
        const [leftEnd, rightEnd] = image[0][0] <= image[1][0] ? [c[0], c[1]] : [c[1], c[0]];
        if (result.reason) block(leftEnd[0], leftEnd[1] + step, text);
        else { block(leftEnd[0] - 10, leftEnd[1] + step, [text[1]]); block(rightEnd[0] - 10, rightEnd[1] + step, [text[0], ...text.slice(2)]); }
      } else if (kind === 'spineBalance') {
        f.svg('polygon', g, { points: c.slice(0, 4).map(p => p.join(',')).join(' '), fill: 'none', stroke: color, 'stroke-width': look.width });
        line(c[4], c[5]);
        // The two vertical lines (the image's columns) and the horizontal distance between them at the pelvic level.
        const centre = [image.slice(0, 4).reduce((s, p) => s + p[0], 0) / 4, image.slice(0, 4).reduce((s, p) => s + p[1], 0) / 4], pelvis = at(4, 5);
        line(canvas(centre), canvas([centre[0], pelvis[1]]), dashed);
        line(canvas([pelvis[0], Math.min(centre[1], pelvis[1])]), canvas([pelvis[0], pelvis[1] + 20]), dashed);
        line(canvas([centre[0], pelvis[1]]), canvas(pelvis));
        const foot = canvas([Math.max(centre[0], pelvis[0]), pelvis[1]]);
        block(foot[0] + 8, foot[1] - step, text);
      } else if (kind === 'spineCobb') {
        line(c[0], c[1]); line(c[2], c[3]);
        const right = Math.max(...c.map(p => p[0])), middle = (Math.min(...c.map(p => p[1])) + Math.max(...c.map(p => p[1]))) / 2;
        block(right + 8, middle, text);
      } else if (kind === 'pelvicIncidence') {
        line(c[2], c[3]);
        const hip = at(0, 1), plate = at(2, 3), [h, m] = [canvas(hip), canvas(plate)];
        f.svg('circle', g, { cx: h[0], cy: h[1], r: 4, fill: 'none', stroke: color, 'stroke-width': look.width });
        line(c[0], c[1], dashed); line(m, h);
        // Guides only (the values come from the model): the endplate's perpendicular at its middle — on the patient plane, so
        // it stays perpendicular on pixels that are not square —, the vertical at the hip axis and the horizontal at the
        // endplate's back end (the image's columns and rows).
        const [row, column] = result.spacing || [1, 1], reach = Math.hypot(hip[0] - plate[0], hip[1] - plate[1]);
        const plateVector = [(image[2][0] - image[3][0]) * column, (image[2][1] - image[3][1]) * row];
        const normal = [plateVector[1] / column, -plateVector[0] / row], length = Math.hypot(...normal) || 1, down = normal[1] >= 0 ? 1 : -1;
        line(m, canvas([plate[0] + normal[0] / length * reach * down, plate[1] + normal[1] / length * reach * down]), dashed);
        line(h, canvas([hip[0], hip[1] - reach]), dashed);
        line(c[3], canvas([image[3][0] + (image[2][0] < image[3][0] ? -1 : 1) * reach * .8, image[3][1]]), dashed);
        block(Math.max(c[2][0], c[3][0]) + 8, Math.min(c[2][1], c[3][1]), text);
      }
      c.forEach((p, i) => {
        f.svg('circle', g, { cx: p[0], cy: p[1], r: 2.5, fill: color });
        f.svg('text', g, { x: p[0] + 5, y: p[1] - 5, fill: color, stroke: '#000', 'stroke-width': 3, 'paint-order': 'stroke', style: 'font:11px sans-serif' }, NUMBERS[i]);
        // While a measuring panel is open the handle lets the press through to the cell: it is that panel's next point.
        if (editable) {
          const node = f.svg('circle', g, { cx: p[0], cy: p[1], r: Math.max(N, look.width * 3), fill: 'transparent', stroke: color, 'stroke-width': look.width,
            style: measuring() ? 'pointer-events:none' : 'pointer-events:all;cursor:move' });
          node.dataset.kinPoint = String(i); node.dataset.kinHandle = a.annotationUID;
          node.addEventListener('pointerdown', event => startDrag(event, a, i));
        }
      });
    };
  }

  // ── Dragging one point of a finished mark ──
  function say(text) { if (text) ui.toast(text, 'warning'); }
  function startDrag(event, a, index) {
    if (event.button !== 0 || drag || measuring()) return;
    // Taken here, the press is no step point of an open panel and no press of the cell's own tool.
    event.preventDefault(); event.stopPropagation();
    const f = frame(), layer = event.target.closest?.('[data-kin-measure-layer]');
    const v = viewports().find(view => layer?.dataset.kinMeasureLayer === view.id && imageOf(view) === a.metadata.referencedImageId);
    const imageId = v && imageOf(v);
    const reason = !f ? '측정 틀을 찾을 수 없습니다' : locked(a) ? '저장한 표식은 측정 기록의 Edit를 누른 뒤 고칩니다' : f.gate(v, imageId);
    if (reason) { say(reason); return; }
    drag = { a, v, imageId, index, start: clone(a.data.handles.points), baseline: clone(a.data.kinBaseline), moved: false };
  }
  function dragTo(event, done) {
    const { a, v, imageId, index } = drag, f = frame();
    const reason = !f ? '측정 틀을 찾을 수 없습니다' : !ct.annotation.state.getAnnotation(a.annotationUID) ? '표식이 없어졌습니다' : locked(a) ? '표식이 잠겼습니다' :
      imageOf(v) !== imageId ? '영상이 바뀌어 옮기기를 멈췄습니다' : f.gate(v, imageId);
    if (reason) return cancelDrag(reason);
    const at = f.toImage(imageId, v.canvasToWorld(canvasPoint(v, event)));
    if (!insideImage(imageId, at)) return done ? cancelDrag('영상 밖으로는 옮기지 않습니다') : undefined;
    const points = drag.start.map((p, i) => i === index ? f.toWorld(imageId, at) : p);
    const now = remeasure(KINDS[a.metadata.toolName], imageId, points, drag.baseline?.calculator);
    // A place where the values cannot be calculated is not taken: the point stays where it last could.
    if (now.reason) { if (done) { if (!drag.moved) return cancelDrag(now.reason); say(now.reason); } else return undefined; }
    else {
      a.data.handles.points = points; a.data.kinBaseline = { calculator: now.calculator, values: now.values };
      drag.moved = true; a.invalidated = true;
    }
    if (done) { drag = null; ct.annotation.state.triggerAnnotationModified?.(a, v.element); }
    redraw(v);
  }
  function cancelDrag(reason) {
    if (!drag) return;
    const { a, v, start, baseline } = drag; drag = null;
    if (ct.annotation.state.getAnnotation(a.annotationUID)) { a.data.handles.points = start; a.data.kinBaseline = baseline; }
    say(reason); redraw(v);
  }
  // The frame draws again after a render of the cell.
  const redraw = v => { try { v?.render?.(); } catch (_) { /* a cell that is gone */ } };
  const onMove = event => { if (drag) dragTo(event, false); };
  const onUp = event => { if (drag) dragTo(event, true); };
  window.addEventListener('pointermove', onMove, true); window.addEventListener('pointerup', onUp, true);

  // ── The step panels ──
  const el = (tag, text, parent, attributes = {}) => {
    const node = document.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent?.append(node); return node;
  };
  // A finished mark from the panel's presses, remembered for the panel's Restart.
  function finish(tool, kind, presses, backSide) {
    const [first] = presses, imageId = first.imageId;
    const found = measure(kind, imageId, presses.map(p => p.image), backSide);
    if (found.reason) return found.reason;
    const a = frame().addMark(first.v, imageId, TOOLS[kind], presses.map(p => p.world), { kinBaseline: { calculator: found.calculator, values: found.values } });
    tool.marks.push(a.annotationUID);
    tool.state.last = textOf(kind, imageId, { ...found, backSide }).join(' · ');
    // The mark and the cell it was made in: a later Back side is read and turned in that same cell's view.
    tool.state.made = a.annotationUID; tool.state.madeIn = first.v.id;
    return '';
  }
  const result = tool => tool.state.last ? 'Result: ' + tool.state.last : '';
  const restart = tool => { tool.state.last = ''; tool.state.made = null; tool.state.madeIn = null; };

  // Where the back is, chosen as the reader sees it in the cell: Right / Left, or Top / Bottom when the image's rows run up
  // and down the screen (a turned view). It is turned into the image's own side when the mark is made, so a mirrored or
  // turned view later shows the same mark the same way.
  function screenAxis(v) {
    const imageId = v && imageOf(v), f = frame();
    if (!imageId || !f) return { vertical: false, rightIs: 'Right' };
    try {
      const a = v.worldToCanvas(f.toWorld(imageId, [0, 0])), b = v.worldToCanvas(f.toWorld(imageId, [1, 0])), dx = b[0] - a[0], dy = b[1] - a[1];
      return Math.abs(dx) >= Math.abs(dy) ? { vertical: false, rightIs: dx >= 0 ? 'Right' : 'Left' } : { vertical: true, rightIs: dy >= 0 ? 'Bottom' : 'Top' };
    } catch (_) { return { vertical: false, rightIs: 'Right' }; }
  }
  const activeViewport = () => {
    const id = services?.viewportGridService?.getActiveViewportId?.();
    return viewports().find(v => v.id === id) || viewports().find(v => v.type === 'stack' && imageOf(v)) || null;
  };
  const imageSide = (choice, axis) => (choice === axis.rightIs) ? 'right' : 'left';

  const specs = {
    limbLength: {
      id: 'measure-limb-length', title: 'Limb Length Discrepancy',
      note: '기준선을 긋고, 좌우의 같은 골반 표지와 좌우의 같은 대퇴 표지를 찍습니다. 쪽마다 골반 표지에서 대퇴 표지까지를 기준선의 수직 방향으로 잰 거리와, 두 값의 차를 냅니다(좌우는 찍은 순서가 아니라 영상의 자리로 짝짓습니다).',
      steps: [{ text: '①② 기준선의 두 끝', points: 2 }, { text: '③④ 좌우의 같은 골반 표지(예: 좌골결절)', points: 2 }, { text: '⑤⑥ 좌우의 같은 대퇴 표지(예: 소전자 중점)', points: 2 }],
    },
    acetabular: {
      id: 'measure-acetabular', title: 'Acetabular Angle',
      note: '좌우를 잇는 기준선 A를 긋고, 양쪽 비구의 선을 긋습니다. A의 양 끝에 그쪽 비구 선과 A가 이루는 각과 보각을 냅니다(괄호는 360°에서 뺀 값).',
      steps: [{ text: '①② 기준선 A의 두 끝(좌우)', points: 2 }, { text: '③④ 한쪽 비구의 선', points: 2 }, { text: '⑤⑥ 다른 쪽 비구의 선', points: 2 }],
    },
    spineBalance: {
      id: 'measure-spine-balance', title: 'Spine Balance',
      note: '정면(PA) 전척추 영상에서 위쪽 척추체의 네 모서리와 골반 높이의 좌우 두 점을 찍습니다. 척추체 중심에서 내린 수직선과 골반 두 점의 가운데에서 세운 수직선 사이의 가로 거리를 냅니다.',
      steps: [{ text: '①②③④ 위쪽 척추체의 네 모서리', points: 4 }, { text: '⑤⑥ 골반 높이의 좌우 두 점', points: 2 }],
    },
    spineCobb: {
      id: 'measure-cobb', title: 'Cobb Angle (Lordosis / Kyphosis)',
      note: '측면 영상에서 위·아래 끝 척추의 종판 선을 긋고 등의 위치를 고릅니다(선을 그은 뒤 바꾸면 방금 그린 표식에 적용됩니다). 두 선이 등 쪽으로 모이면 Lordosis(−), 앞쪽으로 모이면 Kyphosis(+)입니다. 괄호는 360°에서 뺀 값입니다.',
      steps: [{ text: '①② 한 끝 척추의 종판 선', points: 2 }, { text: '③④ 다른 끝 척추의 종판 선', points: 2 }],
      fields(body, tool) {
        const wrap = el('label', '', body); wrap.style.cssText = 'display:flex;gap:.5em;align-items:center;margin:.3em 0';
        const select = el('select', '', null, { 'aria-label': 'Back side' });
        wrap.append('Back side', select);
        const s = tool.state; s.select = select; s.choice = null;
        // The cell the mark just made is in, while it still shows that mark's image.
        const cellOfMade = () => { const a = s.made && ct.annotation.state.getAnnotation(s.made);
          return a ? viewports().find(view => view.id === s.madeIn && imageOf(view) === a.metadata.referencedImageId) || null : null; };
        // The cell the choice is read in: that of the points of a mark being made (its first point is there), else that of
        // the mark just made (while it is there), else the active cell.
        const cellOfChoice = () => tool.presses[0]?.v || cellOfMade() || activeViewport();
        s.paint = (cell = cellOfChoice()) => {
          const axis = screenAxis(cell), options = axis.vertical ? ['Top', 'Bottom'] : ['Right', 'Left'];
          // The original's default is the right; on a turned view, the side where the image's right is.
          if (!options.includes(s.choice)) s.choice = axis.vertical ? axis.rightIs : 'Right';
          if ([...select.options].map(o => o.value).join() !== options.join()) select.replaceChildren(...options.map(name => el('option', name, null, { value: name })));
          select.value = s.choice;
        };
        // The original asks for the back's side after the four points: a change applies to the mark this panel just made
        // (while it is not saved), through the edit gate, and to the marks after it.
        select.onchange = () => {
          const previous = s.choice; s.choice = select.value;
          // While the points of a new mark are being placed, the choice is for that mark only.
          if (tool.presses.length) return;
          const a = s.made && ct.annotation.state.getAnnotation(s.made);
          if (!a || locked(a) || !tool.marks.includes(a.annotationUID)) return;
          const v = cellOfMade(), imageId = v && imageOf(v);
          const refuse = reason => { tool.status.textContent = reason; s.choice = previous; select.value = previous; };
          const reason = !v ? '표식을 만든 칸에 그 영상이 없어 등의 위치를 바꾸지 않습니다' : frame().gate(v, imageId);
          if (reason) return refuse(reason);
          const backSide = imageSide(s.choice, screenAxis(v));
          const now = measure('spineCobb', imageId, a.data.handles.points.map(p => frame().toImage(imageId, p)), backSide);
          if (now.reason) return refuse(now.reason);
          a.data.kinBaseline = { calculator: now.calculator, values: now.values }; a.invalidated = true;
          s.last = textOf('spineCobb', imageId, { ...now, backSide }).join(' · ');
          tool.status.textContent = '';
          ct.annotation.state.triggerAnnotationModified?.(a, v.element);
          tool.refresh(); redraw(v);
        };
        select.onfocus = () => s.paint();
        s.paint();
      },
      complete(tool, presses) {
        // The choices and their turn into the image's side in one cell: the one these points are in.
        const s = tool.state, cell = presses[0].v; s.paint(cell);
        return finish(tool, 'spineCobb', presses, imageSide(s.choice, screenAxis(cell)));
      },
    },
    pelvicIncidence: {
      id: 'measure-pelvic-incidence', title: 'Pelvic Incidence',
      note: '측면 영상에서 차례대로 찍습니다(차례가 틀리면 값이 틀립니다): 좌우 대퇴골두 중심, S1 위 종판의 앞 끝, 뒤 끝. PI = PT + SS.',
      steps: [{ text: '①② 좌우 대퇴골두의 중심', points: 2 }, { text: '③ S1 위 종판의 앞 끝', points: 1 }, { text: '④ S1 위 종판의 뒤 끝', points: 1 }],
    },
  };
  for (const [kind, spec] of Object.entries(specs)) {
    spec.complete ||= (tool, presses) => finish(tool, kind, presses);
    spec.result = tool => { if (kind === 'spineCobb') tool.state.paint?.(); return result(tool); };
    spec.restart = restart;
  }
  for (const [order, kind] of [[70, 'limbLength'], [80, 'acetabular'], [90, 'spineBalance'], [100, 'spineCobb'], [110, 'pelvicIncidence']])
    ui.menuItem('Measure', { id: specs[kind].id, label: specs[kind].title, order, run: () => {
      if (!attach()) { ui.toast('측정 틀을 불러오는 중입니다. 잠시 뒤 다시 누르세요.', 'warning'); return; }
      frame().open(specs[kind]);
    } });

  // ── Joining the frame: the drawings, the check before a save, the Job print's recheck ──
  function attach() {
    const f = frame();
    if (ended || !f || !model) return false;
    if (attached === f) return true;
    attached = f;
    for (const [kind, tool] of Object.entries(TOOLS)) {
      f.renderer(tool, renderer(kind));
      if (typeof f.verifier === 'function') unregister.push(f.verifier(tool, a => check(a, true).reason || ''));
    }
    return true;
  }
  const waiting = setInterval(() => { if (attach() || ended) clearInterval(waiting); }, 200);
  // The Job print checks a saved mark on its own copy of the image: item = the saved item (world points, baseline).
  window.KinMeasureOrtho = {
    kinds: () => Object.keys(TOOLS),
    values: (imageId, item, tags) => model && frame() ? remeasure(item.kind, imageId, item.points, item.baseline?.calculator, tags) : { reason: '측정 계산을 불러오지 못했습니다' },
    lines: (item, tags) => { const parsed = model?.parseCalculator(item.baseline?.calculator);
      return model ? model.lines(item.kind, item.baseline?.values, { basis: parsed?.basis, sides: model.sideNames(tags), backSide: parsed?.backSide }) : []; },
  };
  void loaded;
  return () => {
    ended = true; drag = null; clearInterval(waiting);
    window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true);
    for (const off of unregister) try { off?.(); } catch (_) { /* the frame has gone */ }
    checks.clear();
    if (window.KinMeasureOrtho?.kinds) delete window.KinMeasureOrtho;
  };
});
