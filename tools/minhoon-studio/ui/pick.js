'use strict';
// Point-and-click ("이거"): the Agentation pattern (agentation.com) written fresh in vanilla JS — no code copied.
// In pick mode a transparent shield in the studio page sits over the product iframe, so the product never receives
// the pointer events: picking a button does not press it. The element under the pointer is found with the iframe
// document's elementFromPoint, outlined, and described (stable selector, visible text, box, page, role) for Claude.
// Highlights live in the studio page, not in the product DOM, so the product's layout and CSS are untouched.
// The viewer popup is OHIF itself (a top-level page, not a frame the studio owns): there the same shield covers the
// whole window (target = window), and the studio's own elements, marked data-studio, are skipped when looking under
// the pointer.
(() => {
  const { el } = window.Studio;
  // One request carries at most this many picks, counted over every window (product and viewer popups together):
  // the chat sends what it shows, so the limit is applied where he picks, not by cutting the list later.
  const MAX_PICKS = 12;
  const HINT = '고르기: 바꿀 곳을 클릭하세요 · 여러 개 가능 · 다시 클릭하면 빼기 · Esc 모두 지우기';
  const FULL = `한 번에 ${MAX_PICKS}개까지 고를 수 있습니다(제품 화면과 영상 창을 합해서). 하나를 빼고 다시 고르세요.`;

  // room(): how many picks this window may hold now (MAX_PICKS less those held by the other windows).
  // inner(node, x, y): the element the page means at that point, when hit-testing stops at a frame around it.
  window.StudioPick = function StudioPick(target, { meta = () => ({}), onChange = () => {}, onMode = () => {}, idPrefix = 'p',
    room = () => MAX_PICKS, inner = node => node } = {}) {
    const self = target === window;
    const layer = el('div', 'pick-layer');
    const shield = el('div', 'pick-shield');
    const hover = el('div', 'pick-box hover');
    const hint = el('div', 'pick-hint', HINT);
    shield.hidden = true; hover.hidden = true; hint.hidden = true;
    for (const node of [layer, shield, hint]) node.dataset.studio = '';
    // Focusable, so pick mode can take the keyboard away from the product (Space/Enter would press a focused button).
    shield.tabIndex = -1;
    layer.append(hover);
    document.body.append(layer, shield, hint);

    const picks = []; // { id, node, desc, box, missingSince }
    let active = false, seq = 0, frame = 0;

    const doc = () => { if (self) return document; try { return target.contentDocument; } catch { return null; } };
    const win = () => (self ? window : target.contentWindow);
    const offset = () => (self ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : target.getBoundingClientRect());
    const studioOwn = n => !!(n && n.closest && n.closest('[data-studio]'));

    function nodeAt(x, y) {
      const d = doc();
      if (!d) return null;
      const r = offset();
      const node = d.elementsFromPoint(x - r.left, y - r.top).find(n => !studioOwn(n));
      return node && node !== d.documentElement && node !== d.body ? inner(node, x - r.left, y - r.top) : null;
    }

    // Only the part of the node the product actually shows is outlined: a cell scrolled out of the worklist must not
    // leave an outline over the buttons below the list.
    function shown(node) {
      const d = node.ownerDocument, win = d.defaultView;
      const r = node.getBoundingClientRect();
      // The viewport stands in for <html>/<body>, whose overflow scrolls the page rather than clipping it.
      let left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, win.innerWidth), bottom = Math.min(r.bottom, win.innerHeight);
      for (let a = node.parentElement; a && a !== d.body && a !== d.documentElement && right > left && bottom > top; a = a.parentElement) {
        const cs = win.getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect(), x = c.left + a.clientLeft, y = c.top + a.clientTop;
        left = Math.max(left, x); top = Math.max(top, y); right = Math.min(right, x + a.clientWidth); bottom = Math.min(bottom, y + a.clientHeight);
      }
      return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
    }

    function place(box, node) {
      if (!node || !node.isConnected) { box.hidden = true; return; }
      const r = shown(node), o = offset();
      if (!r) { box.hidden = true; return; }
      box.hidden = false;
      Object.assign(box.style, { left: `${o.left + r.left}px`, top: `${o.top + r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }

    // A pick belongs to a node of the product document now shown. After a reload the old node still exists, but in
    // the old document; after a re-render (sorting the list) it is replaced. Either way it is looked up again by its
    // selector. A positional selector (:nth-of-type) only rebinds to an element with the same visible text, so a
    // re-sorted list never moves a pick onto another study; until it is found again the pick is shown as lost.
    function resolve(p) {
      const d = doc();
      if (p.node && p.node.isConnected && p.node.ownerDocument === d) return;
      let found = null;
      try { found = d ? d.querySelector(p.desc.selector) : null; } catch { found = null; }
      if (found && /:nth-of-type\(/.test(p.desc.selector) && p.desc.text && visibleText(found) !== p.desc.text) found = null;
      p.node = found;
    }

    // A reloading list has no rows for a moment: a pick counts as lost only once the page has settled without it.
    const LOST_AFTER_MS = 1500;
    function paint() {
      frame = 0;
      const d = doc(), now = Date.now();
      let changed = false;
      for (const p of picks) {
        resolve(p);
        if (p.node) p.missingSince = 0; else if (!p.missingSince) p.missingSince = now;
        const lost = !p.node && !!d && d.readyState === 'complete' && now - p.missingSince > LOST_AFTER_MS;
        if (lost !== !!p.desc.lost) { p.desc.lost = lost; changed = true; }
        place(p.box, p.node);
      }
      if (changed) emit();
      if (active || picks.length) frame = requestAnimationFrame(paint);
    }
    const repaint = () => { if (!frame) frame = requestAnimationFrame(paint); };

    function emit() {
      picks.forEach((p, i) => { p.box.dataset.n = `선택됨 ${i + 1}`; });
      onChange(picks.map(p => p.desc));
    }

    function add(node) {
      picks.forEach(resolve); // a click right after a reload must find the pick it repeats, not add a second one
      const existing = picks.findIndex(p => p.node === node);
      if (existing >= 0) { picks[existing].box.remove(); picks.splice(existing, 1); emit(); return; }
      if (picks.length >= Math.min(MAX_PICKS, room())) { full(); return; }
      const box = el('div', 'pick-box picked');
      layer.append(box);
      const id = `${idPrefix}${++seq}`;
      picks.push({ id, node, box, desc: { id, ...describe(node, meta(node)) } });
      emit();
      repaint();
    }

    // A click past the limit says so where he clicked, instead of doing nothing.
    let fullTimer = 0;
    function full() {
      hint.textContent = FULL; hint.classList.add('full');
      clearTimeout(fullTimer);
      fullTimer = setTimeout(() => { hint.textContent = HINT; hint.classList.remove('full'); }, 3000);
    }

    function remove(id) {
      const i = picks.findIndex(p => p.id === id);
      if (i < 0) return;
      picks[i].box.remove(); picks.splice(i, 1); emit();
    }

    function clear() {
      for (const p of picks) p.box.remove();
      picks.length = 0;
      emit();
    }

    function fit() {
      const r = offset();
      Object.assign(shield.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }

    // The keyboard moves to the shield, so a focused product button cannot be pressed with Space/Enter while
    // picking. Chromium then reports <body> as the product's focused element, so the field he was typing in is
    // remembered: an edit still waits for "지금 보기" instead of wiping the text, and focus goes back to it after.
    let held = null;
    function holdKeyboard() {
      const d = doc(), now = d && d.activeElement;
      if (now && now !== d.body && now !== d.documentElement && !studioOwn(now)) held = now;
      shield.focus({ preventScroll: true });
    }
    function heldField() {
      return held && held.isConnected && held.ownerDocument === doc() ? held : null;
    }

    // onMode only on a real change: a resize while picking must not look like a second "picking started".
    function setActive(on) {
      on = !!on;
      fit();
      if (on === active) return;
      active = on;
      // Read before hiding: a hidden shield has already given focus up to <body>.
      const hadKeyboard = document.activeElement === shield;
      shield.hidden = !active; hint.hidden = !active;
      if (active) { held = null; holdKeyboard(); }
      else {
        hover.hidden = true;
        const back = heldField();
        held = null;
        if (hadKeyboard) {
          try { if (back) back.focus({ preventScroll: true }); else if (self) shield.blur(); else target.contentWindow.focus(); } catch { /* navigating */ }
        }
      }
      onMode(active);
      repaint();
    }

    shield.addEventListener('pointermove', e => { place(hover, nodeAt(e.clientX, e.clientY)); });
    shield.addEventListener('pointerleave', () => { hover.hidden = true; });
    shield.addEventListener('click', e => { e.preventDefault(); const node = nodeAt(e.clientX, e.clientY); if (node) add(node); });
    shield.addEventListener('contextmenu', e => e.preventDefault());
    // On the viewer page the shield shares the document with the product: its pointer events would bubble to the
    // viewer's document listeners (tools, menus that close on an outside click). They stop at the shield.
    if (self) {
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'pointermove', 'mousemove', 'touchstart', 'touchend']) {
        shield.addEventListener(type, e => e.stopPropagation());
      }
    }
    // The shield would otherwise stop scrolling: scroll whatever is under the pointer. Wheel over an image is not
    // passed on: in the viewer it would page through the slices, which is the viewer's own button-free action.
    shield.addEventListener('wheel', e => {
      e.preventDefault();
      e.stopPropagation();
      let node = nodeAt(e.clientX, e.clientY);
      while (node && node.nodeType === 1) {
        const cs = node.ownerDocument.defaultView.getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) { node.scrollBy(e.deltaX, e.deltaY); return; }
        node = node.parentElement;
      }
      try { win().scrollBy(e.deltaX, e.deltaY); } catch { /* navigating */ }
    }, { passive: false });
    window.addEventListener('resize', () => { if (active) fit(); });

    // Esc while picking clears every pick and leaves pick mode. Outside pick mode Esc stays the product's.
    // While picking, plain keys meant for the product (focus can come back, e.g. a reloaded page that focuses a
    // field) are kept from it; Alt/Ctrl chords pass so the studio shortcuts still work.
    function onKey(e) {
      if (!active) return false;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); setActive(false); return true; }
      const where = e.target && (e.target.ownerDocument || e.target);
      // Viewer page: everything but the studio's own controls is the product.
      const forProduct = self ? e.target === shield || !studioOwn(e.target) : where !== document || e.target === shield;
      if (forProduct && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); e.stopPropagation(); holdKeyboard(); return true;
      }
      return false;
    }

    // Picks kept from before this page reloaded (the viewer reloads its whole page): found again by their selector,
    // shown as lost until they are.
    function restore(descs) {
      for (const desc of Array.isArray(descs) ? descs : []) {
        if (!desc || typeof desc.id !== 'string' || typeof desc.selector !== 'string' || picks.length >= MAX_PICKS) continue;
        const box = el('div', 'pick-box picked');
        layer.append(box);
        picks.push({ id: desc.id, node: null, box, desc: { ...desc, lost: false }, missingSince: 0 });
        const n = Number(desc.id.slice(idPrefix.length));
        if (Number.isInteger(n) && n > seq) seq = n;
      }
      emit();
      repaint();
    }

    return {
      toggle: on => setActive(on === undefined ? !active : on),
      restore,
      get active() { return active; },
      // The product field that had the keyboard before picking took it (null outside pick mode).
      heldField: () => (active ? heldField() : null),
      remove, clear, onKey,
      list: () => picks.map(p => p.desc),
    };
  };

  // ── description sent to Claude ──
  function describe(node, meta) {
    const win = node.ownerDocument.defaultView;
    const r = node.getBoundingClientRect();
    const cs = win.getComputedStyle(node);
    let page = '';
    try { page = win.location.pathname + win.location.search; } catch { /* navigating */ }
    return {
      selector: selectorFor(node),
      tag: node.tagName.toLowerCase(),
      text: visibleText(node),
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: win.innerWidth, h: win.innerHeight },
      style: { font: `${cs.fontSize} ${cs.fontWeight}`, color: cs.color, background: cs.backgroundColor },
      page, screen: meta.screen || null, role: meta.role || null,
      ...(meta.image ? { image: meta.image } : {}),
    };
  }

  function visibleText(node) {
    const tag = node.tagName;
    let text = '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const label = node.id && node.ownerDocument.querySelector(`label[for="${CSS.escape(node.id)}"]`);
      text = node.getAttribute('aria-label') || (label && label.textContent) || node.getAttribute('placeholder') || node.getAttribute('name') || '';
      if (tag === 'SELECT' && node.selectedOptions && node.selectedOptions[0]) text += ` [${node.selectedOptions[0].textContent}]`;
      if (tag === 'INPUT' && /button|submit/.test(node.type)) text = node.value || text;
    } else {
      text = node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '';
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  }

  // Shortest selector that still finds exactly this element: an id if there is one, else tag + a telling attribute
  // + up to two classes, climbing to an ancestor with an id, with :nth-of-type only where siblings look alike.
  // State classes (sel, on, active, …) are left out so the selector survives a click elsewhere.
  // A study row is named by its data-uid (the study itself), never by its position, so the selector still means the
  // same study after the list is sorted or filtered; its classes (st-<report state>) change with the study and are
  // left out. Anything inside a study row always names that row: a filtered list can make "the 18th cell" unique
  // for a moment, and once the filter is cleared it would mean another study's cell.
  const STATE_CLASS = /^(sel|selected|on|off|active|hover|focus|focused|open|closed|show|hidden|disabled|is-.*|has-.*)$/;
  // In the viewer the same holds for a viewport (OHIF's data-viewport-uid): a pick stays on its viewport.
  const IDENTITY = ['data-uid', 'data-viewport-uid'];
  const ATTRS = ['data-mode', 'data-col', 'data-key', 'data-action', 'data-tab', 'name', 'aria-label', 'role', 'type'];
  function selectorFor(node) {
    const d = node.ownerDocument;
    const count = (sel, scope = d) => { try { return scope.querySelectorAll(sel).length; } catch { return 0; } };
    const identityOf = n => !n.id && IDENTITY.find(a => n.getAttribute(a) && n.getAttribute(a).length < 120);
    let owner = node;
    while (owner && owner.nodeType === 1 && !identityOf(owner)) owner = owner.parentElement;
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1 && n !== d.documentElement && n !== d.body && parts.length < 8) {
      let part;
      const identity = identityOf(n);
      if (n.id) part = `#${CSS.escape(n.id)}`;
      else if (identity) part = `${n.tagName.toLowerCase()}[${identity}="${CSS.escape(n.getAttribute(identity))}"]`;
      else {
        part = n.tagName.toLowerCase();
        const attr = ATTRS.find(a => n.hasAttribute(a) && n.getAttribute(a).length < 60);
        if (attr) part += `[${attr}="${CSS.escape(n.getAttribute(attr))}"]`;
        part += [...n.classList].filter(c => !STATE_CLASS.test(c) && c.length < 40).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
      }
      parts.unshift(part);
      // Below the study row, uniqueness is judged inside that row and the climb always goes on up to it.
      const inside = owner && n !== owner;
      const unique = sel => count(sel, inside ? owner : d) === 1;
      if (!inside && unique(parts.join(' > '))) return parts.join(' > ');
      if (!n.id && !identity && n.parentElement) {
        const same = [...n.parentElement.children].filter(c => c.tagName === n.tagName);
        if (same.length > 1 && !unique(parts.join(' > '))) {
          parts[0] = `${part}:nth-of-type(${same.indexOf(n) + 1})`;
          if (!inside && unique(parts.join(' > '))) return parts.join(' > ');
        }
      }
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  window.StudioPick.selectorFor = selectorFor;
  window.StudioPick.MAX = MAX_PICKS;
})();
