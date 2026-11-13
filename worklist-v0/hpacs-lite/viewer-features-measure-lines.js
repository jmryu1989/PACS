// Viewer feature module: the Measure menu's line tools — CTR (4-line / 2-line), Parallel Lines, Length Ratio, Centre-line Angle
// and Volume Measure. It stands on the measuring frame of viewer-features-measure.js (window.KinMeasureFrame): the step panel
// takes the presses on the image, the frame asks the edit gate before each one, and the marks live in the annotation state
// under their own tool names, saved and restored by the History panel as the frame's other marks.
// - Values come from measure-lines-model.js on the patient (image pixels times the spacing): in mm only where the frame says
//   the spacing is known (planar spacing, MG, ultrasound Region Calibration); otherwise in pixels, marked as pixel-based. A
//   Volume is never calculated in pixels. A value that cannot be defined (a length of 0, a ratio over 0) is shown as "—".
// - A finished mark that is not locked (not saved, or opened with the History panel's Edit) has a handle on each of its points;
//   dragging one asks the gate on every move, keeps Parallel Lines parallel, and calculates the values again.
// - A Volume's two or three lengths may be measured on different frames of one study; each keeps its own original (series,
//   SOP, frame, points, spacing basis) in the result mark, is drawn on its frame when that frame is shown, and is checked
//   again from that frame's metadata when the mark is drawn, saved or printed.
window.KinViewerFeatures?.module('measure-lines', ({ ui }) => {
  const cs = window.cornerstone, ct = window.cornerstoneTools, F = window.KinMeasureFrame;
  if (!cs?.utilities || !ct?.annotation?.state || !F) return undefined;
  const TOOLS = { ctr: 'KinCTR', parallel: 'KinParallelLines', ratio: 'KinLengthRatio', angle: 'KinCentreLineAngle', volume: 'KinVolume' };
  const LINE_TOOLS = [TOOLS.ctr, TOOLS.parallel, TOOLS.ratio, TOOLS.angle];
  const CENTRE = '#9fd4ff', WARN = '#ff6b6b';
  const cleanups = [];
  let model = null, ended = false, drag = null, volumeTool = null;
  ui.load(['measure-lines-model.js']).then(() => { model = window.KinMeasureLinesModel; F.schedule(); }, () => {});

  const el = (tag, text, parent, attributes = {}) => {
    const node = document.createElement(tag); if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    parent?.append(node); return node;
  };
  const field = (parent, text, control) => { const wrap = el('label', '', parent); wrap.style.cssText = 'display:flex;gap:.5em;align-items:center;margin:.3em 0'; wrap.append(text, control); return control; };
  const reference = imageId => window.kinViewerImageReference?.(imageId) || null;
  const toolOf = baseline => String(baseline?.calculator || '').split(':')[0].slice(4, -3);
  const basisOf = baseline => String(baseline?.calculator || '').split(':')[1] || '';
  // The spacing of points on an image: the frame's (mm), or none (pixels) with the frame's reason.
  function spacingOf(imageId, points, tags) {
    const found = F.geometry(imageId, points, tags);
    return found.reason ? { spacing: null, basis: 'px', reason: found.reason } : { spacing: found.spacing, basis: found.basis, label: found.label };
  }
  const lineValues = (tool, imageId, image, tags) => { const found = spacingOf(imageId, image, tags); return { ...found, values: model.calculate(tool, image, found.spacing) }; };

  // ── Checks: a mark's stored values against its place now (once per position; fresh before a save or a print) ──
  const checks = new Map();
  // Points of a mark on a frame as the frame's metadata places it now: on the image plane (within 0.001 mm) and inside the
  // image; for a Volume's length also the frame's identity, its frame count and its frame of reference. '' or a reason.
  // tags: the original's tags where the image has none of its own (the Job print's copy of the frame).
  function onFrame(imageId, points, source, tags = F.instance(imageId)) {
    if (!tags) return '원본 영상 정보를 확인할 수 없습니다';
    if (source) {
      const ref = reference(imageId), frames = Number(tags.NumberOfFrames ?? 1);
      if (!ref || ref.seriesUid !== source.seriesUid || ref.sopUid !== source.sopUid || ref.frame !== source.frame || !(source.frame <= frames))
        return '원본 영상 참조가 일치하지 않습니다';
      if ((tags.FrameOfReferenceUID || null) !== source.frameOfReferenceUid) return '원본의 좌표 기준이 저장 당시와 다릅니다';
    }
    for (const world of points) {
      const image = F.toImage(imageId, world), back = F.toWorld(imageId, image);
      if (!image.every(Number.isFinite) || Math.hypot(...world.map((n, i) => n - back[i])) > .001) return '점이 원본 영상의 평면 밖에 있습니다';
      if (!F.insideImage(imageId, image)) return '점이 원본 영상 범위를 벗어납니다';
    }
    return '';
  }
  function lineCheck(a, imageId, fresh, tags) {
    if (!model) return { reason: '' };
    const key = JSON.stringify([imageId, a.data.handles.points, a.data.kinBaseline]), cached = checks.get(a.annotationUID);
    if (!fresh && !tags && cached?.key === key) return cached.result;
    let result;
    try {
      const stored = a.data.kinBaseline, tool = toolOf(stored), image = a.data.handles.points.map(p => F.toImage(imageId, p));
      const where = onFrame(imageId, a.data.handles.points, null, tags || undefined);
      const now = where ? null : lineValues(tool, imageId, image, tags);
      if (where) result = { reason: '재확인 필요: ' + where };
      else if (stored?.calculator !== 'kin-' + tool + '-v1:' + now.basis) result = { reason: '재확인 필요: ' + (now.reason || '간격 기준이 저장 당시와 다릅니다') };
      else if (!model.same(now.values, stored.values)) result = { reason: '재확인 필요: 저장 당시 값과 다릅니다' };
      else result = { label: now.label };
    } catch (error) { result = { reason: '재확인 필요: ' + error.message }; }
    if (!tags) checks.set(a.annotationUID, { key, result });
    return result;
  }
  // The image id of a Volume length's original: one shown now, or an image id of this viewer (the result mark's) with the
  // study (when given) and that frame's identity in its place.
  function sourceImage(template, source, study) {
    for (const v of F.viewports()) {
      const id = F.imageOf(v), ref = reference(id);
      if (ref && (!study || ref.study === study) && ref.seriesUid === source.seriesUid && ref.sopUid === source.sopUid && ref.frame === source.frame) return id;
    }
    const pattern = /\/studies\/([0-9.]+)\/series\/[0-9.]+\/instances\/[0-9.]+\/frames\/[1-9][0-9]*/;
    return typeof template === 'string' && pattern.test(template)
      ? template.replace(pattern, (_, own) => `/studies/${study || own}/series/${source.seriesUid}/instances/${source.sopUid}/frames/${source.frame}`) : null;
  }
  // A length on its original: its mm length now, or a reason.
  function sourceLength(imageId, source) {
    if (!imageId || !F.instance(imageId)) return { reason: '부피 길이의 원본 영상 정보를 확인할 수 없습니다' };
    const where = onFrame(imageId, source.points, source); if (where) return { reason: where };
    const image = source.points.map(p => F.toImage(imageId, p)), found = F.geometry(imageId, image);
    if (found.reason) return { reason: found.reason };
    if ('kin-length-v1:' + found.basis !== source.calculator) return { reason: '부피 길이의 간격 기준이 저장 당시와 다릅니다' };
    return { length: model.length(image, found.spacing), image };
  }
  function volumeCheck(a, fresh, template = a.metadata.referencedImageId, study) {
    if (!model) return { reason: '' };
    const key = JSON.stringify([template, a.data.handles.points, a.data.kinBaseline]), cached = checks.get(a.annotationUID);
    if (!fresh && cached?.key === key) return cached.result;
    let result;
    try {
      const b = a.data.kinBaseline, formula = b?.calculator?.match(/^kin-volume-v1:(ellipsoid|prolate)$/)?.[1];
      const parts = formula && model.formulaParts(formula);
      if (!parts || !Array.isArray(b.sources) || b.sources.length !== parts.length || b.values?.length !== parts.length + 1) result = { reason: '재확인 필요: 값을 확인할 수 없습니다' };
      else {
        const now = b.sources.map(source => sourceLength(sourceImage(template, source, study), source));
        const failed = now.find(n => n.reason);
        const lengths = Object.fromEntries(parts.map((part, i) => [part, now[i].length]));
        if (failed) result = { reason: '재확인 필요: ' + failed.reason };
        else if (!model.same([...now.map(n => n.length), model.volume(formula, lengths)], b.values)) result = { reason: '재확인 필요: 저장 당시 값과 다릅니다' };
        else result = {};
      }
    } catch (error) { result = { reason: '재확인 필요: ' + error.message }; }
    checks.set(a.annotationUID, { key, result });
    return result;
  }
  for (const name of LINE_TOOLS) cleanups.push(F.verifier(name, a => !model ? '측정 계산을 불러오지 못했습니다' : lineCheck(a, a.metadata.referencedImageId, true).reason || ''));
  cleanups.push(F.verifier(TOOLS.volume, a => !model ? '측정 계산을 불러오지 못했습니다' : volumeCheck(a, true).reason || ''));
  // The Job print's check of a saved item on its frame (id: the print's copy of the frame, tags: the original's tags, study:
  // the item's study).
  window.KinMeasureLines = { recheck(item, id, tags, study) {
    if (!model) return '측정 계산을 불러오지 못했습니다';
    const a = { annotationUID: 'kin-print-check', metadata: { referencedImageId: id }, data: { handles: { points: item.points }, kinBaseline: item.baseline } };
    if (item.kind !== 'volume') return lineCheck(a, id, true, tags).reason || '';
    // The lengths are checked on their originals as this viewer knows them (the study is open here): an image id of a cell
    // of this viewer, with the item's study and each original's identity, names each original.
    const own = study || reference(id)?.study;
    const template = F.viewports().map(v => F.imageOf(v)).find(imageId => reference(imageId)) || id;
    return volumeCheck({ ...a, annotationUID: 'kin-print-check-volume' }, true, template, own).reason || '';
  },
  // The lines a saved item's print draws besides the lines between its points, in world coordinates of the print's frame:
  // CTR's two heart-border perpendiculars, the Parallel Lines' centre line, the Centre-line Angle's two centre lines.
  guides(item, id, tags) {
    if (!model || item?.kind === 'volume') return [];
    const tool = toolOf(item.baseline), image = item.points.map(p => F.toImage(id, p)), spacing = spacingOf(id, image, tags).spacing;
    const back = points => points.map(p => F.toWorld(id, p));
    if (tool === 'ctr4') { const feet = model.ctrFeet(image, spacing); return feet ? [back([image[2], feet[0]]), back([image[3], feet[1]])] : []; }
    if (tool === 'parallel') return [back(model.parallelCentre(image))];
    if (tool === 'centreangle') return model.centreLines(image, spacing).filter(Boolean).map(back);
    return [];
  } };

  // ── Drawing ──
  const seg = (g, a, b, color, look, dashed) => F.svg('line', g, { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: color, 'stroke-width': look.width, ...(dashed ? { 'stroke-dasharray': '6 4' } : {}) });
  const words = (g, at, lines, look, color) => lines.forEach((line, i) => F.label(g, at[0] + 8, at[1] + 4 + i * (parseFloat(look.font) || 14) * 1.25, line, look, color));
  function pointHandle(g, a, which, at, look, color) {
    const node = F.svg('circle', g, { cx: at[0], cy: at[1], r: Math.max(4, look.width * 3), fill: 'transparent', stroke: color, 'stroke-width': look.width, style: 'pointer-events:all;cursor:move' });
    node.dataset.kinPoint = which.join(':'); node.dataset.kinHandle = a.annotationUID;
    node.addEventListener('pointerdown', event => startDrag(event, a, which));
  }
  function drawLines({ g, a, imageId, canvas, look, color, editable }) {
    if (!model) return;
    const stored = a.data.kinBaseline, tool = toolOf(stored), image = a.data.handles.points.map(p => F.toImage(imageId, p)), at = image.map(canvas);
    const check = lineCheck(a, imageId, false), spacing = spacingOf(imageId, image).spacing;
    if (tool === 'ctr4') {
      seg(g, at[0], at[1], CENTRE, look, true);
      const feet = model.ctrFeet(image, spacing);
      if (feet) { seg(g, at[2], canvas(feet[0]), color, look); seg(g, at[3], canvas(feet[1]), color, look); }
      seg(g, at[4], at[5], color, look);
    } else if (tool === 'parallel') {
      seg(g, at[0], at[1], color, look); seg(g, at[2], at[3], color, look);
      const [m1, m2] = model.parallelCentre(image).map(canvas); seg(g, m1, m2, CENTRE, look, true);
    } else if (tool === 'centreangle') {
      for (let i = 0; i < 8; i += 2) seg(g, at[i], at[i + 1], color, look);
      for (const line of model.centreLines(image, spacing)) if (line) seg(g, canvas(line[0]), canvas(line[1]), CENTRE, look, true);
    } else {
      seg(g, at[0], at[1], color, look); seg(g, at[2], at[3], color, look);
      if (tool === 'ratio') { F.label(g, at[1][0] + 6, at[1][1], 'L1', look, color); F.label(g, at[3][0] + 6, at[3][1], 'L2', look, color); }
    }
    const corner = [Math.max(...at.map(p => p[0])), Math.min(...at.map(p => p[1]))];
    words(g, corner, check.reason ? [check.reason] : [...model.lines(tool, stored.values, basisOf(stored)), ...(check.label ? [check.label] : [])], look, check.reason ? WARN : color);
    if (editable) {
      at.forEach((p, i) => pointHandle(g, a, ['point', i], p, look, color));
      // Parallel Lines: the second line's middle moves it sideways (the gap) and along.
      if (tool === 'parallel') pointHandle(g, a, ['shift'], [(at[2][0] + at[3][0]) / 2, (at[2][1] + at[3][1]) / 2], look, CENTRE);
    }
  }
  for (const name of LINE_TOOLS) F.renderer(name, drawLines);
  F.renderer(TOOLS.volume, ({ g, a, fromWorld, look, color }) => {
    if (!model) return;
    const b = a.data.kinBaseline, check = volumeCheck(a, false), at = fromWorld(a.data.handles.points[0]);
    const parts = model.formulaParts(basisOf(b)), values = b?.values || [];
    const lines = check.reason ? [check.reason] : [String(a.data.text || 'Volume') + ': ' + model.volumeText(values[parts.length] ?? null),
      parts.map((part, i) => part[0] + ' ' + model.one(values[i] ?? null) + ' mm').join(' · ')];
    F.svg('circle', g, { cx: at[0], cy: at[1], r: 3, fill: color });
    words(g, at, lines, look, check.reason ? WARN : color);
  });
  // A Volume's lengths on the frames they were measured on (saved or not yet stamped), with handles while the mark is unlocked.
  function volumeLines(imageId) {
    const ref = reference(imageId); if (!ref) return [];
    const out = [];
    for (const a of ct.annotation.state.getAllAnnotations()) {
      if (a?.metadata?.toolName !== TOOLS.volume || a.isVisible === false || reference(a.metadata.referencedImageId)?.study !== ref.study) continue;
      const sources = a.data.kinBaseline?.sources || [], parts = model ? model.formulaParts(basisOf(a.data.kinBaseline)) : [];
      sources.forEach((s, i) => { if (s.seriesUid === ref.seriesUid && s.sopUid === ref.sopUid && s.frame === ref.frame) out.push({ a, i, points: s.points, letter: (parts[i] || '?')[0] }); });
    }
    // Saved Volumes the History panel has not drawn yet (their result is on a frame not shown since the viewer opened): their
    // lengths are drawn on their own frames, locked, each checked against its stored length.
    const state = window.kinViewerHistoryState?.();
    if (state?.scope === ref.study) for (const head of state.heads || []) {
      if (head.kind !== 'volume' || head.hidden || !head.item || head.annotation && ct.annotation.state.getAnnotation(head.annotation)) continue;
      const b = head.item.baseline, parts = model ? model.formulaParts(basisOf(b)) : [];
      (b?.sources || []).forEach((s, i) => { if (s.seriesUid === ref.seriesUid && s.sopUid === ref.sopUid && s.frame === ref.frame)
        out.push({ saved: true, points: s.points, letter: (parts[i] || '?')[0], source: s, length: b.values?.[i] }); });
    }
    for (const [name, part] of Object.entries(volumeTool?.state.parts || {})) if (part?.imageId === imageId) out.push({ pending: true, points: part.world, letter: name[0] });
    return out;
  }
  cleanups.push(F.overlay({ wants: imageId => !!model && volumeLines(imageId).length > 0, draw({ root, imageId, fromWorld, look }) {
    for (const line of volumeLines(imageId)) {
      const g = F.svg('g', root); g.dataset.kinVolumeLength = line.letter;
      const editable = !line.pending && !line.saved && !F.locked(line.a);
      let color = line.pending || editable ? look.color : look.locked, letter = line.letter;
      if (line.saved) {
        const now = sourceLength(imageId, line.source);
        if (now.reason || !model.same([now.length], [line.length])) { color = WARN; letter += ' 재확인 필요'; }
      }
      const [p, q] = line.points.map(fromWorld);
      seg(g, p, q, color, look); F.label(g, q[0] + 6, q[1], letter, look, color);
      if (editable) [p, q].forEach((at, j) => pointHandle(g, line.a, ['source', line.i, j, imageId], at, look, color));
    }
  } }));

  // ── Dragging one point of an unlocked mark ──
  function startDrag(event, a, which) {
    if (event.button !== 0 || drag || !model) return;
    event.preventDefault(); event.stopPropagation();
    const root = event.target.closest?.('svg[data-kin-measure-layer]'), v = F.viewports().find(view => view.id === root?.dataset.kinMeasureLayer);
    const imageId = v && F.imageOf(v), source = which[0] === 'source';
    const reason = F.locked(a) ? '저장한 표식은 측정 기록의 Edit를 누른 뒤 고칩니다' : !v ? '영상 칸을 확인할 수 없습니다' :
      (source ? which[3] : a.metadata.referencedImageId) !== imageId ? '영상이 바뀌었습니다' : F.gate(v, imageId);
    if (reason) { ui.toast(reason, 'warning'); return; }
    drag = { a, v, imageId, which, start: structuredClone(a.data.handles.points), baseline: structuredClone(a.data.kinBaseline),
      from: F.toImage(imageId, v.canvasToWorld(F.canvasPoint(v, event))) };
  }
  // The points of a mark (or of a Volume's length) after a move, in image pixels; null when the move is not taken.
  function moved(at) {
    const { a, imageId, which, start, baseline } = drag;
    if (which[0] === 'source') {
      const pts = baseline.sources[which[1]].points.map(p => F.toImage(imageId, p)); pts[which[2]] = at; return pts;
    }
    const pts = start.map(p => F.toImage(imageId, p)), tool = toolOf(baseline), spacing = spacingOf(imageId, pts).spacing;
    if (which[0] === 'shift') {
      const delta = [at[0] - drag.from[0], at[1] - drag.from[1]];
      return pts.map((p, i) => i >= 2 ? [p[0] + delta[0], p[1] + delta[1]] : p);
    }
    const i = which[1];
    if (tool === 'parallel' && i >= 2) return model.parallelSlide(pts, i, at, spacing);
    pts[i] = at;
    return tool === 'parallel' ? model.parallelAlign(pts, spacing) : pts;
  }
  function dragTo(event, done) {
    const { a, v, imageId, which, baseline } = drag;
    const reason = !ct.annotation.state.getAnnotation(a.annotationUID) ? '표식이 없어졌습니다' : F.locked(a) ? '표식이 잠겼습니다' : F.imageOf(v) !== imageId ? '영상이 바뀌어 고치기를 멈췄습니다' : F.gate(v, imageId);
    if (reason) return cancelDrag(reason);
    const at = F.toImage(imageId, v.canvasToWorld(F.canvasPoint(v, event)));
    let pts, why = '';
    try { pts = moved(at); } catch (error) { why = error.message; }
    if (!why && !pts.every(p => F.insideImage(imageId, p))) why = '영상 밖으로는 옮기지 않습니다';
    let next;
    if (!why && which[0] === 'source') {
      // A Volume's length: measured again on its own frame; the volume follows.
      const found = F.geometry(imageId, pts), source = baseline.sources[which[1]];
      if (found.reason || 'kin-length-v1:' + found.basis !== source.calculator) why = found.reason || '간격 기준이 다른 자리로는 옮기지 않습니다';
      else {
        const formula = basisOf(baseline), parts = model.formulaParts(formula), values = [...baseline.values];
        values[which[1]] = model.length(pts, found.spacing);
        values[parts.length] = model.volume(formula, Object.fromEntries(parts.map((part, i) => [part, values[i]])));
        if (values[parts.length] === null) why = '길이가 0인 자리로는 옮기지 않습니다';
        else next = { points: drag.start, baseline: { ...baseline, values, sources: baseline.sources.map((s, i) => i === which[1] ? { ...s, points: pts.map(p => F.toWorld(imageId, p)) } : s) } };
      }
    } else if (!why) {
      const tool = toolOf(baseline), now = lineValues(tool, imageId, pts);
      // The spacing basis is kept: a move into another ultrasound region or out of it is not taken.
      if (now.basis !== basisOf(baseline)) why = now.reason || '간격 기준이 다른 자리로는 옮기지 않습니다';
      else next = { points: pts.map(p => F.toWorld(imageId, p)), baseline: { calculator: baseline.calculator, values: now.values } };
    }
    if (why) return done ? cancelDrag(why) : undefined;
    a.data.handles.points = next.points; a.data.kinBaseline = next.baseline; a.invalidated = true;
    if (done) { drag = null; ct.annotation.state.triggerAnnotationModified?.(a, v.element); }
    F.schedule();
  }
  function cancelDrag(reason) {
    if (!drag) return;
    const { a, start, baseline } = drag; drag = null;
    if (ct.annotation.state.getAnnotation(a.annotationUID)) { a.data.handles.points = start; a.data.kinBaseline = baseline; }
    if (reason) ui.toast(reason, 'warning');
    F.schedule();
  }
  const onMove = event => { if (drag) dragTo(event, false); };
  const onUp = event => { if (drag) dragTo(event, true); };
  window.addEventListener('pointermove', onMove, true); window.addEventListener('pointerup', onUp, true);
  cleanups.push(() => { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); });

  // ── The tools ──
  // A finished line mark from the presses of one image.
  function stamp(tool, press, toolName, calculator, image) {
    const found = lineValues(calculator, press.imageId, image);
    const a = F.addMark(press.v, press.imageId, toolName, image.map(p => F.toWorld(press.imageId, p)), { kinBaseline: { calculator: 'kin-' + calculator + '-v1:' + found.basis, values: found.values } });
    tool.marks.push(a.annotationUID);
    tool.state.last = model.lines(calculator, found.values, found.basis).join(' · ') + (found.reason ? ' — ' + found.reason : '');
    return '';
  }
  const result = tool => tool.state.last ? 'Result: ' + tool.state.last : '';
  const restart = tool => { tool.state.last = ''; };

  function ctr() {
    const four = [{ text: 'Midline — 대동맥 꼭대기에서 심장 바닥까지 (두 점)', points: 2 }, { text: 'Right heart border — 정중선에서 가장 먼 오른쪽 끝 (한 점)', points: 1 },
      { text: 'Left heart border — 정중선에서 가장 먼 왼쪽 끝 (한 점)', points: 1 }, { text: 'Lung field — 폐야의 가장 넓은 곳 양 끝 (두 점)', points: 2 }];
    const two = [{ text: 'Heart — 심장의 가장 넓은 폭 양 끝 (두 점)', points: 2 }, { text: 'Chest — 흉곽 안쪽의 가장 넓은 폭 양 끝 (두 점)', points: 2 }];
    const spec = { id: 'measure-ctr', title: 'CTR', steps: four, result, restart,
      note: '흉부 영상에 선을 그어 심흉비를 냅니다. 4-line: CTR = (MRD + MLD) / ID. 2-line: 긴 선이 흉곽(ID), 짧은 선이 심장(CD), CTR = CD / ID.',
      fields(body, tool) {
        const method = field(body, 'Method', el('select', '', null, { 'aria-label': 'CTR Method' }));
        el('option', '4-line (midline, MRD, MLD, ID)', method, { value: '4' }); el('option', '2-line (heart and chest widths)', method, { value: '2' });
        tool.state.method = '4';
        method.onchange = () => { tool.state.method = method.value; spec.steps = method.value === '2' ? two : four; tool.presses = []; tool.state.last = ''; tool.status.textContent = ''; tool.refresh(); };
      },
      complete: (tool, presses) => stamp(tool, presses[0], TOOLS.ctr, tool.state.method === '2' ? 'ctr2' : 'ctr4', presses.map(p => p.image)) };
    return spec;
  }
  const parallel = () => ({ id: 'measure-parallel', title: 'Parallel Lines', result, restart,
    note: '평행한 두 선을 그으면 두 선 사이의 간격(Gap)과 두 선의 가운데를 잇는 중심선의 길이(Centre)를 따로 냅니다.',
    steps: [{ text: 'First line — 시작점과 끝점 (두 점)', points: 2 }, { text: 'Second line — 둘째 선의 가운데 자리 (한 점; 첫 선과 평행, 같은 길이로 놓입니다)', points: 1 }],
    complete(tool, [p, q, r]) {
      const first = [p.image, q.image], placed = spacingOf(p.imageId, [p.image, q.image, r.image]);
      const second = model.parallelSecond(first, r.image, placed.spacing);
      if (!second.every(point => F.insideImage(p.imageId, point))) return '둘째 선이 영상 밖으로 나갑니다. 영상 안쪽을 누르세요';
      if (spacingOf(p.imageId, [...first, ...second]).basis !== placed.basis) return '둘째 선이 초음파 보정 영역을 벗어납니다';
      return stamp(tool, p, TOOLS.parallel, 'parallel', [...first, ...second]);
    } });
  const ratio = () => ({ id: 'measure-length-ratio', title: 'Length Ratio', result, restart,
    note: '두 선을 그으면 각 길이와 길이의 비(Ratio = Length 1 / Length 2)를 따로 냅니다.',
    steps: [{ text: 'First line — 첫 길이의 두 끝점', points: 2 }, { text: 'Second line — 둘째 길이의 두 끝점', points: 2 }],
    complete: (tool, presses) => stamp(tool, presses[0], TOOLS.ratio, 'ratio', presses.map(p => p.image)) });
  const angle = () => ({ id: 'measure-centre-angle', title: 'Centre-line Angle', result, restart,
    note: '선 네 개(점 여덟)를 그으면 선 1·2와 선 3·4의 중심선을 각각 그리고 두 중심선 사이의 각을 냅니다(괄호: 360° − 각).',
    steps: [{ text: 'Lines 1 and 2 — 선마다 두 끝점 (네 점)', points: 4 }, { text: 'Lines 3 and 4 — 선마다 두 끝점 (네 점)', points: 4 }],
    complete: (tool, presses) => stamp(tool, presses[0], TOOLS.angle, 'centreangle', presses.map(p => p.image)) });

  // Volume Measure: a formula, two or three lengths (each on any frame of the study), a title and OK.
  const PARTS = ['Length', 'Height', 'Width'];
  function volume() {
    const spec = { id: 'measure-volume', title: '2D Volume Measurement', noRestart: true, steps: [{ text: 'Length — 두 끝점을 누르세요', points: 2 }],
      note: '공식을 고르고 길이·높이·폭을 차례로 잽니다(각 길이는 같은 검사의 다른 영상에서 재도 됩니다). 제목을 넣고 OK를 누르면 마지막으로 잰 영상에 제목과 부피가 찍힙니다.',
      fields(body, tool) {
        const s = tool.state;
        Object.assign(s, { formula: 'ellipsoid', parts: {}, order: [], current: 'Length', study: null, stamped: '' });
        const formula = field(body, 'Formula', el('select', '', null, { 'aria-label': 'Formula' }));
        el('option', 'Ellipsoid: L × H × W × 0.523', formula, { value: 'ellipsoid' }); el('option', 'Prolate spheroid: L × W² × 0.523', formula, { value: 'prolate' });
        const table = el('table', '', body), cells = {}, buttons = {};
        for (const part of PARTS) {
          const row = el('tr', '', table); el('th', part, row);
          cells[part] = el('td', '—', row, { 'data-volume-value': part });
          buttons[part] = el('button', 'Measure ' + part, el('td', '', row), { type: 'button' });
          // Another length starts with new points: a point given for the length before is dropped.
          buttons[part].onclick = () => { s.current = part; tool.presses = []; tool.status.textContent = ''; s.paint(); };
        }
        const total = el('tr', '', table); el('th', 'Volume', total); cells.Volume = el('td', '—', total, { 'data-volume-value': 'Volume' });
        const row = el('div', '', body); row.style.marginTop = '.3em';
        const title = el('input', '', row, { placeholder: 'Title', 'aria-label': 'Volume Title', maxlength: '200' });
        const ok = el('button', 'OK', row, { type: 'button' }), reset = el('button', 'Reset', row, { type: 'button' });
        s.needed = () => model ? model.formulaParts(s.formula) : PARTS;
        s.paint = () => {
          const needed = s.needed();
          if (!needed.includes(s.current)) s.current = needed.find(part => !s.parts[part]) || needed[needed.length - 1];
          for (const part of PARTS) {
            const used = needed.includes(part), length = s.parts[part]?.length;
            cells[part].textContent = !used ? '— (not used)' : length ? model.one(length) + ' mm' : '—';
            buttons[part].disabled = !used; buttons[part].setAttribute('aria-pressed', String(part === s.current));
            buttons[part].style.fontWeight = part === s.current ? '700' : '';
          }
          const value = model ? model.volume(s.formula, Object.fromEntries(needed.map(part => [part, s.parts[part]?.length]))) : null;
          cells.Volume.textContent = model ? model.volumeText(value) : '—';
          spec.steps = [{ text: s.current + ' — 두 끝점을 누르세요', points: 2 }];
          tool.refresh();
        };
        s.clear = text => { s.parts = {}; s.order = []; s.study = null; s.current = s.needed()[0]; tool.presses = []; if (text !== undefined) tool.status.textContent = text; s.paint(); };
        formula.onchange = () => { s.formula = formula.value; tool.presses = []; s.paint(); };
        reset.onclick = () => { title.value = ''; s.stamped = ''; s.clear(''); };
        ok.onclick = () => { tool.status.textContent = place(tool, title.value); if (!tool.status.textContent) title.value = ''; };
        volumeTool = tool;
        tool.panel.onClose(() => { if (volumeTool === tool) volumeTool = null; F.schedule(); });
        s.paint();
      },
      complete(tool, [p, q]) {
        const s = tool.state, part = s.current, image = [p.image, q.image], found = F.geometry(p.imageId, image);
        if (found.reason) return '이 영상에서는 mm로 잴 수 없어 부피에 쓰지 않습니다: ' + found.reason;
        const ref = reference(p.imageId); if (!ref) return '영상 참조를 확인할 수 없습니다';
        // The lengths of one Volume are of one study: a length on another study starts the Volume again there.
        if (s.study && s.study !== ref.study) { s.clear('다른 검사의 영상이라 재던 길이를 지우고 다시 시작합니다'); }
        const length = model.length(image, found.spacing);
        if (!(length > 0)) return '두 끝점을 떨어뜨려 누르세요';
        s.study = ref.study;
        s.parts[part] = { imageId: p.imageId, world: [p.world, q.world], image, length, basis: found.basis, ref,
          frameOfReferenceUid: F.instance(p.imageId)?.FrameOfReferenceUID || null };
        s.order = [...s.order.filter(name => name !== part), part];
        const needed = s.needed();
        s.current = needed.find(name => !s.parts[name]) || part;
        s.paint();
        return '';
      },
      result: tool => tool.state.stamped ? 'Stamped: ' + tool.state.stamped : '' };
    return spec;
  }
  // OK: the title, the lengths and the volume stamped on the frame of the last length, beside its middle.
  function place(tool, titleText) {
    const s = tool.state;
    if (!model) return '측정 계산을 불러오는 중입니다';
    const needed = s.needed(), missing = needed.filter(part => !s.parts[part]);
    if (missing.length) return '먼저 ' + missing.join(', ') + '을(를) 재세요';
    const lengths = Object.fromEntries(needed.map(part => [part, s.parts[part].length])), value = model.volume(s.formula, lengths);
    const last = s.parts[s.order.filter(part => needed.includes(part)).pop()];
    const v = F.viewports().find(view => F.imageOf(view) === last.imageId);
    if (!v) return '마지막으로 잰 영상을 화면에 띄운 뒤 OK를 누르세요';
    const reason = F.gate(v, last.imageId); if (reason) return reason;
    const title = String(titleText ?? '').trim();
    if ([...title].length > 200 || /[\u0000]/.test(title)) return '제목은 200자까지입니다';
    try { encodeURIComponent(title); } catch (_) { return '제목에 쓸 수 없는 글자가 있습니다'; }
    const sources = needed.map(part => { const p = s.parts[part]; return { seriesUid: p.ref.seriesUid, sopUid: p.ref.sopUid, frame: p.ref.frame,
      frameOfReferenceUid: p.frameOfReferenceUid, points: p.world.map(w => [...w]), calculator: 'kin-length-v1:' + p.basis }; });
    const middle = [(last.image[0][0] + last.image[1][0]) / 2, (last.image[0][1] + last.image[1][1]) / 2];
    const a = F.addMark(v, last.imageId, TOOLS.volume, [F.toWorld(last.imageId, middle)],
      { text: title, kinBaseline: { calculator: 'kin-volume-v1:' + s.formula, values: [...needed.map(part => lengths[part]), value], sources } });
    tool.marks.push(a.annotationUID);
    s.stamped = (title || 'Volume') + ': ' + model.volumeText(value);
    s.clear();
    return '';
  }
  // A patient switch or another study in the cells empties the lengths of a Volume not yet stamped.
  function watch() {
    const s = volumeTool?.state;
    if (s && drag && F.imageOf(drag.v) !== drag.imageId) cancelDrag('영상이 바뀌어 고치기를 멈췄습니다');
    if (!s?.study) return;
    const switching = ['kin-patient-switching', 'kin-viewer-empty'].some(name => document.body.classList.contains(name));
    const shown = F.viewports().map(v => reference(F.imageOf(v))).filter(Boolean);
    if (switching || shown.length && !shown.some(ref => ref.study === s.study)) s.clear('환자나 검사가 바뀌어 재던 길이를 지웠습니다');
  }
  const tick = setInterval(watch, 300);
  cleanups.push(() => clearInterval(tick));

  // The menu items, in the order of the Measure menu (between the frame's own and the orthopaedic tools).
  for (const [order, make] of [[10, ctr], [40, parallel], [50, ratio], [60, angle], [120, volume]]) {
    const { id, title } = make();
    ui.menuItem('Measure', { id, label: id === 'measure-volume' ? 'Volume Measure' : title, order, run: () => { F.open(make()); } });
  }
  return () => {
    ended = true; drag = null; volumeTool = null;
    for (const cleanup of cleanups) try { cleanup(); } catch (error) { console.error(error); }
    checks.clear();
    if (window.KinMeasureLines) delete window.KinMeasureLines;
  };
});
