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
  // The server's refusals, each with the Accession No of the study it is about (when the page knows it).
  const reason = (error, accOf = uid => uid) => {
    const refusals = Array.isArray(error?.body?.refusals) ? error.body.refusals : [];
    return refusals.length ? [...new Set(refusals.map(r => (r.uid ? accOf(r.uid) + ': ' : '') + r.message))]
      : [error?.message || '서버가 변경을 받지 않았습니다.'];
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
    // A study's Accession No as the list shows it (a merged exam's other studies included), else its UID.
    const accOf = uid => text(ctx.studies().flatMap(s => [s, ...(s.group?.members ?? [])]).find(s => s.uid === uid)?.acc ?? uid);

    // ── Merge Exam ──
    function openMerge() {
      if (!allowed() || !ready()) return;
      const sel = selected();
      if (!sel) { ctx.toast('기준 검사(Base)로 쓸 검사를 먼저 고르세요.', 'info'); return; }
      if (sel.group) { ctx.toast('이미 합친 검사입니다. 되돌리려면 Split / Unmerge를 쓰세요.', 'info'); return; }
      // The selected patient's studies first (so the candidates are in view without scrolling), the list order otherwise.
      const list = ctx.studies().filter(s => !s.group || s.uid === sel.uid)
        .sort((a, b) => (b.id === sel.id) - (a.id === sel.id));
      const win = openWindow('Merge Exam', 'merge');
      const checks = new Map(), bases = new Map();
      const summary = el('div', { className: 'order-status exam-merge-result', role: 'status', 'aria-live': 'polite' });
      const go = button('Merge', () => submit(), '체크한 검사를 기준 검사(Base) 하나로 합칩니다.');
      const picked = () => list.filter(s => checks.get(s.uid).checked);
      function recompute() {
        const rows = picked(), base = rows.find(s => bases.get(s.uid).checked) || null;
        const ids = [...new Set(rows.map(s => s.id))];
        go.disabled = true;
        if (rows.length < 2) summary.replaceChildren('합칠 검사를 2건 이상 체크하세요.');
        else if (ids.length > 1) summary.replaceChildren(el('span', { className: 'order-note warn', text: `다른 환자의 검사는 합칠 수 없습니다 (${ids.join(', ')}).` }));
        else if (!base) summary.replaceChildren('기준 검사(Base)를 고르세요.');
        else {
          go.disabled = false;
          const series = sum(rows, 'series'), images = sum(rows, 'count');
          summary.replaceChildren(
            el('div', { text: `결과: 검사 1건 (기준 ${text(base.acc)}, ${text(base.date)}) · 시리즈 ${count(series)} · 영상 ${count(images)}. ` +
              `원래 검사 ${rows.length}건의 묶음은 기록으로 남아 Unmerge로 되돌릴 수 있습니다.` }),
            el('div', { className: 'order-note muted', text: '판독문은 합치지 않습니다: 합친 검사는 기준 검사에서 판독합니다. ' +
              '영상은 바뀌지 않습니다 — Query/Retrieve·내보내기·병원 EMR은 원래 검사를 그대로 봅니다.' }));
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
      win.body.append(note('같은 환자의 검사를 기준 검사 하나로 합칩니다. 같은 날 검사는 미리 체크되어 있고 다른 날짜의 검사도 체크할 수 있습니다. ' +
        '다른 환자의 검사는 합칠 수 없습니다.'),
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
          summary.after(el('div', { className: 'exam-merge-refused' }, reason(error, accOf).map(m => note(m, 'err'))));
          go.disabled = false;
          return;
        }
        const total = sum(chosen, 'count');
        win.body.replaceChildren(note(`합쳤습니다: 검사 ${chosen.length}건 → ${text(base.acc)} (` +
          chosen.map(s => `${text(s.acc)} ${count(s.count)}장`).join(' + ') + ` = ${count(total)}장). ` +
          `합친 검사는 목록에서 빠지고 기준 행에 "Merged ×${chosen.length}"가 표시됩니다. Split / Unmerge로 되돌릴 수 있습니다.`, 'ok'));
        win.buttons(win.closeButton());
        await ctx.reload();
        ctx.select(base.uid);
      }
    }

    // ── Split / Unmerge ──
    async function openUnmerge() {
      if (!allowed() || !ready()) return;
      const sel = selected();
      if (!sel) { ctx.toast('되돌릴 검사를 먼저 고르세요.', 'info'); return; }
      const win = openWindow('Split / Unmerge Exam', 'unmerge');
      if (!sel.group) {
        win.body.append(note(`${text(sel.name)} ${text(sel.id)}: 합친 검사가 아닙니다.`, 'muted'));
        win.buttons(win.closeButton());
        return;
      }
      const members = sel.group.members;
      win.body.append(note('합친 검사를 원래 검사들로 되돌립니다. 시리즈와 영상은 각자의 검사로 돌아갑니다.'),
        table(['Original exam', 'StudyDate', 'StudyDesc', 'Series / Images back'],
          members.map(m => [m.acc, m.date, m.desc, seriesImages(m.series, m.count)])),
        el('h4', { text: 'Checks' }));
      const list = el('ul', { className: 'exam-merge-checks' }, el('li', { text: '확인 중…' }));
      const go = button('Unmerge', () => submit(), '원래 검사들로 되돌립니다.');
      go.disabled = true;
      win.body.append(list, note('합친 검사에 지금 승인된 판독문이 있거나(먼저 판독 취소(Reset)), 판독문을 쓰는 중이거나, ' +
        '전송·내보내기가 진행 중이면 되돌릴 수 없습니다. 합친 뒤 도착한 영상은 자기 검사에 그대로 남습니다.', 'muted'));
      win.buttons(go, win.closeButton());
      let answer;
      try { answer = await ctx.api('GET', '/studies/' + encodeURIComponent(sel.uid) + '/exam-group', undefined, undefined, ctx.work('document')); }
      catch (error) { if (error?.name !== 'AbortError') list.replaceChildren(el('li', { className: 'order-note err', text: reason(error, accOf).join(' ') })); return; }
      if (!answer?.group) { list.replaceChildren(el('li', { className: 'order-note warn', text: '이미 되돌린 검사입니다. 목록을 새로고침하세요.' })); return; }
      list.replaceChildren(...(answer.checks || []).map(c => el('li', { className: c.ok ? 'order-note ok' : 'order-note err', text: (c.ok ? '✓ ' : '✗ ') + c.message })));
      go.disabled = (answer.checks || []).some(c => !c.ok);
      async function submit() {
        go.disabled = true;
        try { await ctx.api('POST', '/exam-groups/' + encodeURIComponent(answer.group.id) + '/dissolve', undefined, undefined, ctx.work('document')); }
        catch (error) {
          if (error?.name === 'AbortError') return;
          list.after(el('div', {}, reason(error, accOf).map(m => note(m, 'err'))));
          return;
        }
        win.body.replaceChildren(note(`되돌렸습니다: 원래 검사 ${members.length}건 (` +
          members.map(m => `${text(m.acc)} ${count(m.count)}장`).join(', ') + ').', 'ok'));
        win.buttons(win.closeButton());
        await ctx.reload();
      }
    }

    // ── the selected study's report: which exam's images it is written on (above the editor's draft line) ──
    const scope = el('div', { className: 'exam-report-scope', role: 'status', hidden: true });
    document.getElementById('draftmsg')?.before(scope);
    function paintScope() {
      const s = selected();
      const active = s?.group, stored = s?.reportGroup;
      let line = '';
      if (active) line = `합친 검사(${active.members.map(m => text(m.acc)).join(' + ')})입니다 — 판독문은 이 검사 모두의 영상에 대한 것입니다.`;
      else if (stored && !stored.readable) line = '이 판독문은 합친 검사의 영상으로 썼고, 그 검사 일부를 볼 수 없어 본문을 보이지 않습니다.';
      else if (stored) line = `이 판독문은 합친 검사(${stored.studies.map(accOf).join(' + ')})의 영상으로 썼습니다` +
        (stored.active ? '.' : ' · 지금은 되돌린 상태(Unmerged)라 판독 취소(Reset) 뒤에 다시 판독합니다.');
      scope.hidden = !line;
      scope.replaceChildren(...(line ? [el('b', { text: 'Merged exam' }), ' — ' + line] : []));
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
          title: s.group.members.map(m => text(m.acc)).join(', ') + '을(를) 합친 검사입니다. Split / Unmerge로 되돌릴 수 있습니다.' }));
      }
    }
    const style = document.head.appendChild(el('style', { text: '.exam-merged{display:inline-block;margin-left:4px;padding:0 5px;border:1px solid #6b5a2e;border-radius:3px;color:#ffcf7a;font-size:11px;white-space:nowrap}.exam-merge-checks{margin:4px 0;padding-left:18px}.exam-report-scope{padding:2px 6px;font-size:12px;color:#ffcf7a}' }));
    const offRender = ctx.onRender(() => { roles(); paint(); paintScope(); });
    const offSelect = ctx.onSelect(paintScope);
    mergeButton.addEventListener('click', openMerge);
    unmergeButton.addEventListener('click', openUnmerge);
    paint();
    paintScope();
    return () => {
      offRender();
      offSelect();
      scope.remove();
      style.remove();
      mergeButton.removeEventListener('click', openMerge);
      unmergeButton.removeEventListener('click', openUnmerge);
      for (const badge of document.querySelectorAll('#rows .exam-merged')) badge.remove();
      for (const d of document.querySelectorAll('dialog[data-exam-window]')) d.remove();
    };
  });
})();
