// Run with node --test tests/worklist_prior_test.cjs. No DOM, network or fixture writes.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '../worklist-v0/hpacs-lite/main.html'), 'utf8');
const fmtD = html.match(/^    const fmtD = .*;$/m)?.[0];
const start = html.indexOf('    function validPriorDate(');
const end = html.indexOf('    function openFilmbox(', start);
assert.ok(fmtD && start >= 0 && end > start, 'Test the actual worklist functions, not a copied implementation');
const sandbox = vm.createContext({});
vm.runInContext(`${fmtD}\n${html.slice(start, end)}\nlet studies = [];`, sandbox);

function row(uid, date, changes = {}) {
  return { uid, date, sourcePatientKey: 'source-a|same-id', modality: 'CT', ...changes };
}
function choose(rows, uid = '1.2.3') {
  // Both production ingest paths format StudyDate before autoPrior sees it.
  sandbox.inputRows = rows;
  sandbox.inputUid = uid;
  return vm.runInContext('studies = inputRows.map(s => ({...s, date: fmtD(s.date)})); autoPrior(inputUid)', sandbox);
}

test('TEST-D03A-PAST: closest strictly older study; future and same day are excluded', () => {
  const rows = [row('1.2.3', '20260907'), row('1.2.4', '20260801'),
    row('1.2.5', '20260906'), row('1.2.6', '20261001'), row('1.2.7', '20260907')];
  assert.equal(choose(rows), '1.2.5');
  assert.equal(choose(rows, '1.2.4'), null);
  assert.equal(choose(rows, 'absent'), null);
  assert.equal(choose([rows[0], rows[3], rows[4]]), null);
});

test('TEST-D03A-DATE: malformed source dates cannot become automatic priors through fmtD', () => {
  for (const date of ['', '2026', '202609', 'abcdefgh', '20260230', '20261301', '20260010',
    '20260100', '20260132', '20260431', '2026-9-01', '2026-09-1', '2026-09-01T00:00:00Z',
    ' 20260901', '2026-09-01\n', '2026-09-01\r', '00000101', '19000229', '21000229']) {
    assert.equal(choose([row('1.2.3', '20260907'), row('1.2.9', date)]), null, `candidate ${date}`);
    assert.equal(choose([row('1.2.3', date), row('1.2.9', '00010101')]), null, `current ${date}`);
  }
});

test('TEST-D03A-DATE: Gregorian leap and month boundaries are real calendar dates', () => {
  for (const [current, prior] of [['20240301', '20240229'], ['20000301', '20000229'],
    ['20260301', '20260228'], ['20260501', '20260430'], ['00010102', '00010101'],
    ['2026-09-07', '2026-09-06']]) {
    assert.equal(choose([row('1.2.3', current), row('1.2.9', prior)]), '1.2.9', prior);
  }
});

test('TEST-D03A-DATE: absent or non-string in-memory dates fail closed', () => {
  for (const value of [undefined, null, 20260901, {}, []]) {
    sandbox.value = value;
    assert.equal(vm.runInContext('validPriorDate(value)', sandbox), false);
  }
});

test('TEST-D03A-IDENTITY: source-qualified identity, modality and known key are required', () => {
  const current = row('1.2.3', '20260907');
  for (const changes of [{sourcePatientKey: 'source-b|same-id'}, {sourcePatientKey: null},
    {sourcePatientKey: ''}, {sourcePatientKey: undefined}, {modality: 'MR'}]) {
    assert.equal(choose([current, row('1.2.9', '20260906', changes)]), null);
  }
  for (const sourcePatientKey of [undefined, null, '']) {
    assert.equal(choose([row('1.2.3', '20260907', {sourcePatientKey}),
      row('1.2.9', '20260906', {sourcePatientKey})]), null);
  }
  assert.equal(choose([current, row('1.2.9', '20260906')]), '1.2.9');
});

test('TEST-D03A-TIE/COST: existing UID descending tie is stable and inputs remain intact', () => {
  const rows = [row('1.2.3', '20260907'), row('1.2.8', '20260906'), row('1.2.9', '20260906')];
  const before = JSON.stringify(rows);
  assert.equal(choose(rows), '1.2.9');
  assert.equal(choose([...rows].reverse()), '1.2.9');
  assert.equal(JSON.stringify(rows), before);
  // The VM has no fetch, XMLHttpRequest, storage or window capability.
  assert.equal(vm.runInContext('typeof fetch + typeof window + typeof localStorage', sandbox),
    'undefinedundefinedundefined');
});
