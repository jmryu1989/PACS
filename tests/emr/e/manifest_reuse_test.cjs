'use strict';
// E_ROUTE performance boundary: one whole-study catalog read serves that study's frame requests, without changing
// what each request proves. A frame of a series must not re-read and rehash the whole study; an object or frame
// the kept manifest lacks, or a source that no longer matches, must not be served from it. A request for the study's
// or a series' contents (retrieve, query, metadata) answers with what the study holds now, objects that arrived after
// the kept manifest included (R244-01). Compiled product code.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const api = process.env.KIN_E_API || path.resolve(__dirname, '../../../api');
require(path.join(api, 'node_modules/reflect-metadata'));
const load = name => require(path.join(api, 'dist', name));
const { buildImageManifest } = load('emr-image/manifest');
const { parseImageRequest } = load('emr-image/contract');
// Loaded where used, so the service case also runs against a build without this module.
const fresh = (...args) => new (load('emr-image/manifest-reuse').ManifestReuse)(...args);
const { OnlineImageService } = load('emr-image/service');
const { ContractError } = load('emr-contract/validation');
const { ConflictException, ForbiddenException } = require(path.join(api, 'node_modules/@nestjs/common'));

const hash = value => createHash('sha256').update(value).digest('hex');
// The response's check pool (check-db.ts) as a transaction stand-in; these cases stop at the access check inside it.
const checkPool = () => ({ $transaction: fn => fn({ $executeRaw: async () => 0 }) });
// The shared study delivery recorder stands aside where a case stops at the access check before any record is named.
const noRecord = { lease: async () => null };
const STUDY = '2.25.7101', SERIES = STUDY + '.1';
const sop = n => SERIES + '.' + n;
function manifest(count, frames = 1, study = STUDY) {
  const objects = Array.from({ length: count }, (_, i) => ({ studyUid: study, seriesUid: study + '.1', sopInstanceUid: study + '.1.' + (i + 1),
    sopClassUid: '1.2.840.10008.5.1.4.1.1.2', transferSyntaxUid: '1.2.840.10008.1.2.1', imageType: ['ORIGINAL', 'PRIMARY'],
    bytes: 4096, sha256: hash('object' + i), declaredFrameCount: frames,
    frames: Array.from({ length: frames }, (_, f) => ({ number: f + 1, bytes: 1024, sha256: hash(`frame${i}.${f}`) })),
    provenance: { kind: 'device', receiptEventId: null }, derivation: { kind: 'original' }, mammography: null, timing: null }));
  return buildImageManifest({ formatVersion: 1, studyUid: study, managingInstitution: 'synthetic-hospital',
    patient: { linkId: 'synthetic-link', patientId: 'SYNTHETIC', assigningAuthority: 'synthetic-hospital' },
    builtAt: new Date().toISOString(), expected: { series: 1, objects: count },
    pages: [{ cursor: null, next: null, objects }], referencedObjects: [],
    decoderCatalog: { native: { version: 'synthetic', sha256: hash('decoder') } },
    viewer: { id: 'synthetic-viewer', version: 'fixture', sha256: hash('viewer') } });
}
const frame = (n, f = 1, study = STUDY) => parseImageRequest('GET', `/dicom-web/studies/${study}/series/${study}.1/instances/${study}.1.${n}/frames/${f}`);
const live = () => new AbortController().signal;
const later = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
// Orthanc stand-in for the service cases: every one of them stops at the access check, before any source byte.
const noSourceRead = { imageSource: () => ({ async copy() { throw new Error('a source read before the access check'); } }) };

test('one catalog read serves every frame of the study, including a burst of simultaneous first requests', async () => {
  const reuse = fresh(), built = manifest(200);
  let reads = 0;
  const build = async () => { reads++; await new Promise(r => setTimeout(r, 20)); return built; };
  const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => reuse.manifest(frame(i + 1), build, live())));
  assert.equal(reads, 1);
  assert.ok(burst.every(m => m === built));
  for (let i = 51; i <= 200; i++) assert.equal(await reuse.manifest(frame(i), build, live()), built);
  assert.equal(reads, 1, 'a 200-slice series is one study read, not one per frame');
});

test('a request the kept manifest does not cover reads the catalog again; a kept frame does not', async () => {
  const reuse = fresh();
  const versions = [manifest(2), manifest(3, 2)];
  let reads = 0;
  const build = async () => versions[reads++];
  assert.equal(await reuse.manifest(frame(1), build, live()), versions[0]);
  assert.equal(await reuse.manifest(frame(3), build, live()), versions[1], 'an object that arrived later');
  assert.equal(await reuse.manifest(frame(3, 2), build, live()), versions[1]);
  assert.equal(await reuse.manifest(frame(1), build, live()), versions[1]);
  assert.equal(reads, 2);
  let looked = 0;
  // Still absent after the new read: prepareDelivery refuses it (ScopeOutsideManifest) against that fresh manifest.
  assert.equal(await reuse.manifest(frame(9), async () => { looked++; return versions[1]; }, live()), versions[1]);
  assert.equal(looked, 1, 'an object outside the kept manifest is looked up again, never assumed absent');
});

test('a study or series request selects what the study holds now, not what a frame request kept', async () => {
  const { prepareDelivery, checkProvisionBasis } = load('emr-image/contract');
  const at = new Date().toISOString();
  const selected = (kept, request) => prepareDelivery(kept, request, { eventId: randomUUID(), at, cause: 'background-fetch',
    opening: null, authorization: { studyUid: STUDY, institution: 'synthetic-hospital', accountGeneration: 1 },
    provision: checkProvisionBasis({ relation: 'same-institution', at, managingInstitution: 'synthetic-hospital', studyUid: STUDY,
      recipient: null, purpose: null, basis: null, agreement: null, auditBefore: null }) }).units.map(unit => unit.sopInstanceUid);
  for (const target of [`/dicom-web/studies/${STUDY}`, `/dicom-web/studies/${STUDY}/series/${SERIES}`]) {
    const reuse = fresh();
    let source = manifest(2), reads = 0;
    const build = async () => { reads++; return source; };
    await reuse.manifest(frame(1), build, live());
    source = manifest(3); // an ordinary later arrival: same patient and institution, earlier objects unchanged
    const request = parseImageRequest('GET', target);
    assert.deepEqual(selected(await reuse.manifest(request, build, live()), request), [sop(1), sop(2), sop(3)], target);
    assert.equal(reads, 2, target);
    assert.equal(await reuse.manifest(frame(3), async () => { throw new Error('read again'); }, live()), source,
      'the fresh read then serves the arrival\'s frames');
  }
  for (const target of [`/dicom-web/studies?StudyInstanceUID=${STUDY}`, `/dicom-web/studies/${STUDY}/series`,
    `/dicom-web/studies/${STUDY}/instances`, `/dicom-web/studies/${STUDY}/metadata`,
    `/dicom-web/studies/${STUDY}/series/${SERIES}/instances`, `/dicom-web/studies/${STUDY}/series/${SERIES}/metadata`]) {
    const reuse = fresh(), versions = [manifest(2), manifest(3)];
    let reads = 0;
    const build = async () => versions[reads++];
    await reuse.manifest(frame(1), build, live());
    assert.equal(await reuse.manifest(parseImageRequest('GET', target), build, live()), versions[1], target);
  }
});

test('a study request does not join a catalog read that a frame request started before it', async () => {
  const reuse = fresh(), gate = later(), versions = [manifest(2), manifest(3)];
  const owner = reuse.manifest(frame(1), () => gate.promise, live());
  let reads = 0;
  const study = reuse.manifest(parseImageRequest('GET', `/dicom-web/studies/${STUDY}`), async () => versions[++reads], live());
  gate.resolve(versions[0]);
  assert.equal(await owner, versions[0]);
  assert.equal(await study, versions[1], 'an object stored before the study request belongs in its answer');
  assert.equal(reads, 1);
});

test('a joined build that fails for its own requester does not decide another request', async () => {
  const reuse = fresh(), built = manifest(4), first = later();
  const own = reuse.manifest(frame(1), () => first.promise, live());
  let reads = 0;
  const joined = reuse.manifest(frame(2), async () => { reads++; return built; }, live());
  first.reject(new ForbiddenException('synthetic refusal of the first requester'));
  await assert.rejects(own, ForbiddenException);
  assert.equal(await joined, built);
  assert.equal(reads, 1, 'the second request read the catalog with its own identity');
});

test('an aborted waiter stops waiting without stopping the build another request owns', async () => {
  const reuse = fresh(), built = manifest(4), gate = later();
  const owner = reuse.manifest(frame(1), () => gate.promise, live());
  const control = new AbortController();
  const waiter = reuse.manifest(frame(2), async () => built, control.signal);
  control.abort(new Error('synthetic client abort'));
  await assert.rejects(waiter, /synthetic client abort/);
  gate.resolve(built);
  assert.equal(await owner, built);
  let reads = 0;
  await assert.rejects(reuse.manifest(frame(1, 1, '2.25.7104'), async () => (reads++, manifest(1, 1, '2.25.7104')), control.signal),
    /synthetic client abort/);
  assert.equal(reads, 0, 'an aborted request starts no whole-study read');
});

test('forget drops only the manifest it names; the bound keeps recently used studies', async () => {
  const reuse = fresh(2), a = manifest(2), b = manifest(2);
  let reads = 0;
  assert.equal(await reuse.manifest(frame(1), async () => (reads++, a), live()), a);
  reuse.forget(STUDY, b);
  assert.equal(await reuse.manifest(frame(2), async () => (reads++, b), live()), a, 'a stale reference forgets nothing');
  reuse.forget(STUDY, a);
  assert.equal(await reuse.manifest(frame(2), async () => (reads++, b), live()), b);
  assert.equal(reads, 2);
  const other = ['2.25.7102', '2.25.7103'].map(study => manifest(1, 1, study));
  await reuse.manifest(frame(1, 1, '2.25.7102'), async () => other[0], live());
  await reuse.manifest(frame(1), async () => { throw new Error('kept'); }, live());
  await reuse.manifest(frame(1, 1, '2.25.7103'), async () => other[1], live());
  await assert.rejects(reuse.manifest(frame(1, 1, '2.25.7102'), async () => { throw new Error('evicted'); }, live()), /evicted/);
  assert.equal(await reuse.manifest(frame(1), async () => { throw new Error('not evicted'); }, live()), b);
});

test('the image service rebuilds after a source/current-study change, not after an access refusal', async () => {
  process.env.KIN_EMR_STATE_DIR = require('node:os').tmpdir();
  const built = manifest(3);
  let reads = 0, answer;
  const context = {
    async manifest() { reads++; return built; },
    async recheck() { throw answer; },
  };
  const service = new OnlineImageService(context, {}, noSourceRead,
    { facts: async () => ({ roles: [], binding: {}, actor: {} }) }, checkPool(), noRecord);
  const send = async n => {
    const request = Object.assign(new EventEmitter(), { method: 'GET', headers: {} });
    const response = Object.assign(new EventEmitter(), { writableFinished: false });
    await service.send(request, response, `/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${sop(n)}/frames/1`);
  };
  answer = new ForbiddenException('synthetic access refusal');
  await assert.rejects(send(1), ForbiddenException);
  await assert.rejects(send(2), ForbiddenException);
  assert.equal(reads, 1, 'a refused member does not cost the next reader a whole-study read');
  for (const change of [new ContractError('ImageCurrentStudyChanged'), new ConflictException('synthetic replaced source'),
    new ContractError('ImageSourceMismatch'), new AggregateError([new ContractError('ImageSourceMismatch'), new Error('cleanup')])]) {
    const before = reads;
    answer = change;
    await assert.rejects(send(1));
    answer = new ForbiddenException('synthetic access refusal');
    await assert.rejects(send(2), ForbiddenException);
    assert.equal(reads, before + 1, `rebuilt after ${change.code ?? change.constructor.name}`);
  }
});

test('the image service reads the catalog for each study or series request, between frames that reuse it', async () => {
  process.env.KIN_EMR_STATE_DIR = require('node:os').tmpdir();
  let reads = 0;
  const context = { async manifest() { reads++; return manifest(3); },
    async recheck() { throw new ForbiddenException('synthetic stop at the access check'); } };
  const service = new OnlineImageService(context, {}, noSourceRead, { facts: async () => ({ roles: [], binding: {}, actor: {} }) }, checkPool(), noRecord);
  const send = target => service.send(Object.assign(new EventEmitter(), { method: 'GET', headers: {} }),
    Object.assign(new EventEmitter(), { writableFinished: false }), target);
  const seen = [];
  for (const target of [`/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${sop(1)}/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${SERIES}`, `/dicom-web/studies/${STUDY}`,
    `/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${sop(2)}/frames/1`]) {
    await assert.rejects(send(target), ForbiddenException);
    seen.push(reads);
  }
  assert.deepEqual(seen, [1, 2, 3, 3]);
});

test('simultaneous frames of a kept study do not wait on their own B2 append lanes', async () => {
  // The real B2 admission: a few append lanes shared FIFO by every transaction on one client. Resolving a request's
  // member identity takes a lane of its own; the study delivery's opening (the shared recorder's record transaction
  // and append) takes lanes too, once for the burst, while the other frames wait for its receipt.
  const { admitAppend } = load('emr-runtime/admission');
  const { StudyImageDeliveryRecorder } = load('image-delivery-record');
  const { mintDurableReceipt } = load('emr-runtime/contract');
  const { parseAccessEvent } = load('emr-contract/access-event');
  const client = {}, poolSize = 6, built = manifest(40);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const materialized = new WeakMap();
  const requests = { facts(request) {
    if (!materialized.has(request)) materialized.set(request, admitAppend(client, poolSize, async () => { await settle(); return { roles: [], binding: {}, actor: {} }; }));
    return materialized.get(request);
  }, read: () => ({ issuer: 'synthetic', subject: 'doctor', binding: { method: 'session', sessionRef: 'synthetic-session' } }) };
  const context = {
    async manifest() { return built; },
    async recheck(_tx, request) { await requests.facts(request); throw new ForbiddenException('synthetic stop after the access check'); },
  };
  const actor = { id: randomUUID(), issuer: 'synthetic', subject: 'doctor' };
  const clinical = {
    async facts(_tx, request) { await requests.facts(request); return { actor: { identity: actor, kind: 'member', roles: ['radiologist'], institutionId: 'synthetic-hospital' },
      requestId: randomUUID(), ip: { status: 'known', value: { address: '127.0.0.1', source: 'request-peer' } } }; },
    async study() { return { studyId: STUDY, managingInstitutionId: 'synthetic-hospital', patient: built.patient }; },
  };
  const appended = [];
  const records = { begin: () => ({ transactionWithRecords: fn => admitAppend(client, poolSize, async () => { await settle(); return fn({}); }),
    append: event => admitAppend(client, poolSize, async () => {
      await settle(); appended.push(parseAccessEvent(event).action); return mintDurableReceipt(parseAccessEvent(event).eventId, new Date().toISOString());
    }), end() {} }) };
  const registry = load('emr-runtime/background-work').createBackgroundWorkRegistry();
  const orthanc = { ...noSourceRead, studyRevision: async () => ({ id: 'synthetic', lastUpdate: '20261028T120000' }) };
  const recorder = new StudyImageDeliveryRecorder(records, requests, clinical, registry.work, orthanc);
  process.env.KIN_EMR_STATE_DIR = require('node:os').tmpdir();
  const service = new OnlineImageService(context, {}, orthanc, requests, checkPool(), recorder);
  const send = n => service.send(Object.assign(new EventEmitter(), { method: 'GET', headers: {} }),
    Object.assign(new EventEmitter(), { writableFinished: false }),
    `/dicom-web/studies/${STUDY}/series/${SERIES}/instances/${sop(n)}/frames/1`);
  // A served CT series: about 25 prefetch frames at once, more than the lanes.
  const sends = Array.from({ length: 24 }, (_, i) => send(i + 1));
  const outcome = await Promise.race([Promise.allSettled(sends).then(results => results),
    new Promise(resolve => setTimeout(() => resolve('waiting on its own lanes'), 3000))]);
  assert.notEqual(outcome, 'waiting on its own lanes');
  assert.ok(outcome.every(result => result.status === 'rejected' && result.reason instanceof ForbiddenException));
  assert.deepEqual(appended, ['provide-prepared'], 'the burst opened one study delivery');
  await recorder.beforeApplicationShutdown();
  assert.deepEqual(appended, ['provide-prepared', 'transfer-aborted'], 'nothing of it was served');
});
