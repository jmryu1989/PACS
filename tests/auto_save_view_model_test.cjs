'use strict';
// Auto Save View, the pure part (worklist-v0/hpacs-lite/viewer-auto-view-model.js): the saved view's shape as it is
// read back, finding the saved image by SOP and frame after the cell's stack was sorted again, and the words of the
// last saved view and of the badge, which names only what was actually put back.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const model = require(path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'viewer-auto-view-model.js'));

const STUDY = '1.2.826.0.1.3680043.8.498.140', PRIOR = '1.2.826.0.1.3680043.8.498.141';
const camera = (scale = 100) => ({ focalPoint: [0, 0, -10], position: [0, 0, 90], viewUp: [0, -1, 0], viewPlaneNormal: [0, 0, 1],
  parallelScale: scale, rotation: 0, flipHorizontal: false, flipVertical: true });
const cell = (extra = {}) => ({ study: STUDY, series: STUDY + '.2', sop: STUDY + '.2.32', frame: 1, index: 31, zoom: 3.77, camera: camera(),
  properties: { voiRange: { lower: 31, upper: 192 }, VOILUTFunction: 'LINEAR', invert: false, interpolationType: 1 }, display: null, ...extra });
const view = (extra = {}) => ({ version: 1, studies: [STUDY], rows: 1, cols: 1, active: 0, cells: [cell()], ...extra });
const RULE = { magnification: 'fit', windowing: null, filter: 'sharpen', sort: 'position-desc', rotate: 0, flip: 'none', firstImage: 'first', gspsAuto: false, overlay: 'none' };

test('a saved view reads back only in its exact shape and for its own study', () => {
  assert.deepEqual(model.validate(view(), STUDY), view());
  assert.ok(model.validate(view({ studies: [STUDY, PRIOR], rows: 1, cols: 2, cells: [cell({ display: RULE }), cell({ study: PRIOR, series: PRIOR + '.1', sop: PRIOR + '.1.1' })] }), STUDY));
  for (const [name, bad] of [
    ['another study first', view({ studies: [PRIOR] })],
    ['an unknown key', { ...view(), extra: 1 }],
    ['version 2', view({ version: 2 })],
    ['cells not rows x cols', view({ rows: 2 })],
    ['no saved cell', view({ cells: [null] })],
    ['active out of range', view({ active: 1 })],
    ['a cell of a study not named', view({ cells: [cell({ study: PRIOR })] })],
    ['frame 0', view({ cells: [cell({ frame: 0 })] })],
    ['a zero zoom', view({ cells: [cell({ zoom: 0 })] })],
    ['view-up not at right angles to the normal', view({ cells: [cell({ camera: { ...camera(), viewUp: [0, 0, 1] } })] })],
    ['a window range turned over', view({ cells: [cell({ properties: { ...cell().properties, voiRange: { lower: 5, upper: 4 } } })] })],
    ['an unknown VOI function', view({ cells: [cell({ properties: { ...cell().properties, VOILUTFunction: 'TABLE' } })] })],
    ['a rule of another shape', view({ cells: [cell({ display: { sort: 'stock' } })] })],
    ['a SOP that is no UID', view({ cells: [cell({ sop: 'x' })] })],
  ]) assert.equal(model.validate(bad, STUDY), null, name);
  assert.equal(model.validate(null, STUDY), null);
  assert.equal(model.validate('{"version":1}', STUDY), null);
});

test('the frame of an image id and the saved image found again in a stack sorted the other way', () => {
  assert.equal(model.frameOf('wadors:/dicom-web/studies/1/series/2/instances/3/frames/4'), 4);
  assert.equal(model.frameOf('wadouri:/x?objectUID=3&frame=2'), 2);
  assert.equal(model.frameOf('wadors:/dicom-web/studies/1/series/2/instances/3'), 1);
  const meta = { a: { SOPInstanceUID: '1.1' }, b: { SOPInstanceUID: '1.2' }, c: { SOPInstanceUID: '1.3' } };
  const ids = ['wadors:/i/a/frames/1', 'wadors:/i/b/frames/1', 'wadors:/i/c/frames/1'];
  const of = id => meta[id.split('/')[2]];
  assert.equal(model.findImage(ids, of, '1.2', 1), 1);
  // Sorted the other way (as a cell's Sort rule does): the same image is found at its new place, not at the old index.
  assert.equal(model.findImage([...ids].reverse(), of, '1.2', 1), 1);
  assert.equal(model.findImage([...ids].reverse(), of, '1.3', 1), 0);
  // Frames of one multi-frame image are told apart; a missing or doubled image is not found.
  const frames = ['wadors:/i/a/frames/1', 'wadors:/i/a/frames/2', 'wadors:/i/a/frames/3'];
  assert.equal(model.findImage(frames, of, '1.1', 3), 2);
  assert.equal(model.findImage(frames, of, '1.1', 4), -1);
  assert.equal(model.findImage(['wadors:/i/a/frames/1', 'wadors:/i/a/frames/1'], of, '1.1', 1), -1);
  assert.equal(model.findImage(ids, () => { throw new Error('no metadata'); }, '1.1', 1), -1);
});

test('the last saved view and the badge say what was saved and what was put back', () => {
  // W/L from the window range by the DICOM linear rule (the viewer's own conversion when it is given).
  assert.deepEqual(model.windowOf({ lower: 31, upper: 192 }), { w: 162, l: 112 });
  assert.deepEqual(model.windowOf({ lower: 31, upper: 192 }, (lower, upper) => ({ windowWidth: upper - lower, windowCenter: (upper + lower) / 2 })), { w: 161, l: 112 });
  assert.equal(model.cellText(cell()), 'Zoom 377%, W 162 / L 112, Image 32');
  assert.equal(model.summary(view()), '1 cell · Zoom 377%, W 162 / L 112, Image 32');
  assert.equal(model.summary(null), 'No view of this study is saved.');
  const two = view({ rows: 1, cols: 2, active: 1, cells: [cell({ zoom: 1 }), cell({ index: 0, zoom: 2 })] });
  assert.equal(model.summary(two), '2 cells · Zoom 200%, W 162 / L 112, Image 1');
  assert.equal(model.restoredText(view(), [{ zoom: true, window: true, image: true }]), 'Restored saved view: Zoom 377%, W 162 / L 112, Image 32');
  // Only what was put back: the image was not found, so neither the image nor the zoom is named.
  assert.equal(model.restoredText(view(), [{ zoom: false, window: true, image: false }]), 'Restored saved view: W 162 / L 112');
  assert.equal(model.restoredText(view(), [null]), null);
  assert.equal(model.restoredText(two, [null, { zoom: true, window: true, image: true }]), 'Restored saved view: Zoom 200%, W 162 / L 112, Image 1 (1 of 2 cells; 1 not restored)');
  assert.equal(model.restoredText(two, [{ zoom: true, window: true, image: true }, null]), 'Restored saved view (1 of 2 cells; 1 not restored)');
  assert.equal(model.restoredText(two, [{ zoom: true, window: true, image: true }, { zoom: true, window: true, image: true }]), 'Restored saved view: Zoom 200%, W 162 / L 112, Image 1 (2 of 2 cells)');
});
