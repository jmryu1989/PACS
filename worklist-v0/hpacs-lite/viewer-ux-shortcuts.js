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
  function mount({ getBindings, invoke, allowed }) {
    const blocked = event => event.isComposing || event.keyCode === 229 || event.repeat ||
      editable(event.target) || editable(document.activeElement) ||
      document.body.classList.contains('kin-viewer-empty') || document.body.classList.contains('kin-patient-switching') ||
      document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
    // The existing CT preset extension owns its numbered mode hotkeys. A user
    // tool binding overrides one; otherwise keep that published preset action.
    const nativePreset = (event, key) => !blocked(event) && allowed() &&
      !Object.values(getBindings()).includes(key) && !!window.kinCTPresets?.names?.[Number(key) - 1];
    function key(event) {
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
  return { defaults, parse, display, mount };
})();
