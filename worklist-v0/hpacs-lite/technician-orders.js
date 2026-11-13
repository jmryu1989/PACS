/*
 * Technician Order List additions (a worklist add-on, window.KinWorklistAddOns):
 *   - the tab row: Order List (RIS) · Scheduled · Report (the panes come from technician-scheduled.js and
 *     technician-report.js through KinTechnicianPanes; this file draws the tabs and switches between them);
 *   - the action row under the tabs: Search Orders · Delete Order · Match… · Unmatch…;
 *   - Search Orders: a bar of conditions on the order rows (Scheduled from / to, State, Ward, ReqDoc) applied at once,
 *     together with the panel's own ID / Name / Modality / StudyDesc boxes. Reset clears them; Close only closes the bar
 *     and, while a condition is set, says so on the action row;
 *   - Delete Order: takes an unmatched order off this list with a reason (the server keeps who, when and why); Undo
 *     brings it back. No hospital RIS order is cancelled, and no image, study or report is deleted;
 *   - Match… / Unmatch…: the page's own Match / Unmatch (the right-click body) in a window that compares the study with
 *     the order field by field (≠ shows a difference and never refuses: Match corrects the study from the order), asks
 *     for a reason on Unmatch, and after success shows the values the list read back from the server.
 * Every request and change goes through the page (context.api, context.orders); nothing here holds its own order list.
 */
(function () {
  'use strict';
  const panes = new Map();
  /** technician-scheduled.js / technician-report.js register a pane: { label, show(host), hide?(), select?(uid), render?() }. */
  window.KinTechnicianPanes = Object.freeze({ register(key, pane) { if (!panes.has(key)) panes.set(key, pane); } });

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
  const same = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
  const button = (label, onClick, className, title) => {
    const b = el('button', { type: 'button', className, title });
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const table = (heads, rows) => el('table', { className: 'order-table' },
    el('thead', {}, el('tr', {}, heads.map(h => el('th', { text: h })))),
    el('tbody', {}, rows.map(r => r instanceof HTMLElement ? r : el('tr', {}, r.map(v => el('td', { text: text(v) }))))));
  const note = (message, kind = '') => el('p', { className: 'order-note ' + kind, text: message });

  /** A modal window (Esc and Close close it; it is removed when closed). */
  function openWindow(title, name) {
    const body = el('div', { className: 'order-dialog-body' }), foot = el('div', { className: 'order-dialog-foot' });
    const dialog = el('dialog', { className: 'order-dialog', 'aria-label': title, 'data-order-window': name },
      el('h3', { text: title }), body, foot);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    const close = () => { if (dialog.open) dialog.close(); };
    const buttons = (...list) => { foot.replaceChildren(...list); list.find(b => !b.disabled)?.focus(); };
    return { dialog, body, foot, close, buttons, closeButton: (label = 'Close') => button(label, close) };
  }

  (window.KinWorklistAddOns ||= []).push(function technicianOrders(ctx) {
    const panel = document.querySelector('.order-p'), tabs = panel?.querySelector('.reltabs');
    const actions = document.getElementById('order-actions'), search = document.getElementById('order-search');
    const paneHost = document.getElementById('order-pane'), grid = panel?.querySelector('.grid2');
    if (!panel || !tabs || !actions || !search || !paneHost || !grid) throw new Error('The Order List anchors are missing');
    const listTab = tabs.querySelector(':scope > div.on') || tabs.querySelector(':scope > div');
    const added = [];
    let current = null;

    // ── tabs ──
    const tabOf = new Map();
    let after = listTab;
    for (const [key, pane] of panes) {
      const tab = el('div', { role: 'tab', tabindex: '0', 'data-order-tab': key, text: pane.label });
      tab.addEventListener('click', () => showTab(key));
      tab.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(key); } });
      after.after(tab); after = tab; added.push(tab); tabOf.set(key, tab);
    }
    const backToList = () => showTab(null);
    listTab.addEventListener('click', backToList);
    const host = {
      ctx, element: paneHost,
      showList: () => showTab(null),
      openMatch: () => openMatch(),
      status: (message, undo) => setStatus(message, undo),
    };
    function showTab(key) {
      if (current === key) return;
      const leaving = current && panes.get(current);
      current = key;
      try { leaving?.hide?.(); } catch (error) { console.error(error); }
      listTab.classList.toggle('on', !key);
      for (const [k, tab] of tabOf) { tab.classList.toggle('on', k === key); tab.setAttribute('aria-selected', String(k === key)); }
      paneHost.hidden = !key; grid.hidden = !!key; actions.hidden = !!key;
      search.hidden = !!key || !searchOpen;
      if (!key) { paneHost.replaceChildren(); paneHost.removeAttribute('data-pane'); return; }
      paneHost.dataset.pane = key;
      try { panes.get(key).show(host); } catch (error) { console.error(error); paneHost.replaceChildren(note('This view could not be drawn.', 'err')); }
    }
    const offSelect = ctx.onSelect(uid => { if (current) { try { panes.get(current).select?.(uid); } catch (error) { console.error(error); } } });
    const offRender = ctx.onRender(() => { if (current) { try { panes.get(current).render?.(); } catch (error) { console.error(error); } } });

    // ── action row ──
    const status = el('span', { className: 'order-status', role: 'status', 'aria-live': 'polite' });
    const condition = el('span', { className: 'order-condition', hidden: true });
    actions.replaceChildren(
      button('Search Orders', () => toggleSearch(), '', 'Find orders by scheduled date, state, ward or requesting doctor.'),
      button('Delete Order', () => deleteOrder(), '', 'Take the selected order off this list. Images, studies and reports are not deleted.'),
      button('Match…', () => openMatch(), '', 'Compare the selected study with the selected order, then link them.'),
      button('Unmatch…', () => openUnmatch(), '', 'Unlink the selected study from its order and go back to the values read from its images.'),
      condition, status);
    actions.hidden = false;
    function setStatus(message, undo) {
      status.replaceChildren(message || '');
      if (undo) status.append(' ', button('Undo', undo));
    }

    // ── Search Orders ──
    const crit = { from: '', to: '', state: '', ward: '', doc: '' };
    let searchOpen = false;
    const active = () => Object.values(crit).some(Boolean);
    const removeFilter = ctx.orders.filter(o => {
      const day = String(o.sched ?? '').slice(0, 10);
      if (crit.from && day < crit.from) return false;
      if (crit.to && day > crit.to) return false;
      if (crit.state && o.matched !== crit.state) return false;
      if (crit.ward && !String(o.ward ?? '').toUpperCase().includes(crit.ward.toUpperCase())) return false;
      if (crit.doc && !String(o.reqDoc ?? '').toUpperCase().includes(crit.doc.toUpperCase())) return false;
      return true;
    });
    const count = el('span', { className: 'order-count', role: 'status' });
    const offOrders = ctx.orders.onRender(n => { count.textContent = n + ' orders'; showCondition(); });
    const inputs = {};
    const field = (key, label, type) => {
      const input = el('input', { type, 'aria-label': label, size: type === 'text' ? 8 : undefined });
      input.addEventListener('input', () => { crit[key] = input.value.trim(); ctx.orders.render(); });
      inputs[key] = input;
      return el('label', {}, label + ' ', input);
    };
    const state = el('select', { 'aria-label': 'State' },
      el('option', { value: '', text: 'All' }), el('option', { value: 'U', text: 'Unmatched' }), el('option', { value: 'M', text: 'Matched' }));
    state.addEventListener('change', () => { crit.state = state.value; ctx.orders.render(); });
    inputs.state = state;
    search.replaceChildren(field('from', 'Scheduled from', 'date'), field('to', 'to', 'date'), el('label', {}, 'State ', state),
      field('ward', 'Ward', 'text'), field('doc', 'ReqDoc', 'text'),
      button('Reset', () => resetSearch()), button('Close', () => toggleSearch(false)), count);
    function resetSearch() {
      for (const key of Object.keys(crit)) { crit[key] = ''; inputs[key].value = ''; }
      ctx.orders.render();
    }
    function toggleSearch(open = !searchOpen) {
      searchOpen = open; search.hidden = !open || !!current;
      if (open) inputs.from.focus();
      ctx.orders.render();
    }
    function showCondition() {
      const words = [crit.from && 'from ' + crit.from, crit.to && 'to ' + crit.to, crit.state && (crit.state === 'M' ? 'Matched' : 'Unmatched'),
        crit.ward && 'Ward ' + crit.ward, crit.doc && 'ReqDoc ' + crit.doc].filter(Boolean);
      condition.hidden = searchOpen || !words.length;
      condition.replaceChildren(...(words.length ? ['Order search: ' + words.join(' · ') + ' ', button('Reset', () => resetSearch())] : []));
    }

    // ── Delete Order ──
    const selectedOrder = () => { const oid = ctx.orders.selected(); return oid ? ctx.orders.list().find(o => o.oid === oid) ?? null : null; };
    function deleteOrder() {
      const o = selectedOrder();
      if (!o) { ctx.toast('Select an order to delete in Order List first.', 'info'); return; }
      const w = openWindow('Delete Order', 'order-delete');
      w.body.append(table(['Order', 'Patient', 'Scheduled', 'Exam', 'Accession', 'Ward · ReqDoc', 'Mt'],
        [[o.oid, `${o.name} (${o.id})`, o.sched, `${o.modality} ${o.desc}`, o.accession, `${text(o.ward)} · ${text(o.reqDoc)}`, o.matched]]));
      if (o.matched === 'M') {
        w.body.append(note('A matched order cannot be deleted. Unmatch it first.', 'warn'));
        w.buttons(w.closeButton()); return;
      }
      if (!ctx.allowed()) { w.body.append(note('Deleting an order needs the server connection.', 'warn')); w.buttons(w.closeButton()); return; }
      const reason = el('input', { size: 40, 'aria-label': 'Reason', required: true, placeholder: 'Example: duplicate order, cancelled order' });
      const result = el('p', { className: 'order-note', role: 'status' });
      w.body.append(note('This takes the order off this Order List only. Images, studies and reports are not deleted, and the hospital RIS order is not cancelled.'),
        el('label', { className: 'order-reason' }, 'Reason ', reason), result);
      const go = button('Delete Order', async () => {
        const why = reason.value.trim();
        if (!why) { reason.focus(); return; }
        go.disabled = true; result.textContent = 'Deleting…';
        try { await ctx.api('POST', '/orders/' + encodeURIComponent(o.oid) + '/remove', { reason: why }, undefined, ctx.work('document')); }
        catch (error) { if (error?.name === 'AbortError') return; result.textContent = 'Not deleted: ' + (error?.message || error); result.className = 'order-note err'; go.disabled = false; return; }
        w.close();
        await ctx.orders.refresh();
        setStatus(`Order ${o.oid} removed from the list.`, () => restore(o.oid));
      }, 'danger');
      go.disabled = true;
      reason.addEventListener('input', () => { go.disabled = !reason.value.trim(); });
      w.buttons(go, w.closeButton('Cancel'));
      reason.focus();
    }
    async function restore(oid) {
      setStatus('Restoring…');
      try { await ctx.api('POST', '/orders/' + encodeURIComponent(oid) + '/restore', undefined, undefined, ctx.work('document')); }
      catch (error) { if (error?.name !== 'AbortError') setStatus('Undo failed: ' + (error?.message || error)); return; }
      await ctx.orders.refresh();
      setStatus(`Order ${oid} is back on the list.`);
    }

    // ── Match… ──
    function shown(s) { return { acc: s.acc, id: s.id, name: s.name, desc: s.desc, ward: s.ward, mt: s.matched }; }
    function resultRows(before, after) {
      return [['Accession', before.acc, after?.acc], ['Patient ID', before.id, after?.id], ['Name', before.name, after?.name],
        ['StudyDesc', before.desc, after?.desc], ['Ward', before.ward, after?.ward], ['Mt', before.mt, after?.mt]];
    }
    function openMatch() {
      const uid = ctx.selectedUid(), s = uid ? ctx.study(uid) : null, o = selectedOrder();
      if (!s || !o) { ctx.toast('Select one study in Study List and one order in Order List first.', 'info'); return; }
      const w = openWindow('Match Study to Order', 'order-match');
      const cmp = [['Patient ID', s.id, o.id], ['Name', s.name, o.name], ['Sex', s.sex, o.sex], ['BirthDate', s.birth, o.birth],
        ['Modality', s.modality, o.modality], ['Exam', s.desc, o.desc], ['Date', s.date, String(o.sched ?? '').slice(0, 10)]];
      const rows = cmp.map(([k, a, b]) => {
        const ok = same(a, b);
        return el('tr', { className: ok ? '' : 'order-diff' }, el('td', { text: k }), el('td', { text: text(a) }), el('td', { text: text(b) }),
          el('td', { className: 'order-mark', text: ok ? '✓' : '≠' }));
      });
      const orderAcc = o.accession;
      rows.push(el('tr', { className: orderAcc && !same(s.acc, orderAcc) ? 'order-diff' : '' }, el('td', { text: 'Accession' }),
        el('td', { text: text(s.acc) }), el('td', { text: text(orderAcc) }),
        el('td', { className: 'order-mark', text: !orderAcc ? '—' : same(s.acc, orderAcc) ? '✓' : '≠',
          title: !orderAcc ? 'The order has no accession number; the study keeps its own.' : 'While matched, the study shows the order\'s accession number.' })));
      w.body.append(note('Link the study images to this order. The study takes the order\'s patient details and study description' +
        (orderAcc ? ' and shows the order\'s accession number' : '') + '. The images\' own DICOM values are not changed.'),
        table(['', `Study (${text(s.acc)})`, `Order (${o.oid})`, ''], rows));
      if (s.matched === 'M' || o.matched === 'M') {
        w.body.append(note('This study or this order is already matched. Unmatch it first.', 'warn'));
        w.buttons(w.closeButton()); return;
      }
      if (cmp.some(([, a, b]) => !same(a, b)))
        w.body.append(note('Values marked ≠ differ. Match replaces the study\'s patient details with the order\'s; check them before linking.', 'muted'));
      const result = el('p', { className: 'order-note', role: 'status' });
      w.body.append(result);
      const before = shown(s);
      const go = button('Match', async () => {
        go.disabled = true; result.textContent = 'Matching…';
        const r = await ctx.orders.match(s.uid, o.oid);
        if (!w.dialog.isConnected) return;
        if (!r.ok) { result.textContent = 'Not matched: ' + (r.message || 'refused'); result.className = 'order-note err'; go.disabled = false; return; }
        w.body.replaceChildren(note(`Matched: ${s.name} (${s.id}) ↔ ${o.oid}. Reading the result back…`, 'ok'));
        w.buttons(w.closeButton());
        const confirmed = await r.reloaded;
        if (!w.dialog.isConnected) return;
        const after = confirmed ? ctx.study(s.uid) : null;
        w.body.replaceChildren(note(`Matched: ${s.name} (${s.id}) ↔ ${o.oid}.`, 'ok'),
          table(['Field', 'Before', 'After (read back)'], resultRows(before, after && shown(after))));
        if (!after) w.body.append(note('The match was saved, but the list could not be read back. Check the row in Study List.', 'warn'));
        setStatus(`Matched ${s.id} ↔ ${o.oid}.`);
        w.buttons(w.closeButton());
      }, 'primary');
      w.buttons(go, w.closeButton());
    }

    // ── Unmatch… ──
    function openUnmatch() {
      const uid = ctx.selectedUid(), s = uid ? ctx.study(uid) : null;
      if (!s) { ctx.toast('Select a study to unlink in Study List.', 'info'); return; }
      const w = openWindow('Unmatch Study', 'order-unmatch');
      if (s.matched !== 'M') { w.body.append(note(`${s.name} (${s.id}) is not matched to an order.`, 'muted')); w.buttons(w.closeButton()); return; }
      const order = ctx.orders.list().find(o => o.studyUid === s.uid) ?? null;
      const read = ctx.orders.identity(s.uid);
      const before = shown(s);
      w.body.append(note('Unlink the study from its order. The study goes back to the values the server read from its images (DICOM), and the order returns to Unmatched.'),
        table(['Field', 'Now', 'Restored (from the images)'], [['Order', order?.oid, null], ...resultRows(before,
          read ? { acc: read.acc, id: read.id, name: read.name, desc: read.desc, ward: null, mt: 'U' } : { mt: 'U' }).filter(r => r[0] !== 'Ward')]));
      const reason = el('input', { size: 40, 'aria-label': 'Reason', required: true, placeholder: 'Example: linked to the wrong order' });
      const result = el('p', { className: 'order-note', role: 'status' });
      w.body.append(el('label', { className: 'order-reason' }, 'Reason ', reason), result);
      const go = button('Unmatch', async () => {
        const why = reason.value.trim();
        if (!why) { reason.focus(); return; }
        go.disabled = true; reason.disabled = true; result.textContent = 'Unmatching…';
        const r = await ctx.orders.unmatch(s.uid, why);
        if (!w.dialog.isConnected) return;
        if (!r.ok) { result.textContent = 'Not unmatched: ' + (r.message || 'refused'); result.className = 'order-note err'; go.disabled = false; reason.disabled = false; return; }
        w.body.replaceChildren(note(`Unmatched: ${s.name} (${s.id}). Reading the result back…`, 'ok'));
        w.buttons(w.closeButton());
        const confirmed = await r.reloaded;
        if (!w.dialog.isConnected) return;
        const after = confirmed ? ctx.study(s.uid) : null;
        const freed = confirmed && order ? ctx.orders.list().find(x => x.oid === order.oid) : null;
        w.body.replaceChildren(note(after
          ? `Unmatched: the study shows accession ${text(after.acc)} and ${text(after.desc)} again.` + (freed && freed.matched === 'U' ? ` Order ${freed.oid} is Unmatched again.` : '')
          : `Unmatched: ${s.name} (${s.id}).`, 'ok'),
          table(['Field', 'Before', 'Restored (read back)'], resultRows(before, after && shown(after)).filter(r => r[0] !== 'Ward')));
        if (!after) w.body.append(note('The unmatch was saved, but the list could not be read back. Check the row in Study List.', 'warn'));
        setStatus(`Unmatched ${s.id}.`);
        w.buttons(w.closeButton());
      }, 'primary');
      go.disabled = true;
      reason.addEventListener('input', () => { go.disabled = !reason.value.trim(); });
      w.buttons(go, w.closeButton());
      reason.focus();
    }

    return () => {
      showTab(null);
      for (const node of added) node.remove();
      listTab.removeEventListener('click', backToList);
      offSelect(); offRender(); offOrders(); removeFilter();
      actions.replaceChildren(); actions.hidden = true; search.replaceChildren(); search.hidden = true;
      for (const dialog of document.querySelectorAll('dialog[data-order-window]')) dialog.close();
    };
  });
})();
