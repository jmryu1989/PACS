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
  // A viewer reports its outer geometry only; the receiving list validates it.
  function geometry(value) {
    if (!value || typeof value !== 'object') return null;
    const rect = { left: value.left, top: value.top, width: value.width, height: value.height };
    return Object.values(rect).every(Number.isFinite) && rect.left > -30000 && rect.top > -30000 &&
      rect.width >= 320 && rect.height >= 240 ? rect : null;
  }
  /* The reading screen's answer to a viewer's kin-editor-request (viewer-editor-link.js): the unsaved findings, conclusion and
   * recommendation exactly as typed, only for this login, only while the report target is the viewer's current study, no
   * dialog is open and the findings field can be used. It reads; it never saves, focuses or changes anything. The request's
   * own scope is echoed so the viewer can match the answer to what it asked. `reader` supplies the live page state. */
  const EDITOR_FIELDS = ['findings', 'conclusion', 'recommendation'];
  function editorReply(message, reader) {
    let m;
    try {
      m = message;
      if (!m || typeof m !== 'object' || m.type !== 'kin-editor-request' || !uuid(m.request) || typeof m.owner !== 'string' ||
          !Array.isArray(m.studies) || m.studies.length < 1 || m.studies.length > 2 || m.studies.some(v => typeof v !== 'string') ||
          typeof m.activeUid !== 'string' || m.activeUid !== m.studies[0]) return null;
      m = { request: m.request, owner: m.owner, studies: [...m.studies], activeUid: m.activeUid };
    } catch (_) { return null; }
    const reply = result => ({ type: 'kin-editor-reply', request: m.request, owner: m.owner, studies: m.studies, activeUid: m.activeUid, result });
    try {
      const owner = reader.owner();
      if (typeof owner !== 'string' || !owner || owner !== m.owner) return reply('session');
      if (reader.target() !== m.activeUid) return reply('context');
      if (reader.modal()) return reply('modal');
      const fields = EDITOR_FIELDS.map(id => reader.field(id));
      if (!fields[0] || !reader.usable(fields[0]) || fields.some(field => !field || typeof field.value !== 'string')) return reply('unavailable');
      const session = reader.session(m.owner, m.activeUid);
      if (typeof session !== 'string' || !session) return reply('unavailable');
      return { ...reply('ok'), session, editor: Object.fromEntries(EDITOR_FIELDS.map((key, i) => [key, fields[i].value])) };
    } catch (_) { return reply('unavailable'); }
  }
  /* The reading screen's answer to a viewer's kin-editor-open (viewer-editor-link.js open()): make the viewer's study the
   * report target and put the caret in Findings. The study must be a row of this list, the login the viewer's, and no
   * dialog open. The move is the page's own select(uid) - its study-move gate saves or refuses the text it holds - and
   * only its result is reported: ok only when that result is same, clear or saved and the target is that study now.
   * Nothing is saved, written or relayed here. eader supplies the live page state; the reply is a Promise. */
  const OPEN_STATUS = { composing: 'composing', refused: 'saving', unknown: 'saving', conflict: 'saving', owner: 'saving',
    stale: 'stale', stayed: 'stale', unresolved: 'unresolved', gone: 'gone' };
  async function editorOpen(message, reader) {
    let m;
    try {
      m = message;
      if (!m || typeof m !== 'object' || m.type !== 'kin-editor-open' || !uuid(m.request) || typeof m.owner !== 'string' || !m.owner ||
          typeof m.uid !== 'string' || m.uid.length > 64 || !/^\d+(?:\.\d+)+$/.test(m.uid)) return null;
      m = { request: m.request, owner: m.owner, uid: m.uid };
    } catch (_) { return null; }
    const reply = (result, reason = null) => ({ type: 'kin-editor-opened', request: m.request, owner: m.owner, uid: m.uid, result, reason });
    try {
      if (reader.owner() !== m.owner) return reply('refused', 'session');
      if (reader.busy?.()) return reply('refused', 'busy');
      if (!reader.listed(m.uid)) return reply('refused', 'unlisted');
      if (reader.modal()) return reply('refused', 'modal');
      let outcome;
      try { outcome = await reader.select(m.uid); } catch (_) { return reply('refused', 'unavailable'); }
      if (reader.owner() !== m.owner) return reply('refused', 'session');
      const status = outcome && typeof outcome === 'object' ? outcome.status : null;
      if (!['same', 'clear', 'saved'].includes(status)) return reply('refused', OPEN_STATUS[status] || 'unavailable');
      if (reader.target() !== m.uid) return reply('refused', 'stale');
      if (reader.modal()) return reply('refused', 'modal');
      const field = reader.field('findings');
      if (!field || !reader.usable(field)) return reply('refused', 'unavailable');
      reader.focus();
      return reply('ok');
    } catch (_) { return reply('refused', 'unavailable'); }
  }
  function create({ storage, owner, newId, origin, describe, changed = () => {}, placed = () => {} }) {
    const work=root.KinWorkContext;
    const bound = owner(), key = 'kin-viewer-windows:v1:' + bound;
    // This list document's own link id, never stored: a duplicated tab shares the stored group but not this id, and a reloaded
    // list has a new one. A viewer's editor request names it, so only the list document that last linked that window answers.
    let documentLink = null; try { documentLink = root.crypto.randomUUID(); } catch (_) { documentLink = null; }
    let state, error = null, ended = false, channel;
    const entries = Array.from({ length: 4 }, () => ({ popup: null, href: null, pending: null, document: null, committed: false }));
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
      if (any && persist(next)) { entries.forEach((entry, i) => { if (!next.slots[i]) { entry.popup = null; entry.href = null; entry.pending = null; entry.document = null; } }); changed(); }
    }
    function rows() {
      prune();
      return !state ? [] : entries.flatMap((entry, i) => {
        if (!state.slots[i]) return [];
        let status;
        try { status = entry.popup ? describe(entry.popup) : null; } catch (_) {}
        if (entry.pending && entry.document) {
          try { if (entry.popup.document !== entry.document) { entry.committed = true; entry.document = null; } }
          catch (_) { entry.committed = true; entry.document = null; }
        }
        const readyWithoutDocument = !entry.document && !entry.committed && status?.ready &&
          JSON.stringify(scope(status.href, origin)) === JSON.stringify(scope(entry.pending, origin));
        if (entry.pending && (entry.committed && status?.kind === 'viewer' || readyWithoutDocument)) {
          entry.pending = null; entry.document = null;
        }
        const href = entry.pending || status?.href || entry.href;
        if (entry.pending) status = { kind: 'pending', href, ready: false, busy: true, dirty: false };
        return [{ index: i, name: i === 0 ? 'kin-ohif-current' : 'kin-ohif-' + state.id + '-' + i,
          href, scope: scope(href, origin), status, pending: !!entry.pending, popup: entry.popup }];
      });
    }
    function choose(href, limit, options = {}) {
      if (!current() || error || !scope(href, origin)) return { error: error || '현재 계정과 영상 대상을 확인한 뒤 다시 여세요.' };
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) return { error: '영상 창 수 설정을 확인하세요.' };
      const singleWindow = options?.singleWindow === true;
      if (singleWindow) limit = 1;
      const freshDocument = options?.freshDocument === true && !singleWindow;
      const open = rows(), wanted = JSON.stringify(scope(href, origin));
      if (error) return { error };
      let row = freshDocument ? null : open.find(r => r.scope && JSON.stringify(r.scope) === wanted);
      if (!freshDocument && !row && limit === 1 && open.length === 1 && (singleWindow || open[0].index === 0)) row = open[0];
      if (row) return { ...row, fresh: false };
      if (open.length >= limit) return { full: true, error: freshDocument ? '새 영상 화면을 열 수 없습니다. Image Opening에서 Viewer Windows 수를 늘리거나 기존 영상 창의 작업을 저장하고 닫으세요.' : '영상 창 수 제한에 도달했습니다. Viewer Windows에서 기존 창으로 돌아가거나 저장 후 닫으세요.' };
      const index = state.slots.indexOf(false), next = normalize(state);
      next.slots[index] = true;
      if (!persist(next)) return { error };
      return { index, name: index === 0 ? 'kin-ohif-current' : 'kin-ohif-' + state.id + '-' + index, fresh: true };
    }
    function attach(choice, popup) {
      if (!current() || !state?.slots[choice.index] || !popup) return false;
      entries[choice.index].popup = popup; changed(); return true;
    }
    function navigating(choice, href, previousDocument) {
      if (!current() || !state?.slots[choice.index] || !scope(href, origin)) return;
      entries[choice.index].pending = entries[choice.index].href = new URL(href, origin).href;
      // Release the old document reference as soon as replacement is observed.
      // A restored Job or unverified new owner must not remain labelled Loading.
      entries[choice.index].committed = false;
      try { entries[choice.index].document = previousDocument || entries[choice.index].popup.document || null; } catch (_) { entries[choice.index].document = null; }
      changed();
    }
    function blocked(choice) {
      if (!choice.fresh || entries[choice.index].popup || !current()) return;
      const next = normalize(state); next.slots[choice.index] = false; persist(next); changed();
    }
    function linked(href, index) {
      const url = new URL(href, origin), hash = new URLSearchParams(url.hash.slice(1));
      hash.set('kin-window-group', state.id); hash.set('kin-window-slot', String(index));
      if (documentLink) hash.set('kin-window-list', documentLink);
      url.hash = hash.toString();
      return url.pathname + url.search + url.hash;
    }
    function refresh() { prune(); try { channel?.postMessage({ type: 'discover', owner: bound }); } catch (_) {} }
    function end() { ended = true; channel?.close(); entries.forEach(entry => { entry.popup = null; entry.href = null; entry.pending = null; entry.document = null; }); }
    function subscribe(){
    channel?.close();
    if (state && !error && typeof root.BroadcastChannel === 'function') {
      channel = new root.BroadcastChannel('kin-viewer-windows:' + state.id);
      const at=work.capture('document');
      channel.onmessage = e => work.commit(at,()=>{
        const m = e.data;
        // A viewer this list document linked asks for the reading screen's unsaved report body; the reading screen of this
        // same document answers (reading-workspace.js), and nothing answers while it is absent or for another document's link.
        if (m?.type === 'kin-editor-request') {
          if (!current() || !documentLink || m.list !== documentLink) return;
          let answer = null; try { answer = root.kinReadingEditorReply?.(m) ?? null; } catch (_) { answer = null; }
          if (answer) channel.postMessage(answer);
          return;
        }
        // The same viewer asks this document's reading screen to open its study (Open in Reading Screen). The answer
        // waits for the page's own move; it is sent only while this list and this channel are still the ones asked.
        if (m?.type === 'kin-editor-open') {
          if (!current() || !documentLink || m.list !== documentLink) return;
          let pending = null; try { pending = root.kinReadingEditorOpen?.(m) ?? null; } catch (_) { pending = null; }
          if (!pending) return;
          const asked = channel;
          Promise.resolve(pending).then(answer => { if (answer && asked === channel && current()) asked.postMessage(answer); }, () => {});
          return;
        }
        // The same viewer stopped waiting for that opening: the reading screen drops the move if it is still waiting.
        if (m?.type === 'kin-editor-open-cancel') {
          if (!current() || !documentLink || m.list !== documentLink) return;
          try { root.kinReadingEditorCancel?.(m); } catch (_) {}
          return;
        }
        // A viewer this list document linked asks where the list window stands (Monitors in Hanging Protocol: the worklist
        // monitor). Only this document answers, with its outer geometry now; it never moves.
        if (m?.type === 'where') {
          if (!current() || !documentLink || m.list !== documentLink || m.owner !== bound || !uuid(m.request)) return;
          let rect = null;
          try { rect = geometry({ left: root.screenX, top: root.screenY, width: root.outerWidth, height: root.outerHeight }); } catch (_) { rect = null; }
          channel.postMessage({ type: 'here', owner: bound, list: documentLink, request: m.request, rect });
          return;
        }
        if (!current() || m?.type !== 'present' || m.owner !== bound || !Number.isInteger(m.index) ||
            m.index < 0 || m.index > 3 || !state.slots[m.index] || !scope(m.href, origin)) return;
        if (entries[m.index].href !== m.href) { entries[m.index].href = m.href; changed(); }
        // A list that holds the window measures it itself, including while its
        // placement is pending. A reloaded list holds no handle, so a viewer the
        // reader moves afterwards would otherwise reopen at the old place.
        const rect = geometry(m.rect);
        if (rect && !entries[m.index].popup) placed(m.index, rect);
      });
      refresh();
    }
    }
    work.onInvalidate(event=>{if(event.reason==='cancel'||event.reason==='lifecycle'&&event.state==='active')subscribe();else if(event.reason==='lifecycle'&&event.state!=='preparing')end();});
    subscribe();
    return { choose, attach, navigating, blocked, linked, rows, refresh, end, available: () => current() && !error, error: () => error };
  }
  function connect({ owner, live }) {
    const work=root.KinWorkContext;
    let channel, ended = false, group, index, first = null, moved = false, reported = null, poll = null, listLink = null;
    const bound = JSON.stringify(owner());
    const identity = () => !ended && live() && JSON.stringify(owner()) === bound ? bound : null;
    root.kinViewerWindowOwner = identity;
    // Where the list document that linked this window stands now (its outer geometry), asked of that document alone;
    // null when it does not answer within 1.5 s, is gone, or this window was not opened from a list.
    function listPlace() {
      return new Promise(resolve => {
        const asked = channel, list = listLink;
        if (!asked || !list || !identity()) { resolve(null); return; }
        let request; try { request = root.crypto.randomUUID(); } catch (_) { resolve(null); return; }
        const done = value => { clearTimeout(timer); asked.removeEventListener('message', hear); resolve(value); };
        const hear = e => {
          const m = e.data;
          if (m?.type === 'here' && m.request === request && m.owner === bound && m.list === list && identity()) done(geometry(m.rect));
        };
        const timer = setTimeout(() => done(null), 1500);
        asked.addEventListener('message', hear);
        try { asked.postMessage({ type: 'where', owner: bound, list, request }); } catch (_) { done(null); }
      });
    }
    root.kinViewerListPlace = listPlace;
    // The first geometry this document sees can be a fallback its list has not
    // placed yet, or one kept after a failed placement; it never replaces the
    // saved place. Any later change is the reader's move (or the placement).
    // A minimized window is hidden (and reports far-off coordinates).
    function rect() {
      try { if (root.document.visibilityState === 'hidden') return null; } catch (_) { return null; }
      const value = geometry({ left: root.screenX, top: root.screenY, width: root.outerWidth, height: root.outerHeight });
      if (!value) return null;
      if (!first) { first = value; return null; }
      moved ||= JSON.stringify(value) !== JSON.stringify(first);
      return moved ? value : null;
    }
    function announce() {
      if (work.state()!=='active'||ended || !live() || JSON.stringify(owner()) !== bound || !channel) return;
      if (!scope(root.location.href, root.location.origin)) return;
      const place = rect(); reported = place && JSON.stringify(place);
      channel.postMessage({ type: 'present', owner: bound, index, href: root.location.href, ...(place ? { rect: place } : {}) });
    }
    function watch() { const place = rect(); if (place && JSON.stringify(place) !== reported) announce(); }
    function bind() {
      channel?.close(); channel = null; clearInterval(poll); poll = null;
      if (work.state()!=='active'||ended || !live() || JSON.stringify(owner()) !== bound) return;
      const hash = new URLSearchParams(root.location.hash.slice(1));
      const groups = hash.getAll('kin-window-group'), slots = hash.getAll('kin-window-slot');
      if (groups.length !== 1 || slots.length !== 1 || !uuid(groups[0]) || !/^[0-3]$/.test(slots[0])) return;
      group = groups[0]; index = Number(slots[0]);
      const lists = hash.getAll('kin-window-list'); listLink = lists.length === 1 && uuid(lists[0]) ? lists[0] : null;
      try {
        channel = new root.BroadcastChannel('kin-viewer-windows:' + group);
        const at=work.capture('document');channel.onmessage = e => work.commit(at,()=>{ if (e.data?.type === 'discover' && e.data.owner === bound) announce(); });
        announce();
        // Browsers announce no window move; the list polls its own handle at the same rate.
        poll = setInterval(() => work.commit(at, watch), 2000);
      } catch (_) { channel = null; }
    }
    let changed;
    function listen(){root.removeEventListener('hashchange',changed);root.removeEventListener('kin-window-link-changed',changed);const at=work.capture('document');changed=()=>work.commit(at,bind);root.addEventListener('hashchange',changed);root.addEventListener('kin-window-link-changed',changed);bind();}
    work.onInvalidate(event=>{if(event.reason==='cancel'||event.reason==='lifecycle'&&event.state==='active')listen();else if(event.reason==='lifecycle'&&event.state!=='preparing'){ended=true;channel?.close();clearInterval(poll);}});
    listen();
    return { dispose() { ended = true; if (root.kinViewerWindowOwner === identity) root.kinViewerWindowOwner = () => null; if (root.kinViewerListPlace === listPlace) root.kinViewerListPlace = () => Promise.resolve(null); channel?.close(); clearInterval(poll); root.removeEventListener('hashchange', changed); root.removeEventListener('kin-window-link-changed', changed); } };
  }
  const api = { normalize, scope, create, connect, editorReply, editorOpen };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinViewerWindows = api;
})(globalThis);
