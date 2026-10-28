'use strict';
// Point-and-click ("이거"): the Agentation pattern (agentation.com) written fresh in vanilla JS — no code copied.
// In pick mode a transparent shield in the studio page sits over the product iframe, so the product never receives
// the pointer events: picking a button does not press it. The element under the pointer is found with the iframe
// document's elementFromPoint, outlined, and described (stable selector, visible text, box, page, role) for Claude.
// Highlights live in the studio page, not in the product DOM, so the product's layout and CSS are untouched.
(() => {
  const { el } = window.Studio;
  const MAX_PICKS = 12;

  window.StudioPick = function StudioPick(iframe, { meta = () => ({}), onChange = () => {}, onMode = () => {} } = {}) {
    const layer = el('div', 'pick-layer');
    const shield = el('div', 'pick-shield');
    const hover = el('div', 'pick-box hover');
    const hint = el('div', 'pick-hint', '고르기: 바꿀 곳을 클릭하세요 · 여러 개 가능 · 다시 클릭하면 빼기 · Esc 모두 지우기');
    shield.hidden = true; hover.hidden = true; hint.hidden = true;
    layer.append(hover);
    document.body.append(layer, shield, hint);

    const picks = []; // { id, node, desc, box }
    let active = false, seq = 0, frame = 0;

    const doc = () => { try { return iframe.contentDocument; } catch { return null; } };
    const offset = () => iframe.getBoundingClientRect();

    function nodeAt(x, y) {
      const d = doc();
      if (!d) return null;
      const r = offset();
      const node = d.elementFromPoint(x - r.left, y - r.top);
      return node && node !== d.documentElement && node !== d.body ? node : null;
    }

    function place(box, node) {
      if (!node || !node.isConnected) { box.hidden = true; return; }
      const r = node.getBoundingClientRect(), o = offset();
      if (!r.width && !r.height) { box.hidden = true; return; }
      box.hidden = false;
      Object.assign(box.style, { left: `${o.left + r.left}px`, top: `${o.top + r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }

    // Outlines follow scrolling and re-layout; after a reload the old nodes are gone, so look them up again.
    function paint() {
      frame = 0;
      for (const p of picks) {
        if (!p.node || !p.node.isConnected) {
          try { p.node = doc() && doc().querySelector(p.desc.selector); } catch { p.node = null; }
        }
        place(p.box, p.node);
      }
      if (active || picks.length) frame = requestAnimationFrame(paint);
    }
    const repaint = () => { if (!frame) frame = requestAnimationFrame(paint); };

    function emit() {
      picks.forEach((p, i) => { p.box.dataset.n = `선택됨 ${i + 1}`; });
      onChange(picks.map(p => p.desc));
    }

    function add(node) {
      const existing = picks.findIndex(p => p.node === node);
      if (existing >= 0) { picks[existing].box.remove(); picks.splice(existing, 1); emit(); return; }
      if (picks.length >= MAX_PICKS) return;
      const box = el('div', 'pick-box picked');
      layer.append(box);
      picks.push({ id: `p${++seq}`, node, box, desc: { id: `p${seq}`, ...describe(node, iframe, meta()) } });
      emit();
      repaint();
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

    function setActive(on) {
      active = !!on;
      const r = offset();
      Object.assign(shield.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      shield.hidden = !active; hint.hidden = !active;
      if (!active) hover.hidden = true;
      onMode(active);
      repaint();
    }

    shield.addEventListener('pointermove', e => { place(hover, nodeAt(e.clientX, e.clientY)); });
    shield.addEventListener('pointerleave', () => { hover.hidden = true; });
    shield.addEventListener('click', e => { e.preventDefault(); const node = nodeAt(e.clientX, e.clientY); if (node) add(node); });
    shield.addEventListener('contextmenu', e => e.preventDefault());
    // The shield would otherwise stop scrolling: scroll whatever is under the pointer.
    shield.addEventListener('wheel', e => {
      e.preventDefault();
      let node = nodeAt(e.clientX, e.clientY);
      while (node && node.nodeType === 1) {
        const cs = node.ownerDocument.defaultView.getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) { node.scrollBy(e.deltaX, e.deltaY); return; }
        node = node.parentElement;
      }
      try { iframe.contentWindow.scrollBy(e.deltaX, e.deltaY); } catch { /* navigating */ }
    }, { passive: false });
    window.addEventListener('resize', () => { if (active) setActive(true); });

    // Esc while picking clears every pick and leaves pick mode. Outside pick mode Esc stays the product's.
    function onKey(e) {
      if (e.key === 'Escape' && active) { e.preventDefault(); e.stopPropagation(); clear(); setActive(false); return true; }
      return false;
    }

    return {
      toggle: on => setActive(on === undefined ? !active : on),
      get active() { return active; },
      remove, clear, onKey,
      list: () => picks.map(p => p.desc),
    };
  };

  // ── description sent to Claude ──
  function describe(node, iframe, meta) {
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
  const STATE_CLASS = /^(sel|selected|on|off|active|hover|focus|focused|open|closed|show|hidden|disabled|is-.*|has-.*)$/;
  const ATTRS = ['data-mode', 'data-col', 'data-key', 'data-action', 'data-tab', 'name', 'aria-label', 'role', 'type'];
  function selectorFor(node) {
    const d = node.ownerDocument;
    const unique = sel => { try { return d.querySelectorAll(sel).length === 1; } catch { return false; } };
    const parts = [];
    let n = node;
    while (n && n.nodeType === 1 && n !== d.documentElement && n !== d.body && parts.length < 8) {
      let part;
      if (n.id) part = `#${CSS.escape(n.id)}`;
      else {
        part = n.tagName.toLowerCase();
        const attr = ATTRS.find(a => n.hasAttribute(a) && n.getAttribute(a).length < 60);
        if (attr) part += `[${attr}="${CSS.escape(n.getAttribute(attr))}"]`;
        part += [...n.classList].filter(c => !STATE_CLASS.test(c) && c.length < 40).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) return parts.join(' > ');
      if (!n.id && n.parentElement) {
        const same = [...n.parentElement.children].filter(c => c.tagName === n.tagName);
        if (same.length > 1) {
          parts[0] = `${part}:nth-of-type(${same.indexOf(n) + 1})`;
          if (unique(parts.join(' > '))) return parts.join(' > ');
        }
      }
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  window.StudioPick.selectorFor = selectorFor;
})();
