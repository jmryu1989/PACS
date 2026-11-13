// Pure values of the Measure menu's base tools: Spine Label level order, Circle by Diameter shape and statistics,
// and the texts of Marking, Text and Memo. Nothing here reads the screen; coordinates are image pixel coordinates
// (column x, row y; a whole number is the centre of a pixel) and lengths are millimetres.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.KinMeasureToolsModel = api;
})(globalThis, () => {
  const finite = n => typeof n === 'number' && Number.isFinite(n);

  // ── Spine Label ──
  const DIRECTIONS = Object.freeze(['Top to bottom', 'Bottom to top']);
  const ALL_LEVELS = Object.freeze(spineLevels(true, true));
  function spineLevels(includeC8, includeL6) {
    return [...Array.from({ length: includeC8 ? 8 : 7 }, (_, i) => 'C' + (i + 1)), ...Array.from({ length: 12 }, (_, i) => 'T' + (i + 1)),
      ...Array.from({ length: includeL6 ? 6 : 5 }, (_, i) => 'L' + (i + 1)), 'S1'];
  }
  // The levels to stamp from the start level on, one per press. null when the start is not one of the levels.
  function spineOrder({ start, includeC8, includeL6, direction }) {
    const levels = spineLevels(!!includeC8, !!includeL6), at = levels.indexOf(start);
    if (at < 0 || !DIRECTIONS.includes(direction)) return null;
    return { levels, order: direction === DIRECTIONS[0] ? levels.slice(at) : levels.slice(0, at + 1).reverse() };
  }
  // The preview line: every level, the start level in brackets.
  const spinePreview = (levels, start) => levels.map(level => level === start ? '[' + level + ']' : level).join(' ');
  const spineLevel = value => typeof value === 'string' && ALL_LEVELS.includes(value);

  // ── Circle by Diameter ──
  // A circle of the given diameter on the patient: on pixels that are not square it is an ellipse of pixels.
  // spacing = [row spacing, column spacing] in mm (DICOM PixelSpacing order).
  function circleShape(center, diameter, spacing) {
    if (!Array.isArray(center) || center.length !== 2 || !center.every(finite)) throw new Error('원의 가운데를 확인할 수 없습니다');
    if (!finite(diameter) || diameter <= 0) throw new Error('지름은 0보다 커야 합니다');
    if (!Array.isArray(spacing) || spacing.length !== 2 || !spacing.every(n => finite(n) && n > 0)) throw new Error('이 영상에서는 mm 지름을 쓸 수 없습니다');
    const radius = diameter / 2, rx = radius / spacing[1], ry = radius / spacing[0];
    return { center: [...center], radius, rx, ry, edge: [center[0] + rx, center[1]], area: Math.PI * radius * radius };
  }
  // The pixels whose centres lie inside the circle on the patient, within the image.
  function circlePixels(shape, rows, columns, spacing) {
    const out = [];
    const [cx, cy] = shape.center, r2 = shape.radius * shape.radius;
    const x0 = Math.max(0, Math.ceil(cx - shape.rx)), x1 = Math.min(columns - 1, Math.floor(cx + shape.rx));
    const y0 = Math.max(0, Math.ceil(cy - shape.ry)), y1 = Math.min(rows - 1, Math.floor(cy + shape.ry));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) * spacing[1], dy = (y - cy) * spacing[0];
      if (dx * dx + dy * dy <= r2 + 1e-9) out.push([x, y]);
    }
    return out;
  }
  const MAX_PIXELS = 4194304;
  // Mean, SD (of the pixels, not of a sample), minimum, maximum and count of the modality values inside the circle.
  // value(x, y) gives the modality value (rescaled) of one pixel. null when no pixel centre falls inside.
  function circleStats(shape, rows, columns, spacing, value) {
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1) throw new Error('영상 크기를 확인할 수 없습니다');
    if ((2 * shape.rx + 1) * (2 * shape.ry + 1) > MAX_PIXELS) throw new Error('원이 너무 커서 통계를 계산하지 않습니다');
    let count = 0, sum = 0, squares = 0, min = Infinity, max = -Infinity;
    for (const [x, y] of circlePixels(shape, rows, columns, spacing)) {
      const n = value(x, y);
      if (!finite(n)) throw new Error('화소값을 읽을 수 없습니다');
      count++; sum += n; squares += n * n; if (n < min) min = n; if (n > max) max = n;
    }
    if (!count) return null;
    const mean = sum / count;
    return { count, mean, sd: Math.sqrt(Math.max(0, squares / count - mean * mean)), min, max };
  }
  // The saved values: [diameter mm, area mm²] and, when calculated, [mean, SD, min, max, pixel count].
  function circleValues(diameter, stats) {
    const area = Math.PI * diameter * diameter / 4;
    return stats ? [diameter, area, stats.mean, stats.sd, stats.min, stats.max, stats.count] : [diameter, area];
  }
  // The lines shown beside a circle and in the panel. unit '' is a pixel value without a unit.
  function circleLines(values, unit, basisLabel) {
    if (!Array.isArray(values) || ![2, 7].includes(values.length) || !values.every(finite)) return ['재확인 필요: 값을 확인할 수 없습니다'];
    const one = n => (Math.round(n * 10) / 10).toFixed(1), u = unit ? ' ' + unit : '';
    const lines = ['Ø ' + one(values[0]) + ' mm · Area ' + one(values[1]) + ' mm²'];
    if (values.length === 7) lines.push('Mean ' + one(values[2]) + u + ' · SD ' + one(values[3]) + u, 'Min ' + one(values[4]) + u + ' · Max ' + one(values[5]) + u + ' · n ' + values[6]);
    else lines.push('통계 없음(원 안에 화소가 없거나 색 영상)');
    if (basisLabel) lines.push(basisLabel);
    return lines;
  }

  // ── Marking, Text and Memo ──
  const TEXT_LIMIT = 1000, TITLE_LIMIT = 200, MARKING_LIMIT = 60, MARKINGS = 30;
  // A text as stamped: no NUL, no unpaired surrogate; trimmed; within the limit; null otherwise (or when empty).
  function cleanText(value, limit = TEXT_LIMIT) {
    if (typeof value !== 'string' || /[\u0000]/.test(value)) return null;
    try { encodeURIComponent(value); } catch (_) { return null; }
    const text = value.trim();
    return text && [...text].length <= limit ? text : null;
  }
  // The account's Marking list, read as stored: only distinct one-line texts within the limits; anything else is dropped.
  function markingList(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      const text = cleanText(entry, MARKING_LIMIT);
      if (text && !/[\r\n]/.test(text) && !out.includes(text) && out.length < MARKINGS) out.push(text);
    }
    return out;
  }
  function addMarking(list, value) {
    const text = cleanText(value, MARKING_LIMIT);
    if (!text || /[\r\n]/.test(text)) return { list, error: '문구는 한 줄, ' + MARKING_LIMIT + '자까지입니다.' };
    if (list.includes(text)) return { list, error: '이미 목록에 있는 문구입니다.' };
    if (list.length >= MARKINGS) return { list, error: '목록은 ' + MARKINGS + '개까지입니다.' };
    return { list: [...list, text], error: '' };
  }

  return Object.freeze({ DIRECTIONS, ALL_LEVELS, spineLevels, spineOrder, spinePreview, spineLevel,
    circleShape, circlePixels, circleStats, circleValues, circleLines, MAX_PIXELS,
    TEXT_LIMIT, TITLE_LIMIT, MARKING_LIMIT, MARKINGS, cleanText, markingList, addMarking });
});
