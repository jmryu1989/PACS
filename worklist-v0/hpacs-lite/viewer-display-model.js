// Display menu calculations without the screen: zoom percent, the 180° orientation rule, the user's W/L presets,
// overlay items, corner items and the ruler length. viewer-features-display.js loads this file; tests load it alone.
(function (root) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const MODALITY = /^[A-Z][A-Z0-9]{1,3}$/;

  // ── Zoom: 100% is the size that fits the cell (the viewer's own zoom 1) ──
  const ZOOM_PRESETS = [50, 75, 100, 150, 200, 300, 400];
  const ZOOM_MIN = 10, ZOOM_MAX = 1600;
  const zoomPercent = zoom => finite(zoom) && zoom > 0 ? Math.round(zoom * 100) : null;
  // A typed percent ("150", "150%", " 75 ") as the viewer's zoom, or null when it is not a number in range.
  function zoomFromPercent(value) {
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/%$/, '').trim() : '';
    if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
    const percent = Number(text);
    return percent >= ZOOM_MIN && percent <= ZOOM_MAX ? percent / 100 : null;
  }
  // The camera that magnifies by `factor` while the world point `point` stays where it is on the screen.
  function anchoredZoom(camera, point, factor) {
    if (!camera || !Array.isArray(point) || point.length !== 3 || !finite(factor) || factor <= 0) return null;
    const { focalPoint, position, parallelScale } = camera;
    if (![focalPoint, position].every(v => Array.isArray(v) && v.length === 3 && v.every(finite)) || !finite(parallelScale) || !point.every(finite)) return null;
    const shift = point.map((value, i) => (value - focalPoint[i]) * (1 - 1 / factor));
    return { focalPoint: focalPoint.map((value, i) => value + shift[i]), position: position.map((value, i) => value + shift[i]), parallelScale: parallelScale / factor };
  }

  // ── Auto Rotate 180°: Image Orientation (Patient) against the standard display of its plane ──
  // Standard: axial rows go to the patient's left (+x) and columns to the back (+y); coronal rows +x and columns to the
  // feet (−z); sagittal rows to the back (+y) and columns −z. Only both directions reversed is a 180° turn; one reversed
  // is a mirror image and is left alone. Each direction must lie within the tolerance of one axis (largest component
  // of the unit vector ≥ 0.9); otherwise the plane is oblique and nothing is decided.
  const TOLERANCE = 0.9;
  const STANDARD = { axial: [[0, 1], [1, 1]], coronal: [[0, 1], [2, -1]], sagittal: [[1, 1], [2, -1]] };
  function mainAxis(vector) {
    const length = Math.hypot(...vector);
    if (!(length > 0)) return null;
    const unit = vector.map(value => value / length);
    let axis = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(unit[i]) > Math.abs(unit[axis])) axis = i;
    return Math.abs(unit[axis]) >= TOLERANCE ? [axis, Math.sign(unit[axis])] : null;
  }
  function parseIOP(value) {
    const list = typeof value === 'string' ? value.split('\\') : value;
    if (!Array.isArray(list) || list.length !== 6) return null;
    const numbers = list.map(item => typeof item === 'string' && item.trim() ? Number(item) : item);
    return numbers.every(finite) ? numbers : null;
  }
  function orientation(value) {
    const iop = parseIOP(value);
    if (!iop) return { state: 'missing', plane: null };
    const row = mainAxis(iop.slice(0, 3)), column = mainAxis(iop.slice(3));
    if (!row || !column || row[0] === column[0]) return { state: 'oblique', plane: null };
    const normal = 3 - row[0] - column[0];
    const plane = ['sagittal', 'coronal', 'axial'][normal];
    const [standardRow, standardColumn] = STANDARD[plane];
    // Rows and columns along the other plane's axes (a 90° turn or a transposed image): not this rule's case.
    if (row[0] !== standardRow[0] || column[0] !== standardColumn[0]) return { state: 'other', plane };
    const rowSame = row[1] === standardRow[1], columnSame = column[1] === standardColumn[1];
    return { state: rowSame && columnSame ? 'standard' : !rowSame && !columnSame ? 'rotated-180' : 'mirrored', plane };
  }

  // ── My W/L Presets: { CT: [{ name, w, l }], … } ──
  const PRESET_NAME = 60, PRESETS_PER_MODALITY = 20, MODALITIES = 32;
  const presetName = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  function preset(value) {
    if (!plain(value)) return null;
    const name = presetName(value.name), w = Number(value.w), l = Number(value.l);
    if (!name || name.length > PRESET_NAME || !finite(w) || !(w >= 1) || w > 100000 || !finite(l) || Math.abs(l) > 100000) return null;
    return { name, w: Math.round(w * 100) / 100, l: Math.round(l * 100) / 100 };
  }
  function presets(value) {
    const out = {};
    if (!plain(value)) return out;
    for (const key of Object.keys(value).slice(0, MODALITIES)) {
      if (!MODALITY.test(key) || !Array.isArray(value[key])) continue;
      const list = [];
      for (const item of value[key]) {
        const valid = preset(item);
        if (valid && !list.some(other => other.name === valid.name) && list.length < PRESETS_PER_MODALITY) list.push(valid);
      }
      if (list.length) out[key] = list;
    }
    return out;
  }
  // The stored value after saving one preset: { ok, value, reason }. The same name is replaced in its place.
  function savePreset(stored, modality, item) {
    const value = presets(stored), valid = preset(item);
    if (!MODALITY.test(modality || '')) return { ok: false, reason: 'modality', value };
    if (!valid) return { ok: false, reason: !presetName(item?.name) ? 'name' : presetName(item?.name).length > PRESET_NAME ? 'name-length' : 'numbers', value };
    const list = value[modality] ? value[modality].slice() : [];
    const at = list.findIndex(other => other.name === valid.name);
    if (at >= 0) list[at] = valid;
    else if (list.length >= PRESETS_PER_MODALITY) return { ok: false, reason: 'full', value };
    else list.push(valid);
    if (!value[modality] && Object.keys(value).length >= MODALITIES) return { ok: false, reason: 'full', value };
    return { ok: true, value: { ...value, [modality]: list } };
  }
  function deletePreset(stored, modality, name) {
    const value = presets(stored);
    if (!value[modality]) return value;
    const list = value[modality].filter(item => item.name !== name);
    const next = { ...value };
    if (list.length) next[modality] = list; else delete next[modality];
    return next;
  }
  // A window as the viewer keeps it ({ lower, upper }) and back; the same rounding as the stock corner text.
  const toRange = (w, l) => ({ lower: l - w / 2, upper: l + w / 2 });
  const fromRange = range => plain(range) && finite(range.lower) && finite(range.upper) && range.upper > range.lower
    ? { w: Math.round(range.upper - range.lower), l: Math.round((range.upper + range.lower) / 2) } : null;

  // ── Overlay Items ──
  const OVERLAY_DEFAULTS = Object.freeze({ wl: true, zoom: true, ruler: false, dicom: true, border: false, colour: '#E8C547', width: 2 });
  function overlay(value) {
    const out = { ...OVERLAY_DEFAULTS };
    if (!plain(value)) return out;
    for (const key of ['wl', 'zoom', 'ruler', 'dicom', 'border']) if (typeof value[key] === 'boolean') out[key] = value[key];
    if (typeof value.colour === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value.colour)) out.colour = value.colour.toUpperCase();
    if (Number.isInteger(value.width) && value.width >= 1 && value.width <= 4) out.width = value.width;
    return out;
  }

  // ── Corner Information: { CT: { TL: [k, k, k], TR, BL, BR }, … } ──
  const CORNERS = ['TL', 'TR', 'BL', 'BR'], LINES = 3;
  const TAGS = ['PatientName', 'PatientID', 'PatientSex', 'PatientAge', 'StudyDate', 'StudyTime', 'StudyDescription', 'AccessionNumber',
    'SeriesNumber', 'SeriesDescription', 'InstanceNumber', 'Modality', 'InstitutionName', 'Manufacturer', 'BodyPartExamined',
    'ViewPosition', 'ImageLaterality', 'SliceThickness', 'KVP', 'ReferringPhysicianName'];
  // A DICOM keyword or a tag number; "(0018,0050)", "0018,0050" and "00180050" are the same tag.
  function field(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(text)) return text;
    const tag = /^\(?\s*([0-9A-Fa-f]{4})\s*,?\s*([0-9A-Fa-f]{4})\s*\)?$/.exec(text);
    return tag ? '(' + tag[1].toUpperCase() + ',' + tag[2].toUpperCase() + ')' : null;
  }
  function corners(value) {
    const out = {};
    if (!plain(value)) return out;
    for (const key of Object.keys(value).slice(0, MODALITIES)) {
      const set = value[key];
      if (!MODALITY.test(key) || !plain(set)) continue;
      const clean = {};
      for (const corner of CORNERS) {
        const lines = Array.isArray(set[corner]) ? set[corner].slice(0, LINES) : [];
        clean[corner] = Array.from({ length: LINES }, (_, i) => lines[i] === '' || lines[i] == null ? '' : field(lines[i]) || '');
      }
      out[key] = clean;
    }
    return out;
  }
  // The starting choice for a modality never saved: the stock corner text's own items where there is one.
  const cornerDefaults = () => ({ TL: ['StudyDate', 'SeriesDescription', ''], TR: ['', '', ''], BL: ['', '', ''], BR: ['InstanceNumber', '', ''] });
  // One value as text: person names by their alphabetic part, several values joined by "\" as DICOM writes them.
  function text(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(text).join('\\');
    if (plain(value)) return typeof value.Alphabetic === 'string' ? value.Alphabetic : '';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
    return String(value);
  }
  // Tag numbers of the listed items and other common display items; the viewer's metadata keeps them by keyword.
  const KEYWORDS = {
    '00100010': 'PatientName', '00100020': 'PatientID', '00100040': 'PatientSex', '00101010': 'PatientAge', '00080020': 'StudyDate',
    '00080030': 'StudyTime', '00081030': 'StudyDescription', '00080050': 'AccessionNumber', '00200011': 'SeriesNumber',
    '0008103E': 'SeriesDescription', '00200013': 'InstanceNumber', '00080060': 'Modality', '00080080': 'InstitutionName',
    '00080070': 'Manufacturer', '00180015': 'BodyPartExamined', '00185101': 'ViewPosition', '00200062': 'ImageLaterality',
    '00180050': 'SliceThickness', '00180060': 'KVP', '00080090': 'ReferringPhysicianName', '00180088': 'SpacingBetweenSlices',
    '00201041': 'SliceLocation', '00181150': 'ExposureTime', '00181151': 'XRayTubeCurrent', '00181152': 'Exposure',
    '00281050': 'WindowCenter', '00281051': 'WindowWidth', '00080021': 'SeriesDate', '00080031': 'SeriesTime',
    '00081090': 'ManufacturerModelName', '00181030': 'ProtocolName', '00200012': 'AcquisitionNumber', '00080022': 'AcquisitionDate',
    '00080032': 'AcquisitionTime', '00100030': 'PatientBirthDate', '00181020': 'SoftwareVersions', '00280030': 'PixelSpacing',
    '00181164': 'ImagerPixelSpacing', '00280010': 'Rows', '00280011': 'Columns', '00200032': 'ImagePositionPatient',
    '00200037': 'ImageOrientationPatient', '00180080': 'RepetitionTime', '00180081': 'EchoTime', '00180087': 'MagneticFieldStrength',
  };
  // A field's value from an instance's metadata: by keyword, or a tag number through its keyword (or the number itself,
  // as metadata keeps a tag it has no keyword for). '\u2014' when the image has no value.
  function lookup(fieldName, instance) {
    if (!fieldName || !instance) return fieldName ? '\u2014' : null;
    let key = fieldName;
    if (fieldName[0] === '(') {
      const hex = fieldName.slice(1, 5) + fieldName.slice(6, 10);
      key = KEYWORDS[hex] && own(instance, KEYWORDS[hex]) ? KEYWORDS[hex] : hex;
    }
    const shown = own(instance, key) ? text(instance[key]) : '';
    return shown === '' ? '\u2014' : shown;
  }
  // The name in the choice lists: "Slice Thickness", "Patient ID", "kVp"; a tag number as typed.
  const LABELS = { KVP: 'kVp' };
  function fieldLabel(fieldName) {
    if (!fieldName) return '(none)';
    if (fieldName[0] === '(' || LABELS[fieldName]) return LABELS[fieldName] || fieldName;
    return fieldName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  }
  // One corner line: "SliceThickness: 2.5 mm", "(0019,1001): —". Units only for the few items whose DICOM unit is fixed.
  const UNITS = { SliceThickness: 'mm', SpacingBetweenSlices: 'mm', SliceLocation: 'mm', KVP: 'kV', ExposureTime: 'ms', XRayTubeCurrent: 'mA' };
  function line(fieldName, instance) {
    const value = lookup(fieldName, instance);
    if (value === null) return null;
    const keyword = fieldName[0] === '(' ? KEYWORDS[fieldName.slice(1, 5) + fieldName.slice(6, 10)] : fieldName;
    return fieldName + ': ' + value + (value !== '\u2014' && UNITS[keyword] ? ' ' + UNITS[keyword] : '');
  }

  // ── Ruler: the on-screen length of `mm` given the image's pixel spacing and the screen pixels per image pixel ──
  function rulerPixels(mm, spacingMm, screenPerImagePixel) {
    if (![mm, spacingMm, screenPerImagePixel].every(finite) || mm <= 0 || spacingMm <= 0 || screenPerImagePixel <= 0) return null;
    return mm / spacingMm * screenPerImagePixel;
  }

  // ── VOI LUT: whether the instance's header carries one (a table or a non-linear function) ──
  function voiKind(spec) {
    if (!spec || !spec.voi) return 'none';
    if (spec.voi.lut) return 'table';
    if (spec.voi.fn === 'SIGMOID') return 'sigmoid';
    return 'none';
  }

  const api = Object.freeze({
    ZOOM_PRESETS: Object.freeze(ZOOM_PRESETS.slice()), ZOOM_MIN, ZOOM_MAX, zoomPercent, zoomFromPercent, anchoredZoom,
    TOLERANCE, parseIOP, orientation,
    PRESET_NAME, PRESETS_PER_MODALITY, preset, presets, savePreset, deletePreset, toRange, fromRange,
    OVERLAY_DEFAULTS, overlay,
    CORNERS, LINES, TAGS: Object.freeze(TAGS.slice()), field, fieldLabel, corners, cornerDefaults, text, lookup, line,
    rulerPixels, voiKind, modality: value => typeof value === 'string' && MODALITY.test(value),
  });
  root.KinViewerDisplayModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
