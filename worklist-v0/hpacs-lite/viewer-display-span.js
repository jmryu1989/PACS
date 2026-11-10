/* A viewer window across a display edge, and a second viewer window.
 * - The grid's middle column edge is put on the display edge, so no cell is cut
 *   by the monitor seam. Columns stay equal; one display has no change at all.
 * - The display past the edge gets working copies of the patient tabs, image
 *   tools and series rows. The rows themselves do not move: a copy forwards
 *   its clicks and drags to the original control, which keeps every guard.
 * - The account setting (Viewer Settings > Second Display) turns the copies,
 *   and the rows of a second viewer window, off. Without the setting they show.
 * Geometry is read from the browser only; a screen-details request never
 * prompts here (it is used only when the permission was already granted). */
window.KinViewerDisplaySpan = (() => {
  const ROWS = [
    { row: '.kin-patient-tabs', source: '[role="tablist"]', name: 'Patients' },
    { row: '.kin-ux-toolbar', source: '.kin-ux-tools-bar', name: 'Image Tools' },
    { row: '.kin-viewer-series-strip', source: '.kin-series-list', name: 'Series' },
  ];
  const ROOM = 120;
  function slotOf() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const groups = hash.getAll('kin-window-group'), slots = hash.getAll('kin-window-slot');
    return groups.length === 1 && slots.length === 1 && /^[0-3]$/.test(slots[0]) ? { group: groups[0], slot: Number(slots[0]) } : null;
  }
  function pathTo(root, node) {
    const path = [];
    for (let at = node; at && at !== root; at = at.parentElement) {
      if (!at.parentElement) return null;
      path.unshift([...at.parentElement.children].indexOf(at));
    }
    return path;
  }
  function follow(root, path) {
    let at = root;
    for (const index of path || []) { at = at?.children[index]; if (!at) return null; }
    return at;
  }
  function mount({ services, enabled }) {
    const layout = window.KinViewerDisplayLayout;
    let ended = false, frame = null, details = null, geometry = '', firstSeen = 0, link = null, channel = null;
    const abort = new AbortController(), mirrors = new Map();
    const style = document.createElement('style'); style.dataset.kinUxOwned = ''; document.head.append(style);
    const on = () => { try { return enabled() !== false; } catch (_) { return true; } };
    // Reuse window-management access the reader already granted; never ask here.
    navigator.permissions?.query({ name: 'window-management' }).then(permission => {
      if (permission.state === 'granted') return window.getScreenDetails?.();
    }).then(value => {
      if (ended || !value) return;
      details = value;
      details.addEventListener?.('screenschange', schedule, { signal: abort.signal });
      details.addEventListener?.('currentscreenchange', schedule, { signal: abort.signal });
      schedule();
    }).catch(() => {});
    function screens() {
      if (details?.screens?.length) return Array.from(details.screens, s => ({ left: s.left, top: s.top, width: s.width, height: s.height }));
      const s = window.screen;
      return [{ left: s.availLeft, top: s.availTop, width: s.availWidth, height: s.availHeight }];
    }
    function zoom() {
      const os = details?.currentScreen?.devicePixelRatio;
      return Number.isFinite(os) && os > 0 ? window.devicePixelRatio / os : null;
    }
    function seams() {
      return layout.seams(screens(), { screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth,
        outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight }, zoom());
    }
    // M-1: the grid fills its column; its middle edge goes to the seam.
    function placeGrid(list) {
      const grid = document.querySelector('[data-cy="viewport-grid"]'), column = grid?.parentElement;
      let rule = '', seam = null;
      const state = services.viewportGridService.getState();
      const middle = [...state.viewports.values()].some(cell => Math.abs((cell.x ?? -1) - 0.5) < 0.001);
      if (grid && column && middle) {
        const box = column.getBoundingClientRect(), css = getComputedStyle(column);
        const base = { left: box.left + parseFloat(css.paddingLeft || 0) + parseFloat(css.borderLeftWidth || 0),
          right: box.right - parseFloat(css.paddingRight || 0) - parseFloat(css.borderRightWidth || 0) };
        const plan = layout.split(base, list);
        if (plan && (plan.left || plan.right)) {
          seam = plan.seam;
          rule = 'body.kin-viewer-ux [data-cy="viewport-grid"] { margin-left: ' + plan.left + 'px !important; margin-right: ' + plan.right +
            'px !important; width: calc(100% - ' + (plan.left + plan.right) + 'px) !important; max-width: calc(100% - ' + (plan.left + plan.right) + 'px) !important; }';
        } else if (plan) seam = plan.seam;
      }
      if (style.textContent !== rule) style.textContent = rule;
      return seam;
    }
    // M-2: the copy of one row on the display past the seam.
    function drop(spec) { const state = mirrors.get(spec); if (!state) return; state.observer.disconnect(); state.host.remove(); state.row?.classList.remove('kin-span-row'); mirrors.delete(spec); }
    // Each copied element is paired with the element it was copied from, at copy time.
    function pair(map, copy, source) {
      map.set(copy, source);
      for (let i = 0; i < copy.children.length; i++) pair(map, copy.children[i], source.children[i]);
    }
    function rebuild(state) {
      state.queued = false;
      // Replacing the node a drag started from ends that drag: wait for its end.
      if (ended || !state.source.isConnected || state.dragging) return;
      // The strip and toolbar rewrite equal attributes on every rendered frame; copy only a real change.
      const html = state.source.outerHTML;
      if (html === state.html && state.clone) return;
      const active = state.focusPath || (state.clone?.contains(document.activeElement) ? pathTo(state.clone, document.activeElement) : null);
      const scrolled = state.clone?.scrollLeft || 0;
      const clone = state.source.cloneNode(true), map = new WeakMap();
      pair(map, clone, state.source);
      for (const node of [clone, ...clone.querySelectorAll('[id]')]) node.removeAttribute('id');
      for (const node of [clone, ...clone.querySelectorAll('[role="toolbar"],[role="tablist"]')]) {
        const label = node.getAttribute('aria-label');
        if (label && node.matches('[role="toolbar"],[role="tablist"]')) node.setAttribute('aria-label', label + ' (Second Display)');
      }
      state.html = html; state.map = map; state.clone = clone; state.focusPath = null;
      state.host.replaceChildren(state.pagers[0], clone, state.pagers[1]);
      clone.scrollLeft = scrolled;
      if (active) follow(clone, active)?.focus({ preventScroll: true });
      requestAnimationFrame(() => paging(state));
    }
    // The copy's own list pages by itself (the row's arrows page the original list).
    function paging(state) {
      const clone = state.clone; if (!clone) return;
      const hidden = clone.scrollWidth <= clone.clientWidth + 1;
      state.pagers.forEach(node => { node.hidden = hidden; });
    }
    // Forward only to the very element this copy was made from. The rows build new elements whenever their
    // content changes (another study's series, another tab list, a new tool set), so a copy made before that
    // points at a detached element and is refused, then copied again; it never reaches the element now in its place.
    function original(state, node) {
      const target = state.map?.get(node);
      if (!target || !target.isConnected || !(target === state.source || state.source.contains(target)) ||
          target.tagName !== node.tagName || target.textContent !== node.textContent) { state.html = null; queue(state); return null; }
      return target;
    }
    function nearest(state, node) {
      for (let at = node; at && at !== state.host; at = at.parentElement) if (state.map?.has(at)) return at;
      return null;
    }
    function queue(state) { if (!state.queued) { state.queued = true; requestAnimationFrame(() => rebuild(state)); } }
    function forwardDrag(state, event) {
      const type = event.type;
      if (type === 'dragend') state.dragging = false;
      const node = type === 'dragstart' || type === 'dragend' ? event.target.closest?.('[draggable="true"]') : event.target;
      const copy = node && state.host.contains(node) ? nearest(state, node) : null, target = copy && original(state, copy);
      if (type === 'dragend') queue(state);
      if (!target) { if (type === 'dragstart') event.preventDefault(); return; }
      // The same DataTransfer, inside the reader's own drag: the original's handlers run as if over it
      // (a tool dropped on the copied bar is moved by the original bar's own drop handler).
      const forwarded = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: event.dataTransfer,
        clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY });
      target.dispatchEvent(forwarded);
      if (forwarded.defaultPrevented) event.preventDefault();
      else if (type === 'dragstart') state.dragging = true;
      event.stopPropagation();
    }
    function mirror(spec, seam) {
      const row = document.querySelector(spec.row), source = row?.querySelector(':scope > ' + spec.source) || row?.querySelector(spec.source);
      if (!row || !source || source.closest('.kin-span-mirror') || !row.getClientRects().length) { drop(spec); return; }
      const box = row.getBoundingClientRect();
      if (!(seam > box.left + 1 && seam < box.right - 1)) { drop(spec); return; }
      // The copy ends before the row's own trailing controls (More, Viewer Settings, the series arrow).
      let end = box.right;
      for (let node = source.nextElementSibling; node; node = node.nextElementSibling) {
        if (node.matches('[role="status"], .kin-span-mirror') || node.hidden) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width && rect.right > seam) { end = Math.max(seam, rect.left); break; }
      }
      if (end - seam < ROOM) { drop(spec); return; }
      let state = mirrors.get(spec);
      if (state && (state.source !== source || state.row !== row)) { drop(spec); state = null; }
      if (!state) {
        const host = document.createElement('div'); host.className = 'kin-span-mirror'; host.dataset.kinUxOwned = '';
        host.setAttribute('role', 'group'); host.setAttribute('aria-label', spec.name + ' (Second Display)');
        state = { spec, row, source, host, clone: null, map: null, html: null, queued: false, observer: null, dragging: false,
          focusPath: null, followUntil: 0, pagers: [] };
        const current = state;
        state.pagers = [['Previous', -1, '‹'], ['Next', 1, '›']].map(([word, direction, text]) => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'kin-span-pager'; button.hidden = true;
          button.textContent = text; button.setAttribute('aria-label', word + ' ' + spec.name + ' (Second Display)');
          button.onclick = event => { event.stopPropagation(); current.clone?.scrollBy({ left: direction * current.clone.clientWidth, behavior: 'smooth' }); };
          return button;
        });
        host.addEventListener('click', event => {
          if (event.target.closest?.('.kin-span-pager')) return;
          const node = event.target.closest?.('button, summary, a[href], [role="tab"]');
          if (!node || !host.contains(node)) return;
          event.preventDefault(); event.stopPropagation();
          const target = original(current, node);
          if (!target || target.disabled) return;
          current.followUntil = Date.now() + 3000; target.click();
        });
        // Tab keys (ArrowLeft/Right, Home, End, Delete) run the original control's own handler. The event does not
        // bubble again, so document shortcuts see the reader's key once. Enter/Space arrive as a click.
        host.addEventListener('keydown', event => {
          if (['Tab', 'Enter', ' '].includes(event.key) || event.target.closest?.('.kin-span-pager')) return;
          const copy = nearest(current, event.target), target = copy && original(current, copy);
          if (!target) return;
          const forwarded = new KeyboardEvent('keydown', { key: event.key, code: event.code, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
            altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat, cancelable: true, bubbles: false });
          current.followUntil = Date.now() + 3000;
          target.dispatchEvent(forwarded);
          if (forwarded.defaultPrevented) event.preventDefault();
        });
        for (const type of ['dragstart', 'dragend', 'dragenter', 'dragover', 'drop']) host.addEventListener(type, event => forwardDrag(current, event));
        host.addEventListener('scroll', () => paging(current), { capture: true });
        state.observer = new MutationObserver(() => queue(current));
        state.observer.observe(source, { subtree: true, childList: true, attributes: true, characterData: true });
        row.classList.add('kin-span-row'); row.append(host);
        mirrors.set(spec, state); rebuild(state);
      } else if (state.host.parentElement !== row) row.append(state.host);
      state.host.style.left = Math.round((seam - box.left) * 100) / 100 + 'px';
      state.host.style.width = Math.round((end - seam) * 100) / 100 + 'px';
      paging(state);
    }
    // A control used from the copy that moves focus to an original control (a tab switch focuses the new tab)
    // keeps the reader on the copy's display.
    document.addEventListener('focusin', event => {
      for (const state of mirrors.values()) {
        // Only focus that leaves the copy (or the copy's node replaced under it) is brought back, once.
        if (state.followUntil < Date.now() || !state.source.contains(event.target) ||
            event.relatedTarget && !state.host.contains(event.relatedTarget)) continue;
        state.followUntil = 0; state.focusPath = pathTo(state.source, event.target); state.html = null; queue(state);
      }
    }, { capture: true, signal: abort.signal });
    // A second window of the same viewer group hides its rows only while the
    // first window of that group is open (a lone window is never stripped).
    function bindGroup() {
      const now = slotOf(), key = now ? now.group + ':' + now.slot : null;
      if (key === link?.key) return;
      channel?.close(); channel = null; link = now ? { ...now, key } : null; firstSeen = 0;
      if (!link || typeof BroadcastChannel !== 'function') return;
      try {
        channel = new BroadcastChannel('kin-viewer-display:' + link.group);
        channel.onmessage = event => {
          const m = event.data;
          if (m?.type === 'first' && link.slot > 0) { firstSeen = Date.now(); schedule(); }
          if (m?.type === 'gone' && link.slot > 0) { firstSeen = 0; schedule(); }
          if (m?.type === 'who' && link.slot === 0) channel.postMessage({ type: 'first' });
        };
        channel.postMessage({ type: link.slot === 0 ? 'first' : 'who' });
      } catch (_) { channel = null; }
    }
    function update() {
      frame = null;
      if (ended) return;
      const list = seams();
      const seam = placeGrid(list);
      const rowSeam = seam ?? list.find(x => x > window.innerWidth / 4 && x < window.innerWidth * 3 / 4) ?? null;
      for (const spec of ROWS) { if (on() && rowSeam !== null) mirror(spec, rowSeam); else drop(spec); }
      const second = !!link && link.slot > 0 && firstSeen && Date.now() - firstSeen < 7000;
      document.body.classList.toggle('kin-second-display-rows-off', !on() && !!second);
    }
    function schedule() { if (!ended && !frame) frame = requestAnimationFrame(update); }
    function poll() {
      // Browsers announce no window move. Compare the geometry each second.
      const now = [window.screenX, window.screenY, window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight].join(',');
      if (now !== geometry) { geometry = now; schedule(); }
      if (link?.slot > 0) channel?.postMessage({ type: 'who' });
      if (link && link.slot > 0 && firstSeen && Date.now() - firstSeen >= 7000) schedule();
    }
    const timer = setInterval(poll, 1000);
    window.addEventListener('resize', schedule, { signal: abort.signal });
    window.screen?.addEventListener?.('change', schedule, { signal: abort.signal });
    window.addEventListener('hashchange', () => { bindGroup(); schedule(); }, { signal: abort.signal });
    window.addEventListener('kin-viewer-second-display', schedule, { signal: abort.signal });
    // A drag that ends outside the copy (dropped on a cell, cancelled) releases the copies too.
    for (const type of ['drop', 'dragend']) window.addEventListener(type, () => setTimeout(() => {
      for (const state of mirrors.values()) if (state.dragging) { state.dragging = false; queue(state); }
    }), { capture: true, signal: abort.signal });
    window.addEventListener('pagehide', () => { if (link?.slot === 0) channel?.postMessage({ type: 'gone' }); }, { signal: abort.signal });
    const subscriptions = Object.values(services.viewportGridService.EVENTS || {}).map(event => services.viewportGridService.subscribe(event, schedule));
    // Opening or closing a side panel changes the grid's column without a window resize.
    const resized = new ResizeObserver(schedule);
    let observed = null;
    const observeColumn = () => {
      const column = document.querySelector('[data-cy="viewport-grid"]')?.parentElement;
      if (!column || column === observed) return false;
      if (observed) resized.unobserve(observed);
      observed = column; resized.observe(column); return true;
    };
    const rooted = new MutationObserver(() => { if (observeColumn()) schedule(); });
    const root = document.getElementById('root');
    if (root) rooted.observe(root, { childList: true, subtree: true });
    bindGroup(); observeColumn(); schedule();
    return {
      seams, refresh: schedule,
      dispose() {
        if (ended) return; ended = true;
        if (link?.slot === 0) { try { channel?.postMessage({ type: 'gone' }); } catch (_) {} }
        cancelAnimationFrame(frame); clearInterval(timer); abort.abort(); resized.disconnect(); rooted.disconnect();
        subscriptions.forEach(subscription => subscription.unsubscribe());
        [...mirrors.keys()].forEach(drop); channel?.close(); style.remove();
        document.body.classList.remove('kin-second-display-rows-off');
      },
    };
  }
  return { mount };
})();
