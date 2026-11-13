// The Prior Studies controller's connection for the Compare menu (worklist-v0/hpacs-lite/viewer-prior-controller.js
// `related`): the list for any cell without the panel, opening a chosen series, and changing several comparison cells
// together — every study loads first, and a failure, a cell that changed or a patient switch changes none.
// Synthetic studies only. node --test tests/viewer_prior_related_test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite', 'viewer-prior-controller.js');
const source = fs.readFileSync(file, 'utf8');

const STUDIES = [
  { uid: 'cur', date: '20260812', sourcePatientKey: 'PK' },
  { uid: 'aug', date: '20250812', sourcePatientKey: 'PK' },
  { uid: 'may', date: '20250502', sourcePatientKey: 'PK' },
  { uid: 'other', date: '20250101', sourcePatientKey: 'OTHER' },
];

function world() {
  const w = { cells: new Map(), patient: { key: 'PK', sequence: 1, studyUIDs: ['cur'] }, loads: [], replaced: [], compared: [], assigned: [], listed: [], fail: null, during: null };
  const win = { KinSessionTransport: { refusal: () => null, responseError: () => new Error('ended') } };
  const fetch = async () => ({ ok: true, status: 200, json: async () => ({ studies: STUDIES.map(row => ({ ...row })) }) });
  const Controller = vm.runInThisContext('(function (window, fetch) {' + source + '\nreturn window.KinViewerPriorController; })', { filename: file })(win, fetch);
  const cell = (id, study, set) => ({ patientKey: 'PK', sequence: 1, viewportId: id, studyUid: study, seriesUid: study + '-s', displaySetUid: set, mode: 'stack' });
  w.cells.set('left', cell('left', 'cur', 'set-cur')); w.cells.set('right', cell('right', 'aug', 'set-aug')); w.cells.set('third', cell('third', 'aug', 'set-aug-2'));
  const viewer = {
    viewport: id => w.cells.get(id) ? { ...w.cells.get(id) } : null,
    snapshot: () => ({ ...w.patient }),
    subscribe: () => () => {},
    async compare(value, sets) { w.compared.push([value.viewportId, sets]); return true; },
    async assign(value, sets) { w.assigned.push([value.viewportId, sets]); return true; },
    async replace(plan) { w.replaced.push(plan.map(entry => [entry.value.viewportId, entry.displaySetInstanceUIDs])); return true; },
  };
  w.controller = Controller.create({ viewer, onList: value => w.listed.push(value.state), onReport() {},
    async loadStudy(uid, origin) {
      w.loads.push([uid, origin.viewportId]);
      if (w.during) w.during(uid, origin);
      if (w.fail === uid + ':' + origin.viewportId) throw new Error('metadata failed');
      // Ranked for the asking cell: its own series name first.
      return [{ displaySetInstanceUID: uid + '-for-' + origin.viewportId, SeriesInstanceUID: uid + '-ranked' }, { displaySetInstanceUID: uid + '-second', SeriesInstanceUID: uid + '-second-s' }];
    } });
  w.value = id => ({ ...w.cells.get(id) });
  return w;
}

test('studies: the patient list for any cell, related to the current study, without opening or closing the panel', async () => {
  const w = world();
  const rows = await w.controller.related.studies(w.value('right'));
  assert.deepEqual(rows.map(row => [row.uid, row.date, row.relation]), [['cur', '2026-08-12', 'Current'], ['aug', '2025-08-12', 'Prior'], ['may', '2025-05-02', 'Prior']]);
  assert.deepEqual(w.listed, []);
  // Asked for a cell that shows something else now: no list.
  const stale = w.value('right');
  w.cells.get('right').displaySetUid = 'changed';
  assert.equal(await w.controller.related.studies(stale), null);
});

test('replace: every comparison cell loads its own ranked series first, then all change in one request', async () => {
  const w = world(), rows = await w.controller.related.studies(w.value('left'));
  assert.equal(await w.controller.related.replace([{ value: w.value('right'), uid: 'may' }, { value: w.value('third'), uid: 'may' }], { studies: rows }), true);
  assert.deepEqual(w.loads, [['may', 'right'], ['may', 'third']]);
  assert.deepEqual(w.replaced, [[['right', ['may-for-right']], ['third', ['may-for-third']]]]);
});

test('replace: a failed load, a cell that changed, a patient switch or a study outside the list changes nothing', async () => {
  let w = world(), rows = await w.controller.related.studies(w.value('left'));
  w.fail = 'may:third';
  await assert.rejects(w.controller.related.replace([{ value: w.value('right'), uid: 'may' }, { value: w.value('third'), uid: 'may' }], { studies: rows }), /metadata failed/);
  assert.deepEqual(w.replaced, []);
  w = world(); rows = await w.controller.related.studies(w.value('left'));
  w.during = uid => { w.cells.get('right').displaySetUid = 'set-other'; };
  assert.equal(await w.controller.related.replace([{ value: w.value('right'), uid: 'may' }, { value: w.value('third'), uid: 'may' }], { studies: rows }), false);
  assert.deepEqual(w.replaced, []);
  w = world(); rows = await w.controller.related.studies(w.value('left'));
  w.during = () => { w.patient = { ...w.patient, sequence: 2 }; };
  assert.equal(await w.controller.related.replace([{ value: w.value('right'), uid: 'may' }], { studies: rows }), false);
  assert.deepEqual(w.replaced, []);
  w = world(); rows = await w.controller.related.studies(w.value('left'));
  assert.equal(await w.controller.related.replace([{ value: w.value('right'), uid: 'other' }], { studies: rows }), false);
  assert.deepEqual(w.loads, []);
  // The caller's signal ends while a study loads (a target cell went A->B->A, or a newer press): nothing changes.
  w = world(); rows = await w.controller.related.studies(w.value('left'));
  const request = new AbortController();
  w.during = () => request.abort();
  assert.equal(await w.controller.related.replace([{ value: w.value('right'), uid: 'may' }, { value: w.value('third'), uid: 'may' }], { studies: rows, signal: request.signal }), false);
  assert.deepEqual(w.replaced, []);
  const again = new AbortController();
  w.during = () => again.abort();
  assert.equal(await w.controller.related.open(w.value('left'), 'may', { studies: rows, signal: again.signal }), false);
  assert.deepEqual(w.compared, []);
});

test('open: a chosen series opens itself (not the first ranked); the cell\'s own study goes into that cell', async () => {
  const w = world(), rows = await w.controller.related.studies(w.value('left'));
  assert.equal(await w.controller.related.open(w.value('left'), 'may', { seriesUid: 'may-second-s', studies: rows }), true);
  assert.deepEqual(w.compared, [['left', ['may-second']]]);
  assert.equal(await w.controller.related.open(w.value('left'), 'cur', { seriesUid: 'cur-second-s', studies: rows }), true);
  assert.deepEqual(w.assigned, [['left', ['cur-second']]]);
  assert.equal(await w.controller.related.open(w.value('left'), 'aug', { studies: rows }), true);
  assert.deepEqual(w.compared.at(-1), ['left', ['aug-for-left']]);
});
