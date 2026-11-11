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

  const WARNING = '식별정보가 포함될 수 있습니다. Image Text/Images Only는 익명화가 아닙니다.';
  const actions = [
    { id: 'CopyImage', label: 'Copy Image', description: '선택한 영상 칸을 보이는 그대로(영상·표식·영상 글자) 클립보드에 PNG로 복사 · ' + WARNING,
      run: (services, { live } = {}) => copy(services, 'image', live) },
    { id: 'CopyScreen', label: 'Copy Screen', description: '이 창의 모든 영상 칸을 보이는 그대로 한 장으로 클립보드에 PNG로 복사 · ' + WARNING,
      run: (services, { live } = {}) => copy(services, 'screen', live) },
  ];
  return { actions, pin, render, copy };
})();
