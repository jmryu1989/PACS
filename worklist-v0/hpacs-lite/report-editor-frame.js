// Own report text history boundaries, composition guards and synchronous text edits.
(function (root) {
  'use strict';

  function create({ fields, canEdit }) {
    const names = Object.keys(fields);
    const doc = fields[names[0]]?.ownerDocument;
    if (!names.length || typeof canEdit !== 'function' || names.some(name =>
      fields[name].tagName !== 'TEXTAREA' || fields[name].ownerDocument !== doc || !fields[name].isConnected)
      || new Set(Object.values(fields)).size !== names.length) throw new TypeError('Invalid report fields');
    const states = Object.fromEntries(names.map(name => [name, { el: fields[name], revision: 0, composing: false }]));
    const requests = new WeakSet();
    let opening = null;
    let writing = false;
    const refused = reason => ({ status: 'refused', reason });
    const lf = text => text.replace(/\r\n?/g, '\n');

    function state(name) {
      if (!Object.hasOwn(states, name)) throw new TypeError('Unknown report field');
      return states[name];
    }

    function bind(s) {
      const start = () => { s.composing = true; };
      const end = () => { s.composing = false; };
      const input = () => { s.revision++; };
      s.el.addEventListener('compositionstart', start);
      s.el.addEventListener('compositionend', end);
      s.el.addEventListener('input', input);
      s.unbind = () => {
        s.el.removeEventListener('compositionstart', start);
        s.el.removeEventListener('compositionend', end);
        s.el.removeEventListener('input', input);
      };
    }
    Object.values(states).forEach(bind);

    function isComposing(name) {
      return name === undefined ? Object.values(states).some(s => s.composing) : state(name).composing;
    }

    function read(name) {
      return name === undefined ? Object.fromEntries(names.map(k => [k, state(k).el.value])) : state(name).el.value;
    }

    function view(el) {
      return { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection,
        top: el.scrollTop, left: el.scrollLeft };
    }

    function scrolls() {
      const elements = new Set();
      for (const s of Object.values(states)) {
        for (let el = s.el; el; el = el.parentElement) elements.add(el);
      }
      return [...elements].map(el => [el, el.scrollTop, el.scrollLeft]);
    }

    function restoreScroll(positions) {
      for (const [el, top, left] of positions) { el.scrollTop = top; el.scrollLeft = left; }
    }

    function switchStudy(context, texts) {
      if (!context || !(context.uid === null || typeof context.uid === 'string') ||
          !Number.isSafeInteger(context.selectionSeq) || names.some(k => typeof texts?.[k] !== 'string'))
        throw new TypeError('A study opening and all report texts are required');
      if (writing) return refused('busy');
      // A render of the current opening must not reset history, selection or an IME session.
      if (opening && opening.uid === context.uid && opening.selectionSeq === context.selectionSeq)
        return names.every(k => read(k) === lf(texts[k])) ? { status: 'unchanged' } : refused('same-opening');
      if (isComposing()) return refused('composing');
      writing = true;
      try {
        const active = doc.activeElement;
        const positions = scrolls();
        const replacements = names.map(name => {
          const s = state(name), old = s.el, next = old.cloneNode(true), saved = view(old);
          // Detached initialization creates no undo command. Old commands cannot target a new node.
          next.value = lf(texts[name]);
          next.defaultValue = next.value;
          return { s, old, next, saved };
        });
        opening = Object.freeze({ uid: context.uid, selectionSeq: context.selectionSeq });
        for (const { s, old, next, saved } of replacements) {
          s.unbind();
          s.el = next; s.revision = 0; s.composing = false;
          bind(s);
          old.replaceWith(next);
          next.setSelectionRange(saved.start, saved.end, saved.direction);
        }
        const focused = replacements.find(item => item.old === active);
        if (focused) focused.next.focus({ preventScroll: true });
        restoreScroll(positions);
        for (const { next, saved } of replacements) { next.scrollTop = saved.top; next.scrollLeft = saved.left; }
        return { status: 'switched' };
      } finally { writing = false; }
    }

    // Capture before an await or before a toolbar takes focus. A later caret move is not an edit.
    function capture(name, range) {
      const s = state(name), el = s.el;
      const start = range?.start ?? el.selectionStart, end = range?.end ?? el.selectionEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > el.value.length)
        throw new TypeError('Invalid report selection');
      const at = Object.freeze({ field: name, text: el.value, start, end, opening, revision: s.revision });
      requests.add(at);
      return at;
    }

    function blocked(at) {
      if (!at || !requests.has(at) || !opening || at.opening !== opening) return 'stale';
      const s = state(at.field);
      // Even an edit followed by Undo retires a pending request.
      if (s.revision !== at.revision || s.el.value !== at.text) return 'changed';
      // Focusing a different field would commit its composition as a side effect.
      if (isComposing()) return 'composing';
      if (!s.el.isConnected || s.el.readOnly || s.el.disabled || !canEdit(at.field)) return 'readonly';
      return null;
    }

    function replace(at, text, start, end) {
      if (typeof text !== 'string') throw new TypeError('Report text must be a string');
      if (writing) return refused('busy');
      let why = blocked(at);
      if (why) return refused(why);
      text = lf(text);
      const s = state(at.field), el = s.el;
      const expected = at.text.slice(0, start) + text + at.text.slice(end);
      if (expected === el.value) return { status: 'unchanged' };
      if (el.maxLength >= 0 && expected.length > el.maxLength) return refused('length');
      const active = doc.activeElement, saved = view(el), positions = scrolls();
      writing = true;
      let applied = false;
      try {
        el.focus({ preventScroll: true });
        // Focus listeners can change edit permission. Check again immediately before the native edit.
        why = blocked(at);
        if (why) return refused(why);
        // Hidden or inert controls cannot take focus; execCommand would edit the previous field.
        if (doc.activeElement !== el) return refused('unavailable');
        el.setSelectionRange(start, end);
        const accepted = doc.execCommand('insertText', false, text);
        applied = el.value === expected;
        if (!accepted || !applied) return refused('native-edit');
        // Chromium ends a typing group on an explicit selection, including an unchanged selection.
        el.setSelectionRange(start + text.length, start + text.length);
        return { status: 'applied' };
      } finally {
        if (!applied) el.setSelectionRange(saved.start, saved.end, saved.direction);
        if (active !== el && active?.isConnected) active.focus({ preventScroll: true });
        restoreScroll(positions);
        writing = false;
      }
    }

    function insert(at, text) { return replace(at, text, at?.start, at?.end); }

    function applyServer(at, { sent, text }) {
      // A save sends the captured text; a structured insertion sends its proposed replacement.
      if (typeof sent !== 'string' || (sent !== at?.text && sent !== text)) return refused('sent-mismatch');
      return replace(at, text, 0, at?.text.length);
    }

    return Object.freeze({ switchStudy, capture, insert, applyServer, read, isComposing,
      element: name => state(name).el });
  }

  root.KinReportEditorFrame = Object.freeze({ create });
})(typeof window === 'object' ? window : globalThis);
