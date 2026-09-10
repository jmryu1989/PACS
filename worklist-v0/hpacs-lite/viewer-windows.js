/* Persist only window-slot identifiers. Clinical scope lives in memory and is
 * rediscovered from authenticated viewer documents after worklist reload. */
(function (root) {
  'use strict';
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'id,slots,version' || value.version !== 1 || !uuid(value.id) ||
        !Array.isArray(value.slots) || value.slots.length !== 4 || value.slots.some(v => typeof v !== 'boolean')) return null;
    return { version: 1, id: value.id, slots: [...value.slots] };
  }
  function scope(href, origin) {
    try {
      const url = new URL(href, origin);
      if (url.origin !== origin || url.pathname !== '/ohif/viewer') return null;
      const values = url.searchParams.getAll('StudyInstanceUIDs');
      if (values.length !== 1) return null;
      const studies = values[0].split(',');
      if (studies.length < 1 || studies.length > 2 || new Set(studies).size !== studies.length ||
          studies.some(v => v.length > 64 || !/^\d+(?:\.\d+)+$/.test(v))) return null;
      const series = url.searchParams.get('initialSeriesInstanceUID');
      if (series !== null && (series.length > 64 || !/^\d+(?:\.\d+)+$/.test(series))) return null;
      return { studies, series };
    } catch (_) { return null; }
  }
  function create({ storage, owner, newId, origin, describe, changed = () => {} }) {
    const bound = owner(), key = 'kin-viewer-windows:v1:' + bound;
    let state, error = null, ended = false, channel;
    const entries = Array.from({ length: 4 }, () => ({ popup: null, href: null }));
    try {
      if (!bound) throw Error('owner');
      const raw = storage.getItem(key);
      state = raw === null ? { version: 1, id: newId(), slots: [false, false, false, false] }
        : raw.length <= 512 && normalize(JSON.parse(raw));
      if (!normalize(state)) throw Error('format');
      storage.setItem(key, JSON.stringify(state));
    } catch (_) { error = '영상 창 연결 저장소를 확인하지 못했습니다. 기존 창을 유지하며 새 창은 열지 않습니다.'; }
    const current = () => !ended && !!bound && owner() === bound;
    function persist(next) {
      try { storage.setItem(key, JSON.stringify(next)); state = next; error = null; return true; }
      catch (_) { error = '영상 창 연결을 저장하지 못했습니다. 기존 창에서 작업을 확인하세요.'; return false; }
    }
    function prune() {
      if (!state || !current()) return;
      const next = normalize(state); let any = false;
      entries.forEach((entry, i) => {
        try { if (next.slots[i] && entry.popup?.closed) { next.slots[i] = false; any = true; } } catch (_) {}
      });
      if (any && persist(next)) { entries.forEach((entry, i) => { if (!next.slots[i]) { entry.popup = null; entry.href = null; } }); changed(); }
    }
    function rows() {
      prune();
      return !state ? [] : entries.flatMap((entry, i) => {
        if (!state.slots[i]) return [];
        let status;
        try { status = entry.popup ? describe(entry.popup) : null; } catch (_) {}
        const href = status?.href || entry.href;
        return [{ index: i, name: i === 0 ? 'kin-ohif-current' : 'kin-ohif-' + state.id + '-' + i,
          href, scope: scope(href, origin), status, popup: entry.popup }];
      });
    }
    function choose(href, limit) {
      if (!current() || error || !scope(href, origin)) return { error: error || '현재 계정과 영상 대상을 확인한 뒤 다시 여세요.' };
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) return { error: '영상 창 수 설정을 확인하세요.' };
      const open = rows(), wanted = JSON.stringify(scope(href, origin));
      let row = open.find(r => r.scope && JSON.stringify(r.scope) === wanted);
      if (!row && limit === 1 && open.length === 1 && open[0].index === 0) row = open[0];
      if (row) return { ...row, fresh: false };
      if (open.length >= limit) return { full: true, error: '영상 창 수 제한에 도달했습니다. Viewer Windows에서 기존 창으로 돌아가거나 저장 후 닫으세요.' };
      const index = state.slots.indexOf(false), next = normalize(state);
      next.slots[index] = true;
      if (!persist(next)) return { error };
      return { index, name: index === 0 ? 'kin-ohif-current' : 'kin-ohif-' + state.id + '-' + index, fresh: true };
    }
    function attach(choice, popup) {
      if (!current() || !state?.slots[choice.index] || !popup) return false;
      entries[choice.index].popup = popup; changed(); return true;
    }
    function blocked(choice) {
      if (!choice.fresh || entries[choice.index].popup || !current()) return;
      const next = normalize(state); next.slots[choice.index] = false; persist(next); changed();
    }
    function linked(href, index) {
      const url = new URL(href, origin), hash = new URLSearchParams(url.hash.slice(1));
      hash.set('kin-window-group', state.id); hash.set('kin-window-slot', String(index)); url.hash = hash.toString();
      return url.pathname + url.search + url.hash;
    }
    function refresh() { prune(); try { channel?.postMessage({ type: 'discover', owner: bound }); } catch (_) {} }
    function end() { ended = true; channel?.close(); }
    if (state && !error && typeof root.BroadcastChannel === 'function') {
      channel = new root.BroadcastChannel('kin-viewer-windows:' + state.id);
      channel.onmessage = e => {
        const m = e.data;
        if (!current() || m?.type !== 'present' || m.owner !== bound || !Number.isInteger(m.index) ||
            m.index < 0 || m.index > 3 || !state.slots[m.index] || !scope(m.href, origin)) return;
        if (entries[m.index].href !== m.href) { entries[m.index].href = m.href; changed(); }
      };
      refresh();
    }
    return { choose, attach, blocked, linked, rows, refresh, end, available: () => current() && !error, error: () => error };
  }
  function connect({ owner, live }) {
    let channel, ended = false, group, index;
    const bound = JSON.stringify(owner());
    const identity = () => !ended && live() && JSON.stringify(owner()) === bound ? bound : null;
    root.kinViewerWindowOwner = identity;
    function announce() {
      if (ended || !live() || JSON.stringify(owner()) !== bound || !channel) return;
      if (!scope(root.location.href, root.location.origin)) return;
      channel.postMessage({ type: 'present', owner: bound, index, href: root.location.href });
    }
    function bind() {
      channel?.close(); channel = null;
      if (ended || !live() || JSON.stringify(owner()) !== bound) return;
      const hash = new URLSearchParams(root.location.hash.slice(1));
      const groups = hash.getAll('kin-window-group'), slots = hash.getAll('kin-window-slot');
      if (groups.length !== 1 || slots.length !== 1 || !uuid(groups[0]) || !/^[0-3]$/.test(slots[0])) return;
      group = groups[0]; index = Number(slots[0]);
      try {
        channel = new root.BroadcastChannel('kin-viewer-windows:' + group);
        channel.onmessage = e => { if (e.data?.type === 'discover' && e.data.owner === bound) announce(); };
        announce();
      } catch (_) { channel = null; }
    }
    root.addEventListener('hashchange', bind); root.addEventListener('kin-window-link-changed', bind); bind();
    return { dispose() { ended = true; if (root.kinViewerWindowOwner === identity) root.kinViewerWindowOwner = () => null; channel?.close(); root.removeEventListener('hashchange', bind); root.removeEventListener('kin-window-link-changed', bind); } };
  }
  const api = { normalize, scope, create, connect };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinViewerWindows = api;
})(globalThis);
