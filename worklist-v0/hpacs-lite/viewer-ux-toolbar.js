window.KinViewerUXToolbar = (() => {
  const frequent = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI'];
  const symbols = { WindowLevel: '◐', Pan: '✥', Zoom: '⌕', StackScroll: '↕', Length: '↔',
    Angle: '∠', EllipticalROI: '◯', RectangleROI: '□', ArrowAnnotate: '↗', invert: '◑', Cine: '▷', Crosshairs: '⊕' };
  function mount({ services, host: settingsHost, owner, live }) {
    const service = services.toolbarService;
    const original = service.getButtonSection('primary').map(button => button.id);
    const catalog = new Map(), removed = new Set();
    for (const id of original) {
      const definition = service.getButtons()[id], props = definition?.props || {};
      const items = props.items ? [props.primary, ...props.items].filter(Boolean) : [{ id, ...props }];
      // Layout and other custom renderers stay in the native section.
      if (!['ohif.radioGroup', 'ohif.splitButton'].includes(definition?.uiType) || !items.length || items.some(item => !item.commands)) continue;
      removed.add(id);
      for (const item of items) if (item.id && !catalog.has(item.id)) catalog.set(item.id, item);
    }
    if (!catalog.size) return null;
    let ended = false, loaded = false, saving = false, preferences, record, dragged, opener, loadSequence = 0;
    const abort = new AbortController(), initialOwner = JSON.stringify(owner());
    const active = () => !ended && live() && JSON.stringify(owner()) === initialOwner;
    const element = (tag, text, parent) => { const node = document.createElement(tag); if (text) node.textContent = text; parent?.append(node); return node; };
    const button = (text, parent, click) => { const node = element('button', text, parent); node.type = 'button'; node.onclick = click; return node; };
    const defaults = () => ({ version: 1, bar: frequent.filter(id => catalog.has(id)),
      shortcuts: Object.fromEntries([...catalog.keys()].map(id => [id, window.KinViewerUXShortcuts.defaults[id] || null])) });
    preferences = defaults();
    const toolbar = element('section'); toolbar.className = 'kin-ux-toolbar'; toolbar.dataset.kinUxOwned = '';
    toolbar.setAttribute('aria-label', 'Image Tools');
    const bar = element('div', '', toolbar); bar.className = 'kin-ux-tools-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Frequent Tools');
    const more = element('details', '', toolbar); more.className = 'kin-ux-more';
    const summary = element('summary', 'More', more); summary.title = '도구를 도구 모음과 More 사이로 끌어 옮길 수 있습니다.';
    const menu = element('div', '', more); menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'More Tools');
    const settings = element('section', '', settingsHost); settings.className = 'kin-ux-toolbar-settings';
    const edit = button('Viewer Settings', settings, () => openSettings());
    const status = element('span', '', settings); status.setAttribute('role', 'status');
    const retry = button('Reload Settings', settings, () => load()); retry.hidden = true;
    const dialog = element('dialog', '', document.body); dialog.className = 'kin-ux-settings';
    dialog.setAttribute('aria-label', 'Viewer Settings'); element('h2', 'Viewer Settings', dialog);
    element('p', '자주 쓰는 도구는 표시하고 나머지는 More에서 사용합니다. 단축키는 영문자·숫자 한 개이며, 입력 중에는 실행하지 않습니다. 설정은 계정에 저장됩니다.', dialog);
    const rows = element('div', '', dialog), inputs = new Map(), checks = new Map();
    const feedback = element('p', '', dialog); feedback.setAttribute('role', 'status');
    const close = () => { dialog.close(); opener?.isConnected && opener.focus(); };
    function fill(value) {
      rows.replaceChildren(); inputs.clear(); checks.clear();
      for (const [id, item] of catalog) {
        const row = element('label', '', rows); row.className = 'kin-ux-setting-row';
        const check = element('input', '', row); check.type = 'checkbox'; check.checked = value.bar.includes(id);
        check.setAttribute('aria-label', 'Show ' + label(item)); checks.set(id, check);
        element('span', label(item), row);
        const input = element('input', '', row); input.value = value.shortcuts[id] || ''; input.maxLength = 1;
        input.setAttribute('aria-label', label(item) + ' Shortcut'); input.autocomplete = 'off'; inputs.set(id, input);
        button('Clear', row, () => { input.value = ''; input.focus(); });
      }
    }
    function openSettings() { if (saving || !active()) return false; opener = document.activeElement; fill(preferences); feedback.textContent = loaded ? '' : status.textContent; dialog.showModal(); return true; }
    window.kinViewerUXOpenSettings = openSettings;
    button('Restore Defaults', dialog, () => fill(defaults()));
    const saveButton = button('Save', dialog, async () => {
      const used = new Set(), shortcuts = {};
      for (const [id, input] of inputs) {
        const value = input.value.trim().toLowerCase();
        if (value && (!/^[a-z0-9]$/.test(value) || used.has(value))) { feedback.textContent = '단축키는 중복 없이 영문자·숫자 한 개로 지정하세요.'; input.focus(); return; }
        shortcuts[id] = value || null; if (value) used.add(value);
      }
      const selected = [...checks].filter(([, check]) => check.checked).map(([id]) => id);
      const next = { version: 1, shortcuts, bar: [...preferences.bar.filter(id => selected.includes(id)), ...selected.filter(id => !preferences.bar.includes(id))] };
      if (await save(next)) close(); else feedback.textContent = status.textContent;
    });
    button('Cancel', dialog, close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    function label(item) { return item.label || item.title || item.tooltip || item.id; }
    function invoke(id) {
      if (!active() || document.body.classList.contains('kin-viewer-empty') || document.body.classList.contains('kin-patient-switching')) return false;
      const item = service.getButtonProps(id); if (!item || item.disabled) return false;
      const states = [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()];
      if (states.some(state => !state || state.busy)) return false;
      try {
        service.recordInteraction({ ...item, itemId: id });
        return true;
      } catch (error) { status.textContent = error.message || '현재 영상에서 도구를 사용할 수 없습니다.'; return false; }
    }
    function tool(id, parent) {
      const item = catalog.get(id), key = preferences.shortcuts[id];
      const node = button('', parent, () => { invoke(id); }); node.className = 'kin-ux-tool'; node.draggable = loaded && !saving;
      node.dataset.tool = id; node.setAttribute('aria-label', label(item));
      node.title = label(item) + (key ? ' · ' + key.toUpperCase() : ' · 단축키 미지정') + ' — 끌어서 도구 위치를 바꿀 수 있습니다.';
      if (key) node.setAttribute('aria-keyshortcuts', key.toUpperCase());
      const icon = element('span', symbols[id] || label(item).split(' ').map(word => word[0]).slice(0, 2).join(''), node); icon.setAttribute('aria-hidden', 'true'); icon.className = 'kin-ux-tool-icon';
      element('span', label(item), node); element('kbd', key?.toUpperCase() || '—', node);
      node.ondragstart = event => { if (saving || !loaded) { event.preventDefault(); return; } dragged = id; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move'; more.open = true; };
      node.ondragend = () => { dragged = null; };
      node.ondragover = event => { if (dragged) event.preventDefault(); };
      node.ondrop = event => { if (!dragged) return; event.preventDefault(); event.stopPropagation(); move(dragged, parent === bar, id); };
    }
    function render() {
      bar.replaceChildren(); menu.replaceChildren();
      preferences.bar.filter(id => catalog.has(id)).forEach(id => tool(id, bar));
      [...catalog.keys()].filter(id => !preferences.bar.includes(id)).forEach(id => tool(id, menu));
      if (!bar.children.length) element('span', '도구를 여기로 끌어 놓으세요.', bar);
      if (!menu.children.length) element('span', '도구를 여기로 끌어 놓으세요.', menu);
      edit.disabled = saving; saveButton.disabled = !loaded || saving;
      refreshState();
    }
    function refreshState() {
      for (const node of toolbar.querySelectorAll('[data-tool]')) {
        const props = service.getButtonProps(node.dataset.tool);
        node.disabled = !props || !!props.disabled;
        if (props?.isActive !== undefined) node.setAttribute('aria-pressed', String(!!props.isActive));
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
      loaded = false; render(); status.textContent = '계정 설정을 불러오는 중…';
      try {
        const data = await request(); if (!active() || sequence !== loadSequence) return;
        record = data; preferences = data.viewerSettings || defaults(); loaded = true; retry.hidden = true;
        status.textContent = '계정 설정 · 다른 PC에서도 적용됩니다.';
      } catch (error) { if (active() && sequence === loadSequence) { status.textContent = error.message; retry.hidden = false; } }
      if (active() && sequence === loadSequence) render();
    }
    async function save(next) {
      if (!loaded || saving || !active()) return false;
      saving = true; render(); status.textContent = '계정에 저장 중…';
      try {
        const data = await request({ method: 'PUT', body: JSON.stringify({ expectedOwner: record.owner, revision: record.revision, viewerSettings: next }) });
        if (!active()) return false;
        record = data; preferences = data.viewerSettings; status.textContent = '계정에 저장했습니다.'; retry.hidden = true; return true;
      } catch (error) { if (active()) { status.textContent = error.message; retry.hidden = false; } return false; }
      finally { saving = false; if (active()) render(); }
    }
    const retained = original.filter(id => !removed.has(id));
    service.clearButtonSection('primary'); service.createButtonSection('primary', retained);
    const subscription = service.subscribe(service.EVENTS.TOOL_BAR_MODIFIED, refreshState);
    function focusTools() {
      if (!active() || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) return false;
      const first = bar.querySelector('button:not(:disabled)') || summary;
      first.focus(); first.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true;
    }
    // Reuse the existing navigation bindings and their modal/session guards.
    // That controller also serves the Image Tools button and embedded focus requests.
    window.kinViewerUXFocusTools = focusTools;
    const shortcuts = window.KinViewerUXShortcuts.mount({ getBindings: () => preferences.shortcuts, invoke, allowed: active });
    function refresh() {
      const strip = document.querySelector('.kin-viewer-series-strip');
      if (!toolbar.isConnected && strip) strip.before(toolbar);
    }
    refresh(); const observer = new MutationObserver(refresh); observer.observe(document.getElementById('root'), { childList: true, subtree: true });
    render(); load();
    return { dispose() {
      if (ended) return; ended = true; abort.abort(); observer.disconnect(); shortcuts.dispose(); toolbar.remove(); settings.remove(); dialog.remove();
      subscription.unsubscribe();
      if (window.kinViewerUXFocusTools === focusTools) delete window.kinViewerUXFocusTools;
      if (window.kinViewerUXOpenSettings === openSettings) delete window.kinViewerUXOpenSettings;
      if (JSON.stringify(service.getButtonSection('primary').map(button => button.id)) === JSON.stringify(retained)) {
        service.clearButtonSection('primary'); service.createButtonSection('primary', original);
      }
    } };
  }
  return { mount };
})();
