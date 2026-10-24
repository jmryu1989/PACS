window.KinViewerUXShortcuts = (() => {
  // D1821: initial single keys are editable; null explicitly clears a binding.
  const defaults = { WindowLevel: 'w', Pan: 'p', Zoom: 'z', StackScroll: 's',
    Length: 'l', Angle: 'a', EllipticalROI: 'e', RectangleROI: 'r',
    ArrowAnnotate: 't', invert: 'i', Cine: 'c', Crosshairs: 'x' };
  const editable = node => !!node?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
  function mount({ getBindings, invoke, allowed }) {
    const blocked = event => event.isComposing || event.keyCode === 229 || event.repeat ||
      editable(event.target) || editable(document.activeElement) ||
      document.body.classList.contains('kin-viewer-empty') || document.body.classList.contains('kin-patient-switching') ||
      document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
    // The existing CT preset extension owns its numbered mode hotkeys. A user
    // tool binding overrides one; otherwise keep that published preset action.
    const nativePreset = event => !blocked(event) && allowed() &&
      !Object.values(getBindings()).includes(event.key) && !!window.kinCTPresets?.names?.[Number(event.key) - 1];
    function key(event) {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const character = event.key?.toLowerCase();
      if (!/^[a-z0-9]$/.test(character || '')) return;
      // Own single keys before the stock document handler so a cleared or
      // reassigned key cannot also run the old OHIF binding.
      if (nativePreset(event)) return;
      event.stopImmediatePropagation();
      if (blocked(event)) return;
      if (event.defaultPrevented || !allowed()) return;
      const id = Object.keys(getBindings()).find(id => getBindings()[id] === character);
      if (id && invoke(id)) event.preventDefault();
    }
    const stopNativeCharacter = event => {
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && /^[a-z0-9]$/i.test(event.key || '') && !nativePreset(event)) event.stopImmediatePropagation();
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
  return { defaults, mount };
})();
