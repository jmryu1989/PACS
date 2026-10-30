'use strict';
// REQ-MG-VENDOR-CLASS -> RISK-MG-MISCLASS -> TEST-MG-VENDOR-CATALOG. The API's image catalog (OrthancImageCatalog.manifest,
// compiled api/dist) over a synthetic Orthanc on real local HTTP: Siemens breast tomosynthesis slices stored as CT Image
// Storage are classified from their stored headers as the viewer hangs them, and an ordinary CT image in the same study
// gets no mammography result. The database, clinical scope and request context are stand-ins; every catalog read is HTTP.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = process.env.KIN_E_API || path.resolve(__dirname, '../../../api');
require(path.join(api, 'node_modules/reflect-metadata'));
const { OrthancImageCatalog } = require(path.join(api, 'dist', 'emr-source/image'));
const viewer = require('../../../worklist-v0/hpacs-lite/mammography-model.js');
const cases = require('../../fixtures/mg_vendor_cases.json').cases;

const fixture = id => structuredClone(cases.find(c => c.id === id).dicom);
const resource = n => [1, 2, 3, 4, 5].map(() => n.toString(16).padStart(8, '0')).join('-');

test('Siemens CT-format tomosynthesis slices are classified in the API catalog as the viewer hangs them', async () => {
  // Three slices of one series, stored out of position order, and an ordinary CT image in a second series.
  const slices = [2, 0, 1].map((position, i) => {
    const d = fixture('siemens-ct-tomo12');
    d['00080018'].Value = [d['0020000E'].Value[0] + '.' + (position + 1)];
    d['00200032'].Value[2] = position;
    d['00200013'] = { vr: 'IS', Value: [i + 1] };
    return d;
  });
  const ordinary = fixture('siemens-ct-tomo12');
  ordinary['00080008'].Value = ['ORIGINAL', 'PRIMARY', 'AXIAL'];
  ordinary['00080060'].Value = ['CT'];
  ordinary['0020000E'].Value = [ordinary['0020000D'].Value[0] + '.2'];
  ordinary['00080018'].Value = [ordinary['0020000E'].Value[0] + '.1'];
  const headers = [...slices, ordinary];
  const studyUid = headers[0]['0020000D'].Value[0], patientId = headers[0]['00100020'].Value[0];
  const objects = headers.map((h, i) => ({ id: resource(i + 2), file: 'synthetic-file-' + i, sop: h['00080018'].Value[0],
    bytes: Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), Buffer.alloc(64, i)]), frame: Buffer.alloc(32, 7 + i) }));
  const archive = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://synthetic'), json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/tools/lookup') {
      let body = ''; for await (const chunk of req) body += chunk;
      return json(body === studyUid ? [{ Type: 'Study', ID: resource(1) }] : []);
    }
    if (url.pathname === `/studies/${resource(1)}/instances`)
      return json(objects.map(o => ({ ID: o.id, FileUuid: o.file, MainDicomTags: { SOPInstanceUID: o.sop } })));
    if (url.pathname === `/dicom-web/studies/${studyUid}/metadata`) return json(headers);
    const object = objects.find(o => url.pathname.startsWith(`/instances/${o.id}/`));
    if (object && url.pathname.endsWith('/header')) return json({ '0002,0010': { Value: '1.2.840.10008.1.2.1' } });
    if (object && url.pathname.endsWith('/file')) return res.end(object.bytes);
    if (object && url.pathname.endsWith('/frames/0/raw')) return res.end(object.frame);
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => archive.listen(0, '127.0.0.1', resolve));
  const custody = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-mg-'));
  try {
    fs.writeFileSync(path.join(custody, 'viewer.js'), 'synthetic deployed viewer and native decoder bytes');
    const asset = { version: 'synthetic-distribution', files: ['viewer.js'] };
    fs.writeFileSync(path.join(custody, 'assets.json'), JSON.stringify({ viewer: { id: 'viewer', ...asset }, decoders: { native: asset } }));
    Object.assign(process.env, { ORTHANC_URL: 'http://127.0.0.1:' + archive.address().port, ORTHANC_USER: 'synthetic',
      ORTHANC_PASS: randomUUID(), KIN_EMR_IMAGE_ASSET_CATALOG: path.join(custody, 'assets.json') });
    const study = { studyId: studyUid, managingInstitutionId: 'synthetic-hospital',
      patient: { linkId: 'synthetic-link', patientId, assigningAuthority: 'synthetic-hospital' } };
    // No kept digests: every object is read from the archive, and keeping them afterwards is accepted.
    const db = { $transaction: fn => fn({}), $queryRaw: async () => [], $executeRaw: async () => 0 };
    const catalog = new OrthancImageCatalog(db, { study: async () => study }, { read: () => ({ institution: 'synthetic-hospital' }) },
      { every: () => () => {} });
    const manifest = await catalog.manifest({}, { studyUid }, new AbortController().signal);
    const bySop = new Map(manifest.objects.map(o => [o.sopInstanceUid, o]));
    for (const h of slices) {
      const listed = bySop.get(h['00080018'].Value[0]);
      assert.ok(listed.mammography, 'a CT-format tomosynthesis slice carries its classification');
      assert.equal(listed.mammography.class, 'dbt-slices');
      assert.equal(listed.mammography.status, 'verified');
      assert.equal(listed.mammography.laterality, 'R');
      assert.equal(viewer.classify(h).kind, 'dbt', 'the viewer hangs the same header as DBT');
      assert.equal(listed.sha256, createHash('sha256').update(objects.find(o => o.sop === listed.sopInstanceUid).bytes).digest('hex'));
    }
    assert.equal(bySop.get(ordinary['00080018'].Value[0]).mammography, null, 'an ordinary CT image is not a mammography object');
    assert.notEqual(viewer.classify(ordinary).kind, 'dbt');
  } finally {
    await new Promise(resolve => archive.close(resolve));
    fs.rmSync(custody, { recursive: true, force: true });
  }
});
