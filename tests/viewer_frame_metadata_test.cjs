// REQ-MG-05 -> RISK-MG-FLIP-CLIP -> TEST-MG-FRAME-METADATA.
// Exercise the UID lookup boundary used by native geometry/VOI consumers.
// Real functional-group decoding and length units are checked on served OHIF.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const cached = new Map();
  const provider = { getUIDsFromImageID(imageId) { return cached.get(imageId); } };
  const window = { webpackChunk: { push(entry) {
    entry[2](() => ({ Ly: { MetadataProvider: provider } }));
  } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../config/ohif.js'), 'utf8'), { window, document: {} });
  const extension = window.config.extensions.find(e => e.id === 'kin.frame-metadata');
  extension.preRegistration();
  return { cached, provider, extension };
}
const base = 'wadors:../dicom-web/studies/1/series/2/instances/3';
const uids = { StudyInstanceUID: '1', SeriesInstanceUID: '2', SOPInstanceUID: '3' };

test('cached enhanced single-frame and multiframe identities retain the requested frame', () => {
  const { cached, provider } = setup();
  for (const frame of [1, 67, 2, 1]) {
    const id = `${base}/frames/${frame}`;
    cached.set(id, uids);
    const actual = provider.getUIDsFromImageID(id);
    assert.equal(actual.frameNumber, String(frame));
    for (const key of Object.keys(uids)) assert.equal(actual[key], uids[key]);
  }
  assert.equal(uids.frameNumber, undefined, 'lookup must not mutate the shared UID cache');
});

test('explicit frame identities and other metadata paths retain their original result', () => {
  const { cached, provider, extension } = setup();
  const framed = { ...uids, frameNumber: 2 };
  const id = `${base}/frames/2`;
  cached.set(id, framed);
  assert.equal(provider.getUIDsFromImageID(id), framed);
  for (const other of ['dicomfile:0', 'wadouri:/image?frame=2', base]) {
    cached.set(other, uids);
    assert.equal(provider.getUIDsFromImageID(other), uids);
  }
  assert.equal(provider.getUIDsFromImageID(`${base}/frames/3`), undefined);
  const installed = provider.getUIDsFromImageID;
  extension.preRegistration();
  assert.equal(provider.getUIDsFromImageID, installed);
});

test('a WADO-RS query or fragment preserves the encoded frame identity', () => {
  const { cached, provider } = setup();
  for (const suffix of ['?x=1', '#image']) {
    const id = `${base}/frames/12${suffix}`;
    cached.set(id, uids);
    assert.equal(provider.getUIDsFromImageID(id).frameNumber, '12');
  }
});
