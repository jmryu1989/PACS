/* Durable choices stay separate from screen bounds: opening a small window must
 * not erase the dimensions the user chose on a larger display. */
(function (root) {
  'use strict';
  const sizes = ['reportWidth', 'imageHeight', 'relatedHeight', 'relatedListHeight'];
  const defaults = () => ({ version: 1, reportWidth: null, imageHeight: null,
    relatedHeight: null, relatedListHeight: null, relatedHidden: false });
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
        typeof value.relatedHidden !== 'boolean' || Object.keys(value).length !== 6 ||
        Object.keys(value).some(key => !['version', ...sizes, 'relatedHidden'].includes(key))) return null;
    const clean = defaults(); clean.relatedHidden = value.relatedHidden;
    for (const key of sizes) {
      const n = value[key];
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 16384)) return null;
      clean[key] = n;
    }
    return clean;
  }
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  function resolve(value, screen) {
    const clean = normalize(value); if (!clean) return null;
    const width = Math.max(1, Number(screen.width) || 1), height = Math.max(1, Number(screen.height) || 1);
    const narrow = typeof screen.narrow === 'boolean' ? screen.narrow : width <= 850;
    const listMin = Math.max(125, Math.ceil(Number(screen.listMin) || 125));
    const relatedMin = listMin + 86;
    const workHeight = Math.max(621, Number(screen.workHeight) || 621);
    const ranges = {
      reportWidth: { min: 300, max: Math.max(300, Math.floor(width - 366)), default: width <= 1250 ? 340 : 420 },
      imageHeight: { min: 300, max: Math.max(530, Math.floor(height * 1.25)), default: Math.max(530, Math.round(height * .6)) },
      relatedHeight: { min: relatedMin, max: Math.max(relatedMin, Math.floor(workHeight - 376)), default: 245 },
    };
    const effective = {};
    for (const key of ['reportWidth', 'imageHeight', 'relatedHeight']) {
      const range = ranges[key]; effective[key] = clamp(clean[key] ?? range.default, range.min, range.max);
    }
    ranges.relatedListHeight = { min: listMin, max: Math.max(listMin, effective.relatedHeight - 86), default: 125 };
    const listRange = ranges.relatedListHeight;
    effective.relatedListHeight = clamp(clean.relatedListHeight ?? listRange.default, listRange.min, listRange.max);
    return { narrow, effective, ranges };
  }
  const api = { defaults, normalize, resolve };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinReadingPanelLayout = api;
})(globalThis);
