// REQ-MG-VENDOR-CLASS/DISPLAY -> RISK-MG-MISCLASS/WRONG-VOI -> TEST-MG-VENDOR.
// Inputs are declared vendor header shapes; assertions use classification, slots and display values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../worklist-v0/hpacs-lite/mammography-model.js');
const cases = require('./fixtures/mg_vendor_cases.json').cases;
const clone = x => structuredClone(x);
const value = (vr, ...Value) => ({ vr, Value });
const row = id => clone(cases.find(c => c.id === id).dicom);
const plan = instances => model.plan({ institution: 'SYNTHETIC', studies: [{
  institution: 'SYNTHETIC', role: 'current', uid: instances[0]['0020000D'].Value[0], instances,
}] });

for (const c of cases) test('vendor header ' + c.id, () => {
  const result = model.classify(c.dicom);
  assert.equal(result.kind, c.kind);
  assert.equal(result.status, 'verified', result.issues.join(','));
  assert.equal(result.standard, !c.processing);
  const spec = model.displaySpec(c.dicom);
  assert.equal(spec.invert, c.dicom['00280004'].Value[0] === 'MONOCHROME1');
  assert.equal(spec.voi.status, 'verified');
  const frameVOI = c.dicom['52009229']?.Value[0]['00289132'].Value[0];
  if ((frameVOI || c.dicom)['00283010']) {
    assert.equal(spec.voi.fn, 'TABLE');
    assert.deepEqual(spec.voi.lut, { first: 100, bits: 16, data: [0, 512, 4096, 16000, 32000, 50000, 62000, 65535] });
  } else {
    assert.equal(spec.voi.center, (frameVOI || c.dicom)['00281050'].Value[0]);
    assert.equal(spec.voi.width, (frameVOI || c.dicom)['00281051'].Value[0]);
    assert.equal(spec.voi.fn, (frameVOI || c.dicom)['00281056']?.Value[0] || 'LINEAR');
  }
  if (c.instances === 1 && !c.processing) assert.equal(plan([c.dicom]).slots['current|R|CC|' + c.kind].status, 'ready');
});

function ctStack() {
  return [2, 0, 1].map((position, i) => {
    const d = row('siemens-ct-tomo12');
    d['00080018'] = value('UI', d['0020000E'].Value[0] + '.' + (position + 1));
    d['00200032'] = value('DS', 0, 0, position);
    d['00200013'] = value('IS', i + 1);
    return d;
  });
}
test('CT breast slices hang as one DBT stack and keep the real SOP identities', () => {
  const input = ctStack(), before = clone(input), result = plan(input).slots['current|R|CC|dbt'];
  assert.equal(result.status, 'ready');
  assert.equal(result.object.frames, 3);
  assert.equal(result.object.stackMembers.length, 3);
  assert.deepEqual(new Set(result.object.stackMembers.map(o => o.sop)), new Set(input.map(d => d['00080018'].Value[0])));
  assert.deepEqual(input, before, 'stored headers are never rewritten as a synthetic BTO');
});
test('CT ordinary scans, rotating mammograms and ambiguous slice collections do not auto-hang as DBT', () => {
  for (const change of [
    d => { d['00080008'] = value('CS', 'ORIGINAL', 'PRIMARY', 'AXIAL'); },
    d => { d['00080008'].Value.push('INSIGHT_3D'); },
    d => { d['00200062'] = value('CS', 'L'); },
    d => { delete d['00082218']; },
    d => { d['00200032'] = value('DS', 0, 0, 0); },
    d => { d['00200052'] = value('UI', '2.25.999'); },
    d => { d['00280010'] = value('US', 128); },
  ]) {
    const input = ctStack(); change(input[0]);
    assert.notEqual(plan(input).slots['current|R|CC|dbt'].status, 'ready');
  }
  assert.notEqual(plan(ctStack().slice(0, 1)).slots['current|R|CC|dbt'].status, 'ready');
});
test('INSIGHT_2D is only the declared Siemens presentation image with matching laterality', () => {
  for (const mutate of [
    d => { d['00080008'].Value[2] = 'TOMO'; },
    d => { d['00080008'].Value[3] = 'L'; },
    d => { d['00080008'].Value[4] = 'INSIGHT_3D'; },
    d => { d['00080070'] = value('LO', 'Unspecified'); },
    d => { d['00080008'].Value.push('UNKNOWN'); },
  ]) {
    const d = row('siemens-insight12'); mutate(d);
    assert.notEqual(model.classify(d).kind, 'generated2d');
  }
  const exposure = row('siemens-insight12'); exposure['00080008'].Value.pop();
  assert.equal(model.classify(exposure).kind, 'conventional');
  // VC20G describes its series "INSIGHT 2D"; without the INSIGHT_2D value it is no conventional view either.
  exposure['0008103E'] = value('LO', 'INSIGHT 2D R CC');
  assert.equal(model.classify(exposure).status, 'unverified');
  assert.equal(plan([exposure]).slots['current|R|CC|conventional'].status, 'missing');
});
test('Siemens Table 164 laterality literals hang by side; BOTH is never a full-view slot', () => {
  for (const [literal, side] of [['LEFT', 'L'], ['RIGHT', 'R'], ['L', 'L']]) {
    const d = row('siemens-2d-12-1'); d['00080008'].Value[3] = literal; d['00200062'] = value('CS', side); d['00200060'] = value('CS', side);
    assert.equal(plan([d]).slots['current|' + side + '|CC|conventional'].status, 'ready', literal);
  }
  const both = row('siemens-insight12'); both['00080008'].Value[3] = 'BOTH'; both['00200062'] = value('CS', 'B'); both['00200060'] = value('CS', 'B');
  assert.equal(model.classify(both).standard, false);
});
test('implicit-VR LUT Data is read from inline or fetched bulk bytes, never guessed', () => {
  const lut = [0, 512, 4096, 16000, 32000, 50000, 62000, 65535], bytes = new Uint8Array(new Uint16Array(lut).buffer);
  const withData = element => { const d = row('siemens-lut-12-1'); d['00283010'].Value[0]['00283006'] = element; return d; };
  const inline = model.displaySpec(withData({ vr: 'OW', InlineBinary: Buffer.from(bytes).toString('base64') }));
  assert.equal(inline.voi.status, 'verified'); assert.deepEqual(inline.voi.lut.data, lut);
  const bulk = withData({ vr: 'OW', BulkDataURI: 'https://example.invalid/bulk/1' });
  assert.equal(model.displaySpec(bulk).voi.status, 'unverified', 'bytes not fetched yet');
  assert.ok(model.displaySpec(bulk).issues.includes('voi-lut-table-invalid'));
  assert.deepEqual(model.displaySpec(bulk, 1, { bulk: () => bytes }).voi.lut.data, lut);
  assert.equal(model.displaySpec(bulk, 1, { bulk: () => bytes.subarray(1) }).voi.status, 'unverified', 'a short table is not padded');
  // An 8-bit table is stored 8 bits allocated, padded to an even length.
  const eight = withData({ vr: 'OW', InlineBinary: Buffer.from([0, 64, 128, 255, 9, 0]).toString('base64') });
  eight['00283010'].Value[0]['00283002'] = value('US', 5, 100, 8);
  assert.deepEqual(model.displaySpec(eight).voi.lut, { first: 100, bits: 8, data: [0, 64, 128, 255, 9] });
  assert.equal(model.displaySpec(withData({ vr: 'OW', InlineBinary: '%%%' })).voi.status, 'unverified');
});
test('a partial or contradictory synthetic view cannot fill a full-view slot', () => {
  for (const vendor of ['hologic-generated-bto10', 'ge-generated-bto12', 'fuji-sview12']) {
    const d = row(vendor); d['00281350'] = value('CS', 'YES');
    assert.notEqual(plan([d]).slots['current|R|CC|generated2d'].status, 'ready');
    const conflict = row(vendor); conflict['52009230'].Value[0]['00189504'].Value[0]['00089007'].Value[3] = 'NONE';
    assert.equal(model.classify(conflict).status, 'unverified');
  }
});
test('synthetic 2D comparison matches the same breast/view across manufacturers', () => {
  const current = row('siemens-insight12'), prior = row('fuji-sview12');
  const result = model.plan({ institution: 'SYNTHETIC', studies: [current, prior].map((d, i) => ({
    institution: 'SYNTHETIC', role: i ? 'prior' : 'current', uid: d['0020000D'].Value[0], instances: [d],
  })) });
  assert.equal(result.prior.status, 'ok');
  for (const role of ['current', 'prior']) {
    assert.equal(result.slots[role + '|R|CC|generated2d'].status, 'ready');
    assert.equal(result.slots[role + '|R|CC|conventional'].status, 'missing');
  }
});
test('invalid LUT tables remain unverified; an explicit window stays an available alternative', () => {
  const d = row('siemens-lut-12-2'); d['00283010'].Value[0]['00283006'].Value.pop();
  assert.equal(model.displaySpec(d).voi.status, 'unverified');
  d['00281050'] = value('DS', 733); d['00281051'] = value('DS', 1300);
  assert.equal(model.displaySpec(d).voi.center, 733);
  assert.equal(model.displaySpec(d).voi.width, 1300);
  assert.equal(model.displaySpec(d).voi.lut, null);
});
