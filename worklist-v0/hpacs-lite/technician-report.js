/*
 * Technician Order List · Report tab: the report of the study selected in Study List, read only, with Copy Report.
 * The text comes from what the page already holds for that study (the list and its state), never from a new read. Only
 * an Approved report shows its text and can be copied; any other state shows the status and that the report is not final
 * yet (a display rule of this tab, not a permission). The status is the row's own RS.
 */
(function () {
  'use strict';
  const RS_WORD = { W: 'Unread', T: 'In Progress', P: 'Preliminary', H: 'On Hold', A: 'Approved', D: 'Destroyed' };
  let view = null;   // { host, shown }
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null) { if (k === 'text') node.textContent = v; else if (k === 'className') node.className = v; else node.setAttribute(k, v); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  };
  const pad = n => String(n).padStart(2, '0');
  const when = iso => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };

  /** What the pane shows for the selected study; repainted only when this changes (a copy message stays otherwise). */
  function snapshot() {
    const ctx = view.host.ctx, uid = ctx.selectedUid(), s = uid ? ctx.study(uid) : null;
    const r = s ? ctx.report.read(uid) : null;
    return { uid: s ? uid : null, s, r, key: JSON.stringify([s?.uid, s?.name, s?.id, s?.desc, r]) };
  }
  function paint(force) {
    if (!view) return;
    const now = snapshot();
    if (!force && view.shown === now.key) return;
    view.shown = now.key;
    const { s, r } = now;
    const head = el('div', { className: 'order-pane-head' }, el('b', { text: 'Report' }), ' ',
      el('small', { className: 'order-note muted', text: 'Technologists cannot edit or approve reports.' }));
    if (!s) { view.host.element.replaceChildren(head, el('p', { className: 'order-note muted', text: 'Select a study in Study List.' })); return; }
    const meta = el('div', { className: 'order-note', text: `${s.name} · ${s.id} · ${s.desc || s.modality || ''}` });
    const rs = r?.rs ?? s.rs ?? 'W';
    const written = !!(r && (r.findings || r.conclusion || r.recommendation));
    if (rs === 'W' && !written) {
      view.host.element.replaceChildren(head, meta, el('p', { className: 'order-note', 'data-report-state': 'unread', text: 'No report has been written yet (Unread).' }));
      return;
    }
    if (rs !== 'A') {
      view.host.element.replaceChildren(head, meta,
        el('div', {}, el('span', { className: 'order-badge open', 'data-report-state': 'not-final', text: (RS_WORD[rs] || rs) + ' · Not Approved' })),
        el('p', { className: 'order-note', text: 'The report is not final yet.' }));
      return;
    }
    const status = el('span', { className: 'order-note', role: 'status', 'aria-live': 'polite' });
    const copy = el('button', { type: 'button', text: 'Copy Report' });
    copy.addEventListener('click', async () => {
      const lines = [`[Approved] ${s.name} ${s.id} ${s.date || ''} ${s.desc || ''}`.trim(), 'Findings:', r.findings || '', 'Conclusion:', r.conclusion || ''];
      if (r.recommendation) lines.push('Recommendation:', r.recommendation);
      try { await navigator.clipboard.writeText(lines.join('\n')); status.textContent = 'Report copied to the clipboard.'; }
      catch (_) { status.textContent = 'Could not copy: clipboard access is blocked.'; }
    });
    const by = [r.repDoc, r.approvedAt ? 'Approved ' + when(r.approvedAt) : r.confirm].filter(Boolean).join(' · ');
    const block = (title, value) => value ? [el('h5', { text: title }), el('pre', { className: 'order-report-text', text: value })] : [];
    view.host.element.replaceChildren(head, meta,
      el('div', {}, el('span', { className: 'order-badge ok', 'data-report-state': 'approved', text: 'Approved' }), by ? ' ' + by + ' ' : ' ', copy, ' ', status),
      ...block('Findings', r.findings || ' '), ...block('Conclusion', r.conclusion || ' '), ...block('Recommendation', r.recommendation));
  }

  window.KinTechnicianPanes?.register('report', {
    label: 'Report',
    show(host) { view = { host, shown: null }; paint(true); },
    hide() { view = null; },
    select() { paint(false); },
    render() { paint(false); },
  });
})();
