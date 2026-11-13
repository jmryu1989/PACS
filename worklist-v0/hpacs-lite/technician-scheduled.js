/*
 * Technician Order List · Scheduled tab: today's orders on this list (the order's scheduled date = the screen's local
 * date) with what the image archive holds for each, read from the server (GET /orders/scheduled). Each order keeps its
 * own state — Matched, No images yet (the archive was asked and has none), Not checked (the archive did not answer, or
 * the order cannot be looked up), or images found for the patient that day that are not matched to it (each with how its
 * accession compares) — and none is shown as another. A row's detail says which, with Retry Check where a check can be
 * repeated and Open Match… for a study found. The orders are this institution's order list (Engineering Only: no
 * hospital order feed is connected).
 */
(function () {
  'use strict';
  const LABEL = { matched: 'Matched', no_images: 'No images yet', lookup_failed: 'Not checked', not_checkable: 'Not checked' };
  const ENGINEERING = '권위 있는 병원 오더 출처(HL7/FHIR)가 연결되지 않았습니다. 이 오더 목록과 대사 결과는 엔지니어링 확인 전용이며 예정 환자 목록으로 쓰면 안 됩니다.';
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const reconciliation = o => o.state !== 'images_found' ? LABEL[o.state] ?? '—'
    : o.candidates.some(c => c.relation === 'match') ? 'Accession matches'
      : o.candidates.some(c => c.relation === 'mismatch') ? 'Accession differs' : 'Not matched';
  const images = o => o.state === 'matched' && Number.isInteger(o.images) ? o.images + ' images' : '—';
  const relationText = (c, o) => c.relation === 'match' ? 'same as the order'
    : c.relation === 'mismatch' ? 'differs from the order\'s ' + o.accession
      : !o.accession ? 'the order has no accession number' : 'the study has no accession number';

  let view = null;   // { host, day, orders, selected, loading, error }
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (v !== undefined && v !== null) { if (k === 'text') node.textContent = v; else if (k === 'className') node.className = v; else node.setAttribute(k, v); }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  };
  const button = (label, onClick) => { const b = el('button', { type: 'button', text: label }); b.addEventListener('click', onClick); return b; };

  async function read(oid) {
    const ctx = view.host.ctx, day = view.day;
    const at = ctx.work('document');
    const answer = await ctx.api('GET', '/orders/scheduled?day=' + encodeURIComponent(day) + (oid ? '&oid=' + encodeURIComponent(oid) : ''), undefined, undefined, at);
    if (!answer || !Array.isArray(answer.orders)) throw new Error('The answer could not be read.');
    return answer.orders;
  }
  async function load() {
    const mine = view;
    mine.loading = true; mine.error = null; paint();
    try { const orders = await read(); if (view !== mine) return; mine.orders = orders; }
    catch (error) { if (view !== mine || error?.name === 'AbortError') return; mine.error = error?.message || String(error); }
    mine.loading = false; paint();
  }
  async function retry(oid) {
    const mine = view, at = mine.orders.findIndex(o => o.oid === oid);
    mine.checking = oid; paint();
    try {
      const [again] = await read(oid);
      if (view !== mine) return;
      if (again) mine.orders[at] = again; else mine.orders.splice(at, 1);
      mine.checked = again ? oid : null;
    } catch (error) { if (view !== mine || error?.name === 'AbortError') return; mine.checkError = error?.message || String(error); }
    mine.checking = null; paint();
  }

  function detail(o) {
    const box = el('div', { className: 'order-detail', role: 'region', 'aria-label': 'Scheduled order detail' },
      el('b', { text: `${o.name} · ${o.id} · ${o.desc}` }), el('br'));
    const line = (kind, message) => box.append(el('span', { className: 'order-note ' + kind, text: message }));
    if (view.checking === o.oid) { line('muted', 'Checking the archive again…'); return box; }
    if (o.state === 'matched')
      line('ok', 'Matched — linked to a study' + (Number.isInteger(o.images) ? ` with ${o.images} images.` : '; the archive has no images for it yet.'));
    else if (o.state === 'no_images')
      line('muted', 'No images yet — no study of this patient on this date has arrived. Check again after the scan.');
    else if (o.state === 'lookup_failed')
      line('warn', 'Lookup failed — the image archive did not respond, so image availability could not be checked. This does not mean there are no images.');
    else if (o.state === 'not_checkable')
      line('warn', 'Not checked — the order has no patient ID the archive can be searched with.');
    else {
      line('warn', 'Images of this patient on this date are in the archive but not matched to this order:');
      const list = el('ul');
      for (const c of o.candidates) list.append(el('li', {}, `${c.desc || 'Study'} · Accession ${c.accession || '(none)'} (${relationText(c, o)}) · ${c.images} images `,
        button('Open Match…', () => openMatch(o, c))));
      box.append(list);
    }
    if (o.state === 'lookup_failed' || o.state === 'no_images') box.append(' ', button('Retry Check', () => retry(o.oid)));
    if (view.checked === o.oid) box.append(el('div', { className: 'order-note muted', text: 'Checked again just now.' }));
    if (view.checkError) { box.append(el('div', { className: 'order-note err', text: 'Retry Check failed: ' + view.checkError })); view.checkError = null; }
    return box;
  }
  async function openMatch(o, c) {
    const host = view.host, { ctx } = host;
    if (!ctx.study(c.uid)) { ctx.toast('That study is not in the Study List now. Refresh the list and try again.', 'info'); return; }
    // The study is selected through the page's own gate; Match… opens only on the pair the person picked.
    await ctx.select(c.uid);
    if (ctx.selectedUid() !== c.uid) return;
    if (!ctx.orders.select(o.oid)) { ctx.toast('That order is not in the Order List now. Refresh the Order List and try again.', 'info'); return; }
    host.showList();
    host.openMatch();
  }

  function paint() {
    if (!view) return;
    const { element } = view.host;
    const head = el('div', { className: 'order-pane-head' }, el('b', { text: 'Scheduled Studies — ' + view.day }), ' ',
      el('span', { className: 'order-engineering', title: ENGINEERING, text: 'Engineering Only' }), ' ', button('Refresh', () => load()));
    if (view.loading && !view.orders) { element.replaceChildren(head, el('p', { className: 'order-note muted', text: 'Checking the archive…' })); return; }
    if (view.error && !view.orders) { element.replaceChildren(head, el('p', { className: 'order-note err', text: 'Scheduled orders could not be read: ' + view.error })); return; }
    const orders = view.orders || [];
    const rows = orders.map(o => {
      const tr = el('tr', { 'data-oid': o.oid, 'data-state': o.state, className: view.selected === o.oid ? 'sel' : '' },
        [String(o.sched ?? '').slice(11) || o.sched, o.id, o.name, o.desc, images(o), reconciliation(o)].map(v => el('td', { text: v || '—' })));
      tr.addEventListener('click', () => { view.selected = o.oid; view.checked = null; paint(); });
      return tr;
    });
    const tableEl = el('table', { className: 'order-table' },
      el('thead', {}, el('tr', {}, ['Scheduled', 'ID', 'Name', 'Exam', 'Images', 'Reconciliation'].map(h => el('th', { text: h })))),
      el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: '6', className: 'empty', text: 'No orders scheduled for today.' }))));
    const picked = orders.find(o => o.oid === view.selected);
    element.replaceChildren(head, view.error ? el('p', { className: 'order-note err', text: 'Not refreshed: ' + view.error }) : '', tableEl,
      picked ? detail(picked) : el('p', { className: 'order-note muted', text: 'Select a scheduled order to see whether its images have arrived.' }));
  }

  window.KinTechnicianPanes?.register('scheduled', {
    label: 'Scheduled',
    show(host) { view = { host, day: today(), orders: null, selected: null, loading: false, error: null, checking: null, checked: null }; load(); },
    hide() { view = null; },
  });
})();
