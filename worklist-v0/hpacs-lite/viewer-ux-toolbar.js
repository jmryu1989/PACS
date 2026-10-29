window.KinViewerUXToolbar = (() => {
  const frequent = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI'];
  const symbols = { WindowLevel: '◐', Pan: '✥', Zoom: '⌕', StackScroll: '↕', Length: '↔',
    Angle: '∠', EllipticalROI: '◯', RectangleROI: '□', ArrowAnnotate: '↗', invert: '◑', Cine: '▷', Crosshairs: '⊕',
    flipHorizontal: '⇆', flipVertical: '⇅', 'rotate-left': '↺', 'rotate-right': '↻' };
  // The stock More Tools flips and turns one way each; F8 asks for both ways.
  // A left turn is three right quarter turns: the stock counter-clockwise
  // command asks a stack at 0 degrees for -90, which the viewport ignores.
  const companions = [['flipHorizontal', 'flipVertical', 'Flip Vertical', 'Flip Vertically', 'flipViewportVertical'],
    ['rotate-right', 'rotate-left', 'Rotate Left', 'Rotate -90', { commandName: 'rotateViewportCW', commandOptions: { rotation: 270 } }]];
  // Version 1 offered no key for the flips and turns, so a null there is the
  // old default rather than a cleared choice; version 2 gives them the F8 keys.
  const turns = ['flipHorizontal', 'flipVertical', 'rotate-left', 'rotate-right'];
  const upgrade = value => value?.version !== 1 ? value : { ...value, version: 2, shortcuts: { ...value.shortcuts,
    ...Object.fromEntries(turns.filter(id => value.shortcuts[id] == null).map(id => [id, window.KinViewerUXShortcuts.defaults[id]])) } };
  let cached = null, preparedFailure = null;
  async function prepare(session) {
    if (session.state() === 'unconfirmed') await session.decide();
    if (!session.writer() || session.ended()) return;
    const owner = JSON.stringify(session.owner());
    cached = null; preparedFailure = null;
    try {
      const response = await fetch('/api/workspace-shortcuts', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
      if (!response.ok) throw new Error('설정을 불러오지 못했습니다. 연결을 확인한 뒤 다시 불러오세요.');
      const record = await response.json();
      if (JSON.stringify(record.owner) !== owner) throw new Error('계정이 변경되었습니다. 뷰어를 다시 여세요.');
      if (!session.ended() && JSON.stringify(session.owner()) === owner) cached = record;
    } catch (error) {
      // Refusal and account messages are written for readers; fetch, timeout and
      // JSON failures carry browser text, which the connection guidance replaces.
      if (!session.ended() && JSON.stringify(session.owner()) === owner)
        preparedFailure = { owner, message: error?.constructor === Error ? error.message : '설정을 불러오지 못했습니다. 연결을 확인한 뒤 다시 불러오세요.' };
    }
    window.kinMammographyHanging?.registerPreferenceProvider(() =>
      JSON.stringify(cached?.owner) === JSON.stringify(session.owner()) ? cached?.viewerSettings?.mammography || { layout: 'compare', kind: null } : null);
  }
  function mount({ services, session }) {
    const owner = () => session.owner();
    const service = services.toolbarService;
    const original = service.getButtonSection('primary').map(button => button.id);
    const catalog = new Map(), removed = new Set();
    let ended = false, loaded = false, saving = false, preferences, record, dragged, opener, loadSequence = 0;
    let initialOwner = JSON.stringify(owner()), syncing = false, queued = false;
    const abort = new AbortController();
    const active = () => !ended && !session.ended() && (initialOwner === 'null' || JSON.stringify(owner()) === initialOwner);
    const element = (tag, text, parent) => { const node = document.createElement(tag); if (text) node.textContent = text; parent?.append(node); return node; };
    const button = (text, parent, click) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; return node; };
    const keys = window.KinViewerUXShortcuts;
    const defaults = () => ({ version: 2, bar: [...frequent],
      shortcuts: { ...Object.fromEntries([...catalog.keys()].map(id => [id, null])), ...keys.defaults } });
    record = cached && JSON.stringify(cached.owner) === initialOwner ? cached : null;
    loaded = !!record;
    preferences = upgrade(record?.viewerSettings) || defaults();
    const toolbar = element('section'); toolbar.className = 'kin-ux-toolbar'; toolbar.dataset.kinUxOwned = '';
    toolbar.setAttribute('aria-label', 'Image Tools');
    const bar = element('div', '', toolbar); bar.className = 'kin-ux-tools-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Frequent Tools');
    const more = element('details', '', toolbar); more.className = 'kin-ux-more';
    const summary = element('summary', 'More', more); summary.title = '도구를 도구 모음과 More 사이로 끌어 옮길 수 있습니다.';
    const menu = element('div', '', more); menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'More Tools');
    const dismissMore = event => {
      if (event.type === 'keydown') {
        if (event.key !== 'Escape' || !more.open) return;
        more.open = false; summary.focus();
      } else if (!more.contains(event.target)) more.open = false;
    };
    document.addEventListener('pointerdown', dismissMore, { capture: true, signal: abort.signal });
    document.addEventListener('keydown', dismissMore, { capture: true, signal: abort.signal });
    const settings = element('section', '', toolbar); settings.className = 'kin-ux-toolbar-settings';
    const edit = button('Viewer Settings', settings, () => openSettings());
    const status = element('span', '', settings); status.setAttribute('role', 'status');
    const retry = button('Reload Settings', settings, () => load()); retry.hidden = true;
    const dialog = element('dialog', '', document.body); dialog.className = 'kin-ux-settings';
    dialog.setAttribute('aria-label', 'Viewer Settings'); element('h2', 'Viewer Settings', dialog);
    element('p', '자주 쓰는 도구는 표시하고 나머지는 More에서 사용합니다. 단축키는 영문자·숫자 한 개 또는 Shift+영문자이며, 입력 중에는 실행하지 않습니다. 설정은 계정에 저장됩니다.', dialog);
    const rows = element('div', '', dialog), inputs = new Map(), checks = new Map();
    const mgSection = element('fieldset', '', dialog), mgInputs = new Map();
    element('legend', 'Mammography', mgSection);
    element('p', '유방영상 배치와 영상 종류를 계정에 저장합니다. 비교할 이전 검사가 없으면 현재 검사만 표시합니다.', mgSection);
    for (const [key, title, options] of [
      ['layout', 'MG Layout', [['compare', 'Current vs Prior'], ['current', 'Current']]],
      ['kind', 'MG Image Type', [['', 'Automatic'], ['conventional', 'Conventional'], ['generated2d', 'Synthetic 2D'], ['dbt', 'DBT']]],
    ]) {
      const row = element('label', title, mgSection), select = element('select', '', row);
      select.setAttribute('aria-label', title);
      for (const [value, title] of options) { const option = element('option', title, select); option.value = value; }
      mgInputs.set(key, select);
    }
    const arrangement = { viewOrder: 'CC-MLO', sideOrder: 'R-L', priorPosition: 'right', currentColumns: 2, compareColumns: 4 };
    for (const [key, title, options] of [
      ['viewOrder', 'MG View Order', [['CC-MLO', 'CC / MLO'], ['MLO-CC', 'MLO / CC']]],
      ['sideOrder', 'MG Breast Order', [['R-L', 'Right / Left'], ['L-R', 'Left / Right']]],
      ['priorPosition', 'MG Prior Position', [['right', 'Right'], ['left', 'Left'], ['bottom', 'Bottom'], ['top', 'Top']]],
      ['currentColumns', 'MG Current Grid', [[2, '2 × 2'], [4, '1 × 4'], [1, '4 × 1']]],
      ['compareColumns', 'MG Comparison Grid', [[4, '2 × 4'], [2, '4 × 2'], [8, '1 × 8'], [1, '8 × 1']]],
    ]) {
      const row = element('label', title, mgSection), select = element('select', '', row);
      select.setAttribute('aria-label', title);
      for (const [value, title] of options) { const option = element('option', title, select); option.value = value; }
      mgInputs.set(key, select);
    }
    function updateMGGridChoices() {
      const vertical = ['top', 'bottom'].includes(mgInputs.get('priorPosition').value);
      const grid = mgInputs.get('compareColumns');
      for (const option of grid.options) option.disabled = vertical ? option.value === '8' : option.value === '1';
      if (grid.selectedOptions[0]?.disabled) grid.value = vertical ? '4' : '2';
    }
    mgInputs.get('priorPosition').onchange = updateMGGridChoices;
    const hanging = window.KinViewerHangingSettings, hangingInputs = new Map();
    const hangingSection = element('fieldset', '', dialog); element('legend', 'Hanging & Layout', hangingSection);
    element('p', '모달리티별 기본 배치와 비교 위치를 계정에 저장합니다. 워크리스트에서 이전 검사와 함께 여는 비교에도 적용됩니다. Automatic은 기존 Hanging Protocol의 배치를 사용합니다. Hanging Protocol 편집기에서 지정한 프로토콜과 유방영상 배치는 유지됩니다. Series 메뉴에서 비교 시리즈를 직접 바꿀 수 있습니다.', hangingSection);
    for (const modality of hanging.modalities) {
      const group = element('fieldset', '', hangingSection); element('legend', modality, group);
      const fields = new Map(); hangingInputs.set(modality, fields);
      for (const [key, title, options] of [
        ['layout', 'Default Layout', [['automatic', 'Automatic'], ['1x1', '1 × 1'], ['1x2', '1 × 2'], ['2x1', '2 × 1'], ['2x2', '2 × 2'], ['custom', 'Custom']]],
        ['priorPosition', 'Prior Position', [['right', 'Right'], ['left', 'Left'], ['bottom', 'Bottom'], ['top', 'Top']]],
        ['seriesMatch', 'Compare Series', [['similar', 'Similar Series'], ['number', 'Same Series Number'], ['largest', 'Most Images']]],
      ]) {
        const row = element('label', title, group), select = element('select', '', row);
        select.setAttribute('aria-label', modality + ' ' + title);
        for (const [value, title] of options) { const option = element('option', title, select); option.value = value; }
        fields.set(key, select);
        if (key === 'layout') {
          const custom = element('span', '', row); custom.hidden = true;
          for (const dimension of ['Rows', 'Columns']) {
            const input = element('input', '', custom); input.type = 'number'; input.min = '1'; input.step = '1';
            input.setAttribute('aria-label', modality + ' Layout ' + dimension); fields.set(dimension.toLowerCase(), input);
          }
          select.onchange = () => { custom.hidden = select.value !== 'custom'; };
        }
      }
    }
    const mammography = value => value?.mammography || { layout: 'compare', kind: null };
    const generalHanging = hanging.mount(services, () => preferences);
    const layoutStatus = element('span', ' · Display Fit', settings); layoutStatus.hidden = true;
    layoutStatus.title = '현재 기기의 표시 한계에 맞춰 영상 영역의 폭을 조정했습니다. 배치 설정은 유지됩니다.';
    const sizing = hanging.mountSizing(services, fitting => { layoutStatus.hidden = !fitting; });
    let appliedHanging = JSON.stringify(preferences.hanging);
    window.kinViewerHangingPreference = modality => hanging.get(preferences, modality);
    let appliedMammography = null, pendingMammography = null, requestedMammography = null;
    function applyMammography(force = false) {
      if (!active() || !loaded || pendingMammography || saving && !force) return;
      const value = mammography(preferences), signature = JSON.stringify(value);
      if (force || appliedMammography !== signature) {
        if (window.kinMammographyHanging?.set(value, { accountDefault: true })) appliedMammography = signature;
      }
    }
    function saveMammography() {
      if (!saving && !pendingMammography) requestedMammography = null;
      if (!pendingMammography || saving || !active() || !loaded) return;
      const value = pendingMammography; pendingMammography = null;
      save({ ...preferences, mammography: value });
    }
    // The native hook reports the effective layout (Current when no prior exists).
    // Capture the reader's choice before that fallback, so changing image type does
    // not replace their account's comparison default or another queued choice.
    document.addEventListener('change', event => {
      const select = event.target;
      if (!active() || !select.closest?.('#kin-mammography-hanging')) return;
      const key = { 'MG Layout': 'layout', 'MG Image Type': 'kind' }[select.getAttribute('aria-label')];
      if (key) requestedMammography = { ...(requestedMammography || mammography(preferences)), [key]: select.value || null };
    }, { capture: true, signal: abort.signal });
    window.addEventListener('kin-mammography-hanging-changed', event => {
      if (!active() || !session.writer()) return;
      if (!loaded) { pendingMammography = { ...(requestedMammography || event.detail) }; return; }
      pendingMammography = { ...(requestedMammography || event.detail) };
      appliedMammography = JSON.stringify(pendingMammography);
      saveMammography();
    }, { signal: abort.signal });
    const feedback = element('p', '', dialog); feedback.setAttribute('role', 'status');
    const close = () => { dialog.close(); opener?.isConnected && opener.focus(); };
    function fill(value) {
      rows.replaceChildren(); inputs.clear(); checks.clear();
      for (const [key, input] of mgInputs) input.value = mammography(value)[key] ?? arrangement[key] ?? '';
      updateMGGridChoices();
      for (const [modality, fields] of hangingInputs) {
        const stored = hanging.get(value, modality), layout = fields.get('layout');
        const custom = ![...layout.options].some(option => option.value === stored.layout);
        layout.value = custom ? 'custom' : stored.layout; layout.onchange();
        const [rows, columns] = stored.layout === 'automatic' ? [1, 1] : stored.layout.split('x');
        fields.get('rows').value = rows; fields.get('columns').value = columns;
        for (const key of ['priorPosition', 'seriesMatch']) fields.get(key).value = stored[key];
      }
      for (const [id, item] of catalog) {
        const row = element('label', '', rows); row.className = 'kin-ux-setting-row';
        const check = element('input', '', row); check.type = 'checkbox'; check.checked = value.bar.includes(id);
        check.setAttribute('aria-label', 'Show ' + label(item)); checks.set(id, check);
        element('span', label(item), row);
        const input = element('input', '', row); input.value = keys.display(value.shortcuts[id]); input.maxLength = 7;
        input.setAttribute('aria-label', label(item) + ' Shortcut'); input.autocomplete = 'off'; inputs.set(id, input);
        button('Clear', row, () => { input.value = ''; input.focus(); });
      }
    }
    let pointer = null, screenDetails = null;
    const trackPointer = event => { if (event.target.closest?.('[data-cy=viewport-pane]')) pointer = { x: event.clientX, y: event.clientY }; };
    window.addEventListener('pointerdown', trackPointer, true);
    // Reuse already granted window-management access; never prompt at viewer open.
    navigator.permissions?.query({ name: 'window-management' }).then(permission => {
      if (permission.state === 'granted') return window.getScreenDetails?.();
    }).then(value => { if (!ended) screenDetails = value; }).catch(() => {});
    function positionSettings() {
      const id = services.viewportGridService.getActiveViewportId();
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
      const rect = viewport?.element?.getBoundingClientRect();
      const inCell = rect && pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
      const anchor = inCell ? pointer : rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
      const screens = screenDetails?.screens || [window.screen];
      const screenPoint = anchor;
      const monitor = screens.find(s => screenPoint.x + screenX >= (s.availLeft || 0) && screenPoint.x + screenX < (s.availLeft || 0) + s.availWidth &&
        screenPoint.y + screenY >= (s.availTop || 0) && screenPoint.y + screenY < (s.availTop || 0) + s.availHeight) || screenDetails?.currentScreen || window.screen;
      const left = Math.max(0, (monitor.availLeft || 0) - screenX), top = Math.max(0, (monitor.availTop || 0) - screenY);
      const right = Math.min(innerWidth, (monitor.availLeft || 0) + monitor.availWidth - screenX);
      const bottom = Math.min(innerHeight, (monitor.availTop || 0) + monitor.availHeight - screenY);
      dialog.style.maxWidth = Math.max(0, right - left) + 'px'; dialog.style.maxHeight = Math.max(0, bottom - top) + 'px';
      dialog.style.margin = '0'; dialog.style.position = 'fixed';
      const box = dialog.getBoundingClientRect();
      dialog.style.left = Math.max(left, Math.min(anchor.x - box.width / 2, right - box.width)) + 'px';
      dialog.style.top = Math.max(top, Math.min(anchor.y - box.height / 2, bottom - box.height)) + 'px';
    }
    function openSettings() { if (!session.writer() || saving || !active()) return false; more.open = false; opener = document.activeElement; fill(preferences); feedback.textContent = loaded ? '' : status.textContent; dialog.showModal(); positionSettings(); return true; }
    window.kinViewerUXOpenSettings = openSettings;
    button('Restore Defaults', dialog, () => fill(defaults()));
    const saveButton = button('Save', dialog, async () => {
      const shortcuts = { ...preferences.shortcuts };
      const used = new Set(Object.entries(shortcuts).filter(([id, key]) => !inputs.has(id) && key).map(([, key]) => key));
      for (const [id, input] of inputs) {
        const value = input.value.trim() ? keys.parse(input.value) : '';
        if (value === null || value && used.has(value)) { feedback.textContent = '단축키는 중복 없이 영문자·숫자 한 개 또는 Shift+영문자로 지정하세요.'; input.focus(); return; }
        shortcuts[id] = value || null; if (value) used.add(value);
      }
      const selected = [...checks].filter(([, check]) => check.checked).map(([id]) => id);
      const next = { ...preferences, version: 2, shortcuts, bar: [...preferences.bar.filter(id => !checks.has(id) || selected.includes(id)), ...selected.filter(id => !preferences.bar.includes(id))] };
      next.mammography = { layout: mgInputs.get('layout').value, kind: mgInputs.get('kind').value || null };
      for (const [key, fallback] of Object.entries(arrangement)) {
        const value = typeof fallback === 'number' ? Number(mgInputs.get(key).value) : mgInputs.get(key).value;
        if (value !== fallback) next.mammography[key] = value;
      }
      next.hanging = { ...preferences.hanging };
      for (const [modality, fields] of hangingInputs) {
        const rows = Number(fields.get('rows').value), columns = Number(fields.get('columns').value);
        let layout = fields.get('layout').value;
        if (layout === 'custom') {
          if (![rows, columns, rows * columns].every(v => Number.isSafeInteger(v) && v > 0)) {
            feedback.textContent = '행과 열은 양의 정수로 지정하세요.'; fields.get('rows').focus(); return;
          }
          layout = rows + 'x' + columns;
        }
        const value = { layout, priorPosition: fields.get('priorPosition').value, seriesMatch: fields.get('seriesMatch').value };
        if (preferences.hanging?.[modality] || Object.entries(value).some(([key, field]) => field !== hanging.defaults[key]))
          next.hanging[modality] = value;
      }
      if (!Object.keys(next.hanging).length) delete next.hanging;
      if (await save(next)) close(); else feedback.textContent = status.textContent;
    });
    button('Cancel', dialog, close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    function label(item) { return item.label || item.title || item.tooltip || item.id; }
    // A companion follows its stock sibling's evaluated availability.
    function props(id) {
      const item = catalog.get(id);
      if (!item?.sibling) return service.getButtonProps(id);
      const sibling = service.getButtonProps(item.sibling);
      return sibling && { id, label: item.label, tooltip: item.tooltip, commands: item.commands, disabled: !!sibling.disabled };
    }
    function invoke(id) {
      if (!active() || document.body.classList.contains('kin-viewer-empty') || document.body.classList.contains('kin-patient-switching')) return false;
      const item = props(id); if (!item || item.disabled) return false;
      const states = [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()];
      if (states.some(state => state?.busy)) {
        status.textContent = '영상 작업을 불러오는 중입니다. 완료 후 도구를 다시 선택하세요.';
        services.uiNotificationService?.show({ title: 'Image Tools', message: status.textContent, type: 'info' });
        return false;
      }
      try {
        if (window.kinViewerStackMouse?.deselect(id)) { refreshState(); return true; }
        service.recordInteraction({ ...item, itemId: id });
        return true;
      } catch (error) { status.textContent = error.message || '현재 영상에서 도구를 사용할 수 없습니다.'; return false; }
    }
    function tool(id, parent) {
      const item = catalog.get(id), key = preferences.shortcuts[id];
      const node = button('', parent, () => { more.open = false; invoke(id); }); node.className = 'kin-ux-tool'; node.draggable = loaded && !saving;
      node.dataset.tool = id; node.setAttribute('aria-label', label(item));
      node.title = label(item) + (key ? ' · ' + keys.display(key) : ' · 단축키 미지정') + ' — 끌어서 도구 위치를 바꿀 수 있습니다.';
      if (key) node.setAttribute('aria-keyshortcuts', keys.display(key));
      const icon = element('span', symbols[id] || label(item).split(' ').map(word => word[0]).slice(0, 2).join(''), node); icon.setAttribute('aria-hidden', 'true'); icon.className = 'kin-ux-tool-icon';
      element('span', label(item), node); element('kbd', keys.display(key) || '—', node);
      node.ondragstart = event => { if (saving || !loaded) { event.preventDefault(); return; } dragged = id; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; more.open = true; };
      node.ondragend = () => { dragged = null; };
      node.ondragover = event => { if (dragged) event.preventDefault(); };
      node.ondrop = event => { if (!dragged) return; event.preventDefault(); event.stopPropagation(); move(dragged, parent === bar, id); };
    }
    function render() {
      applyMammography();
      const signature = JSON.stringify(preferences.hanging);
      if (loaded && signature !== appliedHanging) { appliedHanging = signature; generalHanging.apply(); }
      bar.replaceChildren(); menu.replaceChildren();
      preferences.bar.filter(id => catalog.has(id)).forEach(id => tool(id, bar));
      [...catalog.keys()].filter(id => !preferences.bar.includes(id)).forEach(id => tool(id, menu));
      if (!bar.children.length) element('span', '도구를 여기로 끌어 놓으세요.', bar);
      if (!menu.children.length) element('span', '도구를 여기로 끌어 놓으세요.', menu);
      edit.hidden = !session.writer();
      edit.disabled = saving; saveButton.disabled = !loaded || saving;
      refreshState();
    }
    function refreshState() {
      for (const node of toolbar.querySelectorAll('[data-tool]')) {
        const state = props(node.dataset.tool);
        node.disabled = !state || !!state.disabled;
        if (state?.isActive !== undefined) node.setAttribute('aria-pressed', String(!!state.isActive));
        else node.removeAttribute('aria-pressed');
      }
    }
    function move(id, visible, before) {
      if (!loaded || saving || !catalog.has(id) || id === before) return;
      const next = { ...preferences, bar: preferences.bar.filter(value => value !== id) };
      if (visible) { const index = next.bar.indexOf(before); next.bar.splice(index < 0 ? next.bar.length : index, 0, id); }
      dragged = null; save(next);
    }
    for (const [target, visible] of [[bar, true], [more, false]]) {
      target.ondragover = event => { if (dragged) { event.preventDefault(); if (!visible) more.open = true; } };
      target.ondrop = event => { if (!dragged) return; event.preventDefault(); move(dragged, visible); };
    }
    async function request(options) {
      const response = await fetch('/api/workspace-shortcuts', { credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        ...options, headers: { 'X-KIN-CSRF': '1', 'Content-Type': 'application/json' } }).catch(error => {
        if (error.name === 'AbortError') throw error;
        throw new Error('설정을 불러오거나 저장하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.');
      });
      if (window.KinSessionTransport.refusal(response)) throw window.KinSessionTransport.responseError(response);
      const data = await response.json().catch(() => { throw new Error('계정 설정 응답을 읽지 못했습니다. 다시 불러오세요.'); });
      if (!response.ok) throw new Error(data.message || '설정을 저장하지 못했습니다. 다시 불러온 뒤 시도하세요.');
      if (JSON.stringify(data.owner) !== initialOwner) throw new Error('계정이 변경되었습니다. 뷰어를 다시 여세요.');
      return data;
    }
    async function load() {
      if (!active() || saving) return;
      const sequence = ++loadSequence;
      // Keep the cached bar and bindings, but wait for the current revision before editing.
      loaded = false; render();
      if (session.state() === 'unconfirmed') await session.decide();
      if (!active() || sequence !== loadSequence) return;
      if (!session.writer()) { status.textContent = ''; retry.hidden = true; render(); return; }
      initialOwner = JSON.stringify(owner());
      status.textContent = '계정 설정을 불러오는 중…';
      try {
        const data = await request(); if (!active() || sequence !== loadSequence) return;
        record = cached = data; preparedFailure = null; preferences = upgrade(data.viewerSettings) || defaults(); loaded = true; retry.hidden = true;
        status.textContent = '계정 설정 · 다른 PC에서도 적용됩니다.';
      } catch (error) { if (active() && sequence === loadSequence) { status.textContent = error.message; retry.hidden = false; } }
      if (active() && sequence === loadSequence) { render(); saveMammography(); }
    }
    async function save(next) {
      if (!loaded || saving || !active()) return false;
      saving = true; render(); status.textContent = '계정에 저장 중…';
      try {
        const data = await request({ method: 'PUT', body: JSON.stringify({ expectedOwner: record.owner, revision: record.revision, viewerSettings: next }) });
        if (!active()) return false;
        record = cached = data; preferences = data.viewerSettings; status.textContent = '계정에 저장했습니다.'; retry.hidden = true; return true;
      } catch (error) {
        pendingMammography = requestedMammography = null;
        if (active()) { status.textContent = error.message; retry.hidden = false; applyMammography(true); }
        return false;
      }
      finally { saving = false; if (active()) { render(); saveMammography(); } }
    }
    const nativeStyle = element('style', '', document.head);
    function rebuild() {
      if (ended || syncing) return;
      queued = false; syncing = true;
      try {
        const present = service.getButtonSection('primary').map(button => button.id);
        for (const id of present) if (!original.includes(id)) original.push(id);
        const next = new Map(); removed.clear();
        for (const id of original) {
          const definition = service.getButtons()[id], props = definition?.props || {};
          const items = props.items ? [props.primary, ...props.items].filter(Boolean) : [{ id, ...props }];
          if (!['ohif.radioGroup', 'ohif.splitButton'].includes(definition?.uiType) || !items.length || items.some(item => !item.commands)) continue;
          removed.add(id);
          for (const item of items) if (item.id && !next.has(item.id)) next.set(item.id, item);
        }
        // Companions stay in this toolbar only: registering buttons in the shared
        // toolbar state during mode entry would notify every stock listener.
        for (const [sibling, id, name, tooltip, commands] of companions) {
          if (!next.has(sibling) || next.has(id)) continue;
          const entries = [...next]; entries.splice(entries.findIndex(([key]) => key === sibling) + 1, 0, [id, { id, label: name, tooltip, commands, sibling }]);
          next.clear(); entries.forEach(([key, value]) => next.set(key, value));
        }
        const changed = JSON.stringify([...next].map(([id, item]) => [id, label(item)])) !== JSON.stringify([...catalog].map(([id, item]) => [id, label(item)]));
        catalog.clear(); next.forEach((item, id) => catalog.set(id, item));
        // Leave native sections intact: the role policy restores their authoring
        // tools after /me. Hide only the controls replaced by this toolbar.
        nativeStyle.textContent = [...removed].map(id => {
          const key = CSS.escape(id);
          return 'body.kin-viewer-ux #root .relative.flex.justify-center > div:has([data-cy="' + key + '"], [data-cy^="' + key + '-split-button-"]) { display: none; }';
        }).join('\n');
        if (changed) render(); else refreshState();
      } finally { syncing = false; }
    }
    const subscription = service.subscribe(service.EVENTS.TOOL_BAR_MODIFIED, () => {
      if (!syncing && !queued) { queued = true; queueMicrotask(rebuild); }
    });
    rebuild();
    function focusTools() {
      if (!active() || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) return false;
      const first = bar.querySelector('button:not(:disabled)') || summary;
      first.focus(); first.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true;
    }
    // Reuse the existing navigation bindings and their modal/session guards.
    // That controller also serves the Image Tools button and embedded focus requests.
    window.kinViewerUXFocusTools = focusTools;
    function refresh() {
      if (toolbar.isConnected) return;
      // The shell reserves this toolbar's row when it places the strip, so the
      // image area does not move when the toolbar arrives after the tech-note
      // connection; without that row the toolbar stands above the strip.
      const slot = document.querySelector('.kin-ux-toolbar-slot'), strip = document.querySelector('.kin-viewer-series-strip');
      if (slot) slot.replaceChildren(toolbar); else if (strip) strip.before(toolbar);
    }
    refresh(); const observer = new MutationObserver(refresh); observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    render();
    if (!loaded) {
      // Expose the pre-registration read failure instead of silently reading twice.
      if (preparedFailure?.owner === initialOwner) { status.textContent = preparedFailure.message; retry.hidden = false; }
      else load();
    }
    return { invoke, bindings: () => preferences.shortcuts, dispose() {
      if (ended) return; ended = true; abort.abort(); observer.disconnect(); window.removeEventListener('pointerdown', trackPointer, true); toolbar.remove(); settings.remove(); dialog.remove();
      subscription.unsubscribe();
      sizing.dispose(); generalHanging.dispose(); delete window.kinViewerHangingPreference;
      if (window.kinViewerUXFocusTools === focusTools) delete window.kinViewerUXFocusTools;
      if (window.kinViewerUXOpenSettings === openSettings) delete window.kinViewerUXOpenSettings;
      nativeStyle.remove();
    } };
  }
  return { mount, prepare, clear() { cached = null; preparedFailure = null; } };
})();
