/* W5 Related Report mode: reading a related study's approved report while writing the current one (design v5 section 1,
 * D1244; O4 answer D1423 R2/R3/R6).
 *
 * The page keeps everything that belongs to the Reading Target: its editor, its Draft command state and the settlement of
 * an inserted operation (an operation outlives this mode: Back, a Source move and a new mode never end it). This module owns
 * only what the mode adds: its lifecycle and generation, the two identity cards, the Source display context, the
 * confirmation of one explicit Insert and the one-shot admission that lets exactly that native edit through while every
 * other write and report command stays blocked. The Source is read-only text: it never becomes an editor value, a draft, a
 * save or recovery snapshot. Only the reviewed insertion string reaches the Target, by the page's own native edit.
 *
 * Minhoon item 8 (2026-10-27): the mode is shown inside the Related panel and the editor stays on screen with the current
 * draft. Holding the editor is therefore `inert` only: it is not focusable or editable, and an Insert lands in front of
 * the reader's eyes.
 */
(function (root) {
  'use strict';
  const SOURCE_FIELDS = Object.freeze(['findings', 'conclusion', 'recommendation']);
  const SECTIONS = Object.freeze(['findings', 'conclusion']);
  const OPTIONAL_FIELDS = Object.freeze(['recommendation']);
  const LABEL = Object.freeze({ findings: 'Findings', conclusion: 'Conclusion', recommendation: 'Recommendation' });
  const ACTION = Object.freeze({ approve: 'Approved', addendum: 'Addendum' });
  const UNKNOWN = '확인할 수 없음';
  const REASON = 'Related Report 모드에서는 쓸 수 없습니다 — Back to Current Draft로 돌아간 뒤 사용하세요.';
  const lf = value => String(value ?? '').replace(/\r\n?/g, '\n');

  /** A surrogate pair is one character: no range boundary may fall between its two code units. */
  function splitsPair(text, at) {
    if (at <= 0 || at >= text.length) return false;
    const before = text.charCodeAt(at - 1), after = text.charCodeAt(at);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  }

  /**
   * The Source parts of one Insert (R1): at most one non-empty range per field, in findings/conclusion/recommendation order,
   * as UTF-16 offsets over the LF-normalised field text. Null when they cannot be sent as they are.
   */
  function validParts(parts, texts) {
    if (!Array.isArray(parts) || !parts.length || parts.length > SOURCE_FIELDS.length) return null;
    let last = -1;
    for (const part of parts) {
      const index = SOURCE_FIELDS.indexOf(part?.field), text = texts?.[part?.field];
      if (index <= last || typeof text !== 'string' || !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end)
          || part.start < 0 || part.end <= part.start || part.end > text.length
          || splitsPair(text, part.start) || splitsPair(text, part.end)) return null;
      last = index;
    }
    return Object.freeze(parts.map(part => Object.freeze({ field: part.field, start: part.start, end: part.end })));
  }

  /**
   * The insertion string of R1, built the way the server rebuilds it: the parts' LF text joined by two LFs, after a prefix
   * that is '' when the seed section is empty or ends with LF and '\n' otherwise, appended at the section's end. No trim and
   * no Unicode normalisation: the reader confirms these exact characters.
   */
  function insertion(seedSection, parts, texts) {
    const seed = String(seedSection);
    const body = parts.map(part => texts[part.field].slice(part.start, part.end)).join('\n\n');
    return Object.freeze({ offset: seed.length, text: (seed === '' || seed.endsWith('\n') ? '' : '\n') + body });
  }

  function mount(app) {
    const doc = document;
    const node = id => {
      const found = doc.getElementById(id);
      if (!found) throw new Error('Related Report mode: #' + id + ' is missing');
      return found;
    };
    const section = node('related-mode'), title = node('related-mode-title'), back = node('related-mode-back');
    const targetCard = node('related-mode-target'), sourceCard = node('related-mode-source'), status = node('related-mode-status');
    const insertButton = node('related-mode-insert'), dialog = node('related-insert-dialog');
    const dialogTarget = node('related-insert-target'), dialogSource = node('related-insert-source');
    const dialogPosition = node('related-insert-position'), dialogText = node('related-insert-text');
    const dialogError = node('related-insert-error'), confirmButton = node('related-insert-confirm');
    const cancelButton = node('related-insert-cancel');
    // The one Notice's Discard Insert (its markup comes with this mode): shown only for a confirmed refused operation.
    const noticeDiscardButton = node('report-notice-discard');
    let noticeOperation = null;
    const shown = Object.fromEntries(SOURCE_FIELDS.map(field => {
      const el = section.querySelector('[data-related-source="' + field + '"]');
      if (!el) throw new Error('Related Report mode: the ' + field + ' text block is missing');
      return [field, el];
    }));
    const sections = Object.fromEntries(SOURCE_FIELDS.map(field => {
      const box = shown[field].closest('.related-mode-section');
      if (!box) throw new Error('Related Report mode: the ' + field + ' section is missing');
      return [field, box];
    }));
    const sourceState = section.querySelector('.related-mode-state');
    if (!sourceState) throw new Error('Related Report mode: the Source state line is missing');
    const editor = app.editor();
    if (!editor) throw new Error('Related Report mode: the report editor host is missing');

    let state = null;        // the open mode: { generation, target, selectionSeq, owner, opening, point, inserted }
    let generation = 0;      // every enter and exit is a new generation: late work of an older one never reaches the screen
    let source = Object.freeze({ seq: -1, uid: null, state: 'idle' });   // the Source display context (R6)
    let confirming = null;   // the open confirmation: { generation, parts, source }
    let admission = null;    // the one-shot native-edit admission of the Insert being confirmed (R2)
    let closing = 0;         // a close this module makes itself, so its own close handler stays out of the way
    let held = null;         // what the page had on the editor host before the mode held it (only W5's own change is undone)
    let lastField = 'findings';

    // The field the reader worked in: a row click moves focus away from the editor before the mode opens.
    editor.addEventListener('focusin', event => {
      if (SECTIONS.includes(event.target?.id) && app.field(event.target.id) === event.target) lastField = event.target.id;
    });

    function holdEditor() {
      if (held) return;
      held = { inert: editor.inert };
      editor.inert = true;
    }
    function releaseEditor() {
      if (!held) return;
      editor.inert = held.inert;
      held = null;
    }
    /**
     * R2: during one explicit native edit only the restriction this mode put on the editor is lifted, in the same synchronous
     * span, and put back right after. A hidden/inert/readOnly state the page had for its own reasons stays: the edit then
     * meets it and is refused.
     */
    function withEditor(run) {
      const was = held;
      if (was) editor.inert = was.inert;
      try { return run(); }
      finally { if (was && held === was) editor.inert = true; }
    }

    function capturePoint() {
      const active = doc.activeElement;
      const field = SECTIONS.includes(active?.id) && app.field(active.id) === active ? active.id : lastField;
      const el = app.field(field);
      // Every scroll position between the field and the page: which box scrolls depends on the layout and the window.
      const scrolls = [];
      for (let box = el; box; box = box.parentElement) scrolls.push([box, box.scrollTop, box.scrollLeft]);
      return Object.freeze({ field, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection,
        value: el.value, scrolls: Object.freeze(scrolls) });
    }

    // The status row is one line in the Related panel; its tooltip keeps the whole sentence.
    function say(text) { status.textContent = text; status.title = text; }

    function rows(card, heading, entries, extra) {
      const nodes = [];
      const head = doc.createElement('h4');
      head.textContent = heading;
      nodes.push(head);
      for (const [label, value] of entries) {
        const line = doc.createElement('div'), name = doc.createElement('span'), text = doc.createElement('span');
        line.className = 'related-mode-line';
        name.className = 'related-mode-label';
        name.textContent = label;
        text.textContent = value === null || value === undefined || value === '' ? UNKNOWN : String(value);
        line.append(name, text);
        nodes.push(line);
      }
      if (extra) nodes.push(...extra);
      card.replaceChildren(...nodes);
    }
    const pair = (...values) => values.filter(value => value !== null && value !== undefined && value !== '').join(' · ') || null;

    function renderTarget() {
      const t = app.target();
      if (!t) { rows(targetCard, 'Reading Target', [['Patient', null]]); return; }
      rows(targetCard, 'Reading Target', [
        ['Patient', pair(t.name, t.id)], ['Institution', t.institution], ['Study', pair(t.date, t.desc)],
        ['Accession', t.acc], ['Report', t.version === null || t.version === undefined ? null : 'v' + t.version + (t.rs ? ' · RS ' + t.rs : '')],
        ['Draft', t.draft]]);
    }

    function sourceLine(view) {
      if (view.state !== 'ready') return null;
      return pair(view.version === null || view.version === undefined ? null : 'v' + view.version, ACTION[view.action] || view.action,
        view.author, view.at);
    }
    const SOURCE_STATE = {
      idle: '이전 판독문을 고르세요.',
      loading: '승인 판독문을 불러오는 중입니다…',
      failed: '이전 판독문을 불러오지 못했습니다 (Load Failed). Retry를 누르면 다시 읽습니다.',
      restricted: '이 판독문을 볼 권한이 없습니다 (Access Restricted).',
      none: '이 검사에는 승인된 판독문이 없습니다.',
      unavailable: '이 검사는 지금 목록에 없어 판독문을 보일 수 없습니다 (환자 식별 불일치·목록 조건 변경 포함).',
    };
    function sourceView() {
      const s = app.source();
      if (!s) return { identity: null, view: { state: 'unavailable' } };
      if (s.unresolved) return { identity: s, view: { state: 'unavailable', message: s.unresolved } };
      return { identity: s, view: source.uid === s.uid ? source : { state: 'idle' } };
    }
    function renderSource() {
      const { identity, view } = sourceView();
      const badge = doc.createElement('div');
      badge.className = 'related-mode-badge';
      badge.textContent = 'READ ONLY';
      const extra = [badge];
      const note = doc.createElement('div');
      note.className = 'related-mode-note';
      note.setAttribute('lang', 'ko');
      const ready = view.state === 'ready';
      note.textContent = ready ? '비교 중인 검사의 판독문입니다.' : view.message || SOURCE_STATE[view.state] || SOURCE_STATE.idle;
      extra.push(note);
      // Minhoon item 8: the mode stands in the Related panel's place for the plain view, so without a report its first
      // line says why (loading, failed, none) where the text would be, instead of empty section headings.
      sourceState.hidden = ready;
      sourceState.textContent = ready ? '' : note.textContent;
      if (view.state === 'failed') {
        const retry = doc.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => { if (state) app.reloadSource(); });
        extra.push(retry);
      }
      rows(sourceCard, 'Source Study', [
        ['Patient', identity && pair(identity.name, identity.id)], ['Institution', identity?.institution],
        ['Study', identity && pair(identity.date, identity.desc)], ['Accession', identity?.acc], ['Report', sourceLine(view)]], extra);
      for (const field of SOURCE_FIELDS) {
        const text = view.state === 'ready' ? view.texts?.[field] ?? '' : '';
        if (shown[field].textContent !== text) shown[field].textContent = text;
        // W-07b: Findings and Conclusion are the two report sections. A stored Recommendation is shown read-only only when it
        // has text, so an empty heading never shows and a whole-report Insert never carries text the reader did not see.
        sections[field].hidden = !ready || OPTIONAL_FIELDS.includes(field) && !text;
      }
    }

    function insertReason() {
      if (!state) return REASON;
      const { view } = sourceView();
      if (view.state !== 'ready' || !SOURCE_FIELDS.some(field => view.texts?.[field])) return '넣을 이전 판독문이 표시돼 있지 않습니다.';
      return app.insertBlock();
    }
    function renderButtons() {
      const why = confirming ? null : insertReason();
      insertButton.disabled = !!why || !!confirming;
      insertButton.title = why || '선택한 글(선택이 없으면 판독문 전체)을 확인한 뒤 현재 초안 끝에 넣습니다';
    }

    function render() {
      if (!state) return;
      renderTarget();
      renderSource();
      renderButtons();
    }

    const sameView = (a, b) => a.uid === b.uid && a.state === b.state && a.version === b.version && a.action === b.action
      && a.author === b.author && a.at === b.at && SOURCE_FIELDS.every(field => (a.texts?.[field] ?? null) === (b.texts?.[field] ?? null));
    /**
     * The Source display context of one Source read (R6). An older read never replaces a newer one. A re-read of the Source on
     * screen (the page re-reads it on every list refresh) keeps the shown text until its answer: the same text then continues
     * an open confirmation under the new read; anything else retires it.
     */
    function showSource(view) {
      if (!view || !Number.isSafeInteger(view.seq) || view.seq < source.seq) return;
      if (view.state === 'loading' && source.state === 'ready' && source.uid === (view.uid ?? null)) return;
      const texts = view.texts ? Object.freeze(Object.fromEntries(SOURCE_FIELDS.map(field => [field, lf(view.texts[field])]))) : null;
      const next = Object.freeze({ seq: view.seq, uid: view.uid ?? null, state: view.state, version: view.version ?? null,
        action: view.action ?? null, author: view.author ?? null, at: view.at ?? null, message: view.message ?? null, texts });
      const before = source.state;
      const continued = !!confirming && sameView(confirming.source, next);
      source = next;
      // A confirmation shows the Source it was opened on; another Source or another text retires it.
      if (continued) confirming.source = next;
      else if (confirming) closeDialog(false);
      if (!state) return;
      render();
      if (before !== next.state && next.uid) {
        say(next.state === 'ready' ? '이전 판독문을 표시했습니다.' : next.message || SOURCE_STATE[next.state] || '');
      }
    }

    /** The Source parts the reader marked: a selection inside the Source text, or (nothing selected there) every non-empty field. */
    function selectedParts(view) {
      const selection = doc.getSelection();
      if (selection && selection.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0), parts = [];
        let touched = false;
        for (const field of SOURCE_FIELDS) {
          const el = shown[field], text = view.texts[field];
          if (!text || !range.intersectsNode(el)) continue;
          touched = true;
          const offset = (container, at) => { const r = doc.createRange(); r.setStart(el, 0); r.setEnd(container, at); return r.toString().length; };
          const start = el.contains(range.startContainer) ? offset(range.startContainer, range.startOffset) : 0;
          const end = el.contains(range.endContainer) ? offset(range.endContainer, range.endOffset) : text.length;
          if (end > start) parts.push({ field, start, end });
        }
        if (touched) return validParts(parts, view.texts);
      }
      return validParts(SOURCE_FIELDS.filter(field => view.texts[field]).map(field => ({ field, start: 0, end: view.texts[field].length })),
        view.texts);
    }

    function chosenSection() {
      const chosen = dialog.querySelector('input[name="related-insert-section"]:checked')?.value;
      return SECTIONS.includes(chosen) ? chosen : 'findings';
    }
    function paintDialog() {
      const open = confirming;
      if (!open) return;
      const seed = app.seed();
      const section = chosenSection();
      dialogSource.textContent = 'Source: ' + (pair(open.source.version === null ? null : 'v' + open.source.version,
        ACTION[open.source.action] || open.source.action, open.source.author, open.source.at) || UNKNOWN) + ' · '
        + open.parts.map(part => LABEL[part.field] + (part.start === 0 && part.end === open.source.texts[part.field].length ? '' : ' (선택한 부분)')).join(', ');
      if (!seed || seed.reason) {
        dialogTarget.textContent = 'Target: ' + (seed?.label || UNKNOWN);
        dialogPosition.textContent = '';
        dialogText.textContent = '';
        dialogError.textContent = seed?.reason || '현재 초안을 확인하지 못했습니다.';
        confirmButton.disabled = true;
        return;
      }
      const planned = insertion(seed.texts[section], open.parts, open.source.texts);
      dialogTarget.textContent = 'Target: ' + seed.label;
      dialogPosition.textContent = LABEL[section] + ' 칸의 끝에 넣습니다' + (planned.text.startsWith('\n') ? ' · 앞 글과 줄을 바꿔 붙입니다' : '')
        + ' · 넣는 글은 아래와 같습니다.';
      dialogText.textContent = planned.text;
      dialogError.textContent = '';
      confirmButton.disabled = !planned.text.replace(/\n/g, '');
    }

    function closeDialog(returnFocus) {
      const was = confirming;
      confirming = null;
      if (dialog.open) { closing += 1; try { dialog.close(); } finally { closing -= 1; } }
      if (state) renderButtons();
      if (returnFocus && was && state && was.generation === generation) (insertButton.disabled ? title : insertButton).focus({ preventScroll: true });
    }

    async function openInsert() {
      if (!state || confirming) return;
      const gen = generation, view = source;
      const why = insertReason();
      if (why) { say(why); return; }
      const parts = selectedParts(view);
      if (!parts) { say('선택한 글의 범위를 확인할 수 없습니다. 선택을 지우고 다시 누르면 판독문 전체를 넣습니다.'); return; }
      insertButton.disabled = true;
      say('현재 초안의 저장 상태를 확인하는 중입니다…');
      let prepared;
      try { prepared = await app.prepare(); }
      catch (_) { prepared = '현재 초안의 저장 상태를 확인하지 못했습니다.'; }
      // Back or another mode meanwhile: this confirmation is not theirs. Another Source text: the reader looks again first.
      if (!state || gen !== generation) return;
      if (!sameView(source, view)) { say('이전 판독문이 그 사이 바뀌었습니다 — 다시 확인한 뒤 누르세요.'); renderButtons(); return; }
      if (prepared) { say(prepared); renderButtons(); return; }
      say('');
      confirming = { generation: gen, parts, source };
      const first = dialog.querySelector('input[name="related-insert-section"][value="findings"]');
      if (first) first.checked = true;
      paintDialog();
      renderButtons();
      dialog.showModal();
      (confirmButton.disabled ? cancelButton : confirmButton).focus();
    }

    /**
     * The explicit Insert (R2). Everything asynchronous happened before this click. Here, in one synchronous span: the page
     * freezes one operation for the current Target, Source and CAS (or refuses), the confirmation closes, the editor host is
     * released only from this mode's own restriction, one native edit runs under a one-shot admission, the restriction and a
     * safe focus come back. Only an applied native edit is handed to the page to send; a refused one is never sent.
     */
    function confirmInsert() {
      const open = confirming;
      if (!open || !state || open.generation !== generation || source !== open.source) { closeDialog(true); return; }
      const gen = generation, section = chosenSection();
      const token = Object.seal({ op: null, field: section, at: null, text: null, state: 'prepared' });
      admission = token;
      let frozen = null, applied = false;
      try {
        frozen = app.freeze({ section, parts: open.parts, source: open.source, admission: token });
        if (!frozen || frozen.refused) {
          dialogError.textContent = frozen?.refused || '현재 초안에 넣을 수 없습니다.';
          return;
        }
        token.op = frozen.op;
        token.at = frozen.at;
        token.text = frozen.text;
        confirming = null;
        closing += 1;
        try { dialog.close(); } finally { closing -= 1; }
        // An exception inside the native edit is a refused edit: the restriction comes back and nothing is sent.
        try { applied = withEditor(() => app.edit(frozen, token)) === true; } catch (_) { applied = false; }
      } finally {
        admission = null;
        token.state = 'spent';
        // A safe, visible focus of this mode (the Insert button itself waits while the operation is pending).
        if (frozen && !frozen.refused && state && gen === generation) title.focus({ preventScroll: true });
      }
      if (!frozen || frozen.refused) return;
      if (applied) {
        if (state && gen === generation)
          state.inserted = Object.freeze({ field: frozen.at.field, end: frozen.at.start + frozen.text.length, after: frozen.op.after });
        say('현재 초안에 넣었습니다. 서버 저장을 확인하는 중입니다…');
        app.submit(frozen.op);
      } else {
        app.abandon(frozen.op);
        if (state && gen === generation && source === open.source) {
          // The same context: give the reader the confirmation back with what happened.
          confirming = open;
          paintDialog();
          dialogError.textContent = '현재 초안에 넣지 못했습니다. 편집기의 글은 바뀌지 않았거나 그대로 남아 있습니다 — 확인한 뒤 다시 시도하세요.';
          renderButtons();
          dialog.showModal();
          cancelButton.focus();
        }
      }
      if (state) renderButtons();
    }

    /** One native edit of the page under a one-shot admission while the mode holds the editor (the inverse of a discarded Insert). */
    function admit({ field, at, text, op }, run) {
      // A late Discard after Back still needs the operation's identity admission at the frame's final edit check.
      const token = Object.seal({ op, field, at, text, state: 'prepared' }), gen = generation;
      admission = token;
      try { return withEditor(() => run(token)); }
      finally {
        admission = null;
        token.state = 'spent';
        if (state && gen === generation && !section.contains(doc.activeElement)) title.focus({ preventScroll: true });
      }
    }

    /** Validates the admission at the editor's own permission check, once per edit span: prepared becomes running. */
    function admits(token, field, at) {
      if (!token || token !== admission || token.state === 'spent' || token.field !== field || token.at !== at) return false;
      if (token.state === 'prepared') token.state = 'running';
      return true;
    }
    /** The mode's reason for any write or command; the live admission of this one edit is the only exception. */
    function blocked(token) {
      if (!state) return null;
      return token && token === admission && token.state !== 'spent' ? null : REASON;
    }

    function enter({ target, selectionSeq, owner, opening, focus }) {
      if (state) return false;
      generation += 1;
      state = { generation, target, selectionSeq, owner, opening, point: capturePoint(), inserted: null };
      holdEditor();
      section.hidden = false;
      render();
      if (focus) title.focus({ preventScroll: false });
      say('Related Report 모드입니다. 이전 판독문은 읽기 전용이고, 검토한 글만 Insert로 현재 초안에 넣습니다.');
      return true;
    }

    /** Leaves the mode (Back, a move, an end). Returns what Back restores; the pending operation is not the mode's to end. */
    function exit() {
      if (!state) return null;
      const left = state;
      state = null;
      generation += 1;
      closeDialog(false);
      admission = null;
      section.hidden = true;
      releaseEditor();
      say('');
      return left;
    }

    /**
     * Back puts the reader where the Target was: the same nodes, text and Undo; the caret, selection and scroll it had, or the
     * end of the inserted text when this mode inserted one. A text that changed otherwise meanwhile keeps its own caret.
     */
    function restore(left) {
      if (state || !left) return;
      const point = left.point, inserted = left.inserted;
      const field = inserted ? inserted.field : point.field, el = app.field(field);
      if (!el || el.disabled || el.closest('[hidden], [inert]') || !el.getClientRects().length) return;
      el.focus({ preventScroll: true });
      if (inserted && el.value === inserted.after) {
        el.setSelectionRange(inserted.end, inserted.end);
        el.scrollIntoView({ block: 'nearest' });
      } else if (!inserted && el.value === point.value) {
        el.setSelectionRange(point.start, point.end, point.direction);
        // Focus may scroll the field's boxes to the caret; the reader's own scroll positions come back.
        for (const [box, top, left] of point.scrolls) if (box.isConnected) { box.scrollTop = top; box.scrollLeft = left; }
      }
    }

    function modalOpen() {
      return !!doc.querySelector('dialog[open], .modal.show, #structmodal.modal.on');
    }

    /** The Notice's Discard Insert for one operation (or none). The page decides when an operation may be discarded. */
    function noticeDiscard(op, disabled = false) {
      noticeOperation = op || null;
      noticeDiscardButton.style.display = op ? '' : 'none';
      noticeDiscardButton.disabled = !!op && !!disabled;
    }
    noticeDiscardButton.addEventListener('click', () => { if (noticeOperation) app.discard(noticeOperation); });

    back.addEventListener('click', () => { if (state) app.back(); });
    insertButton.addEventListener('click', () => { openInsert(); });
    confirmButton.addEventListener('click', confirmInsert);
    cancelButton.addEventListener('click', () => closeDialog(true));
    dialog.addEventListener('change', event => { if (event.target?.name === 'related-insert-section') paintDialog(); });
    dialog.addEventListener('close', () => {
      if (closing) return;
      const was = confirming;
      confirming = null;
      if (was && state && was.generation === generation) {
        renderButtons();
        (insertButton.disabled ? title : insertButton).focus({ preventScroll: true });
      }
    });
    // Esc: the confirmation first (the dialog's own cancel), then the mode, exactly as Back.
    section.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !state || event.defaultPrevented || event.isComposing || dialog.open) return;
      event.preventDefault();
      event.stopPropagation();
      app.back();
    });
    doc.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !state || event.defaultPrevented || event.isComposing || dialog.open || modalOpen()) return;
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== doc.documentElement) return;
      event.preventDefault();
      app.back();
    });

    return Object.freeze({
      enter, exit, restore, showSource, admit, admits, blocked, noticeDiscard, insertion,
      refresh: () => { if (state) render(); },
      announce: text => { if (state) say(text); },
      focus: () => { if (state) title.focus({ preventScroll: false }); },
      active: () => !!state,
      generation: () => generation,
      context: () => state && Object.freeze({ generation: state.generation, target: state.target, selectionSeq: state.selectionSeq }),
      reason: () => REASON,
    });
  }

  root.KinRelatedReportMode = Object.assign(mount, { insertion, validParts, REASON, SOURCE_FIELDS, SECTIONS });
})(typeof window === 'object' ? window : globalThis);
