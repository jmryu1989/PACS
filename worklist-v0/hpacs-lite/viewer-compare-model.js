// Pure calculations for the viewer's Compare menu: exam marks, the prior order, manual sync steps, the physical
// scale of a cell and where a slice crosses a scout image. Nothing here reads the screen.
(function (root) {
  const validDate = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  };
  // DICOM TM as a sortable HHMMSS.ffffff; an absent or malformed time sorts before every real time.
  const time = value => {
    const text = typeof value === 'string' ? value.trim().replace(/:/g, '') : '';
    if (!/^\d{2}(\d{2}(\d{2}(\.\d{1,6})?)?)?$/.test(text)) return '';
    const [whole, fraction = ''] = text.split('.');
    return whole.padEnd(6, '0') + '.' + fraction.padEnd(6, '0');
  };
  const text = value => typeof value === 'string' ? value : value == null ? '' : String(value);
  // Later first: date, then time; the same date and time fall back to Accession Number, then Study Instance UID.
  const newerFirst = (a, b) => b.date.localeCompare(a.date) || time(b.time).localeCompare(time(a.time))
    || text(a.acc).localeCompare(text(b.acc)) || text(a.uid).localeCompare(text(b.uid));

  // rows: the patient's related studies ({ uid, date 'YYYY-MM-DD', time, acc }); currentUid: the current study.
  // Returns the rows in list order with a mark: '*' for the current study, P1, P2, … for studies dated before it
  // (nearest first), '' for the others (same day, later, or without a date). Rows without a date go last.
  function marks(rows, currentUid) {
    const list = Array.isArray(rows) ? rows.filter(row => row && typeof row.uid === 'string') : [];
    const current = list.find(row => row.uid === currentUid) || null;
    const dated = list.filter(row => row !== current && validDate(row.date));
    const undated = list.filter(row => row !== current && !validDate(row.date)).sort((a, b) => text(a.uid).localeCompare(text(b.uid)));
    const known = current && validDate(current.date);
    const priors = known ? dated.filter(row => row.date < current.date).sort(newerFirst) : [];
    const others = dated.filter(row => !priors.includes(row)).sort(newerFirst);
    return [
      ...(current ? [{ ...current, mark: '*' }] : []),
      ...priors.map((row, index) => ({ ...row, mark: 'P' + (index + 1) })),
      ...others.map(row => ({ ...row, mark: '' })),
      ...undated.map(row => ({ ...row, mark: '' })),
    ];
  }
  const priorUids = marked => marked.filter(row => /^P\d+$/.test(row.mark)).map(row => row.uid);

  // The prior to show after Prev (direction -1, toward the current study) or Next (+1, further back), from the prior
  // now shown. With no prior shown, either goes to the nearest prior. At an end: { end: 'newer' | 'older' | 'none' }.
  function step(priors, shownUid, direction) {
    if (!Array.isArray(priors) || !priors.length) return { end: 'none' };
    const at = priors.indexOf(shownUid);
    if (at < 0) return { uid: priors[0] };
    const next = at + (direction < 0 ? -1 : 1);
    if (next < 0) return { end: 'newer' };
    if (next >= priors.length) return { end: 'older' };
    return { uid: priors[next] };
  }

  // Manual sync keeps the image-number difference the cells had when they were tied (their anchors). The cell the
  // reader moved sets the group's shift; every other cell goes to its anchor plus that shift, stopped at its ends, so a
  // cell stopped at an end returns to its own difference once the shift comes back.
  // members: [{ id, anchor, count }]; returns { id: index } for the other members.
  function follow(members, driverId, driverIndex) {
    const driver = members.find(member => member.id === driverId);
    if (!driver || !Number.isInteger(driverIndex)) return {};
    const shift = driverIndex - driver.anchor, out = {};
    for (const member of members) {
      if (member.id === driverId || !(member.count > 0)) continue;
      out[member.id] = Math.max(0, Math.min(member.count - 1, member.anchor + shift));
    }
    return out;
  }

  const numbers = (value, count) => {
    const list = typeof value === 'string' ? value.split('\\') : Array.isArray(value) ? value : null;
    if (!list || list.length !== count) return null;
    const out = list.map(item => typeof item === 'number' ? item : typeof item === 'string' && item.trim() ? Number(item) : NaN);
    return out.every(Number.isFinite) ? out : null;
  };
  const first = (tags, sequence, key) => {
    const item = tags?.SharedFunctionalGroupsSequence?.[0]?.[sequence]?.[0] ?? tags?.PerFrameFunctionalGroupsSequence?.[0]?.[sequence]?.[0];
    return item?.[key];
  };
  const SOURCES = {
    patient: 'Pixel Spacing (patient)',
    detector: 'Imager Pixel Spacing (detector, not true size)',
    ermf: 'Imager Pixel Spacing / magnification factor (estimated)',
  };
  // The spacing a cell's millimetres come from, with its source, as the measurement tools judge it: Pixel Spacing is
  // in the patient; Imager Pixel Spacing is at the detector, corrected by the Estimated Radiographic Magnification Factor
  // when there is one. None, or one that is not two positive numbers: null.
  function spacing(tags) {
    if (!tags || typeof tags !== 'object') return null;
    const pixel = tags.PixelSpacing ?? first(tags, 'PixelMeasuresSequence', 'PixelSpacing');
    let value = numbers(pixel, 2), source = 'patient';
    if (pixel === undefined || pixel === null) {
      value = numbers(tags.ImagerPixelSpacing, 2); source = 'detector';
      const factor = tags.EstimatedRadiographicMagnificationFactor;
      if (value && factor !== undefined && factor !== null) {
        const k = numbers([factor], 1)?.[0];
        if (!(k > 0)) return null;
        value = value.map(n => n / k); source = 'ermf';
      }
    }
    if (!value || value.some(n => !(n > 0))) return null;
    return { value, source, label: SOURCES[source] };
  }
  // Screen pixels per millimetre from screen pixels per image pixel (horizontal) and the column spacing.
  const pxPerMm = (pxPerPixel, columnSpacing) => pxPerPixel > 0 && columnSpacing > 0 ? pxPerPixel / columnSpacing : null;
  // The zoom that makes a cell show as many screen pixels per millimetre as the reference.
  const ratioZoom = (zoom, reference, now) => zoom > 0 && reference > 0 && now > 0 ? zoom * reference / now : null;

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // An image plane from its own tags only: Image Position and Orientation (Patient) must be present and orthonormal,
  // and a Frame of Reference must be named. Defaults never stand in for a missing value.
  function plane(tags) {
    if (!tags || typeof tags !== 'object') return null;
    const origin = numbers(tags.ImagePositionPatient, 3), orientation = numbers(tags.ImageOrientationPatient, 6);
    const frame = typeof tags.FrameOfReferenceUID === 'string' && tags.FrameOfReferenceUID.trim() ? tags.FrameOfReferenceUID.trim() : null;
    const rows = Number(tags.Rows), columns = Number(tags.Columns), pixel = spacing(tags);
    if (!origin || !orientation || !frame || !Number.isSafeInteger(rows) || !Number.isSafeInteger(columns) || rows < 1 || columns < 1) return null;
    const row = orientation.slice(0, 3), column = orientation.slice(3);
    if (Math.abs(dot(row, row) - 1) > 1e-3 || Math.abs(dot(column, column) - 1) > 1e-3 || Math.abs(dot(row, column)) > 1e-3) return null;
    return { origin, row, column, normal: cross(row, column), rows, columns, spacing: pixel?.value || null, frame };
  }
  const PARALLEL = 1 - 1e-3;
  // Where the slice plane crosses the scout image, in scout pixel coordinates [column, row] (pixel centres at whole
  // numbers), clipped to the image. { reason } when it cannot be drawn: another frame of reference, parallel planes,
  // no spacing, or the slice outside the image.
  function crossLine(scout, slice) {
    if (!scout || !slice) return { reason: 'geometry' };
    if (scout.frame !== slice.frame) return { reason: 'frame' };
    if (!scout.spacing) return { reason: 'geometry' };
    if (Math.abs(dot(scout.normal, slice.normal)) > PARALLEL) return { reason: 'parallel' };
    const n = slice.normal, d = scout.origin.map((v, i) => v - slice.origin[i]);
    const a = dot(n, d), b = dot(n, scout.row) * scout.spacing[1], c = dot(n, scout.column) * scout.spacing[0];
    const left = -0.5, right = scout.columns - 0.5, top = -0.5, bottom = scout.rows - 0.5, points = [];
    const add = (x, y) => {
      if (x < left - 1e-9 || x > right + 1e-9 || y < top - 1e-9 || y > bottom + 1e-9) return;
      if (!points.some(p => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6)) points.push([x, y]);
    };
    if (Math.abs(c) > 1e-12) { add(left, -(a + b * left) / c); add(right, -(a + b * right) / c); }
    if (Math.abs(b) > 1e-12) { add(-(a + c * top) / b, top); add(-(a + c * bottom) / b, bottom); }
    if (points.length < 2) return { reason: 'outside' };
    return { from: points[0], to: points[1] };
  }
  // The patient position of a scout pixel [column, row].
  const scoutPoint = (scout, x, y) => scout.origin.map((v, i) => v + scout.row[i] * x * scout.spacing[1] + scout.column[i] * y * scout.spacing[0]);
  // The index of the slice whose plane lies nearest a patient position; -1 when no slice has a plane.
  function nearestSlice(planes, point) {
    let best = -1, distance = Infinity;
    (planes || []).forEach((p, index) => {
      if (!p) return;
      const gap = Math.abs(dot(p.normal, p.origin.map((v, i) => v - point[i])));
      if (gap < distance - 1e-9) { distance = gap; best = index; }
    });
    return best;
  }

  const api = { validDate, marks, priorUids, step, follow, spacing, pxPerMm, ratioZoom, plane, crossLine, scoutPoint, nearestSlice };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KinCompareModel = api;
})(typeof window === 'object' ? window : globalThis);
