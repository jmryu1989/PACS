/* Move existing study tools into a non-modal drawer without losing their state or the opener's focus. */
(function (root) {
  'use strict';
  // Text Size steps Normal / Large / Larger (pilot D1160). The moved tools keep their own pixel font sizes, so the
  // tabs and tab contents are zoomed as a whole; the header, the report editor and the worklist never are.
  const TEXT_SCALES = Object.freeze([1, 1.2, 1.4]);
  const TEXT_LABELS = ['Normal', 'Large', 'Larger'];
  function create(app) {
    const host = app.host, doc = host?.ownerDocument;
    const names = ['images', 'info', 'templates'], labels = ['Images', 'Info', 'Templates'];
    const validAvailable = value => Array.isArray(value) && value.every(name => names.includes(name));
    if (app.available !== undefined && !validAvailable(app.available)) throw new TypeError('Invalid available tabs');
    let available = names.filter(name => (app.available ?? names).includes(name));
    const resolve = value => typeof value === 'function' ? value() : value;
    if (!doc || !host.id || !app.fallbackFocus) throw new TypeError('Study Panel requires a named host and fallbackFocus');
    const contents = names.map(name => resolve(app.content?.[name]));
    if (contents.some(el => !el || el.nodeType !== 1 || el.ownerDocument !== doc || el.contains(host))
        || contents.some((el, i) => contents.some((other, j) => i !== j && el.contains(other)))) {
      throw new TypeError('Study Panel requires three separate content elements');
    }
    const listeners = [], moved = [], tabs = [], panels = [];
    let state = { open: false, tab: available.includes('info') ? 'info' : available[0] || 'info' }, opener = resolve(app.opener) || null, destroyed = false, composing = false;
    let movingFocus = false;
    const node = (tag, text, parent) => {
      const el = doc.createElement(tag); if (text) el.textContent = text;
      if (parent) parent.append(el); return el;
    };
    const listen = (el, type, fn) => { el.addEventListener(type, fn); listeners.push(() => el.removeEventListener(type, fn)); };
    const drawer = node('aside', '', host); drawer.className = 'study-panel';
    drawer.setAttribute('role', 'complementary');
    drawer.id = host.id + '-study-panel'; drawer.setAttribute('aria-label', 'Study Panel');
    const header = node('div', '', drawer); header.className = 'study-panel-head';
    node('h2', 'Study Panel', header);
    const tools = node('div', '', header); tools.className = 'study-panel-tools';
    const textSize = node('select', '', tools); textSize.setAttribute('aria-label', 'Text Size');
    textSize.title = 'Study Panel 글자 크기입니다(기본·크게·더 크게). 판독문과 워크리스트 글자는 바뀌지 않습니다.';
    TEXT_LABELS.forEach((label, step) => { node('option', label, textSize).value = String(step); });
    const resetButton = node('button', 'Default', tools); resetButton.type = 'button';
    resetButton.title = '이 방향(가로·세로) 화면의 Study Panel 크기와 글자 크기를 기본값으로 되돌립니다.';
    const closeButton = node('button', 'Close', tools); closeButton.type = 'button';
    const tablist = node('div', '', drawer); tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Study Panel'); tablist.setAttribute('aria-orientation', 'horizontal');
    for (const [i, name] of names.entries()) {
      const tab = node('button', labels[i], tablist); tab.type = 'button';
      tab.id = drawer.id + '-tab-' + name; tab.setAttribute('role', 'tab');
      const panel = node('section', '', drawer); panel.id = drawer.id + '-panel-' + name;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
      tab.setAttribute('aria-controls', panel.id); tabs.push(tab); panels.push(panel);
      const content = contents[i], marker = doc.createComment('Study Panel content return');
      if (content.parentNode) content.parentNode.insertBefore(marker, content);
      moved.push({ content, marker }); panel.append(content);
      listen(tab, 'click', () => select(name));
    }
    // The edge facing the work area. The page owns the geometry: it says which axis this edge resizes and
    // within which bounds, and stores what the reader chose (onResize/onReset); the drawer only reports input.
    const grip = node('div', '', drawer); grip.className = 'study-panel-resize';
    grip.setAttribute('role', 'separator'); grip.tabIndex = 0; grip.setAttribute('aria-controls', drawer.id);
    grip.setAttribute('aria-label', 'Study Panel 크기 조절');
    grip.title = '드래그하거나 화살표 키로 Study Panel 크기를 조절합니다. 두 번 클릭하면 기본 크기와 글자로 돌아갑니다.';
    let text = 0, size = null, drag = null;
    const snapshot = () => ({ ...state });
    // Layout records keep the preference even while the current mode hides it.
    const shownTab = () => available.includes(state.tab) ? state.tab : available[0];
    function render() {
      drawer.hidden = !state.open; drawer.inert = !state.open;
      names.forEach((name, i) => {
        const active = shownTab() === name;
        tabs[i].hidden = !available.includes(name);
        tabs[i].setAttribute('aria-selected', String(active)); tabs[i].tabIndex = active ? 0 : -1;
        panels[i].hidden = !active; panels[i].inert = !active;
      });
    }
    function focusable(el) {
      if (!el?.isConnected || typeof el.focus !== 'function' || el.disabled
          || el.closest('[hidden], [inert]') || !el.getClientRects().length) return false;
      const style = doc.defaultView.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse';
    }
    function focus(el) {
      if (!focusable(el)) return false;
      movingFocus = true;
      try { el.focus({ preventScroll: true }); } finally { movingFocus = false; }
      return doc.activeElement === el;
    }
    function focusTab() { focus(tabs[names.indexOf(shownTab())]); }
    const outsideElement = el => el?.nodeType === 1 && el.ownerDocument === doc && el.isConnected
      && el !== doc.body && el !== doc.documentElement && !drawer.contains(el);
    function captureOpener(el = doc.activeElement) {
      // Drawer controls and unknown focus must not replace the outside destination.
      if (outsideElement(el)) opener = el;
    }
    function returnFocus(needed, saved = opener) {
      opener = null;
      // Decide before hiding/removing DOM: browsers can then move focus to body.
      // An outside editor belongs to the user and must not be touched on close.
      if (!needed) return;
      if (!focus(saved)) focus(resolve(app.fallbackFocus));
    }
    function changed() { app.onChange?.(snapshot()); }
    function applyState(value) {
      const different = state.open !== value.open || state.tab !== value.tab;
      const returnNeeded = state.open && !value.open && drawer.contains(doc.activeElement);
      if (value.open) captureOpener();
      state = { ...value }; render();
      if (state.open) {
        const tab = shownTab(), panel = panels[names.indexOf(tab)], target = app.focusTarget?.(tab, panel);
        if (!target || !panel.contains(target) || !focus(target)) focusTab();
      } else returnFocus(returnNeeded);
      if (different) changed(); return true;
    }
    function open(tab) {
      // Explicit unavailable requests are refused; omitted tab opens the shown fallback.
      if (destroyed || !available.length || (tab !== undefined && !available.includes(tab))) return false;
      if (!state.open && !opener) opener = resolve(app.opener) || null;
      return applyState({ open: true, tab: tab === undefined ? state.tab : tab });
    }
    function close() {
      if (destroyed || !state.open) return false;
      const returnNeeded = drawer.contains(doc.activeElement), saved = opener;
      state.open = false; render();
      // The page may return moved content from onChange. An opener inside that
      // content becomes focusable only after it has returned to its original row.
      changed(); returnFocus(returnNeeded, saved); return true;
    }
    function select(tab) {
      if (destroyed || !available.includes(tab)) return false;
      const different = state.tab !== tab;
      if (state.open) captureOpener();
      state.tab = tab; render(); if (state.open) focusTab();
      if (different) changed(); return true;
    }
    function restore(value) {
      if (destroyed || !value || typeof value.open !== 'boolean' || !names.includes(value.tab)
          || Object.keys(value).some(key => !['open', 'tab'].includes(key))) return false;
      return applyState({ open: value.open && available.length > 0, tab: value.tab });
    }
    function setAvailable(value) {
      if (destroyed || !validAvailable(value)) return false;
      const before = snapshot(), inside = state.open && drawer.contains(doc.activeElement);
      available = names.filter(name => value.includes(name));
      if (!available.length) state.open = false;
      render();
      if (before.open && !state.open) returnFocus(inside);
      else if (inside && (!drawer.contains(doc.activeElement) || !focusable(doc.activeElement)
          || (tabs.includes(doc.activeElement) && doc.activeElement !== tabs[names.indexOf(shownTab())]))) focusTab();
      if (before.open !== state.open || before.tab !== state.tab) changed();
      return true;
    }
    listen(drawer, 'focusin', event => {
      if (state.open && !movingFocus && outsideElement(event.relatedTarget)) captureOpener(event.relatedTarget);
    });
    listen(closeButton, 'click', close);
    listen(tablist, 'keydown', event => {
      const visibleTabs = available.map(name => tabs[names.indexOf(name)]), i = visibleTabs.indexOf(event.target);
      if (i < 0 || event.defaultPrevented || event.isComposing || composing || event.altKey || event.ctrlKey || event.metaKey) return;
      const count = available.length;
      const destinations = { ArrowRight: (i + 1) % count, ArrowLeft: (i + count - 1) % count, Home: 0, End: count - 1 };
      if (!Object.hasOwn(destinations, event.key)) return;
      const next = destinations[event.key];
      event.preventDefault(); event.stopPropagation(); select(available[next]);
    });
    function renderText() {
      textSize.value = String(text);
      for (const el of [tablist, ...panels]) el.style.zoom = text ? String(TEXT_SCALES[text]) : '';
    }
    const validText = value => Number.isInteger(value) && value >= 0 && value < TEXT_SCALES.length;
    function setText(value) {
      if (destroyed || !validText(value)) return false;
      text = value; renderText(); return true;
    }
    listen(textSize, 'change', () => {
      const value = Number(textSize.value);
      if (!validText(value) || value === text) { renderText(); return; }
      text = value; renderText(); app.onText?.(value);
    });
    function renderSize() {
      grip.hidden = !size;
      if (!size) return;
      grip.setAttribute('aria-orientation', size.axis === 'x' ? 'vertical' : 'horizontal');
      grip.setAttribute('aria-valuenow', String(Math.round(size.value)));
      grip.setAttribute('aria-valuemin', String(Math.round(size.min)));
      grip.setAttribute('aria-valuemax', String(Math.round(size.max)));
    }
    function setSize(value) {
      if (destroyed) return false;
      if (value === null) { size = null; drag = null; renderSize(); return true; }
      if (!value || !['x', 'y'].includes(value.axis) || ![value.value, value.min, value.max].every(Number.isFinite)
          || value.min > value.max) return false;
      size = { axis: value.axis, value: value.value, min: value.min, max: value.max }; renderSize(); return true;
    }
    const pointerAt = event => drag.axis === 'x' ? event.clientX : event.clientY;
    listen(grip, 'pointerdown', event => {
      if (event.button !== 0 || !size || !state.open || destroyed) return;
      event.preventDefault();
      drag = { id: event.pointerId, axis: size.axis, from: 0, start: size.value, moved: false };
      drag.from = pointerAt(event);
      grip.setPointerCapture?.(event.pointerId);
    });
    listen(grip, 'pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = pointerAt(event) - drag.from;
      if (!delta && !drag.moved) return;
      drag.moved = true; app.onResize?.(drag.start + delta, 'move');
    });
    const endDrag = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const done = drag, at = pointerAt(event); drag = null;
      if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      // A press without movement (or the first click of a double-click) changes and stores nothing.
      if (event.type === 'pointerup' && done.moved) app.onResize?.(done.start + at - done.from, 'end');
      else if (done.moved) app.onResize?.(done.start, 'cancel');
    };
    listen(grip, 'pointerup', endDrag);
    listen(grip, 'pointercancel', endDrag);
    listen(grip, 'lostpointercapture', endDrag);
    listen(grip, 'keydown', event => {
      if (!size || event.defaultPrevented || event.isComposing || event.keyCode === 229
          || event.altKey || event.ctrlKey || event.metaKey) return;
      const keys = size.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (![...keys, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === 'Home' ? size.min : event.key === 'End' ? size.max
        : size.value + (event.key === keys[0] ? -step : step);
      app.onResize?.(Math.min(size.max, Math.max(size.min, next)), 'end');
    });
    listen(grip, 'dblclick', event => { event.preventDefault(); if (state.open) app.onReset?.(); });
    listen(resetButton, 'click', () => { if (state.open) app.onReset?.(); });
    listen(drawer, 'compositionstart', () => { composing = true; });
    listen(drawer, 'compositionend', () => { composing = false; });
    listen(drawer, 'keydown', event => {
      if (event.key !== 'Escape' || !state.open || !drawer.contains(doc.activeElement)
          || event.defaultPrevented || event.isComposing || composing || event.keyCode === 229) return;
      // Native select popups expose no reliable open state; leave their Escape
      // to the browser. Custom popups can claim it by cancellation or callback.
      if (event.target.closest('select, [aria-expanded="true"]') || app.escapeClaimed?.(event)) return;
      event.preventDefault(); event.stopPropagation(); close();
    });
    function destroy() {
      if (destroyed) return;
      const returnNeeded = state.open && drawer.contains(doc.activeElement);
      destroyed = true; state.open = false; drag = null;
      listeners.forEach(remove => remove());
      const saved = opener;
      for (const { content, marker } of moved) {
        if (marker.parentNode) marker.parentNode.replaceChild(content, marker);
        else content.remove();
      }
      drawer.remove();
      returnFocus(returnNeeded, saved);
    }
    render(); renderText(); renderSize();
    return { open, close, toggle: () => state.open ? close() : open(), select, setAvailable, snapshot, restore, destroy,
      setText, setSize, element: drawer };
  }
  create.TEXT_SCALES = TEXT_SCALES;
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.KinStudyPanel = create;
})(globalThis);
