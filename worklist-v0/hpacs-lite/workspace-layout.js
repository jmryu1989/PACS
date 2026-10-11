/* Only display preferences belong here; patient, report and authentication data
 * must never be copied into a browser-wide workspace record. */
(function (root) {
  'use strict';
  const PREFIX = 'kin-workspace:v1:';
  const modes = ['auto', 'portrait', 'landscape'];
  const panels = ['main', 'top', 'related', 'prior'];
  const readingPanels = typeof module === 'object' && module.exports
    ? require('./reading-panel-layout.js') : root.KinReadingPanelLayout;
  const defaults = () => ({ version: 1, mode: 'auto', portrait: {}, landscape: {} });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const workspaceDefaults = () => ({ version: 1, rail: null, worklist: null, related: null,
    prior: null, railCollapsed: false, studyPanelTab: 'images' });
  function normalizeV3(value) {
    if (Object.keys(value).some(k => !['version', 'mode', 'portrait', 'landscape', 'reading', 'workspace'].includes(k))) return null;
    const legacy = normalize({ version: 2, mode: value.mode, portrait: value.portrait,
      landscape: value.landscape, reading: value.reading });
    const workspace = value.workspace, clean = workspaceDefaults();
    if (!legacy || !object(workspace) || Object.keys(workspace).length !== 7
        || Object.keys(workspace).some(k => !Object.hasOwn(clean, k)) || workspace.version !== 1
        || typeof workspace.railCollapsed !== 'boolean'
        || !['images', 'info', 'templates'].includes(workspace.studyPanelTab)) return null;
    for (const name of ['rail', 'worklist', 'related', 'prior']) {
      const size = workspace[name];
      if (size !== null && (!Number.isInteger(size) || size < 1 || size > 16384)) return null;
      clean[name] = size;
    }
    clean.railCollapsed = workspace.railCollapsed; clean.studyPanelTab = workspace.studyPanelTab;
    return { ...legacy, version: 3, workspace: clean };
  }
  function normalize(value) {
    if (object(value) && value.version === 3) return normalizeV3(value);
    if (!object(value) || ![1, 2].includes(value.version) || !modes.includes(value.mode)
        || Object.keys(value).some(k => !['version', 'mode', 'portrait', 'landscape', ...(value.version === 2 ? ['reading'] : [])].includes(k))) return null;
    const clean = defaults();
    clean.mode = value.mode;
    if (value.version === 2) {
      const reading = readingPanels.normalize(value.reading);
      if (!reading) return null;
      clean.version = 2; clean.reading = reading;
    }
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
  function withReading(value, reading) {
    if (value?.version === 3) return normalize({ ...value, reading });
    return normalize({ ...value, version: 2, reading });
  }
  function toVersion3(value, current) {
    const clean = normalize(value);
    if (!clean || clean.version === 3) return clean;
    const previous = normalize(current);
    // Legacy records have no new geometry. Keep current choices on explicit
    // account Load; otherwise let the page resolve null sizes for its viewport.
    return normalize({ ...clean, version: 3,
      reading: clean.reading || previous?.reading || readingPanels.defaults(),
      workspace: previous?.workspace || workspaceDefaults() });
  }
  function mergeLoaded(current, incoming) {
    const clean = normalize(incoming);
    if (!clean) return null;
    if (clean.version === 3 || current?.version === 3) return toVersion3(clean, current);
    // Older account layouts contain no integrated-panel choice. Loading one
    // must not silently erase the arrangement the user is currently working in.
    return clean.version === 1 && current?.version === 2 ? withReading(clean, current.reading) : clean;
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
    try {
      const raw = JSON.stringify(clean);
      if (raw.length > 2048) return false;
      storage.setItem(owner, raw); return true;
    }
    catch (_) { return false; }
  }
  function remove(storage, owner) {
    if (!owner) return false;
    try { storage.removeItem(owner); return true; }
    catch (_) { return false; }
  }
  const api = { PREFIX, defaults, normalize, withReading, workspaceDefaults, toVersion3, mergeLoaded, key, read, write, remove };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinWorkspaceLayout = api;
})(globalThis);
