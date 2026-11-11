/* Viewer export: actions that stand after Capture in the viewer toolbar and work on what an image cell
   shows. A cell is drawn as the reader sees it: its image canvases, its measurement and annotation layer and
   the image text shown in it. Image Text and Images Only already decide which text is shown, so there is no
   separate overlay choice here. Nothing is sent to the server and nothing is stored.
   Every action pins the cells it started on (viewport, series, shown image) and the viewer's life; a result
   that arrives after any of them changed, even if it changed back, is dropped, never written for another study. */
window.KinViewerExport = (() => {
  // Text inside controls, menus and hidden parts of a cell is not image text.
  const NOT_IMAGE_TEXT = 'button,[role="button"],[role="menu"],[role="menuitem"],[role="dialog"],input,select,textarea,dialog,svg,canvas,[aria-hidden="true"],[hidden]';
  const visible = element => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  class Stopped extends Error {}
  // The active cell, or every cell of this window in grid order. A cell is the native pane around the
  // Cornerstone element, so the image text drawn beside the element is part of it.
  function pin(services, scope, live = () => true) {
    const grid = services?.viewportGridService, viewports = services?.cornerstoneViewportService;
    if (!grid || !viewports) return null;
    const ids = scope === 'screen' ? [...(grid.getState()?.viewports?.keys?.() || [])] : [grid.getActiveViewportId?.()];
    const cells = ids.map(id => ({ id, viewport: viewports.getCornerstoneViewport(id) })).filter(cell => cell.viewport?.element?.isConnected)
      .map(cell => ({ ...cell, pane: cell.viewport.element.closest('[data-cy="viewport-pane"]') || cell.viewport.element,
        imageIds: JSON.stringify(cell.viewport.getImageIds?.() || []), index: cell.viewport.getCurrentImageIdIndex?.() }))
      .filter(cell => visible(cell.pane));
    if (!cells.length) return null;
    // A change seen at any moment stays seen: a cell that shows another series and then the first one again
    // (A -> B -> A) is not the cell this action started on. New stacks and grid changes are watched until release().
    let moved = false;
    const restacked = () => { moved = true; };
    const stack = window.cornerstone?.Enums?.Events?.STACK_NEW_STACK || 'CORNERSTONE_STACK_NEW_STACK';
    const sets = id => JSON.stringify(grid.getState?.()?.viewports?.get?.(id)?.displaySetInstanceUIDs ?? null);
    cells.forEach(cell => { cell.sets = sets(cell.id); cell.viewport.element.addEventListener(stack, restacked); });
    const watched = Object.values(grid.EVENTS || {}).map(event => grid.subscribe?.(event, () => {
      if (cells.some(cell => sets(cell.id) !== cell.sets)) moved = true;
    }));
    // Still the same viewer, cells, series and (unless this action moves it) shown image.
    const same = (moving = false) => !moved && live() && !document.body.classList.contains('kin-patient-switching') && cells.every(cell =>
      viewports.getCornerstoneViewport(cell.id) === cell.viewport && cell.viewport.element?.isConnected &&
      JSON.stringify(cell.viewport.getImageIds?.() || []) === cell.imageIds && (moving || cell.viewport.getCurrentImageIdIndex?.() === cell.index));
    const release = () => {
      cells.forEach(cell => cell.viewport.element.removeEventListener(stack, restacked));
      watched.forEach(subscription => subscription?.unsubscribe?.());
    };
    return { cells, same, release };
  }
  function svgImage(svg, rect) {
    const copy = svg.cloneNode(true);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', rect.width); copy.setAttribute('height', rect.height);
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    return image.decode().then(() => image);
  }
  // Image text where the page puts each line, so wrapped lines, spacing and alignment stay as shown. A box
  // between the pane and the text that clips on screen clips here, and its background colour is drawn behind
  // the text (a box that holds the image canvas is the image's, not the text's).
  function drawText(context, pane, at) {
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT), painted = new Set(), range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.data.trim() || !parent || parent.closest(NOT_IMAGE_TEXT) || !visible(parent)) continue;
      const boxes = [];
      for (let box = parent; box && box !== pane; box = box.parentElement) boxes.push(box);
      context.save();
      for (const box of boxes.slice().reverse()) {
        const style = getComputedStyle(box), r = box.getBoundingClientRect();
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          context.beginPath(); context.rect(r.left - at.left, r.top - at.top, r.width, r.height); context.clip();
        }
        const colour = style.backgroundColor;
        if (!painted.has(box) && !box.querySelector('canvas,svg') && colour && !/^(transparent|rgba\(.*,\s*0\))$/.test(colour)) {
          painted.add(box); context.fillStyle = colour; context.fillRect(r.left - at.left, r.top - at.top, r.width, r.height);
        }
      }
      const style = getComputedStyle(parent);
      context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
      context.fillStyle = style.color;
      const rtl = style.direction === 'rtl'; context.direction = rtl ? 'rtl' : 'ltr'; context.textAlign = rtl ? 'right' : 'left';
      if ('letterSpacing' in context) context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
      if ('wordSpacing' in context) context.wordSpacing = style.wordSpacing === 'normal' ? '0px' : style.wordSpacing;
      // Lines as the page breaks them, found from whole grapheme clusters; each line is then drawn in one call,
      // so combining marks (a decomposed Korean name) and joined scripts are shaped together as on screen.
      const parts = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(node.data)]
        : [...node.data].reduce((list, segment) => { list.push({ segment, index: list.length ? list.at(-1).index + list.at(-1).segment.length : 0 }); return list; }, []);
      const lines = [];
      for (const { segment, index } of parts) {
        range.setStart(node, index); range.setEnd(node, index + segment.length);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const middle = r.top + r.height / 2;
        let line = lines.find(item => Math.abs(item.middle - middle) < r.height / 2);
        if (!line) lines.push(line = { start: index, end: index, left: r.left, right: r.right, top: r.top, bottom: r.bottom, middle });
        line.start = Math.min(line.start, index); line.end = Math.max(line.end, index + segment.length);
        line.left = Math.min(line.left, r.left); line.right = Math.max(line.right, r.right);
        line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
      }
      const keep = style.whiteSpace.startsWith('pre') || style.whiteSpace === 'break-spaces';
      for (const line of lines) {
        let text = node.data.slice(line.start, line.end);
        if (!keep) text = text.replace(/\s+/g, ' ');
        text = style.textTransform === 'uppercase' ? text.toUpperCase() : style.textTransform === 'lowercase' ? text.toLowerCase() : text;
        if (!text.trim()) continue;
        // The page's baseline: a text box is the font's ascent and descent, centred in the line's box.
        const metrics = context.measureText(text), ascent = metrics.fontBoundingBoxAscent, descent = metrics.fontBoundingBoxDescent;
        const exact = Number.isFinite(ascent) && Number.isFinite(descent);
        context.textBaseline = exact ? 'alphabetic' : 'middle';
        const y = exact ? line.top + (line.bottom - line.top - ascent - descent) / 2 + ascent : line.middle;
        context.fillText(text, (rtl ? line.right : line.left) - at.left, y - at.top);
      }
      context.restore();
    }
  }
  // One canvas for the given cells, at the image canvases' own pixel density.
  async function render(cells) {
    const rects = cells.map(cell => cell.pane.getBoundingClientRect());
    const region = { left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)) };
    region.width = Math.max(...rects.map(r => r.right)) - region.left; region.height = Math.max(...rects.map(r => r.bottom)) - region.top;
    const densities = cells.flatMap(cell => [...cell.pane.querySelectorAll('canvas')].filter(visible)
      .map(canvas => canvas.width / canvas.getBoundingClientRect().width)).filter(value => Number.isFinite(value) && value > 0);
    const scale = densities.length ? Math.max(...densities) : (window.devicePixelRatio || 1);
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(region.width * scale)); output.height = Math.max(1, Math.round(region.height * scale));
    const context = output.getContext('2d');
    context.fillStyle = '#000'; context.fillRect(0, 0, output.width, output.height);
    context.scale(scale, scale);
    // Everything is read from the page before the first await, so one call draws one moment of the cells.
    const layers = cells.map((cell, index) => ({ pane: rects[index], cell,
      canvases: [...cell.pane.querySelectorAll('canvas')].filter(visible).map(canvas => [canvas, canvas.getBoundingClientRect()]),
      svgs: [...cell.pane.querySelectorAll('svg.svg-layer')].filter(visible).map(svg => [svgImage(svg, svg.getBoundingClientRect()), svg.getBoundingClientRect()]) }));
    const frozen = layers.map(layer => layer.canvases.map(([canvas, r]) => {
      const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
      copy.getContext('2d').drawImage(canvas, 0, 0); return [copy, r];
    }));
    const text = document.createElement('canvas'); text.width = output.width; text.height = output.height;
    const textContext = text.getContext('2d'); textContext.scale(scale, scale);
    for (const layer of layers) {
      textContext.save(); textContext.beginPath();
      textContext.rect(layer.pane.left - region.left, layer.pane.top - region.top, layer.pane.width, layer.pane.height); textContext.clip();
      drawText(textContext, layer.cell.pane, region); textContext.restore();
    }
    for (const [index, layer] of layers.entries()) {
      const pane = layer.pane;
      context.save(); context.beginPath(); context.rect(pane.left - region.left, pane.top - region.top, pane.width, pane.height); context.clip();
      for (const [canvas, r] of frozen[index]) context.drawImage(canvas, r.left - region.left, r.top - region.top, r.width, r.height);
      for (const [image, r] of layer.svgs) context.drawImage(await image, r.left - region.left, r.top - region.top, r.width, r.height);
      context.restore();
    }
    context.setTransform(1, 0, 0, 1, 0, 0); context.drawImage(text, 0, 0);
    return output;
  }
  const blob = (canvas, type, quality) => new Promise((resolve, reject) =>
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('영상을 그림 파일로 만들지 못했습니다.')), type, quality));
  function tell(services, message, type = 'info') {
    services?.uiNotificationService?.show?.({ title: 'Image Export', message, type });
  }
  const failure = error => error instanceof Stopped ? error.message
    : error?.constructor === Error && /[가-힣]/.test(error.message) ? error.message : '영상을 내보내지 못했습니다. 다시 시도하세요.';
  const changed = () => new Stopped('영상이나 화면이 바뀌어 내보내기를 멈췄습니다. 다시 시도하세요.');

  // Copy: the clipboard takes images as PNG only, so there is no format choice. The write starts in the
  // reader's click or key press and receives the image once it is drawn and encoded; a cell or viewer that
  // changed by then fails the write, so the clipboard keeps what it had.
  function copy(services, scope, live) {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      tell(services, '이 브라우저에서는 영상을 클립보드에 복사할 수 없습니다.', 'error'); return Promise.resolve(false);
    }
    const target = pin(services, scope, live);
    if (!target) { tell(services, '복사할 영상 칸이 없습니다.', 'warning'); return Promise.resolve(false); }
    const image = render(target.cells).then(canvas => { if (!target.same()) throw changed(); return blob(canvas, 'image/png'); })
      .then(file => { if (!target.same()) throw changed(); return file; });
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
      .then(() => { tell(services, scope === 'screen' ? '화면의 영상 칸을 클립보드에 복사했습니다.' : '영상 칸을 클립보드에 복사했습니다.', 'success'); return true; })
      .catch(error => image.catch(reason => reason).then(reason => { tell(services, failure(reason instanceof Error ? reason : error), 'error'); return false; }))
      .finally(target.release);
  }

  // File names carry no patient data: what, the series number when the image states it, and the local time.
  const stamp = () => { const d = new Date(), two = n => String(n).padStart(2, '0');
    return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds()); };
  const seriesName = viewport => {
    const number = window.cornerstone?.metaData?.get?.('generalSeriesModule', viewport.getImageIds?.()?.[0])?.seriesNumber;
    return 'series-' + (Number.isSafeInteger(Number(number)) && String(number).trim() ? Number(number) : 'images');
  };
  function download(file, name) {
    const link = document.createElement('a'); link.href = URL.createObjectURL(file); link.download = name;
    link.hidden = true; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  }

  // A stored (uncompressed) ZIP: JPEG frames are already compressed and one file is one download.
  const CRC = (() => { const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    return table; })();
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {
    if (files.length > 0xFFFF) throw new Error('한 번에 저장할 수 있는 영상 수를 넘었습니다.');
    const now = new Date(), parts = [], central = []; let offset = 0;
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const { name, data } of files) {
      const title = new TextEncoder().encode(name), crc = crc32(data);
      if (offset + 30 + title.length + data.length > 0xFFFFFFFF) throw new Error('저장할 파일이 너무 큽니다.');
      const local = new DataView(new ArrayBuffer(30)), entry = new DataView(new ArrayBuffer(46));
      for (const [view, at, fields] of [[local, 4, [20, 0x0800, 0, time, date]], [entry, 6, [20, 0x0800, 0, time, date]]])
        fields.forEach((value, i) => view.setUint16(at + i * 2, value, true));
      local.setUint32(0, 0x04034b50, true); local.setUint32(14, crc, true); local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true); local.setUint16(26, title.length, true);
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true); entry.setUint16(28, title.length, true); entry.setUint32(42, offset, true);
      parts.push(local, title, data); central.push(entry, title);
      offset += 30 + title.length + data.length;
    }
    const size = central.reduce((sum, part) => sum + part.byteLength, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  const options = { loadTimeout: 30000 };
  const frames = count => new Promise(resolve => { const step = left => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });
  // Show one image of a stack: the viewport has set that image (its own promise) and then drawn while showing
  // it, and two more frames passed so the measurement layer and the image text follow. A draw of anything else
  // does not end the wait. The call in flight is kept, so a stop can let it land before anything else moves.
  function show(viewport, index, flight) {
    if (viewport.getCurrentImageIdIndex() === index) return frames(2);
    const event = window.cornerstone?.Enums?.Events?.IMAGE_RENDERED || 'CORNERSTONE_IMAGE_RENDERED';
    const set = Promise.resolve().then(() => viewport.setImageIdIndex(index));
    flight.index = index; flight.call = set.catch(() => {});
    return new Promise((resolve, reject) => {
      let over = false;
      const stop = () => { over = true; clearTimeout(timer); viewport.element.removeEventListener(event, drawn); };
      const drawn = () => { if (viewport.getCurrentImageIdIndex() !== index) return; stop(); frames(2).then(resolve); };
      const timer = setTimeout(() => { stop(); reject(new Error('영상을 불러오지 못해 내보내기를 멈췄습니다.')); }, options.loadTimeout);
      // A show that already ended (timed out) adds no listener when its call lands later.
      set.then(() => { if (over) return; viewport.element.addEventListener(event, drawn); viewport.render?.(); }, error => { stop(); reject(error); });
    });
  }
  // The export keeps its ownership until a call in flight has landed, however long that takes: released earlier,
  // a late call would move the image after the export said it stopped.
  const landed = flight => flight.call;
  // One series export at a time. It walks the selected stack from its first image to its last on the cell
  // itself (so each image is drawn as the reader would see it), and Esc stops it. It stops when the reader
  // moves the image, the cell or viewer changes, and it returns to the image the reader was on unless the
  // reader moved it or the cell no longer shows that series. Nothing is written unless it got back there and
  // nothing changed or stopped meanwhile; `after` runs inside the same export, under the same checks.
  let job = null;
  async function walk(services, live, say, verb, each, after) {
    if (job) { tell(services, '다른 내보내기가 진행 중입니다. 끝난 뒤 다시 시도하세요.', 'warning'); return false; }
    const target = pin(services, 'image', live);
    if (!target) { tell(services, '저장할 영상 칸이 없습니다.', 'warning'); return false; }
    const cell = target.cells[0], viewport = cell.viewport, ids = viewport.getImageIds?.() || [];
    const refuse = message => { target.release(); tell(services, message, 'warning'); return false; };
    if (viewport.type !== 'stack' || typeof viewport.setImageIdIndex !== 'function' || !ids.length) return refuse('시리즈 저장은 일반(2D) 영상 칸에서 할 수 있습니다.');
    if (services.cineService?.getState?.()?.cines?.[cell.id]?.isPlaying) return refuse('Cine 재생을 멈춘 뒤 다시 시도하세요.');
    const run = job = { stopped: false }, flight = { call: null, index: null };
    const key = event => { if (event.key === 'Escape') { run.stopped = true; event.preventDefault(); event.stopImmediatePropagation(); } };
    window.addEventListener('keydown', key, true);
    let shown = cell.index;
    const check = () => {
      if (run.stopped) throw new Stopped('내보내기를 멈췄습니다.');
      if (!target.same(true) || viewport.getCurrentImageIdIndex() !== shown) throw changed();
    };
    try {
      let failed = null;
      try {
        for (let index = 0; index < ids.length; index++) {
          check(); say?.(verb + ' ' + (index + 1) + '/' + ids.length + ' · Esc로 멈춤');
          await show(viewport, index, flight); shown = index; check();
          const canvas = await render(target.cells); check();
          await each(canvas, index, ids.length); check();
        }
      } catch (error) { failed = error; }
      // A call still in flight lands first; an image it moved to is this export's own move.
      if (flight.call) say?.('영상을 불러오는 중입니다. 끝나면 원래 영상으로 돌아갑니다.');
      await landed(flight);
      if (viewport.getCurrentImageIdIndex() === flight.index) shown = flight.index;
      if (target.same(true) && viewport.getCurrentImageIdIndex() === shown && shown !== cell.index) {
        await show(viewport, cell.index, flight).catch(() => {});
        await landed(flight);
        // Judged by where the image is once the call landed; the first failure is the one reported.
        if (!failed && viewport.getCurrentImageIdIndex() !== cell.index) failed = new Error('원래 보던 영상으로 돌아가지 못해 저장하지 않았습니다.');
      }
      if (failed) throw failed;
      const unchanged = () => {
        if (run.stopped) throw new Stopped('내보내기를 멈췄습니다.');
        if (!target.same()) throw changed();
      };
      unchanged();
      return after ? await after(target, unchanged) : target;
    } finally {
      window.removeEventListener('keydown', key, true); job = null; say?.(''); target.release();
    }
  }

  // Save JPEG: one image. Save Series JPEG: every image of the selected series as JPEG in one ZIP.
  async function saveImage(services, live) {
    const target = pin(services, 'image', live);
    if (!target) { tell(services, '저장할 영상 칸이 없습니다.', 'warning'); return false; }
    try {
      const file = await blob(await render(target.cells), 'image/jpeg', 0.92);
      if (!target.same()) throw changed();
      download(file, 'image-' + stamp() + '.jpg'); tell(services, 'JPEG 파일로 저장했습니다.', 'success'); return true;
    } catch (error) { tell(services, failure(error), 'error'); return false; }
    finally { target.release(); }
  }
  async function saveSeries(services, live, say) {
    const files = [];
    try {
      const target = await walk(services, live, say, 'JPEG 만드는 중', async (canvas, index, total) => {
        const data = new Uint8Array(await (await blob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
        files.push({ name: 'image-' + String(index + 1).padStart(Math.max(4, String(total).length), '0') + '.jpg', data });
      }, (target, unchanged) => {
        const file = zip(files); unchanged();
        download(file, seriesName(target.cells[0].viewport) + '-' + stamp() + '.zip'); return true;
      });
      if (!target) return false;
      tell(services, '시리즈 영상 ' + files.length + '장을 JPEG로 저장했습니다.', 'success'); return true;
    } catch (error) { tell(services, failure(error), error instanceof Stopped ? 'warning' : 'error'); return false; }
  }
  const WARNING = '식별정보가 포함될 수 있습니다. Image Text/Images Only는 익명화가 아닙니다.';
  const actions = [
    { id: 'CopyImage', label: 'Copy Image', description: '선택한 영상 칸을 보이는 그대로(영상·표식·영상 글자) 클립보드에 PNG로 복사 · ' + WARNING,
      run: (services, { live } = {}) => copy(services, 'image', live) },
    { id: 'CopyScreen', label: 'Copy Screen', description: '이 창의 모든 영상 칸을 보이는 그대로 한 장으로 클립보드에 PNG로 복사 · ' + WARNING,
      run: (services, { live } = {}) => copy(services, 'screen', live) },
    { id: 'SaveJPEG', label: 'Save JPEG', description: '선택한 영상 칸을 보이는 그대로 JPEG 파일로 저장 · ' + WARNING,
      run: (services, { live } = {}) => saveImage(services, live) },
    { id: 'SaveSeriesJPEG', label: 'Save Series JPEG', description: '선택한 영상 칸 시리즈의 모든 영상을 처음부터 끝까지 보이는 그대로 JPEG로 만들어 ZIP 하나로 저장 · Esc로 멈춤 · ' + WARNING,
      run: (services, { live, say } = {}) => saveSeries(services, live, say) },
  ];
  return { actions, options, pin, render, copy, saveImage, saveSeries, zip };
})();
