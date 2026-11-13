// Display set presets, pure parts: the cell rule kept beside a Hanging Protocol layout, the stack orders and first
// image, the display-stage filter kernels and the reading of a Grayscale Softcopy Presentation State (GSPS).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../worklist-v0/hpacs-lite/hanging-protocol-model.js');
const filters = require('../worklist-v0/hpacs-lite/viewer-image-filter.js');
const gsps = require('../worklist-v0/hpacs-lite/viewer-gsps.js');

const rule = (extra = {}) => ({ ...model.defaultDisplay(), ...extra });
const library = (cells, display) => ({ version: 1, activeRuleId: null, rules: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Chest CT', enabled: true,
  match: { modality: null, retrieveAE: null, bodyPart: null, description: null },
  selectors: [{ alias: 'Current', role: 'current', historical: false, modality: null, retrieveAE: null, bodyPart: null, description: null, laterality: null, order: 'ascending', occurrence: 1 }],
  layout: { rows: 2, cols: 2, cells }, ...(display === undefined ? {} : { display }) }] });

test('a cell rule has exactly the nine values; unknown keys and values are refused', () => {
  assert.deepEqual(Object.keys(model.defaultDisplay()), ['magnification', 'windowing', 'filter', 'sort', 'rotate', 'flip', 'firstImage', 'gspsAuto', 'overlay']);
  const soft = rule({ windowing: { name: 'Soft tissue', w: 400, l: 40 }, filter: 'sharpen', sort: 'position-desc', gspsAuto: true });
  assert.deepEqual(model.displayRule(soft), soft);
  assert.equal(model.displayRule(null), null);
  assert.equal(model.displayRule({ ...soft, brightness: 1 }), undefined);
  const missing = { ...soft }; delete missing.overlay;
  assert.equal(model.displayRule(missing), undefined);
  for (const [key, value] of [['magnification', '100'], ['filter', 'edge'], ['sort', 'random'], ['rotate', 45], ['flip', 'both'], ['firstImage', 'second'], ['gspsAuto', 'on'], ['overlay', 'minimal']])
    assert.equal(model.displayRule({ ...soft, [key]: value }), undefined, key);
  for (const windowing of [{ name: 'Zero', w: 0, l: 40 }, { name: ' Lung', w: 1500, l: -600 }, { name: 'Lung', w: 1500, l: -600, invert: true }, { name: 'Lung', w: '1500', l: -600 }])
    assert.equal(model.displayRule({ ...soft, windowing }), undefined, JSON.stringify(windowing));
  assert.equal(model.isDefaultDisplay(rule()), true);
  assert.equal(model.isDefaultDisplay(rule({ overlay: 'none' })), false);
});

test('the display list keeps string, empty and plane cells and round-trips through storage', () => {
  const plane = { alias: 'Current', view: 'mpr', orientation: 'coronal' };
  const lung = rule({ windowing: { name: 'Lung', w: 1500, l: -600 }, magnification: '1:1' });
  const value = library(['Current', null, plane, 'Current'], [rule({ filter: 'smooth' }), null, null, lung]);
  const clean = model.normalize(value);
  assert.deepEqual(clean, value);
  assert.equal(typeof clean.rules[0].layout.cells[0], 'string');
  assert.deepEqual(clean.rules[0].layout.cells[2], plane);
  const storage = new Map(); const fake = { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, v) };
  const key = model.ownerKey({ institution: 'site', subject: 'reader' });
  model.write(fake, key, value);
  assert.deepEqual(model.read(fake, key), value);
  // Old rules (no display) still pass unchanged.
  const old = library(['Current', null, plane, 'Current']);
  assert.deepEqual(model.normalize(old), old);
  // A rule on an empty or plane cell, or a list that does not match the layout, is refused.
  assert.equal(model.normalize(library(['Current', null, plane, 'Current'], [null, lung, null, null])), null);
  assert.equal(model.normalize(library(['Current', null, plane, 'Current'], [null, null, lung, null])), null);
  assert.equal(model.normalize(library(['Current', null, plane, 'Current'], [null, null, null])), null);
});

test('alignDisplay follows the layout: one entry per cell, null for empty, plane and default cells', () => {
  const lung = rule({ windowing: { name: 'Lung', w: 1500, l: -600 } });
  const plane = { alias: 'Current', view: 'mpr', orientation: 'axial' };
  assert.deepEqual(model.alignDisplay([lung, lung, lung, rule()], ['Current', null, plane, 'Current']), [lung, null, null, null]);
  assert.deepEqual(model.alignDisplay([lung], ['Current', 'Current']), [lung, null]);
  assert.deepEqual(model.alignDisplay(undefined, ['Current']), [null]);
  assert.deepEqual(model.alignDisplay([{ bad: true }], ['Current']), [null]);
});

test('sort orders: instance number, slice position along the normal both ways, acquisition time; missing values last', () => {
  const images = [
    { InstanceNumber: 3, ImagePositionPatient: [0, 0, -20], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], AcquisitionTime: '101500' },
    { InstanceNumber: 1, ImagePositionPatient: [0, 0, 10], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], AcquisitionTime: '101000.5' },
    { InstanceNumber: 2, ImagePositionPatient: [0, 0, 0], ImageOrientationPatient: [1, 0, 0, 0, 1, 0], AcquisitionDateTime: '20260801101200' },
    { ImageOrientationPatient: [1, 0, 0, 0, 1, 0] },
  ];
  assert.deepEqual(model.sortOrder(images, 'stock'), [0, 1, 2, 3]);
  assert.deepEqual(model.sortOrder(images, 'instance'), [1, 2, 0, 3]);
  assert.deepEqual(model.sortOrder(images, 'position-asc'), [0, 2, 1, 3]);
  assert.deepEqual(model.sortOrder(images, 'position-desc'), [1, 2, 0, 3]);
  // Times without a date sort before a full date-time; within each, by time.
  assert.deepEqual(model.sortOrder(images, 'acquisition'), [1, 0, 2, 3]);
  // Equal values keep the stock order.
  assert.deepEqual(model.sortOrder([{ InstanceNumber: 1 }, { InstanceNumber: 1 }], 'instance'), [0, 1]);
  // DICOM string lists (backslash) are read too.
  assert.deepEqual(model.sortOrder([{ ImagePositionPatient: '0\\0\\5', ImageOrientationPatient: '1\\0\\0\\0\\1\\0' }, { ImagePositionPatient: '0\\0\\1', ImageOrientationPatient: '1\\0\\0\\0\\1\\0' }], 'position-asc'), [1, 0]);
});

test('first image: first, middle and last of the sorted stack', () => {
  assert.equal(model.firstIndex(5, 'first'), 0);
  assert.equal(model.firstIndex(5, 'middle'), 2);
  assert.equal(model.firstIndex(4, 'middle'), 1);
  assert.equal(model.firstIndex(5, 'last'), 4);
  assert.equal(model.firstIndex(0, 'last'), 0);
});

test('filter kernels keep a flat picture as it is; Sharpen raises an edge, Smooth lowers it', () => {
  for (const kind of ['sharpen', 'smooth']) {
    const k = filters.kernel(kind);
    assert.equal(k.matrix.reduce((a, b) => a + b, 0) / k.divisor, 1, kind + ' keeps the mean');
    assert.deepEqual(filters.convolve(new Array(9).fill(120), 3, 3, kind), new Array(9).fill(120));
  }
  const edge = [100, 100, 200, 200, 100, 100, 200, 200, 100, 100, 200, 200, 100, 100, 200, 200];
  const sharp = filters.convolve(edge, 4, 4, 'sharpen'), smooth = filters.convolve(edge, 4, 4, 'smooth');
  assert.ok(sharp[5] < 100 && sharp[6] > 200, 'Sharpen: the edge pixels move apart ' + sharp);
  assert.ok(smooth[5] > 100 && smooth[6] < 200, 'Smooth: the edge pixels move together ' + smooth);
  assert.deepEqual(filters.convolve(edge, 4, 4, 'none'), edge);
  assert.equal(filters.kernel('none'), null);
});

// A GSPS as DICOMweb JSON: names two images, a window for the first, inverse, a 90° turn, a displayed area and annotations.
const sq = items => ({ vr: 'SQ', Value: items });
const ref = (sop, frames) => ({ '00081155': { vr: 'UI', Value: [sop] }, ...(frames ? { '00081160': { vr: 'IS', Value: frames } } : {}) });
const PR = (sop, date, time, extra = {}) => ({
  '00080016': { vr: 'UI', Value: [gsps.GSPS_CLASS] }, '00080018': { vr: 'UI', Value: [sop] }, '00080060': { vr: 'CS', Value: ['PR'] },
  '00700080': { vr: 'CS', Value: ['READER'] }, '00700082': { vr: 'DA', Value: [date] }, '00700083': { vr: 'TM', Value: [time] },
  '00081115': sq([{ '00081140': sq([ref('1.2.3.1'), ref('1.2.3.2')]) }]), ...extra });
test('a GSPS is read: window, inverse, rotation and flip, displayed area and annotations, for the images it names', () => {
  const json = PR('1.2.9.1', '20260801', '101500', {
    '00283110': sq([{ '00081140': sq([ref('1.2.3.1')]), '00281050': { vr: 'DS', Value: [50] }, '00281051': { vr: 'DS', Value: ['350'] } }]),
    '20500020': { vr: 'CS', Value: ['INVERSE'] }, '00700042': { vr: 'US', Value: [90] }, '00700041': { vr: 'CS', Value: ['Y'] },
    '0070005A': sq([{ '00700052': { vr: 'SL', Value: [11, 21] }, '00700053': { vr: 'SL', Value: [110, 220] }, '00700100': { vr: 'CS', Value: ['SCALE TO FIT'] } }]),
    '00700001': sq([{ '00081140': sq([ref('1.2.3.2')]), '00700002': { vr: 'CS', Value: ['LAYER1'] },
      '00700009': sq([{ '00700005': { vr: 'CS', Value: ['PIXEL'] }, '00700023': { vr: 'CS', Value: ['POLYLINE'] }, '00700022': { vr: 'FL', Value: [10, 10, 50, 10, 50, 40] }, '00700024': { vr: 'CS', Value: ['N'] } },
        { '00700005': { vr: 'CS', Value: ['PIXEL'] }, '00700023': { vr: 'CS', Value: ['CIRCLE'] }, '00700022': { vr: 'FL', Value: [30, 30, 30, 40] } }]),
      '00700008': sq([{ '00700004': { vr: 'CS', Value: ['PIXEL'] }, '00700014': { vr: 'FL', Value: [12, 14] }, '00700006': { vr: 'ST', Value: ['Nodule'] } }]) }]),
  });
  const p = gsps.parse(json);
  assert.equal(p.sop, '1.2.9.1'); assert.equal(p.label, 'READER'); assert.equal(p.created, '20260801101500');
  const first = gsps.forImage(p, '1.2.3.1');
  assert.deepEqual(first.voi, { center: 50, width: 350 });
  assert.equal(first.invert, true); assert.equal(first.rotation, 90); assert.equal(first.horizontalFlip, true);
  assert.deepEqual(first.area, { from: [10, 20], to: [110, 220], mode: 'SCALE TO FIT', magnification: null });
  assert.deepEqual(first.graphics, [], 'the annotations name only the second image');
  const second = gsps.forImage(p, '1.2.3.2');
  assert.equal(second.voi, null, 'the window names only the first image');
  assert.deepEqual(second.graphics.map(g => [g.type, g.points.length, g.layer]), [['POLYLINE', 3, 'LAYER1'], ['CIRCLE', 2, 'LAYER1']]);
  assert.deepEqual(second.texts.map(t => [t.text, t.anchor]), [['Nodule', [12, 14]]]);
  const circle = gsps.outline(second.graphics[1], 8);
  assert.equal(circle.closed, true); assert.ok(circle.points.every(([x, y]) => Math.abs(Math.hypot(x - 30, y - 30) - 10) < 1e-9));
  assert.equal(gsps.outline(second.graphics[0]).closed, false);
});

test('the latest GSPS that names the image (and frame) is chosen; other objects are not GSPS', () => {
  const older = gsps.parse(PR('1.2.9.1', '20260801', '090000')), newer = gsps.parse(PR('1.2.9.2', '20260801', '101500.25'));
  const other = gsps.parse(PR('1.2.9.3', '20260901', '000000', { '00081115': sq([{ '00081140': sq([ref('1.2.3.7')]) }]) }));
  assert.equal(gsps.latest([older, newer, other], '1.2.3.1').sop, '1.2.9.2');
  assert.equal(gsps.latest([older, newer, other], '1.2.3.7').sop, '1.2.9.3');
  assert.equal(gsps.latest([older, newer], '1.2.3.9'), null);
  const framed = gsps.parse(PR('1.2.9.4', '20261001', '000000', { '00081115': sq([{ '00081140': sq([ref('1.2.3.5', [2])]) }]) }));
  assert.equal(gsps.latest([framed], '1.2.3.5', 1), null);
  assert.equal(gsps.latest([framed], '1.2.3.5', 2).sop, '1.2.9.4');
  assert.equal(gsps.parse({ ...PR('1.2.9.5', '20260801', '000000'), '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.88.11'] } }), null, 'an SR is not a GSPS');
  assert.equal(gsps.parse({ '00080018': { vr: 'UI', Value: ['1.2.9.6'] } }), null);
  assert.equal(gsps.parse(PR('1.2.9.7', '20260801', '000000', { '00081115': sq([]) })), null, 'a GSPS that names no image applies to none');
});
