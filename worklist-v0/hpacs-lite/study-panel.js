/* Move existing study tools into a non-modal drawer without losing their state or the opener's focus. */
(function (root) {
  'use strict';
  function create(app) {
    const host = app.host, doc = host?.ownerDocument;
    const names = ['images', 'info', 'templates'], labels = ['Images', 'Info', 'Templates'];
    const resolve = value => typeof value === 'function' ? value() : value;
    if (!doc || !host.id || !app.fallbackFocus) throw new TypeError('Study Panel requires a named host and fallbackFocus');
    const contents = names.map(name => resolve(app.content?.[name]));
    if (contents.some(el => !el || el.nodeType !== 1 || el.ownerDocument !== doc || el.contains(host))
        || contents.some((el, i) => contents.some((other, j) => i !== j && el.contains(other)))) {
      throw new TypeError('Study Panel requires three separate content elements');
    }
    const listeners = [], moved = [], tabs = [], panels = [];
    let state = { open: false, tab: 'images' }, opener = null, destroyed = false, composing = false;
    const node = (tag, text, parent) => {
      const el = doc.createElement(tag); if (text) el.textContent = text;
      if (parent) parent.append(el); return el;
    };
    const listen = (el, type, fn) => { el.addEventListener(type, fn); listeners.push(() => el.removeEventListener(type, fn)); };
    const drawer = node('aside', '', host); drawer.className = 'study-panel';
    drawer.id = host.id + '-study-panel'; drawer.setAttribute('aria-label', 'Study Panel');
    const header = node('div', '', drawer); header.className = 'study-panel-head';
    node('h2', 'Study Panel', header);
    const closeButton = node('button', 'Close', header); closeButton.type = 'button';
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
    const snapshot = () => ({ ...state });
    function render() {
      drawer.hidden = !state.open; drawer.inert = !state.open;
      names.forEach((name, i) => {
        const active = state.tab === name;
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
      el.focus({ preventScroll: true }); return doc.activeElement === el;
    }
    function focusTab() { focus(tabs[names.indexOf(state.tab)]); }
    function captureOpener() {
      const el = doc.activeElement;
      opener = { el, scrollTop: el?.scrollTop, scrollLeft: el?.scrollLeft };
      if (typeof el?.selectionStart === 'number') {
        opener.selection = [el.selectionStart, el.selectionEnd, el.selectionDirection];
      }
    }
    function returnFocus() {
      const saved = opener; opener = null;
      if (saved && focus(saved.el)) {
        if (saved.selection) saved.el.setSelectionRange(...saved.selection);
        saved.el.scrollTop = saved.scrollTop; saved.el.scrollLeft = saved.scrollLeft;
      } else focus(resolve(app.fallbackFocus));
    }
    function changed() { app.onChange?.(snapshot()); }
    function open(tab = state.tab) {
      if (destroyed || !names.includes(tab)) return false;
      const different = !state.open || state.tab !== tab;
      if (!state.open) captureOpener();
      state = { open: true, tab }; render();
      const panel = panels[names.indexOf(tab)], target = app.focusTarget?.(tab, panel);
      if (!target || !panel.contains(target) || !focus(target)) focusTab();
      if (different) changed(); return true;
    }
    function close() {
      if (destroyed || !state.open) return false;
      state.open = false; render(); returnFocus(); changed(); return true;
    }
    function select(tab) {
      if (destroyed || !names.includes(tab)) return false;
      const different = state.tab !== tab;
      state.tab = tab; render(); if (state.open) focusTab();
      if (different) changed(); return true;
    }
    function restore(value) {
      if (destroyed || !value || typeof value.open !== 'boolean' || !names.includes(value.tab)
          || Object.keys(value).some(key => !['open', 'tab'].includes(key))) return false;
      if (value.open) return open(value.tab);
      const different = state.open || state.tab !== value.tab, wasOpen = state.open;
      state = { open: false, tab: value.tab }; render();
      if (wasOpen) returnFocus(); if (different) changed(); return true;
    }
    listen(closeButton, 'click', close);
    listen(tablist, 'keydown', event => {
      const i = tabs.indexOf(event.target);
      if (i < 0 || event.defaultPrevented || event.isComposing || composing || event.altKey || event.ctrlKey || event.metaKey) return;
      const destinations = { ArrowRight: (i + 1) % 3, ArrowLeft: (i + 2) % 3, Home: 0, End: 2 };
      if (!Object.hasOwn(destinations, event.key)) return;
      const next = destinations[event.key];
      event.preventDefault(); event.stopPropagation(); select(names[next]);
    });
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
      destroyed = true; state.open = false;
      listeners.forEach(remove => remove());
      if (returnNeeded) returnFocus(); else opener = null;
      for (const { content, marker } of moved) {
        if (marker.parentNode) marker.parentNode.replaceChild(content, marker);
        else content.remove();
      }
      drawer.remove();
    }
    render();
    return { open, close, toggle: () => state.open ? close() : open(), select, snapshot, restore, destroy,
      element: drawer };
  }
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.KinStudyPanel = create;
})(globalThis);
