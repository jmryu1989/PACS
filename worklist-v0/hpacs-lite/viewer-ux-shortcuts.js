window.KinViewerUXShortcuts = (() => {
  // D1821: initial single keys are editable; null explicitly clears a binding.
  // F8 (2026-10-26): flips and turns take Shift so L and R stay Length and Rectangle.
  const defaults = { WindowLevel: 'w', Pan: 'p', Zoom: 'z', StackScroll: 's',
    Length: 'l', Angle: 'a', EllipticalROI: 'e', RectangleROI: 'r',
    ArrowAnnotate: 't', invert: 'i', Cine: 'c', Crosshairs: 'x',
    flipHorizontal: 'shift+h', flipVertical: 'shift+v', 'rotate-left': 'shift+l', 'rotate-right': 'shift+r' };
  const editable = node => !!node?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
  // A stored binding is one letter or digit, or Shift with one letter.
  const parse = text => {
    const value = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
    return /^(?:[a-z0-9]|shift\+[a-z])$/.test(value) ? value : null;
  };
  const display = key => key ? key.split('+').map(part => part === 'shift' ? 'Shift' : part.toUpperCase()).join('+') : '';
  // The binding a press stands for, or null for presses this layer leaves alone.
  // Shift is read from the modifier and the letter from the key, so Caps Lock
  // changes neither.
  function pressed(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return null;
    const character = event.key?.toLowerCase() || '';
    if (event.shiftKey) return /^[a-z]$/.test(character) ? 'shift+' + character : null;
    return /^[a-z0-9]$/.test(character) ? character : null;
  }
  // Names for a summary outside the viewer (Keyboard Shortcuts of the reading screen); the viewer buttons keep their own.
  const names = { WindowLevel: 'Window / Level', Pan: 'Pan', Zoom: 'Zoom', StackScroll: 'Stack Scroll',
    Length: 'Length', Angle: 'Angle', EllipticalROI: 'Ellipse ROI', RectangleROI: 'Rectangle ROI',
    ArrowAnnotate: 'Arrow', invert: 'Invert', Cine: 'Cine', Crosshairs: 'Crosshairs',
    flipHorizontal: 'Flip Horizontal', flipVertical: 'Flip Vertical', 'rotate-left': 'Rotate Left', 'rotate-right': 'Rotate Right' };
  const turns = ['flipHorizontal', 'flipVertical', 'rotate-left', 'rotate-right'];
  // The keys a Viewer window opens with for the saved viewer settings of an account, as viewer-ux-toolbar.js reads them:
  // nothing saved is the defaults; version 1 offered no flip/turn keys, so its nulls there are the defaults.
  function current(settings) {
    const saved = settings && typeof settings === 'object' && settings.shortcuts && typeof settings.shortcuts === 'object'
      ? settings.shortcuts : null;
    if (!saved) return { ...defaults };
    const map = { ...saved };
    if (settings.version === 1) for (const id of turns) if (map[id] == null) map[id] = defaults[id];
    return map;
  }
  // A key panel (F.Leader, viewer-features-input.js) takes keys before this layer's tool keys: lead(fn) installs it,
  // fn(event, refused) returns true for a key it used, and refused() says whether a closed panel may open now (the
  // same refusals as a tool key). A used key runs nothing else; its keypress and keyup go nowhere either.
  let leader = null;
  function lead(fn) { leader = fn; return () => { if (leader === fn) leader = null; }; }
  function mount({ getBindings, invoke, allowed }) {
    const blocked = event => event.isComposing || event.keyCode === 229 || event.repeat ||
      editable(event.target) || editable(document.activeElement) ||
      document.body.classList.contains('kin-viewer-empty') || document.body.classList.contains('kin-patient-switching') ||
      document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
    // The existing CT preset extension owns its numbered mode hotkeys. A user
    // tool binding overrides one; otherwise keep that published preset action.
    const nativePreset = (event, key) => !blocked(event) && allowed() &&
      !Object.values(getBindings()).includes(key) && !!window.kinCTPresets?.names?.[Number(key) - 1];
    const held = new Set();
    function led(event) {
      if (!leader || event.isComposing || event.keyCode === 229) return false;
      // A key the panel used stays its own until it is let go: its repeats run nothing, also after the panel closed.
      if (event.repeat && held.has(event.code || event.key)) { event.stopImmediatePropagation(); event.preventDefault(); return true; }
      let used = false;
      try { used = leader(event, () => !!blocked(event) || !allowed()) === true; } catch (error) { console.error(error); }
      if (!used) { held.delete(event.code || event.key); return false; }
      event.stopImmediatePropagation(); event.preventDefault(); held.add(event.code || event.key);
      return true;
    }
    function key(event) {
      if (led(event)) return;
      if (editable(event.target) || editable(document.activeElement)) return;
      const binding = pressed(event);
      if (!binding) return;
      // Own these keys before the stock document handler so a cleared or
      // reassigned key cannot also run the old OHIF binding.
      if (nativePreset(event, binding)) return;
      event.stopImmediatePropagation();
      if (blocked(event)) return;
      if (event.defaultPrevented || !allowed()) return;
      const bindings = getBindings();
      const id = Object.keys(bindings).find(id => bindings[id] === binding);
      if (id && invoke(id)) event.preventDefault();
    }
    const stopNativeCharacter = event => {
      const code = event.code || event.key;
      if (held.has(code)) {
        if (event.type === 'keyup') held.delete(code);
        event.stopImmediatePropagation(); event.preventDefault(); return;
      }
      if (editable(event.target) || editable(document.activeElement)) return;
      const binding = pressed(event);
      if (binding && !nativePreset(event, binding)) event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('keypress', stopNativeCharacter, true);
    window.addEventListener('keyup', stopNativeCharacter, true);
    return { dispose() {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keypress', stopNativeCharacter, true);
      window.removeEventListener('keyup', stopNativeCharacter, true);
    } };
  }
  return { defaults, names, current, parse, display, mount, lead };
})();
