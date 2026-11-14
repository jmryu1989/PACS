/*
 * Merge Exam · Split / Unmerge (a worklist add-on, window.KinWorklistAddOns; the two buttons sit in the Technician button
 * row right after Unverify).
 *   - Merge Exam: the selected study is the Base; the window lists the loaded studies (the selected patient's first, those of
 *     the same patient ID and date ticked), each with a Merge tick and a Base choice. The result line says what one exam the
 *     ticked studies make; studies of different patients are refused on the spot (the Merge button is off) and again by the
 *     server, which also refuses a study with a report written or approved, a draft, a reader writing it, a transfer or export
 *     in progress, or one already merged. Nothing in any image changes: the server keeps a record that groups the studies.
 *   - Split / Unmerge: for a merged exam, the original studies it goes back to and the server's checks; Unmerge ends the record.
 *   - The merged exam's row shows `Merged ×N · M img` next to its Accession No (the other studies are no longer listed).
 * Requests go through the page (context.api); the list is read again after a change.
 */
(function () {
  'use strict';
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
    return node;
  };
  const text = value => value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);
  const button = (label, onClick, title) => {
    const b = el('button', { type: 'button', title });
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const note = (message, kind = '') => el('p', { className: 'order-note ' + kind, text: message });
  const RS_WORD = { W: 'Unread', T: 'In Progress', P: 'Preliminary', H: 'On Hold', A: 'Approved', D: 'Destroyed' };
  const count = value => Number.isInteger(value) ? String(value) : '?';
  const seriesImages = (series, images) => count(series) + ' / ' + count(images);
  const sum = (rows, key) => rows.some(r => !Number.isInteger(r[key])) ? null : rows.reduce((a, r) => a + r[key], 0);

  /** A modal window (Esc and Close close it; removed when closed). Same look as the Technician Order List windows. */
  function openWindow(title, name) {
    const body = el('div', { className: 'order-dialog-body' }), foot = el('div', { className: 'order-dialog-foot' });
    const dialog = el('dialog', { className: 'order-dialog exam-merge-dialog', 'aria-label': title, 'data-exam-window': name },
      el('h3', { text: title }), body, foot);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    const close = () => { if (dialog.open) dialog.close(); };
    const buttons = (...list) => { foot.replaceChildren(...list); list.find(b => !b.disabled)?.focus(); };
    return { dialog, body, foot, close, buttons, closeButton: (label = 'Close') => button(label, close) };
  }
  const table = (heads, rows) => el('table', { className: 'order-table' },
    el('thead', {}, el('tr', {}, heads.map(h => el('th', { text: h })))),
    el('tbody', {}, rows.map(r => r instanceof HTMLElement ? r : el('tr', {}, r.map(v => v instanceof Node ? el('td', {}, v) : el('td', { text: text(v) }))))));
  const reason = error => {
    const refusals = Array.isArray(error?.body?.refusals) ? error.body.refusals : [];
    return refusals.length ? [...new Set(refusals.map(r => r.message))] : [error?.message || 'The server did not accept the change.'];
  };

  (window.KinWorklistAddOns ||= []).push(function examMerge(ctx) {
    const mergeButton = document.getElementById('t-merge-exam'), unmergeButton = document.getElementById('t-split-unmerge');
    if (!mergeButton || !unmergeButton) throw new Error('The Merge Exam buttons are missing');
    // Like Verify / Unverify: technician (admin passes). The roles are known once the session is read, so the buttons follow
    // them on every list drawing (the session's first list included).
    const allowed = () => ctx.has('technician') || ctx.has('admin');
    const titles = new Map([mergeButton, unmergeButton].map(b => [b, b.title]));
    function roles() {
      for (const b of [mergeButton, unmergeButton]) {
        b.disabled = !allowed();
        b.title = allowed() ? titles.get(b) : '방사선사(technician) 권한이 필요합니다';
      }
    }
    roles();
    const ready = () => {
      if (!ctx.allowed()) { ctx.toast('서버에 연결된 상태에서만 검사를 합치거나 되돌릴 수 있습니다.', 'err'); return false; }
      return true;
    };
    const selected = () => { const uid = ctx.selectedUid(); return uid ? ctx.study(uid) : null; };

    // ── Merge Exam ──
    function openMerge() {
      if (!allowed() || !ready()) return;
      const sel = selected();
      if (!sel) { ctx.toast('Select a base study first.', 'info'); return; }
      if (sel.group) { ctx.toast('This study is already a merged exam. Use Split / Unmerge to restore it.', 'info'); return; }
      // The selected patient's studies first (so the candidates are in view without scrolling), the list order otherwise.
      const list = ctx.studies().filter(s => !s.group || s.uid === sel.uid)
        .sort((a, b) => (b.id === sel.id) - (a.id === sel.id));
      const win = openWindow('Merge Exam', 'merge');
      const checks = new Map(), bases = new Map();
      const summary = el('div', { className: 'order-status exam-merge-result', role: 'status', 'aria-live': 'polite' });
      const go = button('Merge', () => submit(), 'Merge the ticked studies into the Base study.');
      const picked = () => list.filter(s => checks.get(s.uid).checked);
      function recompute() {
        const rows = picked(), base = rows.find(s => bases.get(s.uid).checked) || null;
        const ids = [...new Set(rows.map(s => s.id))];
        go.disabled = true;
        if (rows.length < 2) summary.replaceChildren('Select at least two studies to merge.');
        else if (ids.length > 1) summary.replaceChildren(el('span', { className: 'order-note warn', text: `Cannot merge studies from different patients (${ids.join(', ')}).` }));
        else if (!base) summary.replaceChildren('Select the base study.');
        else {
          go.disabled = false;
          const series = sum(rows, 'series'), images = sum(rows, 'count');
          summary.replaceChildren(
            el('div', { text: `Result: 1 exam (base ${text(base.acc)}, ${text(base.date)}) with ${count(series)} series, ${count(images)} images. ` +
              `The original grouping of ${rows.length} studies is kept so Unmerge can restore it.` }),
            el('div', { className: 'order-note muted', text: 'Reports are not merged: the merged exam is reported on the Base study. ' +
              'No image is changed — Query/Retrieve, export and the hospital EMR keep the original studies.' }));
        }
      }
      const rows = list.map(s => {
        const sameDay = s.id === sel.id && s.date === sel.date;
        const c = el('input', { type: 'checkbox', checked: s.uid === sel.uid || sameDay, 'aria-label': 'Merge ' + text(s.acc) });
        const b = el('input', { type: 'radio', name: 'exam-merge-base', checked: s.uid === sel.uid, 'aria-label': 'Base ' + text(s.acc) });
        checks.set(s.uid, c); bases.set(s.uid, b);
        c.addEventListener('change', recompute); b.addEventListener('change', () => { c.checked = true; recompute(); });
        return el('tr', { 'data-uid': s.uid }, el('td', {}, c), el('td', {}, b), el('td', { text: text(s.id) }), el('td', { text: text(s.name) }),
          el('td', { text: text(s.date) }), el('td', { text: text(s.desc) }), el('td', { text: text(s.acc) }),
          el('td', { text: seriesImages(s.series, s.count) }), el('td', { text: RS_WORD[s.rs] || text(s.rs) }));
      });
      // The result line sits above the list so it is on screen with the ticked rows.
      win.body.append(note('Merge studies of the same patient into one base study. The same patient\'s studies of the same day are ticked; ' +
        'other dates can be ticked too. Studies of different patients cannot be merged.'),
        summary, table(['Merge', 'Base', 'ID', 'Name', 'StudyDate', 'StudyDesc', 'Accession No', 'Series / Images', 'Report'], rows));
      win.buttons(go, win.closeButton());
      recompute();
      async function submit() {
        const chosen = picked(), base = chosen.find(s => bases.get(s.uid).checked);
        if (!base || go.disabled) return;
        go.disabled = true;
        try {
          await ctx.api('POST', '/exam-groups', { baseUid: base.uid, uids: chosen.map(s => s.uid) }, undefined, ctx.work('document'));
        } catch (error) {
          if (error?.name === 'AbortError') return;
          win.body.querySelector('.exam-merge-refused')?.remove();
          summary.after(el('div', { className: 'exam-merge-refused' }, reason(error).map(m => note(m, 'err'))));
          go.disabled = false;
          return;
        }
        const total = sum(chosen, 'count');
        win.body.replaceChildren(note(`Merged: ${chosen.length} exams → ${text(base.acc)} (` +
          chosen.map(s => `${text(s.acc)} ${count(s.count)} images`).join(' + ') + ` = ${count(total)} images). ` +
          `The merged studies are no longer listed and the base row shows "Merged ×${chosen.length}". Use Split / Unmerge to restore them.`, 'ok'));
        win.buttons(win.closeButton());
        await ctx.reload();
        ctx.select(base.uid);
      }
    }

    // ── Split / Unmerge ──
    async function openUnmerge() {
      if (!allowed() || !ready()) return;
      const sel = selected();
      if (!sel) { ctx.toast('Select a study to restore first.', 'info'); return; }
      const win = openWindow('Split / Unmerge Exam', 'unmerge');
      if (!sel.group) {
        win.body.append(note(`${text(sel.name)} ${text(sel.id)}: this study is not a merged exam.`, 'muted'));
        win.buttons(win.closeButton());
        return;
      }
      const members = sel.group.members;
      win.body.append(note('Restore the merged exam to its original studies, each with its own series and images.'),
        table(['Original exam', 'StudyDate', 'StudyDesc', 'Series / Images back'],
          members.map(m => [m.acc, m.date, m.desc, seriesImages(m.series, m.count)])),
        el('h4', { text: 'Checks' }));
      const list = el('ul', { className: 'exam-merge-checks' }, el('li', { text: 'Checking…' }));
      const go = button('Unmerge', () => submit(), 'Restore the original studies.');
      go.disabled = true;
      win.body.append(list, note('Unmerge is refused while the merged exam has an approved report (Reset it to Unread first), ' +
        'a report is being written, or a transfer or export is in progress. Images that arrived after the merge stay with their own study.', 'muted'));
      win.buttons(go, win.closeButton());
      let answer;
      try { answer = await ctx.api('GET', '/studies/' + encodeURIComponent(sel.uid) + '/exam-group', undefined, undefined, ctx.work('document')); }
      catch (error) { if (error?.name !== 'AbortError') list.replaceChildren(el('li', { className: 'order-note err', text: reason(error).join(' ') })); return; }
      if (!answer?.group) { list.replaceChildren(el('li', { className: 'order-note warn', text: 'This exam is no longer merged. Refresh the list.' })); return; }
      list.replaceChildren(...(answer.checks || []).map(c => el('li', { className: c.ok ? 'order-note ok' : 'order-note err', text: (c.ok ? '✓ ' : '✗ ') + c.message })));
      go.disabled = (answer.checks || []).some(c => !c.ok);
      async function submit() {
        go.disabled = true;
        try { await ctx.api('POST', '/exam-groups/' + encodeURIComponent(answer.group.id) + '/dissolve', undefined, undefined, ctx.work('document')); }
        catch (error) {
          if (error?.name === 'AbortError') return;
          list.after(el('div', {}, reason(error).map(m => note(m, 'err'))));
          return;
        }
        win.body.replaceChildren(note(`Unmerged: ${members.length} original exams restored (` +
          members.map(m => `${text(m.acc)} ${count(m.count)} images`).join(', ') + ').', 'ok'));
        win.buttons(win.closeButton());
        await ctx.reload();
      }
    }

    // ── badge on the merged exam's row (next to its Accession No) ──
    function paint() {
      const byUid = new Map(ctx.studies().filter(s => s.group).map(s => [s.uid, s]));
      for (const tr of document.querySelectorAll('#rows tr[data-uid]')) {
        const cell = tr.querySelector('td.acc'), s = byUid.get(tr.dataset.uid);
        const old = cell?.querySelector('.exam-merged');
        if (!cell) continue;
        if (!s) { old?.remove(); continue; }
        const label = `Merged ×${s.group.members.length} · ${count(s.count)} img`;
        if (old && old.textContent === label) continue;
        old?.remove();
        cell.append(' ', el('span', { className: 'exam-merged', text: label,
          title: 'Merged exam of ' + s.group.members.map(m => text(m.acc)).join(', ') + '. Split / Unmerge restores them.' }));
      }
    }
    const style = document.head.appendChild(el('style', { text: '.exam-merged{display:inline-block;margin-left:4px;padding:0 5px;border:1px solid #6b5a2e;border-radius:3px;color:#ffcf7a;font-size:11px;white-space:nowrap}.exam-merge-checks{margin:4px 0;padding-left:18px}' }));
    const offRender = ctx.onRender(() => { roles(); paint(); });
    mergeButton.addEventListener('click', openMerge);
    unmergeButton.addEventListener('click', openUnmerge);
    paint();
    return () => {
      offRender();
      style.remove();
      mergeButton.removeEventListener('click', openMerge);
      unmergeButton.removeEventListener('click', openUnmerge);
      for (const badge of document.querySelectorAll('#rows .exam-merged')) badge.remove();
      for (const d of document.querySelectorAll('dialog[data-exam-window]')) d.remove();
    };
  });
})();
