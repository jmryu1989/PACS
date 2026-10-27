// Regression: the OHIF prior browser follows Related's source patient identity and scoped queries.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(rows, read, search = '?StudyInstanceUIDs=1') {
  const calls = [];
  const original = async function (params) { calls.push({ params, receiver: this === studies }); return [params.studyInstanceUid]; };
  const studies = { search: original };
  let end;
  const location = { search };
  const context = vm.createContext({ URLSearchParams, AbortController, location,
    kinViewerOnEnd: callback => { end = callback; return { close() {} }; },
    fetch: async (url, options) => { assert.equal(url, '/api/studies'); assert.equal(options.credentials, 'same-origin');
      return read ? read() : { ok: true, json: async () => ({ studies: rows }) }; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../config/ohif/study-search.js'), 'utf8'), context);
  const extension = context.kinCreateStudySearch();
  extension.preRegistration({ extensionManager: { getActiveDataSource: () => [{ query: { studies } }] } });
  extension.onModeEnter();
  return { studies, original, calls, extension, location, end: () => end() };
}
const rows = [
  { uid: '1', id: 'P', sourcePatientKey: 'site-a|P' },
  { uid: '2', id: 'P', sourcePatientKey: 'site-a|P' },
  { uid: '3', id: 'P', sourcePatientKey: 'site-b|P' },
  { uid: '4', id: 'Q', sourcePatientKey: 'site-a|Q' },
];
test('prior search uses the opened source patient and individually scoped UIDs', async () => {
  const f = fixture(rows);
  const result = await f.studies.search({ patientId: 'P', disableWildcard: true });
  assert.deepEqual(Array.from(result), ['1', '2']);
  assert.deepEqual(f.calls.map(c => c.params.studyInstanceUid), ['1', '2']);
  assert.ok(f.calls.every(c => c.receiver && c.params.patientId === 'P' && c.params.disableWildcard));
  assert.deepEqual(Array.from(await f.studies.search({ patientId: 'Q' })), []);
  f.extension.onModeExit();
  assert.equal(f.studies.search, f.original);
});
test('ordinary UID queries keep the pinned data source contract', async () => {
  const f = fixture(rows);
  const params = { studyInstanceUid: '1' };
  assert.deepEqual(await f.studies.search(params), ['1']);
  assert.equal(f.calls[0].params, params);
});
test('two opened institutions with the same MRN do not become one prior list', async () => {
  const f = fixture(rows, undefined, '?StudyInstanceUIDs=1,3');
  await assert.rejects(f.studies.search({ patientId: 'P' }));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.studies.search({ studyInstanceUid: '1' }), ['1']);
});
test('a refused worklist read is not an empty successful prior search', async () => {
  const f = fixture(rows, async () => ({ ok: false, status: 403 }));
  await assert.rejects(f.studies.search({ patientId: 'P' }), /HTTP 403/);
  assert.equal(f.calls.length, 0);
});
test('mode exit/reentry and document end discard an outstanding patient lookup', async () => {
  for (const action of ['reenter', 'end']) {
    let resolve;
    const f = fixture(rows, () => new Promise(done => { resolve = done; }));
    const pending = f.studies.search({ patientId: 'P' });
    if (action === 'end') f.end();
    else { f.extension.onModeExit(); f.extension.onModeEnter(); }
    resolve({ ok: true, json: async () => ({ studies: rows }) });
    await assert.rejects(pending);
    assert.equal(f.calls.length, 0);
  }
});
