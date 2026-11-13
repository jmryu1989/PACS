// Viewer feature module: mouse, wheel and quick tool access. It registers through viewer-features.js (menu items, toolbar buttons,
// Viewer Settings entries, shortcuts) and adds nothing to the screen until it registers something.
//   Mouse & Wheel (A1 04-3): the tools of the right, middle and both buttons, the wheel step and wraparound, the Ctrl+wheel
//     zoom step and the default tool, saved to the account and put on the stack cells by kinStackMouse (config/ohif/viewer-ux.js).
//   Context Toolbar (A1 04-5): when on, a right click that does not move opens a bar of chosen tools at the pointer; its
//     tools run on the cell that was clicked.
//   F.Leader (A1 04-6): a key panel — an area letter, then a function letter runs that function as its menu or button does.

// Pure parts, also read by the tests.
window.KinViewerInputModel = (() => {
  // Keys of the functions in an area: a–z, then 1–9, in menu order; more functions than that continue on further pages
  // of the same keys, turned with Tab.
  const KEYS = 'abcdefghijklmnopqrstuvwxyz123456789'.split('');
  const leaderKeys = count => Array.from({ length: Math.max(0, count | 0) }, (_, index) => ({ key: KEYS[index % KEYS.length], page: Math.floor(index / KEYS.length) }));
  const AREAS = [['v', 'View'], ['n', 'Navigate'], ['c', 'Compare'], ['m', 'Measure'], ['s', 'Settings']];
  // The toolbar's own tools by area; a tool not named here is a View tool.
  const MEASURE_TOOLS = ['Length', 'Bidirectional', 'ArrowAnnotate', 'EllipticalROI', 'RectangleROI', 'CircleROI', 'PlanarFreehandROI',
    'SplineROI', 'LivewireContour', 'Probe', 'Angle', 'CobbAngle', 'CalibrationLine', 'UltrasoundDirectionalTool'];
  const NAVIGATE_TOOLS = ['StackScroll', 'Cine', 'Crosshairs', 'ReferenceLines', 'ImageSliceSync'];
  const toolArea = id => MEASURE_TOOLS.includes(id) ? 'm' : NAVIGATE_TOOLS.includes(id) ? 'n' : 'v';
  // A registered action without a menu belongs to its module's area.
  const moduleArea = name => ({ navigate: 'n', compare: 'c', measure: 'm', 'measure-lines': 'm', 'measure-ortho': 'm' })[name] || 'v';
  // The functions of every area, read when the panel asks: Display items, View buttons and tools, then MG items under v;
  // Viewer Settings and the Tools & Display windows under s.
  function areas({ actions = [], tools = [], settings = [], exclude = [] }) {
    const feature = action => ({ kind: 'feature', id: action.id, label: action.label });
    const menu = name => actions.filter(action => action.menu === name).map(feature);
    const loose = area => actions.filter(action => !action.menu && !exclude.includes(action.id) && moduleArea(action.module) === area).map(feature);
    const tool = area => tools.filter(item => toolArea(item.id) === area).map(item => ({ kind: 'tool', id: item.id, label: item.label }));
    return {
      v: [...menu('Display'), ...loose('v'), ...tool('v'), ...menu('MG')],
      n: [...menu('Navigate'), ...loose('n'), ...tool('n')],
      c: [...menu('Compare'), ...loose('c'), ...tool('c')],
      m: [...menu('Measure'), ...loose('m'), ...tool('m')],
      s: [{ kind: 'settings', id: 'viewerSettings', label: 'Viewer Settings' }, ...settings.map(item => ({ kind: 'setting', id: item.id, label: item.label }))],
    };
  }
  // Context Toolbar: off unless turned on; the bar's tools in order. A stored value is checked on every read.
  const CONTEXT_ITEMS = ['WindowLevel', 'Zoom', 'Pan', 'Length', 'EllipticalROI', 'ArrowAnnotate', 'invert'];
  function contextSettings(value) {
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const items = Array.isArray(stored.items)
      ? [...new Set(stored.items.filter(id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)))].slice(0, 64)
      : [...CONTEXT_ITEMS];
    return { on: stored.on === true, items };
  }
  // A right click opens the bar only when the press did not move past this distance and was let go within this time.
  return { KEYS, leaderKeys, AREAS, areas, toolArea, contextSettings, CONTEXT_ITEMS, MOVE: 4, HOLD: 400 };
})();

window.KinViewerFeatures?.module('input', ({ services, store, ui }) => {
  const model = window.KinViewerInputModel, disposers = [];
  const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); disposers.push(() => target.removeEventListener(type, fn, options)); };
  const element = (tag, text, parent, className) => {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; parent?.append(node); return node;
  };
  const button = (text, parent, click, className) => { const node = element('button', text, parent, className); node.type = 'button'; node.onclick = click; return node; };
  const saved = () => store.writable() ? '계정에 저장했습니다.' : '이 창에만 적용했습니다. 계정에는 저장하지 않습니다.';
  const unsaved = '저장하지 못했습니다. 도구 줄의 상태 문구를 확인한 뒤 다시 시도하세요.';
  const style = element('style', `
.kin-ux-context-bar { position: fixed; z-index: 1000; display: flex; flex-wrap: wrap; gap: 2px; max-width: 90vw; padding: 3px; background: var(--kin-panel, #1b2230); border: 1px solid var(--kin-ux-secondary, #556); border-radius: 4px; box-shadow: 0 2px 8px #0008; }
.kin-ux-context-bar button { font: inherit; font-size: 12px; color: var(--kin-ux-text, #eee); background: transparent; border: 1px solid transparent; border-radius: 3px; padding: 3px 7px; cursor: pointer; white-space: nowrap; }
.kin-ux-context-bar button:hover, .kin-ux-context-bar button:focus-visible { border-color: var(--kin-accent, #6cf); }
.kin-ux-fleader { position: fixed; z-index: 1000; left: 50%; top: 18%; transform: translateX(-50%); min-width: 240px; max-width: min(560px, 92vw); max-height: 70vh; overflow: auto; padding: 10px 14px; background: var(--kin-panel, #1b2230); color: var(--kin-ux-text, #eee); border: 1px solid var(--kin-accent, #6cf); border-radius: 6px; box-shadow: 0 4px 16px #000a; }
.kin-ux-fleader h2 { margin: 0 0 4px; font-size: 14px; }
.kin-ux-fleader p { margin: 0 0 6px; font-size: 12px; color: var(--kin-ux-secondary, #aaa); }
.kin-ux-fleader ul { margin: 0; padding: 0; list-style: none; columns: 2; font-size: 13px; }
.kin-ux-fleader li { padding: 2px 0; break-inside: avoid; }
.kin-ux-fleader kbd { display: inline-block; min-width: 1.4em; margin-right: 6px; text-align: center; border: 1px solid var(--kin-ux-secondary, #888); border-radius: 3px; font: 12px monospace; }
.kin-ux-input-form { display: grid; gap: 4px; margin: 6px 0; }
.kin-ux-input-form label { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.kin-ux-context-list { border-collapse: collapse; font-size: 12px; margin: 6px 0; }
.kin-ux-context-list td, .kin-ux-context-list th { padding: 1px 6px; text-align: left; }`, document.head);
  disposers.push(() => style.remove());
  const toolLabel = id => ui.tools().find(tool => tool.id === id)?.label;

  // ── Mouse & Wheel (04-3) ── the settings and their engine live in config/ohif/viewer-ux.js; without it nothing is offered.
  const mouseModel = typeof window.kinMouseModel === 'function' ? window.kinMouseModel() : null;
  if (mouseModel) {
    store.subscribe('mouse', value => window.kinViewerStackMouse?.configure(value));
    ui.setting({ id: 'mouseWheel', kind: 'button', label: 'Mouse & Wheel…', order: 10, run: openMouse });
  }
  function openMouse() {
    const panel = ui.panel({ id: 'mouse', title: 'Mouse & Wheel' });
    if (!panel || panel.body.childElementCount) return;
    const current = window.kinMouseSettings(store.get('mouse')), { choices } = mouseModel;
    const names = { StackScroll: 'Stack Scroll', WindowLevel: 'W/L', Pan: 'Pan', Zoom: 'Zoom', Pointer: 'Pointer', None: 'None' };
    element('p', '마우스 단추마다 쓸 도구, 휠 한 칸에 넘길 영상 수와 끝에서 돌아가기, Ctrl+휠 확대 비율, 기본 도구를 정합니다. Left button은 지금 왼쪽 단추의 도구이고, Default tool은 뷰어를 열 때와 선택한 도구를 끌 때 왼쪽 단추로 돌아오는 도구입니다. Apply를 누르면 열린 영상에 바로 적용하고 계정에 저장합니다.', panel.body);
    const form = element('div', '', panel.body, 'kin-ux-input-form');
    const field = (label, options, value) => {
      const row = element('label', '', form); element('span', label, row);
      const select = element('select', '', row); select.setAttribute('aria-label', label);
      for (const [key, text] of options) { const option = element('option', text, select); option.value = String(key); }
      select.value = String(value); return select;
    };
    const tools = list => list.map(id => [id, names[id]]);
    const leftNow = window.kinViewerStackMouse?.left?.() || current.defaultTool;
    const leftOptions = tools(choices.left);
    if (!choices.left.includes(leftNow)) leftOptions.unshift([leftNow, toolLabel(leftNow) || leftNow]);
    const left = field('Left button', leftOptions, leftNow);
    const middle = field('Middle button', tools(choices.middle), current.middle);
    const right = field('Right button', tools(choices.right), current.right);
    const both = field('Left + Right', tools(choices.both), current.both);
    const fallback = field('Default tool', tools(choices.defaultTool), current.defaultTool);
    const step = field('Wheel step', choices.wheelStep.map(count => [count, count === 1 ? '1 image' : count + ' images']), current.wheelStep);
    const wrapRow = element('label', '', form), wrap = element('input', '', wrapRow); wrap.type = 'checkbox'; wrap.checked = current.wrap;
    wrap.setAttribute('aria-label', 'Wrap at ends'); element('span', 'Wrap at ends', wrapRow);
    const zoom = field('Ctrl+wheel zoom', choices.ctrlZoom.map(percent => [percent, percent ? percent + '%' : 'Off']), current.ctrlZoom);
    const apply = button('Apply', panel.body, async () => {
      const value = { middle: middle.value, right: right.value, both: both.value, defaultTool: fallback.value,
        wheelStep: Number(step.value), wrap: wrap.checked, ctrlZoom: Number(zoom.value) };
      apply.disabled = true; status.textContent = '저장 중…';
      const ok = await store.set('mouse', value, { revision: panel.revision });
      if (!panel.element.isConnected) return;
      apply.disabled = false;
      if (!ok) { status.textContent = unsaved; return; }
      panel.revision = store.revision();
      window.kinViewerStackMouse?.configure(value, { left: left.value });
      status.textContent = '적용했습니다. ' + saved();
    });
    const status = element('p', '', panel.body); status.setAttribute('role', 'status');
    left.focus();
  }

  // ── Context Toolbar (04-5) ──
  let context = model.contextSettings(undefined), gesture = null, bar = null;
  store.subscribe('contextToolbar', value => { context = model.contextSettings(value); if (!context.on) closeBar(); });
  ui.setting({ id: 'contextToolbar', kind: 'button', label: 'Context Toolbar…', order: 30, run: openContext });
  // What the bar can hold: the toolbar's tools, then the feature menu items and buttons.
  function candidates() {
    const tools = ui.tools().map(tool => ({ kind: 'tool', id: tool.id, label: tool.label }));
    const features = (window.KinViewerFeatures?.actions() || []).filter(action => (action.menu || action.button) && !tools.some(tool => tool.id === action.id))
      .map(action => ({ kind: 'feature', id: action.id, label: action.label }));
    return [...tools, ...features];
  }
  // The cell the right click was on, pinned at the press: its viewport, its display sets and a generation that moves
  // whenever the grid or that cell is given other images, or a patient switch or an emptied viewer begins or ends.
  // A bar (or a press) whose cell moved on is dropped; a tool runs only while the cell is still that target.
  const moves = new Map(), STATES = ['kin-patient-switching', 'kin-viewer-empty'];
  let everyCell = 0;
  const generation = id => everyCell + (moves.get(id) ?? 0);
  const switching = () => STATES.some(name => document.body.classList.contains(name));
  function moved(ids) {
    if (ids) for (const id of ids) moves.set(id, (moves.get(id) ?? 0) + 1); else everyCell++;
    if (gesture && !same(gesture.target)) gesture.cancelled = true;
    if (bar && !same(bar.target)) closeBar();
  }
  const subscriptions = [];
  const follow = (service, event, fn) => {
    if (!event || typeof service?.subscribe !== 'function') return;
    const subscription = service.subscribe(event, fn); if (subscription) subscriptions.push(subscription);
  };
  const grid = services.viewportGridService, cells = services.cornerstoneViewportService;
  follow(grid, grid?.EVENTS?.GRID_STATE_CHANGED, event => moved(Array.isArray(event?.viewports)
    ? [...event.viewports.map(view => view?.viewportId), ...(event.removedViewportIds || [])].filter(Boolean) : null));
  follow(cells, cells?.EVENTS?.VIEWPORT_DATA_CHANGED, event => moved(event?.viewportId ? [event.viewportId] : null));
  // A state class was there before a change (the old value) or is there now: a switch began or ended.
  const stateIn = value => typeof value === 'string' && value.split(/\s+/).some(name => STATES.includes(name));
  const observed = records => { if (records.length && (records.some(record => stateIn(record.oldValue)) || switching())) moved(null); };
  const classes = new MutationObserver(observed);
  classes.observe(document.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  disposers.push(() => { classes.disconnect(); for (const subscription of subscriptions) try { subscription.unsubscribe?.(); } catch (error) { console.error(error); } });
  const shown = id => JSON.stringify(grid?.getState?.()?.viewports?.get?.(id)?.displaySetInstanceUIDs || []);
  function pin(viewportId) {
    return { viewportId, at: generation(viewportId), viewport: cells?.getCornerstoneViewport(viewportId), sets: shown(viewportId) };
  }
  function same(target) {
    observed(classes.takeRecords());
    return !!target && !switching() && generation(target.viewportId) === target.at && cells?.getCornerstoneViewport(target.viewportId) === target.viewport
      && shown(target.viewportId) === target.sets;
  }
  // The viewer makes a requested cell active on a later render; resolves whether that cell is active within a second.
  function activate(viewportId) {
    if (grid?.getActiveViewportId?.() === viewportId) return Promise.resolve(true);
    if (typeof grid?.setActiveViewportId !== 'function') return Promise.resolve(false);
    grid.setActiveViewportId(viewportId);
    const until = Date.now() + 1000;
    return new Promise(resolve => {
      const check = () => grid.getActiveViewportId?.() === viewportId ? resolve(true) : Date.now() >= until ? resolve(false) : setTimeout(check, 16);
      setTimeout(check, 0);
    });
  }
  async function runOn(entry, target) {
    if (!same(target)) return false;
    if (entry.kind !== 'tool') return window.KinViewerFeatures?.run(entry.id, { viewportId: target.viewportId });
    // The toolbar's guards come first, so a refused tool changes nothing (not even the active cell). The target then
    // becomes the active cell; the tool runs there only if the cell still shows the same images.
    if (!ui.allowed() || !await activate(target.viewportId) || !same(target)) return false;
    return ui.invoke(entry.id);
  }
  function openContext() {
    const panel = ui.panel({ id: 'context', title: 'Context Toolbar' });
    if (!panel || panel.body.childElementCount) return;
    element('p', '영상 위에서 마우스를 움직이지 않고 오른쪽 단추를 누르면 그 자리에 도구 막대를 엽니다. 막대에 올릴 도구와 순서를 정합니다. 끄면 오른쪽 단추는 지금처럼 동작합니다. 바꾸면 바로 계정에 저장합니다.', panel.body);
    const onRow = element('label', '', panel.body, 'kin-ux-setting-row'), on = element('input', '', onRow); on.type = 'checkbox';
    on.setAttribute('aria-label', 'Right-click opens the Context Toolbar'); element('span', 'Right-click opens the Context Toolbar', onRow);
    const table = element('table', '', panel.body, 'kin-ux-context-list'); table.setAttribute('aria-label', 'Context Toolbar Tools');
    const status = element('p', '', panel.body); status.setAttribute('role', 'status');
    let value = model.contextSettings(store.get('contextToolbar')), saving = false;
    // The control that had focus keeps it when the table is drawn again (also across a save, which disables it meanwhile).
    function paint(keep) {
      const focused = keep || document.activeElement?.dataset?.contextControl;
      on.checked = value.on; on.disabled = saving;
      const all = candidates(), shown = value.items.map(id => all.find(item => item.id === id)).filter(Boolean);
      const rest = all.filter(item => !value.items.includes(item.id));
      table.replaceChildren();
      const head = element('tr', '', table); for (const text of ['Show', 'Tool', 'Order']) element('th', text, head);
      for (const item of [...shown, ...rest]) {
        const row = element('tr', '', table), visible = shown.includes(item);
        const check = element('input', '', element('td', '', row)); check.type = 'checkbox'; check.checked = visible; check.disabled = saving;
        check.setAttribute('aria-label', 'Show ' + item.label); check.dataset.contextControl = 'show:' + item.id;
        check.onchange = () => change({ ...value, items: check.checked ? [...value.items, item.id] : value.items.filter(id => id !== item.id) });
        element('td', item.label, row);
        const order = element('td', '', row);
        if (!visible) continue;
        for (const [text, name, direction] of [['↑', 'Up', -1], ['↓', 'Down', 1]]) {
          const node = button(text, order, () => move(item.id, direction));
          node.setAttribute('aria-label', 'Move ' + item.label + ' ' + name); node.dataset.contextControl = name + ':' + item.id; node.disabled = saving;
        }
      }
      if (focused) table.querySelector('[data-context-control="' + CSS.escape(focused) + '"]')?.focus();
    }
    // Up and Down swap with the neighbouring tool on the bar (stored tools not offered now keep their places).
    function move(id, direction) {
      const all = candidates(), places = value.items.map((item, index) => [item, index]).filter(([item]) => all.some(c => c.id === item));
      const at = places.findIndex(([item]) => item === id), other = places[at + direction];
      if (at < 0 || !other) return;
      const items = [...value.items]; [items[places[at][1]], items[other[1]]] = [items[other[1]], items[places[at][1]]];
      change({ ...value, items });
    }
    async function change(next) {
      if (saving) return;
      const keep = document.activeElement?.dataset?.contextControl;
      saving = true; value = next; status.textContent = '저장 중…'; paint(keep);
      const ok = await store.set('contextToolbar', next, { revision: panel.revision });
      saving = false;
      if (!panel.element.isConnected) return;
      if (ok) { panel.revision = store.revision(); status.textContent = saved(); }
      else { value = model.contextSettings(store.get('contextToolbar')); status.textContent = unsaved; }
      paint(keep);
    }
    on.dataset.contextControl = 'on';
    on.onchange = () => change({ ...value, on: on.checked });
    paint(); on.focus();
  }
  // The stack cell under a pointer event (the bar is offered on stack cells only).
  function cellAt(target) {
    const grid = services.viewportGridService, cells = services.cornerstoneViewportService;
    for (const id of grid?.getState?.()?.viewports?.keys?.() || []) {
      const viewport = cells?.getCornerstoneViewport(id);
      if (viewport?.type === 'stack' && viewport.element?.contains?.(target)) return id;
    }
    return null;
  }
  function closeBar() { if (!bar) return; bar.remove(); bar = null; }
  function openBar(x, y, target) {
    closeBar();
    if (!same(target)) return;
    const all = candidates(), entries = context.items.map(id => all.find(item => item.id === id)).filter(Boolean);
    if (!entries.length) return;
    bar = element('div', '', document.body, 'kin-ux-context-bar');
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Context Toolbar'); bar.dataset.viewportId = target.viewportId; bar.target = target;
    for (const entry of entries) {
      const node = button(entry.label, bar, () => { closeBar(); runOn(entry, target); });
      node.dataset.contextItem = entry.id;
    }
    const box = bar.getBoundingClientRect();
    bar.style.left = Math.max(0, Math.min(x, innerWidth - box.width - 4)) + 'px';
    bar.style.top = Math.max(0, Math.min(y, innerHeight - box.height - 4)) + 'px';
  }
  // The right-button gesture as a whole: a press on a stack cell with the right button alone, no modifier key, let go
  // within HOLD without moving past MOVE, no other button joining and not cancelled (Esc, leaving the window). Motion
  // within MOVE does not reach the right-button tool, so a click never also changes the window or level.
  listen(window, 'mousedown', event => {
    if (gesture) { if (event.button !== 2) gesture.cancelled = true; return; }
    if (!context.on || event.button !== 2 || event.buttons !== 2 || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    const viewportId = cellAt(event.target);
    if (viewportId) gesture = { x: event.clientX, y: event.clientY, time: event.timeStamp, target: pin(viewportId), moved: false, cancelled: false };
  }, true);
  listen(window, 'mousemove', event => {
    if (!gesture || gesture.moved || gesture.cancelled) return;
    if (event.buttons !== 2) { gesture.cancelled = true; return; }
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > model.MOVE) { gesture.moved = true; return; }
    event.stopImmediatePropagation();
  }, true);
  listen(window, 'mouseup', event => {
    if (!gesture || event.button !== 2) return;
    const done = gesture; gesture = null;
    if (done.moved || done.cancelled || event.buttons !== 0 || event.timeStamp - done.time > model.HOLD || !context.on) return;
    if (Math.hypot(event.clientX - done.x, event.clientY - done.y) > model.MOVE) return;
    openBar(event.clientX, event.clientY, done.target);
  }, true);
  // While the bar is on, the right button of a stack cell opens no other menu.
  listen(window, 'contextmenu', event => {
    if (!context.on || !cellAt(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  listen(window, 'blur', () => { if (gesture) gesture.cancelled = true; });
  listen(window, 'pointerdown', event => { if (bar && !bar.contains(event.target)) closeBar(); }, true);
  listen(window, 'keydown', event => {
    if (event.key !== 'Escape') return;
    if (gesture) gesture.cancelled = true;
    if (bar) { event.stopImmediatePropagation(); event.preventDefault(); closeBar(); }
  }, true);

  // ── F.Leader (04-6) ──
  let spaceOn = false, leader = null;
  store.subscribe('fleaderSpace', value => { spaceOn = value === true; });
  ui.setting({ id: 'fleaderSpace', kind: 'check', label: 'Space opens F.Leader', order: 5, key: 'fleaderSpace' });
  ui.toolbarButton({ id: 'fLeader', label: 'F.Leader', title: 'Press Space, then an area letter, then a function letter.', order: 100,
    run: () => { if (leader) closeLeader(true); else openLeader(); } });
  function openLeader() {
    closeLeader(false);
    const node = element('section', '', document.body, 'kin-ux-fleader');
    node.setAttribute('role', 'dialog'); node.setAttribute('aria-label', 'F.Leader');
    leader = { node, area: null, page: 0, entries: [], opener: document.activeElement };
    paint();
  }
  function closeLeader(focus) {
    if (!leader) return;
    const { node, opener } = leader; leader = null; node.remove();
    if (focus && opener?.isConnected) opener.focus?.();
  }
  function enter(area) {
    const list = model.areas({ actions: window.KinViewerFeatures?.actions() || [], tools: ui.tools(), settings: window.KinViewerFeatures?.settings() || [], exclude: ['fLeader'] });
    leader.area = area; leader.page = 0; leader.entries = list[area];
    paint();
  }
  function paint() {
    const { node, area, page, entries } = leader, name = area && model.AREAS.find(([key]) => key === area)[1];
    const keys = model.leaderKeys(entries.length), pages = Math.max(1, Math.ceil(entries.length / model.KEYS.length));
    node.replaceChildren();
    element('h2', 'F.Leader' + (name ? ' › ' + name : ''), node);
    element('p', area ? 'Press a function letter. Backspace: back · Esc: close' + (pages > 1 ? ' · Tab: more keys (' + (page + 1) + '/' + pages + ')' : '')
      : 'Press an area letter. Esc: close', node);
    const list = element('ul', '', node);
    const rows = area ? entries.map((entry, index) => [keys[index], entry.label]).filter(([key]) => key.page === page).map(([key, label]) => [key.key, label])
      : model.AREAS;
    for (const [key, label] of rows) { const row = element('li', '', list); element('kbd', key.toUpperCase(), row); row.append(label); }
    if (area && !entries.length) element('li', 'No functions here yet', list);
  }
  function runEntry(entry) {
    if (entry.kind === 'tool') return ui.invoke(entry.id);
    if (entry.kind === 'feature') return window.KinViewerFeatures?.run(entry.id);
    if (entry.kind === 'setting') return window.KinViewerFeatures?.openSetting(entry.id);
    return window.kinViewerUXOpenSettings?.();
  }
  // Keys reach the panel before the toolbar's tool keys (viewer-ux-shortcuts.js): while it is open every key is its own,
  // so no tool key runs underneath; while it is closed only Space (when turned on, outside text fields and dialogs) opens it.
  const unlead = window.KinViewerUXShortcuts?.lead((event, refused) => {
    if (!leader) {
      if (event.key !== ' ' || !spaceOn || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || refused()) return false;
      openLeader(); return true;
    }
    // A held key's repeats are the panel's but change nothing: no area entered, no function run.
    if (event.repeat) return true;
    const key = event.key;
    if (key === 'Escape') closeLeader(true);
    else if (key === 'Backspace') { if (leader.area) { leader.area = null; leader.page = 0; leader.entries = []; paint(); } else closeLeader(true); }
    else if (key === 'Tab') {
      const pages = Math.max(1, Math.ceil(leader.entries.length / model.KEYS.length));
      if (leader.area && pages > 1) { leader.page = (leader.page + (event.shiftKey ? pages - 1 : 1)) % pages; paint(); }
    } else if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const letter = key.toLowerCase();
      if (!leader.area) { if (model.AREAS.some(([area]) => area === letter)) enter(letter); }
      else {
        const keys = model.leaderKeys(leader.entries.length);
        const at = keys.findIndex(item => item.page === leader.page && item.key === letter);
        if (at >= 0) { const entry = leader.entries[at]; closeLeader(false); runEntry(entry); }
      }
    }
    return true;
  });
  if (unlead) disposers.push(unlead);
  listen(window, 'pointerdown', event => {
    if (leader && !leader.node.contains(event.target) && !event.target.closest?.('[data-feature="fLeader"]')) closeLeader(false);
  }, true);

  return () => { closeLeader(false); closeBar(); gesture = null; for (const dispose of disposers.splice(0).reverse()) try { dispose(); } catch (error) { console.error(error); } };
});
