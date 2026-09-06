/* Only display preferences belong here; patient, report and authentication data
 * must never be copied into a browser-wide workspace record. */
(function (root) {
  'use strict';
  const PREFIX = 'kin-workspace:v1:';
  const modes = ['auto', 'portrait', 'landscape'];
  const panels = ['main', 'top', 'related', 'prior'];
  const defaults = () => ({ version: 1, mode: 'auto', portrait: {}, landscape: {} });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function normalize(value) {
    if (!object(value) || value.version !== 1 || !modes.includes(value.mode)
        || Object.keys(value).some(k => !['version', 'mode', 'portrait', 'landscape'].includes(k))) return null;
    const clean = defaults();
    clean.mode = value.mode;
    for (const axis of ['portrait', 'landscape']) {
      const sizes = value[axis];
      if (!object(sizes) || Object.keys(sizes).some(k => !panels.includes(k))) return null;
      for (const name of Object.keys(sizes)) {
        const size = sizes[name];
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 1 || size > 16384) return null;
        clean[axis][name] = Math.round(size);
      }
    }
    return clean;
  }
  function key(session) {
    // Display names and email aliases can change or collide on a shared PC.
    if (!session || session.state !== 'approved' || session.demo) return null;
    if (![session.sub, session.institution].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) return null;
    return PREFIX + JSON.stringify([session.institution, session.sub]);
  }
  function read(storage, owner) {
    if (!owner) return { state: defaults(), status: 'disabled' };
    try {
      const raw = storage.getItem(owner);
      if (raw === null) return { state: defaults(), status: 'empty' };
      if (typeof raw !== 'string' || raw.length > 2048) return { state: defaults(), status: 'invalid' };
      const state = normalize(JSON.parse(raw));
      return { state: state || defaults(), status: state ? 'restored' : 'invalid' };
    } catch (_) { return { state: defaults(), status: 'unavailable' }; }
  }
  function write(storage, owner, value) {
    const clean = normalize(value);
    if (!owner || !clean) return false;
    try { storage.setItem(owner, JSON.stringify(clean)); return true; }
    catch (_) { return false; }
  }
  function remove(storage, owner) {
    if (!owner) return false;
    try { storage.removeItem(owner); return true; }
    catch (_) { return false; }
  }
  const api = { PREFIX, defaults, normalize, key, read, write, remove };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinWorkspaceLayout = api;
})(globalThis);
