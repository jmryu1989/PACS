// Viewer feature module: Toolbar & Thumbnail Position. The image toolbar and the series (thumbnail) strip can stand on
// any edge of the image area, and either can hide until the pointer reaches its edge. The choice is saved to the account
// (viewerSettings.features.chrome) and applied by the viewer shell (viewer-ux-shell.js), which owns the rows' place.
// The pure part below (KinViewerChromePosition) checks a stored value and turns it into the image column's layout.
(function (root) {
  const SIDES = ['top', 'bottom', 'left', 'right'];
  const DEFAULT = Object.freeze({ toolbar: 'top', toolbarAutoHide: false, thumbs: 'top', thumbsAutoHide: false });
  // Whole-pixel thickness of each row at the viewer's 12px font: the toolbar row is 36px high on top or bottom and
  // 108px wide on a side; the strip is 66px high (a 4em thumbnail and two text lines) or 156px wide (one 12em card).
  const THICKNESS = { toolbar: { across: 36, upright: 108 }, thumbs: { across: 66, upright: 156 } };
  const EDGE = 8;
  const upright = side => side === 'left' || side === 'right';
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

  // A stored value is never trusted: each field that is not one of its choices falls back to the default.
  function normalize(value) {
    const given = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      toolbar: SIDES.includes(given.toolbar) ? given.toolbar : DEFAULT.toolbar,
      toolbarAutoHide: typeof given.toolbarAutoHide === 'boolean' ? given.toolbarAutoHide : DEFAULT.toolbarAutoHide,
      thumbs: SIDES.includes(given.thumbs) ? given.thumbs : DEFAULT.thumbs,
      thumbsAutoHide: typeof given.thumbsAutoHide === 'boolean' ? given.thumbsAutoHide : DEFAULT.thumbsAutoHide,
    };
  }
  const standard = value => { const v = normalize(value); return Object.keys(DEFAULT).every(key => v[key] === DEFAULT[key]); };
  const thickness = (row, side) => THICKNESS[row][upright(side) ? 'upright' : 'across'];

  // The image column as a CSS grid. Rows that stay in place take a band on their edge, outermost first: the toolbar is
  // placed before the strip, so on the same edge it is outside, and on another edge it spans the whole column. An
  // auto-hidden row takes no band; it lies over the images at its edge (overlays), inside any band placed before it.
  function plan(value) {
    const v = normalize(value);
    const rows = [['toolbar', 'tb', v.toolbar, v.toolbarAutoHide], ['thumbs', 'th', v.thumbs, v.thumbsAutoHide]];
    const bands = rows.filter(row => !row[3]);
    const on = side => bands.filter(band => band[2] === side).map(band => band[1]);
    const rowNames = [...on('top'), 'im', ...on('bottom').reverse()];
    const columnNames = [...on('left'), 'im', ...on('right').reverse()];
    const cells = rowNames.map(() => columnNames.map(() => 'im'));
    let top = 0, bottom = rowNames.length - 1, left = 0, right = columnNames.length - 1;
    for (const [, name, side] of bands) {
      if (side === 'top') { for (let c = left; c <= right; c++) cells[top][c] = name; top++; }
      else if (side === 'bottom') { for (let c = left; c <= right; c++) cells[bottom][c] = name; bottom--; }
      else if (side === 'left') { for (let r = top; r <= bottom; r++) cells[r][left] = name; left++; }
      else { for (let r = top; r <= bottom; r++) cells[r][right] = name; right--; }
    }
    const track = name => name === 'im' ? 'minmax(0, 1fr)' : 'auto';
    // Where each auto-hidden row lies (inset: its insets from the column's edges; the opposite edge is left to its size)
    // and the edge whose band brings it out (edge: inside the bands in place only). Two auto-hidden rows on the same edge
    // come out together from that one edge, the toolbar outside the strip (together).
    const overlays = [];
    const inset = { top: 0, right: 0, bottom: 0, left: 0 }, edge = { ...inset };
    const together = v.toolbarAutoHide && v.thumbsAutoHide && v.toolbar === v.thumbs;
    const trim = value => { const box = { ...value }; return side => { delete box[opposite[side]]; return box; }; };
    for (const [row, , side, hidden] of rows) {
      if (hidden) overlays.push({ row, side, inset: trim(inset)(side), edge: trim(edge)(side), thickness: thickness(row, side), together });
      if (row === 'toolbar' && !hidden) { inset[side] += thickness(row, side); edge[side] += thickness(row, side); }
      else if (row === 'toolbar' && together) inset[side] += thickness(row, side);
    }
    return {
      standard: standard(v), value: v,
      areas: cells.map(line => '"' + line.join(' ') + '"').join(' '),
      rows: rowNames.map(track).join(' '), columns: columnNames.map(track).join(' '),
      overlays,
    };
  }

  // The rules the shell writes for a value; the theme stylesheet keys the rest on the body attributes.
  const COLUMN = 'body.kin-viewer-ux[data-kin-chrome] #root :has(> .kin-viewer-series-strip)';
  const SELECTOR = { toolbar: '.kin-ux-toolbar-slot', thumbs: '.kin-viewer-series-strip' };
  function css(value) {
    const p = plan(value);
    if (p.standard) return '';
    const lines = [COLUMN + ' { grid-template-areas: ' + p.areas + '; grid-template-rows: ' + p.rows + '; grid-template-columns: ' + p.columns + '; }'];
    for (const { row, side, inset, together } of p.overlays) {
      const place = Object.entries(inset).map(([edge, px]) => edge + ': ' + px + 'px').join('; ');
      const across = upright(side) ? 'height: auto' : 'width: auto';
      lines.push(COLUMN + ' > ' + SELECTOR[row] + ' { ' + place + '; ' + across + '; }');
      // A 4px line on that edge shows where the hidden row is (the column's ::before for the toolbar, ::after for the strip);
      // two rows that come out together from one edge have one line.
      if (together && row === 'thumbs') continue;
      const hint = row === 'toolbar' ? '::before' : '::after';
      lines.push(COLUMN + hint + ' { ' + place + '; ' + (upright(side) ? 'width' : 'height') + ': 4px; }');
    }
    return lines.join('\n');
  }

  // The band along a hidden row's edge where the pointer brings it out, in the column's coordinates.
  function edgeHit(overlay, box, x, y) {
    const { side } = overlay, inset = overlay.edge || overlay.inset;
    const top = box.top + (inset.top || 0), bottom = box.bottom - (inset.bottom || 0);
    const left = box.left + (inset.left || 0), right = box.right - (inset.right || 0);
    if (upright(side)) {
      const line = side === 'left' ? left : right;
      return y >= top && y <= bottom && Math.abs(x - line) <= EDGE;
    }
    const line = side === 'top' ? top : bottom;
    return x >= left && x <= right && Math.abs(y - line) <= EDGE;
  }

  const model = { SIDES, DEFAULT, THICKNESS, EDGE, normalize, standard, plan, css, edgeHit, upright };
  if (typeof module === 'object' && module.exports) module.exports = model;
  if (root) root.KinViewerChromePosition = model;
})(typeof window === 'object' ? window : null);

if (typeof window === 'object') window.KinViewerFeatures?.module('chrome', ({ store, ui }) => {
  const model = window.KinViewerChromePosition;
  const SIDE_LABEL = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' };
  let current = model.normalize(undefined), panel = null;
  const element = (tag, attributes = {}, parent) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'text') node.textContent = value; else if (key === 'className') node.className = value; else node.setAttribute(key, value);
    }
    parent?.append(node); return node;
  };
  function apply(value) {
    current = model.normalize(value);
    // While an applied Hanging Protocol places the rows per monitor (viewer-features-monitors.js) they stay there; the
    // account's value comes back when that ends.
    if (!window.KinViewerMonitorRows) window.KinViewerUXShell?.chrome?.(current);
    panel?.show();
  }

  // A drawing of a monitor with the rows where the chosen value puts them (a hidden row is a thin line).
  function monitor(label, width, height, value) {
    const box = element('div', { className: 'kin-chrome-monitor', role: 'img' });
    box.style.width = width + 'px'; box.style.height = height + 'px';
    const area = { top: 0, right: 0, bottom: 0, left: 0 };
    const words = [];
    for (const [row, name, side, hidden] of [['toolbar', 'Toolbar', value.toolbar, value.toolbarAutoHide], ['thumbs', 'Thumbnails', value.thumbs, value.thumbsAutoHide]]) {
      const thick = hidden ? 4 : row === 'toolbar' ? 14 : 24;
      const part = element('div', { className: 'kin-chrome-' + row + (hidden ? ' kin-chrome-hidden' : '') }, box);
      const across = !model.upright(side);
      Object.assign(part.style, {
        top: (side === 'bottom' ? '' : area.top + 'px'), bottom: (side === 'top' ? '' : area.bottom + 'px'),
        left: (side === 'right' ? '' : area.left + 'px'), right: (side === 'left' ? '' : area.right + 'px'),
        [across ? 'height' : 'width']: thick + 'px',
      });
      if (!hidden) part.textContent = row === 'toolbar' ? 'Tools' : 'Thumbs';
      area[side] += thick;
      words.push(name + ' ' + SIDE_LABEL[side] + (hidden ? ' (Auto-hide)' : ''));
    }
    const images = element('div', { className: 'kin-chrome-images', text: 'Images' }, box);
    Object.assign(images.style, { top: area.top + 'px', right: area.right + 'px', bottom: area.bottom + 'px', left: area.left + 'px' });
    box.setAttribute('aria-label', label + ': ' + words.join(', '));
    const figure = element('figure', { className: 'kin-chrome-figure' });
    figure.append(box); element('figcaption', { text: label }, figure);
    return figure;
  }

  function open() {
    const handle = ui.panel({ id: 'chromePosition', title: 'Toolbar & Thumbnail Position' });
    if (!handle || handle.body.childElementCount) return handle;
    handle.element.classList.add('kin-chrome-panel');
    element('p', { text: '도구 줄과 썸네일(시리즈) 줄을 모니터에 맞춰 위·아래·왼쪽·오른쪽에 둡니다. Auto-hide를 켜면 줄을 접어 두고, 마우스를 그 가장자리로 가져가면 나타납니다. Apply로 계정에 저장하고 이 창에 바로 적용합니다.' }, handle.body);
    const draft = { ...current };
    const controls = {};
    for (const [row, name] of [['toolbar', 'Toolbar'], ['thumbs', 'Thumbnails']]) {
      const line = element('div', { className: 'kin-chrome-row' }, handle.body);
      const field = element('label', { className: 'kin-chrome-field' }, line);
      element('span', { text: name }, field);
      const select = element('select', { 'aria-label': name }, field);
      for (const side of model.SIDES) element('option', { value: side, text: SIDE_LABEL[side] }, select);
      const hide = element('label', { className: 'kin-chrome-check' }, line);
      const check = element('input', { type: 'checkbox', 'aria-label': 'Auto-hide ' + name }, hide);
      element('span', { text: 'Auto-hide ' + name }, hide);
      select.addEventListener('change', () => { draft[row] = select.value; paint(); });
      check.addEventListener('change', () => { draft[row + 'AutoHide'] = check.checked; paint(); });
      controls[row] = { select, check };
    }
    const diagram = element('div', { className: 'kin-chrome-diagram', role: 'group', 'aria-label': 'Layout Preview' }, handle.body);
    const actions = element('div', { className: 'kin-chrome-actions' }, handle.body);
    const applyButton = element('button', { type: 'button', text: 'Apply' }, actions);
    const status = element('p', { role: 'status' }, handle.body);
    let revision = handle.revision, saving = false, live = true;
    function paint() {
      diagram.replaceChildren(monitor('Landscape', 168, 104, draft), monitor('Portrait', 96, 152, draft));
    }
    function show() {
      if (saving) return;
      Object.assign(draft, current);
      for (const row of ['toolbar', 'thumbs']) { controls[row].select.value = draft[row]; controls[row].check.checked = draft[row + 'AutoHide']; }
      paint();
    }
    applyButton.addEventListener('click', async () => {
      if (saving) return;
      saving = true; applyButton.disabled = true; status.textContent = '저장 중입니다…';
      const value = model.normalize(draft);
      const saved = await store.set('chrome', value, { revision });
      if (!live) return;
      saving = false; applyButton.disabled = false;
      if (saved) revision = store.revision();
      show();
      status.textContent = saved ? (store.writable() ? '계정에 저장하고 이 창에 적용했습니다.' : '이 창에만 적용했습니다.')
        : '저장하지 못해 저장된 배치로 되돌렸습니다. 도구 줄의 상태 문구를 확인하세요.';
    });
    panel = { show };
    handle.onClose(() => { live = false; if (panel?.show === show) panel = null; });
    show();
    handle.focus();
    return handle;
  }

  ui.setting({ id: 'chromePosition', kind: 'button', label: 'Toolbar & Thumbnail Position…', order: 2, run: () => open() });
  const stop = store.subscribe('chrome', apply);
  // The rows keep their place for the next viewer of this document (a patient tab or a saved Job remounts the toolbar,
  // which applies the account's value again before the grid is drawn).
  return () => { stop(); };
});
