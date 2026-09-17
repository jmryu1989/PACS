/* Findings section inside the Measurements panel. All decisions live in the store
 * (finding-link-model.js); this file only renders its state and forwards user actions.
 * Control names are English, messages Korean; external strings go through textContent. */
window.kinViewerFindings = function (services, model) {
  'use strict';
  let stop = () => {};
  function mount() {
    stop();
    const host = document.querySelector('#kin-viewer-history');
    if (!host) return false;
    const store = model.createStore({ fetch: (url, options) => window.fetch(url, options), uuid: () => crypto.randomUUID(),
      navigate: target => typeof window.kinViewerHistoryNavigate === 'function' ? window.kinViewerHistoryNavigate(target) : { ok: false, reason: 'tool-missing' } });
    const panel = document.createElement('details'); panel.id = 'kin-viewer-findings'; panel.open = true;
    panel.style.cssText = 'border-top:1px solid #405777;margin-top:10px;padding-top:8px';
    const text = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
    text(panel, 'summary', 'Findings');
    text(panel, 'p', '저장한 표식을 연결해 소견을 기록합니다. 소견의 수치는 연결 당시 서버 사본이며 표식의 현재 확인 상태와는 별개입니다.');
    // Not role=status and not <section> rows: the Measurements panel's own tests and scans address
    // `#kin-viewer-history [role=status]` and `#kin-viewer-history section` and must keep matching only theirs.
    const status = text(panel, 'p', '검사 확인 중…'); status.id = 'kin-viewer-findings-status'; status.setAttribute('aria-live', 'polite');
    const actions = document.createElement('div'), list = document.createElement('div'); panel.append(actions, list);
    host.append(panel);
    const button = (parent, label, run, disabled = false) => {
      const b = text(parent, 'button', label); b.type = 'button'; b.disabled = disabled;
      b.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
      b.addEventListener('click', () => Promise.resolve().then(run).catch(() => { status.textContent = '작업을 완료하지 못했습니다. 현재 내용을 확인하세요.'; })); return b;
    };
    const field = (parent, label, tag, value, max, change, disabled) => {
      const wrap = text(parent, 'label', label), el = document.createElement(tag);
      el.value = value; el.maxLength = max; el.disabled = disabled; el.setAttribute('aria-label', label);
      el.style.cssText = 'display:block;width:100%;background:#0c1423;color:#fff;border:1px solid #657c9f;padding:4px';
      el.addEventListener('input', () => change(el.value)); wrap.append(el); return el;
    };
    const names = { arrow: 'Arrow', key: 'Key Image', length: 'Length', angle: 'Angle', ellipse: 'Ellipse ROI' };
    const describe = h => (names[h.kind] || h.kind) + ' · ' + (h.label || '') + ' · 프레임 ' + h.frame + ' · r' + h.revision;
    const values = v => Array.isArray(v) && v.length ? ' · ' + v.map(n => Number.isFinite(n) ? (Math.round(n * 10) / 10).toFixed(1) : '?').join(' / ') : '';
    const rows = new Map();
    function sourceLine(parent, e, s, index, editing) {
      const link = (e.links || []).find(l => l.itemId === s.itemId) || null, head = store.state().heads.get(s.itemId) || null;
      const status = model.sourceStatus(s, e.head ? link : null, head);
      const line = text(parent, 'div', ''); line.dataset.itemId = s.itemId; line.dataset.linkState = status.linkState;
      line.style.cssText = 'margin:2px 0 2px 6px;padding-left:6px;border-left:2px solid #405777';
      const label = s.kind ? describe(s) + values(s.values) : head ? describe(head) : '표식 ' + s.itemId.slice(0, 8);
      text(line, 'span', (index === (e.head ? e.head.item.primary ?? 0 : e.draft.primary) ? '★ ' : '') + label + ' · ');
      const badge = text(line, 'strong', status.label); badge.dataset.kinLinkState = status.linkState;
      if (status.referenceLabel) text(line, 'span', ' · ' + status.referenceLabel);
      if (status.linkState === 'revised' && status.headRevision) text(line, 'span', ' (현재 r' + status.headRevision + ')');
      if (e.staleSource && e.staleSource.itemId === s.itemId) text(line, 'span', e.staleSource.headHidden ? ' · 서버에서 숨겨짐' : ' · 서버 최신판 r' + e.staleSource.headRevision);
      if (status.text && status.linkState !== 'current') text(line, 'p', status.text);
      if (e.head) {
        button(line, 'Go to Image', () => store.navigate(e, index), !!e.busy);
        if (store.writable(e) && status.linkState === 'revised' && !e.pending) button(line, 'Refresh Link', () => store.refreshSource(e, s.itemId), !!e.busy);
      }
      if (editing) {
        button(line, 'Unlink', () => store.toggleSource(e, s.itemId), !!(e.busy || e.pending));
        if (index !== e.draft.primary) button(line, 'Set Primary', () => store.setPrimary(e, index), !!(e.busy || e.pending));
      }
    }
    function selection(parent, e) {
      const heads = [...store.state().heads.values()].filter(h => !e.draft.sources.some(s => s.itemId === h.id));
      const box = text(parent, 'details', ''); box.open = true; text(box, 'summary', 'Link Saved Items');
      if (!heads.length) { text(box, 'p', '연결할 수 있는 저장 표식이 없습니다. 먼저 표식을 저장하세요.'); return; }
      for (const h of heads) {
        const wrap = text(box, 'label', ''); wrap.style.display = 'block';
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = false;
        check.disabled = !!(h.hidden || h.working || e.busy || e.pending || e.draft.sources.length >= model.LIMITS.sources);
        check.setAttribute('aria-label', 'Link ' + describe(h));
        check.addEventListener('change', () => { if (!store.toggleSource(e, h.id)) check.checked = false; });
        wrap.append(check, document.createTextNode(' ' + describe(h) + values(h.values) + (h.hidden ? ' · Hidden' : h.working ? ' · 미저장 수정 중' : '') +
          (h.referenceStatus ? ' · ' + (h.referenceStatus === 'verified' ? 'Verified' : 'Unverified') : '')));
      }
    }
    function row(e) {
      let el = rows.get(e);
      if (!el) { el = document.createElement('article'); el.dataset.rowKey = crypto.randomUUID(); el.style.cssText = 'border-top:1px solid #405777;margin-top:8px;padding-top:8px'; rows.set(e, el); list.append(el); }
      el.replaceChildren(); el.dataset.findingId = e.head?.id || ''; el.dataset.saved = e.head ? 'true' : 'false';
      text(el, 'strong', 'Finding · ' + (e.head ? 'Saved r' + e.head.revision : 'Unsaved') + (e.head?.hidden ? ' · Hidden' : ''));
      if (e.head) text(el, 'div', e.head.authorActor + (store.writable(e) ? ' · My Finding' : ' · Read-only'));
      const editing = e.editing && store.writable(e);
      if (editing) {
        field(el, 'Finding Title', 'input', e.draft.title, model.LIMITS.title, v => store.updateDraft(e, { title: v }), !!(e.busy || e.pending));
        field(el, 'Finding Text', 'textarea', e.draft.text, model.LIMITS.text, v => store.updateDraft(e, { text: v }), !!(e.busy || e.pending));
      } else {
        text(el, 'p', e.head ? e.head.item.title : e.draft.title).style.fontWeight = '600';
        const body = text(el, 'p', e.head ? e.head.item.text : e.draft.text); body.style.whiteSpace = 'pre-wrap';
      }
      const shown = e.head && !editing ? e.head.item.sources : e.draft.sources.map(pair => (e.head?.item.sources || []).find(s => s.itemId === pair.itemId && s.revision === pair.revision) || pair);
      const sources = text(el, 'div', ''); sources.dataset.kinSources = '';
      shown.forEach((s, index) => sourceLine(sources, e, s, index, editing));
      if (editing) selection(el, e);
      if (e.message) text(el, 'p', e.message).dataset.kinMessage = '';
      // Distinct from the per-source 'Go to Image' lines above, so neither name is ambiguous within a row.
      if (e.head && !editing) button(el, 'Go to Primary Image', () => store.navigate(e), !!e.busy);
      if (store.writable(e)) {
        if (e.pending) button(el, 'Retry Request', () => store.save(e), !!e.busy);
        else if (editing) {
          button(el, 'Save', () => store.save(e, e.head ? 'edit' : 'create'), !!e.busy || !!e.latest);
          button(el, e.head ? 'Cancel' : 'Discard Draft', () => store.discard(e), !!e.busy);
        } else if (e.head && !e.head.hidden) button(el, 'Edit', () => store.edit(e), !!e.busy);
        if (e.head && !editing && !e.pending) button(el, e.head.hidden ? 'Restore' : 'Hide', () => {
          const reason = window.prompt((e.head.hidden ? '복원' : '숨김') + ' 사유');
          if (reason?.trim()) store.save(e, e.head.hidden ? 'restore' : 'hide', reason);
        }, !!e.busy);
        if (e.latest && !e.pending) button(el, 'Use Latest & Keep Changes', () => store.useLatest(e), !!e.busy);
      }
      if (e.head) button(el, 'History', async () => {
        const history = document.createElement('div'); el.append(history); let cursor = null, count = 0;
        const more = async () => {
          const data = await store.history(e, cursor);
          if (!data || !el.isConnected) return;
          for (const r of data.revisions) text(history, 'p', 'r' + r.revision + ' · ' + ({ create: '생성', edit: '수정', hide: '숨김', restore: '복원' }[r.action] || r.action) + ' · ' + r.actor + ' · ' + r.at + ' · ' + r.reason + ' · ' + r.item.title + ' · 표식 ' + r.item.sources.length + '개');
          count += data.revisions.length; cursor = data.nextCursor;
          if (cursor && count < 1000) button(history, 'Load More History', more);
        };
        await more();
      });
    }
    function render() {
      const s = store.state();
      status.textContent = s.status;
      panel.dataset.studyUid = s.scope || '';
      actions.replaceChildren();
      // A distinct accessible name: the Measurements panel already owns the exact name 'Refresh'.
      button(actions, 'Reload Findings', () => store.load(), s.ended || !s.scope);
      button(actions, 'New Finding', () => store.newDraft(), s.ended || s.suspended || !store.writable());
      if (!s.ended && !s.suspended && !store.writable()) text(actions, 'span', ' Read-only');
      for (const [e, el] of [...rows]) if (!s.entries.has(e.id) || s.entries.get(e.id) !== e) { el.remove(); rows.delete(e); }
      for (const e of s.entries.values()) row(e);
    }
    const unsubscribe = store.subscribe(render);
    // The Measurements panel owns scope, session and saved heads; observe it at the same cadence.
    const timer = setInterval(() => { try { store.syncHistory(typeof window.kinViewerHistoryState === 'function' ? window.kinViewerHistoryState() : null); } catch (_) {} }, 250);
    const onStorage = e => { if (e.key === 'kin-session-ended') store.end(); };
    let channel; try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') store.end(); }; } catch (_) {}
    window.addEventListener('storage', onStorage); window.addEventListener('kin-viewer-access-ended', store.end);
    window.kinViewerFindingsState = () => ({ scope: store.state().scope, dirty: [...store.state().entries.values()].some(store.hasWork) });
    const state = window.kinViewerFindingsState;
    stop = () => {
      clearInterval(timer); unsubscribe(); channel?.close(); window.removeEventListener('storage', onStorage); window.removeEventListener('kin-viewer-access-ended', store.end);
      if (window.kinViewerFindingsState === state) delete window.kinViewerFindingsState;
      store.dispose(); panel.remove(); rows.clear(); stop = () => {};
    };
    render();
    return true;
  }
  return { mount, stop: () => stop() };
};
