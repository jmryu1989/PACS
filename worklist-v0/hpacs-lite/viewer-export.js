/* Viewer export (A1): actions that stand after Capture in the viewer toolbar and work on what an image cell
   shows. A cell is drawn as the reader sees it: its image canvases, its measurement and annotation layer and
   the image text shown in it. Image Text and Images Only already decide which text is shown, so there is no
   separate overlay choice here. Nothing is sent to the server and nothing is stored.
   Every action pins the cells it started on (viewport, image list, shown image) and the viewer's life; a
   result that arrives after any of them changed is dropped, never written to another study. */
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
    // Still the same viewer, cells, image lists and (unless this action moves it) shown image.
    const same = (moving = false) => live() && !document.body.classList.contains('kin-patient-switching') && cells.every(cell =>
      viewports.getCornerstoneViewport(cell.id) === cell.viewport && cell.viewport.element?.isConnected &&
      JSON.stringify(cell.viewport.getImageIds?.() || []) === cell.imageIds && (moving || cell.viewport.getCurrentImageIdIndex?.() === cell.index));
    return { cells, same };
  }
  function svgImage(svg, rect) {
    const copy = svg.cloneNode(true);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', rect.width); copy.setAttribute('height', rect.height);
    const image = new Image();
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy));
    return image.decode().then(() => image);
  }
  function drawText(context, pane, at) {
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.replace(/\s+/g, ' ').trim(), parent = node.parentElement;
      if (!text || !parent || parent.closest(NOT_IMAGE_TEXT) || !visible(parent)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rect = range.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
      const style = getComputedStyle(parent);
      context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
      context.fillStyle = style.color; context.textBaseline = 'middle'; context.textAlign = 'left';
      context.fillText(text, rect.left - at.left, rect.top - at.top + rect.height / 2);
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

  // FB-031. The clipboard takes images as PNG only, so there is no format choice. The write starts in the
  // reader's click or key press and receives the image once it is drawn; a changed cell fails the write.
  function copy(services, scope, live) {
    const target = pin(services, scope, live);
    if (!target) { tell(services, '복사할 영상 칸이 없습니다.', 'warning'); return Promise.resolve(false); }
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
      tell(services, '이 브라우저에서는 영상을 클립보드에 복사할 수 없습니다.', 'error'); return Promise.resolve(false);
    }
    const image = render(target.cells).then(canvas => { if (!target.same()) throw changed(); return blob(canvas, 'image/png'); });
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': image })])
      .then(() => { tell(services, scope === 'screen' ? '화면의 영상 칸을 클립보드에 복사했습니다.' : '영상 칸을 클립보드에 복사했습니다.', 'success'); return true; })
      .catch(error => image.catch(reason => reason).then(reason => { tell(services, failure(reason instanceof Error ? reason : error), 'error'); return false; }));
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
