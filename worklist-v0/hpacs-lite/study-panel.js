/* Move existing study tools into a non-modal drawer without losing their state or the opener's focus. */
(function (root) {
  'use strict';
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
    let state = { open: false, tab: available[0] || 'images' }, opener = null, destroyed = false, composing = false;
    let movingFocus = false;
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
        const active = available.includes(name) && state.tab === name;
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
    function focusTab() { focus(tabs[names.indexOf(state.tab)]); }
    function captureOpener(el = doc.activeElement) {
      // Repeated API entry from inside the drawer refreshes the outside record,
      // never making a drawer control its own return destination.
      if (drawer.contains(el)) el = opener?.el;
      if (!el || el === doc.body || el === doc.documentElement) { opener = null; return; }
      opener = { el, scrollTop: el?.scrollTop, scrollLeft: el?.scrollLeft };
      if (typeof el?.selectionStart === 'number') {
        opener.selection = [el.selectionStart, el.selectionEnd, el.selectionDirection];
      }
    }
    function returnFocus(needed) {
      const saved = opener; opener = null;
      // Decide before hiding/removing DOM: browsers can then move focus to body.
      // An outside editor belongs to the user and must not be touched on close.
      if (!needed) return;
      if (saved && focus(saved.el)) {
        if (saved.selection) saved.el.setSelectionRange(...saved.selection);
        saved.el.scrollTop = saved.scrollTop; saved.el.scrollLeft = saved.scrollLeft;
      } else focus(resolve(app.fallbackFocus));
    }
    function changed() { app.onChange?.(snapshot()); }
    function open(tab = state.tab) {
      if (destroyed || !available.includes(tab)) return false;
      const different = !state.open || state.tab !== tab;
      captureOpener();
      state = { open: true, tab }; render();
      const panel = panels[names.indexOf(tab)], target = app.focusTarget?.(tab, panel);
      if (!target || !panel.contains(target) || !focus(target)) focusTab();
      if (different) changed(); return true;
    }
    function close() {
      if (destroyed || !state.open) return false;
      const returnNeeded = drawer.contains(doc.activeElement);
      state.open = false; render(); returnFocus(returnNeeded); changed(); return true;
    }
    function select(tab) {
      if (destroyed || !available.includes(tab)) return false;
      const different = state.tab !== tab;
      if (state.open) captureOpener();
      state.tab = tab; render(); if (state.open) focusTab();
      if (different) changed(); return true;
    }
    function restore(value) {
      if (destroyed || !value || typeof value.open !== 'boolean' || !available.includes(value.tab)
          || Object.keys(value).some(key => !['open', 'tab'].includes(key))) return false;
      if (value.open) return open(value.tab);
      const different = state.open || state.tab !== value.tab;
      const returnNeeded = state.open && drawer.contains(doc.activeElement);
      state = { open: false, tab: value.tab }; render();
      returnFocus(returnNeeded); if (different) changed(); return true;
    }
    function setAvailable(value) {
      if (destroyed || !validAvailable(value)) return false;
      const before = snapshot(), inside = state.open && drawer.contains(doc.activeElement);
      available = names.filter(name => value.includes(name));
      if (available.length && !available.includes(state.tab)) state.tab = available[0];
      if (!available.length) state.open = false;
      render();
      if (before.open && !state.open) returnFocus(inside);
      else if (inside && (!drawer.contains(doc.activeElement) || !focusable(doc.activeElement))) focusTab();
      if (before.open !== state.open || before.tab !== state.tab) changed();
      return true;
    }
    listen(drawer, 'focusin', event => {
      if (state.open && !movingFocus && !drawer.contains(event.relatedTarget)) captureOpener(event.relatedTarget);
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
      returnFocus(returnNeeded);
      for (const { content, marker } of moved) {
        if (marker.parentNode) marker.parentNode.replaceChild(content, marker);
        else content.remove();
      }
      drawer.remove();
    }
    render();
    return { open, close, toggle: () => state.open ? close() : open(), select, setAvailable, snapshot, restore, destroy,
      element: drawer };
  }
  if (typeof module === 'object' && module.exports) module.exports = create;
  else root.KinStudyPanel = create;
})(globalThis);
