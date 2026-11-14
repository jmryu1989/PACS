// The report pop-up window: Pop Out moves the one report editor (not a copy) into a separate always-on-top window
// (Document Picture-in-Picture) and Dock moves it back. The moved elements keep their listeners, text, caret, undo
// history and draft state; the page finds them through find() while they are away. Where the browser has no such window,
// the same editor moves into a movable box over the page instead.
//
// States: docked (in its place) | window (Picture-in-Picture) | box (in-page fallback) | behind (closed after an approval
// with Pin off: the editor waits, hidden, in its place and the place offers "Report (behind) — bring to front").
// Pin = whether the window stays open after Approve. Approve in the window is the page's Approve & Next: only a move to
// the next study it reports (approveAndNext() resolves { moved: true }) closes the window when Pin is off; a refused,
// unknown or last-study approval leaves the window and its text as they are. Dock and the window's own close (×) put
// the editor back in its place.
(function (root) {
  'use strict';

  // Moved in this order; each leaves a marker behind so Dock restores the exact place.
  const PARTS = ['exam-report-scope', 'draftbar', 'holdbar', 'deferbar', 'recnote', 'report-editor'];
  const SAVE = 'b-save';
  const STYLE = `
.report-window-place { flex: 1 1 0; min-width: 160px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
  padding: 8px 10px; color: var(--kin-muted, #8892a4); }
.report-window-place[hidden], .report-window-hold { display: none !important; }
.report-window-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 4px 10px; flex: none;
  border-bottom: 1px solid var(--kin-line2, #333c4d); }
.report-window-bar .spacer { flex: 1; }
.report-window-bar button[aria-pressed="true"] { border-color: var(--kin-accent, #4c8dff); color: var(--kin-text, #e6e9ef); }
.report-window-note { min-width: 0; color: var(--kin-muted, #8892a4); }
.report-window-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.report-window-body > .report-editor { flex: 1 1 auto; }
.report-window-foot { flex: none; display: flex; gap: 6px; padding: 6px 10px; }
.report-window-box { position: fixed; z-index: 2147483000; top: 72px; right: 24px; width: 560px; height: 600px;
  max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); display: flex; flex-direction: column; resize: both;
  overflow: hidden; background: var(--kin-panel, #1b2130); border: 1px solid var(--kin-line2, #333c4d); border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .5); }
.report-window-box[hidden] { display: none; }
.report-window-box .report-window-bar { cursor: move; }
.report-window-confirm { max-width: 90vw; color: inherit; background: var(--kin-panel, #1b2130);
  border: 1px solid var(--kin-line2, #333c4d); }
.report-window-confirm p { white-space: pre-wrap; margin: 0 0 10px; }
body.report-window-doc { height: 100vh; margin: 0; display: flex; flex-direction: column; overflow: hidden; }
`;
  const TEXT = Object.freeze({
    open: 'Report is open in a pop-up window',
    behind: 'The report window closed after the approval because Pin is off.',
    noWindow: 'This browser cannot keep the report above other windows.',
    notice: 'Confirm your choice in the worklist window (Retry · Check · Stay).',
    pinTitle: 'Pin: 승인한 뒤에도 이 창을 열어 두고 다음 검사를 이 창에서 이어 씁니다. 끄면 승인한 뒤 창을 닫습니다.',
    dockTitle: '판독 편집기를 목록 화면의 원래 자리로 되돌리고 이 창을 닫습니다.',
    approveTitle: '승인하고 목록의 다음 검사로 넘어갑니다(Approve & Next와 같습니다). 승인이 확인되지 않거나 다음 검사가 없으면 이 검사에 머뭅니다.',
    frontTitle: '판독 창을 앞으로 가져옵니다.',
    behindTab: 'Report (behind) — bring to front',
    readingTitle: 'Reading Workspace에서는 판독 편집기가 영상 옆에 있어 따로 띄우지 않습니다.',
    endedTitle: '세션이 끝나 판독 창을 띄울 수 없습니다.',
  });

  let current = null;   // the mounted controller (one per page)

  /** The page's lookup while the editor is away: the element in the window's document, or null. */
  // Only the moved elements are searched (never the rest of the window), and nothing before a window has opened.
  function find(selector) {
    const moved = current?.movedElements() ?? [];
    try {
      for (const el of moved) {
        const hit = el.matches(selector) ? el : el.querySelector(selector);
        if (hit) return hit;
      }
    } catch (_) {}
    return null;
  }

  // listen(doc) adds the page's report-field listeners to another document and returns their remover.
  function mount({ approveAndNext, toast = () => {}, listen = () => () => {}, document: doc = root.document } = {}) {
    if (current) return current;
    if (typeof approveAndNext !== 'function') throw new TypeError('approveAndNext is required');
    const editor = doc.getElementById('report-editor'), button = doc.getElementById('report-popout');
    const parts = PARTS.map(id => doc.getElementById(id)).filter(Boolean), save = doc.getElementById(SAVE);
    // A page without the editor or its Pop Out button (a partial test page) gets no window.
    if (!editor || !button || !parts.includes(editor)) return null;
    const css = doc.createElement('style');
    css.id = 'report-window-style';
    css.textContent = STYLE;
    doc.head.append(css);
    // Markers: where each part goes back to.
    const markers = new Map([...parts, ...(save ? [save] : [])].map(el => {
      const marker = doc.createComment('report-window:' + el.id);
      el.before(marker);
      return [el, marker];
    }));
    // The editor's place in the page while it is away: what happened and the way back.
    const place = doc.createElement('div');
    place.className = 'report-window-place';
    place.setAttribute('role', 'status');
    place.hidden = true;
    const placeText = doc.createElement('span');
    const front = chip(doc, 'Bring to Front', TEXT.frontTitle), tab = chip(doc, TEXT.behindTab, TEXT.frontTitle);
    const placeDock = chip(doc, 'Dock', TEXT.dockTitle);
    tab.id = 'report-window-behind';
    place.append(placeText, tab, front, placeDock);
    const hold = doc.createElement('div');
    hold.className = 'report-window-hold';
    hold.hidden = true;
    editor.before(place);
    place.after(hold);

    let state = 'docked', pinned = false, ended = false, approving = false, opening = false;
    // The open window: { kind: 'window' | 'box', win, doc, shell, bar, note, pin, approve, foot, closing, dialogs }.
    let shown = null;
    const nextButton = () => doc.getElementById('b-approve-next');
    const notice = () => doc.getElementById('report-notice');

    function chip(d, label, title) {
      const b = d.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = label;
      if (title) b.title = title;
      return b;
    }
    const reading = () => doc.body.classList.contains('reading');

    function renderPlace() {
      place.hidden = state === 'docked';
      placeText.textContent = state === 'behind' ? TEXT.behind : TEXT.open;
      tab.hidden = state !== 'behind';
      front.hidden = state === 'behind';
      button.hidden = state !== 'docked';
      button.disabled = ended || reading();
      button.title = ended ? TEXT.endedTitle : reading() ? TEXT.readingTitle
        : '판독 편집기를 따로 움직이는 창으로 띄웁니다. Pin을 켜면 승인한 뒤에도 창이 남아 다음 검사를 받습니다.';
    }

    // Mirrors of the page's state inside the window: Approve & Next's lock and reason, the identity in the title, the notice.
    function mirror() {
      if (!shown) return;
      const next = nextButton();
      shown.approve.disabled = approving || !next || next.disabled;
      shown.approve.title = next?.disabled ? (next.title || TEXT.approveTitle) : TEXT.approveTitle;
      const n = notice();
      const asking = !!n && n.style.display !== 'none';
      shown.note.textContent = asking ? TEXT.notice : shown.kind === 'box' ? TEXT.noWindow : '';
      shown.pin.setAttribute('aria-pressed', String(pinned));
      shown.pin.textContent = pinned ? 'Pin: On' : 'Pin: Off';
      if (shown.kind === 'window') {
        const target = editor.querySelector('#report-editor-target')?.textContent.trim();
        shown.doc.title = target ? 'Report — ' + target : 'Report';
      }
    }
    const watch = new MutationObserver(() => mirror());
    function observe() {
      watch.disconnect();
      const next = nextButton(), n = notice(), target = editor.querySelector('#report-editor-target');
      if (next) watch.observe(next, { attributes: true, attributeFilter: ['disabled', 'title'] });
      if (n) watch.observe(n, { attributes: true, attributeFilter: ['style', 'hidden'] });
      if (target) watch.observe(target, { childList: true, characterData: true, subtree: true });
    }
    // The Reading Workspace keeps the editor beside the images and finds it in the page: entering it docks the editor.
    new MutationObserver(records => {
      // Entered at any point since the last look (also entered and left again within one task) counts as entered.
      const entered = reading() || records.some(record => /(^|\s)reading(\s|$)/.test(record.oldValue || ''));
      // A Pop Out still opening is retired too: leaving the workspace again before the browser answers opens nothing.
      if (entered && (state !== 'docked' || opening)) dock();
      renderPlace();
    }).observe(doc.body, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    function copyStyles(target) {
      for (const sheet of doc.styleSheets) {
        let el;
        try {
          el = target.createElement('style');
          el.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n');
        } catch (_) {
          if (!sheet.href) continue;
          el = target.createElement('link');
          el.rel = 'stylesheet'; el.href = sheet.href;
        }
        target.head.append(el);
      }
      // Reading Appearance keeps the reader's fonts and colours on the root element.
      const style = doc.documentElement.getAttribute('style');
      if (style) target.documentElement.setAttribute('style', style);
      target.documentElement.lang = doc.documentElement.lang;
    }

    // The window's frame around the moved parts, built in the document that shows it.
    function frame(kind, win, d) {
      const shell = d.createElement('div');
      shell.className = kind === 'box' ? 'report-window-box' : 'report-window-shell';
      shell.setAttribute('role', 'dialog');
      shell.setAttribute('aria-label', 'Report window');
      if (kind === 'window') { d.body.classList.add('report-window-doc'); Object.assign(shell.style, { display: 'contents' }); }
      const bar = d.createElement('div'), note = d.createElement('span'), spacer = d.createElement('span');
      bar.className = 'report-window-bar';
      note.className = 'report-window-note'; note.setAttribute('role', 'status');
      spacer.className = 'spacer';
      const pin = chip(d, 'Pin: Off', TEXT.pinTitle), dockButton = chip(d, 'Dock', TEXT.dockTitle);
      pin.id = 'report-window-pin'; dockButton.id = 'report-window-dock';
      bar.append(note, spacer, pin, dockButton);
      const body = d.createElement('div');
      body.className = 'report-window-body';
      const foot = d.createElement('div');
      foot.className = 'rfoot2 rbtns report-window-foot';
      const approve = d.createElement('button');
      approve.type = 'button'; approve.className = 'approve'; approve.id = 'report-window-approve';
      approve.textContent = 'Approve';
      foot.append(approve);
      shell.append(bar, body, foot);
      pin.addEventListener('click', () => { pinned = !pinned; mirror(); });
      dockButton.addEventListener('click', () => dock());
      approve.addEventListener('click', () => approveInWindow());
      if (kind === 'box') drag(shell, bar);
      return { kind, win, doc: d, shell, bar, body, note, pin, approve, foot, closing: null, dialogs: new Set(), unlisten: () => {} };
    }

    function drag(box, handle) {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target.closest('button')) return;
        const rect = box.getBoundingClientRect(), dx = event.clientX - rect.left, dy = event.clientY - rect.top;
        const move = e => {
          box.style.left = Math.max(0, Math.min(root.innerWidth - 40, e.clientX - dx)) + 'px';
          box.style.top = Math.max(0, Math.min(root.innerHeight - 30, e.clientY - dy)) + 'px';
          box.style.right = 'auto';
        };
        const up = () => { root.removeEventListener('pointermove', move); root.removeEventListener('pointerup', up); };
        root.addEventListener('pointermove', move);
        root.addEventListener('pointerup', up);
      });
    }

    // Moving keeps each element (and its listeners); focus goes with the field that had it.
    function focused() {
      const from = shown?.doc ?? doc;
      const active = from.activeElement;
      return active && (editor.contains(active) || active === save) ? active : null;
    }
    function moveInto(s) {
      const had = focused();
      for (const el of parts) s.body.append(el);
      if (save) s.approve.after(save);
      if (had?.isConnected) had.focus({ preventScroll: true });
    }
    function moveHome() {
      for (const [el, marker] of markers) marker.after(el);
    }

    // The Pop Out being opened. A Dock or the session's end retires it: whatever the browser answers afterwards (a window
    // or a refusal) opens nothing.
    let request = 0;
    async function popOut() {
      if (ended || reading() || opening) return;
      if (state === 'window' || state === 'box') return bringToFront();
      const mine = ++request;
      const still = () => mine === request && !ended && !reading() && (state === 'docked' || state === 'behind');
      const picker = root.documentPictureInPicture;
      let s = null;
      if (picker && typeof picker.requestWindow === 'function' && root.isSecureContext) {
        opening = true;
        let win = null;
        try { win = await picker.requestWindow({ width: 560, height: 640 }); } catch (_) { win = null; }
        finally { opening = false; }
        if (!still()) { try { win?.close(); } catch (_) {} return; }
        if (win) {
          copyStyles(win.document);
          s = frame('window', win, win.document);
          s.unlisten = listen(win.document);
          win.document.body.append(s.shell);
          win.addEventListener('pagehide', () => closed(s), { once: true });
          win.addEventListener('keydown', event => finalizeKey(event, s));
        }
      }
      if (!s) {
        s = frame('box', root, doc);
        doc.body.append(s.shell);
      }
      shown = s;
      state = s.kind;
      moveInto(s);
      observe();
      renderPlace();
      mirror();
      if (!focused()) editor.querySelector('#findings')?.focus({ preventScroll: true });
    }

    function bringToFront() {
      if (state === 'behind') return popOut();
      if (!shown) return;
      try { shown.win.focus(); } catch (_) {}
      if (shown.kind === 'box') { shown.shell.hidden = false; editor.querySelector('#findings')?.focus({ preventScroll: true }); }
    }

    // The window is going away: back to the place (Dock, ×, the session's end) or into the hidden holder (behind).
    function closed(s) {
      if (shown !== s) return;
      s.unlisten();
      for (const resolve of s.dialogs) resolve(false);
      s.dialogs.clear();
      const behind = s.closing === 'behind';
      if (behind) { for (const el of parts) hold.append(el); if (save) hold.append(save); }
      else moveHome();
      shown = null;
      watch.disconnect();
      state = behind ? 'behind' : 'docked';
      if (s.kind === 'box') s.shell.remove();
      renderPlace();
    }
    function close(reason) {
      const s = shown;
      if (!s) return;
      s.closing = reason;
      if (s.kind === 'window') {
        try { s.win.close(); } catch (_) {}
        // pagehide normally runs inside close(); if the browser defers it, the editor still comes back now.
        if (shown === s) closed(s);
      } else closed(s);
    }

    function dock() {
      request++;
      if (state === 'behind') { moveHome(); state = 'docked'; renderPlace(); return; }
      close('dock');
    }

    // The page's Finalize key (Ctrl+S unless remapped) typed in the separate window: the same command and gates as in the
    // page (KinReportCommands, page-boot.js); a question open in the window holds it as a dialog in the page does.
    function finalizeKey(event, s) {
      if (shown !== s || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (s.doc.querySelector('dialog[open]')) return;
      const commands = root.KinReportCommands;
      if (commands?.isFinalize?.(event) !== true) return;
      if (commands.finalize() === true) { event.preventDefault(); event.stopPropagation(); }
    }

    async function approveInWindow() {
      const s = shown;
      if (!s || approving) return;
      approving = true;
      mirror();
      let result = null;
      try { result = await approveAndNext(); }
      catch (error) { toast('승인하지 못했습니다' + (error?.message ? ': ' + error.message : ''), 'err'); }
      finally { approving = false; mirror(); }
      // Only an approval that was accepted and moved on decides anything; the reader may have docked meanwhile.
      if (!result?.moved || shown !== s || pinned) return;
      close('behind');
    }

    /** A question about the report, asked inside the window while it is a separate window. */
    function asks() { return shown?.kind === 'window'; }
    function ask(message) {
      const s = shown;
      if (!s || s.kind !== 'window') return Promise.resolve(root.confirm(message));
      return new Promise(resolve => {
        const d = s.doc, dialog = d.createElement('dialog'), text = d.createElement('p');
        dialog.className = 'report-window-confirm';
        text.textContent = message;
        const ok = chip(d, 'OK'), cancel = chip(d, 'Cancel');
        dialog.append(text, ok, ' ', cancel);
        const finish = answer => { s.dialogs.delete(finish); dialog.remove(); resolve(answer); };
        s.dialogs.add(finish);
        ok.addEventListener('click', () => finish(true));
        cancel.addEventListener('click', () => finish(false));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
        d.body.append(dialog);
        dialog.showModal();
        cancel.focus();
      });
    }

    function end() {
      if (ended) return;
      ended = true;
      request++;
      if (state === 'behind') { moveHome(); state = 'docked'; }
      else close('dock');
      renderPlace();
    }

    button.addEventListener('click', () => popOut());
    front.addEventListener('click', () => bringToFront());
    tab.addEventListener('click', () => popOut());
    placeDock.addEventListener('click', () => dock());
    root.addEventListener('pagehide', () => end());
    renderPlace();

    current = Object.freeze({
      state: () => state, pinned: () => pinned, popOut, dock, bringToFront, end, asks, confirm: ask,
      // The parts while they are in a separate window's document (the page's own lookup finds them everywhere else).
      movedElements: () => (shown?.kind === 'window' ? [...parts, ...(save ? [save] : [])] : []),
      // A study switch ends any question the window is asking about the study it was asked for.
      cancelQuestions: () => { for (const resolve of [...(shown?.dialogs ?? [])]) resolve(false); },
    });
    return current;
  }

  root.KinReportPopout = Object.freeze({ mount, find, current: () => current });
})(typeof window === 'object' ? window : globalThis);
