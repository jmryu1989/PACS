/* Render immutable saved CT views without moving the reading workspace. */
window.kinViewerJobPrint = function ({ api, authenticate, live }) {
  const core = window.cornerstone;
  const entries = new Map();
  const scheme = 'kinjobprint';
  // Only run-owned, freshly fetched pixels enter this loader. Never evict or
  // replace the diagnostic viewport's shared image cache to force a reload.
  core.imageLoader.registerImageLoader(scheme, id => ({ promise: Promise.resolve(entries.get(id)?.image) }));
  const provider = (type, id) => entries.get(id)?.metadata[type];
  core.metaData.addProvider(provider, 10000);
  const el = (tag, value, host) => { const e = document.createElement(tag); if (value !== undefined) e.textContent = value; host?.append(e); return e; };
  const dialog = el('dialog'); dialog.id = 'kin-job-print';
  dialog.style.cssText = 'width:min(1100px,94vw);height:90vh;padding:16px;background:#18212b;color:white';
  el('h2', '저장한 비교 영상 출력', dialog);
  const caption = el('p', '저장 당시 영상 범위와 밝기입니다. 실제 크기 아님.', dialog);
  const status = el('p', '', dialog); status.setAttribute('role', 'status');
  const reportSource = el('select', undefined, dialog); reportSource.setAttribute('aria-label', '함께 출력할 판독문');
  for (const [value, label] of [['none', '영상만 출력'], ['saved', '현재 검사의 서버 저장 판독문 함께 출력']]) {
    const option = el('option', label, reportSource); option.value = value;
  }
  const refresh = el('button', '다시 확인', dialog), printButton = el('button', '인쇄 / PDF', dialog), closeButton = el('button', '닫기', dialog);
  const paper = el('iframe', undefined, dialog); paper.title = '저장 비교 영상 출력 미리보기'; paper.setAttribute('sandbox', 'allow-same-origin');
  paper.style.cssText = 'display:block;width:100%;height:72%;margin-top:12px;border:0;background:white';
  document.body.append(dialog);
  let serial = 0, controller, current, ready, outputWindow, urls = [];
  function clear() { controller?.abort(); controller = null; ready = null; printButton.disabled = true; paper.srcdoc = ''; urls.forEach(URL.revokeObjectURL); urls = []; if (outputWindow && !outputWindow.closed) outputWindow.close(); outputWindow = null; }
  function close() { serial++; clear(); current = null; if (outputWindow && !outputWindow.closed) outputWindow.close(); outputWindow = null; dialog.close(); }
  const valid = (ticket, signal) => { if (!live() || ticket !== serial || !dialog.open || signal.aborted) throw new Error('출력 확인이 취소되었습니다.'); };
  async function bounded(work) {
    controller?.abort(); const c = controller = new AbortController(), timer = setTimeout(() => c.abort(), 30000);
    try { return await work(c.signal); } finally { clearTimeout(timer); c.abort(); if (controller === c) controller = null; }
  }
  async function bytes(url, signal, max, budget, accept = 'application/json') {
    const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin', headers: { Accept: accept } });
    if (!response.ok || !response.body) throw new Error('출력 원본을 읽지 못했습니다. 다시 확인하세요.');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; budget.bytes += part.value.length;
      if (size > max || budget.bytes > 67108864) throw new Error('출력 원본 용량 한도를 초과했습니다.'); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  }
  async function state(item, signal, includeReport) {
    await authenticate(signal);
    const job = await api('/studies/' + item.uid + '/viewer-jobs/' + item.id, { signal }), identities = [];
    let report = null;
    for (const uid of job.snapshot.studies) {
      const data = await api('/studies/' + uid + '/report-preview', { signal });
      if (data.study?.uid !== uid) throw new Error('출력 검사 정보를 확인할 수 없습니다.');
      identities.push(data.study);
      // A comparison's prior report must never become the reading target's
      // report, even when its image is the active viewport.
      if (includeReport && uid === item.uid) report = data.report;
    }
    if (includeReport && (!report || !Number.isInteger(report.version) || report.version < 0 ||
        !['findings', 'conclusion', 'recommendation', 'rs'].every(k => typeof report[k] === 'string')))
      throw new Error('출력 판독문 정보를 확인할 수 없습니다.');
    await authenticate(signal);
    const latest = await api('/studies/' + item.uid + '/viewer-jobs/' + item.id, { signal });
    if (!equal(latest, job)) throw new Error('작업이 변경되었습니다. 다시 확인하세요.');
    return { job, identities, report, reportUid: includeReport ? item.uid : null };
  }
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function verifyAnnotationValues(viewport, engine, id, annotations, budget) {
    const types = { length: 'LengthTool', angle: 'AngleTool', ellipse: 'EllipticalROITool' };
    for (const entry of annotations) {
      const item = entry.item; if (item.kind === 'arrow') continue;
      const Tool = window.cornerstoneTools[types[item.kind]], target = 'imageId:' + id;
      if (!Tool || item.baseline?.calculator !== 'kin-native-manual-v1') throw new Error('저장 측정값을 확인할 수 없습니다.');
      const tool = new Tool(), data = { handles: { points: structuredClone(item.points) }, cachedStats: { [target]: {} } };
      // Calculate on an unregistered annotation and a private tool instance.
      // The distinct tool name prevents OHIF from mapping it into live measures.
      const annotation = { annotationUID: 'kin-print-check:' + crypto.randomUUID(), invalidated: true, data,
        metadata: { toolName: 'kinJobPrintVerify', referencedImageId: id, FrameOfReferenceUID: item.frameOfReferenceUid,
          viewPlaneNormal: item.viewPlaneNormal, viewUp: item.viewUp } };
      tool.getTargetImageData = requested => requested === target ? viewport.getImageData() : undefined;
      if (item.kind === 'ellipse') {
        const camera = viewport.getCamera(), distance = Math.hypot(...camera.position.map((n, i) => n - camera.focalPoint[i]));
        viewport.setCamera({ viewUp: item.viewUp, viewPlaneNormal: item.viewPlaneNormal,
          position: camera.focalPoint.map((n, i) => n + item.viewPlaneNormal[i] * distance) });
        const calculator = tool.configuration.statsCalculator;
        // Match the pinned native ellipse's two canvas corners and inclusive
        // floor-index bounds exactly, including its single-slice k interval.
        const [bottom, top, left, right] = item.points.map(p => viewport.worldToCanvas(p));
        const indices = [[left[0], top[1]], [right[0], bottom[1]]].map(p =>
          core.utilities.transformWorldToIndex(viewport.getImageData().imageData, viewport.canvasToWorld(p)).map(Math.floor));
        const area = [0, 1, 2].reduce((total, axis) => total * (Math.abs(indices[0][axis] - indices[1][axis]) + 1), 1);
        budget.measurementPixels = (budget.measurementPixels || 0) + area;
        if (!Number.isFinite(area) || area < 1 || budget.measurementPixels > 2097152) throw new Error('주석 수치 재확인 범위가 너무 큽니다. 더 적은 주석의 작업으로 저장하세요.');
        // This pinned calculator is static. Swap in private accumulators only
        // for its synchronous call, restoring them before its modified event.
        const prior = Object.fromEntries(['max', 'min', 'sum', 'count', 'runMean', 'm2', 'pointsInShape'].map(k => [k, calculator[k]]));
        const restore = () => Object.assign(calculator, prior);
        Object.assign(calculator, { max: [-Infinity], min: [Infinity], sum: [0], count: 0, runMean: [0], m2: [0], pointsInShape: null });
        tool.configuration = { ...tool.configuration, statsCalculator: {
          statsCallback: value => calculator.statsCallback(value),
          getStatistics: () => { try { const stats = calculator.getStatistics(); return { ...stats, array: [...stats.array.filter(x => x.name !== 'min'), stats.min] }; } finally { restore(); } },
        } };
        try { tool._calculateCachedStats(annotation, viewport, engine); } finally { restore(); }
      } else tool._calculateCachedStats(annotation, engine, core.getEnabledElement(viewport.element));
      const stats = data.cachedStats[target];
      const actual = item.kind === 'length' ? [stats.length] : item.kind === 'angle' ? [stats.angle] :
        [stats.area, stats.mean, stats.statsArray?.find(x => x.name === 'min')?.value, stats.max, stats.statsArray?.find(x => x.name === 'count')?.value];
      const units = item.kind === 'length' ? stats.unit === 'mm' : item.kind === 'angle' || stats.areaUnit === 'mm²' && stats.modalityUnit === 'HU';
      if (!units || actual.length !== item.baseline.values.length || actual.some((n, i) => !Number.isFinite(n) ||
          Math.abs(n - item.baseline.values[i]) > Math.max(1e-6, Math.abs(n) * 1e-12)) || item.kind === 'ellipse' && actual[4] !== item.baseline.values[4])
        throw new Error('저장 측정값이 원본 재확인 결과와 다릅니다. 원본에서 다시 측정한 뒤 저장하세요.');
    }
  }
  function markedCanvas(viewport, canvas, annotations) {
    if (!annotations.length) return canvas;
    const result = el('canvas'); result.width = canvas.width; result.height = canvas.height;
    const ctx = result.getContext('2d'); ctx.drawImage(canvas, 0, 0);
    const dpr = window.devicePixelRatio || 1, weight = Math.max(1.5, Math.min(canvas.width, canvas.height) / 400);
    ctx.strokeStyle = '#ffd700'; ctx.fillStyle = '#ffd700'; ctx.lineWidth = weight; ctx.lineJoin = 'round';
    for (const [index, entry] of annotations.entries()) {
      const points = entry.item.points.map(p => viewport.worldToCanvas(p).map(n => n * dpr));
      if (points.flat().some(n => !Number.isFinite(n))) throw new Error('저장 주석 좌표를 출력할 수 없습니다.');
      ctx.beginPath();
      if (entry.item.kind === 'ellipse') {
        const center = points[0].map((n, i) => (n + points[1][i]) / 2);
        const a = points[3].map((n, i) => (n - points[2][i]) / 2), b = points[0].map((n, i) => (n - points[1][i]) / 2);
        ctx.ellipse(...center, Math.hypot(...a), Math.hypot(...b), Math.atan2(a[1], a[0]), 0, Math.PI * 2);
      } else { ctx.moveTo(...points[0]); points.slice(1).forEach(p => ctx.lineTo(...p)); }
      ctx.stroke();
      if (entry.item.kind === 'arrow') {
        const [tip, tail] = points, angle = Math.atan2(tail[1] - tip[1], tail[0] - tip[0]), size = weight * 5;
        ctx.beginPath(); ctx.moveTo(tip[0] + size * Math.cos(angle - .5), tip[1] + size * Math.sin(angle - .5));
        ctx.lineTo(...tip); ctx.lineTo(tip[0] + size * Math.cos(angle + .5), tip[1] + size * Math.sin(angle + .5)); ctx.stroke();
      }
      for (const p of points) { ctx.beginPath(); ctx.arc(...p, weight * 1.5, 0, Math.PI * 2); ctx.fill(); }
      const [x, y] = points[0], text = String(index + 1);
      ctx.font = `${Math.max(12, weight * 7)}px sans-serif`; ctx.textBaseline = 'bottom';
      ctx.lineWidth = weight * 2; ctx.strokeStyle = '#000'; ctx.strokeText(text, x + weight * 3, y - weight * 3);
      ctx.fillText(text, x + weight * 3, y - weight * 3); ctx.strokeStyle = '#ffd700'; ctx.lineWidth = weight;
    }
    return result;
  }
  const cellAnnotations = (job, cell) => job.snapshot.version === 3 ? (job.annotations || []).filter(a => a.study === cell.study && a.item.sopUid === cell.sop && a.item.seriesUid === cell.series && a.item.frame === cell.frame) : [];
  function verifyAnnotationSet(job) {
    const annotations = job.annotations, refs = job.snapshot.annotations;
    if (job.snapshot.version !== 3) { if (annotations !== undefined || refs !== undefined) throw new Error('출력 주석 형식이 일치하지 않습니다.'); return; }
    const refuse = () => { throw new Error('저장 주석 전체를 확인할 수 없습니다. 다시 확인하세요.'); };
    if (!Array.isArray(annotations) || !Array.isArray(refs) || annotations.length > 64 || refs.length !== annotations.length ||
        new Set(annotations.map(a => a.id)).size !== annotations.length || new Set(refs.map(r => r.id)).size !== refs.length) refuse();
    for (const a of annotations) {
      const item = a.item, count = { arrow: 2, length: 2, angle: 3, ellipse: 4 }[item?.kind];
      if (!count || item.hidden || !Array.isArray(item.points) || item.points.length !== count ||
          item.points.some(p => !Array.isArray(p) || p.length !== 3 || p.some(n => !Number.isFinite(n))) ||
          !refs.some(r => r.id === a.id && r.study === a.study && r.revision === a.revision) ||
          !job.snapshot.cells.some(c => c && cellAnnotations(job, c).includes(a))) refuse();
      if (item.kind === 'arrow') { if (item.baseline !== undefined) refuse(); }
      else if (item.baseline?.calculator !== 'kin-native-manual-v1' || !Array.isArray(item.baseline.values) ||
          item.baseline.values.length !== (item.kind === 'ellipse' ? 5 : 1) || item.baseline.values.some(n => !Number.isFinite(n))) refuse();
    }
  }
  const annotationMode = job => job.snapshot.version === 3 ? '저장 당시 주석 포함' : '주석 미포함';
  async function render(cell, ticket, signal, budget, annotations) {
    const { width, height } = cell.viewport;
    const location = await api('/dicom/lookup', { signal, method: 'POST', body: JSON.stringify({ studyUid: cell.study, sopUid: cell.sop }) });
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(location.id)) throw new Error('원본 참조가 올바르지 않습니다.');
    const path = '/instances/' + location.id;
    const read = async suffix => JSON.parse(new TextDecoder().decode(await bytes(path + suffix, signal, 524288, budget)));
    const info = await read('/attachments/dicom/info');
    if (info.UncompressedMD5?.toLowerCase() !== cell.sourceDigest) throw new Error('저장 당시 원본과 달라 출력하지 않았습니다.');
    const tags = await read('/simplified-tags'); valid(ticket, signal);
    const list = value => Array.isArray(value) ? value.map(Number) : String(value).split('\\').map(Number);
    const rows = Number(tags.Rows), columns = Number(tags.Columns), slope = Number(tags.RescaleSlope), intercept = Number(tags.RescaleIntercept);
    const orientation = list(tags.ImageOrientationPatient), position = list(tags.ImagePositionPatient), spacing = list(tags.PixelSpacing);
    if (tags.StudyInstanceUID !== cell.study || tags.SeriesInstanceUID !== cell.series || tags.SOPInstanceUID !== cell.sop ||
        tags.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' || tags.Modality !== 'CT' || tags.PhotometricInterpretation !== 'MONOCHROME2' ||
        Number(tags.NumberOfFrames || 1) !== 1 || cell.frame !== 1 || Number(tags.BitsAllocated) !== 16 || Number(tags.SamplesPerPixel) !== 1 ||
        ![0, 1].includes(Number(tags.PixelRepresentation)) || !Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows * columns > 16777216 ||
        !String(tags.RescaleSlope ?? '').trim() || !String(tags.RescaleIntercept ?? '').trim() ||
        !Number.isFinite(slope) || slope <= 0 || !Number.isFinite(intercept) || tags.ModalityLUTSequence !== undefined || tags.VOILUTSequence !== undefined ||
        orientation.length !== 6 || position.length !== 3 || spacing.length !== 2 || [...orientation, ...position, ...spacing].some(n => !Number.isFinite(n)) || spacing.some(n => n <= 0))
      throw new Error('저장 영상 출력은 일반16bit 흑백 CT에서 지원합니다.');
    const signed = Number(tags.PixelRepresentation) === 1;
    const raw = await bytes(path + '/frames/0/' + (signed ? 'image-int16' : 'image-uint16'), signal, 8388608, budget, 'image/x-portable-arbitrarymap');
    if ((await read('/attachments/dicom/info')).UncompressedMD5?.toLowerCase() !== cell.sourceDigest) throw new Error('출력 원본이 변경되었습니다. 다시 확인하세요.');
    const header = /^P7\nWIDTH (\d+)\nHEIGHT (\d+)\nDEPTH 1\nMAXVAL 65535\nTUPLTYPE GRAYSCALE\nENDHDR\n/.exec(new TextDecoder().decode(raw.subarray(0, 512)));
    if (!header || Number(header[1]) !== columns || Number(header[2]) !== rows || raw.length !== header[0].length + rows * columns * 2)
      throw new Error('출력 원본 화소가 일치하지 않습니다.');
    valid(ticket, signal);
    budget.sourcePixels += rows * columns; if (budget.sourcePixels > 33554432) throw new Error('출력 원본 해상도 한도를 초과했습니다.');
    const pixels = new Float32Array(rows * columns), data = new DataView(raw.buffer, header[0].length); let min = Infinity, max = -Infinity;
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = (signed ? data.getInt16(i * 2) : data.getUint16(i * 2)) * slope + intercept;
      if (!Number.isFinite(pixels[i])) throw new Error('출력 원본의 보정 수치를 표시할 수 없습니다.');
      min = Math.min(min, pixels[i]); max = Math.max(max, pixels[i]);
    }
    const id = scheme + ':' + crypto.randomUUID(), engine = new core.RenderingEngine('kin-print-' + crypto.randomUUID());
    // Native canvases use device pixels. Browser zoom must not multiply the
    // saved dimensions again; round CSS layout upward to its 1/64px quantum.
    const dpr = window.devicePixelRatio || 1;
    const host = el('div'); host.style.cssText = `position:fixed;left:-20000px;top:0;width:${Math.ceil(width / dpr * 64) / 64}px;height:${Math.ceil(height / dpr * 64) / 64}px`; document.body.append(host);
    entries.set(id, { image: { imageId: id, width: columns, height: rows, rows, columns, color: false, rgba: false, numberOfComponents: 1,
      slope, intercept, minPixelValue: min, maxPixelValue: max, windowCenter: 40, windowWidth: 400, rowPixelSpacing: spacing[0], columnPixelSpacing: spacing[1],
      sizeInBytes: pixels.byteLength, getPixelData: () => pixels, imageFrame: {}, preScale: { scaled: true, scalingParameters: { rescaleSlope: slope, rescaleIntercept: intercept, modality: 'CT' } } },
      metadata: { imagePlaneModule: { frameOfReferenceUID: tags.FrameOfReferenceUID, rows, columns, rowCosines: orientation.slice(0, 3), columnCosines: orientation.slice(3), imagePositionPatient: position,
        rowPixelSpacing: spacing[0], columnPixelSpacing: spacing[1] }, generalSeriesModule: { modality: 'CT' }, modalityLutModule: { rescaleSlope: slope, rescaleIntercept: intercept },
        voiLutModule: { windowCenter: [40], windowWidth: [400] }, imagePixelModule: { samplesPerPixel: 1, photometricInterpretation: 'MONOCHROME2', rows, columns, bitsAllocated: 16, bitsStored: Number(tags.BitsStored), highBit: Number(tags.HighBit), pixelRepresentation: signed ? 1 : 0 } } });
    try {
      // Reserve synchronously: the native cache otherwise evicts reading frames
      // while inserting an asynchronously loaded image when capacity is low.
      const image = entries.get(id).image;
      if (core.cache.getBytesAvailable() < image.sizeInBytes) throw new Error('출력용 영상 메모리가 부족합니다. 다른 검사를 닫은 뒤 다시 확인하세요.');
      image.voxelManager = core.utilities.VoxelManager.createImageVoxelManager({ scalarData: pixels, width: columns, height: rows, numberOfComponents: 1 });
      core.cache.putImageSync(id, image);
      // setViewports normalizes the canvas backing size after CSS layout;
      // enableElement alone keeps getOrCreateCanvas's rounded-up extra pixel.
      engine.setViewports([{ viewportId: id, type: core.Enums.ViewportType.STACK, element: host, defaultOptions: { background: [0, 0, 0] } }]);
      const viewport = engine.getViewport(id); await viewport.setStack([id]); valid(ticket, signal);
      verifyAnnotationValues(viewport, engine, id, annotations, budget); valid(ticket, signal);
      viewport.setProperties({ ...cell.properties, colormap: { name: 'Grayscale', opacity: [] } });
      viewport.setCamera({ flipHorizontal: cell.camera.flipHorizontal, flipVertical: cell.camera.flipVertical });
      const camera = { ...cell.camera }; delete camera.flipHorizontal; delete camera.flipVertical; viewport.setCamera(camera);
      await new Promise((resolve, reject) => {
        const cancel = () => finish(new Error('출력 확인이 취소되었습니다.')), done = () => finish();
        function finish(error) { host.removeEventListener(core.Enums.Events.IMAGE_RENDERED, done); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); }
        host.addEventListener(core.Enums.Events.IMAGE_RENDERED, done, { once: true }); signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel(); else viewport.render();
      });
      valid(ticket, signal);
      const canvas = viewport.getCanvas();
      if (canvas.width !== width || canvas.height !== height) throw new Error('저장 화면 크기를 재현하지 못했습니다.');
      const output = markedCanvas(viewport, canvas, annotations);
      const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png')); valid(ticket, signal);
      if (!blob || blob.size > 8388608 || (budget.bytes += blob.size) > 67108864) throw new Error('출력 영상 용량 한도를 초과했습니다.');
      const url = URL.createObjectURL(blob); urls.push(url); return url;
    } finally { engine.destroy(); host.remove(); entries.delete(id); if (core.cache.getImageLoadObject(id)) core.cache.removeImageLoadObject(id); }
  }
  function html(data, images) {
    const { job, identities } = data, main = el('main'), legends = [];
    el('h1', 'KIN PACS 저장 비교 영상', main); el('h2', job.title, main); el('p', job.description, main);
    el('p', `작업 작성자 ${job.authorActor} · 저장 ${job.createdAt} · r${job.revision}`, main);
    el('p', '저장 당시 영상 범위·밝기 · ' + annotationMode(job) + ' · 실제 크기 아님', main);
    const reportLabel = data.report ? (!data.report.version ? '저장된 판독문 없음' :
      `${data.report.rs === 'A' ? '승인된 저장본' : '미승인 저장본'} · v${data.report.version} · RS ${data.report.rs}`) : '';
    const summary = identities.map(s => `환자 ${s.name} (${s.id}) · 검사 ${s.date} · Acc ${s.acc || '-'}`).join('\n') +
      (data.report ? '\n현재 검사 판독문: ' + reportLabel : '');
    el('p', summary, main);
    if (data.report) {
      const report = data.report, identity = identities.find(s => s.uid === data.reportUid), section = el('section', undefined, main);
      section.className = 'report';
      el('h2', '현재 검사 판독문', section);
      el('p', `${identity.name} (${identity.id}) · ${identity.date} · ${identity.desc || identity.modality} · Acc ${identity.acc || '-'}`, section);
      el('p', `Study ${identity.uid}`, section).className = 'reference';
      el('p', reportLabel, section).className = 'report-source';
      el('p', '출력 확인 시점의 서버 저장본입니다. 비교 작업 저장 당시 판독문이나 미저장 편집문이 아닙니다.', section);
      el('p', `작성자: ${report.author || '-'} · 승인 판독의: ${report.repDoc || '-'} · 승인일(UTC): ${report.confirm || '-'}`, section);
      for (const [key, label] of [['findings', '소견'], ['conclusion', '결론'], ['recommendation', '권고']]) {
        el('h3', label, section); el('p', report[key] || '(내용 없음)', section).dataset.reportField = key;
      }
    }
    const grid = el('div', undefined, main); grid.className = 'grid'; grid.style.gridTemplateColumns = `repeat(${job.snapshot.cols},minmax(0,1fr))`;
    job.snapshot.cells.forEach((cell, index) => {
      const figure = el('section', undefined, grid); figure.className = 'cell'; el('strong', '셀 ' + (index + 1), figure);
      if (!cell) { el('p', '빈 셀', figure); return; }
      const identity = identities.find(s => s.uid === cell.study), img = el('img', undefined, figure); img.src = images[index]; img.alt = '저장한 셀 ' + (index + 1);
      el('p', `${identity.name} (${identity.id}) · ${identity.date} · ${identity.desc || identity.modality}`, figure);
      el('p', `프레임 ${cell.frame} · ${cell.viewport.width} × ${cell.viewport.height} · VOI ${cell.properties.voiRange.lower} ~ ${cell.properties.voiRange.upper} (${cell.properties.VOILUTFunction})`, figure);
      el('p', `Study ${cell.study}\nSeries ${cell.series}\nSOP ${cell.sop}`, figure).className = 'reference';
      if (job.snapshot.version === 3) {
        const annotations = cellAnnotations(job, cell);
        el('p', `저장 당시 주석 ${annotations.length}개 · 영상 범위 밖의 주석은 일부 또는 전부 보이지 않을 수 있습니다.`, figure);
        const legend = el('div'); legend.className = 'annotations'; legends.push(legend);
        el('h2', `셀 ${index + 1} · 저장 당시 주석`, legend);
        el('p', `${identity.name} (${identity.id}) · ${identity.date} · SOP ${cell.sop}`, legend);
        annotations.forEach((entry, index) => {
          const item = entry.item, values = item.kind === 'arrow' ? null : item.baseline.values.map((n, i) => item.kind === 'ellipse' && i === 4 ? String(n) : core.utilities.roundNumber(n));
          const kinds = { arrow: '화살표', length: '길이', angle: '각도', ellipse: 'ROI' };
          const row = el('div', undefined, legend); row.dataset.annotationId = entry.id; row.dataset.revision = entry.revision;
          el('strong', `${index + 1}. ${kinds[item.kind]} · ${item.label}`, row);
          if (values) el('p', '저장 당시 수치: ' + (item.kind === 'length' ? values[0] + ' mm' : item.kind === 'angle' ? values[0] + '°' :
            `면적 ${values[0]} mm² · 평균 ${values[1]} HU · 최소 ${values[2]} HU · 최대 ${values[3]} HU · 화소 수 ${values[4]}`), row);
          el('p', `작성자 ${entry.authorActor} · r${entry.revision} · ${entry.at}`, row);
        });
      }
    });
    legends.forEach(legend => main.append(legend));
    const cssString = '"' + Array.from(summary, char => '\\' + char.codePointAt(0).toString(16) + ' ').join('') + '"';
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\';img-src blob:;style-src \'unsafe-inline\';base-uri \'none\'"><title>저장 비교 영상</title><style>' +
      'body{margin:0;color:#18212b;background:white;font:13px/1.5 "Malgun Gothic",sans-serif}main{padding:12px}h1{font-size:21px}h2{font-size:16px}p{white-space:pre-wrap;overflow-wrap:anywhere}.grid{display:grid;gap:12px}.cell{min-width:0;break-inside:avoid;border-top:1px solid #aaa;padding-top:10px}.cell img{display:block;max-width:100%;max-height:145mm;width:auto;height:auto;margin:8px auto}.reference{font-size:9px}@page{size:A4;margin:12mm 12mm 24mm;@bottom-left{content:' + cssString + ';font:8px "Malgun Gothic",sans-serif;white-space:pre-wrap}@bottom-right{content:counter(page) " / " counter(pages);font:9px sans-serif}}@media print{main{padding:0}}' +
      '.annotations{margin-top:18px}.annotations>h2,.annotations>p{break-after:avoid;break-inside:avoid}.annotations>div{break-inside:avoid;border-top:1px solid #ccc;padding:8px 0;overflow-wrap:anywhere}.annotations strong{white-space:pre-wrap;overflow-wrap:anywhere}' +
      '.report h2,.report h3{break-after:avoid}.report-source{font-weight:bold}.report+.grid{break-before:page}.report p{orphans:3;widows:3}' +
      '</style></head><body>' + main.outerHTML + '</body></html>';
  }
  function supportsIdentity() { try { const css = new CSSStyleSheet(); css.replaceSync('@page{@bottom-left{content:"x"}}'); return css.cssRules[0]?.cssRules[0]?.name === 'bottom-left'; } catch { return false; } }
  async function prepare() {
    if (!current) return; const ticket = ++serial, item = current, includeReport = reportSource.value === 'saved'; clear(); status.textContent = '저장한 영상 상태를 확인하는 중…';
    try { await bounded(async signal => {
      const data = await state(item, signal, includeReport); valid(ticket, signal); const snapshot = data.job.snapshot;
      if (![2, 3].includes(snapshot.version)) throw new Error('이전 작업에는 화면 크기가 없습니다. 복원 후 새 비교 작업으로 저장하세요.');
      verifyAnnotationSet(data.job);
      caption.textContent = '저장 당시 영상 범위와 밝기 · ' + annotationMode(data.job) + ' · 실제 크기 아님.';
      let total = 0;
      for (const cell of snapshot.cells) if (cell) { const { width, height } = cell.viewport || {}; total += width * height;
        if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 8192) || width * height > 16777216 || total > 33554432) throw new Error('저장 화면 크기가 출력 한도를 초과했습니다.'); }
      const images = [], budget = { bytes: 0, sourcePixels: 0 };
      for (const cell of snapshot.cells) { valid(ticket, signal); images.push(cell ? await render(cell, ticket, signal, budget, cellAnnotations(data.job, cell)) : null); }
      const latest = await state(item, signal, includeReport); valid(ticket, signal); if (!equal(latest, data)) throw new Error('작업 또는 검사 정보·판독문이 변경되었습니다. 다시 확인하세요.');
      ready = { data, includeReport, html: html(data, images) }; paper.srcdoc = ready.html; printButton.disabled = !supportsIdentity();
      status.textContent = printButton.disabled ? '페이지 식별정보를 지원하는 Chrome 또는 Edge에서 여세요.' : '미리보기 내용을 확인하세요. ' + annotationMode(data.job) + ' · 실제 크기 아님.';
    }); } catch (error) { if (ticket === serial) { clear(); status.textContent = error.message; } }
  }
  async function print() {
    const captured = ready, ticket = serial, item = current; if (!captured || printButton.disabled) return;
    if (outputWindow && !outputWindow.closed) outputWindow.close(); const target = outputWindow = window.open('', '_blank');
    if (!target) { status.textContent = '팝업 허용 여부를 확인한 뒤 다시 인쇄하세요.'; return; }
    printButton.disabled = true;
    try { await bounded(async signal => {
      const latest = await state(item, signal, captured.includeReport); valid(ticket, signal);
      if (ready !== captured || !equal(latest, captured.data) || target.closed) throw new Error('출력 내용이 변경되었습니다. 다시 확인하세요.');
      target.document.open(); target.document.write(captured.html); target.document.close();
      await Promise.all([...target.document.images].map(i => i.decode())); valid(ticket, signal);
      if (ready !== captured || target.closed) throw new Error('출력이 취소되었습니다.'); target.focus(); target.print();
    }); } catch (error) { if (!target.closed) target.close(); if (ticket === serial) { clear(); status.textContent = error.message; } }
    finally { if (ticket === serial && ready === captured) printButton.disabled = false; }
  }
  closeButton.onclick = close; refresh.onclick = prepare; printButton.onclick = print; reportSource.onchange = prepare;
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  return { open(uid, id) { close(); reportSource.value = 'none'; current = { uid, id }; dialog.showModal(); void prepare(); }, close,
    destroy() { close(); dialog.remove(); core.metaData.removeProvider(provider); } };
};
