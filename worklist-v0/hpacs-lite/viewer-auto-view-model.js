// Auto Save View: the pure part — the saved view's shape (checked again when it is read back: a stored view is not
// trusted), finding a saved image by its SOP and frame in a cell's (possibly re-sorted) stack, and the words of the
// last saved view and of what was put back. No screen, no requests.
(function (root) {
  const UID = /^[0-9]+(?:\.[0-9]+)+$/;
  const CELL_KEYS = ['study', 'series', 'sop', 'frame', 'index', 'zoom', 'camera', 'properties', 'display'];
  const CAMERA_KEYS = ['focalPoint', 'position', 'viewUp', 'viewPlaneNormal', 'parallelScale', 'rotation', 'flipHorizontal', 'flipVertical'];
  const DISPLAY_KEYS = ['magnification', 'windowing', 'filter', 'sort', 'rotate', 'flip', 'firstImage', 'gspsAuto', 'overlay'];
  const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const count = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const uid = value => typeof value === 'string' && value.length <= 64 && UID.test(value);
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(n => finite(n, -1e7, 1e7));
  const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);

  function camera(value) {
    if (!exact(value, CAMERA_KEYS) || !['focalPoint', 'position', 'viewUp', 'viewPlaneNormal'].every(key => vector(value[key]))) return false;
    if (!finite(value.parallelScale, 0.0001, 1e7) || !finite(value.rotation, -3600, 3600) || typeof value.flipHorizontal !== 'boolean' || typeof value.flipVertical !== 'boolean') return false;
    const { viewUp: u, viewPlaneNormal: n, position: p, focalPoint: f } = value;
    const delta = p.map((v, i) => v - f[i]), distance = Math.sqrt(dot(delta, delta));
    return Math.max(Math.abs(dot(u, u) - 1), Math.abs(dot(n, n) - 1), Math.abs(dot(u, n))) <= 1e-4 && distance >= 0.0001 && Math.abs(dot(delta, n) / distance - 1) <= 1e-4;
  }
  function properties(value) {
    return exact(value, ['voiRange', 'VOILUTFunction', 'invert', 'interpolationType']) && exact(value.voiRange, ['lower', 'upper']) &&
      finite(value.voiRange.lower, -1e9, 1e9) && finite(value.voiRange.upper, -1e9, 1e9) && value.voiRange.upper > value.voiRange.lower &&
      ['LINEAR', 'LINEAR_EXACT', 'SIGMOID'].includes(value.VOILUTFunction) && typeof value.invert === 'boolean' && [0, 1, 2].includes(value.interpolationType);
  }
  // The saved view of `study` (the first study it names), as the server checks it; null when it is not one.
  function validate(value, study) {
    try {
      if (!exact(value, ['version', 'studies', 'rows', 'cols', 'active', 'cells']) || value.version !== 1) return null;
      const studies = value.studies;
      if (!Array.isArray(studies) || studies.length < 1 || studies.length > 8 || !studies.every(uid) || new Set(studies).size !== studies.length ||
          (study !== undefined && studies[0] !== study)) return null;
      if (!count(value.rows, 1, 4) || !count(value.cols, 1, 4) || !Array.isArray(value.cells) || value.cells.length !== value.rows * value.cols ||
          value.cells.every(cell => cell === null) || !count(value.active, 0, value.cells.length - 1)) return null;
      for (const cell of value.cells) {
        if (cell === null) continue;
        if (!exact(cell, CELL_KEYS) || !studies.includes(cell.study) || !uid(cell.series) || !uid(cell.sop) || !count(cell.frame, 1, 100000) ||
            !count(cell.index, 0, 100000) || !finite(cell.zoom, 1e-9, 10000) || cell.zoom <= 0 || !camera(cell.camera) || !properties(cell.properties)) return null;
        if (cell.display !== null && !exact(cell.display, DISPLAY_KEYS)) return null;
      }
      return JSON.parse(JSON.stringify(value));
    } catch (_) { return null; }
  }

  // The DICOM frame an image id names (WADO-RS `/frames/N`, WADO-URI `frame=N`); a single-frame image is frame 1.
  function frameOf(imageId) {
    const text = String(imageId || '');
    const match = /\/frames\/(\d+)(?:[/?#]|$)/.exec(text) || /[?&]frame=(\d+)(?:&|#|$)/.exec(text);
    const frame = match ? Number(match[1]) : 1;
    return Number.isInteger(frame) && frame >= 1 ? frame : 1;
  }
  // The place of the saved image (SOP and frame) in a stack as it is ordered now; -1 when it is not in it (or twice).
  function findImage(imageIds, instanceOf, sop, frame) {
    let found = -1;
    (imageIds || []).forEach((id, index) => {
      let meta = null; try { meta = instanceOf(id); } catch (_) {}
      if (meta?.SOPInstanceUID === sop && frameOf(id) === frame) found = found === -1 ? index : -2;
    });
    return found >= 0 ? found : -1;
  }

  // Window width and level of a window range (the viewer's own conversion when given, else the DICOM linear one).
  function windowOf(range, convert) {
    if (!range || !Number.isFinite(range.lower) || !Number.isFinite(range.upper)) return null;
    let value = null;
    try { value = typeof convert === 'function' ? convert(range.lower, range.upper) : null; } catch (_) { value = null; }
    const w = value && Number.isFinite(value.windowWidth) ? value.windowWidth : Math.abs(range.upper - range.lower) + 1;
    const l = value && Number.isFinite(value.windowCenter) ? value.windowCenter : (range.lower + range.upper + 1) / 2;
    return { w: Math.round(w), l: Math.round(l) };
  }
  // "Zoom 377%, W 162 / L 112, Image 32" for one saved cell; `parts` names the parts to say (all by default).
  function cellText(cell, convert, parts = { zoom: true, window: true, image: true }) {
    if (!cell) return '';
    const words = [];
    if (parts.zoom) words.push('Zoom ' + Math.round(cell.zoom * 100) + '%');
    const wl = parts.window ? windowOf(cell.properties?.voiRange, convert) : null;
    if (wl) words.push('W ' + wl.w + ' / L ' + wl.l);
    if (parts.image) words.push('Image ' + (cell.index + 1));
    return words.join(', ');
  }
  // The cell the summary speaks of: the active one when it holds a saved image, else the first that does.
  const mainCell = view => view.cells[view.active] || view.cells.find(Boolean);
  function summary(view, convert) {
    if (!view) return 'No view of this study is saved.';
    const cells = view.cells.filter(Boolean).length;
    return cells + (cells === 1 ? ' cell' : ' cells') + ' · ' + cellText(mainCell(view), convert);
  }
  // The badge after a reopen, from what was actually put back: per saved cell { zoom, window, image } (true when that part
  // was put back), or null for a cell that was not. Null when nothing was put back.
  function restoredText(view, results, convert) {
    const index = view.cells[view.active] ? view.active : view.cells.findIndex(Boolean);
    const main = results[index], saved = view.cells.map((cell, i) => cell ? i : -1).filter(i => i >= 0);
    const done = saved.filter(i => results[i] && (results[i].zoom || results[i].window || results[i].image)).length;
    if (!done) return null;
    const words = main && (main.zoom || main.window || main.image) ? cellText(view.cells[index], convert, main) : '';
    const missed = saved.length - done;
    return 'Restored saved view' + (words ? ': ' + words : '') + (saved.length > 1 ? ' (' + done + ' of ' + saved.length + ' cells' + (missed ? '; ' + missed + ' not restored' : '') + ')' : '');
  }

  const api = Object.freeze({ validate, frameOf, findImage, windowOf, cellText, summary, restoredText });
  root.KinAutoViewModel = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
