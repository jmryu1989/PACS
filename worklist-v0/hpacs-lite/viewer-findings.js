/* Findings section inside the Measurements panel. All decisions live in the store
 * (finding-link-model.js); this file only renders its state and forwards user actions.
 * Control names are English, messages Korean; external strings go through textContent. */
window.kinViewerFindings = function (services, model) {
  'use strict';
  let stop = () => {};
  // Drafts held across a mode exit of this same document, in memory only. They return only through
  // the next store's authenticated load; a logout clears them even while no section is mounted.
  let held = [];
  const keep = records => { if (Array.isArray(records) && records.length) held = held.concat(records); };
  const dropHeld = () => { held = []; };
  window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') dropHeld(); });
  try { const session = new BroadcastChannel('kin-session'); session.onmessage = e => { if (e.data?.type === 'session-ended') dropHeld(); }; } catch (_) {}
  window.addEventListener('kin-viewer-access-ended', e => { if (e?.kinModeExit !== true) dropHeld(); });
  window.addEventListener('beforeunload', e => { if (held.length) { e.preventDefault(); e.returnValue = ''; } });
  // This document's study set in URL order: the first study anchors the section, the second is its comparison study.
  function urlStudies() {
    try {
      const values = new URLSearchParams(location.search).getAll('StudyInstanceUIDs');
      return values.length === 1 ? values[0].split(',') : null;
    } catch (_) { return null; }
  }
  function mount() {
    stop();
    const host = document.querySelector('#kin-viewer-history');
    if (!host) return false;
    const studies = urlStudies();
    const store = model.createStore({ fetch: (url, options) => window.fetch(url, options), uuid: () => crypto.randomUUID(), recovered: held, studies,
      navigate: target => typeof window.kinViewerHistoryNavigate === 'function' ? window.kinViewerHistoryNavigate(target) : { ok: false, reason: 'tool-missing' },
      history: () => typeof window.kinViewerHistoryState === 'function' ? window.kinViewerHistoryState() : null,
      activate: study => typeof window.kinViewerHistoryActivate === 'function' ? window.kinViewerHistoryActivate(study) : { ok: false, reason: 'tool-missing' } });
    held = [];
    const panel = document.createElement('details'); panel.id = 'kin-viewer-findings'; panel.open = true;
    panel.style.cssText = 'border-top:1px solid #405777;margin-top:10px;padding-top:8px';
    const text = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
    text(panel, 'summary', 'Findings');
    text(panel, 'p', '저장한 표식을 연결해 소견을 기록합니다. 소견의 수치는 연결 당시 서버 사본이며 표식의 현재 확인 상태와는 별개입니다.');
    // Not role=status and not <section> rows: the Measurements panel's own tests and scans address
    // `#kin-viewer-history [role=status]` and `#kin-viewer-history section` and must keep matching only theirs.
    const status = text(panel, 'p', '검사 확인 중…'); status.id = 'kin-viewer-findings-status'; status.setAttribute('aria-live', 'polite');
    const recovery = text(panel, 'p', ''); recovery.id = 'kin-viewer-findings-held'; recovery.hidden = true;
    // Two-study viewer: the product limits of comparison sources, in the user's terms.
    const pairNote = text(panel, 'p', '비교 화면에서는 첫 검사(현재 검사)의 소견만 표시합니다. 비교 검사 영상 칸을 선택해도 목록과 작성 중인 내용은 그대로입니다. ' +
      '소견 하나에는 같은 환자의 비교 검사 하나에서만 표식을 연결할 수 있고, 다른 비교 검사는 새 소견으로 기록합니다. ' +
      '비교 검사를 볼 수 없게 되면 그 검사를 연결한 소견은 목록에서 빠집니다. 소견 저장 한도에는 이 화면에 표시되지 않는 소견도 포함됩니다.');
    pairNote.id = 'kin-viewer-findings-pair-note'; pairNote.hidden = !store.pairOf();
    const pairStatus = text(panel, 'p', ''); pairStatus.id = 'kin-viewer-findings-comparison'; pairStatus.hidden = true;
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
    // Copied numbers with names and units only for a known provenance (S2-V); a source's are its frozen revision's.
    const values = (h, provenance) => { const t = model.valueText(h.kind, h.calculator, h.values, provenance); return t ? ' · ' + t : ''; };
    const rows = new Map();
    function sourceLine(parent, e, s, index, editing) {
      const st = store.state(), study = store.studyOf(e, s), own = study === st.scope;
      const link = (e.links || []).find(l => l.itemId === s.itemId) || null, head = (own ? st.heads : st.pair.heads).get(s.itemId) || null;
      const status = model.sourceStatus(s, e.head ? link : null, head);
      const line = text(parent, 'div', ''); line.dataset.itemId = s.itemId; line.dataset.linkState = status.linkState;
      line.dataset.sourceStudy = own ? 'current' : 'comparison';
      line.style.cssText = 'margin:2px 0 2px 6px;padding-left:6px;border-left:2px solid ' + (own ? '#405777' : '#b08a3c');
      // Nothing copied from a comparison study that this login can no longer read stays on screen.
      const withheld = !own && st.pair.status === 'denied';
      const label = withheld ? '접근할 수 없는 비교 검사의 표식' : s.kind ? describe(s) + values(s, 'server-copy') : head ? describe(head) : '표식 ' + s.itemId.slice(0, 8);
      const tag = own ? (store.pairOf() ? '[현재 검사] ' : '') : '[비교 검사] ';
      text(line, 'span', tag + (index === (e.head ? e.head.item.primary ?? 0 : e.draft.primary) ? '★ ' : '') + label + ' · ');
      const badge = text(line, 'strong', status.label); badge.dataset.kinLinkState = status.linkState;
      if (status.referenceLabel) text(line, 'span', ' · ' + status.referenceLabel);
      if (status.linkState === 'revised' && status.headRevision) text(line, 'span', ' (현재 r' + status.headRevision + ')');
      if (e.staleSource && e.staleSource.itemId === s.itemId) text(line, 'span', e.staleSource.headHidden ? ' · 서버에서 숨겨짐' : ' · 서버 최신판 r' + e.staleSource.headRevision);
      if (status.text && status.linkState !== 'current') text(line, 'p', status.text);
      if (e.head) {
        button(line, 'Go to Image', () => store.navigate(e, index), !!e.busy || withheld);
        if (store.writable(e) && status.linkState === 'revised' && !e.pending && !store.pairBlocked(e)) button(line, 'Refresh Link', () => store.refreshSource(e, s.itemId), !!e.busy);
      }
      if (editing) {
        button(line, 'Unlink', () => store.toggleSource(e, s.itemId), !!(e.busy || e.pending));
        if (index !== e.draft.primary) button(line, 'Set Primary', () => store.setPrimary(e, index), !!(e.busy || e.pending));
      }
    }
    // `provenance`: 'live-head' for this document's Measurements heads, 'server-copy' for the comparison list.
    function choices(box, e, heads, name, study, provenance) {
      for (const h of heads) {
        const wrap = text(box, 'label', ''); wrap.style.display = 'block';
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = false;
        check.disabled = !!(h.hidden || h.working || e.busy || e.pending || e.draft.sources.length >= model.LIMITS.sources || (study && study.blocked));
        check.setAttribute('aria-label', name + describe(h));
        check.addEventListener('change', () => { if (!store.toggleSource(e, h.id, study ? study.uid : undefined)) check.checked = false; });
        wrap.append(check, document.createTextNode(' ' + describe(h) + values(h, provenance) + (h.hidden ? ' · Hidden' : h.working ? ' · 미저장 수정 중' : '') +
          (h.referenceStatus ? ' · ' + (h.referenceStatus === 'verified' ? 'Verified' : 'Unverified') : '')));
      }
    }
    function selection(parent, e) {
      const st = store.state(), pair = store.pairOf(), linked = id => e.draft.sources.some(s => s.itemId === id);
      const heads = store.anchorLive() ? [...st.heads.values()].filter(h => !linked(h.id)) : [];
      const box = text(parent, 'details', ''); box.open = true; text(box, 'summary', 'Link Saved Items');
      if (!store.anchorLive()) text(box, 'p', '현재 검사의 표식은 현재 검사의 영상 칸을 선택하면 연결할 수 있습니다.');
      else if (!heads.length) text(box, 'p', '연결할 수 있는 저장 표식이 없습니다. 먼저 표식을 저장하세요.');
      choices(box, e, heads, 'Link ', null, 'live-head');
      if (!pair) return;
      // The comparison study's own saved list; an entry that already names another comparison study cannot add these.
      const other = store.comparisonOf(e), blocked = !!other && other !== pair;
      const group = text(parent, 'details', ''); group.open = true; group.dataset.kinComparison = pair;
      text(group, 'summary', 'Link Comparison Items');
      const note = { idle: '비교 검사 표식을 확인하지 않았습니다. Reload Comparison Items로 확인하세요.', loading: '비교 검사 표식 확인 중…',
        denied: '비교 검사에 접근할 수 없어 표식을 연결할 수 없습니다.', failed: '비교 검사 표식을 확인하지 못했습니다. Reload Comparison Items로 다시 확인하세요.' }[st.pair.status];
      if (blocked) text(group, 'p', '이 소견에는 다른 비교 검사의 표식이 있어 이 비교 검사의 표식을 연결할 수 없습니다. 새 소견으로 기록하세요.');
      else if (note) text(group, 'p', note);
      const pairHeads = st.pair.status === 'ready' ? [...st.pair.heads.values()].filter(h => !linked(h.id)).map(h => ({ ...h, working: st.pair.working.has(h.id) })) : [];
      if (st.pair.status === 'ready' && !pairHeads.length) text(group, 'p', '연결할 수 있는 비교 검사 저장 표식이 없습니다.');
      choices(group, e, pairHeads, 'Link Comparison ', { uid: pair, blocked }, 'server-copy');
      button(group, 'Reload Comparison Items', () => store.loadPair(), st.pair.status === 'loading' || !!e.busy);
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
        } else if (e.head && !e.head.hidden && !store.pairBlocked(e)) button(el, 'Edit', () => store.edit(e), !!e.busy);
        if (e.head && !editing && !e.pending && !store.pairBlocked(e)) button(el, e.head.hidden ? 'Restore' : 'Hide', () => {
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
      // Held drafts are named by count and study only, so the unsaved-work guards never fire with nothing to resolve.
      const kept = store.held();
      recovery.hidden = !kept.count; recovery.dataset.count = String(kept.count);
      recovery.textContent = kept.count ? '보관 중인 소견 작성 내용 ' + kept.count + '건 · ' + kept.studies.map(r => (r.current ? '현재 검사 ' : '다른 검사 ') + r.scope + ' ' + r.count + '건').join(' · ') +
        ' · 해당 검사의 영상 칸을 선택하면 접근과 계정을 확인한 뒤 복원합니다. 현재 검사는 Reload Findings로 다시 확인하세요.' : '';
      if (kept.count && !s.ended) button(actions, 'Discard Held Drafts', () => {
        if (window.confirm('보관 중인 소견 작성 내용 ' + store.held().count + '건을 버립니다. 결과를 확인하지 못한 저장 요청은 서버에 이미 저장되었을 수 있습니다. 계속할까요?')) store.discardHeld();
      });
      const pair = store.pairOf();
      pairNote.hidden = !pair; pairStatus.hidden = !pair; panel.dataset.comparisonUid = pair; panel.dataset.comparisonState = pair ? s.pair.status : '';
      pairStatus.textContent = !pair ? '' : '비교 검사 ' + pair + ' · ' + ({ idle: '표식 확인 전', loading: '표식 확인 중…',
        ready: '연결할 수 있는 저장 표식 ' + s.pair.heads.size + '개', denied: '접근할 수 없음(그 검사를 연결한 소견은 표시하지 않습니다)',
        failed: '표식을 확인하지 못했습니다' }[s.pair.status] || '');
      // A finding that names a comparison study this login can no longer read is not shown unless the
      // user is working on it; the anchor list read that follows removes it for good.
      const shown = e => s.entries.get(e.id) === e && !(store.pairBlocked(e) && !store.hasWork(e));
      for (const [e, el] of [...rows]) if (!shown(e)) { el.remove(); rows.delete(e); }
      for (const e of s.entries.values()) if (shown(e)) row(e);
    }
    const unsubscribe = store.subscribe(render);
    // The Measurements panel owns scope, session and saved heads; observe it at the same cadence.
    const timer = setInterval(() => { try { store.syncHistory(typeof window.kinViewerHistoryState === 'function' ? window.kinViewerHistoryState() : null); } catch (_) {} }, 250);
    const onStorage = e => { if (e.key === 'kin-session-ended') store.end(); };
    let channel; try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') store.end(); }; } catch (_) {}
    // The Measurements panel announces both a real session end and its own mode exit; only the
    // former destroys drafts, the latter hands them to the next mode entry of this document.
    const onAccessEnded = e => { if (e?.kinModeExit === true) keep(store.detach()); else store.end(); };
    window.addEventListener('storage', onStorage); window.addEventListener('kin-viewer-access-ended', onAccessEnded);
    window.kinViewerFindingsState = () => ({ scope: store.state().scope, ...store.workState() });
    const state = window.kinViewerFindingsState;
    stop = () => {
      clearInterval(timer); unsubscribe(); channel?.close(); window.removeEventListener('storage', onStorage); window.removeEventListener('kin-viewer-access-ended', onAccessEnded);
      keep(store.detach());
      if (window.kinViewerFindingsState === state) delete window.kinViewerFindingsState;
      store.dispose(); panel.remove(); rows.clear(); stop = () => {};
    };
    render();
    return true;
  }
  return { mount, stop: () => stop() };
};
